<script setup lang="ts">
/**
 * 学习台首页：四入口磁贴 + 继续学习 + 本周概览。
 * 对齐画布「1. 学习台首页」：Backdrop + Sidebar + Main(Topbar + Content)。
 */
import { useRouter } from 'vue-router'
import { MessageCircle, Clapperboard, Code, Trophy, ArrowUpRight, Flame, Target, Zap } from 'lucide-vue-next'
import { mastery, kpNames, weeklyActivity, progressRows, recommendation } from '@/mocks'

const router = useRouter()

/** 四种交互（核心范围，画布与技术方案一致） */
const entries = [
  { name: 'chat', title: '对话问答', desc: '随时提问，学段自适应讲解', icon: MessageCircle, route: '/app/chat', badge: '4 条待续' },
  { name: 'animation', title: '动画讲解', desc: '模板优先，把抽象概念动起来', icon: Clapperboard, route: '/app/animation', badge: '12 个模板' },
  { name: 'coding', title: '编程环境', desc: '写 Python，隔离沙箱里跑', icon: Code, route: '/app/coding', badge: '本地执行' },
  { name: 'quiz', title: '闯关练习', desc: '客观题规则判分，主观题 LLM 判分', icon: Trophy, route: '/app/quiz', badge: '3 关待闯' }
]

const stats = [
  { icon: Flame, label: '连续学习', value: '12 天' },
  { icon: Zap, label: '本周交互', value: `${weeklyActivity.reduce((a, b) => a + b.qa + b.animation + b.coding + b.quiz, 0)} 次` },
  { icon: Target, label: '已掌握知识点', value: `${mastery.filter((m) => m.score >= 0.7).length} / ${mastery.length}` }
]

const maxBar = Math.max(...weeklyActivity.map((d) => d.qa + d.animation + d.coding + d.quiz))
</script>

<template>
  <div class="home">
    <!-- 四入口磁贴 -->
    <section class="home__tiles">
      <button
        v-for="e in entries"
        :key="e.name"
        type="button"
        class="tile"
        @click="router.push(e.route)"
      >
        <div class="tile__ico"><component :is="e.icon" :size="18" /></div>
        <div class="tile__text">
          <p class="tile__title">{{ e.title }}</p>
          <p class="tile__desc">{{ e.desc }}</p>
        </div>
        <span class="tile__badge">{{ e.badge }}</span>
      </button>
    </section>

    <!-- 统计条 -->
    <section class="home__stats">
      <div v-for="s in stats" :key="s.label" class="stat">
        <component :is="s.icon" :size="14" class="stat__ico" />
        <span class="stat__label">{{ s.label }}</span>
        <span class="stat__value">{{ s.value }}</span>
      </div>
    </section>

    <div class="home__main">
      <!-- 继续学习 -->
      <section class="panel panel--wide">
        <header class="panel__head">
          <h2 class="panel__title">继续学习</h2>
          <span class="panel__meta">按依赖图推荐</span>
        </header>
        <div class="reco">
          <span class="reco__pill">{{ recommendation.kpName }}</span>
          <p class="reco__desc">{{ recommendation.reason }}</p>
          <button type="button" class="reco__btn" @click="router.push(recommendation.targetRoute)">
            <span>{{ recommendation.ctaLabel }}</span>
            <ArrowUpRight :size="13" />
          </button>
        </div>

        <div class="rows">
          <div v-for="r in progressRows" :key="r.kpId" class="row">
            <span class="row__name">{{ r.name }}</span>
            <span class="row__stage" :data-stage="r.stage">
              {{ { locked: '未解锁', learning: '学习中', quizzed: '已闯关', mastered: '已掌握' }[r.stage] }}
            </span>
            <div class="row__track">
              <span class="row__fill" :style="{ width: `${Math.round(r.score * 100)}%` }" />
            </div>
            <span class="row__pct">{{ Math.round(r.score * 100) }}%</span>
          </div>
        </div>
      </section>

      <!-- 本周活动 -->
      <section class="panel">
        <header class="panel__head">
          <h2 class="panel__title">本周活动</h2>
          <span class="panel__meta">4 类交互</span>
        </header>
        <div class="bars">
          <div v-for="d in weeklyActivity" :key="d.day" class="bar">
            <div class="bar__stack">
              <span class="bar__seg bar__seg--quiz" :style="{ height: `${(d.quiz / maxBar) * 100}%` }" />
              <span class="bar__seg bar__seg--coding" :style="{ height: `${(d.coding / maxBar) * 100}%` }" />
              <span class="bar__seg bar__seg--anim" :style="{ height: `${(d.animation / maxBar) * 100}%` }" />
              <span class="bar__seg bar__seg--qa" :style="{ height: `${(d.qa / maxBar) * 100}%` }" />
            </div>
            <span class="bar__label">{{ d.day }}</span>
          </div>
        </div>
        <div class="legend">
          <span class="legend__i"><i class="dot dot--qa" />问答</span>
          <span class="legend__i"><i class="dot dot--anim" />动画</span>
          <span class="legend__i"><i class="dot dot--coding" />编程</span>
          <span class="legend__i"><i class="dot dot--quiz" />闯关</span>
        </div>
      </section>

      <!-- 掌握度概览 -->
      <section class="panel">
        <header class="panel__head">
          <h2 class="panel__title">掌握度概览</h2>
          <span class="panel__meta">最近 4 个知识点</span>
        </header>
        <div class="rows rows--tight">
          <div v-for="m in mastery" :key="m.kpId" class="row row--tight">
            <span class="row__name">{{ kpNames[m.kpId] ?? m.kpId }}</span>
            <div class="row__track">
              <span class="row__fill" :style="{ width: `${Math.round(m.score * 100)}%` }" />
            </div>
            <span class="row__pct">{{ Math.round(m.score * 100) }}%</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.home {
  padding: 18px 22px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.home__tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--k12-glass-border);
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.16s ease, transform 0.16s ease;
}
.tile:hover {
  border-color: var(--k12-accent-border);
  transform: translateY(-1px);
}
.tile__ico {
  width: 34px;
  height: 34px;
  border-radius: var(--k12-r-2xl);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}
.tile__text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tile__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.tile__desc {
  font-size: var(--k12-fs-xs);
  line-height: 1.6;
  color: var(--k12-muted);
}
.tile__badge {
  align-self: flex-start;
  padding: 3px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}

.home__stats {
  display: flex;
  gap: 12px;
}
.stat {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
}
.stat__ico {
  color: var(--k12-accent);
  flex: none;
}
.stat__label {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.stat__value {
  margin-left: auto;
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}

.home__main {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
}
.panel--wide {
  grid-row: span 2;
}
.panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.panel__meta {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}

.reco {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px;
  border-radius: var(--k12-r-3xl);
  background: linear-gradient(120deg, color-mix(in srgb, var(--k12-accent) 8%, #fff), color-mix(in srgb, var(--k12-accent-2) 8%, #fff));
  border: 1px solid var(--k12-accent-border);
}
.reco__pill {
  align-self: flex-start;
  padding: 3px 9px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-accent);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
}
.reco__desc {
  font-size: var(--k12-fs-xs);
  line-height: 1.7;
  color: var(--k12-fg-2);
}
.reco__btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: none;
  border-radius: var(--k12-r-lg);
  background: var(--k12-accent);
  color: #fff;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rows--tight {
  gap: 7px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.row--tight {
  gap: 8px;
}
.row__name {
  width: 120px;
  flex: none;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__stage {
  flex: none;
  padding: 2px 7px;
  border-radius: var(--k12-r-xs);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}
.row__stage[data-stage='mastered'] {
  background: var(--k12-good-soft);
  color: var(--k12-good);
}
.row__stage[data-stage='quizzed'] {
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
}
.row__stage[data-stage='learning'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.row__stage[data-stage='locked'] {
  background: var(--k12-surface-2);
  color: var(--k12-muted-2);
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
  width: 36px;
  flex: none;
  text-align: right;
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-fg-2);
  font-variant-numeric: tabular-nums;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 120px;
}
.bar {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
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
.legend {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.legend__i {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
}
.dot--qa {
  background: var(--k12-accent);
}
.dot--anim {
  background: var(--k12-accent-2);
}
.dot--coding {
  background: var(--k12-cyan);
}
.dot--quiz {
  background: var(--k12-good);
}
</style>
