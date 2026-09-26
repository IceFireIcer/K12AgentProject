/**
 * 图谱**视口裁剪**（优化报告 §5.2 的第一条：只渲染可见节点 ±100px）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有它
 * ---------------------------------------------------------------------------
 * 现在的初中档只有 57 个节点，全量渲染毫无压力；但报告的场景是「几百个节点」——
 * 那时 SVG 里几千个 `<g>/<rect>/<text>` 节点会让滚动与选中都变卡，而其中
 * **绝大多数根本不在屏幕上**。裁剪掉它们不改变任何视觉结果（它们本来也看不见）。
 *
 * ★ 本文件**零 import**：`nodeRect` / `edgePath` 这类几何由调用方以 `rectOf`
 *   回调传进来（渲染层已经拿着它们），于是这层纯粹是"筛"，可以 node --test 直接跑
 *   （node 的 ESM 加载器要求显式 `.ts` 扩展名，零 import 就没有这个两面为难 ——
 *   与 `components/badge-level.ts` 同一条经验）。
 */

/** 画布坐标系里的视口（= 滚动容器当前的可见矩形）。 */
export interface MapViewport {
  x: number
  y: number
  width: number
  height: number
}

/** 一个矩形（节点外框 / 边的包围盒）。 */
export interface MapRect {
  x: number
  y: number
  width: number
  height: number
}

/** 视口外扩的余量（报告原文：只渲染可见节点 **±100px**）。 */
export const CULL_MARGIN_PX = 100

/** 视口外扩成裁剪矩形（负数宽高归零，避免 `scrollLeft` 抖动时把整图裁空）。 */
export function expandViewport(
  viewport: MapViewport,
  margin: number = CULL_MARGIN_PX
): MapRect {
  return {
    x: viewport.x - margin,
    y: viewport.y - margin,
    width: Math.max(0, viewport.width) + margin * 2,
    height: Math.max(0, viewport.height) + margin * 2
  }
}

/** 两个矩形是否相交（边界相接算相交 —— 宁可多画一个，不要少画一个）。 */
export function rectsIntersect(a: MapRect, b: MapRect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

/**
 * 裁掉视口外的元素（**顺序与输入一致** —— 布局输出的确定性不允许被裁剪打乱）。
 *
 * @param items 全部元素
 * @param rectOf 取元素包围盒的纯函数（节点用 `nodeRect`，边用 {@link edgeRect}）
 * @param viewport 当前可见矩形
 * @param margin 外扩余量（默认 100px）
 */
export function visibleItems<T>(
  items: readonly T[],
  rectOf: (item: T) => MapRect,
  viewport: MapViewport,
  margin: number = CULL_MARGIN_PX
): T[] {
  const box = expandViewport(viewport, margin)
  return items.filter((item) => rectsIntersect(rectOf(item), box))
}

/** 一条边的包围盒（布局给的是两端点坐标）。 */
export function edgeRect(edge: { x1: number; y1: number; x2: number; y2: number }): MapRect {
  const x = Math.min(edge.x1, edge.x2)
  const y = Math.min(edge.y1, edge.y2)
  return {
    x,
    y,
    width: Math.abs(edge.x2 - edge.x1),
    height: Math.abs(edge.y2 - edge.y1)
  }
}
