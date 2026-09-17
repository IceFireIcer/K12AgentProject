<script setup lang="ts">
/**
 * 动画讲解：模板库（模板优先 + 生成补充）+ 播放台。
 * 引擎不接（用户决策）：不引入 Anime.js、不建 iframe 沙箱，舞台为静态图层。
 *
 * 接线时：舞台换成 sandboxed iframe（**禁止 allow-same-origin**），
 * 资源经一次性 nonce 路由托管（iframe 带不了自定义 header）。
 */
import { ref } from 'vue'
import { Play, Plus, Wand2, Library, Maximize2 } from 'lucide-vue-next'
import { animationStages, animationPlayback } from '@/mocks'

interface Template {
  id: string
  name: string
  concept: string
  grades: string[]
  /** 模板优先；生成的走 generate_animation */
  source: 'template' | 'generated'
}

/** 真实模板清单在 server/resources/templates/*.json（8 个） */
const templates: Template[] = [
  { id: 'nn-forward', name: '神经网络前向传播', concept: '特征提取', grades: ['初中', '高中'], source: 'template' },
  { id: 'bubble-sort', name: '冒泡排序', concept: '排序算法', grades: ['小学高', '初中'], source: 'template' },
  { id: 'decision-tree', name: '决策树分裂', concept: '决策树', grades: ['初中'], source: 'template' },
  { id: 'gradient-descent', name: '梯度下降下山', concept: '损失函数', grades: ['高中'], source: 'template' },
  { id: 'knn-vote', name: 'KNN 投票', concept: '最近邻', grades: ['高中'], source: 'template' },
  { id: 'train-test-split', name: '训练/测试集划分', concept: '模型评估', grades: ['初中', '高中'], source: 'template' }
]

const active = ref(templates[0]!.id)
const playing = ref(false)
</script>

<template>
  <div class="anim">
    <!-- 左侧：模板库 -->
    <aside class="anim__side">
      <header class="anim__side-head">
        <Library :size="14" />
        <span class="anim__side-title">动画模板</span>
        <span class="anim__side-meta">{{ templates.length }} 个</span>
      </header>
      <button
        v-for="t in templates"
        :key="t.id"
        type="button"
        class="tpl"
        :class="{ 'tpl--on': active === t.id }"
        @click="active = t.id"
      >
        <div class="tpl__top">
          <span class="tpl__name">{{ t.name }}</span>
          <span class="tpl__src" :data-src="t.source">
            {{ t.source === 'template' ? '模板' : '生成' }}
          </span>
        </div>
        <p class="tpl__concept">{{ t.concept }}</p>
        <div class="tpl__grades">
          <span v-for="g in t.grades" :key="g" class="tpl__grade">{{ g }}</span>
        </div>
      </button>
      <button type="button" class="tpl tpl--new">
        <Plus :size="13" />
        <span>用 AI 生成新动画</span>
      </button>
      <p class="anim__side-note">
        生成链路：校验 → 失败重试 ≤3 次 → 降级为文字/静态图。模板内不得内联 CDN。
      </p>
    </aside>

    <!-- 右侧：播放台 -->
    <section class="anim__stage-wrap">
      <header class="anim__head">
        <div class="anim__head-text">
          <h2 class="anim__title">{{ templates.find((t) => t.id === active)?.name }}</h2>
          <p class="anim__sub">模板「{{ templates.find((t) => t.id === active)?.name }}」· Anime.js · 沙箱 iframe</p>
        </div>
        <button type="button" class="anim__ghost"><Wand2 :size="13" /><span>重新生成</span></button>
        <button type="button" class="anim__ghost"><Maximize2 :size="13" /><span>全屏</span></button>
      </header>

      <div class="anim__stage">
        <div v-for="layer in animationStages" :key="layer.name" class="anim__layer">
          <p class="anim__layer-name">{{ layer.name }}</p>
          <div class="anim__dots">
            <span v-for="i in layer.nodes" :key="i" class="anim__node" :class="{ 'anim__node--hot': i === 1 }" />
          </div>
          <p class="anim__layer-detail">{{ layer.detail }}</p>
        </div>
        <span class="anim__badge">静态预览 · 引擎未接</span>
      </div>

      <footer class="anim__foot">
        <button type="button" class="anim__play" @click="playing = !playing">
          <Play :size="14" />
        </button>
        <div class="anim__progress">
          <span class="anim__fill" :style="{ width: `${animationPlayback.progress * 100}%` }" />
        </div>
        <span class="anim__time">{{ animationPlayback.elapsedLabel }} / {{ animationPlayback.totalLabel }}</span>
        <button type="button" class="anim__ghost">重新播放</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.anim {
  display: flex;
  height: 100%;
  min-height: 0;
}
.anim__side {
  width: 268px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-right: 1px solid var(--k12-border);
  background: var(--k12-glass-2);
  overflow-y: auto;
}
.anim__side-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--k12-muted);
  padding: 0 2px 4px;
}
.anim__side-title {
  font-size: var(--k12-fs-tiny);
  font-weight: 650;
  color: var(--k12-muted);
}
.anim__side-meta {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.tpl {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 11px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-2xl);
  background: var(--k12-surface);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.16s ease, background 0.16s ease;
}
.tpl:hover {
  border-color: var(--k12-accent-border);
}
.tpl--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.tpl__top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tpl__name {
  flex: 1;
  font-size: var(--k12-fs-xs);
  font-weight: 620;
  color: var(--k12-fg);
}
.tpl__src {
  padding: 2px 6px;
  border-radius: var(--k12-r-xs);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
}
.tpl__src[data-src='template'] {
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
}
.tpl__src[data-src='generated'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.tpl__concept {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.tpl__grades {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.tpl__grade {
  padding: 1px 6px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: 8.5px;
}
.tpl--new {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-style: dashed;
  color: var(--k12-accent);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
}
.anim__side-note {
  padding: 8px 9px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  line-height: 1.6;
}

.anim__stage-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 20px 18px;
  gap: 12px;
}
.anim__head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.anim__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.anim__title {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}
.anim__sub {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.anim__ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-md);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}
.anim__ghost:hover {
  border-color: var(--k12-accent-border);
}

.anim__stage {
  position: relative;
  flex: 1;
  min-height: 240px;
  padding: 24px 28px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-fg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.anim__layer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  flex: 1;
}
.anim__layer-name {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: #96a0be;
}
.anim__dots {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
}
.anim__node {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--k12-fg-2);
}
.anim__node--hot {
  background: var(--k12-accent-2);
}
.anim__layer-detail {
  font-size: var(--k12-fs-micro);
  color: #5b6482;
}
.anim__badge {
  position: absolute;
  right: 14px;
  bottom: 12px;
  font-size: var(--k12-fs-micro);
  color: #5b6482;
}

.anim__foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.anim__play {
  width: 30px;
  height: 30px;
  flex: none;
  border: none;
  border-radius: var(--k12-r-lg);
  background: var(--k12-accent);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.anim__progress {
  flex: 1;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.anim__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent);
}
.anim__time {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
  font-variant-numeric: tabular-nums;
}
</style>
