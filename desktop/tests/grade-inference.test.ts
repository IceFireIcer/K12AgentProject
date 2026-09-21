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
 *   G3  **chain 保真**：别的扩展拼好的 prompt 只做学段片段替换，其余内容一个字节都不许丢；
 *       拼出来的 prompt **始终**带权威段（`GRADE_OVERRIDE_HEADING`），且**幂等**
 *   G4  **下一轮生效**：第 N 轮判定出的学段在第 N+1 轮的 prompt 里才生效（学生无感）
 *
 * ★★ **2026-09-16 返工（本文件随之改了断言口径）**：原来这些用例假定
 *   「`grade.ts` 用 `pi.on('input'|'before_agent_start')` 驱动」。实测证明那两条挂不上
 *   （无 Key 时 `prompt()` 根本不被调用 → `input` 不发；`before_agent_start` 排在凭证校验之后），
 *   于是改成由 `runtime.ts` 显式调用 `observeTurn()` / `systemPromptFor()`。
 *   用例改成打**同一套语义**的新入口，并**新增两条守卫**：
 *     - G1e 本扩展不再订阅任何 Pi 事件（防止有人「顺手加回去」，那会让无 Key 世界再次静默失灵）；
 *     - G4b `systemPromptFor()` 的输出**幂等**（重复拼装不会叠出第二段权威段）。
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
  LLM_DECIDES_FROM_TURN,
  LAYER2_MIN_TURNS,
  LAYER2_RETRY_TURN,
  MAX_TURN_CHARS,
  buildGradeSystemPrompt,
  buildJudgePrompt,
  clampTurnText,
  countUsableTurns,
  createGradeExtension,
  isDegradedLayer2,
  parseProposal,
  shouldRequestLayer2,
  stripGradeOverride,
  swapKnownGradeTemplate,
  type GradeProposal,
  type GradeTurnResponse,
  type GradeStateSnapshot,
  type Layer2Status
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

/**
 * 去掉注释再匹配（守卫只在**代码**上断言）。
 *
 * ★ 这不是洁癖：`grade.ts` 的文件头与 `observeTurn` 的注释里**故意**引用了
 * `pi.on('input')` / `pi.on('before_agent_start')` 来解释返工原因；不去注释就会
 * 把「解释」误判成「订阅」。同一坑 `architecture-guards.test.ts` 已经踩过并留了实现。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
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

test('G1a-2 ★★ 「哪些第二层状态算降级」两边必须一致（否则 degraded 又会说谎）', () => {
  /**
   * 这条盯的是一个**已经发生过**的缺陷：服务端原先按「没有提议 + 第 3 轮起」
   * 就报 `degraded="no_llm"`，把 `already_proposed`（本窗口早提过议，
   * 属**正常工作**）也算成了「没有模型」。实测 436 次判定里 218 次被这么标，
   * 而 63 次第 3 轮判定里 **48 次真的带上了提议** —— 标注与实际相反。
   *
   * 现在两边各有一份白名单（服务端 `DEGRADED_LAYER2_STATUSES`、
   * 桌面端 `isDegradedLayer2()`）。**改一边不改另一边 = 同一个谎换一种形式**，
   * 所以这里逐值对照。
   */
  const ALL_STATUSES: Layer2Status[] = [
    'not_due',
    'no_llm',
    'judge_error',
    'due',
    'retry',
    'insufficient_evidence',
    'already_proposed',
    'used'
  ]

  // 从 Python 源码里把 frozenset 的字面量抠出来。
  // ⚠️ 集合里既可能直接写字符串（`"judge_error"`），也可能引用常量
  //    （`DEGRADED_NO_LLM`）—— 两种写法都要认，否则这条守卫会因为「写法不同」
  //    而误报，最后被人当成噪音删掉（那就等于没守）。
  const matched = /DEGRADED_LAYER2_STATUSES[^=]*=\s*frozenset\(\{([^}]*)\}\)/.exec(rulesSource)
  assert.ok(matched, 'server 侧找不到 DEGRADED_LAYER2_STATUSES 的字面量')
  const pyDegraded = new Set<Layer2Status>()
  for (const raw of matched[1].split(',')) {
    const item = raw.trim()
    if (!item) continue
    const literal = /^"([a-z_]+)"$/.exec(item)
    if (literal) {
      pyDegraded.add(literal[1] as Layer2Status)
      continue
    }
    // 引用了常量：回源码里查它的值（`DEGRADED_NO_LLM = "no_llm"`）
    const constMatch = new RegExp(`^${item}\\s*=\\s*"([a-z_]+)"`, 'm').exec(rulesSource)
    assert.ok(constMatch, `server 侧的 ${item} 找不到字符串定义`)
    pyDegraded.add(constMatch[1] as Layer2Status)
  }
  assert.equal(pyDegraded.size, 2, '白名单恰好两个状态（多了就是把正常工作也当降级）')

  const tsDegraded = new Set(ALL_STATUSES.filter((status) => isDegradedLayer2(status)))
  assert.deepEqual(
    [...tsDegraded].sort(),
    [...pyDegraded].sort(),
    '两边的「降级状态白名单」必须逐一相同'
  )

  // ★ 正向断言：真降级恰好这两个（多一个会让标注重新失真）
  assert.deepEqual([...tsDegraded].sort(), ['judge_error', 'no_llm'])

  // ★★ 反向对照：这几个**都不算**降级 —— 它们描述的是「第二层工作正常」。
  //    漏掉这条，白名单就可能被写成「除了 used 都算降级」（那等于没修）。
  for (const ok of ['used', 'due', 'retry', 'already_proposed', 'not_due', 'insufficient_evidence'] as Layer2Status[]) {
    assert.equal(isDegradedLayer2(ok), false, `${ok} 不该被标成降级（它不是「第二层没工作」）`)
  }
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

test('G1d 清单里的 grade 扩展文件真实存在，且本扩展**不再订阅任何 Pi 事件**', () => {
  const spec = AGENT_EXTENSION_SPECS.find((entry) => entry.name === 'grade')
  assert.ok(spec, 'extensions/index.ts 里少了 grade 这一项')
  assert.equal(spec!.file, './grade.ts')
  assert.ok(existsSync(join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'grade.ts')), 'grade.ts 没落地')

  // ★★ 2026-09-16 返工（这条断言原来要求「只订阅 input + before_agent_start」）。
  //   实测：`input` 只在真的调用 `session.prompt()` 时才发，而本项目**无 Key 时根本不调它**；
  //   `before_agent_start` 又排在凭证校验之后。两条挂在这两个事件上都会让「无 Key 世界」
  //   静默失灵（grade_signals 0 行、prompt 里 grep 不到学段）。
  //   现在由 `runtime.ts` 显式调用 observeTurn()/systemPromptFor()，本扩展**不订阅任何事件**。
  //   这条守卫的作用是防止有人「顺手加回 pi.on(...)」—— 那会重新引入一份只在有 Key 时
  //   才生效的**重复观察路径**（信号被双份计数）。
  //   ⚠️ 必须先在**去注释**的源码上匹配：文件头与 `observeTurn` 的注释里会引用这两个事件名做论证。
  const subscribed = [...stripComments(gradeExtensionSource).matchAll(/\bpi\s*\.\s*on\s*\(/g)]
  assert.deepEqual(
    subscribed.map((match) => match[0]),
    [],
    'grade 扩展不订阅 Pi 事件（能力由 runtime.ts 显式驱动）'
  )
  assert.deepEqual(spec!.events, [], '清单里 grade 的 events 必须为空（与实现一致）')
})

test('G1e 本扩展导出 runtime.ts 需要的两个显式入口（返回 Promise 之外的同步能力）', () => {
  for (const member of ['observeTurn', 'systemPromptFor', 'appliedGrade']) {
    assert.ok(
      new RegExp(`extension\\.${member}\\s*=`).test(gradeExtensionSource),
      `grade 扩展必须挂上 ${member}()（runtime.ts 靠它驱动学段）`
    )
  }
  assert.ok(
    /gradeExtension\.observeTurn\(/.test(
      readFileSync(join(desktopRoot, 'src', 'main', 'agent', 'runtime.ts'), 'utf8')
    ),
    'runtime.ts 必须在每轮开始时调用 observeTurn（这是唯一的观察入口）'
  )
})

/* ------------------------------------------------------------------ *
 * G2 第二层的触发与降级
 * ------------------------------------------------------------------ */

test('G2a ★★ 累计第 5 轮起才请 LLM 出场（D-066）；前 4 轮只有规则判', () => {
  // 前 4 个累计轮次：一律不触发 —— 这一段由**规则引擎**全权判定
  for (const cumulativeTurns of [1, 2, 3, 4]) {
    assert.deepEqual(
      shouldRequestLayer2({ cumulativeTurns, usableTurns: 8, windowHasProposal: false, judgeAvailable: true }),
      { run: false, status: 'not_due' },
      `累计第 ${cumulativeTurns} 轮不该请 LLM（前 4 轮是规则的地盘）`
    )
  }
  // 第 5 个累计轮次：到点，LLM 出场（此后它**直接定方向**，不再只是提议）
  assert.deepEqual(
    shouldRequestLayer2({ cumulativeTurns: 5, usableTurns: 5, windowHasProposal: false, judgeAvailable: true }),
    { run: true, status: 'due' }
  )
  assert.equal(LLM_DECIDES_FROM_TURN, 5, '「前五轮用本地规则」是用户裁决的冻结口径')
})

test('G2b ★ 计数单位是**累计轮次**（跨会话），不是本地那个每会话计数器', () => {
  // ★ 这是本票最容易写错的一处：拿 `turn`（每会话计数器）判断，会让每个新会话
  //   都从头等 5 轮 —— 而实测会话普遍只有 3–8 轮，很多会话永远等不到 LLM。
  //   所以入参是 `cumulativeTurns`，且**它来自服务端**（`GET /api/grade/state`）。
  const same = shouldRequestLayer2({
    cumulativeTurns: 5, usableTurns: 5, windowHasProposal: false, judgeAvailable: true
  })
  assert.deepEqual(same, { run: true, status: 'due' })
  // 累计到第 5 轮、但本轮是新会话的第 1 轮 —— **照常触发**（累计轮次不看会话）
  assert.deepEqual(
    shouldRequestLayer2({ cumulativeTurns: 5, usableTurns: 1, windowHasProposal: false, judgeAvailable: true }),
    { run: false, status: 'insufficient_evidence' },
    '到点了但本轮可用证据太少 → 等攒够（不硬判）'
  )
  assert.equal(LAYER2_MIN_TURNS, 3, '至少 3 轮可用证据才算「够料」')
})

test('G2c 一个窗口只判定一次，且没有通道时显式 no_llm', () => {
  assert.deepEqual(
    shouldRequestLayer2({ cumulativeTurns: 6, usableTurns: 6, windowHasProposal: true, judgeAvailable: true }),
    { run: false, status: 'already_proposed' }
  )
  assert.deepEqual(
    shouldRequestLayer2({ cumulativeTurns: 9, usableTurns: 9, windowHasProposal: false, judgeAvailable: false }),
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
 * G3 prompt 组装（链式保真 + 始终可审计）
 * ------------------------------------------------------------------ */

test('G3a 拿不到别的扩展的 prompt → 给出推断学段的模板（绝不返回空）', () => {
  const junior = buildGradeSystemPrompt({ incoming: undefined, inferredGrade: 'junior' })
  assert.ok(junior.includes(gradePromptFor('junior')), '必须给出推断学段的模板')
  assert.ok(junior.includes(GRADE_OVERRIDE_HEADING), '★ 权威段必须在（无 Key 世界就靠它证明覆盖生效）')
  const low = buildGradeSystemPrompt({ incoming: '', inferredGrade: 'primary_low' })
  assert.ok(low.includes(gradePromptFor('primary_low')))
})

test('G3b 已经是目标模板 → 仍然追加权威段（学段可见，可审计）', () => {
  const merged = buildGradeSystemPrompt({ incoming: gradePromptFor('senior'), inferredGrade: 'senior' })
  // ★ 旧实现这里返回 undefined（「不动链条」），后果是 wire prompt 里**看不出**学段覆盖有没有生效。
  assert.ok(merged.includes(GRADE_OVERRIDE_HEADING), '同一学段也要有权威段（可审计性）')
  assert.equal(
    merged.split(gradePromptFor('senior')).length - 1,
    1,
    '模板已经在了，权威段里不得再抄一遍（省 ~2.5k token）'
  )
})

test('G3c 只替换学段模板片段，别的扩展追加的内容一个字节都不丢', () => {
  const incoming = `【别的扩展加的头】\n${GRADE_PROMPTS.primary_high}\n【别的扩展加的尾】`
  const merged = buildGradeSystemPrompt({ incoming, inferredGrade: 'junior' })
  assert.ok(merged.startsWith('【别的扩展加的头】'), '别人的头原样保留')
  assert.ok(merged.includes('【别的扩展加的尾】'), '别人的尾原样保留')
  assert.ok(merged.includes(GRADE_PROMPTS.junior), '应当换成推断学段的模板')
  assert.ok(!merged.includes(GRADE_PROMPTS.primary_high), '旧学段模板应当被换掉')
  assert.ok(merged.includes(GRADE_OVERRIDE_HEADING))
})

test('G3d 认不出的自定义 prompt → 原样保留 + 追加权威覆盖块', () => {
  const incoming = '某个扩展自己拼的 system prompt，不是四份模板里的任何一份。'
  const merged = buildGradeSystemPrompt({ incoming, inferredGrade: 'senior' })
  assert.ok(merged.startsWith(incoming), '别人的内容原样保留')
  assert.ok(merged.includes(GRADE_OVERRIDE_HEADING))
  assert.ok(merged.includes(GRADE_PROMPTS.senior), '覆盖块里必须给出权威学段模板')
  assert.equal(swapKnownGradeTemplate(incoming, GRADE_PROMPTS.senior), null)
})

test('G3e ★ 拼装幂等：重复调用不会叠出第二段权威段', () => {
  const once = buildGradeSystemPrompt({ incoming: GRADE_PROMPTS.primary_high, inferredGrade: 'junior' })
  const twice = buildGradeSystemPrompt({ incoming: once, inferredGrade: 'junior' })
  assert.equal(twice, once, '第二次拼装必须与原结果逐字相同')
  assert.equal(once.split(GRADE_OVERRIDE_HEADING).length - 1, 1, '权威段只允许出现一次')
  // 剥掉权威段后应当回到原来的「别人的 prompt」（模板已被换成 junior，所以不会与原始相同）
  assert.ok(!stripGradeOverride(once).includes(GRADE_OVERRIDE_HEADING))
  assert.equal(stripGradeOverride(GRADE_PROMPTS.senior), GRADE_PROMPTS.senior, '没有权威段时原样返回')
})

test('G3f ★ Pi 追加的宿主 cwd 行必须被整段丢弃（风险 #19 的二道防线）', () => {
  // 真实形态（`system-prompt.js` 的 `buildSystemPrompt`）：哪怕给了 customPrompt，
  // Pi 仍会无条件在**末尾**追加一行 `Current working directory: <绝对路径>`。
  // `before_agent_start` 拿到的 `event.systemPrompt` 里就有它 —— 覆盖必须把它整段丢掉。
  const loader = buildGradeSystemPrompt({ incoming: undefined, inferredGrade: 'junior' })
  const withCwd = `${loader}\nCurrent working directory: C:/Users/Someone/AppData/Roaming/k12-agent-desktop\n`
  const out = buildGradeSystemPrompt({ incoming: withCwd, inferredGrade: 'junior' })

  assert.ok(!out.includes('Current working directory'), 'cwd 行不得留在最终 prompt 里')
  assert.ok(!/AppData|C:\//i.test(out), '不得出现宿主路径')
  assert.equal(out.split(GRADE_OVERRIDE_HEADING).length - 1, 1, '权威段仍然只出现一次')
  assert.equal(out.split(GRADE_PROMPTS.junior).length - 1, 1, '模板也不得被抄一遍')
})

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

test('G3g 文本截断与可用轮数', () => {
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
  /**
   * 模拟「学生发了一轮」。
   *
   * ★ 2026-09-16 返工：原来是 `pi.emit('input', …)`（走 Pi 事件），现在直接调
   * `extension.observeTurn()` —— 与 `runtime.ts` 的调用方式**逐字一致**（同一入口）。
   */
  pushTurn(text: string): void
  /** 模拟本轮拼 system prompt（`runtime.ts` 的 `before_agent_start` 里就是这么调的）。 */
  promptFor(incoming: string | undefined): string
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
    pushTurn: (text: string) => {
      extension.observeTurn(text)
    },
    promptFor: (incoming: string | undefined) => extension.systemPromptFor(incoming)
  }
}

test('G4a observeTurn 上交本轮证据，且不含任何服务端算好的信号', async () => {
  const harness = createHarness()
  harness.pushTurn('电脑怎么认图片呀？')
  await harness.extension.flush()

  assert.equal(harness.submitted.length, 1)
  const body = harness.submitted[0].turns[0]
  // ★ `layer2Status` 是 2026-09-21 新加的：把**通道状态**上报给服务端，
  //   好让它别再把 `already_proposed`（正常工作）标成 `degraded="no_llm"`。
  assert.deepEqual(Object.keys(body).sort(), ['layer2Status', 'sessionId', 'text', 'turn'])
  assert.equal(body.turn, 1)
  assert.equal(body.text, '电脑怎么认图片呀？')
  assert.equal(body.sessionId, 'sess-1')
  assert.equal(harness.submitted[0].studentId, 'student_001')
  // ★ 仍然不含任何**服务端算好的信号**（方向/强度/置信度一概不上交）——
  //   这是契约纪律：提取与判定只在 Python 发生一次。
  assert.equal('signals' in body, false)
  assert.equal('confidence' in body, false)
  assert.equal('direction' in body, false)
  // ★ 工厂本身是空实现（不再订阅 Pi 事件）：不订阅也是「已注册」，注册器照常把它算作就位
  assert.deepEqual(Object.keys(harness.pi.handlers), [], '本扩展不得订阅任何 Pi 事件')
})

test('G4b ★★ 累计第 5 轮带上第二层提议；没有通道时不带提议而且降级可见', async () => {
  // ★ 2026-09-21（D-066）：LLM 的出场点从「第 3 轮」改成「累计第 5 轮」
  //   —— 前 4 轮是**规则引擎**的地盘（标签「本地规则判定」）。
  const withJudge = createHarness({ judge: true })
  for (const text of ['一', '二', '三', '四', '五']) withJudge.pushTurn(text)
  await withJudge.extension.flush()
  assert.equal(
    withJudge.submitted.at(-1)!.turns[0].proposal?.suggestedGrade,
    'primary_low',
    '第 5 轮才带提议（前 4 轮规则判，不上交提议）'
  )
  assert.equal(withJudge.extension.snapshot().layer2, 'used')
  assert.equal(
    withJudge.submitted.slice(0, 4).every((entry) => !entry.turns[0].proposal),
    true,
    '前 4 轮一律不带提议'
  )

  const withoutJudge = createHarness({ judge: false })
  for (const text of ['一', '二', '三', '四', '五']) withoutJudge.pushTurn(text)
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
  for (let index = 0; index < 6; index += 1) harness.pushTurn(`第 ${index} 轮`)
  await harness.extension.flush()
  const proposals = harness.submitted.filter((entry) => entry.turns[0].proposal)
  assert.equal(proposals.length, 1, '一个窗口只判定一次（already_proposed）')
})

test('G4c-1 ★ 前 4 轮一次 LLM 都不调；累计第 5 轮才触发（D-066 的冻结口径）', async () => {
  const harness = createHarness({ judge: true })
  for (const nth of ['第一轮', '第二轮', '第三轮', '第四轮']) {
    harness.pushTurn(nth)
    await harness.extension.flush()
    assert.equal(harness.judgeCalls(), 0, `${nth}：前 4 轮是规则引擎的地盘，一次 LLM 都不调`)
  }
  assert.equal(harness.submitted.length, 4, '前 4 轮都上交了第一层证据（规则判）')

  harness.pushTurn('第五轮')
  await harness.extension.flush()
  assert.equal(harness.judgeCalls(), 1, '累计第 5 轮：LLM 出场，触发**一次**判定')
  assert.equal(harness.submitted.length, 5, '五轮都上交了第一层证据')

  harness.pushTurn('第六轮')
  harness.pushTurn('第七轮')
  await harness.extension.flush()
  assert.equal(harness.judgeCalls(), 1, '同一窗口不再重复判定')
})

test('G4d 判定出的学段在**下一轮**才进 prompt（学生无感）', async () => {
  const harness = createHarness()
  // 第 1 轮：服务端说 junior
  harness.setGrade('junior')
  harness.pushTurn('第一轮')
  await harness.extension.flush()

  // 第 1 轮：服务端还没判出来 → 别人拼的是 primary_high，学段片段不动（只追加权威段）
  const first = harness.promptFor(GRADE_PROMPTS.primary_high)
  assert.ok(first.includes(GRADE_PROMPTS.primary_high), '本轮学段还没交接：模板保持原样')
  assert.ok(!first.includes(GRADE_PROMPTS.junior), '本轮不得提前换成新学段')
  assert.equal(harness.extension.appliedGrade(), 'primary_high')

  // 第 2 轮：交接发生 → 换成 junior 的模板
  harness.pushTurn('第二轮')
  const second = harness.promptFor(GRADE_PROMPTS.primary_high)
  assert.ok(second.includes(GRADE_PROMPTS.junior), '第 2 轮必须换成新学段')
  assert.ok(!second.includes(GRADE_PROMPTS.primary_high), '旧学段模板应当被换掉')
  assert.ok(second.includes(GRADE_OVERRIDE_HEADING), '★ 权威段始终在（wire prompt 可断言）')
  assert.equal(harness.extension.appliedGrade(), 'junior')
})

test('G4e 学段没变时不动别人的模板内容（只追加权威段）', async () => {
  const harness = createHarness({ grade: 'primary_high' })
  harness.pushTurn('随便问一句')
  await harness.extension.flush()
  const prompt = harness.promptFor(GRADE_PROMPTS.primary_high)
  assert.ok(prompt.includes(GRADE_PROMPTS.primary_high), '别人的模板原样保留')
  assert.equal(prompt.split(GRADE_PROMPTS.primary_high).length - 1, 1, '不得把模板抄第二遍')
  assert.ok(prompt.includes(GRADE_OVERRIDE_HEADING), '★ 学段没变也要有权威段（可审计）')
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
  extension.observeTurn('你好')
  await extension.flush()

  const stats = extension.snapshot()
  assert.equal(stats.submitted, 0)
  assert.equal(stats.failed, 1)
  assert.ok(stats.lastError?.includes('sidecar'))
  assert.ok(logs.some((line) => line.includes('不影响本轮对话')))
  // 对话仍能拿到学段 prompt（绝不因为学段推断失败而少一道覆盖）
  const prompt = extension.systemPromptFor(undefined)
  assert.ok(prompt.includes(gradePromptFor(DEFAULT_GRADE_LEVEL)))
  assert.ok(prompt.includes(GRADE_OVERRIDE_HEADING))
})

test('G4g 主动 refresh 能立刻取到当前学段（冷启动少一轮滞后）', async () => {
  const harness = createHarness({ grade: 'senior' })
  const grade = await harness.extension.refresh()
  assert.equal(grade, 'senior')
  const prompt = harness.promptFor(GRADE_PROMPTS.junior)
  assert.ok(prompt.includes(GRADE_PROMPTS.senior), 'refresh 之后立刻按 senior 拼')
  assert.ok(!prompt.includes(GRADE_PROMPTS.junior))
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
  extension.observeTurn('梯度下降')
  await extension.flush()
  extension.observeTurn('链式法则')
  await extension.flush()
  assert.equal(extension.snapshot().appliedGrade, 'senior')

  // 换到学生 B：第一次 observeTurn 就该回到冷启动默认值，而不是沿用 senior
  session = { studentId: 'student_002', sessionId: 'sess-B', gradeLevel: 'primary_high' }
  extension.observeTurn('你好')
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

  // ★ 2026-09-21（D-066）：LLM 在**累计**第 5 轮出场（前 4 轮规则判）
  for (let index = 0; index < 5; index += 1) {
    extension.observeTurn(`第 ${index} 轮`)
    await extension.flush()
  }
  assert.equal(judgeCalls, 1, '累计第 5 轮判定过一次')
  assert.equal(extension.snapshot().turn, 5)

  session = { studentId: 'student_001', sessionId: 'sess-B', gradeLevel: 'primary_high' }
  extension.observeTurn('换会话后的第一轮')
  await extension.flush()
  const stats = extension.snapshot()
  assert.equal(stats.turn, 1, '新会话的轮次从 1 重新计（**本地计数器**）')
  // ★★ **累计轮次跨会话继续累加**（D-066 的核心）：换会话前已聊 5 轮，这里换完再聊 1 轮 → 6。
  //   它**不能**跟着 `turn` 归零 —— 否则「第 5 轮起 LLM 接管」在跨会话时永远不成立
  //   （实测 CI：这条断言曾报 `1 !== 6`，正是「累计数被 resetWindow 打回去」的现场）。
  assert.equal(
    stats.cumulativeTurns,
    6,
    '累计轮次跨会话累加（换会话 ≠ 没聊过）——这正是 D-066 要的口径'
  )
  assert.equal(stats.appliedGrade, DEFAULT_GRADE_LEVEL, '同一学生：学段沿用（此处服务端返回的也是默认值）')
})
