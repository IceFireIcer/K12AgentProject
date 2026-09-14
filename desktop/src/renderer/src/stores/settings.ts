/**
 * 设置状态（Pinia）。
 *
 * 与后端 `/api/settings` 的交互都在这里，组件只读状态、调 action。
 *
 * ⚠️ **API Key 的回显语义**（最容易写错的地方）：
 * 后端 GET 只回 `hasKey` + 掩码。表格里给用户看到的是掩码，但**提交时**：
 * - 用户没动 → 提交空串 → 后端保留原 key；
 * - 用户输入了新 key → 提交新值 → 覆盖。
 * 绝不能把掩码本身当作输入框的值提交（后端也会兜住，但那是第二道防线）。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { components } from '../../../shared/api-types'
import {
  BackendUnavailableError,
  UnauthorizedError,
  requestJson,
  type BackendEndpoint,
  type LlmConfig,
  type SettingsResponse
} from '../api/client'
import { useSidecarStore } from './sidecar'

type EmbeddingConfig = components['schemas']['EmbeddingConfig']
type SettingsUpdateRequest = components['schemas']['SettingsUpdateRequest']

/** 表单模型：API Key 单独放一个字段，避免和"已保存的掩码"混淆。 */
export interface SettingsForm {
  providerName: string
  baseUrl: string
  modelId: string
  /** 用户新输入的 key；留空 = 不修改。 */
  apiKeyInput: string
  embeddingMode: EmbeddingConfig['mode']
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModelId: string
}

function emptyForm(): SettingsForm {
  return {
    providerName: '',
    baseUrl: '',
    modelId: '',
    apiKeyInput: '',
    embeddingMode: 'local_fastembed',
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    embeddingModelId: ''
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const form = ref<SettingsForm>(emptyForm())
  /** 后端最近一次响应（含 hasKey / 掩码 / configPath），只读展示用。 */
  const current = ref<SettingsResponse | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const savingPath = ref('')
  const error = ref<string | null>(null)
  /** 保存成功的瞬时提示（几秒后自动清）。 */
  const notice = ref<string | null>(null)

  const embeddingMode = computed(() => form.value.embeddingMode)
  /** 本地嵌入模型（只读，随包分发）。 */
  const localEmbeddingModelId = computed(() => current.value?.embeddingModelId ?? '')

  /** 尚未保存的改动（用于提示"有未保存内容"）。 */
  const dirty = computed(() => {
    const saved = current.value
    if (!saved) return false
    const f = form.value
    return (
      f.providerName !== saved.llm.providerName ||
      f.baseUrl !== saved.llm.baseUrl ||
      f.modelId !== saved.llm.modelId ||
      f.apiKeyInput !== '' ||
      f.embeddingMode !== saved.embedding.mode ||
      f.embeddingBaseUrl !== (saved.embedding.baseUrl ?? '') ||
      f.embeddingModelId !== (saved.embedding.modelId ?? '') ||
      f.embeddingApiKey !== ''
    )
  })

  function endpoint(): BackendEndpoint {
    const sidecar = useSidecarStore()
    const info = sidecar.info
    if (!info?.port || !info.token) throw new BackendUnavailableError()
    return { port: info.port, token: info.token }
  }

  /** 把后端响应灌进表单（**掩码绝不进 apiKeyInput**）。 */
  function applyResponse(response: SettingsResponse): void {
    current.value = response
    form.value = {
      providerName: response.llm.providerName,
      baseUrl: response.llm.baseUrl,
      modelId: response.llm.modelId,
      apiKeyInput: '', // ★ 永远留空：留空 = 保留原值
      embeddingMode: response.embedding.mode,
      embeddingBaseUrl: response.embedding.baseUrl ?? '',
      embeddingApiKey: '',
      embeddingModelId: response.embedding.modelId ?? ''
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      applyResponse(await requestJson<SettingsResponse>(endpoint(), '/api/settings'))
    } catch (err) {
      error.value = describe(err)
    } finally {
      loading.value = false
    }
  }

  async function save(): Promise<boolean> {
    const f = form.value
    const llm: LlmConfig = {
      providerName: f.providerName.trim(),
      baseUrl: f.baseUrl.trim(),
      // 空串 = 不修改（后端语义），所以这里不做任何"填充掩码"的操作
      apiKey: f.apiKeyInput,
      modelId: f.modelId.trim()
    }
    const embedding: EmbeddingConfig = {
      mode: f.embeddingMode,
      baseUrl: f.embeddingBaseUrl.trim() || null,
      apiKey: f.embeddingApiKey || null,
      modelId: f.embeddingModelId.trim() || null
    }
    // clearApiKey 显式写 false：契约里它有默认值，但语义上"普通保存"和"清空"
    // 是两条路径，写出来比依赖默认值更难改错。
    const payload: SettingsUpdateRequest = { llm, embedding, clearApiKey: false }

    saving.value = true
    error.value = null
    notice.value = null
    try {
      const response = await requestJson<SettingsResponse>(endpoint(), '/api/settings', {
        method: 'PUT',
        body: payload
      })
      applyResponse(response)
      savingPath.value = response.configPath
      notice.value = '已保存'
      return true
    } catch (err) {
      error.value = describe(err)
      return false
    } finally {
      saving.value = false
    }
  }

  /** 显式清除 API Key（后端 `clearApiKey`）。 */
  async function clearApiKey(): Promise<void> {
    const f = form.value
    const payload: SettingsUpdateRequest = {
      llm: {
        providerName: f.providerName.trim(),
        baseUrl: f.baseUrl.trim(),
        apiKey: '',
        modelId: f.modelId.trim()
      },
      embedding: {
        mode: f.embeddingMode,
        baseUrl: f.embeddingBaseUrl.trim() || null,
        apiKey: null,
        modelId: f.embeddingModelId.trim() || null
      },
      clearApiKey: true
    }
    saving.value = true
    error.value = null
    try {
      const response = await requestJson<SettingsResponse>(endpoint(), '/api/settings', {
        method: 'PUT',
        body: payload
      })
      applyResponse(response)
      notice.value = '已清除 API Key'
    } catch (err) {
      error.value = describe(err)
    } finally {
      saving.value = false
    }
  }

  function reset(): void {
    form.value = emptyForm()
    error.value = null
    notice.value = null
  }

  return {
    form,
    current,
    loading,
    saving,
    savingPath,
    error,
    notice,
    dirty,
    embeddingMode,
    localEmbeddingModelId,
    load,
    save,
    clearApiKey,
    reset
  }
})

function describe(err: unknown): string {
  if (err instanceof UnauthorizedError || err instanceof BackendUnavailableError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
