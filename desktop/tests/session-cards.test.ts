/**
 * 会话回看时**卡片投影**的单测（A3）：把会话文件里 type='custom' / customType='k12.cards'
 * 的条目按 id 挂回它当时所在的那条助手消息上。
 *
 * ★ 为什么这些断言值得钉：
 *   · custom 条目是**只落盘、不进模型上下文**的旁路（Pi 的 appendCustomEntry）——
 *     一旦它被当成普通消息投影出来，回看里就会多出一条写满内部结构的假消息；
 *   · 挂载主判据是 entryId（写入口在 runtime.ts 的 persistTurnCards 里落的**助手条目 id**）：
 *     按顺序挂会漂 —— Pi 的条目流里混着 model_change / thinking_level_change，
 *     失败或被拦下的轮次也不留助手条目，「第几条」与「第几轮」对不上；
 *     requestId 只作排障溯源，**不参与挂载**（实现注释写死）；
 *   · 坏结构 / 认不出的 kind 必须**丢弃而不是抛出**：一条手改过或旧版本的会话文件
 *     不该让整个回看打不开（宁可少一张卡）。
 *
 * 全是纯函数（projectTranscript），不加载 Pi、不碰文件系统 —— 跑法与 session-reader.test.ts 一致。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { projectTranscript } from '../src/main/study/sessions.ts'

/** 一条 Pi 的 message 条目（只填投影关心的字段）。 */
function messageEntry(id: string, role: 'user' | 'assistant', text: string) {
  return {
    type: 'message',
    id,
    timestamp: '2026-09-30T01:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] }
  }
}

/** 一条 Pi 的 custom 条目（冻结契约形状：type / customType / data）。 */
function cardsEntry(data: unknown, id = 'cards-1') {
  return { type: 'custom', id, customType: 'k12.cards', data }
}

/** 投影挂上去的一张卡片（契约：kind + payload，原样透传）。 */
interface CardView {
  kind: string
  payload: unknown
}

/** 统一读法：没挂卡片的字段是 undefined，归一成空数组才好用 deepEqual 判。 */
function cardsOf(message: unknown): CardView[] {
  const value = (message as { cards?: unknown }).cards
  return Array.isArray(value) ? (value as CardView[]) : []
}

const QUIZ_CARD: CardView = { kind: 'quiz', payload: { tool: 'generate_quiz', qid: 'q-1' } }

/* ================================================================== *
 * ① custom 条目零可见消息 + 按 entryId 挂载
 * ================================================================== */

test('★ custom 条目本身不产生可见消息，卡片按 entryId 挂到点名的那条助手消息上', () => {
  const entries = [
    messageEntry('u1', 'user', '我想学循环结构'),
    messageEntry('a1', 'assistant', '好的，这是学习计划'),
    messageEntry('u2', 'user', '考考我'),
    messageEntry('a2', 'assistant', '这是三道题'),
    // ⚠️ 挂载点点名 a1，而这条 custom 条目**紧跟在 a2 后面** —— 用它区分「按 id」与「按位置」
    cardsEntry({ requestId: 'a2', entryId: 'a1', cards: [QUIZ_CARD] })
  ]
  const { messages, truncated } = projectTranscript(entries)
  assert.equal(truncated, 0)
  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    [
      ['user', '我想学循环结构'],
      ['assistant', '好的，这是学习计划'],
      ['user', '考考我'],
      ['assistant', '这是三道题']
    ],
    'custom 条目不许变成一条可见消息（它是旁路数据，不是对话内容）'
  )
  assert.deepEqual(
    cardsOf(messages[1]),
    [QUIZ_CARD],
    '卡片必须按 entryId 挂到 a1 —— 不是按位置挂到紧邻的 a2'
  )
  assert.deepEqual(cardsOf(messages[3]), [], '没被点名的那条助手消息不该被挂上任何东西')
})

test('★ entryId 缺省 / 认不出时，退回「该条目之前最近的一条助手消息」（位置兜底）', () => {
  // ① 写入口没记住 id（本轮 assistant 条目认不出）→ 位置兜底
  const noId = [
    messageEntry('a1', 'assistant', '第一条回答'),
    messageEntry('u1', 'user', '再问一句'),
    messageEntry('a2', 'assistant', '第二条回答'),
    cardsEntry({ requestId: 'r-1', cards: [QUIZ_CARD] })
  ]
  const first = projectTranscript(noId)
  assert.deepEqual(
    cardsOf(first.messages[2]),
    [QUIZ_CARD],
    '没有 entryId 时要挂到「该条目之前最近的一条助手消息」（a2）'
  )
  assert.deepEqual(cardsOf(first.messages[0]), [], '不许挂到更早的那条助手消息（a1）')

  // ② entryId 指向一条不存在的条目 → 同样退回位置兜底，而不是整批丢掉
  const unknownId = [
    messageEntry('a1', 'assistant', '唯一的回答'),
    cardsEntry({ entryId: 'does-not-exist', cards: [QUIZ_CARD] })
  ]
  const second = projectTranscript(unknownId)
  assert.deepEqual(
    cardsOf(second.messages[0]),
    [QUIZ_CARD],
    'entryId 在本次投影里找不到时退回位置兜底（诚实的位置判据，不是静默丢卡）'
  )
})

test('★ 位置兜底只认助手消息：最近一条是用户消息时整批丢弃', () => {
  // 最近一条是 user（助手条目还没落盘：本轮失败 / 被拦下）
  const afterUser = projectTranscript([
    messageEntry('u1', 'user', '考考我'),
    cardsEntry({ cards: [QUIZ_CARD] })
  ])
  assert.equal(afterUser.messages.length, 1, 'custom 条目仍不许变成可见消息')
  assert.deepEqual(cardsOf(afterUser.messages[0]), [], '卡片不许挂到用户消息上')

  // 没有任何前置消息（文件开头就是卡片条目）
  const atHead = projectTranscript([cardsEntry({ cards: [QUIZ_CARD] })])
  assert.deepEqual(atHead.messages, [], '开头没有助手消息时，卡片无处可挂 —— 丢弃而不是造一条空消息')
})

test('★ 同一条助手消息收到多批卡片时合并（分次写入不互相覆盖）', () => {
  const c2: CardView = { kind: 'animation', payload: { template: 'loop' } }
  const entries = [
    messageEntry('a1', 'assistant', '这是回答'),
    cardsEntry({ entryId: 'a1', cards: [QUIZ_CARD] }, 'ce-1'),
    cardsEntry({ entryId: 'a1', cards: [c2] }, 'ce-2')
  ]
  const { messages } = projectTranscript(entries)
  assert.deepEqual(
    cardsOf(messages[0]),
    [QUIZ_CARD, c2],
    '两批卡片都要留着（后一批覆盖前一批会让第一张卡凭空消失）'
  )
})

/* ================================================================== *
 * ② 坏结构 / 未知 kind：丢弃而不是抛出
 * ================================================================== */

test('★ 认不出的 kind 与结构不全的卡片被逐张丢弃，好的那张照常挂上', () => {
  const entries = [
    messageEntry('a1', 'assistant', '这是三道题'),
    cardsEntry({
      entryId: 'a1',
      cards: [
        { kind: 'quiz', payload: { q: 1 } },
        { kind: 'nope', payload: { q: 2 } },
        { kind: 'coding' }
      ]
    })
  ]
  const { messages } = projectTranscript(entries)
  assert.deepEqual(
    cardsOf(messages[0]),
    [{ kind: 'quiz', payload: { q: 1 } }],
    '只留「kind 在白名单里且 payload 是对象」的卡片：未知 kind 与缺 payload 的一律丢掉（宁可少一张）'
  )
})

test('★ 坏条目一律丢弃且不抛（手改过的会话文件不该让回看打不开）', () => {
  const bad: unknown[] = [
    null,
    'nope',
    { type: 'custom', id: 'c0' },
    { type: 'custom', id: 'c1', customType: 'other', data: { entryId: 'a1', cards: [QUIZ_CARD] } },
    cardsEntry(null, 'c2'),
    cardsEntry({}, 'c3'),
    cardsEntry({ entryId: 'a1', cards: 'not-array' }, 'c4'),
    cardsEntry({ entryId: 'a1', cards: [null, 7, {}] }, 'c5'),
    cardsEntry({ entryId: 'a1', cards: [{ kind: 'nope', payload: { q: 3 } }] }, 'c6'),
    { type: 'message', id: 'a1', message: { role: 'assistant', content: '回答' } },
    messageEntry('u1', 'user', '问题')
  ]
  let projected: ReturnType<typeof projectTranscript> | undefined
  assert.doesNotThrow(() => {
    projected = projectTranscript(bad)
  }, '坏结构必须被跳过，不许把异常抛给调用方')
  const messages = projected!.messages
  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    [
      ['assistant', '回答'],
      ['user', '问题']
    ],
    '只有合法的 message 条目能成为可见消息'
  )
  assert.deepEqual(cardsOf(messages[0]), [], '坏卡片条目一张都不许挂上去')
})

/* ================================================================== *
 * ③ 回归：没有卡片条目时与从前完全一致
 * ================================================================== */

test('★ 回归：没有卡片条目时，投影出的消息与从前逐字一致', () => {
  const entries = [messageEntry('u1', 'user', '问题'), messageEntry('a1', 'assistant', '回答')]
  const { messages, truncated } = projectTranscript(entries)
  assert.equal(truncated, 0)
  assert.deepEqual(
    messages.map((message) => [message.role, message.text, message.entryId, message.entryType]),
    [
      ['user', '问题', 'u1', 'message'],
      ['assistant', '回答', 'a1', 'message']
    ],
    '没有卡片条目时，投影结果与改造前逐字一致（回归）'
  )
  assert.deepEqual(cardsOf(messages[0]), [], '没有卡片条目时消息不带卡片')
  assert.deepEqual(cardsOf(messages[1]), [], '没有卡片条目时消息不带卡片')
})
