/**
 * 渲染进程 → 主进程的**数据面桥**（画像 / 闯关 / 编程 / 动画 / 教材知识库 / 轨迹）。
 *
 * ★ 与 `api/events.ts`（6 事件流）的分工：那个是**对话**，这个是**取数与写库**。
 * ★ 与 `api/study.ts`（章节 / 报告 / 错题 / 地图）同一手法：**能力探测 + 薄包装**，
 *   不在这里做任何业务判定 —— 聚合与排序全在 Python（混合后端硬边界）。
 *
 * ★★ 一条贯穿全文件的纪律：**回执从不抛异常，失败也是「一句可读中文」**。
 *   桥缺失（分步接线时的老产物 / 测试替身）时给一句能照着接线的提示，
 *   而不是让界面弹一个 `TypeError: xxx is not a function`。
 */

import type { GradeLevel, TraceSnapshot } from '@shared/ipc-events'
// ★ 相对路径 **type-only** import（编译后完全擦除，运行时不加载主进程代码）：
//   与 `api/study.ts` / `api/grade.ts` 同一手法，守卫 G2/G3 允许。
import type { K12Api } from '../../../preload/index'
import { warnWiring } from './wiring-notice'

/** 新增数据面通道的通用回执（与 `StudyCallResult` 同形）。 */
export type DataCallResult<T = unknown> = { ok: true; data: T } | { ok: false; message: string }

/**
 * 数据面桥不可用时**给学生看的那句话**（会渲染在编程 / 闯关 / 动画 / 记录各页的错误位上）。
 *
 * ★★ 2026-09-22 改口（设计评审报告 0.2 + 双视角 D-063）：原来这里给的是
 *   「本地数据通道未接通：主进程没有提供 window.api.readQuizBank。（分步接线时的老产物，
 *   或测试替身没装全。）」——方法名、`window.api`、「测试替身」全印在学生的屏幕上，
 *   而「分步接线时的老产物」更是把他当成了接线的人。
 *   现在只说他能感知的事：这块打不开、还能回对话页、需要时找老师。
 * ★ 缺哪些方法**不在这里**：它经 `resolveDataBridge` 的 `warnWiring` 进控制台。
 */
export const DATA_BRIDGE_MISSING_HINT = '这部分内容暂时打不开。先回对话页就好，需要时请老师帮忙看看。'

/**
 * 新增数据面桥的能力面。
 *
 * ★ 每个方法都可选：**分步接线**时主进程可能只提供了一部分，
 *   桥据此如实报告「哪个方法缺失」，而不是在调用点上抛。
 */
export interface DataBridge {
  getStudent(): Promise<DataCallResult>
  readProfile(): Promise<DataCallResult>
  readRecommendation(): Promise<DataCallResult>
  readGradeSignals(): Promise<DataCallResult>
  readGradeHistory(): Promise<DataCallResult>

  readQuizBank(payload: { kpId: string; count?: number }): Promise<DataCallResult>
  gradeQuiz(payload: { qid: string; answer: string; sessionId?: string }): Promise<DataCallResult>
  readQuizProgress(payload?: { kpIds?: string[] }): Promise<DataCallResult>

  readCodeTemplate(payload: { kpId: string; gradeLevel?: GradeLevel }): Promise<DataCallResult>
  readCodeHint(payload: { kpId: string; level?: number }): Promise<DataCallResult>
  analyzeCodeRun(payload: {
    kpId: string
    code: string
    language: string
    stdout: string
    stderr: string
    attempt: number
  }): Promise<DataCallResult>

  readAnimationTemplates(payload?: {
    kpId?: string
    gradeLevel?: GradeLevel
  }): Promise<DataCallResult>
  renderAnimation(payload: {
    templateId?: string
    kpId?: string
    gradeLevel?: GradeLevel
    params?: Record<string, unknown>
    fallbackText?: string
    /**
     * 烙进产物的 `payload_id` —— **必须与随后那次 `hostAnimation` 的同一个值**：
     * 产物里带着谁，沙箱就回谁；宿主只认它自己那把 id。对不上 = 每条消息被过滤 =
     * 5 秒超时 + 整段降级（见 `ipc/channels.ts` 的注释）。
     */
    payloadId?: string
  }): Promise<DataCallResult>
  hostAnimation(payload: { kpId: string; html: string; payloadId: string }): Promise<DataCallResult>

  /**
   * 当前学生的动画库清单（**不含 HTML**）。
   * ★ 入参里没有 studentId：身份由主进程决定，渲染进程指定不了。
   */
  readSavedAnimations(payload?: { gradeLevel?: GradeLevel; kpId?: string }): Promise<DataCallResult>
  /**
   * 该学生**自己的**生成题（`GET /api/quiz/generated/{id}`，D-088）。
   *
   * ★ 身份由主进程注入；返回值与题库那条路同形（`QuizPayload`，结构上没有答案）。
   */
  readGeneratedQuestions(payload?: { kpId?: string; limit?: number }): Promise<DataCallResult>
  /** 取库里的一条（**带 HTML**，可交给沙箱播）。 */
  readSavedAnimation(payload: { savedId: string }): Promise<DataCallResult>
  /** 存一条进动画库（`promptHash` 是摘要 —— 学生原话不进库）。 */
  saveAnimationToLibrary(payload: {
    kpId: string
    gradeLevel: GradeLevel
    concept: string
    promptHash: string
    title: string
    durationMs: number
    html: string
    fallbackText: string
    fallbackImage?: string
  }): Promise<DataCallResult>
  /** 删一条（只可能删到自己的）。 */
  deleteSavedAnimation(payload: { savedId: string }): Promise<DataCallResult>
  /**
   * 按需现做一份动画（「在线生成」的**兜底**路径：那一轮开不起来时才用它）。
   * ★ 主进程做完会自己存库，调用方不需要再存一次。
   */
  composeAnimation(payload: {
    kpId?: string
    gradeLevel?: GradeLevel
    concept: string
    request: string
    caption?: string
  }): Promise<DataCallResult>

  readKnowledgeStats(): Promise<DataCallResult>
  readKnowledgePoints(payload?: { gradeLevel?: GradeLevel }): Promise<DataCallResult>
  importKnowledge(payload: {
    fileName: string
    markdown: string
    gradeLevel?: GradeLevel
    rebuild?: boolean
  }): Promise<DataCallResult>
  rebuildKnowledge(): Promise<DataCallResult>

  onTraceChanged(listener: (snapshot: TraceSnapshot) => void): () => void
}

/** 能力探测结果：要么就绪（bridge），要么带一句可读中文（message）。 */
export type DataBridgeLookup = { ready: true; bridge: DataBridge } | { ready: false; message: string }

/**
 * 探测的必需方法（**全都要有**：少一个就说明这套能力没接完，那就不该半可用）。
 *
 * ★ 导出是为了让测试夹具**从这一处派生**，而不是各留一份拷贝：
 *   两个测试文件原先各有一份 hand-maintained 清单，加了 5 个动画库方法之后
 *   两份都忘了跟，于是能力探测判定「桥不齐」→ 39 条测试集体假红。
 *   拷贝必然漂移，所以只留一个真相。
 */
export const REQUIRED_METHODS = [
  'getStudent',
  'readProfile',
  'readRecommendation',
  'readGradeSignals',
  'readGradeHistory',
  'readQuizBank',
  'gradeQuiz',
  'readQuizProgress',
  'readCodeTemplate',
  'readCodeHint',
  'analyzeCodeRun',
  'readAnimationTemplates',
  'renderAnimation',
  'hostAnimation',
  'readSavedAnimations',
  'readSavedAnimation',
  'saveAnimationToLibrary',
  'readGeneratedQuestions',
  'deleteSavedAnimation',
  'composeAnimation',
  'readKnowledgeStats',
  'readKnowledgePoints',
  'importKnowledge',
  'rebuildKnowledge',
  'onTraceChanged'
] as const satisfies readonly (keyof DataBridge)[]

/**
 * 探测 `window.api` 上的数据面能力。
 *
 * ★ 显式构造（**不用双重断言**）：每个方法都当场包一层，函数签名一改 typecheck 就报。
 *   用 `as unknown as` 抹平的话，签名漂移在编译期完全看不见。
 */
export function resolveDataBridge(host: unknown = globalThis.window?.api): DataBridgeLookup {
  if (typeof host !== 'object' || host === null) {
    warnWiring(
      'data',
      'window.api 缺失：preload 没有加载（整块数据面不可用）。检查 preload 入口与 contextIsolation / sandbox 配置。'
    )
    return { ready: false, message: DATA_BRIDGE_MISSING_HINT }
  }
  const api = host as Partial<K12Api>
  // ★★ 一次把**缺的全列出来**（不是遇到第一个就返回）——与 `api/study.ts` / `api/sessions.ts`
  //   同一个手法：接线的人需要的是完整清单，而不是「改一个再来一次」的体验。
  const missing = REQUIRED_METHODS.filter((method) => typeof api[method] !== 'function')
  if (missing.length > 0) {
    warnWiring(
      'data.methods',
      `preload 白名单缺少这 ${missing.length} 个方法：${missing.join(' / ')}。` +
        '需要主进程逐个注册数据面通道（画像 / 闯关 / 编程 / 动画 / 知识库五组），' +
        '再由 preload 白名单暴露同名方法。接线后重启渲染进程即可生效。'
    )
    return { ready: false, message: DATA_BRIDGE_MISSING_HINT }
  }
  return {
    ready: true,
    bridge: {
      getStudent: () => api.getStudent!(),
      readProfile: () => api.readProfile!(),
      readRecommendation: () => api.readRecommendation!(),
      readGradeSignals: () => api.readGradeSignals!(),
      readGradeHistory: () => api.readGradeHistory!(),
      readQuizBank: (payload) => api.readQuizBank!(payload),
      gradeQuiz: (payload) => api.gradeQuiz!(payload),
      readQuizProgress: (payload) => api.readQuizProgress!(payload ?? {}),
      readCodeTemplate: (payload) => api.readCodeTemplate!(payload),
      readCodeHint: (payload) => api.readCodeHint!(payload),
      analyzeCodeRun: (payload) => api.analyzeCodeRun!(payload),
      readAnimationTemplates: (payload) => api.readAnimationTemplates!(payload ?? {}),
      renderAnimation: (payload) => api.renderAnimation!(payload),
      hostAnimation: (payload) => api.hostAnimation!(payload),
      readSavedAnimations: (payload) => api.readSavedAnimations!(payload ?? {}),
      readGeneratedQuestions: (payload) => api.readGeneratedQuestions!(payload ?? {}),
      readSavedAnimation: (payload) => api.readSavedAnimation!(payload),
      saveAnimationToLibrary: (payload) => api.saveAnimationToLibrary!(payload),
      deleteSavedAnimation: (payload) => api.deleteSavedAnimation!(payload),
      composeAnimation: (payload) => api.composeAnimation!(payload),
      readKnowledgeStats: () => api.readKnowledgeStats!(),
      readKnowledgePoints: (payload) => api.readKnowledgePoints!(payload ?? {}),
      importKnowledge: (payload) => api.importKnowledge!(payload),
      rebuildKnowledge: () => api.rebuildKnowledge!(),
      onTraceChanged: (listener) => api.onTraceChanged!(listener)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 生成物类型的便捷别名（避免每个消费方都写一遍 components['schemas'][…]）
 * ------------------------------------------------------------------ */

type Schemas = import('@shared/api-types').components['schemas']

/** 一名学生（昵称 / 学段 / 当前章节）。 */
export type StudentView = Schemas['Student']
/** 画像（掌握度 + 偏好 + 推荐点）。 */
export type ProfileView = Schemas['StudentProfile']
/** 推荐下一步。 */
export type RecommendationView = Schemas['RecommendationResponse']
/** 学段信号。 */
export type GradeSignalsView = Schemas['GradeSignals']
/** 学段轨迹。 */
export type GradeHistoryView = Schemas['GradeHistoryResponse']
/** 题库载荷（**不含标准答案**）。 */
export type QuizBankView = Schemas['QuizPayload']
/** 判分结果。 */
export type QuizResultView = Schemas['QuizResult']
/** 代码脚手架（**没有 solution**）。 */
export type CodeTemplateView = Schemas['CodeTemplate']
/** 一级代码提示。 */
export type CodingHintView = Schemas['CodingHint']
/** 代码评估（跑完之后的反馈 + 下一级提示）。 */
export type CodeEvaluationView = Schemas['CodeEvaluation']
/** 动画载荷。 */
export type AnimationPayloadView = Schemas['AnimationPayload']
/** 动画库里的一条（**不含 html**；清单与保存回执都用它）。 */
export type AnimationSavedItemView = Schemas['AnimationSavedItem']
/** 动画库清单（`gradeLevel` / `kpId` 回显本次的过滤条件）。 */
export type AnimationSavedListView = Schemas['AnimationSavedListResponse']
/** 库里的一条**带 html**（可以交给沙箱播的那一份）。 */
export type AnimationSavedView = Schemas['AnimationSavedView']
/** 知识库体检数字。 */
export type KnowledgeStatsView = Schemas['KnowledgeStats']
/** 知识点清单。 */
export type KnowledgePointsView = Schemas['KnowledgePointListResponse']
/** 导入回执。 */
export type KnowledgeImportView = Schemas['KnowledgeImportResponse']
/** 重建回执。 */
export type KnowledgeRebuildView = Schemas['KnowledgeRebuildResponse']

/* ------------------------------------------------------------------ *
 * ★★ 下面三个**没有生成物**，因此只能手写 —— 这是有意的例外，理由都写在各自注释里。
 *
 * 判据：`api-types.ts` 是「pydantic → OpenAPI → TS」的产物；**没进 OpenAPI 的端点
 * 就没有生成类型**。这三个端点分别因为「返回纯 dict」与「include_in_schema=False」
 * 而缺席。手写它们**不违反**「契约唯一来源」—— 因为它们在 Python 侧本来就
 * 没有 pydantic 模型（那边的真源是 `JSONResponse` 的字面量 dict）。
 * 一旦某个端点在 Python 侧改成 pydantic 模型，这三行就该立刻换成生成类型。
 * ------------------------------------------------------------------ */

/**
 * 闯关进度（`GET /api/quiz/progress/{id}`）。
 *
 * ★ 手写的理由：该端点返回的是 `routes/quiz.py` 里手拼的 dict（`read_progress` 的
 *   `return {...}`），**没有 pydantic 模型**，所以它不在 OpenAPI 里。
 * ★ 字段按 `progress_snapshot()` 的真实产出对齐：`stage` / `badge` / `mastery`
 *   原样来自 `learning.db`（前端只读，不自持状态机）。
 */
export interface QuizProgressView {
  studentId: string
  gradeLevel: import('@shared/ipc-events').GradeLevel
  /** 本次是否是该学生的**冷启动**（首次读进度时服务端按依赖图播种了默认路径）。 */
  seeded: boolean
  levels: Array<{
    kpId: string
    stage: 'locked' | 'learning' | 'quizzed' | 'mastered'
    /** 徽章名（服务端给的展示名）；没有则 `null`。 */
    badge: string | null
    /** 该关的掌握度 0–1。 */
    mastery: number
  }>
}

/**
 * 动画模板清单（`GET /api/animation/templates`）。
 *
 * ★ 手写的理由：该端点是 `include_in_schema=False` 的**内部端点**
 *   （只给主进程转发用，不对外暴露），所以不在 OpenAPI 里。
 */
export interface AnimationTemplatesView {
  /** 本机共有多少份模板。 */
  total: number
  /** 与本次查询（kpId / gradeLevel）匹配上的模板（含参数定义）。 */
  matched: Array<{
    id: string
    label: string
    title: string
    concept: string
    kpIds: string[]
    gradeLevels: string[]
    durationMs: number
    params: Array<{ name: string; type: string; default: unknown; description: string }>
    fallbackText: string
    hasFallbackImage: boolean
  }>
  /** 全部可用模板的 id（用于「为什么我想要的没匹配上」这种排查）。 */
  available: string[]
}

/**
 * 动画托管回执（`POST /api/animation/host/{student_id}/{kp_id}`）。
 *
 * ★ 手写的理由：同上是内部端点（`include_in_schema=False`）。
 * ★ `url` 带**一次性 nonce** —— iframe 带不了自定义 header，所以资源地址
 *   不能用 token 鉴权；nonce 绑定「学生 + 知识点 + 有效期」，用一次即失效。
 */
export interface AnimationHostView {
  /** 可交给 iframe 的一次性地址（含 nonce + payloadId）。 */
  url: string
  /** 资源路径（不含 origin）。 */
  path: string
  /** 这一份动画的防串台标识（沙箱 postMessage 靠它配对）。 */
  payloadId: string
  filename: string
  expiresInMs: number
  singleUse: boolean
}
