/**
 * 编程 Extension（票 18/19，执行文档 §9.2 第 2 行 / §11.3）：注册
 * `get_code_template` / `get_coding_hint` / `evaluate_code`
 * （三个都在 §9.3 的「Tool 名 → `kind`」映射表里 → `coding`，表在 `ipc/tool-kinds.ts`，**只此一处**）。
 *
 * ---------------------------------------------------------------------------
 * ★★ 头号硬约束：学生代码**绝不**在本文件里执行（执行文档 §12 / AGENTS §5.7）
 * ---------------------------------------------------------------------------
 *
 * 为什么这条约束存在：Pi 的 Extension 与 Agent **同进程**，而 Agent 跑在 Electron **主进程**里，
 * 拥有完整系统权限（能 spawn、能读写任意文件）。学生的代码一旦在这里跑起来，
 * 「沙箱」就没了 —— 动画 iframe、Pyodide Worker、主线程的三重隔离会缺掉最关键的一环。
 *
 * 所以本文件的 `evaluate_code.execute()` **只做三件事**：
 *
 *     ① 把代码经 IPC 交给**渲染进程**（`dispatch`）；
 *     ② 等渲染进程的 **Pyodide Worker** 把运行结果回传（`settle`）；
 *     ③ 拿 stdout/stderr 去 sidecar 换中文反馈与分级提示，组装结果。
 *
 * 它**没有**任何执行代码的路径 —— 没有 `eval` / `new Function` / `vm` / `import('pyodide')`，
 * 这不靠自觉，`desktop/tests/coding-extension.test.ts` 会静态断言（票 18 的守卫）：
 *
 *   - 主进程 `src/main/**` 不得 import `pyodide`；
 *   - 不得出现 `eval(` / `new Function(` / `node:vm`；
 *   - 本文件不得出现任何「执行学生代码」的调用点。
 *
 * ---------------------------------------------------------------------------
 * 运行器（`codeRunner`）是**唯一注入点**
 * ---------------------------------------------------------------------------
 *
 * 主进程 → 渲染进程的 IPC 通道由 `src/main/ipc/**` 接线（本票不碰那些文件）。为了不把
 * 传输细节焊进 Tool 逻辑，这里用**一个** `CodeRunner` 接缝：
 *
 *     type CodeRunner = (request: CodeRunRequest) => Promise<CodeRunOutcome>
 *
 *   - `createCodingExtension({ codeRunner })` —— 测试注入假执行器（不起 Electron 也能测全链路）；
 *   - `bindCodeRunner(runner)` —— `ipc/**` 在注册处理器时**注入一次**（一句话接线）；
 *   - 默认导出 `codingExtension = createCodingExtension()` 供 `runtime.ts` 的 `factories` 使用：
 *     未接线时**如实报「执行服务未接线」**，绝不在主进程兜底执行（那正是要防的事）。
 *
 * 同一个接缝还带一个**可测的桥**（{@link createRendererCodeRunner} + {@link settleCodeRunResult}）：
 * 它负责 requestId 配对、超时、以及「渲染进程崩了/没回话」的可读错误 ——
 * `ipc/**` 只需要「发一条」+「把回信喂给 settle」。
 *
 * ---------------------------------------------------------------------------
 * Ticket 19：从「能跑代码」到「会教」
 * ---------------------------------------------------------------------------
 *
 *   - **报错感知**：把 Worker 回传的 traceback 交给 Python 换中文反馈（报错翻译是 Python 的职责，
 *     见 `server/app/routes/code.py` —— 那里有翻译表，这里不重写第二份）；
 *   - **手动求助**：`get_coding_hint` 按 `level` 1→2→3 递进，**同一 kp 内绝不跳级**；
 *   - **连续失败 N 次主动介入**：`MAX_CONSECUTIVE_FAILURES`（**唯一的具名常量**）
 *     + 本文件内的 `Map`（**不放 State** —— `tool_execution_end` 是只读通知，
 *     驱动不了这件事；执行文档 §6.6 明确要求这类单轮临时态放 Extension 内存 Map 里）。
 *     介入**复用既有对话输出**（Tool 结果文本里给模型一句指令），
 *     **不新增第 7 个事件类型**。
 *
 * ★ `execute()` 自兜异常：Pi 与 UI 同在主进程，抛异常会同时带走两者。
 *   失败一律返回可读中文 + `details.ok=false`（事件层据此发 `error` 事件，见 `agent/events.ts`）。
 */

import { createHash } from 'node:crypto'

import { Type, type Static } from '@sinclair/typebox'
import { apiFetch } from '../../bridge/client.ts'
import type {
  CodeExerciseDraft,
  CodeExerciseRequest
} from '../coding/generator.ts'
import {
  currentAgentSession,
  SIDECAR_UNAVAILABLE_TEXT,
  toolFailure,
  type AgentExtensionApi
} from './index.ts'

/* ------------------------------------------------------------------ *
 * ★ 唯一的具名阈值常量（票 19 明确要求：不许散落字面量）
 * ------------------------------------------------------------------ */

/**
 * ★★ 连续失败几次后，主 Agent **主动介入**（票 19 的硬要求，默认 3）。
 *
 * 为什么是**常量**而不是散落的 `3`：这个数字是产品决策（「学生卡住了」的判定线），
 * 不是实现细节。它出现在三处（计数比较、提示级别、文案），散落就会悄悄漂移
 * ——「提示到 3 级了但介入是 5 次」这种不一致，演示现场很难解释。
 *
 * 改这一个值，计数、介入、文案一起变。
 */
export const MAX_CONSECUTIVE_FAILURES = 3

/** 分级提示的级数上限（契约 `CodingHint.level` 是 `Literal[1, 2, 3]`）。 */
export const MAX_HINT_LEVEL = 3

/** 单次渲染进程执行的超时（毫秒）。与 `server/app/routes/code.py` 的 `CODE_RUN_TIMEOUT_MS` 同值。
 *
 * ⚠️ **这不是保护，只是兜底**：真正的保护在 Worker 里（Pyodide 的 `setInterruptBuffer`
 * 中断死循环，见 `sandbox/pyodide.worker.ts`）。主进程这一层只负责「渲染进程彻底没回话时
 * 不要把这个 Promise 永远挂着」—— 所以留了宽裕的余量（中断本身 5s，加上排队与传输）。
 */
export const CODE_RUN_TIMEOUT_MS = 5_000
/** 主进程等待渲染进程回话的总超时（执行预算 + 传输余量）。 */
export const CODE_RUN_DISPATCH_TIMEOUT_MS = CODE_RUN_TIMEOUT_MS + 4_000
/** 单次调用 sidecar 的超时（本机回环，正常毫秒级）。 */
export const CODING_TIMEOUT_MS = 8_000

/** 发给前端卡片时，载荷里带的 `kind`（与 `ipc/tool-kinds.ts` 的表一致；这里只用于载荷自描述）。 */
export const CODING_PAYLOAD_KIND = 'coding'

/* ------------------------------------------------------------------ *
 * 与契约对应的 TS 形状（`contracts.py` 出参的 camelCase 形态）
 * ------------------------------------------------------------------ */

/** 编程模板（`CodeTemplate`）。★ **没有 `solution`** —— 参照实现永不外发。 */
export interface CodeTemplateShape {
  kpId: string
  language: 'python'
  scaffold: string
  expectedBehavior: string
}

/** 分级提示（`CodingHint`）。 */
export interface CodingHintShape {
  level: 1 | 2 | 3
  hint: string
}

/** 归一化后的错误（`CodeError`）。`message` 是中文解释，`rawTraceback` 是原文留档。 */
export interface CodeErrorShape {
  type: string
  message: string
  rawTraceback: string
  line: number | null
}

/** 代码评估结果（`CodeEvaluation`，§6.5）。 */
export interface CodeEvaluationShape {
  ok: boolean
  stdout: string
  error: CodeErrorShape | null
  feedback: string
  nextHint: CodingHintShape | null
}

/* ------------------------------------------------------------------ *
 * 运行接缝：主进程 → 渲染进程 Worker → 回传
 * ------------------------------------------------------------------ */

/** 交给渲染进程执行的一次请求。 */
export interface CodeRunRequest {
  /** 主进程生成的请求号（与 Pi 的 `toolCallId` 一起用于追踪，票 18 明确要求可追踪）。 */
  requestId: string
  /** Pi 的 Tool 调用号（同一轮里可能有多次执行）。 */
  toolCallId: string
  /** 要执行的源码。 */
  code: string
  language: 'python'
  /** 中断上限（毫秒）。渲染进程据此 `setInterruptBuffer` + 计时。 */
  timeoutMs: number
}

/**
 * 渲染进程 Worker 的回传。**原始结果**，不含任何"友好化"处理 ——
 * 中文反馈由 Python 侧的报错翻译产出（单一实现处，见 `routes/code.py`）。
 */
export interface CodeRunOutcome {
  /** 运行期间捕获的 stdout（原样）。 */
  stdout: string
  /** 原始 traceback（空 = 成功）。 */
  stderr: string
  /**
   * 是否被**超时中断**（`setInterruptBuffer` 写入 SIGINT 后 Pyodide 抛 `KeyboardInterrupt`）。
   * 它是「学生代码停不下来」的正向证据，用于轨迹图与文案（票 18 的头号演示）。
   */
  interrupted: boolean
  /** 从开始执行到结束（或被中断）的毫秒数。 */
  elapsedMs: number
  /** 运行器自身的失败（Worker 未就绪 / 崩溃）——**不是**学生的报错，两者不可混。 */
  failure?: string
}

/** ★ **唯一的执行接缝**：主进程侧调用它 = 请求渲染进程执行（不在本进程执行）。 */
export type CodeRunner = (request: CodeRunRequest) => Promise<CodeRunOutcome>

/* ------------------------------------------------------------------ *
 * 参数 schema（TypeBox `TSchema`；与 pydantic 的一致性由 check-tool-schema 断言）
 * ------------------------------------------------------------------ */

export const GetCodeTemplateParams = Type.Object({
  kpId: Type.String({
    minLength: 1,
    maxLength: 64,
    description: '要取代码模板的知识点 id（例如 prog-loop-jr / prog-variable-jr / prog-list-jr）。★ 只有「编程实践」章（第八章）配有代码模板，可用 id 就是这三个：prog-variable-jr / prog-loop-jr / prog-list-jr；取别的知识点会拿不到模板。'
  }),
  gradeLevel: Type.Optional(
    Type.Union(
      ['primary_low', 'primary_high', 'junior', 'senior'].map((level) => Type.Literal(level)),
      { description: '当前学段（可选；传了会按「只取不高于本学段」检查，不传则不检查）' }
    )
  )
})

/**
 * `generate_code_exercise` 的参数（D-089）。
 *
 * ★ 两个都必填：`kpId` 决定这道题挂在哪个知识点上；`request` 是**学生的那句要求**——
 *   它是「个性化」唯一的来源（原话只进提示词，库里只留指纹，见 `codeRequestHash`）。
 */
export const GenerateCodeExerciseParams = Type.Object({
  // ★ 边界不在这里声明：契约（`GeneratedCodeSaveRequest.kp_id`）是唯一来源，
  //   `check:tool-schema` 逐字段比边界 —— Tool 侧多写一个 minLength 就是一处漂移。
  kpId: Type.String({
    description: '要出题的知识点 id（例如 prog-loop-jr / agent-action-jr）'
  }),
  request: Type.String({
    minLength: 1,
    maxLength: 200,
    description: '学生的那句个性化要求（例如「用外星人送快递来写循环」）'
  })
})
export type GenerateCodeExerciseParamsType = Static<typeof GenerateCodeExerciseParams>

export const GetCodingHintParams = Type.Object({
  kpId: Type.String({
    minLength: 1,
    maxLength: 64,
    description: '学生卡住的知识点 id（决定用哪一套分级提示，也决定失败计数按谁隔离）'
  }),
  /**
   * ★ 生成题专用（D-089）：这道题存在学生库里的 id（`generate_code_exercise` 的回执里给过）。
   *
   * 随包模板按 `kpId` 就能取到提示；**生成题取不到**（它不是随包资产，一题一份存在学生名下），
   * 所以出题时把 `savedId` 一并交给模型，学生点「求助」时带回来 —— 提示才落得到那道题上。
   */
  savedId: Type.Optional(
    Type.String({
      maxLength: 64,
      description: '生成题的 savedId（出题时回执里给过；随包模板的题不要带）'
    })
  ),
  reason: Type.Optional(
    Type.String({
      maxLength: 200,
      description:
        '仅用于你自己的判断（可填报错摘要或学生的原话），不会发送给后端：提示的级别与内容都由服务端按知识点 + 当前级别决定'
    })
  )
})

export const EvaluateCodeParams = Type.Object({
  kpId: Type.String({
    minLength: 1,
    maxLength: 64,
    description: '学生正在做的知识点 id（失败计数与分级提示都按它隔离）'
  }),
  code: Type.String({
    minLength: 1,
    maxLength: 20_000,
    description: '要运行的 Python 代码（通常是学生刚写的版本，或你要检验的答案）'
  }),
  language: Type.Optional(Type.Literal('python', { default: 'python' }))
})

export type GetCodeTemplateParamsType = Static<typeof GetCodeTemplateParams>
export type GetCodingHintParamsType = Static<typeof GetCodingHintParams>
export type EvaluateCodeParamsType = Static<typeof EvaluateCodeParams>

/* ------------------------------------------------------------------ *
 * 注入点
 * ------------------------------------------------------------------ */

/** sidecar 请求出口（默认 {@link apiFetch}；测试注入假实现以覆盖断网/500 分支）。 */
export type CodingRequester = (path: string, init?: RequestInit) => Promise<Response>

export interface CodingExtensionOptions {
  /**
   * ★ 执行接缝。**默认 = 未接线**（如实报错，绝不在主进程兜底执行）。
   * 生产由 `bindCodeRunner()`（`ipc/**` 调用）或这里显式注入。
   */
  codeRunner?: CodeRunner
  /** 请求出口（默认 `apiFetch`）。 */
  request?: CodingRequester
  /** 日志出口（默认 `console.warn`）。 */
  log?: (line: string) => void
  /** 连续失败阈值（默认 {@link MAX_CONSECUTIVE_FAILURES}）——测试用来压缩到 2 次。 */
  maxConsecutiveFailures?: number
  /**
   * ★ 出题接缝（D-089）：**按学生要求现出一题**的实现。
   *
   * 默认不接（`undefined`）= 这条能力不可用 —— 那时 `generate_code_exercise` 会**如实报错**
   * 并让模型改用对话讲，绝不产出「看起来像题、其实是编的」的东西。
   * 生产由 `runtime.ts` 注入 `createCodeExerciseGenerator({ complete })`。
   */
  generate?: (request: CodeExerciseRequest) => Promise<CodeExerciseDraft>
}

/* ------------------------------------------------------------------ *
 * ★ 单轮/单会话临时态：连续失败计数 + 已给到的提示级别（**不进 State**）
 * ------------------------------------------------------------------ *
 *
 * 执行文档 §6.6 明确要求：**重试计数不能放 State 里**。原因是 Pi 的 `tool_execution_end`
 * 是**只读通知**（不能改结果），所以「数到第几次失败」「要不要主动介入」必须由
 * `execute()` 自己维护 —— 状态就落在本文件的 Map 里，与动画 Extension 的
 * `Map<toolCallId, retryCount>` 同一手法。
 *
 * 隔离口径（票 19 的三条要求，逐条对应下面三个函数）：
 *   1. **按学生 + 知识点隔离**：键是 `${studentId}::${kpId}` ——
 *      换到下一个知识点时自然拿到一个新的计数（**不带上一轮的计数**）；
 *   2. **答对后清零**：{@link recordCodingSuccess} 把该键整条删掉（含提示级别）；
 *   3. **提示级别按 kp 记忆**：只有记住"给到过第几级"才能强制**不跳级**。
 *
 * ⚠️ 为什么不是模块级全局 Map 而是工厂闭包里的 Map：每个 `createCodingExtension()`
 *    实例各有各的计数 —— 单测里互不串味，生产也只有一个实例。
 */

/** 一个「学生 + 知识点」上的编程练习状态。 */
export interface CodingSessionState {
  /** 连续失败次数（答对后清零）。 */
  consecutiveFailures: number
  /** 已经给过的**最高**提示级别（0 = 还没给过；决定「不跳级」）。 */
  hintLevel: 0 | 1 | 2 | 3
  /** 最近一次更新时间（诊断用；也是将来做超时回收的抓手）。 */
  updatedAt: number
}

/** 计数表的隔离键：**学生 + 知识点**（一人一份 + 一知识点一份）。 */
function codingStateKey(studentId: string, kpId: string): string {
  return `${studentId}::${kpId}`
}

/**
 * 状态表容量上限（F12）：键是「学生 + 知识点」，一学期下来会攒出几百个键。
 * 到顶就丢最旧的一半（Map 保持插入序），与 `animation.ts` 的 `MAX_TRACKED_CALLS` 同一手法。
 * 单会话内真正在用的键是个位数，上限只是**防长会话无限攒**。
 */
export const MAX_CODING_STATE_ENTRIES = 256

/** 建一份状态表（工厂闭包持有；`clear()` 供测试与「切学生」时清空）。 */
export function createCodingSessionState(): {
  failures: (studentId: string, kpId: string) => number
  /** 含本次在内的「第几次尝试」（在真正执行前读，用于喂 `attempt`）。 */
  previewAttempt: (studentId: string, kpId: string) => number
  hintLevel: (studentId: string, kpId: string) => number
  /** ★ 手动求助的下一级（**不跳级**：最多 = 已给过的最高级 + 1）。 */
  nextHintLevel: (studentId: string, kpId: string) => number
  noteHint: (studentId: string, kpId: string, level: number) => void
  noteFailure: (studentId: string, kpId: string) => CodingSessionState
  noteSuccess: (studentId: string, kpId: string) => CodingSessionState
  snapshot: (studentId: string, kpId: string) => CodingSessionState
  clear: () => void
  /** 当前表里有几条（诊断/单测用，用于断言「有上限」）。 */
  size: () => number
} {
  const table = new Map<string, CodingSessionState>()

  const read = (studentId: string, kpId: string): CodingSessionState =>
    table.get(codingStateKey(studentId, kpId)) ?? {
      consecutiveFailures: 0,
      hintLevel: 0,
      updatedAt: 0
    }

  const write = (studentId: string, kpId: string, next: CodingSessionState): CodingSessionState => {
    const key = codingStateKey(studentId, kpId)
    // ★ 容量上限（F12）：新键且已满 → 丢最旧的一半，绝不无限攒
    if (table.size >= MAX_CODING_STATE_ENTRIES && !table.has(key)) {
      const keys = [...table.keys()].slice(0, MAX_CODING_STATE_ENTRIES / 2)
      for (const stale of keys) table.delete(stale)
    }
    table.set(key, next)
    return next
  }

  return {
    failures: (studentId, kpId) => read(studentId, kpId).consecutiveFailures,
    previewAttempt: (studentId, kpId) => read(studentId, kpId).consecutiveFailures + 1,
    hintLevel: (studentId, kpId) => read(studentId, kpId).hintLevel,

    nextHintLevel: (studentId, kpId) => {
      const current = read(studentId, kpId).hintLevel
      // 0 → 1 → 2 → 3 → 3（到顶就停，不越界、不报错）
      return Math.min(MAX_HINT_LEVEL, Math.max(1, current + 1))
    },

    noteHint: (studentId, kpId, level) => {
      const current = read(studentId, kpId)
      const clamped = Math.max(0, Math.min(MAX_HINT_LEVEL, Math.trunc(level)))
      // 只升不降（同一 kp 内提示级别是单调的；降级会让学生看到"退回"的怪现象）
      write(studentId, kpId, {
        ...current,
        hintLevel: Math.max(current.hintLevel, clamped) as CodingSessionState['hintLevel'],
        updatedAt: Date.now()
      })
    },

    noteFailure: (studentId, kpId) => {
      const current = read(studentId, kpId)
      // 计数本身**无上限**：学生可能失败 7 次才成功，那个数字要在卡片与轨迹图里如实显示
      //（「要不要介入」是调用方拿它与阈值比较，不是计数自己封顶）。
      return write(studentId, kpId, {
        ...current,
        consecutiveFailures: current.consecutiveFailures + 1,
        updatedAt: Date.now()
      })
    },

    noteSuccess: (studentId, kpId) => {
      // ★ 答对后**整条清掉**（失败计数 + 提示级别都归零）：
      //   下一次再做这个 kp 时，提示会重新从 level 1 开始 —— 尊重"你上次做对了"这件事。
      table.delete(codingStateKey(studentId, kpId))
      return { consecutiveFailures: 0, hintLevel: 0, updatedAt: Date.now() }
    },

    snapshot: (studentId, kpId) => ({ ...read(studentId, kpId) }),
    clear: () => table.clear(),
    size: () => table.size
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 失败结果的统一形状：**就是 {@link toolFailure}**（F11）。
 *
 * 以前这里另有一份逐字同构的私有 `failed()`：四份拷贝一旦有一份漂移，
 * 事件层（`agent/events.ts` 只认 `details.error === true`）与轨迹（`agent/trace.ts`
 * 认 `details.ok === false`）就会各认一半，失败会**静默变成成功**。
 * 别名只是为了少改调用点，语义一字不变。
 */
const failed = toolFailure

/** 成功结果：`details` 就是事件层的 `payload`（`events.ts` 会把 details 展开成 payload）。 */
function ok<TDetails extends object>(
  text: string,
  details: TDetails
): { content: Array<{ type: 'text'; text: string }>; details: TDetails } {
  return { content: [{ type: 'text', text }], details }
}

/** 读一小段响应体用于报错（**截断**）。 */
async function readSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return ''
  }
}

/**
 * 载荷自描述字段（`events.ts` 的 `readPayload` 会再补 `tool` 与 `kind`；
 * 这里先带上 `kind` 让**单测**与轨迹图不必依赖事件层就能认出载荷种类）。
 */
function asCodingPayload<T extends object>(details: T): T & { kind: typeof CODING_PAYLOAD_KIND } {
  return { ...details, kind: CODING_PAYLOAD_KIND }
}

/* ------------------------------------------------------------------ *
 * 渲染进程执行桥（可测：`dispatch` 可注入）
 * ------------------------------------------------------------------ */

/** 把一条执行请求交给渲染进程（由 `ipc/**` 实现为 `webContents.send`）。 */
export type CodeRunDispatcher = (request: CodeRunRequest) => void

/** 桥的失败原因（全部是「运行器」层面的问题，**不是**学生的报错）。 */
export const RUNNER_UNWIRED_TEXT =
  '代码执行服务还没有接线：学生代码只能在渲染进程的 Pyodide Worker 里运行，' +
  '主进程不执行任何学生代码（安全约束）。请告诉学生稍后再试，或先讲解思路。'
export const RUNNER_TIMEOUT_TEXT = '代码执行服务没有在预期时间内回话（渲染进程可能已崩溃或卡住）。'
export const RUNNER_UNAVAILABLE_TEXT = '代码执行服务当前不可用。'

interface PendingRun {
  resolve: (outcome: CodeRunOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 建一个「经渲染进程执行」的运行器（★ 桥，不含任何执行逻辑）。
 *
 * 职责边界（这样 `ipc/**` 只需两行接线）：
 *   - 生成 `requestId` → 登记 pending → `dispatch(request)` 把请求推给渲染进程；
 *   - 渲染进程把 Worker 的原始结果经 IPC 回传，由 {@link settleCodeRunResult} 兑现；
 *   - 超时/未知 requestId/重复回信一律**收敛成可读结果**，不抛异常。
 *
 * 带 `maxPending` 上限：渲染进程若整体崩掉，不会在这里堆无穷多个 pending Promise。
 */
export function createRendererCodeRunner(options: {
  dispatch: CodeRunDispatcher
  timeoutMs?: number
  log?: (line: string) => void
  maxPending?: number
  /** 生成请求号（测试注入确定性实现）。 */
  nextRequestId?: () => string
}): { runner: CodeRunner; settle: (payload: unknown) => boolean; pendingCount: () => number } {
  const timeoutMs = options.timeoutMs ?? CODE_RUN_DISPATCH_TIMEOUT_MS
  const log = options.log ?? ((line: string) => console.warn(line))
  const maxPending = options.maxPending ?? 8
  let sequence = 0
  const nextRequestId = options.nextRequestId ?? (() => `coderun-${++sequence}`)
  const pending = new Map<string, PendingRun>()

  const runner: CodeRunner = (request) =>
    new Promise<CodeRunOutcome>((resolve) => {
      if (pending.size >= maxPending) {
        // 渲染进程整体没响应：不要继续堆积（每个都是一条永挂的 Promise）
        log(`[coding] 待回话的执行请求已达上限（${maxPending}），本次直接失败`)
        resolve({
          stdout: '',
          stderr: '',
          interrupted: false,
          elapsedMs: 0,
          failure: RUNNER_TIMEOUT_TEXT
        })
        return
      }
      // 请求号**由桥生成**（覆盖调用方传进来的占位值），保证配对唯一
      const requestId = nextRequestId()
      const timer = setTimeout(() => {
        pending.delete(requestId)
        log(`[coding] 执行请求 ${requestId} 超时（${timeoutMs}ms）未回话`)
        resolve({
          stdout: '',
          stderr: '',
          interrupted: false,
          elapsedMs: timeoutMs,
          failure: RUNNER_TIMEOUT_TEXT
        })
      }, timeoutMs)
      pending.set(requestId, { resolve, timer })
      try {
        options.dispatch({ ...request, requestId })
      } catch (error) {
        // 推不出去（窗口已销毁）—— 立刻失败，不要等超时
        clearTimeout(timer)
        pending.delete(requestId)
        const reason = error instanceof Error ? error.message : String(error)
        log(`[coding] 执行请求 ${requestId} 推送失败：${reason}`)
        resolve({ stdout: '', stderr: '', interrupted: false, elapsedMs: 0, failure: RUNNER_UNAVAILABLE_TEXT })
      }
    })

  /** 把渲染进程的回信喂进来（`ipc/**` 的处理器调用）。返回是否成功配对。 */
  function settle(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false
    const record = payload as Record<string, unknown>
    const requestId = readNonEmptyString(record.requestId)
    if (requestId === null) return false
    const entry = pending.get(requestId)
    if (!entry) {
      // 超时后回信 = 正常竞态（那条请求已经被判失败）：记日志，不当错误
      log(`[coding] 收到未知/已过期的执行回信：${requestId}`)
      return false
    }
    pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve({
      stdout: typeof record.stdout === 'string' ? record.stdout : '',
      stderr: typeof record.stderr === 'string' ? record.stderr : '',
      interrupted: record.interrupted === true,
      elapsedMs:
        typeof record.elapsedMs === 'number' && Number.isFinite(record.elapsedMs)
          ? Math.max(0, record.elapsedMs)
          : 0,
      failure: readNonEmptyString(record.failure) ?? undefined
    })
    return true
  }

  return { runner, settle, pendingCount: () => pending.size }
}

/* ------------------------------------------------------------------ *
 * 默认运行器（模块级单点注入）
 * ------------------------------------------------------------------ */

/**
 * ★ **唯一的运行器注入点**（`ipc/**` 注册处理器时调用一次）。
 *
 * 为什么不直接在 `coding.ts` 里 import electron 自己发 IPC：
 *   ① 那样本文件就绑死在 Electron 上，`node --test` 里没法直接单测 Tool 逻辑；
 *   ② 传输是「谁接线」的问题，不是「怎么讲代码」的问题 —— 混在一起后，
 *      换传输（比如加一层队列）就得改 Tool 逻辑。
 *
 * 传 `null` 可以解绑（测试与热重载用）。
 */
let boundRunner: CodeRunner | null = null

/** 出题重试上限（含首次共 3 次）：与动画自由生成同一条口径 —— 两次还不够就说明不适合硬塞。 */
const MAX_CODE_EXERCISE_ATTEMPTS = 2

/**
 * 出题请求的**指纹**（十六进制摘要）：学生原话不进库（与动画库同一条合规口径）。
 *
 * 键里带 `kpId`：同一个要求在不同知识点上就是两道不同的题，不该互相复用。
 */
export function codeRequestHash(kpId: string, request: string): string {
  const normalised = `${kpId}\n${request}`.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  return createHash('sha1').update(normalised, 'utf8').digest('hex')
}

/** 出题回执 → 给模型的一句话（说清下一步，不要让它把脚手架念一遍）。 */
export function renderExerciseText(template: CodeTemplateShape, savedId: string): string {
  const todoCount = (template.scaffold.match(/TODO/g) ?? []).length
  return (
    `已经按学生的要求现出了一道「${template.kpId}」的 Python 练习题（${todoCount} 处 TODO），` +
    '会以**编程卡片**的形式显示在对话里 —— 学生可以直接在卡片上改代码、点运行。' +
    '**不要**把脚手架念一遍；用一两句话说明这次要做什么、以及完成的标准：' +
    `「${template.expectedBehavior}」` +
    `。这道题已经存进他自己的题里（savedId=${savedId}）：他点「求助」时，` +
    `调 \`get_coding_hint\` 要带上这个 savedId。`
  )
}

export function bindCodeRunner(runner: CodeRunner | null): void {
  boundRunner = runner
}

/** 当前是否已有运行器（诊断用；不暴露运行器本身）。 */
export function isCodeRunnerBound(): boolean {
  return boundRunner !== null
}

/**
 * 默认运行器：**未接线时如实失败**。
 *
 * ★ 这里**刻意不做任何兜底执行** —— 没有「退化成主进程跑一下」的分支。
 *   那种「优雅降级」正好会击穿本票要守的边界：一旦存在这条路径，
 *   生产上某个装配失误就会静默地让学生在**宿主进程**里执行代码，而没人会注意到。
 *   宁可这一轮能力受限（走 `error` 事件，学生看到一句可读提示），也不越线。
 */
const unboundRunner: CodeRunner = async () => ({
  stdout: '',
  stderr: '',
  interrupted: false,
  elapsedMs: 0,
  failure: RUNNER_UNWIRED_TEXT
})

/** 解析出生效的运行器（显式注入 > 模块级绑定 > 未接线兜底）。**导出供测试断言"未接线"行为**。 */
export function resolveCodeRunner(explicit?: CodeRunner): CodeRunner {
  return explicit ?? boundRunner ?? unboundRunner
}

/* ------------------------------------------------------------------ *
 * 给模型看的文本（卡片已经是可视化的，文本只做"交接"）
 * ------------------------------------------------------------------ */

/** 模板 → 给模型的一句话（**不要把脚手架念一遍**，那会刷屏）。 */
export function renderTemplateText(template: CodeTemplateShape): string {
  const todoCount = (template.scaffold.match(/TODO/g) ?? []).length
  return (
    `已经取到「${template.kpId}」的 Python 代码模板（含 ${todoCount} 处 TODO），` +
    '会以**编程卡片**的形式显示在对话里 —— 学生可以直接在卡片上改代码、点运行。' +
    '**不要**把脚手架代码念一遍。请用一两句话说明这次要做什么、以及完成的标准：' +
    `「${template.expectedBehavior}」`
  )
}

/** 提示 → 给模型的一句话（**不许**让模型把提示重复一遍，更不许让它补充答案）。 */
export function renderHintText(hint: CodingHintShape, kpId: string): string {
  return (
    `已经给出「${kpId}」的**第 ${hint.level} 级**提示，会显示在编程卡片上。` +
    '请用一句话鼓励学生按提示再试一次，' +
    '**不要**把提示原文重复一遍，**更不要**直接给出正确代码 —— 提示的目的是引导，不是代做。'
  )
}

/**
 * 评估结果 → 给模型的一句话。
 *
 * ★ **主动介入就在这里落地**（票 19 的「连续失败 N 次」）：不新增事件类型、
 *   不另开一条消息通道 —— 只是在 Tool 结果文本里给模型一句明确的指令，
 *   模型照常经既有的对话输出（`delta` 事件）讲出来。
 */
export function renderEvaluationText(
  evaluation: CodeEvaluationShape,
  context: { kpId: string; consecutiveFailures: number; shouldIntervene: boolean }
): string {
  const parts: string[] = []
  if (evaluation.ok) {
    parts.push(
      `学生在「${context.kpId}」上的代码**运行成功**了（输出已显示在编程卡片上，不要复述输出）。` +
        '请肯定他，并引导他对照卡片上的「预期效果」自查一遍——跑通不等于做对。'
    )
    return parts.join('\n')
  }

  parts.push(
    `学生在「${context.kpId}」上的代码**运行失败**：${evaluation.error?.type ?? '运行时错误'}` +
      `（第 ${context.consecutiveFailures} 次连续失败）。` +
      '中文反馈已经生成并显示在卡片上了（**不要**把反馈原文重复一遍，也不要把原始 traceback 念出来）。'
  )

  if (context.shouldIntervene) {
    // ★ 主动介入：给模型一条**明确的行动指令**，语气也要给（别让它只会说"再试试"）
    parts.push(
      `★★ 学生已经连续失败 ${context.consecutiveFailures} 次了，**请你主动介入**（不要等学生再问）：\n` +
        '  1. 先用一句话承认他卡住了（「这个错误确实容易踩」，不要说教）；\n' +
        '  2. 指出**他这次的具体错误**在讲什么（卡片上已有中文反馈，你据此展开一两句即可）；\n' +
        `  3. 主动提出下一步：把范围缩小到一个最小的问题（例如「先把这一行单独 print 出来看看」），` +
        '或者请他读一遍卡片上的提示。\n' +
        '  ⚠️ 仍然**不要直接给正确代码** —— 让他自己迈过这一步。'
    )
  } else {
    parts.push('请简短地把他的思路引回正轨（一两句话），**不要直接给正确代码**。')
  }
  return parts.join('\n')
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

/**
 * 建一个编程 Extension 工厂（测试与 `ipc/**` 用它注入运行器/请求出口）。
 */
export function createCodingExtension(
  options: CodingExtensionOptions = {}
): (pi: AgentExtensionApi) => void {
  const request: CodingRequester = options.request ?? apiFetch
  const log = options.log ?? ((line: string) => console.warn(line))
  const maxFailures = Math.max(1, Math.trunc(options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES))
  const explicitRunner = options.codeRunner
  // ★ 单轮临时态落在这里（**不进 State** —— `tool_execution_end` 是只读通知，见文件头）
  const state = createCodingSessionState()

  /**
   * 上一次见到的学生（F12：切学生时把状态表整张清掉）。
   *
   * 键里虽然已经带了 `studentId`（跨学生本来就不会串），但「上一个学生的失败计数与
   * 已给到的提示级别」对新学生毫无价值 —— 留着只会在长会话里白占内存。
   * **判据就是每次 `execute` 开头的 `currentAgentSession()`**：本文件不订阅任何全局事件
   * （见文件头「不自建事件总线」那条纪律），所以边界识别放在工具入口。
   */
  let trackedStudentId = ''

  /** 换学生 → 清空临时态（同一学生会话内不动它）。 */
  function noteStudentBoundary(studentId: string | undefined): void {
    const next = studentId ?? ''
    if (next === trackedStudentId) return
    state.clear()
    trackedStudentId = next
  }

  /** 一次带超时的 sidecar 请求（超时/网络异常由调用方收敛成可读错误）。 */
  async function call(path: string, init?: RequestInit): Promise<Response> {
    return await request(path, { ...init, signal: AbortSignal.timeout(CODING_TIMEOUT_MS) })
  }

  /**
   * ★ 先跑代码（在渲染进程），再把结果交给 Python 做**报错翻译 + 分级提示**。
   *
   * 这个顺序是刻意的：执行与"教学判断"分离 ——
   *   - 执行只可能在渲染进程（安全边界）；
   *   - 报错翻译是纯文本规则，放在 Python（单一实现处，`routes/code.py`）。
   *
   * 返回的 `evaluation` 里已经含中文 `feedback` 与 `nextHint`（若失败）。
   */
  async function runAndEvaluate(input: {
    kpId: string
    code: string
    studentId: string
    toolCallId: string
    attempt: number
  }): Promise<
    | { ok: true; outcome: CodeRunOutcome; evaluation: CodeEvaluationShape }
    | { ok: false; message: string; outcome?: CodeRunOutcome }
  > {
    const runner = resolveCodeRunner(explicitRunner)
    // ★ 运行器自身抛异常也必须在这里收敛（`execute()` 自兜异常）：
    //   Pi 的 Extension 与 Agent 同进程，异常冒出去会同时带走 UI（AGENTS §5.14）。
    //   注意这是**外部**故障（Worker 崩溃 / 桥实现有 bug），与"学生代码报错"是两回事。
    let outcome: CodeRunOutcome
    try {
      outcome = await runner({
        // requestId 由桥覆盖（这里给一个占位，便于直接注入的假运行器也能看到字段）
        requestId: `${input.toolCallId}:pending`,
        toolCallId: input.toolCallId,
        code: input.code,
        language: 'python',
        timeoutMs: CODE_RUN_TIMEOUT_MS
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `${RUNNER_UNAVAILABLE_TEXT}（${reason}）` }
    }

    // 运行器自身的故障（Worker 没过 / 窗口销毁 / 超时）—— **不是**学生的报错
    if (outcome.failure) {
      return { ok: false, message: outcome.failure, outcome }
    }

    // 到这里才有"学生代码的运行结果"：交给 Python 翻译
    try {
      const response = await call('/api/code/run-hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ⚠️ 只发契约里**有**的字段：`CodeRunRequest` 是 `extra="forbid"`，
        //    多带一个 `sessionId` 会直接 422（这是防「临时加松散字段」的硬闸门）。
        //    `attempt` 已经承载了「同一知识点第几次」的语义，够服务端定提示级别。
        body: JSON.stringify({
          studentId: input.studentId,
          kpId: input.kpId,
          code: input.code,
          language: 'python',
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          attempt: input.attempt
        })
      })
      if (!response.ok) {
        const snippet = await readSnippet(response)
        return {
          ok: false,
          message: `评估失败：本地服务返回 HTTP ${response.status}${snippet ? `（${snippet}）` : ''}。`,
          outcome
        }
      }
      const evaluation = normalizeEvaluation(await response.json())
      if (evaluation === null) {
        return { ok: false, message: '评估失败：本地服务回执不符合契约（缺 ok/stdout/feedback）。', outcome }
      }
      return { ok: true, outcome, evaluation }
    } catch (error) {
      return { ok: false, message: SIDECAR_UNAVAILABLE_TEXT, outcome }
    }
  }

  return function codingExtension(pi: AgentExtensionApi): void {
    /* ---------------------------------------------------------- *
     * 1. get_code_template —— 按知识点取脚手架（本地文件，断网可用）
     * ---------------------------------------------------------- */
    pi.registerTool({
      name: 'get_code_template',
      label: '取代码模板',
      description:
        '按知识点取一份预置的 Python 代码模板（含 TODO 标记的脚手架），以编程卡片显示给学生。' +
        '卡片里学生可以直接改代码并运行。学生要动手练、或某个知识点适合"写两行试试"时调用。' +
        '模板来自本地文件（断网也能用），不经过模型生成。',
      promptSnippet: 'get_code_template：取知识点的代码脚手架（编程卡片）',
      promptGuidelines: [
        '取模板前先确认知识点 id（从画像或 rag_search 的结果里取），不要编造 id。',
        '取到模板后不要念脚手架代码，让学生自己在卡片上改；用一两句话说明完成标准。',
        '模板里的 TODO 是给学生填的：不要替他填，也不要贴出完整答案。'
      ],
      parameters: GetCodeTemplateParams,
      execute: async (_toolCallId: string, params: GetCodeTemplateParamsType) => {
        const session = currentAgentSession()
        // ★ 换学生就在入口清掉临时态（F12；本文件不订阅全局事件，边界在工具入口识别）
        noteStudentBoundary(session?.studentId)
        const kpId = readNonEmptyString(params?.kpId)
        if (kpId === null) {
          return failed('取代码模板需要知识点 id（例如 prog-loop-jr）。请先确认要练哪个知识点。')
        }

        const query = new URLSearchParams()
        // ★ 学段**以会话为准**（会话里那个值是**服务端推断**（`server/app/grade/rules.py`）
        //   出来的当前生效值，前端不推断学段（手动指定走独立通道、由服务端写库），模型也说了不算）。
        //   带上它 = 让服务端按「只取不高于本学段」检查（服务端把这条做成显式开关，
        //   见 routes/code.py 的 template_grade_ok）。会话没有学段时不带 = 不过滤。
        if (session?.gradeLevel) query.set('gradeLevel', session.gradeLevel)
        const path = `/api/code/templates/${encodeURIComponent(kpId)}${query.size > 0 ? `?${query}` : ''}`

        try {
          const response = await call(path, { method: 'GET' })
          if (!response.ok) {
            const snippet = await readSnippet(response)
            if (response.status === 404) {
              return failed(
                `本地还没有「${kpId}」这个知识点的代码模板${snippet ? `（${snippet}）` : ''}。` +
                  '请换一个知识点，或先用对话把概念讲清楚再让学生动手。'
              )
            }
            return failed(
              `取代码模板失败：本地服务返回 HTTP ${response.status}${snippet ? `（${snippet}）` : ''}。`,
              SIDECAR_UNAVAILABLE_TEXT
            )
          }
          const template = normalizeTemplate(await response.json())
          if (template === null) {
            return failed(
              '取代码模板失败：回执不符合契约（缺 kpId/scaffold/expectedBehavior），卡片无法渲染。'
            )
          }
          return ok(renderTemplateText(template), asCodingPayload({ ...template }))
        } catch (error) {
          return failed('取代码模板失败（本地服务不可用）。', error)
        }
      }
    })

    /* ---------------------------------------------------------- *
     * 2. get_coding_hint —— 手动求助，分级 1→2→3（不跳级、不给答案）
     * ---------------------------------------------------------- */
    pi.registerTool({
      name: 'get_coding_hint',
      label: '给一点提示',
      description:
        '学生卡住时给一条**分级提示**（第 1 级只指方向、第 2 级给结构性提示、第 3 级才贴近骨架），' +
        '以编程卡片的形式显示。同一知识点内**逐级加深、不会跳级**。' +
        '学生说「不会做」「提示一下」「帮帮我」，或连续失败需要引导时调用。' +
        '★ 提示的目的是引导，**绝不直接给正确代码**。',
      promptSnippet: 'get_coding_hint：分级提示（1 指方向 / 2 结构 / 3 骨架）',
      promptGuidelines: [
        '提示的级别由系统按学生的失败次数与已给过的级别决定，你**不要**在对话里补充更具体的做法。',
        '给完提示让学生自己试，不要顺手把答案写出来——那会让学生跳过思考。'
      ],
      parameters: GetCodingHintParams,
      execute: async (_toolCallId: string, params: GetCodingHintParamsType) => {
        const session = currentAgentSession()
        // ★ 换学生就在入口清掉临时态（F12）；**必须在读「已给到的级别」之前**
        noteStudentBoundary(session?.studentId)
        if (!session) {
          return failed(
            '还没有绑定当前学生，无法按他的进度给提示。请先直接回应学生，用对话引导他。'
          )
        }
        const kpId = readNonEmptyString(params?.kpId)
        if (kpId === null) {
          return failed('给提示需要知识点 id（决定用哪一套分级提示）。')
        }
        // ★ 生成题按 `savedId` 取（它不在随包目录里）；随包模板仍按 `kpId` 取（见 D-089）
        const savedId = readNonEmptyString(params?.savedId)

        // ★ 「不跳级」在这里强制执行：级别由**已给过的最高级 +1** 决定，
        //   而不是让模型填一个 level —— 模型一旦能填，就会出现"直接要 3 级"绕开引导。
        const nextLevel = state.nextHintLevel(session.studentId, kpId)
        const path = savedId
          ? `/api/code/generated/${encodeURIComponent(session.studentId)}/${encodeURIComponent(
              savedId
            )}/hint?level=${nextLevel}`
          : `/api/code/hint/${encodeURIComponent(kpId)}?level=${nextLevel}`

        try {
          const response = await call(path, { method: 'GET' })
          if (!response.ok) {
            const snippet = await readSnippet(response)
            if (response.status === 404) {
              // 没有模板 → 没有分级提示：退回「用对话引导」，这是**能力受限**而不是崩溃
              return failed(
                `这个知识点还没有分级提示${snippet ? `（${snippet}）` : ''}。` +
                  '请改用对话引导：先问学生卡在哪一步，再给一句方向性的提示。'
              )
            }
            return failed(
              `取提示失败：本地服务返回 HTTP ${response.status}${snippet ? `（${snippet}）` : ''}。`,
              SIDECAR_UNAVAILABLE_TEXT
            )
          }
          const hint = normalizeHint(await response.json())
          if (hint === null) {
            return failed('取提示失败：回执不符合契约（缺 level/hint）。')
          }
          state.noteHint(session.studentId, kpId, hint.level)
          // `kpId` 是给卡片做归属用的（前端要把提示挂到对应知识点的卡片上）；
          // 契约字段 level/hint 逐字保留。
          return ok(
            renderHintText(hint, kpId),
            asCodingPayload({ kpId, level: hint.level, hint: hint.hint })
          )
        } catch (error) {
          return failed('取提示失败（本地服务不可用）。', error)
        }
      }
    })

    /* ---------------------------------------------------------- *
     * 2.5 generate_code_exercise —— 按学生要求**现出一道题**（D-089）
     *
     * 为什么需要它：随包模板只有三份（`prog-variable-jr` / `prog-loop-jr` / `prog-list-jr`），
     * 学生说「想用外星人送快递来练循环」时那条路没有东西可给。这条路把「学生的要求」变成
     * 一道**真的能做的题**：模型出结构化草稿 → Python 二次校验（缺 TODO / 提示不是三级 /
     * 第 1 级带代码…一律 422）→ 存进**该学生名下** → 以编程卡片显示。
     *
     * ★★ 三条边界：
     *   ① `solution` 只进库、绝不进卡片载荷（与题库的 `answer` 同一条纪律）；
     *   ② 校验不过**不硬塞**：带原因重试 ≤2，仍不过就如实失败（让模型改用对话讲）；
     *   ③ 学生原话（`request`）只进提示词与指纹，库里不存原话。
     * ---------------------------------------------------------- */
    pi.registerTool({
      name: 'generate_code_exercise',
      label: '出一道写代码的题',
      description:
        '★★ 出一道**让学生自己动手写代码**的编程练习题（Python，含 TODO 脚手架、能在编程卡片上' +
        '直接改代码并点运行），并存在他自己的题里。' +
        '**与 `generate_quiz` 的分工（选错就出成另一张卡片）**：' +
        '`generate_quiz` 出的是**选择题/填空题**（口头作答）；本工具出的是**写代码的题**' +
        '（有代码区、要点运行）。学生说「出几道题/练习一下/考考我」→ 用 `generate_quiz`；' +
        '学生说「**写代码**的题 / 动手写的题 / 上机题 / 用代码实现的题」→ 用本工具。' +
        '★ 随包模板只有三份（prog-variable-jr / prog-loop-jr / prog-list-jr）：想要别的情境、' +
        '或想练的知识点本来没有模板时用本工具；已经用 `get_code_template` 取到模板就不要重复出题。',
      promptSnippet: 'generate_code_exercise：出一道**写代码**的练习题（有 TODO 脚手架与运行按钮）',
      promptGuidelines: [
        '`request` 用学生自己的说法（他要的那个情境），不要改写成技术描述。',
        '它出的是**写代码**的题，不是选择题 —— 学生要的是「练选择题」时改用 `generate_quiz`。',
        '出好后用一两句话说明「这次要做什么」与「做对了会怎样」，**不要**把脚手架念一遍、更不要给答案。',
        '学生点「求助」时，调 `get_coding_hint` 要带上这道题的 `savedId`（回执里给过）。'
      ],
      parameters: GenerateCodeExerciseParams,
      execute: async (_toolCallId: string, params: GenerateCodeExerciseParamsType) => {
        const session = currentAgentSession()
        noteStudentBoundary(session?.studentId)
        if (!session?.studentId) {
          return failed(
            '还没有绑定当前学生，没法把这道题存进他的题里。请先用对话把这件事讲清楚。'
          )
        }
        const kpId = readNonEmptyString(params?.kpId)
        const request = readNonEmptyString(params?.request)
        if (kpId === null || request === null) {
          return failed('出题需要知识点 id 与学生的那句要求（两个都要）。')
        }
        const generate = options.generate
        if (!generate) {
          return failed(
            '按学生要求出题这条能力在这台电脑上不可用（没有可用的模型）。' +
              '请改用对话把这件事讲清楚，或先给他取一份随包模板。'
          )
        }

        const gradeLevel = readNonEmptyString(session.gradeLevel) ?? 'primary_high'
        const promptHash = codeRequestHash(kpId, request)
        let previousReason: string | undefined

        // 校验不过就带原因重试（≤2 次），与动画那条自由生成同一条口径
        for (let attempt = 0; attempt <= MAX_CODE_EXERCISE_ATTEMPTS; attempt += 1) {
          let draft: CodeExerciseDraft
          try {
            draft = await generate({ kpId, gradeLevel, request, attempt, previousReason })
          } catch (error) {
            // ★ 模型那条路的失败也**要重试**（实测：它偶尔会把多行脚手架写成字符串里的真实换行
            //   —— 那不是合法 JSON，重来一次基本就好了）。只有「无 Key」这种硬失败才立刻返回。
            const reason = error instanceof Error ? error.message : String(error)
            if (attempt < MAX_CODE_EXERCISE_ATTEMPTS && !reason.includes('没有配置 API Key')) {
              previousReason = `上一次的返回不是可用的题目 JSON（${reason.slice(0, 80)}）`
              log(`[coding] 出题失败（第 ${attempt + 1} 次）：${reason.slice(0, 120)}`)
              continue
            }
            return failed('这次没能出成题（模型那条路不通）。请改用对话讲清楚这个知识点。', error)
          }

          try {
            const response = await call(
              `/api/code/generated/${encodeURIComponent(session.studentId)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  kpId,
                  gradeLevel,
                  title: draft.title,
                  expectedBehavior: draft.expectedBehavior,
                  scaffold: draft.scaffold,
                  expectedOutput: draft.expectedOutput,
                  hints: draft.hints,
                  solution: draft.solution,
                  promptHash
                })
              }
            )
            if (response.ok) {
              const saved = (await response.json()) as Record<string, unknown>
              const savedId = readNonEmptyString(saved.savedId)
              if (savedId === null) {
                return failed('这道题存是存下了，但回执里没有 id（卡片没法找回提示）。')
              }
              const template = normalizeTemplate(saved)
              if (template === null) {
                return failed('出题回执不符合契约（缺 kpId/scaffold/expectedBehavior）。')
              }
              log(
                `[coding] 已出题并存进学生库：知识点=${kpId} id=${savedId}（第 ${attempt + 1} 次尝试）`
              )
              return ok(
                renderExerciseText(template, savedId),
                asCodingPayload({
                  ...template,
                  savedId,
                  title: typeof saved.title === 'string' ? saved.title : draft.title,
                  expectedOutput: draft.expectedOutput
                })
              )
            }

            const snippet = await readSnippet(response)
            if (response.status === 422) {
              // ★ 服务端说清「哪里不合格」——把它带进下一次尝试，而不是原样重试
              previousReason = snippet || '不合题意'
              log(`[coding] 出题被拒（第 ${attempt + 1} 次）：${previousReason}`)
              continue
            }
            return failed(
              `出题失败：本地服务返回 HTTP ${response.status}${snippet ? `（${snippet}）` : ''}。`,
              SIDECAR_UNAVAILABLE_TEXT
            )
          } catch (error) {
            return failed('出题失败（本地服务不可用）。', error)
          }
        }

        return failed(
          `这道题试了几次都没法用${previousReason ? `（${previousReason}）` : ''}。` +
            '请改用对话把知识点讲清楚，别硬塞一道不合格的题给学生。'
        )
      }
    })

    /* ---------------------------------------------------------- *
     * 3. evaluate_code —— ★ 经 IPC 请求渲染进程执行 → 回传 → 组装
     * ---------------------------------------------------------- */
    pi.registerTool({
      name: 'evaluate_code',
      label: '运行学生代码',
      description:
        '运行学生写的 Python 代码（在浏览器的安全沙箱里执行，**不会**接触本机文件与学习数据），' +
        '返回运行输出、中文的错误解释与下一步提示。学生说「帮我看看」「运行一下」时调用。' +
        '★ 不要凭代码内容猜对错：对错的依据是真实运行结果。',
      promptSnippet: 'evaluate_code：运行学生代码并给出中文反馈（沙箱内执行）',
      promptGuidelines: [
        '运行结果与中文反馈会显示在编程卡片上，你只需做简短的引导，不要把输出或反馈念一遍。',
        '学生连续失败时系统会提示你主动介入——这时要主动给方向，但仍然不要给完整正确代码。'
      ],
      parameters: EvaluateCodeParams,
      execute: async (toolCallId: string, params: EvaluateCodeParamsType) => {
        const session = currentAgentSession()
        // ★ 换学生就在入口清掉临时态（F12）；**必须在读 attempt 之前**
        noteStudentBoundary(session?.studentId)
        if (!session) {
          return failed('还没有绑定当前学生，无法记录这次练习（学习记录要记到具体学生名下）。')
        }
        const kpId = readNonEmptyString(params?.kpId)
        if (kpId === null) {
          return failed('运行代码需要知识点 id（决定失败计数与提示按谁隔离）。')
        }
        const code = typeof params?.code === 'string' ? params.code : ''
        if (code.trim().length === 0) {
          return failed('没有收到要运行的代码。请先让学生把代码写在编程卡片里，或把代码贴给你。')
        }

        // 本次是「该知识点上的第几次尝试」——由**本 Extension 的状态表**给出（见文件头的隔离口径）
        const attempt = state.previewAttempt(session.studentId, kpId)

        const result = await runAndEvaluate({
          kpId,
          code,
          studentId: session.studentId,
          toolCallId,
          attempt
        })

        if (!result.ok) {
          return failed(result.message)
        }

        const { evaluation, outcome } = result
        // ★ 计数更新只在这里做（`tool_execution_end` 是只读通知，驱动不了计数）
        const snapshot = evaluation.ok
          ? state.noteSuccess(session.studentId, kpId)
          : state.noteFailure(session.studentId, kpId)

        // ★★ F7：**服务端随失败一起给的 `nextHint` 也要写回「已给到的级别」**。
        //   服务端按 `attempt`（= 连续失败次数 + 1）定级，不施加「最多 +1」护栏；
        //   所以连续失败 3 次后自动提示已经到了 level 3。若这里不记，
        //   学生随后点「求助」时 `nextHintLevel = 已给过最高级 + 1` 会算出 **1** ——
        //   给出**更低**一级的提示，与「只升不降」（见 `noteHint`）的设计口径正相反。
        if (!evaluation.ok && evaluation.nextHint) {
          state.noteHint(session.studentId, kpId, evaluation.nextHint.level)
        }

        const shouldIntervene = !evaluation.ok && snapshot.consecutiveFailures >= maxFailures

        // 计数与介入的**服务端日志**（面向排查：汇报时「连续失败 3 次」这条要能拿出证据）
        log(
          `[coding] ${session.studentId} 在 ${kpId} 上第 ${attempt} 次尝试：` +
            `${evaluation.ok ? '成功（计数已清零）' : `失败（连续 ${snapshot.consecutiveFailures} 次）`}` +
            `${outcome.interrupted ? '（被超时中断）' : ''}` +
            `${shouldIntervene ? ' → 已指示模型主动介入' : ''}`
        )

        return ok(
          renderEvaluationText(evaluation, {
            kpId,
            consecutiveFailures: snapshot.consecutiveFailures,
            shouldIntervene
          }),
          asCodingPayload({
            kpId,
            ...evaluation,
            /**
             * ★★ 「学生代码跑通没有」与「这次工具调用成功没有」是**两个**问题，
             *    绝不能共用一个 `ok` 字段（这里曾经就是共用的，代价如下）。
             *
             * `evaluation.ok` 是前者。它被原样铺进 `details` 之后，`details.ok` 的含义
             * 就从「工具级成败」变成了「学生的代码对不对」—— 而工具调用轨迹
             * （`agent/trace.ts` 的 `toolResultOk()`）正是靠 `details.ok === false` 判失败的，
             * 于是**学生在编程卡片里写错一行代码（工具本身完全正常）**会在轨迹图上被画成
             * `fail` 节点、标签写 `error`。轨迹图是报告「设计合理性 25%」的**核心证据**，
             * 它必须在最常见的教学路径上如实 —— 而「跑代码 → 学生第一次没跑通」正是那条路径。
             *
             * 现在的三个字段各司其职（**读之前先看清自己读的是哪一个**）：
             *   - `codeOk` —— 学生代码跑通没有（**显式命名**，卡片与轨迹都该读它）；
             *   - `toolOk` —— ★ **工具级**：这次 `evaluate_code` 调用本身成功了。失败的形态
             *                 走 `failed()`（= `toolFailure()`，`details.error === true`），
             *                 根本到不了这里；两个字段同时存在，正是为了不让读取方去猜；
             *   - `ok`     —— 与 `codeOk` **同值**，是渲染进程卡片（`renderer/src/cards/coding.ts`
             *                 的 `readCodingCard`）当前读的那个字段。它保留在这里是**兼容**：
             *                 那个文件不在本次改动范围内，改名要连它一起改（见下方的 TODO）。
             *
             * ⚠️ TODO（跨文件，需要与渲染进程一起改）：把渲染进程的 `readCodingCard` 改成读
             *    `codeOk` 之后，本载荷里的 `ok` 应当**删掉**（它不该继续以「工具级字段」的名字
             *    承载领域值），届时 `toolOk` 也可以直接并回 `ok`。在那之前保留同值别名，
             *    是为了不让「载荷改名」变成「卡片显示不出来」。
             */
            codeOk: evaluation.ok,
            toolOk: true,
            // ↓ 下面这些是**给卡片与轨迹图的补充字段**（契约字段原样保留在上面）
            consecutiveFailures: snapshot.consecutiveFailures,
            shouldIntervene,
            interrupted: outcome.interrupted || (evaluation.error?.type === 'KeyboardInterrupt'),
            elapsedMs: outcome.elapsedMs,
            code
          })
        )
      }
    })
  }
}

/* ------------------------------------------------------------------ *
 * 回执归一化（形状不对就返回 null，由调用方给可读错误 —— 不猜、不硬塞）
 * ------------------------------------------------------------------ */

function normalizeTemplate(raw: unknown): CodeTemplateShape | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const kpId = readNonEmptyString(record.kpId)
  const scaffold = typeof record.scaffold === 'string' ? record.scaffold : null
  const expectedBehavior = readNonEmptyString(record.expectedBehavior)
  if (kpId === null || scaffold === null || expectedBehavior === null) return null
  return { kpId, language: 'python', scaffold, expectedBehavior }
}

function normalizeHint(raw: unknown): CodingHintShape | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const level = record.level
  const hint = readNonEmptyString(record.hint)
  if (hint === null) return null
  if (level !== 1 && level !== 2 && level !== 3) return null
  return { level, hint }
}

/** 评估回执归一化：`ok`/`stdout`/`feedback` 缺一不可（缺了就说明契约漂移了）。 */
function normalizeEvaluation(raw: unknown): CodeEvaluationShape | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return null
  if (typeof record.stdout !== 'string') return null
  if (typeof record.feedback !== 'string') return null

  const errorRaw = record.error
  let error: CodeErrorShape | null = null
  if (errorRaw && typeof errorRaw === 'object') {
    const item = errorRaw as Record<string, unknown>
    const type = readNonEmptyString(item.type)
    const message = typeof item.message === 'string' ? item.message : null
    if (type !== null && message !== null) {
      error = {
        type,
        message,
        rawTraceback: typeof item.rawTraceback === 'string' ? item.rawTraceback : '',
        line: typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : null
      }
    }
  }

  return {
    ok: record.ok,
    stdout: record.stdout,
    error,
    feedback: record.feedback,
    nextHint: normalizeHint(record.nextHint)
  }
}

/* ------------------------------------------------------------------ *
 * 默认工厂（`runtime.ts` 直接注入它；生产由 `ipc/**` 调 `bindCodeRunner`）
 * ------------------------------------------------------------------ */

export default createCodingExtension()
