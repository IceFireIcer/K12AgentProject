/**
 * Pyodide 执行 Worker（票 18）—— ★★ **学生代码唯一被允许执行的地方**。
 *
 * ---------------------------------------------------------------------------
 * 为什么是 Worker，而且必须是**专门的**一个
 * ---------------------------------------------------------------------------
 *
 * 执行文档 §12 的沙箱三重隔离：
 *
 *     ① 动画 iframe（`sandbox="allow-scripts"`，**不放开同源**）
 *     ② **Pyodide 独立 Web Worker**（本文件）
 *     ③ 主线程 / sidecar 进程 —— 三者互不共享执行环境
 *
 * 学生代码一旦跑在主线程，`while True` 会冻住整个界面（连"停止"按钮都点不动）；
 * 跑在主进程则更糟：Pi 的 Extension 与 Agent 同进程且拥有完整系统权限
 * （执行文档 §12 把这升级成硬约束，守卫在 `desktop/tests/coding-extension.test.ts` 的 G18-1）。
 *
 * ---------------------------------------------------------------------------
 * ★★ 死循环中断：`setInterruptBuffer` + **必须由别的线程写 SIGINT**
 * ---------------------------------------------------------------------------
 *
 * 这是本文件最容易做错的一处，实测结论（不是推测）：
 *
 *   - Pyodide 的 `setInterruptBuffer(Int32Array)` 让 Python 在执行期间轮询这块内存；
 *     写入 `SIGINT`（值 2）会抛 `KeyboardInterrupt` 打断**同步**的 `runPython`。
 *   - ⚠️ **在同一线程里用 `setTimeout` 写这块 buffer 是没用的**：
 *     `runPython` 是同步阻塞调用，会占满线程的事件循环，定时器根本不会触发 ——
 *     实测结果是**整个进程挂死**（`node` 退出码 124 = 超时被 kill）。
 *     这正是"以为加了超时、其实一点保护都没有"的典型陷阱。
 *   - ✅ 正确做法：SIGINT 必须从**另一个线程**写入。所以本 Worker 采用
 *     **主线程 ↔ Worker 双线程**结构，且由**主线程**拥有定时器：
 *
 *         CodingCard（主线程）
 *           ├─ new Worker(pyodide.worker.ts)
 *           ├─ 发 {type:'run', ...}
 *           ├─ 启动 setTimeout(timeoutMs) ──▶ 到点写 SIGINT 到共享内存
 *           └─ 收 {type:'result' | 'timeout' | 'error'}
 *
 *         本 Worker
 *           ├─ 收 'init'：懒加载 Pyodide + numpy（**进卡片才加载**）
 *           ├─ 收 'run'：同步 `runPython`
 *           └─ Python 轮询共享内存 → 抛 KeyboardInterrupt → 回传原始 traceback
 *
 * `SharedArrayBuffer` 是 `setInterruptBuffer` 的前提。⚠️ **它默认不可用**：
 * 实测 Electron 的渲染进程（`file://` 与 `data:`）里 `typeof SharedArrayBuffer === 'undefined'`，
 * 需要主进程 `app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')`
 * （`src/main/index.ts`，一行）。**启动时自检**：拿不到 SAB 就如实降级为
 * 「只有墙钟超时、无法中断」并把这件事报给界面，绝不假装有保护（见 {@link capability}）。
 *
 * 中断发生时，本 Worker 回传的是 **Pyodide 抛出的 `KeyboardInterrupt` 的原始 traceback** ——
 * 与其它报错走同一条归一化路径（`server/app/routes/code.py` 的翻译表），
 * 所以「死循环」和「写错了」在数据结构上同形，靠类名区分文案。
 *
 * ---------------------------------------------------------------------------
 * 离线自托管（★ 任何 CDN 引用都是断网演示的必然翻车点）
 * ---------------------------------------------------------------------------
 *
 * 资源全部来自**本地** `<renderer>/pyodide/`（构建期由 vite 从 `src/renderer/public/` 拷入）：
 *
 *     pyodide.mjs / pyodide.asm.mjs / pyodide.asm.wasm / python_stdlib.zip
 *     pyodide-lock.json
 *     numpy-<ver>-cp314-cp314-pyemscripten_2026_0_wasm32.whl   ← 见下方"为什么文件名这么长"
 *
 * ⚠️ **wheel 的文件名必须与 `pyodide-lock.json` 里的 `file_name` 逐字相同**：
 * Pyodide 是按**锁定文件名**去 `indexURL` 找包的，改了名字它认不出来，
 * 就会**静默回退到 CDN**（实测：`Didn't find package numpy-…-wasm32.whl locally,
 * attempting to load from https://cdn.jsdelivr.net/…`）—— 断网时这一步直接失败。
 * 把文件放对名字之后，`loadPackage('numpy')` 全程不再产生任何网络请求。
 *
 * **matplotlib 不随包**（票 18 要求把决策与体积记进票尾）：
 * 实测其依赖闭包共 12 个包、约 **8.8 MB**（其中 matplotlib 本体 6.98 MB、
 * pillow 1.04 MB），加上 Pyodide 运行时本体（wasm 9.2 MB + stdlib 2.4 MB）
 * 与 numpy（2.8 MB），编程模块的静态资源会从 16 MB 涨到约 25 MB。
 * 本项目是「随包分发 + 全本地」的安装包（不是网页），体积直接进安装包；
 * 而教学场景里的排序/决策树/神经网络都只需要 `print` 与 numpy，
 * **故本期不预置 matplotlib**。代价：`import matplotlib` 会报
 * 「找不到这个模块」，由报错翻译给出可读中文（`ModuleNotFoundError` 那一条）。
 *
 * ---------------------------------------------------------------------------
 * 懒加载（票 18 验收项：进卡片才加载）
 * ---------------------------------------------------------------------------
 *
 * 本文件**不在模块顶层调用 `loadPyodide`**，而是等 `init` 消息。
 * `CodingCard.vue` 只在编程卡片真的被打开时才 `new Worker(...)` + 发 `init`，
 * 并在加载前后各打一次时间戳（`loadedAt - requestedAt` 就是"没有提前加载"的证据）。
 *
 * 本文件是 **module worker**（`new Worker(url, { type: 'module' })`）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Pyodide 的 API 面很大，只声明用到的部分 */

/** Worker 侧 Pyodide 的最小结构面（不从 `pyodide` 包 import 类型：它还没安装，见文件头）。 */
interface PyodideLike {
  version: string
  runPython(code: string): unknown
  loadPackage(name: string): Promise<void>
  setStdout(options: { batched: (text: string) => void }): void
  setStderr(options: { batched: (text: string) => void }): void
  setInterruptBuffer(buffer?: Int32Array): void
  globals: { set(name: string, value: unknown): void }
}

interface LoadPyodideOptions {
  indexURL: string
  /** 关掉"自动去 CDN 找包"这条退路（见文件头：静默回退会让断网演示翻车）。 */
  packageCacheDir?: string
}

/* ------------------------------------------------------------------ *
 * 消息协议（主线程 ↔ Worker）
 * ------------------------------------------------------------------ */

export interface InitMessage {
  type: 'init'
  /** Pyodide 资源目录（相对页面）。默认 `./pyodide/`。 */
  indexURL?: string
  /** 预置包（默认 `['numpy']`；空数组 = 只加载运行时，更快）。 */
  packages?: string[]
}

export interface RunMessage {
  type: 'run'
  /** 配对用（主进程那条链的 `requestId` 会一路传下来，轨迹图靠它关联）。 */
  runId: string
  code: string
  timeoutMs: number
}

export type WorkerInbound = InitMessage | RunMessage

export interface ReadyMessage {
  type: 'ready'
  version: string
  /** 懒加载耗时（主线程据此记录"进卡片才开始加载"的证据）。 */
  loadMs: number
  /** 已就绪的包。 */
  packages: string[]
  /** ★ 能力自检结果（`interruptible=false` 时界面必须如实告知"无法中断"）。 */
  capability: CapabilityReport
  /**
   * ★★ 中断用的共享内存（**同一块**交给主线程写 SIGINT）。
   *
   * `null` = 本环境拿不到 `SharedArrayBuffer`（`capability.interruptible === false`）——
   * 此时**没有**真正的中断保护，主线程只能靠墙钟超时。如实告知，不假装有。
   *
   * SAB 经结构化克隆是**共享**而非拷贝，所以主线程 `Atomics.store` 的内容
   * Pyodide 在 Worker 里立刻看得到 —— 这是中断能生效的全部机制。
   */
  interruptBuffer: SharedArrayBuffer | null
}

export interface CapabilityReport {
  /** 是否拿得到 `SharedArrayBuffer`（`setInterruptBuffer` 的前提）。 */
  interruptible: boolean
  /** 自检给出的说明（面向排错，不是面向学生）。 */
  detail: string
}

export interface ResultMessage {
  type: 'result'
  runId: string
  stdout: string
  stderr: string
  /** 是否被**中断**（主线程写 SIGINT 后 Pyodide 抛 KeyboardInterrupt）。 */
  interrupted: boolean
  elapsedMs: number
}

export interface ErrorMessage {
  type: 'error'
  runId: string
  /** 运行器层面的故障（Pyodide 没加载起来 / Worker 崩了）——**不是**学生的报错。 */
  failure: string
}

/** 中断信号：Pyodide 约定写入 `SIGINT`（值 2）即抛 `KeyboardInterrupt`。 */
export const SIGINT = 2

/** 默认预置包（票 18：预置 numpy；matplotlib 按体积砍掉，见文件头）。 */
export const DEFAULT_PACKAGES = ['numpy'] as const

/** 默认 Pyodide 资源目录（vite 把 `src/renderer/public/pyodide/` 拷到这个相对路径）。 */
export const DEFAULT_INDEX_URL = './pyodide/'

/* ------------------------------------------------------------------ *
 * 分工：Worker 与主线程各管一半（**这是"中断能生效"的关键**）
 * ------------------------------------------------------------------ *
 *
 * ⚠️ **本 Worker 里不放任何定时器。**
 *
 * 原因见文件头：`runPython` 是同步阻塞的，本线程的 `setTimeout` 在死循环期间
 * 永远不会触发（实测：整个进程挂死、退出码 124）。所以超时**必须**由主线程掌握。
 *
 * 本文件只负责三件事：
 *   1. `ready` 消息里把一块 4 字节的 `SharedArrayBuffer` 交给主线程
 *      （若能力自检发现 SAB 不可用，则给 `null`，并如实标注 `interruptible: false`）；
 *   2. 同步执行 `runPython`，把**原始** traceback 回传（不做友好化）；
 *   3. 由 Pyodide 自己在执行期间轮询那块内存 —— 主线程写入 2（SIGINT）即抛 `KeyboardInterrupt`。
 *
 * 主线程那一半（定时器、写 SIGINT、**执行完把内存清回 0**）见
 * `sandbox/pyodide-runner.ts`。两边通过 `postMessage` 传的是**同一块**共享内存
 * （SAB 走结构化克隆是共享而非拷贝），所以主线程写得进去。
 */

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

let pyodide: PyodideLike | null = null
let loadMs = 0
let capability: CapabilityReport = { interruptible: false, detail: '尚未自检' }
/** ★ 中断用的共享内存（**同一块**交给主线程写 SIGINT；`null` = 本环境不支持中断）。 */
let interruptBuffer: Int32Array | null = null
/** 当前正在执行的 runId（中断回执要能对上；同一时刻只允许一次执行）。 */
let currentRunId: string | null = null

/**
 * 能力自检：`setInterruptBuffer` 需要 `SharedArrayBuffer`。
 *
 * ⚠️ 这里**如实上报**而不是乐观假定：拿不到 SAB 时，"超时中断"这条保护其实不存在，
 * 界面必须把这件事说清楚（`interruptible=false`），否则演示现场遇到死循环时
 * 学生会以为界面卡了、而我们会以为"超时没生效"——两个方向的误判都要避免。
 */
function probeCapability(): CapabilityReport {
  if (typeof SharedArrayBuffer === 'undefined') {
    return {
      interruptible: false,
      detail:
        'SharedArrayBuffer 不可用（需要主进程开启 enable-features=SharedArrayBuffer）——' +
        '本次只能靠主线程的墙钟超时，无法真正中断死循环。'
    }
  }
  try {
    // 真正分配一块试试（有的环境 SAB 存在但分配会抛）
    const probe = new SharedArrayBuffer(4)
    if (new Int32Array(probe).length !== 1) throw new Error('Int32Array 视图异常')
    return { interruptible: true, detail: 'SharedArrayBuffer 可用，setInterruptBuffer 已就绪。' }
  } catch (error) {
    return {
      interruptible: false,
      detail: `SharedArrayBuffer 分配失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/* ------------------------------------------------------------------ *
 * 输出捕获
 * ------------------------------------------------------------------ */

/**
 * stdout / stderr 的**有界**缓冲。
 *
 * 为什么要限：`while True: print(x)` 这种代码（哪怕 1 秒）也能吐出几十 MB，
 * 无界收集会先把 Worker 的内存吃光 —— **那比死循环更难排查**（看起来像"随机崩溃"）。
 * 达到上限后只统计丢弃了多少行，并在回传时如实说明。
 */
export class BoundedText {
  private readonly chunks: string[] = []
  private length = 0
  private dropped = 0
  /**
   * ★ 上限写成**显式字段 + 构造函数赋值**，不用 TS 的「参数属性」简写
   *   （`constructor(private readonly limit = 64 * 1024)`）。
   *
   * 为什么：本项目的纯逻辑单测走 `node --test` **直接跑 `.ts`**（Node 的类型擦除模式），
   * 那个模式不支持参数属性，会当场报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
   * —— 给这个类补一条单测（既定做法）就会炸，而报错形态很像"环境坏了"，
   * 极易被误判成工具链问题。
   */
  private readonly limit: number

  constructor(limit = 64 * 1024) {
    this.limit = limit
  }

  push(text: string): void {
    if (text.length === 0) return
    if (this.length >= this.limit) {
      this.dropped += 1
      return
    }
    const room = this.limit - this.length
    if (text.length <= room) {
      this.chunks.push(text)
      this.length += text.length
      return
    }
    this.chunks.push(text.slice(0, room))
    this.length += room
    // 剩下的算作丢弃的片段（保留一行提示，避免"输出凭空少了一截"）
    this.dropped += 1
  }

  /** 取全文（超过上限时附一句说明）。 */
  value(): string {
    const text = this.chunks.join('')
    if (this.dropped === 0) return text
    const note = text.endsWith('\n') ? '' : '\n'
    return `${text}${note}…（输出过多，已截断 ${this.dropped} 段）`
  }
}

/* ------------------------------------------------------------------ *
 * 消息处理
 * ------------------------------------------------------------------ */

/** 把 Pyodide 的原始异常转成 traceback 文本（**不做任何友好化**：那是 Python 的职责）。 */
export function rawTracebackOf(error: unknown): { stderr: string; interrupted: boolean } {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error)
            } catch {
              return String(error)
            }
          })()

  // Pyodide 的 PythonError.message 就是 CPython 的 traceback 原文。
  // 中断与普通报错在这里同形，靠类名区分（`KeyboardInterrupt`）。
  const interrupted = /KeyboardInterrupt/.test(message)
  return { stderr: message, interrupted }
}

async function handleInit(message: InitMessage): Promise<void> {
  const indexURL = message.indexURL ?? DEFAULT_INDEX_URL
  const packages = message.packages ?? [...DEFAULT_PACKAGES]
  const startedAt = performance.now()

  capability = probeCapability()

  // ★ 动态 import：这一行**没有**出现在模块顶层 —— 只有收到 `init` 才去拉那个 9 MB 的 wasm。
  const module = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as {
    loadPyodide: (options: LoadPyodideOptions) => Promise<PyodideLike>
  }
  const instance = await module.loadPyodide({ indexURL })

  if (packages.length > 0) {
    // 逐个装，失败一个不影响其它（`ModuleNotFoundError` 由 Python 侧的报错翻译兜住）
    for (const name of packages) {
      try {
        await instance.loadPackage(name)
      } catch {
        // 装不上不要在这里抛：运行时本身是可用的，缺包会以 ModuleNotFoundError 出现在学生面前
      }
    }
  }

  pyodide = instance
  loadMs = Math.round(performance.now() - startedAt)

  // ★★ 接上中断通道：**建 SAB → 交给 Pyodide → 同一块交给主线程**。
  //    顺序不能反：`setInterruptBuffer` 必须在任何 `runPython` 之前调用，
  //    否则第一次执行期间 Pyodide 根本不知道去哪儿看中断标志。
  let sharedBuffer: SharedArrayBuffer | null = null
  if (capability.interruptible) {
    sharedBuffer = new SharedArrayBuffer(4)
    interruptBuffer = new Int32Array(sharedBuffer)
    instance.setInterruptBuffer(interruptBuffer)
  }

  const ready: ReadyMessage = {
    type: 'ready',
    version: instance.version,
    loadMs,
    packages,
    capability,
    interruptBuffer: sharedBuffer
  }
  self.postMessage(ready)
}

function handleRun(message: RunMessage): void {
  const instance = pyodide
  if (!instance) {
    const failure: ErrorMessage = {
      type: 'error',
      runId: message.runId,
      failure: '代码运行器还没准备好，稍等一下再点运行试试。'
    }
    self.postMessage(failure)
    return
  }

  const stdout = new BoundedText()
  const stderr = new BoundedText()
  // Pyodide 把 print / 异常输出经这两个钩子送出来；`batched` 是"按行批量"的形态
  instance.setStdout({ batched: (text) => stdout.push(`${text}\n`) })
  instance.setStderr({ batched: (text) => stderr.push(`${text}\n`) })

  currentRunId = message.runId
  const startedAt = performance.now()
  let interrupted = false

  try {
    instance.runPython(message.code)
  } catch (error) {
    const parsed = rawTracebackOf(error)
    interrupted = parsed.interrupted
    // ★ 原始 traceback 原样带走（中文翻译在 Python 侧，单一实现处）
    //   Pyodide 的异常 message 里已经含 traceback；再补上 str(e) 的正文更保险。
    stderr.push(parsed.stderr.endsWith('\n') ? parsed.stderr : `${parsed.stderr}\n`)
  } finally {
    currentRunId = null
  }

  const result: ResultMessage = {
    type: 'result',
    runId: message.runId,
    stdout: stdout.value(),
    stderr: stderr.value(),
    interrupted,
    elapsedMs: Math.round(performance.now() - startedAt)
  }
  self.postMessage(result)
}

/**
 * Worker 入口。
 *
 * ★ 每一件事都包在 try/catch 里：Worker 抛出的未捕获异常只会变成
 *   主线程上的 `onerror`（信息量很低），而我们要给学生/排查者一句可读中文。
 */
self.onmessage = (event: MessageEvent<WorkerInbound>): void => {
  const message = event.data
  if (!message || typeof message !== 'object') return

  if (message.type === 'init') {
    void handleInit(message).catch((error: unknown) => {
      // ★ 这句会**原样印到学生的编程页上**（走 `phase: 'failed'` 的 `failure`），
      //   所以它只能有一句学生能懂的话 —— 原来的「本地资源应位于 <renderer>/pyodide/；
      //   离线演示不允许走 CDN」是写给打包/排障的人看的（路径 + CDN 取舍），
      //   学生读到只会以为自己弄坏了什么。技术细节进 console，界面文案归学生。
      console.error('[pyodide] 初始化失败：', error)
      const failure: ErrorMessage = {
        type: 'error',
        runId: 'init',
        failure: '运行环境没准备好，这段时间先看点别的，或者稍后再试一次。'
      }
      self.postMessage(failure)
    })
    return
  }

  if (message.type === 'run') {
    try {
      handleRun(message)
    } catch (error) {
      const failure: ErrorMessage = {
        type: 'error',
        runId: message.runId,
        failure: '运行器内部异常：' + (error instanceof Error ? error.message : String(error))
      }
      self.postMessage(failure)
    }
  }
}

/* 供主线程读取（`ready` 消息里也带了一份；导出便于单测与调试） */
export function currentCapability(): CapabilityReport {
  return capability
}

export function currentRun(): string | null {
  return currentRunId
}
