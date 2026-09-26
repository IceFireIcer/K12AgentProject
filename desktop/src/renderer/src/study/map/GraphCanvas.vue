<script setup lang="ts">
/**
 * 学习地图的 **Canvas 渲染模式**（优化报告 §5.2 第三条：>100 节点切 Canvas）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是「Canvas + DOM 命中层」而不是纯 Canvas
 * ---------------------------------------------------------------------------
 * Canvas 画图快，但它**没有元素**：读屏读不到、Tab 也 Tab 不进去 —— 而本仓的
 * 硬纪律是「所有可点元素必须键盘可达」（`tests/keyboard-a11y.test.ts`）。
 * 所以这里分两层：
 *   · `<canvas>`：只画（`aria-hidden`，它不承载语义）；
 *   · **命中层**：给**当前可见**的节点各放一枚透明的真按钮（`<button>`），
 *     键盘 / 读屏 / 点击全部走它们 —— 被裁剪的节点本来就不在屏幕上，
 *     按钮数量因此始终是「视口里的几十个」，不会退化成 500 个 DOM 节点。
 *
 * ★ LOD（`lod.ts`）按**缩放档**生效：1:1 画完整标签；适应宽度（zoom < 1）
 *   依次退化成图标 / 点 —— 这正是报告 §5.2 的三档。
 * ★ 与 SVG 那条路**共用同一份布局与裁剪**（`layout.ts` / `culling.ts`）：
 *   两条渲染路径的坐标、选中语义、testid 锚点都是一个来源。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { edgePath, nodeLabel, nodeRect, type GraphLayout } from './layout'
import { edgeRect, visibleItems, type MapViewport } from './culling'
import { clampZoom, lodForZoom, showsLabel, type MapLod } from './lod'

const props = defineProps<{
  layout: GraphLayout
  selected?: string
  /** 当前视口（画布坐标；由 `MapTab.vue` 跟着滚动容器给）。 */
  viewport?: MapViewport | null
  /** 缩放（1 = 1:1；<1 = 「适应宽度」那种缩略视图）。 */
  zoom?: number
}>()

const emit = defineEmits<{ select: [kpId: string] }>()

const canvas = ref<HTMLCanvasElement | null>(null)
let observer: ResizeObserver | null = null

/** 缩放夹在 [0.1, 1.5]（见 `clampZoom` 的说明）。 */
const scale = computed(() => clampZoom(props.zoom ?? 1))
/** 细节档：报告的三档（zoom < 0.5 点 / < 1.0 图标 / 其余完整）。 */
const lod = computed<MapLod>(() => lodForZoom(scale.value))
/** 画布尺寸（CSS 像素）：缩放后仍按 1:1 的用户单位画，坐标不用改。 */
const width = computed(() => Math.max(1, Math.round(props.layout.width * scale.value)))
const height = computed(() => Math.max(1, Math.round(props.layout.height * scale.value)))

/** 当前可见的节点 / 边（视口裁剪，与 SVG 那条路同一个实现）。 */
const visibleNodes = computed(() =>
  props.viewport ? visibleItems(props.layout.nodes, nodeRect, props.viewport) : props.layout.nodes
)
const visibleEdges = computed(() =>
  props.viewport ? visibleItems(props.layout.edges, edgeRect, props.viewport) : props.layout.edges
)

/** 命中层的按钮（只给可见节点）。 */
const hitNodes = computed(() =>
  visibleNodes.value.map((node) => {
    const rect = nodeRect(node)
    return { node, rect, on: props.selected === node.kpId }
  })
)

/** 画一帧（清屏 → 边 → 节点；颜色从 CSS 令牌读，避免与设计系统两套色）。 */
function draw(): void {
  const element = canvas.value
  if (element === null) return
  const context = element.getContext('2d')
  if (context === null) return

  // 高清屏：后备缓冲按 devicePixelRatio 放大，再用 transform 拉回 CSS 像素
  const dpr = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
    ? Math.max(1, Math.min(2, window.devicePixelRatio))
    : 1
  element.width = Math.round(width.value * dpr)
  element.height = Math.round(height.value * dpr)
  context.setTransform(dpr * scale.value, 0, 0, dpr * scale.value, 0, 0)
  context.clearRect(0, 0, props.layout.width, props.layout.height)

  const styles = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null
  const borderStrong = styles?.getPropertyValue('--k12-border-strong').trim() || '#c9ccd6'
  const surface = styles?.getPropertyValue('--k12-surface').trim() || '#ffffff'
  const accent = styles?.getPropertyValue('--k12-accent').trim() || '#6b7cff'
  const accentSoft = styles?.getPropertyValue('--k12-accent-soft').trim() || '#eaedff'
  const accentInk = styles?.getPropertyValue('--k12-accent-ink').trim() || '#3a49c9'
  const fg = styles?.getPropertyValue('--k12-fg').trim() || '#1c1f2a'

  // ① 边：与 SVG 完全同一条折线（`edgePath`，唯一来源）
  context.strokeStyle = borderStrong
  context.lineWidth = 1.4
  for (const edge of visibleEdges.value) {
    const path = new Path2D(edgePath(edge))
    context.stroke(path)
  }

  // ② 节点
  for (const { node } of hitNodes.value) {
    const rect = nodeRect(node)
    if (lod.value === 'dot') {
      // 点：只画一个小圆点（中心定位，避免"点"被误读成矩形）
      context.beginPath()
      context.arc(node.x, node.y, 4, 0, Math.PI * 2)
      context.fillStyle = node.mastered ? accent : surface
      context.fill()
      context.strokeStyle = node.mastered ? accent : borderStrong
      context.stroke()
      continue
    }
    context.beginPath()
    context.roundRect(rect.x, rect.y, rect.width, rect.height, 9)
    context.fillStyle = node.mastered ? accentSoft : surface
    context.fill()
    context.lineWidth = node.mastered ? 1.6 : 1.2
    context.strokeStyle = node.mastered ? accent : borderStrong
    context.stroke()
    if (!showsLabel(lod.value)) continue
    context.fillStyle = fg
    context.font = '13px "Noto Sans SC Variable", "Microsoft YaHei", sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(nodeLabel(node.name, node.kpId), node.x, node.y)
  }

  // ③ 选中环（与 SVG 一样画在节点外圈）
  for (const { node, on } of hitNodes.value) {
    if (!on) continue
    const rect = nodeRect(node)
    context.beginPath()
    context.roundRect(rect.x - 4, rect.y - 4, rect.width + 8, rect.height + 8, 13)
    context.lineWidth = 2
    context.strokeStyle = accentInk
    context.stroke()
  }
}

onMounted(() => {
  draw()
  if (typeof ResizeObserver !== 'undefined' && canvas.value) {
    observer = new ResizeObserver(() => draw())
    observer.observe(canvas.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

// 数据 / 视口 / 缩放 / 选中任何一项变了都重画（只有可见的那部分）
watch([visibleNodes, visibleEdges, scale, () => props.selected], () => draw())
</script>

<template>
  <div class="gcv" :style="{ width: `${width}px`, height: `${height}px` }">
    <canvas
      ref="canvas"
      class="gcv__canvas"
      :style="{ width: `${width}px`, height: `${height}px` }"
      aria-hidden="true"
      data-testid="study-map-canvas-mode"
    />
    <!-- 命中层：可见节点各一枚真按钮（键盘 / 读屏 / 点击都走这里） -->
    <div class="gcv__hits">
      <button
        v-for="{ node, rect, on } in hitNodes"
        :key="node.kpId"
        type="button"
        class="gcv__hit"
        :class="{ 'gcv__hit--on': on }"
        :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
        :data-testid="`map-node-${node.kpId}`"
        :data-mastered="node.mastered ? 'true' : 'false'"
        :data-layer="node.layer"
        :data-selected="on ? 'true' : 'false'"
        :aria-pressed="on ? 'true' : 'false'"
        :aria-label="`${nodeLabel(node.name, node.kpId)}${node.mastered ? '，已掌握' : '，还没掌握'}`"
        @click="emit('select', node.kpId)"
      />
    </div>
  </div>
</template>

<style scoped>
.gcv {
  position: relative;
  /* 尺寸由 style 给（缩放后的画布尺寸）—— 父容器负责滚动 */
}
.gcv__canvas {
  display: block;
}
.gcv__hits {
  position: absolute;
  inset: 0;
}
/* 透明按钮：看得见的是 canvas 画的节点，点到的是这一层 */
.gcv__hit {
  position: absolute;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.gcv__hit:focus-visible {
  outline: 2px dashed var(--k12-accent-ink);
  outline-offset: 3px;
}
</style>
