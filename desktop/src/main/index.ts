/**
 * Electron 主进程：窗口与生命周期。
 *
 * ⚠️ 这里**只做 UI 壳 + sidecar 生命周期管理**，不引入任何原生 DB 模块
 * （项目执行文档 5.2 明确约束，风险隔离）。
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { SidecarManager } from './sidecar'
import { describeStartupFailure } from './sidecar-logic'

const sidecar = new SidecarManager()

/**
 * 可选开启 CDP 调试端口（**只有显式设置 `K12_DEBUG_PORT` 才会开**）。
 *
 * 默认完全关闭——不给任何构建产物留下可被本机其他进程接管的调试入口。
 * 用途：自动化 UI 校验（读取真实 DOM），见 scripts/verify-ui.mjs。
 *
 * 打包产物上开启需要在环境里显式设 `K12_DEBUG_PORT`，会打印告警；验收完即关。
 */
const debugPort = process.env['K12_DEBUG_PORT']
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
  if (app.isPackaged) {
    console.warn(`[security] 打包产物已开启 CDP 调试端口 ${debugPort}，仅供本地验收，请勿分发此实例`)
  }
}

/** 保证「杀进程树」只有一条路径，避免退出时重复触发。 */
let quitCleanupDone = false

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'K12 AI 教学助手',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 渲染层与 Node 隔离；所有能力经 preload 白名单暴露
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/** IPC：渲染层要展示的 sidecar 快照（界面首次加载时主动拉一次）。 */
function registerIpc(): void {
  ipcMain.handle('sidecar:get-info', () => sidecar.info)

  ipcMain.handle('sidecar:restart', async () => {
    await sidecar.restart()
    return sidecar.info
  })

  ipcMain.handle('app:get-log-path', () => sidecar.info.logFile)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.k12agent.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()

  // 窗口先出来（即便后端起不来也不会白屏：渲染层会显示可读错误）
  sidecar.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * ★ 退出清理：必须杀整棵进程树。
 *
 * `uv run` 会派生子进程，只杀父进程会留下孤儿 python.exe 占住端口，
 * 导致「二次启动失败」——这正是关卡 A 的验收项之一。
 */
app.on('before-quit', (event) => {
  if (quitCleanupDone) return
  event.preventDefault()
  quitCleanupDone = true
  void sidecar
    .stop()
    .catch(() => undefined)
    .finally(() => app.quit())
})

// 兜底：异常退出路径也尽量清干净
process.on('exit', () => {
  void sidecar.stop()
})

export { describeStartupFailure }
