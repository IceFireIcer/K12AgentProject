/**
 * 画像 Extension（票 08 建立，票 20 补齐个性化闭环）：注册 `get_student_profile` 与
 * `remember_preference`，并导出每轮预取的 {@link fetchStudentContext}。
 *
 * 闭环的三条边都在本文件里（读 / 写 / 注入）：
 *   - **读**：`get_student_profile` Tool（模型主动要画像时）+ 每轮的 {@link fetchStudentContext}；
 *   - **写**：`remember_preference` Tool（模型观察到稳定偏好时 → `PUT .../preferences`）；
 *   - **注入**：`fetchStudentContext` 的产物由 `runtime.ts` 的 `buildSystemPrompt()` 拼进
 *     system prompt（正文渲染复用 {@link renderProfileText}，**只有一份实现**）。
 *
 * 职责：把「这个学生现在会什么、卡在哪、适合下一步学什么」交给主 Agent，
 * 让它在**同一轮**里调整讲解深度与例子 —— 这是「个性化学习路径」在对话里的落点。
 *
 * ★ 闭环的「读」这一端（票 20）：``recommendedKpIds`` 由 Python 侧的
 *   ``app/routes/profile.py`` 用**依赖图 + 掌握度**算出（掌握「变量」→ 推荐「循环」），
 *   本文件只把它渲染成给模型看的一句话。**不要在 TS 侧再算一份推荐** ——
 *   两套推荐会给出两个「下一步」，而学生只会看到其中一个。
 *
 * ★ 三条硬约束（都不是实现细节，是架构决策）：
 *
 * 1. **学生身份由主进程注入，不是 Tool 参数**（{@link currentAgentSession}）。
 *    `get_student_profile(student_id=...)` 这种形状一旦存在，模型就有机会读到**别的学生**的画像；
 *    身份只能来自渲染进程「当前选中的学生」，模型连表达「读别人」的能力都不该有。
 * 2. **只走 `bridge/client.ts`**（`apiFetch`）：token 注入与「渲染进程不直连 sidecar」这两条
 *    都靠这唯一的出口保证（有架构守卫）。本文件**不碰 fetch**，也不接触 token。
 * 3. **`execute()` 自兜异常、绝不抛出**：Pi 的 Extension 与 Agent 同在主进程，
 *    抛异常会同时带走 UI；失败一律返回可读中文 + `details.ok=false`
 *    （`details.ok=false` 会被轨迹图如实记成失败，见 `agent/trace.ts` 的 `toolResultOk`）。
 *
 * ★ **不缓存、不落第二份副本**（票 20 明确要求）：每次调用都真发一次
 *   `GET /api/profile/{student_id}`。缓存会让「上一轮的掌握度变化改变下一轮的推荐输入」
 *   这条闭环失效 —— 而那正是这一票要证明的东西。
 *
 * 画像数据本身来自 Python 侧一人一份的 `learning.db`（§8.1，`learning_history` **不存对话正文**）。
 */

import { Type, type Static } from '@sinclair/typebox'
// ★ 学生情况块的正文渲染**只有一份实现**（`renderProfileText`）：本文件把它同时用于
//   ①`get_student_profile` Tool 的返回；②每轮注入 system prompt 的那一节。别在本文件里
//   再写一份「给 Prompt 看的」渲染 —— 两套必然漂移。
//   ⚠️ `STUDENT_CONTEXT_HEADING` 只在**函数体内**引用（不在模块顶层 const 里）：
//     `prompts/student-context.ts` 与本文件互相 import（它要 `renderProfileText`），
//     顶层读对方的值会踩循环导入的 TDZ（本仓库 `extensions/index.ts` ↔ `learning-log.ts`
//     那条边已经有同样的教训）。
import { renderStudentContextBlock, STUDENT_CONTEXT_HEADING } from '../prompts/student-context.ts'
import {
  currentAgentSession,
  SIDECAR_UNAVAILABLE_TEXT,
  toolFailure,
  toolSuccess,
  type AgentExtensionApi
} from './index.ts'

/** 参数 schema（TypeBox `TSchema`；冻结口径见 `desktop/scripts/check-tool-schema.mjs`）。 */
export const GetStudentProfileParams = Type.Object({
  /** 返回掌握度条目的上限（Prompt 预算控制；默认 8，最多 20）。 */
  max_mastery: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      default: 8,
      description: '掌握度条目上限，用于控制注入 Prompt 的长度'
    })
  )
})

/**
 * 单次 sidecar 调用的超时（F9）。
 *
 * ★ 为什么必须有它：本 Tool 在**主 Agent 的对话路径**上，sidecar 假死时没有超时
 *   就等于这一轮永久 pending（学生只看到转圈）。数值与 `rag-search.ts` 的
 *   `RAG_SEARCH_TIMEOUT_MS` 同一口径（本机回环，超过 8 秒说明进程已经不正常了）。
 */
export const PROFILE_TIMEOUT_MS = 8_000

/**
 * ★ 每轮**预取**画像的超时（比 {@link PROFILE_TIMEOUT_MS} 短得多）。
 *
 * 为什么和 Tool 那条不是一个数：`fetchStudentContext()` 挂在**每轮对话的最前面**
 * （`runtime.ts` 的 `runTurn()`，在 `reviewInput` 与 `session.prompt()` 之前）——
 * 它卡的每一毫秒都是学生等首字的毫秒。本机回环 + 一个 SQLite 查询的正常耗时是个位数毫秒，
 * 3 秒还没回来说明 sidecar 已经不正常了，这时**正确地降级**（不注入画像）比继续等更有价值。
 * Tool 那条则在模型主动要画像时跑，可以容忍更久。
 */
export const STUDENT_CONTEXT_TIMEOUT_MS = 3_000

export type GetStudentProfileParamsType = Static<typeof GetStudentProfileParams>

/**
 * `remember_preference` 的参数 schema（TypeBox `TSchema`；**导出**供
 * `desktop/scripts/check-tool-schema.mjs` 做「防静默漂移」断言）。
 *
 * ★ 这个 Tool 是「个性化闭环」里**写**的那一端：学生在前几轮里表现出的稳定偏好
 *   （喜欢用例子、要更慢的节奏……）由模型判断后记下来，下一次 `GET /api/profile/{id}`
 *   就会把它带回 Prompt 里的「学习偏好」那行 —— 闭环因此不需要任何界面入口。
 *
 * ⚠️ 键**只有四个**（`contracts.py` 的偏好白名单，冻结）：
 *   自由键会让 `learning.db` 里长出一堆拼写各异的字段（`interest` / `interests` / `hobby`），
 *   而本文件的「学习偏好」渲染是 `key=value` 直连的 —— 脏键会原样进 Prompt。
 */
export const RememberPreferenceParams = Type.Object({
  key: Type.Union(['interest', 'explain_style', 'pace', 'note'].map((name) => Type.Literal(name)), {
    description:
      '偏好类别（四个取值）：interest=兴趣方向（学生反复主动想聊的内容）；' +
      'explain_style=讲解方式偏好（比喻 / 步骤化 / 先给结论 / 多举例子…）；' +
      'pace=节奏偏好（想快一点 / 想慢一点 / 需要多练几遍）；note=其它稳定的学习方式。'
  }),
  value: Type.String({
    minLength: 1,
    maxLength: 40,
    description:
      '一句话描述这个偏好（**只写学习方式**，例如「喜欢用生活中的例子」「想先看结论」）。' +
      '严禁写姓名、学校、住址、电话、账号等个人信息 —— 这段文字会进入后续每一轮的提示词。'
  })
})

export type RememberPreferenceParamsType = Static<typeof RememberPreferenceParams>

/**
 * `GET /api/profile/{student_id}` 的响应形状（`contracts.py` 的出参，camelCase 由 alias 转）。
 *
 * ★ 导出是给 `prompts/student-context.ts` 用的（那个模块的签名必须是 `ProfileResponse | null`）——
 *   **不要**在别处再声明一个同名的结构：那会变成两份会漂移的「画像形状」。
 */
export interface ProfileResponse {
  student?: {
    studentId?: string
    nickname?: string
    gradeLevel?: string
    createdAt?: number
    lastActiveAt?: number
    /**
     * 学生当前学习的教材章节标题（= `ChapterInfo.chapter_title`）。
     *
     * ★ 它是**软偏好**：由学生自己显式选定（`chapter:set` 那条通道），
     *   让回答与检索**优先围绕本章**，但**不改检索契约、不做 SQL 硬过滤** ——
     *   学生问别的章节照常回答。所以它渲染出来是一句「优先」而不是一条「只能」。
     * ★ 空串 / 缺失 = 未选择章节（那一行整行不出现，不是空行）。
     * ★ 只有学生改动时它才变 → 放进每轮都渲染的块里是安全的（D-032）。
     */
    currentChapter?: string
  }
  mastery?: Array<{
    kpId?: string
    score?: number
    attempts?: number
    correct?: number
    lastSeenAt?: number | null
  }>
  preferences?: Record<string, string>
  recommendedKpIds?: string[]
}

/** `GET /api/profile/{student_id}/recommendation` 的响应形状（票 20；同样导出，见上）。 */
export interface RecommendationResponse {
  source?: string
  summary?: string
  items?: Array<{
    kpId?: string
    name?: string
    gradeLevel?: string | null
    depth?: number
    mastery?: number
    reason?: string
  }>
}

/**
 * 错题端点（`GET /api/quiz/mistakes/{student_id}`）的**最小**回执形状。
 *
 * ★ 只取渲染进 Prompt 真正要用的字段。特别是：
 *   - **不取 `stem`（题干）**：注入块每轮都在首位，题干会把真正相关的教材上下文挤掉，
 *     而模型手里本来就有当前这轮题目的上下文；
 *   - **不取 `lastWrongAt`（时间）**：那是每轮/每天都会变的字节，会毁掉前缀缓存
 *     （D-032 / G21 组的硬规则，见 `renderProfileText` 头部的第二条纪律）。
 *     只取「错了几个知识点 + 错了几次」这种**低频变化**的结构信息。
 */
export interface MistakesResponse {
  studentId?: string
  items?: Array<{
    kpId?: string
    kpName?: string
    wrongCount?: number
  }>
  totalWrong?: number
  withoutStem?: number
}

/** 推荐来源的中文说法（只用于给模型的一句提示，**不是**界面文案）。 */
const RECOMMENDATION_SOURCE_LABELS: Record<string, string> = {
  review: '优先重练（这个知识点还没练熟）',
  graph: '依赖图后继（前置已掌握）',
  cold_start: '学习路线起点（新学生）',
  empty: '暂无（知识库或学习记录不足）'
}

/** 学段的中文名（**只用于拼给模型看的一句话**；学段语气由 Prompt 模板负责，见 `prompts/`）。 */
const GRADE_LABELS: Record<string, string> = {
  primary_low: '小学低年级',
  primary_high: '小学高年级',
  junior: '初中',
  senior: '高中'
}

/** 掌握度分档（给模型一个可以直接照做的难度指示，而不是一个 0.42 让模型自己猜）。 */
function masteryBand(score: number): string {
  if (score >= 0.8) return '已掌握'
  if (score >= 0.6) return '基本掌握'
  if (score >= 0.3) return '正在学'
  return '刚接触'
}

/**
 * ★ 偏好键的**固定渲染顺序**（不是随便定的，见下）。
 *
 * 为什么必须固定：块要满足「同样的画像 → **逐字节相同**的块」（守卫在
 * `tests/student-context.test.ts` 的 G21 组）。偏好来自 `profile_pref` 表，
 * 而 `LearningStore.preferences()` 是 `SELECT key, value` **不带 ORDER BY** ——
 * 行序取决于 SQLite 的存储布局（rowid / 索引），**重写同一个键会让它在结果里挪位置**。
 * 于是「模型把 pace 从『慢一点』改成『快一点』」这种只改一个值的写入，也会因为
 * 键序变化而让整块变样 —— 白白丢掉一次缓存命中，而且丢得毫无理由。
 * 按固定顺序输出则把这种抖动从根上消掉。
 *
 * 选择依据：把「长期不变、最能定调」的放前面，「工具顺手记的」放最后
 * （顺序只影响可读性，不影响正确性 —— 但**必须**是常量，不能是 `Object.keys()`）。
 */
export const PREFERENCE_ORDER: readonly string[] = ['interest', 'explain_style', 'pace', 'note']

/** 按 {@link PREFERENCE_ORDER} 排偏好（词表外的键排在最后，再按字典序 —— 仍然是确定的）。 */
export function orderPreferences(preferences: Record<string, string>): Array<[string, string]> {
  const rank = (key: string): number => {
    const at = PREFERENCE_ORDER.indexOf(key)
    return at < 0 ? PREFERENCE_ORDER.length : at
  }
  return Object.entries(preferences).sort((a, b) => {
    const byRank = rank(a[0]) - rank(b[0])
    return byRank !== 0 ? byRank : a[0].localeCompare(b[0])
  })
}

/**
 * ★ 错题注入块里**最多列几个知识点**（不是错题条数：同一个知识点错十次仍算一条）。
 *
 * 为什么有这个上限：块在**每一轮**的首位，列太多会把真正相关的教材上下文挤下去；
 * 而模型的用法是「知道哪些地方没练熟，出题时照顾一下」——三个足够。
 */
export const MISTAKE_INJECT_LIMIT = 3

/**
 * 挑出要注入的错题并**钉死顺序**（纯函数，可单测）。
 *
 * 排序：错得多的在前；平局按 `kpId` 字典序。
 * ★ 平局的兜底键**必须**有：只按 `wrongCount` 排的话，同样错 2 次的两个知识点
 *   谁在前取决于服务端返回顺序 —— 那会让块在数据没变的情况下变样（D-032 / G21-2）。
 * ★ 这里**只回名字**，不回题干、不回时间：见 {@link MistakesResponse} 的注释。
 */
export function pickMistakesToInject(
  mistakes: MistakesResponse | null,
  limit: number = MISTAKE_INJECT_LIMIT
): Array<{ kpId: string; label: string; wrongCount: number }> {
  const items = (mistakes?.items ?? []).filter(
    (item) => typeof item.kpId === 'string' && item.kpId.length > 0
  )
  return [...items]
    .sort(
      (a, b) =>
        Number(b.wrongCount ?? 0) - Number(a.wrongCount ?? 0) ||
        String(a.kpId).localeCompare(String(b.kpId))
    )
    .slice(0, Math.max(1, limit))
    .map((item) => {
      const kpId = String(item.kpId)
      const name = typeof item.kpName === 'string' ? item.kpName.trim() : ''
      // 名字与 id 相同（服务端查不到名字时的退路）不算「有名字」
      const label = name && name !== kpId ? name : kpId
      return { kpId, label, wrongCount: Number(item.wrongCount ?? 0) }
    })
}

/**
 * 把画像渲染成**给模型看**的一段中文摘要（纯函数，可单测）。
 *
 * 三条纪律：
 *   - 掌握度按分数**降序**并截断到上限；一次注入几十条掌握度只会挤掉真正相关的教材上下文；
 *   - **只输出「这个学生是什么样」，不输出「现在几点」**：本函数的产物会进 system prompt，
 *     而 system prompt 是前缀缓存的**最前面一段**。任何每轮都会变的字节（时间、计数器、会话 id）
 *     都会让整段前缀 + 其后全部对话历史一起失去缓存命中 —— 而「上次活跃是几分钟前」
 *     对教学决策没有任何价值（真正要老师注意的「好久没来了」是**天级**信号，
 *     需要时由推荐链或专门字段表达，不该靠一个每分钟都变的时间戳顺带捎上）。
 *     ★ `student.lastActiveAt` 在契约里**保留**（界面要用），只是**不进给模型的这一段**。
 *   - 明确告诉模型「这是内部数据，不要整段念给学生」—— 画像里的 `kpId` 是机器口径，
 *     直接念出来（`prog-loop-jr`）学生完全看不懂。
 * ★ 章节那一行的位置是**固定**的（紧跟标题行）：块是前缀缓存的最前面一段，
 *   靠 `Object.entries` 之类的顺序把行排出来会让「同样的画像 → 不同的块」（G23-1）。
 */
export function renderProfileText(
  profile: ProfileResponse,
  options: {
    maxMastery?: number
    fallbackStudentId?: string
    recommendation?: RecommendationResponse | null
    /** 错题摘要（学习档案的错题本同源）；取不到就不注入那一行。 */
    mistakes?: MistakesResponse | null
  } = {}
): string {
  const maxMastery = Math.max(1, Math.min(20, options.maxMastery ?? 8))
  const student = profile.student ?? {}
  const studentId = student.studentId ?? options.fallbackStudentId ?? '(未知)'
  const grade = student.gradeLevel ? (GRADE_LABELS[student.gradeLevel] ?? student.gradeLevel) : '未设置'

  const lines: string[] = [`【学习画像 · 内部数据，不要整段念给学生听】学生：${studentId}（${grade}）`]

  // ★ 当前教材章节（软偏好）：**紧跟标题行、在掌握度之前**的固定位置。
  //   ★★ 必须写在这里、不能改写进 `map` / `Object.entries` 的顺序里 —— 位置一变，
  //     同样的画像会渲染出不同的块，前缀缓存白白失效（D-032 / G23 钉着这一点）。
  //   ★★ 这一行**只放学生选定的章标题**：不放进度百分比、不放时间 ——
  //     教材章节只在学生改动时变，而任何「每轮都在变」的量都会毁掉整个 system prompt 前缀。
  //   ★ 没有章节（空串 / 缺失 / 非字符串）时**整行不出现**（不是空行）；
  //     `currentChapter` 来自 `GET /api/profile/{id}`（复用每轮已有的那一次请求，
  //     **不新增 HTTP**）—— 见 `fetchStudentContext`。
  const chapter = typeof student.currentChapter === 'string' ? student.currentChapter.trim() : ''
  if (chapter) {
    // ★★ 2026-09-21：从「查询偏好」降为**纯背景**（D-064）。
    //   原文是「回答与检索**优先围绕本章**；学生若问其他章节，照常回答」——
    //   后半句虽然在，但前半句把章节写成了**行动指引**，模型会往本章上拽。
    //   产品口径：教材与知识点只是回答的**参考**，学生问什么就聊什么。
    lines.push(`- 学生当前在看：${chapter}（只是背景，不必刻意围绕它）`)
  }

  const mastery = [...(profile.mastery ?? [])]
    .filter((item) => typeof item.kpId === 'string' && item.kpId.length > 0)
    // 平局按 kpId 字典序：只按分数排的话，同分条目之间的先后由**输入数组的顺序**决定，
    // 而那个顺序来自服务端 SQL（`ORDER BY score DESC, kp_id` —— 它有兜底；
    // 但契约不禁止调用方换顺序）。渲染端自己钉死，块才与输入顺序无关。
    .sort(
      (a, b) =>
        Number(b.score ?? 0) - Number(a.score ?? 0) || String(a.kpId).localeCompare(String(b.kpId))
    )

  if (mastery.length === 0) {
    lines.push('- 还没有掌握度记录：这是这个学生的第一次对话，先用一个具体的小例子建立概念，别急着上难度。')
  } else {
    lines.push(`- 掌握度（共 ${mastery.length} 条，按分数降序显示前 ${Math.min(mastery.length, maxMastery)} 条）：`)
    for (const item of mastery.slice(0, maxMastery)) {
      const score = Number(item.score ?? 0)
      const attempts = Number(item.attempts ?? 0)
      const correct = Number(item.correct ?? 0)
      lines.push(
        `  - ${item.kpId}：${score.toFixed(2)}（${masteryBand(score)}；${attempts} 次作答，答对 ${correct} 次）`
      )
    }
  }

  // ★ 顺序由 `orderPreferences` 钉死（不是 `Object.entries` 的原始顺序）：
  //   后者取决于 SQLite 的行序，重写同一个键就可能让整块变样 —— 见那里的注释。
  const preferences = orderPreferences(profile.preferences ?? {})
  if (preferences.length > 0) {
    lines.push(
      `- 学习偏好：${preferences
        .slice(0, 6)
        .map(([key, value]) => `${key}=${value}`)
        .join('；')}`
    )
  }

  // ★ 推荐（票 20）：优先用 `/recommendation` 的**带理由**版本（它还会说明「为什么」：
  //   是重练、是依赖图后继、还是冷启动）。取不到就退回 `/profile` 里的 kp_id 列表 ——
  //   两条路径的数据来源**同一处**（Python 的 `build_recommendation`），只是详细程度不同。
  lines.push(...renderRecommendationLines(profile, options.recommendation ?? null))

  // ★ 错题摘要（学习档案的错题本与这里**同源**）：`senior.ts` 早就要求
  //   「错题要给变式题巩固」，而模型此前手里没有任何错题数据 —— 那条要求一直是悬空的。
  //   这里补上「哪些地方错过、错了多少次」，让那条要求有数据支撑。
  const mistakes = pickMistakesToInject(options.mistakes ?? null)
  if (mistakes.length > 0) {
    lines.push(
      `- 错过的地方（按错次降序）：${mistakes
        .map((item) => `${item.label}（错 ${item.wrongCount} 次）`)
        .join('；')}`
    )
    lines.push(
      '  - 对上面这些地方：如果这一轮聊到相关内容，**再出一道变式题巩固**，并用学生听得懂的话点出他容易栽在哪。'
    )
  }

  // ★ 这里**故意没有「最近活跃」那一行**（曾经有）：它是每轮都会变的时间戳，
  //   会把 system prompt 整段从前缀缓存里踢出去（缓存丢失的是它**后面**的全部对话历史）。
  //   理由与取舍写在本函数头部的第二条纪律里 —— 不要因为「看着信息更全」再加回来。
  lines.push('注意：面向学生的回答里不要出现知识点 id、分数这类内部字段，用自然语言说「你已经会…，我们试试…」。')
  return lines.join('\n')
}

/** 推荐那几行（带理由时用详细版；否则退回 kp_id 列表）。 */
function renderRecommendationLines(
  profile: ProfileResponse,
  recommendation: RecommendationResponse | null
): string[] {
  const items = (recommendation?.items ?? []).filter(
    (item) => typeof item.kpId === 'string' && item.kpId.length > 0
  )
  if (items.length > 0) {
    const source = recommendation?.source ?? ''
    const why = RECOMMENDATION_SOURCE_LABELS[source] ?? '依赖图推荐'
    const listed = items
      .slice(0, 6)
      .map((item) => {
        const name = item.name ? `${item.name}（${item.kpId}）` : item.kpId
        const score = Number(item.mastery ?? 0)
        return `${name} 掌握度 ${score.toFixed(2)}`
      })
      .join('；')
    return [
      `- 推荐下一步（${why}）：${listed}`,
      recommendation?.summary
        ? `- 想带一下方向时，可以用类似的意思说（不必逐字照搬）：${recommendation.summary}`
        : '- 需要时可以顺着这条线带一带；学生想聊别的就跟着他聊。'
    ]
  }

  const recommended = (profile.recommendedKpIds ?? []).slice(0, 6)
  return [
    recommended.length > 0
      ? `- 依赖图推荐的下一个知识点：${recommended.join(', ')}（需要时可以提一句）`
      : '- 依赖图推荐：暂无（掌握度不足或依赖图未命中，按当前问题本身作答即可）'
  ]
}

/** 画像端点（`GET /api/profile/{student_id}`）。 */
export const profilePath = (studentId: string): string =>
  `/api/profile/${encodeURIComponent(studentId)}`

/** 推荐端点（`GET /api/profile/{student_id}/recommendation`，票 20）。 */
export const recommendationPath = (studentId: string): string =>
  `/api/profile/${encodeURIComponent(studentId)}/recommendation`

/** 偏好写入端点（`PUT /api/profile/{student_id}/preferences`，body `{key, value}`）。 */
export const preferencesPath = (studentId: string): string =>
  `/api/profile/${encodeURIComponent(studentId)}/preferences`

/**
 * 错题端点（`GET /api/quiz/mistakes/{student_id}`）。
 *
 * ★ 与「学习档案 → 错题本」**同一个端点**：页面显示什么，模型就拿到什么 ——
 *   两处各取一份数据的话，学生看到的错题与模型以为的错题会慢慢对不上。
 */
export const mistakesPath = (studentId: string): string =>
  `/api/quiz/mistakes/${encodeURIComponent(studentId)}`

/**
 * ★★ 每轮**预取**学生情况块（`runtime.ts` 的 `runTurn()` 调，结果进 system prompt）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有它
 * ---------------------------------------------------------------------------
 * 画像此前只在模型**主动**调 `get_student_profile` 时才被看到 —— 不主动调就永远不进 Prompt。
 * 本函数把画像变成每轮的固定上下文（掌握度 / 偏好 / 推荐下一步），
 * 让「个性化」不依赖模型的自觉。正文渲染复用 {@link renderProfileText}（唯一实现）。
 *
 * ---------------------------------------------------------------------------
 * 为什么失败一律降级（绝不抛、不阻断对话）
 * ---------------------------------------------------------------------------
 * 画像只是**增强**：sidecar 挂了 / 3 秒超时 / 响应畸形时，正确的行为是
 * 「这一轮不带画像照常对话」，而不是把学生卡在转圈里（它是**首字之前**的一步）。
 * 所以三段式：
 *   - **成功** → `renderStudentContextBlock(profile, { recommendation })`；
 *   - **404（新学生，还没有一行学习记录）** → 给一行「这是第一次对话」的提示，
 *     **不是空串** —— 冷启动恰恰是最需要引导的场合，模型要据此先建立概念、别急着上难度；
 *   - **其它任何失败**（连不上 / 超时 / 非 404 状态码 / JSON 读不出来）→ `''`（不注入），
 *     只留一条结构性 warn（**不带任何正文**，§12）。
 *
 * ★ 两个请求**并行**（`Promise.allSettled` + 各自 3 秒预算）：串行会把首字的等待翻倍，
 *   而推荐只是增强 —— 它超时不该把已经拿到的画像一起丢掉，所以**各算各的**：
 *   推荐拿不到就退回画像自带的 `recommendedKpIds`（`renderProfileText` 里已有这条退路）。
 */
export async function fetchStudentContext(studentId: string): Promise<string> {
  try {
    // ★ 调用点动态 import（与 Tool 同因，见 `get_student_profile` 里的注释）：
    //   `bridge/client.ts` 有一处缺 `.ts` 的导入，Node 直跑 TS 时整个模块导入失败；
    //   推迟到真正发请求那一刻，本文件里那些纯函数就还能被 `node --test` 覆盖。
    const { apiFetch } = await import('../../bridge/client.ts')
    const [profileOutcome, recommendationOutcome, mistakesOutcome] = await Promise.allSettled([
      withBudget(requestProfile(apiFetch, studentId)),
      withBudget(fetchRecommendation(apiFetch, studentId)),
      withBudget(fetchMistakes(apiFetch, studentId))
    ])

    const probe = settle(profileOutcome)
    if (probe.kind === 'timeout') {
      warnDegraded(studentId, `读取画像超过 ${STUDENT_CONTEXT_TIMEOUT_MS}ms 未返回`)
      return ''
    }
    if (probe.kind === 'rejected') {
      warnDegraded(studentId, probe.reason)
      return ''
    }
    if (probe.value.kind === 'notFound') return coldStartBlock()
    if (probe.value.kind === 'failed') {
      warnDegraded(studentId, probe.value.reason)
      return ''
    }

    const recommendation = settle(recommendationOutcome)
    const mistakes = settle(mistakesOutcome)
    return renderStudentContextBlock(probe.value.profile, {
      // 推荐取不到（超时 / 失败）→ `null`：`renderProfileText` 会退回画像自带的 kp_id 列表
      recommendation: recommendation.kind === 'ok' ? recommendation.value : null,
      // 错题同理：取不到就不注入那一行（新学生 404 也走这条 —— 没做过题就没有错题）
      mistakes: mistakes.kind === 'ok' ? mistakes.value : null,
      fallbackStudentId: studentId
    })
  } catch (error) {
    // ★ 绝不抛出：调用方在**每轮对话的主路径**上（Pi 与 UI 同进程，抛出去会同时带走两者）
    warnDegraded(studentId, error instanceof Error ? error.message : String(error))
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * 预取的内部零件（不导出：外部只认 fetchStudentContext 一个出口）
 * ------------------------------------------------------------------ */

/** 单次画像请求的结论（`notFound` 用来把「新学生」与「服务不可用」分开）。 */
type ProfileProbe =
  | { kind: 'ok'; profile: ProfileResponse }
  | { kind: 'notFound' }
  | { kind: 'failed'; reason: string }

/** `Promise.allSettled` 的超时哨兵（用它区分「超时」与「真的返回了 null」）。 */
const TIMED_OUT = Symbol('student-context-timeout')

/** 取画像一次；**只有传输层错误才抛**（由调用点的 try/catch 兜住）。 */
async function requestProfile(
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  studentId: string
): Promise<ProfileProbe> {
  const response = await apiFetch(profilePath(studentId), {
    method: 'GET',
    signal: AbortSignal.timeout(STUDENT_CONTEXT_TIMEOUT_MS)
  })
  // ★ 404 是**新学生**的正常形态（一人一库，还没写过任何记录），不是故障
  if (response.status === 404) return { kind: 'notFound' }
  if (!response.ok) return { kind: 'failed', reason: `HTTP ${response.status}` }
  const payload = (await response.json()) as unknown
  // 结构不认（sidecar 版本不匹配 / 返回了别的端点的东西）→ 当作失败，绝不当成画像用
  if (!payload || typeof payload !== 'object') return { kind: 'failed', reason: '响应结构不认' }
  return { kind: 'ok', profile: payload as ProfileResponse }
}

/**
 * 给一个 Promise 加时间预算（超时 resolve 成 {@link TIMED_OUT}，**不 reject**）。
 *
 * 为什么 `fetchRecommendation` 这条也要包：它内部用的是 `PROFILE_TIMEOUT_MS`（8s，Tool 口径），
 * 而这里是**首字之前**的等待 —— 8 秒的敞口会把「画像预取」变成学生等最久的一步。
 * 包一层之后，每个请求都严格受 {@link STUDENT_CONTEXT_TIMEOUT_MS} 约束。
 */
function withBudget<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    work,
    new Promise<typeof TIMED_OUT>((resolve) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), STUDENT_CONTEXT_TIMEOUT_MS)
      // 计时器不该拖住退出（Node 的 timers 会 ref，这里主动 unref）
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
  ])
}

/**
 * 展开 `allSettled` 的结果：三种情形分开（**不要把「连不上」说成「超时」** —— 排查时那两句
 * 指向完全不同的原因：前者是 sidecar 没起来，后者是它卡住了）。
 */
function settle<T>(
  outcome: PromiseSettledResult<T | typeof TIMED_OUT>
): { kind: 'ok'; value: T } | { kind: 'timeout' } | { kind: 'rejected'; reason: string } {
  if (outcome.status === 'rejected') {
    const reason = outcome.reason
    return { kind: 'rejected', reason: reason instanceof Error ? reason.message : String(reason) }
  }
  if (outcome.value === TIMED_OUT) return { kind: 'timeout' }
  return { kind: 'ok', value: outcome.value as T }
}

/** 新学生的第一轮：一行可执行的中文提示（**带标题**，否则下一轮清不掉、会一轮层叠一块）。 */
function coldStartBlock(): string {
  return (
    `${STUDENT_CONTEXT_HEADING}\n` +
    '- 该学生还没有学习记录：这是第一次对话，先用具体的小例子建立概念，别急着上难度，' +
    '也不要假装知道他的水平。'
  )
}

/** 降级留痕（**只记结论与计数口径，绝无正文与个人信息**，§12）。 */
function warnDegraded(studentId: string, reason: string): void {
  console.warn(
    `[profile] 本轮未注入学生情况（画像预取降级，不影响对话）：${reason}｜学生=${studentId}`
  )
}

/**
 * `get_student_profile` 的 Tool 工厂。
 *
 * 单独导出是为了让**测试**能直接构造一个假 `pi`（只实现 `on` / `registerTool`）来断言：
 *   - 未绑定学生时返回可读错误且**不抛**；
 *   - sidecar 不可用时返回可读错误、耗时可控；
 *   - 成功时把 `content[0].text` 交给模型、`details.ok === true`。
 */
export default function profileExtension(pi: AgentExtensionApi): void {
  pi.registerTool({
    name: 'get_student_profile',
    label: '学习画像',
    description:
      '读取当前学生的画像：各知识点掌握度、学习偏好、依赖图推荐的下一步（含推荐理由）。' +
      '在学生问「我接下来学什么」「我哪里没学好」，或需要判断该讲多深时调用。' +
      '学生身份由宿主应用注入，**无需也不要**传学生标识。',
    promptSnippet: 'get_student_profile：读取当前学生画像与推荐下一步',
    parameters: GetStudentProfileParams,
    execute: async (_toolCallId: string, params: GetStudentProfileParamsType) => {
      const session = currentAgentSession()
      if (!session) {
        return toolFailure(
          '还没有绑定当前学生，无法读取学习画像。请先直接回答学生的问题，不要假设任何学习记录。'
        )
      }
      try {
        // ⚠️ 调用点动态 import（与 `learning-log.ts` 同因）：`bridge/client.ts` 里有一处缺 `.ts`
        // 的导入，Node 直跑 TS 时会让**整个模块**导入失败；推迟到真正发请求的那一刻，
        // 提取/渲染这类纯逻辑就还能被 `node --test` 覆盖。生产产物照常静态分析内联。
        const { apiFetch } = await import('../../bridge/client.ts')
        // ★ 显式超时（F9）：没有它，sidecar 假死时这一轮 Tool 永久 pending
        const response = await apiFetch(profilePath(session.studentId), {
          method: 'GET',
          signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS)
        })
        if (!response.ok) {
          const snippet = await readSnippet(response)
          if (response.status === 404) {
            return toolFailure(
              // ★ 2026-09-21 改：原文写「先问清楚年级与想学什么」——
              //   两处都错：① 学段是**系统自动推断**的（学生会话里已经带着学段，
              //   不需要问）；② 问年级属于「索取个人信息」那一类（隐私段的明文禁止）。
              //   没有画像时的正确动作是「按第一次对话处理」，不是去问身份。
              `还没有这个学生的画像记录（${session.studentId}）。按「第一次对话」处理：`
                + '从他刚问的这个问题本身讲起，别去追问他的年级或身份。'
                + (snippet ? `（服务端：${snippet}）` : '')
            )
          }
          return toolFailure(
            `读取学习画像失败：本地数据服务返回 HTTP ${response.status}` +
              (snippet ? `（${snippet}）` : ''),
            SIDECAR_UNAVAILABLE_TEXT
          )
        }
        const profile = (await response.json()) as ProfileResponse

        // ★ 推荐详细版（票 20）：**同一轮里再发一次**，拿到「为什么推荐它」。
        //   取不到不影响画像本身（推荐只是增强），所以失败静默退回 kp_id 列表。
        //   ★ **不缓存**：缓存会让「上一轮的变化改变下一轮的输入」这条闭环失效。
        const recommendation = await fetchRecommendation(apiFetch, session.studentId)

        const maxMastery = typeof params?.max_mastery === 'number' ? params.max_mastery : 8
        const text = renderProfileText(profile, {
          maxMastery,
          fallbackStudentId: session.studentId,
          recommendation
        })
        // 详细推荐优先；它没有条目时退回 `/profile` 里的 kp_id 列表（两者同源）
        const recommendedFromDetail = (recommendation?.items ?? [])
          .map((item) => item.kpId)
          .filter((kpId): kpId is string => typeof kpId === 'string' && kpId.length > 0)
        return toolSuccess(text, {
          ok: true,
          studentId: session.studentId,
          sessionId: session.sessionId,
          masteryCount: (profile.mastery ?? []).length,
          recommendedKpIds:
            recommendedFromDetail.length > 0
              ? recommendedFromDetail
              : (profile.recommendedKpIds ?? []),
          recommendationSource: recommendation?.source ?? null
        })
      } catch (error) {
        // ★ 绝不抛出：Pi 与 UI 同进程，抛出去会同时带走两者（AGENTS §5.14）
        return toolFailure(SIDECAR_UNAVAILABLE_TEXT, error)
      }
    }
  })

  /**
   * ★★ `remember_preference`：个性化闭环的**写**这一端（与 `get_student_profile` 同属本扩展，
   * 所以扩展清单仍然只有六个 —— **不要为它新建扩展文件**）。
   *
   * 什么时候该记（`description` 里逐条写清，模型据此判断）：
   *   观察到**稳定的**学习偏好时（同一倾向出现多轮 / 学生明说「我喜欢…」），不要每轮都记。
   * 记什么：只记学习方式（兴趣方向 / 讲解方式 / 节奏 / 其它学习法）。
   * 绝不记：姓名、学校、联系方式等个人信息（K12 未成年人数据最小化，§12）；
   *   掌握度（那是判分与 `learning_history` 的事，模型记的不算数）；
   *   学段（学段只有一个写路径：`server/app/grade/rules.py`，模型不得改写）。
   *
   * ⚠️ **同一个键会覆盖旧值**（后端 `PUT .../preferences` 是 upsert 语义），
   *   所以「只在确实变化时调用」是这条 Tool 的核心纪律：每轮都写等于每轮都在洗同一行。
   *
   * 学生身份同样取 {@link currentAgentSession}（**不是 Tool 参数**）—— 与 `get_student_profile`
   * 同一纪律：模型连表达「写别人」的能力都不该有。
   */
  pi.registerTool({
    name: 'remember_preference',
    label: '记住学习偏好',
    description:
      '记下这个学生**稳定的学习偏好**，供后续每一轮参考。' +
      '什么时候调用：当你观察到反复出现的倾向时 —— 他多次要求举例子、总说「讲慢一点」、' +
      '明显偏爱先看结论、或主动说「我喜欢……」。**不要**每轮都调用，也不要为一次性的要求调用。' +
      '只记学习方式：兴趣方向（interest）、讲解方式（explain_style）、节奏（pace）、其它（note）。' +
      '**绝不记**：姓名、学校、住址、电话、账号等个人信息；也不要记掌握度或学段' +
      '（掌握度由判分与学习记录维护，学段由系统自动推断）。' +
      '同一个键会**覆盖**旧值，所以只在偏好确实变了（或第一次出现）时调用。',
    promptSnippet: 'remember_preference：记下学生稳定的学习偏好（只记学习方式）',
    parameters: RememberPreferenceParams,
    execute: async (_toolCallId: string, params: RememberPreferenceParamsType) => {
      const session = currentAgentSession()
      if (!session) {
        return toolFailure('还没有绑定当前学生，本次偏好没有记下。请先继续回答学生的问题。')
      }
      // 参数由 TypeBox 校验过（Key 四取一、值 1–40 字），但模型可能绕过校验层，
      // 所以再夹一次长度：这段文字会进**后续每一轮**的 Prompt，脏长文本是长期的预算与合规风险。
      const key = typeof params?.key === 'string' ? params.key : ''
      const value = typeof params?.value === 'string' ? params.value.trim().slice(0, 40) : ''
      if (!key || !value) {
        return toolFailure('偏好没有记下：类别或内容为空。请用一句话描述他的学习方式。')
      }
      try {
        // ★ 调用点动态 import（同 `get_student_profile`）：理由见那里
        const { apiFetch } = await import('../../bridge/client.ts')
        const response = await apiFetch(preferencesPath(session.studentId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
          // ★ 超时用 Tool 那条（8s）：本 Tool 在模型主动调用时跑，不在首字之前
          signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS)
        })
        if (!response.ok) {
          const snippet = await readSnippet(response)
          if (response.status === 422) {
            return toolFailure(
              `偏好没有记下：本地数据服务拒绝了这条内容（${key}）。` +
                '请只记学习方式（兴趣 / 讲解方式 / 节奏 / 一句话说明），不要记个人信息。' +
                (snippet ? `（服务端：${snippet}）` : '')
            )
          }
          return toolFailure(
            `偏好没有记下：本地数据服务返回 HTTP ${response.status}` +
              (snippet ? `（${snippet}）` : ''),
            SIDECAR_UNAVAILABLE_TEXT
          )
        }
        return toolSuccess(`已记下他的学习方式（${key}）：${value}。本轮照常回答，不要特意提起这件事。`, {
          ok: true,
          key,
          studentId: session.studentId
        })
      } catch (error) {
        // ★ 绝不抛出（与另外两个 Tool 同一条纪律）
        return toolFailure(SIDECAR_UNAVAILABLE_TEXT, error)
      }
    }
  })
}

/** 读推荐详情；**任何失败都返回 `null`**（推荐是增强，缺了不该让画像读不出来）。 */
async function fetchRecommendation(
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  studentId: string
): Promise<RecommendationResponse | null> {
  try {
    // ★ 同样带超时（F9）：推荐只是增强，但它卡住会拖住整个 Tool 的返回
    const response = await apiFetch(recommendationPath(studentId), {
      method: 'GET',
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const payload = (await response.json()) as unknown
    if (!payload || typeof payload !== 'object') return null
    return payload as RecommendationResponse
  } catch {
    return null
  }
}

/**
 * 读错题摘要（**失败一律 null**：它只是增强，绝不阻断对话）。
 *
 * ★ 三个请求是**并行**的（见 `fetchStudentContext`），所以这里多一次请求不会
 *   把首字的等待相加 —— 而错题摘要让 `senior.ts` 那条「错题要给变式题巩固」
 *   从「悬空要求」变成有数据支撑的行为。
 * ★ 404（学生还没建库 / 从没做过题）与其它失败在这里**同样返回 null**：
 *   对「要不要注入错题那一行」来说二者没有区别（都是「没有错题可注入」）。
 */
async function fetchMistakes(
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  studentId: string
): Promise<MistakesResponse | null> {
  try {
    const response = await apiFetch(mistakesPath(studentId), {
      method: 'GET',
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const payload = (await response.json()) as unknown
    if (!payload || typeof payload !== 'object') return null
    return payload as MistakesResponse
  } catch {
    return null
  }
}

/** 读一小段响应体用于报错（**截断**，避免把整页 HTML/堆栈塞进 Prompt）。 */
async function readSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return ''
  }
}
