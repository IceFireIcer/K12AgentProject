<script setup lang="ts">
/**
 * 应用外壳：桌面 + 侧栏 + 顶栏 + 内容区。纯结构，不含尺寸逻辑。
 *
 * 材质：外壳是**深色壳**（`--k12-surface`）—— 侧栏、顶栏、页面底都在这一层，
 * 它退到背景；内容区是**亮面**（`--k12-surface` 系列），页面把内容摆上去。
 * 明暗对比是这个界面建立层次的主要手段：壳暗、内容亮，结构自然后退。
 *
 * 尺寸策略：**真响应式断点**，不做整体等比缩放。
 *   - ≥1440：外壳铺满，阅读栏弹性；
 *   - 1280–1439：右栏可折叠（在 ChatView 内）；
 *   - <1280：侧栏收成 64px 图标条、对话右栏改浮层；
 *   - <1120：出横向滚动（`#app { min-width }`，见 base.css）。
 *
 * 为什么废掉等比缩放：老做法在窗口窄于 1440 时对**整个界面**做 transform: scale(w/1440)，
 * 连字号一起压 —— 1100px 窗口下正文只有 ~9.5px，1px 描边也糊掉。
 */
import AppSidebar from '@/components/AppSidebar.vue'
import AppTopbar from '@/components/AppTopbar.vue'
import FloatPanel from '@/components/FloatPanel.vue'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 滚动状态标记。
 *
 * `PageActions` 吸顶时需要知道「内容是否已滚过它」，才能决定要不要补那条分隔线 ——
 * 纯 CSS 无法表达"sticky 是否已吸住"。所以在**滚动容器**（`.shell__content`）
 * 上挂一个 `is-scrolled`，由它自己判断，而不是让每个使用页各写一份监听。
 *
 * 阈值 1px：只要离开原位就算滚过（0 → 1 的那一下正是分隔线该出现的时候）。
 */
const contentRef = ref<HTMLElement | null>(null)
const scrolled = ref(false)

function onScroll() {
  scrolled.value = (contentRef.value?.scrollTop ?? 0) > 1
}

/**
 * 换页归零。
 *
 * `router` 的 `scrollBehavior` 管的是 window 滚动，而这里滚的是**内层容器**
 * （`.shell__content`），所以必须在换页时显式归零 —— 否则从"依赖图谱"切到"设置"
 * 会停在上一页的滚动位置，看起来像是页面没加载完。
 */
const route = useRoute()
function resetScroll() {
  const el = contentRef.value
  if (!el) return
  el.scrollTop = 0
  scrolled.value = false
}

watch(() => route.fullPath, () => void resetScroll())

onMounted(() => contentRef.value?.addEventListener('scroll', onScroll, { passive: true }))
onBeforeUnmount(() => contentRef.value?.removeEventListener('scroll', onScroll))
</script>

<template>
  <div class="shell">
    <AppSidebar />
    <div class="shell__main">
      <AppTopbar />
      <!-- `is-scrolled` 供 PageActions 吸顶时补分隔线（纯 CSS 判断不了是否已吸住） -->
      <main ref="contentRef" class="shell__content" :class="{ 'is-scrolled': scrolled }">
        <RouterView />
      </main>
    </div>

    <!-- 悬浮追问窗：挂在外壳上（而不是某张卡里），这样它在换页时不会被卸载，
         位置与对话记录得以延续。Teleport 到 body，不受 shell 的 overflow 裁切。 -->
    <FloatPanel />
  </div>
</template>

<style scoped>
/* 外壳 = **页面底色**层（画布原 bg，带学段色）。
 *
 * ⚠️ 这里**不能**写死白底 —— 那会让页面底色消失，白卡片压在白底上就分不出边界。
 * 画布的设计正是"带色的页面 + 白卡片"，这一层是全站层次的地基。
 * 侧栏与顶栏自带自己的底色（见各自组件），不依赖这里。 */
.shell {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  display: flex;
  background: var(--k12-page);
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
  /* 内容区透出页面底色：卡片浮在它上面 */
  background: var(--k12-page);
}

/* 换页：瞬时切换，无过渡。
 * 这是有意的 —— 设计和内容要能靠静态层次站住，动效不做掩护。 */
</style>
