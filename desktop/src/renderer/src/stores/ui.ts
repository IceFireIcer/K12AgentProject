/**
 * 界面外壳状态（Pinia）：**当前在哪个视图**。
 *
 * ---------------------------------------------------------------------------
 * 为什么要从 `App.vue` 里把这个状态抽出来
 * ---------------------------------------------------------------------------
 * 原来 `App.vue` 里一句 `const view = ref<'chat' | 'settings'>('chat')` 就够了
 * —— 顶栏那个按钮是**唯一**的切换入口。
 *
 * 现在不同了：学习档案里的「去练一练」（错题本 → 回对话页接着练）**也要切视图**。
 * 那是子组件里的动作，改不了父组件的本地 ref。所以「当前视图」必须变成一个
 * 共享状态，否则只能靠 `emit` 一层层往上冒 —— 而每加一个跨视图跳转就要多穿一层。
 *
 * ---------------------------------------------------------------------------
 * 为什么不用 vue-router
 * ---------------------------------------------------------------------------
 * 视图只有三个，且**没有 URL / 前进后退 / 深链**这类需求（Electron 单窗口应用）。
 * 引一个路由库等于为一个 `ref<string>` 付出一份依赖与一套新概念。
 * 视图切换的语义在这里一目了然，也就没必要抽象。
 *
 * ⚠️ 视图组件**必须挂在 `<KeepAlive>` 里**（见 `App.vue` 的注释）：学生写的代码、
 *    练习作答、动画播放进度只存在于卡片组件内部，不在 store 里；用 `v-if` 直接销毁
 *    会把这些全部丢掉。本文件只负责「切到哪个视图」，**不负责挂载方式**。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 三个视图（`chat` 对话 / `study` 学习档案 / `settings` 设置）。 */
export type ViewName = 'chat' | 'study' | 'settings'

/** 学习档案里的分页（错题本 / 报告 / …）。 */
export type StudyTab = 'report' | 'mistakes' | 'chapters' | 'map' | 'sessions'

export const useUiStore = defineStore('ui', () => {
  const view = ref<ViewName>('chat')
  const studyTab = ref<StudyTab>('report')

  /** 切视图。可选地**同时**指定学习档案里显示哪一页（「看错题」这类入口用）。 */
  function show(next: ViewName, tab?: StudyTab): void {
    view.value = next
    if (tab) studyTab.value = tab
  }

  /**
   * 顶栏按钮的循环顺序（对话 → 学习档案 → 设置 → 对话）。
   *
   * ★ 顺序固定在这里而不是组件里：顶栏按钮的文案要显示「下一个是什么」，
   *   两处各写一份顺序迟早对不上（按钮写着「去设置」，点下去却到了学习档案）。
   */
  return { view, studyTab, show }
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
