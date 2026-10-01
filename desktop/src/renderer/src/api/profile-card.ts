/**
 * 画像标签卡（票 27）+ 家长同意 / 记忆开关（设置页）的**渲染进程侧通道入口**。
 *
 * ── 这一层只做三件事 ────────────────────────────────────────────────────
 *   1. 读标签（profile:tags）与身份行（identity:read）；
 *   2. 撤销一条猜出来的标签（profile:tag-retract）；
 *   3. 写两道闸（identity:flags-set）。
 *
 * ── 界面**不认技术词** ──────────────────────────────────────────────────
 * 标签的 key / 分组维度 / 中文名全部由后端给（dimension 1..12 + label）——
 * 渲染层一个字都不许自己拼（守卫会扫全部渲染进程源码），所以本文件里连一个
 * 标签名都不出现。
 *
 * ── 越界的东西这里一个都没有 ────────────────────────────────────────────
 * 没有 studentId 字段：身份由主进程决定（递进去就等于允许读别人的画像）。
 *
 * ── 形状从哪来 ──────────────────────────────────────────────────────────
 * 载荷类型 import 自 `main/ipc/channels.ts`（B 落的那一份，**唯一形状来源**），
 * 不在渲染层另写一份 —— 契约漂移正是从「两处各写一份形状」开始的。
 * ⚠️ 与契约文档 §3 的命名出入见 `api/onboarding.ts` 文件头那段说明（同一个成因）。
 */

import type { K12Api } from '../../../preload/index'
import type {
  IdentityCallResult,
  IdentityFlagsRequest,
  IdentityPayload,
  ProfileTagView,
  ProfileTagsCallResult,
  ProfileTagsPayload,
  ProfileSummaryCallResult,
  ProfileTimelineCallResult,
  ProfileTimelineEventView,
  ProfileTimelinePayload
} from '../../../main/ipc/channels'
import { ONBOARDING_STATE_SET } from '@shared/profile-tags'
import { warnWiring } from './wiring-notice'

export type {
  IdentityPayload,
  ProfileTagView,
  ProfileTagsPayload,
  ProfileTimelineEventView,
  ProfileTimelinePayload
} from '../../../main/ipc/channels'

/** 标签的来源（三层模型）。★ 界面必须**看得见来源**：猜的那一档要说出来。 */
export type TagSource = ProfileTagView['source']

/** 标签卡一次读取的全部内容（= 主进程给的那份载荷）。 */
export type ProfileTagsView = ProfileTagsPayload
/** 身份行（只给渲染层做本地替换与开关回显用）。 */
/**
 * 归一化引导状态：不在封闭词表里（读不到 / 认不出）一律落 'done'。
 *
 * ★★ 为什么回落值必须是 'done' 而不是 '' 或 'not_started'：
 *   这个字段在别处正是「**该不该弹五问引导**」的判据（'not_started' = 弹）。
 *   如果把「不知道」写成 'not_started'，一次读失败就会让已经答过五问的学生
 *   被重新问一遍 —— 而「不再重问」是这一整套设计的硬承诺（G-I）。
 *   猜错的方向必须是安全的那个：宁可不弹，也不要重问。
 */
function readOnboardingStateOf(value: unknown): IdentityView['onboardingState'] {
  return typeof value === 'string' && ONBOARDING_STATE_SET.has(value)
    ? (value as IdentityView['onboardingState'])
    : 'done'
}

export type IdentityView = IdentityPayload

export interface ProfileCardBridge {
  tags(): Promise<ProfileTagsCallResult>
  /** 撤销一条标签（**有回执**；界面等回执再改，不做乐观更新）。 */
  retract(key: string): Promise<ProfileTagsCallResult>
  identity(): Promise<IdentityCallResult>
  /** 写两道闸（两个字段都可选，只提交要改的那个）。 */
  setFlags(flags: IdentityFlagsRequest): Promise<IdentityCallResult>
  /**
   * 画像变化时间线（§5.2 #11）。
   *
   * ★ **可选能力**：它是后加的一条读通道，缺了只让「变化」那一段不显示，
   *   **不该**把标签卡与两道闸一起拖下线 —— 那会让一个新增功能的缺失
   *   变成「整个画像页坏了」（既有能力被新能力连坐，是本项目踩过的坑）。
   *   所以它不进下面那个四方法探测，单独判一次。
   */
  timeline?: (limit?: number) => Promise<ProfileTimelineCallResult>
  /**
   * 画像小结（三期，2026-09-30）。
   *
   * ★ 与 timeline 同一条纪律：**可选能力** —— preload 没接这条时，五行里的
   *   「小结」那一行显示**后端给的空态文案**，其余四行与整块画像照常工作。
   * ★ 它**不触发生成**（只读主进程缓存）：调用它零等待、零模型开销。
   */
  summary?: () => Promise<ProfileSummaryCallResult>
}

export type ProfileCardBridgeLookup =
  | { ready: true; bridge: ProfileCardBridge }
  | { ready: false; message: string }

/** 整块画像能力不可用时**给学生看的那句话**（说清「用不了 / 还能做什么 / 找谁」）。 */
export const PROFILE_CARD_BRIDGE_MISSING_HINT = '这里暂时看不到我记住的内容，你照常问我问题就好。'

/** 从 `window.api` 上取画像能力（缺一条就整块不可用 —— 它们是一条链上的四个动作）。 */
export function resolveProfileCardBridge(): ProfileCardBridgeLookup {
  if (typeof window === 'undefined' || typeof window.api === 'undefined') {
    warnWiring(
      'profileCard',
      'window.api 缺失：preload 没有加载（整块画像能力不可用）。检查 preload 入口与 contextIsolation / sandbox 配置。'
    )
    return { ready: false, message: PROFILE_CARD_BRIDGE_MISSING_HINT }
  }

  const api: K12Api = window.api
  if (
    typeof api.readProfileTags !== 'function' ||
    typeof api.retractProfileTag !== 'function' ||
    typeof api.readIdentity !== 'function' ||
    typeof api.setIdentityFlags !== 'function'
  ) {
    warnWiring(
      'profileCard.channels',
      'preload 白名单缺少 readProfileTags / retractProfileTag / readIdentity / setIdentityFlags：' +
        '需要主进程注册 profile:tags（invoke）、profile:tag-retract（invoke，带回执）、' +
        'identity:read 与 identity:flags-set（两条 invoke），再由 preload 暴露同名方法。'
    )
    return { ready: false, message: PROFILE_CARD_BRIDGE_MISSING_HINT }
  }

  const bridge: ProfileCardBridge = {
    tags: () => api.readProfileTags(),
    retract: (key) => api.retractProfileTag(key),
    identity: () => api.readIdentity(),
    setFlags: (flags) => api.setIdentityFlags(flags)
  }
  // ★ 时间线单独判：preload 没接这条时就**没有**这个成员（界面据此不渲染那一段），
  //   而不是整块不可用。
  if (typeof api.readProfileTimeline === 'function') {
    bridge.timeline = (limit) => api.readProfileTimeline(limit)
  }
  // ★ 小结同样单独判（三期）：缺了它只是「小结那一行显示空态文案」。
  if (typeof api.readProfileSummary === 'function') {
    bridge.summary = () => api.readProfileSummary()
  }
  return { ready: true, bridge }
}

/** 三档来源，认不出的一律**丢掉整条**（猜一个最近的来源等于对着界面撒谎）。 */
const TAG_SOURCES: readonly TagSource[] = ['declared', 'observed', 'inferred']

/**
 * 一条标签的投影（脏数据回 `null`，调用方忽略它）。
 *
 * ★ 中文名必须由后端给：拿不到就整条不渲染（绝不回落成 key —— 那会把一个英文
 *   字段名摆到一个 10 岁学生面前，看起来像报错）。
 */
/**
 * 时间线视图（= 后端出参形状；主进程已把 title/detail 拼成中文）。
 *
 * ★ 与 normalizeProfileTag 同一原则：**脏数据整条丢弃**，不猜。
 */
export type TimelineView = ProfileTimelinePayload

/**
 * 时间线事件的**出处**（迁移 v7）。
 *
 * ★ 与 `source` 正交：source 说「多可信」，origin 说「从哪条路来的」。
 * ★ 空串是一个**真实取值**：v7 之前的旧行没有出处 —— 不猜、不补。
 */
const TAG_ORIGINS = ['cold_start', 'refresh', 'projection'] as const

function readTagOrigin(value: unknown): ProfileTimelineEventView['origin'] {
  return typeof value === 'string' && (TAG_ORIGINS as readonly string[]).includes(value)
    ? (value as ProfileTimelineEventView['origin'])
    : ''
}

/**
 * 归一化时间线（认不出的整条丢弃）。
 *
 * ★ 为什么没有 title 就丢：界面上一条没有标题的事件就是一个空行，
 *   学生看到的是「这里好像坏了」——宁可不显示。
 * ★ 为什么 kind 认不出时落到 'tag' 而不是丢弃：kind 只决定配色与图标，
 *   丢一条事件等于丢一段真实历史；'tag' 是最中性的那一类。
 */
export function normalizeTimeline(raw: unknown): TimelineView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as { studentId?: unknown; events?: unknown }
  const rawEvents = Array.isArray(record.events) ? record.events : []
  const events: ProfileTimelineEventView[] = []
  for (const item of rawEvents) {
    if (typeof item !== 'object' || item === null) continue
    const event = item as Record<string, unknown>
    const title = typeof event.title === 'string' ? event.title : ''
    if (title.length === 0) continue
    const kind =
      event.kind === 'grade' || event.kind === 'onboarding' ? event.kind : 'tag'
    events.push({
      at: typeof event.at === 'number' ? event.at : 0,
      kind,
      title,
      detail: typeof event.detail === 'string' ? event.detail : '',
      key: typeof event.key === 'string' ? event.key : '',
      label: typeof event.label === 'string' ? event.label : '',
      // ★ 出处（v7）：认不出的一律空串（= 「不知道」），绝不补一个猜测的枚举值。
      origin: readTagOrigin(event.origin)
    })
  }
  return {
    studentId: typeof record.studentId === 'string' ? record.studentId : '',
    events
  }
}

export function normalizeProfileTag(raw: unknown): ProfileTagView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  if (typeof record.key !== 'string' || record.key === '') return null
  if (typeof record.value !== 'string') return null
  if (!TAG_SOURCES.includes(record.source as TagSource)) return null
  if (typeof record.label !== 'string' || record.label.trim() === '') return null

  const dimension = typeof record.dimension === 'number' ? record.dimension : 0
  // 置信度只认 0..1 的数字：后端给别的一律当「没给」（界面据此不显示百分比）。
  const confidence =
    typeof record.confidence === 'number' && record.confidence >= 0 && record.confidence <= 1
      ? record.confidence
      : null

  return {
    key: record.key,
    value: record.value,
    confidence,
    source: record.source as TagSource,
    ts: typeof record.ts === 'number' ? record.ts : 0,
    dimension,
    label: record.label.trim()
  }
}

/** 标签卡载荷的投影（认不出整份回 `null`）。 */
export function normalizeProfileTags(raw: unknown): ProfileTagsView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.tags)) return null
  const tags: ProfileTagView[] = []
  for (const item of record.tags) {
    const tag = normalizeProfileTag(item)
    if (tag !== null) tags.push(tag)
  }
  return {
    tags,
    parentConsent: record.parentConsent === true,
    memorySwitch: record.memorySwitch !== false,
    dimensionLabels: normalizeStringMap(record.dimensionLabels),
    // ★ 五行结构的三张表（2026-09-30）：行标题 / 行↔键映射 / 空态文案。
    //   全部由后端给（双视角纪律）—— 渲染层只按它们取数与拼接，不写任何中文名。
    portraitRowLabels: normalizeStringMap(record.portraitRowLabels),
    portraitRowKeys: normalizeRowKeys(record.portraitRowKeys),
    portraitEmptyNotes: normalizeStringMap(record.portraitEmptyNotes)
  }
}

/**
 * 归一化「字符串 → 非空字符串」的映射（维度名 / 五行行标题 / 空态文案共用）。
 *
 * ★ 渲染层**不认识任何一个具体的中文名**：这里只判「键与值都是非空字符串」。
 *   一个名字都不出现在渲染进程源码里 —— 守卫扫的就是这类字面量。
 * ★ 认不出的**逐条丢掉**，不整份回空：掉一个键不该让别的组标题一起消失，
 *   那样画像卡会退回「一串标签没有小标题」的老样子。
 * ★ 拿不到（老后端 / 桥没接全）就回空对象：界面回落到「不渲染组标题 / 不渲染那一行」，
 *   标签本身照常显示 —— 新能力缺失不许拖垮既有能力（与时间线同一条纪律）。
 * ★ 2026-09-30 起三处共用（原 `normalizeDimensionLabels`）：同一形状的数据
 *   共读一份，避免「一处收紧了、另一处没跟上」。
 */
export function normalizeStringMap(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {}
  const result: Record<string, string> = {}
  for (const [key, label] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '' || typeof label !== 'string' || label.trim() === '') continue
    result[key] = label.trim()
  }
  return result
}

/**
 * 归一化「行 → 该行取哪些标签键」的映射（五行结构，2026-09-30）。
 * ★ 值只保证是**非空字符串数组**；行本身没有标题（`portraitRowLabels` 里查不到）
 *   时界面不渲染那一行 —— 宁可不显示，也不摆一行没有名字的标签。
 */
export function normalizeRowKeys(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null) return {}
  const result: Record<string, string[]> = {}
  for (const [row, keys] of Object.entries(raw as Record<string, unknown>)) {
    if (row === '' || !Array.isArray(keys)) continue
    const list = keys.filter((key): key is string => typeof key === 'string' && key !== '')
    if (list.length > 0) result[row] = list
  }
  return result
}

/**
 * 身份行的投影。
 *
 * ★ displayName 拿不到时**回空串**，由界面回落到中性的「同学」——
 *   这里绝不回落成 realName：那一份只给本地替换用，混进显示层就是把它推上台面。
 */
export function normalizeIdentity(raw: unknown): IdentityView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.anonStudentId !== 'string') return null
  return {
    anonStudentId: record.anonStudentId,
    realName: typeof record.realName === 'string' ? record.realName : '',
    displayName: typeof record.displayName === 'string' ? record.displayName.trim() : '',
    parentConsent: record.parentConsent === true,
    memorySwitch: record.memorySwitch !== false,
    onboardingState: readOnboardingStateOf(record.onboardingState)
  }
}
