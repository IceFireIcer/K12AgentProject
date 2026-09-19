/**
 * 会话分叉（「从这里重新问」）—— `architecture/pending/03-会话保存与恢复.md` §3.6。
 *
 * ---------------------------------------------------------------------------
 * 这个功能要保证的**唯一**一件事
 * ---------------------------------------------------------------------------
 * **原会话一个字节都不动。** 学生点「从这里重新问」时的心态是
 * 「我想换个问法再看看」，不是「我要改写刚才那段」——
 * 所以分叉是**复制**（新文件 + `parentSession` 指回去），不是**回退**。
 * 一旦哪次实现变成「把当前会话倒回去重写」，学生就**永久丢掉**了原来那条线，
 * 而他并没有要求过这件事。下面每一条断言都围绕这一条展开。
 *
 * 另外两条同样重要、但属于「安全」而不是「体验」：
 *   ② `entryId` 必须**属于那条会话**（否则跨会话分叉 = 读到别人的对话）；
 *   ③ 分叉失败时**当前会话毫发无损**（先分叉、后 dispose，顺序反了就是灾难）。
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
      if (specifier.startsWith('.') && !/[a-z]+\.[a-z]+$/i.test(specifier)) {
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
const RUNTIME = 'src/main/agent/runtime.ts'
const CHAT_MESSAGE = 'src/renderer/src/components/ChatMessage.vue'
const CHAT_STORE = 'src/renderer/src/stores/chat.ts'
const SESSION_LIST = 'src/renderer/src/components/SessionList.vue'

/* ------------------------------------------------------------------ *
 * 1. ★★ 纯函数：分叉点的投影与「谁从谁分出来」
 * ------------------------------------------------------------------ */

test('★★ 消息投影必须带**条目 id**（分叉点不能靠「第几条」定位）', async () => {
  const { projectTranscript } = await import('../src/main/study/sessions.ts')
  const entries = [
    { type: 'session', id: 'head' },
    { type: 'model_change', id: 'mc1', timestamp: '2026-09-19T00:00:00.000Z' },
    {
      type: 'message',
      id: 'e-user-1',
      timestamp: '2026-09-19T00:00:01.000Z',
      message: { role: 'user', content: '第一句' }
    },
    {
      type: 'message',
      id: 'e-ai-1',
      timestamp: '2026-09-19T00:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '第一条回答' }] }
    }
  ]
  const { messages } = projectTranscript(entries)
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.entryId, 'e-user-1', '★ 学生那条消息要带自己的条目 id')
  assert.equal(messages[1]?.entryId, 'e-ai-1', '★ 助手那条也要')
  assert.equal(messages[1]?.entryType, 'message')

  // ★★ 反向对照：id 取自**文件里的条目**，不是「第几条可显示消息」的序号 ——
  //    `model_change` 也在文件里占位置，用序号会让「第 0 条」指向它（分叉到非对话条目上）。
  assert.notEqual(messages[0]?.entryId, '0')
  assert.notEqual(messages[1]?.entryId, '1')
})

test('★ 认不出 id 的条目给空串（界面据此不给分叉按钮，而不是拿 undefined 去问 Pi）', async () => {
  const { projectTranscript } = await import('../src/main/study/sessions.ts')
  const { messages } = projectTranscript([
    {
      type: 'message',
      // 没有 id（老会话 / 手改过的文件）
      timestamp: '2026-09-19T00:00:01.000Z',
      message: { role: 'user', content: '老格式的消息' }
    }
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.entryId, '', '★ 缺 id 时是空串（不是 undefined、不是编一个）')
})

test('★★ 会话树：`parentSessionPath` 解析成「从哪条分出来的」', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  const pathToId = new Map([
    ['/sessions/old.jsonl', 'sess-old'],
    ['/sessions/new.jsonl', 'sess-new']
  ])
  const tree = projectSessionTree(
    [
      {
        id: 'sess-old',
        title: '原来那段',
        messageCount: 8,
        modifiedAt: 100
      },
      {
        id: 'sess-new',
        title: '换个问法',
        messageCount: 4,
        modifiedAt: 200,
        parentPath: '/sessions/old.jsonl'
      }
    ],
    pathToId
  )
  const branch = tree.find((item) => item.id === 'sess-new')
  assert.equal(branch?.parentId, 'sess-old', '★ 分支要认出父会话')
  assert.equal(branch?.parentTitle, '原来那段', '★ 带上父标题（界面直接显示，不再反查）')
  assert.equal(branch?.branchedAtMessage, null, '不知道就说不知道（宁缺勿假）')
  // 独立会话不该被当成分支
  assert.equal(tree.find((item) => item.id === 'sess-old')?.parentId, null)
})

test('★★ 父会话**不在列表里**时不声称有父（否则界面给一个点不开的「来自…」）', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  const tree = projectSessionTree(
    [
      {
        id: 'sess-orphan',
        title: '父被删掉的分支',
        messageCount: 2,
        modifiedAt: 300,
        // 指向一个**不在本批列表里**的父（父已被删 / 被清理）
        parentPath: '/sessions/gone.jsonl'
      }
    ],
    new Map()
  )
  assert.equal(tree[0]?.parentId, null, '★ 父不在列表里就不能声称有父')
  assert.equal(tree[0]?.parentTitle, null)
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 主进程：三道闸门
 * ------------------------------------------------------------------ */

test('★★ 分叉**不 dispose 当前会话**（顺序：先分叉、再装配；反了就是灾难）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function branchFromMessage(')
  assert.ok(at > 0, '找不到 branchFromMessage')
  const body = source.slice(at, at + 3400)

  const branchAt = body.indexOf('instance.branchFrom(')
  const swapAt = body.indexOf('swapToSession(')
  assert.ok(branchAt > 0, '必须调 runtime 的 branchFrom')
  assert.ok(swapAt > 0, '分叉之后要装配新会话')
  assert.ok(
    branchAt < swapAt,
    '★★ 必须**先分叉、后装配**：分叉只是写一个新文件，失败时当前会话毫发无损；' +
      '先 dispose 再分叉的话，一次失败会让学生连当前对话都没了'
  )
  // 分叉本身**不许**自己 dispose
  assert.doesNotMatch(
    body.slice(0, swapAt),
    /disposeChatRuntime\(\)/,
    '★ 分叉那一步不许 dispose（dispose 是 swapToSession 的职责，它自己会做）'
  )
})

test('★★ 分叉前必须校验 `entryId` 属于那条会话（否则能跨会话分叉）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function branchFromMessage(')
  const body = source.slice(at, at + 3400)

  // ① 会话白名单对齐（只认 id）
  assert.match(body, /findSessionById\(/, '★ 必须先按 id 在会话白名单里对齐')
  // ② ★★ 条目归属校验：读回那条会话的条目、确认 entryId 在里面
  assert.match(
    body,
    /readStudentSessionEntries\(/,
    '★★ 必须把那条会话的条目读回来核对 —— `createBranchedSession(leafId)` 只认 id、' +
      '不认它属于谁，不核对就是「可以拿 B 会话的 id 去分叉 A」'
  )
  assert.match(body, /belongs/, '核对要有结论变量（不是「读了但没判」）')
  // ③ 校验失败必须**在**分叉之前
  const belongsAt = body.indexOf('if (!belongs)')
  const branchAt = body.indexOf('instance.branchFrom(')
  assert.ok(belongsAt > 0 && belongsAt < branchAt, '★ 校验必须在分叉之前（否则校验没有意义）')
})

test('★ 分叉的入参逐字段收窄成字符串（对象 / 数字进不来）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('IPC.sessionBranch,')
  assert.ok(at > 0, '找不到 session:branch 的处理器')
  const body = source.slice(at, at + 600)
  assert.match(body, /typeof request\?\.sessionId === 'string'/, '★ sessionId 只认字符串')
  assert.match(body, /typeof request\?\.entryId === 'string'/, '★ entryId 只认字符串')
})

test('★★ 分叉走 Pi 的 `createBranchedSession`，且不接管分支关系（Pi 记的）', () => {
  const source = stripComments(read(RUNTIME))
  const at = source.indexOf('async branchFrom(entryId: string)')
  assert.ok(at > 0, '找不到 branchFrom 的实现')
  const body = source.slice(at, at + 2400)

  assert.match(body, /createBranchedSession\(/, '★ 用 Pi 的分叉 API（不要自己拼 JSONL）')
  // ★ 反向对照：不许自己写文件 / 自己维护分支关系
  assert.doesNotMatch(
    body,
    /writeFileSync|appendFileSync/,
    '★ 不许自己写 JSONL：「分支关系由 Pi 记录」这条是本功能的地基'
  )
  // Pi 的英文错误要翻成中文（学生看得见）
  assert.match(body, /catch\s*\(/, '★ 必须兜住 Pi 的 `Entry xxx not found` 并翻成中文')
  assert.match(body, /找不到那条消息/, '错误文案要说清是哪件事不对')
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 界面：按钮的位置与可见条件
 * ------------------------------------------------------------------ */

test('★★ 「从这里重新问」挂在**助手消息**的正文之后（不是页面级按钮）', () => {
  const source = read(CHAT_MESSAGE)
  const btnAt = source.indexOf('data-testid="branch-restart"')
  assert.ok(btnAt > 0, 'ChatMessage 里没有分叉按钮')
  // 它必须在「助手回答」那一列里（`ai-col` 之后），而不是学生气泡里
  const aiColAt = source.indexOf('class="ai-col"')
  assert.ok(aiColAt > 0, '找不到 ai-col')
  assert.ok(aiColAt < btnAt, '★ 分叉按钮必须在助手回答那一列里（学生问的是「他这条答得不对」）')
})

test('★★ 流式中 / 没有条目 id 时**不给**分叉按钮', () => {
  const source = stripComments(read(CHAT_MESSAGE))
  const at = source.indexOf('const branchable = computed(')
  assert.ok(at > 0, '找不到 branchable')
  const body = source.slice(at, at + 400)

  assert.match(
    body,
    /status === 'streaming'[\s\S]{0,80}return false/,
    '★ 流式途中不给按钮：分支点不该是半句话（学生拿到的是没写完的回答）'
  )
  assert.match(
    body,
    /!props\.turn\.entryId[\s\S]{0,60}return false/,
    '★ 没有条目 id 时不给按钮（老会话 / 认不出条目）—— 宁可不给，也不要给一个点了就报错的'
  )
})

test('★★ 学生那条消息的条目 id 也要留下来（换个问法 = 从我这句话重来）', async () => {
  const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
  const state = restoreConversation(
    [
      { role: 'user', text: '我的问题', at: 1, entryId: 'e-user' },
      { role: 'assistant', text: '他的回答', at: 2, entryId: 'e-ai' }
    ],
    null
  )
  // ★★ 一问一答 = 一轮，两个条目 id 各占一个字段（见 P-106）
  assert.equal(state.turns.length, 1, '一问一答 = 一轮')
  assert.equal(state.turns[0]?.userEntryId, 'e-user', '★ 学生那句话的条目 id 要留着')
  assert.equal(state.turns[0]?.entryId, 'e-ai', '★ 助手那条的也要留着（同一轮里）')
  assert.equal(state.turns[0]?.userText, '我的问题', '★ 配对不能把学生问题丢掉')
  assert.equal(state.turns[0]?.text, '他的回答')
})

test('★★ 分叉前必须确认（界面会切到另一条线，学生要知道原来那条不会丢）', () => {
  const source = stripComments(read(CHAT_STORE))
  const storeAt = source.indexOf('async function branchSession(')
  assert.ok(storeAt > 0, '找不到 store 的 branchSession')
  const storeBody = source.slice(storeAt, storeAt + 1200)
  assert.match(
    storeBody,
    /currentSessionId\.value/,
    '★ 没有当前会话时分叉没有意义（分叉点是「本条会话里的某条消息」）'
  )
  assert.match(storeBody, /entryId/, '入参是条目 id')

  // 确认弹窗在视图层（store 不该弹窗）
  const view = readFileSync(
    join(DESKTOP, 'src', 'renderer', 'src', 'views', 'Chat.vue'),
    'utf8'
  )
  const at = view.indexOf('async function onBranch(')
  assert.ok(at > 0, '找不到 onBranch')
  const body = view.slice(at, at + 1400)
  assert.match(body, /confirm\.ask\(/, '★ 必须先确认（「屏幕上的对话忽然换了一段」足够让人困惑）')
  assert.match(body, /不会丢/, '★ 确认文案要明说原对话不会丢 —— 那正是学生最担心的事')
})

/* ------------------------------------------------------------------ *
 * 4. ★★ 侧栏：分支标记
 * ------------------------------------------------------------------ */

test('★★ 侧栏标出「来自〈父会话〉」，且**父不在时不给**这个标记', () => {
  const source = read(SESSION_LIST)
  const at = source.indexOf('data-testid="session-branch-mark"')
  assert.ok(at > 0, '侧栏没有分支标记')
  const before = source.slice(Math.max(0, at - 300), at)
  assert.match(
    before,
    /v-if="item\.parentId"/,
    '★ 标记必须由 `parentId` 门禁 —— 主进程那边已经核过「父还在不在列表里」，' +
      '父被删掉之后仍显示「来自…」等于给一个点不开的入口'
  )
  assert.match(before + source.slice(at, at + 400), /parentTitle/, '★ 要显示父的标题（学生认的是标题不是 id）')
})

/* ------------------------------------------------------------------ *
 * 5. ★★ 行为面：真的跑一遍 store
 * ------------------------------------------------------------------ */

function installBridge(overrides: Record<string, (...args: unknown[]) => unknown> = {}): {
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record =
    (method: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args })
      return impl(...args)
    }
  const defaults: Record<string, (...args: unknown[]) => unknown> = {
    // ⚠️ 必须是 **Promise**：`connectSession()` 是 fire-and-forget 的 `.then(...)`，
    //   返回裸对象会抛 `getSessionState(...).then is not a function`
    //   （实测踩到两次，两次的报错都与被测的东西无关）。
    getSessionState: () =>
      Promise.resolve({
        ok: true,
        current: { sessionId: 'sess-current', title: '当前这段', messageCount: 4 },
        messages: [],
        opening: '',
        openingKpId: ''
      }),
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
  const api: Record<string, unknown> = {}
  for (const [name, impl] of Object.entries({ ...defaults, ...overrides })) {
    api[name] = record(name, impl)
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return { calls }
}

test('★★ 分叉：真的调了 `branchSession`，并带上**当前会话 id + 那条条目 id**', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    const { calls } = installBridge({
      branchSession: () => {
        return {
          ok: true,
          current: { sessionId: 'sess-branched', title: '', messageCount: 3 },
          messages: [
            { role: 'user', text: '第一句', at: 1, entryId: 'e1' },
            { role: 'assistant', text: '第一条回答', at: 2, entryId: 'e2' },
            { role: 'user', text: '换个问法', at: 3, entryId: 'e3' }
          ],
          opening: '',
          openingKpId: ''
        }
      }
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    await chat.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(chat.currentSessionId, 'sess-current', '先确认拿到了当前会话')

    const result = await chat.branchSession('e2')
    assert.equal(result.ok, true, JSON.stringify(result))

    const call = calls.find((entry) => entry.method === 'branchSession')
    assert.ok(call, '★ 必须真的调了 bridge.branchSession')
    assert.deepEqual(
      call.args[0],
      { sessionId: 'sess-current', entryId: 'e2' },
      '★★ 必须带当前会话 id（主进程据此核对条目归属）+ 那条消息的条目 id'
    )
    // 分叉成功后消息列表整段换成新会话的（与切换会话同一套落库）
    // ★ 三条消息 = 两轮（问-答 + 单独的问），见 P-106
    assert.equal(chat.turns.length, 2)
    assert.equal(chat.currentSessionId, 'sess-branched')
    assert.equal(
      chat.turns[0]?.entryId,
      'e2',
      '★ 新会话里的回答也要带条目 id（否则在新线上没法再分叉一次）'
    )
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 分叉失败：**不动**当前对话（原对话必须毫发无损）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installBridge({
      branchSession: () => ({ ok: false, message: '那条消息不属于这条会话。' })
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    // ★ 必须 connect：`currentSessionId` 由主进程给（`getSessionState`）——
    //   没有它的话 store 会在「当前没有进行中的对话」那道闸门就返回，
    //   根本走不到我们要测的「分叉失败」那条路（实测踩到过：断言看错了失败原因）。
    await chat.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(chat.currentSessionId, 'sess-current', '先确认拿到了当前会话')
    chat.conversation = restoreConversation([{ role: 'user', text: '正在聊的', at: 9 }])

    const result = await chat.branchSession('e-nope')
    assert.equal(result.ok, false)
    assert.equal(result.message, '那条消息不属于这条会话。', '失败原因原样带给界面（可读中文）')
    assert.equal(chat.turns.length, 1, '★★ 失败时当前对话必须原样保留')
    assert.equal(chat.turns[0]?.userText, '正在聊的')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 没有当前会话时不发分叉请求（分叉点必须是「本条会话里的某条消息」）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    const { calls } = installBridge()
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    // 故意不 connect：currentSessionId 还是空串
    const result = await chat.branchSession('e1')
    assert.equal(result.ok, false)
    assert.match(String(result.message), /没有进行中的对话/)
    assert.equal(
      calls.filter((entry) => entry.method === 'branchSession').length,
      0,
      '★ 不许发出这次请求（主进程那边也不需要处理这种形态）'
    )
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 空条目 id 当场拒（不发请求）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    const { calls } = installBridge()
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    const result = await chat.branchSession('')
    assert.equal(result.ok, false)
    assert.equal(calls.filter((entry) => entry.method === 'branchSession').length, 0)
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})


/* ------------------------------------------------------------------ *

/* ------------------------------------------------------------------ *
 * 6. 面向学生的文案不许带裸 Markdown 标记
 * ------------------------------------------------------------------ */

test('确认框 / 提示文案里不许出现裸星号标记（它是纯文本，不解析 Markdown）', () => {
  // 缺陷形态（实测两次，见 P-104）：ConfirmDialog 的 body 走插值渲染，
  // **不解析 Markdown** —— 写两个星号包住的词会原样显示成星号
  // （实测截图里就是「复制成两个星号包住的一条新的对话线」）。
  // 与 P-076（模型输出里的星号直接露给学生）同一类问题：
  // 把标记当成了强调手段，而渲染层不认。
  //
  // 判据：面向学生的**字符串字面量**里不许出现双星号；注释里的不算
  // （本项目注释风格大量使用双星号做强调）。
  const files = [CHAT_MESSAGE, SESSION_LIST, "src/renderer/src/views/Chat.vue"]
  const mark = String.fromCharCode(42) + String.fromCharCode(42)
  const offenders: string[] = []
  for (const rel of files) {
    for (const raw of read(rel).split(String.fromCharCode(10))) {
      const line = raw.trim()
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue
      const single = line.match(/'([^']*)'/g) ?? []
      for (const literal of single) {
        if (literal.includes(mark)) offenders.push(rel + " -> " + literal.slice(0, 70))
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "面向学生的文案里出现裸星号标记（渲染层不解析 Markdown，会原样显示）：" +
      String.fromCharCode(10) + offenders.join(String.fromCharCode(10))
  )
})

/* ------------------------------------------------------------------ *
 * 7. 实时轮次也要有分叉点（P-105：按钮只对历史消息出现的缺陷）
 * ------------------------------------------------------------------ */

test('实时轮次也能分叉：主进程每轮推 turn:entries，store 把它落到那一轮上', async () => {
  // 缺陷形态（实测抓到的 P-105）：`entryId` 原先**只**由「恢复历史」那条路填
  // （`restoreConversation` 从投影里带），而实时聊出来的轮次一个 id 都没有 ——
  // 于是「从这里重新问」按钮**只对历史消息出现**，对刚读完的那条回答不出现。
  // 而那恰恰是这个按钮最主要的用法。
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    // ⚠️ 用 `let x!: T`（明确赋值断言）而不是 `= null`：赋值发生在订阅回调**内部**，
    //   TS 的控制流分析看不到它，于是 `= null` 的写法会在调用处报
    //   「possibly null / not callable」（实测踩到）。之后用 `push(...)` 包装一次。
    let pushEntries!: (payload: unknown) => void
    const api = {
      getSessionState: () => Promise.resolve({ ok: true, current: { sessionId: 's1', title: '', messageCount: 0 }, messages: [], opening: '', openingKpId: '' }),
      openSession: () => Promise.resolve({ ok: false, message: 'x' }),
      startNewSession: () => Promise.resolve({ ok: false, message: 'x' }),
      branchSession: () => Promise.resolve({ ok: false, message: 'x' }),
      onSessionChanged: () => () => {},
      // 捕获订阅回调：测试里手动触发它，模拟主进程推送
      onTurnEntries: (listener: (payload: unknown) => void) => { pushEntries = listener; return () => {} },
      onChatEvent: () => () => {},
      onGradeChanged: () => () => {},
      getGrade: () => Promise.resolve({ ok: false, message: 'x' }),
      getChapter: () => Promise.resolve({ ok: false, message: 'x' }),
      onChapterChanged: () => () => {},
      sendChat: () => Promise.resolve({ ok: true, requestId: 'turn-live', message: null })
    }
    ;(globalThis as { window?: unknown }).window = { api }
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(typeof pushEntries, 'function', '必须订阅了 onTurnEntries')

    // 学生发一轮（尚未拿到条目 id）
    await chat.send('我的问题')
    assert.equal(chat.turns.length, 1)
    assert.equal(chat.turns[0]?.entryId, null, '还没推送时是 null（按钮不显示）')

    // 主进程在本轮结束时推条目 id
    pushEntries({ requestId: 'turn-live', userEntryId: 'e-user', entryId: 'e-ai' })  // eslint-disable-line
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(chat.turns[0]?.entryId, 'e-ai', '★ 实时轮次也要拿到回答那条的条目 id')
    assert.equal(chat.turns[0]?.userEntryId, 'e-user', '★ 学生那句话的也要')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 条目 id 超前到达时要缓冲（否则那一轮永远没有分叉按钮）', async () => {
  // 与 6 事件的「超前到达」同一个竞态：主进程的推送可能**早于**
  // `sendChat` 的回执（渲染进程是在回执里才建轮的）。不缓冲的话，
  // 快的那条推送被丢掉 —— 表现与「这轮本来就取不到条目」一模一样（最难查的那种）。
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    // ⚠️ 用 `let x!: T`（明确赋值断言）而不是 `= null`：赋值发生在订阅回调**内部**，
    //   TS 的控制流分析看不到它，于是 `= null` 的写法会在调用处报
    //   「possibly null / not callable」（实测踩到）。之后用 `push(...)` 包装一次。
    let pushEntries!: (payload: unknown) => void
    let resolveSend!: (value: unknown) => void
    const pendingSend = new Promise((resolve) => { resolveSend = resolve })
    const api = {
      getSessionState: () => Promise.resolve({ ok: true, current: { sessionId: 's1', title: '', messageCount: 0 }, messages: [], opening: '', openingKpId: '' }),
      openSession: () => Promise.resolve({ ok: false, message: 'x' }),
      startNewSession: () => Promise.resolve({ ok: false, message: 'x' }),
      branchSession: () => Promise.resolve({ ok: false, message: 'x' }),
      onSessionChanged: () => () => {},
      onTurnEntries: (listener: (payload: unknown) => void) => { pushEntries = listener; return () => {} },
      onChatEvent: () => () => {},
      onGradeChanged: () => () => {},
      getGrade: () => Promise.resolve({ ok: false, message: 'x' }),
      getChapter: () => Promise.resolve({ ok: false, message: 'x' }),
      onChapterChanged: () => () => {},
      // 回执**延迟**：模拟「推送先到、回执后到」
      sendChat: () => pendingSend
    }
    ;(globalThis as { window?: unknown }).window = { api }
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const sending = chat.send('抢先说的话')
    // 推送**先**到（此时轮次还没建）
    pushEntries({ requestId: 'turn-early', userEntryId: 'e-user', entryId: 'e-ai' })
    assert.equal(chat.turns.length, 0, '回执还没回来，轮次尚未建立')
    // 回执这才回来
    resolveSend({ ok: true, requestId: 'turn-early', message: null })
    await sending

    assert.equal(chat.turns.length, 1)
    assert.equal(chat.turns[0]?.entryId, 'e-ai', '★★ 超前到达的条目 id 必须被补上（否则按钮永不出现）')
    assert.equal(chat.turns[0]?.userEntryId, 'e-user')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 主进程每轮结束都要推 turn:entries（否则实时轮次永远没有分叉按钮）', () => {
  // ⚠️ 这条是**源码级**的：上面两条行为面测试用的是假 bridge（它们只证明
  //   store 收到推送后能正确落库），**证明不了主进程真的推了**。
  //   变异验证踩到过：把 `pushTurnEntries(...)` 改成 `void entries` 之后，
  //   那两条行为面测试仍然全绿 —— 因为它们从来没经过主进程。
  const source = stripComments(read(HANDLERS))
  assert.match(
    source,
    /pushTurnEntries\(handle\.requestId, entries\)/,
    '★★ 每轮结束必须推本轮条目 id —— 不推的话「从这里重新问」只对历史消息出现'
  )
  const at = source.indexOf('async function runChatTurn(')
  assert.ok(at > 0, '找不到 runChatTurn')
  const body = source.slice(at, at + 4000)
  assert.match(body, /lastTurnEntries\(\)/, '取值点必须在**本轮结束之后**（那两条条目刚追加进去）')
  // ⚠️ 不许经 6 事件的 emit（词表被 G4 冻结为恰好 6 个）
  assert.doesNotMatch(
    body,
    /handle\.emit\(\{[\s\S]{0,80}turnEntries/,
    '★ 不许把 turn:entries 塞进 6 事件（词表冻结；硬塞会让每个消费方都要理解一个它不关心的字段）'
  )
})

/* ------------------------------------------------------------------ *
 * 8. ★★ 恢复历史必须**配成轮次**（P-106：一半一半的对话）
 * ------------------------------------------------------------------ */

test('★★ 一问一答配成一轮；连续两问各自一轮（不丢问题、不造空轮）', async () => {
  // 缺陷形态（实测 + UX 体检 D7 抓到，见 P-106）：初版把每条消息各当成一轮，
  // 于是恢复出来的对话在界面上长成
  //   [我的问题] ← 一轮：学生气泡 + **一个空的回答块**
  //   [（空）][他的回答] ← 另一轮：空的学生气泡 + 回答
  // 两半各占一轮，视觉上就是「一半一半」。
  const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
  const state = restoreConversation(
    [
      { role: 'user', text: '第一问', at: 1, entryId: 'u1' },
      { role: 'assistant', text: '第一答', at: 2, entryId: 'a1' },
      { role: 'user', text: '第二问', at: 3, entryId: 'u2' },
      { role: 'assistant', text: '第二答', at: 4, entryId: 'a2' },
      // 第三问没有回答（那一轮失败 / 被拦下了）—— 它是**如实反映**，不是缺陷
      { role: 'user', text: '第三问', at: 5, entryId: 'u3' }
    ],
    null
  )
  assert.equal(state.turns.length, 3, '★ 五条消息 = 三轮（两轮问答 + 一轮只有提问）')
  assert.deepEqual(
    state.turns.map((t) => [t.userText, t.text, t.userEntryId, t.entryId]),
    [
      ['第一问', '第一答', 'u1', 'a1'],
      ['第二问', '第二答', 'u2', 'a2'],
      ['第三问', '', 'u3', null]
    ],
    '★ 每一轮：学生问题 + 它的回答 + 两个分叉点（没有回答的那轮 entryId 为空）'
  )
  // ★ 反向对照：不许把学生问题弄丢（配对时最容易犯的错 —— 替换整轮而不是补回答）
  assert.equal(state.turns.every((t) => t.userText.length > 0), true, '★ 每一轮都要有学生的话')
})

test('★ 开头就是 assistant（开场引导）时单独一轮，不与后面的学生问题挤在一起', async () => {
  const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
  const state = restoreConversation(
    [
      { role: 'assistant', text: '你好，我是团团。从循环开始吧。', at: 1, entryId: 'a0' },
      { role: 'user', text: '好啊', at: 2, entryId: 'u1' },
      { role: 'assistant', text: '那我们开始讲', at: 3, entryId: 'a1' }
    ],
    null
  )
  assert.equal(state.turns.length, 2, '开场引导单独一轮 + 一问一答一轮')
  assert.equal(state.turns[0]?.text, '你好，我是团团。从循环开始吧。')
  assert.equal(state.turns[1]?.userText, '好啊')
  assert.equal(state.turns[1]?.text, '那我们开始讲')
})
