/**
 * 会话标题的**显示层兜底**（唯一实现，两处共用）。
 *
 * ★ 为什么需要它（实测 P1-3）：没有消息的会话，主进程从 Pi 那边拿到的名字可能是
 *   英文占位（`(no messages)` 一类）。它在列表里与中文标题并排出现，读起来像界面坏了。
 *   `components/SessionList.vue`（对话页左栏）一直有这个兜底，而
 *   `study/SessionsTab.vue`（学习记录页的历史会话）**直接渲染 `item.title`** ——
 *   于是同一个占位串在档案页露了出来。两处各写一份判据必然再次漂移，所以归口到这里。
 *
 * ★ 归一只做**最小**一件事：把认得出的英文占位换成中文说法，其余一字不改
 *   （不改标题、不截断、不生成标题 —— 标题的来源仍是主进程那一处）。
 */

/** 见过 / 可能出现的英文占位标题（比对时折成小写）。 */
export const PLACEHOLDER_TITLES: readonly string[] = ['(no messages)', '(empty)', '(untitled)']

/** 占位 / 空白标题在界面上统一显示成这个中文说法。 */
export const FALLBACK_SESSION_TITLE = '新的对话'

/**
 * 标题 → 界面上显示的文字。
 *
 * - 空串 / 纯空白 → {@link FALLBACK_SESSION_TITLE}；
 * - 认得出的英文占位（大小写不敏感）→ 同样换成中文；
 * - 其余**原样返回**（只 trim）。
 */
export function displaySessionTitle(title: string | null | undefined): string {
  if (typeof title !== 'string') return FALLBACK_SESSION_TITLE
  const trimmed = title.trim()
  if (trimmed.length === 0) return FALLBACK_SESSION_TITLE
  return PLACEHOLDER_TITLES.includes(trimmed.toLowerCase()) ? FALLBACK_SESSION_TITLE : trimmed
}
