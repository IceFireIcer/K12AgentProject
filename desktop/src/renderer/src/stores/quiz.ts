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
  type QuizBankView,
  type QuizProgressView,
  type QuizResultView
} from '../api/data'

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

  /** 按 `qid` 存作答状态（翻回上一题时状态还在）。 */
  const attempts = ref<Record<string, QuizAttempt>>({})
  /** 本页判分过的题目数（用于「本轮小结」；**不编造历史记录**）。 */
  const gradedCount = ref(0)
  const correctCount = ref(0)

  const bridgeError = ref<string | null>(null)
  /** 非响应式：同一知识点的并发取题只发一次。 */
  let bankInFlight: Promise<void> | null = null

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

  /** 已锁的关卡不能进（服务端判的，这里只是照着禁用按钮）。 */
  const activeLocked = computed(() => activeStage.value === 'locked')

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
      if (result.ok) progress.value = result.data as QuizProgressView
      else progressError.value = result.message
    } catch (thrown) {
      progressError.value = thrown instanceof Error ? thrown.message : String(thrown)
    } finally {
      progressLoading.value = false
    }
  }

  /**
   * 选一关并取题。
   *
   * ★ 锁着的关卡**当场拒绝**（不发给后端）：后端的学段与阶段隔离是权威，
   *   但让一个明显点不动的按钮发出请求，会在界面上留下一次无意义的失败。
   */
  async function selectLevel(kpId: string): Promise<void> {
    const level = levels.value.find((item) => item.kpId === kpId)
    if (level?.stage === 'locked') {
      bankError.value = '这一关还没解锁 —— 先把前面的关卡过掉。'
      return
    }
    activeKpId.value = kpId
    attempts.value = {}
    gradedCount.value = 0
    correctCount.value = 0
    await loadBank(kpId)
  }

  /** 取某知识点的题目（默认 3 道；数量由主进程校验上限）。 */
  async function loadBank(kpId: string, count = 3): Promise<void> {
    if (bankInFlight) return await bankInFlight
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bankLoading.value = true
    bankError.value = null
    bankInFlight = (async () => {
      try {
        const result = await lookup.bridge.readQuizBank({ kpId, count })
        bank.value = result.ok ? (result.data as QuizBankView) : null
        if (!result.ok) bankError.value = result.message
      } catch (thrown) {
        bankError.value = thrown instanceof Error ? thrown.message : String(thrown)
      } finally {
        bankLoading.value = false
        bankInFlight = null
      }
    })()
    await bankInFlight
  }

  /**
   * 提交一题并判分。
   *
   * ★ 判分**只在后端**：这里拿回来的 `correct` / `feedback` / `masteryDelta` 是权威结论。
   * ★ 防连点：同一题提交中直接返回（连点会判两次、写两次掌握度）。
   * ★ 判完顺手刷新进度与画像 —— 刚过的那一关应该立刻在关卡列表里变样，
   *   而不是等学生自己再点一次刷新。
   */
  async function submit(qid: string, answer: string): Promise<void> {
    const existing = attempts.value[qid]
    if (existing?.submitting) return
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
          [qid]: { qid, answer: trimmed, result: null, submitting: false, error: result.message }
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
          error: thrown instanceof Error ? thrown.message : String(thrown)
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
    activeLocked,
    bank,
    bankLoading,
    bankError,
    attempts,
    gradedCount,
    correctCount,
    accuracy,
    bridgeError,
    loadProgress,
    selectLevel,
    loadBank,
    submit,
    restart
  }
})
