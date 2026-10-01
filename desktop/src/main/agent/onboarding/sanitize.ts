/**
 * 学生文本的**本地脱敏**（票 25 主进程半）。
 *
 * ★★ 职责已经收窄（v3，执行报告 §0.6.4）：
 *   它**不再负责出网保护** —— 出网由 shared/profile-tags.ts 的**白名单投影**全权负责
 *   （不在白名单的字段压根拼不进 prompt）。这道闸现在只剩一件事：**守住本地** ——
 *   不让「学生没同意在本机留下的信息」进 identity_local / profile_tags。
 *
 * 两条硬口径：
 *   ① **命中就整条丢弃**，回落 STUDENT_FALLBACK_NAME。**不做「清洗后部分保留」** ——
 *      部分保留是黑名单思路的典型残渣：洗完的文本看起来干净了，但结构还在
 *      （「XX 学校二班」被洗成「XX 二班」，学校名只是换了位置）。
 *   ② ⚠️ **五年级不遮**：精确年级是抽 grade_band 的原料（报告 §1.6 明文保留），
 *      所以模式表里**没有**任何一条会单独命中「X 年级」。守卫测试里有反向对照。
 *
 * ⚠️ 本文件是纯函数，不 import 任何 IO —— 它会被 node --test 直接加载。
 */

import { STUDENT_FALLBACK_NAME } from '../../../shared/profile-tags.ts'
import type { SanitizeOutcome } from './types.ts'

/** 答案文本上限（与后端契约 OnboardingAnswerRequest.answer_text 的 max_length 同口径）。 */
export const MAX_ONBOARDING_ANSWER_CHARS = 400

/**
 * 「我叫 X / 我的名字是 X」——只认**明确的自我介绍句式**。
 *
 * ⚠️ 刻意**不**收「我是 X」：那会把「我是五年级的」「我是新来的」一起吃掉，
 *   而学段是我们要留下的原料（五年级不遮）。
 */
const NAME_INTRO_RE = /(?:我|本人)\s*(?:叫|叫做|名字叫|名字是|的名字叫|的名字是)[^\s，。,.!！?？、；;]{1,12}/

/** 泛指的「学校」二字（只要出现就当作地点信息）。 */
const SCHOOL_WORD_RE = /学校/

/**
 * 具名学校：**两个以上汉字 + 校名后缀**。
 *
 * 为什么要前缀有下限、还要过停用词表：光看「小学」二字会把「我在读小学」判成学校名，
 * 而那句话里没有任何具体地点（用户明确要求「五年级不遮」，边界就画在这类地方）。
 */
const NAMED_SCHOOL_RE = /([\u4e00-\u9fff]{2,6})(?:小学|中学|学院|大学)/g

/** 具名学校前缀里的停用词（以它们开头的都不是校名，是动词/代词）。 */
const SCHOOL_PREFIX_STOPWORDS = [
  '在', '是', '读', '上', '的', '于', '到', '进', '了', '我', '他', '她', '们',
  '这', '那', '有', '去', '从', '和', '跟', '与', '念', '在念'
]

/** 「二班 / 3班」这类班级信息。 */
const CLASS_RE = /[一二三四五六七八九十\d]{1,3}班/

/** 手机号（11 位、1[3-9] 开头）。 */
const PHONE_RE = /\b1[3-9]\d{9}\b/

/** 身份证样式（18 位，末位可以是 X）。 */
const ID_CARD_RE = /\b\d{17}[\dXx]\b/

/** 邮箱（顺带处理：它同样是学生没同意外传的联系方式）。 */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/

/**
 * 模式表。**顺序即优先级**（只用于报出「命中了哪一条」，命中任意一条的处理都一样：整条丢弃）。
 * ★ 名字一律写成「给测试与日志看的中文标签」，它们**不进任何 prompt**。
 */
export const PII_PATTERNS: readonly { name: string; test: (text: string) => boolean }[] = [
  { name: '自我介绍（我叫…）', test: (text) => NAME_INTRO_RE.test(text) },
  { name: '学校名', test: (text) => SCHOOL_WORD_RE.test(text) || hasNamedSchool(text) },
  { name: '班级（X 班）', test: (text) => CLASS_RE.test(text) },
  { name: '手机号', test: (text) => PHONE_RE.test(text) },
  { name: '身份证样式', test: (text) => ID_CARD_RE.test(text) },
  { name: '邮箱', test: (text) => EMAIL_RE.test(text) }
]

/**
 * 具名学校的判定：从**每一个**起始位置重试，从而让「我在阳光小学」里的「阳光小学」
 * 有机会被单独看到（贪婪匹配会一次吃掉「我在阳光小学」，只在整段前缀上判会漏）。
 */
function hasNamedSchool(text: string): boolean {
  NAMED_SCHOOL_RE.lastIndex = 0
  let matched: RegExpExecArray | null
  while ((matched = NAMED_SCHOOL_RE.exec(text)) !== null) {
    const prefix = matched[1] ?? ''
    if (!SCHOOL_PREFIX_STOPWORDS.some((word) => prefix.startsWith(word))) return true
    NAMED_SCHOOL_RE.lastIndex = matched.index + 1
  }
  return false
}

/** 第一条命中的模式名；没命中返回 null。 */
export function firstPiiPattern(text: string): string | null {
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(text)) return pattern.name
  }
  return null
}

/**
 * 脱敏一条学生文本。
 *
 * 语义（就这两条，别加第三条）：
 *   · 命中任一模式 -> text 回落 STUDENT_FALLBACK_NAME、hit=true、pattern=模式名；
 *   · 没命中      -> text 原样（只做首尾空白与长度收敛），hit=false。
 */
export function sanitizeStudentText(raw: unknown): SanitizeOutcome {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { text: '', hit: false, pattern: null }
  const pattern = firstPiiPattern(text)
  if (pattern !== null) return { text: STUDENT_FALLBACK_NAME, hit: true, pattern }
  const capped =
    text.length > MAX_ONBOARDING_ANSWER_CHARS ? text.slice(0, MAX_ONBOARDING_ANSWER_CHARS) : text
  return { text: capped, hit: false, pattern: null }
}

/**
 * 学生面称呼的安全值：脱敏后为空就回落「同学」。
 * ★ Q5 的回答走它；**结果只进 identity_local.real_name / 渲染层内存**，永不进标签表、永不进 prompt。
 */
export function safeDisplayName(raw: unknown): string {
  const outcome = sanitizeStudentText(raw)
  const text = outcome.text.trim()
  return text === '' ? STUDENT_FALLBACK_NAME : text
}

/** 这个称呼是不是回落值（渲染层据此决定「要不要显示称呼」这类文案）。 */
export function isFallbackName(name: string): boolean {
  return name.trim() === '' || name.trim() === STUDENT_FALLBACK_NAME
}
