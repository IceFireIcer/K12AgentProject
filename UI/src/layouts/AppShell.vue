<script setup lang="ts">
/**
 * 应用外壳：极光背景 + 玻璃侧栏 + 顶栏 + 内容区。
 *
 * 尺寸策略（用户决策）：**弹性 + 整体等比缩放**，两者各管一段，不要用其中一个顶替另一个：
 *  - 宽度 **≥ DESIGN_WIDTH(1440)**：scale 恒为 1，外壳宽度 `100%` —— **内容自然铺满宽屏**。
 *    （若把外壳宽度硬写成 1440px，1920 窗口右侧会留下 480px 空白。）
 *  - 宽度 **< 1440**：外壳仍固定 1440px，用 `transform: scale(w/1440)` 整体等比缩小，
 *    避免侧栏被压扁、阅读栏被挤窄，设计比例得以保留。
 *
 * 缩放用 ResizeObserver 观测容器实际宽度，不监听 window.resize（避免 DPI 抖动）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AuroraBackdrop from '@/components/AuroraBackdrop.vue'
import AppSidebar from '@/components/AppSidebar.vue'
import AppTopbar from '@/components/AppTopbar.vue'

/** 设计基准宽度（画布都是 1440×900） */
const DESIGN_WIDTH = 1440

const hostRef = ref<HTMLElement | null>(null)
const hostWidth = ref(DESIGN_WIDTH)

let ro: ResizeObserver | null = null

onMounted(() => {
  if (!hostRef.value) return
  ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width
    if (typeof w === 'number' && w > 0) hostWidth.value = w
  })
  ro.observe(hostRef.value)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

/** 只在窄于设计基准时才缩放，避免宽屏下多余放大 */
const scale = computed(() => Math.min(1, hostWidth.value / DESIGN_WIDTH))

const stageStyle = computed(() => {
  // 宽屏：不缩放、宽度铺满，交给弹性布局
  if (scale.value === 1) {
    return { width: '100%', height: '100%' }
  }
  // 窄屏：固定设计宽度 + 等比缩小；高度按比例反算，避免底部留白
  return {
    transform: `scale(${scale.value})`,
    transformOrigin: 'top left',
    width: `${DESIGN_WIDTH}px`,
    height: `calc(100% / ${scale.value})`
  }
})
</script>

<template>
  <div ref="hostRef" class="shell">
    <AuroraBackdrop />

    <div class="shell__stage" :style="stageStyle">
      <AppSidebar />
      <div class="shell__main">
        <AppTopbar />
        <main class="shell__content">
          <RouterView v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </RouterView>
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--k12-bg);
}
.shell__stage {
  position: relative;
  z-index: 1;
  display: flex;
  /* 缩放时高度按比例反算，保证填满视口 */
  min-height: 100%;
}
.shell__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.shell__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.16s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
