/**
 * 后端 HTTP 客户端（渲染层）。
 *
 * 职责：
 * 1. **统一注入 `X-Auth-Token`**——token 从 sidecar store 实时取，
 *    ⚠️ **绝不缓存**：sidecar 每次启动/重启都会换新 token（见 S01 文档第 7 节）。
 * 2. 统一错误语义（把 401 / 网络错误翻译成可读中文）。
 * 3. 提供 `streamSse()`：`fetch` + `ReadableStream` 流式读取。
 *
 * **为什么不用 `EventSource`**：它只支持 GET 且不能带自定义 header，
 * 我们的 token 需要 header，鉴权必然 401（S02 DoD 硬性要求）。
 */

import type { components } from '../../../shared/api-types'
import { SseParser, type SseEvent } from './sse-parser'

/** 后端基址：从 sidecar 快照取（端口由系统分配，每次可能不同）。 */
export interface BackendEndpoint {
  port: number
  token: string
}

/** 后端不可用（未就绪 / 端口丢失）。 */
export class BackendUnavailableError extends Error {
  constructor(message = '后端服务尚未就绪，请稍后再试') {
    super(message)
    this.name = 'BackendUnavailableError'
  }
}

/** 带了 token 仍被拒（401）——通常意味着 sidecar 重启过，token 已轮换。 */
export class UnauthorizedError extends Error {
  constructor() {
    super('鉴权失败（token 可能已失效，后端重启会更换 token），请稍后重试')
    this.name = 'UnauthorizedError'
  }
}

/** 后端返回了非 2xx。 */
export class BackendHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'BackendHttpError'
  }
}

export function baseUrl(endpoint: BackendEndpoint): string {
  if (!endpoint.port) throw new BackendUnavailableError()
  return `http://127.0.0.1:${endpoint.port}`
}

function authHeaders(endpoint: BackendEndpoint, json = false): Record<string, string> {
  const headers: Record<string, string> = { 'X-Auth-Token': endpoint.token }
  if (json) headers['Content-Type'] = 'application/json'
  return headers
}

/** 解析后端错误体（FastAPI 的 `{detail}` 或 `{detail:[...]}` 校验错误）。 */
async function describeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    const detail = body?.detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      // pydantic 422：把字段路径挑出来，比整段 JSON 有用得多
      const parts = detail
        .map((item) => {
          const loc = Array.isArray(item?.loc) ? item.loc.join('.') : ''
          return `${loc}: ${item?.msg ?? ''}`.trim()
        })
        .filter(Boolean)
      if (parts.length) return `参数校验失败 — ${parts.join('；')}`
    }
  } catch {
    /* 非 JSON 响应体（如代理返回的 HTML），走下面的兜底 */
  }
  return `后端返回 HTTP ${res.status}`
}

/** 带 token 的 JSON 请求。 */
export async function requestJson<T>(
  endpoint: BackendEndpoint,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${baseUrl(endpoint)}${path}`, {
    method: init.method ?? 'GET',
    headers: authHeaders(endpoint, init.body !== undefined),
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new BackendHttpError(res.status, await describeError(res))
  return (await res.json()) as T
}

export interface StreamSseOptions {
  path: string
  body: unknown
  /** 单个事件回调。 */
  onEvent: (event: SseEvent) => void
  /** 外部取消（如用户点「停止」）。 */
  signal?: AbortSignal
}

/**
 * 流式消费 SSE 端点。
 *
 * 实现要点（每一条都对应一个真实翻车点）：
 * - `TextDecoder('utf-8')` + **`{ stream: true }`**：不带的后果是跨 chunk 的
 *   汉字解成 `�`（中文场景必现）。
 * - 响应体为 `null`（无 body）时立刻报错，而不是卡死。
 * - 读到 EOF 后必须 `parser.flush()`，否则最后一块（若后端漏发空行）会被丢掉。
 */
export async function streamSse(endpoint: BackendEndpoint, options: StreamSseOptions): Promise<void> {
  const res = await fetch(`${baseUrl(endpoint)}${options.path}`, {
    method: 'POST',
    headers: { ...authHeaders(endpoint, true), Accept: 'text/event-stream' },
    body: JSON.stringify(options.body),
    signal: options.signal
  })

  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new BackendHttpError(res.status, await describeError(res))
  if (!res.body) throw new BackendHttpError(res.status, '后端未返回流式响应体')

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = new SseParser(options.onEvent)

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // ★ stream:true —— 多字节字符可能被 chunk 边界切开
      parser.push(decoder.decode(value, { stream: true }))
    }
    // 收尾：冲刷解码器残字节 + 解析器残留块
    parser.push(decoder.decode())
    parser.flush()
  } finally {
    reader.releaseLock()
  }
}

/** 便捷别名（用的是生成类型，改契约即在这里报错）。 */
export type SettingsResponse = components['schemas']['SettingsResponse']
export type SettingsUpdateRequest = components['schemas']['SettingsUpdateRequest']
export type LlmConfig = components['schemas']['LlmConfig']
export type EmbeddingConfig = components['schemas']['EmbeddingConfig']
export type ChatRequest = components['schemas']['ChatRequest']
export type GradeLevel = components['schemas']['GradeLevel']
