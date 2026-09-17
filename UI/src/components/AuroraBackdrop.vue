<script setup lang="ts">
/**
 * 极光背景：设计稿每屏 Backdrop 的 3 个径向渐变 Blob。
 * 颜色走 --k12-wash-1/2 与 --k12-glow，随学段主题自动变化。
 */
interface Blob {
  /** 直径，px（设计稿为 520–700） */
  size: number
  x: string
  y: string
  tone: 'wash-1' | 'wash-2' | 'glow'
  opacity?: number
}

withDefaults(defineProps<{ blobs?: Blob[] }>(), {
  blobs: () => [
    { size: 620, x: '-6%', y: '-18%', tone: 'wash-1', opacity: 0.85 },
    { size: 700, x: '58%', y: '-24%', tone: 'wash-2', opacity: 0.7 },
    { size: 520, x: '22%', y: '52%', tone: 'glow', opacity: 0.5 }
  ]
})
</script>

<template>
  <div class="k12-aurora" aria-hidden="true">
    <span
      v-for="(b, i) in blobs"
      :key="i"
      class="k12-aurora__blob"
      :style="{
        width: `${b.size}px`,
        height: `${b.size}px`,
        left: b.x,
        top: b.y,
        opacity: b.opacity,
        background: `radial-gradient(circle at center, var(--k12-${b.tone}) 0%, transparent 72%)`
      }"
    />
  </div>
</template>
