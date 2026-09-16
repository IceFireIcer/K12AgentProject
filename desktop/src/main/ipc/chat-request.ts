/**
 * `chat:send` 入参的**校验与归一**（纯函数，可单测）。
 *
 * 纪律：**不信任渲染进程**。渲染进程只能经 preload 白名单调这一条通道，
 * 但参数仍要在主进程再校验一次（类型、空串、长度、学段字面量），
 * 失败返回可读中文回执（`ok: false`），**不抛异常**——抛出去只会变成穿过 IPC 的堆栈文本。
 */

import type { GradeLevel } from '@shared/ipc-events'
import type { ChatSendRequest } from './channels.ts'

/** 单条输入的长度上限（防手滑粘贴整本书；也保护下游 Prompt 预算）。 */
export const MAX_INPUT_CHARS = 2000

/** 四学段字面量（执行文档 §6.2，冻结）。 */
const GRADE_LEVELS: readonly GradeLevel[] = ['primary_low', 'primary_high', 'junior', 'senior']

export type ChatSendParse =
  | { ok: true; request: ChatSendRequest }
  | { ok: false; message: string }

/** 解析 `chat:send` 的入参：成功给出归一后的请求，失败给出**可直接显示给学生**的一句话。 */
export function parseChatSendRequest(payload: unknown): ChatSendParse {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: '发送失败：请求格式不正确。' }
  }

  const record = payload as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (text.length === 0) {
    return { ok: false, message: '发送失败：内容为空，请先输入你想问的问题。' }
  }
  if (text.length > MAX_INPUT_CHARS) {
    return { ok: false, message: `发送失败：一次最多输入 ${MAX_INPUT_CHARS} 个字，可以先说说你最想弄懂的那一点。` }
  }

  const gradeLevel = readGradeLevel(record.gradeLevel)
  return { ok: true, request: gradeLevel === undefined ? { text } : { text, gradeLevel } }
}

/** 学段必须是四个冻结字面量之一；不是就当作「没给」（由下游用默认值，而不是把脏值传下去）。 */
function readGradeLevel(value: unknown): GradeLevel | undefined {
  if (typeof value !== 'string') return undefined
  return (GRADE_LEVELS as readonly string[]).includes(value) ? (value as GradeLevel) : undefined
}
