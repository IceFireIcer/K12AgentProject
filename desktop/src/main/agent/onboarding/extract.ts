/**
 * 五问的**本地抽取**（票 25 主进程半）。
 *
 * ★★ 本文件的核心事实：**MVP 15 个标签一个 LLM 调用都不需要**
 *   （执行报告 §1.6 末尾：subagent 概括整条链路推迟到 v2 票）。
 *
 * | 来源 | 产出标签 |
 * | --- | --- |
 * | Q1 点选直达 / 年级词表 | grade_band（+ 学段走既有 grade:set 立即生效） |
 * | Q2 点选学科 + 本地关键词表 | subject, current_topic |
 * | Q3 点选 + 本地关键词表 | explain_style, output_length, practice_type, tone |
 * | Q4 点选 + 本地关键词表 | pace |
 * | Q5 称呼（过脱敏） | 只进 identity_local.real_name，**不设标签** |
 * | 既有数据源（不在本文件） | knowledge_point / mastery / error_type ← 判分路径；emotion / intensity ← signals.py 元认知路；safety_level ← safety/guard |
 *
 * ★★ 纪律：**「靠位置，不靠解析」**。这个文件只回答「拿到这一问的回答文本，能本地映射出什么」，
 *   它**不猜**「哪句话属于哪一问」—— 问题 id 由渲染层按位置记下来（pendingQuestionId），
 *   连同答案一起经独立通道递进来（绝不混进 chat:send）。
 *   这里的「关键词表」是**映射**（学生点了/说了这个说法 -> 那个标签值），不是**归类猜测**。
 *
 * ★ emotion / intensity 的**数据源早就有**（signals.py 的元认知路），只是从没被整理成标签；
 *   本文件提供 normalizeEmotion / normalizeIntensity 做「整理」，而**不新增**任何采集 ——
 *   禁做清单第 12 条要求情绪取值域是有限枚举，自由文本一律不准进库。
 */

import {
  EMOTION_VALUE_SET,
  INTENSITY_MAX,
  INTENSITY_MIN,
  isLlmVisibleTag,
  ONBOARDING_QUESTIONS,
  STUDENT_FALLBACK_NAME,
  type OnboardingQuestionId
} from '../../../shared/profile-tags.ts'
import { safeDisplayName, sanitizeStudentText } from './sanitize.ts'
import type { GradeLevelLiteral, OnboardingExtraction, OnboardingTagWrite } from './types.ts'

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 造一条候选标签：**key 先过白名单**，不在白名单的直接被丢掉（不可能漏）。 */
function tag(key: string, value: string, confidence: number, source: OnboardingTagWrite['source'] = 'declared'): OnboardingTagWrite | null {
  if (!isLlmVisibleTag(key)) return null
  return { key, value, source, confidence }
}

/** 同 key 只留第一条（本地抽取的优先级：点选 > 关键词表里更靠前的规则）。 */
function dedupeByKey(tags: readonly OnboardingTagWrite[]): OnboardingTagWrite[] {
  const seen = new Set<string>()
  const out: OnboardingTagWrite[] = []
  for (const item of tags) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    out.push(item)
  }
  return out
}

/** 一问的问句原文（唯一一份脚本在 shared/profile-tags.ts，不在本地再抄）。 */
export function onboardingQuestionText(questionId: OnboardingQuestionId): string {
  return ONBOARDING_QUESTIONS.find((question) => question.id === questionId)?.text ?? ''
}

/* ------------------------------------------------------------------ *
 * Q1：学段
 * ------------------------------------------------------------------ */

/** Q1 点选**直达映射**（「小学高年级」-> primary_high，无需任何解析）。 */
export const GRADE_CHIP_MAP: Readonly<Record<string, GradeLevelLiteral>> = {
  小学低年级: 'primary_low',
  小学高年级: 'primary_high',
  初中: 'junior',
  高中: 'senior'
}

/**
 * 自由输入的年级词表（按学段从低到高，取**第一条命中** —— 学生通常先说当前年级）。
 *
 * ★ 「小学」二字单独出现时给 null（**不猜**）：说「我在上小学」只到「小学」这一档，
 *   既可能是低年级也可能是高年级，硬映射一个值就是编数据；学段层自己有冷启动默认值。
 */
const GRADE_WORD_TABLE: readonly { re: RegExp; level: GradeLevelLiteral | null }[] = [
  { re: /一年级|二年级|三年级|小学低年级/, level: 'primary_low' },
  { re: /四年级|五年级|六年级|小学高年级/, level: 'primary_high' },
  { re: /初一|初二|初三|七年级|八年级|九年级|初中/, level: 'junior' },
  { re: /高一|高二|高三|高中/, level: 'senior' },
  { re: /小学/, level: null }
]

/** 从一句自由文本里读学段；读不出返回 null（不猜、不兜底）。 */
export function gradeLevelFromText(text: string): GradeLevelLiteral | null {
  for (const entry of GRADE_WORD_TABLE) {
    if (entry.re.test(text)) return entry.level
  }
  return null
}

function extractGrade(raw: string): GradeLevelLiteral | null {
  const chip = GRADE_CHIP_MAP[raw.trim()]
  if (chip) return chip
  return gradeLevelFromText(raw)
}

/* ------------------------------------------------------------------ *
 * Q2：学科与当前话题
 * ------------------------------------------------------------------ */

/** 本地学科关键词表（复用 signals.py 的词表机制：词 -> 规范学科名）。 */
export const SUBJECT_KEYWORDS: readonly { subject: string; re: RegExp }[] = [
  { subject: '数学', re: /数学|代数|几何|函数|方程|分数|导数|统计|概率|算数/ },
  { subject: '语文', re: /语文|作文|阅读|古诗|文言文|拼音|汉字/ },
  { subject: '英语', re: /英语|单词|语法|时态/ },
  { subject: '科学', re: /科学|自然|实验|观察/ },
  { subject: '物理', re: /物理|力学|电学|光学/ },
  { subject: '化学', re: /化学|元素|化学反应/ },
  { subject: '生物', re: /生物|细胞|遗传/ },
  { subject: '历史', re: /历史|朝代/ },
  { subject: '地理', re: /地理|地形|气候/ },
  { subject: '道德与法治', re: /道德与法治|政治|道法/ },
  { subject: '信息技术', re: /信息技术|编程|计算机|程序|代码|Python/i },
  { subject: '美术', re: /美术|画画|绘画/ },
  { subject: '音乐', re: /音乐|唱歌|乐器/ },
  { subject: '体育', re: /体育|运动|篮球|足球/ }
]

/** 命中的学科名（最多 3 个，用中文顿号连接；一个都没有给空串）。 */
export function subjectsFromText(text: string): string[] {
  const found: string[] = []
  for (const entry of SUBJECT_KEYWORDS) {
    if (entry.re.test(text) && !found.includes(entry.subject)) found.push(entry.subject)
    if (found.length >= 3) break
  }
  return found
}

function extractStudy(text: string): OnboardingTagWrite[] {
  const subjects = subjectsFromText(text)
  const tags: (OnboardingTagWrite | null)[] = []
  if (subjects.length > 0) tags.push(tag('subject', subjects.join('、'), 1))
  // current_topic：整句就是学科名（点选）时不重复写一条；有别的信息时才当作话题。
  const trimmed = text.trim()
  if (trimmed !== '' && trimmed !== subjects.join('、') && trimmed.length >= 2) {
    tags.push(tag('current_topic', trimmed.slice(0, 40), 0.8))
  }
  return dedupeByKey(tags.filter((item): item is OnboardingTagWrite => item !== null))
}

/* ------------------------------------------------------------------ *
 * Q3 / Q4：讲法与节奏
 * ------------------------------------------------------------------ */

/** Q3 点选直达映射（chip 文本 -> 标签组）。 */
export const EXPLAIN_CHIP_TAGS: Readonly<Record<string, readonly OnboardingTagWrite[]>> = {
  多举生活里的例子: [
    { key: 'explain_style', value: '生活例子', source: 'declared', confidence: 1 },
    { key: 'practice_type', value: '先看例子', source: 'declared', confidence: 1 }
  ],
  先给结论再讲: [
    { key: 'explain_style', value: '先给结论', source: 'declared', confidence: 1 },
    { key: 'output_length', value: 'short', source: 'declared', confidence: 1 }
  ],
  一步一步慢慢推: [
    { key: 'explain_style', value: '逐步推导', source: 'declared', confidence: 1 },
    { key: 'pace', value: '慢', source: 'declared', confidence: 1 },
    { key: 'practice_type', value: '分步练习', source: 'declared', confidence: 1 }
  ],
  先看图再讲: [{ key: 'explain_style', value: '图示优先', source: 'declared', confidence: 1 }]
}

/** Q3 自由输入的关键词表（置信度 0.7：是映射，不是学生点选）。 */
const EXPLAIN_FREE_KEYWORDS: readonly { re: RegExp; tag: OnboardingTagWrite }[] = [
  { re: /例子|生活|实际/, tag: { key: 'explain_style', value: '生活例子', source: 'declared', confidence: 0.7 } },
  { re: /结论|先说答案|直接讲/, tag: { key: 'explain_style', value: '先给结论', source: 'declared', confidence: 0.7 } },
  { re: /图|画|动画/, tag: { key: 'explain_style', value: '图示优先', source: 'declared', confidence: 0.7 } },
  { re: /一步步|慢慢|推导|过程|步骤/, tag: { key: 'explain_style', value: '逐步推导', source: 'declared', confidence: 0.7 } },
  { re: /越短越好|简短|简洁|少说|别啰嗦/, tag: { key: 'output_length', value: 'short', source: 'declared', confidence: 0.7 } },
  { re: /详细|讲清楚|多讲/, tag: { key: 'output_length', value: 'long', source: 'declared', confidence: 0.7 } },
  { re: /亲切|温柔|耐心/, tag: { key: 'tone', value: '亲切', source: 'declared', confidence: 0.7 } },
  { re: /幽默|有趣|搞笑|好玩/, tag: { key: 'tone', value: '幽默', source: 'declared', confidence: 0.7 } }
]

/** Q4 点选直达映射。 */
export const PACE_CHIP_MAP: Readonly<Record<string, string>> = {
  慢一点: '慢',
  正常: '正常',
  快一点: '快'
}

/** Q4 自由输入的关键词表。 */
const PACE_FREE_KEYWORDS: readonly { re: RegExp; value: string }[] = [
  { re: /慢/, value: '慢' },
  { re: /快/, value: '快' },
  { re: /正常|都行|随便|中间|一般/, value: '正常' }
]

function extractExplain(raw: string): OnboardingTagWrite[] {
  const chip = EXPLAIN_CHIP_TAGS[raw.trim()]
  if (chip) return [...chip]
  const hits: OnboardingTagWrite[] = []
  for (const entry of EXPLAIN_FREE_KEYWORDS) {
    if (entry.re.test(raw)) hits.push(entry.tag)
  }
  return dedupeByKey(hits)
}

function extractPace(raw: string): OnboardingTagWrite[] {
  const chip = PACE_CHIP_MAP[raw.trim()]
  if (chip) return [{ key: 'pace', value: chip, source: 'declared', confidence: 1 }]
  for (const entry of PACE_FREE_KEYWORDS) {
    if (entry.re.test(raw)) return [{ key: 'pace', value: entry.value, source: 'declared', confidence: 0.7 }]
  }
  return []
}

/* ------------------------------------------------------------------ *
 * 既有数据源 -> 标签（signals.py 的情绪两件套）
 * ------------------------------------------------------------------ */

/** 情绪值必须是有限枚举之一（禁做清单第 12 条：自由文本 = 心理诊断，一律不准进库）。 */
export function normalizeEmotion(raw: unknown): string | null {
  return typeof raw === 'string' && EMOTION_VALUE_SET.has(raw) ? raw : null
}

/** 情绪强度归一化到 0–3 的整数（越界夹紧，非数字给 null）。 */
export function normalizeIntensity(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return null
  return Math.max(INTENSITY_MIN, Math.min(INTENSITY_MAX, Math.trunc(value)))
}

/**
 * 把 signals.py 元认知路的**已有结论**整理成标签（本文件不采集、不推断）。
 * ★ 来源标 observed（系统观察），不是 declared（学生自述）—— 两条来源在界面上要分得开。
 */
export function tagsFromSignals(signals: { emotion?: unknown; intensity?: unknown }): OnboardingTagWrite[] {
  const out: OnboardingTagWrite[] = []
  const emotion = normalizeEmotion(signals.emotion)
  if (emotion !== null) out.push({ key: 'emotion', value: emotion, source: 'observed' })
  const intensity = normalizeIntensity(signals.intensity)
  if (intensity !== null) out.push({ key: 'intensity', value: String(intensity), source: 'observed' })
  return out
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 抽取一问的答案。**纯函数**（无 IO、无时钟、无随机），因此可以逐条断言。
 *
 * 顺序是有意的：**先脱敏，再抽取** —— 命中的回答整条被回落成「同学」，
 * 于是后续任何映射都拿不到原始信息（这就是「守住本地」的实现方式）。
 */
export function extractAnswer(questionId: OnboardingQuestionId, raw: unknown): OnboardingExtraction {
  const clean = sanitizeStudentText(raw)
  const text = clean.text
  const base = {
    questionId,
    text,
    piiHit: clean.hit,
    piiPattern: clean.pattern,
    gradeLevel: null as GradeLevelLiteral | null,
    displayName: null as string | null,
    tags: [] as OnboardingTagWrite[]
  }
  // ★★ 命中敏感模式 = **整条丢弃**：连映射都不做。
  //   否则「同学」这个回落值会顺着 Q2 的规则变成一条 current_topic=同学（看着无害，
  //   实际是把「这里原本有信息、被我们遮掉了」写进了库 —— 那不是丢弃，是留痕）。
  if (clean.hit) {
    if (questionId === 'q5') base.displayName = STUDENT_FALLBACK_NAME
    return base
  }

  if (questionId === 'q1') {
    base.gradeLevel = extractGrade(text)
    // ★ Q1 的 grade_band 标签**不由本文件写**：学段只有一个写入口（grade:set，
    //   立即生效 + 冷却），标签由后端在收到学段后自己投影 —— 两处写会漂。
    return base
  }
  if (questionId === 'q2') {
    base.tags = extractStudy(text)
    return base
  }
  if (questionId === 'q3') {
    base.tags = extractExplain(text)
    return base
  }
  if (questionId === 'q4') {
    base.tags = extractPace(text)
    return base
  }
  // q5：称呼（过脱敏）+ 备注。★ 称呼**不设标签** —— 它只进 identity_local.real_name 与渲染层内存。
  base.displayName = safeDisplayName(text)
  return base
}
