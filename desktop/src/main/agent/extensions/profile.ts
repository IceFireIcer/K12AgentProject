/**
 * 画像 Extension（票 08 建立，票 20 补齐个性化闭环）：注册 `get_student_profile`。
 *
 * 职责：把「这个学生现在会什么、卡在哪、适合下一步学什么」交给主 Agent，
 * 让它在**同一轮**里调整讲解深度与例子 —— 这是「个性化学习路径」在对话里的落点。
 *
 * ★ 闭环的「读」这一端（票 20）：``recommendedKpIds`` 由 Python 侧的
 *   ``app/routes/profile.py`` 用**依赖图 + 掌握度**算出（掌握「变量」→ 推荐「循环」），
 *   本文件只把它渲染成给模型看的一句话。**不要在 TS 侧再算一份推荐** ——
 *   两套推荐会给出两个「下一步」，而学生只会看到其中一个。
 *
 * ★ 三条硬约束（都不是实现细节，是架构决策）：
 *
 * 1. **学生身份由主进程注入，不是 Tool 参数**（{@link currentAgentSession}）。
 *    `get_student_profile(student_id=...)` 这种形状一旦存在，模型就有机会读到**别的学生**的画像；
 *    身份只能来自渲染进程「当前选中的学生」，模型连表达「读别人」的能力都不该有。
 * 2. **只走 `bridge/client.ts`**（`apiFetch`）：token 注入与「渲染进程不直连 sidecar」这两条
 *    都靠这唯一的出口保证（有架构守卫）。本文件**不碰 fetch**，也不接触 token。
 * 3. **`execute()` 自兜异常、绝不抛出**：Pi 的 Extension 与 Agent 同在主进程，
 *    抛异常会同时带走 UI；失败一律返回可读中文 + `details.ok=false`
 *    （`details.ok=false` 会被轨迹图如实记成失败，见 `agent/trace.ts` 的 `toolResultOk`）。
 *
 * ★ **不缓存、不落第二份副本**（票 20 明确要求）：每次调用都真发一次
 *   `GET /api/profile/{student_id}`。缓存会让「上一轮的掌握度变化改变下一轮的推荐输入」
 *   这条闭环失效 —— 而那正是这一票要证明的东西。
 *
 * 画像数据本身来自 Python 侧一人一份的 `learning.db`（§8.1，`learning_history` **不存对话正文**）。
 */

import { Type, type Static } from '@sinclair/typebox'
import {
  currentAgentSession,
  SIDECAR_UNAVAILABLE_TEXT,
  toolFailure,
  toolSuccess,
  type AgentExtensionApi
} from './index.ts'

/** 参数 schema（TypeBox `TSchema`；冻结口径见 `desktop/scripts/check-tool-schema.mjs`）。 */
export const GetStudentProfileParams = Type.Object({
  /** 返回掌握度条目的上限（Prompt 预算控制；默认 8，最多 20）。 */
  max_mastery: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      default: 8,
      description: '掌握度条目上限，用于控制注入 Prompt 的长度'
    })
  )
})

export type GetStudentProfileParamsType = Static<typeof GetStudentProfileParams>

/** `GET /api/profile/{student_id}` 的响应形状（`contracts.py` 的出参，camelCase 由 alias 转）。 */
interface ProfileResponse {
  student?: {
    studentId?: string
    nickname?: string
    gradeLevel?: string
    createdAt?: number
    lastActiveAt?: number
  }
  mastery?: Array<{
    kpId?: string
    score?: number
    attempts?: number
    correct?: number
    lastSeenAt?: number | null
  }>
  preferences?: Record<string, string>
  recommendedKpIds?: string[]
}

/** `GET /api/profile/{student_id}/recommendation` 的响应形状（票 20）。 */
interface RecommendationResponse {
  source?: string
  summary?: string
  items?: Array<{
    kpId?: string
    name?: string
    gradeLevel?: string | null
    depth?: number
    mastery?: number
    reason?: string
  }>
}

/** 推荐来源的中文说法（只用于给模型的一句提示，**不是**界面文案）。 */
const RECOMMENDATION_SOURCE_LABELS: Record<string, string> = {
  review: '优先重练（这个知识点还没练熟）',
  graph: '依赖图后继（前置已掌握）',
  cold_start: '学习路线起点（新学生）',
  empty: '暂无（知识库或学习记录不足）'
}

/** 学段的中文名（**只用于拼给模型看的一句话**；学段语气由 Prompt 模板负责，见 `prompts/`）。 */
const GRADE_LABELS: Record<string, string> = {
  primary_low: '小学低年级',
  primary_high: '小学高年级',
  junior: '初中',
  senior: '高中'
}

/** 掌握度分档（给模型一个可以直接照做的难度指示，而不是一个 0.42 让模型自己猜）。 */
function masteryBand(score: number): string {
  if (score >= 0.8) return '已掌握'
  if (score >= 0.6) return '基本掌握'
  if (score >= 0.3) return '正在学'
  return '刚接触'
}

/** `ts`（Unix 秒或毫秒都兜住）→ `YYYY-MM-DD HH:mm`；拿不准就返回空串。 */
export function formatTimestamp(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
  const ms = value > 1e11 ? value : value * 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (input: number): string => String(input).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/**
 * 把画像渲染成**给模型看**的一段中文摘要（纯函数，可单测）。
 *
 * 两条纪律：
 *   - 掌握度按分数**降序**并截断到上限；一次注入几十条掌握度只会挤掉真正相关的教材上下文；
 *   - 明确告诉模型「这是内部数据，不要整段念给学生」—— 画像里的 `kpId` 是机器口径，
 *     直接念出来（`jr-py-loop`）学生完全看不懂。
 */
export function renderProfileText(
  profile: ProfileResponse,
  options: { maxMastery?: number; fallbackStudentId?: string; recommendation?: RecommendationResponse | null } = {}
): string {
  const maxMastery = Math.max(1, Math.min(20, options.maxMastery ?? 8))
  const student = profile.student ?? {}
  const studentId = student.studentId ?? options.fallbackStudentId ?? '(未知)'
  const grade = student.gradeLevel ? (GRADE_LABELS[student.gradeLevel] ?? student.gradeLevel) : '未设置'

  const lines: string[] = [`【学习画像 · 内部数据，不要整段念给学生听】学生：${studentId}（${grade}）`]

  const mastery = [...(profile.mastery ?? [])]
    .filter((item) => typeof item.kpId === 'string' && item.kpId.length > 0)
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))

  if (mastery.length === 0) {
    lines.push('- 还没有掌握度记录：这是这个学生的第一次对话，先用一个具体的小例子建立概念，别急着上难度。')
  } else {
    lines.push(`- 掌握度（共 ${mastery.length} 条，按分数降序显示前 ${Math.min(mastery.length, maxMastery)} 条）：`)
    for (const item of mastery.slice(0, maxMastery)) {
      const score = Number(item.score ?? 0)
      const attempts = Number(item.attempts ?? 0)
      const correct = Number(item.correct ?? 0)
      lines.push(
        `  - ${item.kpId}：${score.toFixed(2)}（${masteryBand(score)}；${attempts} 次作答，答对 ${correct} 次）`
      )
    }
  }

  const preferences = Object.entries(profile.preferences ?? {})
  if (preferences.length > 0) {
    lines.push(
      `- 学习偏好：${preferences
        .slice(0, 6)
        .map(([key, value]) => `${key}=${value}`)
        .join('；')}`
    )
  }

  // ★ 推荐（票 20）：优先用 `/recommendation` 的**带理由**版本（它还会说明「为什么」：
  //   是重练、是依赖图后继、还是冷启动）。取不到就退回 `/profile` 里的 kp_id 列表 ——
  //   两条路径的数据来源**同一处**（Python 的 `build_recommendation`），只是详细程度不同。
  lines.push(...renderRecommendationLines(profile, options.recommendation ?? null))

  const lastActive = formatTimestamp(student.lastActiveAt)
  if (lastActive) lines.push(`- 最近活跃：${lastActive}`)
  lines.push('注意：面向学生的回答里不要出现知识点 id、分数这类内部字段，用自然语言说「你已经会…，我们试试…」。')
  return lines.join('\n')
}

/** 推荐那几行（带理由时用详细版；否则退回 kp_id 列表）。 */
function renderRecommendationLines(
  profile: ProfileResponse,
  recommendation: RecommendationResponse | null
): string[] {
  const items = (recommendation?.items ?? []).filter(
    (item) => typeof item.kpId === 'string' && item.kpId.length > 0
  )
  if (items.length > 0) {
    const source = recommendation?.source ?? ''
    const why = RECOMMENDATION_SOURCE_LABELS[source] ?? '依赖图推荐'
    const listed = items
      .slice(0, 6)
      .map((item) => {
        const name = item.name ? `${item.name}（${item.kpId}）` : item.kpId
        const score = Number(item.mastery ?? 0)
        return `${name} 掌握度 ${score.toFixed(2)}`
      })
      .join('；')
    return [
      `- 推荐下一步（${why}）：${listed}`,
      recommendation?.summary
        ? `- 推荐口径（照这个意思用学生能听懂的话说）：${recommendation.summary}`
        : '- 优先顺着这条线引导，不要跳到更后面的内容。'
    ]
  }

  const recommended = (profile.recommendedKpIds ?? []).slice(0, 6)
  return [
    recommended.length > 0
      ? `- 依赖图推荐的下一个知识点：${recommended.join(', ')}（优先顺着这条线引导）`
      : '- 依赖图推荐：暂无（掌握度不足或依赖图未命中，按当前问题本身作答即可）'
  ]
}

/** 画像端点（`GET /api/profile/{student_id}`）。 */
export const profilePath = (studentId: string): string =>
  `/api/profile/${encodeURIComponent(studentId)}`

/** 推荐端点（`GET /api/profile/{student_id}/recommendation`，票 20）。 */
export const recommendationPath = (studentId: string): string =>
  `/api/profile/${encodeURIComponent(studentId)}/recommendation`

/**
 * `get_student_profile` 的 Tool 工厂。
 *
 * 单独导出是为了让**测试**能直接构造一个假 `pi`（只实现 `on` / `registerTool`）来断言：
 *   - 未绑定学生时返回可读错误且**不抛**；
 *   - sidecar 不可用时返回可读错误、耗时可控；
 *   - 成功时把 `content[0].text` 交给模型、`details.ok === true`。
 */
export default function profileExtension(pi: AgentExtensionApi): void {
  pi.registerTool({
    name: 'get_student_profile',
    label: '学习画像',
    description:
      '读取当前学生的画像：各知识点掌握度、学习偏好、依赖图推荐的下一步（含推荐理由）。' +
      '在学生问「我接下来学什么」「我哪里没学好」，或需要判断该讲多深时调用。' +
      '学生身份由宿主应用注入，**无需也不要**传学生标识。',
    promptSnippet: 'get_student_profile：读取当前学生画像与推荐下一步',
    parameters: GetStudentProfileParams,
    execute: async (_toolCallId: string, params: GetStudentProfileParamsType) => {
      const session = currentAgentSession()
      if (!session) {
        return toolFailure(
          '还没有绑定当前学生，无法读取学习画像。请先直接回答学生的问题，不要假设任何学习记录。'
        )
      }
      try {
        // ⚠️ 调用点动态 import（与 `learning-log.ts` 同因）：`bridge/client.ts` 里有一处缺 `.ts`
        // 的导入，Node 直跑 TS 时会让**整个模块**导入失败；推迟到真正发请求的那一刻，
        // 提取/渲染这类纯逻辑就还能被 `node --test` 覆盖。生产产物照常静态分析内联。
        const { apiFetch } = await import('../../bridge/client.ts')
        const response = await apiFetch(profilePath(session.studentId), { method: 'GET' })
        if (!response.ok) {
          const snippet = await readSnippet(response)
          if (response.status === 404) {
            return toolFailure(
              `还没有这个学生的画像记录（${session.studentId}）。按「第一次对话」处理：先问清楚年级与想学什么。` +
                (snippet ? `（服务端：${snippet}）` : '')
            )
          }
          return toolFailure(
            `读取学习画像失败：本地数据服务返回 HTTP ${response.status}` +
              (snippet ? `（${snippet}）` : ''),
            SIDECAR_UNAVAILABLE_TEXT
          )
        }
        const profile = (await response.json()) as ProfileResponse

        // ★ 推荐详细版（票 20）：**同一轮里再发一次**，拿到「为什么推荐它」。
        //   取不到不影响画像本身（推荐只是增强），所以失败静默退回 kp_id 列表。
        //   ★ **不缓存**：缓存会让「上一轮的变化改变下一轮的输入」这条闭环失效。
        const recommendation = await fetchRecommendation(apiFetch, session.studentId)

        const maxMastery = typeof params?.max_mastery === 'number' ? params.max_mastery : 8
        const text = renderProfileText(profile, {
          maxMastery,
          fallbackStudentId: session.studentId,
          recommendation
        })
        // 详细推荐优先；它没有条目时退回 `/profile` 里的 kp_id 列表（两者同源）
        const recommendedFromDetail = (recommendation?.items ?? [])
          .map((item) => item.kpId)
          .filter((kpId): kpId is string => typeof kpId === 'string' && kpId.length > 0)
        return toolSuccess(text, {
          ok: true,
          studentId: session.studentId,
          sessionId: session.sessionId,
          masteryCount: (profile.mastery ?? []).length,
          recommendedKpIds:
            recommendedFromDetail.length > 0
              ? recommendedFromDetail
              : (profile.recommendedKpIds ?? []),
          recommendationSource: recommendation?.source ?? null
        })
      } catch (error) {
        // ★ 绝不抛出：Pi 与 UI 同进程，抛出去会同时带走两者（AGENTS §5.14）
        return toolFailure(SIDECAR_UNAVAILABLE_TEXT, error)
      }
    }
  })
}

/** 读推荐详情；**任何失败都返回 `null`**（推荐是增强，缺了不该让画像读不出来）。 */
async function fetchRecommendation(
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  studentId: string
): Promise<RecommendationResponse | null> {
  try {
    const response = await apiFetch(recommendationPath(studentId), { method: 'GET' })
    if (!response.ok) return null
    const payload = (await response.json()) as unknown
    if (!payload || typeof payload !== 'object') return null
    return payload as RecommendationResponse
  } catch {
    return null
  }
}

/** 读一小段响应体用于报错（**截断**，避免把整页 HTML/堆栈塞进 Prompt）。 */
async function readSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return ''
  }
}
