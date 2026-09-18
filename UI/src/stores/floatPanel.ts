/**
 * 悬浮追问窗的状态（单实例）。
 *
 * 为什么是「单实例」：核心场景是**边看动画边问**，同时开两个窗反而互相遮挡，
 * 而且学生的心智是"我正在问这个"，不是"我开了两个会话"。所以切换关联对象时
 * **复用同一个窗**，只换标题与上下文——不叠加、不层叠。
 *
 * 位置存在 store 里而不是组件里：窗口被关掉再打开时，位置应当延续
 * （学生会把它拖到不遮住动画的地方，这个选择应该被记住）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** 追问的对象：决定标题与给学生的建议问法 */
export interface FloatSubject {
  kind: 'animation' | 'coding' | 'quiz' | 'general'
  /** 关联对象的名字，显示在标题栏 */
  title: string
  /** 一句话提示可以问什么（原型阶段替代真实的"围绕此内容"约束） */
  hint?: string
}

const KIND_LABEL: Record<FloatSubject['kind'], string> = {
  animation: '动画',
  coding: '编程',
  quiz: '闯关',
  general: '问答'
}

/** 默认尺寸与边距（视口坐标） */
const DEFAULT_SIZE = { w: 380, h: 460 }
const MARGIN = 24

/**
 * 右侧要避让的宽度：右栏（288px）+ 一点缝。
 * 默认落在"正文区右下角"，而不是"窗口右下角" —— 压住右栏会让
 * 「学习上下文 / 工具轨迹」这些答辩证据看不见，而它们正是要展示的东西。
 */
const RAIL_AVOID = 288 + 16

export const useFloatPanel = defineStore('floatPanel', () => {
  const open = ref(false)
  const collapsed = ref(false)
  const subject = ref<FloatSubject | null>(null)

  /** 视口坐标；null = 还没被拖过，由组件算默认落点（右下角） */
  const pos = ref<{ x: number; y: number } | null>(null)

  /** 触发按钮的视口坐标 —— 出场动画的 transform-origin 锚在这里 */
  const origin = ref<{ x: number; y: number } | null>(null)

  const kindLabel = computed(() =>
    subject.value ? KIND_LABEL[subject.value.kind] : KIND_LABEL.general
  )

  /**
   * 打开（或复用）窗口。
   * `at` 是触发按钮的视口坐标；用来做锚定出场，也用来定位默认落点。
   */
  function openPanel(next: FloatSubject, at?: { x: number; y: number }) {
    const switching = open.value && subject.value?.title !== next.title
    subject.value = next
    if (at) origin.value = at
    // 切换关联对象时保持窗口位置（学生的摆放是有意的）；只清掉折叠态
    if (switching) collapsed.value = false
    open.value = true
  }

  /**
   * 从某个按钮元素打开 —— 顺手把锚点算出来。
   * 让调用方去读 getBoundingClientRect 会把这段样板散到 4 个入口里。
   */
  function openFrom(el: Element | null, next: FloatSubject) {
    const r = el?.getBoundingClientRect()
    openPanel(next, r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined)
  }

  function close() {
    open.value = false
  }

  function toggleCollapsed() {
    collapsed.value = !collapsed.value
  }

  function moveTo(x: number, y: number) {
    pos.value = { x, y }
  }

  /** 默认落点：右下角。首次打开或视口变化时用。 */
  /** 默认落点：正文区右下角（避让侧栏与右栏）。窗口太窄时退化为贴右下角。 */
  function defaultPos() {
    const rightmost = window.innerWidth - DEFAULT_SIZE.w - MARGIN
    return {
      x: Math.max(MARGIN, rightmost - RAIL_AVOID),
      y: Math.max(MARGIN, window.innerHeight - DEFAULT_SIZE.h - MARGIN)
    }
  }

  return {
    open,
    collapsed,
    subject,
    pos,
    origin,
    kindLabel,
    size: DEFAULT_SIZE,
    margin: MARGIN,
    openPanel,
    openFrom,
    close,
    toggleCollapsed,
    moveTo,
    defaultPos
  }
})

export type FloatPanelStore = ReturnType<typeof useFloatPanel>
