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

/** 出网口（可注入；生产用本文件里的 `llmFetch`，测试用替身断言请求体）。 */
export type LlmChatFetch = (url: string, init: RequestInit) => Promise<Response>

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
export async function llmFetch(url: string, init: RequestInit): Promise<Response> {
  if (!isHttpUrl(url)) throw new Error('模型服务地址不是 http(s)，已拒绝出网')
  return await fetch(url, init)
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
