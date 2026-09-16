/**
 * 关卡 B₁ 证据脚本：证明原生二进制**真的以实体文件解包**（而不是只躺在 app.asar 里）。
 *
 * 做法：解析 app.asar 的头部 JSON，检查关键原生文件的 `unpacked: true` 标志，
 * 并实测 `app.asar.unpacked/` 下同名实体文件的大小（与 asar 内记录的 size 对比）。
 *
 * 跑法：node scripts/verify-unpacked-asars.mjs [dist/win-unpacked/resources]
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const resourcesDir = resolve(process.argv[2] ?? 'dist/win-unpacked/resources')
const asarPath = join(resourcesDir, 'app.asar')
const unpackedRoot = join(resourcesDir, 'app.asar.unpacked')

if (!existsSync(asarPath)) {
  console.error(`找不到 app.asar：${asarPath}`)
  process.exit(1)
}

// app.asar 头部：pickle 长度 + header 长度 + json 长度 + json + padding。
// ★ 不依赖固定偏移（electron-builder 的 pickle 布局与文档描述有出入，按固定偏移取会
//   JSON.parse 失败并把整个头部字符串喷进 stdout）：直接定位 `{"files":` 再配对花括号。
const buffer = readFileSync(asarPath)
const start = buffer.indexOf('{"files":')
if (start < 0) {
  console.error('app.asar 头部里找不到 {"files":，asar 格式与预期不符')
  process.exit(1)
}
let depth = 0
let end = -1
let inString = false
let escaped = false
for (let i = start; i < buffer.length; i += 1) {
  const char = buffer[i]
  if (inString) {
    if (escaped) escaped = false
    else if (char === 0x5c) escaped = true
    else if (char === 0x22) inString = false
    continue
  }
  if (char === 0x22) inString = true
  else if (char === 0x7b) depth += 1
  else if (char === 0x7d) {
    depth -= 1
    if (depth === 0) {
      end = i
      break
    }
  }
}
if (end < 0) {
  console.error('app.asar 头部的 JSON 花括号未闭合')
  process.exit(1)
}
const header = JSON.parse(buffer.toString('utf8', start, end + 1))

const rows = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`
    if (entry.files) {
      walk(entry, path)
    } else {
      rows.push({ path, size: entry.size, unpacked: entry.unpacked === true })
    }
  }
}
walk(header, '')

const isNative = (p) => /esbuild\.exe$/i.test(p) || /\.node$/i.test(p)
const natives = rows.filter((row) => isNative(row.path))

console.log(`app.asar            : ${asarPath}`)
console.log(`asar 内文件条目总数 : ${rows.length}`)
console.log(`其中原生文件        : ${natives.length}`)
console.log('')
console.log('原生文件解包状态（unpacked=true 表示实体文件在 app.asar.unpacked/ 下）：')
console.log('')

let allUnpacked = true
for (const row of natives) {
  const real = join(unpackedRoot, row.path)
  const exists = existsSync(real)
  const realSize = exists ? statSync(real).size : 0
  const ok = row.unpacked && exists && realSize === row.size
  if (!ok) allUnpacked = false
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${row.unpacked ? 'unpacked' : 'IN-ASAR '}  ${row.path}`)
  console.log(
    `         asar 记录 size=${row.size}B  实体文件 size=${exists ? `${realSize}B` : '(不存在)'}  ${ok ? '一致 ✓' : '★ 不一致'}`
  )
}

console.log('')
const esbuildExe = natives.filter((row) => /esbuild\.exe$/i.test(row.path))
console.log(`esbuild 原生二进制数量：${esbuildExe.length}`)
for (const row of esbuildExe) {
  console.log(`  - ${join(unpackedRoot, row.path)}  ${row.size}B`)
}
console.log('')
console.log(allUnpacked ? '结论：全部原生文件均已实体解包 ✓' : '结论：存在未解包的原生文件 ✗')

process.exit(allUnpacked ? 0 : 1)
