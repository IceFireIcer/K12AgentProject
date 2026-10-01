/**
 * 视觉边界守卫（2026-09-27，D-105）。
 *
 * 为什么需要它：`scripts/design/check-contrast.mjs` 校验的是**单值 token 色对**
 * （墨 vs 底）。而"边界看不见"这个故障有另外两条成因，它一条都覆盖不到：
 *
 *   ① **层次塌陷**：底色差是边界的主信号 —— 但 18 组配色里任何一组都可能悄悄
 *      回到「白纸压在白桌面上」。旧版本就是这么坏的：`default` 档（**开机默认**）
 *      的 page 是 `#FFFFFF`，5 个学段的 `mono` 档 page 比嵌入块还亮。
 *      check-contrast 查不出这个，因为"page = 白"当时是**合法取值**（没超标）。
 *   ② **用法错位**：皮肤定义好了，但组件没用（旧版 `.k12-inset` 零消费者），
 *      或者内容区忘了铺桌面色 → 结构上就分不出层级。
 *
 * 判据（三条，全部机器可查）：
 *   A. 线：`border` 对白 ≥1.40、`border-strong` 对白 ≥2.00（18 组同值，查一次）
 *   B. 层次：18 组里 page / surface-2 对白各 ≥1.04（防塌陷 —— 这条是本次改造的
 *      真正主判据，也是「白底白线」复发的唯一拦路者）
 *   C. 用法：内容区必须铺桌面色、`.k12-inset` 必须有底色+细线、
 *      结构分面（侧栏 / 右栏）必须有强线或单侧投影
 *
 * ⚠️ 阈值取**实测下限**而不是 WCAG 的 3:1：本仓的边界靠"底色差 + 线 + 投影"
 *    三件套，线只是副信号；把线单独压到 3:1 会让浅色界面变线框风。
 *    完整口径见 `scripts/design/check-contrast.mjs` 顶部的注释。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const R = 'src/renderer/src'
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

const baseCss = read(...`${R}/assets/base.css`.split('/'))
const generated = read(...`${R}/assets/tokens.generated.css`.split('/'))

const GRADES = ['primary-low', 'primary-high', 'junior', 'senior', 'default', 'brand'] as const
const SATS = ['vivid', 'soft', 'mono'] as const

function rgb(hex: string): [number, number, number] {
  const c = hex.trim().replace('#', '')
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}
function luminance(color: [number, number, number]): number {
  const [r, g, b] = color.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const la = luminance(rgb(a))
  const lb = luminance(rgb(b))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}
/** 单值 token（`:root` 第一块）。`name` 与 source JSON 的 key 同名（自动补 k12- 前缀）。 */
function singleToken(name: string): string | null {
  const block = /^:root \{([\s\S]*?)\}/m.exec(generated)
  if (block === null) return null
  const m = new RegExp(`--k12-${name}:\\s*(#[0-9a-fA-F]{3,8});`).exec(block[1] ?? '')
  return m === null ? null : (m[1] ?? null)
}
/** 某一组配色的主题 token。 */
function themedToken(grade: string, sat: string, name: string): string | null {
  const block = new RegExp(`\\[data-grade="${grade}"\\]\\[data-sat="${sat}"\\][^{]*\\{([\\s\\S]*?)\\}`).exec(
    generated
  )
  if (block === null) return null
  const m = new RegExp(`--k12-${name}:\\s*(#[0-9a-fA-F]{3,8});`).exec(block[1] ?? '')
  return m === null ? null : (m[1] ?? null)
}

/** 取某个选择器的声明块内容。
 *
 * ★★ 两个坑都必须避开，否则守卫是"假绿"：
 *   ① 不能用 `选择器 {[\s\S]{0,300}?属性` 这种**窗口式**正则 —— 窗口会越过规则的
 *      `}` 撞到下一条规则的声明，于是"属性被删掉"这种变异仍然匹配得上
 *      （实测：`.k12-inset` 的细线被删后，窗口吃到了紧随其后的 `.k12-float`
 *      的细线，守卫照样绿）。
 *   ② 选择器必须**锚在行首** —— `.rail--closed .rail__panel {` 里含有
 *      `.rail__panel {` 这个子串，不锚行首就会取到那条 `display: none`
 *      （实测：右栏的线明明在，守卫却报"找不到"）。
 * 本仓反复踩过这两种形态，所以这里写死为"行首选择器 + 到本层 `}` 为止"。 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return m?.[1] ?? ''
}

/* ------------------------------------------------------------------ *
 * A. 线：可见性下限
 * ------------------------------------------------------------------ */

test('边框两支对白 ≥1.40 / ≥2.00（读得出「这里有一条边界」）', () => {
  const border = singleToken('border')
  const strong = singleToken('border-strong')
  assert.ok(border !== null, 'tokens.generated.css 里找不到 --k12-border')
  assert.ok(strong !== null, 'tokens.generated.css 里找不到 --k12-border-strong')

  // 旧值（#E6EAF2 1.21:1 / #D9DFEC 1.34:1）是本次要修的毛病：
  // 1px 宽 + 1.2:1 在实机上根本读不出边界。这条守住的正是"别再退回去"。
  const b = contrast(border, '#FFFFFF')
  const s = contrast(strong, '#FFFFFF')
  assert.ok(b >= 1.4, `--k12-border 对白只有 ${b.toFixed(2)}:1（要 ≥1.40，旧值 #E6EAF2 是 1.21）`)
  assert.ok(s >= 2.0, `--k12-border-strong 对白只有 ${s.toFixed(2)}:1（要 ≥2.00，旧值 #D9DFEC 是 1.34）`)
  assert.ok(
    contrast(strong, '#FFFFFF') > contrast(border, '#FFFFFF'),
    '强边框必须真的比普通边框强（两档合并等于没有分档）'
  )
})

/* ------------------------------------------------------------------ *
 * B. 层次：底色差不塌陷（本次改造的主判据）
 * ------------------------------------------------------------------ */

test('18 组配色：桌面与嵌入块都对白纸 ≥1.04（防「白底白线」复发）', () => {
  const failures: string[] = []
  for (const grade of GRADES) {
    for (const sat of SATS) {
      const page = themedToken(grade, sat, 'page')
      const s2 = themedToken(grade, sat, 'surface-2')
      if (page === null || s2 === null) {
        failures.push(`${grade}/${sat}: 取不到 page 或 surface-2`)
        continue
      }
      const pageRatio = contrast(page, '#FFFFFF')
      const s2Ratio = contrast(s2, '#FFFFFF')
      // 这两个下限的意义：白卡片（surface）压在 page 上、嵌入块压在纸面上，
      // 都是"两个面直接相邻"，色差低于 1.04 时肉眼读不出分界（旧 default 档 = 1.0000）。
      if (pageRatio < 1.04) failures.push(`${grade}/${sat} page ${page} 对白 ${pageRatio.toFixed(4)}:1`)
      if (s2Ratio < 1.04) failures.push(`${grade}/${sat} surface-2 ${s2} 对白 ${s2Ratio.toFixed(4)}:1`)
    }
  }
  assert.deepEqual(
    failures,
    [],
    '这些配色档位的底色差塌陷（白纸压在白桌面上，只能靠线分开）：\n' + failures.join('\n')
  )
})

/* ------------------------------------------------------------------ *
 * C. 用法：皮肤定义了必须真的被用上
 * ------------------------------------------------------------------ */

test('内容区（桌面层）必须铺 --k12-page，不能铺白纸或透明', () => {
  const shell = read(...`${R}/layouts/AppShell.vue`.split('/'))
  const content = ruleBody(shell, '.shell__content')
  assert.ok(content.length > 0, 'AppShell 里找不到 .shell__content 规则（内容区是桌面层的落点）')
  assert.match(
    content,
    /background:\s*var\(--k12-page\)/,
    '内容区必须铺页面底色（--k12-page）：它是「桌面」，白纸卡片要靠它分出边界'
  )
  // body 也铺桌面色：它是「桌面」的最外层，漏了会在滚动回弹 / 换页间隙露出白底
  assert.match(ruleBody(baseCss, 'body'), /background:\s*var\(--k12-page\)/, 'body 必须铺 --k12-page')
})

test('嵌入块皮肤：.k12-inset 必须有底色 + 1px 细线（否则「浅底压浅底」分不开）', () => {
  const inset = ruleBody(baseCss, '.k12-inset')
  assert.ok(inset.length > 0, 'base.css 里找不到 .k12-inset 规则（E3 嵌入块皮肤的唯一来源）')
  assert.match(inset, /background:\s*var\(--k12-surface-2\)/, '.k12-inset 必须铺 --k12-surface-2')
  assert.match(
    inset,
    /border:\s*1px\s+solid/,
    '.k12-inset 必须有 1px 细线（page 也带色之后，纯底色差不够）'
  )
  // 定义好却没人用 = 摆设。右栏的四块嵌入块是真实消费者（D-105 补上的）。
  const rail = read(...`${R}/components/ContextRail.vue`.split('/'))
  assert.match(rail, /class="[^"]*k12-inset/, '右栏至少要有一个真实的 .k12-inset 消费者（皮肤定义了就得用上）')
})

test('结构分面（侧栏 / 右栏 / 顶栏 / 档案画像栏）必须有强线或单侧投影', () => {
  const sidebar = read(...`${R}/components/AppSidebar.vue`.split('/'))
  const rail = read(...`${R}/components/ContextRail.vue`.split('/'))
  const topbar = read(...`${R}/components/AppTopbar.vue`.split('/'))
  // ★ 学习档案页右栏（2026-09-29 新开出的 20%）：它与左列内容区同样是
  //   一对「并列面」，「线 + 单侧投影」的口径必须与对话页右栏一致 ——
  //   少一样就会在带学段色的桌面上读成「两块白纸糊在一起」。
  const portrait = read(...`${R}/components/StudyPortrait.vue`.split('/'))

  // 侧栏：右缘是它与内容区唯一的分界。2026-09-22 曾删掉这条线（理由是"材质差够了"），
  // 而真实原因是两个档位的材质差塌陷 —— 见 D-105。现在要求"线 + 投影"都要有。
  const sb = ruleBody(sidebar, '.sb')
  assert.ok(sb.length > 0, 'AppSidebar 里找不到 .sb 规则')
  assert.match(
    sb,
    /border-right:\s*1px\s+solid\s+var\(--k12-border-strong\)/,
    '侧栏必须有 border-right（强线档），否则它看起来"飘"在桌面上'
  )
  assert.match(sb, /box-shadow:\s*var\(--k12-shadow-edge-right\)/, '侧栏必须有 --k12-shadow-edge-right（单侧投影）')

  // 右栏：左缘同理
  const panel = ruleBody(rail, '.rail__panel')
  assert.ok(panel.length > 0, 'ContextRail 里找不到 .rail__panel 规则')
  assert.match(panel, /border-left:\s*1px\s+solid\s+var\(--k12-border-strong\)/, '右栏必须有 border-left（强线档）')
  assert.match(panel, /box-shadow:\s*var\(--k12-shadow-edge-left\)/, '右栏必须有 --k12-shadow-edge-left（单侧投影）')

  // 顶栏：下缘的线（chrome 与内容的分隔）
  assert.match(
    ruleBody(topbar, '.tb'),
    /border-bottom:\s*1px\s+solid\s+var\(--k12-border-strong\)/,
    '顶栏必须有 border-bottom（强线档）'
  )

  // 学习档案页的画像栏：左缘同理（它与左列内容区不是父子、是并列面）
  const portraitBody = ruleBody(portrait, '.portrait')
  assert.ok(portraitBody.length > 0, 'StudyPortrait 里找不到 .portrait 规则')
  assert.match(
    portraitBody,
    /border-left:\s*1px\s+solid\s+var\(--k12-border-strong\)/,
    '档案画像栏必须有 border-left（强线档）'
  )
  assert.match(
    portraitBody,
    /box-shadow:\s*var\(--k12-shadow-edge-left\)/,
    '档案画像栏必须有 --k12-shadow-edge-left（单侧投影）'
  )
})

test('单侧投影令牌存在，且由前景色派生（随学段主题走，不写死灰）', () => {
  for (const name of ['edge-right', 'edge-left', 'edge-bottom']) {
    assert.match(
      baseCss,
      new RegExp(`--k12-shadow-${name}:`),
      `缺少 --k12-shadow-${name}（结构分面的浮起靠它）`
    )
  }
  // 三支都必须从 --k12-fg 派生：写死 rgba(0,0,0,…) 在带学段色的桌面上会发脏
  for (const name of ['edge-right', 'edge-left', 'edge-bottom']) {
    assert.match(
      baseCss,
      new RegExp(`--k12-shadow-${name}:[^;]*color-mix\\(in srgb, var\\(--k12-fg\\)`),
      `--k12-shadow-${name} 必须从 --k12-fg 派生（不要写死 rgba）`
    )
  }
})

/* ------------------------------------------------------------------ *
 * D. 学习档案页的两列外壳
 * ------------------------------------------------------------------ */

test('★★ 学习档案页：左列内容 + 右列画像（25% 带上下限），窄窗堆叠', () => {
  const study = read(...`${R}/views/Study.vue`.split('/'))

  // ★ 两列 grid，且左列必须 `minmax(0, 1fr)`。
  //   `1fr` 的最小值是 `auto`：分页里任何宽内容（表格 / 长串）会把它顶宽，
  //   右列被挤到窗口外 —— 这是这一版最容易写错、且只在真机上才看得见的一处。
  // ★ 2026-09-30：右列从 clamp(232px, 20%, 288px) 调大到 clamp(280px, 25%, 348px) ——
  //   右栏内容从「几行标签 + 四条掌握度」变成「五行结构 + 最近在学」，20% 下会挤成竖条。
  assert.match(
    study,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+clamp\(\s*280px\s*,\s*25%\s*,\s*348px\s*\)/,
    '两列宽度必须是 minmax(0, 1fr) + clamp(280px, 25%, 348px)（左列不钉 0 会被宽内容顶飞）'
  )
  // ★ 左列的头 / 体仍在（改造不许把五个分页那一层顺手改坏）。
  const main = ruleBody(study, '.study__main')
  assert.ok(main.length > 0, '左列外壳 .study__main 必须存在')
  assert.match(main, /display:\s*flex/, '左列必须是纵向 flex（头不滚、内容滚）')
  assert.match(main, /min-width:\s*0/, '左列要 min-width: 0（否则它是 grid 里被顶飞的那一个）')
  // ★ 右栏组件真的挂在模板里。
  assert.match(study, /<StudyPortrait\s*\/>/, '模板里必须真的渲染右栏画像组件')
  // ★ 窄窗堆叠（1023px 断点，沿用全站主断点）。
  assert.match(
    study,
    /@media\s*\(max-width:\s*1023px\)/,
    '窄窗必须有 1023px 的堆叠规则（并排会把分页内容挤成一条竖井）'
  )
})
