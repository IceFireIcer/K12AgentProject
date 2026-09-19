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
/*
 * ★★ 画布**按 1:1 渲染，一个字都不许缩放**（改这一条之前先读完）。
 *
 * 这里以前写的是 `max-width: 100%; height: auto` —— 那是「网页自适应」的习惯写法，
 * 但在这张图上是个**可读性缺陷**：`layout.ts` 输出的是**固定像素**画布
 * （junior 实测 1610 × 1600），而 SVG 带 viewBox 时被 CSS 缩窄就**整体等比缩小**，
 * 于是 `--k12-fs-xs`（13px）也跟着缩：
 *
 *     1440 设计基准窗口 → 可用 1440 − 264（侧栏） − 48（内容 padding） = 1128px
 *                          缩放 1128 / 1610 = 0.70 → 字渲染成约 9px
 *     1120 最小窗口     → 可用 808px，缩放 0.50 → 字渲染成约 **6.5px**
 *
 * 6.5px 的中文在学生那儿等于「看不清」，而且**外层 `.canvas` 的 `overflow: auto`
 * 永远不滚**（内容被 max-width 缩得刚刚好装下，没有溢出可滚）——
 * 也就是说：既牺牲了字号，又没有换来任何别的东西。
 *
 * 所以这里去掉缩放，让 `.canvas` 真的横向滚动。取舍（为什么选滚动而不是拆图）：
 *   · **不拆图**：这张图的价值就是「跨章节的长依赖链一眼可见」（见 `layout.ts` 文件头），
 *     按章节拆成多张子图会把**图与图之间的边**全丢掉 —— 那不是排版变通，是换了信息。
 *   · **不缩字**：字号阶梯是 8 档固定令牌（D-043），在页面里写 `font-size: <数字>px`
 *     被明令禁止 —— 所以「把 13px 调大」不是正确修法（`assets/base.css` 也不归本组件管）。
 *   · **代价**：窄窗口下要横向滚动才看得到图的右半边。这是**如实呈现**：
 *     滚动条至少说明「图比窗口宽」，等比缩小则悄悄把字变成 6.5px、还不给任何提示。
 *
 * ⚠️ 别再写回 `max-width: 100%` / `width: 100%` / `transform: scale(...)`：
 *    三者都会让上面那条等比缩放回来。守卫见 `desktop/tests/study-views.test.ts`。
 */
.map {
  display: block;
  /* 尺寸只认 `:width` / `:height` 属性（= 布局函数给的那两个数）：CSS 一个数都不加，
     于是 SVG 的用户单位恒等于 CSS 像素，`--k12-fs-xs` 在屏幕上就是 13px 整。 */
  max-width: none;
}

.edge {
  fill: none;
  /* 边用 border-strong（不是 border）：白卡上的极浅细线在这个尺寸下几乎看不见 */
  stroke: var(--k12-border-strong);
  stroke-width: 1.4;
}

.node {
  fill: var(--k12-surface);
  stroke: var(--k12-border-strong);
  stroke-width: 1.2;
}

.node--mastered {
  fill: var(--k12-accent-soft);
  stroke: var(--k12-accent);
  stroke-width: 1.6;
}

.node__text {
  font-size: var(--k12-fs-xs);
  fill: var(--k12-fg);
  pointer-events: none;
}
</style>
