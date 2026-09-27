<script setup lang="ts">
/**
 * 应用外壳：侧栏 + 顶栏 + 内容区。**只做布局**，不知道有哪些页面。
 *
 * 材质：外壳是**桌面**（`--k12-page` 带学段色）—— 侧栏、顶栏、页面底都在这一层，
 * 它退到背景；内容区的卡片是**纸面**（`--k12-surface` 恒为白）压在桌面上。
 * 明暗对比是这个界面建立层次的主要手段（见 `assets/base.css` 的材质模型）。
 *
 * 外壳的边界由三者**共同**承担：桌面底色（主）+ 顶栏下线 `--k12-border-strong`（副）
 * + 单侧投影 `--k12-shadow-edge-bottom`（副）。只有底色差、没有线时，
 * 白纸顶栏压在白纸内容区的起点上就分不出缝（这正是「顶栏边界不明显」的成因）。
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
    <!-- 键盘用户的第一个 Tab 落点：跳过侧栏与顶栏，直接进内容区（优化报告 §3.1）。
         ★ 平时 sr-only（读屏可读、视觉隐藏），**聚焦时可见** —— 否则键盘用户
           看不到自己 Tab 到了哪儿。目标容器同时带 `tabindex="-1"`，
           这样 href 锚点跳转后焦点真的落进去（否则只是滚动，焦点还在链接上）。 -->
    <a class="skip-link" href="#k12-content">跳到主内容</a>
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
      <main
        id="k12-content"
        ref="contentRef"
        class="shell__content"
        :class="{ 'is-scrolled': scrolled }"
        tabindex="-1"
      >
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

/* 「跳到主内容」：整页 Tab 顺序的第 0 站。
 * ★ 平时视觉隐藏但**可聚焦**（用 clip-path 而不是 display:none —— 后者键盘也够不到，
 *   与 `.sr-only` 同一条理由）；聚焦时显形，浮在最上层。 */
.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 60;
  padding: 8px 14px;
  border: 1px solid var(--k12-accent-ink);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  clip-path: inset(50%);
}
.skip-link:focus-visible {
  clip-path: none;
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
 *       `GradeIndicator` 的**合并 chip**（值 + 「我选年级」那一枚，2026-09-22 起
 *       状态与动作合成一枚）与它的选项、`WindowControls` 整块。
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
  /* ★ 单侧投影挂在**这一行**上：顶栏与右侧动作条共用同一条下边线，而动作条那一段
   *   自己没有投影 —— 不在这里画一遍，边界就只覆盖左边一半，接缝处会断开。
   *   ⚠️ 它要能画在内容区之上，靠的是下面这两条定位与层级：投影（外阴影）与背景
   *   同属一个绘制阶段，而 `.shell__content` 在文档流里排在它后面、又是不透明的
   *   桌面色 —— 不给层级，这 3px 的投影会被整条盖掉（实测确认）。 */
  box-shadow: var(--k12-shadow-edge-bottom);
  position: relative;
  z-index: 1;
  -webkit-app-region: drag;
}
.shell__head > :first-child {
  flex: 1;
  min-width: 0;
}
.shell__actions {
  display: flex;
  align-items: stretch;
  /* ★ 12px（原 8px）：把**外壳级跳转**（`.cycle`）与窗口按钮分开。
   * 两者都是「点一下换个地方」，但一个是应用内的导航、一个是窗口 chrome ——
   * 贴在一起会读成同一组（报告 1.1 的「业务区顶到窗控正下方」）。
   * 间距只在这一处给：窗控自己不许留白，否则「关闭」会离屏幕角差一截。 */
  gap: 12px;
  flex: none;
  /* 右侧不留 padding-right：`WindowControls` 的三个键各自 44px 宽、贴到窗口右上角
   * （Windows 原生就是贴边的）。留白会让「关闭」离屏幕角差一截，看着像浮在中间。 */
  background: var(--k12-surface);
  /* chrome 与内容的分隔用**结构分面线**（strong 档）：外壳这一行是整块结构的分面，
   * 它与左侧顶栏共用同一条下边线 —— 两边只有**同档**时才读成一条线（见 AppTopbar）。 */
  border-bottom: 1px solid var(--k12-border-strong);
  -webkit-app-region: no-drag;
}

.shell__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* 内容区透出桌面底色：纸面卡片浮在它上面 */
  background: var(--k12-page);
  /* ★ 桌面从「纸的起点」往下略沉一点点：桌面是整块的一层，越往下越退，
   *   读者才会觉得内容浮在**桌面上**，而不是贴在同一个平面上。
   *   ⚠️ 加成 background-image（而不是改 background-color）：吸顶的 `PageActions`
   *   与设置页的色板预览都直接读 `--k12-page`，底色一旦被换掉，那两处就跟着变。 */
  background-image: linear-gradient(
    180deg,
    transparent 0%,
    color-mix(in srgb, var(--k12-fg) 3%, transparent) 100%
  );
}

/* 换页：瞬时切换，无过渡。
 * 这是有意的 —— 设计和内容要能靠静态层次站住，动效不做掩护。 */
</style>
