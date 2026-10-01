/**
 * 卡片玻璃光效（2026-09-30 设计执行报告 §4.4）的单测。
 *
 * 两层：
 *   1. **纯函数**（直接 import composables/useCardShine.ts，不挂 DOM）：四角内凹的
 *      衰减曲线与近边强度都是「指针位置 → 数字」的确定性映射，最适合逐条钉死；
 *      边界（角上 / FALLOFF 外 / 卡外负坐标）是最容易在调参时被悄悄改坏的地方。
 *   2. **源码守卫**（读文件断言）：光效的六条纪律里，能被静态判据钉住的五条 ——
 *      高光色必须从 --k12-accent 经 color-mix 派生（学段换肤自动跟随）、hover 态
 *      必须包在精确指针媒体查询里、减动效门不能被后人删掉、命名不许与 .k12-glass
 *      串台、性能红线（不用 backdrop-filter / will-change）。
 *
 * 写法照 tests/visual-edges.test.ts 的源码守卫：**先剥注释再扫** —— 本仓的注释
 * 刻意引用坏写法（「不叫 .k12-glass」「不用 backdrop-filter」），扫整份源码会把
 * 说明书当成实现（那条纪律在 animation-extension.test.ts 里已经踩过一次）。
 *
 * ⚠️ 被测模块与 base.css 光效段由 S1/S2 落地；未落地时本文件会红，属暂时状态。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC_SHARED = new URL('../src/shared/', import.meta.url)

/**
 * 渲染进程的模块按 Vite 的口味写相对导入（不带扩展名），Node ESM 要求显式扩展名。
 * 这个 hook 只给「相对且没写扩展名」的说明符补 .ts，并补 @shared 别名。
 *
 * ⚠️ 被测模块必须用**动态 import**：ESM 把静态 import 提到模块顶部，
 *    而 hook 是在那之后才注册的。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      return { url: new URL(specifier.slice('@shared/'.length) + '.ts', SRC_SHARED).href, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.ts', '/index.ts']) {
          const candidate = new URL(specifier + suffix, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
      }
      throw error
    }
  }
})

const { cornerDent, edgeProximity } = await import('../src/renderer/src/composables/useCardShine.ts')

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_CSS_PATH = 'src/renderer/src/assets/base.css'
const SHINE_TS_PATH = 'src/renderer/src/composables/useCardShine.ts'

/** 读一份仓库内文本，并把 CRLF 归一成 LF（切片锚点在 CRLF 里会错位）。 */
function readText(relativePath: string): string {
  return readFileSync(join(DESKTOP_ROOT, ...relativePath.split('/')), 'utf8').split('\r\n').join('\n')
}

/**
 * 剥掉注释（**手写状态机，不用正则**）：本文件里要写不少含反斜杠的正则，
 * 再叠一层转义很容易写出「看着对、其实没剥干净」的 helper。
 * HTML / 块注释 / 行注释三种形态都处理。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    out += source[i]
    i += 1
  }
  return out
}

/** 从某个 '{' 起取到配对的 '}'（用于「这条规则/这个媒体块里有什么」）。 */
function blockAt(source: string, openIndex: number): string {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex, i + 1)
    }
  }
  return source.slice(openIndex)
}

/**
 * base.css 里的**光效段**：从定义 --k12-shine-* 的那个 :root 起，
 * 到下一个「EP 细节对齐」段（或文件末尾）为止。
 * 用途：只在这一段里判「有没有 backdrop-filter / will-change / k12-glass」——
 * 文件别处的 .k12-glass 本来就合法。
 */
function shineSectionOf(css: string): string {
  const anchor = css.indexOf('--k12-shine-')
  if (anchor < 0) return ''
  const rootStart = css.lastIndexOf(':root', anchor)
  if (rootStart < 0) return ''
  const ep = css.indexOf('EP 细节对齐', rootStart)
  if (ep <= rootStart) return css.slice(rootStart)
  const commentEnd = css.lastIndexOf('*/', ep)
  return css.slice(rootStart, commentEnd > rootStart ? commentEnd : ep)
}

/** 浮点近似比较（衰减曲线里有 hypot 与除法）。 */
function closeTo(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    message + '（实得 ' + actual + '，期望 ' + expected + '）'
  )
}

/* ================================================================== *
 * ① 纯函数：cornerDent（四角内凹）
 * ================================================================== */

test('cornerDent：角上封顶 12、FALLOFF(120) 外归零、半程 3px', () => {
  assert.equal(cornerDent(0, 0, 0, 0), 12, '指针正好在角上（距离 0）应得 MAX_DENT=12')
  assert.equal(cornerDent(120, 0, 0, 0), 0, '距离正好等于 FALLOFF(120) 时衰减到 0')
  assert.equal(cornerDent(200, 0, 0, 0), 0, '超过 FALLOFF 仍是 0（不会变成负数）')
  closeTo(cornerDent(60, 0, 0, 0), 3, '距离 60（一半）应得 12 × (1 − 0.5)² = 3')
  assert.ok(
    cornerDent(30, 0, 0, 0) > cornerDent(90, 0, 0, 0),
    '越靠近角凹得越多（二次衰减必须单调不增）'
  )
})

test('cornerDent：只与到角的距离有关 —— 四角同一相对位置结果相同', () => {
  // 400×300 的卡：指针 (30,40) 到左上角距离 = 50；指针 (370,260) 到右下角距离 = 50
  closeTo(
    cornerDent(30, 40, 0, 0),
    cornerDent(370, 260, 400, 300),
    '四个角共用同一套公式：同一相对位置必须得到同一个凹量'
  )
  closeTo(
    cornerDent(10, 20, 0, 0),
    cornerDent(10, -20, 0, 0),
    '公式只吃距离：y 取正负但距离相同时凹量相同'
  )
  // 每个角都在自己的角点取到最大值（四角对称的锚点）
  assert.equal(cornerDent(0, 0, 0, 0), 12, '左上角')
  assert.equal(cornerDent(400, 0, 400, 0), 12, '右上角')
  assert.equal(cornerDent(400, 300, 400, 300), 12, '右下角')
  assert.equal(cornerDent(0, 300, 0, 300), 12, '左下角')
})

test('cornerDent：负坐标 / 卡外坐标一律夹在 [0, MAX_DENT]', () => {
  const coordinates = [-1000, -50, -1, 0, 30, 119, 121, 500, 1000]
  const corners: ReadonlyArray<[number, number]> = [
    [0, 0],
    [400, 0],
    [400, 300],
    [0, 300]
  ]
  for (const px of coordinates) {
    for (const py of coordinates) {
      for (const [cx, cy] of corners) {
        const dent = cornerDent(px, py, cx, cy)
        assert.ok(
          // 12 = composable 里的 MAX_DENT（2026-09-30 用户裁决从 5 上调；这里跟着改）
          dent >= 0 && dent <= 12,
          '凹量越界：cornerDent(' + px + ',' + py + ',' + cx + ',' + cy + ') = ' + dent + '（应在 0..12）'
        )
      }
    }
  }
})

/* ================================================================== *
 * ② 纯函数：edgeProximity（近边强度）
 * ================================================================== */

test('edgeProximity：贴边得 1、离边 64px 归零、大卡中心得 0', () => {
  assert.equal(edgeProximity(0, 150, 400, 300), 1, '贴着左边缘 = 1')
  assert.equal(edgeProximity(400, 150, 400, 300), 1, '贴着右边缘 = 1')
  assert.equal(edgeProximity(200, 0, 400, 300), 1, '贴着上边缘 = 1')
  assert.equal(edgeProximity(200, 300, 400, 300), 1, '贴着下边缘 = 1')
  assert.equal(edgeProximity(64, 150, 400, 300), 0, '离最近边缘 64px 时归零')
  assert.equal(edgeProximity(200, 150, 400, 300), 0, '400×300 的卡中心离四边都 ≥64 → 0')
  closeTo(edgeProximity(32, 150, 400, 300), 0.5, '离边 32px（一半）应得 0.5')
})

test('edgeProximity：负坐标 / 卡外坐标一律夹在 [0, 1]', () => {
  assert.equal(edgeProximity(-50, 10, 200, 100), 1, '卡外（负 x）夹到上限 1，而不是 >1')
  assert.equal(edgeProximity(500, 10, 200, 100), 1, '卡外（x 大于宽）同样夹到 1')
  const coordinates = [-999, -1, 0, 200, 201, 999]
  for (const px of coordinates) {
    for (const py of coordinates) {
      const strength = edgeProximity(px, py, 200, 100)
      assert.ok(
        strength >= 0 && strength <= 1,
        '近边强度越界：edgeProximity(' + px + ',' + py + ') = ' + strength + '（应在 0..1）'
      )
    }
  }
})

/* ================================================================== *
 * ③ 源码守卫（五条）
 * ================================================================== */

test('守卫：--k12-shine-bright 从 --k12-accent 经 color-mix 派生，且只定义一次', () => {
  const css = readText(BASE_CSS_PATH)
  assert.match(
    css,
    /--k12-shine-bright:\s*color-mix\(in srgb,\s*var\(--k12-accent\)/,
    '高光色必须从 --k12-accent 经 color-mix 派生（学段切换自动换色），实得光效段缺失或写死色值'
  )
  assert.doesNotMatch(
    css,
    /--k12-shine-[a-z-]+:\s*rgba?\(/,
    '光效令牌不许写死 rgba(...) —— 写死了学段换肤就不跟随（与 --k12-shadow-* 同一条纪律）'
  )
  // P-158：同一自定义属性两处定义会被后加载的静默覆盖 —— 每个 --k12-shine-* 只许定义一次
  const definitions = css.match(/--k12-shine-[a-z-]+\s*:/g) ?? []
  const counts = new Map<string, number>()
  for (const definition of definitions) {
    const name = definition.split(':')[0].trim()
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  assert.ok(counts.size >= 3, 'base.css 里应有光效令牌定义（radius / edge / bright / shade / wash）')
  for (const [name, count] of counts) {
    assert.equal(count, 1, name + ' 在 base.css 里定义了 ' + count + ' 次（P-158：两处定义会被静默覆盖）')
  }
})

test('守卫：.k12-shine:hover::before 的 opacity 规则包在精确指针媒体查询里', () => {
  const code = stripComments(readText(BASE_CSS_PATH))
  const media = '@media (hover: hover) and (pointer: fine)'
  const rule = '.k12-shine:hover::before'
  let insideMedia = 0
  let cursor = code.indexOf(media)
  while (cursor >= 0) {
    const open = code.indexOf('{', cursor)
    const block = open >= 0 ? blockAt(code, open) : ''
    if (block.includes(rule)) {
      insideMedia += 1
      assert.match(block, /opacity:\s*1/, rule + ' 的 opacity 必须是 1（只在悬停时亮）')
    }
    cursor = code.indexOf(media, cursor + 1)
  }
  const occurrences = code.split(rule).length - 1
  assert.ok(occurrences >= 1, 'base.css 里找不到 ' + rule + '（光效的悬停规则没了）')
  assert.equal(
    insideMedia,
    occurrences,
    '每条 ' + rule + ' 都必须落在 @media (hover: hover) and (pointer: fine) 里（触屏 / 粗指针不该出效果）'
  )
})

test('守卫：useCardShine 必须读 useReducedMotion（防减动效门被删）', () => {
  const code = stripComments(readText(SHINE_TS_PATH))
  assert.ok(
    code.includes("from './useReducedMotion'") || code.includes("from './useReducedMotion.ts'"),
    'useCardShine 必须从 ./useReducedMotion 导入减动效有效值（JS 驱动的 rAF 收不进 CSS 的 reduce 媒体查询）'
  )
  assert.match(code, /useReducedMotion\(\)/, '必须真的调用 useReducedMotion()（只 import 不用等于没门）')
})

test('守卫：useCardShine 签名是 (el, enabled?) —— enabled 缺省视为开启（冻结接口 v1）', () => {
  const code = stripComments(readText(SHINE_TS_PATH))
  assert.match(
    code,
    /export function useCardShine\([^)]*enabled\?:[^)]*\)/,
    '签名必须是 (el, enabled?)：接入方开关缺省为 true（SurfacePanel 的 shine prop 靠它挂/摘监听）'
  )
})

test('守卫：命名不串台 —— 光效实现里不许出现 k12-glass', () => {
  const implementations: ReadonlyArray<[string, string]> = [
    ['useCardShine.ts', stripComments(readText(SHINE_TS_PATH))],
    ['base.css 光效段', stripComments(shineSectionOf(readText(BASE_CSS_PATH)))]
  ]
  for (const [label, code] of implementations) {
    assert.ok(
      !code.includes('k12-glass'),
      label + ' 里出现了 k12-glass —— 那是 backdrop-filter 毛玻璃类，两个效果会串台'
    )
  }
})

test('守卫（红线）：base.css 光效段不许用 backdrop-filter / will-change', () => {
  const section = stripComments(shineSectionOf(readText(BASE_CSS_PATH)))
  assert.ok(section.length > 0, 'base.css 里找不到光效段（--k12-shine-* 尚未落地）')
  assert.ok(
    !section.includes('backdrop-filter'),
    '光效段出现 backdrop-filter —— 昂贵且 .k12-glass 语义已占用（报告 §3 明确禁用）'
  )
  assert.ok(
    !section.includes('will-change'),
    '光效段出现 will-change —— 会常驻合成层，卡片多的页面吃显存（报告 §5 红线 7）'
  )
})

/* ================================================================== *
 * ④ 集成守卫：SurfacePanel 的 scoped 复合规则必须与 base.css 逐字同源
 * ================================================================== */

/**
 * ★★ 为什么必须钉这一条（2026-09-30 真机集成缺陷）：
 *   SurfacePanel 是 **scoped 样式**，.sf--r-card 编译后会带上 [data-v-…]，
 *   特异度 0,2,0；而 base.css 的 .k12-shine 是单类 0,1,0 —— 特异度高者赢，
 *   于是 base.css 那条「基础圆角 + 四角内凹」的 border-radius **被既有静态圆角整条盖住**：
 *   边缘高光照常亮，四角内凹却一下都不会发生（肉眼极难发现）。
 *   处置是纯新增一条复合规则把公式抬到同等特异度；两处公式必须**逐字同源**，
 *   否则那边改了这边不改，缺陷会静默复发。
 */

/** 从 <style> 块取内容（避免把 script 里的 JS 花括号当成 CSS 规则解析）。 */
function vueStyleBlock(source: string): string {
  const open = source.indexOf('<style')
  if (open < 0) return ''
  const bodyStart = source.indexOf('>', open)
  const close = source.indexOf('</style>', bodyStart)
  return source.slice(bodyStart + 1, close < 0 ? source.length : close)
}

/** 解析出一批「选择器 + 规则体」（含媒体块内层规则）。 */
function cssRules(source: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = []
  let i = 0
  let preludeStart = 0
  while (i < source.length) {
    if (source[i] === '{') {
      rules.push({ selector: source.slice(preludeStart, i).trim(), body: blockAt(source, i) })
      preludeStart = i + 1
      i += 1
      continue
    }
    if (source[i] === '}') preludeStart = i + 1
    i += 1
  }
  return rules
}

/** 找选择器列表里**恰好包含**该选择器的第一条规则（精确匹配，避免 .sf--r-inset 误配复合规则）。 */
function ruleWithSelector(
  rules: Array<{ selector: string; body: string }>,
  selector: string
): { selector: string; body: string } | null {
  for (const rule of rules) {
    if (rule.selector.split(',').map((part) => part.trim()).includes(selector)) return rule
  }
  return null
}

/** 直接按选择器找规则体（要求选择器后只有空白再接 '{'，用于 base.css 的 .k12-shine）。 */
function ruleBodyBySelector(source: string, selector: string): string | null {
  let from = 0
  while (true) {
    const at = source.indexOf(selector, from)
    if (at < 0) return null
    const rest = source.slice(at + selector.length)
    const open = rest.indexOf('{')
    if (open >= 0 && rest.slice(0, open).trim() === '') return blockAt(source, at + selector.length + open)
    from = at + selector.length
  }
}

/** 取一条声明的值（连续空白压成单空格 —— 换行排版不该让守卫变红）。 */
function declarationValue(body: string, property: string): string {
  for (const declaration of body.slice(1, -1).split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    if (declaration.slice(0, colon).trim() !== property) continue
    return declaration.slice(colon + 1).replace(/\s+/g, ' ').trim()
  }
  return ''
}

test('守卫：SurfacePanel 的 .sf--r-*.k12-shine 与 base.css 的 .k12-shine 圆角公式逐字同源', () => {
  const SURFACE_PANEL_PATH = 'src/renderer/src/components/SurfacePanel.vue'
  const baseCode = stripComments(readText(BASE_CSS_PATH))
  const panelCode = stripComments(readText(SURFACE_PANEL_PATH))
  const panelRules = cssRules(vueStyleBlock(panelCode))

  // ① base.css 那一条公式（四角 calc(基础档 + 该角内凹量)）
  const baseBody = ruleBodyBySelector(baseCode, '.k12-shine')
  assert.ok(baseBody !== null, 'assets/base.css 里找不到 .k12-shine 规则体（光效挂载点没了）')
  const baseRadius = declarationValue(baseBody, 'border-radius')
  assert.ok(
    baseRadius.includes('--k12-dent-tl') && baseRadius.includes('--k12-dent-br'),
    'assets/base.css 的 .k12-shine 必须给四角 calc(基础档 + 内凹量)，实得：' + JSON.stringify(baseRadius)
  )

  // ② 三条 scoped 复合规则：各自的值必须与 base.css 逐字相等
  const compositeSelectors = ['.sf--r-inset.k12-shine', '.sf--r-card.k12-shine', '.sf--r-control.k12-shine']
  for (const selector of compositeSelectors) {
    const rule = ruleWithSelector(panelRules, selector)
    assert.ok(
      rule !== null,
      'components/SurfacePanel.vue 里找不到 ' + selector +
        ' —— 缺了它，scoped 静态圆角（特异度 0,2,0）会整条盖住 base.css 的 .k12-shine（0,1,0），四角内凹静默失效'
    )
    const radius = declarationValue(rule.body, 'border-radius')
    assert.equal(
      radius,
      baseRadius,
      selector + ' 的 border-radius 必须与 assets/base.css 的 .k12-shine 逐字同源。\n' +
        '改了其中一处必须同步另一处（assets/base.css 与 components/SurfacePanel.vue），' +
        '否则四角内凹会静默失效（边缘高光照常亮，肉眼很难发现）。\n' +
        '实得：' + JSON.stringify(radius) + '\n' +
        '期望：' + JSON.stringify(baseRadius)
    )
  }

  // ③ 回归：三条既有基础档声明仍在（皮肤配方没被顺手删）
  const baseTiers: ReadonlyArray<[string, string]> = [
    ['.sf--r-inset', '--k12-r-inset'],
    ['.sf--r-card', '--k12-r-card'],
    ['.sf--r-control', '--k12-r-control']
  ]
  for (const [selector, token] of baseTiers) {
    const rule = ruleWithSelector(panelRules, selector)
    assert.ok(rule !== null, 'components/SurfacePanel.vue 里找不到 ' + selector + ' 基础档规则')
    assert.ok(
      declarationValue(rule.body, 'border-radius').includes('var(' + token + ')'),
      selector + ' 的 border-radius 必须仍是 var(' + token + ')（既有皮肤配方不许被顺手删/改）'
    )
  }
})

/* ================================================================== *
 * ⑤ 对话气泡：同样的效果，但幅度必须克制（2026-09-30 用户裁决）
 * ================================================================== */

test('守卫：学生气泡的 .bubble.k12-shine 与 base.css 圆角公式逐字同源（同一特异度坑）', () => {
  const CHAT_MESSAGE_PATH = 'src/renderer/src/components/ChatMessage.vue'
  const baseCode = stripComments(readText(BASE_CSS_PATH))
  const bubbleCode = stripComments(readText(CHAT_MESSAGE_PATH))
  const bubbleRules = cssRules(vueStyleBlock(bubbleCode))

  const baseBody = ruleBodyBySelector(baseCode, '.k12-shine')
  assert.ok(baseBody !== null, 'assets/base.css 里找不到 .k12-shine 规则体')
  const baseRadius = declarationValue(baseBody, 'border-radius')

  // ★ 对话**两侧**都要：学生气泡 `.bubble` 与助手纸面 `.answer`（2026-09-30 用户裁决：
  //   「双方的对话都得做啊」）。两条 scoped 复合规则各自对齐自己的基础圆角档。
  const targets: ReadonlyArray<[string, string]> = [
    ['.bubble.k12-shine', 'var(--k12-r-inset)'],
    ['.answer.k12-shine', 'var(--k12-r-card)']
  ]
  for (const [selector, token] of targets) {
    const rule = ruleWithSelector(bubbleRules, selector)
    assert.ok(
      rule !== null,
      'components/ChatMessage.vue 里找不到 ' + selector + ' —— 它是 scoped（0,2,0），' +
        '会整条盖掉 base.css 单类 .k12-shine（0,1,0）的圆角，该侧的四角内凹会静默失效'
    )
    assert.equal(
      declarationValue(rule.body, 'border-radius'),
      baseRadius,
      selector + ' 的 border-radius 必须与 assets/base.css 的 .k12-shine 逐字同源，' +
        '否则四角内凹静默失效（改了其中一处必须同步另一处）'
    )
    assert.ok(
      declarationValue(rule.body, '--k12-shine-r').includes(token),
      selector + ' 的基础圆角档要跟着它自己的 ' + token + ' 走（否则光效层会改掉它的圆角）'
    )
  }
})

test('守卫：对话里的幅度必须克制（两侧都要：倾斜 ≤ 1.5°、内凹 < 卡片档）', () => {
  const code = stripComments(readText('src/renderer/src/components/ChatMessage.vue'))
  const calls = code.match(/useCardShine\([\s\S]{0,220}?\)/g) || []
  assert.ok(
    calls.length >= 2,
    '★ 用户裁决「双方的对话都得做啊」：学生气泡与助手纸面各要一次 useCardShine 调用，实得 ' +
      String(calls.length) + ' 次'
  )
  for (const call of calls) {
    const tilt = Number((call.match(/maxTilt:\s*([0-9.]+)/) || [])[1])
    const dent = Number((call.match(/maxDent:\s*([0-9.]+)/) || [])[1])
    assert.ok(
      Number.isFinite(tilt) && tilt > 0 && tilt <= 1.5,
      '★ 用户裁决：对话里倾斜要克制（1°±）。实得 maxTilt=' + String(tilt)
    )
    assert.ok(
      Number.isFinite(dent) && dent > 0 && dent < 12,
      '★ 对话里的面比卡片小，内凹幅度必须小于卡片档 12px。实得 maxDent=' + String(dent)
    )
  }
})

