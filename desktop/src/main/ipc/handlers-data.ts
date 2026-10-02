/**
 * 新增读/写通道的 **IPC 处理器**（画像 / 闯关 / 编程 / 动画 / 知识库 / 学生身份 / 轨迹）。
 *
 * ★ 为什么单独一个文件：`ipc/handlers.ts` 已经承担了会话生命周期、轮次、设置域、
 *   代码桥四件事，再塞十几条纯转发会让它继续膨胀。
 *   形态与 `registerStudyHandlers()` 完全一致 —— **从这里出去的东西不做聚合**。
 *
 * ★★ 两条贯穿全文件的纪律：
 *   ① **学生身份由主进程决定**：所有需要 `studentId` 的通道都调 `resolveActiveStudentId()`，
 *      **绝不读渲染进程递进来的 id** —— 那等于允许读别人的画像与学习记录。
 *      ⚠️ 有两条通道的 id 不是拼进 URL 而是**塞进 POST body**（`quiz:grade` / `code:run-hint`）：
 *      服务端那两处的 `student_id` 是必填，所以必须**显式注入**，否则整条链路 422 全哑。
 *      它们的 id 是 `wire/data.ts` 包装函数的**内部参数**（`req.quizGrade(request, studentId)`），
 *      刻意不进 `channels.ts` 的请求类型 —— 那类型渲染进程看得见，加进去就等于把身份交回给它。
 *   ② **绝不抛异常**：回执统一是 `{ok:true,data} | {ok:false,message}`。
 *      抛出去会变成渲染进程侧的一坨堆栈文本，而不是界面上一句可读中文。
 */

// ★ 三期（2026-09-30）：画像小结的读取口由**接线层注入**（见 handler 的注释）——
//   本文件**不 import electron 的 app**：`tests/data-plane-forward.test.ts` 会在纯 node 下
//   加载本模块，静态 import 一个 Electron 专属导出会让它直接语法错。
import { DEFAULT_GRADE_LEVEL } from '../agent/prompts/grade.ts'
// 学生 id 白名单：账号 id 会被拼进请求路径（服务端还会再校验一遍），
// 与 `pi-paths.ts` 里拼文件系统路径用的是**同一个**正则（只允许 [A-Za-z0-9_-]{1,64}）。
import { STUDENT_ID_PATTERN } from '../agent/pi-paths.ts'
// ★ 演示沙箱：写操作在**处理器层**一律拒绝（回一句可读中文，绝不让状态码上屏）。
import { isDemoSeeded } from '../demo/state.ts'
// ★★ 沙箱态「再练几道」的预置题：它**不是写操作**，所以走的是放行分支而不是回绝
//    （见 `runQuizGeneration` 的文件头）。与判分不同，这一条在沙箱里必须给出题 ——
//    演示要看到的是「动态出题真的能拿到题」，而不是一句「当前不可用」。
//    ⚠️ 相对路径 + `.ts` 后缀：与上面那条同一条纪律（本文件要被 node 单测直接加载）。
import { demoQuizVariantsBody } from '../demo/data.ts'
// ⚠️ 相对路径 + `.ts` 后缀，**不用 `@shared/*` 别名**：本文件会被若干 node 单测直接加载
//    （它们没有别名的解析钩子），写成别名会让那些用例当场 `Cannot find package`。
import { DEMO_BLOCKED_MESSAGE } from '../../shared/demo-seed.ts'
// ★ 学生面称呼的回落值（沙箱态回的那一帧状态用它）—— 与渲染层/主进程同一份常量。
import { STUDENT_FALLBACK_NAME } from '../../shared/profile-tags.ts'
import { ipcMain, type WebContents } from 'electron'
import {
  IPC,
  type AccountDeletePayload,
  type AccountsCallResult,
  type AccountsCreateRequest,
  type AccountsDeleteRequest,
  type AccountsDeleteResult,
  type AccountsListPayload,
  type AccountsListResult,
  type AccountsRenameRequest,
  type AccountsStudentResult,
  type AccountsSwitchRequest,
  type AccountSummary,
  type AnimationComposeRequest,
  type AnimationHostRequest,
  type AnimationRenderRequest,
  type AnimationSavedDeleteRequest,
  type AnimationSavedGetRequest,
  type AnimationSavedListRequest,
  type QuizGeneratedListRequest,
  type AnimationSavedSaveRequest,
  type AnimationTemplatesRequest,
  type CodeHintRequest,
  type CodeRunHintRequest,
  type CodeTemplateRequest,
  // ★ 决策记录与出题载荷：类型定义在 `shared/quiz-generate.ts`，经 `channels.ts` 转出
  //   （渲染层组装、主进程校验，两边同一份）。
  type DecisionTrace,
  type IdentityCallResult,
  type IdentityFlagsRequest,
  type KnowledgeImportIpcRequest,
  type KnowledgePointsRequest,
  type OnboardingAnswerRequest,
  type OnboardingCallResult,
  type OnboardingStatePayload,
  type ProfileTagsCallResult,
  type ProfileSummaryCallResult,
  type ProfileTimelineCallResult,
  type QuizBankRequest,
  type QuizGenerateRequest,
  type QuizGradeRequest,
  type QuizProgressRequest,
  type StudyCallResult
} from './channels.ts'
// ★★ 冷启动引导（票 25）：五问流程与画像标签的**主进程出口**。
//   · onboardingService 是流程状态与后台队列的唯一持有者（fire-and-forget 全在它内部）；
//   · 四个 profile / identity 出口（标签读/撤销、身份读、两道闸写）都在同一个模块里，
//     这里只做「校验入参 + 把异常翻成一句可读中文」——**绝不把异常穿过 IPC**。
import {
  fetchIdentity,
  fetchProfileTags,
  fetchProfileTimeline,
  MAX_ONBOARDING_ANSWER_CHARS,
  onboardingService,
  retractProfileTag,
  saveIdentityFlags,
  // ⚠️ GradeLevelLiteral 用本文件上面那个（四个学段字面量已在这里定义了一次）——
  //    两处同名会让 tsc 报 TS2440，而那个并集是同一个形状，没有必要 import 第二份。
  type OnboardingService,
  type OnboardingSummarizer
} from '../agent/onboarding/index.ts'
// ★★ sidecar 的**唯一出口**（`bridge/client.ts`）——账号那几条要 PATCH，
//   而 `wire/data.ts` 的方法联合只认 GET/POST/PUT/DELETE，所以这里直接用它，
//   **不新增第二个 HTTP 出口**（守卫 G5 扫的就是裸 `fetch(`）。
import { apiFetch } from '../bridge/client.ts'
import { dataRequests } from '../wire/data.ts'
import type { TraceRecordForUi } from '../agent/trace.ts'
import type { TraceEntry, TraceSnapshot } from '../../shared/ipc-events.ts'
// ★★ 动画的两条实现复用（**不重写第二套**）：
//   · `agent/animation/generator.ts`：模型出片段 → Python 拼装 + 校验 的那一条出口；
//   · `agent/extensions/animation.ts`：载荷投影 / 校验 / 重试上限 / 复用键的**唯一实现**
//     （Tool 那边用的也是它）。这里只是把它们编排起来，不复制任何判据。
import {
  MAX_RETRIES,
  animationRequestHash,
  projectAnimationPayload,
  validateAnimationPayload,
  withCaption,
  type AnimationPayloadShape
} from '../agent/extensions/animation.ts'
import { createAnimationGenerator } from '../agent/animation/generator.ts'
// ★★ 练习页动态出题：**进程内唯一实例** —— 模型通道由 runtime 填（`setCompleter`），
//   生成由本文件发起。两边必须是同一个实例，否则模型通道接不上，生成永远降级。
import { gradeSubjective, quizGenService } from '../agent/quizgen/service.ts'
// ★ 主观题判分失败的既有可读文案（与对话里那条判分路同一句，不另写一份）。
import { SUBJECTIVE_GRADING_FAILED_TEXT } from '../agent/extensions/quiz.ts'
// ★★ 登记时落盘的评分细则缓存 —— 练习页手里没有 rubric，见 rubric-cache.ts 的文件头。
import { rubricFor } from '../agent/quizgen/rubric-cache.ts'
import type { TextCompleter } from '../agent/safety/review.ts'

/** 题库一次最多取几道（与后端 `GET /api/quiz/bank` 的约束一致）。 */
export const QUIZ_BANK_MAX_COUNT = 10
/** 题库默认取几道。 */
export const QUIZ_BANK_DEFAULT_COUNT = 3
/** 代码提示的级别范围（与 `GET /api/code/hint` 一致）。 */
export const CODE_HINT_MIN_LEVEL = 1
export const CODE_HINT_MAX_LEVEL = 3
/** 导入教材的正文字符上限（与契约 `KnowledgeImportRequest.markdown` 的 max_length 一致）。 */
export const MAX_IMPORT_MARKDOWN_CHARS = 400_000
/** 动画概念名的字符上限（与 `compose_animation` 的 Tool 参数同一口径）。 */
export const MAX_ANIMATION_CONCEPT_CHARS = 40
/** 「学生想看什么」的字符上限（同上）。 */
export const MAX_ANIMATION_REQUEST_CHARS = 200
/** 一句话讲解的上限（同上）。 */
export const MAX_ANIMATION_CAPTION_CHARS = 200
/** 动画库条目 id 的字符集（与 Python `ANIMATION_SAVED_ID_PATTERN` / 契约同口径）。 */
export const ANIMATION_SAVED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 知识点 id 的字符集（Python `KP_ID_RE` 同口径；空串表示「没有绑定知识点」）。 */
export const ANIMATION_KP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 请求指纹（**十六进制摘要**；Python 的 `prompt_hash` 只收十六进制字符）。 */
export const ANIMATION_PROMPT_HASH_RE = /^[0-9a-fA-F]{8,128}$/

/* ------------------------------------------------------------------ *
 * 练习页动态出题：决策记录的**白名单投影**
 *
 * ★★ 为什么在处理器层单独投影一遍：这是渲染进程递上来的数据，字段一个都不能信 ——
 *   它会被拼进给模型的 Prompt（出错就是一次越界的模型调用），而 IPC 载荷是
 *   渲染进程能完全控制的那一侧。投影只取白名单里的字段、逐项限长，其余一律不进；
 *   认不出的整条丢掉（与 projectQuestion 同一「宁可少不要脏」口径）。
 * ------------------------------------------------------------------ */

/** 一次请求最多带多少条决策记录（防御性上限；正常一关就是几十条）。 */
export const MAX_DECISION_TRACES = 200
/** 题干开头截断长度（与后端写 learning_history 时 120 字的口径一致）。 */
export const MAX_STEM_HEAD_CHARS = 120
/** 单次作答文本上限（与判分通道的 2000 字同一口径）。 */
export const MAX_TRACE_ANSWER_CHARS = 2_000
/** 单题最多保留多少条提交轨迹（只留**最近**这些条：最新的卡点最有信息量）。 */
export const MAX_TRACE_TRIES = 20
/** 题型白名单（与题库载荷同一口径）。 */
const DECISION_TYPES = ['choice', 'blank', 'code_blank'] as const
/** 题目来源白名单：内置题库 / 智团团此前生成的题。 */
const DECISION_SOURCES = ['bank', 'generated'] as const

/**
 * 投影**一条**决策记录；认不出就返回 null（整条丢）。
 *
 * ★ triesCount / firstTryCorrect 由 tries **重算**，不采信渲染层给的值：
 *   两者本该同源，采信它等于给了「说一套、给一套」的机会。
 * ★ 一次判分没回来的提交记 correct: null（不是 false）——「不知道」与「答错了」
 *   对出题的价值相反，别在投影这一步把它们抹成同一个值。
 */
export function projectDecisionTrace(raw: unknown): DecisionTrace | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Partial<DecisionTrace>
  const qid = readText(source.qid, 128)
  if (!qid) return null
  const type =
    typeof source.type === 'string' && (DECISION_TYPES as readonly string[]).includes(source.type)
      ? (source.type as DecisionTrace['type'])
      : null
  if (type === null) return null
  const origin =
    typeof source.source === 'string' && (DECISION_SOURCES as readonly string[]).includes(source.source)
      ? (source.source as DecisionTrace['source'])
      : null
  if (origin === null) return null

  const tries = (Array.isArray(source.tries) ? source.tries : [])
    .map((item): { answer: string; correct: boolean | null } | null => {
      if (item === null || typeof item !== 'object') return null
      const entry = item as { answer?: unknown; correct?: unknown }
      if (typeof entry.answer !== 'string' || entry.answer.length === 0) return null
      return {
        answer: entry.answer.slice(0, MAX_TRACE_ANSWER_CHARS),
        correct: typeof entry.correct === 'boolean' ? entry.correct : null
      }
    })
    .filter((item): item is { answer: string; correct: boolean | null } => item !== null)
    .slice(-MAX_TRACE_TRIES)

  return {
    qid,
    // index 只是「题号」这个展示序，缺了不影响出题 —— 给 0 而不是丢掉整条。
    index: readInt(source.index, 1, 100_000) ?? 0,
    type,
    source: origin,
    stemHead: typeof source.stemHead === 'string' ? source.stemHead.slice(0, MAX_STEM_HEAD_CHARS) : '',
    tries,
    firstTryCorrect: tries.length > 0 ? tries[0].correct : null,
    triesCount: tries.length
  }
}

/**
 * 投影整个 context（白名单 + 条数上限）。
 *
 * ★ 上限按**前** 200 条截：列表是题号序，从头截意味着保住的总是最早那些题
 *   （学生第一次答对 / 第一次卡住的地方），比从尾截更难丢关键信息。
 */
export function projectDecisionTraceContext(raw: unknown): DecisionTrace[] {
  if (!Array.isArray(raw)) return []
  const projected: DecisionTrace[] = []
  for (const item of raw.slice(0, MAX_DECISION_TRACES)) {
    const trace = projectDecisionTrace(item)
    if (trace !== null) projected.push(trace)
  }
  return projected
}

/** 四个学段字面量（与契约 `GradeLevel` 逐字一致；此处只做运行期白名单）。 */
const GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior'] as const
type GradeLevelLiteral = (typeof GRADE_LEVELS)[number]

/** 降级链四档（与 `extensions/rag-search.ts` 的 `DEGRADED_LEVELS` / 契约 `Degraded` 一致）。 */
const DEGRADED_LEVELS = ['vector', 'cloud', 'fts', 'outline'] as const

/** 读一个降级档位；不是四档之一返回 `undefined`（**不兜底成 outline**）。 */
function readDegraded(value: unknown): TraceEntry['degraded'] | undefined {
  return typeof value === 'string' && (DEGRADED_LEVELS as readonly string[]).includes(value)
    ? (value as NonNullable<TraceEntry['degraded']>)
    : undefined
}

/**
 * 轨迹回调收到的记录形状。
 *
 * ★ 直接复用 Agent 运行时的 `TraceRecordForUi`（**唯一一份定义**）：
 *   在这里另写一份结构相同的接口，两处迟早漂移（一方加字段、另一方不知道），
 *   而漂移的表现是「界面上某个字段永远是空的」这种最难发现的静默错误。
 */
export type TraceRecordLike = TraceRecordForUi

/** 读一个学段字面量；不是四个之一返回 `null`（**不猜、不兜底**）。 */
function readGradeLevel(value: unknown): GradeLevelLiteral | null {
  return typeof value === 'string' && (GRADE_LEVELS as readonly string[]).includes(value)
    ? (value as GradeLevelLiteral)
    : null
}

/** 读一个非空字符串（带长度上限）；不合法返回 `null`。 */
function readText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

/** 读一个整数（可带范围）；不合法返回 `null`。 */
function readInt(value: unknown, min: number, max: number, fallback?: number): number | null {
  if (value === undefined || value === null) return fallback ?? null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null
  return parsed
}

/**
 * 一个新的 `payload_id`（沙箱『这是谁的消息』的身份）。
 *
 * ★ 字符集与长度与 Python 的 `validate_payload_id`（`^[A-Za-z0-9_-]{1,64}$`）一致：
 *   它会被服务端拼进**文件名与 URL query**，带别的字符会被拒。
 * ★ 与 `agent/extensions/animation.ts` 的 `newPayloadId()` 是**同一套形状的两份实现**
 *   （那边是 Tool 闭包里的私有函数）。这里不共用是为了不 widening 那个模块的导出面 ——
 *   代价是两处各一行，收益是 Agent 扩展的模块边界不被 IPC 层穿透。
 */
export function newAnimationPayloadId(): string {
  const cryptoRef = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return `anim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/* ------------------------------------------------------------------ *
 * 账号（本机多个学生）：路径 / 入参校验 / 取数口
 *
 * ★★ 与其它通道同一条纪律：**身份由主进程决定**。账号这几条递的是「操作哪一个账号」
 *    （一个要落进 URL 的 id），从不递「以谁的身份」—— 后者只有 `studentId()` 说了算。
 * ★ id 会被拼进请求路径，所以先过 `STUDENT_ID_PATTERN`；服务端还会再校验一遍，
 *   两道都要有（前端那道挡住明显穿越，服务端那道是权威）。
 * ------------------------------------------------------------------ */

/** 账号清单端点（`GET /api/students`）。 */
const ACCOUNTS_PATH = '/api/students'

/** 单个账号端点（`PATCH` / `DELETE /api/students/{id}`）。 */
function accountPath(studentId: string): string {
  return `${ACCOUNTS_PATH}/${encodeURIComponent(studentId)}`
}

/**
 * ★ Q1 的学段 = **冷启动初始值**（2026-10-01 用户裁决）：按当前账号改 `student.grade_level`
 * —— 与账号菜单「改名与学段」**同一条路**（`PATCH /api/students/{id}`）。
 *
 * ★ 为什么不用 `grade:set`（`POST /api/grade/override`）：那条是**手动语义** ——
 *   写 `grade_history(source=explicit)` 并进入 10 轮手动冷却，把「五问里的一道选择题」
 *   升格成「学生正式接管学段」；而它实际只是冷启动的第一个初始值，之后仍该被自动推断微调。
 * ⚠️ `studentId` 由调用方**在调用时**解析（`resolveActiveStudentId`），绝不接受装配期
 *    捕获的 id —— 那正是「学段写到上一个学生」的成因。
 */
export async function updateStudentGradeForAccount(
  studentId: string,
  gradeLevel: GradeLevelLiteral
): Promise<void> {
  const result = await requestAccounts<unknown>(accountPath(studentId), {
    method: 'PATCH',
    body: { gradeLevel }
  })
  if (!result.ok) throw new Error(result.message)
}

/** 账号端点的请求超时（本机回环，毫秒级；与 `wire/data.ts` 默认同量级）。 */
const ACCOUNTS_TIMEOUT_MS = 8_000

/**
 * ★★ 把「账号门填的昵称」写成学生称呼（`identity_local.real_name`）的**唯一写入点**
 * （2026-10-01 用户裁决：五问 q5 改成兴趣题后，称呼改由**建号 / 改名**这条路负责）。
 *
 * ⚠️ 身份是**参数传进来的那一位**（建号时是刚建出来的 id、改名时是被改的那位）——
 *    绝不用 `studentId()` 解析「当前账号」：建号这一刻当前账号还指着上一位。
 * ⚠️ 写失败**只 warn 不抛**：称呼丢了顶多回落「同学」，绝不因此让建号 / 改名失败。
 * ⚠️ 脱敏在服务端（`profile.py` 的 `safe_display_name`）—— 这条链只有一份实现，不在这里重写。
 */
async function writeAccountRealName(studentId: string, nickname: string): Promise<void> {
  try {
    await saveIdentityFlags(studentId, { realName: nickname })
  } catch (error) {
    console.warn(
      '[accounts] 称呼没有落盘（不影响账号操作，界面回落「同学」）：' +
        (error instanceof Error ? error.message : String(error))
    )
  }
}

/** 昵称上限（与契约 `StudentCreateRequest.nickname` 的 max_length 一致）。 */
const ACCOUNT_NICKNAME_MAX_CHARS = 32

/**
 * 账号四条的取数口（列表 / 建号 / 改名 / 删号）。
 *
 * ★ 为什么不复用 `wire/data.ts` 的 `requestJson`：它的方法联合只认 GET/POST/PUT/DELETE，
 *   而「改名」的契约是 **PATCH**。出口仍是同一个 `bridge/client.ts` 的 `apiFetch` ——
 *   本文件**一个 `fetch(` 都不写**（架构守卫 G5 扫的就是裸 fetch）。
 * ★ 失败消息与 `requestJson` 同口径（带状态码 + 服务端 detail）：界面上仍是可读中文，
 *   绝不把异常穿过 IPC 变成一坨堆栈文本。
 */
async function requestAccounts<T>(
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = { method: 'GET' }
): Promise<AccountsCallResult<T>> {
  const verb = init.method === 'GET' ? '读取失败' : '操作失败'
  try {
    const response = await apiFetch(path, {
      method: init.method,
      ...(init.body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
        : {}),
      signal: AbortSignal.timeout(ACCOUNTS_TIMEOUT_MS)
    })
    if (!response.ok) {
      return {
        ok: false,
        message: `${verb}（HTTP ${response.status}）：${await readAccountsDetail(response)}`
      }
    }
    return { ok: true, data: (await response.json()) as T }
  } catch (error) {
    return { ok: false, message: `${verb}：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 从失败响应里取一句细节（与 `wire/data.ts` / `ipc/handlers.ts` 的同名口径一致）。
 *
 * ★ 失败体有三种形态都要能用：`{detail: '…'}`、`{detail: [{loc, msg}]}`（pydantic 422）、
 *   非 JSON（中间件直接回的纯文本）。只认字符串的后果是 422 退化成英文
 *   `Unprocessable Entity` —— 学生既不知道哪个字段，也不知道要改什么。
 */
async function readAccountsDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown }
    const detail = body?.detail ?? body?.message
    if (typeof detail === 'string' && detail) return clipAccountDetail(detail)
    if (Array.isArray(detail)) {
      const first = detail[0] as { loc?: unknown; msg?: unknown } | undefined
      const field = Array.isArray(first?.loc)
        ? first.loc.filter((part) => part !== 'body').join('.')
        : ''
      const message = typeof first?.msg === 'string' ? first.msg : '校验未通过'
      return clipAccountDetail(field ? `${field}：${message}` : message)
    }
  } catch {
    // 非 JSON 响应（例如中间件直接返回的 401 纯文本）：忽略，走下面的回落
  }
  return response.statusText || '没有更多说明'
}

/** 单行化 + 截断（失败消息要能进界面，不能是一条两 KB 的 JSON）。 */
function clipAccountDetail(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 200 ? `${single.slice(0, 200)}…` : single
}

/** 读一个账号 id（非法 / 非字符串返回 `null`，**不猜**）。 */
function readAccountId(value: unknown): string | null {
  return typeof value === 'string' && STUDENT_ID_PATTERN.test(value) ? value : null
}

/** 读一个 Unix 毫秒时间戳（认不出给 `null`）。 */
function readAccountMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把服务端回的一行学生投影成账号列表项；认不出返回 `null`（**整行丢掉，不猜**）。
 *
 * ★ 时间字段两种写法都认（`createdAt` / `lastActiveAt` 与 A1 可能补的
 *   `createdAtMs` / `updatedAtMs`）：账号列表要显示「最近使用」，字段名对不上就会
 *   安静地显示成 1970 —— 那是本轮最容易漏的一种错。
 */
function readAccountSummary(value: unknown): AccountSummary | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const studentId = readAccountId(row.studentId)
  const nickname = typeof row.nickname === 'string' ? row.nickname.trim() : ''
  const gradeLevel = readGradeLevel(row.gradeLevel)
  if (studentId === null || nickname === '' || gradeLevel === null) return null
  return {
    studentId,
    nickname,
    gradeLevel,
    currentChapter: typeof row.currentChapter === 'string' ? row.currentChapter : '',
    createdAt: readAccountMs(row.createdAt) ?? readAccountMs(row.createdAtMs) ?? 0,
    lastActiveAt: readAccountMs(row.lastActiveAt) ?? readAccountMs(row.updatedAtMs) ?? 0
  }
}

/**
 * 这次失败是不是「这道主观题必须另走判分端点」（后端 409）。
 *
 * ★ 判据用 `requestJson` 拼出来的那句话里的**可读特征**：状态码（`HTTP 409`）或后端
 *   detail 里点名的端点（`grade-subjective`）。不解析 JSON、不看具体题号 ——
 *   消息本来是给人读的，这里是**唯一**一处把它当判据用；写脆了的表现是
 *   「主观题静默退化成判不了分」，不报错。
 */
function isSubjectiveConflict(message: string | undefined): boolean {
  if (typeof message !== 'string') return false
  return message.includes('HTTP 409') || message.includes('grade-subjective')
}

/** 409 但缓存里没有这题细则（重启前生成的老题 / 缓存文件被清过）时的可读提示。 */
const MISSING_RUBRIC_MESSAGE =
  '这道题要模型来判分，但它当时没留下评分要点。先做下一题，或者回对话里让智团团讲讲这道题。'

/**
 * 注册全部新增通道。
 *
 * @param options.resolveStudentId 学生 id 解析（生产恒为 `resolveActiveStudentId`）。
 * @param options.currentGradeLevel 当前生效学段（**题库隔离用**；不是渲染进程递来的值）。
 * @param options.requests 数据层请求注入点（测试用；生产恒为默认出口）。
 */
export function registerDataHandlers(options: {
  resolveStudentId: () => string
  /** 当前生效学段（`null` = 还没判出来，此时按冷启动默认值取题）。 */
  currentGradeLevel: () => string | null
  /** 数据层请求注入点（测试用；生产恒为默认出口）。 */
  requests?: typeof dataRequests
  /**
   * 切号成功后把「当前账号」写到本机状态文件（**由 `handlers.ts` 注入**）。
   *
   * ★ 为什么是注入而不是在这里写文件：那份状态落在 Electron 的 `userData` 下，
   *   而本文件**不 import Electron 的 `app`**（见文件头：纯 node 单测会加载本模块）。
   * ★ 不注入时切号回一句可读中文（写不进去就说写不进去，绝不假装切成功）。
   */
  saveCurrentAccount?: (studentId: string) => void
  /**
   * **文本补全器**（`animation:compose` 的直连生成用；生产默认 `null` = 没有）。
   *
   * ★★ 为什么是可注入的、且默认 `null`：直连生成要「模型出片段」，而补全器
   *   （`runtime.ts` 里那个 `lazyComplete`）是 ChatRuntime 的**闭包内部状态**，
   *   既不导出也没有访问器。本文件不拥有那个运行时，所以**不自己造一个 Pi 会话**
   *   （那会变成第二套装配，且每次点按钮都要付一次装配代价）。
   *   接线的位置在 `ipc/handlers.ts`（ChatRuntime 的持有者）——
   *   一行 `animationCompleter: () => runtime?.<补全器>` 就能点亮这条路。
   * ★ 拿不到补全器时**不是失败**：下面会退到「按当前学段重新渲染内置模板」那条路
   *   （零模型调用，断网也能用），再不行才给一句可读提示。
   */
  animationCompleter?: () => TextCompleter | null
}): void {
  // ★ 本文件里**所有**要用到学生身份的地方都只经这一个取数口（拼 URL 的与塞 body 的都算）：
  //   散开写就会出现「某一条通道忘了注入」——而它的表现是整条链路 422 全哑，不是一句报错。
  const studentId = (): string => options.resolveStudentId()
  const req = options.requests ?? dataRequests
  const animationCompleter = options.animationCompleter ?? ((): TextCompleter | null => null)

  /**
   * 沙箱态下拒绝一次**写操作**（回一句统一的、学生能读懂的中文）。
   *
   * ★★ 为什么拒绝在这里而不是 HTTP 层：走到 HTTP 层的话学生会看到
   *   「操作失败（HTTP 409）」这类**状态码**，而界面上每一句话都必须是中文。
   * ★ 被拒的这六条是**唯一会写学生数据 / 写随包资产**的读之外通道：
   *   判分写掌握度、求助写学习记录、存/删动画写动画库、导入与重建写知识库。
   *   沙箱态下它们**一个都不许真的落下去** —— 那正是「真实数据一字未动」的判据。
   */
  const demoBlocked = (): { ok: false; message: string } | null =>
    isDemoSeeded() ? { ok: false, message: DEMO_BLOCKED_MESSAGE } : null

  /* ---------------------------------------------------------------- *
   * 学生身份：读当前学生；**库里没有就把它建出来**
   *
   * 新装的机器首跑时 `learning.db` 是空的，没有这一条，界面上的昵称、
   * 档案页、推荐都无从谈起。建的学生是「本机唯一的学生」——
   * 与 `resolveActiveStudentId()` 的取值一致（同一台机器一个学生）。
   *
   * ★★ **必须按已知 id 建，不能用 `POST /api/students`**（P3-4 实测缺陷）：
   *   `POST /api/students` 的 id 是**服务端扫描目录分配的下一个空号**，
   *   于是这条「列一遍 → 没有就建」就成了一个**读-改-写竞态**：
   *   启动时两个调用（本通道 + 学段/推荐那条自动建学生的路）都可能先看到「一个都没有」，
   *   接着各建一个 —— 服务端顺序处理，第二个看到 `student_001` 已占，于是建出 `student_002`。
   *   现场表现就是「同一秒出现 `students/student_001` 与 `students/student_002`」，
   *   而学生的数据会分裂在两个目录里（谁被读到取决于哪条路先跑完）。
   *
   *   所以改成**幂等**的两步：先读该 id 的画像；404 说明这一位还不存在，
   *   就调那几条**会按这个 id 自动建行**的端点（`/recommendation` 的冷启动分支
   *   走 `upsert_student(student_id)`，主键固定），再读一次画像。
   *   两个并发调用做的是**同一件幂等的事**，不可能再冒出第二个 id。
   */
  ipcMain.handle(IPC.studentGet, async (): Promise<StudyCallResult> => {
    const wanted = studentId()

    /** 读该学生的 Student 行（不存在时服务端回 404）。 */
    const readWanted = async (): Promise<StudyCallResult> => {
      const profile = await req.profile(wanted)
      if (!profile.ok) return profile
      const data = profile.data as { student?: Record<string, unknown> } | null
      const student = data?.student
      if (student === undefined || student === null) {
        return { ok: false, message: '读取学生信息失败：本地数据服务返回的数据不完整。' }
      }
      return { ok: true, data: student }
    }

    const first = await readWanted()
    if (first.ok) return first
    // 不是「还没有」就不能乱建：权限 / 服务不可用这类失败要如实回给界面。
    if (!/HTTP\s*404/.test(first.message)) return first

    // 「还没有这一位」→ 调一个会按 **这个 id** 建行的端点（冷启动分支），
    // 昵称与学段都用服务端的中性默认值（**不采集真实姓名**，§12 数据最小化）。
    const ensured = await req.recommendation(wanted)
    if (!ensured.ok) return ensured
    return await readWanted()
  })

  /* ---------------------------------------------------------------- *
   * 账号（本机多个学生）：列表 / 建号 / 改名 / 删号 / 切号
   *
   * ★★ 「当前账号」只有一个真相点：`resolveActiveStudentId()`（本文件所有通道都经
   *    `studentId()` 取它）。切号只写本机那个指针，**不在处理器里动会话/运行时装配** ——
   *    渲染层重载后一切按新身份重新读，装配归 runtime。
   * ★★ 删号是破坏性的：**当前账号先拒绝**（回一句人话），切走之后再删。不挡的话，
   *    「当前账号」会指向一个刚被删掉的目录，下一次读学生态整个空掉 —— 而界面只会说
   *    「读取失败」，学生不知道那是自己刚删掉的账号。
   * ★ 沙箱态（预置数据）下建号 / 改名 / 删号一律拒绝：它们会真的写、真的删本机学生目录，
   *    而演示的前提是「真实数据一字未动」。列表与切号放行（切号只写本机指针，不碰库）。
   * ---------------------------------------------------------------- */

  ipcMain.handle(IPC.accountsList, async (): Promise<AccountsListResult> => {
    const result = await requestAccounts<unknown>(ACCOUNTS_PATH)
    if (!result.ok) return result
    if (!Array.isArray(result.data)) {
      return { ok: false, message: '读取账号失败：本地数据服务返回的数据不完整。' }
    }
    const students: AccountSummary[] = []
    for (const row of result.data) {
      const student = readAccountSummary(row)
      // ★ 认不出的整行丢掉（与事件层「脏数据一律忽略」同一条口径）：
      //   宁可列表少一行，也不给界面塞一个渲染不出来的账号。
      if (student !== null) students.push(student)
    }
    const payload: AccountsListPayload = { students }
    return { ok: true, data: payload }
  })

  ipcMain.handle(
    IPC.accountsCreate,
    async (_event, payload: unknown): Promise<AccountsStudentResult> => {
      const blocked = demoBlocked()
      if (blocked !== null) return blocked
      const request = (payload ?? {}) as Partial<AccountsCreateRequest>
      const nickname = readText(request.nickname, ACCOUNT_NICKNAME_MAX_CHARS)
      if (!nickname) {
        return {
          ok: false,
          message: `新建账号失败：昵称不能为空（最多 ${ACCOUNT_NICKNAME_MAX_CHARS} 个字）。`
        }
      }
      const gradeLevel = readGradeLevel(request.gradeLevel)
      if (gradeLevel === null) return { ok: false, message: '新建账号失败：请选择学段。' }
      const result = await requestAccounts<unknown>(ACCOUNTS_PATH, {
        method: 'POST',
        body: { nickname, gradeLevel }
      })
      if (!result.ok) return result
      const student = readAccountSummary(result.data)
      if (student === null) {
        return { ok: false, message: '新建账号失败：本地数据服务没有返回账号信息。' }
      }
      // ★★ 称呼在这里写（见 writeAccountRealName 的说明）：账号门填的昵称 = 学生的称呼。
      //    身份必须是**刚建出来的那一位**，不是当前账号 —— 建号这一刻 accounts.json 还指着上一位。
      await writeAccountRealName(student.studentId, nickname)
      return { ok: true, data: student }
    }
  )

  ipcMain.handle(
    IPC.accountsRename,
    async (_event, payload: unknown): Promise<AccountsStudentResult> => {
      const blocked = demoBlocked()
      if (blocked !== null) return blocked
      const request = (payload ?? {}) as Partial<AccountsRenameRequest>
      const target = readAccountId(request.studentId)
      if (target === null) return { ok: false, message: '修改账号失败：账号不合法。' }
      // ★ 只发**要改的字段**：全量覆盖会把没提到的字段按服务端默认值重置
      //   （学生只想改名，结果学段被改回默认值 —— 那种静默丢数据的错最难发现）。
      const body: { nickname?: string; gradeLevel?: GradeLevelLiteral } = {}
      if (request.nickname !== undefined) {
        const nickname = readText(request.nickname, ACCOUNT_NICKNAME_MAX_CHARS)
        if (!nickname) {
          return {
            ok: false,
            message: `修改账号失败：昵称不能为空（最多 ${ACCOUNT_NICKNAME_MAX_CHARS} 个字）。`
          }
        }
        body.nickname = nickname
      }
      if (request.gradeLevel !== undefined) {
        const gradeLevel = readGradeLevel(request.gradeLevel)
        if (gradeLevel === null) return { ok: false, message: '修改账号失败：学段不合法。' }
        body.gradeLevel = gradeLevel
      }
      if (body.nickname === undefined && body.gradeLevel === undefined) {
        return { ok: false, message: '修改账号失败：没有要改的内容。' }
      }
      const result = await requestAccounts<unknown>(accountPath(target), {
        method: 'PATCH',
        body
      })
      if (!result.ok) return result
      const student = readAccountSummary(result.data)
      if (student === null) {
        return { ok: false, message: '修改账号失败：本地数据服务没有返回账号信息。' }
      }
      // ★ 改名同样落到称呼上（与建号同一条纪律）：否则界面显示新昵称、
      //   而模型眼里的 {{student_name}} 还是旧称呼。学段单独改时不碰称呼。
      if (body.nickname !== undefined) await writeAccountRealName(target, body.nickname)
      return { ok: true, data: student }
    }
  )

  ipcMain.handle(
    IPC.accountsDelete,
    async (_event, payload: unknown): Promise<AccountsDeleteResult> => {
      const blocked = demoBlocked()
      if (blocked !== null) return blocked
      const request = (payload ?? {}) as Partial<AccountsDeleteRequest>
      const target = readAccountId(request.studentId)
      if (target === null) return { ok: false, message: '删除账号失败：账号不合法。' }
      // ★★ 当前账号不许删：删掉它之后，下一次 resolveActiveStudentId 会指着一个不存在的
      //    目录，界面上的学生态整个空掉 —— 而那不是一句「删除失败」能解释清楚的。
      //    正确的动作是**先切到别的账号再删**（文案直接把这一步说出来）。
      if (target === studentId()) {
        return {
          ok: false,
          message: '这是当前正在用的账号，先切换到别的账号再删。'
        }
      }
      const result = await requestAccounts<unknown>(accountPath(target), { method: 'DELETE' })
      if (!result.ok) return result
      const row = (result.data ?? {}) as { studentId?: unknown; deleted?: unknown }
      const deleted = typeof row.deleted === 'boolean' ? row.deleted : null
      const deletedId = typeof row.studentId === 'string' ? row.studentId : ''
      if (deleted === null || deletedId === '') {
        return { ok: false, message: '删除账号失败：本地数据服务没有返回删除结果。' }
      }
      // ★ `deleted: false` 不是失败：那个账号本来就已经不在了（界面照常刷新列表）。
      const payloadOut: AccountDeletePayload = { studentId: deletedId, deleted }
      return { ok: true, data: payloadOut }
    }
  )

  ipcMain.handle(
    IPC.accountsSwitch,
    async (_event, payload: unknown): Promise<AccountsStudentResult> => {
      const request = (payload ?? {}) as Partial<AccountsSwitchRequest>
      const target = readAccountId(request.studentId)
      if (target === null) return { ok: false, message: '切换账号失败：账号不合法。' }
      // ★ 先确认真有这一位，再落盘：把当前账号指向一个不存在的目录，会让下一次读学生态
      //   整个空掉（界面只能说「读取失败」，学生不知道自己点了什么）。
      const listed = await requestAccounts<unknown>(ACCOUNTS_PATH)
      if (!listed.ok) return listed
      const rows = Array.isArray(listed.data) ? listed.data : []
      let found: AccountSummary | null = null
      for (const row of rows) {
        const student = readAccountSummary(row)
        if (student !== null && student.studentId === target) {
          found = student
          break
        }
      }
      if (found === null) {
        return { ok: false, message: '切换账号失败：这个账号已经不在本机了。' }
      }
      const save = options.saveCurrentAccount
      if (save === undefined) {
        return { ok: false, message: '切换账号失败：本机的账号记录暂时写不进去。' }
      }
      try {
        // ★ 每次切号都写一次（即使切的就是当前那位）：这样「环境变量改道口」撤掉之后，
        //   本机指针与界面上的选择仍然是一致的，而不是停留在默认值上。
        save(target)
      } catch {
        return { ok: false, message: '切换账号失败：本机的账号记录暂时写不进去。' }
      }
      return { ok: true, data: found }
    }
  )

  /* ---------------------------------------------------------------- *
   * 画像 / 推荐 / 学段证据
   * ---------------------------------------------------------------- */
  ipcMain.handle(IPC.profileRead, async (): Promise<StudyCallResult> =>
    await req.profile(studentId())
  )

  ipcMain.handle(IPC.profileRecommendation, async (): Promise<StudyCallResult> =>
    await req.recommendation(studentId())
  )

  ipcMain.handle(IPC.gradeSignals, async (): Promise<StudyCallResult> =>
    await req.gradeSignals(studentId())
  )

  ipcMain.handle(IPC.gradeHistory, async (): Promise<StudyCallResult> =>
    await req.gradeHistory(studentId())
  )

  /* ---------------------------------------------------------------- *
   * 闯关（独立页面）
   *
   * ★ 题库的**学段由主进程注入**（从当前会话取），不接受渲染进程递来的值 ——
   *   否则「只取不高于学生学段的内容」这条隔离就被绕开了。
   * ---------------------------------------------------------------- */
  ipcMain.handle(IPC.quizBank, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<QuizBankRequest>
    const kpId = readText(request.kpId, 64)
    if (!kpId) return { ok: false, message: '取题失败：知识点 id 不合法。' }
    const count = readInt(request.count, 1, QUIZ_BANK_MAX_COUNT, QUIZ_BANK_DEFAULT_COUNT)
    if (count === null) {
      return { ok: false, message: `取题失败：题目数量必须是 1–${QUIZ_BANK_MAX_COUNT} 的整数。` }
    }
    // ★ 兜底必须是**真实的冷启动默认值**（`agent/prompts/grade.ts` 的 `DEFAULT_GRADE_LEVEL`），
    //   不能手写一个别的学段字面量：写错的表现与「沙箱态取不到题」一模一样 ——
    //   题库按不存在的学段过滤，后端 404，界面上是「这关的题目没取到」，
    //   而真正的默认学段一直就在那个常量里（D-073：冷启动默认初中）。
    const gradeLevel = readGradeLevel(options.currentGradeLevel?.()) ?? DEFAULT_GRADE_LEVEL
    return await req.quizBank({ kpId }, gradeLevel, count)
  })

  ipcMain.handle(IPC.quizGrade, async (_event, payload: unknown): Promise<StudyCallResult> => {
    // ★ 沙箱态：拒绝判分（它会写掌握度 / 学习记录 / 闯关进度三处）
    const blocked = demoBlocked()
    if (blocked !== null) return blocked
    const request = (payload ?? {}) as Partial<QuizGradeRequest>
    const qid = readText(request.qid, 128)
    if (!qid) return { ok: false, message: '提交失败：题目 id 不合法。' }
    // ★ 作答可以是空串吗：不可以。空着按「没答」处理，别让一次空提交也去写掌握度。
    const answer = typeof request.answer === 'string' ? request.answer.trim() : ''
    if (answer.length === 0) return { ok: false, message: '提交失败：还没有作答。' }
    if (answer.length > 2000) return { ok: false, message: '提交失败：作答内容过长。' }
    // ★★ 学生身份由**主进程**决定（`studentId()`），并作为**内部参数**传进取数层 ——
    //   它刻意不在 `QuizGradeRequest` 里（那是渲染进程能看到的类型）。
    //   服务端 `QuizGradeRequest.student_id` 是必填：不注入就是整个闯关页判分 422
    //   （掌握度 / 学习历史 / 进度三处全都不写），且渲染进程手里那个 `studentId`
    //   哪怕真被转发进来也只是个被**覆盖**的多余字段，指不动别人的记录。
    const graded = await req.quizGrade(
      {
        qid,
        answer,
        ...(typeof request.sessionId === 'string' && request.sessionId
          ? { sessionId: request.sessionId }
          : {})
      },
      studentId()
    )
    // ★★ 带 rubric 的主观题：规则判分端点一律 409（「必须走 grade-subjective」），
    //   而练习页手里没有 rubric（GET /api/quiz/generated 是投影后的，无 rubric/答案，
    //   后端也没有读单题端点）。唯一能拿到它的时机是**登记那一刻** —— 所以遇 409
    //   去缓存里取，用模型走一遍判分并把结论落库（契约与后端零改动）。
    //   ⚠️ 其余失败路径**原样返回**：D-134 刚修好的 topic/文案不许在这里被覆盖。
    if (graded.ok || !isSubjectiveConflict(graded.message)) return graded
    const student = studentId()
    const cached = rubricFor(student, qid)
    if (cached === null) return { ok: false, message: MISSING_RUBRIC_MESSAGE }
    try {
      const result = await gradeSubjective({
        studentId: student,
        gradeLevel: readGradeLevel(options.currentGradeLevel?.()) ?? DEFAULT_GRADE_LEVEL,
        qid,
        answer,
        stem: cached.stem,
        rubric: cached.rubric
      })
      return { ok: true, data: result }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : SUBJECTIVE_GRADING_FAILED_TEXT
      }
    }
  })

  ipcMain.handle(IPC.quizProgress, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<QuizProgressRequest>
    const kpIds = Array.isArray(request.kpIds)
      ? request.kpIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 64)
      : undefined
    return await req.quizProgress(studentId(), kpIds ? { kpIds } : {})
  })

  /* ---------------------------------------------------------------- *
   * 编程（★ 这里没有任何「执行代码」的路径）
   * ---------------------------------------------------------------- */
  ipcMain.handle(IPC.codeTemplate, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<CodeTemplateRequest>
    const kpId = readText(request.kpId, 64)
    if (!kpId) return { ok: false, message: '取模板失败：知识点 id 不合法。' }
    const level = request.gradeLevel === undefined ? undefined : readGradeLevel(request.gradeLevel)
    if (request.gradeLevel !== undefined && level === null) {
      return { ok: false, message: '取模板失败：学段不合法。' }
    }
    return await req.codeTemplate(level ? { kpId, gradeLevel: level } : { kpId })
  })

  ipcMain.handle(IPC.codeHint, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<CodeHintRequest>
    const kpId = readText(request.kpId, 64)
    if (!kpId) return { ok: false, message: '取提示失败：知识点 id 不合法。' }
    const level = readInt(request.level, CODE_HINT_MIN_LEVEL, CODE_HINT_MAX_LEVEL, CODE_HINT_MIN_LEVEL)
    if (level === null) {
      return {
        ok: false,
        message: `取提示失败：提示级别必须是 ${CODE_HINT_MIN_LEVEL}–${CODE_HINT_MAX_LEVEL} 的整数。`
      }
    }
    return await req.codeHint({ kpId, level })
  })

  ipcMain.handle(IPC.codeRunHint, async (_event, payload: unknown): Promise<StudyCallResult> => {
    // ★ 沙箱态：拒绝（它会写学习记录，并据库里状态算下一级提示）
    const blocked = demoBlocked()
    if (blocked !== null) return blocked
    const request = (payload ?? {}) as Partial<CodeRunHintRequest>
    const kpId = readText(request.kpId, 64)
    if (!kpId) return { ok: false, message: '分析失败：知识点 id 不合法。' }
    // ★ 代码上限与 Python 侧 `CodeRunRequest.code` 的 max_length 一致（20000）。
    //   超限当场拒绝：让后端回一个 422 再翻成「操作失败」对学生毫无帮助。
    const code = typeof request.code === 'string' ? request.code : ''
    if (code.length > 20_000) return { ok: false, message: '分析失败：代码过长（上限 20000 字符）。' }
    const attempt = readInt(request.attempt, 1, 1000, 1)
    if (attempt === null) return { ok: false, message: '分析失败：尝试次数不合法。' }
    // ★★ 与 `quizGrade` 同一个注入点：服务端 `CodeRunRequest.student_id` 同样是**必填**
    //   （它要用学生自己的库查生成题 / 写学习记录），少了它这条通道一律 422 ——
    //   表现就是「报错感知 + 分级求助」整条链路点了没反应。
    //   身份仍旧只取主进程解析出来的那个（见 `studentId()` 的定义处）。
    return await req.codeRunHint(
      {
        kpId,
        code,
        language: typeof request.language === 'string' && request.language ? request.language : 'python',
        stdout: typeof request.stdout === 'string' ? request.stdout.slice(0, 20_000) : '',
        stderr: typeof request.stderr === 'string' ? request.stderr.slice(0, 20_000) : '',
        attempt
      },
      studentId()
    )
  })

  /* ---------------------------------------------------------------- *
   * 动画（模板 → 渲染 → 一次性 nonce 托管）
   * ---------------------------------------------------------------- */
  ipcMain.handle(
    IPC.animationTemplates,
    async (_event, payload: unknown): Promise<StudyCallResult> => {
      const request = (payload ?? {}) as Partial<AnimationTemplatesRequest>
      const templates: AnimationTemplatesRequest = {}
      if (typeof request.kpId === 'string' && request.kpId) templates.kpId = request.kpId
      if (request.gradeLevel !== undefined) {
        const level = readGradeLevel(request.gradeLevel)
        if (level === null) return { ok: false, message: '取模板失败：学段不合法。' }
        templates.gradeLevel = level
      }
      return await req.animationTemplates(templates)
    }
  )

  ipcMain.handle(IPC.animationRender, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<AnimationRenderRequest>
    const render: AnimationRenderRequest = {}
    if (typeof request.templateId === 'string' && request.templateId) render.templateId = request.templateId
    if (typeof request.kpId === 'string' && request.kpId) render.kpId = request.kpId
    if (typeof request.fallbackText === 'string') render.fallbackText = request.fallbackText
    if (request.params && typeof request.params === 'object') render.params = request.params
    // ★ 转发 payload_id：不转发的话服务端会落默认的 `"preview"`，而托管侧另造一个 UUID，
    //   两边对不上 → 沙箱的每条消息被宿主过滤 → 动画必降级（见 `AnimationRenderRequest` 注释）。
    if (typeof request.payloadId === 'string' && request.payloadId) render.payloadId = request.payloadId
    if (request.gradeLevel !== undefined) {
      const level = readGradeLevel(request.gradeLevel)
      if (level === null) return { ok: false, message: '渲染失败：学段不合法。' }
      render.gradeLevel = level
    }
    if (!render.templateId && !render.kpId) {
      return { ok: false, message: '渲染失败：至少要给模板 id 或知识点 id。' }
    }
    return await req.animationRender(render)
  })

  ipcMain.handle(IPC.animationHost, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<AnimationHostRequest>
    const kpId = readText(request.kpId, 64)
    if (!kpId) return { ok: false, message: '托管失败：知识点 id 不合法。' }
    const html = typeof request.html === 'string' ? request.html : ''
    if (html.length === 0) return { ok: false, message: '托管失败：没有可托管的动画内容。' }
    const payloadId = readText(request.payloadId, 128)
    if (!payloadId) return { ok: false, message: '托管失败：缺少 payloadId（沙箱消息靠它防串台）。' }
    return await req.animationHost(studentId(), { kpId, html, payloadId })
  })

  /* ---------------------------------------------------------------- *
   * 学生动画库（清单 / 取一条 / 存一条 / 删一条）
   *
   * ★★ 五条通道（含下面的「按需现做」）**都不接受渲染进程递来的学生 id**：
   *   身份一律走 `studentId()`（= `resolveActiveStudentId()`）。库里一人一份
   *   `learning.db`，「查自己的库」这个动作本身就完成了学生隔离 —— 而它成立的前提
   *   恰恰是「id 只能由主进程决定」。所以 `channels.ts` 的这几个请求类型里
   *   **没有** studentId 字段（那是刻意的，别"补全"它）。
   * ★ 学段与知识点是**过滤维度**（不是权限）：跨学段预览就是换一个学段再查一次。
   * ---------------------------------------------------------------- */
  ipcMain.handle(IPC.animationSavedList, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<AnimationSavedListRequest>
    const query: AnimationSavedListRequest = {}
    if (request.gradeLevel !== undefined) {
      const level = readGradeLevel(request.gradeLevel)
      if (level === null) return { ok: false, message: '读取失败：学段不合法。' }
      query.gradeLevel = level
    }
    if (typeof request.kpId === 'string' && request.kpId.trim().length > 0) {
      const kpId = request.kpId.trim()
      if (!ANIMATION_KP_ID_RE.test(kpId)) return { ok: false, message: '读取失败：知识点不合法。' }
      query.kpId = kpId
    }
    return await req.animationSavedList(studentId(), query)
  })

  ipcMain.handle(IPC.quizGeneratedList, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<QuizGeneratedListRequest>
    const query: QuizGeneratedListRequest = {}
    if (typeof request.kpId === 'string' && request.kpId.trim().length > 0) {
      const kpId = request.kpId.trim()
      if (!ANIMATION_KP_ID_RE.test(kpId)) return { ok: false, message: '读取失败：知识点不合法。' }
      query.kpId = kpId
    }
    if (typeof request.limit === 'number' && Number.isFinite(request.limit)) {
      const limit = Math.trunc(request.limit)
      if (limit < 1 || limit > 200) return { ok: false, message: '读取失败：条数超出范围。' }
      query.limit = limit
    }
    // ★ 身份由主进程解析（与动画库那几条同一纪律：递进来就等于允许读别人的题）
    return await req.quizGeneratedList(studentId(), query)
  })

  /* ---------------------------------------------------------------- *
   * 练习页动态出题（做完内置题的自动追加 / 「还想再练练」）
   *
   * ★★ 身份与学段**由主进程注入**（与 quizBank 同一条纪律）：载荷类型里根本没有
   *    studentId / gradeLevel 这两个字段，渲染进程递不了也改不了。
   * ★★ 沙箱演示态的**例外**：这两条通道**放行**，回的是预置好的三道变式题
   *   （`demo/data.ts` 的 `DEMO_QUIZ_VARIANTS`）。
   *   判据是「这一条要演示的机制是动态出题本身」：回绝掉它就等于把这条功能在演示里
   *   整个抹掉，而它恰恰是这次演示要展示的东西（见 `docs/preset-redesign/05`）。
   *   ⚠️ 放行**只放行到预置数据**：模型通道一次都不会被调到（不花真钱、不落库），
   *   学生的作答轨迹也不会被送出去 —— 载荷在沙箱态下不参与任何生成。
   * ★ 出参形态与 quizGeneratedList 一致（data = 投影后的载荷，结构上没有答案）。
   *   ok:true 但 data === null = 「这一批没有新题」（配额已满 / 当前没有可用模型）——
   *   渲染层据此静默不追加（自动路径）或给一句行内说明（按钮路径），
   *   所以这里**不**把它翻成 ok:false（那会让自动路径摆出错误卡）。
   * ---------------------------------------------------------------- */
  ipcMain.handle(IPC.quizGenerateAuto, async (_event, payload: unknown): Promise<StudyCallResult> =>
    await runQuizGeneration(payload, 'auto')
  )

  ipcMain.handle(IPC.quizGenerateMore, async (_event, payload: unknown): Promise<StudyCallResult> =>
    await runQuizGeneration(payload, 'more')
  )

  /** 两条出题通道的公共前半段：拦截 → 校验 → 投影 → 注入身份/学段 → 交给出题服务。 */
  async function runQuizGeneration(
    payload: unknown,
    mode: 'auto' | 'more'
  ): Promise<StudyCallResult> {
    // ★★ 沙箱态：**直接回预置变式题**（不调模型、不读库、不写库）。
    //   放在 `demoBlocked()` 之前是刻意的：这一条不是写操作，走的是「放行并给预置数据」
    //   那条路 —— 与 `quizGrade`（真的会写掌握度）必须回绝的情形不是同一件事。
    if (isDemoSeeded()) return { ok: true, data: demoQuizVariantsBody() }
    const blocked = demoBlocked()
    if (blocked !== null) return blocked
    const request = (payload ?? {}) as Partial<QuizGenerateRequest>
    const kpId = readText(request.kpId, 64)
    if (!kpId || !ANIMATION_KP_ID_RE.test(kpId)) {
      return { ok: false, message: '出题失败：知识点不合法。' }
    }
    const run = {
      kpId,
      context: projectDecisionTraceContext(request.context),
      studentId: studentId(),
      // 学段取主进程当前生效的那一档（服务端推断出来的），再不行才是冷启动默认值 ——
      // 绝不用渲染层递来的值（那等于绕开「只出本学段的题」这条隔离）。
      gradeLevel: readGradeLevel(options.currentGradeLevel?.()) ?? DEFAULT_GRADE_LEVEL
    }
    const result =
      mode === 'auto'
        ? await quizGenService.generateAuto(run)
        : await quizGenService.generateMore(run)
    if (result.ok) {
      if (!result.payload && result.note) {
        // ★ 降级说明只在主进程日志里留痕：回执与 quizGeneratedList 同形，
        //   承载不了「为什么没出题」这种附加语义（多塞字段就等于改契约形状）。
        console.warn(`[quizgen] ${mode} 未产出题目：${result.note}`)
      }
      return { ok: true, data: result.payload ?? null }
    }
    return { ok: false, message: result.message ?? '这次没能出新题。' }
  }

  ipcMain.handle(IPC.animationSavedGet, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<AnimationSavedGetRequest>
    const savedId = typeof request.savedId === 'string' ? request.savedId.trim() : ''
    // ★ id 会被拼进路径：白名单挡在拼接之前（Python 侧还有一道同口径的校验）
    if (!ANIMATION_SAVED_ID_RE.test(savedId)) {
      return { ok: false, message: '这条动画读不出来，换一条试试。' }
    }
    return await req.animationSavedGet(studentId(), { savedId })
  })

  ipcMain.handle(IPC.animationSavedSave, async (_event, payload: unknown): Promise<StudyCallResult> => {
    // ★ 沙箱态：拒绝（它会往该学生的动画库里写一份产物）
    const blocked = demoBlocked()
    if (blocked !== null) return blocked
    const request = (payload ?? {}) as Partial<AnimationSavedSaveRequest>
    const kpId = readText(request.kpId, 64)
    if (!kpId || !ANIMATION_KP_ID_RE.test(kpId)) {
      return { ok: false, message: '保存失败：缺少知识点信息。' }
    }
    const gradeLevel = readGradeLevel(request.gradeLevel)
    if (gradeLevel === null) return { ok: false, message: '保存失败：学段不合法。' }
    const concept = readText(request.concept, MAX_ANIMATION_CONCEPT_CHARS)
    if (!concept) return { ok: false, message: '保存失败：缺少概念名称。' }
    // ★★ 只收**摘要**（十六进制）：学生原话一个字都不进库 ——
    //   与「SQLite 不存对话正文」同一条纪律（Python 侧的字段名就是 promptHash）。
    const promptHash =
      typeof request.promptHash === 'string' && ANIMATION_PROMPT_HASH_RE.test(request.promptHash)
        ? request.promptHash
        : ''
    if (!promptHash) return { ok: false, message: '保存失败：动画指纹不合法。' }
    const durationMs = readInt(request.durationMs, 1, 120_000)
    if (durationMs === null) return { ok: false, message: '保存失败：动画时长不合法。' }
    const html = typeof request.html === 'string' ? request.html : ''
    if (html.length === 0) return { ok: false, message: '保存失败：没有可保存的动画内容。' }
    const fallbackText = readText(request.fallbackText, 600)
    if (!fallbackText) return { ok: false, message: '保存失败：缺少文字讲解。' }
    const title = readText(request.title, 120) ?? concept
    const body: AnimationSavedSaveRequest = {
      kpId,
      gradeLevel,
      concept,
      promptHash,
      title,
      durationMs,
      html,
      fallbackText,
      ...(typeof request.fallbackImage === 'string' && request.fallbackImage.length > 0
        ? { fallbackImage: request.fallbackImage }
        : {})
    }
    return await req.animationSavedSave(studentId(), body)
  })

  ipcMain.handle(IPC.animationSavedDelete, async (_event, payload: unknown): Promise<StudyCallResult> => {
    // ★★ 沙箱态：**必须**拒绝（它是删除操作；预置动画库里那两条在磁盘上不存在，
    //    真删只会删到同名记录上 —— 与 `session:delete` 同一条理由）
    const blocked = demoBlocked()
    if (blocked !== null) return blocked
    const request = (payload ?? {}) as Partial<AnimationSavedDeleteRequest>
    const savedId = typeof request.savedId === 'string' ? request.savedId.trim() : ''
    if (!ANIMATION_SAVED_ID_RE.test(savedId)) {
      return { ok: false, message: '删除失败：这条动画不在你的动画库里。' }
    }
    return await req.animationSavedDelete(studentId(), { savedId })
  })

  /* ---------------------------------------------------------------- *
   * 按需现做一份动画（`animation:compose`）
   *
   * ★★ 它是「在线生成」按钮的**直连兜底**：正常路径是让学生那句话走一轮对话
   *   （模型调 `compose_animation`），只有当**这一轮根本开不起来**时才用这条。
   * ★ 两条腿，按「有没有模型」分工（都不产生白屏，拿不到就返回可读中文）：
   *     ① **模型出片段 → Python 拼装 + 校验 → 重试 ≤3**（`createAnimationGenerator`）：
   *        与 Tool 那条路**同一份实现、同一个校验器**，只是没有对话回合；
   *     ② 拿不到模型（或模型那条腿失败）→ **按当前学段重新渲染内置模板**：
   *        零模型调用、断网也能用，正好覆盖「按当前学段重画」这个诉求。
   *   两条都失败 → `{ok:false, message}`：**卡片照旧显示原来那段动画**，
   *   学生看到的是一句可读的话，而不是一块空白。
   * ★ 成功就**自动存库**（尽力而为：存不进只影响「下次还得现做」，不影响这次显示）。
   * ---------------------------------------------------------------- */
  ipcMain.handle(IPC.animationCompose, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<AnimationComposeRequest>

    const concept = readText(request.concept, MAX_ANIMATION_CONCEPT_CHARS)
    if (!concept) return { ok: false, message: '这个知识点暂时做不出新动画，先看现在这段。' }
    const wanted = readText(request.request, MAX_ANIMATION_REQUEST_CHARS) ?? concept
    const caption = readText(request.caption, MAX_ANIMATION_CAPTION_CHARS)

    const rawKpId = typeof request.kpId === 'string' ? request.kpId.trim() : ''
    if (rawKpId && !ANIMATION_KP_ID_RE.test(rawKpId)) {
      return { ok: false, message: '这个知识点暂时做不出新动画，先看现在这段。' }
    }
    const kpId = rawKpId
    // ★ 学段：请求里给了就用它（「按当前学段重画」要的正是那一档），否则用**主进程**当前的
    //   生效学段（服务端推断出来的那个），再不行才是冷启动默认值 —— 绝不用前端的猜测。
    const gradeLevel =
      readGradeLevel(request.gradeLevel) ?? readGradeLevel(options.currentGradeLevel?.()) ?? DEFAULT_GRADE_LEVEL

    const payloadId = newAnimationPayloadId()
    const student = studentId()

    const outcome = await produceComposedAnimation({
      kpId,
      gradeLevel,
      concept,
      request: wanted,
      caption,
      payloadId
    })
    if (outcome === null) {
      return {
        ok: false,
        message: '新的动画这次没做出来，先看现在这段就好。'
      }
    }

    // 尽力而为地存库：只有**真动画**（有 HTML）才存，且没有知识点时不存
    // （复用键的第一维就是知识点，落不到「讲的是哪一课」名下）。
    if (outcome.html.trim().length > 0 && kpId) {
      await req.animationSavedSave(student, {
        kpId,
        gradeLevel,
        concept: outcome.concept,
        promptHash: animationRequestHash(wanted),
        title: concept,
        durationMs: outcome.durationMs,
        html: outcome.html,
        fallbackText: outcome.fallbackText,
        ...(outcome.fallbackImage ? { fallbackImage: outcome.fallbackImage } : {})
      })
    }

    // ★ 渲染侧附加字段（与 Tool 那条路**同一形状**）：`payloadId` 是沙箱的串台防线，
    //   `gradeLevel` 是实际生效的学段（卡片据此判断要不要提供「按当前学段重画」）。
    return {
      ok: true,
      data: { ...outcome, payloadId, gradeLevel }
    }
  })

  /**
   * 直连生成的两条腿（模型 → 模板兜底）。拿不到载荷时返回 `null`（调用方给可读提示）。
   *
   * ★ 「重试 ≤3」的额度**与 Tool 那边同一个常量**（{@link MAX_RETRIES}）：
   *   两条路各自最多 4 次尝试，超了就收手 —— 无限重试等于把额度烧穿。
   * ★ 每一次产物都过**同一套校验**（`projectAnimationPayload` + `validateAnimationPayload`）：
   *   缺字段 / 有外部引用 / 时长非法一律不进卡片（那是白屏与"断网打不开"的成因）。
   */
  async function produceComposedAnimation(input: {
    kpId: string
    gradeLevel: string
    concept: string
    request: string
    caption: string | null
    payloadId: string
  }): Promise<(AnimationPayloadShape & { attempts: number }) | null> {
    // ── 腿①：模型出片段 → Python 拼装 + 校验（与 Tool 同一条实现） ──────────
    const complete = animationCompleter()
    if (complete) {
      const generate = createAnimationGenerator({ complete })
      let previousReason: string | undefined
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          const raw = await generate({
            concept: input.concept,
            kpId: input.kpId,
            gradeLevel: input.gradeLevel,
            attempt,
            ...(previousReason ? { previousReason } : {}),
            payloadId: input.payloadId
          })
          const projected = projectAnimationPayload(raw)
          if (projected === null) {
            previousReason = '自由生成的结果字段不齐'
            continue
          }
          const validated = validateAnimationPayload(projected)
          if (!validated.ok) {
            previousReason = validated.reason
            continue
          }
          return {
            ...withCaption({ ...projected, source: 'generated' }, input.caption),
            attempts: attempt + 1
          }
        } catch (error) {
          previousReason = error instanceof Error ? error.message : String(error)
        }
      }
    }

    // ── 腿②：按这一档学段重新渲染**内置模板**（零模型调用；断网也能用） ──────
    if (!input.kpId) return null
    const rendered = await req.animationRender({
      kpId: input.kpId,
      gradeLevel: input.gradeLevel as AnimationRenderRequest['gradeLevel'],
      params: {},
      // ★ 把同一个 payload_id 交给渲染：服务端不传时落 `"preview"`，
      //   与卡片手里那把对不上 → 沙箱永远等不到 ready（实测踩过，见 channels.ts 的注释）。
      payloadId: input.payloadId,
      ...(input.caption ? { fallbackText: input.caption } : {})
    })
    if (!rendered.ok) return null
    const projected = projectAnimationPayload(rendered.data)
    if (projected === null) return null
    const validated = validateAnimationPayload(projected)
    if (!validated.ok) return null
    return { ...withCaption(projected, input.caption), attempts: 1 }
  }

  /* ---------------------------------------------------------------- *
   * 教材知识库
   * ---------------------------------------------------------------- */
  ipcMain.handle(IPC.knowledgeStats, async (): Promise<StudyCallResult> => await req.knowledgeStats())

  ipcMain.handle(IPC.knowledgePoints, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const request = (payload ?? {}) as Partial<KnowledgePointsRequest>
    if (request.gradeLevel === undefined) return await req.knowledgePoints({})
    const level = readGradeLevel(request.gradeLevel)
    if (level === null) return { ok: false, message: '读取失败：学段不合法。' }
    return await req.knowledgePoints({ gradeLevel: level })
  })

  ipcMain.handle(IPC.knowledgeImport, async (_event, payload: unknown): Promise<StudyCallResult> => {
    // ★ 沙箱态：拒绝（它会往随包知识库写一份教材并重建索引）
    const blocked = demoBlocked()
    if (blocked !== null) return blocked
    const request = (payload ?? {}) as Partial<KnowledgeImportIpcRequest>
    const fileName = readText(request.fileName, 200)
    if (!fileName) return { ok: false, message: '导入失败：文件名不合法。' }
    // 文件名会被 Python 侧用来推导 kp_id 并拼进路径 —— 这里先挡掉路径分隔符与 `..`
    // （Python 侧还有一道「文件名 = kp_id.md」的校验，但**两道都要有**）
    if (/[\\/]/.test(fileName) || fileName.includes('..')) {
      return { ok: false, message: '导入失败：文件名里不能带路径分隔符。' }
    }
    const markdown = typeof request.markdown === 'string' ? request.markdown : ''
    if (markdown.length === 0) return { ok: false, message: '导入失败：文件内容为空。' }
    if (markdown.length > MAX_IMPORT_MARKDOWN_CHARS) {
      return { ok: false, message: `导入失败：文件过大（上限 ${MAX_IMPORT_MARKDOWN_CHARS} 字符）。` }
    }
    const body: KnowledgeImportIpcRequest = { fileName, markdown }
    if (request.gradeLevel !== undefined) {
      const level = readGradeLevel(request.gradeLevel)
      if (level === null) return { ok: false, message: '导入失败：学段不合法。' }
      body.gradeLevel = level
    }
    if (typeof request.rebuild === 'boolean') body.rebuild = request.rebuild
    return await req.knowledgeImport(body)
  })

  ipcMain.handle(IPC.knowledgeRebuild, async (): Promise<StudyCallResult> => {
    // ★ 沙箱态：拒绝（重建索引会真的重写随包知识库）
    const blocked = demoBlocked()
    if (blocked !== null) return blocked
    return await req.knowledgeRebuild()
  })
}

/**
 * 轨迹记录 → 界面快照的**投影器**。
 *
 * 用法：`createChatRuntime({ onTraceRecord: createTraceProjector(pushTrace) })`。
 *
 * ★ 为什么单独一个函数而不是塞进 `registerDataHandlers`：轨迹的产生者是
 *   **Agent 运行时**（`agent/runtime.ts` 的 `onTraceRecord` 回调），
 *   而消费者是渲染进程。本文件正好是两者之间那一层，所以投影逻辑放这里；
 *   但**接线**（谁把 webContents 传进来）留给 `handlers.ts` —— 本文件不碰 electron 的窗口。
 *
 * ★ 投影只保留界面要显示的字段：`toolCallId` / `at` / `blockReason` 是排查用的，
 *   界面放不下，也容易夹带内部信息（轨迹是要拿去做汇报的，宁少勿滥）。
 */
export function createTraceProjector(
  pushTrace: (snapshot: TraceSnapshot) => void
): (records: readonly TraceRecordLike[]) => void {
  return (records) => {
    const entries: TraceEntry[] = records.map((record) => {
      const degraded = readDegraded(record.degraded)
      return {
        turn: record.turn,
        toolName: record.toolName,
        argsSummary: record.argsSummary,
        ok: record.ok,
        latencyMs: record.latencyMs,
        // 只在认得出时带上（省略 = 「这一条没有降级信息」，与骗一个 outline 不是一回事）
        ...(degraded ? { degraded } : {})
      }
    })
    pushTrace({
      turn: entries.reduce((max, item) => Math.max(max, item.turn), 0),
      entries
    })
  }
}

/** 把轨迹快照发给一个窗口（销毁后不发 —— 对已销毁的 webContents 调用会抛）。 */
export function sendTraceTo(webContents: WebContents, snapshot: TraceSnapshot): void {
  if (webContents.isDestroyed()) return
  webContents.send(IPC.traceChanged, snapshot)
}

/* ------------------------------------------------------------------ *
 * 冷启动引导与画像标签（票 25）：七条 invoke + 一条推送
 *
 * ★★ 四条纪律，逐条与契约书 §3 对应：
 *   ① **学生身份由主进程决定**：这里所有处理器都只调 options.resolveStudentId()，
 *      请求类型里一个 studentId 字段都没有（一旦能指定 = 允许读别人的画像）；
 *   ② **五问的回答走独立通道**（onboarding:answer），**绝不混进 chat:send** ——
 *      ChatSendRequest 的字段集合被守卫 G6c 钉死为 ['text']；
 *   ③ **回执统一 {ok:true,data} | {ok:false,message}**，失败也给可读中文，
 *      绝不让异常穿过 IPC（那会变成界面上的堆栈文本）；
 *   ④ **只有 onboarding:changed 是推送**，其余七条都是 invoke（不进 PUSH_CHANNELS）。
 *
 * ★ 沙箱态（演示预置数据）：读状态一律回「引导早已结束」，写操作一律拒绝 ——
 *   演示里**绝不能突然弹出冷启动五问**（那会真的往学生的库里写五条回答），
 *   也不能改两道闸。这是「真实数据一字未动」这条判据在画像面的落点。
 * ------------------------------------------------------------------ */

/** 把任何异常翻成一句可读中文（IPC 边界上唯一的失败形态）。 */
function describeOnboardingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 沙箱态下拒绝一次写入（与 registerDataHandlers 里的 demoBlocked 同一条文案）。 */
function onboardingWriteBlocked(): { ok: false; message: string } | null {
  return isDemoSeeded() ? { ok: false, message: DEMO_BLOCKED_MESSAGE } : null
}

/**
 * 注册引导线七条 invoke 通道。
 *
 * @param options.resolveStudentId 学生身份（生产恒为 handlers.ts 的 resolveActiveStudentId）。
 * @param options.applyGradeBand Q1 点选直达的落点 —— **走既有 grade:set 那条链**
 *   （立即生效 + 10 轮冷却 + source=explicit，且不写 grade_signals）。由 handlers.ts 注入
 *   （那里持有 ChatRuntime）；不注入时引导照常走完，只是学段不立即生效。
 * @param options.sessionId 当前会话 id（落库审计用；拿不到就不发这个字段）。
 * @param options.onChanged 状态推送（onboarding:changed）。★ 由 `handlers.ts` 注入 ——
 *   本文件**不碰 electron 的窗口**（与 `createTraceProjector` 同一条纪律：投影在这里、
 *   接线在那里），否则 node 单测里那个只导出 ipcMain 的 electron 替身会当场炸。
 * @param options.summarize 五问收齐后的概括器（票 31 真接上 = `createLlmSummarizer`）。
 *   ★ 由 `handlers.ts` 注入 —— 本文件**不读设置、不碰明文 Key**（那是 settings/runtime-config 的事）；
 *   不注入时服务走降级桩（只保留本地抽取的字段，引导照常结束）。
 * @param options.service 注入点（测试用；生产恒为模块单例 onboardingService）。
 */
export function registerOnboardingHandlers(options: {
  resolveStudentId: () => string
  applyGradeBand?: (level: GradeLevelLiteral) => Promise<void>
  sessionId?: () => string
  onChanged?: (payload: OnboardingStatePayload) => void
  summarize?: OnboardingSummarizer
  service?: OnboardingService
  /**
   * ★ 三期（2026-09-30）：读**画像小结**（只回一段中文，空串 = 还没生成过）。
   *
   * ★ 为什么是注入的回调而不是在本文件里取：小结存在主进程本地文件
   *   （`<userData>/pi-agent/logs/`），而 userData 只有接线层（`handlers.ts` / runtime）
   *   知道 —— 本文件更**不该** import Electron 的 `app`
   *   （`tests/data-plane-forward.test.ts` 会在纯 node 下加载本模块，静态 import
   *   一个 Electron 专属导出会让它当场语法错）。这与「接线在 handlers.ts、
   *   投影在 handlers-data.ts」是同一条既有纪律。
   * ★ 不传 = 这个通道恒回空串（界面显示后端给的空态文案），不影响其余能力。
   */
  readSummary?: () => Promise<string>
}): void {
  const service = options.service ?? onboardingService
  service.configure({
    studentId: options.resolveStudentId,
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    ...(options.applyGradeBand ? { applyGradeBand: options.applyGradeBand } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.summarize ? { summarize: options.summarize } : {})
  })

  /** 学生 id 的唯一取数口（本段所有处理器都经它，绝不读渲染进程递来的 id）。 */
  const studentId = (): string => options.resolveStudentId()

  ipcMain.handle(IPC.onboardingState, async (): Promise<OnboardingCallResult<OnboardingStatePayload>> => {
    // ★ 沙箱态：直接回「引导早已结束」—— 既不弹五问，也不去读真实学生的流程状态。
    if (isDemoSeeded()) {
      return {
        ok: true,
        data: { onboardingState: 'done', answered: [], nextQuestionId: null, displayName: STUDENT_FALLBACK_NAME }
      }
    }
    try {
      return { ok: true, data: await service.start() }
    } catch (error) {
      // 读不到权威状态时**不猜**（宁可这一轮不弹引导，也不重复打扰学生）
      return { ok: false, message: '读取引导状态失败：' + describeOnboardingError(error) }
    }
  })

  ipcMain.handle(
    IPC.onboardingAnswer,
    async (_event, payload: unknown): Promise<OnboardingCallResult<{ accepted: boolean }>> => {
      const blocked = onboardingWriteBlocked()
      if (blocked !== null) return blocked
      const request = (payload ?? {}) as Partial<OnboardingAnswerRequest>
      const answerText = typeof request.answerText === 'string' ? request.answerText : ''
      if (answerText.trim() === '') return { ok: false, message: '引导回答失败：还没有内容。' }
      if (answerText.length > MAX_ONBOARDING_ANSWER_CHARS) {
        return { ok: false, message: '引导回答失败：内容过长（最多 ' + String(MAX_ONBOARDING_ANSWER_CHARS) + ' 字）。' }
      }
      try {
        // ★ questionId 只当**位置标签**用：认不出（不是 q1..q5）就拒，绝不去猜「哪句话是答案」。
        const result = await service.answer(request.questionId, answerText)
        if (!result.accepted) return { ok: false, message: result.message }
        return { ok: true, data: { accepted: true } }
      } catch (error) {
        return { ok: false, message: '引导回答失败：' + describeOnboardingError(error) }
      }
    }
  )

  ipcMain.handle(IPC.profileTags, async (): Promise<ProfileTagsCallResult> => {
    try {
      return { ok: true, data: await fetchProfileTags(studentId()) }
    } catch (error) {
      return { ok: false, message: '读取画像标签失败：' + describeOnboardingError(error) }
    }
  })

  ipcMain.handle(
    IPC.profileTimeline,
    async (_event, limit: unknown): Promise<ProfileTimelineCallResult> => {
      // ★ 只递一个**数字**上限：渲染进程指不了学生（身份由 resolveStudentId 决定）。
      const raw = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : undefined
      try {
        return { ok: true, data: await fetchProfileTimeline(studentId(), raw) }
      } catch (error) {
        return { ok: false, message: '读取画像变化失败：' + describeOnboardingError(error) }
      }
    }
  )

  ipcMain.handle(IPC.profileTagRetract, async (_event, key: unknown): Promise<ProfileTagsCallResult> => {
    const blocked = onboardingWriteBlocked()
    if (blocked !== null) return blocked
    const tagKey = readText(key, 64)
    if (!tagKey) return { ok: false, message: '撤销标签失败：标签名不合法。' }
    try {
      return { ok: true, data: await retractProfileTag(studentId(), tagKey) }
    } catch (error) {
      return { ok: false, message: '撤销标签失败：' + describeOnboardingError(error) }
    }
  })

  ipcMain.handle(IPC.profileSummary, async (): Promise<ProfileSummaryCallResult> => {
    // ★★ 只读缓存、**不生成**（三期，2026-09-30）：小结在画像变更之后由主进程顺带写好
    //   （`profile-refresh` 的 refresh-apply 成功时），所以这里没有网络调用、也不依赖模型可用。
    // ★ 沙箱态回空串：预置演示数据下没有真实画像变更，也就不会有小结 ——
    //   直接回空，界面显示后端给的空态文案（与 onboardingState 的沙箱 fail-safe 同一条纪律）。
    if (isDemoSeeded()) return { ok: true, data: { text: '' } }
    // ★ 没注入读取回调（测试 / 精简装配）→ 回空串，而不是报错：小结是可选能力。
    if (options.readSummary === undefined) return { ok: true, data: { text: '' } }
    try {
      return { ok: true, data: { text: await options.readSummary() } }
    } catch (error) {
      // 读文件失败（权限 / 文件坏了）→ 回一句可读中文；界面可回落空态文案，不白屏
      return { ok: false, message: '读取画像小结失败：' + describeOnboardingError(error) }
    }
  })

  ipcMain.handle(IPC.identityRead, async (): Promise<IdentityCallResult> => {
    try {
      return { ok: true, data: await fetchIdentity(studentId()) }
    } catch (error) {
      return { ok: false, message: '读取身份信息失败：' + describeOnboardingError(error) }
    }
  })

  ipcMain.handle(
    IPC.identityFlagsSet,
    async (_event, payload: unknown): Promise<IdentityCallResult> => {
      const blocked = onboardingWriteBlocked()
      if (blocked !== null) return blocked
      const request = (payload ?? {}) as IdentityFlagsRequest
      const flags: IdentityFlagsRequest = {}
      if (typeof request.parentConsent === 'boolean') flags.parentConsent = request.parentConsent
      if (typeof request.memorySwitch === 'boolean') flags.memorySwitch = request.memorySwitch
      if (flags.parentConsent === undefined && flags.memorySwitch === undefined) {
        return { ok: false, message: '保存开关失败：没有要改的开关。' }
      }
      try {
        return { ok: true, data: await saveIdentityFlags(studentId(), flags) }
      } catch (error) {
        return { ok: false, message: '保存开关失败：' + describeOnboardingError(error) }
      }
    }
  )
}
