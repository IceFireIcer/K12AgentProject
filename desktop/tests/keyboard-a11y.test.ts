/**
 * 键盘可达性守卫：优化报告 §3.1（键盘可达性系统审计）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 报告的执行计划三条：① 补键盘可达（列表项 / SVG 节点 / 卡片 / 跳转链接 / Shift+Tab）；
 * ② 统一 `focus-visible`；③ 自动化（守卫 + 真机脚本）。
 *
 * 为什么用**正向清单**而不是"扫描所有 @click 元素"的启发式：
 *   后者在 Vue 模板上必然假红（`@click` 可以写在 `<el-button>`、`<label>`、
 *   以及带 `role="button"` 的自绘元素上），而假红会逼人放宽判据 ——
 *   最终变成一条永远通过的断言。所以这里逐项钉「报告点名的那几处交互元素」，
 *   每条都能回答"它凭什么可以被键盘操作"。
 *
 * 跑法：`npm test`；真机由 `scripts/ux-keyboard.mjs`（键盘走通一条链）验证。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')
const R = 'src/renderer/src'

/* ------------------------------------------------------------------ *
 * 1. 跳到主内容（Tab 的第 0 站）
 * ------------------------------------------------------------------ */

test('★★ 「跳到主内容」链接必须在 Tab 顺序最前，且真的把焦点送进内容区', () => {
  const shell = read(...`${R}/layouts/AppShell.vue`.split('/'))

  const skipIndex = shell.indexOf('class="skip-link"')
  const sidebarIndex = shell.indexOf('<AppSidebar')
  assert.ok(skipIndex > 0, 'AppShell 里必须有「跳到主内容」链接（优化报告 §3.1）')
  assert.ok(sidebarIndex > 0 && skipIndex < sidebarIndex, '跳转链接必须在侧栏**之前**（Tab 的第一个落点）')
  assert.match(shell, /<a class="skip-link" href="#k12-content">跳到主内容<\/a>/, '链接文案与锚点必须写死且可读')

  // 目标容器：有 id（锚点） + tabindex="-1"（锚点跳转后焦点真的落进去）
  const contentIndex = shell.indexOf('class="shell__content"')
  assert.ok(contentIndex > 0, '找不到内容区容器 .shell__content')
  const contentTag = shell.slice(Math.max(0, contentIndex - 320), contentIndex + 160)
  assert.match(contentTag, /id="k12-content"/, '内容区必须有 id="k12-content" 作为跳转目标')
  assert.match(contentTag, /tabindex="-1"/, '内容区必须 tabindex="-1"，否则锚点跳转只滚动、焦点仍在链接上')

  // 聚焦时必须显形（否则键盘用户看不到自己 Tab 到了哪儿）
  assert.match(shell, /\.skip-link\s*\{[\s\S]{0,600}?clip-path:\s*inset\(50%\)/, '平时用 clip-path 隐藏（不能 display:none）')
  assert.match(shell, /\.skip-link:focus-visible\s*\{[\s\S]{0,120}?clip-path:\s*none/, '聚焦时必须显形')
})

/* ------------------------------------------------------------------ *
 * 2. 统一的 focus-visible 基线
 * ------------------------------------------------------------------ */

test('★★ 全站 focus-visible 基线存在，且颜色走 token', () => {
  const css = read(...`${R}/assets/base.css`.split('/'))
  assert.match(css, /\*:focus-visible\s*\{/, '必须有一条低特异度的全局 focus-visible 基线（报告 §3.1）')
  const block = css.slice(css.indexOf('*:focus-visible {'), css.indexOf('*:focus-visible {') + 200)
  assert.match(block, /outline:\s*2px\s+solid\s+var\(--k12-accent\)/, '焦点环颜色必须走 token（随学段变）')
  assert.match(block, /outline-offset:\s*2px/, '焦点环要留出偏移，避免贴着边框看不清')
})

/* ------------------------------------------------------------------ *
 * 3. 报告点名的三处"自绘交互元素"必须键盘可达
 * ------------------------------------------------------------------ */

test('★★ SVG 图谱节点：role + tabindex + aria-label + Enter/Space 一个都不能少', () => {
  const map = read(...`${R}/study/map/GraphMap.vue`.split('/'))
  assert.match(map, /role="button"/, '图谱节点要声明 role=button')
  assert.match(map, /tabindex="0"/, '图谱节点必须能 Tab 到')
  assert.match(map, /:aria-label="labelOf\(node\)"/, '每个节点要有读屏名字（知识点中文名，不是 slug）')
  assert.match(map, /:aria-pressed="on \? 'true' : 'false'"/, '选中态要能被读屏读出来')
  assert.match(map, /@keydown\.enter\.prevent="emit\('select', node\.kpId\)"/, 'Enter 必须等价于点击')
  assert.match(map, /@keydown\.space\.prevent="emit\('select', node\.kpId\)"/, 'Space 必须等价于点击')

  // 读屏名字的来源不能是内部 id（slug 会泄露到 a11y 层）
  const labelFn = /function labelOf\([\s\S]{0,400}?\n\}/.exec(map)?.[0] ?? ''
  assert.ok(labelFn.length > 0, '找不到 labelOf（图谱节点的读屏名字来源）')
  assert.doesNotMatch(labelFn, /\bkpId\b\s*\}$/, 'labelOf 不许直接把 kpId 当读屏名字')
})

test('★★ 会话列表项是原生 <button>（键盘天然可达），删除入口仍走确认', () => {
  const list = read(...`${R}/components/SessionList.vue`.split('/'))
  const itemIndex = list.indexOf('class="sl__item"')
  assert.ok(itemIndex > 0, '找不到会话列表项 .sl__item')
  const itemTag = list.slice(Math.max(0, itemIndex - 120), itemIndex + 80)
  assert.match(itemTag, /<button/, '.sl__item 必须是 <button>（Tab + Enter 天然可用）')
  assert.match(list, /confirm\.ask\(/, '删除会话必须走全站唯一的确认框')
})

/* ------------------------------------------------------------------ *
 * 4. 模态：Esc 出口 + 焦点收束（含 Shift+Tab 反向循环）
 * ------------------------------------------------------------------ */

test('★★ 模态必须有 Esc + Tab 收束；非模态浮层必须有 Esc + 移入/归还（但不锁 Tab）', () => {
  /** 模态：`aria-modal="true"`，Tab 必须锁在层内。 */
  const modals: ReadonlyArray<readonly [string, string]> = [
    ['components/ConfirmDialog.vue', '确认框'],
    ['components/ChatMessage.vue', '教材原文抽屉']
  ]
  for (const [file, label] of modals) {
    const source = read(...`${R}/${file}`.split('/'))
    assert.match(source, /useEscape\(/, `${label}（${file}）必须挂 useEscape`)
    assert.match(source, /useFocusReturn\(/, `${label}（${file}）必须挂 useFocusReturn`)
  }

  /** 非模态浮层：可拖拽追问窗 / 只读机制浮窗 —— 要「移入 + 归还」，但**不锁 Tab**
   *  （学生得能一边看动画一边 Tab 回页面操作）。 */
  const nonModals: ReadonlyArray<readonly [string, string]> = [
    ['components/FloatPanel.vue', '追问浮窗'],
    ['components/DiagnosticsPanel.vue', '机制浮窗']
  ]
  for (const [file, label] of nonModals) {
    const source = read(...`${R}/${file}`.split('/'))
    assert.match(source, /useEscape\(/, `${label}（${file}）必须挂 useEscape`)
    assert.match(
      source,
      /useFocusReturn\([\s\S]{0,160}?trap:\s*false/,
      `${label}（${file}）必须挂 useFocusReturn 且显式 trap: false（非模态不锁 Tab）`
    )
    assert.doesNotMatch(source, /aria-modal="true"/, `${label}（${file}）是非模态浮层，不许声明 aria-modal`)
  }

  const focus = read(...`${R}/composables/useFocusReturn.ts`.split('/'))
  assert.match(focus, /e\.shiftKey/, '焦点循环必须显式处理 Shift+Tab（报告 §3.1 的执行计划）')
  assert.match(focus, /key !== 'Tab'/, '循环只接管 Tab 键，别吞掉其它按键')
  assert.match(focus, /options\.trap !== false/, 'trap: false 时必须真的不接管 Tab（否则非模态浮窗会锁住焦点）')
})

test('★ 真机键盘探针存在且判据齐全（报告 §3.1 执行计划第三条）', () => {
  const script = join(desktopRoot, 'scripts', 'ux-keyboard.mjs')
  assert.ok(existsSync(script), '缺 scripts/ux-keyboard.mjs —— 键盘可达不能只靠源码守卫，要有真机走通')
  const source = readFileSync(script, 'utf8')
  assert.match(source, /skip-link|跳到主内容/, '探针要断言第一站是「跳到主内容」')
  assert.match(source, /掉回 body|BODY/, '探针要断言焦点不掉回 body')
  assert.match(source, /Escape/, '探针要验 Esc 之后焦点仍在文档内')
  assert.match(source, /process\.exit\(findings\.length === 0 \? 0 : 1\)/, '探针必须有可用的退出码（CI/人工跑都能判读）')
})
