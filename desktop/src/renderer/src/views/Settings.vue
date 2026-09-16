<script setup lang="ts">
/**
 * 设置视图 —— ★ 占位（票 07 接手本文件）。
 *
 * 票 05 只提供「入口 + 当前链路事实」，方便当场核对
 * 「窗口 → 主进程 IPC → sidecar」这条线是通的：
 *   - sidecar 状态（阶段 / 端口 / 进程 pid / 运行形态）来自 `sidecar:changed` 推送；
 *   - 供应商名称 / BaseURL / APIKey / ModelID 与**真实连通性探测**归票 07；
 *   - 嵌入配置三选一（local_fastembed / cloud_api / none）归票 07。
 */
import { useChatStore } from '../stores/chat'
import { GRADE_LABELS } from '../labels'
import { useSidecarStore } from '../stores/sidecar'

const sidecar = useSidecarStore()
const chat = useChatStore()
</script>

<template>
  <section class="settings" data-testid="settings-view">
    <header class="head">
      <h2 class="title">设置</h2>
      <span class="chip chip--warn">占位视图 · 票 07 落地</span>
    </header>

    <p class="lead">
      模型供应商（供应商名称 / BaseURL / APIKey / ModelID）与嵌入配置的填写与**真实连通性探测**
      由票 07 完成。本次先给出入口，并把当前链路的真实状态摆在下面，便于对照。
    </p>

    <dl class="rows" data-testid="settings-sidecar">
      <div class="row">
        <dt>本地数据服务</dt>
        <dd>{{ sidecar.phaseText }}</dd>
      </div>
      <div class="row">
        <dt>端口</dt>
        <dd>{{ sidecar.state?.port ?? '—' }}</dd>
      </div>
      <div class="row">
        <dt>后端进程 PID</dt>
        <dd>{{ sidecar.state?.pid ?? '—' }}</dd>
      </div>
      <div class="row">
        <dt>运行形态</dt>
        <dd>{{ sidecar.state?.mode === 'packaged' ? '打包产物' : '开发态' }}</dd>
      </div>
      <div class="row">
        <dt>当前学段（随对话请求传入）</dt>
        <dd>{{ GRADE_LABELS[chat.gradeLevel] }}（选择器归票 06）</dd>
      </div>
    </dl>

    <p v-if="sidecar.errorText" class="error" data-testid="settings-error">{{ sidecar.errorText }}</p>

    <section class="safe">
      <h3 class="safe__title">安全约定（已生效）</h3>
      <ul class="safe__list">
        <li>渲染进程不直连本地数据服务，也没有 HTTP 能力：所有数据都经主进程 IPC 白名单。</li>
        <li>本地数据服务的访问令牌只在主进程内存里，不会出现在页面能拿到的任何对象中。</li>
        <li>API Key 仅本地存储、不回显明文、不写入日志（票 07 落地时同样遵守）。</li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.settings {
  max-width: 920px;
  margin: 0 auto;
  padding: 28px 24px 40px;
  overflow-y: auto;
  height: 100%;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.title {
  font-size: 20px;
  font-weight: 650;
}

.lead {
  margin-top: 10px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-muted);
  max-width: 720px;
}

.rows {
  margin: 22px 0 0;
  padding: 16px 18px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
  font-size: 14px;
}

.row dt {
  color: var(--text-muted);
}

.row dd {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.error {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--danger-soft);
  border: 1px solid rgba(179, 38, 30, 0.2);
  color: var(--danger);
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}

.safe {
  margin-top: 24px;
  padding: 16px 18px;
  border-radius: var(--radius);
  background: var(--surface-muted);
  border: 1px solid var(--border);
}

.safe__title {
  font-size: 14px;
  font-weight: 650;
}

.safe__list {
  margin: 10px 0 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-muted);
}
</style>
