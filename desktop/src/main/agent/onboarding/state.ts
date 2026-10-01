/**
 * 引导状态机（**纯函数**，票 25 主进程半；票 31 改触发语义）。
 *
 * 状态空间：not_started -> in_progress -> done（唯一终态）
 *
 * ★★ 触发判据**只有一条**：state !== 'done'（未到终态就续问，跨重启也续）。
 *   历史 `skipped`（跳过入口已全链路删除，新数据不再产生它）按「没答完」处理，
 *   学生再答一问就回到 in_progress。
 *   **不**作为触发依据的（v2/v4 全被推翻，理由见 shared/profile-tags.ts 的注释）：
 *     · 画像是否为空      —— 学生之后手动改过学段/偏好，画像本来就会「不空」，但不该重问；
 *     · grade source 是否 explicit —— 手动定过学段 != 需要重问五问；
 *     · 是不是新会话      —— 五问只跟学生走，不跟会话走；
 *     · 装机时间 / localStorage   —— 本地 DB 里已经有权威状态，不该再有第二份。
 */

import {
  ONBOARDING_DONE_STATE,
  ONBOARDING_INITIAL_STATE,
  ONBOARDING_QUESTION_IDS,
  ONBOARDING_STATE_SET,
  type OnboardingQuestionId,
  type OnboardingState
} from '../../../shared/profile-tags.ts'
import type { OnboardingProgress } from './types.ts'

/** 冷启动初值（与服务端 identity_local.onboarding_state 的 DEFAULT 同值）。 */
export function initialProgress(): OnboardingProgress {
  return { state: ONBOARDING_INITIAL_STATE, answered: [] }
}

/**
 * ★★ **弹不弹引导的唯一判据**（守卫 G-I 的落点）：
 * 只有 done 是终态；not_started / in_progress / skipped（历史数据）都要把没答完的问完。
 */
export function shouldStartOnboarding(state: OnboardingState): boolean {
  return state !== ONBOARDING_DONE_STATE
}

/** 流程是否还在引导里（prompt 切「引导模式」的判据之一，与 active 标记合起来用）。 */
export function isGuidedState(state: OnboardingState): boolean {
  return state !== ONBOARDING_DONE_STATE
}

/** 下一条**还没答**的问题（按 ONBOARDING_QUESTION_IDS 的固定顺序；都答完给 null）。 */
export function nextQuestionId(answered: readonly OnboardingQuestionId[]): OnboardingQuestionId | null {
  const seen = new Set<OnboardingQuestionId>(answered)
  for (const id of ONBOARDING_QUESTION_IDS) {
    if (!seen.has(id)) return id
  }
  return null
}

/**
 * 归一化一份「从服务端读回来的」进度。
 *
 * ★ 只认冻结词表里的状态与问题 id（认不出的**丢掉**，不猜、不兜底成最近的一个）：
 *   服务端字段风格一变，主进程如果拿 as 断言糊过去，界面会显示一个不存在的引导态。
 */
export function selectProgress(input: {
  state?: unknown
  answered?: unknown
}): OnboardingProgress {
  const state =
    typeof input.state === 'string' && ONBOARDING_STATE_SET.has(input.state)
      ? (input.state as OnboardingState)
      : ONBOARDING_INITIAL_STATE
  const answered: OnboardingQuestionId[] = []
  if (Array.isArray(input.answered)) {
    for (const item of input.answered) {
      const id = readQuestionId(item)
      if (id !== null && !answered.includes(id)) answered.push(id)
    }
  }
  return { state, answered }
}

/** 读一个问题 id；不是 q1..q5 之一返回 null（**不猜**）。 */
export function readQuestionId(value: unknown): OnboardingQuestionId | null {
  return typeof value === 'string' && (ONBOARDING_QUESTION_IDS as readonly string[]).includes(value)
    ? (value as OnboardingQuestionId)
    : null
}

/**
 * 收下一条回答（**重答是覆盖，不追加**）。
 *
 * 语义细节：
 *   · 第一次回答把状态从 not_started 推到 in_progress（状态机的第二条箭头）；
 *   · 五问收齐 -> done（调用方据此投递概括）；
 *   · **已经是 done 时再收到回答不改变状态** —— 引导已经结束了，
 *     学生的后续消息是普通对话（渲染层不该再发 onboarding:answer，这里只是兜住）；
 *   · 历史 skipped 收到回答 -> 回到 in_progress（跳过入口已删，skipped 只是没答完的一种）。
 */
export function recordAnswer(progress: OnboardingProgress, questionId: OnboardingQuestionId): OnboardingProgress {
  const answered = progress.answered.includes(questionId)
    ? [...progress.answered]
    : [...progress.answered, questionId]
  if (progress.state === 'done') {
    return { state: progress.state, answered }
  }
  return { state: nextQuestionId(answered) === null ? 'done' : 'in_progress', answered }
}

/** 流程是否已经结束（done = 唯一终态）—— 引导模式 prompt 到这一步必须切回正常模式。 */
export function isFinished(state: OnboardingState): boolean {
  return !isGuidedState(state)
}
