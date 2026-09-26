/**
 * 设计 token 守卫：优化报告 §1.2（间距系统标准化）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 报告的判据是**两条**：
 *   ① 所有间距都是 8 点网格上的值：4 / 8 / 12 / 16 / 24 / 32 / 40 / 48（4 只留给图标与标签内边距）；
 *   ② 「层级切换」的语义间距收口到四个 token：`gap 16` · `block 24` · `section 40` · `msg 32`。
 *
 * 为什么必须机器守：20px 与 36px 曾经是**跨页面的隐式标准**（改版前实测 9 处 padding/margin/gap
 * 用它），而它们不在 8 点网格上 —— 手写一个 `padding: 20px` 不会让任何构建失败，
 * 只会让"卡片、块、消息"三档节奏慢慢糊在一起。
 *
 * ⚠️ 允许清单（写清楚，避免假红）：
 *   · `base.css` 的 token 定义行（`--k12-sp-*` / `--k12-gap-*`，它们**定义**这些值）；
 *   · `width/height/min-height` 这类**尺寸**属性（图标块 36×36 不是间距）；
 *   · 注释里的说明文字（讲历史、讲为什么）。
 *
 * 跑法：`npm test`。真机节奏由 `scripts/ux-audit.mjs` / `ux-probe-scroll-behavior.mjs` 量。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = 'src/renderer/src'
const BASE_CSS = `${RENDERER}/assets/base.css`
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

/** 渲染进程里全部 .vue / .ts / .css 源码（相对路径 + 原文）。 */
function rendererSources(): Array<{ path: string; text: string }> {
  return readdirSync(join(desktopRoot, RENDERER), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(vue|ts|css)$/.test(entry.name))
    .map((entry) => {
      const parent =
        (entry as unknown as { parentPath?: string }).parentPath ??
        (entry as unknown as { path?: string }).path ??
        RENDERER
      const full = join(parent, entry.name)
      const relative = full
        .replace(/\\/g, '/')
        .replace(`${desktopRoot.replace(/\\/g, '/')}/`, '')
      return { path: relative, text: readFileSync(full, 'utf8') }
    })
}

function tokenValue(css: string, name: string): string {
  const matched = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)
  assert.ok(matched !== null, `base.css 的 :root 里找不到 --${name}`)
  return (matched[1] ?? '').trim()
}

function pxOf(value: string): number {
  const matched = /([0-9.]+)px/.exec(value)
  assert.ok(matched !== null, `token 不是 px 字面值：${value}`)
  return Number(matched[1])
}

/* ------------------------------------------------------------------ *
 * 1. 基础间距阶梯 = 8 点网格
 * ------------------------------------------------------------------ */

test('★★ 间距阶梯严格是 4/8/12/16/24/32/40/48（8 点网格）', () => {
  const css = read(...BASE_CSS.split('/'))
  const ladder: ReadonlyArray<readonly [string, number]> = [
    ['k12-sp-1', 4],
    ['k12-sp-2', 8],
    ['k12-sp-3', 12],
    ['k12-sp-4', 16],
    ['k12-sp-5', 24],
    ['k12-sp-6', 32],
    ['k12-sp-7', 40],
    ['k12-sp-8', 48]
  ]
  for (const [name, expected] of ladder) {
    assert.equal(
      pxOf(tokenValue(css, name)),
      expected,
      `--${name} 必须是 ${expected}px（优化报告 §1.2 的 8 点网格；20px 不再是间距档）`
    )
  }
})

/* ------------------------------------------------------------------ *
 * 2. 四档语义间距
 * ------------------------------------------------------------------ */

test('★★ 语义间距只有四档：gap 16 / block 24 / section 40 / msg 32', () => {
  const css = read(...BASE_CSS.split('/'))
  const gaps: ReadonlyArray<readonly [string, number]> = [
    ['k12-gap', 16],
    ['k12-gap-block', 24],
    ['k12-gap-section', 40],
    ['k12-gap-msg', 32]
  ]
  for (const [name, expected] of gaps) {
    assert.equal(pxOf(tokenValue(css, name)), expected, `--${name} 必须是 ${expected}px（报告 §1.2 的语义间距表）`)
  }
})

/* ------------------------------------------------------------------ *
 * 3. 页面里不许把 20 / 36 当间距写死
 * ------------------------------------------------------------------ */

test('★★ 全站不得把 20px / 36px 当间距写死（必须是 token）', () => {
  const offenders: string[] = []
  const spacingProperty = /(?:^|[;\s{])(padding|margin|gap|row-gap|column-gap)\s*:\s*[^;]*?\b(?:20|36)px/
  for (const file of rendererSources()) {
    if (file.path.endsWith('assets/tokens.generated.css')) continue
    const lines = file.text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const trimmed = line.trim()
      // 允许清单：token 定义行、注释行（讲历史/讲理由）、以及 CSS 变量声明
      if (trimmed.startsWith('--') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) continue
      if (spacingProperty.test(line)) offenders.push(`${file.path}:${index + 1}  ${trimmed}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些地方把 20px / 36px 当间距写死了（应改用 --k12-sp-* 或 --k12-gap-*）：\n' +
      offenders.slice(0, 12).join('\n')
  )
})
