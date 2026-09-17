/**
 * 票 17 的**补充路径**测试：动画自由生成（审计结论：此前 `export default createAnimationExtension()`
 * 没接 `generate`，于是「模板未命中 → 自由生成 → 降级」这条被单测覆盖的链路在生产里**不可达**）。
 *
 * 这一份盯住四件事：
 *
 *   A1 **生成器本身**：片段解析（宽松读 / 严格校验）、prompt 里的四条硬约束、合流走 Python；
 *   A2 ★ **真的接进扩展**：用「模板 404 + 接了生成器」跑一次 `generate_animation`，
 *      断言 `source: "generated"`（生成成功分支）—— 这是「路径可达」的直接证据；
 *   A3 ★ **无 Key 时的诚实降级**：`complete: null` → 生成器抛错 → 扩展降级为
 *      **文字 + 静态 SVG 的合法载荷**（`html` 为空、`degradedFrom` 非空），
 *      **没有白屏、没有 error 事件**；
 *   A4 **模板优先不变**：模板命中时生成器一次都不被调用（补充路径不许抢主路径）。
 *
 * 跑法：`npm test`
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
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

const animation = await import('../src/main/agent/extensions/animation.ts')
const generator = await import('../src/main/agent/animation/generator.ts')

const { createAnimationExtension } = animation
const {
  ANIMATION_COMPOSE_PATH,
  RetryableGenerationError,
  buildFragmentPrompt,
  createAnimationGenerator,
  parseAnimationFragment
} = generator

/* ================================================================== *
 * 工具
 * ================================================================== */

/** 抓一个注册好的 Tool（与 animation-extension.test.ts 同一形态）。 */
function captureTool(extension: (pi: unknown) => void): {
  execute: (toolCallId: string, params: unknown) => Promise<unknown>
} {
  let captured: { execute: (a: string, b: unknown) => Promise<unknown> } | null = null
  extension({
    on: () => {},
    registerTool: (tool: { execute: (a: string, b: unknown) => Promise<unknown> }) => {
      captured = { execute: tool.execute }
    }
  })
  if (!captured) throw new Error('扩展必须注册一个 Tool')
  return captured
}

/** 假 sidecar：按给定状态码序列回话。 */
function fakeRequester(responses: Array<{ status?: number; body?: unknown }>): {
  request: (path: string, init?: RequestInit) => Promise<Response>
  calls: Array<{ path: string; init?: RequestInit }>
} {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  let index = 0
  return {
    calls,
    request: async (path, init) => {
      calls.push({ path, init })
      const plan = responses[Math.min(index, responses.length - 1)] ?? { status: 200 }
      index += 1
      const status = plan.status ?? 200
      return new Response(JSON.stringify(plan.body ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }
}

/** 一份合法的完整动画载荷（模板路径的成功产物）。 */
function goodPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function detailsOf(result: Record<string, unknown>): Record<string, unknown> {
  const details = result.details
  assert.ok(details && typeof details === 'object', '结果里必须有 details（事件层靠它发 payload）')
  return details as Record<string, unknown>
}

/* ================================================================== *
 * A1 生成器本身
 * ================================================================== */

test('A1 片段解析：宽松读（剥 ```json 围栏）但严格校验必填字段', () => {
  const good = parseAnimationFragment(
    '```json\n{"body":"<p>hi</p>","script":"Sandbox.play(function(){return null})",' +
      '"fallbackText":"讲解","durationMs":4000,"title":"标题"}\n```'
  )
  assert.ok(good, '合法片段必须解析成功（允许代码块围栏）')
  assert.equal(good?.body, '<p>hi</p>')
  assert.equal(good?.durationMs, 4000)
  assert.equal(good?.title, '标题')

  // 脏值一律拒（空 body / 缺 script / 时长非法 / 不是 JSON）
  assert.equal(parseAnimationFragment(''), null)
  assert.equal(parseAnimationFragment('不是 JSON'), null)
  assert.equal(parseAnimationFragment('{"script":"x","fallbackText":"y","durationMs":1}'), null, '缺 body')
  assert.equal(
    parseAnimationFragment('{"body":"x","fallbackText":"y","durationMs":1}'),
    null,
    '缺 script（没有播放实现，动画不可能动）'
  )
  assert.equal(
    parseAnimationFragment('{"body":"x","script":"y","durationMs":1}'),
    null,
    '缺 fallbackText（失败时就没话可说了）'
  )
  assert.equal(
    parseAnimationFragment('{"body":"x","script":"y","fallbackText":"z","durationMs":0}'),
    null,
    'durationMs <= 0 非法'
  )
})

test('A1 prompt：把四条会白屏的约束都写进去了', () => {
  const prompt = buildFragmentPrompt({ concept: '梯度下降', kpId: 'jr-ml-gd', gradeLevel: 'junior', attempt: 0 })
  assert.match(prompt, /梯度下降/)
  assert.match(prompt, /junior/)
  assert.match(prompt, /禁止任何外部引用/, '断网演示的底线必须写进 prompt')
  assert.match(prompt, /Sandbox\.play/, '必须要求注册播放实现（否则宿主等不到 ready）')
  assert.match(prompt, /parent\.document/, '必须禁止访问宿主文档（沙箱里拿不到）')
  assert.match(prompt, /只输出一个 JSON 对象/, '要结构化输出（我们按 JSON 解析）')
  // 重试时把上次原因带进去（否则重试只是重复同样的错误）
  const retry = buildFragmentPrompt({
    concept: '梯度下降',
    kpId: '',
    gradeLevel: 'junior',
    attempt: 1,
    previousReason: '出现了外部引用'
  })
  assert.match(retry, /上一次尝试失败的原因/)
  assert.match(retry, /出现了外部引用/)
})

test('A1 合流：生成器把片段交回 Python（我们不在 TS 侧拼 HTML）', async () => {
  const calls: Array<Record<string, unknown>> = []
  const generate = createAnimationGenerator({
    complete: async () => '{"body":"<p>b</p>","script":"s()","fallbackText":"f","durationMs":3000}',
    compose: async (request) => {
      calls.push(request as unknown as Record<string, unknown>)
      // 模拟 Python 合流后的完整载荷（注意 source=generated）
      return goodPayload({ source: 'generated', html: '<!DOCTYPE html><html></html>' })
    },
    log: () => {}
  })

  const payload = (await generate({
    concept: '循环',
    kpId: 'jr-py-loop',
    gradeLevel: 'junior',
    attempt: 0
  })) as Record<string, unknown>

  assert.equal(calls.length, 1, '必须走合流端点（库内联与校验只有 Python 做得到）')
  assert.equal(calls[0].body, '<p>b</p>')
  assert.equal(calls[0].script, 's()')
  assert.equal(calls[0].fallbackText, 'f')
  assert.equal(calls[0].concept, '循环')
  assert.equal(calls[0].gradeLevel, 'junior')
  assert.equal(payload.source, 'generated')
})

test('A1 合流路径常量：相对路径（token 由 bridge/client 注入）', () => {
  assert.equal(ANIMATION_COMPOSE_PATH, '/api/animation/compose')
  assert.ok(ANIMATION_COMPOSE_PATH.startsWith('/'))
})

test('A1 合流 422 = 可重试（与模板路径的 422 同一语义）', async () => {
  const generate = createAnimationGenerator({
    complete: async () => '{"body":"b","script":"s","fallbackText":"f","durationMs":3000}',
    compose: async () => {
      throw new RetryableGenerationError('产物未通过校验：出现了外部引用')
    },
    log: () => {}
  })
  await assert.rejects(
    () => generate({ concept: 'c', kpId: '', gradeLevel: 'junior', attempt: 0 }),
    /未通过校验/
  )
})

test('A1 模型没按 JSON 回 → 抛可重试错误（扩展会带着原因再试）', async () => {
  const generate = createAnimationGenerator({
    complete: async () => '这是一段解释而不是 JSON',
    compose: async () => goodPayload(),
    log: () => {}
  })
  await assert.rejects(
    () => generate({ concept: 'c', kpId: '', gradeLevel: 'junior', attempt: 0 }),
    /不是合法 JSON 片段/
  )
})

/* ================================================================== *
 * A2 ★ 真的接进扩展：模板 404 → 生成成功 → source=generated
 * ================================================================== */

test('★ A2 模板未命中（404）→ 自由生成 → source=generated（这条路径现在可达）', async () => {
  const fake = fakeRequester([
    // 模板路径：404（没有覆盖该知识点的模板 —— 这就是触发补充路径的信号）
    { status: 404, body: { detail: '没有覆盖知识点的模板' } }
  ])
  let generated = 0
  const extension = createAnimationExtension({
    request: fake.request,
    generate: async () => {
      generated += 1
      // 生成器返回**已合流/已校验**的完整载荷（source 由扩展改写成 generated）
      return goodPayload({ source: 'generated', concept: '没有模板的概念' })
    },
    log: () => {}
  })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  const result = (await tool.execute('call-gen-1', {
    concept: '没有模板的概念',
    kpId: 'kp-no-template',
    gradeLevel: 'junior'
  })) as Record<string, unknown>

  assert.equal(generated, 1, '404 之后必须真的尝试一次自由生成')
  const details = detailsOf(result)
  assert.equal(details.source, 'generated', '★ 生成成功的产物必须标成 generated')
  assert.equal(details.degradedFrom, null, '走通了就不该标降级')
  assert.equal(fake.calls.length, 1, '模板路径只试一次（404 不可重试）')
})

/* ================================================================== *
 * A3 ★ 无 Key 时的诚实降级（不许白屏、不许 error）
 * ================================================================== */

test('★★ A3 无 Key：生成失败 → 降级为文字 + 静态 SVG 的合法载荷（不白屏、不发 error）', async () => {
  const fake = fakeRequester([{ status: 404, body: { detail: '没有覆盖知识点的模板' } }])
  let attempts = 0
  const extension = createAnimationExtension({
    request: fake.request,
    // ★ 无 Key 的真实形态：生成器抛错（`createAnimationGenerator` 在 complete=null 时就是这么抛的）
    generate: async () => {
      attempts += 1
      throw new Error('自由生成不可用：本机没有配置 API Key（这条是模板未命中时的补充路径）')
    },
    log: () => {}
  })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  const result = (await tool.execute('call-nokey-1', {
    concept: '无模板概念',
    kpId: 'kp-no-template',
    gradeLevel: 'junior'
  })) as Record<string, unknown>

  // ★ 关键：结果**不是**错误，而是一个合法的可展示载荷
  const details = detailsOf(result)
  assert.equal(details.error, undefined, '降级**不是** error（error 对 UI 是终态，会掐掉后半段对话）')
  assert.equal(String(details.html), '', '降级产物 html 为空 → 前端直接渲染文字 + 静态图（不建 iframe，不会白屏）')
  assert.ok(String(details.fallbackText).trim().length > 0, '降级文案必须非空（界面不允许空着）')
  assert.ok(String(details.fallbackImage).startsWith('data:image/svg+xml'), '静态图必须是自包含 dataURL')
  assert.ok(String(details.degradedFrom).length > 0, '必须留下降级原因（轨迹与排查都靠它）')
  assert.equal(details.concept, '无模板概念')
  // 重试上限：模板 1 次 + 生成 ≤4 次（扩展的 maxRetries = 3），但绝不无限重试
  assert.ok(attempts <= 4, `自由生成最多重试到上限（实际 ${attempts} 次），不许无限循环`)
})

test('A3 降级后的 Tool 文本：告诉模型「用文字接着讲」，不向学生暴露技术细节', () => {
  const payload = animation.buildFallbackPayload('无模板概念', '一段讲解', 'data:image/svg+xml;base64,eA==')
  const text = animation.renderAnimationText(payload)
  assert.match(text, /无模板概念/)
  assert.match(text, /文字讲解顶/)
  assert.ok(!/API Key|error|异常|失败原因/.test(text), '面向模型的说明里不许出现技术细节（模型会学给学生的）')
})

/* ================================================================== *
 * A4 模板优先不变
 * ================================================================== */

test('★ A4 模板命中时生成器一次都不被调用（补充路径不许抢主路径）', async () => {
  const fake = fakeRequester([{ status: 200, body: goodPayload() }])
  let generated = 0
  const extension = createAnimationExtension({
    request: fake.request,
    generate: async () => {
      generated += 1
      return goodPayload({ source: 'generated' })
    },
    log: () => {}
  })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  const result = (await tool.execute('call-template-1', {
    concept: '排序',
    kpId: 'jr-data-features',
    gradeLevel: 'junior',
    templateId: 'sorting-bars'
  })) as Record<string, unknown>

  assert.equal(generated, 0, '模板优先：命中就不该走自由生成')
  assert.equal(detailsOf(result).source, 'template')
})

test('★ A4 默认导出仍然「不接生成器」（无 Key / 无 sidecar 时最保守的那条路）', async () => {
  const fake = fakeRequester([{ status: 404, body: { detail: '没有模板' } }])
  const extension = createAnimationExtension({ request: fake.request, log: () => {} })
  const tool = captureTool(extension as unknown as (pi: unknown) => void)
  const result = (await tool.execute('call-default-1', {
    concept: 'c',
    kpId: 'kp',
    gradeLevel: 'junior'
  })) as Record<string, unknown>

  // 不接生成器 → 直接降级（这条路径**必须**保持可用的兜底）
  const details = detailsOf(result)
  assert.equal(String(details.html), '')
  assert.ok(String(details.degradedFrom).length > 0)
  assert.ok(String(details.degradedFrom).includes('模板未命中') || String(details.degradedFrom).length > 0)
})

test('A4 接线守卫：runtime.ts 注入的是「接了 generate 的」工厂', () => {
  const source = readFileSync(join(DESKTOP_ROOT, 'src', 'main', 'agent', 'runtime.ts'), 'utf8')
  assert.ok(source.includes('createAnimationGenerator('), 'runtime.ts 必须用到 createAnimationGenerator')
  assert.ok(
    /animation:\s*createAnimationExtension\(/.test(source),
    'animation 这一格必须传 createAnimationExtension({ generate }) 的实例'
  )
})
