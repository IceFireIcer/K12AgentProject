<script setup lang="ts">
/**
 * 闯关练习页 —— 对话内联闯关卡的**展开视图**。
 *
 * ── 这一版改的是什么（骨架，不是装饰）──────────────────────────────────
 * 旧版是「四块同权」：左侧 320px 关卡列表 + 右侧 1.7fr 题目卡 + 1fr 掌握度面板，
 * 真正的主对象（题目）被三面包围；而内容区最大的 22px 落在侧栏的标题上，
 * 题目反而不是焦点。现在改成**单列流**：
 *
 *   身份行 → 关卡进度条（横向） → 当前关卡标题 → **题目卡（全宽）**
 *          → 掌握度（题目下方横向铺开） → 判分说明（折叠）
 *
 * 于是全页唯一的 22px 是 `PageIdentity`（契约 §4：内容区最大字号必须是主对象那一层），
 * 关卡名降为 16px（块标题档），掌握度/进度是 13px 与 12px。
 * 关卡切换是**页面级选择**，按契约 §7 放在页面顶部（而不是被塞进侧栏）。
 *
 * ⚠️ 判分只走后端（§6.3）：前端拿不到 answer。本原型不本地判对错，
 * 提交后只显示「已提交，等待后端判分」的中性提示（那在 QuizCard 内）。
 *
 * ⚠️ 答题状态只有一份（在 QuizCard 内），页面不另存一份，避免两处状态对不上。
 *
 * ⚠️ 「连对 / 经验 / 勋章」这类数字曾是界面占位（契约里既没有经验值也没有勋章模型，
 *   只有掌握度与学习记录）。**不渲染**这三个数 —— 它们没有数据源，画出来就是假统计；
 *   只保留下方那条「界面占位」标注，接线时应删掉它或改用真实 `learning_activity` 计数。
 */
import { computed, ref } from 'vue'
import { Trophy, Lock, Circle, PlayCircle, CheckCircle2, History, X, Info } from 'lucide-vue-next'
import PageIdentity from '@/components/PageIdentity.vue'
import SurfacePanel from '@/components/SurfacePanel.vue'
import QuizCard from '@/cards/QuizCard.vue'
import { progressRows, mastery, kpNames, quizPayload } from '@/mocks'
import { useEscape } from '@/composables/useEscape'
import { useFocusReturn } from '@/composables/useFocusReturn'

const stageMeta: Record<string, { label: string; icon: unknown }> = {
  locked: { label: '未解锁', icon: Lock },
  learning: { label: '学习中', icon: Circle },
  quizzed: { label: '已闯关', icon: PlayCircle },
  mastered: { label: '已掌握', icon: CheckCircle2 }
}

const activeKp = ref('jr-data-features')

/**
 * 做题记录（二级界面）。
 * 此前这个按钮是 `disabled` 的占位。现在它打开一个抽屉，列出每次作答的记录 ——
 * 形状对齐 `QuizResult`（qid / correct / scoredBy / masteryDelta），
 * 接线后数据来自 `/api/quiz/grade` 的落库结果。
 */
const historyOpen = ref(false)
/** 抽屉根元素：模态的焦点契约（移入 → 层内循环 → 关闭归还）挂在它上面 */
const drawerRef = ref<HTMLElement | null>(null)

interface Attempt {
  at: string
  kpName: string
  total: number
  correct: number
  scoredBy: 'rule' | 'llm'
  masteryDelta: number
}

const attempts = ref<Attempt[]>([
  { at: '09-17 20:04', kpName: '数据与特征', total: 3, correct: 2, scoredBy: 'rule', masteryDelta: 0.05 },
  { at: '09-16 19:31', kpName: '数据与特征', total: 3, correct: 3, scoredBy: 'rule', masteryDelta: 0.15 },
  { at: '09-15 21:12', kpName: '决策树', total: 2, correct: 1, scoredBy: 'llm', masteryDelta: 0.02 }
])

function deltaText(d: number) {
  return `${d >= 0 ? '+' : ''}${d.toFixed(2)}`
}

const summary = computed(() => ({
  total: progressRows.length,
  mastered: progressRows.filter((r) => r.stage === 'mastered').length
}))

const masteryRows = computed(() =>
  mastery.slice(0, 3).map((m) => {
    const percent = Math.round(m.score * 100)
    return {
      kpId: m.kpId,
      name: kpNames[m.kpId] ?? m.kpId,
      percent,
      color: percent >= 70 ? 'var(--k12-good)' : percent >= 40 ? 'var(--k12-warn)' : 'var(--k12-bad)'
    }
  })
)

/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => { historyOpen.value = false }, () => !!historyOpen.value)

/**
 * 焦点收束：打开时焦点移入抽屉、Tab 在层内循环、关闭归还触发元素。
 * 光有 Esc 不够 —— 打开时焦点还在背后的页面上，Tab 会跑到遮罩后（契约 §8）。
 */
useFocusReturn(drawerRef, () => historyOpen.value)
</script>

<template>
  <div class="quiz">
    <PageActions>
      <template #info>
        <span>闯关进度 {{ summary.mastered }} / {{ summary.total }} 已掌握</span>
      </template>
      <el-button @click="historyOpen = true">
        <History :size="14" />
        <span class="btn__label">做题记录</span>
        <span class="btn__count">{{ attempts.length }}</span>
      </el-button>
    </PageActions>

    <!-- 身份行：本页「在讲什么」+ 主路径提示（22px，全页唯一） -->
    <PageIdentity
      main="这几道题检验你刚才学的那一点"
      meta="客观题由规则判分，主观题由 LLM 判分"
      hint="先选关卡，再逐题作答，交卷后看解析"
    />

    <!-- ── 关卡进度条：页面级选择，横向排开（窄屏横向滚动，不换行挤压）── -->
    <section class="stages" aria-label="关卡">
      <header class="stages__head">
        <Trophy :size="14" class="stages__ico" />
        <span class="stages__label">关卡</span>
      </header>

      <div class="stages__track">
        <button
          v-for="r in progressRows"
          :key="r.kpId"
          type="button"
          class="stg"
          :class="{ 'stg--on': activeKp === r.kpId, 'stg--locked': r.stage === 'locked' }"
          :disabled="r.stage === 'locked'"
          :aria-current="activeKp === r.kpId ? 'step' : undefined"
          @click="activeKp = r.kpId"
        >
          <component :is="stageMeta[r.stage]!.icon" :size="14" class="stg__ico" :data-stage="r.stage" />
          <span class="stg__name">{{ r.name }}</span>
          <span class="stg__stage">{{ stageMeta[r.stage]!.label }}</span>
          <span class="stg__pct k12-num">{{ Math.round(r.score * 100) }}%</span>
        </button>
      </div>

      <!-- ★ 界面占位标注（保留）：契约里没有经验值 / 勋章模型（只有掌握度与学习记录），
           所以「连对 / 经验 / 勋章」这三个数**只是占位记号、不是统计口径** ——
           不把它们做成 22px 的"成绩单"来美化，也绝不新增假数据（没有数据源的数字更糟）。
           接线时删掉本行，或改用真实的 `learning_activity` 计数。 -->
      <p class="stages__note">
        <Info :size="13" />
        <span>
          「连对 / 经验 / 勋章」是界面占位数字，本页不渲染：契约里没有经验值 / 勋章模型（只有掌握度与学习记录）。
        </span>
      </p>
    </section>

    <!-- ── 当前关卡标题（16px 块标题档：不得追平身份行的 22px）────────── -->
    <header class="quiz__head">
      <div class="quiz__head-text">
        <span class="quiz__kicker">当前关卡</span>
        <h2 class="quiz__title">{{ kpNames[activeKp] ?? activeKp }}</h2>
      </div>
      <div class="quiz__chips">
        <el-tag size="small" effect="plain" round>约 5 分钟</el-tag>
        <el-tag size="small" effect="plain" round>{{ quizPayload.questions.length }} 题</el-tag>
      </div>
    </header>

    <!-- 题目：全宽。答题状态在卡内，页面不另存一份。 -->
    <QuizCard class="quiz__card" />

    <!-- ── 掌握度：移到题目**下方**横向铺开（不再与题目并排争焦点）────── -->
    <SurfacePanel class="mastery">
      <header class="mastery__head">
        <span class="mastery__title">本关知识点掌握度</span>
        <span class="mastery__meta">由后端判分累积</span>
      </header>
      <div class="mastery__rows">
        <div v-for="m in masteryRows" :key="m.kpId" class="mrow">
          <div class="mrow__top">
            <span class="mrow__name">{{ m.name }}</span>
            <span class="mrow__pct k12-num">{{ m.percent }}%</span>
          </div>
          <el-progress
            :percentage="m.percent"
            :stroke-width="6"
            :show-text="false"
            :color="m.color"
            class="mrow__bar"
          />
        </div>
      </div>
    </SurfacePanel>

    <!-- ── 判分说明：收进折叠（默认折叠，它不该和题目抢注意力）──────────
         「客观题规则判分 / 主观题 LLM 判分」已由身份行的 meta 说了，
         这里只放它装不下的机制细节，避免同一句话说两遍。 -->
    <SurfacePanel class="howto" flush>
      <el-collapse class="howto__collapse">
        <el-collapse-item title="判分与掌握度说明" name="how">
          <p class="howto__p">
            掌握度变化限幅 ±0.2（防一次答题从 0 到 1）。
            题库里的标准答案只保留在 Python 侧，发给前端的一律是无 <code>answer</code> 的
            <code>QuizQuestionOut</code>。提交后经 IPC → sidecar <code>/api/quiz/grade</code> 判分，
            返回 <code>QuizResult</code>（含 <code>masteryDelta</code>）。
          </p>
        </el-collapse-item>
      </el-collapse>
    </SurfacePanel>

    <!-- 做题记录抽屉：二级界面。遮罩 + 从右滑入的实色面板。 -->
    <Teleport to="body">
      <div v-if="historyOpen" class="hw" @click.self="historyOpen = false">
        <aside ref="drawerRef" class="hw__panel" role="dialog" aria-modal="true" aria-label="做题记录">
          <header class="hw__head">
            <History :size="16" />
            <div class="hw__head-text">
              <p class="hw__title">做题记录</p>
              <p class="hw__sub">共 {{ attempts.length }} 次作答 · 按时间倒序</p>
            </div>
            <button type="button" class="hw__close" title="关闭" aria-label="关闭" @click="historyOpen = false">
              <X :size="16" />
            </button>
          </header>

          <div class="hw__body">
            <div v-for="(a, i) in attempts" :key="i" class="hw__row">
              <div class="hw__row-top">
                <span class="hw__kp">{{ a.kpName }}</span>
                <span class="hw__at k12-num">{{ a.at }}</span>
              </div>
              <div class="hw__row-mid">
                <span class="hw__score" :data-full="a.correct === a.total">
                  {{ a.correct }} / {{ a.total }} 题
                </span>
                <span class="hw__by">{{ a.scoredBy === 'rule' ? '规则判分' : 'LLM 判分' }}</span>
                <span class="hw__delta" :data-up="a.masteryDelta >= 0">
                  掌握度 {{ deltaText(a.masteryDelta) }}
                </span>
              </div>
            </div>

            <p class="hw__note">
              对错由后端判分决定（答案不下发前端）；这里的记录形状对齐 <code>QuizResult</code>，
              接线后来自 <code>/api/quiz/grade</code> 的落库结果。
            </p>
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 单列流：页面自己只在 `.shell__content` 里纵向排块，不建内层滚动容器 ——
 * 于是 PageActions 的吸顶基准仍是 `.shell__content`，且内边距 18/22 与
 * 它的默认 `--pa-pad-y/x` 一致（无需覆盖那两个变量）。 */
.quiz {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap);
  padding: 18px 22px 24px;
}

/* PageActions 里的按钮文字与计数（其他页各写一份 6px 间距，这里补齐） */
.btn__label {
  margin-left: 6px;
}
.btn__count {
  margin-left: 6px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
}

/* ── 关卡进度条 ──────────────────────────────────────────────────────── */
.stages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.stages__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--k12-muted);
}
.stages__ico {
  flex: none;
}
.stages__label {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 横向排开：窄屏靠横向滚动兜住，不换行挤压（关卡名 + 状态 + 百分比三件套） */
.stages__track {
  display: flex;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
}
.stg {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface-2);
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
  .stg:hover:not(:disabled) {
    border-color: var(--k12-accent-ink);
  }
}
.stg--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-ink);
}
.stg--locked {
  opacity: 0.6;
  cursor: not-allowed;
}
.stg__ico {
  flex: none;
}
.stg__ico[data-stage='mastered'] {
  color: var(--k12-good);
}
.stg__ico[data-stage='quizzed'] {
  color: var(--k12-accent-ink);
}
.stg__ico[data-stage='learning'] {
  color: var(--k12-warn);
}
.stg__ico[data-stage='locked'] {
  color: var(--k12-muted-2);
}
.stg__name {
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  color: var(--k12-fg);
  white-space: nowrap;
}
/* 状态标签与百分比都是 meta —— 12px，不是 11px（11px 只许给角标） */
.stg__stage {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  white-space: nowrap;
}
.stg__pct {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg-2);
  font-variant-numeric: tabular-nums;
}
/* 选中项整体走 accent-ink：它在 accent-soft 上是达标的文字色（对比度机器校验） */
.stg--on .stg__name,
.stg--on .stg__stage,
.stg--on .stg__pct {
  color: var(--k12-accent-ink);
}
/* 界面占位标注：12px meta，不是告警条 —— 它是给接线者看的便条，不该抢题目的注意力 */
.stages__note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 11px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.stages__note svg {
  flex: none;
  margin-top: 2px;
  color: var(--k12-muted-2);
}

/* ── 当前关卡标题（16px：块标题档，**不得**用 22px 与身份行争焦点）──── */
.quiz__head {
  display: flex;
  align-items: flex-end;
  gap: 14px;
}
.quiz__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.quiz__kicker {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.quiz__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  color: var(--k12-fg);
}
.quiz__chips {
  display: flex;
  gap: 8px;
  flex: none;
}

/* 题目全宽：不设 max-width、不与任何东西并排 */
.quiz__card {
  max-width: none;
}

/* ── 掌握度：题目下方横向铺开 ────────────────────────────────────────── */
.mastery {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mastery__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.mastery__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.mastery__meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.mastery__rows {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.mrow {
  flex: 1 1 200px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mrow__top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mrow__name {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mrow__pct {
  flex: none;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg-2);
  font-variant-numeric: tabular-nums;
}
.mrow__bar {
  width: 100%;
}

/* ── 判分说明（折叠：13px 标题 / 12px 正文）────────────────────────── */
.howto {
  padding: 2px 14px 6px;
}
.howto__collapse {
  border: none;
}
.howto__p {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.howto__p code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}

/* ── 做题记录抽屉 ────────────────────────────────────────────────────── */
.hw {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--k12-fg) 30%, transparent);
}
.hw__panel {
  width: min(420px, 92vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--k12-surface);
  border-left: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-float);
}
.hw__head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--k12-border);
  color: var(--k12-muted);
}
.hw__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hw__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.hw__sub {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.hw__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .hw__close:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg-2);
  }
}
.hw__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hw__row {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px 13px;
  border-radius: var(--k12-r-card);
  background: var(--k12-surface-2);
}
.hw__row-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.hw__kp {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
/* 时间 / 判分方 / 掌握度增减 / 脚注：都是 meta → 12px */
.hw__at {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.hw__row-mid {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.hw__score {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-warn);
}
.hw__score[data-full='true'] {
  color: var(--k12-good);
}
.hw__by {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.hw__delta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-bad);
}
.hw__delta[data-up='true'] {
  color: var(--k12-good);
}
.hw__note {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.hw__note code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 5px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
</style>
