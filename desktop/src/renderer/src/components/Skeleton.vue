<script setup lang="ts">
/**
 * 骨架屏（优化报告 §3.2 的 Loading 四形态之一）。
 *
 * ── 为什么需要它（与"转圈"的分工）─────────────────────────────────────────
 *   · 转圈（`.es` 的 loading 态）：**不知道内容长什么样**时用（首屏取数、按钮在途）；
 *   · 骨架屏：**知道内容结构**时用（列表、卡片）—— 它把"马上要出现几行、每行多高"
 *     先摆出来，页面不会在数据到达时整体跳一下（布局稳定性 CLS）。
 *
 * ★ 纪律：
 *   · 只用 k12 token（底色走 `--k12-surface-2`，圆角走 `--k12-r-inset`），不写死色值；
 *   · 闪烁是**唯一允许的循环动画**之一，且 `prefers-reduced-motion` 下必须关掉
 *     （减动效用户不该被闪烁打扰，静态灰块同样表达"正在加载"）；
 *   · `aria-hidden="true"`：它是视觉占位，读屏用户由外层的状态文案负责
 *     （不要让它念出一堆"空白行"）。
 */
import type { SkeletonVariant } from '../types/component-props'

withDefaults(
  defineProps<{
    /** 行数（列表用）。 */
    rows?: number
    /** 形态：文本块 / 列表行 / 卡片。 */
    variant?: SkeletonVariant
  }>(),
  { rows: 3, variant: 'row' }
)
</script>

<template>
  <div class="sk" :data-variant="variant" aria-hidden="true" data-testid="skeleton">
    <div v-for="index in rows" :key="index" class="sk__row">
      <span v-if="variant !== 'text'" class="sk__dot" />
      <span class="sk__bar" :style="{ width: `${100 - index * 6}%` }" />
    </div>
  </div>
</template>

<style scoped>
.sk {
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-3);
  padding: var(--k12-sp-2) 0;
}
.sk__row {
  display: flex;
  align-items: center;
  gap: var(--k12-sp-3);
}
.sk__dot {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.sk__bar {
  height: 14px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
}
[data-variant='card'] .sk__bar {
  height: 18px;
}
/* 闪烁：唯一允许的循环动画之一，且是**唯一**的动效来源（减动效下关掉）。 */
@media (prefers-reduced-motion: no-preference) {
  .sk__dot,
  .sk__bar {
    animation: sk-breathe 1.4s var(--k12-ease-state) infinite;
  }
}
@keyframes sk-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
</style>
