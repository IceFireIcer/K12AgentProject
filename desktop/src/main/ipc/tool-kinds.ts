/**
 * Tool 名 → `payload` 事件 `kind` 的映射（执行文档 §9.3，**冻结**）。
 *
 * ★ 全仓**唯一**的映射表：`desktop/src/main/ipc/tool-kinds.ts`。
 *   票 06/08 在 `src/main/agent/events.ts` 把 `tool_execution_end` 翻成 `payload` 事件时，
 *   **必须 import 这张表**，不要再写第二份（新增 Tool 必须同步登记，否则前端收到未知 `kind`）。
 *   架构守卫断言：这 7 个 Tool 在表内，`get_student_profile` / `rag_search` 明确**不在**表内
 *   （它们不发 `payload`：画像只影响 Prompt，检索结果走 `citation` 事件）。
 */

import type { PayloadKind } from '@shared/ipc-events'

export const TOOL_TO_KIND = {
  generate_animation: 'animation',
  get_code_template: 'coding',
  get_coding_hint: 'coding',
  evaluate_code: 'coding',
  generate_quiz: 'quiz',
  submit_quiz: 'quiz',
  generate_variants: 'quiz'
} as const satisfies Record<string, PayloadKind>

/** 会发 `payload` 事件的 Tool 名（表内全部 7 个）。 */
export type PayloadToolName = keyof typeof TOOL_TO_KIND

/** 表内全部 Tool 名（顺序与声明一致，供测试与守卫比对）。 */
export const PAYLOAD_TOOL_NAMES = [
  'generate_animation',
  'get_code_template',
  'get_coding_hint',
  'evaluate_code',
  'generate_quiz',
  'submit_quiz',
  'generate_variants'
] as const satisfies readonly PayloadToolName[]

/**
 * 查表。
 * 不在表内（`rag_search` / `get_student_profile` / 未来新增但未登记的 Tool）返回 `null`——
 * 调用方据此**不发** `payload` 事件，而不是猜一个 `kind` 塞给前端。
 */
export function kindForTool(toolName: string): PayloadKind | null {
  return toolName in TOOL_TO_KIND ? TOOL_TO_KIND[toolName as PayloadToolName] : null
}
