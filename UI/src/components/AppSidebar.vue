<script setup lang="ts">
/**
 * 左侧导航栏。
 *
 * 导航项**由路由表 meta 推导**（见 router/index.ts：nav / section / icon / badge），
 * 不在组件里再写一份清单 —— 避免「加了页面忘了加导航」这类漂移。
 * `section: ''` 的项独占一组且不渲染组标题（对话是主入口，不该被归进某个分组）。
 *
 * 窄窗口（<1280px）收成 64px 图标条：只留图标，文字靠 `title` 提示。
 *
 * 两处刻意去掉的东西：
 *   1. 学生卡上的 `ChevronsUpDown` —— 它暗示「可以切换学生」，但本项目是一人一库
 *      且当前只有一个学生，那是个没有后端的假下拉。卡片改成可点，进学习档案。
 *   2. 底部三行服务状态 —— 三行等宽键值把侧栏底部压得很吵，且窄屏时全被折掉。
 *      合并成一行总状态（细节放 `title`），完整信息在学习档案与设置页。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  MessageCircle,
  Clapperboard,
  Code,
  Trophy,
  Radar,
  Settings,
  ShieldCheck,
  FlaskConical,
  LayoutDashboard
} from 'lucide-vue-next'
import { useThemeStore } from '@/stores/theme'
import { student } from '@/mocks'

const route = useRoute()
const router = useRouter()
const theme = useThemeStore()

/** lucide 图标名 → 组件（路由表 meta.icon 查这张表；只登记用到的，避免整包引入） */
const ICONS: Record<string, unknown> = {
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

/** 主入口排在最前，其余按能力 → 学习数据的顺序 */
const ORDER = ['chat', 'animation', 'coding', 'quiz', 'profile', 'settings']

/** 从路由表里挑出 nav: true 的子路由，按 section 分组并保持定义顺序 */
const sections = computed(() => {
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
    .sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name))

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

/** 底部服务状态：三行合并成一行，细节进 title */
const SERVICE_TITLE = 'Python 服务 就绪 · 8756 / 检索链路 向量 · 512d / 嵌入模型 bge-small-zh'
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

    <!-- 学生卡：只读（学段来自系统推断），点击进学习档案 -->
    <div class="sb__student-wrap">
      <button
        type="button"
        class="sb__student"
        :title="`${student.nickname} · ${theme.displayGradeMeta.label}`"
        @click="go('profile')"
      >
        <div class="sb__avatar">{{ student.nickname.slice(-1) }}</div>
        <div class="sb__student-text">
          <p class="sb__student-name">{{ student.nickname }}</p>
          <p class="sb__student-grade">{{ theme.displayGradeMeta.label }} · 系统自动判定</p>
        </div>
      </button>
    </div>

    <!-- 导航：由路由 meta 推导 -->
    <nav class="sb__nav">
      <template v-for="group in sections" :key="group.label || '__main'">
        <div v-if="group.label" class="sb__section">
          <p class="sb__section-label">{{ group.label }}</p>
        </div>
        <button
          v-for="item in group.items"
          :key="item.name"
          type="button"
          class="sb__item"
          :class="{ 'sb__item--active': activeName === item.name }"
          :data-nav="item.name"
          :title="item.title"
          @click="go(item.name)"
        >
          <component :is="item.icon" :size="16" class="sb__icon" />
          <span class="sb__label">{{ item.title }}</span>
          <span v-if="item.badge" class="sb__badge">{{ item.badge }}</span>
        </button>
      </template>
    </nav>

    <!-- 底部：一行总状态 + 隐私声明 + 开发入口 -->
    <div class="sb__foot">
      <div class="sb__stat" :title="SERVICE_TITLE">
        <span class="k12-dot sb__ok" />
        <span class="sb__stat-k">本地服务就绪</span>
      </div>
      <div class="sb__privacy" title="涉未成年人数据：最小化采集，不采集生物特征；对话正文不进 SQLite">
        <ShieldCheck :size="14" />
        <span class="sb__privacy-text">数据不出端 · 全本地</span>
      </div>
      <!-- 开发入口：学段手动切换只在开发页可用（先点这里，再开「开发模式」） -->
      <button type="button" class="sb__dev" title="主题切换台（开发）" @click="router.push('/dev/theme')">
        <FlaskConical :size="13" />
        <span class="sb__dev-text">开发工具</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sb {
  --el-box-shadow-light: none;
  --el-box-shadow: var(--k12-shadow-float);

  width: var(--k12-w-sidebar);
  flex: none;
  display: flex;
  flex-direction: column;
  /* 实色桌面：侧栏是"桌上的工具架"，不该透出正文工作面的格子 */
  background: var(--k12-surface);
  border-right: 1px solid var(--k12-border);
  position: relative;
  z-index: 2;
  color: var(--k12-fg);
}

/* ── 品牌 ─────────────────────────────────────────────────────────────── */
.sb__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 14px 14px;
}
.sb__mark {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--k12-r-control);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 实色而非渐变：同一个"accent→accent-2"渐变此前用在品牌标、头像、气泡、
   * 发送键、主按钮等 6 处 —— 强调用得太滥就不再是强调。 */
  background: var(--k12-accent);
}
.sb__mark span {
  color: var(--k12-surface);
  font-size: var(--k12-fs-lg);
  font-weight: 700;
}
.sb__brand-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.sb__brand-name {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
}
.sb__brand-sub {
  /* 产品副标题 = 说明性 meta，不是角标 */
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ── 学生卡 ───────────────────────────────────────────────────────────── */
.sb__student-wrap {
  padding: 0 12px 12px;
}
.sb__student {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  cursor: pointer;
  text-align: left;
}
/* hover 样式必须带指针门禁：触屏设备上 :hover 会在点按后粘住 */
@media (hover: hover) and (pointer: fine) {
  .sb__student:hover {
    border-color: var(--k12-accent-border);
  }
}
.sb__avatar {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: var(--k12-r-control);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--k12-accent) 16%, var(--k12-surface));
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-md);
  font-weight: 600;
}
.sb__student-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.sb__student-name {
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  color: var(--k12-fg);
}
/* 「初中 · 系统自动判定」是「系统在适配我」的唯一可见证据，用 fg-2 保证可读；
 * 它是**可读的键值说明**（学段 + 来源），不是角标，用 12px。 */
.sb__student-grade {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}

/* ── 导航 ─────────────────────────────────────────────────────────────── */
.sb__nav {
  flex: 1;
  padding: 0 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.sb__section {
  padding: 12px 9px 4px;
}
/* 组标题（「能力」「学习数据」）：它是**分组标题**，不是角上的记号。
 * 它比导航项（14px）小、比角标大 —— 12px 是它该在的档。 */
.sb__section-label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
  letter-spacing: 0.02em;
}
.sb__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-md);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
  .sb__item:hover {
    background: var(--k12-surface);
  }
}
.sb__item--active {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-weight: 600;
}
.sb__item--active .sb__icon {
  color: var(--k12-accent-ink);
}
.sb__icon {
  color: var(--k12-muted);
  flex: none;
}
.sb__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb__badge {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--k12-r-pill);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--k12-accent);
  color: var(--k12-surface);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
}
.sb__item:not(.sb__item--active) .sb__badge {
  background: var(--k12-surface-2);
  color: var(--k12-muted);
}

/* ── 底部 ─────────────────────────────────────────────────────────────── */
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
  cursor: default;
}
.sb__ok {
  background: var(--k12-good);
}
.sb__stat-k {
  font-size: var(--k12-fs-xs);
  font-weight: 550;
  color: var(--k12-fg-2);
}
.sb__privacy {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--k12-r-control);
  background: var(--k12-good-soft);
  color: var(--k12-good);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
}
.sb__dev {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-muted);
  /* 按钮标签（「开发工具」）是可读文字，不是角标 */
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .sb__dev:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

/* ── 窄窗口：收成图标条（断点 1280，同时右栏在 ChatView 里改浮层）───────── */
@media (max-width: 1279px) {
  .sb {
    width: var(--k12-w-sidebar-narrow);
  }
  .sb__brand {
    padding: 16px 0 12px;
    justify-content: center;
  }
  .sb__brand-text,
  .sb__student-text,
  .sb__label,
  .sb__section-label,
  .sb__badge,
  .sb__stat-k,
  .sb__privacy-text,
  .sb__dev-text {
    display: none;
  }
  /* 服务状态只剩那个绿点：居中安置，别让 6px 的圆点孤零零飘在左边 */
  .sb__stat {
    justify-content: center;
    padding: 4px 0;
  }
  .sb__student-wrap {
    padding: 0 10px 12px;
  }
  .sb__student {
    justify-content: center;
    padding: 8px;
  }
  .sb__nav {
    padding: 0 10px;
  }
  .sb__item {
    justify-content: center;
    padding: 11px 0;
  }
  /* 组标题退化成一条分隔线 */
  .sb__section {
    padding: 0;
    margin: 8px 4px;
    border-top: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  }
  .sb__foot {
    padding: 10px;
    align-items: center;
  }
  .sb__stat,
  .sb__privacy,
  .sb__dev {
    justify-content: center;
  }
  .sb__privacy,
  .sb__dev {
    padding: 8px;
    width: 100%;
  }
}
</style>
