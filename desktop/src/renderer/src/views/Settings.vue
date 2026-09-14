<script setup lang="ts">
/**
 * 设置页（S02 核心交付之一）。
 *
 * 可填：供应商名称 / BaseURL / APIKey / ModelId / 嵌入模式。
 * 保存后写 `config.json`（落在 `--data-dir`），重启应用仍在。
 *
 * ★ API Key 交互的关键设计：
 *   - 输入框**永远是空的**，placeholder 显示后端回的掩码 → 用户不会误以为要重填；
 *   - 留空提交 = 不修改（后端语义）；
 *   - 想换 key 就输入新的；想清除用「清除密钥」按钮（显式 clearApiKey）。
 *   - 任何情况下界面/日志都不会出现明文 key。
 */
import { onMounted } from 'vue'
import { useSettingsStore } from '../stores/settings'

const settings = useSettingsStore()

onMounted(() => {
  void settings.load()
})
</script>

<template>
  <div class="shell">
    <header class="hd">
      <div>
        <h1>设置</h1>
        <p class="sub">模型供应商、嵌入模式与本地存储位置</p>
      </div>
      <span v-if="settings.dirty" class="badge warn">有未保存的改动</span>
      <span v-else-if="settings.notice" class="badge ok">{{ settings.notice }}</span>
    </header>

    <p v-if="settings.error" class="alert bad">{{ settings.error }}</p>

    <form class="card" @submit.prevent="settings.save()">
      <p class="card-title">主模型（OpenAI 兼容）</p>
      <p class="note">
        默认 DeepSeek。任何 OpenAI 兼容供应商都可以用——
        <strong>换供应商只改这里，不需要改代码</strong>。
      </p>

      <div class="grid">
        <label class="field">
          <span class="label">供应商名称</span>
          <input v-model="settings.form.providerName" placeholder="DeepSeek" autocomplete="off" />
          <span class="hint">仅用于界面展示，不参与调用</span>
        </label>

        <label class="field">
          <span class="label">Model ID</span>
          <input v-model="settings.form.modelId" placeholder="deepseek-chat" autocomplete="off" />
          <span class="hint">如 deepseek-chat / qwen-plus</span>
        </label>

        <label class="field wide">
          <span class="label">BaseURL</span>
          <input
            v-model="settings.form.baseUrl"
            type="url"
            placeholder="https://api.deepseek.com/v1"
            spellcheck="false"
            autocomplete="off"
          />
          <span class="hint">需以 http:// 或 https:// 开头，末尾斜杠会被自动去掉</span>
        </label>

        <label class="field wide">
          <span class="label">
            API Key
            <span v-if="settings.current?.hasKey" class="tag ok">
              已配置 {{ settings.current.apiKeyMasked }}
            </span>
            <span v-else class="tag">未配置</span>
          </span>
          <input
            v-model="settings.form.apiKeyInput"
            type="password"
            :placeholder="
              settings.current?.hasKey ? '留空则保持当前 Key 不变' : '粘贴你的 API Key'
            "
            spellcheck="false"
            autocomplete="new-password"
          />
          <span class="hint">
            仅存本机 <code>config.json</code>，不上传、不入日志；接口返回时也只会给出掩码。
          </span>
        </label>
      </div>

      <div class="actions">
        <button class="primary" type="submit" :disabled="settings.saving">
          {{ settings.saving ? '保存中…' : '保存' }}
        </button>
        <button type="button" :disabled="settings.saving" @click="settings.load()">重新载入</button>
        <button
          v-if="settings.current?.hasKey"
          type="button"
          class="danger"
          :disabled="settings.saving"
          @click="settings.clearApiKey()"
        >
          清除密钥
        </button>
      </div>
    </form>

    <form class="card" @submit.prevent="settings.save()">
      <p class="card-title">嵌入（检索用）</p>
      <p class="note">
        默认<strong>本地 fastembed</strong>：模型随应用打包、纯 CPU、离线可用，
        无需安装 Ollama 或 torch。云端嵌入是可选的降级路径。
      </p>

      <div class="grid">
        <label class="field">
          <span class="label">模式</span>
          <select v-model="settings.form.embeddingMode">
            <option value="local_fastembed">本地 fastembed（推荐）</option>
            <option value="cloud_api">云端 API</option>
            <option value="none">不使用嵌入</option>
          </select>
          <span class="hint">
            本地模型：<code>{{ settings.localEmbeddingModelId || '—' }}</code>
          </span>
        </label>

        <template v-if="settings.form.embeddingMode === 'cloud_api'">
          <label class="field">
            <span class="label">Model ID</span>
            <input v-model="settings.form.embeddingModelId" placeholder="text-embedding-3-small" />
          </label>
          <label class="field wide">
            <span class="label">BaseURL</span>
            <input v-model="settings.form.embeddingBaseUrl" placeholder="https://api.openai.com/v1" />
          </label>
          <label class="field wide">
            <span class="label">API Key</span>
            <input
              v-model="settings.form.embeddingApiKey"
              type="password"
              placeholder="留空则保持当前值不变"
              autocomplete="new-password"
            />
          </label>
        </template>
      </div>

      <div class="actions">
        <button class="primary" type="submit" :disabled="settings.saving">
          {{ settings.saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </form>

    <section class="card muted">
      <p class="card-title">存储位置</p>
      <dl class="kv">
        <div class="wide">
          <dt>配置文件</dt>
          <dd class="mono">{{ settings.savingPath || settings.current?.configPath || '—' }}</dd>
        </div>
        <div class="wide">
          <dt>数据目录</dt>
          <dd class="mono">与 SQLite 同级（由 Electron 以 <code>--data-dir</code> 传入）</dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.shell {
  max-width: 760px;
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

.alert {
  margin: 0;
  padding: 11px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
}
.alert.bad {
  background: var(--bad-soft);
  color: var(--bad);
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 22px;
}
.card.muted {
  background: transparent;
}

.card-title {
  margin: 0 0 6px;
  font-size: 14.5px;
  font-weight: 620;
}

.note {
  margin: 0 0 16px;
  font-size: 12.5px;
  color: var(--fg-dim);
  line-height: 1.7;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.field.wide {
  grid-column: 1 / -1;
}

.label {
  font-size: 12.5px;
  font-weight: 560;
  display: flex;
  align-items: center;
  gap: 8px;
}

.tag {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--chip);
  color: var(--fg-dim);
}
.tag.ok {
  background: var(--ok-soft);
  color: var(--ok);
}

input,
select {
  font: inherit;
  font-size: 13px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  width: 100%;
  min-width: 0;
}
input:focus,
select:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
  border-color: transparent;
}

.hint {
  font-size: 11.5px;
  color: var(--fg-dim);
  line-height: 1.5;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
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
button:hover:not(:disabled) {
  border-color: var(--fg-dim);
}
button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
button.danger {
  color: var(--bad);
  border-color: var(--bad-border);
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

.kv {
  margin: 12px 0 0;
  display: grid;
  gap: 8px;
}
.kv > div {
  display: flex;
  justify-content: space-between;
  gap: 14px;
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
</style>
