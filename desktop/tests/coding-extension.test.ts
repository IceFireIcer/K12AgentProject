/**
 * 票 18/19 的**主进程**守卫与单测：编程 Extension（`get_code_template` / `get_coding_hint` /
 * `evaluate_code`）+ ★★ 那条硬约束的静态证据。
 *
 * ---------------------------------------------------------------------------
 * ★★ G18-1：学生代码**绝不在 Electron 主进程执行**（票 18 的架构守卫）
 * ---------------------------------------------------------------------------
 *
 * 为什么这条必须有测试：Pi 的 Extension 与 Agent **同进程**，而 Agent 跑在主进程里、
 * 拥有完整系统权限（能 spawn、能读写任意文件）。一旦有人为了「省事」在 Tool 里
 * `import('pyodide')` 或 `eval(code)`，三重隔离（动画 iframe / Pyodide Worker / 主线程）
 * 就被悄悄击穿 —— **功能上完全看不出来**（本地跑得好好的），只有安全边界没了。
 *
 * 所以这条守卫写成**静态断言**（扫 `src/main/**` 的源码），不是行为断言：
 *   ① 主进程任何文件不得 import `pyodide`（连类型都不行）；
 *   ② 主进程不得出现 `eval(` / `new Function(` / `node:vm` 这类执行原语；
 *   ③ `coding.ts` 里不得出现「执行学生代码」的调用点（它只有 `runner(...)` 一个出口）；
 *   ④ **正向**断言：`evaluate_code` 的执行出口是那个可注入的 `codeRunner` 接缝 ——
 *      证明「代码是发出去的，不是在这里跑的」。
 *
 * 与之互补的另一半在 `renderer` 侧（Worker 里真的执行）与 `server` 侧
 * （`server/tests/test_code_templates.py` 断言服务端也没有执行原语）。
 *
 * ---------------------------------------------------------------------------
 * G18-2：`setInterruptBuffer` 的死循环中断链（本票的头号演示）
 * ---------------------------------------------------------------------------
 *
 * 主进程这一侧只能保证「中断结果被正确识别与呈现」：`interrupted` 标志、
 * `KeyboardInterrupt` 走「停不下来」的文案、以及 `evaluate_code` 仍返回可读结果
 * 而**不是抛异常**（抛出去会同时带走 UI —— Pi 与 UI 同进程）。
 *
 * 真正的中断在 `sandbox/pyodide.worker.ts`（`setInterruptBuffer` + `Atomics.store(SIGINT)`）。
 * ⚠️ **事实澄清**：那条链**没有**端到端 CDP 断言 —— `scripts/verify-ui.mjs` 里
 *    `grep -ci pyodide` = 0，它不碰 Pyodide，也不碰编程卡片的执行通道。
 *    （这里以前写的是「由 verify-ui 的 CDP 断言端到端验证」，那句话不成立。）
 *    当前覆盖的实际边界是：
 *      · 本文件 G18-1* —— 主进程侧的静态守卫与桥的纯逻辑单测；
 *      · 本文件 G18-1c2/c3 —— 渲染进程入口 + 主进程 handler 的**接线**静态守卫；
 *      · 本文件 G18-1e2 —— `installCodeExecutionBridge` 的注入式单测（假 bridge + 假 runner）；
 *      · Worker 内部的真实执行与中断**只有** `pyodide.worker.ts` 自身的代码路径，
 *        **没有自动化端到端覆盖** —— 现场演示前必须手点一次死循环验证「停止」。
 *
 * ---------------------------------------------------------------------------
 * G19-*：报错感知 / 分级提示不跳级 / 连续失败 3 次主动介入
 * ---------------------------------------------------------------------------
 *
 * 跑法：`npm test`（Node 内置类型擦除 + 内置断言，不引入测试框架）。
 * 本文件用**假的 codeRunner + 假的 sidecar 请求出口**，所以不需要 Electron、
 * 不需要 Pyodide、不需要启动 sidecar —— 全链路逻辑都能在这里跑。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  bindAgentSession,
  type AgentExtensionApi,
  type AgentToolDefinition
} from '../src/main/agent/extensions/index.ts'
import {
  bindCodeRunner,
  CODE_RUN_TIMEOUT_MS,
  CODING_PAYLOAD_KIND,
  createCodingExtension,
  createCodingSessionState,
  codeRequestHash,
  createRendererCodeRunner,
  EvaluateCodeParams,
  GetCodeTemplateParams,
  GetCodingHintParams,
  isCodeRunnerBound,
  MAX_CONSECUTIVE_FAILURES,
  MAX_HINT_LEVEL,
  renderEvaluationText,
  resolveCodeRunner,
  RUNNER_TIMEOUT_TEXT,
  RUNNER_UNWIRED_TEXT,
  type CodeRunOutcome,
  type CodeRunRequest,
  type CodeRunner
} from '../src/main/agent/extensions/coding.ts'
// ★ 渲染进程侧：执行桥（主进程下发 → 渲染进程 Pyodide Worker 执行 → 回传）
import { installCodeExecutionBridge } from '../src/renderer/src/sandbox/pyodide-runner.ts'
// ★ 轨迹的失败判据（载荷 `toolOk` 的**读取方**：这条断言就是「学生写错 ≠ 工具失败」的落点）
import { toolResultOk } from '../src/main/agent/trace.ts'
// ★ 学习记录回流的判据（`extractCorrectness` **只认** `correct` / `passed`，不认 `ok` ——
//   载荷改名/toolOk 都不该影响它。这里把「不受影响」写成可执行的对照，而不是口头确认。）
import { extractCorrectness, extractKpId } from '../src/main/agent/extensions/learning-log.ts'
// ★ 渲染进程侧：编程卡片的载荷投影（前后端交界处的契约消费方，和上面同一个文件里测）
import {
  buildHintRequestMessage,
  buildRunRequestMessage,
  collectHints,
  collectResult,
  formatRunMeta,
  goalOfScaffold,
  projectHint,
  readCodingCard
} from '../src/renderer/src/cards/coding.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainDir = join(desktopRoot, 'src', 'main')
const codingFile = join(mainDir, 'agent', 'extensions', 'coding.ts')

/** 主进程侧的扫描扩展名（与 `architecture-guards.test.ts` 保持同一批）。 */
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs']

function listFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(full)
    }
  }
  walk(root)
  return found
}

function show(file: string): string {
  return relative(desktopRoot, file).replace(/\\/g, '/')
}

/**
 * 去掉注释，只看可执行代码。
 *
 * 为什么必须去：本文件的注释里**大量**解释「这里为什么不执行代码」「不出现 eval(」，
 * 那些说明文字是好注释，不该被判违规（`architecture-guards.test.ts` 的 `stripComments`
 * 同一口径，那里踩过一次「注释里举反例被自己的守卫拦下」）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

/* ------------------------------------------------------------------ *
 * 假件：把 Tool 的「外部世界」全部换掉（两个接缝，不需要 Electron/sidecar/Pyodide）
 * ------------------------------------------------------------------ */

/** 记录下来的执行请求（用来断言「代码真的被交出去了」）。 */
interface RunCall {
  request: CodeRunRequest
}

/** 假运行器：按预设脚本回放（`outcomes` 依次取用；用尽后回放最后一个）。 */
function fakeRunner(outcomes: CodeRunOutcome[]): { runner: CodeRunner; calls: RunCall[] } {
  const calls: RunCall[] = []
  let index = 0
  const runner: CodeRunner = async (request) => {
    calls.push({ request })
    const outcome = outcomes[Math.min(index, outcomes.length - 1)]
    index += 1
    return outcome
  }
  return { runner, calls }
}

const OK_OUTCOME: CodeRunOutcome = { stdout: '60 75 88\n', stderr: '', interrupted: false, elapsedMs: 12 }
const FAIL_OUTCOME: CodeRunOutcome = {
  stdout: '',
  stderr: "File \"<exec>\", line 3\nIndentationError: unexpected indent",
  interrupted: false,
  elapsedMs: 8
}
const LOOP_OUTCOME: CodeRunOutcome = {
  stdout: '',
  stderr: 'File "<exec>", line 2, in <module>\nKeyboardInterrupt: ',
  interrupted: true,
  elapsedMs: CODE_RUN_TIMEOUT_MS
}

/** 假 sidecar：按路径分派回执（`/api/code/...` 三个端点）。 */
interface FakeServerOptions {
  /** `/api/code/run-hint` 的回执（函数形式可按 attempt 变化）。 */
  runHint?: (body: Record<string, unknown>) => unknown
  template?: unknown
  hint?: unknown
  /** 强制某个端点返回 HTTP 错误（模拟断网/500）。 */
  failStatus?: number
  /** 记录收到的请求体（断言 attempt / stderr 等字段真的传下去了）。 */
  seen?: Array<{ path: string; body: Record<string, unknown> | null }>
}

function fakeServer(options: FakeServerOptions = {}) {
  const seen = options.seen ?? []
  const requester = async (path: string, init?: RequestInit): Promise<Response> => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    seen.push({ path, body })
    if (options.failStatus) {
      return new Response(JSON.stringify({ detail: '模拟的服务端故障' }), {
        status: options.failStatus,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    if (path.startsWith('/api/code/templates/')) {
      return Response.json(
        options.template ?? {
          kpId: 'prog-loop-jr',
          language: 'python',
          scaffold: '# TODO 1：把循环次数补上\nfor i in range(____):',
          expectedBehavior: '打印 60 75 88'
        }
      )
    }
    if (path.startsWith('/api/code/hint/')) {
      return Response.json(options.hint ?? { level: 1, hint: '先想想这段代码要重复做什么。' })
    }
    if (path.startsWith('/api/code/run-hint')) {
      const result = options.runHint
        ? options.runHint(body ?? {})
        : {
            ok: true,
            stdout: String(body?.stdout ?? ''),
            error: null,
            feedback: '运行成功。',
            nextHint: null
          }
      return Response.json(result)
    }
    return new Response('not found', { status: 404 })
  }
  return { requester, seen }
}

/** 收集注册到的 Tool（只实现我们用到的那一个方法）。 */
function collectTools(): { tools: Map<string, AgentToolDefinition>; pi: AgentExtensionApi } {
  const tools = new Map<string, AgentToolDefinition>()
  const pi: AgentExtensionApi = {
    on: () => {},
    registerTool: (tool) => {
      tools.set(tool.name, tool)
    }
  }
  return { tools, pi }
}

/** 建一个装好假件的 Extension，并返回它的三个 Tool。 */
function setup(options: {
  outcomes: CodeRunOutcome[]
  server?: FakeServerOptions
  maxConsecutiveFailures?: number
  withRunner?: boolean
}) {
  const { runner, calls } = fakeRunner(options.outcomes)
  const server = fakeServer(options.server)
  const factory = createCodingExtension({
    codeRunner: options.withRunner === false ? undefined : runner,
    request: server.requester,
    maxConsecutiveFailures: options.maxConsecutiveFailures,
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)
  return { tools, calls, seen: server.seen, runner }
}

/** 调一个 Tool 的 execute（Pi 的签名是 `(toolCallId, params)`，多出来的参数我们不依赖）。 */
async function callTool(
  tools: Map<string, AgentToolDefinition>,
  name: string,
  params: unknown,
  toolCallId = 'tc-1'
): Promise<{ details: Record<string, unknown>; text: string }> {
  const tool = tools.get(name)
  assert.ok(tool, `Tool ${name} 没有注册`)
  const result = (await tool.execute(toolCallId, params)) as {
    content: Array<{ type: string; text: string }>
    details: Record<string, unknown>
  }
  return { details: result.details, text: result.content.map((part) => part.text).join('\n') }
}

/** 一个固定的学生上下文（Tool 的身份来自主进程注入，模型改不了）。 */
function bindStudent(studentId = 'student_001', gradeLevel = 'junior'): void {
  bindAgentSession({ studentId, sessionId: 'sess-1', gradeLevel: gradeLevel as 'junior' })
}

// ====================================================================== *
// G18-1 ★★ 学生代码绝不在主进程执行（静态守卫）
// ====================================================================== *

test('G18-1a: 主进程任何文件都不 import pyodide（连类型都不行）', () => {
  const files = listFiles(mainDir)
  assert.ok(files.length > 0, 'src/main 下没扫到文件，守卫形同虚设')

  // 匹配 import / import() / require() 里的裸说明符
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  const offenders: string[] = []
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        if (/(^|\/)pyodide($|\/)/.test(match[1])) offenders.push(`${show(file)} → ${match[1]}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `主进程出现 pyodide import：\n  ${offenders.join('\n  ')}\n` +
      `学生代码只在渲染进程的 Pyodide Worker 里执行 —— 主进程一旦加载 Pyodide，` +
      `「学生代码绝不在宿主进程执行」这条硬约束就没了（执行文档 §12）。`
  )
})

test('G18-1b: 主进程不出现执行原语（eval / new Function / node:vm / 子进程跑代码）', () => {
  const files = listFiles(mainDir)
  const offenders: string[] = []

  // `eval(` / `new Function(` / `node:vm` / `vm.runIn*`
  const primitives: Array<{ label: string; pattern: RegExp }> = [
    { label: 'eval(', pattern: /(?<![.\w])eval\s*\(/ },
    { label: 'new Function(', pattern: /new\s+Function\s*\(/ },
    { label: 'node:vm', pattern: /['"]node:vm['"]/ },
    { label: 'vm.runIn', pattern: /\.runIn(?:This|New|Context)\s*\(/ }
  ]

  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const { label, pattern } of primitives) {
      if (pattern.test(code)) offenders.push(`${show(file)} → ${label}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `主进程出现代码执行原语：\n  ${offenders.join('\n  ')}\n` +
      `主进程拥有完整系统权限，任何"在这里跑一段字符串"的路径都可能被执行学生代码击穿。`
  )
})

test('G18-1c: coding.ts 的执行出口只有 codeRunner 接缝（代码是发出去的，不是在这里跑的）', () => {
  const code = stripComments(readFileSync(codingFile, 'utf8'))

  // ★ 正向断言：必须存在那把唯一的执行出口
  assert.ok(
    /^export type CodeRunner =/m.test(code),
    'coding.ts 必须导出 CodeRunner 接缝类型（它把"执行"与"教学判断"分开）'
  )
  assert.ok(
    /await\s+runner\s*\(/.test(code),
    'coding.ts 的 evaluate_code 必须经 `await runner(...)` 把代码交出去执行'
  )

  // ★ 反向断言：不得出现自己解析/执行 Python 的路径。
  //
  // ⚠️ 这里**不**禁止「Pyodide」这个词出现在中文文案里 —— 未接线的错误提示
  //   必须能说清「学生代码只能在渲染进程的 Pyodide Worker 里运行」，
  //    那是最有价值的一句排错信息（G18-1a 已经从 import 层面禁掉了真正危险的那件事：
  //    主进程任何文件不得 import pyodide）。所以这里只盯**执行原语**。
  const forbidden = [
    { label: 'Python 解释执行', pattern: /(?<![.\w])eval\s*\(/ },
    { label: 'new Function', pattern: /new\s+Function\s*\(/ },
    { label: '子进程', pattern: /child_process|spawn\s*\(/ },
    { label: '写临时文件再跑', pattern: /writeFileSync\s*\(|createWriteStream\s*\(/ }
  ]
  const offenders = forbidden.filter(({ pattern }) => pattern.test(code)).map(({ label }) => label)
  assert.deepEqual(
    offenders,
    [],
    `coding.ts 里出现执行相关路径 ${offenders} —— 它只允许「请求渲染进程执行 → 等回传」（§12）`
  )
})

/**
 * ★★ G18-1c2 / G18-1c3：硬约束②的**渲染进程与 IPC 半边**的接线守卫。
 *
 * 缺口（审计结论）：`grep -rln "sandbox/pyodide-runner" desktop/tests` → 0 个文件，
 * 主进程那半（G18-1a..i）测得很全，而「渲染进程入口真的把桥装上了」与
 * 「主进程 handler 真的在发 codeExecute / 收 codeResult」没有任何机器判据 ——
 * 那两处任意一处被删/改名，全套测试仍然全绿，只有现场手点「运行」才发现代码跑不起来。
 */
test('★ G18-1c2: 渲染进程入口真的装上了代码执行桥（installCodeExecutionBridge）', () => {
  const mainEntry = join(desktopRoot, 'src', 'renderer', 'src', 'main.ts')
  const code = stripComments(readFileSync(mainEntry, 'utf8'))
  assert.ok(
    /installCodeExecutionBridge\s*\(\s*window\.api\s*\)/.test(code),
    'src/renderer/src/main.ts 必须调用 installCodeExecutionBridge(window.api) —— ' +
      '这行是「主进程下发的执行请求」在渲染进程唯一的落点；删掉它，' +
      'evaluate_code 会以「没有可用的渲染进程」失败，而没有任何测试会发现'
  )
  assert.ok(
    /import\s*\{[^}]*installCodeExecutionBridge[^}]*\}\s*from\s*['"][^'"]*sandbox\/pyodide-runner['"]/.test(code),
    '必须从 sandbox/pyodide-runner 导入（别处再写一份桥 = 两套实现）'
  )
})

test('★ G18-1c3: 主进程 handler 同时下发 code:execute 并接收 code:result（IPC 两端都接上）', () => {
  const source = stripComments(readFileSync(join(mainDir, 'ipc', 'handlers.ts'), 'utf8'))
  // 下发端：把执行请求推给渲染进程（主进程自己不执行）
  assert.ok(
    /webContents\.send\(\s*IPC\.codeExecute\s*,/.test(source),
    'handlers.ts 必须把执行请求经 `webContents.send(IPC.codeExecute, …)` 推给渲染进程 —— ' +
      '这是「学生代码绝不在主进程执行」的落点'
  )
  // 接收端：兑现主进程侧挂着的 Promise
  assert.ok(
    /ipcMain\.handle\(\s*IPC\.codeResult\s*,/.test(source),
    'handlers.ts 必须有 `ipcMain.handle(IPC.codeResult, …)` 把渲染进程的回执兑现回 pending'
  )
  // 两处通道名都必须来自 channels.ts 的单一来源（不是手写字符串）
  assert.ok(!/['"]code:execute['"]/.test(source), '通道名不得手写在 handlers.ts 里（单一来源是 channels.ts 的 IPC 表）')
  assert.ok(!/['"]code:result['"]/.test(source), '通道名不得手写在 handlers.ts 里（单一来源是 channels.ts 的 IPC 表）')
})

test('G18-1d: 未接线时如实失败，绝不在主进程兜底执行', async () => {
  // 不注入 runner、也没 bindCodeRunner → 默认运行器必须**如实报错**而不是自己跑
  bindCodeRunner(null)
  assert.equal(isCodeRunnerBound(), false)
  const defaultRunner = resolveCodeRunner(undefined)
  const outcome = await defaultRunner({
    requestId: 'r1',
    toolCallId: 'tc',
    code: 'print(1)',
    language: 'python',
    timeoutMs: CODE_RUN_TIMEOUT_MS
  })
  assert.equal(outcome.failure, RUNNER_UNWIRED_TEXT)
  assert.equal(outcome.stdout, '', '未接线时不许有任何执行输出（说明它真的没跑）')
  assert.ok(
    /主进程不执行任何学生代码/.test(outcome.failure ?? ''),
    '未接线的错误文案要说清"主进程不执行学生代码"这个安全约束的存在'
  )
})

test('G18-1e: 渲染进程执行桥只做 requestId 配对，不碰代码内容', async () => {
  const dispatched: CodeRunRequest[] = []
  const bridge = createRendererCodeRunner({
    dispatch: (request) => dispatched.push(request),
    timeoutMs: 50,
    log: () => {},
    nextRequestId: () => 'req-fixed-1'
  })

  const pending = bridge.runner({
    requestId: 'ignored-placeholder',
    toolCallId: 'tc-9',
    code: 'print("hello")',
    language: 'python',
    timeoutMs: 5_000
  })

  // 桥把请求原样交出去，**不解释代码**（代码只是载荷）
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].requestId, 'req-fixed-1', '请求号由桥生成，保证配对唯一')
  assert.equal(dispatched[0].code, 'print("hello")')

  // 渲染进程回信 → 兑现
  const settled = bridge.settle({
    requestId: 'req-fixed-1',
    stdout: 'hello\n',
    stderr: '',
    interrupted: false,
    elapsedMs: 3
  })
  assert.equal(settled, true)
  const outcome = await pending
  assert.equal(outcome.stdout, 'hello\n')
  assert.equal(outcome.failure, undefined)
  assert.equal(bridge.pendingCount(), 0)
})

/**
 * ★ G18-1e2：`installCodeExecutionBridge` 的**注入式**单测（假 bridge + 假 runner）。
 *
 * 这条确实能写：`installCodeExecutionBridge(bridge?)` 的 `bridge` 就是可注入接缝，
 * 而它内部走 `handleDispatchedRun` → `runStudentCode` → `getSharedRunner()`，
 * 后者在 Node 下会因为没有 `Worker` 全局而**如实失败**（不抛、不崩）——
 * 这正好让我们能断言「requestId 原样回传」与「异常回一条可读 failure」这两件事。
 *
 * 注意：这里断言的是**协议纪律**，不是 Pyodide 真的跑起来了（那需要浏览器环境）。
 */
test('★ G18-1e2: 执行桥把 requestId 原样回传；执行通道异常时回一条可读 failure（不抛）', async () => {
  let listener:
    | ((request: { requestId: string; code: string; timeoutMs?: number; toolCallId?: string }) => void)
    | null = null
  const results: Array<{ requestId: string; stdout: string; failure?: string }> = []
  const uninstall = installCodeExecutionBridge({
    onCodeExecute: (handler) => {
      listener = handler
      return () => {
        listener = null
      }
    },
    sendCodeResult: (result) => results.push(result as { requestId: string; stdout: string; failure?: string })
  })

  assert.ok(listener !== null, '装上桥之后必须订阅到 onCodeExecute（否则主进程发的请求没人接）')
  ;(listener as (request: { requestId: string; code: string }) => void)({
    requestId: 'req-from-main-42',
    code: 'print("hi")'
  })

  // 等回执（Node 下没有 Worker → 运行器立刻失败，回一条可读 failure）
  await new Promise((resolveDone) => setTimeout(resolveDone, 300))

  assert.equal(results.length, 1, '必须回一条结果（不回 = 主进程那边只能干等到超时）')
  assert.equal(
    results[0].requestId,
    'req-from-main-42',
    '★ requestId 必须**原样**回传（主进程的桥按它兑现 pending；生成新号会让每条请求超时）'
  )
  assert.ok(
    typeof results[0].failure === 'string' && results[0].failure.length > 0,
    `执行通道不可用时必须回**可读 failure**（不能只回空 stdout 让主进程猜）：${JSON.stringify(results[0])}`
  )
  assert.equal(results[0].stdout, '', '失败时不该有 stdout')

  uninstall()
  // 缺 bridge（单测 / 无 preload 环境）时必须静默返回一个可调用的退订函数，不抛
  const noop = installCodeExecutionBridge(undefined)
  assert.equal(typeof noop, 'function')
  const partial = installCodeExecutionBridge({ onCodeExecute: () => () => {} })
  assert.equal(typeof partial, 'function', '只给了一半能力时也要安全退化成 no-op')
})

test('G18-1f: 渲染进程没回话时超时收敛成可读结果（不挂死、不抛异常）', async () => {
  const bridge = createRendererCodeRunner({
    dispatch: () => {},
    timeoutMs: 30,
    log: () => {},
    nextRequestId: () => 'req-timeout'
  })
  const outcome = await bridge.runner({
    requestId: 'x',
    toolCallId: 'tc',
    code: 'while True: pass',
    language: 'python',
    timeoutMs: 5_000
  })
  assert.equal(outcome.failure, RUNNER_TIMEOUT_TEXT)
  assert.equal(bridge.pendingCount(), 0, '超时后 pending 必须清掉（否则会缓慢泄漏）')
})

test('G18-1g: 推送失败（窗口已销毁）立刻失败，不等超时', async () => {
  const bridge = createRendererCodeRunner({
    dispatch: () => {
      throw new Error('webContents 已销毁')
    },
    timeoutMs: 5_000,
    log: () => {},
    nextRequestId: () => 'req-dead'
  })
  const outcome = await bridge.runner({
    requestId: 'x',
    toolCallId: 'tc',
    code: 'print(1)',
    language: 'python',
    timeoutMs: 5_000
  })
  assert.ok(outcome.failure, '必须给出可读失败而不是一直等')
  assert.equal(bridge.pendingCount(), 0)
})

test('G18-1h: 未知或过期的回信被安全忽略（不抛、不误兑现）', () => {
  const bridge = createRendererCodeRunner({ dispatch: () => {}, timeoutMs: 50, log: () => {} })
  assert.equal(bridge.settle({ requestId: 'never-issued' }), false)
  assert.equal(bridge.settle({}), false)
  assert.equal(bridge.settle(null), false)
  assert.equal(bridge.settle('garbage'), false)
})

test('G18-1i: pending 有上限 —— 渲染进程整体崩掉时不会无限堆积', async () => {
  const bridge = createRendererCodeRunner({
    dispatch: () => {},
    timeoutMs: 5_000, // 故意给很长：证明是上限（而不是超时）让它失败的
    log: () => {},
    maxPending: 2,
    nextRequestId: (() => {
      let n = 0
      return () => `req-${++n}`
    })()
  })
  const first = bridge.runner({ requestId: 'a', toolCallId: 't', code: '1', language: 'python', timeoutMs: 1 })
  const second = bridge.runner({ requestId: 'b', toolCallId: 't', code: '2', language: 'python', timeoutMs: 1 })
  const third = await bridge.runner({
    requestId: 'c',
    toolCallId: 't',
    code: '3',
    language: 'python',
    timeoutMs: 1
  })
  assert.equal(third.failure, RUNNER_TIMEOUT_TEXT)
  assert.equal(bridge.pendingCount(), 2)
  // 收尾：兑现前两个，别让它们挂着（进程会因未完成的 Promise 而晚退出）
  bridge.settle({ requestId: 'req-1', stdout: '', stderr: '' })
  bridge.settle({ requestId: 'req-2', stdout: '', stderr: '' })
  await Promise.all([first, second])
})

// ====================================================================== *
// 三把 Tool 的注册与参数 schema
// ====================================================================== *

test('coding-1: 恰好注册四个冻结 Tool（多一个少一个都不行）', () => {
  // ★ 2026-09-26（D-089）第四个：`generate_code_exercise` —— 按学生要求**现出一道题**
  //   （随包模板只有三份，学生要别的情境时原来没有东西可给）。
  //   它同样**不执行代码**：出题只走「模型出草稿 → 服务端校验并入库 → 卡片显示」。
  const { tools } = setup({ outcomes: [OK_OUTCOME] })
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['evaluate_code', 'generate_code_exercise', 'get_code_template', 'get_coding_hint'],
    '编程扩展注册的 Tool 必须与 §9.2/9.3 的冻结清单逐字一致'
  )
})

test('coding-2: 三个 Tool 的 TypeBox 参数 schema 形状正确', () => {
  const { tools } = setup({ outcomes: [OK_OUTCOME] })
  // 直接比对**导出的 schema 常量**与 Tool 上挂着的是同一份对象（防"另写一份"）
  assert.equal(tools.get('get_code_template')?.parameters, GetCodeTemplateParams)
  assert.equal(tools.get('get_coding_hint')?.parameters, GetCodingHintParams)
  assert.equal(tools.get('evaluate_code')?.parameters, EvaluateCodeParams)

  // 关键字段必须在（缺了模型就填不出来，Tool 直接不可用）
  const required = (schema: unknown): string[] => {
    const record = schema as { required?: string[] }
    return [...(record.required ?? [])].sort()
  }
  assert.deepEqual(required(GetCodeTemplateParams), ['kpId'])
  assert.deepEqual(required(GetCodingHintParams), ['kpId'])
  assert.deepEqual(required(EvaluateCodeParams), ['code', 'kpId'])
})

test('coding-3: 每个 Tool 都有 promptSnippet 与中文 description（模型能据它选对工具）', () => {
  const { tools } = setup({ outcomes: [OK_OUTCOME] })
  for (const [name, tool] of tools) {
    assert.ok(tool.label.trim().length > 0, `${name} 缺 label`)
    assert.ok(tool.description.trim().length > 10, `${name} 的 description 太短，模型选不对`)
    assert.ok((tool.promptSnippet ?? '').trim().length > 0, `${name} 缺 promptSnippet`)
    assert.ok(/[\u4e00-\u9fff]/.test(tool.description), `${name} 的 description 必须是中文`)
  }
})

test('coding-4: get_code_template / evaluate_code 的结果都带 kind: coding 供前端分派', async () => {
  bindStudent()
  const { tools } = setup({ outcomes: [OK_OUTCOME] })
  const template = await callTool(tools, 'get_code_template', { kpId: 'prog-loop-jr' })
  assert.equal(template.details.kind, CODING_PAYLOAD_KIND)
  assert.equal(CODING_PAYLOAD_KIND, 'coding', 'kind 必须与 §9.3 的映射表一致')

  const evaluation = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })
  assert.equal(evaluation.details.kind, CODING_PAYLOAD_KIND)
})

// ====================================================================== *
// get_code_template
// ====================================================================== *

test('template-1: 取模板：返回脚手架 + 预期行为，并带上会话学段', async () => {
  bindStudent('student_001', 'junior')
  const { tools, seen } = setup({ outcomes: [OK_OUTCOME] })
  const result = await callTool(tools, 'get_code_template', { kpId: 'prog-loop-jr' })

  assert.equal(result.details.kpId, 'prog-loop-jr')
  assert.ok(String(result.details.scaffold).includes('TODO'), '脚手架必须带 TODO 标记')
  assert.ok(String(result.details.expectedBehavior).length > 0)
  // 学段来自**会话**（前端说了不算），用查询串传给服务端
  assert.ok(seen[0].path.includes('gradeLevel=junior'), `请求路径应带学段：${seen[0].path}`)
})

test('template-2: 给模型的话不许把脚手架念一遍（会被刷屏）', async () => {
  bindStudent()
  const { tools } = setup({ outcomes: [OK_OUTCOME] })
  const result = await callTool(tools, 'get_code_template', { kpId: 'prog-loop-jr' })
  assert.ok(result.text.includes('编程卡片'), '要告诉模型"内容在卡片上"')
  assert.ok(result.text.includes('不要'), '要明确要求模型别复述代码')
  assert.ok(!result.text.includes('for i in range'), '不许把脚手架原文塞进给模型的文本')
})

test('template-3: 缺 kpId 时不发请求，直接给可读错误', async () => {
  bindStudent()
  const { tools, seen } = setup({ outcomes: [OK_OUTCOME] })
  const result = await callTool(tools, 'get_code_template', {})
  assert.equal(result.details.ok, false)
  assert.equal(result.details.error, true, 'details.error 必须是布尔 true（events.ts 只认这个）')
  assert.equal(seen.length, 0, '入参不合法时不该发起请求')
})

test('template-4: 知识点没有模板（404）→ 可读中文 + 失败形状', async () => {
  bindStudent()
  const { tools } = setup({ outcomes: [OK_OUTCOME], server: { failStatus: 404 } })
  const result = await callTool(tools, 'get_code_template', { kpId: 'no-such-kp' })
  assert.equal(result.details.ok, false)
  assert.match(String(result.details.errorMessage), /no-such-kp/)
  assert.ok(/[\u4e00-\u9fff]/.test(String(result.details.errorMessage)))
})

test('template-5: 断网（请求抛异常）→ 走 failed，不抛到调用方', async () => {
  bindStudent()
  const factory = createCodingExtension({
    codeRunner: fakeRunner([OK_OUTCOME]).runner,
    request: async () => {
      throw new Error('ECONNREFUSED')
    },
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)
  const result = await callTool(tools, 'get_code_template', { kpId: 'prog-loop-jr' })
  assert.equal(result.details.ok, false)
  assert.equal(result.details.degraded, true)
})

test('template-6: 回执不符合契约（缺 scaffold）→ 明确报错而不是渲染空卡片', async () => {
  bindStudent()
  const { tools } = setup({
    outcomes: [OK_OUTCOME],
    server: { template: { kpId: 'prog-loop-jr' } }
  })
  const result = await callTool(tools, 'get_code_template', { kpId: 'prog-loop-jr' })
  assert.equal(result.details.ok, false)
  assert.match(String(result.details.errorMessage), /契约/)
})

// ====================================================================== *
// ★★ evaluate_code：执行在渲染进程，主进程只转发
// ====================================================================== *

test('G18-2a: ★ evaluate_code 把代码交给运行器（而不是自己执行）', async () => {
  bindStudent()
  const { tools, calls } = setup({ outcomes: [OK_OUTCOME] })
  await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print("hi")' })

  assert.equal(calls.length, 1, '应当恰好请求渲染进程执行一次')
  assert.equal(calls[0].request.code, 'print("hi")', '代码原样交给运行器')
  assert.equal(calls[0].request.language, 'python')
  assert.equal(calls[0].request.timeoutMs, CODE_RUN_TIMEOUT_MS, '中断上限要传给 Worker')
  assert.ok(calls[0].request.requestId.length > 0, '请求要带 requestId 可追踪（票 18）')
  assert.ok(calls[0].request.toolCallId.length > 0, '请求要带 toolCallId 可追踪（票 18）')
})

test('G18-2b: ★ 成功路径：stdout 原样回传，无 error、无提示', async () => {
  bindStudent()
  const { tools } = setup({ outcomes: [OK_OUTCOME] })
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })
  assert.equal(result.details.ok, true)
  assert.equal(result.details.stdout, '60 75 88\n')
  assert.equal(result.details.error, null)
  assert.equal(result.details.nextHint, null)
})

test('G18-2c: ★ 失败路径：中文反馈 + 结构化 error + 第 1 级提示', async () => {
  bindStudent()
  const { tools, seen } = setup({
    outcomes: [FAIL_OUTCOME],
    server: {
      runHint: (body) => ({
        ok: false,
        stdout: String(body.stdout ?? ''),
        error: {
          type: 'IndentationError',
          message: '第 3 行附近的缩进不对。',
          rawTraceback: 'IndentationError: unexpected indent',
          line: 3
        },
        feedback: '运行没有通过（缩进错误）。第 3 行附近的缩进不对。',
        nextHint: { level: 1, hint: '先想想这段代码属于谁。' }
      })
    }
  })
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'if True:\nprint(1)' })

  assert.equal(result.details.ok, false)
  const error = result.details.error as Record<string, unknown>
  assert.equal(error.type, 'IndentationError')
  assert.equal(error.line, 3)
  assert.ok(/[\u4e00-\u9fff]/.test(String(error.message)), 'error.message 必须是中文解释')
  assert.ok(String(error.rawTraceback).length > 0, '原始 traceback 必须留档')
  const hint = result.details.nextHint as Record<string, unknown>
  assert.equal(hint.level, 1)
  // 传给服务端的 stderr 是 Worker 的**原文**（翻译是 Python 的职责，TS 不重写一份）
  assert.equal(seen[0].body?.stderr, FAIL_OUTCOME.stderr)
})

test('G18-2c2 ★★ 「学生代码没跑通」不得被轨迹读成「工具失败」（toolOk / codeOk 分离）', async () => {
  // 这是最常见的一条教学路径：**学生第一次写错** —— 工具本身完全正常。
  // 若载荷把「学生代码跑通没有」铺在 `details.ok` 上，`trace.ts` 的 `toolResultOk()`
  // 会判它失败，于是轨迹图（报告「设计合理性 25%」的核心证据）在每一段正常的教学对话里
  // 都画出一个假 `fail` 节点。断言必须直接打在**真实载荷**上（不是手写的形状）。
  bindStudent()
  const { tools } = setup({
    outcomes: [FAIL_OUTCOME],
    server: {
      runHint: () => ({
        ok: false,
        stdout: '',
        error: {
          type: 'IndentationError',
          message: '第 3 行附近的缩进不对。',
          rawTraceback: 'IndentationError: unexpected indent',
          line: 3
        },
        feedback: '运行没有通过（缩进错误）。',
        nextHint: { level: 1, hint: '先想想这段代码属于谁。' }
      })
    }
  })
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'if True:\nprint(1)' })

  // ① 卡片读的领域字段（名字直说它是什么意思）
  assert.equal(result.details.codeOk, false, 'codeOk 才是「学生代码跑通没有」')
  // ② 工具级：这次调用成功了（失败的形态根本到不了这里，走 failed()）
  assert.equal(result.details.toolOk, true, '工具级成败必须显式声明，不能让学生代码的正确性冒充它')
  // ③ ★ 真正的缺陷断言：轨迹读取方必须判成「工具成功」
  assert.equal(
    toolResultOk(result),
    true,
    '★ 学生写错一行代码（工具正常）在轨迹里必须是 ok —— 否则轨迹图在正常教学路径上全部失真'
  )

  // 反向对照：工具**真的**失败时（运行器故障 / 服务不可用）轨迹必须记成失败
  const broken = setup({
    outcomes: [{ stdout: '', stderr: '', interrupted: false, elapsedMs: 0, failure: RUNNER_UNWIRED_TEXT }]
  })
  const failedRun = await callTool(broken.tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })
  assert.equal(toolResultOk(failedRun), false, '反向对照：工具级失败仍要如实记成失败（修复不能把失败一起抹平）')

  // ★ 学习记录回流**不受本次改动影响**：`extractCorrectness` 只认 `correct` / `passed`，
  //   不认识 `ok`（那是它在注释里就定好的口径：「ok 在不同扩展里含义不同」）。
  //   `codeOk` / `toolOk` 都是**新增**字段，既没有冒充 `correct`，也没有把 kpId 挤掉。
  assert.equal(
    extractCorrectness(result),
    undefined,
    '载荷里不得出现 correct / passed —— 代码练习的对错由 ok/codeOk 表达，掌握度不靠它'
  )
  assert.equal(
    extractKpId({ kpId: 'prog-loop-jr' }, result),
    'prog-loop-jr',
    'kpId 必须仍在载荷里（学习记录与卡片都靠它归属）'
  )
})

test('G18-2d: ★★ 死循环被中断：interrupted 标志 + 「停不下来」文案 + 不抛异常', async () => {
  bindStudent()
  const { tools } = setup({
    outcomes: [LOOP_OUTCOME],
    server: {
      runHint: () => ({
        ok: false,
        stdout: '',
        error: {
          type: 'KeyboardInterrupt',
          message: '你的代码一直在重复做同一件事，停不下来，为了保护界面我已经把它停住了。',
          rawTraceback: 'KeyboardInterrupt: ',
          line: 2
        },
        feedback: '运行没有通过（程序运行太久，已被中断）。你的代码一直在重复做同一件事，停不下来。',
        nextHint: { level: 1, hint: '先找找那个"永远为真"的条件。' }
      })
    }
  })

  // ★ 关键：Tool **正常返回**（而不是抛异常）—— Pi 与 UI 同进程，抛出去会一起挂
  const result = await callTool(tools, 'evaluate_code', {
    kpId: 'prog-loop-jr',
    code: 'while True:\n    pass'
  })

  assert.equal(result.details.interrupted, true, 'interrupted 标志要透出给卡片与轨迹图')
  assert.equal(result.details.elapsedMs, CODE_RUN_TIMEOUT_MS, '耗时要如实上报（中断发生的时间点）')
  assert.equal(result.details.shouldIntervene, false, '第 1 次失败不该触发主动介入')
  // ★ 给模型的文本要能认出「这是被中断」而不是「学生写错了」，并且仍然不许给答案
  assert.match(result.text, /KeyboardInterrupt/, '要让模型知道这次是中断（不是普通报错）')
  assert.match(result.text, /不要直接给正确代码/, '中断场景同样不许直接给答案')
  assert.match(result.text, /不要.*重复/, '不许让模型把卡片上的反馈复述一遍')
})

test('G18-2e: 运行器故障（Worker 未接线 / 超时）与「学生报错」严格区分', async () => {
  bindStudent()
  const outcomes: CodeRunOutcome[] = [
    { stdout: '', stderr: '', interrupted: false, elapsedMs: 0, failure: RUNNER_UNWIRED_TEXT }
  ]
  const { tools, seen } = setup({ outcomes })
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })

  assert.equal(result.details.ok, false)
  assert.equal(result.details.degraded, true, '运行器故障是"能力受限"，不是崩溃')
  assert.ok(String(result.details.errorMessage).includes('主进程不执行任何学生代码'))
  assert.equal(seen.length, 0, '运行器都没跑起来，不该去问 sidecar 要反馈')
})

test('G18-2f: evaluate_code 不吞掉空代码与缺 kpId（入参校验在本地做完）', async () => {
  bindStudent()
  const { tools, calls } = setup({ outcomes: [OK_OUTCOME] })
  const empty = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: '   ' })
  assert.equal(empty.details.ok, false)
  const noKp = await callTool(tools, 'evaluate_code', { code: 'print(1)' })
  assert.equal(noKp.details.ok, false)
  assert.equal(calls.length, 0, '入参不合法时不消耗一次真实执行')
})

test('G18-2g: 没有绑定学生时拒绝执行（学习记录必须落到具体学生名下）', async () => {
  bindAgentSession(null)
  const { tools, calls } = setup({ outcomes: [OK_OUTCOME] })
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })
  assert.equal(result.details.ok, false)
  assert.equal(calls.length, 0)
  bindStudent() // 收尾：别把未绑定状态漏给下一个测试
})

// ====================================================================== *
// ★ 分级提示：1→2→3 递进、不跳级、不给答案
// ====================================================================== *

test('G19-hint-1: 提示级别逐级加深，同一 kp 内绝不跳级', async () => {
  bindStudent()
  const hints = [
    { level: 1, hint: '先想想这段代码要重复做什么。' },
    { level: 2, hint: '循环需要两层：外层管轮数，内层管每一轮比到哪儿。' },
    { level: 3, hint: '两层 range 的形状是 range(n-1) 与 range(n-1-i)。' }
  ]
  const seen: number[] = []
  const factory = createCodingExtension({
    codeRunner: fakeRunner([OK_OUTCOME]).runner,
    request: async (path) => {
      const level = Number(new URL(`http://x${path}`).searchParams.get('level'))
      seen.push(level)
      return Response.json(hints[Math.min(level, 3) - 1])
    },
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)

  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-1')
  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-2')
  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-3')
  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-4') // 到顶后应停在 3

  assert.deepEqual(seen, [1, 2, 3, 3], '必须 1→2→3 逐级，到顶停住（不跳级、不越界）')
})

test('G19-hint-2: 提示文本逐级不同，且 level 1 不含可直接照抄的代码', async () => {
  bindStudent()
  const hints = [
    '先想想这段代码要重复做什么。',
    '循环需要两层：外层管轮数，内层管每一轮比到哪儿。',
    '两层 range 的形状是 range(n-1) 与 range(n-1-i)。'
  ]
  const captured: string[] = []
  const factory = createCodingExtension({
    codeRunner: fakeRunner([OK_OUTCOME]).runner,
    request: async (path) => {
      const level = Number(new URL(`http://x${path}`).searchParams.get('level'))
      return Response.json({ level, hint: hints[level - 1] })
    },
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)
  for (let i = 0; i < 3; i += 1) {
    const result = await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, `tc-${i}`)
    captured.push(String(result.details.hint))
  }
  assert.equal(new Set(captured).size, 3, '三级提示必须文本不同（否则"递进"是空话）')
  for (const marker of ['range(', 'for ', 'if ']) {
    assert.ok(!captured[0].includes(marker), `level 1 出现代码片段「${marker}」——它只该指方向`)
  }
  // 越长越具体（可测的"递进"代理）
  assert.ok(captured[0].length < captured[1].length)
  assert.ok(captured[1].length < captured[2].length)
})

test('G19-hint-3: 提示按 kp 隔离 —— 换知识点后从 level 1 重新开始', async () => {
  bindStudent()
  const seen: Array<{ path: string; level: number }> = []
  const factory = createCodingExtension({
    codeRunner: fakeRunner([OK_OUTCOME]).runner,
    request: async (path) => {
      const url = new URL(`http://x${path}`)
      const level = Number(url.searchParams.get('level'))
      seen.push({ path, level })
      return Response.json({ level, hint: `第 ${level} 级提示` })
    },
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)

  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-1')
  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-2') // → 2
  // 换一个知识点：必须重新从 1 开始（不带上一轮的级别）
  await callTool(tools, 'get_coding_hint', { kpId: 'supervised-learning-jr' }, 'tc-3')

  assert.deepEqual(
    seen.map((entry) => entry.level),
    [1, 2, 1],
    '换知识点后提示级别必须重新从 1 开始（按 kp 隔离）'
  )
})

test('G19-hint-4: 答对后清零 —— 再求助从 level 1 重新开始', async () => {
  bindStudent()
  const levels: number[] = []
  const factory = createCodingExtension({
    codeRunner: fakeRunner([OK_OUTCOME]).runner,
    request: async (path) => {
      if (path.includes('/hint/')) {
        const level = Number(new URL(`http://x${path}`).searchParams.get('level'))
        levels.push(level)
        return Response.json({ level, hint: `第 ${level} 级提示` })
      }
      return Response.json({ ok: true, stdout: 'ok\n', error: null, feedback: '成功。', nextHint: null })
    },
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)

  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-1') // 1
  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-2') // 2
  // 学生做对了 → 清零
  await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' }, 'tc-3')
  await callTool(tools, 'get_coding_hint', { kpId: 'prog-loop-jr' }, 'tc-4')

  assert.deepEqual(levels, [1, 2, 1], '答对后提示级别应回到 1（"你上次做对了"这件事要尊重）')
})

test('G19-hint-5: 没有模板（404）→ 退回对话引导，不崩、不空提示', async () => {
  bindStudent()
  const { tools } = setup({ outcomes: [OK_OUTCOME], server: { failStatus: 404 } })
  const result = await callTool(tools, 'get_coding_hint', { kpId: 'no-such-kp' })
  assert.equal(result.details.ok, false)
  assert.match(String(result.details.errorMessage), /对话引导/)
  assert.equal(result.details.degraded, true)
})

test('G19-hint-6: state 表可直接单测：计数与级别的隔离/清零口径', () => {
  const state = createCodingSessionState()

  assert.equal(state.failures('s1', 'kp-a'), 0)
  assert.equal(state.previewAttempt('s1', 'kp-a'), 1, '还没失败过 → 这是第 1 次尝试')

  state.noteFailure('s1', 'kp-a')
  state.noteFailure('s1', 'kp-a')
  assert.equal(state.failures('s1', 'kp-a'), 2)
  assert.equal(state.previewAttempt('s1', 'kp-a'), 3)
  // ★ 按 kp 隔离：另一个知识点不受影响
  assert.equal(state.failures('s1', 'kp-b'), 0)
  // ★ 按学生隔离：另一个学生不受影响
  assert.equal(state.failures('s2', 'kp-a'), 0)

  // 提示级别只升不降、且到顶停住
  state.noteHint('s1', 'kp-a', 1)
  assert.equal(state.hintLevel('s1', 'kp-a'), 1)
  state.noteHint('s1', 'kp-a', 1)
  assert.equal(state.hintLevel('s1', 'kp-a'), 1, '重复给同一级不升级')
  state.noteHint('s1', 'kp-a', 3)
  assert.equal(state.hintLevel('s1', 'kp-a'), MAX_HINT_LEVEL)
  state.noteHint('s1', 'kp-a', 1)
  assert.equal(state.hintLevel('s1', 'kp-a'), MAX_HINT_LEVEL, '级别不许降')

  // ★ 答对后整条清掉（计数 + 级别一起归零）
  state.noteSuccess('s1', 'kp-a')
  assert.equal(state.failures('s1', 'kp-a'), 0)
  assert.equal(state.hintLevel('s1', 'kp-a'), 0)
})

// ====================================================================== *
// ★★ 连续失败 3 次 → 主 Agent 主动介入（票 19）
// ====================================================================== *

test('G19-intervene-1: 阈值是**单一具名常量**（默认 3，不许散落字面量）', () => {
  assert.equal(MAX_CONSECUTIVE_FAILURES, 3, '票 19 明确要求 N=3')

  const code = stripComments(readFileSync(codingFile, 'utf8'))
  // 常量必须被声明一次并被引用（否则就是"写了个没人用的常量"）
  assert.match(code, /export const MAX_CONSECUTIVE_FAILURES\s*=\s*3/)
  assert.match(code, /options\.maxConsecutiveFailures\s*\?\?\s*MAX_CONSECUTIVE_FAILURES/)
})

test('G19-intervene-2: ★ 连续失败 3 次触发主动介入（第 1、2 次不介入）', async () => {
  bindStudent()
  const { tools } = setup({
    outcomes: [FAIL_OUTCOME],
    server: {
      runHint: () => ({
        ok: false,
        stdout: '',
        error: { type: 'NameError', message: '第 2 行用到了一个还没被创建过的名字。', rawTraceback: 'NameError', line: 2 },
        feedback: '运行没有通过（变量名没有定义）。',
        nextHint: { level: 1, hint: '顺着这个名字往上找。' }
      })
    }
  })

  const interveneFlags: boolean[] = []
  const counterValues: number[] = []
  const texts: string[] = []
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
    const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(x)' }, `tc-${i}`)
    interveneFlags.push(result.details.shouldIntervene === true)
    counterValues.push(Number(result.details.consecutiveFailures))
    texts.push(result.text)
  }

  assert.deepEqual(counterValues, [1, 2, 3], '失败计数要如实递增')
  assert.deepEqual(
    interveneFlags,
    [false, false, true],
    `前 ${MAX_CONSECUTIVE_FAILURES - 1} 次只引导，第 ${MAX_CONSECUTIVE_FAILURES} 次必须主动介入`
  )
  // ★ 介入是**写给模型的行动指令**，复用既有对话输出（不新增事件类型）
  assert.match(texts[2], /主动介入/)
  assert.match(texts[2], /承认|说教/, '介入指令要给语气要求，别让模型只会说"再试试"')
  assert.match(texts[2], /不要直接给正确代码/, '介入不等于给答案')
})

test('G19-intervene-3: 答对后计数清零，再失败从 1 重新数', async () => {
  bindStudent()
  // ★ 前两次失败、第三次成功、第四次又失败
  const outcomes: CodeRunOutcome[] = [FAIL_OUTCOME, FAIL_OUTCOME, OK_OUTCOME, FAIL_OUTCOME]
  const { tools } = setup({
    outcomes,
    server: {
      runHint: (body) => {
        const failed = String(body.stderr ?? '').length > 0
        return failed
          ? {
              ok: false,
              stdout: '',
              error: { type: 'NameError', message: '中文解释', rawTraceback: 'NameError', line: 1 },
              feedback: '失败反馈',
              nextHint: { level: 1, hint: '方向' }
            }
          : { ok: true, stdout: 'ok\n', error: null, feedback: '成功。', nextHint: null }
      }
    }
  })

  const counts: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' }, `tc-${i}`)
    counts.push(Number(result.details.consecutiveFailures))
  }
  assert.deepEqual(counts, [1, 2, 0, 1], '成功那一次把计数清零，之后从 1 重新数')
})

test('G19-intervene-4: 换知识点不带上一轮的失败计数', async () => {
  bindStudent()
  const { tools } = setup({
    outcomes: [FAIL_OUTCOME],
    server: {
      runHint: () => ({
        ok: false,
        stdout: '',
        error: { type: 'NameError', message: '中文解释', rawTraceback: 'NameError', line: 1 },
        feedback: '失败反馈',
        nextHint: { level: 1, hint: '方向' }
      })
    }
  })

  const a1 = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'x' }, 'tc-1')
  const a2 = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'x' }, 'tc-2')
  // 换到另一个知识点：必须从 1 开始（不带上一轮的计数）
  const b1 = await callTool(tools, 'evaluate_code', { kpId: 'supervised-learning-jr', code: 'x' }, 'tc-3')

  assert.equal(a1.details.consecutiveFailures, 1)
  assert.equal(a2.details.consecutiveFailures, 2)
  assert.equal(b1.details.consecutiveFailures, 1, '换知识点后计数必须从 1 开始')
  assert.equal(b1.details.shouldIntervene, false, '换了知识点就不该带着上一轮的"卡住"判定')
})

test('G19-intervene-5: 换学生不带上一轮的失败计数（一人一份）', async () => {
  const { tools } = setup({
    outcomes: [FAIL_OUTCOME],
    server: {
      runHint: () => ({
        ok: false,
        stdout: '',
        error: { type: 'NameError', message: '中文解释', rawTraceback: 'NameError', line: 1 },
        feedback: '失败反馈',
        nextHint: { level: 1, hint: '方向' }
      })
    }
  })

  bindAgentSession({ studentId: 'student_001', sessionId: 's1', gradeLevel: 'junior' })
  await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'x' }, 'tc-1')
  await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'x' }, 'tc-2')

  bindAgentSession({ studentId: 'student_002', sessionId: 's2', gradeLevel: 'junior' })
  const other = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'x' }, 'tc-3')

  assert.equal(other.details.consecutiveFailures, 1, '换学生后计数必须从 1 开始（绝不跨学生复用）')
})

test('G19-intervene-6: 阈值可注入（压缩到 2 次）—— 证明它真的是那一个常量在起作用', async () => {
  bindStudent()
  const { tools } = setup({
    outcomes: [FAIL_OUTCOME],
    maxConsecutiveFailures: 2,
    server: {
      runHint: () => ({
        ok: false,
        stdout: '',
        error: { type: 'NameError', message: '中文解释', rawTraceback: 'NameError', line: 1 },
        feedback: '失败反馈',
        nextHint: { level: 1, hint: '方向' }
      })
    }
  })
  const first = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'x' }, 'tc-1')
  const second = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'x' }, 'tc-2')
  assert.equal(first.details.shouldIntervene, false)
  assert.equal(second.details.shouldIntervene, true, '阈值改成 2 后第 2 次就该介入')
})

test('G19-intervene-7: 介入指令复用既有对话输出 —— 不新增第 7 个事件类型', () => {
  // 事件词表在 shared/ipc-events.ts，这里断言它仍是冻结的 6 个（没被本票撬开）
  const source = readFileSync(join(desktopRoot, 'src', 'shared', 'ipc-events.ts'), 'utf8')
  const list = /export\s+const\s+IPC_EVENT_NAMES[^=]*=\s*\[([\s\S]*?)\]/.exec(source)?.[1]
  assert.ok(list, '找不到 IPC_EVENT_NAMES')
  const names = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(names, ['delta', 'citation', 'payload', 'blocked', 'done', 'error'])

  // 介入靠的是 Tool 结果文本（模型经既有 delta 流讲出来），所以文本里必须有那句指令
  const text = renderEvaluationText(
    {
      ok: false,
      stdout: '',
      error: { type: 'NameError', message: '中文解释', rawTraceback: '', line: 1 },
      feedback: '失败反馈',
      nextHint: null
    },
    { kpId: 'prog-loop-jr', consecutiveFailures: 3, shouldIntervene: true }
  )
  assert.match(text, /主动介入/)
  // 不介入时不该出现那句指令
  const quiet = renderEvaluationText(
    {
      ok: false,
      stdout: '',
      error: { type: 'NameError', message: '中文解释', rawTraceback: '', line: 1 },
      feedback: '失败反馈',
      nextHint: null
    },
    { kpId: 'prog-loop-jr', consecutiveFailures: 1, shouldIntervene: false }
  )
  assert.doesNotMatch(quiet, /主动介入/)
})

// ====================================================================== *
// 降级与自兜异常（Pi 与 UI 同进程，异常必须自己兜住）
// ====================================================================== *

test('degrade-1: sidecar 不可用时仍返回可读结果（不是异常、不是白屏）', async () => {
  bindStudent()
  const factory = createCodingExtension({
    codeRunner: fakeRunner([OK_OUTCOME]).runner,
    request: async () => {
      throw new Error('sidecar 尚未就绪')
    },
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })
  assert.equal(result.details.ok, false)
  assert.equal(result.details.degraded, true, 'degraded=true 表示"本轮对话可继续"')
  assert.ok(/[\u4e00-\u9fff]/.test(String(result.details.errorMessage)))
})

test('degrade-2: sidecar 返回 500 → 可读错误 + degraded', async () => {
  bindStudent()
  const { tools } = setup({ outcomes: [OK_OUTCOME], server: { failStatus: 500 } })
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })
  assert.equal(result.details.ok, false)
  assert.match(String(result.details.errorMessage), /HTTP 500/)
  assert.equal(result.details.degraded, true)
})

test('degrade-3: 运行器抛异常时 execute 也自兜（绝不冒到 Pi 与 UI）', async () => {
  bindStudent()
  const exploding: CodeRunner = async () => {
    throw new Error('运行器内部炸了')
  }
  const server = fakeServer()
  const factory = createCodingExtension({ codeRunner: exploding, request: server.requester, log: () => {} })
  const { tools, pi } = collectTools()
  factory(pi)

  // ★ Pi 的 Extension 与 Agent 同进程，运行器抛出的异常若冒出去会同时带走 UI
  //   （AGENTS §5.14 的纪律）—— 所以这里断言它**不抛**，而是收敛成可读失败。
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })
  assert.equal(result.details.ok, false)
  assert.equal(result.details.degraded, true)
  assert.match(String(result.details.errorMessage), /运行器内部炸了/, '内部原因要保留在可读文案里')
})

test('degrade-4: 回执缺字段（契约漂移）→ 明确报契约不符，不硬塞半个对象', async () => {
  bindStudent()
  const { tools } = setup({
    outcomes: [OK_OUTCOME],
    server: { runHint: () => ({ ok: true, stdout: 'x' }) } // 缺 feedback
  })
  const result = await callTool(tools, 'evaluate_code', { kpId: 'prog-loop-jr', code: 'print(1)' })
  assert.equal(result.details.ok, false)
  assert.match(String(result.details.errorMessage), /契约/)
})

test('degrade-5: Tool 的失败形状与 quiz/rag 逐字一致（全项目只有一种失败形态）', async () => {
  bindStudent()
  const { tools } = setup({ outcomes: [OK_OUTCOME] })
  const result = await callTool(tools, 'get_code_template', {})
  assert.deepEqual(Object.keys(result.details).sort(), [
    'degraded',
    'error',
    'errorMessage',
    'message',
    'ok'
  ])
  assert.equal(result.details.ok, false)
  assert.equal(result.details.error, true)
  assert.equal(result.details.degraded, true)
  assert.equal(result.details.errorMessage, result.details.message, '两个字段口径要一致')
})

// ====================================================================== *
// ★ 渲染进程侧：编程卡片的载荷投影（`cards/coding.ts` 的纯函数）
// ====================================================================== *
//
// 为什么这一组要在这里测（而不是另起一个渲染进程测试文件）：
// 投影规则是**前后端交界处**的契约消费者 —— 它消费的正是 `coding.ts` 产出的 `details`。
// 放在同一个文件里，改了一边就会同时看到另一边的断言，
// 「主进程多给了一个字段、前端没认」这类静默漂移更容易当场暴露。

test('card-1: 模板载荷 → template 视图（含 scaffold 与预期行为）', () => {
  const view = readCodingCard({
    kpId: 'prog-loop-jr',
    language: 'python',
    scaffold: '# TODO 1\nfor i in range(____):\n',
    expectedBehavior: '打印 1 到 5',
    kind: 'coding',
    tool: 'get_code_template'
  })
  assert.equal(view.kind, 'template')
  if (view.kind !== 'template') return
  assert.equal(view.kpId, 'prog-loop-jr')
  assert.match(view.scaffold, /TODO/)
  assert.equal(view.expectedBehavior, '打印 1 到 5')
})

test('card-2: 评估载荷 → result 视图（中文 feedback 与原始 traceback 分开）', () => {
  const view = readCodingCard({
    kpId: 'prog-loop-jr',
    ok: false,
    stdout: '',
    error: {
      type: 'IndentationError',
      message: '第 3 行附近的缩进不对。',
      rawTraceback: 'Traceback (most recent call last):\n  File "<exec>", line 3\n',
      line: 3
    },
    feedback: '运行没有通过（缩进错误）。第 3 行附近的缩进不对。',
    nextHint: { level: 1, hint: '先想想这段代码属于谁。' },
    consecutiveFailures: 2,
    shouldIntervene: false,
    interrupted: false,
    elapsedMs: 12,
    kind: 'coding'
  })
  assert.equal(view.kind, 'result')
  if (view.kind !== 'result') return
  assert.equal(view.ok, false)
  assert.equal(view.error?.type, 'IndentationError')
  assert.equal(view.error?.line, 3)
  assert.ok(view.error?.message.includes('缩进'), 'error.message 是给学生的中文解释')
  assert.ok(view.error?.rawTraceback.includes('Traceback'), '原文另存，不与中文混')
  assert.equal(view.consecutiveFailures, 2)
  assert.equal(view.shouldIntervene, false)
})

test('card-3: ★ 认不出的载荷退化成 unknown（绝不猜、绝不白屏）', () => {
  // 失败形态（主进程 failed() 的 details）
  const failedView = readCodingCard({ ok: false, error: true, errorMessage: '取模板失败', message: '取模板失败', degraded: true })
  assert.equal(failedView.kind, 'unknown')

  for (const garbage of [null, undefined, 42, 'x', {}, { scaffold: '' }, []]) {
    assert.equal(readCodingCard(garbage).kind, 'unknown', `载荷 ${JSON.stringify(garbage)} 应退化成 unknown`)
  }

  // 带兜底文本时要把文本交出来（卡片显示一句人话，而不是空）
  const withText = readCodingCard({ note: 'x', text: '编程卡片暂时显示不出来' })
  assert.equal(withText.kind, 'unknown')
  if (withText.kind === 'unknown') assert.equal(withText.text, '编程卡片暂时显示不出来')
})

test('card-4: 提示载荷投影 —— 只认 level 1/2/3 且 hint 非空', () => {
  assert.deepEqual(projectHint({ level: 1, hint: '指个方向' }), { level: 1, hint: '指个方向' })
  assert.deepEqual(projectHint({ level: 3, hint: '贴近骨架' }), { level: 3, hint: '贴近骨架' })
  // 越界级别、缺 hint、空 hint、垃圾 → 全部丢掉（宁可少一条提示，也不要一条怪的）
  assert.equal(projectHint({ level: 4, hint: '越界' }), null)
  assert.equal(projectHint({ level: 0, hint: '越界' }), null)
  assert.equal(projectHint({ level: '1', hint: '类型不对' }), null)
  assert.equal(projectHint({ level: 1 }), null)
  assert.equal(projectHint({ level: 1, hint: '   ' }), null)
  assert.equal(projectHint(null), null)
})

test('card-5: ★ 跨轮收集提示并按 level 升序（1→2→3 都显示出来）', () => {
  const cards = [
    // 提示可能在别的轮次里到达，顺序甚至可能是乱的
    { payload: { kpId: 'prog-loop-jr', level: 3, hint: '第三级' } },
    { payload: { kpId: 'prog-loop-jr', level: 1, hint: '第一级' } },
    { payload: { kpId: 'prog-loop-jr', level: 2, hint: '第二级' } }
  ]
  const hints = collectHints(cards, 'prog-loop-jr')
  assert.deepEqual(
    hints.map((hint) => hint.level),
    [1, 2, 3],
    '要按 level 升序展示（学生看到的顺序必须是由浅入深）'
  )
  assert.deepEqual(
    hints.map((hint) => hint.hint),
    ['第一级', '第二级', '第三级']
  )
})

test('card-6: ★ 提示/结果按 kpId 归属（多知识点同屏不串台）', () => {
  const cards = [
    { payload: { kpId: 'prog-loop-jr', level: 1, hint: '循环的第一级' } },
    { payload: { kpId: 'supervised-learning-jr', level: 1, hint: '决策树的第一级' } },
    { payload: { kpId: 'supervised-learning-jr', level: 2, hint: '决策树的第二级' } }
  ]
  const loopHints = collectHints(cards, 'prog-loop-jr')
  assert.equal(loopHints.length, 1, '不能把别的知识点的提示挂到这张卡片上')
  assert.equal(loopHints[0].hint, '循环的第一级')

  const treeHints = collectHints(cards, 'supervised-learning-jr')
  assert.deepEqual(treeHints.map((hint) => hint.hint), ['决策树的第一级', '决策树的第二级'])
})

test('card-7: 结果收集保留**最新**一次（学生改完再跑要看新结果）', () => {
  const cards = [
    { payload: { kpId: 'prog-loop-jr', ok: false, stdout: '', feedback: '第一次失败', consecutiveFailures: 1 } },
    { payload: { kpId: 'prog-loop-jr', ok: true, stdout: 'ok\n', feedback: '成功', consecutiveFailures: 0 } }
  ]
  const result = collectResult(cards, 'prog-loop-jr')
  assert.ok(result)
  assert.equal(result?.ok, true, '后到的结果覆盖先前的（否则学生改好了还看着旧的失败结论）')
  assert.equal(result?.feedback, '成功')
})

test('card-8: 消息文本不让模型代做 / 不改写学生代码', () => {
  const hintMessage = buildHintRequestMessage('prog-loop-jr', 'for i in range(____):')
  assert.match(hintMessage, /prog-loop-jr/)
  assert.match(hintMessage, /不要直接给我完整答案/, '求助时必须显式要求不给答案')
  assert.match(hintMessage, /get_coding_hint/, '要指名让模型调哪个 Tool')
  // ★ 前端不许指定级别（级别由主进程的状态表推进）
  assert.doesNotMatch(hintMessage, /level\s*[:=]\s*[123]/, '消息里不许出现"要第几级"')

  const runMessage = buildRunRequestMessage('prog-loop-jr', 'print(1)')
  assert.match(runMessage, /evaluate_code/)
  assert.match(runMessage, /python/, '代码块要标语言，模型才看得清')
  assert.match(runMessage, /不要直接给正确代码/)
})

test('card-9: 超长代码在消息里被截断（别把整份文件灌进 prompt）', () => {
  const long = 'x = 1\n'.repeat(500)
  const message = buildRunRequestMessage('prog-loop-jr', long)
  assert.ok(message.length < long.length, '必须截断')
  assert.ok(message.includes('…'), '截断要有可见标记')
})

test('card-11: ★★ 从脚手架抽「目标：…」那句话（任务简报要拿它回答「要我写什么」）', () => {
  // 真模板原文（228 份随包模板的第一行都是这个形状）
  assert.equal(
    goalOfScaffold('# 目标：写一个求平均值的函数，再用它算一遍\nnums = [1, 2, 3, 4]\n'),
    '写一个求平均值的函数，再用它算一遍'
  )
  // 中英文冒号、`#` 后多空格、前后缩进都要认
  assert.equal(goalOfScaffold('#目标:把 result 从小到大排好'), '把 result 从小到大排好')
  assert.equal(goalOfScaffold('   #  目标 ：  调用函数  '), '调用函数')
  // ★ 抽不到就返回空串（调用方整行不渲染）——绝不编一句「理解这道题」的废话
  assert.equal(goalOfScaffold(''), '')
  assert.equal(goalOfScaffold('nums = [1, 2, 3]\n# TODO 1：补完函数体\n'), '')
  // ★ 只认**行首注释**：正文里出现「目标：」不该被当成说明抽出来
  assert.equal(goalOfScaffold('print("目标：做点什么")\n'), '')
  // ★ 只取第一行目标（后面的注释不算）
  assert.equal(
    goalOfScaffold('# 目标：第一句\n# 目标：第二句\n'),
    '第一句'
  )
})

test('card-10: 状态条文案区分"被中断"与"普通失败"（票 18 的头号演示）', () => {
  assert.equal(formatRunMeta(1014, false), '运行 1014 ms')
  const interrupted = formatRunMeta(1014, true)
  assert.match(interrupted, /已中断/, '中断必须能一眼看出来')
  assert.match(interrupted, /1014/, '同时要保留耗时（说明它是被超时停下的）')
})

// ====================================================================== *
// D-089：按学生要求**现出一道题**（generate_code_exercise）
// ====================================================================== *

const EXERCISE_DRAFT = {
  title: '外星人送快递',
  expectedBehavior: '屏幕上依次出现 3 件快递的编号。',
  scaffold: 'for i in range(TODO):\n    print("快递", i)\n',
  expectedOutput: '快递 0\n快递 1\n快递 2',
  hints: [
    { level: 1, hint: '想让同一件事重复三次。' },
    { level: 2, hint: '用循环，把次数写进括号。' },
    { level: 3, hint: 'range(3) 会给出 0、1、2。' }
  ],
  solution: 'for i in range(3):\n    print("快递", i)'
}

test('coding-9: 出题 → 服务端校验入库 → 卡片载荷带 savedId（答案与提示都不进载荷）', async () => {
  bindStudent()
  const requested = '用外星人送快递来写循环'
  const posted: Array<Record<string, unknown>> = []
  const asked: Array<Record<string, unknown>> = []
  const factory = createCodingExtension({
    request: async (path, init) => {
      if (path.startsWith('/api/code/generated/')) {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({
          kpId: 'prog-loop-jr',
          language: 'python',
          scaffold: EXERCISE_DRAFT.scaffold,
          expectedBehavior: EXERCISE_DRAFT.expectedBehavior,
          savedId: 'code-abc123',
          title: EXERCISE_DRAFT.title,
          expectedOutput: EXERCISE_DRAFT.expectedOutput
        })
      }
      return new Response(JSON.stringify({ detail: '不该走这条路' }), { status: 500 })
    },
    generate: async (request) => {
      asked.push(request as unknown as Record<string, unknown>)
      return EXERCISE_DRAFT
    },
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)
  const { details, text } = await callTool(tools, 'generate_code_exercise', {
    kpId: 'prog-loop-jr',
    request: requested
  })

  assert.equal(posted.length, 1, '出题必须真的发给服务端（存进学生名下）')
  assert.equal(posted[0].solution, EXERCISE_DRAFT.solution, '★ 参照实现必须交给服务端（只进库）')
  assert.deepEqual(posted[0].hints, EXERCISE_DRAFT.hints, '三级提示也要进库（按级从服务端发）')
  assert.equal(
    posted[0].promptHash,
    codeRequestHash('prog-loop-jr', requested),
    '指纹由主进程算（学生原话只进提示词）'
  )
  // ★ 判据是**学生那句话**（整句）不进请求体：题名里出现同一个词（「外星人送快递」）
  //   是内容本身，不是原话 —— 断言过严会把「题名贴题」判成泄漏。
  assert.equal(
    JSON.stringify(posted[0]).includes(requested),
    false,
    '★ 学生原话（整句）不许出现在请求体里（只留指纹）'
  )
  assert.equal(asked[0]?.gradeLevel, 'junior', '学段以会话为准（模型说了不算）')

  assert.equal(details.savedId, 'code-abc123', '卡片载荷要带上 savedId（提示要用它定位）')
  assert.equal(details.kind, 'coding')
  assert.equal('solution' in details, false, '★ 卡片载荷里不许有参照实现')
  assert.equal('hints' in details, false, '★ 卡片载荷里不许有提示（提示按级从服务端发）')
  assert.ok(text.includes('code-abc123'), '要给模型 savedId：学生点「求助」时要带上它')
})

test('coding-10: 出题被服务端拒（422）→ 带原因重试；仍不过就如实失败，不硬塞', async () => {
  bindStudent()
  let calls = 0
  const reasons: Array<string | undefined> = []
  const factory = createCodingExtension({
    request: async () => {
      calls += 1
      return new Response(
        JSON.stringify({ detail: '生成的编程题不合格：scaffold 里没有 TODO 标记' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    },
    generate: async (request) => {
      reasons.push((request as { previousReason?: string }).previousReason)
      return EXERCISE_DRAFT
    },
    log: () => {}
  })
  const { tools, pi } = collectTools()
  factory(pi)
  const { text } = await callTool(tools, 'generate_code_exercise', {
    kpId: 'prog-loop-jr',
    request: '随便来一道'
  })

  assert.equal(calls, 3, '首次 + 重试 2 次 = 3 次（再不过就不适合硬塞）')
  assert.equal(reasons[0], undefined, '第一次没有「上一次原因」')
  assert.match(String(reasons[1]), /没有 TODO/, '★ 重试必须带服务端给的原因（否则等于原样重来）')
  assert.match(text, /没法用|不合格/, '最终要如实说清「这道题没能用上」')
})
