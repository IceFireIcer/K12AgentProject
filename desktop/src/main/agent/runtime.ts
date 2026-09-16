/**
 * ★ `runtime.ts` —— **聊天路径唯一的 Agent 会话工厂**（票 06；执行文档 §9.4、§10.1、§10.5、§11.1）。
 *
 * 职责（一条链，缺一不可）：
 *   1. 目录隔离：`ModelRuntime.create({ authPath, modelsPath })` + `DefaultResourceLoader({ agentDir })`
 *      + `SessionManager.create(cwd, sessionDir)` 全部钉在 `<userData>/pi-agent/`，**不读不写 `~/.pi/agent`**。
 *   2. system prompt 两道覆盖：`systemPromptOverride`（资源加载器层）+
 *      `before_agent_start` 每轮整段替换（★ 最后一道改写点，学段语气就落在这里）。
 *   3. 学段：**由推断系统决定**（`agent/extensions/grade.ts` 独占 `before_agent_start` 的学段落点）。
 *      运行时**不读**渲染进程传来的学段 —— `ChatSendRequest.gradeLevel` 只是历史字段，
 *      已不再权威（手动选学段的 UI 已取消，见 `ipc/channels.ts` 的字段注释）。
 *      本文件只保留一个**冷启动兜底学段**（`prompts/grade.ts` 的默认值），保证
 *      `systemPromptOverride` 在任何情况下都不会退化成 Pi 的默认 prompt（那会泄漏宿主路径）。
 *   4. Pi → 6 事件：事件流交给 `events.ts` 的 `bindTurnStream()`，本文件只管会话与生命周期。
 *   5. provider 边界脱敏审计（§12）：`before_provider_request` 里把**真正要发出去的** system prompt
 *      取出、抹掉任何密钥痕迹、并做宿主路径泄漏断言，然后落盘作证据。
 *
 * ★ 与 `pi-bootstrap.ts` 的分工（不要合并、也不要互相抄）：
 *   - `pi-bootstrap.ts`（票 03）是**冒烟**用的最小会话（学段无关的 baseline prompt + echo Tool），
 *     服务「关卡 B₁：Pi 能不能在 Electron 里加载」这条判定；
 *   - 本文件是**产品会话**（学段 prompt + 工具 + 事件流），服务「关卡 B：学生能不能流式对话」。
 *   两者共用 pi-bootstrap 导出的原语（`loadPi` / `resolveCredentials` / `ensureModelsJson` /
 *   `extractWireSystemPrompt` / `findHostPathLeaks`），**不重复实现目录隔离与 Key 解析链**。
 *
 * ★ 无 Key 时的行为（本机现状：`DEEPSEEK_API_KEY` 未设置）：
 *   **不假装、不静默、不挂起** —— 直接发一条可读的 `error`（`degraded: true`）并收尾本轮，
 *   文案明确写「这是配置缺失，不是程序故障」（见 `events.ts` 的 `MISSING_KEY_MESSAGE`）。
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
  type PiNativeEvent,
  type TurnSink
} from './events.ts'
import {
  bindAgentSession,
  describeRegistryReport,
  registerAgentExtensions,
  type AgentExtensionApi
} from './extensions/index.ts'
import quizExtension from './extensions/quiz.ts'
// ★ 学段**推断**扩展（票 21）：它独占 `input`（收集本轮证据）与 `before_agent_start`（按推断出的
//   学段替换整段 prompt），并自兜异常。工厂是「可调用 + `.refresh()/.useJudge()` 诊断入口」的形态。
import gradeExtension from './extensions/grade.ts'
import ragSearchExtension from './extensions/rag-search.ts'
import {
  ensureModelsJson,
  extractWireSystemPrompt,
  findHostPathLeaks,
  loadPi,
  resolveCredentials,
  type PiCredentials
} from './pi-bootstrap.ts'
import {
  assertSessionManagerIsolated,
  ensureStudentPiDirs,
  resolveStudentPiPaths,
  type StudentPiPaths
} from './pi-paths.ts'
import { DEFAULT_GRADE_LEVEL, gradePromptFor, normalizeGradeLevel } from './prompts/grade.ts'
import { createTraceExtension, exportToolTrace, ToolTraceRecorder, type TraceExportOptions } from './trace.ts'

/* ------------------------------------------------------------------ *
 * 选项与返回类型
 * ------------------------------------------------------------------ */

export interface ChatRuntimeOptions {
  /** ★ 必须显式传入（Electron 里是 `app.getPath('userData')`）；**禁止回退 `~/.pi`**。 */
  userDataDir: string
  /**
   * ★ 学生 id（票 09）：会话、`auth.json` / `models.json`、JSONL 全部落
   * `<userData>/students/<id>/pi-agent/`。**未经校验的 id 不许进来**（会被拼进路径）。
   */
  studentId: string
  /** Key 解析链第一档（CLI `--api-key`）；其余档位由 `resolveCredentials` 处理。 */
  apiKey?: string
  modelId?: string
  baseUrl?: string
  /** 会话工作目录（决定 Pi 的项目级资源发现范围）。 */
  cwd?: string
  /**
   * 离线探针（默认关闭；也可用环境变量 `K12_OFFLINE_PROBE=1` 打开）：
   * 无 Key 时用**假 Key + 本机不可达地址**把一轮踢到 provider 边界，从而在无 Key 环境下
   * 也能断言「system prompt 每轮生效且不含宿主路径」。
   * **不发出任何真实请求、不写盘任何凭证**；只用于排查与验收。
   */
  offlineProbe?: boolean
}

export interface ChatTurnInput {
  text: string
}

/** 本轮的结论（供日志与工具调用轨迹用；UI 只认 6 事件）。 */
export interface ChatTurnOutcome {
  ok: boolean
  /** `ok` / `missing-key` / `provider-error` / `busy` / `exception`。 */
  status: 'ok' | 'missing-key' | 'provider-error' | 'busy' | 'exception'
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
  readonly credentials: PiCredentials
  /** 供应商是否具备凭证（`false` = 只能跑到「准备发请求」为止）。 */
  readonly authReady: boolean
  /** 运行时侧的**兜底**学段（冷启动默认值；权威学段由 `extensions/grade.ts` 的推断给出）。 */
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
  setGradeLevel(grade: GradeLevel | string | undefined): GradeLevel
  /** 跑一轮：事件经 `sink` 投递（`sink` 就是 `ChatStreamRegistry` 的 `TurnHandle`）。 */
  runTurn(input: ChatTurnInput, sink: ChatTurnSink): Promise<ChatTurnOutcome>
  /** 关闭会话（`session.dispose()` 会把 JSONL flush 干净）。**幂等**。 */
  dispose(): Promise<void>
}

/** `TurnHandle` 的最小面（多一个 `requestId`：用于兜底生成 `done.messageId`）。 */
export interface ChatTurnSink extends TurnSink {
  readonly requestId: string
}

/** 供应商 / 模型默认值来自 `pi-bootstrap`（单一来源，别在这里再写一份）。 */
const PROBE_API_KEY = 'offline-probe-no-real-key'
const PROBE_BASE_URL = 'http://127.0.0.1:9/v1'
const PROBE_NOTICE =
  '离线探针模式：本轮用假 Key 指向本机不可达地址，**不会发出任何真实请求**，用于验证提示词装配与事件通道。'

/** 并发保护：同一时刻只允许一轮（渲染进程也有 streaming 守卫，这里是第二道）。 */
export const BUSY_MESSAGE = '上一条回答还没说完，请等它结束再发下一条。'

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
  checkAuth(providerId: string): Promise<{ type: 'api_key' | 'oauth' } | undefined>
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>
}

interface PiSessionLike {
  systemPrompt: string
  subscribe(listener: (event: PiNativeEvent) => void): () => void
  prompt(text: string): Promise<void>
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

/** 会话内部的可变状态（用闭包而不是类字段，避免 Pi 对象在类实例上被长期持有）。 */
interface RuntimeState {
  /**
   * 冷启动兜底学段（`prompts/grade.ts` 的默认值）。
   *
   * ★ **不再是「权威学段」**：学段由推断系统决定（`extensions/grade.ts` 在 `before_agent_start`
   *   里替换整段 prompt）。这里只保证「推断扩展没接上时也有一份合法模板」——
   *   `systemPromptOverride` 绝不能返回空，否则会退化成 Pi 的默认 prompt（泄漏宿主安装路径）。
   */
  grade: GradeLevel
  /** `before_agent_start` 看到的基座 prompt（未覆盖时长什么样，证据用）。 */
  basePromptSeen?: string
  lastPrompt?: string
  wirePrompt?: string
  wireLeaks: string[]
  providerRequests: number
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
  ensureModelsJson(paths, options.baseUrl, options.modelId)

  const credentials = resolveCredentials(paths, {
    apiKey: options.apiKey,
    modelId: options.modelId,
    baseUrl: options.baseUrl
  })

  const probeRequested = options.offlineProbe === true || process.env.K12_OFFLINE_PROBE === '1'
  const useProbe = probeRequested && !credentials.apiKey

  const pi = (await loadPi()) as unknown as PiModuleLike
  const state: RuntimeState = { grade: DEFAULT_GRADE_LEVEL, wireLeaks: [], providerRequests: 0 }
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
   * ② ★ prompt 基座（学段兜底）+ provider 边界审计（同一个工厂，注册顺序即执行顺序）。
   *
   * `before_agent_start` 的返回值会写进 `agent.state.systemPrompt`，是 **Pi 拼完 prompt 之后**
   * 的最后一道改写点 —— 也正因如此，它同时承担「抹掉 Pi 追加的 cwd 环境块」和「垫一份合法模板」。
   * **多个扩展的返回值是链式叠加的（后注册者看到前者结果）**，所以：
   *   - 不要在这里返回 `undefined`（那等于放弃覆盖，Pi 的默认 prompt 会带着宿主路径发出去）；
   *   - ★ 学段**推断**的落点是后注册的 `extensions/grade.ts`（它读 `event.systemPrompt`
   *     再整段替换成本轮推断学段的模板）—— 本工厂垫的那份是**兜底**，不是权威值。
   */
  const chatFactory = (extensionApi: PiExtensionLike): void => {
    extensionApi.on('before_agent_start', (event: unknown) => {
      const base = (event as { systemPrompt?: unknown }).systemPrompt
      if (typeof base === 'string') state.basePromptSeen = base
      const prompt = gradePromptFor(state.grade)
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
      const redacted = redactSecret(wire, credentials.apiKey)
      state.wirePrompt = redacted
      state.wireLeaks = findHostPathLeaks(redacted, [options.userDataDir, process.execPath])
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
        // ★ 学段推断（票 21）：注册顺序在 `chatFactory` **之后** —— 它的 `before_agent_start`
        //   读 chatFactory 垫好的模板再整段换成推断出的学段（Pi 的返回值链式叠加）。
        grade: gradeExtension
      },
      extra: [
        { name: 'rag-search', factory: ragSearchExtension },
        { name: 'trace', factory: createTraceExtension(trace) }
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
    // 第一道：不让 Pi 拼默认 prompt（默认那份会列出 readme/docs 的绝对路径）
    systemPromptOverride: () => gradePromptFor(state.grade),
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
  //    `SessionManager.create(cwd, sessionDir)` 的第二个参数一旦漏传，Pi 会静默退回
  //    `~/.pi/agent/sessions/--<cwd>--/`（跨学生混放的合规硬伤），所以这里必须断言而不是相信。
  const sessionManager = pi.SessionManager.create(
    options.cwd ?? paths.root,
    paths.sessionDir
  ) as PiSessionManagerLike
  assertSessionManagerIsolated(sessionManager, paths.sessionDir, `学生 ${paths.studentId} 的会话`)
  const sessionId = sessionManager.getSessionId?.() ?? ''

  /**
   * ★ 把当前学生上下文写进扩展层（`extensions/index.ts` 的 `bindAgentSession`）。
   *
   * 契约是「**每次建会话 / 切学生时都要调用**」：Tool 里的 `currentAgentSession()` 只可能拿到
   * 主进程写进来的这份 —— 学段推断（`grade.ts`）、画像、学习记录都靠它，而学生身份**不是**
   * Tool 参数（模型连表达「读别人」的能力都没有）。建会话时先绑一次，每轮再绑一次刷新会话 id。
   */
  const bindCurrentSession = (): void => {
    bindAgentSession({
      studentId: paths.studentId,
      // 会话 id 每轮重取：Pi 换会话文件（/new、branch）后 `learning_history.session_id` 要跟着变
      sessionId: sessionManager.getSessionId?.() ?? sessionId,
      gradeLevel: state.grade
    })
  }
  bindCurrentSession()

  // ★ 冷启动把服务端已存的学段取回来（`grade.ts` 的 `refresh()`）。
  //   不 await：它要发一次本机 HTTP，绝不能拖慢建会话；`refresh()` 内部自己吞异常，
  //   sidecar 还没起来时只记一条 warn（干净降级 —— 第一轮用默认学段，第二轮回正）。
  void gradeExtension.refresh()

  const model =
    modelRuntime.getModel(credentials.providerId, credentials.modelId) ??
    modelRuntime.getModels(credentials.providerId)[0]
  if (!model) {
    throw new Error(
      `Pi 里找不到模型 ${credentials.providerId}/${credentials.modelId}（models.json 与内置目录都没命中）`
    )
  }

  // Key 只进内存（`setRuntimeApiKey`），**不写 auth.json**（合规：凭证仅本地且不落日志）
  const runtimeKey = credentials.apiKey ?? (useProbe ? PROBE_API_KEY : undefined)
  if (runtimeKey) await modelRuntime.setRuntimeApiKey(credentials.providerId, runtimeKey)
  const effectiveModel = useProbe ? { ...(model as object), baseUrl: PROBE_BASE_URL } : model

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

  const auth = await modelRuntime.checkAuth(credentials.providerId)
  const authReady = auth !== undefined
  let disposed = false
  let busy = false

  return {
    paths,
    studentId: paths.studentId,
    sessionId,
    credentials: useProbe ? { ...credentials, offlineProbe: true, source: 'offline-probe', apiKey: undefined } : credentials,
    authReady,
    get gradeLevel() {
      return state.grade
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

    setGradeLevel(grade) {
      return applyGrade(state, grade)
    },

    async runTurn(input: ChatTurnInput, sink: ChatTurnSink): Promise<ChatTurnOutcome> {
      // ★★ 学段**不在这里改**：客户端的 `gradeLevel` 不再权威（学段由推断系统决定），
      //    本文件只保留 `state.grade` 作为冷启动兜底 —— 显式 `setGradeLevel()` 之外的
      //    任何写入都会把推断结果顶掉（`extensions/grade.ts` 的 `before_agent_start` 才是落点）。

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
        // 无 Key：**不调 prompt()**，直接给可读结论（Pi 在 prompt() 最开头就会因缺凭证抛错，
        // 且那时连 `before_agent_start` 都不会触发 —— 所以在这里前置判定，文案才不会退化成异常）
        if (!credentials.apiKey && !useProbe) {
          emitTerminal(sink, MISSING_KEY_MESSAGE)
          return { ok: false, status: 'missing-key', detail: `key来源=${credentials.source}` }
        }
        if (!authReady) {
          emitTerminal(sink, `${MISSING_KEY_MESSAGE}（供应商凭证检查未通过）`)
          return { ok: false, status: 'missing-key', detail: 'checkAuth 未通过' }
        }

        const binding = bindTurnStream(
          session,
          target,
          { requestId: sink.requestId },
          // 诊断钩子（`K12_PI_TRACE=1`）：**只打事件名与结构性字段**，绝不记录消息正文或凭证
          tracePiEvents ? { onEvent: tracePiEvent } : {}
        )
        try {
          await session.prompt(input.text)
        } catch (error) {
          // ★ 兜异常：Pi 与 UI 同在主进程，抛出会同时带走两者。这里转成 `error` 事件（可读、非堆栈）
          const { message, status } = describeTurnException(error)
          binding.failWith(message)
          dumpPrompts(paths, state)
          return { ok: false, status, detail: message }
        } finally {
          binding.unsubscribe()
        }

        dumpPrompts(paths, state)
        const leaks = state.wireLeaks
        if (leaks.length > 0) {
          // 泄漏是**开发期缺陷**，不该让学生看见：记在结论里，UI 只看到正常收尾
          return { ok: false, status: 'provider-error', detail: `system prompt 泄漏：${leaks.join(' / ')}` }
        }
        return { ok: true, status: 'ok' }
      } finally {
        busy = false
      }
    },

    /**
     * ★ 幂等：`before-quit` 与窗口销毁都可能触发（Pi 的 JSONL 必须在进程退出前 flush）。
     *
     * 顺序：① 导出工具调用轨迹（**读内存**，dispose 之后照样能导，但放在前面语义更清楚）
     *       ② `session.dispose()` 把 JSONL flush 干净。
     * 两者都在 try/catch 里：收尾失败不该把退出流程卡住（调用方是 `before-quit`）。
     */
    async dispose() {
      if (disposed) return
      disposed = true
      // 诊断（`K12_PI_TRACE=1`）：退出路径上「有没有真的调到 dispose」必须可观测
      if (tracePiEvents) console.warn('[pi] session.dispose() 已调用（JSONL flush）')
      exportTrace()
      try {
        session.dispose()
      } catch {
        // dispose 失败不该盖掉退出流程
      }
    }
  }

  /**
   * 轨迹落盘（票 08：`docs/tool-trace.mmd`）。
   *
   * 落点分两种，都不是「随便写一个地方」：
   *   - **开发态**：仓库根的 `docs/tool-trace.mmd`（`repoRoot`，与 `npm run trace:export` 同一处，
   *     直接进报告与答辩 PPT）；
   *   - **打包态**：仓库不存在，写到本学生的 `pi-agent/logs/tool-trace.mmd`
   *     （`<userData>/students/<id>/…`，与其它诊断证据同处，绝不写到安装目录）。
   * `K12_TRACE_OUT` 可覆盖落点（人工验收时把证据收到指定路径）。
   */
  function exportTrace(): void {
    try {
      const options: TraceExportOptions = {
        // `meta` 必须是完整对象（`generatedAt` / `turns` 由采集器补齐），所以经 `trace.meta()` 取
        meta: trace.meta({ model: `${credentials.providerId}/${credentials.modelId}` })
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

/**
 * 学段写入的唯一实现点（`setGradeLevel()` 走它）：非法值落到默认学段（**不推断、不猜测**）。
 *
 * ⚠️ `runTurn()` **不调用它**：学段不再由客户端参数驱动（学段推断见 `extensions/grade.ts`），
 *    每轮重设会让推断结果被渲染进程传来的历史值顶回去。
 */
function applyGrade(state: RuntimeState, grade: GradeLevel | string | undefined): GradeLevel {
  const next = normalizeGradeLevel(grade)
  state.grade = next
  return next
}

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
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 6) return text
  return text.split(secret).join('***')
}

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
