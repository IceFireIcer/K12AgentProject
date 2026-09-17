<script setup lang="ts">
/**
 * 玻璃卡片：设计稿的通用玻璃表面。
 * depth 对应画布上的三档表面：main(glass) / sub(glass-2) / hi(glass-hi)。
 */
withDefaults(
  defineProps<{
    depth?: 'main' | 'sub' | 'hi'
    /** 是否使用 14px 大圆角（卡片）或 13px（紧凑卡） */
    radius?: 'sm' | 'md' | 'lg' | 'xl'
    padding?: string
    /** 去掉内边距（表格/舞台类内容自己控制） */
    flush?: boolean
  }>(),
  { depth: 'main', radius: 'xl', padding: '14px', flush: false }
)
</script>

<template>
  <div
    class="k12-card"
    :class="[`k12-card--${depth}`, `k12-card--r-${radius}`, { 'k12-card--flush': flush }]"
    :style="flush ? undefined : { padding }"
  >
    <slot />
  </div>
</template>

<style scoped>
.k12-card {
  position: relative;
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
  min-width: 0;
}
.k12-card--sub {
  background: var(--k12-glass-2);
}
.k12-card--hi {
  background: var(--k12-glass-hi);
}
.k12-card--r-sm {
  border-radius: var(--k12-r-md);
}
.k12-card--r-md {
  border-radius: var(--k12-r-xl);
}
.k12-card--r-lg {
  border-radius: var(--k12-r-3xl);
}
.k12-card--r-xl {
  border-radius: var(--k12-r-4xl);
}
.k12-card--flush {
  overflow: hidden;
}
</style>
