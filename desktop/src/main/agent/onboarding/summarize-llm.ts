/**
 * 五问概括的**真实实现**（票 31：subagent 概括真接上；票 31-A2：真正「判断画像」）。
 *
 * ── 它接的是哪条缝 ──────────────────────────────────────────────────────
 * `summarize.ts` 里的 `OnboardingSummarizer` 那条缝（类型面 + 8s 超时 + 只重试 1 次
 * + degraded 降级）从票 25 起就留着，但**默认挂的是降级桩**：MVP 15 个标签全部本地
 * 可抽，当时引入一次 LLM 往返换不到新标签（执行报告 §1.6）。现在接上真实现，
 * 调用侧（service.ts 的 runSummary）**一行都不用改** —— 这正是那条缝存在的理由。
 *
 * ── ★★ A2（2026-09-29 用户裁决：「扩大 subagent 职责，让它真正判断画像」）──────
 * 原实现只把**答案文本**发给模型，模型无从知道「这句话是在回答什么」；现在把
 * **问句原文**（由 `questionId` 从唯一脚本 `ONBOARDING_QUESTIONS` 查出）与答案**配对**
 * 一起发。这不是「让模型更懂学生」，而是让它的输入**完整** —— 「最近在学什么」的答案
 * 与「想讲快一点还是慢一点」的答案，含义天差地别，只给答案等于让模型猜上下文。
 *
 * ⚠️ A2 **不代表**可以推断性格/心理（禁做清单第 10~14 条，见下 §出网边界④）：
 *    「判断画像」在这里 = 把学生**自己说过的话**正确归位到画像的各个维度
 *    （学科 / 兴趣 / 讲法偏好 / 节奏 / 情绪倾向），**不是**性格分析、不是心理评估、
 *    不是从行为反推动机。system prompt 第 7~8 条把这条边界写成了可读的指令。
 *
 * ── ★★ A2+（2026-09-29：画像更丰富 / 教学更贴合，用户裁决「1 2 都要」）──────
 * A2 解决的是**输入完整性**（问-答配对），A2+ 解决的是**覆盖度**：
 *   ① 系统提示把「可整理的维度」从六类**逐维点名**（原写法只说了学科/兴趣/讲法/
 *      节奏/鼓励/练习，模型就只往这几类归，互动偏好与场景目标整维空缺）；
 *   ② 单次上限 8 → 12（五问之后的本地规则通常已占 3~5 席，剩下的才轮到模型补，
 *      8 席会在偏好维上就被截断，画像只剩「他在学数学」）。
 * ⚠️ 两处改动**都不碰白名单**：安全边界（LLM_VISIBLE_TAGS）一个字未动，
 *    「不许推断心理」的第 7~8 条纪律原样保留 —— 丰富的是**学生说过的话的落点**，
 *    不是系统的推断权限。
 *
 * ── ★★ 出网边界（比「概括准确」重要得多）────────────────────────────────
 *   ① 输入只有**已脱敏**的回答文本、**问句原文**与本地候选标签 —— `answers` 是
 *      `extract.ts` 里 `sanitizeStudentText()` 之后的产物（命中敏感模式已被整条回落成
 *      「同学」）；问句原文是**写死的公开脚本**（学生已看见的那几句），不含任何新信息；
 *   ② `displayName`（真名的显示口径）**绝不进任何出网载荷** —— 它连本函数的
 *      入参都不许被拼进请求体（见下面的 `buildSummaryPayload`）；
 *   ③ 输出的 key 只能是白名单子集（`ONBOARDING_SUMMARY_ALLOWED_KEYS`），
 *      脏值 / 越界值**逐条丢掉**，不整批拒绝也不部分保留 —— 与 grade.ts 的
 *      `parseProposal` 同一条纪律（宽松读、严格校验、脏值丢弃）；
 *   ④ source 一律 `declared`：这些值都是学生自己说过的，只是由模型从原话里挑出来，
 *      与本地关键词表同一性质（禁做清单第 10 条把 `inferred` 限制在情绪/风格类，
 *      本函数**不产出 inferred**）。
 *
 * ── 与引导 prompt 的关系（别把两条 prompt 混了）────────────────────────────
 * `prompt.ts` 的 `buildOnboardingSystemPrompt` 是**引导那轮对话**的 prompt，
 *   守卫 G-PR 要求它**一条问句都不含**（界面是唯一提问者，模型不许复述问句）。
 * 本文件的 `buildSummaryPayload` 是**五问答完之后**那次**离线概括**的 prompt，
 *   它面对的是一个已经不存在的对话轮次，目的恰是把「问—答」配对整理成标签 ——
 *   所以它**带上问句原文是正当的**，与 G-PR 不冲突（两条 prompt 的用途不同）。
 */

// ★ 出网口：主进程里**唯一**允许打外部模型服务的地方（守卫 G5 的两个白名单出口之一）。
//   本文件自己不写 `fetch(` —— 那会让「Key 在哪里进 header」变成两处真相。
import { llmFetch, llmPostInit, type LlmChatFetch } from '../../bridge/llm-completions.ts'
import {
  EPHEMERAL_TAG_SET,
  LEARNER_STYLE_VALUE_SET,
  LEARNER_STYLE_VALUES,
  LLM_VISIBLE_TAGS,
  ONBOARDING_QUESTIONS,
  PERSONALITY_VALUE_SET,
  PERSONALITY_VALUES,
  type LlmVisibleTag
} from '../../../shared/profile-tags.ts'
import {
  ONBOARDING_SUMMARY_TIMEOUT_MS,
  type OnboardingSummarizer,
  type OnboardingSummaryInput
} from './summarize.ts'
import type { OnboardingTagWrite } from './types.ts'

/* ------------------------------------------------------------------ *
 * 常量与类型
 * ------------------------------------------------------------------ */

/**
 * 概括器能产出的 key：白名单里扣掉 join 钥匙与三个短期情绪键（那三档由系统观察写，且有 TTL）。
 *
 * ★ A2+（2026-09-29）：这里**不**再进一步收窄 —— 之前 prompt 的规则 5 只点名了
 *   「学科 / 兴趣 / 讲法 / 节奏 / 鼓励 / 练习」六类，模型就只往这六类上归；
 *   而实际上「互动偏好（语气 / 挑战度）」「场景与目标」「安全边界」同样有对应答案，
 *   只是没人告诉模型可以归到那里。放宽的是**prompt 的维度清单**，不是白名单
 *   （白名单是安全边界，一个字都不动）。
 */
export const ONBOARDING_SUMMARY_ALLOWED_KEYS: readonly string[] = LLM_VISIBLE_TAGS.filter(
  (key) => key !== 'anon_student_id' && !EPHEMERAL_TAG_SET.has(key)
)

/**
 * 一次概括最多补几条（再多就不是「补充」，而是替学生编画像）。
 *
 * ★ A2+ 从 8 提到 12：五问答完之后本地规则通常已抽到 3~5 条（学科 / 学段 / 当前话题），
 *   剩下**真正需要模型补的**是在偏好、互动、场景这几维上 —— 每维一两条就逼近 8 条上限，
 *   于是后面几维一律被截断，画像就只剩「他在学数学」这种谁都能看出来的东西。
 *   ⚠️ 上限**不是**「越多越好」：12 已覆盖全部非情绪维度各自一条，再多就只能靠编。
 */
export const ONBOARDING_SUMMARY_MAX_TAGS = 12

/** 单条 value 的长度上限（与 extract.ts 的 current_topic 同一口径：短语，不是正文）。 */
const MAX_VALUE_CHARS = 30

/** 模型没给置信度时的默认值（低于点选的 1、也低于关键词表的 0.7 —— 它是「从原话里挑的」）。 */
const DEFAULT_CONFIDENCE = 0.6

/** 概括的采样预算（够写 8 条 JSON，多一点都是浪费延迟）。 */
const SUMMARY_MAX_TOKENS = 400

/** 概括用的模型配置（来自 `settings/runtime-config.ts`，★ 明文 Key 只在本进程内存里流转）。 */
export interface LlmSummarizerConfig {
  baseUrl: string
  modelId: string
  apiKey: string
}

export type LlmConfigProvider = () => Promise<LlmSummarizerConfig | null>

/** 出网口（可注入；生产用 `llmFetch` —— 测试用替身断言请求体）。 */
export type SummaryResponseFetch = LlmChatFetch

/* ------------------------------------------------------------------ *
 * URL（与 Python 探测端同一口径：{baseUrl}/chat/completions，404 时试 /v1 变体）
 * ------------------------------------------------------------------ */

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function chatCompletionsUrl(baseUrl: string): string {
  return trimBase(baseUrl) + '/chat/completions'
}

/**
 * 另一种常见写法（… ↔ …/v1），**只在 404/405 时试一次**。
 *
 * DeepSeek 两种写法都通，但多数 OpenAI 兼容服务只认一种；与 `routes/settings.py` 的
 * `base_url_variant()` 同一条判断，两边不许各写一份。
 */
export function chatCompletionsVariantUrl(baseUrl: string): string | null {
  const trimmed = trimBase(baseUrl)
  if (trimmed === '') return null
  if (trimmed.endsWith('/v1')) return trimmed.slice(0, -'/v1'.length) + '/chat/completions'
  return trimmed + '/v1/chat/completions'
}

/* ------------------------------------------------------------------ *
 * 载荷与解析
 * ------------------------------------------------------------------ */

/**
 * 一问的**问句原文**（唯一一份脚本在 shared/profile-tags.ts，本地不另抄一份）。
 * 查不到时给空串 —— 调用方据此退化成「只发答案」（老形状），不至于因为
 * 脚本里少了一条 id 就让整条概括链断掉。
 */
export function summaryQuestionText(questionId: string): string {
  return ONBOARDING_QUESTIONS.find((question) => question.id === questionId)?.text ?? ''
}

/**
 * 组出网载荷。
 *
 * ★★ `input.displayName` **故意不出现在这里** —— 它是「该怎么称呼他」的显示口径，
 *    真名的替身；概括只需要学生的回答（与回答所对应的问句），不需要知道他是谁。
 *
 * ★ A2：每条答案**配对带上问句原文**（`Q2` 后面跟着学生答的那句）。这样模型才知道
 *   「分数」是在回答「最近在学什么」还是在回答「喜欢哪种讲法」—— 少了问句，
 *   同一个词会被归到完全不同的画像维度上。
 */
export function buildSummaryPayload(input: OnboardingSummaryInput): { system: string; user: string } {
  const known =
    input.tags.length > 0
      ? input.tags.map((item) => item.key + '=' + item.value).join('；')
      : '（无）'
  const transcript = input.answers
    .map((item) => {
      const ordinal = 'Q' + String(item.questionId).replace(/^q/, '')
      const question = summaryQuestionText(item.questionId)
      // 有问句就「问 + 答」两行；没有就退回老形状（只一行答案）—— 保证不因缺 id 崩掉。
      return question === ''
        ? ordinal + '：' + item.text
        : ordinal + ' 问：' + question + '\n' + ordinal + ' 答：' + item.text
    })
    .join('\n')

  const system = [
    '你是学生画像的整理助手。',
    '输入是一位 K12 学生在「首次见面」时对五个问题的回答（已脱敏，不含真名、学校、班级、联系方式），',
    '每题都附上了原始问句，以及本地已经抽出的候选标签。',
    '任务：把学生**自己说过的内容**整理成结构化的画像标签，补上本地规则抽不出来的部分。',
    '规则：',
    '1. 只输出一个 JSON 对象，形如 {"tags":[{"key":"subject","value":"数学","confidence":0.6}]}，不要输出别的文字。',
    '2. key 只能是这些之一：' + ONBOARDING_SUMMARY_ALLOWED_KEYS.join('、') + '。',
    '3. value 是中文短语，不超过 20 个字，**必须能在学生的原话或点选里找到依据**；学生没说的不要编。',
    '4. 拿不准的条目不要输出；最多 ' + String(ONBOARDING_SUMMARY_MAX_TAGS) + ' 条；不要重复输出本地已有的标签。',
    '5. 尽量**把每个维度都看一眼**，只要学生在某一维上明确说过话就写一条：',
    '   · 在学什么（subject / course_module / current_topic）；',
    '   · 知识掌握（knowledge_point / mastery）；',
    '   · 讲法偏好（explain_style / output_length / pace / practice_type）；',
    '   · 兴趣与类比（interest_topic）—— 他用什么例子、喜欢什么都算；',
    '   · 互动偏好（tone / encouragement_freq / challenge_level）—— 语气、要不要多夸、想不想难一点；',
    '   · 场景与目标（scene / task_goal）—— 什么时候学、想达到什么；',
    '   · 安全边界（safety_level / boundary_topics）—— 他说了不想聊什么、要什么提醒。',
    '   · 类型与性格（learner_style / personality）—— 他**自己说过的**学习倾向或性格；',
    '     值必须用给定词表里的词（下表在规则 7）。',
    '   以上是「按维度找」，不是「凑数」：某一维学生没说，就**跳过**，不要为了填满而编。',
    '6. 只能用学生**明确表达过**的偏好，不要替他决定；本地已经抽到的标签不要重复输出。',
    '7. 不要推断学生的心理状态、家庭情况或智能水平；不要因为他说了什么就给他下结论。',
    '   性格（personality）只能记**他自己说的**，值只能是这几个词：' + PERSONALITY_VALUES.join('、') + '。',
    '   学习类型（learner_style）值只能是这几个词：' + LEARNER_STYLE_VALUES.join('、') + '。',
    '8. 不要输出真名、学校、班级、手机号、身份证号；不要输出任何情绪或心理判断。'
  ].join('\n')

  const user = ['本地已抽出的候选标签（不必重复）：' + known, '学生的回答：', transcript].join('\n')
  return { system, user }
}

/**
 * 解析模型回执（**宽松读、严格校验、脏值丢弃**）。
 *
 * ★ 认不出 JSON / key 不在允许清单 / value 为空 → 那条丢掉（而不是整批作废，
 *   也不是回落成一个「看起来差不多」的值 —— 后者等于让模型编数据）。
 */
export function parseSummaryTags(raw: string): OnboardingTagWrite[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const stripped = raw.replace(/```(?:json)?/gi, ' ')
  const matched = /\{[\s\S]*\}/.exec(stripped)
  if (!matched) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(matched[0])
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const list = Array.isArray(record.tags) ? record.tags : []
  const out: OnboardingTagWrite[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const key = typeof entry.key === 'string' ? entry.key.trim() : ''
    const value = typeof entry.value === 'string' ? entry.value.trim().slice(0, MAX_VALUE_CHARS) : ''
    if (value === '') continue
    if (!ONBOARDING_SUMMARY_ALLOWED_KEYS.includes(key)) continue
    // ★ 维度 13（2026-09-30）：五问能写性格与学习类型，但值必须是封闭词表里的中文词 ——
    //   学生原话（「我有点马虎」）不能原样进库，模型要么选词表里最近的词（细心/急性子…），
    //   要么整条跳过。与持续概括侧 `parseRefreshTags` 同源判据、两处落点。
    if (key === 'personality' && !PERSONALITY_VALUE_SET.has(value)) continue
    if (key === 'learner_style' && !LEARNER_STYLE_VALUE_SET.has(value)) continue
    if (out.some((own) => own.key === key)) continue
    const rawConfidence = typeof entry.confidence === 'number' ? entry.confidence : Number(entry.confidence)
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : DEFAULT_CONFIDENCE
    out.push({ key: key as LlmVisibleTag, value, source: 'declared', confidence })
    if (out.length >= ONBOARDING_SUMMARY_MAX_TAGS) break
  }
  return out
}

/** 从 chat/completions 的回执里取正文（宽松读：各种形态都试一遍，取不到就是空串）。 */
function readContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const choices = Array.isArray(record.choices) ? record.choices : []
  const first = choices[0] as Record<string, unknown> | undefined
  if (!first || typeof first !== 'object') return ''
  const message = first.message as Record<string, unknown> | undefined
  const content = message && typeof message === 'object' ? message.content : first.text
  return typeof content === 'string' ? content : ''
}

/* ------------------------------------------------------------------ *
 * 实现
 * ------------------------------------------------------------------ */

/**
 * 造一个**真会调模型**的概括器。
 *
 * @param options.getConfig 取「生效中的 LLM 配置」（生产 = `refreshRuntimeLlmConfig`）。
 *   拿不到（没填 Key / sidecar 没起来）→ 直接降级，理由是可读中文。
 * @param options.fetchResponse 出网口（测试注入替身；默认全局 `fetch`）。
 */
export function createLlmSummarizer(options: {
  getConfig: LlmConfigProvider
  fetchResponse?: SummaryResponseFetch
}): OnboardingSummarizer {
  const fetchResponse = options.fetchResponse ?? llmFetch

  return async (input: OnboardingSummaryInput) => {
    let config: LlmSummarizerConfig | null = null
    try {
      config = await options.getConfig()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, degraded: true, reason: '读不到模型配置，本轮概括走降级：' + reason, tags: [] }
    }
    if (config === null || config.baseUrl.trim() === '' || config.modelId.trim() === '') {
      return { ok: false, degraded: true, reason: '没有可用的模型配置（设置还没读到），本轮概括走降级', tags: [] }
    }
    if (config.apiKey.trim() === '') {
      return { ok: false, degraded: true, reason: '还没有配置 API Key，本轮概括走降级', tags: [] }
    }

    const { system, user } = buildSummaryPayload(input)
    const body = JSON.stringify({
      model: config.modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      max_tokens: SUMMARY_MAX_TOKENS,
      stream: false
    })
    // ⚠️ Key 只在这一个 header 里出现；错误信息里**绝不回显**它（下面只带状态码）。
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.apiKey
    }
    // ★ 每次请求都要新造 signal：重试时第一次的请求可能还在飞，复用会被一起取消。
    const initFor = (): RequestInit => llmPostInit(headers, body, ONBOARDING_SUMMARY_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetchResponse(chatCompletionsUrl(config.baseUrl), initFor())
      // 404/405 = 地址写法不对（不是鉴权问题）：试一次 /v1 变体，仍不行才算失败
      if (response.status === 404 || response.status === 405) {
        const variant = chatCompletionsVariantUrl(config.baseUrl)
        if (variant !== null) response = await fetchResponse(variant, initFor())
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, degraded: true, reason: '概括请求没发出去（' + reason + '），本轮走降级', tags: [] }
    }

    if (!response.ok) {
      // ★ 只带状态码：回执正文里可能回显了提交的内容，而那里面有学生的回答
      return { ok: false, degraded: true, reason: '概括请求失败（HTTP ' + String(response.status) + '），本轮走降级', tags: [] }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { ok: false, degraded: true, reason: '概括回执不是合法 JSON，本轮走降级', tags: [] }
    }

    const tags = parseSummaryTags(readContent(payload))
    return { ok: true, degraded: false, reason: '', tags }
  }
}
