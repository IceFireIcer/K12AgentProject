<script setup lang="ts">
/**
 * SSE 管道自检视图（S02 DoD：「前端能逐条收到 6 种事件」）。
 *
 * 为什么做成界面而不是 console.log：
 * 1. 契约里 `blocked` / `error` 两种事件在真实链路中很难自然触发（要等 S12 的
 *    内容安全和弱网降级），没有这个开关就永远测不到——不测的分支约等于没写；
 * 2. 演示时能当场按「全事件模式」证明六条分支都通；
 * 3. 「逐条到达」的时序、中文不乱码、最终正文能否拼回原文，都是一眼可判的证据。
 *
 * 注：S03 接真实 LLM 流后，这里改用 `/api/chat/stream`，界面结构不变。
 */
import { useSseProbeStore } from '../stores/sse-probe'

const probe = useSseProbeStore()

const EVENT_STYLE: Record<string, string> = {
  delta: 'ev-delta',
  citation: 'ev-citation',
  payload: 'ev-payload',
  blocked: 'ev-blocked',
  done: 'ev-done',
  error: 'ev-error'
}

const EVENT_LABEL: Record<string, string> = {
  delta: 'delta 逐字',
  citation: 'citation 引用',
  payload: 'payload 卡片',
  blocked: 'blocked 安全拦截',
  done: 'done 收尾',
  error: 'error 降级'
}
</script>

<template>
  <div class="shell">
    <header class="hd">
      <div>
        <h1>流式管道自检</h1>
        <p class="sub">
          用 <code>fetch</code> + <code>ReadableStream</code> 消费
          <code>POST /api/chat/stream/echo</code>（S02 临时的假数据端点）
        </p>
      </div>
      <span v-if="probe.running" class="badge warn">接收中…</span>
      <span v-else-if="probe.finished" class="badge ok">已完成</span>
    </header>

    <section class="card">
      <div class="controls">
        <button class="primary" :disabled="probe.running" @click="probe.run({ allEvents: false, intervalMs: 50 })">
          正常流（delta → citation → payload → done）
        </button>
        <button :disabled="probe.running" @click="probe.run({ allEvents: true, intervalMs: 50 })">
          全事件模式（+ blocked / error）
        </button>
        <button :disabled="!probe.running" @click="probe.stop()">停止</button>
        <button :disabled="probe.running" @click="probe.reset()">清空</button>
      </div>
      <p class="note">
        事件间隔 50ms：既能看清「逐条到达」，也留出足够时间点「停止」验证中断。
      </p>

      <p v-if="probe.error" class="alert bad">{{ probe.error }}</p>

      <!-- 事件覆盖情况：验收项「6 种事件全部收到」的直接证据 -->
      <div class="coverage">
        <span
          v-for="name in ['delta', 'citation', 'payload', 'blocked', 'done', 'error']"
          :key="name"
          class="chip"
          :class="[EVENT_STYLE[name], { seen: (probe.counts[name] ?? 0) > 0 }]"
        >
          {{ name }}
          <b v-if="probe.counts[name]">×{{ probe.counts[name] }}</b>
          <span v-else class="miss">未收到</span>
        </span>
        <span class="cov-summary" :class="{ ok: probe.allSixCovered }">
          {{ probe.coveredEvents.length }} / 6
        </span>
      </div>

      <dl class="kv">
        <div><dt>requestId</dt><dd class="mono">{{ probe.requestId ?? '—' }}</dd></div>
        <div><dt>messageId</dt><dd class="mono">{{ probe.messageId ?? '—' }}</dd></div>
        <div><dt>耗时</dt><dd>{{ probe.elapsedMs }} ms</dd></div>
        <div>
          <dt>降级标记</dt>
          <dd :class="{ 'bad-text': probe.degraded }">{{ probe.degraded ? 'degraded=true' : '无' }}</dd>
        </div>
      </dl>

      <p v-if="probe.blocked" class="blocked-note">
        <strong>已被安全拦截并替换为：</strong>{{ probe.blocked }}
      </p>
    </section>

    <!-- 累积正文：验证中文不乱码（跨 chunk 的 TextDecoder{stream:true}）与顺序 -->
    <section v-if="probe.text" class="card">
      <p class="card-title">累积正文（{{ probe.text.length }} 字符）</p>
      <p class="note">若出现 <code>�</code> 说明 <code>TextDecoder</code> 少了 <code>stream: true</code>。</p>
      <pre class="stream mono">{{ probe.text }}</pre>
    </section>

    <!-- 逐条事件日志：证明确实是"逐条到达"而不是一次性灌进来 -->
    <section v-if="probe.entries.length" class="card">
      <p class="card-title">事件日志（{{ probe.entries.length }} 条）</p>
      <ol class="log">
        <li v-for="entry in probe.entries" :key="entry.index" :class="EVENT_STYLE[entry.event]">
          <span class="idx mono">{{ entry.index }}</span>
          <span class="ev">{{ EVENT_LABEL[entry.event] ?? entry.event }}</span>
          <span class="sum mono">{{ entry.summary }}</span>
        </li>
      </ol>
    </section>

    <p v-if="probe.diagnostics.length" class="alert bad">
      解析器诊断：{{ probe.diagnostics.join('；') }}
    </p>
  </div>
</template>

<style scoped>
.shell {
  max-width: 860px;
  margin: 0 auto;
  padding: 40px 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
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
  margin: 0 0 4px;
}

.sub {
  margin: 0;
  font-size: 12.5px;
  color: var(--fg-dim);
  line-height: 1.6;
}

.badge {
  flex: none;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.badge.ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.badge.warn {
  background: var(--warn-soft);
  color: var(--warn);
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 22px;
}

.card-title {
  margin: 0 0 6px;
  font-size: 14.5px;
  font-weight: 620;
}

.note {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--fg-dim);
  line-height: 1.6;
}

.controls {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

button {
  font: inherit;
  font-size: 12.5px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--chip);
  color: inherit;
  cursor: pointer;
}
button:hover:not(:disabled) {
  border-color: var(--fg-dim);
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.alert {
  margin: 14px 0 0;
  padding: 11px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
}
.alert.bad {
  background: var(--bad-soft);
  color: var(--bad);
}

.coverage {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 18px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 560;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--chip);
  color: var(--fg-dim);
}
.chip.seen {
  color: var(--fg);
  border-color: var(--ok-border);
  background: var(--ok-soft);
}
.chip .miss {
  font-weight: 400;
  opacity: 0.75;
}
.chip b {
  font-weight: 700;
}

.cov-summary {
  margin-left: auto;
  font-size: 12.5px;
  font-weight: 620;
  color: var(--fg-dim);
}
.cov-summary.ok {
  color: var(--ok);
}

.kv {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 20px;
  margin: 18px 0 0;
}
.kv > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
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

.bad-text {
  color: var(--bad);
}

.blocked-note {
  margin: 14px 0 0;
  padding: 10px 12px;
  background: var(--warn-soft);
  color: var(--warn);
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
}

.stream {
  margin: 0;
  padding: 13px 14px;
  background: var(--chip);
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  max-height: 200px;
  overflow: auto;
}

.log {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.log li {
  display: grid;
  grid-template-columns: 34px 128px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  padding: 5px 8px;
  border-radius: 7px;
  font-size: 12px;
}
.log li:nth-child(odd) {
  background: var(--chip);
}

.idx {
  color: var(--fg-dim);
  font-size: 11px;
  text-align: right;
}

.ev {
  font-weight: 560;
}

.sum {
  color: var(--fg-dim);
  word-break: break-word;
  user-select: text;
}

.ev-delta .ev {
  color: var(--fg-dim);
}
.ev-citation .ev {
  color: #2f6fed;
}
.ev-payload .ev {
  color: #7a53c4;
}
.ev-blocked .ev {
  color: var(--warn);
}
.ev-done .ev {
  color: var(--ok);
}
.ev-error .ev {
  color: var(--bad);
}

code,
.mono {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

code {
  background: var(--chip);
  padding: 1px 6px;
  border-radius: 5px;
}
</style>
