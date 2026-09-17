/**
 * ★★ 内容安全**投递层**（票 22 的收口）—— `runtime.ts` 在每一轮里显式驱动它。
 *
 * 执行文档 §12 的链路（本文件是「主进程这一半」）::
 *
 *     学生输入 ──▶ [1] 输入检查（词表 + 越狱意图正则）   ← 命中：立刻发 blocked，**不发起模型调用**
 *                    │ 通过
 *                    ▼
 *               [2] 流式生成（首 token 不被审核拖慢）
 *                    │ 生成结束
 *                    ▼
 *               [3] 整段终审：词表再扫一遍 + LLM 自审（双重过滤）
 *                    │ 命中
 *                    ▼
 *               发 blocked {reason, safeText} —— 渲染进程**撤回该条消息**并替换为安全文本
 *
 * ## 职责边界（本文件**不做判定**）
 *
 * `server/app/safety/guard.py` 是**唯一的判定者**：词表加载、越狱正则、类别优先级、安全文本、
 * 自审 prompt 模板、自审响应解析、二者合并规则，全在 Python 侧。本文件只做三件事：
 *
 *   1. **调用**：把文本交给 sidecar 的 `/api/safety/check`，拿回一个 `SafetyVerdict`；
 *   2. **投递**：判定违规时用 `events.planBlockedEvent()` 构造 `blocked` 事件（唯一构造点）；
 *   3. **协调撤回**：`done` 是终态、`blocked` 不是 —— 所以终审必须先于 `done`。
 *
 * **为什么不在 TS 侧也写一套词表匹配**：两份实现必然漂移，而漂移的表现是
 * 「同一条内容在服务端被拦、在客户端放行」（或反过来）。本项目已经因为「双份口径」
 * 在学段推断上返工过一次（见 `extensions/grade.ts` 文件头），这里不再犯同一个错。
 *
 * ## ★ 一个真实的时序约束：`done` 与 `blocked`
 *
 * 渲染进程的归约器里 `done` / `error` 是**终态**：`turn.status !== 'streaming'` 之后
 * 到达的正文类事件一律丢弃（见 `renderer/src/api/events.ts` 的 `applyChatEvent`）。
 * 而 `blocked` **不是**终态 —— 它是「把已经流出去的那条正文撤回」。
 *
 * 于是「生成结束 → 终审 → 违规则发 blocked」这条链上有一个**必须解决**的时序问题：
 * Pi 在本轮结束时发 `agent_end`，`events.ts` 的 `bindTurnStream` 收到 `done` 就 `finish()`
 * 把本轮登记清掉了 —— 之后我们再去发 `blocked`，会被 registry 当作「已结束的轮次」丢弃，
 * **撤回永远到不了界面**（这正是票 22 之前 `planBlockedEvent` 没有生产调用方的形态）。
 *
 * 解决办法（{@link createSafetyGate}）：把 `done` **扣住**，直到终审跑完再放行：
 *
 *     delta… ──┐                                    ┌─ 通过终审 → 放行 done
 *              ├─▶ 门（缓冲 assistant 文本） ─▶ 终审 ─┤
 *     agent_end┘  （done 被扣住）                     └─ 判定违规 → 发 blocked + 撤掉扣住的 done
 *
 * 门是**纯逻辑**（不碰 HTTP、不碰 electron），所以「违规完成必须被撤回」这件事
 * 可以完全不依赖 API Key 地单测 —— `decideGate()` 就是那条链路的判定内核。
 *
 * ## 降级（§12：审核不可用 ≠ 放行）
 *
 * `guard.final_review()` 的第二道是 LLM 自审，**没有 API Key 时跑不了**。此时：
 *   - **词表那道照常工作**（纯 Python，不依赖任何模型）—— 这是「无 Key 也必须有效」的那一半；
 *   - 自审拿不到响应时**不据此拦截**（`parse_self_review` 返回 `null` → 按「审核不可用」处理），
 *     这是 Python 侧已经定好的口径（宁可漏拦也不误伤），本文件只保证**它真的被执行到**。
 */

import type { TurnEvent } from '../../ipc/chat-stream.ts'
import type { GradeLevel } from '@shared/ipc-events'
import { apiFetch } from '../../bridge/client.ts'
import { planBlockedEvent, type TurnSink } from '../events.ts'

/* ------------------------------------------------------------------ *
 * 契约形状（与 `server/app/safety/route.py` 的 pydantic 出参一一对应）
 * ------------------------------------------------------------------ */

/** 安全检查的阶段：输入侧 / 生成结束后的整段终审。 */
export type SafetyStage = 'input' | 'final'

/**
 * 判定结论（= Python 的 `SafetyVerdict`）。
 *
 * ⚠️ 字段是 **camelCase**（pydantic alias 统一转）；`safeText` 是**面向学生**的替换文案。
 */
export interface SafetyVerdict {
  allowed: boolean
  category: string
  reason: string
  safeText: string
  matched: string[]
  flagged: string[]
  /** `wordlist` / `pattern` / `llm` / `none` —— 命中来自哪一道（证据用）。 */
  source: string
  stage: string
}

/** 判定出口（默认走 `apiFetch`；测试注入假实现，从而**不需要 sidecar**）。 */
export type SafetyChecker = (request: {
  text: string
  stage: SafetyStage
  gradeLevel?: GradeLevel | null
  /** 生成侧终审专用：LLM 自审的原始响应（本文件负责调用模型并取回它）。 */
  selfReviewRaw?: string | null
}) => Promise<SafetyVerdict>

/** 自审 prompt 出口（默认走 `apiFetch`；**prompt 模板在 Python 侧，TS 不另写一份**）。 */
export type SelfReviewPromptBuilder = (request: {
  text: string
  gradeLevel?: GradeLevel | null
}) => Promise<string>

/** 一次 LLM 文本补全（`runtime.ts` 用 Pi 的 `modelRuntime.completeSimple` 接上来）。 */
export type TextCompleter = (request: {
  systemPrompt?: string
  prompt: string
  /** 超时（毫秒）；超时按「审核不可用」处理，**不阻塞本轮收尾**。 */
  timeoutMs: number
}) => Promise<string>

/** header 脱敏出口（默认走 `apiFetch`；Python 的 `redact_provider_headers()` 是唯一实现）。 */
export type HeaderRedactor = (headers: Record<string, string>) => Promise<{
  headers: Record<string, string>
  sensitiveKeys: string[]
}>

/** 安全服务在 sidecar 上的三个端点（**只在这一个地方写路径**）。 */
export const SAFETY_CHECK_PATH = '/api/safety/check'
export const SAFETY_SELF_REVIEW_PROMPT_PATH = '/api/safety/self-review-prompt'
export const SAFETY_REDACT_HEADERS_PATH = '/api/safety/redact-headers'

/**
 * 终审阶段 LLM 自审的超时（毫秒）。
 *
 * 为什么给得比一般请求短：终审发生在**学生已经看到全文之后**，它决定的是「要不要撤回」。
 * 让界面在 `done` 之前干等一个慢模型，会退化成「审核拖慢收尾」——正是票 22 要避免的。
 * 超时就按「自审不可用」收尾（词表那道的结论照旧生效）。
 */
export const SELF_REVIEW_TIMEOUT_MS = 6_000

/** 自审响应在 `blocked.reason` 里的长度上限（`reason` 是**面向开发者/轨迹**的，但要可读）。 */
const MAX_REASON_CHARS = 160

/* ------------------------------------------------------------------ *
 * 默认出口（sidecar HTTP）
 * ------------------------------------------------------------------ */

/** pydantic 出参 → 本文件的形状（**宽松读、严格兜底**：缺字段给出安全默认值，绝不抛）。 */
export function readSafetyVerdict(raw: unknown): SafetyVerdict | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.allowed !== 'boolean') return null
  return {
    allowed: record.allowed,
    category: readText(record.category) ?? 'ok',
    reason: readText(record.reason) ?? '',
    safeText: readText(record.safeText ?? record.safe_text) ?? '',
    matched: readStringArray(record.matched),
    flagged: readStringArray(record.flagged),
    source: readText(record.source) ?? 'none',
    stage: readText(record.stage) ?? 'input'
  }
}

/** 默认判定出口：`POST /api/safety/check`（token 注入由 `bridge/client.ts` 负责）。 */
export const postSafetyCheck: SafetyChecker = async (request) => {
  const response = await apiFetch(SAFETY_CHECK_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: request.text,
      stage: request.stage,
      gradeLevel: request.gradeLevel ?? null,
      selfReviewRaw: request.selfReviewRaw ?? null
    }),
    // 判定在本地回环（毫秒级）；给一个上限免得 sidecar 卡住时把本轮吊死
    signal: AbortSignal.timeout(SELF_REVIEW_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`内容安全检查失败：HTTP ${response.status}`)
  }
  const verdict = readSafetyVerdict(await response.json())
  if (!verdict) throw new Error('内容安全检查失败：后端回执不符合契约（缺 allowed 字段）')
  return verdict
}

/** 默认自审 prompt 出口：`POST /api/safety/self-review-prompt`（模板在 Python 侧）。 */
export const postSelfReviewPrompt: SelfReviewPromptBuilder = async (request) => {
  const response = await apiFetch(SAFETY_SELF_REVIEW_PROMPT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: request.text, gradeLevel: request.gradeLevel ?? null }),
    signal: AbortSignal.timeout(SELF_REVIEW_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`取自审 prompt 失败：HTTP ${response.status}`)
  const raw = (await response.json()) as { prompt?: unknown }
  const prompt = readText(raw.prompt)
  if (!prompt) throw new Error('取自审 prompt 失败：后端回执里没有 prompt')
  return prompt
}

/** 默认 header 脱敏出口：`POST /api/safety/redact-headers`（Python 侧是唯一实现）。 */
export const postHeaderRedaction: HeaderRedactor = async (headers) => {
  const response = await apiFetch(SAFETY_REDACT_HEADERS_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ headers }),
    signal: AbortSignal.timeout(SELF_REVIEW_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`provider 头脱敏失败：HTTP ${response.status}`)
  const raw = (await response.json()) as { headers?: unknown; sensitiveKeys?: unknown }
  if (!raw.headers || typeof raw.headers !== 'object') {
    throw new Error('provider 头脱敏失败：后端回执不符合契约（缺 headers 字段）')
  }
  return {
    headers: readStringMap(raw.headers),
    sensitiveKeys: readStringArray(raw.sensitiveKeys)
  }
}

/* ------------------------------------------------------------------ *
 * ★ 撤回门（纯逻辑：可无 sidecar、无 Key 地单测）
 * ------------------------------------------------------------------ */

/** 门的输入：本轮发生了什么。 */
export interface SafetyGateInput {
  /** 输入侧判定（`null` = 没做，例如 sidecar 不可用）。 */
  inputVerdict: SafetyVerdict | null
  /** 本轮已流出的 assistant 正文（`delta` 累积）。 */
  assistantText: string
  /** 供应商错误文案（非空 = 本轮以失败收尾，`error` 已经发过终态）。 */
  failureMessage?: string | null
}

/** 门的输出：主进程下一步该做什么。 */
export interface SafetyGateDecision {
  /** 发 `blocked`（撤回已流出的正文）；`null` = 无需撤回。 */
  blocked: TurnEvent | null
  /** 是否放行 `done`（`false` 时调用方要在终审完成后自己收尾）。 */
  releaseDone: boolean
  /** 最终正文（`blocked` 时是 `safeText`，供日志/轨迹；**不进 UI**）。 */
  text: string
  /** 终审是否真的跑过（证据：证明 `final_review` 在生产路径上被执行到）。 */
  reviewed: boolean
}

/**
 * 违规 → 撤回决定（**唯一的构造路径**）。
 *
 * `safeText` 由 Python 给（`guard.py` 保证非空：词表缺类时走 `DEFAULT_SAFE_TEXT`），
 * **不在 TS 侧另写一份兜底文案** —— 渲染进程自己还有一层 `FALLBACK_SAFE_TEXT`
 * 兜「主进程给了空串」这种畸形情况。
 */
export function buildBlockedDecision(verdict: SafetyVerdict): SafetyGateDecision {
  return {
    blocked: planBlockedEvent(clipReason(verdict.reason), verdict.safeText),
    releaseDone: false,
    text: verdict.safeText,
    reviewed: true
  }
}

/**
 * 撤回门的判定内核（**纯函数**，`node --test` 直接覆盖）。
 *
 * 三条分支：
 *   1. **输入侧命中**（`inputVerdict.allowed === false`）→ 立刻撤回（本轮没发请求，无正文可撤，
 *      但界面要看到安全文案）；
 *   2. **生成侧命中**（`finalVerdict.allowed === false`）→ 撤回已流出的正文；
 *   3. 都通过 → 放行 `done`。
 *
 * ⚠️ 「撤回」用 `planBlockedEvent()` 构造（`events.ts` 的**唯一**构造点），
 *    确保 `reason` / `safeText` 的形状与契约、前端归约器、`withRequestId()` 三处一致。
 */
export function decideGate(input: SafetyGateInput, finalVerdict: SafetyVerdict | null): SafetyGateDecision {
  // 输入侧命中优先（它更早发生、且本轮根本没发请求）：此时终审的结论没有意义
  const verdict =
    input.inputVerdict?.allowed === false
      ? input.inputVerdict
      : finalVerdict && finalVerdict.allowed === false
        ? finalVerdict
        : null

  if (verdict) return buildBlockedDecision(verdict)
  return {
    blocked: null,
    releaseDone: true,
    text: input.assistantText,
    reviewed: finalVerdict !== null
  }
}

/* ------------------------------------------------------------------ *
 * ★★ 撤回门（sink 包装器）：**扣住 done**，直到终审跑完
 * ------------------------------------------------------------------ */

/**
 * ★★ 为什么必须「扣住 done」——本项目最容易漏掉的一处时序（票 22 返工的根因）。
 *
 * 渲染进程的 `applyChatEvent`（`renderer/src/api/events.ts`）把 `done` / `error` 当**终态**：
 * 轮次状态一旦不是 `streaming`，**后续到达的正文类事件一律丢弃**。而 `blocked` 恰恰是
 * 「撤回已经流出去的那条正文」—— 它必须在轮次还是 `streaming` 时到达。
 *
 * 若按直觉实现（`agent_end` → 发 `done` → 再跑终审 → 违规发 `blocked`），结果是：
 * `blocked` 永远被归约器丢掉，界面显示的是**未撤回的违规正文**，而日志里一切正常。
 * 更糟的是 `bindTurnStream` 在发出 `done` 时就会 `finish()`，registry 会连 `blocked`
 * 都不再往下投 —— 撤回**静默失效**。
 *
 * 所以本包装器把 `done` 扣在手里：
 *
 *     delta… ──┬─▶ 立刻转发（**首 token 延迟不受审核影响**）
 *              └─▶ 同时累积进缓冲区
 *     done   ──▶ 扣住 → await 终审 ─┬─ 通过 → 补发 done（原样）→ finish
 *                                   └─ 违规 → 先发 blocked（归约器此时仍是 streaming，
 *                                            于是原文被撤换成 safeText）→ 再补发 done → finish
 *
 * `done` 在 `blocked` 之后补发是**必要**的：`blocked` 只改 `status`，不带 `messageId`；
 * 且渲染进程对非 streaming 轮次的 `done` 只做「补 messageId」这一件事（不会覆盖撤回结果）。
 * 主进程侧的 `finish()` 也依赖它把本轮登记清掉，否则 composer 会一直停在「回答中…」。
 */
export interface SafetyGateSinkOptions {
  /** 下游句柄（生产是 registry 的 `TurnHandle`；测试注入记录器）。 */
  inner: TurnSink
  /** 终审出口（默认 {@link finalizeTurn}；测试注入 stub，于是**不需要 sidecar 与 Key**）。 */
  finalize?: (text: string) => Promise<FinalizeResult>
  log?: (line: string) => void
}

/**
 * 撤回门（就是一个 `TurnSink`，外加给验收用的计数与等待能力）。
 *
 * ⚠️ 这里**显式重列** `TurnSink` 的两个方法，而不是 `extends TurnSink`：
 *    `TurnSink` 是 `events.ts` 里的一个 interface，本模块只 `import type` 它 ——
 *    重列一次换来的是「这个模块不依赖 events.ts 的运行时」（它只依赖 `planBlockedEvent`，
 *    而那是纯函数）。接口合并的实现在 `createSafetyGateSink()` 的返回对象里一一对应。
 */
export interface SafetyGateSink {
  /** 转发一个事件（`delta` 立刻转发；`done` 被扣住；`error` 立即转发）。 */
  emit(event: TurnEvent): boolean
  /** 请求结束本轮（真正的 `inner.finish()` 要等终审跑完）。 */
  finish(): void
  /** 转发出去的 `delta` 条数（= 首 token 路径没被门挡住的正向证据）。 */
  readonly deltas: number
  /** 真正跑过的终审次数（= `final_review` 在生产路径上被调用的证据）。 */
  readonly finalizations: number
  /** 撤回次数（`blocked` 真发出去了几次）。 */
  readonly retractions: number
  /** 本轮已累计的正文（诊断/轨迹用；**不进 UI、不进日志正文**）。 */
  readonly bufferedChars: number
  /**
   * ★ 等终审与收尾都完成。**必须有兜底**：若本轮一个终态事件都没到（Pi 没有 `agent_end`
   * 就返回了），这里会**合成一条 `done`** 再走终审 —— 否则 `settled()` 永不 resolve，
   * `runTurn()` 挂死，界面永远停在「回答中…」（这是本设计唯一会挂住的位置，所以专门兜住）。
   */
  settled(): Promise<void>
}

export function createSafetyGateSink(options: SafetyGateSinkOptions): SafetyGateSink {
  const inner = options.inner
  const log = options.log ?? ((line: string) => console.warn(line))
  const finalize = options.finalize ?? ((text: string) => finalizeTurn(text, { log }))

  let buffer = ''
  let pendingDone: { name: 'done'; data: { messageId: string } } | null = null
  /** 本轮以失败收尾（`error` 已转发）：没有正文要撤，也不再拖一次终审。 */
  let failed = false
  /** 终审/收尾已经启动（防止 `settled()` 与 `finish()` 各跑一次导致重复 emit）。 */
  let settling = false
  let closed = false
  let deltas = 0
  let finalizations = 0
  let retractions = 0

  let resolveSettled: () => void = () => {}
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })

  const release = (): void => {
    if (closed) return
    closed = true
    resolveSettled()
    // 真正的收尾：把本轮从 registry 里清掉（界面据此离开「回答中…」）
    inner.finish()
  }

  /** 终审 + 收尾（唯一会碰 IO 的地方；自己兜全部异常）。 */
  const runFinalize = async (done: { name: 'done'; data: { messageId: string } }): Promise<void> => {
    finalizations += 1
    let decision: SafetyGateDecision
    try {
      const result = await finalize(buffer)
      decision = result.decision
    } catch (error) {
      // `finalizeTurn` 自己已经兜了异常；这一层防的是**注入实现**抛异常（测试/未来替换）
      log(`[safety] 终审异常（本轮按放行处理）：${error instanceof Error ? error.message : String(error)}`)
      decision = { blocked: null, releaseDone: true, text: buffer, reviewed: false }
    }
    if (closed) return
    if (decision.blocked) {
      // ★ 先撤回、再补 done：顺序错了撤回会被归约器丢掉（见上方注释）
      retractions += 1
      inner.emit(decision.blocked)
      log(`[safety] 本轮回答被安全终审撤回（已替换为安全提示，原文长度 ${buffer.length}）`)
    }
    if (!failed) inner.emit(done)
    release()
  }

  const settle = (): void => {
    if (closed || settling) return
    settling = true
    if (failed) {
      // 失败收尾：`error` 已经转发过了，直接放行 done（若有）并收尾
      if (pendingDone) {
        inner.emit(pendingDone)
        pendingDone = null
      }
      release()
      return
    }
    const done = pendingDone
    pendingDone = null
    if (!done) {
      // 没有终态事件 → 直接收尾（绝不挂住；`settled()` 的注释里说明了为什么）
      release()
      return
    }
    void runFinalize(done)
  }

  return {
    get deltas() {
      return deltas
    },
    get finalizations() {
      return finalizations
    },
    get retractions() {
      return retractions
    },
    get bufferedChars() {
      return buffer.length
    },
    async settled() {
      // ★ 兜底：一个终态事件都没到也要收尾（合成一条 done）——否则这里永不 resolve
      if (!settling && !closed) {
        if (!pendingDone) pendingDone = { name: 'done', data: { messageId: '' } }
        settle()
      }
      await settledPromise
    },

    emit(event: TurnEvent): boolean {
      if (closed) return false
      switch (event.name) {
        case 'delta':
          // ★ 首 token 不被审核拖慢：立刻转发，同时留一份给终审
          buffer += event.data.delta
          deltas += 1
          return inner.emit(event)

        case 'done':
          // ★ 扣住，等终审（见上方注释）
          pendingDone = event
          return true

        case 'error':
          // 失败是终态：立刻转发，并让 finish() 走「不审核」的分支
          failed = true
          return inner.emit(event)

        default:
          // `payload` / `citation` 与安全终审无关，原样透传
          return inner.emit(event)
      }
    },

    finish(): void {
      // `bindTurnStream` 在终态事件后调用它；这里**不立刻**转发给 registry，
      // 否则 `blocked` 会被「轮次已结束」挡掉（撤回无法到达界面）。
      settle()
    }
  }
}

/** 发一条「输入侧就命中」的完整回合（撤回 + 收尾），供 `runtime.ts` 的无请求分支用。 */
export function emitBlockedTurn(inner: TurnSink, verdict: SafetyVerdict, reason?: string): void {
  inner.emit(planBlockedEvent(clipReason(reason ?? verdict.reason), verdict.safeText))
  inner.emit({ name: 'done', data: { messageId: '' } })
  inner.finish()
}


/* ------------------------------------------------------------------ *
 * 终审执行（IO 都在这里）
 * ------------------------------------------------------------------ */

export interface FinalizeOptions {
  /** 判定出口（默认 `postSafetyCheck`）。 */
  check?: SafetyChecker
  /** 自审 prompt 出口（默认 `postSelfReviewPrompt`）。 */
  buildPrompt?: SelfReviewPromptBuilder
  /** LLM 文本补全（**可选**：没有 Key 时为 `null`，此时只跑词表那一半）。 */
  complete?: TextCompleter | null
  gradeLevel?: GradeLevel | null
  /** 诊断出口（默认 `console.warn`）；**只允许结构性字段，绝不记录正文**（§12）。 */
  log?: (line: string) => void
  /** 单次终审的总超时（毫秒）。 */
  timeoutMs?: number
}

/** 一次终审的结论（供日志与轨迹；`blocked` 就是最终事件）。 */
export interface FinalizeResult {
  decision: SafetyGateDecision
  /** `wordlist` / `pattern` / `llm` / `none` / `unavailable`。 */
  source: string
  /** 自审那半是否真的跑过（`false` = 无 Key 或调用失败）。 */
  selfReviewRan: boolean
  /** 终审整体是否可用（sidecar 挂了 → `unavailable`，此时**不据此拦截**）。 */
  available: boolean
}

/**
 * ★★ **生成结束后的整段终审**：跑 `guard.final_review()` 的双重过滤，返回该不该撤回。
 *
 * 三步，任何一步失败都**不影响本轮收尾**（降级而不是挂起）：
 *   1. 向 Python 取自审 prompt（模板在 Python 侧）；
 *   2. 用 Pi 的模型运行时做一次文本补全（无 Key → 跳过）；
 *   3. 把自审原始响应 + 全文交回 Python 的 `final_review()` 合流判定。
 *
 * ⚠️ **词表那一半与有没有 Key 无关**：即便 `complete` 为 `null`、第 1、2 步全跳过，
 *    第 3 步仍会执行（`selfReviewRaw` 传 `null`），Python 侧照常做词表扫描。
 *    这就是「无 Key 世界安全链路仍然有效」的实现方式。
 */
export async function finalizeTurn(text: string, options: FinalizeOptions = {}): Promise<FinalizeResult> {
  const check = options.check ?? postSafetyCheck
  const buildPrompt = options.buildPrompt ?? postSelfReviewPrompt
  const log = options.log ?? ((line: string) => console.warn(line))
  const gradeLevel = options.gradeLevel ?? null

  /** ① LLM 自审（**有 Key 才可能成功**；失败一律按「自审不可用」处理）。 */
  let selfReviewRaw: string | null = null
  let selfReviewRan = false
  if (options.complete && text.trim().length > 0) {
    try {
      const prompt = await buildPrompt({ text, gradeLevel })
      selfReviewRaw = await options.complete({
        prompt,
        timeoutMs: options.timeoutMs ?? SELF_REVIEW_TIMEOUT_MS
      })
      selfReviewRan = true
    } catch (error) {
      // 自审拿不到结果 ≠ 放行：词表那道照旧执行（下面第 ③ 步），这里只记一条降级日志
      log(
        `[safety] LLM 自审不可用（改用词表那一半终审）：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  /** ② ③ 合流：`stage:"final"` 让 Python 先扫词表、再合并自审（顺序由 Python 定，TS 不插手）。 */
  try {
    const verdict = await check({ text, stage: 'final', gradeLevel, selfReviewRaw })
    const decision = decideGate({ inputVerdict: null, assistantText: text }, verdict)
    return { decision, source: verdict.source, selfReviewRan, available: true }
  } catch (error) {
    // 终审服务不可用：**不据此拦截**（`parse_self_review` 的口径同样如此）+ 落一条可查的日志。
    // 原文本照常放行 —— 「宁可漏拦也不误伤」是票 22 明确取舍，且不能因为审核挂掉就卡住收尾。
    log(
      `[safety] 终审不可用（本轮按放行处理，词表检查未生效）：${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return {
      decision: { blocked: null, releaseDone: true, text, reviewed: false },
      source: 'unavailable',
      selfReviewRan,
      available: false
    }
  }
}

/**
 * ★ 输入侧检查（`runtime.ts` 在**发起模型调用之前**调它）。
 *
 * 返回 `null` = 检查服务不可用 → **放行**（不能因为审核挂了就让应用不可用），
 * 但调用方要把 `unavailable` 记进日志（本函数已经记了）。
 */
export async function reviewInput(
  text: string,
  options: {
    check?: SafetyChecker
    gradeLevel?: GradeLevel | null
    log?: (line: string) => void
  } = {}
): Promise<SafetyVerdict | null> {
  const check = options.check ?? postSafetyCheck
  const log = options.log ?? ((line: string) => console.warn(line))
  try {
    return await check({ text, stage: 'input', gradeLevel: options.gradeLevel ?? null })
  } catch (error) {
    log(
      `[safety] 输入侧检查不可用（本轮按放行处理）：${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}

/* ------------------------------------------------------------------ *
 * provider 边界（§12 的第二道脱敏）
 * ------------------------------------------------------------------ */

/** 敏感头的**本地兜底**名单（与 `guard.py` 的 `SENSITIVE_HEADERS` 对齐）。 */
export const FALLBACK_SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'token'
]

/** 覆盖值（与 Python 的 `REDACTED` 一致）。 */
export const REDACTED = '***'

/** 本地兜底脱敏（**只在 sidecar 不可用时用**；出网前的最后一道保险）。 */
export function redactHeadersLocally(
  headers: Record<string, string | null>
): { headers: Record<string, string>; sensitiveKeys: string[] } {
  const out: Record<string, string> = {}
  const sensitiveKeys: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) continue
    if (FALLBACK_SENSITIVE_HEADERS.includes(key.toLowerCase())) {
      out[key] = REDACTED
      sensitiveKeys.push(key)
      continue
    }
    out[key] = value
  }
  return { headers: out, sensitiveKeys }
}

/**
 * ★★ provider 边界脱敏（`before_provider_headers` 的实际动作）。
 *
 * Pi 的这个钩子**原地改 `event.headers`**（返回值被忽略，`null` 表示删除该头）——
 * 见 `dist/core/extensions/types.d.ts` 的 `BeforeProviderHeadersEvent`。
 *
 * 三条纪律：
 *   1. **优先向 Python 要脱敏结果**（`redact_provider_headers()` 是唯一实现，含 `sk-` / `Bearer` 形态）；
 *   2. Python 不可用时退到 {@link redactHeadersLocally}（**出网前必须已经脱敏**，
 *      不能因为 sidecar 挂了就把 Key 原样发出去——虽然发出去的正是 Key 本身，但审计副本必须干净）；
 *   3. **审计副本与被修改的头分开**：真正发出去的请求头**一个字节都不动**
 *      （Python 的 `redact_provider_headers` 注释里写死了「返回新 dict，不改入参」），
 *      我们只记脱敏副本。
 *
 * 返回审计副本与命中的敏感头名（供日志与验收断言）。
 */
export async function auditProviderHeaders(
  headers: Record<string, string | null>,
  options: { redactor?: HeaderRedactor; log?: (line: string) => void } = {}
): Promise<{ headers: Record<string, string>; sensitiveKeys: string[]; source: 'sidecar' | 'fallback' }> {
  const log = options.log ?? ((line: string) => console.warn(line))
  const plain: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') plain[key] = value
  }
  try {
    const redactor = options.redactor ?? postHeaderRedaction
    const result = await redactor(plain)
    return { ...result, source: 'sidecar' }
  } catch (error) {
    log(
      `[safety] provider 头脱敏服务不可用（改用本地兜底名单）：${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return { ...redactHeadersLocally(headers), source: 'fallback' }
  }
}

/* ------------------------------------------------------------------ *
 * 一次 LLM 文本补全（自审 / 第二层判定 / 动画自由生成**共用**这一个原语）
 * ------------------------------------------------------------------ */

/**
 * Pi `ModelRuntime` 上我们用到的那一个方法（结构化子集，**不静态 import Pi**）。
 *
 * 为什么三个用途共用一个原语而不是各写一份：Pi 的 `ExtensionAPI` 面上**没有** completion 能力
 * （只有 `ctx.model` / `ctx.modelRegistry`），所以「发起一次模型调用」这件事在本项目里
 * 只能有**一个**实现点。三处（`grade.ts` 的第二层、本文件的 LLM 自审、`animation.ts`
 * 的自由生成）都从 `runtime.ts` 注入，注入的形状就是这个 `TextCompleter`。
 *
 * ⚠️ **无 Key 时 `completeSimple` 会同步抛错**（Pi 的 `StreamOptions` 文档写死：
 *    "Direct `streamSimple()` calls throw synchronously when request auth is missing"），
 *    所以本原语把异常统一收敛成**可读错误**，让调用方各自走自己的降级分支。
 */
export interface CompleterModelRuntime {
  completeSimple(
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>
  ): Promise<{ content?: unknown; stopReason?: string; errorMessage?: string }>
}

/** 文本补全的可选项（`systemPrompt` 与 `maxTokens` 都是可选）。 */
export interface ModelCompleterOptions {
  /** 本轮不需要工具：一律不传 tools（自审/判学段/生成载荷都是纯文本任务）。 */
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
}

/**
 * 用 Pi 的模型运行时造一个 {@link TextCompleter}（三个用途共用）。
 *
 * 三件事必须做对，否则「无 Key 世界」会出现挂起或崩溃：
 *   1. **超时**（`AbortSignal.timeout`）—— 无 Key 时 `completeSimple` 是同步抛，
 *      但有 Key 而网络不通时它会挂很久；审核/判学段都不该把收尾吊死；
 *   2. **同步抛也兜住**（`try/catch` 包住调用本身，不只是 await）；
 *   3. **把模型原话收敛成可读错误**（`errorMessage` / `stopReason === 'error'`）。
 */
export function createModelCompleter(
  runtime: CompleterModelRuntime,
  model: unknown,
  options: ModelCompleterOptions = {}
): TextCompleter {
  return async (request) => {
    const signal = AbortSignal.timeout(request.timeoutMs)
    let message: { content?: unknown; stopReason?: string; errorMessage?: string }
    try {
      message = await runtime.completeSimple(
        model,
        {
          ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
          messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }]
        },
        {
          signal,
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature })
        }
      )
    } catch (error) {
      // 同步抛（无 Key）与异步 reject 都收敛到这条路径
      throw new Error(readableCompletionError(error))
    }
    if (message.stopReason === 'error') {
      throw new Error(readableCompletionError(message.errorMessage ?? '模型返回了错误'))
    }
    const text = extractCompletionText(message.content)
    if (!text) throw new Error('模型没有返回任何文本')
    return text
  }
}

/** 从 `AssistantMessage.content` 里取第一段非空文本（认不出返回空串）。 */
export function extractCompletionText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as { type?: unknown; text?: unknown }
    if (record.type !== 'text') continue
    if (typeof record.text === 'string' && record.text.trim().length > 0) return record.text
  }
  return ''
}

/** 异常 → 一句话（**不塞堆栈**；它会进日志，所以还要过一层「不含 Key」的纪律）。 */
function readableCompletionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat || '模型调用失败'
}

/* ------------------------------------------------------------------ *
 * 小工具（认不出就当没有）
 * ------------------------------------------------------------------ */

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function readStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/** `reason` 单行化 + 截断（它进 `blocked` 事件，界面侧只在调试面板显示）。 */
function clipReason(reason: string): string {
  const flat = (reason ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return '内容安全终审判定为不适合展示。'
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS)}…` : flat
}
