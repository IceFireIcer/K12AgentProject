/**
 * 学习地图的**布局算法**与**报告 Markdown 拼装**的断言。
 *
 * 这一组盯住三条「错了就静默出事」的性质：
 *
 * 1. ★ **布局是确定性的**：同样的输入必须给出**逐字节相同**的输出 ——
 *    否则同一张图每次打开都在横向漂移（学生以为看到的是不同的结构）。
 *    这条要求「层内排序不依赖入参数组顺序」，是布局里最容易写错的地方。
 * 2. ★ **箭头永远向下**：边必须从浅层连到深层（依赖方向 = 视觉方向）。
 *    方向反了图仍然「能画出来」，但学生会照着从下往上学。
 * 3. ★ **导出物不泄漏内部字段名 / 不出现答案**：报告用人类可读名，
 *    错题本只有题干（数据里本就没有答案与学生的作答）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ★ 与 `renderer-quiz.test.ts` 同一个手法：渲染进程的模块只按 Vite 的口味写相对导入
 *   （`from '../labels'`，**不带扩展名**），而 Node ESM 要求显式扩展名。
 *   这个 hook 只给「相对且没写扩展名」的说明符补 `.ts`，
 *   让单测能直接 import **渲染进程的真实实现**（而不是另写一份替身）。
 *
 * ⚠️ 必须用**动态 import** 加载被测模块：ESM 会把静态 `import` 提到模块顶部，
 *   而 hook 是在那之后才注册的 —— 用静态导入的话 `labels`（不带扩展名）在 hook
 *   生效前就被解析了，直接 `ERR_MODULE_NOT_FOUND`（实测踩到）。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
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

const {
  LAYOUT,
  NODE_LABEL_MAX_CHARS,
  edgePath,
  layoutGraph,
  nodeLabel,
  nodeRect
} = await import('../src/renderer/src/study/map/layout.ts')
const {
  composeMistakesMarkdown,
  composeReportMarkdown,
  formatMs,
  masteryLabel,
  summaryLine
} = await import('../src/renderer/src/study/report-markdown.ts')
type MistakesView = import('../src/renderer/src/stores/study.ts').MistakesView
type ReportView = import('../src/renderer/src/stores/study.ts').ReportView

/* ------------------------------------------------------------------ *
 * 布局
 * ------------------------------------------------------------------ */

/** 造一个满足布局入参的节点。 */
function node(kpId: string, layer: number, extra: Record<string, unknown> = {}) {
  return { kpId, name: `知识点${kpId}`, chapterTitle: '第1章', layer, mastered: false, ...extra }
}

test('布局：空输入给出空结果（不产出非法 viewBox）', () => {
  const layout = layoutGraph([], [])
  assert.deepEqual(layout.nodes, [])
  assert.deepEqual(layout.edges, [])
  assert.equal(layout.width, 0)
  assert.equal(layout.height, 0)
})

test('★ 布局是确定性的：打乱输入顺序后输出逐字节相同', () => {
  const nodes = [node('c', 1), node('a', 0), node('b', 0), node('d', 2)]
  const edges = [
    { fromKpId: 'a', toKpId: 'c' },
    { fromKpId: 'b', toKpId: 'c' },
    { fromKpId: 'c', toKpId: 'd' }
  ]
  const first = layoutGraph(nodes, edges)
  // 打乱节点顺序（边也一起打乱），结果必须一字不差
  const second = layoutGraph([...nodes].reverse(), [...edges].reverse())
  assert.deepEqual(second, first, '同一张图在两次调用间不能有差别（否则图会漂移）')
  // 再验一次「同层内按 kpId 排」这条具体性质
  const layer0 = first.nodes.filter((n) => n.layer === 0).map((n) => n.kpId)
  assert.deepEqual(layer0, ['a', 'b'])
  assert.ok(first.nodes[0].x < first.nodes[1].x, '同层内 kpId 小的应当在左边')
})

test('★ 箭头永远向下：每条边的起点层比终点层浅', () => {
  const layout = layoutGraph(
    [node('a', 0), node('b', 1), node('c', 2)],
    [
      { fromKpId: 'a', toKpId: 'b' },
      { fromKpId: 'b', toKpId: 'c' }
    ]
  )
  for (const edge of layout.edges) {
    assert.ok(edge.y1 < edge.y2, `边 ${edge.fromKpId}→${edge.toKpId} 的方向反了（y1 应当在上方）`)
  }
  // 层序号越大 y 越大（第 0 层在最上面）
  const byId = new Map(layout.nodes.map((n) => [n.kpId, n]))
  assert.ok(byId.get('a')!.y < byId.get('b')!.y)
  assert.ok(byId.get('b')!.y < byId.get('c')!.y)
})

test('布局：悬空边（引用不存在的节点）被丢掉，不画出指向画布外的线', () => {
  const layout = layoutGraph(
    [node('a', 0), node('b', 1)],
    [
      { fromKpId: 'a', toKpId: 'b' },
      { fromKpId: 'a', toKpId: '不存在' },
      { fromKpId: '也不存在', toKpId: 'b' }
    ]
  )
  assert.equal(layout.edges.length, 1)
  assert.equal(layout.edges[0].fromKpId, 'a')
})

test('布局：缺 layer 的节点按第 0 层处理（不猜测依赖关系）', () => {
  const layout = layoutGraph(
    [{ kpId: 'a', name: 'A' }, { kpId: 'b', name: 'B', layer: 2 }],
    []
  )
  const byId = new Map(layout.nodes.map((n) => [n.kpId, n]))
  assert.equal(byId.get('a')!.layer, 0)
  assert.equal(byId.get('b')!.layer, 2)
})

test('布局：画布尺寸含内边距，且能容纳全部节点', () => {
  const layout = layoutGraph([node('a', 0), node('b', 0), node('c', 1)], [])
  assert.ok(layout.width >= 2 * LAYOUT.nodeWidth + LAYOUT.columnGap)
  assert.ok(layout.height >= 2 * LAYOUT.nodeHeight + LAYOUT.rowGap)
  for (const item of layout.nodes) {
    const rect = nodeRect(item)
    assert.ok(rect.x >= 0 && rect.y >= 0)
    assert.ok(rect.x + rect.width <= layout.width, `节点 ${item.kpId} 超出画布右边界`)
    assert.ok(rect.y + rect.height <= layout.height, `节点 ${item.kpId} 超出画布下边界`)
  }
})

test('布局：同层节点不重叠（水平间距不小于约定值）', () => {
  const layout = layoutGraph([node('a', 0), node('b', 0), node('c', 0)], [])
  const sorted = [...layout.nodes].sort((x, y) => x.x - y.x)
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].x - sorted[i - 1].x
    assert.ok(gap >= LAYOUT.nodeWidth, `同层节点重叠：间距 ${gap} < 宽度 ${LAYOUT.nodeWidth}`)
  }
})

test('布局：mastered 标记被原样带到输出（界面据此上色）', () => {
  const layout = layoutGraph([node('a', 0, { mastered: true }), node('b', 1)], [])
  const byId = new Map(layout.nodes.map((n) => [n.kpId, n]))
  assert.equal(byId.get('a')!.mastered, true)
  assert.equal(byId.get('b')!.mastered, false)
})

test('边的路径是直角折线（起点竖 → 横 → 终点竖），且不穿过节点矩形', () => {
  /*
   * ⚠️ 起点与终点**必须落在不同的 x 上**，否则「竖 → 横 → 竖」这个形状根本区分不出来：
   *    第一版这里只放了每层各一个节点（都被居中），于是 x1 === x2，
   *    连「把第一段画成斜线」这种改动都测不出来（变异验证时当场发现）。
   *    现在第 0 层 1 个、第 1 层 2 个 —— 窄层居中，两端 x 天然不同。
   */
  const layout = layoutGraph(
    [node('a', 0), node('b', 1, { chapterTitle: '第2章' }), node('c', 1, { chapterTitle: '第2章' })],
    [{ fromKpId: 'a', toKpId: 'b' }]
  )
  const path = edgePath(layout.edges[0])
  // 四个点：起点 → 中点 → 中点 → 终点
  const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number)
  assert.equal(numbers.length, 8, `路径应当有 4 个坐标点：${path}`)
  const [x1, y1, x1b, midY1, x2, midY2, x2b, y2] = numbers
  /*
   * ★★ 这里原来写的是 `assert.equal(x1, x2 === numbers[4] ? x1 : x1)` ——
   *   「第一段是竖直的」这句话**从来没被真的验证过**：那个三元的两个分支都是 `x1`，
   *   而 `x2` 本身就是 `numbers[4]` 解构来的，所以条件恒真、断言退化成 `assert.equal(x1, x1)`。
   *   （变异验证：把两个分支改成任意别的值，它照样通过。）
   *
   * 真正要断的是「起点与**第一个拐点**同 x」（竖直段），以及对称的另一头。
   * 路径形态是 `M x1 y1 L x1 midY L x2 midY L x2 y2`，所以：
   *   numbers = [x1, y1, x1, midY, x2, midY, x2, y2]
   *                ↑0  ↑1  ↑2         ↑4  ↑5  ↑6  ↑7
   * 竖直：0 与 2 同 x（第一段）、4 与 6 同 x（最后一段）；水平：3 与 5 同 y（中间那段）。
   */
  assert.notEqual(x1, x2, '两端的 x 必须不同，否则这个形状断言没有判别力（见上面的注释）')
  assert.equal(x1, x1b, '路径第一段是竖直的（起点与第一个拐点同 x）')
  assert.equal(midY1, midY2, '中间两个拐点同一水平线（中段是水平的）')
  assert.equal(x2, x2b, '路径最后一段是竖直的（第二个拐点与终点同 x）')
  assert.ok(y1 < midY1, '拐点在起点下方')
  assert.ok(midY2 < y2, '第二段拐点在终点上方')
  assert.ok(path.startsWith('M '), '路径以 moveto 开头')
  assert.equal(path.includes('C'), false, '不用贝塞尔曲线（保证任意缩放下观感一致）')
})

/**
 * ★ 上面那条测试的标题写了「且不穿过节点矩形」，但**正文从来没有断言过它** —— 补上。
 *
 * 补的时候先搞清楚了实现**到底**保证什么（这比抄一句标题重要）：
 *
 *   ✅ **相邻层的边**不穿过任何节点矩形 —— 这才是实现真正保证的性质，也是本测试钉的。
 *      原因很直接：`midY` 正好落在两行之间的空隙里（`y1` 是源节点下边缘、`y2` 是目标上边缘，
 *      `midY` 取两者中点），而那一整段 y 区间里没有任何节点矩形。
 *
 *   ⚠️ **跨层的边**（layer 0 → layer 2）会压住中间层的节点：实测
 *      `midY=170` 正落在中间节点 `b` 的矩形 `y=[150,190]` 里。
 *      这是**已知且被接受的取舍** —— `layout.ts` 文件头明写「不做边的路由优化（不要曲线、不要避让）」，
 *      本测试**不**断言它不穿过（那会把一个有意决策判成失败）。
 *      它没有在这里被修，只是被如实记录：真实数据里存在跨层边时，图上会出现
 *      「一条横线从某个节点矩形中间穿过」的观感（不是渲染错误，是布线策略的代价）。
 *      → 已写进本轮审计报告，交给收口的人决定要不要动布局。
 */
test('★ 相邻层的边不穿过任何节点矩形（实现真正保证的性质；跨层边不在保证范围内）', () => {
  // 第 0 层 2 个、第 1 层 3 个 —— 列不齐，横段要横跨一段真实距离
  const layout = layoutGraph(
    [
      node('a', 0),
      node('b', 0, { chapterTitle: '第2章' }),
      node('c', 1, { chapterTitle: '第2章' }),
      node('d', 1, { chapterTitle: '第2章' }),
      node('e', 1, { chapterTitle: '第2章' })
    ],
    [
      { fromKpId: 'a', toKpId: 'd' },
      { fromKpId: 'b', toKpId: 'c' },
      { fromKpId: 'b', toKpId: 'e' }
    ]
  )
  const rects = layout.nodes.map((item) => ({ kpId: item.kpId, ...nodeRect(item) }))

  /** 两个轴对齐矩形是否相交（含边界相切：相切也算「压住」）。 */
  const hits = (r: { x: number; y: number; width: number; height: number }, x: number, y: number): boolean =>
    x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height

  assert.equal(layout.edges.length, 3, '三条边都应当画出来（两端节点都在）')
  for (const edge of layout.edges) {
    const midY = (edge.y1 + edge.y2) / 2
    // 直角折线的四段用「有限个采样点」判定：三点足够（两端 + 中点），
    // 因为每一段都是轴对齐的直线段，端点在内就等价于整段在内。
    const samples: Array<[number, number]> = [
      [edge.x1, edge.y1],
      [edge.x1, midY],
      [edge.x2, midY],
      [edge.x2, edge.y2]
    ]
    for (const { kpId, ...rect } of rects) {
      // 边与它自己的两个端点节点是**贴着**的（起止于矩形边缘），那是设计如此，跳过
      if (kpId === edge.fromKpId || kpId === edge.toKpId) continue
      for (const [x, y] of samples) {
        assert.equal(
          hits(rect, x, y),
          false,
          `边 ${edge.fromKpId}→${edge.toKpId} 的路径压住了节点 ${kpId} 的矩形` +
            `（采样点 ${x.toFixed(1)}, ${y.toFixed(1)}；矩形 ${rect.x.toFixed(1)},${rect.y.toFixed(1)} ` +
            `${rect.width}×${rect.height}）—— 直角折线应当走在层间空隙里`
        )
      }
    }
  }
})

test('节点标签：超过上限按**字符**截断（不把汉字切半个）', () => {
  assert.equal(nodeLabel('神经网络', 'neural-network-jr'), '神经网络')
  // 没有名字时退回 kpId —— **也要截断**：矩形是定宽的，id 同样放不下
  // （`neural-network-jr` 是 17 个字符 > 上限 7）。截断而不是溢出，是刻意的。
  assert.equal(nodeLabel('', 'neural-network-jr'), 'neural-…')
  const long = '一二三四五六七八九十'
  const label = nodeLabel(long, 'x')
  assert.equal(Array.from(label).length, NODE_LABEL_MAX_CHARS + 1, '截断后应含省略号')
  assert.ok(label.endsWith('…'))
  assert.ok(long.startsWith(label.slice(0, -1)), '截断保留了前缀')
  // 恰好等于上限时不加省略号
  assert.equal(nodeLabel('七个字符的标签', 'x'), '七个字符的标签')
  assert.equal(Array.from(nodeLabel('七个字符的标签', 'x')).length, NODE_LABEL_MAX_CHARS)
})

test('节点矩形：由中心点换算左上角，尺寸来自布局常量', () => {
  const rect = nodeRect({ x: 100, y: 50 })
  assert.equal(rect.width, LAYOUT.nodeWidth)
  assert.equal(rect.height, LAYOUT.nodeHeight)
  assert.equal(rect.x + rect.width / 2, 100)
  assert.equal(rect.y + rect.height / 2, 50)
})

/* ------------------------------------------------------------------ *
 * ★ 画布是「固定像素 + 容器滚动」，不是「等比缩到装得下」
 * ------------------------------------------------------------------ */

/** 132×40 的节点在 1120 窗口下会被缩到多少（13px 的字会变成多少 px）。 */
const SHELL_SIDEBAR_W = 264
const SHELL_CONTENT_PADDING = 48
const NARROW_WINDOW_W = 1120
const NODE_LABEL_FONT_PX = 13

/**
 * 造一张**与真实数据同形**的图：每个学段 57 个知识点，最宽一层 10 个。
 *
 * ⚠️ 用合成数据而不是去读 `kb.sqlite`：布局是纯函数，单测不该依赖本地库
 *   （干净克隆里 `_data/` 不存在）。层数与宽度按真实形状摆好，
 *   算出来的画布尺寸才和真机一致。
 */
function juniorShapedGraph(): {
  nodes: Array<ReturnType<typeof node>>
  edges: Array<{ fromKpId: string; toKpId: string }>
} {
  const nodes: Array<ReturnType<typeof node>> = []
  // 13 层：第 0 层放 10 个（最宽），其余 47 个摊到后面 12 层
  const layers = 13
  let index = 0
  for (let layer = 0; layer < layers; layer += 1) {
    const count = layer === 0 ? 10 : Math.ceil(47 / (layers - 1))
    for (let column = 0; column < count && index < 57; column += 1) {
      nodes.push(node(`kp-${String(index).padStart(2, '0')}`, layer))
      index += 1
    }
  }
  // 78 条边：每条都从上一层连到下一层（保证「箭头向下」这条性质也一起成立）
  const edges: Array<{ fromKpId: string; toKpId: string }> = []
  for (let layer = 1; layer < layers; layer += 1) {
    const prev = nodes.filter((n) => n.layer === layer - 1)
    const curr = nodes.filter((n) => n.layer === layer)
    for (let column = 0; column < Math.min(prev.length, curr.length) && edges.length < 78; column += 1) {
      edges.push({ fromKpId: prev[column].kpId, toKpId: curr[column].kpId })
    }
  }
  return { nodes, edges }
}

test('★ 画布尺寸是**固定像素**：真实形状（57 点 / 最宽 10）算出来就是 1610 × 1600', () => {
  const { nodes, edges } = juniorShapedGraph()
  const layout = layoutGraph(nodes, edges)

  assert.equal(nodes.length, 57, '构造的图应当是 57 个节点（与每个学段的知识点数一致）')
  assert.equal(layout.nodes.length, 57, '悬空节点不该被丢（只有悬空**边**才丢）')
  // 10 × 132 + 9 × 26 + 28 × 2 = 1610
  assert.equal(layout.width, 10 * LAYOUT.nodeWidth + 9 * LAYOUT.columnGap + LAYOUT.paddingX * 2)
  assert.equal(layout.width, 1610, '这是 junior 那张图的真实画布宽度（改布局常量时请同步这一处）')
  assert.equal(layout.height, 1600, '13 层 → 1600（与真机一致；数字变了说明密度改了）')
})

test('★★ 画布宽度超出最窄窗口的内容区 → 必须靠容器滚动，缩到装得下会把 13px 压成 6.5px', () => {
  const { nodes, edges } = juniorShapedGraph()
  const layout = layoutGraph(nodes, edges)

  // 1120（窗口下限）− 264（侧栏）− 48（内容 padding）= 808px 可用
  const available = NARROW_WINDOW_W - SHELL_SIDEBAR_W - SHELL_CONTENT_PADDING
  assert.equal(available, 808, '可用宽度按 shell 版式算（侧栏 264 / padding 48，见 assets/base.css 的 min-width）')

  const shrinkScale = available / layout.width
  assert.ok(
    shrinkScale < 0.6,
    `「缩到装得下」的比例是 ${shrinkScale.toFixed(2)} —— 这个数必须**小于 0.6** 才说明本测试的前提还成立` +
      '（若外壳版式变宽了，请重新评估「滚动 vs 缩字」这个取舍，而不是把这条断言调松）'
  )
  assert.ok(
    NODE_LABEL_FONT_PX * shrinkScale < 8,
    `缩放下节点文字只剩 ${(NODE_LABEL_FONT_PX * shrinkScale).toFixed(1)}px（= 13 × ${shrinkScale.toFixed(2)}）` +
      ' —— 这就是不能让 SVG 自适应的量化理由'
  )
  // 1:1 渲染时字号恒为设计值（`--k12-fs-xs` = 13px）
  assert.equal(NODE_LABEL_FONT_PX * 1, 13)
})

/**
 * ★ 渲染层守卫（源码级）：`.map` 不得把固定像素画布缩回去。
 *
 * 为什么用源码断言而不是渲染后量 DOM：`node --test` 里没有浏览器，
 * 而这条约束**恰恰只存在于 CSS 里** —— 它错了不会让任何逻辑断言变红，
 * 只会让节点文字在窄窗口下悄悄变成 6.5px（且外层容器永远不出现滚动条）。
 * 手法与 `ux-queue-and-scroll.test.ts` 一致：读源码，钉住那条不能再犯的写法。
 */
test('★ 渲染层守卫：SVG 画布 1:1 渲染（不得 max-width:100% / 100% 宽 / transform: scale）', () => {
  const source = readFileSync(join(desktopRoot, 'src', 'renderer', 'src', 'study', 'map', 'GraphMap.vue'), 'utf8')
  // 只看 <style> 段（模板里 `width` 属性是另一回事）
  const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))
  // ★ 先去掉注释再匹配：`.map` 那段注释**故意举了这些坏写法的例子**（讲清楚为什么不能写），
  //   不去注释的话守卫会被自己的说明书绊倒 —— 与 build-pipeline.test.ts 同一个手法。
  const rules = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(
    styleBlock.includes('max-width: none'),
    '`.map` 必须显式 `max-width: none`（对上任何会缩窄它的规则）'
  )

  const shrinkers = [
    { pattern: /max-width:\s*100%/, label: 'max-width: 100%' },
    { pattern: /(?<!max-)width:\s*100%/, label: 'width: 100%' },
    { pattern: /transform:\s*scale/, label: 'transform: scale(...)' }
  ]
  const offenders = shrinkers.filter(({ pattern }) => pattern.test(rules)).map(({ label }) => label)

  // ★ `height: auto` 单独出现是**无害**的（尺寸仍由 width/height 属性决定），
  //   只有与一条会缩窄宽度的规则同时出现才是「等比缩放」那个写法。
  //   判据写精确一点：无条件报它会造出假阳性，而假阳性会让人白查一轮（本项目实测过）。
  const narrowsWidth = /max-width:\s*(?!none)\S|(?<!max-)width:\s*\d+%/.test(rules)
  if (narrowsWidth && /height:\s*auto/.test(rules)) {
    offenders.push('宽度受限 + height: auto（等比缩放的组合写法）')
  }
  assert.deepEqual(
    offenders,
    [],
    `GraphMap.vue 的样式里出现 ${offenders.join(' / ')} —— 会让 SVG 等比缩小，` +
      '窄窗口下把 13px 的节点文字压到 6.5px（见 layout.ts 的 GraphLayout.width 注释）'
  )
})

/* ------------------------------------------------------------------ *
 * 报告 / 错题本的 Markdown
 * ------------------------------------------------------------------ */

function sampleReport(overrides: Partial<ReportView> = {}): ReportView {
  return {
    studentId: 'student_001',
    nickname: '小明',
    gradeLevel: 'junior',
    days: 7,
    generatedAt: Date.parse('2026-09-17T10:00:00Z'),
    daily: [{ day: '2026-09-17', count: 3, quizCount: 2, correctCount: 1 }],
    totalActivities: 3,
    quizTotal: 2,
    quizCorrect: 1,
    streakDays: 2,
    todayStudied: true,
    mastery: [
      { kpId: 'prog-loop-jr', score: 0.9, attempts: 2, correct: 2 },
      { kpId: 'prog-variable-jr', score: 0.3, attempts: 1, correct: 0 }
    ],
    chapters: [{ chapterTitle: '第8章 编程实践（补充）', kpCount: 3, masteredCount: 1, quizzedCount: 1 }],
    stageCounts: { mastered: 1, learning: 2 },
    badges: ['bronze'],
    gradeHistory: [
      { ts: Date.parse('2026-09-17T09:00:00Z'), turn: 0, toLevel: 'primary_high', source: 'inferred', confidence: 0 },
      {
        ts: Date.parse('2026-09-17T09:30:00Z'),
        turn: 3,
        fromLevel: 'primary_high',
        toLevel: 'junior',
        source: 'inferred',
        confidence: 0.75
      }
    ],
    ...overrides
  } as ReportView
}

function sampleMistakes(overrides: Partial<MistakesView> = {}): MistakesView {
  return {
    studentId: 'student_001',
    gradeLevel: 'junior',
    items: [
      {
        kpId: 'prog-loop-jr',
        kpName: '循环：重复的事交给机器',
        chapterTitle: '第8章 编程实践（补充）',
        stem: '下面哪个循环是无限循环？',
        wrongCount: 2,
        lastWrongAt: Date.parse('2026-09-17T10:00:00Z'),
        lastQid: 'prog-loop-jr-q1'
      }
    ],
    totalWrong: 2,
    withoutStem: 1,
    ...overrides
  } as MistakesView
}

test('报告 Markdown：含六个分区与关键数字', () => {
  const markdown = composeReportMarkdown(sampleReport(), 7)
  for (const heading of ['# 学习报告（近 7 天）', '## 一、学习概况', '## 二、知识点掌握情况', '## 三、章节进度', '## 四、闯关进度', '## 五、学段变化轨迹', '## 六、下一步']) {
    assert.ok(markdown.includes(heading), `缺少分区：${heading}`)
  }
  assert.ok(markdown.includes('连续学习：**2** 天'))
  assert.ok(markdown.includes('第 3 轮：小学高年级 → 初中'), '学段轨迹应当是可读叙事')
  assert.ok(markdown.includes('prog-loop-jr'), '掌握度表格含知识点')
  // 表头与分隔行成对（Markdown 表格语法）
  const tableRows = markdown.split('\n').filter((line) => line.startsWith('|'))
  assert.ok(tableRows.length >= 4, `表格行数偏少：${tableRows.length}`)
})

test('★ 报告 Markdown 不出现答案字段（错题本同一条纪律）', () => {
  const markdown = composeReportMarkdown(sampleReport(), 7) + composeMistakesMarkdown(sampleMistakes())
  assert.equal(markdown.toLowerCase().includes('answer'), false)
  assert.equal(markdown.includes('参考答案'), false)
  assert.equal(markdown.includes('标准答案'), false)
})

test('报告 Markdown：没有记录时不崩，给出可读说明', () => {
  const empty = sampleReport({
    daily: [],
    mastery: [],
    chapters: [],
    stageCounts: {},
    badges: [],
    gradeHistory: [],
    totalActivities: 0,
    quizTotal: 0,
    quizCorrect: 0,
    streakDays: 0,
    todayStudied: false
  })
  const markdown = composeReportMarkdown(empty, 7)
  assert.ok(markdown.includes('这段时间还没有学习记录。'))
  assert.ok(markdown.includes('还没有掌握度记录。'))
  assert.ok(markdown.includes('还没有章节进度记录。'))
  assert.ok(markdown.includes('还没有开始闯关。'))
  assert.ok(markdown.includes('还没有学段变化记录。'))
})

test('报告摘要行：正确率按四舍五入，没有题目时说明而不是除以零', () => {
  assert.match(summaryLine(sampleReport(), 7), /正确率 50%/)
  const noQuiz = summaryLine(sampleReport({ quizTotal: 0, quizCorrect: 0 }), 7)
  assert.ok(noQuiz.includes('还没有作答记录'), noQuiz)
  assert.equal(noQuiz.includes('NaN'), false)
  assert.equal(noQuiz.includes('Infinity'), false)
})

test('掌握度分档：0.8 / 0.5 两条线的口径', () => {
  assert.equal(masteryLabel(1), '已掌握')
  assert.equal(masteryLabel(0.8), '已掌握')
  assert.equal(masteryLabel(0.79), '正在学')
  assert.equal(masteryLabel(0.5), '正在学')
  assert.equal(masteryLabel(0.49), '需要练')
  assert.equal(masteryLabel(0), '需要练')
})

test('时间格式化：非法值给破折号（不产出 Invalid Date）', () => {
  assert.equal(formatMs(0), '—')
  assert.equal(formatMs(Number.NaN), '—')
  assert.equal(formatMs(-1), '—')
  assert.match(formatMs(Date.parse('2026-09-17T10:00:00Z')), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('错题本 Markdown：列出知识点名、题干与错次；没有题干时如实说明', () => {
  const markdown = composeMistakesMarkdown(sampleMistakes())
  assert.ok(markdown.includes('# 错题本'))
  assert.ok(markdown.includes('循环：重复的事交给机器'), '应当用人类可读的知识点名')
  assert.ok(markdown.includes('下面哪个循环是无限循环？'), '应当含题干')
  assert.ok(markdown.includes('错 2 次'))
  assert.ok(markdown.includes('另有 1 次答错没有题目记录'), '没有题干的答错要被显式说明')
})

test('错题本 Markdown：拿不到知识点名时退回编号并标注（不假装有名）', () => {
  const markdown = composeMistakesMarkdown(
    sampleMistakes({
      items: [
        {
          kpId: 'prog-loop-jr',
          kpName: 'prog-loop-jr',
          chapterTitle: '',
          stem: '',
          wrongCount: 1,
          lastWrongAt: 0,
          lastQid: ''
        }
      ]
    })
  )
  assert.ok(markdown.includes('prog-loop-jr（知识点编号）'))
  assert.ok(markdown.includes('这次答错没有对应的题目记录'))
})

test('错题本 Markdown：全对时给出鼓励而不是空表', () => {
  const markdown = composeMistakesMarkdown(sampleMistakes({ items: [], totalWrong: 0, withoutStem: 0 }))
  assert.ok(markdown.includes('还没有错题记录'))
  assert.equal(markdown.includes('| 知识点 |'), false, '没有条目时不该画空表')
})

test('Markdown：统一 LF（导出物不制造 CRLF/LF 混排）', () => {
  const markdown = composeReportMarkdown(sampleReport(), 7) + composeMistakesMarkdown(sampleMistakes())
  assert.equal(markdown.includes('\r'), false, '不得出现 CR')
})
