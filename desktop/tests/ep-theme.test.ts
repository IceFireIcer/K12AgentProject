/**
 * Element Plus 主题对齐守卫：优化报告 §4.1。
 *
 * 报告的判据是"EP 与 k12 系统同一套皮肤"：圆角（base 8 / small 6 / large 12）、
 * 字号（base 16 / small 14 / large 18）、颜色（primary→accent、success→good、
 * warning→warn、danger→bad、info→cyan）、边框与文字色全部映射到 k12 token，
 * 并保留 28px 触控下限。
 *
 * 为什么必须机器守：EP 的默认值（圆角 4px、字号 14px、颜色 #409EFF）**一直都在**，
 * 只要有人新引一个 EP 组件而没走 `var(--k12-*)` 映射，页面上就会冒出一块"另一个系统"的控件。
 *
 * 跑法：`npm test`。视觉一致性由 `ux:pages` + 人工走查覆盖。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CSS = 'src/renderer/src/assets/base.css'
const css = readFileSync(join(desktopRoot, ...CSS.split('/')), 'utf8')

/** 读一个 `--el-*` 变量的值。 */
function value(name: string): string {
  const matched = new RegExp(`${name}:\\s*([^;]+);`).exec(css)
  assert.ok(matched !== null, `base.css 里找不到 ${name}（EP 主题映射缺了这一条）`)
  return (matched[1] ?? '').trim()
}

test('EP 圆角三档映射到 k12：base 8 / small 6 / large 12', () => {
  assert.equal(value('--el-border-radius-base'), 'var(--k12-r-control)')
  assert.equal(value('--el-border-radius-small'), 'var(--k12-r-sm)', '小件（tag/chip 档）必须是 6px 档')
  assert.equal(value('--el-border-radius-large'), 'var(--k12-r-lg)', '大件（卡片档）必须是 12px 档')
  assert.equal(value('--el-border-radius-round'), 'var(--k12-r-pill)')
})

test('EP 字号三档映射到 k12 阶梯：16 / 14 / 18 / 20', () => {
  assert.equal(value('--el-font-size-base'), 'var(--k12-fs-body)')
  assert.equal(value('--el-font-size-small'), 'var(--k12-fs-body-sm)')
  assert.equal(value('--el-font-size-large'), 'var(--k12-fs-body-lg)')
  assert.equal(value('--el-font-size-extra-large'), 'var(--k12-fs-h3)')
})

test('EP 语义色与边框/文字色全部映射到 k12 token（不许出现 EP 默认色）', () => {
  assert.equal(value('--el-color-primary'), 'var(--k12-accent-ink)')
  assert.equal(value('--el-color-success'), 'var(--k12-good)')
  assert.match(value('--el-color-warning'), /var\(--k12-warn\)/, 'warning 必须映射到 k12 warn')
  assert.match(value('--el-color-danger'), /var\(--k12-bad\)/, 'danger 必须映射到 k12 bad')
  assert.match(value('--el-color-info'), /var\(--k12-cyan\)/, 'info 必须映射到 k12 cyan')

  assert.equal(value('--el-border-color'), 'var(--k12-border)')
  assert.equal(value('--el-text-color-primary'), 'var(--k12-fg)')
  assert.equal(value('--el-text-color-regular'), 'var(--k12-fg-2)')
  assert.equal(value('--el-text-color-secondary'), 'var(--k12-muted)')

  // EP 的默认蓝（#409EFF）与默认圆角/字号不许在 base.css 里出现
  assert.doesNotMatch(css, /#409EFF/i, 'EP 默认主色不许残留（必须走 k12 token）')
  assert.doesNotMatch(css, /--el-font-size-base:\s*14px/, 'EP 默认 base 14px 不许残留（k12 正文是 16px）')
})

test('EP 组件的触控下限与特殊组件适配都在（报告 §4.1 的收尾三条）', () => {
  assert.match(css, /\.el-button:not\(\.el-button--text\):not\(\.el-button--link\)/, '按钮要有 28px 触控下限')
  assert.match(css, /\.el-segmented__item[\s\S]{0,200}?min-height:\s*28px/, '分段控件要有 28px 下限')
  assert.match(css, /\.el-table \.cell\s*\{[\s\S]{0,120}?padding:\s*0 var\(--k12-sp-2\)/, '表格单元格内边距走 k12 间距')
  assert.match(css, /\.el-form-item\s*\{[\s\S]{0,120}?margin-bottom:\s*var\(--k12-sp-4\)/, '表单字段间距走 k12 间距')
  assert.match(css, /\.el-descriptions__cell\s*\{[\s\S]{0,120}?line-height:\s*var\(--k12-lh-ui\)/, '描述列表行高走 k12 行高')
})
