/**
 * 响应式断点守卫：优化报告 §2.2。
 *
 * 报告的判据：新增 `bp-md 1024` 与 `bp-2xl 1920`、补高度断点 768/900、
 * 最小宽度 1120 → 1024（1024–1119 走紧凑布局而不是横向滚动）、
 * 且 1024–1279 这一档**保留完整侧栏**（原来 <1280 就把侧栏收成图标条，
 * 于是"平板/小笔记本"这一档被当成手机处理）。
 *
 * ⚠️ CSS 媒体查询不能用 `var()`，所以断点 token 是**文档 + JS 的单一真相**；
 *    本守卫同时钉"token 存在"与"实际媒体查询落在正确档位"。
 *
 * 跑法：`npm test`；真机四视口由 `scripts/ux-layout-audit.mjs` 量。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')
const R = 'src/renderer/src'
const css = read(...`${R}/assets/base.css`.split('/'))

test('断点 token：6 档宽度 + 3 档高度（报告 §2.2）', () => {
  const widths: ReadonlyArray<readonly [string, string]> = [
    ['k12-bp-xs', '0px'],
    ['k12-bp-sm', '640px'],
    ['k12-bp-md', '1024px'],
    ['k12-bp-lg', '1280px'],
    ['k12-bp-xl', '1440px'],
    ['k12-bp-2xl', '1920px']
  ]
  for (const [name, expected] of widths) {
    const matched = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)
    assert.ok(matched !== null, `base.css 缺少断点 token --${name}`)
    assert.equal((matched[1] ?? '').trim(), expected, `--${name} 必须是 ${expected}`)
  }
  for (const name of ['k12-bp-h-sm', 'k12-bp-h-md', 'k12-bp-h-lg']) {
    assert.match(css, new RegExp(`--${name}:\\s*\\d+px;`), `base.css 缺少高度断点 --${name}`)
  }
})

test('最小宽度降到 1024px；1024–1279 不再被当成窄屏', () => {
  assert.match(css, /min-width:\s*1024px/, '#app 的最小宽度必须是 1024px（报告 §2.2）')
  assert.doesNotMatch(css, /min-width:\s*1120px/, '旧的 1120px 下限必须删掉')

  // 侧栏/右栏等的窄屏收拢档必须是 1023（即 <1024），不是 1279
  const offenders: string[] = []
  for (const file of ['components/AppSidebar.vue', 'views/Chat.vue', 'components/ContextRail.vue', 'components/SessionList.vue']) {
    const source = read(...`${R}/${file}`.split('/'))
    for (const matched of source.matchAll(/max-width:\s*1279px/g)) offenders.push(`${file}: ${matched[0]}`)
  }
  assert.deepEqual(offenders, [], '1024–1279 档必须保留完整布局（收拢发生在 1023px 及以下）：\n' + offenders.join('\n'))
})

test('聊天气泡网格是 4 / 3 / 2 三档（1440 基准 / 1024 档 / 更窄）', () => {
  const chat = read(...`${R}/views/Chat.vue`.split('/'))
  assert.match(chat, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/, '1440 基准是 4 列')
  assert.match(
    chat,
    /@media \(max-width: 1439px\)\s*\{[\s\S]{0,160}?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
    '1024–1439 档必须是 3 列（报告 §2.2 新增）'
  )
  assert.match(
    chat,
    /@media \(max-width: 1023px\)\s*\{[\s\S]{0,160}?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    '更窄档才是 2 列'
  )
})

test('真机版式体检覆盖 1024 档（四视口）', () => {
  const probe = read('scripts', 'ux-layout-audit.mjs')
  assert.match(probe, /\[1024,\s*\d+\]/, 'ux-layout-audit 的视口表里必须有 1024（报告 §2.2 的测试计划）')
  assert.match(probe, /\[1280,\s*\d+\]/, '1280 档保留')
  assert.match(probe, /\[1440,\s*\d+\]/, '1440 档保留')
})
