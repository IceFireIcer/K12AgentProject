/**
 * 界面外壳状态（Pinia）：**当前在哪一页**。
 *
 * ---------------------------------------------------------------------------
 * 为什么不用 vue-router
 * ---------------------------------------------------------------------------
 * 这是 Electron 单窗口应用，**没有 URL / 前进后退 / 深链**这类需求。
 * 引一个路由库等于为一个 `ref<string>` 付出一份依赖与一套新概念。
 *
 * ★ 更重要的是**单一真相**：页面清单（侧栏导航、顶栏标题与副标题、滚动归零）
 *   全部从下面的 `PAGES` 推导。如果同时存在 router 与 store 两处真相，
 *   迟早在「侧栏高亮的是这一页、内容区渲染的是那一页」上对不上。
 *
 * ⚠️ 视图组件**必须挂在 `<KeepAlive>` 里**（见 `App.vue` 的注释）：学生写的代码、
 *    练习作答、动画播放进度只存在于卡片组件内部，不在 store 里；用 `v-if` 直接销毁
 *    会把这些全部丢掉。本文件只负责「切到哪一页」，**不负责挂载方式**。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * 全部页面（**侧栏可见与否都在这里**）。
 *
 * ★「能力」与「学习数据」两个分组是设计稿的分组；`section: ''` 的项独占一组、
 *   不渲染组标题（对话是主入口，不该被塞进某个分组里）。
 */
export type PageName =
  | 'chat'
  | 'animation'
  | 'coding'
  | 'quiz'
  | 'study'
  | 'settings'
  | 'knowledge'
  | 'dependency'

/** 学习档案里的分页（概览 / 错题本 / 章节 / 地图 / 会话）。 */
export type StudyTab = 'report' | 'mistakes' | 'chapters' | 'map' | 'sessions'

export interface PageMeta {
  /** 页面中文名（侧栏项 + 顶栏标题）。 */
  title: string
  /** 顶栏副标题（页面没有自己的动态副标题时用它）。 */
  subtitle?: string
  /** 侧栏分组名；空串 = 独占一组且不渲染组标题。 */
  section: string
  /** 是否出现在侧栏。`false` 的页面**必须有别的入口** —— 本项目没有 router，
   *  没有入口就等于点不到（`knowledge` / `dependency` 曾因此变成死页面，见 D-040 的补记）。 */
  nav: boolean
  /** 侧栏图标名（`lucide-vue-next` 的组件名）。 */
  icon?: string
}

/**
 * 页面清单（**唯一来源**）。
 *
 * 侧栏、顶栏标题、`document.title` 的副标题都读它；新增页面只改这一处。
 */
export const PAGES: Record<PageName, PageMeta> = {
  chat: { title: '对话课堂', section: '', nav: true, icon: 'MessageCircle' },
  animation: { title: '动画讲解', section: '能力', nav: true, icon: 'Clapperboard' },
  coding: { title: '编程环境', section: '能力', nav: true, icon: 'Code' },
  quiz: { title: '闯关练习', section: '能力', nav: true, icon: 'Trophy' },
  study: {
    title: '学习档案',
    subtitle: '掌握度 · 学段轨迹 · 学习记录',
    section: '学习数据',
    nav: true,
    icon: 'Radar'
  },
  settings: {
    title: '设置',
    subtitle: '模型接入 · 本地服务 · 隐私',
    section: '学习数据',
    nav: true,
    icon: 'Settings'
  },
  // 数据层检视页：**挂进侧栏**。
  //
  // ★ 设计原型把它们标成 `nav: false`（「开发/数据检视」页，不进学生日常导航），
  //   但原型是 **router 驱动**的 —— 那时可以直接改哈希进得去。
  //   本项目没有 router（见 D-040），`nav: false` 于是等于**这两页点不到**：
  //   实测确认全仓没有任何一处导航到它们，而「教材知识库」里恰恰有
  //   **导入教材 / 重建索引**这两个真实功能（`knowledge:import` / `knowledge:rebuild`）。
  //   做了却进不去的功能等于没做，所以这里改成进侧栏、放在「学习数据」组末尾。
  knowledge: {
    title: '教材知识库',
    subtitle: '四学段分块 · 向量索引状态 · 导入与重建',
    section: '学习数据',
    nav: true,
    icon: 'Library'
  },
  dependency: {
    title: '依赖图谱',
    subtitle: '知识点前置关系（from 是前置）',
    section: '学习数据',
    nav: true,
    icon: 'GitBranch'
  }
}

/** 侧栏渲染顺序（分组顺序 = 数组顺序，组内 = 数组顺序）。 */
export const PAGE_ORDER: readonly PageName[] = [
  'chat',
  'animation',
  'coding',
  'quiz',
  'study',
  'knowledge',
  'dependency',
  'settings'
]

/* ------------------------------------------------------------------ *
 * 兼容层：顶栏的三步循环与 `studyTab`
 * ------------------------------------------------------------------ */

/** 三个「主视图」（对话 / 学习档案 / 设置）—— 顶栏按钮按它循环。 */
export type ViewName = 'chat' | 'study' | 'settings'

/** 三个主视图对应的页面名（学习档案是 `study`，其余同名）。 */
const VIEW_TO_PAGE: Record<ViewName, PageName> = {
  chat: 'chat',
  study: 'study',
  settings: 'settings'
}

/** 页面名 → 主视图；非主视图（动画/编程/闯关/知识库/依赖图）返回 `null`。 */
export function viewOfPage(page: PageName): ViewName | null {
  return page === 'chat' || page === 'study' || page === 'settings' ? page : null
}

export const useUiStore = defineStore('ui', () => {
  const page = ref<PageName>('chat')
  /** 学习档案的分页；「去练一练」这类入口会顺手指定它。 */
  const studyTab = ref<StudyTab>('report')

  /**
   * 当前**主视图**（只读派生）。
   *
   * ★ 它不再是独立状态：`page` 是唯一真相，`view` 由它派生 —— 两者各存一份
   *   就会出现「顶栏按钮按 view 循环、内容区按 page 渲染」的错位。
   * ★ 保留这个名字是因为它已是**对外契约**：`ui-shell.test.ts`、`App.vue` 的
   *   顶栏按钮、以及 `verify-ui.mjs` 的 `view-entry` 循环都按它取当前主视图。
   *   非主视图（动画/编程/闯关/知识库/依赖图）回落到 `chat`。
   */
  const view = computed<ViewName>(() => viewOfPage(page.value) ?? 'chat')

  /**
   * 切页。可选地**同时**指定学习档案里显示哪一页（「看错题」这类入口用）。
   */
  function show(next: ViewName, tab?: StudyTab): void {
    page.value = VIEW_TO_PAGE[next]
    if (tab) studyTab.value = tab
  }

  /** 切到任意页（含非主视图的动画/编程/闯关/知识库/依赖图）。 */
  function go(next: PageName): void {
    page.value = next
  }

  /** 切到学习档案并指定分页（「去闯关检验」这类跨页跳转用）。 */
  function showStudy(tab: StudyTab): void {
    page.value = 'study'
    studyTab.value = tab
  }

  /** 顶栏按钮循环：等价于 `show(nextView(view))`。 */
  function cycleView(): void {
    show(nextView(view.value))
  }

  return { page, view, studyTab, show, go, showStudy, cycleView }
})

/** 视图顺序 + 顶栏按钮文案（**唯一来源**，`App.vue` 与测试都读它）。 */
export const VIEW_ORDER: readonly ViewName[] = ['chat', 'study', 'settings']

/** 每个视图上顶栏按钮显示的文案（指向**下一个**视图）。 */
export const VIEW_LABELS: Record<ViewName, string> = {
  chat: '学习档案',
  study: '设置',
  settings: '返回对话'
}

/** 视图的中文名（面包屑 / 断言用）。 */
export const VIEW_TITLES: Record<ViewName, string> = {
  chat: '对话',
  study: '学习档案',
  settings: '设置'
}

/** 下一个视图（顶栏按钮点击后到达的那一个）。 */
export function nextView(current: ViewName): ViewName {
  const at = VIEW_ORDER.indexOf(current)
  return VIEW_ORDER[(at + 1) % VIEW_ORDER.length]
}
