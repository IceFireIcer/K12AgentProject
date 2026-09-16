/**
 * ★ 全应用**唯一**与 Python sidecar 通信的 HTTP 客户端。
 *
 * 架构规则（有守卫测试，见 `tests/architecture-guards.test.ts`）：
 *   - 只有本文件可以对 sidecar 发请求；**渲染进程永不直连 sidecar**。
 *     渲染进程一旦自己发请求，token 下发与跨源/CORS 那一整类故障就会全部回来。
 *   - **token 绝不下发到渲染进程**：票 02 在此处统一注入 `X-Auth-Token`
 *     （每次启动随机生成的 hex token，经 `--token` 传给 Python）。
 *   - 除 `/health`（匿名探活）外，所有 `/api/*` 都必须带 token。
 */

import { healthUrl } from '../sidecar/protocol'

/** `GET /health` 的响应体（§6.3）。 */
export interface HealthPayload {
  status: string
  version: string
  /** 嵌入模型是否就绪；模型缺失时为 false，但不影响 sidecar 存活。 */
  embedderReady: boolean
}

/**
 * 探活：`GET /health`。
 * 返回 `null` 表示「还没准备好」（未监听 / 超时 / 非 2xx）——
 * 这是启动期的**正常状态**，不是错误，调用方据此继续轮询。
 */
export async function probeHealth(port: number, timeoutMs = 1500): Promise<HealthPayload | null> {
  try {
    const response = await fetch(healthUrl(port), {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return null

    const raw = (await response.json()) as Record<string, unknown>
    return {
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      version: typeof raw.version === 'string' ? raw.version : 'unknown',
      // 契约出参统一 camelCase（pydantic alias）；这里对 snake_case 兜一手，
      // 免得后端字段风格一变，探活就静默失效。
      embedderReady: Boolean(raw.embedderReady ?? raw.embedder_ready ?? false)
    }
  } catch {
    return null
  }
}
