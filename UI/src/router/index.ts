/**
 * 路由：三区
 *   /app     产品主线（侧栏 7 项导航 + 导航外的多模态工作台）
 *   /system  设计系统页（配色总览 / 四学段对照）
 *   /dev     开发页（主题切换台 —— 只有这里能手动切学段，且需先开 devMode）
 *
 * 说明：`/app` 下的 7 项与设计稿侧栏导航一一对应；多模态工作台挂在
 * `/app/workbench`，它不占导航项（设计稿里它是独立一屏的另一种 IA）。
 */
import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/app/home' },

  {
    path: '/app',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      {
        path: 'home',
        name: 'home',
        component: () => import('@/views/app/HomeView.vue'),
        meta: { title: '学习台', nav: true, icon: 'layout-dashboard', section: '教学' }
      },
      {
        path: 'chat',
        name: 'chat',
        component: () => import('@/views/app/ChatView.vue'),
        meta: { title: '对话课堂', nav: true, icon: 'message-circle', section: '教学', badge: 4 }
      },
      {
        path: 'animation',
        name: 'animation',
        component: () => import('@/views/app/AnimationView.vue'),
        meta: { title: '动画讲解', nav: true, icon: 'clapperboard', section: '教学' }
      },
      {
        path: 'coding',
        name: 'coding',
        component: () => import('@/views/app/CodingView.vue'),
        meta: { title: '编程环境', nav: true, icon: 'code', section: '教学' }
      },
      {
        path: 'quiz',
        name: 'quiz',
        component: () => import('@/views/app/QuizView.vue'),
        meta: { title: '闯关练习', nav: true, icon: 'trophy', section: '教学', badge: 3 }
      },
      {
        path: 'profile',
        name: 'profile',
        component: () => import('@/views/app/ProfileView.vue'),
        meta: { title: '学习档案', nav: true, icon: 'radar', section: '学习数据' }
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/app/SettingsView.vue'),
        meta: { title: '设置', nav: true, icon: 'settings', section: '学习数据' }
      },
      {
        // 多模态工作台：四交互同屏，不占导航项
        path: 'workbench',
        name: 'workbench',
        component: () => import('@/views/app/WorkbenchView.vue'),
        meta: { title: '多模态工作台', nav: false }
      },
      {
        // 教材知识库：数据层检视视图
        path: 'knowledge',
        name: 'knowledge',
        component: () => import('@/views/app/KnowledgeView.vue'),
        meta: { title: '教材知识库', nav: false }
      },
      {
        path: 'dependency',
        name: 'dependency',
        component: () => import('@/views/app/DependencyView.vue'),
        meta: { title: '依赖图谱', nav: false }
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
        meta: { title: '配色总览' }
      },
      {
        path: 'grades',
        name: 'grades',
        component: () => import('@/views/system/GradeMatrixView.vue'),
        meta: { title: '四学段对照' }
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
        meta: { title: '主题切换台', dev: true }
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
