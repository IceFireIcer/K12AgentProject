/**
 * 探针公共库（优化报告 §5.3 的 WP-15：结构化锚点 / 自检 / 隔离 / 截图 / axe 类规则）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这一份
 * ---------------------------------------------------------------------------
 * 2026-09-27 那轮真机体检里，五条"红"没有一条是产品缺陷 —— 全是**锚点腐烂**：
 * 组件改了结构 / 改名，探针还在按旧选择器找元素，于是报"渲染不出来"，
 * 而真相是"探针找错了"。这份库把三件事从"每个探针各自发挥"变成"一个实现"：
 *
 *   ① **结构化锚点**：`{ id, selector, attribute?, expected?, description }` ——
 *      探针开跑之前先自检一遍（缺锚点 → 显式报"部分失败"，而不是把失配算成产品红）；
 *   ② **隔离**：探针会往 localStorage / DOM 里写东西（偏好、探针元素），
 *      跑完要能干净地还原（否则"连续两次跑结果不一致"）；
 *   ③ **失败截图**：红了要留现场（`{name}.png`），否则只能靠复现。
 *
 * ★ 页面侧的检查写成**字符串脚本**（`*_SCRIPT`）：探针通过 CDP 的
 *   `Runtime.evaluate` 注入，不在 Node 侧碰 DOM（与既有探针同一手法）。
 * ★ 锚点表是**唯一真相**：`probe-anchors.test.ts`（单测）扫它 + 探针脚本里的静态
 *   `data-testid`，两边合起来挡住"探针找了一个不存在的锚点"。
 */

/**
 * 结构化锚点（报告 §5.3 的接口形状：id / selector / attribute / expected / description）。
 *
 * ⚠️ `selector` 用 `data-probe-id`（结构锚点）或既有 `data-testid`；
 *    `attribute` + `expected` 用来量**行为**（题数 / 展开态 / 折叠态），
 *    不给"量行为"的那些锚点省略这两项（那是 D12 的范围：只给量行为的锚点加 data-probe-*）。
 */
export const ANCHORS = [
  {
    id: 'quiz-default-single',
    selector: '[data-probe-id="quiz-card"]',
    attribute: 'data-probe-count',
    expected: '1',
    description: '对话内练习卡默认只渲染 1 道题（报告 §2.3）'
  },
  {
    id: 'progress-detached',
    selector: '[data-probe-id="progress-detached"]',
    attribute: null,
    expected: null,
    description: '闯关进度卡由消息层独立渲染（不嵌在题卡里）'
  },
  {
    id: 'citation-collapsed',
    selector: '[data-probe-id="citation-disclosure"]',
    attribute: 'data-probe-expanded',
    expected: 'false',
    description: '教材引用默认收起（点一下才展开）'
  },
  {
    id: 'session-fold-aria',
    selector: '[data-probe-id="session-fold"]',
    attribute: 'aria-expanded',
    expected: null,
    description: '会话折叠箭头的展开态由 aria-expanded 表达（值取决于当前树）'
  },
  {
    id: 'settings-motion-block',
    selector: '[data-testid="settings-motion-block"]',
    attribute: null,
    expected: null,
    description: '设置页有「减少动效」三档'
  },
  {
    id: 'chat-turn',
    selector: '[data-testid="chat-turn"]',
    attribute: null,
    expected: null,
    description: '对话轮次（所有对话页断言的地基）'
  }
]

function anchorListJson() {
  return JSON.stringify(
    ANCHORS.map((anchor) => ({
      id: anchor.id,
      selector: anchor.selector,
      attribute: anchor.attribute,
      expected: anchor.expected,
      description: anchor.description
    }))
  )
}

/**
 * 页面侧锚点自检脚本（探针在开跑之前 `evaluate` 它一次）。
 *
 * 返回 `{ checked, missing, mismatched }`：
 *   · `missing`：选择器在页面上找不到（这一条锚点指向的东西不在——可能不在本页）；
 *   · `mismatched`：找到了，但 `attribute` 与 `expected` 对不上（**行为**不符）。
 *
 * ★ 两者都不直接判"产品红"：探针据此打「部分失败」（报告 §5.3 的原文口径）。
 */
export const VERIFY_ANCHORS_SCRIPT = `(() => {
  const anchors = ${anchorListJson()}
  const missing = []
  const mismatched = []
  let checked = 0
  for (const anchor of anchors) {
    const el = document.querySelector(anchor.selector)
    if (!el) {
      missing.push({ id: anchor.id, selector: anchor.selector, description: anchor.description })
      continue
    }
    checked += 1
    if (anchor.attribute && anchor.expected !== null) {
      const value = el.getAttribute(anchor.attribute)
      if (String(value) !== String(anchor.expected)) {
        mismatched.push({
          id: anchor.id,
          attribute: anchor.attribute,
          expected: String(anchor.expected),
          actual: String(value),
          description: anchor.description
        })
      }
    }
  }
  return { checked, total: anchors.length, missing, mismatched }
})()`

/** 锚点自检结果 → 一行可读摘要（探针直接打印它）。 */
export function formatAnchorReport(report) {
  const lines = [
    `锚点自检：命中 ${report.checked}/${report.total}` +
      (report.missing.length > 0 ? `，缺失 ${report.missing.length}` : '') +
      (report.mismatched.length > 0 ? `，行为不符 ${report.mismatched.length}` : '')
  ]
  for (const item of report.missing) {
    lines.push(`  [缺锚点] ${item.id} → ${item.selector}（${item.description}）`)
  }
  for (const item of report.mismatched) {
    lines.push(
      `  [行为不符] ${item.id} → ${item.attribute}=${item.actual}（期望 ${item.expected}；${item.description}）`
    )
  }
  return lines.join('\n')
}

/**
 * 探针隔离：把"这一轮探针自己写进去的东西"清干净。
 *
 * · localStorage：只清探针**明确列出的键**（不 clear 整个库 —— 那会把学生自己的偏好删掉）；
 * · DOM：移除探针注入的元素（`data-probe-injected`）。
 *
 * ★ 与"重载页面"是两件事：重载解决的是渲染层状态（store / 滚动），这里解决的是
 *   持久化状态（localStorage）与注入物。两条一起用才是完整的隔离。
 */
export const CLEANUP_SCRIPT = (storageKeys) => `(() => {
  const keys = ${JSON.stringify(storageKeys)}
  const removed = []
  for (const key of keys) {
    try {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key)
        removed.push(key)
      }
    } catch (e) {}
  }
  const injected = document.querySelectorAll('[data-probe-injected]')
  for (const el of injected) el.remove()
  return { removedKeys: removed, removedNodes: injected.length }
})()`

/**
 * 失败截图（`Page.captureScreenshot` → PNG 文件）。
 *
 * ★ 只在失败时调用：一次真机体检动辄几十张截图，全存会把仓库搞脏
 *   （产物落在 `.probe-artifacts/`，已加进 `.gitignore`）。
 */
export async function captureFailureScreenshot(cdp, name, dir) {
  try {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${name}.png`)
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  } catch {
    return null
  }
}

/**
 * axe 类规则集（报告 §6.4 的「CI 集成 axe-core 自动化测试」的**自研等价物**）。
 *
 * 三类，与报告点名的键盘 / 语义 / 对比度一一对应：
 *   ① `no-focusable-hidden`：`aria-hidden` 的子树里不许有可聚焦元素（读屏死区）；
 *   ② `interactive-name`：可交互元素必须有可读名字（文字 / aria-label / title）；
 *   ③ `text-contrast`：带 `data-testid` 且直接含文字的元素，前景/背景对比度 ≥4.5:1
 *      （背景透明时向上找第一个不透明的祖先底色）。
 *
 * ★ 为什么自研而不是引 axe-core：本仓的体积纪律（渲染进程零新增依赖）是真约束，
 *   而这三类规则覆盖的正是报告点名的风险面（全量 axe 的规则集远超这里能维护的范围）。
 */
export const A11Y_SCRIPT = `(() => {
  const problems = []
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
  }
  const name = (el) =>
    (el.getAttribute('aria-label') || '').trim() ||
    (el.getAttribute('title') || '').trim() ||
    (el.innerText || '').trim() ||
    (el.getAttribute('alt') || '').trim()

  // ① 键盘：aria-hidden 子树里的可聚焦元素
  for (const host of document.querySelectorAll('[aria-hidden="true"]')) {
    const focusable = host.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    for (const el of focusable) {
      if (visible(el)) problems.push({ rule: 'no-focusable-hidden', target: el.tagName.toLowerCase(), detail: '在 aria-hidden 子树里却可聚焦' })
    }
  }

  // ② 语义：可交互元素要有名字
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (!visible(el)) continue
    if ((el.getAttribute('aria-hidden') || '') === 'true') continue
    if (name(el) === '') problems.push({ rule: 'interactive-name', target: (el.getAttribute('data-testid') || el.tagName.toLowerCase()), detail: '可交互元素没有可读名字' })
  }

  // ③ 对比度：带 data-testid 的文字元素
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value || '')
    if (!m) return null
    const parts = m[1].split(',').map((x) => Number.parseFloat(x))
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null
    const alpha = parts.length >= 4 ? parts[3] : 1
    return { r: parts[0], g: parts[1], b: parts[2], a: alpha }
  }
  const lum = (c) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); const hi = Math.max(l1, l2); const lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05) }
  const bgOf = (el) => {
    let node = el
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c && c.a > 0.5) return c
      node = node.parentElement
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  for (const el of document.querySelectorAll('[data-testid]')) {
    const direct = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0)
    if (!direct || !visible(el)) continue
    if ((el.getAttribute('aria-hidden') || '') === 'true') continue
    const fg = parse(getComputedStyle(el).color)
    if (!fg) continue
    const value = ratio(fg, bgOf(el))
    if (value < 4.5) {
      problems.push({ rule: 'text-contrast', target: el.getAttribute('data-testid') || '', detail: '对比度 ' + value.toFixed(2) + ':1（要求 ≥4.5）' })
    }
  }
  return problems.slice(0, 20)
})()`
