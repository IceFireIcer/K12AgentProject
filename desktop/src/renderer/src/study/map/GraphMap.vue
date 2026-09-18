<script setup lang="ts">
/**
 * 学习地图的**渲染**（纯 SVG，自绘；布局在 `map/layout.ts` 里，是纯函数）。
 *
 * ★ 一个依赖都不引：见 `map/layout.ts` 的注释（零打包风险 + 演示可能断网）。
 * ★ 渲染层**不做任何几何计算**：所有坐标、路径、矩形都来自布局函数的输出
 *   （`nodeRect` / `edgePath`），这里只负责把数字放进 SVG 属性里。
 * ★ 已掌握 / 未掌握的区分只用**填充色与描边**（不靠颜色单独承载语义，
 *   文字上也能看出来：`data-mastered` 供断言与无障碍读取）。
 */
import { computed } from 'vue'
import { edgePath, nodeLabel, nodeRect, type GraphLayout } from './layout'

const props = defineProps<{ layout: GraphLayout }>()

/** 画布为空时的占位尺寸（避免 `viewBox="0 0 0 0"` 这种非法值）。 */
const viewBox = computed(() =>
  props.layout.nodes.length > 0
    ? `0 0 ${props.layout.width} ${props.layout.height}`
    : '0 0 100 100'
)

/** 每个节点的矩形（预算一次，避免模板里反复调用）。 */
const rects = computed(() =>
  props.layout.nodes.map((node) => ({ node, rect: nodeRect(node) }))
)
</script>

<template>
  <svg
    class="map"
    :viewBox="viewBox"
    :width="layout.width || 100"
    :height="layout.height || 100"
    role="img"
    aria-label="知识点依赖图"
    data-testid="study-map-svg"
  >
    <!-- 边：先画（在节点下层），直角折线 -->
    <g class="map__edges">
      <path
        v-for="edge in layout.edges"
        :key="`${edge.fromKpId}->${edge.toKpId}`"
        :d="edgePath(edge)"
        class="edge"
        :data-from="edge.fromKpId"
        :data-to="edge.toKpId"
        :data-relation="edge.relation"
      />
    </g>

    <!-- 节点 -->
    <g class="map__nodes">
      <g
        v-for="{ node, rect } in rects"
        :key="node.kpId"
        :data-testid="`map-node-${node.kpId}`"
        :data-mastered="node.mastered ? 'true' : 'false'"
        :data-layer="node.layer"
      >
        <rect
          :x="rect.x"
          :y="rect.y"
          :width="rect.width"
          :height="rect.height"
          rx="9"
          class="node"
          :class="{ 'node--mastered': node.mastered }"
        />
        <text :x="node.x" :y="node.y" class="node__text" text-anchor="middle" dominant-baseline="middle">
          {{ nodeLabel(node.name, node.kpId) }}
        </text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.map {
  display: block;
  max-width: 100%;
  height: auto;
}

.edge {
  fill: none;
  stroke: var(--border);
  stroke-width: 1.4;
}

.node {
  fill: var(--surface);
  stroke: var(--border);
  stroke-width: 1.2;
}

.node--mastered {
  fill: var(--accent-soft);
  stroke: var(--accent);
  stroke-width: 1.6;
}

.node__text {
  font-size: 12px;
  fill: var(--text);
  pointer-events: none;
}
</style>
