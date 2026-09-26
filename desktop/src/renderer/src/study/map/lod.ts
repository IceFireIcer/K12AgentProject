/**
 * 图谱 **LOD（Level of Detail）** 与「什么时候该换 Canvas」（优化报告 §5.2 的第二、三条）。
 *
 * 报告的阈值（照抄，不改数）：
 *   · `zoom < 0.5` → 只画**点**（dot）
 *   · `zoom < 1.0` → 画**图标**（icon：不画文字的方块）
 *   · 其余        → **完整**（full：方块 + 文字标签）
 *   · `节点数 > 100` → 切换 **Canvas** 渲染
 *
 * ★ 本文件零 import（同 `culling.ts` 的理由：node --test 直接跑）。
 *
 * ⚠️ **SVG 那条路不套 LOD**：SVG 是 1:1 固定渲染（13px 标签是学生要读的东西，
 *   见 `GraphMap.vue` 的样式说明），给它加"密度掉档"会把标签悄悄藏掉。
 *   LOD 只在 **Canvas 模式**（>100 节点）里按缩放档生效 —— 那时本来就是
 *   "看结构"而不是"读每一个标签"，而且 Canvas 上给了「适应宽度 / 1:1」两个档。
 */

export type MapLod = 'dot' | 'icon' | 'full'

/** `zoom < 0.5` → 点。 */
export const LOD_DOT_BELOW = 0.5
/** `zoom < 1.0` → 图标。 */
export const LOD_ICON_BELOW = 1

/** 缩放 → 细节档（报告的三档，边界取"含下不含上"）。 */
export function lodForZoom(zoom: number): MapLod {
  const value = Number.isFinite(zoom) ? zoom : 1
  if (value < LOD_DOT_BELOW) return 'dot'
  if (value < LOD_ICON_BELOW) return 'icon'
  return 'full'
}

/** `>100` 节点切 Canvas（报告原文）。 */
export const CANVAS_NODE_THRESHOLD = 100

export function shouldUseCanvas(nodeCount: number): boolean {
  return nodeCount > CANVAS_NODE_THRESHOLD
}

/**
 * 「适应宽度」时的缩放（画布宽 / 视口宽；不做上限 1 的截断 —— 调用方自己 clamp）。
 */
export function fitZoom(viewportWidth: number, graphWidth: number): number {
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(graphWidth)) return 1
  if (viewportWidth <= 0 || graphWidth <= 0) return 1
  return viewportWidth / graphWidth
}

/** 把缩放夹在 [min, max]（默认 [0.1, 1.5]，别让滚轮把图缩成看不见的灰点）。 */
export function clampZoom(zoom: number, min = 0.1, max = 1.5): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(max, Math.max(min, zoom))
}

/** 某个细节档下要不要画文字标签。 */
export function showsLabel(lod: MapLod): boolean {
  return lod === 'full'
}
