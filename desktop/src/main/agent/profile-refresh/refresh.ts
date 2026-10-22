/**
 * 持续画像概括的**编排**（持续画像迭代二期）—— 「什么时候、把什么、发给谁、写到哪」。
 *
 * ── 它接的是哪条缝 ──────────────────────────────────────────────────────
 *
 * 一期已经把两件地基做好了：`turn-clock.ts`（什么时候该跑）与
 * `transcript-window.ts`（该看哪几轮）。二期在这个文件的 `runRefresh()` 里把
 * **载荷（`payload.ts`）→ 模型（`llmFetch`，主进程唯一的模型出口）→ 后端
 * （`/api/profile/{sid}/tags/refresh-apply`，分档写入）**串成一条链。
 *
 * ── 三条硬纪律（每一条都对应一处验收 / 一条红线）──────────────────────────
 *
 * 1. **fire-and-forget**：调用方（`runtime.ts` 的 agent_end）用 `void runRefresh(...)`，
 *    **绝不 await** —— 概括是尽力而为的增强，绝不能拖慢对话。
 *    （与 onboarding 的 `runSummary` 同一条纪律，见 `onboarding/service.ts` 的 G-J。）
 *
 * 2. **失败不重试到烦人**：概括最多尝试 {@link REFRESH_MAX_ATTEMPTS} 次（自动重试 1 次），
 *    仍失败就**放弃这一轮**，等下一个周期 —— 而不是立刻重试到成功。
 *    原因见 `turn-clock.ts` 的 `markRefreshed`：计数照常推进，避免失败风暴。
 *
 * 3. **两道闸照过**：`memory_switch=0` 时**一个标签都不写**（G-F）；`parent_consent=0`
 *    时学生面投影清空、但标签仍照常落库（G-G 的口径，由后端决定，本文件只是不额外拦截）。
 *    backend 在 `refresh-apply` 里复核这两道闸（纵深防御）—— 本文件**不替它判断**，
 *    只在日志里如实记下回执里的闸状态。
 *
 * ── ★★ 出网边界 ──────────────────────────────────────────────────────────
 *
 * 本文件**自己不发模型请求**：调 `onboarding/summarize-llm.ts` 导出的 `llmFetch` /
 * `chatCompletionsUrl`（主进程唯一允许打外部模型服务的出口，守卫 G5）。
 * sidecar 也只经 `bridge/client.ts` 的 `apiFetch`（本文件 import 的是
 * `onboarding/service.ts` 的 `defaultRequestJson`，那是同一件事的**唯一包装**）。
 * ⚠️ 本文件里**不许出现裸 `fetch(`** —— 那会新增一个出网口。
 *
 * ⚠️ `displayName` **既不进载荷、也不进本文件的入参**（见 `payload.ts` 的文件头）。
 *
 * ── 与 onboarding 的关系（别搞混）────────────────────────────────────────
 *
 * onboarding 的 `runSummary` 是**一次性**的（五问答完跑一次），写 `declared`。
 * 本文件的 `runRefresh` 是**周期性**的（每 N 轮跑一次），写 `observed`/`inferred`
 * 且**永不覆盖 declared**（分档在后端 `upsert_tag_from_summary`）。
 * 两条链共用的是「文本 → 白名单标签」这个动作，但输入、频次、来源与覆盖纪律全不同。
 *
 * ⚠️ 本文件**不 import `runtime.ts`**（避免循环导入边；`runtime.ts` 反过来 import 本文件）。
 *    需要的一切都经 {@link RefreshDeps} 注入。
 */

import { llmFetch, llmPostInit, type LlmChatFetch } from '../../bridge/llm-completions.ts'
import {
  chatCompletionsUrl,
  chatCompletionsVariantUrl,
  type LlmConfigProvider,
  type LlmSummarizerConfig
} from '../onboarding/summarize-llm.ts'
import { defaultRequestJson } from '../onboarding/service.ts'
import { isLlmVisibleTag } from '../../../shared/profile-tags.ts'
import { buildRefreshPayload, parseRefreshTags, type RefreshTagWrite } from './payload.ts'
// ★ 直接从两个源文件取（不经 `index.ts` barrel）：barrel 会反过来 export 本文件，
//   形成 `refresh ⇄ index` 的循环导入边 —— 与 `runtime.ts` 里 `flushLearningLog`
//   注释点名的那类 TDZ 崩溃同源。源文件之间没有这条边。
import { markRefreshed, shouldRefresh, PROFILE_REFRESH_EVERY_TURNS } from './turn-clock.ts'
import { recentTurns } from './transcript-window.ts'
// ★ 三期（2026-09-30）：AI 小结（学习档案五行结构的第五行）。
import { generateSummaryLine } from './summary-line.ts'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 单次概括调用的超时（与五问概括同一口径：8s）。 */
export const REFRESH_TIMEOUT_MS = 8_000

/** 概括最多尝试几次（= 自动重试 1 次；与 `ONBOARDING_SUMMARY_MAX_ATTEMPTS` 同口径）。 */
export const REFRESH_MAX_ATTEMPTS = 2

/** 概括的采样预算（够写 4 条 JSON；比五问版更小 —— 产出上限本来就更低）。 */
export const REFRESH_MAX_TOKENS = 300

/** sidecar 调用超时（落库那一步；与 `ONBOARDING_REQUEST_TIMEOUT_MS` 同一口径）。 */
export const REFRESH_APPLY_TIMEOUT_MS = 8_000

/** 端点：批量应用一次持续概括的产出（后端 `POST /api/profile/{sid}/tags/refresh-apply`）。 */
export const profileRefreshApplyPath = (studentId: string): string =>
  '/api/profile/' + encodeURIComponent(studentId) + '/tags/refresh-apply'

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 现有画像的一条（**只用来告诉模型「这些已经有了」**，键已过白名单）。 */
export interface RefreshKnownTag {
  key: string
  value: string
}

/** 回执解析结论（缺省值都在这里，调用方不必再判）。 */
export interface RefreshApplyOutcome {
  applied: string[]
  rejected: { key: string; reason: string }[]
  parentConsent: boolean
  memorySwitch: boolean
  /**
   * ★★ 后端在回执里回的**应用后的最新投影**（`RefreshApplyOut.tags`，与 GET /tags 同形）。
   *
   * ★ 为什么必须把它带出来（2026-10-22 修的一处缺陷）：
   *   落库之后紧接着要生成「画像小结」，而小结的全部输入就是画像标签。
   *   此前这里只保留了 `applied`（键名数组），于是调用方只能拿**落库之前**读到的
   *   `knownFiltered` 去写小结 —— 那一份**不含本轮刚写入的新标签**，
   *   小结永远滞后一个周期（注释还写着「此刻手里的已经是最新的一份」，与代码不符）。
   *   而后端**本来就回了正确的那一份**，只是被这个类型丢掉了。
   * ★ 空数组 = 后端没回（旧版后端 / 投影被 parent_consent 清空）→ 调用方自行回落。
   */
  tags: readonly RefreshKnownTag[]
}

/**
 * 编排的接线面（全部可注入；生产由 `runtime.ts` / `ipc/handlers.ts` 提供）。
 *
 * ★ 为什么 `getConfig` 与 `fetchResponse` 分开注入：前者取「生效中的配置」，
 *   后者是出网口（测试注入替身来断言**请求体里有什么**）。两者都是
 *   `onboarding/summarize-llm.ts` 已经在用的同一个形状 —— 一致才有复用价值。
 */
export interface RefreshDeps {
  /** 取「生效中的 LLM 配置」（生产 = `refreshRuntimeLlmConfig`；拿不到就降级）。 */
  getConfig: LlmConfigProvider
  /** 读现有画像（生产 = `GET /api/profile/{sid}/tags`；读不到就当作空画像）。 */
  readKnownTags: (studentId: string) => Promise<readonly RefreshKnownTag[]>
  /** 落库（生产 = `POST …/tags/refresh-apply`）。 */
  applyTags: (
    studentId: string,
    tags: readonly RefreshTagWrite[],
    reason: string
  ) => Promise<RefreshApplyOutcome>
  /** 模型出网口（测试注入替身；默认 `llmFetch`）。 */
  fetchResponse?: LlmChatFetch
  /**
   * 小结缓存目录（三期，2026-09-30）。生产 = `runtime` 的 `userDataDir`；
   * **不传 = 不生成小结**（测试与「只要标签不要小结」的调用方可省掉一段模型往返）。
   */
  userDataDir?: string
  log?: (line: string, level?: 'info' | 'warn' | 'error') => void
}

/** `runRefresh()` 的结论（诊断 / 测试用；**不进 UI**）。 */
export interface RefreshRunResult {
  /** 有没有真的跑（false = 没到触发条件 / 学生身份缺失）。 */
  ran: boolean
  /** 概括是否成功（模型回执解析出至少 0 条也算成功；网络失败才算 false）。 */
  ok: boolean
  /** 模型产出的条数（解析后）。 */
  proposed: number
  /** 后端实际写入的条数。 */
  applied: number
  /** 原因（degraded 时的可读中文；ok 时为空串）。 */
  reason: string
}

/* ------------------------------------------------------------------ *
 * 编排
 * ------------------------------------------------------------------ */

/**
 * 跑一次持续概括（**fire-and-forget**；调用方 `void runRefresh(...)`）。
 *
 * 流程：① 判触发 → ② 取窗口 → ③ 构载荷 → ④ 调模型（超时 + 重试 1 次）
 *      → ⑤ 解析 → ⑥ 落库 → ⑦ markRefreshed + 日志。
 *
 * ★ **触发判定放在这里**（而不是让调用方先判）：调用方（`runtime.ts`）只需要
 *   「每轮结束了，问一下要不要跑」这一件事，把三个条件（轮次够 / 有内容 / 有窗口）
 *   收在同一个函数里，调用点就只有一行 `void runRefresh(...)`。
 * ★ 即使**没触发**也会在窗口为空时如实返回 `ran:false` —— 调用方不需要区分，
 *   但诊断与测试需要知道「为什么没跑」。
 */
export async function runRefresh(studentId: string, deps: RefreshDeps): Promise<RefreshRunResult> {
  const log = deps.log ?? ((line: string, level?: string): void => {
    if (level === 'warn') console.warn(line)
    else if (level === 'error') console.error(line)
    else console.info(line)
  })
  const skip = (reason: string): RefreshRunResult => ({ ran: false, ok: false, proposed: 0, applied: 0, reason })

  if (!studentId) return skip('没有学生身份，跳过持续概括')

  // ① 触发判定（轮次够 + 这期间有实质内容）
  if (!shouldRefresh(studentId)) return skip('未到触发条件')

  // ② 取窗口（★ 最近 PROFILE_REFRESH_EVERY_TURNS 轮；不取满窗口 —— 只概括本周期）
  const turns = recentTurns(studentId).slice(-currentWindowLimit())
  if (turns.length === 0) return skip('对话窗口为空，跳过持续概括')
  // ★ 窗口里必须至少有一条学生说了话的轮次：全是空轮（系统触发）时概括没有输入。
  if (!turns.some((turn) => turn.user.trim() !== '')) return skip('窗口里没有学生的话，跳过持续概括')

  // ③ 取现有画像（读失败 → 当作空画像，仍然照常概括；「重复输出已有标签」由 prompt 规则 5 兜）
  let known: readonly RefreshKnownTag[] = []
  try {
    known = await deps.readKnownTags(studentId)
  } catch (error) {
    log('[profile-refresh] 读现有画像失败（按空画像继续）：' + describeError(error), 'warn')
  }
  const knownFiltered = known.filter((item) => isLlmVisibleTag(item.key) && item.key !== 'anon_student_id')

  // ④ 取模型配置（拿不到 → 降级；**不 markRefreshed** 之外的副作用一律不做）
  let config: LlmSummarizerConfig | null = null
  try {
    config = await deps.getConfig()
  } catch (error) {
    log('[profile-refresh] 读模型配置失败，本轮走降级：' + describeError(error), 'warn')
    return skip('读不到模型配置')
  }
  if (config === null || config.baseUrl.trim() === '' || config.modelId.trim() === '' || config.apiKey.trim() === '') {
    // ★ 没有可用配置：**推进计数**（markRefreshed）—— 否则每一轮都会重新判「该触发」，
    //   变成每轮读一次配置的浪费。等配置补上后，下一个周期自然跑。
    markRefreshed(studentId)
    log('[profile-refresh] 没有可用的模型配置（设置还没读到 / 没填 Key），本轮持续概括跳过', 'warn')
    return skip('没有可用的模型配置')
  }

  // ⑤ 构载荷 + 调模型（超时 + 重试 1 次）
  const payload = buildRefreshPayload({ turns, knownTags: knownFiltered })
  const fetchResponse = deps.fetchResponse ?? llmFetch
  let lastReason = ''
  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt += 1) {
    const outcome = await callModelOnce(config, payload, fetchResponse)
    if (!outcome.ok) {
      lastReason = outcome.reason
      if (attempt < REFRESH_MAX_ATTEMPTS) {
        log('[profile-refresh] 持续概括失败，自动重试 1 次：' + outcome.reason, 'warn')
      }
      continue
    }
    const tags = outcome.tags
    // ★★ 无论后端写了几条，**计数都推进**：概括是尽力而为的增强，
    //    失败/被拒就等下一个周期（见 turn-clock.ts 的 markRefreshed 注释）。
    markRefreshed(studentId)
    if (tags.length === 0) {
      log('[profile-refresh] 持续概括完成（第 ' + String(attempt) + ' 次尝试，没有值得更新的标签）')
      return { ran: true, ok: true, proposed: 0, applied: 0, reason: '' }
    }
    // ⑥ 落库（逐条分档写入由后端负责；这里一次批量提交）
    let applied: RefreshApplyOutcome
    try {
      applied = await deps.applyTags(studentId, tags, '持续画像迭代（每 ' + String(turns.length) + ' 轮）')
    } catch (error) {
      log('[profile-refresh] 持续概括的标签写入失败（等下一个周期）：' + describeError(error), 'warn')
      return { ran: true, ok: false, proposed: tags.length, applied: 0, reason: '写入失败：' + describeError(error) }
    }
    log(
      '[profile-refresh] 持续概括完成（第 ' + String(attempt) + ' 次尝试）：产出 ' +
        String(tags.length) + ' 条，写入 ' + String(applied.applied.length) + ' 条，' +
        '未写入 ' + String(applied.rejected.length) + ' 条' +
        (applied.rejected.length > 0
          ? '（' + applied.rejected.map((item) => item.key + ':' + item.reason).join('、') + '）'
          : '') +
        '｜两道闸 parentConsent=' + String(applied.parentConsent) + ' memorySwitch=' + String(applied.memorySwitch)
    )
    // ★★ 三期（2026-09-30）：画像刚落库 → **顺带**生成一段 AI 小结（fire-and-forget）。
    //   为什么挂在这个位置：这是「画像刚变过」的**唯一时刻**，而小结的全部输入就是画像标签。
    //
    //   ★★ 2026-10-22 修正（此前用的是**落库之前**的快照）：
    //     原先传的是 `knownFiltered` —— 那是本函数开头（步骤③）读到的**旧**画像，
    //     本轮刚写入的新标签**不在里面**，于是小结永远滞后一个周期。
    //     现在优先用后端回执里的 `applied.tags`（= 应用后的**最新投影**，后端本来就回了，
    //     只是此前被 `RefreshApplyOutcome` 丢掉）；回执没带（旧后端 / 被闸清空）时
    //     再回落到「旧画像 + 本轮实际写入的标签」的合并结果 —— 两条路都不会少这一轮。
    //   失败只是「小结还是旧的」，下一个周期画像再变时会重来（`summary-line.ts` 兜）。
    if (deps.userDataDir !== undefined && deps.userDataDir.trim() !== '') {
      const summaryTags =
        applied.tags.length > 0 ? applied.tags : mergeAppliedTags(knownFiltered, tags, applied.applied)
      void generateSummaryLine(studentId, summaryTags, {
        getConfig: deps.getConfig,
        userDataDir: deps.userDataDir,
        ...(deps.fetchResponse ? { fetchResponse: deps.fetchResponse } : {}),
        log: (line, level) => log(line, level)
      })
    }
    return {
      ran: true,
      ok: true,
      proposed: tags.length,
      applied: applied.applied.length,
      reason: ''
    }
  }

  // 两次都失败：推进计数，等下一个周期（**不**立刻重试到成功）
  markRefreshed(studentId)
  log('[profile-refresh] 持续概括走降级（两次尝试都失败）：' + lastReason, 'warn')
  return { ran: true, ok: false, proposed: 0, applied: 0, reason: lastReason }
}

/**
 * 回执没带投影时的**回落合并**：旧画像 + 本轮实际写入的那几条。
 *
 * ★ 为什么需要它：`RefreshApplyOut.tags` 是「应用后的最新投影」，正常情况下一定有；
 *   但旧版后端不回这个字段，而 `parent_consent=0` 时它会被**清空**（G-G：落库照常、
 *   外发投影为空）。后者不能拿来当小结输入（那是空的），前者则压根没有。
 * ★ 口径与「写库只写真的写进去的那几条」一致：`applied.applied` 是后端确认写入的键，
 *   不在其中的（被分档拒 / 被闸挡）**不能**混进小结 —— 否则小结会说出画像里没有的东西。
 * ★ 纯函数、按 key 覆盖（后写的赢，与 upsert 语义一致）。
 */
function mergeAppliedTags(
  known: readonly RefreshKnownTag[],
  proposed: readonly RefreshTagWrite[],
  appliedKeys: readonly string[]
): RefreshKnownTag[] {
  const merged = new Map<string, string>()
  for (const item of known) merged.set(item.key, item.value)
  for (const item of proposed) {
    if (!appliedKeys.includes(item.key)) continue
    merged.set(item.key, item.value)
  }
  return [...merged.entries()].map(([key, value]) => ({ key, value }))
}

/** 本周期回看几轮（= 触发周期；`transcript-window` 的窗口可能更大，这里只取本周期）。 */
function currentWindowLimit(): number {
  // 直接读 `PROFILE_REFRESH_EVERY_TURNS`，但经函数包一层，便于将来「回看 2× 周期」的调优。
  return PROFILE_REFRESH_EVERY_TURNS
}

/* ------------------------------------------------------------------ *
 * 一次模型调用（超时包装：拿不到响应就返回 ok:false）
 * ------------------------------------------------------------------ */

type ModelOutcome =
  | { ok: true; tags: RefreshTagWrite[] }
  | { ok: false; reason: string }

/**
 * 调一次模型并把回执解析成标签。
 *
 * ★ 超时用 `AbortSignal`（`llmPostInit` 已经带 timeout），不再额外套 `Promise.race` ——
 *   与五问版同一条实现（那边也是靠 `llmPostInit(headers, body, TIMEOUT_MS)` 收敛）。
 *   多套一层 race 会让「请求还在飞但被放弃」有两个来源，反而难排查。
 */
async function callModelOnce(
  config: LlmSummarizerConfig,
  payload: { system: string; user: string },
  fetchResponse: LlmChatFetch
): Promise<ModelOutcome> {
  const body = JSON.stringify({
    model: config.modelId,
    messages: [
      { role: 'system', content: payload.system },
      { role: 'user', content: payload.user }
    ],
    temperature: 0.2,
    max_tokens: REFRESH_MAX_TOKENS,
    stream: false
  })
  // ⚠️ Key 只在这一个 header 里出现；错误信息里**绝不回显**它（下面只带状态码）。
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + config.apiKey
  }
  // ★ 每次请求新造 signal（重试时第一次的请求可能还在飞，复用会被一起取消）。
  const initFor = (): RequestInit => llmPostInit(headers, body, REFRESH_TIMEOUT_MS)

  let response: Response
  // ★ 出网 span（V1 运行透视）：分类与上屏文案由调用点给，出网口只负责记事实与体量。
  const span = { purpose: '画像刷新', label: '把最近的问答整理成画像变化', model: config.modelId }
  try {
    response = await fetchResponse(chatCompletionsUrl(config.baseUrl), initFor(), span)
    // 404/405 = 地址写法不对（不是鉴权问题）：试一次 /v1 变体，仍不行才算失败
    if (response.status === 404 || response.status === 405) {
      const variant = chatCompletionsVariantUrl(config.baseUrl)
      if (variant !== null) response = await fetchResponse(variant, initFor(), span)
    }
  } catch (error) {
    return { ok: false, reason: '概括请求没发出去（' + describeError(error) + '）' }
  }
  if (!response.ok) {
    // ★ 只带状态码：回执正文里可能回显了提交的内容，而那里面有学生的对话
    return { ok: false, reason: '概括请求失败（HTTP ' + String(response.status) + '）' }
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return { ok: false, reason: '概括回执不是合法 JSON' }
  }
  const tags = parseRefreshTags(readContent(parsed))
  return { ok: true, tags }
}

/** 从 chat/completions 回执里取正文（宽松读；取不到就是空串）。与五问版同一手法。 */
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

/* ------------------------------------------------------------------ *
 * 生产用的 deps（把两个 HTTP 出口包成 `RefreshDeps`）
 * ------------------------------------------------------------------ */

/**
 * 读现有画像（`GET /api/profile/{sid}/tags` → 白名单键的 `key=value` 列表）。
 *
 * ★ 复用 `defaultRequestJson`（= `bridge/client.ts` 的 `apiFetch` 的唯一包装），
 *   **不新开一个 sidecar 出口**。失败由调用方兜（当空画像继续）。
 */
export async function readKnownTagsFromSidecar(studentId: string): Promise<readonly RefreshKnownTag[]> {
  const body = (await defaultRequestJson(
    '/api/profile/' + encodeURIComponent(studentId) + '/tags',
    { method: 'GET' }
  )) as { tags?: unknown }
  const list = Array.isArray(body?.tags) ? body.tags : []
  const out: RefreshKnownTag[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as { key?: unknown; value?: unknown }
    const key = typeof record.key === 'string' ? record.key : ''
    if (!isLlmVisibleTag(key) || key === 'anon_student_id') continue
    out.push({ key, value: typeof record.value === 'string' ? record.value : String(record.value ?? '') })
  }
  return out
}

/**
 * 落库（`POST /api/profile/{sid}/tags/refresh-apply`）。
 *
 * ★ 回执读法（与后端 `RefreshApplyOut` 逐字段对应）：
 *   `applied` / `rejected[{key,reason}]` / `parentConsent` / `memorySwitch`。
 *   认不出的字段一律给安全默认（`applied=[]`、`parentConsent=false`），**不抛**。
 */
export async function applyRefreshTagsFromSidecar(
  studentId: string,
  tags: readonly RefreshTagWrite[],
  reason: string
): Promise<RefreshApplyOutcome> {
  const body = (await defaultRequestJson(profileRefreshApplyPath(studentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tags: tags.map((item) => ({
        key: item.key,
        value: item.value,
        confidence: item.confidence,
        source: item.source
      })),
      reason
    })
  })) as Record<string, unknown>

  const appliedRaw = Array.isArray(body?.applied) ? body.applied : []
  const applied = appliedRaw.filter((item): item is string => typeof item === 'string')
  const rejectedRaw = Array.isArray(body?.rejected) ? body.rejected : []
  const rejected: { key: string; reason: string }[] = []
  for (const item of rejectedRaw) {
    if (!item || typeof item !== 'object') continue
    const record = item as { key?: unknown; reason?: unknown }
    rejected.push({
      key: typeof record.key === 'string' ? record.key : '',
      reason: typeof record.reason === 'string' ? record.reason : 'rejected'
    })
  }
  // ★★ 应用后的最新投影（`RefreshApplyOut.tags`）：落库之后画像的**真实样子**。
  //   认不出的条目一律跳过（宽松读、严格校验，与其它回执解析同一纪律）——
  //   小结拿到的宁可少一条，也不能拿到一条脏值。
  const projectedRaw = Array.isArray(body?.tags) ? body.tags : []
  const projected: RefreshKnownTag[] = []
  for (const item of projectedRaw) {
    if (!item || typeof item !== 'object') continue
    const record = item as { key?: unknown; value?: unknown }
    const key = typeof record.key === 'string' ? record.key : ''
    if (!isLlmVisibleTag(key) || key === 'anon_student_id') continue
    if (projected.some((own) => own.key === key)) continue
    projected.push({
      key,
      value: typeof record.value === 'string' ? record.value : String(record.value ?? '')
    })
  }

  return {
    applied,
    rejected,
    parentConsent: body?.parentConsent === true,
    memorySwitch: body?.memorySwitch !== false,
    tags: projected
  }
}
