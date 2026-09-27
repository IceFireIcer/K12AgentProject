/**
 * 可拖拽浮层的**公共拖拽逻辑**（当前消费者只有一个：`DiagnosticsPanel.vue`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 与 `FloatPanel.vue` 的真实关系（2026-09-27 校准）
 * ══════════════════════════════════════════════════════════════════════════
 * 这段注释此前写的是「`FloatPanel.vue` 与 `DiagnosticsPanel.vue` 共用」—— **已经过时**。
 * 事实是：`FloatPanel.vue` 在 2026-09-27 的走查里**就地内联**了一份带 `isInteractive()`
 * 的修复版（因为没有意识到这里有一份公共实现可取用），修复没有回灌到这里。
 *   - `FloatPanel.vue`  → 本地实现（`components/FloatPanel.vue` 内的拖拽三件套）
 *   - 本文件            → 只有 `DiagnosticsPanel.vue` 在用
 * ★ 于是现在的纪律是：**两处独立实现，但必须行为一致**。改任何一边的拖拽判据
 *   （尤其是下面「放过可交互子元素」那一条），另一边必须同步改 —— 否则会出现
 *   「追问窗的 X 点得动、机制浮窗的 X 点不动」这种最难查也最难解释的不一致。
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

  /**
   * 「这一下按在可交互子元素上」的判据 —— 命中就完全不进拖拽路径。
   *
   * ★★ 这是**同一个 bug 的第二次出现**（2026-09-27 走查的真事故，用户实测
   *   「机制浮窗没法关掉」）：标题栏里有关闭 / 折叠 / 固定三颗按钮，而
   *   `setPointerCapture` 会把后续指针事件**全部重定向到捕获元素**（标题栏），
   *   于是按钮上的 `click` 永远不触发 —— 表现就是「X 点不动、折叠没反应」。
   *   `.stop` 挡不住它：那是**点击**事件的冒泡，不是指针捕获的重定向。
   *
   *   第一次出现在 `FloatPanel.vue`（追问窗的 X / 最小化点不动）。当时在组件里
   *   **就地内联**修好了，但**没有回灌到本文件** —— 而 `DiagnosticsPanel.vue` 用的
   *   正是这份未修复版，于是同一只 bug 换了个窗又演了一遍。
   *   → 两处实现的关系与同步纪律见文件头；这条判据必须与 `FloatPanel.vue` 逐字一致。
   *
   * 判据放宽到「表单控件 + 链接」而不只是 button：从 `<svg>`（lucide 图标）上按下的
   * 也算 —— 事件目标是**最深的那个元素**，`closest()` 负责把它折算回按钮/控件。
   */
  function isInteractive(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('button, input, textarea, select, a[href]') !== null
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    // ★ 必须放在捕获指针**之前**：一旦捕获，按钮就再也收不到 click（见 isInteractive）
    if (isInteractive(event.target)) return
    const rect = options.rootRef.value?.getBoundingClientRect()
    if (!rect) return
    // 保留抓取点偏移：从哪儿按下的，就从哪儿拖
    drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    // `!drag` 这一半不只是防重复指针：上面放过按钮时**根本没有捕获指针**，
    // 那条路径上的 move 必然在这里被拦住（没有 start 就没有 move）。
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
    // 同 `onPointerMove`：`!drag` 同时兜住「没进拖拽路径所以没捕获指针」的那一次抬手
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
