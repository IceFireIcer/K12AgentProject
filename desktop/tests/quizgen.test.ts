/**
 * 练习页「动态出题」的单测（计划 §7 的 1–5 条）。
 *
 * 五块：
 *   1. shouldAutoGenerate —— 触发判据（全判分 / 同关一次 / 配额 / 空题库）；
 *   2. buildPersonalizedQuizPrompt —— 纯函数快照（学段、素材、错选原文、去重清单、
 *      输出仍是骨架那一行 JSON 的约定；**题型配比交给模型**（D-133，骨架那条
 *      「最多一道开放题」在练习页链路显式作废））；
 *   3. 主进程出题流水（注入假 complete / prepare / register）—— 成功、无 Key 降级、
 *      登记失败不下发、重试上限、auto 配额复核、more 不受 20 约束、10+7 拆批；
 *   4. IPC 载荷的决策记录白名单投影 —— 脏条目整条丢、tries 重算、超长截断、条数上限；
 *   5. 常量唯一来源（AUTO_PHASE_LIMIT=20 / MORE_BATCH=10 每进程各只定义一次，
 *      调用点一律用常量名）。
 *
 * 写法：node:test + assert/strict（TS 单测禁 parameter property）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import type { DecisionTrace } from '../src/shared/quiz-generate.ts'
import type { QuizGenDeps, QuizGenRunRequest } from '../src/main/agent/quizgen/service.ts'

/**
 * electron 替身（data: URL 模块）：handlers-data.ts 在模块顶层 import { ipcMain }，
 * 而 electron 是 CJS、Node 的类型擦除加载器认不出它的具名导出 —— 直接 import 会当场
 * SyntaxError。与 tests/data-plane-forward.test.ts 同一手法：只给本文件要用的那一个
 * ipcMain.handle 注册表（我们只读它导出的纯函数，从不 invoke）。
 */
const ELECTRON_STUB =
  'data:text/javascript;base64,' +
  Buffer.from(
    'const handlers = new Map()\n' +
      'export const ipcMain = {\n' +
      '  handle(channel, listener) { handlers.set(channel, listener) },\n' +
      '  removeHandler(channel) { handlers.delete(channel) }\n' +
      '}\n'
  ).toString('base64')

const SRC_SHARED = new URL('../src/shared/', import.meta.url)

/**
 * 渲染进程的模块按 Vite 的口味写相对导入（不带扩展名）与 @shared 别名，
 * Node ESM 要求显式扩展名。这个 hook 补齐两者。
 *
 * ⚠️ 被测模块必须用**动态 import**：ESM 把静态 import 提到模块顶部，
 *    而 hook 是在那之后才注册的（上面的 import type 在类型擦除时整行消失）。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
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

const { shouldAutoGenerate, useQuizStore, AUTO_PHASE_LIMIT, MORE_BATCH } = await import(
  '../src/renderer/src/stores/quiz.ts'
)
const { buildPersonalizedQuizPrompt } = await import('../src/main/agent/quizgen/prompt.ts')
const { createQuizGenService } = await import('../src/main/agent/quizgen/service.ts')
const { DEFAULT_GENERATION_RETRIES, MAX_QUIZ_QUESTIONS } = await import('../src/main/agent/extensions/quiz.ts')
const {
  projectDecisionTrace,
  projectDecisionTraceContext,
  MAX_DECISION_TRACES,
  MAX_STEM_HEAD_CHARS,
  MAX_TRACE_ANSWER_CHARS,
  MAX_TRACE_TRIES
} = await import('../src/main/ipc/handlers-data.ts')

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readFile = (relativePath: string): string =>
  readFileSync(join(DESKTOP_ROOT, ...relativePath.split('/')), 'utf8')

/* ================================================================== *
 * 1. shouldAutoGenerate（触发判据）
 * ================================================================== */

type BankArg = Parameters<typeof shouldAutoGenerate>[0]
type AttemptsArg = Parameters<typeof shouldAutoGenerate>[1]

/** 造一个最小题库视图（判据只看 questions[].qid）。 */
function bankOf(qids: string[]): BankArg {
  return { kpId: 'prog-loop-jr', questions: qids.map((qid) => ({ qid })) } as unknown as BankArg
}

/** 造 attempts：值 true = 判过分（result 非空），false = 还没判分。 */
function attemptsOf(graded: Record<string, boolean>): AttemptsArg {
  const attempts: Record<string, unknown> = {}
  for (const [qid, done] of Object.entries(graded)) {
    attempts[qid] = {
      qid,
      answer: 'x',
      result: done ? { qid, correct: true } : null,
      submitting: false,
      error: null,
      history: []
    }
  }
  return attempts as unknown as AttemptsArg
}

test('shouldAutoGenerate：内置题全部判分过才触发（不要求全对）', () => {
  const bank = bankOf(['q1', 'q2'])
  assert.equal(
    shouldAutoGenerate(bank, attemptsOf({ q1: true, q2: true }), '', 'prog-loop-jr'),
    true,
    '全部判分过 → 触发'
  )
  assert.equal(
    shouldAutoGenerate(bank, attemptsOf({ q1: true, q2: false }), '', 'prog-loop-jr'),
    false,
    '有题没判分 → 不触发'
  )
  assert.equal(
    shouldAutoGenerate(bank, attemptsOf({ q1: true }), '', 'prog-loop-jr'),
    false,
    'attempts 里缺一条同 qid 的记录 = 没判过分 → 不触发'
  )
})

test('shouldAutoGenerate：同一关只触发一次（autoFiredKp 是唯一判据）', () => {
  const bank = bankOf(['q1'])
  assert.equal(
    shouldAutoGenerate(bank, attemptsOf({ q1: true }), 'prog-loop-jr', 'prog-loop-jr'),
    false,
    '这一关已经触发过 → 不再触发（restart 也不重置）'
  )
  assert.equal(
    shouldAutoGenerate(bank, attemptsOf({ q1: true }), 'other-kp', 'prog-loop-jr'),
    true,
    '换了一关（autoFiredKp 记的是别的关）→ 照常触发'
  )
})

test('shouldAutoGenerate：配额满不触发（内置 + 已有生成题一起算）', () => {
  const bank = bankOf(['q1'])
  const attempts = attemptsOf({ q1: true })
  assert.equal(shouldAutoGenerate(bank, attempts, '', 'kp', 2, 1), false, '1 内置 + 1 生成 = 2 达到上限')
  assert.equal(shouldAutoGenerate(bank, attempts, '', 'kp', 2, 0), true, '未达上限 → 触发')
  assert.equal(
    shouldAutoGenerate(bank, attempts, '', 'kp', AUTO_PHASE_LIMIT, AUTO_PHASE_LIMIT - 1),
    false,
    '默认上限 20：19 + 1 = 20 达到上限'
  )
  assert.equal(
    shouldAutoGenerate(bank, attempts, '', 'kp', AUTO_PHASE_LIMIT, AUTO_PHASE_LIMIT - 2),
    true,
    '18 + 1 = 19 < 20 → 触发'
  )
})

test('shouldAutoGenerate：题库为空 / 没有当前关 / bank 缺失都不触发', () => {
  assert.equal(shouldAutoGenerate(bankOf([]), attemptsOf({}), '', 'kp'), false, '题库为空 → 不触发')
  assert.equal(shouldAutoGenerate(null, attemptsOf({}), '', 'kp'), false, 'bank 还没读回来 → 不触发')
  assert.equal(
    shouldAutoGenerate(bankOf(['q1']), attemptsOf({ q1: true }), '', ''),
    false,
    '没有当前关（currentKpId 为空）→ 不触发'
  )
})

/* ================================================================== *
 * 2. buildPersonalizedQuizPrompt（纯函数快照）
 * ================================================================== */

function traceOf(over: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    qid: 'q1',
    index: 1,
    type: 'choice',
    source: 'bank',
    stemHead: '循环的条件是什么',
    tries: [{ answer: '选 B', correct: false }],
    firstTryCorrect: false,
    triesCount: 1,
    ...over
  }
}

test('buildPersonalizedQuizPrompt：学段 / kpId / 错选原文 / 去重清单都注入，输出形态仍压轴', () => {
  const prompt = buildPersonalizedQuizPrompt({
    gradeLevel: 'junior',
    kpId: 'prog-loop-jr',
    count: 3,
    summary: { graded: 3, correct: 1, firstTryCorrect: 1, multiTry: 2 },
    traces: [
      traceOf(),
      traceOf({
        qid: 'q2',
        index: 2,
        firstTryCorrect: true,
        tries: [{ answer: '对了的内容', correct: true }]
      })
    ],
    existingStems: ['已有题干甲', '已有题干乙']
  })

  assert.ok(prompt.includes('prog-loop-jr'), 'kpId 必须进 prompt')
  assert.ok(prompt.includes('初中'), '学段标签必须进 prompt（junior → 初中）')
  assert.ok(!prompt.includes('中小学'), '学段认不出时才会回落「中小学」—— 这里不该出现')
  assert.ok(prompt.includes('判分 3 道'), '总体表现（判分数）必须进 prompt')
  assert.ok(prompt.includes('选 B'), '错题的**错选原文**必须进 prompt')
  assert.ok(prompt.includes('已有题干甲') && prompt.includes('已有题干乙'), '去重清单两条都要进 prompt')
  assert.ok(prompt.includes('需要重点巩固'), '做得不顺的题要单独列出')

  // 输出形态：仍是一行 JSON 的约定，且个性化内容插在它**之前**（那条约定压轴）
  assert.ok(prompt.includes('只输出一行 JSON'), '骨架的「只输出一行 JSON」约定必须原样保留')
  assert.ok(prompt.includes('{"questions"'), '骨架给了 questions 的 JSON 形态示例')
  const jsonAt = prompt.lastIndexOf('只输出一行 JSON')
  assert.ok(prompt.indexOf('【这名学生刚刚做完的练习】') < jsonAt, '个性化内容必须在输出约定之前')
  assert.ok(prompt.indexOf('需要重点巩固') < jsonAt)
  assert.ok(prompt.indexOf('不要与这些题重复') < jsonAt)

  // ★★ 题型配比交给模型（2026-10-01 用户裁决 D-133）：「开放题比例我不管，动态调配，根据 LLM 的意图来」。
  //   骨架里那条「最多一道开放题」是通用变式题的口径，练习页这条链路**显式作废**它。
  assert.ok(
    prompt.includes('题型由你决定'),
    '必须给模型「题型由你决定」的授权段 —— 否则它会照骨架那条固定比例出题'
  )
  assert.ok(
    prompt.includes('作废'),
    '★ 必须**显式作废**骨架里那条旧限制：两段话打架时模型多半听先出现的那句'
  )
  assert.ok(
    prompt.includes('rubric'),
    '开放题仍要带 rubric（判分路径靠它区分，契约口径没变）'
  )
  assert.ok(
    prompt.includes('不要超过一半'),
    '保留一条成本护栏：开放题由模型判分、学生要等，整批不超过一半（这是提示不是硬切）'
  )
})

test('buildPersonalizedQuizPrompt：一次答对率高 → 加深变式；低 → 先保基础', () => {
  const base = {
    gradeLevel: 'primary_high',
    kpId: 'prog-loop-jr',
    count: 3,
    traces: [traceOf({ firstTryCorrect: true, tries: [{ answer: 'A', correct: true }] })],
    existingStems: []
  }
  const deep = buildPersonalizedQuizPrompt({
    ...base,
    summary: { graded: 4, correct: 4, firstTryCorrect: 4, multiTry: 0 }
  })
  assert.ok(deep.includes('再深一步'), '一次答对率高 → 要求换情境 / 多一步推理')
  assert.ok(!deep.includes('还没完全稳'), '高分组不该出现「先保基础」那句')

  const shaky = buildPersonalizedQuizPrompt({
    ...base,
    summary: { graded: 4, correct: 1, firstTryCorrect: 1, multiTry: 3 }
  })
  assert.ok(shaky.includes('还没完全稳'), '一次答对率低 → 先保住基础变式')
})

test('buildPersonalizedQuizPrompt：没有轨迹时明说「历史作答不可用」，不编素材', () => {
  const prompt = buildPersonalizedQuizPrompt({
    gradeLevel: 'junior',
    kpId: 'prog-loop-jr',
    count: 3,
    summary: { graded: 0, correct: 0, firstTryCorrect: 0, multiTry: 0 },
    traces: [],
    existingStems: []
  })
  assert.ok(prompt.includes('历史作答不可用'), 'v1 局限要如实写进 prompt（切走再回来只剩题干清单）')
})

test('buildPersonalizedQuizPrompt：超长作答 / 题干被截断，不把整段原文灌进 prompt', () => {
  const longAnswer = 'x'.repeat(200)
  const longStem = '题干'.repeat(100)
  const prompt = buildPersonalizedQuizPrompt({
    gradeLevel: 'junior',
    kpId: 'prog-loop-jr',
    count: 3,
    summary: { graded: 1, correct: 0, firstTryCorrect: 0, multiTry: 1 },
    traces: [traceOf({ stemHead: longStem, tries: [{ answer: longAnswer, correct: false }] })],
    existingStems: []
  })
  assert.ok(!prompt.includes(longAnswer), '200 字作答不该整段进 prompt（单次引用限 60 字）')
  assert.ok(!prompt.includes(longStem), '200 字题干不该整段进 prompt（限 80 字）')
  assert.ok(prompt.includes('…'), '截断要留下省略号')
})

/* ================================================================== *
 * 3. 主进程出题流水（注入假 complete / prepare / register）
 * ================================================================== */

const RAW_REPLY = '{"questions":[{"qid":"x","type":"choice","stem":"s","options":[],"answer":"A"}]}'
const completer = async (_prompt: string): Promise<string> => RAW_REPLY

const REQUEST: QuizGenRunRequest = {
  kpId: 'prog-loop-jr',
  context: [],
  studentId: 'student_001',
  gradeLevel: 'junior'
}

type Prepare = NonNullable<QuizGenDeps['prepare']>
type Register = NonNullable<QuizGenDeps['register']>

/** 假校验：把 maxQuestions 记下来，并回**刚好这么多**道题（让一批恰好填满配额）。 */
function makePrepare(recorded: number[]): Prepare {
  const prepare = (_raw: unknown, expect: { maxQuestions?: number }): unknown => {
    const count = expect.maxQuestions ?? 1
    recorded.push(count)
    const questions: Array<Record<string, unknown>> = []
    for (let i = 0; i < count; i += 1) questions.push({ qid: 'gen-' + i })
    return { ok: true, questions, subjective: [] }
  }
  return prepare as unknown as Prepare
}

/** 假登记：fail 为 true = 登记失败（返回 null，服务必须**不下发**）。 */
interface RegisterCall {
  studentId: string
  gradeLevel: string
  count: number
}
function makeRegister(recorded: RegisterCall[], fail: boolean): Register {
  const register = async (input: {
    studentId: string
    gradeLevel: string
    questions: Array<Record<string, unknown>>
  }): Promise<unknown> => {
    recorded.push({ studentId: input.studentId, gradeLevel: input.gradeLevel, count: input.questions.length })
    if (fail) return null
    return {
      kpId: 'prog-loop-jr',
      source: 'generated',
      questions: input.questions.map((question) => ({
        qid: String(question.qid),
        kpId: 'prog-loop-jr',
        type: 'choice',
        stem: '题干',
        options: null
      }))
    }
  }
  return register as unknown as Register
}

/** 假校验永远不合格 → 触发重试上限。 */
const failingPrepare = ((_raw: unknown, _expect: unknown) => ({
  ok: false,
  reason: '不合格'
})) as unknown as Prepare

test('服务流水：成功 —— 补全 → 校验（收到 count）→ 登记（收到身份/学段）→ 下发投影载荷', async () => {
  const prepareCounts: number[] = []
  const registerCalls: RegisterCall[] = []
  const service = createQuizGenService({
    readBank: async () => 0,
    readExisting: async () => [],
    prepare: makePrepare(prepareCounts),
    register: makeRegister(registerCalls, false),
    complete: completer
  })
  const result = await service.generateAuto(REQUEST)
  assert.equal(result.ok, true)
  assert.equal(result.degraded, undefined, '成功不是降级')
  assert.equal(result.payload?.source, 'generated')
  assert.equal(
    result.payload?.questions.length,
    AUTO_PHASE_LIMIT,
    'auto 阶段把配额填满（0 内置 → 20 道），单批仍 ≤ 契约上限 10'
  )
  assert.deepEqual(
    prepareCounts,
    [MAX_QUIZ_QUESTIONS, MAX_QUIZ_QUESTIONS],
    '20 道拆成 10 + 10 两批（单批不得超过契约上限）'
  )
  assert.deepEqual(
    registerCalls,
    [
      { studentId: 'student_001', gradeLevel: 'junior', count: MAX_QUIZ_QUESTIONS },
      { studentId: 'student_001', gradeLevel: 'junior', count: MAX_QUIZ_QUESTIONS }
    ],
    '每一批各自登记，身份与学段由调用方注入'
  )
})

test('服务流水：无可用模型 → 降级（ok 仍为 true + 可读说明）；setCompleter 热挂/热摘', async () => {
  const service = createQuizGenService({
    readBank: async () => 0,
    readExisting: async () => [],
    prepare: makePrepare([]),
    register: makeRegister([], false)
  })
  const degraded = await service.generateAuto(REQUEST)
  assert.equal(degraded.ok, true, '降级不是 error（ok 仍为 true）')
  assert.equal(degraded.degraded, true)
  assert.equal(degraded.payload, undefined)
  assert.ok((degraded.note ?? '').length > 0, '要给学生一句可读说明')

  service.setCompleter(completer)
  const up = await service.generateAuto(REQUEST)
  assert.equal(up.ok, true)
  assert.equal(up.degraded, undefined, '挂上通道后不再降级')
  assert.equal(up.payload?.questions.length, AUTO_PHASE_LIMIT)

  service.setCompleter(null)
  const down = await service.generateAuto(REQUEST)
  assert.equal(down.degraded, true, '摘掉通道立刻回到降级（Key 热清空）')
})

test('服务流水：登记失败 → 该批**不下发**（先登记后下发的铁律）', async () => {
  const registerCalls: RegisterCall[] = []
  const service = createQuizGenService({
    readBank: async () => 0,
    readExisting: async () => [],
    prepare: makePrepare([]),
    register: makeRegister(registerCalls, true),
    complete: completer
  })
  const result = await service.generateAuto(REQUEST)
  assert.equal(result.ok, false)
  assert.equal(result.payload, undefined, '登记没成功就一个题都不许下发')
  assert.ok((result.message ?? '').length > 0, '失败要给一句可读中文')
  assert.equal(
    registerCalls.length,
    DEFAULT_GENERATION_RETRIES + 1,
    '每一轮都试过登记，但一次都没成功（首次 + 2 次重试）'
  )
})

test('服务流水：补全/校验一直失败 → 重试到上限（首次 + 2 次重试）', async () => {
  let completeCalls = 0
  const counting = async (_prompt: string): Promise<string> => {
    completeCalls += 1
    return RAW_REPLY
  }
  const service = createQuizGenService({
    readBank: async () => 0,
    readExisting: async () => [],
    prepare: failingPrepare,
    register: makeRegister([], false),
    complete: counting
  })
  const result = await service.generateAuto(REQUEST)
  assert.equal(result.ok, false)
  assert.equal(
    completeCalls,
    DEFAULT_GENERATION_RETRIES + 1,
    '重试上限 2 → 总共尝试 3 次（多一次或少一次都算漂）'
  )
  assert.equal(result.payload, undefined)
})

test('服务流水：auto 配额已满 → 空成功（不调模型、也不算失败）', async () => {
  let completeCalls = 0
  const counting = async (_prompt: string): Promise<string> => {
    completeCalls += 1
    return RAW_REPLY
  }
  const service = createQuizGenService({
    readBank: async () => 22,
    readExisting: async () => [],
    prepare: makePrepare([]),
    register: makeRegister([], false),
    complete: counting
  })
  const result = await service.generateAuto(REQUEST)
  assert.deepEqual(result, { ok: true }, '配额 ≤ 0 → 空成功（没有可提示的）')
  assert.equal(completeCalls, 0, '不出题就一次模型都不该调')
})

test('服务流水：「还想再练练」（more）不受 20 上限约束，每批固定 10 道', async () => {
  const prepareCounts: number[] = []
  const service = createQuizGenService({
    readBank: async () => 22,
    readExisting: async () => [],
    prepare: makePrepare(prepareCounts),
    register: makeRegister([], false),
    complete: completer
  })
  const result = await service.generateMore(REQUEST)
  assert.equal(result.ok, true)
  assert.equal(result.payload?.questions.length, MORE_BATCH)
  assert.deepEqual(prepareCounts, [MORE_BATCH], 'more 路径批量恒为 MORE_BATCH')
})

test('服务流水：auto 配额 17 → 拆成 10 + 7 两批，题目合并下发', async () => {
  const prepareCounts: number[] = []
  const service = createQuizGenService({
    readBank: async () => 3,
    readExisting: async () => [],
    prepare: makePrepare(prepareCounts),
    register: makeRegister([], false),
    complete: completer
  })
  const result = await service.generateAuto(REQUEST)
  assert.equal(result.ok, true)
  assert.deepEqual(prepareCounts, [MAX_QUIZ_QUESTIONS, 7], '单批 ≤ 契约上限 10，余下 7 道走第二批')
  assert.equal(result.payload?.questions.length, 17, '两批合并后 17 道')
})

/* ================================================================== *
 * 4. 决策记录的白名单投影（IPC 载荷校验）
 * ================================================================== */

test('projectDecisionTrace：结构不对 / 字段越界整条丢掉', () => {
  assert.equal(projectDecisionTrace(null), null)
  assert.equal(projectDecisionTrace('x'), null)
  assert.equal(projectDecisionTrace({}), null)
  assert.equal(projectDecisionTrace({ qid: 'q1', type: 'choice' }), null, '缺 source → 整条丢')
  assert.equal(projectDecisionTrace({ qid: 'q1', type: 'weird', source: 'bank' }), null, '题型不在白名单 → 丢')
  assert.equal(
    projectDecisionTrace({ qid: 'q1', type: 'choice', source: 'other' }),
    null,
    '来源不在白名单 → 丢'
  )
  assert.equal(
    projectDecisionTrace({ qid: 'x'.repeat(129), type: 'choice', source: 'bank' }),
    null,
    'qid 超过 128 字 → 整条丢（不是截断）'
  )

  // 可选字段缺省不影响整条：index 给 0、stemHead 空串、tries 空
  const minimal = projectDecisionTrace({ qid: 'q1', type: 'blank', source: 'generated' })
  assert.equal(minimal?.index, 0)
  assert.equal(minimal?.stemHead, '')
  assert.equal(minimal?.triesCount, 0)
  assert.equal(minimal?.firstTryCorrect, null)
})

test('projectDecisionTrace：tries 白名单投影 + triesCount/firstTryCorrect 由 tries 重算', () => {
  const trace = projectDecisionTrace({
    qid: 'q1',
    index: 3,
    type: 'choice',
    source: 'bank',
    tries: [
      { answer: 'A', correct: false },
      { answer: 'B', correct: true },
      { answer: 'C' },
      { answer: '' },
      { answer: 42 },
      null,
      'x'
    ],
    // 下面两个是渲染层给的，主进程**不采信**：
    triesCount: 99,
    firstTryCorrect: true
  })
  assert.deepEqual(
    trace?.tries,
    [
      { answer: 'A', correct: false },
      { answer: 'B', correct: true },
      { answer: 'C', correct: null }
    ],
    '缺 correct → null（「没判出来」不是「答错」）；空作答 / 非字符串 / 非对象整条丢'
  )
  assert.equal(trace?.triesCount, 3, 'triesCount 由 tries 重算，不采信输入')
  assert.equal(trace?.firstTryCorrect, false, 'firstTryCorrect = tries[0].correct（不是输入里的 true）')
})

test('projectDecisionTrace：超长文本截断（题干 120 / 作答 2000 / tries 只留最近 20）', () => {
  const longStem = '甲'.repeat(300)
  const longAnswer = '乙'.repeat(3000)
  const trace = projectDecisionTrace({
    qid: 'q1',
    type: 'blank',
    source: 'bank',
    stemHead: longStem,
    tries: [{ answer: longAnswer, correct: true }]
  })
  assert.equal(trace?.stemHead.length, MAX_STEM_HEAD_CHARS, '题干截到 120 字')
  assert.equal(trace?.tries[0].answer.length, MAX_TRACE_ANSWER_CHARS, '单次作答截到 2000 字')

  const many = Array.from({ length: 25 }, (_, index) => ({ answer: 'a' + index, correct: true }))
  const capped = projectDecisionTrace({ qid: 'q1', type: 'blank', source: 'bank', tries: many })
  assert.equal(capped?.triesCount, MAX_TRACE_TRIES, '单题最多保留 20 条轨迹')
  assert.equal(capped?.tries[0].answer, 'a5', '保留的是**最近** 20 条（从尾部截）')
})

test('projectDecisionTraceContext：坏条目丢弃 + 条数上限 200（从头截）', () => {
  const many = Array.from({ length: 250 }, (_, index) => ({
    qid: 'q' + index,
    type: 'choice',
    source: 'bank'
  }))
  const projected = projectDecisionTraceContext(many)
  assert.equal(projected.length, MAX_DECISION_TRACES, '最多 200 条')
  assert.equal(projected[0].qid, 'q0', '从头截：保住最早那些题')
  assert.equal(projected[MAX_DECISION_TRACES - 1].qid, 'q199')

  const mixed = projectDecisionTraceContext([
    { qid: 'ok', type: 'choice', source: 'bank' },
    null,
    { qid: 'bad' },
    'x'
  ])
  assert.deepEqual(mixed.map((item) => item.qid), ['ok'], '坏条目丢掉，其余照常保留')
  assert.deepEqual(projectDecisionTraceContext('x'), [], '不是数组 → 空')
  assert.deepEqual(projectDecisionTraceContext(null), [], 'null → 空')
})

/* ================================================================== *
 * 5. 常量唯一来源
 * ================================================================== */

test('常量唯一来源：每进程各只定义一次 AUTO_PHASE_LIMIT=20 / MORE_BATCH=10，调用点用常量名', () => {
  const serviceCode = readFile('src/main/agent/quizgen/service.ts')
  const storeCode = readFile('src/renderer/src/stores/quiz.ts')
  const modules: Array<[string, string]> = [
    ['主进程 quizgen/service.ts', serviceCode],
    ['渲染层 stores/quiz.ts', storeCode]
  ]
  let definitions = 0
  for (const [label, code] of modules) {
    const autoCount = (code.match(/export const AUTO_PHASE_LIMIT = 20/g) ?? []).length
    const moreCount = (code.match(/export const MORE_BATCH = 10/g) ?? []).length
    assert.equal(autoCount, 1, label + ' 里 AUTO_PHASE_LIMIT=20 必须只定义一次')
    assert.equal(moreCount, 1, label + ' 里 MORE_BATCH=10 必须只定义一次')
    definitions += autoCount + moreCount
  }
  assert.equal(
    definitions,
    4,
    '这两个常量只允许在「主进程服务 + 渲染层 store」各一份（每进程一份），别处再定义就是第三份来源'
  )

  // 调用点必须用常量名，不散落字面量
  assert.match(serviceCode, /AUTO_PHASE_LIMIT - existingTotal/, '主进程配额必须用 AUTO_PHASE_LIMIT 算')
  assert.match(
    serviceCode,
    /Math\.min\(MORE_BATCH, MAX_QUIZ_QUESTIONS\)/,
    'more 批量必须用 MORE_BATCH（对齐契约单批上限）'
  )
  assert.match(storeCode, /autoPhaseLimit: AUTO_PHASE_LIMIT/, 'store 对外别名必须指向同一常量')
  assert.match(storeCode, /moreBatch: MORE_BATCH/, 'store 对外别名必须指向同一常量')
  assert.ok(
    readFile('src/renderer/src/views/Quiz.vue').includes('quiz.autoPhaseLimit'),
    '练习页截断必须读 store 的 autoPhaseLimit，不许写死 20'
  )

  // 冻结接口的对外口径：store 上拿到的就是这两个数
  setActivePinia(createPinia())
  const store = useQuizStore()
  assert.equal(store.autoPhaseLimit, 20)
  assert.equal(store.moreBatch, 10)
})
