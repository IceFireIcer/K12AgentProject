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

import { DEFAULT_GRADE_LEVEL } from '../agent/prompts/grade.ts'
import { ipcMain, type WebContents } from 'electron'
import {
  IPC,
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
} from './channels.ts'
import { dataRequests, requestJson } from '../wire/data.ts'
import type { TraceRecordForUi } from '../agent/trace.ts'
import type { TraceEntry, TraceSnapshot } from '../../shared/ipc-events.ts'

/** 题库一次最多取几道（与后端 `GET /api/quiz/bank` 的约束一致）。 */
export const QUIZ_BANK_MAX_COUNT = 10
/** 题库默认取几道。 */
export const QUIZ_BANK_DEFAULT_COUNT = 3
/** 代码提示的级别范围（与 `GET /api/code/hint` 一致）。 */
export const CODE_HINT_MIN_LEVEL = 1
export const CODE_HINT_MAX_LEVEL = 3
/** 导入教材的正文字符上限（与契约 `KnowledgeImportRequest.markdown` 的 max_length 一致）。 */
export const MAX_IMPORT_MARKDOWN_CHARS = 400_000

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
}): void {
  // ★ 本文件里**所有**要用到学生身份的地方都只经这一个取数口（拼 URL 的与塞 body 的都算）：
  //   散开写就会出现「某一条通道忘了注入」——而它的表现是整条链路 422 全哑，不是一句报错。
  const studentId = (): string => options.resolveStudentId()
  const req = options.requests ?? dataRequests

  /* ---------------------------------------------------------------- *
   * 学生身份：读当前学生；**库里没有就建一个**
   *
   * 新装的机器首跑时 `learning.db` 是空的，没有这一条，界面上的昵称、
   * 档案页、推荐都无从谈起。建的学生是「本机唯一的学生」——
   * 与 `resolveActiveStudentId()` 的取值一致（同一台机器一个学生）。
   * ---------------------------------------------------------------- */
  ipcMain.handle(IPC.studentGet, async (): Promise<StudyCallResult> => {
    const wanted = studentId()
    const listed = await requestJson('/api/students')
    if (!listed.ok) return listed
    const students = Array.isArray(listed.data) ? (listed.data as Array<Record<string, unknown>>) : []
    const existing = students.find((item) => item?.studentId === wanted)
    if (existing) return { ok: true, data: existing }

    // 没有就建：昵称用中性默认值（**不采集真实姓名**，§12 数据最小化），
    // 学段给冷启动默认值 —— 它只是起点，之后由服务端推断接管。
    return await requestJson('/api/students', {
      method: 'POST',
      body: { nickname: '同学', gradeLevel: DEFAULT_GRADE_LEVEL }
    })
  })

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
    const gradeLevel = readGradeLevel(options.currentGradeLevel?.()) ?? 'primary_high'
    return await req.quizBank({ kpId }, gradeLevel, count)
  })

  ipcMain.handle(IPC.quizGrade, async (_event, payload: unknown): Promise<StudyCallResult> => {
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
    return await req.quizGrade(
      {
        qid,
        answer,
        ...(typeof request.sessionId === 'string' && request.sessionId
          ? { sessionId: request.sessionId }
          : {})
      },
      studentId()
    )
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

  ipcMain.handle(IPC.knowledgeRebuild, async (): Promise<StudyCallResult> => await req.knowledgeRebuild())
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
