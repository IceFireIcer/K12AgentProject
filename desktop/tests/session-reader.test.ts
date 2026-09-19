/**
 * 历史会话**只读读取**的纯逻辑断言（投影 / 搜索 / 白名单对齐 / 截断）。
 *
 * ★★ 这一组最重要的是**安全约束**：渲染进程只能递会话 id，主进程先用
 *    `SessionManager.list()` 的结果做白名单对齐，再用 Pi 给的 path 打开。
 *    下面的 `findSessionById` 断言就是那条约束的落点 —— 递一个不存在的 id、
 *    或递一个**路径**，都必须拿不到任何东西。
 *
 * ★ 另一半是「投影只取文本块」：assistant 的 content 里还有 `thinking`（思考过程）
 *   与 `toolCall`（工具参数，可能含题干/答案），它们**不该**出现在回看里。
 *
 * 这些全是纯函数（不加载 Pi、不碰文件系统），所以能直接在 `node --test` 里跑。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import type { SessionInfo } from '@earendil-works/pi-coding-agent'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

import {
  MAX_TRANSCRIPT_MESSAGES,
  SNIPPET_CONTEXT_CHARS,
  TITLE_MAX_CHARS,
  findSessionById,
  projectSessionList,
  projectTranscript,
  searchSessions,
  titleFromText,
  toMs,
  truncateChars
} from '../src/main/study/sessions.ts'

/** 造一个 `SessionInfo`（只填测试关心的字段）。 */
function info(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    path: `C:/tmp/sessions/${overrides.id}.jsonl`,
    cwd: 'C:/tmp',
    created: new Date('2026-09-17T01:00:00Z'),
    modified: new Date('2026-09-17T02:00:00Z'),
    messageCount: 4,
    firstMessage: '第一个问题',
    allMessagesText: '第一个问题\n模型的回答',
    ...overrides
  } as SessionInfo
}

// ── 白名单对齐（★ 安全约束的落点）────────────────────────────────────

test('★ 白名单对齐：只有 list() 给出的会话 id 能被找到（路径一律找不到）', () => {
  const infos = [info({ id: 'sess-a' }), info({ id: 'sess-b' })]
  assert.ok(findSessionById(infos, 'sess-a'))
  assert.ok(findSessionById(infos, 'sess-b'))
  // 关键：递路径、递不存在的东西 —— 都拿不到（于是 handlers 会拒绝）
  assert.equal(findSessionById(infos, 'C:/tmp/sessions/sess-a.jsonl'), null)
  assert.equal(findSessionById(infos, '../../config.json'), null)
  assert.equal(findSessionById(infos, ''), null)
  assert.equal(findSessionById(infos, 'sess-c'), null)
  // 精确匹配，不做前缀/模糊
  assert.equal(findSessionById(infos, 'sess'), null)
  assert.equal(findSessionById(infos, 'sess-a '), null)
})

test('★ 白名单对齐：命中的那条带回的是**Pi 给的 path**（不是调用方给的字符串）', () => {
  const infos = [info({ id: 'sess-a', path: 'C:/real/sessions/sess-a.jsonl' })]
  const found = findSessionById(infos, 'sess-a')
  assert.equal(found?.path, 'C:/real/sessions/sess-a.jsonl')
})

/**
 * ★★ 负向对照：递进来一条**真实存在的、别人的**会话文件路径 —— 必须被拒。
 *
 * 为什么这条比上面那条更值得单独写：上面递的是 `'../../config.json'` 这类
 * **一看就不像 id** 的东西，任何实现都能挡住；真正危险的是**一条合法、存在、但属于
 * 别的学生的路径**（渲染进程从别处拿到 `students/student_002/.../x.jsonl` 再递进来）——
 * 那种输入在「看起来对不对」这一层毫无破绽，只能靠**白名单对齐**挡住。
 *
 * 所以这里同时钉住两道防线（`handlers.ts` 的 `session:transcript` 与
 * `sessions.ts` 的 `readStudentSessionEntries` 各是一道）：
 *   ① 按 id 白名单查（`findSessionById`）—— 路径**永远**匹配不上一个 id；
 *   ② 路径包含判定（`isInside`）—— 即便有人绕过第一道把 `info` 直接塞给读取函数，
 *      第二道也会因为「不在本学生会话目录内」而拒绝。
 */
test('★★ 负向对照：别的学生的真实会话路径被两道防线各自拒绝', async () => {
  const { isInside, resolveStudentPiPaths } = await import('../src/main/agent/pi-paths.ts')

  const userDataDir = 'C:/tmp/k12-test-userdata'
  const mine = resolveStudentPiPaths(userDataDir, 'student_001')
  const other = resolveStudentPiPaths(userDataDir, 'student_002')

  // 一条**真实存在**的别人会话：路径形态完全合法，不是 `../../` 那种一眼可辨的穿越
  const otherStudentFile = `${other.sessionDir}/--C--k12--/2026-09-17T01-00-00.jsonl`.replace(/\\/g, '/')
  const myOwnFile = `${mine.sessionDir}/--C--k12--/2026-09-17T01-00-00.jsonl`.replace(/\\/g, '/')

  // 白名单里只有**我自己**那条（`loadSessions()` 只会列当前学生的会话）
  const infos = [info({ id: 'my-session', path: myOwnFile })]

  // ① 第一道：拿别人的路径当 id 递进来 → 查不到（handlers 随即返回「找不到会话」）
  assert.equal(
    findSessionById(infos, otherStudentFile),
    null,
    '别人的会话路径不得被当成 id 命中 —— 一旦命中，渲染进程就等于能读任意会话文件'
  )
  // 反向对照：**连自己的路径也不行**（约束是「只接受 id」，不是「只接受安全的路径」）
  assert.equal(findSessionById(infos, myOwnFile), null, '自己的路径同样不是 id，也不该命中')
  assert.ok(findSessionById(infos, 'my-session'), '而真正的 id 必须能命中（否则上面的断言可能是「什么都没找到」）')

  // ② 第二道：绕过第一道也不放行 —— 别人的路径不在我的会话目录内
  assert.equal(
    isInside(mine.sessionDir, otherStudentFile),
    false,
    '★ 别人的会话文件必须落在「我的会话目录」之外（第二道防线就靠这条包含判定）'
  )
  // 反向对照：我自己的路径确实在目录内 —— 证明上面的 false 不是因为判定写得过严
  assert.equal(isInside(mine.sessionDir, myOwnFile), true, '自己的会话路径应当在目录内')
})

// ── 会话列表投影 ───────────────────────────────────────────────────────

test('会话列表：按最后修改时间倒序，平局按 id（顺序稳定）', () => {
  const same = new Date('2026-09-17T02:00:00Z')
  const list = projectSessionList([
    info({ id: 'b', modified: same }),
    info({ id: 'a', modified: same }),
    info({ id: 'c', modified: new Date('2026-09-17T03:00:00Z') })
  ])
  assert.deepEqual(list.map((s) => s.id), ['c', 'a', 'b'])
})

test('会话列表：标题优先 name，退回首条消息，再退占位（绝不用 path 当标题）', () => {
  const list = projectSessionList([
    info({ id: 'has-name', name: '循环练习', firstMessage: '问题' }),
    info({ id: 'no-name', firstMessage: '第二个问题' }),
    info({ id: 'empty', firstMessage: '' })
  ])
  const byId = new Map(list.map((s) => [s.id, s]))
  assert.equal(byId.get('has-name')?.title, '循环练习')
  assert.equal(byId.get('no-name')?.title, '第二个问题')
  assert.equal(byId.get('empty')?.title, '（空会话）')
  // 标题里不该出现宿主路径（path 只在主进程内部用）
  for (const item of list) {
    assert.equal(item.title.includes('/'), false)
    assert.equal(item.title.includes('\\'), false)
    assert.equal(JSON.stringify(item).includes('.jsonl'), false, '摘要里不该带路径')
  }
})

test('会话列表：时间转成 Unix 毫秒；非法时间回 0（不抛）', () => {
  const list = projectSessionList([
    info({ id: 'ok', modified: new Date('2026-09-17T02:00:00Z'), created: new Date('2026-09-17T01:00:00Z') })
  ])
  assert.equal(list[0].modifiedAt, Date.parse('2026-09-17T02:00:00Z'))
  assert.equal(list[0].createdAt, Date.parse('2026-09-17T01:00:00Z'))
  assert.equal(toMs(new Date('invalid')), 0)
  assert.equal(toMs(undefined), 0)
  assert.equal(toMs('not a date'), 0)
  assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000)
})

// ── 字符截断（不按字节）──────────────────────────────────────────────

test('★ 截断按字符：不会把汉字 / emoji 切一半', () => {
  assert.equal(truncateChars('一二三四五', 3), '一二三…')
  assert.equal(truncateChars('abc', 10), 'abc')
  // emoji 是一个代理对（utf-16 里 length === 2）：按字符切才安全
  const emoji = '😀😀😀😀'
  const cut = truncateChars(emoji, 2)
  assert.equal(cut, '😀😀…')
  assert.equal([...cut].length, 3, '两个 emoji + 省略号')
  // 没有出现半个代理对（孤立的 surrogate 表现为 U+FFFD 或被拆开）
  assert.equal(cut.includes('\uFFFD'), false)
})

test('标题：压掉换行与多余空白，空文本给占位', () => {
  assert.equal(titleFromText('  第一行\n第二行  '), '第一行 第二行')
  assert.equal(titleFromText('   '), '未命名')
  assert.equal(Array.from(titleFromText('学'.repeat(100))).length, TITLE_MAX_CHARS + 1)
})

// ── 会话正文投影（★ 只取文本块）──────────────────────────────────────

test('★ 会话正文：只取 user/assistant 的文本块，思考与工具调用一律不要', () => {
  const entries = [
    { type: 'message', timestamp: '2026-09-17T01:00:00Z', message: { role: 'user', content: '什么是循环？' } },
    {
      type: 'message',
      timestamp: '2026-09-17T01:00:05Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '学生问的是循环，我该先举例子' },
          { type: 'text', text: '循环就是让一段代码重复执行。' },
          { type: 'toolCall', id: 'call-1', name: 'generate_quiz', arguments: { answer: '秘密答案' } }
        ]
      }
    }
  ]
  const { messages, truncated } = projectTranscript(entries)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].text, '什么是循环？')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].text, '循环就是让一段代码重复执行。')
  assert.equal(truncated, 0)
  // ★ 思考与工具参数里的内容一个字都不许出现
  const dump = JSON.stringify(messages)
  assert.equal(dump.includes('该先举例子'), false, '思考过程不该进回看')
  assert.equal(dump.includes('generate_quiz'), false, '工具名不该进回看')
  assert.equal(dump.includes('秘密答案'), false, '工具参数不该进回看')
})

test('会话正文：非 message 条目被跳过（model_change / thinking_level_change 等）', () => {
  const entries = [
    { type: 'session', id: 'sess-a' },
    { type: 'model_change', provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    { type: 'thinking_level_change', thinkingLevel: 'high' },
    { type: 'message', message: { role: 'user', content: '你好' } },
    { type: 'custom_message', content: '系统注入的内容' }
  ]
  const { messages } = projectTranscript(entries)
  assert.deepEqual(messages.map((m) => m.text), ['你好'])
})

test('会话正文：脏数据不抛（缺 role / content 形态不对 / 空文本一律忽略）', () => {
  const entries = [
    null,
    'not an object',
    { type: 'message' },
    { type: 'message', message: null },
    { type: 'message', message: { role: 'system', content: '系统提示' } },
    { type: 'message', message: { role: 'user', content: '' } },
    { type: 'message', message: { role: 'user', content: [null, 42, { type: 'text' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'x' }] } },
    { type: 'message', message: { role: 'user', content: '有效的一条' } }
  ]
  const { messages } = projectTranscript(entries)
  assert.deepEqual(messages.map((m) => m.text), ['有效的一条'])
})

test('会话正文：超过上限时保留**最近**的 N 条并报出截断数', () => {
  const entries = Array.from({ length: 10 }, (_unused, index) => ({
    type: 'message',
    message: { role: 'user', content: `第 ${index} 条` }
  }))
  const { messages, truncated } = projectTranscript(entries, { limit: 3 })
  assert.deepEqual(messages.map((m) => m.text), ['第 7 条', '第 8 条', '第 9 条'])
  assert.equal(truncated, 7)
})

test('会话正文：默认上限是个有限值（防超长会话撑爆 IPC 载荷）', () => {
  assert.ok(Number.isFinite(MAX_TRANSCRIPT_MESSAGES))
  assert.ok(MAX_TRANSCRIPT_MESSAGES > 0 && MAX_TRANSCRIPT_MESSAGES <= 1000)
})

// ── 搜索 ───────────────────────────────────────────────────────────────

test('搜索：命中全文并给出片段，标题也参与匹配', () => {
  const infos = [
    info({ id: 'a', allMessagesText: '什么是循环？\n循环就是让代码重复执行。' }),
    info({ id: 'b', allMessagesText: '完全无关的内容' }),
    info({ id: 'c', name: '循环练习', allMessagesText: '没有这个词' })
  ]
  const hits = searchSessions(infos, '循环')
  assert.deepEqual(hits.map((h) => h.id).sort(), ['a', 'c'])
  assert.match(hits.find((h) => h.id === 'a')!.snippet, /循环/)
})

test('搜索：空查询返回空数组（不是「全部命中」）', () => {
  assert.deepEqual(searchSessions([info({ id: 'a' })], ''), [])
  assert.deepEqual(searchSessions([info({ id: 'a' })], '   '), [])
})

test('搜索：大小写不敏感；片段有长度上限；换行被压成空格', () => {
  const long = `${'甲'.repeat(200)}KEYWORD${'乙'.repeat(200)}`
  const hits = searchSessions([info({ id: 'a', allMessagesText: long })], 'keyword')
  assert.equal(hits.length, 1, '大小写不敏感')
  const snippet = hits[0].snippet
  assert.ok(snippet.length <= 2 * SNIPPET_CONTEXT_CHARS + 'KEYWORD'.length + 2, `片段太长：${snippet.length}`)
  assert.equal(snippet.includes('\n'), false, '片段应当是单行')
  assert.ok(snippet.includes('…'), '掐头去尾时应当有省略号')
})

test('搜索：结果按最后修改时间倒序，并受条数上限约束', () => {
  const infos = Array.from({ length: 30 }, (_unused, index) =>
    info({
      id: `s${String(index).padStart(2, '0')}`,
      allMessagesText: '共同关键词',
      modified: new Date(1_700_000_000_000 + index * 1000)
    })
  )
  const hits = searchSessions(infos, '共同关键词', { limit: 5 })
  assert.equal(hits.length, 5)
  assert.deepEqual(
    hits.map((h) => h.id),
    ['s29', 's28', 's27', 's26', 's25'],
    '越新的会话应当排在越前面'
  )
})

test('搜索：命中在开头 / 结尾时不加多余的省略号', () => {
  const hits = searchSessions([info({ id: 'a', allMessagesText: '关键词在开头' })], '关键词')
  assert.equal(hits[0].snippet.startsWith('…'), false)
  const tail = searchSessions([info({ id: 'a', allMessagesText: '结尾有关键词' })], '关键词')
  assert.equal(tail[0].snippet.endsWith('…'), false)
})

/* ------------------------------------------------------------------ *
 * ★★ cwd 一致性：建会话与列会话必须用**同一个** cwd
 * ------------------------------------------------------------------ */

test('★★ 「列出历史会话」与「建会话」必须用同一个 cwd（写错就是列表恒为空）', () => {
  // 缺陷形态（实测踩到，见 `pi-paths.ts` 的 `piSessionCwd` 注释与 P-102）：
  //   Pi 的 `SessionManager.list(cwd, sessionDir)` 在**传了自定义 sessionDir** 时
  //   会**额外按 cwd 过滤**（源码：`filterCwd` + `sessionCwdMatches`）。
  //   于是「建会话用 A、列会话用 B」的结果是**列表恒为空** ——
  //   不报错、不告警、文件全在盘上，只是历史会话一条都看不见。
  //   实测：建会话用 `<studentDir>/pi-agent`，列表却用 `<studentDir>` ⇒ 0 条
  //   （而同一目录下实际有 19 个会话文件）。
  //
  // 这项判据只有真跑一次 Pi 才测得出来（喂假对象测不到），所以这里做**源码级**断言：
  // 两处必须都经由 `piSessionCwd()` 取 cwd —— 任何一处写回字面量就是漂移的起点。
  const runtime = readFileSync(
    join(desktopRoot, 'src', 'main', 'agent', 'runtime.ts'),
    'utf8'
  )
  const sessions = readFileSync(
    join(desktopRoot, 'src', 'main', 'study', 'sessions.ts'),
    'utf8'
  )

  assert.match(
    runtime,
    /piSessionCwd\(paths\)/,
    '★ 建会话（runtime.ts 的 openSessionManager）必须用 piSessionCwd(paths) 取 cwd'
  )
  assert.match(
    sessions,
    /SessionManager\.list\(piSessionCwd\(paths\),\s*paths\.sessionDir\)/,
    '★★ 列出会话必须用**同一个** piSessionCwd(paths)：用别的值会让列表恒为空'
  )
  // 反向对照：不许再出现「用 studentDir 当 list 的 cwd」那种写法
  assert.doesNotMatch(
    sessions,
    /SessionManager\.list\(paths\.studentDir/,
    '★ 不许用 paths.studentDir 当 list 的 cwd —— 那与会话文件里记的 cwd 不一致（列表恒为空）'
  )
})
