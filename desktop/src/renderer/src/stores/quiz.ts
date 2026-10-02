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
 *
 * ★★ 2026-10-01 补上「动态出题」的渲染层一半（施工图 `docs/练习动态出题-功能实现计划.md`）：
 *   做完一关内置题（全部判过分）后**自动**追加个性化题，每关只自动触发一次；
 *   学生在列表尾部点「还想再练练」再要一批。出题本身在主进程做（模型 + 登记），
 *   这里只负责四件事：触发判据、组装作答轨迹、去重请求、把**已经拿到**的题追加进列表。
 *   ★ 渲染层**不传** studentId / gradeLevel —— 身份与学段由主进程注入（与取题库同一条纪律）。
 *   ★ 请求里没有 `count`：「还想再练练」的题量由主进程定（渲染层传了也不被信任）。
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
// ★ 「本学段关卡路径」的口径不写在这里：见 `study/workshop-path.ts` 的 `pathLevelsOf`
//   （纯函数 + 单测）；本 store 只负责把它接到响应上
import { pathLevelsOf } from '../study/workshop-path'

// ★ 出题请求的类型来自冻结接口（`shared/quiz-generate.ts`）：渲染层只组装 `context`，
//   请求里**没有** studentId / gradeLevel（与 `IPC.quizBank` 同一条纪律）。
import type { DecisionTrace, QuizGenerateRequest } from '@shared/quiz-generate'

/** 页面上一题的作答状态（本地，不落库；落库由判分端点负责）。 */
export interface QuizAttempt {
  qid: string
  answer: string
  result: QuizResultView | null
  /** 提交中（防连点：连点会判两次、写两次掌握度）。 */
  submitting: boolean
  error: string | null
  /**
   * ★★ 每次提交的轨迹（**只增不减**，提交即追加）。
   *
   * ★ 为什么需要它：`result` 只留**最后一次**判分结果，而「一次答对还是试了好几次」
   *   「每次都选了什么」正是动态出题最需要的素材（错题 + 错选原文 → 针对性子概念的巩固题）。
   * ★ 判分失败也记：`answer` 留着、`correct` 记 `null`（那次提交确实发生过，只是没拿到结论）；
   *   本地拦下的**空作答不记**（它根本没发出去）。
   * ★ 本地态、不落库：跨会话的作答流水在后端 `learning_history`，那是另一份事实。
   */
  history: Array<{ answer: string; correct: boolean | null; at: number }>
}

/**
 * 自动阶段的题目总数上限（内置 + 生成）。
 *
 * ★ 常量集中在这一处：触发判据与界面截断共用它，别让 20 散落成两份。
 */
export const AUTO_PHASE_LIMIT = 20
/** 「还想再练练」每次追加的题量（题量本身由主进程定，这里是对外口径）。 */
export const MORE_BATCH = 10

/**
 * 自动追加**第一段**的题数上限（= 契约单批上限 10）。
 *
 * ★★ 2026-10-02 用户裁决：自动追加**分两段**，先给第一段。
 *   分段前：配额 17（内置 3 + 17 = 20）一次要完 → 两批串行 + 每批最多 2 次重试
 *   → 学生对着空列表等几十秒。分段后：第一段到手就能开始做，剩下的后台补。
 *   ⚠️ 这是**等待与展示**的取舍，不是总量变化：两段之和仍是「补齐到 20」。
 *   ⚠️ 与主进程 AUTO_FIRST_BATCH（agent/quizgen/service.ts）必须同值 ——
 *   真正出几道由那边定，这一份只用来算「还剩多少要补」。
 */
export const AUTO_FIRST_BATCH = 10

/** 题干进决策记录时的截断长度（与后端记录作答时 question 列的口径一致）。 */
const STEM_HEAD_LIMIT = 120

/** 「还想再练练」在没有可用模型时说的一句人话（**降级不是失败**，不摆错误卡）。 */
const MORE_UNAVAILABLE_TEXT =
  '现在没法出新题（还没有可用的模型）。可以先回去聊一聊，或者换一关接着练。'

/**
 * 「还想再练练」点了、但**这一批没有新题**时给学生的另一句人话。
 *
 * ★ 为什么不说「没有可用模型」：主进程把「配额已满」与「当前没有可用模型」回成**同一个形状**
 *   （`{ ok: true, data: null }`，附加语义只进主进程日志，见 handlers-data.ts 的
 *   runQuizGeneration）—— 在这边说成模型问题，配额已满时就是一句假话。
 *   「这次没有新题」两种情形都成立，也不需要学生理解背后机制。
 */
const MORE_EMPTY_TEXT = '这次没有新题。可以先接着做上面的题，或者换一关试试。'

/** 一道题的展示形态（题库与生成题**同形**；契约里没有 `answer` / `explanation`）。 */
type QuizQuestionView = NonNullable<QuizBankView['questions']>[number]

/**
 * 一次生成请求给界面看的最小事实。
 *
 * ★ `degraded` 与失败分开：前者是「现在做不了」的**可用性说明**（自动路径静默吞掉、
 *   按钮路径说一句人话），后者才是需要学生知道的失败（按钮路径给行内提示 + 重试）。
 */
export interface QuizGenerateOutcome {
  ok: boolean
  added: number
  degraded: boolean
  message: string | null
}

/**
 * 该不该为这一关**自动追加**生成题（纯函数，单测直接测）。
 *
 * 五个条件缺一不可（计划 §4.1）：
 *   ① 题库对象在、当前关卡非空；
 *   ② 题干数 > 0（题库为空的关卡不触发 —— 页面已有「让老师现场出几道」的空态指引）；
 *   ③ 同一关**只触发一次**（`autoFiredKp` 在派发时就登记；`restart` 刻意不重置）；
 *   ④ 配额未满（内置 + 已有生成题数 < `limit`）；
 *   ⑤ 内置题**全部判分过**（`result != null`）—— 不要求全对：卡在错题上的学生
 *      恰恰最需要个性化题（计划 §1 的口径裁决，不是笔误）。
 *
 * @param limit 自动阶段总数上限（默认 {@link AUTO_PHASE_LIMIT}）
 * @param generatedCount 这一关**已有**的生成题数（历史复用 + 本轮追加都算）
 */
export function shouldAutoGenerate(
  bank: QuizBankView | null,
  attempts: Record<string, QuizAttempt>,
  autoFiredKp: string,
  currentKpId: string,
  limit: number = AUTO_PHASE_LIMIT,
  generatedCount = 0
): boolean {
  if (bank === null || currentKpId.length === 0) return false
  const questions = bank.questions ?? []
  if (questions.length === 0) return false
  if (autoFiredKp === currentKpId) return false
  if (questions.length + Math.max(0, generatedCount) >= limit) return false
  return questions.every((question) => attempts[question.qid]?.result != null)
}

/** 判分回来后把最后一条轨迹补上结论（判分失败不调用 —— 它保持 `null`）。 */
function markLastHistoryCorrect(
  history: QuizAttempt['history'],
  correct: boolean
): QuizAttempt['history'] {
  if (history.length === 0) return history
  const next = history.slice()
  next[next.length - 1] = { ...next[next.length - 1], correct }
  return next
}

/**
 * 读生成回执（**白名单读取**，与卡片载荷同一条纪律）。
 *
 * ★ 两种形态都认：出题服务把 `questions` 直接摊在 `data` 上，或包一层 `payload` ——
 *   主进程那侧的字段名由冻结接口定，这里不假设，认得出就取、认不出的整条丢掉。
 * ★ `degraded === true` 是「现在没有可用模型」的可用性说明，不是错误。
 */
function readGenerateResponse(data: unknown): {
  questions: QuizQuestionView[]
  degraded: boolean
  note: string | null
} {
  const record = (data && typeof data === 'object' ? data : {}) as {
    questions?: unknown
    degraded?: unknown
    note?: unknown
    payload?: { questions?: unknown } | null
  }
  const flat = Array.isArray(record.questions) ? record.questions : null
  const nested = Array.isArray(record.payload?.questions) ? record.payload.questions : null
  const questions = ((flat ?? nested ?? []) as QuizQuestionView[]).filter(
    (question) => question !== null && typeof question.qid === 'string' && question.qid.length > 0
  )
  const note =
    typeof record.note === 'string' && record.note.trim().length > 0 ? record.note.trim() : null
  return { questions, degraded: record.degraded === true, note }
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

  /**
   * 本关是否已经**自动追加**过一次（空串 = 还没有）。
   *
   * ★ `selectLevel` 切关时清空（新关可以再触发一次）；`restart` **不**重置 ——
   *   做完了就是做完了，重做不该再白花一次生成（计划 §4.1）。
   */
  const autoFiredKp = ref('')

  /**
   * 自动追加是否在飞。
   *
   * ★★ 2026-10-02：它**不再是「没人看的死状态」** —— 练习页的占位卡就读它。
   *   原注释写着「界面若要提示正在出题…可以读它」，而当时是**零个消费者**：
   *   学生在「什么都没有」的状态下等几十秒，然后突然发现多了十几道题。
   */
  const autoGenerating = ref(false)

  /**
   * 自动追加是否**已经派发过**（第一段已发出）。
   *
   * ★ 与 autoGenerating 分开：后者是「此刻在飞」，前者是「这件事发生过」。
   *   失败后 autoGenerating 会落回 false，但卡片要留下来显示失败与重试。
   */
  const autoStarted = ref(false)

  /** 自动追加还剩几段没回来。> 0 = 占位卡显示「正在出」而不是「失败」。 */
  const autoPending = ref(0)

  /**
   * 自动追加的**失败说明**（学生面可读中文）。
   *
   * ★★ 2026-10-02 补的出口：此前这条路**一个出口都没有** ——
   *   runGenerate 里只有 mode==="more" 才写 moreError / moreNotice，
   *   auto 分支失败时连一句 console 都没有（降级只有主进程 warn）。
   */
  const autoError = ref<string | null>(null)

  /** 自动追加的降级说明（无可用模型 → 主进程给的那句话）。 */
  const autoNotice = ref<string | null>(null)
  /** 「还想再练练」是否在飞（按钮防连点的权威状态）。 */
  const moreGenerating = ref(false)
  /** 「还想再练练」失败时给学生的一句话（`null` = 没有失败）。 */
  const moreError = ref<string | null>(null)
  /** 「还想再练练」的降级说明（还没有可用模型时的那句）；`null` = 没有。 */
  const moreNotice = ref<string | null>(null)

  /**
   * 生成请求的在途登记（键 = `mode#kpId`）—— 与 {@link bankInFlight} 同一个手法：
   * 键相同才复用（连点 / 判分连击只发一次），键不同就并发发新的、且只让最后一次写结果。
   */
  let generateInFlight: { key: string; promise: Promise<QuizGenerateOutcome> } | null = null
  /** 生成请求序号：只让**最后一次**发出的请求写结果（切关后迟到的响应直接丢）。 */
  let generateSeq = 0
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

  /**
   * ★★ **本学段关卡路径**（路径视图用这个；`levels` 是整张进度表，记录视图才用它）。
   *
   * 为什么必须分开：`progress` 表是**按学生长期保留**的，学段换过之后会同时留着
   * 更低学段的旧行（取题允许向上兼容，所以那些行是合法记录）—— 整张表当路径渲染，
   * 学生看到的就是「同一个概念出现三次、名字一模一样」。服务端已逐行标好 `inPath`
   * （P-085：关卡路径 = 本学段），这里只做一次投影。
   */
  const pathLevels = computed(() => pathLevelsOf(levels.value))

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

  /**
   * 题库 + 生成题的**合并列表**（按 `qid` 去重，题库在前）。
   *
   * ★ 与 `views/Quiz.vue` 的显示列表同源：那边多一层「自动阶段上限」的截断
   *   （UI 策略，常量是 {@link AUTO_PHASE_LIMIT}）；这里给的是**全量** ——
   *   决策记录要的是「学生做过的所有题」，不是「屏幕上这一刻的截断视图」。
   */
  const allQuestions = computed<QuizQuestionView[]>(() => {
    const bankQuestions = bank.value?.questions ?? []
    const seen = new Set(bankQuestions.map((question) => question.qid))
    const extras: QuizQuestionView[] = []
    for (const question of generated.value) {
      if (seen.has(question.qid)) continue
      seen.add(question.qid)
      extras.push(question)
    }
    return [...bankQuestions, ...extras]
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
    // ★ 切关：本关的自动追加登记清空（新关可以再触发一次），并把**在途**的生成请求作废 ——
    //   旧请求迟到回来时序号已变，只会被丢弃，不会写进新关的列表（计划 §6）。
    autoFiredKp.value = ''
    autoGenerating.value = false
    // ★ 分段那两个状态也要清：换关之后「上一关还在补余」不成立。
    autoStarted.value = false
    autoPending.value = 0
    autoError.value = null
    autoNotice.value = null
    moreGenerating.value = false
    moreError.value = null
    moreNotice.value = null
    generateInFlight = null
    generateSeq += 1
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
    /*
     * ★★ 空 qid 直接不发（2026-10-01 真机缺陷的根因之一）：题号来自渲染出来的那一行，
     *   而列表在**自动追加生成题**时会重建 —— 重建的那一瞬间提交，qid 可能是空的，
     *   请求带着空 qid 打到后端必然 404，学生看到的就是「这一关还没有题目」
     *   （明明眼前就有题）。这里挡一道：没有 qid 就没有请求、也没有假消息。
     */
    if (qid.trim() === '') return
    const existing = attempts.value[qid]
    if (existing?.submitting) return
    if (isSettled(qid)) return
    const trimmed = answer.trim()
    if (trimmed.length === 0) {
      attempts.value = {
        ...attempts.value,
        [qid]: {
          qid,
          answer,
          result: null,
          submitting: false,
          error: '还没有作答。',
          // ★ 空作答是本地拦下的（根本没发出去），不记轨迹
          history: existing?.history ?? []
        }
      }
      return
    }

    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }

    // ★ 提交那一刻先记一条（`correct` 先记 `null` = 还没有判分结论）；
    //   判分返回后把这条的结论补上 —— 判分失败就保持 `null`（计划 §4.6）。
    const history: QuizAttempt['history'] = [
      ...(existing?.history ?? []),
      { answer: trimmed, correct: null, at: Date.now() }
    ]
    attempts.value = {
      ...attempts.value,
      [qid]: {
        qid,
        answer: trimmed,
        result: existing?.result ?? null,
        submitting: true,
        error: null,
        history
      }
    }
    try {
      const result = await lookup.bridge.gradeQuiz({ qid, answer: trimmed })
      if (result.ok) {
        const graded = result.data as QuizResultView
        attempts.value = {
          ...attempts.value,
          [qid]: {
            qid,
            answer: trimmed,
            result: graded,
            submitting: false,
            error: null,
            history: markLastHistoryCorrect(history, graded.correct)
          }
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
            // ★ topic 用 'grade' 而不是 'quiz'：判分失败与「这关有没有题」是两件事（见 student-facing.ts）
      error: toStudentFacingMessage(result.message, { topic: 'grade' }),
            history
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
          error: describeClientError(thrown, { topic: 'quiz' }),
          history
        }
      }
    } finally {
      // ★ 触发点就在这里（判分返回后顺手求值，**不开 watcher**）：无论这一题判成没判成，
      //   「内置题是否全部判分过」都可能刚刚翻面；判据本身在纯函数里，这里不做二次判断。
      maybeAutoGenerate()
    }
  }

  /* ---------------------------------------------------------------- *
   * 动态出题（做完内置题自动追加 + 「还想再练练」）
   * ---------------------------------------------------------------- */

  /** 本轮作答轨迹 → 主进程出题用的决策记录（题号 = 合并列表下标 + 1）。 */
  function buildDecisionTraces(): DecisionTrace[] {
    const generatedQids = new Set(generated.value.map((question) => question.qid))
    return allQuestions.value.map((question, index) => {
      const history = attempts.value[question.qid]?.history ?? []
      const first = history.length > 0 ? history[0].correct : null
      const trace: DecisionTrace = {
        qid: question.qid,
        index: index + 1,
        type: question.type,
        source: generatedQids.has(question.qid) ? 'generated' : 'bank',
        // 题干前 120 字：与后端记录作答时那一列同一个截断口径
        stemHead: question.stem.slice(0, STEM_HEAD_LIMIT),
        tries: history.map((entry) => ({ answer: entry.answer, correct: entry.correct })),
        firstTryCorrect: first,
        triesCount: history.length
      }
      return trace
    })
  }

  /** 把一批新题追加进 `generated`（按 `qid` 去重；**不重载整表**，计划 §4.4）。 */
  function appendGenerated(questions: readonly QuizQuestionView[]): number {
    const seen = new Set<string>([
      ...(bank.value?.questions ?? []).map((question) => question.qid),
      ...generated.value.map((question) => question.qid)
    ])
    const fresh = questions.filter((question) => {
      if (seen.has(question.qid)) return false
      seen.add(question.qid)
      return true
    })
    if (fresh.length === 0) return 0
    generated.value = [...generated.value, ...fresh]
    return fresh.length
  }

  /** 两个生成入口各自的在飞标记（键不同、状态各归各的）。 */
  function setGenerating(mode: 'auto' | 'more', on: boolean): void {
    if (mode === 'auto') autoGenerating.value = on
    else moreGenerating.value = on
  }

  /**
   * 发一次生成请求（auto / more 共用）。
   *
   * ★ 三件事的顺序是有理由的：
   *   ① 请求键去重（键 = `mode#kpId`）—— 连点 / 判分连击只发一次；
   *   ② 请求序号 `generateSeq`：切关会把序号推走，迟到的旧响应**一律丢弃**；
   *   ③ 只有拿到 payload 才追加（「先登记后下发」的渲染层一半）—— 没拿到就什么都不做。
   * ★ 身份与学段**不在请求里**：主进程按当前学生与学段自己注入（渲染层的类型里就没有这两个字段）。
   */
  async function runGenerate(
    mode: 'auto' | 'more',
    /** auto 的分段（见 AUTO_FIRST_BATCH）；more 忽略。 */
    stage?: 'first' | 'rest'
  ): Promise<QuizGenerateOutcome> {
    const failed = (message: string | null): QuizGenerateOutcome => ({
      ok: false,
      added: 0,
      degraded: false,
      message
    })
    const kpId = activeKpId.value
    if (kpId.length === 0) return failed(mode === 'more' ? '还没有选关卡。' : null)

    const key = `${mode}#${stage ?? '-'}#${kpId}`
    if (generateInFlight !== null && generateInFlight.key === key) {
      return await generateInFlight.promise
    }
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      // 桥缺失：整块数据面不可用（这句话是给学生看的；自动路径静默）
      if (mode === 'more') moreError.value = lookup.message
      return failed(mode === 'more' ? lookup.message : null)
    }

    if (mode === 'more') {
      // 新的一次点击：把上一次的失败 / 降级说明收起来
      moreError.value = null
      moreNotice.value = null
    }

    // ★ 分段只对 auto 有意义（more 忽略它）：see AUTO_FIRST_BATCH 的说明。
    const request: QuizGenerateRequest =
      stage === undefined ? { kpId, context: buildDecisionTraces() } : { kpId, context: buildDecisionTraces(), stage }
    const seq = (generateSeq += 1)
    setGenerating(mode, true)
    const promise = (async (): Promise<QuizGenerateOutcome> => {
      try {
        const result =
          mode === 'auto'
            ? await lookup.bridge.generateQuizAuto(request)
            : await lookup.bridge.generateQuizMore(request)
        // ★ 迟到响应：序号对不上（切过关）或已不是当前关 → 丢弃，一个字段都不改
        if (seq !== generateSeq || activeKpId.value !== kpId) return failed(null)
        if (!result.ok) {
          const message = toStudentFacingMessage(result.message, { topic: 'quiz' })
          // ★★ 两条路都要有出口（2026-10-02）：auto 此前是静默吞掉，
          //   学生看到的是「答完了，没有新题，也没人解释」。
          if (mode === 'more') moreError.value = message
          else autoError.value = message
          return failed(message)
        }
        const view = readGenerateResponse(result.data)
        if (view.degraded) {
          // ★★ 两条路都说一句人话（2026-10-02 改判）：
          //   原口径是「自动路径静默吞掉」—— 但那等于学生等了几十秒、什么都没有，
          //   也不知道是"没出题"还是"出了题没显示"。学生必然会察觉的事情不能静默。
          if (mode === 'more') moreNotice.value = view.note ?? MORE_UNAVAILABLE_TEXT
          else autoNotice.value = view.note ?? MORE_UNAVAILABLE_TEXT
          return { ok: false, added: 0, degraded: true, message: view.note }
        }
        const added = appendGenerated(view.questions)
        if (added === 0) {
          // ★★ “ok:true 但一道题都没追加”必须有出口，否则按钮点下去**一声不吭**：
          //   主进程的回执与 quizGeneratedList 同形（`{ ok: true, data: null }`），
          //   承载不了「为什么没出题」——配额已满 / 当前没有可用模型 / 回来的题全与已有
          //   题干重复，在这边就是同一个形状。自动路径静默（后台加分动作不该给「做完一关」
          //   添坏消息）；按钮路径给一句**不指向具体原因**的行内说明。
          if (mode === 'more') moreNotice.value = view.note ?? MORE_EMPTY_TEXT
          else autoNotice.value = view.note ?? MORE_EMPTY_TEXT
          return { ok: false, added: 0, degraded: true, message: null }
        }
        return { ok: true, added, degraded: false, message: null }
      } catch (thrown) {
        if (seq !== generateSeq) return failed(null)
        const message = describeClientError(thrown, { topic: 'quiz' })
        if (mode === 'more') moreError.value = message
        else autoError.value = message
        return failed(message)
      } finally {
        // 只有仍然是「最后一次」的那次负责关掉自己的加载态（被顶掉的请求不许乱关）
        if (seq === generateSeq) setGenerating(mode, false)
      }
    })()
    generateInFlight = { key, promise }
    try {
      return await promise
    } finally {
      if (generateInFlight !== null && generateInFlight.promise === promise) generateInFlight = null
    }
  }

  /**
   * 自动追加（由 {@link submit} 判分返回后触发，见 {@link maybeAutoGenerate}）。
   *
   * ★★ 2026-10-02 改判：**分两段，先给第一段**，失败**必须**说话。
   *   原因见 AUTO_FIRST_BATCH 与 autoError 的说明（原口径是「静默」，
   *   而它是学生在"什么都没有"的状态下等几十秒、失败还不知情的来源）。
   */
  async function generateAuto(): Promise<QuizGenerateOutcome> {
    return await refreshAuto('first')
  }

  /**
   * 自动追加的**重试入口**（失败卡片上的「再试一次」）。
   *
   * ★ 从**第一段**重来：失败可能发生在任一段，而只有第一段成功过才谈得上"补余"。
   */
  async function retryAuto(): Promise<QuizGenerateOutcome> {
    autoError.value = null
    autoNotice.value = null
    return await refreshAuto('first')
  }

  /**
   * 发一段自动追加，成功且还有配额就顺手把下一段挂上（**不 await**）。
   *
   * ★ 为什么"不 await 第二段"：学生此刻已经能做第一段的题了，
   *   让第二段在后台补 —— 等他做完第一段（10 道），补余通常早回来了。
   * ★ 为什么失败就不补：目标总量已经把失败的段算进去了，接着要只会拿到"配额已满"的
   *   空成功，白跑一次模型调用。
   */
  async function refreshAuto(stage: 'first' | 'rest'): Promise<QuizGenerateOutcome> {
    const before = generated.value.length
    autoStarted.value = true
    autoPending.value += 1
    try {
      const outcome = await runGenerate('auto', stage)
      if (!outcome.ok) return outcome
      // 还有没有余量要补：主进程按「20 - 已有」定，这里只判"够不够再发一段"
      const remaining =
        AUTO_PHASE_LIMIT - (bank.value?.questions?.length ?? 0) - generated.value.length
      if (outcome.added > 0 && remaining > 0) {
        // ★ 刻意不 await：补余在后台跑，学生不必等它。
        void refreshAuto('rest')
      } else if (outcome.added === 0 && before === generated.value.length) {
        // 一道都没加（配额满 / 回来的题干全重复）：给一句说明，别让学生以为坏了。
        autoNotice.value = autoNotice.value ?? MORE_EMPTY_TEXT
      }
      return outcome
    } finally {
      autoPending.value = Math.max(0, autoPending.value - 1)
    }
  }

  /**
   * 「还想再练练」：生成一批续练题追加在列表尾部。
   *
   * ★ 返回结果给界面做行内状态（失败一句可读中文 + 重试），**不摆错误卡**。
   */
  async function generateMore(): Promise<QuizGenerateOutcome> {
    return await runGenerate('more')
  }

  /**
   * 判分之后顺手求值（**不开 watcher**，计划 §4.1）。
   *
   * ★ 派发时就把本关登记进 `autoFiredKp`：连击 / 重判都不会再发第二次。
   */
  function maybeAutoGenerate(): void {
    const kpId = activeKpId.value
    if (
      !shouldAutoGenerate(
        bank.value,
        attempts.value,
        autoFiredKp.value,
        kpId,
        AUTO_PHASE_LIMIT,
        generated.value.length
      )
    ) {
      return
    }
    autoFiredKp.value = kpId
    // 新的一次派发：把上一次的失败/降级说明收起来（重试后不该还挂着旧结论）
    autoError.value = null
    autoNotice.value = null
    void generateAuto()
  }

  /** 重做这一关（清掉本地作答状态；**不**清除已落库的判分结果）。 */
  function restart(): void {
    attempts.value = {}
    gradedCount.value = 0
    correctCount.value = 0
    // ★ 刻意**不**重置 `autoFiredKp`：做完了就是做完了，重做不该再白花一次生成（计划 §4.1）。
    //   清掉的只是「还想再练练」上一次的失败 / 降级说明（新一轮重新开始说）。
    moreError.value = null
    moreNotice.value = null
    // ★ 同上：auto 的说明也是「上一轮的结论」，重做这一关时收起来。
    //   ⚠️ 但 autoFiredKp **仍然不重置**（做完了就是做完了，重做不该再白花一次生成）。
    autoError.value = null
    autoNotice.value = null
  }

  return {
    progress,
    progressLoading,
    progressError,
    levels,
    pathLevels,
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
    allQuestions,
    autoFiredKp,
    autoGenerating,
    autoStarted,
    autoPending,
    autoError,
    autoNotice,
    retryAuto,
    moreGenerating,
    moreError,
    moreNotice,
    // 常量的 store 侧出口（与模块常量同一个值；界面两种取法都可以）
    autoPhaseLimit: AUTO_PHASE_LIMIT,
    moreBatch: MORE_BATCH,
    bridgeError,
    loadProgress,
    selectLevel,
    loadBank,
    loadGenerated,
    submit,
    generateAuto,
    generateMore,
    restart
  }
})
