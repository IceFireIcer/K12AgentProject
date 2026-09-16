/**
 * 6 事件流的**订阅与分发**（执行文档 §7.3 的 `renderer/src/api/events.ts`）。
 *
 * ★ 这里**不是解析器**。传输层是 IPC（结构化克隆的对象），所以：
 *   没有 SSE、没有分帧、没有 `TextDecoder`、没有 `{stream:true}` 解码、没有半行缓冲。
 *   本模块只做两件事：
 *     1. `subscribeToChatEvents()`：接上 preload 白名单的订阅回调，返回退订函数；
 *     2. `applyChatEvent()`：**纯函数**，把事件折进对话状态（`node --test` 可直接单测）。
 *
 * ★ 容错原则：**任何脏数据都不许抛到 UI**。认不出/缺字段/顺序不对的事件一律
 *   「忽略并计数」，绝不改变其它轮次的状态（旧轮事件不得污染新轮）。
 */

import type { Citation, GradeLevel, IpcEvent, PayloadKind } from '@shared/ipc-events'

/** 内容被安全撤回时，如果主进程没给 `safeText`，用这句兜底（UI 不允许出现空白气泡）。 */
export const FALLBACK_SAFE_TEXT = '这条内容不适合直接展示，我们换个话题继续聊吧。'

/** 出错/降级时，如果主进程没给可读文案，用这句兜底。 */
export const FALLBACK_ERROR_TEXT = '刚才这一步没能完成，请稍后再试一次。'

/** 单个 `requestId` 最多缓冲多少条「超前到达」的事件。 */
export const MAX_PENDING_EVENTS_PER_TURN = 64

/** 最多为多少个「尚未建立的轮次」保留缓冲（防伪造 requestId 撑爆内存）。 */
export const MAX_PENDING_TURNS = 8

/** 展示用文案的长度上限（防止把一整段堆栈灌进气泡）。 */
const MAX_NOTICE_CHARS = 200

const UNKNOWN_CHAPTER = '未命名章节'
const GRADE_LEVELS: readonly GradeLevel[] = ['primary_low', 'primary_high', 'junior', 'senior']
const PAYLOAD_KINDS: readonly PayloadKind[] = ['animation', 'coding', 'quiz']

/** `payload` 事件渲染成的内联卡片（真实卡片组件在票 16–19）。 */
export interface InlineCard {
  /** 稳定 key：同一轮内递增（`requestId#序号`）。 */
  id: string
  kind: PayloadKind
  /** 产出这张卡片的 Tool 名（占位载荷里带的 `tool` 字段；没有则为 null）。 */
  tool: string | null
  payload: unknown
}

/** 安全撤回：原文已撤回，展示 `safeText`。 */
export interface BlockedNotice {
  reason: string
  safeText: string
  /** 被撤回的原文（仅面板/调试可见，不展示给学生）。 */
  retractedText: string
}

/** 出错 / 降级提示。`degraded === true` 表示「能力受限但仍可用」，不是崩溃。 */
export interface ErrorNotice {
  message: string
  degraded: boolean
}

export type TurnStatus = 'streaming' | 'done' | 'blocked' | 'error'

/** 一轮对话：一条学生消息 + 它对应的主进程流（同一个 `requestId`）。 */
export interface ChatTurn {
  requestId: string
  userText: string
  /**
   * 这一轮回答时**系统判定出的学段**（`null` = 当时还没判出来）。
   *
   * ★ 学段不由学生选择、也不随 `chat:send` 发送：判定在主进程做（规则 + 轻量 LLM），
   *   渲染进程只是把「当前判定结果」记在轮次上，让每条回答都能标出它是按哪个年级生成的。
   */
  gradeLevel: GradeLevel | null
  /** `delta` 累积出的正文（撤回后为 `safeText`）。 */
  text: string
  citations: Citation[]
  cards: InlineCard[]
  status: TurnStatus
  /** `done` 带来的消息 id（用于持久化/学习记录，票 09）。 */
  messageId: string | null
  blocked: BlockedNotice | null
  error: ErrorNotice | null
}

export interface ConversationState {
  turns: ChatTurn[]
  /**
   * 「事件先到、轮次后建」的缓冲：`requestId` 由主进程生成，
   * 事件首次推送**可能早于** `sendChat()` 的回执到达渲染进程。
   * 按 `requestId` 暂存，`startTurn()` 时按序回放；容量有上限，不会无限增长。
   */
  pending: Record<string, IpcEvent[]>
  /** 被忽略的畸形/未知事件数（诊断用；「忽略而不抛异常」的可观测证据）。 */
  ignoredEvents: number
}

/** 订阅侧的能力：只需一个 `onChatEvent`（便于单测注入假实现，不必碰 electron）。 */
export interface ChatStreamSource {
  onChatEvent(listener: (event: IpcEvent) => void): () => void
}

export function emptyConversation(): ConversationState {
  return { turns: [], pending: {}, ignoredEvents: 0 }
}

export function createTurn(
  requestId: string,
  userText: string,
  gradeLevel: GradeLevel | null = null
): ChatTurn {
  return {
    requestId,
    userText,
    gradeLevel,
    text: '',
    citations: [],
    cards: [],
    status: 'streaming',
    messageId: null,
    blocked: null,
    error: null
  }
}

/**
 * 接上 6 事件流（只订阅，无解析）。
 * 返回退订函数；组件卸载时必须调用，避免监听器堆积。
 */
export function subscribeToChatEvents(
  source: ChatStreamSource,
  handler: (event: IpcEvent) => void
): () => void {
  return source.onChatEvent((event) => {
    try {
      handler(event)
    } catch {
      // 一个订阅者的异常不许影响其它订阅者，也不许冒到 UI
    }
  })
}

/**
 * 建立一轮（收到 `chat:send` 回执后调用）；把超前到达的事件按序回放。
 *
 * `gradeLevel` 是**这一轮回答时系统判定出的学段**（`null` = 当时还没判出来）。
 * 它只是给轮次做展示标注，判分/检索用的学段一律由主进程决定（前端不参与、也改不了）。
 */
export function startTurn(
  state: ConversationState,
  requestId: string,
  userText: string,
  gradeLevel: GradeLevel | null = null
): ConversationState {
  if (state.turns.some((turn) => turn.requestId === requestId)) return state

  const buffered = state.pending[requestId] ?? []
  const pending = { ...state.pending }
  delete pending[requestId]

  let next: ConversationState = {
    ...state,
    turns: [...state.turns, createTurn(requestId, userText, gradeLevel)],
    pending
  }
  for (const event of buffered) {
    next = applyChatEvent(next, event)
  }
  return next
}

/**
 * 事件分发（纯函数，返回新状态）。
 *
 * 三种容错的落点：
 *   1. **缺字段 / 未知事件名 / 未知 `kind`** → 归一化失败 → 忽略并 `ignoredEvents + 1`；
 *   2. **超前到达的 `requestId`** → 先缓冲，轮次建立时回放；
 *   3. **已终结的轮次（旧轮）再来的事件** → 丢弃（只有 `done` 还允许补 `messageId`）。
 */
export function applyChatEvent(state: ConversationState, rawEvent: unknown): ConversationState {
  try {
    const event = normalizeIpcEvent(rawEvent)
    if (!event) return { ...state, ignoredEvents: state.ignoredEvents + 1 }

    const index = state.turns.findIndex((turn) => turn.requestId === event.data.requestId)
    if (index === -1) return bufferPendingEvent(state, event)

    const turn = state.turns[index]
    if (turn.status !== 'streaming') {
      // 终态轮次不再接受正文类事件；只允许 `done` 补上 messageId
      if (event.name !== 'done' || turn.messageId !== null) return state
      const turns = [...state.turns]
      turns[index] = { ...turn, messageId: event.data.messageId }
      return { ...state, turns }
    }

    const nextTurn = reduceTurn(turn, event)
    if (nextTurn === turn) return state
    const turns = [...state.turns]
    turns[index] = nextTurn
    return { ...state, turns }
  } catch {
    // 兜底：归一化/折叠里的任何意外都不许冒到 UI
    return state
  }
}

/** 把一条事件折进一轮状态；没有变化时原样返回（便于上层跳过重渲染）。 */
function reduceTurn(turn: ChatTurn, event: IpcEvent): ChatTurn {
  switch (event.name) {
    case 'delta':
      return { ...turn, text: turn.text + event.data.delta }

    case 'citation':
      return { ...turn, citations: [...turn.citations, ...event.data.citations] }

    case 'payload':
      return {
        ...turn,
        cards: [
          ...turn.cards,
          {
            id: `${turn.requestId}#${turn.cards.length}`,
            kind: event.data.kind,
            tool: readToolName(event.data.payload),
            payload: event.data.payload
          }
        ]
      }

    case 'blocked':
      // 撤回：正文换成安全提示，原文留在 blocked.retractedText 里（供调试/轨迹，不展示给学生）
      return {
        ...turn,
        status: 'blocked',
        blocked: {
          reason: event.data.reason,
          safeText: event.data.safeText,
          retractedText: turn.text
        },
        text: event.data.safeText
      }

    case 'done':
      return { ...turn, status: 'done', messageId: event.data.messageId.length > 0 ? event.data.messageId : null }

    case 'error':
      return {
        ...turn,
        status: 'error',
        error: {
          message: sanitizeNotice(event.data.message),
          degraded: event.data.degraded
        }
      }
  }
}

/** 轮次尚未建立：按 `requestId` 缓冲（有上限），避免「事件先到」被整段丢掉。 */
function bufferPendingEvent(state: ConversationState, event: IpcEvent): ConversationState {
  const requestId = event.data.requestId
  const kept = [...(state.pending[requestId] ?? []), event].slice(-MAX_PENDING_EVENTS_PER_TURN)
  const pending: Record<string, IpcEvent[]> = { ...state.pending, [requestId]: kept }

  const ids = Object.keys(pending)
  while (ids.length > MAX_PENDING_TURNS) {
    const oldest = ids.shift()
    if (oldest === undefined) break
    delete pending[oldest]
  }
  return { ...state, pending }
}

/**
 * 事件归一化：认得出就返回**字段已校验、兜底已补齐**的契约事件，认不出返回 `null`。
 * 这里是「不许有解析层」的边界 —— 校验的是**对象字段**，不是字节流。
 */
export function normalizeIpcEvent(rawEvent: unknown): IpcEvent | null {
  if (typeof rawEvent !== 'object' || rawEvent === null) return null
  const record = rawEvent as { name?: unknown; data?: unknown }
  if (typeof record.name !== 'string') return null
  if (typeof record.data !== 'object' || record.data === null) return null

  const data = record.data as Record<string, unknown>
  const requestId = readText(data.requestId)
  if (requestId === null) return null

  switch (record.name) {
    case 'delta': {
      // ★ 增量片段**不做 trim**：空格与换行也是内容的一部分
      const delta = data.delta
      if (typeof delta !== 'string' || delta.length === 0) return null
      return { name: 'delta', data: { requestId, delta } }
    }

    case 'citation': {
      const citations = readCitations(data.citations)
      return citations.length === 0 ? null : { name: 'citation', data: { requestId, citations } }
    }

    case 'payload': {
      const kind = readPayloadKind(data.kind)
      return kind === null ? null : { name: 'payload', data: { requestId, kind, payload: data.payload } }
    }

    case 'blocked':
      return {
        name: 'blocked',
        data: {
          requestId,
          reason: readText(data.reason) ?? '内容安全终审判定为不适合展示。',
          safeText: readText(data.safeText) ?? FALLBACK_SAFE_TEXT
        }
      }

    case 'done':
      // 缺 messageId 也要放行：本轮确实结束了，不能让 UI 卡在「正在回答」
      return { name: 'done', data: { requestId, messageId: readText(data.messageId) ?? '' } }

    case 'error':
      return {
        name: 'error',
        data: {
          requestId,
          message: sanitizeNotice(data.message),
          // 缺 degraded 时按「降级」处理：宁可多提示一句能力受限，也不要静默吞掉异常
          degraded: data.degraded !== false
        }
      }

    default:
      return null
  }
}

/** 可读提示：折叠空白并截断（**绝不把堆栈原样塞进气泡**）。 */
export function sanitizeNotice(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_ERROR_TEXT
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return FALLBACK_ERROR_TEXT
  return flat.length > MAX_NOTICE_CHARS ? `${flat.slice(0, MAX_NOTICE_CHARS)}…` : flat
}

function readCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return []
  const citations: Citation[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const chunkId = readText(record.chunkId)
    const gradeLevel = readGradeLevel(record.gradeLevel)
    // 学段认不出就不展示（宁缺一条来源，也不要给学生一个猜出来的学段标签）
    if (chunkId === null || gradeLevel === null) continue
    citations.push({
      chunkId,
      chapterTitle: readText(record.chapterTitle) ?? UNKNOWN_CHAPTER,
      sectionTitle: readText(record.sectionTitle) ?? UNKNOWN_CHAPTER,
      gradeLevel,
      compat: record.compat === true
    })
  }
  return citations
}

function readPayloadKind(value: unknown): PayloadKind | null {
  return typeof value === 'string' && (PAYLOAD_KINDS as readonly string[]).includes(value)
    ? (value as PayloadKind)
    : null
}

function readGradeLevel(value: unknown): GradeLevel | null {
  return typeof value === 'string' && (GRADE_LEVELS as readonly string[]).includes(value)
    ? (value as GradeLevel)
    : null
}

/** 占位载荷里的 `tool` 字段（真实载荷由票 08 的 Extension 产出，结构由 pydantic 决定）。 */
function readToolName(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  return readText((payload as Record<string, unknown>).tool)
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
