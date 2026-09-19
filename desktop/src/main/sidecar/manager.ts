/**
 * Python sidecar 的进程管家：spawn → 单行 JSON 握手 → token 鉴权 → 探活 → 崩溃重启一次 → 退出杀进程树。
 *
 * 纪律（都踩过坑，别丢）：
 *   - **stdout 是保留通道**：只允许一行握手 JSON。其余内容经 {@link LineBuffer} +
 *     {@link parseHandshakeLine} 判为 `ignore`，只记日志并计数（`ignoredStdoutLines` 应恒为 0）。
 *   - ★ **销毁用握手里的 pid，不是 `child.pid`**：dev 态 `child.pid` 是 `uv.exe` **包装进程**
 *     （实测 UI 上显示 4508），真正持有端口的是它的 **Python 孙进程**（实测 44156）。
 *     只杀 `uv.exe` 会留下占着端口的孤儿，下一次启动直接 bind 失败。**两个 pid 都杀。**
 *   - **stale-child 守卫**：每个异步回调（stdout / exit / 探活）都要确认自己捕获的 `child`
 *     仍是 `this.child`；被替换掉的进程不许改新状态。
 *   - `exit` 回调里必须**先把 pid 取出来再把 `this.child` 置空**，否则拿不到要杀的 pid。
 *   - **`restart()` 不得复用 `stop()`**：`stop()` 会置终态 `shuttingDown`，之后崩溃自愈永久失效。
 *     `start()` 必须显式清掉 `shuttingDown`。
 *   - 状态对象里**永远不带 token**：token 只在主进程内存里，只交给 `bridge/client.ts`。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
// ⚠️ 相对导入**必须带 `.ts` 后缀**：产物是 ESM（无扩展名补全），裸 Node / `node --test`
//    直接 import 本文件时同样要求写全 —— 少了后缀只有打包器能读懂。
import { clearSidecarEndpoint, configureSidecarEndpoint, probeHealth, type HealthPayload } from '../bridge/client.ts'
import {
  LINE_BUFFER_MAX_BYTES,
  MAX_RESTARTS,
  LineBuffer,
  decideRestart,
  describeStartupFailure,
  parseHandshakeLine,
  redactLogLine,
  resolveSidecarCommand,
  type HandshakeResult,
  type SidecarMode,
  type SidecarPaths,
  type SidecarState,
  type StartupFailure,
  type StartupFailureContext
} from './protocol.ts'

/** 探活轮询间隔（§7.4：就绪前给启动动画，不要白屏）。 */
const HEALTH_POLL_INTERVAL_MS = 300
/** 单次探活请求超时（必须小于启动总预算的量级，避免一次卡住的请求把轮询堵死）。 */
const HEALTH_REQUEST_TIMEOUT_MS = 2000
/** 启动总预算：**握手 + 探活合计** 30s，超时给可读错误。 */
const STARTUP_BUDGET_MS = 30_000
/** `taskkill` 超时：先给它 5s 收尾，还活着就走硬兜底。 */
const TASKKILL_TIMEOUT_MS = 5000
/** 崩溃后的重启延迟（给端口释放留点时间）。 */
const RESTART_DELAY_MS = 500
/** 判断进程是否还活着时的短暂等待（taskkill 返回≠进程已完全消失）。 */
const ALIVE_RECHECK_DELAY_MS = 200

/** 握手等待的结果：`null` = 进程先退出了/被替换（由 exit 流程负责状态）。 */
type HandshakeOutcome = HandshakeResult | { kind: 'timeout' } | null

export interface SidecarManagerOptions {
  /** Electron `userData` 目录：`--data-dir` 指这里，日志也落这里（不写工作区、不写用户主目录）。 */
  userDataDir: string
  /** 状态变化回调；主进程入口把它接到 `webContents.send(IPC.sidecarChanged, state)`。 */
  onStateChanged?: (state: SidecarState) => void
}

export function resolveSidecarMode(): SidecarMode {
  // 允许用环境变量强制覆盖，便于「开发代码 + 打包产物」的交叉验证
  const override = process.env.K12_SIDECAR_MODE
  if (override === 'dev' || override === 'packaged') return override
  return app.isPackaged ? 'packaged' : 'dev'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 进程是否还在（信号 0 = 只探测，不发信号）。 */
function isAlive(pid: number | null): boolean {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class SidecarManager {
  private readonly userDataDir: string
  private readonly onStateChanged: ((state: SidecarState) => void) | undefined
  private child: ChildProcess | null = null
  /** 握手里的**后端 pid**（真正持有端口的 Python 进程）。销毁时优先杀它，其次杀包装进程。 */
  private backendPid: number | null = null
  /**
   * 当前启动铸的随机 token。
   * ★ 只在主进程内存里：不进 state、不发 IPC；只交给 `bridge/client.ts` 注入 `X-Auth-Token`。
   *   保留到下一次 start（写日志时还要用它做脱敏）。
   */
  private token: string | null = null
  private lineBuffer: LineBuffer | null = null
  private logStream: WriteStream | null = null
  private restartTimer: NodeJS.Timeout | null = null
  /** 终态标记：置位后不再自愈。**只有 `stop()` 会置位**，`start()` 必须清掉它。 */
  private shuttingDown = false
  /** 本次退出是我们主动 kill 的（restart/stop），不是崩溃。 */
  private intentionalKill = false
  /** 当前这个进程**曾经**就绪过（决定崩溃后值不值得重启）。 */
  private wasUsable = false
  private state: SidecarState

  constructor(options: SidecarManagerOptions) {
    this.userDataDir = options.userDataDir
    this.onStateChanged = options.onStateChanged
    this.state = {
      phase: 'idle',
      port: null,
      pid: null,
      mode: resolveSidecarMode(),
      restarts: 0,
      lastError: null,
      ignoredStdoutLines: 0
    }
  }

  /** 当前状态（**副本**，调用方改不到内部状态；且不含 token）。 */
  getState(): SidecarState {
    return { ...this.state }
  }

  /** 启动 sidecar：拉起进程 → 等握手 → 轮询 `/health` 直到就绪/超时。已在跑则直接返回。 */
  async start(): Promise<void> {
    if (this.child) return

    // ★ 显式清掉终态标记：否则一次 stop() 之后崩溃自愈就永久死了
    this.shuttingDown = false
    this.intentionalKill = false
    this.wasUsable = false
    this.clearRestartTimer()

    // ★ 每次启动铸一把新 token（重启也换），经 --token 传给 Python
    const token = randomBytes(32).toString('hex')
    this.token = token
    // 端点要等握手拿到真实端口才成立；在此之前清空，避免拿旧端口发 /api 请求
    clearSidecarEndpoint()

    const paths = this.resolvePaths()
    const command = resolveSidecarCommand(this.state.mode, paths, token)

    this.setState({ phase: 'starting', port: null, pid: null, lastError: null })
    this.openLog()
    // writeLog 会把 token 脱敏后再落盘（日志可能被贴进缺陷报告）
    this.writeLog(`[manager] spawn: ${command.command} ${command.args.join(' ')} (cwd=${command.cwd})`)

    let child: ChildProcess
    try {
      child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: {
          ...process.env,
          // 源码运行态的编码保障；**打包态这些 env 无效**（PyInstaller 会忽略，
          // bootloader 设了 Py_IgnoreEnvironmentFlag），那边靠 server 侧 reconfigure(encoding="utf-8") 兜底。
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1'
        },
        windowsHide: true,
        // stdout 是**握手专用**通道（只允许一行 JSON），stderr 才是日志
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      this.fail(describeStartupFailure({ kind: 'spawn', message: errorMessage(error) }, this.failureContext()))
      return
    }

    this.child = child
    this.backendPid = null
    // setEncoding('utf8') 让 Node 用 StringDecoder 解码：多字节中文被分片也不会出现半个字符
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    // 本次启动的握手等待：exit 时也要 resolve(null)，好让下面 await 的流程立刻醒来
    let settleHandshake: (result: HandshakeResult | null) => void = () => {}
    const pendingHandshake = new Promise<HandshakeResult | null>((resolve) => {
      settleHandshake = resolve
    })

    const ignoredLines = new LineBuffer({
      onOverflow: (info) => {
        this.writeLog(
          `[stdout] 行缓冲超过 ${LINE_BUFFER_MAX_BYTES} 字节上限：丢弃 ${info.droppedBytes} 字节` +
            `（累计 ${info.totalDroppedBytes} 字节，第 ${info.occurrences} 次）`
        )
        this.countIgnoredStdoutLine()
      }
    })
    this.lineBuffer = ignoredLines

    /**
     * ★ 本次启动**是否已经拿到过结论**（`ready` / `error`）。
     *
     * stdout 是保留通道（票 02 的验收口径：只允许一行握手 JSON）。第二条能解析出结论的行
     * 以前会**静默消失**（Promise 的第二次 `resolve` 是 no-op，`start()` 也早就离开了
     * `awaitHandshake`），于是 `ignoredStdoutLines` 兑现不了它注释里的承诺
     * （「非 0 说明有东西往保留通道里打印」）。
     */
    let handshakeSettled = false

    child.stdout?.on('data', (chunk: string) => {
      // ★ stale-child 守卫：被替换掉的进程不许改新状态
      if (this.child !== child) return
      for (const line of ignoredLines.push(chunk)) {
        const result = parseHandshakeLine(line)
        if (result.kind === 'ignore') {
          this.noteIgnoredStdoutLine(child, result.line)
          continue
        }
        if (handshakeSettled) {
          // ★ 第二行「合法握手 JSON」：计数 + 记日志，**但不判失败**。
          //   取舍：已就绪的 sidecar 因为多打一行就被放弃属于**误杀**（票 02 的原意是
          //   「stdout 不得当日志通道」，不是「多一行即不可用」）；而完全不留痕又会让
          //   这条验收口径形同虚设。所以这里留痕（计数 + 日志），真出问题看这两个信号。
          this.noteSupersededHandshakeLine(child, line)
          continue
        }
        handshakeSettled = true
        settleHandshake(result)
      }
    })

    child.stderr?.on('data', (chunk: string) => {
      if (this.child !== child) return
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) this.writeLog(`[stderr] ${line}`)
      }
    })

    child.on('error', (error) => {
      this.writeLog(`[manager] 子进程错误：${errorMessage(error)}`)
      // 进程已经起来了：错误交给 close/exit 收尾（那里才有退出码）
      if (child.pid !== undefined) return
      if (this.child !== child) return
      // spawn 直接失败（uv 不在 PATH / cwd 不存在）时不会有 exit 事件，
      // 这里必须自己清引用，否则 this.child 永远非空
      this.child = null
      settleHandshake(null)
      this.fail(describeStartupFailure({ kind: 'spawn', message: errorMessage(error) }, this.failureContext()))
    })

    // 监听 close 而不是 exit：spawn 失败时只有 close，监听 close 能一次覆盖两种情况
    child.on('close', (code, signal) => {
      settleHandshake(null)
      this.handleExit(child, code, signal)
    })

    const deadline = Date.now() + STARTUP_BUDGET_MS
    const outcome = await this.awaitHandshake(pendingHandshake, deadline)

    // 已被替换 / 已停止：状态由那条路径负责，这里绝不回写
    if (this.child !== child) return
    // 进程先退出了：handleExit 已经写好可读错误
    if (outcome === null) return

    if (outcome.kind === 'timeout') {
      this.abandon(child, { kind: 'timeout', timeoutMs: STARTUP_BUDGET_MS, port: this.state.port })
      return
    }
    if (outcome.kind === 'error') {
      // 后端自报失败（{"event":"error", ...}）：直接把它给出的中文原因报给用户
      this.abandon(child, { kind: 'handshake', message: outcome.message })
      return
    }
    if (outcome.kind !== 'ready') {
      // `ignore` 行在 stdout 回调里就被过滤掉了（不会 resolve 进来）；真出现就按超时收尾，绝不猜
      this.abandon(child, { kind: 'timeout', timeoutMs: STARTUP_BUDGET_MS, port: null })
      return
    }

    // ★ 记的是**后端自己的 pid**（端口持有者），不是 uv 包装进程的 pid
    this.backendPid = outcome.pid
    this.setState({ port: outcome.port, pid: outcome.pid })
    // 端点此刻才成立：唯一的 HTTP 客户端从这里拿到「真实端口 + 本次 token」
    configureSidecarEndpoint(outcome.port, token)
    this.writeLog(
      `[manager] 握手成功：port=${outcome.port} backendPid=${outcome.pid} ` +
        `wrapperPid=${String(child.pid ?? '?')} version=${outcome.version} frozen=${outcome.frozen}`
    )

    const health = await this.pollUntilHealthy(child, outcome.port, deadline)
    if (this.child !== child) return
    if (!health) {
      this.abandon(child, { kind: 'timeout', timeoutMs: STARTUP_BUDGET_MS, port: outcome.port })
      return
    }

    this.wasUsable = true
    this.writeLog(`[manager] /health 就绪：${JSON.stringify(health)}`)
    // ★★ 重启额度在**真正就绪**时归还（G3b）。
    //   不归还的话额度是**终生一次**：`start()` 清了 `shuttingDown` / `intentionalKill` / `wasUsable`，
    //   唯独没清 `restarts`，于是「崩溃 → 自愈成功 → 又崩溃」时 `decideRestart` 直接判
    //   `restarts(1) < maxRestarts(1)` 为假，走 `restart-exhausted` —— 自愈第二次就永久失效。
    //   `restarts` 的语义明确为「**自上次成功就绪以来**重启过几次」，所以这里归零；
    //   「一个崩溃周期内最多重启 {@link MAX_RESTARTS} 次」这个上限语义**不变**。
    this.setState({ phase: 'ready', lastError: null, restarts: 0 })
  }

  /**
   * 停止 sidecar（`before-quit` 用）：Windows 上 `taskkill /PID <pid> /T /F` 杀**整棵进程树**，
   * 否则 `uv → python` 的孙进程会变成孤儿、占着端口，下次启动直接失败。
   * ★ 会置终态 `shuttingDown`：**这是 stop 的语义**，`restart()` 不允许复用它。
   */
  async stop(): Promise<void> {
    this.shuttingDown = true
    this.clearRestartTimer()

    const child = this.child
    const wrapperPid = child?.pid ?? null
    const backendPid = this.backendPid
    // ★ 先断开引用：之后所有 stale-child 守卫都会放行，退出事件不会再来改状态
    this.child = null
    this.backendPid = null
    this.wasUsable = false
    this.lineBuffer = null
    // 停止期间不该再有任何带 token 的请求
    clearSidecarEndpoint()

    if (child !== null || wrapperPid !== null || backendPid !== null) {
      this.writeLog(`[manager] stop：wrapperPid=${String(wrapperPid)} backendPid=${String(backendPid)}`)
      await this.terminate(child, wrapperPid, backendPid)
    }

    this.setState({ phase: 'stopped', pid: null, port: null })
    this.closeLog()
  }

  /**
   * 主动重启（UI 重试 / 程序化重来）。
   * ★ **绝不调用 `stop()`**：`stop()` 会把 `shuttingDown` 置成终态，之后崩溃自愈永久失效。
   *   这里走「主动 kill + 收尾 + `start()`」的等价路径，而 `start()` 会显式清掉 `shuttingDown`。
   */
  async restart(): Promise<void> {
    this.clearRestartTimer()

    const child = this.child
    const wrapperPid = child?.pid ?? null
    const backendPid = this.backendPid

    this.intentionalKill = true
    // 先断开引用，再杀：老进程的 exit 回调会因为 stale-child 守卫而失效
    this.child = null
    this.backendPid = null
    this.wasUsable = false
    this.lineBuffer = null

    try {
      await this.terminate(child, wrapperPid, backendPid)
    } finally {
      this.intentionalKill = false
    }

    await this.start()
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  /** 两种模式都提供同一份路径，由 `resolveSidecarCommand` 决定用哪一个。 */
  private resolvePaths(): SidecarPaths {
    return {
      // dev：`app.getAppPath()` 是 desktop/，仓库的 server/ 在它旁边
      serverDir: join(app.getAppPath(), '..', 'server'),
      resourcesPath: process.resourcesPath,
      dataDir: this.userDataDir
    }
  }

  /** 启动失败/放弃启动时统一收尾：先给出可读错误，再把这个进程（及其子孙）杀掉，避免孤儿占端口。 */
  private abandon(child: ChildProcess, failure: StartupFailure): void {
    this.fail(describeStartupFailure(failure, this.failureContext()))

    if (this.child !== child) return
    const wrapperPid = child.pid ?? null
    const backendPid = this.backendPid
    this.child = null
    this.backendPid = null
    this.wasUsable = false
    this.lineBuffer = null
    clearSidecarEndpoint()
    void this.terminate(child, wrapperPid, backendPid)
  }

  /** 等握手；到总预算还没到就返回 `{kind:'timeout'}`（**不会抛出**）。 */
  private async awaitHandshake(
    pending: Promise<HandshakeResult | null>,
    deadline: number
  ): Promise<HandshakeOutcome> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, deadline - Date.now()))
    })
    try {
      return await Promise.race([pending, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 轮询 `/health`（复用唯一的 HTTP 客户端）。返回 null = 超时或被中断。 */
  private async pollUntilHealthy(
    child: ChildProcess,
    port: number,
    deadline: number
  ): Promise<HealthPayload | null> {
    while (Date.now() < deadline) {
      // ★ stale-child 守卫：进程被替换/被停止后不要继续探活、更不要改状态
      if (this.child !== child || this.shuttingDown) return null

      const health = await probeHealth(port, HEALTH_REQUEST_TIMEOUT_MS)
      if (health) return health
      if (this.child !== child || this.shuttingDown) return null

      await delay(HEALTH_POLL_INTERVAL_MS)
    }
    return null
  }

  private handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    // ★ stale-child 守卫：这个回调属于一个已被替换/已停止的进程，一律不碰状态
    if (this.child !== child) {
      this.writeLog(
        `[manager] 忽略已分离进程的退出事件：pid=${String(child.pid ?? '?')} code=${String(code)} signal=${String(signal)}`
      )
      return
    }

    // ★ 先把 pid 取出来，再置空（置空之后就拿不到要杀的 pid 了）
    const wrapperPid = child.pid ?? null
    const backendPid = this.backendPid
    const wasUsable = this.wasUsable
    this.child = null
    this.backendPid = null
    this.wasUsable = false

    // 退出时把行缓冲里最后一段**没有换行**的残行冲出来（半行握手 JSON 属于典型症状，要留在日志里）
    const buffer = this.lineBuffer
    this.lineBuffer = null
    const trailing = buffer?.flush() ?? null
    if (trailing !== null) this.noteIgnoredStdoutLine(child, trailing)

    this.writeLog(
      `[manager] sidecar 退出：wrapperPid=${String(wrapperPid)} backendPid=${String(backendPid)} ` +
        `code=${String(code)} signal=${String(signal)} wasUsable=${String(wasUsable)}`
    )

    if (this.shuttingDown) {
      this.setState({ phase: 'stopped', pid: null, port: null })
      return
    }

    const decision = decideRestart({
      exitCode: code,
      signal,
      shuttingDown: this.shuttingDown,
      intentionalKill: this.intentionalKill,
      wasUsable,
      restarts: this.state.restarts,
      maxRestarts: MAX_RESTARTS
    })
    this.writeLog(`[manager] 重启决策：restart=${String(decision.restart)} —— ${decision.reason}`)

    if (!decision.restart) {
      clearSidecarEndpoint()
      this.fail(
        describeStartupFailure(
          wasUsable
            ? {
                kind: 'restart-exhausted',
                restarts: this.state.restarts,
                exitCode: code,
                signal
              }
            : { kind: 'unusable', exitCode: code, signal },
          this.failureContext()
        )
      )
      return
    }

    /**
     * ★★ 端点必须**在这里**清，不能只靠 `start()` 开头那一次（本轮修正）。
     *
     * `clearSidecarEndpoint()` 原本只在「不重启」的分支被调用；重启分支只是把
     * `state.port` 置空，而**全局端点**（`bridge/client.ts` 里那个只存在于主进程内存的
     * `{port, token}`）要等 500ms 后 `start()` 开头才被清掉。
     *
     * 这 500ms 正是最危险的一段：进程已经**死了**，但端点还指着它的旧端口与旧 token ——
     * 期间学生发消息、或右栏点开取数，`apiFetch` 会拿着旧端口发请求，
     * 换来一句 `ECONNREFUSED`，而学生会看到英文的 `fetch failed`（不经归一化的话）。
     * 端点在此刻就已经**不成立**了（持有它的进程都没了），没有任何理由多留 500ms。
     *
     * ⚠️ `start()` 开头那次**保留**：它不是冗余 —— 正常启动路径（非重启）也要清，
     *   而且它顺带覆盖「`start()` 被别处直接调用」的情形。两次调用都是 `endpoint = null`，幂等。
     */
    clearSidecarEndpoint()
    this.setState({
      restarts: this.state.restarts + 1,
      phase: 'starting',
      port: null,
      pid: null,
      lastError: null
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().catch((error: unknown) => {
        this.writeLog(`[manager] 自动重启异常：${errorMessage(error)}`)
      })
    }, RESTART_DELAY_MS)
  }

  /**
   * 杀进程树。
   * ★ dev 态有**两个**要杀的 pid：`backendPid`（Python 孙进程，真正持端口）与
   *   `wrapperPid`（`uv.exe` 包装进程）。只杀后者会留下占端口的孤儿——这是实测过的坑。
   */
  private async terminate(
    child: ChildProcess | null,
    wrapperPid: number | null,
    backendPid: number | null
  ): Promise<void> {
    const pids: number[] = []
    for (const pid of [backendPid, wrapperPid]) {
      if (pid !== null && !pids.includes(pid)) pids.push(pid)
    }
    if (pids.length === 0) return

    for (const pid of pids) {
      this.writeLog(`[manager] 终止进程 pid=${pid}`)
      await this.killTree(pid, child)
    }

    // 硬兜底：taskkill 失败/超时后仍活着，就直接 SIGKILL（Windows 上等价于 TerminateProcess）
    await delay(ALIVE_RECHECK_DELAY_MS)
    if (!pids.some((pid) => isAlive(pid))) return

    this.writeLog('[manager] 进程仍然存活，改用 SIGKILL 兜底')
    try {
      child?.kill('SIGKILL')
    } catch {
      // 已退出
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  }

  /** Windows：`taskkill /PID <pid> /T /F`（`/T` 才会连子孙一起杀）；其他平台：SIGKILL。 */
  private async killTree(pid: number, child: ChildProcess | null): Promise<void> {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        this.writeLog(`[manager] SIGKILL 未成功（进程可能已退出）：${errorMessage(error)}`)
      }
      return
    }

    await new Promise<void>((resolve) => {
      execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true },
        (error) => {
          if (error) {
            this.writeLog(`[manager] taskkill 未成功（进程可能已退出）：${errorMessage(error)}`)
            // 兜底：直接对已捕获的包装进程下手（taskkill 拿不到 pid 时至少收掉它）
            if (child?.pid === pid) {
              try {
                child.kill('SIGKILL')
              } catch {
                // 已退出
              }
            }
          }
          resolve()
        }
      )
    })
  }

  /** 统计一条被忽略的 stdout 行（空行不算：握手行后面多一个换行是正常现象）。 */
  private noteIgnoredStdoutLine(child: ChildProcess, line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    this.writeLog(
      `[stdout] 忽略非握手行（pid=${String(child.pid ?? '?')}）：${trimmed} —— stdout 是保留通道，日志请走 stderr`
    )
    this.countIgnoredStdoutLine()
  }

  /** 诊断计数：stdout 是保留通道，这个值应当恒为 0。 */
  private countIgnoredStdoutLine(): void {
    this.setState({ ignoredStdoutLines: this.state.ignoredStdoutLines + 1 })
  }

  /**
   * 第二条**能解析出结论**的 stdout 行（重复 `ready` / 后到的 `error`）。
   *
   * 与 {@link noteIgnoredStdoutLine} 一样计数与留痕，只是日志措辞点明「这是第二行握手结论」——
   * 排查时一眼能看出是「后端往保留通道多打了一行」而不是「日志跑错了通道」。
   */
  private noteSupersededHandshakeLine(child: ChildProcess, line: string): void {
    const trimmed = line.trim()
    this.writeLog(
      `[stdout] WARNING：第 2 行握手结论被忽略（pid=${String(child.pid ?? '?')}）：` +
        `${trimmed === '' ? '(空行)' : trimmed} —— stdout 只允许一行握手 JSON，` +
        '这次不计入启动结论（sidecar 继续按第一行运行）'
    )
    this.countIgnoredStdoutLine()
  }

  private fail(message: string): void {
    this.writeLog(`[manager] ${message}`)
    this.setState({ phase: 'failed', lastError: message, pid: null, port: null })
  }

  private failureContext(): StartupFailureContext {
    return { logPath: this.logPath() }
  }

  private logPath(): string {
    return join(this.userDataDir, 'logs', 'sidecar.log')
  }

  private setState(patch: Partial<SidecarState>): void {
    this.state = { ...this.state, ...patch }
    this.onStateChanged?.(this.getState())
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private openLog(): void {
    if (this.logStream) return
    try {
      const logDir = join(this.userDataDir, 'logs')
      mkdirSync(logDir, { recursive: true })
      const stream = createWriteStream(this.logPath(), { flags: 'a' })
      // ★★ 上面的 try/catch **只兜得住同步段**（`mkdirSync`）。`createWriteStream` 的 open 是
      //    **异步**的：EPIPE / EPERM / ENOSPC（只读安装介质、磁盘满、杀软或另一个实例锁住文件）
      //    会以 `'error'` 事件的形式冒出来 —— 没有监听器时 EventEmitter 直接把它抛成
      //    **主进程未捕获异常**（Electron 弹「A JavaScript error occurred in the main process」或直接崩）。
      //    那与本函数「日志开不起来不能阻断启动」的意图正好相反，所以这里必须挂监听。
      stream.on('error', (error: NodeJS.ErrnoException) => {
        console.warn(`[sidecar] 日志文件不可用（已停用文件日志，不影响运行）：${errorMessage(error)}`)
        // 只在还是当前流时断开引用：避免把后来重新打开的新流误清（进而漏掉它的错误）
        if (this.logStream === stream) this.logStream = null
      })
      this.logStream = stream
    } catch (error) {
      // 日志开不起来不能阻断启动，只在控制台提示
      console.warn(`[sidecar] 日志文件不可用：${errorMessage(error)}`)
    }
  }

  /** ★ 所有落盘日志都过一遍脱敏：日志可能被整段贴进缺陷报告，token 与 API Key 不许活着写进去。 */
  private writeLog(line: string): void {
    const stream = this.logStream
    // ★ `'error'` 监听是异步的，中间存在「流已被销毁但我们还没处理完事件」的窗口；
    //   此时再 `write` 会抛 `ERR_STREAM_DESTROYED`。另外 `closeLog()` 之后 `end()` 过的流也不能写。
    //   **日志写不进去绝不能打崩主进程**，所以两处都挡一下。
    if (!stream || stream.destroyed || stream.writableEnded) return
    const safe = redactLogLine(line, this.token === null ? [] : [this.token])
    try {
      stream.write(`[${new Date().toISOString()}] ${safe}\n`)
    } catch {
      // 同步抛出（极端情况）：丢弃这一行日志即可，不影响业务
    }
  }

  private closeLog(): void {
    const stream = this.logStream
    this.logStream = null
    if (!stream || stream.destroyed) return
    // `end()` 之后仍可能有 'error'（未 flush 完就失败）；监听器还在，且已按引用判断过，不会再动状态
    stream.end()
  }
}
