/**
 * 学段**手动设定**（`grade:set` 这条链的桌面端一半）的守卫。
 *
 * 这一份盯住四件「错了就静默出事」的事：
 *
 *   G1 **路径构造**：`/api/grade/override/{studentId}` 与 `encodeURIComponent`
 *      —— `studentId` 虽然来自主进程，但不该让一个特殊字符改变 URL 结构；
 *   G2 ★★ **epoch（在途作废）**：学生手动选了学段之后，**之前已经在飞的**那次上交
 *      回来时带的是按**旧学段**算出来的结论。不作废它，学生就会看到
 *      「我明明选了初中，它又跳回小学高年级」，而且这个动作会**反复被覆盖**（改不回来）。
 *      手法与已有的 `isDiscarded()`（跨学生丢弃）同源，只是换了一个维度。
 *      ★ 这一条**必须配反向对照**（P-053）：同一个场景不调 `adoptOverride` 时，
 *      那个结论**必须**被采纳 —— 否则「断言能照出问题」这件事本身没有被证明。
 *   G3 **立即生效 + 清 pendingGrade**：手动选择是学生**现在**就要生效的动作，
 *      不能等下一轮；而 `pendingGrade`（服务端判出来、下一轮生效）必须清掉，
 *      否则下一轮 `applyPending()` 会把它顶回来；
 *   G4 **脏值收敛**：任何非法值都收敛到四学段之一（不崩、不让脏值流进 prompt 查表）。
 *
 * 跑法：`node --test tests/grade-override.test.ts`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GradeLevel } from '../src/shared/ipc-events.ts'
import {
  DEFAULT_GRADE_LEVEL,
  GRADE_LABELS,
  GRADE_PROMPTS,
  gradePromptFor
} from '../src/main/agent/prompts/grade.ts'
import {
  GRADE_OVERRIDE_HEADING,
  createGradeExtension,
  gradeOverridePath,
  type GradeProposal,
  type GradeStateSnapshot,
  type GradeTurnResponse
} from '../src/main/agent/extensions/grade.ts'

const SESSION = {
  studentId: 'student_001',
  sessionId: 'sess-1',
  gradeLevel: 'primary_high' as GradeLevel
}

/** 桌面端根目录（测试文件在 `desktop/tests/` 下）。 */
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 非法值的注入口（否则 TS 会当场拒绝 `'college'` 这种字面量断言）。 */
const dirty = (value: string): GradeLevel => value as unknown as GradeLevel

/** 一个可手动兑现的 Promise（**不用固定时长猜顺序**：显式握手，测试不会因机器慢而抖）。 */
interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface Gate {
  /** 上交**进入** submitter 时兑现（测试据此确认「它已经在飞了」）。 */
  entered: Deferred
  /** 手动放行：在那之后上交才会返回。 */
  release: Deferred
}

/** 假 Pi：本扩展**不订阅任何事件**（工厂是空实现），这里只为了让注册形态一致。 */
interface FakePi {
  handlers: Record<string, unknown[]>
  on(event: string, handler: unknown): void
  registerTool(): void
}

function createFakePi(): FakePi {
  const handlers: Record<string, unknown[]> = {}
  return {
    handlers,
    on(event, handler) {
      ;(handlers[event] ??= []).push(handler)
    },
    registerTool() {
      throw new Error('grade 扩展不注册 Tool')
    }
  }
}

interface HarnessOptions {
  /** 上交返回的学段（可中途改）。 */
  grade?: GradeLevel
  /**
   * 让上交**可控延迟**：给一个 `Gate` 就表示
   * 「进到上交里时兑现 `entered`，然后一直等 `release`」—— 用来在 await 期间插入手动设定。
   */
  gate?: Gate
  /**
   * 让**第二层 LLM 判定**可控延迟（H-2）：给一个 `Gate` 就表示
   * 「判定被调用时兑现 `entered`，然后一直等 `release`」—— 用来在**判定飞行途中**插入手动设定。
   * 不传就没有第二层通道（`no_llm`）。
   */
  judgeGate?: Gate
  /** 让 `GET /api/grade/state`（`refresh()` 的唯一出口）可控延迟（H-2 第二处）。 */
  fetchGate?: Gate
}

interface Harness {
  extension: ReturnType<typeof createGradeExtension>
  logs: string[]
  submitted: Array<{ studentId: string; turn: number; text: string; proposal?: GradeProposal }>
  setGrade(grade: GradeLevel): void
  /** 模拟「学生发了一轮」（与 `runtime.ts` 的调用入口逐字一致）。 */
  pushTurn(text: string): void
  /** 换学生（`resetForStudent` 的触发条件：`studentId` 变了）。 */
  switchStudent(studentId: string): void
}

function createHarness(options: HarnessOptions = {}): Harness {
  const pi = createFakePi()
  const logs: string[] = []
  const submitted: Harness['submitted'] = []
  let nextGrade: GradeLevel = options.grade ?? DEFAULT_GRADE_LEVEL
  let session = { ...SESSION }

  const submitter = async (
    studentId: string,
    body: { turns: Array<{ turn: number; text: string; sessionId?: string; proposal?: GradeProposal }> }
  ): Promise<GradeTurnResponse> => {
    const turn = body.turns[body.turns.length - 1]
    submitted.push({ studentId, turn: turn.turn, text: turn.text, proposal: turn.proposal })
    if (options.gate) {
      options.gate.entered.resolve()
      await options.gate.release.promise
    }
    return {
      grade: nextGrade,
      previousGrade: DEFAULT_GRADE_LEVEL,
      changed: nextGrade !== DEFAULT_GRADE_LEVEL,
      reason: 'changed',
      confidence: 0.75,
      turn: turn.turn,
      direction: -1,
      streak: 3,
      cooldownRemainingTurns: 0,
      degraded: null
    }
  }

  const extension = createGradeExtension({
    submitter,
    fetcher: async (): Promise<GradeStateSnapshot> => {
      if (options.fetchGate) {
        options.fetchGate.entered.resolve()
        await options.fetchGate.release.promise
      }
      return {
        grade: nextGrade,
        source: 'inferred',
        lastTurn: 0,
        cooldownRemainingTurns: 0,
        streak: 0,
        direction: 0,
        confidence: 0
      }
    },
    judge: options.judgeGate
      ? async () => {
          options.judgeGate!.entered.resolve()
          await options.judgeGate!.release.promise
          return { suggestedGrade: 'primary_low', confidence: 0.72 }
        }
      : null,
    sessionProvider: () => session,
    log: (line: string) => {
      logs.push(line)
    }
  })
  extension(pi as never)

  return {
    extension,
    logs,
    submitted,
    setGrade: (grade: GradeLevel) => {
      nextGrade = grade
    },
    pushTurn: (text: string) => {
      extension.observeTurn(text)
    },
    switchStudent: (studentId: string) => {
      session = { ...session, studentId, sessionId: `${studentId}-sess` }
    }
  }
}

/* ------------------------------------------------------------------ *
 * G1 路径构造（唯一出口的形状）
 * ------------------------------------------------------------------ */

test('G1a 手动设定的路径按 studentId 构造，且特殊字符被 encodeURIComponent', () => {
  assert.equal(gradeOverridePath('student_001'), '/api/grade/override/student_001')
  assert.equal(
    gradeOverridePath('a/b c?d#e'),
    `/api/grade/override/${encodeURIComponent('a/b c?d#e')}`,
    '特殊字符必须被编码 —— 它不该改变 URL 的结构'
  )
  // 编码后不得残留能改变路径结构的字符
  const encoded = gradeOverridePath('a/b?c#d')
  assert.equal(encoded.includes('/override/a%2Fb'), true, `分隔符没有被编码：${encoded}`)
})

test('G1b 上交的 body 是 camelCase 的 { gradeLevel }（与后端 CamelModel alias 对齐）', () => {
  // ★ 静态断言而不是发真请求：`postGradeOverride` 走 `apiFetch`（进程内唯一出口），
  //   单测里没有 sidecar。只钉住「发出去的形状」这一件最容易漂移的事。
  const source = readFileSync(
    join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'grade.ts'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, ' ')

  assert.ok(
    source.includes('JSON.stringify({ gradeLevel })'),
    'body 必须是 camelCase 的 { gradeLevel }：后端是 snake_case 入参 + CamelModel alias，' +
      '发错形状会被服务端当成缺字段'
  )
  assert.ok(
    source.includes('encodeURIComponent(studentId)'),
    'studentId 必须 encodeURIComponent'
  )
})

/* ------------------------------------------------------------------ *
 * G2 立即生效
 * ------------------------------------------------------------------ */

test('G2a adoptOverride 立即生效：appliedGrade 与 prompt 当场就是新学段', () => {
  const harness = createHarness()
  assert.equal(harness.extension.appliedGrade(), DEFAULT_GRADE_LEVEL)

  harness.extension.adoptOverride('junior', 10)

  assert.equal(harness.extension.appliedGrade(), 'junior', '手动选择必须**立即**生效（不等下一轮）')
  assert.equal(harness.extension.snapshot().cooldownRemainingTurns, 10, '冷却轮数要能被界面读到')

  const prompt = harness.extension.systemPromptFor(GRADE_PROMPTS.primary_high)
  assert.ok(prompt.includes(GRADE_PROMPTS.junior), 'prompt 里必须是初中模板（旧模板被换掉）')
  assert.ok(!prompt.includes(GRADE_PROMPTS.primary_high), '旧学段模板不该留在链上')
  assert.ok(prompt.includes(GRADE_OVERRIDE_HEADING), '★ 权威段始终在（wire prompt 可审计）')
  assert.ok(
    prompt.includes(GRADE_LABELS.junior),
    `权威段要写清新学段（${GRADE_LABELS.junior}），否则「按哪个学段作答」不可读`
  )
  assert.ok(harness.logs.some((line) => line.includes('学生手动设定学段')), '手动设定要留一行可读日志')
})

/* ------------------------------------------------------------------ *
 * G3 epoch：在途结论不得覆盖学生刚做的选择（含 P-053 反向对照）
 * ------------------------------------------------------------------ */

test('G3a ★★ 在途上交的结论不得覆盖学生刚做的手动选择（epoch 作废）', async () => {
  const gate = { entered: deferred(), release: deferred() }
  const harness = createHarness({ gate })
  // 服务端这条在途结论算出来的是 primary_low（按**旧学段**算的）
  harness.setGrade('primary_low')

  harness.pushTurn('梯度下降是什么？')
  await gate.entered.promise // 上交已经在飞（正 await 服务端）

  // ★ 学生**在这期间**手动选了高中
  harness.extension.adoptOverride('senior', 10)
  assert.equal(harness.extension.appliedGrade(), 'senior')

  gate.release.resolve() // 那条在途结论现在才回来
  await harness.extension.flush()

  assert.equal(
    harness.extension.appliedGrade(),
    'senior',
    '★ 学生刚选的学段必须还在（在途结论不许把它顶掉）'
  )
  assert.equal(
    harness.extension.snapshot().pendingGrade,
    null,
    '★ 在途结论必须被整条作废：连 pendingGrade 都不许被 primary_low 占住'
  )
  assert.ok(
    harness.logs.some((line) => line.includes('作废')),
    '作废必须留一行可见日志（静默丢弃会让人以为「学段不响应」）'
  )
})

test('G3b ★ P-053 反向对照：不调 adoptOverride 时那条结论**必须**被采纳', async () => {
  // 与 G3a 完全同一场景，唯一的差别是**不**调 adoptOverride。
  // 这一条红了就说明 G3a 的断言照不出问题（比如 epoch 比对根本没写、或写反了）。
  const gate = { entered: deferred(), release: deferred() }
  const harness = createHarness({ gate })
  harness.setGrade('primary_low')

  harness.pushTurn('梯度下降是什么？')
  await gate.entered.promise
  gate.release.resolve()
  await harness.extension.flush()

  assert.equal(
    harness.extension.snapshot().pendingGrade,
    'primary_low',
    '没有手动选择时，服务端判出的学段必须照常进入「下一轮生效」'
  )
  assert.equal(harness.extension.snapshot().submitted, 1, '这条结论是被采纳的（计入 submitted）')

  // 下一轮才交接（与 G4d 的口径一致）
  harness.pushTurn('再问一句')
  await harness.extension.flush()
  assert.equal(harness.extension.appliedGrade(), 'primary_low', '下一轮生效')
})

test('G3c 被作废的那条结论不计入 submitted（计数只说「结论真的进了决策链路」）', async () => {
  const gate = { entered: deferred(), release: deferred() }
  const harness = createHarness({ gate })
  harness.setGrade('primary_low')

  harness.pushTurn('第一轮')
  await gate.entered.promise
  harness.extension.adoptOverride('senior', 10)
  gate.release.resolve()
  await harness.extension.flush()

  assert.equal(
    harness.extension.snapshot().submitted,
    0,
    '被 epoch 作废的结论没有进决策链路：submitted 不该 +1（否则「上交成功数」与「学段真的动过几次」对不上）'
  )
  assert.equal(harness.extension.snapshot().failed, 0, '它不是失败（HTTP 是成功的），只是被主动丢弃')
})

/* ------------------------------------------------------------------ *
 * G6 在途的第二层判定 / 刷新（H-2）
 * ------------------------------------------------------------------ */

test('G6a ★★ LLM 判定在飞期间的手动设定必须作废这条在途结论（epoch 快照提到 runJudge 之前）', async () => {
  // ★ H-2：`submitTurn` 的 epoch 快照原先拍在 `submitter` 的 await 之前、
  //   `runJudge()` 的 await **之后** —— 于是「判定飞行途中点学段」这个窗口完全没被覆盖。
  //   判定返回后 `pendingGrade` 照常落地，下一轮 `applyPending()` 把学生刚选的学段顶回去。
  const judgeGate = { entered: deferred(), release: deferred() }
  const harness = createHarness({ judgeGate })

  // 第 1、2 轮先走完（没到第二层的触发轮次，也就没有在飞窗口）
  harness.pushTurn('第一轮')
  harness.pushTurn('第二轮')
  await harness.extension.flush()
  assert.equal(harness.submitted.length, 2, '前两轮不走第二层，正常上交')
  assert.equal(harness.extension.snapshot().pendingGrade, null, '前两轮服务端说的就是当前学段')

  // ★ 第 3 轮：第二层判定在飞（`LAYER2_FIRST_TURN` / `LAYER2_MIN_TURNS` 都是 3）
  harness.setGrade('primary_low') // 这条在途结论算出来的是 primary_low（按**旧学段**算的）
  harness.pushTurn('梯度下降是什么？')
  await judgeGate.entered.promise // 判定已经在飞（正 await 那道 LLM 调用）

  // ★ 学生**在判定飞行途中**手动选了高中
  harness.extension.adoptOverride('senior', 10)
  assert.equal(harness.extension.appliedGrade(), 'senior')

  judgeGate.release.resolve() // 判定现在才回来
  await harness.extension.flush()

  assert.equal(
    harness.extension.appliedGrade(),
    'senior',
    '★ 学生刚选的学段必须还在（判定回来的结论不许把它顶掉）'
  )
  assert.equal(
    harness.extension.snapshot().pendingGrade,
    null,
    '★ 在途结论必须被整条作废：连 pendingGrade 都不许被 primary_low 占住'
  )
  assert.equal(
    harness.submitted.length,
    2,
    '连提议都不许带上交（按旧学段算出来的提议对服务端也是过期的原料）'
  )
  assert.ok(
    harness.logs.some((line) => line.includes('第二层判定期间') && line.includes('作废')),
    '作废必须留一行可见日志（静默丢弃会让人以为「学段不响应」）'
  )

  // 下一轮：那个旧结论一个字都不许再冒出来
  harness.pushTurn('再问一句')
  await harness.extension.flush()
  assert.equal(harness.extension.appliedGrade(), 'senior', '下一轮的交接不得覆盖手动选择')
})

test('G6b ★ P-053 反向对照：判定在飞期间**不**手动设定时，那条结论必须被采纳', async () => {
  // 与 G6a 完全同一场景，唯一的差别是**不**调 adoptOverride。
  // 这一条红了就说明 G6a 的断言照不出问题（比如 epoch 比对写反了、或干脆把判定结果丢了）。
  const judgeGate = { entered: deferred(), release: deferred() }
  const harness = createHarness({ judgeGate })

  harness.pushTurn('第一轮')
  harness.pushTurn('第二轮')
  await harness.extension.flush()

  harness.setGrade('primary_low') // 第 3 轮判出来的新学段
  harness.pushTurn('梯度下降是什么？')
  await judgeGate.entered.promise
  judgeGate.release.resolve()
  await harness.extension.flush()

  assert.equal(harness.submitted.length, 3, '没有手动选择时第三轮照常上交')
  assert.equal(
    harness.submitted[2].proposal?.suggestedGrade,
    'primary_low',
    '第二层的提议必须跟着这一轮一起交上去'
  )
  assert.equal(
    harness.extension.snapshot().pendingGrade,
    'primary_low',
    '没有手动选择时，服务端判出的学段必须照常进入「下一轮生效」'
  )
})

test('G6c ★ refresh 的回执在途中被手动设定作废（fire-and-forget 的 GET 不许覆盖新选择）', async () => {
  // ★ H-2 第二处：`refresh()` 由 `runtime.ts` **不 await** 地调用，sidecar 慢时（上限 8s）
  //   它的回执带的是**旧的**学段值；无检查地写 `appliedGrade` 就把学生刚选的顶回旧值。
  const fetchGate = { entered: deferred(), release: deferred() }
  const harness = createHarness({ fetchGate, grade: 'primary_low' })

  const pending = harness.extension.refresh()
  await fetchGate.entered.promise // GET 已经在飞

  harness.extension.adoptOverride('senior', 10) // 学生此刻点了高中
  assert.equal(harness.extension.appliedGrade(), 'senior')

  fetchGate.release.resolve() // 旧值的回执现在才回来
  const result = await pending

  assert.equal(result, null, '被作废的刷新没有可信结果可回（返回 null 而不是旧值）')
  assert.equal(
    harness.extension.appliedGrade(),
    'senior',
    '★ refresh 的回执不许把学生刚选的学段顶回旧值'
  )
  assert.ok(
    harness.logs.some((line) => line.includes('取当前学段的回执') && line.includes('作废')),
    '作废要留一行可见日志'
  )
})

/* ------------------------------------------------------------------ *
 * G4 清 pendingGrade / 脏值收敛 / 换学生
 * ------------------------------------------------------------------ */

test('G4a ★ adoptOverride 清掉 pendingGrade（否则下一轮 applyPending 会把它顶回来）', async () => {
  const harness = createHarness({ grade: 'junior' })
  harness.pushTurn('第一轮')
  await harness.extension.flush()
  assert.equal(harness.extension.snapshot().pendingGrade, 'junior', '服务端判出的学段已就绪')

  harness.extension.adoptOverride('senior', 10)
  assert.equal(harness.extension.snapshot().pendingGrade, null, '★ 手动选择后必须清空 pendingGrade')

  // 下一轮：不允许那个「下一轮生效」的旧值把学生刚选的顶掉
  harness.pushTurn('第二轮')
  await harness.extension.flush()
  assert.equal(
    harness.extension.appliedGrade(),
    'senior',
    '下一轮的交接不得把学生手动选的学段覆盖掉'
  )
})

test('G4b 脏值收敛：非法学段一律落到合法学段（不崩、不把脏值塞进 prompt）', () => {
  const harness = createHarness()
  for (const value of ['college', '', '初中', 'PRIMARY_LOW', 'senior ']) {
    harness.extension.adoptOverride(dirty(value), 5)
    const applied = harness.extension.appliedGrade()
    assert.ok(
      (['primary_low', 'primary_high', 'junior', 'senior'] as readonly string[]).includes(applied),
      `${value} → ${applied} 不是合法学段`
    )
    const prompt = harness.extension.systemPromptFor(undefined)
    assert.ok(prompt.includes(gradePromptFor(applied)), 'prompt 里必须是合法学段的模板')
    assert.ok(!prompt.includes('college'), '脏值不得出现在 prompt 里')
  }
  // 合法值原样采纳（收敛不是「一律回落默认值」）
  harness.extension.adoptOverride('primary_low', 2)
  assert.equal(harness.extension.appliedGrade(), 'primary_low')
  // 冷却轮数也收敛（NaN / 负数不得进状态）
  harness.extension.adoptOverride('junior', Number.NaN)
  assert.equal(harness.extension.snapshot().cooldownRemainingTurns, 0)
  harness.extension.adoptOverride('junior', -3)
  assert.equal(harness.extension.snapshot().cooldownRemainingTurns, 0)
})

test('G4c 换学生之后 adoptOverride 照常工作，且学生的冷却不串台', async () => {
  const harness = createHarness({ grade: 'senior' })
  // ★ 先让扩展**认识**这个学生（`trackBoundary` 只在第一次 `observeTurn` 时记下身份），
  //   否则「换学生」这条路径根本不会被触发 —— 测的就不是我们要测的东西了。
  harness.pushTurn('第一轮')
  await harness.extension.flush()

  harness.extension.adoptOverride('junior', 10)
  assert.equal(harness.extension.appliedGrade(), 'junior')

  // 换学生：学段与冷却都回到冷启动默认值（绝不把上一个学生的状态带过去）
  harness.switchStudent('student_002')
  harness.pushTurn('你好')
  await harness.extension.flush()
  assert.equal(harness.extension.appliedGrade(), DEFAULT_GRADE_LEVEL, '换学生后回到冷启动默认值')
  assert.equal(
    harness.extension.snapshot().cooldownRemainingTurns,
    0,
    '冷却与学生绑定：换学生必须归零，否则新学生的界面会显示别人的冷却'
  )

  // 新学生照样能手动设定
  harness.extension.adoptOverride('senior', 4)
  assert.equal(harness.extension.appliedGrade(), 'senior')
  assert.equal(harness.extension.snapshot().cooldownRemainingTurns, 4)
  assert.equal(
    harness.extension.snapshot().pendingGrade,
    null,
    '手动设定之后 pendingGrade 仍是空的（换学生带来的队列丢弃不影响这条）'
  )
})

test('G4d reset() 之后 adoptOverride 仍可用（手动设定的状态不依赖推断窗口）', () => {
  const harness = createHarness()
  harness.pushTurn('一')
  harness.extension.reset()
  assert.equal(harness.extension.appliedGrade(), DEFAULT_GRADE_LEVEL)

  harness.extension.adoptOverride('junior', 10)
  assert.equal(harness.extension.appliedGrade(), 'junior')
  assert.equal(harness.extension.snapshot().cooldownRemainingTurns, 10)
})

/* ------------------------------------------------------------------ *
 * G5 跨进程边界：来源以服务端为准 + 三态 origin + 通道是 invoke
 *
 * 这一段读源码做静态断言（`handlers.ts` / `preload/index.ts` 都 import electron，
 * 在 `node --test` 里加载不了）。检查点都是**这一波新增的那几行**：
 * 把它们改回旧形态，下面的断言就会红。
 * ------------------------------------------------------------------ */

/** 去注释后按「函数头 → 顶格右花括号」截出一段（本仓库的函数都按这个风格排版）。 */
function functionBody(file: string, header: string): string {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
  const matched = new RegExp(`${header}[\\s\\S]*?\\n\\}`).exec(source)
  assert.ok(matched, `${file} 里找不到 ${header}（这一波改动被整体删掉了？）`)
  return matched[0]
}

test('G5a ★ 学段来源以服务端 source 为准：explicit 必须映射成 explicit（否则学生的手动选择被显示成 AI 推的）', () => {
  const body = functionBody(join(desktopRoot, 'src', 'main', 'ipc', 'handlers.ts'), 'async function readGradeState')
  assert.ok(
    /source\s*===\s*'explicit'\s*\?\s*'explicit'/.test(body),
    'readGradeState 必须把 source === "explicit" 映射成 origin: "explicit" —— ' +
      '否则学生刚选的学段会被标成「系统判的」，唯一的人工入口在界面上隐身'
  )
  assert.ok(
    /lastTurn > 0 \? 'inferred' : 'default'/.test(body),
    '其余情况仍按 lastTurn 区分 inferred / default（冷启动不许冒充推断结果）'
  )
})

test('G5b preload 的边界校验认三态 origin（漏掉 explicit 会让刚点完的推送被整条丢掉）', () => {
  const body = functionBody(join(desktopRoot, 'src', 'preload', 'index.ts'), 'function isGradeState')
  for (const origin of ['inferred', 'explicit', 'default']) {
    assert.ok(body.includes(`'${origin}'`), `isGradeState 必须认 origin === '${origin}'`)
  }
})

test('G5c grade:set 是 invoke（有回执），不得登记进 PUSH_CHANNELS', () => {
  const channels = readFileSync(join(desktopRoot, 'src', 'main', 'ipc', 'channels.ts'), 'utf8')
  assert.ok(
    /gradeSet:\s*'grade:set'/.test(channels),
    '通道名必须来自唯一来源 channels.ts 的 IPC.gradeSet'
  )
  const pushBlock = /export\s+const\s+PUSH_CHANNELS[^=]*=\s*\[([\s\S]*?)\]/.exec(channels)?.[1]
  assert.ok(pushBlock, 'channels.ts 里找不到 PUSH_CHANNELS')
  assert.ok(
    !pushBlock.includes('IPC.gradeSet'),
    'grade:set 是 invoke（学生要看到「改没改成、冷却还剩几轮」），不是单向推送通道'
  )
})
