/**
 * sidecar 纯逻辑单测（不依赖 Electron，Node 原生 TS 直接跑）：
 *   cd desktop && npm test
 *
 * 覆盖三处最容易翻车的地方：stdout 半行 JSON、退出重启判定、日志脱敏。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  LineBuffer,
  decideRestart,
  describeStartupFailure,
  parseHandshakeLine,
  redactLogLine,
  type RestartContext
} from '../src/main/sidecar-logic.ts'

describe('parseHandshakeLine', () => {
  test('解析 ready 握手（含后端自报 pid）', () => {
    const out = parseHandshakeLine(
      '{"event":"ready","port":8756,"pid":1234,"version":"0.1.0","frozen":false}'
    )
    assert.deepEqual(out, {
      kind: 'ready',
      port: 8756,
      pid: 1234,
      version: '0.1.0',
      frozen: false
    })
  })

  test('★ pid 非法/缺失时给 null（退出清理由此兜底，不能因脏数据抛错）', () => {
    for (const pid of [undefined, 0, -5, 1.5, '1234', null]) {
      const out = parseHandshakeLine(JSON.stringify({ event: 'ready', port: 5000, pid }))
      assert.equal(out.kind, 'ready', `pid=${String(pid)} 不应导致忽略整条握手`)
      assert.equal((out as { pid: number | null }).pid, null)
    }
  })

  test('解析后端的 error 握手', () => {
    const out = parseHandshakeLine('{"event":"error","message":"数据目录不可用"}')
    assert.deepEqual(out, { kind: 'error', message: '数据目录不可用' })
  })

  test('无 message 的 error 也要给人话', () => {
    const out = parseHandshakeLine('{"event":"error"}')
    assert.equal(out.kind, 'error')
    assert.match((out as { message: string }).message, /启动失败/)
  })

  test('非 JSON 行（第三方库直接 print）必须忽略而非抛错', () => {
    const out = parseHandshakeLine('INFO:     Started server process [1234]')
    assert.equal(out.kind, 'ignore')
  })

  test('JSON 但不是对象 → 忽略', () => {
    assert.equal(parseHandshakeLine('"hello"').kind, 'ignore')
    assert.equal(parseHandshakeLine('42').kind, 'ignore')
  })

  test('未知 event → 忽略', () => {
    assert.equal(parseHandshakeLine('{"event":"progress","value":50}').kind, 'ignore')
  })

  test('端口非法（0 / 负数 / 越界 / 非整数 / 缺失 / 字符串）一律忽略', () => {
    for (const port of [0, -1, 70000, 1.5, undefined, '8756']) {
      const line = JSON.stringify({ event: 'ready', port })
      assert.equal(parseHandshakeLine(line).kind, 'ignore', `port=${String(port)} 应被忽略`)
    }
  })

  test('version 缺失时给 null，不崩', () => {
    const out = parseHandshakeLine('{"event":"ready","port":5000}')
    assert.deepEqual(out, { kind: 'ready', port: 5000, version: null, frozen: false, pid: null })
  })

  test('首尾空白与 \\r（Windows CRLF）不影响解析', () => {
    const out = parseHandshakeLine('  {"event":"ready","port":8080}\r ')
    assert.equal(out.kind, 'ready')
  })
})

describe('LineBuffer', () => {
  test('一次给完整行', () => {
    const buf = new LineBuffer()
    assert.deepEqual(buf.push('{"a":1}\n'), ['{"a":1}'])
  })

  test('★ 半行 JSON：跨 chunk 拼接后才完整', () => {
    const buf = new LineBuffer()
    assert.deepEqual(buf.push('{"event":"rea'), [])
    assert.deepEqual(buf.push('dy","port":8756}\n'), ['{"event":"ready","port":8756}'])
  })

  test('★ 逐字节喂入也能还原（最坏情况的流式切分）', () => {
    const buf = new LineBuffer()
    const payload = '{"event":"ready","port":8756}\n'
    const lines: string[] = []
    for (const ch of payload) lines.push(...buf.push(ch))
    assert.deepEqual(lines, ['{"event":"ready","port":8756}'])
  })

  test('一个 chunk 含多行', () => {
    const buf = new LineBuffer()
    assert.deepEqual(buf.push('a\nb\nc\n'), ['a', 'b', 'c'])
  })

  test('多行 + 尾部半行：半行留到下次', () => {
    const buf = new LineBuffer()
    assert.deepEqual(buf.push('a\nb\npar'), ['a', 'b'])
    assert.equal(buf.pending, 'par')
    assert.deepEqual(buf.push('tial\n'), ['partial'])
  })

  test('空行照常产出（由上层决定忽略）', () => {
    const buf = new LineBuffer()
    assert.deepEqual(buf.push('\n\n'), ['', ''])
  })

  test('flush 取出未换行收尾的残余；无残余给 null', () => {
    const buf = new LineBuffer()
    buf.push('no-newline')
    assert.equal(buf.flush(), 'no-newline')
    assert.equal(buf.flush(), null)
  })

  test('超长无换行输出不会无限占用内存', () => {
    const buf = new LineBuffer()
    const huge = 'x'.repeat((1 << 20) + 10)
    const lines = buf.push(huge)
    assert.equal(lines.length, 1)
    assert.equal(buf.pending, '')
  })
})

describe('decideRestart', () => {
  const base: RestartContext = {
    wasUsable: true,
    restarts: 0,
    shuttingDown: false,
    intentionalKill: false,
    maxRestarts: 1
  }

  test('就绪后意外退出 → 重启', () => {
    assert.equal(decideRestart(base).action, 'restart')
  })

  test('★ 关闭应用中退出 → 绝不重启（否则退出时复活成孤儿进程）', () => {
    assert.equal(decideRestart({ ...base, shuttingDown: true }).action, 'fail')
  })

  test('★ 主动杀掉（超时兜底/清理）→ 不重启', () => {
    assert.equal(decideRestart({ ...base, intentionalKill: true }).action, 'fail')
  })

  test('★ 从未就绪就挂 → 不重启，直接报错（配置错误重试还是错）', () => {
    const d = decideRestart({ ...base, wasUsable: false })
    assert.equal(d.action, 'fail')
  })

  test('重启配额用尽 → 失败并给出可读提示', () => {
    const d = decideRestart({ ...base, restarts: 1 })
    assert.equal(d.action, 'fail')
    assert.match((d as { message: string }).message, /自动重启后仍未恢复/)
  })

  test('配额未用尽 → 继续重启', () => {
    assert.equal(decideRestart({ ...base, restarts: 0, maxRestarts: 2 }).action, 'restart')
  })
})

describe('redactLogLine', () => {
  test('★ 传入的 token 被抹掉', () => {
    const token = 'a'.repeat(64)
    const out = redactLogLine(`token=${token} ok`, [token])
    assert.ok(!out.includes(token))
    assert.match(out, /\*\*\*/)
  })

  test('★ 未见过的长 hex 串（如 token 泄漏到 stderr）也会被抹掉', () => {
    const leaked = 'f3a9'.repeat(16) // 64 位 hex
    const out = redactLogLine(`auth header: ${leaked}`)
    assert.ok(!out.includes(leaked), `未脱敏：${out}`)
  })

  test('API Key 形态被抹掉', () => {
    const out = redactLogLine('using key sk-abcdef1234567890 for request')
    assert.ok(!out.includes('sk-abcdef1234567890'))
  })

  test('普通文本不受影响', () => {
    const line = 'INFO: Application startup complete.'
    assert.equal(redactLogLine(line), line)
  })

  test('短 hex（如 pid、端口）不被误伤', () => {
    assert.equal(redactLogLine('port=8756 pid=1234'), 'port=8756 pid=1234')
  })
})

describe('describeStartupFailure', () => {
  test('缺文件 → 安装包不完整', () => {
    assert.match(describeStartupFailure('ENOENT: no such file'), /安装包可能不完整/)
  })

  test('超时 → 提示安全软件', () => {
    assert.match(describeStartupFailure('sidecar 启动超时（30s）'), /超时/)
  })

  test('无原因也给可读文案', () => {
    assert.ok(describeStartupFailure(null).length > 0)
  })
})
