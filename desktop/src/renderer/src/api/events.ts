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

import type {
  Citation,
  CitationDetail,
  CitationEvent,
  Degraded,
  GradeLevel,
  IpcEvent,
  PayloadKind
} from '@shared/ipc-events'

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

/**
 * 出错 / 降级提示。`degraded === true` 表示「能力受限但仍可用」，不是崩溃。
 *
 * ★ 两种 `degraded` 的**轮次语义**不同（跨进程约定，主进程与本文件的判据必须一致）：
 *   - `degraded === true`：**只提示，不终结本轮** —— 主进程仍会把这一轮的回答生成完
 *     （典型场景：某个 Tool 没成功，模型接着用已有信息把话讲完），
 *     所以后续 `delta` 必须照常进入正文，`done` 也还要能收尾；
 *   - `degraded === false`：真正的崩溃式失败，本轮到此为止（终态 `error`）。
 */
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
  /**
   * 引用的**细节**（右栏「教材原文」抽屉用）：节级正文、相关度、父块 id、检索方式。
   *
   * ★ 按 `chunkId` 与 `citations` 对齐；`citations` 里没有的 id 不会出现在这里
   *   （否则界面上会出现「有原文可看、却没有对应引用行」的孤儿）。
   * ★ 主进程认不出细节时是空数组（可选字段），消费方必须容忍它缺席 ——
   *   那时「原文」按钮显示「原文暂时取不到」，而不是点下去毫无反应。
   */
  citationDetails: CitationDetail[]
  /**
   * 这一轮检索实际走到的降级链档位（`null` = 本轮没发生检索）。
   *
   * ★ **原样透传 Python 的判定**，渲染进程不重新推理（四级链必须一次走完）。
   *   右栏的降级链据此点亮；`null` 时四档都显示「本轮未检索」（不是失败）。
   */
  citationDegraded: Degraded | null
  cards: InlineCard[]
  status: TurnStatus
  /**
   * ★★ **分叉点：助手那条回答的条目 id**（`null` = 这条消息不能作为分叉点）。
   *
   * 「从这里重新问」挂在这条回答上 —— 点了之后：把「根 → 这条回答」复制成新会话，
   * 学生换一种问法接着问。它是**文件里的稳定标识**，不是「第几轮」。
   */
  entryId: string | null
  /**
   * ★★ **分叉点：学生那句话的条目 id**（`null` = 不能从这句分叉）。
   *
   * 与 {@link entryId} 配对：一条 turn 里学生说了一句、助手答了一句，两者各是一个
   * 条目、各能当分叉点。**两个都要** —— 学生的意图可能是
   * 「我这句话问得不好，重问」（从 `userEntryId` 分叉）
   * 也可能是「他这条答得不对，我换个方向」（从 `entryId` 分叉）。
   */
  userEntryId: string | null
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

/**
 * ★ 一条**恢复出来的历史消息**（打开历史会话时由主进程投影后回传）。
 *
 * ★★ 为什么历史消息**必须是 `ChatTurn`**（而不是另建一个「历史消息列表」）：
 *    界面的消息列表只有一个渲染路径（`ChatMessage.vue` 吃 `ChatTurn`）。
 *    另建一条路径意味着两套气泡样式、两套滚动行为、两套「学生/AI」头像逻辑 ——
 *    而它们迟早分叉（本项目在「两处各写一份」上有过多次前科）。
 *
 * ★ 为什么**不**恢复当时的卡片 / 引用 / 降级档位：那些是**当时那一次交互**的产物
 *    （动画 iframe 的 nonce 早已过期、题库卡片也要重新取题），恢复它们等于伪造
 *    一次并未发生的交互。回看只需要「他问了什么、AI 答了什么」。
 * ★ `requestId` 用 `restored-` 前缀：它与 `turn_` 前缀的**真实轮次**区分开 ——
 *    任何按 requestId 认领轮次的逻辑（如悬浮追问窗）都不会误认一条历史消息。
 */
export function restoredTurn(
  index: number,
  role: 'user' | 'assistant',
  text: string,
  gradeLevel: GradeLevel | null = null,
  /**
   * ★★ 这条消息在会话文件里的条目 id —— 「从这里重新问」拿它去分叉。
   * 空串 = 认不出（老会话 / 别处造的状态），那条消息**不给**分叉按钮。
   */
  entryId = ''
): ChatTurn {
  const base = createTurn(`restored-${index}`, role === 'user' ? text : '', gradeLevel)
  if (role === 'assistant') {
    // 助手那条：正文落在 `text`，条目 id 落在 `entryId`
    return {
      ...base,
      text,
      status: 'done',
      entryId: entryId || null,
      userEntryId: null
    }
  }
  // 学生那条：`userText` 承载正文（由 createTurn 传入），`entryId` 留空 ——
  // ★ 两个字段各管一边，**不要串**：`entryId` 永远是「助手那条回答」的分叉点
  return { ...base, status: 'done', entryId: null, userEntryId: entryId || null }
}

/**
 * ★★ 把恢复出来的一批消息整段铺成**轮次**（**替换**，不是追加）。
 *
 * 为什么不追加：这是一次**会话切换** —— 手里那段消息属于**上一条**会话，
 * 追加会让两段对话拼在一起（学生会看到自己没说过的话）。
 *
 * ★★★ **必须把 user 与 assistant 配成一轮**（实测抓到的缺陷，见 P-106）：
 *   初版把每条消息各当成一轮，于是恢复出来的对话在界面上长成这样：
 *
 *   ```
 *   [我的问题]        ← 一轮：有学生气泡 + **一个空的回答块**
 *   [（空）][他的回答]  ← 另一轮：空的学生气泡 + 回答
 *   ```
 *
 *   两半各占一轮，视觉上就是「一半一半的对话」。而 `restoredTurn` 的两条分支
 *   本来就写着「学生消息的 `text` 留空 / 助手消息的 `userText` 留空」——
 *   那正是**配对**的写法，初版却把它们拆开各建了一轮。
 *
 * ★ 配对规则（按文件里的顺序走）：
 *   - `user` 开头 → 建一轮，`userText` 填上、`userEntryId` 记下；
 *   - 紧跟的 `assistant` → **补进同一轮**（填 `text` / `entryId`），不新建轮；
 *   - 连续两个 `user`（上一轮失败 / 被拦下，没有回答）→ 前一轮就那样收尾
 *     （只有学生问题，没有回答）—— 那是**如实反映**，不是缺陷；
 *   - 开头就是 `assistant`（开场引导被投影进来）→ 单独一轮（`userText` 空）。
 *
 * ★ 空数组返回**全新的空状态**：切到一条空会话时必须真的清空。
 * ★ 不去重、不合并同文本消息：学生完全可能连着问两句一样的话。
 */
export function restoreConversation(
  // ★ `at`（消息时间戳）收下但**不渲染**：它是主进程投影时带的（与「只读回看」同形），
  //   而对话页的气泡上没有时间戳 —— 与其让调用方为了过类型而把它剥掉
  //   （剥的过程会顺手丢掉别的字段），不如在这里明说「收下、暂不使用」。
  messages: ReadonlyArray<{
    role: 'user' | 'assistant'
    text: string
    at?: number
    /** 条目 id（分叉点）；缺 = 那条消息不给分叉按钮。 */
    entryId?: string
  }>,
  gradeLevel: GradeLevel | null = null
): ConversationState {
  const turns: ChatTurn[] = []
  for (const message of messages) {
    const entryId = message.entryId ?? ''
    const last = turns[turns.length - 1]

    if (message.role === 'user') {
      // 学生的话**总是**开一轮（哪怕上一轮还没有回答：那是两次提问）
      turns.push(
        restoredTurn(turns.length, 'user', message.text, gradeLevel, entryId)
      )
      continue
    }

    // assistant：能补进上一轮就补进去（**这就是配对**），否则单独一轮
    if (last !== undefined && last.status === 'done' && last.text === '') {
      // ★★ 关键：`restoredTurn('assistant', …)` 造出来的对象 `userText` 是**空的** ——
      //    直接替换会把刚放进去的学生问题丢掉（一变二之后又变回一半）。
      //    所以这里**保留上一轮的 user 那一半**，只把回答那一半填上。
      const withAnswer = restoredTurn(
        turns.length - 1,
        'assistant',
        message.text,
        gradeLevel,
        entryId
      )
      turns[turns.length - 1] = { ...withAnswer, userText: last.userText, userEntryId: last.userEntryId }
      continue
    }
    turns.push(restoredTurn(turns.length, 'assistant', message.text, gradeLevel, entryId))
  }
  return { turns, pending: {}, ignoredEvents: 0 }
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
    citationDetails: [],
    citationDegraded: null,
    cards: [],
    status: 'streaming',
    entryId: null,
    userEntryId: null,
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

    case 'citation': {
      // ★ 同一轮里模型可能多次调 `rag_search`，同一个 `chunkId` 会**重复到达**；
      //   而来源标签拿 `chunkId` 当 `v-for` 的 key（`SourceChips.vue`）——
      //   不去重就会出现「Duplicate keys found」与标签重复/错位。
      //   按首次出现的顺序保留（后面的同 id 条目直接丢弃）。
      const seen = new Set(turn.citations.map((citation) => citation.chunkId))
      const fresh = event.data.citations.filter((citation) => {
        if (seen.has(citation.chunkId)) return false
        seen.add(citation.chunkId)
        return true
      })

      // ★ 细节与降级档位**即使没有新引用也要收下**：
      //   重复到达的 `citation` 事件里可能带着**更完整**的细节（同一个 chunkId 第二次
      //   返回时 `text` 才补全），而 `degraded` 更是「本轮检索走成什么样」的唯一记录 ——
      //   只因为它没有新增引用就整条丢掉，右栏的降级链会永远显示「本轮未检索」。
      const details = mergeCitationDetails(turn.citationDetails, event.data.details ?? [])
      const degraded = event.data.degraded ?? turn.citationDegraded
      const citations = fresh.length === 0 ? turn.citations : [...turn.citations, ...fresh]
      if (citations === turn.citations && details === turn.citationDetails && degraded === turn.citationDegraded) {
        return turn
      }
      return { ...turn, citations, citationDetails: details, citationDegraded: degraded }
    }

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

    case 'error': {
      const notice: ErrorNotice = {
        message: sanitizeNotice(event.data.message),
        degraded: event.data.degraded
      }
      // ★ `degraded === true` = **降级提示，不是终态**：主进程还会把这一轮讲完
      //   （Tool 失败但模型接着用已有信息作答），所以这里只记提示 + 保持 `streaming`，
      //   让后续 `delta` / `done` 照常进来。置成终态会把后半段正文整段丢掉。
      if (notice.degraded) return { ...turn, error: notice }
      // `degraded === false` = 真正的失败：本轮到此为止。
      return { ...turn, status: 'error', error: notice }
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
      // ★ 没有引用也**可能是有效事件**：主进程只在「认得出的引用非空」时发 citation
      //   （`agent/events.ts`），但同一轮的**第二次**检索可能命中同一批 chunkId ——
      //   那时 `citations` 会被这边去重掉，而 `degraded` 与更完整的 `details`
      //   仍要收下（否则右栏的降级链永远显示「本轮未检索」）。
      const details = readCitationDetails(data.details)
      const degraded = readDegraded(data.degraded)
      if (citations.length === 0 && details.length === 0 && degraded === null) return null
      const payload: CitationEvent = { requestId, citations }
      if (details.length > 0) payload.details = details
      if (degraded !== null) payload.degraded = degraded
      return { name: 'citation', data: payload }
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

/**
 * 读引用细节（右栏「教材原文」抽屉的数据源）。
 *
 * ★ 逐字段读 + 兜底：`text` 缺失时回空串（界面据此说「原文暂时取不到」），
 *   `score` 认不出回 `null`（**不补 0** —— 0 分看起来像一个真实的坏结果，
 *   而 `null` 诚实地表示「这次没给分数」）。
 * ★ `chunkId` 是唯一的必需字段：它是与引用行对齐的键，缺了整条丢掉。
 */
function readCitationDetails(value: unknown): CitationDetail[] {
  if (!Array.isArray(value)) return []
  const details: CitationDetail[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const chunkId = readText(record.chunkId)
    if (chunkId === null) continue
    details.push({
      chunkId,
      text: typeof record.text === 'string' ? record.text : '',
      score:
        typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : null,
      parentChunkId: readText(record.parentChunkId),
      degraded: readDegraded(record.degraded),
      kpId: readText(record.kpId),
      expanded: record.expanded === true
    })
  }
  return details
}

/** 四个降级档位（与契约 `Degraded` 同源；认不出回 `null`，**不兜底成 outline**）。 */
const DEGRADED_LEVELS = ['vector', 'cloud', 'fts', 'outline'] as const

function readDegraded(value: unknown): Degraded | null {
  return typeof value === 'string' && (DEGRADED_LEVELS as readonly string[]).includes(value)
    ? (value as Degraded)
    : null
}

/**
 * 合并细节：同一 `chunkId` **后到的更完整的那份赢**。
 *
 * ★ 同一轮可能多次检索、同一 chunkId 被多次返回。第一次回来时 `text` 可能是空的
 *   （主进程那一刻还没拿到父块正文），第二次才补全 —— 直接「后到覆盖」
 *   会让先到的那份被一份更差的覆盖掉，所以按「有内容的赢」合并。
 * ★ 返回**原数组**（引用不变）表示没有变化，调用方据此跳过重渲染。
 */
function mergeCitationDetails(
  current: readonly CitationDetail[],
  incoming: readonly CitationDetail[]
): CitationDetail[] {
  if (incoming.length === 0) return current as CitationDetail[]
  const index = new Map(current.map((item, position) => [item.chunkId, position]))
  let changed = false
  const next = [...current]
  for (const item of incoming) {
    const position = index.get(item.chunkId)
    if (position === undefined) {
      index.set(item.chunkId, next.length)
      next.push(item)
      changed = true
      continue
    }
    const existing = next[position] as CitationDetail
    const merged: CitationDetail = {
      chunkId: existing.chunkId,
      // ★ 正文与分数：有内容的赢（空串 / null 视为「还没有」）
      text: existing.text.length > 0 ? existing.text : item.text,
      score: existing.score ?? item.score,
      parentChunkId: existing.parentChunkId ?? item.parentChunkId,
      degraded: existing.degraded ?? item.degraded,
      kpId: existing.kpId ?? item.kpId,
      expanded: existing.expanded || item.expanded
    }
    if (
      merged.text !== existing.text ||
      merged.score !== existing.score ||
      merged.parentChunkId !== existing.parentChunkId ||
      merged.degraded !== existing.degraded ||
      merged.kpId !== existing.kpId ||
      merged.expanded !== existing.expanded
    ) {
      next[position] = merged
      changed = true
    }
  }
  return changed ? next : (current as CitationDetail[])
}

function readCitations(value: unknown): Citation[] {  if (!Array.isArray(value)) return []
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
