/**
 * `compose_animation`（**按学生具体要求实时做动画**）的单测。
 *
 * 这个 Tool 与 `generate_animation` 共用同一套「生成 → 校验 → 重试 → 降级」实现，
 * 差别只有三处，而**恰恰就是这三处最容易写错**，所以这一份只盯它们：
 *
 *   C1 **复用优先**：命中已保存的那一份 → **模型一次都不被调用**，返回的就是库里那份；
 *   C2 **没命中就现做 + 存库**：生成跑起来，成功后**保存请求真的发出去了**；
 *   C3 ★ **复用是增强不是依赖**：保存 / 查库端点缺失或失败（404 / 500 / 抛异常）
 *      → 这一次照样返回可用的生成结果，**绝不抛**；
 *   C4 **无 Key（补全器拿不到实现）** → 可读中文失败 + 降级载荷，**绝不抛**；
 *   C5 ★ **重试额度与 `generate_animation` 互不消耗**（两个 Tool 各有一份 `MAX_RETRIES + 1`）；
 *   C6 **成功路径的 `source` 必须是 `generated`**（这条路径不问模板）。
 *
 * ★ 这个 Tool 的第三条纪律（复用命中时 `payload_id` 必须从产物里取回来）在 C7：
 *   取不回来时**宁可重新生成** —— 发一张永远收不到 ready 的卡片比多做一次更糟。
 *
 * 跑法：`node --test tests/animation-compose-tool.test.ts`
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HERE, '..')
void DESKTOP_ROOT

const animation = await import('../src/main/agent/extensions/animation.ts')
const index = await import('../src/main/agent/extensions/index.ts')

const {
  ANIMATION_SAVED_LOOKUP_PATH,
  ANIMATION_TOOL_NAME,
  COMPOSE_ANIMATION_TOOL_NAME,
  MAX_RETRIES,
  animationRequestHash,
  animationReuseKey,
  animationSavedPath,
  createAnimationExtension
} = animation

const { bindAgentSession } = index

/* ================================================================== *
 * 工具
 * ================================================================== */

/** 一次脚本化的假响应（假 sidecar 按调用序号逐个返回，用完最后一个就重复它）。 */
interface ScriptedResponse {
  status?: number
  body?: unknown
  /** `true` = 这次请求直接抛异常（模拟断网 / sidecar 没起来）。 */
  throws?: boolean
}

/**
 * 假 sidecar：**按路径分派**而不是按调用顺序。
 *
 * 为什么必须按路径（这是本文件与 `animation-extension.test.ts` 的假请求最大的不同）：
 *   这个 Tool 一次调用最多会打**三类**端点（`/saved/lookup` → `/compose` →
 *   `/saved/{id}`），而「保存失败但生成成功」这条分支恰恰要求**其中一条**失败、
 *   其余照常。按调用序号脚本化会让断言依赖时序，改一处顺序就整片红。
 */
function fakeRequester(plan: {
  lookup?: ScriptedResponse
  compose?: ScriptedResponse
  save?: ScriptedResponse
  /** 兜底：没在上面列出的路径一律用这份（默认 200 `{}`）。 */
  fallback?: ScriptedResponse
}): {
  request: (path: string, init?: RequestInit) => Promise<Response>
  calls: Array<{ path: string; init?: RequestInit; body: Record<string, unknown> }>
  pathsOf: (needle: string) => Array<{ path: string; init?: RequestInit; body: Record<string, unknown> }>
} {
  const calls: Array<{ path: string; init?: RequestInit; body: Record<string, unknown> }> = []
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      body = {}
    }
    calls.push({ path, init, body })

    const chosen = path.startsWith(ANIMATION_SAVED_LOOKUP_PATH)
      ? plan.lookup
      : /\/api\/animation\/saved\/[^/]+$/.test(path)
        ? plan.save
        : path === animation.ANIMATION_SAVED_LOOKUP_PATH
          ? plan.lookup
          : path.startsWith('/api/animation/compose')
            ? plan.compose
            : plan.fallback
    const scripted = chosen ?? { status: 200, body: {} }
    if (scripted.throws === true) throw new Error('假 sidecar 断了')
    const status = scripted.status ?? 200
    return new Response(JSON.stringify(scripted.body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  return {
    request,
    calls,
    pathsOf: (needle: string) => calls.filter((call) => call.path.includes(needle))
  }
}

/** 一份合法的动画载荷（`source: generated` —— 这条路径的产物不该冒充模板产物）。 */
function goodGeneratedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    concept: '循环',
    html:
      '<!DOCTYPE html><html><head><script>/* anime=e() */</script>' +
      // ★ 拼装器（`compose_animation_html`）注入的就是这一行：复用命中时要从这里读回 payload_id
      '<script>window.__K12_PAYLOAD_ID__ = "saved-payload-1";</script>' +
      '<script>window.Sandbox = {};</script><script>Sandbox.ready({});</script></head>' +
      '<body>payload_id<script>Sandbox.play(function () { return null })</script></body></html>',
    durationMs: 4200,
    fallbackText: '循环是让同一段动作重复执行，直到条件不再满足。',
    fallbackImage: 'data:image/svg+xml;base64,PHN2Zy8+',
    source: 'generated',
    ...overrides
  }
}

/** 抓一个注册好的 Tool（假 pi 只记录注册）。 */
function captureTools(extension: (pi: unknown) => void): Map<
  string,
  { name: string; parameters: unknown; execute: (toolCallId: string, params: unknown) => Promise<unknown> }
> {
  const tools = new Map<
    string,
    { name: string; parameters: unknown; execute: (toolCallId: string, params: unknown) => Promise<unknown> }
  >()
  extension({
    on: () => {},
    registerTool: (tool: {
      name: string
      parameters: unknown
      execute: (a: string, b: unknown) => Promise<unknown>
    }) => {
      tools.set(tool.name, { name: tool.name, parameters: tool.parameters, execute: tool.execute })
    }
  })
  return tools
}

/** 抓单个 Tool（断言「只注册了这一个」时用）。 */
function captureTool(extension: (pi: unknown) => void): {
  name: string
  parameters: unknown
  execute: (toolCallId: string, params: unknown) => Promise<unknown>
} {
  const tools = captureTools(extension)
  const tool = tools.get(COMPOSE_ANIMATION_TOOL_NAME)
  assert.ok(tool, `扩展必须注册 ${COMPOSE_ANIMATION_TOOL_NAME}`)
  return tool
}

function detailsOf(result: Record<string, unknown>): Record<string, unknown> {
  const details = result.details
  assert.ok(details && typeof details === 'object', '结果里必须有 details（事件层靠它发 payload）')
  return details as Record<string, unknown>
}

/** 固定学生上下文（身份来自主进程注入，模型改不了）。 */
function bindStudent(studentId = 'student_001', gradeLevel = 'junior'): void {
  bindAgentSession({ studentId, sessionId: 'sess-compose', gradeLevel: gradeLevel as 'junior' })
}

/** 一次生成成功的 `generate` 假实现（记录被调了几次）。 */
function countingGenerator(payload: Record<string, unknown> = goodGeneratedPayload()): {
  generate: (request: { attempt: number; payloadId: string }) => Promise<unknown>
  calls: Array<{ attempt: number; payloadId: string }>
} {
  const calls: Array<{ attempt: number; payloadId: string }> = []
  return {
    calls,
    generate: async (request: { attempt: number; payloadId: string }) => {
      calls.push({ attempt: request.attempt, payloadId: request.payloadId })
      return payload
    }
  }
}

/**
 * 跑一次 `compose_animation`。
 *
 * ⚠️ 每个用例**自己建一个扩展**（`createAnimationExtension`）：重试计数是 Extension 级
 *   局部 Map，跨用例复用同一个实例会把「上一次的重试」算到下一次头上。
 */
async function runCompose(
  params: Record<string, unknown>,
  options: {
    plan?: Parameters<typeof fakeRequester>[0]
    generate?: (request: { attempt: number; payloadId: string }) => Promise<unknown>
    retries?: number
    toolCallId?: string
    studentId?: string | null
  } = {}
): Promise<{
  result: Record<string, unknown>
  calls: ReturnType<typeof fakeRequester>['calls']
  pathsOf: ReturnType<typeof fakeRequester>['pathsOf']
}> {
  if (options.studentId === null) bindAgentSession(null)
  else bindStudent(options.studentId ?? 'student_001')

  const fake = fakeRequester(options.plan ?? {})
  const extension = createAnimationExtension({
    request: fake.request,
    ...(options.generate ? { generate: options.generate as never } : {}),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    log: () => {}
  })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  const result = (await tool.execute(
    options.toolCallId ?? 'compose-call-1',
    params
  )) as Record<string, unknown>
  return { result, calls: fake.calls, pathsOf: fake.pathsOf }
}

/* ================================================================== *
 * C1 复用优先：命中 → 模型一次都不被调用
 * ================================================================== */

test('C1 ★ 复用命中：不调用模型（生成器 0 次），返回的就是库里那一份', async () => {
  const generator = countingGenerator()
  const saved = goodGeneratedPayload({
    concept: '循环',
    // 库里那份带的是它**当初**的 payload_id：卡片必须用它才能收到沙箱的 ready
    html:
      '<!DOCTYPE html><html><head><script>window.__K12_PAYLOAD_ID__ = "saved-payload-1";</script>' +
      '<script>Sandbox.ready({});</script></head>' +
      '<body><script>Sandbox.play(function () { return null })</script></body></html>'
  })
  const { result, pathsOf } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    { plan: { lookup: { status: 200, body: saved } }, generate: generator.generate }
  )

  assert.equal(generator.calls.length, 0, '★ 复用命中时**一次模型调用都不该发生**（这是复用的全部意义）')
  const details = detailsOf(result)
  assert.equal(details.source, 'generated', '复用回来的产物仍然是「即时生成」那一类')
  assert.equal(details.concept, '循环')
  assert.equal(details.attempts, 0, '没做任何生成尝试')
  assert.equal(details.degradedFrom, null, '复用命中不是降级')
  // ★ payload_id 必须取回**库里那一份**的：发一个新 id 会让卡片永远收不到 ready
  assert.equal(details.payloadId, 'saved-payload-1')
  assert.equal(details.html, saved.html)

  // 复用命中**不该**再存一次（那只会覆盖掉同一份，白跑一次写盘）
  assert.equal(pathsOf('/saved/').length, 1, '只发了查库那一次请求')
  const content = result.content as Array<{ text: string }>
  assert.ok(content[0].text.includes('之前'), '给模型的说明要说清这次是复用，别让它说成「我刚做的」')
})

test('C1b 复用键：四维（学生 / 知识点 / 学段 / 请求指纹），且发出去的是摘要不是原话', async () => {
  const { calls } = await runCompose(
    { concept: '循环', request: '  想让  小球 一直绕圈跑  ', kpId: 'prog-loop-jr' },
    { plan: { lookup: { status: 404, body: { detail: '没有' } } } }
  )

  const lookup = calls.find((call) => call.path === ANIMATION_SAVED_LOOKUP_PATH)
  assert.ok(lookup, '必须发一次查库请求')

  // ① 请求体的形状：契约的四个 camelCase 字段（`AnimationSavedLookupRequest`）
  assert.deepEqual(Object.keys(lookup.body).sort(), ['gradeLevel', 'kpId', 'promptHash', 'studentId'])
  assert.equal(lookup.body.studentId, 'student_001', '学生 id 来自主进程注入')
  assert.equal(lookup.body.kpId, 'prog-loop-jr')
  assert.equal(lookup.body.gradeLevel, 'junior', '学段真值来自会话')

  // ② ★ 学生原话一个字都不进请求：只有指纹（十六进制摘要）
  assert.equal(lookup.body.promptHash, animationRequestHash('想让 小球 一直绕圈跑'))
  assert.match(String(lookup.body.promptHash), /^[0-9a-f]{40}$/, 'sha1 十六进制')
  assert.ok(
    !JSON.stringify(lookup.body).includes('小球'),
    '★ 学生原话不许出现在请求体里（promptHash 只收十六进制，见 contracts.py 的动画库段落）'
  )

  // ③ 归一化：首尾空格 / 连续空格 / 大小写不同 = **同一个要求**（否则复用永远命中不了）
  assert.equal(animationRequestHash('想让  小球 一直绕圈跑'), animationRequestHash('想让 小球 一直绕圈跑'))
  assert.equal(animationRequestHash(' Move  It '), animationRequestHash('move it'))
  // ④ 归一化只抹格式，不抹语义：换一句话就是另一个键
  assert.notEqual(animationRequestHash('想让小球绕圈跑'), animationRequestHash('想让小球弹起来'))

  // ⑤ 复用键是四维拼出来的（缺知识点时归一成 general，与托管路径同一口径）
  assert.equal(
    animationReuseKey({ studentId: 'student_001', kpId: '', gradeLevel: 'junior', request: '想让小球绕圈跑' }),
    `student_001|general|junior|${animationRequestHash('想让小球绕圈跑')}`
  )
})

/* ================================================================== *
 * C2 复用未命中 → 生成 → 保存
 * ================================================================== */

test('C2 ★ 复用未命中：生成跑起来，并且**真的发了保存请求**（断言保存调用发生过）', async () => {
  const generator = countingGenerator()
  const { result, calls, pathsOf } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑', kpId: 'prog-loop-jr' },
    {
      plan: {
        lookup: { status: 404, body: { detail: '库里没有' } },
        fallback: { status: 200, body: { id: 'saved-abc' } }
      },
      generate: generator.generate
    }
  )

  assert.equal(generator.calls.length, 1, '没命中就要现做一份')
  const details = detailsOf(result)
  assert.equal(details.source, 'generated')
  assert.equal(details.degradedFrom, null)
  assert.ok((details.attempts as number) >= 1)

  // ① 保存请求真的发了，落在该学生的路径上
  const save = calls.find((call) => call.path === animationSavedPath('student_001'))
  assert.ok(save, `必须调 ${animationSavedPath('student_001')} 保存这次的产物`)
  assert.equal(save.path, '/api/animation/saved/student_001')

  // ② 保存请求体的形状（`AnimationSaveRequest`，camelCase）：复用键 + 产物本体
  assert.equal(save.body.kpId, 'prog-loop-jr')
  assert.equal(save.body.gradeLevel, 'junior')
  assert.equal(save.body.concept, '循环')
  assert.equal(save.body.promptHash, animationRequestHash('想让小球一直绕圈跑'))
  assert.equal(save.body.html, details.html, '存的就是这次的产物本身')
  assert.equal(save.body.fallbackText, details.fallbackText)
  assert.equal(save.body.durationMs, details.durationMs)
  assert.ok(!JSON.stringify(save.body).includes('小球一直绕圈'), '原话不进保存请求（同一条合规纪律）')

  // ③ 顺序：先查库，再存（命中就不会走到保存；这里是未命中的正常链路）
  assert.ok(
    calls.findIndex((call) => call.path === ANIMATION_SAVED_LOOKUP_PATH) <
      calls.findIndex((call) => call.path === '/api/animation/saved/student_001'),
    '查库必须排在保存之前'
  )
  assert.equal(pathsOf('/api/animation/saved/').length, 2, '一次查 + 一次存')
})

test('C2b `reuseSaved: false`：**连查库都不发**（学生明确要求「重新做一个」）', async () => {
  const generator = countingGenerator()
  const { pathsOf } = await runCompose(
    { concept: '循环', request: '重新做一个小球跑圈的动画', reuseSaved: false },
    { plan: { fallback: { status: 200, body: { id: 'saved-x' } } }, generate: generator.generate }
  )
  assert.equal(pathsOf(ANIMATION_SAVED_LOOKUP_PATH).length, 0, '关掉复用就该跳过查询')
  assert.equal(generator.calls.length, 1, '直接现做')
})

test('C2c 没有绑定学生：跳过查库与保存，动画照样做得出来', async () => {
  // 学生没绑定时（冷启动 / 演示态）动画库无处可落：这是**正常状态**，不是失败。
  const generator = countingGenerator()
  const { pathsOf, result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    { studentId: null, generate: generator.generate, plan: { fallback: { status: 200, body: {} } } }
  )
  assert.equal(pathsOf('/api/animation/saved').length, 0, '不查也不存（一人一库，落不到具体人名下）')
  assert.equal(generator.calls.length, 1, '生成照常')
  assert.equal(detailsOf(result).html !== '', true, '产物仍然可用')
})

/* ================================================================== *
 * C3 复用是增强，不是依赖：保存 / 查库失败绝不影响出卡
 * ================================================================== */

test('C3 ★ 保存端点缺失（404）：这一次照样返回可用的生成产物，**不抛**', async () => {
  const generator = countingGenerator()
  const { result, pathsOf } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    {
      // 保存 404 = 端点还没落地（这正是并行开发期的形态）
      plan: { lookup: { status: 404, body: {} }, save: { status: 404, body: { detail: '没有这个接口' } } },
      generate: generator.generate
    }
  )
  assert.equal(pathsOf('/api/animation/saved/student_001').length, 1, '保存请求发过（失败了）')
  const details = detailsOf(result)
  assert.notEqual(details.error, true, '保存失败**不是**这次调用的失败')
  assert.equal(details.source, 'generated')
  assert.notEqual(details.html, '')
  assert.equal(details.degradedFrom, null, '产物是好的，就不是降级')
})

test('C3b 保存抛异常（sidecar 断了）：产物照样下发，绝不抛', async () => {
  const generator = countingGenerator()
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    { plan: { lookup: { status: 404 }, save: { throws: true } }, generate: generator.generate }
  )
  const details = detailsOf(result)
  assert.equal(details.source, 'generated')
  assert.notEqual(details.html, '')
  assert.notEqual(details.error, true)
})

test('C3c 查库抛异常（sidecar 没起来）：退化成「现做」，仍然出卡', async () => {
  const generator = countingGenerator()
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    { plan: { lookup: { throws: true }, fallback: { status: 200, body: {} } }, generate: generator.generate }
  )
  assert.equal(generator.calls.length, 1, '查库失败 = 没命中，接着现做')
  assert.equal(detailsOf(result).source, 'generated')
  assert.equal(detailsOf(result).degradedFrom, null)
})

test('C3d 保存 500：仍然返回生成产物（复用只影响「下次」，不影响「这次」）', async () => {
  const generator = countingGenerator()
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    { plan: { lookup: { status: 404 }, save: { status: 500, body: { detail: 'boom' } } }, generate: generator.generate }
  )
  assert.equal(detailsOf(result).html !== '', true)
  assert.equal(detailsOf(result).degradedFrom, null)
})

/* ================================================================== *
 * C4 无 Key / 生成器拿不出东西 → 可读中文 + 降级载荷，绝不抛
 * ================================================================== */

test('C4 ★ 生成器抛错（无 Key 的形态）：可读中文 + 降级载荷，**不发 error、不抛**', async () => {
  const { result, pathsOf } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    {
      plan: { lookup: { status: 404 } },
      // 生产路径上无 Key 时生成器就是这么拒的（`createAnimationGenerator` 的 complete=null 分支）
      generate: async () => {
        throw new Error('自由生成不可用：本机没有配置 API Key')
      }
    }
  )

  const details = detailsOf(result)
  // ① 不是失败形状：事件层据 details.error 发 error，降级不该走那条
  assert.notEqual(details.error, true, '降级是正常 payload，不是错误')
  // ② 降级载荷六字段语义正确（形状与 generate_animation 的降级一致）
  assert.equal(details.html, '', '降级产物的 html 必须为空（前端据此不建 iframe）')
  assert.equal(details.concept, '循环')
  // ★ 出处标成 generated：这条路径从头到尾不问模板，标 template 会让卡片显示「内置模板」
  assert.equal(details.source, 'generated', '这条路径的产物一律 generated（它不是模板产物）')
  assert.ok(typeof details.fallbackText === 'string' && (details.fallbackText as string).length > 0)
  assert.ok(
    typeof details.fallbackImage === 'string' && (details.fallbackImage as string).startsWith('data:image/svg+xml'),
    '必须有静态 SVG 兜底 —— 否则降级后只剩一行字'
  )
  assert.ok(
    typeof details.degradedFrom === 'string' && (details.degradedFrom as string).length > 0,
    '轨迹里要能看出为什么降级'
  )
  // ③ 渲染侧附加上要带主进程解析出来的学段
  assert.equal(details.gradeLevel, 'junior')
  // ④ ★ 降级产物**不入库**（库里只留能播的动画）
  assert.equal(
    pathsOf('/api/animation/saved/student_001').length,
    0,
    '降级产物（html 为空）不入动画库：存一份播不出来的东西没有意义'
  )
})

test('C4b 生成器返回 null（模型没接线）：降级，绝不抛', async () => {
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    { plan: { lookup: { status: 404 } }, generate: async () => null }
  )
  assert.equal(detailsOf(result).html, '')
  assert.equal(detailsOf(result).error, undefined)
  assert.ok((detailsOf(result).fallbackText as string).length > 0)
})

test('C4c ★ 连生成器都没有（默认工厂形态）：降级，绝不抛', async () => {
  // 默认导出就是 `createAnimationExtension()`（不接 generate）：这条路径下也必须兜住
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    { plan: { lookup: { status: 404 } } }
  )
  const details = detailsOf(result)
  assert.notEqual(details.error, true)
  assert.equal(details.html, '')
  assert.ok((details.fallbackText as string).length > 0)
  assert.ok((details.fallbackImage as string).startsWith('data:image/svg+xml'))
})

test('C4d 入参不合法（缺 concept / 缺 request）：可读失败形状，不消耗一次真实生成', async () => {
  for (const [params, keyword] of [
    [{}, '概念'],
    [{ concept: '循环' }, 'request'],
    [{ concept: '循环', request: '   ' }, 'request']
  ] as Array<[Record<string, unknown>, string]>) {
    const generator = countingGenerator()
    const { result, pathsOf } = await runCompose(params, { generate: generator.generate })
    const details = detailsOf(result)
    assert.equal(details.error, true, `入参 ${JSON.stringify(params)} 必须是失败形状`)
    assert.ok((details.message as string).includes(keyword), '失败文案要指出缺了什么')
    assert.equal(generator.calls.length, 0, '入参不合法时不消耗一次真实生成')
    assert.equal(pathsOf('/api/animation').length, 0, '也不该打任何 sidecar 端点')
  }
})

test('C4e execute() 绝不抛：怪参数一律收敛成可读结果', async () => {
  const extension = createAnimationExtension({
    request: async () => {
      throw new Error('boom')
    },
    generate: async () => {
      throw new Error('生成器也炸了')
    },
    log: () => {}
  })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  bindStudent()
  for (const params of [null, {}, { concept: 42 }, { concept: '循环', request: 7 }, { concept: '循环', request: 'x', reuseSaved: 'yes' }]) {
    const result = (await tool.execute('c', params)) as Record<string, unknown>
    assert.ok(result && typeof result === 'object', 'execute 必须返回结果对象')
    assert.ok(Array.isArray(result.content), '结果里必须有 content（Pi 的 Tool 返回形态）')
  }
})

/* ================================================================== *
 * C5 ★ 两个 Tool 的重试额度互不消耗
 * ================================================================== */

test('★ C5 两个 Tool 的重试额度互不消耗（各自 MAX_RETRIES + 1 次）', async () => {
  // 为什么这条重要：两个 Tool 由**同一个扩展**注册，重试计数是 Extension 级的 Map。
  // 只按 toolCallId 计数时两者共用一个命名空间，「另一个 Tool 试了 3 次」会让这一个
  // 少试几次（或反过来白多试）—— 一条路径的坏运气不该影响另一条的预算。
  const fake = fakeRequester({
    lookup: { status: 404 },
    // 模板渲染 404 = 没有匹配模板（不可重试）→ generate_animation 立刻转去自由生成，
    // 于是两个 Tool 都把额度花在**同一条自由生成路径**上，对比才有意义
    fallback: { status: 404, body: { detail: '没有模板' } }
  })
  let generateCalls = 0
  const extension = createAnimationExtension({
    request: fake.request,
    generate: async () => {
      generateCalls += 1
      throw new Error('生成失败')
    },
    log: () => {}
  })
  const tools = captureTools(extension as unknown as (pi: unknown) => void)

  bindStudent()
  const composeTool = tools.get(COMPOSE_ANIMATION_TOOL_NAME)
  const generateTool = tools.get(ANIMATION_TOOL_NAME)
  assert.ok(composeTool)
  assert.ok(generateTool)

  // ① 先跑 compose_animation，**用掉一个 toolCallId**：耗尽它自己的额度
  const first = (await composeTool.execute('shared-call-id', {
    concept: '循环',
    request: '想让小球一直绕圈跑'
  })) as Record<string, unknown>
  const composeAttempts = detailsOf(first).attempts as number
  assert.equal(composeAttempts, MAX_RETRIES + 1, `compose_animation 应恰好尝试 ${MAX_RETRIES + 1} 次`)
  const generateCallsAfterCompose = generateCalls
  assert.equal(generateCallsAfterCompose, MAX_RETRIES + 1)

  // ② 再跑 generate_animation（**同一个 toolCallId**）：它必须从自己的额度从头开始
  const second = (await generateTool.execute('shared-call-id', { concept: '循环' })) as Record<string, unknown>
  const generateAttempts = detailsOf(second).attempts as number
  assert.equal(
    generateAttempts,
    MAX_RETRIES + 1,
    '★ generate_animation 的尝试次数不许被 compose_animation 的重试吃掉（两个 Tool 各有一份额度）'
  )
  assert.ok(
    generateCalls - generateCallsAfterCompose > 0,
    '它自己的额度还够真去做自由生成（不是「一上来就说额度用尽」）'
  )

  // ③ 对照组：**同一个 toolCallId 只跑 generate_animation**（换一个全新的扩展实例，
  //    没有任何 compose_animation 的历史）—— 尝试次数必须**一模一样**。
  //    这一条才是「互不消耗」的直接判据：多跑一次别的 Tool 不改变它的预算。
  const control = fakeRequester({ fallback: { status: 404, body: { detail: '没有模板' } } })
  const controlExtension = createAnimationExtension({
    request: control.request,
    generate: async () => {
      throw new Error('生成失败')
    },
    log: () => {}
  })
  const controlTool = captureTools(controlExtension as unknown as (pi: unknown) => void).get(ANIMATION_TOOL_NAME)
  assert.ok(controlTool)
  const baseline = (await controlTool.execute('shared-call-id', { concept: '循环' })) as Record<string, unknown>
  assert.equal(
    detailsOf(baseline).attempts,
    generateAttempts,
    '★ 有没有先跑过 compose_animation，generate_animation 的预算必须完全一样'
  )

  // ④ 两条路径的降级产物形状一致（学生不该看出这是两个不同的 Tool 出的问题）
  assert.equal(detailsOf(first).html, '')
  assert.equal(detailsOf(second).html, '')
  for (const details of [detailsOf(first), detailsOf(second)]) {
    assert.ok((details.fallbackText as string).length > 0)
    assert.ok((details.fallbackImage as string).startsWith('data:image/svg+xml'))
  }
})

test('retries=0 时 compose_animation 只试一次（旋钮可调，上限语义不变）', async () => {
  let generateCalls = 0
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    {
      retries: 0,
      plan: { lookup: { status: 404 } },
      generate: async () => {
        generateCalls += 1
        return { concept: '循环' } // 字段不齐 → 不合格
      }
    }
  )
  assert.equal(generateCalls, 1)
  assert.equal(detailsOf(result).attempts, 1)
})

test('自由生成重试若成功，attempts 如实记录；重试序号从 0 开始', async () => {
  const attempts: number[] = []
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    {
      plan: { lookup: { status: 404 } },
      generate: async (request) => {
        attempts.push(request.attempt)
        if (request.attempt === 0) return goodGeneratedPayload({ html: '' }) // 不合格 → 重试
        return goodGeneratedPayload()
      }
    }
  )
  assert.deepEqual(attempts, [0, 1], '重试序号从 0 起，逐次 +1')
  assert.equal(detailsOf(result).attempts, 2)
  assert.notEqual(detailsOf(result).html, '')
})

/* ================================================================== *
 * C6 成功路径的 source 与 details 形状
 * ================================================================== */

test('★ C6 成功路径 source 恒为 generated（这条路径不问模板）', async () => {
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    {
      plan: { lookup: { status: 404 }, fallback: { status: 200, body: {} } },
      // 生成器**故意**回一个 source: template 的载荷（模型/服务端都可能回错）
      generate: async () => goodGeneratedPayload({ source: 'template' })
    }
  )
  assert.equal(
    detailsOf(result).source,
    'generated',
    '★ 自由生成这条路径的产物一律标成 generated —— 它不该冒充模板产物'
  )
})

test('C6b details 带齐渲染侧附加字段：payloadId / attempts / degradedFrom / gradeLevel', async () => {
  const { result } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    { plan: { lookup: { status: 404 }, fallback: { status: 200, body: {} } }, generate: countingGenerator().generate }
  )
  const details = detailsOf(result)
  assert.ok(typeof details.payloadId === 'string' && (details.payloadId as string).length > 0)
  assert.equal(typeof details.attempts, 'number')
  assert.equal(details.degradedFrom, null)
  assert.equal(details.gradeLevel, 'junior')
  // 契约的六个字段一个不少（前端卡片按它们渲染）
  for (const field of ['concept', 'html', 'durationMs', 'fallbackText', 'fallbackImage', 'source']) {
    assert.ok(field in details, `载荷缺字段 ${field}`)
  }
})

/* ================================================================== *
 * C7 复用命中的 payload_id 取不回来 → 宁可重新生成
 * ================================================================== */

test('★ C7 复用命中的产物里读不到 payload_id：改为重新生成（不发「永远等不到 ready」的卡片）', async () => {
  const generator = countingGenerator()
  const { result, calls } = await runCompose(
    { concept: '循环', request: '想让小球一直绕圈跑' },
    {
      plan: {
        // 库里那份是**旧版本拼装的**（没有 `window.__K12_PAYLOAD_ID__ = "…"` 那一行）
        lookup: { status: 200, body: goodGeneratedPayload({ html: '<html><body>旧产物</body></html>' }) },
        fallback: { status: 200, body: { id: 'saved-new' } }
      },
      generate: generator.generate
    }
  )
  assert.equal(generator.calls.length, 1, '取不回 id 就该重新生成，而不是发一张永远等不到 ready 的卡片')
  assert.notEqual(detailsOf(result).payloadId, 'saved-payload-1')
  assert.ok(
    calls.some((call) => call.path === animationSavedPath('student_001')),
    '重新生成的产物照样入库（它自己带 payload_id，是能播的）'
  )
})

/* ================================================================== *
 * C8 与 generate_animation 的边界：注册面与既有行为不被改坏
 * ================================================================== */

test('C8 扩展注册两个 Tool，且 generate_animation 的参数面**一个字没变**', () => {
  const extension = createAnimationExtension({ log: () => {} })
  const tools = captureTools(extension as unknown as (pi: unknown) => void)
  assert.deepEqual([...tools.keys()].sort(), ['compose_animation', 'generate_animation'])

  // generate_animation：只有 concept 必填（既有断言口径不变）
  const legacy = tools.get(ANIMATION_TOOL_NAME)
  assert.ok(legacy)
  assert.deepEqual((legacy.parameters as { required?: string[] }).required, ['concept'])

  // compose_animation：concept + request 必填（request 是这个 Tool 的存在理由）
  const compose = tools.get(COMPOSE_ANIMATION_TOOL_NAME)
  assert.ok(compose)
  assert.deepEqual((compose.parameters as { required?: string[] }).required, ['concept', 'request'])
  const props = (compose.parameters as { properties: Record<string, Record<string, unknown>> }).properties
  assert.deepEqual(
    Object.keys(props).sort(),
    ['caption', 'concept', 'gradeLevel', 'kpId', 'request', 'reuseSaved'],
    '参数面恰好这六个（与冻结口径逐字一致）'
  )
  assert.equal(props.request.maxLength, 200)
  assert.equal(props.request.minLength, 1)
  assert.equal(props.concept.maxLength, 40)
  assert.equal(props.reuseSaved.type, 'boolean')
  assert.equal(props.reuseSaved.default, true, '默认复用（undefined 也算开）')
  // ★ 没有模板参数：这条路径不问模板
  assert.equal('templateId' in props, false)
  assert.equal('params' in props, false)
})

test('C8b generate_animation 仍然是「模板优先」：模板命中时不生成、不查库，但**会存库**（D-088）', async () => {
  const generator = countingGenerator()
  const fake = fakeRequester({
    compose: { status: 200, body: goodGeneratedPayload() },
    lookup: { status: 200, body: goodGeneratedPayload() },
    // 模板路径命中
    fallback: { status: 200, body: goodGeneratedPayload({ source: 'template' }) }
  })
  const extension = createAnimationExtension({ request: fake.request, generate: generator.generate, log: () => {} })
  bindStudent()
  const tool = captureTools(extension as unknown as (pi: unknown) => void).get(ANIMATION_TOOL_NAME)
  assert.ok(tool)
  const result = (await tool.execute('legacy-1', { concept: '排序', kpId: 'prog-list-jr' })) as Record<string, unknown>

  assert.equal(detailsOf(result).source, 'template', '模板命中就该是 template（既有行为不变）')
  assert.equal(generator.calls.length, 0, '模板命中不调自由生成')
  // ★★ 2026-09-26（D-088）改写这条：**存库不再是 compose 的专属**。
  //   原来是「查/存动画库只属于 compose_animation」—— 后果是同一件事**走哪条 Tool 决定了它
  //   能不能留下**：学生用 `generate_animation` 看到一段动画，回头在「我的动画」里找不到，
  //   卡片上那个「我的」按钮也永远是灰的（它靠库里有匹配项才可点）。
  //   现在的口径（三条一起钉）：
  //     ① 模板命中**仍然不生成**（自由生成那条路一个字不动）；
  //     ② 模板命中**仍然不查复用**（这条路的产物是模板的确定性渲染，查库没有意义）；
  //     ③ 但**要存**：做出来就进该学生的动画库，与 compose 那条路一致。
  assert.equal(
    fake.pathsOf('/api/animation/saved/lookup').length,
    0,
    '★ 模板路径不查复用（产物是模板的确定性渲染，查库只会多一次往返）'
  )
  assert.equal(
    fake.pathsOf('/api/animation/saved').length,
    1,
    '★ 模板路径**要存库**（D-088）：学生看到的动画必须能在「我的动画」里找回来'
  )
  // 渲染侧附加上也带学段了（这次要求的唯一一处改动）
  assert.equal(detailsOf(result).gradeLevel, 'junior')
})
