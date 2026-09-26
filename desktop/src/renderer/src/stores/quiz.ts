/**
 * 闯关（Pinia）：独立闯关页的进度 / 出题 / 判分。
 *
 * ★ ★ 与**对话内题卡**的分工（两条路都在，别合并）：
 *   - 对话内题卡（`cards/QuizCard.vue`）：答案当一句话发进对话，模型调 `submit_quiz`，
 *     好处是模型能顺着学生的话给反馈；
 *   - 本 store（独立页）：直接取题库、直接判分，**不开对话**。
 *     学生在页面上刷题时不该每答一题就消耗一次云端调用。
 *   两条路最终都落到同一个后端端点（`POST /api/quiz/grade`），判分口径因此一致。
 *
 * ★★ 答案防泄漏：库里的载荷是 `QuizQuestionOut`（**没有 `answer`**），
 *   对错只从判分回执里来。前端**永远不知道**正确答案是什么，也**不做**本地判分 ——
 *   在这里自己比对等于把「学生能自己看到答案」这件事重新发明一遍。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  resolveDataBridge,
  type DataBridge,
  type QuizBankView,
  type QuizProgressView,
  type QuizResultView
} from '../api/data'
// ★ 面向学生的失败文案只有一处实现（HTTP 状态码 / 服务器路径 / 内部 kp_id 都要翻掉）
import { describeClientError, toStudentFacingMessage } from '../api/student-facing'

/** 页面上一题的作答状态（本地，不落库；落库由判分端点负责）。 */
export interface QuizAttempt {
  qid: string
  answer: string
  result: QuizResultView | null
  /** 提交中（防连点：连点会判两次、写两次掌握度）。 */
  submitting: boolean
  error: string | null
}

export const useQuizStore = defineStore('quiz', () => {
  const progress = ref<QuizProgressView | null>(null)
  const progressLoading = ref(false)
  const progressError = ref<string | null>(null)

  /** 当前正在练的知识点（空串 = 还没选）。 */
  const activeKpId = ref('')
  const bank = ref<QuizBankView | null>(null)
  const bankLoading = ref(false)
  const bankError = ref<string | null>(null)

  /**
   * **智团团给这个学生出过的题**（`GET /api/quiz/generated/{id}`，D-088）。
   *
   * ★ 与 `bank` 是**两处来源、一条做题链路**：作答/判分/反馈完全同一条
   *   （答完按 `qid` 走 `POST /api/quiz/grade`），所以页面把它们合并进同一个题列表，
   *   只在题头标出「这道是智团团出的」。
   * ★ 失败**不影响题库那批题**：这条读路径是加分项，挂了就当没有（不摆错误卡）。
   */
  // ★ `NonNullable<…>`：契约里 `questions` 有默认值 ⇒ 生成的 TS 标成可选；
  //   而这里的状态**永远是一个数组**（没有就是空数组），别把可选性传染给下游
  const generated = ref<NonNullable<QuizBankView['questions']>>([])
  const generatedLoading = ref(false)
  /** 按 `qid` 存作答状态（翻回上一题时状态还在）。 */
  const attempts = ref<Record<string, QuizAttempt>>({})
  /** 本页判分过的题目数（用于「本轮小结」；**不编造历史记录**）。 */
  const gradedCount = ref(0)
  const correctCount = ref(0)

  const bridgeError = ref<string | null>(null)
  /**
   * 非响应式：**同一请求键**的并发取题只发一次（键 = `kpId` + `count`）。
   *
   * ★★ 去重必须看请求键，不能只看「有没有请求在飞」：旧写法
   *   `if (bankInFlight) return await bankInFlight` 会在学生连点两个关卡时
   *   把**第二个请求静默丢掉** —— 而 `activeKpId` 已经切到 B、`bank` 还是 A 的题，
   *   于是「学生对着错误标题作答」。键相同才复用（同一关连点不必发两次），
   *   键不同就并发发新的，且**只让最后一次写结果**。
   *   对照组是 `stores/study.ts` 的 `chaptersInFlight === gradeLevel`。
   */
  let bankInFlight: { key: string; promise: Promise<void> } | null = null
  /** 取题的请求序号（只让最后一次发出的请求写结果）。 */
  let bankRequestSeq = 0

  /* ---------------------------------------------------------------- *
   * 派生
   * ---------------------------------------------------------------- */

  /** 关卡列表（服务端已按依赖图拓扑序排好 —— **不要在这里重排**）。 */
  const levels = computed(() => progress.value?.levels ?? [])

  /** 未掌握的关卡数（侧栏 badge 用它，替掉原型里写死的 `3`）。 */
  const pendingCount = computed(
    () => levels.value.filter((level) => level.stage !== 'mastered').length
  )

  /** 当前关卡的阶段（没有关卡时 `null`）。 */
  const activeStage = computed(
    () => levels.value.find((level) => level.kpId === activeKpId.value)?.stage ?? null
  )

  /** 本轮做对的比例（没有判过题时 `null`，界面据此隐藏小结）。 */
  const accuracy = computed(() => {
    if (gradedCount.value === 0) return null
    return correctCount.value / gradedCount.value
  })

  /* ---------------------------------------------------------------- *
   * 取数
   * ---------------------------------------------------------------- */

  /** 读闯关进度（幂等）。 */
  async function loadProgress(force = false): Promise<void> {
    if (progressLoading.value) return
    if (progress.value !== null && !force) return
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bridgeError.value = null
    progressLoading.value = true
    progressError.value = null
    try {
      const result = await lookup.bridge.readQuizProgress()
      // ★★ 失败文案必须过一遍面向学生的翻译（与 `bankError` 同一条纪律）。
      //   这里原来是**直出** `result.message`，而它来自主进程的 wire 层，
      //   形如「读取失败（HTTP 503）：<后端 detail>」—— HTTP 状态码与内部细节
      //   会直接印在**编程页左侧的关卡列表**与**闯关页**上（两处都渲染这个字段）。
      //   这正是走查那条「界面文案不得包含服务器路径 / HTTP 状态码」的落点。
      if (result.ok) progress.value = result.data as QuizProgressView
      else progressError.value = toStudentFacingMessage(result.message, { topic: 'quiz' })
    } catch (thrown) {
      progressError.value = describeClientError(thrown, { topic: 'quiz' })
    } finally {
      progressLoading.value = false
    }
  }

  /**
   * 选一关并取题。
   *
   * ★★ 2026-09-25 去掉关卡锁定：不再有「还没解锁」这一档，**任何一关都可以直接作答**。
   *   这里不再按阶段拦请求（旧写法会为锁着的关卡当场拒绝、把「这一关还没解锁」写进
   *   `bankError`）。学段与题量隔离仍是服务端的权威，交给它判就行。
   */
  async function selectLevel(kpId: string): Promise<void> {
    activeKpId.value = kpId
    attempts.value = {}
    gradedCount.value = 0
    correctCount.value = 0
    // ★ 两处来源一起取：教材配套题（题库）+ 智团团给这个学生出过的题（D-088）
    await Promise.all([loadBank(kpId), loadGenerated(kpId)])
  }

  /**
   * 取「智团团给这个学生出过的题」（D-088）。
   *
   * ★ 静默失败：这条是**加分来源**（题库那条路才是主路径），拿不到就当没有 ——
   *   给它摆一张错误卡只会让学生在「做题」这件事上读到两次失败。
   * ★ 身份由主进程注入（请求里没有 studentId，见 `IPC.quizGeneratedList`）。
   */
  async function loadGenerated(kpId: string): Promise<void> {
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      generated.value = []
      return
    }
    generatedLoading.value = true
    try {
      const result = await lookup.bridge.readGeneratedQuestions({ kpId })
      generated.value = result.ok
        ? ((result.data as QuizBankView).questions ?? [])
        : []
    } catch {
      // 同上：静默（这条读路径不是主路径）
      generated.value = []
    } finally {
      generatedLoading.value = false
    }
  }

  /** 取某知识点的题目（默认 3 道；数量由主进程校验上限）。 */
  async function loadBank(kpId: string, count = 3): Promise<void> {
    const key = `${kpId}#${count}`
    // 键相同 → 复用那次在途请求；键不同 → 往下走，**并发发新的**（题量与知识点都算键）
    if (bankInFlight !== null && bankInFlight.key === key) {
      return await bankInFlight.promise
    }
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bankLoading.value = true
    bankError.value = null
    const request = fetchBank(kpId, count, lookup.bridge)
    bankInFlight = { key, promise: request }
    try {
      await request
    } finally {
      // 只有仍然登记在案的那次负责收尾（被更新的一次顶掉的请求不该关掉新请求的加载态）
      if (bankInFlight !== null && bankInFlight.promise === request) {
        bankInFlight = null
        bankLoading.value = false
      }
    }
  }

  /**
   * 发一次取题的请求（拆出来是为了有一个**绝不同步抛**的边界）。
   *
   * ★ 只有**最后一次**发出的请求能写结果：迟到的旧响应若照写，
   *   学生已经点开 B 了却会被 A 的题与失败文案盖回去。
   * ★ 失败也过翻译：后端 detail 里带着服务器上的题库目录
   *   （`知识点 'x-jr' … （题库文件：server/resources/quizbank/）`）。
   */
  async function fetchBank(kpId: string, count: number, bridge: DataBridge): Promise<void> {
    const seq = (bankRequestSeq += 1)
    try {
      const result = await bridge.readQuizBank({ kpId, count })
      if (seq !== bankRequestSeq) return
      bank.value = result.ok ? (result.data as QuizBankView) : null
      if (!result.ok) bankError.value = toStudentFacingMessage(result.message, { topic: 'quiz' })
    } catch (thrown) {
      if (seq !== bankRequestSeq) return
      bankError.value = describeClientError(thrown, { topic: 'quiz' })
    }
  }

  /**
   * 这道题是不是**已有终态**（答对了）。
   *
   * ★★ 判据只读后端判分回来的 `correct`（前端不比对答案、不自己判对错）。
   * 为什么需要它：判分口径是「**首次作答决定**」——答对之后再提交，
   * 服务端照常判分照常给反馈，但掌握度与闯关进度**一个字都不会变**，
   * 反馈里还会多一句「这次就算再练一遍，不计分」。那是一次**没有效果**的提交，
   * 界面上不该有一个键在邀请学生去做它（评审实测：答对后按钮仍写着「再提交一次」）。
   * 页面的提交键据此变「已完成」并禁用（`views/Quiz.vue` 的 `submitDisabled`），
   * 这里再挡一道：即使有别的调用方绕过界面调用 `submit()`，也不会发那次无意义的请求。
   */
  function isSettled(qid: string): boolean {
    return attempts.value[qid]?.result?.correct === true
  }

  /**
   * 提交一题并判分。
   *
   * ★ 判分**只在后端**：这里拿回来的 `correct` / `feedback` / `masteryDelta` 是权威结论。
   * ★ 防连点：同一题提交中直接返回（连点会判两次、写两次掌握度）。
   * ★ 答对即终态：已判为正确的题不再重发（见 `isSettled`）。
   * ★ 判完顺手刷新进度与画像 —— 刚过的那一关应该立刻在关卡列表里变样，
   *   而不是等学生自己再点一次刷新。
   */
  async function submit(qid: string, answer: string): Promise<void> {
    const existing = attempts.value[qid]
    if (existing?.submitting) return
    if (isSettled(qid)) return
    const trimmed = answer.trim()
    if (trimmed.length === 0) {
      attempts.value = {
        ...attempts.value,
        [qid]: { qid, answer, result: null, submitting: false, error: '还没有作答。' }
      }
      return
    }

    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }

    attempts.value = {
      ...attempts.value,
      [qid]: { qid, answer: trimmed, result: existing?.result ?? null, submitting: true, error: null }
    }
    try {
      const result = await lookup.bridge.gradeQuiz({ qid, answer: trimmed })
      if (result.ok) {
        const graded = result.data as QuizResultView
        attempts.value = {
          ...attempts.value,
          [qid]: { qid, answer: trimmed, result: graded, submitting: false, error: null }
        }
        // 只在**首次**判分时计数（重判同一题不该把正确率刷上去）
        if (existing?.result == null) {
          gradedCount.value += 1
          if (graded.correct) correctCount.value += 1
        }
        void loadProgress(true)
      } else {
        attempts.value = {
          ...attempts.value,
          [qid]: {
            qid,
            answer: trimmed,
            result: null,
            submitting: false,
            // 判分失败也是「一句学生看得懂的话」：后端 detail 可能带内部标识与服务器路径
            error: toStudentFacingMessage(result.message, { topic: 'quiz' })
          }
        }
      }
    } catch (thrown) {
      attempts.value = {
        ...attempts.value,
        [qid]: {
          qid,
          answer: trimmed,
          result: null,
          submitting: false,
          error: describeClientError(thrown, { topic: 'quiz' })
        }
      }
    }
  }

  /** 重做这一关（清掉本地作答状态；**不**清除已落库的判分结果）。 */
  function restart(): void {
    attempts.value = {}
    gradedCount.value = 0
    correctCount.value = 0
  }

  return {
    progress,
    progressLoading,
    progressError,
    levels,
    pendingCount,
    activeKpId,
    activeStage,
    bank,
    bankLoading,
    bankError,
    generated,
    generatedLoading,
    attempts,
    gradedCount,
    correctCount,
    accuracy,
    bridgeError,
    loadProgress,
    selectLevel,
    loadBank,
    loadGenerated,
    submit,
    restart
  }
})
