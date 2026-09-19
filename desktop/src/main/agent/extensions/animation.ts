/**
 * 动画 Extension（票 16/17，执行文档 §9.2 第 1 行 / §11.2）：注册**唯一一个** Tool
 * `generate_animation`（在 §9.3 的「Tool 名 → `kind`」映射表里 → `animation`）。
 *
 * ★★ 本文件是全项目**最容易翻车**的一环，四条纪律先说清楚（改之前逐条读完）：
 *
 * 1. **模板优先，自由生成只是补充路径**（§11.2 的「生成策略」）。
 *    内置模板在 Python 侧（`server/resources/templates/`），模型只做
 *    「选模板 id + 填参数 + 写文案」；模板没命中才考虑自由生成，且**必须过同一套校验**。
 *    理由：原方案自认「一次性生成 HTML 失败率过高」是头号风险。
 *
 * 2. ★★ **校验 → 重试 ≤3 → 降级，全部在 `execute()` 内部完成。**
 *    Pi 的 `tool_execution_end` 是**只读通知**（`agent/events.ts` 文件头也写着这条），
 *    它不能回写任何结果 —— 所以重试**不可能**挂在事件上，只能写在 Tool 自己里面。
 *    重试计数用本模块内的 `Map<toolCallId, retryCount>`（§6.6 / §9.4：**不放 State**）。
 *
 * 3. **降级是「正常 payload」，不是 `error`**（票 17 的验收口径）。
 *    3 次都失败 → 用 `fallback_text` + 静态 SVG 组一个 `source: "template"` 的载荷正常下发，
 *    走 `payload` 事件；**不发 `error`**。理由见 `agent/events.ts` 文件头：
 *    `error` 对 UI 是**终态**，发了它后半段正文会被丢掉；而「动画降级成文字」这件事
 *    学生还能继续听，不该把整轮对话掐掉。
 *    （`error` 只留给「连降级都做不到」的情形 —— 那种情况下本文件返回 `failed()`。）
 *
 * 4. **`execute()` 绝不抛异常**（AGENTS §5.14）：Pi 的 Extension 与 Agent 同进程，
 *    抛出去会同时带走 UI。所有分支都收敛到 `ok()` / `failed()` 两种返回。
 *
 * 另外两条安全细节：
 *   - **HTML 由 Python 渲染与校验**（它才是能读到动画库与模板的一方），本文件不拼 HTML；
 *   - 托管走的是一次性 nonce（`/resources/animation/<student>/<kp>`），
 *     本文件**不碰 token、不碰 nonce**：它只调 `/api/animation/host/...`，
 *     token 由 `bridge/client.ts` 统一注入（`iframe` 那条路径才需要 nonce，见票 16）。
 */

import { Type, type Static } from '@sinclair/typebox'
import { apiFetch } from '../../bridge/client.ts'
import {
  currentAgentSession,
  toolFailure,
  toolSuccess,
  type AgentExtensionApi
} from './index.ts'

/* ------------------------------------------------------------------ *
 * 与契约对应的 TS 形状（`contracts.py` 的 `AnimationPayload` 出参形态）
 * ------------------------------------------------------------------ */

/** 动画载荷（`AnimationPayload`，§6.5）。**六个字段一个都不能少**。 */
export interface AnimationPayloadShape {
  concept: string
  /** 完整自包含 HTML（内联 Anime.js，**不引 CDN**）。 */
  html: string
  durationMs: number
  /** 降级为文字讲解（**必须非空**）。 */
  fallbackText: string
  /** 静态图（SVG dataURL；同样不依赖网络）。 */
  fallbackImage: string | null
  source: 'template' | 'generated'
}

/**
 * 下发给前端的动画载荷 = 契约的六个字段 + 两个**渲染侧附加字段**。
 *
 * ⚠️ 为什么不把 `resourceUrl` 加进 `AnimationPayload`（pydantic 契约）：
 * 契约是**冻结**的（§6.5 六字段），加字段要走「改 pydantic → 重导 OpenAPI → 重生成 TS」
 * 那条链，而这条附加信息只对**本机渲染进程**有意义（它是带一次性 nonce 的临时地址，
 * 换个进程、过 2 分钟就失效，没有任何契约价值）。所以它按 `agent/events.ts` 的既有做法
 * （`readPayload` 里那个 `tool` / `kind`）作为**渲染侧附加字段**挂在事件载荷上。
 */
export interface AnimationCardPayload extends AnimationPayloadShape {
  /**
   * 沙箱 HTML 的托管地址（带一次性 nonce，**票 16**）。
   *
   * 有它时前端走 `<iframe src="...">` 这条路；没有（或拿不到）时才退回 `srcdoc` 内联。
   * 两种路径的沙箱属性完全一致（都只有 `allow-scripts`）。
   */
  resourceUrl?: string | null
  /** `payload_id`（串台防线；前端由它校验每条 postMessage）。 */
  payloadId?: string
  /** 实际尝试了几次（模板路径 + 自由生成路径合计）。 */
  attempts?: number
  /** 非空表示这次是**降级**产物（值就是降级原因，供轨迹与排查）。 */
  degradedFrom?: string | null
}

/** `/api/animation/render` 的响应 = `AnimationPayload`（camelCase 由 pydantic alias 转）。 */
export type RenderResponse = Partial<AnimationPayloadShape> & { html?: string }

/** `/api/animation/host/...` 的响应（票 16 的一次性 nonce 在这里拿到）。 */
export interface HostResponse {
  url?: string
  path?: string
  payloadId?: string
  filename?: string
  expiresInMs?: number
  singleUse?: boolean
}

/** 模板参数声明（`/api/animation/templates` 里每个参数的形态）。 */
export interface TemplateParameterShape {
  name: string
  type: string
  minimum: number | null
  maximum: number | null
  default: unknown
  description: string
}

/** 一个可用模板的描述（模型据此「选模板 + 填参数」）。 */
export interface TemplateSummaryShape {
  id: string
  label: string
  title: string
  concept: string
  kpIds: string[]
  gradeLevels: string[]
  durationMs: number
  params: TemplateParameterShape[]
  fallbackText: string
  hasFallbackImage: boolean
}

/* ------------------------------------------------------------------ *
 * 常量（冻结 + 可调旋钮）
 * ------------------------------------------------------------------ */

/** Tool 名（冻结；事件层按 §9.3 的表把它映射成 `payload.kind = "animation"`）。 */
export const ANIMATION_TOOL_NAME = 'generate_animation'

/**
 * ★ 重试硬上限（票 17：「重试无上限 = 死循环烧额度」）。
 *
 * 语义是「**额外**重试几次」：`0` = 只试一次；默认 `3` = 最多试 4 次（首次 + 3 次重试）。
 * ★ 这是**模板路径与自由生成路径共用**的额度（F6）：最坏总尝试 = `MAX_RETRIES + 1`，
 *   不是「每条路径各 4 次」——后者最坏 8 次真实渲染 / LLM 调用，与冻结口径不符。
 * 为什么要上限：每次重试都是一次真实的 HTTP + 渲染（自由生成还要一次 LLM 调用），
 * 没上限时一个坏模板能把额度烧穿。
 */
export const MAX_RETRIES = 3

/** 单次 sidecar 调用的超时（本机服务；超这个数说明进程已不正常）。 */
export const ANIMATION_TIMEOUT_MS = 12000

/** 单份 HTML 的体积上限（与 Python 侧 `MAX_HTML_BYTES` 同一口径的粗校验）。 */
export const MAX_HTML_BYTES = 1024 * 1024

/** 降级文案的兜底（连模板都没命中且自由生成也失败时用；**永远有话可说**）。 */
export const DEFAULT_FALLBACK_TEXT =
  '这个概念我改用文字讲一遍：动画这边暂时没能生成出来，但讲解内容本身不受影响。'

/**
 * ★ 外部引用判据（陷阱 §6 第 3 条：模板内联 CDN → 沙箱断网白屏）。
 *
 * TS 侧**只做快速拦截**，真正权威的校验在 Python（`validate_animation_html`，
 * 它还要查库是否内联、`ready` 上报、`payload_id`、凭据泄漏等）。
 * 两边都查是有意的：这一条是断网演示的底线，多一道不亏。
 */
export const EXTERNAL_REFERENCE_RE = /https?:\/\/|\/\/cdn|unpkg|jsdelivr|cdnjs|googleapis/i

/** `payload_id` 白名单（它会被拼进 URL 与文件名）。 */
export const PAYLOAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/* ------------------------------------------------------------------ *
 * 参数 schema（TypeBox `TSchema`）
 * ------------------------------------------------------------------ */

/**
 * `generate_animation` 的参数。
 *
 * ⚠️ 与契约的一致性：`AnimationPayload` 是**产出**（Tool 的 details），不是入参，
 * 所以这里没有可对照的请求体契约模型 —— `check-tool-schema.mjs` 的 `TOOLS` 清单
 * 因此**没有**登记本 Tool（那里登记的是「Tool 参数 ⇄ 契约请求体」的同名字段比对，
 * 本 Tool 的入参在契约里没有对应物，登记了反而会变成一条永远命中的假差异）。
 * 参数与 Python `/api/animation/render` 的接受面的一致性由**服务端测试**盯住
 * （`server/tests/test_animation_templates.py`）。
 */
export const GenerateAnimationParams = Type.Object({
  concept: Type.String({
    minLength: 1,
    maxLength: 40,
    description: '要讲的概念（用学生问题里的说法，例如「排序」「梯度下降」）'
  }),
  kpId: Type.Optional(
    Type.String({
      maxLength: 64,
      description: '知识点 id（例如 training-inference-jr）；从 rag_search 结果或画像里取，不确定就不要填'
    })
  ),
  templateId: Type.Optional(
    Type.String({
      maxLength: 64,
      description: '指定用哪个内置模板；不确定就留空，服务端会按知识点自动匹配'
    })
  ),
  gradeLevel: Type.Optional(
    Type.Union(
      ['primary_low', 'primary_high', 'junior', 'senior'].map((level) => Type.Literal(level)),
      { description: '当前学段（会与主进程注入的学段核对，以主进程为准）' }
    )
  ),
  params: Type.Optional(
    Type.Record(Type.String({ maxLength: 32 }), Type.Union([Type.Number(), Type.String(), Type.Boolean()]), {
      description: '模板参数（数量、速度这类旋钮），键名与模板声明的参数一致'
    })
  ),
  caption: Type.Optional(
    Type.String({
      maxLength: 200,
      description: '一句话讲解（显示在动画上方；不填就用模板自带的说明）'
    })
  )
})

export type GenerateAnimationParamsType = Static<typeof GenerateAnimationParams>

/* ------------------------------------------------------------------ *
 * 载荷投影与校验
 * ------------------------------------------------------------------ */

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 把任意来源的渲染结果投影成 :interface:`AnimationPayloadShape`。
 *
 * **认不准就返回 `null`**（宁可重试，也不要一个缺字段的载荷 —— 缺 `fallbackText` 的载荷
 * 在降级时就没话可说了，那正是白屏的成因）。
 */
export function projectAnimationPayload(raw: unknown): AnimationPayloadShape | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>

  const concept = readNonEmptyString(record.concept)
  const html = readNonEmptyString(record.html)
  const fallbackText = readNonEmptyString(record.fallbackText ?? record.fallback_text)
  if (concept === null || html === null || fallbackText === null) return null

  const durationRaw = record.durationMs ?? record.duration_ms
  const durationMs =
    typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.trunc(durationRaw)
      : 0
  if (durationMs === 0) return null

  const sourceRaw = record.source
  const source: AnimationPayloadShape['source'] = sourceRaw === 'generated' ? 'generated' : 'template'

  const imageRaw = record.fallbackImage ?? record.fallback_image
  const fallbackImage =
    typeof imageRaw === 'string' && imageRaw.trim().length > 0 ? imageRaw.trim() : null

  return { concept, html, durationMs, fallbackText, fallbackImage, source }
}

/**
 * 载荷**六字段齐备性**校验（票 17 的验收口径）。
 *
 * 与 Python 的 `validate_animation_html` 分工不同：那边盯「HTML 本身能不能安全地跑」，
 * 这边盯「这份载荷交给前端后，最坏情况下界面会不会白屏」。
 */
export function validateAnimationPayload(payload: AnimationPayloadShape): { ok: true } | { ok: false; reason: string } {
  if (!payload.concept.trim()) return { ok: false, reason: '概念名称为空（学生看不到这是讲什么）' }
  if (!payload.fallbackText.trim()) return { ok: false, reason: '缺少降级文案（动画失败时界面会空着）' }
  if (!payload.fallbackImage) return { ok: false, reason: '缺少静态降级图（降级后只剩文字）' }
  if (payload.fallbackImage.startsWith('data:') && !payload.fallbackImage.includes('base64')) {
    return { ok: false, reason: '静态图不是合法的 dataURL' }
  }
  if (!payload.html.trim()) return { ok: false, reason: 'HTML 为空' }
  if (payload.html.length > MAX_HTML_BYTES) {
    return { ok: false, reason: `HTML 过大（${payload.html.length} 字符）` }
  }
  const external = EXTERNAL_REFERENCE_RE.exec(payload.html)
  if (external) {
    return { ok: false, reason: `HTML 里有外部引用「${external[0]}」（断网会白屏）` }
  }
  if (payload.durationMs <= 0) return { ok: false, reason: '时长非法' }
  return { ok: true }
}

/**
 * 渲染结果 + 降级文案 → 最终载荷。
 *
 * `caption`（模型写的一句话讲解）会盖掉模板自带的降级文案，但**盖不掉**模板的静态图 ——
 * 图是兜底的视觉，不该让模型左右。
 */
export function withCaption(
  payload: AnimationPayloadShape,
  caption: string | null
): AnimationPayloadShape {
  if (!caption) return payload
  const text = caption.trim()
  return text.length > 0 ? { ...payload, fallbackText: text } : payload
}

/**
 * 降级载荷（票 17 的核心兜底）。**它是一个合法的 `source: "template"` 载荷**，
 * 不是错误 —— 因此它走 `payload` 事件，学生看到的是一张有文字有图的卡片。
 *
 * `html` 留空串是有意的：前端看到空 `html` 就直接渲染降级视图（文字 + 静态图），
 * **不创建 iframe**（少一个必然失败的加载过程，也就少一次超时等待）。
 */
export function buildFallbackPayload(
  concept: string,
  fallbackText: string,
  fallbackImage: string | null
): AnimationPayloadShape {
  return {
    concept: concept.trim() || '本次讲解',
    html: '',
    durationMs: 0,
    fallbackText: fallbackText.trim() || DEFAULT_FALLBACK_TEXT,
    fallbackImage,
    source: 'template'
  }
}

/** 给模型看的一句话（动画走卡片，别让它把讲解词念一遍）。 */
export function renderAnimationText(payload: AnimationPayloadShape): string {
  if (payload.html.trim().length === 0) {
    return (
      `「${payload.concept}」的动画这次没能生成出来，已经用文字讲解顶上（卡片里能看到）。` +
      '请照卡片上的讲解继续，用一两句话引导学生看这张静态示意图，不要说自己「生成失败」这类技术细节。'
    )
  }
  const sourceLabel = payload.source === 'template' ? '内置动画模板' : '即时生成'
  return (
    `动画已经以卡片形式显示给学生（${payload.concept}；${sourceLabel}；约 ${(
      payload.durationMs / 1000
    ).toFixed(1)} 秒）。` +
    '卡片上有播放/暂停/重播按钮，学生会自己控制。**不要**把动画里的解说词念一遍，' +
    '只用一两句话说明「注意看什么」，然后停下来等学生反馈。'
  )
}

/* ------------------------------------------------------------------ *
 * 模板选择（模板优先策略的编排层一半）
 * ------------------------------------------------------------------ */

/** 从 `/api/animation/templates` 的响应里投影模板清单（**白名单**挑字段）。 */
export function projectTemplateSummary(raw: unknown): TemplateSummaryShape | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = readNonEmptyString(record.id)
  const label = readNonEmptyString(record.label)
  if (id === null || label === null) return null
  const params: TemplateParameterShape[] = []
  if (Array.isArray(record.params)) {
    for (const item of record.params) {
      if (!item || typeof item !== 'object') continue
      const spec = item as Record<string, unknown>
      const name = readNonEmptyString(spec.name)
      if (name === null) continue
      params.push({
        name,
        type: typeof spec.type === 'string' ? spec.type : 'str',
        minimum: typeof spec.minimum === 'number' ? spec.minimum : null,
        maximum: typeof spec.maximum === 'number' ? spec.maximum : null,
        default: spec.default,
        description: typeof spec.description === 'string' ? spec.description : ''
      })
    }
  }
  return {
    id,
    label,
    title: readNonEmptyString(record.title) ?? label,
    concept: readNonEmptyString(record.concept) ?? label,
    kpIds: Array.isArray(record.kpIds) ? record.kpIds.filter((x): x is string => typeof x === 'string') : [],
    gradeLevels: Array.isArray(record.gradeLevels)
      ? record.gradeLevels.filter((x): x is string => typeof x === 'string')
      : [],
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    params,
    fallbackText: typeof record.fallbackText === 'string' ? record.fallbackText : '',
    hasFallbackImage: record.hasFallbackImage === true
  }
}

/* ------------------------------------------------------------------ *
 * 注入点（测试与演示用；生产走默认实现）
 * ------------------------------------------------------------------ */

/** sidecar 请求出口（默认 `apiFetch`；测试注入假实现以覆盖断网 / 422 / 500 分支）。 */
export type AnimationRequester = (path: string, init?: RequestInit) => Promise<Response>

/**
 * 自由生成器（**补充路径**，仅当模板未命中时才会被调用）。
 *
 * ⚠️ 它的返回值必须过 {@link validateAnimationPayload} 与 Python 的 HTML 校验，
 * 不合格就继续重试，重试仍不合格就降级（**不是**「生成出来就直接用」）。
 * ★ 重试**与模板路径共用同一个额度**（见 {@link produce} 的 `totalBudget`，F6）——
 *   不是各给 3 次。
 */
export interface AnimationGenerationRequest {
  concept: string
  kpId: string
  gradeLevel: string
  /** 重试次数（从 0 开始），供生成器记录轨迹。 */
  attempt: number
  /** 上次失败的可读原因（让生成器知道该改什么）。 */
  previousReason?: string
  /**
   * ★ 卡片手里的那个 `payload_id`（与 `details.payloadId` **同一个值**）。
   * 生成器必须把它原样送到 `/api/animation/compose` —— Python 会把它注入沙箱 HTML，
   * 前端按它校验每条 postMessage；对不上时卡片永远收不到 `ready`，5 秒后必然降级（F2）。
   */
  payloadId: string
}

export interface AnimationExtensionOptions {
  /** 请求出口（默认 `apiFetch`）。 */
  request?: AnimationRequester
  /** 额外重试次数（默认 {@link MAX_RETRIES} = 3）。 */
  retries?: number
  /** 自由生成器（默认不接：模板未命中时直接降级）。 */
  generate?: (request: AnimationGenerationRequest) => Promise<unknown>
  /** 日志出口（默认 `console.warn`）。**只记结构性字段，不记 HTML 正文与凭据**。 */
  log?: (line: string) => void
  /** 单次调用超时（默认 {@link ANIMATION_TIMEOUT_MS}）。 */
  timeoutMs?: number
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

/**
 * 建一个动画 Extension 工厂（`runtime.ts` 用默认导出；测试用本函数注入假请求与生成器）。
 */
export function createAnimationExtension(
  options: AnimationExtensionOptions = {}
): (pi: AgentExtensionApi) => void {
  const request: AnimationRequester = options.request ?? apiFetch
  const maxRetries = Math.max(0, Math.trunc(options.retries ?? MAX_RETRIES))
  const log = options.log ?? ((line: string) => console.warn(line))
  const timeoutMs = options.timeoutMs ?? ANIMATION_TIMEOUT_MS
  const generate = options.generate

  /**
   * ★★ 重试计数（票 17 的硬要求）：**Extension 内的 Map，不放 State、不依赖事件回写**。
   *
   * 键是 Pi 的 `toolCallId`：同一轮里同一个 Tool 的多次调用各自计数，
   * 不会因为「上一张卡片重试过」就让下一张卡片少试几次。
   * 容量有上限（同屏卡片是个位数，256 足够），防止长会话把内存攒住。
   */
  const retryCounts = new Map<string, number>()
  const MAX_TRACKED_CALLS = 256

  function noteRetry(toolCallId: string): number {
    const next = (retryCounts.get(toolCallId) ?? 0) + 1
    if (retryCounts.size >= MAX_TRACKED_CALLS && !retryCounts.has(toolCallId)) {
      // 丢最旧的一半（Map 保持插入序）：长会话里不该无限攒键
      const keys = [...retryCounts.keys()].slice(0, MAX_TRACKED_CALLS / 2)
      for (const key of keys) retryCounts.delete(key)
    }
    retryCounts.set(toolCallId, next)
    return next
  }

  /** 本次调用已经重试过几次（诊断 / 轨迹用）。 */
  function retryCountOf(toolCallId: string): number {
    return retryCounts.get(toolCallId) ?? 0
  }

  /** 一次带超时的请求（超时 / 网络异常都由调用方收敛成可读错误）。 */
  async function call(path: string, init?: RequestInit): Promise<Response> {
    return await request(path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  }

  /** 读一小段响应体用于报错（**截断**，别把整页 HTML 塞进 Prompt）。 */
  async function readSnippet(response: Response): Promise<string> {
    try {
      const text = (await response.text()).replace(/\s+/g, ' ').trim()
      return text.length > 160 ? `${text.slice(0, 160)}…` : text
    } catch {
      return ''
    }
  }

  /**
   * 请求渲染一份动画（**这一条调用同时承担校验**：Python 渲染完自己校验，
   * 不合格返回 422 + 可读原因）。
   *
   * 返回 `{ ok: true, payload }` 或 `{ ok: false, reason, retryable }`：
   * `retryable=false` 表示「再试也一样」（例如知识点没有模板、sidecar 挂了），
   * 此时立刻收手去降级，不再浪费 3 次重试。
   */
  async function renderOnce(
    body: Record<string, unknown>
  ): Promise<{ ok: true; payload: AnimationPayloadShape } | { ok: false; reason: string; retryable: boolean }> {
    let response: Response
    try {
      response = await call('/api/animation/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (error) {
      return {
        ok: false,
        retryable: false,
        reason: `本地动画服务不可用（${error instanceof Error ? error.message : String(error)}）`
      }
    }

    if (response.status === 404) {
      // 没命中模板 → 「模板优先」这条路径到此为止，交给自由生成 / 降级（重试无意义）
      const snippet = await readSnippet(response)
      return { ok: false, retryable: false, reason: `没有匹配的动画模板${snippet ? `（${snippet}）` : ''}` }
    }
    if (response.status === 422) {
      // ★ 审核不合格 = **可重试**：这正是「校验 → 重试 ≤3 → 降级」里的重试分支
      const snippet = await readSnippet(response)
      return { ok: false, retryable: true, reason: `动画未通过校验${snippet ? `：${snippet}` : ''}` }
    }
    if (!response.ok) {
      const snippet = await readSnippet(response)
      return {
        ok: false,
        retryable: response.status >= 500,
        reason: `动画服务返回 HTTP ${response.status}${snippet ? `（${snippet}）` : ''}`
      }
    }

    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      return { ok: false, retryable: true, reason: '动画服务返回的不是合法 JSON' }
    }
    const payload = projectAnimationPayload(raw)
    if (payload === null) {
      return { ok: false, retryable: true, reason: '载荷字段不齐（缺 concept / html / durationMs / fallbackText）' }
    }
    const validated = validateAnimationPayload(payload)
    if (!validated.ok) {
      return { ok: false, retryable: true, reason: validated.reason }
    }
    return { ok: true, payload }
  }

  /**
   * 主链路：**模板优先 → 自由生成（补充）→ 降级**。
   *
   * 重试的边界（票 17）：
   *   - 模板路径的 422（校验不过）→ 重试；自由生成路径每次返回都过同一套校验 → 同样可重试；
   *   - ★ **两条路径共用同一个尝试额度**（{@link MAX_RETRIES} + 1 = 总尝试次数，F6）：
   *     以前两条 `for` 各自 `0..maxRetries`，最坏是 4 次渲染 + 4 次 LLM 调用（8 次），
   *     与执行文档「重试 ≤3 → 降级」的冻结口径不符，也白烧额度；
   *   - 重试耗尽 → **降级为非空 payload**，走 `payload` 事件，不发 `error`。
   */
  async function produce(input: {
    toolCallId: string
    concept: string
    kpId: string
    gradeLevel: string
    templateId: string
    params: Record<string, unknown>
    caption: string | null
  }): Promise<
    | { kind: 'ok'; payload: AnimationPayloadShape; attempts: number; payloadId: string }
    | { kind: 'degraded'; payload: AnimationPayloadShape; attempts: number; reason: string; payloadId: string }
    | { kind: 'failed'; reason: string }
  > {
    /** 兜底用的降级素材：**一路攒着**，任何一步失败都能立刻用它拼出可展示的载荷。 */
    let fallbackText = input.caption ?? ''
    let fallbackImage: string | null = null
    let attempts = 0
    let lastReason = ''
    const payloadId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    /**
     * ★ 模板路径与自由生成路径**共用**的尝试总量（F6）：
     * `maxRetries = 3` → 最多 4 次尝试（首次 + 3 次重试），不论钱花在哪条路径上。
     * 这里不是「每条路径各 4 次」—— 那是最坏 8 次真实渲染 / LLM 调用。
     */
    const totalBudget = maxRetries + 1

    /** 记一次尝试（第 2 次起同时记一条重试日志）；两条路径共用，额度才不会各算一份。 */
    const noteAttempt = (): void => {
      attempts += 1
      if (attempts > 1) {
        noteRetry(input.toolCallId)
        log(
          `[animation] 第 ${attempts - 1} 次重试（toolCallId=${input.toolCallId}，累计重试 ${retryCountOf(
            input.toolCallId
          )} 次）：${lastReason}`
        )
      }
    }

    // ── 第一条路径：模板命中（首选） ─────────────────────────────
    while (attempts < totalBudget) {
      noteAttempt()
      const result = await renderOnce({
        templateId: input.templateId,
        kpId: input.kpId,
        gradeLevel: input.gradeLevel,
        concept: input.concept,
        payloadId,
        params: input.params,
        ...(input.caption ? { fallbackText: input.caption } : {})
      })
      if (result.ok) {
        // 模板自带的降级素材要留好：前端在 iframe 超时时会用它
        fallbackText = result.payload.fallbackText || fallbackText
        fallbackImage = result.payload.fallbackImage ?? fallbackImage
        return {
          kind: 'ok',
          payload: withCaption(result.payload, input.caption),
          attempts,
          payloadId
        }
      }
      lastReason = result.reason
      if (!result.retryable) break
    }

    // ── 第二条路径：自由生成（**补充**，默认没接） ───────────────
    //   ★ 只能用**模板路径没花完的**额度（`totalBudget - attempts`）；额度用尽直接去降级。
    if (generate) {
      let generationAttempt = 0
      while (attempts < totalBudget) {
        const attempt = generationAttempt
        generationAttempt += 1
        noteAttempt()
        try {
          const raw = await generate({
            concept: input.concept,
            kpId: input.kpId,
            gradeLevel: input.gradeLevel,
            attempt,
            previousReason: lastReason,
            // ★ 卡片手里的那个 id（F2）：产物里的 payload_id 必须与 `details.payloadId` 一致，
            //   否则 iframe-host 会把沙箱发来的每条消息都当成别人的（永远收不到 ready）。
            payloadId
          })
          const payload = projectAnimationPayload(raw)
          if (payload === null) {
            lastReason = '自由生成的结果字段不齐'
            log(`[animation] 自由生成字段不齐（第 ${attempt + 1} 次），继续重试`)
            continue
          }
          const validated = validateAnimationPayload(payload)
          if (!validated.ok) {
            lastReason = validated.reason
            log(`[animation] 自由生成校验未通过（第 ${attempt + 1} 次）：${validated.reason}`)
            continue
          }
          fallbackText = payload.fallbackText || fallbackText
          fallbackImage = payload.fallbackImage ?? fallbackImage
          return {
            kind: 'ok',
            payload: withCaption({ ...payload, source: 'generated' }, input.caption),
            attempts,
            payloadId
          }
        } catch (error) {
          lastReason = error instanceof Error ? error.message : String(error)
          log(`[animation] 自由生成抛异常（第 ${attempt + 1} 次）：${lastReason}`)
        }
      }
    }

    // ── 第三条路径：降级（**正常 payload，不是 error**） ──────────
    if (!fallbackImage) {
      // 连静态图都没有时不能空手降级：Python 的模板渲染会给，模板都没命中时用兜底 SVG
      fallbackImage = buildInlineFallbackImage(input.concept, fallbackText)
    }
    if (!fallbackText) fallbackText = DEFAULT_FALLBACK_TEXT
    log(
      `[animation] 已降级为文字 + 静态图（尝试 ${attempts} 次；原因：${lastReason || '模板未命中'}）` +
        `：概念「${input.concept}」`
    )
    return {
      kind: 'degraded',
      payload: buildFallbackPayload(input.concept, fallbackText, fallbackImage),
      attempts,
      reason: lastReason || '模板未命中，且没有可用的生成路径',
      payloadId
    }
  }

    /**
     * 托管动画 HTML（票 16）：把渲染好的产物交给 Python 按学生分目录落盘，
     * 换回一个**带一次性 nonce 的地址**给 iframe 用。
     *
     * ★ 为什么值得多这一步（而不是直接把 HTML 塞进 `srcdoc`）：
     *   - 学生数据落在 `students/<id>/animations/`，**跨学生不可互取**这条性质变成可测试的；
     *   - 沙箱加载的是 sidecar 上的地址，鉴权在 HTTP 层完成（nonce，因为 iframe 带不了 header）；
     *   - `srcdoc` 是**兜底路径**（sidecar 没起来 / 学生未绑定时用），不是首选。
     *
     * 失败一律返回 `null`（**不抛**）：托管不成功只影响「走哪条路径」，不影响这张卡片能不能显示。
     */
    async function hostHtml(
      studentId: string,
      kpId: string,
      payloadId: string,
      html: string
    ): Promise<string | null> {
      if (!studentId || !kpId) return null
      try {
        const response = await call(
          `/api/animation/host/${encodeURIComponent(studentId)}/${encodeURIComponent(kpId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ html, payloadId })
          }
        )
        if (!response.ok) {
          log(`[animation] 托管未成功（HTTP ${response.status}），本卡片退回内联 srcdoc 路径`)
          return null
        }
        const raw = (await response.json()) as HostResponse
        const url = readNonEmptyString(raw.url)
        return url
      } catch (error) {
        log(
          `[animation] 托管请求异常（退回内联路径）：${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return null
      }
    }

    return function animationExtension(pi: AgentExtensionApi): void {
    pi.registerTool({
      name: ANIMATION_TOOL_NAME,
      label: '动画讲解',
      description:
        '把一个知识点做成**可播放的动画卡片**显示给学生（内置动画模板优先：排序 / 神经网络 / 决策树 / ' +
        '梯度下降 / 循环 / 变量 / 图像分类 / 数据训练预测）。学生说「用动画讲讲」「演给我看」' +
        '「看不懂，能演示一下吗」，或者某个概念用图讲比用文字讲更清楚时调用。' +
        '动画卡片支持播放 / 暂停 / 重播；生成不出来时会自动降级为文字 + 静态图，不会失败。',
      promptSnippet: 'generate_animation：给知识点生成动画讲解卡片（模板优先，失败自动降级）',
      promptGuidelines: [
        '先确认要讲的概念和知识点 id（可以从 rag_search 的结果里取），不要为了用动画而编造知识点。',
        '动画出不来时系统会降级成文字 + 静态图，**你不需要**自己写 HTML，也不要向学生解释失败原因。',
        '动画卡片有自己的讲解文字，你不要把动画里的解说词再念一遍，只说「注意看哪里」。'
      ],
      parameters: GenerateAnimationParams,
      execute: async (toolCallId: string, params: GenerateAnimationParamsType) => {
        // ★ 整段 execute 包在 try/catch 里：Pi 与 UI 同进程，抛异常会同时带走两者。
        try {
          const concept = readNonEmptyString(params?.concept)
          if (concept === null) {
            return toolFailure('动画讲解需要先确定要讲什么概念（例如「排序」「循环」）。')
          }
          const session = currentAgentSession()
          const kpId = readNonEmptyString(params?.kpId) ?? ''
          const templateId = readNonEmptyString(params?.templateId) ?? ''
          // ★ 学段以**会话**为准（与 rag-search.ts / quiz.ts 同一口径）：
          //   会话里那个值是**服务端推断**（`server/app/grade/rules.py`）出来的当前生效值，
          //   前端不推断学段（手动指定走独立通道、由服务端写库）；模型填的那个只是「复述」。
          const gradeLevel =
            readNonEmptyString(session?.gradeLevel) ?? readNonEmptyString(params?.gradeLevel) ?? 'primary_high'
          const caption = readNonEmptyString(params?.caption)
          const templateParams =
            params?.params && typeof params.params === 'object' && !Array.isArray(params.params)
              ? (params.params as Record<string, unknown>)
              : {}

          const outcome = await produce({
            toolCallId: typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : 'animation',
            concept,
            kpId,
            gradeLevel,
            templateId,
            params: templateParams,
            caption
          })

          if (outcome.kind === 'failed') {
            // 只有「连降级都做不到」才走 error —— 正常降级在上面的分支里
            return toolFailure(outcome.reason)
          }
          if (outcome.kind === 'degraded') {
            log(
              `[animation] 降级下发（第 ${
                outcome.attempts
              } 次尝试后）：${outcome.reason}`
            )
          }

          /**
           * 托管（票 16）：**只有真动画才托管**。
           *
           * 降级产物（`html` 为空）不托管 —— 前端看到空 `html` 就直接渲染文字 + 静态图，
           * 不会建 iframe，托管一份永远不会被加载的 HTML 只是白占磁盘。
           */
          let resourceUrl: string | null = null
          if (outcome.payload.html.trim().length > 0 && session?.studentId) {
            resourceUrl = await hostHtml(
              session.studentId,
              kpId || 'general',
              outcome.payloadId,
              outcome.payload.html
            )
          }

          // 把「试了几次 / 为什么降级 / 托管地址 / payload_id」放进 details：
          // 事件层会把 details 展开成 payload（`agent/events.ts` 的 readPayload），
          // 轨迹图（`agent/trace.ts`）也会读其中的 `degraded` 标记。
          const details: AnimationCardPayload = {
            ...outcome.payload,
            payloadId: outcome.payloadId,
            resourceUrl,
            attempts: outcome.attempts,
            degradedFrom: outcome.kind === 'degraded' ? outcome.reason : null
          }
          return toolSuccess(renderAnimationText(outcome.payload), details)
        } catch (error) {
          // 兜底异常：给一句可读中文 + 统一失败形状（event 层据此发 degraded 的 error 事件）
          return toolFailure('动画讲解这一步没有完成。请直接用文字把这个概念讲清楚。', error)
        }
      }
    })
  }
}

/* ------------------------------------------------------------------ *
 * 极小兜底图（Python 都给不出降级图时的最后一道）
 * ------------------------------------------------------------------ */

/**
 * 兜底静态图：一张极简的 SVG（dataURL）。
 *
 * 什么时候会用到它：模板路径 404（没命中）+ 没有自由生成器 + 拿不到任何 Python 侧素材。
 * 正常情况下走不到这里（Python 的 `build_fallback_svg` 会给出更完整的图），
 * 但**「降级也不可能空手回」**这条纪律必须有一个确定性的实现。
 *
 * ★ 与 Python 侧同一个理由用 base64：SVG 的 XML 命名空间里有个 `http://` 字面量，
 * 内联会让「零外部引用」那条断言出现一次命中，base64 之后编码串里什么都没有。
 */
export function buildInlineFallbackImage(concept: string, text: string): string {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const title = escape(concept.slice(0, 24))
  const line = escape(text.replace(/\s+/g, ' ').slice(0, 34))
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200">` +
    `<rect width="480" height="200" rx="12" fill="#ffffff" stroke="#d6ddec"/>` +
    `<text x="24" y="52" font-size="16" font-weight="650" fill="#12233b">${title}</text>` +
    `<rect x="24" y="84" width="18" height="60" rx="3" fill="#2f6fd0" opacity="0.5"/>` +
    `<rect x="52" y="64" width="18" height="80" rx="3" fill="#2f6fd0" opacity="0.7"/>` +
    `<rect x="80" y="104" width="18" height="40" rx="3" fill="#2f6fd0" opacity="0.9"/>` +
    `<text x="120" y="120" font-size="13" fill="#5b6b82">${line}</text>` +
    `</svg>`
  // 主进程是 Node 环境，`Buffer` 一定存在（渲染进程那条路径不走本文件）
  const encoded = Buffer.from(svg, 'utf8').toString('base64')
  return `data:image/svg+xml;base64,${encoded}`
}

/** 默认工厂（`runtime.ts` 直接注入它）。 */
export default createAnimationExtension()
