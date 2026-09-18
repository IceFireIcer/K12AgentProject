#!/usr/bin/env node
/**
 * 死按钮审计：找出没有任何行为、也没有明确禁用的 <button>。
 *
 * 用**平衡扫描**而不是正则解析标签：属性值里可能出现 `>`（比如
 * `:key="e.from + '>'"`）与各种引号，正则会被截断，产生假阳性。
 *
 * 判据：标签内既没有 `@click`（或其他 `@事件`），也没有 `disabled`。
 * 有 `disabled` 就算合格 —— 明确禁用是有意的表达（配合 title 说明原因）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src'
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.vue') ? [p] : []
  })

/** 从 `<button` 起，扫到这个标签真正结束的 `>`（跳过引号与 {} 内部） */
function readTag(src, start) {
  let i = start + 7
  let quote = null
  let depth = 0
  for (; i < src.length; i += 1) {
    const c = src[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    else if (c === '>' && depth === 0) break
  }
  return { tag: src.slice(start, i), end: i }
}

/**
 * 去掉 CSS 注释后再扫。
 * 否则注释里写的 `<button>`（比如"引用行是 <button>，所以要清默认样式"）
 * 会被当成一个真按钮，报出假阳性 —— 实测踩到过。
 */
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

let bad = 0
let total = 0

for (const file of walk(ROOT)) {
  const s = stripCssComments(readFileSync(file, 'utf8'))
  let i = 0
  while ((i = s.indexOf('<button', i)) !== -1) {
    const { tag, end } = readTag(s, i)
    total += 1
    // `@click` 或任何 `@事件`，或明确 disabled
    const hasHandler = /@[a-zA-Z]/.test(tag)
    const hasDisabled = /\bdisabled\b/.test(tag)
    if (!hasHandler && !hasDisabled) {
      const line = s.slice(0, i).split('\n').length
      console.log(`  ✗ ${file}:${line}  ${tag.replace(/\s+/g, ' ').slice(0, 90)}`)
      bad += 1
    }
    i = end
  }
}

console.log(
  bad
    ? `\n共 ${total} 个按钮，其中 ${bad} 个既无行为也未禁用`
    : `✓ ${total} 个按钮全部有行为或明确禁用`
)
process.exit(bad ? 1 : 0)
