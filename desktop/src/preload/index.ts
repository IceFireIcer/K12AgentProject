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
  type ChapterCallResult,
  type ChapterSetResult,
  type ChapterState,
  type ChatSendRequest,
  type ChatSendResult,
  type CodeExecuteRequest,
  type CodeExecuteResult,
  type FetchModelsResult,
  type FileExportRequest,
  type FileExportResult,
  type GradeCallResult,
  type GradeSetResult,
  type GradeState,
  type IpcChannel,
  type ProbeRequest,
  type ProbeResult,
  type ProviderCatalogEntry,
  type SessionSearchRequest,
  type SettingsCallResult,
  type SettingsSnapshot,
  type SettingsUpdateRequest,
  type StudyCallResult,
  type StudyGradeRequest,
  type StudyReportRequest
} from '../main/ipc/channels'
import type { SidecarState } from '../main/sidecar/protocol'
import type { GradeLevel } from '../shared/ipc-events'
import { IPC_EVENT_NAMES, type IpcEvent } from '../shared/ipc-events'

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
   * 把一段 Markdown 存成文件（报告 / 错题本导出）。
   * ★ **回执只有文件名**（完整路径不进渲染进程）；文件名由主进程清理。
   * ★ 学生取消保存时回 `{ok:false, canceled:true}` —— 那是正常路径，不是错误。
   */
  exportMarkdown(payload: FileExportRequest): Promise<FileExportResult>
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

  exportMarkdown: (payload): Promise<FileExportResult> =>
    ipcRenderer.invoke(IPC.fileExport, payload) as Promise<FileExportResult>
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

/** 下发执行请求的最小形状检查（缺 `requestId`/`code` 的直接丢掉，别让渲染侧拿到半截对象）。 */
function isCodeExecuteRequest(value: unknown): value is CodeExecuteRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { requestId?: unknown; code?: unknown }
  return typeof record.requestId === 'string' && typeof record.code === 'string'
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
  // 历史会话（invoke；只读回看；**只接受 id，不接受路径**）
  IPC.sessionList,
  IPC.sessionTranscript,
  IPC.sessionSearch,
  // 导出（invoke；回执只有文件名）
  IPC.fileExport
]

contextBridge.exposeInMainWorld('api', api)
