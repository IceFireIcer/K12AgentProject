<script setup lang="ts">
/**
 * 左侧导航栏：设计稿 234px 宽，分「教学」「学习数据」两组。
 *
 * 导航项**由路由表 meta 推导**（见 router/index.ts：nav/section/icon/badge），
 * 不在组件里再写一份清单 —— 避免「加了页面忘了加导航」这类漂移。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { LayoutDashboard, MessageCircle, Clapperboard, Code, Trophy, Radar, Settings, ShieldCheck, ChevronsUpDown, FlaskConical } from 'lucide-vue-next'
import { useThemeStore } from '@/stores/theme'
import { student } from '@/mocks'

const route = useRoute()
const router = useRouter()
const theme = useThemeStore()

/** lucide 图标名 → 组件（只登记用到的，避免整包引入） */
const ICONS: Record<string, unknown> = {
  'layout-dashboard': LayoutDashboard,
  'message-circle': MessageCircle,
  clapperboard: Clapperboard,
  code: Code,
  trophy: Trophy,
  radar: Radar,
  settings: Settings
}

interface NavItem {
  name: string
  title: string
  icon: unknown
  badge?: number
}

/** 从路由表里挑出 nav: true 的子路由，按 section 分组并保持定义顺序 */
const sections = computed(() => {
  const order = ['home', 'chat', 'animation', 'coding', 'quiz', 'profile', 'settings']
  const all: (NavItem & { section: string })[] = router
    .getRoutes()
    .filter((r) => r.path.startsWith('/app/') && r.meta?.nav)
    .map((r) => ({
      name: String(r.name),
      title: String(r.meta.title ?? ''),
      icon: ICONS[String(r.meta.icon ?? '')] ?? LayoutDashboard,
      badge: r.meta.badge as number | undefined,
      section: String(r.meta.section ?? '')
    }))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))

  const groups: { label: string; items: NavItem[] }[] = []
  for (const item of all) {
    let g = groups.find((x) => x.label === item.section)
    if (!g) {
      g = { label: item.section, items: [] }
      groups.push(g)
    }
    g.items.push(item)
  }
  return groups
})

const activeName = computed(() => String(route.name ?? ''))

function go(name: string) {
  router.push({ name })
}
</script>

<template>
  <aside class="sb">
    <!-- 品牌 -->
    <div class="sb__brand">
      <div class="sb__mark"><span>知</span></div>
      <div class="sb__brand-text">
        <p class="sb__brand-name">知了同学</p>
        <p class="sb__brand-sub">K12 AI 通识课助手</p>
      </div>
    </div>

    <!-- 学生卡：只读，学段来自系统推断 -->
    <div class="sb__student-wrap">
      <div class="sb__student">
        <div class="sb__avatar">{{ student.nickname.slice(-1) }}</div>
        <div class="sb__student-text">
          <p class="sb__student-name">{{ student.nickname }}</p>
          <p class="sb__student-grade">{{ theme.displayGradeMeta.label }} · 系统自动判定</p>
        </div>
        <ChevronsUpDown :size="13" class="sb__chev" />
      </div>
    </div>

    <!-- 导航：由路由 meta 推导 -->
    <nav class="sb__nav">
      <template v-for="group in sections" :key="group.label">
        <div class="sb__section">
          <p class="sb__section-label">{{ group.label }}</p>
        </div>
        <button
          v-for="item in group.items"
          :key="item.name"
          type="button"
          class="sb__item"
          :class="{ 'sb__item--active': activeName === item.name }"
          :data-nav="item.name"
          @click="go(item.name)"
        >
          <component :is="item.icon" :size="15" class="sb__icon" />
          <span class="sb__label">{{ item.title }}</span>
          <span v-if="item.badge" class="sb__badge">{{ item.badge }}</span>
        </button>
      </template>
    </nav>

    <!-- 底部状态：本地化与依赖就绪情况 -->
    <div class="sb__foot">
      <div class="sb__stat"><span class="k12-dot sb__ok" /><span class="sb__stat-k">Python 服务</span><span class="sb__stat-v">就绪 · 8756</span></div>
      <div class="sb__stat"><span class="k12-dot sb__ok" /><span class="sb__stat-k">检索链路</span><span class="sb__stat-v">向量 · 512d</span></div>
      <div class="sb__stat"><span class="k12-dot sb__idle" /><span class="sb__stat-k">嵌入模型</span><span class="sb__stat-v">bge-small-zh</span></div>
      <div class="sb__privacy">
        <ShieldCheck :size="14" />
        <span>数据不出端 · 全本地</span>
      </div>
      <!-- 开发入口：学段手动切换只在开发页可用（先点这里，再开「开发模式」） -->
      <button type="button" class="sb__dev" @click="router.push('/dev/theme')">
        <FlaskConical :size="12" />
        <span>开发工具</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sb {
  width: var(--k12-w-sidebar);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--k12-glass-2);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border-right: 1px solid var(--k12-glass-border);
  position: relative;
  z-index: 2;
}

.sb__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 14px 14px;
}
.sb__mark {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: var(--k12-r-xl);
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--k12-accent) 0%, var(--k12-accent-2) 100%);
}
.sb__mark span {
  color: #fff;
  font-size: var(--k12-fs-title);
  font-weight: 700;
}
.sb__brand-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sb__brand-name {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.sb__brand-sub {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}

.sb__student-wrap {
  padding: 0 12px 14px;
}
.sb__student {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border-radius: var(--k12-r-2xl);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
}
.sb__avatar {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: var(--k12-r-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--k12-accent) 16%, #fff);
  color: var(--k12-accent);
  font-size: var(--k12-fs-lg);
  font-weight: 600;
}
.sb__student-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.sb__student-name {
  font-size: var(--k12-fs-md);
  font-weight: 600;
  color: var(--k12-fg);
}
.sb__student-grade {
  font-size: var(--k12-fs-tiny);
  color: var(--k12-muted);
}
.sb__chev {
  color: var(--k12-muted-2);
  flex: none;
}

.sb__nav {
  flex: 1;
  padding: 0 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.sb__section {
  padding: 10px 8px 4px;
}
.sb__section-label {
  font-size: var(--k12-fs-micro);
  font-weight: 600;
  color: var(--k12-muted-2);
  letter-spacing: 0.02em;
}
.sb__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 9px;
  border: none;
  border-radius: var(--k12-r-lg);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-md);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.16s ease, color 0.16s ease;
}
.sb__item:hover {
  background: var(--k12-surface);
}
.sb__item--active {
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-weight: 600;
}
.sb__item--active .sb__icon {
  color: var(--k12-accent);
}
.sb__icon {
  color: var(--k12-muted);
  flex: none;
}
.sb__label {
  flex: 1;
}
.sb__badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--k12-r-lg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--k12-accent);
  color: #fff;
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}
.sb__item:not(.sb__item--active) .sb__badge {
  background: var(--k12-surface-2);
  color: var(--k12-muted);
}

.sb__foot {
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid color-mix(in srgb, var(--k12-border) 60%, transparent);
}
.sb__stat {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sb__ok {
  background: var(--k12-good);
}
.sb__idle {
  background: var(--k12-border-strong);
}
.sb__stat-k {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.sb__stat-v {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg-2);
}
.sb__privacy {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--k12-r-xl);
  background: var(--k12-good-soft);
  color: #0b7a57;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
}
.sb__dev {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-lg);
  background: transparent;
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
  cursor: pointer;
}
.sb__dev:hover {
  border-color: var(--k12-accent-border);
  color: var(--k12-accent);
}
</style>
