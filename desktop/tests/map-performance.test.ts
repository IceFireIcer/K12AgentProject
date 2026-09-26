/**
 * 图谱与长列表性能守卫：优化报告 §5.2（WP-14）。
 *
 * ---------------------------------------------------------------------------
 * 报告的四件事与判据
 * ---------------------------------------------------------------------------
 *   ① 视口裁剪（只渲染可见节点 ±100px）→ `map/culling.ts` 的纯函数 + 渲染层真的接了它；
 *   ② LOD（zoom < 0.5 点 / < 1.0 图标 / 其余完整）→ `map/lod.ts` 的三档；
 *   ③ `>100` 节点切 Canvas → `shouldUseCanvas` + `GraphCanvas.vue`（Canvas 画 + DOM 命中层）；
 *   ④ 长列表虚拟化 → `vue-virtual-scroller` + `components/VirtualList.vue`（超过阈值才启用）。
 *
 * ★ ③ 的验收场景是**500 节点合成布局**（当前教材只有 57 个节点，Canvas 分支不会被真实数据触发）：
 *   这里用 `layoutGraph` 造 500 个节点，断言「>100 → Canvas」「裁剪后可见数 << 总数」，
 *   并在 500 节点上量一次裁剪耗时（宽松上限，防的是 O(n²) 之类的写法混进来）。
 *
 * 跑法：`npm test`（纯函数 + 源码扫描，不需要真机）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const R = 'src/renderer/src'
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

const culling = await import('../src/renderer/src/study/map/culling.ts')
const lod = await import('../src/renderer/src/study/map/lod.ts')
const layout = await import('../src/renderer/src/study/map/layout.ts')

/* ------------------------------------------------------------------ *
 * 1. ★★ 视口裁剪
 * ------------------------------------------------------------------ */

test('★★ 视口裁剪：外扩 100px，边界相接算可见，顺序不变', () => {
  assert.equal(culling.CULL_MARGIN_PX, 100, '报告原文的外扩余量就是 100px')
  const box = culling.expandViewport({ x: 100, y: 100, width: 200, height: 200 })
  assert.deepEqual(box, { x: 0, y: 0, width: 400, height: 400 }, '外扩后是 (x-100, y-100, w+200, h+200)')

  // 刚好贴边算可见（宁可多画一个，不可少画一个）
  assert.equal(
    culling.rectsIntersect(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 10, y: 0, width: 10, height: 10 }
    ),
    true,
    '边界相接算相交'
  )
  assert.equal(
    culling.rectsIntersect(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 11, y: 0, width: 10, height: 10 }
    ),
    false,
    '隔开 1px 就不算'
  )

  const items = [
    { id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'b', rect: { x: 5000, y: 5000, width: 10, height: 10 } },
    { id: 'c', rect: { x: 120, y: 120, width: 10, height: 10 } }
  ]
  const visible = culling.visibleItems(items, (item) => item.rect, { x: 0, y: 0, width: 200, height: 200 })
  assert.deepEqual(
    visible.map((item) => item.id),
    ['a', 'c'],
    '视口内 + 100px 余量内的保留，远端的裁掉，且**顺序不变**'
  )
})

test('★ 边的包围盒：两点任意方向都能算出正矩形', () => {
  assert.deepEqual(
    culling.edgeRect({ x1: 200, y1: 100, x2: 50, y2: 300 }),
    { x: 50, y: 100, width: 150, height: 200 },
    '从右下到左上也要得到正宽高的包围盒'
  )
})

/* ------------------------------------------------------------------ *
 * 2. ★★ LOD 三档 + Canvas 阈值
 * ------------------------------------------------------------------ */

test('★★ LOD：zoom < 0.5 点 / < 1.0 图标 / 其余完整（报告原文的阈值）', () => {
  assert.equal(lod.lodForZoom(0.49), 'dot')
  assert.equal(lod.lodForZoom(0.5), 'icon', '0.5 属于「图标」档（含下不含上）')
  assert.equal(lod.lodForZoom(0.99), 'icon')
  assert.equal(lod.lodForZoom(1), 'full')
  assert.equal(lod.lodForZoom(1.5), 'full')
  assert.equal(lod.lodForZoom(Number.NaN), 'full', '认不出的缩放按 1:1 处理（不抛）')
  assert.equal(lod.showsLabel('full'), true)
  assert.equal(lod.showsLabel('icon'), false)
  assert.equal(lod.showsLabel('dot'), false)
})

test('★★ Canvas 阈值：>100 节点才切（当前 57 个节点不触发）', () => {
  assert.equal(lod.CANVAS_NODE_THRESHOLD, 100)
  assert.equal(lod.shouldUseCanvas(57), false, '当前教材数据（57 节点）走 SVG')
  assert.equal(lod.shouldUseCanvas(100), false, '100 这一档还是 SVG')
  assert.equal(lod.shouldUseCanvas(101), true, '101 起走 Canvas')
  assert.ok(lod.clampZoom(99) <= 1.5 && lod.clampZoom(0) >= 0.1, '缩放要夹在合理区间')
  assert.equal(lod.fitZoom(1000, 2000), 0.5, '适应宽度 = 视口宽 / 画布宽')
  assert.equal(lod.fitZoom(1000, 0), 1, '画布宽为 0 时退回 1（不产生 Infinity）')
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 500 节点合成场景（报告点名的大数据验收）
 * ------------------------------------------------------------------ */

test('★★ 500 节点：走 Canvas + 裁剪后可视节点远小于总数 + 裁剪本身不慢', () => {
  const nodes = Array.from({ length: 500 }, (_, index) => ({
    kpId: `kp-${String(index).padStart(3, '0')}`,
    name: `知识点 ${index}`,
    chapterTitle: `第${(index % 8) + 1}章`,
    layer: index % 20,
    mastered: index % 3 === 0
  }))
  const edges = Array.from({ length: 900 }, (_, index) => ({
    fromKpId: nodes[index % 500].kpId,
    toKpId: nodes[(index * 7 + 3) % 500].kpId,
    relation: 'prerequisite'
  }))
  const built = layout.layoutGraph(nodes, edges)

  assert.equal(built.nodes.length, 500, '布局保留全部 500 个节点')
  assert.equal(lod.shouldUseCanvas(built.nodes.length), true, '500 节点 → Canvas 模式')

  const viewport = { x: 0, y: 0, width: 1128, height: 720 }
  const started = Date.now()
  const visible = culling.visibleItems(built.nodes, layout.nodeRect, viewport)
  const elapsed = Date.now() - started
  assert.ok(visible.length > 0, '视口里至少要看得见一个节点（否则这条断言是空转）')
  assert.ok(
    visible.length < built.nodes.length / 2,
    `裁剪要真的裁掉大部分节点（可见 ${visible.length} / 共 ${built.nodes.length}）`
  )
  assert.ok(elapsed < 100, `500 节点的裁剪耗时应远低于 100ms（实测 ${elapsed}ms）`)
})

/* ------------------------------------------------------------------ *
 * 4. ★★ 渲染层真的接了这些能力（纯函数再对，不接也是摆设）
 * ------------------------------------------------------------------ */

test('★★ 渲染层：SVG 接视口裁剪、MapTab 按节点数切 Canvas', () => {
  const graphMap = read(...`${R}/study/map/GraphMap.vue`.split('/'))
  assert.match(graphMap, /visibleItems\(props\.layout\.nodes, nodeRect, props\.viewport\)/, 'SVG 节点要走裁剪')
  assert.match(graphMap, /visibleItems\(props\.layout\.edges, edgeRect, props\.viewport\)/, '边也要走裁剪')
  assert.match(graphMap, /v-for="edge in visibleEdges"/, '模板里遍历的必须是裁剪后的那份')

  const canvas = read(...`${R}/study/map/GraphCanvas.vue`.split('/'))
  assert.match(canvas, /data-testid="study-map-canvas-mode"/, 'Canvas 模式要有稳定锚点')
  assert.match(canvas, /stroke\(new Path2D\(edgePath\(edge\)\)\)|new Path2D\(edgePath\(edge\)\)/, '边要与 SVG 共用 edgePath')
  assert.match(canvas, /:data-testid="`map-node-\$\{node\.kpId\}`"/, '命中层按钮要保留与 SVG 相同的节点锚点')
  assert.match(canvas, /showsLabel\(lod\.value\)/, 'LOD 要真的影响文字标签')

  const mapTab = read(...`${R}/study/map/MapTab.vue`.split('/'))
  assert.match(mapTab, /shouldUseCanvas\(layout\.value\.nodes\.length\)/, 'MapTab 按节点数切换渲染器')
  assert.match(mapTab, /<GraphCanvas/, 'Canvas 分支要真的渲染')
  assert.match(mapTab, /@scroll="syncViewport"/, '滚动时要同步视口（否则裁剪永远停在初始位置）')
})

/* ------------------------------------------------------------------ *
 * 5. ★★ 长列表虚拟化（D10 的照做口径）
 * ------------------------------------------------------------------ */

test('★★ 长列表虚拟化：依赖在 devDependencies + 两条列表都接了 VirtualList', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  assert.ok(
    pkg.devDependencies?.['vue-virtual-scroller'],
    'vue-virtual-scroller 必须在 devDependencies（渲染专用包，代码会被 vite 打进 out/renderer）'
  )
  assert.ok(
    !pkg.dependencies?.['vue-virtual-scroller'],
    '它不能在 dependencies —— electron-builder 会把 dependencies 收进 asar（同一份代码打两遍）'
  )

  const virtual = read(...`${R}/components/VirtualList.vue`.split('/'))
  assert.match(virtual, /DynamicScroller/, '行高不固定，要用动态测量那一版')
  assert.match(virtual, /virtualizeAt: 60/, '阈值默认 60 条（短列表走原路径，探针不受影响）')
  assert.match(
    virtual,
    /virtual = computed\(\(\) => props\.items\.length > props\.virtualizeAt\)/,
    '虚拟化开关的判据是「条数 > 阈值」——这条判据被改掉就等于不做虚拟化了'
  )
  assert.match(virtual, /<slot :item="item" \/>/, '行模板两条路径共用同一个 slot（不许抄两份）')

  const sessions = read(...`${R}/study/SessionsTab.vue`.split('/'))
  assert.match(sessions, /<VirtualList[\s\S]{0,200}data-testid="sessions-list"/, '学习记录的历史会话要接虚拟列表')
  const sessionList = read(...`${R}/components/SessionList.vue`.split('/'))
  assert.match(sessionList, /<VirtualList[\s\S]{0,200}data-testid="session-tree"/, '对话页侧栏历史会话也要接')
})
