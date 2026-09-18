<script setup lang="ts">
/**
 * 动画讲解内联卡。
 *
 * ⚠️ 引擎不接（用户决策）：这里**不引入 Anime.js、不创建 iframe 沙箱**，
 * 「舞台」用静态图层结构呈现四层网络的节点布局。
 * 接线时把 Stage 换成 sandboxed iframe（**禁止 allow-same-origin**），
 * 内容换成 `payload.html`（自包含 HTML），播放控制改由 postMessage 驱动。
 *
 * 播放条现在**是真的**：播放/暂停推进进度、重播归零、时间按 `durationMs` 换算。
 * 它模拟的是播放时钟，不是动画引擎 —— 舞台仍是静态图层，卡上仍标注「引擎未接」。
 * 音量与倍速两个按钮已删：契约里既没有音轨也没有倍速字段，留着是纯装饰。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Maximize2, Play, Pause, RotateCcw, MessagesSquare, TriangleAlert } from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import { useReducedMotion } from '@/composables/useReducedMotion'
import { useFloatPanel } from '@/stores/floatPanel'
import { animationStages, animationPayload } from '@/mocks'
import type { AnimationPayload } from '@/types/contract'

const props = withDefaults(defineProps<{ payload?: AnimationPayload }>(), {
  payload: () => animationPayload
})

const router = useRouter()
const floatPanel = useFloatPanel()
const stages = animationStages

const playing = ref(false)
/** 0..1 */
const progress = ref(0)
let timer: number | null = null

/** 减动效：不跑时钟，进度直接给终态（否则时钟照样每 100ms 更新） */
const reduced = useReducedMotion()

const totalMs = computed(() => props.payload.durationMs)

/**
 * 当前"点亮"的图层索引。
 * 由播放进度驱动 —— 上一版写死 `i === 1`（永远只亮第一个点），
 * 于是这段静态图完全不随播放条动，"动画预览"这个身份就是假的。
 */
const activeLayer = computed(() => {
  if (progress.value <= 0) return -1
  return Math.min(stages.length - 1, Math.floor(progress.value * stages.length))
})

function fmt(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const elapsedLabel = computed(() => fmt(progress.value * totalMs.value))
const totalLabel = computed(() => fmt(totalMs.value))

function stop() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  playing.value = false
}

function start() {
  stop()
  if (progress.value >= 1) progress.value = 0
  playing.value = true
  timer = window.setInterval(() => {
    progress.value = Math.min(1, progress.value + 100 / totalMs.value)
    if (progress.value >= 1) stop()
  }, 100)
}

function toggle() {
  if (playing.value) stop()
  else start()
}

function restart() {
  stop()
  progress.value = 0
}

/**
 * 降级展示：动画引擎/生成失败时，学生看到的应当是
 * **这段动画要讲的那件事的文字版**，而不是一个空白舞台。
 *
 * `AnimationPayload.fallbackText` 就是为这个准备的 —— 而它此前
 * **全站从未被渲染过**，于是"失败降级为文字"这条链路在界面上不存在。
 */
const degraded = ref(false)
function ask(e: MouseEvent) {
  floatPanel.openFrom(e.currentTarget as Element, {
    kind: 'animation',
    title: props.payload.concept,
    hint: '可以问：这一步为什么这样算 / 这里的「特征」指什么'
  })
}

onBeforeUnmount(stop)
/** 换一份 payload（重新生成 / 换卡）时回到起点 */
watch(() => props.payload.concept, restart)
/** 减动效下不自动播放，直接给出完整进度（图层全部可见） */
watch(
  reduced,
  (on) => {
    if (on) {
      stop()
      progress.value = 1
    }
  },
  { immediate: true }
)
</script>

<template>
  <SurfacePanel flush tone="card" class="an">
    <!-- 卡头 -->
    <div class="an__head">
      <span class="an__tag">动画</span>
      <div class="an__head-text">
        <p class="an__title">{{ payload.concept }}</p>
        <p class="an__meta">
          {{ payload.source === 'template' ? '模板库' : 'AI 生成' }} · {{ totalLabel }}
        </p>
      </div>
      <button type="button" class="an__ask" title="就地追问这段动画" @click="ask">
        <MessagesSquare :size="14" />
        <span>追问</span>
      </button>
      <button
        type="button"
        class="an__icon"
        title="在动画讲解页展开"
        @click="router.push({ name: 'animation' })"
      >
        <Maximize2 :size="14" />
      </button>
    </div>

    <!-- 降级态：生成失败或引擎不可用时，给文字讲解而不是空白舞台 -->
    <div v-if="degraded" class="an__fallback">
      <div class="an__fallback-head">
        <TriangleAlert :size="14" />
        <span>动画没能生成，先看文字讲法</span>
      </div>
      <p class="an__fallback-text">{{ payload.fallbackText }}</p>
      <button type="button" class="an__fallback-retry" @click="degraded = false">重试一次</button>
    </div>

    <!-- 舞台：静态图层结构（引擎未接）。点亮的那一层跟着播放进度走。 -->
    <div v-else class="an__stage">
      <div
        v-for="(layer, li) in stages"
        :key="layer.name"
        class="an__layer"
        :class="{ 'an__layer--lit': li === activeLayer, 'an__layer--done': li < activeLayer }"
      >
        <p class="an__layer-name">{{ layer.name }}</p>
        <div class="an__dots">
          <span v-for="i in layer.nodes" :key="i" class="an__node" />
        </div>
        <p class="an__layer-detail">{{ layer.detail }}</p>
      </div>
      <span class="an__badge">静态预览 · 引擎未接</span>
    </div>

    <!-- 播放条 -->
    <div class="an__foot">
      <button type="button" class="an__ctrl" :title="playing ? '暂停' : '播放'" @click="toggle">
        <component :is="playing ? Pause : Play" :size="14" />
      </button>
      <button type="button" class="an__ctrl an__ctrl--ghost" title="重播" @click="restart">
        <RotateCcw :size="14" />
      </button>
      <div class="an__progress">
        <span class="an__fill" :style="{ transform: `scaleX(${progress})` }" />
      </div>
      <span class="an__time">{{ elapsedLabel }} / {{ totalLabel }}</span>
      <button
        type="button"
        class="an__degrade"
        title="演示：动画生成失败时的降级展示"
        @click="degraded = true"
      >
        降级演示
      </button>
    </div>
  </SurfacePanel>
</template>

<style scoped>
.an__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}
.an__tag {
  padding: 3px 8px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-micro);
  font-weight: 700;
  flex: none;
}
.an__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.an__title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
}
.an__meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
/* 追问：卡头一级动作，用描边按钮而不是图标按钮 —— 它是这轮新增的主入口 */
.an__ask {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 5px 10px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
.an__ask:hover {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}
}
.an__icon {
  border: none;
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
  padding: 5px;
  border-radius: var(--k12-r-flat);
  display: inline-flex;
  flex: none;
}
@media (hover: hover) and (pointer: fine) {
.an__icon:hover {
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
}
}

/* 舞台：桌面上的一块"屏幕"——唯一与纸相反的材质（深底），
 * 所以文字色走 screen-* 那一族，而不是纸面上的墨色。 */
.an__stage {
  position: relative;
  margin: 0 14px;
  padding: 16px 18px 22px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-fg);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.an__layer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  /* 播放进度点亮某一层时，该层的文字与节点一起变亮 —— 让"进行到哪"可见 */
  opacity: 0.55;
}
.an__layer--done {
  opacity: 0.8;
}
.an__layer--lit {
  opacity: 1;
}
.an__layer-name {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-screen-fg);
}
.an__dots {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: center;
}
.an__node {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--k12-screen-dim);
}
.an__layer--lit .an__node {
  background: var(--k12-accent);
}
.an__layer--done .an__node {
  background: color-mix(in srgb, var(--k12-accent) 55%, var(--k12-screen-dim));
}
.an__layer-detail {
  font-size: var(--k12-fs-xs);
  color: var(--k12-screen-dim);
  text-align: center;
}
.an__badge {
  position: absolute;
  right: 10px;
  bottom: 6px;
  font-size: var(--k12-fs-micro);
  color: var(--k12-screen-dim);
}

.an__foot {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 14px 12px;
}
.an__ctrl {
  width: 26px;
  height: 26px;
  flex: none;
  border: none;
  border-radius: var(--k12-r-control);
  background: var(--k12-accent);
  color: var(--k12-surface);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.an__ctrl--ghost {
  background: transparent;
  color: var(--k12-fg-2);
}
@media (hover: hover) and (pointer: fine) {
.an__ctrl--ghost:hover {
  background: var(--k12-surface-2);
}
}
.an__progress {
  flex: 1;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
/* 进度用 scaleX 而不是 width：宽度动画每帧触发布局，这是性能 finding。
 * transform-origin 放左侧，铺满即从左往右长。 */
.an__fill {
  display: block;
  height: 100%;
  width: 100%;
  transform-origin: left center;
  border-radius: var(--k12-r-pill);
  /* 亮面上的图形用 accent（ink）：signal 是给深底用的，在白底只有 2:1 上下 */
  background: var(--k12-accent);
}
/* 降级态（文字讲法） */
.an__fallback {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 14px;
  padding: 14px 16px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
}
.an__fallback-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-warn);
}
.an__fallback-text {
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.an__fallback-retry {
  align-self: flex-start;
  padding: 6px 12px;
  border: 1px solid var(--k12-warn-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-warn);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
.an__degrade {
  padding: 3px 0;
  border: none;
  background: transparent;
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .an__degrade:hover {
    color: var(--k12-fg-2);
  }
}
.an__time {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  flex: none;
  font-variant-numeric: tabular-nums;
}
</style>
