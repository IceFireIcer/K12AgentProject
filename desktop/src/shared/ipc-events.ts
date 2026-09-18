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

/** 一轮请求内的文本增量。 */
export interface DeltaEvent {
  requestId: string
  delta: string
}

/** `rag_search` 命中的引用列表。 */
export interface CitationEvent {
  requestId: string
  citations: Citation[]
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
