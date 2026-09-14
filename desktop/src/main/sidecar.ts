/**
 * Python sidecar 进程管理（Electron main 进程侧）。
 *
 * 生命周期（对应 `项目执行文档.md` 第 7.4 节）：
 *   spawn → stdout 握手 JSON 取端口 → 轮询 /health 探活 → ready
 *                                        ↘ 超时/异常退出 → 重启一次 → 仍失败 → failed
 *   before-quit → 杀进程树（Windows 必须 taskkill /T，否则漏掉孙子进程）
 *
 * 设计要点：
 * - **端口由 OS 分配**（`--port 0`），sidecar 握手回传；绝不自己扫端口（有竞态）。
 * - **stdout 是握手专用通道**，只认单行 JSON；其他行只记日志。
 * - 凭据（token）只经进程参数传递，**不写日志**。
 * - 纯判定逻辑抽到 `sidecar-logic.ts`，由 `npm test` 覆盖。
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { HealthPayload, SidecarInfo, SidecarPhase } from '../shared/sidecar-types'
import {
  LineBuffer,
  decideRestart,
  describeStartupFailure,
  parseHandshakeLine,
  redactLogLine
} from './sidecar-logic'

/** spawn 到 /health 通过的整段预算；超时即失败，给可读错误而非白屏干等。 */
const STARTUP_TIMEOUT_MS = 30_000
/** 探活轮询间隔。 */
const HEALTH_POLL_INTERVAL_MS = 300
/** 探活单次请求超时。 */
const HEALTH_REQUEST_TIMEOUT_MS = 2_000
/** 异常退出后的自动重启次数上限（关卡 A 要求「重启一次」）。 */
const MAX_RESTARTS = 1
/** taskkill 兜底时间：超时就放行，避免卡住应用退出。 */
const KILL_GRACE_MS = 5_000
/** 重启前的短暂延迟，给端口释放留时间。 */
const RESTART_DELAY_MS = 500

export class SidecarManager {
  private child: ChildProcess | null = null
  private phase: SidecarPhase = 'idle'
  private port: number | null = null
  private pid: number | null = null
  private version: string | null = null
  private frozen = false
  private embedderReady: boolean | null = null
  private restarts = 0
  /** 原始错误（进日志 / 详情）。 */
  private lastErrorDetail: string | null = null
  private shuttingDown = false
  private intentionalKill = false
  private startupTimer: NodeJS.Timeout | null = null
  /** stdout 行缓冲：管道分片可能把一行 JSON 切开，必须跨 chunk 拼接。 */
  private stdoutBuffer = new LineBuffer()

  /** 每次启动生成新 token（重启也换，压缩本机其他进程复用的窗口）。 */
  private token = ''
  private readonly dataDir: string
  private readonly logFile: string

  constructor() {
    this.dataDir = join(app.getPath('userData'), 'data')
    const logDir = join(app.getPath('userData'), 'logs')
    this.logFile = join(logDir, 'sidecar.log')
    mkdirSync(this.dataDir, { recursive: true })
    mkdirSync(logDir, { recursive: true })
    writeFileSync(this.logFile, '', 'utf-8') // 每次会话清空，避免无限增长
  }

  // ------------------------------------------------------------------ 对外 --

  get info(): SidecarInfo {
    return {
      phase: this.phase,
      mode: this.mode,
      port: this.port,
      pid: this.pid,
      token: this.token,
      version: this.version,
      frozen: this.frozen,
      embedderReady: this.embedderReady,
      dataDir: this.dataDir,
      restarts: this.restarts,
      lastError: this.lastErrorDetail ? describeStartupFailure(this.lastErrorDetail) : null,
      lastErrorDetail: this.lastErrorDetail,
      logFile: this.logFile,
      shuttingDown: this.shuttingDown,
      updatedAt: Date.now()
    }
  }

  /**
   * 一律以「打包模式」启动 sidecar。
   *
   * 默认跟随 `app.isPackaged`（生产 = 打包产物）。
   * 开发期可用 `K12_SIDECAR_MODE=packaged` 强制走打包产物路径——
   * 这正是关卡 A 要验证的路径（Electron 拉起 exe 而非 `uv run`），
   * 不必每次都跑完整的 electron-builder 才能验。
   */
  private get mode(): 'dev' | 'packaged' {
    const override = process.env['K12_SIDECAR_MODE']
    if (override === 'packaged') return 'packaged'
    if (override === 'dev') return 'dev'
    return app.isPackaged ? 'packaged' : 'dev'
  }

  start(): void {
    if (this.child) return
    this.intentionalKill = false
    this.lastErrorDetail = null
    this.token = randomBytes(32).toString('hex')
    this.log(`[sidecar] 启动（mode=${this.info.mode}）`)
    this.spawnProcess()
  }

  /** 应用退出时调用：杀进程树，防止孤儿进程占端口。 */
  async stop(): Promise<void> {
    this.shuttingDown = true
    this.intentionalKill = true
    this.clearStartupTimer()
    const pid = this.child?.pid
    this.child = null
    await this.killTree(pid)
    this.pid = null
    this.port = null
    this.setPhase('stopped')
  }

  // -------------------------------------------------------------- 进程启动 --

  /** 解析启动命令：开发态走 `uv run`，打包态直接跑 exe。 */
  private resolveCommand(): { command: string; args: string[]; cwd: string } {
    const commonArgs = ['--port', '0', '--token', this.token, '--data-dir', this.dataDir]

    if (this.mode === 'packaged') {
      const serverDir = this.resolvePackagedServerDir()
      const exe = join(serverDir, 'k12-agent-server.exe')
      if (!existsSync(exe)) {
        throw new Error(`未找到打包后的 sidecar 可执行文件：${exe}`)
      }
      return { command: exe, args: commonArgs, cwd: serverDir }
    }

    // 开发态：desktop/ 与 server/ 同级
    const serverDir = join(app.getAppPath(), '..', 'server')
    if (!existsSync(join(serverDir, 'app', 'main.py'))) {
      throw new Error(`未找到后端源码目录：${serverDir}`)
    }
    return {
      command: 'uv',
      args: ['run', 'python', '-m', 'app.main', ...commonArgs],
      cwd: serverDir
    }
  }

  /**
   * 打包产物的位置。
   *
   * - 正式打包：electron-builder 的 `extraResources` 把它放在 `resources/server/`。
   * - 开发期强制打包模式（`K12_SIDECAR_MODE=packaged`）：产物还在 `server/dist/`，
   *   用 `K12_SERVER_DIST` 指定，或按仓库相对路径兜底推导。
   */
  private resolvePackagedServerDir(): string {
    const fromEnv = process.env['K12_SERVER_DIST']
    if (fromEnv) return fromEnv

    // 已打包：process.resourcesPath/server
    const inBundle = join(process.resourcesPath, 'server')
    if (existsSync(join(inBundle, 'k12-agent-server.exe'))) return inBundle

    // 开发期：desktop/../server/dist/k12-agent-server
    return join(app.getAppPath(), '..', 'server', 'dist', 'k12-agent-server')
  }

  private spawnProcess(): void {
    let cmd: { command: string; args: string[]; cwd: string }
    try {
      cmd = this.resolveCommand()
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      return
    }

    this.stdoutBuffer = new LineBuffer() // 重启时重置，丢弃上一进程的残余

    this.setPhase(this.restarts > 0 ? 'restarting' : 'starting')

    const child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      // ⚠️ 打包后的子进程**不继承**全局 PYTHONUTF8，必须显式注入，否则中文按 GBK 输出乱码
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1'
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.child = child
    this.pid = child.pid ?? null

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))

    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk))

    child.on('error', (err) => this.fail(`sidecar 进程启动失败：${err.message}`))
    child.on('exit', (code, signal) => this.onExit(code, signal))

    this.armStartupTimeout()
  }

  // ------------------------------------------------------------ 握手与探活 --

  private armStartupTimeout(): void {
    this.clearStartupTimer()
    this.startupTimer = setTimeout(() => {
      if (this.phase === 'ready') return
      this.fail(`sidecar 启动超时（${STARTUP_TIMEOUT_MS / 1000}s 内未完成握手）`)
    }, STARTUP_TIMEOUT_MS)
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
  }

  private onStdout(chunk: string): void {
    for (const line of this.stdoutBuffer.push(chunk)) {
      const outcome = parseHandshakeLine(line)
      switch (outcome.kind) {
        case 'ready':
          this.onHandshakeReady(outcome.port, outcome.version, outcome.frozen)
          break
        case 'error':
          this.fail(outcome.message)
          break
        case 'ignore':
          this.log(`[stdout] ${line}`)
          break
      }
    }
  }

  private onHandshakeReady(port: number, version: string | null, frozen: boolean): void {
    if (this.phase === 'ready' || this.phase === 'handshaking') return // 幂等
    this.port = port
    this.version = version
    this.frozen = frozen
    this.log(`[sidecar] 握手成功 port=${port} pid=${this.pid ?? '?'}`)
    this.setPhase('handshaking')
    void this.waitForHealthy()
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim()) this.log(`[stderr] ${line.trimEnd()}`)
    }
  }

  /** 轮询 `/health`（免鉴权）直到就绪或超时。 */
  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.shuttingDown || !this.child || this.child.exitCode !== null) return
      const health = await this.fetchHealth()
      if (health) {
        this.embedderReady = health.embedder_ready
        this.version = health.version
        this.frozen = health.frozen
        this.clearStartupTimer()
        this.setPhase('ready')
        this.log(
          `[sidecar] /health 就绪 version=${health.version} embedder=${health.embedder_ready}`
        )
        return
      }
      await delay(HEALTH_POLL_INTERVAL_MS)
    }
    this.fail('sidecar 端口已就绪，但 /health 一直未通过（可能是模型或依赖加载失败）')
  }

  private async fetchHealth(): Promise<HealthPayload | null> {
    if (this.port === null) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
        signal: controller.signal
      })
      if (!res.ok) return null
      return (await res.json()) as HealthPayload
    } catch {
      return null // 端口尚未就绪属正常现象，继续轮询
    } finally {
      clearTimeout(timer)
    }
  }

  // ------------------------------------------------------------ 退出与重启 --

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasUsable = this.phase === 'ready' || this.phase === 'handshaking'
    this.log(`[sidecar] 进程退出 code=${code ?? '-'} signal=${signal ?? '-'}`)
    this.child = null
    this.pid = null
    this.port = null
    this.embedderReady = null

    const decision = decideRestart({
      wasUsable,
      restarts: this.restarts,
      shuttingDown: this.shuttingDown,
      intentionalKill: this.intentionalKill,
      maxRestarts: MAX_RESTARTS
    })

    if (decision.action === 'restart') {
      this.restarts += 1
      this.setPhase('restarting')
      this.log(`[sidecar] ${decision.reason}`)
      setTimeout(() => {
        if (!this.shuttingDown) this.spawnProcess()
      }, RESTART_DELAY_MS)
      return
    }

    // 关闭中/主动杀掉的退出是预期行为，不算失败
    if (this.shuttingDown) {
      this.setPhase('stopped')
      return
    }
    this.fail(decision.message)
  }

  private fail(message: string): void {
    this.clearStartupTimer()
    // 存原文（进日志、便于排查），界面展示时再经 describeStartupFailure 映射成人话
    this.lastErrorDetail = message
    this.setPhase('failed')
    this.log(`[sidecar] 失败：${message}`)
    this.intentionalKill = true // 失败收尾杀进程时不要再触发重启
    void this.killTree(this.child?.pid)
  }

  /**
   * Windows 下必须 `/T` 杀整棵进程树：`uv run` 会再派生子进程（真正的 python.exe），
   * 只杀父进程会留下孤儿占住端口。
   */
  private killTree(pid: number | undefined): Promise<void> {
    if (!pid) return Promise.resolve()

    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const killer = execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => done())
      // 兜底：taskkill 卡住也不能阻塞应用退出
      const timer = setTimeout(() => {
        killer.kill()
        done()
      }, KILL_GRACE_MS)
      timer.unref?.()
    })
  }

  // -------------------------------------------------------------- IPC 广播 --

  private setPhase(phase: SidecarPhase): void {
    this.phase = phase
    this.broadcast()
  }

  private broadcast(): void {
    const payload = this.info
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('sidecar:changed', payload)
    }
  }

  // ------------------------------------------------------------------ 日志 --

  private log(line: string): void {
    // 纵深防御：即便调用方漏了，也保证 token / API Key 不落盘
    const safe = redactLogLine(line, [this.token])
    try {
      appendFileSync(this.logFile, `${new Date().toISOString()} ${safe}\n`, 'utf-8')
    } catch {
      /* 日志失败不应影响主流程 */
    }
  }
}

/** 暴露给界面层的可读错误映射。 */
export { describeStartupFailure }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
