#!/usr/bin/env node
/**
 * 由 `scripts/design/tokens.source.json` 生成
 * `src/renderer/src/assets/tokens.generated.css`。
 *
 * 两轴模型：grade 轴 × sat 轴（6 × 3 = 18 组），落在两轴属性选择器上：
 *   :root[data-grade="junior"][data-sat="vivid"] { --k12-accent: #4338CA; ... }
 * 改一个轴不会重写另一个轴。
 *
 * 材质模型（「书桌与纸」，四层，见 base.css 文件头）：
 *   page      = 桌面：带学段色的页面底色（内容区/外壳底）
 *   surface   = 纸面：白卡片、对话回答卡、侧栏 / 顶栏 / 右栏等结构面
 *   surface-2 = 纸上的嵌入块（卡内块、hover 底、卡头卡脚）
 *   float     = 浮层：白面 + 最深边框 + 最强投影（模态 / 菜单 / 抽屉）
 *   accent    = 学段墨：链接 / 当前项 / 主按钮 / 进度
 *   accent-2  = 仅数据可视化用的第二色相（图表分段），不进 UI 骨架
 *
 * 2026-09-27（D-105）：**结构分面允许一条单侧投影**（侧栏右缘 / 顶栏下缘 /
 * 右栏左缘），用来表达「这块纸面浮在桌面上」。此前「纸与桌面都不用阴影」的
 * 口径导致的后果是：边框一浅，整块面就"飘"在空中没有边界。
 * 日常内容卡片仍然只用近景投影（`--k12-shadow-card`），不用深投影。
 *
 * 数值请改 scripts/design/tokens.source.json（那才是一处来源），不要在此脚本里硬编码颜色。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 本文件在 desktop/scripts/design/ 下：desktop 根 = 上两级
const desktopRoot = resolve(here, '..', '..')
const src = JSON.parse(readFileSync(resolve(here, 'tokens.source.json'), 'utf8'))

const { grades, sats, single, themed } = src
const DEFAULT_GRADE = 'default'
const DEFAULT_SAT = 'vivid'

/** CSS 自定义属性名统一加 k12- 前缀，避免与 Element Plus 的 --el-* 及其他库冲突 */
const cssName = (key) => `--k12-${key}`

const lines = []
lines.push('/* ==========================================================================')
lines.push(' * 本文件由 scripts/design/gen-tokens.mjs 自动生成，请勿手工编辑。')
lines.push(' * 源数据：scripts/design/tokens.source.json（本项目调色板，非画布直出）')
lines.push(' * 两轴主题：grade × sat，共 ' + grades.length * sats.length + ' 组')
lines.push(' * 对比度：npm run check:contrast -- --strict')
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
lines.push('/* 由主色派生的合成分级（组件统一引用这些，不要各自 color-mix）')
lines.push(' * 只放**随学段变色**的东西：两支聚焦环。')
lines.push(' * ⚠️ 投影不放这里 —— 它们定义在 base.css 的 `:root`（`--k12-shadow-*`）。')
lines.push(' *   同一份文件里两处定义过 `--k12-shadow-float`，base.css 后加载把它覆盖掉，')
lines.push(' *   于是「改 token 里的阴影」永远不生效（踩坑 P-157）。现已删掉重复定义。 */')
lines.push(':root {')
lines.push('  --k12-accent-ring: color-mix(in srgb, var(--k12-accent) 34%, transparent);')
lines.push('  --k12-accent-ring-soft: color-mix(in srgb, var(--k12-accent) 16%, transparent);')
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

const out = resolve(desktopRoot, 'src/renderer/src/assets/tokens.generated.css')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, lines.join('\n') + '\n', 'utf8')

const themedCount = Object.keys(themed).length
console.log(
  `✓ 生成 ${out}\n  grade × sat = ${grades.length} × ${sats.length} = ${matrix.length} 组\n` +
    `  非主题 token ${Object.keys(single).length} 个 · 主题 token ${themedCount} 个 · ` +
    `默认 ${DEFAULT_GRADE}/${DEFAULT_SAT}`
)
