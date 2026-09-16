/**
 * 从 app.asar 里抽取一个文件的原始字节（不依赖 @electron/asar 的路径约定，
 * 直接按 asar 头部 JSON 的 offset 读取 —— 该产物在本机是 Windows 路径分隔符风格）。
 *
 * 用法：node scripts/asar-read.mjs <asar> <内部路径> [输出文件]
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [, , asarPath, innerPath, outPath] = process.argv
if (!asarPath || !innerPath) {
  console.error('用法：node scripts/asar-read.mjs <app.asar> <内部路径（用 / 分隔）> [输出文件]')
  process.exit(2)
}

const buffer = readFileSync(asarPath)
const start = buffer.indexOf('{"files":')
if (start < 0) {
  console.error('asar 头部格式不符')
  process.exit(1)
}

// 头部 JSON 的花括号配对（字符串内的括号要跳过）
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
const headerJson = buffer.toString('utf8', start, end + 1)
const header = JSON.parse(headerJson)

// 文件数据区起点：asar 结构为 [u32 pickleSize][u32 headerSize][u32 jsonSize][header...]
// 链接库实现里 datas 从 `8 + headerSize` 开始（pickleSize 字段本身占 4B，另 4B 是 headerSize）。
const dataStart = 8 + buffer.readUInt32LE(4)

/** 头部 JSON 里的键可能是反斜杠风格（Windows 产物）；两种都试。 */
function lookup(node, segments) {
  for (const [, entry] of Object.entries(node.files ?? {})) {
    void entry
  }
  const normalized = segments.join('/')
  const candidates = [normalized, segments.join('\\')]
  let cursor = header
  for (const segment of segments) {
    const files = cursor.files ?? {}
    const key = Object.keys(files).find(
      (name) => name === segment || name.replace(/\\/g, '/') === segment
    )
    if (!key) return { error: `在 ${Object.keys(files).slice(0, 5).join(', ')}… 里找不到 ${segment}` }
    cursor = files[key]
  }
  void candidates
  return { entry: cursor }
}

const segments = innerPath.split('/').filter(Boolean)
const result = lookup(header, segments)
if (result.error) {
  console.error(`找不到 ${innerPath}：${result.error}`)
  process.exit(1)
}
if (result.entry.files) {
  console.error(`${innerPath} 是目录，不是文件`)
  process.exit(1)
}
if (result.entry.unpacked === true) {
  console.error(`${innerPath} 标记为 unpacked=true —— 它的实体文件在 app.asar.unpacked/ 下，不在 asar 里`)
  process.exit(3)
}

const from = dataStart + Number(result.entry.offset)
const data = buffer.subarray(from, from + result.entry.size)
if (outPath) {
  writeFileSync(outPath, data)
  console.log(`已写出 ${outPath}（${data.length}B）`)
} else {
  process.stdout.write(data)
}
