<script setup lang="ts">
/**
 * 页面身份行 —— 每个内容页顶部的**唯一**标题落点。
 *
 * 它解决的问题（本轮返工的第一个根因）：内容区最大字号原本是 16px，
 * 而**顶栏 18px 的页面名（chrome）比内容还重**。于是整页看起来"外壳压着内容"，
 * 眼睛不知道该从哪里开始读。
 *
 * 现在分成两层，职责不重叠：
 *   顶栏（15px）  = 「你在哪一页」—— 导航属性，chrome，退后
 *   身份行（22px） = 「这一页在讲什么」—— 内容属性，置前
 *
 * ⚠️ `main` **不要重复顶栏的页面名**（那是同一句话说两遍）。
 *    写"这页的价值 / 它回答什么问题"，例如：
 *      依赖图谱 → 「一个知识点，卡在它的前置上就学不动」
 *      设置     → 「供应商与本地服务」
 *
 * `hint` 是主路径提示（D1）：说清「先做什么、再做什么」，学生不必靠试错找用法。
 *
 * 样式落在 base.css 的 `.k12-identity` / `.k12-path`（全局唯一取值），
 * 本组件只负责结构 —— 各页因此不可能把字号写成 18/20/22 三种。
 */
withDefaults(
  defineProps<{
    /** 这一页在讲什么（**不是**页面名的重复） */
    main: string
    /** 右侧补充：统计口径 / 数据来源 / 单位 */
    meta?: string
    /** 主路径提示：先做什么、再做什么 */
    hint?: string
  }>(),
  { meta: '', hint: '' }
)
</script>

<template>
  <header class="ph">
    <div class="k12-identity">
      <h2 class="k12-identity__main">{{ main }}</h2>
      <span v-if="meta" class="k12-identity__meta">{{ meta }}</span>
    </div>
    <p v-if="hint" class="k12-path">{{ hint }}</p>
  </header>
</template>

<style scoped>
.ph {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
</style>
