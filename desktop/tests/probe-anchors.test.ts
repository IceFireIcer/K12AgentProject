/**
 * 探针锚点自检：优化报告 §5.3（探针维护性改进）的"自动锚点验证"。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（P-147 的机器化防线）
 * ---------------------------------------------------------------------------
 * 2026-09-27 那轮真机体检里，五条"红"没有一条是产品缺陷 —— 全是**探针锚点腐烂**：
 * 组件改了结构/改名，探针还在按旧选择器找元素，于是报出"渲染不出来"，
 * 而真相是"探针找不到它自己该找的东西"。
 *
 * 本守卫把这件事提前到单测里：**探针脚本里出现的静态 `data-testid` 必须真的存在于
 * 渲染层源码**。动态锚点（`quiz-question-${n}` 这类）不在判据内 —— 它们由模板拼出来，
 * 文本层面无法穷举，交由真机探针自己校验。
 *
 * 跑法：`npm test`（纯源码扫描，不需要真机）。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 探针脚本（会去页面里找元素的那批）。 */
const PROBE_SCRIPTS = [
  'verify-ui.mjs',
  'ux-audit.mjs',
  'ux-pages-audit.mjs',
  'ux-layout-audit.mjs',
  'ux-scroll-attribution.mjs',
  'ux-student-view-scan.mjs',
  'ux-probe-demo.mjs'
]

function rendererText(): string {
  const files = readdirSync(join(desktopRoot, 'src', 'renderer', 'src'), {
    withFileTypes: true,
    recursive: true
  })
    .filter((entry) => entry.isFile() && /\.(vue|ts)$/.test(entry.name))
    .map((entry) => {
      const parent =
        (entry as unknown as { parentPath?: string }).parentPath ??
        (entry as unknown as { path?: string }).path ??
        'src/renderer/src'
      return readFileSync(join(parent, entry.name), 'utf8')
    })
  return files.join('\n')
}

test('★★ 探针里的静态 data-testid 全部真的存在于渲染层（锚点腐烂的机器防线）', () => {
  const renderer = rendererText()
  const missing: string[] = []
  const checked = new Set<string>()
  /**
   * **否定锚点**：探针故意去找"不该存在"的东西。
   * 它们必须**不存在**于渲染层，否则那条断言就成了空转。
   */
  const NEGATIVE_ANCHORS: ReadonlyArray<readonly [string, string]> = [
    ['grade-notice', 'D-083：顶栏那两张浮动提示已经删掉，探针断言它不再出现'],
    ['grade-notice-detail', '同上（提示详情那半）'],
    ['grade-selector', '旧世界的学段选择器遗物：探针断言它不存在（学段只有一个 store 入口）'],
    ['grade-option', '同上（旧的选择项）']
  ]
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  for (const script of PROBE_SCRIPTS) {
    let source = ''
    try {
      source = readFileSync(join(desktopRoot, 'scripts', script), 'utf8')
    } catch {
      continue // 脚本被删/改名时跳过（不把"探针没了"算成锚点腐烂）
    }
    for (const matched of stripComments(source).matchAll(/data-testid="([a-z0-9-]+)"/gi)) {
      const id = matched[1] ?? ''
      // 动态锚点（带 ${} 的）已经在正则里被排除：它们不含引号内的纯静态形态。
      if (id.length === 0) continue
      checked.add(id)
      const negative = NEGATIVE_ANCHORS.find(([name]) => name === id)
      const exists = renderer.includes(`data-testid="${id}"`)
      if (negative !== undefined) {
        if (exists) missing.push(`${script} → ${id} 是**否定锚点**（${negative[1]}），但它居然还存在于渲染层`)
        continue
      }
      if (!exists) missing.push(`${script} → ${id}`)
    }
  }

  assert.ok(checked.size > 20, `扫描到的锚点太少（${checked.size} 个）—— 说明探针脚本或判据本身失效了`)
  assert.deepEqual(
    missing,
    [],
    '这些锚点只在探针里存在、渲染层已经找不到（探针会报"渲染不出来"，而真相是它找错了）：\n' +
      missing.join('\n')
  )
})
