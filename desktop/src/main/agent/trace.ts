/**
 * 工具调用轨迹（票 08，执行文档 §9.4 第 4 条）。
 *
 * ★ **这是「设计合理性 25%」的唯一证据形态**：原方案的 `draw_mermaid()` 状态流转图
 *   随 LangGraph 一起作废，取而代之的是这份**真实发生过的** Tool 路由轨迹 ——
 *   它由 `tool_execution_start` / `tool_execution_end` / `tool_call` 三个 Pi 原生事件拼出来，
 *   记录 `{turn, toolName, args摘要, ok, latencyMs, degraded}`，导出为 `docs/tool-trace.mmd`。
 *
 * 三条纪律（都不是「好看」，是硬要求）：
 *
 * 1. **参数只记摘要，绝不落原文**。`get_student_profile` 这类 Tool 的参数里可能带学生输入、
 *    代码片段、昵称；轨迹图是要进汇报 PPT 与报告的文件，落原文等于把数据合规问题写进交付物。
 *    {@link summarizeArgs} 按「键名分类 → 值分类」产出 `kp_id=jr-py-loop, query=«文本 12 字»`
 *    这样的摘要，并且**默认丢弃**敏感键（key/token/secret…）与个人信息键（name/student/…）。
 * 2. **不改任何东西**。三个事件全部是**只读通知**：`tool_execution_end` 不能回写结果，
 *    `tool_call` 只用来读「是否被安全阀拦下」（拦下时不会再有执行事件）。
 * 3. **导出物本身必须是合法 Mermaid**：节点 id 只允许 `[A-Za-z0-9_]`，标签里的引号/尖括号/竖线
 *    一律转义成 Mermaid 实体 —— 否则图在报告里渲染成一片红字，比没有图更糟。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/* ------------------------------------------------------------------ *
 * 记录结构
 * ------------------------------------------------------------------ */

/** 轨迹里的**一条** Tool 调用（一条 = 一次 `tool_execution_*` 配对）。 */
export interface ToolTraceRecord {
  /** 单调递增序号（1 起）。 */
  seq: number
  /** 第几轮对话（`turn_start` 的 `turnIndex`；没有该事件时退化为内部计数）。 */
  turn: number
  /** Tool 名（字面量，来自冻结词表）。 */
  toolName: string
  /** Pi 的调用 id（同一次调用的 start/end 靠它配对）。 */
  toolCallId: string
  /** ★ 参数摘要（**绝不是原文**，见 {@link summarizeArgs}）。 */
  argsSummary: string
  /** `false` = `tool_execution_end.isError`；被安全阀拦下的调用也是 `false`。 */
  ok: boolean
  /** 从 `tool_execution_start` 到 `tool_execution_end` 的墙钟耗时（毫秒，取整）。 */
  latencyMs: number
  /** 降级档位（`vector | cloud | fts | outline`）；没有则省略。 */
  degraded?: string
  /** `true` = 被 `tool_call` 的安全阀拦下（`{block: true}`）。 */
  blocked?: boolean
  /** 拦截原因（来自安全阀的 `reason`）。 */
  blockReason?: string
  /** 失败时的可读原因（已截断，不含堆栈全文）。 */
  errorMessage?: string
  /** 记录结束时刻（ISO 8601，便于与 JSONL 会话对时间）。 */
  at: string
}

/** 轨迹的元信息（导出文件的抬头用；**不含任何学生标识**）。 */
export interface ToolTraceMeta {
  /** 生成时刻（ISO 8601）。 */
  generatedAt: string
  /** 产生轨迹的模型（`providerId/modelId`）；未知则省略。 */
  model?: string
  /** 轮数（实际观察到 `turn_start` 的最大轮次）。 */
  turns: number
}

/**
 * 推给界面的轨迹条目 —— **只带界面要显示的那几个字段**。
 *
 * ★ 与 {@link ToolTraceRecord} 的分工：那个是完整的落盘记录（导出 `.mmd` 用，
 *   带 `toolCallId` / `at` / `blockReason` / `errorMessage`）；这个是**界面快照**。
 *   排查用的字段不进界面：一张小卡片放不下，也容易夹带内部信息
 *   （轨迹是要拿去做汇报的，宁少勿滥）。
 *
 * ★ 定义放在**本文件**（而不是 IPC 层）：产生者是 Agent 运行时，
 *   IPC 层只是把它转给渲染进程。反过来定义会让「Agent 依赖 IPC」这种倒置的层次出现。
 */
export interface TraceRecordForUi {
  turn: number
  toolName: string
  argsSummary: string
  ok: boolean
  latencyMs: number
  /** 降级档位（`vector | cloud | fts | outline`）；认不出时省略。 */
  degraded?: string
}

/** 导出选项。 */
export interface TraceExportOptions {
  /** `.mmd` 落盘路径（默认 {@link resolveTracePath}）。 */
  outPath?: string
  /** 同时写一份带表格的 Markdown（默认同目录同名 `.md`）；传 `null` 关闭。 */
  markdownPath?: string | null
  meta?: ToolTraceMeta
  /** 仓库根（用于默认路径推断）。 */
  repoRoot?: string
}

/** Mermaid 文件里**唯一**允许的图表类型（保证渲染器认得）。 */
export const MERMAID_HEADER = 'flowchart TD'

/* ------------------------------------------------------------------ *
 * 参数摘要（★ 数据合规的关键一环）
 * ------------------------------------------------------------------ */

/** 敏感键：**绝不**出现在轨迹里（凭据、密钥、鉴权）。 */
const SENSITIVE_KEY = /(key|token|secret|password|passwd|credential|auth|cookie|signature)/i

/** 个人信息键：K12 场景一律不落盘（昵称、真实姓名、学生标识、联系方式）。 */
const PII_KEY = /(name|nickname|student|phone|mobile|email|idcard|address|birth)/i

/**
 * 可以原样显示的键：值本身是**短标识**（知识点 id、学段、题型…），不含自然语言与隐私。
 *
 * 用「归一化后的键名」比对（去掉 `_`/`-`/大小写差异），这样 `grade_level` 与 `gradeLevel`
 * 这类 camelCase / snake_case 混用不会漏掉 —— 漏掉的后果是轨迹里只剩「«文本 6 字»」，
 * 看不出到底调了哪个学段/哪个知识点，轨迹的价值就没了。
 */
const ID_LIKE_KEYS = new Set([
  'kpid',
  'chunkid',
  'qid',
  'id',
  'type',
  'level',
  'gradelevel',
  'count',
  'topk',
  'maxmastery',
  'maxresults',
  'attempt',
  'language',
  'mode',
  'source',
  'enabled',
  'allowcompat',
  'includeexpansion'
])

function isIdLikeKey(key: string): boolean {
  return ID_LIKE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
}

/** 短标识值的形状：只允许 ASCII 标识符风格（中文/空格/标点一律当文本处理）。 */
const SAFE_TOKEN_VALUE = /^[A-Za-z0-9_.:-]{1,32}$/

/** 单个值摘要的最大长度（超长只给长度，不给内容）。 */
const MAX_SUMMARY_CHARS = 48
/** 单次调用最多摘要几个键（其余只报个数）。 */
const MAX_SUMMARY_KEYS = 8

/** 一个值被隐去内容时的占位（明确写出「有多少」，既不泄内容又可判规模）。 */
function textPlaceholder(value: string): string {
  const lines = value.split('\n').length
  return lines > 1 ? `«文本 ${value.length} 字 / ${lines} 行»` : `«文本 ${value.length} 字»`
}

/**
 * 把一个参数值压成摘要。
 *
 * 规则（**白名单思路**：能显示什么由这里决定，而不是「除了敏感词都能显示」）：
 *   - 数字 / 布尔 / null → 原样（可以带小数的精度收敛）；
 *   - 字符串：键名是 id 类**且**值形如短标识 → 原样；否则只给长度；
 *   - 数组 / 对象 → 只给规模（`«数组 3 项»` / `«对象 2 字段»`）。
 */
function summarizeValue(key: string, value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (isIdLikeKey(key) && SAFE_TOKEN_VALUE.test(value)) return value
    return textPlaceholder(value)
  }
  if (Array.isArray(value)) return `«数组 ${value.length} 项»`
  if (typeof value === 'object') return `«对象 ${Object.keys(value as object).length} 字段»`
  return `«${typeof value}»`
}

/**
 * ★ 参数摘要：**唯一**允许进入轨迹文件的参数表示。
 *
 * - 不做「原始 JSON 截断」—— 截断只是让泄漏短一点，仍然是泄漏；
 * - 敏感键与个人信息键**连键名都不写**，只留 `«已省略(敏感)»`；
 * - 输出恒为单行、长度有上限，便于直接嵌进 Mermaid 标签与 Markdown 表格。
 */
export function summarizeArgs(args: unknown, options: { maxKeys?: number } = {}): string {
  if (args === undefined || args === null) return '(无参数)'
  if (typeof args !== 'object' || Array.isArray(args)) return summarizeValue('', args)

  const record = args as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length === 0) return '(无参数)'

  const maxKeys = options.maxKeys ?? MAX_SUMMARY_KEYS
  const parts: string[] = []
  for (const key of keys.slice(0, maxKeys)) {
    if (SENSITIVE_KEY.test(key)) {
      parts.push(`${key}=«已省略(敏感)»`)
      continue
    }
    if (PII_KEY.test(key)) {
      parts.push(`${key}=«已省略(个人信息)»`)
      continue
    }
    parts.push(`${key}=${summarizeValue(key, record[key])}`)
  }
  if (keys.length > maxKeys) parts.push(`…共 ${keys.length} 项`)
  const text = parts.join(', ')
  return text.length > MAX_SUMMARY_CHARS * 4 ? `${text.slice(0, MAX_SUMMARY_CHARS * 4)}…` : text
}

/* ------------------------------------------------------------------ *
 * 事件形状（Pi 原生事件的结构子集；不静态 import Pi 类型）
 * ------------------------------------------------------------------ */

/** `pi.on(...)` 的最小可用面（与 `pi-bootstrap.ts` 的写法一致，避免为一个类型拖入整个包）。 */
export interface TracePiApi {
  on(event: string, handler: (event: unknown, ctx?: unknown) => unknown): void
}

interface ToolCallLikeEvent {
  toolCallId?: string
  toolName?: string
  input?: Record<string, unknown>
}

interface ToolExecutionStartLikeEvent {
  toolCallId?: string
  toolName?: string
  args?: unknown
}

interface ToolExecutionEndLikeEvent {
  toolCallId?: string
  toolName?: string
  result?: unknown
  isError?: boolean
}

interface TurnStartLikeEvent {
  turnIndex?: number
}

/* ------------------------------------------------------------------ *
 * 采集器
 * ------------------------------------------------------------------ */

interface PendingCall {
  turn: number
  toolName: string
  argsSummary: string
  startedAt: number
}

/** `tool_call` 看到的「这条调用被谁拦了」（拦下后不会再有执行事件）。 */
interface PendingBlock {
  toolName: string
  reason?: string
}

/**
 * ★★ **轮次推进规则（纯函数，唯一的实现处，可直接单测）**。
 *
 * 为什么不能直接用 Pi 的 `turnIndex`（实测 0.85.1，读 `dist/core/agent-session.js` +
 * `@earendil-works/pi-agent-core/dist/agent-loop.js`）：
 *   - 每条学生消息都会重跑 `agent_start`，而它的分支里有一句 **`_turnIndex = 0`**；
 *   - 同一条学生消息里，模型每次发起工具调用之后还会再来一轮推理，每次都发 `turn_start`
 *     并把 `_turnIndex` 加一（0 → 1 → 2 …）。
 *   也就是说 `turnIndex` 是「**本条消息内的第几个 LLM 往返**」，**不是「第几次学生提问」**。
 *   旧实现直接采信它（还叠了个 `Math.max(1, index)`），于是两次 `session.prompt()` 之后
 *   `recorder.turn = 1`、`meta.turns = 1` —— 这份「设计合理性 25%」的核心证据**看不出
 *   「第 1 轮问了什么 → 调了 rag_search → 第 2 轮又调了什么」**（仓库里已导出的
 *   `docs/tool-trace.mmd` 正是「轮数：1｜调用：2 次」）。
 *
 * 规则（**回退/重复即新轮**，严格单调）：
 *   1. 第一次调用（`currentTurn === 0`）→ 第 1 轮；
 *   2. `index` **回退或与上次相同**（= 新一轮 `agent_start` 把下标重置回 0）→ `currentTurn + 1`；
 *   3. `index` **正常推进**（同一条学生消息里的第 2、3 个子回合）→ **轮次不变**，
 *      只更新下标 —— 这样「一次提问、两次工具调用」仍然画在同一块里；
 *   4. `index` 缺失 / 非有限数 → 按新的一轮算（信息不足时宁可多分块，也不能两张牌子叠在一起）。
 *
 * 返回值是两个数（`turn` 与新的 `lastIndex`），提醒调用方：**下标与轮次是两份状态**，
 * 混成一个字段就会退回「子回合被当成新轮」的老问题。
 */
export function nextTurnFor(
  currentTurn: number,
  lastTurnIndex: number,
  index: number
): { turn: number; lastIndex: number } {
  const numeric = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : undefined
  if (currentTurn === 0) return { turn: 1, lastIndex: numeric ?? 0 }
  if (numeric === undefined) return { turn: currentTurn + 1, lastIndex: lastTurnIndex }
  if (numeric <= lastTurnIndex) return { turn: currentTurn + 1, lastIndex: numeric }
  return { turn: currentTurn, lastIndex: numeric }
}

/**
 * 轨迹采集器。**纯内存**，没有任何副作用，随时可单测：
 * 灌入事件 → {@link records} / {@link toMermaid} / {@link renderMarkdown}。
 *
 * 用法（`runtime.ts` 接线）：
 * ```ts
 * const trace = new ToolTraceRecorder()
 * const resourceLoader = new DefaultResourceLoader({
 *   ...,
 *   extensionFactories: [createTraceExtension(trace), ...agentExtensions]
 * })
 * // 一轮结束或退出前：
 * exportToolTrace(trace, { repoRoot })
 * ```
 */
export class ToolTraceRecorder {
  private readonly items: ToolTraceRecord[] = []
  private readonly pending = new Map<string, PendingCall>()
  private readonly blocks = new Map<string, PendingBlock>()
  private currentTurn = 0
  /** 上一次看到的 Pi `turnIndex`（**子回合下标**，见 {@link nextTurnFor}）。 */
  private lastTurnIndex = -1
  private maxTurn = 0
  /** 记录序号（**落一条加一**，所以 Mermaid 的节点 id 天然唯一）。 */
  private recordSeq = 0

  /** 记录数（不含待配对的 start）。 */
  get size(): number {
    return this.items.length
  }

  /** 当前轮次（`turn_start` 未出现过时为 0，第一条记录会落到第 1 轮）。 */
  get turn(): number {
    return this.currentTurn
  }

  /**
   * 轮次切换（`turn_start`）。**只影响后续记录的 turn 字段**，不产生记录。
   *
   * 语义全在纯函数 {@link nextTurnFor} 里（可单测）：**回退/重复的 `turnIndex` 才算新的一轮
   * 学生提问**，同一轮里的第 2、3 个子回合（工具调用之后的再次推理）保持同一个轮号。
   * 这正是「轮次」在本文件里的含义 —— 轨迹图的每一块是**一次学生提问**，
   * 不是一次 LLM 往返。
   */
  noteTurn(index: number): void {
    const next = nextTurnFor(this.currentTurn, this.lastTurnIndex, index)
    this.currentTurn = next.turn
    this.lastTurnIndex = next.lastIndex
    this.maxTurn = Math.max(this.maxTurn, next.turn)
  }

  /**
   * `tool_call`（**执行前**的唯一钩子，也是安全阀的落点）。
   *
   * 这里只做两件事：记下参数摘要（执行事件里也能拿到，但被拦下的调用**只有**这里有）
   * 与记下拦截原因（`event.input` 是可变对象，本方法**绝不修改它**）。
   */
  noteToolCall(event: unknown): void {
    const payload = (event ?? {}) as ToolCallLikeEvent
    const toolCallId = String(payload.toolCallId ?? '')
    if (!toolCallId) return
    this.blocks.set(toolCallId, {
      toolName: String(payload.toolName ?? 'unknown'),
      reason: undefined
    })
    // 参数摘要用 `input`（tool_call 的形态）；执行事件里还有一份，二者取先到的那份。
    const summary = summarizeArgs(payload.input)
    if (!this.pending.has(toolCallId)) {
      this.pending.set(toolCallId, {
        turn: this.currentTurn,
        toolName: String(payload.toolName ?? 'unknown'),
        argsSummary: summary,
        startedAt: Number.NaN
      })
    } else {
      const existing = this.pending.get(toolCallId) as PendingCall
      if (existing.argsSummary === '(无参数)') existing.argsSummary = summary
    }
  }

  /** 记录安全阀的判定结果（`tool_call` 处理器返回 `{block, reason}` 时由调用方回填）。 */
  noteBlock(toolCallId: string, reason?: string): void {
    const block = this.blocks.get(toolCallId)
    if (block) block.reason = reason
    else this.blocks.set(toolCallId, { toolName: 'unknown', reason })
  }

  /** `tool_execution_start`：开一个计时窗口。 */
  noteToolStart(event: unknown): void {
    const payload = (event ?? {}) as ToolExecutionStartLikeEvent
    const toolCallId = String(payload.toolCallId ?? '')
    if (!toolCallId) return
    const existing = this.pending.get(toolCallId)
    this.pending.set(toolCallId, {
      turn: existing?.turn ?? this.currentTurn,
      toolName: String(payload.toolName ?? existing?.toolName ?? 'unknown'),
      argsSummary:
        existing && existing.argsSummary !== '(无参数)'
          ? existing.argsSummary
          : summarizeArgs(payload.args),
      startedAt: Date.now()
    })
  }

  /** `tool_execution_end`：**只读通知**，这里只读取结果，不改写任何东西。 */
  noteToolEnd(event: unknown): ToolTraceRecord | undefined {
    const payload = (event ?? {}) as ToolExecutionEndLikeEvent
    const toolCallId = String(payload.toolCallId ?? '')
    if (!toolCallId) return undefined
    const started = this.pending.get(toolCallId)
    this.pending.delete(toolCallId)
    const blocked = this.blocks.get(toolCallId)
    this.blocks.delete(toolCallId)

    const isError = payload.isError === true
    const selfReportedFailure = !toolResultOk(payload.result)
    const record: ToolTraceRecord = {
      seq: ++this.recordSeq,
      turn: started?.turn ?? this.currentTurn,
      toolName: String(payload.toolName ?? started?.toolName ?? blocked?.toolName ?? 'unknown'),
      toolCallId,
      argsSummary: started?.argsSummary ?? '(未捕获参数)',
      ok: !isError && !selfReportedFailure,
      latencyMs:
        started && Number.isFinite(started.startedAt) ? Math.max(0, Date.now() - started.startedAt) : 0,
      at: new Date().toISOString()
    }
    const degraded = degradedOf(payload.result)
    if (degraded) record.degraded = degraded
    if (!record.ok) record.errorMessage = errorMessageOf(payload.result)
    this.items.push(record)
    return record
  }

  /** 一条被安全阀拦下的调用也要留下痕迹（否则「模型想干什么」这段证据就丢了）。 */
  noteBlockedCall(toolCallId: string, toolName: string, reason?: string): ToolTraceRecord {
    const record: ToolTraceRecord = {
      seq: ++this.recordSeq,
      turn: this.currentTurn,
      toolName,
      toolCallId,
      argsSummary: this.pending.get(toolCallId)?.argsSummary ?? '(未捕获参数)',
      ok: false,
      latencyMs: 0,
      blocked: true,
      blockReason: reason ? truncate(reason, 80) : undefined,
      at: new Date().toISOString()
    }
    this.pending.delete(toolCallId)
    this.items.push(record)
    return record
  }

  /** 只读快照（返回副本，调用方改不动内部状态）。 */
  records(): ToolTraceRecord[] {
    return this.items.map((item) => ({ ...item }))
  }

  /** 丢弃全部记录（换学生 / 重开会话时用；**不落盘**）。 */
  reset(): void {
    this.items.length = 0
    this.pending.clear()
    this.blocks.clear()
    this.currentTurn = 0
    this.lastTurnIndex = -1
    this.maxTurn = 0
    this.recordSeq = 0
  }

  meta(extra: Partial<ToolTraceMeta> = {}): ToolTraceMeta {
    return {
      generatedAt: new Date().toISOString(),
      turns: Math.max(this.maxTurn, this.currentTurn, ...this.items.map((item) => item.turn), 0),
      ...extra
    }
  }

  /** 轨迹图（**纯 Mermaid**，可直接写进 `.mmd`）。 */
  toMermaid(): string {
    return renderMermaid(this.records(), this.meta())
  }

  /** 报告形态（Markdown + 内嵌 Mermaid + 明细表），可直接贴进报告素材。 */
  renderMarkdown(): string {
    return renderMarkdownReport(this.records(), this.meta())
  }
}

/** 从 Tool 结果里取降级档位（四种取值由契约冻结；取不到就不显示）。 */
export function degradedOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const record = result as Record<string, unknown>
  const candidates: unknown[] = [
    record.degraded,
    (record.details as Record<string, unknown> | undefined)?.degraded,
    (record.result as Record<string, unknown> | undefined)?.degraded
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && ['vector', 'cloud', 'fts', 'outline'].includes(value)) return value
  }
  return undefined
}

/**
 * Tool 的 `execute()` **自兜异常**时约定上报失败（而不是抛异常）。
 *
 * 认两种标记，因为仓库里两处都真实存在：
 *   - `details.error === true`（`runtime.ts` 的 `safeToolExecute` 与 `extensions/index.ts` 的
 *     `toolFailure()` 都用这个 —— `events.ts` 靠它发 `error` 事件）；
 *   - `details.ok === false`（更口语化的写法，同样认可）。
 *
 * 为什么需要这条约定：Pi 的 `isError` 只看「有没有抛」——`execute()` 把异常吞掉并返回可读文本后，
 * 事件层看到的仍是「成功」。轨迹图要如实反映失败，就必须认这个标记。
 * （本项目的 Tool 一律不抛：Pi 与 UI 同在主进程，抛出去会同时带走两者。）
 */
export function toolResultOk(result: unknown): boolean {
  if (!result || typeof result !== 'object') return true
  const details = (result as Record<string, unknown>).details
  if (!details || typeof details !== 'object') return true
  const record = details as Record<string, unknown>
  return record.ok !== false && record.error !== true
}

/** 从 Tool 结果里取**可读**错误信息（截断，绝不带堆栈与密钥）。 */
function errorMessageOf(result: unknown): string | undefined {
  if (typeof result === 'string') return truncate(result, 120)
  if (!result || typeof result !== 'object') return undefined
  const record = result as Record<string, unknown>
  const details = (record.details ?? {}) as Record<string, unknown>
  // 自兜异常约定：错误正文在 details.errorMessage（`safeToolExecute` / `toolFailure()`）
  if (typeof details.errorMessage === 'string') return truncate(details.errorMessage, 120)
  if (typeof details.error === 'string') return truncate(details.error, 120)
  if (typeof details.message === 'string') return truncate(details.message, 120)
  const content = record.content
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === 'object' ? (part as { text?: unknown }).text : undefined))
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
    if (text) return truncate(text, 120)
  }
  if (typeof record.error === 'string') return truncate(record.error, 120)
  if (typeof record.message === 'string') return truncate(record.message, 120)
  return undefined
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/* ------------------------------------------------------------------ *
 * 扩展：把三个事件接到采集器上
 * ------------------------------------------------------------------ */

/**
 * 轨迹扩展（**不是**六个业务 Extension 之一，属于基础设施；由 `runtime.ts` 单独挂上）。
 *
 * 订阅：
 *   - `turn_start`          → 轮次编号（只为了给记录标 turn，无副作用）
 *   - `tool_call`           → 参数摘要 + 安全阀留痕（**只读**，绝不改 `event.input`）
 *   - `tool_execution_start`→ 计时起点
 *   - `tool_execution_end`  → 落一条记录（**只读通知**，不回写结果）
 *
 * `agent_end` 不在这里导出文件：导出是**显式动作**（一轮结束或退出前调 `exportToolTrace`），
 * 免得每轮都写盘、也免得把「半截数据」写进交付物。
 */
export function createTraceExtension(
  recorder: ToolTraceRecorder,
  /**
   * 每记录一条就回调一次（可选）。主进程用它把**轨迹快照**推给渲染进程
   * （右栏「工具调用轨迹」）。传 `undefined` 时行为与改造前逐字一致。
   *
   * ★ 为什么是回调而不是让渲染进程来轮询：轨迹要**随着工具执行实时出现**，
   *   而轮询要么太慢（看不出一轮里有几次调用）要么太费（每 200ms 一次 IPC）。
   * ★ 回调里只给 `records()` 的副本，不给内部数组 —— 消费方改不动记录器。
   */
  onRecord?: (records: ToolTraceRecord[]) => void
): (pi: TracePiApi) => void {
  return (pi: TracePiApi): void => {
    pi.on('turn_start', (event: unknown) => {
      // ★ 原样把 `turnIndex` 交进去：**不能在调用点做「取 max」** ——
      //   它每轮都从 0 重开，回退本身就是「新的一轮学生提问」的信号（见 `noteTurn` 的说明）。
      //   `typeof index === 'number'` 只是把「缺字段」这一种形态交给 noteTurn 兜底。
      const index = (event as TurnStartLikeEvent).turnIndex
      recorder.noteTurn(typeof index === 'number' ? index : Number.NaN)
    })
    pi.on('tool_call', (event: unknown) => {
      recorder.noteToolCall(event)
      // ⚠️ 这里**不返回**任何值：安全阀在别处（票 22 的 tool_call 处理器）。
      //    本扩展只观察，不参与放行/拦截决策（同一事件的多个处理器互不可见返回值）。
    })
    pi.on('tool_execution_start', (event: unknown) => {
      recorder.noteToolStart(event)
    })
    pi.on('tool_execution_end', (event: unknown) => {
      const record = recorder.noteToolEnd(event)
      // 只有真的落了一条记录才推（`noteToolEnd` 缺 `toolCallId` 时返回 undefined，
      // 那时推一份没变化的快照没有意义）。
      if (record && onRecord) onRecord(recorder.records())
    })
  }
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

/** 轨迹文件的默认相对路径（执行文档 §9.4 第 4 条冻结）。 */
export const TRACE_RELATIVE_PATH = join('docs', 'tool-trace.mmd')

/**
 * 默认落盘路径：`<repoRoot>/docs/tool-trace.mmd`。
 *
 * `docs/` 属文档轨（本模块只**写文件**，绝不改仓库里的其它内容）。
 * 打包产物里不存在 `docs/`，所以调用方**必须**给 `repoRoot`（开发态）或显式 `outPath`。
 */
export function resolveTracePath(options: { repoRoot?: string; outPath?: string } = {}): string {
  if (options.outPath) return resolve(options.outPath)
  const root = options.repoRoot ?? process.cwd()
  return resolve(root, TRACE_RELATIVE_PATH)
}

/** Mermaid 标签转义：引号/尖括号/括号会把图渲染坏，统一换成 Mermaid 实体。 */
export function escapeMermaidLabel(text: string): string {
  const entities: Array<[RegExp, string]> = [
    [/"/g, '#quot;'],
    [/</g, '#lt;'],
    [/>/g, '#gt;'],
    [/\[/g, '#91;'],
    [/\]/g, '#93;'],
    [/\{/g, '#123;'],
    [/}/g, '#125;'],
    [/\(/g, '#40;'],
    [/\)/g, '#41;'],
    [/\|/g, '#124;'],
    [/\r?\n/g, ' ']
  ]
  let out = text
  for (const [pattern, replacement] of entities) out = out.replace(pattern, replacement)
  return out
}

/** Markdown 表格单元格转义（`|` 与换行会把表格切碎）。 */
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** 节点 id 必须只含 `[A-Za-z0-9_]`（Mermaid 对 id 的字符集限制）。 */
function nodeId(prefix: string, ...parts: Array<string | number>): string {
  const tail = parts
    .map((part) => String(part).replace(/[^A-Za-z0-9_]/g, '_'))
    .join('_')
  return `${prefix}${tail}`
}

/**
 * ★ 轨迹图：**真 Mermaid**（`flowchart TD`），按轮次分块、按调用顺序连线。
 *
 * 之所以不是「一张汇总表」：这条链路的存在意义就是**展示 LLM 的路由决策**，
 * 所以图里必须能看出「第 1 轮问了什么 → 调了 rag_search → 又调了 generate_quiz → 回复」，
 * 以及每次调用是否失败 / 耗时 / 降级 —— 这正是演示现场要指给验收方看的东西。
 */
export function renderMermaid(records: ToolTraceRecord[], meta: ToolTraceMeta): string {
  const lines: string[] = []
  lines.push(MERMAID_HEADER)
  lines.push('  %% 由 desktop/src/main/agent/trace.ts 自动生成，请勿手改')
  lines.push(`  %% 生成时间：${meta.generatedAt}｜轮数：${meta.turns}｜调用：${records.length} 次`)
  lines.push('  %% 参数只记摘要（不含原文 / 密钥 / 学生个人信息）')
  lines.push('  classDef turn fill:#e3f2fd,stroke:#1565c0,stroke-width:1px,color:#0d47a1')
  lines.push('  classDef ok fill:#e8f5e9,stroke:#2e7d32,stroke-width:1px,color:#1b5e20')
  lines.push('  classDef fail fill:#ffebee,stroke:#c62828,stroke-width:1px,color:#b71c1c')
  lines.push('  classDef blocked fill:#fff8e1,stroke:#f9a825,stroke-width:1px,color:#795548')

  if (records.length === 0) {
    lines.push('  EMPTY["尚无工具调用<br/>（跑一轮含 rag_search / generate_quiz 的对话后重新导出）"]:::turn')
    return `${lines.join('\n')}\n`
  }

  const byTurn = new Map<number, ToolTraceRecord[]>()
  for (const record of records) {
    const list = byTurn.get(record.turn) ?? []
    list.push(record)
    byTurn.set(record.turn, list)
  }

  for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
    const list = byTurn.get(turn) as ToolTraceRecord[]
    const start = nodeId('T', turn, 'START')
    const end = nodeId('T', turn, 'END')
    lines.push(`  ${start}(["第 ${turn} 轮 · 学生提问"]):::turn`)

    let previous = start
    for (const record of list) {
      const node = nodeId('T', turn, 'C', record.seq)
      const cls = record.blocked ? 'blocked' : record.ok ? 'ok' : 'fail'
      const outcome = record.blocked ? 'blocked' : record.ok ? 'ok' : 'error'
      const extras = [outcome, `${record.latencyMs}ms`, record.degraded ? `degraded:${record.degraded}` : '']
        .filter((part) => part.length > 0)
        .join(' · ')
      // ⚠️ 只转义**参数摘要**：`<br/>` 是我们要的换行，被一起转义就没有多行标签了。
      const label = `${escapeMermaidLabel(record.toolName)}<br/>${extras}<br/>${escapeMermaidLabel(record.argsSummary)}`
      lines.push(`  ${previous} --> ${node}["${label}"]:::${cls}`)
      previous = node
    }
    lines.push(`  ${previous} --> ${end}(["第 ${turn} 轮 · 回复学生"]):::turn`)
  }

  return `${lines.join('\n')}\n`
}

/** Markdown 报告：抬头 + 内嵌 Mermaid + 明细表（报告素材可直接引用）。 */
export function renderMarkdownReport(records: ToolTraceRecord[], meta: ToolTraceMeta): string {
  const lines: string[] = []
  lines.push('# 工具调用轨迹（自动导出）')
  lines.push('')
  lines.push(
    '> 由 `desktop/src/main/agent/trace.ts` 从 Pi 的 `tool_call` / `tool_execution_start` / ' +
      '`tool_execution_end` 事件导出。**本文件替代原方案的 LangGraph 状态流转图**（执行文档 §9.4 第 4 条）。'
  )
  lines.push(
    '> 参数只记摘要：键名 + 规模（`«文本 12 字»`），密钥与个人信息类键一律省略 —— ' +
      '轨迹图是要进报告与汇报 PPT 的，不落原始输入是数据合规要求。'
  )
  lines.push('')
  lines.push(`- 生成时间：${meta.generatedAt}`)
  lines.push(`- 轮数：${meta.turns}`)
  lines.push(`- Tool 调用次数：${records.length}`)
  if (meta.model) lines.push(`- 模型：${meta.model}`)
  lines.push('')
  lines.push('```mermaid')
  lines.push(renderMermaid(records, meta).trimEnd())
  lines.push('```')
  lines.push('')
  lines.push('## 调用明细')
  lines.push('')
  lines.push('| # | 轮次 | Tool | 参数摘要 | 结果 | 耗时 | 降级 | 备注 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  if (records.length === 0) {
    lines.push('| — | — | — | — | — | — | — | 尚无工具调用 |')
  }
  for (const record of records) {
    lines.push(
      `| ${record.seq} | ${record.turn} | ${escapeTableCell(record.toolName)} | ` +
        `${escapeTableCell(record.argsSummary)} | ${record.blocked ? 'blocked' : record.ok ? 'ok' : 'error'} | ` +
        `${record.latencyMs}ms | ${record.degraded ?? '—'} | ` +
        `${escapeTableCell(record.blockReason ?? record.errorMessage ?? '')} |`
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * 落盘：写 `.mmd`（纯 Mermaid，GitHub / VS Code 直接渲染）+ 可选 `.md`（带明细表）。
 *
 * 返回实际写入的路径，便于调用方打印证据（冒烟脚本与测试都要拿它）。
 */
export function exportToolTrace(
  recorder: ToolTraceRecorder,
  options: TraceExportOptions = {}
): { mmdPath: string; markdownPath?: string; records: number } {
  const mmdPath = resolveTracePath({ repoRoot: options.repoRoot, outPath: options.outPath })
  const records = recorder.records()
  const meta = recorder.meta(options.meta ?? {})

  mkdirSync(dirname(mmdPath), { recursive: true })
  writeFileSync(mmdPath, renderMermaid(records, meta), 'utf8')

  const markdownPath =
    options.markdownPath === null
      ? undefined
      : options.markdownPath ?? mmdPath.replace(/\.mmd$/i, '.md')
  if (markdownPath) {
    mkdirSync(dirname(markdownPath), { recursive: true })
    writeFileSync(markdownPath, renderMarkdownReport(records, meta), 'utf8')
  }
  return { mmdPath, markdownPath, records: records.length }
}

/* ------------------------------------------------------------------ *
 * CLI：`node src/main/agent/trace.ts [--out <path>] [--demo]`
 *
 * ★ 本文件**不依赖任何 Pi / Electron 符号**，所以能直接跑：这样「导出轨迹」既能被主进程调用，
 *   也能在验收时用一条命令复现（不需要起 GUI、不需要 Key）。
 * ------------------------------------------------------------------ */

/**
 * 合成一段调用序列（两轮：`rag_search` 降级 FTS、`generate_quiz`、一次失败的画像读取）。
 *
 * 用途有两个，都是**验收**用途，不是产品路径：
 *   - 单测里验证导出链路（不经模型、不经 Pi，确定性地跑）；
 *   - CLI `--demo` 时生成一份可渲染的样例图（无 Key、无 GUI 也能出证据）。
 */
export function demoRecorder(): ToolTraceRecorder {
  const recorder = new ToolTraceRecorder()
  // ⚠️ 参数是 Pi 的 `turnIndex`（**一条学生消息内的 sub-turn 下标**），不是「第几轮」。
  //    它每条消息都从 0 重开，所以「第二次传 0」才是「第二条学生消息」的真机形态
  //    （`dist/core/agent-session.js:470` 在 `agent_start` 里重置它）。
  //    这里照真机传，样例图的轮次才是产品里真实会出现的样子。
  recorder.noteTurn(0)
  recorder.noteToolCall({
    toolCallId: 'c1',
    toolName: 'rag_search',
    input: { query: '什么是循环？', gradeLevel: 'junior' }
  })
  recorder.noteToolStart({
    toolCallId: 'c1',
    toolName: 'rag_search',
    args: { query: '什么是循环？', gradeLevel: 'junior' }
  })
  recorder.noteToolEnd({ toolCallId: 'c1', toolName: 'rag_search', isError: false, result: { degraded: 'fts' } })

  recorder.noteToolCall({ toolCallId: 'c2', toolName: 'generate_quiz', input: { kp_id: 'jr-py-loop', count: 2 } })
  recorder.noteToolStart({ toolCallId: 'c2', toolName: 'generate_quiz', args: { kp_id: 'jr-py-loop', count: 2 } })
  recorder.noteToolEnd({ toolCallId: 'c2', toolName: 'generate_quiz', isError: false, result: {} })

  // 第二条学生消息：Pi 把 `turnIndex` 重置回 0
  recorder.noteTurn(0)
  recorder.noteToolCall({ toolCallId: 'c3', toolName: 'get_student_profile', input: { student_name: '小明' } })
  recorder.noteToolStart({ toolCallId: 'c3', toolName: 'get_student_profile', args: { student_name: '小明' } })
  recorder.noteToolEnd({
    toolCallId: 'c3',
    toolName: 'get_student_profile',
    isError: true,
    result: 'sidecar 尚未就绪（无端口与 token）'
  })
  return recorder
}

function isMainModule(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/')
  return entry.endsWith('agent/trace.ts') || entry.endsWith('agent/trace.js')
}

if (isMainModule()) {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined
  const repoIndex = args.indexOf('--repo-root')
  const repoRoot = repoIndex >= 0 ? args[repoIndex + 1] : undefined
  const recorder = args.includes('--demo') ? demoRecorder() : new ToolTraceRecorder()
  const written = exportToolTrace(recorder, { outPath, repoRoot })
  process.stdout.write(
    `轨迹已导出：${written.mmdPath}（${written.records} 条）` +
      `${written.markdownPath ? `\nMarkdown：${written.markdownPath}` : ''}\n`
  )
}
