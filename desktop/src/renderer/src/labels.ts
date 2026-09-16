/**
 * 界面文案映射（学段名 / 学段提示语 / 卡片种类 / 轮次状态 / 练习卡片）。
 *
 * 只做「枚举 → 中文」这一件事：四学段字面量、`PayloadKind` 与题型都来自冻结契约
 * （`@shared/ipc-events` 与 OpenAPI 生成物），这里不新增任何枚举值。
 */

import type { GradeLevel, PayloadKind } from '@shared/ipc-events'
import type { QuizQuestionType } from './cards/quiz'
import type { TurnStatus } from './api/events'

/** 四学段的中文名（执行文档 §6.2 的字面量，一一对应）。 */
export const GRADE_LABELS: Record<GradeLevel, string> = {
  primary_low: '小学低年级',
  primary_high: '小学高年级',
  junior: '初中',
  senior: '高中'
}

/** 学段还没判出来时指示器上的字（★ 不许拿冷启动默认值冒充判定结果）。 */
export const GRADE_UNKNOWN_LABEL = '待判定'

/**
 * 系统判定出学段（或判定结果变化）时，给学生的一句**简短**提示。
 *
 * ★ 为什么要有这句话：学段是**系统自己判的**，学生没做过任何操作；
 *   不说一声的话，适配发生了也看不出来。所以这里只陈述「我按什么说法讲」，
 *   不邀功、不解释规则、不需要学生确认（更不是让他去选）。
 */
export function gradeAdaptNotice(grade: GradeLevel): string {
  return `我按${GRADE_LABELS[grade]}的说法来讲。`
}

/** 内联卡片种类（§9.3 的三个 `kind`）。 */
export const PAYLOAD_KIND_LABELS: Record<PayloadKind, string> = {
  animation: '动画讲解',
  coding: '编程练习',
  quiz: '随堂练习'
}

/** 一句话说明每类卡片将来会做什么（动画 16/17、编程 18/19 落地；练习已由票 14 落地）。 */
export const PAYLOAD_KIND_HINTS: Record<PayloadKind, string> = {
  animation: '看动画，把抽象概念演给你看',
  coding: '动手改代码，马上看到运行结果',
  quiz: '做几道题，检验一下刚学的'
}

export const TURN_STATUS_LABELS: Record<TurnStatus, string> = {
  streaming: '正在回答',
  done: '回答完成',
  blocked: '已撤回',
  error: '能力受限'
}

/** 三种题型的中文名（`QuizQuestionType`，契约里的三个字面量）。 */
export const QUIZ_TYPE_LABELS: Record<QuizQuestionType, string> = {
  choice: '选择题',
  blank: '填空题',
  code_blank: '代码填空'
}

/** 判分方式（`QuizResult.scoredBy`）：客观题规则判分 / 主观题模型判分。 */
export const SCORED_BY_LABELS: Record<'rule' | 'llm', string> = {
  rule: '规则判分',
  llm: '模型判分'
}

/**
 * 掌握度变化的中文展示（`QuizResult.masteryDelta`，后端已限幅 ±0.2）。
 *
 * ★ 只做**格式化**：不重新计算、不判对错、不做第二套限幅 —— 判分只在后端（§6.3）。
 */
export function formatMasteryDelta(delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return '掌握度不变'
  const sign = delta > 0 ? '+' : ''
  return `掌握度 ${sign}${delta.toFixed(2)}`
}
