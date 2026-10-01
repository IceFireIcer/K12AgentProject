/**
 * 画像与学段证据（Pinia）：对话右栏与学习档案页的**同一个数据源**。
 *
 * 四份数据，四个独立端点 —— 分开存、分开报错（一个挂了不该把另一个也打空）：
 *   - `profile`          `GET /api/profile/{id}`             掌握度 + 偏好 + 推荐点
 *   - `recommendation`   `GET /api/profile/{id}/recommendation`  「下一步学什么」+ 理由
 *   - `gradeSignals`     `GET /api/grade/signals/{id}`        当前学段 + 各信号分值
 *   - `gradeHistory`     `GET /api/grade/history/{id}`        学段变化轨迹（含来源）
 *
 * ★★ 这里**一个判定都不做**：掌握度怎么算、推荐谁、学段是推断还是手选 ——
 *   全部在 Python 侧完成（混合后端硬边界：数据域只在 Python）。
 *   本文件只负责「取回来、摆好、说清哪一份失败了」。
 *
 * ★ 为什么合并成一个 store：这四份数据的消费者高度重合（右栏、档案页、依赖图），
 *   而且它们的**新鲜度语义相同**（一轮对话结束后一起变旧）。
 *   按端点拆四个 store 会让「刷新」这件事要在四个地方各写一遍。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { describeClientError } from '../api/student-facing'
import {
  resolveDataBridge,
  type DataBridge,
  type GradeHistoryView,
  type GradeSignalsView,
  type ProfileView,
  type RecommendationView
} from '../api/data'

/** 四个分区各自的加载态与错误（分开放，一处失败不影响其它三处）。 */
export interface InsightSections {
  profile: boolean
  recommendation: boolean
  gradeSignals: boolean
  gradeHistory: boolean
}

/**
 * 主进程失败文案里的 HTTP 状态码（`读取失败（HTTP 404）：…`）。
 *
 * ★ 只在**归类**时读一次：渲染层不自己发 HTTP，但主进程的回执里带着状态码，
 *   而「404 = 还没有 / 500 = 服务端出错」这两种处境给学生的下一步完全不同。
 */
function statusOf(message: string): number | null {
  const match = /HTTP\s*(\d{3})/.exec(message)
  return match ? Number(match[1]) : null
}

/**
 * 一个分区的失败 → **学生看得懂的一句话**（P1-1 / P1-2）。
 *
 * 三种归类比原样直出更准，也各自对应一个真实处境：
 *   - **404**：这个学生**还没有**这份记录（冷启动最常见）。它不是「界面坏了」，
 *     所以给一句处境说明 + 下一步，而不是报错腔（P1-1：右栏曾直出
 *     `读取失败（HTTP 404）：还没有 student_001 的画像…`）。
 *   - **503**：本地数据服务（sidecar）不可用 —— 学生能做的只有等一会儿重试。
 *   - **其它（含 500）**：说「这次没读上来，稍后再试」，**绝不**把状态码摆上屏
 *     （P1-2：右栏曾直出 `读取失败（HTTP 500）：Internal Server Error`）。
 *
 * 认不出的文案仍过一遍 `toStudentFacingMessage` 的判据（含 HTTP 状态码 /
 * 服务器路径 / 内部 id 的一律换成中文），保证**任何一条**都不会原样印给学生。
 */
export function classifySectionError(
  section: keyof InsightSections,
  message: string
): string {
  const status = statusOf(message)
  if (status === 404) {
    // 「还没有」是空态语义，不是错误 —— 每个分区说自己的下一步。
    switch (section) {
      case 'profile':
        return '还没有练习记录。去闯关里做几道题，这里就会显示你的掌握度。'
      case 'recommendation':
        return '暂时还推不出下一步，先去对话里聊两句或做几道题。'
      case 'gradeSignals':
        return '还没攒到足够的判定依据，多聊几轮就会出现。'
      case 'gradeHistory':
        return '还没有发生过学段变化。'
    }
  }
  if (status === 503) {
    return '本地数据服务暂时不可用，请等几秒后重试。'
  }
  // ★ 500 与其它状态码走同一句：学生不需要知道「服务端哪里错了」，
  //   也不该看到任何 HTTP 状态码（原文进控制台，排查仍要看）。
  console.warn(`[insight] ${section} 读取失败（原始文案，仅排查用）：`, message)
  return '这次没能读上来，稍后再试一次。'
}

export const useInsightStore = defineStore('insight', () => {
  const profile = ref<ProfileView | null>(null)
  const recommendation = ref<RecommendationView | null>(null)
  const gradeSignals = ref<GradeSignalsView | null>(null)
  const gradeHistory = ref<GradeHistoryView | null>(null)

  const loading = ref<InsightSections>({
    profile: false,
    recommendation: false,
    gradeSignals: false,
    gradeHistory: false
  })
  const errors = ref<Record<keyof InsightSections, string | null>>({
    profile: null,
    recommendation: null,
    gradeSignals: null,
    gradeHistory: null
  })
  /** 桥整体缺失时的说明（与四个分区各自的错误分开：这是「没接线」，不是「取数失败」）。 */
  const bridgeError = ref<string | null>(null)

  /** 非响应式的在途标记：同一分区的并发请求只发一次。 */
  const inFlight = new Map<keyof InsightSections, Promise<void>>()

  /* ---------------------------------------------------------------- *
   * 派生视图（右栏与档案页共用的展示口径）
   * ---------------------------------------------------------------- */

  /** 掌握度列表（按分数降序；同分按 kpId 兜底 —— 不依赖服务端返回的顺序）。 */
  const masteryRows = computed(() => {
    const rows = profile.value?.mastery ?? []
    return [...rows].sort((a, b) => b.score - a.score || a.kpId.localeCompare(b.kpId))
  })

  /**
   * 「最近在学」：按**最近一次接触时间**倒序（与掌握度排序是两种口径）。
   *
   * ★ 为什么不是按分数排：右栏要回答的是「我最近在碰哪些东西」，不是「我哪里最熟」——
   *   后者在左边的概览分页里有全表（带排序、带导出）。
   * ★ 没有 `lastSeenAt` 的行（老数据 / 只判过分没记时间）排在最后：**不猜时间**。
   */
  const recentRows = computed(() => {
    const rows = profile.value?.mastery ?? []
    return [...rows].sort((a, b) => {
      const left = typeof a.lastSeenAt === 'number' ? a.lastSeenAt : 0
      const right = typeof b.lastSeenAt === 'number' ? b.lastSeenAt : 0
      return right - left || a.kpId.localeCompare(b.kpId)
    })
  })

  /** 评价性摘要：平均掌握度 / 已掌握（≥0.6）/ 待加强（<0.6）。 */  const masterySummary = computed(() => {
    const rows = masteryRows.value
    if (rows.length === 0) return { average: 0, mastered: 0, needWork: 0, total: 0 }
    const total = rows.reduce((sum, row) => sum + row.score, 0)
    // 0.6 这个阈值只用于**界面分档**（不是判分、不是推荐），
    // 与后端 `progress.stage == mastered` 不是一回事 —— 后者才是权威。
    return {
      average: total / rows.length,
      mastered: rows.filter((row) => row.score >= 0.6).length,
      needWork: rows.filter((row) => row.score < 0.6).length,
      total: rows.length
    }
  })

  /** 推荐下一步（没有推荐时整块不渲染，而不是显示一个空卡片）。 */
  const recommended = computed(() => {
    const items = recommendation.value?.items ?? []
    return items.length > 0 ? items[0] : null
  })

  /** 学段推断的置信度（0–1）；没有信号时为 `null`。 */
  const confidence = computed(() => gradeSignals.value?.confidence ?? null)

  /** 学段轨迹（**倒序**：最近一次变化在最上面）。 */
  const historyDesc = computed(() => {
    const entries = gradeHistory.value?.entries ?? []
    return [...entries].reverse()
  })

  /* ---------------------------------------------------------------- *
   * 取数
   * ---------------------------------------------------------------- */

  /** 四个分区全部拉一遍（档案页 / 右栏展开时用）。 */
  async function loadAll(): Promise<void> {
    await Promise.all([loadProfile(), loadRecommendation(), loadGradeSignals(), loadGradeHistory()])
  }

  async function loadProfile(force = false): Promise<void> {
    await loadSection('profile', force, async (bridge) => {
      const result = await bridge.readProfile()
      if (result.ok) profile.value = result.data as ProfileView
      return result
    })
  }

  async function loadRecommendation(force = false): Promise<void> {
    await loadSection('recommendation', force, async (bridge) => {
      const result = await bridge.readRecommendation()
      if (result.ok) recommendation.value = result.data as RecommendationView
      return result
    })
  }

  async function loadGradeSignals(force = false): Promise<void> {
    await loadSection('gradeSignals', force, async (bridge) => {
      const result = await bridge.readGradeSignals()
      if (result.ok) gradeSignals.value = result.data as GradeSignalsView
      return result
    })
  }

  async function loadGradeHistory(force = false): Promise<void> {
    await loadSection('gradeHistory', force, async (bridge) => {
      const result = await bridge.readGradeHistory()
      if (result.ok) gradeHistory.value = result.data as GradeHistoryView
      return result
    })
  }

  /**
   * 单个分区的取数骨架。
   *
   * ★ 三个「不」：不抛异常、不覆盖旧数据（取失败时保留上一次的，界面不停在空白）、
   *   不并发重复发（同一分区的在途请求只发一次 —— 右栏与档案页会同时挂载）。
   * ★★ 失败文案**在这一层就归类成学生话**（P1-1 / P1-2）：主进程回的是
   *   `读取失败（HTTP 404）：还没有 student_001 的画像…` 这种排查口径，
   *   里面有 HTTP 状态码与内部学生 id —— 它此前被右栏原样直出（学生面直接看到
   *   `student_001`）。归类放在 store（而不是各消费点）是刻意的：右栏与档案页
   *   读的是同一个 `errors`，两处各写一份判据必然漂移。
   */
  async function loadSection(
    section: keyof InsightSections,
    force: boolean,
    run: (bridge: DataBridge) => Promise<
      { ok: true; data: unknown } | { ok: false; message: string }
    >
  ): Promise<void> {
    const pending = inFlight.get(section)
    if (pending) return await pending
    if (!force && !loading.value[section] && errors.value[section] === null && hasData(section)) return

    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bridgeError.value = null

    loading.value = { ...loading.value, [section]: true }
    errors.value = { ...errors.value, [section]: null }
    const task = (async () => {
      try {
        const result = await run(lookup.bridge)
        if (!result.ok) {
          errors.value = { ...errors.value, [section]: classifySectionError(section, result.message) }
        }
      } catch (thrown) {
        // ★ 异常也走同一套归类（连接失败 / 超时 → 可读中文），不留英文原文。
        errors.value = {
          ...errors.value,
          [section]: describeClientError(thrown)
        }
      } finally {
        loading.value = { ...loading.value, [section]: false }
        inFlight.delete(section)
      }
    })()
    inFlight.set(section, task)
    await task
  }

  /** 该分区是否已经有数据（决定 `force=false` 时要不要重新取）。 */
  function hasData(section: keyof InsightSections): boolean {
    switch (section) {
      case 'profile':
        return profile.value !== null
      case 'recommendation':
        return recommendation.value !== null
      case 'gradeSignals':
        return gradeSignals.value !== null
      case 'gradeHistory':
        return gradeHistory.value !== null
    }
  }

  return {
    profile,
    recommendation,
    gradeSignals,
    gradeHistory,
    loading,
    errors,
    bridgeError,
    masteryRows,
    recentRows,
    masterySummary,
    recommended,
    confidence,
    historyDesc,
    loadAll,
    loadProfile,
    loadRecommendation,
    loadGradeSignals,
    loadGradeHistory
  }
})
