/**
 * 轮次诊断信封（`TurnDiagnostics`）——**演示模式 / 教师答辩视角的唯一数据底座**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它是什么（以及不是什么）
 * ══════════════════════════════════════════════════════════════════════════
 * 它是「关于**这一轮**的运行时元数据」：这一轮按哪个学段答的、Prompt 拼了几段、
 * 画像块的字节指纹变没变、检索走到了降级链的哪一级、安全三阶段各自的结论、
 * 工具调了几次多快、有没有被哪个机制拦下。
 *
 * ★★ 它**不是第二套对话历史**（那件事的唯一真相是 Pi 的会话 JSONL）：
 *   · 不进 6 事件词表（`delta|citation|payload|blocked|done|error` 一个字不动）；
 *   · 不落进对话历史；
 *   · 落盘（JSONL）时**剥掉正文**：学生输入、画像块、Prompt 原文、模型推理
 *     一律只留长度与哈希（见 `main/agent/diagnostics.ts` 的 `stripForPersistence`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么独立成通道而不是塞进 `trace:changed`
 * ══════════════════════════════════════════════════════════════════════════
 * `trace:changed` 的载荷是「工具调用轨迹」——它已经是一个**并列通道**（不是事件）。
 * 信封比它宽得多（Prompt / 画像 / 学段 / 安全 / 检索），塞进去会让每一个轨迹消费方
 * 都被迫理解一堆它不关心的字段（与 `ipc-events.ts` 里那条「并列通道」的判断同一条纪律）。
 * 所以：**新开一条 `diagnostics:changed`**，与轨迹并列。
 *
 * ⚠️ 本文件被主进程与渲染进程**同时** import：不许出现任何 Node 内建模块
 *   （守卫 G2 扫渲染进程），也不许 import 主进程模块。
 */

import type { GradeLevel } from './ipc-events'

// 让只依赖本模块的消费方（主进程的采集器、preload 的边界校验）也能拿到四学段的类型，
// 不必再 import 一次 `ipc-events`（少一条 import 边 = 少一处可以写错的联合类型副本）。
export type { GradeLevel }

/** 环形缓冲保留的轮数（演示与回放够用；再多的价值低于它占的内存与落盘体积）。 */
export const DIAGNOSTICS_TURN_LIMIT = 20

/** 一段 Prompt（按标题切段；`text` 可能被截断，见 `truncated`）。 */
export interface DiagPromptSegment {
  id: string
  label: string
  /** 估算 token（中文按字符数换算的粗略值，**只用于展示相对体量**，不是计费口径）。 */
  tokens: number
  chars: number
  text: string
  /** 展示用的 `text` 被截断过（原文更长）。 */
  truncated: boolean
}

/** 三道运行时注入各自「这一轮有没有生效」。 */
export interface DiagPromptOverride {
  stage: 'override' | 'per-turn' | 'authority'
  applied: boolean
  note: string
}

/** 一条工具调用（与 `TraceEntry` 同源，但只保留这一轮的信封里要用的字段）。 */
export interface DiagToolCall {
  seq: number
  name: string
  ok: boolean
  latencyMs: number
  degraded?: string
}

/** 降级链的**一级**：试过没有、命中了没有、为什么。 */
export interface DiagRetrievalLevel {
  level: 'vector' | 'cloud' | 'fts' | 'outline'
  tried: boolean
  ok: boolean
  hits: number
  note: string
}

/** 本轮检索的完整轨迹（`null` = 这一轮没有查教材）。 */
export interface DiagRetrieval {
  /** 检索词（**模型自己拟的**，不是学生原话）。 */
  query: string
  /** Python 判定的最终档位（TS 不重新推理）。 */
  degraded: string
  /** 学段过滤条件**原文**（由 Python 按它真正下发的白名单生成；展示用）。 */
  gradeFilter: string
  hitCount: number
  compatCount: number
  levels: DiagRetrievalLevel[]
}

/** 内容安全的一个阶段。`skipped` = 那一阶段没跑（无 Key / 没有正文要审）。 */
export interface DiagSafetyStage {
  stage: 'input' | 'stream' | 'final'
  verdict: 'pass' | 'blocked' | 'skipped'
  reason?: string
}

/**
 * 一条**拦截**记录 —— 演示模式里最强的证据：不是「我做了什么」，是「我拦下了什么」。
 *
 * `source` 是机制名（学段冷却 / 安全拦截 / 动画校验 / 重试上限 / 检索降级），
 * `reason` 是一句可读中文，`detail` 只在拿得到时给（**不含正文**）。
 */
export interface DiagInterception {
  source: string
  reason: string
  detail?: string
}

/** 学段观察（这一轮按谁的话、用哪一层判的）。 */
export interface DiagGrade {
  applied: GradeLevel
  /** `llm` = LLM 复核层判的；`rules` = 本地规则层；`null` = 还一次都没判过。 */
  decidedBy: string | null
  /** 第二层（LLM 复核）最近一次的状态：`not_due` / `due` / `used` / `no_llm` … */
  layer2: string
  pending: GradeLevel | null
  cumulativeTurns: number
  /** 学生手动指定后的冷却剩余轮数（0 = 没在冷却）。 */
  cooldownRemainingTurns: number
  /** 最近一次服务端判定的可读结论（**不含正文**）。 */
  note: string
}

/** 画像注入：**逐字节稳定**是「前缀缓存可复用」的可观测证据。 */
export interface DiagStudentContext {
  injected: boolean
  chars: number
  /** 画像块的字节指纹（前 12 位十六进制）。 */
  byteHash: string
  /** 与上一轮**逐字节相同**（`false` = 这一轮变了，前缀缓存要从这里往后重算）。 */
  sameAsPrev: boolean
  text: string
  truncated: boolean
}

/**
 * 模型推理（**条件式**：拿不到就是 `available: false`，不编）。
 *
 * ★ 两道纪律（报告第 8 节）：过滤层**整段替换**（不是打码）、默认折叠、不落盘。
 */
export interface DiagReasoning {
  available: boolean
  filtered: string
  /** 为什么没有 / 为什么被整段替换掉。 */
  note: string
}

/** 本轮安全终审的聚合计数（与 `[safety]` 那行日志同一个口径）。 */
export interface DiagSafetyFinal {
  stages: DiagSafetyStage[]
  finalizations: number
  retractions: number
  bufferedChars: number
}

/** 本轮结束的时序。 */
export interface DiagDone {
  ok: boolean
  status: string
  totalMs: number
  firstTokenMs: number | null
}

/**
 * 沙箱事件**只由渲染进程采集**（Worker 与 iframe 都在渲染进程里，主进程看不到）。
 *
 * ★ 按 `requestId` 合并进同一份信封：主进程发一份信封，渲染进程把自己采集到的
 *   这几条挂上去再渲染 —— **绝不**在主进程里编沙箱事件。
 */
export interface DiagSandbox {
  codeExecutedIn: 'renderer-worker' | null
  interrupted: boolean
  outputTruncated: boolean
  /** 动画沙箱就绪超时（5 秒没 ready → 整段降级）。 */
  animationReadyTimeout: boolean
}

export interface TurnDiagnostics {
  /** 第几轮（与工具轨迹的 `turn` 同一个口径：一次学生提问 = 一轮）。 */
  turn: number
  requestId: string
  /** 这一轮开始的时间戳（毫秒）。 */
  at: number
  input: {
    text: string
    safetyInput: { verdict: 'pass' | 'blocked'; reason?: string }
  }
  grade: DiagGrade
  prompt: {
    chars: number
    totalTokens: number
    gradeTemplate: GradeLevel
    segments: DiagPromptSegment[]
    overrides: DiagPromptOverride[]
    /** 上屏前的本机路径断言结论（`true` = 干净）。 */
    hostPathClean: boolean
  }
  studentContext: DiagStudentContext
  reasoning: DiagReasoning
  tools: DiagToolCall[]
  retrieval: DiagRetrieval | null
  safetyFinal: DiagSafetyFinal
  interceptions: DiagInterception[]
  done: DiagDone
  /** 渲染进程补齐的沙箱事件（主进程发出来的那份没有这个字段）。 */
  sandbox?: DiagSandbox
}

/**
 * 一份**全量**快照（最近 N 轮，按轮次升序）。
 *
 * ★ 与 `TraceSnapshot` 同一条纪律：推**全量**而不是增量 —— 轮数少，
 *   全量替换省掉一整套「对不上号就重来」的恢复协议。
 * ★ `persisted` 说明这份快照是不是从落盘的 JSONL 暖机来的（演示时一眼看得出
 *   「这是重启前的记录」还是「这是这次跑出来的」）。
 */
export interface DiagnosticsSnapshot {
  turns: TurnDiagnostics[]
  limit: number
  persisted: boolean
  updatedAt: number
}

/** preload 边界的形状检查（半截对象直接丢掉，别让界面上出现一行空白信封）。 */
export function isDiagnosticsSnapshot(value: unknown): value is DiagnosticsSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { turns?: unknown; limit?: unknown; updatedAt?: unknown }
  return (
    Array.isArray(record.turns) &&
    typeof record.limit === 'number' &&
    typeof record.updatedAt === 'number'
  )
}

/** 一条信封的最小形状检查（暖机读 JSONL 时逐行校验用）。 */
export function isTurnDiagnostics(value: unknown): value is TurnDiagnostics {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { turn?: unknown; requestId?: unknown; done?: unknown }
  return (
    typeof record.turn === 'number' &&
    typeof record.requestId === 'string' &&
    typeof record.done === 'object' &&
    record.done !== null
  )
}

/** 空快照（还没跑过任何一轮 / 桥缺失时界面显示它，而不是 `undefined`）。 */
export function emptyDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return { turns: [], limit: DIAGNOSTICS_TURN_LIMIT, persisted: false, updatedAt: 0 }
}
