<script setup lang="ts">
/**
 * 学习地图的**渲染**（纯 SVG，自绘；布局在 `map/layout.ts` 里，是纯函数）。
 *
 * ★ 一个依赖都不引：见 `map/layout.ts` 的注释（零打包风险 + 演示可能断网）。
 * ★ 渲染层**不做任何几何计算**：所有坐标、路径、矩形都来自布局函数的输出
 *   （`nodeRect` / `edgePath`），这里只负责把数字放进 SVG 属性里。
 * ★ 已掌握 / 未掌握的区分只用**填充色与描边**（不靠颜色单独承载语义，
 *   文字上也能看出来：`data-mastered` 供断言与无障碍读取）。
 *
 * ---------------------------------------------------------------------------
 * ★★ 节点是**真的可点、键盘可达**的（走查结论：原来一个点击处理都没有）
 * ---------------------------------------------------------------------------
 * 一个学生看着这张图，最自然的动作就是「点一下某个知识点」—— 原来点了毫无反应
 * （图上没有任何提示说「这里不可点」，于是像坏了）。现在每个节点是一枚
 * `role="button"` + `tabindex="0"` 的元素：鼠标点击、Tab 聚焦、Enter / Space 都能选中。
 *
 * ★ 选中态**不只靠颜色**（本项目的明文规则）：被选中的节点外面多一圈**环**
 *   （`.node__ring`，尺寸与描边都变了），键盘聚焦时那圈环变成虚线 ——
 *   灰度打印或色觉差异下，「选中 / 聚焦」照样看得出来。
 * ★ 节点**不重排、不改画布尺寸**：环画在节点矩形外侧（半径 +4px 的余量），
 *   布局输出的 `x/y/width/height` 一个数都没动（守卫钉着 1610×1600 与 13px 字号）。
 */
import { computed } from 'vue'
import { edgePath, nodeLabel, nodeRect, type GraphLayout } from './layout'
import { edgeRect, visibleItems, type MapViewport } from './culling'

const props = defineProps<{
  layout: GraphLayout
  selected?: string
  /**
   * 当前视口（画布坐标；由 `MapTab.vue` 跟着滚动容器给）。
   *
   * ★ 给了就**只渲染可见节点 ±100px**（报告 §5.2 的视口裁剪）；不给 = 全量渲染
   *   （单测 / 旧调用点的行为一字不差）。
   * ★ 裁剪**不改任何几何**：被裁掉的是本来就在屏幕外的元素，
   *   留下那些的坐标、字号、层级全是布局输出的原值。
   */
  viewport?: MapViewport | null
}>()

const emit = defineEmits<{ select: [kpId: string] }>()

/** 画布为空时的占位尺寸（避免 `viewBox="0 0 0 0"` 这种非法值）。 */
const viewBox = computed(() =>
  props.layout.nodes.length > 0
    ? `0 0 ${props.layout.width} ${props.layout.height}`
    : '0 0 100 100'
)

/** 这一帧真正要渲染的节点（没有视口 = 全部；有视口 = 可见 ±100px）。 */
const visibleNodes = computed(() =>
  props.viewport ? visibleItems(props.layout.nodes, nodeRect, props.viewport) : props.layout.nodes
)

/** 这一帧真正要渲染的边（按包围盒与视口相交判定）。 */
const visibleEdges = computed(() =>
  props.viewport ? visibleItems(props.layout.edges, edgeRect, props.viewport) : props.layout.edges
)

/** 每个节点的矩形与选中环（预算一次，避免模板里反复调用）。 */
const rects = computed(() =>
  visibleNodes.value.map((node) => {
    const rect = nodeRect(node)
    return {
      node,
      rect,
      // 选中环：节点矩形外扩 4px。**不参与布局**（纯装饰，画在节点下层）
      ring: { x: rect.x - 4, y: rect.y - 4, width: rect.width + 8, height: rect.height + 8 },
      on: props.selected === node.kpId
    }
  })
)

/** 无障碍标签：知识点名 + 掌握状态（读屏用户听到的是这句话，不是一串坐标）。 */
function labelOf(node: { name: string; kpId: string; mastered: boolean }): string {
  return `${nodeLabel(node.name, node.kpId)}${node.mastered ? '，已掌握' : '，还没掌握'}`
}
</script>

<template>
  <svg
    class="map"
    :viewBox="viewBox"
    :width="layout.width || 100"
    :height="layout.height || 100"
    role="group"
    aria-label="知识点依赖图（可以用 Tab 逐个浏览、回车选中）"
    data-testid="study-map-svg"
  >
    <!-- 边：先画（在节点下层），直角折线 -->
    <g class="map__edges">
      <path
        v-for="edge in visibleEdges"
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
        v-for="{ node, rect, ring, on } in rects"
        :key="node.kpId"
        class="hit"
        :class="{ 'hit--on': on }"
        :data-testid="`map-node-${node.kpId}`"
        :data-mastered="node.mastered ? 'true' : 'false'"
        :data-layer="node.layer"
        :data-selected="on ? 'true' : 'false'"
        role="button"
        tabindex="0"
        :aria-pressed="on ? 'true' : 'false'"
        :aria-label="labelOf(node)"
        @click="emit('select', node.kpId)"
        @keydown.enter.prevent="emit('select', node.kpId)"
        @keydown.space.prevent="emit('select', node.kpId)"
      >
        <!-- 选中环（画在节点下层；键盘聚焦时变虚线 —— 形状本身承载「当前在哪」） -->
        <rect
          :x="ring.x"
          :y="ring.y"
          :width="ring.width"
          :height="ring.height"
          rx="13"
          class="ring"
          aria-hidden="true"
        />
        <rect
          :x="rect.x"
          :y="rect.y"
          :width="rect.width"
          :height="rect.height"
          rx="9"
          class="node"
          :class="{ 'node--mastered': node.mastered, 'node--on': on }"
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

/* 节点是一个可点、可聚焦的整体（`<g>` 而不是 `<rect>`：文字也是它的一部分） */
.hit {
  cursor: pointer;
}

/* 键盘聚焦：SVG 元素上 `:focus-visible` 在 Chromium 里可用；
 * 这里给的是**形状**变化（虚线环），不是又一个颜色。 */
.hit:focus-visible {
  outline: none;
}

.hit:focus-visible .ring {
  stroke: var(--k12-accent-ink);
  stroke-dasharray: 5 4;
  opacity: 1;
}

.ring {
  fill: none;
  stroke: var(--k12-accent);
  stroke-width: 2;
  opacity: 0;
}

.hit--on .ring {
  opacity: 1;
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

/* 选中：加粗描边（尺寸也变了，不只是颜色） */
.node--on {
  stroke: var(--k12-accent-ink);
  stroke-width: 2.6;
}

.node__text {
  font-size: var(--k12-fs-caption);
  fill: var(--k12-fg);
  pointer-events: none;
}

.hit--on .node__text {
  font-weight: 650;
}
</style>
