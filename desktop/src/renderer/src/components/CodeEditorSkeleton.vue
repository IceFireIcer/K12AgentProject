<script setup lang="ts">
/**
 * 代码编辑器的加载骨架（优化报告 §5.1 的 `CodeEditorSkeleton`）。
 *
 * ── 它在两个位置被用 ────────────────────────────────────────────────────
 *   ① 异步组件的 `loadingComponent`（`defineAsyncComponent` 的骨架）；
 *   ② 编辑器宿主的覆盖层：Monaco 的 chunk 有 2 MB 级，**组件 import 完 ≠ 编辑器可用**，
 *      真正在等的是 `createCodeEditor()`。两层用同一个骨架，学生眼里只有一种等待。
 *
 * ★ 与 `Skeleton.vue`（通用列表骨架）的分工：那一份是灰条；这一份是**代码形**
 *   （等宽的深色行 + 「正在准备代码编辑器…」），因为编辑器一出现就是深色 ——
 *   用灰白骨架会把「马上要出现的是一块黑色区域」这件事说错。
 * ★ `aria-hidden` 只给灰条；那句「正在准备」是可读的状态文案（读屏用户要知道在等什么）。
 */
withDefaults(defineProps<{ lines?: number }>(), { lines: 6 })
</script>

<template>
  <div class="ces" data-testid="code-editor-skeleton">
    <p class="ces__note" role="status">正在准备代码编辑器…</p>
    <div class="ces__body" aria-hidden="true">
      <span
        v-for="index in lines"
        :key="index"
        class="ces__row"
        :style="{ width: `${100 - (index % 4) * 9}%` }"
      />
    </div>
  </div>
</template>

<style scoped>
/* 底色与编辑器同值（`--k12-editor-bg` = Monaco vs-dark 的背景）——骨架不该在深色编辑器
 * 加载完成时"跳"一下颜色。 */
.ces {
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-3);
  padding: var(--k12-sp-4);
  min-height: 100%;
  background: var(--k12-editor-bg);
}
.ces__note {
  font-size: var(--k12-fs-caption);
  /* 深色底上的文字色：直接用高对比的浅色（编辑器内没有 k12 的语义色可用） */
  color: #d4d4d4;
}
.ces__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ces__row {
  height: 12px;
  border-radius: var(--k12-r-xs);
  background: #3a3a3a;
}
/* 闪烁是减动效下必须关掉的装饰（同 Skeleton.vue 的口径） */
@media (prefers-reduced-motion: no-preference) {
  .ces__row {
    animation: ces-breathe 1.4s var(--k12-ease-state) infinite;
  }
}
@keyframes ces-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
</style>
