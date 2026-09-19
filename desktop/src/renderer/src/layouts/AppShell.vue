<script setup lang="ts">
/**
 * 应用外壳：侧栏 + 顶栏 + 内容区。**只做布局**，不知道有哪些页面。
 *
 * 材质：外壳是**桌面**（`--k12-page` 带学段色）—— 侧栏、顶栏、页面底都在这一层，
 * 它退到背景；内容区的卡片是**纸面**（`--k12-surface` 恒为白）压在桌面上。
 * 明暗对比是这个界面建立层次的主要手段（见 `assets/base.css` 的材质模型）。
 *
 * 尺寸策略：**真响应式断点**，不做整体等比缩放。
 *   - ≥1440：外壳铺满，阅读栏弹性；
 *   - 1280–1439：右栏可折叠（在对话页内）；
 *   - <1280：侧栏收成图标条、对话右栏改浮层；
 *   - <1120：出横向滚动（`#app { min-width }`，见 base.css）。
 *
 * 为什么废掉等比缩放：老做法在窗口窄于 1440 时对**整个界面**做 transform: scale(w/1440)，
 * 连字号一起压 —— 1100px 窗口下正文只有 ~9.5px，1px 描边也糊掉。
 *
 * ★ 页面**不在这里**（App.vue 决定渲染哪一个）：外壳只管「怎么摆」，
 *   不知道「摆什么」，这样它才能同时服务单页与将来的多窗口。
 *   但**滚动容器在这里** —— 换页归零必须挂在同一个容器上，否则从「依赖图谱」
 *   切到「设置」会停在上一页的滚动位置，看起来像页面没加载完。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppSidebar from '../components/AppSidebar.vue'
import AppTopbar from '../components/AppTopbar.vue'
import WindowControls from '../components/WindowControls.vue'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()

/**
 * 滚动状态标记。
 *
 * `PageActions` 吸顶时需要知道「内容是否已滚过它」，才能决定要不要补那条分隔线 ——
 * 纯 CSS 无法表达「sticky 是否已吸住」。所以在**滚动容器**（`.shell__content`）
 * 上挂一个 `is-scrolled`，由它自己判断，而不是让每个使用页各写一份监听。
 *
 * 阈值 1px：只要离开原位就算滚过（0 → 1 的那一下正是分隔线该出现的时候）。
 */
const contentRef = ref<HTMLElement | null>(null)
const scrolled = ref(false)

function onScroll(): void {
  scrolled.value = (contentRef.value?.scrollTop ?? 0) > 1
}

/** 换页归零（见文件头：滚的是内层容器，路由/浏览器的滚动恢复管不到它）。 */
function resetScroll(): void {
  const el = contentRef.value
  if (!el) return
  el.scrollTop = 0
  scrolled.value = false
}

watch(
  () => ui.page,
  () => void resetScroll()
)

onMounted(() => contentRef.value?.addEventListener('scroll', onScroll, { passive: true }))
onBeforeUnmount(() => contentRef.value?.removeEventListener('scroll', onScroll))

/** 供页面内调用（例如「回到顶部」这类动作）。 */
defineExpose({ scrollToTop: resetScroll })
</script>

<template>
  <div class="shell">
    <AppSidebar />
    <div class="shell__main">
      <div class="shell__head">
        <AppTopbar />
        <!-- 外壳级动作（三步循环按钮由 App.vue 从外部塞进来；窗口按钮固定在最右端） -->
        <div class="shell__actions">
          <slot name="actions" />
          <WindowControls />
        </div>
      </div>

      <!-- `is-scrolled` 供 PageActions 吸顶时补分隔线（纯 CSS 判断不了是否已吸住） -->
      <main ref="contentRef" class="shell__content" :class="{ 'is-scrolled': scrolled }">
        <slot />
      </main>
    </div>

    <!-- 悬浮追问窗：挂在外壳上（而不是某张卡里），这样它在换页时不会被卸载，
         位置与对话记录得以延续。Teleport 到 body，不受 shell 的 overflow 裁切。 -->
    <slot name="overlay" />
  </div>
</template>

<style scoped>
/* 外壳 = **桌面**层（带学段色的页面底色）。
 *
 * ⚠️ 这里**不能**写死白底 —— 那会让页面底色消失，白卡片压在白底上就分不出边界。
 * 设计正是「带色的桌面 + 白纸」，这一层是全站层次的地基。
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

/* 顶栏那一行：AppTopbar 占满，右侧留给外壳级动作 + 窗口按钮。
 *
 * ★★ 这一行是**窗口拖拽区**（窗口是 `frame: false`，没有系统标题栏可拖）。
 *   所以：
 *     - 这里必须有 `-webkit-app-region: drag`（拖空白处即可移动窗口）；
 *     - 里面**每一个可交互元素**都必须 `no-drag`，否则点它会被当成拖窗口 ——
 *       表现成「按钮点不动」。已经标注的：`.cycle`（本文件）、`AppTopbar` 的模型 chip、
 *       `GradeIndicator` 的触发键与选项、`WindowControls` 整块。
 *   新增顶栏控件时**别忘了这一条**（漏了不会报错，只是点不动）。
 * ★ 高度由 `--k12-h-topbar` 定死（64px）：侧栏的品牌块用的是同一个令牌，
 *   两者的横向接缝才对得上（侧栏那一侧见 `AppSidebar.vue` 的 `min-height`）。 */
.shell__head {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 0;
  min-width: 0;
  height: var(--k12-h-topbar);
  -webkit-app-region: drag;
}
.shell__head > :first-child {
  flex: 1;
  min-width: 0;
}
.shell__actions {
  display: flex;
  align-items: stretch;
  gap: 8px;
  flex: none;
  /* 右侧不留 padding-right：`WindowControls` 的三个键各自 44px 宽、贴到窗口右上角
   * （Windows 原生就是贴边的）。留白会让「关闭」离屏幕角差一截，看着像浮在中间。 */
  background: var(--k12-surface);
  border-bottom: 1px solid var(--k12-border);
  -webkit-app-region: no-drag;
}

.shell__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* 内容区透出桌面底色：纸面卡片浮在它上面 */
  background: var(--k12-page);
}

/* 换页：瞬时切换，无过渡。
 * 这是有意的 —— 设计和内容要能靠静态层次站住，动效不做掩护。 */
</style>
