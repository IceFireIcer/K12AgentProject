#!/usr/bin/env node
/**
 * 由 scripts/tokens.source.json 生成 src/styles/tokens.generated.css
 *
 * 画布模型：grade 轴 × sat 轴（6 × 3 = 18 组），落在两轴属性选择器上：
 *   :root[data-grade="junior"][data-sat="vivid"] { --accent: #4F46E5; ... }
 * 改一个轴不会重写另一个轴，与画布的 theme 轴一一对应。
 *
 * 数值来源是 Pencil 画布文档变量，请勿在此脚本里硬编码颜色。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const src = JSON.parse(readFileSync(resolve(here, 'tokens.source.json'), 'utf8'))

const { grades, sats, single, themed } = src
const DEFAULT_GRADE = 'default'
const DEFAULT_SAT = 'vivid'

/** CSS 自定义属性名统一加 k12- 前缀，避免与 Element Plus 的 --el-* 及其他库冲突 */
const cssName = (key) => `--k12-${key}`

const lines = []
lines.push('/* ==========================================================================')
lines.push(' * 本文件由 scripts/gen-tokens.mjs 自动生成，请勿手工编辑。')
lines.push(' * 源数据：scripts/tokens.source.json（导出自 Pencil 画布文档变量）')
lines.push(' * 两轴主题：grade × sat，共 ' + grades.length * sats.length + ' 组')
lines.push(' * ========================================================================== */')
lines.push('')

/** 1. 非主题化 token（所有 grade/sat 下取值相同） */
lines.push(':root {')
for (const [key, value] of Object.entries(single)) {
  lines.push(`  ${cssName(key)}: ${value};`)
}
lines.push('}')

/** 2. 主题化 token：为每个 grade/sat 组合生成一个块 */
const matrix = []
for (const grade of grades) {
  for (const sat of sats) {
    const idx = grades.indexOf(grade) * sats.length + sats.indexOf(sat)
    const decls = []
    for (const [key, values] of Object.entries(themed)) {
      const value = values[idx]
      if (value == null) {
        throw new Error(`缺失取值：${key} @ ${grade}/${sat}（索引 ${idx}）`)
      }
      decls.push(`  ${cssName(key)}: ${value};`)
    }
    matrix.push({ grade, sat, decls })
  }
}

const isDefault = (m) => m.grade === DEFAULT_GRADE && m.sat === DEFAULT_SAT

/** 默认组合同时写成裸 :root，使未设置 data 属性时也有完整取值 */
for (const m of matrix) {
  const selectors = isDefault(m)
    ? [':root', `:root[data-grade="${m.grade}"][data-sat="${m.sat}"]`]
    : [`:root[data-grade="${m.grade}"][data-sat="${m.sat}"]`]
  lines.push('')
  lines.push(`${selectors.join(',\n')} {`)
  lines.push(...m.decls)
  lines.push('}')
}

/** 3. 单轴回退：只设了 data-grade 或用只设了 data-sat 时，用默认值补齐另一轴 */
lines.push('')
lines.push('/* 单轴设定时的回退：未指定的轴按默认值补齐 */')
for (const grade of grades) {
  if (grade === DEFAULT_GRADE) continue
  const m = matrix.find((x) => x.grade === grade && x.sat === DEFAULT_SAT)
  lines.push(`:root[data-grade="${grade}"]:not([data-sat]) {`)
  lines.push(...m.decls)
  lines.push('}')
}
for (const sat of sats) {
  if (sat === DEFAULT_SAT) continue
  const m = matrix.find((x) => x.grade === DEFAULT_GRADE && x.sat === sat)
  lines.push(`:root[data-sat="${sat}"]:not([data-grade]) {`)
  lines.push(...m.decls)
  lines.push('}')
}

/** 4. 派生合成分级变量（由主色推导，避免在组件里重复写 color-mix） */
lines.push('')
lines.push('/* 由主色派生的玻璃拟态合成分级（组件统一引用这些，不要各自 color-mix） */')
lines.push(':root {')
lines.push('  --k12-accent-wash: color-mix(in srgb, var(--k12-accent) 6%, transparent);')
lines.push('  --k12-accent-wash-strong: color-mix(in srgb, var(--k12-accent) 12%, transparent);')
lines.push('  --k12-accent-ring: color-mix(in srgb, var(--k12-accent) 34%, transparent);')
lines.push('  --k12-accent-2-wash: color-mix(in srgb, var(--k12-accent-2) 8%, transparent);')
lines.push('  --k12-glass-blur: 22px;')
lines.push('  --k12-shadow-sm: 0 1px 2px rgba(27, 34, 51, 0.04);')
lines.push('  --k12-shadow-md: 0 6px 20px -10px rgba(27, 34, 51, 0.16);')
lines.push('  --k12-shadow-lg: 0 18px 50px -24px rgba(27, 34, 51, 0.24);')
lines.push('}')

/**
 * 5. 色板缩略（.k12-swatch）：
 * 配色总览页要**同时**展示 18 组配色，但页面自身只能处在一组主题下。
 * 因此把同一批变量再按 `[data-grade][data-sat]` 生成一份挂在 .k12-swatch 上，
 * 让每个格子自带主题作用域 —— 组件里因此不需要硬编码任何色值。
 */
lines.push('')
lines.push('/* 色板缩略：让单个元素自带某组主题（配色总览页用，组件内不硬编码色值） */')
for (const m of matrix) {
  lines.push(`.k12-swatch[data-grade="${m.grade}"][data-sat="${m.sat}"] {`)
  lines.push(...m.decls)
  lines.push('}')
}

const out = resolve(root, 'src/styles/tokens.generated.css')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, lines.join('\n') + '\n', 'utf8')

const themedCount = Object.keys(themed).length
console.log(
  `✓ 生成 ${out}\n  grade × sat = ${grades.length} × ${sats.length} = ${matrix.length} 组\n` +
    `  非主题 token ${Object.keys(single).length} 个 · 主题 token ${themedCount} 个 · ` +
    `默认 ${DEFAULT_GRADE}/${DEFAULT_SAT}`
)
