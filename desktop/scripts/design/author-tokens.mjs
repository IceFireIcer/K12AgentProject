/**
 * 生成 tokens.source.json —— 恢复画布原始配色的浅色体系。
 *
 * ── 为什么回到浅色（这一轮的决定）──────────────────────────────────────
 * 上一版试过「深色仪器壳 + 亮面内容」，用户判定那是"夜晚模式"，不要。
 * 色彩体系回到 Pencil 画布的原值（见下方 GRADES / SATS，逐字取自画布导出）。
 *
 * ── 边界问题的根因（这一轮真正要修的）──────────────────────────────────
 * 之前"分不清组件边界"不是因为边框太细，而是因为 **页面底色也是白的** ——
 * 白卡片压在白页面上，只能靠 6% 透明度的细线分隔，等于没有分隔。
 *
 * 画布原本的设计是：**每个学段有一个带色的页面底色**（初中 #ECEDFE、
 * 小学低 #FFF2E4…），白卡片压在上面时边界天然清楚。恢复它，边界问题就解决了。
 *
 * ── 2026-09-27 的第二次修正（D-105）：两处「看起来是白的」────────────────
 * 上一次恢复底色只改了 6 个学段的 vivid 档，留下两个洞，用户看到的仍是白底白线：
 *   ① `default` 档（**开机默认**：学段还没判定出来时全站都用它）的 page 是 `#FFFFFF`
 *      —— 白卡片压在白页面上，正是最坏情况，而且它是第一印象；
 *   ② 5 个学段的 `mono` 档 page 是 `#FAFAFB`，比卡片内的嵌入块（surface-2 `#F5F6F9`）
 *      **还亮** —— 层次顺序倒挂，嵌入块反而"浮"在页面之上。
 * 同时把两支边框从画布原值压深（1.21:1/1.34:1 → 1.50:1/2.35:1）：底色差是主信号，
 * 线是副信号，但副信号太弱时「这里有一条边界」就读不出来（见 single.border 的注释）。
 *
 * 层次是：
 *   page  页面底色（画布原 bg，带学段色）  ← 最底
 *   card  白卡片（#FFFFFF）+ 1px 边框 + 浅投影
 *   inset 卡片内的嵌入块（画布原 surface-2，带学段色）
 *   float 浮层（白 + 更强投影）
 *
 * ── 唯一一处偏离画布 ────────────────────────────────────────────────────
 * 画布的 accent 是给**大面积色块**定的，直接当小字色用不达标
 * （小学低 2.8:1、品牌绿 2.5:1，AA 要 4.5:1）。所以每个学段配两支：
 *   accent      画布原值 → 边框、浅底、大片装饰（"被看"的东西）
 *   accent-ink  压深版   → 文字、按钮填充、进度、节点（"被读"的东西）
 *   两者都保留画布的色相，只是明度不同 —— 明快感在 accent，可读性在 ink。
 * 这一处偏离有机器校验兜底（check-contrast.mjs），不是随手改的。
 *
 * ── 2026-09-27 的第四、五处偏离（D-105）────────────────────────────────
 *   ④ 边框两支压深（画布原值 1.21:1 / 1.34:1，读不出"这里有边界"）
 *   ⑤ 画布**底色**不塌陷下限：soft / mono 档原值对白纸低到 1.02–1.03
 *      （vivid 档看不出问题，落在这些档上就是用户反馈的"白底白线"）
 * 两者都有机器校验兜底，见下方 CANVAS_FLOOR / single.border 的注释。
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hex2rgb = (h) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16))
const rgb2hex = (c) =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase()).join('')
/** 与 color-mix(in srgb, a p%, b) 等价 */
const mix = (a, b, p) => rgb2hex(hex2rgb(a).map((v, i) => v * p + hex2rgb(b)[i] * (1 - p)))
const W = '#FFFFFF'
const FG = '#1B2233'

// ── 对比度工具（用于反推 accent-ink 的混合比例）─────────────────────────
const lum = (h) => {
  const c = hex2rgb(h)
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
const cr = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
/**
 * 逐步压深直到达标。要同时满足**两条**（它们在数学上是同一条件：
 * 相对亮度 L ≤ 0.1833）：
 *   ① 当文字时，压在所有可能落到的浅底上都 ≥min
 *   ② 当填充时，白字压在上面 ≥min
 * 所以按"最深的那个底"来算，一处达标则处处达标。
 */
function darkenTo(accent, min, backgrounds) {
  for (let p = 100; p >= 25; p -= 1) {
    const c = mix(accent, FG, p / 100)
    const okText = backgrounds.every((bg) => cr(c, bg) >= min)
    const okFill = cr(W, c) >= min
    if (okText && okFill) return c
  }
  return mix(accent, FG, 0.25)
}

/** 同样逐级压深，只对单一底色 */
function darkenOn(accent, min, bg) {
  for (let p = 100; p >= 25; p -= 1) {
    const c = mix(accent, FG, p / 100)
    if (cr(c, bg) >= min) return c
  }
  return mix(accent, FG, 0.25)
}

/**
 * ★★ 桌面不塌陷下限（2026-09-27，D-105）——本轮修「边界看不见」的最后一块。
 *
 * 背景：`soft` / `mono` 两档的 `bg` 是画布给的**很浅**的取值（soft 最浅的一档
 * 对白纸只有 1.025:1，mono 的嵌入块 1.020:1）。vivid 档看不出问题，一旦用户
 * （或默认值）落在这些档上，「白纸压在白桌面上」就原样复发 —— 而那正是用户
 * 反馈的原始现象。底色差是边界的主信号，它不能被某一档悄悄关掉。
 *
 * 规则（两条，都只作用于**已经太浅**的取值，达标的一律不动）：
 *   ① `page` 与 `surface-2` 对白纸 ≥1.045 —— 保证"桌面"能被看出来；
 *   ② `surface-2` 与 `page` ≥1.01 —— 保证嵌入块直接落在桌面上时也分得开
 *      （顺序不限：本仓的嵌入块主要落在**纸面**上，与桌面的先后不构成约束）。
 * 之下不改动任何画布原值、不动色相，只压明度一档 —— 与 accent-ink 同一手法。
 */
const CANVAS_FLOOR = 1.045
const LAYER_GAP = 1.01
/** 逐级压深（每步 2%），返回**第一个同时满足** predicate 的色；都不满足就取最深那档。 */
function deepenUntil(color, predicate) {
  for (let p = 100; p >= 20; p -= 2) {
    const c = mix(color, FG, p / 100)
    if (predicate(c)) return c
  }
  return mix(color, FG, 0.2)
}

/**
 * 六个学段档 —— **值逐字取自 Pencil 画布导出**。
 * bg / surface-2 / accent / accent-2 / accent-soft / accent-border / chip 都是原值。
 * ink 是算出来的（画布没有这一支）。
 */
const GRADE_RAW = [
  {
    key: 'primary-low',
    bg: ['#FFF2E4', '#fff9f3', '#F1F2F6'],
    s2: ['#FFF8F0', '#fffcf8', '#F5F6F9'],
    accent: '#F97316',
    accent2: '#FB7185',
    soft: ['#fef0e5', '#fef0e5', '#F1F5F9'],
    border: ['#fdd5b9', '#fdd5b9', '#E2E8F0'],
    chip: [['#feede1', '#bd5711'], ['#fff5ef', '#bd5711'], ['#FFFFFF', '#F97316']]
  },
  {
    key: 'primary-high',
    bg: ['#E8F6FE', '#f5fbff', '#F1F2F6'],
    s2: ['#F3FAFF', '#f9fdff', '#F5F6F9'],
    accent: '#0EA5E9',
    accent2: '#22C55E',
    soft: ['#e4f5fd', '#e4f5fd', '#F1F5F9'],
    border: ['#b7e4f8', '#b7e4f8', '#E2E8F0'],
    chip: [['#e0f3fc', '#0b7db1'], ['#eef9fd', '#0b7db1'], ['#FFFFFF', '#0EA5E9']]
  },
  {
    key: 'junior',
    bg: ['#ECEDFE', '#f6f7ff', '#F1F2F6'],
    s2: ['#F6F7FE', '#fbfbff', '#F5F6F9'],
    accent: '#4F46E5',
    accent2: '#7C6CF0',
    soft: ['#ecebfc', '#ecebfc', '#F1F5F9'],
    border: ['#cac8f7', '#cac8f7', '#E2E8F0'],
    chip: [['#e8e7fc', '#3c35ae'], ['#f3f2fd', '#3c35ae'], ['#FFFFFF', '#4F46E5']]
  },
  {
    key: 'senior',
    bg: ['#E8F6F3', '#f5fbfa', '#F1F2F6'],
    s2: ['#F4FAF9', '#fafdfc', '#F5F6F9'],
    accent: '#0D9488',
    accent2: '#0EA5E9',
    soft: ['#e4f3f2', '#e4f3f2', '#F1F5F9'],
    border: ['#b6dfdb', '#b6dfdb', '#E2E8F0'],
    chip: [['#e0f1f0', '#0a7067'], ['#eef8f7', '#0a7067'], ['#FFFFFF', '#0D9488']]
  },
  {
    key: 'default',
    // ★★ 2026-09-27（D-105）：这一档原来是 `#FFFFFF` —— 也就是**开机默认档的
    //   页面底色就是纯白**，于是「白卡片压在白页面上」的最坏情况恰恰是用户
    //   第一眼看到的那个界面（学段还没判定出来时全站都是它）。
    //   它比 mono 档还亮，是「边界看不见」的结构性根因，不是线太细。
    //   改成与 default 学段色（#2563EB 蓝）同色相的淡底。
    bg: ['#EEF2FC', '#F5F8FD', '#F1F2F6'],
    s2: ['#F7F9FC', '#F7F9FC', '#F7F9FC'],
    accent: '#2563EB',
    accent2: '#EC4899',
    soft: ['#ebf1fd', '#ebf1fd', '#F1F5F9'],
    border: ['#c6d6fa', '#c6d6fa', '#E2E8F0'],
    chip: [['#EFF5FF', '#1D4ED8'], ['#EFF5FF', '#1D4ED8'], ['#FFFFFF', '#2563EB']]
  },
  {
    key: 'brand',
    bg: ['#ECFDF5', '#f6fefb', '#F1F2F6'],
    s2: ['#F5FDF0', '#fafef8', '#F5F6F9'],
    accent: '#10B981',
    accent2: '#84CC16',
    soft: ['#e5f7f1', '#e5f7f1', '#F1F5F9'],
    border: ['#b7ead9', '#b7ead9', '#E2E8F0'],
    chip: [['#e0f6ef', '#0c8d62'], ['#eefaf6', '#0c8d62'], ['#FFFFFF', '#10B981']]
  }
]

const SAT_KEYS = ['vivid', 'soft', 'mono']
const grades = GRADE_RAW.map((g) => g.key)
const sats = SAT_KEYS

const themed = {
  // 页面底色：画布原 bg。**这是边界能看清的前提** —— 白卡片压在有色的页面上。
  page: [],
  // 卡片面与嵌入块
  surface: [],
  'surface-2': [],
  // 学段色
  accent: [],
  'accent-ink': [],
  'accent-2': [],
  'accent-soft': [],
  'accent-border': [],
  'chip-bg': [],
  'chip-fg': []
}

for (const g of GRADE_RAW) {
  SAT_KEYS.forEach((sat, si) => {
    // 桌面与嵌入块：画布原值先过一道「不塌陷下限」（见 CANVAS_FLOOR 的注释）。
    // ⚠️ 两条判据一起解 —— 只按"对白纸达标"压深，会把 surface-2 压到与 page 同色
    //    （junior/soft 实测只剩 1.0007），嵌入块又与桌面糊在一起。
    const page = cr(g.bg[si], W) < CANVAS_FLOOR ? deepenUntil(g.bg[si], (c) => cr(c, W) >= CANVAS_FLOOR) : g.bg[si]
    const s2Need = (c) => cr(c, W) >= CANVAS_FLOOR && cr(c, page) >= LAYER_GAP
    const s2 = s2Need(g.s2[si]) ? g.s2[si] : deepenUntil(g.s2[si], s2Need)
    themed.page.push(page)
    themed.surface.push(W)
    themed['surface-2'].push(s2)
    themed.accent.push(g.accent)
    // 文字/填充用的墨：压深到"落在任何一个可能的浅底上都 ≥4.5:1"，
    // 且白字压在它上面也 ≥4.5:1。画布原值这两条都做不到，所以这一支是算的。
    // ⚠️ 底色用**下限修正之后**的 page / s2 —— 墨必须落在真实会出现的底上。
    themed['accent-ink'].push(darkenTo(g.accent, 4.5, [W, page, s2, g.soft[si]]))
    themed['accent-2'].push(g.accent2)
    themed['accent-soft'].push(g.soft[si])
    themed['accent-border'].push(g.border[si])
    themed['chip-bg'].push(g.chip[si][0])
    // 胶囊文字也压到达标（画布原值有几档是 4.0–4.3:1）
    themed['chip-fg'].push(darkenOn(g.chip[si][1], 4.5, g.chip[si][0]))
  })
}

const single = {
  // 文字（画布原值）
  fg: FG,
  'fg-2': '#3E4761',
  // 画布的 muted 是 3.75:1，承载信息的 meta 用它会读不清 ——
  // 压到 #616A7A（5.45:1）。这是第二处、也是最后一处偏离画布，同样有脚本兜底。
  muted: '#616A7A',
  'muted-2': '#8A93A3',
  // 边框：**分档**（2026-09-27，D-105）。画布原值（#E6EAF2 / #D9DFEC）对白
  // 只有 1.21:1 / 1.34:1，在 1px 宽度下几乎读不出「这里有一条边界」——
  // 界面走查的结论是「侧栏像飘在空中、顶栏没有底边、卡片与页面融为一体」。
  //   border        卡片/嵌入块的发丝线 → 1.50:1（够看见，仍不抢内容）
  //   border-strong 结构分面（侧栏/顶栏/右栏/浮层）→ 2.35:1（一眼是边界）
  // ⚠️ 两者都**不到 WCAG 图形 3:1**。这是有意的：发丝线在浅色体系里是「提示」
  //    而不是「图形」，3:1 的线（≈#86909F）会让整个界面变成线框风。
  //    真正承担层级的是「桌面底色差 + 单侧投影 + 线」三者叠加，见 base.css 文件头。
  border: '#D1D5DB',
  'border-strong': '#9CA3AF',
  // 语义色：画布的 good/warn/bad 是给色块定的，压深后用作文本色
  good: '#0B7A57',
  'good-soft': '#F0FAF5',
  'good-border': '#CDEEDF',
  warn: '#9A5B08',
  'warn-soft': '#FFF8EC',
  'warn-border': '#F3E2C0',
  bad: '#C0392B',
  'bad-soft': '#FDECEA',
  'bad-border': '#F5C6C0',
  cyan: '#0E7490',
  'cyan-soft': '#ECF9FB'
}

const out = {
  _source:
    '画布 Pencil pencil-new.pen 的文档变量原值 + 三处算出来的偏离：' +
    '① accent-ink（画布 accent 压深到白底 ≥4.5:1，供文字用，原值只够当图形色）；' +
    '② muted #7A849B→#616A7A（原值 3.75:1，承载信息的 meta 读不清）；' +
    '③ 边框两支压深（画布 #E6EAF2/#D9DFEC 对白只有 1.21:1/1.34:1，读不出边界）。' +
    '「页面底色 + 白卡片」这一层是画布本来的设计，曾被我改成全白导致组件边界消失，现已恢复；' +
    '2026-09-27 又补齐 default 档（原是纯白，即开机默认档）与 mono 档的底色，见 D-105。',
  _generatedBy: 'scripts/design/author-tokens.mjs（派生色用 sRGB 插值，与 CSS color-mix 等价）',
  _checkWith: 'node scripts/design/check-contrast.mjs --strict',
  _exportedAt: '2026-09-27',
  grades,
  sats,
  single,
  themed
}

writeFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'tokens.source.json'),
  JSON.stringify(out, null, 2) + '\n',
  'utf8'
)
console.log('✓ tokens.source.json（画布原配色 + 页面底色）')
console.log(`  ${grades.length} 学段 × ${sats.length} 档 = ${grades.length * sats.length} 组`)
console.log('\n  学段          页面底色    accent（图形）  accent-ink（文字）')
for (const g of GRADE_RAW) {
  const i = grades.indexOf(g.key) * sats.length
  console.log(
    `  ${g.key.padEnd(14)} ${themed.page[i]}     ${g.accent}        ${themed['accent-ink'][i]}  (${cr(themed['accent-ink'][i], W).toFixed(2)}:1)`
  )
}
