/**
 * 路由：三区
 *   /app     产品主线（对话为主入口，能力与学习数据为次级分组）
 *   /system  设计系统页（配色总览 / 四学段对照）
 *   /dev     开发页（主题切换台 —— 只有这里能手动切学段，且需先开 devMode）
 *
 * ★ 对话是默认主界面：`/` 直接落到 `/app/chat`。
 *   原「学习台」（/app/home）已撤 —— 四入口磁贴的职责由**对话空态的能力入口**承担，
 *   「继续学习 / 掌握度 / 本周活动」并入学习档案页。理由是三个入口并列会稀释
 *   「以对话为主」这件事：学生打开应用应该直接能提问，而不是先看一个仪表盘。
 *
 * 侧栏导航**由本表 meta 推导**（nav / section / icon / badge），不在组件里另写清单。
 *   - `section: ''` → 该导航项独占一组且不渲染组标题（主入口用）
 *   - `subtitle`     → 顶栏副标题（学习类页面另有动态副标题，见 AppTopbar）
 */
import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/app/chat' },

  {
    path: '/app',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      {
        // 主入口：独占一组、无组标题
        path: 'chat',
        name: 'chat',
        component: () => import('@/views/app/ChatView.vue'),
        meta: { title: '对话课堂', nav: true, icon: 'message-circle', section: '', badge: 4 }
      },
      {
        path: 'animation',
        name: 'animation',
        component: () => import('@/views/app/AnimationView.vue'),
        meta: { title: '动画讲解', nav: true, icon: 'clapperboard', section: '能力' }
      },
      {
        path: 'coding',
        name: 'coding',
        component: () => import('@/views/app/CodingView.vue'),
        meta: { title: '编程环境', nav: true, icon: 'code', section: '能力' }
      },
      {
        path: 'quiz',
        name: 'quiz',
        component: () => import('@/views/app/QuizView.vue'),
        meta: { title: '闯关练习', nav: true, icon: 'trophy', section: '能力', badge: 3 }
      },
      {
        path: 'profile',
        name: 'profile',
        component: () => import('@/views/app/ProfileView.vue'),
        meta: { title: '学习档案', nav: true, icon: 'radar', section: '学习数据', subtitle: '掌握度 · 学段轨迹 · 学习记录' }
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/app/SettingsView.vue'),
        meta: { title: '设置', nav: true, icon: 'settings', section: '学习数据', subtitle: '模型接入 · 本地服务 · 隐私' }
      },
      {
        // 教材知识库：数据层检视视图
        path: 'knowledge',
        name: 'knowledge',
        component: () => import('@/views/app/KnowledgeView.vue'),
        meta: { title: '教材知识库', nav: false, subtitle: '四学段 chunk · 向量索引状态' }
      },
      {
        path: 'dependency',
        name: 'dependency',
        component: () => import('@/views/app/DependencyView.vue'),
        meta: { title: '依赖图谱', nav: false, subtitle: '知识点前置关系（from 是前置）' }
      }
    ]
  },

  {
    path: '/system',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      {
        path: 'palette',
        name: 'palette',
        component: () => import('@/views/system/PaletteView.vue'),
        meta: { title: '配色总览', subtitle: '设计系统证据页（报告 / 答辩用）' }
      },
      {
        path: 'grades',
        name: 'grades',
        component: () => import('@/views/system/GradeMatrixView.vue'),
        meta: { title: '四学段对照', subtitle: '语气与认知定位对照' }
      }
    ]
  },

  {
    path: '/dev',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      {
        path: 'theme',
        name: 'dev-theme',
        component: () => import('@/views/dev/ThemeConsoleView.vue'),
        meta: { title: '主题切换台', dev: true, subtitle: '开发期手动切学段配色（需先开开发模式）' }
      }
    ]
  },

  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue')
  }
]

export const router = createRouter({
  // hash 模式：Electron 以 file:// 加载渲染进程时会用到，提前对齐避免接线时换模式
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

export default router
