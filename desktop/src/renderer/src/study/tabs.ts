/**
 * 学习档案的**分页注册表**（唯一来源）。
 *
 * 为什么把「有哪几页」抽成一个数组，而不是在 `Study.vue` 的模板里写五个 `<button>`：
 *   ① 按钮、内容区、以及 `stores/ui.ts` 里的 `StudyTab` 类型**必须一致** ——
 *      三处各写一份的话，加一页时漏掉任何一处都会表现成「点了按钮没反应」；
 *   ② 内容区用 `<component :is>` 动态渲染，`KeepAlive` 要靠组件名做缓存键，
 *      所以每页的组件必须显式写出 `name`（见下面各组件里的 `defineOptions`）。
 *
 * ★ 顺序就是界面上的顺序：**报告 → 错题本 → 章节进度 → 学习地图 → 会话**。
 *   报告放第一是因为它是「这一周学得怎么样」的总览（进来先看结论）。
 */

import type { Component } from 'vue'
import type { StudyTab } from '../stores/ui'
import ReportTab from './ReportTab.vue'
import MistakesTab from './MistakesTab.vue'
import ChaptersTab from './ChaptersTab.vue'
import MapTab from './map/MapTab.vue'
import SessionsTab from './SessionsTab.vue'

export interface StudyTabEntry {
  id: StudyTab
  /** 按钮文案 */
  label: string
  /** 一句话说明（放在内容区顶部；也是 `title` 属性） */
  hint: string
  component: Component
}

export const STUDY_TABS: readonly StudyTabEntry[] = [
  {
    id: 'report',
    label: '学习报告',
    hint: '这一段时间学了多少、会了什么、学段怎么变的。',
    component: ReportTab
  },
  {
    id: 'mistakes',
    label: '错题本',
    hint: '哪些知识点答错过、错了多少次 —— 可以一键回对话里再练一遍。',
    component: MistakesTab
  },
  {
    id: 'chapters',
    label: '章节进度',
    hint: '教材每一章你掌握到了哪一步。',
    component: ChaptersTab
  },
  {
    id: 'map',
    label: '学习地图',
    hint: '知识点的前后依赖关系：先学什么，再学什么。',
    component: MapTab
  },
  {
    id: 'sessions',
    label: '历史会话',
    hint: '以前聊过什么 —— 可以搜索，也可以点开回看（只读）。',
    component: SessionsTab
  }
]

/** 取一页的注册项（找不到时退回第一页：`StudyTab` 是联合类型，理论上不会走到）。 */
export function findStudyTab(id: StudyTab): StudyTabEntry {
  return STUDY_TABS.find((tab) => tab.id === id) ?? STUDY_TABS[0]
}
