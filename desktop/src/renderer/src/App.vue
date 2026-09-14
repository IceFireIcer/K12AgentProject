<script setup lang="ts">
/**
 * S01 阶段的状态页：把「握手成功 port=xxxxx」摆到界面上。
 *
 * 这是关卡 A 的可视证据；S02 起会被真正的对话界面取代。
 */
import { computed, ref } from 'vue'
import { useSidecar } from './stores/sidecar'

const sidecar = useSidecar()
const authProbe = ref<string>('未验证')

/** 仅在「技术详情」与可读文案确实不同时才折叠展示，避免重复噪音。 */
const showDetail = computed(
  () => !!sidecar.info?.lastErrorDetail && sidecar.info.lastErrorDetail !== sidecar.info?.lastError
)

/** 就绪后顺手验证一次受保护接口，证明 token 鉴权链路是通的。 */
async function probeAuth(): Promise<void> {
  const info = sidecar.info
  if (!info?.port || !info.token) return
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping`, {
      headers: { 'X-Auth-Token': info.token }
    })
    authProbe.value = res.ok ? '通过（/api/ping 200）' : `失败（HTTP ${res.status}）`
  } catch (err) {
    authProbe.value = `失败：${err instanceof Error ? err.message : String(err)}`
  }
}
</script>

<template>
  <div class="shell">
    <header class="hd">
      <div>
        <h1>K12 AI 通识课教学助手</h1>
        <p class="sub">Stage 01 · 双端脚手架 + Sidecar 握手</p>
      </div>
      <span class="badge" :class="sidecar.phase">{{ sidecar.phaseText }}</span>
    </header>

    <!-- 就绪：把端口大字摆出来，这是关卡 A 的核心证据 -->
    <section v-if="sidecar.isReady" class="card ok">
      <p class="headline">
        握手成功 <code>port={{ sidecar.portText }}</code>
      </p>
      <p class="note">Electron 已拉起 Python sidecar，并通过 <code>/health</code> 探活。</p>

      <dl class="kv">
        <div><dt>运行模式</dt><dd>{{ sidecar.info?.mode === 'packaged' ? '打包产物' : '开发（uv run）' }}</dd></div>
        <div><dt>后端版本</dt><dd>{{ sidecar.info?.version ?? '—' }}</dd></div>
        <div><dt>进程 PID</dt><dd>{{ sidecar.info?.pid ?? '—' }}</dd></div>
        <div><dt>打包运行</dt><dd>{{ sidecar.info?.frozen ? '是（PyInstaller）' : '否' }}</dd></div>
        <div><dt>嵌入模型</dt><dd>{{ sidecar.info?.embedderReady ? '文件就绪' : '未检出' }}</dd></div>
        <div><dt>自动重启</dt><dd>{{ sidecar.info?.restarts ?? 0 }} 次</dd></div>
        <div class="wide"><dt>数据目录</dt><dd class="mono">{{ sidecar.info?.dataDir }}</dd></div>
      </dl>

      <div class="row">
        <button @click="probeAuth">验证 token 鉴权</button>
        <span class="probe" :class="{ ok: authProbe.includes('通过') }">{{ authProbe }}</span>
      </div>
    </section>

    <!-- 进行中 -->
    <section v-else-if="sidecar.isBusy" class="card busy">
      <div class="spinner" aria-hidden="true"></div>
      <p class="headline">{{ sidecar.phaseText }}</p>
      <p class="note">首次启动需要加载后端依赖，请稍候（最长 30 秒）。</p>
    </section>

    <!-- 失败：绝不白屏，给可读错误 + 重试 -->
    <section v-else-if="sidecar.isFailed" class="card bad">
      <p class="headline">后端服务启动失败</p>
      <p class="note">{{ sidecar.info?.lastError ?? sidecar.error ?? '未知原因' }}</p>
      <p v-if="sidecar.info?.restarts" class="note">
        已自动重启 {{ sidecar.info.restarts }} 次仍未恢复。
      </p>
      <details v-if="showDetail" class="detail">
        <summary>查看技术详情</summary>
        <pre class="mono">{{ sidecar.info?.lastErrorDetail }}</pre>
      </details>
      <div class="row">
        <button class="primary" @click="sidecar.restart">重试</button>
        <span class="mono logpath">{{ sidecar.info?.logFile }}</span>
      </div>
    </section>

    <section v-else class="card">
      <p class="headline">{{ sidecar.phaseText }}</p>
      <p class="note">正在等待主进程上报状态…</p>
    </section>

    <footer class="ft">
      <span>本地化运行 · 数据不出端</span>
      <span class="mono">仅监听 127.0.0.1</span>
    </footer>
  </div>
</template>

<style scoped>
.shell {
  max-width: 820px;
  margin: 0 auto;
  padding: 48px 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

h1 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin: 0 0 4px;
}

.sub {
  margin: 0;
  font-size: 13px;
  color: var(--fg-dim);
}

.badge {
  flex: none;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--chip);
  color: var(--fg-dim);
  white-space: nowrap;
}
.badge.ready {
  background: var(--ok-soft);
  color: var(--ok);
}
.badge.failed {
  background: var(--bad-soft);
  color: var(--bad);
}
.badge.starting,
.badge.handshaking,
.badge.restarting {
  background: var(--warn-soft);
  color: var(--warn);
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 24px;
}
.card.ok {
  border-color: var(--ok-border);
}
.card.bad {
  border-color: var(--bad-border);
}

.headline {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 620;
}

.note {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--fg-dim);
  line-height: 1.6;
}

code,
.mono {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12.5px;
}

code {
  background: var(--chip);
  padding: 2px 7px;
  border-radius: 6px;
}

.kv {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 20px;
  margin: 20px 0 0;
}
.kv > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
}
.kv .wide {
  grid-column: 1 / -1;
}
.kv dt {
  font-size: 12.5px;
  color: var(--fg-dim);
  flex: none;
}
.kv dd {
  margin: 0;
  font-size: 12.5px;
  text-align: right;
  word-break: break-all;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
  flex-wrap: wrap;
}

button {
  font: inherit;
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--chip);
  color: inherit;
  cursor: pointer;
}
button:hover {
  border-color: var(--fg-dim);
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.probe {
  font-size: 12.5px;
  color: var(--fg-dim);
}
.probe.ok {
  color: var(--ok);
}

.logpath {
  color: var(--fg-dim);
  font-size: 11.5px;
  word-break: break-all;
}

.detail {
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--fg-dim);
}
.detail summary {
  cursor: pointer;
  user-select: none;
}
.detail pre {
  margin: 8px 0 0;
  padding: 10px 12px;
  background: var(--chip);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}

.spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid var(--border);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
  margin-bottom: 14px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2.4s;
  }
}

.ft {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--fg-dim);
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
</style>
