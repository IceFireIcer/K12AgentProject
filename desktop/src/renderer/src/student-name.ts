/**
 * `{{student_name}}` 占位机制（执行报告 §0.6.4）—— 渲染层**唯一**的替换实现。
 *
 * ── 为什么走占位符而不是把名字交给模型 ──────────────────────────────────
 * 提示词里写死的是一句带占位符的规则：
 *
 *   提示词：称呼这位学生时使用占位符 {{student_name}}
 *   模型说：「{{student_name}}，我们先把这道题拆成三步」
 *   界面说：「小明，我们先把这道题拆成三步」
 *
 * **模型全程不知道「小明」是谁** —— 真名只活在两个地方：本机库的
 * `identity_local.real_name` 与渲染进程的内存里。任何一个字节都不进 prompt。
 *
 * ── 为什么必须有一条「残留检测」────────────────────────────────────────
 * 模型可能不照做（改叫「这位同学」「亲爱的同学」），也可能把占位符写花
 * （`{{ student_name }}`、`{{studentName}}`、`{{`）。**最坏的一种是它照抄了
 * 一个我们不认得的占位符** —— 那串花括号会原样印到学生眼前，看起来像程序坏了。
 * 所以这里不只做替换，还要能把「有没有残留」判出来（{@link hasUnsubstitutedPlaceholder}），
 * 由调用方决定怎么兜（{@link renderStudentName} 的兜底 + 守卫 G-D 的测试断言）。
 *
 * ── 名字的来源与回落 ────────────────────────────────────────────────────
 * 优先用后端给的 `displayName`（它是 `real_name` 过脱敏之后的安全值），
 * 拿不到才回落到中性的「同学」—— **绝不回落成空串**（那会渲染出
 * 「，我们先把这道题拆成三步」，看起来像模板漏了变量）。
 */

import { STUDENT_FALLBACK_NAME } from '@shared/profile-tags'

/** 占位符的规范写法（提示词里给模型的就是这一个）。 */
export const STUDENT_NAME_TOKEN = '{{student_name}}'

/**
 * 「像不像一个没被替换掉的占位符」。
 *
 * ★ 刻意**比规范写法宽**：只要出现 `{{` 就认为有残留。
 *   窄匹配（只认 `{{student_name}}`）会让 `{{ student_name }}`、
 *   `{{studentName}}`、`{{名称}}` 这些「模型自己造的花括号」全部漏过去 ——
 *   而它们印到学生眼前的观感与规范占位符一模一样（都是两支花括号）。
 */
const PLACEHOLDER_PATTERN = /\{\{/

/** 规范占位符（允许花括号内有多余空格）→ 真实称呼。 */
const STUDENT_NAME_PATTERN = /\{\{\s*student_name\s*\}\}/g

/**
 * 取这次替换要用的称呼。
 *
 * @param displayName 后端给的脱敏显示名（可为空）。
 * @returns 一定是**非空**的一个称呼（兜底是中性的「同学」）。
 */
export function resolveStudentName(displayName: string | null | undefined): string {
  const trimmed = (displayName ?? '').trim()
  return trimmed === '' ? STUDENT_FALLBACK_NAME : trimmed
}

/**
 * 把一段正文里的占位符换成真实称呼。
 *
 * ⚠️ 只做**一次**替换，不做循环：替换结果里若又出现 `{{`（学生自己把名字取成了
 *    「{{x}}」这种），再替一次会变成无界递归 —— 那是一个能被输入触发的挂死。
 *   残留由 {@link hasUnsubstitutedPlaceholder} 报出来，不在这里反复擦。
 */
export function substituteStudentName(text: string, displayName: string | null | undefined): string {
  if (text === '') return ''
  return text.replace(STUDENT_NAME_PATTERN, resolveStudentName(displayName))
}

/**
 * 替换之后**还有没有没被替换掉的占位符**（守卫 G-D 的判据）。
 *
 * ★ 它是「模型没照做」这件事的唯一机械判据 —— 没有它，那种失败在界面上
 *   只表现为「学生看到两支花括号」，谁都不会知道该去改提示词。
 */
export function hasUnsubstitutedPlaceholder(text: string): boolean {
  return PLACEHOLDER_PATTERN.test(text)
}

/**
 * 渲染层给正文用的**唯一出口**：替换 + 残留兜底。
 *
 * 兜底策略：把残留的花括号整体抹掉（留下称呼该在的位置由模型自己写的话）。
 * 宁可少半句话，也不让学生读到一段像程序坏了的乱码。
 *
 * @returns `text` = 可以上屏的正文；`residual` = 是否发生过兜底
 *   （**只给测试与教师视角用**，学生面不显示这个布尔量）。
 */
export function renderStudentName(
  text: string,
  displayName: string | null | undefined
): { text: string; residual: boolean } {
  const substituted = substituteStudentName(text, displayName)
  const residual = hasUnsubstitutedPlaceholder(substituted)
  if (!residual) return { text: substituted, residual: false }
  return { text: substituted.replace(/\{\{[^}]*\}\}?/g, ''), residual: true }
}