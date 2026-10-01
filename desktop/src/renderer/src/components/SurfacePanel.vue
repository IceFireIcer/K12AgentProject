<script setup lang="ts">
/**
 * 表面面板：全应用唯一的"一块内容"容器。
 *
 * 四层，每层只表达一件事（见 base.css 的层次系统）：
 *   page   页面底色（画布原 bg，带学段色）—— 由外层页面铺，不在这里
 *   card   白卡片 + 可见边框 + 浅投影     —— **默认**，绝大多数内容都用它
 *   inset  卡片内的嵌入块（带学段浅色底）  —— 卡中卡时用它
 *   float  浮层（更强投影）               —— 对话框 / 菜单 / 悬浮窗
 *
 * ⚠️ **不要 card 套 card**：白面叠白面看不出层次。卡中卡一律用 `inset` ——
 *    它有学段浅底，压在白面上自然分得开。上一版 16 处手写卡片、
 *    10 种表面配方混用，就是这个问题的来源。
 *
 * `plain` 是给"只作分组、不参与层次"的容器用的（无底色无边框）。
 */
import { ref, toRef } from 'vue'
import type { SurfacePadding, SurfaceRadius, SurfaceTone } from '../types/component-props'
import { useCardShine } from '../composables/useCardShine'

const props = withDefaults(
  defineProps<{
    tone?: SurfaceTone
    /** 圆角（语义档：inset / card / control —— 见 base.css 的 r-* 映射）。 */
    radius?: SurfaceRadius
    /**
     * 内边距（报告 §4.2：**枚举四选一**，不再是任意字符串）。
     *
     * 档位与设计 token 一一对应：none = 0 / sm = sp-3(12) / md = sp-4(16) / lg = sp-5(24)。
     * ★ 为什么收成枚举：旧版允许 `padding="14px 16px"` 这类任意值，
     *   几十个调用点各写一套内边距，卡片与卡片之间的呼吸感就不一样了 ——
     *   这正是报告说的「缺少 TypeScript 约束」的后果。
     */
    padding?: SurfacePadding
    /** 去掉内边距（卡头/卡身/卡脚自己控制间距的内容用它） */
    flush?: boolean
    /**
     * 卡片玻璃边缘光效（2026-09-30 设计执行报告 §4.3）。
     *
     * ★★ 为什么是 **opt-in 而不是默认开**：光效靠每个实例自己的指针监听算位移
     *   （`useCardShine`），监听器**按卡片计**。虚拟列表 / 卡片密集的页面里默认开，
     *   就等于把监听数量交给"这一屏碰巧渲染了几张卡"决定 —— 那是性能问题，
     *   不是视觉效果问题。所以由接入方显式点名（一期只给静态的内容页卡片开）。
     * ★ 关掉时视觉与改造前**逐像素一致**：`.k12-shine` 的两个叠加层 opacity 从 0 起步
     *   （红线 1，见报告 §5）。
     */
    shine?: boolean
  }>(),
  { tone: 'card', radius: 'card', padding: 'md', flush: false, shine: false }
)

/** 内边距枚举 → 设计 token（唯一映射表，模板不写第二份）。 */
const PADDING_TOKENS: Record<SurfacePadding, string> = {
  none: '0',
  sm: 'var(--k12-sp-3)',
  md: 'var(--k12-sp-4)',
  lg: 'var(--k12-sp-5)'
}

/**
 * 光效的宿主元素。
 *
 * ★ 这里必须真的把 ref 交给 composable：光效**不读全局指针位置**，它只在自己这张卡上
 *   监听 `pointerenter` / `pointermove` / `pointerleave` —— 没有宿主就没有"在哪张卡上"。
 */
const rootRef = ref<HTMLElement | null>(null)

/**
 * 光效接线（`useCardShine` 内部自己处理三件事，本组件不重复判断）：
 *   · 减动效（`useReducedMotion` 有效值）开启时**根本不挂监听**；
 *   · 指针媒体查询（触屏 / 无精确指针）不出效果；
 *   · enable 为 false 时同样不挂 —— 这就是 `shine` prop 的落点。
 * ★ 传 `toRef(props, 'shine')` 而不是先读一次布尔值：接入方在运行时改 `shine`
 *   （条件渲染 / 热更新）时，composable 要能当场挂上或摘下监听。
 */
useCardShine(rootRef, toRef(props, 'shine'))
</script>

<template>
  <div
    ref="rootRef"
    class="sf"
    :class="[`sf--${tone}`, `sf--r-${radius}`, { 'sf--flush': flush, 'k12-shine': shine }]"
    :style="flush || padding === 'none' ? undefined : { padding: PADDING_TOKENS[padding] }"
  >
    <slot name="head" />
    <slot />
    <slot name="foot" />
  </div>
</template>

<style scoped>
.sf {
  position: relative;
  min-width: 0;
}
/* E2 卡片：默认形态 */
.sf--card {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
}
/* E3 嵌入块：卡中卡用它。有学段浅底，压在白面上分得开。
 * ★ 那条线**与 base.css 的 `.k12-inset` 同值**（逐字一致），两处必须一起改：
 *   页面底色也带学段色时，「浅底压浅底」分不开，一条 70% 的线才是
 *   「这里是一个独立的块」的边界信号（D-105）。 */
.sf--inset {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
}
/* E4 浮层 */
.sf--float {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-float);
}
/* 无底色、无边框：只作分组用，不参与层次 */
.sf--plain {
  background: transparent;
}
/* 三个圆角档各把**基础半径**告诉光效层（只加变量，既有 border-radius 一字不动）：
 * `.k12-shine` 的圆角公式是 calc(--k12-shine-r 或卡片档 + 该角内凹量)，
 * 不告诉它这一档实际是多少，inset / control 的卡就会按卡片档(12px)去算内凹 ——
 * 一凹就跳变。 */
.sf--r-inset {
  border-radius: var(--k12-r-inset);
  --k12-shine-r: var(--k12-r-inset);
}
.sf--r-card {
  border-radius: var(--k12-r-card);
  --k12-shine-r: var(--k12-r-card);
}
.sf--r-control {
  border-radius: var(--k12-r-control);
  --k12-shine-r: var(--k12-r-control);
}

/* ★★ 光效开启时，圆角必须**让给** base.css 的 `.k12-shine` 公式。
 *
 * 为什么非有这一段不可（实测推演，别删）：本组件是 **scoped 样式**，上面三条
 * 选择器编译后带 data-v 属性（特异度 0,2,0），而 base.css 的 `.k12-shine` 是
 * 单类（0,1,0）—— 特异度更高的那一条永远赢，于是光效里
 * `calc(基础档 + 该角内凹量)` 永远被盖住，**四角一下都不会凹**。
 * ⚠️ 这个缺陷很隐蔽：边缘高光（`::before` 的 opacity）照常亮，肉眼看"光效是好的"，
 *    只有"贴角内凹"那半个效果是死的 —— 所以验收时专门盯四角。
 *
 * 为什么是**新增**一条而不是改上面三条：那三条是既有皮肤配方（红线 1：声明一字不改）。
 * 这里只把 base.css 的同一条公式在更高特异度上放行一次：
 * `--k12-shine-r` 仍只由上面三条给（基础档唯一来源），本段不新增任何 --k12-shine-* 定义。
 * ⚠️ 公式与 base.css 的 `.k12-shine` **逐字同源**：那边改了（S2），这段必须同步。 */
.sf--r-inset.k12-shine,
.sf--r-card.k12-shine,
.sf--r-control.k12-shine {
  border-radius:
    calc(var(--k12-shine-r, var(--k12-r-card)) + var(--k12-dent-tl, 0px))
    calc(var(--k12-shine-r, var(--k12-r-card)) + var(--k12-dent-tr, 0px))
    calc(var(--k12-shine-r, var(--k12-r-card)) + var(--k12-dent-br, 0px))
    calc(var(--k12-shine-r, var(--k12-r-card)) + var(--k12-dent-bl, 0px));
}
.sf--flush {
  overflow: hidden;
}
</style>
