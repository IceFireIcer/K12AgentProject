<script setup lang="ts">
/**
 * 标准卡片的**卡身**（优化报告 §2.3 的标准结构第二段）。
 *
 * 卡身是唯一必需的一段：实际内容（题干 / 讲解 / 列表……）。
 * 类名直通 `base.css` 的 `.k12-card-body`（16px 内边距），组件本身不重写样式。
 */
</script>

<template>
  <div class="k12-card-body" data-testid="card-body">
    <slot />
  </div>
</template>
