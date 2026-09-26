/**
 * 轮次诊断信封的**采集与缓存**（主进程侧）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 分工（三件事，一个地方）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① {@link TurnDiagnosticsRecorder}：把**一轮**里散在各处的机制数据收拢成一份信封
 *      （纯内存、无 IO、可直接单测）；
 *   ② {@link DiagnosticsStore}：最近 {@link DIAGNOSTICS_TURN_LIMIT} 轮的环形缓冲
 *      + 脱敏 JSONL 落盘 + 启动暖机 + 一键清空；
 *   ③ {@link stripForPersistence} / {@link redactHostPaths}：**两条不同的脱敏**——
 *      前者管「什么不许落盘」（正文一律不落），后者管「上屏前把本机路径抹掉」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么落盘的那份和界面看到的那份**不是同一份**
 * ══════════════════════════════════════════════════════════════════════════
 * 演示要看到「学生输入了什么、Prompt 长什么样、画像块是什么」，但**这些都不许留在磁盘上**
 * （与「SQLite 不存对话正文」是同一条纪律）。所以：
 *   · 推给界面的 = 完整信封（含正文），**只在内存里**；
 *   · 落到 JSONL 的 = {@link stripForPersistence} 之后的信封：
 *     正文 / 画像块 / Prompt 原文 / 检索词 / 模型推理**全部置空**，
 *     只留长度、哈希、计数、工具名、档位、结论这些**结构性证据**。
 * 于是重启后回放看到的是「结构与结论还在、正文不在了」——这是**刻意的**，
 * 不是丢了数据（对话正文的唯一真相是 Pi 的会话 JSONL）。
 *
 * ⚠️ 本文件只在主进程加载（跑 fs 与 crypto）。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DIAGNOSTICS_TURN_LIMIT,
  isTurnDiagnostics,
  type DiagGrade,
  type DiagInterception,
  type DiagPromptOverride,
  type DiagPromptSegment,
  type DiagRetrieval,
  type DiagRetrievalLevel,
  type DiagSafetyStage,
  type DiagnosticsSnapshot,
  type GradeLevel,
  type TurnDiagnostics
} from '@shared/diagnostics'
import { GRADE_OVERRIDE_HEADING } from './extensions/grade.ts'
import { STUDENT_CONTEXT_HEADING } from './prompts/student-context.ts'

/** 落盘文件名（在学生的 `pi-agent/logs/` 下，与 `chat-system-prompt.txt` 同目录）。 */
export const DIAGNOSTICS_FILE_NAME = 'turn-diagnostics.jsonl'

/** 展示用文本的单段截断长度（信封里保留原文，界面上按需展开；太长的段先截）。 */
const SEGMENT_DISPLAY_CHARS = 1600

/**
 * token 估算：中文按 **1 字 ≈ 0.6 token**（本项目 prompt 以中文为主）。
 *
 * ★ 它只用来展示「各段相对体量」（哪一段占得多），**不是计费口径** ——
 *   真正的 token 数只有供应商知道。界面上必须按「估算」呈现，不许写成精确值。
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.max(1, Math.round(text.length * 0.6))
}

/** 十二位十六进制字节指纹（画像块的「逐字节稳定」判据）。 */
export function byteHash(text: string): string {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex').slice(0, 12)
}

/**
 * 上屏前抹掉本机路径。
 *
 * ★ 与 `findHostPathLeaks` 的分工：那个是**断言**（不许有），这个是**兜底**（万一有，
 *   上屏前先换掉）。两道都要有：断言保证「正常情况下干净」，替换保证「异常时也不投屏」。
 */
export function redactHostPaths(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .replace(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'`，。；）)】]*/g, '«本机路径»')
    .replace(/\\\\[A-Za-z0-9._-]+\\[^\s"'`，。；）)】]*/g, '«本机路径»')
    .replace(/\/(?:home|Users)\/[A-Za-z0-9._-]+[^\s]*/g, '«本机路径»')
}

/** 按行首 Markdown 标题切段（拿不到标题的整块作为一段）。 */
function splitByHeadings(text: string): Array<{ label: string; body: string }> {
  const out: Array<{ label: string; body: string }> = []
  const lines = text.split('\n')
  let label = '正文'
  let buffer: string[] = []
  for (const line of lines) {
    const heading = /^\s{0,3}(#{1,4})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (buffer.some((item) => item.trim() !== '')) out.push({ label, body: buffer.join('\n') })
      label = heading[2].trim()
      buffer = [line]
      continue
    }
    buffer.push(line)
  }
  if (buffer.some((item) => item.trim() !== '')) out.push({ label, body: buffer.join('\n') })
  return out
}

/**
 * 把拼好的 system prompt 切成可展示的段。
 *
 * 结构与 `buildSystemPrompt()` 的组装顺序一致（**不猜**）：
 *   `[学段模板（静态七段）] + [学生画像块] + [学段权威段（恒追加）]`。
 * 学段模板那一半再按行首标题细分，所以界面上能看到「七段」的实际分布。
 */
export function segmentPrompt(prompt: string): DiagPromptSegment[] {
  const text = typeof prompt === 'string' ? prompt : ''
  if (text.trim() === '') return []
  const parts: Array<{ id: string; label: string; body: string }> = []

  const contextAt = text.indexOf(STUDENT_CONTEXT_HEADING)
  const gradeAt = text.lastIndexOf(GRADE_OVERRIDE_HEADING)
  const headEnd = Math.min(
    contextAt >= 0 ? contextAt : text.length,
    gradeAt >= 0 ? gradeAt : text.length
  )
  const head = text.slice(0, headEnd).trim()
  if (head !== '') {
    for (const [index, part] of splitByHeadings(head).entries()) {
      parts.push({ id: `grade-${index + 1}`, label: part.label, body: part.body })
    }
  }
  if (contextAt >= 0) {
    const end = gradeAt > contextAt ? gradeAt : text.length
    parts.push({ id: 'student-context', label: '学生画像（本轮注入）', body: text.slice(contextAt, end).trim() })
  }
  if (gradeAt >= 0) {
    parts.push({ id: 'grade-authority', label: '学段权威段（恒追加）', body: text.slice(gradeAt).trim() })
  }

  return parts
    .filter((part) => part.body !== '')
    .map((part) => {
      const chars = part.body.length
      const display = redactHostPaths(part.body)
      return {
        id: part.id,
        label: part.label,
        tokens: estimateTokens(part.body),
        chars,
        text: display.length > SEGMENT_DISPLAY_CHARS ? display.slice(0, SEGMENT_DISPLAY_CHARS) : display,
        truncated: display.length > SEGMENT_DISPLAY_CHARS
      }
    })
}

/** 学段观察的快照来源（`gradeExtension.snapshot()` 的子集，避免这里 import 那个模块）。 */
export interface GradeSnapshotLike {
  turn: number
  appliedGrade: GradeLevel
  pendingGrade: GradeLevel | null
  layer2: string
  cumulativeTurns: number
  decidedBy: string | null
  lastReason: string
  cooldownRemainingTurns: number
}

/** 输入侧安全判定的形状（`SafetyVerdict` 的子集）。 */
export interface InputSafetyLike {
  allowed: boolean
  category?: string
  source?: string
  matched?: readonly string[]
}

/** 工具记录的形状（`ToolTraceRecord` 的子集）。 */
export interface ToolRecordLike {
  turn: number
  toolName: string
  ok: boolean
  latencyMs: number
  degraded?: string
}

/**
 * 一轮的诊断信封采集器。
 *
 * ★ 生命周期与 `runTurn()` 一致：`new` → 各处 `note*()` → `finish()`。
 *   `finish()` **幂等**（第二次调用返回同一份对象），因为它会被 done 分支与异常分支都碰到。
 */
export class TurnDiagnosticsRecorder {
  private readonly envelope: TurnDiagnostics
  private readonly startedAt: number
  private firstTokenAt: number | null = null
  private rawThinking = ''
  /** 这一轮有没有出现过**终态**的供应商错误（`message_update.error` / 重试彻底失败）。 */
  private providerError = false

  constructor(fields: {
    turn: number
    requestId: string
    text: string
    gradeLevel: GradeLevel
    grade?: GradeSnapshotLike
    at?: number
  }) {
    this.startedAt = fields.at ?? Date.now()
    this.envelope = {
      turn: fields.turn,
      requestId: fields.requestId,
      at: this.startedAt,
      input: { text: typeof fields.text === 'string' ? fields.text : '', safetyInput: { verdict: 'pass' } },
      grade: emptyGrade(fields.gradeLevel, fields.grade),
      prompt: { chars: 0, totalTokens: 0, gradeTemplate: fields.gradeLevel, segments: [], overrides: [], hostPathClean: true },
      studentContext: { injected: false, chars: 0, byteHash: '', sameAsPrev: false, text: '', truncated: false },
      reasoning: { available: false, filtered: '', note: '本轮没有拿到模型推理增量。' },
      tools: [],
      retrieval: null,
      safetyFinal: {
        stages: [
          { stage: 'input', verdict: 'skipped' },
          { stage: 'stream', verdict: 'skipped' },
          { stage: 'final', verdict: 'skipped' }
        ],
        finalizations: 0,
        retractions: 0,
        bufferedChars: 0
      },
      interceptions: [],
      done: { ok: false, status: 'running', totalMs: 0, firstTokenMs: null }
    }
  }

  /** 输入侧安全预检的结论（**在发起模型调用之前**）。 */
  noteInputSafety(verdict: InputSafetyLike | null): void {
    if (!verdict) {
      this.stage('input', 'skipped')
      return
    }
    if (verdict.allowed) {
      this.envelope.input.safetyInput = { verdict: 'pass' }
      this.stage('input', 'pass')
      return
    }
    const reason = [verdict.category, verdict.source].filter((item) => typeof item === 'string' && item !== '').join(' · ')
    this.envelope.input.safetyInput = { verdict: 'blocked', ...(reason ? { reason } : {}) }
    this.stage('input', 'blocked', reason)
    this.noteInterception({
      source: '内容安全 · 入口预检',
      reason: '输入命中安全规则，这一轮**没有发给模型**',
      ...(reason ? { detail: reason } : {})
    })
  }

  /** 学段观察（这一轮按谁的话作答）。 */
  noteGrade(snapshot: GradeSnapshotLike): void {
    this.envelope.grade = emptyGrade(snapshot.appliedGrade, snapshot)
    if (snapshot.cooldownRemainingTurns > 0) {
      this.noteInterception({
        source: '学段 · 冷却窗口',
        reason: `学生手动指定学段后仍在冷却期内，还剩 ${snapshot.cooldownRemainingTurns} 轮不接受自动调整`,
        detail: `本轮生效：${snapshot.appliedGrade}`
      })
    }
  }

  /** Prompt 拼装结果（三段结构 + 三道运行时注入）。 */
  notePrompt(input: {
    prompt: string
    gradeTemplate: GradeLevel
    hostPathClean: boolean
    overrides: DiagPromptOverride[]
  }): void {
    const segments = segmentPrompt(input.prompt)
    this.envelope.prompt = {
      chars: input.prompt.length,
      totalTokens: estimateTokens(input.prompt),
      gradeTemplate: input.gradeTemplate,
      segments,
      overrides: input.overrides,
      hostPathClean: input.hostPathClean
    }
  }

  /** 学生画像块（逐字节稳定性）。 */
  noteStudentContext(block: string, previousHash: string): void {
    const text = typeof block === 'string' ? block : ''
    const hash = text.trim() === '' ? '' : byteHash(text)
    this.envelope.studentContext = {
      injected: hash !== '',
      chars: text.length,
      byteHash: hash,
      sameAsPrev: hash !== '' && hash === previousHash,
      text: text.length > SEGMENT_DISPLAY_CHARS ? redactHostPaths(text.slice(0, SEGMENT_DISPLAY_CHARS)) : redactHostPaths(text),
      truncated: text.length > SEGMENT_DISPLAY_CHARS
    }
  }

  /** 模型推理增量（Pi 的 `thinking_*` 事件；拿不到就一直是空）。 */
  noteThinkingDelta(delta: string): void {
    if (typeof delta !== 'string' || delta.length === 0) return
    // 上限只是防内存无界增长（防御性）；超出的部分丢掉
    if (this.rawThinking.length < 20_000) this.rawThinking += delta
  }

  /** 首个文本增量到达的时刻（首字延迟）。 */
  noteFirstToken(): void {
    if (this.firstTokenAt === null) this.firstTokenAt = Date.now()
  }

  /**
   * 记一次终态供应商错误。
   *
   * ★ 为什么要单独记：收尾那段代码在 `gate.settled()` 之后才跑，**看不到**本轮是怎么结束的
   *   （终态 `error` 与正常 `done` 在门那一层都只是「本轮结束了」）。没有这个标记，
   *   一次供应商故障会在演示页上被写成 `ok` —— 那正是「承诺文案不得超出实际行为」要拦的东西。
   */
  noteProviderError(): void {
    this.providerError = true
  }

  /** 这一轮有没有出现过终态供应商错误。 */
  get hasProviderError(): boolean {
    return this.providerError
  }

  /** 这一轮的工具调用（`records` 由调用方按轮次窗口筛好）。 */
  noteTools(records: readonly ToolRecordLike[]): void {
    this.envelope.tools = records.map((record, index) => ({
      seq: index + 1,
      name: record.toolName,
      ok: record.ok,
      latencyMs: record.latencyMs,
      ...(typeof record.degraded === 'string' && record.degraded !== '' ? { degraded: record.degraded } : {})
    }))
  }

  /** 检索轨迹（`null` = 这一轮没查教材）。 */
  noteRetrieval(retrieval: DiagRetrieval | null): void {
    if (!retrieval) return
    this.envelope.retrieval = {
      ...retrieval,
      query: redactHostPaths(retrieval.query),
      levels: retrieval.levels.map((level) => ({ ...level }))
    }
  }

  /** 生成侧终审的计数与结论。 */
  noteSafetyFinal(input: {
    finalizations: number
    retractions: number
    bufferedChars: number
    streamed?: boolean
  }): void {
    this.envelope.safetyFinal = {
      ...this.envelope.safetyFinal,
      finalizations: input.finalizations,
      retractions: input.retractions,
      bufferedChars: input.bufferedChars
    }
    if (input.streamed === true) this.stage('stream', 'pass')
    if (input.retractions > 0) {
      this.stage('final', 'blocked', '整段回答被终审撤回')
      this.noteInterception({
        source: '内容安全 · 生成侧终审',
        reason: '正文已经流式显示过，终审判定违规后整段撤回',
        detail: `${input.retractions} 次撤回 / 缓冲 ${input.bufferedChars} 字符`
      })
    } else if (input.finalizations > 0) {
      this.stage('final', 'pass')
    }
  }

  /** 一条拦截记录（各机制的拒绝分支统一写这里）。 */
  noteInterception(entry: DiagInterception): void {
    if (typeof entry.source !== 'string' || entry.source === '') return
    if (this.envelope.interceptions.some((item) => item.source === entry.source && item.reason === entry.reason)) return
    this.envelope.interceptions.push({ ...entry, ...(entry.detail ? { detail: redactHostPaths(entry.detail) } : {}) })
  }

  /** 收尾：结论 + 时序 + 推理过滤。 */
  finish(input: { ok: boolean; status: string }): TurnDiagnostics {
    this.envelope.done = {
      ok: input.ok,
      status: input.status,
      totalMs: Math.max(0, Date.now() - this.startedAt),
      firstTokenMs: this.firstTokenAt === null ? null : Math.max(0, this.firstTokenAt - this.startedAt)
    }
    this.envelope.reasoning = filterReasoning(this.rawThinking)
    return this.envelope
  }

  /** 只给测试用：拿到当前（可能还没 finish 的）信封。 */
  current(): TurnDiagnostics {
    return this.envelope
  }

  private stage(stage: DiagSafetyStage['stage'], verdict: DiagSafetyStage['verdict'], reason?: string): void {
    this.envelope.safetyFinal.stages = this.envelope.safetyFinal.stages.map((item) =>
      item.stage === stage ? { stage, verdict, ...(reason ? { reason } : {}) } : item
    )
  }
}

function emptyGrade(applied: GradeLevel, snapshot?: GradeSnapshotLike): DiagGrade {
  return {
    applied: snapshot?.appliedGrade ?? applied,
    decidedBy: snapshot?.decidedBy ?? null,
    layer2: snapshot?.layer2 ?? 'not_due',
    pending: snapshot?.pendingGrade ?? null,
    cumulativeTurns: snapshot?.cumulativeTurns ?? 0,
    cooldownRemainingTurns: snapshot?.cooldownRemainingTurns ?? 0,
    note: typeof snapshot?.lastReason === 'string' ? snapshot.lastReason : ''
  }
}

/**
 * 模型推理的**过滤层**。
 *
 * ★ 纪律（报告第 8 节）：**整段替换，不是打码**。只要这段推理里出现本机路径、
 *   凭证形状或用户名，就整段丢掉并换一句话说清为什么 —— 局部遮盖会给人
 *   「其余部分已经检查过」的错觉，而事实上没人能保证剩下的部分是干净的。
 * ★ 默认折叠由界面负责；**不落盘**由 `stripForPersistence` 负责。
 */
export function filterReasoning(raw: string): TurnDiagnostics['reasoning'] {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { available: false, filtered: '', note: '本轮没有拿到模型推理增量。' }
  const risky = /(api[_-]?key|sk-[A-Za-z0-9]{8,}|Bearer\s+\S+|password|密码|密钥)/i.test(text)
  const pathLike = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+\\|\/(?:home|Users)\//i.test(text)
  if (risky || pathLike) {
    return {
      available: false,
      filtered: '',
      note: '本轮推理内容里出现了敏感形状（凭证或本机路径），按纪律**整段丢弃**，不做局部遮盖。'
    }
  }
  return {
    available: true,
    filtered: redactHostPaths(text.length > 4000 ? `${text.slice(0, 4000)}…` : text),
    note: '模型思考增量（默认折叠；不落盘、不进对话）。'
  }
}

/**
 * 落盘前的剥离：正文一律置空，只留长度 / 哈希 / 计数 / 结论。
 *
 * ★ 返回**深拷贝**（不就地改内存里那份，界面还要用完整版）。
 */
export function stripForPersistence(turn: TurnDiagnostics): TurnDiagnostics {
  return {
    ...turn,
    input: { text: '', safetyInput: { ...turn.input.safetyInput } },
    prompt: {
      ...turn.prompt,
      segments: turn.prompt.segments.map((segment) => ({ ...segment, text: '' }))
    },
    studentContext: { ...turn.studentContext, text: '' },
    reasoning: { ...turn.reasoning, filtered: '' },
    retrieval: turn.retrieval
      ? { ...turn.retrieval, query: '', levels: turn.retrieval.levels.map((level) => ({ ...level })) }
      : null,
    tools: turn.tools.map((tool) => ({ ...tool })),
    safetyFinal: { ...turn.safetyFinal, stages: turn.safetyFinal.stages.map((stage) => ({ ...stage })) },
    interceptions: turn.interceptions.map((item) => ({ ...item })),
    grade: { ...turn.grade },
    done: { ...turn.done }
  }
}

/**
 * 最近 N 轮的信封缓存 + 脱敏 JSONL。
 *
 * ★ 轮次号由 `beginTurn()` 发号（**跨重启单调**：暖机后从磁盘上最大轮次继续），
 *   所以「输入被拦下、根本没走到 LLM」的那一轮也有自己的号，不会与下一轮撞车。
 * ★ 所有磁盘操作都在 try/catch 里：诊断是**旁路**，它坏掉绝不该影响对话。
 */
export class DiagnosticsStore {
  private readonly limit: number
  private readonly filePath: string
  private turns: TurnDiagnostics[] = []
  private nextTurn = 1
  private persisted = false

  constructor(options: { filePath: string; limit?: number }) {
    this.filePath = options.filePath
    this.limit = options.limit ?? DIAGNOSTICS_TURN_LIMIT
  }

  /** 下一位轮次号（每轮开始时调用一次）。 */
  beginTurn(): number {
    return this.nextTurn
  }

  /**
   * 收下一轮的信封：进内存环形缓冲（**完整版**）、落盘（**脱敏版**）、推进轮次号。
   */
  append(turn: TurnDiagnostics): void {
    this.turns.push(turn)
    if (this.turns.length > this.limit) this.turns = this.turns.slice(-this.limit)
    this.nextTurn = Math.max(this.nextTurn, turn.turn) + 1
    this.writeLine(stripForPersistence(turn))
  }

  /** 当前快照（轮次升序）。 */
  snapshot(): DiagnosticsSnapshot {
    return {
      turns: this.turns.map((turn) => turn),
      limit: this.limit,
      persisted: this.persisted,
      updatedAt: Date.now()
    }
  }

  /** 清空（内存 + 磁盘，幂等）。 */
  clear(): DiagnosticsSnapshot {
    this.turns = []
    this.persisted = false
    try {
      rmSync(this.filePath, { force: true })
    } catch {
      /* 清不掉只是下次启动会读回旧记录，不影响本次演示 */
    }
    return this.snapshot()
  }

  /**
   * 启动暖机：把上次落盘的记录读回环形缓冲。
   *
   * ★ 读回来的那份是**脱敏版**（正文本来就是空的），所以界面上会如实看到
   *   「结构与结论在、正文不在」——这是刻意的。
   * ★ 坏行直接跳过（半行 JSON 不该让整次启动失败）。
   */
  warmup(): number {
    try {
      if (!existsSync(this.filePath)) return 0
      const lines = readFileSync(this.filePath, 'utf8').split('\n')
      const restored: TurnDiagnostics[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (isTurnDiagnostics(parsed)) restored.push(parsed)
        } catch {
          /* 半行 / 坏行：跳过 */
        }
      }
      if (restored.length === 0) return 0
      this.turns = restored.slice(-this.limit)
      this.persisted = true
      this.nextTurn = this.turns.reduce((max, turn) => Math.max(max, turn.turn), 0) + 1
      return this.turns.length
    } catch {
      return 0
    }
  }

  /** 磁盘上有没有记录（界面上标「这份是重启前留下的」）。 */
  get fromDisk(): boolean {
    return this.persisted
  }

  private writeLine(turn: TurnDiagnostics): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      appendFileSync(this.filePath, `${JSON.stringify(turn)}\n`, 'utf8')
      // 文件按环形上限**截断重写**：条数是几十，重写的代价远低于「无界增长」
      if (this.turns.length >= this.limit) {
        const lines = this.turns.map((item) => JSON.stringify(stripForPersistence(item)))
        writeFileSync(this.filePath, `${lines.join('\n')}\n`, 'utf8')
      }
    } catch {
      /* 落盘失败只影响「重启后还能不能回放」 */
    }
  }
}

/** 四级降级链的固定顺序（展示时四档都要在，哪怕没试过）。 */
export const RETRIEVAL_LEVELS: readonly DiagRetrievalLevel['level'][] = ['vector', 'cloud', 'fts', 'outline']

/** 认一个数（认不出回落到 `fallback`）。 */
function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 认一个串（认不出回落空串）。 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 从 `rag_search` 的工具产出里读出**这一轮检索的完整轨迹**。
 *
 * ★ 四档**都要出现**（没走到的那一档写「未走到这一档」）—— 演示时要能一眼看出
 *   「它试了向量、没命中、于是落到 FTS」，而不是只看到一个最终档位。
 * ★ `attempts` / `gradeFilter` 来自 Python 的 `RagSearchResult`（本轮新增的可选字段）。
 *   老 sidecar 没有这两个字段时 `levels` 退化成「只有最终档位被标记 tried」，
 *   **不编造**中间档位的状态。
 */
export function readRetrievalFromDetails(details: Record<string, unknown> | null): DiagRetrieval | null {
  if (!details || details.ok !== true) return null
  const rawAttempts = Array.isArray(details.attempts) ? details.attempts : []
  const attempts = rawAttempts.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
  )
  const degraded = readText(details.degraded)
  const levels: DiagRetrievalLevel[] = RETRIEVAL_LEVELS.map((level) => {
    const attempt = attempts.find((item) => readText(item.level) === level)
    if (!attempt) {
      // 认得出最终档位时，把「最终落在哪一档」如实标成 tried（老 sidecar 的退化形态）
      const isFinal = attempts.length === 0 && level === degraded
      return {
        level,
        tried: isFinal,
        ok: isFinal,
        hits: isFinal ? readNumber(details.hitCount) : 0,
        note: isFinal ? '本次最终落在这一档（旧版后端未提供逐级记录）' : '未走到这一档'
      }
    }
    return {
      level,
      tried: true,
      ok: attempt.ok === true,
      hits: readNumber(attempt.hits),
      note: readText(attempt.detail)
    }
  })
  return {
    query: readText(details.query),
    degraded,
    gradeFilter: readText(details.gradeFilter),
    hitCount: readNumber(details.hitCount),
    compatCount: readNumber(details.compatCount),
    levels
  }
}
