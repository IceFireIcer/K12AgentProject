/**
 * 学段 Extension（票 21）—— **学段由系统推断并自动生效，没有人工选择**。
 *
 * 设计（旧设计「学生手选 + 推断只给建议」已废止）：
 *
 * ```text
 * 每轮 input ──▶ 上交本轮证据 ──▶ Python：signals.py 提取四类信号（不调 LLM）
 *                                    └─▶ rules.py 规则引擎（最终决策者）
 *                                          └─▶ 必要时原子改 learning.db 的 student.grade_level
 *   下一轮 before_agent_start ──▶ 用**新学段**的模板拼 system prompt（学生无感）
 * ```
 *
 * ★ 五条纪律（都不是实现细节）：
 *
 * 1. **提取只有一份实现**：本文件**不做**任何规则/词表匹配，只上交「本轮证据」
 *    （`{turn, text, sessionId}` + 可选的第二层提议）。判据全在 `server/app/grade/signals.py`，
 *    两份实现必然漂移，而漂移的表现是「学段莫名乱动」。
 * 2. **决策在服务端**：本文件只认服务端回的 `grade`，不自己算阈值、不自己判方向。
 * 3. **下一轮生效**：服务端在第 N 轮判定出的学段在**第 N+1 轮**的 `before_agent_start` 生效
 *    （`pendingGrade` → `appliedGrade` 的交接发生在下一次 `input`）。学生看不到「切换」事件，
 *    这正是执行文档 §10.4 要求的「无感」。
 * 4. **绝不阻塞对话**：`input` 里的上交是 fire-and-forget（判定的产物下一轮才用），
 *    失败只记日志；`before_agent_start` 是**同步**的，绝不 await 网络。
 * 5. **链式保真**：`before_agent_start` 的返回值会被 Pi **链式叠加**（后注册者看到前者结果）。
 *    别的扩展（`runtime.ts` 的 chatFactory 等）已经把学段 prompt 拼好了，本扩展
 *    **只在学段确实变化时**替换其中的模板片段，并在末尾追加覆盖块作为兜底 ——
 *    绝不整段丢弃别人的内容（那会把「抹掉宿主路径泄漏」的那道覆盖一起冲掉）。
 *
 * ★ 第二层（一次轻量 LLM 判定）走**可注入的 judge**：Pi 的 `ExtensionAPI` 面上没有
 *   completion 能力（只有 `ctx.model` / `ctx.modelRegistry`），所以接线要由 `runtime.ts`
 *   完成（`gradeExtension.useJudge(fn)`）。**没有接线 = 没有 API Key** 时，本扩展
 *   **跳过**第二层并把它显式标出来（日志 + `snapshot().layer2`，服务端回 `degraded="no_llm"`）——
 *   第一层照常工作、照常能改学段，降级绝不静默。
 */

import type { GradeLevel } from '@shared/ipc-events'
import {
  DEFAULT_GRADE_LEVEL,
  GRADE_LEVELS,
  GRADE_PROMPTS,
  gradePromptFor,
  normalizeGradeLevel
} from '../prompts/grade.ts'
import { currentAgentSession, type AgentExtensionApi } from './index.ts'

/* ------------------------------------------------------------------ *
 * 常量（与 server/app/grade/rules.py 的同名常量一一对应）
 * ------------------------------------------------------------------ */

/** 第二层 LLM 判定的触发轮次（`rules.py` 的 `LAYER2_FIRST_TURN`）。 */
export const LAYER2_FIRST_TURN = 3

/** 第 3 轮证据不足时的重试轮次（`rules.py` 的 `LAYER2_RETRY_TURN`）。 */
export const LAYER2_RETRY_TURN = 5

/** 第二层判定至少要有几轮可用证据（不足则等到 `LAYER2_RETRY_TURN`）。 */
export const LAYER2_MIN_TURNS = 3

/** 最近多少轮进第二层判定的上下文（Prompt 预算；判学段不需要整段对话史）。 */
export const LAYER2_WINDOW_TURNS = 8

/** 单轮文本的长度上限（与 `routes/grade.py` 的 `MAX_TURN_CHARS` 对齐；超长截断而不是 422）。 */
export const MAX_TURN_CHARS = 2000

/** 单个学生的端点（**经 `bridge/client.ts` 转发**，渲染进程永远不直连 sidecar）。 */
export const gradeStatePath = (studentId: string): string =>
  `/api/grade/state/${encodeURIComponent(studentId)}`
export const gradeTurnsPath = (studentId: string): string =>
  `/api/grade/turns/${encodeURIComponent(studentId)}`

/**
 * 追加式覆盖块的标题（**只在认不出别的扩展拼的是哪份模板时**才用）。
 * 用中文写，是为了让模型一眼看出这一段是权威的学段指令。
 */
export const GRADE_OVERRIDE_HEADING = '## 学段（系统自动推断，以此段为准）'

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 第二层 LLM 的提议（**只是提议**：服务端可能采纳、无视或否决）。 */
export interface GradeProposal {
  suggestedGrade: GradeLevel
  confidence: number
  note?: string
}

/** 一轮可上交的证据（**不含**任何服务端算好的信号）。 */
export interface TurnEvidence {
  turn: number
  text: string
  sessionId?: string
  proposal?: GradeProposal
}

/** `POST /api/grade/turns/{studentId}` 的出参（只声明本扩展用得到的字段）。 */
export interface GradeTurnResponse {
  grade: GradeLevel
  previousGrade: GradeLevel
  changed: boolean
  reason: string
  confidence: number
  turn: number
  direction: number
  streak: number
  cooldownRemainingTurns: number
  /** 第二层被跳过时可见（`no_llm`）；正常为 `null`。 */
  degraded?: string | null
}

/** `GET /api/grade/state/{studentId}` 的出参。 */
export interface GradeStateSnapshot {
  grade: GradeLevel
  source: string
  lastTurn: number
  lastChangeTurn?: number | null
  cooldownRemainingTurns: number
  streak: number
  direction: number
  confidence: number
  suggestedLevel?: GradeLevel | null
}

/** 上交出口（默认走 `apiFetch`；测试注入假实现）。 */
export type TurnSubmitter = (
  studentId: string,
  body: { turns: TurnEvidence[] }
) => Promise<GradeTurnResponse>

/** 当前学段读取出口（默认走 `apiFetch`）。 */
export type GradeStateFetcher = (studentId: string) => Promise<GradeStateSnapshot>

/** 第二层判定通道：给一段对话上下文，返回一个提议（`null` = 这条通道不可用）。 */
export type Layer2Judge = (input: {
  turns: Array<{ turn: number; text: string }>
  currentGrade: GradeLevel
}) => Promise<GradeProposal | null>

export type Layer2Status =
  | 'not_due'
  | 'no_llm'
  | 'judge_error'
  | 'due'
  | 'retry'
  | 'insufficient_evidence'
  | 'already_proposed'
  | 'used'

export interface GradeExtensionStats {
  /** 本会话已观察到的轮数（`input` 事件计数）。 */
  turn: number
  /** 本轮生效的学段（`before_agent_start` 用的就是它）。 */
  appliedGrade: GradeLevel
  /** 服务端判定出、下一轮生效的学段（`null` = 与 `appliedGrade` 相同）。 */
  pendingGrade: GradeLevel | null
  /** 第二层最近一次的状态（`used` = 真的用上了 LLM 提议）。 */
  layer2: Layer2Status
  /** 成功上交的轮数 / 失败次数（失败只影响下一轮生效的时机，不影响本轮对话）。 */
  submitted: number
  failed: number
  /** 最近一次服务端判定的结论（可读中文，进日志与验收记录）。 */
  lastReason: string
  lastChangedAtTurn: number | null
  lastError?: string
}

export interface GradeExtensionOptions {
  submitter?: TurnSubmitter
  fetcher?: GradeStateFetcher
  judge?: Layer2Judge | null
  /** 学生身份来源（默认 `currentAgentSession`；测试可注入）。 */
  sessionProvider?: () => { studentId: string; sessionId: string; gradeLevel: GradeLevel } | null
  log?: (line: string, level?: 'info' | 'warn') => void
}

/** `grade` 扩展 = 工厂 + 诊断/接线入口（**诊断不进 LLM 上下文**）。 */
export interface GradeExtension {
  (pi: AgentExtensionApi): void
  /** 接线第二层判定通道（`runtime.ts` 建会话后调用；不接线 = 干净降级）。 */
  useJudge(judge: Layer2Judge | null): void
  snapshot(): GradeExtensionStats
  /** 清空会话状态（换学生时用；**不会**删除已落库的数据）。 */
  reset(): void
  /** 等排队的上交全部走完（切换学生 / 退出前调用，别把最后一轮的证据丢了）。 */
  flush(): Promise<void>
  /** 主动拉一次当前学段（建议 `runtime.ts` 在绑会话后调用，省掉冷启动那一轮的滞后）。 */
  refresh(): Promise<GradeLevel | null>
}

/* ------------------------------------------------------------------ *
 * 纯函数（可单测）
 * ------------------------------------------------------------------ */

/** 从 `input` 事件里取学生输入（只认 `text`，别把别的字段当正文）。 */
export function readInputText(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  const record = event as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  return ''
}

/**
 * 这一条 input 是否算「学生说的一句话」。
 *
 * `source === "extension"` 的内容是别的扩展注入的（不是学生打的字），
 * 用它去推学段会自我循环 —— 直接跳过。
 */
export function isStudentTurn(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  const source = (event as Record<string, unknown>).source
  return source === undefined || source === 'interactive' || source === 'rpc'
}

/** 截断到上限（服务端也会再挡一道；这里先截，免得白传）。 */
export function clampTurnText(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_TURN_CHARS ? trimmed.slice(0, MAX_TURN_CHARS) : trimmed
}

/** 有几轮「可用的证据」（非空文本）——第二层判定够不够料看它。 */
export function countUsableTurns(turns: Array<{ text: string }>): number {
  return turns.filter((turn) => turn.text.trim().length > 0).length
}

/**
 * ★ 第二层何时触发（执行文档 §10.3：「第 3 轮触发，不足则第 5 轮」）。
 *
 * 返回 `run=true` 时调用方才去跑一次轻量 LLM 判定。**没有判定通道时返回 `no_llm`**
 * （不是静默跳过：调用方据此打日志、服务端据此回 `degraded`）。
 */
export function shouldRequestLayer2(input: {
  turn: number
  usableTurns: number
  windowHasProposal: boolean
  judgeAvailable: boolean
}): { run: boolean; status: Layer2Status } {
  if (!input.judgeAvailable) return { run: false, status: 'no_llm' }
  if (input.windowHasProposal) return { run: false, status: 'already_proposed' }
  if (input.turn < LAYER2_FIRST_TURN) return { run: false, status: 'not_due' }
  if (input.usableTurns >= LAYER2_MIN_TURNS) return { run: true, status: 'due' }
  if (input.turn >= LAYER2_RETRY_TURN) return { run: true, status: 'retry' }
  return { run: false, status: 'insufficient_evidence' }
}

/**
 * 第二层的判定 Prompt（**只给最近的几轮学生提问 + 当前学段**）。
 *
 * 本扩展自己拼这一段，不经 `prompts/` 的四份学段模板 —— 它是一次**内部**判定调用，
 * 不是给学生的回答。**不含**宿主路径、工具名、内部字段名。
 */
export function buildJudgePrompt(
  turns: Array<{ turn: number; text: string }>,
  currentGrade: GradeLevel
): string {
  const recent = turns.slice(-LAYER2_WINDOW_TURNS)
  const lines = recent.map((turn) => `${turn.turn}. ${turn.text}`)
  return [
    '你是 K12 人工智能通识课的分级助手。下面是一名学生最近的提问（按时间先后）。',
    `系统当前按「${currentGrade}」跟他对话。`,
    '请判断他更像哪个学段的学生，只依据提问用词与问题深度，不要猜测他的身份。',
    '四个取值：primary_low（小学低年级）/ primary_high（小学高年级）/ junior（初中）/ senior（高中）。',
    '',
    ...lines,
    '',
    '只输出一行 JSON，不要解释、不要代码块：',
    '{"suggestedGrade": "primary_low|primary_high|junior|senior", "confidence": 0.0, "note": "一句话理由"}',
    'confidence 是 0 到 1 的小数（0.6 以上表示你比较有把握）。'
  ].join('\n')
}

/**
 * 解析第二层返回的提议（**宽松读、严格校验**）。
 *
 * 模型可能包 ```json 代码块、可能多嘴几句，所以先剥壳再取第一个 JSON 对象；
 * 但取值必须合法（四学段之一 + confidence 数值），否则返回 `null`（当作没有提议）——
 * **脏值绝不放行**：它会被服务端当成一次真实判定。
 */
export function parseProposal(raw: string): GradeProposal | null {
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
  const grade = record.suggestedGrade ?? record.suggested_grade ?? record.grade
  if (typeof grade !== 'string' || !(GRADE_LEVELS as readonly string[]).includes(grade)) return null
  const confidenceRaw = record.confidence
  const confidence = typeof confidenceRaw === 'number' ? confidenceRaw : Number(confidenceRaw)
  if (!Number.isFinite(confidence)) return null
  return {
    suggestedGrade: grade as GradeLevel,
    confidence: Math.max(0, Math.min(1, confidence)),
    note: typeof record.note === 'string' ? record.note.slice(0, 200) : undefined
  }
}

/**
 * ★ 把 `incoming` 里**已知的**学段模板片段替换成目标模板（链式保真的关键）。
 *
 * 为什么按「整份模板做子串替换」而不是按标题找段落：四份模板是**整段文本**
 * （`prompts/grade.ts` 的 `GRADE_PROMPTS`），拼在别处也可能被包一层 —— 子串替换能保留
 * 别的扩展追加的前后缀内容。找不到任何已知模板时返回 `null`（由调用方兜底）。
 */
export function swapKnownGradeTemplate(incoming: string, target: string): string | null {
  for (const grade of GRADE_LEVELS) {
    const template = GRADE_PROMPTS[grade]
    if (!template || template === target) continue
    const at = incoming.indexOf(template)
    if (at >= 0) return incoming.slice(0, at) + target + incoming.slice(at + template.length)
  }
  return null
}

/**
 * `before_agent_start` 的 prompt 组装（**纯函数**，链式语义全在这里）。
 *
 * 三种情形：
 *   - 别的扩展**没给** prompt（`undefined`/空）→ 返回推断学段的模板
 *     （★ 绝不能返回 `undefined`：那等于放弃覆盖，Pi 的默认 prompt 会把宿主安装路径发出去）；
 *   - 已经是目标模板 → 返回 `undefined`（**不动链条**，谁也别改谁）；
 *   - 是别的学段的模板 → 原地替换模板片段，保留其余内容；
 *     认不出来（别的扩展拼了自定义 prompt）→ 原样保留 + 追加一段权威覆盖块。
 */
export function mergeGradePrompt(params: {
  incoming: string | undefined
  inferredGrade: GradeLevel
}): string | undefined {
  const target = gradePromptFor(params.inferredGrade)
  const incoming = params.incoming
  if (typeof incoming !== 'string' || incoming.trim() === '') return target
  if (incoming === target) return undefined
  if (incoming.includes(target)) return undefined
  const swapped = swapKnownGradeTemplate(incoming, target)
  if (swapped !== null) return swapped
  return `${incoming}\n\n${GRADE_OVERRIDE_HEADING}\n${target}`
}

/* ------------------------------------------------------------------ *
 * 唯一出口：bridge/client.ts（token 注入与「渲染进程不直连 sidecar」都靠它）
 * ------------------------------------------------------------------ */

/** 上交一批轮次证据。⚠️ 调用点动态 import 的理由见 `learning-log.ts` 的同名注释。 */
export async function postGradeTurns(
  studentId: string,
  body: { turns: TurnEvidence[] }
): Promise<GradeTurnResponse> {
  const { apiFetch } = await import('../../bridge/client.ts')
  const response = await apiFetch(gradeTurnsPath(studentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`学段判定请求失败：HTTP ${response.status}${await readSnippet(response)}`)
  }
  return (await response.json()) as GradeTurnResponse
}

/** 读当前学段（冷启动/刷新用）。 */
export async function fetchGradeState(studentId: string): Promise<GradeStateSnapshot> {
  const { apiFetch } = await import('../../bridge/client.ts')
  const response = await apiFetch(gradeStatePath(studentId), { method: 'GET' })
  if (!response.ok) {
    throw new Error(`读取当前学段失败：HTTP ${response.status}${await readSnippet(response)}`)
  }
  return (await response.json()) as GradeStateSnapshot
}

async function readSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text ? `（${text.slice(0, 120)}）` : ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * 扩展本体
 * ------------------------------------------------------------------ */

export function createGradeExtension(options: GradeExtensionOptions = {}): GradeExtension {
  const submitter = options.submitter ?? postGradeTurns
  const fetcher = options.fetcher ?? fetchGradeState
  const log = options.log ?? ((line, level) => (level === 'warn' ? console.warn(line) : console.info(line)))
  const sessionProvider = options.sessionProvider ?? currentAgentSession

  let judge: Layer2Judge | null = options.judge ?? null

  /** 本轮生效的学段（`before_agent_start` 用）。 */
  let appliedGrade: GradeLevel = DEFAULT_GRADE_LEVEL
  /** 服务端已判定、**下一轮**生效的学段。 */
  let pendingGrade: GradeLevel | null = null

  let turn = 0
  let currentSessionId = ''
  let currentStudentId = ''
  let buffer: Array<{ turn: number; text: string }> = []
  let windowHasProposal = false
  let layer2: Layer2Status = 'not_due'
  let submitted = 0
  let failed = 0
  let lastReason = ''
  let lastChangedAtTurn: number | null = null
  let lastError: string | undefined
  let warnedNoJudge = false
  /** 会话内的串行化：每一轮的上交排队执行，避免同一进程里并发写库。 */
  let queue: Promise<void> = Promise.resolve()

  const snapshot = (): GradeExtensionStats => ({
    turn,
    appliedGrade,
    pendingGrade,
    layer2,
    submitted,
    failed,
    lastReason,
    lastChangedAtTurn,
    lastError
  })

  const reset = (): void => {
    appliedGrade = DEFAULT_GRADE_LEVEL
    pendingGrade = null
    turn = 0
    currentSessionId = ''
    currentStudentId = ''
    buffer = []
    windowHasProposal = false
    layer2 = 'not_due'
    submitted = 0
    failed = 0
    lastReason = ''
    lastChangedAtTurn = null
    lastError = undefined
    queue = Promise.resolve()
  }

  /** 把「上一轮判定出的学段」交接给本轮（这就是「下一轮生效」的落点）。 */
  const applyPending = (): void => {
    if (pendingGrade && pendingGrade !== appliedGrade) {
      log(`[grade] 本轮按推断出的新学段作答：${appliedGrade} → ${pendingGrade}（学生无感）`)
      appliedGrade = pendingGrade
    }
    pendingGrade = null
  }

  /** 换会话（同一学生的 `/new`、分支）：轮次与第二层窗口重来，**学段沿用**。 */
  const resetWindow = (): void => {
    buffer = []
    windowHasProposal = false
    turn = 0
    layer2 = 'not_due'
  }

  /** 换学生：**连学段一起重置**（绝不把上一个学生的学段带到下一个学生头上）。 */
  const resetForStudent = (): void => {
    resetWindow()
    appliedGrade = DEFAULT_GRADE_LEVEL
    pendingGrade = null
  }

  /** 跟踪会话/学生边界（每轮开始调用；返回本轮的学生身份是否已切换）。 */
  const trackBoundary = (session: { studentId: string; sessionId: string } | null): void => {
    if (!session) return
    if (session.studentId !== currentStudentId) {
      if (currentStudentId) {
        log(`[grade] 切换学生：${currentStudentId} → ${session.studentId}，学段回到冷启动默认值并重新推断`)
        resetForStudent()
      }
      currentStudentId = session.studentId
      currentSessionId = session.sessionId
      return
    }
    if (session.sessionId && session.sessionId !== currentSessionId) {
      resetWindow()
      currentSessionId = session.sessionId
    }
  }

  const runJudge = async (): Promise<GradeProposal | null> => {
    if (!judge) return null
    try {
      return await judge({ turns: [...buffer], currentGrade: appliedGrade })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      log(`[grade] 第二层判定失败（本轮只用第一层规则信号）：${lastError}`, 'warn')
      layer2 = 'judge_error'
      return null
    }
  }

  const submitTurn = async (turnIndex: number, text: string, sessionId: string): Promise<void> => {
    const session = sessionProvider()
    if (!session) {
      failed += 1
      lastError = '未绑定当前学生'
      log(
        '[grade] 未绑定当前学生，本轮学段证据未上交（应由 runtime.ts 每轮调用 bindAgentSession）——' +
          '本轮不会更新学段。',
        'warn'
      )
      return
    }

    const decision = shouldRequestLayer2({
      turn: turnIndex,
      usableTurns: countUsableTurns(buffer),
      windowHasProposal,
      judgeAvailable: judge !== null
    })
    let proposal: GradeProposal | null = null
    if (decision.run) {
      proposal = await runJudge()
      layer2 = proposal ? 'used' : layer2 === 'judge_error' ? 'judge_error' : 'no_llm'
      if (proposal) windowHasProposal = true
    } else {
      layer2 = decision.status
    }
    if (decision.status === 'no_llm' && !warnedNoJudge) {
      warnedNoJudge = true
      log(
        '[grade] 第二层 LLM 判定通道未接线（无 API Key 或 runtime 未调用 useJudge）：' +
          '本轮起只用第一层规则信号判定学段，服务端会在出参里标 degraded="no_llm"。' +
          '第一层是完整的（四类信号照常提取、照常能调整学段）。',
        'warn'
      )
    }

    try {
      const response = await submitter(session.studentId, {
        turns: [
          {
            turn: turnIndex,
            text: clampTurnText(text),
            sessionId: sessionId || session.sessionId,
            ...(proposal ? { proposal } : {})
          }
        ]
      })
      submitted += 1
      lastReason = response.reason
      const nextGrade = normalizeGradeLevel(response.grade)
      if (nextGrade !== appliedGrade) {
        pendingGrade = nextGrade
        lastChangedAtTurn = response.turn
        log(
          `[grade] 学段自动调整：${appliedGrade} → ${nextGrade}` +
            `（第 ${response.turn} 轮，置信度 ${response.confidence.toFixed(2)}，` +
            `连续 ${response.streak} 轮同向${response.degraded ? `，${response.degraded}` : ''}）——` +
            '下一轮生效'
        )
      }
    } catch (error) {
      failed += 1
      lastError = error instanceof Error ? error.message : String(error)
      log(`[grade] 本轮学段证据未上交（不影响本轮对话）：${lastError}`, 'warn')
    }
  }

  const extension = ((pi: AgentExtensionApi): void => {
    // ── ① 学生开口：先交接上一轮的判定，再上交本轮证据（fire-and-forget） ──
    pi.on('input', (event: unknown) => {
      try {
        if (!isStudentTurn(event)) return undefined // 别的扩展注入的内容不算学生的一轮
        const text = readInputText(event)
        const session = sessionProvider()
        trackBoundary(session)

        applyPending()
        turn += 1
        const turnIndex = turn
        if (text.trim()) {
          buffer.push({ turn: turnIndex, text: clampTurnText(text) })
          if (buffer.length > LAYER2_WINDOW_TURNS) buffer = buffer.slice(-LAYER2_WINDOW_TURNS)
        }

        // ★ 串行排队：这一轮的判定结果下一轮才用，绝不让本轮对话等它
        //   （`.catch` 只是保住队列：`submitTurn` 自己已经兜了异常，这里再兜一次是防止
        //    队列被一个漏网的 reject 卡死 —— 卡死之后所有轮次都不再上交，且没有任何报错）
        queue = queue
          .then(() => submitTurn(turnIndex, text, session?.sessionId ?? ''))
          .catch((error: unknown) => {
            failed += 1
            lastError = error instanceof Error ? error.message : String(error)
            log(`[grade] 学段证据上交队列异常（已恢复）：${lastError}`, 'warn')
          })
      } catch (error) {
        // 事件处理器里绝不抛：Pi 与 UI 同进程
        log(
          `[grade] 本轮学段观察失败（已忽略，不影响对话）：${
            error instanceof Error ? error.message : String(error)
          }`,
          'warn'
        )
      }
      return undefined // 不参与文本改写：随便返回一个 action 会顶掉别的扩展的决定
    })

    // ── ② 每轮开始：按**推断出的**学段拼 system prompt（链式保真） ──
    pi.on('before_agent_start', (event: unknown) => {
      try {
        const incoming = (event as { systemPrompt?: unknown } | undefined)?.systemPrompt
        const merged = mergeGradePrompt({
          incoming: typeof incoming === 'string' ? incoming : undefined,
          inferredGrade: appliedGrade
        })
        return merged === undefined ? undefined : { systemPrompt: merged }
      } catch (error) {
        // 兜底：出任何意外也要给出学段模板（绝不放行 Pi 的默认 prompt）
        log(`[grade] 学段 prompt 组装失败，退回默认模板：${error instanceof Error ? error.message : String(error)}`, 'warn')
        return { systemPrompt: gradePromptFor(appliedGrade) }
      }
    })
  }) as GradeExtension

  extension.useJudge = (next: Layer2Judge | null): void => {
    judge = next
    warnedNoJudge = false
  }
  extension.snapshot = snapshot
  extension.reset = reset
  extension.flush = async (): Promise<void> => {
    await queue
  }
  extension.refresh = async (): Promise<GradeLevel | null> => {
    const session = sessionProvider()
    if (!session) return null
    try {
      const state = await fetcher(session.studentId)
      const grade = normalizeGradeLevel(state.grade)
      if (grade !== appliedGrade) {
        log(`[grade] 从本地数据服务取到当前学段：${appliedGrade} → ${grade}`)
        appliedGrade = grade
      }
      lastReason = `state:${state.source}`
      return grade
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      log(`[grade] 读取当前学段失败（沿用本进程内的值 ${appliedGrade}）：${lastError}`, 'warn')
      return null
    }
  }
  return extension
}

/** ★ 默认导出：主 Agent 注册的那个单例（`runtime.ts` 用 `grade: gradeExtension` 注入）。 */
const gradeExtension = createGradeExtension()

export default gradeExtension
