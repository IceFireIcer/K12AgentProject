/**
 * 练习 Extension（票 14，执行文档 §9.2 第 3 行 / §11.4）：注册
 * `generate_quiz` / `submit_quiz` / `generate_variants`（三个都在 §9.3 的「Tool 名 → `kind`」映射表里 → `quiz`）。
 *
 * 这一条闭环：**出题 → 学生作答 → 后端规则判分 → 掌握度落库**
 *
 *     generate_quiz ──GET /api/quiz/bank/{kp_id}──▶ Python 题库（断网可用的根）
 *     submit_quiz   ──POST /api/quiz/grade───────▶ Python 规则判分 + mastery ±0.2 限幅
 *
 * ★★ 头号红线：**答案不出后端**（执行文档 §6.3 的答案泄漏防护）。
 *
 *   - 题库返回的是 `QuizQuestionOut`（结构上没有 `answer`）；
 *   - 本文件对所有**外部来源**的题目一律走 {@link projectQuestion} 的**白名单投影**：
 *     只挑 `qid/kpId/type/stem/options/explanation` 六个字段，
 *     LLM 生成的题即使多带了 `answer`/`solution`/`hint` 也**进不了**下发给前端的载荷；
 *   - 前端从不发送、也从不接收标准答案，答案只在 Python 的题库文件里。
 *
 * ★ 掌握度限幅：`mastery_delta` 由 Python 侧限幅（`contracts.py` 的 `MASTERY_DELTA_LIMIT` +
 *   `store/learning.py` 的 `apply_mastery`）。本文件**不做第二套判分/限幅**，
 *   只是把 `QuizResult` 原样交给事件层（`payload.kind == "quiz"`）。
 *
 * ★ `execute()` 自兜异常：Pi 的 Extension 与 Agent 同进程，抛异常会同时带走 UI。
 *   失败一律返回可读中文 + `details.ok=false`（事件层据此发 `error` 事件，见 `agent/events.ts`）。
 */

import { Type, type Static } from '@sinclair/typebox'
import { apiFetch } from '../../bridge/client.ts'
import { currentAgentSession, SIDECAR_UNAVAILABLE_TEXT, type AgentExtensionApi } from './index.ts'

/* ------------------------------------------------------------------ *
 * 与契约对应的 TS 形状（`contracts.py` 出参的 camelCase 形态）
 * ------------------------------------------------------------------ */

/** 题型（`QuizQuestionType`，第一期只做这三种，§11.4）。 */
export const QUIZ_QUESTION_TYPES = ['choice', 'blank', 'code_blank'] as const
export type QuizQuestionType = (typeof QUIZ_QUESTION_TYPES)[number]

/** **对外**题目形态（`QuizQuestionOut`）：**没有 `answer`**。 */
export interface QuizQuestionOutShape {
  qid: string
  kpId: string
  type: QuizQuestionType
  stem: string
  options: string[] | null
  explanation: string
}

/** 出题载荷（`QuizPayload`）。`source` 区分题库与生成（§11.4）。 */
export interface QuizPayloadShape {
  kpId: string
  questions: QuizQuestionOutShape[]
  source: 'bank' | 'generated'
}

/** 批改结果（`QuizResult`）。 */
export interface QuizResultShape {
  qid: string
  correct: boolean
  scoredBy: 'rule' | 'llm'
  feedback: string
  masteryDelta: number
}

/** 出题数量上限（一次给太多题，学生只会关掉卡片）。 */
export const MAX_QUIZ_QUESTIONS = 10
/** 默认出题数量。 */
export const DEFAULT_QUIZ_QUESTIONS = 3
/** LLM 变式生成的重试次数（重试仍失败 → 退回题库，票 14）。 */
export const DEFAULT_GENERATION_RETRIES = 2
/** 单次调用 sidecar 的超时。 */
export const QUIZ_TIMEOUT_MS = 8000

/* ------------------------------------------------------------------ *
 * 参数 schema（TypeBox `TSchema`）
 * ------------------------------------------------------------------ */

export const GenerateQuizParams = Type.Object({
  kpId: Type.String({
    minLength: 1,
    maxLength: 64,
    description: '要出题的知识点 id（例如 jr-py-loop）；从画像或 rag_search 的结果里取'
  }),
  gradeLevel: Type.Optional(
    Type.Union(
      ['primary_low', 'primary_high', 'junior', 'senior'].map((level) => Type.Literal(level)),
      { description: '当前学段（会与主进程注入的学段核对，以主进程为准）' }
    )
  ),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_QUIZ_QUESTIONS,
      default: DEFAULT_QUIZ_QUESTIONS,
      description: `出几道题（默认 ${DEFAULT_QUIZ_QUESTIONS}，最多 ${MAX_QUIZ_QUESTIONS}）`
    })
  )
})

export const SubmitQuizParams = Type.Object({
  qid: Type.String({ minLength: 1, maxLength: 64, description: '被作答的题目 id（来自题目卡片）' }),
  answer: Type.Union(
    [Type.String(), Type.Array(Type.String(), { minItems: 1, maxItems: 8 })],
    { description: '学生的作答：选择题填选项文本或字母；填空题可传多个空' }
  )
})

export const GenerateVariantsParams = Type.Object({
  kpId: Type.String({ minLength: 1, maxLength: 64, description: '要生成变式题的知识点 id' }),
  gradeLevel: Type.Optional(
    Type.Union(
      ['primary_low', 'primary_high', 'junior', 'senior'].map((level) => Type.Literal(level)),
      { description: '当前学段（以主进程注入的学段为准）' }
    )
  ),
  count: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_QUIZ_QUESTIONS, default: DEFAULT_QUIZ_QUESTIONS })
  )
})

export type GenerateQuizParamsType = Static<typeof GenerateQuizParams>
export type SubmitQuizParamsType = Static<typeof SubmitQuizParams>
export type GenerateVariantsParamsType = Static<typeof GenerateVariantsParams>

/* ------------------------------------------------------------------ *
 * 白名单投影与校验（防答案泄漏 / 防 LLM 乱出题）
 * ------------------------------------------------------------------ */

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readQuestionType(value: unknown): QuizQuestionType | null {
  return typeof value === 'string' && (QUIZ_QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuizQuestionType)
    : null
}

/**
 * ★ 把**任意来源**的一道题投影成对外形态（`QuizQuestionOut`）。
 *
 * 这是「答案不出后端」在编排层的落点：**白名单**挑字段，而不是黑名单删 `answer`。
 * 黑名单会被 `answerText` / `solution` / `correctOption` 这类变体绕过；白名单不会。
 * 认不准的题返回 `null`，由调用方丢掉（宁可少一道题，也不要一道有问题的题）。
 */
export function projectQuestion(raw: unknown): QuizQuestionOutShape | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const qid = readNonEmptyString(record.qid)
  const type = readQuestionType(record.type)
  const stem = readNonEmptyString(record.stem)
  if (qid === null || type === null || stem === null) return null

  const rawOptions = record.options
  let options: string[] | null = null
  if (Array.isArray(rawOptions)) {
    options = rawOptions
      .map((option) => readNonEmptyString(option))
      .filter((option): option is string => option !== null)
    if (options.length === 0) options = null
  }
  // 选择题必须给出至少两个选项，否则前端渲染出来是一道没法做的题
  if (type === 'choice' && (options === null || options.length < 2)) return null

  return {
    qid,
    kpId: readNonEmptyString(record.kpId ?? record.kp_id) ?? '',
    type,
    stem,
    options,
    explanation: readNonEmptyString(record.explanation) ?? ''
  }
}

/**
 * 校验 LLM 生成的一组题（票 14 的「pydantic 校验 + 重试」在 TS 侧的对等物）。
 *
 * 通过时返回**已投影**的载荷（多一个字段都不会带出去）；
 * 不通过时给出可读原因，调用方据此重试，重试仍失败则退回题库。
 *
 * 另外要求每题**带有答案**（`answer`）—— 那是给后端判分登记的，
 * {@link projectQuestion} 会把它丢掉，所以它永远不会出现在下发给前端的载荷里。
 */
export function validateGeneratedQuiz(
  raw: unknown,
  expect: { kpId: string; maxQuestions?: number }
): { ok: true; payload: QuizPayloadShape } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '生成结果不是一个对象' }
  const record = raw as Record<string, unknown>
  const questions = record.questions
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, reason: '生成结果里没有 questions 数组（或为空）' }
  }
  const limit = Math.min(expect.maxQuestions ?? MAX_QUIZ_QUESTIONS, MAX_QUIZ_QUESTIONS)
  const projected: QuizQuestionOutShape[] = []
  for (const [index, item] of questions.slice(0, limit).entries()) {
    const question = projectQuestion(item)
    if (question === null) {
      return { ok: false, reason: `第 ${index + 1} 道题缺少 qid/type/stem/options（无法渲染）` }
    }
    if (question.kpId && question.kpId !== expect.kpId) {
      return { ok: false, reason: `第 ${index + 1} 道题的 kpId（${question.kpId}）与请求的不一致` }
    }
    const source = item as Record<string, unknown>
    const answer = source.answer
    const hasAnswer =
      (typeof answer === 'string' && answer.trim().length > 0) ||
      (Array.isArray(answer) && answer.some((value) => readNonEmptyString(value) !== null))
    if (!hasAnswer) {
      return { ok: false, reason: `第 ${index + 1} 道题没有标准答案（后端将无法判分）` }
    }
    projected.push({ ...question, kpId: question.kpId || expect.kpId })
  }
  return { ok: true, payload: { kpId: expect.kpId, questions: projected, source: 'generated' } }
}

/** 学段解析：**会话学段为权威**（与 `rag-search.ts` 同一口径，显式选择优先 §10.1）。 */
export function resolveGradeLevel(requested: unknown, sessionGrade: unknown): string {
  const levels = ['primary_low', 'primary_high', 'junior', 'senior'] as const
  for (const value of [sessionGrade, requested]) {
    if (typeof value === 'string' && (levels as readonly string[]).includes(value)) return value
  }
  return 'primary_high'
}

/* ------------------------------------------------------------------ *
 * 注入点（测试与票 15 都用它，不另写一套）
 * ------------------------------------------------------------------ */

/** sidecar 请求出口（默认 {@link apiFetch}；测试注入假实现以覆盖断网/500 分支）。 */
export type QuizRequester = (path: string, init?: RequestInit) => Promise<Response>

/** 变式生成的入参（票 15 的 LLM 生成器按这个签名接入）。 */
export interface GenerateQuestionsRequest {
  kpId: string
  gradeLevel: string
  count: number
  /** 重试次数（从 0 开始），供生成器记录轨迹。 */
  attempt: number
}

export interface QuizExtensionOptions {
  /**
   * ★ **票 15 的接入点**：LLM 变式生成器。
   *
   * 缺省（本票）时只用本地题库 —— 断网、无 Key 都能出题。
   * 生成器返回的东西会被 {@link validateGeneratedQuiz} 校验，校验不过就重试，
   * 重试仍不过就**退回题库**（`source` 回到 `"bank"`），不抛错、不空题。
   *
   * ⚠️ 生成器的返回值里**必须**含每题的标准答案，并负责把答案登记到后端
   * （判分只认后端题库里的答案，票 15 的 `POST /api/quiz/variants` 或等价路径）。
   */
  generateQuestions?: (request: GenerateQuestionsRequest) => Promise<unknown>
  /** 请求出口（默认 `apiFetch`）。 */
  request?: QuizRequester
  /** LLM 生成失败后的重试次数（默认 2，即最多尝试 3 次）。 */
  generationRetries?: number
  /** 日志出口（默认 `console.warn`）。 */
  log?: (line: string) => void
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 失败结果的统一形状（与 `rag-search.ts` 同一口径，两边都要被 events 与 trace 正确识别）。 */
function failed(text: string, error?: unknown): {
  content: Array<{ type: 'text'; text: string }>
  details: { ok: false; error: true; errorMessage: string; message: string; degraded: true }
} {
  const reason = error instanceof Error ? error.message : error === undefined ? '' : String(error)
  const message = reason ? `${text}（${reason}）` : text
  return {
    content: [{ type: 'text', text: `⚠️ ${message}` }],
    details: { ok: false, error: true, errorMessage: message, message, degraded: true }
  }
}

/** 成功结果：`details` 就是事件层的 `payload`（`events.ts` 会把 details 展开成 payload）。 */
function ok<TDetails extends object>(
  text: string,
  details: TDetails
): { content: Array<{ type: 'text'; text: string }>; details: TDetails } {
  return { content: [{ type: 'text', text }], details }
}

/** 读一小段响应体用于报错（**截断**）。 */
async function readSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return ''
  }
}

/** 把题库响应投影成对外载荷（`QuizQuestionOut` 白名单；题库理论上已是合法形态，这里再兜一次）。 */
export function projectBankPayload(raw: unknown, kpId: string): QuizPayloadShape | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const questions = Array.isArray(record.questions) ? record.questions : []
  const projected = questions
    .map((question) => projectQuestion(question))
    .filter((question): question is QuizQuestionOutShape => question !== null)
  if (projected.length === 0) return null
  return {
    kpId: readNonEmptyString(record.kpId) ?? kpId,
    questions: projected,
    source: 'bank'
  }
}

/** 给模型看的一句话（题目本身走卡片，别让模型把题干念一遍）。 */
export function renderQuizText(payload: QuizPayloadShape): string {
  const count = payload.questions.length
  const types = [...new Set(payload.questions.map((question) => question.type))]
  return (
    `已经出好 ${count} 道题（${payload.kpId}；题型：${types.join('、')}，来源：${
      payload.source === 'bank' ? '本地题库' : '模型生成'
    }）。` +
    '题目会以练习卡片的形式显示在对话里，**不要**把题干和选项再念一遍；' +
    '请用一句话邀请学生作答，并告诉他们答完可以直接把答案发给你，也可以点卡片上的按钮提交。'
  )
}

/** 给模型看的批改摘要（掌握度变化也要让模型知道，好安排下一步）。 */
export function renderResultText(result: QuizResultShape): string {
  const delta = result.masteryDelta
  const deltaText = delta > 0 ? `掌握度 +${delta.toFixed(2)}` : delta < 0 ? `掌握度 ${delta.toFixed(2)}` : '掌握度不变'
  return (
    `已批改（${result.scoredBy === 'rule' ? '规则判分' : '模型判分'}）：${result.correct ? '答对' : '答错'}；${deltaText}。` +
    `反馈已展示给学生：「${result.feedback}」` +
    '请用一两句话回应（答对了就肯定并问要不要再来一题；答错了就引导学生再想一次，**不要直接给答案**）。'
  )
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

/**
 * 建一个练习 Extension 工厂（票 15 用 `createQuizExtension({ generateQuestions })` 接 LLM）。
 */
export function createQuizExtension(
  options: QuizExtensionOptions = {}
): (pi: AgentExtensionApi) => void {
  const request: QuizRequester = options.request ?? apiFetch
  const retries = Math.max(0, options.generationRetries ?? DEFAULT_GENERATION_RETRIES)
  const log = options.log ?? ((line: string) => console.warn(line))
  const generateQuestions = options.generateQuestions

  /** 一次带超时的请求（超时 / 网络异常都由调用方收敛成可读错误）。 */
  async function call(path: string, init?: RequestInit): Promise<Response> {
    return await request(path, { ...init, signal: AbortSignal.timeout(QUIZ_TIMEOUT_MS) })
  }

  /**
   * 出题：**题库优先**（断网兜底的根），题库没有才走 LLM 生成（票 15），
   * 生成失败重试 ≤2 → 仍失败就如实报错（**不返回空题**：空题会让前端渲染一张空卡片）。
   */
  async function generate(kpId: string, gradeLevel: string, count: number) {
    const path = `/api/quiz/bank/${encodeURIComponent(kpId)}?gradeLevel=${encodeURIComponent(
      gradeLevel
    )}&count=${count}`
    let bank: Response | null = null
    try {
      bank = await call(path, { method: 'GET' })
    } catch (error) {
      // sidecar 没起来：连题库都取不到 —— 这是「本轮能力受限」，不是崩溃
      return failed(
        `本地题库服务暂时不可用。请告诉学生「练习稍后再来」，并继续用对话讲清楚这个概念。`,
        error
      )
    }

    if (bank.ok) {
      const payload = projectBankPayload(await bank.json(), kpId)
      if (payload !== null) return ok(renderQuizText(payload), payload)
    } else if (bank.status !== 404) {
      const snippet = await readSnippet(bank)
      return failed(
        `取题失败：本地题库服务返回 HTTP ${bank.status}${snippet ? `（${snippet}）` : ''}。`,
        SIDECAR_UNAVAILABLE_TEXT
      )
    }

    // 到这里 = 题库没有这个知识点的题（404 / 空题）
    if (!generateQuestions) {
      return failed(
        `本地题库里还没有「${kpId}」这个知识点的题目（变式生成属票 15，尚未接入）。` +
          '请换成题库里已有的知识点出题，或先用对话把这个概念讲清楚。'
      )
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const raw = await generateQuestions({ kpId, gradeLevel, count, attempt })
        const validated = validateGeneratedQuiz(raw, { kpId, maxQuestions: count })
        if (validated.ok) {
          return ok(renderQuizText(validated.payload), validated.payload)
        }
        log(`[quiz] LLM 出题校验未通过（第 ${attempt + 1} 次）：${validated.reason}`)
      } catch (error) {
        log(
          `[quiz] LLM 出题失败（第 ${attempt + 1} 次）：${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    // ★ 重试仍失败 → **退回题库**（票 14 的兜底口径：不抛错、不空题）
    try {
      const fallback = await call(
        `/api/quiz/bank/${encodeURIComponent(kpId)}?gradeLevel=${encodeURIComponent(
          gradeLevel
        )}&count=${count}&allowCompat=true`,
        { method: 'GET' }
      )
      if (fallback.ok) {
        const payload = projectBankPayload(await fallback.json(), kpId)
        if (payload !== null) {
          log('[quiz] 变式生成失败，已退回本地题库（source=bank）')
          return ok(renderQuizText(payload), payload)
        }
      }
    } catch {
      // 走到这里说明两条路都不通，下面统一给可读错误
    }
    return failed(
      `暂时没能为「${kpId}」出题（题库里没有，模型生成也失败了）。请换一个知识点，或先讲解概念。`
    )
  }

  return function quizExtension(pi: AgentExtensionApi): void {
    pi.registerTool({
      name: 'generate_quiz',
      label: '出题练习',
      description:
        '为某个知识点出 1-10 道客观题（选择/填空/代码填空），题目以练习卡片显示给学生。' +
        '题目优先取自本地题库，断网也能用。判分与学生答案的提交用 submit_quiz。' +
        '学生主动要求练习、或刚讲完一个知识点需要检验时调用。',
      promptSnippet: 'generate_quiz：为知识点出客观题（练习卡片）',
      promptGuidelines: [
        '出题前先确认知识点 id（从画像或 rag_search 的结果里取），不要编造 id。',
        '出完题不要念题干，让学生自己在卡片上作答；学生答完用 submit_quiz 批改。'
      ],
      parameters: GenerateQuizParams,
      execute: async (_toolCallId: string, params: GenerateQuizParamsType) => {
        const session = currentAgentSession()
        const kpId = readNonEmptyString(params?.kpId)
        if (kpId === null) {
          return failed('出题需要知识点 id（例如 jr-py-loop）。请先确认要练哪个知识点。')
        }
        const gradeLevel = resolveGradeLevel(params?.gradeLevel, session?.gradeLevel)
        const count =
          typeof params?.count === 'number' && Number.isFinite(params.count)
            ? Math.max(1, Math.min(MAX_QUIZ_QUESTIONS, Math.trunc(params.count)))
            : DEFAULT_QUIZ_QUESTIONS
        return await generate(kpId, gradeLevel, count)
      }
    })

    pi.registerTool({
      name: 'submit_quiz',
      label: '提交作答',
      description:
        '把学生对某道题的作答交给后端批改（客观题规则判分），返回对错、中文反馈与掌握度变化。' +
        '学生说「我选 B」「答案是 5」「提交」时调用。**不要**自己判对错，判分只走后端。',
      promptSnippet: 'submit_quiz：提交学生作答，后端判分并更新掌握度',
      promptGuidelines: [
        '判分只走后端：不要凭题干自己推断对错，也不要改学生的作答。',
        '批改结果里的反馈会显示在卡片上，你只需要做简短的鼓励或引导。'
      ],
      parameters: SubmitQuizParams,
      execute: async (_toolCallId: string, params: SubmitQuizParamsType) => {
        const session = currentAgentSession()
        if (!session) {
          return failed(
            '还没有绑定当前学生，无法批改（掌握度需要记到具体学生名下）。请先直接回应学生。'
          )
        }
        const qid = readNonEmptyString(params?.qid)
        if (qid === null) {
          return failed('批改需要题目 id（qid）：请从练习卡片或上一轮出题结果里取。')
        }
        const answer = params?.answer
        if (answer === undefined || answer === null || (Array.isArray(answer) && answer.length === 0)) {
          return failed('没有收到学生的作答内容，无法批改。请先让学生给出答案。')
        }

        try {
          const response = await call('/api/quiz/grade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: session.studentId,
              qid,
              answer,
              sessionId: session.sessionId
            })
          })
          if (!response.ok) {
            const snippet = await readSnippet(response)
            if (response.status === 404) {
              return failed(
                `题目 ${qid} 不在题库里（可能是生成的变式题还没登记答案）。请重新出题后再作答。` +
                  (snippet ? `（服务端：${snippet}）` : '')
              )
            }
            return failed(
              `提交作答失败：本地服务返回 HTTP ${response.status}${snippet ? `（${snippet}）` : ''}。`,
              SIDECAR_UNAVAILABLE_TEXT
            )
          }
          const result = (await response.json()) as QuizResultShape
          return ok(renderResultText(result), result)
        } catch (error) {
          return failed('提交作答失败（本地服务不可用），本次没有更新掌握度。', error)
        }
      }
    })

    pi.registerTool({
      name: 'generate_variants',
      label: '变式题',
      description:
        '为同一个知识点生成变式题（换数字、换问法），用于多练几遍。' +
        '当前由票 15 接入模型生成；未接入时请改用 generate_quiz。',
      promptSnippet: 'generate_variants：同知识点的变式题（票 15 接入模型生成）',
      parameters: GenerateVariantsParams,
      execute: async (_toolCallId: string, params: GenerateVariantsParamsType) => {
        const kpId = readNonEmptyString(params?.kpId)
        if (kpId === null) return failed('生成变式题需要知识点 id。')
        if (!generateQuestions) {
          return failed(
            '变式题生成还没有接入（票 15）。请改用 generate_quiz 出题 —— ' +
              '它会从本地题库取题，同样能多练几遍。'
          )
        }
        const session = currentAgentSession()
        const gradeLevel = resolveGradeLevel(params?.gradeLevel, session?.gradeLevel)
        const count =
          typeof params?.count === 'number' && Number.isFinite(params.count)
            ? Math.max(1, Math.min(MAX_QUIZ_QUESTIONS, Math.trunc(params.count)))
            : DEFAULT_QUIZ_QUESTIONS
        // 走与 generate_quiz 同一条路径（题库优先，生成后校验 + 重试 + 退回题库）
        return await generate(kpId, gradeLevel, count)
      }
    })
  }
}

/** 默认工厂（`runtime.ts` 直接注入它；票 15 用 {@link createQuizExtension} 注入生成器）。 */
export default createQuizExtension()
