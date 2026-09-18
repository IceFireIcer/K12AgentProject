/**
 * 学习地图的**布局算法**（纯函数，可单测）。
 *
 * ---------------------------------------------------------------------------
 * 为什么自绘而不是引图表库
 * ---------------------------------------------------------------------------
 * 本项目**不加任何 npm 依赖**（零打包风险，且演示环境可能断网）：
 * 手画 SVG 需要的只是一次分层遍历 + 一点几何。
 * 节点量级也支持这么做：四学段各 5–7 章、单学段 8–9 个知识点（实测 33 个 kp / 47 条边）。
 *
 * ---------------------------------------------------------------------------
 * 布局规则（都是**确定性**的：同输入 → 逐字节同输出）
 * ---------------------------------------------------------------------------
 * 1. **纵向 = 依赖方向**：`layer` 由服务端按最长前置链算好（`GraphOverview.nodes[].layer`），
 *    所以「箭头永远向下」—— 学生一眼能看出先学什么。
 * 2. **横向 = 顺序**：同一层内按 `kpId` 字典序**从左到右**排（不用数组下标：
 *    后端返回顺序一旦变化，整张图会横向漂移）。
 * 3. **同一章挨在一起**：同层内先按章节名聚簇、再按 kpId —— 相邻的节点多半属于同一章。
 * 4. 层高 / 列宽 / 内边距都是常量，输出是绝对坐标（渲染只负责画）。
 *
 * ★ 布局**不做**节点去重、不做边的路由优化（不要曲线、不要避让）：
 *   这张图是给学生看**结构**的，不是给工程师看的美术稿。直角连线足够清晰，
 *   而任何「自动避让」都会引入不确定的输出（同一张图两次打开长得不一样）。
 */

/** 布局后的一个节点（绝对坐标，单位 px；`x`/`y` 是**中心点**）。 */
export interface LayoutNode {
  kpId: string
  name: string
  chapterTitle: string
  layer: number
  /** 该学生是否已掌握（来自服务端） */
  mastered: boolean
  x: number
  y: number
}

/** 布局后的一条边（两端坐标，由节点位置算出）。 */
export interface LayoutEdge {
  fromKpId: string
  toKpId: string
  relation: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface GraphLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  /** 画布尺寸（含内边距），SVG 的 viewBox 直接用 */
  width: number
  height: number
}

/** 布局常量（改这里就能整体调密度；渲染层不写死任何几何数值）。 */
export const LAYOUT = {
  /** 同一层内相邻节点的水平间距 */
  columnGap: 26,
  /** 层与层的垂直间距 */
  rowGap: 86,
  /** 节点矩形宽 / 高 */
  nodeWidth: 132,
  nodeHeight: 40,
  /** 画布内边距 */
  paddingX: 28,
  paddingY: 24
} as const

/** 布局输入（与契约 `GraphOverview` 的形状一致，但**不 import** 生成类型以保持纯函数可测）。 */
export interface LayoutInputNode {
  kpId: string
  name: string
  chapterTitle?: string
  layer?: number
  mastered?: boolean
}

export interface LayoutInputEdge {
  fromKpId: string
  toKpId: string
  relation?: string
}

/**
 * 计算整张图的布局。
 *
 * ★ 入参里的边若引用**不存在的节点**，那条边被丢掉（画不出来）；
 *   这与服务端「只返回两端都在本学段内的边」是同一个道理，但这里再挡一次 ——
 *   渲染层不该因为一条悬空边而画出一条指向画布外的线。
 */
export function layoutGraph(nodes: LayoutInputNode[], edges: LayoutInputEdge[]): GraphLayout {
  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  // ① 分层：按服务端给的 layer；缺省按 0（不猜测依赖关系）
  const byLayer = new Map<number, LayoutInputNode[]>()
  for (const node of nodes) {
    const layer = Number.isInteger(node.layer) ? Number(node.layer) : 0
    const bucket = byLayer.get(layer)
    if (bucket) bucket.push(node)
    else byLayer.set(layer, [node])
  }

  // ② 层内排序：章节聚簇 → kpId。**不依赖入参数组顺序**（否则整张图会随返回顺序漂）
  for (const bucket of byLayer.values()) {
    bucket.sort((a, b) => {
      const byChapter = (a.chapterTitle ?? '').localeCompare(b.chapterTitle ?? '')
      return byChapter !== 0 ? byChapter : a.kpId.localeCompare(b.kpId)
    })
  }

  // ③ 计算每层的宽度，据此把整张图**水平居中**（窄层居中，视觉上更像一棵树）
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  const { columnGap, rowGap, nodeWidth, nodeHeight, paddingX, paddingY } = LAYOUT
  const layerWidths = new Map<number, number>()
  let widest = 0
  for (const layer of layers) {
    const count = byLayer.get(layer)!.length
    const width = count * nodeWidth + (count - 1) * columnGap
    layerWidths.set(layer, width)
    widest = Math.max(widest, width)
  }
  const width = widest + paddingX * 2
  const height = layers.length * nodeHeight + (layers.length - 1) * rowGap + paddingY * 2

  // ④ 落坐标
  const positions = new Map<string, { x: number; y: number }>()
  const laidOutNodes: LayoutNode[] = []
  layers.forEach((layer, rowIndex) => {
    const bucket = byLayer.get(layer)!
    const layerWidth = layerWidths.get(layer)!
    const startX = paddingX + (widest - layerWidth) / 2
    bucket.forEach((node, columnIndex) => {
      const x = startX + columnIndex * (nodeWidth + columnGap) + nodeWidth / 2
      const y = paddingY + rowIndex * (nodeHeight + rowGap) + nodeHeight / 2
      positions.set(node.kpId, { x, y })
      laidOutNodes.push({
        kpId: node.kpId,
        name: node.name,
        chapterTitle: node.chapterTitle ?? '',
        layer,
        mastered: node.mastered === true,
        x,
        y
      })
    })
  })

  // ⑤ 边：两端都要有落点才画（悬空边直接丢）
  const edges2: LayoutEdge[] = []
  for (const edge of edges) {
    const from = positions.get(edge.fromKpId)
    const to = positions.get(edge.toKpId)
    if (!from || !to) continue
    edges2.push({
      fromKpId: edge.fromKpId,
      toKpId: edge.toKpId,
      relation: edge.relation ?? 'prerequisite',
      x1: from.x,
      y1: from.y + nodeHeight / 2,
      x2: to.x,
      y2: to.y - nodeHeight / 2
    })
  }

  // ⑥ 稳定顺序（输出与输入顺序无关）
  laidOutNodes.sort((a, b) => a.layer - b.layer || a.x - b.x)
  edges2.sort((a, b) => a.fromKpId.localeCompare(b.fromKpId) || a.toKpId.localeCompare(b.toKpId))

  return { nodes: laidOutNodes, edges: edges2, width, height }
}

/**
 * 边的折线路径（先竖、再横、再竖 —— 直角折线，不用曲线）。
 *
 * ★ 不画曲线：贝塞尔控制点一旦按两节点距离算，同样的输入在不同缩放下的观感会变，
 *   而直角折线在任何尺寸下都清晰。两个拐点分别是「起点正下方一半处」与
 *   「终点正上方一半处」——这条路径**不会**穿过节点矩形（走的是层间空隙）。
 */
export function edgePath(edge: LayoutEdge): string {
  const midY = (edge.y1 + edge.y2) / 2
  return `M ${edge.x1} ${edge.y1} L ${edge.x1} ${midY} L ${edge.x2} ${midY} L ${edge.x2} ${edge.y2}`
}

/**
 * 节点矩形的左上角（SVG `<rect>` 用的是左上角，而布局给的是中心点）。
 *
 * ★ 这个换算放在这里而不是模板里：模板里做算术会让「同一个常量在两处出现」
 *   （`nodeWidth / 2`），改了布局常量就可能有一处忘了改。
 */
export function nodeRect(node: Pick<LayoutNode, 'x' | 'y'>): {
  x: number
  y: number
  width: number
  height: number
} {
  return {
    x: node.x - LAYOUT.nodeWidth / 2,
    y: node.y - LAYOUT.nodeHeight / 2,
    width: LAYOUT.nodeWidth,
    height: LAYOUT.nodeHeight
  }
}

/**
 * 节点显示名（过长按**字符**截断 —— 不按字节，否则汉字会被切成半个）。
 *
 * 132px 宽的矩形里放 7 个汉字（约 13px 字号）比较合适；再长就省略。
 */
export const NODE_LABEL_MAX_CHARS = 7

export function nodeLabel(name: string, kpId: string): string {
  const text = (name || kpId).trim()
  const chars = Array.from(text)
  if (chars.length <= NODE_LABEL_MAX_CHARS) return text
  return `${chars.slice(0, NODE_LABEL_MAX_CHARS).join('')}…`
}
