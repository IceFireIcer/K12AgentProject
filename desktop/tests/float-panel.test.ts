/**
 * 悬浮追问窗守门（2026-09-27）。
 *
 * 为什么需要它：这只窗（`components/FloatPanel.vue`）**曾经完全没有入口** ——
 * store 里的 `openFrom` / `openPanel` 一个调用者都没有，于是它只在你手动触发
 * store 时才出得来。真机走查问的第一句就是「这个窗怎么打开？」。
 * 组件树、样式、日志全都正常，**没有任何一条既有断言会发现"没人能打开它"** ——
 * 这类缺陷不属于"逻辑错"，属于"接线漏了"，只能由一条**接线断言**兜住。
 *
 * 判据三条（都读源码，不需要真机）：
 *   ① 入口：至少有一个 `.vue` 真的调用 `floatPanel.openFrom(...)`（不是只 import）；
 *   ② 出口：窗自己有折叠与关闭两个控件（关得掉、收得起）；
 *   ③ 回得来：折叠态必须换一个**不同的图标**（原地留减号 = 学生找不到"放大回来"的地方）。
 *
 * ⚠️ 同样的接线缺陷在 `views/Chat.vue` 里也发生过一次（那只「只读机制浮窗」
 *    在演示档之外没有入口）—— 那条入口由 `tests/demo-mode.test.ts` 管。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const R = 'src/renderer/src'

/** 递归收集 `.vue` 源文件（排除生成物与 node_modules）。 */
function vueSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      vueSources(full, out)
    } else if (name.endsWith('.vue')) out.push(full)
  }
  return out
}

const vueFiles = vueSources(join(desktopRoot, R))
const read = (full: string): string => readFileSync(full, 'utf8')
const panel = read(join(desktopRoot, R, 'components/FloatPanel.vue'))

test('★★ 悬浮追问窗必须有真实入口（有调用点，不只是定义了 openFrom）', () => {
  // 找「谁调用了 openFrom / toggleFrom / openPanel」——**排除 store 自己与面板自己**：
  // store 里是定义、面板里只用 open/close/toggleCollapsed，都不算入口。
  const callers = vueFiles
    .filter((f) => !f.endsWith('FloatPanel.vue'))
    .filter((f) => {
      const source = read(f)
      return /floatPanel\.(openFrom|toggleFrom|openPanel)\(/.test(source)
    })
    .map((f) => f.slice(desktopRoot.length + 1).replaceAll('\\', '/'))

  assert.ok(
    callers.length > 0,
    '没有任何组件调用 floatPanel.openFrom / toggleFrom / openPanel —— 这只窗学生打不开（历史上真发生过）'
  )
})

test('悬浮窗能收起、能关闭，且收起后**换图标**（找得到放大回来的地方）', () => {
  // ① 折叠与关闭两个控件都在，且都落到 store 的真实动作上
  assert.match(panel, /floatPanel\.toggleCollapsed\(\)/, '折叠按钮必须真的切折叠态')
  assert.match(panel, /floatPanel\.close\(\)/, '关闭按钮必须真的关窗')
  // ② 两条路径都要留出稳定锚点（探针与守卫按它们找控件）
  assert.match(panel, /data-testid="float-panel-toggle"/, '折叠/展开按钮要有 data-testid')
  assert.match(panel, /data-testid="float-panel-close"/, '关闭按钮要有 data-testid')
  // ③ ★ 折叠态必须换图标：原地留 Minus 的话，学生找不到"放大回来"的地方
  assert.match(
    panel,
    /floatPanel\.collapsed\s*\?\s*ChevronUp\s*:\s*Minus/,
    '折叠态的按钮必须换成"展开"语义的图标（ChevronUp），不能还是 Minus'
  )
  assert.match(panel, /from 'lucide-vue-next'[\s\S]{0,120}ChevronUp|ChevronUp[\s\S]{0,120}from 'lucide-vue-next'/, 'ChevronUp 必须真的被 import（否则模板里是空图标）')
})

/* ------------------------------------------------------------------ *
 * 2026-09-27 走查抓到的三个真缺陷（用户实测，逐个钉住）
 * ------------------------------------------------------------------ */

test('★★ 标题栏拖动必须放过可交互子元素（否则 X / 最小化点不动）', () => {
  // 根因：`setPointerCapture` 会把后续指针事件**全部重定向到捕获元素**（标题栏），
  // 子按钮上的 click 永不触发 —— 表现就是「X 点不动、最小化没反应」。
  // `.stop` 挡不住它（那是点击冒泡，不是指针重定向）。
  assert.match(
    panel,
    /function isInteractive[\s\S]{0,300}?closest\('button, input, textarea, select, a\[href\]'\)/,
    '标题栏拖动必须先排除可交互子元素（否则按钮被指针捕获吃掉）'
  )
  assert.match(
    panel,
    /function onPointerDown[\s\S]{0,400}?if \(isInteractive\(e\.target\)\) return/,
    'onPointerDown 必须在可交互子元素上直接返回（不进拖拽、不捕获指针）'
  )
})

test('★★ 窗高必须与内容脱钩：显式高度 + 内部滚动 + 夹紧发生在 store', () => {
  // 根因：`style` 此前只给 width，窗高完全由内容决定 —— 追问几轮就长到出屏。
  assert.match(panel, /height: `\$\{floatPanel\.size\.h\}px`/, '窗必须显式给高度（不能由内容撑）')
  assert.match(
    panel,
    /\.fp__body\s*\{[\s\S]{0,200}?overflow-y:\s*auto/,
    '正文区必须自己滚动 —— 高度固定后内容只能在这里滚，不能把窗撑长'
  )

  const store = read(join(desktopRoot, R, 'stores/floatPanel.ts'))
  // 夹紧必须发生在 store（不靠调用方自觉）：面积比例 + 围栏 + 绝对下限三档都要在
  assert.match(store, /function clampSize[\s\S]{0,400}?MIN_SIZE\.w/, 'clampSize 必须含绝对下限')
  assert.match(store, /function clampSize[\s\S]{0,900}?fence\.w - MARGIN \* 2/, 'clampSize 必须含围栏上限')
  // 位置夹紧不能只在"用户拖过窗"时才做（那正是"没拖过就出围栏"的成因）
  assert.match(
    store,
    /const base = pos\.value \?\? defaultPos\(\)/,
    'setSize 必须把"默认落点"实体化后再夹位置（否则没拖过的窗一拉大就出围栏）'
  )
})

test('悬浮窗可改大小：右下角有手柄，且手柄走真实拖拽路径', () => {
  assert.match(panel, /data-testid="float-panel-resize"/, '要有可拖拽的改大小手柄')
  assert.match(panel, /floatPanel\.setSize\(/, '手柄必须真的调 setSize')
  assert.match(panel, /function onResizeMove[\s\S]{0,300}?e\.pointerId !== resizing\.pointerId/, '改大小必须按 pointerId 过滤（否则多指针会打架）')
})

test('入口按钮是**开关**：再点一次要能收起（不能只开不关）', () => {
  // 用户实测：「点了一次弹出来，再点一次居然关不掉」—— 入口必须走 toggle。
  // ★ 必须**逐个入口**查（三页各有一个）：只断言"某处用了 toggleFrom"的话，
  //   把其中一个入口改回 openFrom 仍然能过（变异 116 实测过这条弱点）。
  const entries = ['views/Animation.vue', 'views/Coding.vue', 'views/Quiz.vue']
  for (const file of entries) {
    const source = read(join(desktopRoot, R, file))
    assert.match(
      source,
      /floatPanel\.toggleFrom\(/,
      `${file} 的入口必须用 toggleFrom（openFrom 只开不关，而按钮看起来是开关）`
    )
    assert.doesNotMatch(
      source,
      /floatPanel\.openFrom\(/,
      `${file} 不许直接调 openFrom —— 那会让这个入口只开不关（三个入口都要是开关）`
    )
  }

  const store = read(join(desktopRoot, R, 'stores/floatPanel.ts'))
  // ★★ 判据必须带 kind：三页入口常常指向同一个知识点（标题相同），只比 title 时
  //   「切页后点新入口」会被判成"再点一次"而把窗关掉（真机实测过）。
  assert.match(
    store,
    /function toggleFrom[\s\S]{0,400}?subject\.value\?\.kind === next\.kind && subject\.value\?\.title === next\.title/,
    'toggleFrom 的判据必须是"同一个 kind 且同一个对象才关"（否则切页点入口会误关窗）'
  )
  // 清空追问记录的 watcher 同样要带 kind（否则换了页却留着上一页的问法）
  assert.match(
    panel,
    /watch\([\s\S]{0,300}?floatPanel\.subject\?\.kind[\s\S]{0,120}?floatPanel\.subject\?\.title/,
    '换对象清空记录的 watcher 必须同时看 kind 与 title（只比 title 会在同知识点跨页时漏清）'
  )
})

/* ------------------------------------------------------------------ *
 * 2026-09-27 用户裁决的三条几何纪律
 * ------------------------------------------------------------------ */

test('★★ 只在「动手试试」三页存在：清单必须与 PAGES 的那一组完全一致', () => {
  const store = read(join(desktopRoot, R, 'stores/floatPanel.ts'))
  const ui = read(join(desktopRoot, R, 'stores/ui.ts'))

  // ① 声明必须存在，且逐字是那三页
  const declared = /export const FLOAT_PANEL_PAGES = \[([^\]]+)\]/.exec(store)
  assert.ok(declared !== null, 'store 必须显式声明 FLOAT_PANEL_PAGES（它决定这只窗能在哪些页出现）')
  const pages = declared[1].split(',').map((s) => s.trim().replaceAll("'", ''))

  // ② 与 PAGES 里 section === '动手试试' 的那一组**完全一致**（两边同改才过）
  const group = [...ui.matchAll(/(\w+):\s*\{[^}]*?section:\s*'动手试试'/g)].map((m) => m[1])
  assert.deepEqual(
    pages.slice().sort(),
    group.slice().sort(),
    `FLOAT_PANEL_PAGES（${pages.join('/')}）与侧栏「动手试试」组（${group.join('/')}）不一致 —— ` +
      '两个清单必须同时改（前者是可达范围，后者是学生看到的入口分组）'
  )

  // ③ 离开不在清单里的页必须关窗（挂在外壳上不会自己消失）
  assert.match(store, /function closeIfPageDisallowed[\s\S]{0,300}?FLOAT_PANEL_PAGES[\s\S]{0,120}?close\(\)/, '离开允许页面时必须关窗')
  assert.match(store, /function initPageFence[\s\S]{0,400}?watch\(/, '必须有一个 watch 盯着 ui.page（否则切页后窗还留着）')
  const panel = read(join(desktopRoot, R, 'components/FloatPanel.vue'))
  assert.match(panel, /floatPanel\.initPageFence\(\)/, '面板挂载时必须启动页面围栏')
})

test('★★ 围栏 = 内容区：拖拽不能压到顶栏（窗口按钮）或侧栏（导航）', () => {
  const store = read(join(desktopRoot, R, 'stores/floatPanel.ts'))

  // ① 围栏取 `.shell__content`（顶栏与侧栏都在它之外）
  assert.match(
    store,
    /querySelector\('\.shell__content'\)/,
    '围栏必须取内容区 `.shell__content` —— 取整个视口会把窗放到顶栏/侧栏上（挡住窗口按钮 = 关都关不掉）'
  )
  // ② 夹紧的边界来自围栏，而不是 window.innerWidth/innerHeight
  assert.match(store, /function clampPos[\s\S]{0,600}?fence\.x \+ fence\.w - size\.value\.w/, '位置夹紧必须用围栏算右边界')
  assert.match(store, /function clampPos[\s\S]{0,700}?fence\.y \+ fence\.h - size\.value\.h/, '位置夹紧必须用围栏算下边界')
  // ③ 拖动路径必须走 store 的夹紧版 moveTo（组件不许自己算边界）
  const panel = read(join(desktopRoot, R, 'components/FloatPanel.vue'))
  assert.match(panel, /function onPointerMove[\s\S]{0,400}?floatPanel\.moveTo\(/, '拖动必须调 store 的 moveTo')
  assert.doesNotMatch(
    panel,
    /window\.innerWidth - w - m/,
    '组件里不许自己算拖拽边界（围栏只有 store 一处真相）'
  )
})

test('★★ 缩放面积按主窗口取比例：≥15%、≤45%', () => {
  const store = read(join(desktopRoot, R, 'stores/floatPanel.ts'))
  const min = /const MIN_AREA_RATIO = ([\d.]+)/.exec(store)
  const max = /const MAX_AREA_RATIO = ([\d.]+)/.exec(store)
  assert.ok(min !== null, 'store 必须声明面积下限 MIN_AREA_RATIO')
  assert.ok(max !== null, 'store 必须声明面积上限 MAX_AREA_RATIO')
  assert.equal(Number(min[1]), 0.15, '面积下限必须是 15%（用户裁决）')
  assert.equal(Number(max[1]), 0.45, '面积上限必须是 45%（用户裁决）')

  // 比例必须真的作用在**主窗口面积**上（不是围栏、不是某个边长）
  assert.match(store, /function windowArea[\s\S]{0,200}?window\.innerWidth \* window\.innerHeight/, '比例的分母必须是主窗口面积')
  assert.match(store, /const minArea = MIN_AREA_RATIO \* area/, '下限必须按面积算')
  assert.match(store, /const maxArea = MAX_AREA_RATIO \* area/, '上限必须按面积算')

  // 绝对下限仍然兜底（小窗口下 15% 会小到放不下内容——两条下限取更严的）
  assert.match(store, /const MIN_SIZE = \{ w: 300, h: 240 \}/, '必须保留绝对下限（面积比例在小窗口下会小于内容所需）')
})
