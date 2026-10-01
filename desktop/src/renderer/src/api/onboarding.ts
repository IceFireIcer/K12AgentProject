/**
 * 对话式冷启动引导（五问）的**渲染进程侧通道入口**。
 *
 * ── 这一层为什么存在 ──────────────────────────────────────────────────────
 * 引导的「该不该问」「问到第几问」「学生刚才说的是哪一问」全是**主进程 / 后端**的事，
 * 渲染进程只做两件事：把状态显示出来、把学生的回答原样递回去。
 * 与 `api/grade.ts` / `api/chapter.ts` 同一口径：**缺通道不抛异常、不白屏**，
 * 屏幕上给一句学生话，接线细节走 {@link warnWiring} 进控制台。
 *
 * ── 弹不弹的判据只有一条 ────────────────────────────────────────────────
 * `onboardingState !== 'done'`（{@link shouldOfferOnboarding}）—— 票 31 起**唯一终态是 done**：
 * 没答完（not_started / in_progress / 历史 skipped）就一直问，跨重启也续。
 * 渲染进程**不许**自己加 localStorage / 装机时间这类标记位 —— 库里已经有权威状态，
 * 再加一份就会出现「界面说没问过、库里说问过了」这种两处真相。
 *
 * ── 形状与命名从哪来 ────────────────────────────────────────────────────
 * 载荷类型 import 自 `main/ipc/channels.ts`（B 落的那一份，**唯一形状来源**）——
 * 不在渲染层另写一份，否则主进程改了字段这里不会报错，那正是契约漂移的起点。
 * 那一份本身也标着「将来换成生成物」：A 的 pydantic 一落地、集成方重跑
 * `export_openapi.py` + `gen:api` 之后，通道两侧一起换。
 *
 * ⚠️ **与契约文档的一处出入（留给集成方）**：§3 把通道方法写成
 *   \`onboardingState / onboardingAnswer / onboardingSkip / onboardingChanged\`，
 *   而 preload（B）实际落的是 \`readOnboardingState / answerOnboarding / onOnboardingChanged\`。
 *   渲染层只能有一个真相，所以这里跟**实际落地**的命名走 ——
 *   ★ 票 31 把 `onboardingSkip` 那条**全链路删掉**了（五问不允许跳过）：
 *     契约文档若仍写着它，以本文件为准（文档那行待同步）。
 */

import type { K12Api } from '../../../preload/index'
import type {
  OnboardingAnswerRequest,
  OnboardingCallResult,
  OnboardingStatePayload
} from '../../../main/ipc/channels'
import type { OnboardingQuestionId } from '@shared/profile-tags'
import { ONBOARDING_STATE_SET, ONBOARDING_QUESTION_IDS } from '@shared/profile-tags'
import { warnWiring } from './wiring-notice'

export type { OnboardingCallResult, OnboardingStatePayload }

/** 引导流程状态（= 主进程给的那份载荷，界面按 id 收窄两个字段）。 */
export type OnboardingStateView = OnboardingStatePayload

/** 交回一问之后主进程的回信（界面只关心收下了没有）。 */
export interface OnboardingAnswerView {
  accepted: boolean
}

export interface OnboardingBridge {
  /** 读一次当前引导状态（挂载 / 每次回答之后都读，作为对齐的唯一落点）。 */
  state(): Promise<OnboardingCallResult<OnboardingStatePayload>>
  /** 把学生对**某一问**的回答递回去（`questionId` 由界面记，不靠解析）。 */
  answer(input: {
    questionId: OnboardingQuestionId
    answerText: string
  }): Promise<OnboardingCallResult<OnboardingAnswerView>>
  /** 订阅状态变化（唯一推送；返回取消订阅函数）。 */
  onChanged(listener: (state: unknown) => void): () => void
}

export type OnboardingBridgeLookup =
  | { ready: true; bridge: OnboardingBridge }
  | { ready: false; message: string }

/**
 * 整块引导能力不可用时**给学生看的那句话**。
 *
 * ★ 说三件事：什么用不了、还能做什么、找谁 —— 与 `GRADE_BRIDGE_MISSING_HINT` 同一写法。
 *   一个词的技术细节都不许有（守卫扫全部渲染进程源码）。
 * ★★ 关键是「**照常可以问问题**」：引导只是前 30 秒的一段流程，它没了绝不能拖住对话。
 */
export const ONBOARDING_BRIDGE_MISSING_HINT = '第一次认识你这一步现在用不了，你直接问我问题就好。'

/**
 * 从 `window.api` 上取引导能力。
 *
 * ★ 按**方法名探测**而不是直接调：引导通道与对话页是两条并行改动，
 *   线没接上时必须让对话页照常可用（而不是抛 `is not a function` 把整页打空）。
 */
export function resolveOnboardingBridge(): OnboardingBridgeLookup {
  if (typeof window === 'undefined' || typeof window.api === 'undefined') {
    warnWiring(
      'onboarding',
      'window.api 缺失：preload 没有加载（整块引导能力不可用）。检查 preload 入口与 contextIsolation / sandbox 配置。'
    )
    return { ready: false, message: ONBOARDING_BRIDGE_MISSING_HINT }
  }

  // ★ 结构检查替代双重断言：先拿到真实白名单类型，再逐方法确认（白名单是分步接线的，
  //   运行时可能缺方法），最后显式拼出要交给上层的桥。三条方法一起探测 ——
  //   它们是同一条流程的三个动作，缺任何一条都走不完。
  //   ★ 票 31 删掉了 skipOnboarding：五问不允许跳过（未答完就续问，直到 done）。
  const api: K12Api = window.api
  if (
    typeof api.readOnboardingState !== 'function' ||
    typeof api.answerOnboarding !== 'function' ||
    typeof api.onOnboardingChanged !== 'function'
  ) {
    warnWiring(
      'onboarding.channels',
      'preload 白名单缺少 readOnboardingState / answerOnboarding / onOnboardingChanged：' +
        '需要主进程注册 onboarding:state / onboarding:answer（两条 invoke，带回执）' +
        '与 onboarding:changed（一条推送），再由 preload 暴露同名方法。'
    )
    return { ready: false, message: ONBOARDING_BRIDGE_MISSING_HINT }
  }

  const request = (input: {
    questionId: OnboardingQuestionId
    answerText: string
  }): OnboardingAnswerRequest => ({ questionId: input.questionId, answerText: input.answerText })
  const bridge: OnboardingBridge = {
    state: () => api.readOnboardingState(),
    answer: (input) => api.answerOnboarding(request(input)),
    // ★ 只把载荷交上去（回调接的是 unknown）：形状过滤在 normalizeOnboardingState 一处做，
    //   避免「边界上校验一次、落库前再校验一次」两份判据迟早不一致。
    onChanged: (listener) => api.onOnboardingChanged(listener)
  }
  return { ready: true, bridge }
}

/**
 * 载荷的**白名单投影**：认得出就返回规范化对象，认不出返回 `null`（调用方忽略该条）。
 *
 * ★ 与 `normalizeGradeState` 同一原则：脏数据一律「忽略而不抛异常」，
 *   绝不猜一个最近的问次 —— 猜错的表现是「学生答的那句被记到别一问上」。
 */
export function normalizeOnboardingState(raw: unknown): OnboardingStateView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  const state = record.onboardingState
  if (typeof state !== 'string' || !ONBOARDING_STATE_SET.has(state)) return null
  // ★ 显式断言而不是再写一遍联合字面量：ONBOARDING_STATE_SET.has 不是类型谓词
  //   （Set.has 的签名收窄不了 string），所以 TS 需要一个断言。
  //   运行期判据就在上一行 —— 断言只是把那个判据的结果告诉类型系统，不掩盖任何东西。
  const onboardingState = state as OnboardingStateView['onboardingState']

  const answered: OnboardingQuestionId[] = []
  if (Array.isArray(record.answered)) {
    for (const item of record.answered) {
      if (typeof item !== 'string') continue
      if (!(ONBOARDING_QUESTION_IDS as readonly string[]).includes(item)) continue
      const id = item as OnboardingQuestionId
      if (!answered.includes(id)) answered.push(id)
    }
  }

  const next = record.nextQuestionId
  const nextQuestionId =
    typeof next === 'string' && (ONBOARDING_QUESTION_IDS as readonly string[]).includes(next)
      ? (next as OnboardingQuestionId)
      : null

  return {
    onboardingState,
    answered,
    nextQuestionId,
    displayName: typeof record.displayName === 'string' ? record.displayName.trim() : ''
  }
}

/**
 * ★★ **该不该弹引导 —— 只有这一个判据**（执行报告 §1.8 / 守卫 G-I；票 31 改判据）。
 *
 * ★ `done` 是唯一终态：其余三态都要把没答完的问完 ——
 *   `in_progress` 是「答了一半」、`skipped` 是**历史**态（跳过入口已删，
 *   新数据不再产生它，但老库里落过它的学生按「没答完」处理）。
 *
 * 明确**不**作为判据的：画像是不是空的、学段是不是学生自己定的、是不是新会话、
 * 本机装多久了。它们全都由「库里那条流程状态」蕴含 —— 多加一条就等于多一处真相。
 */
export function shouldOfferOnboarding(state: OnboardingStateView | null): boolean {
  return state !== null && state.onboardingState !== 'done'
}
