/**
 * 票 20 守卫：**学生情况（画像）注入 System Prompt**（`prompts/student-context.ts` +
 * `extensions/profile.ts` 的预取 + `runtime.ts` 的唯一出口）。
 *
 * 这一组断言盯住的是一类**不会崩、只会静默失效**的问题 —— 个性化明明写了，学生却感觉不到：
 *
 *   G20-1  ★ 幂等：每轮重拼不会一轮叠一块（重复调用**逐字相等**，块恰好一个）
 *   G20-2  ★ 插入位置：块排在**学段权威段之前**，且注入不会把权威段顶掉 / 吃掉
 *   G20-3  空块：没有画像（或预取降级）时不留下「只有标题的空壳段」
 *   G20-4  内容：掌握度分档 / 学习偏好 / 推荐下一步三类信息都在（模型拿到的是可直接照做的话）
 *   G20-5  单一实现：块正文就是 `renderProfileText` 的输出（防「两套渲染」漂移）
 *   G20-6  无宿主路径：块过 `findHostPathLeaks` 必须为空（与 P3a 同款口径）
 *   G20-7  strip 语义：不含块时逐字返回，含块时清干净（幂等的前提）
 *   G20-8  ★ 与学段块共存：连续 3 轮「先学段、后学生情况」后两块各只剩一个
 *          （照抄 `stripGradeOverride` 的「切到末尾」会把学段权威段一起切掉的真实风险）
 *   G20-9  冷启动：`renderStudentContextBlock(null)` 为空，但 404（新学生）给的是
 *          **带标题的非空块**（不带标题 → 下一轮 strip 不掉 → 一轮叠一块）
 *   G20-10 ★ 唯一出口（源码级）：`runtime.ts` 里 `systemPromptFor(` 只剩 1 处（在
 *          `buildSystemPrompt` 内部），且画像预取排在 `reviewInput` / 无 Key 早退**之前**
 *
 *   G21 组（缓存前缀稳定性）：块必须**逐字节稳定** —— 同样的画像两次渲染逐字相等、
 *        `lastActiveAt` 变化不影响块、偏好顺序与掌握度平局都不影响块；
 *        外加**反向对照**（画像真变了块必须变，防「把块冻成常量」这种假优化）。
 *        成因见 `renderProfileText` 头部第二条纪律：块是 system prompt 的最前面一段，
 *        混进任何每轮都变的字节都会让整段前缀 + 其后全部对话历史丢掉缓存命中。
 *
 * ★ 为什么第 10 条是**读源码**而不是构造一个真 runtime：`buildSystemPrompt()` 有 6 个落点
 *   （`before_agent_start` / `systemPromptOverride` / 学段自检 / 三条早退路径），
 *   构造真 runtime 要拉起 Pi、sidecar 与 Electron 的 `app`，成本远超收益；
 *   而这条规则的失效形态恰好是**结构性的**（有人在某个落点直接调 `systemPromptFor(`、
 *   或把预取挪到早退路径之后），读源码就足以判定。
 *   真 HTTP 那一半（`fetchStudentContext` 遇 404 / 连不上）在第 9 条里用**本机假服务端**实测。
 *
 * ⚠️ `node --test` 直跑 `.ts` 用的是 Node 的类型擦除 —— **禁用 TS parameter property**
 *   （`constructor(private readonly x)`），见 AGENTS §8.1。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { clearSidecarEndpoint, configureSidecarEndpoint } from '../src/main/bridge/client.ts'
import { buildGradeSystemPrompt, GRADE_OVERRIDE_HEADING } from '../src/main/agent/extensions/grade.ts'
import {
  fetchStudentContext,
  MISTAKE_INJECT_LIMIT,
  orderPreferences,
  PREFERENCE_ORDER,
  renderProfileText,
  type ProfileResponse,
  type RecommendationResponse
} from '../src/main/agent/extensions/profile.ts'
import { findHostPathLeaks } from '../src/main/agent/pi-bootstrap.ts'
import {
  renderStudentContextBlock,
  stripStudentContext,
  STUDENT_CONTEXT_HEADING,
  withStudentContext
} from '../src/main/agent/prompts/student-context.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ *
 * 夹具：一份「像真的」的画像 + 一份带学段权威段的基座 prompt
 * ------------------------------------------------------------------ */

/** 掌握度两条：0.9（已掌握）与 0.35（正在学）—— 分档渲染必须都体现出来。 */
const FAKE_PROFILE: ProfileResponse = {
  student: {
    studentId: 'student_001',
    nickname: '小同',
    gradeLevel: 'junior',
    lastActiveAt: 1_757_000_000
  },
  mastery: [
    { kpId: 'prog-loop-jr', score: 0.9, attempts: 3, correct: 3, lastSeenAt: 1_757_000_000 },
    { kpId: 'prog-variable-jr', score: 0.35, attempts: 2, correct: 1, lastSeenAt: 1_756_000_000 }
  ],
  preferences: { explain_style: '喜欢用生活中的例子', pace: '想慢一点' },
  recommendedKpIds: ['prog-list-jr']
}

/** 推荐详细版（票 20 的 `/recommendation`）：带理由，渲染成「推荐下一步（…）」那一行。 */
const FAKE_RECOMMENDATION: RecommendationResponse = {
  source: 'graph',
  summary: '前置已经会了，可以直接往下讲循环。',
  items: [{ kpId: 'prog-loop-jr', name: '循环：重复的事交给机器', gradeLevel: 'junior', depth: 1, mastery: 0.9, reason: '前置已掌握' }]
}

/** 带学段权威段的基座 prompt（真实形态：`buildGradeSystemPrompt` 的产物）。 */
const GRADE_BASE = buildGradeSystemPrompt({ incoming: '（基座模板）', inferredGrade: 'junior' })

/** 出现次数（`split` 计数比正则更直白，且 needle 里有中文与括号）。 */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/* ------------------------------------------------------------------ *
 * G20-1 ★ 幂等
 * ------------------------------------------------------------------ */

test('G20-1 ★ 幂等：重复注入逐字相等，块恰好一个（否则每轮叠一层）', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, { recommendation: FAKE_RECOMMENDATION })
  assert.ok(block.length > 0)

  const once = withStudentContext(GRADE_BASE, block)
  const twice = withStudentContext(once, block)
  assert.equal(twice, once, '第二次注入必须与第一次**逐字相等**（不是「大致一样」）')
  assert.equal(countOccurrences(once, STUDENT_CONTEXT_HEADING), 1, '块必须恰好一个')

  // 模拟真实运行时：连续 5 轮重拼（`before_agent_start` 每轮都会拿到上一轮的产物）
  let prompt = GRADE_BASE
  for (let round = 0; round < 5; round += 1) prompt = withStudentContext(prompt, block)
  assert.equal(prompt, once, '5 轮之后必须还是那一份（prompt 预算不会被自己吃掉）')
  assert.equal(countOccurrences(prompt, STUDENT_CONTEXT_HEADING), 1)
})

/* ------------------------------------------------------------------ *
 * G20-2 ★ 插入位置
 * ------------------------------------------------------------------ */

test('G20-2 ★ 插入位置：块在学段权威段之前，权威段仍在', () => {
  const prompt = withStudentContext(GRADE_BASE, renderStudentContextBlock(FAKE_PROFILE))

  const blockAt = prompt.indexOf(STUDENT_CONTEXT_HEADING)
  const gradeAt = prompt.indexOf(GRADE_OVERRIDE_HEADING)
  assert.ok(blockAt >= 0, '学生情况块没插进 prompt')
  assert.ok(gradeAt >= 0, '学段权威段不见了')
  assert.ok(blockAt < gradeAt, '★ 块必须排在学段权威段**之前**（权威指令要离生成最近）')
  assert.equal(countOccurrences(prompt, GRADE_OVERRIDE_HEADING), 1, '注入把权威段复制/叠加了')
  assert.ok(prompt.includes('（基座模板）'), '注入不能顺手把别人的内容顶掉')
})

/* ------------------------------------------------------------------ *
 * G20-3 空块
 * ------------------------------------------------------------------ */

test('G20-3 空块：没有画像就不注入，更不留「只有标题的空壳段」', () => {
  assert.equal(renderStudentContextBlock(null), '', 'null 画像必须是空串（空壳段会让模型以为「查过了，什么都没有」）')

  const dirty = withStudentContext(GRADE_BASE, renderStudentContextBlock(FAKE_PROFILE))
  assert.ok(dirty.includes(STUDENT_CONTEXT_HEADING))

  const cleaned = withStudentContext(dirty, '')
  assert.ok(!cleaned.includes(STUDENT_CONTEXT_HEADING), '空块必须把上一轮的旧块清掉')
  assert.ok(cleaned.includes(GRADE_OVERRIDE_HEADING), '清旧块不能连学段权威段一起清掉')

  // 本来就没有块时：空块注入是**逐字返回**（不动别人的 prompt）
  assert.equal(withStudentContext(GRADE_BASE, ''), GRADE_BASE)
})

/* ------------------------------------------------------------------ *
 * G20-4 / G20-5 内容与单一实现
 * ------------------------------------------------------------------ */

test('G20-4 内容：掌握度分档 / 学习偏好 / 推荐下一步都在块里', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, {
    recommendation: FAKE_RECOMMENDATION,
    fallbackStudentId: 'student_001'
  })

  assert.ok(block.startsWith(STUDENT_CONTEXT_HEADING), '块必须**以标题起头**（strip 靠它认块）')
  assert.ok(block.includes('已掌握'), '0.9 必须渲染成「已掌握」这类可执行指示（而不是一个 0.9 让模型猜）')
  assert.ok(block.includes('正在学'), '0.35 必须渲染成「正在学」')
  assert.ok(block.includes('学习偏好'), '偏好行必须在（`remember_preference` 写的就是它）')
  assert.ok(block.includes('explain_style=喜欢用生活中的例子'), '偏好的 key=value 必须原样进块')
  assert.ok(block.includes('推荐下一步'), '推荐行必须在（个性化闭环的「读」这一端）')
  assert.ok(block.includes('推荐口径') || block.includes('优先顺着这条线引导'), '推荐口径或退路提示必须有一句')
  // 掌握度按分数降序：0.9 那条排在 0.35 前面（prompt 预算先给最重要的）
  assert.ok(block.indexOf('prog-loop-jr') < block.indexOf('prog-variable-jr'))
})

test('G20-5 单一实现：块正文就是 renderProfileText 的输出（防两套渲染漂移）', () => {
  const options = { maxMastery: 3, recommendation: FAKE_RECOMMENDATION, fallbackStudentId: 'student_001' }
  const block = renderStudentContextBlock(FAKE_PROFILE, options)
  const body = renderProfileText(FAKE_PROFILE, options)

  assert.ok(body.length > 0)
  assert.ok(
    block.includes(body),
    '块正文与 renderProfileText 的输出不一致 —— 说明有人在本模块里**另写了一份渲染**：\n' +
      `期望包含：\n${body}\n实际块：\n${block}`
  )

  // 反向对照（同一份数据必须同步变化）：画像里没有偏好时，块里也不该有「学习偏好」那一行
  const noPreference = renderStudentContextBlock({ ...FAKE_PROFILE, preferences: {} })
  assert.ok(!noPreference.includes('学习偏好'), '块里的偏好行必须来自画像数据（不是写死的样板文字）')
})

/* ------------------------------------------------------------------ *
 * G20-6 无宿主路径
 * ------------------------------------------------------------------ */

test('G20-6 块里没有宿主路径（与 pi-bootstrap 的泄漏断言同款口径）', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, {
    recommendation: FAKE_RECOMMENDATION,
    fallbackStudentId: 'student_001'
  })
  assert.deepEqual(findHostPathLeaks(block), [], `学生情况块里出现了宿主路径（会真的发给云端模型）：\n${block}`)
})

/* ------------------------------------------------------------------ *
 * G20-7 strip 语义
 * ------------------------------------------------------------------ */

test('G20-7 strip 语义：不含块逐字返回；含块清干净（幂等的前提）', () => {
  assert.equal(stripStudentContext(GRADE_BASE), GRADE_BASE, '不含块时必须**逐字返回**（不动别人的 prompt）')
  assert.equal(stripStudentContext(''), '')

  const injected = withStudentContext(GRADE_BASE, renderStudentContextBlock(FAKE_PROFILE))
  const stripped = stripStudentContext(injected)
  assert.ok(!stripped.includes(STUDENT_CONTEXT_HEADING), '含块时必须清干净')
  assert.ok(stripped.includes(GRADE_OVERRIDE_HEADING), '★ 清块不能把排在后面的学段权威段一起切掉')
  assert.equal(stripStudentContext(stripped), stripped, 'strip 自身也要幂等')
})

/* ------------------------------------------------------------------ *
 * G20-8 ★ 与学段块的共存（真实踩过的风险）
 * ------------------------------------------------------------------ */

test('G20-8 ★ 共存：连续 3 轮「先学段、后学生情况」后两块各只剩一个', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, { recommendation: FAKE_RECOMMENDATION })

  let prompt = ''
  for (let round = 1; round <= 3; round += 1) {
    // 与 runtime.ts 的 buildSystemPrompt 同序：先学段（权威段拼在最末尾），再插学生情况块
    prompt = buildGradeSystemPrompt({ incoming: prompt, inferredGrade: 'primary_low' })
    prompt = withStudentContext(prompt, block)

    assert.equal(
      countOccurrences(prompt, STUDENT_CONTEXT_HEADING),
      1,
      `第 ${round} 轮学生块数量不是 1（块被学段拼装带进来了，或没清干净）`
    )
    assert.equal(
      countOccurrences(prompt, GRADE_OVERRIDE_HEADING),
      1,
      `第 ${round} 轮学段权威段数量不是 1 —— 学生块的 strip 把权威段一起切掉了（照抄「切到末尾」的经典回归）`
    )
  }
  assert.ok(prompt.indexOf(STUDENT_CONTEXT_HEADING) < prompt.indexOf(GRADE_OVERRIDE_HEADING), '顺序必须稳定')
})

/* ------------------------------------------------------------------ *
 * G20-9 冷启动（含真 HTTP：本机假服务端，不需要 uvicorn）
 * ------------------------------------------------------------------ */

test('G20-9 冷启动：预取 null 为空，但 404（新学生）给的是带标题的非空块', async () => {
  assert.equal(renderStudentContextBlock(null), '', '没有画像 → 不注入')

  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ detail: '还没有这个学生的记录' }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo

  try {
    configureSidecarEndpoint(port, 'test-token-student-context')
    const block = await fetchStudentContext('student_001')

    assert.ok(block.length > 0, '404（新学生）必须给一行冷启动提示，**不是空串**')
    assert.equal(
      countOccurrences(block, STUDENT_CONTEXT_HEADING),
      1,
      '★ 冷启动块必须**带标题**：没有标题，下一轮的 stripStudentContext 就清不掉它 → 一轮叠一块'
    )
    assert.ok(block.includes('第一次对话'), '提示要说清「这是第一次对话」，模型据此别急着上难度')
    assert.ok(
      requests.includes('GET /api/profile/student_001'),
      `请求没打到画像端点：${requests.join(' / ')}`
    )
  } finally {
    clearSidecarEndpoint()
    await new Promise<void>((done) => server.close(() => done()))
  }

  // 端点未配置（sidecar 不可用）→ 干净降级为空串，绝不阻断对话
  assert.equal(await fetchStudentContext('student_001'), '', 'sidecar 不可用时必须降级为空串（本轮照常对话）')
})

/* ------------------------------------------------------------------ *
 * G20-10 ★ 唯一出口（源码级守卫）
 * ------------------------------------------------------------------ */

const runtimeSource = stripComments(
  readFileSync(join(desktopRoot, 'src', 'main', 'agent', 'runtime.ts'), 'utf8')
).replace(/\r\n/g, '\n')

/** 取某个函数签名之后到「同级闭合大括号」之间的源码（够用来断言「这个调用在不在函数体内」）。 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `源码里找不到 ${signature}`)
  const end = source.indexOf('\n  }\n', start)
  return source.slice(start, end < 0 ? source.length : end)
}

test('G20-10 ★ 唯一出口：systemPromptFor( 全文件只剩 1 处，且在 buildSystemPrompt 内', () => {
  assert.ok(
    runtimeSource.includes('function buildSystemPrompt('),
    'runtime.ts 里找不到**唯一的** prompt 组装出口 buildSystemPrompt()'
  )

  const calls = countOccurrences(runtimeSource, 'systemPromptFor(')
  assert.equal(
    calls,
    1,
    `systemPromptFor( 在 runtime.ts 里出现 ${calls} 次 —— 它只允许出现在 buildSystemPrompt() 内部；` +
      '其余落点直接调它 = 某个落点会绕开「学段 + 学生情况」同一份文本（第一轮与后续轮不一致）'
  )

  const body = functionBody(runtimeSource, 'function buildSystemPrompt(')
  assert.ok(body.includes('systemPromptFor('), '唯一那次 systemPromptFor 调用必须就在 buildSystemPrompt 里')
  assert.ok(body.includes('withStudentContext('), 'buildSystemPrompt 必须同时拼学段与学生情况（同一份文本、同一个出口）')

  // 6 个落点 + 1 个定义（新增落点是允许的，所以只给下界；绕开出口才是回归）
  const total = countOccurrences(runtimeSource, 'buildSystemPrompt(')
  assert.ok(
    total >= 7,
    `buildSystemPrompt( 只出现 ${total} 次（期望 ≥ 7 = 1 个定义 + 6 个 prompt 落点）—— 有落点没走唯一出口`
  )
})

test('G20-10b ★ 预取顺序：画像预取唯一、且排在 reviewInput 与无 Key 早退之前', () => {
  const prefetchNeedle = 'studentContextBlock = await fetchStudentContext('
  const prefetchAt = runtimeSource.indexOf(prefetchNeedle)
  const reviewAt = runtimeSource.indexOf('await reviewInput(')
  const missingKeyAt = runtimeSource.indexOf('emitTerminal(sink, MISSING_KEY_MESSAGE)')

  assert.ok(prefetchAt >= 0, `找不到画像预取的落点（${prefetchNeedle}…）`)
  assert.ok(reviewAt >= 0, '找不到 reviewInput 调用点（输入侧安全检查）')
  assert.ok(missingKeyAt >= 0, '找不到「无 Key」早退点（emitTerminal(sink, MISSING_KEY_MESSAGE)）')

  // ★ 必须**恰好一处**：两处的话 `indexOf` 只会看到靠前的那处，
  //   于是「把预取整个挪到早退之后」会被一个残留的第二处（或在别处复用同一赋值）掩盖 —— 断言就名存实亡了。
  assert.equal(
    countOccurrences(runtimeSource, prefetchNeedle),
    1,
    `画像预取在 runtime.ts 里出现 ${countOccurrences(runtimeSource, prefetchNeedle)} 次 —— ` +
      '只允许 `runTurn()` 里那一处（多处会让「预取在早退之前」这条断言只看得到第一处，形同虚设）'
  )

  assert.ok(
    prefetchAt < reviewAt,
    '★ 预取必须排在 reviewInput **之前**：否则输入被拦截时落盘的 chat-system-prompt.txt ' +
      '与真正会发出去的那份不一致（那正是「唯一出口」要保证的事）'
  )
  assert.ok(
    prefetchAt < missingKeyAt,
    '★ 预取必须排在「无 Key」早退**之前**：否则无 Key 世界（本机现状）的提示词里永远没有画像，' +
      '而那条路径恰恰是验收证据的来源'
  )
})

/** 去掉注释，只留可执行代码（注释里**故意**引用 `pi.on(...)` / 旧写法来解释返工，不去注释会误判）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/**
 * 取**顶层**函数的完整函数体（靠大括号配对，不用缩进）。
 *
 * `functionBody` 认的是 `\n  }\n`（两空格缩进的闭合括号），那是给 `runtime.ts` 里
 * **嵌套在工厂内**的函数用的；顶层函数的第一处两空格闭合括号往往只是它内部某个 `if/else` 的结尾，
 * 会把函数体截断在中间（G21-6 第一版就是这么假红的）。
 */
function topLevelFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `源码里找不到 ${signature}`)
  // ★ 先跳过**参数表**再找函数体的起始大括号：形参上的类型标注（`options: { … } = {}`）
  //   自带一对大括号，直接从签名后找第一个 `{` 会当场配对成功、把函数体截成空串。
  const params = source.indexOf('(', start)
  assert.ok(params >= 0, `${signature} 后面找不到参数表`)
  let parens = 0
  let afterParams = -1
  for (let at = params; at < source.length; at += 1) {
    if (source[at] === '(') parens += 1
    else if (source[at] === ')') {
      parens -= 1
      if (parens === 0) {
        afterParams = at
        break
      }
    }
  }
  assert.ok(afterParams > 0, `${signature} 的参数表括号没有配对`)
  const open = source.indexOf('{', afterParams)
  assert.ok(open >= 0, `${signature} 后面找不到函数体的起始大括号`)
  let depth = 0
  for (let at = open; at < source.length; at += 1) {
    const char = source[at]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, at + 1)
    }
  }
  throw new Error(`${signature} 的大括号没有配对（源码被截断了？）`)
}

/* ------------------------------------------------------------------ *
 * G21 缓存前缀稳定性：块必须**逐字节稳定**
 *
 * 为什么单独立一组：这一组的失效**不会报错、不会崩溃**，只表现为「每轮都白白丢一次
 * 前缀缓存命中」—— 学生感觉到的是响应变慢，账单上是成本。而它的成因又极其不起眼
 * （块里混进一个每分钟都在变的时间戳）。所以既要有行为断言（同输入 → 逐字节相同），
 * 也要有反向对照（画像真变了 → 块**必须**变），否则「把块冻成常量」也能骗过测试。
 * ------------------------------------------------------------------ */

const CONTEXT_OPTIONS = {
  recommendation: FAKE_RECOMMENDATION,
  fallbackStudentId: 'student_001'
}

const profileSource = readFileSync(
  join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'profile.ts'),
  'utf8'
).replace(/\r\n/g, '\n')

test('G21-1 块里没有「现在几点」：时间字段与时间样式的串一个都不许进块', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, CONTEXT_OPTIONS)

  assert.ok(
    !block.includes('最近活跃'),
    '块里出现了「最近活跃」—— 它是**每轮都会变**的时间戳，会把 system prompt 连同其后全部对话历史一起踢出前缀缓存'
  )
  // 行为断言之外再加一道形态断言：防的是「换个写法把时间加回来」（改标题、换格式都躲不过）
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(block), `块里出现了日期样式的串（每轮变 → 缓存失效）：\n${block}`)
  assert.ok(!/\d{1,2}:\d{2}/.test(block), `块里出现了时间样式的串（每轮变 → 缓存失效）：\n${block}`)
  assert.ok(!/\d{10,}/.test(block), `块里出现了 Unix 时间戳样式的串（每轮变 → 缓存失效）：\n${block}`)
})

test('G21-2 ★ 同样的画像 → 逐字节相同的块（lastActiveAt 变了也不变）', () => {
  const once = renderStudentContextBlock(FAKE_PROFILE, CONTEXT_OPTIONS)
  const twice = renderStudentContextBlock(FAKE_PROFILE, CONTEXT_OPTIONS)
  assert.equal(once, twice, '同一份画像两次渲染必须逐字相等（渲染里混进了随机 / 时间 / 环境相关的东西？）')

  // ★ 反向对照的关键一条：把 lastActiveAt 换掉（模拟「每轮的活跃时间刷新」），块必须一模一样。
  //   这正是本次优化的**唯一**目标 —— 没有这条，「时间戳又加回来了」会静默通过。
  const laterActive = {
    ...FAKE_PROFILE,
    student: { ...FAKE_PROFILE.student, lastActiveAt: 1_760_000_000 }
  }
  assert.equal(
    renderStudentContextBlock(laterActive, CONTEXT_OPTIONS),
    once,
    '★ lastActiveAt 变化改变了块 —— 时间字段又进了给模型的那一段（前缀缓存每轮失效）'
  )
})

test('G21-3 偏好顺序不影响块：渲染顺序由 PREFERENCE_ORDER 钉死（不随 SQLite 行序漂）', () => {
  const ordered: Record<string, string> = {
    interest: '喜欢游戏',
    explain_style: '多举例子',
    pace: '慢一点',
    note: '喜欢被提问'
  }
  const reversed = Object.fromEntries(Object.entries(ordered).reverse())
  assert.notDeepEqual(Object.keys(ordered), Object.keys(reversed), '夹具本身要真的换了顺序，否则这条断言是空的')

  const base = { ...FAKE_PROFILE, preferences: ordered }
  const flipped = { ...FAKE_PROFILE, preferences: reversed }
  const a = renderStudentContextBlock(base, CONTEXT_OPTIONS)
  const b = renderStudentContextBlock(flipped, CONTEXT_OPTIONS)

  assert.equal(a, b, '偏好顺序变了块就变 —— 前缀缓存会因为「重写同一个键导致行序变化」而无谓地失效')
  // 排序器本身也要钉住：词表内的按 PREFERENCE_ORDER，词表外的排最后（将来扩词表时仍然确定）
  assert.deepEqual(
    orderPreferences({ note: 'n', interest: 'i', weird: 'w' }).map(([key]) => key),
    ['interest', 'note', 'weird'],
    'orderPreferences 必须把词表外的键排在最后（而不是抛错或插到中间）'
  )
  // 不只是「恰好一致」：确认落进块里的顺序就是 PREFERENCE_ORDER 的顺序
  const positions = PREFERENCE_ORDER.map((key) => a.indexOf(`${key}=`))
  assert.ok(positions.every((at) => at >= 0), `四个偏好键都必须在块里：${a}`)
  assert.deepEqual(
    [...positions].sort((x, y) => x - y),
    positions,
    `块里的偏好顺序必须是 PREFERENCE_ORDER（${PREFERENCE_ORDER.join(' / ')}），不是输入顺序：\n${a}`
  )
})

test('G21-4 掌握度平局不影响块：同分按 kpId 兜底排序（不靠调用方给的数组顺序）', () => {
  const tie = [
    { kpId: 'prog-variable-jr', score: 0.5, attempts: 1, correct: 1, lastSeenAt: 1_700_000_000 },
    { kpId: 'prog-list-jr', score: 0.5, attempts: 1, correct: 1, lastSeenAt: 1_700_000_000 }
  ]
  const a = renderStudentContextBlock({ ...FAKE_PROFILE, mastery: tie }, CONTEXT_OPTIONS)
  const b = renderStudentContextBlock({ ...FAKE_PROFILE, mastery: [...tie].reverse() }, CONTEXT_OPTIONS)

  assert.equal(a, b, '同分条目换了数组顺序块就变 —— 服务端换个 ORDER BY 就会让前缀缓存无谓失效')
  assert.ok(
    a.indexOf('prog-list-jr') < a.indexOf('prog-variable-jr'),
    `同分必须按 kpId 字典序（prog-list-jr 在 prog-variable-jr 前）：\n${a}`
  )
})

test('G21-5 ★ 反向对照：画像真的变了，块**必须**跟着变（不许把块冻成常量）', () => {
  const base = renderStudentContextBlock(FAKE_PROFILE, CONTEXT_OPTIONS)

  const higherScore = renderStudentContextBlock(
    {
      ...FAKE_PROFILE,
      mastery: FAKE_PROFILE.mastery!.map((item) =>
        item.kpId === 'prog-variable-jr' ? { ...item, score: 0.95 } : item
      )
    },
    CONTEXT_OPTIONS
  )
  assert.notEqual(higherScore, base, '掌握度变了块却不变 —— 个性化注入退化成常量了')

  const newPreference = renderStudentContextBlock(
    { ...FAKE_PROFILE, preferences: { ...FAKE_PROFILE.preferences, interest: '喜欢恐龙' } },
    CONTEXT_OPTIONS
  )
  assert.notEqual(newPreference, base, '新增偏好后块必须变（否则「模型写了偏好，下一轮就该按它讲」这条闭环断了）')
  assert.ok(newPreference.includes('interest=喜欢恐龙'), '新增的偏好必须真的出现在块里')

  const otherRecommendation = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    recommendation: { source: 'review', summary: '先回头把循环再练熟一点。', items: [] }
  })
  assert.notEqual(otherRecommendation, base, '推荐变了块必须变（它是「下一步学什么」的落点）')
})

test('G21-6 源码级：renderProfileText 不得再引用时间（防「改个写法把时间加回来」）', () => {
  const body = topLevelFunctionBody(profileSource, 'export function renderProfileText(')
  assert.ok(body.includes('lines.join'), '定位到的不是 renderProfileText 的函数体 —— 本测试的定位依据需要更新')

  for (const token of ['lastActiveAt', 'formatTimestamp', 'new Date', 'Date.now', 'toLocale']) {
    assert.ok(
      !body.includes(token),
      `renderProfileText 里出现了「${token}」—— 它渲染的块每轮都进 system prompt（前缀缓存最前面一段），` +
        '任何随时间变化的内容都会让整段前缀失效。真需要时间信息时，加一个**天级**字段并同步更新 G21 组。'
    )
  }
  // ★ 契约字段本身必须还在（我们只是不把它渲染进 prompt，不是删数据）
  assert.ok(
    profileSource.includes('lastActiveAt'),
    'ProfileResponse 的 lastActiveAt 不该被删 —— 它仍是契约字段（界面要用），只是不进给模型的那一段'
  )
})

/* ------------------------------------------------------------------ *
 * G22 错题摘要注入（与「学习档案 → 错题本」同一个端点）
 *
 * 为什么单独立一组：`senior.ts` 早就要求「错题要给变式题巩固」，而模型手里
 * 此前没有任何错题数据 —— 那条要求一直是悬空的。本组确认它接上了，
 * 同时**把 D-032 的三条纪律重跑一遍**（错题是新增进块的内容，最容易把时间带进来）。
 * ------------------------------------------------------------------ */

test('G22-1 错题摘要进了块：含知识点名与错次，且带「再出变式题」的指示', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: {
      studentId: 'student_001',
      items: [
        { kpId: 'prog-loop-jr', kpName: '循环：重复的事交给机器', wrongCount: 3 },
        { kpId: 'prog-variable-jr', kpName: '变量：给数据起名字', wrongCount: 1 }
      ],
      totalWrong: 4,
      withoutStem: 1
    }
  })

  assert.ok(
    block.includes('循环：重复的事交给机器（错 3 次）'),
    `块里应当有错题的知识点名与错次：\n${block}`
  )
  assert.ok(block.includes('错 3 次'), '应当出现错次（模型据此决定先照顾哪个）')
  assert.ok(block.includes('变式题'), '应当明确指示「再出变式题巩固」（对接 senior.ts 的既有要求）')
  // 错得多的排前面（锚在错题那一行上：知识点名在「推荐下一步」那行里也会出现）
  assert.ok(
    block.indexOf('循环：重复的事交给机器（错 3 次）') < block.indexOf('变量：给数据起名字（错 1 次）'),
    `错次多的应当排在前面：\n${block}`
  )
})

test('★ G22-2 错题那一行不放时间与题干（否则每轮都丢掉前缀缓存）', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: {
      studentId: 'student_001',
      items: [
        {
          kpId: 'prog-loop-jr',
          kpName: '循环：重复的事交给机器',
          wrongCount: 2,
          // 就算服务端把这两个字段一起给过来，也**不许**进块
          stem: '下面哪个循环是无限循环？',
          lastWrongAt: 1_760_000_000_000
        }
      ],
      totalWrong: 2,
      withoutStem: 0
    } as never
  })

  assert.ok(!block.includes('无限循环'), '题干不该进块（120 字的题干会挤掉教材上下文）')
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(block), '块里不该出现日期（G21-1 的形态断言同样适用）')
  assert.ok(!/\d{1,2}:\d{2}/.test(block), '块里不该出现时刻')
  assert.ok(!/\d{10,}/.test(block), `块里出现了长数字串（多半是时间戳）：\n${block}`)
})

test('★ G22-3 错题平局不影响块：同错次按 kpId 兜底排序', () => {
  const items = [
    { kpId: 'machine-learning-jr', kpName: '机器学习（ML）', wrongCount: 2 },
    { kpId: 'neural-network-jr', kpName: '神经网络', wrongCount: 2 }
  ]
  const first = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: { items, totalWrong: 4, withoutStem: 0 }
  })
  const reversed = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: { items: [...items].reverse(), totalWrong: 4, withoutStem: 0 }
  })

  assert.equal(first, reversed, '同错次换了数组顺序块就变 —— 服务端换个 ORDER BY 就会白白丢一次缓存')
  assert.ok(
    first.indexOf('机器学习（ML）') < first.indexOf('神经网络'),
    `同错次必须按 kpId 字典序：\n${first}`
  )
})

test('★ G22-4 反向对照：错题真的变了，块必须跟着变', () => {
  const base = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: {
      items: [{ kpId: 'prog-loop-jr', kpName: '循环：重复的事交给机器', wrongCount: 1 }],
      totalWrong: 1,
      withoutStem: 0
    }
  })
  const moreWrong = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: {
      items: [{ kpId: 'prog-loop-jr', kpName: '循环：重复的事交给机器', wrongCount: 5 }],
      totalWrong: 5,
      withoutStem: 0
    }
  })
  assert.notEqual(moreWrong, base, '错次变了块却不变 —— 「答错了要照顾」这条闭环断了')

  const anotherKp = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: {
      items: [{ kpId: 'prog-list-jr', kpName: '列表与字典：把一批数据放在一起', wrongCount: 1 }],
      totalWrong: 1,
      withoutStem: 0
    }
  })
  assert.notEqual(anotherKp, base, '换了一个错题知识点，块必须变')
  assert.ok(anotherKp.includes('列表与字典：把一批数据放在一起'))
})

test('G22-5 没有错题 / 取不到错题 → 不注入那一行（不产出空壳）', () => {
  const withoutMistakes = renderStudentContextBlock(FAKE_PROFILE, CONTEXT_OPTIONS)
  for (const empty of [null, undefined, {}, { items: [] }]) {
    const block = renderStudentContextBlock(FAKE_PROFILE, {
      ...CONTEXT_OPTIONS,
      mistakes: empty as never
    })
    assert.equal(block, withoutMistakes, `错题为 ${JSON.stringify(empty)} 时不该改变块（不注入空行）`)
  }
  assert.ok(!withoutMistakes.includes('变式题'), '没有错题时不该出现「再出变式题」的指示')
})

test('G22-6 错题最多注入三个知识点（块在每轮首位，不能挤掉教材上下文）', () => {
  const items = Array.from({ length: 8 }, (_unused, index) => ({
    kpId: `kp-${index}`,
    kpName: `知识点${index}`,
    wrongCount: 8 - index
  }))
  const block = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: { items, totalWrong: 36, withoutStem: 0 }
  })
  const listed = items.filter((item) => block.includes(item.kpName))
  assert.equal(listed.length, MISTAKE_INJECT_LIMIT, `应当只注入 ${MISTAKE_INJECT_LIMIT} 个（错次最高的那几个）`)
  assert.deepEqual(
    listed.map((item) => item.kpId),
    ['kp-0', 'kp-1', 'kp-2'],
    '注入的应当是错次最高的三个'
  )
})

test('G22-7 幂等仍成立：带错题的块重复拼装只出现一次', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: {
      items: [{ kpId: 'prog-loop-jr', kpName: '循环：重复的事交给机器', wrongCount: 2 }],
      totalWrong: 2,
      withoutStem: 0
    }
  })
  const once = withStudentContext(GRADE_BASE, block)
  const twice = withStudentContext(once, block)

  assert.equal(twice, once, '带错题的块也必须幂等（否则每轮叠一层）')
  assert.equal(once.split(STUDENT_CONTEXT_HEADING).length - 1, 1)
  assert.ok(once.includes(GRADE_OVERRIDE_HEADING), '学段权威段必须仍在（错题块插在它之前）')
})

test('G22-8 拿不到知识点名时退回 kpId（不假装有名，也不留空）', () => {
  const block = renderStudentContextBlock(FAKE_PROFILE, {
    ...CONTEXT_OPTIONS,
    mistakes: { items: [{ kpId: 'prog-loop-jr', wrongCount: 2 }], totalWrong: 2, withoutStem: 0 }
  })
  assert.ok(block.includes('prog-loop-jr'), `没有名字时应当退回 kpId：\n${block}`)
  assert.ok(block.includes('错 2 次'))
})

/* ------------------------------------------------------------------ *
 * G23 当前教材章节（软偏好）进块
 *
 * 章节是学生**显式选定**的一章（`chapter:set` 那条独立通道），它让回答与检索
 * 优先围绕本章 —— 但**不做 SQL 硬过滤**（学生问别的章节照常回答）。
 *
 * 为什么单独立一组：这是块里**唯一一段由学生自己决定的内容**，
 * 于是它天生带着两个风险 ——
 *   ① 位置漂移（谁是「第一行」会随写法变）→ 同样的画像渲染出不同的块；
 *   ② 顺手塞进「每轮都在变」的量（进度百分比、当前页、时间）→ 前缀缓存每轮失效。
 * 前者靠固定插入点挡住，后者靠 D-032 的形态断言挡住，两个方向都要有断言。
 * ------------------------------------------------------------------ */

/** 带章节的画像（在校章 = junior 第4章）。 */
const CHAPTER_PROFILE: ProfileResponse = {
  ...FAKE_PROFILE,
  student: { ...FAKE_PROFILE.student, currentChapter: '第4章 大模型与AI智能体Agent' }
}

const CHAPTER_LINE_HEAD = '- 当前教材章节：'
const TITLE_LINE_HEAD = '【学习画像 · 内部数据，不要整段念给学生听】学生：'

test('G23-1 ★ 章节行的位置固定：在标题行之后、掌握度之前', () => {
  const block = renderStudentContextBlock(CHAPTER_PROFILE, CONTEXT_OPTIONS)
  const titleAt = block.indexOf(TITLE_LINE_HEAD)
  const chapterAt = block.indexOf(CHAPTER_LINE_HEAD)
  const masteryAt = block.indexOf('- 掌握度（共')

  assert.ok(titleAt >= 0, '标题行不见了（块必须仍以标题起头，strip 靠它认块）')
  assert.ok(chapterAt >= 0, `章节行必须出现（学生选了章节，模型就该知道）：\n${block}`)
  assert.ok(masteryAt >= 0, `掌握度行不见了：\n${block}`)
  assert.ok(titleAt < chapterAt, `★ 章节行必须在标题行**之后**（它是块的内容，不是新的一段）:\n${block}`)
  assert.ok(chapterAt < masteryAt, `★ 章节行必须在掌握度**之前**（固定位置，不许随渲染顺序漂）:\n${block}`)

  // 位置是「紧跟标题行」而不仅是「在标题之后」—— 逐行确认（防有人把它挪到块末尾）。
  // 注意块首还有一行二级标题（`renderStudentContextBlock` 加的），所以是「标题行的下一行」。
  const lines = block.split('\n')
  const titleLine = lines.findIndex((line) => line.startsWith(TITLE_LINE_HEAD))
  assert.ok(titleLine >= 0, `块里找不到画像标题行：\n${block}`)
  assert.equal(
    lines[titleLine + 1],
    `${CHAPTER_LINE_HEAD}第4章 大模型与AI智能体Agent（回答与检索优先围绕本章；学生若问其他章节，照常回答）`,
    `★ 章节行必须是**紧跟标题行的那一行**（它是块的第二行正文），实际下一行是：${lines[titleLine + 1]}`
  )
})

test('G23-2 ★ 同画像两次渲染逐字相等（章节行不得引入任何不稳定的字节）', () => {
  const once = renderStudentContextBlock(CHAPTER_PROFILE, CONTEXT_OPTIONS)
  const twice = renderStudentContextBlock(CHAPTER_PROFILE, CONTEXT_OPTIONS)
  assert.equal(once, twice, '带章节的块两次渲染必须逐字相等（渲染里混进了随机 / 时间 / 环境相关的东西？）')

  // 章节两边的空白不该改变块（`renderProfileText` 内部 trim）
  const padded = renderStudentContextBlock(
    { ...CHAPTER_PROFILE, student: { ...CHAPTER_PROFILE.student, currentChapter: '  第4章 大模型与AI智能体Agent  ' } },
    CONTEXT_OPTIONS
  )
  assert.equal(padded, once, '首尾空白应当被 trim 掉（否则「同一章」会渲染出两种块）')
})

test('★ G23-3 反向对照：章节改了，块**必须**跟着变（不许把章节写死 / 忽略）', () => {
  const base = renderStudentContextBlock(CHAPTER_PROFILE, CONTEXT_OPTIONS)
  const another = renderStudentContextBlock(
    { ...CHAPTER_PROFILE, student: { ...CHAPTER_PROFILE.student, currentChapter: '第5章 人工智能主要应用领域' } },
    CONTEXT_OPTIONS
  )

  assert.notEqual(another, base, '章节换了块却不变 —— 学生选了章节，模型却还是按旧章讲（软偏好没接上）')
  assert.ok(another.includes('第5章 人工智能主要应用领域'), `新章节标题必须真的进块：\n${another}`)
  assert.ok(!another.includes('第4章 大模型与AI智能体Agent'), '旧章节标题不该还留在块里')
})

test('★ G23-4 无章节时：块与从前**逐字相等**（整行不出现，不是空行）', () => {
  const withoutChapter = renderStudentContextBlock(FAKE_PROFILE, CONTEXT_OPTIONS)

  for (const empty of [undefined, '', '   ']) {
    const block = renderStudentContextBlock(
      // eslint 风格的显式构造：模拟后端回空串 / 老版本回执里根本没有这个字段
      { ...FAKE_PROFILE, student: { ...FAKE_PROFILE.student, currentChapter: empty } },
      CONTEXT_OPTIONS
    )
    assert.equal(
      block,
      withoutChapter,
      `章节 = ${JSON.stringify(empty)} 时块必须与无章节时逐字相等（不许留下「- 当前教材章节：」空行）`
    )
  }

  assert.ok(!withoutChapter.includes(CHAPTER_LINE_HEAD), '没有章节时那一行**整行不出现**')
  // 非字符串（后端字段风格变了）也当作「未选择」，而不是渲染出一个 undefined
  const malformed = renderStudentContextBlock(
    { ...FAKE_PROFILE, student: { ...FAKE_PROFILE.student, currentChapter: 42 as never } },
    CONTEXT_OPTIONS
  )
  assert.equal(malformed, withoutChapter, '非字符串的章节必须当作「未选择」，不许原样拼进 Prompt')
})

test('★ G23-5 章节行里没有日期 / 时刻 / 长数字串（防有人把进度或时间塞进来）', () => {
  const block = renderStudentContextBlock(CHAPTER_PROFILE, CONTEXT_OPTIONS)

  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(block), `块里出现了日期样式（每轮变 → 前缀缓存失效）：\n${block}`)
  assert.ok(!/\d{1,2}:\d{2}/.test(block), `块里出现了时刻样式：\n${block}`)
  assert.ok(!/\d{10,}/.test(block), `块里出现了 Unix 时间戳样式的串：\n${block}`)
  assert.ok(!/%/.test(block), `块里出现了百分比（进度是每轮都在变的量，不许进块）：\n${block}`)

  // 正向：章节行本身只承载标题 + 那句「优先但不限」的口径，不多不少
  const chapterLine = block.split('\n').find((line) => line.startsWith(CHAPTER_LINE_HEAD)) ?? ''
  assert.equal(
    chapterLine,
    `${CHAPTER_LINE_HEAD}第4章 大模型与AI智能体Agent（回答与检索优先围绕本章；学生若问其他章节，照常回答）`,
    '章节行的文本模板是冻结的（改它等于换一种口径交给模型）'
  )
  assert.ok(!chapterLine.includes('学段'), '章标题已含学段语境，不要在章节行后面重复学段标签')
})
