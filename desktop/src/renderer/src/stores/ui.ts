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
 * 三档视角（从小到大 = 能看到的内部信息从少到多）：`student` / `teacher` / `debug`。
 *
 * ★★ 类型与档位表**住在这里**（`stores/ui.ts`）而不是 `stores/viewMode.ts`：
 *   本文件被 `tests/student-view-discipline.test.ts` 与 `tests/ui-shell.test.ts`
 *   **直接用 Node 的 ESM 加载器 import**，而 Node 解析不了渲染进程里那种不带后缀的相对
 *   import。所以这里必须是一个**零运行时 import** 的纯模块 —— `stores/viewMode.ts`
 *   用 `import type` 反过来拿这个类型（类型 import 编译后完全擦除，不会产生那条边）。
 */
export type ViewMode = 'student' | 'teacher' | 'debug'

/** 档位从低到高（**唯一判据**：`visibleInSidebar` / `requiredViewFor` / ViewMode 的派生标志都对齐它）。 */
export const VIEW_MODE_ORDER: readonly ViewMode[] = ['student', 'teacher', 'debug']

/** `mode` 是否**至少**达到 `required`（`required === null` = 所有档位都能看）。 */
export function viewModeAllows(mode: ViewMode, required: ViewMode | null): boolean {
  if (required === null) return true
  return VIEW_MODE_ORDER.indexOf(mode) >= VIEW_MODE_ORDER.indexOf(required)
}

/**
 * 全部页面（**侧栏可见与否都在这里**）。
 *
 * ★ 三个分组（2026-09-21 起）：`跟团团聊` / `动手试试` / `我的记录`。
 *   原来两组叫「能力」与「学习数据」—— 前者对学生没有意义（什么能力？），
 *   后者把「设置」也算了进去（设置不是学习数据）。
 *   ⚠️ 现在**没有页面再用空串 section**（空串 = 独占一组且不渲染组标题；
 *   对话页原来用它，2026-09-21 起归入「跟团团聊」，因为那一组就是它的入口）。
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
  | 'demo'

/**
 * 学习档案里的分页（概览 / 错题本 / 章节 / 地图 / **学习历史** / 会话）。
 *
 * ★ 2026-09-30 加第六页「**学习历史**」（用户裁决）：`report` 给的是**聚合**
 *   （每天多少条、正确率、连续天数），学生要能回看**逐条流水**
 *   （几点几分做了什么）。两者读同一张 `learning_history` 表，回答的是不同问题
 *   —— 聚合页答「我这一周怎么样」，流水页答「我那天到底做了什么」。
 */
export type StudyTab = 'report' | 'mistakes' | 'chapters' | 'map' | 'history' | 'sessions'

export interface PageMeta {
  /** 页面中文名（侧栏项 + 顶栏标题）。 */
  title: string
  /** 顶栏副标题（页面没有自己的动态副标题时用它）。 */
  subtitle?: string
  /** 侧栏分组名；空串 = 独占一组且不渲染组标题。 */
  section: string
  /**
   * 侧栏可见性：
   *   `true`      —— 学生与教师视角都显示；
   *   `'teacher'` —— **只在教师 / 答辩视角及更高档显示**（数据检视 / 破坏性运维类页面，
   *                  以及运行透视：技术证据摆在那一页，但学生面看不到）；
   *   `'debug'`   —— **只在演示 / 调试档显示**（Prompt 原文与原始信封最细的那一层）；
   *   `false`     —— 不进侧栏，**必须有别的入口**（本项目没有 router，
   *                  没有入口就等于点不到，见 D-040 的补记）。
   *
   * ★ `'teacher'` 与 `false` 的区别是**故意的**：前者「功能仍在、只是默认不给学生看」
   *   （入口在设置页的高级区里说清怎么打开），后者「本来就不该出现在导航里」。
   *   判据见 `visibleInSidebar()` —— 侧栏不要自己比较这个字段。
   */
  nav: boolean | 'teacher' | 'debug'
  /** 侧栏图标名（`lucide-vue-next` 的组件名）。 */
  icon?: string
}

/**
 * 某一页在当前视角下是否进侧栏（**唯一判据**，侧栏组件不要自己比较 `nav`）。
 *
 * ★ 收口成一个函数的原因：`nav` 现在是三态联合，`nav === true` 与 `nav !== false`
 *   这两种「差不多」的写法在 `'teacher'` 上给出相反结果，而写错的表现是
 *   「教师视角下知识库页不见了」—— 一个只有评委才会发现、且会被当成功能没做的错误。
 */
export function visibleInSidebar(meta: PageMeta, mode: ViewMode): boolean {
  if (meta.nav === true) return true
  // ★ 判据是**档位高低**（`viewModeAllows`）：演示档看得到教师档的页，反过来看不到 ——
  //   否则一进演示模式，「参考资料库」会突然从侧栏消失，看起来像功能坏了。
  if (meta.nav === 'teacher' || meta.nav === 'debug') return viewModeAllows(mode, meta.nav)
  return false
}

/**
 * 页面清单（**唯一来源**）。
 *
 * 侧栏、顶栏标题、`document.title` 的副标题都读它；新增页面只改这一处。
 *
 * ★★ 2026-09-21 重命名 + 重新分组（D-064）。两件事：
 *   ① **标题去课程色彩**：产品定位是「7×24 在线的 AI 老师」，我们没有「课程」——
 *      教材与知识点只是回答时的**参考**。所以「对话课堂 → 问问智团团」、
 *      「闯关练习 → 闯关挑战」、「学习档案 → 学习记录」、「教材知识库 → 参考资料库」、
 *      「学习地图 → 知识图谱」。动画讲解 / 设置两个功能名本来就没有课程色，不动。
 *      ⚠️ 编程环境 → **智码工坊**是后来（2026-09-29）单独改的，见 `PAGES.coding` 的说明。
 *   ② **侧栏重分三组**：跟团团聊 / 动手试试 / 我的记录
 *      （原来是「能力 / 学习数据」两组 —— 「能力」这个词对学生没有意义）。
 *
 * ⚠️ **`PageName` 内部 id 一个都没改**（`chat` / `quiz` / `knowledge` / `dependency`…）：
 *   改名会牵动 `ui.go('quiz')`、`data-testid="coding-view-*"`、探针的页清单、
 *   架构守卫与文档计数 —— 而学生**看不见** id。所以这轮只动给人看的 `title` / `section`。
 *
 * ★★ 2026-09-30 再改一处（用户裁决）：「闯关挑战 → **个性化学习**」（内部 id 仍是 `quiz`）。
 *   理由：这一页做的事是**按教材章节分块的知识点练习**（左栏二级导航：大章节 → 小知识点），
 *   「闯关挑战」说的是游戏化外壳，盖不住「我该补哪个知识点」这条主线。
 *   与 D-064 同一条纪律：只动给人看的 `title`，id / 存储键 / 路由语义一个都不碰。
 */
export const PAGES: Record<PageName, PageMeta> = {
  chat: { title: '问问智团团', section: '跟团团聊', nav: true, icon: 'MessageCircle' },
  animation: { title: '动画讲解', section: '动手试试', nav: true, icon: 'Clapperboard' },
  /**
   * 智码工坊（内部 id 仍是 `coding`）。
   *
   * ★★ 2026-09-29 从「编程环境」改名：这一页是**按教材章节分块的动手页**
   *   （先看大模块、再进小关），「环境」这个词说的是开发工具，
   *   而学生在这里做的是**一关一关造东西** —— 「工坊」才对应那条学习动线。
   *   ⚠️ 改名只动 `title`（给人看的）：内部 id、`data-testid="coding-view-*"`、
   *      探针的页清单都不动（学生看不见 id，改了只会白折腾一堆锚点）。
   */
  coding: { title: '智码工坊', section: '动手试试', nav: true, icon: 'Code' },
  /**
   * 个性化学习（内部 id 仍是 `quiz`）。
   *
   * ★★ 2026-09-30 从「闯关挑战」改名（理由见上面 PAGES 的说明）：左栏改成按教材章节
   *   分块的二级导航（`views/Quiz.vue` 用 `study/workshop-path.ts` 的
   *   `groupLevelsByChapter` 分块，与智码工坊同一口径）。
   */
  quiz: { title: '个性化学习', section: '动手试试', nav: true, icon: 'Trophy' },
  study: {
    title: '学习记录',
    subtitle: '掌握度 · 学段轨迹 · 学习历史',
    section: '我的记录',
    nav: true,
    icon: 'Radar'
  },
  settings: {
    title: '设置',
    subtitle: '学段 · 章节 · 外观',
    section: '我的记录',
    nav: true,
    icon: 'Settings'
  },
  // 参考资料库：**曾经是**数据层检视页（`nav: 'teacher'`），2026-09-30 起学生可见。
  //
  // ★ 历史（三次转折，改这一段前先读完）：
  //   ① 设计原型把它们标成 `nav: false`，而原型是 router 驱动的（可以直接改哈希进去）；
  //      本项目没有 router（见 D-040），`nav: false` 于是等于**这两页点不到** ——
  //      而这一页里恰恰有**导入教材 / 重建索引**两个真实功能。
  //      做了却进不去的功能等于没做，所以当时改成进侧栏。
  //   ② 2026-09-20 走查发现另一端的问题：这一页会把 `kb.sqlite` 的**完整路径**
  //      （含 Windows 用户名）、`kp_id`、`已嵌入` 状态、以及两个破坏性按钮
  //      直接摆到学生面前 —— 一个 10 岁学生既看不懂，也不该有能力重建索引。
  //      于是改成 `nav: 'teacher'`（学生侧栏里进不去）。
  //   ③ ★★ 2026-09-30 用户裁决：**学生也要能查教材**（「学生视角就可以查看」）——
  //      于是改回 `nav: true`。但 ② 里那些东西**一条都不能回到学生眼前**：
  //      技术读数 / `kp_id` 列 / 向量与嵌入状态 / 导入 / 重建，全部关进 `TeacherGate`
  //      （渲染层分档），学生面只留「有哪些教材、能搜什么」。
  //      ⚠️ 这与全项目一致：TeacherGate **不是权限控制**（只防误入），
  //      真正的破坏性操作防护在服务端（导入要过文件校验、重建要过模型与维度检查）。
  knowledge: {
    title: '参考资料库',
    // ★ 学生面副标题：去掉「向量索引状态 · 导入与重建」—— 那是运维口径
    subtitle: '按学段整理的教材与知识点，可以搜',
    section: '我的记录',
    nav: true,
    icon: 'Library'
  },
  dependency: {
    title: '知识图谱',
    subtitle: '知识点的先后关系',
    section: '我的记录',
    nav: true,
    icon: 'GitBranch'
  },
  /**
   * ★★ 运行透视（2026-09-27 前叫「演示驾驶舱」）：**教师档及以上可见**。
   *
   * 这一页摊开的是每一轮的运行机制（Prompt 分段拼装、画像字节指纹、四级降级链、
   * 安全三阶段、拦截记录、原始信封）。2026-09-26 它只在最高档可达，落成了「专给
   * 演示做的页面」；2026-09-27 改成 `nav: 'teacher'` —— **不载入任何预置数据、
   * 普通运行态下**，老师也要能看「这一轮背后调用了什么、走了哪条链路」。
   * ⚠️ 学生面仍然看不到它（技术证据不进学生面）：`visibleInSidebar(PAGES.demo, 'student')`
   *   必须恒为假，守卫钉着这一条（`tests/demo-mode.test.ts` / `student-view-discipline.test.ts`）。
   */
  demo: {
    title: '运行透视',
    subtitle: '这一轮怎么跑出来的 · 每一步都查得到',
    section: '我的记录',
    nav: 'teacher',
    icon: 'Radar'
  }
}

/**
 * 侧栏渲染顺序（分组顺序 = 数组顺序，组内 = 数组顺序）。
 *
 * ★ 组顺序**由首次出现的顺序决定**（`AppSidebar.vue` 的 `sections` 就是这么分的），
 *   所以三组的排列只体现在这个数组里：跟团团聊 → 动手试试 → 我的记录。
 */
export const PAGE_ORDER: readonly PageName[] = [
  'chat',
  'animation',
  'coding',
  'quiz',
  'study',
  'dependency',
  'knowledge',
  'demo',
  'settings'
]

/**
 * 这一页是否**只属于教师 / 答辩视角**（见 `PAGES` 里 `nav: 'teacher'` 的那些）。
 *
 * ★ 为什么需要它：教师视角下学生可以进「参考资料库」，切回学生视角时**得有人把他带走** ——
 *   否则界面会停在一个侧栏里已经没有入口的页面上（学生看到自己在看一个
 *   「进得来、退不出、也说不清为什么在这儿」的运维页面）。这不是渲染问题，
 *   是**状态迁移**问题，所以判据放在 store 里、由 `App.vue` 监听视角变化时执行。
 */
export function isTeacherOnlyPage(page: PageName): boolean {
  return PAGES[page].nav === 'teacher'
}

/**
 * 这一页**要求的最低档位**（`null` = 三档都能看）。
 *
 * ★ 与 `visibleInSidebar` 的分工：那个回答「进不进侧栏」，这个回答「停在这一页上还合不合法」。
 *   两者读**同一个** `nav` 字段，所以不会出现「侧栏里看不到它、停在里面又没人管」这种只有
 *   评委才会撞见的不一致。`App.vue` 的档位迁移监听读的就是它。
 */
export function requiredViewFor(page: PageName): ViewMode | null {
  const nav = PAGES[page].nav
  if (nav === 'teacher' || nav === 'debug') return nav
  return null
}

/* ------------------------------------------------------------------ *
 * 兼容层：顶栏的三步循环与 `studyTab`
 * ------------------------------------------------------------------ */

/** 三个「主视图」（对话 / 学习记录 / 设置）—— 顶栏按钮按它循环。 */
export type ViewName = 'chat' | 'study' | 'settings'

/** 三个主视图对应的页面名（学习记录是 `study`，其余同名）。 */
const VIEW_TO_PAGE: Record<ViewName, PageName> = {
  chat: 'chat',
  study: 'study',
  settings: 'settings'
}

/** 页面名 → 主视图；非主视图（动画/编程/闯关/参考资料/知识图谱）返回 `null`。 */
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
   * ★ 保留这个名字是因为它已是**对外契约**：`ui-shell.test.ts` 与
   *   `verify-ui.mjs`（它按 `PAGES.title` 点侧栏导航）都按它取当前主视图。
   *   ⚠️ 2026-10-01（D-126）：`App.vue` 里那个靠 `VIEW_LABELS`/`nextView` 显示文案的
   *   顶栏三步循环按钮已删除 —— 这两个导出现在**只服务数据自洽**，界面上没有对应按钮了。
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
  chat: '学习记录',
  study: '设置',
  settings: '返回对话'
}

/** 视图的中文名（面包屑 / 断言用）。 */
export const VIEW_TITLES: Record<ViewName, string> = {
  chat: '对话',
  study: '学习记录',
  settings: '设置'
}

/** 下一个视图（顶栏按钮点击后到达的那一个）。 */
export function nextView(current: ViewName): ViewName {
  const at = VIEW_ORDER.indexOf(current)
  return VIEW_ORDER[(at + 1) % VIEW_ORDER.length]
}
