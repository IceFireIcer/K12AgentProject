/**
 * 架构守卫（票 01）。
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
 *
 * 跑法：`npm test`。全部用 fs 读源码做静态断言，失败信息里带上具体文件路径。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = join(desktopRoot, 'src', 'renderer')
const mainDir = join(desktopRoot, 'src', 'main')
const sharedEventsFile = join(desktopRoot, 'src', 'shared', 'ipc-events.ts')
const bridgeClientFile = join(mainDir, 'bridge', 'client.ts')

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
const HTTP_CALL_PATTERN = /\bfetch\s*\(|XMLHttpRequest|EventSource/

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

  const offenders = files
    .filter((file) => resolve(file) !== resolve(bridgeClientFile))
    .filter((file) => FETCH_PATTERN.test(readSource(file)))
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
