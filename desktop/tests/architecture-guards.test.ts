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
 *   G10 ★ `TOOL_TO_KIND` 单一定义：9 个 Tool 在表内，`rag_search` / `get_student_profile` 不在表内
 *   G11 ★ 6 事件载荷字段与契约逐字一致（`shared/ipc-events.ts`）
 *   G12 ★ 渲染进程接事件是**订阅回调**：不存在解析层（无 `TextDecoder` / `EventSource`）
 *   G13 ★ 明文 LLM 配置只有主进程能取；`shared/provider-catalog.ts`（唯一的契约例外）
 *       也被扫，且对它单独启用凭证禁词表
 *
 * 跑法：`npm test`。全部用 fs 读源码做静态断言，失败信息里带上具体文件路径。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

/**
 * 抽出 `export interface NAME { ... }` 的主体。
 *
 * ★ 用**花括号配平**定位结尾，而不是「找第一个顶格 `\n}`」：接口一旦被写成单行
 *   （`export interface X { a: string }`），后者会一路吞到文件里**下一处**顶格 `}`，
 *   提取器于是去看另一个接口的成员 —— 守卫照样通过，却什么都没守（实测复现过）。
 * ★ 先 `stripComments`：文档注释里的 `{@link x}` / `{ok,data}` 会让配平算歪。
 * ★ 单行接口直接判违规：字段/方法提取器都是**按行**读声明的，单行写法整块漏得掉，
 *   所以这里宁可响亮失败，也不给它静默漏过的机会。
 */
function interfaceBody(source: string, name: string, file: string): string {
  const code = stripComments(source)
  const head = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).exec(code)
  assert.ok(head, `${show(file)} 里找不到 interface ${name}`)

  const open = code.indexOf('{', head.index)
  let depth = 0
  let close = -1
  for (let index = open; index < code.length; index += 1) {
    const char = code[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  assert.ok(close > open, `${show(file)} 的 interface ${name} 花括号不配平（提取不出主体）`)

  const body = code.slice(open + 1, close)
  assert.ok(
    body.includes('\n'),
    `${show(file)} 的 interface ${name} 被写成了单行 —— 字段/方法提取器按行读声明，` +
      '单行接口会被整块漏掉（守卫静默失守）。请把每个成员写在自己的一行上。'
  )
  return body
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

/**
 * 把接口主体切成一个个成员声明。
 *
 * ★ 切分符必须同时含 `;`：TypeScript 允许同一行写两个成员
 *   （`text: string; gradeLevel?: GradeLevel`）—— 只按 `\n` 切时**第二个成员整块看不见**，
 *   提取器于是报出一个「干净」的字段集合（实测复现：G6c 照样通过）。
 */
function splitMembers(body: string): string[] {
  return body
    .split(/[\n;]/)
    .map((member) => member.trim())
    .filter((member) => member.length > 0)
}

/** 接口主体里的属性名（逐行看声明，避免把注释里的词误判成字段）。 */
function declaredFields(body: string): string[] {
  return splitMembers(body)
    .map((member) => /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(member))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1])
}

/**
 * 接口主体里的方法名。**两种写法都要认**：
 *   - 签名式：`getName(args): ret`
 *   - 属性式（箭头属性）：`getName: (args) => ret` / `getName: (...) => ret`
 *
 * ★ 属性式那一支不能漏：`contextBridge.exposeInMainWorld('api', api)` 暴露的是**对象字面量**，
 *   属性式写法在运行期与签名式完全等价（真的会被暴露给渲染进程），
 *   而只认 `name(` 的正则把它整块漏掉 —— G9 的白名单断言照样通过（实测复现过）。
 */
function declaredMethods(body: string): string[] {
  return splitMembers(body)
    .map((member) => /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|\??\s*:\s*\()/.exec(member))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1])
}

/**
 * 抽出 `const NAME: T = { ... }` 对象字面量在**深度 0**处的键。
 *
 * ★ 为什么 G9 不能只信 `K12Api` 接口：`node --test` 只做类型擦除、**不做类型检查**，
 *   所以「接口声明了但字面量里没有」「字面量里多出一个属性式方法」这类不一致，
 *   在测试进程里既不报错也看不出（`const api: K12Api = {...}` 的赋值检查是 tsc 的事，
 *   `npm test` 根本不跑 tsc）。而 `contextBridge` 暴露的正是这个字面量 ——
 *   **它的键集合才是真实的暴露面**。
 * ★ 不能逐行正则：字面量里嵌着箭头函数体（`onChatEvent` 里还有第二层箭头），
 *   行首匹配会把函数体里的语句也当成键。这里按「花括号/圆括号深度 + 跳过字符串」扫描，
 *   只在所有深度都是 0 的顶层取「标识符 + 冒号」。
 */
function objectLiteralKeys(source: string, name: string, file: string): string[] {
  const code = stripComments(source)
  const decl = new RegExp(`\\bconst\\s+${name}\\s*:[^=\\n]*=\\s*\\{`).exec(code)
  assert.ok(decl, `${show(file)} 里找不到 ${name} 的对象字面量（应当写成 \`const ${name}: T = { ... }\`）`)

  const body = code.slice(decl.index + decl[0].length)
  const keys: string[] = []
  let braces = 0
  let parens = 0
  let quote: string | null = null

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string

    if (quote !== null) {
      // 字符串内部的一切都不算结构（`'chat:event'` 里的冒号不是键分隔符）
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') {
      braces += 1
      continue
    }
    if (char === '}') {
      if (braces === 0) break // 字面量结束
      braces -= 1
      continue
    }
    if (char === '(') {
      parens += 1
      continue
    }
    if (char === ')') {
      parens -= 1
      continue
    }

    if (braces !== 0 || parens !== 0) continue
    if (!/[A-Za-z_$]/.test(char)) continue
    if (index > 0 && /[\w$]/.test(body[index - 1] as string)) continue

    const matched = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(index))
    if (!matched) continue
    keys.push(matched[1] as string)
    index += matched[0].length - 1
  }

  assert.ok(keys.length > 0, `${show(file)} 的 ${name} 里没解析出任何键`)
  return keys
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

/**
 * ★ 主进程里**允许出现 `fetch(` 的全部文件**（两个，各管一条互不相干的路）。
 *
 * 票 31 之前只有一个：sidecar。接上真实的画像概括之后多了「外部大模型服务」这一条 ——
 *   它对端是**用户在设置里填的供应商地址**，凭证是**供应商 Key**（不是 sidecar token），
 *   目标路径是 `/chat/completions`（不是 `/api/*`）。
 * 把它塞进 `client.ts` 是错的（那边是 127.0.0.1 + 启动新铸的 token + `/api/*` 纪律）；
 * 让调用点就地 `fetch` 更错（那是「凭证注入有几处」这个问题重新失去答案）。
 * 所以这里是**两个出口** —— 判据不是「数量」，而是「每条路的凭证注入只有一处」。
 */
const EGRESS_FILES = [bridgeClientFile, join(mainDir, 'bridge', 'llm-completions.ts')]

test('G5: 出网只有两个口 —— sidecar 走 client.ts，外部模型走 llm-completions.ts', () => {
  const files = listFiles(mainDir)
  assert.ok(files.length > 0, 'src/main 下没有扫到任何文件，守卫形同虚设，请检查扫描路径')

  // 只看**可执行代码**：注释里写「这里不出现 fetch(」是解释纪律，不该被判违规
  // （踩过一次：注释里举反例，守卫当场把写注释的人拦下）。
  const allowed = new Set(EGRESS_FILES.map((file) => resolve(file)))
  const offenders = files
    .filter((file) => !allowed.has(resolve(file)))
    .filter((file) => FETCH_PATTERN.test(stripComments(readSource(file))))
    .map(show)

  assert.deepEqual(
    offenders,
    [],
    `以下文件自己发了 HTTP 请求，绕过了两个出网口：\n  ${offenders.join('\n  ')}\n` +
      `sidecar（/api/*）必须走 bridge/client.ts；外部模型服务必须走 bridge/llm-completions.ts，\n` +
      `以保证「token 注入」与「供应商 Key 注入」各自只有一处。`
  )

  for (const file of EGRESS_FILES) {
    assert.ok(
      FETCH_PATTERN.test(readSource(file)),
      `${show(file)} 里没有 fetch —— 它应当是一个真正的出网口（白名单里挂了个空壳等于把口子开没影）`
    )
  }
})

test('G5b: 两个出网口不许串味 —— sidecar 口不碰供应商 Key，模型口不打 /api/', () => {
  const clientSource = stripComments(readSource(bridgeClientFile))
  const llmSource = stripComments(readSource(join(mainDir, 'bridge', 'llm-completions.ts')))

  // ① sidecar 的凭证是 X-Auth-Token（每次启动新铸）；供应商 Key 的形态是 Bearer。
  //    两边串了 = 把供应商 Key 发给了本机 sidecar，或把本机 token 发给了公网。
  assert.ok(
    !/Authorization/.test(clientSource),
    'bridge/client.ts 里出现了 Authorization —— sidecar 只认 X-Auth-Token，' +
      '供应商 Bearer Key 绝不许出现在这一侧（它会随 /api/* 一起落进 sidecar 的日志）'
  )
  assert.ok(
    !/'\/api\//.test(llmSource) && !/"\/api\//.test(llmSource),
    'bridge/llm-completions.ts 里出现了 /api/ 字面量 —— 外部模型口不许借道打 sidecar'
  )
  // ② 两边都必须是 POST 之外的通用实现：sidecar 口按 path 走，模型口只认 http(s)
  assert.match(clientSource, /X-Auth-Token/, 'bridge/client.ts 必须继续在这里注入唯一那份 sidecar token')
  assert.match(llmSource, /\^https\?:\\\/\\\//, '模型口必须校验地址是 http(s)（配置里塞进 file:// 时不许出网）')
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
  // 也**没有学段**：学段的手动写入走 `grade:set` 这条独立通道（`IPC.gradeSet`），
  // 对话请求永远只有 `text`（发消息与改学段是两件事，不能互为副作用）。
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
  // ★ 学段**唯一的手动写入口**（学生显式设定，走 grade:set 独立通道）。
  //   刻意不混进 `ChatSendRequest`：发消息与改学段是两件事（G6c 钉着请求只有 text）。
  'setGrade',
  'onGradeChanged',
  // 教材章节（**软偏好**）：与学段那一对完全对称 —— 两条 invoke + 一条推送。
  // ★ 同样刻意不混进 `ChatSendRequest`：章节是学生的显式选择，不该成为「发消息」的副作用。
  // ★ 章节**不进检索契约、不做 SQL 硬过滤**：它只让回答优先围绕本章，学生问别的章照常回答。
  'getChapter',
  'setChapter',
  'onChapterChanged',
  // 票 18：代码执行桥（主进程只**下发**代码，渲染进程在 Pyodide Worker 里跑，结果回传）
  'onCodeExecute',
  'sendCodeResult',
  // 学习档案（章节 / 报告 / 错题本 / 学习地图）：**纯转发**，聚合全在 Python 侧。
  // ★ 四条都不接受 `studentId`：学生身份由主进程决定（否则等于允许读别人的记录）。
  'readStudyReport',
  'readStudyMistakes',
  'readStudyChapters',
  'readStudyGraph',
  // ★ 学习历史（2026-09-30）：学习档案的第六个分页（只递分页参数，不接受 studentId）。
  'readStudyHistory',
  // 历史会话：`readSessionTranscript` 与 `openSession` 都**只接受会话 id**，
  // 主进程先用 Pi 列出的会话做白名单对齐 —— 渲染进程无法指定路径。
  'listSessions',
  'readSessionTranscript',
  'searchSessions',
  // ★ 会话切换 / 新建 / 当前状态（三条 invoke）+ 变化推送（一条 push）。
  //   ★ `startNewSession` 与 `chat:send` **分开**是刻意的：`ChatSendRequest` 的字段集合
  //     被 G6c 钉死为 `['text']`，把「开会话」塞进去会让「发一条消息」变成
  //     「顺带换一个会话」的副作用（与学段/章节不走对话请求同一条纪律）。
  //   ★ `onSessionChanged` 是**推送**：学生会在别处改变当前会话（列表里点开另一条、
  //     标题在后台生成完成），渲染进程观察不到那些动作 —— 不推的话侧栏永远高亮旧会话。
  'getSessionState',
  'openSession',
  'startNewSession',
  // ★★ 会话分叉（「从这里重新问」）：把「根 → 该消息」复制成新会话，原会话不动。
  //   两个入参都只当字符串 id 用 —— `sessionId` 走会话白名单、`entryId` 由主进程
  //   核对该会话的条目清单（渲染进程指不了别的会话）。
  'branchSession',
  // ★★ 会话删除（2026-09-22）：本项目**唯一**的破坏性能力。入参只当字符串 id 用 ——
  //   主进程先做会话白名单对齐（path 由 Pi 给），再断言路径落在当前学生的 sessionDir 里
  //   （两道防线都在 `study/sessions.ts` 的 `resolveDeletionTarget`，可单测）。
  //   ⚠️ 不要把它并进别的通道（比如给 `session:open` 加个 `delete: true`）：
  //      破坏性操作该有自己的名字，将来审计「谁能删东西」时只有这一处要查。
  'deleteSession',
  'onSessionChanged',
  // ★ 本轮条目 id（`turn:entries` 推送）：「从这里重新问」的分叉点靠它 ——
  //   没有它，那个按钮只对**历史消息**出现，对刚聊出来的回答不出现（实测 P-105）。
  'onTurnEntries',
  // 导出：回执**只有文件名**（完整路径不进渲染进程）
  'exportMarkdown',
  // ★ 演示模式：轮次诊断信封（两条 invoke + 一条推送）。
  //   它**不是** 6 事件之一：信封是「这一轮背后发生了什么」的旁路证据，
  //   与对话状态机不是一回事（与 `onTraceChanged` 同一判断）。
  'readDiagnostics',
  'clearDiagnostics',
  'onDiagnosticsChanged',
  // ★ 演示沙箱：预置数据的开关 / 状态 / 脚本（三条 invoke + **零推送**）。
  //   ⚠️ 与上面那三条是**两件事**：那三条管「把这一轮背后发生了什么摊开看」，
  //     这三条管「把这个应用切成看起来像用了两个月的状态」。
  //   ★ 三条都**不进** `PUSH_CHANNELS`：它们不产生任何流，只有回执。
  'readDemoState',
  'seedDemo',
  'readDemoScript',
  // 工具调用轨迹（**推送**；快照语义）。★ 它不是 6 事件之一：
  //   轨迹是工程证据（哪次调了什么 Tool、多快、有没有降级），与对话状态机不是一回事。
  'onTraceChanged',
  // 学生身份 / 画像 / 学段证据。★ 一律不接受 `studentId`：身份由主进程决定，
  //   递进一个 id 就等于允许读别人的画像与学习记录。
  'getStudent',
  // 账号（本机多个学生）：列表 / 建号 / 改名 / 删号 / 切号。
  // ★ 五条都**不接受**「以谁的身份」：身份仍由主进程 resolveActiveStudentId 决定，
  //   这里递的只是「操作哪一个账号」（后端会自己校验一遍）。
  'listAccounts',
  'createAccount',
  'renameAccount',
  'deleteAccount',
  'switchAccount',
  'readProfile',
  'readRecommendation',
  'readGradeSignals',
  'readGradeHistory',
  // 闯关（独立页面用；对话内的题卡仍走 chat 路径）。
  // ★ `readQuizBank` 的**学段由主进程注入**（前端指定不了它）——
  //   否则「只取不高于学生学段的内容」这条隔离就被绕开了。
  // ★ 题库载荷**不含标准答案**（`QuizQuestionOut`，答案只留 Python 侧）。
  'readQuizBank',
  'gradeQuiz',
  'readQuizProgress',
  // 编程（★ 注意这里**没有**「执行代码」的方法：执行只在渲染进程的 Pyodide Worker 里，
  //   主进程只把代码**下发**下去，见 `onCodeExecute` / `sendCodeResult`）
  'readCodeTemplate',
  'readCodeHint',
  // ★ 名字刻意不叫 `runCode`：它**不执行任何东西**，只把「已经跑完的代码与输出」
  //   交给后端做中文报错归一 + 定下一级提示。叫 run 会让人以为代码在这里跑。
  'analyzeCodeRun',
  // 动画：模板 → 渲染 → 一次性 nonce 托管（iframe 带不了 header，所以不能用 token 鉴权）
  'readAnimationTemplates',
  'renderAnimation',
  'hostAnimation',
  // 学生动画库 + 按需现做：**身份由主进程决定**，所以这些方法的入参里没有 studentId。
  // 库里存的是「按知识点 + 学段 + 请求指纹」分开的产物（同学段之外互不复用）。
  'readSavedAnimations',
  'readGeneratedQuestions',
  // ★ 练习页动态出题（票 32，D-132）：两条 invoke —— 自动追加 / 「还想再练练」。
  //   刻意**不**新增 Pi Tool、不进 6 事件词表：练习页不开对话（刷题不烧云端对话）。
  'generateQuizAuto',
  'generateQuizMore',
  'readSavedAnimation',
  'saveAnimationToLibrary',
  'deleteSavedAnimation',
  'composeAnimation',
  // 教材知识库：读三条 + 写两条。
  // ★ 写的那两条（导入 / 重建）用**长超时** —— 重建要跑整份教材的嵌入，
  //   用默认 8s 会把一次成功的重建报成超时。
  'readKnowledgeStats',
  'readKnowledgePoints',
  'importKnowledge',
  'rebuildKnowledge',
  // 窗口控制（无边框窗口的页面内按钮）。
  // ★ 窗口是 `frame: false`，没有系统标题栏可画这三个键，所以只能由页面要 ——
  //   而渲染进程没有 Node 能力，必须经 IPC。三条都**不接受参数**：
  //   作用对象由主进程从 `event.sender` 反查窗口，所以渲染进程指不了别的窗口。
  // ★ `onWindowMaximizedChanged` 是**推送**：双击拖拽区、Win+↑/↓、拖到屏幕上边缘
  //   都会改变最大化状态，渲染进程自己观察不到，只能由主进程推。
  'minimizeWindow',
  'toggleMaximizeWindow',
  'closeWindow',
  'onWindowMaximizedChanged',
  // ── 冷启动引导与画像标签（票 25；2026-09-28 集成期补登）─────────────────
  // ★ 为什么这 8 条必须登记在这里：G9 断言 preload 的方法集合与这份清单**逐字相等**
  //   （不多不少）。票 25 加了 8 条通道却没同步这里，于是 G9 红 —— 而它红得**对**：
  //   清单的意义就是「新增一个暴露面必须是一次显式动作」，漏登记等于绕过了审查。
  // ★ 六条 invoke + **一条推送**（'onOnboardingChanged'）。
  //   （票 31 删掉了 'skipOnboarding'：五问不允许跳过，未答完就续问，直到 done。
  //    少一个暴露面同样是「一次显式动作」，所以这里也要跟着删。）
  // ★ 全部**不接受 studentId**：身份由主进程 resolveActiveStudentId 决定 ——
  //   一旦它能指定，「读别人的画像」就只是一个字符串的距离（与 getStudent 同一条纪律）。
  // ★ 五问的回答走 answerOnboarding 这条独立通道，**绝不混进 sendChat**：
  //   'ChatSendRequest' 的字段集合被 G6c 钉死为 ['text']。
  'readOnboardingState',
  'answerOnboarding',
  'onOnboardingChanged',
  'readProfileTags',
  'retractProfileTag',
  // ★ 画像变化时间线（§5.2 #11）：与其它画像通道一样**不接受 studentId**，只递一个条数上限。
  'readProfileTimeline',
  // ★ 画像小结（三期，2026-09-30）：只读主进程缓存、不生成；同样不接受 studentId。
  'readProfileSummary',
  'readIdentity',
  'setIdentityFlags'
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

  // ★ 第二条判据：接口声明只是**类型**，真正被 `contextBridge.exposeInMainWorld` 交出去的是
  //   那个 `const api: K12Api = { ... }` 字面量 —— 它的键才是暴露面。
  //   两条都必须与白名单相等：字面量里多一个属性式方法（接口没写、或写成别的类型）
  //   在 `node --test`（只擦类型、不检查）里是隐形的，只有数键才看得见。
  const exposedKeys = [...new Set(objectLiteralKeys(source, 'api', preloadIndexFile))].sort()
  assert.deepEqual(
    exposedKeys,
    [...EXPECTED_API_METHODS].sort(),
    `${show(preloadIndexFile)} 的 \`api\` 对象字面量键集合与白名单不一致：\n` +
      `  实际：${exposedKeys.join(', ')}\n  期望：${EXPECTED_API_METHODS.join(', ')}\n` +
      `暴露面由这个字面量决定（不是接口声明），多一个键就是多一项渲染进程能力。`
  )

  const generic = [...new Set([...methods, ...exposedKeys])].filter((method) =>
    GENERIC_BRIDGE_METHODS.includes(method)
  )
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
  // ★★ 收尾锚点必须是**行首的 ]**（配 m 标志），不能用非贪婪的 \]（2026-09-28 集成期修正）。
  //   数组内部的注释里只要出现一个右方括号，非贪婪匹配就当场截断 ——
  //   本轮实测：注释里写了 `['text']`（说明 ChatSendRequest 只有 text），于是解析结果
  //   正好少掉最后 8 条新通道，而断言消息却说「白名单与通道定义不一致」，
  //   把人引去查 preload 的 channels 列表 —— 那里其实一条都不缺。
  //   症状（少 8 条）与原因（注释里一个字符）之间的这段距离，就是这条守卫的易碎点。
  const block = /export\s+const\s+WHITELISTED_CHANNELS[^=]*=\s*\[([\s\S]*?)^\]/m.exec(source)?.[1]
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

// ── G13 明文 LLM 配置绝不进渲染进程 ──────────────────────────────────

/**
 * ★★ 「设置 → Pi」这条链路需要**明文 Key**（Pi 必须拿到它才能发请求），
 * 而它的载体是 sidecar 的 `GET /api/settings/runtime`。
 *
 * 这条守卫把「明文只留给主进程」钉成**可判定的断言**（而不是只写在注释里）：
 *   - 渲染进程 / preload 里**不出现** `settings/runtime` 这个后端路径；
 *   - 渲染进程 / preload 的可执行代码里**不出现** `apiKey` 之外的明文配置字段名
 *     （`RuntimeLlmConfig` 是主进程独有的类型）；
 *   - preload 暴露的方法集合里没有「取明文配置」那一类方法；
 *   - ★ **`src/shared/provider-catalog.ts` 也被扫**（它是架构里唯一被批准的契约例外，
 *     也是唯一一份跨进程共享、可能被塞进凭证字段的类型集合；该文件自己写着
 *     「有架构守卫（G13）盯着凭证字段」—— 原来扫描集合不含 `shared/`，那条承诺是空的），
 *     并且对它单独启用**禁词表**（`apiKey|api_key|token|secret|Bearer|Authorization`，
 *     在 `stripComments` 之后的文本上判）。
 *
 * ⚠️ 为什么对 renderer/preload 用「后端路径 + 类型名」而不是「禁止 apiKey 字样」：
 *    设置页**本来就要**提交明文 Key（`LlmConfigIn.apiKey`，那是用户刚敲进去的），
 *    所以那两处用禁词表会把正常功能一起打死。
 *    真正要守的是「**读回**明文」这条路径 —— 它唯一的入口就是那个后端路径与那份配置类型。
 *    而 `provider-catalog.ts` 的性质不同：它**只承载界面展示用的候选清单**，
 *    本来就没有任何理由出现凭证字段，所以那里用禁词表是**正当的**（不是误伤）。
 */
test('G13: 明文 LLM 配置（含 API Key）只有主进程能取，渲染进程与 preload 都没有入口', () => {
  const runtimeConfigPath = 'settings/runtime'
  const runtimeConfigType = 'RuntimeLlmConfig'

  // ① 渲染进程与 preload 都不得直接引用后端那条路径
  const frontFacing = [...listFiles(rendererDir), ...listFiles(preloadDir)]
  const pathHits = frontFacing.filter((file) => readSource(file).includes(runtimeConfigPath)).map(show)
  assert.deepEqual(
    pathHits,
    [],
    `以下文件引用了 ${runtimeConfigPath}（那是**含明文 Key** 的配置接口，只允许主进程调用）：\n  ` +
      pathHits.join('\n  ')
  )

  // ② 主进程独有的配置类型不得被前端引用（含它的字段名组合）
  const typeHits = frontFacing.filter((file) => readSource(file).includes(runtimeConfigType)).map(show)
  assert.deepEqual(
    typeHits,
    [],
    `以下文件引用了 ${runtimeConfigType}（主进程独有的含明文配置类型）：\n  ` + typeHits.join('\n  ')
  )

  // ③ 正向断言：主进程侧**确实**有这条链路（否则上面两条会因为「功能被删掉」而空过）
  const mainRuntimeConfig = readSource(join(mainDir, 'settings', 'runtime-config.ts'))
  assert.ok(
    mainRuntimeConfig.includes(runtimeConfigPath),
    `${show(join(mainDir, 'settings', 'runtime-config.ts'))} 里看不到 ${runtimeConfigPath}：` +
      '主进程必须自己拉那份配置，否则「设置改完 Pi 不生效」的故障会回来。'
  )
  assert.ok(
    mainRuntimeConfig.includes('parseRuntimeLlmConfig'),
    'runtime-config.ts 必须做回执形状校验（不信任网络回执，缺字段要回落默认值）'
  )

  // ④ ★ `shared/provider-catalog.ts` 也被扫：它是架构里**唯一被批准的契约例外**
  //    （TS 手写类型，理由见文件头），也是唯一可能被塞进 `apiKey` 的**跨进程**类型集合。
  //    该文件自己声明「里面有架构守卫（G13）盯着凭证字段」—— 而原来的扫描集合只有
  //    renderer/ + preload/，**不含 `src/shared/`**，那条承诺的守卫根本不存在。
  const sharedCatalogFile = join(desktopRoot, 'src', 'shared', 'provider-catalog.ts')
  assert.ok(existsSync(sharedCatalogFile), `${show(sharedCatalogFile)} 必须存在（设置页的预设/拉取模型靠它）`)

  //    这两条路径/类型也**不许**出现在这份跨进程文件里（它不该成为取明文配置的后门）
  const catalogSource = readSource(sharedCatalogFile)
  assert.ok(
    !catalogSource.includes(runtimeConfigPath),
    `${show(sharedCatalogFile)} 引用了 ${runtimeConfigPath} —— 跨进程共享的文件不得碰含明文 Key 的接口`
  )
  assert.ok(
    !catalogSource.includes(runtimeConfigType),
    `${show(sharedCatalogFile)} 引用了 ${runtimeConfigType} —— 那是主进程独有的含明文配置类型`
  )

  //    ★ 显式**禁词**断言（stripComments 之后：注释里解释「这里不许出现 apiKey」不算违规）。
  const credentialWords = /\b(apiKey|api_key|token|secret|Bearer|Authorization)\b/
  const credentialLines = stripComments(catalogSource)
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => credentialWords.test(entry.line))
  assert.deepEqual(
    credentialLines.map((entry) => `L${entry.number}: ${entry.line}`),
    [],
    `provider-catalog.ts 的可执行代码里出现凭证字段名（该文件承诺「不允许任何凭证字段」）：\n  ` +
      credentialLines.map((entry) => `L${entry.number}: ${entry.line}`).join('\n  ') +
      '\n这份类型只承载「界面展示用的候选清单」，不应该有、也不需要任何 Key / token 字段。'
  )
})

// ── G10 Tool → payload.kind 映射表 ───────────────────────────────────

test('G10: TOOL_TO_KIND 只有一处定义；9 个 Tool 在表内，画像/检索不在表内', () => {
  const table = stringLiteralRecord(readSource(toolKindsFile), 'TOOL_TO_KIND', toolKindsFile)

  assert.deepEqual(
    table,
    {
      generate_animation: 'animation',
      compose_animation: 'animation',
      get_code_template: 'coding',
      get_coding_hint: 'coding',
      evaluate_code: 'coding',
      generate_code_exercise: 'coding',
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
