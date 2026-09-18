/**
 * 布局体检探针（在浏览器里跑，把结果打回控制台）。
 *
 * 静态审计（audit-layout.mjs）只看声明，看不见渲染结果。
 * 这个探针量的是**真实几何** —— 它回答四类问题：
 *
 *   1. 溢出：元素内容比自己的盒子宽/高（scrollWidth > clientWidth），
 *      且没开滚动 → 内容被裁掉或撑破父容器
 *   2. 越界：元素跑到视口外（x < 0 或 right > 视口宽）→ 出现横向滚动条或裁切
 *   3. 叠压：同级非绝对定位元素**互相重叠**（不是父子关系）
 *   4. 纵向裁切：`overflow:hidden` 但内容更高 → 文字被切掉
 *
 * ── 怎么用 ────────────────────────────────────────────────────────────
 * 它**不是** npm script，而是手动注入的一段脚本（因为要放进真实浏览器上下文）：
 *
 *   // 起 dev server 后，在浏览器控制台粘贴本文件全文，然后：
 *   __layoutProbe()        // 返回 { viewport, count, issues: [...] }
 *
 * 配合 Playwright / chrome-devtools MCP 时可批量跑：
 *   await page.addScriptTag({ url: 'http://localhost:5273/scripts/layout-probe.js' })
 *   const r = await page.evaluate(() => window.__layoutProbe())
 *
 * **建议同时扫 1440 / 1280 / 1120 三种宽度** —— 本项目的 `#app` 有
 * `min-width: 1120px`，而媒体查询断点在 1279px，窄端是布局最容易坏的地方
 * （实测就是在这个区间发现了"hero 被强制堆成三行"）。
 *
 * ⚠️ **它自己踩过两个假阳性坑，改动时别退回去**：
 *   · 滚动容器内的内容跑到视口外是**设计**（横向胶片条、长表格），不是越界；
 *   · `colgroup` / `col` / `caption` 的盒子天然与 thead/tbody 重叠（它们不参与绘制）。
 *
 * 刻意**不报**的（否则满屏假阳性，工具就没人看了）：
 *   - 有意重叠的浮层（position: fixed/absolute）
 *   - 滚动容器本身（内容超出是设计）
 *   - 视觉隐藏元素（面积 < 4px²、visibility:hidden、opacity:0）
 *   - 带 `text-overflow: ellipsis` 的溢出（那是明确写的省略）
 */
window.__layoutProbe = function probe() {
  const VW = document.documentElement.clientWidth
  const VH = document.documentElement.clientHeight
  const issues = []

  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.opacity === '0') return false
    return true
  }

  /** 这个元素自己是不是滚动容器（那它内容超出是设计，不算溢出） */
  const isScrollContainer = (el) => {
    const cs = getComputedStyle(el)
    return /auto|scroll/.test(cs.overflowX) || /auto|scroll/.test(cs.overflowY)
  }
  /** 祖先里有没有滚动容器（有的话裁切是设计） */
  const hasScrollAncestor = (el) => {
    let p = el.parentElement
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      if (/auto|scroll|hidden/.test(cs.overflowX) || /auto|scroll|hidden/.test(cs.overflowY)) return true
      p = p.parentElement
    }
    return false
  }

  const describe = (el) => {
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28)
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` 「${txt}」` : ''}`
  }

  const walk = (el) => {
    if (!(el instanceof HTMLElement)) return
    if (!visible(el)) return

    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()

    // ── 1. 横向溢出（内容比盒子宽，且不滚动）──
    if (!isScrollContainer(el) && el.scrollWidth > el.clientWidth + 2) {
      const over = el.scrollWidth - el.clientWidth
      // 只在"确实裁掉了"或"真的溢出了"时报；white-space:nowrap 的省略号是设计
      const ellipsis = cs.textOverflow === 'ellipsis' && /nowrap/.test(cs.whiteSpace)
      if (!ellipsis && over >= 2) {
        issues.push({
          kind: '横向溢出',
          el: describe(el),
          detail: `内容宽 ${el.scrollWidth} > 盒子 ${el.clientWidth}（超出 ${over}px，overflow-x=${cs.overflowX}）`
        })
      }
    }

    // ── 2. 纵向溢出（高度被写死导致内容裁掉）──
    if (!isScrollContainer(el) && cs.overflowY === 'hidden') {
      const over = el.scrollHeight - el.clientHeight
      if (over >= 4) {
        issues.push({
          kind: '纵向裁切',
          el: describe(el),
          detail: `内容高 ${el.scrollHeight} > 盒子 ${el.clientHeight}（裁掉 ${over}px）`
        })
      }
    }

    // ── 3. 视口越界 ──
    // 只查 fixed/absolute 之外的常规流元素；浮层允许出界（它就是盖上去的）。
    // ⚠️ 也必须排除**滚动容器内的内容** —— 横向胶片条、长表格里的项跑到视口外
    //    正是"可以滚过去"的设计。第一版漏了这条，动画页报了 21 条假阳性
    //    （全是底部胶片条里没滚到的模板项）。
    const positioned = cs.position === 'fixed' || cs.position === 'absolute'
    if (!positioned && !hasScrollAncestor(el)) {
      const right = r.right
      const left = r.left
      // 容忍 1px 亚像素
      if (right > VW + 1) {
        issues.push({
          kind: '右侧越界',
          el: describe(el),
          detail: `右边缘 ${Math.round(right)} > 视口 ${VW}（超出 ${Math.round(right - VW)}px）`
        })
      }
      if (left < -1) {
        issues.push({
          kind: '左侧越界',
          el: describe(el),
          detail: `左边缘 ${Math.round(left)} < 0`
        })
      }
    }

    // ── 4. 同级重叠（非绝对定位的兄弟互相压） ──
    // 只对"叶子级"兄弟做，避免把父子关系误判。
    // ⚠️ 排除**不参与绘制**的结构元素：`colgroup` / `col` / `caption` 的盒子天然
    //    与 thead/tbody 重叠（它们是表格列定义，不是可见的块）。第一版报了两条
    //    100% 重叠的假阳性，正是它们。
    const NOT_PAINTED = new Set(['COLGROUP', 'COL', 'CAPTION', 'THEAD', 'TBODY', 'TFOOT', 'TR'])
    const kids = Array.from(el.children).filter(
      (c) =>
        c instanceof HTMLElement &&
        !NOT_PAINTED.has(c.tagName) &&
        visible(c) &&
        !['fixed', 'absolute'].includes(getComputedStyle(c).position)
    )
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const a = kids[i].getBoundingClientRect()
        const b = kids[j].getBoundingClientRect()
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        // 重叠面积占较小者 30% 以上才算（排除亚像素/圆角相切）
        if (ox > 2 && oy > 2) {
          const area = ox * oy
          const smaller = Math.min(a.width * a.height, b.width * b.height)
          if (area > smaller * 0.3) {
            issues.push({
              kind: '同级叠压',
              el: `${describe(kids[i])}  ✕  ${describe(kids[j])}`,
              detail: `重叠 ${Math.round(ox)}×${Math.round(oy)}px（占较小者 ${Math.round((area / smaller) * 100)}%）`
            })
          }
        }
      }
    }

    for (const c of Array.from(el.children)) walk(c)
  }

  walk(document.body)

  // 去重（同一元素同类问题只报一次）
  const seen = new Set()
  const dedup = issues.filter((i) => {
    const k = i.kind + '|' + i.el
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return {
    viewport: `${VW}×${VH}`,
    docScrollWidth: document.documentElement.scrollWidth,
    hasHorizontalScroll: document.documentElement.scrollWidth > VW + 1,
    count: dedup.length,
    issues: dedup.slice(0, 40)
  }
}
