/**
 * 票 16/17 的单测：**动画沙箱 + RPC + 模板优先 / 重试 / 降级**。
 *
 * 覆盖四块（每一块都对着票据里的一条验收口径）：
 *
 *   1. `sandbox/iframe-host.ts` —— 沙箱属性只有 `allow-scripts`（**绝无放开同源**）、
 *      每条消息带 `payload_id`、来源过滤（多卡片串台）、进度节流 ~10Hz、
 *      5s 无 `ready` 判超时、降级判定；
 *   2. `extensions/animation.ts` —— 模板优先 → 校验 → **重试硬上限 3** → 降级为
 *      正常 payload（**不发 error**）、六字段齐备、`execute()` 永不抛；
 *   3. 载荷投影的白名单（认不出的载荷退化成可读文案，不猜字段）；
 *   4. 静态纪律：生产代码里没有放开同源的属性、模板里没有外部引用、凭据不进 HTML。
 *
 * 跑法：`npm test`（`node --test` + 内置断言，不引入测试框架）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
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
const REPO_ROOT = resolve(DESKTOP_ROOT, '..')
const RENDERER_ROOT = join(DESKTOP_ROOT, 'src', 'renderer', 'src')
const TEMPLATES_ROOT = join(REPO_ROOT, 'server', 'resources', 'templates')

const sandbox = await import('../src/renderer/src/sandbox/iframe-host.ts')
const animation = await import('../src/main/agent/extensions/animation.ts')

const {
  AnimationSandboxHost,
  FORBIDDEN_SANDBOX_FLAG,
  HOST_COMMAND_TYPES,
  IFRAME_MESSAGE_TYPES,
  PROGRESS_THROTTLE_MS,
  READY_TIMEOUT_MS,
  SANDBOX_ATTRIBUTE,
  buildHostCommand,
  buildIframeAttributes,
  createProgressThrottle,
  findSandboxEscapes,
  readAnimationPayload,
  readLoopbackUrl,
  readSandboxMessage,
  shouldMountIframe
} = sandbox

const {
  ANIMATION_TOOL_NAME,
  MAX_RETRIES,
  buildInlineFallbackImage,
  createAnimationExtension,
  projectAnimationPayload,
  validateAnimationPayload
} = animation

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 造一个假的 sidecar：按脚本逐个返回响应（用完最后一个就重复它）。 */
function fakeRequester(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path, init })
    const index = Math.min(calls.length - 1, responses.length - 1)
    const scripted = responses[index] ?? { status: 200, body: {} }
    const status = scripted.status ?? 200
    return new Response(JSON.stringify(scripted.body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  return { calls, request }
}

/** 一份**合格**的动画载荷（Python 正常渲染时会给出这种形态）。 */
function goodPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const html = readFileSync(join(TEMPLATES_ROOT, 'sorting-bars.json'), 'utf8')
  void html
  return {
    concept: '排序',
    html:
      '<!DOCTYPE html><html><head><script>/* anime=e() */</script>' +
      '<script>window.Sandbox = {};</script><script>Sandbox.ready({});</script></head>' +
      '<body>payload_id<script>Sandbox.play(function () { return null })</script></body></html>',
    durationMs: 5200,
    fallbackText: '排序是反复比较相邻的两个数，左边的更大就交换。',
    fallbackImage: 'data:image/svg+xml;base64,PHN2Zy8+',
    source: 'template',
    ...overrides
  }
}

/** 抓一个注册好的 Tool（假 pi 只记录注册，不做任何别的事）。 */
function captureTool(extension: (pi: unknown) => void): {
  name: string
  parameters: unknown
  execute: (toolCallId: string, params: unknown) => Promise<unknown>
} {
  let captured: {
    name: string
    parameters: unknown
    execute: (toolCallId: string, params: unknown) => Promise<unknown>
  } | null = null
  extension({
    on: () => {},
    registerTool: (tool: { name: string; parameters: unknown; execute: (a: string, b: unknown) => Promise<unknown> }) => {
      captured = { name: tool.name, parameters: tool.parameters, execute: tool.execute }
    }
  })
  assert.ok(captured, '扩展必须注册一个 Tool')
  return captured
}

/** 跑一次 `generate_animation`（默认注入「一直返回好载荷」的假 sidecar）。 */
async function runTool(
  params: Record<string, unknown>,
  options: {
    responses?: Array<{ status?: number; body?: unknown }>
    retries?: number
    generate?: (request: { attempt: number }) => Promise<unknown>
    toolCallId?: string
  } = {}
): Promise<{ result: Record<string, unknown>; calls: Array<{ path: string; init?: RequestInit }> }> {
  const fake = fakeRequester(options.responses ?? [{ status: 200, body: goodPayload() }])
  const extension = createAnimationExtension({
    request: fake.request,
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.generate ? { generate: options.generate as never } : {}),
    log: () => {}
  })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  const result = (await tool.execute(options.toolCallId ?? 'call-1', params)) as Record<string, unknown>
  return { result, calls: fake.calls }
}

function detailsOf(result: Record<string, unknown>): Record<string, unknown> {
  const details = result.details
  assert.ok(details && typeof details === 'object', '结果里必须有 details（事件层靠它发 payload）')
  return details as Record<string, unknown>
}

/** 递归收集目录下指定后缀的文件。 */
function listFiles(root: string, extensions: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full)
    }
  }
  if (existsSync(root) && statSync(root).isDirectory()) walk(root)
  return found
}

/* ================================================================== *
 * 1. ★★ 沙箱纪律：只有 allow-scripts，绝无放开同源
 * ================================================================== */

test('★ 沙箱属性只有一个取值：allow-scripts（且不含放开同源那个开关）', () => {
  assert.equal(SANDBOX_ATTRIBUTE, 'allow-scripts')
  assert.ok(!SANDBOX_ATTRIBUTE.includes('same'), '沙箱属性里出现了 additional 放行 —— 沙箱会失效')
  // 属性装配也只给这一个 sandbox 值（没有第二处拼装）
  const attrs = buildIframeAttributes()
  assert.equal(Object.keys(attrs).filter((key) => key === 'sandbox').length, 1)
  assert.equal(attrs.sandbox, 'allow-scripts')
})

test('★ 生产代码里不出现「放开同源」那个属性名（渲染进程 + 动画模板都扫）', () => {
  // 判据来自生产模块自己的导出：这里断言它确实指向那个属性名
  assert.equal(FORBIDDEN_SANDBOX_FLAG, 'allow-same-origin', '守卫的判据本身必须是那个属性名')

  const rendererFiles = listFiles(RENDERER_ROOT, ['.ts', '.vue'])
  assert.ok(rendererFiles.length > 0, '渲染进程目录里没扫到文件，守卫形同虚设')

  const offenders: string[] = []
  for (const file of rendererFiles) {
    // 渲染进程源码里**连注释都不许出现**（注释同样会被 grep 证据命中）
    const hits = findSandboxEscapes(readFileSync(file, 'utf8'))
    for (const hit of hits) offenders.push(`${relative(DESKTOP_ROOT, file).replace(/\\/g, '/')} → ${hit}`)
  }
  assert.deepEqual(
    offenders,
    [],
    `生产代码里出现放开同源的沙箱开关：\n  ${offenders.join('\n  ')}\n` +
      '加上它，iframe 里的脚本就能读宿主 DOM / localStorage —— 沙箱当场形同虚设。'
  )

  // 动画模板（会被内联进沙箱文档）同样不许出现
  const templateFiles = listFiles(TEMPLATES_ROOT, ['.json', '.js', '.css'])
  assert.ok(templateFiles.length > 0, '模板目录里没扫到文件，守卫形同虚设')
  const templateOffenders = templateFiles
    .filter((file) => findSandboxEscapes(readFileSync(file, 'utf8')).length > 0)
    .map((file) => relative(REPO_ROOT, file).replace(/\\/g, '/'))
  assert.deepEqual(
    templateOffenders,
    [],
    `动画模板里出现放开同源的沙箱开关：${templateOffenders.join('、')}`
  )
})

/* ================================================================== *
 * 2. RPC：payload_id 是每条消息的必填项（串台防线）
 * ================================================================== */

test('RPC 指令词表与业务陷阱清单一致（7 条，两个方向）', () => {
  assert.deepEqual([...IFRAME_MESSAGE_TYPES], ['ready', 'progress', 'error'])
  assert.deepEqual([...HOST_COMMAND_TYPES], ['play', 'pause', 'replay', 'timeout'])
})

test('消息解析：缺 payload_id 或指令名不认识一律忽略（不抛异常）', () => {
  assert.equal(readSandboxMessage(null), null)
  assert.equal(readSandboxMessage('hello'), null)
  assert.equal(readSandboxMessage({ type: 'ready' }), null, '缺 payload_id 必须丢弃')
  assert.equal(readSandboxMessage({ type: 'unknown-type', payload_id: 'a' }), null)
  assert.equal(readSandboxMessage({ type: 'ready', payload_id: '' }), null)
  const ok = readSandboxMessage({ type: 'ready', payload_id: 'a' })
  assert.equal(ok?.type, 'ready')
  assert.equal(ok?.payloadId, 'a')
})

test('消息解析：progress 收敛到 0..1；error 文案截断；ready 只留结构性字段', () => {
  assert.equal(readSandboxMessage({ type: 'progress', payload_id: 'a', progress: 2 })?.progress, 1)
  assert.equal(readSandboxMessage({ type: 'progress', payload_id: 'a', progress: -1 })?.progress, 0)
  assert.equal(readSandboxMessage({ type: 'progress', payload_id: 'a', progress: 'x' })?.progress, 0)

  const long = 'x'.repeat(500)
  assert.equal(readSandboxMessage({ type: 'error', payload_id: 'a', message: long })?.message?.length, 200)

  const ready = readSandboxMessage({
    type: 'ready',
    payload_id: 'a',
    detail: { template: 'sorting-bars', bars: 6, html: long, nested: { a: 1 } }
  })
  assert.deepEqual(ready?.detail, { template: 'sorting-bars', bars: 6 }, 'ready 里不该带长正文与嵌套对象')
})

test('★ 宿主 → 沙箱的每条指令都带 payload_id', () => {
  for (const type of HOST_COMMAND_TYPES) {
    const command = buildHostCommand(type, 'pid-42')
    assert.equal(command.payload_id, 'pid-42', `${type} 指令必须带 payload_id`)
    assert.equal(command.type, type)
  }
})

/* ================================================================== *
 * 3. ★★ 多卡片串台：来源与 payload_id 两道过滤
 * ================================================================== */

/** 造一个假 iframe（只要 contentWindow 能收 postMessage）。 */
function fakeFrame(): { contentWindow: { postMessage: (m: unknown, o: string) => void }; sent: unknown[] } {
  const sent: unknown[] = []
  return {
    sent,
    contentWindow: {
      postMessage: (message: unknown) => {
        sent.push(message)
      }
    }
  }
}

/** 造一个假事件（source 指向某个 iframe 的 contentWindow）。 */
function frameEvent(frame: { contentWindow: unknown }, data: unknown): { source: unknown; data: unknown } {
  return { source: frame.contentWindow, data }
}

test('★ 串台防线：另一张卡片的 payload_id 到不了本卡片（同屏多卡片交替播放）', () => {
  const cardA = fakeFrame()
  const cardB = fakeFrame()
  const seenA: number[] = []
  const seenB: number[] = []

  const hostA = new AnimationSandboxHost({
    payloadId: 'payload-A',
    onProgress: (value) => seenA.push(value),
    log: () => {}
  })
  const hostB = new AnimationSandboxHost({
    payloadId: 'payload-B',
    onProgress: (value) => seenB.push(value),
    log: () => {}
  })
  hostA.attach(cardA)
  hostB.attach(cardB)

  // 两张卡片交替播各自的进度（都是广播到同一个 window 的消息）
  let now = 0
  hostA.useClock(() => now)
  hostB.useClock(() => now)
  for (let round = 0; round < 5; round += 1) {
    now += 200
    hostA.handleMessage(frameEvent(cardA, { type: 'progress', payload_id: 'payload-A', progress: round / 10 }))
    hostB.handleMessage(frameEvent(cardB, { type: 'progress', payload_id: 'payload-B', progress: 0.5 + round / 20 }))
  }

  assert.equal(seenA.length, 5, 'A 卡片应收到 5 条自己的进度')
  assert.equal(seenB.length, 5, 'B 卡片应收到 5 条自己的进度')
  // ★ 互不污染：A 收到的是自己的值，B 也是
  assert.deepEqual(seenA, [0, 0.1, 0.2, 0.3, 0.4])
  assert.deepEqual(seenB.map((value) => Number(value.toFixed(2))), [0.5, 0.55, 0.6, 0.65, 0.7])

  // 交叉投递（把 A 的消息喂给 B）：必须被过滤掉
  const beforeB = seenB.length
  assert.equal(
    hostB.handleMessage(frameEvent(cardB, { type: 'progress', payload_id: 'payload-A', progress: 0.99 })),
    false,
    'B 必须丢弃 payload_id 不属于自己的消息'
  )
  assert.equal(seenB.length, beforeB, '被丢弃的消息不许触发回调')
  assert.ok(hostB.filteredMessages >= 1, '丢弃计数要能看见（诊断用）')

  // 来源不对（消息来自另一张卡片的 iframe）：同样丢弃
  // —— 这一条打的是 `event.source` 那道过滤，与 payload_id 那道是**两层**。
  const fromOtherFrame = hostA.handleMessage(
    frameEvent(cardB, { type: 'progress', payload_id: 'payload-A', progress: 0.8 })
  )
  assert.equal(fromOtherFrame, false, '来源不是自己的 iframe，必须丢弃（哪怕 payload_id 对得上）')
  assert.equal(seenA.length, 5, '被来源过滤挡下的消息不许触发回调')
})

test('★ 串台防线：ready 也只认自己的 payload_id（否则两张卡片会同时显示就绪）', () => {
  const cardA = fakeFrame()
  const readyA: string[] = []
  const hostA = new AnimationSandboxHost({
    payloadId: 'payload-A',
    onReady: (_detail, id) => readyA.push(id),
    log: () => {}
  })
  hostA.attach(cardA)

  // 另一张卡片（payload-B）的 ready 广播到了同一个 window：本卡片必须无视它
  hostA.handleMessage(frameEvent(cardA, { type: 'ready', payload_id: 'payload-B' }))
  assert.deepEqual(readyA, [], '别人的 ready 不算自己的')
  assert.equal(hostA.phase, 'loading')

  hostA.handleMessage(frameEvent(cardA, { type: 'ready', payload_id: 'payload-A', detail: { template: 'sorting-bars' } }))
  assert.deepEqual(readyA, ['payload-A'])
  assert.equal(hostA.phase, 'ready')
  assert.deepEqual(hostA.readyInfo, { template: 'sorting-bars' })
})

/* ================================================================== *
 * 4. 进度节流到 ~10Hz（1 秒 ≤ 12 条）
 * ================================================================== */

test('★ 进度节流：1 秒内收到的 progress 回调 ≤ 12 条', () => {
  const throttle = createProgressThrottle(PROGRESS_THROTTLE_MS)
  let passed = 0
  // 沙箱每秒最多发 60 条（60fps 的每一帧都发），宿主侧必须挡住
  for (let ms = 0; ms < 1000; ms += 16) {
    if (throttle.allow(ms)) passed += 1
  }
  assert.ok(
    passed <= 12,
    `1 秒内放行了 ${passed} 条（上限 12 条 ≈ 10Hz）—— 高频 postMessage 会把界面卡住`
  )
  assert.ok(passed >= 8, `放行太少（${passed} 条）：节流过头会让进度条看起来卡住`)
  assert.ok(throttle.dropped > 0, '被丢掉的条数要能看见（诊断用）')
})

test('★ 宿主侧进度节流：跑 1 秒的帧序列，最终回调数 ≤ 12 且进度单调不减', () => {
  const frame = fakeFrame()
  const values: number[] = []
  const host = new AnimationSandboxHost({
    payloadId: 'p1',
    onProgress: (value) => values.push(value),
    log: () => {}
  })
  let now = 0
  host.useClock(() => now)
  host.attach(frame)
  host.handleMessage(frameEvent(frame, { type: 'ready', payload_id: 'p1' }))

  for (let ms = 0; ms <= 1000; ms += 16) {
    now = ms
    host.handleMessage(frameEvent(frame, { type: 'progress', payload_id: 'p1', progress: Math.min(1, ms / 1000) }))
  }

  assert.ok(values.length <= 12, `1 秒内回调 ${values.length} 条，超过 12 条上限`)
  assert.equal(host.receivedProgress, 63, '宿主应记录收到了多少条原始消息（0..1000 每 16ms 一帧 = 63 帧）')
  assert.equal(host.droppedProgress, host.receivedProgress - values.length)
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] >= values[i - 1], '进度不许倒退')
  }
})

/* ================================================================== *
 * 5. ★ 5s 无 ready → 超时 → 降级（不白屏）
 * ================================================================== */

test('★ 5s 没收到 ready 判超时：发 timeout 指令 + 通知宿主降级', async () => {
  const frame = fakeFrame()
  const timeouts: string[] = []
  const host = new AnimationSandboxHost({
    payloadId: 'p-timeout',
    readyTimeoutMs: 40, // 单测里把 5s 压到 40ms（常量本身的取值由下一条断言守住）
    onTimeout: (id) => timeouts.push(id),
    log: () => {}
  })
  host.attach(frame)
  assert.equal(host.phase, 'loading')

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 90))

  assert.equal(host.phase, 'timed-out')
  assert.deepEqual(timeouts, ['p-timeout'], '宿主必须被通知去渲染降级视图')
  assert.deepEqual(
    frame.sent,
    [{ type: 'timeout', payload_id: 'p-timeout' }],
    '必须先给沙箱发一条 timeout（让它停掉），且带上 payload_id'
  )
})

test('ready 先到则不再超时（计时器被清掉）', async () => {
  const frame = fakeFrame()
  let timedOut = false
  const host = new AnimationSandboxHost({
    payloadId: 'p-ok',
    readyTimeoutMs: 40,
    onTimeout: () => {
      timedOut = true
    },
    log: () => {}
  })
  host.attach(frame)
  host.handleMessage(frameEvent(frame, { type: 'ready', payload_id: 'p-ok' }))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 90))
  assert.equal(timedOut, false, 'ready 之后不该再判超时')
  assert.equal(host.phase, 'ready')
  assert.deepEqual(frame.sent, [], '没有超时就不该发 timeout')
})

test('默认超时就是 5 秒（业务陷阱清单的原文取值）', () => {
  assert.equal(READY_TIMEOUT_MS, 5000)
})

test('沙箱自报 error → 宿主进入降级（同样不白屏）', () => {
  const frame = fakeFrame()
  const errors: string[] = []
  const host = new AnimationSandboxHost({
    payloadId: 'p-err',
    onError: (message) => errors.push(message),
    log: () => {}
  })
  host.attach(frame)
  host.handleMessage(frameEvent(frame, { type: 'error', payload_id: 'p-err', message: 'boom' }))
  assert.equal(host.phase, 'error')
  assert.deepEqual(errors, ['boom'])
})

test('dispose 之后计时器不再响（卡片被移除后不该再回调）', async () => {
  const frame = fakeFrame()
  let timedOut = false
  const host = new AnimationSandboxHost({
    payloadId: 'p-dispose',
    readyTimeoutMs: 30,
    onTimeout: () => {
      timedOut = true
    },
    log: () => {}
  })
  host.attach(frame)
  host.dispose()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
  assert.equal(timedOut, false, 'dispose 后超时计时器必须被清掉')
})

test('iframe 还没挂上时发指令返回 false（调用方据此走降级，而不是静默失败）', () => {
  const host = new AnimationSandboxHost({ payloadId: 'p-noframe', log: () => {} })
  assert.equal(host.post('play'), false)
})

/* ================================================================== *
 * 6. ★★ 模板优先 → 校验 → 重试 ≤3 → 降级（重试写在 execute() 内部）
 * ================================================================== */

test('模板优先：命中时直接返回 template 载荷，且只调一次 /api/animation/render', async () => {
  const { result, calls } = await runTool({ concept: '排序', kpId: 'prog-list-jr' })
  const details = detailsOf(result)
  assert.equal(details.source, 'template')
  assert.equal(details.concept, '排序')
  assert.equal(details.attempts, 1, '模板命中不该有重试')
  assert.equal(calls.filter((call) => call.path === '/api/animation/render').length, 1)
  // 给模型看的文本：让它别把解说词念一遍
  const content = result.content as Array<{ text: string }>
  assert.ok(content[0].text.includes('动画'), '要么提示已显示动画卡片')
  assert.ok(!content[0].text.includes('<'), '正文里不许出现 HTML')
})

test('★ 校验不过（422）→ 重试，重试次数**硬上限 3**（首次 + 3 次重试 = 4 次调用）', async () => {
  const { result, calls } = await runTool(
    { concept: '排序', kpId: 'prog-list-jr' },
    { responses: [{ status: 422, body: { detail: '模板脚本里有 throw' } }] }
  )
  // 4 次渲染尝试 + 0 次托管（降级产物不托管）
  const renderCalls = calls.filter((call) => call.path === '/api/animation/render')
  assert.equal(renderCalls.length, MAX_RETRIES + 1, `渲染调用数应为 ${MAX_RETRIES + 1}（首次 + 重试 ${MAX_RETRIES}）`)

  const details = detailsOf(result)
  assert.equal(details.attempts, MAX_RETRIES + 1, 'details.attempts 要如实记录尝试了几次')
})

test('★ 3 次仍失败 → **降级为正常 payload（不发 error）**：文字 + 静态图都在', async () => {
  const { result } = await runTool(
    { concept: '排序', kpId: 'prog-list-jr', caption: '看左边的柱子怎么一点点挪到位置。' },
    { responses: [{ status: 422, body: { detail: '模板脚本里有 throw' } }] }
  )

  // ① 不是失败形状（事件层据此发 payload 而不是 error）
  const details = detailsOf(result)
  assert.notEqual(details.error, true, '降级不是错误：unable 走 error 的话 UI 会把后半段正文丢掉')
  assert.notEqual(details.ok, false)

  // ② 六字段语义正确
  assert.equal(details.html, '', '降级产物的 html 必须为空（前端据此不建 iframe）')
  assert.equal(details.concept, '排序')
  assert.equal(details.source, 'template')
  assert.equal(details.fallbackText, '看左边的柱子怎么一点点挪到位置。', '模板降级文案被模型写的一句话覆盖')
  assert.ok(
    typeof details.fallbackImage === 'string' && details.fallbackImage.startsWith('data:image/svg+xml'),
    '必须有可用的静态 SVG dataURL —— 否则降级后只剩一行字'
  )
  assert.ok(typeof details.degradedFrom === 'string' && (details.degradedFrom as string).length > 0, '轨迹里要能看出为什么降级')

  // ③ 前端投影后仍然是一张能显示的卡片
  const view = readAnimationPayload(details)
  assert.equal(view.html, '')
  assert.equal(shouldMountIframe(view.html), false, '降级产物不建 iframe（少一次必然失败的加载）')
  assert.ok(view.fallbackText.length > 0)
  assert.ok(view.fallbackImage !== null)
})

test('模板未命中（404）→ 不浪费重试，直接降级', async () => {
  const { result, calls } = await runTool(
    { concept: '不存在的概念', kpId: 'invented-kp-xyz' },
    { responses: [{ status: 404, body: { detail: '没有覆盖知识点的模板' } }] }
  )
  const renderCalls = calls.filter((call) => call.path === '/api/animation/render')
  assert.equal(renderCalls.length, 1, '404 表示「再试也一样」，不该重试')
  assert.equal(detailsOf(result).html, '')
  assert.ok(
    typeof detailsOf(result).fallbackText === 'string' && (detailsOf(result).fallbackText as string).length > 0
  )
})

test('sidecar 不可用 → 降级（且不发 error），界面仍然有文字可看', async () => {
  const failing = async (): Promise<Response> => {
    throw new Error('sidecar 尚未就绪（无端口与 token）')
  }
  const extension = createAnimationExtension({ request: failing, log: () => {} })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  const result = (await tool.execute('call-x', { concept: '循环', kpId: 'prog-loop-jr' })) as Record<string, unknown>
  const details = detailsOf(result)
  assert.notEqual(details.error, true)
  assert.equal(details.html, '')
  assert.ok((details.fallbackText as string).length > 0)
  assert.ok((details.fallbackImage as string).startsWith('data:image/svg+xml'))
})

test('★ 重试计数用 Extension 内的 Map，**同一个 toolCallId 累计、不同调用互不影响**', async () => {
  const { result } = await runTool(
    { concept: '排序', kpId: 'prog-list-jr' },
    { responses: [{ status: 422, body: { detail: 'boom' } }], toolCallId: 'call-A' }
  )
  const details = detailsOf(result)
  // 每次重试都会记一次（3 次重试 → attempts = 4）
  assert.equal(details.attempts, 4)

  // 另一次调用（不同 toolCallId）从 0 重新计：不会因为上一张卡片重试过就少试几次
  const second = await runTool(
    { concept: '循环', kpId: 'prog-loop-jr' },
    { responses: [{ status: 422, body: { detail: 'boom' } }], toolCallId: 'call-B' }
  )
  assert.equal(detailsOf(second.result).attempts, 4)
})

test('retries=0 时只试一次（旋钮可调，但上限语义不变）', async () => {
  const { calls } = await runTool(
    { concept: '排序' },
    { responses: [{ status: 422, body: { detail: 'boom' } }], retries: 0 }
  )
  assert.equal(calls.filter((call) => call.path === '/api/animation/render').length, 1)
})

test('自由生成是**补充路径**：模板命中时完全不调用它', async () => {
  let generated = 0
  const { result } = await runTool(
    { concept: '排序', kpId: 'prog-list-jr' },
    {
      generate: async () => {
        generated += 1
        return goodPayload({ source: 'generated' })
      }
    }
  )
  assert.equal(generated, 0, '模板命中就不该走自由生成（模板优先）')
  assert.equal(detailsOf(result).source, 'template')
})

test('自由生成路径：模板未命中时启用，通过校验后 source=generated', async () => {
  const { result } = await runTool(
    { concept: '自定义概念', kpId: 'invented-kp' },
    {
      responses: [{ status: 404, body: { detail: '没有模板' } }],
      generate: async () => goodPayload({ source: 'generated', concept: '自定义概念' })
    }
  )
  const details = detailsOf(result)
  assert.equal(details.source, 'generated', '自由生成的产物必须标成 generated')
  assert.notEqual(details.html, '')
})

test('自由生成也失败 → 降级（重试同样受上限约束）', async () => {
  let attempts = 0
  const { result } = await runTool(
    { concept: '自定义概念', kpId: 'invented-kp' },
    {
      responses: [{ status: 404, body: { detail: '没有模板' } }],
      generate: async () => {
        attempts += 1
        return { concept: '自定义概念' } // 字段不齐
      }
    }
  )
  assert.ok(attempts <= MAX_RETRIES + 1, `自由生成尝试 ${attempts} 次，超过上限`)
  assert.equal(detailsOf(result).html, '')
  assert.ok((detailsOf(result).fallbackText as string).length > 0)
})

/* ================================================================== *
 * 7. execute() 永不抛 + 入参校验
 * ================================================================== */

test('★ execute() 绝不抛异常：连假 sidecar 抛的怪东西也被收敛成可读结果', async () => {
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
  // 不给概念 / 给怪值 / 空对象：三种都不许抛
  for (const params of [{}, { concept: '   ' }, { concept: '排序', params: 'not-an-object' }, { concept: 42 }]) {
    const result = (await tool.execute('c', params)) as Record<string, unknown>
    assert.ok(result && typeof result === 'object', 'execute 必须返回结果对象')
    assert.ok(Array.isArray(result.content), '结果里必须有 content（Pi 的 Tool 返回形态）')
  }
})

test('缺 concept → 可读失败（统一失败形状，事件层据此发 error）', async () => {
  const { result } = await runTool({})
  const details = detailsOf(result)
  assert.equal(details.error, true, '失败必须是 details.error === true（布尔，事件层只认这个）')
  assert.equal(details.ok, false)
  assert.equal(details.degraded, true)
  assert.ok(typeof details.message === 'string' && (details.message as string).includes('概念'))
})

test('生成的 HTML 里有外部引用 → 校验不通过 → 重试（CDN 在断网演示里必然白屏）', async () => {
  const { result, calls } = await runTool(
    { concept: '排序', kpId: 'prog-list-jr' },
    { responses: [{ status: 200, body: goodPayload({ html: '<html><script src="https://cdn.jsdelivr.net/anime.js"></script></html>' }) }] }
  )
  assert.ok(
    calls.filter((call) => call.path === '/api/animation/render').length > 1,
    '带 CDN 的产物必须被判不合格并触发重试'
  )
  assert.equal(detailsOf(result).html, '', '重试耗尽后降级')
})

test('载荷六字段投影：缺一个就判不合格（宁可重试，也不要缺字段的载荷）', () => {
  assert.equal(projectAnimationPayload(null), null)
  assert.equal(projectAnimationPayload(goodPayload({ concept: '' })), null)
  assert.equal(projectAnimationPayload(goodPayload({ html: '' })), null)
  assert.equal(projectAnimationPayload(goodPayload({ fallbackText: '' })), null)
  assert.equal(projectAnimationPayload(goodPayload({ durationMs: 0 })), null)
  assert.equal(projectAnimationPayload(goodPayload({ durationMs: '5200' })), null, 'durationMs 必须是数字')

  const ok = projectAnimationPayload(goodPayload())
  assert.ok(ok)
  assert.equal(ok?.source, 'template')

  // snake_case 也认（契约出参是 camelCase，但手工/旧数据可能是 snake_case）
  assert.ok(projectAnimationPayload(goodPayload({ duration_ms: 5200, durationMs: undefined, fallback_text: '文字' })))
})

test('载荷校验：缺降级素材判不合格（降级后白屏的成因就是它）', () => {
  const base = projectAnimationPayload(goodPayload())
  assert.ok(base)
  if (!base) return
  assert.deepEqual(validateAnimationPayload(base), { ok: true })
  assert.equal(validateAnimationPayload({ ...base, fallbackText: '' }).ok, false)
  assert.equal(validateAnimationPayload({ ...base, fallbackImage: null }).ok, false)
  assert.equal(
    validateAnimationPayload({ ...base, html: '<html><script src="https://unpkg.com/x"></script></html>' }).ok,
    false,
    'unpkg 这类 CDN 必须被判不合格'
  )
})

test('内置兜底 SVG：是可用 dataURL，且**字面量里没有 http://**（零外部引用口径）', () => {
  const dataUrl = buildInlineFallbackImage('排序', '反复比较相邻的两个数，大的往右挪。')
  assert.ok(dataUrl.startsWith('data:image/svg+xml;base64,'))
  const decoded = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64').toString('utf8')
  assert.ok(decoded.includes('<svg'), '解码后应是一份 SVG')
  assert.ok(decoded.includes('排序'), '解码后应带上概念名')
  // ★ base64 之后外层字符串里不该有任何 URL 形状（否则「零外部引用」的 grep 会出现假命中）
  assert.ok(!/https?:\/\//.test(dataUrl), 'dataURL 外层不许出现 http:// 字面量')
})

/* ================================================================== *
 * 8. 渲染侧载荷投影（白名单 + 只认回环地址）
 * ================================================================== */

test('渲染侧投影：认不出的载荷退化成可读文案，绝不抛、不猜字段', () => {
  assert.deepEqual(readAnimationPayload(undefined), {
    concept: '',
    html: '',
    durationMs: 0,
    fallbackText: sandbox.FALLBACK_TEXT_WHEN_EMPTY,
    fallbackImage: null,
    source: 'template',
    resourceUrl: null,
    degradeReason: null
  })
  const weird = readAnimationPayload({ html: { nested: true }, durationMs: 'x', fallbackImage: 42 })
  assert.equal(weird.html, '', '非字符串的 html 一律当空（走降级视图）')
  assert.equal(weird.durationMs, 0)
  assert.equal(weird.fallbackImage, null)
})

test('★ resourceUrl 只认本机回环的动画托管地址（防载荷被改成外网地址）', () => {
  assert.equal(
    readLoopbackUrl('http://127.0.0.1:54321/resources/animation/student_001/prog-loop-jr?nonce=abc&payload_id=p1'),
    'http://127.0.0.1:54321/resources/animation/student_001/prog-loop-jr?nonce=abc&payload_id=p1'
  )
  for (const bad of [
    'https://evil.example/resources/animation/a/b?nonce=x',
    'http://10.0.0.5:8000/resources/animation/a/b',
    'http://127.0.0.1:54321/api/students',
    'file:///C:/resources/animation/a/b',
    '',
    null,
    42
  ]) {
    assert.equal(readLoopbackUrl(bad), null, `不该接受：${String(bad)}`)
  }
})

test('降级判定：html 为空不建 iframe（少一次必然失败的加载）', () => {
  assert.equal(shouldMountIframe('<html></html>'), true)
  assert.equal(shouldMountIframe('   '), false)
  assert.equal(shouldMountIframe(''), false)
  assert.equal(shouldMountIframe(null), false)
})

test('★★ 对话卡片只从内联 HTML 挂 iframe —— 一次性 nonce 的 used/expired 不可能落到学生眼前', () => {
  // ── 这条断言挡的是用户实测报的缺陷（2026-09-23） ────────────────────
  // 托管地址 = 一次性 nonce + TTL 120s + `Cache-Control: no-store`
  // （`server/app/routes/resources.py`：`单次消费`）。而卡片拿到的 `resourceUrl` 是
  // **跟着会话落盘的**：切页回来重建组件、回看历史、隔 2 分钟再看、
  // 甚至 Chromium 丢弃隐藏 iframe 文档后再加载 —— 任一种都会把同一个地址再取一次
  // → 403 `used` / `expired` → iframe 把
  //   `{"detail":"动画资源未通过 nonce 校验（used）"}` 当作文档渲染出来，
  // **直接摆进学生的对话**，还得再干等 5 秒超时才回退。
  //
  // 旧实现是「托管优先、失败回退内联」（当年源码里留着实测记录：原因=used / expired），
  // 那是**止血不是修复**：它承认网络往返会失败，却仍让失败在学生眼前停留 5 秒。
  // 现在的口径是**那次请求根本不该发生**：内联 HTML 永远在（挂载条件就是它非空），
  // 而托管的正是同一份 HTML（`hostAnimation({kpId, html})` 原样落盘）——
  // 走内联 = nonce 没被消费，也就没有「第二次」可言（used 与 expired 同时失效）。
  // 附带收益：卡片不再依赖 sidecar 存活（它挂了动画照样能播）。
  //
  // ⚠️ 规格 D10 的托管服务**没有被架空**：动画讲解页的舞台是它的正常消费者
  //   （每次 `renderAndHost` 现签新地址、不会复用旧地址；实测切页回来不发第二次请求）。
  //
  // ★ 为什么写成源码级断言：卡片是 `.vue`，`node --test` 里没有 Vue 运行时；
  //   而这条纪律的要害恰恰是「源码里还有没有把 URL 绑到 iframe 上的分支」——
  //   源码断言能直接钉住它，且**删掉/加回那条分支都必须显式改本测试**（这正是想要的摩擦）。
  // ★ 先归一化换行：本仓库 `.vue` 在 Windows 工作区里可能是 CRLF，
  //   按 `\n` 写的切片锚点在 CRLF 文本里匹配不到（实测踩过：切片一路跑到文件尾，
  //   断言去扫了整份源码，测试**假红**）。
  const source = readFileSync(
    join(DESKTOP_ROOT, 'src', 'renderer', 'src', 'cards', 'AnimationCard.vue'),
    'utf8'
  ).replace(/\r\n/g, '\n')

  /**
   * 剥注释后只看**代码**。
   *
   * ⚠️ 必须有这一步：本文件用**自然语言**解释了「为什么删掉托管开关」，
   *   注释里难免出现那个标识符。扫整份源码会把**说明**当成**实现**（实测：
   *   第一版直接 `doesNotMatch(/useHosted/)` 就是被自己写的注释判红）——
   *   那等于禁止后人在代码里记录历史，判据与意图背道而驰。
   * `//` 前加 `[^:]` 看着：别吃掉 `http://` 这种 URL 里的双斜线。
   */
  const code = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  // ① iframe 只吃内联 HTML：**不许**出现把 URL 绑上去的写法
  assert.match(source, /:srcdoc="view\.html"/, 'iframe 必须直接吃内联 HTML')
  assert.doesNotMatch(
    code,
    /:src="/,
    '不许给这个 iframe 绑 src —— 绑了就等于把持久化的 nonce 交给浏览器去取第二次'
  )
  assert.doesNotMatch(
    code,
    /useHosted/,
    '托管开关（useHosted）必须连同它的回退分支一起删干净：留着就有人会把那条路径加回来'
  )

  // ② 挂载条件仍然只认 html（html 为空 → 不建 iframe → 直接文字讲解，少一次必然失败的加载）
  assert.match(
    source,
    /const mountIframe = ref<boolean>\(shouldMountIframe\(view\.html\)\)/,
    '挂载条件只能是「载荷里有 HTML」，不得再引回 resourceUrl'
  )

  // ③ 两个失败入口都走统一处理（超时 / 沙箱自报错）
  // ★ 断言要**贴着回调体**取，不能给宽松字符窗口 —— 实测：
  //   写成 `onTimeout:[\s\S]{0,220}?…` 时，改回 `goDegraded(` 也能匹配上（窗口吃到下面 onError），**假绿**。
  const timeoutBody = source.slice(source.indexOf('onTimeout:'), source.indexOf('onError:'))
  assert.match(timeoutBody, /handleFailure\(/, '超时入口的回调体里必须调 handleFailure')
  const errorBody = source.slice(source.indexOf('onError:'), source.indexOf('\n  })\n  return instance'))
  assert.match(errorBody, /handleFailure\(/, '沙箱自报错误的回调体里必须调 handleFailure')

  // ④ 统一失败处理的**终点**是降级视图（绝不白屏），且**不得**再重建宿主去换数据源
  const handler = source.slice(
    source.indexOf('function handleFailure('),
    source.indexOf('function buildHost(')
  )
  assert.match(handler, /goDegraded\(reason\)/, '失败的终点必须是降级视图 —— 降级是终态，绝不白屏')
  assert.doesNotMatch(
    handler,
    /buildHost\(\)/,
    '不得重建宿主去切换数据源：内联是唯一数据源，重建只是把失败换个样子演一遍'
  )

  // ⑤ 探针口径：`data-resource` 如实写死 inline（CDP 据此确认走了哪条路）
  assert.match(source, /data-resource="inline"/, 'data-resource 必须如实标注当前数据源')
})

/* ================================================================== *
 * 9. 静态纪律：模板零外部引用 + 凭据不进产物
 * ================================================================== */

test('★ 动画模板里没有任何外部引用（沙箱断网 → 白屏的根因）', () => {
  const files = listFiles(TEMPLATES_ROOT, ['.json', '.js', '.css'])
  assert.ok(files.length >= 10, `模板目录里文件数看起来不对（${files.length} 个）`)

  const external = /https?:\/\/|\/\/cdn|unpkg|jsdelivr|cdnjs|googleapis|fonts\.gstatic/i
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const match = external.exec(source)
    if (match) offenders.push(`${relative(REPO_ROOT, file).replace(/\\/g, '/')} → 「${match[0]}」`)
  }
  assert.deepEqual(
    offenders,
    [],
    `模板里出现外部引用：\n  ${offenders.join('\n  ')}\n` +
      '沙箱在演示现场是断网的：任何外链都等于白屏。动画库必须本地读取后内联。'
  )
})

test('★ 模板里没有凭据与宿主路径（API Key / baseURL / 绝对路径都不进产物）', () => {
  const files = listFiles(TEMPLATES_ROOT, ['.json', '.js', '.css'])
  const patterns: Array<[string, RegExp]> = [
    ['API Key 形状', /\bsk-[A-Za-z0-9_-]{6,}/],
    ['鉴权头', /X-Auth-Token|Bearer\s/i],
    ['宿主绝对路径', /[A-Za-z]:[\\/]{1,2}(Users|Program|AppData)|\/home\/|\/Users\//]
  ]
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const [label, pattern] of patterns) {
      if (pattern.test(source)) offenders.push(`${relative(REPO_ROOT, file).replace(/\\/g, '/')} → ${label}`)
    }
  }
  assert.deepEqual(offenders, [], `模板里出现凭据/宿主路径：${offenders.join('、')}`)
})

test('模板数量不限：每份内置模板都必须声明 id/kp_ids/body/script 与 ≥30 字降级文案', () => {
  const files = readdirSync(TEMPLATES_ROOT).filter((name) => name.endsWith('.json'))
  // ★ 2026-09-23（D-078）：旧约束「6–8 个」是原票据的时代限制，内容包接入后模板数按知识点覆盖
  //   （206 份一 KP 一模板 + 既有 8 份手作）而定，**不再设上限/下限**。
  // ⚠️ 只留 `> 0` 这一条地板：否则「目录被清空」会让下面的逐份循环空转成假绿。
  //   真正的门是下面那份**逐份**断言 —— 每一份都得合格，数量是几与好坏无关。
  assert.ok(files.length > 0, '一个模板都没有：TEMPLATES_ROOT 被清空或路径配错了（D-078：数量不设限，但一份都不许缺）')

  for (const name of files) {
    const template = JSON.parse(readFileSync(join(TEMPLATES_ROOT, name), 'utf8')) as Record<string, unknown>
    assert.ok(typeof template.id === 'string' && template.id.length > 0, `${name} 缺 id`)
    assert.ok(Array.isArray(template.kp_ids) && (template.kp_ids as unknown[]).length > 0, `${name} 缺 kp_ids`)
    assert.ok(typeof template.body === 'string' && template.body.length > 0, `${name} 缺 body`)
    assert.ok(typeof template.script === 'string' && template.script.length > 0, `${name} 缺 script`)
    assert.ok(
      typeof template.fallback_text === 'string' && (template.fallback_text as string).length >= 30,
      `${name} 的降级文案太短（降级后学生看到的就是它）`
    )
    assert.ok(typeof template.duration_ms === 'number' && template.duration_ms > 0, `${name} 缺 duration_ms`)
  }
})

test('Tool 名冻结（事件层按 §9.3 的表把它映射成 payload.kind = animation）', () => {
  assert.equal(ANIMATION_TOOL_NAME, 'generate_animation')
  const extension = createAnimationExtension({ log: () => {} })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  assert.equal(tool.name, 'generate_animation')
  // 参数 schema 必须是对象（Pi 的 Tool 参数约定）
  assert.equal((tool.parameters as { type?: string }).type, 'object')
  const required = (tool.parameters as { required?: string[] }).required ?? []
  assert.deepEqual(required, ['concept'], '只有 concept 是必填（其余都能从会话/模板推出来）')
})
