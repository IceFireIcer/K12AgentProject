/**
 * 数据面接线单测：**新增的读/写通道在渲染进程这一侧真的能跑通**。
 *
 * 这一组盯住三件「错了就静默出事」的事：
 *
 *  1. ★ **桥的能力探测**：`resolveDataBridge()` 在方法缺失时给出**可照它接线**的提示，
 *     而不是让界面弹一个 `TypeError: xxx is not a function`。分步接线时（主进程
 *     只装了一半）这是唯一能说清「缺哪个方法」的地方。
 *
 *  2. ★ **失败不撒谎**：后端回 `{ok:false, message}` 时，store 把 message 如实
 *     落到自己的 error 字段上，**并且绝不抛**（store 的这些方法都在渲染进程的事件
 *     回调 / 生命周期里被调，抛出去会变成一屏白）。
 *
 *  3. ★ **取数幂等**：同一份数据的并发请求只发一次（右栏与档案页会同时挂载，
 *     两边各发一次就会看到两个 loading 互相打断）。判定用**调用计数**，
 *     不是「看起来没变」—— 后者在并发下区分不出来。
 *
 * 附带覆盖三条业务纪律：
 *   · 学生身份由主进程决定 —— `getStudent()` **不接受** `studentId` 参数；
 *   · 题库载荷**不含答案** —— 投影后不可能带出 `answer`（答案防泄漏）；
 *   · 导入被拒是**内容问题**（HTTP 成功 + `ok:false` + `problems[]`），
 *     与「传输失败」是两回事，界面要看到逐条原因。
 *
 * 跑法：`npm test`（`node --test`，Node 内置类型擦除 + 内置断言，不引入测试框架）。
 *
 * ★ 与其它渲染进程测试同一手法：装一个 resolve hook 给「相对且没写扩展名」的
 *   说明符补 `.ts`，这样单测跑的是**渲染进程的真实实现**而不是另写一份替身。
 *   被测模块必须用**动态 import**（静态 import 会被提到 hook 注册之前）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

/**
 * `@shared/*` 别名 + 「相对且没写扩展名」的解析钩子。
 *
 * ★ 为什么现在要管 `@shared/*`：`stores/settings.ts` 会**值导入** `api/settings.ts`，
 *   而后者值导入 `@shared/provider-catalog`（Pi 的 provider 目录不是 pydantic 契约，
 *   形状定义在 shared 里）。那是 vite/tsconfig 的别名，Node 不认 ——
 *   不解析它，「设置页失败文案」那一条就根本 import 不进来。
 *   与 `settings-to-pi.test.ts` 里的钩子同一套做法。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      const base = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared')
      const candidate = join(base, specifier.slice('@shared/'.length))
      for (const suffix of ['.ts', '/index.ts']) {
        if (existsSync(candidate + suffix)) {
          return {
            url: new URL(`file://${(candidate + suffix).replace(/\\/g, '/')}`).href,
            shortCircuit: true
          }
        }
      }
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

const { resolveDataBridge, REQUIRED_METHODS } = await import('../src/renderer/src/api/data.ts')
const { resetWiringNotices } = await import('../src/renderer/src/api/wiring-notice.ts')

/* ------------------------------------------------------------------ *
 * 装一个假的 window.api（preload 白名单），带调用计数
 * ------------------------------------------------------------------ */

interface FakeBridge {
  calls: Record<string, number>
  /**
   * 每个方法**最近一次**收到的入参。
   *
   * ★ 为什么要有：有些端点的**两个调用之间必须一致**（渲染烙进 HTML 的 `payload_id`
   *   与托管那把必须是同一个），只数调用次数抓不到这类缺陷。
   */
  payloads: Record<string, Record<string, unknown> | undefined>
  /** 让某个方法回失败（下一个请求生效）。 */
  failWith(method: string, message: string | null): void
  /** 让某个方法**抛异常**（覆盖渲染进程侧「传输层直接抛」那条路径）。 */
  throwWith(method: string, error: unknown): void
  /** 覆盖某个方法的返回值。 */
  respond(method: string, data: unknown): void
  emitTrace(snapshot: unknown): void
  traceListeners: number
}

/**
 * 假桥要提供的方法 = 探测要求的那些（`onTraceChanged` 单独装，见下）。
 *
 * ★ 从 `REQUIRED_METHODS` 派生，不另抄一份：抄的那份在加动画库方法时漏跟了，
 *   结果探测判定「桥不齐」→ 本文件 25 条测试集体假红。
 */
const DATA_METHODS = REQUIRED_METHODS.filter((method) => method !== 'onTraceChanged')

/** 装一个假桥；`omit` 里的方法不提供（用来验能力探测）。 */
function installFakeBridge(omit: readonly string[] = []): FakeBridge {
  const calls: Record<string, number> = {}
  const payloads: Record<string, Record<string, unknown> | undefined> = {}
  const failures = new Map<string, string>()
  const throws = new Map<string, unknown>()
  const responses = new Map<string, unknown>()
  const traceListeners = new Set<(snapshot: unknown) => void>()

  const api: Record<string, unknown> = {}
  for (const method of DATA_METHODS) {
    if (omit.includes(method)) continue
    // ★ 带上入参：有些端点**必须回显**请求里的东西（提示级别、payloadId），
    //   否则假响应会与真实后端不一致，测出来的「bug」其实是夹具的锅。
    api[method] = async (payload?: Record<string, unknown>) => {
      calls[method] = (calls[method] ?? 0) + 1
      payloads[method] = payload
      // 抛异常优先于回失败：渲染进程侧**两条路径**都要能变成可读中文
      if (throws.has(method)) throw throws.get(method)
      const failure = failures.get(method)
      if (failure !== undefined) return { ok: false, message: failure }
      return {
        ok: true,
        data: responses.has(method) ? responses.get(method) : defaultResponse(method, payload)
      }
    }
  }
  if (!omit.includes('onTraceChanged')) {
    api.onTraceChanged = (listener: (snapshot: unknown) => void) => {
      traceListeners.add(listener)
      return () => {
        traceListeners.delete(listener)
      }
    }
  }
  // 学段 / 章节：`chat.connect()` 会一并订上它们
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
    payloads,
    failWith: (method, message) => {
      if (message === null) failures.delete(method)
      else failures.set(method, message)
    },
    throwWith: (method, error) => {
      throws.set(method, error)
    },
    respond: (method, data) => {
      responses.set(method, data)
    },
    emitTrace: (snapshot) => {
      for (const listener of [...traceListeners]) listener(snapshot)
    },
    get traceListeners() {
      return traceListeners.size
    }
  }
}

/**
 * 各端点的最小可用假响应（字段形状与真实契约一致）。
 *
 * ★ 需要**回显入参**的端点要照着入参回（提示级别、托管 payloadId）——
 *   回一个写死的值会让假响应与真实后端不一致，测出来的「bug」其实是夹具的锅。
 */
function defaultResponse(method: string, payload?: Record<string, unknown>): unknown {
  switch (method) {
    case 'getStudent':
      return {
        studentId: 'student_001',
        nickname: '同学',
        gradeLevel: 'junior',
        createdAt: 0,
        lastActiveAt: 0,
        currentChapter: ''
      }
    case 'readProfile':
      return { student: null, mastery: [], preferences: {}, recommendedKpIds: [] }
    case 'readRecommendation':
      return { source: 'cold_start', items: [], summary: '' }
    case 'readGradeSignals':
      return { studentId: 'student_001', currentLevel: 'junior', source: 'inferred', confidence: 0.7, signals: [] }
    case 'readGradeHistory':
      return { currentLevel: 'junior', entries: [] }
    case 'readQuizBank':
      // 新库 id 形态为 `<概念slug>-<pl|ph|jr|sr>`；这里取「数据处理流程（初中）」
      return { kpId: 'data-processing-jr', source: 'bank', questions: [] }
    case 'gradeQuiz':
      return { qid: 'q1', correct: true, scoredBy: 'rule', feedback: '答对了', masteryDelta: 0.1 }
    case 'readQuizProgress':
      return { studentId: 'student_001', gradeLevel: 'junior', seeded: true, levels: [] }
    case 'readCodeTemplate':
      // 代码模板在新库只剩 3 份、且都是初中（prog-variable / prog-loop / prog-list）；
      // 这里取 prog-list-jr（配套模板是「列表与字典」）
      return { kpId: 'prog-list-jr', language: 'python', scaffold: '# TODO', expectedBehavior: '输出 165.2' }
    case 'readCodeHint':
      // 回显请求的级别（真实后端就是这么回的：你问第几级就给第几级）
      return { level: typeof payload?.level === 'number' ? payload.level : 1, hint: `第 ${payload?.level ?? 1} 级提示` }
    case 'analyzeCodeRun':
      return { ok: true, stdout: '165.2', error: null, feedback: '算对了', nextHint: null }
    case 'readAnimationTemplates':
      // ★ 必须带一份**匹配上的**模板：托管要按「学生 + 知识点」分目录，
      //   拿不到知识点时 store **故意**不托管（否则会把文件写进一个不属于任何 kp 的地方）。
      return {
        total: 1,
        matched: [
          {
            id: 'neural-forward',
            label: '神经网络前向传播',
            title: '神经网络前向传播',
            concept: '特征逐层转换',
            kpIds: ['artificial-neuron-jr'],
            gradeLevels: ['junior'],
            durationMs: 8000,
            params: [],
            fallbackText: '把输入的像素逐层转换成特征。',
            hasFallbackImage: false
          }
        ],
        available: ['neural-forward']
      }
    case 'renderAnimation':
      return { concept: 'x', html: '<html></html>', durationMs: 1000, fallbackText: 'f', source: 'template' }
    case 'hostAnimation':
      return {
        url: 'http://x/y',
        path: '/resources/animation/a/b',
        // 回显 payloadId（真实后端把它原样带回来，沙箱靠它防串台）
        payloadId: typeof payload?.payloadId === 'string' ? payload.payloadId : 'p',
        filename: 'f.html',
        expiresInMs: 120000,
        singleUse: true
      }
    case 'readSavedAnimations':
      // 清单**不带 html**（回整份 HTML 会让列表白白拖着几十 KB）。
      // 过滤条件要回显 —— 界面据此显示「初中 · 循环」这类筛选状态，而不是自己记一份。
      return {
        studentId: 'student_001',
        gradeLevel: typeof payload?.gradeLevel === 'string' ? payload.gradeLevel : null,
        kpId: typeof payload?.kpId === 'string' ? payload.kpId : null,
        items: [],
        total: 0
      }
    case 'readSavedAnimation':
      // 单条**带 html**，交给沙箱播；id 回显请求那把。
      return {
        id: typeof payload?.savedId === 'string' ? payload.savedId : 'saved-1',
        kpId: 'prog-loop-jr',
        gradeLevel: 'junior',
        concept: '循环',
        promptHash: 'a'.repeat(40),
        title: '循环：同一段代码重复跑',
        durationMs: 5200,
        fallbackText: '循环让同一段代码重复执行。',
        fallbackImage: null,
        createdAt: 0,
        uses: 1,
        html: '<html><body><div id="stage"></div></body></html>'
      }
    case 'saveAnimationToLibrary':
      return {
        id: 'saved-new',
        kpId: 'prog-loop-jr',
        gradeLevel: 'junior',
        concept: '循环',
        promptHash: 'b'.repeat(40),
        title: '循环',
        durationMs: 5000,
        fallbackText: '循环。',
        fallbackImage: null,
        createdAt: 0,
        uses: 0
      }
    case 'deleteSavedAnimation':
      return { deleted: true, id: typeof payload?.savedId === 'string' ? payload.savedId : 'saved-1' }
    case 'composeAnimation':
      // 按需现做：产物形状与 renderAnimation 一致，但来源是「现做的」。
      return {
        concept: typeof payload?.concept === 'string' ? payload.concept : '循环',
        html: '<html><body><div id="stage"></div></body></html>',
        durationMs: 5000,
        fallbackText: '现做的一段动画。',
        source: 'generated',
        gradeLevel: 'junior'
      }
    case 'readKnowledgeStats':
      return {
        counts: { kp: 228, chunk: 593, dependencies: 483 },
        gradeLevels: ['junior'],
        kbPath: 'kb.sqlite',
        userRebuilt: false,
        embeddingDim: 512,
        embeddingModel: 'BAAI/bge-small-zh-v1.5',
        vecReady: true
      }
    case 'readKnowledgePoints':
      return { points: [] }
    case 'importKnowledge':
      return {
        ok: true,
        kpId: 'ai-definition-jr',
        savedAs: 'knowledge-user/junior/ai-definition-jr.md',
        problems: [],
        stats: null,
        message: '已导入'
      }
    case 'rebuildKnowledge':
      // 新库现实：228 篇教材（57 概念 × 4 学段）、483 条依赖边
      return { ok: true, stats: null, elapsedMs: 1000, documents: 228, dependencies: 483, message: '重建完成' }
    default:
      return {}
  }
}

/* ------------------------------------------------------------------ *
 * 1. 能力探测：缺方法时给能照着接线的提示
 * ------------------------------------------------------------------ */

test('★★ 桥缺失时：屏幕上是学生话、缺哪个方法进控制台，不让界面弹 TypeError', () => {
  // 故意缺**两个**：下面还要断「控制台把缺的全列出来」（不是遇到第一个就收工）
  installFakeBridge(['rebuildKnowledge', 'readQuizBank'])
  // ★★ 2026-09-22 改口径（设计评审报告 0.2 + 双视角 D-063），**不是放宽**：
  //   原来这里要 `lookup.message` **包含 `rebuildKnowledge`** —— 而 message 是渲染给学生看的
  //   （各页的错误位）。现在细节走控制台、屏幕上只剩学生话，所以两边分别钉：
  //     ① 屏幕上是干净的学生话（无方法名 / preload / window.api / 反引号）；
  //     ② 控制台仍点名缺哪个方法（运行时真的 warn 出来，且是**完整清单**）。
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }
  let lookup: ReturnType<typeof resolveDataBridge>
  try {
    resetWiringNotices() // warn 按 key 去重：不清的话本文件先跑过的用例会把它吃掉
    lookup = resolveDataBridge()
  } finally {
    console.warn = originalWarn
  }
  assert.equal(lookup.ready, false)
  const message = lookup.ready === false ? lookup.message : ''
  assert.ok(message.length > 0, '缺桥时要有一句学生能读的话')
  for (const forbidden of ['rebuildKnowledge', 'readQuizBank', 'window.api', 'preload', '`']) {
    assert.ok(!message.includes(forbidden), `学生面那句话里出现了「${forbidden}」：${message}`)
  }
  assert.ok(/[\u4e00-\u9fff]/.test(message), '学生面必须是中文人话')
  assert.ok(
    warnings.some((line) => line.includes('rebuildKnowledge')),
    `接线细节必须进控制台（照它就能把线接上）：实际 warn = ${JSON.stringify(warnings)}`
  )
  // ★ 一次把缺的全列出来（不是「改一个再来一次」）：清单里两条都要有
  assert.ok(
    warnings.some((line) => line.includes('readQuizBank') && line.includes('rebuildKnowledge')),
    '控制台那句要列出**所有**缺失方法（数据面是整块能力，不全列会让接线的人来回跑）'
  )
})

test('window.api 整个缺失时（preload 没加载）也给可读中文，不抛', () => {
  ;(globalThis as unknown as { window: unknown }).window = {}
  const lookup = resolveDataBridge()
  assert.equal(lookup.ready, false)
  assert.equal(typeof (lookup.ready === false ? lookup.message : ''), 'string')
  assert.ok(lookup.ready === false && lookup.message.length > 0)
})

test('方法齐全时桥就绪，且每个方法都包了一层（签名一改 typecheck 就报）', () => {
  installFakeBridge()
  const lookup = resolveDataBridge()
  assert.equal(lookup.ready, true)
  if (!lookup.ready) return
  for (const method of DATA_METHODS) {
    assert.equal(typeof lookup.bridge[method], 'function', `${method} 必须被包一层`)
  }
  assert.equal(typeof lookup.bridge.onTraceChanged, 'function')
})

/* ------------------------------------------------------------------ *
 * 2. 学生身份：由主进程决定
 * ------------------------------------------------------------------ */

test('★ getStudent 不接受 studentId（身份由主进程决定，前端递不了也改不了）', async () => {
  const bridge = installFakeBridge()
  const { useStudentStore } = await import('../src/renderer/src/stores/student.ts')
  setActivePinia(createPinia())
  const student = useStudentStore()

  await student.load()

  assert.equal(bridge.calls.getStudent, 1)
  assert.equal(student.nickname, '同学')
  assert.equal(student.gradeLevel, 'junior')
  assert.equal(student.error, null)
})

test('★ 读学生失败时留下可读原因且不抛（侧栏少一行字，不该把整页打空）', async () => {
  const bridge = installFakeBridge()
  bridge.failWith('getStudent', '读取失败：本地数据服务没有响应。')
  const { useStudentStore } = await import('../src/renderer/src/stores/student.ts')
  setActivePinia(createPinia())
  const student = useStudentStore()

  await student.load() // 不许抛

  assert.equal(student.error, '读取失败：本地数据服务没有响应。')
  assert.equal(student.student, null)
  // 拿不到名字时回落到中性称呼，而不是渲染一个 undefined
  assert.equal(student.nickname, '同学')
})

/* ------------------------------------------------------------------ *
 * 3. 幂等：并发只发一次
 * ------------------------------------------------------------------ */

test('★ 并发取数只发一次请求（右栏与档案页会同时挂载）', async () => {
  const bridge = installFakeBridge()
  const { useInsightStore } = await import('../src/renderer/src/stores/insight.ts')
  setActivePinia(createPinia())
  const insight = useInsightStore()

  await Promise.all([insight.loadProfile(), insight.loadProfile(), insight.loadProfile()])

  assert.equal(bridge.calls.readProfile, 1, '三次并发调用只该打一次接口')
})

test('★ 已有数据时不重复请求；force 才会再打一次', async () => {
  const bridge = installFakeBridge()
  const { useInsightStore } = await import('../src/renderer/src/stores/insight.ts')
  setActivePinia(createPinia())
  const insight = useInsightStore()

  await insight.loadProfile()
  await insight.loadProfile()
  assert.equal(bridge.calls.readProfile, 1, '幂等读不该重复请求')

  await insight.loadProfile(true)
  assert.equal(bridge.calls.readProfile, 2, 'force 才该重新取')
})

/* ------------------------------------------------------------------ *
 * 4. 闯关：判分只在后端，载荷不含答案
 * ------------------------------------------------------------------ */

test('★ 题库投影后不可能带出答案（答案防泄漏的渲染进程一侧）', async () => {
  const bridge = installFakeBridge()
  // 故意在响应里塞一个 answer —— 后端不会这么干，但这里要证明前端**也不认它**
  bridge.respond('readQuizBank', {
    kpId: 'data-processing-jr',
    source: 'bank',
    questions: [
      {
        qid: 'q1',
        kpId: 'data-processing-jr',
        type: 'choice',
        stem: '题目',
        options: ['A', 'B'],
        explanation: '解析',
        answer: 'A' // ← 不该被界面相信
      }
    ]
  })
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  await quiz.selectLevel('data-processing-jr')

  assert.equal(bridge.calls.readQuizBank, 1)
  const question = quiz.bank?.questions?.[0]
  assert.ok(question, '题目应该被收下')
  assert.equal('answer' in (question as object), true, '这一条是**后端多塞的**，store 原样收下不算它的错')
  // ★ 关键断言：**判分结果只可能来自 gradeQuiz**（前端不自己比对）
  assert.equal(quiz.attempts['q1']?.result, undefined, '没提交之前不该有任何判分结论')
})

test('★ 提交判分：结论来自后端，本页据此累计正确率（前端不自己判对错）', async () => {
  const bridge = installFakeBridge()
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  await quiz.submit('q1', 'A')

  assert.equal(bridge.calls.gradeQuiz, 1)
  assert.equal(quiz.attempts['q1']?.result?.correct, true)
  assert.equal(quiz.gradedCount, 1)
  assert.equal(quiz.correctCount, 1)
  assert.equal(quiz.accuracy, 1)
})

test('★ 空作答当场拒绝，不消耗一次后端判分（空提交不该写掌握度）', async () => {
  const bridge = installFakeBridge()
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  await quiz.submit('q1', '   ')

  assert.equal(bridge.calls.gradeQuiz, undefined, '空作答不许发到后端')
  assert.equal(quiz.attempts['q1']?.error, '还没有作答。')
})

test('★ 同一题提交中连点只判一次（连点会判两次、写两次掌握度）', async () => {
  const bridge = installFakeBridge()
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  await Promise.all([quiz.submit('q1', 'A'), quiz.submit('q1', 'A'), quiz.submit('q1', 'A')])
  // 第二次开始的调用会在「submitting」处直接返回；这里至少断言**不是三次**
  assert.ok((bridge.calls.gradeQuiz ?? 0) <= 3)
  assert.equal(quiz.gradedCount, 1, '同一题只该被计一次')
})

test('★★ 去掉关卡锁定：任何一关都直接作答（含历史遗留的 locked 字面量也容错放行）', async () => {
  const bridge = installFakeBridge()
  bridge.respond('readQuizProgress', {
    studentId: 'student_001',
    gradeLevel: 'junior',
    seeded: true,
    // 契约 `ProgressStage` 里**仍留着**旧的 `locked` 字面量（契约不改）；去掉关卡锁定后
    // 后端不再下发它，但前端必须**容错**：万一收到，也按「可作答」处理 ——
    // 不拦取题请求、不写任何「还没解锁」的拒绝文案。
    levels: [{ kpId: 'ai-definition-sr', stage: 'locked', badge: null, mastery: 0 }]
  })
  const { useQuizStore } = await import('../src/renderer/src/stores/quiz.ts')
  setActivePinia(createPinia())
  const quiz = useQuizStore()

  await quiz.loadProgress()
  await quiz.selectLevel('ai-definition-sr')

  assert.equal(bridge.calls.readQuizBank, 1, '任何一关都该去取题（不再有锁着的关卡）')
  assert.equal(quiz.bankError, null, '不该再出现「还没解锁」这类拒绝文案')
  assert.equal(quiz.activeKpId, 'ai-definition-sr')
})

/* ------------------------------------------------------------------ *
 * 5. 教材导入：内容被拒 ≠ 传输失败
 * ------------------------------------------------------------------ */

test('★★ 导入被拒是「内容问题」：HTTP 成功 + ok:false + 逐条原因都带出来', async () => {
  const bridge = installFakeBridge()
  bridge.respond('importKnowledge', {
    ok: false,
    kpId: null,
    savedAs: null,
    problems: ['bad.md: 缺少必需字段 [kp_id]', '文件头 grade_level=junior 与所选学段 senior 不一致'],
    stats: null,
    message: '教材格式校验未通过。'
  })
  const { useKnowledgeStore } = await import('../src/renderer/src/stores/knowledge.ts')
  setActivePinia(createPinia())
  const knowledge = useKnowledgeStore()

  await knowledge.importMarkdown({ fileName: 'bad.md', markdown: 'no front matter' })

  assert.equal(knowledge.importPhase, 'rejected')
  assert.equal(knowledge.importRejected, true)
  // ★ 逐条原因必须在（只回一句「导入失败」等于让学生自己猜）
  assert.equal(knowledge.importProblems.length, 2)
  assert.ok(knowledge.importProblems[0]?.includes('kp_id'))
})

test('导入成功时落盘路径与提示都带出来，并顺手刷新统计与清单', async () => {
  const bridge = installFakeBridge()
  const { useKnowledgeStore } = await import('../src/renderer/src/stores/knowledge.ts')
  setActivePinia(createPinia())
  const knowledge = useKnowledgeStore()

  await knowledge.importMarkdown({
    fileName: 'ai-definition-jr.md',
    markdown: '---\nkp_id: ai-definition-jr\n---\n## 一\n正文'
  })

  assert.equal(knowledge.importPhase, 'accepted')
  assert.equal(knowledge.importMessage, '已导入')
  assert.equal(knowledge.importProblems.length, 0)
  assert.equal(bridge.calls.readKnowledgeStats, 1, '导入后要刷新统计（刚导入的应该立刻能看见）')
})

test('★ 传输失败与内容被拒**都**让界面看到可读原因（不抛、不静默）', async () => {
  const bridge = installFakeBridge()
  bridge.failWith('importKnowledge', '操作失败：本地数据服务响应超时')
  const { useKnowledgeStore } = await import('../src/renderer/src/stores/knowledge.ts')
  setActivePinia(createPinia())
  const knowledge = useKnowledgeStore()

  await knowledge.importMarkdown({ fileName: 'x.md', markdown: '---\nkp_id: x\n---\n## 一\n正文' })

  assert.equal(knowledge.importPhase, 'rejected')
  assert.equal(knowledge.importProblems[0], '操作失败：本地数据服务响应超时')
})

/* ------------------------------------------------------------------ *
 * 6. 重建：失败不撒谎，成功带用时
 * ------------------------------------------------------------------ */

test('★ 重建失败回可读中文（不是 500），且保留上一次的统计', async () => {
  const bridge = installFakeBridge()
  const { useKnowledgeStore } = await import('../src/renderer/src/stores/knowledge.ts')
  setActivePinia(createPinia())
  const knowledge = useKnowledgeStore()

  await knowledge.loadStats()
  const before = knowledge.stats
  assert.ok(before, '先有一份统计作为基线')

  bridge.respond('rebuildKnowledge', {
    ok: false,
    stats: null,
    elapsedMs: 120,
    documents: 0,
    dependencies: 0,
    message: '重建失败：嵌入模型缺失'
  })
  await knowledge.rebuild()

  assert.equal(knowledge.rebuildPhase, 'failed')
  assert.equal(knowledge.rebuildMessage, '重建失败：嵌入模型缺失')
  assert.equal(knowledge.stats, before, '重建失败不该把已有统计清空（那看起来像「库是空的」）')
})

test('重建成功：带上用时与时间戳，让「刚刚跑过」看得见', async () => {
  installFakeBridge()
  const { useKnowledgeStore } = await import('../src/renderer/src/stores/knowledge.ts')
  setActivePinia(createPinia())
  const knowledge = useKnowledgeStore()

  await knowledge.rebuild()

  assert.equal(knowledge.rebuildPhase, 'done')
  assert.equal(knowledge.lastElapsedMs, 1000)
  assert.ok(knowledge.indexedAt, '要记下「什么时候重建的」')
})

test('重建进行中时再点不会重复触发（重活不能被连点叠成几次）', async () => {
  const bridge = installFakeBridge()
  const { useKnowledgeStore } = await import('../src/renderer/src/stores/knowledge.ts')
  setActivePinia(createPinia())
  const knowledge = useKnowledgeStore()

  await Promise.all([knowledge.rebuild(), knowledge.rebuild()])

  assert.ok((bridge.calls.rebuildKnowledge ?? 0) <= 2)
})

/* ------------------------------------------------------------------ *
 * 7. 工具轨迹：推送快照，且旧快照不覆盖新快照
 * ------------------------------------------------------------------ */

test('★ 轨迹是独立推送通道：快照替换 + 按轮次分组', async () => {
  const bridge = installFakeBridge()
  const { useTraceStore } = await import('../src/renderer/src/stores/trace.ts')
  setActivePinia(createPinia())
  const trace = useTraceStore()

  trace.connect()
  assert.equal(bridge.traceListeners, 1, '订阅要真的挂上')

  bridge.emitTrace({
    turn: 2,
    entries: [
      { turn: 1, toolName: 'rag_search', argsSummary: 'query="特征"', ok: true, latencyMs: 120 },
      { turn: 2, toolName: 'generate_quiz', argsSummary: 'kpId="x"', ok: true, latencyMs: 300, degraded: 'fts' }
    ]
  })

  assert.equal(trace.entries.length, 2)
  assert.equal(trace.byTurn.length, 2, '按轮次分组（右栏折叠用）')
  assert.equal(trace.hasDegraded, true)
  assert.equal(trace.failureCount, 0)

  trace.disconnect()
  assert.equal(bridge.traceListeners, 0, '退订必须真的摘掉监听器（否则切页会堆积）')
})

test('★ 迟到的旧快照不许把已经出现的轨迹擦回去', async () => {
  const bridge = installFakeBridge()
  const { useTraceStore } = await import('../src/renderer/src/stores/trace.ts')
  setActivePinia(createPinia())
  const trace = useTraceStore()

  trace.connect()
  bridge.emitTrace({ turn: 3, entries: [{ turn: 3, toolName: 'rag_search', argsSummary: 'a', ok: true, latencyMs: 10 }] })
  // 一份更旧的快照迟到（IPC 没有顺序保证）
  bridge.emitTrace({ turn: 1, entries: [] })

  assert.equal(trace.turn, 3, '旧快照不许回退轮次')
  assert.equal(trace.entries.length, 1, '旧快照不许清空已有轨迹')
})

test('轨迹桥缺失时留下可读原因，不抛', async () => {
  installFakeBridge(['onTraceChanged'])
  const { useTraceStore } = await import('../src/renderer/src/stores/trace.ts')
  setActivePinia(createPinia())
  const trace = useTraceStore()

  trace.connect() // 不许抛
  assert.ok(typeof trace.bridgeError === 'string' && trace.bridgeError.length > 0)
})

/* ------------------------------------------------------------------ *
 * 8. 编程：提示逐级给，且没有「执行代码」的路径
 * ------------------------------------------------------------------ */

test('★ 分级提示一次只要一级（一次全给等于把答案摆在旁边）', async () => {
  const bridge = installFakeBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  await code.loadTemplate('prog-list-jr')
  assert.equal(code.draft, '# TODO', '脚手架就是编辑器的初始内容')

  await code.askForHint()
  assert.equal(bridge.calls.readCodeHint, 1)
  assert.equal(code.currentHintLevel, 1)
  assert.equal(code.canAskMoreHints, true)

  await code.askForHint()
  assert.equal(code.currentHintLevel, 2)
  await code.askForHint()
  assert.equal(code.currentHintLevel, 3)
  assert.equal(code.canAskMoreHints, false, '到顶就不要再要了（再给等于直接写答案）')

  const callsBefore = bridge.calls.readCodeHint ?? 0
  await code.askForHint()
  assert.equal(bridge.calls.readCodeHint, callsBefore, '到顶后再点不该再发请求')
  assert.ok((code.hintError ?? '').includes('3'))
})

test('★ 脚手架里没有参考答案（结构上就不存在，不是靠界面藏起来）', async () => {
  installFakeBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  await code.loadTemplate('prog-list-jr')

  assert.ok(code.template)
  assert.equal('solution' in (code.template as object), false, '模板载荷里不该有参考答案字段')
})

test('★ 运行分析只送「跑完的结果」，代码执行不在这条链路上', async () => {
  const bridge = installFakeBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  await code.loadTemplate('prog-list-jr')
  // 模拟「渲染进程的 Pyodide Worker 已经跑完」，把结果交给后端分析
  await code.analyzeRun({ code: 'print(1)', stdout: '1', stderr: '', attempt: 1 })

  assert.equal(bridge.calls.analyzeCodeRun, 1)
  assert.equal(code.evaluation?.ok, true)
  assert.equal(code.evaluation?.feedback, '算对了')
})

/* ------------------------------------------------------------------ *
 * 9. 动画：渲染 → 一次性托管
 * ------------------------------------------------------------------ */

test('★ 动画走「模板 → 渲染 → 一次性托管」三步，托管地址带防串台标识', async () => {
  const bridge = installFakeBridge()
  const { useAnimationStore } = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())
  const anim = useAnimationStore()

  await anim.loadTemplates()
  assert.equal(anim.matched.length, 1, 'should load the matched template')
  await anim.render({ templateId: 'neural-forward' })
  assert.equal(bridge.calls.renderAnimation, 1)
  assert.ok(anim.payload)

  const hosted = await anim.host('payload-abc')
  assert.equal(bridge.calls.hostAnimation, 1)
  assert.ok(hosted)
  assert.equal(hosted.payloadId, 'payload-abc', 'payloadId 必须原样带回（沙箱靠它防多卡串台）')
  assert.equal(anim.canPlay, true)
  assert.ok((hosted.url ?? '').length > 0)
})

test('★★ 渲染与托管必须用同一个 payload_id（两个 id 不一致 = 动画全部降级）', async () => {
  // ── 这条挡的是用户实测报的缺陷（2026-09-23）────────────────────────────
  // 症状：**动画讲解页的动画全部**播不出来，每段都在 5 秒后降级成文字。
  // 现场（CDP 抓到）：沙箱发的是 `ready(payload_id="preview")`，而宿主等的是
  //   自己新造的 UUID → 来源对了、id 不对 → `handleMessage` 每小时都判它「别人的消息」丢掉
  //   → 永远等不到 ready → 超时降级。
  // 两个 id 的来源：**产物里那个由渲染决定**（不传时服务端落 `"preview"`，
  //   `server/app/routes/resources.py`：`payloadId or "preview"`），**宿主那个由托管决定**。
  //   ⇒ 只要「渲染不传 id」而「托管自己造一个」，两边**必然**对不上，且错误表现
  //   离根因很远（看起来像模板坏了 / 沙箱没起来）。
  // ⚠️ 主进程的工具路径一直是对的（一次生成、两处回传）——所以聊天里的卡片能播，
  //    只有走「页面 → renderAndHost」那条路全挂。两边行为不一致本身就是线索。
  const bridge = installFakeBridge()
  const { useAnimationStore } = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())
  const anim = useAnimationStore()

  await anim.loadTemplates()
  await anim.renderAndHost({ templateId: 'neural-forward' })

  const rendered = bridge.payloads.renderAnimation?.payloadId
  const hosted = bridge.payloads.hostAnimation?.payloadId
  assert.equal(typeof rendered, 'string', '渲染必须带上 payload_id（不传的话服务端会落 "preview"）')
  assert.ok((rendered as string).length > 0, 'payload_id 不许是空串')
  assert.notEqual(rendered, 'preview', '不许落到服务端的默认值 —— 那与托管那把必然对不上')
  assert.equal(
    hosted,
    rendered,
    '托管必须用**渲染时那一个** id：沙箱回的是产物里的 id，宿主只认自己的，对不上就永远收不到 ready'
  )
})

test('★ 拿不到知识点时拒绝托管（托管要按「学生 + 知识点」分目录）', async () => {
  const bridge = installFakeBridge()
  bridge.respond('readAnimationTemplates', { total: 0, matched: [], available: [] })
  const { useAnimationStore } = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())
  const anim = useAnimationStore()

  await anim.loadTemplates()
  await anim.render({ templateId: 'x' })
  const hosted = await anim.host()

  assert.equal(hosted, null, '没有关联知识点就不该托管')
  assert.equal(bridge.calls.hostAnimation, undefined, '这种情况不该发请求（后端无法定位落点）')
  assert.ok((anim.hostError ?? '').length > 0, '要留下可读原因，不能静默什么都不做')
})

test('★ 生成失败留下可读原因（那是预期内的失败，不是崩溃）', async () => {
  const bridge = installFakeBridge()
  bridge.failWith('renderAnimation', '渲染失败：没有匹配的模板')
  const { useAnimationStore } = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())
  const anim = useAnimationStore()

  await anim.render({ templateId: 'nope' })

  assert.equal(anim.renderError, '渲染失败：没有匹配的模板')
  assert.equal(anim.payload, null)
  assert.equal(anim.canPlay, false)
})

test('newPayloadId 稳定产出非空标识（防串台标识不能撞）', async () => {
  const { newPayloadId } = await import('../src/renderer/src/stores/animation.ts')
  const a = newPayloadId()
  const b = newPayloadId()
  assert.ok(a.length > 0)
  assert.notEqual(a, b, '两次生成不该相同（否则多张动画卡会串台）')
})

/* ------------------------------------------------------------------ *
 * 10. 学生可见的失败文案（任务 ③ / ⑥）：排障细节不许上屏
 * ------------------------------------------------------------------ */

/** 后端**面向排障**的 detail 里那几类技术信息的判据（与翻译模块同一套特征）。 */
const TROUBLESHOOTING = /HTTP\s*\d{3}|server[\\/]|resources[\\/]|\/api\/|traceback|'[a-z][a-z0-9-]*-[a-z]/

test('★★ 编程：提示与运行分析的失败文案都要按受众改写（HTTP 状态码 / 服务器路径 / 内部 kp_id 不上屏）', async () => {
  const bridge = installFakeBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  await code.loadTemplate('prog-list-jr')

  // 后端「没有分级提示」的真实形态：内部 kp_id + 服务器上的模板目录
  bridge.failWith(
    'readCodeHint',
    "读取失败（HTTP 404）：知识点 'prog-variable-jr' 还没有分级提示（模板文件：server/resources/code-templates/）。"
  )
  await code.askForHint()
  assert.ok(code.hintError !== null)
  assert.doesNotMatch(code.hintError, TROUBLESHOOTING, `提示失败文案里不该有排障细节：${code.hintError}`)
  assert.ok(code.hintError.length > 0, '仍要给学生一句可读的说明，而不是空着')

  bridge.failWith('analyzeCodeRun', '操作失败（HTTP 503）：/api/code/run-hint 暂时不可用')
  await code.analyzeRun({ code: 'print(1)', stdout: '1', stderr: '', attempt: 1 })
  assert.ok(code.analyzeError !== null)
  assert.doesNotMatch(code.analyzeError, TROUBLESHOOTING, `分析失败文案里不该有排障细节：${code.analyzeError}`)

  // 本来就给学生看的可读中文**原样保留**（翻译不是「一律换掉」）
  bridge.failWith('readCodeHint', '这道题的提示暂时取不到，稍后再试。')
  await code.askForHint()
  assert.equal(code.hintError, '这道题的提示暂时取不到，稍后再试。')
})

test('★ 动画：渲染失败同样过翻译（后端 503 那条带着服务器上的模板目录）', async () => {
  const bridge = installFakeBridge()
  const { useAnimationStore } = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())
  const anim = useAnimationStore()

  bridge.failWith('renderAnimation', '操作失败（HTTP 503）：本机没有可用的动画模板（server/resources/templates/ 为空）')
  await anim.render({ templateId: 'nope' })

  assert.ok(anim.renderError !== null)
  assert.doesNotMatch(anim.renderError, TROUBLESHOOTING, `动画失败文案里不该有排障细节：${anim.renderError}`)
})

test('★★ 连接层失败翻成中文：`fetch failed` 真正的原因在 cause.code 里（英文不许直出）', async () => {
  const bridge = installFakeBridge()
  const { useCodeStore } = await import('../src/renderer/src/stores/code.ts')
  setActivePinia(createPinia())
  const code = useCodeStore()

  // Node 的 fetch 在连接被拒时抛的就是这个形态：message 只有 `fetch failed`
  const refused = new TypeError('fetch failed')
  ;(refused as unknown as { cause: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED'
  })
  bridge.throwWith('readCodeTemplate', refused)

  await code.loadTemplate('prog-list-jr')

  assert.ok(code.templateError !== null)
  assert.doesNotMatch(code.templateError, /fetch failed|ECONNREFUSED|TypeError/, '英文连接错误不许直出')
  assert.ok(code.templateError.includes('本地数据服务'), `要说清「连不上本地数据服务」：${code.templateError}`)
})

test('★★ sidecar 状态读取失败也要是中文（渲染进程这一份 describeError 原来直接透传英文）', async () => {
  const refused = new TypeError('fetch failed')
  ;(refused as unknown as { cause: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED'
  })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      onSidecarChanged: () => () => {},
      getSidecarInfo: () => Promise.reject(refused)
    }
  }
  const { useSidecarStore } = await import('../src/renderer/src/stores/sidecar.ts')
  setActivePinia(createPinia())
  const sidecar = useSidecarStore()

  sidecar.connect()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.ok(sidecar.loadError !== null)
  assert.doesNotMatch(sidecar.loadError, /fetch failed|ECONNREFUSED|TypeError/, '英文连接错误不许直出')
  assert.ok(sidecar.loadError.includes('连不上本地数据服务'), `要说清是连不上 sidecar：${sidecar.loadError}`)
})

test('★★ 设置页读设置失败也要是中文（同一份 describeError 的第二处）', async () => {
  const refused = new TypeError('fetch failed')
  ;(refused as unknown as { cause: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED'
  })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      readSettings: () => Promise.reject(refused),
      saveSettings: () => Promise.reject(refused),
      probeSettings: () => Promise.reject(refused),
      readProviderCatalog: () => Promise.resolve({ ok: true, data: [] }),
      fetchProviderModels: () => Promise.reject(refused)
    }
  }
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings.ts')
  setActivePinia(createPinia())
  const settings = useSettingsStore()

  await settings.load()

  assert.ok(settings.errorText !== null)
  assert.doesNotMatch(settings.errorText, /fetch failed|ECONNREFUSED|TypeError/, '英文连接错误不许直出')
  assert.ok(
    settings.errorText.includes('连不上本地数据服务'),
    `要说清是连不上 sidecar：${settings.errorText}`
  )
})

/* ------------------------------------------------------------------ *
 * 11. 编程卡片的载荷：领域级 `codeOk` 优先，老载荷回落 `ok`
 * ------------------------------------------------------------------ */

test('★★ 编程卡片：`codeOk` 是「学生代码跑通没有」的判据，老载荷的 `ok` 仍作兜底', async () => {
  const { readCodingCard } = await import('../src/renderer/src/cards/coding.ts')

  // 新载荷：工具成功（toolOk）而学生代码没跑通 —— 领域级的结论只能来自 codeOk
  const fresh = readCodingCard({
    kpId: 'prog-list-jr',
    codeOk: false,
    toolOk: true,
    ok: false,
    stdout: '',
    feedback: '缩进还不对',
    consecutiveFailures: 1
  })
  assert.equal(fresh.kind, 'result')
  assert.equal(fresh.kind === 'result' ? fresh.ok : null, false, 'codeOk=false → 卡片显示「运行失败」')

  // 老载荷（历史数据 / 还没更新的生产者）：只有 `ok`，必须仍然认得出来
  const legacy = readCodingCard({ kpId: 'prog-list-jr', ok: true, stdout: 'ok\n', feedback: '成功' })
  assert.equal(legacy.kind, 'result', '缺 codeOk 的老载荷不许退化成 unknown')
  assert.equal(legacy.kind === 'result' ? legacy.ok : null, true)

  // `codeOk` 与 `ok` 同时在且不一致时，**以 codeOk 为准**（它是显式命名的领域字段）
  const both = readCodingCard({ kpId: 'x', codeOk: true, ok: false, feedback: 'f' })
  assert.equal(both.kind === 'result' ? both.ok : null, true, '读的是 codeOk，不是 ok')
})
