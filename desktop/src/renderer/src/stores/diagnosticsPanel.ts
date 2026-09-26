/**
 * 演示浮窗的状态（**独立于「追问窗」的第二只单实例浮窗**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么不复用「追问窗」那个 store
 * ══════════════════════════════════════════════════════════════════════════
 * 两只窗的**语义正交**：
 *   · 追问窗是**可交互**的（学生围绕一份内容继续问，那里面有输入框、有对话）；
 *   · 机制浮窗是**只读**的（把这一轮背后的机制摊开给评委看，一个可写控件都没有）。
 * 合成一只窗的代价是：要么给追问窗加一个模式分支（两种语义挤在一个组件里，
 * 关掉演示模式时还得小心别把学生的追问记录一起关了），
 * 要么让只读窗继承一堆它用不到的状态。两只独立实例、共用拖拽逻辑更干净。
 *
 * ★ 位置**不持久化**（与追问窗不同）：演示浮窗是「这一场要摊在哪儿」的临时摆放，
 *   而追问窗的位置是学生长期的阅读习惯。两者判据不同，不要顺手对齐。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 默认尺寸与边距（视口坐标）。比追问窗矮一点：它是摘要，不是谈判桌。 */
const DEFAULT_SIZE = { w: 420, h: 320 }
const MARGIN = 24

/**
 * 右侧要避让的宽度：右栏（288px）+ 一点缝。
 *
 * ★ 与 `stores/floatPanel.ts` 同一个理由：默认落在「正文区右下角」而不是「窗口右下角」——
 *   压住右栏会让「学习上下文 / 工具轨迹」这些答辩证据看不见，而它们正是要展示的东西。
 */
const RAIL_AVOID = 288 + 16

export const useDiagnosticsPanel = defineStore('diagnosticsPanel', () => {
  const open = ref(false)
  const collapsed = ref(false)
  /** 视口坐标；`null` = 还没被拖过，由组件算默认落点（右下角）。 */
  const pos = ref<{ x: number; y: number } | null>(null)
  /** 触发按钮的视口坐标 —— 出场动画的 `transform-origin` 锚在这里。 */
  const origin = ref<{ x: number; y: number } | null>(null)

  function openPanel(at?: { x: number; y: number }): void {
    if (at) origin.value = at
    open.value = true
  }

  /** 从某个按钮元素打开 —— 顺手把锚点算出来（调用方不必读 `getBoundingClientRect`）。 */
  function openFrom(el: Element | null): void {
    const rect = el?.getBoundingClientRect()
    openPanel(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined)
  }

  function close(): void {
    open.value = false
  }

  function toggle(): void {
    open.value = !open.value
  }

  function toggleCollapsed(): void {
    collapsed.value = !collapsed.value
  }

  function moveTo(x: number, y: number): void {
    pos.value = { x, y }
  }

  /** 默认落点：正文区右下角（避让侧栏与右栏）。窗口太窄时退化为贴右下角。 */
  function defaultPos(): { x: number; y: number } {
    const rightmost = window.innerWidth - DEFAULT_SIZE.w - MARGIN
    return {
      x: Math.max(MARGIN, rightmost - RAIL_AVOID),
      y: Math.max(MARGIN, window.innerHeight - DEFAULT_SIZE.h - MARGIN)
    }
  }

  return {
    open,
    collapsed,
    pos,
    origin,
    size: DEFAULT_SIZE,
    margin: MARGIN,
    openPanel,
    openFrom,
    close,
    toggle,
    toggleCollapsed,
    moveTo,
    defaultPos
  }
})
