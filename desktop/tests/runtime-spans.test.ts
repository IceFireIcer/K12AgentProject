/**
 * 运行时 span 采集（V1）的守卫：出网口一个不漏、只留体量与结论、轮内/轮外归属、环形上限。
 *
 * ★ 为什么这一组值钱：子代理（五问概括 / 画像刷新 / 画像小结）**不经过 Pi**，
 *   Pi extension 看不到它们；它们全部经过主进程唯一的模型出网口（D-116）——
 *   在这一个点打点，才能证明「一个不漏」。同时它是**证据页的数据源**：
 *   落盘那份绝不能带提示词 / 正文原文，也不能带本机绝对路径。
 *
 * 跑法：node --test tests/runtime-spans.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { RuntimeSpanEvent } from '../src/main/bridge/llm-completions.ts'

const SRC_SHARED = new URL('../src/shared/', import.meta.url)

/**
 * 主进程模块里用了 @shared 别名与不带扩展名的相对导入（打包器口味），
 * Node 直跑要么补别名、要么补 .ts。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      return { url: new URL(specifier.slice('@shared/'.length) + '.ts', SRC_SHARED).href, shortCircuit: true }
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

const bridge = await import('../src/main/bridge/llm-completions.ts')
const diagnostics = await import('../src/main/agent/diagnostics.ts')

const originalFetch = globalThis.fetch

/** 用注入的上层出口接管事件（诊断模块自己注册的那份先让开；finally 还原）。 */
function captureEvents(events: RuntimeSpanEvent[]): void {
  bridge.setRuntimeSpanSink((event) => events.push(event))
}
function restoreSink(): void {
  bridge.setRuntimeSpanSink((event) => diagnostics.recordRuntimeSpan(event))
}

const SPAN_URL = 'https://api.example.com/v1/chat/completions'
const EVENT_BASE: Omit<RuntimeSpanEvent, 'ok' | 'note'> = {
  purpose: '五问概括',
  label: '五问概括',
  model: 'm-1',
  promptChars: 100,
  startedAt: 1_700_000_000_000,
  ms: 12
}

test('★ 出网口成功一次 = 一条 span（模型 / 体量 / 结论齐全，只有数字没有正文）', async () => {
  const events: RuntimeSpanEvent[] = []
  captureEvents(events)
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  try {
    const body = JSON.stringify({
      model: 'm-span-1',
      messages: [
        { role: 'user', content: 'abcde' },
        { role: 'system', content: 'xy' }
      ]
    })
    const response = await bridge.llmFetch(SPAN_URL, { method: 'POST', body }, { purpose: '五问概括', label: '五问概括' })
    assert.equal(response.status, 200)
    assert.equal(events.length, 1, '一次调用恰好一条 span')
    const event = events[0]
    assert.ok(event)
    assert.equal(event.purpose, '五问概括')
    assert.equal(event.label, '五问概括')
    assert.equal(event.model, 'm-span-1', '模型名从请求体读（不靠调用点自报）')
    assert.equal(event.promptChars, 7, '只累计 messages 的字符数（abcde + xy）')
    assert.equal(event.ok, true)
    assert.equal(event.note, null)
    assert.ok(Number.isInteger(event.ms) && event.ms >= 0, '耗时是非负整数毫秒')
    assert.ok(Number.isFinite(event.startedAt) && event.startedAt > 0)
    assert.equal(JSON.stringify(event).includes('abcde'), false, 'span 里绝不含提示词正文')
  } finally {
    globalThis.fetch = originalFetch
    restoreSink()
  }
})

test('★ 非 2xx：仍是一条 span，ok=false 且 note 只有状态码', async () => {
  const events: RuntimeSpanEvent[] = []
  captureEvents(events)
  globalThis.fetch = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
  try {
    const response = await bridge.llmFetch(SPAN_URL, { method: 'POST', body: '{}' })
    assert.equal(response.status, 503, '响应原样返回（由调用点翻译成降级理由）')
    assert.equal(events.length, 1)
    assert.equal(events[0]?.ok, false)
    assert.equal(events[0]?.note, 'HTTP 503')
  } finally {
    globalThis.fetch = originalFetch
    restoreSink()
  }
})

test('★ 网络异常：记一条失败 span 并把异常原样抛出（note 抹掉查询串）', async () => {
  const events: RuntimeSpanEvent[] = []
  captureEvents(events)
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED https://gw.school.edu/v1?key=sk-secret')
  }) as unknown as typeof fetch
  try {
    await assert.rejects(
      () => bridge.llmFetch(SPAN_URL, { method: 'POST', body: '{}' }),
      /ECONNREFUSED/,
      '异常必须原样抛出（本文件不替调用点决定降级还是重试）'
    )
    assert.equal(events.length, 1, '抛异常也要留下一条 span（否则失败调用在证据页上消失）')
    const note = String(events[0]?.note ?? '')
    assert.equal(events[0]?.ok, false)
    assert.equal(note.includes('sk-secret'), false, 'note 必须抹掉 URL 查询串（网关常把凭据放那里）')
    assert.equal(note.includes('?'), false)
  } finally {
    globalThis.fetch = originalFetch
    restoreSink()
  }
})

test('★ 没给 options：回落中性 purpose/label（泳道按 purpose 分组，不能给空串）', async () => {
  const events: RuntimeSpanEvent[] = []
  captureEvents(events)
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  try {
    await bridge.llmFetch(SPAN_URL, { method: 'POST', body: '{}' })
    assert.equal(events[0]?.purpose, '子代理')
    assert.equal(events[0]?.label, '一次子代理模型调用')
    assert.equal(events[0]?.model, null, '读不出模型名就 null（不编）')
  } finally {
    globalThis.fetch = originalFetch
    restoreSink()
  }
})

test('★ 非 http(s) 地址：拒绝出网，且一条 span 都不产生', async () => {
  const events: RuntimeSpanEvent[] = []
  captureEvents(events)
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  try {
    await assert.rejects(() => bridge.llmFetch('file:///etc/passwd', { method: 'POST', body: '{}' }), /http/)
    assert.equal(called, false, '被拒的地址根本不该发出去')
    assert.equal(events.length, 0, '没发生的调用不记 span')
  } finally {
    globalThis.fetch = originalFetch
    restoreSink()
  }
})

test('★ recordRuntimeSpan：形状 / 估算 / 钳位（没有活动轮 = 轮外）', () => {
  diagnostics.resetRuntimeSpansForTests()
  const span = diagnostics.recordRuntimeSpan({
    ...EVENT_BASE,
    purpose: '画像刷新',
    label: '画像刷新',
    model: null,
    ms: -5,
    ok: false,
    note: '  失败   原因  '
  })
  assert.equal(span.id, 'span-1')
  assert.equal(span.kind, 'subagent')
  assert.equal(span.ms, 0, '负耗时钳到 0')
  assert.equal(span.promptTokEst, 60, '估算 = max(1, round(chars * 0.6))')
  assert.equal(span.note, '失败 原因', 'note 压成单行')
  assert.equal(span.offTurn, true)
  assert.equal(span.turnIndex, null, '没有活动轮 → 轮外')

  const blanks = diagnostics.recordRuntimeSpan({ ...EVENT_BASE, ok: true, note: '   ' })
  assert.equal(blanks.note, null, '空 note 给 null（别给空串）')
  assert.equal(diagnostics.estimateTokensFromChars(0), 0)
  assert.equal(diagnostics.estimateTokensFromChars(10), 6)
})

test('★ recordRuntimeSpan：note 里的本机路径被抹掉，超长截断到 160', () => {
  diagnostics.resetRuntimeSpansForTests()
  const withPath = diagnostics.recordRuntimeSpan({
    ...EVENT_BASE,
    ok: false,
    note: '读取 C:\\Users\\me\\secret.txt 失败'
  })
  assert.ok(String(withPath.note).includes('«本机路径»'), '上屏/落盘前抹掉本机路径')
  assert.equal(String(withPath.note).includes('secret.txt'), false)
  const long = diagnostics.recordRuntimeSpan({ ...EVENT_BASE, ok: true, note: 'x'.repeat(400) })
  assert.equal(long.note?.length, 160)
})

test('★ 轮内 / 轮外归属：recorder 存活期间挂该轮，finish 之后归轮外', () => {
  diagnostics.resetRuntimeSpansForTests()
  const recorder = new diagnostics.TurnDiagnosticsRecorder({
    turn: 7,
    requestId: 'req-span-7',
    text: '学生提问',
    gradeLevel: 'junior'
  })
  const inside = diagnostics.recordRuntimeSpan({ ...EVENT_BASE, ok: true, note: null })
  assert.equal(inside.turnIndex, 7)
  assert.equal(inside.offTurn, false)

  recorder.finish({ ok: true, status: 'done' })
  const outside = diagnostics.recordRuntimeSpan({ ...EVENT_BASE, ok: true, note: null })
  assert.equal(outside.offTurn, true, 'finish 之后没有活动轮 —— 启动补跑这类归轮外')
  assert.equal(outside.turnIndex, null)
})

test('★ 环形上限：只留最近 RUNTIME_SPAN_LIMIT 条；drain 取走即清空', () => {
  diagnostics.resetRuntimeSpansForTests()
  const total = diagnostics.RUNTIME_SPAN_LIMIT + 5
  for (let index = 0; index < total; index += 1) {
    diagnostics.recordRuntimeSpan({ ...EVENT_BASE, ok: true, note: null })
  }
  const drained = diagnostics.drainRuntimeSpans()
  assert.equal(drained.length, diagnostics.RUNTIME_SPAN_LIMIT)
  assert.equal(drained[0]?.id, 'span-6', '丢的是最早那 5 条')
  assert.equal(drained[drained.length - 1]?.id, 'span-' + String(total))
  assert.equal(diagnostics.drainRuntimeSpans().length, 0, '取走即清空')
  assert.equal(diagnostics.RUNTIME_SPAN_LIMIT, 20, '与轮次信封同口径')
})

test('★ 落盘脱敏：stripForPersistence 后 spans 里没有提示词/正文原文，也没有本机路径', () => {
  diagnostics.resetRuntimeSpansForTests()
  const PROMPT_MARK = 'SECRET-PROMPT-7f3a-别落盘'
  const ANSWER_MARK = 'SECRET-ANSWER-7f3a-别落盘'
  const recorder = new diagnostics.TurnDiagnosticsRecorder({
    turn: 3,
    requestId: 'req-span-3',
    text: '学生原话 ' + ANSWER_MARK,
    gradeLevel: 'junior'
  })
  recorder.notePrompt({
    prompt: '系统提示词 ' + PROMPT_MARK,
    gradeTemplate: 'junior',
    hostPathClean: true,
    overrides: []
  })
  const span = diagnostics.recordRuntimeSpan({
    ...EVENT_BASE,
    ok: false,
    note: '读取 C:\\Users\\me\\secret.txt 失败'
  })
  assert.equal(span.turnIndex, 3)

  const envelope = recorder.finish({ ok: false, status: 'error' })
  assert.equal(envelope.spans?.length, 1, '轮内 span 要挂进这一轮的信封')

  const stripped = diagnostics.stripForPersistence(envelope)
  const json = JSON.stringify(stripped)
  assert.equal(json.includes(PROMPT_MARK), false, '落盘那份不许有提示词原文')
  assert.equal(json.includes(ANSWER_MARK), false, '落盘那份不许有正文原文')
  assert.equal(json.includes('secret.txt'), false, '落盘那份不许有本机绝对路径')
  assert.equal(stripped.spans?.length, 1)
  assert.notEqual(stripped.spans?.[0], envelope.spans?.[0], 'span 也要深拷贝（不共享引用）')
  assert.equal(stripped.spans?.[0]?.promptChars, 100, '体量数字保留（证据页要它）')
  assert.equal(stripped.spans?.[0]?.promptTokEst, 60)
  assert.ok(String(stripped.spans?.[0]?.note).includes('«本机路径»'))
  // 内存那份仍保留原文（界面要用），只有落盘那份被剥
  assert.ok(envelope.prompt.segments.some((segment) => segment.text.includes(PROMPT_MARK)))
  assert.equal(stripped.prompt.segments.every((segment) => segment.text === ''), true)
})
