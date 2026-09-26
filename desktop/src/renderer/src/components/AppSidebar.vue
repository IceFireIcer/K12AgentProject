<script setup lang="ts">
/**
 * 左侧导航栏。
 *
 * 导航项**由 `stores/ui.ts` 的 `PAGES` / `PAGE_ORDER` 推导**（页面清单只在那一处声明）：
 * 只有 `visibleInSidebar()` 放行的页面进侧栏、顺序按 `PAGE_ORDER`、分组标题取 `PAGES[name].section`
 * （空串 = 独占一组且不渲染组标题 —— 对话是主入口，不该被归进某个分组）。
 * 在这里再抄一份清单，就会出现「加了页面忘了加导航」这类漂移。
 *
 * ★★ `nav` 是**三态**（true / 'teacher' / false），判据收口在 `visibleInSidebar()`：
 *   教师视角下会多出「教材知识库」（数据检视 + 导入 / 重建，学生不该看到
 *   `kb.sqlite` 路径与两个破坏性按钮）。侧栏只是**调那个函数**，
 *   不自己比较字段 —— 写错方向的表现（学生看到运维页 / 评委看不到它）
 *   都不会报错，只能靠收口把它变成一处可读的代码。
 *
 * ★ 图标名也是**数据**（`PAGES[name].icon` 存的是 lucide 的组件名），所以要用一张
 *   名字 → 组件的表来解析；没有这张表就只能按页面写死 import。
 *
 * ★ 左上角品牌标是**真实素材**（`resources/brand/*.png`，吉祥物「智团团」），不是字母方块：
 *   默认 `main.png`，判出学段之后随学段换图（`theme.displayGrade` → 四学段四张）。
 *   素材由 `server/scripts/make_brand_icons.py` 从仓库根 `logos/` 生成，改了 logo 重跑脚本。
 *
 * **窄窗口（<1280px）收成 64px 图标条 —— 只有这一档隐藏文字**：导航项名、分组标题、
 * 品牌名与学生昵称都折掉，靠 `title` 提示。≥1280px 是完整的 248px 栏（目标窗口
 * 1440×900），文字全在；截图里「图标旁边没有文字」就是 1080px 宽时落在了这一档。
 *
 * 三处刻意去掉的东西：
 *   1. 学生卡上的 `ChevronsUpDown` —— 它暗示「可以切换学生」，但本项目是一人一库
 *      且当前只有一个学生，那是个没有后端的假下拉。卡片改成可点，进学习档案。
 *   2. 底部三行服务状态 —— 三行等宽键值把侧栏底部压得很吵，且窄屏时全被折掉。
 *      合并成一行总状态（细节放 `title`）。
 *   3. 「开发工具」入口 —— 它指向的主题切换台（一个开发页）随
 *      「无人工学段入口」那套设计一起作废了；页面不存在，入口也不该在。
 *
 * ★★ 2026-09-22（报告 C13 / 2.5）：底部原本是「● 已就绪」+ 一整块绿底的
 *   「数据不出端 · 全本地」**双条**。现在只留**一个短词状态**（`sidecar.phaseText`），
 *   绿块整块删掉：隐私说明在设置页的高级区已有一份（`views/Settings.vue` 的
 *   「隐私与本地服务」），常驻侧栏等于把同一句话印两遍，而且那一块绿底在全站
 *   语义色里是最抢眼的一档 —— 它却什么也不做。**删的是重复与抢眼，不是承诺本身**：
 *   承诺仍在设置页那一处（且那里的措辞更完整）。
 *
 * ★★ 服务状态**接真实 store**（`stores/sidecar.ts`）：原型里那行是写死的
 *   「本地服务就绪 + 绿点」，服务根本没起来时它也这么说 —— 那是界面在撒谎。
 *   现在圆点颜色与文案都随 `phase` 走（只有 `ready` 是绿的），出错时把 `errorText` 列出来。
 *   `data-phase` 与文案是 `scripts/verify-ui.mjs` 的断言对象，改文案请同步脚本。
 *
 * ★ 品牌名取自 `@shared/brand`（唯一来源，见 AGENTS.md §1），不在本文件里写死。
 */
import { computed, onMounted } from 'vue'
import {
  Clapperboard,
  Code,
  GitBranch,
  LayoutDashboard,
  Library,
  MessageCircle,
  Radar,
  Settings,
  Trophy
} from 'lucide-vue-next'
import { BRAND_NAME, BRAND_TAGLINE } from '@shared/brand'
import { PAGES, PAGE_ORDER, useUiStore, visibleInSidebar } from '../stores/ui'
import type { PageName } from '../stores/ui'
import { useViewModeStore } from '../stores/viewMode'
import { useStudentStore } from '../stores/student'
import { useThemeStore } from '../stores/theme'
import { useChatStore } from '../stores/chat'
import { PHASE_HINT, useSidecarStore } from '../stores/sidecar'
import { GRADE_UNKNOWN_LABEL, gradeOriginLabel } from '../labels'
import { logoUrlFor } from '../brand-logo'

const ui = useUiStore()
const viewMode = useViewModeStore()
const student = useStudentStore()
const theme = useThemeStore()
const chat = useChatStore()
const sidecar = useSidecarStore()

/** lucide 图标名 → 组件（`PAGES[name].icon` 查这张表；只登记用到的，避免整包引入） */
const ICONS: Record<string, unknown> = {
  MessageCircle,
  Clapperboard,
  Code,
  Trophy,
  Radar,
  Settings,
  Library,
  GitBranch
}

interface NavItem {
  name: PageName
  title: string
  icon: unknown
}

/** 侧栏项：被 `visibleInSidebar` 放行的页，按 `PAGE_ORDER` 的顺序（不另排序、不另起名） */
const navItems = computed<NavItem[]>(() =>
  // ★ 传的是**档位**而不是「是不是教师视角」：三档之后「可见」由档位高低决定
  //   （演示档看得到教师档的页），判据收口在 `visibleInSidebar` 里。
  PAGE_ORDER.filter((name) => visibleInSidebar(PAGES[name], viewMode.mode)).map((name) => ({
    name,
    title: PAGES[name].title,
    icon: ICONS[PAGES[name].icon ?? ''] ?? LayoutDashboard
  }))
)

/** 按 `section` 分组：空串自成一组、渲染时**不输出组标题** */
const sections = computed(() => {
  const groups: { label: string; items: NavItem[] }[] = []
  for (const item of navItems.value) {
    const label = PAGES[item.name].section
    let group = groups.find((entry) => entry.label === label)
    if (!group) {
      group = { label, items: [] }
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
})

function go(name: PageName): void {
  ui.go(name)
}

/**
 * 品牌标（左上角）：**四学段四张吉祥物图，默认用主 logo**。
 *
 * ★ 图与换算都在 `brand-logo.ts`（渲染进程的**唯一 URL 来源**）——
 *   同一张图在对话空态与每条回答的头像上也要用，三处各写一份路径就是三处真相，
 *   漏改一处不会报错，只会在界面上留一个裂图。
 * ★ **学段→图**这条机制就在下面这一行（`theme.displayGrade` 变了图就换）：
 *   它是学段自适应的可见证据之一，不要动。
 */
const brandLogo = computed(() => logoUrlFor(theme.displayGrade))

/**
 * 学生身份：昵称与学段。
 *
 * ★ 取数在**本组件**发起（原型里读的是那个已删除的 mocks 模块）：侧栏是昵称的消费点，
 *   `load()` 幂等、失败不抛，拿不到就回落成「同学」+ `GRADE_UNKNOWN_LABEL`，不把整页打空。
 * ★ 学段来源**如实标注**：D-037 之后学生可以手动指定，写死「系统自动判定」会在
 *   学生手选之后变成一句假话 —— 文案统一走 `gradeOriginLabel()`（唯一实现）。
 * ★★ 这张卡是**全应用唯一**同时说「学段 + 来源」的地方（报告 2.1）：顶栏那枚学段 chip
 *   只显示值（点开可改），设置页只负责编辑 —— 同一件事不再在四处各说一遍。
 *   所以这一行**别**改成只有学段名：来源（「这档是谁定的」）只剩这里能看到了。
 */
onMounted(() => void student.load())

const gradeLine = computed(() =>
  theme.isRealGrade
    ? `${theme.displayGradeMeta.label} · ${gradeOriginLabel(chat.gradeOrigin)}`
    : GRADE_UNKNOWN_LABEL
)

const studentTitle = computed(() => {
  const base = `${student.nickname} · ${gradeLine.value}（点击进入学习档案）`
  return student.error === null ? base : `${base} · ${student.error}`
})

/**
 * 服务状态订阅。
 *
 * ★ `connect()` 是幂等的（store 里已在订阅就直接返回），外壳若也接了不会重复订阅；
 *   本组件与外壳同生死（侧栏是常驻 chrome），所以**不**在这里 `disconnect()` ——
 *   那会把外壳那一份订阅一起摘掉。
 * ★ 状态细节放 `title`：错误优先，其次是该阶段的说明文案。
 */
onMounted(() => sidecar.connect())

const statusTitle = computed(() => sidecar.errorText ?? PHASE_HINT[sidecar.phase])
</script>

<template>
  <aside class="sb">
    <!-- 品牌：品牌标是真实素材（随学段切换），名称与定位语来自 @shared/brand -->
    <div class="sb__brand">
      <img
        class="sb__mark"
        :src="brandLogo"
        :alt="BRAND_NAME"
        width="36"
        height="36"
        draggable="false"
        data-testid="brand-logo"
        :data-grade="theme.displayGrade"
      />
      <div class="sb__brand-text">
        <p class="sb__brand-name">{{ BRAND_NAME }}</p>
        <p class="sb__brand-sub">{{ BRAND_TAGLINE }}</p>
      </div>
    </div>

    <!-- 学生卡：点击进学习档案（学段由系统推断或学生手动指定，不在这里改） -->
    <div class="sb__student-wrap">
      <button type="button" class="sb__student" :title="studentTitle" @click="go('study')">
        <div class="sb__avatar">{{ student.avatarText }}</div>
        <div class="sb__student-text">
          <p class="sb__student-name">{{ student.nickname }}</p>
          <p class="sb__student-grade">{{ gradeLine }}</p>
        </div>
      </button>
    </div>

    <!-- 导航：由页面清单（stores/ui.ts）推导 -->
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
          :class="{ 'sb__item--active': ui.page === item.name }"
          :data-nav="item.name"
          :aria-current="ui.page === item.name ? 'page' : undefined"
          :title="item.title"
          @click="go(item.name)"
        >
          <component :is="item.icon" :size="16" class="sb__icon" />
          <span class="sb__label">{{ item.title }}</span>
        </button>
      </template>
    </nav>

    <!-- 底部：一个短词状态（真实的 sidecar 阶段）。
         ★ 2026-09-22 起这里**只有这一行**：原先下面还挂着一整块绿底的「数据不出端 · 全本地」，
           隐私说明在设置页高级区已有一份，常驻侧栏只是把同一句话印两遍（见文件头 ★★）。 -->
    <div class="sb__foot">
      <div class="sb__stat" :data-phase="sidecar.phase" :title="statusTitle" data-testid="sidecar-status">
        <span class="k12-dot sb__dot" />
        <span class="sb__stat-k">{{ sidecar.phaseText }}</span>
      </div>
      <!-- 起不来时才有的第二行：那是**故障原因**（不是常驻说明），
           学生/老师要能当场读出来；细节同时在 title 里，窄屏折掉这行也读得到。 -->
      <p v-if="sidecar.errorText" class="sb__stat-err" data-testid="sidecar-error">
        {{ sidecar.errorText }}
      </p>
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
  /* 实色桌面：侧栏是"桌上的工具架"，不该透出正文工作面的格子。
   * ★★ 2026-09-22（报告 4.1）：这里原来还有一条 `border-right`。
   *  窗口级分割线当时有四条（侧栏竖线 + 顶栏下线 + 章节条下线 + 「本轮对话」条下线），
   *  而侧栏与内容区**本来就有材质差**（surface vs 带学段色的 page）—— 竖线是重复的一条。
   *  ⚠️ 别加回来：这会与「边框 = 层级」的口径打架（见报告 0.1 / 4.2）。 */
  background: var(--k12-surface);
  position: relative;
  z-index: 2;
  color: var(--k12-fg);
}

/* ── 品牌 ─────────────────────────────────────────────────────────────── */
.sb__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 左右栏距 12px 与下面三块（学生卡 / 导航 / 页脚）**同一个值**：
   * 此前是 14px，品牌标比学生卡与导航项整体右移 2px，整列左缘对不齐。
   * 上下 10px 只是下限 —— 真正的高度由 min-height 定，内容垂直居中。 */
  padding: 10px 12px;
  /* 品牌带高度钉在顶栏高度上：侧栏首行与顶栏**共用同一条水平分界**，
   * 两栏的"窗帘"在 64px 处一起开始。 */
  min-height: var(--k12-h-topbar);
}
/* 品牌标 = 吉祥物素材本身（透明底 PNG，256px 缩到 36px），**不加底色方块**。
 * 原实现是一个写着「智」的实心方块：那既不是品牌素材，也跟四学段切换无关。 */
.sb__mark {
  width: 36px;
  height: 36px;
  flex: none;
  display: block;
  object-fit: contain;
}
.sb__brand-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.sb__brand-name {
  font-size: var(--k12-fs-body-lg);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
}
.sb__brand-sub {
  /* 产品副标题 = 说明性 meta，不是角标 */
  font-size: var(--k12-fs-caption);
  /* ★ 行高必须显式写 snug：不写就继承正文的 1.7，两行标签块被撑到 43.8px ——
   * 比 36px 的品牌标还高，品牌带因此比顶栏高一截（垂直节奏错位）。
   * 写 snug 之后 40.2px，稳稳落在 64px 的品牌带里。 */
  line-height: var(--k12-lh-snug);
  color: var(--k12-muted);
}
/* 固定宽度栏里的单行标识：一律省略号收尾（宁可截断，不可换行）——
 * 换行会把品牌带 / 学生卡撑高，整列的垂直节奏随之错位。 */
.sb__brand-name,
.sb__brand-sub,
.sb__student-name,
.sb__student-grade {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  /* 10px 而不是 9px：与 `.sb__item` **同一个内边距**。
   * 两个块上下相邻却差 1px，扫一眼就能看出「不对齐」。 */
  padding: 10px;
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
  font-size: var(--k12-fs-body);
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
  font-size: var(--k12-fs-body-sm);
  font-weight: 600;
  color: var(--k12-fg);
  /* 侧栏是 chrome，不是正文：两行都不吃正文的 1.7 行高 ——
   * 那会把学生卡撑到 ~65px（比 64px 的品牌带还高），一块一块量出来都不一样高。 */
  line-height: var(--k12-lh-ui);
}
/* 「初中 · AI 引擎推算」是「系统在适配我」的唯一可见证据，用 fg-2 保证可读；
 * 它是**可读的键值说明**（学段 + 来源），不是角标，用 12px。 */
.sb__student-grade {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
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
  /* 左 11px = 导航项 12px 栏距 + 1px 透明描边 + 10px 内边距 = 23px：
   * 组标题的左缘与下面各导航项的**图标左缘**对齐（此前差 2px，看着就是"错位"）。 */
  padding: 12px 11px 4px;
}
/* 组标题（「能力」「学习数据」）：它是**分组标题**，不是角上的记号。
 * 它比导航项（14px）小、比角标大 —— 12px 是它该在的档。 */
.sb__section-label {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
  letter-spacing: 0.02em;
}
.sb__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  /* 导航项内边距 10px：与学生卡严格一致（两块上下相邻，差 1px 就是错位） */
  padding: 10px;
  /* ★ 常态补一圈**透明**描边：选中/悬停时只换颜色，不换宽度 ——
   * 否则选中项的内容会比邻居宽 1px，整列文字左缘跳动。 */
  border: 1px solid transparent;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-body);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
  .sb__item:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg);
  }
  .sb__item:hover .sb__icon {
    color: var(--k12-fg-2);
  }
}
/* 当前页：浅底 + 强调色文字 + 左侧竖条。
 * ★ 用 `box-shadow: inset` 画那条竖条，而不是 `border-left` ——
 *   加一条左边框会把内容整体右推 3px，选中项的图标与标题跟邻居对不齐。 */
.sb__item--active {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--k12-accent-ink);
}
.sb__item--active .sb__icon {
  color: var(--k12-accent-ink);
}
.sb__icon {
  /* ★ 不做颜色过渡：`--k12-dur-state` 是 120ms，换页会看到图标"渐变"一下；
   * 全站动效为零（base.css 的材质规则），状态本身瞬时切换。 */
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

/* ── 底部 ─────────────────────────────────────────────────────────────── */
.sb__foot {
  /* 左右 12px：与品牌 / 学生卡 / 导航**同一个栏距**（此前 14px 会整块左缘对不齐） */
  padding: 12px;
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
/* 状态圆点：颜色**随阶段走**，未就绪时不是绿的。
 * （原型这里恒为绿点，服务没起来也写着「就绪」——界面不该替后端打包票。） */
.sb__dot {
  background: var(--k12-muted-2);
}
.sb__stat[data-phase='ready'] .sb__dot {
  background: var(--k12-good);
}
.sb__stat[data-phase='starting'] .sb__dot {
  background: var(--k12-warn);
}
.sb__stat[data-phase='failed'] .sb__dot {
  background: var(--k12-bad);
}
.sb__stat-k {
  font-size: var(--k12-fs-caption);
  font-weight: 550;
  color: var(--k12-fg-2);
}
.sb__stat[data-phase='starting'] .sb__stat-k {
  color: var(--k12-warn);
}
.sb__stat[data-phase='failed'] .sb__stat-k {
  color: var(--k12-bad);
}
/* 起不来时把原因列出来（细节同时在 title 里，窄屏折掉这行也读得到） */
.sb__stat-err {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-bad);
  word-break: break-word;
}

/* ── 窄窗口：收成图标条（断点 1280，同时右栏在 ChatView 里改浮层）─────────
 * ★ 只有这一档隐藏文字；≥1280px 是完整的 248px 栏（目标窗口 1440×900）。 */
@media (max-width: 1023px) {
  .sb {
    width: var(--k12-w-sidebar-narrow);
  }
  .sb__brand {
    /* 品牌带的 64px 由上面的 min-height 保证：这里只把品牌标居中，
     * 不再靠上下 padding 凑高度（凑出来的值一改 logo 尺寸就对不上了）。 */
    padding: 0;
    justify-content: center;
  }
  .sb__brand-text,
  .sb__student-text,
  .sb__label,
  .sb__section-label,
  .sb__stat-k,
  .sb__stat-err {
    display: none;
  }
  /* 服务状态只剩那个圆点：居中安置，别让 6px 的圆点孤零零飘在左边 */
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
  .sb__stat {
    justify-content: center;
  }
}
</style>
