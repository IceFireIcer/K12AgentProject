/**
 * Electron 主进程入口：窗口 + 生命周期 + sidecar 管家接线。
 *
 * 分工（执行文档 §7.4）：
 *   - 本文件只负责「创建窗口 → 启动 sidecar → 把状态推给渲染进程 → 退出时杀干净」。
 *   - Pi Agent 运行时接线点在 `src/main/agent/`（票 03 建立底座，票 06/08 全面接入）。
 *
 * ⚠️ **本文件是 ESM**（构建产物 `out/main/index.mjs`，见 `electron.vite.config.ts` 的注释）：
 *    - **没有 `__dirname`**，一律用 `import.meta.dirname`；
 *    - 相对导入**必须带 `.ts` 后缀**（ESM 不做扩展名补全）——这也是 `scripts/pi-smoke.mjs`
 *      能直接 import 同一份 TS 实现的前提。
 */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { runPiSmoke } from './agent/pi-bootstrap.ts'
import { IPC } from './ipc/channels.ts'
import { disposeChatRuntime, registerIpcHandlers } from './ipc/handlers.ts'
import { SidecarManager } from './sidecar/manager.ts'

const APP_ID = 'com.k12agent.desktop'

/**
 * CDP 调试入口：**默认关闭**，只在显式设置 `K12_DEBUG_PORT` 时打开。
 * 本机截图不可靠，`scripts/verify-ui.mjs` 靠 CDP 读真实 DOM 做断言，所以这条必须可用；
 * 但绝不能让它跟着分发包一起发出去。
 */
// ★★ 票 18：Pyodide 的 setInterruptBuffer 需要 SharedArrayBuffer，
//    而它在 Electron 的渲染进程与 Worker 里**默认是 undefined**（实测），
//    不开这个开关，「while True: pass」就只能干等超时、无法真正中断。
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

const debugPort = process.env.K12_DEBUG_PORT
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
  console.warn(`[main] CDP 调试端口已开启：${debugPort}`)
  if (app.isPackaged) {
    console.warn('[main] 警告：打包产物不应带调试入口，请确认这只是临时排查。')
  }
}

/**
 * ★ 关卡 B₁ 的打包态冒烟开关（票 03）。
 *
 * `K12_PI_SMOKE=1` 时**不建窗口、不起 sidecar**，只在打包产物的真实主进程里
 * 走一遍 Pi 的装配（导入 → ModelRuntime → createAgentSession → systemPromptOverride），
 * 然后把结果打到 stdout 并退出。**不需要任何 API Key**：
 * 缺 Key 会被明确标成「blocked：缺 Key」，与「Pi 加载失败」严格区分。
 *
 * 退出码：0 通过（含「到 Key 为止」）/ 10-13 分步失败 / 1 装配异常。
 */
const smokeMode = process.env.K12_PI_SMOKE === '1'

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
      preload: join(import.meta.dirname, '../preload/index.js'),
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
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
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

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId(APP_ID)

  // ★ 关卡 B₁：打包态冒烟模式。走完就退，不建窗口、不动 sidecar。
  if (smokeMode) {
    const lines: string[] = []
    const result = await runPiSmoke({
      userDataDir: app.getPath('userData'),
      packaged: app.isPackaged,
      log: (line) => {
        lines.push(line)
        // Windows GUI 进程的 stdout 不一定接得到管道，所以**同时落盘**一份作为证据
        console.log(line)
      }
    })
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const dir = join(app.getPath('userData'), 'pi-agent', 'logs')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'smoke-packaged.log'), `${lines.join('\n')}\n`, 'utf8')
    } catch {
      // 落盘失败不影响退出码
    }
    app.exit(result.exitCode)
    return
  }

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
 * 退出清理：顺序是**硬要求**，不能对调。
 *
 *   ① `disposeChatRuntime()` —— Pi 的 `session.dispose()`（JSONL flush）+ 工具调用轨迹落盘。
 *      **必须排在停 sidecar 之前**：Tool 可能是最后一个写 `/api/*` 的调用方，
 *      dispose 之后不应再有 `/api` 请求（sidecar 先死会让最后一条学习记录丢在重试队列里）。
 *   ② 杀掉 sidecar 的**整棵进程树**（Windows 上 `uv → python` 会留下孤儿进程占端口）。
 *
 * 每一步各自 try/catch：**收尾失败不能挡住退出**（否则用户只能去任务管理器杀进程）。
 * 先 `preventDefault` 把退出推迟到两步都结束，再 `app.quit()`；`quitting` 保证只跑一次、不会递归。
 *
 * ★ 一次性保证：`quitting` 置位后就永远走上面那个 early return，
 *   所以即使 `app.quit()` 再次触发 `before-quit`，也不会重复杀进程。
 * ★ 双保险：`registerIpcHandlers()` 里还有一条幂等的 `before-quit` 兜底
 *   （`disposeChatRuntime()` 自身幂等，重复调用不会二次 dispose），
 *   这里保留它 —— 入口改动被误删时，JSONL 仍不会半写。
 */
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()

  const current = sidecar
  sidecar = null

  void (async () => {
    // ① 先 flush Pi 会话（`before-quit` 里必须 await，否则进程可能在 flush 前就没了）
    try {
      await disposeChatRuntime()
    } catch (error) {
      console.error('[main] Pi 会话收尾异常（继续退出）：', error)
    }

    // ② 再停 sidecar（整棵进程树）
    try {
      await (current ? current.stop() : Promise.resolve())
    } catch (error) {
      // 收尾异常不能挡住退出：日志留在 stderr，进程该走还得走
      console.error('[main] sidecar 收尾异常：', error)
    }
  })().finally(() => {
    app.quit()
  })
})
