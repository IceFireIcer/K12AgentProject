/**
 * 学习计划 / 练习检验按钮的**消息对**单测（study/plan-request.ts）。
 *
 * ★ 为什么值得单独钉：
 *   · 两条 wire 文本是**写给模型的指令**（含「3~5 个学习步骤」「不要口头出题」这类约束），
 *     它们必须一字不动地留在 wire 里 —— 约束被删薄，模型行为就悄悄变弱；
 *   · 学生气泡里显示的必须是另外一句话（planRequestDisplayText / quizAskDisplayText），
 *     一旦把 wire 原文落进学生气泡，就是把「底牌」印给学生（走查已经抓到过一次同类缺陷，
 *     见 cards/coding.ts 的先例）；回看历史时 JSONL 里存的也是 wire 原文，
 *     所以 planUserTextDisplay 必须能把它们翻译回来，且**认不出一律原样返回**。
 *   · 因此这里既钉 wire 的逐字格式，也钉显示文本「不含内部 id / 不含工具名」。
 *
 * 跑法与 renderer-onboarding.test.ts 一致（Node 内置类型擦除 + 内置断言 +
 * 给相对且无扩展名的说明符补 .ts 的解析 hook）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 渲染进程的模块只按 Vite 的口味写相对导入（不带扩展名），
 * 而 Node ESM 要求显式扩展名。这个 hook 只给「相对且没写扩展名」的说明符补 '.ts'。
 *
 * ⚠️ 被测模块必须用**动态 import**：ESM 把静态 import 提到模块顶部，
 *    而 hook 是在那之后才注册的。
 */
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

const {
  PLAN_REQUEST_PREFIX,
  QUIZ_ASK_PREFIX,
  buildPlanRequestMessage,
  buildQuizAskMessage,
  planRequestDisplayText,
  quizAskDisplayText,
  planUserTextDisplay,
  parsePlanRequest
} = await import('../src/renderer/src/study/plan-request.ts')

/* ================================================================== *
 * 期望值：逐字抄自冻结契约（测试就是契约的执行形态，不另起一份口径）
 * ================================================================== */

const KP_ID = 'prog-loop-jr'
const KP_NAME = '循环结构'

/** 计划 wire 的正文（发给模型的那段指令）。 */
const PLAN_TAIL =
  '请为这个知识点安排一份学习计划：先用两三句话讲清它是什么、解决什么问题，再按顺序给出 3~5 个学习步骤（每一步写清「看什么 / 练什么」），最后给一个能自测的小目标。贴合我的学段，别一次塞太多。讲完提醒我可以用下方的按钮检验。'
const PLAN_WIRE = '【学习计划】kp_id=' + KP_ID + '\n知识点：' + KP_NAME + '\n' + PLAN_TAIL
/** kpName 为空时，「知识点：」整行省略（不留空标签）。 */
const PLAN_WIRE_NO_NAME = '【学习计划】kp_id=' + KP_ID + '\n' + PLAN_TAIL
/**
 * 练习检验 wire 的措辞由 A5 改成「点名变式现场出题、不要教材原题」，A8 只钉
 * **关键约束与结构**，不再逐字抄整段 —— 逐字抄会把「改一句说明」也变成红，
 * 而真正要防的是约束被悄悄删薄。这里直接从实现取，供 parse / 回看翻译用例当输入。
 */
const QUIZ_WIRE = buildQuizAskMessage(KP_ID, KP_NAME)
const QUIZ_WIRE_NO_NAME = buildQuizAskMessage(KP_ID, '')

/* ================================================================== *
 * ① 前缀常量
 * ================================================================== */

test('两条前缀常量逐字正确（回看翻译靠它们认出自家的消息）', () => {
  assert.equal(PLAN_REQUEST_PREFIX, '【学习计划】', 'PLAN_REQUEST_PREFIX 必须逐字是「【学习计划】」')
  assert.equal(QUIZ_ASK_PREFIX, '【练习检验】', 'QUIZ_ASK_PREFIX 必须逐字是「【练习检验】」')
})

/* ================================================================== *
 * ② 两条 wire 的格式（学习计划逐字；练习检验钉结构与关键约束）
 * ================================================================== */

test('buildPlanRequestMessage：逐字格式（含 kpName 空串时省略「知识点：」整行）', () => {
  assert.equal(
    buildPlanRequestMessage(KP_ID, KP_NAME),
    PLAN_WIRE,
    '计划 wire 必须逐字等于契约：首行前缀 + kp_id=、次行知识点名、正文含「3~5 个学习步骤」等约束'
  )
  const noName = buildPlanRequestMessage(KP_ID, '')
  assert.equal(
    noName,
    PLAN_WIRE_NO_NAME,
    'kpName 为空串时「知识点：」整行必须省略，不留一个空标签'
  )
  assert.ok(!noName.includes('知识点：'), '空名字分支里不许留下「知识点：」这一行')
  // 空名字不影响写给模型的约束本身
  assert.ok(
    noName.includes('3~5 个学习步骤') && noName.includes('贴合我的学段'),
    '省略的只能是名字那一行，写给模型的约束一个字都不能少'
  )
})

test('buildQuizAskMessage：结构与关键约束（A5 新措辞：变式现场出题 / 不要教材原题）', () => {
  const wire = buildQuizAskMessage(KP_ID, KP_NAME)
  // ① 结构仍是「前缀 + kp_id= 行 + 知识点名行 + 正文」——认领与回看翻译都靠它
  assert.ok(
    wire.startsWith('【练习检验】kp_id=' + KP_ID + '\n知识点：' + KP_NAME + '\n'),
    '练习检验 wire 必须仍以「前缀 + kp_id= + 知识点名」开头，实得：' + JSON.stringify(wire.slice(0, 80))
  )
  // ② 出题导向的关键约束：必须点名「变式」，且明确「不要…教材原题」
  assert.ok(wire.includes('变式'), 'A5 口径要求点名「变式题」能力（模型现场出题），实得：' + JSON.stringify(wire))
  assert.ok(wire.includes('教材原题'), '必须写明「不要直接给教材原题」这条约束，实得：' + JSON.stringify(wire))
  assert.match(
    wire,
    /不[^。\n]{0,14}教材原题/,
    '「教材原题」前面必须有「不要 / 不直接」这类否定，否则这条约束被删薄了：' + JSON.stringify(wire)
  )
  // ③ 空名字分支：同样省略「知识点：」整行，关键约束一个不少
  const noName = buildQuizAskMessage(KP_ID, '')
  assert.ok(
    noName.startsWith('【练习检验】kp_id=' + KP_ID + '\n'),
    '空名字分支仍以 kp_id= 行开头，实得：' + JSON.stringify(noName.slice(0, 60))
  )
  assert.ok(!noName.includes('知识点：'), '空名字分支里不许留下「知识点：」这一行')
  assert.ok(
    noName.includes('变式') && noName.includes('教材原题'),
    '省略的只能是名字那一行，出题导向的关键约束一个字都不能少'
  )
})

/* ================================================================== *
 * ③ 四个显示文本
 * ================================================================== */

test('planRequestDisplayText：有名字 / 没名字两个分支', () => {
  assert.equal(
    planRequestDisplayText(KP_NAME),
    '我想学「循环结构」，帮我安排一下学习计划。',
    '有名字时把名字嵌进学生话里'
  )
  assert.equal(
    planRequestDisplayText(''),
    '我想学一个知识点，帮我安排一下学习计划。',
    '名字取不到时给通用说法，绝不回落成空串或内部 id'
  )
})

test('quizAskDisplayText：有名字 / 没名字两个分支', () => {
  assert.equal(quizAskDisplayText(KP_NAME), '就「循环结构」考考我。', '有名字时把名字嵌进学生话里')
  assert.equal(
    quizAskDisplayText(''),
    '就刚才那个知识点考考我。',
    '名字取不到时给通用说法（「刚才那个」承接上文）'
  )
})

/* ================================================================== *
 * ④ parsePlanRequest：前缀不对 / 缺 kp_id= / 两条前缀 / 缺名字
 * ================================================================== */

test('parsePlanRequest：两条 wire 前缀都能解析出 kpId 与 kpName', () => {
  assert.deepEqual(
    parsePlanRequest(PLAN_WIRE),
    { kpId: KP_ID, kpName: KP_NAME },
    '【学习计划】前缀的 wire 必须解析出 { kpId, kpName }'
  )
  assert.deepEqual(
    parsePlanRequest(QUIZ_WIRE),
    { kpId: KP_ID, kpName: KP_NAME },
    '【练习检验】前缀的 wire 同样要能解析'
  )
  assert.deepEqual(
    parsePlanRequest(PLAN_WIRE_NO_NAME),
    { kpId: KP_ID, kpName: '' },
    '缺「知识点：」那行时 kpName 给空串，但 kpId 照常解析'
  )
  assert.deepEqual(
    parsePlanRequest(QUIZ_WIRE_NO_NAME),
    { kpId: KP_ID, kpName: '' },
    '练习检验 wire 缺「知识点：」那行时同样给空串（两条前缀共用同一个解析）'
  )
})

test('parsePlanRequest：前缀不对或缺 kp_id= 一律 null（不猜、不半解析）', () => {
  assert.equal(parsePlanRequest('【编程求助】kp_id=' + KP_ID), null, '别的前缀 → null，不许当成计划请求')
  assert.equal(parsePlanRequest('【学习计划】知识点：' + KP_NAME), null, '缺 kp_id= → null')
  assert.equal(parsePlanRequest('【练习检验】就考考我吧'), null, '空手打的一句 → null')
  assert.equal(parsePlanRequest('随便一句话'), null, '完全无关的文本 → null')
  assert.equal(parsePlanRequest(''), null, '空串 → null')
})

/* ================================================================== *
 * ⑤ planUserTextDisplay：回看翻译 + 认不出原样返回
 * ================================================================== */

test('planUserTextDisplay：认两条前缀 → 换成对应的学生话（与显示文本同一出口）', () => {
  assert.equal(
    planUserTextDisplay(PLAN_WIRE),
    planRequestDisplayText(KP_NAME),
    '回看计划 wire 时必须换成学生话，而不是把内部指令再印一遍'
  )
  assert.equal(planUserTextDisplay(PLAN_WIRE), '我想学「循环结构」，帮我安排一下学习计划。')
  assert.equal(
    planUserTextDisplay(QUIZ_WIRE),
    quizAskDisplayText(KP_NAME),
    '回看练习检验 wire 时同样要翻译'
  )
  assert.equal(planUserTextDisplay(QUIZ_WIRE), '就「循环结构」考考我。')
  assert.equal(
    planUserTextDisplay(PLAN_WIRE_NO_NAME),
    planRequestDisplayText(''),
    'wire 里没有名字 → 用通用显示文本'
  )
})

test('planUserTextDisplay：认不出一律原样返回（绝不改写学生自己打的字）', () => {
  // 学生真的手打了同款开头，但没有 kp_id= —— 这不是本应用生成的消息，不许被翻译
  const handTyped = '【学习计划】帮我安排一下学习计划'
  assert.equal(planUserTextDisplay(handTyped), handTyped, '手打的同款文字必须原样返回')
  const handTypedQuiz = '【练习检验】给我出几道题吧'
  assert.equal(planUserTextDisplay(handTypedQuiz), handTypedQuiz, '练习检验同款手打文字也必须原样返回')
  // 普通文本 / 空串 / 别的前缀
  assert.equal(planUserTextDisplay('今天讲了循环'), '今天讲了循环', '普通文本原样返回')
  assert.equal(planUserTextDisplay(''), '', '空串原样返回（不是造一句空显示）')
  const otherPrefix = '【编程求助】kp_id=' + KP_ID
  assert.equal(planUserTextDisplay(otherPrefix), otherPrefix, '别的前缀归各自的模块翻译，这里不许越权')
})

/* ================================================================== *
 * ⑥ 显示文本的卫生：不带内部 id / slug / 工具名
 * ================================================================== */

test('四个显示文本都不含 kp_id / 内部 slug / 工具名，且都是中文人话', () => {
  const displayTexts: Array<[string, string]> = [
    ['planRequestDisplayText(有名字)', planRequestDisplayText(KP_NAME)],
    ['planRequestDisplayText(无名字)', planRequestDisplayText('')],
    ['quizAskDisplayText(有名字)', quizAskDisplayText(KP_NAME)],
    ['quizAskDisplayText(无名字)', quizAskDisplayText('')]
  ]
  for (const [label, text] of displayTexts) {
    for (const bad of ['kp_id', 'kpId', KP_ID, 'get_', '【学习计划】', '【练习检验】', '知识点：']) {
      assert.ok(!text.includes(bad), label + ' 里出现了「' + bad + '」—— 学生气泡里不许有内部标识或写给模型的指令')
    }
    assert.ok(/[\u4e00-\u9fff]/.test(text), label + ' 必须是中文人话，实得：' + JSON.stringify(text))
  }
})
