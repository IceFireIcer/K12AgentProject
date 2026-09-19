/**
 * 票 14 的**渲染进程**单测：练习卡片 + 学段（读 + 一条写）在 store 里的行为。
 *
 * 覆盖三块：
 *   1. `cards/quiz.ts` —— 载荷投影（★ 答案泄漏防线：白名单投影后**不可能**带出 `answer`）、
 *      批改结果收集、提交消息生成；
 *   2. `stores/chat.ts` —— **`sendChat` 只发文本**（`ChatSendRequest` 只有 `text`），
 *      「当前学段」来自主进程推送（`grade:changed`）；学生手动指定走**另一条**通道
 *      `chat.setGrade` → `window.api.setGrade`（`grade:set`），两件事永不互为副作用；
 *   3. `labels.ts` —— 掌握度变化的展示口径与学段提示语（只格式化，不重算、不判分）。
 *
 * 跑法：`npm test`（`node --test`，Node 内置类型擦除 + 内置断言，不引入测试框架）。
 *
 * ★ 为什么文件顶部要装一个 resolve hook：
 *   渲染进程的模块只按 Vite 的口味写相对导入（`from '../labels'`，**不带扩展名**），
 *   而 Node ESM 要求显式扩展名。hook 只给「相对且没写扩展名」的说明符补 `.ts`，
 *   让单测能直接 import **渲染进程的真实实现**（而不是另写一份替身）。
 *   它对其它测试文件无影响：`node --test` 每个测试文件跑在独立子进程里。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { applyChatEvent, emptyConversation, startTurn } from '../src/renderer/src/api/events.ts'
import {
  buildQuizSubmissionMessage,
  collectQuizResults,
  isBlankAnswer,
  optionLetter,
  readQuizCard
} from '../src/renderer/src/cards/quiz.ts'
import { GRADE_LABELS, formatMasteryDelta, gradeAdaptNotice } from '../src/renderer/src/labels.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const chatModule = await import('../src/renderer/src/stores/chat.ts')

/* ------------------------------------------------------------------ *
 * 固定样本
 * ------------------------------------------------------------------ */

/** 一道选择题（**对外形态**：没有 `answer`）。 */
const CHOICE_QUESTION = {
  qid: 'prog-variable-jr-q1',
  kpId: 'prog-variable-jr',
  type: 'choice',
  stem: '在 Python 里，下面哪一句能把 3 和 5 的和存进变量 total？',
  options: ['total = 3 + 5', 'total = "3 + 5"', 'total == 3 + 5'],
  explanation: '等号让右边算完再存进左边；== 是比较。'
}

/** 题库出题载荷（`generate_quiz` 的 details）+ 主进程附加的 `tool` / `kind`。 */
function quizPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    kpId: 'prog-variable-jr',
    source: 'bank',
    questions: [CHOICE_QUESTION],
    tool: 'generate_quiz',
    kind: 'quiz',
    ...overrides
  }
}

/** 批改结果载荷（`submit_quiz` 的 details）。 */
function resultPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    qid: 'prog-variable-jr-q1',
    correct: true,
    scoredBy: 'rule',
    feedback: '答对了！等号让右边算完再存进左边。',
    masteryDelta: 0.15,
    tool: 'submit_quiz',
    kind: 'quiz',
    ...overrides
  }
}

/** 递归找出对象里所有名为 `answer` 的键（答案泄漏防线的检测手段）。 */
function findAnswerKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findAnswerKeys(item, `${path}[${index}]`))
  if (typeof value !== 'object' || value === null) return []
  const hits: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase().includes('answer')) hits.push(`${path}.${key}`)
    hits.push(...findAnswerKeys(item, `${path}.${key}`))
  }
  return hits
}

/* ------------------------------------------------------------------ *
 * 1. 载荷投影：答案进不来
 * ------------------------------------------------------------------ */

test('练习卡片：题库载荷投影成可渲染的题目（选项、题型、题干都在）', () => {
  const view = readQuizCard(quizPayload())
  assert.equal(view.kind, 'questions')
  if (view.kind !== 'questions') return

  assert.equal(view.source, 'bank')
  assert.equal(view.kpId, 'prog-variable-jr')
  assert.equal(view.questions.length, 1)
  const [question] = view.questions
  assert.equal(question.qid, 'prog-variable-jr-q1')
  assert.equal(question.type, 'choice')
  assert.equal(question.options.length, 3)
  assert.ok(question.stem.includes('total'))
})

test('★ 答案不泄漏：投影结果里不可能出现 answer / explanation（哪怕载荷硬塞进来）', () => {
  const SECRET = '标准答案是 A' // 故意与选项文本不同：只要它出现在视图里，就是泄漏
  const leaked = quizPayload({
    questions: [
      { ...CHOICE_QUESTION, answer: SECRET, answerText: SECRET, solution: SECRET, correctOption: 0 },
      { ...CHOICE_QUESTION, qid: 'prog-variable-jr-q2', answer: [SECRET], explanation: SECRET }
    ]
  })

  const view = readQuizCard(leaked)
  assert.equal(view.kind, 'questions')
  if (view.kind !== 'questions') return

  // ① 结构上没有答案键（递归扫描，连嵌套字段一起看）
  assert.deepEqual(findAnswerKeys(view), [], '投影结果里出现了 answer 相关字段')
  // ② 题干以外的解析（explanation 往往直接写着答案）也不许带出去
  assert.deepEqual(Object.keys(view.questions[0]).sort(), [
    'kpId',
    'options',
    'qid',
    'stem',
    'type'
  ])
  // ③ 序列化后的文本里不许出现标准答案原文
  const serialized = JSON.stringify(view)
  assert.ok(!serialized.includes(SECRET), '标准答案原文出现在了卡片视图里')
})

test('练习卡片：认不出的载荷退化成说明，不抛异常、不猜字段', () => {
  assert.deepEqual(readQuizCard(undefined), { kind: 'unknown', text: '' })
  assert.equal(readQuizCard({ tool: 'generate_quiz', kind: 'quiz', text: '题库暂时不可用' }).kind, 'unknown')
  const withText = readQuizCard({ tool: 'generate_quiz', kind: 'quiz', text: '题库暂时不可用' })
  assert.equal(withText.kind === 'unknown' ? withText.text : '', '题库暂时不可用')

  // 选择题选项不足两道 → 整题丢掉（渲染出来没法作答）
  const broken = readQuizCard(quizPayload({ questions: [{ ...CHOICE_QUESTION, options: ['只有一个'] }] }))
  assert.equal(broken.kind, 'unknown')
})

test('练习卡片：填空题 / 代码填空题也认得（题型来自冻结契约）', () => {
  const view = readQuizCard(
    quizPayload({
      questions: [
        { qid: 'prog-variable-jr-q2', kpId: 'prog-variable-jr', type: 'code_blank', stem: 'total = 3 ______ 5', options: null },
        { qid: 'prog-variable-jr-q3', kpId: 'prog-variable-jr', type: 'blank', stem: '变量名要能看懂：______' }
      ]
    })
  )
  assert.equal(view.kind, 'questions')
  if (view.kind !== 'questions') return
  assert.deepEqual(
    view.questions.map((question) => question.type),
    ['code_blank', 'blank']
  )
  assert.deepEqual(view.questions[0].options, [])
})

test('练习卡片：批改结果按后端给的字段渲染（不重算、不改写）', () => {
  const view = readQuizCard(resultPayload({ correct: false, masteryDelta: -0.1, scoredBy: 'rule' }))
  assert.equal(view.kind, 'result')
  if (view.kind !== 'result') return
  assert.equal(view.qid, 'prog-variable-jr-q1')
  assert.equal(view.correct, false)
  assert.equal(view.masteryDelta, -0.1)
  assert.equal(view.scoredBy, 'rule')
  assert.ok(view.feedback.includes('答对') || view.feedback.length > 0)

  // 怪值不许把界面搞崩：非数字的 masteryDelta 视为 0，认不出的 scoredBy 视为 null
  const odd = readQuizCard(resultPayload({ masteryDelta: '很多', scoredBy: '人工' }))
  assert.equal(odd.kind === 'result' ? odd.masteryDelta : null, 0)
  assert.equal(odd.kind === 'result' ? odd.scoredBy : 'x', null)
})

test('批改结果跨轮收集：同一题多次作答时保留最新一次', () => {
  const results = collectQuizResults([
    { payload: resultPayload({ correct: false, masteryDelta: -0.1 }) },
    { payload: quizPayload() },
    { payload: resultPayload({ correct: true, masteryDelta: 0.15, feedback: '这次对了' }) }
  ])
  assert.equal(results.size, 1)
  assert.equal(results.get('prog-variable-jr-q1')?.correct, true)
  assert.equal(results.get('prog-variable-jr-q1')?.feedback, '这次对了')
})

/* ------------------------------------------------------------------ *
 * 2. 提交作答：只把「题号 + 作答」说清楚
 * ------------------------------------------------------------------ */

test('提交消息：带上题目编号与学生的作答，并明确要求走后端判分', () => {
  const message = buildQuizSubmissionMessage({ qid: 'prog-variable-jr-q1', stem: CHOICE_QUESTION.stem }, 'total = 3 + 5')
  assert.ok(message.includes('prog-variable-jr-q1'), '提交消息必须带 qid（后端按 qid 判分）')
  assert.ok(message.includes('total = 3 + 5'), '提交消息必须带学生的作答')
  assert.ok(message.includes('submit_quiz'), '要明确要求模型调用 submit_quiz')
  assert.ok(!message.includes('答对了'), '前端不许出现任何判分结论')
})

test('提交消息：长题干截断，不把整段材料灌进 prompt', () => {
  const longStem = '题目'.repeat(200)
  const message = buildQuizSubmissionMessage({ qid: 'q1', stem: longStem }, 'B')
  assert.ok(message.length < 400, `提交消息过长：${message.length}`)
  assert.ok(message.includes('…'), '超长题干应带省略号')
})

test('空作答识别（提交按钮的禁用条件；这不是判分）', () => {
  assert.equal(isBlankAnswer(''), true)
  assert.equal(isBlankAnswer('   '), true)
  assert.equal(isBlankAnswer('B'), false)
})

test('选项字母：A/B/C…，超范围退回序号', () => {
  assert.equal(optionLetter(0), 'A')
  assert.equal(optionLetter(2), 'C')
  assert.equal(optionLetter(9), '#10')
})

/* ------------------------------------------------------------------ *
 * 3. 掌握度文案
 * ------------------------------------------------------------------ */

test('掌握度变化只为展示做格式化（正负号 / 两位小数 / 零值）', () => {
  assert.equal(formatMasteryDelta(0.15), '掌握度 +0.15')
  assert.equal(formatMasteryDelta(-0.1), '掌握度 -0.10')
  assert.equal(formatMasteryDelta(0), '掌握度不变')
  assert.equal(formatMasteryDelta(Number.NaN), '掌握度不变')
})

/* ------------------------------------------------------------------ *
 * 4. 学段：**学生不选学段**，只随 sendChat 发文本
 * ------------------------------------------------------------------ */

interface SentRequest {
  text: string
  /** ★ 设计已变更：`ChatSendRequest` 里不该再有 `gradeLevel`（学段只走 `grade:set`）。 */
  gradeLevel?: string
}

/** 假 `window.api` 的记录面（发送的请求 / 手动设定的学段 / 两条推送通道）。 */
function installFakeBridge(): {
  sent: SentRequest[]
  gradeSet: string[]
  emit: (event: unknown) => void
  emitGrade: (state: unknown) => void
  /** 让下一次 `setGrade` 失败（默认成功），用于覆盖「失败不撒谎」那条路径。 */
  failGradeWith: (message: string | null) => void
} {
  const sent: SentRequest[] = []
  const gradeSet: string[] = []
  const listeners: Array<(event: unknown) => void> = []
  const gradeListeners: Array<(state: unknown) => void> = []
  let counter = 0
  let gradeFailure: string | null = null

  const api = {
    getSidecarInfo: async () => ({ phase: 'ready', port: 1, pid: 2, mode: 'dev', errorText: null }),
    onSidecarChanged: () => () => {},
    sendChat: async (request: SentRequest) => {
      sent.push(request)
      counter += 1
      return { ok: true, requestId: `turn_test-${counter}`, message: null }
    },
    onChatEvent: (listener: (event: unknown) => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    // 学段：只读推送（`grade:changed`）+ 可选的初始拉取（`grade:get`）+ 手动写入（`grade:set`）
    getGrade: async () => ({ ok: false as const, message: '测试里不提供初始值' }),
    setGrade: async (level: string) => {
      // ★ 记的是**渲染进程实际递出去的值**：学生选什么就传什么，前端不改写、不映射
      gradeSet.push(level)
      if (gradeFailure !== null) return { ok: false as const, message: gradeFailure }
      return { ok: true as const, data: { changed: true, cooldownRemainingTurns: 10 } }
    },
    onGradeChanged: (listener: (state: unknown) => void) => {
      gradeListeners.push(listener)
      return () => {
        const index = gradeListeners.indexOf(listener)
        if (index >= 0) gradeListeners.splice(index, 1)
      }
    }
  }

  const runtime = globalThis as unknown as { window: unknown }
  runtime.window = { api }
  return {
    sent,
    gradeSet,
    failGradeWith: (message) => {
      gradeFailure = message
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
    emitGrade: (state) => {
      for (const listener of [...gradeListeners]) listener(state)
    }
  }
}

test('★ 发一轮对话只发文本：sendChat 的入参里没有 gradeLevel', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()

  await chat.send('人工智能是怎么认出一只猫的？')

  assert.equal(bridge.sent.length, 1)
  assert.deepEqual(Object.keys(bridge.sent[0]).sort(), ['text'], '学段不该随对话发出（系统判定）')
  assert.equal(bridge.sent[0].text, '人工智能是怎么认出一只猫的？')
})

test('★ store 里**有**唯一的人工写入口 setGrade，且它只经 window.api.setGrade 走（不改 sendChat 的入参）', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()

  // ① 写入口存在且是函数（学生在界面上能手动指定学段）
  assert.equal(typeof chat.setGrade, 'function', '学生手动指定学段要有唯一的人工写入口')

  // ② 它把「学生选了什么」原样递交给 preload 白名单（`grade:set`），前端不推断、不改写
  const result = await chat.setGrade('senior')
  assert.deepEqual(bridge.gradeSet, ['senior'], '手动设定必须经 window.api.setGrade 递出去，且原样传递')

  // ③ ★ 最重要的一条：手动设定**没有**混进对话请求 ——
  //    `ChatSendRequest` 的字段集合被守卫 G6c 钉死为 ['text']，
  //    学段一旦混进去，「发一条消息」就成了「写一次学段」的副作用（重发同一句话会再写一遍）。
  await chat.send('再讲讲函数是什么')
  assert.equal(bridge.sent.length, 1)
  assert.deepEqual(
    Object.keys(bridge.sent[0]).sort(),
    ['text'],
    '手动设定学段之后，对话请求的入参仍然恰好是 [text]（学段不随每轮请求走）'
  )

  assert.deepEqual(result, { ok: true })
  assert.equal(chat.currentGrade, 'senior', '设定成功后当前学段由服务端回执落实')
  assert.equal(chat.gradeOrigin, 'explicit', '来源必须标成「学生手动选的」，而不是 AI 推算')
})

test('学段判定推送：指示器显示判定结果，并在变化时给一句提示', () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()
  chat.connect()

  // 冷启动默认值：不是判定结果 —— 不显示、也不提示
  bridge.emitGrade({ gradeLevel: 'primary_high', origin: 'default' })
  assert.equal(chat.currentGrade, null, '默认值不许当成判定结果')
  assert.equal(chat.gradeNotice, null)

  // 第一次判定成功
  bridge.emitGrade({ gradeLevel: 'junior', origin: 'inferred', reason: '学生用了初中术语' })
  assert.equal(chat.currentGrade, 'junior')
  assert.equal(chat.gradeOrigin, 'inferred')
  assert.equal(chat.currentGradeLabel, '初中')
  assert.equal(chat.gradeNotice, '我按初中的说法来讲。')

  // 同一个学段再推一次：不重复提示
  chat.gradeNotice = null
  bridge.emitGrade({ gradeLevel: 'junior', origin: 'inferred' })
  assert.equal(chat.gradeNotice, null, '学段没变就不该再提示一次')

  // 判定改判
  bridge.emitGrade({ gradeLevel: 'senior', origin: 'inferred' })
  assert.equal(chat.currentGrade, 'senior')
  assert.equal(chat.gradeNotice, '我按高中的说法来讲。')
})

test('学段推送：学生手动设定（origin=explicit）也照常上屏，来源显示为「手动选中」', () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()
  chat.connect()

  // 学生点完「自己指定学段」后，主进程立刻推来的那一条。
  // ★ 与 `inferred` 对称：这条**必须被采纳** —— 丢掉它就是「点了没反应」
  //   （界面停在上一个状态，学生会以为自己没点中而反复点）。
  chat.gradeNotice = null
  bridge.emitGrade({ gradeLevel: 'senior', origin: 'explicit', source: 'explicit' })
  assert.equal(chat.currentGrade, 'senior', '手动设定后的推送必须上屏（否则点了看不出生效）')
  assert.equal(chat.gradeOrigin, 'explicit')
  assert.equal(chat.currentGradeLabel, '高中')

  // ★ 但**不给**「我按高中的说法来讲。」那句：它的主语是系统，而这一档是学生自己定的
  //   （手动那个动作的回执由 store 的 setGrade 给：「已按你选的…」）。
  assert.equal(chat.gradeNotice, null, '手动设定的推送不该改写成「系统自动适配」的语气')

  // 覆盖上一条测试留下的显式状态：再来一条系统判定，照旧要给自动提示
  bridge.emitGrade({ gradeLevel: 'junior', origin: 'inferred' })
  assert.equal(chat.currentGrade, 'junior')
  assert.equal(chat.gradeOrigin, 'inferred')
  assert.equal(chat.gradeNotice, '我按初中的说法来讲。')
})

test('学段推送：认不出的值忽略（不猜测、不映射到最近似的学段）', () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()
  chat.connect()

  bridge.emitGrade({ gradeLevel: 'junior', origin: 'inferred' })
  bridge.emitGrade({ gradeLevel: 'college', origin: 'inferred' })
  bridge.emitGrade({ gradeLevel: 42 })
  bridge.emitGrade(null)
  bridge.emitGrade({ origin: 'inferred' })

  assert.equal(chat.currentGrade, 'junior', '脏数据不许改动当前学段')
})

test('学段推送：本轮标注用的是发送时刻的判定结果', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()
  chat.connect()

  bridge.emitGrade({ gradeLevel: 'junior', origin: 'inferred' })
  await chat.send('什么是神经网络？')

  const turns = (chat as unknown as { turns: Array<{ gradeLevel: string | null; userText: string }> }).turns
  assert.equal(turns.length, 1)
  assert.equal(turns[0].gradeLevel, 'junior', '轮次要记住这一轮是哪个年级的说法')
  assert.equal(turns[0].userText, '什么是神经网络？')
  assert.equal(chat.gradeNotice, null, '发完这一轮后提示应清掉')

  // 还没判定时发出的那一轮：不带学段标注（宁可不标，也不标一个假的）
  bridge.emit({ name: 'done', data: { requestId: 'turn_test-1', messageId: 'm1' } })
  setActivePinia(createPinia())
  const fresh = chatModule.useChatStore()
  await fresh.send('再问一次')
  const freshTurns = (fresh as unknown as { turns: Array<{ gradeLevel: string | null }> }).turns
  assert.equal(freshTurns[0].gradeLevel, null)
})

test('学段文案：四个中文名 + 判定提示语（只陈述「我按什么说法讲」）', () => {
  assert.deepEqual(
    (['primary_low', 'primary_high', 'junior', 'senior'] as const).map((grade) => GRADE_LABELS[grade]),
    ['小学低年级', '小学高年级', '初中', '高中']
  )
  assert.equal(gradeAdaptNotice('junior'), '我按初中的说法来讲。')
  assert.equal(gradeAdaptNotice('senior'), '我按高中的说法来讲。')
})

test('学段推送通道缺失时：给出可读说明，界面不崩', () => {
  const runtime = globalThis as unknown as { window: unknown }
  runtime.window = { api: { sendChat: async () => ({ ok: true, requestId: 'turn_x', message: null }), onChatEvent: () => () => {} } }
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()

  chat.connect() // 不抛异常
  assert.equal(chat.currentGrade, null)
  assert.ok(
    typeof chat.gradeBridgeError === 'string' && chat.gradeBridgeError.includes('onGradeChanged'),
    '缺通道要说清缺什么（照这句话就能把线接上）'
  )
})

test('练习卡片提交：走对话把作答交给主 Agent（不带学段）', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()

  await chat.submitQuizAnswer({ qid: 'prog-variable-jr-q1', stem: '哪一句能求和？' }, 'total = 3 + 5')

  assert.equal(bridge.sent.length, 1)
  assert.deepEqual(Object.keys(bridge.sent[0]).sort(), ['text'])
  assert.ok(bridge.sent[0].text.includes('prog-variable-jr-q1'))
  assert.ok(bridge.sent[0].text.includes('total = 3 + 5'))

  const turns = (chat as unknown as { turns: Array<{ userText: string }> }).turns
  assert.ok(turns[0].userText.includes('【练习作答】'), '学生消息要能看出这是一次作答')
})

test('批改结果进 store 后，题目卡片能按 qid 取到它（跨轮反馈）', () => {
  installFakeBridge()
  setActivePinia(createPinia())
  const chat = chatModule.useChatStore()

  // 第 1 轮：题目卡片（payload）
  let state = startTurn(emptyConversation(), 'turn_a', '出两道题', 'junior')
  state = applyChatEvent(state, { name: 'payload', data: { requestId: 'turn_a', kind: 'quiz', payload: quizPayload() } })
  state = applyChatEvent(state, { name: 'done', data: { requestId: 'turn_a', messageId: 'm1' } })
  // 第 2 轮：批改结果（payload）
  state = startTurn(state, 'turn_b', '【练习作答】…', 'junior')
  state = applyChatEvent(state, { name: 'payload', data: { requestId: 'turn_b', kind: 'quiz', payload: resultPayload() } })
  state = applyChatEvent(state, { name: 'done', data: { requestId: 'turn_b', messageId: 'm2' } })

  ;(chat as unknown as { conversation: unknown }).conversation = state

  const result = chat.quizResults.get('prog-variable-jr-q1')
  assert.ok(result, '批改结果应能从整段对话里按 qid 找到')
  assert.equal(result?.correct, true)
  assert.equal(result?.masteryDelta, 0.15)
})

/* ------------------------------------------------------------------ *
 * 5. 闯关 store（独立页那条路）：失败文案按受众改写
 * ------------------------------------------------------------------ */

/**
 * 装一个只够闯关 store 用的假桥（`window.api` 白名单的一个切片）。
 *
 * ★ 为什么单独装一个而不是复用文件顶部那个：那个是给对话 store 用的
 *   （`sendChat` / `onChatEvent` / 学段推送），本组要的是数据面的三条闯关通道 ——
 *   合成一个「全能假桥」会让两边都读不清自己依赖的是哪几条。
 */
function installQuizBridge(options: {
  bank?: unknown
  bankFailure?: string
  gradeFailure?: string
}): void {
  const api = {
    readQuizProgress: async () => ({
      ok: true as const,
      data: { studentId: 's1', gradeLevel: 'junior', seeded: true, levels: [] }
    }),
    readQuizBank: async () =>
      options.bankFailure !== undefined
        ? { ok: false as const, message: options.bankFailure }
        : { ok: true as const, data: options.bank ?? { kpId: 'data-processing-jr', source: 'bank', questions: [] } },
    gradeQuiz: async () =>
      options.gradeFailure !== undefined
        ? { ok: false as const, message: options.gradeFailure }
        : { ok: true as const, data: { qid: 'q1', correct: true, scoredBy: 'rule', feedback: '答对了', masteryDelta: 0.1 } },
    // 其余数据面方法不在本组的能力范围内（`resolveDataBridge` 要求它们都在，所以给空实现）
    getStudent: async () => ({ ok: false as const, message: '本组不测' }),
    readProfile: async () => ({ ok: false as const, message: '本组不测' }),
    readRecommendation: async () => ({ ok: false as const, message: '本组不测' }),
    readGradeSignals: async () => ({ ok: false as const, message: '本组不测' }),
    readGradeHistory: async () => ({ ok: false as const, message: '本组不测' }),
    readCodeTemplate: async () => ({ ok: false as const, message: '本组不测' }),
    readCodeHint: async () => ({ ok: false as const, message: '本组不测' }),
    analyzeCodeRun: async () => ({ ok: false as const, message: '本组不测' }),
    readAnimationTemplates: async () => ({ ok: false as const, message: '本组不测' }),
    renderAnimation: async () => ({ ok: false as const, message: '本组不测' }),
    hostAnimation: async () => ({ ok: false as const, message: '本组不测' }),
    readKnowledgeStats: async () => ({ ok: false as const, message: '本组不测' }),
    readKnowledgePoints: async () => ({ ok: false as const, message: '本组不测' }),
    importKnowledge: async () => ({ ok: false as const, message: '本组不测' }),
    rebuildKnowledge: async () => ({ ok: false as const, message: '本组不测' }),
    onTraceChanged: () => () => {}
  }
  ;(globalThis as unknown as { window: unknown }).window = { api }
}

test('★★ 闯关页取题失败：后端排障文案（HTTP 状态码 / 服务器路径 / 内部 kp_id）不许上屏', async () => {
  installQuizBridge({
    // 后端真实的 404 detail 形态（面向排障：内部 kp_id + 服务器上的题库目录）
    bankFailure:
      "读取失败（HTTP 404）：知识点 'data-processing-jr' 在 junior 及更低学段没有题目" +
      '（题库文件：server/resources/quizbank/）'
  })
  setActivePinia(createPinia())
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  const quiz = useQuizStore()

  await quiz.loadBank('data-processing-jr')

  assert.ok(quiz.bankError !== null, '要有可读原因，不能静默什么都不显示')
  assert.doesNotMatch(
    quiz.bankError,
    /HTTP\s*\d{3}|server[\\/]|resources[\\/]|'[a-z][a-z0-9-]*-[a-z]/,
    `界面上不该出现排障细节：${quiz.bankError}`
  )
  assert.equal(quiz.bank, null, '失败时不许留着上一关的题（那会让学生对着错误标题作答）')
})

test('★ 闯关页判分失败：同一套翻译（提交回执里的 detail 也不许带排障细节）', async () => {
  installQuizBridge({
    gradeFailure: "操作失败（HTTP 500）：/api/quiz/grade 写库失败（知识点：'prog-loop-jr'）"
  })
  setActivePinia(createPinia())
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  const quiz = useQuizStore()

  await quiz.submit('q1', 'A')

  const error = quiz.attempts['q1']?.error
  assert.ok(error !== null && error !== undefined)
  assert.doesNotMatch(error, /HTTP\s*\d{3}|\/api\/|'[a-z][a-z0-9-]*-[a-z]/, `界面上不该出现排障细节：${error}`)
  assert.equal(quiz.attempts['q1']?.result, null, '失败时不许有判分结论（前端不自己判对错）')
})
