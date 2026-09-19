/**
 * 冷启动恢复：「关掉应用再打开，上一段对话还在」。
 *
 * ---------------------------------------------------------------------------
 * 为什么这是一个单独的文件
 * ---------------------------------------------------------------------------
 * 这是 `AGENTS.md` §10「演示前必做演练」里点名的那条验收（**重启后数据延续演练**），
 * 而它在本轮之前是**不达标**的：数据一直在盘上（Pi 每个会话写一个 JSONL），
 * 缺的只是「把它读回来铺进消息列表」这一步。
 *
 * 它与其他会话测试的**关键差别**：这里走的是 `session:state`（挂载时读一次），
 * 而不是 `session:open`（学生点列表）。两条路的分工与差异必须钉死：
 *
 *   | | `session:state`（冷启动） | `session:open`（点历史） |
 *   | --- | --- | --- |
 *   | 主进程做不做 | **会装配**（正文只有它手里有） | 会 dispose + 重装 |
 *   | 铺不铺历史 | 铺 | 铺 |
 *   | 发不发开场 | **不发**（那份历史里本来就有） | 空会话才发 |
 *
 * ★ 「冷启动不发开场」这一条很容易被"顺手统一"掉（两个回执同形，看着就该一样），
 *   所以下面有一条专门的断言钉着它 —— 发两次的后果是学生每次开应用都看到
 *   一句和昨天一模一样的招呼。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const read = (rel: string): string => readFileSync(join(DESKTOP, rel), 'utf8')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const HANDLERS = 'src/main/ipc/handlers.ts'

/* ------------------------------------------------------------------ *
 * 1. ★★ 主进程：冷启动恢复到**最近一条**会话
 * ------------------------------------------------------------------ */

test('★★ 冷启动默认续上最近一条（这是「重启后数据延续」的落点）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('export function sessionSourceForBoot(')
  assert.ok(at > 0, '找不到 sessionSourceForBoot')
  const body = source.slice(at, at + 600)
  assert.match(body, /'recent'/, '★ 默认必须是 recent（默认 new = 上一段对话从界面上消失）')
  assert.match(body, /'new'/, '要保留「强制新会话」那一档（自动化脚本与演练要用）')
})

test('★★ `session:state` 会**装配**会话（不装配就读不到恢复出来的正文）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('IPC.sessionState,')
  assert.ok(at > 0, '找不到 session:state 的处理器')
  const body = source.slice(at, at + 1400)
  assert.match(
    body,
    /await ensureChatRuntime\(\)/,
    '★★ 必须装配：恢复出来的正文只有主进程手里有 —— 不装配就回空，' +
      '学生看到的是「关掉应用再打开，上一段对话消失了」（数据其实还在盘上）'
  )
  assert.match(
    body,
    /restoredMessages/,
    '★ 必须把恢复出来的正文带上（`instance.restoredMessages`）'
  )
  // ★★ 冷启动**不发**开场：那份历史里本来就有当时发过的那一条
  assert.match(
    body,
    /opening:\s*''/,
    '★★ 冷启动必须回**空**开场：恢复出来的历史里已经有当时发过的那条，' +
      '再发一次就是「每次开应用都看到同一句招呼」'
  )
  // 装配失败不报错（没有 Key / 服务没起来时应用仍要能用）
  assert.match(body, /catch\s*\([\s\S]{0,300}ok:\s*false/, '装配失败必须回可读中文，不是抛异常')
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 渲染进程：挂载时把历史铺回消息列表
 * ------------------------------------------------------------------ */

function installBridge(state: Record<string, unknown>): void {
  const api = {
    getSessionState: () => Promise.resolve(state),
    openSession: () => ({ ok: false, message: '未接线' }),
    startNewSession: () => ({ ok: false, message: '未接线' }),
    branchSession: () => ({ ok: false, message: '未接线' }),
    onSessionChanged: () => () => {},
    onChatEvent: () => () => {},
    onGradeChanged: () => () => {},
    getGrade: () => Promise.resolve({ ok: false, message: '未接线' }),
    getChapter: () => Promise.resolve({ ok: false, message: '未接线' }),
    onChapterChanged: () => () => {},
    sendChat: () => Promise.resolve({ ok: false, requestId: null, message: '未接线' })
  }
  ;(globalThis as { window?: unknown }).window = { api }
}

/** 等一个宏任务轮次（挂载时的 `getSessionState()` 是 fire-and-forget）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('★★ 挂载后把上一段对话铺回消息列表（重启后对话还在）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installBridge({
      ok: true,
      current: { sessionId: 'sess-restored', title: '昨天那段', messageCount: 3 },
      messages: [
        { role: 'user', text: '昨天问的第一句', at: 1 },
        { role: 'assistant', text: '昨天答的', at: 2 },
        { role: 'user', text: '昨天问的第二句', at: 3 }
      ],
      opening: '',
      openingKpId: ''
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    chat.connect()
    await flush()

    // ★★ 三条消息 = **两轮**（问-答 配成一轮，最后那条学生消息单独一轮）——
    //   见 P-106：拆成三条各一轮会让界面出现「一半一半」的对话。
    assert.equal(chat.turns.length, 2, '★ 三条消息要配成两轮（问-答 + 单独的问）')
    assert.equal(chat.turns[0]?.userText, '昨天问的第一句')
    assert.equal(chat.turns[0]?.text, '昨天答的', '★ 回答必须和第 0 轮的学生问题在同一轮里')
    assert.equal(chat.turns[1]?.userText, '昨天问的第二句', '★ 第二个问题单独一轮（还没回答）')
    assert.equal(chat.currentSessionId, 'sess-restored', '当前会话 id 必须是恢复出来的那一条')
    assert.equal(
      chat.turns.every((turn) => turn.status === 'done'),
      true,
      '★ 恢复出来的历史消息不该是 streaming（那会让界面永远显示「正在回答」）'
    )
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 冷启动**不发**开场引导（那份历史里本来就有那条）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installBridge({
      ok: true,
      current: { sessionId: 'sess-restored', title: '', messageCount: 1 },
      messages: [{ role: 'assistant', text: '你好，我是团团。从循环开始吧。', at: 1 }],
      opening: '',
      openingKpId: ''
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.connect()
    await flush()

    assert.equal(chat.showOpening, false, '★ 冷启动不该再发一次开场')
    // 而当时发的那条**已经在历史消息里**（这是「只发一次」的真相：
    // 它写进了 Pi 会话，所以恢复出来就是一条普通的助手消息）
    assert.equal(chat.turns.length, 1, '开场引导那条 assistant 单独一轮')
    assert.match(chat.turns[0]?.text ?? '', /团团/)
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 首跑（一条会话都没有）：空对话，不报错', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installBridge({
      ok: true,
      current: { sessionId: '', title: '', messageCount: 0 },
      messages: [],
      opening: '',
      openingKpId: ''
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.connect()
    await flush()

    assert.deepEqual(chat.turns, [], '首跑就是空对话（这是正常的，不是错误）')
    assert.equal(chat.showOpening, false)
    assert.equal(chat.localNotice, null, '首跑不该弹任何提示')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 读取失败：保持空对话 + 不抛（没有 Key / 服务没起来时应用仍要能用）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installBridge({ ok: false, message: '对话运行时尚未就绪（缺 API Key）。' })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.connect()
    await flush()

    assert.deepEqual(chat.turns, [], '读不到就保持空对话')
    assert.equal(chat.showOpening, false)
    // ★ 这条路径**不许**抛（fire-and-forget 的 rejection 会变成 unhandled rejection）
    assert.equal(chat.bridgeReady, true, '订阅本身是成功的（失败的是那一次读）')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 恢复与「学生刚发出第一条」竞态：不许用历史覆盖他刚发的那轮', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    // 造一个**可控延迟**的回执：学生手快，在它回来之前就发了消息。
    // ⚠️ 必须写成 `let release!: ...`（明确赋值断言）：写成 `= null` 再在 executor 里
    //    赋值的话，TS 的控制流分析不知道那个赋值发生了，会把 `release` 收窄成 `never`
    //    —— 于是 `release?.(…)` 报「This expression is not callable」。
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const api = {
      getSessionState: () => pending,
      openSession: () => ({ ok: false, message: '未接线' }),
      startNewSession: () => ({ ok: false, message: '未接线' }),
      branchSession: () => ({ ok: false, message: '未接线' }),
      onSessionChanged: () => () => {},
      onChatEvent: () => () => {},
      onGradeChanged: () => () => {},
      getGrade: () => Promise.resolve({ ok: false, message: '未接线' }),
      getChapter: () => Promise.resolve({ ok: false, message: '未接线' }),
      onChapterChanged: () => () => {},
      sendChat: () => Promise.resolve({ ok: false, requestId: null, message: '未接线' })
    }
    ;(globalThis as { window?: unknown }).window = { api }
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    const { startTurn } = await import('../src/renderer/src/api/events.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.connect()
    // 学生先发了（历史还没回来）
    chat.conversation = startTurn(chat.conversation, 'turn-now', '我现在问的', null)
    assert.equal(chat.turns.length, 1)

    // 历史这时才回来
    release({
      ok: true,
      current: { sessionId: 'sess-restored', title: '', messageCount: 2 },
      messages: [
        { role: 'user', text: '很久以前问的', at: 1 },
        { role: 'assistant', text: '很久以前答的', at: 2 }
      ],
      opening: '',
      openingKpId: ''
    })
    await flush()

    assert.equal(chat.turns.length, 1, '★ 不许用历史覆盖学生刚发出的那一轮')
    assert.equal(chat.turns[0]?.userText, '我现在问的')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})
