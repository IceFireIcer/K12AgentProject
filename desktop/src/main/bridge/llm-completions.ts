/**
 * ★ 全应用**唯一**对「外部大模型服务」发 HTTP 请求的地方。
 *
 * 与 `bridge/client.ts` 并列，但**管的不是同一条路**：
 *
 * | 出口 | 对端 | 凭证 | 纪律 |
 * | --- | --- | --- | --- |
 * | `bridge/client.ts` | **本地 sidecar**（127.0.0.1） | 每次启动新铸的 `X-Auth-Token` | 只有它能打 `/api/*` |
 * | 本文件 | **外部 LLM 供应商**（用户在设置里填的 baseUrl） | 供应商的 `Authorization: Bearer` | 只有它能带供应商 Key 出网 |
 *
 * ★ 为什么必须单独一个文件（而不是在某个调用点就地 `fetch`）：
 *   架构守卫 G5 按「`fetch(` 出现在哪些文件里」来守住「凭证注入只有一处」。
 *   让每个调用点各写一次 `fetch`，等于让「Key 在哪里被拼进 header」这个问题
 *   有几个调用点就有几个答案 —— 而它一旦答错，形态是**明文 Key 进了日志或错误回显**。
 *   所以本文件是**唯一**出现 `fetch(` 的非 sidecar 出口；调用点只递 URL / headers /
 *   body，不碰网络。
 *
 * ★ 边界（四条硬边界里的第 2 条：编排域只在 TypeScript）：
 *   模型**只能由主进程调**。Python sidecar 不装 langgraph/langchain、不调 LLM
 *  （`server/pyproject.toml` 有注释钉死），所以供应商 Key 只在主进程内存里流转，
 *   绝不进 sidecar、绝不进渲染进程、绝不落 state。
 *
 * ★ 本文件**不做**的事：不组 prompt、不解析回执、不重试。那些是调用点（如
 *   `agent/onboarding/summarize-llm.ts`）的职责 —— 重试与解析需要被单测覆盖，
 *   塞进网络出口就只能用真网络测了。
 */

/**
 * 一次 chat/completions 出网请求。
 *
 * ★ `headers` 由调用点给（含 `Authorization`）—— 本文件**不认识**任何 Key，
 *   也就不可能在错误信息里回显它。
 */
export interface LlmChatRequest {
  url: string
  headers: Record<string, string>
  body: string
  /** 超时（毫秒）。调用点必须给一个有限值：本机回环之外，对面可能永远不回。 */
  timeoutMs: number
}

/** 调用点给 span 的分类与上屏文案（可省：省了就回落中性文案）。 */
export interface LlmChatSpanOptions {
  /** 分类：五问概括 / 画像刷新 / 画像小结 / 出题 / 动画生成 / 编程提示。 */
  purpose?: string
  /** 上屏文案（中文、无技术词）。 */
  label?: string
  /** 模型名（调用点最清楚）；省了就从请求体里读 `model`。 */
  model?: string
}

/**
 * 出网口交给上层的**一次调用事实**（只有体量与结论，**绝不含 prompt 正文**）。
 * 采集端（`agent/diagnostics.ts`）把它补成信封里的 {@link RuntimeSpan}。
 */
export interface RuntimeSpanEvent {
  purpose: string
  label: string
  model: string | null
  promptChars: number
  startedAt: number
  ms: number
  ok: boolean
  note: string | null
}

/** span 采集口（由 `agent/diagnostics.ts` 在模块加载时注册）。 */
export type RuntimeSpanSink = (event: RuntimeSpanEvent) => void
let runtimeSpanSink: RuntimeSpanSink | null = null

/**
 * 注册 span 采集口（**唯一调用点在 `agent/diagnostics.ts` 的模块作用域**）。
 *
 * ★ 为什么用「注册口」而不是让本文件 import 采集端：bridge 是更低的层，
 *   反过来依赖 agent 会把 fs / crypto 拖进只该管网络的模块（也容易成环）。
 */
export function setRuntimeSpanSink(sink: RuntimeSpanSink | null): void {
  runtimeSpanSink = sink
}

/** 出网口（可注入；生产用本文件里的 `llmFetch`，测试用替身断言请求体）。 */
export type LlmChatFetch = (url: string, init: RequestInit, span?: LlmChatSpanOptions) => Promise<Response>

/** 只允许 http(s)：配置里被塞进 `file://` / `data:` 之类的地址时不许真的发出去。 */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

/**
 * 对外部大模型服务发一次请求。
 *
 * ★ 失败形态：网络层抛异常就**原样抛出**，由调用点翻译成可读的降级理由
 *   （本文件不知道调用点的业务语义，不该替它决定「降级还是重试」）。
 * ★ 超时用 `AbortSignal.timeout`：sidecar 之外的对端可能挂住不回。
 */
export async function llmFetch(
  url: string,
  init: RequestInit,
  span?: LlmChatSpanOptions
): Promise<Response> {
  if (!isHttpUrl(url)) throw new Error('模型服务地址不是 http(s)，已拒绝出网')
  // ★ 打点在这里 —— 本文件是全应用唯一的模型出网口（D-116），所以旁路子代理
  //   （不经过 Pi、extension 看不到的那几条）一个都漏不掉。
  const startedAt = Date.now()
  const summary = readPromptSummary(init?.body, span?.model)
  const base: Omit<RuntimeSpanEvent, 'ms' | 'ok' | 'note'> = {
    purpose: readOption(span?.purpose, DEFAULT_SPAN_PURPOSE),
    label: readOption(span?.label, DEFAULT_SPAN_LABEL),
    model: summary.model,
    promptChars: summary.promptChars,
    startedAt
  }
  try {
    const response = await fetch(url, init)
    emitRuntimeSpan({
      ...base,
      ms: Math.max(0, Date.now() - startedAt),
      ok: response.ok,
      note: response.ok ? null : 'HTTP ' + String(response.status)
    })
    return response
  } catch (error) {
    emitRuntimeSpan({
      ...base,
      ms: Math.max(0, Date.now() - startedAt),
      ok: false,
      note: describeSpanFailure(error)
    })
    throw error
  }
}

/** 没给 purpose/label 时的中性回落（组件按 purpose 分泳道，所以别给空串）。 */
const DEFAULT_SPAN_PURPOSE = '子代理'
const DEFAULT_SPAN_LABEL = '一次子代理模型调用'

function readOption(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * 从请求体里读「模型名 + 提示词字符数」——**只取数字与模型名，不保留任何正文**。
 * 读不出（不是 JSON / 没有 messages）时退回 body 的总长度：仍然只是个体量。
 */
function readPromptSummary(
  body: unknown,
  modelHint?: string
): { model: string | null; promptChars: number } {
  const hint = typeof modelHint === 'string' && modelHint.trim() !== '' ? modelHint.trim() : null
  if (typeof body !== 'string' || body === '') return { model: hint, promptChars: 0 }
  try {
    const parsed = JSON.parse(body) as { model?: unknown; messages?: unknown }
    const model =
      typeof parsed.model === 'string' && parsed.model.trim() !== '' ? parsed.model.trim() : hint
    let chars = 0
    if (Array.isArray(parsed.messages)) {
      for (const item of parsed.messages) {
        if (typeof item !== 'object' || item === null) continue
        const content = (item as { content?: unknown }).content
        if (typeof content === 'string') chars += content.length
      }
    }
    return { model, promptChars: chars > 0 ? chars : body.length }
  } catch {
    return { model: hint, promptChars: body.length }
  }
}

/**
 * 失败原因收敛成**可落盘的形状**：抹掉 URL 查询串（供应商网关常把凭据放那里）、
 * 折成一行、截断；**不含正文**（错误信息本来就不该带正文，这里再兜一道）。
 */
function describeSpanFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/https?:\/\/[^\s"']+/gi, (url) => url.split('?')[0] ?? url)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

function emitRuntimeSpan(event: RuntimeSpanEvent): void {
  try {
    runtimeSpanSink?.(event)
  } catch {
    /* 诊断是旁路：采集端坏掉绝不该影响模型调用本身 */
  }
}

/**
 * 造一个带超时的出网 `RequestInit`（调用点少写一遍，也少一处「忘了设超时」）。
 *
 * ⚠️ 复用同一个 `signal` 打第二次请求是错的（第一次的请求可能还在飞），
 *    所以每次都要新造一个 —— 这也是它做成函数而不是常量的原因。
 */
export function llmPostInit(
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): RequestInit {
  return {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs)
  }
}
