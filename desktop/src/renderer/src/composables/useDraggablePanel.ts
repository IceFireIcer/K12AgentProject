/**
 * 可拖拽浮层的**公共拖拽逻辑**（`FloatPanel.vue` 与 `DiagnosticsPanel.vue` 共用）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么抽出来
 * ══════════════════════════════════════════════════════════════════════════
 * 演示模式新增了第二只浮窗（只读的机制浮窗）。它的拖拽**必须**与「追问窗」手感一致：
 * 同一份 `pointerdown/move/up`、同一份「保留抓取点偏移」、同一份「贴边不回弹」。
 * 抄一份的代价不是多 40 行，而是**两只窗慢慢长得不一样** ——
 * 学生（和评委）会立刻感觉到「这只窗拖起来和那只不一样」，而那是纯粹的廉价感。
 *
 * 这几条细节决定了「拖起来跟不跟手」（原文来自 `FloatPanel.vue`，实现一字未改）：
 *   - Pointer Events + `setPointerCapture`：指针移出窗口边界也不丢事件；
 *   - **保留抓取点偏移**：从标题栏中间按下就从中间拖，不吸附到元素中心；
 *   - 限制在视口内，且**不做回弹**（这是精确摆放，不是甩动交互）；
 *   - 松手记住位置（位置由调用方的 store 持有）。
 */

import { onBeforeUnmount, onMounted, type Ref } from 'vue'

export interface DraggablePanelOptions {
  /** 面板根元素（用来读实际位置与高度）。 */
  rootRef: Ref<HTMLElement | null>
  /** 面板尺寸（视口坐标）。 */
  size: { w: number; h: number }
  /** 视口边距。 */
  margin: number
  /** 当前位置（`null` = 还没被拖过，由组件算默认落点）。 */
  position: () => { x: number; y: number } | null
  /** 写回位置。 */
  moveTo: (x: number, y: number) => void
  /** 面板是否打开（视口变化时决定要不要拉回可见区域）。 */
  isOpen: () => boolean
}

export interface DraggablePanelHandle {
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
}

export function useDraggablePanel(options: DraggablePanelOptions): DraggablePanelHandle {
  let drag: { pointerId: number; dx: number; dy: number } | null = null

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    const rect = options.rootRef.value?.getBoundingClientRect()
    if (!rect) return
    // 保留抓取点偏移：从哪儿按下的，就从哪儿拖
    drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return
    const { w } = options.size
    const h = options.rootRef.value?.offsetHeight ?? options.size.h
    const m = options.margin
    // 限制在视口内；到边就停住（不回弹 —— 这是精确摆放，不是甩动）
    const x = Math.min(Math.max(event.clientX - drag.dx, m), window.innerWidth - w - m)
    const y = Math.min(Math.max(event.clientY - drag.dy, m), window.innerHeight - h - m)
    options.moveTo(x, y)
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag = null
  }

  /** 视口变化时把面板拉回可见区域（否则缩放后可能跑到屏幕外）。 */
  function clampToViewport(): void {
    const pos = options.position()
    if (!options.isOpen() || !pos) return
    const { w } = options.size
    const h = options.rootRef.value?.offsetHeight ?? options.size.h
    const m = options.margin
    options.moveTo(
      Math.min(Math.max(pos.x, m), window.innerWidth - w - m),
      Math.min(Math.max(pos.y, m), window.innerHeight - h - m)
    )
  }

  onMounted(() => window.addEventListener('resize', clampToViewport))
  onBeforeUnmount(() => window.removeEventListener('resize', clampToViewport))

  return { onPointerDown, onPointerMove, onPointerUp }
}
