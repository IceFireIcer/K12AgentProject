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
 * 于是层次是：
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
 * 六个学段档 —— **值逐字取自 Pencil 画布导出**。
 * bg / surface-2 / accent / accent-2 / accent-soft / accent-border / chip 都是原值。
 * ink 是算出来的（画布没有这一支）。
 */
const GRADE_RAW = [
  {
    key: 'primary-low',
    bg: ['#FFF2E4', '#fff9f3', '#FAFAFB'],
    s2: ['#FFF8F0', '#fffcf8', '#F5F6F9'],
    accent: '#F97316',
    accent2: '#FB7185',
    soft: ['#fef0e5', '#fef0e5', '#F1F5F9'],
    border: ['#fdd5b9', '#fdd5b9', '#E2E8F0'],
    chip: [['#feede1', '#bd5711'], ['#fff5ef', '#bd5711'], ['#FFFFFF', '#F97316']]
  },
  {
    key: 'primary-high',
    bg: ['#E8F6FE', '#f5fbff', '#FAFAFB'],
    s2: ['#F3FAFF', '#f9fdff', '#F5F6F9'],
    accent: '#0EA5E9',
    accent2: '#22C55E',
    soft: ['#e4f5fd', '#e4f5fd', '#F1F5F9'],
    border: ['#b7e4f8', '#b7e4f8', '#E2E8F0'],
    chip: [['#e0f3fc', '#0b7db1'], ['#eef9fd', '#0b7db1'], ['#FFFFFF', '#0EA5E9']]
  },
  {
    key: 'junior',
    bg: ['#ECEDFE', '#f6f7ff', '#FAFAFB'],
    s2: ['#F6F7FE', '#fbfbff', '#F5F6F9'],
    accent: '#4F46E5',
    accent2: '#7C6CF0',
    soft: ['#ecebfc', '#ecebfc', '#F1F5F9'],
    border: ['#cac8f7', '#cac8f7', '#E2E8F0'],
    chip: [['#e8e7fc', '#3c35ae'], ['#f3f2fd', '#3c35ae'], ['#FFFFFF', '#4F46E5']]
  },
  {
    key: 'senior',
    bg: ['#E8F6F3', '#f5fbfa', '#FAFAFB'],
    s2: ['#F4FAF9', '#fafdfc', '#F5F6F9'],
    accent: '#0D9488',
    accent2: '#0EA5E9',
    soft: ['#e4f3f2', '#e4f3f2', '#F1F5F9'],
    border: ['#b6dfdb', '#b6dfdb', '#E2E8F0'],
    chip: [['#e0f1f0', '#0a7067'], ['#eef8f7', '#0a7067'], ['#FFFFFF', '#0D9488']]
  },
  {
    key: 'default',
    bg: ['#FFFFFF', '#FFFFFF', '#FFFFFF'],
    s2: ['#F7F9FC', '#F7F9FC', '#F7F9FC'],
    accent: '#2563EB',
    accent2: '#EC4899',
    soft: ['#ebf1fd', '#ebf1fd', '#F1F5F9'],
    border: ['#c6d6fa', '#c6d6fa', '#E2E8F0'],
    chip: [['#EFF5FF', '#1D4ED8'], ['#EFF5FF', '#1D4ED8'], ['#FFFFFF', '#2563EB']]
  },
  {
    key: 'brand',
    bg: ['#ECFDF5', '#f6fefb', '#FAFAFB'],
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
    themed.page.push(g.bg[si])
    themed.surface.push(W)
    themed['surface-2'].push(g.s2[si])
    themed.accent.push(g.accent)
    // 文字/填充用的墨：压深到"落在任何一个可能的浅底上都 ≥4.5:1"，
    // 且白字压在它上面也 ≥4.5:1。画布原值这两条都做不到，所以这一支是算的。
    themed['accent-ink'].push(
      darkenTo(g.accent, 4.5, [W, g.bg[si], g.s2[si], g.soft[si]])
    )
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
  // 边框（画布原值）：可见的线才有边界
  border: '#E6EAF2',
  'border-strong': '#D9DFEC',
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
    '画布 Pencil pencil-new.pen 的文档变量原值 + 两处算出来的偏离：' +
    '① accent-ink（画布 accent 压深到白底 ≥4.5:1，供文字用，原值只够当图形色）；' +
    '② muted #7A849B→#616A7A（原值 3.75:1，承载信息的 meta 读不清）。' +
    '「页面底色 + 白卡片」这一层是画布本来的设计，曾被我改成全白导致组件边界消失，现已恢复。',
  _generatedBy: 'scripts/author-tokens.mjs（派生色用 sRGB 插值，与 CSS color-mix 等价）',
  _checkWith: 'node scripts/check-contrast.mjs --strict',
  _exportedAt: '2026-09-17',
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
