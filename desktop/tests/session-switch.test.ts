/**
 * 会话切换 / 新建 / 恢复（「关掉应用再打开，上一段对话还在」的半边；另一半是开场引导）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * `session:open` / `session:new` / `session:current` / `session:changed` 四条通道
 * 把「历史会话」从**只读回看**变成了**可以继续聊**。这类改动最容易出的三件事，
 * 每一件都不会报错、只会静默地把学生的数据弄丢或串起来：
 *
 * 1. ★★ **切换时不 dispose 旧会话** → 旧 JSONL 半写（数据丢在看不见的地方）；
 * 2. ★★ **渲染进程能指定路径** → 不是 bug，是漏洞（读任意文件）；
 * 3. ★★ **切换失败却把界面清空了** → 学生以为在说新话题，其实接着写进上一条会话。
 *
 * 所以下面每一条都对应「一种静默的数据事故」，而不是「接口返回了 200」。
 *
 * ★ 本文件**不起 Electron、不碰真实 Pi**：主进程侧的判据读源码 + 用替身工厂驱动
 *   （`setChatRuntimeFactoryForTests`），渲染进程侧用假的 `window.api`。
 *   真正连 Pi 的那一层由 `npm run smoke:wire` 与人工演练负责（脚本头有跑法）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

/**
 * ★ 与 `renderer-quiz.test.ts` 同一个理由：渲染进程的模块按 Vite 的口味写相对导入
 * （`from '../labels'`，**不带扩展名**），而 Node ESM 要求显式扩展名。
 * 这个 hook 只给「相对且没写扩展名」的说明符补 `.ts`，让单测能 import
 * **渲染进程的真实实现**（而不是另写一份替身）。
 * 它对其它测试文件无影响：`node --test` 每个测试文件跑在独立子进程里。
 */
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

/** 去掉注释（源码级判据只看**可执行代码** —— 注释里写纪律不算接线）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const HANDLERS = 'src/main/ipc/handlers.ts'
const CHANNELS = 'src/main/ipc/channels.ts'
const PRELOAD = 'src/preload/index.ts'
const RUNTIME = 'src/main/agent/runtime.ts'

/* ------------------------------------------------------------------ *
 * 1. ★★ 主进程：切换的**顺序**（despose 先于装配）
 * ------------------------------------------------------------------ */

test('★★ 切换会话必须先 dispose 旧的、再装配新的（顺序反了会同时存在两个会话）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function swapToSession(')
  assert.ok(at > 0, '找不到 swapToSession')
  const body = source.slice(at, at + 2600)

  const disposeAt = body.indexOf('disposeChatRuntime()')
  const ensureAt = body.indexOf('ensureChatRuntime()')
  assert.ok(disposeAt > 0, '★ 切换会话必须调 disposeChatRuntime() —— 不 dispose 旧 JSONL 会半写')
  assert.ok(ensureAt > 0, '切换会话必须重新装配（ensureChatRuntime）')
  assert.ok(
    disposeAt < ensureAt,
    '★★ 顺序必须是「先 dispose 再装配」：反过来的话，装配期间单例还是旧实例，' +
      '任何一条并发取数（渲染进程挂载时的 grade:get 就是一条）都会拿到旧会话 —— ' +
      '表现是「会话切了一半，有的调用用新会话、有的用旧的」'
  )
})

test('★★ 切换失败时**不许**留下一个被清空的单例（那会让下一次发消息写进错的会话）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function swapToSession(')
  const body = source.slice(at, at + 2600)

  // 装配失败必须有分支：回一句可读中文（而不是抛异常穿过 IPC）
  assert.match(
    body,
    /catch\s*\([\s\S]{0,300}ok:\s*false/,
    '★ 装配失败必须回 `{ok:false, message}`（抛异常会变成界面上的堆栈文本）'
  )
  // 而且失败时**不能**推出「成功了」的状态
  assert.match(
    body,
    /message:\s*`切换会话失败/,
    '★ 失败文案要说清是「切换会话」失败（而不是「对话失败」——处置完全不同）'
  )
})

test('★★ 切换前必须记下「下次装配开哪一条」（否则切了等于没切）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function swapToSession(')
  const body = source.slice(at, at + 2600)
  assert.match(
    body,
    /pendingSessionSource\s*=/,
    '★ 必须写 pendingSessionSource：不写的话下一次 ensureChatRuntime 又回到默认来源（切断默认会话）'
  )
  // 反向对照：装配**成功**之后必须清掉它，否则下次重建会又一次开同一个文件
  const ensureAt = source.indexOf('export async function ensureChatRuntime(')
  const ensureBody = source.slice(ensureAt, ensureAt + 2200)
  assert.match(
    ensureBody,
    /pendingSessionSource\s*=\s*null/,
    '★ 装配成功后必须清掉 pendingSessionSource（否则每次重建都回到那一条）'
  )
})

test('★ 冷启动默认是「续上最近一条」（这正是「重启后数据延续」的落点）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('export function sessionSourceForBoot(')
  assert.ok(at > 0, '找不到 sessionSourceForBoot')
  const body = source.slice(at, at + 500)
  assert.match(
    body,
    /'recent'/,
    '★ 默认必须是 recent：默认 new 的表现是「关掉应用再打开，上一段对话从界面上消失」'
  )
  // 逃生舱（自动化脚本 / 新机器演练需要它）
  assert.match(body, /K12_NEW_SESSION_ON_BOOT/, '需要一个显式改回 new 的环境变量（脚本要用）')
  // 装配时真的用了它
  const ensureAt = source.indexOf('export async function ensureChatRuntime(')
  assert.match(
    source.slice(ensureAt, ensureAt + 2200),
    /sessionSourceForBoot\(\)/,
    '★ ensureChatRuntime 必须真的用 sessionSourceForBoot()（否则它是个没人用的常量）'
  )
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 安全：只接受会话 id
 * ------------------------------------------------------------------ */

test('★★ `session:open` 只接受 id：先在 Pi 列出的会话里对齐，再用 Pi 给的 path 打开', () => {
  const source = stripComments(read(HANDLERS))

  // ① ★ 处理器层就把入参**收窄成字符串**（对象/数字一律变成空串 → 后面的校验会拒绝）。
  //    这一条在 `ipcMain.handle` 那一行，不在 `openSessionById` 里面 ——
  //    「只接受 id」这个判据的落点就在这，读源码时要找对地方。
  const handlerAt = source.indexOf('IPC.sessionOpen,')
  assert.ok(handlerAt > 0, '找不到 session:open 的处理器')
  const handlerBody = source.slice(handlerAt, handlerAt + 300)
  assert.match(
    handlerBody,
    /typeof payload === 'string'\s*\?\s*payload\s*:\s*''/,
    '★ `session:open` 的处理器必须把入参收窄成字符串（会话 id）；' +
      '接受对象就等于给「传 path」留了口子'
  )

  // ② 核心实现：先白名单对齐，再用 Pi 给的 path
  const at = source.indexOf('async function openSessionById(')
  assert.ok(at > 0, '找不到 openSessionById')
  const body = source.slice(at, at + 1200)
  assert.match(
    body,
    /findSessionById\(/,
    '★ 必须先在 Pi 列出的会话里做白名单对齐 —— 直接用渲染进程给的字符串去 open 就是「读任意文件」'
  )
  assert.match(body, /ok:\s*false/, '找不到会话必须拒绝（不回退成「试试看能不能打开」）')
  assert.match(
    body,
    /info\.path/,
    '★ 传给 open 的必须是 `info.path`（Pi 提供的），不是渲染进程递来的值'
  )
})

test('★★ preload 侧同样只递字符串（两道都不放行对象形态）', () => {
  const source = stripComments(read(PRELOAD))
  const at = source.indexOf('openSession:')
  assert.ok(at > 0, '找不到 preload 的 openSession')
  const body = source.slice(at, at + 300)
  assert.match(
    body,
    /ipcRenderer\.invoke\(IPC\.sessionOpen,\s*sessionId\)/,
    '★ preload 必须把 id 原样递过去（不接受额外字段、不接受路径对象）'
  )
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 通道纪律：invoke 与 push 不能混
 * ------------------------------------------------------------------ */

test('★ `session:changed` 是唯一的推送；六条 invoke 一个都不许进 PUSH_CHANNELS', () => {
  const source = read(CHANNELS)
  const block = /export\s+const\s+PUSH_CHANNELS[^=]*=\s*\[([\s\S]*?)\]/.exec(source)?.[1]
  assert.ok(block, '找不到 PUSH_CHANNELS')
  assert.match(block, /IPC\.sessionChanged/, '★ `session:changed` 必须登记为推送通道')

  // ★ 删除（`session:delete`）也必须是 invoke：它要回一句「删没删成」——
  //   破坏性操作没有回执，界面就只能假装成功（而失败时学生以为删掉了，其实还在盘上）。
  for (const channel of [
    'sessionList',
    'sessionTranscript',
    'sessionSearch',
    'sessionOpen',
    'sessionNew',
    'sessionDelete'
  ]) {
    assert.doesNotMatch(
      block,
      new RegExp(`IPC\\.${channel}\\b`),
      `★ \`${channel}\` 是 invoke（有回执），不许登记进 PUSH_CHANNELS`
    )
  }
})

test('★ 「新会话」不走 `chat:send`（那会让发一条消息变成顺带换一个会话）', () => {
  const source = read(CHANNELS)
  const body = /export\s+const\s+IPC\s*=\s*\{([\s\S]*?)\n\}\s+as\s+const/.exec(source)?.[1]
  assert.ok(body, '找不到 IPC 表')
  assert.match(body, /sessionNew:\s*'session:new'/, '必须有独立的 session:new 通道')
  // ChatSendRequest 仍然只有 text（G6c 钉着；这里做一次就近的正向对照）
  const reqAt = source.indexOf('export interface ChatSendRequest')
  const reqBody = source.slice(reqAt, reqAt + 300)
  const fields = [...reqBody.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??\s*:/gm)].map((m) => m[1])
  assert.deepEqual(fields, ['text'], `★ ChatSendRequest 的字段必须恰好是 ['text']，实际 ${fields.join(', ')}`)
})

/* ------------------------------------------------------------------ *
 * 4. ★★ 渲染进程：切换的落库语义（整段替换，不是追加）
 * ------------------------------------------------------------------ */

test('★★ 切换回执必须带「恢复出来的消息」与「开场引导」两样（少一样界面就会错）', () => {
  const source = read(CHANNELS)
  // 形状定义在 `SessionStateResult`（`SessionOpenResult` 是它的**别名** ——
  // 「读当前会话」与「切换会话」两条路必须同形，否则渲染进程要写两套字段读取）。
  const at = source.indexOf('export type SessionStateResult')
  assert.ok(at > 0, '找不到 SessionStateResult')
  const body = source.slice(at, at + 1600)
  for (const field of ['current', 'messages', 'opening', 'openingKpId']) {
    assert.match(
      body,
      new RegExp(`\\b${field}\\b`),
      `★ 回执必须带 \`${field}\`：分两次 IPC 拿会留下「界面已切、消息还是旧的」的中间态`
    )
  }
  // ★ 别名关系本身也是判据：两条路分头演化就会漂移
  assert.match(
    source,
    /export type SessionOpenResult = SessionStateResult/,
    '★ `SessionOpenResult` 必须是 `SessionStateResult` 的别名（两条路同形）'
  )
})

/* ------------------------------------------------------------------ *
 * 5. ★★ 行为面：store 的切换动作（用假 window.api 驱动）
 * ------------------------------------------------------------------ */

/**
 * 造一个可控的假 bridge（只实现会话那四条方法），并**记录每一次调用**。
 *
 * ★ 覆盖用的 `overrides` 也走同一个记录包装（而不是直接替换）——
 *   否则「override 了 startNewSession」这个动作本身会让那条调用从 `calls` 里消失，
 *   而「有没有真的调过它」正是几条断言唯一的判据（实测踩到过：走了 override，
 *   计数是 0，看起来像"没调用"，其实调了）。
 */
function installSessionBridge(overrides: Record<string, (...args: unknown[]) => unknown> = {}): {
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
    // ★ 冷启动那条路：回当前会话 + 恢复出来的正文（本组用例默认回空正文，
    //   因为「挂载时铺历史」由 `session-boot.test.ts` 单独覆盖）。
    getSessionState: () => ({
      ok: true,
      current: { sessionId: 'sess-current', title: '现在的', messageCount: 4 },
      messages: [],
      opening: '',
      openingKpId: ''
    }),
    openSession: () => ({ ok: false, message: '未接线' }),
    startNewSession: () => ({ ok: false, message: '未接线' }),
    branchSession: () => ({ ok: false, message: '未接线' }),
    deleteSession: () => ({ ok: false, message: '未接线' }),
    onSessionChanged: () => () => {},
    // chat store 的 connect() 还要订阅这些，全部给空实现
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

/** 一条成功的切换回执（默认形态：带两条历史消息 + 一句开场）。 */
function switchOk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    current: { sessionId: 'sess-old', title: '以前那段', messageCount: 2 },
    messages: [
      { role: 'user', text: '以前问的', at: 1 },
      { role: 'assistant', text: '以前答的', at: 2 }
    ],
    opening: '',
    openingKpId: '',
    ...overrides
  }
}

test('★★ 打开历史会话：消息列表被**整段替换**（不是把旧对话接在后面）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installSessionBridge({ openSession: () => Promise.resolve(switchOk()) })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    // 先造一段「当前对话」（模拟学生正在聊）
    const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
    chat.conversation = restoreConversation([{ role: 'user', text: '刚才问的', at: 9 }])
    assert.equal(chat.turns.length, 1)

    const result = await chat.openSession('sess-old')
    assert.equal(result.ok, true, JSON.stringify(result))
    // ★★ 两条消息 = **一轮**（问-答 配对）；`1 + 1 = 2` 那种按条数算的判据
    //   正是 P-106 的缺陷形态。
    assert.equal(chat.turns.length, 1, '★ 一问一答 = 一轮（不是两条各占一轮）')
    assert.equal(chat.turns[0]?.userText, '以前问的')
    assert.equal(chat.turns[0]?.text, '以前答的', '★ 回答必须跟问题在同一轮')
    assert.ok(
      !chat.turns.some((turn) => turn.userText === '刚才问的'),
      '★ 上一段会话的消息不许留在列表里（两段对话拼在一起 = 学生看到自己没说过的话）'
    )
    assert.equal(chat.currentSessionId, 'sess-old', '当前会话 id 必须换成新的')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 切换失败时**不动**当前对话（清空了又什么都没恢复是最坏的失败）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installSessionBridge({
      openSession: () => Promise.resolve({ ok: false, message: '找不到会话 sess-gone。' })
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.conversation = restoreConversation([{ role: 'user', text: '正在聊的内容', at: 9 }])

    const result = await chat.openSession('sess-gone')
    assert.equal(result.ok, false)
    assert.equal(result.message, '找不到会话 sess-gone。', '失败原因要原样带给界面（可读中文）')
    assert.equal(chat.turns.length, 1, '★ 失败时当前对话必须原样保留')
    assert.equal(chat.turns[0]?.userText, '正在聊的内容')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 空会话切换：真的清空（不是「保留原来的」）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installSessionBridge({
      openSession: () =>
        Promise.resolve(
          switchOk({
            current: { sessionId: 'sess-empty', title: '', messageCount: 0 },
            messages: []
          })
        )
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.conversation = restoreConversation([{ role: 'user', text: '旧的', at: 1 }])

    await chat.openSession('sess-empty')
    assert.deepEqual(chat.turns, [], '★ 切到空会话必须真的清空')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 缺通道时给一句可照着做的话（不是把整页打空）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    // 只有 window，没有那四条方法
    ;(globalThis as { window?: unknown }).window = { api: {} }
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    const result = await chat.openSession('sess-1')
    assert.equal(result.ok, false)
    assert.match(String(result.message), /openSession|白名单/, '缺通道要说清缺什么、怎么接')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 新会话：走的是 `startNewSession`，不是「清屏」（两者是不同的动作）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    const { calls } = installSessionBridge({
      startNewSession: () =>
        Promise.resolve(
          switchOk({ current: { sessionId: 'sess-new', title: '', messageCount: 0 }, messages: [] })
        )
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    const result = await chat.startNewSession()
    assert.equal(result.ok, true)
    assert.equal(chat.currentSessionId, 'sess-new')
    const startCalls = calls.filter((call) => call.method === 'startNewSession')
    assert.equal(startCalls.length, 1, '★ 必须真的调了 bridge.startNewSession（它让主进程开一个新文件）')
    assert.ok(
      !calls.some((call) => call.method === 'openSession'),
      '新会话不该走 openSession（那是「打开已有的一条」）'
    )
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

/* ------------------------------------------------------------------ *
 * 6. ★★ 主进程：把开场引导写进 Pi 会话（形态必须是 assistant 消息）
 * ------------------------------------------------------------------ */

test('★★ 开场引导写成 **assistant 消息**（不是 custom_message：那会变成学生说的话）', () => {
  const source = stripComments(read(RUNTIME))
  // ⚠️ 找**实现**而不是接口声明：`appendOpeningMessage(text: string): void` 在
  //    `ChatRuntime` 接口里也出现一次，用 `indexOf` 会命中那一处（那里没有函数体，
  //    断言会对着一个签名做判断 —— 而签名无法证明任何行为）。
  const at = source.indexOf('appendOpeningMessage(text: string): void {')
  assert.ok(at > 0, '找不到 appendOpeningMessage 的实现')
  const body = source.slice(at, at + 2000)

  assert.match(body, /appendMessage\(/, '必须用 `appendMessage`（写进对话历史，重启后还在）')
  assert.match(
    body,
    /role:\s*'assistant'/,
    "★★ 必须是 `role: 'assistant'` —— `custom_message` 在 Pi 的 convertToLlm 里会变成 **user** 消息，" +
      '模型会以为「从X开始吧」是学生说的（伪造对话记录）'
  )
  // ★ 反向对照：不许用那两个会出问题的形态
  assert.doesNotMatch(
    body,
    /appendCustomMessageEntry|appendCustomEntry/,
    '★ 不许用 custom_message / custom 条目：前者变成 user 消息，后者根本不进模型上下文'
  )
  // usage 全 0 是事实（模板拼出来的，没花 token）
  assert.match(body, /stopReason:\s*'stop'/, '要写一个完整的收尾态（它不是一次被中断的生成）')
  assert.match(body, /totalTokens:\s*0/, '★ token 数写全 0 是**事实**（模板拼的，没发过请求）')
})

test('★ 开场引导写入失败**不许**冒异常（那会让「新建会话」整个失败）', () => {
  const source = stripComments(read(RUNTIME))
  const at = source.indexOf('appendOpeningMessage(text: string): void {')
  assert.ok(at > 0, '找不到 appendOpeningMessage 的实现')
  const body = source.slice(at, at + 2000)
  assert.match(body, /catch\s*\(/, '★ 必须自兜异常：写不进去只该记日志，界面那条开场语照常显示')
  // 空文本直接跳过（不发空开场）
  assert.match(body, /if\s*\(!trimmed/, '空开场语不许写进会话文件')
})
