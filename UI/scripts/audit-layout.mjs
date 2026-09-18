#!/usr/bin/env node
/**
 * 布局审计：每页的「骨架指纹」+ 焦点断言。
 *
 * ── 它度量什么（以及**不**度量什么）──────────────────────────────────────
 * 本脚本是**静态**分析：读 `.vue` 的 `<template>` 与 scoped `<style>`，
 * 把 `var(--k12-fs-*)` 解析成 px，统计每页的结构特征。
 *
 * ⚠️ 它**不是**渲染度量：不算真实布局、不解析继承、不看窗口宽度。
 *    它度量的是「这一页声明了什么样的骨架」，用于回答一个具体问题 ——
 *    **12 个页面里有没有一大半长得一样**。真实渲染由人工实拍核验（阶段 E4）。
 *
 * 之所以坚持静态：结果确定、无需浏览器、可在 CI 里跑，不会因为窗口尺寸或
 * 字体加载时序产生假失败。**测不准的地方宁可说测不准，也不硬凑一个指标。**
 *
 * ── 三个输出 ───────────────────────────────────────────────────────────
 *  1. 骨架指纹：每页的 (grid 档数 / 卡片数 / 字号集合) → 分组
 *     目标：12 页不再有 9 页同指纹（允许最多 4 页同类：三个规格页 + 404）
 *  2. 焦点断言：页面的**最大字号**必须 ≥ 22px（身份行），
 *     且顶栏 chrome（15px）必须严格小于它 —— 否则"外壳压着内容"
 *  3. 字号档位越界：11px 只允许出现在角标语义的类名上
 *
 * 退出码：有问题 → 1（可接入 npm run check）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'src'
const VIEW_DIRS = ['src/views/app', 'src/views/system', 'src/views/dev', 'src/views']

/** 顶栏 chrome 的字号（写死在这里是**故意的**：它是被断言的对象，不能自我参照） */
const CHROME_PX = 15
/** 身份行必须达到的字号 */
const IDENTITY_PX = 22

// ── 1. 解析字号 token ──────────────────────────────────────────────────
function readFontTokens() {
  const css = readFileSync(join(ROOT, 'styles/base.css'), 'utf8')
  const map = {}
  for (const m of css.matchAll(/--(k12-fs-[a-z0-9-]+)\s*:\s*(\d+)px/g)) map[`--${m[1]}`] = Number(m[2])
  return map
}

const FS = readFontTokens()

/** 把一处 font-size 取值解析成 px（解析不了返回 null，绝不猜） */
function toPx(value, localVars) {
  let v = String(value).trim()

  // var(--k12-fs-sm) / var(--pa-size, 14px)：取出变量名，必要时用回退值
  const varMatch = v.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/i)
  if (varMatch) {
    const [, name, fallback] = varMatch
    if (localVars[name] != null) return localVars[name]
    if (FS[name] != null) return FS[name]
    if (fallback != null) return toPx(fallback, localVars)
    return null
  }

  if (localVars[v] != null) return localVars[v]
  if (FS[v] != null) return FS[v]
  const px = v.match(/^(\d+(?:\.\d+)?)px$/)
  if (px) return Number(px[1])
  const rem = v.match(/^(\d+(?:\.\d+)?)rem$/)
  if (rem) return Number(rem[1]) * 16
  if (/^calc\(/.test(v)) {
    // calc(12px + 2px) 这类简单加法
    const parts = [...v.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
    if (parts.length) return parts.reduce((a, b) => a + b, 0)
  }
  return null
}

// ── 2. 拆出 <template> / <style> ───────────────────────────────────────
/** 去掉 CSS 注释：否则注释会粘进选择器名，报出读不懂的定位（实测踩到过） */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 返回两份 style：`style` 已剥注释（用于解析选择器），`styleRaw` 保留注释。
 *
 * ⚠️ 为什么要两份：`k12-mark` 标注**写在注释里**，而解析选择器又必须先剥注释。
 *    第一版只返回剥过的那份，于是 `k12-mark` 断言永远匹配不到 ——
 *    **契约里承诺的出路是失效的**（两个并行代理各自独立撞上并报告了这个 bug）。
 *    凡「例外要靠注释表达」的设计，都要确认注释在被读的那一刻还在。
 */
function split(file) {
  const src = readFileSync(file, 'utf8')
  const tpl = src.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
  const styleRaw = src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? ''
  return { src, tpl, styleRaw, style: stripComments(styleRaw) }
}

/** 从 scoped style 里取出每个选择器的字号声明 */
function fontDecls(style) {
  // 先收本文件内的局部变量（比如 --pa-pad-y 这种不影响字号，但保持通用）
  const localVars = {}
  for (const m of style.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const px = toPx(m[2], {})
    if (px != null) localVars[m[1]] = px
  }
  const out = []
  for (const m of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ')
    const body = m[2]
    const fs = body.match(/font-size\s*:\s*([^;]+);/)
    if (!fs) continue
    const px = toPx(fs[1], localVars)
    if (px != null) out.push({ selector, px })
  }
  return out
}

/** grid 档：本页声明了几种不同的列模板 */
function gridKinds(style) {
  const kinds = new Set()
  for (const m of style.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)) {
    kinds.add(m[1].trim().replace(/\s+/g, ' '))
  }
  return kinds
}

/**
 * 版式原型 —— 本工具**最重要**的一列。
 *
 * 为什么需要它：只比对"字号集合"或"grid 档数"太平滑了 —— 任何页面只要多一个
 * 字号就变成"唯一指纹"，于是工具会报「全部唯一」，**看起来很好但什么也没证明**。
 * （我实测踩到过这个：改完地基后 12 页 12 种指纹，但那是因为我把完整字号集合
 *  塞进了指纹 —— 工具失去了鉴别力。）
 *
 * ⚠️ 第二个实测教训：分栏**不一定用 grid**。Quiz / Animation / Coding 三页都是
 *    `display:flex` + 固定宽侧栏（320px / 296px），只扫 grid 会把它们误判成"单列流"。
 *    于是同一个骨架被当成三种，工具的结论正好反了。**必须同时认 flex 分栏。**
 *
 * 真正要回答的问题只有一个：**这些页面是不是都用同一种骨架搭的**。
 */
function archetype(style, tpl) {
  const grids = [...gridKinds(style)]
  const hasTable = /<el-table\b/.test(tpl)
  const hasSidebar = /<ContextRail\b/.test(tpl)

  // ── 分栏主轴 detection ──
  // grid 写法：固定宽 + 弹性（330px minmax(0,1fr)），或不等比两栏（1.7fr 1fr）
  const gridSplit = grids.some((g) => {
    const cols = g.split(/\s+(?![^(]*\))/).filter(Boolean)
    if (cols.length !== 2) return false
    const [a, b] = cols
    const isFlex = (c) => /minmax\(0,\s*1fr\)/.test(c) || c === '1fr'
    const isFixed = (c) => /^\d+px$/.test(c)
    const isRatioLead = /^\d*\.\d+fr$/.test(a) || /^\d*\.\d+fr$/.test(b)
    return (isFixed(a) && isFlex(b)) || (isFlex(a) && isFixed(b)) || isRatioLead
  })

  /**
   * flex 写法：页根是 flex 行，且有一个**固定宽**的直接子块（侧栏 / 简报栏）。
   * 判据取 `<style>` 里 `width: NNNpx;` + `flex: none;` 同时出现在同一个规则里 ——
   * 这是"侧栏"在本项目里的固定写法（320 / 296 / 248 等）。
   */
  const flexSplit = [...style.matchAll(/\{([^{}]*)\}/g)].some((m) => {
    const body = m[1]
    return /width\s*:\s*\d+px\s*;/.test(body) && /flex\s*:\s*none\s*;/.test(body)
  })
  const rootIsFlexRow = /^\.\w+\s*\{[^{}]*display:\s*flex\s*;[^{}]*height:\s*100%/m.test(style)

  const split = gridSplit || (flexSplit && rootIsFlexRow)

  // 等分多列：等价卡片矩阵（"处处卡片"的骨架特征）
  const equalCols = grids.filter((g) => /repeat\(\s*[2-9]\s*,\s*minmax\(0,\s*1fr\)/.test(g)).length
  // 自适应填充：规格页的密排网格
  const autoFill = grids.some((g) => /auto-fill|auto-fit/.test(g))

  if (hasTable && equalCols === 0 && !split) return '表格主导'
  if (split) return '画布/工作台（分栏主轴）'
  if (autoFill) return '规格密排（auto-fill）'
  if (equalCols >= 2) return '等价卡片矩阵'
  if (equalCols === 1) return '单区 + 一条等分带'
  if (hasSidebar) return '分栏主轴'
  return '单列流'
}

/**
 * 卡片数：模板里"一块内容"的个数。
 *
 * 按**标签**数而不是按模式数 —— 早期版本用多个正则各自计数，
 * 于是 `<SurfacePanel class="card card--wide">` 被算了两次（组件名一次、class 又一次）。
 * 现在扫一遍标签，一个标签最多算一次。
 *
 * 认三种形态：共享容器组件、全局材质类、本页自己的 .card。
 */
function cardCount(tpl) {
  let n = 0
  // 匹配开标签：<Tag ...attributes...>（跳过闭合标签与注释）
  for (const m of tpl.matchAll(/<([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const tag = m[1]
    const attrs = m[2]
    if (tag === 'SurfacePanel') {
      n += 1
      continue
    }
    const cls = attrs.match(/\bclass="([^"]*)"/)?.[1] ?? ''
    // 只看容器级卡片：k12-card，或独立成词的 card（不匹配 card__head / card--wide 的后缀）
    if (/\bk12-card\b/.test(cls) || /(^|\s)card(\s|$)/.test(cls)) n += 1
  }
  return n
}

/** 本页是否有身份行（共享组件或全局类，两种写法都认） */
function hasIdentity(tpl) {
  return /<PageIdentity\b/.test(tpl) || /class="[^"]*\bk12-identity\b/.test(tpl)
}

/** 本页是否有主路径提示 */
function hasPathHint(tpl) {
  return /class="[^"]*\bk12-path\b/.test(tpl) || /:hint=/.test(tpl) || /\bhint=/.test(tpl)
}

/**
 * 11px 只落在「角标语义」的选择器上。
 *
 * ⚠️ **实测教训（本工具的第一版判据是错的）**：
 *  最初只用英文类名词表（badge / chip / tag …）判定角标语义。结果两个真角标
 *  被判越界，被迫从 11px 升到 12px —— 而升完之后它与相邻的 meta 同权，
 *  「这是角上的一个记号」这层意思**反而被抹掉了**：
 *    · `.qz__key`  —— 选项字母 A / B / C（单个字母，装在 22×22 方框里）
 *    · `.chat__compat` —— 「跨学段兼容」（5 字 chip）
 *  也就是说，**工具的判据在逼设计做坏事**。判据错了就要改判据，不能改设计去迁就它。
 *
 * 所以改成两条路，任一成立即合规：
 *   ① 类名含角标词（覆盖大多数情况，默认-拒绝）
 *   ② 源码里显式标注 `k12-mark` —— 给"名字看不出是角标、但确实是角标"的元素一条**可 grep 的**出口。
 *      标注必须写在声明 11px 的那条规则**内部**（见下），于是它在 diff 里看得见、
 *      代码评审时会被读到 —— 而不是靠悄悄放宽词表。
 */
const BADGE_SELECTOR =
  /(badge|chip|tag|pill|count|dot|step|idx|num|counter|key|mark|level)/i

// ── 3. 收集页面 ────────────────────────────────────────────────────────
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /View\.vue$/.test(p) ? [p] : []
  })
}

/** 全部样式载体（视图 + 卡片 + 组件 + 全局 css）—— 7d 断言扫这个范围 */
function walkAll(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walkAll(p)
    return /\.(vue|css)$/.test(p) ? [p] : []
  })
}

const pages = []
for (const d of VIEW_DIRS) {
  try {
    for (const f of walk(d)) if (!pages.some((p) => p.file === f)) pages.push({ file: f })
  } catch {
    /* 目录不存在就跳过（views/dev 可能被裁掉） */
  }
}

// ── 4. 逐页分析 ────────────────────────────────────────────────────────
const rows = []
for (const page of pages) {
  const { tpl, style } = split(page.file)
  const decls = fontDecls(style)
  const grids = gridKinds(style)
  const name = relative(ROOT, page.file).replace(/\\/g, '/')

  // 身份行来自 base.css（全局），所以要额外记入本页的字号集合
  const sizes = new Set(decls.map((d) => d.px))
  if (hasIdentity(tpl)) sizes.add(IDENTITY_PX)

  const ownMax = decls.length ? Math.max(...decls.map((d) => d.px)) : 0
  const effectiveMax = Math.max(ownMax, hasIdentity(tpl) ? IDENTITY_PX : 0)

  // 11px 越界：声明了 11px 但没有一个角标语义的选择器
  const microDecls = decls.filter((d) => d.px === 11)
  const badMicro = microDecls.filter((d) => !BADGE_SELECTOR.test(d.selector))

  rows.push({
    name,
    grids: [...grids].sort(),
    archetype: archetype(style, tpl),
    cards: cardCount(tpl),
    sizes: [...sizes].sort((a, b) => b - a),
    identity: hasIdentity(tpl),
    path: hasPathHint(tpl),
    ownMax,
    effectiveMax,
    microCount: microDecls.length,
    badMicro: badMicro.map((d) => `${d.selector} (${d.px}px)`)
  })
}

// ── 5. 指纹分组 ────────────────────────────────────────────────────────
/**
 * 指纹 = 版式原型 + 卡片规模档。
 *
 * 卡片规模**分档**而不是取精确值：7 张和 8 张卡的页面在观感上是同一类问题
 * （"处处卡片"），精确值会让它们各成一档、掩盖共性。
 */
const cardBand = (n) => (n === 0 ? '0' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : '6+')
const fingerprint = (r) => `${r.archetype} · 卡片 ${cardBand(r.cards)}`

const groups = new Map()
for (const r of rows) {
  const k = fingerprint(r)
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(r.name)
}

// ── 6. 报告 ────────────────────────────────────────────────────────────
const W = (s, n) => String(s).padEnd(n)
const L = (s, n) => String(s).padStart(n)

console.log('布局审计（静态骨架指纹）')
console.log('='.repeat(96))
console.log(`${W('页面', 34)}${L('卡片', 5)}${W('  版式原型', 26)}${L('最大字号', 9)}   字号档`)
console.log('-'.repeat(96))
for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(
    `${W(r.name, 34)}${L(r.cards, 5)}${W('  ' + r.archetype, 26)}${L(r.effectiveMax ? r.effectiveMax + 'px' : '—', 9)}   ` +
      `[${r.sizes.join(', ') || '—'}]`
  )
}

console.log('\n骨架指纹分组（同组 = 结构雷同）')
console.log('-'.repeat(96))
const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
for (const [k, members] of sortedGroups) {
  console.log(`  ${members.length > 1 ? '●' : '○'} ${members.length} 页 · ${k}`)
  console.log(`      ${members.join('、')}`)
}

// ── 7. 断言 ────────────────────────────────────────────────────────────
const problems = []

/** 规格页 / 开发页 / 404 不参与「内容页」的断言：它们本来就是规格表与过渡页 */
const isSpec = (name) => /system\/|dev\/|NotFound/.test(name)
/**
 * 对话页豁免**身份行**（保留焦点与主路径断言）。
 * 理由：对话页的内容区从第一条消息起就是正文，在顶部再插一条 22px 的身份行
 * 会把阅读起点往下推。它的身份由**空态 hero**（28px「你好，…」+ 一句"这轮我们继续…"）
 * 在首屏第一时刻承担 —— 那是更合适的落点，不是遗漏。
 * ⚠️ 这是一条**写明了的例外**，不是筛掉失败用例：下面仍要求它 ≥22px 且 > 顶栏。
 */
const identityExempt = (name) => isSpec(name) || /app\/ChatView/.test(name)

// 7a. 指纹唯一性：最多 4 页同类（三个规格页 + 404 的容差）
for (const [k, members] of sortedGroups) {
  if (members.length > 4) {
    problems.push(`骨架雷同：${members.length} 页指纹相同（上限 4）—— ${members.join('、')}`)
  }
}

// 7b. 焦点断言：内容区最大字号必须 ≥ 22px 且严格大于顶栏 chrome
for (const r of rows) {
  if (isSpec(r.name)) continue
  if (r.effectiveMax < IDENTITY_PX) {
    problems.push(
      `焦点倒置：${r.name} —— 内容区最大 ${r.effectiveMax}px < ${IDENTITY_PX}px（外壳/卡片的重量盖过内容）`
    )
  } else if (r.effectiveMax <= CHROME_PX) {
    problems.push(`焦点倒置：${r.name} —— 内容区最大 ${r.effectiveMax}px ≤ 顶栏 ${CHROME_PX}px`)
  }
}

// 7c. 身份行（内容页，对话页豁免见上）
for (const r of rows) {
  if (identityExempt(r.name)) continue
  if (!r.identity) {
    problems.push(`缺身份行：${r.name} —— 顶部没有 ${IDENTITY_PX}px 的「这页在讲什么」`)
  }
}

// 7d. 11px 只在角标上 —— **全仓**（视图 + 卡片 + 组件 + 全局样式），不限视图
{
  const files = [...walkAll('src')]
  for (const file of files) {
    // ⚠️ 用 styleRaw：`k12-mark` 写在注释里，剥了注释就永远读不到（见 split 的注释）
    const { styleRaw } = split(file)
    const name = relative(ROOT, file).replace(/\\/g, '/')
    const bad = []
    for (const m of styleRaw.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2]
      if (!/font-size\s*:\s*var\(--k12-fs-micro\)/.test(body)) continue
      // 选择器本身要先剥注释，否则注释会粘进名字
      const selector = stripComments(m[1]).trim().replace(/\s+/g, ' ')
      // 两条出路：角标词表，或规则内显式标注 k12-mark
      if (BADGE_SELECTOR.test(selector)) continue
      if (/\bk12-mark\b/.test(body)) continue
      bad.push(`${selector} (11px)`)
    }
    if (bad.length) {
      problems.push(
        `11px 越界：${name} —— ${bad.length} 处既非角标语义、也无 \`k12-mark\` 标注：` +
          bad.slice(0, 3).join(' / ')
      )
    }
  }
}

// 7e. 主路径提示（内容页）
for (const r of rows) {
  if (isSpec(r.name)) continue
  if (!r.path) problems.push(`缺主路径提示：${r.name}`)
}

console.log('\n断言')
console.log('-'.repeat(96))
if (problems.length === 0) {
  console.log('  ✓ 指纹 / 焦点 / 字号档位 / 主路径提示 全部通过')
} else {
  for (const p of problems) console.log(`  ✗ ${p}`)
}

const identicalWorst = sortedGroups[0]?.[1].length ?? 0
console.log(
  `\n汇总：${rows.length} 页 · ${groups.size} 种骨架指纹 · 最大同类 ${identicalWorst} 页 · ${problems.length} 个问题`
)
process.exit(problems.length ? 1 : 0)
