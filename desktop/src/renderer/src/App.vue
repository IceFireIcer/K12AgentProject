<script setup lang="ts">
/**
 * 应用外壳：顶栏（品牌 + 本地服务状态 + 设置入口）+ 主区域（对话 / 学习档案 / 设置）。
 *
 * 布局原则（执行文档 §11.1）：**对话优先** —— 打开就是对话，功能以卡片形式内联在回答里，
 * 设置与学习档案都是二级页面而不是首页的一块。
 *
 * 生命周期：进入时接上两条 IPC 订阅（sidecar 状态、6 事件流），卸载时退订（不留监听器）。
 *
 * 视图切换：顶栏一个按钮按 `VIEW_ORDER` 循环（对话 → 学习档案 → 设置 → 对话）。
 * 「当前在哪个视图」在 `stores/ui.ts` 里 —— 因为学习档案里的「去练一练」
 * （错题本 → 回对话）**也要切视图**，那是子组件的动作，改不了父组件的本地 ref。
 *
 * ★ 三个视图都挂在 `<KeepAlive>` 里（H2 修复）：切走再回来时，**组件本地状态**
 *   必须还在 —— 学生写的代码（Monaco 里的编辑内容）、练习作答、动画播放进度只存在于
 *   卡片组件里，**不在 store 里**；用 `v-if/v-else` 直接销毁会把它们全部丢掉。
 *   （学习地图的缩放位置、会话搜索框的内容同理。）
 *
 *   KeepAlive 带来的生命周期变化（已逐个核对）：
 *     - `onMounted` 每个实例只跑一次 → 全局监听器（`window.addEventListener('message')`）
 *       与订阅**不会被重复注册**（没有「每切一次多一份监听」的泄漏）；
 *     - 切走时触发 `onDeactivated`（**不是** `onUnmounted`），切回触发 `onActivated`；
 *     - 真正的 `onBeforeUnmount`（移除监听器 / dispose 宿主与编辑器 / 断开 ResizeObserver
 *       / 退订运行器状态）仍会在**卸载时刻**执行：卡片从列表移除、或整个应用退出时。
 *   施工记录：`cards/AnimationCard.vue`（window 级消息监听）与 `cards/CodingCard.vue`
 *   （运行器状态订阅 + ResizeObserver + Monaco）在挂载/卸载上都是成对的，
 *   切走期间保留监听正是「动画进度与编辑器内容不被丢掉」所必需的，故**不**额外加
 *   activate/deactivate 收放（加了反而会让切回后 ready 计时与进度断一截）。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { BRAND_NAME, BRAND_TAGLINE } from '@shared/brand'
import SidecarBadge from './components/SidecarBadge.vue'
import Chat from './views/Chat.vue'
import Settings from './views/Settings.vue'
import Study from './views/Study.vue'
import { useChatStore } from './stores/chat'
import { useSidecarStore } from './stores/sidecar'
import { nextView, useUiStore, VIEW_LABELS } from './stores/ui'

const ui = useUiStore()
const chat = useChatStore()
const sidecar = useSidecarStore()

/** 顶栏按钮显示的文案：指向**下一个**视图（顺序的唯一来源是 `stores/ui.ts`）。 */
const nextLabel = computed(() => VIEW_LABELS[ui.view])

onMounted(() => {
  sidecar.connect()
  chat.connect()
})

onUnmounted(() => {
  chat.disconnect()
  sidecar.disconnect()
})

function stepView(): void {
  ui.show(nextView(ui.view))
}
</script>

<template>
  <div class="app" data-testid="app-shell">
    <header class="topbar">
      <div class="brand">
        <h1 class="brand__title">{{ BRAND_NAME }}</h1>
        <p class="brand__subtitle">{{ BRAND_TAGLINE }} · 对话优先</p>
      </div>

      <div class="topbar__side">
        <SidecarBadge />
        <button
          class="btn"
          type="button"
          data-testid="view-entry"
          @click="stepView"
        >
          {{ nextLabel }}
        </button>
      </div>
    </header>

    <main class="main">
      <!-- ★ 三个分支都放在 <KeepAlive> **内部**（`v-if/v-else-if/v-else` 必须相邻，
           所以不能把 KeepAlive 只包住 Chat）。切走后组件被移进隐藏容器，
           DOM 查询看不到它（`data-testid="settings-view"` 在对话态查不到），
           本地状态照常保留。 -->
      <KeepAlive>
        <Chat v-if="ui.view === 'chat'" />
        <Study v-else-if="ui.view === 'study'" />
        <Settings v-else />
      </KeepAlive>
    </main>
  </div>
</template>


<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.brand__title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.2px;
}

.brand__subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-faint);
}

.topbar__side {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.main {
  flex: 1;
  min-height: 0;
}
</style>
