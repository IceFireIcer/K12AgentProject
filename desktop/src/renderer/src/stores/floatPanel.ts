/**
 * 悬浮追问窗的状态（单实例）。
 *
 * 为什么是「单实例」：核心场景是**边看动画边问**，同时开两个窗反而互相遮挡，
 * 而且学生的心智是"我正在问这个"，不是"我开了两个会话"。所以切换关联对象时
 * **复用同一个窗**，只换标题与上下文——不叠加、不层叠。
 *
 * 位置存在 store 里而不是组件里：窗口被关掉再打开时，位置应当延续
 * （学生会把它拖到不遮住动画的地方，这个选择应该被记住）。
 *
 * ── 三条几何纪律（2026-09-27 用户裁决，全部**在 store 里夹紧**）──────────
 *   ① **只活在"动手试试"三页**：离开那三页必须关掉（`FLOAT_PANEL_PAGES`），
 *      它不该跟着学生跑到对话页去（那只窗会盖住对话，而对话页自己有阅读栏）。
 *   ② **不能拖出围栏、也不能压住按钮**：围栏 = 内容区（`.shell__content`）的盒子，
 *      窗必须整个待在围栏里。压在顶栏上会盖住窗口按钮（连应用都关不掉），
 *      压在侧栏上会盖住导航 —— 这两条都是"关都关不掉"级别的可达性事故。
 *   ③ **面积按主窗口取比例**：≥15%、≤45%。太小读不了、太大就不是"浮层"了。
 *      判据是**面积**而不是边长 —— 学生拖的是"占多大地方"，不是"几比几"。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useUiStore } from './ui'

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

/**
 * 这只窗**允许存在的页面** —— 恰好是侧栏「动手试试」那一组。
 *
 * ★ 为什么不写成 `PAGES[p].section === '动手试试'` 动态判断：那会把这条纪律
 *   绑在一个**给侧栏分组用的展示字段**上，改侧栏分组就会悄悄改变本窗的可达范围。
 *   这里显式列名字，并且由 `tests/float-panel.test.ts` 断言它与那一组**完全一致**
 *   （两边同时改才过）—— 显式 + 机器校验，比隐式推导可靠。
 */
export const FLOAT_PANEL_PAGES = ['animation', 'coding', 'quiz'] as const

/** 面积比例：主窗口面积的上下限（用户裁决：≥15%、≤45%）。 */
const MAX_AREA_RATIO = 0.45
const MIN_AREA_RATIO = 0.15

/** 名义默认尺寸（面积夹紧会按窗口大小微调它，见 `defaultSize`） */
const DEFAULT_SIZE = { w: 400, h: 500 }

/**
 * 绝对下限：面积比例在**小窗口**下会算出比这更小的值（例如 1024×700 的 15%
 * 只有 ~107k px²，等价 328×328）—— 而窗再矮就放不下"标题栏 + 一行回答 + 输入条"。
 * 所以两条下限**同时成立**（取更严的那条），见 `clampSize`。
 */
const MIN_SIZE = { w: 300, h: 240 }

const MARGIN = 24

/**
 * 右侧要避让的宽度：右栏（288px）+ 一点缝。
 * 默认落在"正文区右下角"，而不是"窗口右下角" —— 压住右栏会让
 * 「学习上下文 / 工具轨迹」这些答辩证据看不见，而它们正是要展示的东西。
 */
const RAIL_AVOID = 288 + 16

/** 围栏：一块矩形（视口坐标）。 */
export interface Fence {
  x: number
  y: number
  w: number
  h: number
}

export const useFloatPanel = defineStore('floatPanel', () => {
  const ui = useUiStore()

  const open = ref(false)
  const collapsed = ref(false)
  const subject = ref<FloatSubject | null>(null)

  /** 视口坐标；null = 还没被拖过，由组件算默认落点（右下角） */
  const pos = ref<{ x: number; y: number } | null>(null)

  /** 当前尺寸（可被拖拽改变）。组件必须把它落到 `height` 上，见 MIN_SIZE 的注释。 */
  const size = ref({ ...DEFAULT_SIZE })

  /** 触发按钮的视口坐标 —— 出场动画的 transform-origin 锚在这里 */
  const origin = ref<{ x: number; y: number } | null>(null)

  const kindLabel = computed(() =>
    subject.value ? KIND_LABEL[subject.value.kind] : KIND_LABEL.general
  )

  /* ------------------------------------------------------------------ *
   * 围栏与尺寸（几何的唯一真相）
   * ------------------------------------------------------------------ */

  /**
   * 围栏 = **内容区**的盒子（`.shell__content`）。
   *
   * ★ 为什么用内容区而不是整个视口：顶栏（72px，含窗口的 最小化/最大化/关闭）
   *   与侧栏（导航）都在内容区之外 —— 把窗拖到它们上面就是"挡住按钮"，
   *   最坏情况是盖住窗口按钮后**应用都关不掉**。围栏取内容区，这两个问题
   *   一次性消失，而且不必逐个控件去算避让区。
   * ★ 取不到元素时退回视口（单测 / 极端时序）：宁可宽松一点，也不能不设围栏。
   */
  function fenceRect(): Fence {
    const el = document.querySelector('.shell__content')
    const r = el?.getBoundingClientRect()
    if (r && r.width > 0 && r.height > 0) {
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
  }

  /** 主窗口面积（用户口径：比例都按它算）。 */
  function windowArea(): number {
    return window.innerWidth * window.innerHeight
  }

  /**
   * 按面积比例 + 围栏把尺寸夹到合法区间。
   *
   * 顺序有实义（每一档的边界都不一样）：
   *   ① 边长绝对下限（内容放得下）
   *   ② 围栏上限（窗不能比它待的地方还大）—— 硬约束，优先于面积
   *   ③ 面积下限（≥15%）：等比放大到刚好达标，再回夹围栏
   *   ④ 面积上限（≤45%）：等比缩小（只会更小，围栏仍满足）
   */
  function clampSize(w: number, h: number): { w: number; h: number } {
    const fence = fenceRect()
    const maxW = Math.max(MIN_SIZE.w, fence.w - MARGIN * 2)
    const maxH = Math.max(MIN_SIZE.h, fence.h - MARGIN * 2)

    let outW = Math.min(Math.max(w, MIN_SIZE.w), maxW)
    let outH = Math.min(Math.max(h, MIN_SIZE.h), maxH)

    const area = windowArea()
    const minArea = MIN_AREA_RATIO * area
    const maxArea = MAX_AREA_RATIO * area

    if (outW * outH < minArea) {
      const k = Math.sqrt(minArea / (outW * outH))
      outW = Math.min(outW * k, maxW)
      outH = Math.min(outH * k, maxH)
    }
    if (outW * outH > maxArea) {
      const k = Math.sqrt(maxArea / (outW * outH))
      outW *= k
      outH *= k
    }
    return {
      w: Math.round(Math.min(Math.max(outW, MIN_SIZE.w), maxW)),
      h: Math.round(Math.min(Math.max(outH, MIN_SIZE.h), maxH))
    }
  }

  /** 默认尺寸：名义值先过一遍同一套夹紧（窗口大时它会自动长大到 15% 以上）。 */
  function defaultSize(): { w: number; h: number } {
    return clampSize(DEFAULT_SIZE.w, DEFAULT_SIZE.h)
  }

  /**
   * 默认落点：内容区右下角。
   * ★ 用围栏算而不是用视口算 —— 否则窄窗口下它会落在侧栏上（那正是"挡住按钮"）。
   */
  function defaultPos(): { x: number; y: number } {
    const fence = fenceRect()
    const rightmost = fence.x + fence.w - size.value.w - MARGIN
    return {
      x: Math.max(fence.x + MARGIN, rightmost - RAIL_AVOID),
      y: Math.max(fence.y + MARGIN, fence.y + fence.h - size.value.h - MARGIN)
    }
  }

  /** 把位置夹进围栏（窗比围栏小是前提，`clampSize` 已保证）。 */
  function clampPos(x: number, y: number): { x: number; y: number } {
    const fence = fenceRect()
    const maxX = Math.max(fence.x + MARGIN, fence.x + fence.w - size.value.w - MARGIN)
    const maxY = Math.max(fence.y + MARGIN, fence.y + fence.h - size.value.h - MARGIN)
    return {
      x: Math.round(Math.min(Math.max(x, fence.x + MARGIN), maxX)),
      y: Math.round(Math.min(Math.max(y, fence.y + MARGIN), maxY))
    }
  }

  /* ------------------------------------------------------------------ *
   * 开 / 关
   * ------------------------------------------------------------------ */

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
    // 每次打开都重新夹一遍：窗口可能刚被缩过、或上次关掉之后换了页面尺寸
    setSize(size.value.w, size.value.h)
    open.value = true
  }

  /**
   * 从某个按钮打开 —— 顺手把锚点算出来。
   * 让调用方去读 getBoundingClientRect 会把这段样板散到 4 个入口里。
   */
  function openFrom(el: Element | null, next: FloatSubject) {
    const r = el?.getBoundingClientRect()
    openPanel(next, r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined)
  }

  /**
   * 从入口按钮**切换**：已经打开且说的是同一个对象 → 关掉。
   *
   * ★ 为什么需要（2026-09-27 走查）：入口按钮此前只开不关 —— 点第二次没有任何反应，
   *   而它看起来就是个开关。用户的原话是「再点一次悬浮窗居然关不掉」。
   *
   * ★★ 判据必须带上 **kind**（2026-09-27 真机实测踩到）：
   *   只比 `title` 时，三页的入口会因为**指向同一个知识点**而撞名 ——
   *   学生在编程页开着窗、切到闯关页点入口，本意是"换到这一页的上下文"，
   *   却因为标题相同被判成"再点一次"而**把窗关掉**（实测：点闯关入口后 panel=null）。
   *   `kind` 是"这扇窗在讲哪一类东西"（动画 / 编程 / 闯关），拿它一起判才符合直觉：
   *   同一个人从同一页再点 → 关；换了页 / 换了对象 → 复用窗并换内容。
   */
  function toggleFrom(el: Element | null, next: FloatSubject) {
    if (open.value && subject.value?.kind === next.kind && subject.value?.title === next.title) {
      close()
      return
    }
    openFrom(el, next)
  }

  function close() {
    open.value = false
  }

  function toggleCollapsed() {
    collapsed.value = !collapsed.value
  }

  /** 移动（拖动用）。**在 store 里夹进围栏**，调用方只管给指针算出的原始坐标。 */
  function moveTo(x: number, y: number) {
    pos.value = clampPos(x, y)
  }

  /**
   * 改尺寸（拖拽改大小 / 打开时校正用）。**在 store 里夹紧**，不靠调用方自觉：
   *   ① 面积比例与围栏见 `clampSize`；
   *   ② 夹紧后**重新夹紧位置** —— 窗变大了还不移位，右边/下边就出围栏了。
   *
   * ★★ 位置夹紧**不能只在"用户拖过窗"时才做**（曾踩过）：从未拖过时 `pos` 是 null
   *   （位置由 `defaultPos()` 现算），早先写成 `if (pos.value)`，于是"刚打开就拉大"
   *   会把窗推出围栏下缘，连右下角的改大小手柄都够不着。
   *   所以这里把默认落点**实体化**再夹紧：位置一旦被显式记住就永远可夹。
   */
  function setSize(w: number, h: number) {
    size.value = clampSize(w, h)
    const base = pos.value ?? defaultPos()
    pos.value = clampPos(base.x, base.y)
  }

  /** 视口 / 内容区变化后重新夹一遍（由组件在 resize 时调用）。 */
  function reclamp() {
    setSize(size.value.w, size.value.h)
  }

  /* ------------------------------------------------------------------ *
   * 只在"动手试试"三页存在
   * ------------------------------------------------------------------ */

  /**
   * 离开允许的页面就关掉。
   * ★ 为什么必须有：这只窗挂在**外壳**上（换页不卸载，位置与记录得以延续 ——
   *   那正是"边看动画边问"要的连续性），代价是它不会自己随页面消失。
   *   学生切到对话页后它会继续盖在对话上，而对话页有自己的阅读栏与输入条。
   *   用户的原话是「不能跨页面到问问智团团」。
   */
  function closeIfPageDisallowed(page: string): void {
    if (!(FLOAT_PANEL_PAGES as readonly string[]).includes(page)) close()
  }

  /** 交给我们自己的 watcher 用（见下方 `initPageFence`）。 */
  function initPageFence(): void {
    watch(
      () => ui.page,
      (page) => closeIfPageDisallowed(page),
      { immediate: true }
    )
  }

  return {
    open,
    collapsed,
    subject,
    pos,
    origin,
    kindLabel,
    size,
    margin: MARGIN,
    maxAreaRatio: MAX_AREA_RATIO,
    minAreaRatio: MIN_AREA_RATIO,
    openPanel,
    openFrom,
    toggleFrom,
    close,
    toggleCollapsed,
    moveTo,
    setSize,
    reclamp,
    defaultPos,
    defaultSize,
    fenceRect,
    clampSize,
    closeIfPageDisallowed,
    initPageFence
  }
})

export type FloatPanelStore = ReturnType<typeof useFloatPanel>
