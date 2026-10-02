<script setup lang="ts">
/**
 * 学习档案右栏的**五行结构**（2026-09-30）：类型 / 性格 / 偏好 / 兴趣 / 小结。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它替代了什么
 * ══════════════════════════════════════════════════════════════════════════
 * 原来这一栏是 `ProfileTags` 的**分组标签列表**（按维度分组 + 来源标注 + 可撤回）
 * 加一段「画像的变化」时间线。改版后：
 *   · 标签列表 → 五行结构（同一份标签，按**主题行**重组，读起来更像「我是什么样的人」）；
 *   · 时间线 → **这一栏不再显示**（画像变动信息不在学习档案里，对话页右栏仍保留）；
 *   · 撤回等维护能力 → 仍只在对话页右栏（`ProfileTags` 组件未改，只是本页不再引用）。
 *
 * ── ★★ 三条纪律（改这里之前先读完）─────────────────────────────────────
 *
 * 1. **行的标题、空态文案、每行取哪些键，全部由后端给**（双视角纪律 D-063）：
 *    前两者随画像载荷的 `portraitRowLabels` / `portraitEmptyNotes` 下发，
 *    后者是 `portraitRowKeys`（行↔键映射的唯一真相）。本文件**一个中文名都不写** ——
 *    渲染进程里每个字符串字面量都会被守卫扫到，写一个就是给守卫开一个洞。
 *
 * 2. **空态不是空白**：某一行为空时显示后端给的空态文案（它说的是**下一步做什么**，
 *    不是「无数据」）。学生看到一行空白会读成「这里坏了」。
 *
 * 3. **第五行（小结）的正文来自另一条读通道**（AI 生成的小结，见 `profile-refresh`
 *    的 `summary-line`），所以它由 `summary` prop 传进来；但这一行的**标题与空态文案
 *    仍然从后端给的字典里取** —— 与其余四行同一个口径。
 *
 * ⚠️ 后端没给这三张表（老版本 / 桥没接全）→ 整块不渲染：新能力缺失不许拖垮既有能力。
 */
import { computed } from 'vue'
import { useProfileCardStore } from '../stores/profileCard'

const props = withDefaults(
  defineProps<{
    /**
     * AI 小结的正文（空串 = 还没生成 / 生成失败，此时显示空态文案）。
     * ★ 它由宿主从小结读通道取来 —— 本组件不自己去读（数据来源归宿主）。
     */
    summary?: string
  }>(),
  { summary: '' }
)

const profileCard = useProfileCardStore()

/* ------------------------------------------------------------------ *
 * 行强调色（2026-09-30 视觉调整）
 * ------------------------------------------------------------------ */

/**
 * 每行行首标签胶囊的强调色 —— **只用现有 `--k12-*` token**，不写死色值。
 *
 * ★ 选色判据是「能反白」：这五支都是深色档，白字对比度在各学段主题下都够
 *   （`--k12-cyan` / `--k12-good` / `--k12-warn` / `--k12-bad` 是全局常量，
 *   白字各 ≈5.3～5.4:1；`--k12-accent-ink` 随主题走，六套实测 ≥5.0:1）。
 * ★ 刻意**不用** `--k12-accent`：它是浅色主色，白字对比度不足（会把反白做成事故）。
 * ★ 取值小标签的底色 / 字色由本行强调色用 `color-mix()` 在样式表里派生
 *   （同一份配方，随主题与深浅模式一起走），组件里没有第二套色值。
 */
const FACT_TINTS = [
  'var(--k12-accent-ink)',
  'var(--k12-cyan)',
  'var(--k12-good)',
  'var(--k12-bad)'
] as const

/** 第五行（小结）单独一支强调色：让「一段话」与前面四行并列事实分开。 */
const SUMMARY_TINT = 'var(--k12-warn)'

/** 行强调色按行序循环取（后端加行时也不会有一行没颜色）。 */
function rowTint(index: number): string {
  return FACT_TINTS[index % FACT_TINTS.length] ?? FACT_TINTS[0]
}

/**
 * 小结行的标题与空态文案（后端给；标题缺了就不渲染这一行）。
 *
 * ★ 行 id（`summary`）的约定在 store 里（`summaryRow`），本组件不写任何约定字面量；
 *   中文名仍然只由后端给。
 */
const summaryTitle = computed(() => profileCard.summaryRow.title)
const summaryEmptyNote = computed(() => profileCard.summaryRow.emptyNote)
const summaryText = computed(() => props.summary.trim())

/** 小结这一行要不要渲染：标题拿不到就整行不渲染（宁可不显示，也不摆一行没名字的）。 */
const showSummaryRow = computed(() => summaryTitle.value !== '')
</script>

<template>
  <!-- ★ 整块的渲染条件：后端给了行↔键映射（否则没有可渲染的行 —— 见文件头） -->
  <section v-if="profileCard.factRows.length > 0" class="facts" data-testid="portrait-facts">
    <!-- ── 四行标签行：类型 / 性格 / 偏好 / 兴趣（顺序由后端字典给）── -->
    <div
      v-for="(row, index) in profileCard.factRows"
      :key="row.id"
      class="facts__row"
      :data-row="row.id"
      :data-testid="`portrait-fact-${row.id}`"
      :style="{ '--fact-c': rowTint(index) }"
    >
      <span v-if="row.title" class="facts__title">{{ row.title }}</span>
      <span v-if="row.values.length > 0" class="facts__values">
        <span v-for="value in row.values" :key="value" class="facts__value">{{ value }}</span>
      </span>
      <span v-else-if="row.emptyNote" class="facts__empty">{{ row.emptyNote }}</span>
    </div>

    <!-- ── 第五行：AI 小结（正文来自另一条读通道，标题与空态文案仍由后端给）── -->
    <div
      v-if="showSummaryRow"
      class="facts__row facts__row--summary"
      data-row="summary"
      :style="{ '--fact-c': SUMMARY_TINT }"
    >
      <span class="facts__title">{{ summaryTitle }}</span>
      <p v-if="summaryText !== ''" class="facts__summary" data-testid="portrait-summary">
        {{ summaryText }}
      </p>
      <span v-else-if="summaryEmptyNote" class="facts__empty">{{ summaryEmptyNote }}</span>
    </div>
  </section>
</template>

<style scoped>
/* 每一行是「标题 + 内容」两格：标题窄而固定，内容吃掉剩下的宽度。
 * ★ 为什么不用 table / flex：标题列必须**跨行对齐**（五行读起来才像一张表），
 *   而 grid 的固定首列天然做到这一点；flex 需要给每行手写同一个宽度。 */
.facts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.facts__row {
  display: grid;
  /* ★ 首列从 40px 微调到 44px：行首标签现在是**胶囊**（有色底 + 内边距），
   *   40px 装不下「两字 + 气口」；44px 仍是固定列 —— 五行跨行对齐才像一张表。
   * `--fact-c` 是每一行的强调色（模板按行序注入）；这里给一支兜底，
   *   万一某行没注入也不会落到「没有颜色」。 */
  --fact-c: var(--k12-accent-ink);
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 4px 8px;
  align-items: start;
}

.facts__title {
  /* 行标题（类型 / 性格 / 偏好…）：后端给的中文，学生面 → 行首彩色胶囊。
   * ★ 底色 = 本行强调色（深色档，不写死色值），文字 = 纸面白 ⇒ 反白。
   *   实测白字对比度：全局四色 ≈5.3～5.4:1，accent-ink 各主题 ≥5.0:1。 */
  font-size: var(--k12-fs-label);
  font-weight: 650;
  line-height: 1.35;
  color: var(--k12-on-fill);
  background: var(--fact-c);
  border-radius: var(--k12-r-control);
  padding: 2px 4px;
  text-align: center;
  white-space: nowrap;
}

.facts__values {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 6px;
  min-width: 0;
}

/* 一个值一枚小胶囊：值之间是并列关系（「开朗」「爱提问」之间不是一句话），
 * 用胶囊分开比用顿号连成一句更好读 —— 也避免「开朗爱提问」这种黏在一起的误读。
 * ★ 2026-09-30：取值也彩色化 —— 每枚小标签用**本行强调色**派生：
 *   底 = 强调色 14% 混纸面（很浅的有色底），字 = 强调色 88% 混前景（压深一档）。
 *   两者都由 token + color-mix 现算，没有第二份色值；实测字对底 ≥4.7:1（全主题）。 */
.facts__value {
  padding: 1px 8px;
  border-radius: var(--k12-r-pill);
  background: color-mix(in srgb, var(--fact-c) 14%, var(--k12-surface));
  border: 1px solid color-mix(in srgb, var(--fact-c) 30%, var(--k12-surface));
  color: color-mix(in srgb, var(--fact-c) 88%, var(--k12-fg));
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui, 1.4);
  word-break: break-word;
}

/* 空态：与胶囊同位置但不抢眼 —— 它是「还没到这一步」的说明，不是数据 */
.facts__empty {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body, 1.6);
  color: var(--k12-muted-2);
}

/* 小结正文：一段话（不是胶囊），所以左对齐、给行高 */
.facts__summary {
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body, 1.6);
  color: var(--k12-fg-2);
  word-break: break-word;
}

/* 小结行整行与上面四行之间多留一点：它是一段话，前面的四行是并列事实 */
.facts__row--summary {
  margin-top: 2px;
}
</style>
