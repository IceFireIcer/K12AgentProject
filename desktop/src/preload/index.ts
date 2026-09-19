/**
 * preload 白名单：渲染进程能看到的**全部**主进程能力，就这一个 `window.api`。
 *
 * 纪律：
 *   - 不暴露通用 `ipcRenderer` / `ipcRenderer.invoke` / `ipcRenderer.send` / `ipcRenderer.on`；
 *     每加一个能力都必须在这里显式加一个方法（通道名来自 `src/main/ipc/channels.ts`，唯一来源）。
 *   - 不暴露 sidecar token、不暴露任何 sidecar HTTP 能力（token 只在主进程内存里）。
 *   - 回调**只交载荷**：`IpcRendererEvent`（带 `sender` 等内部对象）绝不漏给渲染进程。
 *   - 6 事件流只转发**冻结词表内**的事件名，脏数据在边界上就被丢掉。
 *
 * ★ 类型名与 `src/preload/index.d.ts` 保持一致（`K12Api`）。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AnimationHostRequest,
  type AnimationRenderRequest,
  type AnimationTemplatesRequest,
  type ChapterCallResult,
  type ChapterSetResult,
  type ChapterState,
  type ChatSendRequest,
  type ChatSendResult,
  type CodeExecuteRequest,
  type CodeExecuteResult,
  type CodeHintRequest,
  type CodeRunHintRequest,
  type CodeTemplateRequest,
  type FetchModelsResult,
  type FileExportRequest,
  type FileExportResult,
  type GradeCallResult,
  type GradeSetResult,
  type GradeState,
  type IpcChannel,
  type KnowledgeImportIpcRequest,
  type KnowledgePointsRequest,
  type ProbeRequest,
  type ProbeResult,
  type ProviderCatalogEntry,
  type QuizBankRequest,
  type QuizGradeRequest,
  type QuizProgressRequest,
  type SessionBranchRequest,
  type SessionBranchResult,
  type SessionCurrent,
  type SessionOpenResult,
  type SessionStateResult,
  type SessionSearchRequest,
  type SettingsCallResult,
  type SettingsSnapshot,
  type SettingsUpdateRequest,
  type StudyCallResult,
  type StudyGradeRequest,
  type StudyReportRequest
} from '../main/ipc/channels'
import type { SidecarState } from '../main/sidecar/protocol'
import type { GradeLevel, TraceSnapshot } from '../shared/ipc-events'
import { IPC_EVENT_NAMES, type IpcEvent } from '../shared/ipc-events'

/**
 * 「本轮条目 id」的载荷（`turn:entries`）。
 *
 * ★ 空串 = 那一侧没有条目（本轮失败 / 取不到）：界面据此**不给**对应的分叉按钮，
 *   而不是拿一个 `undefined` 去问 Pi。
 */
export interface TurnEntries {
  /** 本轮的请求号（与 `chat:send` 的回执配对）。 */
  requestId: string
  /** 学生那句话的条目 id（空串 = 无）。 */
  userEntryId: string
  /** 助手那条回答的条目 id（空串 = 无）。 */
  entryId: string
}

export interface K12Api {
  /** 读当前 sidecar 状态（不含 token）。 */
  getSidecarInfo(): Promise<SidecarState>
  /** 订阅 sidecar 状态变化，返回取消订阅函数。 */
  onSidecarChanged(listener: (state: SidecarState) => void): () => void
  /** 发一轮对话：立刻拿到本轮 `requestId`，事件随后经 `onChatEvent` 推来。 */
  sendChat(request: ChatSendRequest): Promise<ChatSendResult>
  /** 订阅 6 事件流（`delta|citation|payload|blocked|done|error`），返回取消订阅函数。 */
  onChatEvent(listener: (event: IpcEvent) => void): () => void
  /** 读设置（`GET /api/settings`；Key 只回掩码，明文永不进渲染进程）。 */
  readSettings(): Promise<SettingsCallResult<SettingsSnapshot>>
  /** 保存设置（`PUT /api/settings`；`apiKey` 空串/掩码 = 保留已存值）。 */
  saveSettings(payload: SettingsUpdateRequest): Promise<SettingsCallResult<SettingsSnapshot>>
  /** 真实连通性探测（`POST /api/settings/probe`；失败原因可读，不落库、不改配置）。 */
  probeSettings(payload: ProbeRequest): Promise<SettingsCallResult<ProbeResult>>
  /**
   * Pi 内置供应商预设（端点地址现成可用，含模型清单）——设置页的「供应商预设」下拉。
   * ★ 只有主进程能读 Pi 目录，渲染进程没有 Node 能力（守卫 G2 拦着），所以必须经这里。
   */
  readProviderCatalog(): Promise<SettingsCallResult<ProviderCatalogEntry[]>>
  /**
   * 拉取某个地址可见的模型清单（端点实时 + Pi 预设合并去重）。
   * 端点失败时 `preset` 仍可用 —— 界面永远有候选可选，不是「全有或全无」。
   */
  fetchProviderModels(payload: ProbeRequest): Promise<SettingsCallResult<FetchModelsResult>>
  /**
   * 读**当前学段**。
   * ★ 学段的写入口只有一条：{@link setGrade}（走 `grade:set` 独立通道）。
   */
  getGrade(): Promise<GradeCallResult<GradeState>>
  /**
   * ★ 学生手动设定学段（走 `grade:set` 独立通道；**绝不混进对话请求** ——
   *   发消息与改学段是两件事，混在一起会让「每轮对话」变成「每轮写一次学段」）。
   */
  setGrade(gradeLevel: GradeLevel): Promise<GradeCallResult<GradeSetResult>>
  /** 订阅学段变化（推进指示器），返回取消订阅函数。 */
  onGradeChanged(listener: (state: GradeState) => void): () => void
  /**
   * 读**当前教材章节**。
   * ★ 章节的写入口只有一条：{@link setChapter}（走 `chapter:set` 独立通道）。
   */
  getChapter(): Promise<ChapterCallResult<ChapterState>>
  /**
   * ★ 学生手动选定当前教材章节（走 `chapter:set` 独立通道；**绝不混进对话请求**）。
   * ★ 传**空串 = 取消选择**（回到「不限章节，自由问答」）—— 空串是合法入参，不是「没填」。
   */
  setChapter(chapterTitle: string): Promise<ChapterCallResult<ChapterSetResult>>
  /** 订阅当前章节变化（推进指示器），返回取消订阅函数。 */
  onChapterChanged(listener: (state: ChapterState) => void): () => void
  /**
   * 订阅「下发学生代码去执行」的请求（渲染进程侧在沙箱 Worker 里跑），返回取消订阅函数。
   * ★ 主进程绝不执行学生代码 —— 它只把代码推下来，结果由 {@link sendCodeResult} 回传。
   */
  onCodeExecute(listener: (request: CodeExecuteRequest) => void): () => void
  /** 回传执行结果（`requestId` 必须**原样带回**，主进程按它配对，否则每次都会超时）。 */
  sendCodeResult(result: CodeExecuteResult): void
  /**
   * 学习报告（`GET /api/profile/{id}/report`）。
   * ★ 学生身份由**主进程**决定（请求里没有 `studentId` 字段）——
   *   身份一旦可由渲染进程指定，就等于允许读别人的学习记录。
   */
  readStudyReport(payload?: StudyReportRequest): Promise<StudyCallResult>
  /** 错题本（`GET /api/quiz/mistakes/{id}`）。 */
  readStudyMistakes(): Promise<StudyCallResult>
  /** 某学段章节清单（带 `studentId` 就补每章的已掌握数）。 */
  readStudyChapters(payload: StudyGradeRequest): Promise<StudyCallResult>
  /** 某学段依赖图全览（学习地图；带 `studentId` 就标注哪些已掌握）。 */
  readStudyGraph(payload: StudyGradeRequest): Promise<StudyCallResult>
  /**
   * 列出当前学生的历史会话（只读回看）。
   * ★ 回来看的是**投影后的摘要**（标题/条数/时间），不含任何宿主路径。
   */
  listSessions(): Promise<StudyCallResult>
  /**
   * 按 **id** 读一条会话的正文。
   * ★★ **只接受会话 id，不接受路径**：主进程先用 Pi 列出的会话做白名单对齐，
   *    再用 Pi 自己给的 path 打开 —— 递路径是无效的（防止渲染进程读任意文件）。
   */
  readSessionTranscript(sessionId: string): Promise<StudyCallResult>
  /** 在历史会话里搜索（命中标题或全文，返回片段）。 */
  searchSessions(payload: SessionSearchRequest): Promise<StudyCallResult>
  /**
   * ★★ 读**当前会话的完整状态**（含**恢复出来的正文**与开场引导）。
   *
   * 这是**冷启动恢复**那条路：主进程启动时已经续上了最近一条会话，
   * 而恢复出来的对话只有它手里有 —— 不调这个方法，学生看到的就是
   * 「关掉应用再打开，上一段对话从界面上消失了」。
   *
   * ★ 它会（必要时）装配会话：那是这条路的代价，也是它的全部意义。
   * ★ 装配失败回 `{ok:false, message}`（没有 Key / 服务没起来时应用仍要能用）。
   */
  getSessionState(): Promise<SessionStateResult>
  /**
   * ★★ **切换到一条历史会话继续聊**（恢复会话的唯一入口）。
   *
   * ★ 只接受**会话 id**：主进程先用 Pi 列出的会话做白名单对齐，再用 Pi 给的 path 打开。
   * ★ 回执里带着**恢复出来的对话**（`messages`）与**开场引导**（`opening`）——
   *   渲染进程要整段换掉手里的消息列表，分两次拿会留下「界面已切、消息还是旧的」的中间态。
   */
  openSession(sessionId: string): Promise<SessionOpenResult>
  /**
   * ★ 开始一条**全新的会话**（旧的那条仍在列表里，随时能切回去）。
   * ★ 回执形状与 {@link openSession} 一致：两条路都返回「切换后的完整状态」。
   */
  startNewSession(): Promise<SessionOpenResult>
  /**
   * ★★ **从某条消息处重新问**（分叉出一条新会话）。
   *
   * 语义：把「根 → 该消息」这一段复制成新会话，**原会话一个字节不动** ——
   * 这是「重新问一遍」而不是「改写历史」，两条线都能找回。
   *
   * ★ 两个入参都只当**字符串 id** 用：`sessionId` 走会话白名单、
   *   `entryId` 由主进程核对该会话的条目清单（渲染进程指不了别的会话）。
   */
  branchSession(request: SessionBranchRequest): Promise<SessionBranchResult>
  /**
   * 订阅**本轮条目 id**（`{requestId, userEntryId, entryId}`），返回取消订阅函数。
   *
   * ★ 「从这里重新问」的分叉点靠它 —— 没有它，那个按钮只对**历史消息**出现，
   *   对刚聊出来的回答不出现（而那正是它最主要的用法）。
   */
  onTurnEntries(listener: (payload: TurnEntries) => void): () => void
  /**
   * 订阅**当前会话变化**，返回取消订阅函数。
   * ★ 必须推送：会话会在别处被改变（列表里点开另一条、标题在后台生成完成），
   *   渲染进程看不到那些动作 —— 不推的话侧栏永远高亮着上一段对话。
   */
  onSessionChanged(listener: (state: SessionCurrent) => void): () => void
  /**
   * 把一段 Markdown 存成文件（报告 / 错题本导出）。
   * ★ **回执只有文件名**（完整路径不进渲染进程）；文件名由主进程清理。
   * ★ 学生取消保存时回 `{ok:false, canceled:true}` —— 那是正常路径，不是错误。
   */
  exportMarkdown(payload: FileExportRequest): Promise<FileExportResult>
  /**
   * 订阅**本轮 Tool 调用轨迹快照**（右栏「工具调用轨迹」），返回取消订阅函数。
   * ★ 它是独立通道，不是 6 事件之一（轨迹是工程证据，与对话状态机不是一回事）。
   */
  onTraceChanged(listener: (snapshot: TraceSnapshot) => void): () => void
  /**
   * 读**当前学生**（昵称 / 学段 / 当前章节）。
   * ★ 学生身份由主进程决定；库里没有学生时主进程会建一个（新机器首跑）。
   */
  getStudent(): Promise<StudyCallResult>
  /** 读画像（掌握度 + 偏好 + 推荐知识点）。 */
  readProfile(): Promise<StudyCallResult>
  /** 读「推荐下一步」（依赖图 + 掌握度推导，聚合在 Python）。 */
  readRecommendation(): Promise<StudyCallResult>
  /** 读学段推断信号（当前学段、各信号分值、待生效建议）。 */
  readGradeSignals(): Promise<StudyCallResult>
  /** 读学段变化轨迹（含来源 inferred / explicit）。 */
  readGradeHistory(): Promise<StudyCallResult>
  /**
   * 取某知识点的题库题目。
   * ★ 学段由主进程注入（前端指定不了）；载荷**不含标准答案**。
   */
  readQuizBank(payload: QuizBankRequest): Promise<StudyCallResult>
  /**
   * 提交一题作答并判分（`POST /api/quiz/grade`）。
   * ★ 判分只在后端 —— 回来的 `correct` / `feedback` / `masteryDelta` 是权威结论。
   */
  gradeQuiz(payload: QuizGradeRequest): Promise<StudyCallResult>
  /** 读闯关进度（每关的阶段 locked/learning/quizzed/mastered 与分数）。 */
  readQuizProgress(payload?: QuizProgressRequest): Promise<StudyCallResult>
  /** 取代码脚手架（**载荷里没有 solution**）。 */
  readCodeTemplate(payload: CodeTemplateRequest): Promise<StudyCallResult>
  /** 取一级代码提示（1 = 方向，3 = 接近脚手架；逐级要，不一次给全）。 */
  readCodeHint(payload: CodeHintRequest): Promise<StudyCallResult>
  /**
   * 把**已经跑完**的代码与输出交给后端（中文报错归一 + 定下一级提示）。
   * ★★ **这条通道不执行任何代码**：学生代码只在渲染进程的 Pyodide Worker 里跑。
   */
  analyzeCodeRun(payload: CodeRunHintRequest): Promise<StudyCallResult>
  /** 列出动画模板（含参数与默认值）。 */
  readAnimationTemplates(payload?: AnimationTemplatesRequest): Promise<StudyCallResult>
  /** 按模板渲染一个自包含沙箱 HTML。 */
  renderAnimation(payload: AnimationRenderRequest): Promise<StudyCallResult>
  /** 把动画 HTML 托管成一次性 nonce 地址（iframe 带不了 header，所以不能用 token）。 */
  hostAnimation(payload: AnimationHostRequest): Promise<StudyCallResult>
  /** 知识库体检数字（规模 / 学段 / 向量可用性 / 是否是用户重建的那一份）。 */
  readKnowledgeStats(): Promise<StudyCallResult>
  /** 知识点清单（教材知识库页的表格；可按学段过滤）。 */
  readKnowledgePoints(payload?: KnowledgePointsRequest): Promise<StudyCallResult>
  /**
   * 导入一份教材 Markdown（严格校验 → 落盘 → 可选重建）。
   * ★ 校验/审计失败回 `{ok:true, data:{ok:false, problems:[…]}}` —— 那是**内容**问题，
   *   界面要在同一张卡片里逐条列出，不是「请求非法」。
   */
  importKnowledge(payload: KnowledgeImportIpcRequest): Promise<StudyCallResult>
  /**
   * 重建索引（重活：分块 + 嵌入整份教材，秒级到十几秒 → 主进程用长超时）。
   * ★ 失败回 `{ok:true, data:{ok:false, message}}`（可读中文），不是异常。
   */
  rebuildKnowledge(): Promise<StudyCallResult>
  /**
   * 最小化本窗口（无边框窗口：没有系统标题栏，按钮只能由页面画）。
   * ★ 不接收参数：作用对象由主进程从事件来源反查，渲染进程指不了别的窗口。
   * ★ 回 `false` 表示「窗口已销毁 / 正在退出」—— 此时点什么都不会发生。
   */
  minimizeWindow(): Promise<boolean>
  /** 在**最大化与还原之间切换**本窗口；回 `false` 同上。 */
  toggleMaximizeWindow(): Promise<boolean>
  /**
   * 关闭本窗口。★ 与点系统关闭按钮**等价**：走的是 `window.close()`，
   * 会正常触发退出流程（Pi 会话 flush + sidecar 收尾），不是强杀。
   */
  closeWindow(): Promise<boolean>
  /**
   * 订阅**最大化状态变化**（按钮图标据此换），返回取消订阅函数。
   * ★ 必须推送：双击拖拽区、Win+↑/↓、拖到屏幕上边缘都会改变状态，渲染进程看不到。
   */
  onWindowMaximizedChanged(listener: (maximized: boolean) => void): () => void
}

/**
 * ★ `window.api` 的全局声明**放在这里**（而不是只放 `index.d.ts`）。
 *
 * 为什么不只靠 `src/preload/index.d.ts`：tsconfig 的 `include` 同时匹配 `index.ts` 与
 * `index.d.ts` 时，TypeScript 会**丢掉同名的 .d.ts**（`index.ts` 胜出），于是
 * `tsconfig.node.json`（含 `tests/**`，而 `tests/renderer-quiz.test.ts` 会 import 渲染进程模块）
 * 里 `window.api` 就成了未声明属性 —— 实测报 `TS2339: Property 'api' does not exist`。
 * 两份 `declare global` 类型完全相同（都指向本文件的 `K12Api`），接口合并不会冲突；
 * `tsconfig.web.json` 只收 `src/preload/*.d.ts`，因此两边各自只看到一份声明。
 */
declare global {
  interface Window {
    api: K12Api
  }
}

const api: K12Api = {
  getSidecarInfo: (): Promise<SidecarState> =>
    ipcRenderer.invoke(IPC.sidecarGetInfo) as Promise<SidecarState>,

  onSidecarChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, state: SidecarState): void => {
      listener(state)
    }
    ipcRenderer.on(IPC.sidecarChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.sidecarChanged, handler)
    }
  },

  sendChat: (request): Promise<ChatSendResult> =>
    ipcRenderer.invoke(IPC.chatSend, request) as Promise<ChatSendResult>,

  onChatEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 白名单校验：只转发冻结词表内的事件（未知/畸形载荷在这里就丢掉，渲染进程看不到脏数据）
      if (!isIpcEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(IPC.chatEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, handler)
    }
  },

  // 设置域：纯 invoke 转发（回执是判别联合 `{ok,data} | {ok,message}`，失败不抛异常）。
  // token 与地址全在主进程（`bridge/client.ts`），这里只是把参数照原样递过去。
  readSettings: (): Promise<SettingsCallResult<SettingsSnapshot>> =>
    ipcRenderer.invoke(IPC.settingsRead) as Promise<SettingsCallResult<SettingsSnapshot>>,

  saveSettings: (payload): Promise<SettingsCallResult<SettingsSnapshot>> =>
    ipcRenderer.invoke(IPC.settingsSave, payload) as Promise<SettingsCallResult<SettingsSnapshot>>,

  probeSettings: (payload): Promise<SettingsCallResult<ProbeResult>> =>
    ipcRenderer.invoke(IPC.settingsProbe, payload) as Promise<SettingsCallResult<ProbeResult>>,

  readProviderCatalog: (): Promise<SettingsCallResult<ProviderCatalogEntry[]>> =>
    ipcRenderer.invoke(IPC.settingsProviderCatalog) as Promise<SettingsCallResult<ProviderCatalogEntry[]>>,

  fetchProviderModels: (payload): Promise<SettingsCallResult<FetchModelsResult>> =>
    ipcRenderer.invoke(IPC.settingsFetchModels, payload) as Promise<SettingsCallResult<FetchModelsResult>>,
  getGrade: (): Promise<GradeCallResult<GradeState>> =>
    ipcRenderer.invoke(IPC.gradeGet) as Promise<GradeCallResult<GradeState>>,
  // ★ 学段的写入口（唯一）：入参按 `{ gradeLevel }` 递过去，主进程再做一次白名单校验
  //   （渲染进程递来的值一律不当真，见 `ipc/handlers.ts` 的 gradeSet 处理器）。
  setGrade: (gradeLevel): Promise<GradeCallResult<GradeSetResult>> =>
    ipcRenderer.invoke(IPC.gradeSet, { gradeLevel }) as Promise<GradeCallResult<GradeSetResult>>,
  onCodeExecute: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, request: unknown): void => {
      if (!isCodeExecuteRequest(request)) return
      listener(request)
    }
    ipcRenderer.on(IPC.codeExecute, handler)
    return () => {
      ipcRenderer.removeListener(IPC.codeExecute, handler)
    }
  },
  sendCodeResult: (result): void => {
    ipcRenderer.invoke(IPC.codeResult, result).catch((error: unknown) => {
      console.error('[preload] 回传代码执行结果失败：', error)
    })
  },
  onGradeChanged: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      // 边界处过滤：只认四个冻结字面量，别把主进程的半截对象丢给界面去渲染
      if (!isGradeState(state)) return
      listener(state)
    }
    ipcRenderer.on(IPC.gradeChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.gradeChanged, handler)
    }
  },

  // 教材章节：与学段那一对完全对称（读一条、写一条、订阅一条）。
  // ★ 身份由主进程决定：这里**不传** studentId（递进去就等于允许读别人的选择）。
  getChapter: (): Promise<ChapterCallResult<ChapterState>> =>
    ipcRenderer.invoke(IPC.chapterGet) as Promise<ChapterCallResult<ChapterState>>,

  // ★ 入参按 `{ chapterTitle }` 递过去，主进程再用 `readChapterTitle` 做一次白名单校验
  //   （渲染进程递来的值一律不当真）。空串 = 取消选择，**必须**能穿过去。
  setChapter: (chapterTitle): Promise<ChapterCallResult<ChapterSetResult>> =>
    ipcRenderer.invoke(IPC.chapterSet, { chapterTitle }) as Promise<
      ChapterCallResult<ChapterSetResult>
    >,

  onChapterChanged: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      // 边界处过滤：学的段必须是四个冻结字面量、标题必须是字符串
      // （半截对象直接丢掉，别让界面去渲染一个 `undefined` 标题）
      if (!isChapterState(state)) return
      listener(state)
    }
    ipcRenderer.on(IPC.chapterChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.chapterChanged, handler)
    }
  },

  // 学习档案：纯 invoke 转发（回执是判别联合 `{ok,data} | {ok,message}`，失败不抛异常）。
  // ★ 身份与聚合全在主进程/Python 侧，这里只是把参数照原样递过去。
  readStudyReport: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.studyReport, payload) as Promise<StudyCallResult>,

  readStudyMistakes: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.studyMistakes) as Promise<StudyCallResult>,

  readStudyChapters: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.studyChapters, payload) as Promise<StudyCallResult>,

  readStudyGraph: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.studyGraph, payload) as Promise<StudyCallResult>,

  listSessions: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.sessionList) as Promise<StudyCallResult>,

  readSessionTranscript: (sessionId): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.sessionTranscript, sessionId) as Promise<StudyCallResult>,

  searchSessions: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.sessionSearch, payload) as Promise<StudyCallResult>,

  // ── 会话切换 / 新建（★ 恢复续聊的写入口）────────────────────────────────
  // ★ 只把**会话 id** 递过去（主进程做白名单对齐），字符串以外的一律过滤掉。
  // ★ 回执是判别联合（失败也带一句可读中文），与本项目其它 invoke 同一条纪律。
  getSessionState: (): Promise<SessionStateResult> =>
    ipcRenderer.invoke(IPC.sessionState) as Promise<SessionStateResult>,

  openSession: (sessionId): Promise<SessionOpenResult> =>
    ipcRenderer.invoke(IPC.sessionOpen, sessionId) as Promise<SessionOpenResult>,

  startNewSession: (): Promise<SessionOpenResult> =>
    ipcRenderer.invoke(IPC.sessionNew) as Promise<SessionOpenResult>,

  branchSession: (request): Promise<SessionBranchResult> =>
    ipcRenderer.invoke(IPC.sessionBranch, {
      // ★ 逐字段重建：只递两个字符串，渲染进程多塞的字段进不来
      sessionId: typeof request?.sessionId === 'string' ? request.sessionId : '',
      entryId: typeof request?.entryId === 'string' ? request.entryId : ''
    }) as Promise<SessionBranchResult>,

  onTurnEntries: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 边界处过滤：三个字段都必须是字符串（半截对象直接丢掉，
      // 别让某一轮挂上 `undefined` 当分叉点）
      const record = payload as { requestId?: unknown; userEntryId?: unknown; entryId?: unknown } | null
      if (!record || typeof record !== 'object') return
      if (typeof record.requestId !== 'string' || record.requestId === '') return
      listener({
        requestId: record.requestId,
        userEntryId: typeof record.userEntryId === 'string' ? record.userEntryId : '',
        entryId: typeof record.entryId === 'string' ? record.entryId : ''
      })
    }
    ipcRenderer.on(IPC.turnEntries, handler)
    return () => {
      ipcRenderer.removeListener(IPC.turnEntries, handler)
    }
  },

  onSessionChanged: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      // 边界处过滤：`sessionId` 必须是字符串（半截对象直接丢掉，
      // 别让侧栏去渲染一个 undefined 的会话 id）
      if (!isSessionCurrent(state)) return
      listener(state)
    }
    ipcRenderer.on(IPC.sessionChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.sessionChanged, handler)
    }
  },

  exportMarkdown: (payload): Promise<FileExportResult> =>
    ipcRenderer.invoke(IPC.fileExport, payload) as Promise<FileExportResult>,

  // ── 工具调用轨迹（推送；快照语义见 shared/ipc-events.ts）──────────────────
  onTraceChanged: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, snapshot: unknown): void => {
      // 边界处过滤：`entries` 必须是数组（半截对象直接丢掉，别让界面上出现一行空白轨迹）
      if (!isTraceSnapshot(snapshot)) return
      listener(snapshot)
    }
    ipcRenderer.on(IPC.traceChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.traceChanged, handler)
    }
  },

  // ── 学生身份 / 画像 / 学段证据 ───────────────────────────────────────────
  // ★ 一律不带 studentId：身份由主进程决定（递进去就等于允许读别人的数据）。
  getStudent: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.studentGet) as Promise<StudyCallResult>,

  readProfile: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.profileRead) as Promise<StudyCallResult>,

  readRecommendation: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.profileRecommendation) as Promise<StudyCallResult>,

  readGradeSignals: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.gradeSignals) as Promise<StudyCallResult>,

  readGradeHistory: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.gradeHistory) as Promise<StudyCallResult>,

  // ── 闯关（独立页面用；对话内的题卡仍走 chat 路径）────────────────────────
  readQuizBank: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.quizBank, payload) as Promise<StudyCallResult>,

  gradeQuiz: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.quizGrade, payload) as Promise<StudyCallResult>,

  readQuizProgress: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.quizProgress, payload) as Promise<StudyCallResult>,

  // ── 编程（★ 没有「执行代码」的通道：那条走 code:execute → 渲染进程 Worker）──
  readCodeTemplate: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.codeTemplate, payload) as Promise<StudyCallResult>,

  readCodeHint: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.codeHint, payload) as Promise<StudyCallResult>,

  analyzeCodeRun: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.codeRunHint, payload) as Promise<StudyCallResult>,

  // ── 动画（模板 → 渲染 → 一次性 nonce 托管）───────────────────────────────
  readAnimationTemplates: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.animationTemplates, payload) as Promise<StudyCallResult>,

  renderAnimation: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.animationRender, payload) as Promise<StudyCallResult>,

  hostAnimation: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.animationHost, payload) as Promise<StudyCallResult>,

  // ── 教材知识库（读三条 + 写两条；写的那两条用长超时，见主进程）─────────────
  readKnowledgeStats: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.knowledgeStats) as Promise<StudyCallResult>,

  readKnowledgePoints: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.knowledgePoints, payload) as Promise<StudyCallResult>,

  importKnowledge: (payload): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.knowledgeImport, payload) as Promise<StudyCallResult>,

  rebuildKnowledge: (): Promise<StudyCallResult> =>
    ipcRenderer.invoke(IPC.knowledgeRebuild) as Promise<StudyCallResult>,

  // ── 窗口控制（无边框窗口的页面内按钮）──────────────────────────────────
  // ★ 三条都不带参数：作用对象由主进程从事件来源反查（渲染进程指不了别的窗口）。
  minimizeWindow: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.windowMinimize) as Promise<boolean>,

  toggleMaximizeWindow: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.windowToggleMaximize) as Promise<boolean>,

  closeWindow: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowClose) as Promise<boolean>,

  onWindowMaximizedChanged: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, maximized: unknown): void => {
      // 边界处过滤：只认布尔（半截载荷直接丢掉，别让按钮图标变成 undefined）
      if (typeof maximized !== 'boolean') return
      listener(maximized)
    }
    ipcRenderer.on(IPC.windowMaximizedChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.windowMaximizedChanged, handler)
    }
  }
}

/**
 * 学段状态的最小形状检查（`origin` 缺省按 `default` 处理：宁可显示待判定）。
 * ★ 三态都要认（`explicit` = 学生手动选的）—— 漏掉它会让「刚点完学段」的推送被整条丢掉，
 *   界面停在上一个状态，看起来像「点了没反应」。
 */
function isGradeState(value: unknown): value is GradeState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { gradeLevel?: unknown; origin?: unknown }
  return (
    typeof record.gradeLevel === 'string' &&
    (GRADE_LEVELS as readonly string[]).includes(record.gradeLevel) &&
    (record.origin === 'inferred' || record.origin === 'explicit' || record.origin === 'default')
  )
}

/**
 * 章节状态的最小形状检查（与 {@link isGradeState} 同一口径）。
 * ★ `chapterTitle` 必须是字符串（**空串合法** = 未选择章节）：认不出就整条丢掉，
 *   否则界面上会渲染出一个 `undefined` 标题，看起来像「选了但没选上」。
 */
function isChapterState(value: unknown): value is ChapterState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { gradeLevel?: unknown; chapterTitle?: unknown }
  return (
    typeof record.gradeLevel === 'string' &&
    (GRADE_LEVELS as readonly string[]).includes(record.gradeLevel) &&
    typeof record.chapterTitle === 'string'
  )
}

/**
 * 当前会话状态的最小形状检查（`sessionId` 必须是字符串 —— **空串合法**）。
 *
 * ★ 空串是合法值（= 还没有会话），所以判据是「是不是字符串」而不是「真值」：
 *   写成 `if (!record.sessionId) return false` 会把「新建应用、还没有会话」这条
 *   完全正常的推送整条丢掉，侧栏于是永远停在上一状态。
 */
function isSessionCurrent(value: unknown): value is SessionCurrent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { sessionId?: unknown; title?: unknown; messageCount?: unknown }
  return (
    typeof record.sessionId === 'string' &&
    typeof record.title === 'string' &&
    typeof record.messageCount === 'number'
  )
}

/** 下发执行请求的最小形状检查（缺 `requestId`/`code` 的直接丢掉，别让渲染侧拿到半截对象）。 */
function isCodeExecuteRequest(value: unknown): value is CodeExecuteRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { requestId?: unknown; code?: unknown }
  return typeof record.requestId === 'string' && typeof record.code === 'string'
}

/**
 * 轨迹快照的最小形状检查。
 * ★ 只认「`turn` 是数字 + `entries` 是数组」：轨迹是**装饰性证据**，
 *   宁可整条丢掉，也不要让界面渲染出半截轨迹（那会让人以为工具没被调用）。
 */
function isTraceSnapshot(value: unknown): value is TraceSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { turn?: unknown; entries?: unknown }
  return typeof record.turn === 'number' && Array.isArray(record.entries)
}

/** 四个学段字面量（与 `shared/ipc-events.ts` 的 `GradeLevel` 同源，此处只做运行期校验）。 */
const GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior'] as const

/** 事件名是否在冻结的 6 个之内（`IPC_EVENT_NAMES` 是 `shared/ipc-events.ts` 的运行时副本）。 */
function isIpcEvent(payload: unknown): payload is IpcEvent {
  if (typeof payload !== 'object' || payload === null) return false
  const name = (payload as { name?: unknown }).name
  return typeof name === 'string' && (IPC_EVENT_NAMES as readonly string[]).includes(name)
}

/** 仅用于类型引用的自检：这些通道名必须来自唯一来源（守卫会另外扫字面量）。 */
export const WHITELISTED_CHANNELS: readonly IpcChannel[] = [
  IPC.sidecarGetInfo,
  IPC.sidecarChanged,
  IPC.chatSend,
  IPC.chatEvent,
  IPC.settingsRead,
  IPC.settingsSave,
  IPC.settingsProbe,
  IPC.settingsProviderCatalog,
  IPC.settingsFetchModels,
  IPC.gradeGet,
  IPC.gradeSet,
  IPC.gradeChanged,
  // 教材章节（读取 invoke / 手动设定 invoke / 变化推送）
  IPC.chapterGet,
  IPC.chapterSet,
  IPC.chapterChanged,
  IPC.codeExecute,
  IPC.codeResult,
  // 学习档案（invoke；聚合在 Python 侧）
  IPC.studyReport,
  IPC.studyMistakes,
  IPC.studyChapters,
  IPC.studyGraph,
  // 历史会话（invoke；**只接受 id，不接受路径**）
  IPC.sessionList,
  IPC.sessionTranscript,
  IPC.sessionSearch,
  // 会话切换 / 新建 / 当前状态（三条 invoke）+ 变化推送（一条 push）
  IPC.sessionOpen,
  IPC.sessionNew,
  IPC.sessionBranch,
  IPC.sessionState,
  IPC.sessionChanged,
  IPC.turnEntries,
  // 导出（invoke；回执只有文件名）
  IPC.fileExport,
  // 工具调用轨迹（**推送**：主进程每记录一条就推一次全量快照）
  IPC.traceChanged,
  // 学生身份 / 画像 / 学段证据（invoke；身份由主进程决定）
  IPC.studentGet,
  IPC.profileRead,
  IPC.profileRecommendation,
  IPC.gradeSignals,
  IPC.gradeHistory,
  // 闯关（invoke；判分只在后端，题库载荷不含答案）
  IPC.quizBank,
  IPC.quizGrade,
  IPC.quizProgress,
  // 编程（invoke；★ 没有任何「执行代码」的通道 —— 执行只在渲染进程 Worker 里）
  IPC.codeTemplate,
  IPC.codeHint,
  IPC.codeRunHint,
  // 动画（invoke；托管回一次性 nonce 地址）
  IPC.animationTemplates,
  IPC.animationRender,
  IPC.animationHost,
  // 教材知识库（invoke；导入/重建是写操作，用长超时）
  IPC.knowledgeStats,
  IPC.knowledgePoints,
  IPC.knowledgeImport,
  IPC.knowledgeRebuild,
  // 窗口控制（三条 invoke + 一条**推送**：最大化状态变化）
  IPC.windowMinimize,
  IPC.windowToggleMaximize,
  IPC.windowClose,
  IPC.windowMaximizedChanged
]

contextBridge.exposeInMainWorld('api', api)
