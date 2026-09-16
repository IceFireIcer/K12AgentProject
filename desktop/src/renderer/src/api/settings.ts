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

/** IPC 回执（与主进程 `channels.ts` 的写法一致：失败不抛异常，回一句人话）。 */
export type SettingsCallResult<T> = { ok: true; data: T } | { ok: false; message: string }

/** 主进程需要暴露的三个方法（preload 白名单）。 */
export interface SettingsBridge {
  readSettings(): Promise<SettingsCallResult<SettingsSnapshot>>
  saveSettings(payload: SettingsUpdateRequest): Promise<SettingsCallResult<SettingsSnapshot>>
  probeSettings(payload: ProbeRequest): Promise<SettingsCallResult<ProbeResult>>
}

/** 缺少的能力名（提示文案用，也是给接线人的清单）。 */
export const SETTINGS_BRIDGE_METHODS: readonly (keyof SettingsBridge)[] = [
  'readSettings',
  'saveSettings',
  'probeSettings'
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

  const host = window.api as unknown as Record<string, unknown>
  const missing = SETTINGS_BRIDGE_METHODS.filter((name) => typeof host[name] !== 'function')
  if (missing.length > 0) {
    return {
      ready: false,
      message:
        `设置功能尚未接线：preload 白名单缺少 ${missing.join(' / ')} —— 需要先在` +
        '主进程 IPC（channels/handlers）注册设置读取、保存、探测三条 invoke 通道，' +
        '再由 preload 暴露对应方法。接线后刷新页面即可使用。'
    }
  }

  return { ready: true, bridge: host as unknown as SettingsBridge }
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
