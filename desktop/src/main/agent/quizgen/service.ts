/**
 * 练习页「动态出题」的**主进程生成服务**（计划 §4.2）。
 *
 * 一次调用 = 一条流水：读现状 → 组装个性化 Prompt → 模型补全 → 校验（复用
 * `prepareVariants`）→ 登记（复用 `registerVariants`）→ 返回**投影后**的载荷。
 * 它不具备对话能力、不注册 Pi Tool、不进 6 事件词表 —— 练习页刻意不开对话
 * （刷题不该每答一题消耗一次云端调用），所以这里是一条常驻服务而不是子 agent。
 *
 * ★★ 四条铁律（改动前先读）：
 *
 * 1. **先登记、后下发**：登记失败的那一批**绝不**发给渲染层 —— 后端判不了分的题
 *    发出去，学生做完提交必 404。降级路径是「这一批不出」，不是「出无答案的题」。
 * 2. **全部失败不退回题库**：这是与 Extension 里 `generate` 的**唯一口径差异**。
 *    那边退回题库是对的（题库题还没做过）；这边退回没有意义 —— 学生刚刚做完的
 *    就是题库题，再发一遍同一批只会让他困惑。所以失败就是失败（可读中文）。
 * 3. **出网只有两个口**：sidecar 走 `bridge/client.ts` 的 `apiFetch`，模型走注入的
 *    `complete`（runtime 填的就是 Pi 模型通道）。本文件**不出现第三处** `fetch(`。
 * 4. **身份与学段由调用方注入**：`studentId` / `gradeLevel` 只从请求参数来
 *    （IPC 处理器从主进程解析后传进来），本服务不读全局、不猜。
 *
 * ★ 依赖全部可注入（`complete` / `prepare` / `register` / `readBank` / `readExisting`）：
 *   单测在没有模型、没有 sidecar 的情况下能覆盖成功 / 无 Key / 登记失败 / 重试上限 /
 *   配额复核全部分支。
 */
import type { DecisionTrace } from '../../../shared/quiz-generate.ts'
import {
  DEFAULT_GENERATION_RETRIES,
  MAX_QUIZ_QUESTIONS,
  QUIZ_TIMEOUT_MS,
  SUBJECTIVE_GRADING_FAILED_TEXT,
  SUBJECTIVE_UNAVAILABLE_TEXT,
  buildSubjectiveGradingPrompt,
  parseSubjectiveScore,
  parseVariantPayload,
  postSubjectiveGrade,
  prepareVariants,
  registerVariants,
  type QuizPayloadShape,
  type QuizResultShape
} from '../extensions/quiz.ts'
import { buildPersonalizedQuizPrompt } from './prompt.ts'
import { rememberRubrics } from './rubric-cache.ts'

/**
 * 自动阶段的**内置 + 生成题总数上限**（需求钉死的 20）。
 * ★ 只在这里定义一次（渲染层的同一个数走 stores/quiz.ts 的 `autoPhaseLimit`，
 *   两个进程各有各的一份常量，别在服务里散落字面量 20）。
 */
export const AUTO_PHASE_LIMIT = 20
/** 「还想再练练」每批题数（= 契约单批上限 10，不受 20 上限约束）。 */
export const MORE_BATCH = 10

/**
 * 下发载荷（= 投影后的出题载荷，结构上**没有** `answer` / `explanation`）。
 * 与 IPC / 渲染层共享的 `QuizPayloadView` 是同一个结构，两边可直接互赋。
 */
export type QuizPayloadView = QuizPayloadShape

/**
 * 判分结论（渲染层管它叫 `QuizResultView`；主进程侧的权威类型是 `QuizResultShape`，
 * 两者结构相同，经 IPC 直接互赋 —— 与上面 QuizPayloadView 同一取法）。
 */
export type QuizResultView = QuizResultShape

/** 一次生成的结果。`ok: true` + 无 payload = 「配额已满，本来就不该出」（不是失败）。 */
export interface QuizGenResult {
  ok: boolean
  payload?: QuizPayloadView
  /** 降级（无可用模型）：渲染层据此显示一句可读说明，不摆错误卡。 */
  degraded?: boolean
  /** 降级说明（学生面可读中文，由渲染层决定显不显示）。 */
  note?: string
  /** 失败说明（可读中文；auto 路径渲染层静默吞掉，more 路径行内提示）。 */
  message?: string
}

/** 一次出题请求（`studentId` / `gradeLevel` 由主进程注入，不来自渲染层）。 */
export interface QuizGenRunRequest {
  kpId: string
  context: DecisionTrace[]
  studentId: string
  gradeLevel: string
}

/** 可注入依赖（生产用默认实现；单测注入假实现覆盖各分支）。 */
export interface QuizGenDeps {
  /** 模型文本补全（runtime 填 Pi 模型通道；**无 Key 时为 null**）。 */
  complete?: (prompt: string) => Promise<string> | null
  register?: typeof registerVariants
  prepare?: typeof prepareVariants
  /** 该知识点的内置题数量（默认打 sidecar 题库端点）。 */
  readBank?: (kpId: string) => Promise<number>
  /** 该知识点已有的题干清单（默认打 sidecar：内置题 + 该生生成题）。 */
  readExisting?: (kpId: string) => Promise<string[]>
}

export interface QuizGenService {
  /** 换模型通道：传函数=挂上，传 null=摘掉（热切换 Key 时立刻降级）。 */
  setCompleter(completer: ((prompt: string) => Promise<string>) | null): void
  generateAuto(request: QuizGenRunRequest): Promise<QuizGenResult>
  generateMore(request: QuizGenRunRequest): Promise<QuizGenResult>
}

/** 无可用模型时的可读说明（不是 error：这条补充路径本轮不可用而已）。 */
const NO_MODEL_NOTE = '现在没法出新题（还没有可用的模型），可以先聊一聊或换一关。'
/** 生成失败（重试到上限）时的可读说明。 */
const GENERATION_FAILED_MESSAGE = '这次没出成，再试一次。'
/** 读现状的一次 sidecar 请求超时（本机回环，正常是毫秒级）。 */
const READ_TIMEOUT_MS = QUIZ_TIMEOUT_MS
/** 读已有生成题的条数上限（后端 limit 上限 200；这里只要题干清单，60 够用）。 */
const GENERATED_LOOKUP_LIMIT = 60
/** 探内置题数量时向题库端点要几道（端点的 count 上限就是契约单批上限）。 */
const BANK_PROBE_COUNT = MAX_QUIZ_QUESTIONS

/* ------------------------------------------------------------------ *
 * sidecar 读取（默认实现）
 *
 * ★ 调用点**动态 import** `bridge/client.ts` 与 `wire/data.ts`（与 extensions/quiz.ts
 *   的登记出口同因）：那两个模块的静态依赖图带着 @shared 别名与打包器才认的写法，
 *   动态 import 让本文件在 `node --test` 下只加载纯逻辑时不会被它们绊住。
 * ★ 这里只读、不做任何判定：题量与题干由 Python 说了算（数据域只在 Python）。
 * ------------------------------------------------------------------ */

/** 从出题载荷里读题干清单（白名单：只认 questions[].stem 这个字符串）。 */
function readQuestionStems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { questions?: unknown }).questions
  if (!Array.isArray(list)) return []
  const stems: string[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const stem = (item as { stem?: unknown }).stem
    if (typeof stem === 'string' && stem.trim() !== '') stems.push(stem.trim())
  }
  return stems
}

/** 打一次 sidecar 取题干（失败一律当空 —— 读现状失败不该把整条出题链判死）。 */
async function fetchStems(
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  path: string
): Promise<string[]> {
  try {
    const response = await apiFetch(path, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
    if (!response.ok) return []
    return readQuestionStems(await response.json())
  } catch {
    return []
  }
}

/** 默认：该知识点的内置题数量（题库 404 = 这一关没有内置题，按 0 算）。 */
async function defaultReadBank(kpId: string, gradeLevel: string): Promise<number> {
  try {
    const [{ apiFetch }, { quizBankPath }] = await Promise.all([
      import('../../bridge/client.ts'),
      import('../../wire/data.ts')
    ])
    return (await fetchStems(apiFetch, quizBankPath(kpId, gradeLevel, BANK_PROBE_COUNT))).length
  } catch {
    return 0
  }
}

/**
 * 默认：该知识点已有的题干（**内置题 + 该生此前生成的题**）。
 * ★ 内置题干也要进去重清单：学生刚做完的就是那一批，模型最容易原样重出。
 */
async function defaultReadExisting(
  kpId: string,
  studentId: string,
  gradeLevel: string
): Promise<string[]> {
  try {
    const [{ apiFetch }, { quizBankPath, quizGeneratedPath }] = await Promise.all([
      import('../../bridge/client.ts'),
      import('../../wire/data.ts')
    ])
    const [bank, generated] = await Promise.all([
      fetchStems(apiFetch, quizBankPath(kpId, gradeLevel, BANK_PROBE_COUNT)),
      fetchStems(apiFetch, quizGeneratedPath(studentId, { kpId, limit: GENERATED_LOOKUP_LIMIT }))
    ])
    return [...generated, ...bank]
  } catch {
    return []
  }
}

/** 总体定档用的汇总（只数「判过分的题」，没判分的不算素材）。 */
function summarize(traces: DecisionTrace[]): {
  graded: number
  correct: number
  firstTryCorrect: number
  multiTry: number
} {
  let graded = 0
  let correct = 0
  let firstTryCorrect = 0
  let multiTry = 0
  for (const trace of traces) {
    const judged = trace.tries.filter((tried) => tried.correct !== null)
    if (judged.length === 0) continue
    graded += 1
    // 「答对数」按**最终有没有做对**（含重试后做对）—— 它定的是难度档，不是掌握度口径
    if (judged.some((tried) => tried.correct === true)) correct += 1
    if (trace.firstTryCorrect === true) firstTryCorrect += 1
    if (judged.length >= 2) multiTry += 1
  }
  return { graded, correct, firstTryCorrect, multiTry }
}

/**
 * 判分路径专用的补全器（模块级）。
 *
 * ★ 为什么另留一个模块级变量：`gradeSubjective` 是**模块级函数**（IPC 处理器直接调），
 *   而补全器是服务实例的私有状态。生产接线只有一条 —— runtime 对**单例**调
 *   `setCompleter` —— 所以 `setCompleter` 顺手镜像到这里，判分与出题共用同一个模型通道。
 * ★ 注入 `deps.complete` 的实例**不**改这里：单测的假补全器不该泄漏到别的实例。
 */
let gradingCompleter: ((prompt: string) => Promise<string> | null) | null = null

export function createQuizGenService(deps: QuizGenDeps = {}): QuizGenService {
  const prepare = deps.prepare ?? prepareVariants
  const register = deps.register ?? registerVariants
  let complete: ((prompt: string) => Promise<string> | null) | null = deps.complete ?? null

  /**
   * 出一批（≤ MAX_QUIZ_QUESTIONS）：补全 → 校验 → 登记，失败重试到上限。
   *
   * ★ 重试是**重掷**而不是纠错：冻结接口的 Prompt 输入里没有「上一次哪里不合格」，
   *   所以每次给的 Prompt 相同（模型输出随机，重掷仍有意义）。
   * ★ 返回 null 的三种情况都**不下发**：没有补全器 / 输出解析不出 / 登记失败。
   */
  async function generateBatch(input: {
    kpId: string
    gradeLevel: string
    count: number
    summary: { graded: number; correct: number; firstTryCorrect: number; multiTry: number }
    traces: DecisionTrace[]
    existingStems: string[]
    studentId: string
  }): Promise<QuizPayloadView | null> {
    const completer = complete
    if (completer === null) return null
    const prompt = buildPersonalizedQuizPrompt({
      gradeLevel: input.gradeLevel,
      kpId: input.kpId,
      count: input.count,
      summary: input.summary,
      traces: input.traces,
      existingStems: input.existingStems
    })
    for (let attempt = 0; attempt <= DEFAULT_GENERATION_RETRIES; attempt += 1) {
      let raw: string | null = null
      try {
        raw = await completer(prompt)
      } catch {
        // 模型通道抛（例如 Key 刚被热清空）：这一轮没出成，进入下一次尝试
        raw = null
      }
      if (raw === null || raw.trim() === '') continue
      const prepared = prepare(parseVariantPayload(raw), {
        kpId: input.kpId,
        gradeLevel: input.gradeLevel,
        maxQuestions: input.count
      })
      if (!prepared.ok) continue
      try {
        const registered = await register({
          studentId: input.studentId,
          gradeLevel: input.gradeLevel,
          questions: prepared.questions
        })
        // ★ 先登记、后下发：只有登记成功（拿到投影后的载荷）这一批才允许返回
        if (registered !== null) {
          // 登记成功才记细则：判分遇 409 时要靠它走模型判分（见 rubric-cache.ts 文件头）。
          // 登记失败的那一批不下发，也就不存在「学生做这道题」，不该留缓存。
          rememberRubrics(input.studentId, prepared.questions)
          return registered
        }
      } catch {
        // 登记超时 / sidecar 不可用：这一批不下发
      }
    }
    return null
  }

  async function run(request: QuizGenRunRequest, mode: 'auto' | 'more'): Promise<QuizGenResult> {
    const readBank = deps.readBank ?? ((kp: string) => defaultReadBank(kp, request.gradeLevel))
    const readExisting =
      deps.readExisting ?? ((kp: string) => defaultReadExisting(kp, request.studentId, request.gradeLevel))

    const bankCount = await readBank(request.kpId)
    const existingStems = await readExisting(request.kpId)
    // 现状 = max(内置题数, 已有题干条数)：默认实现里已有题干**含**内置题干（两者等价）；
    // 注入的假实现若只回生成题，bankCount 兜住内置那部分，不会少算。
    const existingTotal = Math.max(bankCount, existingStems.length)

    const target =
      mode === 'more'
        ? Math.min(MORE_BATCH, MAX_QUIZ_QUESTIONS)
        : Math.max(0, AUTO_PHASE_LIMIT - existingTotal)
    // 配额已满：空成功（不是失败，也没什么可提示的）
    if (target <= 0) return { ok: true }

    if (complete === null) return { ok: true, degraded: true, note: NO_MODEL_NOTE }

    const summary = summarize(request.context)
    const batches: QuizPayloadView[] = []
    let remaining = target
    // 单批 ≤ 10（契约上限），配额 17 时拆成 10 + 7（计划 §4.3）；批间失败即停，
    // 已成功的批次照常下发 —— 部分成功优于全无。guard 只防实现出错转圈。
    for (let guard = 0; guard < 3 && remaining > 0; guard += 1) {
      const count = Math.min(MAX_QUIZ_QUESTIONS, remaining)
      const batch = await generateBatch({
        kpId: request.kpId,
        gradeLevel: request.gradeLevel,
        count,
        summary,
        traces: request.context,
        existingStems,
        studentId: request.studentId
      })
      if (batch === null || batch.questions.length === 0) break
      batches.push(batch)
      // 按**请求量**递减（不是按回包条数）：下一批要几道由「还差几道」决定，
      // 模型少回一道不该让后面多要一道
      remaining -= count
    }

    const questions = batches.flatMap((batch) => batch.questions)
    if (questions.length === 0) return { ok: false, message: GENERATION_FAILED_MESSAGE }
    return {
      ok: true,
      payload: { kpId: batches[0]?.kpId ?? request.kpId, source: 'generated', questions }
    }
  }

  return {
    setCompleter(next) {
      complete = next
      // 判分路径（模块级的 gradeSubjective）跟着同一条模型通道走
      gradingCompleter = next
    },
    generateAuto: (request) => run(request, 'auto'),
    generateMore: (request) => run(request, 'more')
  }
}

/**
 * ★ 进程内**唯一**的出题服务实例。
 *
 * 为什么必须是模块级单例：模型通道由 runtime 填（`setCompleter`），生成由 IPC 处理器发起
 * （`generateAuto` / `generateMore`）—— 两边各 create 一个实例的话，模型通道永远接不到
 * 处理器那个实例，生成会一直停在「无可用模型」的降级分支上。
 * 依赖留空：模型通道后填，sidecar 读取走默认实现。
 */
export const quizGenService = createQuizGenService({})

/**
 * 主观题判分（练习页）：规则判分端点回 409 之后走这里 —— 模型判分 → 结论落库 → 返回结论。
 *
 * ★★ 复用 `extensions/quiz.ts` 已有的三件（**不重写**）：`buildSubjectiveGradingPrompt`
 *    （Prompt）/ `parseSubjectiveScore`（严格解析）/ `postSubjectiveGrade`（落库出口）——
 *    与对话里那条主观题判分路径是**同一个实现**，差别只在 rubric 的来源
 *    （那边是会话内缓存；这边是登记时落盘的缓存，见 rubric-cache.ts 的文件头）。
 * ★ 失败一律**抛可读中文**：无补全器 → SUBJECTIVE_UNAVAILABLE_TEXT；解析不出 →
 *    SUBJECTIVE_GRADING_FAILED_TEXT；落库失败 → 一句「本地服务未就绪」。处理器原样把
 *    它翻成 `{ ok:false, message }`，绝不把异常穿过 IPC。
 * ★ `sessionId` 给空串：练习页没有对话会话，而后端该字段可空
 *    （`routes/quiz.py` 的 `session_id = body.session_id or ""`）。
 */
export async function gradeSubjective(input: {
  studentId: string
  gradeLevel: string
  qid: string
  answer: string
  stem: string
  rubric: string
}): Promise<QuizResultView> {
  const completer = gradingCompleter
  if (completer === null) throw new Error(SUBJECTIVE_UNAVAILABLE_TEXT)
  let judged: { score: number; feedback: string } | null = null
  try {
    const text = await completer(
      buildSubjectiveGradingPrompt({
        gradeLevel: input.gradeLevel,
        stem: input.stem,
        rubric: input.rubric,
        answer: input.answer
      })
    )
    judged = text === null ? null : parseSubjectiveScore(text)
  } catch {
    // 模型没响应 / 超时：当作「这次没判出来」，不把底层异常抛给学生
    judged = null
  }
  if (judged === null) throw new Error(SUBJECTIVE_GRADING_FAILED_TEXT)
  const result = await postSubjectiveGrade({
    studentId: input.studentId,
    qid: input.qid,
    score: judged.score,
    feedback: judged.feedback,
    sessionId: ''
  })
  if (result === null) {
    throw new Error('主观题判分结果没能写进学习记录（本地服务未就绪）。请稍后再试一次。')
  }
  return result
}

