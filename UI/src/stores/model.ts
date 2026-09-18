/**
 * 模型 / 供应商选择（全局）。
 *
 * ── 为什么单独建一个 store ──────────────────────────────────────────────
 * 模型是**跨页信息**：输入条上显示它、设置页编辑它、对话里每个回答都由它产生。
 * 原型阶段它来自 mocks；接线后它的权威源是设置页（`userData/config.json`），
 * Pi 的 `models.json` 只是**派生**产物 —— 这里预留的 `applyToSettings()` 就是那条线。
 *
 * ── 原型阶段做到哪一步（说清楚，避免"假接线"）─────────────────────────
 * · 选择模型 **真的改变 UI 状态**（输入条 chip、顶栏状态、设置页字段同步）；
 * · 「探测可用性」给出确定的结果与延迟，但不发真实请求 —— 卡片上标注了这一点；
 * · **不假装**调用成功：探测结果文案写的是"原型未发真实请求"。
 *
 * ── 候选清单的来源（接线时的落点）─────────────────────────────────────
 * 真实候选来自 Pi 自带的 provider 目录（`desktop/src/shared/provider-catalog.ts`
 * 里那两个手写 TS 类型，因为那份数据在 Python 侧不存在）。
 * 这里列出的是与 `contracts.py` 默认值一致的那几项 + 一个自定义网关示例。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface ModelOption {
  providerId: string
  providerName: string
  baseUrl: string
  modelId: string
  /** 能力标签：给学生看的"这个模型能做什么" */
  tags: string[]
  /** 是否支持图片输入 —— 与多模态交互直接相关 */
  vision: boolean
}

export interface ProbeResult {
  ok: boolean
  latencyMs: number
  message: string
  at: string
}

/**
 * 候选模型。**默认值三项与 `contracts.py` 的常量一字不差**
 * （providerId=deepseek / baseUrl 无 /v1 / modelId 必须在 Pi 目录里存在）——
 * 历史上的 `deepseek-chat` + `/v1` 组合在 Pi 目录里都不存在，会让首轮对话直接报错。
 */
const CATALOG: ModelOption[] = [
  {
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-v4-flash',
    tags: ['默认', '快'],
    vision: false
  },
  {
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-v4-flash-vision-exp',
    tags: ['支持图片'],
    vision: true
  },
  {
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-v4-pro',
    tags: ['更强推理', '较慢'],
    vision: false
  },
  {
    providerId: 'custom',
    providerName: '自定义网关（示例）',
    baseUrl: 'https://your-gateway.example.com/v1',
    modelId: 'your-model-id',
    tags: ['需自填 models[]'],
    vision: false
  }
]

export const useModel = defineStore('model', () => {
  /** 当前生效的模型（默认取目录第一项，与设置页默认值一致） */
  const current = ref<ModelOption>({ ...CATALOG[0]! })
  const catalog = ref<ModelOption[]>(CATALOG.map((m) => ({ ...m })))

  /** 选择器开合（全局模态，App.vue 渲染） */
  const pickerOpen = ref(false)

  type ProbePhase = 'idle' | 'probing' | 'done'
  const probePhase = ref<ProbePhase>('idle')
  const probeResult = ref<ProbeResult | null>(null)
  let probeTimer: number | null = null

  const label = computed(() => current.value.modelId)
  const shortLabel = computed(() => {
    const id = current.value.modelId
    // 输入条上的 chip 要短：只留最后一段，超长再截
    const tail = id.split('/').pop() ?? id
    return tail.length > 22 ? `${tail.slice(0, 20)}…` : tail
  })

  function openPicker() {
    probeResult.value = null
    probePhase.value = 'idle'
    pickerOpen.value = true
  }

  function closePicker() {
    if (probeTimer !== null) {
      clearTimeout(probeTimer)
      probeTimer = null
    }
    pickerOpen.value = false
  }

  /**
   * 选用某个模型。
   * 原型阶段直接生效；接线后这里要写回 `config.json` 并重写 Pi 的 `models.json`，
   * 再让当前会话重新读取 —— 那时这一步会是异步的，所以接口先留成 async。
   */
  async function select(opt: ModelOption) {
    current.value = { ...opt }
    probeResult.value = null
    probePhase.value = 'idle'
    // 选完即关：让"选好了"这个动作有明确终点
    pickerOpen.value = false
  }

  /**
   * 探测可用性。
   * **原型不发真实请求** —— 结果文案必须说清这一点，否则就是假接线。
   * 接线后这里调 sidecar 的探测端点，返回真实延迟与错误原文。
   */
  function probe() {
    if (probePhase.value === 'probing') return
    probePhase.value = 'probing'
    probeResult.value = null
    if (probeTimer !== null) clearTimeout(probeTimer)
    probeTimer = window.setTimeout(() => {
      // 用当前模型的特征决定演示结果，让"不同模型探测结果不同"这件事可见
      const custom = current.value.providerId === 'custom'
      probeResult.value = {
        ok: !custom,
        latencyMs: 180 + Math.round(Math.random() * 120),
        message: custom
          ? '自定义网关未返回模型目录：需在 models[] 里声明至少一个模型'
          : '端点可达、模型 ID 在目录内。原型未发真实请求，接线后由后端实测。',
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      }
      probePhase.value = 'done'
      probeTimer = null
    }, 900)
  }

  /** 清理定时器（由挂载了本 store 的组件在卸载时调用） */
  function dispose() {
    if (probeTimer !== null) {
      clearTimeout(probeTimer)
      probeTimer = null
    }
  }

  return {
    current,
    catalog,
    pickerOpen,
    probePhase,
    probeResult,
    label,
    shortLabel,
    openPicker,
    closePicker,
    select,
    probe,
    dispose
  }
})
