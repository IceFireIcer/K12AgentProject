/**
 * ★★ **设置 → Pi** 的唯一桥梁（主进程侧）。
 *
 * 为什么需要这一层：设置的权威副本在 Python 的 `config.json`（原子写、损坏备份、
 * snake/camel 双写容忍、API Key 掩码语义都在 `server/app/settings_store.py`），
 * 而 Pi 需要**明文 Key** 才能发请求。渲染进程那一侧读设置只回掩码，
 * 于是「设置页改了配置 → Pi 用新配置」这条链路在两侧之间断掉了 —— 症状是
 * **改完设置重启应用，Pi 仍用旧配置**（实测踩到）。
 *
 * 本模块负责：
 *   1. 从 sidecar 的 `GET /api/settings/runtime` 取「真正生效的那份配置」（**含明文 Key**）；
 *   2. 进程内缓存，供「建会话前」与「保存设置后」两处复用；
 *   3. 失败时干净降级（返回 `null`）—— sidecar 没起来时应用仍要能启动、能聊天降级，
 *      而不是白屏或抛异常。
 *
 * ⚠️ **安全边界**（三条一起才成立）：
 *   - 明文 Key **只在本文件与 `runtime.ts` 之间流转**，只经 `setRuntimeApiKey()` 进内存；
 *   - 绝不写盘（不落 `auth.json`、不落日志、不进 `models.json`）；
 *   - 绝不发渲染进程 —— 没有对应 IPC 通道，preload 也没有对应方法（架构守卫会断言）。
 */

import { apiFetch } from '../bridge/client.ts'

/** 「真正生效」的 LLM 配置（字段与契约 `LlmRuntimeConfig` 对齐）。 */
export interface RuntimeLlmConfig {
  providerId: string
  providerName: string
  baseUrl: string
  modelId: string
  /** ★ 明文 Key（空串 = 未配置）。只进内存，绝不落盘 / 绝不外发。 */
  apiKey: string
  hasKey: boolean
}

/** 进程内缓存：`null` = 还没成功取过。 */
let cached: RuntimeLlmConfig | null = null

/** 取设置的超时（本机回环，正常毫秒级；超了就是 sidecar 卡住）。 */
const RUNTIME_CONFIG_TIMEOUT_MS = 8_000

/** 只提示一次（每轮对话都刷屏会把日志淹掉，反而让人忽略它）。 */
let degradedWarned = false

/**
 * 从 sidecar 拉一次「生效中的 LLM 配置」并刷新缓存。
 *
 * **永不抛异常**：拿不到**新鲜**配置时返回 `null`（取到过则回落到缓存值 `cached`），
 * 调用方据此走「降级装配 / 本次不动配置」两条路。
 *
 * ★ 返回值语义（两者都是 `null` 与「有值」之外的唯一区别所在，别把它读错）：
 *   - **非 null** = 本次拿到的就是**当前生效**的配置（可能是新鲜回执，也可能是上一次的成功值）；
 *   - **null** = 本次**没有**可用的生效配置（从没取到过、且这次也失败）。
 *   调用方（`ipc/handlers.ts`）用 `llm === null` 判定「本次是降级装配」——
 *   所以「保留缓存」这个行为对它是**透明的**：缓存命中时它本来就该按旧配置继续用。
 *   ⚠️ 也正因如此，**不要**在这里改成「失败一律 `return null`」：那会把
 *   「sidecar 抖一下」升级成「把已经拿到的配置丢掉」。
 */
export async function refreshRuntimeLlmConfig(): Promise<RuntimeLlmConfig | null> {
  try {
    const response = await apiFetch('/api/settings/runtime', {
      method: 'GET',
      signal: AbortSignal.timeout(RUNTIME_CONFIG_TIMEOUT_MS)
    })
    if (!response.ok) {
      warnDegraded(`后端回执 HTTP ${response.status}`)
      return cached
    }

    const data = (await response.json()) as unknown
    const parsed = parseRuntimeLlmConfig(data)
    if (!parsed) {
      warnDegraded('后端回执不符合契约（缺 providerId / modelId 等字段）')
      return cached
    }

    cached = parsed
    degradedWarned = false
    return cached
  } catch (error) {
    warnDegraded(error instanceof Error ? error.message : String(error))
    // 保留上一次的成功值：sidecar 抖一下不该把已有配置丢掉
    return cached
  }
}

/**
 * 最近一次成功取到的配置（`null` = 还没成功取过）。
 * ★ 目前**没有生产调用点**（建会话与保存后热应用都走 `refreshRuntimeLlmConfig()`，
 *   它自己就带缓存）。保留它是给「设置页清空后要立刻回落到默认值」这类后续改动一个
 *   同步读取口，也供测试用；真要删请连同 `clearRuntimeLlmConfig()` 一起删。
 */
export function currentRuntimeLlmConfig(): RuntimeLlmConfig | null {
  return cached
}

/** 清掉缓存（换学生 / 测试用）。 */
export function clearRuntimeLlmConfig(): void {
  cached = null
  degradedWarned = false
}

/**
 * 回执形状校验（**不信任网络回执**）。
 *
 * 字段缺失就返回 `null` 让调用方回落默认值 —— 半个对象喂给 `createChatRuntime` 会让
 * 失败发生在更深处、更难排查。`apiKey`/`hasKey` 允许缺省（未配置 Key 是合法状态）。
 */
export function parseRuntimeLlmConfig(value: unknown): RuntimeLlmConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : ''
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
  if (!providerId || !modelId) return null

  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : ''
  return {
    providerId,
    modelId,
    baseUrl,
    providerName: typeof record.providerName === 'string' ? record.providerName : '',
    apiKey,
    hasKey: typeof record.hasKey === 'boolean' ? record.hasKey : apiKey.length > 0
  }
}

/**
 * 降级提示：**只打结构性信息**（绝不打印 Key）。
 * 只在第一次失败时出声，恢复后再失败会重新出声（`degradedWarned` 在成功路径复位）。
 */
function warnDegraded(reason: string): void {
  if (degradedWarned) return
  degradedWarned = true
  console.warn(
    `[settings] 取「生效中的 LLM 配置」失败（本轮按内置默认值建会话）：${reason}。` +
      '设置页保存后会自动重试。'
  )
}
