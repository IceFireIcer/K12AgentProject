/**
 * 设计 token 守卫：优化报告 §1.1（字体系统重构）+ §2.1（视觉层次重构）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 报告把字号从「8 档、17px 是异类」重构成**语义化 9 档**：
 *   hero 40 / h1 32 / h2 24 / h3 20 / body-lg 18 / body 16 / body-sm 14 / caption 13 / label 12
 * 并规定三条层次关系（顶栏 < 身份行、正文 > meta、label 只给 ≤4 字角标）。
 *
 * 这些约束**只能靠机器守**：字号是全站最高频的取值，任何一处手改都不会让构建失败，
 * 只会让层次悄悄塌掉（历史上 11px 曾是全站最高频字号，meta 与角标同权）。
 *
 * ★ 旧名（micro/xs/sm/md/lg/title/xl/2xl）保留为**别名**一版：迁移期间的兼容层，
 *   新代码不许再用；本守卫**禁用旧名用法**但不禁止别名定义（别名下一轮删除）。
 *
 * 跑法：`npm test`（源码级断言）。真机字号由 `scripts/ux-audit.mjs` 量（正文 ≥16px / 行高 ≥1.6）。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = 'src/renderer/src'
const BASE_CSS = `${RENDERER}/assets/base.css`
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return m?.[1] ?? ''
}

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
      return { path: full.replace(/\\/g, '/').replace(`${desktopRoot.replace(/\\/g, '/')}/`, ''), text: readFileSync(full, 'utf8') }
    })
}

/** 从 base.css 的 `:root` 读一个 token 的字面值（读不到就抛）。 */
function tokenValue(css: string, name: string): string {
  const matched = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)
  assert.ok(matched !== null, `base.css 的 :root 里找不到 --${name}`)
  return (matched[1] ?? '').trim()
}

/** 把一个 `NNpx` 值解析成数字。 */
function pxOf(value: string): number {
  const matched = /([0-9.]+)px/.exec(value)
  assert.ok(matched !== null, `token 不是 px 字面值：${value}`)
  return Number(matched[1])
}

/* ------------------------------------------------------------------ *
 * 1. 九档阶梯：取值精确等于报告 §1.1
 * ------------------------------------------------------------------ */

test('★★ 字号阶梯是报告 §1.1 的语义 9 档（取值逐项相等）', () => {
  const css = read(...BASE_CSS.split('/'))
  const ladder: ReadonlyArray<readonly [string, number]> = [
    ['k12-fs-hero', 40],
    ['k12-fs-h1', 32],
    ['k12-fs-h2', 24],
    ['k12-fs-h3', 20],
    ['k12-fs-body-lg', 18],
    ['k12-fs-body', 16],
    ['k12-fs-body-sm', 14],
    ['k12-fs-caption', 13],
    ['k12-fs-label', 12]
  ]
  for (const [name, expected] of ladder) {
    assert.equal(
      pxOf(tokenValue(css, name)),
      expected,
      `--${name} 必须是 ${expected}px（优化报告 §1.1 的语义阶梯；改它等于改需求）`
    )
  }
})

test('★ 三条层次关系成立（顶栏 < 身份行，正文 > meta，h3<h2<h1<hero）', () => {
  const css = read(...BASE_CSS.split('/'))
  const hero = pxOf(tokenValue(css, 'k12-fs-hero'))
  const h1 = pxOf(tokenValue(css, 'k12-fs-h1'))
  const h2 = pxOf(tokenValue(css, 'k12-fs-h2'))
  const h3 = pxOf(tokenValue(css, 'k12-fs-h3'))
  const bodyLg = pxOf(tokenValue(css, 'k12-fs-body-lg'))
  const body = pxOf(tokenValue(css, 'k12-fs-body'))
  const caption = pxOf(tokenValue(css, 'k12-fs-caption'))
  const label = pxOf(tokenValue(css, 'k12-fs-label'))

  assert.ok(bodyLg < h1, `顶栏页面名(${bodyLg}) 必须严格小于身份行(${h1})`)
  assert.ok(body > caption, `正文(${body}) 必须大于 caption(${caption})`)
  assert.ok(body > label, `正文(${body}) 必须大于 label(${label})`)
  assert.ok(h3 < h2 && h2 < h1 && h1 < hero, `标题档必须是 h3(${h3}) < h2(${h2}) < h1(${h1}) < hero(${hero})`)
})

/* ------------------------------------------------------------------ *
 * 2. 旧名：只许留在别名定义里，不许再被使用
 * ------------------------------------------------------------------ */

test('★★ 旧字号名只许作为别名保留，全站不得再出现 `var(--k12-fs-<旧名>)`', () => {
  const css = read(...BASE_CSS.split('/'))
  const aliases: ReadonlyArray<readonly [string, string]> = [
    ['k12-fs-micro', 'k12-fs-label'],
    ['k12-fs-xs', 'k12-fs-caption'],
    ['k12-fs-sm', 'k12-fs-body-sm'],
    ['k12-fs-md', 'k12-fs-body'],
    ['k12-fs-lg', 'k12-fs-body-lg'],
    ['k12-fs-title', 'k12-fs-body-lg'],
    ['k12-fs-xl', 'k12-fs-h2'],
    ['k12-fs-2xl', 'k12-fs-hero']
  ]
  for (const [legacy, target] of aliases) {
    assert.equal(
      tokenValue(css, legacy),
      `var(--${target})`,
      `--${legacy} 必须是指向 --${target} 的别名（迁移期兼容层，下一轮删除）`
    )
  }

  const used: string[] = []
  for (const file of rendererSources()) {
    for (const matched of file.text.matchAll(/var\(--k12-fs-(micro|xs|sm|md|lg|title|xl|2xl)\)/g)) {
      used.push(`${file.path}: ${matched[0]}`)
    }
  }
  assert.deepEqual(
    used,
    [],
    '旧字号名还有使用点（应统一改成 hero/h1/h2/h3/body-lg/body/body-sm/caption/label）：\n' + used.slice(0, 12).join('\n')
  )
})

/* ------------------------------------------------------------------ *
 * 3. 页面里不许写死 px 字号
 * ------------------------------------------------------------------ */

test('★★ 写死 px 字号 = 0 处（字号只能走 token）', () => {
  const offenders: string[] = []
  for (const file of rendererSources()) {
    if (file.path.endsWith('assets/tokens.generated.css')) continue // 生成物：只有色值/圆角，不含字号
    for (const matched of file.text.matchAll(/font-size:\s*[0-9.]+px/g)) {
      offenders.push(`${file.path}: ${matched[0]}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些地方把字号写死了（必须换成 --k12-fs-* token）：\n' + offenders.slice(0, 12).join('\n')
  )
})

/* ------------------------------------------------------------------ *
 * 4. 四处层次落点（报告 §2.1 的 Chrome / Hero / Section / Content）
 * ------------------------------------------------------------------ */

test('★★ 四处层次落点正确：顶栏 body-lg+fg-2+强边 / 身份行 h1 / 卡头 h3 / 空态 hero', () => {
  const css = read(...BASE_CSS.split('/'))
  const topbar = read(RENDERER, 'components', 'AppTopbar.vue')

  // Chrome 层：顶栏页面名 18px + 次级色 + 与内容的分隔用强边框
  assert.match(topbar, /\.tb__title\s*\{[\s\S]{0,400}?font-size:\s*var\(--k12-fs-body-lg\)/, '顶栏页面名必须是 body-lg（18px）')
  assert.match(topbar, /\.tb__title\s*\{[\s\S]{0,600}?color:\s*var\(--k12-fg-2\)/, '顶栏页面名必须用 fg-2（次级层级，报告 §2.1）')
  // ★★ 2026-10-02 改落点：那条强边线从顶栏组件挪到了**外壳那一行**
  //   （`layouts/AppShell.vue` 的 `.shell__head`）。原因：顶栏与右侧窗控区是
  //   **同一条 chrome**，两边各画一条会在 x 边界处错开 1px（用户截图点名的竖缝）。
  //   判据（"chrome 与内容之间有一条强线"）一个字没松，只是唯一来源换了一处。
  const shell = read(RENDERER, 'layouts', 'AppShell.vue')
  const head = ruleBody(shell, '.shell__head')
  assert.match(
    head,
    /border-bottom:\s*1px\s+solid\s+var\(--k12-border-strong\)/,
    '外壳那一行（顶栏 + 窗控，同一条 chrome）必须有强边框与内容分隔'
  )
  assert.doesNotMatch(
    topbar,
    /border-bottom:\s*1px/,
    '顶栏组件自己不许再画一条下边线：与外壳那条会各画各的，在 x 边界错开'
  )

  // Hero 层：页面身份行 32px
  assert.match(
    css,
    /\.k12-identity__main\s*\{[\s\S]{0,200}?font-size:\s*var\(--k12-fs-h1\)/,
    '页面身份行必须是 h1（32px，全页最大视觉焦点）'
  )

  // Section 层：卡头 20px
  assert.match(
    css,
    /\.k12-card-head\s*\{[\s\S]{0,400}?font-size:\s*var\(--k12-fs-h3\)/,
    '卡片/区块标题档必须是 h3（20px）'
  )

  // 对话页空态：hero 40px（它承担"首屏唯一 hero"的角色）
  const chat = read(RENDERER, 'views', 'Chat.vue')
  assert.match(chat, /font-size:\s*var\(--k12-fs-hero\)/, '对话页空态问候必须是 hero（40px）')
})
