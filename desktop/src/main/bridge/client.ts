/**
 * ★ 全应用**唯一**与 Python sidecar 通信的 HTTP 客户端。
 *
 * 架构规则（有守卫测试，见 `tests/architecture-guards.test.ts`）：
 *   - 只有本文件可以对 sidecar 发请求；**渲染进程永不直连 sidecar**。
 *     渲染进程一旦自己发请求，token 下发与跨源/CORS 那一整类故障就会全部回来。
 *   - **token 绝不下发到渲染进程**：票 02 在此处统一注入 `X-Auth-Token`
 *     （每次启动随机生成的 hex token，经 `--token` 传给 Python）。
 *   - 除 `/health`（匿名探活）外，所有 `/api/*` 都必须带 token。
 *
 * 端点的**唯一真相**是 sidecar 握手结果：`SidecarManager` 在握手成功时调用
 * {@link configureSidecarEndpoint}，停止/失败时调用 {@link clearSidecarEndpoint}。
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
 * ★ 当前 sidecar 端点：**只存在于主进程内存**。
 * token 由 `sidecar/manager.ts` 每次启动时新铸（`randomBytes(32).toString('hex')`），
 * **绝不进 state、绝不发 IPC、绝不给渲染进程**（有架构守卫）。
 */
interface SidecarEndpoint {
  port: number
  token: string
}

let endpoint: SidecarEndpoint | null = null

/** `SidecarManager` 握手成功后把端口与 token 交到这里（token 只进这一处内存）。 */
export function configureSidecarEndpoint(port: number, token: string): void {
  endpoint = { port, token }
}

/** sidecar 停止/失败/被放弃时清空端点：之后任何 `/api` 请求都会立刻失败而不是裸奔到 401。 */
export function clearSidecarEndpoint(): void {
  endpoint = null
}

/** 是否已经拿到可用端点（诊断/测试用，**不返回 token**）。 */
export function hasSidecarEndpoint(): boolean {
  return endpoint !== null
}

/**
 * 对 sidecar 发**带鉴权**的请求（除 `/health` 外的所有 `/api/*`）。
 *
 * 唯一出口就在本文件：token 注入只有这一处，
 * 调用方（Tool / IPC 处理器）拿不到 token，也就不可能把它漏给渲染进程。
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (endpoint === null) {
    // 还没有端点（sidecar 未启动/已停止）：直接失败，别让请求裸奔到 401
    throw new Error('sidecar 尚未就绪（无端口与 token），无法发起 /api 请求。')
  }

  const headers = new Headers(init.headers)
  headers.set('X-Auth-Token', endpoint.token)

  return await fetch(`http://127.0.0.1:${endpoint.port}${path}`, { ...init, headers })
}

/**
 * 探活：`GET /health`（**匿名**，不带 token —— 它是启动期唯一可用的入口）。
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
