/**
 * 对话式冷启动引导（五问）的界面状态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 决策①：「五问**混进对话正文**」在渲染层是什么形态
 * ══════════════════════════════════════════════════════════════════════════
 * 问句是**助手消息**，不是卡片：它出现在消息流里（与回答同一种气泡），
 * 学生在**正常输入框**里回答，界面照常可用（能翻历史、能开右栏、能换页）。
 *
 * 所以这里**不**建 `ChatTurn`：轮次是「学生问了、模型答了」这件事的记录，
 * 而问句是系统先开的口（既没有 requestId，也不会流式输出）。硬塞进 `chat.turns`
 * 会让所有按轮次算的逻辑（排队、卡片收集、滚动跟随、分叉）都要理解一个特例。
 * 问句走一条独立的渲染槽（对话区里、消息列表同一列），学生一回答就换下一问。
 *
 * ── ★★ 2026-09-30 用户裁决：引导期**不进对话、不调模型、答完另起一页** ─────
 * 五问不是一段对话，是**认识你的头五个问题**。所以：
 *   · 每一句回答只交回本 store（`submitAnswer`）——`Chat.vue` 在引导期**不调
 *     `chat.send`**，因此不会产生任何模型往返、也不会把问答堆进一条会话里；
 *   · 已经问过/答过的那些由 {@link transcript} 在本页自己渲染（问句 + 学生那句），
 *     读起来仍是「团团问、我答」，但它是引导的呈现，不是会话记录；
 *   · 第 5 问答完 → `state=done` → transcript 清空、引导区整块消失，
 *     界面回到**正常的新对话页**（那 5 条只进库 `onboarding_qa`，不进会话历史）。
 *
 * ── 选项 chip 点选 = 直接提交（**同一个出口**）────────────────────────────
 * 只有第 1 问带 chip（年级是闭集）。点一下**立即提交并进入第 2 问**（用户裁决）；
 * 但它与打字**共用同一个出口** `submitAnswer` —— 第二条记录路径迟早会漂
 * （chip 记了问次、打字没记），那种漂移表现为「点选能被记住、打字不被记住」。
 *
 * ── 「这条回答属于哪一问」靠位置，不靠解析 ──────────────────────────────
 * 展示第 N 问时把它的 id 记进 {@link pendingQuestionId}（**位置**），
 * 学生下一条消息连同这个 id 一起交回主进程。绝不从回答文本里去认
 * 「他答的是第几问」—— 那需要模型/规则再理解一遍，而它是**可以答错的**。
 *
 * ── 弹不弹：只有一个判据 ────────────────────────────────────────────────
 * `onboardingState !== 'done'`（票 31：唯一终态是 done）—— 没答完就一直问，
 * 答了一半（in_progress）与历史 skipped 都算没答完。**绝不**自己加 localStorage 标记位：
 * 库里已经有权威状态，再加一份就会出现「界面说没问过、库里说问过了」。
 *
 * ── ★ 降级（执行报告 §1.7 硬要求）──────────────────────────────────────
 * 引导是**新用户的前 30 秒**，卡在这里代价最大。所以：
 *   · 收不到某一问的回答 → 按顺序发下一问（流程**照常走完**）；
 *   · 桥整块不可用（没接线 / preload 缺失）→ **整段引导不出现**，学生直接提问
 *     （绝不显示一段点了没反应的引导）；
 *   · 全部走完 → 发起一次对齐（读一次状态），拿不到就自己认「问完了」。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  ONBOARDING_DONE_STATE,
  ONBOARDING_QUESTIONS,
  type OnboardingQuestionId,
  type OnboardingQuestionSpec
} from '@shared/profile-tags'
import {
  ONBOARDING_BRIDGE_MISSING_HINT,
  normalizeOnboardingState,
  resolveOnboardingBridge,
  shouldOfferOnboarding,
  type OnboardingBridge,
  type OnboardingStateView
} from '../api/onboarding'

/** 按 id 取一问的脚本（**唯一一份**，主进程也读同一份常量）。 */
export function questionById(id: OnboardingQuestionId): OnboardingQuestionSpec | null {
  return ONBOARDING_QUESTIONS.find((question) => question.id === id) ?? null
}

/**
 * 两问里**更靠后**的那个（`null` = 全都答完了，视为最后）。
 *
 * ★ 用于抵消「回答还在后台落库、这次状态读却已经回来了」的竞态：
 *   问句只许往前走，绝不因为一份更旧的快照把学生拽回去重答。
 */
function laterQuestion(
  a: OnboardingQuestionId | null,
  b: OnboardingQuestionId | null
): OnboardingQuestionId | null {
  const pos = (id: OnboardingQuestionId | null): number =>
    id === null ? ONBOARDING_QUESTIONS.length : ONBOARDING_QUESTIONS.findIndex((q) => q.id === id)
  return pos(a) >= pos(b) ? a : b
}

export const useOnboardingStore = defineStore('onboarding', () => {
  /** 后端给的流程状态；`null` = 还没读到（或整块能力不可用）。 */
  const state = ref<OnboardingStateView | null>(null)
  /**
   * 正在等学生回答的那一问（`null` = 现在不该显示问句）。
   *
   * ★ 它是**位置**的记录，不是从任何文本里解析出来的（见文件头）。
   * ★ 它只活在本会话内存里：重开应用时重新从后端状态算（问句由状态决定，
   *   不需要把「问到哪儿了」也持久化一份 —— 那会是第二处真相）。
   */
  const pendingQuestionId = ref<OnboardingQuestionId | null>(null)
  /**
   * 学生已经答过的问次（权威值在后端，这里只是本会话的镜像）。
   *
   * ★ 2026-09-29 起界面上**不再显示进度条**（五问改成普通助手消息形态，去掉了
   *   「第 N 个问题，共 5 个」）—— 但它仍然要留：`apply()` 用它判断
   *   「后端把已答过的问次又发回来」这种重放/竞态，那条判据删不得。
   */
  const answered = ref<OnboardingQuestionId[]>([])
  /**
   * ★★ 本次引导里「已经问过并答过」的那些（`{问次, 学生原话}`），用于渲染。
   *
   * ★ 它**只活在本会话内存里**：引导期不再往会话里写任何消息，所以那几对问答
   *   没有第二个落点。App 中途重启会丢掉这份显示用的记录（权威记录在库里的
   *   `onboarding_qa`），界面从**还没答的那一问**接着问 —— 与「续问到 done」一致。
   * ★ `done` 之后清空（`apply()`）：引导区整块消失，页面回到正常新对话页。
   */
  const transcript = ref<{ questionId: OnboardingQuestionId; answerText: string }[]>([])
  /** 桥整块不可用时给学生看的那句话（`null` = 正常）。 */
  const bridgeError = ref<string | null>(null)
  /** 正在提交（防连点；chip 连点两下会交回两条一模一样的回答）。 */
  const submitting = ref(false)

  /** 已收到的桥（不必每次重新探测）。 */
  let bridge: OnboardingBridge | null = null
  let unsubscribe: (() => void) | null = null

  /** 学生看得见的那一问（`null` = 不显示）。 */
  const currentQuestion = computed<OnboardingQuestionSpec | null>(() =>
    pendingQuestionId.value === null ? null : questionById(pendingQuestionId.value)
  )

  /**
   * 该不该在对话区显示引导。
   *
   * ★ 判据是「现在有一问在等回答」—— 这一条同时蕴含了
   *   「流程状态是 in_progress」与「桥是可用的」，不需要调用方再拼条件。
   */
  const active = computed(() => currentQuestion.value !== null)

  /**
   * 拿到的状态能不能弹（**唯一判据**，导出成函数是为了让它可单测）。
   */
  function canOffer(view: OnboardingStateView | null): boolean {
    return shouldOfferOnboarding(view)
  }

  /**
   * 把一份状态落进界面。
   *
   * ★ `nextQuestionId` 为 `null` 时**必须清掉**待答问次：那是「问完了」的信号，
   *   留着它会让第 5 个问题在学生答完之后继续挂在屏幕上（他答了，界面当没看见）。
   * ★ 后端已经收下这一问时，绝不用本地推断去顶它 —— 能不能弹、问到哪儿，
   *   判据都在库里那一条流程状态上。
   */
  function apply(view: OnboardingStateView | null): void {
    if (view === null) return
    state.value = view
    // ★★ 本地已交回的问次并进权威集合（`submitAnswer` 记的那份，降级路径也在里面）。
    //   它是下面「绝不回头重问」的判据 —— 只信后端那一份会把刚交上去的回答丢掉。
    const merged = [...view.answered]
    for (const id of answered.value) if (!merged.includes(id)) merged.push(id)
    answered.value = merged
    if (view.nextQuestionId === null) {
      pendingQuestionId.value = null
      // ★ 引导结束：显示用的问答记录一并清掉（界面回到正常新对话页）
      if (view.onboardingState === ONBOARDING_DONE_STATE) transcript.value = []
      return
    }
    // ★★ 竞态（2026-09-30 真机实测出来的）：回答是 **fire-and-forget 落库**的
    //   （`service.answer()` 立刻回执，写库与概括都进后台队列），而这一次读走的是
    //   `IPC.onboardingState` → `service.start()` → **重新读服务端**，
    //   于是它完全可能**早于**刚才那条回答落库 —— 回来的 `nextQuestionId` 就是
    //   「学生刚答过的那一问」。照单全收的后果实测过：界面退回去重问，
    //   学生下一条话被记到上一问头上，把刚说的那句**覆盖**掉。
    //   所以问句**只许往前走**：本地按已答集合算出「第一问还没答的」，
    //   与后端给的取更靠后的那个（后端更靠后 = 它知道得更多，照它走）。
    const localNext = ONBOARDING_QUESTIONS.find((question) => !merged.includes(question.id))?.id ?? null
    pendingQuestionId.value = laterQuestion(view.nextQuestionId, localNext)
  }

  /**
   * ★★ **本地降级推进**：答了一问但**收不到后端回信**时，按顺序发下一问。
   *
   * 为什么必须有它（执行报告 §1.7）：没有 Key / 概括失败 / 某条回答没收到，
   * 引导都**照常结束**。这里刻意不做任何「稍后重试」—— 重试的可见代价是
   * 学生盯着一个不动的问句，而它恰好发生在新用户的前 30 秒。
   *
   * @returns 推到了哪一问（`null` = 五问都走完了）。
   */
  function advanceLocally(from: OnboardingQuestionId): OnboardingQuestionId | null {
    const at = ONBOARDING_QUESTIONS.findIndex((question) => question.id === from)
    const next = at >= 0 ? ONBOARDING_QUESTIONS[at + 1] : undefined
    return next?.id ?? null
  }

  /**
   * 读一次状态（挂载时、以及每次回答之后各一次）。
   *
   * ★ 失败**不抛**、不白屏：桥不可用时整段引导不出现（{@link active} 恒为假），
   *   学生照常提问；缺哪条通道由 `api/onboarding.ts` 打进控制台。
   */
  async function load(): Promise<void> {
    const lookup = resolveOnboardingBridge()
    if (!lookup.ready) {
      bridge = null
      bridgeError.value = lookup.message
      state.value = null
      pendingQuestionId.value = null
      return
    }
    bridge = lookup.bridge
    bridgeError.value = null
    subscribe()
    try {
      const result = await bridge.state()
      if (!result.ok) {
        // 读不到状态 ≠ 桥坏了：不显示引导、也不给学生一句他解决不了的话
        state.value = null
        pendingQuestionId.value = null
        return
      }
      apply(normalizeOnboardingState(result.data))
    } catch {
      // 抛异常与回执失败同一处置（降级永不白屏）
      state.value = null
      pendingQuestionId.value = null
    }
  }

  /** 订上「引导状态变化」推送（幂等）。 */
  function subscribe(): void {
    if (unsubscribe !== null || bridge === null) return
    try {
      unsubscribe = bridge.onChanged((raw) => {
        apply(normalizeOnboardingState(raw))
      })
    } catch {
      // 订阅失败不影响读那一条线（推不到就靠每次回答后主动读一次）
      unsubscribe = null
    }
  }

  /**
   * ★★ **交回一问的回答**（chip 与输入框共用的唯一出口）。
   *
   * 顺序（每一步都有理由）：
   *   ① 先取下当前待答的问次 —— 用**位置**记，不解析学生的话；
   *   ② 立刻把待答问次清掉并算好下一问 —— 学生连点两下 chip、或者回答和
   *      下一问的推送竞态时，都不会把同一条回答交回两次；
   *   ③ 交回主进程（`fire-and-forget` 语义：**不等它的回信才让界面能动**）；
   *   ④ 收不到回信 → 用本地顺序推进（降级，流程照常走完）。
   *
   * ★ 它**不**发对话 —— 引导学生那句话该不该进对话、以什么形态进，
   *   是调用方与主进程的事（本函数只管「把回答交回去」这一件事）。
   * ★ 调用方要在**同一个提交动作里**随手把这句话交给对话（学生要看见自己说了什么，
   *   模型也该接着往下聊）—— 顺序必须先本函数、后 `chat.send`：本函数同步段里
   *   就会把待答问次取走并清掉（防重复提交），晚到一步就拿不到它了。
   */
  async function submitAnswer(answerText: string): Promise<void> {
    const questionId = pendingQuestionId.value
    const text = answerText.trim()
    if (questionId === null || text.length === 0) return
    // ★★ 重入闸（**同步设置**，在任何 await 之前）：学生连点提交键 / 回车按两下时，
    //   第二次调用必须被挡掉。只靠「待答问次已被清空」是挡不住的 —— 本地推进已经把
    //   pendingQuestionId 换成了**下一问**，第二次就会把同一条回答交到下一问头上
    //   （实测：连点两下会交回两条，第二条挂错问次）。
    if (submitting.value) return
    submitting.value = true

    const nextLocal = advanceLocally(questionId)
    if (!answered.value.includes(questionId)) answered.value = [...answered.value, questionId]
    pendingQuestionId.value = nextLocal
    // ★★ 记进显示的问答记录（同问重答 = 覆盖那一问，位置不动）：引导期不写会话，
    //   「团团问了什么、我答了什么」只有这一份来源。
    transcript.value = [
      ...transcript.value.filter((row) => row.questionId !== questionId),
      { questionId, answerText: text }
    ]

    const active = bridge
    if (active === null) {
      // 桥不可用：本地推进已经发生，流程仍走得完
      submitting.value = false
      return
    }

    try {
      const result = await active.answer({ questionId, answerText: text })
      if (!result.ok || !result.data.accepted) {
        // ★ 不回头重问：学生已经答了，让他再答一次是最烦人的失败形态。
        //   本地推进已经生效，引导照常往下走（这就是 §1.7 的降级）。
        return
      }
      // 成功：读一次权威状态（问到哪儿、还该不该问，以库里那条为准）
      const refreshed = await active.state()
      if (refreshed.ok) apply(normalizeOnboardingState(refreshed.data))
    } catch {
      // 同上：异常与回执失败同一处置
    } finally {
      submitting.value = false
    }
  }

  /** 断开推送订阅（应用卸载时调用，避免监听器堆积）。 */
  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    state,
    pendingQuestionId,
    answered,
    transcript,
    bridgeError,
    submitting,
    currentQuestion,
    active,
    canOffer,
    load,
    submitAnswer,
    dispose,
    /** 桥不可用时给学生看的那句（模板直接渲染它）。 */
    bridgeMissingHint: ONBOARDING_BRIDGE_MISSING_HINT
  }
})
