<script setup lang="ts">
/**
 * 标准卡片的**卡脚**（优化报告 §2.3 的标准结构第三段）。
 *
 * 判据（版式契约 §7）：卡脚只承载**状态提交**类动作 —— 保存 / 提交 / 运行 /
 * 上一题 / 下一题。页面级动作（导出、刷新）不许收进卡脚。
 * 类名直通 `base.css` 的 `.k12-card-foot`（上边框 + 底色 + 底部圆角）。
 */
</script>

<template>
  <footer class="k12-card-foot" data-testid="card-footer">
    <slot />
  </footer>
</template>
