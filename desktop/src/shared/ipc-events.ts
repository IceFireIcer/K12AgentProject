/**
 * 渲染进程 ↔ 主进程 的 6 事件词表与载荷结构（执行文档 §6.4）。
 *
 * ★★ 词表冻结 ★★
 * 事件名只有这 6 个，一个字都不能改：`delta | citation | payload | blocked | done | error`。
 * 传输层是 IPC（`webContents.send` / `ipcRenderer.on`），不是 SSE——
 * 因此前端只需要**订阅回调**，不存在解析器、分帧、`{stream:true}` 解码这些东西。
 *
 * 事件来源映射（票 06 落地，见 §6.4）：
 *   delta    ← `message_update`（文本增量）
 *   citation ← `rag_search` Tool 的执行结果
 *   payload  ← `tool_execution_end` → 按 Tool 名映射 `kind`（§9.3）
 *   blocked  ← 安全终审节点判定
 *   done     ← `agent_end`
 *   error    ← provider 异常 / Tool 异常 / 降级路径
 */

import type { components } from './api-types'

/** 事件名（冻结的 6 个）。 */
export type IpcEventName = 'delta' | 'citation' | 'payload' | 'blocked' | 'done' | 'error'

/**
 * 冻结词表的运行时副本：供架构守卫测试与运行时断言比对。
 * 顺序也是冻结的一部分（按事件发生的自然顺序排列）。
 */
export const IPC_EVENT_NAMES: readonly IpcEventName[] = [
  'delta',
  'citation',
  'payload',
  'blocked',
  'done',
  'error'
]

/**
 * 四学段（冻结的字面量，§6.2 的 `GradeLevel`）。
 *
 * ★ 从**生成物派生**（不手写副本）：`src/shared/api-types.ts` 是
 *   `contracts.py → OpenAPI → TS` 的产物，`npm run check:api` 保证它不漂移 ——
 *   这里每多手写一份联合类型，就多一个「契约改了、事件边界没跟着改」的静默漂移口。
 * ★ 导出名保持 `GradeLevel` 不变（`channels.ts` / `preload` / 渲染进程都 import 这个名字），
 *   取值也仍是 `contracts.py` 里那四个字符串（`primary_low | primary_high | junior | senior`）。
 */
export type GradeLevel = components['schemas']['GradeLevel']

/**
 * `citation` 事件的检索来源条目（检索严格按学段隔离，向上兼容须显式标注）。
 * ★ 同样从生成物派生：字段（`chunkId` / `chapterTitle` / `sectionTitle` / `gradeLevel` / `compat`）
 *   与 `contracts.py` 的 `Citation`（「只有这 5 个字段，一字不改」）逐字一致。
 */
export type Citation = components['schemas']['Citation']

/**
 * 检索降级链的档位（`vector | cloud | fts | outline`）。
 * ★ 从生成物派生：Python 的 `RagService` 判定后原样透传，TS 侧**不重新推理**。
 */
export type Degraded = components['schemas']['Degraded']

/**
 * 一条引用的**细节**（右栏「教材原文」抽屉用）。
 *
 * ★★ 为什么不塞进 `Citation`：那个类型的 5 个字段是**冻结的投影**
 *   （`contracts.py` 的 `Citation`，注释写着「只有这 5 个字段」），
 *   `citation` 事件的 `citations` 数组因此在任何消费方那里都保持稳定。
 *   详情作为**并列的可选字段**（`details`）出现，老消费方不看它即可，零破坏。
 *
 * ★ 这些字段**本来就在 `RagSearchResult.hits` 里**（Python 一直在返回）：
 *   之前只是在 TS 侧投影成 5 字段时丢掉了。所以补上它不需要改任何 Python 契约。
 *
 * ⚠️ `text` 是**节级完整正文**，可能上千字；它只用于「点开来源看原文」这一处，
 *   不参与列表渲染，也不进 Prompt（Prompt 用的是 `RagSearchResult.context`）。
 */
export interface CitationDetail {
  /** 与 `Citation.chunkId` 对齐（前端按它把详情挂到引用行上）。 */
  chunkId: string
  /** 节级完整正文（取父块）。 */
  text: string
  /** 相关度分数（0–1）；认不出时为 `null`。 */
  score: number | null
  /** 父块 id（父子分块：小子块检索、命中回父块作上下文）。 */
  parentChunkId: string | null
  /** 这一条是在哪一档检索出来的（与事件的 `degraded` 通常一致）。 */
  degraded: Degraded | null
  /** 该命中归属的知识点 id（「去闯关 / 看依赖」用它跳转）。 */
  kpId: string | null
  /** `true` = 由依赖图扩展补充进来的上下文（不是直接命中）。 */
  expanded: boolean
}

/** 一轮请求内的文本增量。 */
export interface DeltaEvent {
  requestId: string
  delta: string
}

/** `rag_search` 命中的引用列表。 */
export interface CitationEvent {
  requestId: string
  citations: Citation[]
  /**
   * 每一条引用的细节（与 `citations` 同源、按 `chunkId` 对齐）。
   * ★ 可选：主进程认不出细节时整块省略，消费方必须容忍它缺席。
   */
  details?: CitationDetail[]
  /**
   * 这一轮检索实际走到了降级链的哪一档（右栏「四级降级链」据此点亮）。
   * ★ 可选：没有检索发生时（模型直接作答）整块省略。
   */
  degraded?: Degraded
}

/** 内联卡片载荷的三种 `kind`（与 §9.3 的 Tool 名映射冻结在一起）。 */
export type PayloadKind = 'animation' | 'coding' | 'quiz'

/** 工具执行产出的结构化载荷（具体结构由各 SubAgent 的 pydantic Payload 决定）。 */
export interface PayloadEvent {
  requestId: string
  kind: PayloadKind
  payload: unknown
}

/** 内容安全终审判定违规：撤回原文，改用安全提示。 */
export interface BlockedEvent {
  requestId: string
  reason: string
  safeText: string
}

/** 本轮结束。 */
export interface DoneEvent {
  requestId: string
  messageId: string
}

/**
 * 出错 / 降级。
 * `degraded === true` 表示这是一次**降级**（不是崩溃）：仍给用户可用结果，
 * 但要在 UI 上明示能力受限（例如检索降级到 FTS5 / 大纲，或云端模型不可用）。
 */
export interface ErrorEvent {
  requestId: string
  message: string
  degraded: boolean
}

/** 判别联合：`name` 与 `data` 一一对应。 */
export type IpcEvent =
  | { name: 'delta'; data: DeltaEvent }
  | { name: 'citation'; data: CitationEvent }
  | { name: 'payload'; data: PayloadEvent }
  | { name: 'blocked'; data: BlockedEvent }
  | { name: 'done'; data: DoneEvent }
  | { name: 'error'; data: ErrorEvent }

/* ------------------------------------------------------------------ *
 * 工具调用轨迹（**不是事件**：它走独立的 `trace:changed` 推送通道）
 *
 * ★ 为什么不塞进 6 事件词表：那 6 个是**对话语义**（学生看到的每一轮怎么走）。
 *   轨迹是**工程证据**（哪次调了什么 Tool、多快、有没有降级），
 *   它服务于「设计合理性」那一维度的汇报，与对话状态机不是一回事。
 *   混进去会让每个消费方都被迫理解一个它不关心的字段。
 * ------------------------------------------------------------------ */

/**
 * 一条 Tool 调用记录（与主进程 `agent/trace.ts` 的 `ToolTraceRecord` 同形，
 * 但**只带界面要显示的那几个字段**）。
 *
 * ⚠️ 主进程侧有更全的记录（`toolCallId` / `at` / `blockReason` / `errorMessage`），
 *   这里刻意不要 —— 那些是排查用的，界面一张小卡片放不下，也容易夹带内部信息。
 */
export interface TraceEntry {
  /** 第几轮对话（一次学生提问 = 一轮）。 */
  turn: number
  /** Tool 名（冻结词表里的名字）。 */
  toolName: string
  /** 参数摘要（主进程已脱敏 + 截断，**不含 Key / 学生身份**）。 */
  argsSummary: string
  /** `false` = 失败或被安全阀拦下。 */
  ok: boolean
  latencyMs: number
  /** 降级档位；没有则省略。 */
  degraded?: Degraded
}

/**
 * 本轮（最新一轮）的工具调用轨迹快照。
 *
 * ★ 推送的是**快照**而不是增量：主进程每记录一条就推一次全量，
 *   渲染进程直接替换。增量协议要多维护一个「对不上号就重来」的恢复路径，
 *   而这里的量级（一轮几个 Tool）小到没必要。
 */
export interface TraceSnapshot {
  /** 快照覆盖的最大轮次。 */
  turn: number
  entries: TraceEntry[]
}
