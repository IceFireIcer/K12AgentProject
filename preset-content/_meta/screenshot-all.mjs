/**
 * 批量截图：对 _meta/rendered/*.html 在 3 个时间点截图（产物落 _meta/shots/，已被 .gitignore 挡住）。
 * 用法：node preset-content/_meta/screenshot-all.mjs
 */
import { chromium } from 'playwright'
import { readdir, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HTML_DIR = join(__dirname, 'rendered')
const SHOT_DIR = join(__dirname, 'shots')
const VIEW = { width: 720, height: 520 }

await mkdir(SHOT_DIR, { recursive: true })
const files = (await readdir(HTML_DIR)).filter((f) => f.endsWith('.html') && f !== 'index.html')
console.log('pages', files.length)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: VIEW })
const report = []

for (const file of files) {
  const id = file.replace(/\.html$/, '')
  const url = 'file://' + join(HTML_DIR, file).replace(/\\/g, '/')
  const errors = []
  page.removeAllListeners('pageerror')
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(url, { waitUntil: 'load' })
  // 起始帧
  await page.screenshot({ path: join(SHOT_DIR, `${id}-0.png`) })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(SHOT_DIR, `${id}-1.png`) })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: join(SHOT_DIR, `${id}-2.png`) })

  // 几何检查：SVG 子元素是否超出 viewBox
  const overflow = await page.evaluate(() => {
    const problems = []
    for (const svg of document.querySelectorAll('svg[viewBox]')) {
      const vb = svg.viewBox.baseVal
      for (const el of svg.querySelectorAll('text,rect,circle,line,path')) {
        let bb
        try {
          bb = el.getBBox()
        } catch {
          continue
        }
        if (!bb || (bb.width === 0 && bb.height === 0)) continue
        const pad = 2
        if (
          bb.x < vb.x - pad ||
          bb.y < vb.y - pad ||
          bb.x + bb.width > vb.x + vb.width + pad ||
          bb.y + bb.height > vb.y + vb.height + pad
        ) {
          problems.push({
            tag: el.tagName,
            text: (el.textContent || '').slice(0, 20),
            bbox: [bb.x, bb.y, bb.width, bb.height].map((n) => Math.round(n * 10) / 10),
            viewBox: [vb.x, vb.y, vb.width, vb.height],
          })
        }
      }
    }
    // 文本重叠（同 svg 内 text 两两）
    const texts = [...document.querySelectorAll('svg text')].map((el) => {
      const bb = el.getBBox()
      return { el, bb, t: (el.textContent || '').trim() }
    })
    const overlaps = []
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].bb
        const b = texts[j].bb
        if (!a.width || !b.width) continue
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        if (ox > 4 && oy > 4) {
          overlaps.push([texts[i].t.slice(0, 12), texts[j].t.slice(0, 12), Math.round(ox), Math.round(oy)])
        }
      }
    }
    return { overflow: problems, overlaps }
  })

  report.push({ id, errors, ...overflow })
  console.log(id, 'overflow', overflow.overflow.length, 'overlaps', overflow.overlaps.length, 'jsErr', errors.length)
}

await writeFile(join(SHOT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
await browser.close()

const bad = report.filter((r) => r.errors.length || r.overflow.length || r.overlaps.length)
console.log('---')
console.log('clean', report.length - bad.length, 'flagged', bad.length)
for (const r of bad) {
  console.log(r.id, JSON.stringify({ err: r.errors, ov: r.overflow.slice(0, 3), ol: r.overlaps.slice(0, 3) }))
}
