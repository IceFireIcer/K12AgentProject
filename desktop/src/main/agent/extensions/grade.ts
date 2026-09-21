/**
 * 学段 Extension（票 21）—— **默认由系统推断并自动生效；学生也可以手动指定**。
 *
 * ★ 头两行曾经写「没有人工选择」——那是 **D-020 的旧口径**，已被 **D-037** 推翻：
 *   学生点指示器或设置页即可**立即**改学段（`grade:set` 独立通道 → `POST /api/grade/override`），
 *   之后进入更长的冷却（10 轮）再平滑回归自动。见 `adoptOverride()`。
 *
 * 设计：
 *
 * ```text
 * 每轮开始 ──▶ 上交本轮证据 ──▶ Python：signals.py 提取三路信号（不调 LLM）
 *                                  └─▶ rules.py 规则引擎（最终决策者）
 *                                        └─▶ 必要时原子改 learning.db 的 student.grade_level
 *   同一轮拼 prompt ──▶ 用**已交接的**学段拼 system prompt（自动调整学生无感）
 * ```
 *
 * ★ 三路信号 = 词汇复杂度 / 问题深度 / 元认知表达（2026-09-21 起；「答题表现」那一路
 *   已移除 —— 它把「知识点没掌握」误当成「学段更低」，还会与元认知重复计数）。
 *
 * ★★ **本扩展不再订阅任何 Pi 事件**（票 21 的返工，2026-09-16 实测结论）。
 *
 * 原设计把观察挂在 `pi.on('input')`、把 prompt 覆盖挂在 `pi.on('before_agent_start')`。
 * 实测这两条在**本项目的 SDK 嵌入形态**下都不可靠，理由分两层、都不是「Pi 的 hook 坏了」：
 *
 * 1. **`input` 只在真的调用 `session.prompt()` 时才发**。Pi 的 `prompt()` 里
 *    `emitInput()` 是第一句（`agent-session.js`），但本项目在**无 API Key** 时会
 *    `runTurn()` 前置判定并**直接 return，根本不调 `prompt()`**（`runtime.ts` 的
 *    「无 Key：不假装、不静默、不挂起」分支）—— 于是观察一次都不发生。
 *    「无 Key 也要能推学段」是硬要求（第一层规则引擎不依赖 LLM），所以观察**不能**挂在 `input` 上。
 * 2. **`before_agent_start` 在 Pi 里排在凭证校验之后**（`prompt()` 先 `hasConfiguredAuth`，
 *    不过就抛 `No API key found`，`emitBeforeAgentStart()` 永远到不了）。也就是说即便调了
 *    `prompt()`，无 Key 时 prompt 覆盖也不会触发 —— 它只能在「真的会有 provider 请求」时生效。
 *
 * 结论（**这就是当前实现**）：
 *   - **观察**：由 `runtime.ts` 在每轮开始**显式调用** {@link GradeExtension.observeTurn}
 *     （唯一入口、唯一提交路径，不存在双份计数）；
 *   - **prompt 覆盖**：由 `runtime.ts` 的 `chatFactory` 在 `before_agent_start` 里用
 *     {@link buildGradeSystemPrompt} 拼（同样唯一一处），并在末尾**始终**追加
 *     {@link GRADE_OVERRIDE_HEADING} 权威段，使「本轮按哪个学段作答」在提示词里**可审计**
 *     （旧实现靠「整份模板替换」，模板相同时静默不动，线上根本看不出覆盖有没有生效）。
 *   - 本文件保留**纯逻辑 + 出口**，因此它同时是可单测的（不 import Pi、不发 HTTP）。
 *
 * ★ 五条纪律（都不是实现细节）：
 *
 * 1. **提取只有一份实现**：本文件**不做**任何规则/词表匹配，只上交「本轮证据」
 *    （`{turn, text, sessionId}` + 可选的第二层提议）。判据全在 `server/app/grade/signals.py`，
 *    两份实现必然漂移，而漂移的表现是「学段莫名乱动」。
 * 2. **决策在服务端**：本文件只认服务端回的 `grade`，不自己算阈值、不自己判方向。
 * 3. **下一轮生效**：服务端在第 N 轮判定出的学段在**第 N+1 轮**的 prompt 生效
 *    （`pendingGrade` → `appliedGrade` 的交接发生在下一次 `observeTurn`）。学生看不到「切换」事件，
 *    这正是执行文档 §10.4 要求的「无感」。
 * 4. **绝不阻塞对话**：`observeTurn` 里的上交是 fire-and-forget（判定的产物下一轮才用），
 *    失败只记日志；prompt 拼装是**同步纯函数**，绝不 await 网络。
 * 5. **链式保真**：{@link buildGradeSystemPrompt} 只在**认得出**别的扩展用的是哪份学段模板时
 *    原地替换片段，认不出就原样保留别人的内容再追加权威段 —— 绝不整段丢弃别人的内容
 *    （那会把「抹掉宿主路径泄漏」的那道覆盖一起冲掉）。
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
  GRADE_LABELS,
  GRADE_LEVELS,
  GRADE_PROMPTS,
  GRADE_STYLES,
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

/**
 * ★★ **LLM 从第几个「累计轮次」起成为决策者**（D-066，`rules.py` 的 `LLM_DECIDES_FROM_TURN`）。
 *
 * 前 4 个累计轮次只有规则判（标签「本地规则判定」）；第 5 个累计轮次起 LLM 直接定方向
 * （标签「AI 引擎判定」）。计数单位是**累计轮次**（跨会话连续，来自服务端
 * `GET /api/grade/state` 的 `cumulativeTurns`）。
 */
export const LLM_DECIDES_FROM_TURN = 5

/** 第二层判定至少要有几轮可用证据（不足则等到累计第 5 轮）。 */
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
export const gradeOverridePath = (studentId: string): string =>
  `/api/grade/override/${encodeURIComponent(studentId)}`

/**
 * 单次 sidecar 调用的超时（F9）。
 *
 * ★ 为什么学段这条链**特别**不能没有超时：上交是**串行排队**的（{@link createGradeExtension}
 *   的 `queue`），一次假死的请求会把队首占住 —— 之后**每一轮都不再上交**，
 *   而 `runtime.dispose()` 里的 `await gradeExtension.flush()` 会跟着一起挂住。
 *   数值与 `rag-search.ts` 的 `RAG_SEARCH_TIMEOUT_MS` 同一口径。
 */
export const GRADE_TIMEOUT_MS = 8_000

/**
 * `flush()` 的等待上限（F9）。
 *
 * 队列里的每一项都已经带上了 `GRADE_TIMEOUT_MS`，所以正常情况远早于这个上限；
 * 上限只对付「某项卡在一个不受我们控制的 await 上」的意外 —— 退出流程不能被无限拖住。
 */
export const GRADE_FLUSH_TIMEOUT_MS = 10_000

/**
 * 追加式权威段的标题（`buildGradeSystemPrompt` 的产物里**始终**有它）。
 *
 * ★ 它不再只是「认不出别的扩展模板时的兜底块」：从返工起，它同时是
 *   **「覆盖到底有没有生效」的唯一可判定标志**（wire prompt 里 grep 得到它 = 学段落点在工作）。
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
  /**
   * ★ 第二层通道的本轮状态（服务端据此决定 `degraded` 要不要置位）。
   *
   * 为什么必须由我们上报：服务端只看得到「这一轮有没有提议」，看不到**为什么没有** ——
   * 于是它把 `already_proposed`（本窗口早就提过议，属**正常工作**）也标成
   * `degraded="no_llm"`。实测 436 次判定里 218 次被这么标，而 63 次第 3 轮里有
   * 48 次真的带上了提议。见 `isDegradedLayer2()`。
   */
  layer2Status?: Layer2Status
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
  /** 哪一层产出了当前学段（D-066）：`rules` / `llm` / `null`（冷启动基线或手动指定）。 */
  decidedBy?: string | null
  /** **累计轮次**（跨会话连续）：`≥ LLM_DECIDES_FROM_TURN` 时才请 LLM 出场。 */
  cumulativeTurns?: number
  lastTurn: number
  lastChangeTurn?: number | null
  cooldownRemainingTurns: number
  streak: number
  direction: number
  confidence: number
  suggestedLevel?: GradeLevel | null
}

/** `POST /api/grade/override/{studentId}` 的出参（只声明本扩展用得到的字段）。 */
export interface GradeOverrideResponse {
  gradeLevel: GradeLevel
  previousLevel: GradeLevel
  changed: boolean
  turn: number
  /** 手动冷却还剩几轮（冷却期内规则引擎不再自动调整学段）。 */
  cooldownRemainingTurns: number
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
  /** **累计轮次**（跨会话连续；服务端 `GET /api/grade/state` 同步下来，D-066）。 */
  cumulativeTurns: number
  /** 当前学段是**哪一层**判的（`rules` / `llm` / `null`）—— 界面标签据此显示「本地规则判定」/「AI 引擎判定」。 */
  decidedBy: string | null
  /** 成功上交的轮数 / 失败次数（失败只影响下一轮生效的时机，不影响本轮对话）。 */
  submitted: number
  failed: number
  /** 最近一次服务端判定的结论（可读中文，进日志与验收记录）。 */
  lastReason: string
  lastChangedAtTurn: number | null
  /** 最近一次**学生手动设定**带来的冷却剩余轮数（没手动改过就是 `0`）。 */
  cooldownRemainingTurns: number
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
  /**
   * 工厂。★ **本扩展不再订阅任何 Pi 事件**（理由见文件头）：工厂本身是空实现，
   * 能力全部经 {@link observeTurn} / {@link systemPromptFor} 由 `runtime.ts` 显式驱动。
   * 保留它是因为 `extensions/index.ts` 的注册器按「是不是一个函数」判定扩展是否就位。
   */
  (pi: AgentExtensionApi): void
  /**
   * ★★ **唯一的观察入口**：`runtime.ts` 在**每轮开始时**调用一次（不论有没有 API Key ——
   * 无 Key 时 `session.prompt()` 根本不会被调用，`input` 事件一次都不发）。
   * 同步返回，绝不阻塞本轮对话；本轮的判定结果**下一轮**才用。
   */
  observeTurn(text: string): void
  /**
   * 本轮 system prompt（**同步纯逻辑**）：`runtime.ts` 的 `before_agent_start` 里调用。
   * 末尾始终带 {@link GRADE_OVERRIDE_HEADING} 权威段，使覆盖在提示词里可审计。
   */
  systemPromptFor(incoming: string | undefined): string
  /** 当前生效学段（诊断；`before_agent_start` 用的就是它）。 */
  appliedGrade(): GradeLevel
  /** 接线第二层判定通道（`runtime.ts` 建会话后调用；不接线 = 干净降级）。 */
  useJudge(judge: Layer2Judge | null): void
  /**
   * ★ 采纳学生的手动选择（服务端已写库之后调用）。
   *
   * 与「下一轮生效」的 {@link GradeExtension.observeTurn} 不同，它**立即生效**：
   * 学生刚点了「初中」，下一句话就该按初中作答 —— 再等一轮等于没改。
   * 同时清掉 `pendingGrade`（那是「服务端判出来、下一轮生效」的载体，
   * 与「学生现在就要生效」是两种语义，混在一起会出现「我明明选了初中，它又跳回去」）。
   * 并且 **bump epoch**：把在途推断结论作废（见 `submitTurn` 里的 epoch 检查）。
   */
  adoptOverride(gradeLevel: GradeLevel, cooldownRemainingTurns: number): void
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
 * ★ 第二层何时触发（D-066：**累计轮次 ≥ 5 起，LLM 成为决策者**）。
 *
 * 旧口径是「第 3 轮触发、不足退第 5 轮」，而且 LLM 只是提议（反向被规则否决）。
 * 2026-09-21（D-066，用户裁决）改为：**前 4 个累计轮次只有规则判；第 5 个累计轮次起
 * LLM 直接定方向**（规则退居安全网）。计数单位是**累计轮次**（跨会话连续，
 * 从服务端 `GET /api/grade/state` 的 `cumulativeTurns` 来），因为实测会话普遍只有 3–8 轮，
 * 按会话重数会让很多会话永远等不到 LLM。
 *
 * 返回 `run=true` 时调用方才去跑一次轻量 LLM 判定。**没有判定通道时返回 `no_llm`**
 * （不是静默跳过：调用方据此打日志、服务端据此回 `degraded`）。
 */
export function shouldRequestLayer2(input: {
  cumulativeTurns: number
  usableTurns: number
  windowHasProposal: boolean
  judgeAvailable: boolean
}): { run: boolean; status: Layer2Status } {
  if (!input.judgeAvailable) return { run: false, status: 'no_llm' }
  if (input.windowHasProposal) return { run: false, status: 'already_proposed' }
  if (input.cumulativeTurns < LLM_DECIDES_FROM_TURN) return { run: false, status: 'not_due' }
  if (input.usableTurns >= LAYER2_MIN_TURNS) return { run: true, status: 'due' }
  return { run: false, status: 'insufficient_evidence' }
}

/**
 * ★★ 这个状态算不算**真降级**（服务端据此决定 `degraded` 要不要置位）。
 *
 * `Layer2Status` 有 8 个取值，但只有两个是「第二层没工作」：
 *
 * - `no_llm`      —— 根本没接上模型通道（无 Key / 启动期降级）；
 * - `judge_error` —— 接上了但调用失败（超时 / 解析不出 JSON）。
 *
 * 其余**都不是**降级。最典型的是 `already_proposed`：一个窗口只判一次是**设计**，
 * 它恰恰说明第二层正常工作过；`not_due` 是还没到第 3 轮。
 *
 * ★ 服务端原先的口径是「没有提议 + 第 3 轮起 → `no_llm`」，于是把 `already_proposed`
 * 也报成「没模型」——实测 436 次判定里 218 次被这么标，而 63 次第 3 轮判定里
 * **48 次真的带上了提议**。标注与实际相反，「双层判定」这条创新性叙事因此拿不出可信证据。
 *
 * ⚠️ 这份白名单必须与服务端 `rules.py` 的 `DEGRADED_LAYER2_STATUSES` **保持一致**，
 * 由 `desktop/tests/grade-inference.test.ts` 的跨语言断言钉住（改一边必须改另一边）。
 */
export function isDegradedLayer2(status: Layer2Status): boolean {
  return status === 'no_llm' || status === 'judge_error'
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
    '你是 K12 场景下的学段分级助手。下面是一名学生最近的提问（按时间先后）。',
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
 * ★★ 剥掉 Pi 无条件追加的宿主 cwd 尾巴（F15，Pi issue #6308）。
 *
 * Pi 的 `buildSystemPrompt()` 在给了 `customPrompt` / 被覆盖之后**仍然**会在**最后**
 * 追加一行 `Current working directory: <绝对路径>`（含盘符与用户名）—— 这一行会把宿主
 * 安装路径泄漏给模型（AGENTS §5.11 / 风险 #19）。上游修复之前只能自己剥。
 *
 * 两道防线（两侧各一道，任一侧漏了另一侧兜住）：
 *   ① `runtime.ts` 在 `before_agent_start` 接线里先剥一遍（代理 E 负责）；
 *   ② **本函数在返回前再剥一遍** —— 即使调用方没剥干净，权威段前面也不会留下尾巴。
 *
 * 判据写成**纯函数**是为了可单测：匹配**末尾**的该行（允许行首缩进、允许后面跟空行），
 * 中间的正文里偶然出现同样字样时不动它（那不是 Pi 的尾巴，是别人 prompt 的内容）。
 */
export const CWD_TAIL_RE = /(?:^|\n)[ \t]*Current working directory:[^\n]*(?:\n[ \t]*)*$/i

/** 去掉末尾的 cwd 尾巴（没有就原样返回；纯函数，可单测）。 */
export function stripCwdTail(prompt: string): string {
  if (typeof prompt !== 'string' || prompt.length === 0) return prompt
  let out = prompt
  // 上限 4 次是防御性的：一次拼装最多追加一次，但真重复时不该只剥一半（也不该死循环）
  for (let index = 0; index < 4; index += 1) {
    const next = out.replace(CWD_TAIL_RE, '')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 本轮 system prompt 的组装（**纯函数**，链式语义全在这里）。
 *
 * ★ 与旧实现（`mergeGradePrompt`）的关键差异：**学段没变时也要追加权威段**。
 *   旧实现「已经是目标模板 → 返回 `undefined`，不动链条」，于是**提示词里没有任何痕迹**
 *   能证明覆盖真的生效了 —— 这一条正是票 21 返工的起因（wire prompt 里 grep 不到
 *   推断学段，只能去读磁盘上的模板文件反推）。现在的语义是：
 *
 *   - 别的扩展**没给** prompt（`undefined`/空）→ 直接给出目标模板；
 *   - 认得出别的扩展用的是**别的学段**模板 → 原地替换该片段（保留其余内容）；
 *   - 已经是目标模板 / 认不出的自定义 prompt → 原样保留；
 *   然后**一律**在最末尾追加权威段（{@link GRADE_OVERRIDE_HEADING}），使「本轮按哪个学段
 *   作答」在提示词里**始终可审计**。目标模板不在基座里时才在权威段里补上，避免同一份
 *   模板在一个 prompt 里出现两遍（约 2.5k token，不能白花）。
 *
 * ★ 进与出一律先过 {@link stripCwdTail}（F15）：Pi 追加的 `Current working directory: …`
 *   尾巴既不进模板替换的判断，也不留在最终产物里（**输出侧那道是最后防线**）。
 *
 * 权威段是**幂等**的：重复拼装不会叠出第二段（见 {@link stripGradeOverride}）。
 */
export function buildGradeSystemPrompt(params: {
  incoming: string | undefined
  inferredGrade: GradeLevel
  /**
   * 这个学段是不是**学生自己选的**（权威段据此换一种说法）。
   *
   * ⚠️ **不改权威段的标题**（{@link GRADE_OVERRIDE_HEADING}）：那个字面量同时是
   * `stripGradeOverride` 的识别标志，改了等于让历史 prompt 里的旧段再也清不掉。
   * 所以来源只体现在**正文**里（见 {@link withGradeOverride}）。
   */
  explicit?: boolean
}): string {
  const target = gradePromptFor(params.inferredGrade)
  const incoming = params.incoming
  const explicit = params.explicit === true
  if (typeof incoming !== 'string' || incoming.trim() === '') {
    return stripCwdTail(withGradeOverride(target, params.inferredGrade, false, explicit))
  }
  // ★ 先剥尾巴再比模板：不然「尾巴」会跟着模板一起被 swap 带走或留在原地
  const bare = stripCwdTail(stripGradeOverride(incoming))
  const merged = bare.includes(target) ? bare : (swapKnownGradeTemplate(bare, target) ?? bare)
  // ★ 输出侧再剥一次（**最后防线**）：即便上游漏了，尾巴也不会到达模型
  return stripCwdTail(
    withGradeOverride(merged, params.inferredGrade, !merged.includes(target), explicit)
  )
}

/**
 * 去掉上一次追加的权威段（幂等的前提）。
 *
 * 权威段总是**拼在最末尾**且以 {@link GRADE_OVERRIDE_HEADING} 起头，所以「最后一次出现」
 * 之后的内容就是我们要替换掉的；找不到标题时原样返回（不动别人的 prompt）。
 */
export function stripGradeOverride(prompt: string): string {
  const at = prompt.lastIndexOf(GRADE_OVERRIDE_HEADING)
  if (at < 0) return prompt
  return prompt.slice(0, at).replace(/\s+$/, '')
}

/**
 * 追加权威段（**幂等**：先剥掉旧的再追加，链式调用不会叠出多段）。
 *
 * 段落用中文写清「这一轮按哪个学段作答」并点名语言风格 ——
 * 模型一眼认出这段是权威指令；`includeTemplate` 为真时再补上模板全文
 * （只在基座里认不出目标模板时才需要）。
 *
 * ★ `explicit`（2026-09-21 新增）：学段是**学生自己选的**时，正文里如实说明。
 *   此前无论自动还是手选都写「系统自动推断」——学生手选之后那句话是假的，
 *   而它排在最末尾、是模型眼里最权威的一句。
 *   ⚠️ 标题（{@link GRADE_OVERRIDE_HEADING}）**不动**：它是幂等清理的识别标志。
 */
function withGradeOverride(
  prompt: string,
  grade: GradeLevel,
  includeTemplate: boolean,
  explicit = false
): string {
  const base = stripGradeOverride(prompt).trim()
  const lines = [
    GRADE_OVERRIDE_HEADING,
    explicit
      ? `- 本轮按「${GRADE_LABELS[grade] ?? grade}」作答（**这个学段是学生自己选的**，请按它作答）。`
      : `- 本轮按「${GRADE_LABELS[grade] ?? grade}」作答（更高学段的问题按该学段的处置办法回答）。`,
    `- 语言风格：${GRADE_STYLES[grade] ?? ''}`
  ]
  const overlay = includeTemplate ? `${lines.join('\n')}\n\n${gradePromptFor(grade)}` : lines.join('\n')
  return base === '' ? overlay : `${base}\n\n${overlay}`
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
    body: JSON.stringify(body),
    // ★ 显式超时（F9）：学段上交是串行排队的，卡住队首会让之后每一轮都不再上交
    signal: AbortSignal.timeout(GRADE_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`学段判定请求失败：HTTP ${response.status}${await readSnippet(response)}`)
  }
  return (await response.json()) as GradeTurnResponse
}

/** 读当前学段（冷启动/刷新用）。 */
export async function fetchGradeState(studentId: string): Promise<GradeStateSnapshot> {
  const { apiFetch } = await import('../../bridge/client.ts')
  // ★ 显式超时（F9）：否则 sidecar 假死时 `refresh()` 会把启动路径一起吊住
  const response = await apiFetch(gradeStatePath(studentId), {
    method: 'GET',
    signal: AbortSignal.timeout(GRADE_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`读取当前学段失败：HTTP ${response.status}${await readSnippet(response)}`)
  }
  return (await response.json()) as GradeStateSnapshot
}

/**
 * 学生手动设定学段（`grade:set` 那条链的 HTTP 出口）。
 *
 * ★ `body` 按 **camelCase** 发：后端入参是 snake_case 模型 + `CamelModel` alias，
 *   按 alias 发才认得出（与 `postGradeTurns` 的 body 形状同一约定）。
 * ★ 与 `postGradeTurns` 一样动态 import `bridge/client.ts`（理由见 `learning-log.ts` 的同名注释：
 *   那个模块有一处缺 `.ts` 的导入，静态 import 会让 `node --test` 整个模块导入失败）。
 * ★ 失败**抛可读异常**（不是回一个 `{ok:false}`）：调用方（runtime → handlers）负责把它
 *   翻成中文回执；在这一层吞掉的话，「为什么没改成」就查不出来了。
 */
export async function postGradeOverride(
  studentId: string,
  gradeLevel: GradeLevel
): Promise<GradeOverrideResponse> {
  const { apiFetch } = await import('../../bridge/client.ts')
  const response = await apiFetch(gradeOverridePath(studentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gradeLevel }),
    // ★ 显式超时（F9）：这是学生在界面上等回执的一条路，卡住会让「设定中…」永远转下去
    signal: AbortSignal.timeout(GRADE_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`设定学段失败：HTTP ${response.status}${await readSnippet(response)}`)
  }
  return (await response.json()) as GradeOverrideResponse
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

  /**
   * ★★ **手动设定的代际**（本波的核心）。
   *
   * 解决什么：学生手动选了学段之后，**之前已经在飞的那次 `submitTurn`** 回来时，
   * 带的是按**旧学段**算出来的结论。不改它就会把学生刚选的学段悄悄顶掉 ——
   * 学生的体感是「我明明选了初中，它又跳回小学高年级了」，而且他做什么都改不回来
   * （每次手动设定都会被另一次在途结论覆盖）。
   *
   * 手法与已有的 `isDiscarded()`（跨学生丢弃）**同一个套路，只是换了一个维度**：
   * 提交前快照 → await 之后再比对 → 不一致就整条作废。
   * 那个维度防的是「A 的证据以 B 的身份上交」，这个维度防的是「旧学段的结论覆盖新选择」。
   */
  let epoch = 0

  /** 最近一次手动设定带来的冷却剩余轮数（`snapshot()` 给诊断与验收用）。 */
  let overrideCooldownRemaining = 0

  let turn = 0
  /**
   * **累计轮次**（跨会话连续）—— 服务端 `GET /api/grade/state` 的 `cumulativeTurns` 同步下来。
   *
   * ★ 它是「第 5 轮起 LLM 接管」的计数单位（D-066）。**不能**用本地那个每会话计数器
   *   `turn`：实测会话普遍只有 3–8 轮，按会话重数会让很多会话永远等不到 LLM，
   *   而学段是跟着**学生这个人**走的，不是跟着某一次对话。
   */
  let serverCumulativeTurns = 0
  /**
   * ★★ **累计轮次的本地增量**（D-066）—— 换**会话不归零**、换**学生才归零**。
   *
   * 为什么不能用 `turn` 推：`turn` 是**每会话**计数器，`resetWindow()` 会在换会话时把它清零
   * （见该函数）。拿它算累计数，换会话那一下累计值会从 6 掉回 1 ——
   * 于是「第 5 轮起 LLM 接管」这条规则在跨会话时永远不成立（实测 CI：`1 !== 6`）。
   *
   * 语义：上次从服务端同步之后，本地又观察到了几轮。
   * - 每次 `observeTurn` +1；
   * - `refresh()` 成功同步时清零（服务端那个数**已经包含**本地之前交上去的轮次，
   *   不清零就把同一批轮次算两遍）；
   * - `reset()`（换学生）清零。
   */
  let localTurnsSinceSync = 0
  /**
   * 当前学段是**哪一层**判的（`rules` / `llm` / `null`）—— 服务端同一行读出来的。
   * 界面标签据此显示「本地规则判定」/「AI 引擎判定」/「待判定」。
   */
  let decidedBy: string | null = null
  let currentSessionId = ''
  let currentStudentId = ''
  let buffer: Array<{ turn: number; text: string }> = []
  let windowHasProposal = false
  let layer2: Layer2Status = 'not_due'
  let submitted = 0
  let failed = 0
  let lastReason = ''
  /**
   * 当前学段是**学生自己选的**吗（`adoptOverride` 置真；自动路径与 `state:` 刷新置假）。
   *
   * ★ 只为**权威段的措辞**服务：自动推断与学生手动选定，对模型的意义不同 ——
   *   前者是「系统按证据猜的」，后者是「学生明确要求的」，后者不该被轻描淡写地带过。
   *   此前权威段一律写「系统自动推断」，于是学生手选之后那句话是**假的**，
   *   而它恰好排在最末尾、是模型眼里最权威的一句（D-064）。
   * ⚠️ 它**不参与任何判定**（不改阈值、不改方向），只改一句话的说法。
   */
  let explicitChoice = false
  let lastChangedAtTurn: number | null = null
  let lastError: string | undefined
  let warnedNoJudge = false
  /** 会话内的串行化：每一轮的上交排队执行，避免同一进程里并发写库。 */
  let queue: Promise<void> = Promise.resolve()

  /**
   * ★★ 排队中的上交项（F3）：**身份在提交那一刻就快照下来**，队列内不再读全局。
   *
   * 曾经的写法是「任务执行时才 `sessionProvider()`」：这两个请求**带超时之后也可能慢**
   * （sidecar 假死 8 秒），而切学生（`runtime.ts` 的 `bindAgentSession`）只做绑定、
   * **不会取消队列**。于是排在后面的任务会拿**新学生**的身份，把**旧学生**的 `text`
   * 发到 `POST /api/grade/turns/{新学生}` —— A 的原话进 B 的 `grade_signals`，
   * 违反「每个学生独立存储」硬约束。
   *
   * 现在：① 快照进 `PendingTurn`；② 切学生时把 studentId 不匹配的待发项标成 `discarded`，
   * 轮到它时**直接跳过**（读都不读新身份）。
   */
  interface PendingTurn {
    studentId: string
    sessionId: string
    turn: number
    text: string
    /**
     * ★★ **入队那一刻的累计轮次**（D-066）—— 与身份快照（F3）同一个道理。
     *
     * 为什么不能在执行时读全局 `localTurnsSinceSync`：上交是**串行队列**，
     * 而 `observeTurn` 是**同步连推**的（一轮回答结束时可能连推好几轮）。
     * 实测（G4b）：无 await 连推 5 轮后队列才开始跑，第一个任务读到的计数器**已经是 5**
     * → 它以为「这已经是累计第 5 轮」而请 LLM 出场 —— 判定落到了**第 1 轮**上。
     */
    cumulativeTurns: number
    /** 切学生时被丢弃：执行到它时直接跳过（**绝不用新学生的身份发旧学生的证据**）。 */
    discarded: boolean
  }
  let pending: PendingTurn[] = []

  const snapshot = (): GradeExtensionStats => ({
    turn,
    appliedGrade,
    pendingGrade,
    layer2,
    // ★ 报**扩展实际相信的**累计轮次（服务端同步值 + 本地增量），不是只报服务端那一半 ——
    //   `snapshot()` 是诊断出口，报一个「判定时并不使用」的数会误导排查。
    cumulativeTurns: serverCumulativeTurns + localTurnsSinceSync,
    decidedBy,
    submitted,
    failed,
    lastReason,
    lastChangedAtTurn,
    cooldownRemainingTurns: overrideCooldownRemaining,
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
    explicitChoice = false
    lastChangedAtTurn = null
    // ★ 累计轮次与判定层也是**学生级**状态（D-066）：换学生时一起归零 ——
    //   否则新学生会继承上一个学生的累计轮数（可能一上来就 ≥ 5）而直接请 LLM 出场。
    //   换会话**不**归零（累计轮次本就跨会话，见 serverCumulativeTurns 的说明）——
    //   那条路径在 `trackBoundary` 里只调 `resetWindow()`。
    serverCumulativeTurns = 0
    localTurnsSinceSync = 0
    decidedBy = null
    // ★ 手动设定的冷却也是**学生级**状态：换学生时一起归零，绝不把上一个学生的冷却
    //   显示到下一个学生的界面上（与 appliedGrade 必须一起重置是同一条纪律）。
    overrideCooldownRemaining = 0
    lastError = undefined
    // ★ 已排队的项也一并作废（F3）：重置之后它们携带的身份已经不再代表「当前学生」
    for (const item of pending) item.discarded = true
    pending = []
    queue = Promise.resolve()
  }

  /** 把「上一轮判定出的学段」交接给本轮（这就是「下一轮生效」的落点）。 */
  const applyPending = (): void => {
    if (pendingGrade && pendingGrade !== appliedGrade) {
      log(`[grade] 本轮按推断出的新学段作答：${appliedGrade} → ${pendingGrade}（学生无感）`)
      appliedGrade = pendingGrade
      // ★ 这是**推断**出来的新学段 → 权威段的措辞不再是「学生自己选的」（见 explicitChoice）。
      //   不重置的话，学生手选过一次初中、之后被自动调到高中，权威段仍写着「学生自己选的」。
      explicitChoice = false
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

  /**
   * 换学生：**连学段一起重置**（绝不把上一个学生的学段带到下一个学生头上）。
   *
   * ★ F3：同时把队列里那些「属于上一个学生」的待发项丢弃 —— 队列没有取消机制，
   *   只清计数的话，A 的提问会被排在队尾、以 B 的身份发出去（跨学生数据污染）。
   *   判据用**传入的新学生 id**（调用点此刻还没更新 `currentStudentId`）。
   */
  const resetForStudent = (nextStudentId: string): void => {
    resetWindow()
    appliedGrade = DEFAULT_GRADE_LEVEL
    pendingGrade = null
    // ★ 冷却与学生绑定：换学生必须归零，否则新学生的界面会显示上一个学生的「冷却剩余」。
    overrideCooldownRemaining = 0
    let dropped = 0
    const kept: PendingTurn[] = []
    for (const item of pending) {
      if (item.studentId !== nextStudentId) {
        item.discarded = true
        dropped += 1
        continue
      }
      kept.push(item)
    }
    pending = kept
    if (dropped > 0) {
      log(
        `[grade] 切换学生：队列里 ${dropped} 条属于上一个学生的学段证据已丢弃（绝不用新学生的身份上交）`,
        'warn'
      )
    }
  }

  /** 跟踪会话/学生边界（每轮开始调用；返回本轮的学生身份是否已切换）。 */
  const trackBoundary = (session: { studentId: string; sessionId: string } | null): void => {
    if (!session) return
    if (session.studentId !== currentStudentId) {
      if (currentStudentId) {
        log(`[grade] 切换学生：${currentStudentId} → ${session.studentId}，学段回到冷启动默认值并重新推断`)
        resetForStudent(session.studentId)
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

  /**
   * 上交一轮证据。
   *
   * ★ F3：**身份由参数传入（提交那一刻的快照），函数内不再读 `sessionProvider()`**。
   *   队列执行到它时可能已经切过学生了 —— 那时读全局会拿到新学生，
   *   把旧学生的 `text` 发到新学生的端点（跨学生数据污染）。
   */
  const submitTurn = async (item: PendingTurn, isDiscarded: () => boolean): Promise<void> => {
    // ★ 切学生时被标成丢弃的项：**读都不读**，直接跳过（日志留痕，绝不静默）
    if (isDiscarded()) {
      log(`[grade] 队列里的第 ${item.turn} 轮证据属于上一个学生，已跳过（切学生时丢弃）`, 'warn')
      return
    }
    const sessionId = item.sessionId

    /**
     * ★★ **手动设定的代际快照必须在任何网络 await 之前**（H-2）。
     *
     * 这里的判定【不是】本轮才第一次读 epoch —— 它就是这套作废机制原本的地址，
     * 只是快照原先拍在 `submitter` 的 await 之前、`runJudge()` 的 await **之后**：
     * `runJudge()` 要过一次 LLM（上限 `JUDGE_TIMEOUT_MS` = 8s，而这里的 8s 只是我们这一侧的
     * 等待上限，云端通常更早返回但**绝不保证**），学生在那个窗口里点一下学段，
     * `adoptOverride()` 会 bump epoch —— 可快照还没拍，于是比对**通过**，
     * 按**旧学段**算出的结论照常落到 `pendingGrade`，下一轮 `applyPending()` 把学生刚选的顶回去。
     * 学生的体感是「我明明选了初中，它又跳回小学高年级」，而且每次选都被下一次在途结论覆盖。
     *
     * 现在快照拍在最前面，`runJudge()` 一返回就立即比对：不一致就**整条丢弃**，
     * 连 `proposal` 都不带上交（按旧学段算出来的提议对服务端也是过期的原料）。
     */
    const epochAtSubmit = epoch

    const decision = shouldRequestLayer2({
      // ★★ 累计轮次用**入队时的快照**（`item.cumulativeTurns`），不读全局计数器 ——
      //   队列是串行异步的，读全局会拿到「后来涨上去的值」（实测 G4b：判定落到第 1 轮）。
      cumulativeTurns: item.cumulativeTurns,
      usableTurns: countUsableTurns(buffer),
      windowHasProposal,
      judgeAvailable: judge !== null
    })
    let proposal: GradeProposal | null = null
    if (decision.run) {
      proposal = await runJudge()
      // ★★ 第一道在途作废（H-2）：LLM 判定期间学生手动选了学段 → 这一轮的结论与提议全部作废。
      //   与下面 `submitter` 之后那道**不是**重复检查：那道防的是「HTTP 往返期间」，
      //   这道防的是「判定往返期间」，两个窗口互不覆盖（判定的 await 在提交之前）。
      if (epochAtSubmit !== epoch) {
        log(
          `[grade] 第 ${item.turn} 轮的第二层判定期间学生手动切换了学段：` +
            '本轮结论整条作废（连提议都不上交，绝不覆盖学生刚做的选择）',
          'warn'
        )
        return
      }
      layer2 = proposal ? 'used' : layer2 === 'judge_error' ? 'judge_error' : 'no_llm'
      if (proposal) windowHasProposal = true
    } else {
      layer2 = decision.status
    }
    // ★ 判完之后再查一次：判定过程本身要 await（LLM），期间可能切换了学生
    if (isDiscarded()) {
      log(`[grade] 第 ${item.turn} 轮证据在判定期间检测到学生切换，已丢弃（不上交）`, 'warn')
      return
    }
    if (decision.status === 'no_llm' && !warnedNoJudge) {
      warnedNoJudge = true
      log(
        '[grade] 第二层 LLM 判定通道未接线（无 API Key 或 runtime 未调用 useJudge）：' +
          '本轮起只用第一层规则信号判定学段，服务端会在出参里标 degraded="no_llm"。' +
          '第一层是完整的（三路信号照常提取、照常能调整学段）。',
        'warn'
      )
    }

    try {
      const response = await submitter(item.studentId, {
        turns: [
          {
            turn: item.turn,
            text: clampTurnText(item.text),
            sessionId: sessionId || '',
            ...(proposal ? { proposal } : {}),
            // ★★ 把**本轮的通道状态**一并上报（2026-09-21）。
            //   服务端只能看到「有没有提议」，看不到「为什么没有」—— 于是它把
            //   `already_proposed`（本窗口早提过议，属**正常工作**）也标成
            //   `degraded="no_llm"`。实测 436 次判定里 218 次被这么标，而其中
            //   63 次第 3 轮里 48 次真的带上了提议 —— 标注与实际相反。
            //   只有这一侧知道真相：由我们告诉它，它只负责归类。
            layer2Status: layer2
          }
        ]
      })
      /**
       * ★★ 学生手动设定的在途作废（与上面那次 `isDiscarded()` 同一个套路，另一个维度）：
       *   那边防的是「A 的证据以 B 的身份上交」，这边防的是
       *   **「按旧学段算出来的结论覆盖学生刚做的手动选择」**。
       *
       * `epochAtSubmit` 的快照点在 `submitTurn` 的**最前面**（H-2 之后）——
       * 覆盖的是整个 HTTP 往返 + 第二层 LLM 判定这两个 await，缺一段都会漏掉一类在途结论。
       * 这里只负责「回来之后」的比对。
       *
       * 不复用 `pendingGrade` 的「下一轮生效」路径，因为手动选择是**立即**生效的：
       * 让学生看到「我刚选了初中，它又跳回小学高年级」，比不做手动选择更糟。
       *
       * ⚠️ `submitted` / `lastReason` 都放在这个 return **之后**：这个计数描述的是
       *   「有几轮结论进了学段决策链路」，被作废的那些没进（HTTP 确实成功了，
       *   但结果被我们主动丢弃）—— 算进去会让「提交成功数」与「学段真的动过几次」对不上号。
       */
      if (epochAtSubmit !== epoch) {
        log(
          `[grade] 第 ${item.turn} 轮的上交结论在途中被学生手动切换学段作废（已丢弃，不覆盖手动选择）`,
          'warn'
        )
        return
      }
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

  /**
   * ★★ **唯一的观察入口**（票 21 返工）：由 `runtime.ts` 在每轮开始时调用。
   *
   * 为什么不是 `pi.on('input', …)`：见文件头「不再订阅任何 Pi 事件」的第 1 条 ——
   * 无 Key 时 `runTurn()` 根本不会调 `session.prompt()`，`input` 一次都不发，
   * 而「无 Key 也要能推学段」是硬要求。**同步返回，绝不阻塞本轮对话**：判定结果下一轮才用。
   *
   * 语义（与旧 `input` 处理器**逐条不变**，只是入口换了）：
   *   ① 交接上一轮判定出的学段 → ② 累计本轮证据 → ③ 串行上交（fire-and-forget）。
   */
  const observeTurn = (text: string): void => {
    try {
      const clean = typeof text === 'string' ? text : ''
      const session = sessionProvider()
      trackBoundary(session)

      if (!session) {
        // ★ 身份是**提交那一刻**取的（F3）：没绑定就当场记失败，绝不把「稍后读全局」当成身份来源
        failed += 1
        lastError = '未绑定当前学生'
        log(
          '[grade] 未绑定当前学生，本轮学段证据未上交（应由 runtime.ts 每轮调用 bindAgentSession）——' +
            '本轮不会更新学段。',
          'warn'
        )
        return
      }

      applyPending()
      turn += 1
      // ★★ 累计轮次的本地增量（D-066）：与 `turn` **分开**计数 —— `turn` 是每会话计数器
      //   （`resetWindow()` 会把它清零），而累计轮次必须**跨会话**（换会话 ≠ 没聊过）。
      localTurnsSinceSync += 1
      const turnIndex = turn
      if (clean.trim()) {
        buffer.push({ turn: turnIndex, text: clampTurnText(clean) })
        if (buffer.length > LAYER2_WINDOW_TURNS) buffer = buffer.slice(-LAYER2_WINDOW_TURNS)
      }

      // ★★ 身份快照（F3）：**在这里**取好 studentId / sessionId，队列里不再读全局。
      //   切学生（`bindAgentSession`）不会取消队列，排在后面的任务若在执行时才读全局，
      //   就会拿新学生的身份把旧学生的原话发过去 —— A 的话进 B 的 `grade_signals`。
      // ★★ 累计轮次同理（D-066）：**入队快照**，否则队列里读到的会是「后来涨上去的值」。
      const item: PendingTurn = {
        studentId: session.studentId,
        sessionId: session.sessionId ?? '',
        turn: turnIndex,
        text: clean,
        cumulativeTurns: serverCumulativeTurns + localTurnsSinceSync,
        discarded: false
      }
      pending.push(item)

      // ★ 串行排队：这一轮的判定结果下一轮才用，绝不让本轮对话等它
      //   （`.catch` 只是保住队列：`submitTurn` 自己已经兜了异常，这里再兜一次是防止
      //    队列被一个漏网的 reject 卡死 —— 卡死之后所有轮次都不再上交，且没有任何报错）
      queue = queue
        .then(() => submitTurn(item, () => item.discarded))
        .catch((error: unknown) => {
          failed += 1
          lastError = error instanceof Error ? error.message : String(error)
          log(`[grade] 学段证据上交队列异常（已恢复）：${lastError}`, 'warn')
        })
        .finally(() => {
          // 出队（同引用 removed，不是按下标删：并发入队时下标会错位）
          const at = pending.indexOf(item)
          if (at >= 0) pending.splice(at, 1)
        })
    } catch (error) {
      // 调用方在主进程的对话路径上：这里绝不抛（Pi 与 UI 同进程）
      log(
        `[grade] 本轮学段观察失败（已忽略，不影响对话）：${
          error instanceof Error ? error.message : String(error)
        }`,
        'warn'
      )
    }
  }

  /** 本轮 system prompt（**同步纯逻辑**，`runtime.ts` 的 `before_agent_start` 调它）。 */
  const currentSystemPrompt = (incoming: string | undefined): string => {
    try {
      return buildGradeSystemPrompt({
        incoming,
        inferredGrade: appliedGrade,
        // ★ 2026-09-21 新增：把「这个学段**是学生自己选的**」带进权威段。
        //   此前权威段一律写「系统自动推断，以此段为准」——学生手动选过之后那句话就是假的，
        //   而它恰好是模型眼里**最权威的一句**（排在最末尾、离生成最近）。见 D-064。
        explicit: explicitChoice
      })
    } catch (error) {
      // 兜底：出任何意外也要给出学段模板（绝不放行 Pi 的默认 prompt）
      log(`[grade] 学段 prompt 组装失败，退回默认模板：${error instanceof Error ? error.message : String(error)}`, 'warn')
      return gradePromptFor(appliedGrade)
    }
  }

  /**
   * 采纳学生的手动选择（**立即生效**，见 {@link GradeExtension.adoptOverride}）。
   *
   * 三步的顺序是有意的（任一步少做都会留下可观察的错）：
   *   ① `appliedGrade` 换成新值 → **本轮起**的 prompt 与 `runtime.gradeLevel` 立刻是新学段；
   *   ② `pendingGrade = null` → 清掉「服务端判出来、下一轮生效」的那份，否则学生刚选完
   *      下一轮 `applyPending()` 会把它顶回来（体感就是「我选了它又跳回去」）；
   *   ③ `epoch += 1` → 把**已经在飞**的上交结论作废（见 `submitTurn` 里的 epoch 检查）。
   *
   * `normalizeGradeLevel` 兜底：渲染进程递来的值在 IPC 边界已被白名单校验过，
   * 但这一层是纯逻辑出口（也会被单测/未来的别的调用方直接调），脏值必须收敛到四学段之一，
   * 绝不让 `'college'` 之类的东西流进 `GRADE_PROMPTS[...]`（那是 undefined）。
   */
  const adoptOverride = (gradeLevel: GradeLevel, cooldownRemainingTurns: number): void => {
    const next = normalizeGradeLevel(gradeLevel)
    const previous = appliedGrade
    appliedGrade = next
    pendingGrade = null
    epoch += 1
    lastReason = 'override'
    explicitChoice = true
    overrideCooldownRemaining = Number.isFinite(cooldownRemainingTurns)
      ? Math.max(0, Math.trunc(cooldownRemainingTurns))
      : 0
    log(
      `[grade] 学生手动设定学段：${previous} → ${next}` +
        `（冷却 ${overrideCooldownRemaining} 轮内不再自动调整；立即生效）`
    )
  }

  /**
   * 工厂**故意为空**：本扩展的能力全部经 {@link GradeExtension.observeTurn} /
   * {@link GradeExtension.systemPromptFor} 由 `runtime.ts` 显式驱动（理由见文件头）。
   *
   * 但工厂仍然保留 —— `extensions/index.ts` 的注册器按「是不是一个函数」判定扩展是否就位，
   * 去掉它会让注册报告里 grade 变成「未注册」，而它其实是在工作的。
   */
  const extension = ((_pi: AgentExtensionApi): void => {
    // 无 Pi 事件订阅（刻意的，见文件头）。保留空工厂只为让注册器把它算作「已就位」。
  }) as GradeExtension

  extension.observeTurn = observeTurn
  extension.systemPromptFor = currentSystemPrompt
  extension.appliedGrade = () => appliedGrade
  extension.useJudge = (next: Layer2Judge | null): void => {
    judge = next
    warnedNoJudge = false
  }
  extension.adoptOverride = adoptOverride
  extension.snapshot = snapshot
  extension.reset = reset
  /**
   * 等排队的上交全部走完（切换学生 / 退出前调用）。
   *
   * ★ `Promise.race` 上限（F9）：队列里的每一项都已经带了 `GRADE_TIMEOUT_MS` 超时，
   *   所以正常情况远早于 {@link GRADE_FLUSH_TIMEOUT_MS} 就返回；上限只用来兜
   *   「某一项卡在不受我们控制的 await 上」—— `runtime.dispose()` 不能被无限拖住。
   *   超时**不抛**（退出流程里抛异常会把别的收尾步骤一起带走），只记一行日志。
   */
  extension.flush = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), GRADE_FLUSH_TIMEOUT_MS)
      // 计时器不该拖住退出（Node 的 timers 会 ref，这里主动 unref）
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    try {
      const outcome = await Promise.race([queue.then(() => 'done' as const), limit])
      if (outcome === 'timeout') {
        log(
          `[grade] 等学段上交队列超过 ${GRADE_FLUSH_TIMEOUT_MS}ms 仍未排空（已放弃等待，退出流程继续）`,
          'warn'
        )
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  extension.refresh = async (): Promise<GradeLevel | null> => {
    const session = sessionProvider()
    if (!session) return null
    // ★★ 与 `submitTurn` 同一手法（H-2）：`refresh()` 由 `runtime.ts` **fire-and-forget** 调用
    //   （`void gradeExtension.refresh()`，故意不 await，省掉冷启动那一轮的滞后），
    //   而它内部要发一次本机 HTTP（上限 `GRADE_TIMEOUT_MS` = 8s）。sidecar 慢的时候，
    //   学生完全可能在这个窗口里点学段 —— 那时 GET 的回执带的是**旧的**学段值，
    //   无检查地写 `appliedGrade` 等于把学生刚选的那个又顶回旧值（且没有任何日志解释）。
    const epochAtRequest = epoch
    try {
      const state = await fetcher(session.studentId)
      if (epochAtRequest !== epoch) {
        log(
          '[grade] 取当前学段的回执在途中被学生手动切换学段作废（已丢弃，不覆盖手动选择）',
          'warn'
        )
        return null
      }
      const grade = normalizeGradeLevel(state.grade)
      if (grade !== appliedGrade) {
        log(`[grade] 从本地数据服务取到当前学段：${appliedGrade} → ${grade}`)
        appliedGrade = grade
      }
      lastReason = `state:${state.source}`
      // ★★ **累计轮次**（D-066）：服务端是权威 —— 它数的是 `grade_signals` 里
      //   `(session_id, turn)` 的**去重桶数**（跨会话连续）。本地那份 `turn` 只是
      //   每会话计数器，拿它判断「该不该请 LLM 出场」会让每个新会话都从头等 5 轮，
      //   而实测会话普遍只有 3–8 轮。
      if (typeof state.cumulativeTurns === 'number' && state.cumulativeTurns >= 0) {
        serverCumulativeTurns = state.cumulativeTurns
        // ★★ **本地增量必须清零**（D-066）：服务端那个数**已经包含**本地之前交上去的轮次，
        //   不清零就把同一批算两遍（累计虚高 → 提前请 LLM 出场）。
        localTurnsSinceSync = 0
      }
      // ★ 判定层（`rules` / `llm` / `NULL`）也以服务端为准，界面标签据此显示
      //   「本地规则判定」还是「AI 引擎判定」。
      decidedBy = state.decidedBy ?? null
      // ★ 服务端的 `source` 是权威：`explicit` = 学生手选过（还在冷却里），其余是推断。
      //   重启后靠这一句把「这个学段是谁定的」恢复正确 —— 否则冷启动后
      //   学生手选的学段会被权威段说成「系统自动推断」（D-064）。
      explicitChoice = state.source === 'explicit'
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
