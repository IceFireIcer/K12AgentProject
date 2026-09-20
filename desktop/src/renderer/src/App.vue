<script setup lang="ts">
/**
 * 应用根：把外壳、八个页面、全局浮层接在一起。
 *
 * 布局原则（执行文档 §11.1）：**对话优先** —— 打开就是对话，能力（动画 / 编程 / 闯关）
 * 以内联卡片出现在回答里，也可以从侧栏直达；学习档案与设置是次级页面。
 *
 * 生命周期：进入时接上两条 IPC 订阅（sidecar 状态、6 事件流）与身份读取，卸载时退订。
 *
 * ★★ 八个页面都挂在 `<KeepAlive>` 里：切走再回来时**组件本地状态**必须还在 ——
 *   学生写的代码（Monaco 里的编辑内容）、练习作答、动画播放进度、地图缩放位置、
 *   会话搜索框的内容只存在于组件里，**不在 store 里**；用 `v-if/v-else` 直接销毁
 *   会把它们全部丢掉。
 *
 *   KeepAlive 带来的生命周期变化（已逐个核对）：
 *     - `onMounted` 每个实例只跑一次 → 全局监听器（`window.addEventListener('message')`）
 *       与订阅**不会被重复注册**（没有「每切一次多一份监听」的泄漏）；
 *     - 切走时触发 `onDeactivated`（**不是** `onUnmounted`），切回触发 `onActivated`；
 *     - 真正的 `onBeforeUnmount`（移除监听器 / dispose 宿主与编辑器 / 断开 ResizeObserver
 *       / 退订运行器状态）仍会在**卸载时刻**执行：整个应用退出时。
 *   施工记录：`cards/AnimationCard.vue`（window 级消息监听）与 `cards/CodingCard.vue`
 *   （运行器状态订阅 + ResizeObserver + Monaco）在挂载/卸载上都是成对的，
 *   切走期间保留监听正是「动画进度与编辑器内容不被丢掉」所必需的，故**不**额外加
 *   activate/deactivate 收放（加了反而会让切回后 ready 计时与进度断一截）。
 *
 * ★ 顶栏的三步循环按钮（`view-entry`）留在这里：它是**外壳级动作**，
 *   而外壳（`layouts/AppShell.vue`）刻意不知道有哪些页面。文案与顺序的唯一来源
 *   仍是 `stores/ui.ts`（`VIEW_LABELS` / `nextView`）—— 两处各写一份顺序迟早对不上
 *   （按钮写着「去设置」，点下去却到了学习档案）。
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { ArrowRight } from 'lucide-vue-next'
import { BRAND_NAME, BRAND_TAGLINE } from '@shared/brand'
import AppShell from './layouts/AppShell.vue'
import Chat from './views/Chat.vue'
import Study from './views/Study.vue'
import Settings from './views/Settings.vue'
import Animation from './views/Animation.vue'
import Coding from './views/Coding.vue'
import Quiz from './views/Quiz.vue'
import Knowledge from './views/Knowledge.vue'
import Dependency from './views/Dependency.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import FloatPanel from './components/FloatPanel.vue'
import ModelPicker from './components/ModelPicker.vue'
import { useOnBackendReady } from './composables/useOnBackendReady'
import { useChatStore } from './stores/chat'
import { useConfirm } from './stores/confirm'
import { useSettingsStore } from './stores/settings'
import { useSidecarStore } from './stores/sidecar'
import { useStudentStore } from './stores/student'
import { useTraceStore } from './stores/trace'
import { nextView, isTeacherOnlyPage, PAGES, useUiStore, VIEW_LABELS } from './stores/ui'
import { useViewModeStore } from './stores/viewMode'

const ui = useUiStore()
const viewMode = useViewModeStore()
const chat = useChatStore()
const sidecar = useSidecarStore()
const student = useStudentStore()
const trace = useTraceStore()
const confirm = useConfirm()
const settings = useSettingsStore()

/**
 * 顶栏循环按钮的文案。
 *
 * ★★ **不要在这里再套一层 `nextView()`**：`VIEW_LABELS[current]` 的语义本来就是
 *   「在 `current` 这一页时，按钮上写什么」——
 *   它指向的是**下一个视图**（`stores/ui.ts` 里 chat: '学习档案' / study: '设置' /
 *   settings: '返回对话'）。再套一层 `nextView` 会得到「在对话页写着『设置』，
 *   点下去却到了学习档案」—— 正是 `ui-shell.test.ts` 那条守卫要防的错位；
 *   而那条守卫检查的是**数据**（`VIEW_LABELS` 与 `nextView` 自洽），
 *   照不到「调用方多套了一层」，所以它会照常通过、界面却在撒谎。
 */
const currentLabel = computed(() => VIEW_LABELS[ui.view])

/** 点击后要去的视图（与上面的文案是同一个来源，保证「写着去哪儿就去哪儿」）。 */
const nextTarget = computed(() => nextView(ui.view))

/**
 * 窗口标题：品牌名 + 当前页名。
 *
 * ★ 这不只是装饰：Electron 窗口标题显示在任务栏与 Alt-Tab 里，
 *   学生同时开多个窗口时靠它分辨。也是**品牌名的唯一来源**（`@shared/brand`）在
 *   外壳层的落点 —— `index.html` 的静态 `<title>` 只是首屏兜底，之后由这里接管。
 */
const windowTitle = computed(() => `${BRAND_NAME} · ${PAGES[ui.page].title}`)
watch(
  windowTitle,
  (title) => {
    document.title = title
  },
  { immediate: true }
)

/**
 * 首屏那一批取数（身份 + 设置）。
 *
 * ★★ 走 `useOnBackendReady` 而不是裸 `onMounted`：sidecar 是**另一个进程**，
 *   从启动到能应答要几秒，而渲染进程一挂载就发这批请求 ——
 *   冷启动几乎必然先撞一次「sidecar 尚未就绪」。
 *   只发一次的话那几个失败会**就地定格**（顶栏永远「未配置模型」、
 *   侧栏永远「学段待判定」），而服务其实几秒后就好了。
 *   打包版冷启动实测踩到过，详见 `composables/useOnBackendReady.ts`。
 *
 * ★ 两个 `load()` 都幂等（已有数据就返回），所以重试不会重复请求、
 *   也不会覆盖学生在设置页里改到一半的草稿。
 */
function loadInitialData(): void {
  // 身份：昵称 / 学段 / 当前章节（侧栏、档案页、依赖图都要用）
  void student.load()
  // 设置快照：模型 chip 在顶栏与输入条上（都是常驻 chrome）。
  // 只在设置页加载的话，学生第一次打开应用会看到「未配置模型」——
  // 而配置其实是好的，那是在拿「还没去读」冒充「没配」。
  void settings.load()
}

onMounted(() => {
  sidecar.connect()
  chat.connect()
  // 工具调用轨迹（独立于 6 事件的通道；右栏据此显示「本轮调了什么」）
  trace.connect()
})

// 首屏取数：立刻跑一次 + sidecar 就绪后补跑一次（见上面那段说明）
useOnBackendReady(loadInitialData)

/**
 * 切回学生视角时，把停在「教师专属页」上的学生带回对话页。
 *
 * ★ 为什么必须有这一段：教师视角下侧栏会多出「教材知识库」（`nav: 'teacher'`）。
 *   如果学生正停在那页、把开关切回学生视角，侧栏里那一项会消失 ——
 *   而页面本身**还在渲染**（它是 `KeepAlive` 里的分支，没有路由会把他弹走）。
 *   结果是「一个侧栏里找不到、也说不清怎么进来的运维页面」，
 *   学生只能靠顶栏那个三步循环按钮摸出去。
 * ★ 只处理「从教师切回学生」这一个方向：反过来（学生 → 教师）停在对话页是正常的，
 *   没有理由把评委弹到知识库页上去。
 */
watch(
  () => viewMode.isTeacher,
  (isTeacher, wasTeacher) => {
    if (wasTeacher === true && !isTeacher && isTeacherOnlyPage(ui.page)) {
      ui.go('chat')
    }
  }
)

onUnmounted(() => {
  chat.disconnect()
  sidecar.disconnect()
  trace.disconnect()
})
</script>

<template>
  <div class="app" data-testid="app-shell">
    <!-- 应用定位语：给读屏软件一句「这是什么应用」。
         侧栏也显示它，但侧栏是**视觉**的入口，读屏用户从应用根节点进来时
         需要一个稳定的说明。文本来自 @shared/brand（品牌名的唯一来源）。 -->
    <p class="sr-only">{{ BRAND_NAME }} —— {{ BRAND_TAGLINE }}</p>

    <AppShell>
      <!-- 外壳级动作：三步循环（对话 → 学习档案 → 设置 → 对话） -->
      <template #actions>
        <button
          class="cycle"
          type="button"
          data-testid="view-entry"
          :title="`切到${currentLabel}`"
          @click="ui.show(nextTarget)"
        >
          <span>{{ currentLabel }}</span>
          <ArrowRight :size="14" />
        </button>
      </template>

      <!-- ★ 全部分支都放在 <KeepAlive> **内部**（`v-if/v-else-if` 必须相邻，
           所以不能把 KeepAlive 只包住其中一个）。切走后组件被移进隐藏容器，
           DOM 查询看不到它（`data-testid="settings-view"` 在对话态查不到），
           本地状态照常保留。 -->
      <KeepAlive>
        <Chat v-if="ui.page === 'chat'" />
        <Animation v-else-if="ui.page === 'animation'" />
        <Coding v-else-if="ui.page === 'coding'" />
        <Quiz v-else-if="ui.page === 'quiz'" />
        <Study v-else-if="ui.page === 'study'" />
        <Settings v-else-if="ui.page === 'settings'" />
        <Knowledge v-else-if="ui.page === 'knowledge'" />
        <Dependency v-else />
      </KeepAlive>

      <!-- 全局浮层：挂在外壳上（不是某张卡里），换页时不卸载，位置与记录得以延续 -->
      <template #overlay>
        <FloatPanel />
      </template>
    </AppShell>

    <!-- 全局单例：确认框与模型选择弹层（都不属于任何一页）。
         ★ 确认框是**受控**的（props 进、事件出），状态在 `stores/confirm.ts` 里 ——
           调用方用 `await confirm.ask({...})` 拿到布尔结果，不必自己摆一个 v-model。 -->
    <ConfirmDialog
      :open="confirm.open"
      :title="confirm.options.title"
      :body="confirm.options.body ?? ''"
      :danger="confirm.options.danger ?? false"
      :confirm-text="confirm.options.confirmText ?? ''"
      :cancel-text="confirm.options.cancelText ?? '取消'"
      @confirm="confirm.onConfirm()"
      @cancel="confirm.onCancel()"
    />
    <ModelPicker />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--k12-page);
}

/* 三步循环按钮：它是**导航**（不是内容），所以走描边样式而不是主色填充 ——
 * 主色留给「这一页真正要做的事」。 */
.cycle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: center;
  padding: 7px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  /* ★ 顶栏整行是窗口拖拽区（见 AppShell 的说明）——
   * 少了这一条，这个按钮会被当成拖窗口的把手，点不动。 */
  -webkit-app-region: no-drag;
}
@media (hover: hover) and (pointer: fine) {
  .cycle:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
</style>
