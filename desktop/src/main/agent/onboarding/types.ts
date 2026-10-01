/**
 * 冷启动五问（引导）的**跨模块类型**（票 25 主进程半）。
 *
 * 这一层只放**纯类型**（编译后全部擦除），运行期常量一律从 shared/profile-tags.ts 取 ——
 * 白名单是那一份，绝不在这里抄第二遍。
 *
 * ★ 为什么学段字面量在这里再写一遍（而不是 import 生成物 api-types）：
 *   本目录会被 node --test 直接加载（没有 @shared/* 别名钩子），而学段只是四个封闭字面量 ——
 *   与 ipc/handlers.ts / ipc/handlers-data.ts 里那两处同一条纪律：
 *   **运行期白名单**必须能在不引入生成物的前提下被判据使用。
 */

import type { LlmVisibleTag, OnboardingQuestionId, OnboardingState } from '../../../shared/profile-tags.ts'

export type { LlmVisibleTag, OnboardingQuestionId, OnboardingState }

/** 四个学段（与 shared/ipc-events.ts 的 GradeLevel 逐字一致；此处只做运行期白名单）。 */
export const GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior'] as const

export type GradeLevelLiteral = (typeof GRADE_LEVELS)[number]

/**
 * 标签来源。★ inferred **本轮一条都不用**：
 * 五问的回答是学生自己说的（declared），本地关键词表也只是「从他的话里挑词」，
 * 仍然是 declared（只是置信度低一档）。禁做清单第 10 条把 inferred 限制在
 * 情绪/风格类的白名单内，本轮不碰它是**最省事也最安全**的做法。
 */
export type TagSource = 'declared' | 'observed' | 'inferred'

/** 一条要写进 profile_tags 的候选（**key 必须是白名单内的**，写前还要再过一次 isLlmVisibleTag）。 */
export interface OnboardingTagWrite {
  key: LlmVisibleTag
  value: string
  source: TagSource
  /** 0–1；点选直达 = 1，关键词表 = 0.7（如实反映「这条有多确定」）。 */
  confidence?: number
}

/** 脱敏结论（见 sanitize.ts：命中即整条丢弃，不做「清洗后部分保留」）。 */
export interface SanitizeOutcome {
  /** 可继续使用的文本；命中敏感模式时是回落值（STUDENT_FALLBACK_NAME）。 */
  text: string
  /** 是否命中（命中 = 学生没同意识别的信息，本地不留）。 */
  hit: boolean
  /** 命中的模式名（只进日志与测试断言，**绝不进任何 prompt**）。 */
  pattern: string | null
}

/** 一问的抽取结果（纯数据，不含任何 IO）。 */
export interface OnboardingExtraction {
  questionId: OnboardingQuestionId
  /** 脱敏后的文本（可能是回落值）。 */
  text: string
  piiHit: boolean
  piiPattern: string | null
  /**
   * Q1 抽出的学段（点选直达映射或年级词表）。
   * ★ 只有 Q1 会给出它 —— 其余四问给 null（学段不靠猜）。
   */
  gradeLevel: GradeLevelLiteral | null
  /** Q5 建议的称呼（已过脱敏；命中或没说时是回落值）。只有 Q5 会给。 */
  displayName: string | null
  /** 要写的白名单标签（key 已过白名单，调用方可直接 PUT）。 */
  tags: OnboardingTagWrite[]
}

/** 引导流程的纯状态（state.ts 的唯一值类型）。 */
export interface OnboardingProgress {
  state: OnboardingState
  /** 已收齐的问题 id（**重答是覆盖，不追加** —— 与后端 UNIQUE 语义一致）。 */
  answered: OnboardingQuestionId[]
}

/** 两道闸（identity_local 的字段，主进程读它们决定行为；**它们本身不进 prompt**）。 */
export interface OnboardingGates {
  parentConsent: boolean
  memorySwitch: boolean
}
