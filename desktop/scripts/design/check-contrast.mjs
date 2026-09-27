#!/usr/bin/env node
/**
 * 对比度校验：把 tokens.source.json 里每一组 grade × sat 的取值算一遍。
 *
 * ── 两支学段色的分工（这是本文件校验的核心约束）──────────────────────────
 *   accent      画布原值 → 图形、填充、边框（对白底 ≥3:1 即可，作图形合格）
 *   accent-ink  压深版   → **文字**（对白底必须 ≥4.5:1）
 *
 * ⚠️ 两者**不可互换**：accent 当小字用只有 2.5–3.0:1（读不清）；
 *    accent-ink 当大面积色块用会发闷（失去画布的明快感）。
 *    挑色时按"这个元素是要被读，还是要被看"选。
 *
 * 18 组 × 十几个 key = 几百个组合，肉眼和手算都查不过来，必须机器算。
 *
 * 用法（本文件在 `scripts/design/` 下 —— 路径早先写作 `scripts/`，那是改名前的旧称）：
 *   node scripts/design/check-contrast.mjs           # 只报告
 *   node scripts/design/check-contrast.mjs --strict  # 有不达标就 exit 1
 *
 * 已纳入 `npm test`（`check:contrast -- --strict`）：色值改动在本地回归里就会红，
 * 不必等 CI 或人肉记得跑。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = JSON.parse(readFileSync(resolve(here, 'tokens.source.json'), 'utf8'))
const { grades, sats, single, themed } = src
const strict = process.argv.includes('--strict')

/** 相对亮度（WCAG 2.1） */
function luminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

function parse(hex) {
  const h = hex.replace('#', '').trim()
  if (h.length !== 6 && h.length !== 8) throw new Error(`无法解析色值：${hex}`)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

const WHITE = [255, 255, 255]
const AA = 4.5
const GRAPHIC = 3

/**
 * 检查项。`on` 指明底色取自哪一档：
 *   'white'          → 纯白
 *   'single:<key>'   → 单值 token
 *   其余            → themed 的某一档（surface / page / surface-2 / accent-soft …）
 *   （注释里曾写 'paper' / 'shell'，那是改名前的旧称，现役只有 themed 的 key 名。）
 *
 * ── 边框为什么不按 WCAG 图形 3:1 卡（2026-09-27，D-105）────────────────
 * WCAG 1.4.11 管的是「**控件或图形的边界必须能被看见**」，3:1 是对
 * 「一个纯色块靠边界与相邻色块区分」的判据。本仓的边界信号是**三件套**：
 * 底色差（桌面 vs 纸面）+ 发丝线 + 单侧投影 —— 线只是副信号之一。
 * 把线单独压到 3:1（≈#86909F）会让整个浅色界面变成线框风，与产品定位冲突。
 * 所以这里的口径是**实测下限**（够看见）而不是 3:1：
 *   border        1.40（实测 1.47，卡片发丝线）
 *   border-strong 1.80（实测 2.54，结构分面的线）
 * 真正的兜底是 tests/visual-edges.test.ts 的「层次不塌陷」用例：
 * 就算线全被去掉，page/surface/surface-2 之间的底色差也必须分得开。
 */
const CONTRAST_BORDER = 1.4
const CONTRAST_BORDER_STRONG = 1.8

const CHECKS = [
  // ── 学段色：文字用 ink，图形用 accent ──────────────────────────────────
  { key: 'accent-ink', on: 'surface', min: AA, why: '文字用墨：链接 / 当前项 / 强调标签' },
  { key: 'accent-ink', on: 'page', min: AA, why: '文字用墨压在页面底色上（最坏情况：底色比白深）' },
  { key: 'accent-ink', on: 'surface-2', min: AA, why: '文字用墨压在嵌入块上' },
  { key: 'accent-ink', on: 'accent-soft', min: AA, why: '文字用墨压在浅色高亮底上' },
  // 注：不检查裸 accent 的对比度 —— 它是画布原值，用途是**边框、浅底、大片装饰**
  // （"被看"的东西）。凡是"被读"的（文字 / 按钮填充 / 进度 / 节点）一律用 accent-ink，
  // 由上面几条覆盖。把装饰色也塞进对比度检查，只会逼着把调色板改灰。
  { key: 'accent-ink', on: 'surface', min: AA, invert: true, why: '主按钮填充：白字压在墨上' },
  { key: 'chip-fg', on: 'chip-bg', min: AA, why: '胶囊：文字压在自己的底色上' },

  // ── 中性文字 ──────────────────────────────────────────────────────────
  { key: 'fg', on: 'surface', min: 7, why: '正文墨：主文字，按 AAA' },
  { key: 'fg-2', on: 'surface', min: AA, why: '次级正文（说明与描述）' },
  { key: 'muted', on: 'surface', min: AA, why: '承载信息的 meta 文字' },
  { key: 'muted', on: 'surface-2', min: AA, why: '嵌入块上的 meta（取最坏情况）' },
  // ★ 2026-09-27：page 现在**每一档**都带色（default 档原为纯白），
  //   于是「直接写在页面底色上、没有卡片兜着的文字」多了一条真实风险面 ——
  //   右栏的 `rail-grade`、对话页的话题 chip 都落在这一层上。
  { key: 'muted', on: 'page', min: AA, why: '直接落在页面底色上的 meta（右栏 / 话题 chip）' },
  { key: 'fg-2', on: 'page', min: AA, why: '直接落在页面底色上的次级正文' },

  // ── 语义色：同样会当文字用 ────────────────────────────────────────────
  { key: 'good', on: 'good-soft', min: AA, why: '语义绿（成功 / 高掌握）压在浅底上' },
  { key: 'warn', on: 'warn-soft', min: AA, why: '语义黄（警示 / 中掌握）压在浅底上' },
  { key: 'bad', on: 'bad-soft', min: AA, why: '语义红（错误 / 低掌握）压在浅底上' },
  { key: 'good', on: 'surface', min: AA, why: '语义绿直接写在白卡片上' },
  { key: 'warn', on: 'surface', min: AA, why: '语义黄直接写在白卡片上' },
  { key: 'bad', on: 'surface', min: AA, why: '语义红直接写在白卡片上' },

  // ── 边界（见上方 CONTRAST_BORDER 的口径说明）──────────────────────────
  { key: 'border', on: 'surface', min: CONTRAST_BORDER, why: '卡片发丝线：够看见边界即可' },
  { key: 'border-strong', on: 'surface', min: CONTRAST_BORDER_STRONG, why: '结构分面的线（侧栏 / 顶栏 / 右栏 / 浮层）' },
  { key: 'border-strong', on: 'page', min: CONTRAST_BORDER_STRONG, why: '结构分面的线压在页面底色上' },
  // 嵌入块的线是全站最弱的一环：它本来就只取 70% 的 `--k12-border`（见 .k12-inset），
  // 压在比纸面更浅的 surface-2 上。它不承担"这是边界"，只承担"这是另一块"——
  // 主信号是它自己的底色差，所以下限按实测放到 1.30（最差 1.36）。
  { key: 'border', on: 'surface-2', min: 1.3, why: '嵌入块的线压在自己的浅底上（最弱一环）' }
]

function resolveBg(cfg, idx) {
  if (cfg === 'white') return WHITE
  if (cfg.startsWith('single:')) return parse(single[cfg.slice(7)])
  const v = themed[cfg]?.[idx]
  return v ? parse(v) : null
}

/** 检查项里的 key 可能取自 themed，也可能取自 single（语义色在 single 里） */
function resolveFg(key, idx) {
  const t = themed[key]?.[idx]
  if (t) return t
  return single[key]
}

const rows = []
let failures = 0

for (const grade of grades) {
  for (const sat of sats) {
    const idx = grades.indexOf(grade) * sats.length + sats.indexOf(sat)
    for (const check of CHECKS) {
      const raw = resolveFg(check.key, idx)
      if (raw == null || raw.length !== 7) continue

      // invert = 把这管 token 当**背景**用（配白字）；否则当**文字**用
      let fg
      let bg
      if (check.invert) {
        fg = WHITE
        bg = parse(raw)
      } else {
        fg = parse(raw)
        bg = resolveBg(check.on, idx)
        if (!bg) continue
      }

      const ratio = contrast(fg, bg)
      const ok = ratio >= check.min
      if (!ok) failures += 1
      rows.push({
        theme: `${grade}/${sat}`,
        key: check.invert ? `${check.key}(填充)` : check.key,
        on: check.on,
        value: raw,
        ratio: Number(ratio.toFixed(2)),
        min: check.min,
        ok
      })
    }
  }
}

const bad = rows.filter((r) => !r.ok)
console.log(`检查 ${rows.length} 项 — 达标 ${rows.length - bad.length}，不达标 ${bad.length}`)

if (bad.length) {
  console.log('\n✗ 不达标：')
  for (const r of bad) {
    console.log(
      `  ${r.theme.padEnd(20)} ${r.key.padEnd(16)} on ${r.on.padEnd(11)} ${r.value}  ${r.ratio}:1 < ${r.min}`
    )
  }
}

console.log('\n各组最差项：')
for (const grade of grades) {
  for (const sat of sats) {
    const t = `${grade}/${sat}`
    const group = rows.filter((r) => r.theme === t)
    if (!group.length) continue
    const worst = group.reduce((a, b) => (a.ratio <= b.ratio ? a : b))
    console.log(
      `  ${worst.ok ? '✓' : '✗'} ${t.padEnd(20)} ${worst.key.padEnd(16)} ${String(worst.ratio).padStart(5)}:1  (下限 ${worst.min})`
    )
  }
}

if (strict && bad.length) {
  console.error(`\n严格模式：${bad.length} 项不达标`)
  process.exit(1)
}
