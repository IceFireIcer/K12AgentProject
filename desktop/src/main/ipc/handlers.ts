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
import {
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
  type SettingsUpdateRequest,
  type StudyCallResult,
  type StudyGradeRequest,
  type StudyReportRequest
} from './channels.ts'
// 学习档案的取数层（路径工厂 + 归一化；聚合全在 Python）
import {
  STUDY_GRADE_LEVELS,
  STUDY_MAX_REPORT_DAYS,
  fetchStudyJson,
  readReportDays,
  readStudyGradeLevel,
  studyChaptersPath,
  studyGraphPath,
  studyMistakesPath,
  studyReportPath
} from '../study/client.ts'
// 当前教材章节（软偏好；读写只有这一处实现）
import {
  CHAPTER_TITLE_MAX_CHARS,
  fetchChapterState,
  readChapterTitle,
  saveChapterState
} from '../study/chapter.ts'
// 历史会话：投影/搜索是纯函数；`listStudentSessions` / `readStudentSessionEntries` 才碰 Pi
import {
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
// ★ 候选合并的实现放在 `@shared/provider-catalog`：渲染进程要在切换预设时就地重算，
//   两处各写一份的话规则会悄悄分叉（见那个文件的注释）。这里直接 import 共用。
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
 * ★ 写入只有一条，走 `grade:set`（见下面的 handler）：学生显式设定学段时，
 *   主进程先写库、再让扩展层立即生效，最后推一条 `grade:changed`。
 *   **绝不混进 `ChatSendRequest`** —— 那个请求只有 `text`（守卫 G6c 钉着）。
 * ★ 缓存只为「值没变就不推送」，真值永远以 sidecar 的 `learning.db` 为准。
 */
let currentGrade: GradeState | null = null

/** 四学段字面量（与 `shared/ipc-events.ts` 的 `GradeLevel` 同源，此处只做运行期校验）。 */
const GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior'] as const

/** 字符串 → 学段（认不出返回 `null`，不映射、不猜测、不兜底成最近的一个）。 */
function readGradeLevel(value: unknown): GradeState['gradeLevel'] | null {
  return typeof value === 'string' && (GRADE_LEVELS as readonly string[]).includes(value)
    ? (value as GradeState['gradeLevel'])
    : null
}

/**
 * 从 sidecar 读当前学段。
 *
 * ★ `origin` 的判定是刻意的：
 *   - `source === 'explicit'` → `explicit`（学生手动选的）；
 *   - 否则 `lastTurn > 0` 表示**发生过推断** → `inferred`；
 *   - 都没有 → `default`（冷启动默认值），前端渲染成「待判定」而不是假装系统已经判过。
 *
 * ★ **来源以服务端 `GradeStateOut.source` 为准，前端/主进程都不自己猜**：
 *   猜错的方向只有一个 —— 把「学生手动选的」显示成「AI 推的」，那会让唯一的人工入口
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
    //   `renderer/src/api/grade.ts`、`renderer/src/api/events.ts`）都做了白名单，主进程这一侧
    //   不能漏 —— 否则后端字段风格一变（或中间插一手中文标签），只读徽章就会显示一个
    //   不存在的学段，而 `as GradeState['gradeLevel']` 这种断言让 TypeScript 完全看不见。
    const gradeLevel = readGradeLevel(body.grade)
    if (gradeLevel === null) return null
    const lastTurn = typeof body.lastTurn === 'number' ? body.lastTurn : 0
    // ★ 读的是契约里**真实存在**的 `GradeStateOut.source`（写入来源，例如 `inferred` / `explicit`）。
    //   历史上这里是 `reason` —— 后端回执里根本没有这个字段（它只出现在
    //   `/api/grade/turns` 的响应里），所以那个字段**恒为 null**，是个死字段。
    const source =
      typeof body.source === 'string' && body.source.trim().length > 0 ? body.source.trim() : null
    // ★ 来源一律**透传服务端**，主进程不自己猜：猜错的唯一方向是把「学生手动选的」
    //   显示成「AI 推的」，那会让唯一的人工入口在界面上隐身。
    return {
      gradeLevel,
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

/**
 * 当前教材章节（**读**给界面用），与 {@link currentGrade} 并列。
 *
 * ★ 写入只有一条，走 `chapter:set`（见下面的 handler）：学生显式选定某一章时，
 *   主进程写库、然后用服务端回执推一条 `chapter:changed`。
 *   **绝不混进 `ChatSendRequest`** —— 那个请求只有 `text`（守卫 G6c 钉着）。
 * ★ 缓存只为「值没变就不推送」，真值永远以 sidecar 的 `learning.db` 为准。
 * ★ 章节是**软偏好**：它进每轮 System Prompt，但**不进检索契约、不做 SQL 硬过滤**。
 */
let currentChapter: ChapterState | null = null

/**
 * 把 sidecar 回执归一成 {@link ChapterState}（两栏都过白名单，认不出回 `null`）。
 *
 * ★ 与 `readGradeState` 同一纪律：**主进程这一侧也要校验**，不拿 `as` 断言糊过去 ——
 *   后端字段风格一变，指示器就会显示一个不存在的学段或一段脏标题，而 TypeScript 看不见。
 * ★ 标题认不出（非 string / 超长）时**当作「未选择」**（空串）而不是整条失败：
 *   指示器上少一行无关紧要，因为一个脏标题把整块状态打成错误才是更坏的结果。
 */
function readChapterState(value: unknown): ChapterState | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { gradeLevel?: unknown; chapterTitle?: unknown }
  const gradeLevel = readGradeLevel(record.gradeLevel)
  if (gradeLevel === null) return null
  return { gradeLevel, chapterTitle: readChapterTitle(record.chapterTitle) ?? '' }
}

/** 值变了才推送 —— 与 {@link pushGradeState} 同一手法（否则指示器会反复闪动）。 */
function pushChapterState(next: ChapterState | null): void {
  if (!next) return
  const unchanged =
    currentChapter !== null &&
    currentChapter.gradeLevel === next.gradeLevel &&
    currentChapter.chapterTitle === next.chapterTitle
  if (unchanged) return
  currentChapter = next
  for (const window of BrowserWindow.getAllWindows()) {
    const webContents = window.webContents
    if (webContents.isDestroyed()) continue
    webContents.send(IPC.chapterChanged, next)
  }
}

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

/**
 * ★★ 会话**代际**：每次 `disposeChatRuntime()` 都 +1。
 *
 * 为什么需要它 —— 装配是异步的（要先去 sidecar 读设置），而渲染进程一挂载就会读学段
 * （只读徽章 → `gradeGet` → `ensureChatRuntime()`），所以**每次启动都必然有一次装配在飞行中**。
 * 学生此时关窗 → `before-quit` 走 `disposeChatRuntime()`，而那一刻 `runtime` 还是 `null`，
 * 装配出来的 `AgentSession` 就成了没人认领的孤儿：`session.dispose()`（JSONL flush）永不执行
 * —— 这正是「`session.dispose()` 必须在 `before-quit` 调用，否则 JSONL 可能半写」这条硬约束
 * 被绕过的**唯一窗口**（窗口内 sidecar 已被杀，装配后续还在写 `students/<id>/pi-agent/`）。
 *
 * 处置：装配完成时比对代际；不一致就说明「装配期间被销毁过」——**就地 dispose 并绝不写回单例**
 * （见 `ensureChatRuntime`），同时抛一句可读中文让调用方走各自的失败分支。
 */
let runtimeGeneration = 0

/** 装配结果已被销毁（代际变了）时抛出的可读错误：调用方不该拿到一个已经 dispose 的会话。 */
export const RUNTIME_SUPERSEDED_MESSAGE =
  '对话会话在装配完成前就被销毁了（通常是应用正在退出），本次不会返回可用会话。'

/**
 * 会话工厂的**注入点**（默认 `null`，生产路径恒为 `null`）。
 *
 * 存在的唯一理由：单测要能造一个「**可控延迟**」的装配来复现上面那条竞态
 * （装配在飞行中 → `disposeChatRuntime()` → 断言替身产出的实例仍被 dispose 过一次）。
 * 生产行为与直接调用 `createChatRuntime` 一字不差。
 */
let chatRuntimeFactoryOverride:
  | ((options: Parameters<typeof createChatRuntime>[0]) => Promise<ChatRuntime>)
  | null = null

/** 仅供测试：注入替身工厂；传 `null` 复位（生产路径永远是真实的 `createChatRuntime`）。 */
export function setChatRuntimeFactoryForTests(
  factory: ((options: Parameters<typeof createChatRuntime>[0]) => Promise<ChatRuntime>) | null
): void {
  chatRuntimeFactoryOverride = factory
}

/**
 * 取当前会话（没有就装配）。**Pi 只在真的发消息时被加载**。
 * `userDataDir` 用 Electron 的 `app.getPath('userData')`，绝不回退 `~/.pi`（票 03/09 的硬约束）。
 *
 * ★★ **启动先读配置**（本项目「设置即权威」的落点）：装配前先从 sidecar 取一次
 * 「生效中的 LLM 配置」（`config.json`，含明文 Key），把它交给 `createChatRuntime`。
 * 于是「设置页改完 → 关掉应用 → 再打开」用的是**新配置**，而不是内置默认值。
 *
 * ⚠️ 取不到就**回落内置默认值照常装配**（`refreshRuntimeLlmConfig` 内部已兜异常并返回 `null`）：
 * 本地数据服务没起来时对话仍要能跑，并给出「缺 Key」这类可读提示 —— 不能白屏。
 * 这种「降级装配」会被记进 {@link runtimeConfigDegraded}，由 {@link ensureRuntimeConfigApplied}
 * 在下一个真实回合前补上配置（见那个函数的注释：这是实测踩到的启动竞态）。
 */
export async function ensureChatRuntime(): Promise<ChatRuntime> {
  if (runtime) return runtime
  if (!runtimePending) {
    // ★ 记下本次装配开始时的代际：装配期间被 dispose 过就作废（见 runtimeGeneration 的注释）
    const generation = runtimeGeneration
    runtimePending = (async () => {
      const llm = await refreshRuntimeLlmConfig()
      // ★ 记住这次是不是「拿不到配置」的降级装配 —— 单看 `runtime !== null` 是分不出来的。
      runtimeConfigDegraded = llm === null
      // 注入点（生产恒为 null，见 setChatRuntimeFactoryForTests）
      if (chatRuntimeFactoryOverride) {
        return await chatRuntimeFactoryOverride(chatRuntimeOptionsFromLlm(llm))
      }
      return await createChatRuntime(chatRuntimeOptionsFromLlm(llm))
    })()
      .then(async (instance) => {
        // ★★ 装配期间被 dispose 过（代际变了）：**就地收尾，绝不写回单例**。
        //   写回的话这个实例就再也没人 dispose —— JSONL 会半写（本文件顶部那条硬约束）。
        if (generation !== runtimeGeneration) {
          await disposeOrphanRuntime(instance)
          throw new Error(RUNTIME_SUPERSEDED_MESSAGE)
        }
        runtime = instance
        return instance
      })
      .finally(() => {
        runtimePending = null
      })
  }
  return await runtimePending
}

/**
 * 收尾一个「装配完成时才发现自己已被销毁」的实例。
 *
 * 这里**只记日志、不抛**：调用方拿到的是 {@link RUNTIME_SUPERSEDED_MESSAGE}（可读中文），
 * 而这条 dispose 是尽力而为的收尾 —— 它失败时能做的也只有留痕。
 */
async function disposeOrphanRuntime(instance: ChatRuntime): Promise<void> {
  try {
    await instance.dispose()
    console.warn('[main] 装配期间会话已被销毁：已就地 dispose（Pi JSONL 已 flush，未写入单例）。')
  } catch (error) {
    console.error('[main] 装配期间被销毁的会话收尾失败（继续退出）：', error)
  }
}

/**
 * ★★ 本次会话是不是「没读到设置」装配出来的（降级）。
 *
 * 为什么需要这个标记 —— **实测踩到的启动竞态**：
 *   渲染进程一挂载就会读学段（只读徽章），那条路径也走 `ensureChatRuntime()`，
 *   而它**早于 sidecar 就绪**。于是会话被用内置默认值建出来并缓存，此后
 *   `ensureChatRuntime()` 直接返回这个实例 —— 用户设置的供应商/端点/Key
 *   **在本次运行里永远不生效**（表现为「设置明明存住了，重启后却没用上」）。
 *
 * 所以：降级装配要能被后续事件**补上**（{@link ensureRuntimeConfigApplied}）。
 */
let runtimeConfigDegraded = false

/**
 * 若本次会话是降级装配的，而现在拿得到设置了，就**补一次热应用**（幂等，便宜）。
 *
 * 调用点：每轮对话开始前（`runChatTurn`）。那时 sidecar 多半已经就绪；
 * 拿到了就 `applyLlmConfig()` 切过去，没拿到就什么都不做（下一轮再试）。
 * **绝不抛异常** —— 它在对话路径上，不能因为配置补齐失败就把这一轮带崩。
 */
export async function ensureRuntimeConfigApplied(): Promise<void> {
  if (!runtimeConfigDegraded || !runtime) return

  let llm: RuntimeLlmConfig | null = null
  try {
    llm = await refreshRuntimeLlmConfig()
  } catch {
    return
  }
  if (!llm) return

  try {
    await runtime.applyLlmConfig({
      providerId: llm.providerId,
      providerName: llm.providerName,
      baseUrl: llm.baseUrl,
      modelId: llm.modelId,
      apiKey: llm.apiKey || undefined
    })
    runtimeConfigDegraded = false
    console.warn(
      `[main] 已补上启动时没读到的设置：provider=${llm.providerId} model=${llm.modelId}`
    )
  } catch (error) {
    // 补不上不拦本轮：下一轮再试（也可能是 Key 还没配，那本来就用不了）
    console.warn(
      `[main] 补配置失败（本轮仍用当前配置）：${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/**
 * 把「设置里的 LLM 配置」翻译成会话工厂的入参（纯函数，便于单测）。
 *
 * `null`（还没取到 / 取失败）→ 只给 `userDataDir` / `studentId`，
 * 其余走 `pi-bootstrap.ts` 的内置默认值 —— 与改造前的行为一致。
 */
export function chatRuntimeOptionsFromLlm(
  llm: RuntimeLlmConfig | null
): Parameters<typeof createChatRuntime>[0] {
  const base = {
    userDataDir: app.getPath('userData'),
    // ★ 票 09：会话与 JSONL 落 `<userData>/students/<id>/pi-agent/`（一人一份，显式改道）
    studentId: resolveActiveStudentId()
  }
  if (!llm) return base
  return {
    ...base,
    providerId: llm.providerId,
    providerName: llm.providerName,
    baseUrl: llm.baseUrl,
    modelId: llm.modelId,
    // 空串 = 未配置：不传，让 Key 解析链继续往下走（auth.json / 环境变量）
    apiKey: llm.apiKey || undefined,
    apiKeySource: llm.apiKey ? 'settings' : undefined
  }
}

/**
 * ★ `before-quit` 必须调用它（`session.dispose()` → JSONL flush）。
 * 幂等：重复调用安全（`ChatRuntime.dispose()` 自身也幂等）。
 *
 * ★★ **必须等「正在装配中」的会话**（G1）：渲染进程一挂载就读学段 → `ensureChatRuntime()`，
 *   所以每次启动都必然有一次装配在飞行中；学生此时关窗，`runtime` 还是 `null`，
 *   光看单例什么都不会发生 —— 装配出来的 `AgentSession` 就成了没人 dispose 的孤儿
 *   （JSONL 半写 + sidecar 已被杀但装配还在写 `students/<id>/pi-agent/`）。
 *   所以：① 先拨代际（装配完成时它会发现「已被销毁」并就地 dispose、不写回单例）；
 *   ② 再等它 settle —— 不等的话 `before-quit` 会在 flush 之前返回，`app.quit()` 直接把进程带走。
 */
export async function disposeChatRuntime(): Promise<void> {
  // ① 拨代际：让飞行中的装配自己收尾（见 runtimeGeneration 的注释）
  runtimeGeneration += 1

  const instance = runtime
  runtime = null
  // 下次装配重新判定（新实例可能是正常装配，也可能是又一次降级装配）
  runtimeConfigDegraded = false

  // ② 等飞行中的装配 settle：成功的那条路会自己 dispose（代际已变），失败也没有实例要收尾。
  //    这里**必须兜异常**：这条链可能是被本次 dispose 打断的那条（会抛 RUNTIME_SUPERSEDED_MESSAGE）。
  const pending = runtimePending
  if (pending) {
    try {
      await pending
    } catch {
      // 装配失败 / 装配期间被本次销毁作废：没有实例需要收尾
    }
  }

  if (!instance) return
  await instance.dispose()
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

        // ★★ **保存即生效**（本项目「设置改完不用重启」的落点）：
        //    刷新主进程缓存的运行时配置，并把它热应用到已经建好的会话上。
        //
        // ⚠️ 这一段**绝不能**把「保存成功」变成失败回执：配置已经落盘了，
        //    那是用户要的结果。热切换失败只是「当前这一轮还按旧配置」，退路有三层：
        //      ① 切换成功 → 下一条消息就用新配置（会话与对话历史都保留）；
        //      ② 切换失败 → 销毁会话，下一条消息按新配置**重建**（仍然生效，只是换新会话）；
        //      ③ 连销毁都失败 → 下次冷启动一定读到新配置（`ensureChatRuntime` 先读）。
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

  // ------------------------------------------------------------------ 预设 / 拉模型
  // ★ 这两条是**只读的辅助能力**（给设置页选端点与模型名用），不改配置、不落库。
  //   它们与「保存设置」分属两条链路：探测/拉取失败都不阻塞保存（离线场景）。

  /**
   * Pi 内置供应商预设（离线可用的端点 + 模型清单）。
   *
   * 数据源是 Pi 自己的目录，**只有主进程能读**（渲染进程没有 Node 能力）。
   * 读失败时给可读回执，设置页退化为「纯手填」——不白屏、不抛异常。
   */
  ipcMain.handle(
    IPC.settingsProviderCatalog,
    async (): Promise<SettingsCallResult<ProviderCatalogEntry[]>> => {
      try {
        const catalog = await builtinCatalog(app.getPath('userData'))
        return {
          ok: true,
          data: catalog.map((provider) => ({
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl ?? null,
            models: provider.models.map((model) => ({ id: model.id, name: model.name ?? model.id }))
          }))
        }
      } catch (error) {
        return { ok: false, message: `读取 Pi 内置供应商预设失败：${describeError(error)}` }
      }
    }
  )

  /**
   * 拉取模型清单：**端点实时结果 + Pi 内置预设** 合并去重。
   *
   * 为什么两个来源都要：端点诚实但常不可用（断网、服务没实现 `/models`、Key 还没填），
   * 而预设离线永远在。两者分开返回（`endpoint` / `preset`）让界面能如实标注来源，
   * 合并结果 `candidates` 直接用于渲染。
   */
  ipcMain.handle(
    IPC.settingsFetchModels,
    async (_event, payload: unknown): Promise<SettingsCallResult<FetchModelsResult>> => {
      if (typeof payload !== 'object' || payload === null) {
        return { ok: false, message: '拉取模型失败：请求体不是对象（渲染进程传参有误）。' }
      }

      const requested = payload as { llm?: { providerId?: unknown } }
      const providerId = typeof requested.llm?.providerId === 'string' ? requested.llm.providerId.trim() : ''

      // ① 预设清单（本地、离线、失败也不影响）
      let preset: string[] = []
      try {
        const catalog = await builtinCatalog(app.getPath('userData'))
        preset = catalog.find((provider) => provider.id === providerId)?.models.map((model) => model.id) ?? []
      } catch {
        // 目录读不到就只有端点结果（下面会说明来源）
      }

      // ② 端点实时清单（要真的外呼，超时给得比读写宽）
      let endpoint: string[] = []
      let message = '没能连上该地址拉取模型清单。'
      let ok = false
      try {
        const response = await apiFetch('/api/settings/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload as ProbeRequest),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
        })
        if (response.ok) {
          const data = (await response.json()) as { ok?: unknown; models?: unknown; message?: unknown }
          if (Array.isArray(data.models)) {
            endpoint = data.models.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
          }
          ok = data.ok === true
          message = typeof data.message === 'string' ? data.message : message
        } else {
          message = `拉取模型失败（HTTP ${response.status}）：${await readDetail(response)}`
        }
      } catch (error) {
        message = `拉取模型失败：${describeError(error)}`
      }

      const candidates = mergeModelCandidates(preset, endpoint)
      // 端点失败但预设可用：把话说全，免得用户以为「一个候选都没有」
      if (!ok && preset.length > 0) {
        message = `${message}（已列出 Pi 内置预设里该供应商的 ${preset.length} 个模型，可直接选用。）`
      }
      return { ok: true, data: { ok, message, endpoint, preset, candidates } }
    }
  )

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

  // ---------------------------------------------------------------- 学段（读 + 一条写）
  // ★ 读：界面挂载时拉一次当前值。
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

  /**
   * ★ 学生**手动设定学段**（唯一的人工作用点）。
   *
   * 三件事的顺序（与 `ChatRuntime.setGradeLevel` 的分工）：
   *   ① 入参**白名单校验**：渲染进程递来的值一律不信任（`readGradeLevel` 认不出就拒），
   *      绝不把 `'college'` 之类的东西写进库；
   *   ② 交给 runtime：写库 → 扩展层立即生效 → 重绑上下文；
   *   ③ 成功后**立刻推一条 `grade:changed`**，指示器无需轮询就更新。
   *
   * ⚠️ **绝不抛异常穿过 IPC**：渲染进程收到异常会渲染成一堆栈文本，
   *   而失败原因（值不合法 / 运行时没起来 / 服务端拒绝）都需要是可读中文 —— 与设置域同一纪律。
   */
  ipcMain.handle(
    IPC.gradeSet,
    async (_event, payload: unknown): Promise<GradeCallResult<GradeSetResult>> => {
      const level = readGradeLevel((payload as { gradeLevel?: unknown } | undefined)?.gradeLevel)
      if (level === null) {
        return { ok: false, message: '设定学段失败：学段取值不合法（只接受四个学段之一）。' }
      }
      let instance: ChatRuntime
      try {
        instance = await ensureChatRuntime()
      } catch (error) {
        return {
          ok: false,
          message: `设定学段失败：对话运行时尚未就绪（${describeRuntimeFailure(error)}）`
        }
      }
      try {
        const result = await instance.setGradeLevel(level)
        // ★ 立刻推（不等下一轮对话）：学生点完就要看到指示器变了 —— 那是这个动作的全部反馈。
        //   带上 `source: 'explicit'`，让指示器说的是「你选的」而不是「AI 推的」。
        pushGradeState({ gradeLevel: level, origin: 'explicit', source: 'explicit' })
        return { ok: true, data: result }
      } catch (error) {
        return { ok: false, message: '设定学段失败：' + (error instanceof Error ? error.message : String(error)) }
      }
    }
  )

  // ---------------------------------------------------------------- 教材章节（读 + 一条写）
  //
  // ★ 与学段那一对**完全对称**：读一条、写一条、写成功即推。
  //   **绝不混进 `ChatSendRequest`** —— 那个请求的字段集合被守卫 G6c 钉死为 `['text']`；
  //   章节一旦混进去，「发一条消息」就会顺带改一次章节（学生的显式选择退化成聊天的副作用）。
  // ★ 章节是**软偏好**：它进每轮 System Prompt 让回答优先围绕本章，但**不进检索契约**。
  //   所以这里既不拼检索参数也不做任何过滤 —— 软偏好就是软偏好。
  // ★ 这两条**不走 `ensureChatRuntime()`**：它们只读写 sidecar 的 `learning.db`，
  //   与 Pi 会话无关（拉 Pi 进来还会让「刚启动就点章节」受装配竞态牵连）。

  ipcMain.handle(IPC.chapterGet, async (): Promise<ChapterCallResult<ChapterState>> => {
    // ★ 学生身份由**主进程**决定（渲染进程递来的身份一律不信，见 DEFAULT_STUDENT_ID）
    const result = await fetchChapterState(resolveActiveStudentId())
    if (!result.ok) return { ok: false, message: result.message }
    const state = readChapterState(result.data)
    if (!state) return { ok: false, message: '读章节失败：本地数据服务没有返回章节状态。' }
    currentChapter = state
    return { ok: true, data: state }
  })

  /**
   * ★ 学生**手动选定当前教材章节**（写入的唯一入口）。
   *
   * 三步：① 入参**白名单校验**（渲染进程递来的值一律不当真，认不出就拒、**不抛异常**）；
   * ② 写 sidecar（服务端还会按**当前学段**的章节清单核一次，不认识的章 422）；
   * ③ 成功后**立刻推一条 `chapter:changed`**，指示器无需轮询就更新。
   *
   * ⚠️ 空串是**合法入参**（= 清除，回到「不限章节，自由问答」），不是「没填」：
   *   它必须能穿过校验，否则学生选了章节就再也回不到自由问答。
   */
  ipcMain.handle(
    IPC.chapterSet,
    async (_event, payload: unknown): Promise<ChapterCallResult<ChapterSetResult>> => {
      const title = readChapterTitle((payload as { chapterTitle?: unknown } | undefined)?.chapterTitle)
      if (title === null) {
        return {
          ok: false,
          message:
            '设定章节失败：章节标题不合法（只能是最多 ' +
            `${CHAPTER_TITLE_MAX_CHARS} 个字的文本；要取消选择请传空串）。`
        }
      }
      const result = await saveChapterState(resolveActiveStudentId(), title)
      if (!result.ok) return { ok: false, message: result.message }
      const state = readChapterState(result.data)
      if (!state) return { ok: false, message: '设定章节失败：本地数据服务没有返回章节状态。' }
      // ★ 立刻推（不等下一次读）：学生点完就要看到指示器变了 —— 那是这个动作的全部反馈。
      //   推送的值以**服务端回执**为准（标题的清洗口径在服务端）。
      pushChapterState(state)
      return { ok: true, data: { chapterTitle: state.chapterTitle } }
    }
  )

  registerStudyHandlers()
  registerSessionHandlers()
  registerExportHandler()
}

/* ------------------------------------------------------------------ *
 * 学习档案（章节 / 报告 / 错题本 / 学习地图）
 *
 * ★ 四条都是**纯转发**：聚合/排序/过滤全在 Python（数据域只在 Python）。
 * ★ 都是 invoke（有回执），不登记进 `PUSH_CHANNELS`。
 * ★ 一律不抛异常：失败回一句可读中文（与设置域三条同一纪律）。
 * ------------------------------------------------------------------ */
function registerStudyHandlers(): void {
  /** 学生 id 一律由**主进程**决定（不信任渲染进程递进来的身份，见 DEFAULT_STUDENT_ID 的注释）。 */
  const studentId = (): string => resolveActiveStudentId()

  ipcMain.handle(
    IPC.studyReport,
    async (_event, payload: unknown): Promise<StudyCallResult> => {
      const days = readReportDays((payload as StudyReportRequest | undefined)?.days)
      if (days === null) {
        return { ok: false, message: `报告天数不合法：${STUDY_MAX_REPORT_DAYS} 天以内、且必须是整数。` }
      }
      return await fetchStudyJson(studyReportPath(studentId(), days))
    }
  )

  ipcMain.handle(IPC.studyMistakes, async (): Promise<StudyCallResult> => {
    return await fetchStudyJson(studyMistakesPath(studentId()))
  })

  for (const [channel, buildPath] of [
    [IPC.studyChapters, studyChaptersPath],
    [IPC.studyGraph, studyGraphPath]
  ] as const) {
    ipcMain.handle(channel, async (_event, payload: unknown): Promise<StudyCallResult> => {
      const level = readStudyGradeLevel((payload as StudyGradeRequest | undefined)?.gradeLevel)
      if (!level) {
        return {
          ok: false,
          message: `学段不合法（允许：${STUDY_GRADE_LEVELS.join(' / ')}）。`
        }
      }
      // 带上学生：章节要显示「3/5 已掌握」、地图要标注哪些已掌握。
      // 学生 id 来自主进程（不是请求里的字段）—— 否则就是「谁的进度都能读」。
      return await fetchStudyJson(buildPath(level, studentId()))
    })
  }
}

/* ------------------------------------------------------------------ *
 * 历史会话（**只读回看**）
 *
 * ★ 不切会话、不写会话：切会话要 dispose 当前 runtime 并处理代际竞态，
 *   那是另一件事（见 `main/study/sessions.ts` 的文件头）。
 * ------------------------------------------------------------------ */
function registerSessionHandlers(): void {
  ipcMain.handle(IPC.sessionList, async (): Promise<StudyCallResult> => {
    const loaded = await loadSessions()
    if (!loaded.ok) return { ok: false, message: loaded.message }
    return { ok: true, data: projectSessionList(loaded.infos) }
  })

  ipcMain.handle(IPC.sessionTranscript, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const id = typeof payload === 'string' ? payload : ''
    if (!id) return { ok: false, message: '读会话失败：没有给出会话 id。' }
    const loaded = await loadSessions()
    if (!loaded.ok) return { ok: false, message: loaded.message }
    // ★★ 安全约束：id 必须先在**白名单**（Pi 自己列出来的会话）里对齐，
    //    然后用 Pi 给的 path 打开 —— 渲染进程永远无法指定一个路径。
    const info = findSessionById(loaded.infos, id)
    if (!info) return { ok: false, message: `读会话失败：找不到会话 ${id}（可能已被删除）。` }
    return await readTranscriptFrom(info)
  })

  ipcMain.handle(IPC.sessionSearch, async (_event, payload: unknown): Promise<StudyCallResult> => {
    const query = typeof (payload as SessionSearchRequest | undefined)?.query === 'string'
      ? (payload as SessionSearchRequest).query
      : ''
    const loaded = await loadSessions()
    if (!loaded.ok) return { ok: false, message: loaded.message }
    return { ok: true, data: searchSessions(loaded.infos, query) }
  })
}

/** 列出当前学生的历史会话（走 Pi 的 `SessionManager.list`，目录**显式**指向该学生）。 */
async function loadSessions(): Promise<
  { ok: true; infos: Awaited<ReturnType<typeof listStudentSessions>> } | { ok: false; message: string }
> {
  try {
    const infos = await listStudentSessions(app.getPath('userData'), resolveActiveStudentId())
    return { ok: true, infos }
  } catch (error) {
    return { ok: false, message: `读取历史会话失败：${describeRuntimeFailure(error)}` }
  }
}

/** 按白名单里那条 `SessionInfo` 读它自己的文件（**path 由 Pi 提供，不是前端给的**）。 */
async function readTranscriptFrom(info: {
  id: string
  path: string
}): Promise<StudyCallResult> {
  try {
    const entries = await readStudentSessionEntries(
      app.getPath('userData'),
      resolveActiveStudentId(),
      info
    )
    const projected = projectTranscript(entries)
    const transcript: SessionTranscript = {
      id: info.id,
      title: truncateChars(info.path.split(/[/\\]/).pop() ?? info.id, TITLE_MAX_CHARS),
      messages: projected.messages,
      truncated: projected.truncated
    }
    return { ok: true, data: transcript }
  } catch (error) {
    return { ok: false, message: `读取会话内容失败：${describeRuntimeFailure(error)}` }
  }
}

/* ------------------------------------------------------------------ *
 * 导出（报告 / 错题本 → Markdown 文件）
 * ------------------------------------------------------------------ */
function registerExportHandler(): void {
  ipcMain.handle(IPC.fileExport, async (event, payload: unknown): Promise<FileExportResult> => {
    const clean = payload as FileExportRequest | undefined
    if (!clean || typeof clean.content !== 'string') {
      return { ok: false, message: '导出失败：没有内容可导出。' }
    }
    if (clean.content.length > MAX_EXPORT_CHARS) {
      return { ok: false, message: `导出失败：内容过长（上限 ${MAX_EXPORT_CHARS} 字）。` }
    }
    // ★ 文件名在**主进程**清理（纯函数，有单测）：渲染进程只能建议一个名字，不能指定路径。
    const fileName = sanitizeFileName(clean.fileName)
    const content = normalizeExportContent(clean.content)

    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '导出学习档案',
      defaultPath: fileName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const picked = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) {
      // 用户取消**不是错误**：回一个带 `canceled` 的失败，界面据此不弹「导出失败」
      return { ok: false, message: '已取消导出。', canceled: true }
    }

    try {
      // UTF-8 无 BOM + LF（`normalizeExportContent` 已统一换行）
      writeFileSync(picked.filePath, content, { encoding: 'utf8' })
    } catch (error) {
      return { ok: false, message: `写入失败：${describeRuntimeFailure(error)}` }
    }
    // ★ 只回文件名：完整路径（含宿主用户名/目录结构）不进渲染进程
    return { ok: true, fileName: picked.filePath.split(/[/\\]/).pop() ?? fileName }
  })
}

/** 读/存设置的单次请求超时（本机回环，正常在毫秒级；超了就是 sidecar 卡住）。 */
const SETTINGS_REQUEST_TIMEOUT_MS = 8000
/** 连通性探测的超时：真的要走一次外呼，宽一些。 */
const PROBE_TIMEOUT_MS = 15_000

/**
 * ★★ **保存设置后把新配置热应用到当前会话**（`settings:save` 成功路径调用）。
 *
 * 三层退路（见 `settingsSave` 里的注释）：热切换 → 销毁重建 → 冷启动兜底。
 * **本函数绝不抛异常**：调用方在「保存成功」的回执路径上，配置已经落盘了，
 * 这里失败只影响「生效时机」，不该把成功回执变成失败。
 */
async function applySavedLlmConfig(): Promise<void> {
  let llm: RuntimeLlmConfig | null
  try {
    llm = await refreshRuntimeLlmConfig()
  } catch (error) {
    console.warn('[main] 刷新运行时 LLM 配置失败（保存已成功，下次建会话会重试）：', error)
    return
  }
  // 取不到（sidecar 没起来 / 回执不合契约）：什么都不做，冷启动路径仍会重试
  if (!llm) return

  const instance = runtime
  if (!instance) {
    // 会话还没建：不需要热切换，下一条消息的 `ensureChatRuntime()` 会用到新缓存
    return
  }

  try {
    await instance.applyLlmConfig({
      providerId: llm.providerId,
      providerName: llm.providerName,
      baseUrl: llm.baseUrl,
      modelId: llm.modelId,
      apiKey: llm.apiKey || undefined
    })
    console.warn(
      `[main] 设置已热生效：provider=${llm.providerId} model=${llm.modelId}（当前会话已切换，对话历史保留）`
    )
    return
  } catch (error) {
    // 热切换失败：**销毁会话**让下一条消息按新配置重建（仍然生效，只是换一个新会话）
    console.warn(
      `[main] LLM 配置热切换失败，将按新配置重建会话：${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  try {
    await disposeChatRuntime()
  } catch (error) {
    // 连销毁都失败：不拦保存回执。冷启动时 `ensureChatRuntime()` 一定读到新配置。
    console.error('[main] 重建会话前的销毁失败（保存已成功，重启后生效）：', error)
  }
}

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
    // ★ 先补配置（幂等、便宜）：若本次会话是「sidecar 还没起来」时降级装配的，
    //   这里把用户设置真正用上 —— 否则「重启后设置不生效」（实测踩到的启动竞态）。
    await ensureRuntimeConfigApplied()
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
