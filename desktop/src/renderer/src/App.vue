<script setup lang="ts">
/**
 * 应用外壳：导航 + 「后端未就绪时」的统一闸门。
 *
 * 设计取舍：S02 阶段先**不引 vue-router**——只有 3 个视图、无深层链接需求，
 * 一个 `ref` 足够；引入 router 会增加一层与 Electron `file://` 协议配合的坑
 * （history 模式在 file:// 下不可用）。S03 起视图变多再评估。
 *
 * 闸门逻辑：sidecar 未就绪时**不渲染任何视图**，只显示后端状态页——
 * 否则每个视图都要自己判断"后端能不能用"，错误处理必然重复且不一致。
 */
import { computed, ref } from 'vue'
import { useSidecar } from './stores/sidecar'
import Dashboard from './views/Dashboard.vue'
import Settings from './views/Settings.vue'
import SseProbe from './views/SseProbe.vue'

const sidecar = useSidecar()

type ViewName = 'dashboard' | 'settings' | 'sse'
const view = ref<ViewName>('dashboard')

const NAV: { name: ViewName; label: string; hint: string }[] = [
  { name: 'dashboard', label: '状态', hint: '后端与运行环境' },
  { name: 'settings', label: '设置', hint: '模型供应商与嵌入模式' },
  { name: 'sse', label: '流式自检', hint: 'SSE 六种事件' }
]

const activeView = computed(() => {
  switch (view.value) {
    case 'settings':
      return Settings
    case 'sse':
      return SseProbe
    default:
      return Dashboard
  }
})
</script>

<template>
  <div class="app">
    <aside class="side">
      <div class="brand">
        <span class="logo" aria-hidden="true">K12</span>
        <div>
          <p class="title">AI 通识课教学助手</p>
          <p class="sub">Stage 02 · 契约冻结</p>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="item in NAV"
          :key="item.name"
          class="nav-item"
          :class="{ active: view === item.name, disabled: !sidecar.isReady }"
          :disabled="!sidecar.isReady"
          :title="item.hint"
          @click="view = item.name"
        >
          <span class="nav-label">{{ item.label }}</span>
          <span class="nav-hint">{{ item.hint }}</span>
        </button>
      </nav>

      <div class="side-foot">
        <span class="dot" :class="sidecar.phase" aria-hidden="true"></span>
        <span>{{ sidecar.phaseText }}</span>
        <span v-if="sidecar.isReady" class="mono port">:{{ sidecar.portText }}</span>
      </div>
    </aside>

    <main class="main">
      <!-- 未就绪：显示 S01 的后端状态页（握手结果 / 可读错误 + 重试），不渲染业务视图 -->
      <Dashboard v-if="!sidecar.isReady" />
      <component :is="activeView" v-else />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  height: 100%;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 22px 16px;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 6px;
}

.logo {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 620;
}

.sub {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--fg-dim);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.nav-item:hover:not(:disabled) {
  background: var(--chip);
}
.nav-item.active {
  background: var(--chip);
  border-color: var(--border);
}
.nav-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.nav-label {
  font-size: 13px;
  font-weight: 560;
}

.nav-hint {
  font-size: 11px;
  color: var(--fg-dim);
}

.side-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 12px;
  font-size: 11.5px;
  color: var(--fg-dim);
  border-top: 1px solid var(--border);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-dim);
  flex: none;
}
.dot.ready {
  background: var(--ok);
}
.dot.failed {
  background: var(--bad);
}
.dot.starting,
.dot.handshaking,
.dot.restarting {
  background: var(--warn);
}

.port {
  margin-left: auto;
  font-size: 11px;
}

.main {
  overflow-y: auto;
}
</style>
