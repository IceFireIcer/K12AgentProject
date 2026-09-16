/**
 * Python sidecar 的进程管家：spawn → 探活 → 状态推送 → 退出时杀进程树。
 *
 * 票 01 的范围：把空 sidecar 拉起来、把状态推给 UI、退出时不留孤儿进程。
 * **票 02 负责**：stdout 单行 JSON 握手（端口从固定值改为系统分配）、token 注入、崩溃重启一次。
 *
 * 纪律（别在票 02 里丢）：
 *   - `stop()` 在 Windows 上必须用 `taskkill /PID <pid> /T /F` 杀**整棵进程树**，
 *     否则 `uv → python` 的子进程会变成孤儿、占着端口。
 *   - `exit` 回调里必须**先把 pid 取出来再把 `this.child` 置空**，否则拿不到要杀的 pid。
 *   - 状态对象里**永远不带 token**。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { probeHealth } from '../bridge/client'
import {
  DEV_PORT,
  resolveSidecarCommand,
  type SidecarMode,
  type SidecarPaths,
  type SidecarState
} from './protocol'

/** 探活间隔与总超时（§7.4：超时 30s 时给可读错误，不是白屏）。 */
const HEALTH_POLL_INTERVAL_MS = 300
const HEALTH_POLL_TIMEOUT_MS = 30_000
/** 单次探活请求超时，必须小于轮询间隔的量级，避免探活把轮询堵死。 */
const HEALTH_REQUEST_TIMEOUT_MS = 1500
/** `taskkill` 兜底超时，避免退出流程被卡住。 */
const TASKKILL_TIMEOUT_MS = 5000

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

export class SidecarManager {
  private readonly userDataDir: string
  private readonly onStateChanged: ((state: SidecarState) => void) | undefined
  private child: ChildProcess | null = null
  private logStream: WriteStream | null = null
  private shuttingDown = false
  private polling = false
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
      lastError: null
    }
  }

  /** 当前状态（**副本**，调用方改不到内部状态；且不含 token）。 */
  getState(): SidecarState {
    return { ...this.state }
  }

  /** 启动 sidecar：拉起进程 + 轮询 `/health` 直到就绪/超时。可重复调用（已在跑则直接返回）。 */
  async start(): Promise<void> {
    if (this.child) return

    this.shuttingDown = false
    const paths = this.resolvePaths()
    const command = resolveSidecarCommand(this.state.mode, paths)

    this.setState({ phase: 'starting', port: null, pid: null, lastError: null })
    this.openLog()
    this.writeLog(`[manager] spawn: ${command.command} ${command.args.join(' ')} (cwd=${command.cwd})`)

    try {
      this.child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: {
          ...process.env,
          // 源码运行态的编码保障；**打包态这些 env 无效**（PyInstaller 会忽略），
          // 那边靠 server/app/console.py 的 install_utf8_stdio() 兜底。
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1'
        },
        windowsHide: true,
        // stdout 留给票 02 的握手 JSON（届时每一行都要喂给行缓冲解析）；现在一律当日志。
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      this.fail(`sidecar 进程无法启动：${errorMessage(error)}`)
      return
    }

    const child = this.child
    // 票 02：端口改由 stdout 握手提供，这里不再写死
    this.setState({ pid: child.pid ?? null, port: DEV_PORT })

    child.stdout?.on('data', (chunk: Buffer) => {
      this.writeLog(`[stdout] ${chunk.toString('utf8')}`)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.writeLog(`[stderr] ${chunk.toString('utf8')}`)
    })
    child.on('error', (error) => {
      // spawn 直接失败（例如 uv 不在 PATH / cwd 不存在）时不会有 exit 事件，这里要自己清掉引用，
      // 否则 this.child 永远非空，后续 start() 会被当成「已在运行」而直接返回。
      if (child.pid === undefined) this.child = null
      this.fail(`sidecar 进程错误：${errorMessage(error)}`)
    })
    // 监听 close 而不是 exit：spawn 失败的场景只有 close（没有 exit），监听 close 能一次覆盖两种情况
    child.on('close', (code, signal) => {
      this.handleExit(code, signal)
    })

    await this.waitForHealthy()
  }

  /** 停止 sidecar：Windows 上杀整棵进程树，避免孤儿进程占端口。 */
  async stop(): Promise<void> {
    this.shuttingDown = true

    const child = this.child
    if (!child || child.pid === undefined) {
      this.child = null
      this.setState({ phase: 'stopped', pid: null, port: null })
      this.closeLog()
      return
    }

    const pid = child.pid
    this.writeLog(`[manager] stop: pid=${pid}`)

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: TASKKILL_TIMEOUT_MS }, (error) => {
          if (error) this.writeLog(`[manager] taskkill 未成功（进程可能已退出）：${error.message}`)
          resolve()
        })
      })
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
    }

    this.child = null
    this.setState({ phase: 'stopped', pid: null, port: null })
    this.closeLog()
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

  private async waitForHealthy(): Promise<void> {
    const port = this.state.port
    if (port === null || this.polling) return

    this.polling = true
    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS
    try {
      while (Date.now() < deadline) {
        // 进程已退出 / 正在关闭：由 exit 或 stop 收尾，这里不再改状态
        if (this.shuttingDown || this.child === null || this.state.phase === 'failed') return

        const health = await probeHealth(port, HEALTH_REQUEST_TIMEOUT_MS)
        if (health) {
          this.writeLog(`[manager] /health 就绪：${JSON.stringify(health)}`)
          this.setState({ phase: 'ready' })
          return
        }
        await delay(HEALTH_POLL_INTERVAL_MS)
      }
      this.fail(`sidecar 启动超时（${HEALTH_POLL_TIMEOUT_MS / 1000}s 内 /health 未就绪，端口 ${port}）`)
    } finally {
      this.polling = false
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    // ★ 先取 pid 再置空（置空后就拿不到了）
    const pid = this.child?.pid ?? null
    this.child = null

    if (this.shuttingDown) {
      this.setState({ phase: 'stopped', pid: null, port: null })
      return
    }

    this.writeLog(`[manager] sidecar 退出：pid=${pid} code=${String(code)} signal=${String(signal)}`)
    // 票 02：此处改为「非正常退出重启一次，再失败才进 failed」
    this.fail(`sidecar 进程意外退出（code=${String(code)}, signal=${String(signal)}）`)
  }

  private fail(message: string): void {
    this.writeLog(`[manager] ${message}`)
    this.setState({ phase: 'failed', lastError: message, pid: null, port: null })
  }

  private setState(patch: Partial<SidecarState>): void {
    this.state = { ...this.state, ...patch }
    this.onStateChanged?.(this.getState())
  }

  private openLog(): void {
    if (this.logStream) return
    try {
      const logDir = join(this.userDataDir, 'logs')
      mkdirSync(logDir, { recursive: true })
      this.logStream = createWriteStream(join(logDir, 'sidecar.log'), { flags: 'a' })
    } catch (error) {
      // 日志开不起来不能阻断启动，只在控制台提示
      console.warn(`[sidecar] 日志文件不可用：${errorMessage(error)}`)
    }
  }

  private writeLog(line: string): void {
    this.logStream?.write(`[${new Date().toISOString()}] ${line}\n`)
  }

  private closeLog(): void {
    this.logStream?.end()
    this.logStream = null
  }
}
