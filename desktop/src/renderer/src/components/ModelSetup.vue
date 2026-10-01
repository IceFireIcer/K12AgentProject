<script setup lang="ts">
/**
 * 模型接入表单：供应商 / BaseURL / Model ID / Key + **真实连通性探测**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么两处共用同一份（设置页 + 首次进入的账号门）
 * ══════════════════════════════════════════════════════════════════════════
 * 同一件事（把模型接上并真连一次）写在两处，迟早分叉：一处补了候选模型、另一处没有；
 * 一处改了校验、另一处还在放行。本仓在这类「两处各写一份」上有过前科，所以这里只留一份。
 *
 * ★ 两处的差异**只有文案与动作排布**，都用 props / 插槽表达，不在组件里分叉：
 *   · `saveLabel`   —— 账号门叫「保存并测试」，设置页叫「保存并生效」；
 *   · `showPrimary` —— 设置页自己有整排动作（放弃修改 / 仅探测 / 仅保存 / 保存并生效），
 *                     所以传 `false`，动作经 `#actions` 插槽进来；账号门用内置那一个；
 *   · `showRawDetail` —— 服务端原始回执只给排障的人看（设置页）；账号门不展示。
 *
 * ★ 组件自己不读页面级的横幅：`showStatus` 打开时它把读/存的失败与成功就地渲染一行
 *   （账号门没有设置页那条横幅），设置页保持 `false` 用页面横幅，不会出现两遍。
 *
 * ⚠️ 文案纪律：组件可能渲染在**学生第一次进入**的那一屏，所以这里的说明一律用学生话
 *   （「服务地址」而不是运维口径的词），且不用破折号连接句子。字段名（BaseURL / API Key）
 *   是契约里就有的技术名，改动它会让设置页与赛题要求对不上。
 */
import { computed, ref } from 'vue'
import { Eye, EyeOff, KeyRound } from 'lucide-vue-next'
import { MANUAL_PRESET_ID } from '../api/settings'
import { useDemoSeedStore } from '../stores/demoSeed'
import { useSettingsStore } from '../stores/settings'

const props = withDefaults(
  defineProps<{
    /** 内置主行动的文案（保存并探测）。 */
    saveLabel?: string
    /** 是否渲染内置主行动（设置页传 false，用自己的动作行）。 */
    showPrimary?: boolean
    /** 是否渲染「技术详情」（服务端原始回执）。 */
    showRawDetail?: boolean
    /** 是否就地渲染读/存的成功与失败（没有页面横幅的调用方传 true）。 */
    showStatus?: boolean
  }>(),
  { saveLabel: '保存并生效', showPrimary: true, showRawDetail: true, showStatus: false }
)

const settings = useSettingsStore()
const demoSeed = useDemoSeedStore()

/** Key 栏的明文/掩码切换（默认掩码，从不回填）。 */
const showKey = ref(false)

/** 预设下拉的说明（读目录 / 读失败 / 读到了几家，三种都说清）。 */
const presetHint = computed(() => {
  if (settings.loadingCatalog) return '正在读取内置的供应商目录…'
  if (settings.catalogError) return settings.catalogError
  if (settings.catalog.length === 0) {
    return '没有读到内置的供应商清单，可以在下面手动填写。'
  }
  return (
    `已读到内置的 ${settings.catalog.length} 个供应商：选一个会自动带出地址与常见模型，` +
    '也可以停在「手动填写」自己填。'
  )
})

/**
 * 探测结论的**一句话白话**（给不懂状态码的人看）。
 *
 * ★ 后端那句原文是排障文案（带地址与状态码），一个学生读到只会以为出了问题：
 *   这里把同一份结果再表述一次，原文只放在「技术详情」里，一个字不改。
 * ★ 判据从原文里**取事实**（模型个数 / 状态码），取不到就说「连通正常」——
 *   不编一个具体数字出来。
 */
const probeSummary = computed(() => {
  const result = settings.probe
  if (result === null) return ''
  if (!result.ok) {
    return props.showRawDetail
      ? '还没连通。具体原因和改法在下面的「技术详情」里。'
      : '还没连通。检查一下上面填的内容，或者稍后再试。'
  }
  const models = /可见模型\s*(\d+)\s*个/.exec(result.message)
  if (models) return `连通正常（这个地址上有 ${models[1]} 个模型可用）`
  const http = /返回 HTTP\s*(\d{3})/.exec(result.message)
  if (http) return `连通正常（对方返回 HTTP ${http[1]}）`
  return '连通正常'
})

/** 探测结果的标题（与后端文案同一个词，不要改）。 */
const probeTitle = computed(() => (settings.probe?.ok ? '连通成功' : '未能连通'))

function onPresetChange(event: Event): void {
  const target = event.target
  if (target instanceof HTMLSelectElement) settings.applyPreset(target.value)
}

/** 内置主行动：保存（成功即自动探测一次，回执与结论都留在 store 里）。 */
async function runSave(): Promise<void> {
  await settings.save()
}

function runFetchModels(): void {
  void settings.fetchModels()
}
</script>

<template>
  <div class="setup" data-testid="model-setup">
    <el-form label-position="top" class="form">
      <el-form-item label="供应商预设（内置目录）">
        <select
          class="pick"
          data-testid="settings-llm-preset"
          :value="settings.presetValue"
          @change="onPresetChange"
        >
          <option :value="MANUAL_PRESET_ID">手动填写（自己填地址与模型）</option>
          <option v-for="preset in settings.catalog" :key="preset.id" :value="preset.id">
            {{ preset.label }}
          </option>
        </select>
        <p class="hint" data-testid="settings-preset-hint">{{ presetHint }}</p>
      </el-form-item>

      <el-form-item label="Provider ID（进 Pi）">
        <el-input
          v-model="settings.draft.providerId"
          data-testid="settings-llm-providerid"
          placeholder="deepseek"
        />
        <p class="hint">
          决定用哪份 provider 定义。自定义或校内网关请自取一个 id（如 <code>custom</code>），
          并在 Pi 的 <code>models[]</code> 里声明模型，否则该供应商下一个模型都没有。
        </p>
      </el-form-item>

      <el-form-item label="供应商名称（仅显示）">
        <el-input
          v-model="settings.draft.providerName"
          data-testid="settings-llm-provider"
          placeholder="DeepSeek"
        />
        <p class="hint">只用于界面与排查，不参与任何调用逻辑。</p>
      </el-form-item>

      <el-form-item label="BaseURL">
        <el-input
          v-model="settings.draft.baseUrl"
          data-testid="settings-llm-baseurl"
          placeholder="https://api.deepseek.com"
        />
        <p class="hint" data-testid="settings-baseurl-hint">{{ settings.baseUrlHintText }}</p>
      </el-form-item>

      <el-form-item label="Model ID">
        <el-input
          v-model="settings.draft.modelId"
          data-testid="settings-llm-modelid"
          placeholder="deepseek-v4-flash"
        />
        <p class="hint">
          必须是该 provider 模型目录里<strong>真实存在</strong>的 id。
          DeepSeek 目录里只有 <code>deepseek-v4-flash</code> / <code>-vision-exp</code> /
          <code>-pro</code>；填错会让首轮对话直接报「找不到模型」。
        </p>
      </el-form-item>

      <el-form-item label="候选模型">
        <div class="cands">
          <div class="cands__head">
            <el-button
              size="small"
              data-testid="settings-fetch-models"
              :loading="settings.fetching"
              :disabled="settings.busy || demoSeed.seeded"
              @click="runFetchModels"
            >
              拉取模型清单
            </el-button>
            <span class="cands__note">从当前地址实时拉取，并与内置清单合并。</span>
            <span v-if="demoSeed.seeded" class="cands__note" data-testid="settings-outbound-off">
              当前状态下这一项先不用动。
            </span>
          </div>
          <p v-if="settings.fetched" class="hint" data-testid="settings-fetch-message">
            {{ settings.fetched.message }}
          </p>
          <ul
            v-if="settings.candidatesOpen && settings.modelCandidates.length > 0"
            class="cands__list"
            data-testid="settings-model-candidates"
          >
            <li v-for="id in settings.modelCandidates" :key="id">
              <button
                type="button"
                class="chip"
                :class="{ 'chip--on': settings.draft.modelId === id }"
                :data-testid="`settings-model-candidate-${id}`"
                @click="settings.chooseModel(id)"
              >
                {{ id }}
              </button>
            </li>
          </ul>
        </div>
      </el-form-item>

      <el-form-item label="API Key">
        <div class="row-inline">
          <el-input
            v-model="settings.draft.apiKey"
            data-testid="settings-llm-apikey"
            :type="showKey ? 'text' : 'password'"
            autocomplete="new-password"
            :placeholder="settings.hasStoredKey ? '已保存（留空则不修改）' : '请输入 API Key'"
            @input="settings.markKeyEdited()"
          />
          <el-button text :title="showKey ? '隐藏' : '显示'" @click="showKey = !showKey">
            <component :is="showKey ? EyeOff : Eye" :size="16" />
          </el-button>
        </div>
        <p class="key-row">
          <span class="key-state" data-testid="settings-key-status">{{ settings.keyStatus }}</span>
          <span class="key-hint">{{ settings.keyStatusHint }}</span>
          <span v-if="settings.keyCleared" class="key-cleared" data-testid="settings-key-cleared">
            保存后将删除已存的 Key
          </span>
          <el-button
            text
            size="small"
            data-testid="settings-clear-key"
            :disabled="settings.busy || !settings.hasStoredKey"
            @click="settings.clearStoredKey()"
          >
            清除已保存的 Key
          </el-button>
        </p>
        <p class="hint">
          <KeyRound :size="12" class="hint__ico" />
          Key 仅存本机（<code>config.json</code>），不进日志、也进不了渲染进程；
          这一栏从头到尾只拿得到掩码，明文只有主进程能读。
        </p>
      </el-form-item>
    </el-form>

    <div v-if="settings.probing" class="probe probe--pending" data-testid="settings-probe-pending">
      正在向这个地址发起一次真实请求…
    </div>
    <div
      v-else-if="settings.probe"
      class="probe"
      :class="settings.probe.ok ? 'probe--ok' : 'probe--fail'"
      data-testid="settings-probe-result"
      :data-ok="String(settings.probe.ok)"
    >
      <p class="probe__title" data-testid="settings-probe-title">
        {{ probeTitle }}
        <span class="probe__at">探测于 {{ settings.probeAt }}</span>
      </p>
      <p class="probe__msg" data-testid="settings-probe-summary">{{ probeSummary }}</p>
      <details v-if="showRawDetail" class="tech">
        <summary class="tech__sum" data-testid="settings-probe-raw-summary">
          技术详情（服务端原始回执）
        </summary>
        <p class="probe__msg" data-testid="settings-probe-message">{{ settings.probe.message }}</p>
      </details>
    </div>

    <p v-if="showStatus && settings.errorText" class="status status--bad" data-testid="model-setup-error">
      {{ settings.errorText }}
    </p>
    <p v-if="showStatus && settings.notice" class="status status--good" data-testid="model-setup-notice">
      {{ settings.notice }}
    </p>

    <div v-if="showPrimary" class="setup__actions">
      <button
        type="button"
        class="k12-cta setup__save"
        data-testid="model-setup-save"
        :disabled="settings.busy"
        @click="runSave"
      >
        {{ settings.saving ? '正在保存…' : saveLabel }}
      </button>
      <span class="cands__note">保存后会用你填的配置真连一次。</span>
    </div>

    <slot name="actions" />
  </div>
</template>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-3);
}
.form :deep(.el-form-item) {
  margin-bottom: 14px;
}
.form :deep(.el-form-item__label) {
  padding-bottom: 4px;
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.form :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}
.row-inline {
  display: flex;
  gap: 6px;
  width: 100%;
}
.hint {
  margin-top: 6px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.hint strong {
  color: var(--k12-fg);
  font-weight: 650;
}
.hint__ico {
  vertical-align: -2px;
  margin-right: 4px;
  color: var(--k12-muted);
}
.hint code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  padding: 1px 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.pick {
  width: 100%;
  padding: 7px 11px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg);
  font-family: inherit;
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-ui);
  cursor: pointer;
}
.cands {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.cands__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.cands__note {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.cands__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 4px 11px;
  /* 触控下限 28px（长模型名换行时要能撑高，所以用 min-height） */
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  border: 1px solid transparent;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chip:hover:not(:disabled) {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}
.chip:disabled {
  cursor: not-allowed;
  color: var(--k12-muted-2);
}
.chip--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
  font-weight: 650;
}
.key-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.key-state {
  padding: 2px 8px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.key-hint,
.key-cleared {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.key-cleared {
  color: var(--k12-warn);
  font-weight: 600;
}
.probe {
  padding: 9px 13px;
  border-radius: var(--k12-r-inset);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface-2);
}
.probe--ok {
  border-color: var(--k12-good-border);
  background: var(--k12-good-soft);
}
.probe--fail {
  border-color: var(--k12-warn-border);
  background: var(--k12-warn-soft);
}
.probe__title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.probe__msg {
  margin-top: 4px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.probe__at {
  font-weight: 500;
  color: var(--k12-muted);
}
.tech {
  border-top: 1px solid var(--k12-border);
  padding-top: 6px;
}
/* 折叠必须真的把内容收起来（作者样式优先级高于浏览器默认的 details 隐藏） */
.tech:not([open]) > :not(summary) {
  display: none;
}
.tech__sum {
  min-height: 28px;
  display: flex;
  align-items: center;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  cursor: pointer;
}
.status {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
}
.status--bad {
  color: var(--k12-bad);
}
.status--good {
  color: var(--k12-good);
}
.setup__actions {
  display: flex;
  align-items: center;
  gap: var(--k12-sp-3);
  flex-wrap: wrap;
}
/* 只补布局：颜色 / 圆角 / 五态全部由 .k12-cta 提供（不在这里抄第二份） */
.setup__save {
  flex: 1 1 auto;
}
</style>