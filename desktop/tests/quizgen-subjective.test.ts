/**
 * 主观题判分回退（Q6/Q7）的单测：rubric 缓存 + 409 → 模型判分。
 *
 * 背景（真机验收发现计划漏掉的一环）：练习页生成题里带 rubric 的是主观题，
 * POST /api/quiz/grade 对它一律 409，而渲染层拿不到 rubric（投影后无 rubric/答案、
 * 后端也没有读单题端点）—— 登记那一刻是唯一能拿到它的时机，所以主进程留了缓存。
 * 契约与后端零改动。
 *
 * 三块：
 *   1. rubric 缓存（内存表行为 + 原子写/坏文件的源码级断言）；
 *   2. gradeSubjective 三条路径（成功 / 无 completer / 解析失败），假 completer +
 *      bridge/client.ts 的 data: URL 替身（落库出口是这里唯一会发请求的地方）；
 *   3. handlers-data 的 409 回退（**源码级**，不把 electron 拖进单测）。
 *
 * ⚠️ 纯 node 下 rubric-cache 的落盘路径解析不到（createRequire('electron') 拿不到
 *    app.getPath）→ 只走内存表；所以「原子写 / 文件坏当空表」按任务允许的**源码级**
 *    断言钉住，行为侧钉内存表与不抛。
 *
 * 写法：node:test + assert/strict；TS 单测禁 parameter property。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC_SHARED = new URL('../src/shared/', import.meta.url)

/** electron 替身：本文件的依赖图里若有人静态 import electron，不能让它当场语法错。 */
const ELECTRON_STUB =
  'data:text/javascript;base64,' +
  Buffer.from(
    'const handlers = new Map()\n' +
      'export const ipcMain = {\n' +
      '  handle(channel, listener) { handlers.set(channel, listener) },\n' +
      '  removeHandler(channel) { handlers.delete(channel) }\n' +
      '}\n'
  ).toString('base64')

/**
 * bridge/client.ts 的替身（**落库出口的观测点**）：postSubjectiveGrade 动态 import 它，
 * 我们在这里既记录请求、又能按用例定制回执。默认回一个 200 的空对象。
 */
const BRIDGE_STUB =
  'data:text/javascript;base64,' +
  Buffer.from(
    'const calls = []\n' +
      'let reply = { status: 200, body: {} }\n' +
      'export const testBridge = { calls, reset() { calls.length = 0 } }\n' +
      'export function setReply(next) { reply = next }\n' +
      'export async function apiFetch(path, init = {}) {\n' +
      '  calls.push({ path, init })\n' +
      '  return new Response(JSON.stringify(reply.body), {\n' +
      '    status: reply.status,\n' +
      '    headers: { "content-type": "application/json" }\n' +
      '  })\n' +
      '}\n' +
      'export const DEFAULT_API_TIMEOUT_MS = 8000\n' +
      'export function configureSidecarEndpoint() {}\n' +
      'export function clearSidecarEndpoint() {}\n' +
      'export async function probeHealth() { return null }\n'
  ).toString('base64')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (specifier.endsWith('bridge/client.ts')) return { url: BRIDGE_STUB, shortCircuit: true }
    if (specifier.startsWith('@shared/')) {
      return { url: new URL(specifier.slice('@shared/'.length) + '.ts', SRC_SHARED).href, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.ts', '/index.ts']) {
          const candidate = new URL(specifier + suffix, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
      }
      throw error
    }
  }
})

const { rememberRubrics, rubricFor, RUBRIC_CACHE_FILE_NAME } = await import(
  '../src/main/agent/quizgen/rubric-cache.ts'
)
const { gradeSubjective, quizGenService } = await import('../src/main/agent/quizgen/service.ts')
const { SUBJECTIVE_UNAVAILABLE_TEXT, SUBJECTIVE_GRADING_FAILED_TEXT } = await import(
  '../src/main/agent/extensions/quiz.ts'
)
const bridge = await import(BRIDGE_STUB)

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readFile = (relativePath: string): string =>
  readFileSync(join(DESKTOP_ROOT, ...relativePath.split('/')), 'utf8')

/* ================================================================== *
 * 1. rubric 缓存（内存表行为）
 * ================================================================== */

test('rememberRubrics：只记 rubric 非空的题（无 rubric / 空串 / 非字符串一律不记）', () => {
  const student = 'student_q7_only_rubric'
  rememberRubrics(student, [
    { qid: 'q-ok', stem: '题干甲', rubric: '  答出要点一  ' },
    { qid: 'q-empty', stem: '题干乙', rubric: '' },
    { qid: 'q-space', stem: '题干丙', rubric: '   ' },
    { qid: 'q-missing', stem: '题干丁' },
    { qid: 'q-null', stem: '题干戊', rubric: null },
    { qid: 'q-number', stem: '题干己', rubric: 42 },
    { qid: '', stem: '题干庚', rubric: '没有 qid' },
    { stem: '题干辛', rubric: '没有 qid' }
  ])

  assert.deepEqual(
    rubricFor(student, 'q-ok'),
    { rubric: '答出要点一', stem: '题干甲' },
    '非空 rubric 要记住，且两端空白要去掉'
  )
  for (const qid of ['q-empty', 'q-space', 'q-missing', 'q-null', 'q-number']) {
    assert.equal(rubricFor(student, qid), null, qid + ' 的 rubric 为空/非字符串 → 不该记住')
  }
})

test('rubricFor：学生之间互不可见；未命中返回 null（不抛）', () => {
  rememberRubrics('student_q7_alice', [{ qid: 'shared-qid', stem: 'Alice 的题干', rubric: 'Alice 的要点' }])
  rememberRubrics('student_q7_bob', [{ qid: 'shared-qid', stem: 'Bob 的题干', rubric: 'Bob 的要点' }])

  assert.deepEqual(rubricFor('student_q7_alice', 'shared-qid'), {
    rubric: 'Alice 的要点',
    stem: 'Alice 的题干'
  })
  assert.deepEqual(rubricFor('student_q7_bob', 'shared-qid'), {
    rubric: 'Bob 的要点',
    stem: 'Bob 的题干'
  })
  assert.equal(rubricFor('student_q7_carol', 'shared-qid'), null, '别的学生查不到（缓存按 studentId 分表）')
  assert.equal(rubricFor('student_q7_alice', 'no-such-qid'), null, '没这题 → null')
  assert.equal(rubricFor('', 'shared-qid'), null, '空 studentId → null')
  assert.equal(rubricFor('student_q7_alice', ''), null, '空 qid → null')
})

test('rememberRubrics：同一 qid 再登记会覆盖旧值（upsert，不留两份）', () => {
  const student = 'student_q7_upsert'
  rememberRubrics(student, [{ qid: 'q1', stem: '旧题干', rubric: '旧要点' }])
  rememberRubrics(student, [{ qid: 'q1', stem: '新题干', rubric: '新要点' }])
  assert.deepEqual(rubricFor(student, 'q1'), { rubric: '新要点', stem: '新题干' })
})

test('rubric-cache 源码：原子写（tmp + rename）、读坏文件当空表且不抛、只存 qid/stem/rubric', () => {
  const source = readFile('src/main/agent/quizgen/rubric-cache.ts')

  assert.equal(RUBRIC_CACHE_FILE_NAME, 'quiz-rubrics.json')
  assert.ok(
    source.includes("RUBRIC_CACHE_FILE_NAME = '" + RUBRIC_CACHE_FILE_NAME + "'"),
    '落盘文件名必须由导出的常量定义（quiz-rubrics.json）'
  )
  // 原子写：先写 .tmp 再 rename（覆写中途崩掉不会留下半截 JSON）
  assert.ok(source.includes("const temp = path + '.tmp'"), '必须先写 .tmp 临时文件')
  assert.ok(source.includes('writeFileSync(temp,'), '临时文件写完后才 rename')
  assert.ok(source.includes('renameSync(temp, path)'), '必须用 rename 原子落盘（与 accounts.json 同一手法）')
  // 读失败 / 文件坏 → 空表 + 不抛
  assert.match(
    source,
    /catch\s*\{[\s\S]{0,240}?table = \{\}/,
    '读盘失败 / 文件坏时必须回落到空表（判分失败要可读，不是崩）'
  )
  // 只存 qid / stem / rubric：绝不存答案
  assert.ok(!source.includes('answer'), 'rubric 缓存只存 qid/stem/rubric，不许把答案也存进来')
})

/* ================================================================== *
 * 2. gradeSubjective 三条路径
 * ================================================================== */

const GRADE_INPUT = {
  studentId: 'student_q7_grade',
  gradeLevel: 'junior',
  qid: 'gen-q7-1',
  answer: '我的作答内容',
  stem: '题干：请解释循环',
  rubric: '要点一：说明条件；要点二：说明退出'
}

test('gradeSubjective：合法档位 → 模型判分 → 落库回执原样返回', async () => {
  bridge.testBridge.reset()
  bridge.setReply({
    status: 200,
    body: {
      qid: 'gen-q7-1',
      correct: true,
      scoredBy: 'llm',
      feedback: '答出了主要要点',
      masteryDelta: 0.15
    }
  })
  let seenPrompt = ''
  quizGenService.setCompleter(async (prompt: string): Promise<string> => {
    seenPrompt = prompt
    return '{"score":0.8,"feedback":"答出了主要要点"}'
  })

  const result = await gradeSubjective(GRADE_INPUT)
  assert.deepEqual(
    result,
    {
      qid: 'gen-q7-1',
      correct: true,
      scoredBy: 'llm',
      feedback: '答出了主要要点',
      masteryDelta: 0.15
    },
    'correct / feedback / masteryDelta 来自服务端落库回执，不由前端自造'
  )
  assert.ok(seenPrompt.includes('我的作答内容'), '判分 Prompt 必须带上学生的作答')
  assert.ok(seenPrompt.includes('要点一'), '判分 Prompt 必须带上 rubric')
  assert.ok(seenPrompt.includes('题干：请解释循环'), '判分 Prompt 必须带上题干')

  assert.equal(bridge.testBridge.calls.length, 1, '判分成功后落库恰好一次')
  assert.equal(bridge.testBridge.calls[0].path, '/api/quiz/grade-subjective')
  const body = JSON.parse(String(bridge.testBridge.calls[0].init?.body)) as Record<string, unknown>
  assert.equal(body.score, 0.8, '送给后端的是模型给的分数（「多少分算过」由 Python 定）')
  assert.equal(body.studentId, 'student_q7_grade')
  assert.equal(body.sessionId, '', '练习页没有对话会话 → sessionId 空串（后端允许）')
})

test('gradeSubjective：无 completer → 抛可读中文（含「模型」，无 stack / 状态码 / 端点名）', async () => {
  bridge.testBridge.reset()
  quizGenService.setCompleter(null)
  await assert.rejects(
    gradeSubjective(GRADE_INPUT),
    (error: unknown) => {
      assert.ok(error instanceof Error, '必须抛 Error')
      assert.equal(error.message, SUBJECTIVE_UNAVAILABLE_TEXT, '口径必须是既有的「没有可用模型」文案')
      assert.ok(error.message.includes('模型'), '要含「模型」这类学生面词')
      assert.ok(/[\u4e00-\u9fff]/.test(error.message), '必须是中文人话')
      for (const bad of ['Error', 'stack', 'HTTP', 'grade-subjective', 'rubric', 'undefined']) {
        assert.ok(!error.message.includes(bad), '学生面文案不许出现「' + bad + '」')
      }
      return true
    }
  )
  assert.equal(bridge.testBridge.calls.length, 0, '没判出来就绝不落库（不瞎判）')
})

test('gradeSubjective：模型输出无法解析 → 走「判分失败」口径，不静默成功、不落库', async () => {
  bridge.testBridge.reset()
  quizGenService.setCompleter(async (): Promise<string> => '我觉得答得不错，给 0.8 分吧（不是 JSON）')
  await assert.rejects(
    gradeSubjective(GRADE_INPUT),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, SUBJECTIVE_GRADING_FAILED_TEXT)
      return true
    }
  )
  assert.equal(bridge.testBridge.calls.length, 0, '解析不出分数时**不落库**（脏分数会污染掌握度）')
})

/* ================================================================== *
 * 3. handlers-data 的 409 回退（源码级）
 * ================================================================== */

test('quiz:grade 的 409 回退（源码级）：判据认两种特征，缺细则给可读中文，其余失败原样放行', () => {
  const source = readFile('src/main/ipc/handlers-data.ts')

  // ① 判据函数同时认状态码与端点名
  const fnAt = source.indexOf('function isSubjectiveConflict(')
  assert.ok(fnAt > 0, '必须有 409 判据函数 isSubjectiveConflict')
  const fnEnd = source.indexOf('\n}', fnAt)
  const fnBody = source.slice(fnAt, fnEnd > fnAt ? fnEnd : fnAt + 400)
  assert.ok(fnBody.includes('HTTP 409'), '判据要认「HTTP 409」这个状态码特征')
  assert.ok(fnBody.includes('grade-subjective'), '判据要认后端点名的 grade-subjective 端点')

  // ② 回退链路：缓存命中 → 模型判分；未命中 → 可读中文
  const gradeAt = source.indexOf('ipcMain.handle(IPC.quizGrade')
  assert.ok(gradeAt > 0, '必须有 quiz:grade 处理器')
  const nextAt = source.indexOf('ipcMain.handle(IPC.quizProgress', gradeAt)
  const gradeBody = source.slice(gradeAt, nextAt > gradeAt ? nextAt : gradeAt + 6000)
  assert.ok(gradeBody.includes('isSubjectiveConflict'), 'quiz:grade 必须用这个判据识别 409')
  assert.ok(gradeBody.includes('rubricFor('), '409 后要去 rubric 缓存取细则')
  assert.ok(gradeBody.includes('gradeSubjective('), '缓存命中 → 走模型判分')
  assert.ok(gradeBody.includes('MISSING_RUBRIC_MESSAGE'), '缓存未命中 → 回那句可读提示')
  assert.ok(gradeBody.includes('return graded'), '非 409 的失败/成功必须原样返回（既有路径不许被改写）')

  // ③ 那句可读中文：无技术词
  const msgAt = source.indexOf('const MISSING_RUBRIC_MESSAGE')
  assert.ok(msgAt > 0, '必须有 MISSING_RUBRIC_MESSAGE 常量')
  // ✗ 只取第一行会取到 'const MISSING_RUBRIC_MESSAGE ='（值在下一行）—— 取一段窗口
  const msgBlock = source.slice(msgAt, msgAt + 260)
  assert.ok(/[\u4e00-\u9fff]/.test(msgBlock), '提示必须是中文人话')
  assert.ok(!msgBlock.includes('HTTP'), '提示里不许出现 HTTP')
  assert.ok(!msgBlock.includes('rubric'), '提示里不许出现英文 rubric')
})
