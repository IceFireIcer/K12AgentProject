/**
 * 界面文案映射（学段名 / 卡片种类 / 轮次状态）。
 *
 * 只做「枚举 → 中文」这一件事：四学段字面量与 `PayloadKind` 都来自冻结契约
 * （`@shared/ipc-events`），这里不新增任何枚举值。
 */

import type { GradeLevel, PayloadKind } from '@shared/ipc-events'
import type { TurnStatus } from './api/events'

/** 四学段的中文名（执行文档 §6.2 的字面量，一一对应）。 */
export const GRADE_LABELS: Record<GradeLevel, string> = {
  primary_low: '小学低年级',
  primary_high: '小学高年级',
  junior: '初中',
  senior: '高中'
}

/** 内联卡片种类（§9.3 的三个 `kind`）。 */
export const PAYLOAD_KIND_LABELS: Record<PayloadKind, string> = {
  animation: '动画讲解',
  coding: '编程练习',
  quiz: '随堂练习'
}

/** 一句话说明每类卡片将来会做什么（票 16–19 落地）。 */
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
