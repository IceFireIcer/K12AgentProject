/**
 * SSE 解析器（**纯逻辑，可单测**）。
 *
 * 与 `server/app/sse.py` 是一对：那边 `format_sse` 负责编码，这边负责解码。
 * 任何一侧改了分帧规则，`tests/sse.test.ts` 里那份"手写协议样本"都会提醒你。
 *
 * ⚠️ **绝对不要用 `EventSource`**（S02 DoD 硬性要求）：
 * `EventSource` 只支持 GET、且无法携带自定义 header —— 我们的 `X-Auth-Token`
 * 传不过去，鉴权必然 401。所以必须 `fetch` + `ReadableStream` 手写解析。
 */

import type { components, SseEvent, SseEventName, SseEventPayloadMap } from '../../../shared/api-types'

/** 契约里的事件名（与后端 models.SSE_EVENT_NAMES 一一对应）。 */
export const SSE_EVENT_NAMES: readonly SseEventName[] = [
  'delta',
  'citation',
  'payload',
  'blocked',
  'done',
  'error'
] as const

const KNOWN_EVENTS = new Set<string>(SSE_EVENT_NAMES)

export interface SseParseError {
  /** 原始事件块文本（已截断，避免把整段 HTML 塞进日志）。 */
  raw: string
  reason: string
}

/**
 * 增量式 SSE 解析器。
 *
 * 关键点：
 * 1. **按 `\n\n` 切事件块**：网络分片可能把任意位置切开，必须跨 chunk 缓存。
 * 2. **`TextDecoder({ stream: true })` 由调用方保证**：多字节汉字可能跨 chunk
 *    被切断，不带 `stream: true` 会解出 `�`。
 * 3. **未知事件名不抛异常**：后端将来新增事件（如 `event: progress`）不应该让
 *    旧前端整条流崩掉，只记一条诊断。
 * 4. JSON 解析失败同样只记录、不中断——丢一个事件好过白屏。
 */
export class SseParser {
  private buffer = ''
  private readonly errors: SseParseError[] = []
  /**
   * 单个事件的回调；抛出异常不会中断后续解析。
   *
   * ⚠️ 写成普通字段而不是构造器参数属性（`constructor(private readonly onEvent: ...)`）：
   * 本仓库的测试用 `node --test` **直接跑 .ts**（Node 的类型擦除模式），
   * 该模式不支持 TS 的 parameter property 语法，会直接 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
   */
  private readonly onEvent: (event: SseEvent) => void

  constructor(onEvent: (event: SseEvent) => void) {
    this.onEvent = onEvent
  }

  /** 喂入一段已解码的文本；返回本次解析出的事件（便于测试与计数）。 */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const parsed: SseEvent[] = []

    // 事件块分隔符：兼容 \r\n\r\n（代理/中间件可能改写换行）
    let index = this.findBoundary()
    while (index !== -1) {
      const block = this.buffer.slice(0, index.start)
      this.buffer = this.buffer.slice(index.end)
      const event = this.parseBlock(block)
      if (event) {
        parsed.push(event)
        try {
          this.onEvent(event)
        } catch {
          // 回调自身的问题不该影响解析循环
        }
      }
      index = this.findBoundary()
    }

    // 防御：后端异常时可能永远不发分隔符，避免无界增长
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.errors.push({
        raw: this.buffer.slice(0, 200),
        reason: `事件块超过 ${MAX_BUFFER_CHARS} 字符仍无分隔符，已丢弃`
      })
      this.buffer = ''
    }
    return parsed
  }

  /** 流结束时调用：处理没有以空行收尾的最后一个块。 */
  flush(): SseEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = ''
      return []
    }
    const block = this.buffer
    this.buffer = ''
    const event = this.parseBlock(block)
    if (!event) return []
    try {
      this.onEvent(event)
    } catch {
      /* 同上 */
    }
    return [event]
  }

  /** 本次会话累积的解析异常（UI 可展示，便于定位"后端发了什么怪东西"）。 */
  get diagnostics(): readonly SseParseError[] {
    return this.errors
  }

  private findBoundary(): { start: number; end: number } | -1 {
    const lf = this.buffer.indexOf('\n\n')
    const crlf = this.buffer.indexOf('\r\n\r\n')
    if (lf === -1 && crlf === -1) return -1
    if (crlf !== -1 && (lf === -1 || crlf < lf)) {
      return { start: crlf, end: crlf + 4 }
    }
    return { start: lf, end: lf + 2 }
  }

  private parseBlock(block: string): SseEvent | null {
    if (!block.trim()) return null

    let name: string | null = null
    const dataLines: string[] = []
    let sawComment = false

    for (const rawLine of block.split(/\r?\n/)) {
      // 注释行（`:` 开头）是 SSE 规范里的心跳，**合法且常见**——静默忽略，
      // 不能记成诊断，否则每次心跳都会污染"解析异常"面板。
      if (rawLine.startsWith(':')) {
        sawComment = true
        continue
      }
      if (rawLine.startsWith('event:')) {
        name = rawLine.slice('event:'.length).trim()
      } else if (rawLine.startsWith('data:')) {
        // 规范：冒号后的**一个**空格是分隔符，不属于数据
        const value = rawLine.slice('data:'.length)
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
      }
    }

    if (!name) {
      // 纯注释块 = 心跳，直接跳过
      if (sawComment) return null
      this.errors.push({ raw: truncate(block), reason: '缺少 event: 行' })
      return null
    }
    if (!KNOWN_EVENTS.has(name)) {
      this.errors.push({ raw: truncate(block), reason: `未知事件名 ${name}` })
      return null
    }
    if (dataLines.length === 0) {
      this.errors.push({ raw: truncate(block), reason: `事件 ${name} 缺少 data: 行` })
      return null
    }

    // 规范允许多行 data（用 \n 拼接）；我们的后端只发单行，这里按规范兼容
    const json = dataLines.join('\n')
    let data: unknown
    try {
      data = JSON.parse(json)
    } catch (err) {
      this.errors.push({
        raw: truncate(json),
        reason: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`
      })
      return null
    }

    return { event: name, data } as SseEvent
  }
}

/** 上限 1 MiB：正常事件远小于此，触顶说明后端行为异常。 */
const MAX_BUFFER_CHARS = 1024 * 1024

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 收窄 `payload` 事件里的 SubAgent 产物。
 *
 * 契约里 `SsePayloadData.payload` 是 `Record<string, unknown>`（「结构由 kind 决定」），
 * 所以在 TS 侧必须有一次显式收窄。**这个 cast 只允许出现在这里**——
 * 散落在各个组件里的 `as QuizPayload` 会让契约校验形同虚设。
 *
 * 注意返回的是**包装对象**而不是直接给 payload 加 `kind` 字段：三种 Payload
 * 本身都没有 `kind`，硬塞进去会污染数据结构、传到后端还会被 `extra="forbid"` 拒。
 */
export type SubagentEvent =
  | { kind: 'animation'; value: components['schemas']['AnimationPayload'] }
  | { kind: 'coding'; value: components['schemas']['CodeTemplate'] }
  | { kind: 'quiz'; value: components['schemas']['QuizPayload'] }

export function readSubagentPayload(event: SseEvent): SubagentEvent | null {
  if (event.event !== 'payload') return null
  const { kind, payload } = event.data
  switch (kind) {
    case 'animation':
      return { kind, value: payload as components['schemas']['AnimationPayload'] }
    case 'coding':
      return { kind, value: payload as components['schemas']['CodeTemplate'] }
    case 'quiz':
      return { kind, value: payload as components['schemas']['QuizPayload'] }
    default:
      return null
  }
}

/** 常用类型再导出，省得调用方到处 import 生成文件。 */
export type { SseEvent, SseEventName }
export type SseDeltaData = SseEventPayloadMap['delta']
export type SseBlockedData = SseEventPayloadMap['blocked']
export type SseErrorData = SseEventPayloadMap['error']
export type SseDoneData = SseEventPayloadMap['done']
export type SseCitationData = SseEventPayloadMap['citation']
export type SsePayloadData = SseEventPayloadMap['payload']
