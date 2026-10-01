/**
 * V1（task-49）运行时 span 采集：出网口打点 → 信封 → 落盘脱敏的**行为级**单测。
 *
 * 为什么另起一个文件：V3 的 tests/runtime-spans.test.ts 也盯这条链（验收口径），
 * 这里只钉我自己实现里的**不变式**：一次出网必有一条 span、轮内/轮外归属、
 * 环形上限，以及「落盘那份里没有正文、没有本机路径、没有查询串凭据」。
 *
 * 跑法：cd desktop && node --test tests/runtime-span-capture.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { RuntimeSpanEvent } from '../src/main/bridge/llm-completions.ts'

const SRC_SHARED = new URL('../src/shared/', import.meta.url)

/**
 * 主进程源码用 Vite 的口味写导入（`@shared/diagnostics` 别名 + 不带扩展名的相对路径），
 * Node ESM 认不出 —— 这个 hook 只做这两件事，让单测能 import **真实实现**。
 * ⚠️ 被测模块必须动态 import：静态 import 会被提到 hook 注册之前。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      return {
        url: new URL(specifier.slice('@shared/'.length) + '.ts', SRC_SHARED).href,
        shortCircuit: true
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

// 动态 import：与下面的替身挂在**同一个模块实例**上（模块加载即注册真实采集口）。
const diag = await import('../src/main/agent/diagnostics.ts')
const llm = await import('../src/main/bridge/llm-completions.ts')

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  // 恢复真实采集口（模块加载时注册的那个）
  llm.setRuntimeSpanSink((event) => diag.recordRuntimeSpan(event))
  diag.setOffTurnSpanNotifier(null)
  diag.resetRuntimeSpansForTests()
})

/** 一个假的出网实现（按脚本回执 / 抛错）。 */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: unknown, init: unknown) =>
    await handler(String(url), (init ?? {}) as RequestInit)) as typeof fetch
}

function bodyOf(promptText: string, model = 'test-model'): string {
  return JSON.stringify({ model, messages: [{ role: 'user', content: promptText }] })
}

test('出网口：成功 / HTTP 失败 / 网络异常各产生一条 span，字段齐全', async () => {
  const events: RuntimeSpanEvent[] = []
  llm.setRuntimeSpanSink((event) => events.push(event))

  stubFetch(() => new Response('{}', { status: 200 }))
  const ok = await llm.llmFetch(
    'https://gw.example/v1/chat/completions',
    { method: 'POST', body: bodyOf('你好世界') },
    { purpose: '五问概括', label: '把五问的回答整理成学习偏好' }
  )
  assert.equal(ok.status, 200)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.purpose, '五问概括')
  assert.equal(events[0]?.label, '把五问的回答整理成学习偏好')
  assert.equal(events[0]?.model, 'test-model', '模型名从请求体读回来')
  assert.equal(events[0]?.promptChars, 4, 'prompt 只留**字符数**')
  assert.equal(events[0]?.ok, true)
  assert.equal(events[0]?.note, null)
  assert.ok((events[0]?.ms ?? -1) >= 0)

  stubFetch(() => new Response('nope', { status: 503 }))
  await llm.llmFetch('https://gw.example/v1/chat/completions', { method: 'POST', body: bodyOf('x') })
  assert.equal(events.length, 2)
  assert.equal(events[1]?.ok, false)
  assert.equal(events[1]?.note, 'HTTP 503', 'HTTP 失败只留状态码（绝不带回执正文）')
  assert.equal(events[1]?.purpose, '子代理', '没给 purpose 时回落中性分类')

  stubFetch(() => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:443')
  })
  await assert.rejects(
    () => llm.llmFetch('https://gw.example/v1/chat/completions', { method: 'POST', body: bodyOf('x') }),
    /ECONNREFUSED/
  )
  assert.equal(events.length, 3)
  assert.equal(events[2]?.ok, false)
  assert.match(String(events[2]?.note), /ECONNREFUSED/)

  // 不是 http(s) 的地址：**在打点之前**就拒绝，不该产生 span（它根本没出网）
  await assert.rejects(
    () => llm.llmFetch('file:///c:/x', { method: 'POST', body: bodyOf('x') }),
    /不是 http\(s\)/
  )
  assert.equal(events.length, 3, '被拒的地址不产生 span')
})

test('归属：轮内挂该轮；轮外**不**随 recorder 走（留给即时推送 / 迁移）；finish 幂等', async () => {
  llm.setRuntimeSpanSink((event) => diag.recordRuntimeSpan(event))
  stubFetch(() => new Response('{}', { status: 200 }))

  // ① 轮内：先建 recorder（它就是「当前轮」），再出网
  const recorder = new diag.TurnDiagnosticsRecorder({
    turn: 7,
    requestId: 'req-7',
    text: '学生问',
    gradeLevel: 'junior'
  })
  await llm.llmFetch('https://gw.example/v1/chat/completions', { method: 'POST', body: bodyOf('轮内') })
  const envelope = recorder.finish({ ok: true, status: 'done' })
  assert.equal(envelope.spans?.length, 1)
  assert.equal(envelope.spans?.[0]?.turnIndex, 7)
  assert.equal(envelope.spans?.[0]?.offTurn, false)

  // ② 轮外：没有活动轮 → 留在轮外缓冲（即时推送 / 等下一次信封迁移），不塞进 recorder
  await llm.llmFetch('https://gw.example/v1/chat/completions', { method: 'POST', body: bodyOf('轮外') })
  const pending = diag.peekOffTurnSpans()
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.offTurn, true)
  assert.equal(pending[0]?.turnIndex, null)

  // ③ finish 幂等：不会把轮内那批再取一遍；轮外那条仍在缓冲里
  const again = recorder.finish({ ok: true, status: 'done' })
  assert.equal(again.spans?.length, 1)
  assert.equal(diag.peekOffTurnSpans().length, 1)
})

test('轮外 span 即时上屏 + 迁移：没有轮次时进 offTurnSpans，有轮次时迁进那一轮', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'k12-span-'))
  const store = new diag.DiagnosticsStore({ filePath: join(dir, 'turn-diagnostics.jsonl') })
  try {
    const notified: number[] = []
    diag.setOffTurnSpanNotifier(() => notified.push(Date.now()))
    llm.setRuntimeSpanSink((event) => diag.recordRuntimeSpan(event))
    stubFetch(() => new Response('{}', { status: 200 }))

    // ① 还没有任何轮次（学生答完五问没再发消息）：快照带轮外段，且通知口被叫到
    await llm.llmFetch(
      'https://gw.example/v1/chat/completions',
      { method: 'POST', body: bodyOf('五问') },
      { purpose: '五问概括', label: '把五问的回答整理成学习偏好' }
    )
    assert.equal(notified.length, 1, '轮外 span 落地即通知推送口')
    const before = store.snapshot()
    assert.equal(before.turns.length, 0)
    assert.equal(before.offTurnSpans?.length, 1, '没有轮次时走 offTurnSpans（纯加法字段）')
    assert.equal(before.offTurnSpans?.[0]?.purpose, '五问概括')
    assert.equal(before.offTurnSpans?.[0]?.turnIndex, null)

    // ② 下一份轮次信封收尾 → 迁移进那一轮（同一批数据不留两份）
    const recorder = new diag.TurnDiagnosticsRecorder({
      turn: 9,
      requestId: 'req-9',
      text: '又聊了',
      gradeLevel: 'junior'
    })
    store.append(recorder.finish({ ok: true, status: 'done' }))
    const after = store.snapshot()
    assert.equal(after.turns.length, 1)
    assert.deepEqual(after.turns[0]?.spans?.map((span) => span.purpose), ['五问概括'])
    assert.equal(after.turns[0]?.spans?.[0]?.offTurn, true)
    assert.equal(after.offTurnSpans, undefined, '迁移之后不再留轮外段')

    // ③ 轮内 span 不触发即时推送（它随信封正常上屏）
    const notifiedBefore = notified.length
    const inside = new diag.TurnDiagnosticsRecorder({
      turn: 10,
      requestId: 'req-10',
      text: 'x',
      gradeLevel: 'junior'
    })
    await llm.llmFetch('https://gw.example/v1/chat/completions', { method: 'POST', body: bodyOf('轮内') })
    inside.finish({ ok: true, status: 'done' })
    assert.equal(notified.length, notifiedBefore, '轮内 span 走既有信封推送')
  } finally {
    diag.setOffTurnSpanNotifier(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('环形上限：span 缓冲与轮次信封同口径', async () => {
  llm.setRuntimeSpanSink((event) => diag.recordRuntimeSpan(event))
  stubFetch(() => new Response('{}', { status: 200 }))
  for (let i = 0; i < diag.RUNTIME_SPAN_LIMIT + 5; i += 1) {
    await llm.llmFetch('https://gw.example/v1/chat/completions', {
      method: 'POST',
      body: bodyOf('第' + String(i) + '次')
    })
  }
  assert.equal(diag.drainRuntimeSpans().length, diag.RUNTIME_SPAN_LIMIT)
})

test('落盘脱敏：stripForPersistence 后没有正文 / 本机路径 / 查询串凭据，只有体量与结论', async () => {
  llm.setRuntimeSpanSink((event) => diag.recordRuntimeSpan(event))
  const MARKER = '这条正文一个字都不许落盘-9f3a'
  stubFetch(() => {
    throw new Error('connect failed to http://gw.local/v1?key=SECRET-QUERY at D:\\very\\secret\\path.txt')
  })
  const recorder = new diag.TurnDiagnosticsRecorder({
    turn: 3,
    requestId: 'req-3',
    text: '学生问',
    gradeLevel: 'junior'
  })
  await assert.rejects(() =>
    llm.llmFetch(
      'https://gw.example/v1/chat/completions',
      { method: 'POST', body: bodyOf(MARKER) },
      { purpose: '画像刷新', label: '把最近的问答整理成画像变化' }
    )
  )
  const envelope = recorder.finish({ ok: true, status: 'done' })
  const span = envelope.spans?.[0]
  assert.ok(span, '要有一条 span')
  assert.equal(span.promptChars, MARKER.length, '只留字符数')
  assert.equal(span.promptTokEst, diag.estimateTokensFromChars(MARKER.length))
  assert.equal(span.note?.includes('SECRET-QUERY'), false, '查询串里的疑似凭据不进 note')
  assert.equal(span.note?.includes('D:\\very'), false, '本机路径已抹')
  assert.match(String(span.note), /本机路径/)

  const persisted = JSON.stringify(diag.stripForPersistence(envelope))
  assert.equal(persisted.includes(MARKER), false, '★ 落盘那份里绝不出现 prompt 正文')
  assert.equal(persisted.includes('SECRET-QUERY'), false, '也不出现查询串凭据')
  assert.equal(persisted.includes('D:\\very'), false, '更不出现本机路径')
  assert.match(persisted, /"promptChars":/)
})

test('推送频率有上界：轮外推送是 300ms 合并窗口 + 单一计时器（handlers 侧）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/main/ipc/handlers.ts', import.meta.url), 'utf8')
  assert.match(source, /const OFF_TURN_PUSH_WINDOW_MS = 300/, '窗口常量必须写死在那里')
  assert.match(source, /if \(offTurnPushTimer !== null\) return/, '窗口内重复通知必须被合并')
  assert.match(
    source,
    /setOffTurnSpanNotifier\(scheduleOffTurnDiagnosticsPush\)/,
    '推送口必须真的接上（否则轮外 span 又要等下一轮）'
  )
  assert.ok(source.includes('offTurnPushTimer') && source.includes('.unref?.()'), '计时器不拖住退出')
})

test('estimateTokensFromChars 与信封口径一致（0 字符 = 0）', () => {
  assert.equal(diag.estimateTokensFromChars(0), 0)
  assert.equal(diag.estimateTokensFromChars(-3), 0)
  assert.equal(diag.estimateTokensFromChars(4), 2)
  assert.equal(diag.estimateTokensFromChars(100), 60)
})
