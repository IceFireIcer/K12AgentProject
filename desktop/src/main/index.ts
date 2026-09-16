/**
 * Electron 主进程入口：窗口 + 生命周期 + sidecar 管家接线。
 *
 * 分工（执行文档 §7.4）：
 *   - 本文件只负责「创建窗口 → 启动 sidecar → 把状态推给渲染进程 → 退出时杀干净」。
 *   - Pi Agent 运行时将来挂在这里（票 06/08），当前**不引入任何 Pi 依赖**。
 */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from './ipc/channels'
import { registerIpcHandlers } from './ipc/handlers'
import { SidecarManager } from './sidecar/manager'

const APP_ID = 'com.k12agent.desktop'

/**
 * CDP 调试入口：**默认关闭**，只在显式设置 `K12_DEBUG_PORT` 时打开。
 * 本机截图不可靠，`scripts/verify-ui.mjs` 靠 CDP 读真实 DOM 做断言，所以这条必须可用；
 * 但绝不能让它跟着分发包一起发出去。
 */
const debugPort = process.env.K12_DEBUG_PORT
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
  console.warn(`[main] CDP 调试端口已开启：${debugPort}`)
  if (app.isPackaged) {
    console.warn('[main] 警告：打包产物不应带调试入口，请确认这只是临时排查。')
  }
}

let mainWindow: BrowserWindow | null = null
let sidecar: SidecarManager | null = null
/** 退出流程已开始（防止 `before-quit` 递归触发）。 */
let quitting = false

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'K12 AI 教学助手',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 关闭沙箱是 preload 用 ESM/CJS 混合构建的常规要求；
      // 真正的隔离靠 contextIsolation + 不暴露通用 ipcRenderer（见 preload 白名单）。
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 先隐藏、就绪后再显示，避免白屏闪烁
  window.on('ready-to-show', () => {
    window.show()
  })

  // 外链一律交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function pushSidecarState(): void {
  if (!sidecar) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.sidecarChanged, sidecar.getState())
  }
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)

  // 开发态：F12 开 DevTools、忽略菜单快捷键等
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  sidecar = new SidecarManager({
    userDataDir: app.getPath('userData'),
    onStateChanged: () => pushSidecarState()
  })
  registerIpcHandlers(sidecar)

  mainWindow = createWindow()

  // 窗口先起来（不白屏），sidecar 的状态经 `sidecar:changed` 推给渲染进程
  void sidecar.start().catch((error: unknown) => {
    console.error('[main] sidecar 启动流程异常：', error)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * 退出清理：必须杀掉 sidecar 的**整棵进程树**（Windows 上 `uv → python` 会留下孤儿进程占端口）。
 * 先 `preventDefault` 把退出推迟到 kill 完成，再 `app.quit()`；`quitting` 保证只跑一次、不会递归。
 */
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()

  const current = sidecar
  sidecar = null
  void (current ? current.stop() : Promise.resolve()).finally(() => {
    app.quit()
  })
})
