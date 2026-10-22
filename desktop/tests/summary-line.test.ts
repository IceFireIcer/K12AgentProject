/**
 * 画像小结（学习档案「五行结构」的第五行）的守卫 —— 此前**一个用例都没有**。
 *
 * ★ 为什么这一组必须有（2026-10-22 补）：全仓 `desktop/tests/` 里没有任何文件引用
 *   `summary-line` / `generateSummaryLine` / `SUMMARY_LINE_*`，而它做了四件
 *   「错了就静默出事」的事：
 *     ① **两道词表过滤**（禁心理诊断词 + 禁能力评价词 / 禁技术词）；
 *     ② **长度窗口**（太短视为没写完、太长截断）；
 *     ③ **缓存按学生隔离**（禁做 #9：文件里同住着别人的小结，拿错了就是把 B 的给 A 看）；
 *     ④ **指纹复用**（画像没变就不该再打一次模型）。
 *
 * 跑法：node --test tests/summary-line.test.ts
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  buildSummaryLinePayload,
  generateSummaryLine,
  parseSummaryLine,
  readSummaryLineCache,
  summaryCachePath,
  tagFingerprint,
  writeSummaryLineCache,
  SUMMARY_LINE_FORBIDDEN_WORDS,
  SUMMARY_LINE_MAX_ATTEMPTS,
  SUMMARY_LINE_MAX_CHARS,
  SUMMARY_LINE_MIN_CHARS,
  SUMMARY_LINE_TECH_WORDS
} from '../src/main/agent/profile-refresh/summary-line.ts'

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function freshDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'k12-summary-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 造一条「合法」的小结正文（长度落在窗口内、不含任何违禁词）。 */
function goodText(): string {
  return '你最近在练分数和循环，喜欢先看例子再动手。我们下次可以多做一点需要自己推导的题。'
}

const TAGS = [
  { key: 'subject', value: '数学' },
  { key: 'explain_style', value: '生活例子' }
]

/** 一次成功的模型回执。 */
function okResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

/* ------------------------------------------------------------------ *
 * ① 解析与清洗
 * ------------------------------------------------------------------ */

test('S-1 正常小结原样通过；代码块围栏与首尾引号被剥掉', () => {
  const text = goodText()
  assert.equal(parseSummaryLine(text), text)
  assert.equal(parseSummaryLine('```\n' + text + '\n```'), text)
  assert.equal(parseSummaryLine('「' + text + '」'), text)
  // 多行会被单行化（小结是一段话，换行会被界面读成两段）
  assert.ok(!parseSummaryLine(text.slice(0, 30) + '\n' + text.slice(30)).includes('\n'))
})

test('S-2 ★ 禁心理诊断 / 禁能力评价：命中即整段丢弃（不是截断）', () => {
  // 每一个违禁词都必须真的被挡住 —— 这是「不能给孩子贴标签」的可执行形态
  for (const word of SUMMARY_LINE_FORBIDDEN_WORDS) {
    const text = '你最近学得很认真，' + word + '，我们继续把这一章练完。'
    assert.equal(parseSummaryLine(text), '', `含「${word}」的小结必须整段丢掉`)
  }
  // 褒义的能力评价同样禁止（它诱发固定型思维）
  assert.ok(SUMMARY_LINE_FORBIDDEN_WORDS.includes('聪明'), '「聪明」必须在禁词里（褒义也禁）')
})

test('S-3 ★ 技术词不上学生面：标签 / 数据 / 系统 / 模型 / AI / 算法 一律丢弃', () => {
  for (const word of SUMMARY_LINE_TECH_WORDS) {
    const text = '你最近在练分数，我在' + word + '里记下了你的偏好，下次继续。'
    assert.equal(parseSummaryLine(text), '', `含技术词「${word}」的小结必须整段丢掉`)
  }
})

test('S-4 长度窗口：太短视为没写完；太长截断到上限', () => {
  assert.equal(parseSummaryLine('好。'), '', `短于 ${SUMMARY_LINE_MIN_CHARS} 字视为没写完`)
  assert.equal(parseSummaryLine(''), '')
  const long = '你最近在练分数和循环。'.repeat(40)
  const parsed = parseSummaryLine(long)
  assert.equal(parsed.length, SUMMARY_LINE_MAX_CHARS, '超长必须截到上限')
})

test('S-5 脏输入稳健：非字符串 / 全空白 / 只有围栏 → 空串', () => {
  for (const bad of [null, undefined, 42, {}, '   ', '```\n```']) {
    assert.equal(parseSummaryLine(bad as never), '')
  }
})

/* ------------------------------------------------------------------ *
 * ② 载荷
 * ------------------------------------------------------------------ */

test('S-6 ★ 载荷只有标签：没有称呼字段 / 没有对话正文（与 refresh 同一红线）', () => {
  const payload = buildSummaryLinePayload({ knownTags: TAGS })
  const joined = payload.system + '\n' + payload.user
  assert.ok(joined.includes('subject=数学'), '标签要以 key=value 形态送出去')
  assert.ok(joined.includes('explain_style=生活例子'))
  // ⚠️ 判据是**字段名**，不是「真名」二字 —— 后者出现在 system prompt 的禁令原文里
  //   （「不含真名、学校、班级、联系方式」），拿它当泄漏判据会误伤。
  assert.ok(!/displayName|realName|studentName/.test(joined), '载荷里不许出现称呼类字段')
  assert.ok(!/nickname/i.test(joined), '载荷里不许出现昵称字段')
  // ★ 结构上的事实：载荷输入只有 knownTags 一个字段（不靠调用方自觉不传）
  assert.deepEqual(Object.keys({ knownTags: TAGS }), ['knownTags'])
})

test('S-7 载荷对白名单外 / join 钥匙 / 空标签稳健', () => {
  const payload = buildSummaryLinePayload({
    knownTags: [
      { key: 'anon_student_id', value: 'stu_1' },
      { key: 'not_a_tag', value: 'x' },
      { key: 'subject', value: '数学' }
    ]
  })
  assert.ok(!payload.user.includes('anon_student_id'), 'join 钥匙不进载荷')
  assert.ok(!payload.user.includes('not_a_tag'), '白名单外的键不进载荷')
  assert.ok(payload.user.includes('subject=数学'))
  // 一条都没有 → 明确的空态，而不是空字符串
  assert.ok(buildSummaryLinePayload({ knownTags: [] }).user.includes('（暂无）'))
})

/* ------------------------------------------------------------------ *
 * ③ 缓存（按学生隔离 = 禁做 #9）
 * ------------------------------------------------------------------ */

test('S-8 缓存读-改-写：写一个学生不抹掉另一个学生', () => {
  const { dir, cleanup } = freshDir()
  try {
    writeSummaryLineCache(dir, {
      studentId: 'stu_a',
      text: 'A 的小结',
      generatedAt: 1,
      tagFingerprint: 'fp-a'
    })
    writeSummaryLineCache(dir, {
      studentId: 'stu_b',
      text: 'B 的小结',
      generatedAt: 2,
      tagFingerprint: 'fp-b'
    })
    assert.equal(readSummaryLineCache(dir, 'stu_a')?.text, 'A 的小结')
    assert.equal(readSummaryLineCache(dir, 'stu_b')?.text, 'B 的小结')
    // 再写一次 A，B 仍在（读-改-写，不是整份覆盖）
    writeSummaryLineCache(dir, {
      studentId: 'stu_a',
      text: 'A 的新小结',
      generatedAt: 3,
      tagFingerprint: 'fp-a2'
    })
    assert.equal(readSummaryLineCache(dir, 'stu_a')?.text, 'A 的新小结')
    assert.equal(readSummaryLineCache(dir, 'stu_b')?.text, 'B 的小结', 'B 的条目必须还在')
  } finally {
    cleanup()
  }
})

test('S-9 ★ 读缓存必须核对 studentId（拿不到就是 null，绝不返回别人的）', () => {
  const { dir, cleanup } = freshDir()
  try {
    writeSummaryLineCache(dir, {
      studentId: 'stu_a',
      text: 'A 的小结',
      generatedAt: 1,
      tagFingerprint: 'fp'
    })
    assert.equal(readSummaryLineCache(dir, 'stu_b'), null, '文件里没有 B，就必须回 null')
    assert.equal(readSummaryLineCache(dir, ''), null, '空 studentId 一律 null')
  } finally {
    cleanup()
  }
})

test('S-10 缓存文件坏了 / 不存在 → 读回 null（不是错误路径）', () => {
  const { dir, cleanup } = freshDir()
  try {
    assert.equal(readSummaryLineCache(dir, 'stu_a'), null, '文件不存在 → null')
    // 坏文件：先建目录（写缓存自己会 mkdir，这里要手动造一个坏文件）
    mkdirSync(dirname(summaryCachePath(dir)), { recursive: true })
    writeFileSync(summaryCachePath(dir), '{ 这不是 JSON', 'utf8')
    assert.equal(readSummaryLineCache(dir, 'stu_a'), null, '坏文件 → null，不抛')
    // 坏文件也不阻断写入（从头建一份）
    writeSummaryLineCache(dir, {
      studentId: 'stu_a',
      text: '新的小结',
      generatedAt: 1,
      tagFingerprint: 'fp'
    })
    assert.equal(readSummaryLineCache(dir, 'stu_a')?.text, '新的小结')
  } finally {
    cleanup()
  }
})

test('S-11 指纹只看白名单键、与顺序无关、值变了才变', () => {
  const a = tagFingerprint([
    { key: 'subject', value: '数学' },
    { key: 'pace', value: '慢' }
  ])
  const b = tagFingerprint([
    { key: 'pace', value: '慢' },
    { key: 'subject', value: '数学' }
  ])
  assert.equal(a, b, '指纹必须与输入顺序无关（否则每轮都在变）')
  const c = tagFingerprint([
    { key: 'subject', value: '数学' },
    { key: 'pace', value: '快' }
  ])
  assert.notEqual(a, c, '值变了指纹必须变')
  // 白名单外的键不参与（它进不了载荷，也就不该影响指纹）
  assert.equal(a, tagFingerprint([{ key: 'subject', value: '数学' }, { key: 'pace', value: '慢' }, { key: 'nope', value: 'x' }]))
})

/* ------------------------------------------------------------------ *
 * ④ 编排（generateSummaryLine）
 * ------------------------------------------------------------------ */

function makeDeps(dir: string, options: { reply?: string; calls?: { n: number }; noConfig?: boolean }) {
  const calls = options.calls ?? { n: 0 }
  return {
    getConfig: async () =>
      options.noConfig
        ? null
        : { baseUrl: 'https://example.test/v1', modelId: 'm', apiKey: 'sk-test' },
    userDataDir: dir,
    fetchResponse: async () => {
      calls.n += 1
      return okResponse(options.reply ?? goodText())
    }
  }
}

test('S-12 没有可用配置 → 什么都不做（不写缓存、不调模型）', async () => {
  const { dir, cleanup } = freshDir()
  try {
    const calls = { n: 0 }
    const text = await generateSummaryLine('stu_a', TAGS, makeDeps(dir, { calls, noConfig: true }))
    assert.equal(text, '')
    assert.equal(calls.n, 0, '没有配置时不该发任何请求')
    assert.equal(readSummaryLineCache(dir, 'stu_a'), null)
  } finally {
    cleanup()
  }
})

test('S-13 成功 → 写缓存，且第二次同指纹不再调模型（★ 指纹复用）', async () => {
  const { dir, cleanup } = freshDir()
  try {
    const calls = { n: 0 }
    const first = await generateSummaryLine('stu_a', TAGS, makeDeps(dir, { calls }))
    assert.equal(first, goodText())
    assert.equal(calls.n, 1, '第一次应当调一次模型')
    assert.equal(readSummaryLineCache(dir, 'stu_a')?.text, goodText())

    // ★ 画像没变（同一批标签）→ 直接复用缓存，一次模型调用都不发
    const second = await generateSummaryLine('stu_a', TAGS, makeDeps(dir, { calls }))
    assert.equal(second, goodText())
    assert.equal(calls.n, 1, '★ 指纹相同就不该再打模型（否则每次画像刷新都白花一次调用）')

    // 画像变了 → 必须重新生成
    const third = await generateSummaryLine(
      'stu_a',
      [...TAGS, { key: 'pace', value: '慢' }],
      makeDeps(dir, { calls })
    )
    assert.equal(third, goodText())
    assert.equal(calls.n, 2, '标签变了必须重新生成')
  } finally {
    cleanup()
  }
})

test('S-14 模型回执不合法（命中禁词 / 太短）→ 不写缓存，保留旧值', async () => {
  const { dir, cleanup } = freshDir()
  try {
    const calls = { n: 0 }
    await generateSummaryLine('stu_a', TAGS, makeDeps(dir, { calls }))
    assert.equal(readSummaryLineCache(dir, 'stu_a')?.text, goodText())

    // 第二次：画像变了（强制重新生成），但模型回了含禁词的文本
    const bad = await generateSummaryLine(
      'stu_a',
      [...TAGS, { key: 'pace', value: '慢' }],
      makeDeps(dir, { calls, reply: '你很聪明，最近在练分数。我们下次继续把这一章练完就好。' })
    )
    assert.equal(bad, '', '命中禁词必须整段丢弃')
    assert.equal(calls.n, 1 + SUMMARY_LINE_MAX_ATTEMPTS, `应当重试到 ${SUMMARY_LINE_MAX_ATTEMPTS} 次`)
    assert.equal(readSummaryLineCache(dir, 'stu_a')?.text, goodText(), '失败时保留旧缓存')
  } finally {
    cleanup()
  }
})

test('S-15 ★ 按学生隔离：给 A 生成不碰 B 的缓存条目', async () => {
  const { dir, cleanup } = freshDir()
  try {
    writeSummaryLineCache(dir, {
      studentId: 'stu_b',
      text: 'B 的小结（别人写的）',
      generatedAt: 1,
      tagFingerprint: 'fp-b'
    })
    await generateSummaryLine('stu_a', TAGS, makeDeps(dir, {}))
    assert.equal(readSummaryLineCache(dir, 'stu_a')?.text, goodText())
    assert.equal(readSummaryLineCache(dir, 'stu_b')?.text, 'B 的小结（别人写的）', 'B 的条目一个字节都不该动')
    // 落盘那份确实是「两个学生共用一个文件、各自一条」
    const raw = JSON.parse(readFileSync(summaryCachePath(dir), 'utf8')) as {
      entries: Record<string, { text: string }>
    }
    assert.deepEqual(Object.keys(raw.entries).sort(), ['stu_a', 'stu_b'])
  } finally {
    cleanup()
  }
})

test('S-16 空 studentId / 空缓存目录 → 直接返回空串（不抛、不写）', async () => {
  const { dir, cleanup } = freshDir()
  try {
    const calls = { n: 0 }
    assert.equal(await generateSummaryLine('', TAGS, makeDeps(dir, { calls })), '')
    assert.equal(await generateSummaryLine('stu_a', TAGS, { ...makeDeps(dir, { calls }), userDataDir: '  ' }), '')
    assert.equal(calls.n, 0)
  } finally {
    cleanup()
  }
})
