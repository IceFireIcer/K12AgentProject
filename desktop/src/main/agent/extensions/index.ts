/**
 * 主 Agent 的 **6 个 Extension** 注册表（票 08，执行文档 §9.2）。
 *
 * Pi 的扩展形态（**不要臆造**）：
 *   - 一个扩展 = 导出一个**默认工厂** `(pi: ExtensionAPI) => { pi.on(...); pi.registerTool(...) }`；
 *   - **不存在** `registerExtension`，也**不是**插件清单 —— Pi 的加载器是 jiti（免编译直跑 TS）；
 *   - 工厂由 `DefaultResourceLoader({ extensionFactories: [...] })` 注入（与 `pi-bootstrap.ts`
 *     的 `promptGuard` 同一条路径），**静态 import** 才能被 electron-vite 打进主进程产物。
 *
 * 本文件提供三样东西：
 *   1. **清单**（{@link AGENT_EXTENSION_SPECS}）：六个扩展各自的文件、归属票、注册的 Tool 与订阅的事件；
 *   2. **注册器**（{@link createAgentExtensionRegistry} + {@link registerAgentExtensions}）：
 *      把工厂挂到 Pi 上，并给出「谁没落地 / 谁注册失败 / 11 个冻结 Tool 缺哪几个」的报告；
 *   3. **会话上下文**（{@link bindAgentSession}）：当前学生的身份与轮次上下文。
 *
 * ★ 并行开发说明：`animation.ts` / `coding.ts` / `quiz.ts` / `grade.ts` 由票 14–19 各自落地，
 *   **它们不在本文件的静态 import 列表里** —— 那四个文件一旦被静态 import，未落地时整个主进程
 *   都起不来（连「对话答疑」这条已通的主线都会一起挂）。所以：
 *     - `runtime.ts` 把它们**静态 import 后注入** `createAgentExtensionRegistry({ factories })`；
 *     - 缺哪个，注册器就把它列进 `missing` 并在日志里明确点名（**不静默少能力**）；
 *     - `strict: true`（生产/打包）时缺一个就抛，防止「半套能力」被当成完成品发出去。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GradeLevel } from '@shared/ipc-events'
import { PAYLOAD_TOOL_NAMES } from '../../ipc/tool-kinds.ts'
import learningLogExtension from './learning-log.ts'
import profileExtension from './profile.ts'

/* ------------------------------------------------------------------ *
 * 与 Pi 对接的最小结构面
 * ------------------------------------------------------------------ */

/** Tool 定义（只声明我们用到的字段；`execute` 的入参形状见各扩展）。 */
export interface AgentToolDefinition {
  name: string
  label: string
  description: string
  /** 一行式说明，进默认 system prompt 的「Available tools」小节（Pi 的 `promptSnippet`）。 */
  promptSnippet?: string
  /** 附在默认 system prompt 的 Guidelines 小节（Pi 的 `promptGuidelines`）。 */
  promptGuidelines?: string[]
  /** TypeBox `TSchema`（`@sinclair/typebox` 的 `Type.Object(...)`）。 */
  parameters: unknown
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi 的 execute 有 5 个入参且每个扩展的自有类型不同 */
  execute: (...args: any[]) => unknown
}

/**
 * 扩展能看到的 Pi 能力面（**结构子集**，不是 Pi 的类型）。
 *
 * 为什么不直接 `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'`：
 * 静态 import Pi 会 evaluate 包根的 CLI `main.js`（连带 `esbuild` 原生二进制，风险 #15），
 * 为了一个类型付这个代价不值 —— `pi-bootstrap.ts` 出于同一理由也自己声明了最小面。
 */
export interface AgentExtensionApi {
  on(event: string, handler: (event: unknown, ctx?: unknown) => unknown): void
  registerTool(tool: AgentToolDefinition): void
}

/**
 * 扩展工厂：`(pi) => void`。
 *
 * 参数用 `any` 是有意的：另外四个文件由别的票写，它们的形参类型是 Pi 的 `ExtensionAPI`；
 * 这里做窄化会让「注入」在类型层直接失败（两边的类型不同源）。真正的约束由
 * {@link registerAgentExtensions} 在**运行期**给出（缺文件、抛异常都会被点名）。
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AgentExtensionFactory = (pi: any) => void | Promise<void>

/* ------------------------------------------------------------------ *
 * 当前会话上下文（学生身份由主进程注入，**模型改不了**）
 * ------------------------------------------------------------------ */

/** 一轮对话上下文：谁在问、哪个会话、什么学段。 */
export interface AgentSessionContext {
  /** 学生 id（`student_001` 这类；**经主进程校验后才可能在这里**）。 */
  studentId: string
  /** Pi 的 JSONL 会话 id（写 `learning_history.session_id` 用，关联对话与学习记录）。 */
  sessionId: string
  /** 当前生效学段（**来自服务端推断**（`server/app/grade/rules.py`）的当前生效值，前端不推断学段（手动指定走独立通道、由服务端写库））。 */
  gradeLevel: GradeLevel
}

let activeSession: AgentSessionContext | null = null

/**
 * 绑定当前学生（`runtime.ts` 在**每次建会话/切学生时**调用）。
 *
 * ★ 为什么学生身份要在这里注入、而不是做成 Tool 参数：Tool 参数是模型填的，
 * 一旦 `get_student_profile(student_id=...)` 这种形状存在，模型就有机会读到**别的学生**的画像。
 * 身份必须来自主进程（渲染进程选中的那个学生），模型连表达「读别人」的能力都没有。
 */
export function bindAgentSession(context: AgentSessionContext | null): void {
  if (context === null) {
    activeSession = null
    return
  }
  if (!context.studentId) throw new Error('bindAgentSession: studentId 不能为空')
  if (!context.gradeLevel) {
    throw new Error(
      'bindAgentSession: gradeLevel 不能为空（学段来自服务端推断的当前生效值，前端不推断学段（手动指定走独立通道、由服务端写库））'
    )
  }
  activeSession = { ...context }
}

/** 当前上下文（未绑定返回 `null`；调用方必须自己给可读错误，**不要**猜一个默认学生）。 */
export function currentAgentSession(): AgentSessionContext | null {
  return activeSession ? { ...activeSession } : null
}

/* ------------------------------------------------------------------ *
 * 清单（六扩展 + 十一个冻结 Tool）
 * ------------------------------------------------------------------ */

export type AgentExtensionName = 'animation' | 'coding' | 'quiz' | 'profile' | 'grade' | 'learning-log'

export interface AgentExtensionSpec {
  name: AgentExtensionName
  /** 归属票（并行开发时用来对齐「这个文件谁来写」）。 */
  ticket: string
  /** 模块文件（相对本目录）。 */
  file: string
  /** 该扩展注册的 Tool 名（**字面量冻结**，执行文档 §9.3）。 */
  tools: readonly string[]
  /** 该扩展订阅的 Pi 事件（票 08 只允许这些落点，**不要自建事件总线**）。 */
  events: readonly string[]
  /** 本扩展落地的本地依赖（写进报告与排错信息，避免「为什么这个 Tool 没有」靠猜）。 */
  dependsOn?: readonly string[]
}

/**
 * ★ 六个扩展的清单（执行文档 §9.2 逐条对应）。
 *
 * `file` 是**约定路径**：`runtime.ts` 按它静态 import 并注入；本文件不 import 那四个，
 * 理由见文件头（未落地时不能让主进程起不来）。
 */
export const AGENT_EXTENSION_SPECS: readonly AgentExtensionSpec[] = [
  {
    name: 'animation',
    ticket: '16/17',
    file: './animation.ts',
    // ★ 两个 Tool（2026-09-23 新增第二个）：`generate_animation` 是**模板优先**那条，
    //   `compose_animation` 是「按学生具体要求现场做 + 同一位学生问同一件事就复用」那条。
    //   两者都发 `payload` 事件（kind 都是 `animation`），由同一个扩展注册，
    //   因为它们的产物形状、校验、托管、降级全都共用一套实现（只在选材那一步分叉）。
    tools: ['generate_animation', 'compose_animation'],
    events: ['tool_execution_start', 'tool_execution_end'],
    dependsOn: [
      'Python /resources/animation/<student>/<kp> 一次性 nonce',
      'sandboxed iframe（禁止 allow-same-origin）',
      'Python /api/animation/compose（自由生成合流）与 /api/animation/saved/**（复用与存库）'
    ]
  },
  {
    name: 'coding',
    ticket: '18/19',
    file: './coding.ts',
    // ★ 2026-09-26（D-089）：`generate_code_exercise` 按学生要求现出一道题
    //   （随包模板只有三份，别的情境原来没有东西可给）。
    tools: ['get_code_template', 'get_coding_hint', 'evaluate_code', 'generate_code_exercise'],
    events: ['tool_execution_end'],
    dependsOn: ['渲染进程 Pyodide Worker（学生代码绝不在主进程执行）', 'POST /api/code/run-hint']
  },
  {
    name: 'quiz',
    ticket: '14/15',
    file: './quiz.ts',
    tools: ['generate_quiz', 'submit_quiz', 'generate_variants'],
    events: ['tool_execution_end'],
    dependsOn: ['GET /api/quiz/bank/{kp_id}', 'POST /api/quiz/grade', '掌握度限幅 ±0.2']
  },
  {
    name: 'profile',
    ticket: '08',
    file: './profile.ts',
    tools: ['get_student_profile', 'remember_preference'],
    events: [],
    dependsOn: ['GET /api/profile/{student_id}（Python 侧一人一库）']
  },
  {
    name: 'grade',
    ticket: '21',
    file: './grade.ts',
    tools: [],
    // ★ **空数组是有意的**（2026-09-16 返工）：本扩展**不订阅任何 Pi 事件**。
    //   原设计订阅 `input`（收证据）+ `before_agent_start`（拼 prompt），但实测两条在
    //   「无 API Key」这条主路径上都不会触发（`prompt()` 根本不被调用 / 排在凭证校验之后），
    //   于是学段永远不动。现在由 `runtime.ts` 在每轮开始时**显式调用**
    //   `observeTurn()` / `systemPromptFor()`（见 `grade.ts` 文件头的完整论证）。
    events: [],
    dependsOn: ['四学段 system prompt 模板', 'runtime.ts 显式驱动（observeTurn / systemPromptFor）']
  },
  {
    name: 'learning-log',
    ticket: '09',
    file: './learning-log.ts',
    tools: [],
    // ★ `session_end` **不存在**（Pi 34 个原生事件里没有）：一轮结束用 `agent_end`。
    events: ['tool_execution_end', 'agent_end'],
    dependsOn: ['POST /api/profile/{student_id}/events（写 learning.db，不存对话正文）']
  }
]

/**
 * ★ 十一个冻结 Tool 名（票 08 第二项：**全部**要注册）。
 *
 * 其中 8 个会发 `payload` 事件（映射表在 `ipc/tool-kinds.ts`，**全仓唯一一处**）；
 * `rag_search`（票 13，走 `citation` 事件）、`get_student_profile` 与
 * `remember_preference`（画像：一个只影响 Prompt、一个是写回偏好）**不发** payload。
 *
 * ★ 计数口径：`10` → `11` 是 2026-09-23 加 `compose_animation` 那一次
 *   （票 08 的 9 个 + 票 20 的 `remember_preference` + 这次的按需动画）。
 *   ⚠️ 数字写在这里只是注释 —— **唯一的机器判据**是 `auditToolCoverage()` 与
 *   `scripts/check-tool-schema.mjs`（后者从本常量派生清单完整性），别在两处各记一个数。
 */
export const AGENT_TOOL_NAMES = [
  'generate_animation',
  'compose_animation',
  'get_code_template',
  'generate_code_exercise',
  'get_coding_hint',
  'evaluate_code',
  'generate_quiz',
  'submit_quiz',
  'generate_variants',
  'get_student_profile',
  'remember_preference',
  'rag_search'
] as const

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]

/**
 * 十一个冻结 Tool 里**不属于六个扩展**的那些：`rag_search`（票 13）。
 *
 * 它由 RAG 轨单独注册（检索结果走 `citation` 事件，不发 `payload`），所以不在
 * {@link AGENT_EXTENSION_SPECS} 里；但「全部要注册」是票 08 的验收口径，缺了就少一条能力，
 * 因此这里显式登记，缺它同样会被 {@link auditToolCoverage} 报出来。
 */
export const AGENT_TOOL_NAMES_OUTSIDE_EXTENSIONS = ['rag_search'] as const

/** 六扩展之外的 Tool 模块（同样由 `runtime.ts` 静态 import 后注入 factories）。 */
export const EXTRA_TOOL_MODULES: readonly { tool: string; ticket: string; file: string }[] = [
  { tool: 'rag_search', ticket: '13', file: './rag-search.ts' }
]

/**
 * 一致性自检：清单里声明的 payload 类 Tool 必须与 `ipc/tool-kinds.ts` 的表**逐字相同**。
 *
 * 这里**不复制**那张表（守卫断言它只能有一处定义），只做「覆盖 + 无多余」的比对。
 * 新增 Tool 忘了登记 → 前端收到未知 `kind`；只存在于表里而没人注册 → 模型永远调不到。
 */
export function auditToolCoverage(): { ok: boolean; violations: string[] } {
  const declared = new Set<string>()
  for (const spec of AGENT_EXTENSION_SPECS) for (const tool of spec.tools) declared.add(tool)
  const outside = new Set<string>(AGENT_TOOL_NAMES_OUTSIDE_EXTENSIONS)

  const violations: string[] = []
  for (const tool of PAYLOAD_TOOL_NAMES) {
    if (!declared.has(tool)) violations.push(`payload 类 Tool「${tool}」没有任何扩展声明注册（前端会收到未知 kind）`)
  }
  for (const tool of declared) {
    if (!(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) {
      violations.push(`扩展声明了未登记的 Tool「${tool}」（AGENT_TOOL_NAMES 是冻结词表）`)
    }
  }
  for (const tool of AGENT_TOOL_NAMES) {
    if (declared.has(tool) || outside.has(tool)) continue
    violations.push(`冻结 Tool「${tool}」既没有落到扩展、也没有登记在 AGENT_TOOL_NAMES_OUTSIDE_EXTENSIONS`)
  }
  return { ok: violations.length === 0, violations }
}

/* ------------------------------------------------------------------ *
 * 注册器
 * ------------------------------------------------------------------ */

export interface RegistryOptions {
  /**
   * 由 `runtime.ts` 注入的扩展工厂（`animation` / `coding` / `quiz` / `grade`，可能还含 `rag.ts`）。
   * 键名用 {@link AgentExtensionSpec.name}；缺哪个都不会让主进程起不来，但会被点名。
   */
  factories?: Partial<Record<string, AgentExtensionFactory>>
  /** 本文件自带的核心扩展（`profile` / `learning-log`），测试可替换。 */
  coreFactories?: Partial<Record<string, AgentExtensionFactory>>
  /** 额外扩展（不属于六扩展清单的基础设施，例如轨迹扩展 `trace.ts`）。 */
  extra?: Array<{ name: string; factory: AgentExtensionFactory }>
  /** ★ `true`（生产/打包）：缺任一扩展或任一冻结 Tool 直接抛。 */
  strict?: boolean
  log?: (line: string, level?: 'info' | 'warn' | 'error') => void
}

export interface RegisteredExtensionResult {
  name: string
  ok: boolean
  error?: string
}

export interface RegistryReport {
  ok: boolean
  registered: string[]
  missing: Array<{ name: string; ticket: string; file: string; tools: readonly string[] }>
  failed: RegisteredExtensionResult[]
  /** 缺的 Tool 名（来自未落地的扩展）。 */
  missingTools: string[]
  /** 清单与 `ipc/tool-kinds.ts` 的比对结果。 */
  coverage: { ok: boolean; violations: string[] }
}

/** 默认核心扩展：`profile`（画像读取）与 `learning-log`（学习记录回流）。 */
export const CORE_EXTENSION_FACTORIES: Record<string, AgentExtensionFactory> = {
  profile: profileExtension,
  'learning-log': learningLogExtension
}

/** 建一个注册表（不做任何 Pi 调用，纯装配，可单测）。 */
export function createAgentExtensionRegistry(options: RegistryOptions = {}): {
  factories: Record<string, AgentExtensionFactory>
  extras: Array<{ name: string; factory: AgentExtensionFactory }>
  report(): RegistryReport
} {
  const factories: Record<string, AgentExtensionFactory> = {}
  const missing: RegistryReport['missing'] = []

  for (const spec of AGENT_EXTENSION_SPECS) {
    const factory =
      options.factories?.[spec.name] ?? options.coreFactories?.[spec.name] ?? CORE_EXTENSION_FACTORIES[spec.name]
    if (factory) factories[spec.name] = factory
    else missing.push({ name: spec.name, ticket: spec.ticket, file: spec.file, tools: spec.tools })
  }

  const missingTools = missing.flatMap((entry) => [...entry.tools])
  const report = (): RegistryReport => {
    const coverage = auditToolCoverage()
    return {
      ok: missing.length === 0 && missingTools.length === 0 && coverage.ok,
      registered: Object.keys(factories),
      missing,
      failed: [],
      missingTools,
      coverage
    }
  }

  return { factories, extras: options.extra ?? [], report }
}

/**
 * 把扩展挂到 Pi 上。**失败不抛**（除非 `strict`）：某个扩展的文件有语法错/依赖缺失时，
 * 其余能力必须照常可用 —— 「对话答疑」是主线，不能被动画扩展的 bug 拖走。
 *
 * 每个工厂都在 try/catch 里调用：Pi 的 Extension 与 Agent **同进程**，
 * 工厂里抛出去会同时带走 UI（AGENTS §5.14 的同一条纪律）。
 */
export function registerAgentExtensions(
  pi: AgentExtensionApi,
  options: RegistryOptions = {}
): RegistryReport {
  const log = options.log ?? ((line, level) => (level === 'error' ? console.error(line) : console.warn(line)))
  const registry = createAgentExtensionRegistry(options)
  const report = registry.report()

  for (const entry of report.missing) {
    // 诊断：文件已经落地、但没被注入（`runtime.ts` 忘了 import）与「文件还没写」是两件事，
    // 日志里必须能分开 —— 否则并行开发时两边互相以为对方没做完。
    const onDisk = existsSync(join(import.meta.dirname, entry.file))
    log(
      `[agent] 扩展「${entry.name}」${onDisk ? '文件已在磁盘上，但**没有被注入**（runtime.ts 要静态 import 并传进 factories）' : '尚未落地'}` +
        `（票 ${entry.ticket} → ${entry.file}）：` +
        `${entry.tools.length > 0 ? `该扩展负责的 Tool（${entry.tools.join(', ')}）本轮不可用` : '其能力本轮不可用'}。` +
        `这是**开发期**的正常状态（票 08 允许占位），生产构建必须全部就位。`,
      'warn'
    )
  }
  if (!report.coverage.ok) {
    log(`[agent] Tool 覆盖自检未通过：\n  - ${report.coverage.violations.join('\n  - ')}`, 'warn')
  }

  for (const [name, factory] of Object.entries(registry.factories)) {
    invoke(name, factory)
  }
  for (const extra of registry.extras) {
    invoke(extra.name, extra.factory)
  }

  function invoke(name: string, factory: AgentExtensionFactory): void {
    try {
      const returned = factory(pi)
      // 工厂可以是 async（Pi 的类型允许）：异步分支里的异常不会走上面的 catch，
      // 必须显式挂一个 catch，否则会变成 unhandled rejection 把主进程日志刷花。
      if (returned && typeof (returned as Promise<void>).then === 'function') {
        void (returned as Promise<void>).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          report.failed.push({ name, ok: false, error: message })
          log(`[agent] 扩展「${name}」异步注册失败（其余能力继续）：${message}`, 'error')
        })
      }
      report.registered.push(name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report.failed.push({ name, ok: false, error: message })
      log(`[agent] 扩展「${name}」注册失败（其余能力继续）：${message}`, 'error')
    }
  }

  // 去重（`registered` 既收清单里的也收 extra 的）
  report.registered = [...new Set(report.registered)]
  report.ok = report.missing.length === 0 && report.failed.length === 0 && report.coverage.ok

  if (!report.ok && options.strict) {
    const problems = [
      ...report.missing.map((entry) => `缺扩展 ${entry.name}（票 ${entry.ticket} → ${entry.file}）`),
      ...report.failed.map((entry) => `扩展 ${entry.name} 注册失败：${entry.error}`),
      ...report.coverage.violations
    ]
    throw new Error(`主 Agent 扩展未就位（strict 模式）：\n  - ${problems.join('\n  - ')}`)
  }
  return report
}

/** 一行摘要（启动日志与验收记录都用它，避免两处各写一遍统计口径）。 */
export function describeRegistryReport(report: RegistryReport): string {
  const parts = [
    `已注册 ${report.registered.length} 个扩展（${report.registered.join(', ') || '无'}）`,
    `待落地 ${report.missing.length} 个（${report.missing.map((entry) => entry.name).join(', ') || '无'}）`
  ]
  if (report.failed.length > 0) parts.push(`注册失败 ${report.failed.length} 个`)
  if (report.missingTools.length > 0) parts.push(`缺 Tool：${report.missingTools.join(', ')}`)
  return `主 Agent 扩展：${parts.join('；')}`
}

/* ------------------------------------------------------------------ *
 * 与 sidecar 交互的共享约定
 * ------------------------------------------------------------------ */

/** sidecar 不可用时的**统一可读文案**（Tool 自兜异常时给模型与学生看的那句话）。 */
export const SIDECAR_UNAVAILABLE_TEXT =
  '本地数据服务（sidecar）当前不可用：本次只能凭对话内容作答，请告诉学生稍后再试，不要编造学习记录。'

/**
 * Tool 自兜异常的统一结果形状。
 *
 * ★ **形态与 `runtime.ts` 的 `SafeToolFailure` 一致**（`details.error === true` + `details.errorMessage`）：
 *   `events.ts` 据这两个字段把失败翻成 `error` 事件（`degraded: true`）——
 *   全项目只能有这一种失败形态，别再造第二种（执行文档 §6.5「不引入 ModuleResult」的同一条纪律）。
 *   `degraded` 是额外标注：表示「本轮对话可继续」，供 `error` 事件的 `degraded` 字段使用。
 */
export interface ToolFailureDetails {
  /** `false` = 本次 Tool 没成功（`agent/trace.ts` 的 `toolResultOk()` 认它）。 */
  ok: false
  /** ★ 必须是**布尔 true**：`agent/events.ts` 的 `readToolFailure()` 只认这一种标记。 */
  error: true
  /** 面向事件层的错误正文（`events.ts` 优先取它，再退回 `message`）。 */
  errorMessage: string
  /** 同 `errorMessage`（给轨迹图的写法，两个读取方口径不同，两个字段都要给）。 */
  message: string
  /** `true` = 本轮对话可继续（与 `error` 事件的 `degraded` 语义一致）。 */
  degraded: true
}

/**
 * 组装「可读错误」的 Tool 返回值（**各扩展统一用它，别各写一遍**）。
 *
 * ⚠️ 形状必须与 `quiz.ts` / `rag-search.ts` / `coding.ts` 的失败结果逐字一致
 * （那三处现在**就是** `toolFailure` 的别名，不再各写一份，F11）：
 *   - `events.ts` 的 `readToolFailure()` 只认 `details.error === true`（**布尔**）——
 *     曾把 `error` 写成字符串，结果 `profile.ts` 的失败**永远不发 `error` 事件**（静默成功）；
 *   - `trace.ts` 的 `toolResultOk()` 认 `ok === false` 或 `error === true`，两者都给最稳；
 *   - 两个读取方口径不同：轨迹取 `message`，事件层优先取 `errorMessage` —— 两个字段都要给。
 */
export function toolFailure(text: string, error?: unknown): {
  content: Array<{ type: 'text'; text: string }>
  details: ToolFailureDetails
} {
  const reason = error instanceof Error ? error.message : error === undefined ? '' : String(error)
  const message = reason ? `${text}（${reason}）` : text
  return {
    content: [{ type: 'text', text: `⚠️ ${message}` }],
    details: { ok: false, error: true, errorMessage: message, message, degraded: true }
  }
}

/** 组装成功结果（文本给模型看，`details` 供事件层/轨迹图使用）。 */
export function toolSuccess<T>(
  text: string,
  details: T
): { content: Array<{ type: 'text'; text: string }>; details: T } {
  return { content: [{ type: 'text', text }], details }
}
