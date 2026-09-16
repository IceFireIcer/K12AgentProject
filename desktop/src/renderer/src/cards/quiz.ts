/**
 * 练习卡片的**纯逻辑**（票 14 的前端一半）：把 `payload` 事件的 `unknown` 载荷
 * 投影成可渲染的结构，并生成「提交作答」的那条对话消息。
 *
 * 三条纪律（本文件是它们的落点，改动前先读）：
 *
 * 1. ★★ **答案不出后端**（§6.3）：题目载荷里**结构上就没有** `answer`。
 *    本文件对所有外部载荷做**白名单投影**（只挑 qid/kpId/type/stem/options 五个字段），
 *    而不是黑名单删字段 —— LLM 生成的题若多带了 `answerText` / `solution` / `correctOption`，
 *    白名单一样进不来。**不要**在这里加任何「拿答案本地判分」的兜底：
 *    判分只走后端（`POST /api/quiz/grade`），前端拿不到答案，也不该需要答案。
 * 2. **不渲染 `explanation`**：题面载荷里带了解析（后端为了让模型能组织语言），
 *    但解析里往往直接写着答案（「加法用 + 号」）。所以投影时**主动丢掉**它 ——
 *    解析只在批改结果的 `feedback` 里出现（那是判完分之后的事）。
 * 3. **脏数据不抛异常**：认不出的载荷返回 `{ kind: 'unknown' }`，卡片退化成一句说明，
 *    绝不让一个畸形 payload 把整轮对话渲染炸掉（与 `api/events.ts` 同一原则）。
 */

/** 三种题型（契约 `QuizQuestionType`；执行文档 §11.4 第一期只做这三种）。 */
export const QUIZ_QUESTION_TYPES = ['choice', 'blank', 'code_blank'] as const
export type QuizQuestionType = (typeof QUIZ_QUESTION_TYPES)[number]

/** 载荷来源（契约 `QuizPayload.source`）。 */
export type QuizSource = 'bank' | 'generated'

/** 一道题的**对外渲染形态**：**没有 `answer`、也没有 `explanation`**（见文件头第 1、2 条）。 */
export interface QuizQuestionView {
  qid: string
  kpId: string
  type: QuizQuestionType
  stem: string
  /** 选择题的选项（其它题型为空数组）。 */
  options: string[]
}

/** 出题载荷的渲染形态（`generate_quiz` / `generate_variants` 的产出）。 */
export interface QuizQuestionsView {
  kind: 'questions'
  kpId: string
  source: QuizSource | null
  questions: QuizQuestionView[]
}

/** 批改结果的渲染形态（`submit_quiz` 的产出，全部字段来自后端，前端不改写）。 */
export interface QuizResultView {
  kind: 'result'
  qid: string
  correct: boolean
  scoredBy: 'rule' | 'llm' | null
  feedback: string
  masteryDelta: number
}

/** 认不出的载荷：退化成一句可读说明，不做任何猜测。 */
export interface QuizUnknownView {
  kind: 'unknown'
  /** 主进程在载荷里带的兜底文本（`{tool, kind, text}`），可能为空。 */
  text: string
}

export type QuizCardView = QuizQuestionsView | QuizResultView | QuizUnknownView

/** 选择题的选项字母（与后端判分口径一致：字母与选项原文等价，见 `routes/quiz.py`）。 */
const OPTION_LETTERS = 'ABCDEF'

/** 题干在提交消息里最多原样带多少字（提交本身要短，别把长题干灌进 prompt）。 */
export const MAX_STEM_CHARS_IN_SUBMISSION = 120

/**
 * 把 `payload` 事件里的载荷投影成卡片视图。
 *
 * 判别顺序（结构判别，不看 `tool` 字段 —— `tool` 只是提示，不可信）：
 *   1. 有 `questions` 数组 → 出题载荷；
 *   2. 有 `qid` 且有 `correct` → 批改结果；
 *   3. 其余 → `unknown`（含失败形态 `{tool, kind, text}`，把文本原样交给卡片展示）。
 */
export function readQuizCard(payload: unknown): QuizCardView {
  if (typeof payload !== 'object' || payload === null) return { kind: 'unknown', text: '' }
  const record = payload as Record<string, unknown>

  const questions = projectQuestions(record.questions)
  if (questions.length > 0) {
    return {
      kind: 'questions',
      kpId: readText(record.kpId) ?? '',
      source: readSource(record.source),
      questions
    }
  }

  const qid = readText(record.qid)
  if (qid !== null && typeof record.correct === 'boolean') {
    return {
      kind: 'result',
      qid,
      correct: record.correct,
      scoredBy: readScoredBy(record.scoredBy),
      feedback: readText(record.feedback) ?? '',
      masteryDelta: readNumber(record.masteryDelta)
    }
  }

  return { kind: 'unknown', text: readText(record.text) ?? '' }
}

/**
 * 题目数组的白名单投影（★ 答案泄漏防线的前端一半）。
 *
 * 认不准的题**整题丢掉**（宁可少一道题，也不要一道缺选项、让学生做不了的题）。
 */
export function projectQuestions(raw: unknown): QuizQuestionView[] {
  if (!Array.isArray(raw)) return []
  const questions: QuizQuestionView[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const qid = readText(record.qid)
    const type = readQuestionType(record.type)
    const stem = readText(record.stem)
    if (qid === null || type === null || stem === null) continue

    const options = Array.isArray(record.options)
      ? record.options.map((option) => readText(option)).filter((option): option is string => option !== null)
      : []
    // 选择题必须至少两个选项才能作答（与主进程 `projectQuestion` 同一口径）
    if (type === 'choice' && options.length < 2) continue

    questions.push({
      qid,
      kpId: readText(record.kpId) ?? '',
      type,
      stem,
      options
    })
  }
  return questions
}

/** 选项字母（`A` / `B` / …；超出范围时退回序号）。 */
export function optionLetter(index: number): string {
  return OPTION_LETTERS[index] ?? `#${index + 1}`
}

/**
 * 收集**整段对话**里的批改结果（按 `qid` 索引）。
 *
 * 为什么要跨轮收集：题在某一轮的卡片上，学生作答后**下一轮**才会带回批改结果。
 * 只在本轮卡片里找，题干那张卡片就永远看不到「答对了 / 掌握度 +0.15」。
 */
export function collectQuizResults(cards: Array<{ payload: unknown }>): Map<string, QuizResultView> {
  const results = new Map<string, QuizResultView>()
  for (const card of cards) {
    const view = readQuizCard(card.payload)
    // 同一题被答多次时，保留**最新**一次（后到的结果覆盖先前的）
    if (view.kind === 'result') results.set(view.qid, view)
  }
  return results
}

/**
 * 学生作答 → 发给主 Agent 的那条消息。
 *
 * 为什么走对话而不是加一条 IPC 通道：`submit_quiz` 是**模型的工具**，
 * 判分链是「学生作答 → 主 Agent → submit_quiz → Python 判分」；
 * 加一条「直接提交」的 IPC 等于在主进程里再实现一遍编排（还会绕过安全终审与学习记录）。
 * 所以这里只把作答**说清楚**（qid + 作答 + 明确要求调用 submit_quiz），其余交给模型。
 */
export function buildQuizSubmissionMessage(question: { qid: string; stem: string }, answer: string): string {
  const stem = question.stem.replace(/\s+/g, ' ').trim()
  const clipped = stem.length > MAX_STEM_CHARS_IN_SUBMISSION ? `${stem.slice(0, MAX_STEM_CHARS_IN_SUBMISSION)}…` : stem
  return (
    `【练习作答】我做完这道题了，请帮我批改。\n` +
    `题目编号：${question.qid}\n` +
    (clipped.length > 0 ? `题干：${clipped}\n` : '') +
    `我的答案：${answer.trim()}\n` +
    `（请用 submit_quiz 提交批改，判分要以后端结果为准。）`
  )
}

/** 作答是否为空（提交按钮据此禁用；纯前端校验，不含任何判分）。 */
export function isBlankAnswer(answer: string): boolean {
  return answer.trim().length === 0
}

/* ------------------------------------------------------------------ *
 * 小工具（全部返回 null 而不是抛异常）
 * ------------------------------------------------------------------ */

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readQuestionType(value: unknown): QuizQuestionType | null {
  return typeof value === 'string' && (QUIZ_QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuizQuestionType)
    : null
}

function readSource(value: unknown): QuizSource | null {
  return value === 'bank' || value === 'generated' ? value : null
}

function readScoredBy(value: unknown): 'rule' | 'llm' | null {
  return value === 'rule' || value === 'llm' ? value : null
}
