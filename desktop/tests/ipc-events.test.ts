/**
 * 票 05 的单测：IPC 事件通道的三块**纯逻辑**。
 *
 *   1. `src/renderer/src/api/events.ts` —— 6 事件的分发/折叠（纯函数）+ 缓冲/容错；
 *   2. `src/main/ipc/stub-chat.ts`        —— 假数据源的事件序列（确定性，票 06 会替换数据源）；
 *   3. `src/main/ipc/chat-stream.ts`      —— 请求号贯穿、窗口销毁清理、不泄漏监听器。
 *   另有 `src/main/ipc/tool-kinds.ts` 的冻结映射断言。
 *
 * 跑法：`npm test`（`node --test`，靠 Node 内置类型擦除，不引入测试框架）。
 * ★ 不得使用 TS parameter property；相对导入**必须带 `.ts` 后缀**（Node ESM 不做扩展名补全）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GradeLevel, IpcEvent, PayloadKind } from '../src/shared/ipc-events.ts'
import {
  ChatStreamRegistry,
  REQUEST_ID_PREFIX,
  withRequestId,
  type StreamTarget,
  type TurnEvent
} from '../src/main/ipc/chat-stream.ts'
import { MAX_INPUT_CHARS, parseChatSendRequest } from '../src/main/ipc/chat-request.ts'
import { IPC, PUSH_CHANNELS } from '../src/main/ipc/channels.ts'
import {
  BLOCKED_KEYWORD,
  ERROR_KEYWORD,
  STUB_PAYLOAD_TOOLS,
  STUB_SAFE_TEXT,
  buildStubReply,
  detectStubScenario,
  planStubTurn,
  runStubTurn,
  splitIntoDeltaPieces
} from '../src/main/ipc/stub-chat.ts'
import { PAYLOAD_TOOL_NAMES, TOOL_TO_KIND, kindForTool } from '../src/main/ipc/tool-kinds.ts'
import {
  FALLBACK_ERROR_TEXT,
  applyChatEvent,
  emptyConversation,
  normalizeIpcEvent,
  startTurn,
  subscribeToChatEvents,
  type ConversationState
} from '../src/renderer/src/api/events.ts'

const REQUEST_ID = 'turn_test-0001'

/** 构造一份「已建立一轮」的状态。 */
function stateWithTurn(requestId = REQUEST_ID, userText = '人工智能是怎么认出一只猫的？'): ConversationState {
  return startTurn(emptyConversation(), requestId, userText)
}

function delta(requestId: string, text: string): IpcEvent {
  return { name: 'delta', data: { requestId, delta: text } }
}

function citations(requestId: string): IpcEvent {
  return {
    name: 'citation',
    data: {
      requestId,
      citations: [
        {
          chunkId: 'kb-primary_low-ai-intro-1',
          chapterTitle: '走进人工智能',
          sectionTitle: '人工智能会做什么',
          gradeLevel: 'primary_low' satisfies GradeLevel,
          compat: false
        }
      ]
    }
  }
}

function payloadEvent(requestId: string, kind: string, payload: unknown = {}): IpcEvent {
  return { name: 'payload', data: { requestId, kind: kind as PayloadKind, payload } }
}

// ── 1. 事件分发：delta 与中文跨段 ─────────────────────────────────────────

const CHINESE_SAMPLE = '人工智能（AI）会「看」也会「听」，比如 𠀀 这个生僻字。'

test('分发：中文按 1 字 1 条 delta 推送后，拼回来与原文逐字相等（含代理对）', () => {
  let state = stateWithTurn()
  for (const piece of splitIntoDeltaPieces(CHINESE_SAMPLE)) {
    state = applyChatEvent(state, delta(REQUEST_ID, piece))
  }

  assert.equal(state.turns[0].text, CHINESE_SAMPLE)
  assert.equal(state.turns[0].text.length, CHINESE_SAMPLE.length)
  assert.ok(state.turns[0].text.includes('𠀀'), '代理对被劈开时这里会变成两个替换字符')
  assert.equal(state.turns[0].text.includes('\uFFFD'), false)
  assert.equal(state.ignoredEvents, 0)
})

test('分发：delta 片段原样追加（空格与换行也是内容的一部分，不做 trim）', () => {
  let state = stateWithTurn()
  state = applyChatEvent(state, delta(REQUEST_ID, '第一句 '))
  state = applyChatEvent(state, delta(REQUEST_ID, '\n第二句'))
  assert.equal(state.turns[0].text, '第一句 \n第二句')
})

test('分发：citation 追加来源，并保留 compat 标注', () => {
  const state = applyChatEvent(stateWithTurn(), citations(REQUEST_ID))
  assert.equal(state.turns[0].citations.length, 1)
  assert.equal(state.turns[0].citations[0].chapterTitle, '走进人工智能')
  assert.equal(state.turns[0].citations[0].compat, false)
})

test('分发：citation 里学段认不出的条目被丢掉（不给学生猜出来的学段标签）', () => {
  const broken: IpcEvent = {
    name: 'citation',
    data: {
      requestId: REQUEST_ID,
      citations: [
        { chunkId: 'kb-x', chapterTitle: 'A', sectionTitle: 'B', gradeLevel: 'college' as GradeLevel, compat: false }
      ]
    }
  }
  const state = applyChatEvent(stateWithTurn(), broken)
  assert.equal(state.turns[0].citations.length, 0)
  assert.equal(state.ignoredEvents, 1)
})

// ── 1b. citation 的 details / degraded 端到端（主进程出帧 → 渲染侧归约）──────
//
// ★ 为什么这几条必须**经出帧口**（`withRequestId`）而不是手搓事件：手搓的用例只验证
//   渲染侧认不认字段，而 2026-09 实测踩到的缺陷正好在中间那一跳 —— `case 'citation'`
//   只搬了 `citations`，`details` / `degraded` 在**出帧处**被整块丢掉。
//   于是右栏「四级降级链」恒显示「本轮没有查教材」（关卡 C 的核心演示证据是死的），
//   回答里的「教材原文」抽屉恒显示「原文暂时取不到」，而两侧的用例都是绿的。
//   所以这里从「主进程构造的事件」一路走到 store，把那一跳钉住。

/** 一份 citation 的引用条目（形状与检索回执的投影一致）。 */
function citationItem(): Extract<IpcEvent, { name: 'citation' }>['data']['citations'][number] {
  return {
    chunkId: 'kb-primary_low-ai-intro-1',
    chapterTitle: '走进人工智能',
    sectionTitle: '人工智能会做什么',
    gradeLevel: 'primary_low' satisfies GradeLevel,
    compat: false
  }
}

/** 一份引用细节（`CitationDetail`，右栏「教材原文」抽屉的数据源）。 */
function citationDetail() {
  return {
    chunkId: 'kb-primary_low-ai-intro-1',
    text: '人工智能会看、会听，也会说话，但它不是人。',
    score: 0.87,
    parentChunkId: 'kb-primary_low-ai-intro',
    degraded: 'fts' as const,
    kpId: 'ai-definition-pl',
    expanded: false
  }
}

test('★ 端到端：citation 的 details / degraded 经出帧口一路到达 store（降级链与教材原文的数据源）', () => {
  const target = new FakeTarget(11)
  const registry = new ChatStreamRegistry({ generateRequestId: () => REQUEST_ID })
  const handle = registry.open(target, '人工智能是怎么认出一只猫的？')

  // 主进程侧的构造与 `agent/events.ts` 的 `mapToolExecutionEnd` 逐字一致：
  // 只在真有内容时挂上可选字段（省略 = 「没有这项信息」）
  const detail = citationDetail()
  const mainEvent: Extract<TurnEvent, { name: 'citation' }> = {
    name: 'citation',
    data: { citations: [citationItem()], details: [detail], degraded: 'fts' }
  }

  assert.equal(handle.emit(mainEvent), true, '本轮应当是活跃的')

  const frames = target.events.filter(
    (event): event is Extract<IpcEvent, { name: 'citation' }> => event.name === 'citation'
  )
  assert.equal(frames.length, 1)
  const frame = frames[0]

  // ① 出帧处逐字段齐全（这里曾经只搬 citations，两个字段在这里蒸发）
  assert.deepEqual(Object.keys(frame.data).sort(), ['citations', 'degraded', 'details', 'requestId'])

  // ② 把**真实出帧**折进 store：两个字段都要落在本轮上
  const state = applyChatEvent(stateWithTurn(), frame)
  assert.equal(state.turns[0].citationDegraded, 'fts', '降级档位必须到达 store（右栏四级降级链据此点亮）')
  assert.equal(state.turns[0].citationDetails.length, 1)
  assert.equal(state.turns[0].citationDetails[0].chunkId, detail.chunkId)
  assert.equal(state.turns[0].citationDetails[0].text, detail.text, '节级正文必须到达 store（否则抽屉只说「原文暂时取不到」）')
  assert.equal(state.turns[0].citationDetails[0].score, 0.87)
  assert.equal(state.ignoredEvents, 0, '这条事件不该被当成畸形数据丢掉')
})

test('★ 反向对照：没有 details / degraded 时不得凭空造出空数组或 null（省略 = 没有这项信息）', () => {
  const content = { citations: [citationItem()] }

  const frame = withRequestId({ name: 'citation', data: content }, REQUEST_ID)
  // 「没带上这一项」与「带了一个空值」不是一回事：多发一个空值，
  // 消费方就分不清「本轮没检索」与「检索了但没降级信息」了。
  assert.equal(Object.hasOwn(frame.data, 'details'), false, '缺 details 时不许补成空数组')
  assert.equal(Object.hasOwn(frame.data, 'degraded'), false, '缺 degraded 时不许补成 null')
  assert.deepEqual(frame, { name: 'citation', data: { requestId: REQUEST_ID, ...content } })

  // 空数组同样是「没有内容」：按存在性透传的条件是长度 > 0
  const emptyDetails = withRequestId({ name: 'citation', data: { ...content, details: [] } }, REQUEST_ID)
  assert.equal(Object.hasOwn(emptyDetails.data, 'details'), false, 'details 为空数组时不该透传')

  // 到 store 也是「没收到这项信息」：轮次的初始态原样保留
  const state = applyChatEvent(stateWithTurn(), frame)
  assert.equal(state.turns[0].citationDegraded, null)
  assert.deepEqual(state.turns[0].citationDetails, [])
  assert.equal(state.turns[0].citations.length, 1, '正文引用照常收下（别把整条事件一起丢掉）')
})

test('分发：payload 按 kind 建卡，三种 kind 互不串台', () => {
  let state = stateWithTurn()
  for (const kind of ['animation', 'coding', 'quiz'] as const) {
    state = applyChatEvent(state, payloadEvent(REQUEST_ID, kind, { placeholder: true, tool: 'generate_animation' }))
  }
  assert.deepEqual(
    state.turns[0].cards.map((card) => card.kind),
    ['animation', 'coding', 'quiz']
  )
  assert.equal(state.turns[0].cards[0].tool, 'generate_animation')
  assert.equal(state.turns[0].cards[0].id, `${REQUEST_ID}#0`)
})

test('分发：未知 kind 被忽略（不建卡、不抛异常、计入 ignoredEvents）', () => {
  const state = applyChatEvent(stateWithTurn(), payloadEvent(REQUEST_ID, 'video', { anything: true }))
  assert.equal(state.turns[0].cards.length, 0)
  assert.equal(state.ignoredEvents, 1)
})

test('分发：blocked 撤回正文并换成 safeText，原文留在 retractedText 里', () => {
  let state = stateWithTurn()
  state = applyChatEvent(state, delta(REQUEST_ID, '一段不该出现的回答'))
  state = applyChatEvent(state, {
    name: 'blocked',
    data: { requestId: REQUEST_ID, reason: '示例原因', safeText: STUB_SAFE_TEXT }
  })

  assert.equal(state.turns[0].status, 'blocked')
  assert.equal(state.turns[0].text, STUB_SAFE_TEXT)
  assert.equal(state.turns[0].blocked?.retractedText, '一段不该出现的回答')
})

test('分发：blocked 缺 safeText 时用兜底文案（气泡不许变空）', () => {
  const state = applyChatEvent(stateWithTurn(), { name: 'blocked', data: { requestId: REQUEST_ID } })
  assert.equal(state.turns[0].status, 'blocked')
  assert.ok((state.turns[0].text ?? '').length > 0)
})

test('分发：done 收尾并记下 messageId；之后来的 delta 不再进入正文', () => {
  let state = stateWithTurn()
  state = applyChatEvent(state, delta(REQUEST_ID, '正文'))
  state = applyChatEvent(state, { name: 'done', data: { requestId: REQUEST_ID, messageId: 'msg-1' } })
  state = applyChatEvent(state, delta(REQUEST_ID, '（迟到的增量）'))

  assert.equal(state.turns[0].status, 'done')
  assert.equal(state.turns[0].messageId, 'msg-1')
  assert.equal(state.turns[0].text, '正文')
})

test('分发：done 缺 messageId 也要收尾（不能让 UI 卡在「正在回答」）', () => {
  const state = applyChatEvent(stateWithTurn(), { name: 'done', data: { requestId: REQUEST_ID } })
  assert.equal(state.turns[0].status, 'done')
  assert.equal(state.turns[0].messageId, null)
})

test('分发：error 展示可读降级提示，多行/超长文案被折叠截断（不出现堆栈形态）', () => {
  const stacky = `模型调用失败\n    at fetch (main.ts:1:1)\n    at run (agent.ts:2:2)\n${'x'.repeat(400)}`
  const state = applyChatEvent(stateWithTurn(), {
    name: 'error',
    data: { requestId: REQUEST_ID, message: stacky, degraded: true }
  })

  const notice = state.turns[0].error
  assert.ok(notice)
  assert.equal(notice?.degraded, true)
  assert.equal(notice?.message.includes('\n'), false)
  assert.ok((notice?.message.length ?? 0) <= 201)
})

test('分发：error 缺 message 时用兜底文案；缺 degraded 时按「降级」处理', () => {
  const state = applyChatEvent(stateWithTurn(), { name: 'error', data: { requestId: REQUEST_ID } })
  assert.equal(state.turns[0].error?.message, FALLBACK_ERROR_TEXT)
  assert.equal(state.turns[0].error?.degraded, true)
})

test('分发：未知事件名 / 非对象 / 缺 requestId 一律忽略且不抛异常', () => {
  let state = stateWithTurn()
  const before = state.turns[0].text

  for (const junk of [
    null,
    undefined,
    42,
    'delta',
    { name: 'delta' },
    { name: 'delta', data: null },
    { name: 'delta', data: { delta: '缺 requestId' } },
    { name: 'tool_call', data: { requestId: REQUEST_ID } },
    { name: 'delta', data: { requestId: REQUEST_ID, delta: '' } },
    { name: 'citation', data: { requestId: REQUEST_ID, citations: 'not-an-array' } }
  ]) {
    state = applyChatEvent(state, junk)
  }

  assert.equal(state.turns[0].text, before)
  assert.equal(state.turns[0].citations.length, 0)
  assert.equal(state.ignoredEvents, 10)
})

test('分发：乱序 requestId —— 事件先到则先缓冲，轮次建立时按序回放', () => {
  let state = emptyConversation()
  state = applyChatEvent(state, delta('turn_late', '先'))
  state = applyChatEvent(state, delta('turn_late', '到'))
  state = applyChatEvent(state, { name: 'done', data: { requestId: 'turn_late', messageId: 'msg-late' } })
  assert.equal(state.turns.length, 0, '轮次尚未建立时不该凭空造出学生消息')
  assert.ok(Object.keys(state.pending).length === 1, '事件应当被缓冲而不是丢掉')

  state = startTurn(state, 'turn_late', '迟到的提问')
  assert.equal(state.turns.length, 1)
  assert.equal(state.turns[0].text, '先到')
  assert.equal(state.turns[0].status, 'done')
  assert.equal(state.turns[0].messageId, 'msg-late')
  assert.deepEqual(Object.keys(state.pending), [])
})

test('分发：旧轮事件不得污染新轮（按 requestId 分派）', () => {
  let state = startTurn(emptyConversation(), 'turn_old', '旧问题')
  state = startTurn(state, 'turn_new', '新问题')
  state = applyChatEvent(state, { name: 'done', data: { requestId: 'turn_old', messageId: 'm-old' } })
  // 旧轮已终结，后续事件直接丢弃
  state = applyChatEvent(state, delta('turn_old', '（旧轮的迟到增量）'))
  state = applyChatEvent(state, delta('turn_new', '新答案'))

  assert.equal(state.turns[0].text, '')
  assert.equal(state.turns[0].status, 'done')
  assert.equal(state.turns[1].text, '新答案')
  assert.equal(state.turns[1].status, 'streaming')
})

test('分发：伪造的 requestId 洪水不会撑爆缓冲（有上限）', () => {
  let state = emptyConversation()
  for (let index = 0; index < 40; index += 1) {
    state = applyChatEvent(state, delta(`turn_flood_${index}`, 'x'))
  }
  assert.ok(Object.keys(state.pending).length <= 8, '缓冲的轮次数必须有上限')
})

test('归一化：认得出的事件字段齐全，认不出的返回 null', () => {
  assert.equal(normalizeIpcEvent(null), null)
  assert.equal(normalizeIpcEvent({ name: 'nope', data: { requestId: 'x' } }), null)
  assert.deepEqual(normalizeIpcEvent({ name: 'done', data: { requestId: 'x' } }), {
    name: 'done',
    data: { requestId: 'x', messageId: '' }
  })
})

test('订阅：只做回调转发，回调抛异常不外溢', () => {
  const received: IpcEvent[] = []
  let unsubscribeCalls = 0
  const source = {
    onChatEvent(listener: (event: IpcEvent) => void): () => void {
      listener(delta(REQUEST_ID, '甲'))
      return () => {
        unsubscribeCalls += 1
      }
    }
  }

  const unsubscribe = subscribeToChatEvents(source, (event) => {
    received.push(event)
    throw new Error('订阅者自己炸了')
  })

  assert.equal(received.length, 1, '异常不该阻止事件送达（这里先送达再抛）')
  unsubscribe()
  assert.equal(unsubscribeCalls, 1)
})

// ── 2. 假数据源的确定性事件序列 ──────────────────────────────────────────

test('假数据源：三条链条合起来覆盖 6 种事件名，普通提问以 delta 开头、以 done 收尾', () => {
  const allNames = new Set<IpcEvent['name']>()
  for (const text of ['人工智能怎么认猫？', `测试 ${BLOCKED_KEYWORD}`, `测试 ${ERROR_KEYWORD}`]) {
    for (const event of planStubTurn(text, REQUEST_ID)) allNames.add(event.name)
  }

  assert.deepEqual(
    [...allNames].sort(),
    ['blocked', 'citation', 'delta', 'done', 'error', 'payload'],
    '假数据源必须能把 6 种事件都造出来（UI 的每条分支都要可复现）'
  )

  const normal = planStubTurn('人工智能怎么认猫？', REQUEST_ID)
  assert.equal(normal[0].name, 'delta')
  assert.equal(normal.at(-1)?.name, 'done')
})

test('假数据源：触发词分别导向 blocked / error 链条', () => {
  assert.equal(detectStubScenario(`请帮我看看 ${BLOCKED_KEYWORD} 这条`), 'blocked')
  assert.equal(detectStubScenario(`请帮我看看 ${ERROR_KEYWORD} 这条`), 'error')
  assert.equal(detectStubScenario('随便问问'), 'chat')

  const blocked = planStubTurn(`测试 ${BLOCKED_KEYWORD}`, REQUEST_ID)
  assert.ok(blocked.some((event) => event.name === 'blocked'))
  assert.equal(blocked.some((event) => event.name === 'payload'), false)

  const errored = planStubTurn(`测试 ${ERROR_KEYWORD}`, REQUEST_ID)
  assert.ok(errored.some((event) => event.name === 'error'))
})

test('假数据源：delta 拼起来与回答正文逐字相等（1 字 1 事件）', () => {
  const userText = '什么是神经网络？'
  const plan = planStubTurn(userText, REQUEST_ID)
  const text = plan
    .filter((event): event is Extract<TurnEvent, { name: 'delta' }> => event.name === 'delta')
    .map((event) => event.data.delta)
    .join('')

  assert.equal(text, buildStubReply(userText))
  assert.ok(text.includes(userText), '回答必须原样回显学生的问题（端到端逐字比对的依据）')
})

test('假数据源：回声超长输入时截断，不会把整段粘贴原样发回来', () => {
  const long = '一'.repeat(200)
  const reply = buildStubReply(long)
  assert.ok(reply.length < long.length + 200)
  assert.ok(reply.includes('……'))
})

test('假数据源：三种 kind 齐全，且 kind 来自冻结映射表（不自己猜）', () => {
  const kinds = planStubTurn('练一练', REQUEST_ID)
    .filter((event): event is Extract<TurnEvent, { name: 'payload' }> => event.name === 'payload')
    .map((event) => event.data.kind)

  assert.deepEqual(kinds, ['animation', 'coding', 'quiz'])
  assert.deepEqual(
    STUB_PAYLOAD_TOOLS.map((tool) => kindForTool(tool)),
    ['animation', 'coding', 'quiz']
  )
})

test('假数据源：runStubTurn 经登记中心发出的事件都带同一个 requestId，并在结束后清干净', () => {
  const target = new FakeTarget(7)
  const registry = new ChatStreamRegistry({ generateRequestId: () => REQUEST_ID })
  const handle = registry.open(target, '你好')

  // 同步调度器：不需要等待，也就没有定时器需要收尾
  runStubTurn(handle, '你好', { schedule: (run) => run() })

  assert.ok(target.events.length > 10)
  assert.ok(target.events.every((event) => event.data.requestId === REQUEST_ID))
  assert.equal(target.events.at(-1)?.name, 'done')
  assert.equal(registry.activeTurns, 0, '本轮结束后不该留活跃轮次')
  assert.equal(registry.trackedTargets, 0, '本轮结束后不该留 destroyed 监听')
  assert.equal(target.listenerCount, 0)
})

// ── 3. 请求号生成 / 窗口销毁清理 ─────────────────────────────────────────

test('登记中心：请求号由主进程生成并统一注入（调用方拿不到「发错请求号」的机会）', () => {
  const target = new FakeTarget(1)
  const registry = new ChatStreamRegistry({ generateRequestId: () => `${REQUEST_ID}-a` })
  const handle = registry.open(target, '你好')

  handle.emit({ name: 'delta', data: { delta: '甲' } })
  handle.emit({ name: 'done', data: { messageId: 'm1' } })

  assert.equal(handle.requestId, `${REQUEST_ID}-a`)
  assert.deepEqual(target.events[0], { name: 'delta', data: { requestId: `${REQUEST_ID}-a`, delta: '甲' } })
  assert.deepEqual(target.events[1], { name: 'done', data: { requestId: `${REQUEST_ID}-a`, messageId: 'm1' } })
  assert.ok(REQUEST_ID_PREFIX.length > 0, '请求号前缀供日志/轨迹识别')
  assert.ok(REQUEST_ID.startsWith('turn_'))
})

test('登记中心：一个窗口开多轮只登记一次 destroyed 监听，全部结束即注销', () => {
  const target = new FakeTarget(3)
  let counter = 0
  const registry = new ChatStreamRegistry({ generateRequestId: () => `turn_${(counter += 1)}` })

  const first = registry.open(target, '第一轮')
  const second = registry.open(target, '第二轮')
  assert.equal(target.onDestroyedCalls, 1, '同一窗口的 destroyed 监听只该挂一次')
  assert.equal(registry.activeTurns, 2)

  first.finish()
  assert.equal(target.listenerCount, 1, '还有活跃轮次时监听保留')
  second.finish()
  assert.equal(target.offDestroyedCalls, 1)
  assert.equal(target.listenerCount, 0, '最后一个轮次结束时必须注销监听')
  assert.equal(registry.trackedTargets, 0)
})

test('登记中心：窗口销毁后事件被丢弃、不再 send，且登记被清空', () => {
  const target = new FakeTarget(5)
  const registry = new ChatStreamRegistry({ generateRequestId: () => REQUEST_ID })
  const handle = registry.open(target, '你好')

  handle.emit({ name: 'delta', data: { delta: '甲' } })
  assert.equal(target.events.length, 1)

  target.destroy()

  assert.equal(handle.emit({ name: 'delta', data: { delta: '乙' } }), false, '向已销毁窗口发事件必须被丢弃')
  assert.equal(target.events.length, 1, '销毁后不该再有 send')
  assert.equal(registry.activeTurns, 0)
  assert.equal(registry.trackedTargets, 0)
  assert.equal(registry.droppedEvents, 1)
  assert.equal(handle.active, false)
})

test('登记中心：已结束的轮次再发事件被丢弃（旧轮不污染新轮）', () => {
  const target = new FakeTarget(9)
  const registry = new ChatStreamRegistry({ generateRequestId: () => REQUEST_ID })
  const handle = registry.open(target, '你好')
  handle.finish()

  assert.equal(handle.emit({ name: 'delta', data: { delta: '迟到' } }), false)
  assert.equal(registry.droppedEvents, 1)
  assert.equal(target.events.length, 0)
})

// ── 4. chat:send 入参校验与冻结映射表 ────────────────────────────────────

test('入参校验：空串 / 非对象 / 超长都被挡住，且给出可读中文', () => {
  assert.equal(parseChatSendRequest(null).ok, false)
  assert.equal(parseChatSendRequest({ text: '   ' }).ok, false)
  assert.equal(parseChatSendRequest({ text: '一'.repeat(MAX_INPUT_CHARS + 1) }).ok, false)

  // ★ 请求里**不带学段**：学段由系统推断（D-020）。旧客户端塞进来的脏值
  //   （'college' / 'junior'）既不能进请求对象，也不能改变解析结果。
  const parsed = parseChatSendRequest({ text: '  你好  ', gradeLevel: 'junior' })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok ? parsed.request : null, { text: '你好' })

  for (const bad of [null, { text: '' }, { text: '一'.repeat(MAX_INPUT_CHARS + 1) }]) {
    const result = parseChatSendRequest(bad)
    assert.equal(result.ok, false)
    assert.ok(result.ok === false && result.message.length > 0)
  }
})

test('★ 入参校验：请求里携带的学段被彻底忽略（学段只能由系统推断，D-020）', () => {
  // 旧客户端/手工调用可能仍带 gradeLevel；它既不能进请求对象，也不能影响解析结果。
  const parsed = parseChatSendRequest({ text: '你好', gradeLevel: 'senior' })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok ? { ...parsed.request } : null, { text: '你好' })
})

test('冻结映射：8 个 Tool 在表内，rag_search / get_student_profile 不在表内', () => {
  assert.deepEqual([...PAYLOAD_TOOL_NAMES], [
    'generate_animation',
    'compose_animation',
    'get_code_template',
    'get_coding_hint',
    'evaluate_code',
    'generate_quiz',
    'submit_quiz',
    'generate_variants'
  ])

  assert.equal(kindForTool('generate_animation'), 'animation')
  // ★ 第二个动画 Tool 与第一个**同一个 kind**：产出的是同一种卡片（前端只有一条渲染分支），
  //   要区分是哪条路径看 `payload.tool`。守卫 G10 里也有这一条的字面量断言。
  assert.equal(kindForTool('compose_animation'), 'animation')
  assert.equal(kindForTool('get_code_template'), 'coding')
  assert.equal(kindForTool('get_coding_hint'), 'coding')
  assert.equal(kindForTool('evaluate_code'), 'coding')
  assert.equal(kindForTool('generate_quiz'), 'quiz')
  assert.equal(kindForTool('submit_quiz'), 'quiz')
  assert.equal(kindForTool('generate_variants'), 'quiz')

  // 这两个 Tool **不发** payload：画像只影响 Prompt，检索结果走 citation 事件
  assert.equal(kindForTool('get_student_profile'), null)
  assert.equal(kindForTool('rag_search'), null)
  assert.equal(kindForTool('invented_tool'), null)

  for (const [tool, kind] of Object.entries(TOOL_TO_KIND)) {
    assert.ok(['animation', 'coding', 'quiz'].includes(kind), `${tool} 的 kind 非法`)
  }
})

test('通道定义：chat 事件走推送通道，且 6 事件名不在通道名单里（词表在 shared）', () => {
  assert.ok(PUSH_CHANNELS.includes(IPC.chatEvent))
  assert.equal(PUSH_CHANNELS.includes(IPC.chatSend), false, 'chat:send 是 invoke 通道，不是推送通道')
  assert.equal(IPC.chatEvent, 'chat:event')
  assert.equal(IPC.chatSend, 'chat:send')
})

// ── 测试替身 ─────────────────────────────────────────────────────────────

/** 假的「目标窗口」：记录收到的事件与监听器，用来验证清理逻辑（不需要 electron）。 */
class FakeTarget implements StreamTarget {
  readonly id: number
  readonly events: IpcEvent[] = []
  onDestroyedCalls = 0
  offDestroyedCalls = 0
  private destroyed = false
  private readonly listeners = new Set<() => void>()

  constructor(id: number) {
    this.id = id
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(event: IpcEvent): void {
    this.events.push(event)
  }

  onDestroyed(listener: () => void): void {
    this.onDestroyedCalls += 1
    this.listeners.add(listener)
  }

  offDestroyed(listener: () => void): void {
    this.offDestroyedCalls += 1
    this.listeners.delete(listener)
  }

  /** 模拟窗口被销毁：置位并通知监听器。 */
  destroy(): void {
    this.destroyed = true
    for (const listener of [...this.listeners]) listener()
  }
}
