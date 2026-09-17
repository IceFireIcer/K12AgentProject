<script setup lang="ts">
/**
 * 多模态工作台（画布「3. 多模态工作台」）。
 *
 * 这是与「侧栏 7 页」不同的另一种 IA：**四交互同屏协作**，
 * 不占导航项（挂在 /app/workbench）。保留它的理由是答辩现场表现力强 ——
 * 一屏同时看到对话 / 动画 / 编程 / 闯关，直接对应赛题「四种核心交互」。
 *
 * ⚠️ 沿用同一套修正：顶栏无学段选择器，学段为只读胶囊。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { MessageCircle, Clapperboard, Code, Trophy, Plus, ShieldCheck, ArrowUpRight, Sparkles } from 'lucide-vue-next'
import AnimationCard from '@/cards/AnimationCard.vue'
import CodingCard from '@/cards/CodingCard.vue'
import QuizCard from '@/cards/QuizCard.vue'
import GradeIndicator from '@/components/GradeIndicator.vue'
import { userQuestion, aiAnswer, mastery, kpNames, recommendation, toolTrace } from '@/mocks'

const router = useRouter()
const active = ref<'chat' | 'animation' | 'coding' | 'quiz'>('chat')

const modes = [
  { key: 'chat', label: '对话', icon: MessageCircle, route: '/app/chat' },
  { key: 'animation', label: '动画', icon: Clapperboard, route: '/app/animation' },
  { key: 'coding', label: '编程', icon: Code, route: '/app/coding' },
  { key: 'quiz', label: '闯关', icon: Trophy, route: '/app/quiz' }
] as const

const tiles = [
  { key: 'chat', title: '对话问答', desc: '学段自适应讲解', state: '进行中', route: '/app/chat' },
  { key: 'animation', title: '动画讲解', desc: '模板优先 + 生成补充', state: '待播放', route: '/app/animation' },
  { key: 'coding', title: '编程环境', desc: 'Pyodide 本地沙箱', state: '未运行', route: '/app/coding' },
  { key: 'quiz', title: '闯关练习', desc: '3 题快速检验', state: '3 关待闯', route: '/app/quiz' }
] as const
</script>

<template>
  <div class="wb">
    <!-- 指令栏：模块切换 + 新建会话 -->
    <div class="wb__bar">
      <div class="wb__prompt">
        <Sparkles :size="15" class="wb__spark" />
        <span class="wb__ph">问我任何问题，或直接说「用动画讲一下冒泡排序」…</span>
      </div>
      <div class="wb__modes">
        <button
          v-for="m in modes"
          :key="m.key"
          type="button"
          class="wb__mode"
          :class="{ 'wb__mode--on': active === m.key }"
          @click="active = m.key"
        >
          {{ m.label }}
        </button>
      </div>
      <button type="button" class="wb__new"><Plus :size="13" /><span>新建会话</span></button>
    </div>

    <!-- 四磁贴 -->
    <div class="wb__tiles">
      <button v-for="t in tiles" :key="t.key" type="button" class="tile" @click="router.push(t.route)">
        <div class="tile__row">
          <span class="tile__title">{{ t.title }}</span>
          <span class="tile__state">{{ t.state }}</span>
        </div>
        <p class="tile__desc">{{ t.desc }}</p>
      </button>
    </div>

    <!-- 主行：对话列 + 右栏 -->
    <div class="wb__main">
      <section class="wb__chat">
        <header class="wb__chat-head">
          <MessageCircle :size="14" />
          <span class="wb__chat-title">对话</span>
          <GradeIndicator />
        </header>

        <div class="wb__stream">
          <div class="wb__user">{{ userQuestion }}</div>

          <div class="wb__ai">
            <div class="wb__ai-ico"><Sparkles :size="14" /></div>
            <div class="wb__ai-body">
              <p class="wb__ai-lead">{{ aiAnswer.lead }}</p>

              <!-- 按当前模块切换内联卡 -->
              <AnimationCard v-if="active === 'animation'" />
              <CodingCard v-else-if="active === 'coding'" />
              <QuizCard v-else-if="active === 'quiz'" compact />
              <template v-else>
                <div class="wb__hint">
                  <ShieldCheck :size="13" />
                  <span>切到「动画 / 编程 / 闯关」可看同屏协作的内联卡</span>
                </div>
              </template>
            </div>
          </div>
        </div>

        <div class="wb__composer">
          <span class="wb__ph wb__ph--sm">继续提问…</span>
        </div>
      </section>

      <!-- 右栏：画像 / 依赖图 / 轨迹 -->
      <aside class="wb__rail">
        <div class="panel">
          <header class="panel__head"><span class="panel__title">画像</span></header>
          <div class="mini">
            <div v-for="m in mastery.slice(0, 3)" :key="m.kpId" class="mini__row">
              <span class="mini__k">{{ kpNames[m.kpId] ?? m.kpId }}</span>
              <span class="mini__track"><span class="mini__fill" :style="{ width: `${Math.round(m.score * 100)}%` }" /></span>
              <span class="mini__v">{{ Math.round(m.score * 100) }}%</span>
            </div>
          </div>
        </div>

        <div class="panel">
          <header class="panel__head"><span class="panel__title">依赖图</span><span class="panel__meta">推荐</span></header>
          <div class="dep">
            <span class="dep__pill">{{ recommendation.kpName }}</span>
            <p class="dep__desc">{{ recommendation.reason }}</p>
            <button type="button" class="dep__btn" @click="router.push(recommendation.targetRoute)">
              <span>{{ recommendation.ctaLabel }}</span>
              <ArrowUpRight :size="12" />
            </button>
          </div>
        </div>

        <div class="panel">
          <header class="panel__head"><span class="panel__title">轨迹</span><span class="panel__meta">{{ toolTrace.length }} 次</span></header>
          <div class="trace">
            <div v-for="t in toolTrace" :key="t.toolName" class="trace__row">
              <span class="k12-dot trace__dot" />
              <code class="trace__name">{{ t.toolName }}</code>
              <span class="trace__ms">{{ t.latencyMs }}ms</span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.wb {
  padding: 14px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wb__bar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.wb__prompt {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 14px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.wb__spark {
  color: var(--k12-accent);
  flex: none;
}
.wb__ph {
  font-size: var(--k12-fs-md);
  color: var(--k12-muted-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb__ph--sm {
  font-size: var(--k12-fs-xs);
}
.wb__modes {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
  flex: none;
}
.wb__mode {
  padding: 6px 14px;
  border: none;
  border-radius: var(--k12-r-md);
  background: transparent;
  color: var(--k12-muted);
  font-size: var(--k12-fs-base);
  font-weight: 550;
  cursor: pointer;
}
.wb__mode--on {
  background: var(--k12-surface);
  color: var(--k12-accent);
  font-weight: 650;
}
.wb__new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 13px;
  border: none;
  border-radius: var(--k12-r-lg);
  background: var(--k12-accent);
  color: #fff;
  font-size: var(--k12-fs-base);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}

.wb__tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 12px;
  border: 1px solid var(--k12-glass-border);
  border-radius: var(--k12-r-3xl);
  background: var(--k12-glass);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.16s ease;
}
.tile:hover {
  border-color: var(--k12-accent-border);
}
.tile__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tile__title {
  font-size: var(--k12-fs-md);
  font-weight: 650;
  color: var(--k12-fg);
}
.tile__state {
  margin-left: auto;
  padding: 2px 7px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}
.tile__desc {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}

.wb__main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 12px;
  align-items: start;
}
.wb__chat {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 13px 14px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.wb__chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
}
.wb__chat-title {
  font-size: var(--k12-fs-md);
  font-weight: 650;
  color: var(--k12-fg);
  margin-right: auto;
}
.wb__stream {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wb__user {
  align-self: flex-end;
  max-width: 420px;
  padding: 10px 13px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-accent);
  color: #fff;
  font-size: var(--k12-fs-md);
  line-height: 1.6;
}
.wb__ai {
  display: flex;
  gap: 9px;
}
.wb__ai-ico {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: var(--k12-r-md);
  background: linear-gradient(135deg, var(--k12-accent), var(--k12-accent-2));
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.wb__ai-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wb__ai-lead {
  font-size: var(--k12-fs-md);
  line-height: 1.75;
  color: var(--k12-fg-2);
}
.wb__hint {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 10px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
}
.wb__composer {
  display: flex;
  align-items: center;
  padding: 11px 13px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
}

.wb__rail {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 13px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
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
.panel__meta {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.mini {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.mini__row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.mini__k {
  width: 78px;
  flex: none;
  font-size: var(--k12-fs-micro);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini__track {
  flex: 1;
  height: 5px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.mini__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent);
}
.mini__v {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.dep {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dep__pill {
  align-self: flex-start;
  padding: 3px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
}
.dep__desc {
  font-size: var(--k12-fs-micro);
  line-height: 1.7;
  color: var(--k12-muted);
}
.dep__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 0;
  border: none;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  cursor: pointer;
}
.trace {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.trace__row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.trace__dot {
  background: var(--k12-good);
}
.trace__name {
  flex: 1;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-micro);
  color: var(--k12-fg);
}
.trace__ms {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
</style>
