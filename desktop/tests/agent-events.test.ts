/**
 * 票 06 守卫 A：**Pi 原生事件 → 冻结 6 事件**的映射（执行文档 §6.4 / §9.3 / §9.4）。
 *
 * 覆盖四类最容易被"顺手改坏"的行为：
 *   G1  逐个事件的上行映射（delta / citation / payload / blocked / done / error）
 *   G2  ★ `session_end` **不存在**：写了也不生效 —— 用「订阅了也没有任何事件」把它钉死
 *   G3  ★ 终态语义：`error` 与 `done` 都是终态；`tool_execution_end` 只读、不改写结果
 *   G4  ★ 容错：未知事件 / 缺字段 / 乱序 / 映射层自身异常都不得冒到主进程
 *
 * 另有两条静态守卫（因为"手写第二张表"和"回退到 session_end"是静默失效型错误）：
 *   G5  `events.ts` 必须从 `ipc/tool-kinds.ts` 取 kind（全仓唯一的表），不得自建
 *   G6  `events.ts` 源码里不得出现 `session_end`
 *
 * 跑法：`npm test`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { IpcEventName } from '../src/shared/ipc-events.ts'
import { IPC_EVENT_NAMES } from '../src/shared/ipc-events.ts'
import type { TurnEvent } from '../src/main/ipc/chat-stream.ts'
import {
  bindTurnStream,
  createTurnMapperState,
  describeProviderError,
  describeRuntimeFailure,
  describeTurnException,
  isTerminalTurnEvent,
  mapPiEvent,
  MISSING_KEY_MESSAGE,
  MESSAGE_ID_PREFIX,
  planBlockedEvent,
  RAG_SEARCH_TOOL,
  readToolFailure,
  type PiEventSource,
  type PiNativeEvent,
  type TurnSink
} from '../src/main/agent/events.ts'
import { PAYLOAD_TOOL_NAMES, TOOL_TO_KIND } from '../src/main/ipc/tool-kinds.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const eventsSource = readFileSync(join(desktopRoot, 'src', 'main', 'agent', 'events.ts'), 'utf8')

const CONTEXT = { requestId: 'turn_test_0001' }

/** 走一遍完整映射（每个测试自己一份 state，避免互相影响）。 */
function mapAll(events: PiNativeEvent[], context = CONTEXT): TurnEvent[] {
  const state = createTurnMapperState()
  const out: TurnEvent[] = []
  for (const event of events) out.push(...mapPiEvent(event, state, context))
  return out
}

/** 只映射一个事件（需要观察 state 的测试用）。 */
function mapOne(event: PiNativeEvent, context = CONTEXT): { events: TurnEvent[]; state: ReturnType<typeof createTurnMapperState> } {
  const state = createTurnMapperState()
  const events = mapPiEvent(event, state, context)
  return { events, state }
}

/* ------------------------------------------------------------------ *
 * G1 逐个事件的上行映射
 * ------------------------------------------------------------------ */

test('G1a delta：message_update 的文本增量原样成 delta（中文与代理对不拆）', () => {
  const chunks = ['人工', '智能', '怎么', '认出猫？', '𠀀']
  const events = mapAll(
    chunks.map((delta) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }))
  )

  assert.deepEqual(
    events,
    chunks.map((delta) => ({ name: 'delta', data: { delta } })),
    '每个非空文本增量必须产生一个 delta 事件，且内容逐字一致'
  )
  const joined = events.map((event) => (event.name === 'delta' ? event.data.delta : '')).join('')
  assert.equal(joined, chunks.join(''), '跨 chunk 拼接后必须与原字符串完全相等')
  assert.ok(!joined.includes('\uFFFD'), '拼接结果不得出现替换字符（乱码）')
})

test('G1b delta：空增量与缺字段不发事件（只记忽略计数）', () => {
  const empty = mapOne({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } })
  assert.deepEqual(empty.events, [])
  assert.equal(empty.state.ignoredEvents, 1)

  const missing = mapOne({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } })
  assert.deepEqual(missing.events, [])

  const noUpdate = mapOne({ type: 'message_update' })
  assert.deepEqual(noUpdate.events, [])
  assert.equal(noUpdate.state.ignoredEvents, 1)
})

test('G1c delta：非文本型 message_update（思考/工具调用/本条消息流结束）都不上 UI', () => {
  const types = ['start', 'text_start', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done']
  for (const type of types) {
    const { events, state } = mapOne({ type: 'message_update', assistantMessageEvent: { type, delta: '不该出现' } })
    assert.deepEqual(events, [], `assistantMessageEvent.type=${type} 不该映射成契约事件`)
    assert.equal(state.ignoredEvents, 1, `type=${type} 应计入忽略计数`)
  }
})

test('G1d citation：rag_search 的结果翻成 citation，字段逐个校验（认不准就丢）', () => {
  const result = {
    content: [{ type: 'text', text: '检索到 2 条' }],
    details: {
      citations: [
        { chunkId: 'kb-primary_high-ml-1', chapterTitle: '语音识别', sectionTitle: '机器怎么听懂', gradeLevel: 'primary_high', compat: false },
        { chunkId: 'kb-junior-ml-3', chapterTitle: '机器学习入门', sectionTitle: '模型怎样被训练', gradeLevel: 'junior', compat: true },
        // 下面三条都应被丢弃：缺 chunkId / 学段非法 / 不是对象
        { chapterTitle: '无 id', gradeLevel: 'junior', compat: false },
        { chunkId: 'kb-x', gradeLevel: '大学', compat: false },
        'not-an-object'
      ]
    }
  }
  const events = mapAll([{ type: 'tool_execution_end', toolCallId: 'c1', toolName: RAG_SEARCH_TOOL, result, isError: false }])

  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'citation')
  const citations = events[0].name === 'citation' ? events[0].data.citations : []
  assert.equal(citations.length, 2, '只有两条字段齐全的引用能发出去')
  assert.deepEqual(citations[0], {
    chunkId: 'kb-primary_high-ml-1',
    chapterTitle: '语音识别',
    sectionTitle: '机器怎么听懂',
    gradeLevel: 'primary_high',
    compat: false
  })
  assert.equal(citations[1].compat, true, '向上兼容必须显式标注 compat=true')
})

test('G1e citation：rag_search 无结果 / 结构不认时不发空 citation 事件', () => {
  const cases: unknown[] = [
    { details: { citations: [] } },
    { details: {} },
    {},
    null,
    '纯文本结果'
  ]
  for (const result of cases) {
    const events = mapAll([{ type: 'tool_execution_end', toolName: RAG_SEARCH_TOOL, result, isError: false }])
    assert.deepEqual(events, [], `rag_search 结果 ${JSON.stringify(result)} 不该产生事件`)
  }
})

test('G1f payload：表内 7 个 Tool 各映射到正确 kind（表只有一份，漂移即失败）', () => {
  const expected = Object.entries(TOOL_TO_KIND) as Array<[string, string]>
  assert.equal(expected.length, 7, '冻结表必须是 7 个 Tool')

  for (const [toolName, kind] of expected) {
    const events = mapAll([
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName,
        isError: false,
        result: { content: [{ type: 'text', text: 'ok' }], details: { concept: '决策树' } }
      }
    ])
    assert.equal(events.length, 1, `${toolName} 必须产生一个 payload 事件`)
    assert.equal(events[0].name, 'payload')
    if (events[0].name !== 'payload') continue
    assert.equal(events[0].data.kind, kind, `${toolName} 的 kind 必须与冻结表一致`)
    assert.deepEqual(
      events[0].data.payload,
      { concept: '决策树', tool: toolName, kind },
      'payload 必须带上产出者 Tool 名（前端卡片靠它归档）'
    )
  }
})

test('G1g payload：不在表内的 Tool（检索 / 画像 / 未知）不发 payload 事件', () => {
  for (const toolName of ['rag_search', 'get_student_profile', 'smoke_echo', 'debug_throw']) {
    const events = mapAll([
      { type: 'tool_execution_end', toolCallId: 'c1', toolName, isError: false, result: { details: { anything: 1 } } }
    ])
    assert.deepEqual(events, [], `${toolName} 不在 TOOL_TO_KIND 里，不发 payload（也不能猜一个 kind）`)
  }
  // 表内名单与映射键集合一致（防止有人只改一边）
  assert.deepEqual(Object.keys(TOOL_TO_KIND), [...PAYLOAD_TOOL_NAMES])
})

test('G1h error：provider 异常 → 可读 error（degraded=false 真终态），四类原因文案可分', () => {
  const cases: Array<[string, RegExp]> = [
    ['401 Unauthorized: invalid api key', /API Key 被拒绝/],
    ['402 Insufficient Balance', /额度不足/],
    ['fetch failed: ECONNREFUSED 127.0.0.1:9', /网络连接不上/],
    ['429 rate limit exceeded', /请求过于频繁/],
    ['something totally unexpected happened', /云端模型暂时不可用/]
  ]
  for (const [raw, pattern] of cases) {
    const { events, state } = mapOne({
      type: 'message_update',
      assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: raw } }
    })
    assert.equal(events.length, 1, `供应商错误「${raw}」必须发一个 error 事件`)
    assert.equal(events[0].name, 'error')
    if (events[0].name !== 'error') continue
    assert.match(events[0].data.message, pattern, `「${raw}」的文案应可区分`)
    // `degraded: false` = **真终态**（见事件终态约定）：本轮彻底失败、UI 收尾。
    // 若这里写成 true，`isTerminalTurnEvent` 会判它非终态 → `finish()` 永不调用
    // → UI 永远停在「回答中…」（`errorEmitted` 已置真，兜底 done 也不会来）。
    assert.equal(events[0].data.degraded, false, 'provider 失败是本轮终态，不是「能力受限」')
    assert.ok(events[0].data.message.length <= 200, '文案必须短到能进气泡')
    assert.equal(state.errorEmitted, true)
    assert.equal(isTerminalTurnEvent(events[0]), true, '置位 errorEmitted 的错误必须同时是终态')
  }
})

test('G1i error：缺凭证的文案与「运行时故障」严格区分开', () => {
  const missing = describeProviderError('No API key found for deepseek.')
  assert.equal(missing, MISSING_KEY_MESSAGE, '缺 Key 必须命中专用文案')
  assert.match(missing, /不是程序故障/, '缺 Key 的文案必须排除「程序坏了」的误读')
  assert.match(missing, /API Key/, '缺 Key 的文案必须指向配置动作')

  const runtimeFailure = describeRuntimeFailure(new Error('Cannot find package esbuild'))
  assert.ok(runtimeFailure !== missing, '装配失败与缺 Key 不能是同一句话')
  assert.match(runtimeFailure, /运行时/, '装配失败必须说清是运行时问题')
  assert.match(runtimeFailure, /不是密钥或网络问题/, '装配失败必须排除「缺 Key / 网络」的误读')
  assert.match(runtimeFailure, /esbuild/, '装配失败要保留原始原因便于排查')
})

/* ------------------------------------------------------------------ *
 * G2 ★ session_end 不存在
 * ------------------------------------------------------------------ */

test('G2 session_end 不存在：订阅了也不产生任何事件；会话终态用 session_shutdown', () => {
  const { events, state } = mapOne({ type: 'session_end' })
  assert.deepEqual(events, [], 'session_end 不存在，映射不出任何契约事件')
  assert.equal(state.ignoredEvents, 1, '它会被当成未识别事件忽略（而不是静默当成一轮结束）')

  // 会话终态（quit/reload/new/resume/fork）不是一轮结束，同样不发事件
  const shutdown = mapOne({ type: 'session_shutdown', reason: 'quit' })
  assert.deepEqual(shutdown.events, [])
  assert.equal(shutdown.state.doneEmitted, false, 'session_shutdown 不代表本轮已有 done')

  // 静态守卫：源码里不得出现 session_end（写了会静默不生效）
  const withoutComments = eventsSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
  assert.ok(
    !/['"`]session_end['"`]/.test(withoutComments),
    'events.ts 里不得订阅/引用 session_end（Pi 无此事件，写了不生效）'
  )
  assert.ok(
    /session_shutdown/.test(withoutComments),
    'events.ts 必须显式处理 session_shutdown（会话终态）'
  )
})

/* ------------------------------------------------------------------ *
 * G3 终态语义与 done
 * ------------------------------------------------------------------ */

test('G3a done：agent_end → done（messageId 取 Pi 的 responseId）', () => {
  const events = mapAll([
    { type: 'agent_end', messages: [{ role: 'user' }, { role: 'assistant', responseId: 'resp-42' }], willRetry: false }
  ])
  assert.deepEqual(events, [{ name: 'done', data: { messageId: `${MESSAGE_ID_PREFIX}resp-42` } }])
})

test('G3b done：拿不到 responseId 时用本轮请求号兜底（UI 不会拿到空 messageId）', () => {
  const noResponseId = mapAll([{ type: 'agent_end', messages: [{ role: 'assistant' }] }])
  assert.deepEqual(noResponseId, [{ name: 'done', data: { messageId: `${MESSAGE_ID_PREFIX}${CONTEXT.requestId}` } }])

  const noMessages = mapAll([{ type: 'agent_end' }])
  assert.deepEqual(noMessages, [{ name: 'done', data: { messageId: `${MESSAGE_ID_PREFIX}${CONTEXT.requestId}` } }])
})

test('G3c done：willRetry=true 时不算结束（重试期间不许提前收尾）', () => {
  const { events, state } = mapOne({ type: 'agent_end', messages: [{ role: 'assistant', responseId: 'r1' }], willRetry: true })
  assert.deepEqual(events, [], 'Pi 还要重试，本轮不能发 done')
  assert.equal(state.doneEmitted, false)
})

test('G3d done：agent_end 与 agent_settled 只允许一个赢家（幂等）', () => {
  const events = mapAll([
    { type: 'agent_end', messages: [{ role: 'assistant', responseId: 'r1' }] },
    { type: 'agent_settled' },
    { type: 'agent_end', messages: [{ role: 'assistant', responseId: 'r2' }] }
  ])
  assert.deepEqual(events, [{ name: 'done', data: { messageId: `${MESSAGE_ID_PREFIX}r1` } }])

  // 乱序：settled 先到也算一轮结束（兜底路径）
  const settledFirst = mapAll([{ type: 'agent_settled' }])
  assert.deepEqual(settledFirst, [{ name: 'done', data: { messageId: `${MESSAGE_ID_PREFIX}${CONTEXT.requestId}` } }])
})

test('G3d2 ★ 失败收尾的 agent_end 必须发 error 而不是 done（实测序列回归）', () => {
  // 0.85.1 的真实序列：重试 3 次 → 末次 agent_end 才结束 → auto_retry_end(失败) → agent_settled
  const events = mapAll([
    { type: 'agent_start' },
    { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'fetch failed' }], willRetry: true },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'fetch failed' },
    { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'fetch failed' }], willRetry: true },
    { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, errorMessage: 'fetch failed' },
    { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'fetch failed' }] },
    { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'fetch failed' },
    { type: 'agent_settled' }
  ])

  assert.deepEqual(
    events.map((event) => event.name),
    ['error'],
    '整轮失败只能发一个终态 error：先发 done 会让 UI 丢弃随后的 error（error 对 UI 是终态）'
  )
  if (events[0].name === 'error') {
    assert.match(events[0].data.message, /网络连接不上/, '供应商原文 fetch failed 要翻成可读文案')
    // 重试耗尽 = 本轮彻底失败 = **真终态**，所以必须是 `degraded: false`。
    assert.equal(events[0].data.degraded, false)
    assert.equal(isTerminalTurnEvent(events[0]), true, '重试耗尽的 error 必须终结本轮（否则 sink.finish() 永不调用）')
  }
})

test('G3d3 agent_end 的失败判据：errorMessage / stopReason=error 算失败，aborted 与正常结束不算', () => {
  const failedByMessage = mapAll([{ type: 'agent_end', messages: [{ role: 'assistant', errorMessage: '401 Unauthorized' }] }])
  assert.equal(failedByMessage.length, 1)
  assert.equal(failedByMessage[0].name, 'error')
  if (failedByMessage[0].name === 'error') assert.match(failedByMessage[0].data.message, /API Key 被拒绝/)

  const failedByReason = mapAll([{ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }] }])
  assert.equal(failedByReason[0].name, 'error')

  // 用户主动中断：一次正常收尾，不是故障
  const aborted = mapAll([{ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] }])
  assert.equal(aborted[0].name, 'done')

  // 正常结束：末条是工具结果（没有 assistant）时也算正常
  const toolLast = mapAll([{ type: 'agent_end', messages: [{ role: 'toolResult', toolCallId: 'c1' }] }])
  assert.equal(toolLast[0].name, 'done')
})

test('G3e 自动重试：重试期间的供应商错误先不发，重试失败才发一次终态 error', () => {
  const state = createTurnMapperState()
  const collected: TurnEvent[] = []
  const push = (event: PiNativeEvent): void => {
    collected.push(...mapPiEvent(event, state, CONTEXT))
  }

  push({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'ECONNRESET' })
  push({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'ECONNRESET' } } })
  assert.equal(collected.length, 0, '重试期间的失败不上 UI（否则重试成功后正文会被 UI 丢掉）')
  assert.equal(state.retrying, true)

  // 重试成功：正文继续，且不产生 error
  push({ type: 'auto_retry_end', success: true, attempt: 1 })
  push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '重试后的正文' } })
  assert.deepEqual(collected.map((event) => event.name), ['delta'])
  assert.deepEqual(collected[0].data, { delta: '重试后的正文' })
  assert.equal(state.errorEmitted, false)

  // 重试彻底失败：这才是终态
  push({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, errorMessage: 'ECONNRESET' })
  push({ type: 'auto_retry_end', success: false, attempt: 2, finalError: 'ECONNRESET 127.0.0.1' })
  assert.deepEqual(collected.map((event) => event.name), ['delta', 'error'], '重试彻底失败后必须发终态 error')
  assert.equal(state.errorEmitted, true)

  // 终态 error 之后不再重复发
  push({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'again' } } })
  assert.equal(collected.length, 2, 'error 是终态：一轮只发一次')
})

test('G3f tool_execution_end 只读：失败映射成 error，但不能改写结果（映射不返回任何回写结构）', () => {
  const event: PiNativeEvent = {
    type: 'tool_execution_end',
    toolCallId: 'c9',
    toolName: 'generate_animation',
    isError: true,
    result: { content: [{ type: 'text', text: '模板校验失败' }], details: {} }
  }
  const snapshot = JSON.stringify(event)
  const { events } = mapOne(event)
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'error')
  if (events[0].name === 'error') {
    assert.match(events[0].data.message, /动画演示/, '文案要说人话（不暴露内部 Tool 名）')
    assert.equal(events[0].data.degraded, true)
    assert.ok(!events[0].data.message.includes('generate_animation'), '不得把 Tool 名发给学生')
  }
  assert.equal(JSON.stringify(event), snapshot, '映射过程不得修改事件对象（只读通知）')
})

test('G3g 工具失败只认两种标记；结果里带 degraded（中途降级）不算失败', () => {
  // ① isError
  assert.equal(readToolFailure({ type: 'tool_execution_end', toolName: 'rag_search', isError: true, result: {} }), '工具返回了错误')
  // ② details.error（票 08 的 safeToolExecute 用它兜异常）
  assert.equal(
    readToolFailure({ type: 'tool_execution_end', toolName: 'evaluate_code', isError: false, result: { details: { error: true, errorMessage: 'Pyodide 未就绪' } } }),
    'Pyodide 未就绪'
  )
  // ③ 中途降级（检索降级到 FTS5）：**不是失败**，不发 error（否则 UI 会丢掉后半段正文）
  assert.equal(
    readToolFailure({ type: 'tool_execution_end', toolName: 'rag_search', isError: false, result: { details: { degraded: 'fts', citations: [] } } }),
    null
  )
  const degraded = mapAll([
    { type: 'tool_execution_end', toolName: 'rag_search', isError: false, result: { details: { degraded: 'outline', citations: [] } } }
  ])
  assert.deepEqual(degraded, [], '降级信息随结果走，不单独发 error 事件')
})

test('G3h 终态判定：done 与「degraded=false 的 error」是终态；工具失败的 degraded error 与其余事件不是', () => {
  assert.equal(isTerminalTurnEvent({ name: 'done', data: { messageId: 'm' } }), true)
  assert.equal(isTerminalTurnEvent({ name: 'error', data: { message: 'x', degraded: false } }), true)
  // ★ 工具失败发的 `degraded: true` 的 error **不是终态**：模型通常还会用文字把这一轮讲完，
  //   那两段正文必须继续送达。若这里判成终态，`sink.finish()` 会立刻注销该轮，
  //   后续 delta 全被丢弃 —— 学生只看到半句话 + 一条报错（已实测踩到）。
  assert.equal(
    isTerminalTurnEvent({ name: 'error', data: { message: 'x', degraded: true } }),
    false,
    'degraded=true 的 error 只作提示，不终结本轮'
  )
  for (const event of [
    { name: 'delta', data: { delta: 'x' } },
    { name: 'citation', data: { citations: [] } },
    { name: 'payload', data: { kind: 'quiz', payload: {} } },
    planBlockedEvent('r', 's')
  ] as TurnEvent[]) {
    assert.equal(isTerminalTurnEvent(event), false, `${event.name} 不是终态`)
  }
})

test('G3h2 ★ 工具失败后正文必须继续送达：degraded error 不终结本轮，finish 只在末尾发生一次', () => {
  // 实测踩到的回归：`mapToolExecutionEnd` 对任何 Tool 失败都发 `error`，而 `bindTurnStream`
  // 一见终态就 `sink.finish()` → 该轮注销 → 模型随后写出的正文全被丢弃。
  // 学生实际看到的是「半句话 + 一条报错」，而 rag_search / get_student_profile 在 sidecar
  // 没起来时**必然**会失败（属可降级失败，配置里明说「用文字把这一轮讲完」）。
  const { session, push } = fakeSession()
  const { sink, events, finishedCount } = fakeSink()
  bindTurnStream(session, sink, CONTEXT)

  push({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: '我先查一下教材。' }
  })
  push({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'rag_search',
    isError: true,
    result: { content: [{ type: 'text', text: '本地数据服务不可用' }] }
  })
  push({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: '不过我知道答案：循环是重复执行。' }
  })
  push({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] })

  assert.deepEqual(
    events.map((event) => event.name),
    ['delta', 'error', 'delta', 'done'],
    '工具失败的 error 之后必须还能收到 delta（正文不丢）'
  )
  const degraded = events[1]
  assert.equal(degraded.name === 'error' && degraded.data.degraded, true, '工具失败是「能力受限」提示')
  assert.equal(finishedCount(), 1, '本轮只在末尾收尾一次（若中途 finish，后续 delta 会被 registry 丢掉）')

  // 反面：真终态的 provider 失败必须**立刻**收尾（映射层照常投递迟到事件，
  // 由 ChatStreamRegistry 按「终态后不再接受」丢弃 —— 这里只断言收尾与 closed 标志）
  const terminal = fakeSession()
  const second = fakeSink()
  const terminalBinding = bindTurnStream(terminal.session, second.sink, CONTEXT)
  terminal.push({
    type: 'message_update',
    assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'fetch failed' } }
  })
  assert.deepEqual(second.events.map((event) => event.name), ['error'], '真终态立刻可见')
  assert.equal(second.finishedCount(), 1, '真终态必须收尾')
  assert.equal(terminalBinding.closed, true, '真终态后本轮标记为已关闭（后续事件由 registry 丢弃）')
})

test('G3i blocked：安全终审的发射点已就位（票 22 只接判定，不改契约）', () => {
  const event = planBlockedEvent('内容安全终审判定为不适合展示。', '我们换个话题吧。')
  assert.deepEqual(event, {
    name: 'blocked',
    data: { reason: '内容安全终审判定为不适合展示。', safeText: '我们换个话题吧。' }
  })
  // 发射点在 events.ts 里（票 22 从这里接），而不是散在 handlers 里
  assert.match(eventsSource, /export function planBlockedEvent/, 'blocked 事件必须由 events.ts 提供构造器')
})

/* ------------------------------------------------------------------ *
 * G4 容错：未知事件 / 缺字段 / 乱序 / 映射层自身异常
 * ------------------------------------------------------------------ */

test('G4a 未知与畸形事件：一律忽略并计数，绝不抛异常', () => {
  const weird: Array<PiNativeEvent | null | undefined> = [
    null,
    undefined,
    {} as PiNativeEvent,
    { type: 42 } as unknown as PiNativeEvent,
    { type: 'entry_appended' },
    { type: 'compaction_start', reason: 'threshold' },
    { type: 'queue_update' },
    { type: 'ui_prompt_start' },
    { type: 'turn_start' },
    { type: 'turn_end' },
    { type: 'message_start' },
    { type: 'message_end' },
    { type: 'tool_execution_start', toolName: 'rag_search' },
    { type: 'tool_execution_update', toolName: 'rag_search' }
  ]
  const state = createTurnMapperState()
  for (const event of weird) {
    assert.deepEqual(mapPiEvent(event, state, CONTEXT), [], `事件 ${JSON.stringify(event)} 不该产生契约事件`)
  }
  assert.equal(state.ignoredEvents, weird.length, '每个未识别事件都要计数（可观测的容错证据）')
})

test('G4b tool_execution_end 缺 toolName 时不猜：忽略而不是发出无来源的 payload', () => {
  const { events, state } = mapOne({ type: 'tool_execution_end', toolCallId: 'c1', result: { details: {} }, isError: false })
  assert.deepEqual(events, [])
  assert.equal(state.ignoredEvents, 1)
})

test('G4c 乱序：done 之后来的 delta 仍会被映射（由 registry 负责丢弃，映射层不静默吞事件）', () => {
  const events = mapAll([
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '前半' } },
    { type: 'agent_end', messages: [{ role: 'assistant', responseId: 'r1' }] },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '迟到' } }
  ])
  assert.deepEqual(
    events.map((event) => event.name),
    ['delta', 'done', 'delta'],
    '映射层保持原始顺序（丢弃迟到事件是 chat-stream registry 的职责）'
  )
})

test('G4d 乱序：先 error 后 agent_end —— 一轮只有一个终态事件（error 之后不再补 done）', () => {
  const events = mapAll([
    { type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: '401' } } },
    { type: 'agent_end', messages: [{ role: 'assistant', responseId: 'r1' }] }
  ])
  assert.deepEqual(
    events.map((event) => event.name),
    ['error'],
    'error 是终态：再补 done 会让 UI 的收尾语义变模糊（状态文案与提示条会互相打架）'
  )
})

test('G4e 所有产出的事件名都在冻结词表内（不多一个、不改一个字）', () => {
  const mapped = mapAll([
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } },
    { type: 'tool_execution_end', toolName: RAG_SEARCH_TOOL, isError: false, result: { details: { citations: [{ chunkId: 'c', gradeLevel: 'junior', chapterTitle: 'a', sectionTitle: 'b', compat: false }] } } },
    { type: 'tool_execution_end', toolName: 'generate_quiz', isError: false, result: { details: {} } },
    { type: 'tool_execution_end', toolName: 'evaluate_code', isError: true, result: { details: {} } },
    { type: 'agent_end', messages: [] }
  ])
  // blocked 由安全终审（票 22）单独发，不在 Pi 事件流里 —— 单独并入一起断言词表
  const names = new Set([...mapped, planBlockedEvent('r', 's')].map((event) => event.name))
  for (const name of names) {
    assert.ok((IPC_EVENT_NAMES as readonly string[]).includes(name), `${name} 不在冻结的 6 事件词表里`)
  }
  assert.deepEqual([...names].sort(), [...IPC_EVENT_NAMES].sort(), '六条分支都应被覆盖到')
  for (const name of names) assert.ok(typeof name === 'string' && (name as IpcEventName).length > 0)
})

/* ------------------------------------------------------------------ *
 * G5/G6 静态守卫
 * ------------------------------------------------------------------ */

test('G5 events.ts 从 ipc/tool-kinds.ts 取 kind，不自建第二张表', () => {
  assert.match(
    eventsSource,
    /import\s*\{[^}]*kindForTool[^}]*\}\s*from\s*'\.\.\/ipc\/tool-kinds\.ts'/,
    'events.ts 必须 import kindForTool（`tool-kinds.ts` 是全仓唯一映射表）'
  )
  // 反向：不得出现"自己写一份 Tool → kind"的字面量（kind 取值只能是 animation/coding/quiz）
  assert.ok(
    !/:\s*'(animation|coding|quiz)'/.test(eventsSource),
    'events.ts 里不得出现 Tool→kind 的第二份表（kind 取值必须来自 tool-kinds.ts）'
  )
  // 工具名只允许出现在「面向学生的口语化描述」里（toolDescription），不得出现在 kind 映射位置
  assert.match(eventsSource, /export function toolDescription/, '工具名 → 学生可读说法必须集中在 toolDescription')
})

test('G6 bindTurnStream：收敛到 sink 上、终态即 finish、退订生效', () => {
  const { session, push, unsubscribeCount } = fakeSession()
  const { sink, events, finishedCount } = fakeSink()
  const binding = bindTurnStream(session, sink, CONTEXT)

  push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '一' } })
  push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '二' } })
  assert.equal(binding.closed, false)
  assert.equal(finishedCount(), 0)

  push({ type: 'agent_end', messages: [{ role: 'assistant', responseId: 'r7' }] })
  assert.deepEqual(events.map((event) => event.name), ['delta', 'delta', 'done'])
  assert.equal(finishedCount(), 1, 'done 必须立刻收尾本轮')
  assert.equal(binding.closed, true)

  // 终态之后再来事件：照常投递（由 registry 丢弃），但不重复 finish
  push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '迟到' } })
  assert.equal(finishedCount(), 1, 'finish 只调用一次')

  binding.unsubscribe()
  assert.equal(unsubscribeCount(), 1)
  push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '退订后' } })
  assert.equal(events.length, 4, '退订后不再有新事件到达 sink')
})

test('G6b bindTurnStream.failWith：prompt() 抛异常时补一条可读 error 并收尾（幂等）', () => {
  const { session, push } = fakeSession()
  const { sink, events, finishedCount } = fakeSink()
  const binding = bindTurnStream(session, sink, CONTEXT)

  push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '已经开始说了' } })
  binding.failWith('云端模型暂时不可用：网络连接不上。')

  assert.deepEqual(events.map((event) => event.name), ['delta', 'error'])
  assert.equal(finishedCount(), 1)
  assert.equal(binding.closed, true)

  binding.failWith('再来一次')
  assert.equal(events.length, 2, 'failWith 幂等：已经终结就不补')
  assert.equal(finishedCount(), 1)
})

test('G6c bindTurnStream.failWith：已正常收尾的一轮不再补错误（不许把成功改成失败）', () => {
  const { session, push } = fakeSession()
  const { sink, events } = fakeSink()
  const binding = bindTurnStream(session, sink, CONTEXT)
  push({ type: 'agent_end', messages: [{ role: 'assistant', responseId: 'r1' }] })
  binding.failWith('不该出现')
  assert.deepEqual(events.map((event) => event.name), ['done'])
})

test('G6d 映射层自身异常不得冒进 Pi 的事件循环（Pi 与 UI 同进程）', () => {
  const { session, push } = fakeSession()
  const { sink, events } = fakeSink()
  bindTurnStream(session, sink, CONTEXT)

  const hostile = {}
  Object.defineProperty(hostile, 'type', {
    enumerable: true,
    get() {
      throw new Error('读取 type 就炸')
    }
  })
  assert.doesNotThrow(() => {
    push(hostile as PiNativeEvent)
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '照常继续' } })
  })
  assert.deepEqual(events.map((event) => event.name), ['delta'], '坏事件被吞掉，后面的正常事件照常投递')
})

/* ------------------------------------------------------------------ *
 * 无 Key 场景（本机现状）：文案分类
 * ------------------------------------------------------------------ */

test('无 Key 场景：describeTurnException 把「缺凭证 / 供应商 / 内部异常」分成三类', () => {
  const missing = describeTurnException(new Error('No API key found for deepseek.'))
  assert.equal(missing.status, 'missing-key')
  assert.equal(missing.message, MISSING_KEY_MESSAGE)

  const network = describeTurnException(new Error('fetch failed: ECONNREFUSED 127.0.0.1:9'))
  assert.equal(network.status, 'provider-error')
  assert.match(network.message, /网络连接不上/)

  const bug = describeTurnException(new TypeError('x is not a function'))
  assert.equal(bug.status, 'exception')
  assert.match(bug.message, /内部异常/, '我们自己的 bug 必须说成内部异常，不能赖到模型/网络头上')
  assert.match(bug.message, /x is not a function/, '内部异常要保留原因（便于排查）')

  // ★ 三类文案两两不同（否则排查方向会被带偏）
  assert.notEqual(missing.message, network.message)
  assert.notEqual(network.message, bug.message)
  assert.notEqual(missing.message, bug.message)
})

/* ------------------------------------------------------------------ *
 * 测试用假件
 * ------------------------------------------------------------------ */

function fakeSession(): {
  session: PiEventSource
  push: (event: PiNativeEvent) => void
  unsubscribeCount: () => number
} {
  let listener: ((event: PiNativeEvent) => void) | null = null
  let unsubscribed = 0
  const session: PiEventSource = {
    subscribe(next) {
      listener = next
      return () => {
        unsubscribed += 1
        listener = null
      }
    }
  }
  return {
    session,
    push(event) {
      listener?.(event)
    },
    unsubscribeCount: () => unsubscribed
  }
}

function fakeSink(requestId = CONTEXT.requestId): {
  sink: TurnSink & { readonly requestId: string }
  events: TurnEvent[]
  finishedCount: () => number
} {
  const events: TurnEvent[] = []
  let finished = 0
  return {
    sink: {
      requestId,
      emit(event) {
        events.push(event)
        return true
      },
      finish() {
        finished += 1
      }
    },
    events,
    finishedCount: () => finished
  }
}
