/**
 * ★ IPC 通道名的**唯一来源**：主进程（`ipcMain`）与 preload（`ipcRenderer`）都从这里 import。
 * 不要在 handlers / preload / renderer 里手写通道字符串——那会让白名单与处理器悄悄对不上。
 *
 * 这里同时放**跨边界的请求/回执类型**（`ChatSendRequest` / `ChatSendResult` /
 * `SettingsCallResult`），让 preload 只 import 一个模块就能拿到完整的 IPC 边界定义。
 *
 * ⚠️ 6 个**事件**的名字与载荷类型**不在这里**——它们是契约，在 `src/shared/ipc-events.ts`。
 *    一个通道（`chatEvent`）承载全部 6 种事件，靠 `event.name` 区分（见 `shared/ipc-events.ts`）。
 *
 * 架构守卫（`tests/architecture-guards.test.ts`）会扫描 `desktop/src/**`，
 * 断言下面这些字面量只在本文件出现。
 */

import type { components } from '@shared/api-types'
import type { GradeLevel } from '@shared/ipc-events'

/**
 * 设置域的三个契约类型：**全部来自 `@shared/api-types`（pydantic → OpenAPI → TS 生成物）**，
 * 这里一个字段都不手写 —— 改了 `server/app/contracts.py` 会在 `npm run typecheck` 当场报出来。
 */
export type SettingsSnapshot = components['schemas']['SettingsResponse']
export type SettingsUpdateRequest = components['schemas']['SettingsUpdateRequest']
export type ProbeRequest = components['schemas']['ProbeRequest']
export type ProbeResult = components['schemas']['ProbeResult']

/**
 * 设置域三条 invoke 通道的回执形态（渲染进程侧的镜像定义在 `renderer/src/api/settings.ts`）。
 *
 * ★ 判别联合，**失败也带一句可读中文**：处理器绝不抛异常穿过 IPC（那会变成界面上的堆栈文本），
 *   与 `ChatSendResult` 同一条纪律（见 `src/main/ipc/chat-request.ts` 的注释）。
 */
export type SettingsCallResult<T> = { ok: true; data: T } | { ok: false; message: string }

export const IPC = {
  /** 渲染进程 → 主进程：读当前 sidecar 状态（`ipcMain.handle` / `ipcRenderer.invoke`）。 */
  sidecarGetInfo: 'sidecar:get-info',
  /** 主进程 → 渲染进程：sidecar 状态变化推送（`webContents.send`）。 */
  sidecarChanged: 'sidecar:changed',
  /** 渲染进程 → 主进程：发一轮对话，立刻拿到本轮的 `requestId`。 */
  chatSend: 'chat:send',
  /** 主进程 → 渲染进程：本轮对话的 6 事件流。 */
  chatEvent: 'chat:event',
  /** 渲染进程 → 主进程：读设置（`GET /api/settings`，Key 只回掩码）。 */
  settingsRead: 'settings:read',
  /** 渲染进程 → 主进程：保存设置（`PUT /api/settings`，原子写 config.json）。 */
  settingsSave: 'settings:save',
  /** 渲染进程 → 主进程：真实连通性探测（`POST /api/settings/probe`，不落库、不改配置）。 */
  settingsProbe: 'settings:probe',
  /**
   * 渲染进程 → 主进程：**Pi 内置供应商预设**（离线可用的端点 + 模型清单）。
   *
   * 数据源是 Pi 自己的目录（40 个 provider，含 baseUrl 与模型），所以设置页
   * 不用手输端点地址 —— 选中一个预设就把端点与候选模型带出来。
   * ★ 必须经主进程：只有主进程能加载 Pi（渲染进程没有 Node 能力，守卫 G2 拦着）。
   */
  settingsProviderCatalog: 'settings:provider-catalog',
  /**
   * 渲染进程 → 主进程：**拉取某个地址可见的模型清单**。
   *
   * 主进程做两件事：① 经 sidecar 的 `POST /api/settings/models` 真实外呼拿实时清单；
   * ② 与 Pi 内置预设合并去重。即使 ① 失败（断网 / 该服务没有 `/models`），
   * ② 的预设清单照样返回 —— 界面永远有候选可选。
   */
  settingsFetchModels: 'settings:fetch-models',
  /** 渲染进程 → 主进程：读**当前学段**（指示器展示用）。 */
  gradeGet: 'grade:get',
  /**
   * 渲染进程 → 主进程：**学生手动设定学段**（写入的唯一入口）。
   *
   * ★ 学段的手动写入**只走这条独立通道，绝不混进对话请求** ——
   *   `ChatSendRequest` 依旧只有 `text`（架构守卫 G6c 钉着这一点）。
   *   混进去的话，「这一轮按哪个学段作答」会跟着每一轮对话漂移，而清空输入框、
   *   重发同一句话都会再写一次学段（写入变成了聊天的副作用，不再是显式动作）。
   * ★ 它是 invoke（有回执）：学生要看到「改没改成、冷却还剩几轮」，推送通道给不了这个回执。
   */
  gradeSet: 'grade:set',
  /** 主进程 → 渲染进程：推断出的学段发生变化时推送（指示器据此更新）。 */
  gradeChanged: 'grade:changed',
  /** 渲染进程 → 主进程：读**当前教材章节**（指示器 / 设置页展示用）。 */
  chapterGet: 'chapter:get',
  /**
   * 渲染进程 → 主进程：**学生手动选定当前教材章节**（写入的唯一入口）。
   *
   * ★ 与 `grade:set` 完全对称：**不混进 `ChatSendRequest`**（那个请求只有 `text`，
   *   守卫 G6c 钉着）。章节是学生的显式选择，不该变成「发一条消息」的副作用。
   * ★ 它是 invoke（有回执）：学生要看到「选没选上」，推送通道给不了这个。
   */
  chapterSet: 'chapter:set',
  /** 主进程 → 渲染进程：当前章节发生变化时推送（指示器据此更新）。 */
  chapterChanged: 'chapter:changed',
  /**
   * 主进程 → 渲染进程：**把学生代码下发到渲染进程执行**（票 18 的硬约束）。
   * ★ 主进程**绝不执行学生代码** —— Pi 的 Extension 与 UI 同进程且拥有完整系统权限，
   *   代码只能在渲染进程的 Pyodide Worker 里跑。这条通道就是那座桥。
   */
  codeExecute: 'code:execute',
  /** 渲染进程 → 主进程：回传执行结果（按 requestId 与下发配对）。 */
  codeResult: 'code:result',

  // ── 学习档案（章节 / 报告 / 错题本 / 学习地图）─────────────────────────
  //
  // ★ 这四条都是**纯转发**：主进程把请求发给 sidecar，把 JSON 原样回给渲染进程。
  //   聚合、排序、学段过滤、连续天数**全部在 Python 侧**（混合后端的硬边界：
  //   数据域只在 Python；TS 不读 SQLite、不自己算这些）。
  // ★ 四条都是 invoke（有回执），**不要**登记进 `PUSH_CHANNELS`。
  // ★ 渲染进程不直连 sidecar（守卫 G3）：token 与地址全留在主进程。
  /** 渲染进程 → 主进程：学习报告（`GET /api/profile/{id}/report?days=N`）。 */
  studyReport: 'study:report',
  /** 渲染进程 → 主进程：错题本（`GET /api/quiz/mistakes/{id}`）。 */
  studyMistakes: 'study:mistakes',
  /** 渲染进程 → 主进程：某学段章节清单（`GET /api/knowledge/chapters/{grade}`）。 */
  studyChapters: 'study:chapters',
  /** 渲染进程 → 主进程：某学段依赖图全览（`GET /api/graph/overview/{grade}`）。 */
  studyGraph: 'study:graph',

  // ── 历史会话（只读回看；`sessions.ts` 有「只接受 id」的安全约束说明）──
  /** 渲染进程 → 主进程：列出当前学生的历史会话（读 Pi 的 sessionDir）。 */
  sessionList: 'session:list',
  /** 渲染进程 → 主进程：按 id 读一条会话的正文（**绝不接受路径**）。 */
  sessionTranscript: 'session:transcript',
  /** 渲染进程 → 主进程：在历史会话里搜索（命中标题或全文，返回片段）。 */
  sessionSearch: 'session:search',

  // ── 导出 ──────────────────────────────────────────────────────────────
  /**
   * 渲染进程 → 主进程：把一段 Markdown 存成文件（报告 / 错题本导出）。
   *
   * ★ **只回文件名，不回完整路径** —— 宿主目录结构不进渲染进程。
   * ★ 文件名由主进程清理（去掉分隔符与 `..`、限长、强制 `.md`）。
   * ★ 它是 invoke（有回执，学生可能取消保存）；**不**登记进 `PUSH_CHANNELS`。
   */
  fileExport: 'file:export',

  // ── 窗口控制（无边框窗口的页面内按钮）─────────────────────────────────
  //
  // ★★ 为什么需要这一组：窗口是 `frame: false`（没有系统标题栏），
  //   最小化 / 最大化 / 关闭只能由页面自己画。渲染进程没有 Node 能力，
  //   所以必须经 IPC 要 —— 这也是「渲染进程不直连系统能力」那条约束的落点。
  // ★ 三条都是 invoke（有回执不需要，但**失败要能看见**：窗口已销毁时不能静默什么都不发生）。
  // ★ 它们**不接受任何参数**：作用对象由主进程从 `event.sender` 反查窗口 ——
  //   渲染进程指不了「操作哪个窗口」，也就不会误伤别的窗口。
  /** 渲染进程 → 主进程：最小化本窗口。 */
  windowMinimize: 'window:minimize',
  /** 渲染进程 → 主进程：在最大化与还原之间切换。 */
  windowToggleMaximize: 'window:toggle-maximize',
  /** 渲染进程 → 主进程：关闭本窗口（与点系统关闭按钮等价，走同一套退出流程）。 */
  windowClose: 'window:close',
  /**
   * 主进程 → 渲染进程：**最大化状态变化**（按钮图标据此在「最大化/还原」之间换）。
   * ★ 必须推送而不是让渲染进程自己算：双击拖拽区、Win+↑/↓、拖到屏幕上边缘、
   *   系统菜单 —— 这些都会改变状态，而渲染进程一个都观察不到。
   */
  windowMaximizedChanged: 'window:maximized-changed',

  // ── 工具调用轨迹（主进程 → 渲染进程的推送）────────────────────────────
  /**
   * 主进程 → 渲染进程：**本轮 Tool 调用轨迹快照**（右栏「工具调用轨迹」）。
   *
   * ★ 它不是 6 事件之一（见 `shared/ipc-events.ts` 的说明）：轨迹是工程证据，
   *   与对话状态机不是一回事。混进词表会让每个消费方都被迫理解它。
   * ★ 推送**快照**而不是增量：一轮只有几个 Tool，全量替换省掉一整套恢复协议。
   */
  traceChanged: 'trace:changed',

  // ── 学生身份 ──────────────────────────────────────────────────────────
  /**
   * 渲染进程 → 主进程：读**当前学生**（昵称 / 学段 / 当前章节）。
   *
   * ★ 学生 id 由**主进程**决定（`resolveActiveStudentId`），渲染进程递不了、也改不了 ——
   *   一旦它成为前端可填的参数，「读别人的画像」就只是改一个字符串的事。
   * ★ 副作用：库里一个学生都没有时**建一个**（新装的机器首跑就是这种情况）。
   */
  studentGet: 'student:get',

  // ── 画像与推荐 ────────────────────────────────────────────────────────
  /** 渲染进程 → 主进程：读画像（`GET /api/profile/{id}`：掌握度 + 偏好 + 推荐点）。 */
  profileRead: 'profile:read',
  /** 渲染进程 → 主进程：读推荐下一步（`GET /api/profile/{id}/recommendation`）。 */
  profileRecommendation: 'profile:recommendation',
  /** 渲染进程 → 主进程：读学段信号（`GET /api/grade/signals/{id}`；右栏与档案页的判据展示）。 */
  gradeSignals: 'grade:signals',
  /** 渲染进程 → 主进程：读学段变化轨迹（`GET /api/grade/history/{id}`）。 */
  gradeHistory: 'grade:history',

  // ── 闯关（独立页面用；对话内的题卡仍走 chat 路径）─────────────────────
  /**
   * 渲染进程 → 主进程：取某知识点的题库题目（`GET /api/quiz/bank/{kp_id}`）。
   * ★ 回来的载荷**不含标准答案**（`QuizQuestionOut`，答案只留 Python 侧）。
   */
  quizBank: 'quiz:bank',
  /**
   * 渲染进程 → 主进程：提交一题作答并判分（`POST /api/quiz/grade`）。
   * ★ 判分**只在后端**：这里回来的 `correct` / `feedback` / `masteryDelta` 是权威结论。
   */
  quizGrade: 'quiz:grade',
  /** 渲染进程 → 主进程：读闯关进度（`GET /api/quiz/progress/{id}`：每关的阶段与分数）。 */
  quizProgress: 'quiz:progress',

  // ── 编程 ──────────────────────────────────────────────────────────────
  /**
   * 渲染进程 → 主进程：取代码脚手架（`GET /api/code/templates/{kp_id}`）。
   * ★ 载荷里**没有 `solution`**（结构上就不存在，§13 的答案防泄漏）。
   */
  codeTemplate: 'code:template',
  /** 渲染进程 → 主进程：取一级提示（`GET /api/code/hint/{kp_id}?level=N`，逐级要）。 */
  codeHint: 'code:hint',
  /**
   * 渲染进程 → 主进程：把**已经跑完**的代码与输出交给后端做中文报错归一 + 定下一级提示
   * （`POST /api/code/run-hint`）。
   * ★ ★ **后端绝不执行代码**：代码已经在渲染进程的 Pyodide Worker 里跑完了
   *   （主进程也不许跑 —— 见 `codeExecute` 的注释）。这条通道只送「跑完的结果」。
   */
  codeRunHint: 'code:run-hint',

  // ── 动画 ──────────────────────────────────────────────────────────────
  /** 渲染进程 → 主进程：列出动画模板（`GET /api/animation/templates`，内网端点不进 OpenAPI）。 */
  animationTemplates: 'animation:templates',
  /** 渲染进程 → 主进程：按模板渲染一个自包含沙箱 HTML（`POST /api/animation/render`）。 */
  animationRender: 'animation:render',
  /**
   * 渲染进程 → 主进程：把渲染好的 HTML 托管成**一次性 nonce 地址**
   * （`POST /api/animation/host/{student_id}/{kp_id}`）。
   * ★ iframe 带不了自定义 header，所以这条资源地址不能用 token 鉴权 —— 用一次性 nonce。
   */
  animationHost: 'animation:host',

  // ── 教材知识库（数据层检视页）─────────────────────────────────────────
  /** 渲染进程 → 主进程：知识库体检数字（`GET /api/knowledge/stats`）。 */
  knowledgeStats: 'knowledge:stats',
  /** 渲染进程 → 主进程：知识点清单（`GET /api/knowledge/points`，可按学段过滤）。 */
  knowledgePoints: 'knowledge:points',
  /**
   * 渲染进程 → 主进程：导入一份教材 Markdown（`POST /api/knowledge/import`）。
   *
   * ★ 正文走 **JSON body**（渲染进程已用 `file.text()` 读到），不是 multipart ——
   *   为此给 sidecar 加一个上传依赖不值得。
   * ★ 校验失败回 `{ok:true, data:{ok:false, problems:[…]}}`：那是**内容**问题，
   *   界面要在同一张卡片里逐条列出，不是「请求非法」。
   */
  knowledgeImport: 'knowledge:import',
  /**
   * 渲染进程 → 主进程：重建索引（`POST /api/knowledge/rebuild`）。
   * ★ 重活（分块 + 嵌入整份教材，秒级到十几秒）→ **必须用长超时**，
   *   否则会撞上 `bridge/client.ts` 的 8s 默认兜底，把一次成功的重建报成超时。
   */
  knowledgeRebuild: 'knowledge:rebuild'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * 设置页「预设 / 拉取模型」两个通道的载荷类型。
 *
 * ★ 形状定义在 `src/shared/provider-catalog.ts`（渲染进程也要用，而它不该 import 主进程模块）。
 * 这里只 re-export，让 `channels.ts` 仍然是「IPC 边界类型」的单一入口。
 */
export type { FetchModelsResult, ProviderCatalogEntry } from '@shared/provider-catalog'

/**
 * 主进程 → 渲染进程的**单向推送**通道。
 * 守卫据此断言事件流走的是推送通道（不是拿 invoke 回执当流用）。
 *
 * ⚠️ 设置域三条、`gradeGet` / `gradeSet` / `chapterGet` / `chapterSet` 都是 invoke（有回执），
 * **不要**登记到这里。
 */
export const PUSH_CHANNELS: readonly IpcChannel[] = [
  IPC.sidecarChanged,
  IPC.chatEvent,
  IPC.gradeChanged,
  IPC.chapterChanged,
  IPC.codeExecute,
  IPC.traceChanged,
  IPC.windowMaximizedChanged
]

/**
 * 学段来源（三态）：
 *   - `inferred` = 系统判定过（推断引擎写过库，或已经攒够信号判出结论）；
 *   - `explicit` = 学生手动选择（显式设定，`grade:set` 那条通道写进去的）；
 *   - `default`  = 冷启动默认值 —— 还没判出来、也没人选过。
 */
export type GradeOrigin = 'inferred' | 'explicit' | 'default'

/**
 * 学段状态（展示用）。
 *
 * ★ 学段的**写入只有一条**：`grade:set` 这条独立通道（学生显式设定）。
 *   **绝不混进 `ChatSendRequest`** —— 那个请求的字段集合被守卫 G6c 钉死为 `['text']`，
 *   一旦塞进 `gradeLevel`，「每轮对话」就成了「每轮改学段」的副作用。
 * ★ 宁可显示「待判定」也不要拿冷启动默认值冒充系统判定结果 —— 那是在骗演示。
 * ★ `source` 是后端 `GradeStateOut.source`（那次写入的**来源**，例如 `inferred` / `explicit`）的透传，
 *   它同时决定 `origin`（见 `ipc/handlers.ts` 的 `readGradeState`）：来源以**服务端为准**，
 *   前端不能自己猜 —— 猜出来的后果是「学生手动选的」被显示成「AI 推的」。
 * ★ 它替代了历史上那个恒为 null 的 `reason` —— 后端回执里根本没有
 *   `reason` 字段（`reason` 只出现在 `/api/grade/turns` 的响应里），旧字段是死字段。
 *   渲染进程那边有自己的 `GradeState` 副本（`renderer/src/api/grade.ts`），
 *   它按「未知字段忽略」处理，因此这里改名不会影响界面。
 */
export interface GradeState {
  gradeLevel: GradeLevel
  origin: GradeOrigin
  /** 后端 `GradeStateOut.source`（写入来源，如 `inferred` / `explicit`）；取不到时为 `null`。 */
  source?: string | null
}

/** 学段读取的回执（与 `SettingsCallResult` 同形，便于前端统一处理）。 */
export type GradeCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string }

/** 手动设定学段的回执（`cooldownRemainingTurns` = 手动冷却还剩几轮）。 */
export interface GradeSetResult {
  changed: boolean
  cooldownRemainingTurns: number
}

/**
 * 当前教材章节（展示 / 读回用），与 {@link GradeState} 并列。
 *
 * ★ **章节是软偏好**：它进每轮 System Prompt（让回答与检索优先围绕本章），
 *   但**不进检索契约、不做 SQL 硬过滤** —— 学生问别的章节照常回答。
 * ★ `chapterTitle` 的语义：**空串 = 未选择章节**（不是 `null`）——
 *   前端不用为「空」处理两种值；「不限章节（自由问答）」就是空串。
 * ★ **与学段相互独立**，但学段一变服务端会**清空章节**（那本教材不存在了），
 *   所以渲染进程在学段变化后要重新读一次（不要自己猜成空串）。
 */
export interface ChapterState {
  gradeLevel: GradeLevel
  chapterTitle: string
}

/** 章节读取的回执（与 {@link GradeCallResult} 同形，便于前端统一处理）。 */
export type ChapterCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string }

/** 手动设定章节的回执（回的是**生效后的**章标题；空串 = 已清除）。 */
export interface ChapterSetResult {
  chapterTitle: string
}

/** 一轮对话的入参。 */
export interface ChatSendRequest {
  /** 学生输入（主进程会再次校验非空，不信任渲染进程）。 */
  text: string
}

/**
 * 一轮对话的回执。
 *
 * ★ 结构里**没有 token、没有任何 HTTP 细节**：渲染进程只需要「本轮请求号」。
 * ★ 入参不合法时返回 `ok: false`（而不是抛异常穿过 IPC 变成一堆栈文本）。
 */
export type ChatSendResult =
  | { ok: true; requestId: string; message: null }
  | { ok: false; requestId: null; message: string }

/** 下发到渲染进程执行的学生代码（票 18）。 */
export interface CodeExecuteRequest {
  /** 与执行结果配对（桥生成，渲染进程必须原样带回）。 */
  requestId: string
  code: string
  /** 执行超时；超时必须**中断**（Pyodide setInterruptBuffer），不是干等。 */
  timeoutMs?: number
  /** 发起这次执行的 Tool 调用号（轨迹与求助计数用）。 */
  toolCallId?: string
}

/** 渲染进程回传的执行结果。 */
export interface CodeExecuteResult {
  requestId: string
  stdout: string
  stderr: string
  /** 是否被超时中断（`while True: pass` 必须走这条，而不是把界面卡死）。 */
  interrupted: boolean
  elapsedMs: number
  /** 执行器自身的失败说明（如 Worker 没起来）；学生代码的报错走 stderr。 */
  failure?: string
}

/* ------------------------------------------------------------------ *
 * 学习档案：跨 IPC 的请求 / 回执类型
 * ------------------------------------------------------------------ */

/**
 * 学习档案四条通道的通用回执（与 `SettingsCallResult` 同形）。
 *
 * ⚠️ `data` 是 `unknown` 而**不是**具体契约类型，这是刻意的：
 *    这些端点的字段全部由 pydantic 生成类型定义（`@shared/api-types`），
 *    主进程只是**搬运工**。在这里再写一遍 TS 接口等于把契约抄第二份 ——
 *    渲染进程按生成类型消费（它有 `npm run typecheck` 兜着），
 *    主进程这边多写一份只会漂移。
 */
export type StudyCallResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string }

/** 章节 / 依赖图全览的入参（按学段查；带 `studentId` 就补该学生的进度）。 */
export interface StudyGradeRequest {
  gradeLevel: GradeLevel
  /** 可选：带上就把「已掌握」标注进来（读该学生自己的 `learning.db`）。 */
  studentId?: string
}

/** 学习报告的入参。 */
export interface StudyReportRequest {
  /** 时间窗天数；省略即 7 天（服务端有默认，这里显式给一个便于界面回显）。 */
  days?: number
}

/** 历史会话搜索的入参。 */
export interface SessionSearchRequest {
  query: string
}

/**
 * 导出的入参。
 *
 * ★ `content` 是**已经拼好的 Markdown 文本**：拼装发生在渲染进程
 *   （它手里有报告/错题本的数据），主进程只负责「问路径 + 写盘」。
 */
export interface FileExportRequest {
  /** 建议的文件名（主进程会清理：去分隔符与 `..`、限长、强制 `.md`）。 */
  fileName: string
  content: string
}

/** 导出的回执：**只有文件名**（完整路径不进渲染进程）。 */
export type FileExportResult =
  | { ok: true; fileName: string }
  | { ok: false; message: string; canceled?: boolean }

/**
 * 单个会话文件的大小上限（导出/回看时的保护；超限直接拒绝而不是读进内存）。
 *
 * 1 MiB 对一个学生的单次会话足够宽松（实测一个 4 轮的会话约 4 KB）。
 */
export const MAX_EXPORT_BYTES = 1_048_576

/** 导出内容的字符上限（防止渲染进程递一个巨大字符串把主进程写爆）。 */
export const MAX_EXPORT_CHARS = 200_000

/* ------------------------------------------------------------------ *
 * 闯关 / 编程 / 动画 / 教材知识库：跨 IPC 的请求类型
 *
 * ★ 回执一律复用上面的 `StudyCallResult` 形态（`{ok:true,data} | {ok:false,message}`）：
 *   新增一类 `XxxCallResult` 只是同一形状改名，消费方却要跟着多写一个分支。
 *   数据形状全部来自 `@shared/api-types`（生成物），主进程只当搬运工。
 * ------------------------------------------------------------------ */

/**
 * 取题库的入参。
 *
 * ★ 学段**不在这里**：它由主进程从当前会话取（与 `rag_search` 的学段同一条纪律）——
 *   前端如果能指定学段，就等于绕开了「只取不高于学生学段的内容」这条隔离。
 */
export interface QuizBankRequest {
  kpId: string
  /** 要几道题（1–10，与 `GET /api/quiz/bank` 的约束一致）。 */
  count?: number
}

/** 提交一题作答。 */
export interface QuizGradeRequest {
  /** 题目 id（来自题库载荷）。 */
  qid: string
  /** 学生的作答（选择题是选项文本，填空题是填写内容）。 */
  answer: string
  /** 可选：会话 id（学习记录关联用）。 */
  sessionId?: string
}

/** 读闯关进度（可选只查某几个知识点）。 */
export interface QuizProgressRequest {
  kpIds?: string[]
}

/** 取代码脚手架 / 提示。 */
export interface CodeTemplateRequest {
  kpId: string
  /** 可选：按学段过滤兼容性（不带即不过滤）。 */
  gradeLevel?: GradeLevel
}

export interface CodeHintRequest {
  kpId: string
  /** 提示级别 1–3（1 = 方向，3 = 接近脚手架）。 */
  level?: number
}

/**
 * 把**已经跑完**的代码与输出交给后端分析（`POST /api/code/run-hint`）。
 *
 * ★★ `code` 是**已经执行过**的文本，这条通道**不触发任何执行** ——
 *   学生代码只在渲染进程的 Pyodide Worker 里跑（架构硬约束，有守卫测试）。
 *   主进程把它转发给 sidecar，只为拿「中文报错 + 下一级提示」。
 */
export interface CodeRunHintRequest {
  kpId: string
  code: string
  language: string
  stdout: string
  stderr: string
  attempt: number
}

/** 动画模板列表的入参（都可选：不带就列全部）。 */
export interface AnimationTemplatesRequest {
  kpId?: string
  gradeLevel?: GradeLevel
}

/** 按模板渲染动画的入参。 */
export interface AnimationRenderRequest {
  templateId?: string
  kpId?: string
  gradeLevel?: GradeLevel
  params?: Record<string, unknown>
  fallbackText?: string
}

/**
 * 把渲染好的 HTML 托管成一次性 nonce 地址的入参。
 *
 * ★ `payloadId` 由**渲染进程**生成并回传：沙箱 iframe 的 `postMessage` 用它防串台
 *   （多张动画卡同时在页面上时，消息必须能对上号）。
 */
export interface AnimationHostRequest {
  kpId: string
  html: string
  payloadId: string
}

/** 导入教材的入参（正文走 JSON，不是 multipart —— 见通道注释）。 */
export interface KnowledgeImportIpcRequest {
  fileName: string
  markdown: string
  gradeLevel?: GradeLevel
  /** 导入后是否立刻重建索引（默认 true）。 */
  rebuild?: boolean
}

/** 教材导入 / 重建的**长超时**（重建要跑整份教材的嵌入）。 */
export const KNOWLEDGE_LONG_TASK_TIMEOUT_MS = 180_000

/** 教材清单的入参。 */
export interface KnowledgePointsRequest {
  gradeLevel?: GradeLevel
}
