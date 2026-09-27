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
import type { SurfacePadding, SurfaceRadius, SurfaceTone } from '../types/component-props'

withDefaults(
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
  }>(),
  { tone: 'card', radius: 'card', padding: 'md', flush: false }
)

/** 内边距枚举 → 设计 token（唯一映射表，模板不写第二份）。 */
const PADDING_TOKENS: Record<SurfacePadding, string> = {
  none: '0',
  sm: 'var(--k12-sp-3)',
  md: 'var(--k12-sp-4)',
  lg: 'var(--k12-sp-5)'
}
</script>

<template>
  <div
    class="sf"
    :class="[`sf--${tone}`, `sf--r-${radius}`, { 'sf--flush': flush }]"
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
.sf--r-inset {
  border-radius: var(--k12-r-inset);
}
.sf--r-card {
  border-radius: var(--k12-r-card);
}
.sf--r-control {
  border-radius: var(--k12-r-control);
}
.sf--flush {
  overflow: hidden;
}
</style>
