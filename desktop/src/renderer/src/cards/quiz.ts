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
 * 提交消息的**正文部分**（学生可见的那份）。
 *
 * ★ 为什么拆成「正文 + 指令」两段：最后那句 `（请用 submit_quiz 提交批改…）` 是
 *   **写给模型的指令**，不是给学生看的话 —— 它一旦落进学生自己的气泡，
 *   与编程卡片那条求助消息是**同一个缺陷**（把内部指令摆给学生看）。
 *   所以显示文本取正文，wire 文本取正文 + 指令（见 {@link buildQuizSubmissionMessage}
 *   与 {@link quizSubmissionDisplayText}）。
 * ★★ **题目编号（`qid`）也只进 wire、不进学生气泡**（与那句指令同一个道理）：
 *   qid 的真实形状是 `gen-<kp 的 slug>-<随机>-<序号>`（如
 *   `gen-ai-definition-jr-45238405-1`）—— **它里面嵌着一个知识点 slug**。
 *   摆给学生等于把 `ai-definition-jr` 这种内部主键印在他自己的话旁边。
 *   ⚠️ 这不是推测：真机扫描（`npm run ux:student`）在**恢复出来的历史气泡**里
 *   读到了它 —— 实时路径此前也只靠 displayText 挡，而 displayText 当时把它留着。
 *   模型仍需 qid 才能调 `submit_quiz`，所以它的位置是 wire 文本（见 `submissionWireBody`）。
 */
function submissionBody(question: { qid: string; stem: string }, answer: string): string {
  const stem = question.stem.replace(/\s+/g, ' ').trim()
  const clipped = stem.length > MAX_STEM_CHARS_IN_SUBMISSION ? `${stem.slice(0, MAX_STEM_CHARS_IN_SUBMISSION)}…` : stem
  return (
    `【练习作答】我做完这道题了，请帮我批改。\n` +
    (clipped.length > 0 ? `题干：${clipped}\n` : '') +
    `我的答案：${answer.trim()}\n`
  )
}

/** 发给模型的正文：在学生可见正文之外**补上题目编号**（`submit_quiz` 要用它）。 */
function submissionWireBody(question: { qid: string; stem: string }, answer: string): string {
  // 题号插在首行之后 —— 首行是固定标记，回看时靠它认身份（见 `quizUserTextDisplay`）
  return submissionBody(question, answer).replace('\n', `\n题目编号：${question.qid}\n`)
}

/**
 * 学生作答 → **发给主 Agent** 的那条消息（wire 文本）。
 *
 * 为什么走对话而不是加一条 IPC 通道：`submit_quiz` 是**模型的工具**，
 * 判分链是「学生作答 → 主 Agent → submit_quiz → Python 判分」；
 * 加一条「直接提交」的 IPC 等于在主进程里再实现一遍编排（还会绕过安全终审与学习记录）。
 * 所以这里只把作答**说清楚**（qid + 作答 + 明确要求调用 submit_quiz），其余交给模型。
 *
 * ★★★ **最后那句与题目编号都只准进 wire**：学生气泡里显示的是
 *   {@link quizSubmissionDisplayText}（两句必须成对使用，见 `stores/chat.ts` 的 `send`）。
 */
export function buildQuizSubmissionMessage(question: { qid: string; stem: string }, answer: string): string {
  return submissionWireBody(question, answer) + '（请用 submit_quiz 提交批改，判分要以后端结果为准。）'
}

/** 提交作答时**学生气泡里**显示的那一句（= 正文；不含任何写给模型的指令）。 */
export function quizSubmissionDisplayText(question: { qid: string; stem: string }, answer: string): string {
  return submissionBody(question, answer).trimEnd()
}

/** 提交消息的固定开头（回看历史时靠它认出"这是本应用生成的作答"）。 */
export const QUIZ_SUBMISSION_PREFIX = '【练习作答】'
/** 提交消息结尾那句**写给模型的指令**（回看时必须去掉：它是内部指令，不是学生的话）。 */
const SUBMISSION_INSTRUCTION = '（请用 submit_quiz 提交批改，判分要以后端结果为准。）'
/**
 * 提交消息里**题目编号那一行**的形态（回看时整行去掉）。
 *
 * ★ 写成「行首 + 固定字段名」而不是匹配 qid 的形状：qid 的形状是后端定的
 *   （`gen-…` / `<kp>-q1` 都出现过），照形状匹配迟早漏；而字段名是我自己写的，
 *   它变了这行就一起改 —— 判据与实际写入点同一个来源。
 */
const SUBMISSION_QID_LINE = /^\s*题目编号：/

/**
 * ★★ **回看历史**时把提交消息末尾那句内部指令去掉（其余文本原样返回）。
 *
 * 与 `cards/coding.ts` 的 `codingUserTextDisplay` 同一条理由：JSONL 里存的是
 * **发给模型的原文**，学生重启后回看自己的气泡时会读到那句「请用 submit_quiz…」——
 * 实时路径已经把它挡在气泡之外，回看这条路也得挡住，否则同一个"亮底牌"缺陷从后门回来。
 * ★ 只认本应用生成的这一个前缀：认不出一律原样返回（绝不改写学生自己打的字）。
 */
/**
 * ★★ **回看历史**时把提交消息里的「内部成分」去掉（其余文本原样返回）。
 *
 * 要摘掉两样东西：结尾那句写给模型的指令，以及 `题目编号：…` 那一行。
 *   · 指令 —— 与 `cards/coding.ts` 的 `codingUserTextDisplay` 同一条理由：
 *     JSONL 里存的是**发给模型的原文**，学生重启后回看自己的气泡会读到它；
 *   · 题号 —— ⚠️ **这一条是实测补上的**：qid 形如 `gen-ai-definition-jr-…`，
 *     里面嵌着知识点 slug。修掉实时路径之后，**已经是历史的那些消息**仍然带着它
 *     （真机扫描 `npm run ux:student` 在恢复出来的气泡里读到了 `ai-definition-jr`）——
 *     实时路径与回看路径必须同时挡，否则同一个缺陷从后门回来。
 *
 * ★ 只认本应用生成的这一个前缀 + 行首的固定字段名：认不出一律原样返回
 *   （**绝不改写学生自己打的字** —— 他万一真的写了「题目编号：…」，那也是他的话）。
 */
export function quizUserTextDisplay(text: string): string {
  if (!text.trimStart().startsWith(QUIZ_SUBMISSION_PREFIX)) return text
  const withoutInstruction = text.trimEnd().endsWith(SUBMISSION_INSTRUCTION)
    ? text.trimEnd().slice(0, -SUBMISSION_INSTRUCTION.length).trimEnd()
    : text
  // 逐行去掉「题目编号：…」那一行（只认行首的这四个字，且不碰其它行）
  return withoutInstruction
    .split('\n')
    .filter((line) => !SUBMISSION_QID_LINE.test(line))
    .join('\n')
    .trimEnd()
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
