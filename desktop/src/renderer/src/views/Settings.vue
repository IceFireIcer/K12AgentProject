<script setup lang="ts">
/**
 * 设置视图（票 07）：模型供应商四项自填 + 真实连通性探测 + 嵌入配置三选一。
 *
 * 链路（渲染进程不直连本地服务，也没有任何 HTTP 能力）：
 *   本视图 → `stores/settings.ts` → `window.api`（preload 白名单）
 *   → 主进程 IPC 处理器 → `PUT /api/settings` / `POST /api/settings/probe`
 *
 * 界面纪律（与票 07 的自测项一一对应）：
 * - **供应商名称 / BaseURL / APIKey / ModelID 全部可改**（需求硬性要求，不得写死某一家）；
 * - Key 是**密码框且永不回填掩码**：只显示「已配置 …abcd / 未配置」，留空即沿用已存 Key；
 * - 探测结果（成功或失败原因）内联展示，**失败也能保存**（离线场景）；
 * - BaseURL 的 `/v1` 差异写在输入框下面，不靠用户猜。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { EMBEDDING_MODE_LABELS, MANUAL_PRESET_ID, type EmbeddingMode } from '../api/settings'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { useSidecarStore } from '../stores/sidecar'
import { useStudyStore } from '../stores/study'

const sidecar = useSidecarStore()
const chat = useChatStore()
const settings = useSettingsStore()
const study = useStudyStore()

const EMBEDDING_MODES: readonly EmbeddingMode[] = ['local_fastembed', 'cloud_api', 'none']

const probeTitle = computed(() => (settings.probeAt ? `探测结果（${settings.probeAt}）` : '探测结果'))
const cloudEmbedding = computed(() => settings.embedding.mode === 'cloud_api')

 *
 *   各自写一份写路径的话，迟早出现「在设置页改了、顶栏指示器还显示旧值」——
 *   学生据此判断改没改成，一处不同步就等于告诉他没改成。
 * ★ 这里只传「学生选了什么」：生效逻辑（写库 + 冷却 10 轮）在服务端，前端不推断、不预判。
 */

  try {
  } finally {
  }
}

 *
 */

  try {
  } finally {
  }
}

/**
 */
watch(
  (level, previous) => {
  }
)

/**
 * 预设下拉下面的说明：三种状态各说各的，**不要一句话打天下**。
 *   - 目录还在读 → 说清「正在读什么」，而不是让下拉空着看起来像坏了；
 *   - 目录读失败 → 给可读原因并明说「手填不受影响」（预设只是便利，不是前置条件）；
 *   - 正常 → 告诉用户预设会带出哪些字段（端点与模型名，不含 Key）。
 */
const presetHintText = computed(() => {
  if (settings.catalogError) {
    return `${settings.catalogError}（可以继续手填 BaseURL 与 ModelID，功能不受影响。）`
  }
  if (settings.loadingCatalog) return '正在读取 Pi 内置的供应商清单…'
  if (settings.catalog.length === 0) return '没有读到 Pi 内置预设：请手动填写下面的 BaseURL、ModelID 与供应商 ID。'
  return `共 ${settings.catalog.length} 个内置预设。选中会把端点地址与首选模型名带出来（Key 不会被动）。`
})

onMounted(() => {
  // 两条并行：设置的读写与预设清单互不依赖，谁先回来都能先渲染
  void settings.load()
  void settings.loadCatalog()
})
</script>

<template>
  <section class="settings" data-testid="settings-view">
    <header class="head">
      <h2 class="title">设置</h2>
      <span class="chip chip--accent">本地保存 · 真实探测</span>
      <span v-if="settings.dirty" class="chip chip--warn" data-testid="settings-dirty">有未保存的修改</span>
    </header>

    <p class="lead">
      模型供应商四项都可以自己填（不锁定任何一家）：填完点「保存并探测」，应用会<strong>真的</strong>去调一次该地址，
      把成功或失败原因显示在下面。配置只存在这台电脑上，API Key 不外传、不写日志、界面上永远只显示掩码。
    </p>

    <p v-if="settings.bridgeError" class="notice notice--warn" data-testid="settings-bridge-missing">
      {{ settings.bridgeError }}
    </p>
    <p v-if="settings.errorText" class="notice notice--danger" data-testid="settings-error">
      {{ settings.errorText }}
    </p>
    <p v-if="settings.notice" class="notice notice--ok" data-testid="settings-notice">
      {{ settings.notice }}
    </p>

    <!-- ─────────────────────────── 模型供应商 ─────────────────────────── -->
    <form class="card" data-testid="settings-llm" @submit.prevent="settings.save()">
      <h3 class="card__title">模型供应商</h3>
      <p class="card__lead">
        可以从预设里挑一个（端点地址与模型清单都是现成的），也可以完全手填。四项都自填，
        不锁定任何一家服务。
      </p>

      <div class="field">
        <label class="field__label" for="llm-preset">供应商预设</label>
        <select
          id="llm-preset"
          class="field__input"
          data-testid="settings-llm-preset"
          :value="settings.presetValue"
          :disabled="settings.busy || settings.catalog.length === 0"
          @change="settings.applyPreset(($event.target as HTMLSelectElement).value)"
        >
          <option :value="MANUAL_PRESET_ID">手动填写（自己填端点与模型名）</option>
          <option v-for="preset in settings.catalog" :key="preset.id" :value="preset.id">
            {{ preset.label }}（{{ preset.models.length }} 个模型）
          </option>
        </select>
        <p class="field__hint" data-testid="settings-preset-hint">
          {{ presetHintText }}
        </p>
      </div>

      <div class="field">
        <label class="field__label" for="llm-providerid">供应商 ID</label>
        <input
          id="llm-providerid"
          v-model="settings.draft.providerId"
          class="field__input"
          data-testid="settings-llm-providerid"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="例如 deepseek / openai / custom"
        />
        <p class="field__hint">
          这一项<strong>真正决定用哪一套接入方式</strong>（认证、模型目录、协议）：预设会替你填好，
          自建/校内网关填你自己的 id（例如 <code>custom</code>）即可，字母数字与短横线最稳。
        </p>
      </div>

      <div class="field">
        <label class="field__label" for="llm-provider">供应商名称</label>
        <input
          id="llm-provider"
          v-model="settings.draft.providerName"
          class="field__input"
          data-testid="settings-llm-provider"
          type="text"
          autocomplete="off"
          placeholder="例如 DeepSeek / 校内网关 / 自建服务"
        />
        <p class="field__hint">仅用于显示与排查，填什么都行。</p>
      </div>

      <div class="field">
        <label class="field__label" for="llm-baseurl">BaseURL</label>
        <input
          id="llm-baseurl"
          v-model="settings.draft.baseUrl"
          class="field__input"
          data-testid="settings-llm-baseurl"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="https://api.deepseek.com/v1"
        />
        <p class="field__hint" data-testid="settings-baseurl-hint">{{ settings.baseUrlHintText }}</p>
      </div>

      <div class="field">
        <label class="field__label" for="llm-apikey">APIKey</label>
        <div class="field__row">
          <input
            id="llm-apikey"
            v-model="settings.draft.apiKey"
            class="field__input"
            data-testid="settings-llm-apikey"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            :placeholder="settings.hasStoredKey ? '留空则继续使用已保存的 Key' : '粘贴你的 API Key'"
            @input="settings.markKeyEdited()"
          />
          <span
            class="chip"
            :class="settings.hasStoredKey ? 'chip--ok' : 'chip--warn'"
            data-testid="settings-key-status"
          >
            {{ settings.keyStatus }}
          </span>
        </div>
        <p class="field__hint">{{ settings.keyStatusHint }}；Key 只写进本机的配置文件，读回来永远是掩码。</p>
        <button
          v-if="settings.hasStoredKey"
          class="btn btn--danger btn--small"
          type="button"
          data-testid="settings-clear-key"
          @click="settings.clearStoredKey()"
        >
          清除已保存的 Key
        </button>
        <p v-if="settings.keyCleared" class="field__hint field__hint--warn" data-testid="settings-key-cleared">
          保存后已保存的 Key 会被删除（此操作不可撤销）。
        </p>
      </div>

      <div class="field">
        <label class="field__label" for="llm-modelid">ModelID</label>
        <div class="field__row">
          <input
            id="llm-modelid"
            v-model="settings.draft.modelId"
            class="field__input"
            data-testid="settings-llm-modelid"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="例如 deepseek-v4-flash"
          />
          <button
            class="btn btn--small"
            type="button"
            data-testid="settings-fetch-models"
            :disabled="settings.busy || settings.fetching"
            @click="settings.fetchModels()"
          >
            {{ settings.fetching ? '拉取中…' : '拉取模型' }}
          </button>
        </div>
        <p class="field__hint">
          必须是该地址支持的模型名。「拉取模型」会同时给你两份候选：该地址实际报出的清单，
          以及 Pi 内置目录里该供应商的模型（后者离线也在）。
        </p>

        <div
          v-if="settings.modelCandidates.length > 0 && settings.candidatesOpen"
          class="candidates"
          data-testid="settings-model-candidates"
        >
          <p class="candidates__head">
            候选模型（点击填入）
            <span v-if="settings.fetched" class="candidates__source">
              · {{ settings.fetched.ok ? '含端点实时结果' : '仅 Pi 内置预设' }}
            </span>
          </p>
          <div class="candidates__list">
            <button
              v-for="modelId in settings.modelCandidates"
              :key="modelId"
              class="chip chip--model"
              :class="{ 'chip--model-active': modelId === settings.draft.modelId.trim() }"
              type="button"
              :data-testid="`settings-model-candidate-${modelId}`"
              @click="settings.chooseModel(modelId)"
            >
              {{ modelId }}
            </button>
          </div>
          <p v-if="settings.fetched" class="candidates__note" data-testid="settings-fetch-message">
            {{ settings.fetched.message }}
          </p>
        </div>
      </div>

      <div class="actions">
        <button
          class="btn btn--primary"
          type="submit"
          data-testid="settings-save"
          :disabled="settings.busy"
        >
          {{ settings.saving ? '保存中…' : '保存并探测' }}
        </button>
        <button
          class="btn"
          type="button"
          data-testid="settings-save-only"
          :disabled="settings.busy"
          @click="settings.save({ probeAfter: false })"
        >
          仅保存
        </button>
        <button
          class="btn"
          type="button"
          data-testid="settings-probe"
          :disabled="settings.busy"
          @click="settings.probeNow()"
        >
          {{ settings.probing ? '探测中…' : '仅探测（不保存）' }}
        </button>
        <button
          class="btn"
          type="button"
          data-testid="settings-reset"
          :disabled="settings.busy || !settings.dirty"
          @click="settings.resetDraft()"
        >
          放弃修改
        </button>
      </div>

      <p class="actions__note">
        探测与保存是分开的：探测失败也能保存（断网、校园网受限时先存好，稍后再探测）。
      </p>

      <div
        v-if="settings.probe"
        class="probe"
        :class="settings.probe.ok ? 'probe--ok' : 'probe--fail'"
        data-testid="settings-probe-result"
      >
        <p class="probe__head">
          {{ probeTitle }} · {{ settings.probe.ok ? '连通成功' : '未能连通' }}
        </p>
        <p class="probe__body" data-testid="settings-probe-message">{{ settings.probe.message }}</p>
        <p v-if="!settings.probe.ok" class="probe__hint">
          这是失败原因，不是「配置保存失败」——你可以先保存，换好网络或用正确的地址后再探测。
        </p>
      </div>
      <p v-else-if="settings.probing" class="probe probe--pending" data-testid="settings-probe-pending">
        正在探测（最多几秒钟；超时会明确告诉你，不会一直等）。
      </p>
    </form>

    <!-- ─────────────────────────── 嵌入配置 ─────────────────────────── -->
    <section class="card" data-testid="settings-embedding">
      <h3 class="card__title">教材检索用的嵌入</h3>
      <p class="card__lead">
        检索默认用随安装包分发的本地模型（离线可跑、512 维）。也可以改成云端接口，或直接关掉嵌入。
      </p>

      <div
        v-for="mode in EMBEDDING_MODES"
        :key="mode"
        class="radio"
      >
        <input
          :id="`embedding-${mode}`"
          v-model="settings.embedding.mode"
          :data-testid="`settings-embedding-${mode}`"
          type="radio"
          :value="mode"
        />
        <label :for="`embedding-${mode}`">{{ EMBEDDING_MODE_LABELS[mode] }}</label>
      </div>

      <template v-if="cloudEmbedding">
        <div class="field">
          <label class="field__label" for="embedding-baseurl">嵌入接口地址</label>
          <input
            id="embedding-baseurl"
            v-model="settings.embedding.baseUrl"
            class="field__input"
            data-testid="settings-embedding-baseurl"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="https://api.example.com/v1"
          />
        </div>

        <div class="field">
          <label class="field__label" for="embedding-apikey">嵌入接口 APIKey</label>
          <div class="field__row">
            <input
              id="embedding-apikey"
              v-model="settings.embedding.apiKey"
              class="field__input"
              data-testid="settings-embedding-apikey"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              :placeholder="settings.embeddingKeyStatus === '未配置' ? '粘贴嵌入接口的 Key' : '留空则沿用已存的 Key'"
              @input="settings.markEmbeddingKeyEdited()"
            />
            <span class="chip" data-testid="settings-embedding-key-status">{{ settings.embeddingKeyStatus }}</span>
            <button
              v-if="settings.embeddingKeyStatus !== '未配置'"
              class="btn btn--danger btn--small"
              type="button"
              data-testid="settings-embedding-clear-key"
              @click="settings.clearStoredEmbeddingKey()"
            >
              清除
            </button>
          </div>
          <!-- ★ 与 LLM 那条同一口径（H10）：点「清除」必须立刻有可见反馈，
               否则 chip 仍写着「已配置 …abcd」，用户会以为没生效而反复点。 -->
          <p
            v-if="settings.embeddingKeyCleared"
            class="field__hint field__hint--warn"
            data-testid="settings-embedding-key-cleared"
          >
            保存后已保存的嵌入 Key 会被删除（此操作不可撤销）。
          </p>
        </div>

        <div class="field">
          <label class="field__label" for="embedding-modelid">嵌入模型 ID</label>
          <input
            id="embedding-modelid"
            v-model="settings.embedding.modelId"
            class="field__input"
            data-testid="settings-embedding-modelid"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="例如 bge-m3"
          />
        </div>
      </template>

      <p class="field__hint" data-testid="settings-embedding-hint">
        本地模型是 BAAI/bge-small-zh-v1.5（512 维）。切换模式不会清掉已填的云端地址与模型名，
        换回来时它们还在。
      </p>

      <div class="actions">
        <button
          class="btn btn--primary"
          type="button"
          data-testid="settings-embedding-save"
          :disabled="settings.busy"
          @click="settings.save({ probeAfter: false })"
        >
          保存嵌入配置
        </button>
      </div>
    </section>

         放在「本地数据服务」卡片**之前**：这是一项可操作的功能，不是诊断信息 ——
         埋在状态/端口/PID 中间会让需要它的学生根本找不到。
      <p class="field__hint">系统会根据你问的问题自动判断；你也可以自己指定，指定后 10 轮内系统不再自动改。</p>
        <button
          v-for="level in GRADE_LEVELS"
          :key="level"
          type="button"
        >
          {{ GRADE_LABELS[level] }}
        </button>
      </div>
           `data-active` 全为 false 是**对的**（不拿默认值冒充学生的选择）。 -->
      </p>
    </section>

      </p>

      </p>
      <template v-else>
        <p class="field__hint">
        </p>
        </p>
        <template v-else>
          </p>
            <button
              type="button"
            >
            </button>
          </div>
          <p
            class="field__hint"
          >
          </p>
        </template>

          <button
            type="button"
          >
          </button>
        </div>
      </template>

      </p>
      </p>
    </section>

    <!-- ──────────────────────── 本地服务与安全约定 ──────────────────────── -->
    <section class="card card--plain">
      <h3 class="card__title">本地数据服务</h3>
      <dl class="rows" data-testid="settings-sidecar">
        <div class="row">
          <dt>状态</dt>
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
          <dt>当前学段（系统自动判定，只读）</dt>
          <dd data-testid="settings-grade">{{ chat.currentGradeLabel ?? GRADE_UNKNOWN_LABEL }}</dd>
        </div>
      </dl>
      <p v-if="sidecar.errorText" class="notice notice--danger">{{ sidecar.errorText }}</p>
    </section>

    <section class="card card--plain">
      <h3 class="card__title">安全约定</h3>
      <ul class="safe__list">
        <li>设置由本地数据服务写进这台电脑的配置文件，界面上的 Key 永远是掩码（…abcd）。</li>
        <li>API Key 不上传、不进日志；留空提交不会删除已保存的 Key，删除必须显式点击。</li>
        <li>供应商四项全部可改，不锁定任何一家服务；BaseURL 带不带 /v1 都允许。</li>
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
  max-width: 760px;
}

.card {
  margin-top: 20px;
  padding: 18px 20px 20px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}

.card--plain {
  background: var(--surface-muted);
  box-shadow: none;
}

.card__title {
  font-size: 15px;
  font-weight: 650;
}

.card__lead {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-muted);
}

.field {
  margin-top: 16px;
}

.field__label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.field__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.field__input {
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface-muted);
  font: inherit;
  color: var(--text);
}

.field__row .field__input {
  flex: 1;
  min-width: 240px;
}

.field__input:focus {
  outline: 2px solid rgba(47, 111, 208, 0.35);
  outline-offset: 1px;
  background: var(--surface);
}

/* 下拉复用 `.field__input` 的外观；只需补上 select 的原生差异 */
select.field__input {
  cursor: pointer;
  appearance: auto;
}

select.field__input:disabled {
  cursor: not-allowed;
  color: var(--text-faint);
}

.field__hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-faint);
}

.field__hint--warn {
  color: var(--warn);
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 18px;
}

.actions__note {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-faint);
}

.btn--small {
  padding: 5px 12px;
  font-size: 13px;
}

.btn--danger {
  color: var(--danger);
  border-color: rgba(179, 38, 30, 0.3);
  background: var(--danger-soft);
}

.btn--danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.probe {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-muted);
  font-size: 13px;
  line-height: 1.8;
}

.probe--ok {
  background: var(--ok-soft);
  border-color: rgba(26, 127, 75, 0.24);
  color: var(--ok);
}

.probe--fail {
  background: var(--warn-soft);
  border-color: rgba(154, 100, 0, 0.28);
  color: var(--warn);
}

.probe--pending {
  color: var(--text-muted);
}

.probe__head {
  font-weight: 650;
}

.probe__body {
  margin-top: 4px;
  color: var(--text);
  word-break: break-word;
}

.probe__hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.radio {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 13px;
}

/* ── 候选模型（「拉取模型」的结果）──────────────────────────── */

.candidates {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border-strong);
  background: var(--surface-muted);
}

.candidates__head {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.candidates__source {
  font-weight: 400;
  color: var(--text-faint);
}

.candidates__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.candidates__note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-faint);
  word-break: break-word;
}

/* 可点击的模型 chip（复用 .chip 的底色，加上「可点」的交互与选中态） */
.chip--model {
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.chip--model:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.chip--model-active {
  border-color: rgba(47, 111, 208, 0.45);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.notice {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}

.notice--ok {
  background: var(--ok-soft);
  border: 1px solid rgba(26, 127, 75, 0.24);
  color: var(--ok);
}

.notice--warn {
  background: var(--warn-soft);
  border: 1px solid rgba(154, 100, 0, 0.24);
  color: var(--warn);
}

.notice--danger {
  background: var(--danger-soft);
  border: 1px solid rgba(179, 38, 30, 0.2);
  color: var(--danger);
}


  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--surface-muted);
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

  border-color: var(--accent);
  color: var(--accent);
}

  cursor: not-allowed;
  color: var(--text-faint);
}

/* 当前生效的那一档（含学生刚选中的）：与对话页顶栏的徽章同一视觉语言 */
  border-color: rgba(47, 111, 208, 0.45);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}


  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

  margin-top: 8px;
}

  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--surface-muted);
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

  border-color: var(--accent);
  color: var(--accent);
}

  cursor: not-allowed;
  color: var(--text-faint);
}

  border-color: rgba(47, 111, 208, 0.45);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}

.rows {
  margin-top: 12px;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
  font-size: 13px;
}

.row dt {
  color: var(--text-muted);
}

.row dd {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.safe__list {
  margin: 10px 0 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-muted);
}
</style>
