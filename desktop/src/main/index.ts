/**
 * Electron 主进程入口：窗口 + 生命周期 + sidecar 管家接线。
 *
 * 分工（执行文档 §7.4）：
 *   - 本文件只负责「创建窗口 → 启动 sidecar → 把状态推给渲染进程 → 退出时杀干净」。
 *   - Pi Agent 运行时接线点在 `src/main/agent/`（票 03 建立底座，票 06/08 全面接入）。
 *
 * ★ **单实例**：`requestSingleInstanceLock()` 在模块作用域早期就调用（必须在 `whenReady` 之前），
 *   第二个实例直接退出、第一个实例收到 `second-instance` 时聚焦主窗口 ——
 *   否则两个进程会同时写同一份 `students/<id>/`（一人一库变成一库两写）。
 *
 * ⚠️ **本文件是 ESM**（构建产物 `out/main/index.mjs`，见 `electron.vite.config.ts` 的注释）：
 *    - **没有 `__dirname`**，一律用 `import.meta.dirname`；
 *    - 相对导入**必须带 `.ts` 后缀**（ESM 不做扩展名补全）——这也是 `scripts/pi-smoke.mjs`
 *      能直接 import 同一份 TS 实现的前提。
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { runPiSmoke } from './agent/pi-bootstrap.ts'
import { IPC } from './ipc/channels.ts'
import { disposeChatRuntime, registerIpcHandlers } from './ipc/handlers.ts'
import { decidePortableDataDir } from './portable.ts'
import { SidecarManager } from './sidecar/manager.ts'
import { BRAND_NAME } from '@shared/brand'

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

/**
 * 窗口尺寸与外观。
 *
 * ★ **1440×900 是设计基准**（`docs/ui/版式契约.md` 与 `assets/base.css` 的断点都按它写）：
 *   - `<1280` 会让侧栏收成 64px 图标条、对话右栏改浮层（响应式是**有意的**，
 *     但演示与验收要在一屏里看全，所以默认开 1440）；
 *   - `#app` 有 `min-width: 1120px`（正文阅读栏 + 侧栏 + 右栏的下限），
 *     窗口比它窄就会出横向滚动条 —— 所以 **minWidth 也取 1120**，
 *     让「窗口能缩到多小」与「界面能排到多小」是同一个数，
 *     不会出现「拖到 900 宽就横向滚动」这种看起来像错位的状态。
 *
 * ★★ **无边框窗口（`frame: false`）+ 页面内自绘的窗口按钮**：
 *   Windows 原生标题栏是系统灰、带应用图标与菜单，与本设计（浅色纸面 + 学段配色）
 *   完全不是一套视觉；且它会在顶栏之上再压一行，把「对话优先」的纵向空间吃掉一截。
 *   代价与配套（少任何一条都会让窗口变得不好用）：
 *     ① **拖拽**：顶栏那一行必须是拖拽区（`AppShell.vue` 的 `.shell__head`），
 *        且里面的**可交互元素**要显式 `no-drag`（否则点不动）；
 *     ② **窗口按钮**：最小化 / 最大化 / 关闭做在页面里（`WindowControls.vue`），
 *        经 IPC 走 `window:*` 那四条通道 —— 渲染进程没有 Node 能力，只能这样要；
 *     ③ **最大化状态要推回渲染进程**：按钮图标得知道现在是「最大化」还是「还原」，
 *        而拖拽/双击/贴边吸附（Win+方向键）都会改变它，渲染进程自己看不到。
 *   `titleBarStyle: 'hidden'` 是 macOS 的路子（Windows 上配合 `titleBarOverlay`
 *   会得到**系统画的**按钮，与本设计仍然不是一套）—— 所以用 `frame: false`。
 */
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 900
/** 与 `assets/base.css` 的 `#app { min-width }` 对齐（见上面第 ①② 条的理由）。 */
const WINDOW_MIN_WIDTH = 1120
const WINDOW_MIN_HEIGHT = 700

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    title: BRAND_NAME,
    // ★ 窗口 / 任务栏图标：不设的话 Windows 上显示的是 **Electron 的原子图标** ——
    //   那是别人的牌子，而它是学生每天在任务栏上看到的第一眼。
    // ★ 路径必须是**两个模式下都存在**的那一份。`build/icon.png` 看着最自然，但
    //   electron-builder 把 `build/` 当**构建资源**（只拿它生成 exe 图标），
    //   **不会**打进 app.asar —— 打包态会指向一个不存在的文件（实测确认）。
    //   而 `resources/brand/` 两种模式都在：开发态是 `desktop/resources/brand/`，
    //   打包态在 `app.asar.unpacked/resources/brand/`（`asarUnpack` 收录了 `resources/**`）。
    // ⚠️ 用打包态**实际存在**的那份（同一张 `logos/mainlogo.png` 的 256px 版，
    //   与任务栏图标同源），而不是为了「看着整齐」去 copy 一份到别处。
    icon: join(import.meta.dirname, '../../resources/brand/main.png'),
    // 无边框：标题栏由页面自己画（见上面那段说明）
    frame: false,
    // 屏上居中：默认位置在 Windows 上是「系统决定」，多显示器下可能开在副屏
    center: true,
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

  // ★ 最大化状态变了就推给渲染进程（按钮图标要跟着换）。
  //   这两个事件覆盖「双击拖拽区」「系统菜单」「Win+↑/↓」「拖到屏幕上边缘」全部路径 ——
  //   渲染进程自己无法观察到这些。
  window.on('maximize', () => pushWindowState(window))
  window.on('unmaximize', () => pushWindowState(window))

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

/**
 * 把当前最大化状态推给该窗口的渲染进程。
 *
 * ★ 只推给**这一个**窗口（不是 `getAllWindows()`）：这是窗口自身的属性。
 * ★ 已销毁的窗口不发（对销毁后的 `webContents` 调用会抛）。
 */
function pushWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  window.webContents.send(IPC.windowMaximizedChanged, window.isMaximized())
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

/**
 * ★ 便携（绿色）版：把 Electron 的 `userData` 挪到**程序旁边的 `data/`**，
 * 使全部本地数据（config.json / learning.db / Pi JSONL / 日志）随程序目录走。
 *
 * 为什么必须显式改道：Electron 默认把 `userData` 放在
 * `%APPDATA%/<appName>` —— 便携版拷到别人机器上跑，数据会散落在系统盘，
 * 既不符合「绿色版」的预期，也会让**上一台机器的学习记录留在本机**。
 *
 * 判定方式（两条都认，避免「双击 exe 没带开关」时行为不一致）：
 *   ① 环境变量 `K12_PORTABLE=1`；
 *   ② **exe 同级存在 `portable.marker`**（构建便携版时随包放进去）。
 *
 * ⚠️ 必须在 `whenReady` **之前**调用 `app.setPath`：一旦有窗口或任何模块
 *    读过 userData，再改就来不及了（那时目录已经被创建/写入）。
 * ⚠️ 只在打包态生效：开发态若也改道，`npm run dev` 会把数据写进 `desktop/`，
 *    污染源码目录。
 *
 * ★★ **「哪个目录」这件事在 `portable.ts` 里判**（纯函数、可单测）——
 *    这里只负责「问它 + 应用结果」。为什么必须把判定分出去：那个函数里
 *    写着 P0-1 那个**数据丢失**事故的原因（单文件便携解压到 `%TEMP%` 再运行，
 *   数据写那儿每次重启即清空），而这段逻辑此前混在导入 Electron 的模块里没法单测，
 *    只能靠真机复现 —— 而那正是它漏了两轮测试的原因。
 */
function applyPortableDataDir(): boolean {
  const exeDir = dirname(app.getPath('exe'))
  let markerExists = false
  try {
    markerExists = existsSync(join(exeDir, 'portable.marker'))
  } catch {
    markerExists = false
  }

  const decision = decidePortableDataDir({
    isPackaged: app.isPackaged,
    exeDir,
    tempDir: tmpdir(),
    // ★ 这条环境变量**可能拿不到**（NSIS 启动器未把子进程继承链接全）——
    //   拿不到就靠 exeDir 兜底，而不是像旧实现那样据此放弃改道。
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR ?? null,
    markerExists,
    forced: process.env.K12_PORTABLE === '1',
    // ★ 显式逃生舱（`K12_DATA_DIR`）：与是否便携无关，优先级最高。
    explicitDataDir: process.env.K12_DATA_DIR ?? null
  })

  if (!decision.redirect || decision.dataDir === null) {
    if (decision.reason === 'temp-unpack-dir') {
      // ★★ 这里是 P0-1 的修复点：单文件便携形态跑在 `%TEMP%\<unpackDirName>` 里，
      //    那个目录退出即被 `RMDir /r`。**不往那儿写数据**，退回默认的固定 slug
      //    目录（`%APPDATA%\<slug>`，跨重启存活）。想把数据放 exe 旁边请用 zip 形态。
      console.warn(
        '[main] 便携单文件形态：数据目录在临时解压目录里，已改用默认的持久目录（%APPDATA%\\k12-agent-desktop）。' +
          '若想让数据跟着程序走，请用 zip（绿色）形态解压到固定目录再运行，或用 K12_DATA_DIR 显式指定。'
      )
    }
    return false
  }

  try {
    app.setPath('userData', decision.dataDir)
    app.setPath('sessionData', join(decision.dataDir, 'session'))
    console.warn(`[main] 便携模式：数据目录 = ${decision.dataDir}`)
    return true
  } catch (error) {
    // 改道失败（例如装在只读目录）：退回默认 userData，**不让应用起不来**
    console.error('[main] 便携模式改道失败，退回默认 userData：', error)
    return false
  }
}

// ★ 便携改道必须早于 whenReady（见函数注释）。返回值决定要不要再钉 slug（见下）。
const portableDataDirApplied = applyPortableDataDir()

/**
 * ★★ 把 `userData` 的目录名**钉死**，与品牌名解耦。
 *
 * 为什么必须显式钉：Electron 默认用 `productName`（打包后）/ `package.json` 的 `name`（开发态）
 * 作为 `%APPDATA%` 下的目录名。本项目的品牌名会改（例如「智团团」），
 * 一改 `userData` 就换了目录 —— **学生的 config.json / learning.db / Pi 会话 JSONL
 * 会留在旧目录里「凭空消失」**，而应用看起来像新装的一样（合规与演示双重事故）。
 *
 * 所以：品牌名只用于**界面展示**，存储目录名用固定的 slug。
 * ⚠️ 这个 slug **不要在后续版本里再改**；确需变更时必须写迁移逻辑
 *   （把旧目录整体搬过去），不能只是改字符串。
 * ⚠️ 与便携模式的关系：便携模式把 userData 指到 exe 同级 `data/`（**显式路径**），
 *   那是另一套形态、不受本函数影响，所以这里直接跳过（用返回值判断，不要自己再读一遍环境变量 ——
 *   `applyPortableDataDir()` 还认 `portable.marker`，只看 env 会漏掉 marker 那条路径）。
 */
const STABLE_USER_DATA_SLUG = 'k12-agent-desktop'

function applyStableUserDataSlug(): void {
  if (portableDataDirApplied) return
  const current = app.getPath('userData')
  const stable = join(dirname(current), STABLE_USER_DATA_SLUG)
  if (current === stable) return
  try {
    app.setPath('userData', stable)
  } catch (error) {
    // 改道失败不能让应用起不来：退回 Electron 默认值（仍是可用状态，只是目录名随品牌）
    console.error('[main] 固定 userData 目录名失败，沿用默认值：', error)
  }
}

applyStableUserDataSlug()


/**
 * ★★ 单实例锁（必须在 `whenReady` 之前，见下面的注释）。
 *
 * 为什么**必须**有它：双击两次 exe（或 exe + 快捷方式）会让两个实例各自 spawn 一个 sidecar
 * （各自随机端口/token），但 `--data-dir` 是**同一个** `userData` —— 两个进程同时打开
 * `students/<id>/learning.db`、同时 append 同一份 `students/<id>/pi-agent/` 与
 * `logs/sidecar.log`、同时重写 `config.json` / `models.json`。后果是 SQLite `SQLITE_BUSY`、
 * 设置互相覆盖、Pi 目录被两个进程交叉改写 ——「一人一库、不跨学生复用」在双开下变成「一库两写」。
 *
 * 位置要求在 `whenReady` **之前**：第二个实例必须**在起 sidecar / 建窗口之前**就退出，
 * 否则它已经把 sidecar 拉起来、已经开始写那份共享数据了，锁也就白拿了。
 * 退出走的是 `app.quit()`：**第二个实例从不 `registerIpcHandlers()`**，因此本文件的
 * `before-quit` 清理不会被触发（那是对的 —— 那个实例没有 sidecar 也没有会话要收尾）。
 *
 * 拿不到锁的实例**不会**继续往下走：`whenReady` 与它的全部接线都放在 `else` 分支里，
 * 所以「第二个实例起 sidecar / 建窗口」在设计上就不可能发生（不是靠一个 early return 挡着）。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // 第二个实例：立刻退出（不建窗口、不起 sidecar、不碰任何数据目录）
  app.quit()
} else {
  // 已被第一个实例占位：用户再次双击时，把那个窗口拉到前台（而不是让新实例悄悄起来）
  app.on('second-instance', () => {
    const window = mainWindow
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

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
}

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
