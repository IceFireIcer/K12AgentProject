/**
 * 新增读/写通道的**取数层**（画像 / 闯关 / 编程 / 动画 / 知识库）。
 *
 * ★ 与本文件并列的还有 `study/client.ts`（章节 / 报告 / 错题 / 地图）。
 *   两者形态完全一致：**加超时 + 把失败变成一句可读中文**，
 *   真正干活的全在 Python（数据域只在 Python 是架构硬边界）。
 *
 * ★★ **这里不做任何聚合与判定**：掌握度怎么算、阶段怎么推、章节怎么排、
 *   降级链走到哪一档 —— 全部在 Python 侧完成。TS 只是搬运工。
 *   在这边补一个「顺手也算一下」的分支，就是混合后端两套实现的起点。
 *
 * ★ 路径工厂单独导出（与 `study/client.ts` 同一手法）：测试要断言 URL 形状，
 *   而 handlers 里的调用是黑盒。
 */

import { apiFetch } from '../bridge/client.ts'
import {
  KNOWLEDGE_LONG_TASK_TIMEOUT_MS,
  type AnimationHostRequest,
  type AnimationRenderRequest,
  type AnimationTemplatesRequest,
  type CodeHintRequest,
  type CodeRunHintRequest,
  type CodeTemplateRequest,
  type KnowledgeImportIpcRequest,
  type KnowledgePointsRequest,
  type QuizBankRequest,
  type QuizGradeRequest,
  type QuizProgressRequest,
  type StudyCallResult
} from '../ipc/channels.ts'

/** 默认超时（本机回环，正常是毫秒级）。与 `study/client.ts` 同量级。 */
export const DATA_REQUEST_TIMEOUT_MS = 8_000

/** 单次请求描述（方法 + 已序列化的 body）。 */
interface WireInit {
  method: string
  headers?: Record<string, string>
  body?: string
}

interface WireOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  timeoutMs?: number
  /** 测试注入点（生产恒为默认出口 `apiFetch`）。 */
  request?: (path: string, init: WireInit, timeoutMs: number) => Promise<Response>
}

/* ------------------------------------------------------------------ *
 * 路径工厂
 * ------------------------------------------------------------------ */

/** 画像（`GET /api/profile/{id}`）。 */
export function profilePath(studentId: string): string {
  return `/api/profile/${encodeURIComponent(studentId)}`
}

/** 推荐下一步（`GET /api/profile/{id}/recommendation`）。 */
export function recommendationPath(studentId: string): string {
  return `${profilePath(studentId)}/recommendation`
}

/** 学段信号（`GET /api/grade/signals/{id}`）。 */
export function gradeSignalsPath(studentId: string): string {
  return `/api/grade/signals/${encodeURIComponent(studentId)}`
}

/** 学段轨迹（`GET /api/grade/history/{id}`）。 */
export function gradeHistoryPath(studentId: string): string {
  return `/api/grade/history/${encodeURIComponent(studentId)}`
}

/** 题库（`GET /api/quiz/bank/{kp_id}?gradeLevel=…&count=…`）。 */
export function quizBankPath(kpId: string, gradeLevel: string, count: number): string {
  const base = `/api/quiz/bank/${encodeURIComponent(kpId)}`
  return `${base}?gradeLevel=${encodeURIComponent(gradeLevel)}&count=${encodeURIComponent(String(count))}`
}

/** 判分（`POST /api/quiz/grade`）。 */
export const QUIZ_GRADE_PATH = '/api/quiz/grade'

/** 闯关进度（`GET /api/quiz/progress/{id}`，可选 `kpIds` 逗号分隔）。 */
export function quizProgressPath(studentId: string, kpIds?: readonly string[]): string {
  const base = `/api/quiz/progress/${encodeURIComponent(studentId)}`
  if (!kpIds || kpIds.length === 0) return base
  return `${base}?kpIds=${encodeURIComponent(kpIds.join(','))}`
}

/** 代码脚手架（`GET /api/code/templates/{kp_id}`，可选按学段过滤）。 */
export function codeTemplatePath(kpId: string, gradeLevel?: string): string {
  const base = `/api/code/templates/${encodeURIComponent(kpId)}`
  return gradeLevel ? `${base}?gradeLevel=${encodeURIComponent(gradeLevel)}` : base
}

/** 代码提示（`GET /api/code/hint/{kp_id}?level=N`）。 */
export function codeHintPath(kpId: string, level: number): string {
  return `/api/code/hint/${encodeURIComponent(kpId)}?level=${encodeURIComponent(String(level))}`
}

/** 代码分析（`POST /api/code/run-hint`；**后端不执行代码**，只归一报错 + 定提示）。 */
export const CODE_RUN_HINT_PATH = '/api/code/run-hint'

/** 动画模板清单（`GET /api/animation/templates`）。 */
export function animationTemplatesPath(request: AnimationTemplatesRequest = {}): string {
  const query = new URLSearchParams()
  if (request.kpId) query.set('kpId', request.kpId)
  if (request.gradeLevel) query.set('gradeLevel', request.gradeLevel)
  const qs = query.toString()
  return `/api/animation/templates${qs ? `?${qs}` : ''}`
}

/** 动画渲染（`POST /api/animation/render`）。 */
export const ANIMATION_RENDER_PATH = '/api/animation/render'

/** 动画托管（`POST /api/animation/host/{student_id}/{kp_id}` → 一次性 nonce 地址）。 */
export function animationHostPath(studentId: string, kpId: string): string {
  return `/api/animation/host/${encodeURIComponent(studentId)}/${encodeURIComponent(kpId)}`
}

/** 知识库体检（`GET /api/knowledge/stats`）。 */
export const KNOWLEDGE_STATS_PATH = '/api/knowledge/stats'

/** 知识点清单（`GET /api/knowledge/points`，可选按学段过滤）。 */
export function knowledgePointsPath(request: KnowledgePointsRequest = {}): string {
  const base = '/api/knowledge/points'
  return request.gradeLevel ? `${base}?grade_level=${encodeURIComponent(request.gradeLevel)}` : base
}

/** 教材导入（`POST /api/knowledge/import`）。 */
export const KNOWLEDGE_IMPORT_PATH = '/api/knowledge/import'

/** 索引重建（`POST /api/knowledge/rebuild`）。 */
export const KNOWLEDGE_REBUILD_PATH = '/api/knowledge/rebuild'

/* ------------------------------------------------------------------ *
 * 取数出口
 * ------------------------------------------------------------------ */

/**
 * 发一次请求并归一化成 {@link StudyCallResult}。
 *
 * ★ **绝不抛异常**：这些 handler 在 `ipcMain.handle` 里，抛出去会变成渲染进程侧的
 *   `Error: Error invoking remote method`（一坨堆栈文本），而不是界面上一句可读中文。
 *   与设置域 / 学习档案同一条纪律。
 * ★ **失败要说清哪一步失败**：`HTTP 503` 与「连不上」是两种处置，
 *   所以消息里带上状态码。
 */
export async function requestJson(path: string, options: WireOptions = {}): Promise<StudyCallResult> {
  const timeoutMs = options.timeoutMs ?? DATA_REQUEST_TIMEOUT_MS
  const request = options.request ?? defaultRequest
  const method = options.method ?? 'GET'
  const verb = method === 'GET' ? '读取失败' : '操作失败'
  const init: WireInit = { method }
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }
  try {
    const response = await request(path, init, timeoutMs)
    if (!response.ok) {
      return { ok: false, message: `${verb}（HTTP ${response.status}）：${await readDetail(response)}` }
    }
    return { ok: true, data: (await response.json()) as unknown }
  } catch (error) {
    return { ok: false, message: `${verb}：${describeError(error)}` }
  }
}

/** 默认出口：`bridge/client.ts` 的 `apiFetch`（唯一对 sidecar 发 HTTP 的地方，守卫 G5）。 */
async function defaultRequest(path: string, init: WireInit, timeoutMs: number): Promise<Response> {
  return await apiFetch(path, {
    method: init.method,
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
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
    if (error.name === 'TimeoutError') return '本地数据服务响应超时'
    return error.message
  }
  return String(error)
}

/* ------------------------------------------------------------------ *
 * 各通道的薄包装（入参已在 handlers 里校验过类型）
 * ------------------------------------------------------------------ */

export const dataRequests = {
  profile: (studentId: string) => requestJson(profilePath(studentId)),
  recommendation: (studentId: string) => requestJson(recommendationPath(studentId)),
  gradeSignals: (studentId: string) => requestJson(gradeSignalsPath(studentId)),
  gradeHistory: (studentId: string) => requestJson(gradeHistoryPath(studentId)),

  quizBank: (request: QuizBankRequest, gradeLevel: string, count: number) =>
    requestJson(quizBankPath(request.kpId, gradeLevel, count)),
  quizGrade: (request: QuizGradeRequest) =>
    requestJson(QUIZ_GRADE_PATH, { method: 'POST', body: request }),
  quizProgress: (studentId: string, request: QuizProgressRequest = {}) =>
    requestJson(quizProgressPath(studentId, request.kpIds)),

  codeTemplate: (request: CodeTemplateRequest) =>
    requestJson(codeTemplatePath(request.kpId, request.gradeLevel)),
  codeHint: (request: CodeHintRequest) =>
    requestJson(codeHintPath(request.kpId, request.level ?? 1)),
  codeRunHint: (request: CodeRunHintRequest) =>
    requestJson(CODE_RUN_HINT_PATH, { method: 'POST', body: request }),

  animationTemplates: (request: AnimationTemplatesRequest = {}) =>
    requestJson(animationTemplatesPath(request)),
  animationRender: (request: AnimationRenderRequest) =>
    requestJson(ANIMATION_RENDER_PATH, { method: 'POST', body: request }),
  animationHost: (studentId: string, request: AnimationHostRequest) =>
    requestJson(animationHostPath(studentId, request.kpId), {
      method: 'POST',
      body: { html: request.html, payloadId: request.payloadId }
    }),

  knowledgeStats: () => requestJson(KNOWLEDGE_STATS_PATH),
  knowledgePoints: (request: KnowledgePointsRequest = {}) =>
    requestJson(knowledgePointsPath(request)),

  /**
   * 导入教材（长超时）。
   *
   * ★★ **必须覆盖默认 8s**：它里面会重建索引（分块 + 嵌入整份教材，实测 ~7s，
   *   教材变多会更久）。用默认超时会让一次**成功**的导入被报成「操作失败：响应超时」，
   *   而库其实已经写好了 —— 这是最难排查的一类假失败。
   */
  knowledgeImport: (request: KnowledgeImportIpcRequest) =>
    requestJson(KNOWLEDGE_IMPORT_PATH, {
      method: 'POST',
      body: request,
      timeoutMs: KNOWLEDGE_LONG_TASK_TIMEOUT_MS
    }),

  /** 重建索引（同样长超时，理由同上）。 */
  knowledgeRebuild: () =>
    requestJson(KNOWLEDGE_REBUILD_PATH, {
      method: 'POST',
      body: {},
      timeoutMs: KNOWLEDGE_LONG_TASK_TIMEOUT_MS
    })
} as const
