/**
 * 持续画像迭代 · **AI 小结**（三期，2026-09-30）—— 学习档案「五行结构」的第五行。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────
 *
 * 一段 60~140 字的中文，**对学生本人说**（「你最近在学……，更喜欢……」），
 * 让他一眼看出「智团团记住了我什么」。它由画像标签整理而来，**不引入任何新数据源**。
 *
 * ── 三条设计纪律（改这里之前先读完）─────────────────────────────────────
 *
 * 1. **变更后生成 + 缓存，读的时候永远不调模型**（用户裁决 D）：
 *    生成发生在**持续画像迭代落库成功之后**（fire-and-forget，见 `refresh.ts`），
 *    渲染层经 `profile:summary` 只读缓存 —— 打开档案页零 LLM 调用、零等待。
 *    代价是「最多滞后一个周期（5 轮）」，这是有意接受的（一段小结不值得让学生等 8 秒）。
 *
 * 2. **不进 SQLite**：画像表没有正文字段，那是既有纪律（多一列自由文本 =
 *    多一个「把对话正文塞进画像」的侧门）。小结落**主进程本地文件**
 *    （`<userData>/pi-agent/logs/profile-summary.json`，与冒烟日志同目录）。
 *
 * 3. **输入只有画像标签**：不把对话原文再发一遍（画像概括已经消化过一次），
 *    也不发真名 —— 载荷里连 `displayName` 这种参数都不存在（与 `payload.ts` 同一条红线）。
 *
 * ── 出网边界 ────────────────────────────────────────────────────────────
 *
 * 复用 `onboarding/summarize-llm.ts` 导出的 `llmFetch` / `chatCompletionsUrl`
 * （主进程唯一允许打外部模型服务的出口，守卫 G5）。⚠️ 本文件**不许出现裸 `fetch(`**。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { llmFetch, llmPostInit, type LlmChatFetch } from '../../bridge/llm-completions.ts'
import {
  chatCompletionsUrl,
  chatCompletionsVariantUrl,
  type LlmConfigProvider,
  type LlmSummarizerConfig
} from '../onboarding/summarize-llm.ts'
import { isLlmVisibleTag } from '../../../shared/profile-tags.ts'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 单次小结调用的超时（与概括同一口径：8s）。 */
export const SUMMARY_LINE_TIMEOUT_MS = 8_000

/** 最多尝试几次（= 自动重试 1 次，与概括同口径）。 */
export const SUMMARY_LINE_MAX_ATTEMPTS = 2

/** 采样预算（一段 140 字的中文小结，300 tokens 足够）。 */
export const SUMMARY_LINE_MAX_TOKENS = 300

/** 小结的**字数上限**（超出即截断；中文 220 字已在「一段话」的量级）。 */
export const SUMMARY_LINE_MAX_CHARS = 220

/** 小结的**字数下限**：短于它就视为无效（模型没写完 / 只说了一句废话）→ 不写缓存。 */
export const SUMMARY_LINE_MIN_CHARS = 20

/**
 * 小结里**不许出现**的词（命中即整段丢弃，不截断 —— 截断会留下半句更糟的话）。
 *
 * ★ 两类词：
 *   ① **临床 / 心理诊断词汇**：与 `personality` 词表同一条防线（禁做 #12）。
 *      小结是自由文本，词表约束不住它，所以要在这一层挡。
 *   ② **能力评价词**：给 10 岁孩子写「你很聪明 / 你比较笨」这类话，无论褒贬都是在
 *      给他贴能力标签（这正是本轮把「学习类型」做成**行为描述**而非能力判断的理由）。
 */
export const SUMMARY_LINE_FORBIDDEN_WORDS: readonly string[] = [
  // ① 临床 / 心理
  '抑郁',
  '焦虑',
  '多动',
  '自闭',
  '障碍',
  '诊断',
  '心理问题',
  // ② 能力评价（褒义也禁止：它诱发固定型思维）
  '聪明',
  '天才',
  '智商',
  '笨',
  '落后',
  '比别人差'
]

/** 小结里出现的**技术词**（学生面不该看到「标签」「数据」「系统」这类说法）。 */
export const SUMMARY_LINE_TECH_WORDS: readonly string[] = ['标签', '数据', '系统', '模型', 'AI', '算法']

/* ------------------------------------------------------------------ *
 * 载荷
 * ------------------------------------------------------------------ */

/** 载荷输入：**只有画像标签**（`key` / `value` 已在主进程过白名单）。 */
export interface SummaryLineInput {
  readonly knownTags: readonly { key: string; value: string }[]
}

/** 载荷（两条消息）。 */
export interface SummaryLinePayload {
  system: string
  user: string
}

/**
 * 组出网载荷。
 *
 * ★★ `displayName` 连入参都不存在（与 `buildRefreshPayload` 同一条红线）：
 *   「不传」是结构上的事实，而不是靠调用方自觉。
 * ★ 标签以 `key=value` 形态送出去（与 `buildRefreshPayload` 的 `knownTags` 同一口径）：
 *   key 是稳定的英文标识，模型据此判断维度。**不在这里另做一份 key→中文名的映射** ——
 *   那会成为中文名的第二份真相（唯一来源在后端契约的 `TAG_LABELS`）。
 */
export function buildSummaryLinePayload(input: SummaryLineInput): SummaryLinePayload {
  const list = input.knownTags
    .filter((item) => isLlmVisibleTag(item.key) && item.key !== 'anon_student_id')
    .map((item) => item.key + '=' + item.value)
    .join('；')

  const system = [
    '你是学生画像的整理助手。',
    '输入是一位 K12 学生**已经整理好的画像标签**（已脱敏，不含真名、学校、班级、联系方式）。',
    '任务：写一段中文小结，**直接对这位学生说**（用「你」），让他知道「智团团记住了他什么」。',
    '规则：',
    '1. 只输出这段小结本身 —— 不要标题、不要列表、不要 Markdown、不要引号。',
    '2. 只能依据给定的标签，**不要编造**任何没有给出的内容；信息少就写短一点。',
    '3. 语气平实、鼓励；不要评价他聪明或笨，也不要空泛地夸「你真厉害」。',
    '4. 不要出现真名、学校、班级、联系方式；不要提「标签」「数据」「系统」这类词。',
    '5. 不要对他的心理状态、家庭情况下判断。',
    '6. 长度 ' + String(SUMMARY_LINE_MIN_CHARS) + '~140 字，2~3 句话。'
  ].join('\n')

  const user = ['画像标签：' + (list === '' ? '（暂无）' : list)].join('\n')
  return { system, user }
}

/* ------------------------------------------------------------------ *
 * 解析 / 清洗
 * ------------------------------------------------------------------ */

/**
 * 解析模型回执 → 一段可直接展示的中文（**不合法就返回空串**，调用方据此不写缓存）。
 *
 * 清洗顺序（顺序不能乱）：
 *   ① 剥掉代码块围栏与首尾引号（模型很爱加）；
 *   ② 单行化（小结是一段话，换行会被界面读成两段）；
 *   ③ 违规词 / 技术词检查 → **命中即整段丢掉**（不截断：半句话更糟）；
 *   ④ 长度窗口检查（太短视为没写完，太长截断）。
 */
export function parseSummaryLine(raw: string): string {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/```[a-z]*/gi, ' ').replace(/```/g, ' ')
  text = text.replace(/^[\s"'「『]+|[\s"'」』]+$/g, '')
  text = text.split(/\s+/).join(' ').trim()
  if (text === '') return ''
  for (const word of SUMMARY_LINE_FORBIDDEN_WORDS) {
    if (text.includes(word)) return ''
  }
  for (const word of SUMMARY_LINE_TECH_WORDS) {
    if (text.includes(word)) return ''
  }
  if (text.length < SUMMARY_LINE_MIN_CHARS) return ''
  return text.length > SUMMARY_LINE_MAX_CHARS ? text.slice(0, SUMMARY_LINE_MAX_CHARS) : text
}

/* ------------------------------------------------------------------ *
 * 缓存（主进程本地文件，不进 SQLite）
 * ------------------------------------------------------------------ */

/** 一条缓存记录。 */
export interface SummaryLineCacheEntry {
  readonly studentId: string
  readonly text: string
  /** 生成时间（毫秒）。 */
  readonly generatedAt: number
  /** 生成时的画像指纹（画像变了就知道这条旧了）。 */
  readonly tagFingerprint: string
}

/** 小结缓存文件路径（与冒烟日志同目录：`<userData>/pi-agent/logs/`）。 */
export function summaryCachePath(userDataDir: string): string {
  return join(userDataDir, 'pi-agent', 'logs', 'profile-summary.json')
}

/**
 * 画像指纹：标签集合的稳定摘要（键值排序后做 djb2）。
 *
 * ★ 用途只有一个：**判断缓存是不是旧的**（画像变了 → 下次生成后指纹就变）。
 *   它不是安全边界，所以用一个便宜的散列即可 —— 不引依赖、不算密码学摘要。
 */
export function tagFingerprint(tags: readonly { key: string; value: string }[]): string {
  const normalized = [...tags]
    .filter((item) => isLlmVisibleTag(item.key))
    .map((item) => item.key + '=' + item.value)
    .sort()
    .join('|')
  let hash = 5381
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * 读缓存（读不到 / 形态不对 / 不是这个学生的 → `null`）。
 *
 * ★ 多学生共用一个文件：结构是 `{ entries: { [studentId]: entry } }`。
 *   ⚠️ 读取时**必须核对 studentId**（禁做 #9：绝不跨学生）—— 文件里同住着别人的小结，
 *   拿错了就是把 B 的小结显示给 A。
 */
export function readSummaryLineCache(
  userDataDir: string,
  studentId: string
): SummaryLineCacheEntry | null {
  if (!studentId) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(summaryCachePath(userDataDir), 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const entries = (parsed as { entries?: unknown }).entries
  if (!entries || typeof entries !== 'object') return null
  const entry = (entries as Record<string, unknown>)[studentId]
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text : ''
  if (text.trim() === '') return null
  return {
    studentId,
    text,
    generatedAt: typeof record.generatedAt === 'number' ? record.generatedAt : 0,
    tagFingerprint: typeof record.tagFingerprint === 'string' ? record.tagFingerprint : ''
  }
}

/**
 * 写缓存（**保留其它学生的条目**）。
 *
 * ★ 读-改-写：先读回整份，替换本学生那一条，再写回 —— 直接覆盖会把别人的小结抹掉。
 * ★ 失败**不抛**：写不进缓存只是「下次看还是旧小结」，绝不该把生成链路带崩。
 */
export function writeSummaryLineCache(userDataDir: string, entry: SummaryLineCacheEntry): void {
  try {
    const file = summaryCachePath(userDataDir)
    let all: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown }
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        all = parsed.entries as Record<string, unknown>
      }
    } catch {
      /* 文件不存在 / 坏了：从头建一份（坏文件不阻断写入） */
    }
    all[entry.studentId] = {
      text: entry.text,
      generatedAt: entry.generatedAt,
      tagFingerprint: entry.tagFingerprint
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, entries: all }, null, 2), 'utf8')
  } catch {
    /* 见上：写缓存失败不是错误路径 */
  }
}

/* ------------------------------------------------------------------ *
 * 生成（编排）
 * ------------------------------------------------------------------ */

/** 生成小结的接线面（全部可注入）。 */
export interface SummaryLineDeps {
  /** 取「生效中的 LLM 配置」（与概括同一份来源）。 */
  getConfig: LlmConfigProvider
  /** 模型出网口（测试注入替身；默认 `llmFetch`）。 */
  fetchResponse?: LlmChatFetch
  /** 缓存目录（生产 = `runtime` 的 `userDataDir`）。 */
  userDataDir: string
  log?: (line: string, level?: 'info' | 'warn' | 'error') => void
}

/**
 * 生成一段小结并写缓存（**fire-and-forget**；调用方 `void generateSummaryLine(...)`）。
 *
 * 流程：① 构载荷 → ② 调模型（超时 + 重试 1 次）→ ③ 解析清洗 → ④ 写缓存。
 *
 * ★ 任何一步失败都**只是不更新小结**（旧缓存继续用 / 首次则显示空态文案），
 *   绝不抛给调用方 —— 它是锦上添花，不是任何流程的前置条件。
 *
 * @returns 写进缓存的小结（`''` = 这次没生成成功）。
 */
export async function generateSummaryLine(
  studentId: string,
  knownTags: readonly { key: string; value: string }[],
  deps: SummaryLineDeps
): Promise<string> {
  const log = deps.log ?? ((): void => {})
  if (!studentId || deps.userDataDir.trim() === '') return ''

  let config: LlmSummarizerConfig | null = null
  try {
    config = await deps.getConfig()
  } catch (error) {
    log('[profile-summary] 读模型配置失败，本轮不生成：' + describeError(error), 'warn')
    return ''
  }
  if (
    config === null ||
    config.baseUrl.trim() === '' ||
    config.modelId.trim() === '' ||
    config.apiKey.trim() === ''
  ) {
    // 没有可用配置：与概括同口径 —— 什么都不做（等配置补上，下一轮画像变更会再来）
    return ''
  }

  const payload = buildSummaryLinePayload({ knownTags })
  const fetchResponse = deps.fetchResponse ?? llmFetch
  for (let attempt = 1; attempt <= SUMMARY_LINE_MAX_ATTEMPTS; attempt += 1) {
    const text = await callModelOnce(config, payload, fetchResponse)
    if (text !== '') {
      writeSummaryLineCache(deps.userDataDir, {
        studentId,
        text,
        generatedAt: Date.now(),
        tagFingerprint: tagFingerprint(knownTags)
      })
      log('[profile-summary] 小结已更新（' + String(text.length) + ' 字）')
      return text
    }
    if (attempt < SUMMARY_LINE_MAX_ATTEMPTS) {
      log('[profile-summary] 小结生成失败，自动重试 1 次', 'warn')
    }
  }
  log('[profile-summary] 小结生成走降级（两次都没成），保留旧缓存', 'warn')
  return ''
}

/** 调一次模型并解析（失败 / 清洗后为空 → 空串）。 */
async function callModelOnce(
  config: LlmSummarizerConfig,
  payload: SummaryLinePayload,
  fetchResponse: LlmChatFetch
): Promise<string> {
  const body = JSON.stringify({
    model: config.modelId,
    messages: [
      { role: 'system', content: payload.system },
      { role: 'user', content: payload.user }
    ],
    temperature: 0.6,
    max_tokens: SUMMARY_LINE_MAX_TOKENS,
    stream: false
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + config.apiKey
  }
  const initFor = (): RequestInit => llmPostInit(headers, body, SUMMARY_LINE_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetchResponse(chatCompletionsUrl(config.baseUrl), initFor())
    if (response.status === 404 || response.status === 405) {
      const variant = chatCompletionsVariantUrl(config.baseUrl)
      if (variant !== null) response = await fetchResponse(variant, initFor())
    }
  } catch {
    return ''
  }
  if (!response.ok) return ''
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return ''
  }
  return parseSummaryLine(readContent(parsed))
}

/** 从 chat/completions 回执里取正文（宽松读；与概括同一手法）。 */
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
