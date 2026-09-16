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

  // 关窗后别再留着已销毁窗口的引用（`mainWindow` 只用于取渲染进程/推状态）
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
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
  // 状态对象里**没有 token**（`SidecarState` 结构上就没有这个字段），
  // 渲染进程只会看到「阶段 / 端口 / 后端 pid / 错误文案」。
  const state = sidecar.getState()
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(IPC.sidecarChanged, state)
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
 *
 * ★ 一次性保证：`quitting` 置位后就永远走上面那个 early return，
 *   所以即使 `app.quit()` 再次触发 `before-quit`，也不会重复杀进程。
 */
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()

  // ★★ 票 06 接线点：Pi 的 `session.dispose()` 必须在这里调用（且只调一次）——
  //    否则 Pi 的 JSONL 会话可能半写。**票 02 不引入任何 Pi 依赖**，这里只留位置：
  //
  //      await session.dispose()
  //
  //    顺序：先 dispose（把会话 flush 干净）再停 sidecar，
  //    因为 Tool 可能是最后一个写 /api 的调用方（dispose 之后不应再有 /api 请求）。
  const current = sidecar
  sidecar = null
  void (current ? current.stop() : Promise.resolve())
    .catch((error: unknown) => {
      // 收尾异常不能挡住退出：日志留在 stdout（stderr），进程该走还得走
      console.error('[main] sidecar 收尾异常：', error)
    })
    .finally(() => {
      app.quit()
    })
})
