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

test('桌面层：内容区与 body 必须透明（壁纸 + 毛玻璃才是那一层）', () => {
  /**
   * ★★ 2026-10-02 改判（同一篇用户口径，见 `base.css` 的壁纸一节）：
   *   本条原先要求内容区与 body **铺 `--k12-page` 实色** —— 那时"桌面"就是一块颜色。
   *   现在桌面是**学段壁纸 + 一层毛玻璃**（两个 `body` 伪元素），实色会把图整块盖掉
   *   （表现是"图根本没显示"）。所以本条改成守**新的机制**，而它要防的那个故障
   *   ——「白纸压白桌、层次塌陷」—— 一条都没放松：
   *     · 纸面仍是 70% 白（见下面的断言），压在**带学段色相**的毛玻璃上；
   *     · 毛玻璃那 4% 的淡色取自 `--k12-page`，所以"桌面带学段色"这件事仍然成立；
   *     · 再加壁纸本身的明暗变化，卡片边界比纯色桌面时代**更容易**读出来。
   */
  const shell = read(...`${R}/layouts/AppShell.vue`.split('/'))
  const content = ruleBody(shell, '.shell__content')
  assert.ok(content.length > 0, 'AppShell 里找不到 .shell__content 规则（内容区是桌面层的落点）')
  assert.match(
    content,
    /background:\s*transparent/,
    '内容区必须透明：桌面层由 body 的壁纸伪元素 + 毛玻璃伪元素承担，实色会把壁纸盖掉'
  )
  // body 同样：它上面压着壁纸与毛玻璃两层，自己刷任何底色都会把图盖住
  assert.match(
    ruleBody(baseCss, 'body'),
    /background:\s*transparent/,
    'body 必须透明（它下面就是壁纸层；漏了会在滚动回弹 / 换页间隙露出实色）'
  )

  // ── 反向对照：桌面层那两层**必须真的在** ────────────────────────────────
  //   只断言"透明"是不够的 —— 把壁纸与毛玻璃两段一起删掉，上面两条照样绿，
  //   而界面会退化成"纯透明底"，那比白底更糟（卡片直接飘在窗口背景上）。
  const before = ruleBody(baseCss, 'body::before')
  assert.match(before, /background-image:\s*var\(--k12-wallpaper\)/, 'body::before 必须真的铺壁纸')
  const after = ruleBody(baseCss, 'body::after')
  assert.match(after, /backdrop-filter:\s*blur\(/, 'body::after 必须是毛玻璃（backdrop-filter）')
  assert.match(
    after,
    /background:\s*var\(--k12-glass-tint\)/,
    'body::after 的淡色必须走 --k12-glass-tint（它是"桌面带学段色"的唯一残留）'
  )

  // ── 纸面仍是 70% 白：这一条是"边界读得出来"的最后一根立柱 ──────────────
  //   ⚠️ 它在这里而不是在 contrast 校验里：那是**生成物**的色对校验，
  //   而"纸面半透"是这一版的**呈现**覆盖（见 base.css 的覆盖块）。
  //   ⚠️ 覆盖块是**一组**选择器（28 条，与 tokens.generated.css 逐条对齐 ——
  //   只写 `:root` 压不住它的 `:not([data-sat])` 那条），所以这里在整个文件里找，
  //   不盯某一条规则体。
  assert.match(
    baseCss,
    /--k12-surface:\s*color-mix\(in srgb, #FFFFFF 45%, transparent\)/,
    '纸面必须仍是 45% 白（压在半透毛玻璃上；再往下调要重新核正文对比度）'
  )
  // 而且它**必须**与生成文件那 28 条选择器对齐：只写 `:root` 会被更高特异性的
  // `:root[data-grade=…]:not([data-sat])` 静默压掉（实测踩到两轮）。
  //   ⚠️ 用两段 includes 而不是一条大正则：正则里那对 `[data-sat]` 方括号、
  //   单引号与相邻的 `[\s\S]` 极易互相吃掉（实测写错过一次）。
  const gradeOnly = ":root[data-grade='junior']:not([data-sat])"
  const juniorAt = baseCss.indexOf(gradeOnly)
  assert.ok(
    juniorAt >= 0,
    '纸面覆盖必须照抄生成文件的选择器组：少了 :not([data-sat]) 那一支，' +
      '它会被生成文件里特异性更高的同名规则静默压掉（改了没反应）'
  )
  //   ⚠️ 距离上限给到 2000：这一组选择器有 28 行，中间还夹着大段说明注释
  //   （第一版给 300，被注释顶掉，红得莫名其妙）。
  assert.ok(
    baseCss.indexOf('--k12-surface:', juniorAt) - juniorAt < 2000,
    '那一组选择器里必须真的跟着 --k12-surface 的覆盖声明（声明，不是注释里提一句）'
  )

  /* ── 嵌入块（--k12-surface-2）的**呈现覆盖**（2026-10-04 用户报障）──────────
   * ★★ 报障原话：「有的控件没有透明度或者没有替换纯色导致后面的背景图看不到」。
   *   漏的就是这一层：18 组配色的 --k12-surface-2 是**不透明**浅色，
   *   压在壁纸上就是一块块纯色斑（关卡清单 / 题目卡 / 路径按钮 / 吸顶条 / chip /
   *   分段控件 / 侧栏条目）。
   *
   * ★ 这条守卫钉的是**对齐**，不是色值本身（色值会随观感调）：
   *   两处覆盖共用**同一组选择器** —— 生成文件里 --k12-surface 与 --k12-surface-2
   *   出现在完全相同的 25 条 :root 规则里。只给其中一处写选择器组，
   *   另一处就会退回"只写 :root"，被 :not([data-sat]) 那支静默压掉（改了没反应）。
   */
  assert.match(
    baseCss,
    /--k12-surface-2:\s*color-mix\(in srgb, #FFFFFF 60%, transparent\)/,
    '嵌入块必须半透（不透明的话它在壁纸上就是一块纯色斑 —— 用户报障的那一幕）'
  )
  const s2At = baseCss.indexOf('--k12-surface-2: color-mix')
  assert.ok(
    s2At >= 0 && s2At - juniorAt < 2000,
    '嵌入块的覆盖必须写在**同一组选择器**里（与 --k12-surface 共享），' +
      '否则它只压得住 :root，被生成文件里特异性更高的 :not([data-sat]) 静默压掉'
  )
  // 生成文件里两者选择器**完全同组**：这一条在生成物一变就红，提醒同步两组覆盖。
  const genRules = generated.split('}')
  const selsOf = (token: string): string[] => {
    const out = new Set<string>()
    for (const b of genRules) {
      const i = b.indexOf('{')
      if (i < 0) continue
      const sel = b.slice(0, i).replace(/\s+/g, ' ').trim()
      if (!sel.startsWith(':root')) continue
      if (!b.slice(i + 1).includes(token + ':')) continue
      for (const s of sel.split(',')) out.add(s.trim())
    }
    return [...out].sort()
  }
  assert.deepEqual(
    selsOf('--k12-surface-2'),
    selsOf('--k12-surface'),
    '生成文件里两个令牌必须同组选择器 —— 不同组时，base.css 那**一组**覆盖就会漏掉一些档位'
  )
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
  // ★★ 2026-10-02 改落点：从 `.tb` 挪到外壳那一行 `.shell__head`。
  //   为什么必须挪：顶栏与右侧窗控区是**同一条 chrome**，两边各画一条下边线
  //   会在 x 边界处错开 1px —— 用户截图点名的那条竖缝就是它。
  //   判据（"chrome 与内容之间有一条强线"）没松，只是唯一来源换了一处。
  const shellLayout = read(...`${R}/layouts/AppShell.vue`.split('/'))
  assert.match(
    ruleBody(shellLayout, '.shell__head'),
    /border-bottom:\s*1px\s+solid\s+var\(--k12-border-strong\)/,
    '外壳那一行（顶栏 + 窗控）必须有 border-bottom（强线档）'
  )
  assert.doesNotMatch(
    ruleBody(topbar, '.tb'),
    /border-bottom:\s*1px/,
    '顶栏组件自己不许再画下边线：与外壳那条会各画各的，在 x 边界错开'
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


/* ------------------------------------------------------------------ *
 * 吸顶操作条（PageActions）必须半透 —— 2026-10-04 用户报障
 * ------------------------------------------------------------------ */

test('吸顶操作条：半透 + 毛玻璃（不许在壁纸上留一条实色横条）', () => {
  /**
   * ★★ 用户原话：「我只想把这个组件的背景颜色直接改成透明的 和其他的透明程度一样
   *   可以看出来后面的背景图 显示的不那么突兀」。
   *   它原来铺 `--k12-page`（**不透明**的学段桌面色），所以是全站唯一一条
   *   "压在壁纸上却完全不透"的横条 —— 智码工坊与个性化学习两页都中。
   *
   * ★ 判据是「**半透**」而不是 "transparent"：这条是 sticky，滚动内容会从它下面
   *   经过，全透时正文会与它自己的面包屑/按钮叠在一起（把"挡住了"换成"糊成一片"）。
   *   ⇒ 三条一起判：① 不许再铺 --k12-page；② 要铺 45% 那层通用面（与卡片/气泡同值）；
   *      ③ 要有毛玻璃（只靠 45% 白挡不住滚动正文的笔画）。
   *
   * ⚠️ 这一段**必须独立成一个 test**：变异验证用 `--test-name-pattern <expect>` 选测试，
   *   把断言塞进上面那个"不塌陷"的 test 里时，expect 只能写那个 test 的名字 ——
   *   于是"吸顶条退回实色"这种变异**照样是绿的**（实测踩到，变异 137/138 三条全没抓到）。
   */
  const pageActions = read('src', 'renderer', 'src', 'components', 'PageActions.vue')
  assert.ok(
    !/background:\s*var\(--k12-page\)/.test(pageActions),
    '吸顶操作条不许铺 --k12-page（不透明学段桌面色 = 壁纸上的一条实色横条）'
  )
  /**
   * ★★ 2026-10-04 用户**第二次**报障：「为什么我箭头指的这个白色背景框框还没去掉
   *   想办法去掉 从智码工坊和个性化学习」。
   *   第一版只把它从 --k12-page（不透明）改成 --k12-surface（45% 白）+ 毛玻璃 ——
   *   那仍是「一块比周围白的横带」，在这两页的右栏上就是用户圈的那个白框框。
   *   ⇒ 判据改成**彻底没有底色**。它与上面「不许铺 --k12-page」合起来看：
   *     既不许不透明、也不许半透 —— 就是不许有那层白。
   * ★ 它能全透而不糊：sticky 的父容器（.code__stage / .quiz__main）都有自己的内边距，
   *   正常不滚动时栏里没有别的内容；右栏本来就有自己的分面线。
   * ⚠️ 若日后发现「滚动时正文从栏下透出来」，**不要**退回铺实色（那正是用户两次要求
   *   去掉的东西）—— 改用「给栏里内容加自己的底」或调内边距。
   */
  assert.match(
    pageActions,
    /background:\s*transparent/,
    '吸顶操作条必须**完全透明** —— 半透白仍是用户圈的那个白框框（他两次要求去掉）'
  )
})
/* ------------------------------------------------------------------ *
 * 内容区不许被"两层白"冲成纯白 —— 2026-10-04 用户报障
 * ------------------------------------------------------------------ */

test('内容区：页面根容器不许套 85% 白卡片（两层白会把壁纸冲掉）', () => {
  /**
   * ★★ 用户原话：「你在个性化学习那一页完全理解错我的意思了 我想要的效果是背景图
   *   可以看到 有个透明度 就和我第一个图片给你的效果一样 你个性化学习做的完全乱套了」。
   *
   * 根因**不是布局**，是两层白叠起来：`.quiz`（个性化学习的页面根容器）原先在这份
   * "承载正文的卡片"名单里 → 整个内容区铺一层 85% 白；而它的子元素
   * （`.quiz__nav` / `.qitem` / `.quiz__card`）**各自已有底色** → 两白一叠合成 #FFFFFF。
   * 实测同一坐标（1500,400）：智码工坊 #BFE0EA（壁纸清晰可见）、
   * 个性化学习 #F5FAFC→#FFFFFF（几乎纯白）。
   *
   * ★ 判据：**页面根容器**不许进这份名单 —— 它一进去就是"整页再糊一层白"。
   *   要加白底的是**卡片**（.k12-card / .answer / .bubble / .option / .feedback），
   *   不是页面骨架。
   *
   * ⚠️ 必须先**去掉注释**再判：这份名单里就写着 `.turn__body` 这些类名的说明，
   *   不去注释的话，"死条目"那条断言会被自己的注释命中（实测踩到，第一次就是这么红的）。
   */
  const cardListMatch = /:root \.answer,[\s\S]*?\}/.exec(baseCss)
  assert.ok(cardListMatch !== null, '找不到"承载正文的卡片"那份名单（base.css 的 :root .answer 那一组）')
  const cardList = (cardListMatch?.[0] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')

  // ① 页面根容器不许在名单里
  assert.ok(
    !/:root\s+\.quiz\s*,/.test(cardList),
    '页面根容器 .quiz 不许进"85% 白卡片"名单 —— 它一进去，整个内容区就被第二层白冲成纯白' +
      '（子元素 .quiz__nav/.qitem 各自已有底色），壁纸彻底看不见（用户报障的那一幕）'
  )
  // ② 卡片本身仍要够实（正文可读，用户 2026-10-02 的口径）
  assert.match(
    cardList,
    /background:\s*var\(--k12-surface-card\)/,
    '承载正文的卡片仍要铺 --k12-surface-card（85% 白）—— 用户要的是"卡片读得下去"，不是全透'
  )
  // ③ 名单里不许再有零消费者的死条目：那种条目让"两层白"这类问题查起来绕远路
  for (const dead of ['.turn__body', '.doc-card', '.doc-drawer']) {
    assert.ok(
      !cardList.includes(dead),
      '卡片名单里有零消费者的死条目 ' + dead + ' —— 先确认它真的有消费者，再加进来'
    )
  }
})
/* ------------------------------------------------------------------ *
 * 一个人一个名字：侧栏与右栏画像必须同源 —— 2026-10-04 用户报障
 * ------------------------------------------------------------------ */

test('显示名：侧栏身份卡与右栏画像必须读同一个来源', () => {
  /**
   * ★★ 用户原话：「画像部分为什么切账号以后 画像部分的名字什么没有更新 你是不是忘记
   *   做联动机制了」。查出来**不是忘了联动** —— 是同一屏有**两个名字来源**：
   *     · 侧栏身份卡 / 头像字 读 `student.nickname`（GET /api/students，默认「同学」）；
   *     · 右栏画像 / 问候语 读 `identity.displayName`（GET /profile/{id}/identity，
   *       来自学生在引导页设的称呼）。
   *   实测同一台机器同一个人：侧栏「同学」、右栏真名。两条通道各自异步取数，
   *   切号时谁先回来谁先变 —— 看起来就是"没联动"。
   *
   * 修法有两层，这条守**前端那层**（后端那层见 server/tests/test_students_api.py
   * 的 TestDisplayNameReconcile：称呼与昵称在写入源头同步 + 存量自愈）：
   *   侧栏必须与画像**同源**（`identity.displayName`），昵称只作回落。
   *
   * ⚠️ 判据是「侧栏模板/标题里出现 displayName 派生的那个计算属性」，
   *   而不是「不许出现 student.nickname」—— 回落链 `displayName → nickname → 同学`
   *   里 nickname 本来就该在。
   */
  const sidebar = read('src', 'renderer', 'src', 'components', 'AppSidebar.vue')
  assert.match(
    sidebar,
    /profileCard\.identity\?\.displayName/,
    '侧栏必须读 identity.displayName（与右栏画像同一个来源）—— 否则同一个人两个名字'
  )
  // 身份卡与头像字都要用那个统一后的名字，不许各自再拼一遍
  assert.match(sidebar, /\{\{\s*studentName\s*\}\}/, '侧栏身份卡要显示统一后的 studentName')
  assert.ok(
    !/\{\{\s*student\.nickname\s*\}\}/.test(sidebar),
    '侧栏身份卡不许直接渲染 student.nickname —— 那是另一个来源，会与右栏画像打架'
  )
  assert.match(
    sidebar,
    /studentName\.trim\(\)\.slice\(0,\s*1\)/,
    '头像字要取自同一个 studentName（否则头像写一个名、旁边写另一个名）'
  )
})
