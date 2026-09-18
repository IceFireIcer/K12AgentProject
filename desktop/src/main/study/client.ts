/**
 * 学习档案（章节 / 学习报告 / 错题本 / 学习地图）在主进程侧的**取数层**。
 *
 * ★ **为什么单独一个文件**：这四条通道都是「读 sidecar 的 `/api/*` 然后原样回给渲染进程」，
 *   形态完全一致。写在 `handlers.ts` 里会让那个文件继续膨胀，而它已经承担了
 *   会话生命周期、轮次、设置域、代码桥四件事。
 *
 * ★ **只做转发**：这里不解析、不聚合、不重算任何东西 —— 学段过滤、章节排序、
 *   连续天数、错题聚合**全部在 Python 侧完成**（混合后端的硬边界：数据域只在 Python）。
 *   主进程唯一做的是「加超时 + 把失败变成一句可读中文」。
 *
 * ★ **路径工厂单独导出**（`studyReportPath` 之类）：测试要断言 URL 形状，
 *   而 handlers 里的调用是黑盒。与 `extensions/profile.ts` 的 `profilePath` 同一手法。
 */

import { apiFetch } from '../bridge/client.ts'

/**
 * 单次请求的**传输初始化**（方法 / 头 / 已序列化的 body）。
 *
 * ★ 它由 {@link requestStudyJson} 组装好交给出口，**不暴露给调用方** ——
 *   调用方只需要写 `{ method, body }`，`Content-Type` 与 `JSON.stringify` 由出口统一加。
 */
export interface StudyRequestInit {
  method: string
  headers?: Record<string, string>
  body?: string
}

/** 四条档案通道的响应形态（与 pydantic 契约逐字对应，见 `@shared/api-types`）。 */
export interface StudyBridge {
  request(path: string, timeoutMs: number, init?: StudyRequestInit): Promise<Response>
}

/**
 * 取数结果：成功带回 JSON 原文（**不强转类型**），失败带回一句可读中文。
 *
 * ★ 为什么回 `unknown` 而不是泛型：这四条通道的字段全部由 pydantic 生成类型定义，
 *   主进程只是**搬运工**。在这里再写一遍 TS 类型等于把契约抄第二份，
 *   必然与 `api-types.ts` 漂移。渲染进程那边按生成类型消费（它有 typecheck 兜着）。
 */
export type StudyResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string }

/** 单条档案请求的超时（本机回环，正常是毫秒级；给足余量但不无限等）。 */
export const STUDY_REQUEST_TIMEOUT_MS = 8_000

/**
 * {@link requestStudyJson} 的入参。
 *
 * ★ `body` 存在即按 JSON 发（自动带 `Content-Type` 并序列化）；省略即无请求体。
 * ★ `request` 是**测试注入点**（生产恒为默认出口 `apiFetch`）—— 与改造前同一处。
 */
export interface StudyRequestOptions {
  /** HTTP 方法；省略即 `GET`（写操作的失败消息动词是「保存失败」）。 */
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE'
  /** 请求体（按 JSON 序列化）；`undefined` = 不带体。 */
  body?: unknown
  timeoutMs?: number
  request?: StudyBridge['request']
}

/** 报告端点（`GET /api/profile/{student_id}/report?days=N`）。 */
export function studyReportPath(studentId: string, days: number): string {
  return `/api/profile/${encodeURIComponent(studentId)}/report?days=${encodeURIComponent(String(days))}`
}

/** 错题本端点（`GET /api/quiz/mistakes/{student_id}`）。 */
export function studyMistakesPath(studentId: string): string {
  return `/api/quiz/mistakes/${encodeURIComponent(studentId)}`
}

/** 章节端点（`GET /api/knowledge/chapters/{grade_level}`，带学生就补进度）。 */
export function studyChaptersPath(gradeLevel: string, studentId?: string): string {
  const base = `/api/knowledge/chapters/${encodeURIComponent(gradeLevel)}`
  return studentId ? `${base}?student_id=${encodeURIComponent(studentId)}` : base
}

/** 依赖图全览端点（`GET /api/graph/overview/{grade_level}`，带学生就标注已掌握）。 */
export function studyGraphPath(gradeLevel: string, studentId?: string): string {
  const base = `/api/graph/overview/${encodeURIComponent(gradeLevel)}`
  return studentId ? `${base}?student_id=${encodeURIComponent(studentId)}` : base
}

/**
 * 发一次档案请求（GET / PUT 共用）并归一化成 {@link StudyResult}。
 *
 * ★★ **错误归一化只有这一份**：状态码、超时、异常三种情形到可读中文的映射只写在这里，
 *   写操作（`method !== 'GET'`）也不另写一份 —— 差别仅在那句消息的**动词**（读取 / 保存）：
 *   学生点的是「选择章节」，失败却看见「读取失败」会以为界面读错了东西。
 *
 * ★ **绝不抛异常**：这些 handler 在 `ipcMain.handle` 里，抛出去会变成渲染进程侧的
 *   `Error: Error invoking remote method`（一坨堆栈文本），而不是界面上一句可读中文。
 *   与设置域三条通道同一条纪律（`SettingsCallResult` 的判别联合）。
 *
 * ★ **失败也要给出「哪一步失败」**：`HTTP 503` 与「连不上」是两种完全不同的处置
 *   （前者看 sidecar 日志、后者看进程有没有起来），所以消息里带上状态码。
 *
 * ★ `body` **存在**时才带 `Content-Type: application/json` 并序列化（GET 请求不该带 header，
 *   也不该出现 `body: undefined` —— 某些代理会因此拒绝请求）。
 */
export async function requestStudyJson(
  path: string,
  options: StudyRequestOptions = {}
): Promise<StudyResult> {
  const timeoutMs = options.timeoutMs ?? STUDY_REQUEST_TIMEOUT_MS
  const request = options.request ?? defaultRequest
  const method = options.method ?? 'GET'
  const verb = method === 'GET' ? '读取失败' : '保存失败'
  const init: StudyRequestInit = { method }
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }
  try {
    const response = await request(path, timeoutMs, init)
    if (!response.ok) {
      return { ok: false, message: `${verb}（HTTP ${response.status}）：${await readDetail(response)}` }
    }
    const data = (await response.json()) as unknown
    return { ok: true, data }
  } catch (error) {
    return { ok: false, message: `${verb}：${describeError(error)}` }
  }
}

/**
 * GET 的薄包装（**既有调用点与测试用的就是它**，签名不变）。
 *
 * 行为与推广前逐字一致：默认 `GET`、同一份归一化、同样绝不抛异常。
 */
export async function fetchStudyJson(
  path: string,
  options: { timeoutMs?: number; request?: StudyBridge['request'] } = {}
): Promise<StudyResult> {
  return await requestStudyJson(path, options)
}

/** 默认出口：`bridge/client.ts` 的 `apiFetch`（唯一对 sidecar 发 HTTP 的地方，守卫 G5）。 */
async function defaultRequest(
  path: string,
  timeoutMs: number,
  init?: StudyRequestInit
): Promise<Response> {
  return await apiFetch(path, {
    method: init?.method ?? 'GET',
    // ★ 只在真有时才带上 headers / body：GET 请求带一个 `body: undefined` 虽然合法，
    //   但让「读」和「写」的请求在出口上长得不一样（读的那条不带这两个键）。
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(timeoutMs)
  })
}

/** 从失败响应里取一句细节（后端给的是 `{"detail": "..."}`；取不到就回状态文本）。 */
async function readDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body?.detail === 'string' && body.detail) return body.detail
  } catch {
    // 非 JSON 响应（例如中间件直接返回的 401 纯文本）：忽略，走下面的兜底
  }
  return response.statusText || '没有更多说明'
}

/** 异常 → 可读中文（超时单独说，因为它的处置与其它失败不同）。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    // `AbortSignal.timeout()` 触发时是 `TimeoutError`（DOMException 的子类，
    // 名字是 'TimeoutError'；Node 下也走这条）
    if (error.name === 'TimeoutError') return '本地数据服务响应超时'
    return error.message
  }
  return String(error)
}

/**
 * 学段取值白名单（与契约 `GradeLevel` 逐字一致）。
 *
 * ★ 渲染进程会传学段进来（章节/地图按学段查），所以这里要挡一次：
 *   它最终会被拼进 URL 路径。虽然 `encodeURIComponent` 已经挡住路径穿越，
 *   但**拼错学段**应当当场得到一句可读中文（而不是让后端回一个 422 再翻成「读取失败」）。
 */
export const STUDY_GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior'] as const

export type StudyGradeLevel = (typeof STUDY_GRADE_LEVELS)[number]

/** 字符串 → 学段（认不出返回 `null`，不猜测、不兜底成最近的一个）。 */
export function readStudyGradeLevel(value: unknown): StudyGradeLevel | null {
  return typeof value === 'string' && (STUDY_GRADE_LEVELS as readonly string[]).includes(value)
    ? (value as StudyGradeLevel)
    : null
}

/** 报告天数：整数、1..90（与后端 `REPORT_MAX_DAYS` 同口径；越界就直接拒绝）。 */
export const STUDY_MAX_REPORT_DAYS = 90

/** 解析报告天数，非法返回 `null`。 */
export function readReportDays(value: unknown): number | null {
  if (value === undefined || value === null) return 7
  const days = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(days) || days < 1 || days > STUDY_MAX_REPORT_DAYS) return null
  return days
}
