/**
 * 学习记录 Extension（票 09，执行文档 §9.2 第 6 行）：把「学生在对话里做了什么」写回
 * **每人一份**的 `learning.db`。
 *
 * 数据流向（§9.1 的架构图右下角）：
 *
 *     Pi 事件 ──▶ 提取结构化学习数据 ──▶ bridge/client.ts（apiFetch）──▶ Python
 *                                                          POST /api/profile/{id}/events
 *                                                                    └─▶ learning.db
 *
 * ★★ 合规红线：**SQLite 不存对话正文**（§8.1 / §12）。
 *   这里只写「活动类型 + 知识点 + 对错 + 时间戳 + 一句固定口径的说明」，
 *   学生的原话、模型的回答、代码片段**一律不入库** —— 对话正文归 Pi 的 JSONL 会话树，
 *   两者靠 `studentId` + `sessionId` 关联。
 *
 * ★ 事件口径（票 08 明确要求，**不要写 `session_end`**）：
 *   - 订阅 `tool_execution_end`（**只读通知**：只看结果，绝不回写）；
 *   - 订阅 `agent_end`（一轮结束；`session_end` 在 Pi 里**不存在**，
 *     会话终态叫 `session_shutdown`，本扩展不需要它 —— 数据是逐条即时落库的，不攒到会话结束）。
 *
 * ★ 失败策略：sidecar 没起来 / 401 / 5xx 时**绝不抛**（Pi 与 UI 同进程），
 *   记一条可读日志 + 把该条记录留在有界队列里重试（指数退避，最多 200 条，超出丢最旧并计数）。
 *   对话必须能继续 —— 学习记录是辅助能力，不是主线。
 */

import type { GradeLevel } from '@shared/ipc-events'
import { currentAgentSession, type AgentExtensionApi } from './index.ts'

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 四类学习活动（`contracts.py` 的 `LearningActivity`，冻结）。 */
export type LearningActivity = 'qa' | 'animation' | 'coding' | 'quiz'

/** 一条学习记录（**不含对话正文**）。 */
export interface LearningEventPayload {
  activity: LearningActivity
  /** 关联知识点（提取不到就不写）。 */
  kpId?: string
  /** 关联 Pi JSONL 会话（`learning_history.session_id`）。 */
  sessionId?: string
  /** 对错（只有客观题/代码运行才有确定值）。 */
  isCorrect?: boolean
  /** 固定口径的中文说明（**不是**学生原话）。 */
  detail?: string
  /** 学段（冷启动时服务端据此建学生行；显式选择为权威）。 */
  gradeLevel?: GradeLevel
}

/** 落库出口（默认走 `apiFetch`；测试注入假实现）。 */
export type LearningEventPoster = (
  studentId: string,
  payload: LearningEventPayload
) => Promise<void>

export interface LearningLogStats {
  /** 成功落库条数。 */
  written: number
  /** 失败次数（含重试；`written` 之后仍失败的次数）。 */
  failed: number
  /** 当前待重试队列长度。 */
  queued: number
  /** 因队列上限被丢弃的条数（**要能看见**，不要静默丢数据）。 */
  dropped: number
  /** 最近一次失败原因（可读，不含对话正文）。 */
  lastError?: string
}

export interface LearningLogOptions {
  /** 落库出口（默认 `postLearningEvent`）。 */
  poster?: LearningEventPoster
  /** 队列上限（超出丢最旧；默认 200）。 */
  maxPending?: number
  /** 退避起点（毫秒，默认 1000；每次失败翻倍，封顶 `backoffMaxMs`）。 */
  backoffMs?: number
  backoffMaxMs?: number
  /** 时钟（测试用）。 */
  now?: () => number
  log?: (line: string, level?: 'info' | 'warn') => void
  /** 学生身份来源（默认取 {@link currentAgentSession}；测试可注入）。 */
  sessionProvider?: () => { studentId: string; sessionId: string; gradeLevel: GradeLevel } | null
}

/** `learning-log` 扩展 = 工厂 + 诊断入口（诊断只给测试与验收用，不进 LLM 上下文）。 */
export interface LearningLogExtension {
  (pi: AgentExtensionApi): void
  stats(): LearningLogStats
  /** 立刻把队列写出去（返回是否全部成功）；`agent_end` 与退出前都可调。 */
  flush(): Promise<boolean>
  /** 清空统计与队列（换学生时用；**不会**删除已落库的数据）。 */
  reset(): void
}

/* ------------------------------------------------------------------ *
 * 工具结果 → 学习记录（纯函数，可单测）
 * ------------------------------------------------------------------ */

/** Tool 名 → 活动类型（**只登记会产生学习数据的 Tool**；其余返回 `null`，不写库）。 */
const TOOL_ACTIVITY: Record<string, { activity: LearningActivity; detail: string }> = {
  rag_search: { activity: 'qa', detail: '对话答疑（检索教材片段）' },
  generate_animation: { activity: 'animation', detail: '观看动画讲解' },
  get_code_template: { activity: 'coding', detail: '领取编程模板' },
  get_coding_hint: { activity: 'coding', detail: '请求分级提示' },
  evaluate_code: { activity: 'coding', detail: '代码运行与评估' },
  generate_quiz: { activity: 'quiz', detail: '生成练习' },
  submit_quiz: { activity: 'quiz', detail: '提交作答' },
  generate_variants: { activity: 'quiz', detail: '生成变式练习' }
}

/** 知识点 id 的形状（只接受短标识，避免把整段中文/路径写进 `kp_id` 列）。 */
const SAFE_KP_ID = /^[A-Za-z0-9_.:-]{1,64}$/

/** 从任意位置安全地取一个字符串字段（不深挖、不递归，避免误取正文）。 */
function readField(source: unknown, keys: readonly string[]): string | undefined {
  if (!source || typeof source !== 'object') return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 从参数或结果里取知识点 id（**校验形状**后才返回）。 */
export function extractKpId(args: unknown, result: unknown): string | undefined {
  const fromArgs = readField(args, ['kp_id', 'kpId', 'knowledge_point_id'])
  if (fromArgs && SAFE_KP_ID.test(fromArgs)) return fromArgs
  const details = (result && typeof result === 'object' ? (result as Record<string, unknown>).details : undefined) ?? undefined
  const fromDetails = readField(details, ['kpId', 'kp_id', 'knowledgePointId'])
  if (fromDetails && SAFE_KP_ID.test(fromDetails)) return fromDetails
  const payload = (details && typeof details === 'object' ? (details as Record<string, unknown>).payload : undefined) ?? undefined
  const fromPayload = readField(payload, ['kpId', 'kp_id'])
  if (fromPayload && SAFE_KP_ID.test(fromPayload)) return fromPayload
  return undefined
}

/**
 * 从结果里取「答对没有」。
 *
 * 只认 `correct` / `passed` 两个**显式**字段：`ok` 在不同扩展里含义不同
 * （代码跑通 / 工具调用成功），拿它当对错会把「工具失败」记成「答错」，
 * 污染掌握度（掌握度单次限幅 ±0.2，错几次就掉档，不是小事）。
 */
export function extractCorrectness(result: unknown): boolean | undefined {
  const details = result && typeof result === 'object' ? (result as Record<string, unknown>).details : undefined
  if (!details || typeof details !== 'object') return undefined
  const record = details as Record<string, unknown>
  for (const key of ['correct', 'passed'] as const) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

/**
 * ★ `tool_execution_end` → 结构化学习记录（**唯一**的提取入口）。
 *
 * 返回 `null` 表示「这条调用与学习数据无关」（例如 `get_student_profile`、
 * 冒烟用的 `smoke_echo`、以及未来新增但未登记的 Tool）—— **不写库**，也不猜。
 */
export function extractLearningFromTool(
  toolName: string,
  args: unknown,
  result: unknown
): LearningEventPayload | null {
  const mapping = TOOL_ACTIVITY[toolName]
  if (!mapping) return null
  const payload: LearningEventPayload = { activity: mapping.activity, detail: mapping.detail }
  const kpId = extractKpId(args, result)
  if (kpId) payload.kpId = kpId
  const correct = extractCorrectness(result)
  if (correct !== undefined) payload.isCorrect = correct
  return payload
}

/* ------------------------------------------------------------------ *
 * 落库出口
 * ------------------------------------------------------------------ */

/**
 * ★ 唯一的 HTTP 出口：`POST /api/profile/{student_id}/events`（经 `bridge/client.ts`）。
 *
 * ⚠️ 这里用**调用点动态 import** 而不是文件顶部静态 import，原因是 `bridge/client.ts` 目前有一处
 * 缺扩展名的相对导入（`from '../sidecar/protocol'`），Node 直跑 TS（`node --test`）会
 * `ERR_MODULE_NOT_FOUND` —— 静态 import 会让**本模块连导入都失败**，学习记录的提取逻辑
 * 就再也测不了。动态 import 把这件事推迟到真正发请求的那一刻：
 *   - 生产（Vite/electron-vite 产物）：字面量说明符照样被静态分析并打进产物；
 *   - 测试：注入假 `poster` 时根本不会走到这里。
 * 等 `bridge/client.ts` 的导入补上 `.ts` 之后，这里可以改回静态 import（行为不变）。
 */
export async function postLearningEvent(
  studentId: string,
  payload: LearningEventPayload
): Promise<void> {
  const { apiFetch } = await import('../../bridge/client.ts')
  const response = await apiFetch(`/api/profile/${encodeURIComponent(studentId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!response.ok) {
    // 4xx/5xx 都要给可读原因；**不读大响应体**（写库失败时返回的是短 JSON）
    let snippet = ''
    try {
      snippet = (await response.text()).replace(/\s+/g, ' ').slice(0, 120)
    } catch {
      snippet = ''
    }
    throw new Error(`学习记录写入失败：HTTP ${response.status}${snippet ? `（${snippet}）` : ''}`)
  }
}

/* ------------------------------------------------------------------ *
 * 扩展本体
 * ------------------------------------------------------------------ */

/** 会话 id 的兜底来源：Pi 的 `ExtensionContext.sessionManager`（第二个入参）。 */
function sessionIdFromContext(ctx: unknown): string {
  try {
    const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager
    const id = manager?.getSessionId?.()
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/**
 * 建一个 `learning-log` 扩展（默认导出是它的单例）。
 *
 * 为什么做成工厂：测试要能注入假 `poster`（不起 sidecar、不发网络）与假时钟，
 * 还要能读 `stats()`；生产路径上就是一个默认实例。
 */
export function createLearningLogExtension(options: LearningLogOptions = {}): LearningLogExtension {
  const poster = options.poster ?? postLearningEvent
  const maxPending = options.maxPending ?? 200
  const backoffStart = options.backoffMs ?? 1000
  const backoffMax = options.backoffMaxMs ?? 30_000
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? ((line, level) => (level === 'warn' ? console.warn(line) : console.info(line)))
  const sessionProvider = options.sessionProvider ?? currentAgentSession

  const queue: Array<{ studentId: string; payload: LearningEventPayload }> = []
  let written = 0
  let failed = 0
  let dropped = 0
  let lastError: string | undefined
  let backoff = backoffStart
  let nextAttemptAt = 0
  let flushing: Promise<boolean> | null = null

  const stats = (): LearningLogStats => ({
    written,
    failed,
    queued: queue.length,
    dropped,
    lastError
  })

  const enqueue = (studentId: string, payload: LearningEventPayload): void => {
    queue.push({ studentId, payload })
    while (queue.length > maxPending) {
      queue.shift()
      dropped += 1
      log(
        `[learning-log] 待写队列超过 ${maxPending} 条，丢弃最旧一条（累计丢弃 ${dropped}）。` +
          '通常是 sidecar 长时间不可用 —— 请检查 sidecar 状态，学习记录缺失会影响个性化推荐。',
        'warn'
      )
    }
    void flush()
  }

  const flush = async (): Promise<boolean> => {
    if (flushing) return await flushing
    if (queue.length === 0) return true
    if (now() < nextAttemptAt) return false

    flushing = (async (): Promise<boolean> => {
      while (queue.length > 0) {
        const head = queue[0]
        try {
          await poster(head.studentId, head.payload)
          queue.shift()
          written += 1
          failed = 0
          backoff = backoffStart
          nextAttemptAt = 0
        } catch (error) {
          failed += 1
          lastError = error instanceof Error ? error.message : String(error)
          nextAttemptAt = now() + backoff
          backoff = Math.min(backoffMax, backoff * 2)
          log(
            `[learning-log] 学习记录未能写入（已入队重试，队列 ${queue.length} 条）：${lastError}`,
            'warn'
          )
          return false
        }
      }
      return true
    })()

    try {
      return await flushing
    } finally {
      flushing = null
    }
  }

  const extension = ((pi: AgentExtensionApi): void => {
    // ── ① Tool 调用结束：只读通知，提取学习数据后写库 ──
    pi.on('tool_execution_end', (event: unknown, ctx?: unknown) => {
      try {
        const payloadEvent = (event ?? {}) as { toolName?: string; args?: unknown; result?: unknown }
        const toolName = String(payloadEvent.toolName ?? '')
        if (!toolName) return
        const extracted = extractLearningFromTool(toolName, payloadEvent.args, payloadEvent.result)
        if (!extracted) return // 与学习数据无关的 Tool：不写库

        const session = sessionProvider()
        if (!session) {
          log(
            `[learning-log] 未绑定当前学生，丢弃一条「${extracted.activity}」学习记录` +
              '（应由 runtime.ts 在每轮开始前调用 bindAgentSession）',
            'warn'
          )
          return
        }
        enqueue(session.studentId, {
          ...extracted,
          sessionId: session.sessionId || sessionIdFromContext(ctx),
          gradeLevel: session.gradeLevel
        })
      } catch (error) {
        // ★ 事件处理器里绝不抛：Pi 与 UI 同进程
        log(
          `[learning-log] 提取学习数据失败（已忽略，不影响本轮对话）：${
            error instanceof Error ? error.message : String(error)
          }`,
          'warn'
        )
      }
    })

    // ── ② 一轮结束：记一条「答疑」活动（同时刷新 student.last_active_at） ──
    //    ★ 不是 `session_end`（**Pi 无此事件**），也不用 `agent_settled`（那还要等自动重试/压缩结束）。
    pi.on('agent_end', (_event: unknown, ctx?: unknown) => {
      try {
        const session = sessionProvider()
        if (!session) return
        enqueue(session.studentId, {
          activity: 'qa',
          detail: '对话轮次结束',
          sessionId: session.sessionId || sessionIdFromContext(ctx),
          gradeLevel: session.gradeLevel
        })
      } catch (error) {
        log(
          `[learning-log] 轮次记录失败（已忽略）：${error instanceof Error ? error.message : String(error)}`,
          'warn'
        )
      }
    })
  }) as LearningLogExtension

  extension.stats = stats
  extension.flush = flush
  extension.reset = (): void => {
    queue.length = 0
    written = 0
    failed = 0
    dropped = 0
    lastError = undefined
    backoff = backoffStart
    nextAttemptAt = 0
  }
  return extension
}

/**
 * ★ 默认导出：主 Agent 注册的那个单例（`extensions/index.ts` 的
 * `CORE_EXTENSION_FACTORIES['learning-log']` 引用的就是它）。
 *
 * 统计与手动 flush 通过函数上的附加属性暴露（`learningLogExtension.stats()`）——
 * Pi 只要求「是个工厂」，不需要它是个类。
 */
const learningLogExtension = createLearningLogExtension()

export default learningLogExtension
