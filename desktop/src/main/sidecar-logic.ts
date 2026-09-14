/**
 * sidecar 的**纯逻辑**（不依赖 Electron / 子进程 / 网络）。
 *
 * 抽出来的唯一理由：这些是真正容易出错的地方——
 * ① stdout 分片导致的半行 JSON；② 重启判定；③ 日志脱敏（绝不能泄漏 token）。
 * 它们在 main 进程里跑，但可以脱离 Electron 用 `node --test` 直接验证。
 */

/** 握手消息（后端 stdout 单行 JSON）。 */
export interface HandshakeMessage {
  event: string
  port?: number
  pid?: number
  version?: string
  frozen?: boolean
  message?: string
}

export type HandshakeOutcome =
  | { kind: 'ready'; port: number; version: string | null; frozen: boolean; pid: number | null }
  | { kind: 'error'; message: string }
  | { kind: 'ignore'; reason: string }

/**
 * 把一行 stdout 解析成握手结果。
 *
 * 后端的 stdout **可能混入其他输出**（第三方库直接 print），因此非 JSON 行必须是
 * `ignore` 而不是异常——一次误判就会让启动流程整个失败。
 */
export function parseHandshakeLine(line: string): HandshakeOutcome {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'ignore', reason: '空行' }

  let msg: unknown
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return { kind: 'ignore', reason: '非 JSON 行' }
  }

  if (typeof msg !== 'object' || msg === null) {
    return { kind: 'ignore', reason: 'JSON 不是对象' }
  }

  const m = msg as Partial<HandshakeMessage>

  if (m.event === 'error') {
    return { kind: 'error', message: m.message ?? 'sidecar 启动失败（未给出原因）' }
  }

  if (m.event !== 'ready') {
    return { kind: 'ignore', reason: `未知事件 ${String(m.event)}` }
  }

  // 端口必须是 1..65535 的正整数；0 是「让系统分配」的入参，不可能是回传值
  if (typeof m.port !== 'number' || !Number.isInteger(m.port) || m.port <= 0 || m.port > 65535) {
    return { kind: 'ignore', reason: `ready 事件的 port 非法：${String(m.port)}` }
  }

  return {
    kind: 'ready',
    port: m.port,
    version: typeof m.version === 'string' ? m.version : null,
    frozen: Boolean(m.frozen),
    // ★ 后端自报的真实 PID（emit 握手的那条 python 进程）。
    //   开发态 `spawn` 的直接子进程是 `uv.exe`，真正的 python 是**孙子**进程：
    //   万一 uv 先退出而 python 被重新挂载（reparent），我们已丢失 `this.child`，
    //   此时只能靠这个 pid 兜底杀树，否则留下孤儿占端口。
    pid: typeof m.pid === 'number' && Number.isInteger(m.pid) && m.pid > 0 ? m.pid : null
  }
}

/**
 * stdout 分片缓冲：把任意切分的 chunk 还原成完整的行。
 *
 * ⚠️ 这是最容易踩的坑：管道一次 `data` 事件给到的可能是半行 JSON
 * （`{"event":"rea` + `dy","port":8756}`），直接 `JSON.parse` 必然失败。
 * 必须按 `\n` 切分并保留残余，直到下一次 chunk 到来。
 */
export class LineBuffer {
  private buffer = ''
  /** 安全上限：异常情况下防止无限增长（后端若只输出不换行）。 */
  private static readonly MAX_BUFFER = 1 << 20 // 1 MiB

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      lines.push(this.buffer.slice(0, index))
      this.buffer = this.buffer.slice(index + 1)
    }
    // 只有「不换行的超长输出」才丢；正常的半行 JSON 必须留着等续片
    if (this.buffer.length > LineBuffer.MAX_BUFFER) {
      lines.push(this.buffer)
      this.buffer = ''
    }
    return lines
  }

  /** 进程结束时取出未以换行收尾的残余（可能是最后一条握手）。 */
  flush(): string | null {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest.length > 0 ? rest : null
  }

  get pending(): string {
    return this.buffer
  }
}

export type RestartDecision =
  | { action: 'restart'; reason: string }
  | { action: 'fail'; message: string }

export interface RestartContext {
  /** 进程退出前是否已经握手/就绪。 */
  wasUsable: boolean
  /** 已发生的重启次数。 */
  restarts: number
  /** 应用是否正在关闭（关闭中的退出属预期，不该重启）。 */
  shuttingDown: boolean
  /** 是否由我们主动杀掉（超时兜底、失败清理）。 */
  intentionalKill: boolean
  /** 允许的最大重启次数。 */
  maxRestarts: number
}

/**
 * 退出后的处置决策。
 *
 * 规则：
 * - 应用关闭中 / 主动杀 → 不重启（否则退出时会复活进程，产生孤儿）
 * - 启动阶段就挂（从未就绪）→ 直接失败，重启无意义（配置错误重试还是错）
 * - 就绪后意外挂 → 重启，直到用完配额
 */
export function decideRestart(ctx: RestartContext): RestartDecision {
  if (ctx.shuttingDown) {
    return { action: 'fail', message: '正在关闭' }
  }
  if (ctx.intentionalKill) {
    return { action: 'fail', message: '进程已被主动终止' }
  }
  if (!ctx.wasUsable) {
    return {
      action: 'fail',
      message: '后端进程未能完成启动，请检查日志。'
    }
  }
  if (ctx.restarts < ctx.maxRestarts) {
    return { action: 'restart', reason: `第 ${ctx.restarts + 1} 次自动重启` }
  }
  return {
    action: 'fail',
    message: '后端进程意外退出，自动重启后仍未恢复。请查看日志或重启应用。'
  }
}

/**
 * 日志脱敏：token 与 API Key 绝不落盘。
 *
 * 后端也做了脱敏，这里是纵深防御——**日志文件是本机其他进程可读的**。
 */
export function redactLogLine(line: string, secrets: readonly string[] = []): string {
  let out = line
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join('***')
    }
  }
  // 兜底：任何 32 位以上的 hex 串都按疑似凭据处理（token 是 64 位 hex）
  out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, '***')
  // 兜底：疑似 API Key 的 sk-xxx 形态
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '***')
  return out
}

/** 面向用户的中文可读错误（用于界面提示，不是日志）。 */
export function describeStartupFailure(raw: string | null): string {
  if (!raw) return '后端服务未能启动，请重试或查看日志。'
  if (/ENOENT|not found|未找到/i.test(raw)) {
    return '找不到后端程序文件，安装包可能不完整。'
  }
  if (/超时|timeout/i.test(raw)) {
    return '后端服务启动超时，请检查是否有安全软件拦截。'
  }
  if (/EADDRINUSE|端口/.test(raw)) {
    return '端口被占用，请关闭其他实例后重试。'
  }
  return raw
}
