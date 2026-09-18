/**
 * sidecar 纯逻辑的单测（票 01 的启动命令解析 + 票 02 的行缓冲/握手解析/重启决策/脱敏/失败文案）。
 *
 * 跑法：`npm test`（内部即 `node --test`，扫 tests 目录下的 .test.ts）。
 * ★ 直接 import `.ts` 源文件，靠 Node 内置的类型擦除，不引入任何测试框架或构建步骤。
 *   Node 会打印一条 MODULE_TYPELESS_PACKAGE_JSON 警告：这是**预期**的，不影响结果。
 *   本仓库**有意不设** `"type": "module"` —— 主进程/preload 保持 CJS 产物，
 *   这样 `out/preload/index.js` 的路径才是稳定的（票 03 接 Pi 时若确实需要 ESM，再整体裁决）。
 * ★ 本文件（以及被测文件）不得使用 TS parameter property（`constructor(private readonly x)`），
 *   Node 的类型擦除模式会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  LINE_BUFFER_MAX_BYTES,
  LineBuffer,
  MAX_RESTARTS,
  PACKAGED_SERVER_EXE,
  decideRestart,
  describeStartupFailure,
  healthUrl,
  parseHandshakeLine,
  redactLogLine,
  resolveSidecarCommand,
  type SidecarPaths
} from '../src/main/sidecar/protocol.ts'

const paths: SidecarPaths = {
  serverDir: 'E:\\repo\\server',
  resourcesPath: 'E:\\app\\resources',
  // userData 的目录名是**固定 slug**（`src/main/index.ts` 的 applyStableUserDataSlug），
  // 刻意与品牌名解耦 —— 所以这里照实写 slug，不要换成产品显示名。
  dataDir: 'C:\\Users\\tester\\AppData\\Roaming\\k12-agent-desktop'
}

/** 测试用 token：64 位 hex（与 `randomBytes(32).toString('hex')` 同形）。 */
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

/** 统一成正斜杠，避免测试被平台分隔符影响。 */
function slash(value: string): string {
  return value.replace(/\\/g, '/')
}

/** 取 `--port` 后面的值（两种模式都应当拿到 '0'）。 */
function portArgOf(args: string[]): string | undefined {
  const index = args.indexOf('--port')
  return index === -1 ? undefined : args[index + 1]
}

/** 取 `--token` 后面的值。 */
function tokenArgOf(args: string[]): string | undefined {
  const index = args.indexOf('--token')
  return index === -1 ? undefined : args[index + 1]
}

// ── 启动命令解析 ──────────────────────────────────────────────────────────

test('dev 模式：用 uv run 起 server 目录下的 app.main', () => {
  const command = resolveSidecarCommand('dev', paths, TOKEN)

  assert.equal(command.command, 'uv', 'dev 态必须走 uv（本机裸 python 不可用）')
  assert.ok(
    command.args.join(' ').includes('-m app.main'),
    `dev 参数里必须有 "-m app.main"，实际为：${command.args.join(' ')}`
  )
  assert.equal(
    portArgOf(command.args),
    '0',
    `dev 参数里必须是 "--port 0"（端口由系统分配、从握手取），实际为：${command.args.join(' ')}`
  )
  assert.equal(tokenArgOf(command.args), TOKEN, `dev 参数里必须把 token 经 --token 传入`)
  assert.ok(
    command.args.includes('--data-dir') && command.args.includes(paths.dataDir),
    `dev 参数里必须把 --data-dir 传给 userData，实际为：${command.args.join(' ')}`
  )
  assert.ok(
    command.args.includes('--host') && command.args.includes('127.0.0.1'),
    `sidecar 只允许绑定回环地址，实际为：${command.args.join(' ')}`
  )
  assert.equal(command.cwd, paths.serverDir, 'dev 的 cwd 必须指向仓库的 server/')
  assert.ok(
    slash(command.cwd).endsWith('/server'),
    `dev 的 cwd 必须以 server 结尾，实际为：${command.cwd}`
  )
})

test('packaged 模式：直接跑冻结产物 k12-agent-server.exe', () => {
  const command = resolveSidecarCommand('packaged', paths, TOKEN)

  const expectedExe = join(paths.resourcesPath, 'server', PACKAGED_SERVER_EXE)
  assert.equal(
    command.command,
    expectedExe,
    `packaged 必须指向 <resourcesPath>/server/${PACKAGED_SERVER_EXE}，实际为：${command.command}`
  )
  assert.ok(
    slash(command.command).endsWith(`/server/${PACKAGED_SERVER_EXE}`),
    `packaged 命令必须以 ${PACKAGED_SERVER_EXE} 结尾，实际为：${command.command}`
  )
  assert.equal(
    command.cwd,
    join(paths.resourcesPath, 'server'),
    'packaged 的 cwd 必须是 sidecar 产物所在目录'
  )
  assert.equal(portArgOf(command.args), '0', `packaged 参数里必须是 "--port 0"`)
  assert.equal(tokenArgOf(command.args), TOKEN, `packaged 参数里必须把 token 经 --token 传入`)
  assert.ok(
    command.args.includes('--data-dir') && command.args.includes(paths.dataDir),
    `packaged 参数里必须有 --data-dir <userData>，实际为：${command.args.join(' ')}`
  )
  assert.ok(
    !command.args.includes('uv') && command.command !== 'uv',
    `packaged 态不得依赖 uv（终端用户没有 Python 环境），实际为：${command.command} ${command.args.join(' ')}`
  )
})

test('两种模式都不再写死端口：--port 0 由系统分配，真实端口来自握手', () => {
  for (const mode of ['dev', 'packaged'] as const) {
    const args = resolveSidecarCommand(mode, paths, TOKEN).args
    assert.equal(portArgOf(args), '0', `${mode} 必须用 --port 0`)
    assert.ok(
      !args.includes('8756'),
      `${mode} 不得再出现固定的 8756（那是手工起后端用的），实际为：${args.join(' ')}`
    )
  }
})

test('healthUrl 只拼回环地址', () => {
  assert.equal(healthUrl(8756), 'http://127.0.0.1:8756/health')
  assert.equal(healthUrl(51234), 'http://127.0.0.1:51234/health')
})

// ── LineBuffer：半行 / 多行 / 残行 / 上限 ────────────────────────────────

test('LineBuffer：一行被切成两片时，只有第二片到达后才是完整行', () => {
  const buffer = new LineBuffer()
  const line = '{"event":"ready","port":54321,"pid":12345}'

  assert.deepEqual(buffer.push(line.slice(0, 12)), [], '半行不应当成完整行交出去')
  assert.equal(buffer.pendingBytes, 12, '半行必须留在缓冲里')
  assert.deepEqual(buffer.push(line.slice(12) + '\n'), [line], '第二片补齐后才应当交出一整行')
  assert.equal(buffer.pendingBytes, 0, '交出完整行后缓冲应当清空')
})

test('LineBuffer：一片里有多行时全部交出（含最后一行带 \\n）', () => {
  const buffer = new LineBuffer()
  const lines = buffer.push('INFO: one\n{"event":"ready"}\n\n')

  assert.deepEqual(lines, ['INFO: one', '{"event":"ready"}', ''])
  assert.equal(buffer.pendingBytes, 0)
})

test('LineBuffer：尾部残行留在缓冲里，flush() 才交出来', () => {
  const buffer = new LineBuffer()
  assert.deepEqual(buffer.push('{"event":"ready"}\n{"event":"err'), ['{"event":"ready"}'])

  assert.equal(buffer.flush(), '{"event":"err', 'flush 必须返回没有换行的残行')
  assert.equal(buffer.flush(), null, 'flush 之后残行应当被取走，再 flush 为 null')
})

test('LineBuffer：超过 1 MiB 上限即丢弃并上报，不无上限增长', () => {
  const overflows: number[] = []
  const buffer = new LineBuffer({
    onOverflow: (info) => overflows.push(info.droppedBytes)
  })

  const huge = 'a'.repeat(LINE_BUFFER_MAX_BYTES + 1)
  assert.deepEqual(buffer.push(huge), [], '超限的残行不应当被交出去')
  assert.equal(buffer.pendingBytes, 0, '超限后缓冲必须被丢弃，而不是继续增长')
  assert.equal(buffer.flush(), null, '丢弃后没有残行')
  assert.equal(overflows.length, 1, '超限必须上报一次')
  assert.equal(buffer.droppedBytes, LINE_BUFFER_MAX_BYTES + 1, '上报的丢弃字节数要准确')

  // 超限不能把缓冲「卡死」：后续正常行仍然要能解析出来
  assert.deepEqual(buffer.push('{"event":"ready"}\n'), ['{"event":"ready"}'])

  // 刚好等于上限不触发（边界）——只比长度，避免失败时打印一兆字符
  const boundary = buffer.push('b'.repeat(LINE_BUFFER_MAX_BYTES) + '\n')
  assert.equal(boundary.length, 1, '等于上限的行应当照常交出')
  assert.equal(boundary[0].length, LINE_BUFFER_MAX_BYTES)
  assert.equal(buffer.overflows, 1)

  buffer.reset()
  assert.equal(buffer.droppedBytes, 0)
  assert.equal(buffer.overflows, 0)
  assert.equal(buffer.pendingBytes, 0)
})

// ── parseHandshakeLine ───────────────────────────────────────────────────

const READY_LINE = '{"event":"ready","port":54321,"pid":12345,"version":"0.1.0","frozen":false}'

test('parseHandshakeLine：合法 ready 行解析出端口与后端 pid', () => {
  assert.deepEqual(parseHandshakeLine(READY_LINE), {
    kind: 'ready',
    port: 54321,
    pid: 12345,
    version: '0.1.0',
    frozen: false
  })
})

test('parseHandshakeLine：CRLF 结尾的 ready 行照样认（先削掉 \\r 与空白）', () => {
  const result = parseHandshakeLine(`${READY_LINE}\r`)
  assert.equal(result.kind, 'ready', `CRLF 行应当被认成 ready，实际为 ${JSON.stringify(result)}`)

  const padded = parseHandshakeLine('  {"event":"ready","port":1,"pid":2}  \r')
  assert.equal(padded.kind, 'ready', '两端空白不应当影响解析')
})

test('parseHandshakeLine：畸形 ready 行一律 ignore，绝不当作 ready', () => {
  const malformed = [
    '{"event":"ready","port":0,"pid":12345}', // port 0（系统分配失败的典型症状）
    '{"event":"ready","port":99999999,"pid":12345}', // 端口越界
    '{"event":"ready","port":-1,"pid":12345}',
    '{"event":"ready","port":54321.5,"pid":12345}', // 非整数端口
    '{"event":"ready","pid":12345}', // 缺 port
    '{"event":"ready","port":54321}', // 缺 pid
    '{"event":"ready","port":54321,"pid":0}', // pid 0
    '{"event":"ready","port":54321,"pid":-7}',
    '{"event":"ready","port":"54321","pid":12345}', // 字符串端口（契约是 number）
    '{"event":"ready","port":null,"pid":12345}',
    '{"event":"ready","port":54321,"pid":null}',
    '{"port":54321,"pid":12345}', // 没有 event
    '[]',
    '"ready"'
  ]

  for (const line of malformed) {
    assert.equal(
      parseHandshakeLine(line).kind,
      'ignore',
      `畸形 ready 行必须返回 ignore，实际不是：${line}`
    )
  }
})

test('parseHandshakeLine：半行只是 ignore —— 拼接是 LineBuffer 的职责，不是解析器的', () => {
  const half = '{"event":"ready","port":54'
  assert.equal(parseHandshakeLine(half).kind, 'ignore', '半行 JSON 不应当被猜成 ready')

  // 交给行缓冲拼起来之后，同一个逻辑行才成立
  const buffer = new LineBuffer()
  assert.deepEqual(buffer.push(half), [])
  const [completeLine] = buffer.push('321,"pid":12345}\n')
  assert.deepEqual(parseHandshakeLine(completeLine), {
    kind: 'ready',
    port: 54321,
    pid: 12345,
    version: 'unknown',
    frozen: false
  })
})

test('parseHandshakeLine：空行 / 日志行 / 非 JSON 一律 ignore（只记日志，绝不当错误）', () => {
  for (const line of ['', '   ', '\t', 'INFO:     Started server process [12345]', 'uvicorn running on http://127.0.0.1:54321', '{不是 JSON}']) {
    const result = parseHandshakeLine(line)
    assert.equal(result.kind, 'ignore', `应当 ignore：${JSON.stringify(line)}`)
    if (result.kind === 'ignore') {
      assert.ok(!result.line.includes('\n'), 'ignore 结果里不带换行')
      assert.ok(!result.line.includes('\r'), 'ignore 结果里不带 \\r')
    }
  }
})

test('parseHandshakeLine：error 事件给出可读中文原因；缺原因也有兜底文案', () => {
  assert.deepEqual(parseHandshakeLine('{"event":"error","message":"端口被占用"}'), {
    kind: 'error',
    message: '端口被占用'
  })

  const noMessage = parseHandshakeLine('{"event":"error"}')
  assert.equal(noMessage.kind, 'error')
  if (noMessage.kind === 'error') {
    assert.ok(noMessage.message.trim().length > 0, '兜底文案不能为空（UI 不允许白屏）')
  }

  const blankMessage = parseHandshakeLine('{"event":"error","message":"   "}')
  assert.equal(blankMessage.kind, 'error')
})

test('parseHandshakeLine：frozen 只有明确为 true 才算 true', () => {
  const frozen = parseHandshakeLine('{"event":"ready","port":5000,"pid":9,"version":"1.2.3","frozen":true}')
  assert.equal(frozen.kind, 'ready')
  if (frozen.kind === 'ready') {
    assert.equal(frozen.frozen, true)
    assert.equal(frozen.version, '1.2.3')
  }

  const notFrozen = parseHandshakeLine('{"event":"ready","port":5000,"pid":9,"frozen":"true"}')
  assert.equal(notFrozen.kind, 'ready')
  if (notFrozen.kind === 'ready') assert.equal(notFrozen.frozen, false, '字符串 "true" 不算 true')
})

// ── decideRestart ────────────────────────────────────────────────────────

const restartBase = {
  exitCode: 1,
  signal: null,
  shuttingDown: false,
  intentionalKill: false,
  wasUsable: true,
  restarts: 0
}

test('decideRestart：应用正在退出时绝不重启', () => {
  const decision = decideRestart({ ...restartBase, shuttingDown: true })
  assert.equal(decision.restart, false)
  assert.ok(decision.reason.length > 0, '不给重启也要给原因（要写日志）')
})

test('decideRestart：主动 kill 的退出不算崩溃，不重启', () => {
  const decision = decideRestart({ ...restartBase, intentionalKill: true })
  assert.equal(decision.restart, false)
})

test('decideRestart：从未就绪过就不重启（配置/环境错误重启只会原样再失败）', () => {
  const decision = decideRestart({ ...restartBase, wasUsable: false })
  assert.equal(decision.restart, false)
  assert.ok(
    decision.reason.includes('就绪') || decision.reason.includes('配置'),
    `原因应当指向「未就绪/配置问题」，实际为：${decision.reason}`
  )
})

test('decideRestart：就绪后崩溃允许重启一次，第二次退出就放弃', () => {
  assert.equal(MAX_RESTARTS, 1, '§7.4：非正常退出只重启一次')

  const first = decideRestart({ ...restartBase, restarts: 0 })
  assert.equal(first.restart, true, '第一次崩溃应当重启')
  assert.ok(first.reason.includes('1'), `原因里应带上第几次重启，实际为：${first.reason}`)

  const second = decideRestart({ ...restartBase, restarts: 1 })
  assert.equal(second.restart, false, '额度用尽后不得再重启')

  const custom = decideRestart({ ...restartBase, restarts: 1, maxRestarts: 3 })
  assert.equal(custom.restart, true, 'maxRestarts 可覆盖（默认 1）')
})

// ── redactLogLine ────────────────────────────────────────────────────────

test('redactLogLine：token、裸 hex、sk- Key 全部消失，普通行原样保留', () => {
  const line = `[manager] spawn: uv run python -m app.main --token ${TOKEN} (cwd=E:/repo/server)`
  const redacted = redactLogLine(line, [TOKEN])

  assert.ok(!redacted.includes(TOKEN), 'token 绝不能出现在日志里')
  assert.ok(redacted.includes('--token'), '只擦值，不擦参数名（否则看不出这里本该有 token）')
  assert.ok(redacted.includes('uv run python -m app.main'), '普通命令片段必须保留')

  const hex = 'f'.repeat(64)
  assert.ok(
    !redactLogLine(`Authorization: ${hex}`, []).includes(hex),
    '没显式给 secrets 时，裸 hex（≥32 位）也要被擦掉'
  )

  const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz012345'
  const keyLine = redactLogLine(`llm api key = ${apiKey}`, [])
  assert.ok(!keyLine.includes(apiKey), 'sk- 形态的 API Key 必须被擦掉')

  const ordinary = 'INFO:     Started server process [12345]'
  assert.equal(redactLogLine(ordinary, [TOKEN]), ordinary, '普通日志行必须原样保留')
  assert.equal(redactLogLine('uv run --port 0', []), 'uv run --port 0', '短词一律不动')
})

test('redactLogLine：同一行里多个秘密一起擦，且不删空整行', () => {
  const hex = '0123456789abcdef0123456789abcdef'
  const line = `token=${TOKEN} key=sk-0123456789abcdefghij trailing`
  const redacted = redactLogLine(line, [TOKEN, hex])

  assert.ok(!redacted.includes(TOKEN))
  assert.ok(!redacted.includes('sk-0123456789abcdefghij'))
  assert.ok(redacted.includes('trailing'), '行尾普通内容不能被抹掉')
  assert.ok(redacted.trim().length > 0)
})

// ── describeStartupFailure ───────────────────────────────────────────────

test('describeStartupFailure：每种失败都给非空中文句子，且不含堆栈', () => {
  const cases = [
    describeStartupFailure({ kind: 'timeout', timeoutMs: 30_000, port: 54321 }),
    describeStartupFailure({ kind: 'timeout', timeoutMs: 30_000, port: null }),
    describeStartupFailure({ kind: 'handshake', message: '端口被占用' }),
    describeStartupFailure({ kind: 'spawn', message: 'spawn uv ENOENT' }),
    describeStartupFailure({ kind: 'unusable', exitCode: 3, signal: null }),
    describeStartupFailure({ kind: 'unusable', exitCode: null, signal: 'SIGKILL' }),
    describeStartupFailure({ kind: 'restart-exhausted', restarts: 1, exitCode: 1, signal: null })
  ]

  for (const text of cases) {
    assert.ok(text.trim().length > 0, 'UI 不允许白屏：失败文案不能为空')
    assert.ok(!text.includes('\n'), '文案是一句话，不要多行堆栈')
    assert.ok(!text.includes('    at '), '文案里不许出现堆栈帧')
  }

  assert.ok(cases[0].includes('30'), '超时文案要带上 30 秒与人话解释')
  assert.ok(cases[0].includes('54321'), '超时文案要带上最后一次握手的端口')
  assert.ok(cases[4].includes('3'), '退出场景要带上退出码')
  assert.ok(cases[5].includes('SIGKILL'), '被信号杀死时要带上信号名')
  assert.ok(cases[3].includes('spawn uv ENOENT'), 'spawn 失败要带上原始原因')
})

test('describeStartupFailure：带日志路径时把路径写进文案（让用户知道去哪找线索）', () => {
  const logPath = 'C:\\Users\\tester\\AppData\\Roaming\\k12-agent-desktop\\logs\\sidecar.log'
  const text = describeStartupFailure({ kind: 'timeout', timeoutMs: 30_000, port: null }, { logPath })
  assert.ok(text.includes(logPath), `文案里应当带上日志路径，实际为：${text}`)
})
