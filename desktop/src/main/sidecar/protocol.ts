/**
 * Sidecar 生命周期里的**纯逻辑**：不 import electron、不碰 IO，可直接被 `node --test` 单测
 * （见 `tests/sidecar-protocol.test.ts`）。
 *
 * 本模块负责四件事，全部是「可单测的纯函数/纯类」，真正的进程操作在 `manager.ts`：
 *   - **启动命令解析**：`--port 0`（由系统分配空闲端口）+ `--token <hex>`。
 *   - **行缓冲**：Node 的 `data` 事件会把握手 JSON 切成半行，必须缓冲到 `\n` 再 parse；
 *     非 JSON 行只记日志、绝不当错误；超过 1 MiB 直接丢弃并上报，避免失控进程撑爆内存。
 *   - **握手解析**：Python 绑 `127.0.0.1:0`，把
 *     `{"event":"ready","port":N,"pid":P,"version":"0.1.0","frozen":false}` 以**单行 JSON**
 *     打到 stdout（stdout 只允许这一行，uvicorn 日志全走 stderr）。
 *     **畸形 ready 行绝不当作 ready** —— 返回 `ignore`，让调用方继续等/超时。
 *   - **重启决策 / 日志脱敏 / 启动失败文案**：崩溃只自愈一次；日志里 token 与 API Key 必须消失。
 */

import { join } from 'node:path'

/**
 * 开发态常用端口（执行文档 §7.5：手工 `uv run uvicorn app.main:app --port 8756`）。
 * ★ 它**不再用于握手**：Electron 拉起的 sidecar 一律 `--port 0`（系统分配），
 *   端口真实值从 stdout 握手取。这个常量只留给「手工起后端」的命令与文档引用。
 */
export const DEV_PORT = 8756

/**
 * `--port` 的取值：0 = 让操作系统分配一个空闲端口。
 * 自己找空闲端口会有竞态（探测到占用与真正 bind 之间被别人抢走），所以一律交给系统分配。
 */
export const EPHEMERAL_PORT = 0

/** 打包态 sidecar 在 `process.resourcesPath` 下的目录名（见 electron-builder.yml 的 extraResources）。 */
export const PACKAGED_SERVER_DIR = 'server'

/** 打包态 sidecar 可执行文件名（PyInstaller `--onedir` 产物）。 */
export const PACKAGED_SERVER_EXE = 'k12-agent-server.exe'

/** 行缓冲上限 1 MiB：超过即丢弃并上报（stdout 是保留通道，正常永远用不到这么多）。 */
export const LINE_BUFFER_MAX_BYTES = 1024 * 1024

/** 崩溃自愈的重启上限（§7.4：非正常退出重启**一次**，再失败则提示用户）。 */
export const MAX_RESTARTS = 1

export type SidecarMode = 'dev' | 'packaged'

/** sidecar 生命周期阶段。`starting` 期间 UI 显示启动动画，不允许白屏。 */
export type SidecarPhase = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'

/**
 * 主进程与渲染进程共享的 sidecar 状态。
 * ★ 结构里**没有 token**，也不许加回来：token 只存在于主进程内存中（票 02），
 *   渲染进程只需要知道「几阶段 / 哪个端口 / 什么错」。
 */
export interface SidecarState {
  phase: SidecarPhase
  /** sidecar 监听端口；未启动时为 null。该值来自 stdout 握手（`--port 0` 之后系统分配）。 */
  port: number | null
  /**
   * **后端自己的 pid**（握手里报的 Python 进程），不是 `child.pid`。
   * dev 态 `child.pid` 是 `uv.exe` 包装进程，真正的端口持有者是它的 Python 孙进程；
   * 展示与销毁都以这个值为准（销毁时两者都杀，见 manager.ts）。
   */
  pid: number | null
  mode: SidecarMode
  /** 崩溃重启次数（票 02 使用）。 */
  restarts: number
  /** 最近一次可读错误（直接展示给学生/开发者，不要塞堆栈）。 */
  lastError: string | null
  /**
   * 被忽略的 stdout 行数（诊断字段）：stdout 是**保留通道**，正常只该有一行握手 JSON，
   * 所以这个值**应当恒为 0**；非 0 说明有东西往保留通道里打印（uvicorn 日志没走 stderr 等）。
   * 空行/纯空白行不计入（握手行后面多一个换行是正常现象）。
   */
  ignoredStdoutLines: number
}

/** 解析启动命令所需的路径。 */
export interface SidecarPaths {
  /** 开发态：仓库内的 `server/` 目录（dev 在该目录下用 `uv run` 启动）。 */
  serverDir: string
  /** 打包态：`process.resourcesPath`。 */
  resourcesPath: string
  /** `--data-dir`：Electron 的 `userData`，`config.json` 与 SQLite 都落这里。 */
  dataDir: string
}

export interface SidecarCommand {
  command: string
  args: string[]
  cwd: string
}

/**
 * 解析 sidecar 的启动命令。
 *
 * - `dev`：`uv run python -m app.main ...`，cwd 指向仓库的 `server/`（本机裸 `python` 不可用，
 *   **一律用 uv**；见 AGENTS.md 第 5.10 条）。
 * - `packaged`：直接跑冻结产物 `<resourcesPath>/server/k12-agent-server.exe`——
 *   终端用户不需要 Python 环境。
 *
 * 两种模式都传 `--host 127.0.0.1 --port 0 --token <token> --data-dir <userData>`；
 * 端口真实值由 stdout 握手给出。
 */
export function resolveSidecarCommand(
  mode: SidecarMode,
  paths: SidecarPaths,
  token: string
): SidecarCommand {
  const commonArgs = [
    '--host',
    '127.0.0.1',
    '--port',
    String(EPHEMERAL_PORT),
    '--token',
    token,
    '--data-dir',
    paths.dataDir
  ]

  if (mode === 'packaged') {
    const serverDir = join(paths.resourcesPath, PACKAGED_SERVER_DIR)
    return {
      command: join(serverDir, PACKAGED_SERVER_EXE),
      args: [...commonArgs],
      cwd: serverDir
    }
  }

  return {
    command: 'uv',
    args: ['run', 'python', '-m', 'app.main', ...commonArgs],
    cwd: paths.serverDir
  }
}

/**
 * `/health` 探活地址。只绑定 `127.0.0.1`（绝不监听外部网卡）。
 * `/health` 允许匿名访问（不带 `X-Auth-Token`），是探活的唯一入口。
 */
export function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`
}

// ── 行缓冲 ────────────────────────────────────────────────────────────────

/** 丢弃上报（stdout 超过上限时触发）。 */
export interface LineBufferOverflow {
  /** 本次丢弃的字节数（按 UTF-8 计）。 */
  droppedBytes: number
  /** 累计丢弃字节数。 */
  totalDroppedBytes: number
  /** 累计触发次数。 */
  occurrences: number
}

export interface LineBufferOptions {
  /** 缓冲上限（字节），默认 {@link LINE_BUFFER_MAX_BYTES}。 */
  maxBytes?: number
  /** 超限时的回调：**在这里写日志/计数**，缓冲区本身只负责丢弃。 */
  onOverflow?: (info: LineBufferOverflow) => void
}

/**
 * 把 Node `data` 事件的任意分片还原成**完整行**。
 *
 * - `push(chunk)` 只返回完整行（以 `\n` 切分），尾部的半行留在缓冲里等下一片；
 * - `flush()` 返回最后一段没有换行的残行（进程已退出时用），没有则返回 null；
 * - 缓冲超过 `maxBytes` 时**丢弃并上报**，绝不无上限增长（失控进程不能把主进程内存吃光）。
 *
 * ★ 不要用 `readline` 之类的按 Unicode 分隔符切分的工具处理 JSONL——
 *   它们会在 JSON 载荷内部的 `\u2028` 之类字符上切错（AGENTS.md §8.2 有记录）。
 */
export class LineBuffer {
  private remainder = ''
  private readonly maxBytes: number
  private readonly onOverflow: ((info: LineBufferOverflow) => void) | undefined
  private droppedBytesTotal = 0
  private overflowCount = 0

  constructor(options: LineBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? LINE_BUFFER_MAX_BYTES
    this.onOverflow = options.onOverflow
  }

  /** 至今被丢弃的字节总数（诊断用）。 */
  get droppedBytes(): number {
    return this.droppedBytesTotal
  }

  /** 至今触发上限的次数（诊断用）。 */
  get overflows(): number {
    return this.overflowCount
  }

  /** 当前缓冲里尚未成行的字节数（诊断/测试用）。 */
  get pendingBytes(): number {
    return byteLength(this.remainder)
  }

  /** 喂一片数据，返回其中所有完整行（不含结尾的 `\n`）。 */
  push(chunk: string): string[] {
    if (chunk.length === 0) return []

    const lines: string[] = []
    const text = this.remainder + chunk
    this.remainder = ''

    let start = 0
    let index = text.indexOf('\n', start)
    while (index !== -1) {
      const line = text.slice(start, index)
      if (byteLength(line) > this.maxBytes) {
        // 单行就超限：丢弃该行（stdout 是保留通道，正常不存在这么大的行）
        this.reportOverflow(byteLength(line))
      } else {
        lines.push(line)
      }
      start = index + 1
      index = text.indexOf('\n', start)
    }

    const tail = text.slice(start)
    if (tail.length > 0) {
      if (byteLength(tail) > this.maxBytes) {
        this.reportOverflow(byteLength(tail))
      } else {
        this.remainder = tail
      }
    }

    return lines
  }

  /** 进程退出时取走最后一段**没有换行**的残行；没有残行则返回 null。 */
  flush(): string | null {
    if (this.remainder.length === 0) return null
    const tail = this.remainder
    this.remainder = ''
    return tail
  }

  /** 回到刚构造的状态（缓冲与诊断计数一起清空）。 */
  reset(): void {
    this.remainder = ''
    this.droppedBytesTotal = 0
    this.overflowCount = 0
  }

  private reportOverflow(droppedBytes: number): void {
    this.droppedBytesTotal += droppedBytes
    this.overflowCount += 1
    this.onOverflow?.({
      droppedBytes,
      totalDroppedBytes: this.droppedBytesTotal,
      occurrences: this.overflowCount
    })
  }
}

/** UTF-8 字节长度（用于上限判断）。 */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

// ── 握手解析 ──────────────────────────────────────────────────────────────

/** 握手成功：端口、后端 pid、版本、是否打包态。 */
export interface HandshakeReady {
  kind: 'ready'
  port: number
  pid: number
  version: string
  frozen: boolean
}

/** 后端自报启动失败（`{"event":"error","message":"…"}`）。 */
export interface HandshakeError {
  kind: 'error'
  message: string
}

/** 既不是 ready 也不是 error：空行、日志行、非 JSON、**畸形的 ready 行**。 */
export interface HandshakeIgnore {
  kind: 'ignore'
  line: string
}

export type HandshakeResult = HandshakeReady | HandshakeError | HandshakeIgnore

/** `event === 'error'` 但没给出可读原因时的兜底文案（UI 不能白屏）。 */
export const HANDSHAKE_ERROR_FALLBACK = '本地数据服务报告启动失败，但未给出原因。'

/** 握手未报版本号时的占位值。 */
const UNKNOWN_VERSION = 'unknown'

/**
 * 解析**一行** stdout。
 *
 * ★ 调用方必须只用 {@link LineBuffer} 切出来的完整行调用本函数：
 *   半行 JSON 在这里只会得到 `ignore`（拼接是行缓冲的职责，不是解析器的）。
 * ★ **畸形的 ready 行绝不当作 ready**（缺 port / port 0 / port 越界 / pid 非正）——
 *   返回 `ignore`，让调用方继续等或超时，而不是拿着垃圾端口去探活。
 */
export function parseHandshakeLine(line: string): HandshakeResult {
  // CRLF 兼容：先去掉结尾的 \r 与两端空白
  const trimmed = line.replace(/\r+$/, '').trim()
  if (trimmed.length === 0) return { kind: 'ignore', line: trimmed }

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return { kind: 'ignore', line: trimmed }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'ignore', line: trimmed }
  }

  const record = raw as Record<string, unknown>
  const event = record.event

  if (event === 'error') {
    const message = record.message
    return {
      kind: 'error',
      message:
        typeof message === 'string' && message.trim().length > 0
          ? message.trim()
          : HANDSHAKE_ERROR_FALLBACK
    }
  }

  if (event !== 'ready') return { kind: 'ignore', line: trimmed }

  const { port, pid } = record
  if (!isValidPort(port) || !isPositiveInteger(pid)) {
    // 畸形 ready：当没看见，绝不当作 ready
    return { kind: 'ignore', line: trimmed }
  }

  return {
    kind: 'ready',
    port,
    pid,
    version: typeof record.version === 'string' && record.version.length > 0
      ? record.version
      : UNKNOWN_VERSION,
    frozen: record.frozen === true
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isValidPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65535
}

// ── 崩溃重启决策 ──────────────────────────────────────────────────────────

export interface RestartInput {
  /** 进程退出码；被信号杀死时为 null。 */
  exitCode: number | null
  /** 终止信号；正常退出时为 null。 */
  signal: string | null
  /** 应用正在退出（`stop()` 已置位）。 */
  shuttingDown: boolean
  /** 这次退出是我们主动 kill 的（重启/退出流程），不是崩溃。 */
  intentionalKill: boolean
  /** 这个进程**曾经**就绪过（`/health` 通透过）。 */
  wasUsable: boolean
  /** 已经重启过几次。 */
  restarts: number
  /** 重启上限，默认 {@link MAX_RESTARTS}。 */
  maxRestarts?: number
}

export interface RestartDecision {
  restart: boolean
  /** 可读原因，直接写日志（不展示给学生）。 */
  reason: string
}

/**
 * 决定「这次退出要不要自动重启」。
 *
 * 顺序即优先级：
 *   1. 应用正在退出 → 不重启（否则退出流程会被拖住）；
 *   2. 主动 kill → 不重启（那是重启/退出流程自己干的）；
 *   3. **从未就绪过** → 不重启：那是配置/环境错误（uv 缺失、data-dir 不可写、依赖缺件），
 *      重启只会原样再失败一次，应该直接把可读错误报给用户；
 *   4. 还有重启额度 → 重启一次（上限 {@link MAX_RESTARTS}）；
 *   5. 额度用尽 → 不重启，提示用户并留日志。
 */
export function decideRestart(input: RestartInput): RestartDecision {
  const maxRestarts = input.maxRestarts ?? MAX_RESTARTS

  if (input.shuttingDown) {
    return { restart: false, reason: '应用正在退出，不重启 sidecar。' }
  }
  if (input.intentionalKill) {
    return { restart: false, reason: '本次退出是主动终止（重启/退出流程），不触发自动重启。' }
  }
  if (!input.wasUsable) {
    return {
      restart: false,
      reason: 'sidecar 在就绪前就退出了（配置/环境问题），重启不会自愈，改为提示用户。'
    }
  }
  if (input.restarts < maxRestarts) {
    return {
      restart: true,
      reason: `sidecar 就绪后意外退出，进行第 ${input.restarts + 1} 次自动重启（上限 ${maxRestarts} 次）。`
    }
  }
  return {
    restart: false,
    reason: `sidecar 已自动重启 ${input.restarts} 次仍未稳定，停止自愈并提示用户。`
  }
}

// ── 日志脱敏 ──────────────────────────────────────────────────────────────

const REDACTED = '[REDACTED]'
/** 短于这个长度的「秘密」不当秘密处理，否则会把日志里的普通词全替掉。 */
const MIN_SECRET_LENGTH = 4
/** 裸 hex 串（≥32 位）：随机 token / 密钥的典型形态。 */
const BARE_HEX_PATTERN = /\b[0-9a-fA-F]{32,}\b/g
/** `sk-…` 形态的 API Key。 */
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}/gi

/**
 * 日志脱敏：日志会落到 `userData/logs/`，**可能被用户整段贴进缺陷报告**，
 * 所以 token 与 API Key 绝不能活着写进去。
 *
 * 规则（按顺序生效）：
 *   1. 给定的秘密（token 等）整串替换——**大小写敏感**，避免误伤；
 *   2. 裸 hex 串（≥32 位）替换——覆盖 token 的各种变体；
 *   3. `sk-…` 形态替换——覆盖云厂商 API Key。
 *
 * 短词（`uv`、`python`、`8756`）一律不动。
 */
export function redactLogLine(line: string, secrets: string[]): string {
  let result = line

  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue
    result = result.split(secret).join(REDACTED)
  }

  result = result.replace(BARE_HEX_PATTERN, REDACTED)
  result = result.replace(API_KEY_PATTERN, REDACTED)

  return result
}

// ── 启动失败文案 ──────────────────────────────────────────────────────────

/** 启动失败的形态（供 {@link describeStartupFailure} 生成可读中文）。 */
export type StartupFailure =
  | { kind: 'timeout'; timeoutMs: number; port: number | null }
  | { kind: 'handshake'; message: string }
  | { kind: 'spawn'; message: string }
  /** 就绪前退出：环境/配置问题，重启不会自愈。 */
  | { kind: 'unusable'; exitCode: number | null; signal: string | null }
  /** 就绪后反复退出、重启额度用尽。 */
  | { kind: 'restart-exhausted'; restarts: number; exitCode: number | null; signal: string | null }

export interface StartupFailureContext {
  /** 日志绝对路径，写进文案里让用户知道去哪找线索。 */
  logPath?: string
}

/** 兜底文案：任何分支都必须返回非空可读句子（UI 不允许白屏）。 */
const GENERIC_FAILURE = '本地数据服务启动失败，请查看日志后重试。'

/**
 * 生成**给学生/开发者看的**失败句子：一句话说清「怎么了 + 去哪看日志」。
 * ★ 不塞堆栈、不返回空串（UI 不允许白屏）。
 */
export function describeStartupFailure(
  failure: StartupFailure,
  context: StartupFailureContext = {}
): string {
  const hint = context.logPath ? `请查看日志：${context.logPath}。` : '请查看应用日志后重试。'
  let message: string

  switch (failure.kind) {
    case 'timeout':
      message =
        `本地数据服务启动超时：${Math.round(failure.timeoutMs / 1000)} 秒内 /health 未就绪` +
        `${failure.port === null ? '' : `（端口 ${failure.port}）`}。`
      break
    case 'handshake':
      message = `本地数据服务启动失败：${failure.message}`
      break
    case 'spawn':
      message =
        `本地数据服务进程无法启动：${failure.message}` +
        '（开发态请确认已安装 uv 且 server/ 目录完整；打包态请确认安装包完整或重新安装）。'
      break
    case 'unusable':
      message =
        `本地数据服务进程在就绪前就退出了（${describeExit(failure.exitCode, failure.signal)}），` +
        '这通常是环境或配置问题（缺少 uv、数据目录不可写、依赖缺件），重复启动不会自愈。'
      break
    case 'restart-exhausted':
      message =
        `本地数据服务启动后多次退出，已自动重启 ${failure.restarts} 次仍未就绪` +
        `（${describeExit(failure.exitCode, failure.signal)}）。`
      break
    default:
      message = '本地数据服务启动失败。'
  }

  const text = `${message}${hint}`
  return text.trim().length > 0 ? text : GENERIC_FAILURE
}

/** 把退出码/信号翻译成可读片段（不泄露堆栈，只说发生了什么）。 */
function describeExit(exitCode: number | null, signal: string | null): string {
  if (exitCode !== null && signal) return `退出码 ${exitCode}，信号 ${signal}`
  if (exitCode !== null) return `退出码 ${exitCode}`
  if (signal) return `被信号 ${signal} 终止`
  return '原因未知'
}
