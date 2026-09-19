/**
 * 「在途去重必须看**请求键**」的回归守卫（三个 store：quiz / code / animation）。
 *
 * ★★ 被钉住的缺陷（实测形态）：三个 store 原来都是
 *   `if (xxxInFlight) return await xxxInFlight` —— 只问「有没有请求在飞」，
 *   **完全不看这次要取的是哪个知识点**。于是 sidecar 冷启动或卡顿时，学生连点
 *   两个关卡 / 两个模板，第二个请求被**静默丢掉**，而 store 的 `activeKpId`
 *   已经被切到 B：
 *     - 闯关页：`activeKpId` 是 B 而 `bank` 还是 A 的题 → **学生对着错误标题作答**；
 *     - 编程页更重：视图的 `selectedKpId` 已是 B，`analyzeRun` 拿 `activeKpId`（= A）
 *       把 B 的代码按 A 的知识点去分析并给提示。
 *
 * 这一组要同时证明**三件事**（少一条就说明修法不对）：
 *   ① 键不同 → **不丢**新请求（第二个知识点真的发出去了）；
 *   ② 键相同 → 仍然去重（同一知识点连点不该发两次）；
 *   ③ 落库的是**最后一次**请求的结果（迟到的旧响应不许把界面盖回旧题目）。
 *
 * 另外钉住任务 ②：**换 kpId 清 `hints` / `hintError`，同一 kpId 内保留**。
 *
 * 跑法：`npm test`（`node --test`，Node 内置类型擦除 + 内置断言，不引入测试框架）。
 * ★ 与其它渲染进程测试同一手法：装一个 resolve hook 给「相对且没写扩展名」的说明符补 `.ts`，
 *   这样单测跑的是**渲染进程的真实实现**；被测模块必须用**动态 import**（静态 import 会
 *   被提到 hook 注册之前）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

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

/* ------------------------------------------------------------------ *
 * 假 window.api：**可控时延**（这是本组的关键 —— 缺陷只在并发下出现）
 * ------------------------------------------------------------------ */

/** 一次记录下来的请求（含它对应的延迟与解析函数）。 */
interface PendingCall {
  method: string
  payload: Record<string, unknown>
  /** 让这次请求返回。 */
  resolve: (value: unknown) => void
  /** 让这次请求抛异常（覆盖「传输失败」那条路径）。 */
  reject: (error: unknown) => void
}

interface Harness {
  /** 按方法名收下所有**还没放行**的调用。 */
  calls: Record<string, PendingCall[]>
  /** 放行某一方法第 index 次调用（按发起顺序）。 */
  release: (method: string, index: number, data: unknown) => void
  /** 让某一方法第 index 次调用以失败告终。 */
  fail: (method: string, index: number, message: string) => void
  count: (method: string) => number
}

const DATA_METHODS = [
  'getStudent',
  'readProfile',
  'readRecommendation',
  'readGradeSignals',
  'readGradeHistory',
  'readQuizBank',
  'gradeQuiz',
  'readQuizProgress',
  'readCodeTemplate',
  'readCodeHint',
  'analyzeCodeRun',
  'readAnimationTemplates',
  'renderAnimation',
  'hostAnimation',
  'readKnowledgeStats',
  'readKnowledgePoints',
  'importKnowledge',
  'rebuildKnowledge'
] as const

/**
 * 装一个**手动放行**的假桥。
 *
 * ★ 为什么不用「立即 resolve」：要证明「键变了没把请求丢掉」，必须让请求**停在飞行中**
 *   （第一个请求还没回来时发起第二个）—— 立即 resolve 的假桥在 `await` 之后
 *   第一个请求就已经落地了，测出来的是顺序调用而不是并发调用。
 */
function installControllableBridge(): Harness {
  const calls: Record<string, PendingCall[]> = {}
  for (const method of DATA_METHODS) calls[method] = []

  const api: Record<string, unknown> = {}
  for (const method of DATA_METHODS) {
    api[method] = (payload: Record<string, unknown> = {}) =>
      new Promise((resolve, reject) => {
        calls[method].push({ method, payload, resolve, reject })
      })
  }
  api.onTraceChanged = () => () => {}
  api.onGradeChanged = () => () => {}
  api.getGrade = async () => ({ ok: false, message: '测试里不提供初始值' })
  api.onChapterChanged = () => () => {}
  api.getChapter = async () => ({ ok: false, message: '测试里不提供初始值' })
  api.onChatEvent = () => () => {}
  api.sendChat = async () => ({ ok: true, requestId: 'turn-1', message: null })
  api.getSidecarInfo = async () => ({ phase: 'ready' })
  api.onSidecarChanged = () => () => {}

  ;(globalThis as unknown as { window: unknown }).window = { api }

  return {
    calls,
    count: (method) => calls[method]?.length ?? 0,
    release: (method, index, data) => {
      const call = calls[method]?.[index]
      assert.ok(call, `${method} 的第 ${index} 次调用不存在（实际 ${calls[method]?.length ?? 0} 次）`)
      call.resolve({ ok: true, data })
    },
    fail: (method, index, message) => {
      const call = calls[method]?.[index]
      assert.ok(call, `${method} 的第 ${index} 次调用不存在（实际 ${calls[method]?.length ?? 0} 次）`)
      call.resolve({ ok: false, message })
    }
  }
}

/** 让已经 resolve 的 promise 链跑完（store 里 await 之后的赋值才会发生）。 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

/* ================================================================== *
 * ① 闯关：连点两关不丢第二个请求
 * ================================================================== */

test('★★ 闯关：前一个请求还在飞时切到另一关 —— 第二个请求必须真的发出去，且落库的是 B 的题', async () => {
  const bridge = installControllableBridge()
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  // 学生点 A 关（请求停在飞行中，模拟 sidecar 冷启动/卡顿）
  const first = quiz.loadBank('kp-a', 3)
  await flush()
  assert.equal(bridge.calls.readQuizBank.length, 1, '第一次请求应当发出去')
  assert.equal(bridge.calls.readQuizBank[0]?.payload.kpId, 'kp-a')

  // 还没回来就点了 B 关 —— 旧实现会在这里 `return await bankInFlight`，B 的请求**永不发出**
  const second = quiz.loadBank('kp-b', 3)
  await flush()
  assert.equal(
    bridge.calls.readQuizBank.length,
    2,
    '★ 键变了就必须发新请求（旧实现把第二个请求丢掉了：界面在 B、题还是 A 的）'
  )
  assert.equal(bridge.calls.readQuizBank[1]?.payload.kpId, 'kp-b')

  // 迟到的 A 响应先回来：不许把 B 的请求结果状态（银行）盖成 A 的题
  bridge.release('readQuizBank', 0, { kpId: 'kp-a', source: 'bank', questions: [] })
  await flush()
  // ★ 写成 `=== null` 的布尔断言：`assert.equal`（= strictEqual）带 asserts 签名，
  //   直接断言 `bank === null` 会把它的类型**收窄成 null**，后面再读 `bank?.kpId` 就编不过。
  assert.equal(quiz.bank === null, true, '迟到的 A 响应不许落库（此时该显示的是 B 的题，还没回来）')

  bridge.release('readQuizBank', 1, { kpId: 'kp-b', source: 'bank', questions: [] })
  await Promise.all([first, second])
  await flush()
  assert.equal(quiz.bank?.kpId, 'kp-b', '★ 落库的必须是**最后一次**请求的结果（B）')
  assert.equal(quiz.bankLoading, false, '两次请求都结束后加载态要收')
})

test('★ 闯关：同一关连点仍然去重（键相同不该发两次）', async () => {
  const bridge = installControllableBridge()
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  const all = Promise.all([quiz.loadBank('kp-a', 3), quiz.loadBank('kp-a', 3), quiz.loadBank('kp-a', 3)])
  await flush()

  assert.equal(bridge.calls.readQuizBank.length, 1, '同一请求键的并发只该打一次接口（这条不能一起丢）')
  bridge.release('readQuizBank', 0, { kpId: 'kp-a', source: 'bank', questions: [] })
  await all
  assert.equal(quiz.bank?.kpId, 'kp-a')
})

test('★ 闯关：题量（count）也是请求键的一部分', async () => {
  const bridge = installControllableBridge()
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  const first = quiz.loadBank('kp-a', 3)
  await flush()
  const second = quiz.loadBank('kp-a', 5)
  await flush()

  assert.equal(bridge.calls.readQuizBank.length, 2, '同一关但题量不同 = 不同的请求，不该被当成重复')
  assert.equal(bridge.calls.readQuizBank[1]?.payload.count, 5)
  bridge.release('readQuizBank', 0, { kpId: 'kp-a', source: 'bank', questions: [] })
  bridge.release('readQuizBank', 1, { kpId: 'kp-a', source: 'bank', questions: [] })
  await Promise.all([first, second])
})

/* ================================================================== *
 * ② 编程：换题必须真的换模板（否则分析会按上一个知识点给提示）
 * ================================================================== */

test('★★ 编程：前一个模板还在飞时切到另一题 —— 第二个请求必须真的发出去，且落库的是 B 的模板', async () => {
  const bridge = installControllableBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  const first = code.loadTemplate('kp-a')
  await flush()
  assert.equal(bridge.calls.readCodeTemplate.length, 1)
  assert.equal(code.activeKpId, 'kp-a')

  const second = code.loadTemplate('kp-b')
  await flush()
  assert.equal(
    bridge.calls.readCodeTemplate.length,
    2,
    '★ 键变了就必须发新请求 —— 否则 activeKpId 停在 A、视图已切到 B，' +
      'analyzeRun 会把 B 的代码按 A 的知识点去分析'
  )
  assert.equal(bridge.calls.readCodeTemplate[1]?.payload.kpId, 'kp-b')
  assert.equal(code.activeKpId, 'kp-b', '当前题目必须立刻跟着学生的选择走')

  bridge.release('readCodeTemplate', 0, {
    kpId: 'kp-a',
    language: 'python',
    scaffold: '# A 的脚手架',
    expectedBehavior: 'A'
  })
  await flush()
  // 同上一处：布尔断言，避免把 `template` 收窄成 null 导致后面的 `.kpId` 编不过
  assert.equal(code.template === null, true, '迟到的 A 模板不许落库（学生已经在看 B 了）')

  bridge.release('readCodeTemplate', 1, {
    kpId: 'kp-b',
    language: 'python',
    scaffold: '# B 的脚手架',
    expectedBehavior: 'B'
  })
  await Promise.all([first, second])
  await flush()
  assert.equal(code.template?.kpId, 'kp-b', '★ 落库的必须是最后一次请求的模板')
  assert.equal(code.templateLoading, false)
})

test('★ 编程：同一题连点仍然去重', async () => {
  const bridge = installControllableBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  const all = Promise.all([code.loadTemplate('kp-a'), code.loadTemplate('kp-a')])
  await flush()
  assert.equal(bridge.calls.readCodeTemplate.length, 1, '同一知识点的并发取模板只该打一次')
  bridge.release('readCodeTemplate', 0, {
    kpId: 'kp-a',
    language: 'python',
    scaffold: '# TODO',
    expectedBehavior: 'x'
  })
  await all
})

/* ================================================================== *
 * ③ 动画：换过滤条件必须真的换清单
 * ================================================================== */

test('★★ 动画：前一次模板清单还在飞时换知识点 —— 第二个请求必须真的发出去', async () => {
  const bridge = installControllableBridge()
  const { useAnimationStore } = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())
  const anim = useAnimationStore()

  const first = anim.loadTemplates({ kpId: 'kp-a' })
  await flush()
  assert.equal(bridge.calls.readAnimationTemplates.length, 1)
  assert.equal(bridge.calls.readAnimationTemplates[0]?.payload.kpId, 'kp-a')

  const second = anim.loadTemplates({ kpId: 'kp-b' })
  await flush()
  assert.equal(
    bridge.calls.readAnimationTemplates.length,
    2,
    '★ 键（kpId + 学段）变了就必须发新请求，否则舞台上播的还是上一个知识点的模板'
  )
  assert.equal(bridge.calls.readAnimationTemplates[1]?.payload.kpId, 'kp-b')

  bridge.release('readAnimationTemplates', 0, { total: 1, matched: [], available: ['a'] })
  await flush()
  assert.equal(anim.templates, null, '迟到的旧清单不许落库')

  bridge.release('readAnimationTemplates', 1, {
    total: 1,
    matched: [
      {
        id: 'tpl-b',
        label: 'B',
        title: 'B',
        concept: 'c',
        kpIds: ['kp-b'],
        gradeLevels: ['junior'],
        durationMs: 1000,
        params: [],
        fallbackText: 'f',
        hasFallbackImage: false
      }
    ],
    available: ['tpl-b']
  })
  await Promise.all([first, second])
  await flush()
  assert.equal(anim.matched[0]?.id, 'tpl-b', '★ 落库的是最后一次请求的清单')
  assert.equal(anim.templatesLoading, false)
})

test('★ 动画：同一次查询连点仍然去重；不问过滤条件时仍有「已有数据不重复取」的短路', async () => {
  const bridge = installControllableBridge()
  const { useAnimationStore } = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())
  const anim = useAnimationStore()

  const all = Promise.all([anim.loadTemplates(), anim.loadTemplates()])
  await flush()
  assert.equal(bridge.calls.readAnimationTemplates.length, 1, '同一请求键的并发只该打一次')
  bridge.release('readAnimationTemplates', 0, { total: 0, matched: [], available: [] })
  await all

  await anim.loadTemplates()
  assert.equal(
    bridge.calls.readAnimationTemplates.length,
    1,
    '已经有清单且不带过滤条件时不该重新请求（原来那条短路必须保留）'
  )
})

/* ================================================================== *
 * ④ 换题清提示（任务 ②）：换 kpId 清、同一 kpId 保留
 * ================================================================== */

test('★★ 编程：换知识点清掉已给的提示与提示错误（同一知识点内保留）', async () => {
  const bridge = installControllableBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  // 在 A 上连要三级提示（再用一次失败把 hintError 也点上）
  const loadA = code.loadTemplate('kp-a')
  await flush()
  bridge.release('readCodeTemplate', 0, {
    kpId: 'kp-a',
    language: 'python',
    scaffold: '# TODO',
    expectedBehavior: 'x'
  })
  await loadA
  for (let level = 1; level <= 3; level += 1) {
    const pending = code.askForHint()
    await flush()
    bridge.release('readCodeHint', level - 1, { level, hint: `A 的第 ${level} 级提示` })
    await pending
  }
  assert.equal(code.currentHintLevel, 3)
  assert.equal(code.canAskMoreHints, false)

  // 再点一次「求助」到顶 → 写下 hintError（这是要一起清掉的残渣之一）
  await code.askForHint()
  assert.ok(code.hintError !== null, '到顶后再点会留下一句提示已给完的说明')

  // ── 切到 B ────────────────────────────────────────────────────────
  const loadB = code.loadTemplate('kp-b')
  await flush()
  assert.deepEqual(code.hints, [], '★ 换知识点必须清空已给提示（A 的第 1/2 级文本不许出现在 B 的任务卡里）')
  assert.equal(code.hintError, null, '提示错误同样不许残留')
  assert.equal(
    code.canAskMoreHints,
    true,
    '★ B 的「求助」必须可用 —— 残留的 hints 会让按钮直接 disabled（学生以为 B 没有提示）'
  )
  bridge.release('readCodeTemplate', 1, {
    kpId: 'kp-b',
    language: 'python',
    scaffold: '# TODO',
    expectedBehavior: 'y'
  })
  await loadB

  // ── 同一知识点内再取一次：提示**保留**（学生已经看过的提示不该凭空消失）──
  const again = code.askForHint()
  await flush()
  bridge.release('readCodeHint', 3, { level: 1, hint: 'B 的第 1 级提示' })
  await again
  assert.equal(code.currentHintLevel, 1)

  const reload = code.loadTemplate('kp-b')
  await flush()
  bridge.release('readCodeTemplate', 2, {
    kpId: 'kp-b',
    language: 'python',
    scaffold: '# TODO',
    expectedBehavior: 'y'
  })
  await reload
  assert.equal(code.currentHintLevel, 1, '★ 同一知识点内重取模板不许清掉已给的提示')
})

test('★ 编程：运行失败随结果给的 nextHint 要记进「已给到的级别」（否则求助会倒退到第 1 级）', async () => {
  const bridge = installControllableBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  const load = code.loadTemplate('kp-a')
  await flush()
  bridge.release('readCodeTemplate', 0, {
    kpId: 'kp-a',
    language: 'python',
    scaffold: '# TODO',
    expectedBehavior: 'x'
  })
  await load

  // 运行失败：后端随结果一并给第 2 级提示（`evaluation.nextHint`）
  const run = code.analyzeRun({ code: 'x', stdout: '', stderr: 'boom', attempt: 2 })
  await flush()
  bridge.release('analyzeCodeRun', 0, {
    ok: false,
    stdout: '',
    error: null,
    feedback: '还没通过',
    nextHint: { level: 2, hint: '第二级提示' }
  })
  await run

  assert.equal(
    code.currentHintLevel,
    2,
    '★ 后端已经给到第 2 级 → store 必须记住（不记就会让下一次「求助」要回第 1 级，与「逐级加深」正相反）'
  )

  // 学生点「求助」：应当要**第 3 级**，而不是回头要第 1 级
  const hint = code.askForHint()
  await flush()
  assert.equal(
    bridge.calls.readCodeHint[0]?.payload.level,
    3,
    '求助要的级别必须是「已给到的最高级 + 1」，不许倒退'
  )
  bridge.release('readCodeHint', 0, { level: 3, hint: '第三级提示' })
  await hint
  assert.equal(code.currentHintLevel, 3)
  assert.equal(code.canAskMoreHints, false)
})

/* ================================================================== *
 * ⑤ 学生可见的失败文案（任务 ③）：排障细节不许上屏
 * ================================================================== */

test('★★ 三个 store 的失败文案都不许带 HTTP 状态码 / 服务器路径 / 内部 kp_id', async () => {
  const bridge = installControllableBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  const { useAnimationStore } = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())

  /** 后端面向排障的 detail 长这样（三种能力的真实形态各一条）。 */
  const TECHNICAL = /HTTP\s*\d{3}|server[\\/]|resources[\\/]|\/api\/|'[a-z][a-z0-9-]*-[a-z]/

  const code = useCodeStore()
  const loadA = code.loadTemplate('kp-a')
  await flush()
  bridge.release('readCodeTemplate', 0, {
    kpId: 'kp-a',
    language: 'python',
    scaffold: '# TODO',
    expectedBehavior: 'x'
  })
  await loadA
  const hint = code.askForHint()
  await flush()
  bridge.calls.readCodeHint[0]?.resolve({
    ok: false,
    message:
      "读取失败（HTTP 404）：知识点 'prog-variable-jr' 还没有分级提示" +
      '（模板文件：server/resources/code-templates/）。'
  })
  await hint
  assert.ok(code.hintError !== null)
  assert.doesNotMatch(code.hintError, TECHNICAL, `提示失败文案里不该有排障细节：${code.hintError}`)
  assert.match(code.hintError, /提示/, '要保留「这道题还没有提示」这件事本身（学生才知道下一步做什么）')

  const quiz = useQuizStore()
  const bank = quiz.loadBank('kp-a', 3)
  await flush()
  bridge.fail(
    'readQuizBank',
    0,
    "读取失败（HTTP 404）：知识点 'data-processing-jr' 在 junior 及更低学段没有题目（题库文件：server/resources/quizbank/）"
  )
  await bank
  assert.ok(quiz.bankError !== null)
  assert.doesNotMatch(quiz.bankError, TECHNICAL, `题库失败文案里不该有排障细节：${quiz.bankError}`)

  const anim = useAnimationStore()
  const templates = anim.loadTemplates({ kpId: 'kp-a' })
  await flush()
  bridge.fail('readAnimationTemplates', 0, '操作失败（HTTP 503）：本机没有可用的动画模板（server/resources/templates/ 为空）')
  await templates
  assert.ok(anim.templatesError !== null)
  assert.doesNotMatch(anim.templatesError, TECHNICAL, `动画失败文案里不该有排障细节：${anim.templatesError}`)
})

test('★ 连接层失败翻成中文（`fetch failed` / ECONNREFUSED 不许直出英文）', async () => {
  const bridge = installControllableBridge()
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  const bank = quiz.loadBank('kp-a', 3)
  await flush()
  const call = bridge.calls.readQuizBank[0]
  assert.ok(call)
  // Node 的 fetch 在连接被拒时抛的就是这个形态：真正的原因在 cause.code 里
  const failure = new TypeError('fetch failed')
  ;(failure as unknown as { cause: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED'
  })
  call.reject(failure)
  await bank

  assert.ok(quiz.bankError !== null)
  assert.doesNotMatch(quiz.bankError, /fetch failed|ECONNREFUSED|TypeError/, '英文连接错误不许直出给学生')
  assert.match(quiz.bankError, /本地数据服务/, '要说清是「连不上本地数据服务」而不是一句英文')
})
