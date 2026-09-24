/**
 * 全量布局体检：把每份模板渲染进浏览器，量出**真实的几何缺陷**。
 *
 * 为什么不用源码断言：重叠、溢出、越界都是「渲染结果」的属性 ——
 * 源码里 `x:34,w:154` 看着没错，但字号一缩、行数一多就压到邻居身上了。
 * 所以这里真渲染、真量 DOM。
 */
import { chromium } from 'playwright'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RENDERED = process.argv[2] || 'preset-content/_meta/rendered'
const BASE = process.argv[3] || 'http://127.0.0.1:8812'

const files = readdirSync(RENDERED).filter((f) => f.endsWith('.html') && f !== 'index.html' && f !== '_audit.html')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })

const report = []
for (const file of files) {
  await page.goto(`${BASE}/${file}`, { waitUntil: 'load' })
  // 等动画走完：阶段数与动效时长因模板而异，统一给足
  await page.waitForTimeout(7000)

  const result = await page.evaluate(() => {
    const svg = document.querySelector('#stage svg, .anim-canvas svg')
    if (!svg) return { error: 'no svg' }
    const rect = (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    const inside = (a, b) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1

    // 盒子 = 所有 k12-* 的 <g>（node / readout / bubble / actor）
    const boxEls = [...svg.querySelectorAll('g[class*="k12-"]')].filter(
      (g) => g.classList.contains('k12-node') || g.classList.contains('k12-readout') || g.classList.contains('k12-bubble')
    )
    const boxes = boxEls.map((g) => ({
      el: g,
      cls: g.getAttribute('class'),
      text: (g.textContent || '').trim(),
      rect: rect(g),
      // 盒子自己的矩形（不含文字溢出）
      own: (() => {
        const r = g.querySelector('rect')
        return r ? rect(r) : null
      })()
    }))

    // ① 盒子两两重叠（用**自己的矩形**，不算文字溢出）
    const overlaps = []
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i].own || boxes[i].rect
        const b = boxes[j].own || boxes[j].rect
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ox > 3 && oy > 3) overlaps.push({ a: boxes[i].text.slice(0, 14), b: boxes[j].text.slice(0, 14), ox: Math.round(ox), oy: Math.round(oy) })
      }
    }

    // ② 文字溢出所在盒子
    const textOverflow = []
    for (const box of boxes) {
      if (!box.own) continue
      for (const t of [...box.el.querySelectorAll('text')]) {
        const tr = rect(t)
        if (!inside(tr, box.own)) {
          textOverflow.push({ box: box.text.slice(0, 14), text: (t.textContent || '').slice(0, 16), out: Math.round(Math.max(0, box.own.x - tr.x, tr.x + tr.w - (box.own.x + box.own.w))) })
        }
      }
    }

    // ③ 空盒子（有框没字）
    const empty = boxes.filter((b) => b.text.replace(/[\s·]/g, '') === '').length

    // ④ 同一盒子里 label 与 sub 是同一句（重复显示）
    const dup = []
    for (const box of boxes) {
      const ts = [...box.el.querySelectorAll('text')].map((t) => (t.textContent || '').trim()).filter(Boolean)
      if (ts.length === 2 && ts[0] === ts[1]) dup.push(ts[0].slice(0, 18))
    }

    // ⑤ 内容越出舞台安全区
    const svgRect = rect(svg)
    const outside = []
    for (const box of boxes) {
      const r = box.rect
      if (r.x < svgRect.x - 2 || r.y < svgRect.y - 2 || r.x + r.w > svgRect.x + svgRect.w + 2 || r.y + r.h > svgRect.y + svgRect.h + 2) {
        outside.push(box.text.slice(0, 14))
      }
    }

    // ⑥ 步骤条与内容是否重叠（步骤条是外壳 HTML，不该压到 SVG 内容）
    const chip = document.querySelector('#stage .chip, .chip')
    let chipClash = 0
    if (chip) {
      const c = rect(chip)
      for (const box of boxes) {
        const ox = Math.min(c.x + c.w, box.rect.x + box.rect.w) - Math.max(c.x, box.rect.x)
        const oy = Math.min(c.y + c.h, box.rect.y + box.rect.h) - Math.max(c.y, box.rect.y)
        if (ox > 3 && oy > 3) chipClash += 1
      }
    }

    return {
      boxCount: boxes.length,
      overlaps,
      textOverflow,
      empty,
      dup,
      outside,
      chipClash
    }
  })

  report.push({ file, ...result })
}

await browser.close()

// 汇总
const bad = report.filter((r) => r.error || r.overlaps?.length || r.textOverflow?.length || r.empty || r.dup?.length || r.outside?.length || r.chipClash)
writeFileSync(join(RENDERED, '_audit-layout.json'), JSON.stringify(report, null, 1))

console.log(`检查 ${report.length} 份，有问题 ${bad.length} 份\n`)
const tally = { overlaps: 0, textOverflow: 0, empty: 0, dup: 0, outside: 0, chipClash: 0, error: 0 }
for (const r of report) {
  if (r.error) { tally.error += 1; continue }
  tally.overlaps += r.overlaps?.length || 0
  tally.textOverflow += r.textOverflow?.length || 0
  tally.empty += r.empty || 0
  tally.dup += r.dup?.length || 0
  tally.outside += r.outside?.length || 0
  tally.chipClash += r.chipClash || 0
}
console.log('缺陷统计：', JSON.stringify(tally, null, 1))
console.log('\n前 12 份有问题的：')
for (const r of bad.slice(0, 12)) {
  const parts = []
  if (r.overlaps?.length) parts.push(`重叠×${r.overlaps.length}`)
  if (r.textOverflow?.length) parts.push(`文字溢出×${r.textOverflow.length}`)
  if (r.empty) parts.push(`空盒子×${r.empty}`)
  if (r.dup?.length) parts.push(`重复文字×${r.dup.length}`)
  if (r.outside?.length) parts.push(`越界×${r.outside.length}`)
  if (r.chipClash) parts.push(`压步骤条×${r.chipClash}`)
  if (r.error) parts.push(`错误 ${r.error}`)
  console.log(`  ${r.file}: ${parts.join(' · ')}`)
}
