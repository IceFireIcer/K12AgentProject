<script setup lang="ts">
/**
 * 状态视图。
 *
 * 双重职责（刻意合并，避免重复实现）：
 * 1. **后端未就绪时**：S01 的闸门页——显示「握手成功 port=xxxxx」或可读错误 + 重试。
 *    这是关卡 A 的可视证据，S02 起仍是启动失败时的唯一界面。
 * 2. **后端就绪后**：作为 Dashboard，展示运行环境 + 契约自检结果。
 */
import { computed, onMounted, ref } from 'vue'
import { requestJson } from '../api/client'
import { useSidecar } from '../stores/sidecar'

const sidecar = useSidecar()
const authProbe = ref<string>('未验证')
const meta = ref<Record<string, unknown> | null>(null)
const metaError = ref<string | null>(null)

/** 仅在「技术详情」与可读文案确实不同时才折叠展示，避免重复噪音。 */
const showDetail = computed(
  () => !!sidecar.info?.lastErrorDetail && sidecar.info.lastErrorDetail !== sidecar.info?.lastError
)

function endpoint(): { port: number; token: string } | null {
  const info = sidecar.info
  if (!info?.port || !info.token) return null
  return { port: info.port, token: info.token }
}

/** 连受保护接口，证明 token 鉴权链路是通的。 */
async function probeAuth(): Promise<void> {
  await Promise.all([probePing(), probeMeta()])
}

async function probePing(): Promise<void> {
  const ep = endpoint()
  if (!ep) return
  try {
    // 走统一客户端（自动注入 X-Auth-Token），不要在组件里裸写 fetch
    await requestJson(ep, '/api/ping')
    authProbe.value = '通过（/api/ping 200）'
  } catch (err) {
    authProbe.value = `失败：${err instanceof Error ? err.message : String(err)}`
  }
}

/** `/api/meta` 返回中文 appName —— 順带验证 UTF-8 链路（打包后 GBK 乱码的回归探针）。 */
async function probeMeta(): Promise<void> {
  const ep = endpoint()
  if (!ep) return
  try {
    meta.value = await requestJson<Record<string, unknown>>(ep, '/api/meta')
    metaError.value = null
  } catch (err) {
    metaError.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(() => {
  if (sidecar.isReady) void probeAuth()
})
</script>

<template>
  <div class="shell">
    <!-- ============ 未就绪：后端状态页（含关卡 A 证据） ============ -->
    <template v-if="!sidecar.isReady">
      <header class="hd">
        <div>
          <h1>K12 AI 通识课教学助手</h1>
          <p class="sub">正在等待本地后端服务</p>
        </div>
        <span class="badge" :class="sidecar.phase">{{ sidecar.phaseText }}</span>
      </header>

      <!-- 就绪分支不在这里渲染（就绪后走下面的 Dashboard），保留此块仅为逻辑完整 -->
      <section v-if="sidecar.isReady" class="card ok">
        <p class="headline">握手成功 <code>port={{ sidecar.portText }}</code></p>
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
    </template>

    <!-- ============ 就绪：运行环境 Dashboard ============ -->
    <template v-else>
      <header class="hd">
        <div>
          <h1>运行状态</h1>
          <p class="sub">本地后端已就绪 · 握手成功 <code>port={{ sidecar.portText }}</code></p>
        </div>
        <span class="badge ready">已就绪</span>
      </header>

      <section class="card">
        <p class="card-title">进程与环境</p>
        <dl class="kv">
          <div><dt>运行模式</dt><dd>{{ sidecar.info?.mode === 'packaged' ? '打包产物' : '开发（uv run）' }}</dd></div>
          <div><dt>后端版本</dt><dd>{{ sidecar.info?.version ?? '—' }}</dd></div>
          <div><dt>进程 PID</dt><dd>{{ sidecar.info?.pid ?? '—' }}</dd></div>
          <div><dt>打包运行</dt><dd>{{ sidecar.info?.frozen ? '是（PyInstaller）' : '否' }}</dd></div>
          <div><dt>嵌入模型</dt><dd>{{ sidecar.info?.embedderReady ? '文件就绪' : '未检出' }}</dd></div>
          <div><dt>自动重启</dt><dd>{{ sidecar.info?.restarts ?? 0 }} 次</dd></div>
          <div class="wide"><dt>数据目录</dt><dd class="mono">{{ sidecar.info?.dataDir }}</dd></div>
        </dl>
      </section>

      <section class="card">
        <div class="card-head">
          <p class="card-title">契约与鉴权自检</p>
          <div class="row">
            <button @click="probeAuth">重新检测</button>
            <span class="probe" :class="{ ok: authProbe.includes('通过') }">{{ authProbe }}</span>
          </div>
        </div>
        <p class="note">
          下列信息来自 <code>GET /api/meta</code>（受 <code>X-Auth-Token</code> 保护）。
          中文正常显示即表示 UTF-8 链路（含打包后）无乱码。
        </p>
        <p v-if="metaError" class="note bad-text">读取失败：{{ metaError }}</p>
        <dl v-else-if="meta" class="kv">
          <div><dt>应用名（中文探针）</dt><dd>{{ meta.appName }}</dd></div>
          <div><dt>后端版本</dt><dd>{{ meta.version }}</dd></div>
          <div><dt>嵌入维度</dt><dd>{{ meta.embeddingDim }}</dd></div>
          <div><dt>鉴权</dt><dd>{{ meta.authEnabled ? '已开启（token）' : '未开启（本地开发）' }}</dd></div>
          <div class="wide"><dt>嵌入模型</dt><dd class="mono">{{ meta.embeddingModelId }}</dd></div>
        </dl>
        <p v-else class="note">尚未检测。</p>
      </section>
    </template>

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
  padding: 40px 28px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

h1 {
  font-size: 21px;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin: 0 0 4px;
}

.sub {
  margin: 0;
  font-size: 12.5px;
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
  padding: 22px;
}
.card.ok {
  border-color: var(--ok-border);
}
.card.bad {
  border-color: var(--bad-border);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-title {
  margin: 0 0 6px;
  font-size: 14.5px;
  font-weight: 620;
}

.headline {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 620;
}

.note {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--fg-dim);
  line-height: 1.65;
}

.bad-text {
  color: var(--bad);
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
  margin: 16px 0 0;
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
