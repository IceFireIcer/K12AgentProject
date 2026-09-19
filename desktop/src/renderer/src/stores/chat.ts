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
import type { CitationDetail, Degraded, GradeLevel } from '@shared/ipc-events'
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
import { buildQuizSubmissionMessage, collectQuizResults, type QuizResultView } from '../cards/quiz'
import {
  applyChatEvent,
  emptyConversation,
  startTurn,
  subscribeToChatEvents,
  type ConversationState,
  type InlineCard
} from '../api/events'

export const useChatStore = defineStore('chat', () => {
  const conversation = ref<ConversationState>(emptyConversation())
  const bridgeReady = ref(true)
  /** 本地提示（桥接缺失、发送被拒等），不是 6 事件里的 `error`。 */
  const localNotice = ref<string | null>(null)
  /**
   * 当前学段：`null` = 系统还没判出来、学生也还没选过。
   *
   * ★ 只认「有依据」的两态：`inferred`（系统判过）与 `explicit`（学生选的）。
   *   冷启动默认值（`default`）不是判定结果，也不是学生的选择 ——
   *   拿它上屏等于用默认值冒充一个结论（在演示里就是撒谎）。
   */
  const currentGrade = ref<GradeLevel | null>(null)
  /** 学段来源（三态；`null` = 还没收到任何推送）。 */
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
    if (unsubscribe !== null) return
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      localNotice.value = '预加载脚本未生效（window.api 缺失），对话通道不可用。'
      return
    }
    bridgeReady.value = true
    unsubscribe = subscribeToChatEvents(window.api, (event) => {
      const wasStreaming = streaming.value
      conversation.value = applyChatEvent(conversation.value, event)

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
  }

  /**
   * 开一段新会话：**只清界面上的这一份**。
   *
   * ★ 清的是什么：渲染进程手里这段对话的显示状态（轮次、卡片、引用）。
   * ★ **不清**什么（有意为之）：学段与章节（它们是学生/系统的设定，不是这段对话的属性）、
   *   也已经**不动 Pi 那一侧的会话**（它按 `sessionId` 落在该学生的 JSONL 里，
   *   学习档案的「历史会话」照样能回看 —— 界面清空 ≠ 记录删除）。
   *   「切一条新会话」要 dispose 当前 runtime 并处理代际竞态，是另一件事。
   * ★ 调用方负责先确认（清空不可撤销，见 `views/Chat.vue` 的 `newSession`）。
   */
  function resetConversation(): void {
    conversation.value = emptyConversation()
    localNotice.value = null
    gradeNotice.value = null
    chapterNotice.value = null
    // 排队的那条一并清掉：新会话是「从头开始」，把上一段对话的待发内容带过来会很怪
    queuedText.value = null
    queueNotice.value = null
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
    //   `default`，会让来源标签悄悄变成「AI 引擎推算」—— 学生刚手动选完时，
    //   一条过期的冷启动推送就能把他那句「手动选中」顶掉（同一个谎，换了个字段）。
    if (next.origin !== 'inferred' && next.origin !== 'explicit') return

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

    if (next.origin === 'inferred' && previous !== next.gradeLevel) {
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
      chapterNotice.value = '学段变了，之前选的教材章节已清空 —— 可以重新选一章，或直接自由问答。'
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
   * 发一轮对话：本地先落学生消息，拿到 `requestId` 后建立本轮（事件可能已在前头到达，会被回放）。
   *
   * ★ **忙的时候不再静默丢弃**（见 {@link queuedText}）：回答还在生成时再次发送 = 排队，
   *   并立刻给出可见反馈（输入框清空 + 界面上出现「待发送」条）。
   */
  async function send(rawText: string): Promise<void> {
    const text = rawText.trim()
    if (text.length === 0) return

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
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      localNotice.value = '预加载脚本未生效（window.api 缺失），无法发送。'
      return
    }

    // ★ 这一轮用的学段由**服务端**决定（自动判定 / 学生已手动选定的那把值）：
    //   这里只是把「当前生效的学段」记在轮次上，供界面标注；轮次标注**不是**学段的写入路径。
    const gradeAtSend = currentGrade.value

    try {
      // ★ 不传学段：`ChatSendRequest` 里没有 `gradeLevel`。为什么手动学段也不能从这里走 ——
      //   那样「发一条消息」会顺带写一次学段（重发同一句话、清空重打都会再写一遍），
      //   而且没有回执告诉学生冷却还剩几轮（`grade:set` 才有）。
      const result = await window.api.sendChat({ text })
      if (!result.ok) {
        localNotice.value = result.message
        return
      }
      conversation.value = startTurn(conversation.value, result.requestId, text, gradeAtSend)
    } catch (error) {
      localNotice.value = `发送失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 练习卡片提交作答（票 14 的前端一半）。
   *
   * ★ **前端不判分**：这里只把「题目编号 + 学生的作答」说清楚，交给主 Agent 调 `submit_quiz`，
   *   判分与掌握度更新都在 Python 侧（§6.3 答案泄漏防护）。渲染进程拿不到答案，也不需要。
   */
  async function submitQuizAnswer(question: { qid: string; stem: string }, answer: string): Promise<void> {
    await send(buildQuizSubmissionMessage(question, answer))
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
   */
  function prepareQuestion(text: string): void {
    draft.value = text
  }

  return {
    conversation,
    turns,
    streaming,
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
    submitQuizAnswer
  }
})
