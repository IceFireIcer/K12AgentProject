<script setup lang="ts">
/**
 * 学习档案 · **概览**（学习报告 + 学情概览，学生 / 家长视图）。
 *
 * 这一页是两份东西的**合体**（用户裁决：合并进既有的 report 分页，不新开第六个分页）：
 *
 * ① 原有的**学习报告**：四张统计磁贴、每日明细、掌握度、章节进度、闯关计数、学段轨迹
 *    —— 数据来自 `GET /api/profile/{id}/report`（`stores/study.ts`）。
 * ② 原型里的**概览**：平均掌握度、近 N 日学习量图、继续学习（推荐）、逐关进度、
 *    学段判定信号、学段变化时间线 —— 数据来自 `useInsightStore`
 *    （画像 / 推荐 / 学段信号 / 学段轨迹）与 `useQuizStore`（闯关进度）。
 *
 * ---------------------------------------------------------------------------
 * 四条纪律（改这一页之前先读）
 * ---------------------------------------------------------------------------
 * 1. ★ **一个数都不自己编**：原型里写死的 `weeklyActivity` / `recommendation` /
 *    `progressRows` 三块**全部换成端点数据**；某块端点没数据时给**如实空态**
 *    （说清「为什么空、怎么才会有」），绝不摆一个假数字。
 * 2. ★ **不在这里算「下一步」**：推荐有唯一出口（`/api/profile/{id}/recommendation`），
 *    本页只展示它。自己按掌握度推一条出来，就会与对话里给出的建议不一致。
 * 3. ★ **聚合与判定都在 Python**（混合后端硬边界）：掌握度平均与分档、推荐的来源与理由、
 *    学段信号与轨迹、闯关阶段全部由服务端算好，本页只做百分比/时间的**格式化**。
 * 4. ★ **导航只有一处真相**：`stores/ui.ts`（本项目**没有** vue-router）。
 *    跨页跳转一律走 `ui.go(...)` / `ui.showStudy(...)`，不编路由串。
 *
 * ⚠️ **学习量图只画数据里有的维度**：`LearningReport.daily` 每行只有
 *    `count / quizCount / correctCount` 三个数（没有「问答 / 动画 / 编程」的分类，
 *    那是原型 mock 才有的字段），所以这张图是「其他活动 / 练习未答对 / 练习答对」三段，
 *    **不虚构动画 / 编程的拆分**（没有数据源的色块画出来就是假统计）。
 *
 * ⚠️ 导出仍走 `study.exportReport()`（Markdown 拼装在纯函数 `./report-markdown.ts`）。
 */
import { computed, onMounted, ref } from 'vue'
import { useStudyStore, REPORT_DAY_OPTIONS } from '../stores/study'
import { useInsightStore, type InsightSections } from '../stores/insight'
import { useQuizStore } from '../stores/quiz'
import { useKnowledgeStore } from '../stores/knowledge'
import { useChatStore } from '../stores/chat'
import { useUiStore } from '../stores/ui'
import {
  SIGNAL_TYPE_LABELS,
  STAGE_LABELS,
  formatMs,
  masteryLabel,
  summaryLine
} from './report-markdown'
import { kpLabel, UNKNOWN_KP_LABEL } from './kp-label'
import TeacherGate from '../components/TeacherGate.vue'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL, gradeOriginLabel } from '../labels'
// `GradeOrigin` 的唯一来源是 `main/ipc/channels.ts`，由 `api/grade.ts` re-export
// （与 labels.ts 同一写法）；`GradeSignalsView` 是生成物别名，在 `api/data.ts`。
import type { GradeOrigin } from '../api/grade'
import type { GradeSignalsView } from '../api/data'
import type { GradeLevel } from '@shared/ipc-events'

defineOptions({ name: 'StudyReportTab' })

const study = useStudyStore()
const insight = useInsightStore()
const quiz = useQuizStore()
const knowledge = useKnowledgeStore()
const chat = useChatStore()
const ui = useUiStore()

const report = computed(() => study.report)
const gradeLabel = computed(() => {
  const level = report.value?.gradeLevel
  return level ? (GRADE_LABELS[level] ?? level) : GRADE_UNKNOWN_LABEL
})
/**
 * 「当前学段是怎么定下来的」——取 `chat.gradeOrigin`（主进程推来的**实时**值）。
 *
 * ⚠️ 这里曾经写死一句「由系统自动判定」：D-037 之后学生可以手动指定学段，
 *    那句话在手动选中后就成了一句假话。中文说法一律交给 `gradeOriginLabel()`
 *    （唯一实现，指示器与设置页也调它），本文件不写第二份映射。
 */
const gradeOrigin = computed(() => gradeOriginLabel(chat.gradeOrigin))
const summary = computed(() =>
  report.value ? summaryLine(report.value, study.reportDays) : ''
)

/** 掌握度条形宽度（0..1 → 百分比；**只用于显示**，不参与任何判定）。 */
function barWidth(score: number): string {
  const clamped = Math.max(0, Math.min(1, score))
  return `${Math.round(clamped * 100)}%`
}

/** 0..1 的比值 → 整数百分比（界面上不写 62.0000001%）。 */
function percentOf(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(1, value)) * 100)
}

/* ------------------------------------------------------------------ *
 * 概览 hero：平均掌握度（`insight.masterySummary`，服务端算好的展示口径）
 * ------------------------------------------------------------------ */

const masterySummary = computed(() => insight.masterySummary)
const hasMastery = computed(() => insight.masterySummary.total > 0)
const masteryAveragePercent = computed(() => percentOf(insight.masterySummary.average))

/* ------------------------------------------------------------------ *
 * 近 N 日学习量（只画 `report.daily` 里真实存在的三个数）
 * ------------------------------------------------------------------ */

interface DayBar {
  day: string
  total: number
  /** 练习（`quizCount`，是 `count` 的子集）。 */
  quiz: number
  /** 练习里没答对的次数（`quizCount - correctCount`）。 */
  quizWrong: number
  /** 练习里答对的次数（`correctCount`，是 `quizCount` 的子集）。 */
  correct: number
  /** 其他活动（`count - quizCount`：问答 / 动画 / 编程…混在一起，端点没给分类）。 */
  other: number
}

/**
 * 把 `report.daily` 铺成**整段窗口**的柱子。
 *
 * ★ 为什么需要这一步：`store.daily_activity()` 是 `GROUP BY day` —— **只有有记录的那几天**
 *   才会出现在 `daily` 里。窗口设 7 天而学生只学了 2 天时，直接铺出来只有 2 根柱子，
 *   看起来既不像「近 7 天」，也看不出「中间断了几天」。服务端在 `routes/study.py`
 *   的注释里就写明「前端也拿到 daily 明细，可以自己铺满整周」。
 *
 * ★ 补出来的那些天是 **0，不是编的数字**：那一天在窗口内没有任何学习记录，
 *   事实就是 0 次活动 —— 这与「假统计」的区别在于：数据源没给的维度
 *   （动画 / 编程的分类）一律不画，而**已知为空的日期格**补 0 只是把窗口对齐。
 *
 * ⚠️ 窗口锚点用**服务端的 `generatedAt`**（不读本机时钟）：同一份数据任何时候铺出来都一样。
 *    锚点不可用时（0 / 非有限）**退化成只画真实行**，不猜一个日期出来。
 */
function windowDays(): string[] {
  const value = report.value
  if (!value) return []
  const anchor = value.generatedAt
  if (!Number.isFinite(anchor) || anchor <= 0) return []
  const length = Math.max(1, Math.floor(value.days) || 1)
  const base = new Date(anchor)
  if (Number.isNaN(base.getTime())) return []
  const days: string[] = []
  for (let back = length - 1; back >= 0; back -= 1) {
    // 用 Date 的日溢出（负数也认）做减法：跨月 / 跨年 / 夏令时都由它自己算对，
    // 手写 `- back * 86400000` 会在夏令时那两个小时上把日期挪错一天。
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() - back)
    const pad = (n: number): string => String(n).padStart(2, '0')
    days.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`)
  }
  return days
}

const dayBars = computed<DayBar[]>(() => {
  const daily = report.value?.daily ?? []
  // 窗口 + 「窗口外但仍被端点返回的行」：
  // 服务端的下界是 `ts >= now - days * 86400`（含边界），所以窗口第一天**之前**的
  // 那几个小时里的记录确实会落在日期窗口之外 —— 丢掉它们就是丢真实数据。
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const day of [...windowDays(), ...daily.map((row) => row.day)]) {
    if (seen.has(day)) continue
    seen.add(day)
    ordered.push(day)
  }
  // 升序（`YYYY-MM-DD` 的字典序就是时间序）：图从左到右必须是时间前进，
  // 所以窗口外那几天也是**插回原位**，不是甩到最右边。
  ordered.sort()
  const rows = new Map(daily.map((row) => [row.day, row]))
  return ordered.map((day) => {
    const row = rows.get(day)
    const count = row?.count ?? 0
    const quizCount = row?.quizCount ?? 0
    const correctCount = row?.correctCount ?? 0
    return {
      day,
      total: count,
      quiz: quizCount,
      quizWrong: Math.max(0, quizCount - correctCount),
      correct: Math.max(0, correctCount),
      other: Math.max(0, count - quizCount)
    }
  })
})

const weeklyTotal = computed(() => dayBars.value.reduce((sum, bar) => sum + bar.total, 0))
const maxDayTotal = computed(() => dayBars.value.reduce((max, bar) => Math.max(max, bar.total), 0))

/** 峰值日：整段全为 0 时**没有峰值**（取 max 会得到 0，得先排除），此时不标「峰值」。 */
const peakDay = computed(() => {
  if (maxDayTotal.value <= 0) return null
  return dayBars.value.find((bar) => bar.total === maxDayTotal.value) ?? null
})

/** 柱高：按「这 N 天里最大的一天」归一。⚠️ 除零保护 —— 全为 0 时返回 0%（不是 NaN）。 */
function barHeight(value: number): string {
  const max = maxDayTotal.value
  if (max <= 0 || value <= 0) return '0%'
  return `${Math.round((value / max) * 100)}%`
}

/**
 * 柱子上的悬停说明：**三个真实数字都写出来**（图上只画高度）。
 *
 * ★ 口径只能是端点真有的三个数（`count` / `quizCount` / `correctCount`）。
 *   这里此前写的是「活动 N 次 · 练习 N 次（答对 N 次）」—— 对着数还得自己换算。
 *   现在换成一句人话：「17日：8 次活动，其中 5 道练习题，答对 4 道」。
 *   ⚠️ **不许编出「阅读 N 篇」**这类字段：端点的日聚合里没有内容分类，
 *      数据里没有的东西不能在悬停文字里出现（那就是假统计）。
 */
function barTitle(bar: DayBar): string {
  const parts = [`${friendlyDay(bar.day)}：${bar.total} 次活动`]
  if (bar.quiz > 0) parts.push(`其中 ${bar.quiz} 道练习题，答对 ${bar.correct} 道`)
  else parts.push('这天没有做练习题')
  return parts.join('，')
}

/** `2026-09-17` → `9月17日`（悬停文字里写完整年份只会让人多读四个字，跨月时又不歧义）。 */
function friendlyDay(day: string): string {
  const parts = day.split('-')
  if (parts.length !== 3) return day
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

/** 日期标签只留「日」：14/30 天的窗口下，完整日期会把柱子挤没。 */
function dayLabel(day: string): string {
  const parts = day.split('-')
  return parts.length === 3 ? parts[2] : day
}

const chartLabel = computed(
  () =>
    `近 ${study.reportDays} 天每日学习量柱状图：每根柱子是一天的活动总量，` +
    '分「其他活动 / 练习未答对 / 练习答对」三段。'
)

/* ------------------------------------------------------------------ *
 * 继续学习（推荐卡）
 * ------------------------------------------------------------------ */

const recommended = computed(() => insight.recommended)

/**
 * 推荐知识点的显示名。
 *
 * 服务端取不到名字时会**回落成 kp_id**（`entry_names.get(kp_id, kp_id)`）——
 * 那种情况下再试教材清单里的中文名。
 * ★ 两边都没有时给**中性标签**（`未命名知识点`）而不是 slug：推荐位是学生一眼要读的地方，
 *   一串 `jr-py-data-features` 摆在那儿看起来就像报错；原始 id 仍进 `title`。
 *   口径与唯一实现在 `study/kp-label.ts`（错题本、地图、章节进度共用同一份）。
 */
const recommendedName = computed(() => {
  const item = recommended.value
  if (!item) return ''
  if (item.name && item.name !== item.kpId) return item.name
  return nameOf(item.kpId)
})

/**
 * 推荐卡的落点 —— **都用真实的导航动作**，不编路由串：
 *   - `source === 'review'`（优先重练）：去**错题本**看错在哪儿；
 *   - 其余（依赖图推进 / 冷启动）：去**闯关**检验。
 * 两个落点都是既有页面（`stores/ui.ts` 的 `go` / `showStudy`），不新增页面。
 */
const recommendsReview = computed(() => insight.recommendation?.source === 'review')
const recommendationCta = computed(() => (recommendsReview.value ? '去错题本再练' : '去闯关检验'))

function openRecommendation(): void {
  if (recommendsReview.value) ui.showStudy('mistakes')
  else ui.go('quiz')
}

/** 没有推荐条目时的**如实**说明：服务端给的总述优先（它说清了「为什么没有」）。 */
const recommendationEmpty = computed(
  () =>
    insight.recommendation?.summary ||
    '暂时没有推荐 —— 先在对话里聊几句，系统会按依赖图与掌握度给出下一步。'
)

/* ------------------------------------------------------------------ *
 * 学段依据：判定信号 + 变化轨迹
 * ------------------------------------------------------------------ */

/**
 * 四类信号的**固定展示顺序**（契约 `GradeSignalType` 的四个字面量）。
 * ★ 顺序不由服务端返回顺序决定：那是「最近 N 条读数」的时间序
 *   （`recent_signals`，升序、上限 20 条），同一类型会出现很多次 ——
 *   直接铺开会既重复又不稳定，而卡片的口径是「按类型看当前依据」。
 */
const SIGNAL_TYPE_ORDER = ['vocab', 'depth', 'quiz_perf', 'meta_cognition'] as const

type SignalRow = NonNullable<GradeSignalsView['signals']>[number]

/** 全部读数条数（卡片下如实说明「这里每类只显示最近一次」）。 */
const signalReadingCount = computed(() => insight.gradeSignals?.signals?.length ?? 0)

/**
 * 判定信号：**每类取最近一次读数**（最多 4 张卡）。
 *
 * ★ 归并是**展示选择**，不产生任何判定：后出现的覆盖先出现的（时间升序 → 最新的赢）。
 * ★ 契约外的未知类型**照常显示**（排在四类之后），不静默丢掉。
 */
const signals = computed<SignalRow[]>(() => {
  const latest = new Map<string, SignalRow>()
  for (const row of insight.gradeSignals?.signals ?? []) latest.set(row.signalType, row)
  const ordered: SignalRow[] = []
  for (const type of SIGNAL_TYPE_ORDER) {
    const row = latest.get(type)
    if (row) ordered.push(row)
  }
  for (const [type, row] of latest) {
    if (!(SIGNAL_TYPE_ORDER as readonly string[]).includes(type)) ordered.push(row)
  }
  return ordered
})

const confidencePercent = computed(() => {
  const value = insight.confidence
  return value === null ? null : percentOf(value)
})
function signalLabel(signalType: string): string {
  return SIGNAL_TYPE_LABELS[signalType] ?? signalType
}

/**
 * 学段轨迹（**最近一次在最上面**）。
 *
 * ★ 两份数据来自**同一张 `grade_history` 表**的两个端点（报告的 `gradeHistory` 是正序，
 *   学段端点的 `historyDesc` 是倒序）—— 不是两个真相，所以这里只用**一条**渲染路径：
 *   优先用 `insight.historyDesc`（带 `source`，正是这一版要展示的字段），
 *   它读失败（没接线 / 端点报错）时退回报告里那份，**顺序统一成倒序**。
 */
const gradeTrail = computed(() => {
  const rows = insight.historyDesc
  if (rows.length > 0) return rows
  return [...(report.value?.gradeHistory ?? [])].reverse()
})

function trailFrom(level: GradeLevel | null | undefined): string {
  return level ? (GRADE_LABELS[level] ?? level) : '（初始）'
}

/**
 * `grade_history.source` 是**宽松文本**（契约里 `GradeHistoryEntry.source` 就是 `string`）——
 * 认不出的取值按「非手动」处理（与后端 `_contract_source` 同一口径），
 * 中文说法一律交给 `gradeOriginLabel()`（唯一实现），这里不写第二份映射。
 */
function originOf(source: string): GradeOrigin | null {
  return source === 'explicit' || source === 'inferred' || source === 'default' ? source : null
}

/* ------------------------------------------------------------------ *
 * 闯关进度（`quiz.levels` —— 服务端已按依赖图拓扑序排好，**不重排**）
 * ------------------------------------------------------------------ */

const quizLevels = computed(() => quiz.levels)
const quizSummary = computed(() => ({
  total: quiz.levels.length,
  mastered: quiz.levels.filter((level) => level.stage === 'mastered').length
}))

type TagType = 'primary' | 'success' | 'warning' | 'info'
const STAGE_TAGS: Record<string, TagType> = {
  locked: 'info',
  learning: 'warning',
  quizzed: 'primary',
  mastered: 'success'
}
function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}
function stageTag(stage: string): TagType {
  return STAGE_TAGS[stage] ?? 'info'
}

/**
 * kp_id → 知识点中文名。
 *
 * ⚠️ 闯关进度与掌握度都只给 `kpId`，而界面上不该只摆 `jr-py-data-features` 这种标识。
 *    名字来自**教材知识点清单**（与闯关页 `views/Quiz.vue` 同一个来源、同一个 `kb.sqlite`）。
 * ★ 取不到名字时给**中性标签**（`未命名知识点`）而不是 slug —— 那多半是上一代教材
 *   留下的残留行（`learning.db` 按学生长期保留），把 slug 摆给学生看像报错。
 *   原始 id 仍然进 `title`（悬停可见），所以排障/答辩一点信息都没少。
 *   完整口径与唯一实现在 `study/kp-label.ts`。
 */
const kpNames = computed(() => {
  const map = new Map<string, string>()
  for (const point of knowledge.points?.points ?? []) map.set(point.kpId, point.name)
  return map
})

function nameOf(kpId: string): string {
  return kpLabel(kpId, null, (id) => kpNames.value.get(id) ?? null)
}

/** 名字是否真的取到了（取不到时把原始 id 放进 `title`，见 `study/kp-label.ts`）。 */
function nameResolved(kpId: string): boolean {
  return nameOf(kpId) !== UNKNOWN_KP_LABEL
}

/* ------------------------------------------------------------------ *
 * 概览分区的失败与刷新
 * ------------------------------------------------------------------ */

/** 概览四块数据的名字（失败说明里用：学生要能看出是**哪一块**没读上来）。 */
const INSIGHT_SECTIONS: ReadonlyArray<{ key: keyof InsightSections; label: string }> = [
  { key: 'profile', label: '掌握度画像' },
  { key: 'recommendation', label: '推荐' },
  { key: 'gradeSignals', label: '学段信号' },
  { key: 'gradeHistory', label: '学段轨迹' }
]

/**
 * 概览部分失败的**一句话**（桥缺失优先：那是「没接线」，不是「取数失败」）。
 * ★ 不用它挡住整页：报告本身由另一个端点提供，一块挂了不该让整页空掉。
 */
const insightIssue = computed(() => {
  if (insight.bridgeError) return insight.bridgeError
  const failures = INSIGHT_SECTIONS.map(({ key, label }) => ({
    label,
    message: insight.errors[key]
  })).filter((item) => item.message !== null)
  if (failures.length === 0) return ''
  return failures.map((item) => `${item.label}：${item.message}`).join('；')
})

/** 刷新中（本页自己的 busy 标记：`el-button` 的 loading 与禁用都读它）。 */
const refreshing = ref(false)

/**
 * **真实刷新**：把这一页消费的四份数据重新取一遍（都是 store 的动作，不在这里发请求）。
 *
 * ★ 原型那个「点一下 → 显示『已是最新』→ 1.6 秒后恢复」的假刷新**已删除**：
 *   它连数据都不重取，按钮按下去只是演了一遍动画。
 * ★ 四份取数**互不依赖**，并行发；每一个都自己捕获失败并写成可读中文（不抛异常）。
 * ★ `quiz.loadProgress(true)` 是显式刷新，必须 `force` —— store 的默认值是「已有数据就不取」。
 */
async function refresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await Promise.all([
      study.loadReport(),
      insight.loadAll(),
      quiz.loadProgress(true),
      knowledge.loadPoints()
    ])
  } finally {
    refreshing.value = false
  }
}

onMounted(() => {
  // 学习报告本身由 `views/Study.vue` 在进入档案页时取（那一层负责四个区块），这里不重复。
  // 本页新消费的三份数据在这里补上 —— 三者都是**幂等**的（有缓存 / 在途去重，不会重复打请求）：
  //   · 画像与学段：右栏与推荐位的同一个数据源；
  //   · 闯关进度：`levels` 是服务端拓扑序，本页只读；
  //   · 知识点清单：只为把 kp_id 显示成知识点名（取不到就退回 kp_id）。
  void insight.loadAll()
  void quiz.loadProgress()
  void knowledge.loadPoints()
})
</script>

<template>
  <section class="tab-body" data-testid="study-report">
    <div class="toolbar">
      <div class="toolbar__group">
        <span class="toolbar__label">时间范围</span>
        <button
          v-for="days in REPORT_DAY_OPTIONS"
          :key="days"
          class="chip"
          type="button"
          :class="{ 'chip--on': days === study.reportDays }"
          :data-testid="`report-days-${days}`"
          @click="study.loadReport(days)"
        >
          近 {{ days }} 天
        </button>
      </div>
      <div class="toolbar__actions">
        <el-button
          :loading="refreshing"
          :disabled="refreshing"
          data-testid="report-refresh"
          @click="refresh()"
        >
          {{ refreshing ? '刷新中…' : '刷新' }}
        </el-button>
        <el-button
          :loading="study.exporting"
          :disabled="!report || study.exporting"
          data-testid="report-export"
          @click="study.exportReport()"
        >
          导出 Markdown
        </el-button>
      </div>
    </div>

    <p v-if="study.exportNotice" class="notice" data-testid="report-export-notice">
      {{ study.exportNotice }}
    </p>

    <p v-if="study.loading.report" class="state" data-testid="report-loading">正在汇总学习记录…</p>
    <p v-else-if="study.errors.report" class="state state--error" data-testid="report-error">
      {{ study.errors.report }}
    </p>

    <template v-else-if="report">
      <!-- 概览 hero：全页唯一的 22px（平均掌握度）。其余数字一律 16px 及以下。 -->
      <div class="hero" data-testid="report-hero">
        <div class="hero__top">
          <div class="hero__id">
            <p class="hero__name">{{ report.nickname || report.studentId }}</p>
            <p class="hero__grade">近 {{ study.reportDays }} 天的学习报告</p>
          </div>
          <div class="hero__mastery">
            <p class="hero__num k12-num" data-testid="report-mastery-average">
              <!-- 没有掌握度时不摆一个「0%」：那会被读成「全都没学会」，是假结论 -->
              <template v-if="hasMastery"
                >{{ masteryAveragePercent }}<span class="hero__unit">%</span></template
              >
              <template v-else>—</template>
            </p>
            <p class="hero__cap" data-testid="report-mastery-summary">
              <template v-if="hasMastery">
                平均掌握度 · 共 {{ masterySummary.total }} 个知识点（已掌握 {{ masterySummary.mastered }} ·
                待加强 {{ masterySummary.needWork }}）
              </template>
              <template v-else>还没有掌握度记录 —— 做几道题之后这里会显示平均掌握度</template>
            </p>
          </div>
        </div>
      </div>

      <!-- 概览部分取数失败：如实说清哪一块没读上来，但**不遮住**报告本身 -->
      <p v-if="insightIssue" class="state state--warn" data-testid="report-insight-error">
        概览的部分数据没读上来（下面的报告不受影响）：{{ insightIssue }}
      </p>

      <div class="cards">
        <div class="card">
          <p class="card__label">学习活动</p>
          <p class="card__value k12-num" data-testid="report-total">{{ report.totalActivities }}</p>
          <p class="card__hint">近 {{ study.reportDays }} 天</p>
        </div>
        <div class="card">
          <p class="card__label">练习题</p>
          <p class="card__value k12-num" data-testid="report-quiz">
            {{ report.quizCorrect }}/{{ report.quizTotal }}
          </p>
          <p class="card__hint">
            {{
              report.quizTotal > 0
                ? `正确率 ${Math.round((report.quizCorrect / report.quizTotal) * 100)}%`
                : '还没有作答'
            }}
          </p>
        </div>
        <div class="card">
          <p class="card__label">连续学习</p>
          <p class="card__value k12-num" data-testid="report-streak">{{ report.streakDays }} 天</p>
          <p class="card__hint">{{ report.todayStudied ? '今天已学习' : '今天还没开始' }}</p>
        </div>
        <div class="card">
          <p class="card__label">当前学段</p>
          <p class="card__value" data-testid="report-grade">{{ gradeLabel }}</p>
          <!-- 来源取自主进程推来的实时值：手动选中 / AI 引擎推算（唯一实现是 gradeOriginLabel） -->
          <p class="card__hint">{{ gradeOrigin }}</p>
        </div>
      </div>

      <p class="summary" data-testid="report-summary">{{ summary }}</p>

      <!-- 继续学习：推荐来自唯一出口（/recommendation），本页不算、只展示 -->
      <h3 class="section">继续学习</h3>
      <div v-if="recommended" class="reco" data-testid="report-recommendation">
        <span class="reco__pill" :title="recommended.kpId">{{ recommendedName }}</span>
        <p class="reco__desc">{{ recommended.reason }}</p>
        <span class="reco__meta k12-num">当前掌握度 {{ percentOf(recommended.mastery) }}%</span>
        <el-button
          type="primary"
          size="small"
          data-testid="report-recommendation-cta"
          @click="openRecommendation()"
        >
          {{ recommendationCta }}
        </el-button>
      </div>
      <p v-else class="state" data-testid="report-recommendation-empty">
        {{ recommendationEmpty }}
      </p>

      <!-- 每日学习：图 + 表。★ 图只画 daily 里有的三个数，不虚构动画/编程的分类。 -->
      <h3 class="section">每日学习</h3>
      <p v-if="report.daily.length === 0" class="state">这段时间还没有学习记录。</p>
      <template v-else>
        <div class="chart" data-testid="report-activity-chart">
          <div class="chart__head">
            <span class="chart__title">近 {{ study.reportDays }} 天学习量</span>
            <span class="chart__meta k12-num" data-testid="report-activity-summary">
              合计 {{ weeklyTotal }} 次<template v-if="peakDay">
                · 峰值 {{ peakDay.day }}（{{ peakDay.total }} 次）</template
              >
            </span>
          </div>
          <div class="chart__bars" role="img" :aria-label="chartLabel">
            <div
              v-for="bar in dayBars"
              :key="bar.day"
              class="chart__bar"
              :data-testid="`report-activity-${bar.day}`"
              :title="barTitle(bar)"
            >
              <span class="chart__stack">
                <span class="chart__seg chart__seg--other" :style="{ height: barHeight(bar.other) }"></span>
                <span class="chart__seg chart__seg--wrong" :style="{ height: barHeight(bar.quizWrong) }"></span>
                <span class="chart__seg chart__seg--ok" :style="{ height: barHeight(bar.correct) }"></span>
              </span>
              <span class="chart__day">{{ dayLabel(bar.day) }}</span>
            </div>
          </div>
          <div class="legend">
            <!-- 图例顺序 = 柱子里从上到下的分段顺序（对不上会让人以为读到别的色块）。
                 ★ 每段的色块与柱子里那一段**同款**（含「练习没答对」的斜纹）：
                   颜色不是唯一的区分手段，灰度打印或色觉差异下三段照样分得开。 -->
            <span class="legend__i"><i class="dot dot--other" aria-hidden="true"></i>其他活动</span>
            <span class="legend__i"><i class="dot dot--wrong" aria-hidden="true"></i>练习没答对</span>
            <span class="legend__i"><i class="dot dot--ok" aria-hidden="true"></i>练习答对</span>
          </div>
          <!-- 给学生的一句话（原来这里是一段解释后端字段的「开发笔记」：
               「端点只给…三个数…不做拆分」—— 那是设计说明，不该出现在学生眼前）。
               口径本身没丢：它移进了下面的教师视角块。 -->
          <p class="chart__note">把鼠标停在柱子上，就能看到当天的具体数字。</p>
          <TeacherGate label="为什么图上只有这三段">
            <p class="chart__note">
              学习报告端点（<code>LearningReport.daily</code>）每天只回三个数：
              活动总量 <code>count</code> / 练习数 <code>quizCount</code> / 答对数
              <code>correctCount</code>，没有「问答 / 动画 / 编程」的分类维度，
              所以图上只分这三段 —— 数据里没有的色块不画（画出来就是假统计）。
            </p>
          </TeacherGate>
        </div>

        <h4 class="subsection">每日明细</h4>
        <table class="table" data-testid="report-daily">
          <thead>
            <tr><th>日期</th><th class="num">活动</th><th class="num">练习</th><th class="num">答对</th></tr>
          </thead>
          <tbody>
            <tr v-for="day in report.daily" :key="day.day">
              <td>{{ day.day }}</td>
              <td class="num">{{ day.count }}</td>
              <td class="num">{{ day.quizCount }}</td>
              <td class="num">{{ day.correctCount }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- 掌握度 -->
      <h3 class="section">
        知识点掌握
        <span v-if="report.mastery.length > 0" class="section__meta">
          按掌握度从高到低 · 共 {{ report.mastery.length }} 个
        </span>
      </h3>
      <p v-if="report.mastery.length === 0" class="state">还没有掌握度记录。</p>
      <ul v-else class="list" data-testid="report-mastery">
        <li v-for="item in report.mastery" :key="item.kpId" class="row">
          <!-- 知识点名优先（与闯关 / 错题本同一来源）；取不到时显示中性标签、
               原始标识只进 title —— 不编名字，也不把 slug 摆到学生眼前
               （口径见 `study/kp-label.ts`：`learning.db` 里可能有上一代教材的残留行） -->
          <span class="row__name" :title="item.kpId">{{ nameOf(item.kpId) }}</span>
          <span class="bar"><span class="bar__fill" :style="{ width: barWidth(item.score) }"></span></span>
          <span class="row__score">{{ item.score.toFixed(2) }}</span>
          <span class="row__tag">{{ masteryLabel(item.score) }}</span>
          <span class="row__meta">{{ item.correct }}/{{ item.attempts }} 次答对</span>
        </li>
      </ul>

      <!-- 章节进度 -->
      <h3 class="section">章节进度</h3>
      <p v-if="report.chapters.length === 0" class="state">还没有章节进度记录。</p>
      <ul v-else class="list" data-testid="report-chapters">
        <li v-for="chapter in report.chapters" :key="chapter.chapterTitle" class="row">
          <span class="row__name">{{ chapter.chapterTitle }}</span>
          <span class="bar">
            <span
              class="bar__fill"
              :style="{
                width: chapter.kpCount > 0
                  ? `${Math.round((chapter.masteredCount / chapter.kpCount) * 100)}%`
                  : '0%'
              }"
            ></span>
          </span>
          <span class="row__score">{{ chapter.masteredCount }}/{{ chapter.kpCount }}</span>
          <span class="row__meta">已测验 {{ chapter.quizzedCount }}</span>
        </li>
      </ul>

      <!-- 闯关 + 徽章 + 逐关进度 -->
      <h3 class="section">闯关与徽章</h3>
      <p v-if="Object.keys(report.stageCounts).length === 0" class="state">还没有开始闯关。</p>
      <ul v-else class="list" data-testid="report-stages">
        <li v-for="(count, stage) in report.stageCounts" :key="stage" class="row">
          <span class="row__name">{{ stageLabel(stage) }}</span>
          <span class="row__score">{{ count }}</span>
          <span class="row__meta">个知识点</span>
        </li>
      </ul>
      <p v-if="report.badges.length > 0" class="badges" data-testid="report-badges">
        已获得徽章：{{ report.badges.join('、') }}
      </p>

      <!-- 逐关进度：`quiz.levels` 是服务端按依赖图排好的顺序，这里**一行排序都不做**。
           关卡徽章不在这里重复渲染 —— 它的展示位是闯关页的关卡条（本页的徽章来自报告端点）。 -->
      <h4 class="subsection">
        逐关进度
        <span v-if="quizLevels.length > 0" class="section__meta">
          {{ quizSummary.mastered }}/{{ quizSummary.total }} 已掌握
        </span>
      </h4>
      <p v-if="quizLevels.length === 0" class="state" data-testid="report-quiz-progress-empty">
        还没有可闯的关卡 —— 知识库就绪后，服务端会按依赖图为这名学生播种关卡路径。
      </p>
      <div v-else class="rows" data-testid="report-quiz-progress">
        <div
          v-for="level in quizLevels"
          :key="level.kpId"
          class="row"
          :data-testid="`report-quiz-level-${level.kpId}`"
          :data-stage="level.stage"
        >
          <span
            class="row__name"
            :title="nameResolved(level.kpId) ? undefined : level.kpId"
          >{{ nameOf(level.kpId) }}</span>
          <el-tag size="small" effect="plain" :type="stageTag(level.stage)">
            {{ stageLabel(level.stage) }}
          </el-tag>
          <el-progress
            class="row__bar"
            :percentage="percentOf(level.mastery)"
            :stroke-width="7"
            :show-text="false"
            color="var(--k12-accent)"
          />
          <span class="row__score k12-num">{{ percentOf(level.mastery) }}%</span>
        </div>
      </div>

      <!-- 学段依据：判定信号 + 变化轨迹（全部只读，本页没有任何学段写入口） -->
      <h3 class="section">
        学段依据
        <span v-if="confidencePercent !== null" class="section__meta">
          置信度 {{ confidencePercent }}% · 只读
        </span>
      </h3>
      <div v-if="signals.length > 0" class="signals" data-testid="report-grade-signals">
        <div
          v-for="signal in signals"
          :key="signal.signalType"
          class="sig"
          :data-testid="`report-grade-signal-${signal.signalType}`"
          :data-signal-type="signal.signalType"
        >
          <div class="sig__top">
            <span class="sig__type">{{ signalLabel(signal.signalType) }}</span>
            <span class="sig__val k12-num">{{ percentOf(signal.value) }}%</span>
          </div>
          <el-progress
            :percentage="percentOf(signal.value)"
            :stroke-width="7"
            :show-text="false"
            color="var(--k12-accent)"
          />
          <p v-if="signal.raw" class="sig__raw">{{ signal.raw }}</p>
        </div>
      </div>
      <!-- 端点给的是「最近 N 条读数」而不是四个汇总值：把口径写明，
           免得家长把「每类一张卡」读成「一共只有四条信号」 -->
      <p v-if="signals.length > 0 && signalReadingCount > signals.length" class="chart__note">
        判定依据共 {{ signalReadingCount }} 条读数，上面每类显示最近的一次。
      </p>
      <p v-else-if="signals.length === 0" class="state" data-testid="report-grade-signals-empty">
        还没有学段判定信号 —— 系统会在几轮对话之后开始收集判定依据。
      </p>

      <h4 class="subsection">变化轨迹（最近一次在最上面）</h4>
      <el-timeline v-if="gradeTrail.length > 0" class="trail" data-testid="report-grade-history">
        <el-timeline-item
          v-for="(entry, index) in gradeTrail"
          :key="`${entry.turn}-${index}`"
          :timestamp="`第 ${entry.turn} 轮 · ${formatMs(entry.ts)}`"
          placement="top"
        >
          <p class="trail__move">
            {{ trailFrom(entry.fromLevel) }} → {{ GRADE_LABELS[entry.toLevel] ?? entry.toLevel }}
          </p>
          <p class="trail__meta">
            来源 {{ gradeOriginLabel(originOf(entry.source)) }} · 置信度
            {{ entry.confidence.toFixed(2) }}
          </p>
        </el-timeline-item>
      </el-timeline>
      <p v-else class="state" data-testid="report-grade-history-empty">还没有学段变化记录。</p>
    </template>
  </section>
</template>

<style scoped>
.tab-body {
  padding: 16px 24px 32px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.toolbar__group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar__label {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.toolbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 时间范围切换：胶囊按钮（选中态用学段浅底 + 强调墨）
 * ⚠️ 页面级操作（刷新 / 导出）走 Element Plus 的 `el-button`：
 *    全局 `.btn` 已随旧 base.css 移除，本页不再自带第二套按钮样式。 */
.chip {
  padding: 4px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}

.chip--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
  font-weight: 600;
}

/* ── 概览 hero：全页唯一的 22px（平均掌握度）──────────────────────────────
 * ⚠️ 版式契约 §1/§4：22px 只属于「页面身份行 / hero 数字」，
 *    下面那些磁贴数字一律 `--k12-fs-lg`（16px），不许跟着放大。 */
.hero {
  padding: 14px 16px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.hero__top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px 28px;
}

.hero__id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/* 学生名刻意停在 13px：hero 里只允许「平均掌握度」一个 22px */
.hero__name {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}

.hero__grade {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.hero__mastery {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hero__num {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  letter-spacing: -0.01em;
  color: var(--k12-fg);
}

/* 单位不跟着 22px 放大：否则「%」成了第二个大元素 */
.hero__unit {
  margin-left: 2px;
  font-size: var(--k12-fs-sm);
  color: var(--k12-muted);
}

.hero__cap {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--k12-gap);
  margin-top: 12px;
}

/* 统计磁贴 = 一张卡片（E2：白面 + 可见边框 + 浅投影） */
.card {
  padding: 10px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.card__label {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ⚠️ 磁贴里的数字**不用 22px**（版式契约 §1 明确列为反例）：
 * 22px（`--k12-fs-xl`）只留给页面身份行与 hero。 */
.card__value {
  margin-top: 4px;
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}

.card__hint {
  margin-top: 2px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.summary {
  margin-top: 12px;
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

.section {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 20px 0 8px;
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}

/* 区块标题上的口径说明（「共 N 个」「置信度 62%」）——12px meta，不是小标题 */
.section__meta {
  font-size: var(--k12-fs-xs);
  font-weight: 400;
  color: var(--k12-muted);
}

.subsection {
  margin: 14px 0 8px;
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}

/* ── 继续学习（推荐卡）────────────────────────────────────────────────── */
.reco {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.reco__pill {
  flex: none;
  padding: 3px 10px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}

.reco__desc {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

.reco__meta {
  flex: none;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ── 近 N 日学习量柱状图（只画数据里有的三段）────────────────────────── */
.chart {
  padding: 12px 14px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.chart__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.chart__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}

.chart__meta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* 30 天窗口也放得下：柱子按比例摊开，窄到 10px 就开始横向滚动 */
.chart__bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 112px;
  overflow-x: auto;
}

.chart__bar {
  flex: 1 0 10px;
  min-width: 10px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.chart__stack {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  overflow: hidden;
}

.chart__seg {
  display: block;
  width: 100%;
}

/* ── 三段的配色：都是**既有令牌**，没有新增色值 ───────────────────────────
 * 走查结论（原话）：「像财务报表」—— 原来三段是 border-strong（灰）/ warn（褐）/
 * good（墨绿），三个低饱和色堆在一起确实像一张财务图。现在换成更明快的三个：
 *   · 其他活动  → `--k12-cyan`（中性、信息性的青）
 *   · 练习没答对 → `--k12-accent`（随学段变的活色，橙 / 蓝 / 靛 / 青绿）
 *   · 练习答对  → `--k12-good`（绿 = 好，语义与其它地方一致）
 * ★ **颜色不是唯一的区分手段**（本项目的明文规则）：中间那段用「斜纹」纹理，
 *   灰度打印或色觉差异下三段仍分得开；图例里的色块与柱子用**同一套**配方。
 * ⚠️ 斜纹的底色用 `--k12-surface`（卡片自身底色），不引入新的灰 ——
 *   换成任何硬编码的 rgba 都是「新色值」。
 */
.chart__seg--other {
  background: var(--k12-cyan);
}

.chart__seg--wrong {
  background-color: var(--k12-accent);
  background-image: repeating-linear-gradient(
    45deg,
    var(--k12-surface) 0 2px,
    transparent 2px 5px
  );
}

.chart__seg--ok {
  background: var(--k12-good);
}

.chart__day {
  flex: none;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
}

.chart__note {
  margin-top: 8px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted-2);
}

.legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.legend__i {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--k12-r-flat);
}

/* 图例色块 = 柱子里那一段的**同一套配方**（含斜纹），不是「差不多的一块颜色」 */
.dot--ok {
  background: var(--k12-good);
}

.dot--wrong {
  background-color: var(--k12-accent);
  background-image: repeating-linear-gradient(
    45deg,
    var(--k12-surface) 0 2px,
    transparent 2px 5px
  );
}

.dot--other {
  background: var(--k12-cyan);
}

/* ── 逐关进度 / 掌握度 / 章节：同一套「名称 + 条 + 数字」行 ───────────── */
.list,
.rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rows {
  gap: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--k12-fs-xs);
}

.row__name {
  min-width: 140px;
  flex-shrink: 0;
  color: var(--k12-fg-2);
}

.row__bar {
  flex: 1;
  min-width: 60px;
}

.row__score {
  min-width: 68px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--k12-fg);
}

.row__tag {
  padding: 1px 8px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  /* 掌握度档位角标（「已掌握 / 正在学 / 需要练」≤4 字）：选择器名含 tag，走角标档 */
  font-size: var(--k12-fs-micro);
}

.row__meta {
  color: var(--k12-muted-2);
}

.bar {
  flex: 1;
  min-width: 60px;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-border);
  overflow: hidden;
}

.bar__fill {
  display: block;
  height: 100%;
  background: var(--k12-accent);
}

/* ── 学段判定信号：两列网格（窄屏收成一列）────────────────────────────── */
.signals {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.sig {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
}

.sig__top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sig__type {
  font-size: var(--k12-fs-xs);
  font-weight: 620;
  color: var(--k12-fg-2);
}

.sig__val {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-accent-ink);
}

.sig__raw {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

/* ── 学段轨迹 ─────────────────────────────────────────────────────────── */
.trail {
  padding-left: 2px;
}

.trail__move {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}

.trail__meta {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--k12-fs-xs);
}

.table th,
.table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--k12-border);
  text-align: left;
}

.table th {
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-weight: 650;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.badges {
  margin-top: 8px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-good);
}

.state {
  padding: 10px 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.state--error {
  color: var(--k12-warn);
  line-height: var(--k12-lh-body);
}

/* 概览部分失败：是「一块没读上来」，不是整页错误 —— 用 warn 而不是 bad */
.state--warn {
  margin-top: 10px;
  color: var(--k12-warn);
  line-height: var(--k12-lh-body);
}

.notice {
  margin-bottom: 10px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-good);
}

@media (max-width: 1279px) {
  .signals {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
