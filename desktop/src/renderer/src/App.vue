<script setup lang="ts">
/**
 * 应用外壳：顶栏（品牌 + 本地服务状态 + 设置入口）+ 主区域（对话 / 设置）。
 *
 * 布局原则（执行文档 §11.1）：**对话优先** —— 打开就是对话，功能以卡片形式内联在回答里，
 * 设置是二级页面而不是首页的一块。
 *
 * 生命周期：进入时接上两条 IPC 订阅（sidecar 状态、6 事件流），卸载时退订（不留监听器）。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import SidecarBadge from './components/SidecarBadge.vue'
import Chat from './views/Chat.vue'
import Settings from './views/Settings.vue'
import { useChatStore } from './stores/chat'
import { useSidecarStore } from './stores/sidecar'

type ViewName = 'chat' | 'settings'

const view = ref<ViewName>('chat')
const chat = useChatStore()
const sidecar = useSidecarStore()

onMounted(() => {
  sidecar.connect()
  chat.connect()
})

onUnmounted(() => {
  chat.disconnect()
  sidecar.disconnect()
})

function toggleView(): void {
  view.value = view.value === 'settings' ? 'chat' : 'settings'
}
</script>

<template>
  <div class="app" data-testid="app-shell">
    <header class="topbar">
      <div class="brand">
        <h1 class="brand__title">K12 AI 教学助手</h1>
        <p class="brand__subtitle">多模态人工智能通识课 · 对话优先</p>
      </div>

      <div class="topbar__side">
        <SidecarBadge />
        <button
          class="btn"
          type="button"
          data-testid="settings-entry"
          @click="toggleView"
        >
          {{ view === 'settings' ? '返回对话' : '设置' }}
        </button>
      </div>
    </header>

    <main class="main">
      <Chat v-if="view === 'chat'" />
      <Settings v-else />
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
