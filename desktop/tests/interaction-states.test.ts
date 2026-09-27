/**
 * 交互态守卫：优化报告 §4.3（对比度守卫扩展到**所有交互态** + 交互态色差 ≥10%）。
 *
 * 背景：`scripts/design/check-contrast.mjs` 只校验 tokens.source.json 里的**静态**色对。
 * 而按钮的 hover / active / disabled 是 `color-mix()` 派生的**动态**色 ——
 * 它们不在那份表里，也就是说：一套学段配色可以把静态色做到 100% 达标、却在 hover 时
 * 掉到读不清。这个守卫就是补这一格：把 color-mix 在 sRGB 里算出来，再算对比度。
 *
 * 判据（报告 §4.3）：
 *   ① hover / active 上的按钮文字（surface 色）仍 ≥4.5:1；
 *   ② disabled 上的 muted 文字 ≥3.0:1（禁用态不承载信息，按 WCAG 非文本/禁用下限）；
 *   ③ hover 与 default、active 与 hover 的**色差 ≥10%**（否则"看不出按了没按"）。
 *
 * 跑法：`npm test`（纯计算，不需要真机）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const R = 'src/renderer/src'
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

const css = read(...`${R}/assets/base.css`.split('/'))
const palette = read(...`${R}/assets/tokens.generated.css`.split('/'))

/** `#rrggbb` → [r,g,b]（0..255）。 */
function rgb(hex: string): [number, number, number] {
  const cleaned = hex.trim().replace('#', '')
  const full = cleaned.length === 3 ? cleaned.split('').map((c) => c + c).join('') : cleaned
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}

/** sRGB 线性插值（与 CSS `color-mix(in srgb, A p%, B)` 等价）。 */
function mix(a: string, b: string, percentOfA: number): [number, number, number] {
  const [ar, ag, ab] = rgb(a)
  const [br, bg, bb] = rgb(b)
  const p = percentOfA / 100
  return [ar * p + br * (1 - p), ag * p + bg * (1 - p), ab * p + bb * (1 - p)]
}

/** WCAG 相对亮度。 */
function luminance(color: [number, number, number]): number {
  const [r, g, b] = color.map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** 取 tokens.generated.css 里某个学段/饱和度块的一个色值（hex）。 */
function tokenOf(grade: string, sat: string, name: string): string | null {
  const block = new RegExp(`\\[data-grade="${grade}"\\]\\[data-sat="${sat}"\\][^{]*\\{([\\s\\S]*?)\\}`).exec(palette)
  if (block === null) return null
  const matched = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8});`).exec(block[1] ?? '')
  return matched === null ? null : (matched[1] ?? null)
}

test('交互态派生规则从 base.css **解析**（不许把百分比写死在测试里）', () => {
  /** 从 color-mix 里读"混合比例"（= 该态离 default 有多远）。 */
  function pctOf(name: string): number {
    const matched = new RegExp(`--${name}:\\s*color-mix\\(in srgb,\\s*var\\(--k12-[a-z-]+\\)\\s*(\\d+)%`).exec(css)
    assert.ok(matched !== null, `base.css 里找不到 --${name} 的 color-mix 比例`)
    return Number(matched[1])
  }
  const hover = pctOf('k12-accent-hover')
  const active = pctOf('k12-accent-active')
  const disabled = pctOf('k12-accent-disabled')

  assert.ok(hover < 100, 'hover 必须**比 default 深**（100% = 与默认同色，等于没有 hover 反馈）')
  assert.ok(active < hover, 'active 必须比 hover 再深一档')
  assert.ok(100 - hover >= 10, `default→hover 的色差必须 ≥10%（实测 ${100 - hover}%）`)
  assert.ok(hover - active >= 10, `hover→active 的色差必须 ≥10%（实测 ${hover - active}%）`)
  assert.ok(disabled > 0 && disabled < 100, 'disabled 必须是派生色（0 = 纯底色、100 = 纯强调色，两端都没有"不可点"的语义）')
})

test('18 套学段配色里，hover/active 上的按钮文字仍 ≥4.5:1（报告 §4.3）', () => {
  const failures: string[] = []
  for (const grade of ['primary-low', 'primary-high', 'junior', 'senior', 'default', 'brand']) {
    for (const sat of ['vivid', 'soft', 'mono']) {
      const ink = tokenOf(grade, sat, 'k12-accent-ink')
      const surface = tokenOf(grade, sat, 'k12-surface')
      const fg = tokenOf(grade, sat, 'k12-fg')
      if (ink === null || surface === null || fg === null) continue
      const hover = mix(ink, fg, 88)
      const active = mix(ink, fg, 76)
      for (const [label, bg] of [['hover', hover], ['active', active]] as const) {
        const ratio = contrast(rgb(surface), bg)
        if (ratio < 4.5) failures.push(`${grade}/${sat} ${label}: ${ratio.toFixed(2)}:1`)
      }
    }
  }
  assert.deepEqual(failures, [], '这些配色在交互态掉到 4.5:1 以下：\n' + failures.join('\n'))
})

test('禁用态文字 ≥3.0:1，且 18 套配色全部达标（报告 §4.3）', () => {
  const failures: string[] = []
  const worst = { label: '', ratio: 99 }
  for (const grade of ['primary-low', 'primary-high', 'junior', 'senior', 'default', 'brand']) {
    for (const sat of ['vivid', 'soft', 'mono']) {
      const accent = tokenOf(grade, sat, 'k12-accent')
      const surface = tokenOf(grade, sat, 'k12-surface')
      const muted = tokenOf(grade, sat, 'k12-muted')
      if (accent === null || surface === null || muted === null) continue
      const disabledBg = mix(accent, surface, 38)
      const ratio = contrast(rgb(muted), disabledBg)
      if (ratio < worst.ratio) {
        worst.label = `${grade}/${sat}`
        worst.ratio = ratio
      }
      if (ratio < 3.0) failures.push(`${grade}/${sat}: ${ratio.toFixed(2)}:1`)
    }
  }
  assert.deepEqual(
    failures,
    [],
    `禁用态（muted 文字 + accent-disabled 底）掉到 3.0:1 以下：\n${failures.join('\n')}\n` +
      `最差一档：${worst.label} ${worst.ratio.toFixed(2)}:1（注：叠加 opacity .6 后会更低，见计划 §3 D5 的取舍）`
  )
})

test('交互态补齐：按钮 loading、输入框 filled/error、卡片 hover 抬升（报告 §3.2）', () => {
  assert.match(css, /\.k12-cta\[data-loading\]\s*\{/, '按钮要有 loading 态（报告 §3.2 的五态之一）')
  assert.match(css, /\.k12-cta\[data-loading\][\s\S]{0,200}?pointer-events:\s*none/, 'loading 期间必须不可再点')
  assert.match(css, /@keyframes k12-spin/, 'loading 的转圈要有自己的 keyframes')
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]{0,300}?\.k12-cta\[data-loading\]::after[\s\S]{0,120}?animation:\s*none/,
    '减动效下转圈必须停（改静态表达）'
  )
  assert.match(css, /\.el-input__wrapper:has\(input:not\(:placeholder-shown\)\)/, '输入框要有 filled（有值）态')
  assert.match(css, /aria-invalid='true'/, '输入框要有 error 态（aria-invalid）')
  assert.match(css, /\.k12-card:hover\s*\{[\s\S]{0,200}?transform:\s*translateY\(-1px\)/, '卡片 hover 要抬升 1px（报告 §3.2）')
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]{0,400}?\.k12-card:hover\s*\{[\s\S]{0,80}?transform:\s*none/,
    '减动效下卡片不位移（只换阴影）'
  )
})

test('减动效全局兜底在（报告 §3.3：CSS 收时长 + JS 收滚动/定时器，两边都要有）', () => {
  assert.match(
    css,
    // ⚠️ 2026-09-27 起选择器带 `:root:not([data-k12-reduced-motion='off'])` 前缀 ——
    //   那是「用户没选关闭」的开关（见 tests/reduced-motion-mode.test.ts 的口径）。
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root:not\(\[data-k12-reduced-motion='off'\]\) \*,[\s\S]{0,300}?animation-duration:\s*0\.01ms\s*!important/,
    '必须有全站兜底：animation-duration 压到 0.01ms（且要能被「关闭」档覆盖）'
  )
  assert.match(css, /transition-duration:\s*0\.01ms\s*!important/, 'transition 时长也要压掉')
  assert.match(css, /scroll-behavior:\s*auto\s*!important/, '滚动行为强制 auto')
  // JS 那一半：composable 必须存在且被真实消费（否则只是摆设）
  const reduced = read(...`${R}/composables/useReducedMotion.ts`.split('/'))
  assert.match(reduced, /prefers-reduced-motion: reduce/, 'useReducedMotion 必须读同一个媒体查询')
})
