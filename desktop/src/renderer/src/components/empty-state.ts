/**
 * `EmptyState` 的**文案长度上限**（报告 §4.2 的「title/desc 添加长度校验」）。
 *
 * ★ 单独一个模块而不是写在 `<script setup>` 里：Vue 的 `<script setup>` 不允许
 *   ES 模块导出，而这些上限要被单测（`tests/component-api.test.ts`）直接引用。
 */

/** 标题上限（一行 ≈ 18 个中文字）。 */
export const EMPTY_STATE_TITLE_MAX = 18
/** 说明上限（两行，每行 ≈ 36 个中文字）。 */
export const EMPTY_STATE_DESC_MAX = 72
