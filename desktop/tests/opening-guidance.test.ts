/**
 * 主动发起对话引导（需求原文：「智能体也能主动发起对话引导学习章节内容」）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是「开场白**发错时机**」的四类形态
 * ---------------------------------------------------------------------------
 * 这个功能的价值全在**时机**上：同样一句话，早一秒晚一秒都会变味，而四种错误
 * 全都不报错、界面也不会崩 —— 只是学生会觉得这个助手有点奇怪：
 *
 * 1. ★★ **每轮都发** → 助手像个复读机（开场语只该在**会话还没开始**时出现一次）；
 * 2. ★★ **切到历史会话也发** → 一句「我们从X开始吧」插在他自己聊过的内容前面；
 * 3. ★★ **没有依据也发** → 「今天想学什么？」这种对谁都成立的废话（服务端已经
 *    用空串表达了「这次不发」，前端必须**真的不发**）；
 * 4. ★ **没有目标还渲染动作按钮** → 学生点「好啊，就从这里开始」，什么都不发生。
 * 5. ★★ **同一段没开始的会话长成两副样子**（2026-09-22 实测缺陷）：判据原来是
 *    「会话里消息条数为 0」，而开场白**自己就是写进会话文件的一条消息** ——
 *    于是「刚建好 → 切走 → 切回来」之后开场卡、四张能力入口、建议问题全没了，
 *    只剩一个空气泡 + 一句问候，轮数还从「尚未开始」变成「1 轮」。
 *    现在的判据是**「学生开口了没有」**（`ChatRuntime.hasUserTurn`），
 *    主进程与渲染进程用**同一条规则**（`resolveSessionPrelude` / `turnCount`）。
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
const MESSAGE_VIEW = 'src/renderer/src/components/ChatMessage.vue'

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * 取某个**顶层函数**的函数体（从签名到下一个顶层 `}` 行）。
 *
 * ★ 为什么不用 `slice(at, at + 3000)`：那会把**后面几个函数**一起圈进来 ——
 *   断言"某调用不许出现"时，后面的函数里恰好出现一次就会假红/假绿（锚点选错的两种错法，
 *   本仓库都有前科，见 P-111）。函数体自己有个明确的收尾，就别拿字节数当边界。
 */
function topLevelBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start > 0, `源码里找不到 ${signature}`)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end < 0 ? source.length : end)
}

/* ------------------------------------------------------------------ *
 * 1. ★★ 主进程：什么时候发
 * ------------------------------------------------------------------ */

test('★★ 开场引导的判据是「学生开口了没有」，不是「会话里有没有消息」', () => {
  const source = stripComments(read(HANDLERS))
  const body = topLevelBody(source, 'async function resolveSessionPrelude(')

  // ★★ 判据本体：`hasUserTurn`（学生开口了没有）。
  assert.match(
    body,
    /if\s*\(instance\.hasUserTurn\)/,
    '★ 判据必须是「学生开口了没有」：开场白**自己就是写进会话文件的一条消息**，' +
      '拿消息条数判会让「刚建好 → 切走 → 切回来」的会话丢掉整个空态（实测缺陷）。'
  )
  // ★ 反向：这个函数里不许再出现 `messageCount` —— 它正是被换掉的那个判据。
  assert.equal(
    countOccurrences(body, 'messageCount'),
    0,
    '★★ 判据不许回退到消息条数（`messageCount`）—— 开场白写进文件后它就是 1，' +
      '「文件里有几条消息」与「学生开口了没有」是两件事。'
  )

  // 已经聊过的会话：铺消息、一个字的开场都不给（不许插在历史对话前面）。
  assert.match(
    body,
    /\{\s*started:\s*true,\s*messages:\s*\[\.\.\.instance\.restoredMessages\],\s*opening:\s*'',\s*openingKpId:\s*'',\s*openingKpName:\s*''\s*\}/,
    '★ `started === true` 时必须原样铺消息、且开场语为空串'
  )

  // ★★ 未开始的两条分支**都**回空消息数组：那条开场白由 `opening` 承载，
  //    不许当作普通消息铺回去 —— 铺回去界面就进不了空态（开场卡/入口卡/建议问题全没了）。
  assert.equal(
    countOccurrences(body, 'messages: []'),
    2,
    '★★ 未开始的会话必须回**空消息数组**（两条分支各一处）：开场白走 `opening`，' +
      '否则界面进不了空态 —— 那正是「切回来长得不一样」的根因。'
  )

  // ★ 有开场才写进 Pi 会话（空开场不许写），且只在「文件里还没有」那条分支里写。
  assert.equal(
    countOccurrences(body, 'appendOpeningMessage('),
    1,
    '★ `appendOpeningMessage` 只该调一次（只在文件里还没有开场白时才写）'
  )
  const branchAt = body.indexOf('if (!stored) {')
  assert.ok(branchAt > 0, '找不到「文件里还没有开场白」那条分支')
  const writeBranch = body.slice(branchAt, body.indexOf('\n  }\n', branchAt))
  assert.match(
    writeBranch,
    /if\s*\(fetched\.text\)[\s\S]{0,300}appendOpeningMessage\(/,
    '★ 只有真的拿到开场语时才写进 Pi 会话（写空串会让历史里多出一条空消息）'
  )
  assert.doesNotMatch(
    body.slice(body.lastIndexOf('return {')),
    /appendOpeningMessage\(/,
    '★★ 文件里已经有开场白时**不许再写一遍** —— 重复写入会让历史里出现两句招呼'
  )

  // ★★ 目标知识点优先用**落盘时一起写下的那份**（2026-09-30 修）。
  //    旧判据只有「重新取到的那句与文件里逐字相同」—— 推荐池随画像变化，
  //    重启后重取的那句经常不同，于是按钮被撤掉、卡片上只剩一句点不动的邀请。
  assert.match(
    body,
    /const persisted = storedOpeningKp\(instance\.restoredMessages\)/,
    '★ 必须先从会话文件里取落盘的目标知识点（否则重启后按钮又会因为文案变了而消失）'
  )
  assert.match(
    body,
    /fetched\.text === stored \? fetched : null/,
    '★ 老会话（没有落盘元数据）仍走「逐字相同」判据 —— 不猜、不编'
  )
  assert.match(
    body,
    /openingKpId:\s*persisted\?\.kpId\s*\?\?\s*fresh\?\.kpId\s*\?\?\s*''/,
    '★ 取用优先级：落盘 > 逐字相同 > 空（都对不上才撤按钮）'
  )
  assert.match(
    body,
    /openingKpName:\s*persisted\?\.kpName\s*\?\?\s*fresh\?\.kpName\s*\?\?\s*''/,
    '★★ 名字与 id 同进同退（D-072）：拿不到目标时两个都不给'
  )
})

test('★★ 开场白的目标知识点跟着消息落盘（恢复时不再靠文案比对）', async () => {
  // ── ① 写入侧：接口要收、消息里要真的写进去、调用方要真的递进去 ──
  const runtime = read('src/main/agent/runtime.ts')
  assert.match(
    runtime,
    /appendOpeningMessage\(text: string, opening\?: \{ kpId: string; kpName: string \}\)/,
    '★ `appendOpeningMessage` 必须接受「这句开场指向哪个知识点」'
  )
  assert.match(
    runtime,
    /k12Opening: \{ kpId: opening\.kpId, kpName: opening\.kpName \}/,
    '★ 目标必须真的写进那条 session 消息（Pi 的 appendMessage 原样存对象）'
  )
  const handlers = stripComments(read(HANDLERS))
  assert.match(
    handlers,
    /appendOpeningMessage\(fetched\.text, \{ kpId: fetched\.kpId, kpName: fetched\.kpName \}\)/,
    '★ 调用方必须把目标一起递进去 —— 只写文本等于没修'
  )

  // ── ② 读取侧：真跑 `projectTranscript`（纯函数），元数据原样读回；坏数据整条不认 ──
  const { projectTranscript } = await import('../src/main/study/sessions.ts')
  const base = {
    type: 'message',
    id: 'e1',
    timestamp: '2026-09-30T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '你好，我是智团团。要不我们从变量聊起？' }],
      k12Opening: { kpId: 'prog-variable-jr', kpName: '变量：给数据起名字' }
    }
  }
  const projected = projectTranscript([base]).messages
  assert.deepEqual(projected[0]?.openingKp, {
    kpId: 'prog-variable-jr',
    kpName: '变量：给数据起名字'
  })
  // 坏元数据 / 老会话：一律不认（`undefined`）—— 调用方据此退回「逐字相同」判据，绝不猜
  for (const bad of [{ kpName: '甲' }, { kpId: '' }, { kpId: 42 }, 'x', null]) {
    const one = projectTranscript([{ ...base, message: { ...base.message, k12Opening: bad } }]).messages
    assert.equal(one[0]?.openingKp, undefined, `坏元数据必须整条不认：${JSON.stringify(bad)}`)
  }
  const legacy = projectTranscript([
    { ...base, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } }
  ]).messages
  assert.equal(legacy[0]?.openingKp, undefined, '老会话没有这份元数据 → 不认（退回逐字判据）'
  )
})

test('★★ 开场引导**只在「会话开始/恢复」那条路上**取（不在每轮对话里）', () => {
  const source = stripComments(read(HANDLERS))
  // `fetchOpening` 的调用点只该落在唯一的那个判据函数里（两条未开始分支各一次）
  // ★ D-074：调用要带 seed（会话 id）—— 开场白是随机的，同 seed 才是同一句。
  //   所以匹配「带任意参数」的调用，而不是空参 `()`。
  const calls = [...source.matchAll(/await fetchOpening\([^)]*\)/g)]
  assert.equal(
    calls.length,
    2,
    `fetchOpening 只该在 resolveSessionPrelude 里被调（未开始的两条分支），实际 ${calls.length} 处`
  )
  const prelude = topLevelBody(source, 'async function resolveSessionPrelude(')
  assert.equal(
    (prelude.match(/await fetchOpening\([^)]*\)/g) ?? []).length,
    2,
    '★ 两次调用都必须在 resolveSessionPrelude 内 —— 它是「开场引导发不发」的唯一判据'
  )
  assert.match(
    prelude,
    /await fetchOpening\(instance\.sessionId\)/,
    '★★ seed 必须是**会话 id**：开场白是随机的，同一条会话必须拿到同一句 —— ' +
      '否则「切走再切回」时现取的那句与文件里那句对不上，动作按钮会被（正确地）撤掉（D-074）'
  )

  // 而它**不在** runChatTurn 里（那条是「学生发一条 → 模型回一条」的路径）
  const runBody = topLevelBody(source, 'async function runChatTurn(')
  assert.doesNotMatch(
    runBody,
    /fetchOpening|opening/,
    '★★ 每轮对话都不许碰开场引导 —— 「每轮打招呼」是助手变复读机的形态'
  )
})

test('★★ 切换与冷启动**共用同一个判据**（分两处写就会长出第三副样子）', () => {
  const source = stripComments(read(HANDLERS))
  // 三个调用点：swapToSession（切换/新建/分叉）与 session:state（冷启动恢复）
  const calls = countOccurrences(source, 'await resolveSessionPrelude(')
  assert.equal(
    calls,
    2,
    `resolveSessionPrelude 只该被两处调用（切换 + 冷启动），实际 ${calls} 处 —— ` +
      '两处各写一套判据正是「同一段没开始的会话长成两副样子」的成因'
  )
  const stateBody = topLevelBody(source, 'ipcMain.handle(IPC.sessionState,')
  assert.match(
    stateBody,
    /await resolveSessionPrelude\(/,
    '★ 冷启动（`session:state`）必须走同一个判据 —— 否则重启后又变回第三副样子'
  )
})

test('★ 取开场失败时**安静降级**（不发开场，但对话照常）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function fetchOpening(')
  assert.ok(at > 0, '找不到 fetchOpening')
  const body = source.slice(at, at + 1200)
  // 拿不到（ok:false）→ 空串，不抛（D-074：三个字段一起空 —— text/kpId/kpName 同进同退）
  assert.match(body, /if\s*\(!result\.ok\)\s*return\s*empty/, '失败必须回空串而不是抛')
  // 空文本 → 空串（不硬凑）
  assert.match(body, /if\s*\(!text\)\s*return\s*empty/, '没有内容时不发开场')
  // 三样一起回（开场语 + 目标 + 名字）
  assert.match(body, /return\s*\{\s*text,\s*kpId,\s*kpName\s*\}/, '三样一起回')
})

test('★ 开场语与「写进会话的那一份」是**同一份文本**（不能两处各拼一次）', () => {
  const source = stripComments(read(HANDLERS))
  const body = topLevelBody(source, 'async function resolveSessionPrelude(')
  // 写进去的是 fetched.text（同一次取回的那个值），而不是再调一次 fetchOpening / 再拼一次
  const writes = [...body.matchAll(/appendOpeningMessage\(([^)]*)\)/g)]
  assert.equal(writes.length, 1, `appendOpeningMessage 只该调一次，实际 ${writes.length} 次`)
  assert.match(
    writes[0]?.[1] ?? '',
    /fetched\.text/,
    '★ 写进会话的必须是**屏幕上显示的那一份**（`fetched.text`）—— 两处各拼一次迟早不一致'
  )
  // 回执里给的也必须是同一份：现取的分支给 `fetched.text`，文件已有那条给 `stored`
  assert.match(body, /opening:\s*fetched\.text/, '★ 现取的分支：回执与写入必须是同一份文本')
  assert.match(
    body,
    /opening:\s*stored/,
    '★ 文件里已有开场白的分支：回执给的是**文件里那条**（它是唯一真相，不能拿现取的那句盖掉）'
  )
})

/* ------------------------------------------------------------------ *
 * 1b. ★★ 渲染进程：未开始的会话不许长出第二副样子
 * ------------------------------------------------------------------ */

test('★★ 恢复出来的「开场白」不许挂着一个空气泡（`userText` 空就不渲染学生气泡）', () => {
  const source = read(MESSAGE_VIEW)
  const at = source.indexOf('data-testid="user-message"')
  assert.ok(at > 0, '找不到学生气泡')
  assert.match(
    source.slice(Math.max(0, at - 700), at),
    /v-if="turn\.userText"/,
    '★★ 学生气泡必须带 `v-if="turn.userText"`：开场白是**助手**先说的那条，' +
      '`restoreConversation` 会给它单独一轮而 `userText` 是空串 —— 无条件渲染就是那个空气泡（实测截图）。'
  )
})

test('★★ 「尚未开始 / N 轮」与空态都按**学生开口了没有**算（不是数列表长度）', () => {
  const source = read(CHAT_VIEW)
  assert.match(
    source,
    /const turnCount = computed\(\(\) => turns\.value\.filter\(\(turn\) => turn\.userText !== ''\)\.length\)/,
    "★ 必须有一个只数「有学生提问」的轮次计数器 —— 直接数 `turns.length` 会把开场白那一轮也算进去"
  )
  assert.match(
    source,
    /const isEmpty = computed\(\(\) => turnCount\.value === 0\)/,
    '★ 空态判据必须是「学生还没开口」（与主进程 `hasUserTurn` 同一条规则）'
  )
  // 顶栏那行元信息也必须用它（否则界面会出现「尚未开始」与「1 轮」自相矛盾）
  assert.match(
    source,
    /isEmpty \? '尚未开始' : `\$\{turnCount\} 轮`/,
    '★ 「N 轮」必须用 turnCount —— 用 turns.length 会让同一条会话在切回来后从「1 轮」变「2 轮」'
  )
})

test('★★ 未开始的会话：主进程回空正文 → 界面上就是空态 + 开场卡（行为面）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    // 主进程对「学生还没开口」的会话的形态：started=false、正文空、开场白在 opening 里。
    // ★ 这条正是「切走再切回来」那一刻的回执（开场白已经写在文件里了，所以不再现取）。
    installBridge('你好，我是智团团。我们从人工智能的定义开始吧。', 'ai-definition-pl')
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    await chat.openSession('s-empty')
    assert.equal(chat.turns.length, 0, '★★ 未开始的会话不许铺出任何消息（那些「消息」是开场白，走 opening）')
    assert.equal(chat.showOpening, true, '★ 开场卡仍然要显示 —— 这就是「切回来还是一样的界面」')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
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
    // ★ 冷启动那条路与切换共用同一个判据（`resolveSessionPrelude`）：未开始的会话
    //   一样会带来开场引导 —— 这里回 `started: false` + 空正文 + 开场白。
    getSessionState: () => ({
      ok: true,
      current: { sessionId: 's1', title: '', messageCount: 0 },
      messages: [],
      started: false,
      opening,
      openingKpId,
      openingKpName: openingKpId ? '循环' : ''
    }),
    openSession: () => ({
      ok: true,
      current: { sessionId: 's1', title: '', messageCount: 0 },
      messages: [],
      started: false,
      opening,
      openingKpId,
      openingKpName: openingKpId ? '循环' : ''
    }),
    startNewSession: () => ({
      ok: true,
      current: { sessionId: 's2', title: '', messageCount: 0 },
      messages: [],
      started: false,
      opening,
      openingKpId,
      openingKpName: openingKpId ? '循环' : ''
    }),
    // ★ 分叉（「从这里重新问」）也要在：`resolveSessionBridge` 的必需方法清单里
    //   有它，缺一个整个桥就是 `ready:false` —— 而那时**所有**会话动作都会失败
    //   （实测踩到过：漏了这个假实现，本组用例全红，错误信息与开场语毫无关系）。
    branchSession: () => ({ ok: false, message: '未接线' }),
    deleteSession: () => ({ ok: false, message: '未接线' }),
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
        started: true,
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
        started: true,
        opening: '',
        openingKpId: ''
      }),
      startNewSession: () => ({ ok: false, message: '未接线' }),
      branchSession: () => ({ ok: false, message: '未接线' }),
      deleteSession: () => ({ ok: false, message: '未接线' }),
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
