/**
 * 动画**自由生成**适配器（票 17 的第二条路径：模板未命中时的补充）。
 *
 * ## 为什么需要单独一个文件
 *
 * `extensions/animation.ts` 里已经写好了完整的「模板优先 → 自由生成 → 降级」三段链路，
 * 但它的默认导出处（`animation.ts:827`）是 `createAnimationExtension()` —— **没接 `generate`**。
 * 于是「模板未命中」直接落到文字降级，文档 §11.2 与票 17 写的「自由生成是模板未命中时的
 * 补充路径」**在产物里不可达**（审计结论：测试覆盖了这条分支，但生产代码走不进去）。
 *
 * 本文件就是那条注入：`runtime.ts` 把它接到 `createAnimationExtension({ generate })` 上。
 *
 * ## ★ 一次生成要跨两个进程，顺序不能反
 *
 * 模型的产物**不能直接当 HTML 用**：沙箱 HTML 必须
 *   - 内联 Anime.js（断网演示，任何 CDN 引用都会白屏）、
 *   - 内联沙箱运行时（`window.Sandbox` / `Sandbox.ready(`）、
 *   - 注入 `payload_id`（同屏多卡片的串台防线）、
 *   - 通过 Python 的 `validate_animation_html()` 全套校验。
 * 这些**只有 Python 侧做得到**（库文件与校验器都在 `server/resources/templates/_shared/`），
 * 所以自由生成的分工是：
 *
 *     ① 模型产出**片段**（`body` + `script`，就是一份模板的内容，不含库与运行时）
 *     ② Python 用同一套 `compose_animation_html()` 把它拼成完整 HTML 并**校验**
 *     ③ 校验不过 → 422（可读原因）→ TS 侧重试（≤3）→ 仍不过 → 降级文字 + 静态图
 *
 * ⚠️ **不让模型直接吐整份 HTML**：那样它得知道动画库的版本与内联方式，而且我们要在 TS 侧
 *    另写一遍「内联库 + 校验」——那是**第二套实现**，与 Python 的校验器必然漂移。
 *    这里复用 Python 的合流点，等于把「不合格的产物绝不下发」这条纪律保持在一个地方。
 *
 * ## 降级（无 Key 时的行为）
 *
 * 无 Key → 第一步就失败（`createModelCompleter` 把 Pi 的「缺凭证」收敛成可读错误）
 * → `generate` 抛错 → `produce()` 的自由生成循环走完 → **降级为文字 + 静态 SVG**
 * （一个合法的 `source: "template"` 载荷走 `payload` 事件）→ **学生看到一张卡片，不是白屏**。
 */

import { apiFetch } from '../../bridge/client.ts'
import type { TextCompleter } from '../safety/review.ts'

/** 合流端点（**只在这一个地方写路径**）：把它拼成完整沙箱 HTML 并校验。 */
export const ANIMATION_COMPOSE_PATH = '/api/animation/compose'

/** 一次生成的超时（毫秒）。动画是「锦上添花」的能力，不值得让学生等太久。 */
export const ANIMATION_GENERATE_TIMEOUT_MS = 20_000

/** 模型这一轮最多写多少 token（片段 + 文案，不需要很长）。 */
export const ANIMATION_GENERATE_MAX_TOKENS = 2_600

/** 生成请求（与 `extensions/animation.ts` 的 `AnimationGenerationRequest` 同形状）。 */
export interface AnimationGenerateRequest {
  concept: string
  kpId: string
  gradeLevel: string
  attempt: number
  previousReason?: string
}

/** 模型产出的**片段**（不含库、不含运行时；由 Python 拼装）。 */
export interface AnimationFragment {
  /** 页面片段（HTML，不含 `<html>` / `<script>`）。 */
  body: string
  /** 模板脚本（用 `Sandbox.play(function () { anime({...}) })` 注册播放实现）。 */
  script: string
  /** 降级文案（**必填**：动画失败时就用它讲）。 */
  fallbackText: string
  /** 动画时长（毫秒，必须 > 0）。 */
  durationMs: number
  /** 卡片标题（可选，缺省用概念名）。 */
  title?: string
}

/** 合流出口（默认 `apiFetch`；测试注入假实现，从而**不需要 sidecar**）。 */
export type AnimationComposer = (
  request: AnimationFragment & { concept: string; kpId: string; gradeLevel: string; payloadId: string }
) => Promise<unknown>

/** 默认合流出口：`POST /api/animation/compose`。 */
export const postAnimationCompose: AnimationComposer = async (request) => {
  const response = await apiFetch(ANIMATION_COMPOSE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(ANIMATION_GENERATE_TIMEOUT_MS)
  })
  if (response.status === 422) {
    // 校验不过 = **可重试**（与模板路径的 422 同一语义）
    const detail = await readSnippet(response)
    throw new RetryableGenerationError(`自由生成的产物未通过校验${detail ? `：${detail}` : ''}`)
  }
  if (!response.ok) {
    const detail = await readSnippet(response)
    throw new Error(`动画合流服务返回 HTTP ${response.status}${detail ? `（${detail}）` : ''}`)
  }
  return await response.json()
}

/**
 * 可重试的生成失败。
 *
 * `extensions/animation.ts` 的自由生成循环对**任何**异常都会继续下一次尝试（累计到上限），
 * 所以这里区分「可重试 / 不可重试」只是为了给日志与 `previousReason` 一句更准的话；
 * 真正的重试上限由扩展统一把持（**只有一个计数器**，见 animation.ts 的 `noteRetry`）。
 */
export class RetryableGenerationError extends Error {
  readonly retryable = true
}

/** 一次生成的可选依赖（全部可注入，便于单测在没有模型、没有 sidecar 的情况下覆盖全部分支）。 */
export interface AnimationGeneratorOptions {
  /** 模型文本补全（`runtime.ts` 用 `createModelCompleter` 接上来；**无 Key 时为 `null`**）。 */
  complete: TextCompleter | null
  /** 合流出口（默认 `postAnimationCompose`）。 */
  compose?: AnimationComposer
  log?: (line: string) => void
}

/**
 * 建一个 `generate`（交给 `createAnimationExtension({ generate })`）。
 *
 * ★ **无 Key 时的行为**：`complete` 为 `null` → 直接抛「自由生成不可用（没有 API Key）」
 * → 扩展的自由生成循环立刻结束 → 降级为文字 + 静态图。
 * 全程**不发网络请求、不写盘、不产生白屏**。
 */
export function createAnimationGenerator(
  options: AnimationGeneratorOptions
): (request: AnimationGenerateRequest) => Promise<unknown> {
  const compose = options.compose ?? postAnimationCompose
  const log = options.log ?? ((line: string) => console.warn(line))

  return async (request) => {
    const complete = options.complete
    if (!complete) {
      // 无 Key：这不是故障，而是「这条补充路径本轮不可用」。扩展会直接降级（有兜底，不白屏）。
      throw new Error('自由生成不可用：本机没有配置 API Key（这条是模板未命中时的补充路径）')
    }

    const prompt = buildFragmentPrompt(request)
    const raw = await complete({ prompt, timeoutMs: ANIMATION_GENERATE_TIMEOUT_MS })
    const fragment = parseAnimationFragment(raw)
    if (!fragment) {
      // 模型没按 JSON 回 → 交回扩展重试（它会把这句话带进下一次的 `previousReason`）
      throw new RetryableGenerationError('自由生成的结果不是合法 JSON 片段（缺 body / script / fallbackText）')
    }

    log(
      `[animation] 自由生成：概念「${request.concept}」第 ${request.attempt + 1} 次尝试` +
        `（片段 body ${fragment.body.length} 字符 / script ${fragment.script.length} 字符）`
    )

    // 交回 Python 拼装 + 校验（唯一能把库内联进去、也是唯一持有校验器的一方）
    return await compose({
      ...fragment,
      concept: request.concept,
      kpId: request.kpId,
      gradeLevel: request.gradeLevel,
      // 合流端点的 payload_id 由它自己生成（`validate_payload_id` 有兜底）；
      // 这里不传随机串，避免「随机 id 与卡片手里的 id 对不上」那类串台问题。
      payloadId: ''
    })
  }
}

/**
 * 生成用 prompt。
 *
 * 三条约束都写进去了，因为它们各自对应一条会白屏的失败：
 *   1. **不许引 CDN**（沙箱断网）→ 只用全局 `anime`（库由服务端内联）；
 *   2. **必须调 `Sandbox.play(fn)`**（否则宿主永远等不到播放实现）；
 *   3. **不许访问宿主 DOM / 发网络请求**（沙箱里不存在，脚本会当场抛）。
 */
export function buildFragmentPrompt(request: AnimationGenerateRequest): string {
  const lines = [
    '你在为一个 K12 人工智能通识课的动画沙箱生成一段**页面片段与脚本**（不是完整 HTML）。',
    `概念：${request.concept}`,
    `学段：${request.gradeLevel}（小学低/高、初中、高中；语言与深度要贴这个学段）。`
  ]
  if (request.kpId) lines.push(`知识点 id：${request.kpId}`)
  lines.push(
    '',
    '硬性约束（违反会导致产物被校验器拒绝）：',
    '1. 禁止任何外部引用：不能出现 http(s) 链接、CDN、外链字体或图片；动画库 anime.js 已由服务端内联，',
    '   直接用全局变量 `anime` 即可，**不要**自己引入它。',
    '2. `script` 里必须调用 `Sandbox.play(function () { /* 返回一个 anime 动画实例 */ })` 来注册播放实现；',
    '   可选：`Sandbox.onProgress(function (p) {})`（p 在 0~1）。',
    '3. `script` 里禁止发起网络请求（fetch / XMLHttpRequest）；禁止访问 `parent.document` / `window.top`；禁止 `throw`。',
    '4. 只用 DOM 与内联 SVG 作画，不要用 canvas（沙箱里没有额外的库）。',
    '5. `body` 只写页面内容（不要 <html>/<head>/<script> 标签）；`script` 只写脚本内容（不要 <script> 标签）。',
    '6. 内容要短小：3~6 秒能看完，聚焦一个点，配一句解说 `<p>`。'
  )
  if (request.previousReason) {
    lines.push('', `上一次尝试失败的原因（这次要避开）：${request.previousReason}`)
  }
  lines.push(
    '',
    '只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块：',
    '{',
    '  "title": "卡片标题（不超过 20 字）",',
    '  "body": "页面片段 HTML",',
    '  "script": "注册播放实现的脚本",',
    '  "fallbackText": "动画失败时给学生看的一段讲解（1~2 句）",',
    '  "durationMs": 5000',
    '}'
  )
  return lines.join('\n')
}

/**
 * 解析模型返回的片段（**宽松读、严格校验**）。
 *
 * 模型可能包 ```json 围栏、可能多嘴几句，所以先剥壳再取第一个 JSON 对象；
 * 但取值必须合法（`body` / `script` / `fallbackText` 非空、`durationMs > 0`），否则返回 `null`
 * —— **脏值绝不放行**：它会被送进校验器，而校验器的 422 是「可重试」信号。
 */
export function parseAnimationFragment(raw: string): AnimationFragment | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const stripped = raw.replace(/```(?:json)?/gi, ' ')
  const matched = /\{[\s\S]*\}/.exec(stripped)
  if (!matched) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(matched[0])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>

  const body = readText(record.body)
  const script = readText(record.script)
  const fallbackText = readText(record.fallbackText ?? record.fallback_text)
  if (body === null || script === null || fallbackText === null) return null

  const durationRaw = record.durationMs ?? record.duration_ms
  const duration = typeof durationRaw === 'number' ? durationRaw : Number(durationRaw)
  if (!Number.isFinite(duration) || duration <= 0) return null

  return {
    body,
    script,
    fallbackText,
    durationMs: Math.trunc(duration),
    title: readText(record.title) ?? undefined
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

async function readSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return ''
  }
}
