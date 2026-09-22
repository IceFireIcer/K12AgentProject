/**
 * 模型选择（Pinia）：消息输入条上的模型 chip + 模型选择弹层。
 *
 * ★★ 它是 `stores/settings.ts` 的**只读门面**，不是第二份配置真相。
 *   真值只有一处：`settings.snapshot.llm`（设置页保存后由服务端回执刷新）。
 *   这里再存一份 `current` 就会漂移 —— 设置页换了模型，输入条却还显示旧的。
 *
 * ★ 为什么还留这一层（不直接在组件里读 settings）：
 *   组件关心的是「一个短标签 + 能不能点开换」，而 settings 那边是
 *   「providerId / baseUrl / modelId / 草稿 / 脏标记 / 预设 / 候选」一整套表单状态。
 *   让输入条去理解表单状态是把两件事耦在一起。
 *
 * ⚠️ 上一个版本的 `probe()` 是**假的**（`setTimeout` 900ms + 按 providerId 编造结果，
 *   延迟还是 `Math.random()`）。这里直接接 `settings.probeNow()`（真实外呼探测）——
 *   假探测比没有更坏：它会让「模型到底通不通」这件事看起来已经被验证过了。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { llmDisplayLabel, llmReadyState } from '../labels'
import { useSettingsStore } from './settings'

/** 一个可选项（预设里的模型 / 探测拉回来的模型）。 */
export interface ModelOption {
  providerId: string
  providerName: string
  baseUrl: string
  modelId: string
  /** 可选标签（预设里带的说明）。 */
  tags?: string[]
  /** 是否支持视觉输入（预设里带的标记）。 */
  vision?: boolean
}

export const useModelStore = defineStore('model', () => {
  const settings = useSettingsStore()

  /** 弹层是否打开（组件共用同一个实例，所以放 store 而不是组件本地）。 */
  const pickerOpen = ref(false)

  /**
   * 当前生效的模型（来自设置快照；**还没读到快照 / 还没配好**时为 `null`）。
   *
   * ★★ 未配置（没填 Key）时必须回 `null`，**不许**把服务端默认值当成「当前模型」
   *   （2026-09-22 的实测缺陷）：服务端默认值是 `deepseek-v4-flash`，于是首次安装、
   *   一个 Key 都没填的时候，顶栏与输入条都显示着这个模型名 —— 看起来像「已经配好了」。
   *   详见 `labels.ts` 的 `llmReadyState`。
   */
  const current = computed<ModelOption | null>(() => {
    const llm = settings.snapshot?.llm
    if (!llm || llmReadyState(llm) !== 'ready') return null
    return {
      providerId: llm.providerId,
      providerName: llm.providerName,
      baseUrl: llm.baseUrl,
      // ★ 服务端把 Key 掩码后回；modelId 是明文字段（它不是凭据）。
      modelId: llm.modelId
    }
  })

  /** 「配好了没有」的三态（唯一实现在 `labels.ts`；顶栏 / 输入条 / 弹层共用）。 */
  const readyState = computed(() => llmReadyState(settings.snapshot?.llm))

  /**
   * 可选模型清单。
   *
   * ★ 合并两个来源（**都由设置域算好**，这里只做投影）：
   *   ① 当前供应商的候选（Pi 内置预设 ∪ 探测拉回的实时清单）；
   *   ② 当前生效的那个模型本身 —— 它可能不在候选里（学生手填的 modelId），
   *      不塞进来的话弹层里会「一个选中项都没有」，看着像坏了。
   */
  const catalog = computed<ModelOption[]>(() => {
    const llm = settings.snapshot?.llm
    const options: ModelOption[] = settings.modelCandidates.map((modelId) => ({
      providerId: llm?.providerId ?? settings.draft.providerId,
      providerName: llm?.providerName ?? settings.draft.providerName,
      baseUrl: llm?.baseUrl ?? settings.draft.baseUrl,
      modelId
    }))
    const active = current.value
    if (active && !options.some((option) => option.modelId === active.modelId)) {
      options.unshift(active)
    }
    return options
  })

  /**
   * chip 上的完整标签。
   *
   * ★★ 三态各自说自己的话（唯一实现在 `labels.ts` 的 `llmDisplayLabel`）：
   *   `读取中…` / `未配置` / 模型 id。**不许**在没读到设置或没配 Key 时显示一个模型名 ——
   *   那是在告诉学生「已经配好了」，而他发出去的第一句话会直接失败（实测缺陷）。
   */
  const label = computed(() => llmDisplayLabel(settings.snapshot?.llm))
  /** 窄容器（悬浮追问窗）里的短标签。 */
  const shortLabel = computed(() => {
    const raw = label.value
    return raw.length > 22 ? `${raw.slice(0, 20)}…` : raw
  })

  /** 探测状态（直接透传设置域的，不另存一份）。 */
  const probePhase = computed(() => settings.probing ? 'probing' : settings.probe ? 'done' : 'idle')
  const probeResult = computed(() => {
    const result = settings.probe
    if (!result) return null
    return {
      ok: result.ok,
      message: result.message,
      at: settings.probeAt
    }
  })

  function openPicker(): void {
    settings.probe = null
    pickerOpen.value = true
  }

  function closePicker(): void {
    pickerOpen.value = false
  }

  /**
   * 选择一个模型。
   *
   * ★ 只改**草稿**并保存 —— 写库、重写 Pi 的 `models.json`、热切换会话
   *   全在设置域那条链路上（`saveSettings` → 主进程 `applyLlmConfig`）。
   *   这里自己拼一份请求就等于绕过那条链路（而且会丢掉 Key 的掩码语义）。
   */
  async function select(option: ModelOption): Promise<boolean> {
    settings.chooseModel(option.modelId)
    pickerOpen.value = false
    return await settings.save()
  }

  /** 真实连通性探测（不是 `setTimeout` 假货）。 */
  async function probe(): Promise<void> {
    await settings.probeNow()
  }

  return {
    pickerOpen,
    current,
    readyState,
    catalog,
    label,
    shortLabel,
    probePhase,
    probeResult,
    openPicker,
    closePicker,
    select,
    probe
  }
})
