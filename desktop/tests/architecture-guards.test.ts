/**
 * 架构守卫（票 01 建立，票 02 扩充，票 05 扩充 IPC 事件通道部分）。
 *
 * ★ 一律写成**正向/结构性断言**（「必须经 IPC 与 preload 白名单传递」），
 *   而不是「禁止历史实现」式的反向断言 —— 本项目从零实现，没有 SSE，不需要防守一个不存在的实现。
 *
 * 守卫清单：
 *   G1  Electron 侧不得引入任何原生数据库模块（风险隔离，见 AGENTS.md §4）
 *   G2  渲染进程不得 import 任何 Node 内置模块（渲染进程不该有系统能力）
 *   G3  渲染进程不得直连 sidecar 的 HTTP 端点（否则 token 与跨源/CORS 问题会全部回来）
 *   G4  6 事件词表严格是 delta/citation/payload/blocked/done/error
 *   G5  `src/main/bridge/client.ts` 是唯一对 sidecar 发 HTTP 请求的文件
 *   G6  ★ token 不进入任何面向渲染进程的载荷（`SidecarState` 无 token 字段；
 *       renderer/ 与 preload/ 的可执行代码里不出现 token 标识）
 *   G7  ★ 对话事件流必须经「主进程 IPC ↔ preload 白名单通道」传递（正向断言两端都在用同一批通道）
 *   G8  ★ 通道名只在 `src/main/ipc/channels.ts` 声明一次（主进程与 preload 共用同一来源）
 *   G9  ★ preload 只暴露白名单方法，不暴露通用 `ipcRenderer` 转发
 *   G10 ★ `TOOL_TO_KIND` 单一定义：7 个 Tool 在表内，`rag_search` / `get_student_profile` 不在表内
 *   G11 ★ 6 事件载荷字段与契约逐字一致（`shared/ipc-events.ts`）
 *   G12 ★ 渲染进程接事件是**订阅回调**：不存在解析层（无 `TextDecoder` / `EventSource`）
 *   G13 ★ 明文 LLM 配置只有主进程能取；`shared/provider-catalog.ts`（唯一的契约例外）
 *
 * 跑法：`npm test`。全部用 fs 读源码做静态断言，失败信息里带上具体文件路径。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(desktopRoot, 'src')
const rendererDir = join(desktopRoot, 'src', 'renderer')
const preloadDir = join(desktopRoot, 'src', 'preload')
const mainDir = join(desktopRoot, 'src', 'main')
const ipcDir = join(mainDir, 'ipc')
const channelsFile = join(ipcDir, 'channels.ts')
const toolKindsFile = join(ipcDir, 'tool-kinds.ts')
const handlersFile = join(ipcDir, 'handlers.ts')
const preloadIndexFile = join(preloadDir, 'index.ts')
const rendererEventsFile = join(rendererDir, 'src', 'api', 'events.ts')
const sharedEventsFile = join(desktopRoot, 'src', 'shared', 'ipc-events.ts')
const bridgeClientFile = join(mainDir, 'bridge', 'client.ts')
const sidecarProtocolFile = join(mainDir, 'sidecar', 'protocol.ts')

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.mts', '.vue', '.js', '.mjs', '.cjs', '.html', '.css']

function listFiles(root: string, extensions: string[] = SCAN_EXTENSIONS): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(full)
      }
    }
  }
  walk(root)
  return found
}

/** 仓库内相对路径（正斜杠），让失败信息可读。 */
function show(file: string): string {
  return relative(desktopRoot, file).replace(/\\/g, '/')
}

function readSource(file: string): string {
  return readFileSync(file, 'utf8')
}

/** 抽出源码里所有模块说明符：`from 'x'` / `import 'x'` / `import('x')` / `require('x')`。 */
function moduleSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  const specs: string[] = []
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specs.push(match[1])
    }
  }
  return specs
}

/**
 * 去掉注释，只留可执行代码。
 * 用于「不得出现某标识」这类断言：注释里解释「为什么不能出现 token」是**好事**，不该被判违规。
 * `//` 只在行首或空白之后才当注释（避免把 `https://` 这类字面量切成两半）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** 抽出 `export interface NAME { ... }` 的主体（文件里这些接口的右花括号都顶格）。 */
function interfaceBody(source: string, name: string, file: string): string {
  const matched = new RegExp(`export\\s+interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source)
  assert.ok(matched, `${show(file)} 里找不到 interface ${name}`)
  return matched[1]
}

/** 抽出 `export const NAME = { ... } as const` 里的键值对（值必须是字符串字面量）。 */
function stringLiteralRecord(source: string, name: string, file: string): Record<string, string> {
  const matched = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}\\s*as const`).exec(source)
  assert.ok(matched, `${show(file)} 里找不到 ${name} 的字面量对象`)
  const record: Record<string, string> = {}
  for (const entry of matched[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
    record[entry[1]] = entry[2]
  }
  assert.ok(Object.keys(record).length > 0, `${show(file)} 的 ${name} 里没解析出任何键值对`)
  return record
}

/** 接口主体里的属性名（逐行看声明，避免把注释里的词误判成字段）。 */
function declaredFields(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .map((line) => /^(readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[2])
}

/** 接口主体里的方法名（`name(args): ret`）。 */
function declaredMethods(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .map((line) => /^([A-Za-z_$][\w$]*)\s*\(/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1])
}

// ── G1 原生数据库模块 ───────────────────────────────────────────────────

const BANNED_DB_MODULES = ['better-sqlite3', 'sqlite3', 'duckdb', '@libsql/client', '@libsql/knex', 'node:sqlite']

function isBannedDbModule(name: string): boolean {
  return BANNED_DB_MODULES.includes(name) || name.startsWith('@libsql/') || name.startsWith('better-sqlite3-')
}

test('G1: Electron 侧不引入任何原生数据库模块（数据库全部留在 Python sidecar）', () => {
  const pkg = JSON.parse(readSource(join(desktopRoot, 'package.json'))) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const violations: string[] = []
  for (const section of ['dependencies', 'devDependencies']) {
    const block = pkg[section as 'dependencies' | 'devDependencies'] ?? {}
    for (const name of Object.keys(block)) {
      if (isBannedDbModule(name)) violations.push(`${section} → ${name}`)
    }
  }

  assert.deepEqual(
    violations,
    [],
    `package.json 里出现了被禁的原生数据库模块（应留在 Python 侧）：\n  ${violations.join('\n  ')}\n` +
      `参考：AGENTS.md §4「Electron 侧不得引入任何原生数据库模块」。`
  )
})

// ── G2 渲染进程不得有系统能力 ──────────────────────────────────────────

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib'
])

test('G2: 渲染进程不 import 任何 Node 内置模块（能力一律经 preload 白名单）', () => {
  const files = listFiles(rendererDir)
  assert.ok(files.length > 0, 'src/renderer 下没有扫到任何文件，守卫形同虚设，请检查扫描路径')

  const violations: string[] = []
  for (const file of files) {
    for (const spec of moduleSpecifiers(readSource(file))) {
      const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec
      if (spec.startsWith('node:') || NODE_BUILTINS.has(bare)) {
        violations.push(`${show(file)} → ${spec}`)
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `渲染进程出现 Node 内置模块 import：\n  ${violations.join('\n  ')}\n` +
      `渲染进程唯一的能力入口是 window.api（src/preload/index.ts）。`
  )
})

// ── G3 渲染进程不得直连 sidecar ────────────────────────────────────────

const LOOPBACK_PATTERN = /127\.0\.0\.1|localhost|\[::1\]/i
/** `EventSource` / `fetch` / `XMLHttpRequest` 都按**整个标识符**匹配（`ChatStreamSource` 这类名字不算）。 */
const HTTP_CALL_PATTERN = /\bfetch\s*\(|XMLHttpRequest|\bEventSource\b/

test('G3: 渲染进程不直连 sidecar 的 HTTP 端点', () => {
  const files = listFiles(rendererDir)
  assert.ok(files.length > 0, 'src/renderer 下没有扫到任何文件，守卫形同虚设，请检查扫描路径')

  const loopbackHits: string[] = []
  const httpCallHits: string[] = []

  for (const file of files) {
    const source = readSource(file)
    if (LOOPBACK_PATTERN.test(source)) loopbackHits.push(show(file))
    if (HTTP_CALL_PATTERN.test(source)) httpCallHits.push(show(file))
  }

  assert.deepEqual(
    loopbackHits,
    [],
    `渲染进程出现回环地址字面量（sidecar 只允许主进程访问）：\n  ${loopbackHits.join('\n  ')}\n` +
      `渲染进程要数据请走 window.api；一旦直连，token 下发与跨源/CORS 故障会全部回来。`
  )
  assert.deepEqual(
    httpCallHits,
    [],
    `渲染进程出现 HTTP 调用（fetch / XMLHttpRequest / EventSource）：\n  ${httpCallHits.join('\n  ')}\n` +
      `与 sidecar 的通信只允许发生在主进程的 bridge/client.ts。`
  )
})

// ── G4 6 事件词表 ─────────────────────────────────────────────────────

const EXPECTED_EVENTS = ['delta', 'citation', 'payload', 'blocked', 'done', 'error']

test('G4: 6 事件词表严格是 delta/citation/payload/blocked/done/error', () => {
  const source = readSource(sharedEventsFile)

  const runtimeList = /export\s+const\s+IPC_EVENT_NAMES[^=]*=\s*\[([\s\S]*?)\]/.exec(source)
  assert.ok(runtimeList, `${show(sharedEventsFile)} 里找不到 IPC_EVENT_NAMES 数组`)

  const runtimeNames = runtimeList[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0)

  assert.deepEqual(
    runtimeNames,
    EXPECTED_EVENTS,
    `IPC_EVENT_NAMES 与实际冻结词表不一致：\n  期望：${EXPECTED_EVENTS.join(', ')}\n  实际：${runtimeNames.join(', ')}`
  )

  const typeAlias = /export\s+type\s+IpcEventName\s*=\s*([^\n]+)/.exec(source)
  assert.ok(typeAlias, `${show(sharedEventsFile)} 里找不到 IpcEventName 类型别名`)

  const typeNames = [...typeAlias[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(
    typeNames,
    EXPECTED_EVENTS,
    `IpcEventName 联合类型与冻结词表不一致：\n  期望：${EXPECTED_EVENTS.join(', ')}\n  实际：${typeNames.join(', ')}`
  )
})

// ── G5 sidecar HTTP 客户端唯一性 ──────────────────────────────────────

const FETCH_PATTERN = /\bfetch\s*\(/

test('G5: src/main/bridge/client.ts 是唯一对 sidecar 发 HTTP 请求的文件', () => {
  const files = listFiles(mainDir)
  assert.ok(files.length > 0, 'src/main 下没有扫到任何文件，守卫形同虚设，请检查扫描路径')

  // 只看**可执行代码**：注释里写「这里不出现 fetch(」是解释纪律，不该被判违规
  // （踩过一次：注释里举反例，守卫当场把写注释的人拦下）。
  const offenders = files
    .filter((file) => resolve(file) !== resolve(bridgeClientFile))
    .filter((file) => FETCH_PATTERN.test(stripComments(readSource(file))))
    .map(show)

  assert.deepEqual(
    offenders,
    [],
    `以下文件绕过了唯一的 sidecar HTTP 客户端（src/main/bridge/client.ts）：\n  ${offenders.join('\n  ')}\n` +
      `所有 /api/* 调用都必须走 client.ts，以保证 token 注入与脱敏只有一处。`
  )

  const clientSource = readSource(bridgeClientFile)
  assert.ok(
    FETCH_PATTERN.test(clientSource),
    `src/main/bridge/client.ts 里没有 fetch —— 它应当是对 sidecar 发请求的唯一出口`
  )
})

// ── G6 token 不出主进程 ───────────────────────────────────────────────

/** token 出现在渲染进程侧的典型形态（参数名 / 请求头名 / 裸标识符）。 */
const TOKEN_LEAK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '--token 命令行参数', pattern: /--token/ },
  { label: 'X-Auth-Token 请求头', pattern: /X-Auth-Token/i },
  { label: 'AUTH_HEADER 常量', pattern: /AUTH_HEADER/ },
  { label: 'token 标识符/字符串', pattern: /\btoken\b/i }
]

test('G6a: SidecarState 结构上就没有 token 字段（状态会经 IPC 推给渲染进程）', () => {
  const body = interfaceBody(readSource(sidecarProtocolFile), 'SidecarState', sidecarProtocolFile)

  // 逐行看字段声明，避免把注释里的「不含 token」误判成字段
  const tokenFields = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(readonly\s+)?token\??\s*:/.test(line))

  assert.deepEqual(
    tokenFields,
    [],
    `SidecarState 里出现了 token 字段：\n  ${tokenFields.join('\n  ')}\n` +
      `它的副本会被 webContents.send 推给渲染进程，token 绝不能进这个结构（票 02 纪律）。`
  )

  // 正向断言：这个结构确实承载了「阶段 + 端口 + pid」，不是被清空了
  const bodyOneLine = body.replace(/\s+/g, ' ')
  for (const field of ['phase', 'port', 'pid', 'mode', 'restarts', 'lastError']) {
    assert.ok(
      new RegExp(`\\b${field}\\??\\s*:`).test(bodyOneLine),
      `SidecarState 缺少字段 ${field}（渲染进程要靠它渲染状态徽章）`
    )
  }
})

test('G6b: renderer/ 与 preload/ 的可执行代码里不出现 token 相关标识', () => {
  const files = [...listFiles(rendererDir), ...listFiles(preloadDir)]
  assert.ok(files.length > 0, 'src/renderer 或 src/preload 下没有扫到文件，守卫形同虚设')

  const violations: string[] = []
  for (const file of files) {
    const code = stripComments(readSource(file))
    for (const { label, pattern } of TOKEN_LEAK_PATTERNS) {
      if (pattern.test(code)) violations.push(`${show(file)} → ${label}`)
    }
  }

  assert.deepEqual(
    violations,
    [],
    `渲染进程侧的可执行代码里出现 token 相关标识：\n  ${violations.join('\n  ')}\n` +
      `token 只在主进程内存里，由 src/main/bridge/client.ts 统一注入 X-Auth-Token；` +
      `渲染进程只有 window.api（preload 白名单），既拿不到 token 也没有 HTTP 能力。` +
      `（注释里解释这件事不算违规——扫描前已去注释。）`
  )
})

test('G6c: 面向渲染进程的 IPC 请求/回执类型里没有 token（chat 边界同样干净）', () => {
  const source = readSource(channelsFile)

  const requestFields = declaredFields(interfaceBody(source, 'ChatSendRequest', channelsFile))
  const resultText = /export\s+type\s+ChatSendResult\s*=([\s\S]*?)(?=\n\nexport|$)/.exec(source)?.[1]
  assert.ok(resultText, `${show(channelsFile)} 里找不到 ChatSendResult 类型`)
  const resultFields = [...resultText.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1])

  assert.ok(requestFields.includes('text'), '`ChatSendRequest` 必须承载学生输入（text）')
  assert.ok(resultFields.includes('requestId'), '`ChatSendResult` 必须回传本轮请求号（requestId）')

  for (const field of [...new Set([...requestFields, ...resultFields])]) {
    assert.ok(!/token/i.test(field), `IPC 类型里出现 token 字段：${field}`)
  }

  // 正向断言：`chat:send` 的入参**只有文本** —— 没有通道参数、没有鉴权参数，
  // 也**没有学段**：学段由系统推断（D-020），前端连请求改学段的能力都不提供
  assert.deepEqual([...requestFields].sort(), ['text'])
})

// ── G7 对话事件流经「主进程 IPC ↔ preload 白名单通道」 ──────────────────

test('G7: 对话事件流经主进程 IPC 与 preload 白名单通道传递（两端必须用同一批通道）', () => {
  const channels = stringLiteralRecord(readSource(channelsFile), 'IPC', channelsFile)
  const pushChannels = pushChannelNames()

  assert.ok(channels.chatSend, `${show(channelsFile)} 必须声明「发一轮对话」的通道`)
  assert.ok(channels.chatEvent, `${show(channelsFile)} 必须声明「事件流」的通道`)
  assert.ok(
    pushChannels.includes(channels.chatEvent),
    `事件流通道必须登记为「主进程 → 渲染进程」的推送通道（PUSH_CHANNELS）：${pushChannels.join(', ')}`
  )
  assert.ok(
    !pushChannels.includes(channels.chatSend),
    '「发一轮对话」是 invoke 通道（有回执），不该被当成推送通道'
  )

  // 主进程侧：handle 接一轮 + 经 webContents.send 推事件（渲染进程不轮询、不拉取）
  const handlers = readSource(handlersFile)
  assert.ok(
    /ipcMain\.handle\(IPC\.chatSend/.test(handlers),
    `${show(handlersFile)} 里看不到 ipcMain.handle(IPC.chatSend, ...)：对话入口必须走主进程处理器`
  )
  assert.ok(
    /webContents\.send\(IPC\.chatEvent/.test(handlers),
    `${show(handlersFile)} 里看不到 webContents.send(IPC.chatEvent, ...)：事件流必须由主进程推送`
  )

  // preload 侧：invoke 发一轮 + on 订阅事件（渲染进程唯一的能力入口）
  const preload = readSource(preloadIndexFile)
  assert.ok(
    /ipcRenderer\.invoke\(IPC\.chatSend/.test(preload),
    `${show(preloadIndexFile)} 里看不到 ipcRenderer.invoke(IPC.chatSend, ...)`
  )
  assert.ok(
    /ipcRenderer\.on\(IPC\.chatEvent/.test(preload),
    `${show(preloadIndexFile)} 里看不到 ipcRenderer.on(IPC.chatEvent, ...)`
  )

  // 渲染进程侧：事件只能经「订阅模块」进来，发送只能经 store（都不用知道通道名）
  const rendererFiles = listFiles(rendererDir)
  const codeOf = (file: string): string => stripComments(readSource(file))
  const receivers = rendererFiles.filter((file) => /onChatEvent\(/.test(codeOf(file))).map(show)
  const senders = rendererFiles.filter((file) => /window\.api\.sendChat\(/.test(codeOf(file))).map(show)

  assert.deepEqual(
    receivers,
    [show(rendererEventsFile)],
    `事件流只应由 ${show(rendererEventsFile)} 订阅（其它模块从 store 拿状态，不各自订阅）`
  )
  assert.deepEqual(
    senders,
    ['src/renderer/src/stores/chat.ts'],
    '发送对话只应由 stores/chat.ts 发起（组件只把文字交给 store）'
  )
})

// ── G8 通道名单一来源 ─────────────────────────────────────────────────

test('G8: 通道名只在 channels.ts 出现一次（主进程与 preload 共用同一来源）', () => {
  const literals = Object.values(stringLiteralRecord(readSource(channelsFile), 'IPC', channelsFile))
  assert.ok(literals.length >= 4, `通道数看起来不对：${literals.join(', ')}`)

  const files = listFiles(srcDir).filter((file) => resolve(file) !== resolve(channelsFile))
  const offenders: string[] = []
  for (const file of files) {
    const source = readSource(file)
    for (const literal of literals) {
      if (source.includes(`'${literal}'`) || source.includes(`"${literal}"`)) {
        offenders.push(`${show(file)} → ${literal}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `以下文件手写了通道字符串（应当 import IPC 常量）：\n  ${offenders.join('\n  ')}\n` +
      `通道名单一来源是 ${show(channelsFile)}，白名单与处理器都从那里取名字。`
  )
})

// ── G9 preload 白名单 ────────────────────────────────────────────────

/** 渲染进程能看到的全部能力（每次新增都必须在这里显式登记并被审阅）。 */
const EXPECTED_API_METHODS = [
  'getSidecarInfo',
  'onSidecarChanged',
  'sendChat',
  'onChatEvent',
  'readSettings',
  'saveSettings',
  'probeSettings',
  // 供应商预设 / 拉取模型（设置页选端点与模型名用的**只读**辅助能力；不含任何凭证）
  'readProviderCatalog',
  'fetchProviderModels',
  'getGrade',
  'onGradeChanged',
  // 票 18：代码执行桥（主进程只**下发**代码，渲染进程在 Pyodide Worker 里跑，结果回传）
  'onCodeExecute',
  'sendCodeResult'
]

/** preload 里绝不允许出现的通用转发方法名。 */
const GENERIC_BRIDGE_METHODS = ['send', 'sendSync', 'invoke', 'on', 'once', 'off', 'postMessage', 'ipcRenderer']

test('G9: preload 只暴露白名单方法，不暴露通用 ipcRenderer 转发', () => {
  const source = readSource(preloadIndexFile)
  const methods = declaredMethods(interfaceBody(source, 'K12Api', preloadIndexFile))

  assert.deepEqual(
    [...methods].sort(),
    [...EXPECTED_API_METHODS].sort(),
    `${show(preloadIndexFile)} 的 K12Api 方法集合与白名单不一致：\n` +
      `  实际：${methods.join(', ')}\n  期望：${EXPECTED_API_METHODS.join(', ')}\n` +
      `渲染进程只能看到这些显式方法（新增能力要在这里加一个方法，而不是放开一个通用口子）。`
  )

  const generic = methods.filter((method) => GENERIC_BRIDGE_METHODS.includes(method))
  assert.deepEqual(generic, [], `preload 里出现通用转发方法：${generic.join(', ')}`)

  // 只暴露一个对象，名字固定为 api（没有第二个桥）
  const exposed = [...source.matchAll(/contextBridge\.exposeInMainWorld\(([^)]*)\)/g)].map((match) => match[1])
  assert.deepEqual(
    exposed,
    ["'api', api"],
    `contextBridge 暴露面必须只有 window.api 一个：${JSON.stringify(exposed)}`
  )

  // 白名单通道集合 == 通道名单一来源里的全部通道（既不多也不少）
  const channelValues = [...new Set(Object.values(stringLiteralRecord(readSource(channelsFile), 'IPC', channelsFile)))]
  const block = /export\s+const\s+WHITELISTED_CHANNELS[^=]*=\s*\[([\s\S]*?)\]/.exec(source)?.[1]
  assert.ok(block, `${show(preloadIndexFile)} 里找不到 WHITELISTED_CHANNELS`)
  const channelKeys = stringLiteralRecord(readSource(channelsFile), 'IPC', channelsFile)
  const whitelisted = [...block.matchAll(/IPC\.(\w+)/g)].map((match) => channelKeys[match[1]])

  assert.deepEqual(
    [...whitelisted].sort(),
    [...channelValues].sort(),
    `preload 白名单通道与通道定义不一致：${whitelisted.join(', ')}`
  )

  // ipcRenderer 只做 `ipcRenderer.xxx(...)` 调用，绝不作为值传给别的函数
  const code = stripComments(source).replace(/^import[\s\S]*?from\s*'[^']*'/gm, ' ')
  const valueUses = [...code.matchAll(/[([{,]\s*ipcRenderer\b(?!\s*\.)/g)].map((match) => match[0].trim())
  assert.deepEqual(valueUses, [], `ipcRenderer 被当成值传出去了（渲染进程会拿到通用 IPC 能力）：${valueUses.join(' / ')}`)
})

 *   - ★ **`src/shared/provider-catalog.ts` 也被扫**（它是架构里唯一被批准的契约例外，
 *    而 `provider-catalog.ts` 的性质不同：它**只承载界面展示用的候选清单**，
  // ④ ★ `shared/provider-catalog.ts` 也被扫：它是架构里**唯一被批准的契约例外**
  const sharedCatalogFile = join(desktopRoot, 'src', 'shared', 'provider-catalog.ts')
    `provider-catalog.ts 的可执行代码里出现凭证字段名（该文件承诺「不允许任何凭证字段」）：\n  ` +
// ── G10 Tool → payload.kind 映射表 ───────────────────────────────────

test('G10: TOOL_TO_KIND 只有一处定义；7 个 Tool 在表内，画像/检索不在表内', () => {
  const table = stringLiteralRecord(readSource(toolKindsFile), 'TOOL_TO_KIND', toolKindsFile)

  assert.deepEqual(
    table,
    {
      generate_animation: 'animation',
      get_code_template: 'coding',
      get_coding_hint: 'coding',
      evaluate_code: 'coding',
      generate_quiz: 'quiz',
      submit_quiz: 'quiz',
      generate_variants: 'quiz'
    },
    `Tool → kind 映射与冻结表（执行文档 §9.3）不一致：${JSON.stringify(table)}`
  )

  // 这两个 Tool **不发** payload：画像只影响 Prompt，检索结果走 citation 事件
  for (const tool of ['rag_search', 'get_student_profile']) {
    assert.ok(!(tool in table), `${tool} 不该出现在 TOOL_TO_KIND 里（它不发 payload 事件）`)
  }

  const files = listFiles(srcDir).filter((file) => resolve(file) !== resolve(toolKindsFile))
  const offenders = files.filter((file) => /\bTOOL_TO_KIND\b/.test(readSource(file))).map(show)
  assert.deepEqual(
    offenders,
    [],
    `TOOL_TO_KIND 必须只有一处定义（${show(toolKindsFile)}）：\n  ${offenders.join('\n  ')}\n` +
      `其它模块请从那里 import，避免两张表悄悄漂移。`
  )
})

// ── G11 6 事件载荷字段 ────────────────────────────────────────────────

const EXPECTED_EVENT_FIELDS: Record<string, string[]> = {
  DeltaEvent: ['requestId', 'delta'],
  CitationEvent: ['requestId', 'citations'],
  PayloadEvent: ['requestId', 'kind', 'payload'],
  BlockedEvent: ['requestId', 'reason', 'safeText'],
  DoneEvent: ['requestId', 'messageId'],
  ErrorEvent: ['requestId', 'message', 'degraded']
}

test('G11: 6 事件载荷字段与契约逐字一致（每个事件都带同一个 requestId）', () => {
  const source = readSource(sharedEventsFile)

  for (const [name, fields] of Object.entries(EXPECTED_EVENT_FIELDS)) {
    const declared = declaredFields(interfaceBody(source, name, sharedEventsFile))
    for (const field of fields) {
      assert.ok(
        declared.includes(field),
        `${name} 缺少字段 ${field}（执行文档 §6.4 的载荷冻结，字段名一个字都不能改）`
      )
    }
    assert.ok(declared.includes('requestId'), `${name} 必须带 requestId（一轮对话靠它关联）`)
  }

  // 判别联合：`name` 与 `data` 一一对应
  const union = /export\s+type\s+IpcEvent\s*=([\s\S]*?)(?=\n\nexport|$)/.exec(source)?.[1] ?? ''
  assert.ok(union.length > 0, `${show(sharedEventsFile)} 里找不到 IpcEvent 判别联合`)
  for (const name of EXPECTED_EVENTS) {
    assert.ok(new RegExp(`name:\\s*'${name}'`).test(union), `IpcEvent 判别联合里缺少 ${name} 分支`)
  }
})

// ── G12 渲染进程没有解析层 ────────────────────────────────────────────

test('G12: 渲染进程接事件是订阅回调（IPC 不需要解析层）', () => {
  const files = listFiles(rendererDir)
  assert.ok(files.length > 0, 'src/renderer 下没有扫到文件，守卫形同虚设')

  const decoders = files
    .filter((file) => /\bTextDecoder\b|\bEventSource\b/.test(stripComments(readSource(file))))
    .map(show)
  assert.deepEqual(
    decoders,
    [],
    `渲染进程出现字节流解码/事件源原语：\n  ${decoders.join('\n  ')}\n` +
      `IPC 传的是结构化对象，只需订阅回调；出现解析层说明有人把字节流那套搬回来了。`
  )

  // 正向断言：订阅与分发是两个具名入口，分发是纯函数
  const eventsSource = readSource(rendererEventsFile)
  assert.ok(
    /export\s+function\s+subscribeToChatEvents/.test(eventsSource),
    `${show(rendererEventsFile)} 必须提供订阅入口 subscribeToChatEvents()`
  )
  assert.ok(
    /export\s+function\s+applyChatEvent/.test(eventsSource),
    `${show(rendererEventsFile)} 必须把事件分发做成纯函数 applyChatEvent()（可单测、可容错）`
  )
})

// ── 共用小工具（放在末尾，避免打断上面的守卫阅读顺序） ──────────────────

/** 读出 `channels.ts` 里登记为「主进程 → 渲染进程」推送的通道值。 */
function pushChannelNames(): string[] {
  const source = readSource(channelsFile)
  const keys = stringLiteralRecord(source, 'IPC', channelsFile)
  const block = /export\s+const\s+PUSH_CHANNELS[^=]*=\s*\[([\s\S]*?)\]/.exec(source)?.[1]
  assert.ok(block, `${show(channelsFile)} 里找不到 PUSH_CHANNELS`)
  return [...block.matchAll(/IPC\.(\w+)/g)].map((match) => keys[match[1]])
}
