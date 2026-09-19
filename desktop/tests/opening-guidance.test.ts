/**
 * 主动发起对话引导（需求原文：「智能体也能主动发起对话引导学习章节内容」）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是「开场白**发错时机**」的四类形态
 * ---------------------------------------------------------------------------
 * 这个功能的价值全在**时机**上：同样一句话，早一秒晚一秒都会变味，而四种错误
 * 全都不报错、界面也不会崩 —— 只是学生会觉得这个助手有点奇怪：
 *
 * 1. ★★ **每轮都发** → 助手像个复读机（开场语只该在**会话为空**时出现一次）；
 * 2. ★★ **切到历史会话也发** → 一句「我们从X开始吧」插在他自己聊过的内容前面；
 * 3. ★★ **没有依据也发** → 「今天想学什么？」这种对谁都成立的废话（服务端已经
 *    用空串表达了「这次不发」，前端必须**真的不发**）；
 * 4. ★ **没有目标还渲染动作按钮** → 学生点「好啊，就从这里开始」，什么都不发生。
 *
 * ★ 服务端那一半（`GET /api/profile/{id}/opening` 拼出什么话）由
 *   `server/tests/test_opening_guidance.py` 覆盖；本文件只管**主进程与前端**
 *   把这句话放在哪、放几次、什么时候不放。
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
const CHAT_VIEW = 'src/renderer/src/views/Chat.vue'
const CHAT_STORE = 'src/renderer/src/stores/chat.ts'

/* ------------------------------------------------------------------ *
 * 1. ★★ 主进程：什么时候发
 * ------------------------------------------------------------------ */

test('★★ 开场引导的判据是「这条会话里还没有消息」，不是「刚点了新建」', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function swapToSession(')
  assert.ok(at > 0, '找不到 swapToSession')
  const body = source.slice(at, at + 3000)

  // ⚠️ 必须锚在**取开场那一行**上，不能只搜 `messageCount === 0` ——
  //    同一个函数体里 `maybeGenerateTitle` 也有 `instance.messageCount === 0`，
  //    泛搜会让「判据被删掉」这个改动**静默通过**（变异验证实测踩到过：
  //    把整行改成 `const opening = await fetchOpening()` 之后，守卫仍然是绿的）。
  const openingLine = /const opening = ([^\n]*)/.exec(body)?.[1] ?? ''
  assert.ok(openingLine, '找不到取开场引导的那一行')
  assert.match(
    openingLine,
    /messageCount\s*===\s*0/,
    '★ 取开场的判据必须是「这条会话还没有消息」：\n' +
      '  - 用 `source === "new"` → 切到一条空的历史会话永远等不到开场；\n' +
      '  - 用 `getEntries().length === 0` → 刚建的会话已经有 model_change 等条目，开场永远发不出来；\n' +
      '  - 不加判据（每轮都取）→ 切到已聊过的会话也会插一句「我们从X开始吧」。\n' +
      `实际：${openingLine}`
  )
  // ★ 有开场才写进 Pi 会话（空开场不许写）
  assert.match(
    body,
    /if\s*\(opening\.text\)[\s\S]{0,200}appendOpeningMessage\(/,
    '★ 只有真的拿到开场语时才写进 Pi 会话（写空串会让历史里多出一条空消息）'
  )
})

test('★★ 开场引导**只在切换/新建那条路上**取（不在每轮对话里）', () => {
  const source = stripComments(read(HANDLERS))
  // `fetchOpening` 的调用点：只该在 swapToSession 里有
  const calls = [...source.matchAll(/await fetchOpening\(\)/g)]
  assert.equal(calls.length, 1, `fetchOpening 只该有一个调用点（切换/新建），实际 ${calls.length} 个`)
  const at = source.indexOf('async function swapToSession(')
  const body = source.slice(at, at + 3000)
  assert.ok(body.includes('await fetchOpening()'), '★ 唯一的调用点必须在 swapToSession 里')

  // 而且它**不在** runChatTurn 里（那条是「学生发一条 → 模型回一条」的路径）
  const runAt = source.indexOf('async function runChatTurn(')
  const runBody = source.slice(runAt, runAt + 3000)
  assert.doesNotMatch(
    runBody,
    /fetchOpening|opening/,
    '★★ 每轮对话都不许碰开场引导 —— 「每轮打招呼」是助手变复读机的形态'
  )
})

test('★ 取开场失败时**安静降级**（不发开场，但对话照常）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function fetchOpening(')
  assert.ok(at > 0, '找不到 fetchOpening')
  const body = source.slice(at, at + 1200)
  // 拿不到（ok:false）→ 空串，不抛
  assert.match(body, /if\s*\(!result\.ok\)\s*return\s*\{\s*text:\s*''/, '失败必须回空串而不是抛')
  // 空文本 → 空串（不硬凑）
  assert.match(body, /if\s*\(!text\)\s*return\s*\{\s*text:\s*''/, '没有内容时不发开场')
  // kpId 只在有开场语时才有意义
  assert.match(body, /text,\s*kpId/, '两样一起回（只有开场语没有目标时界面不渲染按钮）')
})

test('★ 开场语与「写进会话的那一份」是**同一份文本**（不能两处各拼一次）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function swapToSession(')
  const body = source.slice(at, at + 3000)
  // 写进去的是 opening.text（同一个变量），而不是再调一次 fetchOpening / 再拼一次
  const writes = [...body.matchAll(/appendOpeningMessage\(([^)]*)\)/g)]
  assert.equal(writes.length, 1, `appendOpeningMessage 只该调一次，实际 ${writes.length} 次`)
  assert.match(
    writes[0]?.[1] ?? '',
    /opening\.text/,
    '★ 写进会话的必须是**屏幕上显示的那一份**（`opening.text`）—— 两处各拼一次迟早不一致'
  )
  // 回执里给的也必须是同一份
  assert.match(body, /opening:\s*opening\.text/, '★ 回执里给前端的也必须是同一份文本')
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 渲染进程：什么时候显示
 * ------------------------------------------------------------------ */

test('★★ 开场引导住在**空态**里（它只在会话为空时才有值 —— 放错分支就永远看不见）', () => {
  // ★★ 这条断言是**实测修正**过的，缺陷形态值得写下来（见 pitfalls P-101）：
  //   初版把开场引导放在「有消息」那个分支里（排在 `<ChatMessage>` 前面），
  //   理由是「它要显示在第一条消息之前」。而它**只在会话为空时才有值** ⇒
  //   那个分支永远进不去 ⇒ 开场语生成了、写进 Pi 会话了、界面上一个字都看不到
  //   （主进程日志明明白白写着「已把开场引导写入会话（35 字符）」，界面却是空的）。
  //   正确的落点是**空态**（`isEmpty` 那个分支）—— 位置本身就是它的语义：
  //   「还没有任何一轮对话时，助手先开口」。
  const source = read(CHAT_VIEW)
  const openingAt = source.indexOf('data-testid="chat-opening"')
  const emptyAt = source.indexOf('data-testid="chat-empty"')
  // ⚠️ `messageAt` 必须从**空态之后**开始找：本文件与 `Chat.vue` 的注释里
  //    都会提到 `<ChatMessage>`（解释这段历史），直接 `indexOf` 会命中那条注释 ——
  //    于是断言对着一段文字做判断（实测踩到过：这条断言因此假红）。
  const messageAt = source.indexOf('<ChatMessage', emptyAt)
  assert.ok(openingAt > 0, 'Chat.vue 里没有开场引导的渲染')
  assert.ok(emptyAt > 0 && messageAt > emptyAt, '找不到空态 / 消息列表')

  // ★★ 判据是**分支边界**而不是「在空态标记之后」：`emptyAt` 只是那个 div 的
  //    **起始位置**，用 `emptyAt < openingAt` 判「在空态里」是不够的 ——
  //    把整块移到空态 div 的收尾之后、`v-else` 分支之内，它照样成立（变异验证实测）。
  //    真正的边界是 `v-else`（消息列表那条分支的开头）：
  //    开场引导必须落在它**之前**，且**在空态区块内**。
  const elseAt = source.indexOf('<template v-else>', emptyAt)
  assert.ok(elseAt > 0, '找不到空态之后的 v-else 分支边界')
  assert.ok(
    emptyAt < openingAt && openingAt < elseAt && openingAt < messageAt,
    '★ 开场引导必须在**空态区块之内**（`chat-empty` 与 `v-else` 之间）—— 它在会话为空时才有值；' +
      `实际位置：empty=${emptyAt} opening=${openingAt} else=${elseAt} message=${messageAt}`
  )

  // 它只在有内容时出现（v-if），不是一直挂着一个空盒子
  const block = source.slice(openingAt - 500, openingAt + 200)
  assert.match(block, /v-if="chat\.showOpening"/, '★ 必须由 `chat.showOpening` 决定显示（不是无条件渲染）')

  // ★ 反过来：**不许**在「有消息」那个分支里再渲染一份（两处渲染就会重复显示）
  const messageBranch = source.slice(messageAt, messageAt + 400)
  assert.doesNotMatch(
    messageBranch,
    /chat__opening/,
    '★ 消息列表里不许再放一份开场引导（两处渲染 = 有消息时也会冒出来一句招呼）'
  )
})

test('★★ `kpId` 为空时**不许**渲染动作按钮（否则点了什么都不发生）', () => {
  const source = read(CHAT_VIEW)
  const at = source.indexOf('data-testid="chat-opening-accept"')
  assert.ok(at > 0, '找不到「好啊，就从这里开始」按钮')
  // 找这个按钮往上最近的一个 v-if
  const before = source.slice(Math.max(0, at - 500), at)
  assert.match(
    before,
    /v-if="chat\.openingKpId"/,
    '★ 接受引导的按钮必须带 `v-if="chat.openingKpId"` —— 没有目标知识点时它是个死按钮'
  )
  // 而「我想问别的」不受这个限制（它不需要目标）
  const skipAt = source.indexOf('data-testid="chat-opening-skip"')
  assert.ok(skipAt > 0, '必须有一个「我想问别的」的出口（学生有权跳过引导）')
})

test('★ 学生开口后开场引导**收起**（它只该出现一次）', () => {
  const store = stripComments(read(CHAT_STORE))
  const at = store.indexOf('async function send(')
  assert.ok(at > 0, '找不到 send')
  const body = store.slice(at, at + 2000)
  assert.match(
    body,
    /openingDismissed\.value\s*=\s*true/,
    '★ `send()` 必须收起开场引导：学生开口就是「这条引导被接住了」，再挂着就成了复读机'
  )
})

test('★★ 空开场语 → `showOpening` 为假（服务端说「这次不发」时前端必须真的不发）', () => {
  const store = stripComments(read(CHAT_STORE))
  const at = store.indexOf('const showOpening = computed(')
  assert.ok(at > 0, '找不到 showOpening')
  const line = store.slice(at, at + 200)
  assert.match(
    line,
    /opening\.value\s*!==\s*''/,
    '★ 判据必须含「开场语非空」—— 服务端用空串表达「没有依据，不要发」'
  )
  assert.match(line, /!openingDismissed\.value/, '★ 判据必须含「学生还没回应过」')
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 行为面：store 的落库（真的跑一遍）
 * ------------------------------------------------------------------ */

function installBridge(opening: string, openingKpId: string): void {
  const api = {
    // ★ 冷启动那条路**不发**开场（主进程 `session:state` 的注释）：回空开场 + 空正文。
    //   所以本组用例里「开场引导」只可能来自 `openSession` / `startNewSession`。
    getSessionState: () => ({
      ok: true,
      current: { sessionId: 's1', title: '', messageCount: 0 },
      messages: [],
      opening: '',
      openingKpId: ''
    }),
    openSession: () => ({
      ok: true,
      current: { sessionId: 's1', title: '', messageCount: 0 },
      messages: [],
      opening,
      openingKpId
    }),
    startNewSession: () => ({
      ok: true,
      current: { sessionId: 's2', title: '', messageCount: 0 },
      messages: [],
      opening,
      openingKpId
    }),
    // ★ 分叉（「从这里重新问」）也要在：`resolveSessionBridge` 的必需方法清单里
    //   有它，缺一个整个桥就是 `ready:false` —— 而那时**所有**会话动作都会失败
    //   （实测踩到过：漏了这个假实现，本组用例全红，错误信息与开场语毫无关系）。
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

test('★★ 有开场语 → 显示；学生回应后 → 收起（行为面，不是读源码）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installBridge('你好，我是团团。从循环开始吧。', 'prog-loop-jr')
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    await chat.startNewSession()
    assert.equal(chat.opening, '你好，我是团团。从循环开始吧。')
    assert.equal(chat.openingKpId, 'prog-loop-jr')
    assert.equal(chat.showOpening, true, '★ 有开场语时必须显示')

    chat.acceptOpening()
    assert.equal(chat.showOpening, false, '★ 学生回应后必须收起')
    // ★ 收起 ≠ 删除：文本还在（它同时已经写进 Pi 会话了，本地这份删掉会让两边不一致）
    assert.equal(chat.opening, '你好，我是团团。从循环开始吧。', '★ 收起不是删除（重启后它还在历史里）')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 空开场语 → 不显示（服务端说「没有依据」时前端必须真的不发）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installBridge('', '')
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    await chat.startNewSession()
    assert.equal(chat.opening, '')
    assert.equal(chat.showOpening, false, '★ 空开场语必须不显示（不硬凑一句「今天想学什么？」）')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 切到一条**有内容**的会话 → 不显示开场（不插在历史对话前面）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    // 主进程对已有内容的会话回空开场（这一侧就是它回什么显示什么）
    installBridge('', '')
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    await chat.openSession('s-old')
    assert.equal(chat.showOpening, false, '★ 切到有内容的会话不许显示开场引导')
    assert.equal(chat.opening, '')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 开场引导只在**会话为空**时随切换落库（有内容的会话带回了消息）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    // 主进程与前端各守一半：主进程不该对有内容的会话给开场，
    // 万一它给了（契约被改坏），界面这一侧也不该把它显示在两条历史消息前面。
    const api = {
      getSessionState: () => ({
        ok: true,
        current: { sessionId: 's1', title: '', messageCount: 2 },
        messages: [],
        opening: '',
        openingKpId: ''
      }),
      openSession: () => ({
        ok: true,
        current: { sessionId: 's-old', title: '以前', messageCount: 2 },
        messages: [
          { role: 'user', text: '以前问的', at: 1 },
          { role: 'assistant', text: '以前答的', at: 2 }
        ],
        opening: '',
        openingKpId: ''
      }),
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
    setActivePinia(createPinia())
    const chat = useChatStore()

    await chat.openSession('s-old')
    // ★ 两条消息 = 一轮（问-答 配对，见 P-106）
    assert.equal(chat.turns.length, 1, '恢复出来的问-答要配成一轮')
    assert.equal(chat.showOpening, false, '★ 历史会话不该顶着一句开场白')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})
