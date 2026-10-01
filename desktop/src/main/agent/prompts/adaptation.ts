/**
 * ★ 学段内难度微调（票 30）+ 受挫处置定向（票 29）—— 作用在「**怎么讲**」的每轮段。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有「学段内微调」这一档
 * ---------------------------------------------------------------------------
 * 学段只有四档，粒度太粗：「小学五年级」和「小学五年级但明显偏难」拿到的是同一套 prompt。
 * 现状的浪费在于，为了表达「他比同年级强一点」，系统要付出一次**完整的学段迁移**
 * （连续 3 轮同向 + 置信度 0.6 + 冷却 5 轮 + 单次最多 1 级）—— 而很多时候根本不需要迁移。
 *
 * 所以这里做的是一件**纯加法**：**学段不动**，只加一档学段内微调
 * （偏易 ← 正常 → 偏难），作用在术语密度、例子的抽象层、先给结论还是先给推导。
 * 自适应于是从**离散跳变**（换整套讲法）变成**连续调节**，而且**完全不触碰**
 * 已在跑的学段机制（本文件不 import 任何学段写入路径，也不改权威段）。
 *
 * ★ 输入用 zpd_level（最近发展区，白名单标签之一）。
 * ★★ **必须有明确回落路径**：数据不足（没有这个标签 / 值认不出 / 置信度太低）
 *    → 回「正常」，**不许猜**。回落的实现就是「这一档什么都不注入」——
 *    模板本来写的就是正常难度，注入一句「按正常难度讲」反而多花预算。
 *
 * ---------------------------------------------------------------------------
 * 受挫处置为什么要条件化
 * ---------------------------------------------------------------------------
 * 「太难了」至少三种意思（求助 / 放弃 / 试探），处置互斥；用一套策略**必然对两种错**。
 * 策略正文的唯一实现是 prompts/rules.ts 的 frustrationGuidance()（静态模板用 'unknown'
 * 版本：三选一 + 先问一句），本文件只在**有标签支持**时给一版定向的短说明。
 * ★ 判不出来就**不注入**（静态那一节已经把三种都讲清楚了，不需要再来一段）。
 *
 * ★ 本模块是**纯函数**（不发 HTTP、不读库、不写任何东西）：标签由
 *   prompts/profile-block.ts 投影好传进来，因此两条铁律天然成立 ——
 *   ① L3 推断永远写不了 L1（这里连写接口都没有）；② 每个标签都带着来源与置信度。
 */

import {
  DIFFICULTY_SECTION_HEADING,
  FRUSTRATION_SECTION_HEADING,
  PROFILE_SECTION_HEADING,
  STYLE_TOOL_SECTION_HEADING,
  renderProfileSectionBody,
  type ProfileProjection,
  type ProjectedTag,
  type PromptSection
} from './profile-block.ts'
import { FRUSTRATION_LABELS, frustrationGuidance } from './rules.ts'
import type { FrustrationTendency } from './rules.ts'

/* ------------------------------------------------------------------ *
 * C5：学段内难度微调
 * ------------------------------------------------------------------ */

/** 学段内难度档（**不是学段**：偏易 / 正常 / 偏难）。 */
export type DifficultyTier = 'easier' | 'normal' | 'harder'

/** 微调的输入标签（执行报告 §5.3①：zpd_level）。 */
export const DIFFICULTY_TAG_KEY = 'zpd_level'

/**
 * 可信度门槛：低于它一律回「正常」。
 *
 * ★ 为什么要有：zpd_level 多半是**推断**出来的（L3），低置信度的推断去改讲法，
 *   错了的代价落在学生这一轮的实际体感上；而「正常」是**没有代价**的默认值。
 *   置信度缺失（后端没给）时不拦 —— 值本身就是证据，缺置信度不等于值不可信。
 */
export const DIFFICULTY_MIN_CONFIDENCE = 0.5

/** 数值档位（1/2/3）。其余数值（0/4/9…）一律回正常 —— 认不出就不猜。 */
const NUMERIC_TIERS: Readonly<Record<number, DifficultyTier>> = {
  1: 'easier',
  2: 'normal',
  3: 'harder'
}

/** 文字档位（后端可能直接存中文；认不出的词同样回正常）。 */
const WORD_TIERS: Readonly<Record<string, DifficultyTier>> = {
  偏易: 'easier',
  较易: 'easier',
  容易: 'easier',
  正常: 'normal',
  适中: 'normal',
  一般: 'normal',
  偏难: 'harder',
  较难: 'harder',
  难: 'harder'
}

/** 从投影里取一个键的标签（没有就是 null）。 */
export function tagOf(projection: ProfileProjection | null | undefined, key: string): ProjectedTag | null {
  return (projection?.tags ?? []).find((tag) => tag.key === key) ?? null
}

/**
 * ★★ 难度档解析（**纯函数**，票 30 的判据全在这里）。
 *
 * 回落路径（数据不足 → 正常，**不许猜**）：
 *   · 没有 zpd_level 标签 → 正常；
 *   · 置信度低于 {@link DIFFICULTY_MIN_CONFIDENCE} → 正常；
 *   · 值不是 1/2/3、也不是认识的中文档位词 → 正常；
 *   · 同一个数**不许当两档用**（例如有人把 0–100 的分数塞进来 → 一律正常）。
 */
export function resolveDifficultyTier(tag: ProjectedTag | null | undefined): DifficultyTier {
  if (!tag) return 'normal'
  if (tag.confidence !== null && tag.confidence < DIFFICULTY_MIN_CONFIDENCE) return 'normal'
  const raw = tag.value.trim()
  if (raw.length === 0) return 'normal'
  const numeric = Number(raw)
  if (Number.isFinite(numeric)) {
    if (!Number.isInteger(numeric)) return 'normal'
    return NUMERIC_TIERS[numeric] ?? 'normal'
  }
  return WORD_TIERS[raw] ?? 'normal'
}

/** 难度档的中文名（诊断 / 日志 / 测试共用一份）。 */
export const DIFFICULTY_LABELS: Readonly<Record<DifficultyTier, string>> = {
  easier: '偏易',
  normal: '正常',
  harder: '偏难'
}

/**
 * 微调段的正文；normal 返回空串（= 这一轮不注入任何微调，走模板本来的正常难度）。
 *
 * ★ 都要写清「**学段与知识范围不变**」：这一段进的是 system prompt，
 *   而模型很容易把「偏难讲」理解成「可以讲更高学段的内容」—— 那就把
 *   「学段内微调」偷偷变成了「学段迁移」，正是本机制要避免的事。
 */
export function renderDifficultySectionBody(tier: DifficultyTier): string {
  if (tier === 'easier') {
    return [
      '- 这一轮**偏易**讲：先给结论，再补一小步推导；术语密度降一档，出现新词就当场用生活里的例子解释。',
      '- 例子用**具体、他熟悉**的场景（他自己、学校、游戏），不要一上来就抽象。',
      '- ★ 只调整**怎么讲**：学段与知识范围**不变**（学段由系统另行判定，不要在这里改）。'
    ].join('\n')
  }
  if (tier === 'harder') {
    return [
      '- 这一轮**偏难**讲：例子抽象一层（用符号或一般化的说法），先给推导过程，再落结论。',
      '- 可以一次引入**一个**与当前内容直接相关的新概念，并点出它和已经学过的哪一段接得上。',
      '- 仍然不超纲：不引入本学段之外的知识点。',
      '- ★ 只调整**怎么讲**：学段与知识范围**不变**（学段由系统另行判定，不要在这里改）。'
    ].join('\n')
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * C4：受挫敏感度
 * ------------------------------------------------------------------ */

/** 负面情绪的值（来自有限枚举；EMOTION_VALUES 的取值域见 @shared/profile-tags）。 */
const FRUSTRATED_EMOTIONS: readonly string[] = ['frustrated', 'angry']

/**
 * 困惑到这个强度也算受挫（intensity 是 **0–3** 的小整数，不是 0–100 的分）。
 * 取 2 = 「明显」：1 级困惑是正常的思考停顿，不值得触发一套特殊处置。
 */
export const FRUSTRATION_MIN_INTENSITY = 2

/** 「没有偏好信号」的取值（这些值等于「没有证据」，不能拿来推倾向）。 */
const NO_SIGNAL_VALUES: readonly string[] = ['', '低', '少', '无', '不需要', '正常', '中', 'low', 'none', 'normal']

/** 一个偏好标签的值算不算「有信号」。 */
function hasSignal(value: string | null): boolean {
  if (value === null) return false
  return !NO_SIGNAL_VALUES.includes(value.trim().toLowerCase())
}

/**
 * ★★ 受挫倾向的解析（**纯函数**，票 29）。
 *
 * 判据（保守：**宁可不判也不押错**）：
 *   ① 行为观察优先（observed）—— 它是「连续受挫后继续问还是停止提问」这类**行为事实**，
 *      比任何标签都新鲜；票 29 今天还没有这个数据源，v2 接上（见入参注释）。
 *   ② 没有行为观察时看标签：emotion 是沮丧/生气，或 confused 且强度 ≥ 2，才算受挫。
 *   ③ 受挫之后再分型：challenge_level 有信号（愿意挑战 → 要的是解法）→ 求助型；
 *      encouragement_freq 有信号（需要被肯定）→ 放弃型。
 *   ④ 只有「沮丧」这一个信号时**回 'unknown'** —— 这时三选一会押错两次，
 *      而静态那一节已经把「先问一句」写好了。
 *
 * ⚠️ testing（试探型）**没有标签信号**：它的证据是学生反复问「我是不是太笨」这类行为，
 *    只能由行为观察给出。这里不硬造一个规则去猜它（那正是「不许猜」的反面）。
 */
export function resolveFrustrationTendency(input: {
  projection?: ProfileProjection | null
  observed?: FrustrationTendency | null
}): FrustrationTendency {
  const observed = input.observed
  if (observed && observed !== 'unknown') return observed

  const projection = input.projection ?? null
  const emotion = tagOf(projection, 'emotion')?.value ?? ''
  const intensityRaw = tagOf(projection, 'intensity')?.value ?? ''
  const intensity = Number(intensityRaw)
  const frustrated =
    FRUSTRATED_EMOTIONS.includes(emotion) ||
    (emotion === 'confused' && Number.isFinite(intensity) && intensity >= FRUSTRATION_MIN_INTENSITY)
  if (!frustrated) return 'unknown'

  if (hasSignal(tagOf(projection, 'challenge_level')?.value ?? null)) return 'help_seeking'
  if (hasSignal(tagOf(projection, 'encouragement_freq')?.value ?? null)) return 'giving_up'
  return 'unknown'
}

/**
 * 定向段的正文；unknown 返回空串（静态那一节已经讲清三种，不再重复一段）。
 *
 * ★ 策略正文从 {@link frustrationGuidance} 来（**只有一份实现**）：
 *   这里只补一句「依据是什么、可能猜错」，让模型知道这一段是**可推翻的**。
 */
export function renderFrustrationSectionBody(tendency: FrustrationTendency): string {
  if (tendency === 'unknown') return ''
  return [
    '- 这一轮他更像**' + FRUSTRATION_LABELS[tendency] +
      '**（依据：这一轮的情绪标签与行为观察；这是猜的，感觉不对就按上面那节的一般说法来）。',
    ...frustrationGuidance(tendency)
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * 组装：每轮注入的段（固定顺序）
 * ------------------------------------------------------------------ */

/**
 * 每轮要注入的全部段（**顺序固定**：画像 → 难度 → 情绪）。
 *
 * 顺序的依据：先给「他是谁」（静态信息，最稳定），再给「这一轮怎么讲」（可能每轮变），
 * 最后给「这一轮怎么接情绪」（变化最频繁）。放在一起还有个好处：**同一批标签**
 * 只解析一次，且三段的稳定性可以一起断言（tests/persona-injection.test.ts）。
 */
/**
 * ★★ 风格驱动的**工具先后**（§5.2 #4）。
 *
 * 计划原话：「**风格驱动工具编排**：动手型优先编程、视觉型优先动画（用 L2+L3）」。
 *
 * ## 它调的**只是先后**，不是能力
 * 本函数**不新增 Tool、不改 Tool 注册**（Tool 集合被守卫钉死，见 `ipc/tool-kinds.ts`）——
 * 它只说「这一轮先出哪个」。学生当轮要什么仍然由学生的话说了算（见 rules.ts 的 needSection：
 * 「学生要，或者你判断讲这个过程确实需要演示 / 需要动手练」）。
 *
 * ## 数据不足 → **什么都不注入**
 * 没有 `practice_type` / `explain_style` 标签时返回空串。
 * 这不是「默认值」，是「这一轮不加这段」——与难度档的回落同一条纪律：
 * 回落 = 什么都不说，而不是说一句「按正常偏好来」白花预算。
 *
 * ## 为什么判据是**关键词**而不是精确等值
 * 这两个标签的值来自 Q3/Q4 的点选 chip 与**自由输入**（如「多举生活里的例子」
 * 「一步一步慢慢推」），表述本来就是开放的。精确等值会把大多数真实值漏掉；
 * 所以用「命中一组关键词」的宽读 —— 但**不命中就返回空**，宽读不等于瞎猜。
 */
export function renderStyleToolSectionBody(projection: ProfileProjection | null): string {
  const hay = [
    tagOf(projection, 'practice_type')?.value ?? '',
    tagOf(projection, 'explain_style')?.value ?? ''
  ]
    .join(' ')
    .trim()
  if (hay.length === 0) return ''

  const lines: string[] = []
  if (/动手|先跑|先做|编程|操作|试一试/.test(hay)) {
    lines.push(
      '- 他偏**动手**：能跑的先给编程工具让他自己试一遍，再讲原理（不要先讲一大段再让他动手）。'
    )
  }
  if (/图|动画|可视|演示/.test(hay)) {
    lines.push('- 他偏**看图**：需要过程演示时优先用动画工具，再配一句文字点题。')
  }
  if (/例子|举例|生活/.test(hay)) {
    lines.push('- 他偏**例子**：先给一个具体例子，再归纳一般规律。')
  }
  if (/结论|先给|直接说/.test(hay)) {
    lines.push('- 他偏**先要结论**：先把结论说清楚，再展开推导（不要让他等三段才知道答案）。')
  }
  if (/一步一步|慢慢|逐步|详细/.test(hay)) {
    lines.push('- 他偏**逐步**：按步骤一层层推，不要跳步；每一步说清「为什么走这一步」。')
  }
  // ★ 一个都没命中 → 空串（不注入）。宽读的边界就在这里。
  return lines.join('\n')
}


export function buildTurnSections(input: {
  projection?: ProfileProjection | null
  observedFrustration?: FrustrationTendency | null
}): PromptSection[] {
  const projection = input.projection ?? null
  const sections: PromptSection[] = []

  const profileBody = renderProfileSectionBody(projection)
  if (profileBody.length > 0) sections.push({ heading: PROFILE_SECTION_HEADING, body: profileBody })

  const difficultyBody = renderDifficultySectionBody(
    resolveDifficultyTier(tagOf(projection, DIFFICULTY_TAG_KEY))
  )
  if (difficultyBody.length > 0) {
    sections.push({ heading: DIFFICULTY_SECTION_HEADING, body: difficultyBody })
  }

  const styleToolBody = renderStyleToolSectionBody(projection)
  if (styleToolBody.length > 0) {
    sections.push({ heading: STYLE_TOOL_SECTION_HEADING, body: styleToolBody })
  }

  const frustrationBody = renderFrustrationSectionBody(
    resolveFrustrationTendency({ projection, observed: input.observedFrustration ?? null })
  )
  if (frustrationBody.length > 0) {
    sections.push({ heading: FRUSTRATION_SECTION_HEADING, body: frustrationBody })
  }

  return sections
}
