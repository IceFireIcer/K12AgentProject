/**
 * 对话页两栏的展开状态（左「历史对话」+ 右「上下文 / 工具 / 学段」）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 这两栏**默认收起**（2026-09-22 定案），各有一个开关弹出。三条纪律，每条都对应
 * 一种「看起来只是不好用、其实会丢状态」的缺陷：
 *
 * 1. ★★ **默认必须是收起**：判错方向的代价不对称 —— 默认展开只是多一屏噪声，
 *    而默认收起被误改成展开，就等于这次调整没做（首屏又被两栏挤窄）。
 * 2. ★★ **状态只能有一份**（`stores/panels.ts`）：组件里再存一份 `ref(true)`，
 *    就会出现「顶栏开关收了、右栏自己的 X 还在亮」这类**自相矛盾**的界面 ——
 *    与学段 / 章节那两处入口是同一条纪律（`chat.setGrade` / `chat.setChapter`）。
 * 3. ★★ **收起时内层要 `display: none`**，不是只裁剪宽度：裁剪出来的子元素仍有
 *    236px 的矩形，而体检脚本按「渲染后的矩形」判可见性（`w > 0 && h > 0`）——
 *    看不见的东西会被量进「学生能点的元素」，产生假红（历史上真发生过，见 ux-audit 的注释）。
 *
 * ★ 冷启动/持久化：localStorage（与 `stores/viewMode.ts` 同一理由 —— 纯界面偏好，
 *   不进 `config.json`、不新增 IPC 通道）。读不到就回默认，且绝不抛（读偏好失败
 *   不该让整个应用白屏）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const read = (rel: string): string => readFileSync(join(DESKTOP, rel), 'utf8')

const PANELS_STORE = 'src/renderer/src/stores/panels.ts'
const CHAT_VIEW = 'src/renderer/src/views/Chat.vue'
const SESSION_LIST = 'src/renderer/src/components/SessionList.vue'

/* ------------------------------------------------------------------ *
 * 1. ★★ 默认收起（纯函数 + 常量）
 * ------------------------------------------------------------------ */

test('★★ 两栏的默认状态是【收起】（`PANEL_DEFAULT_OPEN === false`）', async () => {
  const mod = await import('../src/renderer/src/stores/panels.ts')
  assert.equal(
    mod.PANEL_DEFAULT_OPEN,
    false,
    '★★ 默认必须是**收起**：对话页是打开应用的第一屏，首屏要读的是开场引导与输入框，' +
      '而不是「以前聊过什么」和「检索依据」（那两栏加起来 536px 的固定开销会把主列挤窄）'
  )
  assert.equal(mod.HISTORY_OPEN_STORAGE_KEY, 'k12.historyOpen')
  assert.equal(mod.RAIL_OPEN_STORAGE_KEY, 'k12.railOpen')
})

test('★ 没有存过偏好 → 回默认；`1`/`0` 才认（手改的、别的应用写的都不认）', async () => {
  const mod = await import('../src/renderer/src/stores/panels.ts')
  const original = (globalThis as { localStorage?: unknown }).localStorage
  try {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => (key === 'k12.railOpen' ? '1' : null)
    }
    assert.equal(mod.readStoredPanel(mod.RAIL_OPEN_STORAGE_KEY), true, "存过 '1' → 展开")
    assert.equal(mod.readStoredPanel(mod.HISTORY_OPEN_STORAGE_KEY), false, '没存过 → 默认（收起）')

    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => 'true'
    }
    assert.equal(
      mod.readStoredPanel(mod.RAIL_OPEN_STORAGE_KEY),
      false,
      "只认 '1'：'true' / 'yes' 这类值一律回默认（不猜）"
    )

    // localStorage 抛（file:// + 某些沙箱组合）→ 回默认，绝不冒泡
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      }
    }
    assert.equal(
      mod.readStoredPanel(mod.RAIL_OPEN_STORAGE_KEY),
      false,
      '★ 读偏好失败必须静默回默认 —— 读不到一个界面偏好不该让整个应用白屏'
    )
  } finally {
    if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else (globalThis as { localStorage?: unknown }).localStorage = original
  }
})

test('★ 开关写盘（学生自己动手 → 记住；断点自动收起 → 不覆盖偏好）', () => {
  const source = read(PANELS_STORE)
  assert.match(source, /writeStoredPanel\(HISTORY_OPEN_STORAGE_KEY, open\)/, '左栏开关要落盘')
  assert.match(source, /if \(options\.persist !== false\) writeStoredPanel\(RAIL_OPEN_STORAGE_KEY, open\)/, '右栏开关要落盘（可跳过）')
  // ★★ 断点自动收起必须走 `persist: false`：那不是学生的选择，不该覆盖偏好。
  const chat = read(CHAT_VIEW)
  assert.match(
    chat,
    /panels\.setRail\(false, \{ persist: false \}\)/,
    '★★ 窄屏自动收起不许落盘 —— 否则「在窄窗口里用过一次」就等于把偏好改成了收起，宽屏上再也回不来'
  )
  assert.match(chat, /panels\.setRail\(true, \{ persist: false \}\)/, '★ 离开窄屏的还原同样不落盘')
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 状态只有一份（组件与 store）
 * ------------------------------------------------------------------ */

test('★★ 右栏状态只在 store 里：`Chat.vue` 不许自己 `ref(true)` 一份', () => {
  const source = read(CHAT_VIEW)
  assert.match(source, /const railOpen = computed\(\(\) => panels\.railOpen\)/, '右栏状态要从 store 读')
  assert.match(source, /const historyOpen = computed\(\(\) => panels\.historyOpen\)/, '左栏状态要从 store 读')
  assert.doesNotMatch(
    source,
    /const railOpen = ref\(/,
    '★★ 不许在组件里再存一份 `railOpen = ref(...)` —— 两份状态就是「一处收了另一处还亮着」，' +
      '而那种矛盾在界面上表现为「点了没反应」（与学段/章节两处入口同一条纪律）'
  )
  // 开关与右栏自己的 X 必须落到同一处（store），不能各写一份
  assert.match(source, /const panels = usePanelsStore\(\)/, '必须用 panels store')
  assert.match(source, /<ContextRail :open="railOpen" @update:open="setRailOpen" \/>/, '右栏的开关要显式绑定 store')
  assert.doesNotMatch(source, /v-model:open="railOpen"/, '★ 不能对只读 computed 用 v-model（写值会失败）')
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 收起机制：整列不参与布局、也不参与量测
 * ------------------------------------------------------------------ */

test('★★ 左栏收起时内层 `display: none`（不是只裁剪宽度）', () => {
  const source = read(CHAT_VIEW)
  assert.match(
    source,
    /\.chat__side--closed :deep\(\.sl\) \{\s*display: none;\s*\}/,
    '★★ 收起的列必须 `display: none`：`overflow: hidden` 只是裁剪，子元素仍有 236px 的矩形 —— ' +
      '体检脚本按「渲染后的矩形」判可见性，看不见的东西会被量进「学生能点的元素」'
  )
  assert.match(
    source,
    /<div class="chat__side" :class="\{ 'chat__side--closed': !historyOpen \}">/,
    '左栏必须包在可折叠外壳里'
  )
  // ★★ 不许用 `v-if` 收起：SessionList 挂着两个 watcher（列表刷新）与 onMounted 的首次取数，
  //    卸载后学生在折叠状态下切了会话，再展开看到的是**旧快照**（看起来像「没保存」）。
  assert.doesNotMatch(
    source,
    /<SessionList v-if=/,
    '★★ 不许用 `v-if` 收起历史对话列 —— 它会连 watcher 一起卸载（折叠期间切会话后，展开看到的是旧列表）'
  )
})

test('★ 两个开关都在（左端 / 右端各一枚），且都有可读标题与 `aria-pressed`', () => {
  const source = read(CHAT_VIEW)
  const historyAt = source.indexOf('data-testid="history-toggle"')
  const railAt = source.indexOf('data-testid="rail-toggle"')
  assert.ok(historyAt > 0, '找不到左栏开关')
  assert.ok(railAt > 0, '找不到右栏开关')
  const historyBlock = source.slice(historyAt, historyAt + 400)
  const railBlock = source.slice(railAt, railAt + 400)
  for (const [label, block] of [
    ['左栏', historyBlock],
    ['右栏', railBlock]
  ] as const) {
    assert.match(block, /:title="[^"]*(收起|展开)/, `${label}开关要有「收起 / 展开」的可读标题（图标按钮没有文字）`)
    assert.match(block, /:aria-pressed=/, `${label}开关要有 \`aria-pressed\`（屏幕阅读器要知道当前是开还是关）`)
  }
  // 左开关在工具条的**左端**：它排在「本轮对话」标题之前
  assert.ok(
    historyAt < source.indexOf('class="chat__bar-title"'),
    '★ 左栏开关要在会话工具条的最左端（挨着它控制的那一列），而不是挤在右边'
  )
})

test('★ 左栏的开关真的连到 store（不是只切了个本地 class）', () => {
  const source = read(CHAT_VIEW)
  assert.match(source, /function toggleHistory\(\): void \{\s*panels\.toggleHistory\(\)/, '左栏开关要调 store')
  assert.match(source, /@click="toggleHistory"/, '按钮要绑到那个函数')
})

/* ------------------------------------------------------------------ *
 * 4. ★ 那行提示语已经删掉（票 5）
 * ------------------------------------------------------------------ */

test('★ 历史对话列底部那行提示语已删除（连同它的两条 CSS）', () => {
  const source = read(SESSION_LIST)
  assert.doesNotMatch(
    source,
    /不跨学生共用/,
    '★ 「点一条就能接着聊。对话存在你自己的目录里，不跨学生共用。」这句要删掉（2026-09-22 要求）'
  )
  assert.doesNotMatch(source, /sl__hint/, '★ 已经没有这个元素了，样式也该一并删掉（不留死 CSS）')
})
