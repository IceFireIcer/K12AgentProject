/**
 * ★★ **假数据源**（票 05 建立）★★ —— **票 06 起已不再接入实时对话路径**。
 *
 * 现状（票 06 之后）：
 *   - 实时对话走 `agent/runtime.ts`（真实 Pi 会话）+ `agent/events.ts`（Pi → 6 事件），
 *     `ipc/handlers.ts` 已不再调用本文件的 `runStubTurn`；
 *   - 本文件**保留**，因为它是「通道本身」的可单测样本：`tests/ipc-events.test.ts` 用它
 *     断言 6 事件、请求号贯穿、中文按码点切分、kind 分派这些**与数据源无关**的契约。
 *   - **绝不**在实时路径里回退到它：那等于给学生一个假回答（票 06 的纪律）。
 *
 * 它不假装自己是模型，而是把**通道本身**跑通，并把「我不是真的」写在回答里：
 *   - 一段中文按 **1 字 1 个 `delta`** 发出 —— 中文跨段不乱码的自证方式（`Array.from` 按码点切，
 *     代理对不会被劈成两半）；
 *   - `citation` / `payload`（三种 `kind`）/ `blocked` / `error` 都有**确定性的触发词**，
 *     UI 的每条分支都能被手工或 `scripts/verify-ui.mjs` 复现；
 *   - 明确命名为 stub，并在回答文案里带上标记，**不静默伪装成真回答**。
 *
 * 纯函数：`planStubTurn()` 只产出事件序列（可观、可单测），
 * `runStubTurn()` 只负责按延时投递（调度器可注入，便于单测不等待）。
 */

import type { Citation, PayloadKind } from '@shared/ipc-events'
import type { TurnEvent, TurnHandle } from './chat-stream.ts'
import { kindForTool } from './tool-kinds.ts'

/**
 * 触发「安全撤回」链条的输入关键词（演示用）。
 * 真实的内容安全终审在票 22；这里只用来让 UI 的 `blocked` 分支可复现。
 */
export const BLOCKED_KEYWORD = 'blocked'

/** 触发「降级提示」链条的输入关键词（演示用）。 */
export const ERROR_KEYWORD = 'error'

/** 假数据源在回答里必须出现的自我声明。 */
export const STUB_MARKER = '假数据源'

export type StubScenario = 'chat' | 'blocked' | 'error'

/** 回答里最多原样回显多少字（防止粘贴超长文本把流拖很久）。 */
const MAX_ECHO_CHARS = 60

/** 每个 `delta` 之间的间隔与其余事件的间隔（毫秒）。 */
export const STUB_DELTA_INTERVAL_MS = 10
export const STUB_EVENT_INTERVAL_MS = 45

/** 会发 `payload` 的三个 Tool：各对应一种 `kind`，用来验证前端的 kind 分派。 */
export const STUB_PAYLOAD_TOOLS = ['generate_animation', 'get_code_template', 'generate_quiz'] as const

/** 三种内联卡片占位各自的说明（真实卡片在票 16–19）。 */
export const STUB_PAYLOAD_NOTES: Record<PayloadKind, string> = {
  animation: '这里会显示动画讲解卡片（模板优先 + 沙箱播放，票 16/17 落地）。',
  coding: '这里会显示编程练习卡片（Monaco 编辑器 + Pyodide Worker，票 18/19 落地）。',
  quiz: '这里会显示随堂练习卡片（生成题目 + 判分闭环，票 14/15 落地）。'
}

/** 撤回后给学生的替代文案（真实终审会给自己的安全提示，见票 22）。 */
export const STUB_SAFE_TEXT = '我们换个话题吧：我可以讲讲人工智能是怎么学习认出一只猫的。'

/** 撤回原因（面向开发者/答辩，不展示给学生的细节放这里）。 */
export const STUB_BLOCKED_REASON = '示例：内容安全终审判定为不适合展示（票 05 假数据源）。'

/** 撤回前的那段「违规草稿」——只用于演示「先流式输出、再整段撤回」。 */
const STUB_BLOCKED_DRAFT = '（示例输出）下面是一段会被安全终审撤回的内容……'

/** 降级提示文案：可读、不塞堆栈。 */
export const STUB_ERROR_MESSAGE = '示例：云端模型暂时不可用，已改为本地知识库作答（票 05 假数据源）。'

/** 示例引用：一条同学段 + 一条「向上兼容」（`compat: true`，§6.4 要求跨学段必须显式标注）。 */
export const STUB_CITATIONS: readonly Citation[] = [
  {
    chunkId: 'kb-primary_low-ai-intro-1',
    chapterTitle: '走进人工智能',
    sectionTitle: '人工智能会做什么',
    gradeLevel: 'primary_low',
    compat: false
  },
  {
    chunkId: 'kb-junior-ml-basics-3',
    chapterTitle: '机器学习入门',
    sectionTitle: '模型是怎样被训练的',
    gradeLevel: 'junior',
    compat: true
  }
]

/** 按输入挑一条确定性链条（UI 三个分支都能被手工复现）。 */
export function detectStubScenario(text: string): StubScenario {
  const normalized = text.toLowerCase()
  if (normalized.includes(BLOCKED_KEYWORD)) return 'blocked'
  if (normalized.includes(ERROR_KEYWORD)) return 'error'
  return 'chat'
}

/** 假数据源的回答：**显式声明自己不是真模型**，并原样回显学生的问题（便于端到端比对逐字相等）。 */
export function buildStubReply(userText: string): string {
  const chars = Array.from(userText)
  const echo = chars.slice(0, MAX_ECHO_CHARS).join('')
  const ellipsis = chars.length > MAX_ECHO_CHARS ? '……' : ''
  return (
    `这是票 05 的${STUB_MARKER}在回话：你刚才问的是「${echo}${ellipsis}」。` +
    '这段话由主进程按「一个字一个事件」经 IPC 推给页面，用来证明 6 事件通道、请求号贯穿一轮、中文跨段不断字。' +
    '接上真实模型之后（票 06），这里会换成模型的流式回答。'
  )
}

/** 按 **码点** 切成单字：`Array.from` 保证代理对（如「𠀀」）不会被劈成两半。 */
export function splitIntoDeltaPieces(text: string): string[] {
  return Array.from(text)
}

/** 把一段文字变成一串 `delta` 事件（1 字 1 事件）。 */
export function planDeltas(text: string): TurnEvent[] {
  return splitIntoDeltaPieces(text).map((delta) => ({ name: 'delta', data: { delta } }))
}

/** 三种 `kind` 的占位载荷（`payload` 是 `unknown`，这里用 `placeholder: true` 明确标注是假的）。 */
export function planPayloads(): TurnEvent[] {
  const events: TurnEvent[] = []
  for (const tool of STUB_PAYLOAD_TOOLS) {
    const kind = kindForTool(tool)
    // 表里没有就**不发**（防静默漂移：宁缺一个卡片，也不给前端一个猜出来的 kind）
    if (kind === null) continue
    events.push({
      name: 'payload',
      data: { kind, payload: { placeholder: true, tool, note: STUB_PAYLOAD_NOTES[kind] } }
    })
  }
  return events
}

/**
 * 确定性事件序列：**同一份输入永远得到同一串事件**（顺序、条数、内容都可断言）。
 * `requestId` 只用于生成 `done.messageId`；事件本身不带 `requestId`（由句柄注入）。
 */
export function planStubTurn(userText: string, requestId: string): TurnEvent[] {
  const scenario = detectStubScenario(userText)

  if (scenario === 'blocked') {
    return [
      ...planDeltas(STUB_BLOCKED_DRAFT),
      { name: 'blocked', data: { reason: STUB_BLOCKED_REASON, safeText: STUB_SAFE_TEXT } },
      { name: 'done', data: { messageId: messageIdFor(requestId) } }
    ]
  }

  if (scenario === 'error') {
    return [
      ...planDeltas('（示例输出）先给出一小段，然后模拟模型侧异常……'),
      { name: 'error', data: { message: STUB_ERROR_MESSAGE, degraded: true } }
    ]
  }

  return [
    ...planDeltas(buildStubReply(userText)),
    { name: 'citation', data: { citations: STUB_CITATIONS.map((citation) => ({ ...citation })) } },
    ...planPayloads(),
    { name: 'done', data: { messageId: messageIdFor(requestId) } }
  ]
}

export interface StubRunOptions {
  /** 调度器：默认 `setTimeout`；单测注入同步实现即可不用等。 */
  schedule?: (run: () => void, delayMs: number) => void
  /** `delta` 之间的间隔（毫秒）。 */
  deltaIntervalMs?: number
  /** 其余事件之间的间隔（毫秒）。 */
  eventIntervalMs?: number
}

/**
 * 按序投递假数据源的事件（累计延时，保证顺序；`done` / `error` 之后结束本轮）。
 *
 * ★ 第一个事件也被排进调度器（而不是同步发）——让 `invoke` 的回执先回到渲染进程，
 *   渲染进程就能先建好轮次再收事件（配合 `renderer/src/api/events.ts` 的缓冲，两条路都稳）。
 */
export function runStubTurn(handle: TurnHandle, userText: string, options: StubRunOptions = {}): void {
  const schedule =
    options.schedule ?? ((run: () => void, delayMs: number): void => { setTimeout(run, delayMs) })
  const deltaInterval = options.deltaIntervalMs ?? STUB_DELTA_INTERVAL_MS
  const eventInterval = options.eventIntervalMs ?? STUB_EVENT_INTERVAL_MS

  const plan = planStubTurn(userText, handle.requestId)
  let elapsed = 0

  for (const event of plan) {
    elapsed += event.name === 'delta' ? deltaInterval : eventInterval
    schedule(() => {
      handle.emit(event)
      if (event.name === 'done' || event.name === 'error') handle.finish()
    }, elapsed)
  }
}

function messageIdFor(requestId: string): string {
  return `stub-message:${requestId}`
}
