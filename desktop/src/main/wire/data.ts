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
  type AnimationSavedDeleteRequest,
  type AnimationSavedGetRequest,
  type AnimationSavedListRequest,
  type QuizGeneratedListRequest,
  type AnimationSavedSaveRequest,
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

/**
 * 新会话开场引导（`GET /api/profile/{id}/opening`）。
 *
 * ★ 与 `recommendationPath` 是**两条不同的端点**，不要合并：
 *   推荐是「下一步学什么」（随时可查，给学生一张清单），
 *   开场引导是「新会话的第一句话」（只在会话为空时有意义，且带一句已拼好的中文）。
 *   合并成一条会逼着两个调用点各自判断「我现在要不要念推荐里的哪一条」。
 */
export function openingPath(studentId: string, seed?: string): string {
  const base = `${profilePath(studentId)}/opening`
  // ★★ D-074：开场引导是**随机**的（知识点与说法都随机），而 `seed` 决定抽到什么。
  //   传**会话 id** → 同一条会话反复读拿到逐字相同的那一句（否则「切走再切回 / 重启」
  //   屏幕上那句与写进会话文件的那句对不上 —— D-072 修的就是这类不一致）；
  //   换一条会话（新 id）→ 自然换一个知识点、换一套说法（用户要的「每次换一个」）。
  return seed ? `${base}?seed=${encodeURIComponent(seed)}` : base
}

/** 学段信号（`GET /api/grade/signals/{id}`）。 */
export function gradeSignalsPath(studentId: string): string {
  return `/api/grade/signals/${encodeURIComponent(studentId)}`
}

/** 学段轨迹（`GET /api/grade/history/{id}`）。 */
export function gradeHistoryPath(studentId: string): string {
  return `/api/grade/history/${encodeURIComponent(studentId)}`
}

/**
 * 题库（`GET /api/quiz/bank/{kp_id}?grade_level=…&count=…`）。
 *
 * ★ 参数名用**服务端声明过的那个**（`grade_level`）：`code.py` / `quiz.py` 的
 *   `_pick_grade_level` 两个名字都收，但 camelCase 那个是 `include_in_schema=False`
 *   的兼容别名 —— 真正进了 OpenAPI 契约的是 snake_case。这里跟随契约而不是别名。
 */
export function quizBankPath(kpId: string, gradeLevel: string, count: number): string {
  const base = `/api/quiz/bank/${encodeURIComponent(kpId)}`
  return `${base}?grade_level=${encodeURIComponent(gradeLevel)}&count=${encodeURIComponent(String(count))}`
}

/** 判分（`POST /api/quiz/grade`）。 */
export const QUIZ_GRADE_PATH = '/api/quiz/grade'

/** 闯关进度（`GET /api/quiz/progress/{id}`，可选 `kpIds` 逗号分隔）。 */
export function quizProgressPath(studentId: string, kpIds?: readonly string[]): string {
  const base = `/api/quiz/progress/${encodeURIComponent(studentId)}`
  if (!kpIds || kpIds.length === 0) return base
  return `${base}?kpIds=${encodeURIComponent(kpIds.join(','))}`
}

/**
 * 代码脚手架（`GET /api/code/templates/{kp_id}`，可选按学段过滤）。
 *
 * ★ 与 {@link quizBankPath} 同口径：`grade_level` 是服务端声明的主名，
 *   `gradeLevel` 只是它留的兼容别名。
 */
export function codeTemplatePath(kpId: string, gradeLevel?: string): string {
  const base = `/api/code/templates/${encodeURIComponent(kpId)}`
  return gradeLevel ? `${base}?grade_level=${encodeURIComponent(gradeLevel)}` : base
}

/** 代码提示（`GET /api/code/hint/{kp_id}?level=N`）。 */
export function codeHintPath(kpId: string, level: number): string {
  return `/api/code/hint/${encodeURIComponent(kpId)}?level=${encodeURIComponent(String(level))}`
}

/** 代码分析（`POST /api/code/run-hint`；**后端不执行代码**，只归一报错 + 定提示）。 */
export const CODE_RUN_HINT_PATH = '/api/code/run-hint'

/**
 * 动画模板清单（`GET /api/animation/templates`）。
 *
 * ⚠️ 这里**刻意用 camelCase**（与上面两个工厂相反）：`resources.py` 的
 *   `kpId` / `gradeLevel` 就是**声明过的主名**，没有留 snake_case 别名 ——
 *   写成 `kp_id=` 会被 FastAPI 当成未知参数**静默忽略**（不报错、只是不过滤）。
 *   即「参数名以服务端签名为准」，不是「全项目统一 snake_case」。
 */
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

/* ------------------------------------------------------------------ *
 * 学生动画库（`server/app/routes/animation_library.py`）
 *
 * ★ 学生 id 由**主进程**注入（这些工厂的 `studentId` 参数是内部参数，
 *   不在 `channels.ts` 的请求类型里）—— 与 `quizBank` / `quizGrade` 同一条纪律：
 *   前端能指定身份 = 能读别人做过的动画。
 * ⚠️ 这几条路径与 `agent/extensions/animation.ts` 里的 `animationSavedPath` /
 *   `ANIMATION_SAVED_LOOKUP_PATH` **是同一组端点**（那边给 Tool 用、这边给 IPC 用）。
 *   两处各写一次是有意的取舍：`wire/` 是最底层的数据平面，不该反向依赖 Agent 工具模块；
 *   路径形状由两边各自的测试钉住（`tests/animation-library-ui.test.ts` 与
 *   `tests/animation-compose-tool.test.ts`）。改端点时**两处都要改**。
 * ------------------------------------------------------------------ */

/** 该学生的动画库清单（`GET /api/animation/saved/{id}`，可选按学段 / 知识点过滤）。 */
export function animationSavedListPath(studentId: string, request: AnimationSavedListRequest = {}): string {
  const base = `/api/animation/saved/${encodeURIComponent(studentId)}`
  const query = new URLSearchParams()
  // ⚠️ 参数名用服务端声明过的那个（`gradeLevel` / `kpId`，`routes/animation_library.py` 的 Query 主名）
  if (request.gradeLevel) query.set('gradeLevel', request.gradeLevel)
  if (request.kpId) query.set('kpId', request.kpId)
  const qs = query.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * 该学生自己的生成题（`GET /api/quiz/generated/{id}`）。
 *
 * ⚠️ 参数名用服务端声明过的那个（`kpId` / `limit`，`routes/quiz.py` 的 Query 主名）。
 * ★ 与动画库那几条同一纪律：`studentId` 由这里**内部注入**，不进跨 IPC 的请求类型。
 */
export function quizGeneratedPath(studentId: string, request: QuizGeneratedListRequest = {}): string {
  const base = `/api/quiz/generated/${encodeURIComponent(studentId)}`
  const query = new URLSearchParams()
  if (request.kpId) query.set('kpId', request.kpId)
  if (typeof request.limit === 'number') query.set('limit', String(request.limit))
  const qs = query.toString()
  return qs ? `${base}?${qs}` : base
}

/** 保存一条（同上路径，POST）。 */
export function animationSavedWritePath(studentId: string): string {
  return `/api/animation/saved/${encodeURIComponent(studentId)}`
}

/** 取一条 / 删一条（`/api/animation/saved/{id}/{saved_id}`；`savedId` 服务端还会校验字符集）。 */
export function animationSavedItemPath(studentId: string, savedId: string): string {
  return `${animationSavedWritePath(studentId)}/${encodeURIComponent(savedId)}`
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

/**
 * 从失败响应里取一句细节。
 *
 * ★ 失败体有三种形态，都要能用：`{"detail": "…"}`（鉴权 / 404 / 503）、
 *   `{"detail": […]}`（**422 —— pydantic 的校验错误本来就是个数组**）、非 JSON
 *   （中间件直接返回的纯文本）。口径与 `ipc/handlers.ts` 的同名函数一致
 *   （那边是设置域与对话域的同一条路，别让同类回执在两条链上两种说法），
 *   兜底链也同样取 `detail → message → 状态文本`。
 * ★ 只认字符串形态的后果：一次本可读的校验失败会退化成英文 `Unprocessable Entity`，
 *   学生看到的是「操作失败（HTTP 422）：Unprocessable Entity」—— 他既不知道哪个字段，
 *   也不知道要改什么。
 * ★ 数组分支只报**第一条**：一次也就能改一处，把十条拼成一段反而更长更难读。
 */
async function readDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown }
    const detail = body?.detail ?? body?.message
    if (typeof detail === 'string' && detail) return clip(detail)
    if (Array.isArray(detail)) {
      const first = detail[0] as { loc?: unknown; msg?: unknown } | undefined
      // `loc` 形如 `["body", "studentId"]`：`body` 只是容器名，报给学生的字段名要剥掉它
      const field = Array.isArray(first?.loc)
        ? first.loc.filter((part) => part !== 'body').join('.')
        : ''
      const message = typeof first?.msg === 'string' ? first.msg : '校验未通过'
      return clip(field ? `${field}：${message}` : message)
    }
  } catch {
    // 非 JSON 响应（例如中间件直接返回的 401 纯文本）：忽略，走下面的兜底
  }
  return response.statusText || '没有更多说明'
}

/** 单行化 + 截断（失败消息要能进状态栏，不能是一条 2KB 的 JSON）。与 `ipc/handlers.ts` 同一口径。 */
function clip(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 200 ? `${single.slice(0, 200)}…` : single
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
  opening: (studentId: string, seed?: string) => requestJson(openingPath(studentId, seed)),
  gradeSignals: (studentId: string) => requestJson(gradeSignalsPath(studentId)),
  gradeHistory: (studentId: string) => requestJson(gradeHistoryPath(studentId)),

  quizBank: (request: QuizBankRequest, gradeLevel: string, count: number) =>
    requestJson(quizBankPath(request.kpId, gradeLevel, count)),

  /**
   * 判分（`POST /api/quiz/grade`）。
   *
   * ★★ `studentId` 是**主进程内部多出来的参数**，刻意不放进 `QuizGradeRequest`
   *   （它是渲染进程能看到的类型，加进去等于把身份变成前端可指定 —— 那就成了「读别人的画像」）。
   *   它由调用方（`ipc/handlers-data.ts`）从主进程解析出的当前学生取。
   * ★ 服务端 `QuizGradeRequest.student_id` 是**必填**、且 `CamelModel` 是 `extra="forbid"`：
   *   少了它一律 422 —— 表现是「闯关页整页判分不可用」，掌握度 / 学习历史 / 进度三处**都不写**。
   * ★ 覆盖写：即使调用方手里的 request 带着一个同名的 `studentId`（渲染进程的载荷被原样
   *   转发的场景），被留在 body 里的也是**后写的这个**（主进程解析出的），不是它。
   */
  quizGrade: (request: QuizGradeRequest, studentId: string) =>
    requestJson(QUIZ_GRADE_PATH, { method: 'POST', body: { ...request, studentId } }),
  quizProgress: (studentId: string, request: QuizProgressRequest = {}) =>
    requestJson(quizProgressPath(studentId, request.kpIds)),

  codeTemplate: (request: CodeTemplateRequest) =>
    requestJson(codeTemplatePath(request.kpId, request.gradeLevel)),
  codeHint: (request: CodeHintRequest) =>
    requestJson(codeHintPath(request.kpId, request.level ?? 1)),

  /**
   * 中文报错归一 + 定下一级提示（`POST /api/code/run-hint`）。
   *
   * ★★ 与 {@link dataRequests.quizGrade} 同一个坑：服务端 `CodeRunRequest.student_id`
   *   同样是 **必填**，少了它「报错感知 + 分级求助」整条链路一律 422。
   *   `studentId` 同样**只在主进程内部传**，不进 `CodeRunHintRequest`。
   */
  codeRunHint: (request: CodeRunHintRequest, studentId: string) =>
    requestJson(CODE_RUN_HINT_PATH, { method: 'POST', body: { ...request, studentId } }),

  animationTemplates: (request: AnimationTemplatesRequest = {}) =>
    requestJson(animationTemplatesPath(request)),
  animationRender: (request: AnimationRenderRequest) =>
    requestJson(ANIMATION_RENDER_PATH, { method: 'POST', body: request }),
  animationHost: (studentId: string, request: AnimationHostRequest) =>
    requestJson(animationHostPath(studentId, request.kpId), {
      method: 'POST',
      body: { html: request.html, payloadId: request.payloadId }
    }),

  /* ── 学生动画库（清单 / 取一条 / 存一条 / 删一条）──────────────────────────
   * ★★ 四条都**不接受**渲染进程递来的学生 id（见这些工厂上方的说明）：
   *   id 是包装函数的内部参数，由 `handlers-data.ts` 从主进程解析后传进来。
   * ★ 都是**纯转发**：存库时的 HTML 二次校验、复用键唯一性、覆盖旧文件
   *   全在 Python（`routes/animation_library.py`），这里一个判据都不加。
   * ------------------------------------------------------------------ */

  animationSavedList: (studentId: string, request: AnimationSavedListRequest = {}) =>
    requestJson(animationSavedListPath(studentId, request)),

  quizGeneratedList: (studentId: string, request: QuizGeneratedListRequest = {}) =>
    requestJson(quizGeneratedPath(studentId, request)),

  animationSavedGet: (studentId: string, request: AnimationSavedGetRequest) =>
    requestJson(animationSavedItemPath(studentId, request.savedId)),

  animationSavedSave: (studentId: string, request: AnimationSavedSaveRequest) =>
    requestJson(animationSavedWritePath(studentId), {
      method: 'POST',
      body: {
        kpId: request.kpId,
        gradeLevel: request.gradeLevel,
        concept: request.concept,
        // ★ 只发**摘要**：学生原话一个字都不进库（与「不存对话正文」同一条纪律）
        promptHash: request.promptHash,
        title: request.title,
        durationMs: request.durationMs,
        html: request.html,
        fallbackText: request.fallbackText,
        ...(request.fallbackImage ? { fallbackImage: request.fallbackImage } : {})
      }
    }),

  animationSavedDelete: (studentId: string, request: AnimationSavedDeleteRequest) =>
    requestJson(animationSavedItemPath(studentId, request.savedId), { method: 'DELETE' }),

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
