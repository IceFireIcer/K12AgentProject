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
  type KnowledgeImportIpcRequest,
  type KnowledgePointsRequest,
  type QuizBankRequest,
  type QuizGradeRequest,
  type QuizProgressRequest,
  type StudyCallResult
} from './channels.ts'
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
