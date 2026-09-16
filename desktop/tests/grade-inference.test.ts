/**
 * 票 21 守卫：**桌面端**这一半的学段推断（`extensions/grade.ts`）。
 *
 * 这一份测试盯住四件「错了就静默出事」的事：
 *
 *   G1  ★ **跨语言常量一致**：`LAYER2_FIRST_TURN` / `LAYER2_RETRY_TURN` / `MAX_TURN_CHARS`
 *       必须与 `server/app/grade/rules.py`、`server/app/routes/grade.py` 里的同名常量逐字一致
 *       —— 两边各改一半的后果是「第 3 轮该触发却永远不触发」，且**没有任何报错**
 *   G2  **第二层的触发与降级**：第 3 轮（不足则第 5 轮）触发一次；**没有 LLM 通道时
 *       `no_llm` 要可见**（日志 + 状态），而不是静默跳过
 *   G3  **`before_agent_start` 的链式保真**：别的扩展拼好的 prompt 只做学段片段替换，
 *       其余内容一个字节都不许丢；拿不到别的扩展的 prompt 时也**绝不能**返回 `undefined`
 *       （那等于放弃覆盖，Pi 的默认 prompt 会把宿主安装路径发出去）
 *   G4  **下一轮生效**：第 N 轮判定出的学段在第 N+1 轮的 prompt 里才生效（学生无感）
 *
 * 跑法：`npm test`
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GradeLevel } from '../src/shared/ipc-events.ts'
import {
  DEFAULT_GRADE_LEVEL,
  GRADE_PROMPTS,
  gradePromptFor
} from '../src/main/agent/prompts/grade.ts'
import {
  GRADE_OVERRIDE_HEADING,
  LAYER2_FIRST_TURN,
  LAYER2_MIN_TURNS,
  LAYER2_RETRY_TURN,
  MAX_TURN_CHARS,
  buildJudgePrompt,
  clampTurnText,
  countUsableTurns,
  createGradeExtension,
  isStudentTurn,
  mergeGradePrompt,
  parseProposal,
  readInputText,
  shouldRequestLayer2,
  swapKnownGradeTemplate,
  type GradeProposal,
  type GradeTurnResponse,
  type GradeStateSnapshot
} from '../src/main/agent/extensions/grade.ts'
import { AGENT_EXTENSION_SPECS } from '../src/main/agent/extensions/index.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..')
const serverGradeDir = join(repoRoot, 'server', 'app', 'grade')
const gradeExtensionFile = join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'grade.ts')
const gradeExtensionSource = readFileSync(gradeExtensionFile, 'utf8')
const rulesSource = readFileSync(join(serverGradeDir, 'rules.py'), 'utf8')
const routeSource = readFileSync(join(repoRoot, 'server', 'app', 'routes', 'grade.py'), 'utf8')
const signalsSource = readFileSync(join(serverGradeDir, 'signals.py'), 'utf8')

/** 从 Python 源码里读一个数值常量（`NAME = 0.6`）。 */
function pyNumber(source: string, name: string): number {
  const matched = new RegExp(`^${name}\\s*=\\s*([0-9.]+)`, 'm').exec(source)
  assert.ok(matched, `server 侧找不到常量 ${name}（两边必须共用同一组阈值）`)
  return Number(matched[1])
}

/* ------------------------------------------------------------------ *
 * G1 跨语言常量一致
 * ------------------------------------------------------------------ */

test('G1a 第二层触发轮次与阈值和 server 侧逐字一致', () => {
  assert.equal(LAYER2_FIRST_TURN, pyNumber(rulesSource, 'LAYER2_FIRST_TURN'), 'LAYER2_FIRST_TURN 漂移了')
  assert.equal(LAYER2_RETRY_TURN, pyNumber(rulesSource, 'LAYER2_RETRY_TURN'), 'LAYER2_RETRY_TURN 漂移了')
  assert.equal(LAYER2_FIRST_TURN, 3, '「第 3 轮触发」是执行文档 §10.3 的冻结口径')
  assert.equal(LAYER2_RETRY_TURN, 5, '「不足则第 5 轮」是执行文档 §10.3 的冻结口径')

  // 决策阈值只允许在 rules.py 里定义一次 —— 桌面端不许自己算阈值
  assert.equal(pyNumber(rulesSource, 'CONFIDENCE_THRESHOLD'), 0.6)
  assert.equal(pyNumber(rulesSource, 'SIGNALS_REQUIRED_FOR_CHANGE'), 3)
  assert.equal(pyNumber(rulesSource, 'COOLDOWN_TURNS'), 5)
  assert.equal(pyNumber(rulesSource, 'MAX_STEP_LEVELS'), 1)
})

test('G1b 单轮文本上限与 server 侧一致，且远大于入库证据摘要的上限', () => {
  assert.equal(MAX_TURN_CHARS, pyNumber(routeSource, 'MAX_TURN_CHARS'), '两边的单轮上限必须一致')
  const rawCap = pyNumber(signalsSource, 'RAW_MAX_CHARS')
  assert.ok(
    rawCap > 0 && rawCap <= MAX_TURN_CHARS / 4,
    `入库的 raw 必须是一条摘要（${rawCap} 字符），不能是整段正文（上限 ${MAX_TURN_CHARS}）`
  )
})

test('G1c 本扩展不 import Pi，也不自己发 HTTP', () => {
  assert.ok(
    !gradeExtensionSource.includes('@earendil-works/pi-coding-agent'),
    '静态 import Pi 会拖入 esbuild 原生依赖（风险 #15）：类型走 index.ts 的结构子集'
  )
  assert.ok(!/\bfetch\s*\(/.test(gradeExtensionSource), '唯一出口是 bridge/client.ts 的 apiFetch')
  assert.ok(gradeExtensionSource.includes('bridge/client.ts'), '必须经 apiFetch 呼 sidecar')
})

test('G1d 清单里的 grade 扩展文件真实存在，且本扩展只用清单声明过的事件', () => {
  const spec = AGENT_EXTENSION_SPECS.find((entry) => entry.name === 'grade')
  assert.ok(spec, 'extensions/index.ts 里少了 grade 这一项')
  assert.equal(spec!.file, './grade.ts')
  assert.ok(existsSync(join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'grade.ts')), 'grade.ts 没落地')

  const subscribed = [...gradeExtensionSource.matchAll(/pi\.on\(\s*'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual([...subscribed].sort(), ['before_agent_start', 'input'], '只订阅这两个（tool_call 安全阀归票 22）')
  for (const event of subscribed) {
    assert.ok(spec!.events.includes(event), `订阅了清单里没声明的事件：${event}`)
  }
})

/* ------------------------------------------------------------------ *
 * G2 第二层的触发与降级
 * ------------------------------------------------------------------ */

test('G2a 第二层在第 3 轮触发；未到轮次不触发', () => {
  assert.deepEqual(
    shouldRequestLayer2({ turn: 1, usableTurns: 1, windowHasProposal: false, judgeAvailable: true }),
    { run: false, status: 'not_due' }
  )
  assert.deepEqual(
    shouldRequestLayer2({ turn: 2, usableTurns: 2, windowHasProposal: false, judgeAvailable: true }),
    { run: false, status: 'not_due' }
  )
  assert.deepEqual(
    shouldRequestLayer2({ turn: 3, usableTurns: 3, windowHasProposal: false, judgeAvailable: true }),
    { run: true, status: 'due' }
  )
})

test('G2b 证据不足等到第 5 轮再试（执行文档 §10.3）', () => {
  const thin = { usableTurns: 1, windowHasProposal: false, judgeAvailable: true }
  assert.deepEqual(shouldRequestLayer2({ turn: 3, ...thin }), {
    run: false,
    status: 'insufficient_evidence'
  })
  assert.deepEqual(shouldRequestLayer2({ turn: 4, ...thin }), {
    run: false,
    status: 'insufficient_evidence'
  })
  assert.deepEqual(shouldRequestLayer2({ turn: 5, ...thin }), { run: true, status: 'retry' })
  assert.equal(LAYER2_MIN_TURNS, 3, '至少 3 轮可用证据才算「够料」')
})

test('G2c 一个窗口只判定一次，且没有通道时显式 no_llm', () => {
  assert.deepEqual(
    shouldRequestLayer2({ turn: 6, usableTurns: 6, windowHasProposal: true, judgeAvailable: true }),
    { run: false, status: 'already_proposed' }
  )
  assert.deepEqual(
    shouldRequestLayer2({ turn: 9, usableTurns: 9, windowHasProposal: false, judgeAvailable: false }),
    { run: false, status: 'no_llm' },
    '没有 API Key / 没接线时要看得见，不能静默跳过'
  )
})

test('G2d 判定 Prompt 只带学生提问与学段，不带宿主路径或内部实现', () => {
  const prompt = buildJudgePrompt(
    [
      { turn: 1, text: '电脑怎么认图片呀？' },
      { turn: 2, text: '它会不会把小猫认成小狗？' }
    ],
    'primary_high'
  )
  assert.ok(prompt.includes('电脑怎么认图片呀？'), '要带最近几轮的提问')
  for (const grade of ['primary_low', 'primary_high', 'junior', 'senior']) {
    assert.ok(prompt.includes(grade), `判定 Prompt 必须列出取值 ${grade}`)
  }
  assert.ok(!/[A-Za-z]:\\/.test(prompt), '判定 Prompt 里不得出现宿主路径')
  assert.ok(!prompt.includes('rag_search'), '不得泄漏工具名')
  assert.ok(!prompt.includes('systemPrompt'), '不得提内部字段名')
})

test('G2e 提议解析：宽松读、严格校验', () => {
  const ok = parseProposal('{"suggestedGrade": "junior", "confidence": 0.72, "note": "术语"}')
  assert.deepEqual(ok, { suggestedGrade: 'junior', confidence: 0.72, note: '术语' })

  const fenced = parseProposal('```json\n{"suggestedGrade":"primary_low","confidence":0.8}\n```')
  assert.equal(fenced?.suggestedGrade, 'primary_low')

  const chatty = parseProposal('我判断是小学高年级：{"suggestedGrade":"primary_high","confidence":"0.65"}')
  assert.equal(chatty?.confidence, 0.65, '字符串数字也认（模型很常这么写）')

  assert.equal(parseProposal('{"suggestedGrade":"college","confidence":0.9}'), null, '非法学段必须丢掉')
  assert.equal(parseProposal('{"suggestedGrade":"junior"}'), null, '没有 confidence 丢掉')
  assert.equal(parseProposal('{"suggestedGrade":"junior","confidence":"很高"}'), null)
  assert.equal(parseProposal('模型今天不想回答'), null)
  assert.equal(parseProposal(''), null)

  const clamped = parseProposal('{"suggestedGrade":"senior","confidence":3}')
  assert.equal(clamped?.confidence, 1, '越界置信度夹到 [0,1]')
})

/* ------------------------------------------------------------------ *
 * G3 链式保真
 * ------------------------------------------------------------------ */

test('G3a 拿不到别的扩展的 prompt → 返回推断学段的模板（绝不返回 undefined）', () => {
  assert.equal(mergeGradePrompt({ incoming: undefined, inferredGrade: 'junior' }), gradePromptFor('junior'))
  assert.equal(mergeGradePrompt({ incoming: '', inferredGrade: 'primary_low' }), gradePromptFor('primary_low'))
})

test('G3b 已经是目标模板 → 不动链条（返回 undefined）', () => {
  assert.equal(
    mergeGradePrompt({ incoming: gradePromptFor('senior'), inferredGrade: 'senior' }),
    undefined
  )
})

test('G3c 只替换学段模板片段，别的扩展追加的内容一个字节都不丢', () => {
  const incoming = `【别的扩展加的头】\n${GRADE_PROMPTS.primary_high}\n【别的扩展加的尾】`
  const merged = mergeGradePrompt({ incoming, inferredGrade: 'junior' })
  assert.ok(merged, '学段变了就必须返回新的 prompt')
  assert.ok(merged!.startsWith('【别的扩展加的头】'))
  assert.ok(merged!.endsWith('【别的扩展加的尾】'))
  assert.ok(merged!.includes(GRADE_PROMPTS.junior), '应当换成推断学段的模板')
  assert.ok(!merged!.includes(GRADE_PROMPTS.primary_high), '旧学段模板应当被换掉')
})

test('G3d 认不出的自定义 prompt → 原样保留 + 追加权威覆盖块', () => {
  const incoming = '某个扩展自己拼的 system prompt，不是四份模板里的任何一份。'
  const merged = mergeGradePrompt({ incoming, inferredGrade: 'senior' })
  assert.ok(merged!.startsWith(incoming), '别人的内容原样保留')
  assert.ok(merged!.includes(GRADE_OVERRIDE_HEADING))
  assert.ok(merged!.includes(GRADE_PROMPTS.senior), '覆盖块里必须给出权威学段模板')
  assert.equal(swapKnownGradeTemplate(incoming, GRADE_PROMPTS.senior), null)
})

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

test('G3e 输入解析：只认 text，扩展注入的不算学生的一轮', () => {
  assert.equal(readInputText({ type: 'input', text: '你好', source: 'interactive' }), '你好')
  assert.equal(readInputText({ type: 'input', prompt: '不算' }), '')
  assert.equal(readInputText(null), '')
  assert.equal(isStudentTurn({ source: 'interactive' }), true)
  assert.equal(isStudentTurn({ source: 'rpc' }), true)
  assert.equal(isStudentTurn({ source: 'extension' }), false, '别的扩展注入的内容自我循环，不能算学段证据')
  assert.equal(isStudentTurn({}), true)
})

test('G3f 文本截断与可用轮数', () => {
  assert.equal(clampTurnText('  你好  '), '你好')
  assert.equal(clampTurnText('x'.repeat(MAX_TURN_CHARS + 50)).length, MAX_TURN_CHARS)
  assert.equal(countUsableTurns([{ text: 'a' }, { text: '  ' }, { text: 'b' }]), 2)
})

/* ------------------------------------------------------------------ *
 * G4 扩展行为（假 pi + 注入的出口）
 * ------------------------------------------------------------------ */

interface FakePi {
  handlers: Record<string, Array<(event: unknown, ctx?: unknown) => unknown>>
  on(event: string, handler: (event: unknown, ctx?: unknown) => unknown): void
  registerTool(): void
  emit(event: string, payload: unknown): unknown
}

function createFakePi(): FakePi {
  const handlers: FakePi['handlers'] = {}
  return {
    handlers,
    on(event, handler) {
      ;(handlers[event] ??= []).push(handler)
    },
    registerTool() {
      throw new Error('grade 扩展不注册 Tool（清单里 tools 为空）')
    },
    emit(event, payload) {
      const list = handlers[event] ?? []
      let result: unknown
      for (const handler of list) result = handler(payload) ?? result
      return result
    }
  }
}

const SESSION = { studentId: 'student_001', sessionId: 'sess-1', gradeLevel: 'primary_high' as GradeLevel }

interface Harness {
  pi: FakePi
  extension: ReturnType<typeof createGradeExtension>
  submitted: Array<{
    studentId: string
    turns: Array<{ turn: number; text: string; sessionId?: string; proposal?: GradeProposal }>
  }>
  logs: string[]
  /** 第二层判定被真正调用的次数（= 一次对话里的 LLM 调用计数）。 */
  judgeCalls(): number
  setGrade(grade: GradeLevel): void
  pushTurn(text: string, source?: string): void
}

function createHarness(options: { judge?: boolean; grade?: GradeLevel } = {}): Harness {
  const pi = createFakePi()
  const submitted: Harness['submitted'] = []
  const logs: string[] = []
  let nextGrade: GradeLevel = options.grade ?? DEFAULT_GRADE_LEVEL
  let judgeCallCount = 0

  const submitter = async (
    studentId: string,
    body: {
      turns: Array<{ turn: number; text: string; sessionId?: string; proposal?: GradeProposal }>
    }
  ): Promise<GradeTurnResponse> => {
    submitted.push({ studentId, turns: body.turns })
    return {
      grade: nextGrade,
      previousGrade: DEFAULT_GRADE_LEVEL,
      changed: nextGrade !== DEFAULT_GRADE_LEVEL,
      reason: 'changed',
      confidence: 0.75,
      turn: body.turns[body.turns.length - 1].turn,
      direction: -1,
      streak: 3,
      cooldownRemainingTurns: 0,
      degraded: body.turns[body.turns.length - 1].proposal ? null : 'no_llm'
    }
  }

  const extension = createGradeExtension({
    submitter,
    fetcher: async (): Promise<GradeStateSnapshot> => ({
      grade: nextGrade,
      source: 'inferred',
      lastTurn: 0,
      cooldownRemainingTurns: 0,
      streak: 0,
      direction: 0,
      confidence: 0
    }),
    judge: options.judge
      ? async () => {
          judgeCallCount += 1
          return { suggestedGrade: 'primary_low', confidence: 0.72 }
        }
      : null,
    sessionProvider: () => SESSION,
    log: (line: string) => {
      logs.push(line)
    }
  })
  extension(pi as never)

  return {
    pi,
    extension,
    submitted,
    logs,
    judgeCalls: () => judgeCallCount,
    setGrade: (grade: GradeLevel) => {
      nextGrade = grade
    },
    pushTurn: (text: string, source = 'interactive') => {
      pi.emit('input', { type: 'input', text, source })
    }
  }
}

test('G4a input 上交本轮证据，且不含任何服务端算好的信号', async () => {
  const harness = createHarness()
  harness.pushTurn('电脑怎么认图片呀？')
  await harness.extension.flush()

  assert.equal(harness.submitted.length, 1)
  const body = harness.submitted[0].turns[0]
  assert.deepEqual(Object.keys(body).sort(), ['sessionId', 'text', 'turn'])
  assert.equal(body.turn, 1)
  assert.equal(body.text, '电脑怎么认图片呀？')
  assert.equal(body.sessionId, 'sess-1')
  assert.equal(harness.submitted[0].studentId, 'student_001')
})

test('G4b 第 3 轮带上第二层提议；没有通道时不带提议而且降级可见', async () => {
  const withJudge = createHarness({ judge: true })
  for (const text of ['一', '二', '三']) withJudge.pushTurn(text)
  await withJudge.extension.flush()
  assert.equal(withJudge.submitted.at(-1)!.turns[0].proposal?.suggestedGrade, 'primary_low')
  assert.equal(withJudge.extension.snapshot().layer2, 'used')

  const withoutJudge = createHarness({ judge: false })
  for (const text of ['一', '二', '三']) withoutJudge.pushTurn(text)
  await withoutJudge.extension.flush()
  assert.equal(withoutJudge.submitted.at(-1)!.turns[0].proposal, undefined, '没有通道就只交第一层证据')
  assert.equal(withoutJudge.extension.snapshot().layer2, 'no_llm')
  assert.ok(
    withoutJudge.logs.some((line) => line.includes('未接线') && line.includes('degraded="no_llm"')),
    '降级必须留下可见的一行日志'
  )
})

test('G4c 换会话不再触发第二层的重复判定', async () => {
  const harness = createHarness({ judge: true })
  for (let index = 0; index < 5; index += 1) harness.pushTurn(`第 ${index} 轮`)
  await harness.extension.flush()
  const proposals = harness.submitted.filter((entry) => entry.turns[0].proposal)
  assert.equal(proposals.length, 1, '一个窗口只判定一次（already_proposed）')
})

test('G4c-1 ★ 第一层每轮都跑且**不产生额外的 LLM 调用**（票 21 的验收口径）', async () => {
  const harness = createHarness({ judge: true })
  harness.pushTurn('第一轮')
  await harness.extension.flush()
  assert.equal(harness.judgeCalls(), 0, '第 1 轮：第一层照常上交，一次 LLM 都不调')
  harness.pushTurn('第二轮')
  await harness.extension.flush()
  assert.equal(harness.judgeCalls(), 0, '第 2 轮同上')

  harness.pushTurn('第三轮')
  await harness.extension.flush()
  assert.equal(harness.judgeCalls(), 1, '第 3 轮才触发**一次**第二层判定')
  assert.equal(harness.submitted.length, 3, '三轮都上交了第一层证据')

  harness.pushTurn('第四轮')
  harness.pushTurn('第五轮')
  await harness.extension.flush()
  assert.equal(harness.judgeCalls(), 1, '同一窗口不再重复判定')
})

test('G4d 判定出的学段在**下一轮**才进 prompt（学生无感）', async () => {
  const harness = createHarness()
  // 第 1 轮：服务端说 junior
  harness.setGrade('junior')
  harness.pushTurn('第一轮')
  await harness.extension.flush()

  // 第 1 轮的 before_agent_start：别的扩展拼的还是 primary_high → 本扩展不动它
  const first = harness.pi.emit('before_agent_start', {
    systemPrompt: GRADE_PROMPTS.primary_high
  })
  assert.equal(first, undefined, '本轮还没生效：不改链条')

  // 第 2 轮：交接发生 → 换成 junior 的模板
  harness.pushTurn('第二轮')
  const second = harness.pi.emit('before_agent_start', {
    systemPrompt: GRADE_PROMPTS.primary_high
  }) as { systemPrompt?: string } | undefined
  assert.ok(second?.systemPrompt, '第 2 轮必须换成新学段')
  assert.ok(second!.systemPrompt!.includes(GRADE_PROMPTS.junior))
  assert.ok(!second!.systemPrompt!.includes(GRADE_PROMPTS.primary_high))
})

test('G4e 学段没变时一律不改别人的 prompt', async () => {
  const harness = createHarness({ grade: 'primary_high' })
  harness.pushTurn('随便问一句')
  await harness.extension.flush()
  assert.equal(
    harness.pi.emit('before_agent_start', { systemPrompt: GRADE_PROMPTS.primary_high }),
    undefined
  )
  assert.equal(harness.extension.snapshot().pendingGrade, null)
  assert.equal(harness.extension.snapshot().appliedGrade, 'primary_high')
})

test('G4f 上交失败不影响本轮对话，只记日志并计数', async () => {
  const pi = createFakePi()
  const logs: string[] = []
  const extension = createGradeExtension({
    submitter: async () => {
      throw new Error('sidecar 没起来')
    },
    sessionProvider: () => SESSION,
    log: (line: string) => {
      logs.push(line)
    }
  })
  extension(pi as never)
  pi.emit('input', { type: 'input', text: '你好', source: 'interactive' })
  await extension.flush()

  const stats = extension.snapshot()
  assert.equal(stats.submitted, 0)
  assert.equal(stats.failed, 1)
  assert.ok(stats.lastError?.includes('sidecar'))
  assert.ok(logs.some((line) => line.includes('不影响本轮对话')))
  // 对话仍能拿到学段 prompt（绝不因为学段推断失败而少一道覆盖）
  const merged = pi.emit('before_agent_start', { systemPrompt: undefined }) as
    | { systemPrompt?: string }
    | undefined
  assert.equal(merged?.systemPrompt, gradePromptFor(DEFAULT_GRADE_LEVEL))
})

test('G4g 主动 refresh 能立刻取到当前学段（冷启动少一轮滞后）', async () => {
  const harness = createHarness({ grade: 'senior' })
  const grade = await harness.extension.refresh()
  assert.equal(grade, 'senior')
  const merged = harness.pi.emit('before_agent_start', { systemPrompt: GRADE_PROMPTS.junior }) as
    | { systemPrompt?: string }
    | undefined
  assert.ok(merged!.systemPrompt!.includes(GRADE_PROMPTS.senior))
})

test('G4h reset 清会话状态但不影响服务端数据', async () => {
  const harness = createHarness({ judge: true })
  harness.pushTurn('一')
  harness.pushTurn('二')
  await harness.extension.flush()
  assert.equal(harness.extension.snapshot().turn, 2)
  harness.extension.reset()
  const stats = harness.extension.snapshot()
  assert.equal(stats.turn, 0)
  assert.equal(stats.submitted, 0)
  assert.equal(stats.appliedGrade, DEFAULT_GRADE_LEVEL)
})

test('G4i 换学生必须把学段一起重置（绝不把上一个学生的学段带过去）', async () => {
  const pi = createFakePi()
  let session = { studentId: 'student_001', sessionId: 'sess-A', gradeLevel: 'primary_high' as GradeLevel }
  const logs: string[] = []
  const extension = createGradeExtension({
    submitter: async () => ({
      grade: 'senior',
      previousGrade: 'primary_high',
      changed: true,
      reason: 'changed',
      confidence: 0.9,
      turn: 1,
      direction: 1,
      streak: 3,
      cooldownRemainingTurns: 5,
      degraded: null
    }),
    sessionProvider: () => session,
    log: (line: string) => {
      logs.push(line)
    }
  })
  extension(pi as never)

  // 学生 A 的第 1 轮 → 服务端判定 senior（第 2 轮才生效）
  pi.emit('input', { type: 'input', text: '梯度下降', source: 'interactive' })
  await extension.flush()
  pi.emit('input', { type: 'input', text: '链式法则', source: 'interactive' })
  await extension.flush()
  assert.equal(extension.snapshot().appliedGrade, 'senior')

  // 换到学生 B：第一次 input 就该回到冷启动默认值，而不是沿用 senior
  session = { studentId: 'student_002', sessionId: 'sess-B', gradeLevel: 'primary_high' }
  pi.emit('input', { type: 'input', text: '你好', source: 'interactive' })
  assert.equal(extension.snapshot().appliedGrade, 'primary_high', '换学生后按冷启动默认值起步')
  assert.ok(logs.some((line) => line.includes('切换学生')), '换学生要留一行可见日志')
  await extension.flush()
})

test('G4j 同一学生换会话（/new）：学段沿用，但第二层的窗口重来', async () => {
  const pi = createFakePi()
  let session = { studentId: 'student_001', sessionId: 'sess-A', gradeLevel: 'primary_high' as GradeLevel }
  let judgeCalls = 0
  const extension = createGradeExtension({
    submitter: async (_studentId: string, body: { turns: Array<{ turn: number }> }) => ({
      grade: 'primary_high',
      previousGrade: 'primary_high',
      changed: false,
      reason: 'no_direction',
      confidence: 0,
      turn: body.turns[0].turn,
      direction: 0,
      streak: 0,
      cooldownRemainingTurns: 0,
      degraded: null
    }),
    judge: async () => {
      judgeCalls += 1
      return { suggestedGrade: 'primary_high', confidence: 0.7 }
    },
    sessionProvider: () => session
  })
  extension(pi as never)

  for (let index = 0; index < 3; index += 1) {
    pi.emit('input', { type: 'input', text: `第 ${index} 轮`, source: 'interactive' })
    await extension.flush()
  }
  assert.equal(judgeCalls, 1, '第 3 轮判定过一次')
  assert.equal(extension.snapshot().turn, 3)

  session = { studentId: 'student_001', sessionId: 'sess-B', gradeLevel: 'primary_high' }
  pi.emit('input', { type: 'input', text: '换会话后的第一轮', source: 'interactive' })
  await extension.flush()
  const stats = extension.snapshot()
  assert.equal(stats.turn, 1, '新会话的轮次从 1 重新计')
  assert.equal(stats.layer2, 'not_due')
  assert.equal(stats.appliedGrade, DEFAULT_GRADE_LEVEL, '同一学生：学段沿用（此处服务端返回的也是默认值）')
})
