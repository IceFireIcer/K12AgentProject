<script setup lang="ts">
/**
 * 学习档案 —— 画像 + 掌握度 + 学习历史 + 学段轨迹。
 *
 * ★ 此处合并了画布「2. 学段自适应」拆出来的三张卡（用户决策）：
 *   - Card 学段变化轨迹
 *   - Card 判定信号
 *   - Card 学段隔离检索
 *   它们本来就是「学习数据」，且导航只有 7 项没有第 8 位，所以并入本页。
 *   ⚠️ 原帧里的「确认调整 / 保持初中」按钮**已删除**（学段无人工入口，§5.1）。
 */
import { computed } from 'vue'
import {
  Radar, TrendingUp, Route, ShieldCheck, History, Activity,
  BookOpen, Flame, Timer, Target
} from 'lucide-vue-next'
import { mastery, kpNames, gradeSignals, gradeHistory, isolationNotice, weeklyActivity, student } from '@/mocks'

const signalTypeLabel: Record<string, string> = {
  vocab: '术语使用',
  depth: '提问深度',
  quiz_perf: '答题表现',
  meta_cognition: '元认知表达'
}

const totalInteractions = weeklyActivity.reduce((a, b) => a + b.qa + b.animation + b.coding + b.quiz, 0)

const derived = computed(() => ({
  avgMastery: Math.round((mastery.reduce((a, m) => a + m.score, 0) / mastery.length) * 100),
  mastered: mastery.filter((m) => m.score >= 0.7).length,
  needWork: mastery.filter((m) => m.score < 0.4).length
}))

/** 隔离命中：仅使用当前学段及以下教材块 */
const isolationRows = [
  { label: '初中教材块', state: '命中', on: true },
  { label: '小学高 / 小学低（向上兼容）', state: '未命中', on: false },
  { label: '高中教材块（超出当前学段）', state: '已排除', on: false }
]
</script>

<template>
  <div class="pf">
    <!-- 概要条 -->
    <section class="pf__summary">
      <div class="sum">
        <div class="sum__ico"><Radar :size="16" /></div>
        <div class="sum__text">
          <p class="sum__k">学生</p>
          <p class="sum__v">{{ student.nickname }}</p>
        </div>
      </div>
      <div class="sum">
        <div class="sum__ico"><TrendingUp :size="16" /></div>
        <div class="sum__text">
          <p class="sum__k">平均掌握度</p>
          <p class="sum__v">{{ derived.avgMastery }}%</p>
        </div>
      </div>
      <div class="sum">
        <div class="sum__ico"><Target :size="16" /></div>
        <div class="sum__text">
          <p class="sum__k">已掌握 / 待加强</p>
          <p class="sum__v">{{ derived.mastered }} / {{ derived.needWork }}</p>
        </div>
      </div>
      <div class="sum">
        <div class="sum__ico"><Flame :size="16" /></div>
        <div class="sum__text">
          <p class="sum__k">本周交互</p>
          <p class="sum__v">{{ totalInteractions }} 次</p>
        </div>
      </div>
    </section>

    <div class="pf__grid">
      <!-- 掌握度明细 -->
      <section class="card card--wide">
        <header class="card__head">
          <Route :size="14" />
          <h2 class="card__title">知识点掌握度</h2>
          <span class="card__meta">{{ mastery.length }} 个知识点</span>
        </header>
        <div class="rows">
          <div v-for="m in mastery" :key="m.kpId" class="row">
            <span class="row__name">{{ kpNames[m.kpId] ?? m.kpId }}</span>
            <div class="row__track">
              <span
                class="row__fill"
                :data-level="m.score >= 0.7 ? 'high' : m.score >= 0.4 ? 'mid' : 'low'"
                :style="{ width: `${Math.round(m.score * 100)}%` }"
              />
            </div>
            <span class="row__pct">{{ Math.round(m.score * 100) }}%</span>
            <span class="row__detail">{{ m.correct }} / {{ m.attempts }} 题</span>
          </div>
        </div>
      </section>

      <!-- ★ A2 拆出的卡 ①：学段变化轨迹 -->
      <section class="card">
        <header class="card__head">
          <History :size="14" />
          <h2 class="card__title">学段变化轨迹</h2>
          <span class="card__meta">只读</span>
        </header>
        <div class="trail">
          <div v-for="(h, i) in gradeHistory" :key="i" class="trail__row">
            <div class="trail__rail">
              <span class="trail__dot" />
              <span v-if="i < gradeHistory.length - 1" class="trail__line" />
            </div>
            <div class="trail__text">
              <p class="trail__move">
                {{ h.from }} <span class="trail__arrow">→</span> {{ h.to }}
              </p>
              <p class="trail__reason">{{ h.reason }}</p>
              <p class="trail__meta">{{ h.at }} · 来源 {{ h.source }}</p>
            </div>
          </div>
        </div>
        <p class="card__note">
          学段的唯一写路径是服务端推断；学生端没有选择入口，也没有确认步骤。
        </p>
      </section>

      <!-- ★ A2 拆出的卡 ②：判定信号 -->
      <section class="card">
        <header class="card__head">
          <Activity :size="14" />
          <h2 class="card__title">判定信号</h2>
          <span class="card__meta">置信度 {{ Math.round(gradeSignals.confidence * 100) }}%</span>
        </header>
        <div class="signals">
          <div v-for="s in gradeSignals.signals" :key="s.signalType" class="sig">
            <div class="sig__top">
              <span class="sig__type">{{ signalTypeLabel[s.signalType] ?? s.signalType }}</span>
              <span class="sig__val">{{ Math.round(s.value * 100) }}%</span>
            </div>
            <div class="sig__track">
              <span class="sig__fill" :style="{ width: `${Math.round(s.value * 100)}%` }" />
            </div>
            <p class="sig__raw">{{ s.raw }}</p>
          </div>
        </div>
        <div class="card__rules">
          <p>置信度 &lt; 0.6 不改 · 连续 3 轮同向才动 · 单次最多动一级 · 5 轮冷却</p>
        </div>
      </section>

      <!-- ★ A2 拆出的卡 ③：学段隔离检索 -->
      <section class="card">
        <header class="card__head">
          <ShieldCheck :size="14" />
          <h2 class="card__title">学段隔离检索</h2>
          <span class="card__meta">SQL 层强制</span>
        </header>
        <div class="iso">
          <div v-for="r in isolationRows" :key="r.label" class="iso__row">
            <span class="k12-dot" :class="r.on ? 'iso__dot-on' : 'iso__dot-off'" />
            <span class="iso__label" :class="{ 'iso__label--off': !r.on }">{{ r.label }}</span>
            <span class="iso__state" :class="{ 'iso__state--on': r.on }">{{ r.state }}</span>
          </div>
        </div>
        <div class="iso__notice">
          <BookOpen :size="13" />
          <span>{{ isolationNotice.text }}</span>
        </div>
        <p class="card__note">
          过滤写在 SQL 里，不在应用层筛 —— 否则会被 KNN top-k 提前截断。
        </p>
      </section>

      <!-- 学习历史 -->
      <section class="card">
        <header class="card__head">
          <Timer :size="14" />
          <h2 class="card__title">近 7 日学习量</h2>
          <span class="card__meta">4 类交互</span>
        </header>
        <div class="bars">
          <div v-for="d in weeklyActivity" :key="d.day" class="bar">
            <div class="bar__stack">
              <span class="bar__seg bar__seg--quiz" :style="{ height: `${(d.quiz / 9) * 100}%` }" />
              <span class="bar__seg bar__seg--coding" :style="{ height: `${(d.coding / 9) * 100}%` }" />
              <span class="bar__seg bar__seg--anim" :style="{ height: `${(d.animation / 9) * 100}%` }" />
              <span class="bar__seg bar__seg--qa" :style="{ height: `${(d.qa / 9) * 100}%` }" />
            </div>
            <span class="bar__label">{{ d.day.slice(-1) }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pf {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pf__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.sum {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.sum__ico {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: var(--k12-r-xl);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sum__text {
  min-width: 0;
}
.sum__k {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.sum__v {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}

.pf__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 14px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
}
.card--wide {
  grid-column: 1 / -1;
}
.card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
}
.card__title {
  font-size: var(--k12-fs-md);
  font-weight: 650;
  color: var(--k12-fg);
}
.card__meta {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.card__note {
  font-size: var(--k12-fs-micro);
  line-height: 1.7;
  color: var(--k12-muted);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.row__name {
  width: 130px;
  flex: none;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__track {
  flex: 1;
  height: 7px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.row__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
}
.row__fill[data-level='high'] {
  background: var(--k12-good);
}
.row__fill[data-level='mid'] {
  background: var(--k12-warn);
}
.row__fill[data-level='low'] {
  background: var(--k12-bad);
}
.row__pct {
  width: 36px;
  flex: none;
  text-align: right;
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.row__detail {
  width: 62px;
  flex: none;
  text-align: right;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}

/* 学段轨迹 */
.trail {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.trail__row {
  display: flex;
  gap: 10px;
}
.trail__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 10px;
  flex: none;
}
.trail__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--k12-accent);
  flex: none;
  margin-top: 4px;
}
.trail__line {
  flex: 1;
  width: 2px;
  background: var(--k12-border);
  margin: 3px 0;
}
.trail__text {
  flex: 1;
  min-width: 0;
  padding-bottom: 12px;
}
.trail__move {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg);
}
.trail__arrow {
  color: var(--k12-accent);
}
.trail__reason {
  margin-top: 3px;
  font-size: var(--k12-fs-micro);
  line-height: 1.6;
  color: var(--k12-muted);
}
.trail__meta {
  margin-top: 3px;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}

/* 判定信号 */
.signals {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.sig {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.sig__top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sig__type {
  font-size: var(--k12-fs-micro);
  font-weight: 620;
  color: var(--k12-fg-2);
}
.sig__val {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-accent);
}
.sig__track {
  height: 5px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.sig__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent);
}
.sig__raw {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
  line-height: 1.5;
}
.card__rules {
  padding: 8px 10px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
}
.card__rules p {
  font-size: var(--k12-fs-micro);
  line-height: 1.6;
  color: var(--k12-muted);
}

/* 隔离 */
.iso {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.iso__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.iso__dot-on {
  background: var(--k12-good);
}
.iso__dot-off {
  background: var(--k12-border-strong);
}
.iso__label {
  flex: 1;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.iso__label--off {
  color: var(--k12-muted-2);
}
.iso__state {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-muted-2);
}
.iso__state--on {
  color: var(--k12-good);
}
.iso__notice {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-good-soft);
  color: #0b7a57;
  font-size: var(--k12-fs-micro);
  font-weight: 550;
}

/* 柱状 */
.bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 110px;
}
.bar {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  height: 100%;
}
.bar__stack {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  border-radius: var(--k12-r-sm);
  overflow: hidden;
  background: var(--k12-surface-2);
}
.bar__seg {
  display: block;
  width: 100%;
}
.bar__seg--qa {
  background: var(--k12-accent);
}
.bar__seg--anim {
  background: var(--k12-accent-2);
}
.bar__seg--coding {
  background: var(--k12-cyan);
}
.bar__seg--quiz {
  background: var(--k12-good);
}
.bar__label {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
</style>
