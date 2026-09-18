/**
 * 主进程 IPC 处理器注册。
 *
 * 渲染进程只能通过 preload 白名单访问这些通道（见 `src/preload/index.ts`）。
 *
 * 本文件是**唯一**把 `ipcMain` / `webContents` 与纯逻辑接起来的地方：
 *   - 通道名 → `./channels`（唯一来源）
 *   - 轮次生命周期（请求号、窗口销毁清理）→ `./chat-stream`
 *   - 入参校验 → `./chat-request`
 *   - 事件内容 → `../agent/runtime` + `../agent/events`（★ 票 06：真实 Pi 流，不再是假数据源）
 *
 * ★ 会话工厂是**懒加载单例**：不把 Pi 的模块图拖进启动路径，
 *   首条消息才装配会话（装配失败也只影响对话，应用仍能起来报错而不是白屏）。
 * ★ 退出清理：`disposeChatRuntime()` 必须在 `before-quit` 调用（`src/main/index.ts` 有标记点），
 *   否则 Pi 的 JSONL 可能半写。本文件另注册一条 `before-quit` 兜底（幂等），
 *   即使入口漏接，会话也一定被 flush。
 * ★ 设置域三条 invoke（`settings:read` / `settings:save` / `settings:probe`）也在这里注册：
 *   渲染进程侧只认 `window.api` 上的三个方法，HTTP 与 token 全留在主进程。
 */

import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { apiFetch } from '../bridge/client.ts'
import { describeRuntimeFailure } from '../agent/events.ts'
import { gradeStatePath } from '../agent/extensions/grade.ts'
import { bindCodeRunner, createRendererCodeRunner } from '../agent/extensions/coding.ts'
import { builtinCatalog } from '../agent/pi-bootstrap.ts'
import { assertStudentId } from '../agent/pi-paths.ts'
import type { ChatRuntime } from '../agent/runtime.ts'
import { createChatRuntime } from '../agent/runtime.ts'
  refreshRuntimeLlmConfig,
  type RuntimeLlmConfig
} from '../settings/runtime-config.ts'
import type { SidecarManager } from '../sidecar/manager.ts'
import type { SidecarState } from '../sidecar/protocol.ts'
import {
  IPC,
  MAX_EXPORT_CHARS,
  type ChapterCallResult,
  type ChapterSetResult,
  type ChapterState,
  type ChatSendResult,
  type CodeExecuteRequest,
  type CodeExecuteResult,
  type FetchModelsResult,
  type FileExportRequest,
  type FileExportResult,
  type GradeCallResult,
  type GradeSetResult,
  type GradeState,
  type ProbeRequest,
  type ProbeResult,
  type ProviderCatalogEntry,
  type SessionSearchRequest,
  type SettingsCallResult,
  type SettingsSnapshot,
  type SettingsUpdateRequest
  type StudyCallResult,
  type StudyGradeRequest,
  type StudyReportRequest
} from './channels.ts'
// 学习档案的取数层（路径工厂 + 归一化；聚合全在 Python）
  STUDY_GRADE_LEVELS,
  STUDY_MAX_REPORT_DAYS,
  fetchStudyJson,
  readStudyGradeLevel,
  studyChaptersPath,
  studyGraphPath,
  studyMistakesPath,
  studyReportPath
} from '../study/client.ts'
// 当前教材章节（软偏好；读写只有这一处实现）
  CHAPTER_TITLE_MAX_CHARS,
  fetchChapterState,
  readChapterTitle,
  saveChapterState
} from '../study/chapter.ts'
// 历史会话：投影/搜索是纯函数；`listStudentSessions` / `readStudentSessionEntries` 才碰 Pi
  TITLE_MAX_CHARS,
  findSessionById,
  listStudentSessions,
  projectSessionList,
  projectTranscript,
  readStudentSessionEntries,
  searchSessions,
  truncateChars,
  type SessionTranscript
} from '../study/sessions.ts'
// 导出的文件名清理（纯函数，安全边界）
import { normalizeExportContent, sanitizeFileName } from '../study/export-naming.ts'
import { mergeModelCandidates } from '@shared/provider-catalog'
import { parseChatSendRequest } from './chat-request.ts'
import { ChatStreamRegistry, type StreamTarget, type TurnHandle } from './chat-stream.ts'

const chatStreams = new ChatStreamRegistry()

/**
 * ★★ 票 18 的硬约束：**学生代码绝不在主进程执行**。
 *
 * 这里只做「下发 → 等回话」，真正的执行在渲染进程的 Pyodide Worker 里。
 * Pi 的 Extension 与 UI 同进程且拥有完整系统权限 —— 一旦在主进程跑学生代码，
 * 沙箱就是摆设。所以这条桥**没有**「执行不出来就自己跑一遍」的兜底：
 * 那种兜底会静默刺穿安全边界。
 */
const rendererCodeRunner = createRendererCodeRunner({
  dispatch: (request) => {
    const payload: CodeExecuteRequest = {
      requestId: request.requestId,
      code: request.code,
      timeoutMs: request.timeoutMs,
      toolCallId: request.toolCallId
    }
    let sent = false
    for (const window of BrowserWindow.getAllWindows()) {
      const webContents = window.webContents
      if (webContents.isDestroyed()) continue
      webContents.send(IPC.codeExecute, payload)
      sent = true
    }
    // 没有任何窗口 = 执行器不可用：抛出去让上层立刻失败（而不是干等超时）
    if (!sent) throw new Error('没有可用的渲染进程来执行代码')
  }
})
bindCodeRunner(rendererCodeRunner.runner)

/**
 * 当前学段（**读**给界面用）。
 *
 * ★ 这里**没有写入函数**，也不该有：学段由推断引擎独占（`agent/extensions/grade.ts`
 *   把每轮证据上交到 sidecar，规则引擎决定后写 `learning.db`）。前端连"请求改学段"
 * ★ 写入只有一条，走 `grade:set`（见下面的 handler）：学生显式设定学段时，
 * ★ 缓存只为「值没变就不推送」，真值永远以 sidecar 的 `learning.db` 为准。
 */
let currentGrade: GradeState | null = null

/** 四学段字面量（与 `shared/ipc-events.ts` 的 `GradeLevel` 同源，此处只做运行期校验）。 */
const GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior'] as const
/** 字符串 → 学段（认不出返回 `null`，不映射、不猜测、不兜底成最近的一个）。 */
function readGradeLevel(value: unknown): GradeState['gradeLevel'] | null {
  return typeof value === 'string' && (GRADE_LEVELS as readonly string[]).includes(value)
/**
 * 从 sidecar 读当前学段。
 *
 * ★ `origin` 的判定是刻意的：`lastTurn === 0` 表示**还没发生过任何推断**，
 *   此时显示为 `default`，前端渲染成「待判定」而不是假装系统已经判过。
 *   拿冷启动默认值冒充推断结果，演示时会被一眼看穿。
 *   - `source === 'explicit'` → `explicit`（学生手动选的）；
 * ★ **来源以服务端 `GradeStateOut.source` 为准，前端/主进程都不自己猜**：
 *   在界面上彻底隐身（学生改完学段，指示器却说这是系统判的）。
 */
async function readGradeState(instance: ChatRuntime): Promise<GradeState | null> {
  try {
    const response = await apiFetch(gradeStatePath(instance.studentId))
    if (!response.ok) return null
    const body = (await response.json()) as {
      grade?: unknown
      lastTurn?: unknown
      source?: unknown
    }
    // ★ 四学段**白名单**（不是「非空字符串就算数」）：同一边界的另外三处（`preload/index.ts`、
    //   不存在的学段，而 `as GradeState['gradeLevel']` 这种断言让 TypeScript 完全看不见。
    const gradeLevel = readGradeLevel(body.grade)
    const lastTurn = typeof body.lastTurn === 'number' ? body.lastTurn : 0
    // ★ 读的是契约里**真实存在**的 `GradeStateOut.source`（写入来源，例如 `inferred` / `explicit`）。
    const source =
      typeof body.source === 'string' && body.source.trim().length > 0 ? body.source.trim() : null
    return {
      gradeLevel: body.grade as GradeState['gradeLevel'],
      origin: lastTurn > 0 ? 'inferred' : 'default',
      reason: typeof body.reason === 'string' ? body.reason : null
      origin: source === 'explicit' ? 'explicit' : lastTurn > 0 ? 'inferred' : 'default',
      source
    }
  } catch {
    return null
  }
}

/** 值变了才推送 —— 每轮都推会让只读徽章反复闪动。 */
function pushGradeState(next: GradeState | null): void {
  if (!next) return
  const unchanged =
    currentGrade !== null &&
    currentGrade.gradeLevel === next.gradeLevel &&
    currentGrade.origin === next.origin
  if (unchanged) return
  currentGrade = next
  for (const window of BrowserWindow.getAllWindows()) {
    const webContents = window.webContents
    if (webContents.isDestroyed()) continue
    webContents.send(IPC.gradeChanged, next)
  }
}

 * 当前教材章节（**读**给界面用），与 {@link currentGrade} 并列。
 * ★ 写入只有一条，走 `chapter:set`（见下面的 handler）：学生显式选定某一章时，
 *   主进程写库、然后用服务端回执推一条 `chapter:changed`。
 * ★ 章节是**软偏好**：它进每轮 System Prompt，但**不进检索契约、不做 SQL 硬过滤**。
let currentChapter: ChapterState | null = null
 * 把 sidecar 回执归一成 {@link ChapterState}（两栏都过白名单，认不出回 `null`）。
 * ★ 与 `readGradeState` 同一纪律：**主进程这一侧也要校验**，不拿 `as` 断言糊过去 ——
 *   后端字段风格一变，指示器就会显示一个不存在的学段或一段脏标题，而 TypeScript 看不见。
function readChapterState(value: unknown): ChapterState | null {
  const record = value as { gradeLevel?: unknown; chapterTitle?: unknown }
  const gradeLevel = readGradeLevel(record.gradeLevel)
  return { gradeLevel, chapterTitle: readChapterTitle(record.chapterTitle) ?? '' }
/** 值变了才推送 —— 与 {@link pushGradeState} 同一手法（否则指示器会反复闪动）。 */
function pushChapterState(next: ChapterState | null): void {
    currentChapter !== null &&
    currentChapter.gradeLevel === next.gradeLevel &&
    currentChapter.chapterTitle === next.chapterTitle
  currentChapter = next
    webContents.send(IPC.chapterChanged, next)
/**
 * ★ 默认学生 id（票 09：一人一目录、一人一库）。
 *
 * 为什么是常量而不是从渲染进程传：`ChatSendRequest` 里**没有** `studentId`（守卫 G7 冻结了
 * 只有 `text` / `gradeLevel` 两个字段），身份必须由**主进程**决定 —— 一旦学生 id 变成模型/前端
 * 可填的参数，`get_student_profile(student_id=...)` 这种形状就允许读数别人的画像。
 *
 * 「选学生」的 UI 属票 20/21；在那之前，本机固定用 `student_001`，
 * 并留一个**显式**的环境变量改道口（`K12_STUDENT_ID`）供人工验收跨学生隔离用：
 * 换一个 id 重启 = 换一套 `students/<id>/pi-agent/` 会话目录，绝不复用别人的。
 */
export const DEFAULT_STUDENT_ID = 'student_001'

/** 环境变量优先（经 `assertStudentId` 校验）；非法或未设置时回落到 {@link DEFAULT_STUDENT_ID}。 */
export function resolveActiveStudentId(): string {
  const fromEnv = process.env.K12_STUDENT_ID
  if (!fromEnv) return DEFAULT_STUDENT_ID
  try {
    return assertStudentId(fromEnv)
  } catch (error) {
    console.warn(
      `[main] K12_STUDENT_ID 非法（${fromEnv}），已回落到 ${DEFAULT_STUDENT_ID}：` +
        (error instanceof Error ? error.message : String(error))
    )
    return DEFAULT_STUDENT_ID
  }
}

/**
 * ★ 唯一的会话持有者（模块级单例；`null` = 还没建或已经 dispose）。
 * 当前按「一个应用一个学生一个会话」使用：`studentId` 决定落盘目录，
 * 换学生必须先 `disposeChatRuntime()` 再重建（票 09 的会话目录与 learning.db 都按学生分）。
 */
let runtime: ChatRuntime | null = null
/** 正在装配中的 Promise（并发首条消息只装配一次）。 */
let runtimePending: Promise<ChatRuntime> | null = null

 * 为什么需要它 —— 装配是异步的（要先去 sidecar 读设置），而渲染进程一挂载就会读学段
/**
 * 取当前会话（没有就装配）。**Pi 只在真的发消息时被加载**。
 * `userDataDir` 用 Electron 的 `app.getPath('userData')`，绝不回退 `~/.pi`（票 03/09 的硬约束）。
 * ⚠️ 取不到就**回落内置默认值照常装配**（`refreshRuntimeLlmConfig` 内部已兜异常并返回 `null`）：
 */
export async function ensureChatRuntime(): Promise<ChatRuntime> {
  if (runtime) return runtime
  if (!runtimePending) {
    runtimePending = createChatRuntime({
      userDataDir: app.getPath('userData'),
      // ★ 票 09：会话与 JSONL 落 `<userData>/students/<id>/pi-agent/`（一人一份，显式改道）
      studentId: resolveActiveStudentId()
    })
      .then((instance) => {
      const llm = await refreshRuntimeLlmConfig()
        runtime = instance
        return instance
      })
      .finally(() => {
        runtimePending = null
      })
  }
  return await runtimePending
}

 *   渲染进程一挂载就会读学段（只读徽章），那条路径也走 `ensureChatRuntime()`，
 * 拿到了就 `applyLlmConfig()` 切过去，没拿到就什么都不做（下一轮再试）。
  let llm: RuntimeLlmConfig | null = null
    llm = await refreshRuntimeLlmConfig()
    await runtime.applyLlmConfig({
  llm: RuntimeLlmConfig | null
/**
 * ★ `before-quit` 必须调用它（`session.dispose()` → JSONL flush）。
 * 幂等：重复调用安全（`ChatRuntime.dispose()` 自身也幂等）。
 * ★★ **必须等「正在装配中」的会话**（G1）：渲染进程一挂载就读学段 → `ensureChatRuntime()`，
 */
export async function disposeChatRuntime(): Promise<void> {
  const instance = runtime
  runtime = null
  if (!instance) return
  await instance.dispose()
}

/** 诊断用：会话是否已装配（不暴露 Pi 对象本身）。 */
export function isChatRuntimeReady(): boolean {
  return runtime !== null
}

/**
 * 返回值里绝不带 token —— `SidecarState` 结构上就没有 token 字段（别在票 02 里加回来）。
 */
export function registerIpcHandlers(sidecar: SidecarManager): void {
  ipcMain.handle(IPC.sidecarGetInfo, (): SidecarState => sidecar.getState())

  ipcMain.handle(IPC.chatSend, (event, payload: unknown): ChatSendResult => {
    const parsed = parseChatSendRequest(payload)
    if (!parsed.ok) return { ok: false, requestId: null, message: parsed.message }

    // 请求号由主进程生成，并贯穿本轮全部事件（`done` 另带 `messageId`）
    const handle = chatStreams.open(toStreamTarget(event.sender), parsed.request.text)

    // ★ 真实数据源：Pi 的 `message_update` / `tool_execution_end` / `agent_end`
    //   → 6 事件（映射表在 `agent/events.ts`）。这里只启动，回执立即返回给渲染进程。
    //   ★ 学段**不再随请求传入**：`parsed.request.gradeLevel` 已不是权威值（学段由推断系统
    //     在 `extensions/grade.ts` 的 `before_agent_start` 里决定），所以这里只递文本。
    void runChatTurn(parsed.request.text, handle)
    return { ok: true, requestId: handle.requestId, message: null }
  })

  // ★ 退出兜底（幂等）——**与 `src/main/index.ts` 的 `before-quit` 并存是刻意的**：
  //   入口那份负责「先 flush Pi 会话、再停 sidecar」的**顺序**（Tool 可能是最后一个 `/api` 调用方）；
  //   这一份负责「入口的接线被误删时 JSONL 仍不半写」。`disposeChatRuntime()` 自身幂等，
  //   两次调用只会 dispose 一次（`ChatRuntime.dispose()` 有 `disposed` 标记）。
  //   自带 `.catch`：退出路径上没人接这个 Promise，兜底自己绝不能变成 unhandled rejection。
  app.on('before-quit', () => {
    void disposeChatRuntime().catch((error: unknown) => {
      console.error('[main] Pi 会话兜底收尾异常（继续退出）：', error)
    })
  })

  // ── 设置域（票 07：渲染进程 → IPC → 主进程 → sidecar，渲染进程永远看不到 token）──
  //
  // 三条都是 **invoke**（有回执），所以**不登记**进 `PUSH_CHANNELS`。
  // 处理器一律不抛异常：失败也回一句可读中文（`SettingsCallResult` 的判别联合）。
  // 请求出口只有 `bridge/client.ts` 的 `apiFetch`（它负责注入 `X-Auth-Token`），
  // 本文件里不出现任何地址、也不出现任何 `fetch(`（守卫 G5 会当场拦下）。

  ipcMain.handle(IPC.settingsRead, async (): Promise<SettingsCallResult<SettingsSnapshot>> => {
    try {
      const response = await apiFetch('/api/settings', {
        method: 'GET',
        signal: AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) {
        return { ok: false, message: `读取设置失败（HTTP ${response.status}）：${await readDetail(response)}` }
      }
      const data = (await response.json()) as unknown
      if (!isSettingsSnapshot(data)) {
        return { ok: false, message: '读取设置失败：后端回执不符合契约（缺 llm / embedding 两栏）。' }
      }
      return { ok: true, data }
    } catch (error) {
      return { ok: false, message: `读取设置失败：${describeError(error)}` }
    }
  })

  ipcMain.handle(
    IPC.settingsSave,
    async (_event, payload: unknown): Promise<SettingsCallResult<SettingsSnapshot>> => {
      // 入参形状不合法（被篡改 / 渲染进程 bug）：给可读回执，别让 body 变成 "undefined"
      if (typeof payload !== 'object' || payload === null) {
        return { ok: false, message: '保存设置失败：请求体不是对象（渲染进程传参有误）。' }
      }

      try {
        const response = await apiFetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload as SettingsUpdateRequest),
          signal: AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS)
        })
        if (!response.ok) {
          return { ok: false, message: `保存设置失败（HTTP ${response.status}）：${await readDetail(response)}` }
        }
        const data = (await response.json()) as unknown
        if (!isSettingsSnapshot(data)) {
          return { ok: false, message: '保存设置失败：后端回执不符合契约（缺 llm / embedding 两栏）。' }
        }
        await applySavedLlmConfig()
        return { ok: true, data }
      } catch (error) {
        return { ok: false, message: `保存设置失败：${describeError(error)}` }
      }
    }
  )

  ipcMain.handle(
    IPC.settingsProbe,
    async (_event, payload: unknown): Promise<SettingsCallResult<ProbeResult>> => {
      // 探测要真的发一次外呼（DNS + TLS + 首字节），所以超时给得比读写宽：
      // 15s 是「校园网慢但能用」与「不把设置页吊死」的折中。
      if (typeof payload !== 'object' || payload === null) {
        return { ok: false, message: '探测失败：请求体不是对象（渲染进程传参有误）。' }
      }

      try {
        const response = await apiFetch('/api/settings/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload as ProbeRequest),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
        })
        if (!response.ok) {
          return { ok: false, message: `探测请求失败（HTTP ${response.status}）：${await readDetail(response)}` }
        }
        const data = (await response.json()) as unknown
        if (typeof data !== 'object' || data === null || typeof (data as ProbeResult).ok !== 'boolean') {
          return { ok: false, message: '探测失败：后端回执不符合契约（缺 ok 字段）。' }
        }
        // ★ 探测的「失败」不是 IPC 失败：`ok:false` + 可读 message 要原样交给界面回显
        //   （401 / 超时 / DNS / 404 各有各的说法，不能只吐一个 false）。
        return { ok: true, data: data as ProbeResult }
      } catch (error) {
        return { ok: false, message: `探测请求失败：${describeError(error)}` }
      }
    }
  )

   * Pi 内置供应商预设（离线可用的端点 + 模型清单）。
    IPC.settingsProviderCatalog,
    async (): Promise<SettingsCallResult<ProviderCatalogEntry[]>> => {
        const catalog = await builtinCatalog(app.getPath('userData'))
        return { ok: false, message: `读取 Pi 内置供应商预设失败：${describeError(error)}` }
   * 拉取模型清单：**端点实时结果 + Pi 内置预设** 合并去重。
    IPC.settingsFetchModels,
    async (_event, payload: unknown): Promise<SettingsCallResult<FetchModelsResult>> => {
        return { ok: false, message: '拉取模型失败：请求体不是对象（渲染进程传参有误）。' }
        const catalog = await builtinCatalog(app.getPath('userData'))
      let message = '没能连上该地址拉取模型清单。'
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
          message = `拉取模型失败（HTTP ${response.status}）：${await readDetail(response)}`
        message = `拉取模型失败：${describeError(error)}`
      const candidates = mergeModelCandidates(preset, endpoint)
  // ------------------------------------------------------------------ 代码执行
  // 渲染进程回传结果 → 兑现主进程侧挂着的 Promise（按 requestId 配对）
  ipcMain.handle(IPC.codeResult, (_event, payload: unknown): boolean => {
    try {
      return rendererCodeRunner.settle(payload as CodeExecuteResult)
    } catch (error) {
      console.error('[main] 代码执行结果处理异常：', error)
      return false
    }
  })

  // ---------------------------------------------------------------- 学段（只读）
  // ---------------------------------------------------------------- 学段（读 + 一条写）
  // ★ 写：只有一条，走 `grade:set`（见下方）；**绝不混进 `ChatSendRequest`** ——
  //   那个请求的字段集合被守卫 G6c 钉死为 `['text']`，学段一旦混进去，
  //   每轮对话都会顺带写一次学段，「发消息」与「改学段」两件事就再也分不开了。
  ipcMain.handle(IPC.gradeGet, async (): Promise<GradeCallResult<GradeState>> => {
    let instance: ChatRuntime
    try {
      instance = await ensureChatRuntime()
    } catch (error) {
      return { ok: false, message: `读学段失败：对话运行时尚未就绪（${describeRuntimeFailure(error)}）` }
    }
    const state = await readGradeState(instance)
    if (!state) {
      return { ok: false, message: '读学段失败：本地数据服务没有返回学段状态。' }
    }
    currentGrade = state
    return { ok: true, data: state }
  })
   * ★ 学生**手动设定学段**（唯一的人工作用点）。
   * 三件事的顺序（与 `ChatRuntime.setGradeLevel` 的分工）：
   *   ① 入参**白名单校验**：渲染进程递来的值一律不信任（`readGradeLevel` 认不出就拒），
    IPC.gradeSet,
    async (_event, payload: unknown): Promise<GradeCallResult<GradeSetResult>> => {
      const level = readGradeLevel((payload as { gradeLevel?: unknown } | undefined)?.gradeLevel)
        return { ok: false, message: '设定学段失败：学段取值不合法（只接受四个学段之一）。' }
          message: `设定学段失败：对话运行时尚未就绪（${describeRuntimeFailure(error)}）`
        const result = await instance.setGradeLevel(level)
        //   带上 `source: 'explicit'`，让指示器说的是「你选的」而不是「AI 推的」。
        pushGradeState({ gradeLevel: level, origin: 'explicit', source: 'explicit' })
        return { ok: false, message: '设定学段失败：' + (error instanceof Error ? error.message : String(error)) }
  // ---------------------------------------------------------------- 教材章节（读 + 一条写）
  // ★ 与学段那一对**完全对称**：读一条、写一条、写成功即推。
  //   章节一旦混进去，「发一条消息」就会顺带改一次章节（学生的显式选择退化成聊天的副作用）。
  // ★ 章节是**软偏好**：它进每轮 System Prompt 让回答优先围绕本章，但**不进检索契约**。
  //   与 Pi 会话无关（拉 Pi 进来还会让「刚启动就点章节」受装配竞态牵连）。
  ipcMain.handle(IPC.chapterGet, async (): Promise<ChapterCallResult<ChapterState>> => {
    const result = await fetchChapterState(resolveActiveStudentId())
    const state = readChapterState(result.data)
    if (!state) return { ok: false, message: '读章节失败：本地数据服务没有返回章节状态。' }
    currentChapter = state
   * ★ 学生**手动选定当前教材章节**（写入的唯一入口）。
   * ② 写 sidecar（服务端还会按**当前学段**的章节清单核一次，不认识的章 422）；
   * ③ 成功后**立刻推一条 `chapter:changed`**，指示器无需轮询就更新。
   * ⚠️ 空串是**合法入参**（= 清除，回到「不限章节，自由问答」），不是「没填」：
   *   它必须能穿过校验，否则学生选了章节就再也回不到自由问答。
    IPC.chapterSet,
    async (_event, payload: unknown): Promise<ChapterCallResult<ChapterSetResult>> => {
      const title = readChapterTitle((payload as { chapterTitle?: unknown } | undefined)?.chapterTitle)
            '设定章节失败：章节标题不合法（只能是最多 ' +
            `${CHAPTER_TITLE_MAX_CHARS} 个字的文本；要取消选择请传空串）。`
      const result = await saveChapterState(resolveActiveStudentId(), title)
      const state = readChapterState(result.data)
      if (!state) return { ok: false, message: '设定章节失败：本地数据服务没有返回章节状态。' }
      pushChapterState(state)
      return { ok: true, data: { chapterTitle: state.chapterTitle } }
  registerStudyHandlers()
  registerSessionHandlers()
  registerExportHandler()
 * 学习档案（章节 / 报告 / 错题本 / 学习地图）
function registerStudyHandlers(): void {
    IPC.studyReport,
    async (_event, payload: unknown): Promise<StudyCallResult> => {
      const days = readReportDays((payload as StudyReportRequest | undefined)?.days)
        return { ok: false, message: `报告天数不合法：${STUDY_MAX_REPORT_DAYS} 天以内、且必须是整数。` }
      return await fetchStudyJson(studyReportPath(studentId(), days))
  ipcMain.handle(IPC.studyMistakes, async (): Promise<StudyCallResult> => {
    return await fetchStudyJson(studyMistakesPath(studentId()))
    [IPC.studyChapters, studyChaptersPath],
    [IPC.studyGraph, studyGraphPath]
    ipcMain.handle(channel, async (_event, payload: unknown): Promise<StudyCallResult> => {
      const level = readStudyGradeLevel((payload as StudyGradeRequest | undefined)?.gradeLevel)
          message: `学段不合法（允许：${STUDY_GRADE_LEVELS.join(' / ')}）。`
      // 带上学生：章节要显示「3/5 已掌握」、地图要标注哪些已掌握。
      return await fetchStudyJson(buildPath(level, studentId()))
 * 历史会话（**只读回看**）
 *   那是另一件事（见 `main/study/sessions.ts` 的文件头）。
function registerSessionHandlers(): void {
  ipcMain.handle(IPC.sessionList, async (): Promise<StudyCallResult> => {
    return { ok: true, data: projectSessionList(loaded.infos) }
  ipcMain.handle(IPC.sessionTranscript, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const info = findSessionById(loaded.infos, id)
  ipcMain.handle(IPC.sessionSearch, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const query = typeof (payload as SessionSearchRequest | undefined)?.query === 'string'
      ? (payload as SessionSearchRequest).query
    return { ok: true, data: searchSessions(loaded.infos, query) }
/** 列出当前学生的历史会话（走 Pi 的 `SessionManager.list`，目录**显式**指向该学生）。 */
  { ok: true; infos: Awaited<ReturnType<typeof listStudentSessions>> } | { ok: false; message: string }
    const infos = await listStudentSessions(app.getPath('userData'), resolveActiveStudentId())
    return { ok: false, message: `读取历史会话失败：${describeRuntimeFailure(error)}` }
}): Promise<StudyCallResult> {
    const entries = await readStudentSessionEntries(
    const projected = projectTranscript(entries)
    const transcript: SessionTranscript = {
      title: truncateChars(info.path.split(/[/\\]/).pop() ?? info.id, TITLE_MAX_CHARS),
 * 导出（报告 / 错题本 → Markdown 文件）
function registerExportHandler(): void {
  ipcMain.handle(IPC.fileExport, async (event, payload: unknown): Promise<FileExportResult> => {
    const clean = payload as FileExportRequest | undefined
      return { ok: false, message: '导出失败：没有内容可导出。' }
    if (clean.content.length > MAX_EXPORT_CHARS) {
      return { ok: false, message: `导出失败：内容过长（上限 ${MAX_EXPORT_CHARS} 字）。` }
    const fileName = sanitizeFileName(clean.fileName)
    const content = normalizeExportContent(clean.content)
      title: '导出学习档案',
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
      // 用户取消**不是错误**：回一个带 `canceled` 的失败，界面据此不弹「导出失败」
      return { ok: false, message: '已取消导出。', canceled: true }
      // UTF-8 无 BOM + LF（`normalizeExportContent` 已统一换行）
      writeFileSync(picked.filePath, content, { encoding: 'utf8' })
}

/** 读/存设置的单次请求超时（本机回环，正常在毫秒级；超了就是 sidecar 卡住）。 */
const SETTINGS_REQUEST_TIMEOUT_MS = 8000
/** 连通性探测的超时：真的要走一次外呼，宽一些。 */
const PROBE_TIMEOUT_MS = 15_000

async function applySavedLlmConfig(): Promise<void> {
  let llm: RuntimeLlmConfig | null
    llm = await refreshRuntimeLlmConfig()
    await instance.applyLlmConfig({
/** 后端回执的最小形状检查（不通过就报可读错误，别让界面拿半个对象去渲染）。 */
function isSettingsSnapshot(value: unknown): value is SettingsSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { llm?: unknown; embedding?: unknown }
  return typeof record.llm === 'object' && record.llm !== null && typeof record.embedding === 'object' && record.embedding !== null
}

/**
 * 把非 2xx 回执变成一句人话。
 *
 * FastAPI 的错误体是 `{"detail": "..."}`（鉴权失败、422、500 都是这个形状）；
 * 兜底取 `message` 字段，再兜底取截断后的原文（**绝不把整页 HTML 塞进 UI**）。
 */
async function readDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return '后端没有给出说明'
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown }
      const detail = parsed.detail ?? parsed.message
      if (typeof detail === 'string' && detail.trim() !== '') return clip(detail)
      // 422 的 detail 是数组（pydantic 校验错误），说清「字段在哪」比吐 JSON 有用
      if (Array.isArray(detail)) {
        const first = detail[0] as { loc?: unknown; msg?: unknown } | undefined
        const field = Array.isArray(first?.loc) ? first?.loc.filter((part) => part !== 'body').join('.') : ''
        const message = typeof first?.msg === 'string' ? first.msg : '校验未通过'
        return clip(field ? `${field}：${message}` : message)
      }
    } catch {
      // 回执不是 JSON（网关页面 / 代理错误）：原文截断即可
    }
    return clip(text)
  } catch {
    return '后端回执无法读取'
  }
}

/** 异常 → 可读中文（区分「sidecar 没起来」「超时」「网络异常」三类，排查方向完全不同）。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时（本地数据服务没有在超时时间内响应）。'
    if (error.name === 'AbortError') return '请求被取消。'
    if (error.message.includes('sidecar 尚未就绪')) {
      return '本地数据服务（sidecar）尚未就绪：请等界面上的状态变成「已就绪」后重试。'
    }
    return error.message
  }
  return String(error)
}

/** 单行化 + 截断（错误行要能进状态栏，不能是一条 2KB 的 JSON）。 */
function clip(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 200 ? `${single.slice(0, 200)}…` : single
}

/**
 * 跑一轮对话：装配会话 → 把 6 事件投给本轮句柄。
 *
 * ★ 失败必须变成一条**可读的 `error` 事件**（`degraded: true`），且文案要能**区分两类问题**：
 *   - 「缺 Key / 连不上模型」→ 配置或网络问题（`agent/runtime.ts` 给文案）；
 *   - 「Pi 装配不起来」（打包缺 esbuild、Node 版本不符…）→ **运行时故障**，文案里明说。
 *   混淆这两者会让排查方向彻底跑偏（票 03 踩过：把认证失败读成流式没通）。
 */
async function runChatTurn(text: string, handle: TurnHandle): Promise<void> {
  let instance: ChatRuntime
  try {
    instance = await ensureChatRuntime()
  } catch (error) {
    // ★ 装配失败 = 运行时故障（**不是**缺 Key）：文案与降级标记都要能区分
    handle.emit({ name: 'error', data: { message: describeRuntimeFailure(error), degraded: false } })
    handle.emit({ name: 'done', data: { messageId: `turn:${handle.requestId}` } })
    handle.finish()
    console.error('[main] Pi 会话装配失败：', error)
    return
  }

  try {
    const outcome = await instance.runTurn({ text }, handle)
    if (!outcome.ok && outcome.detail) {
      // 结论只进 stderr（面向排查），UI 那一份文案由 runtime 通过 6 事件给出
      console.warn(`[main] 本轮结论：${outcome.status} —— ${outcome.detail}`)
    }
    // ★ 学段是**推断**出来的：每轮结束后读一次 sidecar 的真值，变了才推送。
    //   放在本轮之后（不是之前）—— 推断的输入就是这一轮的内容。
    //
    // ★★ 必须先 `flushGrades()`（票 21 返工）：`grade.ts` 的观察是**本轮开始时**
    //   发起、**不阻塞本轮对话**的（fire-and-forget）。不 flush 就直接读库，
    //   读到的是**上一轮**的结论 —— 只读徽章会永远慢一拍（实测过：连发三句
    //   递进提问，界面始终停在第一次的学段上）。flush 内部已兜异常，不会抛。
    //   注意：这不是「本轮生效」—— 服务端判出的新学段**下一轮**才进 system prompt，
    //   但**徽章应当立刻反映已落库的真值**（学生看得见系统的适配）。
    await instance.flushGrades().catch(() => {})
    pushGradeState(await readGradeState(instance))
  } catch (error) {
    // 兜底：runTurn 自己已经兜了异常，这里防的是「兜底逻辑本身出错」——绝不让它冒成未捕获异常
    const message = error instanceof Error ? error.message : String(error)
    handle.emit({ name: 'error', data: { message: `本轮没能完成（内部异常）：${message}`, degraded: false } })
    handle.emit({ name: 'done', data: { messageId: `turn:${handle.requestId}` } })
    handle.finish()
    console.error('[main] 对话轮次异常：', error)
  }
}

/**
 * `webContents` → `StreamTarget` 适配器。
 * 只在这里碰 electron：销毁后不再 `send`（对已销毁 webContents 调用会抛异常），
 * `destroyed` 监听的注销由 registry 负责（无活跃轮次即注销）。
 */
function toStreamTarget(webContents: WebContents): StreamTarget {
  return {
    id: webContents.id,
    isDestroyed: () => webContents.isDestroyed(),
    send: (event) => {
      if (webContents.isDestroyed()) return
      webContents.send(IPC.chatEvent, event)
    },
    onDestroyed: (listener) => {
      webContents.on('destroyed', listener)
    },
    offDestroyed: (listener) => {
      webContents.removeListener('destroyed', listener)
    }
  }
}
