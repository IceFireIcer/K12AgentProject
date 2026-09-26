/**
 * RAG 检索 Tool（票 13，执行文档 §9.1 的 `rag_search` → HTTP → Python 那条线）。
 *
 * 主 Agent 由 LLM 自主决定「这一问要不要查教材」；本扩展把这次检索变成一次
 * `POST /api/rag/search`，把命中的**父块正文**交给模型，并把 5 字段投影交给事件层发 `citation`。
 *
 * ★ 四条不许走样的约束：
 *
 * 1. **四级降级链一步都不在 TS 侧**：`vector -> cloud -> fts -> outline` 全部在 Python 的
 *    `RagService.search()` 里一次调用内完成（§8.5 / §0.2 混合后端边界规则）。
 *    本文件**只读**结果里的 `degraded` 并原样透传 —— 不判断、不排序、不重试降级，
 *    连向量表名、关键词检索实现这类词都不会出现在编排层（验收：那条 grep 在 `src/main` 下零命中）。
 * 2. **学段由主进程注入，不是模型填的**：Tool 参数里那个 `gradeLevel` 只是"转述"，
 *    真正发出去的学段取自 {@link currentAgentSession}（**学段来自服务端推断
 *    （`server/app/grade/rules.py`）的当前生效值，前端不推断学段（手动指定走独立通道、由服务端写库）**，§10）。
 *    模型就算填了 `senior`，也不会让它替初中生取高中内容 —— 这与「WHERE 由 Python 强制」
 *    是同一件事的两道门。
 * 3. **不登记进 §9.3 的「Tool 名 → kind」映射表**：检索结果走 `citation` 事件而不是 `payload`
 *    （那张表全仓只有一份：`ipc/tool-kinds.ts`，本文件连它的名字都不提，守卫据此断言本文件未自建表；
 *    事件侧按 Tool 名分流见 `agent/events.ts`）。
 * 4. **`execute()` 自兜异常**：sidecar 未启动 / 500 / 超时 → 返回可读中文 + `details.ok=false`
 *    （**绝不抛出**：Pi 与 UI 同在主进程，抛出去同时带走两者）。
 */

import { Type, type Static } from '@sinclair/typebox'
import { apiFetch } from '../../bridge/client.ts'
import {
  currentAgentSession,
  SIDECAR_UNAVAILABLE_TEXT,
  toolFailure,
  type AgentExtensionApi
} from './index.ts'

/** Tool 名（冻结；事件层用它分流到 `citation`，见 `agent/events.ts` 的 `RAG_SEARCH_TOOL`）。 */
export const RAG_SEARCH_TOOL_NAME = 'rag_search'

/** 四学段（与 `contracts.py` 的 `GradeLevel` / `shared/ipc-events.ts` 逐字一致）。 */
export const GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior'] as const

/** 检索降级链的四档（§8.5）。**只读**：由 Python 决定，TS 不推理。 */
export const DEGRADED_LEVELS = ['vector', 'cloud', 'fts', 'outline'] as const
export type Degraded = (typeof DEGRADED_LEVELS)[number]

/** 单次检索的超时（sidecar 在本机，超过这个数说明进程已经不正常了）。 */
export const RAG_SEARCH_TIMEOUT_MS = 8000

/** 默认取几条（与 `RagSearchRequest.top_k` 的默认值一致）。 */
export const DEFAULT_TOP_K = 5

/**
 * 参数 schema（TypeBox `TSchema`）。
 *
 * 与 `RagSearchRequest`（pydantic，唯一契约来源）的一致性由
 * `desktop/scripts/check-tool-schema.mjs` 断言 —— 本常量因此**必须**导出成可读的对象字面量。
 * `gradeLevel` 在这里是可选的：模型**不必**也不该负责判学段（真值来自会话，见文件头第 2 条），
 * 给它一个可填的字段是为了让它能"复述"当前学段，而不是让它决定学段。
 */
export const RagSearchParams = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 200,
    description: '检索用的关键词或一句话（用学生问题里的核心概念，不要整句照抄）'
  }),
  gradeLevel: Type.Optional(
    Type.Union(
      GRADE_LEVELS.map((level) => Type.Literal(level)),
      { description: '当前学段（会与主进程注入的学段核对，以主进程为准）' }
    )
  ),
  kpId: Type.Optional(
    Type.String({
      maxLength: 64,
      description: '仅用于你自己定位知识点，不会发送给后端（后端按 query + 学段检索）；不确定就不要填'
    })
  ),
  topK: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      default: DEFAULT_TOP_K,
      description: '最多返回几条（默认 5）'
    })
  )
})

export type RagSearchParamsType = Static<typeof RagSearchParams>

/** `citation` 事件的 5 个冻结字段（§6.4，一个字都不能多）。 */
export interface RagCitation {
  chunkId: string
  chapterTitle: string
  sectionTitle: string
  gradeLevel: (typeof GRADE_LEVELS)[number]
  compat: boolean
}

/** `POST /api/rag/search` 的响应（`RagSearchResult`，camelCase 由 pydantic alias 转）。 */
export interface RagSearchResponse {
  hits?: Array<{
    chunkId?: string
    chapterTitle?: string
    sectionTitle?: string
    gradeLevel?: string
    compat?: boolean
    parentChunkId?: string | null
    text?: string
    knowledgePoint?: string
    kpId?: string
    score?: number
    degraded?: string
    expanded?: boolean
  }>
  context?: string
  degraded?: string
  /**
   * ★ 降级链的**逐级记录**（`RagSearchResult.attempts`，本轮新增的可选字段）。
   *
   * Python 从票 11 起就一直在记 `LevelAttempt(level, ok, detail, hits)`，只是**没有对外暴露**
   * （那边的注释写着「只进日志/轨迹，不进 HTTP 契约」）。演示模式要展示「试了哪几级、哪级命中、
   * 为什么落到下一级」，所以它现在**原样透传**。老 sidecar 不带这个字段 → 退化成
   * 「只有最终档位可观测」，消费方**不许**编造中间档位（见 `readRetrievalFromDetails`）。
   */
  attempts?: Array<{ level?: string; ok?: boolean; detail?: string; hits?: number }>
  /**
   * 学段过滤条件**原文**（`RagSearchResult.gradeFilter`）：由 Python 按它真正下发的
   * 白名单生成（`c.grade_level IN ('primary_high','junior')`），演示时用来证明
   * 「隔离在 SQL 层强制」不是一句口号。
   */
  gradeFilter?: string
}

/**
 * Tool 的结构化产出（`details`）。
 *
 * 事件层只认两样：`details.citations`（→ `citation` 事件）与 `details.ok`（→ 轨迹图成败）。
 * 这里多带的 `degraded` / `latencyMs` 进轨迹记录（票 13 的 `{turn, toolName, args摘要, ok, latencyMs, degraded}`）。
 */
export interface RagSearchDetails {
  ok: boolean
  /** 这一轮真实上送的检索词（模型自己拟的，**不是学生原话**）——诊断信封展示用。 */
  query: string
  citations: RagCitation[]
  /** ★ 原样透传 Python 的判定；TS 不重新算一遍。 */
  degraded: Degraded
  hitCount: number
  contextChars: number
  latencyMs: number
  /** 命中的知识点 id（轨迹与调试用）。 */
  kpIds: string[]
  /** 向上兼容命中的条数（前端要标「延伸阅读」，这里给轨迹留档）。 */
  compatCount: number
  /** 降级链的逐级记录（原样透传 Python；认不出就是空数组）。 */
  attempts: Array<{ level: string; ok: boolean; detail: string; hits: number }>
  /** 学段过滤条件原文（空串 = 后端没给）。 */
  gradeFilter: string
  /**
   * 检索命中的**完整条目**（比 `citations` 多带 `text` / `score` / `parentChunkId` /
   * `expanded`），供界面的「查看教材原文」抽屉使用。
   *
   * ★ 它**不进 Prompt**：`renderSearchText` 用的是 `RagSearchResult.context`（父块正文拼接）。
   *   这里留着是为了让引用行可点开 —— 此前这些字段在投影成 5 字段时被丢掉了，
   *   学生看到「教材依据：一、从原始数据到特征」却看不到那句话到底出自哪里。
   * ★ 体积考虑：一条命中的 `text` 是节级正文（数百到上千字），
   *   它是**本轮的**载荷（随事件发一次、随即被折叠进轮次状态），不留档、不累积。
   */
  hits: RagHitDetail[]
}

/** 命中详情（界面「教材原文」抽屉的最小面）。 */
export interface RagHitDetail {
  chunkId: string
  text: string
  score: number | null
  parentChunkId: string | null
  degraded: string | null
  kpId: string | null
  expanded: boolean
}

/** 降级级别 → 给模型的一句中文说明（让它在回答里如实交代能力受限）。 */
export const DEGRADED_HINTS: Record<Degraded, string> = {
  vector: '向量检索（正常）',
  cloud: '云端嵌入检索（本地模型不可用，已改用云端嵌入）',
  fts: '关键词兜底检索（向量不可用，召回可能不完整）',
  outline: '只有章节大纲（没检索到具体段落，请如实告诉学生「教材里没找到这一段」）'
}

/** 读一个学段字面量；不是四个之一就返回 `null`（**不猜、不兜底**）。 */
export function readGradeLevel(value: unknown): (typeof GRADE_LEVELS)[number] | null {
  return typeof value === 'string' && (GRADE_LEVELS as readonly string[]).includes(value)
    ? (value as (typeof GRADE_LEVELS)[number])
    : null
}

/** 读一个降级级别；认不出**按每一级都不命中**处理成 `outline`（最弱的一档，宁可说得保守）。 */
export function readDegraded(value: unknown): Degraded {
  return typeof value === 'string' && (DEGRADED_LEVELS as readonly string[]).includes(value)
    ? (value as Degraded)
    : 'outline'
}

/**
 * 学段解析：**会话学段为权威**（会话里那个值是服务端推断出来的当前生效值，前端不推断学段（手动指定走独立通道、由服务端写库））。
 *
 * 模型填的 `gradeLevel` 只可能被用来「确认」，永远不会覆盖会话值 ——
 * 这是「学段隔离不交给模型」这条约束在编排层的落点（Python 侧还有一道 SQL 过滤）。
 */
export function resolveGradeLevel(
  requested: unknown,
  sessionGrade: unknown
): (typeof GRADE_LEVELS)[number] {
  return readGradeLevel(sessionGrade) ?? readGradeLevel(requested) ?? 'primary_high'
}

/**
 * 把 `RagSearchResult.hits` 投影成 `citation` 事件的 5 个字段（§6.4）。
 *
 * ★ **只准投影这 5 个**：父块正文（`text`）是给模型看的上下文，不进事件载荷；
 * 认不准的条目**丢掉**，绝不给前端一个猜出来的学段标签。
 */
export function toCitations(response: RagSearchResponse): RagCitation[] {
  const hits = Array.isArray(response.hits) ? response.hits : []
  const citations: RagCitation[] = []
  for (const hit of hits) {
    const chunkId = typeof hit?.chunkId === 'string' && hit.chunkId.trim() ? hit.chunkId : null
    const gradeLevel = readGradeLevel(hit?.gradeLevel)
    if (chunkId === null || gradeLevel === null) continue
    citations.push({
      chunkId,
      chapterTitle: typeof hit?.chapterTitle === 'string' && hit.chapterTitle ? hit.chapterTitle : '未命名章节',
      sectionTitle: typeof hit?.sectionTitle === 'string' && hit.sectionTitle ? hit.sectionTitle : '未命名章节',
      gradeLevel,
      compat: hit?.compat === true
    })
  }
  return citations
}

/** 拼给模型看的检索结果文本（**父块正文**在这里进入上下文，不是子块碎片）。 */
export function renderSearchText(
  response: RagSearchResponse,
  citations: RagCitation[],
  degraded: Degraded
): string {
  const header =
    `【教材检索结果】级别：${DEGRADED_HINTS[degraded]}；命中 ${citations.length} 条。` +
    '（面向学生的回答里请用「教材里讲到…」这样的说法引用来源，不要出现知识点 id、chunk id 这类内部字段。）'
  if (citations.length === 0) {
    return (
      '【教材检索结果】没有命中的教材段落。请凭常识作答，并如实说明「教材里暂时没有找到这一段」，' +
      '不要编造出处。'
    )
  }
  const sources = citations
    .map((citation, index) => {
      const grade = citation.gradeLevel === 'senior' ? '高中' : citation.gradeLevel === 'junior' ? '初中' : '小学'
      return `${index + 1}. ${citation.chapterTitle} · ${citation.sectionTitle}（${grade}${
        citation.compat ? '，延伸阅读' : ''
      }）`
    })
    .join('\n')
  const body = typeof response.context === 'string' ? response.context.trim() : ''
  // 知识点 id 是**给出题/依赖图用的机器标识**（generate_quiz 需要它），不是给学生看的
  const kpIds = [
    ...new Set(
      (Array.isArray(response.hits) ? response.hits : [])
        .map((hit) => (typeof hit?.kpId === 'string' && hit.kpId ? hit.kpId : ''))
        .filter((id) => id.length > 0)
    )
  ]
  const kpLine =
    kpIds.length > 0
      ? `\n知识点 id（出题 generate_quiz / 查依赖图时用，**不要念给学生听**）：${kpIds.join('、')}`
      : ''
  return `${header}\n来源：\n${sources}${kpLine}\n正文（节级完整内容）：\n${body}`
}

/**
 * 读降级链的逐级记录（`RagSearchResult.attempts`）。
 *
 * ★ 逐字段读 + 兜底：认不出的条目**跳过**（宁可少一行，也不要一行猜出来的状态）；
 *   老后端没有这个字段 → 空数组（消费方据此如实显示「逐级不可观测」，不编造）。
 */
export function toAttempts(
  response: RagSearchResponse
): Array<{ level: string; ok: boolean; detail: string; hits: number }> {
  const raw = Array.isArray(response.attempts) ? response.attempts : []
  const out: Array<{ level: string; ok: boolean; detail: string; hits: number }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const level = typeof item.level === 'string' ? item.level : ''
    if (level === '') continue
    out.push({
      level,
      ok: item.ok === true,
      detail: typeof item.detail === 'string' ? item.detail : '',
      hits: typeof item.hits === 'number' && Number.isFinite(item.hits) ? item.hits : 0
    })
  }
  return out
}

/**
 * 把命中的**完整条目**投影成界面「教材原文」抽屉要的形状。
 *
 * ★ 只保留 `citations` 里认得的 `chunkId`：学段认不准的命中连引用行都没有
 *   （见 {@link toCitations} 的注释），带上它们的原文会让界面上出现
 *   「有原文可看、却没有对应引用行」的孤儿。
 * ★ 逐字段读 + 兜底（响应是 sidecar 来的 JSON，字段可能缺席或类型不对）：
 *   一个字段读不出来只影响那一项，**不影响整条引用**。
 */
export function toHitDetails(
  response: RagSearchResponse,
  citations: readonly RagCitation[]
): RagHitDetail[] {
  const hits = Array.isArray(response.hits) ? response.hits : []
  const wanted = new Set(citations.map((citation) => citation.chunkId))
  const out: RagHitDetail[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const chunkId = typeof hit?.chunkId === 'string' && hit.chunkId.trim() ? hit.chunkId : null
    if (chunkId === null || !wanted.has(chunkId) || seen.has(chunkId)) continue
    seen.add(chunkId)
    out.push({
      chunkId,
      text: typeof hit?.text === 'string' ? hit.text : '',
      score: typeof hit?.score === 'number' && Number.isFinite(hit.score) ? hit.score : null,
      parentChunkId:
        typeof hit?.parentChunkId === 'string' && hit.parentChunkId ? hit.parentChunkId : null,
      degraded: typeof hit?.degraded === 'string' && hit.degraded ? hit.degraded : null,
      kpId: typeof hit?.kpId === 'string' && hit.kpId ? hit.kpId : null,
      expanded: hit?.expanded === true
    })
  }
  return out
}

/** 读一小段响应体用于报错（**截断**，别把整页 HTML 塞进 Prompt）。 */
async function readSnippet(response: Response): Promise<string> {  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return ''
  }
}

/**
 * 失败结果的形状：**统一用 `extensions/index.ts` 的 {@link toolFailure}**（F11）。
 *
 * ⚠️ 这里不再各写一份：四份逐字同构的私有 `failed()` 一旦漂移，
 * 事件层（`agent/events.ts` 的 `readToolFailure`）与轨迹（`agent/trace.ts` 的 `toolResultOk`）
 * 会分别认不出失败，表现为**静默成功**。别名只是为了少改调用点，语义一字不变。
 */
const failed = toolFailure

/** 组装成功结果（与 `extensions/index.ts` 的 `toolSuccess` 同形状，只是 details 有具体类型）。 */
function succeeded(
  text: string,
  details: RagSearchDetails
): { content: Array<{ type: 'text'; text: string }>; details: RagSearchDetails } {
  return { content: [{ type: 'text', text }], details }
}

/** sidecar 请求出口（默认 {@link apiFetch}；测试/验证可注入假实现以覆盖断网、500、超时分支）。 */
export type RagRequester = (path: string, init?: RequestInit) => Promise<Response>

export interface RagSearchExtensionOptions {
  /** 请求出口（默认 `apiFetch` —— 生产路径永远走 `bridge/client.ts` 的统一 token 注入）。 */
  request?: RagRequester
  /** 单次检索超时（默认 {@link RAG_SEARCH_TIMEOUT_MS}）。 */
  timeoutMs?: number
}

/**
 * 建一个 `rag_search` 扩展工厂。
 *
 * 生产用默认导出；测试用 `createRagSearchExtension({ request })` 注入假请求，
 * 这样「sidecar 未启动 / 500 / 超时」三条失败分支都能被断言到。
 */
export function createRagSearchExtension(
  options: RagSearchExtensionOptions = {}
): (pi: AgentExtensionApi) => void {
  const request: RagRequester = options.request ?? apiFetch
  const timeoutMs = options.timeoutMs ?? RAG_SEARCH_TIMEOUT_MS

  return function ragSearchExtension(pi: AgentExtensionApi): void {
    pi.registerTool({
      name: RAG_SEARCH_TOOL_NAME,
      label: '教材检索',
      description:
        '在本地教材库里检索与问题相关的内容（按学段隔离，必要时给出更低学段的延伸阅读）。' +
        '当学生问具体知识点、需要教材原话或出处时调用；纯粹的寒暄、追问上文的指代词不需要检索。',
      promptSnippet: 'rag_search：查本地教材（按学段隔离），结果会作为引用来源展示给学生',
      promptGuidelines: [
        // ★ 2026-09-21 软化：原文是「需要教材依据时**先调用** rag_search」——
        //   「先调用」把它写成了前置条件（于是闲聊与概念解释也去查一遍）。
        //   现在的口径：教材是**参考**，只在需要原话/出处时才查。
        //   ⚠️ 后半句（不要假装查了）**必须保留** —— 它防的是另一种走样。
        '需要教材原话或出处时调用 rag_search，再基于检索到的正文作答；不要说「我查一下」却不去查。',
        '检索结果里的正文是节级完整内容，可以直接引用；引用时说「教材里讲到」，不要念出内部 id。',
        '没命中时不必反复检索：用你自己会的知识把问题讲清楚，如实说一句「教材里没找到这一条」就好。'
      ],
      parameters: RagSearchParams,
      execute: async (_toolCallId: string, params: RagSearchParamsType, signal?: AbortSignal) => {
        const started = Date.now()
        const session = currentAgentSession()
        // ★ 学段以会话为准（模型填的那个只是转述）；没有会话时退到模型给的值，最后兜冷启动默认值。
        const gradeLevel = resolveGradeLevel(params?.gradeLevel, session?.gradeLevel)

        const query = typeof params?.query === 'string' ? params.query.trim() : ''
        if (query.length === 0) {
          return failed('检索需要关键词。请先用一句话概括学生想问的知识点，再调用本工具。')
        }
        const topK =
          typeof params?.topK === 'number' && Number.isFinite(params.topK)
            ? Math.max(1, Math.min(20, Math.trunc(params.topK)))
            : DEFAULT_TOP_K

        // ★ **请求体只放契约里有的四个字段**（query / gradeLevel / topK + 契约默认的兼容开关）。
        //   `kpId` 是模型给自己用的定位线索（进轨迹/调试），**绝不上送** ——
        //   `RagSearchRequest` 是 `extra="forbid"` 的 CamelModel（`contracts.py:541`），
        //   多一个 `kpId` 键就是 422：模型只要顺手填了它，RAG 主路径整条挂掉（F1）。
        const body: Record<string, unknown> = { query, gradeLevel, topK }

        try {
          const timeout = AbortSignal.timeout(timeoutMs)
          const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
          const response = await request('/api/rag/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: composed
          })

          if (!response.ok) {
            const snippet = await readSnippet(response)
            const detail =
              response.status === 404
                ? '检索接口不存在（sidecar 版本过旧？）'
                : `本地检索服务返回 HTTP ${response.status}`
            return failed(
              `${detail}${snippet ? `（${snippet}）` : ''}。本次没有教材依据，请如实作答并说明来源暂时不可用。`,
              SIDECAR_UNAVAILABLE_TEXT
            )
          }

          const payload = (await response.json()) as RagSearchResponse
          const citations = toCitations(payload)
          // ★ 只读 Python 给的级别，不重新判断（四级降级链全在 Python，§0.2）
          const degraded = readDegraded(payload.degraded)
          const latencyMs = Date.now() - started

          const details: RagSearchDetails = {
            ok: true,
            query,
            citations,
            degraded,
            hitCount: citations.length,
            contextChars: typeof payload.context === 'string' ? payload.context.length : 0,
            latencyMs,
            kpIds: [
              ...new Set(
                (Array.isArray(payload.hits) ? payload.hits : [])
                  .map((hit) => (typeof hit?.kpId === 'string' && hit.kpId ? hit.kpId : ''))
                  .filter((id) => id.length > 0)
              )
            ],
            compatCount: citations.filter((citation) => citation.compat).length,
            // ★ 逐级记录与学段过滤条件**原样透传**（判定在 Python，TS 不重算、不补全）
            attempts: toAttempts(payload),
            gradeFilter: typeof payload.gradeFilter === 'string' ? payload.gradeFilter : '',
            // ★ 只带**引用行认得出来**的那些命中（学段认不准的连引用行都没有，
            //   带上它们的原文会让界面上出现「有原文、没有引用行」的孤儿）
            hits: toHitDetails(payload, citations)
          }
          return succeeded(renderSearchText(payload, citations, degraded), details)
        } catch (error) {
          // ★ 绝不抛出：sidecar 未启动（apiFetch 直接抛）/ 超时 / 网络异常都收敛到这里。
          const aborted = signal?.aborted === true
          return failed(
            aborted
              ? '本次检索已取消（你换了问题或按了停止），请按当前问题直接作答。'
              : '检索失败，本次没有教材依据，请如实说明来源暂时不可用，不要编造出处。',
            error
          )
        }
      }
    })
  }
}

/** 默认工厂（生产路径：`apiFetch` + 默认超时）。 */
export default createRagSearchExtension()
