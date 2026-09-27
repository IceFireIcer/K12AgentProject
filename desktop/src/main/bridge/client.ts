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

// ⚠️ 相对导入**必须带 `.ts` 后缀**（与 `src/main/index.ts` 同一条纪律）：
//    electron-vite 的产物是 ESM，ESM 不做扩展名补全；`node --test` / `scripts/*.mjs`
//    直接 import 本文件时也走同一套解析规则。少了后缀就只有打包器能读懂，裸 Node 会 404。
import { healthUrl } from '../sidecar/protocol.ts'
// ★ 演示沙箱的覆盖层（未激活时严格 no-op）。它与本文件**没有**循环依赖：
//   `demo/overlay.ts` 只 import 纯数据模块，不回头 import 这里。
import { demoResponseFor } from '../demo/overlay.ts'

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

/**
 * `/api/*` 请求的**默认超时**（调用点没显式给 `signal` 时的兜底）。
 *
 * 为什么必须有兜底 —— sidecar「**在监听但不回话**」（SQLite 锁等待 / 进程被暂停 / handler 卡住）
 * 时，裸 `fetch` 会一直吊到 Node 的默认 `headersTimeout`（**300s**）。而退出流程是
 * 「先 `disposeChatRuntime()`（其中会等学段上交队列的最后一个 `/api` 调用）→ 再 `taskkill` sidecar」，
 * 于是关窗后进程最长可挂约 5 分钟、sidecar 也迟迟杀不掉（用户只能去任务管理器）。
 * 8s 与设置域的超时同量级：本机回环毫秒级返回，8s 已经等于「对面卡死了」。
 *
 * ⚠️ 需要更长预算的调用点（比如真的要走一次外呼的探测）**必须显式传自己的 `signal`** ——
 * 有了它这个兜底就不生效（`??` 只在缺省时接管）。
 */
export const DEFAULT_API_TIMEOUT_MS = 8_000

/**
 * 对 sidecar 发**带鉴权**的请求（除 `/health` 外的所有 `/api/*`）。
 *
 * 唯一出口就在本文件：token 注入只有这一处，
 * 调用方（Tool / IPC 处理器）拿不到 token，也就不可能把它漏给渲染进程。
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // ★★ 演示沙箱的覆盖层 —— **必须在端点检查之前**（见 `demo/overlay.ts` 的说明）：
  //    沙箱态下学生态的读请求根本不从服务端取，所以「有没有服务端」与它无关；
  //    放到下面那行之后，断网 / 冷启动的现场演示会一条数据都出不来。
  //    ⚠️ 未激活时它是**严格 no-op**（返回 `null`），普通态下这一层等于不存在。
  //    ★ `await` 只为了「动画库取一条」那条要真渲染一次；未激活 / 未命中时它当场返回，
  //      这一行对热路径只是多一个微任务，没有额外请求。
  const intercepted = await demoResponseFor(path, init)
  if (intercepted !== null) return intercepted

  if (endpoint === null) {
    // 还没有端点（sidecar 未启动/已停止）：直接失败，别让请求裸奔到 401
    throw new Error('sidecar 尚未就绪（无端口与 token），无法发起 /api 请求。')
  }

  const headers = new Headers(init.headers)
  headers.set('X-Auth-Token', endpoint.token)
  // ★ 兜底超时（见 {@link DEFAULT_API_TIMEOUT_MS}）：显式传了 signal 的调用点原样透传，不受影响
  const signal = init.signal ?? AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS)

  return await fetch(`http://127.0.0.1:${endpoint.port}${path}`, { ...init, headers, signal })
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
