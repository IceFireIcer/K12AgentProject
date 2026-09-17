<script setup lang="ts">
/**
 * 闯关练习：关卡列表 + 答题区 + 结算。
 * 对齐画布「4. 闯关练习」。
 *
 * ⚠️ 判分只走后端（§6.3）：前端拿不到 answer。本原型不本地判对错，
 * 提交后只显示「已提交，等待后端判分」的中性提示。
 */
import { computed, ref } from 'vue'
import { Trophy, Lock, CheckCircle2, Circle, PlayCircle, Flame, Award, Zap, Timer, Target } from 'lucide-vue-next'
import QuizCard from '@/cards/QuizCard.vue'
import { progressRows, mastery, kpNames, quizPayload } from '@/mocks'

const stageMeta: Record<string, { label: string; icon: unknown; tone: string }> = {
  locked: { label: '未解锁', icon: Lock, tone: 'locked' },
  learning: { label: '学习中', icon: Circle, tone: 'learning' },
  quizzed: { label: '已闯关', icon: PlayCircle, tone: 'quizzed' },
  mastered: { label: '已掌握', icon: CheckCircle2, tone: 'mastered' }
}

const activeKp = ref('jr-data-features')

const summary = computed(() => ({
  total: progressRows.length,
  mastered: progressRows.filter((r) => r.stage === 'mastered').length,
  quizzed: progressRows.filter((r) => r.stage === 'quizzed').length
}))
</script>

<template>
  <div class="quiz">
    <!-- 左：关卡列表 -->
    <aside class="quiz__side">
      <header class="quiz__side-head">
        <Trophy :size="14" />
        <span class="quiz__side-title">闯关进度</span>
        <span class="quiz__side-meta">{{ summary.mastered }} / {{ summary.total }} 已掌握</span>
      </header>

      <button
        v-for="r in progressRows"
        :key="r.kpId"
        type="button"
        class="lv"
        :class="{ 'lv--on': activeKp === r.kpId, 'lv--locked': r.stage === 'locked' }"
        :disabled="r.stage === 'locked'"
        @click="activeKp = r.kpId"
      >
        <component :is="stageMeta[r.stage]!.icon" :size="14" class="lv__ico" :data-stage="r.stage" />
        <div class="lv__text">
          <span class="lv__name">{{ r.name }}</span>
          <span class="lv__stage">{{ stageMeta[r.stage]!.label }}</span>
        </div>
        <span class="lv__pct">{{ Math.round(r.score * 100) }}%</span>
      </button>

      <div class="quiz__stats">
        <div class="qstat"><Flame :size="13" /><span>连对</span><strong>5</strong></div>
        <div class="qstat"><Zap :size="13" /><span>经验</span><strong>320</strong></div>
        <div class="qstat"><Award :size="13" /><span>勋章</span><strong>2</strong></div>
      </div>
    </aside>

    <!-- 右：答题区 -->
    <section class="quiz__main">
      <header class="quiz__head">
        <div class="quiz__head-text">
          <h2 class="quiz__title">{{ kpNames[activeKp] ?? activeKp }}</h2>
          <p class="quiz__sub">
            客观题由规则判分，主观题由 LLM 判分；掌握度变化限幅 ±0.2
          </p>
        </div>
        <div class="quiz__chips">
          <span class="chip"><Timer :size="12" />约 5 分钟</span>
          <span class="chip"><Target :size="12" />{{ quizPayload.questions.length }} 题</span>
        </div>
      </header>

      <div class="quiz__body">
        <QuizCard class="quiz__card" />

        <aside class="quiz__aside">
          <div class="panel">
            <header class="panel__head">
              <span class="panel__title">本关知识点掌握度</span>
            </header>
            <div class="rows">
              <div v-for="m in mastery.slice(0, 3)" :key="m.kpId" class="row">
                <span class="row__name">{{ kpNames[m.kpId] ?? m.kpId }}</span>
                <div class="row__track">
                  <span class="row__fill" :style="{ width: `${Math.round(m.score * 100)}%` }" />
                </div>
                <span class="row__pct">{{ Math.round(m.score * 100) }}%</span>
              </div>
            </div>
          </div>

          <div class="panel panel--note">
            <header class="panel__head">
              <span class="panel__title">判分说明</span>
            </header>
            <p class="note">
              题库中的标准答案只保留在 Python 侧，发给前端的一律是无 <code>answer</code> 的
              <code>QuizQuestionOut</code>。提交后经 IPC → sidecar <code>/api/quiz/grade</code> 判分，
              返回 <code>QuizResult</code>（含 <code>masteryDelta</code>）。
            </p>
          </div>
        </aside>
      </div>
    </section>
  </div>
</template>

<style scoped>
.quiz {
  display: flex;
  height: 100%;
  min-height: 0;
}
.quiz__side {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 14px;
  border-right: 1px solid var(--k12-border);
  background: var(--k12-glass-2);
  overflow-y: auto;
}
.quiz__side-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--k12-muted);
  padding-bottom: 4px;
}
.quiz__side-title {
  font-size: var(--k12-fs-tiny);
  font-weight: 650;
}
.quiz__side-meta {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.lv {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-2xl);
  background: var(--k12-surface);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.16s ease, background 0.16s ease;
}
.lv:hover:not(:disabled) {
  border-color: var(--k12-accent-border);
}
.lv--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.lv--locked {
  opacity: 0.55;
  cursor: not-allowed;
}
.lv__ico {
  flex: none;
}
.lv__ico[data-stage='mastered'] {
  color: var(--k12-good);
}
.lv__ico[data-stage='quizzed'] {
  color: var(--k12-accent);
}
.lv__ico[data-stage='learning'] {
  color: var(--k12-warn);
}
.lv__ico[data-stage='locked'] {
  color: var(--k12-muted-2);
}
.lv__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lv__name {
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg);
}
.lv__stage {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.lv__pct {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-fg-2);
  font-variant-numeric: tabular-nums;
}
.quiz__stats {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-surface-2);
}
.qstat {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.qstat strong {
  margin-left: auto;
  color: var(--k12-fg);
  font-size: var(--k12-fs-xs);
}

.quiz__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 20px 18px;
  overflow-y: auto;
}
.quiz__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.quiz__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.quiz__title {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}
.quiz__sub {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.quiz__chips {
  display: flex;
  gap: 7px;
  flex: none;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}
.quiz__body {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.quiz__card {
  max-width: none;
}
.quiz__aside {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 13px 14px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.panel--note {
  background: var(--k12-surface);
  border-color: var(--k12-border);
}
.panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel__title {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row__name {
  width: 96px;
  flex: none;
  font-size: var(--k12-fs-micro);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__track {
  flex: 1;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.row__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: linear-gradient(90deg, var(--k12-accent), var(--k12-accent-2));
}
.row__pct {
  width: 32px;
  flex: none;
  text-align: right;
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.note {
  font-size: var(--k12-fs-micro);
  line-height: 1.75;
  color: var(--k12-muted);
}
.note code {
  font-family: var(--k12-font-mono);
  font-size: 9.5px;
  padding: 1px 4px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-accent);
}
</style>
