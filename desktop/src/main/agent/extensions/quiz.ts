/**
 * 练习 Extension（票 14 客观题 + 票 15 主观题/变式/闯关）：注册
 * `generate_quiz` / `submit_quiz` / `generate_variants`（三个都在 §9.3 的「Tool 名 → `kind`」映射表里 → `quiz`）。
 *
 * 两条闭环：
 *
 *     generate_quiz ──GET /api/quiz/bank/{kp_id}──▶ Python 题库（断网可用的根）
 *     submit_quiz   ──POST /api/quiz/grade───────▶ Python 规则判分 + mastery ±0.2 限幅
 *                                                       └─▶ progress 状态机（票 15，关卡 D）
 *
 *     generate_variants ──模型生成──▶ POST /api/quiz/variants（**登记标准答案**，Python 侧）
 *     submit_quiz（主观）──模型判分──▶ POST /api/quiz/grade-subjective（落库，Python 侧）
 *
 * ★★ 头号红线：**答案不出后端**（执行文档 §6.3 的答案泄漏防护）。
 *
 *   - 题库返回的是 `QuizQuestionOut`（结构上没有 `answer`、也**没有 `explanation`**）；
 *   - 本文件对所有**外部来源**的题目一律走 {@link projectQuestion} 的**白名单投影**：
 *     只挑 `qid/kpId/type/stem/options` 五个字段，
 *     LLM 生成的题即使多带了 `answer`/`solution`/`hint`/`explanation` 也**进不了**下发给前端的载荷；
 *   - {@link prepareVariants} 里**故意**保留 `answer`（后端判分要它），
 *     但那是**登记给后端**用的：它经 `POST /api/quiz/variants` 直接进 Python，
 *     在投影后的 `payload` 里一个字段都不留。
 *   - 前端从不发送、也从不接收标准答案。
 *
 * ★ 掌握度限幅：`mastery_delta` 由 Python 侧限幅（`contracts.py` 的 `MASTERY_DELTA_LIMIT` +
 *   `store/learning.py` 的 `apply_mastery`）。本文件**不做第二套判分/限幅**，
 *   只是把 `QuizResult` 原样交给事件层（`payload.kind == "quiz"`）。
 *
 * ★ 主观题为什么在这里判分（票 15 的关键分叉）：**LLM 调用归编排层独占**（Pi），
 *   Python 侧不装任何 LLM 客户端。所以主观题的批改结论由本文件用**评分细则**问出来，
 *   再交给 `POST /api/quiz/grade-subjective` 落库 —— 但「多少分算过」仍由 Python 定
 *   （本文件只送 `score`，不送对错），避免判分规则两边各写一份而漂移。
 *   **没有 API Key = 判不了就说不判**（见 {@link SUBJECTIVE_DEGRADED_TEXT}），绝不瞎判。
 *
 * ★ `execute()` 自兜异常：Pi 的 Extension 与 Agent 同进程，抛异常会同时带走 UI。
 *   失败一律返回可读中文 + `details.ok=false`（事件层据此发 `error` 事件，见 `agent/events.ts`）。
 */

import { Type, type Static } from '@sinclair/typebox'
import { apiFetch } from '../../bridge/client.ts'
import {
  currentAgentSession,
  SIDECAR_UNAVAILABLE_TEXT,
  toolFailure,
  type AgentExtensionApi
} from './index.ts'

/* ------------------------------------------------------------------ *
 * 与契约对应的 TS 形状（`contracts.py` 出参的 camelCase 形态）
 * ------------------------------------------------------------------ */

/** 题型（`QuizQuestionType`，第一期只做这三种，§11.4）。 */
export const QUIZ_QUESTION_TYPES = ['choice', 'blank', 'code_blank'] as const
export type QuizQuestionType = (typeof QUIZ_QUESTION_TYPES)[number]

/** **对外**题目形态（`QuizQuestionOut`）：**没有 `answer`、也没有 `explanation`**。 */
export interface QuizQuestionOutShape {
  qid: string
  kpId: string
  type: QuizQuestionType
  stem: string
  options: string[] | null
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
/** LLM 生成 / 判分的单次超时（比本地请求宽：真的要过一次外呼）。 */
export const LLM_TIMEOUT_MS = 30_000

/**
 * 主观题判分 Prompt 里的**评分细则骨架**（票 15：「prompt 内含评分细则 + 示例对照」）。
 *
 * ★ 为什么细则骨架要**写死在代码里**、而不是让模型自由发挥：判分的稳定性就是靠它。
 *   同一份答案连判 3 次要给同一个结论（票 15 的验收口径），而「自由发挥的评分标准」
 *   每次都会漂移一点，连判三次就能得到三个分数。骨架固定 + 每题自带的细则
 *   （`rubric`，由生成侧写进库里）→ 三次判分落在同一档。
 *
 * ★ 四档锚点是**示例对照**：给模型可对照的具体样子，而不是抽象的「优秀/良好」。
 *   实测抽象档位会让模型把「还算完整」和「非常完整」判成同一档。
 */
export const RUBRIC_SCAFFOLD = [
  '评分细则（四档，先定档再给分，不要给出档位之外的分数）：',
  '- 1.0 完全正确：覆盖了本题要求的所有要点，表述清楚，没有科学性错误。',
  '- 0.8 基本正确：要点基本覆盖，个别地方说得笼统或有小瑕疵，但结论正确。',
  '- 0.5 部分正确：说对了一部分要点，关键点缺失或表述含糊（**方向对但没答全**给这一档）。',
  '- 0.2 基本不对：只有零散的正确碎片，或答非所问。',
  '- 0.0 错得离谱 / 空白 / 与题目无关。',
  '',
  '示例对照：',
  '- 问「什么是特征？」学生答「能用来区分事物的、可以量出来的属性，比如身高体重」→ 1.0',
  '- 问「什么是特征？」学生答「就是事物的特点」→ 0.5（方向对，但没说「可以量出来」）',
  '- 问「什么是特征？」学生答「我不知道」→ 0.0',
  '',
  '打分要求：',
  '1. 只依据「本题要点」与学生的作答，不要考虑学生的年级、也不要因为字数多就加分；',
  '2. 学生的作答里出现与答案无关的闲聊、玩笑或与题目无关的内容时，按未覆盖要点处理；',
  '3. 输出必须是**一行 JSON**，不要解释、不要代码块、不要多余文字。'
].join('\n')

/**
 * 主观题判分 Prompt（**纯函数**，可单测）。
 *
 * 三段：学段与题目 → 本题要点（`rubric`）→ 固定评审骨架（含示例对照）。
 * ★ 只注入「题干 + 要点 + 学生作答」，**不注入对话历史**：
 *   判一道题不需要上一轮聊了什么，多喂上下文只会让结论漂移。
 */
export function buildSubjectiveGradingPrompt(input: {
  gradeLevel: string
  stem: string
  rubric: string
  answer: string
}): string {
  return [
    `你是一名${GRADE_LABEL_FOR_PROMPT[input.gradeLevel] ?? '中小学'}的人工智能通识课老师，` +
      '正在批改一道开放式问答题。请**严格按评分细则**打分。',
    '',
    '【题目】',
    input.stem,
    '',
    '【本题要点（评分依据）】',
    input.rubric,
    '',
    '【学生的作答】',
    input.answer,
    '',
    RUBRIC_SCAFFOLD,
    '',
    '输出格式（严格一行 JSON）：',
    '{"score": 0.8, "feedback": "一句话中文反馈，指出对在哪里/差在哪里"}',
    'score 只能是 0.0 / 0.2 / 0.5 / 0.8 / 1.0 这五档；feedback 不超过 120 字。'
  ].join('\n')
}

/** 学段的中文名（**只用于拼判分 Prompt**，界面文案走 `labels.ts`）。 */
const GRADE_LABEL_FOR_PROMPT: Record<string, string> = {
  primary_low: '小学低年级',
  primary_high: '小学高年级',
  junior: '初中',
  senior: '高中'
}

/** 主观题判分的合法档位（与 Prompt 里的四档一致；**认不准就算判分失败**）。 */
export const SUBJECTIVE_SCORE_STEPS = [0, 0.2, 0.5, 0.8, 1] as const

/**
 * 解析主观题判分结果（**宽松读、严格校验**）。
 *
 * 模型可能包 ```json 代码块、可能多嘴几句，所以先剥壳再取第一个 JSON 对象；
 * 但 ``score`` 必须落在 {@link SUBJECTIVE_SCORE_STEPS} 上 —— 认不准返回 `null`
 * （当作「这次没判出来」），**绝不**把一个脏分数送去落库。掌握度只差 0.15 分档，
 * 一个乱来的 0.73 会直接让「答对/答错」翻转。
 */
export function parseSubjectiveScore(
  raw: string
): { score: number; feedback: string } | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const stripped = raw.replace(/```(?:json)?/gi, ' ')
  const matched = /\{[\s\S]*\}/.exec(stripped)
  if (!matched) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(matched[0])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const rawScore = record.score
  // ★ 必须先排除 `null` / `""` 这类值：`Number(null) === 0`、`Number("") === 0`，
  //   直接转换成数字会把「模型没给分」**静默变成 0 分** —— 学生可能明明答对了，
  //   却被判错并扣掉掌握度（实测踩到：`{"score": null}` 被判成 0.0 并落库）。
  if (typeof rawScore !== 'number' && typeof rawScore !== 'string') return null
  if (typeof rawScore === 'string' && rawScore.trim() === '') return null
  const score = typeof rawScore === 'number' ? rawScore : Number(rawScore)
  if (!Number.isFinite(score)) return null
  // 允许模型给 0.79 这种「就近」值：吸附到最近的合法档位（而不是直接判失败，
  // 否则一半的判分都会因为模型多给一位小数而白跑）。
  const snapped = SUBJECTIVE_SCORE_STEPS.reduce((best, step) =>
    Math.abs(step - score) < Math.abs(best - score) ? step : best
  )
  const feedback = typeof record.feedback === 'string' ? record.feedback.slice(0, 200) : ''
  return { score: snapped, feedback }
}

/** 给「没判出来」时的一句可读说明（**不是** error 事件的兜底文案：判分失败走 details.ok=false）。 */
export const SUBJECTIVE_GRADING_FAILED_TEXT =
  '这道题我这次没能判出来（模型没有按要求给出分数）。先跟你说说思路，等会儿再试一次批改。'

/** 出一道**主观题**的标记：题型仍是契约里的三种，靠 `rubric` 区分批改路径。 */
export interface SubjectiveQuestionShape {
  qid: string
  kpId: string
  type: QuizQuestionType
  stem: string
  options: string[] | null
  explanation: string
  /** ★ 评分细则：登记进后端（`/api/quiz/variants`），**绝不进前端载荷**（同 `answer` 的待遇）。 */
  rubric: string
  /** ★ 参考答案/标准答案：只用于登记后端，不进前端载荷。 */
  answer: string | string[]
}

/** 未接入 LLM 时的可读说明（无 API Key 世界：判不了就明说，不瞎判）。 */
export const SUBJECTIVE_UNAVAILABLE_TEXT =
  '这道主观题需要模型来判分，但当前没有可用的模型（还没配置 API Key）。' +
  '我先不给你判分，免得判错；你可以先说说思路，或者换一道客观题练手。'

/* ------------------------------------------------------------------ *
 * 参数 schema（TypeBox `TSchema`）
 * ------------------------------------------------------------------ */

export const GenerateQuizParams = Type.Object({
  kpId: Type.String({
    minLength: 1,
    maxLength: 64,
    description: '要出题的知识点 id（例如 prog-loop-jr）；从画像或 rag_search 的结果里取'
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
 *
 * ★★ `explanation` **不在白名单里**（2026-09-19 起，与契约 `QuizQuestionOut` 对齐）：
 *   解析的措辞经常把答案直接写进去（实测真题里 41% 如此），发到前端就等于送答案。
 *   它的教学价值在**判分之后** —— `QuizResult.feedback` 里带着它回来，那才是学生
 *   该看到「为什么」的时刻。所以这里丢掉它在设计上是对的，不是"少带了个字段"。
 *   ⚠️ 注意 `explanation` 在**登记给后端的那一份**里仍然保留（见 {@link prepareVariants}）：
 *   后端要它来生成判分后的反馈，而那一份从头到尾不出后端。
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
    options
  }
}

/**
 * 校验 LLM 生成的一组题，只产出**对外载荷**（不带答案的那一份）。
 *
 * 通过时返回**已投影**的载荷（多一个字段都不会带出去）；
 * 不通过时给出可读原因，调用方据此重试，重试仍失败则退回题库。
 *
 * 另外要求每题**带有答案**（`answer`）—— 那是给后端判分登记的，
 * {@link projectQuestion} 会把它丢掉，所以它永远不会出现在下发给前端的载荷里。
 *
 * ⚠️ **生产的两条出题路径都不再直接用它**（F4）：`generate_quiz`（题库缺题时）与
 *   `generate_variants` 都走 {@link prepareVariants} + {@link registerVariantsFn} ——
 *   因为「只投影不给答案」的题在后端判不了分（学生一提交就是 404）。
 *   保留本函数是因为它是**纯投影**的那一半（可单测、可复用），语义与
 *   `prepareVariants` 的投影口径逐条相同。
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

/**
 * 学段解析：**会话学段为权威**（与 `rag-search.ts` 同一口径）。
 *
 * 会话里那个值是**服务端推断**（`server/app/grade/rules.py`）出来的当前生效值，
 * 前端不推断学段（手动指定走独立通道、由服务端写库）；模型填的只是「复述」。
 */
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
  /** Pi 的扩展上下文（默认生成器用它取模型；注入的生成器可以忽略）。 */
  context?: PiCompletionContext
  /** 本轮的中止信号（与 `ctx.signal` 同源，测试可注入）。 */
  signal?: AbortSignal
}

/**
 * ★ **默认的变式题生成器**：让模型现出 `count` 道题（含答案与可选的评分细则）。
 *
 * 输出被要求是**严格 JSON**（`{questions: [...]}`），因为
 * {@link prepareVariants} 要按结构校验；模型多嘴的散文会被解析失败挡下并重试。
 *
 * ★ 题型限定在契约的三种；`rubric` 非空即主观题（判分走 LLM）。
 *   **学段写进 Prompt**（票 15 要求），并且服务端登记时还会按术语文表复查超纲。
 *
 * ★ 为什么仍然要模型给 `explanation`（2026-09-19 起它已不下发给前端）：
 *   它是**判分后反馈**的原料 —— Python 的 `feedback_for()` 用它拼出「答对了！…」/
 *   「这次还差一点，先看看思路：…」，学生在**提交之后**才看到。
 *   所以要它、但只把它登记进后端（`prepareVariants` 的登记那一份），
 *   **不进下发给前端的载荷**（`projectQuestion` 的白名单里没有它）。
 *   ⚠️ 也别让它写成「他答对了吗」式的总结 —— 反馈是给答过题的人看的讲解。
 */
export function buildVariantPrompt(input: {
  kpId: string
  gradeLevel: string
  count: number
  /** 上一次尝试的失败原因（第 2 次起带上，让模型知道要改什么）。 */
  previousError?: string
}): string {
  return [
    `你是一名${GRADE_LABEL_FOR_PROMPT[input.gradeLevel] ?? '中小学'}的人工智能通识课老师，` +
      `请为知识点「${input.kpId}」出 ${input.count} 道**新题**（换数字、换问法、换情境），` +
      '用于让学生多练几遍。',
    '',
    `难度与用词必须严格贴合「${GRADE_LABEL_FOR_PROMPT[input.gradeLevel] ?? '中小学'}」：` +
      '不要出现这个年级还没学过的术语。',
    '',
    '题型只能是这三种之一：choice（选择题，必须有 2-4 个 options）/ blank（填空题）/ code_blank（代码填空）。',
    '其中最多一道可以是开放的问答题：它的 type 仍填 blank，但必须额外给出 rubric（评分要点）；',
    '开放题的 answer 是**参考答案**（不是唯一解）。',
    '',
    '每道题必须给出：',
    '- qid：唯一短标识（英文+数字，例如 loop-v1）',
    '- type / stem / options（选择题才要）/ answer（**标准答案**）/ explanation（给老师看的讲解，学生答完后会看到）',
    '- 开放题额外给 rubric（该答出哪些要点，一到三句话）',
    '',
    ...(input.previousError ? [`上一次尝试不合格（${input.previousError}），请修正后重新生成。`, ''] : []),
    '只输出一行 JSON，不要解释、不要代码块：',
    '{"questions":[{"qid":"...","type":"choice","stem":"...","options":["A","B"],"answer":"A","explanation":"..."}]}'
  ].join('\n')
}

/**
 * 解析生成结果（宽松读：剥 ```json 代码块 / 取第一个 JSON 对象）。
 * 认不出返回 `null` → 交给调用方重试。
 */
export function parseVariantPayload(raw: string): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const stripped = raw.replace(/```(?:json)?/gi, ' ')
  const matched = /\{[\s\S]*\}/.exec(stripped)
  if (!matched) return null
  try {
    return JSON.parse(matched[0])
  } catch {
    return null
  }
}

/** 默认生成器（用 `ctx` 的模型；`context` 缺失时抛错，由调用方兜成可读降级）。 */
export async function generateQuestionsViaContext(
  request: GenerateQuestionsRequest
): Promise<unknown> {
  const text = await completeViaContext(request.context, {
    prompt: buildVariantPrompt({
      kpId: request.kpId,
      gradeLevel: request.gradeLevel,
      count: request.count,
      previousError: request.attempt > 0 ? '上次输出不是合法 JSON 或缺少必填字段' : undefined
    }),
    ...(request.signal ? { signal: request.signal } : {})
  })
  return parseVariantPayload(text)
}

/**
 * ★ LLM 补全出口（票 15）：给一段 Prompt，返回模型的文本。
 *
 * 为什么是**注入**而不是本文件自己从 Pi 取：判分/生成发生在 `execute()` 里，
 * 那里能拿到 Pi 的 `ctx`（`ctx.model` / `ctx.modelRegistry`），所以**默认实现就是
 * 用 `ctx` 调的**（见 {@link completeViaContext}）—— 接线由 `runtime.ts` 完成只是
 * 为了支持测试注入与自定义实现（与 `grade.ts` 的 `useJudge` 同一形态）。
 * **`ctx` 缺失或没有凭证 = 没有 API Key** → 主观题判分与变式生成都走可读降级，绝不瞎判。
 */
export type LlmComplete = (input: {
  prompt: string
  /** `subjective_grade` / `variant_generate`：只用于日志与轨迹，不影响请求。 */
  purpose: string
  signal?: AbortSignal
}) => Promise<string>

/**
 * ★ Pi 边界上的模型调用面（**结构化声明**，不 import Pi 的类型）。
 *
 * 与 `runtime.ts` / `pi-bootstrap.ts` 同一条纪律：静态 import Pi 会 evaluate 包根的
 * CLI `main.js`（连带 `esbuild` 原生二进制，风险 #15）。这里只需要三个方法。
 */
export interface PiCompletionContext {
  model?: unknown
  modelRegistry?: {
    hasConfiguredAuth?: (model: unknown) => boolean
    complete?: (
      model: unknown,
      context: { messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }>; timestamp?: number }> },
      options?: Record<string, unknown>
    ) => Promise<{ content?: Array<{ type?: string; text?: string }> }>
  }
}

/**
 * ★ **默认的 LLM 出口**：用 Pi 的 `ctx.modelRegistry.complete()` 发一次非流式补全。
 *
 * 为什么走这条而不是自己拿 Key 发 HTTP：
 *   - Key 的解析链（CLI → auth.json → 环境变量 → models.json）与 BaseURL/ModelID 的
 *     自定义全都已经在 Pi 里做完了，这里再实现一遍就是第二套凭证逻辑；
 *   - 桌面端的架构守卫要求「对 sidecar 的 HTTP 只准走 `bridge/client.ts`」，
 *     而这里是**供应商**直连（不是 sidecar），走 Pi 是唯一既合规又不重复实现的路径。
 *
 * 抛异常 = 这条通道不可用（无凭证 / 模型不在目录里 / 网络失败），
 * 由调用方的 try/catch 兜成可读中文；**绝不把异常抛给 Pi**。
 */
export async function completeViaContext(
  context: PiCompletionContext | undefined,
  input: { prompt: string; signal?: AbortSignal }
): Promise<string> {
  const registry = context?.modelRegistry
  const model = context?.model
  if (!registry || !model) {
    throw new Error('当前会话没有可用的模型（ctx.model / ctx.modelRegistry 缺失）')
  }
  if (typeof registry.hasConfiguredAuth === 'function' && !registry.hasConfiguredAuth(model)) {
    throw new Error('当前供应商没有配置凭证（未设置 API Key）')
  }
  if (typeof registry.complete !== 'function') {
    throw new Error('当前 Pi 版本没有提供 modelRegistry.complete')
  }
  const response = await registry.complete(
    model,
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: input.prompt }],
          timestamp: Date.now()
        }
      ]
    },
    {
      // 判分/出题都要「同一份输入给同一个结论」：关掉思考预算的随机性来源，
      // 并显式不带缓存（同一道题连判三次必须各自真跑一次，票 15 的证据要求）
      cacheRetention: 'none',
      // ★ 调用方没给 signal 时必须自己兜一个超时（F10）：`execute()` 的第 3 个入参
      //   在某些调用形态下是 `undefined`，没有这一行就等于**没有超时**——
      //   一次外呼卡住会让本 Tool 永久 pending（学生只看到转圈）。
      signal: input.signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS)
    }
  )
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

/** 主观题判分的档位与失败文案见 {@link SUBJECTIVE_SCORE_STEPS} / {@link SUBJECTIVE_GRADING_FAILED_TEXT}。 */

export interface QuizExtensionOptions {
  /**
   * ★ **票 15 的接入点**：LLM 变式生成器（`generate_quiz` 与 `generate_variants` 共用）。
   *
   * 缺省时只用本地题库 —— 断网、无 Key 都能出题。
   * 生成器返回的东西会被 {@link prepareVariants} 校验，校验不过就重试，
   * 重试仍不过就**退回题库**（`source` 回到 `"bank"`），不抛错、不空题。
   *
   * ⚠️ 生成器的返回值里**必须**含每题的标准答案（`answer`）与可选的评分细则（`rubric`），
   * 它们会被 {@link registerVariants} 登记到后端（判分只认后端库里的答案）。
   * ★ 两条出题路径**都是先登记再下发**（F4）：`generate_quiz` 以前跳过登记，
   * 学生做完必然判分 404。
   */
  generateQuestions?: (request: GenerateQuestionsRequest) => Promise<unknown>
  /** 请求出口（默认 `apiFetch`）。 */
  request?: QuizRequester
  /** LLM 生成失败后的重试次数（默认 2，即最多尝试 3 次）。 */
  generationRetries?: number
  /** 日志出口（默认 `console.warn`）。 */
  log?: (line: string) => void
  /**
   * ★ LLM 补全出口（票 15 主观题判分用；由 `runtime.ts` 接线）。
   * **不接线 = 无 API Key 世界**：主观题走可读降级（不判分、也不报错）。
   */
  complete?: LlmComplete | null
  /**
   * ★ 变式题登记出口（默认 {@link registerVariants}；测试注入假实现）。
   * 把「题干 + 标准答案 + 评分细则」交给 Python 侧落库，返回**不含答案**的对外载荷。
   */
  register?: RegisterVariantsFn
  /** 主观题结论落库出口（默认 {@link postSubjectiveGrade}；测试注入假实现）。 */
  submitSubjective?: SubmitSubjectiveGradeFn
  /** 闯关进度读取出口（默认 {@link fetchProgress}；测试注入假实现）。 */
  progress?: FetchProgressFn
}

/** 变式题登记出口的签名。 */
export type RegisterVariantsFn = (input: {
  studentId: string
  gradeLevel: string
  /** 每题都**必须**带标准答案（`answer`）与（主观题才有的）`rubric`。 */
  questions: Array<Record<string, unknown>>
}) => Promise<QuizPayloadShape | null>

/** 主观题结论落库出口的签名（`score` 由模型给，「多少分算过」由 Python 定）。 */
export type SubmitSubjectiveGradeFn = (input: {
  studentId: string
  qid: string
  score: number
  feedback: string
  sessionId: string
}) => Promise<QuizResultShape | null>

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/**
 * 失败结果的统一形状：**就是 {@link toolFailure}**（F11）。
 *
 * 以前这里另有一份逐字同构的私有 `failed()`：四份拷贝一旦有一份漂移，
 * 事件层（`agent/events.ts` 只认 `details.error === true`）与轨迹（`agent/trace.ts`
 * 认 `details.ok === false`）就会各认一半，失败会**静默变成成功**。
 * 别名只是为了少改调用点，语义一字不变。
 */
const failed = toolFailure

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

/**
 * 从 `execute()` 的 `ctx` 里取模型通道（**只读两个字段**，不 import Pi 的类型）。
 *
 * 认不出就返回 `undefined` —— 与项目其它地方同一条口径：**不猜**。
 * 没有它 = 没有模型可用（无 Key / 非标准上下文），调用方据此走可读降级。
 */
export function readCompletionContext(ctx: unknown): PiCompletionContext | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const record = ctx as Record<string, unknown>
  const model = record.model
  const registry = record.modelRegistry
  if (!model || !registry || typeof registry !== 'object') return undefined
  return {
    model,
    modelRegistry: registry as PiCompletionContext['modelRegistry']
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

/* ------------------------------------------------------------------ *
 * 变式题登记（票 15）：答案进 Python，出参不含答案
 * ------------------------------------------------------------------ */

/**
 * ★ 生成变式题的 `qid`（**前端可见的 id 与后端登记的 id 必须是同一个**）。
 *
 * 为什么不让 Python 侧生成：题目卡片先发给学生（上面带着 qid），
 * 后端若另编号，学生提交时带回来的 qid 就查不到 —— 判分必 404。
 * 随机段是为了**同一知识点反复生成不撞 id**（撞了会覆盖上一批题的答案）。
 */
export function variantQid(kpId: string, index: number, seed: string): string {
  const safeKp = kpId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'kp'
  return `gen-${safeKp}-${seed}-${index + 1}`
}

/** 生成随机种子（不用 `Math.random`：Node 的 crypto 更诚实，也便于测试注入）。 */
function randomSeed(): string {
  try {
    // 主进程里 `node:crypto` 一定可用；纯函数测试路径走不到这里
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
    return randomUUID().split('-')[0]
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}

/**
 * ★ **默认的变式题登记出口**：`POST /api/quiz/variants`。
 *
 * 只走 `bridge/client.ts`（token 注入的唯一出口）。返回的是**投影后**的对外载荷 ——
 * 即使后端因为 bug 多回了一个 `answer`，{@link projectBankPayload} 的白名单也会把它丢掉。
 */
export async function registerVariants(input: {
  studentId: string
  gradeLevel: string
  questions: Array<Record<string, unknown>>
}): Promise<QuizPayloadShape | null> {
  // ⚠️ 调用点动态 import（与 `learning-log.ts` 同因）：`bridge/client.ts` 里有一处缺 `.ts`
  // 的导入，Node 直跑 TS 时会让整个模块导入失败；推迟到真正发请求的那一刻，
  // 投影/校验这类纯逻辑就还能被 `node --test` 覆盖。生产产物照常静态分析内联。
  const { apiFetch } = await import('../../bridge/client.ts')
  const response = await apiFetch(
    `/api/quiz/variants?student_id=${encodeURIComponent(input.studentId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gradeLevel: input.gradeLevel, questions: input.questions }),
      signal: AbortSignal.timeout(QUIZ_TIMEOUT_MS)
    }
  )
  if (!response.ok) return null
  const raw = (await response.json()) as unknown
  const kpId = readNonEmptyString((raw as Record<string, unknown>)?.kpId) ?? ''
  return projectBankPayload(raw, kpId)
}

/**
 * ★ **默认的主观题落库出口**：`POST /api/quiz/grade-subjective`。
 *
 * ⚠️ 送的是 `score`（模型给的分数）而**不是**对错：「多少分算过」由 Python 定
 * （`routes/quiz.py` 的 `SUBJECTIVE_PASS_RATIO`）。两边各写一份判定 = 迟早漂移。
 */
export async function postSubjectiveGrade(input: {
  studentId: string
  qid: string
  score: number
  feedback: string
  sessionId: string
}): Promise<QuizResultShape | null> {
  const { apiFetch } = await import('../../bridge/client.ts')
  const response = await apiFetch('/api/quiz/grade-subjective', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentId: input.studentId,
      qid: input.qid,
      score: input.score,
      feedback: input.feedback,
      sessionId: input.sessionId
    }),
    signal: AbortSignal.timeout(QUIZ_TIMEOUT_MS)
  })
  if (!response.ok) return null
  return (await response.json()) as QuizResultShape
}

/* ------------------------------------------------------------------ *
 * 变式题准备（票 15）：**登记给后端的那一份**与**发给前端的那一份**在这里分开
 * ------------------------------------------------------------------ */

/** 校验+拆分的结果：`questions` 含答案（给后端），`subjective` 是其中的主观题。 */
export type PreparedVariants =
  | {
      ok: true
      /** ★ 含 `answer`（登记给后端用）。**不要**把它交给事件层/前端。 */
      questions: Array<Record<string, unknown>>
      /** 其中的主观题（带 `rubric`）—— 细则要留在会话里供判分使用。 */
      subjective: SubjectiveQuestionShape[]
    }
  | { ok: false; reason: string }

/**
 * ★ 校验模型生成的一组变式题，并把「登记用」与「展示用」分开。
 *
 * 与 {@link validateGeneratedQuiz} 的差别：后者只产出**对外载荷**（答案被丢掉），
 * 本函数还额外保留**含答案的原始条目** —— 因为变式题必须先把答案登记到后端，
 * 否则学生提交时判分 404（这是与题库题最本质的不同）。
 *
 * 校验口径（票 15）：
 *   - 题型限定在 `choice / blank / code_blank`（契约冻结的三种）；
 *   - 每题**必须有答案**（后端要判分）；
 *   - `kpId` 必须与请求一致（否则答案会被登记到错的关卡上）；
 *   - 学了 `rubric`（非空）就按主观题处理：也必须有「参考答案」（`answer`），
 *     它是给模型对照的样本答案，不是唯一解。
 */
export function prepareVariants(
  raw: unknown,
  expect: { kpId: string; gradeLevel: string; maxQuestions?: number; seed?: string }
): PreparedVariants {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '生成结果不是一个对象' }
  const record = raw as Record<string, unknown>
  const questions = record.questions
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, reason: '生成结果里没有 questions 数组（或为空）' }
  }

  const limit = Math.min(expect.maxQuestions ?? MAX_QUIZ_QUESTIONS, MAX_QUIZ_QUESTIONS)
  const seed = readNonEmptyString(expect.seed) ?? randomSeed()
  const toRegister: Array<Record<string, unknown>> = []
  const subjective: SubjectiveQuestionShape[] = []
  const used = new Set<string>()

  for (const [index, item] of questions.slice(0, limit).entries()) {
    if (!item || typeof item !== 'object') {
      return { ok: false, reason: `第 ${index + 1} 道题不是对象` }
    }
    const source = item as Record<string, unknown>
    const projected = projectQuestion(source)
    if (projected === null) {
      return { ok: false, reason: `第 ${index + 1} 道题缺少 qid/type/stem/options（无法渲染）` }
    }
    if (projected.kpId && projected.kpId !== expect.kpId) {
      return { ok: false, reason: `第 ${index + 1} 道题的 kpId（${projected.kpId}）与请求的不一致` }
    }

    const answer = source.answer
    const hasAnswer =
      (typeof answer === 'string' && answer.trim().length > 0) ||
      (Array.isArray(answer) && answer.some((value) => readNonEmptyString(value) !== null))
    if (!hasAnswer) {
      return { ok: false, reason: `第 ${index + 1} 道题没有标准答案（后端将无法判分）` }
    }

    // ★ qid 由**这里**统一生成：模型给的 qid 可能是 `q1` 这种会互相撞的名字，
    //   撞了会覆盖上一批题的答案（后端按 qid 覆盖）。带上随机段 + 序号后必不撞。
    const qid = variantQid(expect.kpId, index, seed)
    if (used.has(qid)) continue
    used.add(qid)

    const stem = projected.stem
    const rubric = readNonEmptyString(source.rubric) ?? null
    // ★ 解析取自**原始条目**（`projectQuestion` 的白名单里已经没有它了，见那个函数）：
    //   登记给后端的那一份要带上它 —— 判分后的 `QuizResult.feedback` 正是由它拼出来的。
    //   这一份从头到尾不出后端（`registerVariants` 只把它发进 Python），
    //   所以"契约不下发解析"与"后端要有解析"两件事并不冲突。
    const explanation = readNonEmptyString(source.explanation) ?? ''
    const options = projected.options

    toRegister.push({
      qid,
      kpId: expect.kpId,
      type: projected.type,
      stem,
      options,
      // ★ 标准答案：只进后端（`registerVariants` 的那一条请求体）
      referenceAnswer: answer,
      explanation,
      ...(rubric ? { rubric } : {})
    })

    if (rubric) {
      subjective.push({
        qid,
        kpId: expect.kpId,
        type: projected.type,
        stem,
        options,
        explanation,
        rubric,
        answer: answer as string | string[]
      })
    }
  }

  if (toRegister.length === 0) return { ok: false, reason: '没有一道题通过校验' }
  return { ok: true, questions: toRegister, subjective }
}

/** 闯关进度里的一关（`GET /api/quiz/progress/{student_id}` 的出参，**后端是唯一权威**）。 */
export interface ProgressLevelShape {
  kpId: string
  /** `locked | learning | quizzed | mastered`（契约 `ProgressStage`）。 */
  stage: string
  badge: string | null
  mastery: number
}

/** 闯关进度快照（附在 `submit_quiz` 的结果里，供进度卡片渲染）。 */
export interface ProgressShape {
  levels: ProgressLevelShape[]
  /** 已通过关数 / 总关数（前端画进度条用；**由后端给的 stage 数算出**）。 */
  progress: { done: number; total: number }
  /** 本次作答**新解锁**的关卡（用于给学生一句「下一关开了」的提示）。 */
  unlocked?: string[]
}

/** 进度读取出口（默认 {@link fetchProgress}；测试注入假实现）。 */
export type FetchProgressFn = (studentId: string) => Promise<ProgressShape | null>

/**
 * ★ 读闯关进度（`GET /api/quiz/progress/{student_id}`）。
 *
 * 为什么判分完要**额外**读一次：`QuizResult` 契约里只有 `qid/correct/scored_by/feedback/
 * mastery_delta` 五个字段（§6.5 冻结），**没有**关卡信息 —— 而闯关 UI 需要它。
 * 两种做法里选了这个：
 *   ① 往 `QuizResult` 加字段 → **改冻结契约**（`contracts.py` 不归本票，且会让前端/后端
 *      同时漂移）；
 *   ② 判分后再读一次进度 → 复用既有端点，契约一个字不动（**当前实现**）。
 *
 * 失败一律返回 `null`：进度是**展示增强**，读不到不该让一次成功的判分变成失败
 * （学生已经答对了，界面却报「提交失败」是最糟的形态）。
 */
export async function fetchProgress(studentId: string): Promise<ProgressShape | null> {
  const { apiFetch } = await import('../../bridge/client.ts')
  const response = await apiFetch(
    `/api/quiz/progress/${encodeURIComponent(studentId)}`,
    { method: 'GET', signal: AbortSignal.timeout(QUIZ_TIMEOUT_MS) }
  )
  if (!response.ok) return null
  return projectProgress(await response.json())
}

/**
 * 把进度响应投影成前端需要的形状（**白名单**，与题目投影同一纪律）。
 *
 * 认不出的关卡**整关丢掉**（宁可少显示一关，也不要一关状态不明的进度 ——
 * 那会让学生看到「未解锁」而其实已经通过了）。
 */
export function projectProgress(raw: unknown): ProgressShape | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const rawLevels = Array.isArray(record.levels) ? record.levels : []
  const levels: ProgressLevelShape[] = []
  for (const item of rawLevels) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const kpId = readNonEmptyString(entry.kpId)
    const stage = readNonEmptyString(entry.stage)
    if (kpId === null || stage === null) continue
    const masteryRaw = Number(entry.mastery)
    levels.push({
      kpId,
      stage,
      badge: readNonEmptyString(entry.badge),
      mastery: Number.isFinite(masteryRaw) ? Math.max(0, Math.min(1, masteryRaw)) : 0
    })
  }
  if (levels.length === 0) return null
  const done = levels.filter((item) => item.stage === 'quizzed' || item.stage === 'mastered').length
  return { levels, progress: { done, total: levels.length } }
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
  // ★ 默认用 `ctx` 的模型（见 `completeViaContext`）；注入的实现优先（测试与自定义）
  const generateQuestions = options.generateQuestions ?? generateQuestionsViaContext
  const registerVariantsFn = options.register ?? registerVariants
  const submitSubjectiveFn = options.submitSubjective ?? postSubjectiveGrade
  const fetchProgressFn = options.progress ?? fetchProgress

  /**
   * 本轮 Pi 的扩展上下文（`execute()` 的第 5 个入参）。
   *
   * 为什么存成可变变量而不是当参数一层层传：`generate` / `generateVariants` /
   * `gradeSubjective` 都要它（取模型），而 Pi 只把它交给 `execute`。
   * 每次 `execute` 开头覆盖一次（单进程单会话、串行执行），用完不清理也没问题 ——
   * 它只是一次调用的引用，不持有凭证。
   */
  let toolContext: PiCompletionContext | undefined
  let toolSignal: AbortSignal | undefined

  /**
   * ★ 本次会话里「哪些 qid 是主观题、它们的评分细则是什么」。
   *
   * 为什么放在 Extension 的 Map 里（而不是 State / 数据库）：细则**只在判分的那一刻**
   * 用一次，属于单会话的临时态 —— 与执行文档 §6.6「本轮临时态放 Extension 内存 Map」
   * 的处置一致（动画重试计数是同一类东西）。
   *
   * 为什么需要它：判分要「题干 + 要点」，而发给前端的载荷里**只有题干**（细则是判分依
   * 据，不能给学生）。所以登记变式题时顺手在内存里留一份，判分时按 qid 取回。
   * **落库的那一份在 Python 侧**（`generated_question.rubric`）—— 这里只是本会话的缓存，
   * 进程重启后为空，此时 `submit_quiz` 会返回可读错误让学生重新出题（不静默瞎判）。
   *
   * ★ 两条边界（F12）：
   *   ① **有容量上限**（{@link RUBRIC_CACHE_LIMIT}，LRU 式丢最旧一半，同 `animation.ts`
   *      的 `MAX_TRACKED_CALLS` 手法）—— 它只增不减的写法在长会话里会一直攒；
   *   ② **换学生时整表清掉**（键里虽然有 qid，但 qid 是随机的、不含学生身份）——
   *      不清理就等于把上一个学生的主观题细则留在下一个学生的会话里。
   *      **学生切换的判据是每次 `execute` 开头比对的 `currentAgentSession()`**
   *      （不在本文件里订阅任何全局事件，见文件头的「不自建事件总线」纪律）。
   */
  const rubricCache = new Map<string, { stem: string; rubric: string }>()
  /** rubricCache 的容量上限（同屏题目是个位数，64 已经非常宽裕）。 */
  const RUBRIC_CACHE_LIMIT = 64

  /** 写一条细则进缓存（带上限：满了就丢最旧的一半，Map 保持插入序）。 */
  function noteRubric(qid: string, stem: string, rubric: string): void {
    if (rubricCache.size >= RUBRIC_CACHE_LIMIT && !rubricCache.has(qid)) {
      const keys = [...rubricCache.keys()].slice(0, RUBRIC_CACHE_LIMIT / 2)
      for (const key of keys) rubricCache.delete(key)
    }
    rubricCache.set(qid, { stem, rubric })
  }

  /** 上一次见到的学生（临时态清理的判据，见 {@link noteStudentBoundary}）。 */
  let trackedStudentId = ''

  /** 换学生 → 清掉本会话的临时态（细则缓存）。同学生会话内不动它（判分还要用）。 */
  function noteStudentBoundary(studentId: string | undefined): void {
    const next = studentId ?? ''
    if (next === trackedStudentId) return
    if (trackedStudentId !== '' || next !== '') {
      // 只在**真的换了一个人**时清理；首次绑定（''→X）没有旧数据可清，清一次也无害
      rubricCache.clear()
    }
    trackedStudentId = next
  }

  /** 一次带超时的请求（超时 / 网络异常都由调用方收敛成可读错误）。 */
  async function call(path: string, init?: RequestInit): Promise<Response> {
    return await request(path, { ...init, signal: AbortSignal.timeout(QUIZ_TIMEOUT_MS) })
  }

  /**
   * 出题：**题库优先**（断网兜底的根），题库没有才走 LLM 生成（票 15），
   * 生成失败重试 ≤2 → 仍失败就如实报错（**不返回空题**：空题会让前端渲染一张空卡片）。
   *
   * ★ **LLM 生成的那一批必须先登记到后端**（F4，与 `generateVariants` 同一条链）：
   *   题卡先发给学生，标准答案留在 Python —— 判分只查「该学生生成题表 → 随包题库」，
   *   不登记的话学生做完 `submit_quiz` 必然 404，整轮练习白做（题卡看起来完全正常）。
   */
  async function generate(
    kpId: string,
    gradeLevel: string,
    count: number,
    session: { studentId: string; sessionId: string } | null
  ) {
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
      if (payload !== null) {
        // 出题时也带上进度：学生在做题前就能看到「我在第几关」
        return ok(renderQuizText(payload), await withProgress(payload, session?.studentId ?? ''))
      }
    } else if (bank.status !== 404) {
      const snippet = await readSnippet(bank)
      return failed(
        `取题失败：本地题库服务返回 HTTP ${bank.status}${snippet ? `（${snippet}）` : ''}。`,
        SIDECAR_UNAVAILABLE_TEXT
      )
    }

    // 到这里 = 题库没有这个知识点的题（404 / 空题）
    // ★ 判据是「模型通道能不能用」（注入了生成器 或 `ctx` 里有模型），
    //   不是「有没有注入生成器」：默认生成器也要 `ctx` 才取得到模型。
    if (!options.generateQuestions && !toolContext?.model) {
      return failed(
        `本地题库里还没有「${kpId}」这个知识点的题目，而当前没有可用的模型（还没配置 API Key）` +
          '来临时出题。请换成题库里已有的知识点出题，或先用对话把这个概念讲清楚。'
      )
    }
    // ★ 生成题必须登记到**具体学生**名下（答案的去向），所以这里要身份；
    //   身份仍然只来自主进程（`currentAgentSession()`），不是 Tool 参数。
    if (!session) {
      return failed(
        `本地题库里还没有「${kpId}」这个知识点的题目，而当前没有绑定学生，` +
          '临时出的题没法把标准答案登记到具体学生名下（否则批改时会查不到这道题）。' +
          '请先直接回应学生，或换成题库里已有的知识点出题。'
      )
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const raw = await generateQuestions({
          kpId,
          gradeLevel,
          count,
          attempt,
          ...(toolContext ? { context: toolContext } : {}),
          ...(toolSignal ? { signal: toolSignal } : {})
        })
        // ★ 与变式题**同一条登记链**（F4）：校验（含答案的那一份）→ 登记进 Python
        //   → 只有登记成功才把**不含答案**的载荷发给学生。
        const prepared = prepareVariants(raw, { kpId, gradeLevel, maxQuestions: count })
        if (!prepared.ok) {
          log(`[quiz] LLM 出题校验未通过（第 ${attempt + 1} 次）：${prepared.reason}`)
          continue
        }
        const registered = await registerVariantsFn({
          studentId: session.studentId,
          gradeLevel,
          questions: prepared.questions
        })
        if (registered === null) {
          // ★ 登记失败时**绝不把题发给学生**（后端判不了分），如实降级到下一轮重试/退回题库
          log(
            `[quiz] LLM 出题登记失败（第 ${attempt + 1} 次）：后端未接受（校验不通过或服务不可用）`
          )
          continue
        }
        // 主观题的细则留在本会话内存里（判分用；**绝不进载荷**）
        for (const question of prepared.subjective) {
          noteRubric(question.qid, question.stem, question.rubric)
        }
        log(
          `[quiz] 题库缺「${kpId}」，已用模型出题并登记 ${registered.questions.length} 道` +
            (prepared.subjective.length > 0 ? `（含 ${prepared.subjective.length} 道主观题）` : '')
        )
        return ok(renderQuizText(registered), await withProgress(registered, session.studentId))
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

  /**
   * ★ 生成**变式题**（票 15）：与 {@link generate} 的关键差别是**答案的去向**。
   *
   * - `generate`（题库优先）**不需要**答案：题库里的答案早就在 Python 侧；
   * - 本函数生成的题**必须**把 `answer` / `rubric` 登记到后端（`POST /api/quiz/variants`），
   *   否则学生提交时后端查不到 qid → 判分 404。
   *
   * 三道闸门保证答案不出后端：
   *   ① {@link validateGeneratedQuiz} 校验「有答案 + 投影后的载荷」；
   *   ② 登记时把**原始条目**（含答案）交给 Python，只把**投影后的载荷**留给前端；
   *   ③ 登记失败 → 退回题库（`source=bank`），**绝不**把一道后端判不了的题发给学生。
   *
   * 主观题（带 `rubric` 的开放题）也在这里一并登记，并顺手在 {@link rubricCache} 留一份细则
   * —— 判分时要它（细则不能发给前端，所以不能从载荷里取）。
   */
  async function generateVariants(
    kpId: string,
    gradeLevel: string,
    count: number,
    session: { studentId: string; sessionId: string }
  ) {
    if (!generateQuestions) {
      return failed('变式题生成还没有接入（没有可用的模型）。请改用 generate_quiz。')
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const raw = await generateQuestions({
          kpId,
          gradeLevel,
          count,
          attempt,
          ...(toolContext ? { context: toolContext } : {}),
          ...(toolSignal ? { signal: toolSignal } : {})
        })
        const prepared = prepareVariants(raw, { kpId, gradeLevel, maxQuestions: count })
        if (!prepared.ok) {
          log(`[quiz] 变式题校验未通过（第 ${attempt + 1} 次）：${prepared.reason}`)
          continue
        }

        // ★ 登记（含答案的那一份进 Python；出参是不含答案的对外载荷）
        const registered = await registerVariantsFn({
          studentId: session.studentId,
          gradeLevel,
          questions: prepared.questions
        })
        if (registered === null) {
          log(`[quiz] 变式题登记失败（第 ${attempt + 1} 次）：后端未接受（题库/校验/服务不可用）`)
          continue
        }

        // ★ 主观题的细则留在本会话内存里（判分用；**绝不进载荷**）
        for (const question of prepared.subjective) {
          noteRubric(question.qid, question.stem, question.rubric)
        }
        log(
          `[quiz] 变式题已登记 ${registered.questions.length} 道` +
            (prepared.subjective.length > 0
              ? `（含 ${prepared.subjective.length} 道主观题，判分走模型）`
              : '')
        )
        // ★ 出题时也带上进度：学生在做题前就能看到「我在第几关」（票 15 的闯关 UI）
        return ok(renderQuizText(registered), await withProgress(registered, session.studentId))
      } catch (error) {
        log(
          `[quiz] 变式题生成/登记失败（第 ${attempt + 1} 次）：${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    // ★ 重试仍失败 → **退回题库**（与 `generate` 同一兜底口径：不抛错、不空题）
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
          log('[quiz] 变式题不可用，已退回本地题库（source=bank）')
          return ok(renderQuizText(payload), payload)
        }
      }
    } catch {
      // 两条路都不通，下面统一给可读错误
    }
    return failed(
      `暂时没能为「${kpId}」生成变式题（模型生成或登记失败，题库里也没有这道题的题）。` +
        '请换一个知识点，或先用对话把概念讲清楚。'
    )
  }

  /**
   * ★ 给载荷**附加**进度快照（票 15 的闯关 UI）。
   *
   * **附加而不是替换**：`QuizPayload` 的既有字段（`kpId` / `questions` / `source`）
   * 一个字不动 —— 进度是 `levels` 这个额外键，前端拿旧的投影逻辑照样能渲染出路卡片
   * （`cards/quiz.ts` 的白名单只看它认识的字段，多一个键不影响）。
   *
   * 读不到进度就原样返回（进度是展示增强，不是出题/判分的必要条件）。
   */
  async function withProgress<T extends object>(
    payload: T,
    studentId: string
  ): Promise<T & { levels?: ProgressLevelShape[]; progress?: ProgressShape['progress'] }> {
    try {
      const progress = await fetchProgressFn(studentId)
      if (progress === null) return payload
      return { ...payload, levels: progress.levels, progress: progress.progress }
    } catch (error) {
      log(`[quiz] 进度读取失败（不影响本次出题/判分）：${error instanceof Error ? error.message : String(error)}`)
      return payload
    }
  }

  return function quizExtension(pi: AgentExtensionApi): void {
    /**
     * ★ 主观题判分（票 15）：**LLM 问分 + Python 落库**两步，缺一不可。
     *
     * 只在服务端明确回「这是主观题」（HTTP 409）之后才走这条路 ——
     * 「一道题是不是主观题」由后端按它的 `rubric` 判定，TS 侧不自作主张。
     */
    async function gradeSubjective(
      qid: string,
      answer: string | string[],
      studentId: string,
      sessionId: string
    ): Promise<ReturnType<typeof ok> | ReturnType<typeof failed>> {
      const complete = options.complete
      const submitSubjective = submitSubjectiveFn

      if (!complete && !toolContext) {
        // ★ 无 API Key = 判不了就说不判（**不瞎判**：主观题乱判直接污染掌握度）
        //
        // ⚠️ `details` 里**必须带 `text`**（F5）：事件层（`agent/events.ts` 的 `readPayload`）
        //   把 details 原样展开成 payload，而渲染侧的 `cards/quiz.ts` 需要一个能认出的形状 ——
        //   它只认 `questions[]` 或 `qid` + `correct`。这里既没有题目也没有对错，
        //   所以**只靠 `details.text` 落入 unknown 分支**（卡片显示这句话）。
        //   没有 `text` 时学生看到的是「练习卡片的内容格式不对」—— 一个设计好的降级
        //   会被呈现成「系统坏了」。
        return ok(SUBJECTIVE_UNAVAILABLE_TEXT, {
          ok: true,
          qid,
          scoredBy: 'llm',
          degraded: true,
          note: SUBJECTIVE_UNAVAILABLE_TEXT,
          text: SUBJECTIVE_UNAVAILABLE_TEXT
        })
      }

      // ① 取评分细则：本会话登记变式题时留下的那一份（见 `rubricCache`）。
      //    取不到就明说让模型重新生成 —— 宁可让学生重新出一遍题，也不要瞎判。
      const rubric = rubricCache.get(qid)
      if (!rubric) {
        return failed(
          `这道题（${qid}）需要评分细则才能判分，但当前会话里没有它的细则。` +
            '请重新用 generate_variants 生成这道题（细则会随之登记），再让学生作答。'
        )
      }

      const session = currentAgentSession()
      const gradeLevel = resolveGradeLevel(undefined, session?.gradeLevel)
      const answerText = Array.isArray(answer) ? answer.join('\n') : String(answer)

      let judged: { score: number; feedback: string } | null = null
      try {
        const text = complete
          ? await complete({
              purpose: 'subjective_grade',
              prompt: buildSubjectiveGradingPrompt({
                gradeLevel,
                stem: rubric.stem,
                rubric: rubric.rubric,
                answer: answerText
              }),
              ...(toolSignal ? { signal: toolSignal } : {})
            })
          : await completeViaContext(toolContext, {
              prompt: buildSubjectiveGradingPrompt({
                gradeLevel,
                stem: rubric.stem,
                rubric: rubric.rubric,
                answer: answerText
              }),
              ...(toolSignal ? { signal: toolSignal } : {})
            })
        judged = parseSubjectiveScore(text)
      } catch (error) {
        log(
          `[quiz] 主观题判分调用失败：${error instanceof Error ? error.message : String(error)}`
        )
        return failed('主观题判分调用失败（模型没有响应）。本次没有更新掌握度，稍后再试一次。', error)
      }

      if (!judged) {
        // 模型没按要求给分：**不落库**（宁可不判，也不要一个脏分数进 mastery）
        return failed(SUBJECTIVE_GRADING_FAILED_TEXT)
      }

      // ② 落库（Python 定「多少分算过」，并推进掌握度与闯关）
      try {
        const result = await submitSubjective({
          studentId,
          qid,
          score: judged.score,
          feedback: judged.feedback,
          sessionId
        })
        if (!result) {
          return failed('主观题判分结果没能写入学习记录（本地服务未就绪）。请稍后再试一次。')
        }
        // ★ 判分成功后附上闯关进度（关卡 D 的「下一关解锁 → 进度条前进 → 徽章更新」在这里可见）
        return ok(renderResultText(result), await withProgress(result, studentId))
      } catch (error) {
        return failed('主观题判分结果没能写入学习记录。本次没有更新掌握度。', error)
      }
    }

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
      execute: async (
        _toolCallId: string,
        params: GenerateQuizParamsType,
        signal?: AbortSignal,
        _onUpdate?: unknown,
        ctx?: unknown
      ) => {
        toolContext = readCompletionContext(ctx)
        toolSignal = signal
        const session = currentAgentSession()
        // ★ 换学生就清掉本会话的临时态（评分细则，F12）—— 不在本文件订阅任何全局事件
        noteStudentBoundary(session?.studentId)
        const kpId = readNonEmptyString(params?.kpId)
        if (kpId === null) {
          return failed('出题需要知识点 id（例如 prog-loop-jr）。请先确认要练哪个知识点。')
        }
        const gradeLevel = resolveGradeLevel(params?.gradeLevel, session?.gradeLevel)
        const count =
          typeof params?.count === 'number' && Number.isFinite(params.count)
            ? Math.max(1, Math.min(MAX_QUIZ_QUESTIONS, Math.trunc(params.count)))
            : DEFAULT_QUIZ_QUESTIONS
        // ★ 把身份**快照**传下去（F4 起 LLM 生成题也要登记答案，需要 studentId）；
        //   函数内不再读全局，避免中途切学生把答案登记到别人名下。
        return await generate(kpId, gradeLevel, count, session)
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
      execute: async (
        _toolCallId: string,
        params: SubmitQuizParamsType,
        signal?: AbortSignal,
        _onUpdate?: unknown,
        ctx?: unknown
      ) => {
        // ★ 主观题判分要用模型，而模型只能从 `ctx` 取 —— 所以这里必须先记下上下文
        toolContext = readCompletionContext(ctx)
        toolSignal = signal
        const session = currentAgentSession()
        // ★ 换学生就清掉本会话的临时态（评分细则，F12）；**必须在读 rubricCache 之前**
        noteStudentBoundary(session?.studentId)
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
            // ★ 409 = 服务端说「这是主观题，走模型判分」（票 15）。
            //   判据在服务端（看题目的 rubric），所以这里的重定向也是服务端驱动的 ——
            //   TS 侧不自己猜题型。
            if (response.status === 409) {
              return await gradeSubjective(qid, answer, session.studentId, session.sessionId)
            }
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
          // ★ 判分成功后附上闯关进度（关卡 D 的「下一关解锁 → 进度条前进 → 徽章更新」在这里可见）
          return ok(renderResultText(result), await withProgress(result, session.studentId))
        } catch (error) {
          return failed('提交作答失败（本地服务不可用），本次没有更新掌握度。', error)
        }
      }
    })

    pi.registerTool({
      name: 'generate_variants',
      label: '变式题',
      description:
        '为同一个知识点生成变式题（换数字、换问法、换成开放式问答题），用于多练几遍或换角度检验。' +
        '题目由模型现出，标准答案与评分细则会登记到本地后端（判分/批改只认后端）。' +
        '缺 API Key 或生成失败时自动退回本地题库，不会给出空题。',
      promptSnippet: 'generate_variants：同知识点的变式题（模型现出，含开放题）',
      promptGuidelines: [
        '想让学生多练几遍、或想换个问法检验理解时用 generate_variants；要题库里的现成题用 generate_quiz。',
        '生成出来的题同样会以练习卡片显示；学生答完仍用 submit_quiz 批改（开放题会自动走模型判分）。'
      ],
      parameters: GenerateVariantsParams,
      execute: async (
        _toolCallId: string,
        params: GenerateVariantsParamsType,
        signal?: AbortSignal,
        _onUpdate?: unknown,
        ctx?: unknown
      ) => {
        toolContext = readCompletionContext(ctx)
        toolSignal = signal
        const kpId = readNonEmptyString(params?.kpId)
        if (kpId === null) return failed('生成变式题需要知识点 id。')
        const session = currentAgentSession()
        // ★ 换学生就清掉本会话的临时态（评分细则，F12）
        noteStudentBoundary(session?.studentId)
        if (!session) {
          return failed('还没有绑定当前学生，无法登记生成题（答案要存到具体学生名下）。')
        }
        // ★ 模型通道可用性由 `ctx` 决定（而不是「有没有注入生成器」）：
        //   默认生成器也要 `ctx` 才拿得到模型，所以这两件事是同一个判据。
        if (!options.generateQuestions && !toolContext?.model) {
          return failed(
            '变式题生成需要模型，但当前会话没有可用的模型（还没配置 API Key）。' +
              '请改用 generate_quiz 出题 —— 它会从本地题库取题，同样能多练几遍。'
          )
        }
        const gradeLevel = resolveGradeLevel(params?.gradeLevel, session?.gradeLevel)
        const count =
          typeof params?.count === 'number' && Number.isFinite(params.count)
            ? Math.max(1, Math.min(MAX_QUIZ_QUESTIONS, Math.trunc(params.count)))
            : DEFAULT_QUIZ_QUESTIONS
        return await generateVariants(kpId, gradeLevel, count, session)
      }
    })
  }
}

/** 默认工厂（`runtime.ts` 直接注入它；票 15 用 {@link createQuizExtension} 注入生成器）。 */
export default createQuizExtension()
