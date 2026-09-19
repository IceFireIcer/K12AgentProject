<script setup lang="ts">
/**
 * 页面操作栏：放在内容区顶部的一行工具。
 *
 * **不重复页面标题** —— 顶栏已经从路由 meta 取了标题，页内再写一遍是重复。
 * 这里只承载两件事：
 *   左侧 `info` 槽：这一页特有的说明 / 统计（可选）
 *   右侧默认槽：操作按钮
 *
 * 为什么需要它：审计发现多页（Profile / Settings / Coding / Quiz）要么完全没有
 * 页面级操作，要么把操作藏进某个卡片头里（比如动画页的「重新生成」）。
 * 使用者找不到"这一页能做什么"。统一到这一条栏之后，
 * **每一页的操作都在同一个位置**，肌肉记忆才成立。
 *
 * ── 吸顶（长页面）──────────────────────────────────────────────────────
 * 学习档案 / 依赖图谱这类页面滚动很远，滚到中段时这一栏就看不见了 ——
 * 而「导出报告」「重建索引」正是**看完内容之后**才想按的。所以它要吸顶。
 *
 * 实现要点：吸顶元素的定位基准是**最近的滚动祖先**（`.shell__content`），
 * 所以它必须盖住自己被"让出来"的顶部内边距，否则内容会从它上面透出来。
 * 那个内边距各页不同（内容页 18/22，规格页 16/20），于是用两个自定义属性收口，
 * 各页按需覆盖，**不在组件里写死某一页的数值**：
 *
 *   .pa { --pa-pad-y: 16px; --pa-pad-x: 20px; }   ← 规格页这样覆盖
 *
 * 底色用 `--k12-page`（而非透明）：它吸顶时是从页面底色里"浮出来"的一条，
 * 与卡片区分开，且滚动时不会让下面的内容透上来。
 */
</script>

<template>
  <header class="pa">
    <div class="pa__info">
      <slot name="info" />
    </div>
    <div class="pa__actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.pa {
  /* 吸顶：
   *  `position: sticky` 的定位基准是**最近的滚动祖先**（`.shell__content`），
   *  而各页根容器有各自的内边距（内容页 18/22，规格页 16/20）。
   *  负外边距把这一条拉回内容区边缘，自己的 padding 再把内容推回去 ——
   *  于是"吸住"时它是一条贴边的横条，不回退时它又落在原来的位置上。
   *  ⚠️ 数值由使用页覆盖（`--pa-pad-y` / `--pa-pad-x`），**不要在这里写死某一页的值**。 */
  --pa-pad-y: 18px;
  --pa-pad-x: 22px;

  display: flex;
  align-items: center;
  gap: 12px;

  position: sticky;
  top: 0;
  z-index: 5;
  /* 下留 0：与下方卡片的间距交给页面自己的 gap，避免 gap + margin 叠成双倍缝 */
  margin: calc(var(--pa-pad-y) * -1) calc(var(--pa-pad-x) * -1) 0;
  padding: 12px var(--pa-pad-x);
  /* 用页面底色而不是透明：滚动内容会从它下面经过，必须被挡住 */
  background: var(--k12-page);
  border-bottom: 1px solid transparent;
}
/* ⚠️ 「真正吸住时补分隔线」那条规则**不在这里** —— 见 base.css 的
 * `.shell__content.is-scrolled .pa`。
 *
 * 为什么不能写在这：本组件是 scoped，而规则要同时命中**父级**（`.shell__content`，
 * 在 AppShell 里）与自己（`.pa`）。写成 `:global(.shell__content.is-scrolled) .pa`
 * 会被 Vue 的 SFC 编译器产出成 `.shell__content.is-scrolled{...}` ——
 * **`.pa` 整个被丢掉**，规则在编译期就失效（实测编译产物确认）。
 * 放在 base.css 里则是普通全局选择器，没有这层编译歧义。 */
.pa__info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--k12-fs-sm);
  color: var(--k12-muted);
  overflow: hidden;
}
.pa__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
/* 槽里没内容时不占位（免得空出一个 12px 的缝） */
.pa__info:empty,
.pa__actions:empty {
  display: none;
}
</style>
