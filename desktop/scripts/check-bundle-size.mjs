#!/usr/bin/env node
/**
 * 打包体积体检（D-068）—— **拆开 asar 数一数里面到底装了什么**。
 *
 * 为什么需要它（而不是只靠 `tests/bundle-budget.test.ts`）：源码级守卫管的是
 * 「package.json 与配置写对没有」，但**真正决定安装包大小的是 asar 里的字节**。
 * 两者之间隔着一整套 electron-builder 的依赖收集逻辑 —— 实测就是它把
 * 「npm 装下来的所有平台原生包」「vite 已经打进 out/renderer 的渲染依赖」
 * 「上一轮构建残留的旧 chunk」一起收了进来。只有把 asar 拆开数，才看得见这些。
 *
 * 判据（**动态算，不维护第二份包清单**——避免两处真相漂移）：
 *   从 `package.json` 的 `dependencies` 出发，按 Node 的解析规则求**生产依赖闭包**
 *   （electron-builder 打包的就是这个闭包）。asar 里出现的、**不在闭包里**的顶层包
 *   就是「不该进包的东西」——它们要么是被误加到 dependencies 的渲染依赖，
 *   要么是 devDependencies 的残留。
 *
 * 跑法（在 desktop/ 下）：
 *   npm run check:bundle            # 需先 npm run build:unpack
 *   node scripts/check-bundle-size.mjs --json
 *
 * 退出码：0 = 干净；1 = 有意外进包的依赖（并列出它们与体积）；2 = 产物不存在。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')
const asarPath = resolve(desktopRoot, 'dist', 'win-unpacked', 'resources', 'app.asar')

if (!existsSync(asarPath)) {
  console.error(`✗ 找不到 ${asarPath.replace(desktopRoot, 'desktop')}`)
  console.error('  先跑一次打包：npm run build:unpack')
  process.exit(2)
}

// ─────────────────────────────────────────────────────────────
// 1. 从 package.json 求**生产依赖闭包**（= electron-builder 实际打包的那一组）
//    解析规则与 Node 一致：从包所在目录向上找 node_modules/<name>。
// ─────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'))
const nodeModules = join(desktopRoot, 'node_modules')

function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function declaredDependencies(packageDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {})
    ]
  } catch {
    return []
  }
}

function productionClosure(rootNames) {
  const queue = []
  for (const name of rootNames) {
    const dir = resolvePackageDir(name, desktopRoot)
    if (dir) queue.push([name, dir])
  }
  const closure = new Set()
  while (queue.length > 0) {
    const [name, dir] = queue.pop()
    if (closure.has(name)) continue
    closure.add(name)
    for (const child of declaredDependencies(dir)) {
      if (closure.has(child)) continue
      const childDir = resolvePackageDir(child, dir)
      if (childDir) queue.push([child, childDir])
    }
  }
  return closure
}

const closure = productionClosure(Object.keys(pkg.dependencies ?? {}))
// 脚本自身依赖的「框架级」包（不在 npm 依赖里，但运行期确实要）：
const FRAMEWORK = ['electron'] // 由 electron-builder 从 Electron 发行版提供，不在闭包里
for (const name of FRAMEWORK) closure.add(name)

// ─────────────────────────────────────────────────────────────
// 2. 拆 asar 头，按「顶层包 / 顶层目录」汇总字节
//    asar 格式：4B(=4) | 4B headerPickle | 4B jsonLen | JSON header
//    header.files 是嵌套结构；`unpacked: true` 的文件内容在 app.asar.unpacked 里，
//    但它**仍然占磁盘**（所以照样计入）。
// ─────────────────────────────────────────────────────────────
const asar = readFileSync(asarPath)
const jsonLength = asar.readUInt32LE(12)
const header = JSON.parse(asar.subarray(16, 16 + jsonLength).toString('utf8'))

const byPackage = new Map()
const byTopDir = new Map()
let fileCount = 0
let logicalBytes = 0

function walk(node, path) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = path ? `${path}/${name}` : name
    if (value.files) {
      walk(value, full)
      continue
    }
    if (value.size === undefined) continue
    fileCount++
    logicalBytes += value.size
    const parts = full.split('/')
    if (parts[0] === 'node_modules') {
      const pkgName = parts[1].startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1]
      byPackage.set(pkgName, (byPackage.get(pkgName) ?? 0) + value.size)
    } else {
      const top = parts.slice(0, 2).join('/')
      byTopDir.set(top, (byTopDir.get(top) ?? 0) + value.size)
    }
  }
}
walk(header, '')

const mb = (bytes) => (bytes / 1048576).toFixed(2)
const sortedPackages = [...byPackage.entries()].sort((a, b) => b[1] - a[1])
const unexpected = sortedPackages.filter(([name]) => !closure.has(name))
const unexpectedBytes = unexpected.reduce((sum, [, size]) => sum + size, 0)

const unpackedDir = join(dirname(asarPath), 'app.asar.unpacked')
const unpackedBytes = existsSync(unpackedDir)
  ? readdirSync(unpackedDir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile())
      .reduce((sum, e) => {
        const parent = e.parentPath ?? e.path ?? unpackedDir
        try {
          return sum + statSync(join(parent, e.name)).size
        } catch {
          return sum
        }
      }, 0)
  : 0

// ── Python sidecar 产物（server/dist）：那几个「运行期用不到」的大文件不该在里面 ──
//    判据来自 D-068 ⑤。**这一项只能在产物上看**：源码态的单测压根不经过 PyInstaller，
//    而排除错了的代价是运行期 /api/rag/search 降级（甚至 [FATAL] 找不到模块）。
//    放在 --json 分支**之前**，两种输出才都能反映它。
const sidecarInternal = resolve(desktopRoot, '..', 'server', 'dist', 'k12-agent-server', '_internal')
// 用前缀匹配而不是写死文件名：PIL 的扩展模块名带 Python 版本标签（cp312 → cp313 会漂）。
const FORBIDDEN_SIDECAR = [
  {
    label: 'hf_xet/',
    list: () => (existsSync(join(sidecarInternal, 'hf_xet')) ? ['hf_xet'] : []),
    why: 'HuggingFace 下载加速器（模型随包分发，运行期不下载）'
  },
  {
    label: 'PIL/_avif.*',
    list: () => {
      const pilDir = join(sidecarInternal, 'PIL')
      return existsSync(pilDir) ? readdirSync(pilDir).filter((f) => f.startsWith('_avif')).map((f) => `PIL/${f}`) : []
    },
    why: 'AVIF 图片 codec（本项目只做文本嵌入，从不碰图像模型）'
  }
]
const sidecarChecked = existsSync(sidecarInternal)
const sidecarFound = sidecarChecked
  ? FORBIDDEN_SIDECAR.flatMap(({ list }) => list().map((rel) => ({ rel, bytes: statSync(join(sidecarInternal, rel)).size })))
  : []

if (asJson) {
  console.log(
    JSON.stringify(
      {
        asar: { path: asarPath, bytes: statSync(asarPath).size, fileCount, logicalBytes },
        unpackedBytes,
        topDirectories: Object.fromEntries([...byTopDir.entries()].sort((a, b) => b[1] - a[1])),
        topPackages: Object.fromEntries(sortedPackages.slice(0, 25)),
        unexpected: Object.fromEntries(unexpected),
        productionClosureSize: closure.size,
        sidecar: sidecarChecked
          ? { checked: true, leaked: Object.fromEntries(sidecarFound.map((f) => [f.rel, f.bytes])) }
          : { checked: false }
      },
      null,
      2
    )
  )
  process.exit(unexpected.length > 0 || sidecarFound.length > 0 ? 1 : 0)
}

console.log('══ 打包体积体检（asar 拆解）══')
console.log(`asar 文件： ${mb(statSync(asarPath).size)} MB（${fileCount} 个文件）`)
console.log(`asar 解包： ${mb(unpackedBytes)} MB（app.asar.unpacked，原生模块与 asarUnpack 的资源）`)
console.log(`合计：     ${mb(statSync(asarPath).size + unpackedBytes)} MB\n`)

console.log('── 顶层目录 ──')
for (const [dir, size] of [...byTopDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${mb(size).padStart(8)} MB  ${dir}`)
}

console.log('\n── node_modules 体积 Top 12（生产依赖，应全部是 Pi 的依赖树）──')
for (const [name, size] of sortedPackages.slice(0, 12)) {
  const inClosure = closure.has(name) ? '  ' : '⚠ '
  console.log(`  ${inClosure}${mb(size).padStart(8)} MB  ${name}`)
}

const localesDir = join(desktopRoot, 'dist', 'win-unpacked', 'locales')
if (existsSync(localesDir)) {
  const paks = readdirSync(localesDir)
  const localeBytes = paks.reduce((sum, f) => {
    try {
      return sum + statSync(join(localesDir, f)).size
    } catch {
      return sum
    }
  }, 0)
  console.log(`\n── Electron 语言包 ──\n  ${mb(localeBytes).padStart(8)} MB  locales/ （${paks.length} 个：${paks.join(', ')}）`)
  if (paks.length > 6) {
    console.log('  ⚠ 语言包多于 6 个 —— electronLanguages 是不是被去掉了？')
  }
}

// ── Python sidecar 产物的报告（检查本身在文件上部，--json 分支之前）──
if (sidecarChecked) {
  console.log('\n── Python sidecar 产物 ──')
  for (const { label, list, why } of FORBIDDEN_SIDECAR) {
    const found = list()
    if (found.length === 0) {
      console.log(`  ✓ 已排除  ${label}`)
      continue
    }
    for (const rel of found) {
      const bytes = sidecarFound.find((f) => f.rel === rel)?.bytes ?? 0
      console.log(`  ⚠ ${mb(bytes).padStart(8)} MB  ${rel} —— 不该在这里：${why}`)
    }
  }
} else {
  console.log('\n── Python sidecar 产物 ──')
  console.log('  （跳过：还没打过 server —— 跑 `cd ../server && uv run python scripts/build_server.py`）')
}

console.log('\n── 结论 ──')
console.log(`  生产依赖闭包：${closure.size} 个包`)
if (sidecarFound.length > 0) {
  console.log(
    `  ✗ sidecar 产物里有 ${sidecarFound.length} 个不该带的文件（见上）——\n` +
      '  检查 server/packaging/k12-agent-server.spec 的 excludes（D-068 ⑤）。'
  )
}
if (unexpected.length > 0) {
  console.log(`  ✗ 有 ${unexpected.length} 个「不该进包」的包，合计 ${mb(unexpectedBytes)} MB：`)
  for (const [name, size] of unexpected) console.log(`      ${mb(size).padStart(8)} MB  ${name}`)
  console.log(
    '\n  这些包不在 dependencies 的传递闭包里 —— 多半是渲染进程的依赖被放回了\n' +
      '  dependencies，或 devDependencies 的包被 hoist 到了顶层。\n' +
      '  判据与修法见 AGENTS.md 的「安装包体积」一节，守卫是 tests/bundle-budget.test.ts。'
  )
}
if (unexpected.length === 0 && sidecarFound.length === 0) {
  console.log('  ✓ asar 里没有任何「不该进包」的包（每个都在生产依赖闭包里），sidecar 也没多带文件')
}
process.exit(unexpected.length > 0 || sidecarFound.length > 0 ? 1 : 0)
