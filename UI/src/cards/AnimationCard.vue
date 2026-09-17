<script setup lang="ts">
/**
 * 动画讲解内联卡。
 *
 * ⚠️ 引擎不接（用户决策）：这里**不引入 Anime.js、不创建 iframe 沙箱**，
 * 「舞台」用静态图层结构呈现设计稿的四层网络与节点。
 * 接线时把这个 Stage 换成 sandboxed iframe（**禁止 allow-same-origin**），
 * 数据换成 `payload` 事件的 `AnimationPayload`（html 为自包含 HTML）。
 */
import { ref } from 'vue'
import { Maximize2, Play, Pause, RotateCcw, Volume2, Gauge } from 'lucide-vue-next'
import { animationStages, animationPayload, animationPlayback } from '@/mocks'

const playing = ref(false)
const stages = animationStages

function toggle() {
  playing.value = !playing.value
}
</script>

<template>
  <div class="an">
    <!-- 卡头 -->
    <div class="an__head">
      <span class="an__tag">动画</span>
      <div class="an__head-text">
        <p class="an__title">{{ animationPayload.concept }}</p>
        <p class="an__meta">模板「神经网络前向传播」· Anime.js · 沙箱 iframe</p>
      </div>
      <button type="button" class="an__expand" title="全屏"><Maximize2 :size="13" /></button>
    </div>

    <!-- 舞台：静态图层结构（引擎未接） -->
    <div class="an__stage">
      <div v-for="layer in stages" :key="layer.name" class="an__layer">
        <p class="an__layer-name">{{ layer.name }}</p>
        <div class="an__dots">
          <span
            v-for="i in layer.nodes"
            :key="i"
            class="an__node"
            :class="{ 'an__node--hot': i === 1 }"
          />
        </div>
        <p class="an__layer-detail">{{ layer.detail }}</p>
      </div>
      <span class="an__badge">静态预览 · 引擎未接</span>
    </div>

    <!-- 播放条 -->
    <div class="an__foot">
      <button type="button" class="an__ctrl" @click="toggle">
        <component :is="playing ? Pause : Play" :size="13" />
      </button>
      <button type="button" class="an__ctrl an__ctrl--ghost"><RotateCcw :size="13" /></button>
      <div class="an__progress"><span class="an__fill" :style="{ width: `${animationPlayback.progress * 100}%` }" /></div>
      <span class="an__time">{{ animationPlayback.elapsedLabel }} / {{ animationPlayback.totalLabel }}</span>
      <button type="button" class="an__ctrl an__ctrl--ghost"><Volume2 :size="13" /></button>
      <button type="button" class="an__ctrl an__ctrl--ghost"><Gauge :size="13" /></button>
    </div>
  </div>
</template>

<style scoped>
.an {
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
  overflow: hidden;
}

.an__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 13px;
}
.an__tag {
  padding: 3px 8px;
  border-radius: var(--k12-r-sm);
  background: var(--k12-accent-soft);
  color: #7c3aed;
  font-size: var(--k12-fs-micro);
  font-weight: 700;
  flex: none;
}
.an__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.an__title {
  font-size: var(--k12-fs-base);
  font-weight: 650;
  color: var(--k12-fg);
}
.an__meta {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.an__expand {
  border: none;
  background: transparent;
  color: var(--k12-muted-2);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--k12-r-sm);
  display: inline-flex;
  flex: none;
}
.an__expand:hover {
  background: var(--k12-surface-2);
}

/* 舞台：设计稿用 --fg 深色作底，节点为彩色圆点 */
.an__stage {
  position: relative;
  margin: 0 13px;
  padding: 14px 16px;
  border-radius: var(--k12-r-3xl);
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
  gap: 6px;
  flex: 1;
}
.an__layer-name {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: #96a0be;
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
  background: var(--k12-fg-2);
}
.an__node--hot {
  background: var(--k12-accent-2);
}
.an__layer-detail {
  font-size: 8.5px;
  color: #5b6482;
  text-align: center;
}
.an__badge {
  position: absolute;
  right: 10px;
  bottom: 8px;
  font-size: 8.5px;
  color: #5b6482;
}

.an__foot {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 13px;
}
.an__ctrl {
  width: 22px;
  height: 22px;
  flex: none;
  border: none;
  border-radius: var(--k12-r-sm);
  background: var(--k12-accent);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.an__ctrl--ghost {
  background: transparent;
  color: var(--k12-fg-2);
}
.an__ctrl--ghost:hover {
  background: var(--k12-surface-2);
}
.an__progress {
  flex: 1;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.an__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent);
}
.an__time {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
  flex: none;
  font-variant-numeric: tabular-nums;
}
</style>
