/**
 * 对话状态（Pinia）：只负责「收事件 → 交给纯函数折叠 → 暴露给学生界面」。
 *
 * ★ 渲染进程不直连 sidecar 的 HTTP：这里是 `window.api`（preload 白名单）的唯一使用者之一。
 * ★ 事件分发的逻辑全在 `api/events.ts` 的纯函数里（可单测），本文件不做任何解析。
 *
 * ★★ 学段有**两条来源**，写入口**只有一条**：
 *   - 自动：系统从对话里判定（规则引擎 + 轻量 LLM，主进程侧），经 `grade:changed` 推来，
 *     本 store 只把它当**状态**收下（`currentGrade` + 一次性提示 `gradeNotice`）；
 *   - 手动：学生显式指定 → {@link setGrade} → `window.api.setGrade()`（走 `grade:set` 独立通道）
 *     → 服务端写库 → 主进程把结果推回来。
 *   ★ 手动**绝不混进对话请求**：`sendChat({ text })` 的字段集合被守卫 G6c 钉死为 `['text']`。
 *     混进去的话「发一条消息」会顺带写一次学段（重发同一句话、清空重打字都会再写一遍），
 *     而且拿不到回执 —— 学生无从知道冷却还剩几轮。
 *   ★ 前端自己算、自己改本地状态也不行：界面显示的学段会与库里的不一致，
 *     而下一轮对话用的是库里的值 —— 表现成「指示器写着初中，回答却按小学讲」。
 *
 * ★ 教材章节（本章节新增）与学段是**两条独立的线**，但共用同一套纪律：
 *   - 学生的显式选择 → {@link setChapter} → `window.api.setChapter()`（`chapter:set` 独立通道）；
 *   - 章节是**软偏好**（进 System Prompt 的画像块，不做检索硬过滤）；
 *   - ★ **学段一变就清空章节**（那本教材不存在了）—— 清空规则在服务端，
 *     本 store 在「显示出来的学段真的变了」时**真去读一次**（{@link refreshChapter}），
 *     不自己猜「大概是空的了」。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CitationDetail, Degraded, GradeLevel, IpcEvent } from '@shared/ipc-events'
import { GRADE_LABELS, chapterLineLabel, gradeAdaptNotice, gradeManualNotice } from '../labels'
import {
  GRADE_SET_MISSING_HINT,
  normalizeGradeState,
  resolveGradeBridge,
  type GradeOrigin
} from '../api/grade'
import {
  CHAPTER_SET_MISSING_HINT,
  normalizeChapterState,
  resolveChapterBridge
} from '../api/chapter'
import {
  buildQuizSubmissionMessage,
  collectQuizResults,
  quizSubmissionDisplayText,
  quizUserTextDisplay,
  type QuizResultView
} from '../cards/quiz'
import { codingUserTextDisplay } from '../cards/coding'
import { parsePlanRequest, planUserTextDisplay } from '../study/plan-request'
import {
  applyChatEvent,
  emptyConversation,
  restoreConversation,
  startTurn,
  subscribeToChatEvents,
  type ChatTurn,
  type ConversationState,
  type InlineCard
} from '../api/events'
import { resolveSessionBridge } from '../api/sessions'
import { warnWiring } from '../api/wiring-notice'
// ★ 演示沙箱（预置数据）的脚本回放：只有 `send()` 里那一个分支用它（**取用在动作内部**，
//   不在这里 const 一个实例 —— 两个 store 互相 import，顶层取会落在模块求值的循环上）。
import { useDemoSeedStore } from './demoSeed'

export const useChatStore = defineStore('chat', () => {
  const conversation = ref<ConversationState>(emptyConversation())
  const bridgeReady = ref(true)
  /** 本地提示（桥接缺失、发送被拒等），不是 6 事件里的 `error`。 */
  const localNotice = ref<string | null>(null)
  /**
   * 当前学段：`null` = 系统还没判出来、学生也还没选过。
   *
   * ★ 只认「有依据」的四态（D-066）：`rules`（本地规则判定）/ `llm`（AI 引擎判定）/
   *   `inferred`（历史值 = rules）/ `explicit`（学生选的）。
   *   冷启动默认值（`default`）不是判定结果，也不是学生的选择 ——
   *   拿它上屏等于用默认值冒充一个结论（在演示里就是撒谎）。
   */
  const currentGrade = ref<GradeLevel | null>(null)
  /** 学段来源（五态；`null` = 还没收到任何推送）。 */
  const gradeOrigin = ref<GradeOrigin | null>(null)
  /** 学段**变化**时的一次性提示（下一个问题发出时清掉）。 */
  const gradeNotice = ref<string | null>(null)
  /** 学段推送通道缺失时的可读说明（缺通道不白屏，只说明原因）。 */
  const gradeBridgeError = ref<string | null>(null)
  /**
   * 学生当前在学的教材章节（`''` = 未选择，自由问答）。
   *
   * ★ 它是一份**软偏好**：只进 System Prompt 的画像块（「回答与检索优先围绕本章」），
   *   不做检索硬过滤 —— 学生问到别的章节照常回答。
   * ★ 界面显示的章节**永远来自服务端**（回执 / 推送 / 重取），前端不自己存一份猜测值：
   *   学段变更会清空章节，而这条规则只有服务端知道。
   * ★ 显示用的那一行字由 {@link chapterLineLabel} 拼（指示器与设置页共用同一句）。
   */
  const currentChapter = ref('')
  /**
   * 章节**被清空**时的一次性提示（下一个问题发出时清掉；学生自己选的那一下有更贴切的回执）。
   *
   * ★ 为什么必须有这句话：那一下**不是学生的动作**（是系统判定出的学段变了），
   *   学生会看到「正在学：第4章…」突然不见了 —— 不说一声就是「东西自己没了」。
   */
  const chapterNotice = ref<string | null>(null)
  /** 章节通道缺失时的可读说明（与 `gradeBridgeError` 同一口径）。 */
  const chapterBridgeError = ref<string | null>(null)
  /**
   * 输入框草稿（**供「去练一练」预填**）。
   *
   * ★ 为什么草稿要放到 store 里：输入框在 `MessageComposer.vue`，它的 `draft` 是组件本地状态；
   *   而「从错题本回对话页接着练」这个动作发生在**另一个视图的另一个组件**里，
   *   没有别的办法把一句话放进那个输入框（`provide/inject` 会绕更远）。
   * ★ 组件的本地草稿与此处**双向同步**（见 `MessageComposer.vue` 的注释）：
   *   以 store 为初值、每次输入写回 store，于是「预填 → 学生接着改 → 发送」这条链是通的。
   */
  const draft = ref('')
  let unsubscribe: (() => void) | null = null
  let unsubscribeGrade: (() => void) | null = null
  let unsubscribeChapter: (() => void) | null = null
  let unsubscribeSession: (() => void) | null = null
  let unsubscribeTurnEntries: (() => void) | null = null

  /**
   * 本轮条目 id 的**超前到达**缓冲（`requestId` → 两个 id）。
   *
   * ★ 为什么需要它：主进程在本轮结束时推 `turn:entries`，而渲染进程是在
   *   `sendChat` 的**回执**里才建轮 —— 两者顺序不保证（与 6 事件的
   *   `pending` 缓冲同一个竞态，见 `api/events.ts` 的说明）。
   *   不缓冲的话，快的那条推送会被丢掉，表现是「这一轮永远没有分叉按钮」——
   *   而这与「这轮本来就取不到条目」在界面上长得一模一样（最难查的那种）。
   */
  const pendingTurnEntries = new Map<string, { userEntryId: string; entryId: string }>()

  /** 把条目 id 落到对应那一轮上（轮次还没建就缓冲）。 */
  function applyTurnEntries(requestId: string, userEntryId: string, entryId: string): void {
    const index = conversation.value.turns.findIndex((turn) => turn.requestId === requestId)
    if (index === -1) {
      // 最多留 8 条（与 6 事件的缓冲同量级）：防伪造 requestId 撑爆内存
      if (pendingTurnEntries.size >= 8) {
        const oldest = pendingTurnEntries.keys().next().value
        if (oldest !== undefined) pendingTurnEntries.delete(oldest)
      }
      pendingTurnEntries.set(requestId, { userEntryId, entryId })
      return
    }
    const turn = conversation.value.turns[index] as ChatTurn
    if (turn.entryId === entryId && turn.userEntryId === userEntryId) return
    const turns = [...conversation.value.turns]
    turns[index] = {
      ...turn,
      entryId: entryId || null,
      userEntryId: userEntryId || null
    }
    conversation.value = { ...conversation.value, turns }
  }

  /* ------------------------------------------------------------ 会话（切换/新建） */

  /**
   * 当前会话的 id（`''` = 还没有会话）。
   *
   * ★ 它**只由主进程给**（`getCurrentSession` / `openSession` / `session:changed`）：
   *   渲染进程自己记一个「我刚开了个新会话」是第二处真相 —— 而会话的文件名、
   *   标题、条数都在主进程那一侧。
   */
  const currentSessionId = ref('')
  /** 当前会话标题（服务端 LLM 生成过就是它，否则是首条消息截断；空串 = 还没内容）。 */
  const currentSessionTitle = ref('')
  /**
   * 当前会话的消息条数（主进程给）。
   *
   * ★ 它存在的唯一理由：**「历史对话」列表要跟着刷新**。新会话的第一轮跑完之后，
   *   这条会话才在磁盘上真的存在（Pi 在第一条 assistant 消息到达前不写文件），
   *   列表不刷新就看不见它 —— 学生会以为对话没保存。
   *   侧栏 `watch` 这个数，从 0 变成 >0 时重取一次列表。
   */
  const currentSessionMessageCount = ref(0)
  /** 切换/新建会话进行中（学生点了历史会话之后要看到「正在打开…」）。 */
  const sessionSwitching = ref(false)
  /** 会话通道不可用时的可读说明（缺通道不白屏，只说明原因 —— 与学段/章节同一口径）。 */
  const sessionBridgeError = ref<string | null>(null)

  /**
   * ★★ **AI 主动发起的第一条消息**（需求原文：「智能体也能主动发起对话引导学习章节内容」）。
   *
   * 它是**独立于 turns 的一条状态**，理由有两条：
   *   1. 它**不是一轮问答**（没有学生的问题、没有流式过程、没有 `requestId`）——
   *      塞进 `turns` 会逼着所有按轮次算的逻辑（排队、滚动、卡片收集）去理解一个特例；
   *   2. 它只在该会话**还没开始**（学生一句话都没说过）时出现，学生一开口就该消失
   *      （见 `send`）—— 而 `turns` 里的东西是**只增不减**的。
   *
   * ★ 它**同时已经写进了 Pi 会话**（主进程 `appendOpeningMessage`）。所以恢复一条
   *   **没开始**的会话时，主进程**不再给 `opening` 之外的东西**：那半条消息不当普通消息
   *   铺回来（否则界面进不了空态，开场卡与四张入口卡全没了 —— 那次实测缺陷见
   *   `handlers.ts` 的 `resolveSessionPrelude`）。
   */
  const opening = ref('')
  /** 开场引导指向的知识点（空串 = 没有可去的地方，界面**不渲染**动作按钮）。 */
  const openingKpId = ref('')
  /**
   * 那个知识点的中文名（空串 = 拿不到）。
   * ★ D-074：动作按钮的预填文案用它，**不再**去 `/recommendation` 里按 id 反查 ——
   *   推荐改成随机之后两处不再同源，反查会落空（表现是「点了按钮没反应」）。
   */
  const openingKpName = ref('')

  /** 学生已经回应过开场引导（点过动作、或直接开口说话）→ 不再显示它。 */
  const openingDismissed = ref(false)

  /** 该不该显示开场引导：有内容、且学生还没回应过。 */
  const showOpening = computed(() => opening.value !== '' && !openingDismissed.value)

  /** 学生点「好啊，就从这里开始」：记下目标知识点并收起引导（真正的提问由组件发起）。 */
  function acceptOpening(): void {
    openingDismissed.value = true
  }

  /* ------------------------------------------------------------ 学习计划（巩固条） */

  /**
   * ★★ **「学习计划」那一轮的认领与输出**（2026-09-30 用户裁决）。
   *
   * 裁决内容：学习地图 / 依赖图两处「开始学习」从「只预填一句话」改成**跳页 + 直发**
   * （那两个入口的意图就是「现在讲这一个」，见两个 goLearn 的注释），讲完之后在消息列表
   * 末尾**常驻**一条「去闯关练一练 / 现在考考我」。
   *
   * ★ 为什么 kpId 只能从**这一轮**带出来：巩固条的两条路都要它（一条切闯关页的关卡、
   *   一条发练习请求），而「刚才讲的是哪个知识点」只写在那一轮发给模型的那段文本里 ——
   *   让界面去别处反查（D-074 之前推荐那条路就是这样）会两处不同源，按钮点下去落空。
   * ★ 为什么 `planReady` 只在终态 `done` 置真：回答还在逐字生成、或这一轮中途报错时
   *   挂出按钮，等于请学生去练一个还没讲的东西 —— 时机会错，比按钮迟到更糟。
   * ★ 认领只发生在 {@link send} 里，判据是**真正发给模型的那段**（不是显示文本）：
   *   显示文本是「我想学「循环结构」…」，里面没有内部编号，认不出来。
   *   `ChatSendRequest` 依旧只有 `text` 一个字段（守卫 G6c）——
   *   这一整块状态都是**渲染进程本地**的，不过 IPC。
   */
  const planKpId = ref('')
  const planKpName = ref('')
  const planReady = ref(false)
  /** 被认领的那一轮的 requestId（`''` = 没有在等的计划轮）。 */
  let planRequestId = ''

  /**
   * 清掉计划会话。
   *
   * ★ 与 `openingDismissed` **同址**（三处：冷启动/切换对齐、切会话、清空对话）：
   *   两者都是「属于这一段对话」的临时状态 —— 换一段对话后还挂着上一个知识点的
   *   巩固条，学生会以为现在讲的还是那一个。
   */
  function clearPlanSession(): void {
    planKpId.value = ''
    planKpName.value = ''
    planReady.value = false
    planRequestId = ''
  }

  /**
   * 核对被认领那一轮的终态（每次事件折叠后调一次）。
   *
   * ★ 为什么不 `watch`：调用点本来就在事件回调里、且状态刚折完；多一层 watch
   *   只会多一次调度，还会与滚动跟随的时序错开。
   */
  function settlePlanTurn(): void {
    if (planRequestId === '') return
    const turn = conversation.value.turns.find((item) => item.requestId === planRequestId)
    if (turn === undefined || turn.status === 'streaming') return
    planRequestId = ''
    // `done` = 计划真的讲完了 → 挂出巩固条。
    if (turn.status === 'done') {
      planReady.value = true
      return
    }
    // 其余终态（`error` / `blocked`）一律清掉：`blocked` 的正文已经被撤回，
    // 底下再留一条「去练一练」是在邀请学生练一个刚被收回的计划。
    planKpId.value = ''
    planKpName.value = ''
    planReady.value = false
  }

  const turns = computed(() => conversation.value.turns)
  const streaming = computed(() => turns.value.some((turn) => turn.status === 'streaming'))

  /**
   * 待发的一条消息（回答还在生成时，学生又按了发送）。
   *
   * ★★ 为什么需要它（UX 体检抓到的真实问题）：学生在读回答的过程中把追问打好了，
   *   读到一半觉得不对，回车就想再问一句。旧实现里 `send()` 遇到 `streaming` 直接
   *   `return` —— **消息没发出去，也没有任何提示**：输入框里的字还在，界面毫无反应。
   *   学生的结论不是「上一个回答还在生成」，而是「**键盘坏了 / 软件卡了**」。
   *   实测脚本：`scripts/ux-probe-busy-send.mjs`（当时「有提示=否、轮次数不变」）。
   *
   * ★ 为什么是「排队」而不是「弹一句『请稍等』」：学生**已经**表达了意图（打完了按了回车），
   *   让他等回答结束后再手动按一次，等于把系统的时序问题转嫁给他。
   *   排队 = 举手，回答讲完就轮到他 —— 这也是他与其它聊天工具相处下来的预期。
   *
   * ★ 为什么只存**一条**：两条以上就成了「消息队列」，要面对排序、失败重试、
   *   逐条取消这些真正的复杂度；而「边读边想好一句追问」是这里真实发生的场景。
   *   多的部分不丢 —— 后来的会覆盖前一条，并把被覆盖的那条**告诉学生**（见 {@link queueNotice}）。
   */
  const queuedText = ref<string | null>(null)
  /** 覆盖提示（一次性）：学生连按两次发送时，告诉他前一条没被静默丢掉。 */
  const queueNotice = ref<string | null>(null)

  /** 学生主动取消排队。 */
  function cancelQueued(): void {
    if (queuedText.value !== null) {
      // 把内容**还回输入框**（而不是直接扔掉）：那是他自己敲的字
      draft.value = queuedText.value
      queuedText.value = null
      queueNotice.value = null
    }
  }


  /**
   * 整段对话里的卡片（**只在「卡片增删」时换引用**）。
   *
   * ★ 为什么不能写成 `computed(() => turns.value.flatMap((turn) => turn.cards))`：
   *   每个 `delta` 都会替换 `turns` 数组（reducer 每个事件返回新状态），于是这条 computed
   *   逐字重算 —— 而它下游是**卡片载荷解析**（`collectQuizResults` / `collectHints` /
   *   `collectResult`，每张卡片都要跑一遍白名单投影）。长对话 + 多张卡片时，
   *   流式回答期间每秒上百次全量重解析 + 全量重渲染，低配机上表现为打字卡顿。
   *
   * ★ 为什么可以安全缓存：reducer 只在**真的新增卡片**时才换 `turn.cards` 的数组引用
   *   （`[...turn.cards, …]`）；`delta` / `citation` / `blocked` / `done` / `error`
   *   都保留原引用（`{ ...turn, text }`）。所以「每轮的 cards 引用都没变」== 卡片没变。
   *   缓存命中时返回**同一个数组**，Vue 的 computed 在值未变时不会向下游传播
   *   （`refreshComputed` 里的 `hasChanged` 判定），解析与重渲染就此停在这一层。
   */
  const cards = computed<InlineCard[]>(() => {
    const lists = turns.value.map((turn) => turn.cards)
    if (
      cardCache !== null &&
      lists.length === cardCache.lists.length &&
      lists.every((list, index) => list === cardCache?.lists[index])
    ) {
      return cardCache.value
    }
    const flat = lists.flat()
    cardCache = { lists, value: flat }
    return flat
  })
  /** `cards` 的缓存（非响应式：只做「引用没变就别重算」的判据，不参与渲染）。 */
  let cardCache: { lists: readonly InlineCard[][]; value: InlineCard[] } | null = null

  /**
   * 最近一轮**检索**的降级档位（右栏「四级降级链」据此点亮）。
   *
   * ★ 从后往前找**第一轮有档位记录**的（不是「最后一轮」）：学生问一句寒暄时
   *   那一轮根本没检索（档位为 `null`），若一取最后一轮，右栏就会在寒暄之后
   *   把刚查过的那条链擦成「本轮未检索」—— 看起来像能力突然丢了。
   * ★ `null` = 至今没有发生过检索。**不是失败**：四档都该显示「未走到」。
   */
  const lastCitationDegraded = computed<Degraded | null>(() => {
    for (let index = turns.value.length - 1; index >= 0; index -= 1) {
      const degraded = turns.value[index]?.citationDegraded
      if (degraded !== undefined && degraded !== null) return degraded
    }
    return null
  })

  /**
   * 全部轮次的引用细节，按 `chunkId` 建索引（「教材原文」抽屉据此查全文）。
   *
   * ★ 跨轮索引而不是只看最后一轮：学生点开第 2 轮回答里的某个引用时，
   *   那一轮的细节与最后一轮无关。同一 `chunkId` 先到的赢（合并逻辑已经在
   *   事件层做过「有内容的赢」，这里只要第一个即可）。
   */
  const citationDetails = computed<Map<string, CitationDetail>>(() => {
    const map = new Map<string, CitationDetail>()
    for (const turn of turns.value) {
      for (const detail of turn.citationDetails) {
        if (!map.has(detail.chunkId)) map.set(detail.chunkId, detail)
      }
    }
    return map
  })

  /** 取某个引用 chunk 的详情（拿不到回 `null` → 界面显示「原文暂时取不到」）。 */
  function citationDetailOf(chunkId: string): CitationDetail | null {
    return citationDetails.value.get(chunkId) ?? null
  }

  /** 指示器上的学段名（还没判出来时是「待判定」）。 */
  const currentGradeLabel = computed(() =>
    currentGrade.value === null ? null : GRADE_LABELS[currentGrade.value]
  )

  /**
   * 全对话的批改结果（按 `qid` 索引）。
   *
   * 为什么跨轮收集：题目卡片在某一轮，学生作答后**下一轮**才带回 `QuizResult`；
   * 只在本轮找的话，题干那张卡片永远等不到「答对了 / 掌握度 +0.15」。
   *
   * ★ 依赖的是上面的 {@link cards}（卡片没变就不换引用）——这样流式正文增长时
   *   这条全量解析**不会**重跑；新增卡片（`payload` 事件）时照旧重算，
   *   「批改结果一定能刷出来」的行为不变。
   */
  const quizResults = computed<Map<string, QuizResultView>>(() => collectQuizResults(cards.value))

  /** 连上主进程事件流（幂等：重复调用不会重复订阅）。 */
  function connect(): void {
    connectGrade()
    connectChapter()
    connectSession()
    if (unsubscribe !== null) return
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      // ★★ 2026-09-22 改口（报告 0.2 + 双视角 D-063）：屏幕上是学生话，
      //    「缺什么 / 怎么接」进控制台（`warnWiring`，见 `api/wiring-notice.ts` 的文件头）。
      //    ⚠️ 这一句也是 `views/Chat.vue` 那条「对话暂时用不了」的接线细节 ——
      //    两处说的是同一件事（对话桥缺失），所以**只在 store 这里 warn 一次**（key 去重）。
      warnWiring(
        'chat.connect',
        'window.api 缺失：preload 没有加载（对话事件流整块不可用）。检查 preload 入口与 contextIsolation / sandbox 配置。'
      )
      localNotice.value = '对话暂时用不了，可以先看看别的页面；需要时请老师帮忙看看。'
      return
    }
    bridgeReady.value = true
    // ★★ 本轮条目 id（分叉点）：独立推送，不是 6 事件之一。
    //    ⚠️ 判据是「渲染进程手里**已经**建好这一轮」—— 事件可能早于 `sendChat` 的回执
    //    （与 6 事件的「超前到达」同一个竞态），所以先存进 `pendingTurnEntries`，
    //    由 {@link send} 在建轮之后补上。
    if (typeof window.api.onTurnEntries === 'function') {
      unsubscribeTurnEntries = window.api.onTurnEntries((payload) => {
        applyTurnEntries(payload.requestId, payload.userEntryId, payload.entryId)
      })
    }

    unsubscribe = subscribeToChatEvents(window.api, (event) => {
      const wasStreaming = streaming.value
      conversation.value = applyChatEvent(conversation.value, event)
      // ★ 被认领的计划轮可能在这一条事件上到了终态 —— 终态决定消息列表末尾那条常驻
      //   巩固条出不出来（见 planKpId 的说明）。放在下面「自动补发排队」之前：
      //   补发的那一句若是新的一份计划请求，它自己的认领会覆盖这里的结果。
      settlePlanTurn()

      // ★★ 一轮结束 → 把排队的那条发出去（见 queuedText 的说明）。
      //
      //   判据用「**之前**在流式、**现在**不流式」这个**边沿**，而不是「现在不流式」这个状态：
      //   后者在每一轮的非流式事件（citation / payload 等）上都会命中，
      //   会把队列在回答还没讲完时就提前发出去。
      //
      //   ⚠️ 只在**正常收尾**时发（`done`），`error` 结束时也发 —— 学生已经排了队，
      //     没有理由因为上一轮报错就把他的问题一起丢掉；出错的是上一轮，不是他的。
      //   ⚠️ 用 `void` 而不是 `await`：这是事件回调，不阻塞事件流本身。
      if (wasStreaming && !streaming.value) {
        const pending = queuedText.value
        if (pending !== null) {
          queuedText.value = null
          queueNotice.value = null
          void send(pending)
        }
      }
    })
  }

  /** 断开事件流（组件卸载时必须调用，避免监听器堆积）。 */
  function disconnect(): void {
    unsubscribe?.()
    unsubscribe = null
    unsubscribeGrade?.()
    unsubscribeGrade = null
    unsubscribeChapter?.()
    unsubscribeChapter = null
    unsubscribeSession?.()
    unsubscribeSession = null
    unsubscribeTurnEntries?.()
    unsubscribeTurnEntries = null
  }

  /* ------------------------------------------------------------ 会话（切换/新建） */

  /**
   * 订上「当前会话变化」的推送（幂等；缺通道时只记原因，不抛异常）。
   *
   * ★ 主进程推什么就显示什么 —— 渲染进程**不做第二套判定**，也不自己维护
   *   「当前是哪一条」（那会与主进程的实际会话分叉）。
   */
  function connectSession(): void {
    if (unsubscribeSession !== null) return
    const lookup = resolveSessionBridge()
    if (!lookup.ready) {
      sessionBridgeError.value = lookup.message
      return
    }
    sessionBridgeError.value = null
    try {
      unsubscribeSession = lookup.bridge.onSessionChanged((state) => {
        currentSessionId.value = state.sessionId
        currentSessionTitle.value = state.title
        currentSessionMessageCount.value = state.messageCount
      })
    } catch (error) {
      sessionBridgeError.value = `会话推送订阅失败：${
        error instanceof Error ? error.message : String(error)
      }`
      return
    }
    /**
     * ★★ **冷启动恢复**：挂载时读一次当前会话的完整状态。
     *
     * 这是「关掉应用再打开，上一段对话还在」这条验收的**渲染进程一半**：
     * 主进程启动时已经按 `sessionSourceForBoot()` 续上了最近一条会话，
     * 而恢复出来的正文只有它手里有 —— 不读这一次，学生看到的就是空对话。
     *
     * ⚠️ 与 `openSession` 不同，这里**不**用 `applySwitchResult`：
     *    那个函数会清掉「与上一段对话绑定的临时状态」，而挂载时那些状态本来就是空的。
     * ⚠️ 失败**不报错**：没有 Key / 服务没起来时应用仍要能用（降级永不白屏）。
     *
     * ★★ 冷启动**同样**会带来开场引导（2026-09-22 修正了这里的老口径）：判据在主进程那一侧
     *    （`resolveSessionPrelude`，看「学生开口了没有」）。当年「冷启动开头恒为空串」是为了
     *    避免「每次开应用都看到同一句招呼」—— 那条对**已经聊过**的会话仍然成立（`opening` 是空串），
     *    但对**还没开始**的会话，它让同一段对话重启后变成第三副样子（只剩一个空气泡 + 一句问候）。
     *    现在的纪律：**不重发**（不重复写进会话文件），但显示的就是文件里那条开场白。
     */
    void applyCurrentSessionState({ replace: false })
  }

  /**
   * 读一次「当前会话的完整状态」，并按它把界面**对齐**（唯一的落点）。
   *
   * 两条路共用：挂载时的**冷启动恢复**（见 {@link connectSession}）、
   * **删掉当前会话之后**的重新对齐（那条路主进程已经切到一条新的空白会话，
   * 而 `session:delete` 的回执里只有 id，没有状态 —— 不补读的话屏幕上会留着
   * 一段**已经不在盘上**的对话）。
   *
   * `replace`：
   *   · `false`（冷启动）—— 只在渲染进程手里**还没有任何消息**时才铺历史。
   *     挂载与「首条消息发出」可能竞态（学生手快），那时用历史覆盖会把他刚发的那轮抹掉；
   *   · `true`（删掉当前会话之后）—— **无条件整段替换**：手里那段属于刚被删掉的那条会话，
   *     留着它就是显示一份已经不存在的记录。
   *
   * ⚠️ 失败**不报错**（降级永不白屏）：没有 Key / 服务没起来 / 桥缺失时，
   *   界面保持现状即可，下一轮动作会再对齐一次。
   */
  async function applyCurrentSessionState(options: { replace: boolean }): Promise<void> {
    const lookup = resolveSessionBridge()
    if (!lookup.ready) {
      sessionBridgeError.value = lookup.message
      return
    }
    try {
      const result = await lookup.bridge.getSessionState()
      if (!result.ok) return
      currentSessionId.value = result.current.sessionId
      currentSessionTitle.value = result.current.title
      currentSessionMessageCount.value = result.current.messageCount
      if (options.replace || conversation.value.turns.length === 0) {
        // ★ 与 `applySwitchResult` 同一个出口的纪律：历史里的学生消息也要过翻译
        //   （JSONL 存的是发给模型的原文，见 `studentFacingMessages`）。
        conversation.value =
          result.messages.length > 0
            ? restoreConversation(studentFacingMessages(result.messages), null)
            : emptyConversation()
      }
      opening.value = result.opening
      openingKpId.value = result.openingKpId
      openingKpName.value = result.openingKpName
      openingDismissed.value = false
      clearPlanSession()
    } catch {
      /* 拉取失败不影响推送路径（学生仍能正常开新对话） */
    }
  }

  /**
   * ★★ **打开一条历史会话继续聊**（需求与 `architecture/pending/03` 的核心缺口）。
   *
   * 三件事的顺序（每一步都有它必须在那个位置的理由）：
   *   ① `sessionSwitching = true` —— 学生点了列表里的一条，界面必须立刻有反馈
   *      （几秒的装配在没有任何提示时会让人以为「点了没反应」）；
   *   ② 调主进程 `openSession(id)` —— 它会 dispose 旧会话、装配新的、并把
   *      **恢复出来的正文 + 开场引导**一并回传；
   *   ③ **整段替换**消息列表（`restoreConversation`）—— 不追加：手里那段属于上一条会话。
   *
   * ⚠️ **失败时绝不清空当前对话**：拿不到恢复内容就保持原样 + 给一句可读中文 ——
   *    把学生的屏幕清空、又什么都没恢复出来，是最坏的一种失败。
   * ⚠️ 与「新会话」共用同一个出口（{@link applySwitchResult}）：两条路的回执同形，
   *    各写一份处理就会出现「切会话会清空开场语、新会话不会」这类不对称。
   */
  async function openSession(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    if (!sessionId) return { ok: false, message: '切换会话失败：没有指定会话。' }
    const lookup = resolveSessionBridge()
    if (!lookup.ready) return { ok: false, message: lookup.message }
    return await runSwitch(() => lookup.bridge.openSession(sessionId))
  }

  /**
   * ★ **开始一段全新的对话**（「新会话」按钮的唯一实现）。
   *
   * ★ 它**不动 Pi 的旧会话文件**（旧的那条仍在列表里、随时能切回去）：
   *   新会话 = 开一个新的 JSONL 文件，不是删除。
   */
  async function startNewSession(): Promise<{ ok: boolean; message?: string }> {
    const lookup = resolveSessionBridge()
    if (!lookup.ready) return { ok: false, message: lookup.message }
    return await runSwitch(() => lookup.bridge.startNewSession())
  }

  /**
   * ★★ **从某条消息处重新问**（会话分支的唯一入口）。
   *
   * 学生在读回答时想到「这一句他讲得不对，我换个问法」—— 他要的是**保留原来那条**、
   * 另开一条线接着问。所以这里做的是「复制历史到分叉点 + 切过去」，
   * **原会话一个字节不动**（Pi 在分叉出来的新文件里记 `parentSession` 指回去）。
   *
   * ★ 与「新会话」的区别：新会话是空白开始，分叉**带着分叉点之前的全部历史** ——
   *   它解决的是「改问法」而不是「换话题」。
   * ★ 走的是同一个执行出口（{@link runSwitch}）：回执同形、落库同形
   *   （整段替换消息列表）—— 两条路各写一份就会出现「分叉会清开场语、切会话不会」
   *   这类不对称。
   */
  async function branchSession(entryId: string): Promise<{ ok: boolean; message?: string }> {
    if (!entryId) return { ok: false, message: '重新问失败：没有指定要分叉的那条消息。' }
    // ⚠️ 还没有当前会话时分叉没有意义（分叉点是「本条会话里的某条消息」）
    if (!currentSessionId.value) {
      return { ok: false, message: '重新问失败：当前没有进行中的对话。' }
    }
    const lookup = resolveSessionBridge()
    if (!lookup.ready) return { ok: false, message: lookup.message }
    const sessionId = currentSessionId.value
    return await runSwitch(() => lookup.bridge.branchSession({ sessionId, entryId }))
  }

  /**
   * ★★ **删掉一条历史会话**（`session:delete` 的唯一入口；**不可撤销**）。
   *
   * ★ 与 `startNewSession()` 的区别：那个是「换一条新会话，旧的原样留着」，
   *   这个是**真的把那条会话从盘上删掉**（Pi 的 JSONL 一起）——
   *   所以界面必须先用确认框问一次（`SessionList.vue` 的右键菜单）。
   * ★ 删的是**当前会话**时由**主进程**决定怎么做（先切到一条新的空白会话、成功后才删文件）——
   *   那条顺序纪律在 `handlers.ts` 里，渲染进程不参与（它一次性拿到结果，见
   *   `deleteSessionById` 的注释）。删完当前会话后主进程会推一条 `session:changed`，
   *   界面据此切到新会话。
   * ★★ 失败时**绝不清空当前对话**：与切会话同一条纪律 —— 拿不到结果就保持原样 + 一句可读中文。
   */
  async function deleteSession(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    if (!sessionId) return { ok: false, message: '删除失败：没有指定要删哪条对话。' }
    const lookup = resolveSessionBridge()
    if (!lookup.ready) return { ok: false, message: lookup.message }
    try {
      const result = await lookup.bridge.deleteSession(sessionId)
      if (!result.ok) return { ok: false, message: result.message }
      // ★ 删掉的是**当前那条**：主进程已经切到一条新的空白会话（并带了开场引导），
      //   而这条回执里只有 id —— 补读一次完整状态，界面才跟得上。
      //   不补读的话，屏幕上会留着刚被删掉的那段对话（它已经不在盘上了）。
      if (result.id === currentSessionId.value) {
        resetConversation()
        currentSessionId.value = ''
        currentSessionTitle.value = ''
        currentSessionMessageCount.value = 0
        await applyCurrentSessionState({ replace: true })
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        message: `删除失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /** 切换 / 新建 / 分叉共用的执行与落库（见 {@link openSession} 的三步说明）。 */
  async function runSwitch(
    call: () => Promise<
      | {
          ok: true
          current: { sessionId: string; title: string; messageCount: number }
          messages: Array<{
            role: 'user' | 'assistant'
            text: string
            at: number
            entryId?: string
          }>
          opening: string
          openingKpId: string
          openingKpName: string
        }
      | { ok: false; message: string }
    >
  ): Promise<{ ok: boolean; message?: string }> {
    sessionSwitching.value = true
    try {
      const result = await call()
      if (!result.ok) return { ok: false, message: result.message }
      applySwitchResult(result)
      return { ok: true }
    } catch (error) {
      // IPC 崩了也要出可读中文（绝不把异常抛给组件，那会渲染成一段堆栈文本）
      return {
        ok: false,
        message: `切换会话失败：${error instanceof Error ? error.message : String(error)}`
      }
    } finally {
      sessionSwitching.value = false
    }
  }

  /**
   * ★ 会话切换失败时说一句人话（**唯一写入口**）。
   *
   * 为什么不复用 `localNotice`：那是**对话通道**的提示（发送被拒 / 桥缺失），
   * 而这是**会话切换**的失败。两者的处置不同（一个重发、一个重试切换），
   * 混在一条里会让「切换失败」的提示在下一次发送时被顺手清掉 —— 学生还没读完。
   */
  const sessionNotice = ref<string | null>(null)

  function setSessionNotice(message: string | null): void {
    sessionNotice.value = message
  }

  /** 把一次切换/新建的结果落进状态（**唯一的落点**，见 {@link openSession} 的说明）。 */
  function applySwitchResult(result: {
    current: { sessionId: string; title: string; messageCount: number }
    messages: Array<{
      role: 'user' | 'assistant'
      text: string
      at: number
      /** ★ 条目 id（「从这里重新问」拿它分叉；缺了那条消息就不给按钮）。 */
      entryId?: string
    }>
    opening: string
    openingKpId: string
    openingKpName: string
  }): void {
    currentSessionId.value = result.current.sessionId
    currentSessionTitle.value = result.current.title
    currentSessionMessageCount.value = result.current.messageCount
    // ★ 打上「这一轮回答时系统判出的学段」：历史消息的学段是**当时**的，不是现在的 ——
    //   但我们手里没有「当时」这个值（它没进 JSONL），所以按当前学段标注。
    //   标错比不标更坏，所以历史消息**一律不标**（传 null）。
    // ★★ 历史里的学生消息过一遍 `studentFacingMessages`：JSONL 存的是**发给模型的原文**
    //   （卡片请求里带着内部指令），不翻译的话学生重启后会在气泡里再读到一次（见该函数）。
    conversation.value = restoreConversation(studentFacingMessages(result.messages), null)
    // 清掉与「上一段对话」绑定的临时状态（与新会话同一套清理，见 resetConversation）
    localNotice.value = null
    queuedText.value = null
    queueNotice.value = null
    gradeNotice.value = null
    chapterNotice.value = null
    // ★★ 开场引导：**只在主进程真的给了内容时**才设置。
    //   切换一条已有内容的会话时它是空串 —— 那一侧不显示引导（学生会看到一句
    //   「我们从X开始吧」插在他自己聊过的内容前面，那是明显的错位）。
    opening.value = result.opening
    openingKpId.value = result.openingKpId
    openingKpName.value = result.openingKpName
    openingDismissed.value = false
    clearPlanSession()
    // ★ 清掉超前缓冲：那些条目 id 属于**上一条会话** —— 留着它们会在新会话里
    //   命中同一个 requestId（理论上不会，但那是一个不该存在的巧合依赖）。
    pendingTurnEntries.clear()
    // ★ 显示→wire 的映射同样属于**上一条会话**：清掉，免得同一句显示文本在新会话里
    //   被翻译成上一段对话留下的 wire 文本（而且它本来就没必要跨会话活着）。
    wireTextByDisplay.clear()
  }

  /**
   * 清空界面上这段对话（**纯本地**：不动 Pi 的会话文件）。
   *
   * ★ 它与 `startNewSession()` 是**两件事**，不要混：
   *   - 本函数只清渲染进程手里的显示状态，主进程的会话文件一个字节都不动；
   *   - `startNewSession()` 会 dispose 旧会话、开一个新文件（并回传新会话的状态）。
   *
   * ★ 保留它的理由：状态清理（`applySwitchResult` 与它做同一套事）需要有一个
   *   不依赖 IPC 的纯本地落点 —— 否则「切会话失败」时连界面都清不干净。
   * ★ 清的是什么：轮次、卡片、引用、待发内容、一次性提示、**开场引导**。
   * ★ **不清**什么（有意为之）：学段与章节（它们是学生/系统的设定，不是这段对话的属性）。
   */
  function resetConversation(): void {
    conversation.value = emptyConversation()
    localNotice.value = null
    gradeNotice.value = null
    chapterNotice.value = null
    // 排队的那条一并清掉：新会话是「从头开始」，把上一段对话的待发内容带过来会很怪
    queuedText.value = null
    queueNotice.value = null
    // ★ 开场引导也要清：留着它的话，切到一条空会话时上一条的开场语会继续挂着 ——
    //   而它说的那个知识点可能已经不是现在这条会话要学的了。
    opening.value = ''
    openingKpId.value = ''
    openingKpName.value = ''
    openingDismissed.value = false
    clearPlanSession()
    // ★ 清掉「显示 → wire」映射（与 `applySwitchResult` 同一条纪律：它是本地翻译表，
    //   属于这段对话；留着会让同一句显示文本被翻译成上一段对话的 wire 文本）。
    wireTextByDisplay.clear()
  }

  /**
   * 订上学段推送（幂等；缺通道时只记原因，不抛异常）。
   *
   * 主进程推什么就显示什么 —— 渲染进程**不做第二套判定**。
   */
  function connectGrade(): void {
    if (unsubscribeGrade !== null) return
    const lookup = resolveGradeBridge()
    if (!lookup.ready) {
      gradeBridgeError.value = lookup.message
      return
    }
    gradeBridgeError.value = null

    try {
      unsubscribeGrade = lookup.bridge.onGradeChanged((raw) => {
        applyGradeState(raw)
      })
    } catch (error) {
      gradeBridgeError.value = `学段推送订阅失败：${error instanceof Error ? error.message : String(error)}`
      return
    }

    // 初始值（可选能力）：拿不到就等推送，不报错
    void lookup.bridge.getGrade?.().then(
      (result) => {
        if (result.ok) applyGradeState(result.data)
      },
      () => {
        /* 拉取失败不影响推送路径 */
      }
    )
  }

  /**
   * 应用一条学段状态（纯折叠 + 一次性提示）。
   *
   * ★ **`inferred` 与 `explicit` 都上屏**，原因不同但都要显示：
   *   - `inferred` = 系统真的判出来了（学生该感知到「它在适配我」）；
   *   - `explicit` = 学生自己选的（他刚点完，界面必须**当场**反映出来，否则等于没生效）。
   *   只有 `default`（冷启动默认值）不上屏 —— 用默认值冒充判定结果是在骗演示。
   *
   * ★ **只有 `inferred` 给 `gradeAdaptNotice`**（「我按X的说法来讲」）：那句话的主语是系统。
   *   学生手动选完时若也推这句，等于告诉他「是系统替你改的」，来源就说反了；
   *   手动那条回执由 {@link setGrade} 给（「已按你选的…」）。这也意味着：
   *   手动选完紧接着收到主进程推来的 `explicit`，**不会**覆盖掉刚给的手动回执。
   *
   * ★ 提示只在「显示出来的学段真的变了」时给：初次收到 `default` 不算变化，
   *   第一次判定成功（`default` → `inferred`）与后续改判都算 —— 这正是学生该感知的时刻。
   */
  function applyGradeState(raw: unknown): void {
    const next = normalizeGradeState(raw)
    if (next === null) return

    // ★ 冷启动默认值**整条**丢掉（不只丢学段名，也不写 `gradeOrigin`）：
    //   `gradeOrigin` 的含义是「这个学段是怎么定下来的」。还没定下来的时候往里写
    //   `default`，会让来源标签悄悄变成判定结果 —— 学生刚手动选完时，
    //   一条过期的冷启动推送就能把他那句「手动选中」顶掉（同一个谎，换了个字段）。
    //
    // ★★ 2026-09-21（D-066）：判过的态从两种变四种 ——
    //   `rules`（本地规则判定）/ `llm`（AI 引擎判定）/ `inferred`（历史值= rules）/
    //   `explicit`（手动选中）。**都要放行**，否则「本地规则判定」这条推送会被整条丢掉，
    //   界面永远停在「待判定」，学生看不出系统到底判了没有。
    const accepted: GradeOrigin[] = ['rules', 'llm', 'inferred', 'explicit']
    if (!accepted.includes(next.origin)) return

    const previous = currentGrade.value
    gradeOrigin.value = next.origin
    currentGrade.value = next.gradeLevel

    // ★★ 学段真的变了 → **真去读一次**章节（服务端在学段变更时把 `current_chapter` 清空）。
    //   为什么不能在这里直接 `currentChapter.value = ''`：那是渲染进程在猜服务端的规则
    //   （清空是「学段变更」的副作用，而不是「学段变了」这条状态本身）。
    //   照抄的后果：学生先自己选回同一个学段时，界面会把他已选的章节凭空抹掉 ——
    //   服务端那条「重复确认同一学段不清章节」的分支本来是对的，界面却先撒了谎。
    //   ⚠️ 重取**不做本地比较**：`applyGradeState` 有两条来路（推送 + 初始 `getGrade()`），
    //      「上一条我收到的是不是同一个学段」判断不准；服务端才是章节状态的唯一来源。
    if (previous !== next.gradeLevel) {
      void refreshChapter()
    }

    // ★ 只有**系统判出来的**（规则或 LLM）才给那句「我按XX的说法来讲」，
    //   而且只在学段真的变了时给 —— 学生自己刚选完有更贴切的回执（见 `setGrade`）。
    if (
      (next.origin === 'rules' || next.origin === 'llm' || next.origin === 'inferred') &&
      previous !== next.gradeLevel
    ) {
      gradeNotice.value = gradeAdaptNotice(next.gradeLevel)
    }
  }

  /**
   * ★ 学生手动切换学段（唯一的人工写入口）。
   *
   * 为什么前端不算、不推断：前端只传「学生选了什么」，生效逻辑全在服务端
   * （`rules.override_level` 原子写 student.grade_level + grade_history(source="explicit")），
   * 再由主进程把结果推回来。前端自己改本地状态会让界面上显示的学段与库里不一致。
   *
   * ★ 走 `window.api.setGrade()`（preload 白名单），**绝不混进 `ChatSendRequest`**。
   * ★ 失败**不抛**、不写本地状态：返回一句可读中文，由调用方展示（与 settings store 同口径）。
   */
  async function setGrade(level: GradeLevel): Promise<{ ok: boolean; message?: string }> {
    const lookup = resolveGradeBridge()
    if (!lookup.ready) return { ok: false, message: lookup.message }
    // ★ 缺 `setGrade` 是「这条线还没接」，不是「学段整个不可用」：单独一句说明，
    //   否则学生会以为系统的自动判定也坏了（那只读那部分其实好着）。
    if (typeof lookup.bridge.setGrade !== 'function') {
      return { ok: false, message: GRADE_SET_MISSING_HINT }
    }

    try {
      const result = await lookup.bridge.setGrade(level)
      if (!result.ok) return { ok: false, message: result.message }

      // ★ 成功才动本地状态：服务端已经写了库，这里只是把它显示出来。
      //   `gradeNotice` 先赋新值 —— 它是一次性提示，天然覆盖掉旧的自动提示；
      //   手动切换必须让学生**当场看到生效**，否则他点完不知道有没有成功。
      currentGrade.value = level
      gradeOrigin.value = 'explicit'
      gradeNotice.value = gradeManualNotice(level)
      gradeBridgeError.value = null
      return { ok: true }
    } catch (error) {
      // ★ IPC 崩了也要出可读中文（绝不把异常抛给组件，那会渲染成一段堆栈文本）
      return {
        ok: false,
        message: `设定学段失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /* ------------------------------------------------------------ 教材章节 */

  /**
   * 订上章节推送（幂等；缺通道时只记原因，不抛异常）。
   *
   * 主进程推什么就显示什么 —— 渲染进程不做第二套判定，也不自己清章节。
   */
  function connectChapter(): void {
    if (unsubscribeChapter !== null) return
    const lookup = resolveChapterBridge()
    if (!lookup.ready) {
      chapterBridgeError.value = lookup.message
      return
    }
    chapterBridgeError.value = null

    try {
      unsubscribeChapter = lookup.bridge.onChapterChanged((raw) => {
        applyChapterState(raw)
      })
    } catch (error) {
      chapterBridgeError.value = `章节推送订阅失败：${error instanceof Error ? error.message : String(error)}`
      return
    }

    // 初始值（可选能力）：拿不到就等推送，不报错
    if (typeof lookup.bridge.getChapter === 'function') {
      void lookup.bridge.getChapter().then(
        (result) => {
          if (result.ok) applyChapterState(result.data)
        },
        () => {
          /* 拉取失败不影响推送路径 */
        }
      )
    }
  }

  /**
   * 应用一条章节状态（纯折叠 + 「被清空」时的一次性提示）。
   *
   * ★ 提示只在**从有到无**时给：那一下不是学生的动作（学段变了，服务端清了章节），
   *   学生看到「正在学：第4章…」突然不见了，不说一声就是「东西自己没了」。
   *   学生自己选「不限章节」时不该推这句 —— 那是他刚做的选择，回执由 {@link setChapter} 给。
   */
  function applyChapterState(raw: unknown): void {
    const next = normalizeChapterState(raw)
    if (next === null) return
    const hadChapter = currentChapter.value !== ''
    currentChapter.value = next.chapterTitle
    // 只在「从有到无」时给那句话（学生自己选「不限章节」时不该报「被清空了」——
    // 那是他刚做的选择，回执由 setChapter 给）
    if (hadChapter && next.chapterTitle === '') {
      chapterNotice.value = '学段变了，之前选的教材章节已清空。可以重新选一章，或直接自由问答。'
    }
  }

  /**
   * ★ 重新读一次当前章节（学段变化后调；也可由界面在需要时主动调）。
   *
   * ★ **不做本地比较**：判断「章节到底变没变」是服务端的事（同 `applyChapterState` 的注释）。
   *   失败**不抛异常**、也算不上「出了错」—— 章节只是软偏好，抓不到就不显示，
   *   对话照常（与「画像抓不到就用空块」同一条纪律）。
   */
  async function refreshChapter(): Promise<void> {
    const lookup = resolveChapterBridge()
    if (!lookup.ready) {
      chapterBridgeError.value = lookup.message
      return
    }
    if (typeof lookup.bridge.getChapter !== 'function') return
    try {
      const result = await lookup.bridge.getChapter()
      if (result.ok) applyChapterState(result.data)
    } catch {
      /* 读不到就保持现状，不阻断对话 */
    }
  }

  /**
   * ★ 学生显式选择章节（**唯一的人工写入口**，空串 = 回到「不限章节，自由问答」）。
   *
   * 为什么前端不算、不推断：前端只传「学生选了什么」，生效逻辑全在服务端
   * （写 `learning.db` 的 `student.current_chapter`），章节的软偏好进 Prompt 也在主进程侧。
   * ★ 走 `window.api.setChapter()`（preload 白名单），**绝不混进 `ChatSendRequest`**。
   * ★ 失败**不抛**、不写本地状态：返回一句可读中文，由调用方展示（与 {@link setGrade} 同口径）。
   */
  async function setChapter(chapterTitle: string): Promise<{ ok: boolean; message?: string }> {
    const lookup = resolveChapterBridge()
    if (!lookup.ready) return { ok: false, message: lookup.message }
    // ★ 缺 `setChapter` 是「这条线还没接」，不是「章节整个不可用」：单独一句说明，
    //   否则学生会以为指示器上那行「正在学：…」也坏了（那只读那部分其实好着）。
    if (typeof lookup.bridge.setChapter !== 'function') {
      return { ok: false, message: CHAPTER_SET_MISSING_HINT }
    }

    try {
      const result = await lookup.bridge.setChapter(chapterTitle)
      if (!result.ok) return { ok: false, message: result.message }

      // ★ 成功才动本地状态：服务端已经写了库，这里只是把它显示出来（与 setGrade 同一条纪律）。
      currentChapter.value = result.data.chapterTitle
      chapterNotice.value = null
      chapterBridgeError.value = null
      return { ok: true }
    } catch (error) {
      // ★ IPC 崩了也要出可读中文（绝不把异常抛给组件，那会渲染成一段堆栈文本）
      return {
        ok: false,
        message: `设定章节失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /**
   * ★★ 「学生看到的那一句 → 真正发给模型的那一段」的**渲染进程本地**映射。
   *
   * 为什么需要它（评审抓到的缺陷）：卡片发起的求助/运行请求，正文里必须写着
   * 「请用 get_coding_hint」「不要直接给我完整答案」这类**写给模型的指令**
   * （模型靠它才选对 Tool）；而 `ChatSendRequest` 只有 `text` 一个字段（守卫 G6c），
   * 于是那段文本必然原样变成**学生自己的气泡内容** —— 底牌亮给了学生。
   * 解法：把「显示」与「wire」在**渲染进程内部**分开承载，契约与 IPC 一个字段都不动。
   *
   * ★ 方向是「显示 → wire」而不是反过来：排队条、取消排队还回输入框、气泡三处
   *   读到的都是**显示文本**，于是三处都不会漏出内部指令。
   * ★ 只由卡片发起的消息写入；学生自己打的字（显示 = wire）不进表。
   * ★ 代价（明说）：**排队**那条消息的 wire 文本会在表里留一条 —— 学生取消排队时它
   *   不会被清掉（最多留 32 条，同一条显示文本下次发送会覆盖它）。它不构成泄漏
   *   （表只增不减地记着"这句话发给模型时该长什么样"），所以不做额外清理。
   */
  const wireTextByDisplay = new Map<string, string>()
  /** 映射表的容量上限（与 `pendingTurnEntries` 同量级）：防伪造调用把它撑成泄漏。 */
  const WIRE_TEXT_MAP_LIMIT = 32

  function rememberWireText(display: string, wire: string): void {
    if (wire === display) return
    if (wireTextByDisplay.size >= WIRE_TEXT_MAP_LIMIT) {
      const oldest = wireTextByDisplay.keys().next().value
      if (oldest !== undefined) wireTextByDisplay.delete(oldest)
    }
    wireTextByDisplay.set(display, wire)
  }

  /** 取这次要发给模型的文本（没登记过就是显示文本本身）。 */
  function wireTextFor(display: string): string {
    return wireTextByDisplay.get(display) ?? display
  }

  /**
   * ★★ **回看历史**时把「卡片写给模型的内部指令」还原成学生语言。
   *
   * 为什么回看这条路也要管：Pi 的 JSONL 里存的是**发给模型的原文**（它本来就该存原文），
   * 所以不翻译的话，学生重启应用后会在自己的气泡里**再一次**读到那段内部指令 ——
   * 与实时路径上被修掉的是同一个缺陷。渲染进程显示前过一遍翻译即可关掉它，
   * 磁盘上的会话文件一个字不动（模型续聊时仍看到完整原文）。
   * ★ 两个卡片模块各管自己的消息格式（`codingUserTextDisplay` / `quizUserTextDisplay`），
   *   这里只做分发 —— 文案格式跟着它的产出者走，不集中抄一份。
   * ★ 只动 `role === 'user'`，且两个翻译都只认本应用自己的前缀：
   *   认不出一律原样返回 —— 绝不改写学生自己打的字。
   */
  function studentFacingUserText(text: string): string {
    const coding = codingUserTextDisplay(text)
    if (coding !== text) return coding
    const quiz = quizUserTextDisplay(text)
    if (quiz !== text) return quiz
    // ★ 计划请求（含「现在考考我」那条）与两个卡片模块走同一条分发链：三者都只认自己的
    //   前缀，认不出一律原样返回 —— 绝不改写学生自己打的字。
    return planUserTextDisplay(text)
  }

  function studentFacingMessages<T extends { role: 'user' | 'assistant'; text: string }>(
    messages: readonly T[]
  ): T[] {
    return messages.map((message) =>
      message.role === 'user' ? { ...message, text: studentFacingUserText(message.text) } : message
    )
  }

  /**
   * 发一轮对话：本地先落学生消息，拿到 `requestId` 后建立本轮（事件可能已在前头到达，会被回放）。
   *
   * ★★ 两个参数是这件事的全部要点（也决定了它为什么长这样）：
   *   - `rawText` = **显示文本**：学生气泡里出现的那一句，也是排队条里、
   *     取消排队还回输入框时看到的那一句；
   *   - `wireText`（可选）= **真正发给模型的那一段**，缺省 = 显示文本。
   *   卡片发起的消息必须同时给两个（见 `wireTextByDisplay` 的说明）；普通打字只给一个。
   *   ⚠️ 第二个参数**刻意做成位置参数、而不是可选属性的参数对象**：
   *   `desktop/tests/ux-queue-and-scroll.test.ts` 用「按花括号配平取本函数函数体」的
   *   源码级守卫钉住忙时排队行为，而参数里的 `{` 会先于函数体出现，
   *   让那个守卫切出来的是一段极短的文本（守卫会假红）。改签名前先看那条守卫。
   *
   * ★ **忙的时候不再静默丢弃**（见 {@link queuedText}）：回答还在生成时再次发送 = 排队，
   *   并立刻给出可见反馈（输入框清空 + 界面上出现「待发送」条）。
   */
  async function send(rawText: string, wireText?: string): Promise<void> {
    const text = rawText.trim()
    if (text.length === 0) return

    // wire 文本：卡片发起的消息登记一次，之后（含排队后自动发出那一次）都按显示文本取回
    const explicitWire = wireText?.trim()
    if (explicitWire !== undefined && explicitWire.length > 0) rememberWireText(text, explicitWire)
    const outgoing =
      explicitWire !== undefined && explicitWire.length > 0 ? explicitWire : wireTextFor(text)

    // ★★ 演示沙箱：这一句**不进主进程**，由本机脚本接手（见 `stores/demoSeed.ts`）。
    //    学生打什么都会被「吃掉」，屏幕上出现的是脚本里那句 —— 现场演示不可能每次都把
    //    三句话原样打对，而脚本必须稳定（这是「像真的用过」与「像在放录像」的分界）。
    //
    //    ⚠️⚠️ 位置必须在下面那个 `if (streaming.value)` **之前**（实测踩到）：
    //       放到它之后的话，脚本一轮还在放时按发送会走「忙时排队」分支 ——
    //       而脚本轮次的事件**不经过 IPC 订阅**，那条排队永远不会被自动发出，
    //       屏上会一直挂着一条「待发送」并且**显示的是演示者打的字**（不是脚本那句）。
    //       放在前面：脚本态下一律吃掉，正在放时就只是吸收掉这一次按键（不打断这一轮）。
    //    ⚠️ 分支里**不写**「清空本地提示」那一行：`ux-queue-and-scroll` 的源码切片
    //       以它为终点，在本分支里再出现一次会把切片切空（**这里连它的字面量都不能写**，
    //       因为那条切片取的是全文第一处出现）。
    //    ⚠️ store **懒取**（不在文件顶层拿一次）：`demoSeed.ts` 也要取本 store
    //       （回放时往对话里投事件），两处互相引用时在动作内部再取一次是 Pinia
    //       允许的安全做法 —— 顶层拿会落在两个模块求值的循环上。
    if (useDemoSeedStore().seeded) {
      // 返回 `false` = 这一轮脚本正在放（`advance()` 自己会拒绝重入），那就只吸收这次按键
      useDemoSeedStore().advance()
      draft.value = ''
      return
    }

    // ★ 正在回答：**排队**而不是丢掉。旧实现这里直接 `return` —— 学生按了回车却什么都没发生，
    //   只会以为键盘坏了（`scripts/ux-probe-busy-send.mjs` 实测）。
    if (streaming.value) {
      // 已有排队内容 = 这一条把它替换掉了。**必须说出来**：
      // 静默替换等于把学生刚敲的字扔掉，而他以为两条都排上了。
      if (queuedText.value !== null && queuedText.value !== text) {
        const shown = queuedText.value.length > 18 ? `${queuedText.value.slice(0, 18)}…` : queuedText.value
        queueNotice.value = `上一条待发内容「${shown}」已被这一条替换（只保留最新一条）。`
      } else {
        queueNotice.value = null
      }
      queuedText.value = text
      // 清空输入框：字已经**被接收**了（在排队条里看得见），
      // 留在框里会让人以为没发出去而重复按。
      draft.value = ''
      return
    }

    localNotice.value = null
    queueNotice.value = null
    gradeNotice.value = null
    // ★ 章节的「被清空」提示与学段提示同一口径：**下一个问题发出时清掉**（一次性）。
    chapterNotice.value = null
    // ★★ 学生开口了 → 主动发起的开场引导**立刻收起**（见 `opening` 的说明）：
    //   他是用「回一句」回应它的，收起就是「这条引导已经被接住了」。
    //   收起（而不是删除）是刻意的：那段文本已经写进 Pi 会话，删掉本地这一份会让
    //   界面与历史记录不一致（重启后它又冒出来）。
    openingDismissed.value = true

    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      // 同 `connect()`：屏幕学生话 + 控制台接线细节（这条是「发送」那条线缺了）
      warnWiring(
        'chat.send',
        'window.api 缺失：preload 没有加载（sendChat 那条 invoke 通道不可用，这一句发不出去）。检查 preload 入口与 contextIsolation / sandbox 配置。'
      )
      localNotice.value = '这句话没能发出去。可以再试一次，还不行就请老师帮忙看看。'
      return
    }

    // ★★ 认领「学习计划 / 练习检验」轮（见 planKpId 的说明）：判据是**真正发给模型的那段**
    //    （不是显示文本 —— 学生气泡里那句「我想学「循环结构」…」没有内部编号）。
    //    ⚠️ 位置必须在忙时排队之后：排队那条这一轮不发，等它被自动补发时再认领；
    //    补发只带一个参数，wire 文本由 `wireTextFor` 从本地映射表取回，所以判据落在
    //    `outgoing` 上不会漏。
    const planClaim = parsePlanRequest(outgoing)
    if (planClaim !== null) {
      planKpId.value = planClaim.kpId
      planKpName.value = planClaim.kpName
      // 新的一份计划还没讲完 —— 巩固条先收起来，讲完了才挂（见 settlePlanTurn）。
      planReady.value = false
    }

    // ★ 这一轮用的学段由**服务端**决定（自动判定 / 学生已手动选定的那把值）：
    //   这里只是把「当前生效的学段」记在轮次上，供界面标注；轮次标注**不是**学段的写入路径。
    const gradeAtSend = currentGrade.value

    try {
      // ★ 不传学段：`ChatSendRequest` 里没有 `gradeLevel`。为什么手动学段也不能从这里走 ——
      //   那样「发一条消息」会顺带写一次学段（重发同一句话、清空重打都会再写一遍），
      //   而且没有回执告诉学生冷却还剩几轮（`grade:set` 才有）。
      // ★ 发出去的是 **wire 文本**（卡片消息里带着写给模型的指令）；
      //   落到轮次上的是**显示文本**（学生气泡里那一句）—— 两者只在这里分开一次。
      const result = await window.api.sendChat({ text: outgoing })
      if (!result.ok) {
        localNotice.value = result.message
        return
      }
      conversation.value = startTurn(conversation.value, result.requestId, text, gradeAtSend)
      // ★ 认领的计划轮到这里才拿到 requestId —— 记下它，终态（done / error）才有人认。
      //   建轮时 `startTurn` 会回放已经超前到达的事件，所以建完立刻核对一次：
      //   这一轮完全可能在回执回来之前就已经讲完了。
      if (planClaim !== null) {
        planRequestId = result.requestId
        settlePlanTurn()
      }
      // ★ 补上可能超前到达的条目 id（见 `pendingTurnEntries`）
      const buffered = pendingTurnEntries.get(result.requestId)
      if (buffered) {
        pendingTurnEntries.delete(result.requestId)
        applyTurnEntries(result.requestId, buffered.userEntryId, buffered.entryId)
      }
    } catch (error) {
      localNotice.value = `发送失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /* ------------------------------------------------------------ 演示沙箱（脚本轮次） */

  /**
   * 演示沙箱：开一轮（学生那条 + 一个空的助手气泡）。`requestId` 由 `stores/demoSeed.ts` 生成。
   *
   * ★ 与真实轮次**共用同一个建轮出口**（`startTurn`）：气泡样式、滚动、「正在回答」的
   *   判定都只看 `ChatTurn`，所以本机脚本造出来的这一轮与真的那轮在界面上完全同形。
   * ★ 三种 id（`entryId` / `userEntryId` / `messageId`）**恒为空**：脚本轮次一个字节都没写进
   *   会话文件，因此它**不能**作为分叉点、也不该被当成一条真实记录 ——
   *   与历史回看用 `restored-` 前缀是同一条纪律（见 `api/events.ts` 的说明）。
   */
  function beginScriptedTurn(requestId: string, studentText: string): void {
    conversation.value = startTurn(conversation.value, requestId, studentText, currentGrade.value)
  }

  /**
   * 演示沙箱：把一条事件投进对话状态（复用真实的事件折叠，不另写一套）。
   *
   * ★★ 走的是 {@link applyChatEvent} —— 与 live 路径**同一批** reducer：正文逐字、引用与
   *   降级档位、卡片、`done` 的收尾全部在这里折叠。于是卡片 / 引用 / 正文的渲染路径与
   *   真实轮次**完全相同**（不存在「预置内容的卡片长得不一样」这种事）。
   * ★ 调用方（`stores/demoSeed.ts`）只负责「什么时候投哪条」，投进去之后怎么折叠归这里。
   */
  function pushScriptedEvent(event: IpcEvent): void {
    conversation.value = applyChatEvent(conversation.value, event)
  }

  /**
   * 练习卡片提交作答（票 14 的前端一半）。
   *
   * ★ **前端不判分**：这里只把「题目编号 + 学生的作答」说清楚，交给主 Agent 调 `submit_quiz`，
   *   判分与掌握度更新都在 Python 侧（§6.3 答案泄漏防护）。渲染进程拿不到答案，也不需要。
   * ★★ **两个文本分开给**（与编程卡片同一条纪律）：气泡里显示
   *   `quizSubmissionDisplayText`（不含"请用 submit_quiz…"那句写给模型的指令），
   *   发给模型的是 `buildQuizSubmissionMessage`（正文 + 指令，逐字节与原来一致）。
   */
  async function submitQuizAnswer(question: { qid: string; stem: string }, answer: string): Promise<void> {
    await send(quizSubmissionDisplayText(question, answer), buildQuizSubmissionMessage(question, answer))
  }

  /**
   * ★ 把一句**预填的提问**交给输入框并切回对话页（学习档案里的「去练一练」用）。
   *
   * 为什么是「预填 + 学生自己按发送」而不是直接 `send()`：
   *   - 主动替学生发消息会直接消耗一次云端调用，而学生可能只是想看看那句话对不对；
   *   - 学生看得见自己要问什么，才有机会补一句「我想练简单的」——
   *     这对一个教学助手比「一键自动开始」更贴合。
   *
   * ★ **绝不绕过 `send()` 的校验**：草稿只是填进输入框，走的还是那条通道
   *   （`ChatSendRequest` 只有 `text`，学段/身份都不从这里走）。
   *
   * ★ 这里**不改视图**：切视图是 `stores/ui.ts` 的事，调用方（错题本分页）
   *   两件事一起做。本函数只管草稿，这样它就不依赖 UI 状态（更好测、更少耦合）。
   *
   * ★★ 2026-09-30 用户裁决：学习地图 / 依赖图两处「开始学习」**改成直发**（见 `send()`
   *   与两个 goLearn），因为那两个入口要的就是「现在讲这一个」，预填还要学生再按一次；
   *   **错题本的「去练一练」仍保持预填** —— 那不是同一件事：从错题本来的时候学生还没想好
   *   要练哪一题，让他先看见那句话、再补一句「我想练简单的」仍然是对的。
   */
  function prepareQuestion(text: string): void {
    draft.value = text
  }

  return {
    conversation,
    turns,
    streaming,
    /* ── 会话（切换 / 新建）────────────────────────────────────────────── */
    /** 当前会话 id（`''` = 还没有会话；列表据此高亮）。 */
    currentSessionId,
    /** 当前会话标题（主进程给；空串 = 还没内容）。 */
    currentSessionTitle,
    /** 当前会话的消息条数（侧栏据此决定要不要重取列表）。 */
    currentSessionMessageCount,
    /** 切换/新建进行中（界面据此显示「正在打开…」并禁用列表）。 */
    sessionSwitching,
    /** 会话通道不可用时的可读说明。 */
    sessionBridgeError,
    /** 切换/新建失败的提示（与 `localNotice` 分开，见 {@link setSessionNotice}）。 */
    sessionNotice,
    /** 写会话切换的提示（`null` = 清掉）。 */
    setSessionNotice,
    /** ★ 打开一条历史会话继续聊（只接受会话 id）。 */
    openSession,
    /** ★ 开始一段全新的对话（旧会话仍在列表里）。 */
    startNewSession,
    /** ★★ 从某条消息处重新问（分叉出新会话，原会话不动）。 */
    branchSession,
    /** ★★ 删掉一条历史会话（**不可撤销**；删的是当前会话时主进程会先切到新会话）。 */
    deleteSession,
    /* ── 主动发起对话（开场引导）───────────────────────────────────────── */
    /** AI 主动说的第一句（空串 = 这次没有引导）。 */
    opening,
    /** 引导指向的知识点（空串 = 界面不渲染动作按钮）。 */
    openingKpId,
    /** 那个知识点的中文名（动作按钮的预填文案用它；D-074）。 */
    openingKpName,
    /** 该不该显示它（有内容且学生还没回应过）。 */
    showOpening,
    /** 学生接受了引导（收起它；真正的提问由组件发起）。 */
    acceptOpening,
    /** 回答还在生成时学生又发的那一条（`null` = 没有排队）。 */
    queuedText,
    /** 排队相关的可读说明（连按两次发送时的「已被替换」提示；一次性）。 */
    queueNotice,
    /** 学生主动取消排队（内容还回输入框）。 */
    cancelQueued,
    cards,
    /** 最近一轮检索的降级档位（右栏四级链据此点亮；`null` = 至今没检索过）。 */
    lastCitationDegraded,
    /** 按 chunkId 索引的引用细节（「教材原文」抽屉据此查全文）。 */
    citationDetails,
    /** 取某个引用 chunk 的详情；拿不到回 `null`（界面据此说「原文暂时取不到」）。 */
    citationDetailOf,
    bridgeReady,
    localNotice,
    draft,
    prepareQuestion,
    currentGrade,
    currentGradeLabel,
    gradeOrigin,
    gradeNotice,
    gradeBridgeError,
    currentChapter,
    chapterNotice,
    chapterBridgeError,
    quizResults,
    connect,
    connectGrade,
    connectChapter,
    disconnect,
    /** 清界面上的这段对话（学段/章节与 Pi 的后端会话都不动；调用方先确认）。 */
    resetConversation,
    /** ★ 唯一的人工写入口：学生手动指定学段（走 `grade:set`，不碰对话请求）。 */
    setGrade,
    /** ★ 唯一的人工写入口：学生选择当前教材章节（走 `chapter:set`，不碰对话请求）。 */
    setChapter,
    /** 重新读一次当前章节（学段变化后由 store 自己调；不抛异常）。 */
    refreshChapter,
    send,
    /* ── 学习计划的巩固条（2026-09-30 裁决那两个「开始学习」入口）────────── */
    /** 刚才讲的那个知识点（巩固条的两条路都要它；空串 = 没有可练的目标）。 */
    planKpId,
    /** 那个知识点的中文名（空串 = 名字取不到，按钮文案走通用句）。 */
    planKpName,
    /** 计划讲完了没有（只有终态 `done` 才置真；见 {@link planKpId} 的说明）。 */
    planReady,
    /* ── 演示沙箱（本机脚本轮次；见 stores/demoSeed.ts）────────────────── */
    /** ★ 开一轮脚本轮次（学生那条 + 助手气泡；三种 id 恒空，不能当分叉点）。 */
    beginScriptedTurn,
    /** ★ 把一条脚本事件投进对话状态（复用真实的事件折叠，不另写一套）。 */
    pushScriptedEvent,
    submitQuizAnswer,
    /* ── 回看历史的译文（**唯一的实现**，别再写第二份）────────────────── */
    /**
     * ★★ 把一条**用户消息**的 wire 原文翻成学生能读的那一版。
     *
     * 为什么必须共享：同样的翻译在**三条**回看路径上都需要 ——
     *   ① 对话页切换/恢复会话（本 store 内部，已在用）；
     *   ② 学习档案 →「历史会话」页里点开回看（`study/SessionsTab.vue`）；
     *   ③ 将来任何「把历史正文渲染出来」的地方。
     * ② 曾经漏掉：那条路直接渲染主进程项目的 `message.text`（= JSONL 里的 wire 原文），
     * 于是学生在**档案页**又能读到 `题目编号：gen-ai-definition-jr-…` 与
     * 「请用 submit_quiz 提交批改」那句内部指令 —— 实时路径与对话页都挡住了，
     * 只有这条路漏着。现在导出这一个函数，谁渲染历史谁调它。
     * ★ 只动用户消息；两个卡片模块各认自己的前缀，认不出一律原样返回。
     */
    studentFacingUserText
  }
})
