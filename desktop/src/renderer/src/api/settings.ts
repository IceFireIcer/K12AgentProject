/**
 * 设置页的数据入口：**渲染进程 → 主进程 IPC → sidecar**（票 07）。
 *
 * ★ 渲染进程没有 HTTP 能力（架构守卫 G2/G3 会当场拦下）：本文件只调用
 *   `window.api`（preload 白名单），**不出现任何地址、通道字符串或请求原语**。
 * ★ 类型来自生成物 `@shared/api-types`（pydantic 契约 → OpenAPI → TS），
 *   这里**不手写任何字段名**，改了契约会在 `npm run typecheck` 时报出来。
 *
 * ---------------------------------------------------------------------------
 * ★ 需要主进程提供的能力（票 07 的接线点，主进程侧尚未落地时本页会给出可读提示）
 * ---------------------------------------------------------------------------
 * 通道名（`src/main/ipc/channels.ts` 的唯一来源，本文件不重复写：
 * 设置读取 / 设置保存 / 设置探测三条 invoke 通道），对应 preload 白名单里的三个方法：
 *
 *     readSettings()                      → SettingsCallResult<SettingsSnapshot>
 *     saveSettings(payload)               → SettingsCallResult<SettingsSnapshot>
 *     probeSettings(payload)              → SettingsCallResult<ProbeResult>
 *
 * 入参就是契约里的 `SettingsUpdateRequest` / `ProbeRequest`（camelCase），
 * 处理器把它们原样转给 `PUT /api/settings` 与 `POST /api/settings/probe`
 * （`bridge/client.ts` 统一注入 `X-Auth-Token`，渲染进程看不到任何凭据）。
 * 回执一律是判别联合 `{ok:true,data} | {ok:false,message}`：**失败也带一句可读中文**，
 * 不会把异常堆栈穿过 IPC 变成界面上的乱码。
 */

import type { components } from '@shared/api-types'
// ★ 这两个类型**不是** pydantic 契约的一部分（Python 侧不存在这份数据：它们是 Pi 自带的
//   provider 目录，只有主进程能读到），形状定义在 `@shared/provider-catalog`。
import type { FetchModelsResult, ProviderCatalogEntry } from '@shared/provider-catalog'
// ★ IPC 回执与设置域契约**不在这里重写**（H12）：唯一来源是 `src/main/ipc/channels.ts`
//   （preload 也从那里 import）。跨目录用相对路径 type-only 导入，编译后被擦除，
//   渲染进程运行时不加载任何主进程模块（与 `stores/sidecar.ts` 引 `main/sidecar/protocol` 同法）。
import type { SettingsCallResult } from '../../../main/ipc/channels'
import type { K12Api } from '../../../preload/index'

// ---------------------------------------------------------------- 契约类型 --
export type SettingsSnapshot = components['schemas']['SettingsResponse']
export type LlmSnapshot = components['schemas']['LlmConfig']
export type EmbeddingSnapshot = components['schemas']['EmbeddingConfig']
export type SettingsUpdateRequest = components['schemas']['SettingsUpdateRequest']
export type LlmConfigInput = components['schemas']['LlmConfigIn']
export type EmbeddingConfigInput = components['schemas']['EmbeddingConfigIn']
export type ProbeRequest = components['schemas']['ProbeRequest']
export type ProbeResult = components['schemas']['ProbeResult']
export type EmbeddingMode = EmbeddingSnapshot['mode']
export type { FetchModelsResult, ProviderCatalogEntry }
export type { SettingsCallResult }

/** 主进程暴露的设置相关方法（preload 白名单）。 */
export interface SettingsBridge {
  readSettings(): Promise<SettingsCallResult<SettingsSnapshot>>
  saveSettings(payload: SettingsUpdateRequest): Promise<SettingsCallResult<SettingsSnapshot>>
  probeSettings(payload: ProbeRequest): Promise<SettingsCallResult<ProbeResult>>
  readProviderCatalog(): Promise<SettingsCallResult<ProviderCatalogEntry[]>>
  fetchProviderModels(payload: ProbeRequest): Promise<SettingsCallResult<FetchModelsResult>>
}

/** 缺少的能力名（提示文案用，也是给接线人的清单）。 */
export const SETTINGS_BRIDGE_METHODS: readonly (keyof SettingsBridge)[] = [
  'readSettings',
  'saveSettings',
  'probeSettings',
  'readProviderCatalog',
  'fetchProviderModels'
]

/** 取桥接的结果：要么拿到能力，要么拿到**可读的缺失原因**（不抛异常、不白屏）。 */
export type SettingsBridgeLookup =
  | { ready: true; bridge: SettingsBridge }
  | { ready: false; message: string }

/**
 * 从 `window.api` 上取设置能力。
 *
 * 为什么用「按方法名探测」而不是直接调：票 07 与「主进程 IPC 接线」是两条并行的改动，
 * 通道还没落地时本页必须**显示一句能照着做的话**（缺哪个方法、去哪加），
 * 而不是抛一个 `window.api.readSettings is not a function`。
 */
export function resolveSettingsBridge(): SettingsBridgeLookup {
  if (typeof window === 'undefined' || typeof window.api === 'undefined') {
    return {
      ready: false,
      message: '预加载脚本未生效（window.api 缺失），无法读写设置。请重启应用或检查 preload 是否加载成功。'
    }
  }

  // ★ 结构检查替代双重断言（H12）：先按**主进程白名单的真实类型**拿到 `window.api`，
  //   再逐个确认方法存在（白名单是分步接线的），最后显式拼出桥 ——
  //   方法改名或改签名时 typecheck 会当场报出来，而不是像原来的
  //   `host as unknown as SettingsBridge` 那样把 `window.api` 的真实签名抹掉。
  const api: K12Api = window.api
  const missing = SETTINGS_BRIDGE_METHODS.filter((name) => typeof api[name] !== 'function')
  if (missing.length > 0) {
    return {
      ready: false,
      message:
        `设置功能尚未接线：preload 白名单缺少 ${missing.join(' / ')} —— 需要先在` +
        '主进程 IPC（channels/handlers）注册设置读取、保存、探测三条 invoke 通道，' +
        '再由 preload 暴露对应方法。接线后刷新页面即可使用。'
    }
  }

  return {
    ready: true,
    // 逐项包一层：不把白名单上的方法原样转出去（返回类型由 `K12Api` 保证与契约一致）
    bridge: {
      readSettings: () => api.readSettings(),
      saveSettings: (payload) => api.saveSettings(payload),
      probeSettings: (payload) => api.probeSettings(payload),
      readProviderCatalog: () => api.readProviderCatalog(),
      fetchProviderModels: (payload) => api.fetchProviderModels(payload)
    }
  }
}

// ---------------------------------------------------------------- 纯逻辑 --
/** 掩码前缀（与 `app/contracts.py` 的 `API_KEY_MASK_PREFIX` 一致；只用于「用户没改这一栏」的判断）。 */
export const KEY_MASK_PREFIX = '…'

/** 纯符号占位（`******` / `••••••`）：同样表示「未修改」。 */
const SYMBOL_PLACEHOLDERS = new Set(['*', '•', '·', '.'])

/**
 * 这个值像不像「已保存 Key 的掩码」？
 *
 * 命中它时提交空串（= 后端保留已存 Key），**绝不把掩码当新 Key 写回去** ——
 * 那是票 07 明确要求的「保存两次后 Key 仍可用」。
 */
export function looksLikeKeyMask(value: string): boolean {
  const text = value.trim()
  if (text === '') return true
  if (text.startsWith(KEY_MASK_PREFIX)) return true
  return [...text].every((char) => SYMBOL_PLACEHOLDERS.has(char))
}

/** Key 栏的状态文案（读接口只回掩码，所以这里只展示掩码与「已配置/未配置」）。 */
export function keyStatusText(hasKey: boolean, masked: string): string {
  if (!hasKey) return '未配置'
  return masked ? `已配置 ${masked}` : '已配置'
}

/** 去掉首尾空白与尾部斜杠（与后端 `normalize_base_url` 同一约定：**不自动补 /v1**）。 */
export function normalizeBaseUrlInput(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** `…` ↔ `…/v1` 的另一种写法（只用于提示，**不改写用户输入**）。 */
export function alternateBaseUrl(baseUrl: string): string | null {
  const trimmed = normalizeBaseUrlInput(baseUrl)
  if (trimmed === '') return null
  if (trimmed.endsWith('/v1')) {
    const stripped = trimmed.slice(0, -'/v1'.length)
    return stripped === '' ? null : stripped
  }
  return `${trimmed}/v1`
}

/**
 * BaseURL 提示文案：把「带不带 `/v1`」这条现场最容易踩的差异写在输入框下面
 * （执行文档 §6.2：默认填 `/v1` 习惯写法，而 Pi 内置 DeepSeek provider 是无 `/v1` 的写法）。
 */
export function baseUrlHint(baseUrl: string): string {
  const alternate = alternateBaseUrl(baseUrl)
  const forms = alternate
    ? `当前填的是 ${normalizeBaseUrlInput(baseUrl) || '（空）'}；如果它不通，另一种常见写法是 ${alternate}。`
    : '请填写服务的完整根地址，例如 https://api.deepseek.com 或 https://api.deepseek.com/v1。'

  return (
    `${forms} DeepSeek 官方两种写法（带 /v1 与不带 /v1）都能连通；` +
    '但不少 OpenAI 兼容服务只认其中一种，所以点「探测」拿结论，探测不会修改你填的内容。'
  )
}

/** 嵌入模式的中文名（三选一，取值来自冻结契约）。 */
export const EMBEDDING_MODE_LABELS: Record<EmbeddingMode, string> = {
  local_fastembed: '本地模型（fastembed bge-small-zh-v1.5，512 维，离线可用）',
  cloud_api: '云端接口（OpenAI 兼容 /embeddings，需要地址与 Key）',
  none: '不使用嵌入（检索退回关键词兜底）'
}

// ---------------------------------------------------------------- 供应商预设 --

/**
 * 「手动填写」预设的哨兵 id。
 *
 * 用户在预设下拉里选它 = 不改 `providerId` 之外的任何东西（端点与模型名自己填）。
 * Pi 对**非内置** provider 的 id 没有命名约束，所以自定义 / 校内网关直接用它自己的 id
 * （例如 `custom`）也能正常工作 —— 见 `pi-bootstrap.ts` 的 `buildModelsJsonConfig` 规则 3。
 */
export const MANUAL_PRESET_ID = '__manual__'

/** 预设下拉的一项（「手动填写」由界面另外拼，不在这个列表里）。 */
export interface PresetOption {
  id: string
  label: string
  baseUrl: string
  /** 该预设的模型候选（顺序即 Pi 目录顺序，第一个是默认推荐）。 */
  models: string[]
}

/**
 * 把主进程给的目录投影成下拉选项（纯函数，可单测）。
 *
 * - 过滤掉**没有任何模型**的 provider：选它只会得到一个找不到模型的配置（Pi 里 `getModels()` 为空）；
 * - 排序：有内置端点的排前面（选完就能用），同组内按显示名排序（稳定、可预期）；
 * - `label` 带上端点的 host，让用户在选之前就能看出这是哪一家（不用点进去看 URL）。
 */
export function buildPresetOptions(catalog: readonly ProviderCatalogEntry[]): PresetOption[] {
  return catalog
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      id: provider.id,
      label: provider.name && provider.name !== provider.id ? `${provider.name}` : provider.id,
      baseUrl: provider.baseUrl ?? '',
      models: provider.models.map((model) => model.id)
    }))
    .sort((left, right) => {
      const leftHasEndpoint = left.baseUrl !== ''
      const rightHasEndpoint = right.baseUrl !== ''
      if (leftHasEndpoint !== rightHasEndpoint) return leftHasEndpoint ? -1 : 1
      return left.label.localeCompare(right.label, 'zh-Hans-CN')
    })
}

/** 按 id 找预设（找不到返回 `undefined`；界面据此把下拉停在「手动填写」）。 */
export function findPresetById(presets: readonly PresetOption[], providerId: string): PresetOption | undefined {
  return presets.find((preset) => preset.id === providerId)
}

/**
 * 候选模型 id 的合并。
 *
 * ★ 直接 re-export `@shared/provider-catalog` 的那一份（**主进程用的是同一份实现**）：
 *   界面在切换预设时要能就地重算，而两处各写一份的话规则会悄悄分叉
 *   （表现为「界面显示的候选」与「主进程实际返回的候选」不一致，且两边单测都绿）。
 */
export { mergeModelCandidates } from '@shared/provider-catalog'

/**
 * 「供应商预设」下拉当前应当停在哪个值上（纯函数）。
 *
 * 判据：磁盘上的 `providerId` 能在预设里找到 → 停在它；否则停在「手动填写」。
 * 这样用户手填过的配置（例如校内网关 `custom`）不会被下拉悄悄显示成某个内置供应商。
 */
export function selectedPresetId(presets: readonly PresetOption[], providerId: string): string {
  return findPresetById(presets, providerId.trim()) ? providerId.trim() : MANUAL_PRESET_ID
}

