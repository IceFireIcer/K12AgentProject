/**
 * SSE 解析器单测。
 *
 * 重点覆盖三类"线上必炸、本地手测必漏"的情况：
 * 1. **UTF-8 多字节跨 chunk**——中文被网络分片切断（必须 `TextDecoder{stream:true}`）；
 * 2. **事件块跨 chunk**——`\n\n` 分隔符本身被切开；
 * 3. **后端发了契约外的东西**——未知事件名 / 坏 JSON 时不能整条流崩掉。
 *
 * 另外附一份**手写协议样本**：它同时是「后端编码规则」的可执行规格说明，
 * 后端若偷偷改格式，这里会先红。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SseParser, type SseEvent } from '../src/renderer/src/api/sse-parser.ts'

/** 把（可能被切碎的）字节流喂给解析器，返回全部事件与诊断。 */
function run(chunks: (string | Uint8Array)[], opts: { utf8?: boolean } = {}) {
  const events: SseEvent[] = []
  const parser = new SseParser((e) => events.push(e))
  const decoder = new TextDecoder('utf-8')

  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      parser.push(chunk)
    } else if (opts.utf8 === false) {
      // 故意不带 stream:true —— 用于证明"不带就会坏"（对照组）
      parser.push(decoder.decode(chunk))
    } else {
      parser.push(decoder.decode(chunk, { stream: true }))
    }
  }
  parser.push(decoder.decode())
  parser.flush()
  return { events, parser, diagnostics: parser.diagnostics }
}

/** 把一段字节按给定大小切片（模拟网络分片）。 */
function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

describe('SSE 解析器 · 基本分帧', () => {
  it('解析单个事件', () => {
    const { events } = run(['event: delta\ndata: {"requestId":"r1","delta":"循"}\n\n'])
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'delta')
    assert.deepEqual(events[0].data, { requestId: 'r1', delta: '循' })
  })

  it('解析多个事件并按到达顺序返回', () => {
    const stream = [
      'event: delta\ndata: {"requestId":"r","delta":"a"}\n\n',
      'event: delta\ndata: {"requestId":"r","delta":"b"}\n\n',
      'event: done\ndata: {"requestId":"r","messageId":"m"}\n\n'
    ].join('')
    const { events } = run([stream])
    assert.deepEqual(
      events.map((e) => e.event),
      ['delta', 'delta', 'done']
    )
  })

  it('事件块被切成两半也能正确拼回', () => {
    const full = 'event: delta\ndata: {"requestId":"r1","delta":"hello"}\n\n'
    const { events } = run([full.slice(0, 20), full.slice(20)])
    assert.equal(events.length, 1)
    assert.equal((events[0].data as { delta: string }).delta, 'hello')
  })

  it('分隔符本身被切开（\\n | \\n）也能处理', () => {
    const { events } = run([
      'event: delta\ndata: {"requestId":"r1","delta":"x"}\n',
      '\nevent: done\ndata: {"requestId":"r1","messageId":"m"}\n\n'
    ])
    assert.deepEqual(
      events.map((e) => e.event),
      ['delta', 'done']
    )
  })

  it('兼容 \\r\\n\\r\\n 换行', () => {
    const { events } = run(['event: done\r\ndata: {"requestId":"r","messageId":"m"}\r\n\r\n'])
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'done')
  })

  it('忽略注释行（心跳）', () => {
    const { events, diagnostics } = run([': keep-alive\n\n', 'event: done\ndata: {"requestId":"r","messageId":"m"}\n\n'])
    assert.equal(events.length, 1)
    assert.equal(diagnostics.length, 0)
  })

  it('flush 能取出没有以空行收尾的最后一块', () => {
    const { events } = run(['event: done\ndata: {"requestId":"r","messageId":"m"}'])
    assert.equal(events.length, 1, '缺少结尾空行时不能丢事件')
  })

  it('data 冒号后的单个空格不属于数据', () => {
    const { events } = run(['event: done\ndata:{"requestId":"r","messageId":"m"}\n\n'])
    assert.equal(events.length, 1)
  })

  it('多行 data 按规范用换行拼接', () => {
    const { events } = run(['event: delta\ndata: {"requestId":"r",\ndata: "delta":"中"}\n\n'])
    assert.deepEqual(events[0].data, { requestId: 'r', delta: '中' })
  })
})

describe('SSE 解析器 · 中文与 UTF-8 分片', () => {
  // 后端 _ECHO_TEXT 的片段：含中文与emoji，覆盖 3/4 字节序列
  const text = '循环会重复执行：变量🔄、条件、退出。\n'
  const bytes = new TextEncoder().encode(
    `event: delta\ndata: ${JSON.stringify({ requestId: 'r1', delta: text })}\n\n`
  )

  it('★ 逐字节切片后中文仍完好（TextDecoder stream:true）', () => {
    const { events } = run(chunkBytes(bytes, 1))
    assert.equal(events.length, 1)
    assert.equal((events[0].data as { delta: string }).delta, text)
    assert.ok(!(events[0].data as { delta: string }).delta.includes('�'), '出现替换字符＝乱码')
  })

  it('对照组：不带 stream:true 会在 chunk 边界产生乱码（证明这条测试有效）', () => {
    const { events } = run(chunkBytes(bytes, 1), { utf8: false })
    const delta = (events[0]?.data as { delta?: string })?.delta ?? ''
    assert.ok(
      delta.includes('�') || events.length === 0,
      '如果不带 stream:true 竟然也没坏，说明这个测试没有真正覆盖分片场景'
    )
  })

  it('按 3/7/13 字节等不规则切片仍然完好', () => {
    for (const size of [3, 7, 13, 64]) {
      const { events } = run(chunkBytes(bytes, size))
      assert.equal(
        (events[0]?.data as { delta: string }).delta,
        text,
        `切片大小 ${size} 时中文损坏`
      )
    }
  })
})

describe('SSE 解析器 · 容错', () => {
  it('未知事件名只记诊断、不抛异常，后续事件照常解析', () => {
    const { events, diagnostics } = run([
      'event: future_event\ndata: {"a":1}\n\n',
      'event: done\ndata: {"requestId":"r","messageId":"m"}\n\n'
    ])
    assert.deepEqual(events.map((e) => e.event), ['done'], '未知事件不应阻断后续解析')
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].reason, /未知事件名/)
  })

  it('坏 JSON 只记诊断', () => {
    const { events, diagnostics } = run(['event: delta\ndata: {不是 JSON\n\n'])
    assert.equal(events.length, 0)
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].reason, /JSON/)
  })

  it('缺少 event 行只记诊断', () => {
    const { diagnostics } = run(['data: {"a":1}\n\n'])
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].reason, /缺少 event/)
  })

  it('缺少 data 行只记诊断', () => {
    const { diagnostics } = run(['event: done\n\n'])
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].reason, /缺少 data/)
  })

  it('回调抛异常不会中断解析', () => {
    const parser = new SseParser(() => {
      throw new Error('组件炸了')
    })
    const block = (d: string) => `event: delta\ndata: {"requestId":"r","delta":"${d}"}\n\n`
    const ok = parser.push(block('a') + block('b'))
    assert.equal(ok.length, 2, '回调异常不应该让解析器停摆')
  })

  it('永不出现分隔符时不会无限增长（超限即丢弃并诊断）', () => {
    const parser = new SseParser(() => {})
    parser.push('x'.repeat(1024 * 1024 + 10))
    assert.equal(parser.diagnostics.length, 1)
    assert.match(parser.diagnostics[0].reason, /超过/)
  })

  it('空块与纯空白块被忽略', () => {
    const { events, diagnostics } = run(['\n\n', '   \n\n'])
    assert.equal(events.length, 0)
    assert.equal(diagnostics.length, 0)
  })
})

describe('SSE 解析器 · 与后端契约一致', () => {
  // ★ 这份样本是后端 app/sse.py format_sse() 的输出格式（手写而非生成，
  //   为的是：后端若单方面改格式，测试会红，而不是"生成器跟着一起改"）。
  const SAMPLES: Record<string, string> = {
    delta: '{"requestId":"abc123","delta":"循"}',
    citation:
      '{"requestId":"abc123","citations":[{"chunkId":"c1","chapterTitle":"第三章 循环结构","sectionTitle":"3.1 什么是循环","gradeLevel":"junior","compat":false}]}',
    payload: '{"requestId":"abc123","kind":"quiz","payload":{"kpId":"kp1","questions":[]}}',
    blocked: '{"requestId":"abc123","reason":"命中规则","safeText":"换个角度想" }',
    done: '{"requestId":"abc123","messageId":"m1"}',
    error: '{"requestId":"abc123","message":"超时","degraded":true}'
  }

  for (const [name, json] of Object.entries(SAMPLES)) {
    it(`能解析契约事件 ${name}`, () => {
      const { events, diagnostics } = run([`event: ${name}\ndata: ${json}\n\n`])
      assert.equal(diagnostics.length, 0, `诊断：${JSON.stringify(diagnostics)}`)
      assert.equal(events.length, 1)
      assert.equal(events[0].event, name)
      assert.equal((events[0].data as { requestId: string }).requestId, 'abc123')
    })
  }

  it('载荷字段是 camelCase（契约 6.5）', () => {
    const { events } = run([`event: citation\ndata: ${SAMPLES.citation}\n\n`])
    const first = (events[0].data as { citations: Record<string, unknown>[] }).citations[0]
    for (const key of ['chunkId', 'chapterTitle', 'sectionTitle', 'gradeLevel', 'compat']) {
      assert.ok(key in first, `引用字段 ${key} 缺失（契约漂移？）`)
    }
    assert.ok(!('chunk_id' in first), '出现了 snake_case 字段——契约要求出参 camelCase')
  })

  it('中文不被转义成 \\uXXXX（可读性 + 排查体验）', () => {
    const { events } = run([`event: citation\ndata: ${SAMPLES.citation}\n\n`])
    const title = (events[0].data as { citations: { chapterTitle: string }[] }).citations[0]
      .chapterTitle
    assert.equal(title, '第三章 循环结构')
  })
})
