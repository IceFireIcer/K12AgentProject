<script setup lang="ts">
/**
 * 票 01 的最小可运行界面：只有「应用标题 + sidecar 状态徽章」。
 * 不含任何业务逻辑（对话 / 卡片 / 设置页都归后续票）。
 *
 * ★ 与 sidecar 的通信只走 `window.api`（preload 白名单）——
 *   渲染进程永远不直连 sidecar 的 HTTP 端口（架构守卫会检查这一条）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { SidecarPhase, SidecarState } from '../../main/sidecar/protocol'

const state = ref<SidecarState | null>(null)
const loadError = ref<string | null>(null)
let unsubscribe: (() => void) | null = null

const PHASE_TEXT: Record<SidecarPhase, string> = {
  idle: '等待启动',
  starting: '启动中',
  ready: '已就绪',
  failed: '启动失败',
  stopped: '已停止'
}

const PHASE_HINT: Record<SidecarPhase, string> = {
  idle: '尚未拉起本地数据服务（Python sidecar）。',
  starting: '正在启动本地数据服务，就绪前不影响窗口操作。',
  ready: '本地数据服务已就绪，可以开始对话。',
  failed: '本地数据服务未能启动，请查看下方错误与日志。',
  stopped: '本地数据服务已停止。'
}

const phase = computed<SidecarPhase>(() => state.value?.phase ?? 'idle')
const phaseText = computed(() => PHASE_TEXT[phase.value])
const errorText = computed(() => state.value?.lastError ?? loadError.value)

onMounted(async () => {
  if (typeof window.api === 'undefined') {
    loadError.value = '预加载脚本未生效（window.api 缺失），无法读取本地数据服务状态。'
    return
  }

  unsubscribe = window.api.onSidecarChanged((next) => {
    state.value = next
  })

  try {
    state.value = await window.api.getSidecarInfo()
  } catch (error) {
    loadError.value = `读取本地数据服务状态失败：${String(error)}`
  }
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <main class="shell">
    <section class="panel">
      <header class="head">
        <h1 class="title">K12 AI 教学助手</h1>
        <p class="subtitle">多模态 K12 人工智能通识课教学助手 · 双端脚手架（票 01）</p>
      </header>

      <div class="status">
        <span
          class="badge"
          :class="`badge--${phase}`"
          data-testid="sidecar-status"
          :data-phase="phase"
        >
          <span class="dot" aria-hidden="true"></span>
          {{ phaseText }}
        </span>

        <p class="hint">{{ PHASE_HINT[phase] }}</p>

        <dl class="meta">
          <div class="meta__row">
            <dt>端口</dt>
            <dd>{{ state?.port ?? '—' }}</dd>
          </div>
          <div class="meta__row">
            <dt>进程 PID</dt>
            <dd>{{ state?.pid ?? '—' }}</dd>
          </div>
          <div class="meta__row">
            <dt>运行形态</dt>
            <dd>{{ state?.mode === 'packaged' ? '打包产物' : '开发态' }}</dd>
          </div>
        </dl>

        <p v-if="errorText" class="error" data-testid="sidecar-error">{{ errorText }}</p>
      </div>

      <footer class="foot">
        本地数据服务由 <code>server/</code> 提供（Python 3.12 + FastAPI），
        仅监听本机回环地址，由主进程统一探活与收尾。
      </footer>
    </section>
  </main>
</template>

<style>
:root {
  color-scheme: light;
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  color: #1f2430;
  background: #f4f6fb;
}

body {
  margin: 0;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

code {
  font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
  font-size: 0.92em;
  padding: 0 0.25em;
  border-radius: 4px;
  background: rgba(31, 36, 48, 0.06);
}
</style>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  box-sizing: border-box;
  background: radial-gradient(circle at 20% 0%, #e8eefc 0%, #f4f6fb 45%, #eef1f7 100%);
}

.panel {
  width: 100%;
  max-width: 620px;
  padding: 32px 36px;
  border-radius: 16px;
  background: #ffffff;
  border: 1px solid rgba(31, 36, 48, 0.08);
  box-shadow: 0 18px 40px rgba(31, 36, 48, 0.08);
}

.title {
  margin: 0;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: 0.5px;
}

.subtitle {
  margin: 8px 0 0;
  font-size: 13px;
  color: #5b6473;
  line-height: 1.6;
}

.status {
  margin-top: 24px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid transparent;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.badge--idle,
.badge--stopped {
  color: #5b6473;
  background: #eef1f7;
  border-color: rgba(91, 100, 115, 0.2);
}

.badge--starting {
  color: #9a6400;
  background: #fff5df;
  border-color: rgba(154, 100, 0, 0.24);
}

.badge--starting .dot {
  animation: pulse 1.1s ease-in-out infinite;
}

.badge--ready {
  color: #1a7f4b;
  background: #e6f6ed;
  border-color: rgba(26, 127, 75, 0.24);
}

.badge--failed {
  color: #b3261e;
  background: #fdeceb;
  border-color: rgba(179, 38, 30, 0.24);
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.hint {
  margin: 12px 0 0;
  font-size: 13px;
  color: #5b6473;
  line-height: 1.6;
}

.meta {
  margin: 20px 0 0;
  padding: 14px 16px;
  border-radius: 10px;
  background: #f7f9fd;
  border: 1px solid rgba(31, 36, 48, 0.06);
  font-size: 13px;
}

.meta__row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
}

.meta__row dt {
  color: #5b6473;
}

.meta__row dd {
  margin: 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.error {
  margin: 16px 0 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: #fdeceb;
  border: 1px solid rgba(179, 38, 30, 0.2);
  color: #b3261e;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.foot {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid rgba(31, 36, 48, 0.08);
  font-size: 12px;
  color: #7a8394;
  line-height: 1.7;
}
</style>
