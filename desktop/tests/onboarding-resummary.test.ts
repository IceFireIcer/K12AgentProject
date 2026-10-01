/**
 * 冷启动概括的**补跑一次**（W8）的行为级守卫。
 *
 * 背景：没配 Key 时五问照常答完，但 LLM 概括走降级桩（summary='degraded'、零新标签、永不重试），
 * 而持续画像只从后续对话学、不会回头读那五条回答 —— 冷启动最值钱的素材会被永久跳过。
 * 补跑路径的三条不变量：
 *   · 三个条件（没答完 / 已经成功过（本进程或跨重启标记）/ 拿不到问答）时**不跑**；
 *   · 成功即幂等 —— 同一次进程里第二次不再打模型；
 *   · 失败保留 degraded（下次触发再试），成功走**同一个 summarizer 与同一条写标签路径**。
 *
 * 跑法：node --test tests/onboarding-resummary.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { OnboardingDeps } from '../src/main/agent/onboarding/index.ts'
import { isLlmVisibleTag, LLM_VISIBLE_TAGS } from '../src/shared/profile-tags.ts'

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

const { createOnboardingService } = await import('../src/main/agent/onboarding/index.ts')

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readFile = (relativePath: string): string =>
  readFileSync(join(DESKTOP_ROOT, ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n')

interface WireCall {
  path: string
  method: string
  body?: string
}
interface Wire {
  calls: WireCall[]
  transport: (path: string, init: RequestInit) => Promise<unknown>
  reply(path: string, body: unknown): void
}

/** 唯一 HTTP 出口的替身（与 onboarding-state.test.ts 同一手法，本文件自带一份互不污染）。 */
function makeWire(): Wire {
  const calls: WireCall[] = []
  const replies: Array<{ path: string; body: unknown }> = []
  const transport = async (path: string, init: RequestInit): Promise<unknown> => {
    calls.push({
      path,
      method: typeof init.method === 'string' ? init.method : 'GET',
      body: typeof init.body === 'string' ? init.body : undefined
    })
    for (const rule of replies) {
      if (path === rule.path || path.startsWith(rule.path + '?')) return rule.body
    }
    return {}
  }
  return {
    calls,
    transport,
    reply(path: string, body: unknown): void {
      replies.unshift({ path, body })
    }
  }
}

const STATE_PATH = '/api/onboarding/student_001/state'
const IDENTITY_PATH = '/api/profile/student_001/identity'
const DONE_STATE = { onboardingState: 'done', answered: ['q1', 'q2', 'q3', 'q4', 'q5'], displayName: '' }
const IN_PROGRESS_STATE = { onboardingState: 'in_progress', answered: ['q1'], displayName: '' }

/** 建一个「已接线、已读状态」的服务（每个用例一套）。 */
async function serviceWith(state: Record<string, unknown>, extra: Partial<OnboardingDeps> = {}) {
  const wire = makeWire()
  wire.reply(STATE_PATH, state)
  wire.reply(IDENTITY_PATH, {
    parentConsent: true,
    memorySwitch: true,
    onboardingState: state.onboardingState
  })
  const service = createOnboardingService({
    studentId: () => 'student_001',
    transport: wire.transport,
    log: () => {},
    ...extra
  })
  await service.start()
  return { service, wire }
}

test('★ 三个条件：状态没读过 / 五问没答完 / 已经成功过都不跑（绝不拿空素材打模型）', async () => {
  // ① 状态还没读过（界面还没挂载）—— 先跑只会得到一句误导日志
  const fresh = createOnboardingService({ studentId: () => 'student_001', log: () => {} })
  const pre = await fresh.retrySummary()
  assert.equal(pre.ran, false)
  assert.match(pre.reason, /还没读过/)

  // ② 五问还没答完
  let earlyCalls = 0
  const early = await serviceWith(IN_PROGRESS_STATE, {
    summarize: async () => {
      earlyCalls += 1
      return { ok: true, degraded: false, reason: '', tags: [] }
    }
  })
  const notDone = await early.service.retrySummary()
  assert.equal(notDone.ran, false)
  assert.match(notDone.reason, /还没答完/)
  assert.equal(earlyCalls, 0, '没答完就不该调模型')

  // ③ 跨重启标记：已经成功过 → 永不再跑
  let markedCalls = 0
  const marked = await serviceWith(DONE_STATE, {
    summaryDone: () => true,
    summarize: async () => {
      markedCalls += 1
      return { ok: true, degraded: false, reason: '', tags: [] }
    }
  })
  const skip = await marked.service.retrySummary()
  assert.equal(skip.ran, false)
  assert.match(skip.reason, /已经概括过/)
  assert.equal(markedCalls, 0, '跨重启标记为真就不该再打模型')

  // ④ degraded / 从未成功过 + 有模型（summarize 回 ok）→ 跑
  const ready = await serviceWith(DONE_STATE, {
    summaryDone: () => false,
    loadAnswers: async () => [{ questionId: 'q5', text: '喜欢拼乐高' }],
    summarize: async () => ({ ok: true, degraded: false, reason: '', tags: [] })
  })
  const run = await ready.service.retrySummary()
  assert.equal(run.ran, true)
})

test('★ 成功即幂等：同一次进程里第二次不再打模型（不依赖跨重启标记）', async () => {
  let calls = 0
  const { service } = await serviceWith(DONE_STATE, {
    loadAnswers: async () => [{ questionId: 'q5', text: '喜欢拼乐高' }],
    summarize: async () => {
      calls += 1
      return { ok: true, degraded: false, reason: '', tags: [] }
    }
  })
  const first = await service.retrySummary()
  assert.equal(first.ran, true)
  assert.equal(calls, 1)
  assert.equal(service.snapshot().summary, 'ok')

  const second = await service.retrySummary()
  assert.equal(second.ran, false)
  assert.match(second.reason, /幂等|已经概括过/)
  assert.equal(calls, 1, '成功过就永不再打模型（本进程 ok 判据）')
})

test('★ 失败保留 degraded：下次触发再试；成功一次后转 ok 并幂等', async () => {
  let available = false
  let calls = 0
  const { service } = await serviceWith(DONE_STATE, {
    loadAnswers: async () => [{ questionId: 'q5', text: '喜欢拼乐高' }],
    summarize: async () => {
      calls += 1
      return available
        ? { ok: true, degraded: false, reason: '', tags: [] }
        : { ok: false, degraded: true, reason: 'no-key', tags: [] }
    }
  })

  const failed = await service.retrySummary()
  assert.equal(failed.ran, true)
  assert.equal(service.snapshot().summary, 'degraded', '失败必须保留 degraded（下次还能再试）')

  const again = await service.retrySummary()
  assert.equal(again.ran, true, 'degraded 状态下一次触发要再试（不是永久跳过）')
  assert.equal(calls, 2)

  available = true
  const success = await service.retrySummary()
  assert.equal(success.ran, true)
  assert.equal(service.snapshot().summary, 'ok')
  assert.equal(calls, 3)

  const after = await service.retrySummary()
  assert.equal(after.ran, false, '成功之后转幂等')
  assert.equal(calls, 3)
})

test('★ 补跑与首次概括走同一个 summarizer 与同一条写标签路径（白名单同源）', async () => {
  const seenInputs: Array<Record<string, unknown>> = []
  const { service, wire } = await serviceWith(DONE_STATE, {
    loadAnswers: async () => [{ questionId: 'q5', text: '喜欢拼乐高' }],
    summarize: async (input) => {
      seenInputs.push(input as unknown as Record<string, unknown>)
      return {
        ok: true,
        degraded: false,
        reason: '',
        tags: [{ key: 'interest_topic', value: '拼乐高', source: 'declared', confidence: 0.8 }]
      }
    }
  })

  const outcome = await service.retrySummary()
  assert.equal(outcome.ran, true)
  assert.equal(seenInputs.length, 1, '补跑用的就是注入的那一个 summarizer')
  assert.equal('studentId' in (seenInputs[0] ?? {}), false, '出网载荷里没有身份字段（既有纪律）')

  const puts = wire.calls.filter((call) => call.method === 'PUT')
  const tagPut = puts.find((call) => call.path.includes('/tags/interest_topic'))
  assert.ok(tagPut, '补出的标签必须走同一条逐条 PUT 的写路径')
  const body = JSON.parse(String(tagPut?.body)) as Record<string, unknown>
  assert.equal(body.value, '拼乐高')
  assert.equal(body.source, 'declared')
  assert.equal(body.confidence, 0.8)

  assert.equal(isLlmVisibleTag('interest_topic'), true)
  assert.ok(LLM_VISIBLE_TAGS.includes('interest_topic'), '白名单与 summarizer 同源（LLM_VISIBLE_TAGS 唯一一份）')

  // 源码级：两条概括路径用的是同一组调用（同一个概括器包装 / 同一份内存合并 / 同一条写路径）
  const source = readFile('src/main/agent/onboarding/service.ts')
  const retryAt = source.indexOf('async function retrySummary(')
  const firstAt = source.indexOf('async function runSummary(')
  assert.ok(retryAt > 0 && firstAt > 0, '两条概括路径都必须存在')
  const retry = source.slice(retryAt, retryAt + 4600)
  const first = source.slice(firstAt, firstAt + 2600)
  for (const [label, code] of [['retrySummary', retry], ['runSummary', first]] as const) {
    assert.ok(code.includes('summarizeWithTimeout('), label + ' 必须用同一个概括器包装')
    assert.ok(code.includes('mergeTags('), label + ' 必须走同一份内存合并（含白名单过滤）')
    assert.ok(code.includes('writeTags(sid, fresh)'), label + ' 必须走同一条逐条 PUT 写路径')
  }
})
