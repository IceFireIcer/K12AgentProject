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
  buildPresetOptions,
  findPresetById,
  keyStatusText,
  looksLikeKeyMask,
  MANUAL_PRESET_ID,
  normalizeBaseUrlInput,
  resolveSettingsBridge,
  selectedPresetId,
  type EmbeddingMode,
  type FetchModelsResult,
  type LlmConfigInput,
  type PresetOption,
  type ProbeResult,
  type SettingsSnapshot,
  type SettingsUpdateRequest
} from '../api/settings'
// ★ 异常 → 可读中文（含「连不上 sidecar」那一类：英文的 `fetch failed` 不许直出给用户）
import { describeClientError } from '../api/student-facing'

/**
 * LLM 四项（供应商 ID / 名称 / BaseURL / APIKey / ModelID，全部可改）。
 *
 * `providerId` 与 `providerName` 的分工（不要合并）：
 *   - `providerId`   进 Pi：决定用哪一份 provider 定义（认证 / 模型目录 / 协议），
 *                    内置预设（deepseek / openai / zai…）直接填它们的 id；
 *   - `providerName` **只用于显示与排查**，填什么都行。
 */
export interface LlmDraft {
  providerId: string
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
  const draft = reactive<LlmDraft>({
    providerId: '',
    providerName: '',
    baseUrl: '',
    apiKey: '',
    modelId: ''
  })
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

  // ---- Pi 内置供应商预设 / 拉取模型（票 07 补强：端点与模型名不用手输）--
  /** 预设清单（来自主进程读的 Pi 目录；离线可用）。 */
  const catalog = ref<PresetOption[]>([])
  const catalogError = ref<string | null>(null)
  const loadingCatalog = ref(false)
  /** 最近一次「拉取模型」的结果（两个来源分开存，界面如实标注）。 */
  const fetched = ref<FetchModelsResult | null>(null)
  const fetching = ref(false)
  /** 用户手动选中候选之外的值时把列表收起来（不猜、不强制）。 */
  const candidatesOpen = ref(true)

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

  /** 供应商预设下拉当前停在哪个值（找不到就停在「手动填写」）。 */
  const presetValue = computed(() => selectedPresetId(catalog.value, draft.providerId))
  /** 当前选中的预设（手动填写时为 `undefined`）。 */
  const activePreset = computed(() => findPresetById(catalog.value, draft.providerId))
  /** 候选模型：优先用拉取结果，否则用当前预设自带的清单。 */
  const modelCandidates = computed(() =>
    fetched.value ? fetched.value.candidates : (activePreset.value?.models ?? [])
  )
  /** 草稿是否与磁盘一致（不一致才需要保存）。 */
  const dirty = computed(() => {
    const saved = snapshot.value
    if (saved === null) return false
    return (
      draft.providerId.trim() !== saved.llm.providerId ||
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
      errorText.value = `读取设置失败：${describeClientError(error)}`
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
      // ★ 措辞点出「已生效」：主进程在保存成功后会热切换当前会话（失败则按新配置重建），
      //   所以不需要提示「重启后生效」—— 那会让用户以为没保存成功（实测踩到过这种误判）。
      notice.value = `已保存并生效（${result.data.llm.providerName} · ${result.data.llm.modelId}）`
      if (options.probeAfter !== false) {
        await probeNow()
      }
      return true
    } catch (error) {
      errorText.value = `保存失败：${describeClientError(error)}`
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
      probe.value = { ok: false, message: `探测请求失败：${describeClientError(error)}` }
    } finally {
      probeAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      probing.value = false
    }
  }

  /**
   * 读 Pi 内置供应商预设（进设置页时与 `load()` 并行调用）。
   *
   * 失败**不阻塞设置页**：预设只是「省去手输端点」的便利，拿不到就退化成纯手填
   * （`catalogError` 给一句可读原因，界面据此隐藏下拉）。
   */
  async function loadCatalog(): Promise<void> {
    const lookup = resolveSettingsBridge()
    if (!lookup.ready) return // 缺通道时 `load()` 已经报过可读原因，这里不重复刷屏

    loadingCatalog.value = true
    catalogError.value = null
    try {
      const result = await lookup.bridge.readProviderCatalog()
      if (!result.ok) {
        catalogError.value = result.message
        return
      }
      catalog.value = buildPresetOptions(result.data)
    } catch (error) {
      catalogError.value = `读取供应商预设失败：${describeClientError(error)}`
    } finally {
      loadingCatalog.value = false
    }
  }

  /**
   * 选中一个供应商预设：把端点与（第一个）模型名带出来。
   *
   * 三条刻意的取舍：
   *   - **Key 不动**（切供应商不该把你刚填的 Key 清掉 —— 有些人两家用同一把）；
   *   - `providerName` 一起带出来（它只用于显示，带上比留旧家的名字更不容易误读）；
   *   - `modelId` 用该预设的**第一个**模型（Pi 目录顺序即推荐程度），但用户随时能改。
   */
  function applyPreset(presetId: string): void {
    if (presetId === MANUAL_PRESET_ID) {
      // 「手动填写」不猜内容，只把草稿留在原地让用户自己改
      candidatesOpen.value = true
      return
    }
    const preset = findPresetById(catalog.value, presetId)
    if (!preset) return

    draft.providerId = preset.id
    if (preset.label.trim() !== '') draft.providerName = preset.label
    if (preset.baseUrl.trim() !== '') draft.baseUrl = preset.baseUrl
    if (preset.models.length > 0) draft.modelId = preset.models[0]
    // 切了预设，上一次的拉取结果就过期了（那份清单属于另一个端点）
    fetched.value = null
    candidatesOpen.value = true
  }

  /**
   * 拉取模型清单（端点实时 + Pi 预设合并）。
   *
   * 端点失败**不是**错误：主进程会把 Pi 预设清单照样返回，界面永远有候选可选。
   * 所以这里只在 IPC 通道本身失败（`ok: false`）时记 `errorText`。
   */
  async function fetchModels(): Promise<void> {
    const lookup = resolveSettingsBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }

    fetching.value = true
    errorText.value = null
    try {
      const result = await lookup.bridge.fetchProviderModels({ llm: buildLlmPayload() })
      if (!result.ok) {
        errorText.value = result.message
        return
      }
      fetched.value = result.data
      candidatesOpen.value = true
    } catch (error) {
      errorText.value = `拉取模型失败：${describeClientError(error)}`
    } finally {
      fetching.value = false
    }
  }

  /** 点一个候选模型把它填进 ModelID（唯一写入点；写完收起列表）。 */
  function chooseModel(modelId: string): void {
    draft.modelId = modelId
    candidatesOpen.value = false
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
    candidatesOpen.value = true
  }

  // ------------------------------------------------------------- 内部 --
  /** 落库 / 回显的基准值（Key 栏清空，掩码只做状态文案）。 */
  function fillFromSnapshot(data: SettingsSnapshot): void {
    snapshot.value = data

    draft.providerId = data.llm.providerId
    draft.providerName = data.llm.providerName
    draft.baseUrl = data.llm.baseUrl
    draft.modelId = data.llm.modelId
    draft.apiKey = ''
    llmKeyTouched.value = false
    llmKeyCleared.value = false
    // 换了配置基准，上一次的拉取结果就过期了
    fetched.value = null

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
      // ★ `providerId` 空串 = 「不改已存的」（后端占位即保留）；下拉停在「手动填写」时
      //   用户可能压根没填过它，所以这里允许它为空，由后端沿用现值。
      providerId: draft.providerId.trim() === '' ? null : draft.providerId.trim(),
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
    hasStoredKey,
    keyStatus,
    keyStatusHint,
    keyCleared: llmKeyCleared,
    /**
     * 嵌入 Key 的「保存后删除」标记。
     *
     * ★ 必须暴露出来（H10）：LLM 那条早就有 `keyCleared` 供界面显示提示，嵌入这条却只参与
     *   `dirty` / `clearApiKey` 的计算 —— 学生点了嵌入栏的「清除」后界面**毫无变化**
     *   （chip 还写着「已配置 …abcd」），只能再点一次或以为没生效。
     */
    embeddingKeyCleared,
    embeddingKeyStatus,
    baseUrlHintText,
    dirty,
    // 供应商预设 / 拉取模型
    catalog,
    catalogError,
    loadingCatalog,
    fetched,
    fetching,
    candidatesOpen,
    presetValue,
    activePreset,
    modelCandidates,
    load,
    loadCatalog,
    applyPreset,
    fetchModels,
    chooseModel,
    save,
    probeNow,
    clearStoredKey,
    clearStoredEmbeddingKey,
    markKeyEdited,
    markEmbeddingKeyEdited,
    resetDraft
  }
})

