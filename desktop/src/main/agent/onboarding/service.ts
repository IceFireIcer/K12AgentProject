/**
 * 引导（对话式五问）的**主进程服务**（票 25 主进程半）。
 *
 * 它同时是两样东西：
 *   ① **五问流程的唯一状态持有者**（内存快照 + 后台串行队列）；
 *   ② **onboarding / profile 端点的主进程出口**（HTTP 只经 bridge/client.ts 的 apiFetch）。
 *
 * ★★ 三条硬纪律（每一条都对应一处验收）：
 *
 * 1. **fire-and-forget（守卫 G-J）**：answer() / skip() / start() 里的**持久化与概括**
 *    全部入队后台跑，**绝不 await**。学生答完第 5 问立刻能正常聊天，
 *    画像在后台补齐。手法与 grade.ts 的上交队列**同款**（串行 + flush + 超时上限）。
 *    ⚠️ 唯一的例外是 start()：它要读服务端的权威状态才敢决定「弹不弹引导」，
 *    这是**界面开场前**的一次读取，不是学生等待的路径。
 *
 * 2. **失败不重试到烦人**：概括最多尝试 2 次（自动重试 1 次），仍失败 -> degraded，
 *    只保留点选/本地映射得到的字段，**引导照常结束**（执行报告 §1.7）。
 *
 * 3. **退出前要 flush**：dispose() = flush()。C 在 runtime.ts 的 dispose() 里
 *    await gradeExtension.flush() 之后（同一段、同一个理由：它也是 /api 调用方）挂一行
 *    await onboardingService.dispose() —— 那两处之间不要插别的收尾步骤。
 *
 * ★★ 学生身份**由主进程决定**：本文件不接收任何 studentId 参数，
 *    身份来自 configure() 注入的 studentId()（生产恒为 ipc/handlers.ts 的 resolveActiveStudentId）。
 *    一旦身份可由渲染进程指定，「读别人的画像」就只是一个字符串的距离。
 *
 * ★ 白名单边界在这里也守一道：写标签前 key 过 isLlmVisibleTag；读回来的标签同样再过一遍
 *   （服务端已经过滤，这里是纵深防御 —— 后端字段风格一变，脏 key 也不会漏进渲染层）。
 */

import {
  isLlmVisibleTag,
  PARENT_CONSENT_DEFAULT,
  STUDENT_FALLBACK_NAME,
  type OnboardingQuestionId,
  type OnboardingState
} from '../../../shared/profile-tags.ts'
import type {
  IdentityFlagsRequest,
  IdentityPayload,
  OnboardingStatePayload,
  ProfileTagView,
  ProfileTagsPayload,
  ProfileTimelineEventView,
  ProfileTimelinePayload
} from '../../ipc/channels.ts'
import { extractAnswer } from './extract.ts'
import {
  initialProgress,
  nextQuestionId,
  readQuestionId,
  recordAnswer,
  selectProgress,
  shouldStartOnboarding
} from './state.ts'
import {
  createDegradedSummarizer,
  ONBOARDING_SUMMARY_MAX_ATTEMPTS,
  ONBOARDING_SUMMARY_TIMEOUT_MS,
  type OnboardingSummarizer,
  type OnboardingSummaryInput,
  type OnboardingSummaryOutcome
} from './summarize.ts'
import type {
  GradeLevelLiteral,
  OnboardingGates,
  OnboardingProgress,
  OnboardingTagWrite
} from './types.ts'

/* ------------------------------------------------------------------ *
 * 端点（路径工厂集中在这里；★ 与契约书 §2 的表逐条对应）
 * ------------------------------------------------------------------ */

export const onboardingStatePath = (studentId: string): string =>
  '/api/onboarding/' + encodeURIComponent(studentId) + '/state'
export const onboardingAnswerPath = (studentId: string): string =>
  '/api/onboarding/' + encodeURIComponent(studentId) + '/answer'
export const profileTagsPath = (studentId: string): string =>
  '/api/profile/' + encodeURIComponent(studentId) + '/tags'
export const profileTagPath = (studentId: string, key: string): string =>
  profileTagsPath(studentId) + '/' + encodeURIComponent(key)
export const profileIdentityPath = (studentId: string): string =>
  '/api/profile/' + encodeURIComponent(studentId) + '/identity'
/** 画像变化时间线（§5.2 #11）。 */
export const profileTimelinePath = (studentId: string, limit?: number): string => {
  const base = '/api/profile/' + encodeURIComponent(studentId) + '/timeline'
  return typeof limit === 'number' && Number.isFinite(limit) ? base + '?limit=' + String(limit) : base
}
export const profileIdentityFlagsPath = (studentId: string): string =>
  profileIdentityPath(studentId) + '/flags'

/** 单次 sidecar 调用超时（与 grade.ts 的 GRADE_TIMEOUT_MS 同一口径）。 */
export const ONBOARDING_REQUEST_TIMEOUT_MS = 8_000

/** flush 的等待上限（队首卡在一个不受我们控制的 await 上时，退出流程不能被无限拖住）。 */
export const ONBOARDING_FLUSH_TIMEOUT_MS = 10_000

/* ------------------------------------------------------------------ *
 * 服务面
 * ------------------------------------------------------------------ */

/** 一帧内存快照（prompt 分支、诊断、IPC 回执都读它）。 */
export interface OnboardingSnapshot {
  state: OnboardingState
  /** ★ 本进程是否正在引导。**只有** start() 判出服务端状态是 not_started 才为 true。 */
  active: boolean
  answered: OnboardingQuestionId[]
  nextQuestionId: OnboardingQuestionId | null
  /** 已经问过几问（= 已收齐的数量）。 */
  askedCount: number
  /** 脱敏后的称呼（不知道时是回落值「同学」）。 */
  displayName: string
  gates: OnboardingGates
  summary: 'idle' | 'pending' | 'ok' | 'degraded'
  lastError: string
  /** 后台队列里还有几项没跑完（flush / 诊断用）。 */
  pending: number
}

/** 接线面（由 ipc/handlers-data.ts 与 ipc/handlers.ts 注入；测试可只给一部分）。 */
export interface OnboardingDeps {
  /** ★ 学生身份（**生产恒为 resolveActiveStudentId**；服务自己不决定身份）。 */
  studentId?: () => string
  /** 当前会话 id（落库审计用；拿不到就给空串，不阻塞任何事）。 */
  sessionId?: () => string
  /**
   * Q1 点选直达：走**既有 grade:set 那条链**（立即生效 + 10 轮冷却 + source=explicit，
   * 且**不写 grade_signals**）。由 ipc/handlers.ts 注入（那里持有 ChatRuntime）。
   */
  applyGradeBand?: (level: GradeLevelLiteral) => Promise<void>
  /** 状态变化推送（唯一一条 M->R 推送通道 onboarding:changed）。 */
  onChanged?: (payload: OnboardingStatePayload) => void
  /** 概括通道（默认 = 降级桩；测试注入永不 resolve 的桩来验证 G-J）。 */
  summarize?: OnboardingSummarizer
  /** sidecar 调用出口（默认 = bridge/client.ts；测试注入替身来断言请求体）。 */
  transport?: OnboardingTransport
  log?: (line: string, level?: 'info' | 'warn' | 'error') => void
  /**
   * ★ 存量学生的五问问答（跨重启补概括用）：从服务端读回 onboarding_qa 的那五条。
   *   返回 null / 空数组 = 拿不到 → 本轮跳过（保持 degraded 等下次），**绝不拿空**
   *   transcript 去打模型（那样只会把状态刷成 ok，把素材永久丢掉）。
   *   注入点在 ipc/handlers.ts（只有那里有 sidecar 出口）。
   */
  loadAnswers?: (studentId: string) => Promise<readonly OnboardingAnswerLike[] | null>
  /** ★ 跨重启的幂等标记：这个学生上次是否已经概括成功过（true = 永不再跑，别每次启动都打模型）。 */
  summaryDone?: (studentId: string) => boolean
  /**
   * ★ 记下**这一次**的结果（跨重启幂等）。只允许两个**状态词**：ok / degraded ——
   *   注入方（ipc/handlers.ts）把它写进本地标记文件，那份文件里**不许出现任何学生文本**。
   *   写失败只记日志，不影响本次结果。
   */
  markSummaryDone?: (studentId: string, ok: boolean) => void
}

/** 一条回读的五问问答（问句原文仍由本地脚本配对，服务端不必回传）。 */
export interface OnboardingAnswerLike {
  questionId: string
  /** 已脱敏的回答文本（入库的是主进程 sanitizeStudentText 之后的产物）。 */
  text: string
}

/**
 * 补跑概括的结果（给触发点写日志用；**绝不抛**）。
 * ran=false 时 reason 说明「为什么没跑」（没答完 / 已经概括过 / 拿不到问答）。
 */
export interface OnboardingRetryOutcome {
  ran: boolean
  reason: string
  added: number
}

export interface OnboardingService {
  /** 接线（幂等；IPC 层注册处理器时调一次）。 */
  configure(deps: OnboardingDeps): void
  /** 读权威状态并决定「弹不弹引导」。★ 这是唯一一次同步等待（界面开场前）。 */
  start(): Promise<OnboardingStatePayload>
  /** 收一问的回答。★ **绝不 await 持久化** —— 入队后台跑，本函数只推内存状态。 */
  answer(questionId: unknown, answerText: unknown): Promise<{ accepted: boolean; message: string }>
  /** 退出前 flush（= flush()，可重复调）。 */
  dispose(): Promise<void>
  /** 当前内存快照（同步，纯读）。 */
  snapshot(): OnboardingSnapshot
  /**
   * ★ 冷启动概括的**补跑一次**（没 Key 时答完五问 → Key 就绪后补上那批素材）。
   * 幂等：成功过就永不再跑；失败保持 degraded 等下次触发。**绝不抛**。
   */
  retrySummary(): Promise<OnboardingRetryOutcome>
}

/* ------------------------------------------------------------------ *
 * HTTP 出口（唯一一处；动态 import bridge/client.ts 的理由同 grade.ts）
 * ------------------------------------------------------------------ */

async function readSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text ? '（' + text.slice(0, 120) + '）' : ''
  } catch {
    return ''
  }
}

/**
 * sidecar 调用出口（**默认 = bridge/client.ts 的 apiFetch**，全项目唯一的 HTTP 出口）。
 * ★ 可注入的理由与 grade.ts 的 submitter / fetcher 同一条：单测要能在**不发真实网络请求**的
 *   前提下断言「请求体里有什么」（尤其是「没有 studentId」这条纪律）。
 *   生产路径永远是 defaultRequestJson —— 这里没有第二套 HTTP 实现。
 */
export type OnboardingTransport = (path: string, init: RequestInit) => Promise<unknown>

export async function defaultRequestJson(path: string, init: RequestInit): Promise<unknown> {
  const { apiFetch } = await import('../../bridge/client.ts')
  const response = await apiFetch(path, { ...init, signal: AbortSignal.timeout(ONBOARDING_REQUEST_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error('HTTP ' + String(response.status) + (await readSnippet(response)))
  }
  return await response.json()
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 * 读回执的归一化（★ 出栈再过一遍白名单）
 * ------------------------------------------------------------------ */

const TAG_SOURCES = ['declared', 'observed', 'inferred'] as const

/**
 * 时间线事件的类别归一化：认不出的一律落到 'tag'。
 *
 * ★ 为什么认不出不丢弃：kind 只决定界面上的**分组与图标**，丢一条事件等于丢一段真实历史；
 *   而 'tag' 是最中性的类别（它只影响配色）。
 * ★ 为什么不用 Record 查表：三个取值写死在这里，与契约的 Literal 逐字对应，
 *   多一个取值就该在这里显式加一行（而不是被查表静默接受）。
 */
function readTimelineKind(value: unknown): ProfileTimelineEventView['kind'] {
  return value === 'grade' || value === 'onboarding' ? value : 'tag'
}

/** 时间线事件的**出处**（迁移 v7）：认不出的一律空串（= 「不知道」，不补猜测值）。 */
const TAG_ORIGINS = ['cold_start', 'refresh', 'projection'] as const

function readTimelineOrigin(value: unknown): ProfileTimelineEventView['origin'] {
  return typeof value === 'string' && (TAG_ORIGINS as readonly string[]).includes(value)
    ? (value as ProfileTimelineEventView['origin'])
    : ''
}

function readTagSource(value: unknown): ProfileTagView['source'] {
  return typeof value === 'string' && (TAG_SOURCES as readonly string[]).includes(value)
    ? (value as ProfileTagView['source'])
    : 'declared'
}

/**
 * 归一化一份 ProfileTagsOut。
 * ★★ 关键的一道：**不在白名单的 key 一个都不返回**（服务端已经过滤，这里是纵深防御）。
 */
export function readProfileTagsPayload(body: unknown): ProfileTagsPayload {
  const record = (body ?? {}) as {
    tags?: unknown
    parentConsent?: unknown
    memorySwitch?: unknown
    dimensionLabels?: unknown
    portraitRowLabels?: unknown
    portraitRowKeys?: unknown
    portraitEmptyNotes?: unknown
  }
  const rawTags = Array.isArray(record.tags) ? record.tags : []
  const tags: ProfileTagView[] = []
  for (const item of rawTags) {
    if (typeof item !== 'object' || item === null) continue
    const tag = item as Record<string, unknown>
    const key = typeof tag.key === 'string' ? tag.key : ''
    if (!isLlmVisibleTag(key)) continue
    tags.push({
      key,
      value: typeof tag.value === 'string' ? tag.value : String(tag.value ?? ''),
      confidence: typeof tag.confidence === 'number' ? tag.confidence : null,
      source: readTagSource(tag.source),
      ts: typeof tag.ts === 'number' ? tag.ts : 0,
      dimension: typeof tag.dimension === 'number' ? tag.dimension : 0,
      label: typeof tag.label === 'string' ? tag.label : key
    })
  }
  return {
    tags,
    parentConsent: record.parentConsent === true,
    memorySwitch: record.memorySwitch !== false,
    dimensionLabels: readStringMap(record.dimensionLabels),
    // ★ 五行结构的三张表（2026-09-30）：**透传**给渲染层 —— 行标题、行↔键映射、
    //   空态文案全部由后端给（双视角纪律 D-063），主进程不解释它们、更不自己拼一份。
    portraitRowLabels: readStringMap(record.portraitRowLabels),
    portraitRowKeys: readKeyGroups(record.portraitRowKeys),
    portraitEmptyNotes: readStringMap(record.portraitEmptyNotes)
  }
}

/**
 * 归一化「字符串 → 非空字符串」的映射（维度名 / 行标题 / 空态文案**共用一份读法**）。
 *
 * ★ 为什么只做「按键过滤」而不做「按值校验」：中文名是**后端给的展示文案**，
 *   主进程不认识任何一个具体的名字（认识就意味着这里也写了一份维度名，
 *   而契约的中文名唯一来源在后端）。这里只保证「键是非空字符串、值也是非空字符串」。
 * ★ 脏项**逐条丢弃**（不是整份回空）：丢一个认不出的键，不该让其余维度的
 *   标题一起消失 —— 那会让画像卡退回「一串标签没有组标题」的老样子。
 * ★ 2026-09-30 起三处共用（原 `readDimensionLabels`）：五行结构的行标题与
 *   空态文案是**同一形状的数据**，各写一份读法迟早会漂（一处收紧了、另一处没跟上）。
 */
function readStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const result: Record<string, string> = {}
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (key === '' || typeof text !== 'string' || text.trim() === '') continue
    result[key] = text
  }
  return result
}

/**
 * 归一化「行 → 该行取哪些标签键」的映射（五行结构，2026-09-30）。
 *
 * ★ 值只保证是**非空字符串数组**：**键的合法性不在这一层判** ——
 *   判它就要在这里复制一份白名单（第二份真相）。真正用键的地方是渲染层取数
 *   （那里用 `isLlmVisibleTag` 与已过滤的 tags 对不上就取不到），所以这里只做形状兜底。
 * ★ 空数组的行直接丢掉：一行没有可取的键，等于界面上一行空白。
 */
function readKeyGroups(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null) return {}
  const result: Record<string, string[]> = {}
  for (const [row, keys] of Object.entries(value as Record<string, unknown>)) {
    if (row === '' || !Array.isArray(keys)) continue
    const list = keys.filter((key): key is string => typeof key === 'string' && key !== '')
    if (list.length > 0) result[row] = list
  }
  return result
}

/** 引导状态字面量（生成的 IdentityOut.onboardingState 是**枚举**，认不出就回 not_started）。 */
function readOnboardingStateValue(value: unknown): IdentityPayload['onboardingState'] {
  return value === 'in_progress' || value === 'done' || value === 'skipped' ? value : 'not_started'
}

/** 归一化一份 IdentityOut。★ 真名只回给渲染层做**本地替换**，主进程这边不进任何 prompt。 */
export function readIdentityPayload(body: unknown): IdentityPayload {
  const record = (body ?? {}) as Record<string, unknown>
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  return {
    anonStudentId: str(record.anonStudentId),
    realName: str(record.realName),
    displayName: str(record.displayName) || STUDENT_FALLBACK_NAME,
    parentConsent: record.parentConsent === true,
    memorySwitch: record.memorySwitch !== false,
    onboardingState: readOnboardingStateValue(record.onboardingState)
  }
}

/* ------------------------------------------------------------------ *
 * 四个 profile / identity 出口（IPC 层直接用；失败抛可读异常，由 IPC 翻成中文回执）
 * ------------------------------------------------------------------ */

export async function fetchProfileTags(
  studentId: string,
  transport: OnboardingTransport = defaultRequestJson
): Promise<ProfileTagsPayload> {
  return readProfileTagsPayload(await transport(profileTagsPath(studentId), { method: 'GET' }))
}

/** L3 一键撤销（DELETE 一条标签；**key 先过白名单**，脏 key 连请求都不发）。 */
export async function retractProfileTag(
  studentId: string,
  key: string,
  transport: OnboardingTransport = defaultRequestJson
): Promise<ProfileTagsPayload> {
  if (!isLlmVisibleTag(key)) throw new Error('不能撤销这个标签：它不在模型可见白名单里。')
  return readProfileTagsPayload(await transport(profileTagPath(studentId, key), { method: 'DELETE' }))
}

/**
 * 读画像变化时间线（§5.2 #11）。
 *
 * ★ 归一化只做「形状兜底」，**不重排、不过滤**：排序与三道闸（G-G / 禁做 #9 / 禁做 #11）
 *   都在后端 —— 主进程再筛一遍就成了第二份判据，两份判据迟早会漂。
 * ★ 事件里的 title/detail 是后端拼好的中文，主进程**原样搬运**。
 */
export async function fetchProfileTimeline(
  studentId: string,
  limit?: number,
  transport: OnboardingTransport = defaultRequestJson
): Promise<ProfileTimelinePayload> {
  const body = (await transport(profileTimelinePath(studentId, limit), { method: 'GET' })) ?? {}
  const record = body as { studentId?: unknown; events?: unknown }
  const rawEvents = Array.isArray(record.events) ? record.events : []
  const events: ProfileTimelineEventView[] = []
  for (const item of rawEvents) {
    if (typeof item !== 'object' || item === null) continue
    const event = item as Record<string, unknown>
    const title = typeof event.title === 'string' ? event.title : ''
    if (title.length === 0) continue
    events.push({
      at: typeof event.at === 'number' ? event.at : 0,
      kind: readTimelineKind(event.kind),
      title,
      detail: typeof event.detail === 'string' ? event.detail : '',
      key: typeof event.key === 'string' ? event.key : '',
      label: typeof event.label === 'string' ? event.label : '',
      // ★ 出处（v7）：原样搬运，认不出的落空串（= 旧行/未知，由界面对应「不显示徽标」）。
      origin: readTimelineOrigin(event.origin)
    })
  }
  return {
    studentId: typeof record.studentId === 'string' ? record.studentId : studentId,
    events
  }
}

export async function fetchIdentity(
  studentId: string,
  transport: OnboardingTransport = defaultRequestJson
): Promise<IdentityPayload> {
  return readIdentityPayload(await transport(profileIdentityPath(studentId), { method: 'GET' }))
}

/**
 * 设置页的两道闸 **+ 引导链路落盘一次称呼**（只发显式给到的字段，**绝不全量覆盖**）。
 *
 * ★ 为什么称呼也走这条 PUT：它是**身份层的一次显式写入**，与两道闸同属 identity_local。
 *   后端复用同一个「身份层唯一写入面」，不再开第二条端点（少一个入口 = 少一处漏检）。
 * ⚠️ 它**不是闸**：写称呼不看 memorySwitch —— 「不再记学习画像」不等于「忘掉学生叫什么」，
 *   绑在一起会让关掉记忆开关的学生连称呼都丢掉（那不是隐私保护，是功能坏了）。
 */
export async function saveIdentityFlags(
  studentId: string,
  flags: IdentityFlagsRequest,
  transport: OnboardingTransport = defaultRequestJson
): Promise<IdentityPayload> {
  const body: Record<string, unknown> = {}
  if (typeof flags.parentConsent === 'boolean') body.parentConsent = flags.parentConsent
  if (typeof flags.memorySwitch === 'boolean') body.memorySwitch = flags.memorySwitch
  if (typeof flags.realName === 'string') body.realName = flags.realName
  if (Object.keys(body).length === 0)
    throw new Error('没有要改的字段（parentConsent / memorySwitch / realName 至少给一个）。')
  return readIdentityPayload(
    await transport(profileIdentityFlagsPath(studentId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  )
}

/* ------------------------------------------------------------------ *
 * 服务本体
 * ------------------------------------------------------------------ */

export function createOnboardingService(initial: OnboardingDeps = {}): OnboardingService {
  let deps: OnboardingDeps = { ...initial }

  let progress: OnboardingProgress = initialProgress()
  let active = false
  let displayName = STUDENT_FALLBACK_NAME
  let gates: OnboardingGates = { parentConsent: PARENT_CONSENT_DEFAULT, memorySwitch: true }
  let summaryStatus: OnboardingSnapshot['summary'] = 'idle'
  let lastError = ''
  /** 当前绑定的学生（换学生 = 把整套内存状态重置，绝不把上一个学生的进度带过来）。 */
  let boundStudentId = ''
  /** 本地抽出的标签（快照与 v2 概括用；写库是逐条 PUT，见 writeTags）。 */
  let localTags: OnboardingTagWrite[] = []
  /** 已收下的答案（脱敏后的文本；v2 概括的输入）。 */
  const answers = new Map<OnboardingQuestionId, string>()
  /** 上一次推出去的载荷指纹（值没变就不推 —— 与 pushGradeState 同一手法）。 */
  let lastPushed = ''

  let pending = 0
  let queue: Promise<void> = Promise.resolve()
  let summarizer: OnboardingSummarizer = initial.summarize ?? createDegradedSummarizer()

  /**
   * sidecar 出口。★ 每次调用时读 deps（而不是启动时快照一个函数）：
   * configure() 可能在建实例之后才接线，快照会让注入形同虚设。
   */
  function callApi(path: string, init: RequestInit): Promise<unknown> {
    return (deps.transport ?? defaultRequestJson)(path, init)
  }

  const log = (line: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
    const sink = deps.log
    if (sink) sink(line, level)
    else if (level === 'warn') console.warn(line)
    else if (level === 'error') console.error(line)
    else console.info(line)
  }

  function studentId(): string {
    return deps.studentId?.() ?? ''
  }

  function resetLocal(nextStudentId: string): void {
    progress = initialProgress()
    active = false
    displayName = STUDENT_FALLBACK_NAME
    gates = { parentConsent: PARENT_CONSENT_DEFAULT, memorySwitch: true }
    summaryStatus = 'idle'
    lastError = ''
    localTags = []
    answers.clear()
    lastPushed = ''
    boundStudentId = nextStudentId
    // ★ 排队里的项也一并作废：它们携带的身份已经不代表「当前学生」了（与 grade.ts 的 F3 同思路）
    queue = Promise.resolve()
    pending = 0
  }

  function ensureStudent(): string {
    const sid = studentId()
    if (sid === '') throw new Error('学生身份还没有接线（应由 ipc/handlers.ts 注入 resolveActiveStudentId）')
    if (sid !== boundStudentId) resetLocal(sid)
    return sid
  }

  function payload(): OnboardingStatePayload {
    return {
      onboardingState: progress.state,
      answered: [...progress.answered],
      // null = 不该再弹了（引导未开始 / 已结束）
      nextQuestionId: active ? nextQuestionId(progress.answered) : null,
      displayName
    }
  }

  function pushState(): void {
    const next = payload()
    const fingerprint = JSON.stringify(next)
    if (fingerprint === lastPushed) return
    lastPushed = fingerprint
    try {
      deps.onChanged?.(next)
    } catch (error) {
      // 推送失败绝不影响流程（渲染层下次读 onboarding:state 就能对上）
      log('[onboarding] 状态推送失败（不影响流程）：' + describeError(error), 'warn')
    }
  }

  function enqueue(task: () => Promise<void>): void {
    pending += 1
    queue = queue
      .then(task)
      .catch((error: unknown) => {
        lastError = describeError(error)
        log('[onboarding] 后台队列异常（已恢复，引导不受影响）：' + lastError, 'warn')
      })
      .finally(() => {
        pending -= 1
      })
  }

  function mergeTags(next: readonly OnboardingTagWrite[]): void {
    const seen = new Set(localTags.map((item) => item.key))
    for (const item of next) {
      if (!isLlmVisibleTag(item.key)) continue
      if (seen.has(item.key)) continue
      seen.add(item.key)
      localTags.push(item)
    }
  }

  /* ---------------------------------------------------------------- *
   * 后台任务（全部入队，绝不 await）
   * ---------------------------------------------------------------- */

  async function writeTags(sid: string, tags: readonly OnboardingTagWrite[]): Promise<void> {
    if (tags.length === 0) return
    // ★★ 两道闸（守卫 G-F / G-G 的主进程一侧）：不同意 / 关了记忆 -> **一个标签都不写**。
    if (!gates.parentConsent || !gates.memorySwitch) {
      log(
        '[onboarding] 画像两道闸已关闭（parentConsent=' +
          String(gates.parentConsent) +
          ' / memorySwitch=' +
          String(gates.memorySwitch) +
          '）：本轮不写任何标签',
        'warn'
      )
      return
    }
    for (const item of tags) {
      // ★★ 写侧也复查白名单（纵深防御，与读侧对称）。白名单闸原来只在「真实 summarizer 的解析」
      //    与 mergeTags 两处，而本函数是**唯一的写库入口**：将来谁给 summarize 注入了不过滤的
      //    实现，脏 key 也进不了库。对白名单内的条目行为零变化。
      if (!isLlmVisibleTag(item.key)) continue
      try {
        await callApi(profileTagPath(sid, item.key), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: item.value, source: item.source, confidence: item.confidence ?? null })
        })
      } catch (error) {
        // 逐条独立：某一条失败不阻塞其它（执行报告 §1.7 的「4 键投影逐条独立写」）
        log('[onboarding] 标签写入失败（逐条独立，不影响其它）：' + item.key + ' —— ' + describeError(error), 'warn')
      }
    }
  }

  async function persistAnswer(
    sid: string,
    questionId: OnboardingQuestionId,
    extraction: ReturnType<typeof extractAnswer>
  ): Promise<void> {
    // ① Q1 点选直达：走既有 grade:set 那条链（立即生效 + 冷却），**不写 grade_signals**
    if (questionId === 'q1' && extraction.gradeLevel !== null && deps.applyGradeBand) {
      try {
        await deps.applyGradeBand(extraction.gradeLevel)
      } catch (error) {
        log('[onboarding] 学段立即生效失败（引导继续，下一轮还会按推断走）：' + describeError(error), 'warn')
      }
    }
    // ② 落库这一问的回答（服务端还会再过一次脱敏 —— 守卫 G-A 在那边）
    const sessionId = deps.sessionId?.() ?? ''
    try {
      await callApi(onboardingAnswerPath(sid), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId,
          answerText: extraction.text,
          ...(sessionId ? { sessionId } : {})
        })
      })
    } catch (error) {
      lastError = describeError(error)
      log('[onboarding] 这一问没有落库（引导继续）：' + lastError, 'warn')
    }
    // ③ 本地抽出的标签逐条投影（白名单键）
    await writeTags(sid, extraction.tags)
    // ④ 称呼**不在这里写**（2026-10-01 用户裁决）：五问的 q5 已换成兴趣 / 动机题，
    //    称呼改为**账号门填的昵称**，由**建号**那条路写进 identity_local.real_name
    //    （见 ipc/handlers-data.ts 的 accounts:create）。本服务对称呼只读不写 ——
    //    否则学生答的爱好会被当成称呼覆盖掉真名。
  }

  /** 概括调用的超时包装（桩挂死时队列不能被无限占住）。 */
  async function summarizeWithTimeout(input: OnboardingSummaryInput): Promise<{ ok: boolean; reason: string; tags: OnboardingTagWrite[] }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<{ ok: boolean; reason: string; tags: OnboardingTagWrite[] }>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, reason: '概括超时（' + String(ONBOARDING_SUMMARY_TIMEOUT_MS) + 'ms）', tags: [] }),
        ONBOARDING_SUMMARY_TIMEOUT_MS
      )
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    try {
      const outcome: OnboardingSummaryOutcome | { ok: boolean; reason: string; tags: OnboardingTagWrite[] } =
        await Promise.race([summarizer(input), limit])
      return { ok: outcome.ok === true, reason: outcome.reason ?? '', tags: outcome.tags ?? [] }
    } catch (error) {
      return { ok: false, reason: describeError(error), tags: [] }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 五问收齐后的概括（**fire-and-forget**；守卫 G-J 的落点）。
   * ★ 失败最多再试 1 次；仍失败 -> degraded，**只保留点选/本地映射得到的字段**，引导照常结束。
   */
  async function runSummary(sid: string): Promise<void> {
    summaryStatus = 'pending'
    const input = {
      answers: [...answers.entries()].map(([questionId, text]) => ({ questionId, text })),
      tags: [...localTags],
      displayName
    }
    for (let attempt = 1; attempt <= ONBOARDING_SUMMARY_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await summarizeWithTimeout(input)
      if (outcome.ok) {
        summaryStatus = 'ok'
        // ★ 概括补出的标签**只写本地没有的**：点选直达与关键词表是学生自己说/点的，
        //   置信度更高；概括不该反过来覆盖它们（写库是逐条 PUT，同 key 会覆盖）。
        const fresh = outcome.tags.filter((item) => !localTags.some((own) => own.key === item.key))
        mergeTags(outcome.tags)
        await writeTags(sid, fresh)
        log('[onboarding] 概括完成（第 ' + String(attempt) + ' 次尝试，新增 ' + String(fresh.length) + ' 条标签）')
        return
      }
      lastError = outcome.reason
      if (attempt < ONBOARDING_SUMMARY_MAX_ATTEMPTS) {
        log('[onboarding] 概括失败，自动重试 1 次：' + outcome.reason, 'warn')
      }
    }
    summaryStatus = 'degraded'
    log('[onboarding] 概括走降级：只保留点选/本地映射得到的字段，引导照常结束', 'warn')
  }

  /**
   * ★★ 冷启动概括的**补跑**（2026-10-01）：没配 Key 时五问照常答完，但那五条回答是最值钱的
   * 冷启动素材 —— 降级一次后就再没机会补，而持续画像只从**后续对话**学，不会回头读它们。
   *
   * 幂等（两处判据，缺一不可）：
   *   · 本进程 summaryStatus === 'ok' → 不再跑；
   *   · 跨重启：注入的 summaryDone() 为真 → 不再跑（否则每次启动都会打一次模型）。
   * 失败**保留 degraded**（下次触发再试）；成功置 ok 并落跨重启标记。
   *
   * 输入优先级：本进程内存里刚收下的五条（学生刚答完就去配 Key 的主场景）→ 否则从服务端
   * **回读**存量问答（deps.loadAnswers）；两条都拿不到就跳过，绝不拿空 transcript 去打模型。
   * 出网纪律不变：只有脱敏回答 + 本地配对的问句原文 + 本地候选标签，真名/身份不进载荷。
   */
  /** 落「这次概括成没成」的状态词（注入失败只记日志：幂等标记丢了顶多多跑一次）。 */
  function markSummary(sid: string, ok: boolean): void {
    try {
      deps.markSummaryDone?.(sid, ok)
    } catch (error) {
      log('[onboarding] 概括状态标记没落盘（下次启动可能再跑一次）：' + describeError(error), 'warn')
    }
  }

  async function retrySummary(): Promise<OnboardingRetryOutcome> {
    // ★ 状态还没读过（界面还没挂载 / 没调 onboarding:state）就先不跑：
    //   ensureStudent() 会因「还没绑定」而重置内存状态，那时 progress 是 idle，
    //   照跑只会得到一句「五问还没答完」的误导日志。
    if (boundStudentId === '') {
      return { ran: false, reason: '引导状态还没读过（等界面挂载后再试）', added: 0 }
    }
    let sid = ''
    try {
      sid = ensureStudent()
    } catch (error) {
      return { ran: false, reason: describeError(error), added: 0 }
    }
    if (summaryStatus === 'ok' || deps.summaryDone?.(sid) === true) {
      return { ran: false, reason: '已经概括过（幂等：不再打模型）', added: 0 }
    }
    if (summaryStatus === 'pending') return { ran: false, reason: '概括正在进行中', added: 0 }
    if (progress.state !== 'done') return { ran: false, reason: '五问还没答完', added: 0 }

    let inputAnswers: Array<{ questionId: OnboardingQuestionId; text: string }> = [
      ...answers.entries()
    ].map(([questionId, text]) => ({ questionId, text }))
    let source = '本进程内存'
    if (inputAnswers.length === 0) {
      let loaded: readonly OnboardingAnswerLike[] | null = null
      try {
        loaded = (await deps.loadAnswers?.(sid)) ?? null
      } catch (error) {
        return { ran: false, reason: '回读五问问答失败：' + describeError(error), added: 0 }
      }
      // ★ 回读的 questionId 是 string：必须过本地那份唯一的位置词表（认不出的整条丢掉），
      //   否则脏 id 会一路进概括载荷（与「靠位置不靠解析」同一条纪律）。
      const narrowed = (loaded ?? [])
        .map((item) => ({ questionId: readQuestionId(item.questionId), text: item.text }))
        .filter(
          (item): item is { questionId: OnboardingQuestionId; text: string } => item.questionId !== null
        )
      if (narrowed.length === 0) {
        return { ran: false, reason: '拿不到五问的问答内容（跳过，保持 degraded 等下次）', added: 0 }
      }
      inputAnswers = narrowed
      source = '服务端回读'
    }

    summaryStatus = 'pending'
    const outcome = await summarizeWithTimeout({
      answers: inputAnswers,
      tags: [...localTags],
      displayName
    })
    if (!outcome.ok) {
      summaryStatus = 'degraded'
      lastError = outcome.reason
      markSummary(sid, false)
      log('[onboarding] 概括补跑失败（保持 degraded，下次触发再试）：' + outcome.reason, 'warn')
      return { ran: true, reason: outcome.reason, added: 0 }
    }
    summaryStatus = 'ok'
    const fresh = outcome.tags.filter((item) => !localTags.some((own) => own.key === item.key))
    // ★ 与首次概括**同一条**写标签路径（白名单 + 逐条 PUT + 两道闸都在 writeTags 里），不另起一套。
    try {
      mergeTags(outcome.tags)
      await writeTags(sid, fresh)
    } catch (error) {
      lastError = describeError(error)
      log('[onboarding] 补跑概括的标签写入失败（不重跑：素材已进本进程内存）：' + lastError, 'warn')
    }
    markSummary(sid, true)
    log('[onboarding] 概括补跑成功（来源：' + source + '，新增 ' + String(fresh.length) + ' 条标签）')
    return { ran: true, reason: '成功', added: fresh.length }
  }

  /* ---------------------------------------------------------------- *
   * 公开面
   * ---------------------------------------------------------------- */

  async function start(): Promise<OnboardingStatePayload> {
    const sid = ensureStudent()
    const body = await callApi(onboardingStatePath(sid), { method: 'GET' })
    const remote = (body ?? {}) as { onboardingState?: unknown; answered?: unknown; displayName?: unknown }
    progress = selectProgress({ state: remote.onboardingState, answered: remote.answered })
    // ★★ G-I（票 31）：**只有 done 是终态** —— in_progress / skipped（历史）/ not_started
    //   都要把没答完的问完；新建会话不参与判据（五问只跟学生走），
    //   判据里也没有「画像是否为空 / 是不是新会话 / localStorage」这些东西。
    active = shouldStartOnboarding(progress.state)
    const remoteName = typeof remote.displayName === 'string' ? remote.displayName.trim() : ''
    displayName = remoteName !== '' ? remoteName : STUDENT_FALLBACK_NAME
    if (active) summaryStatus = 'idle'
    // 两道闸读一次（读不到就按「关闭」处理 —— 隐私上宁可少写，不猜同意）
    try {
      const identity = await fetchIdentity(sid, deps.transport ?? defaultRequestJson)
      gates = { parentConsent: identity.parentConsent, memorySwitch: identity.memorySwitch }
      if (identity.displayName) displayName = identity.displayName
    } catch (error) {
      gates = { parentConsent: false, memorySwitch: false }
      log('[onboarding] 读不到身份/两道闸，按「关闭」处理（本轮不写任何标签）：' + describeError(error), 'warn')
    }
    pushState()
    return payload()
  }

  async function answer(rawQuestionId: unknown, rawAnswerText: unknown): Promise<{ accepted: boolean; message: string }> {
    const questionId = readQuestionId(rawQuestionId)
    if (questionId === null) {
      return { accepted: false, message: '引导回答失败：问题编号不合法（只接受 q1–q5）。' }
    }
    let sid = ''
    try {
      sid = ensureStudent()
    } catch (error) {
      return { accepted: false, message: describeError(error) }
    }
    if (!active) {
      return { accepted: false, message: '引导回答失败：当前不在引导流程里（引导已结束或还没开始）。' }
    }
    // ★★ 靠位置，不靠解析：questionId 是渲染层按展示顺序记下来的，这里**不猜**任何东西，
    //    只做「本地映射 + 入队」。重答同一问是覆盖（recordAnswer 的集合语义）。
    const extraction = extractAnswer(questionId, rawAnswerText)
    progress = recordAnswer(progress, questionId)
    answers.set(questionId, extraction.text)
    mergeTags(extraction.tags)
    const finished = progress.state === 'done'
    if (finished) active = false
    enqueue(() => persistAnswer(sid, questionId, extraction))
    // ★ sid 在**此刻**取进来（而不是 runSummary 里再读一次）：队列是异步跑的，
    //   那时候学生可能已经换了 —— 概括产出的标签要写进**答这五问的那个学生**的库。
    if (finished) enqueue(() => runSummary(sid))
    pushState()
    return { accepted: true, message: '' }
  }

  async function flush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ONBOARDING_FLUSH_TIMEOUT_MS)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    try {
      const outcome = await Promise.race([queue.then(() => 'done' as const), limit])
      if (outcome === 'timeout') {
        log('[onboarding] 退出前锋队列超时（' + String(ONBOARDING_FLUSH_TIMEOUT_MS) + 'ms）：剩余任务不再等待', 'warn')
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function snapshot(): OnboardingSnapshot {
    return {
      state: progress.state,
      active,
      answered: [...progress.answered],
      nextQuestionId: active ? nextQuestionId(progress.answered) : null,
      askedCount: progress.answered.length,
      displayName,
      gates: { ...gates },
      summary: summaryStatus,
      lastError,
      pending
    }
  }

  return {
    configure(next: OnboardingDeps): void {
      deps = { ...deps, ...next }
      if (next.summarize) summarizer = next.summarize
    },
    start,
    answer,
    retrySummary,
    async dispose(): Promise<void> {
      await flush()
    },
    snapshot
  }
}

/** ★ 全进程唯一的服务实例（C 的 grade.ts 与 IPC 处理器都读它）。 */
export const onboardingService: OnboardingService = createOnboardingService()

/**
 * ★★ 契约书 §4 的第一个导出：引导是否进行中（C 在 grade.ts 的 systemPromptFor() 里用它切模式）。
 * 同步纯读 —— 它每轮都被调用，绝不能 await 网络。
 */
export function isOnboardingActive(): boolean {
  return onboardingService.snapshot().active
}
