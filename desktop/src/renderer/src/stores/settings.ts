/**
 * 设置状态（Pinia）：读 / 存 / 探测三条链路的**唯一入口**（票 07）。
 *
 * 分工：
 * - `api/settings.ts`：桥接与纯逻辑（掩码判断、BaseURL 提示）；
 * - 本文件：草稿、脏标记、保存与探测的时序（`save()` 成功后自动探测一次）；
 * - `views/Settings.vue`：只渲染与收集输入。
 *
 * 三条硬纪律（票 07 的要求，都有后端断言兜底）：
 * 1. **Key 栏永远是空的密码框**：读回来的掩码只是状态文案，绝不回填到输入框；
 * 2. 没动过 Key 栏（或用户把掩码粘回来）→ 提交空串 = 后端「保留已存 Key」；
 *    删除只能通过显式的「清除已保存的 Key」；
 * 3. 保存与探测解耦：探测失败**不影响**保存（离线/校园网场景仍要能存配置），
 *    探测结果一字不改地显示出来，不静默吞掉。
 */

import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import {
  baseUrlHint,
  keyStatusText,
  looksLikeKeyMask,
  normalizeBaseUrlInput,
  resolveSettingsBridge,
  type EmbeddingMode,
  type LlmConfigInput,
  type ProbeResult,
  type SettingsSnapshot,
  type SettingsUpdateRequest
} from '../api/settings'

/** LLM 四项（供应商名称 / BaseURL / APIKey / ModelID，全部自填）。 */
export interface LlmDraft {
  providerName: string
  baseUrl: string
  apiKey: string
  modelId: string
}

/** 嵌入配置草稿（`mode` 三选一；`cloud_api` 时才有后三项）。 */
export interface EmbeddingDraft {
  mode: EmbeddingMode
  baseUrl: string
  apiKey: string
  modelId: string
}

export const useSettingsStore = defineStore('settings', () => {
  // ------------------------------------------------------------- 状态 --
  /** 磁盘上的真实值（Key 只有掩码）——「已保存」的基准。 */
  const snapshot = ref<SettingsSnapshot | null>(null)
  /** LLM 草稿（`apiKey` 默认空串：掩码不回填）。 */
  const draft = reactive<LlmDraft>({ providerName: '', baseUrl: '', apiKey: '', modelId: '' })
  /** 嵌入草稿。 */
  const embedding = reactive<EmbeddingDraft>({
    mode: 'local_fastembed',
    baseUrl: '',
    apiKey: '',
    modelId: ''
  })

  const llmKeyTouched = ref(false)
  const llmKeyCleared = ref(false)
  const embeddingKeyTouched = ref(false)
  const embeddingKeyCleared = ref(false)

  const loading = ref(false)
  const saving = ref(false)
  const probing = ref(false)
  /** 设置通道未接线时的可读提示（票 07 与主进程接线并行，缺通道不能白屏）。 */
  const bridgeError = ref<string | null>(null)
  /** 读/存失败的可读原因。 */
  const errorText = ref<string | null>(null)
  /** 保存成功等正向提示。 */
  const notice = ref<string | null>(null)
  /** 最近一次探测结果（成功或失败都显示，不静默吞掉）。 */
  const probe = ref<ProbeResult | null>(null)
  const probeAt = ref<string | null>(null)

  // ------------------------------------------------------------- 派生 --
  const hasStoredKey = computed(() => snapshot.value?.llm.hasKey ?? false)
  const keyStatus = computed(() => keyStatusText(hasStoredKey.value, snapshot.value?.llm.apiKey ?? ''))
  const keyStatusHint = computed(() =>
    llmKeyCleared.value
      ? '保存后删除已存 Key'
      : llmKeyTouched.value
        ? '保存后覆盖为这次填写的内容'
        : hasStoredKey.value
          ? '留空则继续使用已保存的 Key'
          : '尚未配置 API Key'
  )
  const baseUrlHintText = computed(() => baseUrlHint(draft.baseUrl))
  const embeddingKeyStatus = computed(() =>
    keyStatusText(snapshot.value?.embedding.hasKey ?? false, snapshot.value?.embedding.apiKey ?? '')
  )
  const busy = computed(() => loading.value || saving.value || probing.value)

  /** 草稿是否与磁盘一致（不一致才需要保存）。 */
  const dirty = computed(() => {
    const saved = snapshot.value
    if (saved === null) return false
    return (
      draft.providerName.trim() !== saved.llm.providerName ||
      normalizeBaseUrlInput(draft.baseUrl) !== saved.llm.baseUrl ||
      draft.modelId.trim() !== saved.llm.modelId ||
      llmKeyTouched.value ||
      llmKeyCleared.value ||
      embedding.mode !== saved.embedding.mode ||
      normalizeBaseUrlInput(embedding.baseUrl) !== (saved.embedding.baseUrl ?? '') ||
      (embedding.modelId.trim() || '') !== (saved.embedding.modelId ?? '') ||
      embeddingKeyTouched.value ||
      embeddingKeyCleared.value
    )
  })

  const probeTone = computed<'ok' | 'fail' | null>(() =>
    probe.value === null ? null : probe.value.ok ? 'ok' : 'fail'
  )

  // ------------------------------------------------------------- 动作 --
  /** 读设置（进设置页时调用；失败也不抛，界面显示可读原因）。 */
  async function load(): Promise<void> {
    const lookup = resolveSettingsBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }

    bridgeError.value = null
    loading.value = true
    errorText.value = null
    try {
      const result = await lookup.bridge.readSettings()
      if (!result.ok) {
        errorText.value = result.message
        return
      }
      fillFromSnapshot(result.data)
      notice.value = null
    } catch (error) {
      errorText.value = `读取设置失败：${describeError(error)}`
    } finally {
      loading.value = false
    }
  }

  /**
   * 保存设置，**成功后自动探测一次**（`probeAfter: false` 可跳过）。
   *
   * 返回是否保存成功（供界面决定要不要提示）。探测结果放在 `probe` 里，失败也照样显示。
   */
  async function save(options: { probeAfter?: boolean } = {}): Promise<boolean> {
    const lookup = resolveSettingsBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return false
    }

    saving.value = true
    errorText.value = null
    try {
      const result = await lookup.bridge.saveSettings(buildUpdatePayload())
      if (!result.ok) {
        errorText.value = result.message
        return false
      }

      fillFromSnapshot(result.data)
      notice.value = `已保存到本地配置文件（${result.data.llm.providerName} · ${result.data.llm.modelId}）`
      if (options.probeAfter !== false) {
        await probeNow()
      }
      return true
    } catch (error) {
      errorText.value = `保存失败：${describeError(error)}`
      return false
    } finally {
      saving.value = false
    }
  }

  /** 只探测不保存（探测的是当前草稿，即「保存后会用的那份配置」）。 */
  async function probeNow(): Promise<void> {
    const lookup = resolveSettingsBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }

    probing.value = true
    errorText.value = null
    try {
      const result = await lookup.bridge.probeSettings({ llm: buildLlmPayload() })
      probe.value = result.ok ? result.data : { ok: false, message: result.message }
    } catch (error) {
      probe.value = { ok: false, message: `探测请求失败：${describeError(error)}` }
    } finally {
      probeAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      probing.value = false
    }
  }

  /** 标记「保存时删除已存的 LLM Key」（唯一能让 Key 变空的入口）。 */
  function clearStoredKey(): void {
    llmKeyCleared.value = true
    llmKeyTouched.value = false
    draft.apiKey = ''
  }

  function clearStoredEmbeddingKey(): void {
    embeddingKeyCleared.value = true
    embeddingKeyTouched.value = false
    embedding.apiKey = ''
  }

  /** 用户在这一栏敲了字（`v-model` 之外显式调用，避免把掩码回填当成「改过」）。 */
  function markKeyEdited(): void {
    llmKeyTouched.value = true
    llmKeyCleared.value = false
  }

  function markEmbeddingKeyEdited(): void {
    embeddingKeyTouched.value = true
    embeddingKeyCleared.value = false
  }

  /** 丢弃草稿，回到上次读到/保存的值。 */
  function resetDraft(): void {
    if (snapshot.value === null) return
    fillFromSnapshot(snapshot.value)
    errorText.value = null
    notice.value = null
    probe.value = null
    probeAt.value = null
  }

  // ------------------------------------------------------------- 内部 --
  /** 落库 / 回显的基准值（Key 栏清空，掩码只做状态文案）。 */
  function fillFromSnapshot(data: SettingsSnapshot): void {
    snapshot.value = data

    draft.providerName = data.llm.providerName
    draft.baseUrl = data.llm.baseUrl
    draft.modelId = data.llm.modelId
    draft.apiKey = ''
    llmKeyTouched.value = false
    llmKeyCleared.value = false

    embedding.mode = data.embedding.mode
    embedding.baseUrl = data.embedding.baseUrl ?? ''
    embedding.modelId = data.embedding.modelId ?? ''
    embedding.apiKey = ''
    embeddingKeyTouched.value = false
    embeddingKeyCleared.value = false
  }

  /** LLM 入参（Key 的去留见 `submitKey`）。 */
  function buildLlmPayload(clear = true): LlmConfigInput {
    return {
      providerName: draft.providerName.trim(),
      baseUrl: normalizeBaseUrlInput(draft.baseUrl),
      apiKey: submitKey(draft.apiKey, llmKeyTouched.value),
      modelId: draft.modelId.trim(),
      clearApiKey: clear ? llmKeyCleared.value : false
    }
  }

  function buildUpdatePayload(): SettingsUpdateRequest {
    return {
      llm: buildLlmPayload(),
      embedding: {
        mode: embedding.mode,
        baseUrl: normalizeBaseUrlInput(embedding.baseUrl) === '' ? null : normalizeBaseUrlInput(embedding.baseUrl),
        // ⚠️ 嵌入这一栏切 mode 时不要顺手清掉云端地址/模型：后端对 null 的语义是「保留原值」。
        apiKey: submitKey(embedding.apiKey, embeddingKeyTouched.value),
        modelId: embedding.modelId.trim() === '' ? null : embedding.modelId.trim(),
        clearApiKey: embeddingKeyCleared.value
      }
    }
  }

  /**
   * 提交给后端的 Key 值。
   *
   * 空格 / 掩码 / 纯符号 = 「未修改」→ 交空串（后端语义：保留已存 Key）。
   * **绝不把掩码写回磁盘** —— 那会把真 Key 抹掉（票 07 的自测项）。
   */
  function submitKey(value: string, touched: boolean): string {
    if (!touched || looksLikeKeyMask(value)) return ''
    return value.trim()
  }

  return {
    snapshot,
    draft,
    embedding,
    loading,
    saving,
    probing,
    busy,
    bridgeError,
    errorText,
    notice,
    probe,
    probeAt,
    probeTone,
    hasStoredKey,
    keyStatus,
    keyStatusHint,
    keyCleared: llmKeyCleared,
    embeddingKeyStatus,
    baseUrlHintText,
    dirty,
    load,
    save,
    probeNow,
    clearStoredKey,
    clearStoredEmbeddingKey,
    markKeyEdited,
    markEmbeddingKeyEdited,
    resetDraft
  }
})

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
