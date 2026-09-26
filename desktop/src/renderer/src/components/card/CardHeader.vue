<script setup lang="ts">
/**
 * 标准卡片的**卡头**（优化报告 §2.3 的标准结构第一段）。
 *
 * 槽位分工（与版式契约 §7 的"对象级操作进卡头"一致）：
 *   · `title`   这一块叫什么（h3 20px，来自 `.k12-card-head` 继承）；
 *   · `meta`    只读的次要信息（口径、来源、计数）；
 *   · `actions` **对象级**操作（展开/收起、排版开关、查看）—— 不要放页面级动作。
 *
 * ⚠️ 样式不在这里重写：类名直通 `base.css` 的 `.k12-card-head`（底色 + 下边框 +
 *    顶部圆角 + h3 字号）。抄一份就会漂移，这是报告 §2.3「卡片头尾规范不明」的落点。
 */
</script>

<template>
  <header class="k12-card-head" data-testid="card-header">
    <slot name="title" />
    <slot name="meta" />
    <div class="k12-card-head__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
/* 只有这一条是本组件的：把 actions 推到右端（其余全在 base.css 的 .k12-card-head）。 */
.k12-card-head__actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--k12-sp-2);
}
</style>
