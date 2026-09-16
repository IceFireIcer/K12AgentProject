/**
 * Pyodide 运行器的**主线程那一半**（票 18）。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件：中断必须由主线程掌握
 * ---------------------------------------------------------------------------
 *
 * `sandbox/pyodide.worker.ts` 里同步执行的 `runPython` 会占满**那个线程**的事件循环，
 * 所以 Worker 自己的 `setTimeout` 在死循环期间永远不会触发 ——
 * 实测结论是**进程直接挂死**（`node` 退出码 124），也就是"以为加了超时、其实没有保护"。
 *
 * 正确结构是双线程协作（本文件 = 左半边）：
 *
 *     CodingCard / 本文件（主线程）                    Worker（pyodide.worker.ts）
 *     ─────────────────────────────                   ──────────────────────────
 *     懒加载时：new Worker(...) + postMessage(init)
 *                                                     loadPyodide + numpy
 *                       ◀── ready { interruptBuffer } ── （同一块 SharedArrayBuffer）
 *     存下这块内存 ──▶
 *     run(code)：postMessage(run) + **启动 setTimeout**
 *                                                     runPython(code) 同步阻塞
 *     到点：Atomics.store(buffer, 0, 2)   ───────────▶  Pyodide 轮询到 SIGINT
 *                                                     → 抛 KeyboardInterrupt
 *                       ◀── result { stderr, interrupted:true } ──
 *     清 buffer 回 0，resolve
 *
 * ⚠️ 两个易错点，都在这里处理：
 *   ① **超时后必须把 buffer 清回 0**：否则下一次执行一开始就看到残留的 2，
 *      会立刻莫名被中断（"第二次运行总是失败"的鬼故事）；
 *   ② **清 buffer 必须在 resolve 之前**、且只在真正中断过之后 —— 见 {@link run}。
 *
 * ---------------------------------------------------------------------------
 * 懒加载（票 18 验收项）
 * ---------------------------------------------------------------------------
 *
 * 本模块**不在顶层创建 Worker**。{@link createPyodideRunner} 返回的对象在被
 * 首次 `run()`（或显式 `ensureReady()`）之前，不会发出任何资源请求。
 * `CodingCard.vue` 只在卡片被打开时创建它，并记录 `requestedAt` → `loadedAt` 的差值
 * 作为"进卡片才开始加载"的证据。
 *
 * ---------------------------------------------------------------------------
 * 与主进程的关系（安全边界）
 * ---------------------------------------------------------------------------
 *
 * 本文件跑在**渲染进程**，是被允许执行学生代码的地方。
 * 主进程（`src/main/agent/extensions/coding.ts`）只会通过 IPC 把代码送过来、
 * 等结果回传 —— 它自己不执行（守卫见 `desktop/tests/coding-extension.test.ts` 的 G18-1）。
 *
 * ⚠️ 本文件**不引用任何 CDN**：Pyodide 资源来自本地 `<renderer>/pyodide/`（离线演示的硬要求）。
 */

import type {
  CapabilityReport,
  ErrorMessage,
  ReadyMessage,
  ResultMessage,
  RunMessage,
  WorkerInbound
} from './pyodide.worker'

/**
 * Pyodide 资源目录（相对**页面**的路径；`publicDir` 把 `desktop/resources/**` 拷到这里）。
 *
 * ⚠️ 这只是兜底值：真正生效的是 {@link resolvePyodideIndexUrl}。
 */
export const PYODIDE_INDEX_URL = './pyodide/'

/**
 * 算出 Pyodide 资源目录的**绝对 URL**（★ 这一条踩过坑，别改回相对路径）。
 *
 * 为什么不能直接给 `./pyodide/`：那个相对路径是相对**发起 import 的模块**解析的。
 * 本文件是主线程模块，但真正 `import()` 的是 Worker（`sandbox/pyodide.worker.ts`），
 * 于是 `./pyodide/` 被解析成 dev server 下**本模块自己那一层**的路径，
 * 而 `publicDir` 把资源放在**应用根**下（`/pyodide/`）。实测就是这么翻车的：
 * 徽章变成「Python 环境不可用」，错误是
 * `Failed to fetch dynamically imported module: …/src/sandbox/pyodide/pyodide.mjs`。
 *
 * 用 `document.baseURI` 当基准，**开发态与打包态同时正确**：
 *   - 开发（vite dev server）：页面根 URL → `<页面根>/pyodide/`
 *   - 打包（`file://…/out/renderer/index.html`）：`file://…/out/renderer/pyodide/`
 *   （`index.html` 就在渲染产物根，`pyodide/` 与它同级 —— 两者都对得上。）
 *
 * ⚠️ 本文件里**不写字面量主机名**（架构守卫 G3 会扫出来）：基准一律从 `document.baseURI` 取，
 * 渲染进程不需要、也不该知道 sidecar 或任何服务地址。
 */
export function resolvePyodideIndexUrl(): string {
  const base = typeof document !== 'undefined' ? document.baseURI : null
  if (base) {
    try {
      return new URL('pyodide/', base).href
    } catch {
      // baseURI 不是合法 URL（极端情况）→ 退回相对路径，由 Worker 侧自己解析
    }
  }
  return PYODIDE_INDEX_URL
}

/** 预置包（票 18：numpy 预置；matplotlib 按体积砍掉，见 worker 文件头的体积实测）。 */
export const PYODIDE_PACKAGES = ['numpy'] as const

/** 单次执行的默认超时（与 `server/app/routes/code.py`、`coding.ts` 的 5s 对齐）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 5_000

/** 懒加载的宽限上限：超过它还没 ready 就如实报错（不要让界面无限转圈）。 */
export const LOAD_TIMEOUT_MS = 60_000

/** 中断信号的取值（Pyodide 约定：写 2 = SIGINT → KeyboardInterrupt）。 */
export const SIGINT = 2

/** 一次执行的结果。**原始数据**：中文反馈由 Python 侧产出（单一实现处）。 */
export interface RunOutcome {
  stdout: string
  stderr: string
  /** 是否被超时中断（`setInterruptBuffer` 生效的正向证据，票 18 的头号演示）。 */
  interrupted: boolean
  elapsedMs: number
  /** 运行器层面的故障（加载失败 / Worker 崩溃）——**不是**学生的报错。 */
  failure?: string
}

/** 加载状态（界面据此显示"正在准备 Python 环境…"）。 */
export interface RunnerStatus {
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  /** 懒加载耗时（毫秒；`null` = 还没加载完）。 */
  loadMs: number | null
  capability: CapabilityReport | null
  failure: string | null
}

export interface RunnerEvents {
  onStatus?: (status: RunnerStatus) => void
  /** 日志出口（默认 `console.info`）——「加载前后各打一次时间戳」的证据就落在这里。 */
  log?: (line: string) => void
}

export interface PyodideRunner {
  /** 确保 Worker 与 Pyodide 就绪（幂等；懒加载的唯一入口）。 */
  ensureReady(): Promise<void>
  /** 跑一段代码（内部会先 `ensureReady()`）。**永不 reject**：故障收敛成 `failure`。 */
  run(code: string, options?: { timeoutMs?: number }): Promise<RunOutcome>
  /** 当前状态快照。 */
  status(): RunnerStatus
  /** 拆掉 Worker（组件卸载时必须调用，否则 Worker 会一直活着占内存）。 */
  dispose(): void
}

/** 生成 runId（配对用；主进程那条链的 requestId 由调用方在需要时覆盖）。 */
let runSequence = 0

/**
 * 建一个 Pyodide 运行器（**懒加载**：不调用 `run`/`ensureReady` 就不会拉任何资源）。
 *
 * @param workerFactory 可注入（测试用假 Worker；生产用 `new Worker(new URL(...), {type:'module'})`）。
 */
export function createPyodideRunner(
  workerFactory: () => Worker,
  events: RunnerEvents = {}
): PyodideRunner {
  const log = events.log ?? ((line: string) => console.info(line))

  let worker: Worker | null = null
  let readyPromise: Promise<void> | null = null
  let status: RunnerStatus = {
    phase: 'idle',
    loadMs: null,
    capability: null,
    failure: null
  }

  /**
   * ★ 中断用的共享内存（`ready` 时由 Worker 交过来）。
   *
   * SAB 经 `postMessage` 是**共享**而非拷贝，所以主线程 `Atomics.store` 的内容
   * Worker 里的 Pyodide 立刻能看到 —— 这正是中断能生效的机制。
   */
  let interruptBuffer: Int32Array | null = null

  /** 正在等待回执的执行（`runId` → resolver）。同一时刻只允许一个（Python 是单线程）。 */
  let pending:
    | {
        runId: string
        resolve: (outcome: RunOutcome) => void
        timer: ReturnType<typeof setTimeout> | null
        startedAt: number
      }
    | null = null

  /** 懒加载的**发起时间戳**（与 Worker 回报的 `loadMs` 一起构成"没有提前加载"的证据）。 */
  let requestedAt: number | null = null

  function setStatus(next: Partial<RunnerStatus>): void {
    status = { ...status, ...next }
    events.onStatus?.(status)
  }

  function ensureReady(): Promise<void> {
    if (readyPromise) return readyPromise
    requestedAt = performance.now()
    log(`[pyodide] 懒加载开始（requestedAt=${Math.round(requestedAt)}）—— 此前未拉取任何资源`)
    setStatus({ phase: 'loading', failure: null })

    readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      const guard = setTimeout(() => {
        if (settled) return
        settled = true
        const failure = `Pyodide 加载超时（${LOAD_TIMEOUT_MS}ms 内没有就绪）。请检查 <renderer>/pyodide/ 下的本地资源是否完整。`
        // ★ 不能只有 reject：一个**永不 settle** 的 reject 会让界面无限转圈，
        //   所以 readyPromise 的失败要同时把状态改成 failed 并给可读文案。
        setStatus({ phase: 'failed', failure })
        readyPromise = null // 允许重试（现场演示时"再点一次"应该有意义）
        reject(new Error(failure))
      }, LOAD_TIMEOUT_MS)

      const created = workerFactory()
      worker = created

      created.onmessage = (event: MessageEvent<ReadyMessage | ResultMessage | ErrorMessage>): void => {
        const message = event.data
        if (!message || typeof message !== 'object') return

        if (message.type === 'ready') {
          interruptBuffer = message.interruptBuffer ? new Int32Array(message.interruptBuffer) : null
          setStatus({
            phase: 'ready',
            loadMs: message.loadMs,
            capability: message.capability,
            failure: null
          })
          log(
            `[pyodide] 懒加载完成：Pyodide ${message.version}，耗时 ${message.loadMs}ms` +
              `（懒加载证明：requestedAt=${Math.round(requestedAt ?? 0)} → readyAt=${Math.round(
                performance.now()
              )}）`
          )
          log(
            `[pyodide] 中断能力：${message.capability.interruptible ? '可用（setInterruptBuffer 已就绪）' : '不可用'}` +
              ` —— ${message.capability.detail}`
          )
          if (!settled) {
            settled = true
            clearTimeout(guard)
            resolve()
          }
          return
        }

        if (message.type === 'result') {
          settleRun(message)
          return
        }

        if (message.type === 'error') {
          if (message.runId === 'init') {
            // 加载失败：把 readyPromise 打回可重试状态
            setStatus({ phase: 'failed', failure: message.failure })
            if (!settled) {
              settled = true
              clearTimeout(guard)
              readyPromise = null
              reject(new Error(message.failure))
            }
            return
          }
          // 执行期故障（不是学生的报错）
          const current = pending
          if (current && current.runId === message.runId) {
            if (current.timer) clearTimeout(current.timer)
            pending = null
            clearInterruptBuffer()
            current.resolve({
              stdout: '',
              stderr: '',
              interrupted: false,
              elapsedMs: Math.round(performance.now() - current.startedAt),
              failure: message.failure
            })
          }
        }
      }

      // Worker 内部未捕获异常（脚本解析失败 / OOM）——收敛成可读错误，别让界面白屏
      created.onerror = (): void => {
        const failure = 'Python 运行环境（Worker）异常退出，可能是内存不足。请稍后重试。'
        setStatus({ phase: 'failed', failure })
        if (!settled) {
          settled = true
          clearTimeout(guard)
          readyPromise = null
          reject(new Error(failure))
          return
        }
        const current = pending
        if (current) {
          if (current.timer) clearTimeout(current.timer)
          pending = null
          current.resolve({
            stdout: '',
            stderr: '',
            interrupted: false,
            elapsedMs: Math.round(performance.now() - current.startedAt),
            failure
          })
        }
      }

      const init: WorkerInbound = {
        type: 'init',
        // ★ 绝对 URL（见 `resolvePyodideIndexUrl`）：相对路径会被解析到 Worker 自己的目录下，404
        indexURL: resolvePyodideIndexUrl(),
        packages: [...PYODIDE_PACKAGES]
      }
      created.postMessage(init)
    })

    return readyPromise
  }

  /**
   * 把中断标志清回 0。
   *
   * ⚠️ **必须做**：`Atomics.store(buffer, 0, 2)` 是一次性信号，Pyodide 不会自己清零。
   * 残留的 2 会让**下一次**执行一开始就被当成"已被中断" —— 表现为
   * "第一次跑死循环之后，后面所有代码都报 KeyboardInterrupt"（极难排查）。
   */
  function clearInterruptBuffer(): void {
    if (interruptBuffer) Atomics.store(interruptBuffer, 0, 0)
  }

  /** 兑现一次执行回执（并清掉中断标志）。 */
  function settleRun(message: ResultMessage): void {
    const current = pending
    if (!current || current.runId !== message.runId) return
    if (current.timer) clearTimeout(current.timer)
    pending = null
    clearInterruptBuffer()
    current.resolve({
      stdout: message.stdout,
      stderr: message.stderr,
      interrupted: message.interrupted,
      elapsedMs: message.elapsedMs
    })
  }

  async function run(code: string, options: { timeoutMs?: number } = {}): Promise<RunOutcome> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS

    try {
      await ensureReady()
    } catch (error) {
      return {
        stdout: '',
        stderr: '',
        interrupted: false,
        elapsedMs: 0,
        failure: error instanceof Error ? error.message : String(error)
      }
    }

    if (!worker) {
      return {
        stdout: '',
        stderr: '',
        interrupted: false,
        elapsedMs: 0,
        failure: 'Python 运行环境尚未就绪（Worker 未创建）。'
      }
    }
    if (pending) {
      // 同一个运行器上并发执行是不允许的（Python 是单线程，且中断标志会互相踩）
      return {
        stdout: '',
        stderr: '',
        interrupted: false,
        elapsedMs: 0,
        failure: '上一次运行还没结束，请等它跑完（或点停止）。'
      }
    }

    const runId = `run-${++runSequence}`
    const startedAt = performance.now()

    return await new Promise<RunOutcome>((resolve) => {
      // ★★ 主线程这一侧的定时器 —— **这才是真正能中断死循环的那个超时**
      //    （Worker 里的定时器在同步 runPython 期间永远不会触发，见文件头）。
      const timer =
        interruptBuffer !== null
          ? setTimeout(() => {
              // 写 SIGINT=2：Pyodide 在执行期间轮询这块内存，看到就抛 KeyboardInterrupt
              Atomics.store(interruptBuffer as Int32Array, 0, SIGINT)
              log(
                `[pyodide] 运行超时（${timeoutMs}ms）→ 已写入 SIGINT 中断信号` +
                  `（runId=${runId}，at=${Math.round(performance.now() - startedAt)}ms）`
              )
            }, timeoutMs)
          : null

      if (timer === null) {
        // 能力自检说不能中断 —— **如实告知**，不要假装有保护
        log(
          '[pyodide] 本次运行**无法中断**（SharedArrayBuffer 不可用）：' +
            '只能等代码自己结束；若界面卡住，请联系管理员开启 enable-features=SharedArrayBuffer。'
        )
      }

      pending = { runId, resolve, timer, startedAt }
      const message: RunMessage = { type: 'run', runId, code, timeoutMs }
      worker?.postMessage(message)
    })
  }

  function dispose(): void {
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve({
        stdout: '',
        stderr: '',
        interrupted: false,
        elapsedMs: 0,
        failure: '运行器已关闭（卡片已卸载）。'
      })
      pending = null
    }
    clearInterruptBuffer()
    interruptBuffer = null
    worker?.terminate()
    worker = null
    readyPromise = null
    setStatus({ phase: 'idle', loadMs: null, capability: null, failure: null })
  }

  return { ensureReady, run, status: () => status, dispose }
}

/**
 * 建一个真的 Pyodide Worker（生产用）。
 *
 * `type: 'module'` 是必须的：worker 里用 `import()` 动态拉 `pyodide.mjs`。
 * `new URL(..., import.meta.url)` 是 vite 认得的写法 —— **不要**改成字符串拼接，
 * 那样构建期就不会把它当成 worker 入口打包（生产构建会拿不到产物）。
 */
export function createBrowserPyodideWorker(): Worker {
  return new Worker(new URL('./pyodide.worker.ts', import.meta.url), { type: 'module' })
}

/* ------------------------------------------------------------------ *
 * ★ 窗口级单例：**一个窗口只该有一个 Pyodide 实例**
 * ------------------------------------------------------------------ *
 *
 * 为什么必须是单例：一套 Pyodide 运行时是 ~16 MB（wasm 9.2 MB + stdlib 2.4 MB + numpy 2.8 MB），
 * 而且每次 `loadPyodide` 都要重新初始化解释器（实测约 1.1 s）。如果「卡片自己跑」
 * 和「主进程派发过来跑」各建一个 Worker，内存与启动成本直接翻倍，
 * 更糟的是**中断标志会分家**（两块 SAB，主线程写的那块不是 Pyodide 在看的那块）。
 *
 * 用法：
 *   - `CodingCard.vue` 的运行按钮 → {@link runStudentCode}
 *   - 将来 `ipc/**` 把主进程的派发请求接进来 → {@link handleDispatchedRun}
 *     两者共用同一个 Worker、同一条中断通道。
 */

let sharedRunner: PyodideRunner | null = null

/**
 * 共享运行器的**状态订阅表**（每张编程卡片都想知道"Python 准备好了没有"）。
 *
 * 为什么不是"谁先创建谁的回调生效"（`getSharedRunner` 的 `events` 只在创建时看得见）：
 * 对话框里可以同时挂着多张编程卡片（学生在两三个知识点之间来回切），
 * 只让第一张收到状态更新，后面那几张就会永远停在"Python 待加载"。
 */
const statusListeners = new Set<(status: RunnerStatus) => void>()
let lastStatus: RunnerStatus = { phase: 'idle', loadMs: null, capability: null, failure: null }

/** 订阅共享运行器的状态（立即回调一次当前值；返回退订函数）。 */
export function subscribeRunnerStatus(listener: (status: RunnerStatus) => void): () => void {
  statusListeners.add(listener)
  listener(lastStatus)
  return () => {
    statusListeners.delete(listener)
  }
}

/** 当前状态快照（未加载时是 `idle`）。 */
export function runnerStatusSnapshot(): RunnerStatus {
  return lastStatus
}

/** 取窗口级共享运行器（首次调用**不会**加载任何资源 —— 懒加载在 `run()` 里）。 */
export function getSharedRunner(events: RunnerEvents = {}): PyodideRunner {
  if (!sharedRunner) {
    sharedRunner = createPyodideRunner(createBrowserPyodideWorker, {
      ...events,
      onStatus: (status) => {
        lastStatus = status
        for (const listener of statusListeners) {
          try {
            listener(status)
          } catch {
            // 一个订阅者出错不许影响其它卡片，也不许冒到渲染树
          }
        }
        events.onStatus?.(status)
      }
    })
  }
  return sharedRunner
}

/** 拆掉共享运行器（仅用于"整页卸载/测试清理"）。 */
export function disposeSharedRunner(): void {
  sharedRunner?.dispose()
  sharedRunner = null
  lastStatus = { phase: 'idle', loadMs: null, capability: null, failure: null }
}

/**
 * 跑一段学生代码（★ 卡片运行按钮与主进程派发**共用**的入口）。
 *
 * @param request.toolCallId 主进程派发时的 Pi 工具调用号（卡片自己跑时为 `undefined`）。
 *   它会进日志，让「这一轮模型调了 evaluate_code」与「学生自己点了运行」在排查时能分开。
 */
export async function runStudentCode(
  code: string,
  options: {
    timeoutMs?: number
    toolCallId?: string
    log?: (line: string) => void
  } = {}
): Promise<RunOutcome> {
  const runner = getSharedRunner({ log: options.log })
  const outcome = await runner.run(code, { timeoutMs: options.timeoutMs })
  if (options.toolCallId) {
    options.log?.(
      `[pyodide] 由主进程派发执行（toolCallId=${options.toolCallId}）：` +
        `${outcome.failure ? `运行器故障 ${outcome.failure}` : `完成于 ${outcome.elapsedMs}ms`}` +
        `${outcome.interrupted ? '（被中断）' : ''}`
    )
  }
  return outcome
}

/**
 * ★ **主进程派发执行的落点**（`ipc/**` 的处理器会调它，一行的接线）。
 *
 * 形状刻意与 `src/main/agent/extensions/coding.ts` 的 `CodeRunOutcome` 对齐：
 * 主进程拿到 `{stdout, stderr, interrupted, elapsedMs, failure?}` 后原样交给
 * `settleCodeRunResult()` 兑现那条 pending 的执行请求。
 *
 * ⚠️ 本函数**不做**任何"友好化"：原始 traceback 原样返回，
 * 由 Python 侧统一翻译（`server/app/routes/code.py`，单一实现处）。
 */
export async function handleDispatchedRun(request: {
  /** 主进程生成的请求号（必须原样回传，桥靠它配对）。 */
  requestId: string
  code: string
  timeoutMs?: number
  toolCallId?: string
  log?: (line: string) => void
}): Promise<{
  requestId: string
  stdout: string
  stderr: string
  interrupted: boolean
  elapsedMs: number
  failure?: string
}> {
  const outcome = await runStudentCode(request.code, {
    timeoutMs: request.timeoutMs,
    toolCallId: request.toolCallId,
    log: request.log
  })
  // 请求号**原样回传**（主进程的桥按它找到 pending；生成新号会让那条请求超时）
  return { requestId: request.requestId, ...outcome }
}

/**
 * ★★ **接上主进程派发通道**（渲染进程入口调用**一次**，一行）。
 *
 * 主进程的 `evaluate_code` Tool 经 IPC 把「要运行的代码」推过来（**它自己不执行**），
 * 本函数收到后在**本进程的 Worker 里**执行，再把原始结果回传。
 * 这条通道就是执行文档 §12 那条硬约束的落点：
 *
 *     主进程（Pi Tool）──code:execute──▶ 渲染进程（本函数）──▶ Pyodide Worker
 *     主进程（等回执）  ◀──code:result─── 渲染进程
 *
 * 为什么要封装成函数而不是让入口自己拼：`requestId` 必须**原样带回**
 * （主进程的桥按它兑现 pending），散在入口处很容易写成"生成新号"导致每条请求都超时。
 *
 * @param bridge preload 暴露的两个方法（`onCodeExecute` / `sendCodeResult`）。
 *   传 `undefined`（或在没有该能力的环境）时静默跳过 —— 卡片自己的「运行」按钮
 *   不依赖这条通道，所以缺它只是少一种驱动方式，不是故障。
 */
export function installCodeExecutionBridge(bridge?: {
  onCodeExecute?: (
    listener: (request: { requestId: string; code: string; timeoutMs?: number; toolCallId?: string }) => void
  ) => () => void
  sendCodeResult?: (result: {
    requestId: string
    stdout: string
    stderr: string
    interrupted: boolean
    elapsedMs: number
    failure?: string
  }) => void
}): () => void {
  if (!bridge?.onCodeExecute || !bridge.sendCodeResult) return () => {}
  const sendResult = bridge.sendCodeResult
  return bridge.onCodeExecute((request) => {
    void handleDispatchedRun({
      requestId: request.requestId,
      code: request.code,
      timeoutMs: request.timeoutMs,
      toolCallId: request.toolCallId,
      log: (line) => console.info(line)
    })
      .then((result) => {
        sendResult(result)
      })
      .catch((error: unknown) => {
        // 兜底：主进程那边有超时，但主动回一条可读失败更及时
        sendResult({
          requestId: request.requestId,
          stdout: '',
          stderr: '',
          interrupted: false,
          elapsedMs: 0,
          failure: `渲染进程执行通道异常：${error instanceof Error ? error.message : String(error)}`
        })
      })
  })
}
