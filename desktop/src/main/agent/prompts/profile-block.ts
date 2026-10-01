/**
 * ★★ 画像标签在 Prompt 里的**白名单投影唯一出口**（票 26 / 执行报告 §0.6 的物理落实）。
 *
 * ---------------------------------------------------------------------------
 * 这个文件存在的理由：模型只能看见白名单里的标签
 * ---------------------------------------------------------------------------
 * §0.6 的核心边界是**白名单投影**而不是「过滤敏感词」：不在 `LLM_VISIBLE_TAGS` 里的字段
 * **没有出口** —— 不是「被正则滤掉了」，是**压根拼不出这一段文本**。所以本文件的纪律是：
 *   ① 只投影白名单里的键（`LLM_VISIBLE_TAG_SET` 是唯一的判据，**不要**在这里 includes 手写词表）；
 *   ② 本地身份层（真名 / 精确年级 / 学校 / 班级 / 两道闸 / 引导流程状态）**一条都不读**
 *      —— 本文件里不存在任何读它的路径，也不 import 任何会读它的模块（守卫 G-C 盯这一点）；
 *   ③ 出栈再挡一次脏值：情绪必须是有限枚举（禁做 12「心理诊断」）、强度必须在 0–3、时长类标签
 *      过了 TTL 就当**不存在**（禁做 11「长期负面情绪档案」）。
 *
 * ---------------------------------------------------------------------------
 * ★ D-032：这一段是 system prompt 的**前缀缓存**最前面的一段，必须逐字节稳定
 * ---------------------------------------------------------------------------
 * 前缀缓存按「从头开始的最长相同前缀」命中，所以这一段里任何每轮都会变的字节
 * （时间戳、计数器、会话 id、随机的键序）都会让整段前缀连同**它后面的全部对话历史**
 * 一起丢掉命中。因此本文件：
 *   · **不放任何时间**（`ts` 只用来判断 TTL，绝不渲染）；
 *   · 标签顺序**固定按 `LLM_VISIBLE_TAGS` 的声明序**（不是字母序、不是输入顺序）；
 *   · 置信度按固定规则格式化（四舍五入到整百分点）；
 *   · 同键冲突按固定优先级取（学生自述 > 系统观察 > 系统推断），平局再按固定次序。
 *   ⇒ 同样的标签 → **逐字节相同**的段；只有标签真的变了，段才变。
 *
 * ---------------------------------------------------------------------------
 * ★ 三条铁律里的两条在这里落地（票 30 · C6）
 * ---------------------------------------------------------------------------
 *   1. **L3 推断永远不能写 L1**：本文件是**只读**的 —— 它没有任何写接口，也不 import 任何
 *      写路径（PUT/POST 只出现在「读标签」的那一次 GET 上）；同键冲突时**声明层赢**，
 *      所以推断值覆盖不了学生自己说过的话。
 *   2. **每个 L3 标签带来源与置信度**：`ProjectedTag.source` 是必填字段，
 *      渲染时把来源写成中文（学生自述 / 系统观察 / 系统推断）并带上置信度，
 *      界面（渲染层）显示「这是猜的，75%」时用的是同一份数据。
 *
 * ★ 不缓存、不落第二份副本（与 `extensions/profile.ts` 同一条纪律）：每轮真读一次。
 */

import {
  EMOTION_LABELS,
  EMOTION_VALUE_SET,
  EPHEMERAL_TAG_SET,
  EPHEMERAL_TTL_MS,
  INTENSITY_MAX,
  INTENSITY_MIN,
  JOIN_KEY,
  LLM_VISIBLE_TAGS,
  LLM_VISIBLE_TAG_SET,
  PARENT_CONSENT_DEFAULT
} from '@shared/profile-tags'
import type { LlmVisibleTag } from '@shared/profile-tags'
// ★ 两个锚点标题：本模块的段固定插在它们**之前**（见 withPromptSections）。
//   ⚠️ 只在**函数体内**读它们（不在模块顶层 const 里）：`prompts/student-context.ts` 与本模块
//   处在同一条循环导入链上，顶层读对方的值会踩 TDZ（本仓库已有同样的教训，见 profile.ts 头部）。
import { GRADE_OVERRIDE_HEADING } from '../extensions/grade.ts'
import { STUDENT_CONTEXT_HEADING } from './student-context.ts'

/* ------------------------------------------------------------------ *
 * 类型：契约（A 的 ProfileTagOut / ProfileTagsOut）在 TS 侧的最小消费面
 * ------------------------------------------------------------------ */

/**
 * 标签的来源层（与后端 `ProfileTagOut.source` 同形）。
 *
 * ★ 三层语义：`declared` = 学生自己说的（L2，可信度中高）；`observed` = 系统观察到的事实
 * （L1/L2 之间，如判分结果）；`inferred` = 模型/规则**猜**的（L3，最低，必须可解释可撤销）。
 */
export type ProfileTagSource = 'declared' | 'observed' | 'inferred'

/** 后端来的一个标签（**宽松读**：每个字段都当 unknown 校验，脏值丢掉而不是往下传）。 */
export interface RawProfileTag {
  key?: unknown
  value?: unknown
  confidence?: unknown
  source?: unknown
  ts?: unknown
  label?: unknown
}

/** `GET /api/profile/{sid}/tags` 的回执（`parentConsent` 是**闸**不是信息）。 */
export interface ProfileTagsPayload {
  tags?: unknown
  parentConsent?: unknown
  memorySwitch?: unknown
}

/** 投影后的一个标签（**每个字段都是可信的**：投影已经过白名单 + 脏值 + TTL 三道）。 */
export interface ProjectedTag {
  readonly key: LlmVisibleTag
  /** 中文名：**优先用后端给的 `label`**（唯一来源），缺了才回落到本地映射。 */
  readonly label: string
  /** 已经单行化、截断、并做过取值域校验的值。 */
  readonly value: string
  readonly source: ProfileTagSource
  /** 0–1；后端没给就是 `null`（**不编一个 0.5 出来**）。 */
  readonly confidence: number | null
}

/** 一次的投影结果。`parentConsent=false` 时 `tags` 一定是空的（G-G 的这一半）。 */
export interface ProfileProjection {
  readonly tags: readonly ProjectedTag[]
  readonly parentConsent: boolean
}

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 单个标签值的长度上限（防止某条自由文本把每轮的 prompt 预算吃光）。 */
export const MAX_TAG_VALUE_CHARS = 40

/**
 * 标签键 → 中文名的**本地兜底**（只在后端没给 `label` 时用）。
 *
 * ⚠️ 中文名的**唯一来源仍然是后端**（契约 §2.1：`label` 放后端是刻意的，
 * 渲染层不写技术词）。这里只为「后端漏给 label」这一种情况兜底，不是第二份真相。
 */
export const TAG_LABELS_FALLBACK: Readonly<Record<string, string>> = {
  anon_student_id: '匿名标识',
  grade_band: '学段档位',
  subject: '学科',
  course_module: '课程模块',
  current_topic: '最近在学的主题',
  knowledge_point: '最近知识点',
  mastery: '掌握程度',
  error_type: '错误模式',
  zpd_level: '难度档',
  explain_style: '讲法偏好',
  output_length: '回答长度偏好',
  pace: '节奏偏好',
  practice_type: '练习偏好',
  interest_topic: '兴趣方向',
  emotion: '这一轮的情绪',
  intensity: '情绪强度',
  trigger: '情绪起因',
  confidence: '把握程度',
  tone: '语气偏好',
  encouragement_freq: '需要鼓励的程度',
  challenge_level: '挑战偏好',
  scene: '使用场景',
  task_goal: '当前目标',
  safety_level: '安全等级',
  boundary_topics: '敏感话题边界'
}

/** 来源层的**中文说法**（模型与界面看到的是这个，不是英文枚举）。 */
export const SOURCE_LABELS: Readonly<Record<ProfileTagSource, string>> = {
  declared: '学生自述',
  observed: '系统观察',
  inferred: '系统推断'
}

/** 三层优先级：**数字小的赢**（学生自述永远压过推断 —— C6 铁律 1）。 */
const SOURCE_RANK: Readonly<Record<ProfileTagSource, number>> = {
  declared: 0,
  observed: 1,
  inferred: 2
}

/* ------------------------------------------------------------------ *
 * 纯函数：投影
 * ------------------------------------------------------------------ */

/** 单行化 + 截断（脏长文本是长期的预算与合规风险）。 */
function cleanValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  return flat.length > MAX_TAG_VALUE_CHARS ? flat.slice(0, MAX_TAG_VALUE_CHARS - 1) + '…' : flat
}

/** 认得出的来源才用，认不出的一律当 `inferred`（**最不可信**的那个，绝不往高估）。 */
function readSource(value: unknown): ProfileTagSource {
  return value === 'declared' || value === 'observed' || value === 'inferred' ? value : 'inferred'
}

/** 置信度：0–1 的有限数（字符串数字也认；越界夹到边界；认不出是 `null`）。 */
function readConfidence(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.max(0, Math.min(1, numeric))
}

/** 取数字（用于强度；认不出是 `null`）。 */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value.trim())
    if (Number.isFinite(numeric)) return numeric
  }
  return null
}

/**
 * 取值域校验（禁做 12：情绪的取值域是**有限枚举**，不是临床词汇）。
 *
 * ★ 为什么在投影这一层也要挡：后端是权威（A 侧契约里同样有限制），但投影是**出网的最后一道**
 *   —— 只要库里出现一个「抑郁」「焦虑」这类值，模型就会把它当成心理诊断标签来用。
 *   认不出的值一律**丢掉整条标签**（不是改写、不是打折）。
 * ★ 强度同样校验：`intensity` 只允许 0–3 的小整数（分值会诱发「优化分数」的坏文化）。
 */
function acceptValue(key: string, value: string): boolean {
  if (key === 'emotion') return EMOTION_VALUE_SET.has(value)
  if (key === 'intensity') {
    const numeric = readNumber(value)
    return numeric !== null && Number.isInteger(numeric)
      && numeric >= INTENSITY_MIN && numeric <= INTENSITY_MAX
  }
  return true
}

/** 中文名：优先后端给的 `label`，缺了才回落到本地映射，最后回落到键本身。 */
function labelFor(key: string, raw: unknown): string {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  return TAG_LABELS_FALLBACK[key] ?? key
}

/**
 * 时长类标签是否**已经过期**（执行报告 §0.6.5：3 轮会话或 24 小时，取先到）。
 *
 * ★ 轮次那一半由后端（A）负责（它在库里能数轮次）；这一半是**本地按墙上时间**再挡一次 ——
 *   投影是出网的最后一道，宁可就地丢掉，也不把一句「上次考试崩了」带进今天这一轮。
 * ★ 没有 `ts`（旧数据 / 后端没给）时**不判过期**（信息不足时不猜，交给后端那道闸）。
 */
function isExpired(key: string, ts: unknown, now: number): boolean {
  if (!EPHEMERAL_TAG_SET.has(key)) return false
  const stamp = readNumber(ts)
  if (stamp === null || stamp <= 0) return false
  return now - stamp > EPHEMERAL_TTL_MS
}

/**
 * ★★ **白名单投影**（纯函数，可单测）—— 模型能看见的画像就是这个函数的返回值。
 *
 * 六道过滤，顺序有意义：
 *   ① `parentConsent === false` → **一条都不投影**（G-G：不同意就不外发任何画像）；
 *   ② 非白名单键 → 丢（**这就是白名单本身**，不是「过滤掉敏感词」）；
 *   ③ 空键 / 空值 → 丢；
 *   ④ 取值域非法（情绪枚举、强度范围）→ 丢；
 *   ⑤ 时长类标签过期 → 丢（EPHEMERAL_TTL_MS）；
 *   ⑥ 同键冲突 → 按来源优先级取（**学生自述赢**，C6 铁律 1）；平局按 confidence、ts、值
 *      依次比较，所以**输入顺序不影响输出**（D-032 的字节稳定）。
 * 最后按 `LLM_VISIBLE_TAGS` 的**声明序**输出。
 */
export function projectProfileTags(
  payload: ProfileTagsPayload | null | undefined,
  options: { now?: number; includeJoinKey?: boolean } = {}
): ProfileProjection {
  const parentConsent =
    payload?.parentConsent === false
      ? false
      : payload?.parentConsent === true
        ? true
        : PARENT_CONSENT_DEFAULT
  if (!parentConsent) return { tags: [], parentConsent: false }

  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const includeJoinKey = options.includeJoinKey === true
  const raw = Array.isArray(payload?.tags) ? (payload?.tags as RawProfileTag[]) : []

  /** key → 胜出的那条（同键冲突在下面按固定次序解决）。 */
  const winners = new Map<string, { tag: ProjectedTag; ts: number }>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    if (key.length === 0) continue
    if (!LLM_VISIBLE_TAG_SET.has(key)) continue
    if (key === JOIN_KEY && !includeJoinKey) continue
    const value = cleanValue(item.value)
    if (value.length === 0) continue
    if (!acceptValue(key, value)) continue
    if (isExpired(key, item.ts, now)) continue
    const candidate: ProjectedTag = {
      key: key as LlmVisibleTag,
      label: labelFor(key, item.label),
      value,
      source: readSource(item.source),
      confidence: readConfidence(item.confidence)
    }
    const ts = readNumber(item.ts) ?? 0
    const previous = winners.get(key)
    if (!previous || betterCandidate(candidate, ts, previous.tag, previous.ts)) {
      winners.set(key, { tag: candidate, ts })
    }
  }

  const rank = (key: string): number => (LLM_VISIBLE_TAGS as readonly string[]).indexOf(key)
  const tags = [...winners.values()]
    .map((entry) => entry.tag)
    .sort((a, b) => rank(a.key) - rank(b.key))

  return { tags, parentConsent: true }
}

/**
 * 同键冲突时谁赢（**必须是全序**，否则输入顺序会影响输出 —— D-032）。
 *
 * 次序：来源优先级 → 置信度高者 → `ts` 新者 → 值字典序小者 → 键字典序。
 * ★ 最后两个兜底键看着多余，但没有它们时「两条完全同分的候选」谁赢取决于数组顺序，
 *   于是**同样的数据换个行序就会渲染出不同的段**（那正是前缀缓存最怕的抖动）。
 */
function betterCandidate(a: ProjectedTag, aTs: number, b: ProjectedTag, bTs: number): boolean {
  const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
  if (bySource !== 0) return bySource < 0
  const byConfidence = (a.confidence ?? -1) - (b.confidence ?? -1)
  if (byConfidence !== 0) return byConfidence > 0
  if (aTs !== bTs) return aTs > bTs
  const byValue = a.value.localeCompare(b.value)
  if (byValue !== 0) return byValue < 0
  return a.key.localeCompare(b.key) < 0
}

/* ------------------------------------------------------------------ *
 * 纯函数：渲染
 * ------------------------------------------------------------------ */

/** 值的展示形态（情绪用中文枚举名；其余原样）。 */
export function displayValue(tag: ProjectedTag): string {
  if (tag.key === 'emotion') {
    const label = (EMOTION_LABELS as Record<string, string>)[tag.value]
    return typeof label === 'string' ? label : tag.value
  }
  return tag.value
}

/** 置信度的展示形态（四舍五入到整百分点 —— 固定规则才能字节稳定）。 */
export function displayConfidence(tag: ProjectedTag): string {
  if (tag.confidence === null) return ''
  return `${Math.round(tag.confidence * 100)}%`
}

/** 按来源分组（顺序固定：自述 → 观察 → 推断）。 */
function groupBySource(tags: readonly ProjectedTag[]): Array<[ProfileTagSource, ProjectedTag[]]> {
  const order: ProfileTagSource[] = ['declared', 'observed', 'inferred']
  return order
    .map((source): [ProfileTagSource, ProjectedTag[]] => [
      source,
      tags.filter((tag) => tag.source === source)
    ])
    .filter(([, items]) => items.length > 0)
}

/**
 * 画像段的正文（**不含标题**；没有标签时是空串 —— 绝不产生只有标题的空壳段）。
 *
 * 形态：
 * ```text
 * - 学生自述：学段档位=小学高年级（学生自述）；学科=数学、科学（学生自述）
 * - 系统观察：难度档=偏易（系统观察 60%）
 * - 这些是内部标签：不要念给学生听，也不要用它去给学生贴标签（他随时可以改）。
 * ```
 */
export function renderProfileSectionBody(projection: ProfileProjection | null): string {
  const tags = projection?.tags ?? []
  if (tags.length === 0) return ''
  const lines: string[] = []
  for (const [source, items] of groupBySource(tags)) {
    // 组内不再重复写来源（组标题已经写了），省下每轮都在花的 prompt 预算
    const body = items
      .map((tag) => {
        const confidence = displayConfidence(tag)
        return confidence === ''
          ? `${tag.label}=${displayValue(tag)}`
          : `${tag.label}=${displayValue(tag)}（${confidence}）`
      })
      .join('；')
    lines.push(`- ${SOURCE_LABELS[source]}：${body}`)
  }
  lines.push(
    '- 这些是系统内部整理的标签，**不要念给学生听**，也不要用它给学生贴标签（他可以随时改）。'
  )
  return lines.join('\n')
}

/**
 * ★★ 学段判定用的**画像摘要**（票 26 / D-073 的老问题）。
 *
 * D-073 的根因：高中生提问往往也很朴素（「什么是集合」「这题怎么做」），判定提示词里
 * 只有 5–8 句问句时，模型只能按「看起来深不深」猜 —— 于是 senior 几乎只在学生自报年级时
 * 才被提出来。这里把**学生自己说的学段档位**与**系统观察到的风格/卡点**补进判定提示词，
 * 让判定手里真的有一条身份侧的证据。
 *
 * ⚠️ **只放判定用得上的那几条**（学段档位 / 学科 / 讲法偏好 / 节奏 / 最近知识点 / 错误模式 /
 * 难度档）。掌握度明细、错题清单、老师说过的话一律**不放** —— 对判学段没有帮助，
 * 只会把真正有用的几行稀释掉（执行报告 §3 的明确要求）。
 * 返回空串 = 没有任何可用标签（调用方据此**不加**这一段）。
 */
export const JUDGE_PERSONA_KEYS: readonly string[] = [
  'grade_band',
  'subject',
  'explain_style',
  'pace',
  'knowledge_point',
  'error_type',
  'zpd_level'
]

/** 学段判定摘要的正文（带键名，便于模型把「档位」与「精确年级」区分开）。 */
export function buildJudgePersona(projection: ProfileProjection | null): string {
  const tags = (projection?.tags ?? []).filter((tag) => JUDGE_PERSONA_KEYS.includes(tag.key))
  if (tags.length === 0) return ''
  const lines: string[] = ['【这名学生已有的画像标签（系统按白名单投影，仅供参考）】']
  for (const [source, items] of groupBySource(tags)) {
    const body = items
      .map((tag) => {
        const confidence = displayConfidence(tag)
        const suffix = confidence === '' ? `${tag.key}` : `${tag.key}，置信度 ${confidence}`
        return `${tag.label}=${displayValue(tag)}（${suffix}）`
      })
      .join('；')
    lines.push(`- ${SOURCE_LABELS[source]}：${body}`)
  }
  lines.push(
    '- 把它当**一条**证据用：学生自己说的学段档位比系统推断可信；与他这次问的内容矛盾时以内容为准。'
  )
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * ★ 段注入原语（幂等 + 位置固定）
 * ------------------------------------------------------------------ */

/**
 * ★★ 偏好自动识别（§5.2 #2）：从**行为观察**给出偏好建议（L3 推断）。
 *
 * 计划原话：「**偏好自动识别**（从行为补偏好）L3→L2：不靠问卷也能长满画像」。
 *
 * ## ★★ 它只**产出建议**，绝不写库 —— 这是三条铁律第 1 条
 * 「L3 推断永远不能写 L1/L2」。本函数是**纯函数**：只读入参、无副作用、不 import 任何写路径。
 * 返回的是建议列表，**采不采纳是用户的动作**（画像卡上的纠错入口就是那个动作）。
 * ⚠️ 一旦让它自己写进 `profile_pref`，就会出现「系统猜错了、学生却以为是自己设的」——
 *   那是比「画像长得慢」严重得多的错（D-020 反复吃过的教训）。
 *
 * ## 回落
 * 数据不足 → 返回**空数组**（不猜）。学生已经明说过的键也不再建议
 * （`source='declared'` 的更可信，拿推断去覆盖它正是 D-020 那个错）。
 */
export interface PreferenceSuggestion {
  readonly key: LlmVisibleTag
  readonly value: string
  readonly confidence: number
  /** 一句给学生看的中文理由（界面要能回答「你凭什么这么猜」）。 */
  readonly reason: string
}

/** 推断建议的置信度上限：**刻意压低** —— 它是猜的，不该看起来像学生说过的话。 */
export const INFERRED_SUGGESTION_MAX_CONFIDENCE = 0.4

export function inferPreferences(projection: ProfileProjection | null): PreferenceSuggestion[] {
  const suggestions: PreferenceSuggestion[] = []
  if (projection === null || !projection.parentConsent) return suggestions
  // 学生**明说**过的键不再建议：声明的可信度天然高于任何推断（L2 > L3）。
  const declared = new Set(
    projection.tags.filter((tag) => tag.source === 'declared').map((tag) => tag.key)
  )

  // ★ 局部查找而不是从 adaptation.ts 借 tagOf：那边是**另一个模块的**工具，
  //   借过来会让两个文件的依赖方向变成环（adaptation 已 import 本模块）。
  const pick = (key: string): string =>
    projection.tags.find((tag) => tag.key === key)?.value ?? ''
  const zpd = pick('zpd_level')
  const errorType = pick('error_type')

  // ① 难度档偏易 + 学生没说过节奏 → 建议放慢（「偏易」通常意味着他需要更细的步子）
  if (!declared.has('pace') && /偏易|较易|容易|1/.test(zpd)) {
    suggestions.push({
      key: 'pace',
      value: '慢一点',
      confidence: 0.35,
      reason: '最近练的题对他来说偏容易，但你可能更希望每一步都讲清楚 —— 要不要我把节奏放慢一点？'
    })
  }

  // ② 反复概念混淆 + 学生没说过讲法 → 建议多用具体例子
  if (!declared.has('explain_style') && errorType === '概念混淆') {
    suggestions.push({
      key: 'explain_style',
      value: '多举生活里的例子',
      confidence: INFERRED_SUGGESTION_MAX_CONFIDENCE,
      reason: '你在同一个知识点上反复卡住，可能抽象讲法不够 —— 要不要我多举几个生活里的例子？'
    })
  }

  return suggestions
}


/** 一个可注入的稳定段：标题行 + 正文（正文空 = 这一段不出现）。 */
export interface PromptSection {
  heading: string
  body: string
}

/** 画像标签段（本轮投影出来的标签）。 */
export const PROFILE_SECTION_HEADING = '## 这位学生的画像标签（系统自动投影，只含白名单标签）'
/** 学段内难度微调段（票 30）。 */
export const DIFFICULTY_SECTION_HEADING = '## 讲法微调（同一学段内，只调怎么讲）'
/** 受挫处置的定向段（票 29，覆盖 `rules.ts` 那一节的一般说法）。 */
export const FRUSTRATION_SECTION_HEADING = '## 这一轮的情绪处置（按画像定向，覆盖上一节的一般说法）'
/** 风格驱动的**工具先后**段（§5.2 #4；只调先后，不加能力）。 */
export const STYLE_TOOL_SECTION_HEADING = '## 工具先后（按这位学生的偏好调整，只影响顺序）'

/**
 * 本模块会往 prompt 里注入的**全部**段标题。
 *
 * ★ 清理时要能删掉「这一轮不再出现」的段（例如情绪标签过期了 → 定向段消失），
 *   所以名单必须是**全集**，而不是「这一轮传进来的那几个」。
 */
export const TURN_SECTION_HEADINGS: readonly string[] = [
  PROFILE_SECTION_HEADING,
  DIFFICULTY_SECTION_HEADING,
  STYLE_TOOL_SECTION_HEADING,
  FRUSTRATION_SECTION_HEADING
]

/** 段标题在行首（`indexOf` 会命中正文里偶然出现的同样字样，那样会切错位置）。 */
function lineStartIndex(text: string, heading: string): number {
  let from = 0
  for (;;) {
    const at = text.indexOf(heading, from)
    if (at < 0) return -1
    if (at === 0 || text[at - 1] === '\n') return at
    from = at + heading.length
  }
}

/** 合并多余空行 + 去尾部空白（幂等的前提：拼装与清理都收敛到同一个规范形态）。 */
function normalizePrompt(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n+$/, '')
}

/**
 * 去掉本模块注入过的段（**幂等的前提**）。找不到任何标题时**逐字返回**（不动别人的 prompt）。
 *
 * 边界判据是「下一个一到六级标题行」而不是「切到字符串末尾」：学段权威段
 * （{@link GRADE_OVERRIDE_HEADING}）与学生情况块（{@link STUDENT_CONTEXT_HEADING}）就排在
 * 这些段**后面**，照「切到末尾」会把它们一起切掉 —— 那是本项目已经吃过一次的经典回归。
 */
export function stripPromptSections(
  prompt: string,
  headings: readonly string[] = TURN_SECTION_HEADINGS
): string {
  if (typeof prompt !== 'string' || prompt.length === 0) return prompt
  if (!headings.some((heading) => prompt.includes(heading))) return prompt
  const lines = prompt.split('\n')
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (headings.includes(line.trim())) {
      skipping = true
      continue
    }
    if (skipping) {
      if (/^#{1,6}\s/.test(line)) skipping = false
      else continue
    }
    kept.push(line)
  }
  return normalizePrompt(kept.join('\n'))
}

/**
 * 把若干稳定段插到 **学生情况块 / 学段权威段之前**（幂等：先清旧段，再插新段）。
 *
 * ★ 插入点选在「学生情况块之前，没有学生情况块时退到学段权威段之前」：
 *   · 学段权威段是**最后一句权威指令**，必须离生成最近（`grade.ts` 的链式语义）；
 *   · 学生情况块（票 20）也要求排在权威段之前，于是本模块的段固定排在它**前面** ——
 *     「身份/风格 → 学情数据 → 权威指令」这个顺序在每一轮都稳定（D-032）。
 * ★ 段为空（`body` 全空）→ 只做清理，绝不留下空标题。
 */
export function withPromptSections(prompt: string, sections: readonly PromptSection[]): string {
  const source = typeof prompt === 'string' ? prompt : ''
  const cleaned = stripPromptSections(source)
  const rendered = sections
    .filter((section) => typeof section?.body === 'string' && section.body.trim().length > 0)
    .map((section) => `${section.heading}\n${section.body.trim()}`)
    .join('\n\n')
  if (rendered.length === 0) return cleaned

  const anchors = [STUDENT_CONTEXT_HEADING, GRADE_OVERRIDE_HEADING]
  let at = -1
  for (const anchor of anchors) {
    const found = lineStartIndex(cleaned, anchor)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) {
    const trimmed = cleaned.trim()
    return trimmed === '' ? rendered : `${trimmed}\n\n${rendered}`
  }
  const head = cleaned.slice(0, at).replace(/\s+$/, '')
  const rest = cleaned.slice(at)
  return head === '' ? `${rendered}\n\n${rest}` : `${head}\n\n${rendered}\n\n${rest}`
}

/* ------------------------------------------------------------------ *
 * 读出口：GET /api/profile/{sid}/tags
 * ------------------------------------------------------------------ */

/** 标签端点（契约 §2；与后端路由逐字一致）。 */
export const profileTagsPath = (studentId: string): string =>
  `/api/profile/${encodeURIComponent(studentId)}/tags`

/**
 * 读标签的超时（与 `STUDENT_CONTEXT_TIMEOUT_MS` 同一口径）。
 *
 * ★ 这一条挂在**每轮对话的最前面**（与画像预取并行），它卡的每一毫秒都是学生等首字的毫秒；
 *   本机回环 + 一个 SQLite 查询是个位数毫秒，3 秒还没回来说明 sidecar 已经不正常了，
 *   这时正确地降级（这一轮不投影画像）比继续等更有价值。
 */
export const PROFILE_TAGS_TIMEOUT_MS = 3_000

/** 标签读取出口（测试注入假实现；默认走 `apiFetch`）。 */
export type ProfileTagsReader = (
  studentId: string,
  options: { now?: number }
) => Promise<ProfileProjection | null>

/**
 * ★★ 每轮读一次画像标签并投影（**绝不抛**：画像只是增强，取不到就这一轮不投影）。
 *
 * ★ 动态 import `bridge/client.ts`（与 `extensions/profile.ts` 同因）：那个模块里有一处
 *   缺 `.ts` 的导入，静态 import 会让整个模块在 `node --test` 下导入失败 ——
 *   推迟到真正发请求那一刻，本文件里那些**纯函数**就还能被单测覆盖。
 */
export async function fetchPersonaSnapshot(
  studentId: string,
  options: { now?: number; reader?: ProfileTagsReader } = {}
): Promise<ProfileProjection | null> {
  if (options.reader) {
    try {
      return await options.reader(studentId, { now: options.now })
    } catch {
      return null
    }
  }
  try {
    const { apiFetch } = await import('../../bridge/client.ts')
    const response = await apiFetch(profileTagsPath(studentId), {
      method: 'GET',
      signal: AbortSignal.timeout(PROFILE_TAGS_TIMEOUT_MS)
    })
    // 404 = 这个学生还没有标签（正常形态，不是故障）→ 不投影
    if (!response.ok) return null
    const payload = (await response.json()) as ProfileTagsPayload | null
    if (!payload || typeof payload !== 'object') return null
    return projectProfileTags(payload, { now: options.now })
  } catch (error) {
    // ★ 绝不抛：调用方在每轮对话的主路径上（Pi 与 UI 同进程）
    console.warn(
      `[profile] 本轮未注入画像标签（读取降级，不影响对话）：${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}
