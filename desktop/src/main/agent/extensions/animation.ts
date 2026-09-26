/**
 * 动画 Extension（票 16/17，执行文档 §9.2 第 1 行 / §11.2）：注册**两个** Tool，
 * 两个都在 §9.3 的「Tool 名 → `kind`」映射表里 → `animation`：
 *
 *   ① `generate_animation`（票 16/17）：**模板优先** —— 选内置模板 + 填参数 + 写文案，
 *      模板没命中才走自由生成，最后降级为文字 + 静态图；
 *   ② `compose_animation`（**按需实时做**）：不问模板，直接把「学生具体想看什么」
 *      变成一次自由生成；同一位学生问同一件事时**先复用**上次做的那份（零模型调用）。
 *      它自己发的载荷 `source` 一律是 `generated`（模板路径不参与）。
 *
 * ★★ 本文件是全项目**最容易翻车**的一环，五条纪律先说清楚（改之前逐条读完）：
 *
 * 1. **模板优先，自由生成只是补充路径**（§11.2 的「生成策略」）。
 *    内置模板在 Python 侧（`server/resources/templates/`），模型只做
 *    「选模板 id + 填参数 + 写文案」；模板没命中才考虑自由生成，且**必须过同一套校验**。
 *    理由：原方案自认「一次性生成 HTML 失败率过高」是头号风险。
 *
 * 2. ★★ **校验 → 重试 ≤3 → 降级，全部在 `execute()` 内部完成。**
 *    Pi 的 `tool_execution_end` 是**只读通知**（`agent/events.ts` 文件头也写着这条），
 *    它不能回写任何结果 —— 所以重试**不可能**挂在事件上，只能写在 Tool 自己里面。
 *    重试计数用本模块内的 `Map<工具名 + toolCallId, retryCount>`（§6.6 / §9.4：**不放 State**）。
 *    ★ 键里带工具名（`retryKeyOf`）：本文件注册两个 Tool，两者的额度**互不消耗**。
 *
 * 3. **降级是「正常 payload」，不是 `error`**（票 17 的验收口径）。
 *    3 次都失败 → 用 `fallback_text` + 静态 SVG 组一个**合法载荷**正常下发，
 *    走 `payload` 事件；**不发 `error`**。理由见 `agent/events.ts` 文件头：
 *    `error` 对 UI 是**终态**，发了它后半段正文会被丢掉；而「动画降级成文字」这件事
 *    学生还能继续听，不该把整轮对话掐掉。
 *    （`error` 只留给「连降级都做不到」的情形 —— 那种情况下本文件返回 `failed()`。）
 *    ★ 降级载荷的 `source` 是**这条链路的实际出身**（卡片上直接显示成「内置模板 / 即时生成」）：
 *      `generate_animation` 沿用 `template`（既有行为不变），`compose_animation` 是 `generated`。
 *
 * 4. **`execute()` 绝不抛异常**（AGENTS §5.14）：Pi 的 Extension 与 Agent 同进程，
 *    抛出去会同时带走 UI。所有分支都收敛到 `ok()` / `failed()` 两种返回。
 *
 * 5. ★★ **`compose_animation` 的两条「绝不」**（它是「按学生具体要求实时做」那条路径）：
 *    - **复用不是硬依赖**：查上次做过的那份（`POST /api/animation/saved/lookup`）与
 *      存下这次的产物（`POST /api/animation/saved/{student_id}`）都是**尽力而为** ——
 *      端点缺失 / 500 / 超时一律只记一行日志，**不许影响这次出不出得来卡片**。
 *      存盘失败最多是「下次还得现做」，而把复用当硬依赖会让整条能力在端点未就绪时全灭。
 *    - **复用命中也要把 `payload_id` 取回来**：沙箱 HTML 里烘焙着**当初**那个 id
 *      （`compose_animation_html` 注入的 `window.__K12_PAYLOAD_ID__`），卡片按它校验每条
 *      postMessage。命中却不认得那个 id 时**宁可重新生成**，也不能发一张永远收不到
 *      `ready` 的卡片（5 秒后必然降级，学生看到的是「加载不出来」）。
 *
 * 另外两条安全细节：
 *   - **HTML 由 Python 渲染与校验**（它才是能读到动画库与模板的一方），本文件不拼 HTML；
 *   - 托管走的是一次性 nonce（`/resources/animation/<student>/<kp>`），
 *     本文件**不碰 token、不碰 nonce**：它只调 `/api/animation/host/...`，
 *     token 由 `bridge/client.ts` 统一注入（`iframe` 那条路径才需要 nonce，见票 16）。
 */

import { createHash } from 'node:crypto'
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
 * 下发给前端的动画载荷 = 契约的六个字段 + 一组**渲染侧附加字段**。
 *
 * ⚠️ 为什么不把它们加进 `AnimationPayload`（pydantic 契约）：
 * 契约是**冻结**的（§6.5 六字段），加字段要走「改 pydantic → 重导 OpenAPI → 重生成 TS」
 * 那条链，而这些附加信息只对**本机渲染进程**有意义（`resourceUrl` 是带一次性 nonce 的
 * 临时地址，换个进程、过 2 分钟就失效；`gradeLevel` 是主进程已经解析过的那一个，
 * 契约里同一份信息本来就在请求侧，没有任何契约价值）。所以它们按 `agent/events.ts`
 * 的既有做法（`readPayload` 里那个 `tool` / `kind`）作为**渲染侧附加字段**挂在事件载荷上。
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
  /**
   * ★ **实际生效的学段**（主进程注入的那个，不是模型复述的那个）。
   *
   * 为什么渲染侧需要它：卡片上的文案与学段有关（同一份产物在不同学段下的说法不同），
   * 而 `payload` 里没有学段 —— 前端若自己去推断就会与主进程注入的值分叉（学段真值
   * 只在服务端推断那一条链上，§10）。所以这里**原样透传**主进程解析出来的值，
   * 前端只读不算。
   */
  gradeLevel?: string
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
 * ★★ 第二个 Tool 名（**按需实时做**）：学生说「给我做一个……」这类**具体诉求**时用它。
 *
 * 与 {@link ANIMATION_TOOL_NAME} 的分工（两个都映射到 `kind = "animation"`）：
 *   - `generate_animation`：**模板优先** —— 概念命中内置模板就用模板（快、稳、可预期）；
 *   - `compose_animation`：**按学生说的那件事现做** —— 模板表达不了的想法走它，
 *     并且同一位学生问同一件事时**先复用**上次做的那份（零模型调用）。
 * 两者的载荷形状完全一致（同一个 `AnimationCardPayload`），前端不需要分辨是哪条路径。
 */
export const COMPOSE_ANIMATION_TOOL_NAME = 'compose_animation'

/** 知识点 id 缺省时的占位（与托管路径的 `kpId || 'general'` 同一口径）。 */
export const ANIMATION_GENERAL_KP = 'general'

/**
 * 复用键的第四维：**请求指纹**（`sha1(normalised request)`，十六进制）。
 *
 * 前三段是「谁 / 讲什么知识点 / 哪个学段」（学生 id 由库文件归属承担，见下面
 * {@link animationReuseKey} 的说明）；第四段是把学生的**具体要求**归一化之后的摘要。
 *
 * ★ 为什么归一化（而不是原样 hash）：同一句话的输入差异（首尾空格、大小写、连续空格、
 *   全角空格）在**学生自己看来是同一个要求**，不归一化就会把「同一个要求」算成两个键 ——
 *   表现为「明明刚做过，再问一次又要重做一遍」（复用的意义全部落空）。
 * ★ 为什么是 hash 而不是原话：**原话不进库**。Python 侧的 `AnimationSaveRequest.prompt_hash`
 *   只接受十六进制串（`ANIMATION_PROMPT_HASH_PATTERN`），学生原话归 Pi 的 JSONL 会话树
 *   —— 与「SQLite 不存对话正文」是同一条纪律，所以这里必须先 hash 再发。
 */
export function animationRequestHash(request: string): string {
  const normalised = request.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  return createHash('sha1').update(normalised, 'utf8').digest('hex')
}

/**
 * 复用键（四维，与 Python 侧 `saved_animation` 的唯一索引逐维对应）。
 *
 * 返回一段**只用于日志与断言**的可读串 —— 真正发出去的是拆开的四段
 * （学生 id 进路径 / 请求体，其余三段进请求体）。把四段拼成一段留给排查用：
 * 「为什么没命中复用」时能一眼看出是哪一维不一样。
 *
 * ⚠️ 学生 id 由**主进程注入**（{@link currentAgentSession}），**绝不是 Tool 参数** ——
 *   模型连表达「读别人做过的动画」的能力都不该有（与 `submit_quiz` 的 studentId 同一条边界）。
 */
export function animationReuseKey(input: {
  studentId: string
  kpId: string
  gradeLevel: string
  request: string
}): string {
  return [input.studentId, input.kpId || ANIMATION_GENERAL_KP, input.gradeLevel, animationRequestHash(input.request)].join('|')
}

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
 * 学生动画库的端点（`server/app/routes/animation_library.py`）
 * ------------------------------------------------------------------ */

/**
 * 按复用键取一条已保存的动画（命中 → 200 + 带 `html` 的那条；未命中 → 404）。
 *
 * ⚠️ **静态路径**：它与 `POST /animation/saved/{student_id}` 同形，服务端的注册顺序
 * 保证 `lookup` 不会被当成一个学生 id 吃掉。TS 侧只需照这个路径发。
 */
export const ANIMATION_SAVED_LOOKUP_PATH = '/api/animation/saved/lookup'

/** 保存一条（服务端会再校验一次 HTML；同一复用键再存 = 覆盖）。 */
export function animationSavedPath(studentId: string): string {
  return `/api/animation/saved/${encodeURIComponent(studentId)}`
}

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

/**
 * `compose_animation` 的参数（**按学生具体要求实时做**）。
 *
 * 与 `generate_animation` 参数的根本差别：**没有 `templateId` / `params`**
 * —— 这条路径不问模板，它把 `request`（学生到底想看什么）直接变成一次自由生成。
 * 所以这里多出的 `request` 是**必填**：它既是生成的输入，也是复用键的第四维
 * （`sha1(归一化后的 request)`，见 {@link animationRequestHash}）。
 *
 * ⚠️ 与契约的一致性：同 `generate_animation` —— 本 Tool 的入参在契约里**没有对应物**
 * （`/api/animation/compose` 收的是**模型产出的片段** body/script/fallbackText，
 * 不是本 Tool 的参数），所以 `check-tool-schema.mjs` 的 `TOOLS` 里**没有**登记它。
 * 登记了反而是一条永远命中的假差异（见 `GenerateAnimationParams` 的注释）。
 * 与「保存 / 复用」两个端点的字段对应关系（`kp_id` / `grade_level` / `prompt_hash`）
 * 由本文件的单测盯住（`tests/animation-compose-tool.test.ts`）。
 */
export const ComposeAnimationParams = Type.Object({
  concept: Type.String({
    minLength: 1,
    maxLength: 40,
    description: '要讲的知识概念（用学生问题里的说法，例如「排序」「梯度下降」）'
  }),
  request: Type.String({
    minLength: 1,
    maxLength: 200,
    description:
      '学生具体想看什么（照他的说法写，例如「想让柱子一步一步换位置」「想看小球越滚越快」）；' +
      '这一条决定动画怎么做，也决定能不能复用上次做过的同一份'
  }),
  kpId: Type.Optional(
    Type.String({
      maxLength: 64,
      description: '知识点 id（例如 training-inference-jr）；从 rag_search 结果或画像里取，不确定就不要填'
    })
  ),
  gradeLevel: Type.Optional(
    Type.Union(
      ['primary_low', 'primary_high', 'junior', 'senior'].map((level) => Type.Literal(level)),
      { description: '当前学段（会与主进程注入的学段核对，以主进程为准）' }
    )
  ),
  caption: Type.Optional(
    Type.String({
      maxLength: 200,
      description: '一句话讲解（显示在动画上方；不填就用生成结果里的说明）'
    })
  ),
  reuseSaved: Type.Optional(
    Type.Boolean({
      default: true,
      description: '同一位学生问同一件事时复用上次做过的动画（默认开；只有在学生明确要求「重新做一个」时才设为 false）'
    })
  )
})

export type ComposeAnimationParamsType = Static<typeof ComposeAnimationParams>

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
 * 降级载荷（票 17 的核心兜底）。**它是一个合法的载荷**，不是错误 ——
 * 因此它走 `payload` 事件，学生看到的是一张有文字有图的卡片。
 *
 * `html` 留空串是有意的：前端看到空 `html` 就直接渲染降级视图（文字 + 静态图），
 * **不创建 iframe**（少一个必然失败的加载过程，也就少一次超时等待）。
 *
 * ★ `source`（2026-09-23 变成参数）：它是**这条链路的实际出身**，不是装饰 ——
 *   卡片上那颗来源标签直接读它（`AnimationCard.vue`：
 *   `generated` → 「即时生成」/ `template` → 「内置模板」）。
 *   默认 `template` 是 `generate_animation` 的口径（它的降级发生在「模板没命中」之后，
 *   沿用原来那个值，行为一字不变）；`compose_animation` 那条路径**从头到尾不问模板**，
 *   它的降级产物必须标成 `generated` —— 否则学生看到的是「内置模板」，
 *   而这份东西跟内置模板毫无关系（那也是对 UI 撒谎）。
 */
export function buildFallbackPayload(
  concept: string,
  fallbackText: string,
  fallbackImage: string | null,
  source: AnimationPayloadShape['source'] = 'template'
): AnimationPayloadShape {
  return {
    concept: concept.trim() || '本次讲解',
    html: '',
    durationMs: 0,
    fallbackText: fallbackText.trim() || DEFAULT_FALLBACK_TEXT,
    fallbackImage,
    source
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

/**
 * `compose_animation` 给模型看的一句话。
 *
 * 与 {@link renderAnimationText} 的差别只有一处：**复用命中的那一份要多说一句** ——
 * 模型不知道「这张卡片是上次就做好的」，而它接下来那句话可能说成「我刚给你做了一个」。
 * 知道这件事，它才会说「我们上次看的那张动画还在，再看一遍」这种对的表述。
 *
 * ★ 降级分支与 `generate_animation` **逐字相同**：学生看到的是同一张「文字 + 静态图」卡片，
 *   模型该说的话也一样（别自己写 HTML、别解释失败）。
 */
export function renderComposedAnimationText(payload: AnimationPayloadShape, reused: boolean): string {
  if (payload.html.trim().length === 0) {
    return (
      `「${payload.concept}」的动画这次没能生成出来，已经用文字讲解顶上（卡片里能看到）。` +
      '请照卡片上的讲解继续，用一两句话引导学生看这张静态示意图，不要说自己「生成失败」这类技术细节。'
    )
  }
  const opening = reused
    ? `这次直接用了之前给这位学生做好的那份动画卡片（${payload.concept}；约 ${(
        payload.durationMs / 1000
      ).toFixed(1)} 秒）。`
    : `按学生的要求做的动画已经以卡片形式显示（${payload.concept}；即时生成；约 ${(
        payload.durationMs / 1000
      ).toFixed(1)} 秒）。`
  return (
    opening +
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
   * 键是 `工具名 + toolCallId`：同一轮里同一个 Tool 的多次调用各自计数，
   * 不会因为「上一张卡片重试过」就让下一张卡片少试几次。
   * ★★ 键里那一段**工具名是必需的**（本文件注册两个 Tool 之后才成立）：两个 Tool 的重试
   *    额度必须**互不消耗** —— 只按 toolCallId 计数时，两者共用一个命名空间，
   *    「一次 `compose_animation` 的重试」与「一次 `generate_animation` 的重试」在
   *    计数上无法区分（诊断数字也会互相污染）。分开之后，两者各自有
   *    `MAX_RETRIES + 1` 次尝试，互不影响（有单测钉着）。
   * 容量有上限（同屏卡片是个位数，256 足够），防止长会话把内存攒住。
   */
  const retryCounts = new Map<string, number>()
  const MAX_TRACKED_CALLS = 256

  /** 重试计数的键：**两个 Tool 各算一份**（见 {@link retryCounts} 的说明）。 */
  function retryKeyOf(toolName: string, toolCallId: string): string {
    return `${toolName}\u0000${toolCallId}`
  }

  function noteRetry(retryKey: string): number {
    const next = (retryCounts.get(retryKey) ?? 0) + 1
    if (retryCounts.size >= MAX_TRACKED_CALLS && !retryCounts.has(retryKey)) {
      // 丢最旧的一半（Map 保持插入序）：长会话里不该无限攒键
      const keys = [...retryCounts.keys()].slice(0, MAX_TRACKED_CALLS / 2)
      for (const key of keys) retryCounts.delete(key)
    }
    retryCounts.set(retryKey, next)
    return next
  }

  /** 本次调用已经重试过几次（诊断 / 轨迹用）。 */
  function retryCountOf(retryKey: string): number {
    return retryCounts.get(retryKey) ?? 0
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
  /* ------------------------------------------------------------------ *
   * 生产状态 + 两条路径共用的机制
   * ------------------------------------------------------------------ */

  /**
   * 一次「生产」过程中的可变状态。
   *
   * ★ 存在的理由：`generate_animation` 的两条路径（模板 → 自由生成）**共用同一个尝试额度**
   *   （F6），`compose_animation` 只有自由生成一条路径但用的**是同一份循环实现**。
   *   把 `attempts` / `lastReason` / 降级素材收进一个累加器，三条链路就不会各写一套计数。
   *   ⚠️ 它是**每次调用新建**的局部对象（不是 Extension 级状态）：并发调用之间不共享。
   */
  interface ProductionState {
    /** 已经尝试了几次（模板路径 + 自由生成路径合计）。 */
    attempts: number
    /** 最近一次失败的可读原因（降级时原样进 `degradedFrom` 与日志）。 */
    lastReason: string
    /** 兜底用的降级文案（模型写的 caption → 产物带回来的 → 默认文案）。 */
    fallbackText: string
    /** 兜底用的静态图（产物带回来的 → 内置 SVG）。 */
    fallbackImage: string | null
  }

  function createProductionState(caption: string | null): ProductionState {
    return { attempts: 0, lastReason: '', fallbackText: caption ?? '', fallbackImage: null }
  }

  /**
   * 记一次尝试（第 2 次起同时记一条重试日志）。
   *
   * ★ 重试计数按 `工具名 + toolCallId` 记（见 {@link retryKeyOf}）：两个 Tool 的额度互不消耗。
   */
  function noteAttempt(state: ProductionState, toolName: string, toolCallId: string): void {
    state.attempts += 1
    if (state.attempts > 1) {
      const retryKey = retryKeyOf(toolName, toolCallId)
      noteRetry(retryKey)
      log(
        `[animation] 第 ${state.attempts - 1} 次重试（toolCallId=${toolCallId}，累计重试 ${retryCountOf(
          retryKey
        )} 次）：${state.lastReason}`
      )
    }
  }

  /**
   * 降级收口（**正常 payload，不是 error**）：文字 + 静态图。
   *
   * 两个 Tool 共用：`generate_animation` 在「模板未命中 + 自由生成失败」后走它，
   * `compose_animation` 在「自由生成失败」后走它 —— 形状必须**逐字一致**，
   * 否则两条路径降级出来的卡片会长得不一样（学生看不出区别，排查时却要分两套看）。
   *
   * ★ `source` 由调用方给：它是**出处标签**（卡片上直接显示「内置模板 / 即时生成」），
   *   默认 `template`（`generate_animation` 的既有口径），`compose_animation` 传 `generated`。
   */
  function finishDegraded(
    state: ProductionState,
    concept: string,
    cause: string,
    source: AnimationPayloadShape['source'] = 'template'
  ): AnimationPayloadShape {
    if (!state.fallbackImage) {
      // 连静态图都没有时不能空手降级：Python 的模板渲染会给，模板都没命中时用兜底 SVG
      state.fallbackImage = buildInlineFallbackImage(concept, state.fallbackText)
    }
    if (!state.fallbackText) state.fallbackText = DEFAULT_FALLBACK_TEXT
    log(
      `[animation] 已降级为文字 + 静态图（尝试 ${state.attempts} 次；原因：${state.lastReason || cause}）` +
        `：概念「${concept}」`
    )
    return buildFallbackPayload(concept, state.fallbackText, state.fallbackImage, source)
  }

  /**
   * ★★ **自由生成循环**（**唯一一份实现**）。
   *
   * 谁在用它：
   *   - `generate_animation` 的**第二条路径**（模板未命中时）—— 额度是模板路径**没花完的**
   *     那些（`state.attempts` 已经在模板循环里涨过）；
   *   - `compose_animation` 的**唯一路径** —— 额度从 0 开始（它不问模板）。
   *
   * 返回值：成功 → 载荷（**`source` 一律改写为 `generated`**，自由生成这条路径的产物不该
   * 冒充模板产物）；失败 → `null`（调用方接着走降级）。
   *
   * ⚠️ `attempt`（给生成器的重试序号）从 **0** 开始，与模板路径试了几次无关 ——
   *   生成器用它写日志与「上次失败原因」，不是全局计数。
   */
  async function runGenerationLoop(request: {
    toolName: string
    toolCallId: string
    state: ProductionState
    concept: string
    kpId: string
    gradeLevel: string
    caption: string | null
    payloadId: string
    /** 尝试总量上限（次数本身，不是重试次数）。 */
    budget: number
  }): Promise<AnimationPayloadShape | null> {
    if (!generate) return null
    const { state } = request
    let generationAttempt = 0
    while (state.attempts < request.budget) {
      const attempt = generationAttempt
      generationAttempt += 1
      noteAttempt(state, request.toolName, request.toolCallId)
      try {
        const raw = await generate({
          concept: request.concept,
          kpId: request.kpId,
          gradeLevel: request.gradeLevel,
          attempt,
          previousReason: state.lastReason,
          // ★ 卡片手里的那个 id（F2）：产物里的 payload_id 必须与 `details.payloadId` 一致，
          //   否则 iframe-host 会把沙箱发来的每条消息都当成别人的（永远收不到 ready）。
          payloadId: request.payloadId
        })
        const payload = projectAnimationPayload(raw)
        if (payload === null) {
          state.lastReason = '自由生成的结果字段不齐'
          log(`[animation] 自由生成字段不齐（第 ${attempt + 1} 次），继续重试`)
          continue
        }
        const validated = validateAnimationPayload(payload)
        if (!validated.ok) {
          state.lastReason = validated.reason
          log(`[animation] 自由生成校验未通过（第 ${attempt + 1} 次）：${validated.reason}`)
          continue
        }
        state.fallbackText = payload.fallbackText || state.fallbackText
        state.fallbackImage = payload.fallbackImage ?? state.fallbackImage
        return withCaption({ ...payload, source: 'generated' }, request.caption)
      } catch (error) {
        state.lastReason = error instanceof Error ? error.message : String(error)
        log(`[animation] 自由生成抛异常（第 ${attempt + 1} 次）：${state.lastReason}`)
      }
    }
    return null
  }

  /** 新的 `payload_id`（串台防线的身份；卡片与沙箱 HTML 里必须是同一个）。 */
  function newPayloadId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
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
    const state = createProductionState(input.caption)
    const payloadId = newPayloadId()
    /**
     * ★ 模板路径与自由生成路径**共用**的尝试总量（F6）：
     * `maxRetries = 3` → 最多 4 次尝试（首次 + 3 次重试），不论钱花在哪条路径上。
     * 这里不是「每条路径各 4 次」—— 那是最坏 8 次真实渲染 / LLM 调用。
     */
    const totalBudget = maxRetries + 1

    // ── 第一条路径：模板命中（首选） ─────────────────────────────
    while (state.attempts < totalBudget) {
      noteAttempt(state, ANIMATION_TOOL_NAME, input.toolCallId)
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
        state.fallbackText = result.payload.fallbackText || state.fallbackText
        state.fallbackImage = result.payload.fallbackImage ?? state.fallbackImage
        return {
          kind: 'ok',
          payload: withCaption(result.payload, input.caption),
          attempts: state.attempts,
          payloadId
        }
      }
      state.lastReason = result.reason
      if (!result.retryable) break
    }

    // ── 第二条路径：自由生成（**补充**，默认没接） ───────────────
    //   ★ 只能用**模板路径没花完的**额度（`totalBudget - attempts`）；额度用尽直接去降级。
    const generated = await runGenerationLoop({
      toolName: ANIMATION_TOOL_NAME,
      toolCallId: input.toolCallId,
      state,
      concept: input.concept,
      kpId: input.kpId,
      gradeLevel: input.gradeLevel,
      caption: input.caption,
      payloadId,
      budget: totalBudget
    })
    if (generated !== null) {
      return { kind: 'ok', payload: generated, attempts: state.attempts, payloadId }
    }

    // ── 第三条路径：降级（**正常 payload，不是 error**） ──────────
    return {
      kind: 'degraded',
      payload: finishDegraded(state, input.concept, '模板未命中'),
      attempts: state.attempts,
      reason: state.lastReason || '模板未命中，且没有可用的生成路径',
      payloadId
    }
  }

  /* ------------------------------------------------------------------ *
   * 学生动画库（**复用 / 存库**，两条路径都是尽力而为）
   * ------------------------------------------------------------------ *
   * ⚠️ 这里的每一次请求都**不许把这次出卡搞砸**：端点缺失（404）/ 未就绪（503）/
   *    校验不过（422）/ 服务出错（500）/ 超时 —— 一律只记一行日志然后继续。
   *    复用的价值是「省一次模型调用」，不是「没有它就做不出来」。
   * ------------------------------------------------------------------ */

  /** 知识点 id 在库里的归一化（缺省用 `general`）：**查库与存库必须用同一个值**，否则永不命中。 */
  function libraryKpId(kpId: string): string {
    return kpId.trim() || ANIMATION_GENERAL_KP
  }

  /**
   * 从**已保存的** HTML 里取回 `payload_id`。
   *
   * ★★ 为什么必须取回而不是新造一个：沙箱 HTML 是**成品**，`window.__K12_PAYLOAD_ID__`
   *    在当初拼装时就烘焙进去了（`compose_animation_html`），卡片按**自己手里那个 id**
   *    校验每条 postMessage。命中复用却发一个新 id，等于这张卡片永远收不到 `ready`
   *    —— 5 秒后必然走超时降级（学生看到的是「加载不出来」，而库里那份明明是好的）。
   *   取不回来时**宁可重新生成**（见 {@link lookupSavedAnimation} 的调用点）。
   *
   * 判据是拼装器写下的那一行（json.dumps 出来的双引号串），并用 {@link PAYLOAD_ID_RE}
   * 卡住字符集 —— 它来自磁盘上的文件，不该被无条件信任。
   */
  function readSavedPayloadId(html: string): string | null {
    const matched = /window\.__K12_PAYLOAD_ID__\s*=\s*"([^"]*)"/.exec(html)
    const candidate = matched?.[1] ?? ''
    return PAYLOAD_ID_RE.test(candidate) ? candidate : null
  }

  /**
   * 查一份可复用的产物（命中 → 载荷 + 它自己的 `payload_id`；否则 `null`）。
   *
   * 未命中与「端点还没有」在**行为上是同一件事**：接着现做一份。所以任何非 2xx 都返回
   * `null`，只把状态码写进日志（区分「库里确实没有」与「端点没落地」靠这一行）。
   */
  async function lookupSavedAnimation(input: {
    studentId: string
    kpId: string
    gradeLevel: string
    request: string
  }): Promise<{ payload: AnimationPayloadShape; payloadId: string } | null> {
    const promptHash = animationRequestHash(input.request)
    try {
      const response = await call(ANIMATION_SAVED_LOOKUP_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: input.studentId,
          kpId: libraryKpId(input.kpId),
          gradeLevel: input.gradeLevel,
          // ★ 只发**摘要**：学生原话一个字都不进库（与「不存对话正文」同一条纪律）
          promptHash
        })
      })
      if (!response.ok) {
        log(
          `[animation] 没有可复用的动画（HTTP ${response.status}；404 = 库里确实没有），这一步现做一份`
        )
        return null
      }
      const raw: unknown = await response.json()
      const payload = projectAnimationPayload(raw)
      if (payload === null) {
        log('[animation] 复用命中的载荷字段不齐，改为现做一份')
        return null
      }
      const validated = validateAnimationPayload(payload)
      if (!validated.ok) {
        log(`[animation] 复用命中的载荷没通过校验（${validated.reason}），改为现做一份`)
        return null
      }
      const savedPayloadId = readSavedPayloadId(payload.html)
      if (savedPayloadId === null) {
        // ★ 见 readSavedPayloadId：宁可不复用，也不发一张永远收不到 ready 的卡片
        log('[animation] 复用命中，但产物里的 payload_id 取不回来，改为现做一份（避免卡片永远等不到就绪）')
        return null
      }
      return { payload: { ...payload, source: 'generated' }, payloadId: savedPayloadId }
    } catch (error) {
      log(
        `[animation] 复用查询失败（不影响本次出卡，改为现做一份）：${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return null
    }
  }

  /**
   * 把刚生成的产物存进学生动画库（**尽力而为**，返回是否真的存下）。
   *
   * 不存的两种情况（都是有意的，不是失败）：
   *   - **降级产物**（`html` 为空）：库里只留能播的动画，文字 + 静态图那一份没必要存；
   *   - **没有绑定学生**（`studentId` 为空）：动画库是一人一份（§8.2），落不到具体人名下。
   */
  async function saveGeneratedAnimation(input: {
    studentId: string
    kpId: string
    gradeLevel: string
    request: string
    payload: AnimationPayloadShape
  }): Promise<boolean> {
    if (!input.studentId) return false
    if (input.payload.html.trim().length === 0) {
      log('[animation] 本次是降级产物（没有可播放的 HTML），不入动画库')
      return false
    }
    try {
      const response = await call(animationSavedPath(input.studentId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kpId: libraryKpId(input.kpId),
          gradeLevel: input.gradeLevel,
          concept: input.payload.concept,
          promptHash: animationRequestHash(input.request),
          durationMs: input.payload.durationMs,
          html: input.payload.html,
          fallbackText: input.payload.fallbackText,
          ...(input.payload.fallbackImage ? { fallbackImage: input.payload.fallbackImage } : {})
        })
      })
      if (!response.ok) {
        // 422（HTML 没通过服务端二次校验）/ 404（端点没落地）/ 503（没有数据目录）都走这里
        log(
          `[animation] 这次的动画没能存进动画库（HTTP ${response.status}），不影响本次显示；下次会重新做一份`
        )
        return false
      }
      log(
        `[animation] 已存入学生动画库（${animationReuseKey({
          studentId: input.studentId,
          kpId: input.kpId,
          gradeLevel: input.gradeLevel,
          request: input.request
        })}），下次同一个要求可以直接复用`
      )
      return true
    } catch (error) {
      log(
        `[animation] 存动画库失败（不影响本次显示）：${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return false
    }
  }

  /**
   * ★★ `compose_animation` 的主链路：**先复用 → 现做 → 存库 → （失败才）降级**。
   *
   * 与 {@link produce} 的差别（两条链路都不许改对方的脾气）：
   *   - **不问模板**：学生说的是「我想要什么样的动画」，模板表达不了才需要这个 Tool；
   *   - **先查库**：同一位学生问同一件事（复用键四维全中）→ 直接回上次那份，**零模型调用**；
   *   - **成功后存库**：尽力而为，失败只记日志（复用是增强，不是依赖）。
   */
  async function produceComposed(input: {
    toolCallId: string
    studentId: string
    concept: string
    request: string
    kpId: string
    gradeLevel: string
    caption: string | null
    reuseSaved: boolean
  }): Promise<
    | { kind: 'ok'; payload: AnimationPayloadShape; attempts: number; payloadId: string; reused: boolean }
    | { kind: 'degraded'; payload: AnimationPayloadShape; attempts: number; reason: string; payloadId: string; reused: false }
  > {
    const state = createProductionState(input.caption)
    const totalBudget = maxRetries + 1

    // ── 第一步：复用（默认开；`reuseSaved: false` 时跳过 —— 学生明确要「重新做一个」） ──
    if (input.reuseSaved && input.studentId) {
      const saved = await lookupSavedAnimation({
        studentId: input.studentId,
        kpId: input.kpId,
        gradeLevel: input.gradeLevel,
        request: input.request
      })
      if (saved !== null) {
        log(
          `[animation] 复用已保存的动画（${
            // 键里带请求指纹，日志只打「学生 / 知识点 / 学段 + 指纹前 8 位」，不落原话
            animationReuseKey({
              studentId: input.studentId,
              kpId: input.kpId,
              gradeLevel: input.gradeLevel,
              request: input.request
            })
          }）：本次没有模型调用`
        )
        return {
          kind: 'ok',
          payload: saved.payload,
          attempts: 0,
          payloadId: saved.payloadId,
          reused: true
        }
      }
    }

    // ── 第二步：现做一份（**与 generate_animation 的自由生成路径同一份实现**） ──
    const payloadId = newPayloadId()
    const generated = await runGenerationLoop({
      toolName: COMPOSE_ANIMATION_TOOL_NAME,
      toolCallId: input.toolCallId,
      state,
      concept: input.concept,
      kpId: input.kpId,
      gradeLevel: input.gradeLevel,
      caption: input.caption,
      payloadId,
      budget: totalBudget
    })

    if (generated !== null) {
      // ── 第三步：存库（**尽力而为**：失败只影响「下次还得现做」） ──
      await saveGeneratedAnimation({
        studentId: input.studentId,
        kpId: input.kpId,
        gradeLevel: input.gradeLevel,
        request: input.request,
        payload: generated
      })
      return { kind: 'ok', payload: generated, attempts: state.attempts, payloadId, reused: false }
    }

    // ── 第四条：降级（形状与 generate_animation 的降级一致，**出处标成 generated**：
    //     这条路径从头到尾不问模板，标 template 会让卡片显示「内置模板」＝ 对 UI 撒谎） ──
    return {
      kind: 'degraded',
      payload: finishDegraded(state, input.concept, '这次没有可用的生成路径', 'generated'),
      attempts: state.attempts,
      reason: state.lastReason || '这次没有可用的生成路径',
      payloadId,
      reused: false
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

          /**
           * ★★ 存入学生动画库（2026-09-26，D-088）：与 `compose_animation` 同一条纪律 —— **做出来就存**。
           *
           * 在此之前只有 compose 那条路存库，于是「同一件事走哪条 Tool」决定了它能不能留下：
           * 学生用 `generate_animation` 看到一段动画，回头在「我的动画」里却找不到，
           * 卡片上那个「我的」按钮也永远是灰的（它靠库里有匹配项才可点）。
           * 复用键里的「请求」一维用**概念** —— 这条路是按模板渲染的，概念就是它的身份。
           * 尽力而为（失败只影响「下次还得现做」），与 compose 那条路完全一致。
           */
          if (session?.studentId) {
            await saveGeneratedAnimation({
              studentId: session.studentId,
              kpId,
              gradeLevel,
              request: concept,
              payload: outcome.payload
            })
          }

          // 把「试了几次 / 为什么降级 / 托管地址 / payload_id」放进 details：
          // 事件层会把 details 展开成 payload（`agent/events.ts` 的 readPayload），
          // 轨迹图（`agent/trace.ts`）也会读其中的 `degraded` 标记。
          const details: AnimationCardPayload = {
            ...outcome.payload,
            payloadId: outcome.payloadId,
            resourceUrl,
            attempts: outcome.attempts,
            degradedFrom: outcome.kind === 'degraded' ? outcome.reason : null,
            // ★ 渲染侧要的那一维：**主进程解析出来的学段**（不是模型复述的那个）
            gradeLevel
          }
          return toolSuccess(renderAnimationText(outcome.payload), details)
        } catch (error) {
          // 兜底异常：给一句可读中文 + 统一失败形状（event 层据此发 degraded 的 error 事件）
          return toolFailure('动画讲解这一步没有完成。请直接用文字把这个概念讲清楚。', error)
        }
      }
    })

    /**
     * ★★ 第二个 Tool：**按学生具体要求实时做**（模板不参与）。
     *
     * 为什么值得再开一个 Tool（而不是给 `generate_animation` 加个开关）：
     * 模型面对的是**一句自然语言要求**（「想让小球越滚越快」），而 `generate_animation`
     * 的参数面是「选模板 + 填参数」—— 把两种意图塞进同一个参数面，模型要么把 `request`
     * 硬塞进 `concept`（概念名被写坏、复用键跟着错），要么退化成「先硬凑一个模板」。
     * 分开之后：`request` **必填**，模板参数**不存在**，两条路径各说各的事。
     *
     * 三条行为（与冻结口径一致）：
     *   ① 复用优先（`reuseSaved` 默认开）：同一位学生 + 同一个知识点 + 同一学段 +
     *      同一个要求 → 直接回上次那份，**零模型调用**；
     *   ② 没命中就现做（**与 `generate_animation` 的自由生成同一份实现**：模型出片段 →
     *      Python 拼装 + 校验 → 不过则重试 → 仍不过降级）；
     *   ③ 成功的产物**尽力存库**（失败只记日志）。
     *
     * ⚠️ 与 `generate_animation` 一样：`execute()` **绝不抛**；失败收敛成可读中文；
     *    降级走 `payload` 事件（`source` 仍是 `generated`，学生那侧看到的是「即时生成」）。
     */
    pi.registerTool({
      name: COMPOSE_ANIMATION_TOOL_NAME,
      label: '按需做动画',
      description:
        '按学生说出的具体要求**当场做一张动画卡片**（不套内置模板）。学生说「我想要……的动画」' +
        '「能不能让小球……」「做一个能看到……的过程」这类**描述得很具体**的要求时用它；' +
        '只是想让某个知识点有个动画，用 generate_animation（模板更快更稳）。' +
        '同一位学生问同一件事时会直接复用上次做好的那一份；做不出来时同样会降级为文字 + 静态图，不会失败。',
      promptSnippet: 'compose_animation：按学生的具体要求现做一张动画（同一位学生问同一件事会复用上次那份）',
      promptGuidelines: [
        'request 要照学生说的写（他想看到什么在动、怎么动），不要改写成教科书式的知识点定义。',
        '学生要的是一个知识点本身有个演示时用 generate_animation；只有在要求**具体到画面**时才用本工具。',
        '做不出来时系统会降级成文字 + 静态图，**你不需要**自己写 HTML，也不要向学生解释失败原因。'
      ],
      parameters: ComposeAnimationParams,
      execute: async (toolCallId: string, params: ComposeAnimationParamsType) => {
        // ★ 整段 execute 包在 try/catch 里：Pi 与 UI 同进程，抛异常会同时带走两者。
        try {
          const concept = readNonEmptyString(params?.concept)
          if (concept === null) {
            return toolFailure('做动画要先知道讲什么概念（例如「排序」「循环」）。')
          }
          const request = readNonEmptyString(params?.request)
          if (request === null) {
            return toolFailure('做动画要先知道学生想看什么，请把他说的那件事用一两句话写进 request。')
          }
          const session = currentAgentSession()
          const kpId = readNonEmptyString(params?.kpId) ?? ''
          // ★ 学段以**会话**为准（与 generate_animation / rag-search.ts 同一口径）
          const gradeLevel =
            readNonEmptyString(session?.gradeLevel) ?? readNonEmptyString(params?.gradeLevel) ?? 'primary_high'
          const caption = readNonEmptyString(params?.caption)
          // 默认**复用**（`undefined` 也算开）：省一次模型调用是这个 Tool 的一半意义
          const reuseSaved = params?.reuseSaved !== false

          const outcome = await produceComposed({
            toolCallId:
              typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : 'compose-animation',
            studentId: session?.studentId ?? '',
            concept,
            request,
            kpId,
            gradeLevel,
            caption,
            reuseSaved
          })

          if (outcome.kind === 'degraded') {
            log(`[animation] 按需做动画降级下发（第 ${outcome.attempts} 次尝试后）：${outcome.reason}`)
          }

          // 托管（票 16）：与 generate_animation 同一条口径 —— 只有真动画才托管，降级产物不托管。
          let resourceUrl: string | null = null
          if (outcome.payload.html.trim().length > 0 && session?.studentId) {
            resourceUrl = await hostHtml(
              session.studentId,
              libraryKpId(kpId),
              outcome.payloadId,
              outcome.payload.html
            )
          }

          const details: AnimationCardPayload = {
            ...outcome.payload,
            payloadId: outcome.payloadId,
            resourceUrl,
            attempts: outcome.attempts,
            degradedFrom: outcome.kind === 'degraded' ? outcome.reason : null,
            gradeLevel
          }
          return toolSuccess(renderComposedAnimationText(outcome.payload, outcome.reused), details)
        } catch (error) {
          // 兜底异常：给一句可读中文 + 统一失败形状（event 层据此发 degraded 的 error 事件）
          return toolFailure('这一步没有做成动画。请直接用文字把学生想看的那件事讲清楚。', error)
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
