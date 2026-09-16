/**
 * Pi 原生事件 → 冻结的 6 事件（票 06；执行文档 §6.4 的来源映射表、§9.3 的 Tool→kind 表）。
 *
 * ★ 本文件分两层，**不要混**：
 *   1. **纯映射**：`mapPiEvent(event, state)` —— 输入一个 Pi 事件，输出 0..n 个 `TurnEvent`。
 *      不订阅、不碰 IO、不抛异常，可直接单测（含未知事件 / 缺字段 / 乱序）。
 *   2. **订阅接线**：`bindTurnStream(session, sink, ...)` —— 把 Pi 的 `subscribe()` 接到
 *      `TurnHandle.emit()` 上，并在终态事件后 `finish()` 本轮。
 *
 * ★ 三条 Pi 事实（照做，别按直觉改）：
 *   - **`session_end` 不存在**（全包 grep 0 命中）。会话终态用 `session_shutdown`，
 *     一轮结束用 `agent_end` / `agent_settled`。写 `pi.on('session_end', ...)` 会静默不生效。
 *   - **`tool_execution_end` 是只读通知**：这里只能"看"，不能改结果。
 *     工具的重试/降级必须写在 Tool 的 `execute()` 内部（票 08）。
 *   - **`error` 对 UI 是终态**：渲染进程收到 `error` 会把本轮置为 `error` 并停止接收正文
 *     （见 `renderer/src/api/events.ts` 的 `applyChatEvent`）。所以**只有真正终止本轮**的
 *     失败才发 `error`；中途降级（如检索降级到 FTS5）随结果一起走 `payload`/`citation`，
 *     不能发 `error` —— 否则后半段正文会被 UI 丢掉。
 *
 * ★ 映射表（与 §6.4 逐条对应）：
 *   | Pi 原生事件                                   | 条件                          | 契约事件 |
 *   | ---                                           | ---                           | ---      |
 *   | `message_update` + `assistantMessageEvent.text_delta` | 增量非空              | `delta`  |
 *   | `message_update` + `assistantMessageEvent.error`      | 流中途失败且不在重试中 | `error`  |
 *   | `auto_retry_start`                            | 供应商失败、Pi 要重试         | （不发，记状态） |
 *   | `auto_retry_end` (success=false)              | 重试全部失败                  | `error`  |
 *   | `agent_end`（末条 assistant 带 `errorMessage`/`stopReason='error'`） | 以失败收尾 | `error` |
 *   | `agent_end`（正常收尾）                        | `willRetry !== true`         | `done`   |
 *   | `agent_settled`                               | 尚未发过终态                  | `done`   |
 *   | `tool_execution_end`（`rag_search`）          | 结果里有合法 citations        | `citation` |
 *   | `tool_execution_end`（Tool→kind 表内的 7 个工具） | 未失败                     | `payload` |
 *   | `tool_execution_end`                          | `isError` / 结果标记为失败    | `error`  |
 *   | `session_shutdown`                            | 会话终结（非本轮）            | （不发） |
 *   | 其它任意事件                                   | —                             | （忽略，计数） |
 *
 * ★★ **实测（0.85.1，离线探针，无 Key）**：供应商连接失败时 Pi **不发** `message_update`，
 *    而是连发 `agent_end willRetry=true` + `auto_retry_start` 重试 3 次，最后一次
 *    `agent_end`（无 willRetry）才结束，之后 `auto_retry_end(success=false)`、`agent_settled`。
 *    所以「失败」必须从 `agent_end` 的末条 assistant 消息识别（见 `readAssistantFailure`）——
 *    只盯 `message_update` 会把整轮失败当成功收尾（实测踩到：先发 done 后发 error，
 *    而 error 对 UI 是终态，结果界面显示"回答完了"却一个字的正文都没有）。
 */

import type { Citation, GradeLevel, PayloadKind } from '@shared/ipc-events'
import type { TurnEvent } from '../ipc/chat-stream.ts'
import { kindForTool } from '../ipc/tool-kinds.ts'

/* ------------------------------------------------------------------ *
 * 上层契约里没有、但 Pi 侧必须知道的常量
 * ------------------------------------------------------------------ */

/** 检索 Tool 名（票 10/11 实现；结果走 `citation` 事件而不是 `payload`）。 */
export const RAG_SEARCH_TOOL = 'rag_search'

/** `done.messageId` 的前缀：`messageId` 只能来自 Pi 的消息，别在别处拼。 */
export const MESSAGE_ID_PREFIX = 'pi-message:'

/** 供应商错误文案在 UI 里的统一前缀（面向学生可读，不暴露内部实现）。 */
export const PROVIDER_ERROR_PREFIX = '云端模型暂时不可用'

/** 学生侧文案：自动重试期间不打扰，只在最终失败时给一句可读提示。 */
export const RETRY_EXHAUSTED_NOTICE = '云端模型连续几次没有响应'

/** 无 Key 时的专用文案。**必须与「接线故障」区分开**（票 06 的 KEY_MISSING_MESSAGE）。 */
export const MISSING_KEY_MESSAGE =
  '云端模型暂时不可用：本机还没有配置 API Key（可在设置页填写，或设置环境变量 DEEPSEEK_API_KEY）。' +
  '这是配置缺失，不是程序故障——配置好之后就能正常对话，现在也可以先用本地知识库的问题练习。'

/* ------------------------------------------------------------------ *
 * Pi 事件的结构化类型（只声明我们用到的字段，避免把整个包静态 import 进来）
 * ------------------------------------------------------------------ */

/** `@earendil-works/pi-ai` 的 `AssistantMessageEvent`（只取用到的变体）。 */
export interface PiAssistantMessageEvent {
  type?: string
  /** `text_delta` */
  delta?: string
  /** `error` 变体的 `reason`：`aborted` | `error` */
  reason?: string
  /** `error` 变体里那份 AssistantMessage（供应商原话在 `errorMessage`）。 */
  error?: { errorMessage?: string; stopReason?: string }
  /** `done` 变体里那份 AssistantMessage（`responseId` 用作 `done.messageId`）。 */
  message?: { responseId?: string }
}

/** `@earendil-works/pi-agent-core` 的 `AgentEvent` + `AgentSessionEvent`（只取用到的字段）。 */
export interface PiNativeEvent {
  type?: string
  /** `message_update` */
  assistantMessageEvent?: PiAssistantMessageEvent
  /** `tool_execution_end` */
  toolCallId?: string
  toolName?: string
  result?: unknown
  isError?: boolean
  /** `agent_end` */
  messages?: unknown[]
  willRetry?: boolean
  /** `auto_retry_start` / `auto_retry_end` / `compaction_end` 等 */
  attempt?: number
  maxAttempts?: number
  errorMessage?: string
  finalError?: string
  success?: boolean
  /** `session_shutdown` */
  reason?: string
  /** `entry_appended` 等的事件对象其余字段（一律不读，保持宽松）。 */
  [key: string]: unknown
}

/* ------------------------------------------------------------------ *
 * 一轮的映射状态（纯数据，可由测试直接构造）
 * ------------------------------------------------------------------ */

export interface TurnMapperState {
  /** 已经发过 `done`（`agent_end` 与 `agent_settled` 只能有一个赢家）。 */
  doneEmitted: boolean
  /** 已经发过终态 `error`。 */
  errorEmitted: boolean
  /** Pi 正在自动重试（此时供应商错误**先不发** `error`，避免 UI 提前收尾丢掉重试结果）。 */
  retrying: boolean
  /** 最近一次供应商错误原文（重试也失败时用它兜底成可读文案）。 */
  lastErrorMessage?: string
  /** 忽略掉的 Pi 事件数（诊断用：证明「未知事件被忽略而不是抛异常」）。 */
  ignoredEvents: number
}

export function createTurnMapperState(): TurnMapperState {
  return { doneEmitted: false, errorEmitted: false, retrying: false, ignoredEvents: 0 }
}

export interface TurnMapContext {
  /** 本轮请求号：只用于兜底生成 `done.messageId`（Pi 没给 `responseId` 时）。 */
  requestId: string
}

/* ------------------------------------------------------------------ *
 * 纯映射
 * ------------------------------------------------------------------ */

/**
 * 把一个 Pi 事件映射成 0..n 个契约事件（纯函数：同一状态 + 同一事件 → 同一结果）。
 * 状态对象会被**原地更新**（`doneEmitted` 等去重标记），因此一轮内请复用同一个 state。
 */
export function mapPiEvent(
  event: PiNativeEvent | null | undefined,
  state: TurnMapperState,
  context: TurnMapContext
): TurnEvent[] {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    state.ignoredEvents += 1
    return []
  }

  switch (event.type) {
    case 'message_update':
      return mapMessageUpdate(event, state)

    case 'tool_execution_end':
      return mapToolExecutionEnd(event, state)

    case 'agent_end':
      return mapAgentEnd(event, state, context)

    case 'agent_settled':
      // 兜底：`agent_end` 已经发过 done 时什么都不做（幂等）
      if (state.doneEmitted || state.errorEmitted) return []
      state.doneEmitted = true
      return [{ name: 'done', data: { messageId: messageIdFrom(undefined, context.requestId) } }]

    case 'auto_retry_start':
      state.retrying = true
      if (typeof event.errorMessage === 'string') state.lastErrorMessage = event.errorMessage
      return []

    case 'auto_retry_end': {
      state.retrying = false
      if (event.success !== false) return []
      // 重试彻底失败：这才是本轮真正的终态
      const message = event.finalError ?? state.lastErrorMessage
      return terminalError(state, describeProviderError(message))
    }

    case 'session_shutdown':
      // ★ 会话终结（quit/reload/new/resume/fork）——**不是一轮结束**，不映射成任何契约事件。
      return []

    default:
      // 34 个原生事件里其余的（turn_start / message_start / thinking_delta / …）都不上 UI
      state.ignoredEvents += 1
      return []
  }
}

/** `message_update`：文本增量与供应商错误。 */
function mapMessageUpdate(event: PiNativeEvent, state: TurnMapperState): TurnEvent[] {
  const update = event.assistantMessageEvent
  if (!update || typeof update !== 'object') {
    state.ignoredEvents += 1
    return []
  }

  if (update.type === 'text_delta') {
    const delta = update.delta
    // 空增量不发（渲染进程会把空 delta 当畸形事件忽略掉，不如在这里就丢掉）
    if (typeof delta !== 'string' || delta.length === 0) {
      state.ignoredEvents += 1
      return []
    }
    return [{ name: 'delta', data: { delta } }]
  }

  if (update.type === 'error') {
    // Pi 正在自动重试：先不发（重试成功的话正文还会继续，发了会把后面的正文丢掉）
    if (state.retrying) return []
    if (state.errorEmitted) return []
    const raw = update.error?.errorMessage ?? update.reason
    return terminalError(state, describeProviderError(raw))
  }

  // text_start / text_end / thinking_* / toolcall_* / done / start：不直接上 UI
  // （`done` 只表示"这条 assistant 消息流结束"，一轮结束以 `agent_end` 为准）
  state.ignoredEvents += 1
  return []
}

/** `tool_execution_end`：检索结果 → `citation`；表内 Tool → `payload`；失败 → `error`。 */
function mapToolExecutionEnd(event: PiNativeEvent, state: TurnMapperState): TurnEvent[] {
  const toolName = typeof event.toolName === 'string' ? event.toolName : ''
  if (toolName.length === 0) {
    state.ignoredEvents += 1
    return []
  }

  const failure = readToolFailure(event)
  if (failure) {
    // 工具失败**不静默**：给学生一句可读的降级说明（能力受限，但本轮对话还能继续）
    return [
      {
        name: 'error',
        data: { message: `「${toolDescription(toolName)}」这一步没有成功：${failure}`, degraded: true }
      }
    ]
  }

  if (toolName === RAG_SEARCH_TOOL) {
    const citations = readCitations(event.result)
    // 检索无结果时**不发** citation（空来源列表对 UI 没有意义，前端也会忽略）
    return citations.length > 0 ? [{ name: 'citation', data: { citations } }] : []
  }

  // ★ 表只有一份（`ipc/tool-kinds.ts`）；不在表内的 Tool 不发 payload，绝不猜 kind
  const kind = kindForTool(toolName)
  if (kind === null) return []

  return [{ name: 'payload', data: { kind, payload: readPayload(event.result, toolName, kind) } }]
}

/** `agent_end`：一轮真正的结束（`willRetry` 时不算结束，等重试）。 */
function mapAgentEnd(
  event: PiNativeEvent,
  state: TurnMapperState,
  context: TurnMapContext
): TurnEvent[] {
  if (event.willRetry === true) return []
  if (state.doneEmitted || state.errorEmitted) return []

  // ★ 以失败收尾的一轮必须发 `error` 而不是 `done`：
  //   Pi 在供应商错误时同样会发 `agent_end`（最后一条 assistant 消息带 `errorMessage`）。
  //   若这里发 done，UI 会先进入「已完成」并**丢弃随后到达的 error**（error 对 UI 是终态）
  //   —— 实测踩到过：探针模式下事件顺序成了 done → error，界面显示"回答完了"却没有任何内容。
  const failure = readAssistantFailure(event.messages)
  if (failure !== null) return terminalError(state, describeProviderError(failure))

  state.doneEmitted = true
  return [{ name: 'done', data: { messageId: messageIdFrom(event.messages, context.requestId) } }]
}

/**
 * `agent_end.messages` 里最后一条 assistant 消息是否以失败结束。
 * 判据（宽松，宁可漏报成 done 也不要把正常结束误报成错误）：
 *   - `stopReason === 'error'`；
 *   - 或 `errorMessage` 非空。
 * `aborted`（用户主动中断）不算失败：那是一次正常收尾。
 */
export function readAssistantFailure(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    const record = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
    if (record.role !== 'assistant') continue
    const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage.trim() : ''
    if (errorMessage.length > 0) return errorMessage
    if (record.stopReason === 'error') return '供应商返回错误'
    return null
  }
  return null
}

/** 终态错误（幂等：同一轮只发一次）。 */
function terminalError(state: TurnMapperState, message: string): TurnEvent[] {
  if (state.errorEmitted) return []
  state.errorEmitted = true
  return [{ name: 'error', data: { message, degraded: true } }]
}

/* ------------------------------------------------------------------ *
 * 安全终审（票 22）的**事件发射点**
 * ------------------------------------------------------------------ */

/**
 * ★ `blocked` 事件的**唯一构造点**（票 22 在这里接内容安全终审）。
 *
 * 语义（§12）：流式输出照常发给学生，生成结束后整段终审；判定违规时发本事件，
 * 渲染进程会**撤回本轮正文**并替换成 `safeText`（见 `renderer/src/api/events.ts`）。
 *
 * 票 06 只提供发射点与构造器，**不实现判定逻辑**（审核在票 22）。
 */
export function planBlockedEvent(reason: string, safeText: string): TurnEvent {
  return { name: 'blocked', data: { reason, safeText } }
}

/** 契约里 `error` 与 `done` 都是终态：发过之后本轮不再有正文。 */
export function isTerminalTurnEvent(event: TurnEvent): boolean {
  return event.name === 'done' || event.name === 'error'
}

/* ------------------------------------------------------------------ *
 * 订阅接线（唯一碰 Pi `subscribe()` 的地方）
 * ------------------------------------------------------------------ */

/** Pi 会话里我们用到的订阅能力（结构化，便于单测注入假 session）。 */
export interface PiEventSource {
  subscribe(listener: (event: PiNativeEvent) => void): () => void
}

/** `TurnHandle` 里我们用到的那两个方法（不 import electron、不依赖 registry）。 */
export interface TurnSink {
  emit(event: TurnEvent): boolean
  finish(): void
}

export interface TurnStreamBinding {
  /** 退订（本轮结束后必须调用，避免监听器堆积）。 */
  unsubscribe(): void
  /** 本轮是否已发出终态事件。 */
  readonly closed: boolean
  /** 发过的契约事件数（诊断/断言用）。 */
  readonly emitted: number
  /**
   * 本轮没收到终态事件就结束时（`prompt()` 抛异常、Pi 会话被销毁等）**补一条可读错误**，
   * 保证 UI 不会永远停在「正在回答」。幂等：已经终结时什么都不做。
   */
  failWith(message: string): void
}

export interface TurnStreamOptions {
  /**
   * 诊断钩子：**在映射之前**对每个 Pi 原生事件调用一次（`K12_PI_TRACE=1` 时 runtime 会传一个日志器）。
   * ⚠️ 只允许记录**事件名**与结构性字段，不得记录消息正文（LLM 输出不得明文进日志，§12）。
   * 映射层把任何异常都吞掉（诊断钩子坏掉不能影响对话）。
   */
  onEvent?: (event: PiNativeEvent) => void
}

/**
 * 把 Pi 的事件流接到本轮句柄上。
 *
 * 纪律：
 *   - 映射里的任何异常都**不许**冒进 Pi 的事件循环（Pi 与 UI 同在主进程，抛出去会同时带走两者）；
 *   - 收到 `done` / `error` 立即 `sink.finish()`，之后到达的迟到事件由 registry 丢弃（已有契约）。
 */
export function bindTurnStream(
  session: PiEventSource,
  sink: TurnSink,
  context: TurnMapContext,
  options: TurnStreamOptions = {}
): TurnStreamBinding {
  const state = createTurnMapperState()
  let emitted = 0

  const unsubscribe = session.subscribe((event) => {
    let events: TurnEvent[]
    try {
      options.onEvent?.(event)
    } catch {
      // 诊断钩子坏掉不影响对话
    }
    try {
      events = mapPiEvent(event, state, context)
    } catch {
      // 映射层自己坏了也不能把主进程带下去：记一个忽略计数，本轮照常继续
      state.ignoredEvents += 1
      return
    }
    for (const turnEvent of events) {
      emitted += 1
      sink.emit(turnEvent)
      if (isTerminalTurnEvent(turnEvent)) sink.finish()
    }
  })

  return {
    unsubscribe,
    get closed() {
      return state.doneEmitted || state.errorEmitted
    },
    get emitted() {
      return emitted
    },
    failWith(message: string) {
      if (state.doneEmitted || state.errorEmitted) return
      const events = terminalError(state, message)
      for (const turnEvent of events) {
        emitted += 1
        sink.emit(turnEvent)
        sink.finish()
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 字段读取与文案（全部以「认不出就当没有」为原则）
 * ------------------------------------------------------------------ */

/** `done.messageId`：优先用 Pi 的 `responseId`，兜底用本轮请求号（保证 UI 一定拿得到）。 */
export function messageIdFrom(messages: unknown, requestId: string): string {
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (!message || typeof message !== 'object') continue
      const record = message as { role?: unknown; responseId?: unknown }
      if (record.role !== 'assistant') continue
      if (typeof record.responseId === 'string' && record.responseId.length > 0) {
        return `${MESSAGE_ID_PREFIX}${record.responseId}`
      }
    }
  }
  return `${MESSAGE_ID_PREFIX}${requestId}`
}

/**
 * 工具失败的**唯一判据**（认不出当成功，避免把正常结果误报成失败）：
 *   - Pi 侧 `isError === true`；
 *   - 或 `result.details` 里带 `error: true`（票 08 的 `safeToolExecute` 用这个标记兜异常）；
 *   - 或 `isError` 缺省但 details 里带非空 `errorMessage`。
 */
export function readToolFailure(event: PiNativeEvent): string | null {
  const details = readDetails(event.result)
  if (event.isError === true) {
    return readableError(details?.errorMessage) ?? readContentText(event.result) ?? '工具返回了错误'
  }
  if (details?.error === true) {
    return readableError(details.errorMessage) ?? '工具内部出错'
  }
  return null
}

/** `result.details`（工具的结构化产出都放这儿）。 */
export function readDetails(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null
  const details = (result as { details?: unknown }).details
  if (details && typeof details === 'object') return details as Record<string, unknown>
  return null
}

/**
 * `citation` 的来源：`result.details.citations`。
 * 逐字段校验（与 `shared/ipc-events.ts` 的冻结契约一致）：**认不准就不发**这条引用，
 * 绝不给前端一个「猜出来的学段标签」（那会让学生看到错误的检索来源）。
 */
export function readCitations(result: unknown): Citation[] {
  const details = readDetails(result)
  const raw = details?.citations
  if (!Array.isArray(raw)) return []
  const citations: Citation[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const chunkId = readNonEmptyString(record.chunkId)
    const gradeLevel = readGradeLevel(record.gradeLevel)
    if (chunkId === null || gradeLevel === null) continue
    citations.push({
      chunkId,
      chapterTitle: readNonEmptyString(record.chapterTitle) ?? '未命名章节',
      sectionTitle: readNonEmptyString(record.sectionTitle) ?? '未命名章节',
      gradeLevel,
      compat: record.compat === true
    })
  }
  return citations
}

/**
 * `payload` 事件的载荷：工具的结构化产出优先（`details`），没有就退回文本内容。
 * `kind` 已经在调用方查过表，这里只负责让 `payload` 一定是个学生可见的对象。
 */
export function readPayload(result: unknown, toolName: string, kind: PayloadKind): unknown {
  const details = readDetails(result)
  if (details) {
    // 带上 tool 名便于前端归档/轨迹（渲染进程用 payload.tool 识别产出者，见 readToolName）
    return { ...details, tool: toolName, kind }
  }
  const text = readContentText(result)
  return text === null ? { tool: toolName, kind } : { tool: toolName, kind, text }
}

/** 工具结果里的第一段文本（`AgentToolResult.content[].text`）。 */
export function readContentText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  if (typeof result === 'string') return result
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const text = (part as { text?: unknown }).text
    if (typeof text === 'string' && text.trim().length > 0) return text.trim()
  }
  return null
}

/**
 * 供应商错误 → 面向学生的一句话。
 *
 * ★ 只做「可读化」，**不吞掉关键信息**：401/额度/断网三类必须能被一眼区分，
 *   因为它们对应完全不同的处置动作（换 Key / 充值 / 检查网络）。
 *   ⚠️ 不把原始堆栈塞进去（渲染进程还会再折叠/截断一次）。
 */
export function describeProviderError(raw: string | undefined): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const lower = text.toLowerCase()

  if (text.length === 0) return `${PROVIDER_ERROR_PREFIX}：本轮没有收到任何回复。`

  if (lower.includes('api key') && (lower.includes('no ') || lower.includes('missing') || lower.includes('not found'))) {
    return MISSING_KEY_MESSAGE
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('authentication')) {
    return `${PROVIDER_ERROR_PREFIX}：API Key 被拒绝（认证失败）。请检查设置页里的 Key 是否正确、是否已过期。`
  }
  if (lower.includes('insufficient') || lower.includes('quota') || lower.includes('balance') || lower.includes('402')) {
    return `${PROVIDER_ERROR_PREFIX}：账户额度不足。请老师或家长在供应商后台充值后再试。`
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('network') ||
    lower.includes('offline')
  ) {
    return `${PROVIDER_ERROR_PREFIX}：网络连接不上（可能断网或地址不可达）。可以先检查网络，或稍后重试。`
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return `${PROVIDER_ERROR_PREFIX}：请求过于频繁，稍等几秒再试一次。`
  }
  return `${PROVIDER_ERROR_PREFIX}：${truncate(text, 120)}`
}

/** 空 Key / 无凭证时的专用文案（runtime 在调 `prompt()` 之前就用它，不必等 Pi 抛错）。 */
export function missingKeyMessage(): string {
  return MISSING_KEY_MESSAGE
}

/**
 * `session.prompt()` 抛出的异常 → 面向学生的一句话 + 本轮结论分类。
 *
 * ★ 分类的意义（票 06 的验收要求）：**「缺 Key」绝不能和「接线故障」混为一谈**。
 *   - 缺凭证 → `missing-key`：文案指向配置动作（设置页填 Key / 环境变量）；
 *   - 供应商/网络 → `provider-error`：文案指向网络与额度；
 *   - 其余（我们自己的代码问题）→ `exception`：文案明确说这是内部异常，
 *     便于排查时一眼区分「模型连不上」与「代码写错了」。
 */
export function describeTurnException(error: unknown): {
  message: string
  status: 'missing-key' | 'provider-error' | 'exception'
} {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.trim()
  const lower = text.toLowerCase()

  if (looksLikeMissingKey(lower)) return { message: MISSING_KEY_MESSAGE, status: 'missing-key' }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('timeout') ||
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('quota') ||
    lower.includes('insufficient') ||
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('provider')
  ) {
    return { message: describeProviderError(text), status: 'provider-error' }
  }
  return {
    message: `这一轮回答没有完成（内部异常）：${truncate(text, 120)}`,
    status: 'exception'
  }
}

/** 缺 Key 的多种说法（Pi 的原文是 `No API key found for <provider>.`）。 */
function looksLikeMissingKey(lower: string): boolean {
  if (lower.includes('no api key')) return true
  if (lower.includes('api key') && (lower.includes('missing') || lower.includes('not found') || lower.includes('required'))) {
    return true
  }
  return lower.includes('not authenticated') || lower.includes('no credentials')
}

/**
 * **Pi 装配失败**（`createChatRuntime` 抛错）→ 面向学生的一句话。
 *
 * ★ 这条与「缺 Key」必须一眼可分（票 06 的验收要求）：
 *   装配失败意味着**运行时本身有问题**（打包缺 esbuild、原生依赖没解包、Node 版本不符……），
 *   改配置根本没用。所以文案里明说「不是密钥或网络问题」，并保留原始原因供排查。
 */
export function describeRuntimeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const flat = raw.replace(/\s+/g, ' ').trim()
  return (
    '本轮没能开始：教学助手的对话运行时没有装配起来（' +
    (flat.length > 0 ? flat.slice(0, 120) : '未知原因') +
    '）。这不是密钥或网络问题，而是运行时故障——请把这条信息交给开发者排查。'
  )
}

/** 面向学生说「某某工具没成功」时的工具名口语化（不暴露内部 Tool 名）。 */
export function toolDescription(toolName: string): string {
  const table: Record<string, string> = {
    generate_animation: '动画演示',
    get_code_template: '代码模板',
    get_coding_hint: '提示',
    evaluate_code: '代码检查',
    generate_quiz: '随堂练习',
    submit_quiz: '练习判分',
    generate_variants: '变式练习',
    rag_search: '教材检索'
  }
  return table[toolName] ?? '这一步'
}

function readGradeLevel(value: unknown): GradeLevel | null {
  if (typeof value !== 'string') return null
  const levels: readonly GradeLevel[] = ['primary_low', 'primary_high', 'junior', 'senior']
  return (levels as readonly string[]).includes(value) ? (value as GradeLevel) : null
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readableError(value: unknown): string | null {
  const text = readNonEmptyString(value)
  if (text === null) return null
  return truncate(text, 120)
}

function truncate(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
}
