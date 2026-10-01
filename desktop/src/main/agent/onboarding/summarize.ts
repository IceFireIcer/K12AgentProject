/**
 * 五问概括的**接缝**（票 25 主进程半；票 31 接上真实现）。
 *
 * ★ 历史与本轮的分工：
 *   · 票 25 时这里只留接缝、默认挂降级桩 —— MVP 15 个标签全部可本地抽取
 *     （执行报告 §1.6），引入一次 LLM 往返换不到新标签；
 *   · 票 31（2026-09-29 用户裁决）把真实现接进来：**createLlmSummarizer**
 *     （住在 `summarize-llm.ts`），由 `ipc/handlers.ts` 在 registerOnboardingHandlers 时注入。
 *     调用侧（service.ts 的 runSummary）因此**一行都没改** —— 这就是这条缝存在的理由。
 *
 * ★ 这个文件仍然只留三样东西（都是**纪律的可执行形态**，不是占位空壳）：
 *   ① 概括通道的**类型面**（OnboardingSummarizer）与出网边界的注释；
 *   ② **降级桩** createDegradedSummarizer —— 现在是「没接线 / 没 Key 时」的默认实现
 *      （永不失败、永不返回新标签），不再是「永远的默认」；
 *   ③ 超时与「只重试 1 次」的常量（service.ts 用它约束**任何**实现，包括真实现）。
 */

import type { OnboardingQuestionId } from '../../../shared/profile-tags.ts'
import type { OnboardingTagWrite } from './types.ts'

/**
 * 降级理由（进日志与诊断，说明「为什么这次没有额外标签」）。
 * ★ 它现在只在**没接线 / 没配 Key** 这两类情形出现；生产路径由 summarize-llm.ts 提供。
 */
export const ONBOARDING_SUMMARY_DEFERRED_REASON =
  '概括器未接线或没有可用的模型配置；只保留本地抽取得到的字段，引导照常结束'

/** 概括调用的一次性上限（与 grade.ts 的第二层判定同一口径：8s）。 */
export const ONBOARDING_SUMMARY_TIMEOUT_MS = 8_000

/**
 * 概括**最多尝试 2 次**（= 自动重试 1 次）。
 * ★ 执行报告 §1.7 明文：「失败不重试到烦人 —— 只自动重试 1 次，
 *   仍失败走降级（degraded，只存点选得到的字段，引导照常结束）」。
 */
export const ONBOARDING_SUMMARY_MAX_ATTEMPTS = 2

/** 概括的输入（★ 只有**已经脱敏**的答案与候选标签，绝不带原文以外的身份信息）。 */
export interface OnboardingSummaryInput {
  answers: readonly { questionId: OnboardingQuestionId; text: string }[]
  tags: readonly OnboardingTagWrite[]
  /** 脱敏后的称呼（实现方**不得**把它写进任何出网载荷）。 */
  displayName: string
}

/** 概括的结论。degraded=true 表示「这次没概括出来」，调用方仍要照常结束引导。 */
export interface OnboardingSummaryOutcome {
  ok: boolean
  degraded: boolean
  /** 失败原因（可读中文；ok=true 时为空串）。 */
  reason: string
  /** 概括出的**额外**标签（必须同样是白名单键；本轮恒为空）。 */
  tags: OnboardingTagWrite[]
}

export type OnboardingSummarizer = (input: OnboardingSummaryInput) => Promise<OnboardingSummaryOutcome>

/**
 * 降级桩（默认实现）：**立刻返回 degraded**，不产出任何新标签。
 *
 * ★ 它为什么不是「永不 resolve 的桩」：那个桩属于**测试**（守卫 G-J 用它证明 UI 不阻塞），
 *   生产里挂一个永不 resolve 的实现只会让队列每次都撞超时。
 */
export function createDegradedSummarizer(reason: string = ONBOARDING_SUMMARY_DEFERRED_REASON): OnboardingSummarizer {
  return async (): Promise<OnboardingSummaryOutcome> => ({
    ok: false,
    degraded: true,
    reason,
    tags: []
  })
}

/** 一个「总能成功」的桩（测试与将来的接线用）：把给定标签原样返回。 */
export function createStaticSummarizer(tags: readonly OnboardingTagWrite[] = []): OnboardingSummarizer {
  return async (): Promise<OnboardingSummaryOutcome> => ({
    ok: true,
    degraded: false,
    reason: '',
    tags: [...tags]
  })
}

/** 一个「永远失败」的桩（测试用：验证只重试 1 次后走降级）。 */
export function createFailingSummarizer(reason = '概括通道不可用'): OnboardingSummarizer {
  return async (): Promise<OnboardingSummaryOutcome> => ({
    ok: false,
    degraded: true,
    reason,
    tags: []
  })
}
