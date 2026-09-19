/**
 * ★ `runtime.ts` —— **聊天路径唯一的 Agent 会话工厂**（票 06；执行文档 §9.4、§10.1、§10.5、§11.1）。
 *
 * 职责（一条链，缺一不可）：
 *   1. 目录隔离：`ModelRuntime.create({ authPath, modelsPath })` + `DefaultResourceLoader({ agentDir })`
 *      + `SessionManager.create(cwd, sessionDir)` 全部钉在 `<userData>/pi-agent/`，**不读不写 `~/.pi/agent`**。
 *   2. system prompt 三道覆盖：`systemPromptOverride`（资源加载器层）+
 *      `before_agent_start` 每轮改写（★ 最后一道改写点，学段语气就落在这里）+ 三条早退路径的
 *      落盘证据。**三道都走同一个出口** {@link createChatRuntime} 里的 `buildSystemPrompt()`：
 *      学段权威段（`gradeExtension.systemPromptFor`）+ 学生情况块（每轮预取的画像）—— 同一份文本，
 *      不会出现「第一轮不带权威段 / 后面带」「落盘的那份和发出去的那份不一样」这类不一致。
 *      ★ 另一道是**剥尾巴**：Pi 会在 `buildSystemPrompt()` 末尾无条件追加
 *      `\nCurrent working directory: <绝对路径>`（实测 0.85.1，`systemPromptOverride` 管不住它），
 *      所以在进那个出口**之前**先过 `stripPiCwdBlock()`（见下方接线处的注释）。
 *   3. 学段：**由推断系统决定**（`agent/extensions/grade.ts` 是唯一权威来源），
 *      **学生情况**：由画像预取决定（`extensions/profile.ts` 的 `fetchStudentContext`）。
 *      ★ 两件事都由本文件**显式驱动**，不挂 Pi 事件（返工原因见 `grade.ts` 文件头）：
 *        - 观察：每轮开始调 `gradeExtension.observeTurn(text)`（**在无 Key 早退之前**，
 *          否则无 Key 世界里学段永远不动；同时**在输入侧安全检查之后** ——
 *          被拦下的消息不该产生学段证据，见 `runTurn` 里那处的说明）；
 *        - prompt：`chatFactory` 的 `before_agent_start` 调 `buildSystemPrompt()`。
 *      运行时**不读**渲染进程传来的学段 —— `ChatSendRequest` 里根本没有学段字段
 *      （字段集合被守卫 G6c 钉死为 `['text']`）。
 *      ★ 学段的写入口**只有一条**：{@link ChatRuntime.setGradeLevel}（学生显式设定，
 *      经独立通道 `grade:set`）—— **绝不借道「发一条消息」**：那样每一轮对话都会顺带写一次
 *      学段，而「发消息」与「改学段」是两件不同的事（一个失误就可能把学生的选择冲掉）。
 *   4. Pi → 6 事件：事件流交给 `events.ts` 的 `bindTurnStream()`，本文件只管会话与生命周期。
 *   5. provider 边界脱敏审计（§12）：`before_provider_request` 里把**真正要发出去的** system prompt
 *      取出、抹掉任何密钥痕迹、并做宿主路径泄漏断言，然后落盘作证据。
 *
 * ★ 与 `pi-bootstrap.ts` 的分工（不要合并、也不要互相抄）：
 *   - `pi-bootstrap.ts`（票 03）是**冒烟**用的最小会话（学段无关的 baseline prompt + echo Tool），
 *     服务「关卡 B₁：Pi 能不能在 Electron 里加载」这条判定；
 *   - 本文件是**产品会话**（学段 prompt + 工具 + 事件流），服务「关卡 B：学生能不能流式对话」。
 *   两者共用 pi-bootstrap 导出的原语（`loadPi` / `resolveCredentials` / `writeModelsJson` /
 *   `extractWireSystemPrompt` / `findHostPathLeaks`），**不重复实现目录隔离与 Key 解析链**。
 *
 * ★ 无 Key 时的行为（本机现状：`DEEPSEEK_API_KEY` 未设置）：
 *   **不假装、不静默、不挂起** —— 直接发一条可读的 `error`（`degraded: true`）并收尾本轮，
 *   文案明确写「这是配置缺失，不是程序故障」（见 `events.ts` 的 `MISSING_KEY_MESSAGE`）。
 *   ★ 但**学段推断照常工作**：观察（`observeTurn`）发生在「无 Key」早退**之前**（但**在输入侧
 *     安全检查之后** —— 被拦下的消息不产生证据），第一层规则引擎
 *     不依赖 LLM；只有第二层（LLM 复核）会退化成 `degraded="no_llm"`。这是刻意的 ——
 *     「没有 API Key 时应用仍然可用」的验收口径包含「学段仍然会动」。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { GradeLevel } from '@shared/ipc-events'
import {
  bindTurnStream,
  describeProviderError,
  describeTurnException,
  MISSING_KEY_MESSAGE,
  // ★ 脱敏的**唯一实现处**在 `events.ts`（本文件只再导出，见文件末尾的说明）
  redactSecret,
  sanitizeProviderText,
  type PiNativeEvent,
  type TurnSink
} from './events.ts'
import {
  bindAgentSession,
  CORE_EXTENSION_FACTORIES,
  describeRegistryReport,
  registerAgentExtensions,
  type AgentExtensionApi
} from './extensions/index.ts'
// ★ 只 import `createAnimationExtension`（**不再用默认导出**）：默认导出是
//   `createAnimationExtension()`（**没接 `generate`**），而票 17 的补充路径要求接上自由生成器
//   —— 见下方 `agentExtensionsFactory` 的说明。
import { createAnimationExtension } from './extensions/animation.ts'
import codingExtension from './extensions/coding.ts'
import quizExtension from './extensions/quiz.ts'
// ★ 学段**推断**扩展（票 21）：它独占 `input`（收集本轮证据）与 `before_agent_start`（按推断出的
//   学段替换整段 prompt），并自兜异常。工厂是「可调用 + `.refresh()/.useJudge()` 诊断入口」的形态。
import gradeExtension, {
  GRADE_OVERRIDE_HEADING,
  buildJudgePrompt,
  parseProposal,
  postGradeOverride
} from './extensions/grade.ts'
// ★ 学生情况（画像）的每轮注入（票 20 的对话侧落点）：取值在 profile 扩展
//   （`fetchStudentContext`，失败降级为空串），拼装在 `prompts/student-context.ts`（纯函数，幂等）。
//   本文件只把它们接在 `buildSystemPrompt()` 这一个出口上 —— 6 个 prompt 落点共用它。
import { fetchStudentContext } from './extensions/profile.ts'
import { withStudentContext } from './prompts/student-context.ts'
import ragSearchExtension from './extensions/rag-search.ts'
import {
  builtinCatalog,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  extractWireSystemPrompt,
  findHostPathLeaks,
  loadPi,
  PROBE_API_KEY,
  PROBE_BASE_URL,
  resolveCredentials,
  stripPiCwdBlock,
  writeModelsJson,
  type LlmConfigForPi,
  type PiCredentials
} from './pi-bootstrap.ts'
// ★ 内容安全投递层（票 22）：输入检查 + 生成结束后的整段终审 + provider 边界脱敏。
//   判定全在 Python 的 `app/safety/guard.py`，本文件只负责把它接到**真实对话回合**上。
import {
  auditProviderHeaders,
  createModelCompleter,
  createSafetyGateSink,
  emitBlockedTurn,
  finalizeTurn,
  reviewInput,
  type TextCompleter
} from './safety/review.ts'
// ★ 动画自由生成（票 17 的补充路径）：模板未命中时才被调用，无 Key 时干净降级。
import { createAnimationGenerator } from './animation/generator.ts'
import {
  assertSessionManagerIsolated,
  ensureStudentPiDirs,
  piSessionCwd,
  resolveStudentPiPaths,
  type StudentPiPaths
} from './pi-paths.ts'
// ★ 历史消息的投影（`SessionEntry[]` → 可显示的问答）：**与「只读回看」共用同一个纯函数**。
//   两处各写一份解析就会出现「回看里显示的消息」与「恢复出来继续聊的消息」不一致 ——
//   而它们读的是同一份 JSONL，任何不一致都是解析差异（不是数据差异）。
import { projectTranscript, titleFromText, type TranscriptMessage } from '../study/sessions.ts'
import {
  createTraceExtension,
  exportToolTrace,
  ToolTraceRecorder,
  type TraceExportOptions,
  type TraceRecordForUi
} from './trace.ts'

/* ------------------------------------------------------------------ *
 * 选项与返回类型
 * ------------------------------------------------------------------ */

/**
 * ★★ 会话**怎么建立**（`ChatRuntimeOptions.sessionSource`；三种形态，别再发明第四种）。
 *
 *   - `'new'`    → `SessionManager.create()`：一个全新的 JSONL 文件（「新会话」按钮）；
 *   - `'recent'` → `SessionManager.continueRecent()`：**续上最近用过的那一条**
 *                  （启动时的默认行为 —— 「关掉应用再打开，上一段对话还在」这条验收）；
 *   - `{ path }` → `SessionManager.open(path)`：**打开指定的那一条**（会话列表里点开的那一条、
 *                  以及分叉出来的新文件）。
 *
 * ⚠️ **`path` 只能由主进程产生**（`SessionManager.list()` 的返回值，或
 *   `createBranchedSession()` 的返回值）—— 渲染进程永远只能递一个**会话 id**
 *   （这条安全约束的说明在 `study/sessions.ts` 的文件头，两处是同一个判据）。
 * ⚠️ 三种形态**都要过 `assertSessionManagerIsolated`**（见 `createChatRuntime` 里那句）：
 *   `open` / `continueRecent` 的第二个参数同样是 `sessionDir`，漏传就会读错目录。
 */
export type ChatSessionSource = 'new' | 'recent' | { path: string }

export interface ChatRuntimeOptions {
  /** ★ 必须显式传入（Electron 里是 `app.getPath('userData')`）；**禁止回退 `~/.pi`**。 */
  userDataDir: string
  /**
   * ★ 学生 id（票 09）：会话、`auth.json` / `models.json`、JSONL 全部落
   * `<userData>/students/<id>/pi-agent/`。**未经校验的 id 不许进来**（会被拼进路径）。
   */
  studentId: string
  /** ★ 设置页的 Key（第一档）；其余档位由 `resolveCredentials` 处理。 */
  apiKey?: string
  /** `apiKey` 来源标签（设置页 vs CLI），只影响 `credentials.source` 诊断。 */
  apiKeySource?: 'settings' | 'flag'
  /** ★ Pi 的 provider id（设置里的那一项）；不传则用内置默认。 */
  providerId?: string
  /** 供应商显示名（只写进 `models.json` 的 `name`）。 */
  providerName?: string
  modelId?: string
  baseUrl?: string
  /** 会话工作目录（决定 Pi 的项目级资源发现范围）。 */
  cwd?: string
  /**
   * 会话来源（默认 `'new'` —— **不改既有默认行为**，恢复由调用方显式要求）。
   * 详见 {@link ChatSessionSource}。
   */
  sessionSource?: ChatSessionSource
  /**
   * 离线探针（默认关闭；也可用环境变量 `K12_OFFLINE_PROBE=1` 打开）：
   * 无 Key 时用**假 Key + 本机不可达地址**把一轮踢到 provider 边界，从而在无 Key 环境下
   * 也能断言「system prompt 每轮生效且不含宿主路径」。
   * **不发出任何真实请求、不写盘任何凭证**；只用于排查与验收。
   */
  offlineProbe?: boolean
  /**
   * 每记录一条 Tool 调用轨迹就回调一次（可选）。
   *
   * 主进程用它把**轨迹快照**推给渲染进程（右栏「工具调用轨迹」）。
   * ★ 与 `trace` 字段的分工：那个是「最终落盘的完整记录」（退出时导出 `.mmd`），
   *   这个是「过程里的实时快照」（界面要看见工具正在被调用）。
   */
  onTraceRecord?: (records: TraceRecordForUi[]) => void
}

export interface ChatTurnInput {
  text: string
}

/** 本轮的结论（供日志与工具调用轨迹用；UI 只认 6 事件）。 */
export interface ChatTurnOutcome {
  ok: boolean
  /** `ok` / `missing-key` / `provider-error` / `busy` / `exception` / `blocked`。 */
  status: 'ok' | 'missing-key' | 'provider-error' | 'busy' | 'exception' | 'blocked'
  /** 面向开发者的说明（**不进 UI**）。 */
  detail?: string
}

export interface ChatRuntime {
  /** ★ 学生级路径（`<userData>/students/<id>/pi-agent/…`），不是应用级那份。 */
  readonly paths: StudentPiPaths
  /** 本会话归属的学生 id（学习记录 / 画像 / 轨迹都用它，**模型改不了**）。 */
  readonly studentId: string
  /** Pi 的 JSONL 会话 id（与 `learning_history.session_id` 关联）。 */
  readonly sessionId: string
  /**
   * ★ 本次装配用的**会话来源**（调用方要据此判断「这是不是一条全新的会话」）。
   *
   * 为什么不看 `messageCount` 就够：**两者都会用到，且不是一回事** ——
   * `sessionSource === 'recent'` 而 `messageCount === 0` 是真实存在的形态
   * （上次开会话后一句话都没说就退出了）。
   */
  readonly sessionSource: ChatSessionSource
  /**
   * 会话里已有的**消息条数**（`type === 'message'` 的条目数）。
   *
   * ★ 它是「该不该发开场引导」的判据（`architecture/pending/04` 的判据原文：
   *   「会话内消息数为 0」）。**不是** `getEntries().length` —— 那里面还有
   *   `model_change` / `thinking_level_change` / 自定义条目，刚建的会话就有好几条，
   *   用它判会让开场语**永远发不出来**（这类「判据选错代理量」的故障本仓库有前科）。
   */
  readonly messageCount: number
  /**
   * 本次装配时**从已有会话里读回来的对话**（按 `{role, text, at}` 投影，与回看同形）。
   * 新会话 / 空会话时是空数组。界面把它铺成消息列表 —— **恢复历史对话的唯一数据源**。
   */
  readonly restoredMessages: readonly TranscriptMessage[]
  readonly credentials: PiCredentials
  /** 供应商是否具备凭证（`false` = 只能跑到「准备发请求」为止）。 */
  readonly authReady: boolean
  /**
   * ★ **当前生效的学段**（唯一权威来源：`extensions/grade.ts` 的推断状态）。
   * 冷启动（一次推断都还没发生）时是 `prompts/grade.ts` 的默认值。
   */
  readonly gradeLevel: GradeLevel
  /** 诊断：最近一轮 `before_agent_start` 采用的 system prompt。 */
  readonly lastSystemPrompt?: string
  /** 诊断：**真正要发到网络上**的那份 system prompt（`before_provider_request` 取出）。 */
  readonly wireSystemPrompt?: string
  /** 诊断：上面那份里的宿主路径泄漏（必须是空数组）。 */
  readonly promptLeaks: readonly string[]
  /** 发出过的 provider 请求数（离线探针那一轮也会计 1）。 */
  readonly providerRequestCount: number
  /** 六扩展 + 轨迹扩展的装配结论（缺哪个、谁注册失败、Tool 覆盖自检）。 */
  readonly extensionReport: { registered: string[]; missing: string[]; missingTools: string[] }
  /** 工具调用轨迹（`docs/tool-trace.mmd` 的数据来源；退出时由 `dispose()` 导出）。 */
  readonly trace: ToolTraceRecorder
  /**
   * ★★ **保存设置后热切换 LLM 配置**（「设置改完即生效」，不必重启应用）。
   *
   * 为什么需要它：`models.json` 只在**建会话时**读一次，`model` 也只在建会话时解析一次。
   * 不重切的话，设置页保存后当前会话仍用旧配置 —— 演示现场极易被误判成「设置没保存」。
   *
   * 步骤（顺序不能乱）：
   *   ① 重写 `models.json`（由新配置派生）；
   *   ② `modelRuntime.refresh({ providers: [id] })` 让 Pi 重新组装这个 provider
   *      （**只刷新这一个**：全量 rebuild 会把其它 provider 也重建一遍，没有必要）；
   *   ③ Key 同步到内存：有新 Key `setRuntimeApiKey()`，**没有就 `removeRuntimeApiKey()`**
   *      （清空 Key 必须真的撤掉，见实现里的注释）；
   *   ④ 重新解析 model，`session.setModel()` 热切换 —— **会话与对话历史都保留**
   *      （`setModel` 只改 `agent.state.model` 并往会话里追一条 model_change）。
   *
   * 失败时**抛可读异常**，由调用方决定降级（`handlers.ts` 会销毁会话让下一条消息按新配置重建）。
   */
  applyLlmConfig(config: LlmConfigForPi & { apiKey?: string }): Promise<void>
  /**
   * ★ 学生手动设定学段（走 `grade:set` 这条独立通道；**绝不混进对话请求**）。
   *
   * 步骤：① POST `/api/grade/override/{studentId}` 落库（服务端是唯一写库方）；
   * ② `gradeExtension.adoptOverride()` **立即生效**并作废在途的推断结论；
   * ③ 重新把学生上下文绑进扩展层，让 `learning-log` 等每轮用到的那份学段也立刻是新值。
   *
   * 失败**抛可读异常**，由 `handlers.ts` 翻成可读中文回执（绝不抛过 IPC）。
   */
  setGradeLevel(gradeLevel: GradeLevel): Promise<{ changed: boolean; cooldownRemainingTurns: number }>
  /**
   * ★★ **主动发起对话**：把一句开场引导写进 Pi 会话（需求原文要求的那一半）。
   *
   * 写成**一条 assistant 消息**（不是 `custom_message`、不是纯 `custom` 条目）——
   * 三个候选形态与取舍（改动前先读完，别"顺手改回更简单的那个"）：
   *
   * | 形态 | 会进模型上下文吗 | 为什么否掉 / 采用 |
   * | --- | --- | --- |
   * | `appendCustomEntry`（纯 `custom`） | **不会** | 它只落盘、不参与上下文。学生回一句「好呀」时模型**完全不知道**自己在跟什么约定 —— 「主动引导」当场退化成一句没人接得住的话 |
   * | `appendCustomMessageEntry`（`custom_message`） | 会，但**变成 user 消息**（`convertToLlm` 的 `case "custom"`） | 模型会以为**是学生说的**「你好，我是团团。从X开始吧」—— 上下文里出现学生从未说过的话，属伪造对话记录 |
   * | `appendMessage` + `role: 'assistant'` ★ **采用** | 会，就是助手自己说过的话 | 与真实情况一致（屏幕上它也确实显示为助手的第一条消息），重启后模型仍记得自己约过什么 |
   *
   * ★ `usage` 全 0 **不是占位符，是事实**：这句话由服务端模板拼出（`routes/profile.py` 的
   *   `_opening_text`），**没有花掉任何 token**。写真实的 `provider` / `model` 让
   *   轨迹与成本统计能对上账；`stopReason: 'stop'` 表示它是一次完整收尾的表述。
   * ★ 由调用方保证「只在 `messageCount === 0` 时调用一次」——本方法不做幂等判断
   *   （判据在 `ipc/handlers.ts` 的 `openSession` 里，那里同时决定前端拿不拿得到它）。
   */
  appendOpeningMessage(text: string): void
  /**
   * ★ 用一次轻量模型补全给当前会话起个名字（写进 Pi 的 `session_info` 条目）。
   *
   * 失败**抛出**由调用方决定降级（没有 Key / 断网时退回首条消息截断）——
   * `ipc/handlers.ts` 的 `maybeGenerateTitle` 是唯一调用方，它自己吞异常。
   * 返回生成的标题（已截断、已单行化）；没生成出可用标题时返回 `null`。
   */
  generateSessionTitle(): Promise<string | null>
  /**
   * ★★ **从某条消息处分叉**（会话分支 UI 的唯一实现点）。
   *
   * 语义：把「根 → 该消息」这一段**复制成一个新的会话文件**，交给调用方去装配
   * （`ChatRuntimeOptions.sessionSource = { path }`）。学生在新会话里接着问，
   * **原会话一个字节都不动** —— 这是「重新问一遍」而不是「改写历史」：
   * 两条线的后续内容各自独立保存，都能在列表里找回。
   *
   * ★ 底层是 Pi 的 `SessionManager.createBranchedSession(leafId)`，它做三件事：
   *   ① 沿 `getBranch(leafId)` 取出「根 → 该条目」的路径；
   *   ② 在**同一个 sessionDir** 里写一个新 JSONL（新 id、新时间戳）；
   *   ③ 在新文件的头部写 `parentSession = <当前文件路径>` —— **分支关系由 Pi 记录**，
   *      我们不自己维护（那会变成第二处真相）。
   *
   * ⚠️ **`entryId` 必须是本条会话里真实存在的条目 id**（`restoredMessages` 给的）。
   *   调用方负责先做白名单对齐（见 `ipc/handlers.ts` 的 `branchFromMessage`）——
   *   本方法只兜住「Pi 说找不到」这一种（它会抛 `Entry <id> not found`）。
   * ⚠️ 返回**新文件的完整路径**（只在主进程内流转，绝不进渲染进程 ——
   *   渲染进程只拿得到新会话的 **id**，与 `session:open` 同一条安全约束）。
   */
  branchFrom(entryId: string): Promise<{ path: string }>
  /**
   * ★★ **刚刚结束的那一轮的条目 id**（`{userEntryId, entryId}`；认不出时是空串）。
   *
   * 为什么需要它 —— 实测抓到的缺陷（见 P-105）：**实时发出的轮次从来没有条目 id**。
   * `entryId` 只由「恢复历史」那条路填过（`restoreConversation` 从投影里带过来），
   * 于是「从这里重新问」按钮**只对历史消息出现**，对刚刚聊出来的那句话**不出现**
   * —— 而那恰恰是这个按钮最主要的用法（学生刚读完一条回答，想换个问法再问）。
   *
   * 判据是「取投影里**末尾**的那一对 (user, assistant)」：
   *   一轮正常结束 = 追加一条 user + 一条 assistant，所以末尾那对就是本轮的。
   *   ⚠️ 不能按「条数差」算：开场引导、`model_change`、失败轮次都会让条数对不上
   *      （本文件里已经有一条同类的教训，见 `messageCount` 的注释）。
   */
  lastTurnEntries(): { userEntryId: string; entryId: string }
  /** 跑一轮：事件经 `sink` 投递（`sink` 就是 `ChatStreamRegistry` 的 `TurnHandle`）。 */
  runTurn(input: ChatTurnInput, sink: ChatTurnSink): Promise<ChatTurnOutcome>
  /**
   * ★ 等本轮（以及此前排队的）学段证据上交完毕。
   *
   * 为什么需要它：上交是 fire-and-forget（**判定结果下一轮才生效**，本轮对话绝不排队等它），
   * 所以 `runTurn()` 返回时服务端可能还没判完。调用方（`ipc/handlers.ts`）要在本轮结束后
   * 读一次 `learning.db` 里的学段推给界面 —— 不 flush 就会**永远慢一拍**，
   * 只读徽章停在上一轮的学段上。
   * 内部已兜异常（提交失败只记日志），**不会抛**。
   */
  flushGrades(): Promise<void>
  /** 关闭会话（`session.dispose()` 会把 JSONL flush 干净）。**幂等**。 */
  dispose(): Promise<void>
}

/** `TurnHandle` 的最小面（多一个 `requestId`：用于兜底生成 `done.messageId`）。 */
export interface ChatTurnSink extends TurnSink {
  readonly requestId: string
}

/** 供应商 / 模型默认值来自 `pi-bootstrap`（单一来源，别在这里再写一份）。
 * ★ 离线探针的两个常量（假 Key / 不可达地址）同样来自 `pi-bootstrap`（`PROBE_API_KEY` /
 *   `PROBE_BASE_URL`）：两处各写一份字面量会漂移，探针就不指向同一个不可达地址了。 */
const PROBE_NOTICE =
  '离线探针模式：本轮用假 Key 指向本机不可达地址，**不会发出任何真实请求**，用于验证提示词装配与事件通道。'

/** 并发保护：同一时刻只允许一轮（渲染进程也有 streaming 守卫，这里是第二道）。 */
export const BUSY_MESSAGE = '上一条回答还没说完，请等它结束再发下一条。'

/**
 * 学段第二层（轻量 LLM 判定）的单次超时（毫秒）。
 *
 * 为什么不能无限等：判定是**每轮 fire-and-forget 上交链**上的一环（`grade.ts` 的队列），
 * 它挂在 `flushGrades()` 上被 `before-quit` / 每轮结束等待。一次挂死的调用会把整条队列
 * 连同退出流程一起拖住。超时 → `judge_error` → 本轮只用第一层（学段照常能改），代价可接受。
 */
export const JUDGE_TIMEOUT_MS = 8_000

/**
 * 会话标题生成的单次超时（毫秒）。
 *
 * 比 `JUDGE_TIMEOUT_MS` 稍宽（要写一句完整的话，而不是一个 JSON），但仍然很短：
 * 标题**不是**学生等待的东西（对话早已结束，他在读回答），它只是列表里的一栏；
 * 挂死了也不能拖住任何东西 —— 调用方是 fire-and-forget，超时就走首条消息截断。
 */
export const TITLE_TIMEOUT_MS = 10_000

/**
 * 退出前冲洗**学习记录队列**的上限（毫秒）。
 *
 * 为什么要有上限：`learning-log.ts` 的 `flush()` 逐条 POST，失败时按指数退避（封顶 30s），
 * 一次全队重试能把 `before-quit` 拖到 Windows 认为「程序没响应」。退出流程里
 * **宁可丢队列也不能卡住退出**（数据已经丢不回来了，卡住还会连带 sidecar 杀不干净）。
 */
export const LEARNING_LOG_FLUSH_TIMEOUT_MS = 3_000

/**
 * 学习记录扩展的**诊断面**（`learning-log.ts` 的 `LearningLogExtension` 结构子集）。
 *
 * 只声明 `flush` / `stats` 两个成员：本文件不去静态 import 那个模块（会产生循环导入边，
 * 见 `flushLearningLog()` 的注释），所以这里用结构化类型描述「退出前要用的那两件事」。
 */
interface LearningLogDiagnostics {
  flush(): Promise<boolean>
  stats(): { written: number; failed: number; queued: number; dropped: number; lastError?: string }
}

/** 诊断开关：把 Pi 原生事件名按顺序打到 stderr（**只打事件名，见 `tracePiEvent`**）。 */
const tracePiEvents = process.env.K12_PI_TRACE === '1'

/**
 * 事件名级别的诊断输出。
 * ★ 只允许结构性字段：事件名 / 子类型 / Tool 名 / 布尔标记。
 *   绝不记录消息正文、prompt、凭证（§12：LLM 与嵌入模型不得明文写入日志）。
 */
function tracePiEvent(event: PiNativeEvent): void {
  const parts = [`[pi] ${event.type ?? '(无 type)'}`]
  if (event.assistantMessageEvent?.type) parts.push(`sub=${event.assistantMessageEvent.type}`)
  if (typeof event.toolName === 'string' && event.toolName.length > 0) parts.push(`tool=${event.toolName}`)
  if (event.isError === true) parts.push('isError=true')
  if (event.willRetry === true) parts.push('willRetry=true')
  if (event.success === false) parts.push('retryFailed=true')
  if (typeof event.attempt === 'number') parts.push(`attempt=${event.attempt}`)
  if (event.assistantMessageEvent?.error?.errorMessage) parts.push('hasProviderError=true')
  console.warn(parts.join(' '))
}

/* ------------------------------------------------------------------ *
 * Pi 命名空间里用到的符号（结构化声明，避免静态 import 整个包）
 * ------------------------------------------------------------------ */

interface PiModuleLike {
  createAgentSession: (options: Record<string, unknown>) => Promise<{ session: PiSessionLike }>
  DefaultResourceLoader: new (options: Record<string, unknown>) => PiResourceLoaderLike
  ModelRuntime: { create: (options: Record<string, unknown>) => Promise<PiModelRuntimeLike> }
  SessionManager: { create: (cwd: string, sessionDir?: string) => unknown }
  defineTool: (tool: Record<string, unknown>) => unknown
}

interface PiResourceLoaderLike {
  reload(options?: Record<string, unknown>): Promise<void>
  getSystemPrompt(): string | undefined
}

interface PiModelRuntimeLike {
  getModel(providerId: string, modelId: string): unknown
  getModels(providerId?: string): unknown[]
  getProviders(): Array<{ id: string }>
  checkAuth(providerId: string): Promise<{ type: 'api_key' | 'oauth' } | undefined>
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>
  /**
   * ★ 抹掉**内存里**的 runtime Key（实测 0.85.1 `model-runtime.d.ts:83` 存在，
   *   实现见 `model-runtime.js:401`：`credentials.removeRuntimeApiKey(id)` +
   *   `synchronizeCredentialState(…, "removeRuntimeApiKey", …)`）。
   *
   * 为什么必须有它：用户清空设置页里的 Key 之后，只看 `setRuntimeApiKey` 是**撤不掉**的 ——
   * 内存里那把旧 Key 仍然被 `checkAuth` 认成 `{"type":"api_key","source":"stored credential"}`，
   * 于是内容安全自审 / 学段第二层 / 动画自由生成**继续用已删除的 Key 发请求**
   * （用户以为已经撤销了）。这里只动内存，不碰 `auth.json`（合规：Key 不落盘）。
   */
  removeRuntimeApiKey(providerId: string): Promise<void>
  /** ★ 保存设置后重新组装 provider（`models.json` 改了必须调它才生效）。 */
  refresh(options?: { providers?: readonly string[]; allowNetwork?: boolean }): Promise<unknown>
}

interface PiSessionLike {
  systemPrompt: string
  subscribe(listener: (event: PiNativeEvent) => void): () => void
  prompt(text: string): Promise<void>
  /** ★ 热切换模型（保留会话与对话历史）；无 Key / 未配置时会抛。 */
  setModel(model: unknown, options?: { persist?: boolean }): Promise<void>
  dispose(): void
}

/** Extension 工厂收到的 API（只需 `on`；`registerTool` 由票 08 使用）。 */
interface PiExtensionLike {
  on(event: string, handler: (event: unknown) => Promise<unknown> | unknown): void
  registerTool?(tool: unknown): void
}

/**
 * `SessionManager` 的最小结构面（只声明**隔离断言**用到的四个方法）。
 *
 * 为什么不 import Pi 的类型：静态 import Pi 会 evaluate 包根的 CLI `main.js`（连带 `esbuild`
 * 原生二进制，风险 #15）—— `pi-paths.ts` 的 `assertSessionManagerIsolated` 也出于同一理由
 * 只认结构（`SessionManagerLike`），两边形状在这里对齐。
 */
interface PiSessionManagerLike {
  getSessionDir(): string
  usesDefaultSessionDir(): boolean
  getSessionId?(): string
  getSessionFile?(): string | undefined
}

/* ------------------------------------------------------------------ *
 * 会话装配
 * ------------------------------------------------------------------ */

/**
 * 会话内部的可变状态（用闭包而不是类字段，避免 Pi 对象在类实例上被长期持有）。
 *
 * ⚠️ 只保留**真有读取方**的字段（读过一遍全仓 grep）：
 *   - `lastPrompt` / `wirePrompt` / `wireLeaks` / `providerRequests` → `ChatRuntime` 的诊断 getter
 *     与 `dumpPrompts()` 的证据文件；
 *   - `headerAudits` → 头 hook 的「第 N 次触发」日志（「hook 真的挂上了」的可观测证据）。
 *   已删掉 6 个**只写不读**的字段：`basePromptSeen` / `redactedHeaderKeys` / `headerAuditSource` /
 *   `inputBlocks` / `finalizations` / `retractions`。它们的读取方一个都不存在，
 *   而「写了没人看」的状态最容易被误当成验收证据 —— 真要审计这些数，
 *   日志里已经有同口径的行（`[safety] 本轮内容安全：…` / `provider 头审计（第 N 次）…`）。
 */
interface RuntimeState {
  lastPrompt?: string
  wirePrompt?: string
  wireLeaks: string[]
  providerRequests: number
  /** ★ 该钩子被调用的次数（验收证据：hook 真的挂上了）。 */
  headerAudits: number
}

/**
 * 建一个真正能聊天的 Pi 会话。
 *
 * ⚠️ 与冒烟会话的三个要害差异（改这里时不要"顺手对齐"回去）：
 *   - `systemPromptOverride` 指向**当前学段**的模板（不是学段无关的 baseline）；
 *   - `before_agent_start` 覆盖 **+ 记录**（这条是最后一道改写点，Pi 会在其后追加 cwd 环境块）；
 *   - `noTools: 'builtin'` 保持不变：读/写/执行文件的**内置工具一律不开**
 *     （Pi 的 Extension 与 UI 同进程，学生代码绝不在主进程执行 —— 票 18/19 经 IPC 交渲染进程）。
 */
export async function createChatRuntime(options: ChatRuntimeOptions): Promise<ChatRuntime> {
  // ★★ 票 09：**学生级**路径（`<userData>/students/<id>/pi-agent/`）。
  //    `resolveStudentPiPaths` 内部先过 `assertStudentId`（白名单），非法 id 在这里就抛，
  //    绝不可能把 `../../` 拼进路径。**应用级那份 `resolvePiPaths` 不在这条链上。**
  const paths = resolveStudentPiPaths(options.userDataDir, options.studentId)
  ensureStudentPiDirs(paths)

  // ★ `models.json` 由**设置**派生（见 `pi-bootstrap.ts` 的 `writeModelsJson` 语义说明）。
  //   拿不到内置目录（极端情况）时退化成「只写 provider 级 baseUrl + 声明 modelId」，不影响可用性。
  const catalog = await builtinCatalog(options.userDataDir).catch(() => [])
  writeModelsJson(
    paths,
    {
      providerId: options.providerId?.trim() || DEFAULT_PROVIDER_ID,
      providerName: options.providerName?.trim() || '',
      baseUrl: options.baseUrl?.trim() || DEFAULT_BASE_URL,
      modelId: options.modelId?.trim() || DEFAULT_MODEL_ID
    },
    catalog
  )

  const credentials = resolveCredentials(paths, {
    apiKey: options.apiKey,
    apiKeySource: options.apiKeySource,
    providerId: options.providerId,
    modelId: options.modelId,
    baseUrl: options.baseUrl
  })

  /**
   * ★ **当前生效的 LLM 配置**（可变：`applyLlmConfig()` 会就地更新）。
   *
   * 为什么不直接用 `credentials` 常量：热切换之后 `credentials` 已经不是事实了，
   * 而工具调用轨迹的 `meta.model` 与诊断日志必须反映**真正在用**的那一对。
   */
  const activeLlm = {
    providerId: credentials.providerId,
    modelId: credentials.modelId
  }

  const probeRequested = options.offlineProbe === true || process.env.K12_OFFLINE_PROBE === '1'
  const useProbe = probeRequested && !credentials.apiKey

  const pi = (await loadPi()) as unknown as PiModuleLike
  const state: RuntimeState = {
    wireLeaks: [],
    providerRequests: 0,
    headerAudits: 0
  }

  /**
   * ★★ **当前生效的 Key**（可变；与 `credentialState` 同处维护）。
   *
   * 为什么不能用建会话时那份 `credentials`（那是个快照）：用户在设置页换了一把新 Key
   * 之后，`credentials.apiKey` 就过期了 —— 而它正好是「审计副本里绝不允许原样出现明文 Key」
   * （`before_provider_headers`）与「提示词落盘前抹掉 Key」（`before_provider_request`）
   * 这两条自证断言**唯一**的比对基准。用旧值去比，新 Key 真漏进 prompt/header 时断言会静默通过
   * —— 那正是它要拦的那类泄漏。所以这里只在 `applyLlmConfig()` 成功之后更新它。
   */
  let activeApiKey: string | undefined = credentials.apiKey

  /**
   * ★★ 模型文本补全的**单一接线点**（三个用途共用：内容安全自审 / 学段第二层 / 动画自由生成）。
   *
   * 为什么是「先给壳、后填芯」（`lazyComplete` + {@link completerHolder}）：
   *   - 补全器要等 `ModelRuntime` 与 `model` 解析完才造得出来（它们在下面几十行）；
   *   - 而**动画扩展的工厂在 `resourceLoader.reload()` 时就要拿到 `generate`**
   *     （Pi 的 `extensionFactories` 是那时调用的），比 `model` 解析更早。
   *   所以这里给扩展一个稳定的函数壳，真正的实现等 `completerHolder` 填上再用。
   *
   * ★ 无 Key 时 `completerHolder` **保持为 `null`**，`lazyComplete` 抛出可读文案 ——
   *   三个用途各自走自己的降级分支（自审跳过词表照跑 / 学段报 `no_llm` / 动画降级为文字+SVG）。
   *   **绝不**在这里造一个假补全器：那会让「无 Key」变成「静默乱答」。
   */
  let completerHolder: TextCompleter | null = null
  const lazyComplete: TextCompleter = async (request) => {
    const completer = completerHolder
    if (!completer) {
      throw new Error('模型通道未接线：本机没有可用的 API Key（可在设置页填写或设置环境变量 DEEPSEEK_API_KEY）')
    }
    return await completer(request)
  }
  /** ★ 工具调用轨迹（票 08 的「设计合理性」证据；`dispose()` 时落盘）。 */
  const trace = new ToolTraceRecorder()
  /** 扩展装配结论（供 `extensionReport` 诊断字段；注册发生在 Pi 调用工厂时）。 */
  let extensionReport: ReturnType<typeof registerAgentExtensions> | null = null

  // ① 凭证 / 模型目录隔离（与冒烟同一套路径规则，但**按学生**分目录）
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false
  })

  /**
   * ★★ 学生情况（画像）的**每轮快照**：由 `runTurn()` 的预取写入，由 {@link buildSystemPrompt} 读取。
   *
   * 为什么是「先预取、后拼装」而不是在 `buildSystemPrompt` 里现取：拼装点有 6 个，
   * 其中 `systemPromptOverride` 是**建会话时同步求值**的（不能是 async），
   * 而 `before_agent_start` 也不该在 Pi 的回调里发 HTTP（它每轮都被调用）。
   * 所以本文件在**每轮开始**取一次（见 `runTurn()` 里的预取），其余点只读这份快照 ——
   * 一份文本、一个出口，第一轮 / 后续轮 / 落盘证据三者不会不一致。
   */
  let studentContextBlock = ''

  /**
   * ★★ **唯一的 system prompt 组装出口**：学段（权威）+ 学生情况（画像），6 个落点都走它。
   *
   * 顺序有意义（**不要对调**）：`withStudentContext` 把学生情况块插在**学段权威段之前**，
   * 于是学段那句「本轮按哪个学段作答」始终排在最后、离生成最近 —— 它是不可协商的指令，
   * 而画像只是背景（且它排前面也让 `grade.ts` 的 `stripGradeOverride` 不会每轮把它切掉）。
   *
   * 调用点（6 处，逐一核对过，**新增 prompt 落点时也必须走这里**）：
   *   ① `before_agent_start`（每轮覆盖，`:511` 那个位置）；② `systemPromptOverride`（建会话一次）；
   *   ③ 学段装配自检；④⑤⑥ 三条早退路径（输入拦截 / 无 Key / 凭证未过）落盘的 `state.lastPrompt`。
   *
   * ⚠️ 建会话时 `studentContextBlock` 还是空串（第一轮还没预取），所以
   *   `systemPromptOverride` 的产物等于「纯学段模板」—— 这是**预期**的：每轮都会由
   *   `before_agent_start` 用它覆盖，而 `withStudentContext` 对空块是原样返回（幂等）。
   */
  function buildSystemPrompt(incoming: string | undefined): string {
    return withStudentContext(gradeExtension.systemPromptFor(incoming), studentContextBlock)
  }

  /**
   * ② ★ prompt 基座 + 学段落点 + provider 边界审计（同一个工厂，注册顺序即执行顺序）。
   *
   * `before_agent_start` 的返回值会写进 `agent.state.systemPrompt`，是 **Pi 拼完 prompt 之后**
   * 的最后一道改写点 —— 也正因如此，它同时承担「抹掉 Pi 追加的 cwd 环境块」和「垫一份合法模板」。
   * **多个扩展的返回值是链式叠加的（后注册者看到前者结果）**，所以：
   *   - 不要在这里返回 `undefined`（那等于放弃覆盖，Pi 的默认 prompt 会带着宿主路径发出去）；
   *   - ★ 学段**推断**的落点就在这里：`gradeExtension.systemPromptFor()` 读 `event.systemPrompt`
   *     再替换/追加成本轮推断学段的权威段（见 `extensions/grade.ts` 的 `buildGradeSystemPrompt`）。
   *
   * ⚠️ **为什么学段 prompt 不在 grade 扩展自己 `pi.on('before_agent_start')` 里拼**（票 21 返工）：
   *   Pi 的 `before_agent_start` **排在凭证校验之后**（`prompt()` 先查 `hasConfiguredAuth`，
   *   不过就抛 `No API key found…`，`emitBeforeAgentStart()` 永远到不了）。本项目的
   *   **无 Key 世界**（本机现状，也是验收口径之一）就属于这种情况 —— 挂在事件上的话，
   *   提示词里永远看不到学段覆盖。放在这里则由本文件在**两条路径**上都显式调用，
   *   无 Key 时也能把「本轮按哪个学段作答」拼出来（`state.lastPrompt` 就是断言证据）。
   */
  const chatFactory = (extensionApi: PiExtensionLike): void => {
    extensionApi.on('before_agent_start', (event: unknown) => {
      const base = (event as { systemPrompt?: unknown }).systemPrompt
      /**
       * ★★ E1：**先把 Pi 无条件追加的 cwd 尾巴剥掉**，再交给学段出口。
       *
       * 根因（实测 0.85.1）：`buildSystemPrompt()` 在 `customPrompt` 分支的最后无条件执行
       *   `prompt += "\nCurrent working directory: " + cwd.replace(...)`
       * （`node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:33`）——
       * `systemPromptOverride` 只管默认 prompt，管不住这一行。结果是会话状态里
       * `systemPrompt = "四学段模板…\nCurrent working directory: C:/Users/<用户名>/…"`，
       * 而这份 prompt 会**真的发给云端模型**（违背 Pi issue #6308 的硬约束）。
       *
       * ⚠️ 学段扩展（`extensions/grade.ts` 的 `buildGradeSystemPrompt`）在「认不出别的模板」
       *   时的分支是**原样保留** incoming —— 所以尾巴得在**调用它之前**就剥掉，
       *   否则它会被原样带进 `state.lastPrompt` → 下一轮再被 Pi 追加一次 → 层层累积。
       *   学段扩展本身**不需要改**（它是通用拼装器，不认识 cwd 这种 Pi 内部产物）。
       */
      const cleaned = typeof base === 'string' ? stripPiCwdBlock(base) : undefined
      // ★ 单一出口：学段（权威段）+ 学生情况（画像快照）都在 buildSystemPrompt 里拼
      const prompt = buildSystemPrompt(cleaned)
      state.lastPrompt = prompt
      return { systemPrompt: prompt }
    })

    // ★ provider 边界（§12 的第二道脱敏）：这里能拿到**真正要发出去的 payload**。
    //   本项目的纪律是「不打印 payload」，所以这一道的实际动作是：
    //   取 system prompt → 抹掉可能的密钥痕迹 → 做宿主路径断言 → 落盘作证据。
    extensionApi.on('before_provider_request', (event: unknown) => {
      state.providerRequests += 1
      const wire = extractWireSystemPrompt((event as { payload?: unknown }).payload)
      if (wire === undefined) return
      // ★ 用 `activeApiKey`（可变：热切换会换新 Key），不是建会话时的快照
      const redacted = redactSecret(wire, activeApiKey)
      state.wirePrompt = redacted
      state.wireLeaks = findHostPathLeaks(redacted, [options.userDataDir, process.execPath])
    })

    // ★★ provider 边界（§12 的第二道脱敏）的**另一半**：`before_provider_headers`。
    //
    //   `before_provider_request` 管的是**请求体**（我们只从中取 system prompt 做泄漏断言），
    //   而凭据恰恰在**请求头**里（`Authorization: Bearer sk-…`）。所以「API Key 明文不得入日志」
    //   这条纪律在 provider 边界上的落点就是这个钩子 —— 它此前**从未注册**（票 22 的欠账）。
    //
    //   ★ Pi 的语义（实测读源码，别按直觉改）：
    //     - handler **原地改 `event.headers`**，返回值被忽略（`emitBeforeProviderHeaders`）；
    //     - `ProviderHeaders = Record<string, string | null>`，赋 `null` = 删除该头。
    //   ★★ 我们的语义（**与「删除 Authorization」相反，别搞反**）：
    //     `Authorization` 是**发请求必须带**的东西。审计副本必须干净，但真实请求头一个字节都不能动 ——
    //     把 Key 抹成 `***` 会让每一轮对话都 401。所以本钩子**只读不写**：
    //     取脱敏副本（Python 的 `redact_provider_headers` 是唯一实现）→ 断言「副本里没有明文 Key」
    //     → 记进状态供验收与日志（**只记头名与命中项，绝不记值**）。
    //
    //   异常纪律：脱敏服务挂了也绝不拦住这一轮（extensions/index.ts 的注册器自兜异常，
    //   这里再兜一次是因为「审计失败」与「对话失败」必须解耦）。
    extensionApi.on('before_provider_headers', (event: unknown) => {
      const headers = (event as { headers?: unknown }).headers
      if (!headers || typeof headers !== 'object') return
      state.headerAudits += 1
      const names = Object.keys(headers as Record<string, unknown>)
      // ★ 头名级别的诊断（`K12_PI_TRACE=1` 时打开）：**只打头名，绝不打值**。
      //   为什么要它 —— 实测发现（0.85.1 + openai-completions + `apiKey` 形态）：
      //   Pi 传给本 hook 的 `headers` 是**空对象**，`Authorization` 由底层 SDK 在
      //   `transformHeaders` **之后**注入（用本机假 provider 抓到的地面真值：
      //   网络上确实有 `authorization`，而 hook 里 names=[]）。
      //   所以「hook 触发了但没看到敏感头」是**正常形态**，必须能和「hook 没触发」分开。
      if (tracePiEvents && state.headerAudits <= 3) {
        console.warn(
          `[safety] provider 头 hook 第 ${state.headerAudits} 次触发，头名=[${names.join(', ')}]（值一律不打印）`
        )
      }
      if (names.length === 0) {
        // ★ 兜底审计：hook 看不到头时，**能审计的就剩「凭据本身」** —— 而它才是敏感度的源头。
        //   判定可执行：密钥必须能被 `redactSecret` 完整抹掉（日志侧唯一实现）。
        //   抹不掉的密钥 = 一旦进了任何日志就再也清不掉，这是必须当场发现的问题。
        //   ★ 读 `activeApiKey`（热切换后是新 Key），不是建会话时的快照。
        const key = activeApiKey
        if (key && key.length >= 6 && redactSecret(key, key) !== '***') {
          console.error('[safety] 凭据脱敏断言失败：API Key 无法被完整抹除（不得进入任何日志）')
        }
        return
      }
      void auditProviderHeaders(headers as Record<string, string | null>)
        .then((audit) => {
          // ★ 审计断言（自证清白）：脱敏副本里绝不允许原样出现真实 Key。
          //   与 `findHostPathLeaks` 同一性质 —— 把「应该做到的事」写成可判定的检查，
          //   而不是只在注释里声明。失败时**只说结论**（不打印任何值）。
          //   ★ 比对基准是 `activeApiKey`（**当前生效**那把，热切换后跟着变）：
          //   拿旧 Key 去比等于把这条断言变成永远通过的空壳（那正是它要拦的泄漏）。
          const key = activeApiKey
          if (key && key.length >= 6) {
            const leaked = Object.values(audit.headers).some((value) => value.includes(key))
            if (leaked) {
              console.error('[safety] provider 头脱敏断言失败：审计副本里仍有明文 Key（脱敏实现有缺口）')
            }
          }
          // ★ 可观测（验收要求「show the hook being invoked」）：只在**确实有敏感头**时出一行，
          //   免得每一轮都刷屏。**只打头名与来源，绝不打值**（§12）。
          if (audit.sensitiveKeys.length > 0) {
            console.warn(
              `[safety] provider 头审计（第 ${state.headerAudits} 次）：已脱敏 ${audit.sensitiveKeys
                .map((key) => key.toLowerCase())
                .join('、')}（实现来源=${audit.source}；真实请求头未被修改）`
            )
          }
        })
        .catch((error: unknown) => {
          // 审计是**旁路**：它失败不影响这一轮对话（Pi 也会吞掉 handler 异常并报给扩展）
          console.warn(
            `[safety] provider 头审计失败（不影响本轮对话）：${
              error instanceof Error ? error.message : String(error)
            }`
          )
        })
    })
  }

  /**
   * ★★ 票 08 的注册点：五个业务扩展（+ `rag_search`）与轨迹扩展。
   *
   * 为什么是「`runtime.ts` 静态 import 后注入」而不是让 `extensions/index.ts` 自己 import：
   *   - 未落地的扩展文件**不能让整个主进程起不来**（连「对话答疑」这条已通的主线都会挂）——
   *     注册器把缺的列进 `missing` 点名告警，`strict` 时才抛；
   *   - 静态 import 的代价在这里付得起：这些模块只依赖 `@sinclair/typebox` 与 `bridge/client.ts`。
   *
   * ⚠️ 组装这份 `factories` 时**只列已经落地的文件**。`animation.ts`（票 16/17）、
   *    `coding.ts`（票 18/19）尚未落地 —— 静态 import 一个不存在的文件
   *    会让 electron-vite 构建当场失败，所以它们落地后在这里补 import + 一行键值即可：
   *      `animation: animationExtension,` / `coding: codingExtension,`
   *    在补齐之前：开发态 `strict: false` → 日志里点名告警、其余能力照常；
   *    打包态 `strict: true`（`app.isPackaged`）→ 直接抛，**不让「半套能力」被当成完成品发出去**。
   *
   * `rag_search` 不在六个扩展的清单里（`AGENT_EXTENSION_SPECS` 只有六个业务扩展），
   * 但它和它们一样是 `extensionFactories` 入口的工厂，所以走 `extra` 注入（键名与
   * `EXTRA_TOOL_MODULES` / `AGENT_EXTENSION_SPECS` 的对齐关系见 `extensions/index.ts`）。
   */
  const agentExtensionsFactory = (extensionApi: PiExtensionLike): void => {
    const report = registerAgentExtensions(extensionApi as unknown as AgentExtensionApi, {
      factories: {
        quiz: quizExtension,
        // 动画（票 16/17）：模板优先 + 校验 + 重试 ≤3 + 降级文字/静态图。
        // 重试计数在扩展内部的 Map 里 —— `tool_execution_end` 是**只读通知**，不能靠它回写。
        //
        // ★★ 票 17 的补充路径（自由生成）在这里**真正接上**（审计结论：此前没接 `generate`，
        //    于是「模板未命中 → 自由生成 → 降级」这条被单测覆盖的链路在生产里**不可达**）。
        //    `createAnimationGenerator` 的分工：模型出片段 → Python 拼装+校验 → 不过则重试/降级。
        //    **无 Key 时它直接抛**（`complete` 是 `lazyComplete`，拿不到实现就拒绝），
        //    扩展随即降级为文字 + 静态 SVG —— 有兜底，不白屏。
        animation: createAnimationExtension({
          generate: createAnimationGenerator({ complete: lazyComplete })
        }),
        // 编程（票 18/19）：模板 / 分级求助 / 报错翻译。
        // ★ 它**不执行学生代码** —— 执行经 IPC 下发到渲染进程的 Pyodide Worker。
        coding: codingExtension,
        // ★ 学段推断（票 21）：注册顺序在 `chatFactory` **之后** —— 它的 `before_agent_start`
        //   读 chatFactory 垫好的模板再整段换成推断出的学段（Pi 的返回值链式叠加）。
        grade: gradeExtension
      },
      extra: [
        { name: 'rag-search', factory: ragSearchExtension },
        {
          name: 'trace',
          factory: createTraceExtension(trace, (records) => {
            // 投影成界面要的那几个字段（**不带** toolCallId / at / blockReason：
            // 那些是排查用的，界面放不下，也容易夹带内部信息）。
            options.onTraceRecord?.(
              records.map((record) => ({
                turn: record.turn,
                toolName: record.toolName,
                argsSummary: record.argsSummary,
                ok: record.ok,
                latencyMs: record.latencyMs,
                ...(record.degraded ? { degraded: record.degraded } : {})
              }))
            )
          })
        }
      ],
      // ★ 开发态宽松（缺文件只告警，对话主线不受影响）；打包态严格（缺一个就抛）
      strict: app.isPackaged
    })
    extensionReport = report

    // 结论进 stderr：`describeRegistryReport` 是启动日志与验收记录共用的统计口径
    const summary = describeRegistryReport(report)
    if (report.ok) console.warn(`[agent] ${summary}`)
    else console.warn(`[agent] ${summary}（开发态正常；打包前必须全部就位）`)
    if (report.failed.length > 0) {
      console.error(`[agent] 注册失败的扩展：${report.failed.map((entry) => `${entry.name}（${entry.error}）`).join(' / ')}`)
    }
  }

  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd ?? paths.root,
    agentDir: paths.agentDir,
    // 第一道：不让 Pi 拼默认 prompt（默认那份会列出 readme/docs 的绝对路径）。
    // ★ 学段是**推断**出来的（`extensions/grade.ts`），所以这里也走同一个出口 ——
    //   三道覆盖（这里 + `before_agent_start` + 三条早退落盘）必须给出**同一份**文本，
    //   否则第一轮与后续轮次的提示词会不一致（前者带权威段、后者不带）。
    //   ⚠️ 建会话时学生情况块还是空串（每轮预取才填上），这里因此只出学段模板 —— 见
    //   `buildSystemPrompt` 的注释（每轮由 `before_agent_start` 覆盖，是预期行为）。
    systemPromptOverride: () => buildSystemPrompt(undefined),
    // ★ 注册顺序 = 执行顺序（`before_agent_start` 的返回值链式叠加，后注册者看到前者结果）：
    //   ① 学段注入 + provider 边界审计（本文件的 chatFactory）
    //   ② 六个业务 Extension（票 08 的注册器）+ 轨迹扩展（票 08 基础设施）
    // 三个工厂都经 Pi 的加载器注入（**不是** `pi.registerExtension`，Pi 没有那个 API）。
    extensionFactories: [chatFactory, agentExtensionsFactory],
    // 不扫描磁盘上的扩展/技能/模板/主题/上下文文件：本应用只认自己注册的能力
    // （`noExtensions` 不影响 `extensionFactories`，业务扩展全在下面那个工厂里注册）
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  })
  await resourceLoader.reload()

  // ③ ★ 会话落盘隔离（票 09 的核心）：目录**按学生**给，且建完当场校验 Pi 真的认了。
  //    `SessionManager.create/open/continueRecent` 的第二个参数（`sessionDir`）一旦漏传，
  //    Pi 会静默退回 `~/.pi/agent/sessions/--<cwd>--/`（跨学生混放的合规硬伤）。
  //    ★ 三种来源**都要过这道断言**（见下方 `openSessionManager`）：
  //      「恢复会话」这条路同样可能读错目录 —— 而它读错的后果比新建更严重
  //      （新建只是写错地方，恢复是**读到了别人的对话**）。
  const sessionSource: ChatSessionSource = options.sessionSource ?? 'new'
  const sessionManager = openSessionManager(sessionSource) as PiSessionManagerLike
  assertSessionManagerIsolated(sessionManager, paths.sessionDir, `学生 ${paths.studentId} 的会话`)
  const sessionId = sessionManager.getSessionId?.() ?? ''

  /**
   * 按来源建/开 `SessionManager`（三种形态的唯一落点）。
   *
   * ★ 为什么三种都在一个函数里：断言、目录参数、cwd 覆盖这三件事对三种形态是同一套，
   *   分成三处写就会出现「新建那条传了 sessionDir、恢复那条忘了」这种不对称缺陷。
   */
  function openSessionManager(source: ChatSessionSource): unknown {
    // ★★ cwd 取自 `piSessionCwd()`（**与「列出历史会话」共用同一个拼装点**）：
    //    两处各写一个值 = 列表恒为空（Pi 在传了自定义 sessionDir 时会额外按 cwd 过滤，
    //    且不报错）—— 见 `pi-paths.ts` 里 `piSessionCwd` 的注释与 P-102。
    const cwd = options.cwd ?? piSessionCwd(paths)
    const manager = pi.SessionManager as unknown as {
      create(cwd: string, sessionDir?: string): unknown
      continueRecent(cwd: string, sessionDir?: string): unknown
      open(path: string, sessionDir?: string, cwdOverride?: string): unknown
    }
    // ★ `cwdOverride` 传学生目录：会话头里可能记着**另一台机器 / 另一个安装位置**的 cwd
    //   （学生把 userData 拷过来的情况），不覆盖就会让 Pi 按一个不存在的路径去发现项目资源。
    if (typeof source === 'object') return manager.open(source.path, paths.sessionDir, cwd)
    if (source === 'recent') return manager.continueRecent(cwd, paths.sessionDir)
    return manager.create(cwd, paths.sessionDir)
  }

  /**
   * ★★ 从**已经打开的那条会话**里读回已有内容（恢复会话时用；新会话时全是空的）。
   *
   * 两件事一起做，因为它们读的是同一份 `getEntries()`（分两处各读一次会有两次全量解析）：
   *
   *   1. **`messageCount`** —— 「该不该发开场引导」的判据。★ 只数 `type === 'message'`
   *      且角色是 user/assistant 的条目：刚建的会话已经有 `model_change` /
   *      `thinking_level_change` 好几条，用 `getEntries().length` 判会让开场语**永远发不出来**。
   *   2. **`restoredMessages`** —— 投影成 `{role, text, at}`，界面据此把历史铺回消息列表。
   *
   * ★ 用 `projectTranscript`（**与「只读回看」同一个纯函数**）：两处各写一份解析，
   *   就会出现「回看里显示的消息」与「恢复出来继续聊的消息」不一致 ——
   *   而它们读的是同一份 JSONL，任何不一致都是解析差异，不是数据差异。
   * ★ 它**不抛**：读不出历史只是「这段对话显示不出来」，重启后重开一次就好；
   *   让它抛会把「续聊最近会话」整条路带崩（学生看到的是打不开的应用）。
   */
  function readExistingSession(): { messageCount: number; restored: TranscriptMessage[] } {
    try {
      const entries = (sessionManager as { getEntries?(): unknown[] }).getEntries?.() ?? []
      const projected = projectTranscript(entries)
      return { messageCount: projected.messages.length, restored: projected.messages }
    } catch (error) {
      console.warn(
        `[agent] 读取会话已有内容失败（按空会话处理）：${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return { messageCount: 0, restored: [] }
    }
  }

  /**
   * 只数「可显示的问答条数」（**不抽正文**）。
   *
   * ★ 与 `readExistingSession()` 分开是为了**代价**：`projectTranscript` 会把每条消息的
   *   文本块拼出来（一个长会话就是几十 KB 的字符串拼接），而调用方要的往往只是一个数
   *   （「该不该发开场语」）。两者的判据必须一致（都只认 user/assistant 的 message 条目），
   *   所以这里复用同一个过滤口径：`projectTranscript` 的结果长度。
   *   ⚠️ 不复用会漂移：一处按 `type === 'message'` 数、另一处按 `role` 数，
   *   差值正好是 toolResult 那些条目 —— 而「数错一个」就能让开场语多发一次。
   */
  function countMessages(): number {
    try {
      const entries = (sessionManager as { getEntries?(): unknown[] }).getEntries?.() ?? []
      return projectTranscript(entries).messages.length
    } catch {
      return 0
    }
  }

  const existing = readExistingSession()

  /**
   * 取投影里**末尾那一对 (user, assistant)**的条目 id（见接口上的说明）。
   *
   * 从后往前找：第一条 assistant 就是本轮的回答；再往前找第一条 user 就是本轮的问题。
   * 没有 assistant（本轮失败 / 还在跑）时，`entryId` 留空、只给 `userEntryId` ——
   * 那样界面上「从我的提问处重来」仍然可用，而「从他那条回答处重来」不显示。
   */
  function lastTurnEntries(): { userEntryId: string; entryId: string } {
    let messages: readonly TranscriptMessage[] = []
    try {
      const entries = (sessionManager as { getEntries?(): unknown[] }).getEntries?.() ?? []
      messages = projectTranscript(entries).messages
    } catch {
      return { userEntryId: '', entryId: '' }
    }
    let entryId = ''
    let userEntryId = ''
    let index = messages.length - 1
    // ① 末尾的 assistant（可能没有）
    for (; index >= 0; index -= 1) {
      const message = messages[index] as TranscriptMessage
      if (message.role === 'assistant') {
        entryId = message.entryId
        break
      }
      // 遇到 user 就停：说明本轮还没产出回答
      if (message.role === 'user') break
    }
    // ② 它前面最近的那条 user
    for (let i = index >= 0 ? index : messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as TranscriptMessage
      if (message.role === 'user') {
        userEntryId = message.entryId
        break
      }
    }
    return { userEntryId, entryId }
  }

  /**
   * ★ 把当前学生上下文写进扩展层（`extensions/index.ts` 的 `bindAgentSession`）。
   *
   * 契约是「**每次建会话 / 切学生时都要调用**」：Tool 里的 `currentAgentSession()` 只可能拿到
   * 主进程写进来的这份 —— 学段推断（`grade.ts`）、画像、学习记录都靠它，而学生身份**不是**
   * Tool 参数（模型连表达「读别人」的能力都没有）。建会话时先绑一次，每轮再绑一次刷新会话 id。
   *
   * ★ 它同时是**手动设学段之后的重新绑定入口**（`setGradeLevel` 里调用）：
   *   学段一旦换了，扩展层里那份 `AgentSessionContext.gradeLevel` 也必须跟着换，
   *   否则 `learning-log` 这类每轮读上下文的地方还按旧学段记账。
   */
  const bindCurrentSession = (): void => {
    bindAgentSession({
      studentId: paths.studentId,
      // 会话 id 每轮重取：Pi 换会话文件（/new、branch）后 `learning_history.session_id` 要跟着变
      sessionId: sessionManager.getSessionId?.() ?? sessionId,
      // ★ 学段来自**推断**（唯一权威来源）：`grade.ts` 的 `appliedGrade()`。
      //   本地不再维护第二份学段状态（旧实现的 `state.grade` 会让「哪一份算数」变成猜谜）。
      gradeLevel: gradeExtension.appliedGrade()
    })
  }
  bindCurrentSession()

  // ★ 冷启动把服务端已存的学段取回来（`grade.ts` 的 `refresh()`）。
  //   不 await：它要发一次本机 HTTP，绝不能拖慢建会话；`refresh()` 内部自己吞异常，
  //   sidecar 还没起来时只记一条 warn（干净降级 —— 第一轮用默认学段，第二轮回正）。
  void gradeExtension.refresh()

  /**
   * ★ 解析 provider 下要用的模型，**按优先级回落到该 provider 的第一个可用模型**。
   *
   * 为什么必须回落而不是直接抛：设置里存的 ModelID 可能是一个**该 provider 不认识的名字**
   * （典型来源：旧版默认值 `deepseek-chat`，它不在 Pi 内置 deepseek 目录里；
   * 或用户手填错）。此时直接抛「Pi 里找不到模型」会让**整个对话不可用**，
   * 而回落成「同一 provider 的另一个模型」至少还能聊 —— 并且打一条可读日志说清楚发生了什么。
   *
   * ⚠️ 模型**查表**（`getModel` / `getModels`）与凭证无关，所以这里可以在 `setRuntimeApiKey`
   * 之前调用；真正依赖凭证的是紧随其后的 `checkAuth`（它决定 `authReady`，进而决定三个降级分支）。
   */
  const resolveModelForProvider = (providerId: string, modelId: string): unknown => {
    const exact = modelRuntime.getModel(providerId, modelId)
    if (exact) return exact

    const first = modelRuntime.getModels(providerId)[0]
    if (first) {
      console.warn(
        `[agent] 设置的模型 ${providerId}/${modelId} 不在 Pi 的模型目录里，` +
          `已回落到 ${providerId}/${(first as { id?: string }).id ?? '(未知)'}。` +
          '请在设置页点「拉取模型」确认可用的模型名。'
      )
      return first
    }
    // 该 provider 一个模型都没有：这才是真正的装配失败（自定义 provider 没写 models[] 就是这种形态）
    throw new Error(
      `Pi 里找不到模型 ${providerId}/${modelId}，且 provider「${providerId}」没有报出任何模型。` +
        '自定义供应商需要至少一个模型定义（models.json 的 models[]），请检查设置页的 ModelID。'
    )
  }

  const model = resolveModelForProvider(credentials.providerId, credentials.modelId)

  // Key 只进内存（`setRuntimeApiKey`），**不写 auth.json**（合规：凭证仅本地且不落日志）
  const runtimeKey = credentials.apiKey ?? (useProbe ? PROBE_API_KEY : undefined)
  if (runtimeKey) await modelRuntime.setRuntimeApiKey(credentials.providerId, runtimeKey)
  const effectiveModel = useProbe ? { ...(model as object), baseUrl: PROBE_BASE_URL } : model

  /**
   * ★★ **当前凭证状态**（可变：`applyLlmConfig()` 会就地更新）。
   *
   * ⚠️ 为什么不能直接用 `credentials` / 建会话时算出来的 `authReady` 常量：
   * 热切换（保存设置后补上 Key）之后，那两个值就是**过期的快照**了。
   * 用它做每轮的门禁会出现「Key 明明配好了，还是回你『没有配置 API Key』」——
   * 实测踩到过：会话在 sidecar 就绪前降级建出来，随后热切换成功，但每轮仍被旧快照挡下。
   *
   * 所以门禁一律读这一份，不再读 `credentials`。
   */
  const credentialState = {
    /**
     * 当前 provider 是否有可用 Key（**每次应用配置时按本次配置重算**，不用 `||` 累积）。
     *
     * 旧实现写的是 `Boolean(config.apiKey) || credentialState.hasKey` —— 只增不减，
     * 于是「清空 Key」或「切到没有 Key 的新供应商」之后它卡在 `true`，
     * 三道门禁（每轮对话 / 自审 / 判学段）全部拿它当「有 Key」，继续发请求。
     */
    hasKey: Boolean(credentials.apiKey),
    /** Pi 的 `checkAuth` 是否通过（Key 形态不对时会在补录时更新）。 */
    authReady: false
  }

  // ★ 凭证就绪判定必须在**填充补全器之前**做完（它是三处降级分支的共同判据）
  const auth = await modelRuntime.checkAuth(credentials.providerId)
  credentialState.authReady = auth !== undefined

  /**
   * ★★ 模型通道的**填充**（`lazyComplete` 的芯；三个用途共用，见文件上方 `completerHolder` 的说明）。
   *
   * 三个必要条件缺一不可（这就是「无 Key 世界干净降级」的判据）：
   *   1. `credentialState.hasKey` 存在 —— 才有真的凭证；
   *   2. `credentialState.authReady` —— Pi 的 `checkAuth` 也认了（Key 形态不对时这里就挡下）；
   *   3. **不是离线探针** —— 探针用的假 Key 指向不可达地址，拿它去跑自审/判学段毫无意义，
   *      只会白等超时。探针模式的存在意义只有「把 prompt 走到终态」，与模型能力无关。
   *
   * 上面任一条不满足 → `completerHolder` 保持 `null` → 三个用途各自降级（**都不崩、都不挂**）：
   *   - 内容安全：自审那半跳过，**词表那半照跑**（无 Key 也可用）；
   *   - 学段第二层：`grade.ts` 报 `no_llm`（服务端出参里也标 `degraded`），第一层照常改学段；
   *   - 动画自由生成：`generate` 抛「没有 API Key」→ 扩展降级为文字 + 静态 SVG。
   */
  /**
   * ★ 填充补全器（三个用途共用的模型通道；判据见上方那段注释）。
   *
   * 抽成函数而不是内联，是因为**热切换后要能重新填**：启动时没有 Key 的会话
   * （或 sidecar 还没起来、配置还没读进来的会话）在补上 Key 之后，
   * 自审 / 判学段 / 动画生成这三条链路都应当恢复可用。
   */
  const fillCompleter = (modelForCompleter: unknown): void => {
    if (!credentialState.hasKey || !credentialState.authReady || useProbe) {
      // ★ 反向也要做对：判据不满足时**必须清掉**已有的补全器。
      //   否则「热切换把 Key 清空」之后，`completerHolder` 还是旧连接 → 三个用途继续用
      //   已删除的 Key 发请求（与 `removeRuntimeApiKey` 同一条纪律，见 `applyLlmConfig`）。
      completerHolder = null
      return
    }
    completerHolder = createModelCompleter(modelRuntime as never, modelForCompleter, {
      // 自审/判学段/生成片段都是**纯文本任务**：不给工具（模型能调用工具就会去调，
      // 而那些工具会改学生数据）。`maxTokens` 给够写一段片段，不追求长输出。
      maxTokens: 1_200,
      temperature: 0
    })
  }
  fillCompleter(effectiveModel)

  const customTools = debugThrowTools(pi)
  const { session } = await pi.createAgentSession({
    cwd: options.cwd ?? paths.root,
    agentDir: paths.agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager,
    model: effectiveModel,
    // 内置 read/bash/edit/write 全关：模型没有任何系统能力（扩展注册的 Tool 不受影响）
    noTools: 'builtin',
    customTools
  })

  /**
   * ★★ 学段第二层（LLM 判定）的**接线点**（票 21）。
   *
   * `grade.ts` 的 `useJudge()` 是它自己文档里点名的注入点，但**此前没有任何生产调用方**
   * （审计结论：`grep useJudge src/main` 只有定义与注释）—— 后果是第二层**永远**报 `no_llm`，
   * 即便本机配好了 Key，而执行文档 §10.3 的「第 3 轮（不足则第 5 轮）触发一次轻量 LLM 判定」
   * 因此从未真正生效过。
   *
   * 判定 prompt 的模板与响应解析都复用 `grade.ts` 的导出（`buildJudgePrompt` / `parseProposal`）——
   * **不在这里另写一份**，否则「模型该怎么答」与「我们怎么读」会各改一半。
   *
   * ★ **总是接线**，由闭包在**调用时**判定有没有可用的模型通道：
   *   会话初建时可能没有 Key（或 sidecar 还没起来、配置还没读进来），
   *   而 `useJudge()` 只建会话时调一次 —— 传 `null` 就等于「第二层永久关闭」，
   *   那些启动期没 Key 的会话即便后来补上了 Key 也再不会做判定（实测踩到过）。
   *   所以这里传一个「调用时再判」的函数：没通道就返回 `null`，扩展照常把状态标成
   *   `no_llm` / `judge_error`，第一层规则引擎完全不受影响。
   */
  gradeExtension.useJudge(async ({ turns, currentGrade }) => {
    // 没有可用通道（无 Key / 探针）→ 交给扩展走它的降级分支（它会说清楚是哪一种）
    if (!credentialState.hasKey || !credentialState.authReady || useProbe) return null
    try {
      const raw = await lazyComplete({
        prompt: buildJudgePrompt(turns, currentGrade),
        timeoutMs: JUDGE_TIMEOUT_MS
      })
      return parseProposal(raw)
    } catch (error) {
      // 判定失败 = 这一轮只用第一层（`grade.ts` 会把状态标成 `judge_error` 并记日志）
      console.warn(
        `[grade] 第二层 LLM 判定调用失败（本轮只用第一层规则信号）：${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return null
    }
  })

  /**
   * ★ 学段装配自检（**常驻**，但只在异常时出声）：建完会话当场验证 prompt 出口能用。
   *
   * 为什么要有它：学段推断曾经**整体静默失灵**（`grade_signals` 0 行、prompt 里
   * grep 不到学段），而进程、日志、UI 全都没有任何异常 —— 只有「没动静」。
   * 一条「没动静」的故障不该靠人工读库才发现，所以这里主动做一次可判定的检查：
   * `systemPromptFor()` 的输出**必须**含权威段标题，否则题词覆盖没生效。
   * 通过时**保持安静**（不刷日志），失败时打一条 error 说清看哪里。
   */
  try {
    const prompt = buildSystemPrompt(undefined)
    if (!prompt.includes(GRADE_OVERRIDE_HEADING)) {
      console.error(
        '[agent] 学段装配自检未通过：system prompt 里没有权威段标题（' +
          `${GRADE_OVERRIDE_HEADING}）—— 学段覆盖不会生效，请检查 extensions/grade.ts 的 systemPromptFor`
      )
    }
  } catch (error) {
    console.error('[agent] 学段装配自检抛异常（学段推断本轮不可用）：', error)
  }

  let disposed = false
  let busy = false
  return {
    paths,
    studentId: paths.studentId,
    sessionId,
    sessionSource,
    get messageCount() {
      // ★ 读**当前**条数（不是装配时的快照）：跑过几轮之后它必须跟着长 ——
      //   调用方（`ipc/handlers.ts`）靠它判断「这条会话该不该发开场语」，
      //   拿一个永不更新的常量会让「新会话」与「已聊过的会话」再也分不开。
      return countMessages()
    },
    // ★ 读**当前**投影（不是装配时的快照）：跑过几轮之后新消息也要带上各自的
    //   条目 id —— 否则「从这里重新问」只对历史消息可用（实测踩到，见 P-105）。
    get restoredMessages() {
      return readExistingSession().restored
    },
    credentials: useProbe ? { ...credentials, offlineProbe: true, source: 'offline-probe', apiKey: undefined } : credentials,
    // ★ 读**当前**凭证状态（可变）：热切换补上 Key 之后这里要跟着变，
    //   否则调用方会一直以为「还没配好」（实测踩到过）。
    get authReady() {
      return credentialState.authReady
    },
    get gradeLevel() {
      return gradeExtension.appliedGrade()
    },
    get lastSystemPrompt() {
      return state.lastPrompt
    },
    get wireSystemPrompt() {
      return state.wirePrompt
    },
    get promptLeaks() {
      return state.wireLeaks
    },
    get providerRequestCount() {
      return state.providerRequests
    },
    get extensionReport() {
      const report = extensionReport
      return {
        registered: report?.registered ?? [],
        missing: report?.missing.map((entry) => entry.name) ?? [],
        missingTools: report?.missingTools ?? []
      }
    },
    trace,

    /**
     * ★★ 保存设置后热切换 LLM 配置（见接口注释；「设置改完即生效」的落地）。
     *
     * ⚠️ 离线探针模式（`useProbe`）下**不切换**：探针的意义是「不碰真实供应商」，
     *   给它换上真实 Key 会当场破坏这个前提。直接返回即可（那种形态本来就只在排查时开启）。
     */
    async applyLlmConfig(config: LlmConfigForPi & { apiKey?: string }) {
      if (useProbe) {
        console.warn('[agent] 离线探针模式忽略 LLM 配置热切换（探针不接触真实供应商）')
        return
      }
      if (disposed) throw new Error('会话已关闭，无法切换 LLM 配置。')

      const providerId = config.providerId.trim() || credentials.providerId
      const nextCatalog = await builtinCatalog(options.userDataDir).catch(() => [])
      writeModelsJson(
        paths,
        {
          providerId,
          providerName: config.providerName,
          baseUrl: config.baseUrl,
          modelId: config.modelId
        },
        nextCatalog
      )

      // ★ 只刷新这一个 provider：全量 rebuild 会把另外 39 个也重建一遍，没有必要。
      await modelRuntime.refresh({ providers: [providerId], allowNetwork: false })
      /**
       * ★★ Key 只进内存（与建会话时同一条纪律：绝不写 `auth.json`），并且**两个方向都要做**：
       *
       *   - 有新 Key → `setRuntimeApiKey()`；
       *   - **没有新 Key（用户清空/换到没配 Key 的供应商）→ `removeRuntimeApiKey()`**。
       *
       * 为什么后者不能省（实测真机 `ModelRuntime`）：清空 Key 之后 `checkAuth` 仍然报
       *   `{"type":"api_key","source":"stored credential"}` —— 内存里那把旧 Key 还活着，
       *   于是内容安全自审 / 学段第二层 / 动画自由生成**继续用用户以为已经撤销的 Key 发请求**。
       *   `removeRuntimeApiKey` 是 Pi 的真实 API（`model-runtime.d.ts:83`），只动内存。
       *
       * ⚠️ 顺序：必须在 `checkAuth` **之前**做完，否则 `authReady` 算的是旧状态。
       */
      if (config.apiKey) await modelRuntime.setRuntimeApiKey(providerId, config.apiKey)
      else await modelRuntime.removeRuntimeApiKey(providerId)
      // ★ 记账同步：`activeApiKey` 是两条脱敏自证断言（prompt / header）唯一的比对基准，
      //   不更新它 = 拿旧 Key 去比 → 新 Key 泄漏时断言静默通过。
      activeApiKey = config.apiKey

      const nextModel = resolveModelForProvider(providerId, config.modelId)
      await session.setModel(nextModel)
      // 切换成功后**才**更新「当前生效」的记账（失败时保持原样，诊断不会说谎）
      activeLlm.providerId = providerId
      activeLlm.modelId = config.modelId

      /**
       * ★★ 同步刷新**凭证状态**（这是「热切换后能不能真的聊起来」的关键一步）。
       *
       * 为什么必须重算：`hasKey` / `authReady` 是每轮门禁的判据（见 `runTurn` 里那两处早退）。
       * 不重算的话，「启动时没 Key → 后来配上了」这条路会一直回「缺少 API Key」，
       * 而 Pi 那边其实已经拿到 Key 了 —— 用户看到的是「配置明明存住了却没用上」。
       * `checkAuth` 读的是 runtime 覆盖层（`setRuntimeApiKey` / `removeRuntimeApiKey` 刚改过的那把），
       * 所以这里直接查得到。
       *
       * ★ **按本次配置重算，不用 `||` 累积**：`hasKey` 只增不减会让「清空 Key」与
       *   「切到没 Key 的供应商」两条路都卡在 `true`（门禁全放行，继续发请求）。
       */
      credentialState.hasKey = Boolean(config.apiKey)
      credentialState.authReady = (await modelRuntime.checkAuth(providerId)) !== undefined
      // ★ 补上 Key 之后要把模型通道**重新填上**：启动时没 Key 的会话，
      //   自审 / 判学段 / 动画生成这三条链路都要跟着恢复（否则「配好了也只有对话能用」）；
      //   反过来清掉 Key 时 `fillCompleter` 会把通道清空（同一条纪律的另一半）。
      fillCompleter(nextModel)

      // 诊断（`K12_PI_TRACE=1`）：只打结构性字段，**绝不打印 Key**
      if (tracePiEvents) {
        console.warn(
          `[pi] 已热切换 LLM 配置：provider=${providerId} model=${config.modelId}` +
            // ★ `baseUrl` 必须过脱敏（本轮修正）：本项目支持「校内网关 / 自建服务」，
            //   而这类网关的惯例是把凭据放**查询串**（`https://gw.school.edu/v1?key=…`）——
            //   直接打印就把用户以为只存在配置里的凭据写进了日志。
            //   诊断要的只是「打到哪个地址」，查询串对排查没有价值（`sanitizeProviderText`
            //   会把它抹成 `key=***`，路径与主机名照旧可见）。
            ` baseUrl=${sanitizeProviderText(config.baseUrl ?? '', activeApiKey)}` +
            ` authReady=${credentialState.authReady}`
        )
      }
    },

    /**
     * ★ 学生手动设定学段（`grade:set` 通道的唯一实现，见接口上的注释）。
     *
     * 顺序不能乱：
     *   ① **先写库**（服务端是唯一写库方）：失败就此为止，进程内状态一点都不动
     *      （绝不能出现「界面上显示初中、库里还是小学高年级」这种两套真值）；
     *   ② `adoptOverride()` —— 立即生效 + 清 `pendingGrade` + bump epoch（作废在途推断）；
     *   ③ `bindCurrentSession()` —— 让扩展层那份 `AgentSessionContext.gradeLevel` 立刻跟上，
     *      否则 `learning-log` 等每轮读上下文的地方还按旧学段记账（**只在成功后**重新绑，
     *      不放在 ① 之前：那会让「写库失败」也留下一次无意义的上下文写入）。
     *
     * ⚠️ 与 `runTurn` 里的两次 `bindCurrentSession()` 一样，它**不碰** `busy` 门禁：
     *   设定学段是控制面的动作，不该被「上一条回答还没说完」挡住（学生改学段的时刻
     *   完全可能正在流式输出中，而那正是他最想改的时刻）。
     */
    async setGradeLevel(
      gradeLevel: GradeLevel
    ): Promise<{ changed: boolean; cooldownRemainingTurns: number }> {
      if (disposed) throw new Error('会话已关闭，无法设定学段。')
      const result = await postGradeOverride(paths.studentId, gradeLevel)
      gradeExtension.adoptOverride(result.gradeLevel, result.cooldownRemainingTurns)
      bindCurrentSession()
      // 结构性日志：只有学段与轮数，**不含任何凭证、不含学生原话**
      console.warn(
        `[grade] 学生手动设定学段：${result.previousLevel} → ${result.gradeLevel}` +
          `（冷却 ${result.cooldownRemainingTurns} 轮内不再自动调整，changed=${result.changed}）`
      )
      return {
        changed: result.changed,
        cooldownRemainingTurns: result.cooldownRemainingTurns
      }
    },

    /**
     * ★★ 主动发起对话：把开场引导写进 Pi 会话（见接口上的形态取舍表）。
     *
     * **同步、不抛**：它写的是本地 JSONL 的一个条目，失败也只影响「这句开场重启后还在不在」，
     * 不该让「新建会话」这个动作失败（那会更糟 —— 学生点一下新会话却什么都没发生）。
     * ⚠️ 写成 `assistant` 消息而**不是** `custom_message`：后者在 `convertToLlm` 里
     *    会变成 **user** 消息，于是模型以为「从X开始吧」是**学生**说的 —— 伪造对话记录。
     */
    appendOpeningMessage(text: string): void {
      const trimmed = text.trim()
      if (!trimmed || disposed) return
      try {
        const manager = sessionManager as {
          appendMessage?(message: Record<string, unknown>): string
        }
        if (typeof manager.appendMessage !== 'function') {
          // 形态不符（Pi 改过 API）：**只记日志**，界面那条开场语照常显示。
          // 退路是「重启后开场语不在历史里」，比「点了新会话没反应」轻得多。
          console.warn('[agent] SessionManager 没有 appendMessage，开场引导未能写入会话文件')
          return
        }
        manager.appendMessage({
          role: 'assistant',
          content: [{ type: 'text', text: trimmed }],
          // ★ 真实的 provider / model（不是占位符）：轨迹与成本报表按这两栏归类。
          api: 'openai-completions',
          provider: activeLlm.providerId,
          model: activeLlm.modelId,
          // ★ 全 0 **是事实**：这句由服务端模板拼出，没有花掉任何 token。
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop',
          timestamp: Date.now()
        })
        console.warn(`[agent] 已把开场引导写入会话（${trimmed.length} 字符，未消耗 token）`)
      } catch (error) {
        console.warn(
          `[agent] 开场引导写入会话失败（界面仍会显示）：${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    },

    /**
     * ★ 用一次轻量补全给当前会话起名（写进 Pi 的 `session_info` 条目）。
     *
     * 判据与降级：拿不到模型通道（无 Key / 探针）→ 直接返回 `null`，
     * 由调用方退回首条消息截断（「降级永不白屏」：标题只是列表里的一个字段）。
     *
     * ★ 提示词只包含**学生自己说的第一句**（截断到 200 字）+ 一句格式要求：
     *   不把整段对话喂进去（那是另一次不小的请求），也不要模型「总结这段对话」——
     *   标题的价值是「一眼认出是哪一段」，不是概括。
     */
    async generateSessionTitle(): Promise<string | null> {
      if (disposed) return null
      const completer = completerHolder
      if (!completer) return null

      const first = existing.restored.find((message) => message.role === 'user')?.text
      if (!first) return null

      try {
        const raw = await completer({
          prompt:
            '下面是一个学生在学习助手里说的第一句话。请为这段对话起一个标题：' +
            '不超过 12 个字、只输出标题本身、不要引号、不要标点结尾、不要解释。\n\n' +
            `学生说：${first.slice(0, 200)}`,
          timeoutMs: TITLE_TIMEOUT_MS
        })
        const title = titleFromText(raw.trim())
        // ★ 认不出（模型返回空 / 只有标点 / 返回了整段解释）时**不写**：
        //   宁可继续用「首条消息截断」，也不要写一个比它更差的标题。
        if (!title || title === '未命名') return null
        const manager = sessionManager as { appendSessionInfo?(name: string): string }
        if (typeof manager.appendSessionInfo !== 'function') return null
        manager.appendSessionInfo(title)
        console.warn(`[agent] 已生成会话标题：${title}`)
        return title
      } catch (error) {
        // 断网 / 超时 / 模型拒答：都走同一条降级（调用方用 firstMessage 截断）
        console.warn(
          `[agent] 会话标题生成失败（退回首条消息截断）：${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return null
      }
    },

    /**
     * 从某条消息处分叉（见接口上的说明）。
     *
     * ⚠️ 这里**不做白名单对齐**（那是调用方的事，见 `handlers.ts` 的 `branchFromMessage`）：
     *   本方法拿到的是「已经确认属于本条会话」的条目 id。但**它仍然兜一层** ——
     *   `createBranchedSession` 对不存在的 id 会抛 `Entry <id> not found`，
     *   这里把它翻成一句可读中文（与全项目「绝不抛异常穿过 IPC」一致）。
     *
     * ⚠️ **不 dispose 当前会话**：分叉只是**写一个新文件**，当前会话要一直活着 ——
     *   由调用方在拿到新路径之后再走 `swapToSession({path})`（那时才 dispose）。
     *   在这里提前 dispose 会让「分叉失败」变成「会话也没了」。
     */
    async branchFrom(entryId: string): Promise<{ path: string }> {
      if (disposed) throw new Error('会话已关闭，无法分叉。')
      const id = entryId.trim()
      if (!id) throw new Error('分叉失败：没有指定要分叉的消息。')

      const manager = sessionManager as {
        createBranchedSession?(leafId: string): string | undefined
      }
      if (typeof manager.createBranchedSession !== 'function') {
        throw new Error('分叉失败：当前 Pi 版本不支持会话分叉（缺 createBranchedSession）。')
      }

      let path: string | undefined
      try {
        path = manager.createBranchedSession(id)
      } catch (error) {
        // Pi 的原话是英文的 `Entry xxx not found` —— 翻成学生/排查都能用的一句中文。
        // ★ 这条**不是**「不该发生」：学生点的那条消息可能来自一个刚刚被清理的会话
        //   （渲染进程手里的历史快照已经过期），所以它是一条正常的失败路径。
        throw new Error(
          `分叉失败：这条会话里找不到那条消息（${id}）。可能它来自另一段对话，` +
            `请刷新历史列表后重试。`
        )
      }
      if (!path) {
        // `undefined` = 这个 manager 不落盘（本应用恒为落盘，所以这是防御分支）
        throw new Error('分叉失败：会话没有落盘，Pi 没有给出新会话文件。')
      }
      console.warn(`[agent] 已从消息 ${id} 分叉出新会话（原会话未改动）`)
      return { path }
    },

    lastTurnEntries,

    async runTurn(input: ChatTurnInput, sink: ChatTurnSink): Promise<ChatTurnOutcome> {
      // ★★ 学段**不在这条路径上改**：推断由 `extensions/grade.ts` 独占，
      //    学生显式设定走独立的 `setGradeLevel()`（`grade:set` 通道），
      //    两者都不借道「发一条消息」—— 对话请求里没有、也不该有学段字段（守卫 G6c）。

      // ★★ 每轮绑定当前学生上下文（票 09）：见 `bindCurrentSession()` 的注释 ——
      //    学生身份**不是** Tool 参数，模型没有表达「读别人」的能力。
      //    `bindAgentSession` 对空 id / 空学段直接抛，所以放在 try 之外、且值来自受信来源。
      bindCurrentSession()

      if (disposed) {
        emitTerminal(sink, '会话已经关闭，请重新打开对话。')
        return { ok: false, status: 'exception', detail: 'disposed' }
      }
      if (busy) {
        emitTerminal(sink, BUSY_MESSAGE)
        return { ok: false, status: 'busy' }
      }
      busy = true
      const target = useProbe ? probeSink(sink) : sink

      try {
        // ★★ 画像预取（票 20 的对话侧落点）：**必须在三条早退路径之前**
        //    （输入拦截 / 无 Key / 鉴权未过），否则那三条路径落盘的 `state.lastPrompt`
        //    与真正发出去的那一份不一致（它们都要走 `buildSystemPrompt`，读的就是这份快照）。
        //    用 `await`（不是 fire-and-forget）：本轮就要用它拼 prompt。
        //    失败降级为空串（绝不阻断对话）—— 见 `extensions/profile.ts` 的 `fetchStudentContext`。
        //    ⚠️ `busy` 已在上方置位，异常由本函数的 `finally` 兜住（不会漏掉 busy=false）。
        //
        //    ★ **为什么不清空**：下一轮的预取会覆盖它，清空只会多出「预取失败于是连上一轮的
        //      有效块也一起丢掉」这个纯损失的分支；而残留旧值的风险是有限的 ——
        //      切换学生走的是**新建会话**（`ipc/handlers.ts` 的 ensureChatRuntime → createChatRuntime），
        //      新的 `ChatRuntime` 自带一个空块，跨学生复用同一个 runtime 的路径不存在。
        studentContextBlock = await fetchStudentContext(paths.studentId)

        // ★★ 内容安全【第一道：输入侧检查】（票 22 / §12）——**在发起模型调用之前**。
        //
        //    为什么放在这里而不是 Pi 的 `input` 事件里：`input` 只在真的调 `session.prompt()`
        //    时才发，而下面的「无 Key」分支根本不调它（与学段推断同一个坑，见上）。
        //    放在这里则**两条路径都覆盖**：命中就立刻 `blocked`，一个字都不发给模型。
        //
        //    ⚠️ 判定在 Python（`guard.check_input`），这里只投递 —— **绝不在 TS 侧另写词表**。
        const inputVerdict = await reviewInput(input.text, { gradeLevel: gradeExtension.appliedGrade() })
        if (inputVerdict && !inputVerdict.allowed) {
          // 证据：本轮**没有**经过 `before_agent_start`（没调 prompt），所以这里自己拼一份
          // 「本轮按哪个学段作答」的 prompt 落盘（同一个出口 `buildSystemPrompt`，不是另写一份；
          // 画像预取已在上面完成，所以这份证据与真正会发出去的那份**逐字一致**）。
          // 拦截计数不在这里单独存 —— 下面那行 `[safety]` 日志与 `blocked` 事件本身就是证据。
          state.lastPrompt = buildSystemPrompt(undefined)
          dumpPrompts(paths, state)
          emitBlockedTurn(sink, inputVerdict)
          console.warn(
            `[safety] 输入侧拦截（不发模型请求）：类别=${inputVerdict.category} 来源=${inputVerdict.source} ` +
              `命中=${inputVerdict.matched.join('、') || '无'}（不回显正文）`
          )
          return { ok: false, status: 'blocked', detail: `输入侧命中 ${inputVerdict.category}` }
        }

        // ★★ 学段观察就在**这里** —— 两个约束夹出来的唯一位置，两个方向都不能挪：
        //
        //  ① **必须在两条对话路径之前**（票 21 返工的核心）：`grade.ts` 原本把观察挂在 Pi 的
        //     `input` 事件上，而下面「无 Key」那条分支**不会调用 `session.prompt()`** ——
        //     于是 `input` 一次都不发，学段永远不动。观察本身只是「收证据 + 交给服务端」，
        //     与能否连上模型无关（第一层规则引擎不用 LLM）。所以它必须待在下面那条早退**之前**。
        //
        //  ② **必须在输入侧安全检查之后**（本轮修正）：被拦下的那条消息**一个字都没发给模型**，
        //     学生只看到 `blocked`。旧位置在 `reviewInput` 之前，于是「这条被拦下的话」
        //     照样按它的用词与深度提取了学段信号、参与连续 3 轮同向计数、甚至把学段改掉 ——
        //     等于让一段**从未进入教学**的文本影响后续所有轮的作答难度，且学生看不到任何关联。
        //     证据必须是「真的发生过的事」，被拦下的输入不算。
        //
        //  两条约束的交集就是这里：`reviewInput` 的 return **之上**、被拦下的 return **之下**。
        //  ⚠️ 与它相邻的 `studentContextBlock = await fetchStudentContext(...)` 是**另一件事**
        //     （那是 Prompt 快照，必须在三条早退路径**之前**），不要顺手一起挪。
        //
        // 同步返回、fire-and-forget 上交：绝不拖慢本轮对话。
        // ⚠️ 顺便完成「上一轮判定 → 本轮生效」的交接（`applyPending` 就在这里面）。
        gradeExtension.observeTurn(input.text)
        // ★ 交接之后**再绑一次**：本轮的事件处理器（`agent_end` 写学习记录、Tool 读画像/题库）
        //   必须看到「本轮真正生效的学段」，而不是上一轮那一份。两次调用都是纯对象赋值，很便宜。
        bindCurrentSession()

        /**
         * ★★ 内容安全【第三道：生成结束后整段终审】的**投递管道**（票 22）。
         *
         * `createSafetyGateSink` 是一个 `TurnSink` 包装器，它做一件必须做对的事：
         * **扣住 `done`**，等终审跑完；违规时**先发 `blocked`、再补 `done`**。
         * 理由见 `safety/review.ts` 的详细注释（`done` 对渲染进程是终态，之后到达的
         * `blocked` 会被归约器丢掉 → 撤回静默失效）。
         *
         * ★ 终审必须**发生在 `done` 之前**，而 Pi 的 `agent_end` 一到就会发 `done` ——
         *   所以门在 `finish()` 里不立刻转发，而是等 `finalizeTurn()` 的结论。
         */
        const gate = createSafetyGateSink({
          inner: target,
          finalize: (text) =>
            finalizeTurn(text, {
              // 无 Key 时 `completerHolder` 为 null → 自审那半跳过；**词表那半照跑**。
              complete: completerHolder ? lazyComplete : null,
              gradeLevel: gradeExtension.appliedGrade()
            })
        })

        // 无 Key：**不调 prompt()**，直接给可读结论（Pi 在 prompt() 最开头就会因缺凭证抛错，
        // 且那时连 `before_agent_start` 都不会触发 —— 所以在这里前置判定，文案才不会退化成异常）
        // ★ 判定读的是 `credentialState`（可变）而不是 `credentials`（建会话时的快照）：
        //   热切换补上 Key 之后，这里必须放行，否则会出现「Key 配好了还说没配」（实测踩到过）。
        if (!credentialState.hasKey && !useProbe) {
          // ★ 无 Key 也要把「本轮按哪个学段作答」拼出来：它是 `chat-system-prompt.txt` 的证据来源，
          //   与真正发出去的那份**同一个函数**（`buildSystemPrompt`：学段 + 本轮画像快照），不是另写一份。
          state.lastPrompt = buildSystemPrompt(undefined)
          dumpPrompts(paths, state)
          emitTerminal(sink, MISSING_KEY_MESSAGE)
          return { ok: false, status: 'missing-key', detail: `key来源=${credentials.source}` }
        }
        if (!credentialState.authReady) {
          state.lastPrompt = buildSystemPrompt(undefined)
          dumpPrompts(paths, state)
          emitTerminal(sink, `${MISSING_KEY_MESSAGE}（供应商凭证检查未通过）`)
          return { ok: false, status: 'missing-key', detail: 'checkAuth 未通过' }
        }

        const binding = bindTurnStream(
          session,
          gate,
          // ★ `secret` 是**给脱敏用的**（不是给日志用的）：供应商原文里的这一把 Key 会被抹掉
          //   （见 `events.ts` 的 `describeProviderError`）。读 `activeApiKey`（可变）而不是
          //   建会话时的快照 —— 热切换之后要抹的是**当前那把**。
          { requestId: sink.requestId, secret: activeApiKey },
          // 诊断钩子（`K12_PI_TRACE=1`）：**只打事件名与结构性字段**，绝不记录消息正文或凭证
          tracePiEvents ? { onEvent: tracePiEvent } : {}
        )
        try {
          await session.prompt(input.text)
        } catch (error) {
          // ★ 兜异常：Pi 与 UI 同在主进程，抛出会同时带走两者。这里转成 `error` 事件（可读、非堆栈）
          //   ⚠️ 这个异常的正文可能带网关回显的 URL / 请求头 → 必须过脱敏（同 `describeProviderError`）
          const { message, status } = describeTurnException(error, activeApiKey)
          binding.failWith(message)
          dumpPrompts(paths, state)
          return { ok: false, status, detail: message }
        } finally {
          binding.unsubscribe()
        }

        // ★★ 等终审与收尾走完**再返回**。
        //
        // 为什么必须 await：门是在 `bindTurnStream` 的订阅回调里被驱动的（同步），而终审是异步的。
        // 不等它，`runTurn()` 就会在 `blocked` 还没发出去时返回，调用方（`ipc/handlers.ts`）
        // 紧接着 `flushGrades()` + 读学段 —— 而 `blocked` 与 `done` 可能在那之后才到。
        // `settled()` 内部有兜底（没有终态事件也会 resolve），所以这里**不会挂住**。
        await gate.settled()
        // ★ 每轮一条结构性审计行（验收与排查的落点）：证明「生成侧终审」在这条真实回合上
        //   被装配过、跑了几次、撤回过没有。**只有结构字段与计数，绝无正文**（§12）。
        //   `finalizations=0` 的两种正常含义：① 本轮以失败收尾（没有正文要撤）；
        //   ② 本轮还没产生任何正文。都不是故障。
        //   ⚠️ 计数只在这里打日志，**不另存进 state**：以前那份 `state.finalizations/retractions`
        //   没有任何读取方（写了没人看的状态最容易被误当成验收证据），已删。
        console.warn(
          `[safety] 本轮内容安全：输入侧检查=通过 生成侧终审=${gate.finalizations} 次 ` +
            `撤回=${gate.retractions} 次（正文 ${gate.bufferedChars} 字符）`
        )

        dumpPrompts(paths, state)
        const leaks = state.wireLeaks
        if (leaks.length > 0) {
          // 泄漏是**开发期缺陷**，不该让学生看见：记在结论里，UI 只看到正常收尾
          return { ok: false, status: 'provider-error', detail: `system prompt 泄漏：${leaks.join(' / ')}` }
        }
        // 撤回过的轮次：结论如实记（面向开发者），UI 那边看到的是安全文案
        if (gate.retractions > 0) {
          return { ok: false, status: 'blocked', detail: '本轮回答被安全终审撤回' }
        }
        return { ok: true, status: 'ok' }
      } finally {
        busy = false
      }
    },

    /**
     * ★ 等排队的学段证据上交完毕（见 `ChatRuntime.flushGrades` 的接口注释）。
     *
     * `gradeExtension.flush()` 内部已经兜了全部异常（提交失败只记日志、计数），所以这里
     * 不会再抛 —— 调用方在**对话路径**上，不能因为学段队列出问题就把这一轮带崩。
     */
    async flushGrades() {
      await gradeExtension.flush()
    },

    /**
     * ★ 幂等：`before-quit` 与窗口销毁都可能触发（Pi 的 JSONL 必须在进程退出前 flush）。
     *
     * 顺序：① 等学段队列走完（**最后一个 `/api` 调用方**，必须排在 sidecar 停之前）
     *       ② 把学习记录队列也写出去（同样是 `/api` 调用方，见下方注释）
     *       ③ 导出工具调用轨迹（**读内存**）
     *       ④ `session.dispose()` 把 JSONL flush 干净。
     * 每一步都在 try/catch 里：收尾失败不该把退出流程卡住（调用方是 `before-quit`）。
     */
    async dispose() {
      if (disposed) return
      disposed = true
      // 诊断（`K12_PI_TRACE=1`）：退出路径上「有没有真的调到 dispose」必须可观测
      if (tracePiEvents) console.warn('[pi] session.dispose() 已调用（JSONL flush）')
      try {
        // 别把最后一轮的学段证据丢在队列里（`flush()` 自己吞异常，这里再兜一次是防未知）
        await gradeExtension.flush()
      } catch {
        // 学段队列收尾失败不影响退出
      }
      await flushLearningLog()
      exportTrace()
      try {
        session.dispose()
      } catch {
        // dispose 失败不该盖掉退出流程
      }
    }
  }

  /**
   * ★★ 退出前把**学习记录队列**写出去（票 09 的欠账：`learning-log.ts` 的模块头与
   * `flush()` / `stats()` 都承诺「`agent_end` 与退出前都可调」，但退出那条路径**此前不存在**）。
   *
   * 不 flush 的后果：sidecar 短暂不可用期间入队的结构化学习记录（最多 200 条）在退出时被丢，
   * 而这些正是个性化闭环与「重启后数据延续」验收的输入；`stats().dropped` 也没人看，
   * 丢数据是**无声**的。
   *
   * ★ 为什么从 `CORE_EXTENSION_FACTORIES` 取而不是 `import learningLogExtension from …`：
   *   本文件已经 import 了 `extensions/index.ts`，再去**静态 import 那个单例**会新增一条
   *   循环导入边（`index.ts` ↔ `learning-log.ts` 本来就互相 import），而循环导入里谁先求值
   *   取决于**源码里的 import 顺序** —— 顺序一变就是启动期 TDZ 崩溃（`Cannot access
   *   'learningLogExtension' before initialization`）。从注册表里取同一个对象则完全没有这条边：
   *   运行时（不带 `coreFactories` 覆盖）注册的就是这个单例，**取的是「实际注册的那个」**，
   *   语义还更准。
   *
   * ★ 加 `Promise.race` 上限：`flush()` 会逐条 POST，退避最长 30s，不能让它把退出流程拖死
   *   （超时只记一条日志，剩下的记录留在队列里 —— 应用已经要退出了，宁可丢队列也不卡住退出）。
   */
  async function flushLearningLog(): Promise<void> {
    try {
      const extension = CORE_EXTENSION_FACTORIES['learning-log'] as unknown as LearningLogDiagnostics | undefined
      if (!extension || typeof extension.flush !== 'function' || typeof extension.stats !== 'function') {
        // 注册表被换过（测试注入）或缺这个扩展：干净跳过，绝不在退出路径上抛
        return
      }
      const stats = extension.stats()
      if (stats.queued === 0) return
      const flushed = await Promise.race([
        extension.flush(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), LEARNING_LOG_FLUSH_TIMEOUT_MS))
      ])
      const after = extension.stats()
      console.warn(
        `[learning-log] 退出前冲洗队列：${flushed === null ? '超时' : flushed ? '全部写入' : '部分写入（已入队重试）'}` +
          `｜本次写入 ${after.written - stats.written} 条，剩余 ${after.queued} 条，累计丢弃 ${after.dropped} 条`
      )
    } catch (error) {
      // 学习记录是辅助能力：收尾失败绝不能拦住退出（与 `gradeExtension.flush` 同一条纪律）
      console.warn(
        `[learning-log] 退出前冲洗失败（已忽略）：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * 轨迹落盘（票 08：`docs/tool-trace.mmd`）。
   *
   * 落点分两种，都不是「随便写一个地方」：
   *   - **开发态**：仓库根的 `docs/tool-trace.mmd`（`repoRoot`，与 `npm run trace:export` 同一处，
   *     直接进报告与汇报 PPT）；
   *   - **打包态**：仓库不存在，写到本学生的 `pi-agent/logs/tool-trace.mmd`
   *     （`<userData>/students/<id>/…`，与其它诊断证据同处，绝不写到安装目录）。
   * `K12_TRACE_OUT` 可覆盖落点（人工验收时把证据收到指定路径）。
   */
  function exportTrace(): void {
    try {
      const options: TraceExportOptions = {
        // `meta` 必须是完整对象（`generatedAt` / `turns` 由采集器补齐），所以经 `trace.meta()` 取。
        // ★ 用 `activeLlm`（可变）而不是 `credentials`（建会话时的快照）：
        //   热切换过 LLM 配置之后，轨迹里记录的必须是**真正在用**的那一对。
        meta: trace.meta({ model: `${activeLlm.providerId}/${activeLlm.modelId}` })
      }
      const override = process.env.K12_TRACE_OUT
      if (override) options.outPath = override
      else if (app.isPackaged) options.outPath = join(paths.logDir, 'tool-trace.mmd')
      else options.repoRoot = '..'

      const result = exportToolTrace(trace, options)
      console.warn(
        `[agent] 工具调用轨迹已导出：${result.mmdPath}（${result.records} 条记录，学生 ${paths.studentId}）`
      )
    } catch (error) {
      // 轨迹是**证据**不是产品能力：写不进去也不能拦住退出
      console.error('[agent] 工具调用轨迹导出失败：', error)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 发终态（`error` + `done`）：保证 UI 永远从「正在回答」里出来。 */
function emitTerminal(sink: ChatTurnSink, message: string): void {
  sink.emit({ name: 'error', data: { message, degraded: true } })
  sink.emit({ name: 'done', data: { messageId: `pi-message:${sink.requestId}` } })
  sink.finish()
}

/** 离线探针：把 provider 报错换成**说清自己是探针**的文案（避免误读成真实网络故障）。 */
function probeSink(sink: ChatTurnSink): ChatTurnSink {
  return {
    requestId: sink.requestId,
    emit(event) {
      return sink.emit(
        event.name === 'error' ? { ...event, data: { ...event.data, message: PROBE_NOTICE } } : event
      )
    },
    finish: () => sink.finish()
  }
}

/**
 * 密钥脱敏（§12 的第二道）：任何要落盘/外发的文本都先过这里。
 * 本项目从不打印 provider payload，所以这里主要保护**提示词落盘**这条路径。
 *
 * ★ **实现已搬到 `events.ts`**（那里是 `describeProviderError` 的所在地，而脱敏是它的前置），
 *   本文件只**再导出**一次以保持既有调用点不变（`safety-review` 的接线守卫与既有的
 *   `redactSecret(wire, activeApiKey)` 都读这个名字）。
 *
 * ⚠️ 为什么不在这里留着实现、让 `events.ts` 反向 import：`events.ts` **已被本文件 import**
 *   （`bindTurnStream` / `describeProviderError` / `MISSING_KEY_MESSAGE` …）——
 *   反过来再加一条边就是循环导入，谁先求值取决于 import 顺序，顺序一变就是启动期
 *   TDZ 崩溃（本项目对这条纪律有前科，见 `flushLearningLog()` 的注释）。
 *   放在 `events.ts`（纯字符串函数、不依赖任何模块）两边都能用，且**只有一份实现**。
 */
export { redactSecret }

/** 提示词落盘（排查与验收证据）：具体那份 + 网络上那份。**只写 prompt 本身，不含 Key**。 */
function dumpPrompts(paths: StudentPiPaths, state: RuntimeState): void {
  try {
    if (state.lastPrompt) {
      writeFileSync(join(paths.logDir, 'chat-system-prompt.txt'), state.lastPrompt, 'utf8')
    }
    if (state.wirePrompt) {
      writeFileSync(join(paths.logDir, 'chat-system-prompt-wire.txt'), state.wirePrompt, 'utf8')
    }
  } catch {
    // 落盘失败不影响对话（证据缺失而已）
  }
}

/**
 * ★ 工具异常纪律的**唯一实现点**（票 06 建立，票 08 的 6 个 Extension 必须走它）：
 * `execute()` **绝不抛异常**，失败时返回可读错误 + `details.error = true`，
 * 让 `events.ts` 能把它翻成 `error` 事件（degraded）而不炸掉主进程。
 *
 * 为什么不能靠 Pi 兜：Pi 的 Extension 与 UI 同在主进程，一个未捕获异常会同时带走两者。
 */
export function safeToolExecute<TParams, TResult>(
  toolName: string,
  execute: (params: TParams) => Promise<TResult> | TResult
): (params: TParams) => Promise<TResult | SafeToolFailure> {
  return async (params: TParams): Promise<TResult | SafeToolFailure> => {
    try {
      return await execute(params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text', text: `工具执行失败（${toolName}）：${message}` }], details: { error: true, errorMessage: message } }
    }
  }
}

/** `safeToolExecute` 的失败形态（`details.error === true`，`events.ts` 据此发 `error` 事件）。 */
export interface SafeToolFailure {
  content: Array<{ type: 'text'; text: string }>
  details: { error: true; errorMessage: string }
}

/**
 * 诊断 Tool：**必抛异常**的那一个（票 06 的验收要求）。
 *
 * 只有显式设置 `K12_DEBUG_THROW_TOOL=1` 时才注册 —— 它故意抛异常，用来证明：
 *   ① `safeToolExecute` 把异常兜成了可读错误；
 *   ② 工具失败不会带走主进程，UI 收到的是 `error` 事件而不是白屏；
 *   ③ `tool_execution_end` 的失败路径映射正确。
 * 默认关闭，分发包里没有它（同 `K12_DEBUG_PORT` 的处理方式）。
 */
function debugThrowTools(pi: PiModuleLike): unknown[] {
  if (process.env.K12_DEBUG_THROW_TOOL !== '1') return []
  return [
    pi.defineTool({
      name: 'debug_throw',
      label: '诊断：必抛异常的工具',
      description: '诊断用：执行时必然抛异常，用于验证工具失败不会导致主进程崩溃。',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: safeToolExecute('debug_throw', () => {
        throw new Error('诊断工具按设计抛出异常（K12_DEBUG_THROW_TOOL=1）')
      })
    })
  ]
}

/** 供应商错误文案的统一出口（`events.ts` 里实现；这里转发，避免调用方两处 import）。 */
export { describeProviderError }
