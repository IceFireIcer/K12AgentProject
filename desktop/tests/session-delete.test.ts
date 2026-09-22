/**
 * 删除历史会话（2026-09-22）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 删除是**本项目唯一会真的丢东西的操作**（对话不在 SQLite 里 —— 它只在 Pi 的 JSONL 里，
 * 删了就是删了）。Pi SDK（0.85.1）又**没有任何删除 API**（`SessionManager` 只有
 * list/open/create/continueRecent/createBranchedSession），所以从选路径到 unlink
 * 都得自己做。因此这里守四类形态：
 *
 * 1. ★★ **路径只能来自白名单**（id → Pi 给的 path），且必须落在**当前学生**的会话目录里 ——
 *    少任何一道，「删除」就变成了「渲染进程指哪删哪」；
 * 2. ★★ **删当前会话前必须先切走**（先 `swapToSession` 再 `unlink`）：反过来的话
 *    Pi 还持有那个文件、下一次 flush 会把它**重新写出来**（学生以为删掉了，其实还在）；
 * 3. ★★ **失败不许假装成功**（invoke 有回执）：删不掉时要回一句人话，
 *    而界面**不清空**当前对话；正在回答时直接拒绝；
 * 4. ★ **入口要点两下**（右键菜单 → 确认框）：学生右键一条列表项时最常见的心思
 *    是「看看有什么能做的」，菜单一出现就删掉是「手一抖什么都没了」。
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
const SESSIONS = 'src/main/study/sessions.ts'
const CHANNELS = 'src/main/ipc/channels.ts'
const SESSION_LIST = 'src/renderer/src/components/SessionList.vue'

/** 会话目录（判据里的 `sessionDir`；用 posix 风格，`isInside` 在 Windows 上也能吃）。 */
const SESSION_DIR = join('C:', 'userData', 'students', 'k12-demo', 'pi-agent', 'sessions')

/* ------------------------------------------------------------------ *
 * 1. ★★ 两道防线（纯函数，负向对照）
 * ------------------------------------------------------------------ */

test('★★ 白名单对齐：只认列表里的 id，path 由 Pi 给（前端递的字符串只是 id）', async () => {
  const { resolveDeletionTarget } = await import('../src/main/study/sessions.ts')
  const infos = [
    { id: 'sess-a', path: join(SESSION_DIR, '2026-01-01_a.jsonl') },
    { id: 'sess-b', path: join(SESSION_DIR, '2026-01-02_b.jsonl') }
  ]

  const hit = resolveDeletionTarget({ infos, id: 'sess-a', sessionDir: SESSION_DIR })
  assert.equal(hit.ok, true)
  assert.equal(hit.ok && hit.path, join(SESSION_DIR, '2026-01-01_a.jsonl'), '★ 拿到的必须是列表里那条自己的 path')

  // ★ 找不到的 id 按**幂等成功**回（path: null = 什么都不删）：
  //   目标状态已达成（另一处删过 / 上次删到一半），报成失败只会让学生反复重试。
  const missing = resolveDeletionTarget({ infos, id: 'sess-not-here', sessionDir: SESSION_DIR })
  assert.deepEqual(missing, { ok: true, path: null }, '★ 找不到这条 → 幂等成功（什么都不删）')

  const empty = resolveDeletionTarget({ infos, id: '   ', sessionDir: SESSION_DIR })
  assert.equal(empty.ok, false, '★ 空 id 必须拒绝（不许退化成「删点什么」）')
})

test('★★ 目录包含：别的学生的会话路径必须被拒（负向对照）', async () => {
  const { resolveDeletionTarget } = await import('../src/main/study/sessions.ts')
  // 另一学生的会话文件：即使它真的出现在列表里（比如列表被投毒、或将来支持多学生），
  // 第二道防线也必须挡住 —— 这是「跨学生隔离」在删除这条路上的最后一关。
  const otherStudent = join('C:', 'userData', 'students', 'someone-else', 'pi-agent', 'sessions', 'x.jsonl')
  const refused = resolveDeletionTarget({
    infos: [{ id: 'sess-x', path: otherStudent }],
    id: 'sess-x',
    sessionDir: SESSION_DIR
  })
  assert.equal(refused.ok, false, '★★ 不在当前学生会话目录里的路径必须拒绝（删除是不可撤销的）')

  // ★ 前缀陷阱：`.../sessions-evil/x.jsonl` 字符串上「以 sessions 开头」，
  //   但它不是 sessions 目录里的文件。`isInside` 用相对路径算，所以要挡住它。
  const sibling = join('C:', 'userData', 'students', 'k12-demo', 'pi-agent', 'sessions-evil', 'x.jsonl')
  const refusedSibling = resolveDeletionTarget({
    infos: [{ id: 'sess-y', path: sibling }],
    id: 'sess-y',
    sessionDir: SESSION_DIR
  })
  assert.equal(refusedSibling.ok, false, '★ 兄弟目录（前缀相同的 `sessions-evil`）也必须拒绝')
})

test('★ 判据收口在一个纯函数里（处理器只能调它，不许自己拼判据）', () => {
  const source = stripComments(read(SESSIONS))
  assert.match(source, /export function resolveDeletionTarget\(/, '唯一实现必须在 study/sessions.ts（可单测）')
  assert.match(source, /isInside\(options\.sessionDir, info\.path\)/, '★ 目录包含那道防线必须真的在这里')
  const handlers = stripComments(read(HANDLERS))
  assert.match(handlers, /resolveDeletionTarget\(\{/, '处理器必须调它')
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 处理器：顺序、拒绝、回执
 * ------------------------------------------------------------------ */

test('★★ 删当前会话：必须先切到新会话，**再**删文件（顺序反了 Pi 会把它写回来）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function deleteSessionById(')
  assert.ok(at > 0, '找不到 deleteSessionById')
  const body = source.slice(at, source.indexOf('\n}\n', at))
  const swapAt = body.indexOf('await swapToSession(')
  const unlinkAt = body.indexOf('await unlink(')
  assert.ok(swapAt > 0, '★ 删当前会话前必须先切走（`await swapToSession({ kind: \'new\' })`）')
  assert.ok(unlinkAt > swapAt, '★★ 顺序必须是「先切后删」：先删文件的话，Pi 还持有它，下一次 flush 会把它重新写出来')
  // 切换失败就不许走到 unlink
  assert.match(
    body,
    /if \(!swapped\.ok\)[\s\S]{0,200}return/,
    '★ 切不过去就**不删**（宁可留着一条对话，也不让学生既没删成、当前会话也没了）'
  )
})

test('★★ unlink 之前要**再核一次**路径（中间隔着一次 swapToSession）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function deleteSessionById(')
  const body = source.slice(at, source.indexOf('\n}\n', at))
  const guardAt = body.lastIndexOf('isInside(')
  const unlinkAt = body.indexOf('await unlink(')
  assert.ok(guardAt > 0, '★ 破坏性操作前必须复核路径在不在当前学生的会话目录里')
  assert.ok(unlinkAt > guardAt, '★ 那次复核必须在 unlink **之前**')
})

test('★★ 正在回答时拒绝删除当前会话（dispose 会与飞行中的轮次打架）', () => {
  const source = stripComments(read(HANDLERS))
  const at = source.indexOf('async function deleteSessionById(')
  const body = source.slice(at, source.indexOf('\n}\n', at))
  assert.match(body, /chatStreams\.activeTurns > 0/, '★ 有轮次在飞时必须拒绝（学生也正看着那句回答）')
  assert.match(body, /ok: false/, '★ 拒绝要回可读中文，不是抛异常')
})

test('★ 回执只回 id 与一句人话（**不回路径**：宿主目录结构不进渲染进程）', () => {
  const source = stripComments(read(CHANNELS))
  const at = source.indexOf('export type SessionDeleteResult')
  assert.ok(at > 0, '找不到 SessionDeleteResult')
  const body = source.slice(at, at + 500)
  assert.match(body, /ok: true; id: string/, '★ 成功只回 id')
  assert.match(body, /ok: false; message: string/, '★ 失败回一句可读中文')
  assert.doesNotMatch(body, /path/, '★★ 不许把路径回给渲染进程（与 file:export 只回文件名同一条纪律）')
})

test('★ 通道登记齐全：IPC 表 + preload 白名单（**不进** PUSH_CHANNELS）', () => {
  const channels = read(CHANNELS)
  assert.match(channels, /sessionDelete: 'session:delete'/, '★ 通道名要在唯一来源里登记')
  const preload = read('src/preload/index.ts')
  assert.match(preload, /IPC\.sessionDelete/, '★ preload 白名单要登记')
  assert.match(preload, /deleteSession: \(sessionId\)/, '★ preload 要暴露 deleteSession 方法')
  const push = /export\s+const\s+PUSH_CHANNELS[^=]*=\s*\[([\s\S]*?)\]/.exec(channels)?.[1] ?? ''
  assert.doesNotMatch(push, /sessionDelete/, '★ 删除是 invoke（有回执），不许进 PUSH_CHANNELS')
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 界面：入口、确认、文案
 * ------------------------------------------------------------------ */

test('★★ 入口要点两下：右键 → 确认框（danger），文案是学生的话', () => {
  const source = read(SESSION_LIST)
  assert.match(source, /@contextmenu\.prevent="openMenu\(item, \$event, false\)"/, '★ 行上要能右键弹出菜单')
  assert.match(source, /data-testid="session-delete-action"/, '★ 菜单里要有一项「删除这条对话」')
  assert.match(source, /danger: true/, '★★ 确认框必须是 danger（红色）—— 删掉不可撤销')
  const at = source.indexOf('async function removeSession(')
  const body = source.slice(at, source.indexOf('\n}\n', at))
  assert.ok(
    body.indexOf('await confirm.ask(') < body.indexOf('chat.deleteSession('),
    '★★ 顺序：先确认、再删 —— 「先删再弹个提示」等于没确认'
  )
  // 文案是学生的话：不出现内部词
  const bodyAt = source.indexOf('function deleteBody(')
  const copy = source.slice(bodyAt, source.indexOf('\n}\n', bodyAt))
  for (const term of ['JSONL', 'jsonl', '路径', '服务端', '文件系统', 'SQLite']) {
    assert.ok(!copy.includes(term), `★ 删除的说明里不该出现「${term}」（学生看不懂，也不该看到）`)
  }
  assert.match(copy, /找不回来/, '★ 要说清「不可撤销」')
})

test('★ ⋯ 触发器与右键弹**同一个**菜单，且是 `.sl__item` 的兄弟节点（按钮不能套按钮）', () => {
  const source = read(SESSION_LIST)
  assert.match(source, /data-testid="`session-more-\$\{item\.id\}`"/, '★ 要有 ⋯ 触发器（右键之外的可发现入口）')
  assert.match(source, /@click\.stop="openMenu\(item, \$event, true\)"/, '★ 它要与右键共用同一个菜单')
  // ★ 结构判据：`.sl__item` 那个按钮必须先闭合，⋯ 才出现（HTML 不许按钮套按钮）
  const itemAt = source.indexOf('class="sl__item"')
  const moreAt = source.indexOf('class="sl__more"')
  assert.ok(itemAt > 0 && moreAt > itemAt, '找不到 sl__item / sl__more 的相对位置')
  assert.ok(
    source.slice(itemAt, moreAt).includes('</button>'),
    '★★ ⋯ 必须是 `.sl__item` 的**兄弟节点**：按钮里套按钮是非法嵌套（浏览器会把它拆开，点击行为随实现而变）'
  )
})

test('★ 删完刷新列表；删的是当前会话时把屏幕对齐（不许留着一段已经不存在的对话）', () => {
  const source = read(SESSION_LIST)
  const at = source.indexOf('async function removeSession(')
  const body = source.slice(at, source.indexOf('\n}\n', at))
  assert.match(body, /await study\.loadSessions\(\)/, '★ 删完必须重取列表（这一条已经不在盘上了）')

  const store = read('src/renderer/src/stores/chat.ts')
  const storeAt = store.indexOf('async function deleteSession(')
  const storeBody = store.slice(storeAt, store.indexOf('\n  }\n', storeAt))
  assert.match(
    storeBody,
    /applyCurrentSessionState\(\{ replace: true \}\)/,
    '★★ 删掉当前会话后必须重新对齐（补读一次状态）：主进程已经切到一条新的空白会话，' +
      '不补读的话屏幕上会留着刚被删掉的那段对话'
  )
  assert.match(
    storeBody,
    /if \(!result\.ok\) return \{ ok: false/,
    '★ 失败要原样回传主进程那句人话（不许吞掉、也不许假装成功）'
  )
})

/* ------------------------------------------------------------------ *
 * 4. ★★ 行为面：store 的删除路径
 * ------------------------------------------------------------------ */

function installSessionBridge(overrides: Record<string, (...args: unknown[]) => unknown> = {}): {
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const defaults: Record<string, (...args: unknown[]) => unknown> = {
    getSessionState: () => ({
      ok: true,
      current: { sessionId: 'sess-fresh', title: '', messageCount: 1 },
      messages: [],
      started: false,
      opening: '你好，我是智团团。我们从人工智能的定义开始吧。',
      openingKpId: 'ai-definition-pl'
    }),
    openSession: () => ({ ok: false, message: '未接线' }),
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
  const api: Record<string, unknown> = {}
  for (const [name, impl] of Object.entries({ ...defaults, ...overrides })) {
    api[name] = (...args: unknown[]): unknown => {
      calls.push({ method: name, args })
      return impl(...args)
    }
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return { calls }
}

test('★★ 删掉**当前**会话 → 屏幕切换到新会话（不留下已被删除的那段对话）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    const { calls } = installSessionBridge({
      deleteSession: () => Promise.resolve({ ok: true, id: 'sess-current' }),
      // 主进程删完当前会话后已经切到一条新的空白会话，补读时拿到它的状态
      getSessionState: () => ({
        ok: true,
        current: { sessionId: 'sess-fresh', title: '', messageCount: 1 },
        messages: [],
        started: false,
        opening: '你好，我是智团团。',
        openingKpId: ''
      })
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    // 先造出「正在聊 sess-current」的样子
    chat.currentSessionId = 'sess-current'
    chat.conversation = restoreConversation([{ role: 'user', text: '刚才问的', at: 1 }])
    assert.equal(chat.turns.length, 1)

    const result = await chat.deleteSession('sess-current')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(
      calls.filter((call) => call.method === 'deleteSession').length,
      1,
      '★ 只该调一次 deleteSession'
    )
    assert.equal(chat.currentSessionId, 'sess-fresh', '★ 界面跟到主进程新开的那条会话上')
    assert.equal(chat.turns.length, 0, '★★ 被删掉的那段对话不许留在屏幕上')
    assert.equal(chat.showOpening, true, '★ 新会话的开场引导要跟着显示（主进程补读了状态）')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★★ 删除失败 → 原样回传一句人话，**当前对话一个字节都不动**', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installSessionBridge({
      deleteSession: () => Promise.resolve({ ok: false, message: '删除失败：这条对话正在回答，等它讲完再删。' })
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    chat.currentSessionId = 'sess-current'
    chat.conversation = restoreConversation([{ role: 'user', text: '刚才问的', at: 1 }])

    const result = await chat.deleteSession('sess-current')
    assert.equal(result.ok, false)
    assert.equal(result.message, '删除失败：这条对话正在回答，等它讲完再删。', '★ 主进程那句人话要原样给界面')
    assert.equal(chat.turns.length, 1, '★★ 失败时绝不清空当前对话（清空了又什么都没恢复是最坏的失败）')
    assert.equal(chat.currentSessionId, 'sess-current')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 删一条**不是当前**的会话 → 当前对话原样不动（只是列表少了一条）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    const { calls } = installSessionBridge({
      deleteSession: () => Promise.resolve({ ok: true, id: 'sess-other' })
    })
    const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
    const { restoreConversation } = await import('../src/renderer/src/api/events.ts')
    setActivePinia(createPinia())
    const chat = useChatStore()

    chat.currentSessionId = 'sess-current'
    chat.conversation = restoreConversation([{ role: 'user', text: '刚才问的', at: 1 }])

    const result = await chat.deleteSession('sess-other')
    assert.equal(result.ok, true)
    assert.equal(chat.turns.length, 1, '★ 当前对话不受影响')
    assert.equal(chat.currentSessionId, 'sess-current')
    assert.equal(
      calls.filter((call) => call.method === 'getSessionState').length,
      0,
      '★ 删的不是当前那条时不必补读状态（省一次 IPC，也不会有覆盖当前对话的风险）'
    )
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})
