<script setup lang="ts">
/**
 * 学习档案 —— 一份「学情报告单」（hero + 三段叙事），不是 10 张等价卡片。
 *
 * ★ 本轮返工（结构）──为什么改：
 *   上一版是 2×N 的等价卡片网格（4 个统计磁贴 + 6 张同权卡片），**没有焦点**：
 *   学生一眼看不出"我该先看什么"。而且内容区最大字号是 16px，
 *   比顶栏 15px 的页面名只重 1px —— 焦点倒置（审计断言 7b / 7c 报错，已修）。
 *
 *   现在自上而下是一条阅读路径：
 *     ① 身份行（PageIdentity，22px）—— 这页回答什么问题 + 主路径提示
 *     ② hero（SurfacePanel）—— **唯一**的 22px 数字（平均掌握度）+ 学段只读 + 近 7 日走向
 *        原 4 个等价磁贴取消，`mastered / needWork / totalInteractions` 降为 hero 第二行 12px meta
 *     ③ 三段带细线的叙事区（不再各自套卡片，段间 1px 细线）：
 *          · 继续学习 —— 推荐下一步 + 知识点掌握度 + 闯关进度 + 近 7 日学习量
 *          · 学段依据 —— 变化轨迹 + 判定信号 + 学段隔离检索
 *          · 附注     —— 各段的规则 / 口径说明（12px 连续文字）
 *
 *   全页只有两个大档：hero 的 22px（掌握度）与段标题的 16px。其余 12–13px。
 *
 * ★ 本页是原「学习台首页」撤销后的收容地：四入口磁贴的职责移交给对话空态，
 *   而「继续学习（依赖图推荐）/ 掌握度概览 / 本周活动」这三块属于学习数据，
 *   并到这里。导航上它与设置同属「学习数据」。
 *
 * ★ 另合并了画布「2. 学段自适应」拆出来的三块（用户决策）：
 *   学段变化轨迹 / 判定信号 / 学段隔离检索。
 *   ⚠️ 原帧里的「确认调整 / 保持初中」按钮**已删除**（学段无人工入口，§5.1）：
 *      本页学段相关内容**全部只读**，没有选择器、没有确认、没有纠偏。
 *
 * 控件换成 Element Plus：进度条 → `el-progress`，轨迹 → `el-timeline`，标签 → `el-tag`。
 * 原来这些全是手写 CSS，同一个进度条在本目录里出现过 7 次、每次高度都不一样。
 *
 * ⚠️ 注入顺序：hero 的 22px 是全页**唯一**的焦点数字（段标题 16px 次之）。
 *    若要在 hero 里加东西，只能 ≤13px —— 否则焦点又会被摊平成"处处同权"。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useThemeStore } from '@/stores/theme'
import { Route, ShieldCheck, Info, BookOpen, ArrowUpRight, RefreshCw, FileDown } from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import PageActions from '@/components/PageActions.vue'
import PageIdentity from '@/components/PageIdentity.vue'
import {
  mastery,
  kpNames,
  gradeSignals,
  gradeHistory,
  isolationNotice,
  weeklyActivity,
  progressRows,
  recommendation,
  student,
  daysWithApp
} from '@/mocks'

const router = useRouter()
const theme = useThemeStore()

const signalTypeLabel: Record<string, string> = {
  vocab: '术语使用',
  depth: '提问深度',
  quiz_perf: '答题表现',
  meta_cognition: '元认知表达'
}

/** 每日交互总量（4 类相加）—— hero 的迷你走向条与总量都取自它 */
const weekDays = weeklyActivity.map((d) => ({
  day: d.day,
  total: d.qa + d.animation + d.coding + d.quiz
}))

const totalInteractions = weekDays.reduce((a, b) => a + b.total, 0)
const maxDayTotal = Math.max(...weekDays.map((d) => d.total))
/** 峰值日：一周全为 0 时没有峰值（取 max 会得到 0，得先排除），此时不标"峰值" */
const peakDay = maxDayTotal > 0 ? (weekDays.find((d) => d.total === maxDayTotal)?.day ?? '—') : null

/**
 * 迷你条高度：留 12% 下限，免得"只做了一点点"的日子看起来像空的。
 * ⚠️ 除零保护：maxDayTotal 为 0（新学生 / 一周没学）时直接返回 0，
 *    否则会算出 NaN% 这种无效样式值。
 */
const sparkHeight = (total: number) =>
  maxDayTotal > 0 ? `${Math.max(12, Math.round((total / maxDayTotal) * 100))}%` : '0%'

/** 柱状图上限改成实算 —— 原实现写死 `/9`，数据一变图就画错 */
const maxBar = Math.max(...weeklyActivity.map((d) => d.qa + d.animation + d.coding + d.quiz))

const derived = computed(() => ({
  avgMastery: Math.round((mastery.reduce((a, m) => a + m.score, 0) / mastery.length) * 100),
  mastered: mastery.filter((m) => m.score >= 0.7).length,
  needWork: mastery.filter((m) => m.score < 0.4).length
}))

const LEVEL_COLOR = (score: number) =>
  score >= 0.7 ? 'var(--k12-good)' : score >= 0.4 ? 'var(--k12-warn)' : 'var(--k12-bad)'

const masteryRows = computed(() =>
  mastery.map((m) => {
    const percent = Math.round(m.score * 100)
    return {
      ...m,
      name: kpNames[m.kpId] ?? m.kpId,
      percent,
      color: LEVEL_COLOR(m.score),
      detail: `${m.correct} / ${m.attempts} 题`
    }
  })
)

/** 隔离命中：仅使用当前学段及以下教材块 */
const isolationRows = [
  { label: '初中教材块', state: '命中', on: true },
  { label: '小学高 / 小学低（向上兼容）', state: '未命中', on: false },
  { label: '高中教材块（超出当前学段）', state: '已排除', on: false }
]

/**
 * 刷新：原型不重取数据，但**要有反馈** ——
 * 一个按下去毫无动静的按钮会让人以为坏了。
 */
const refreshed = ref(false)
let refreshTimer: number | null = null
function refresh() {
  refreshed.value = true
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => (refreshed.value = false), 1600)
}

/**
 * 导出学习报告（Markdown）。
 * 这是教师的真实需求（家长会 / 学情沟通），也是「学习记录」这条数据链路的出口。
 * 原型阶段数据都在前端，所以直接生成并下载，不做一个假按钮。
 */
const exported = ref(false)
let exportTimer: number | null = null
function exportReport() {
  const lines = [
    `# 学习报告 · ${student.nickname}`,
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    `当前学段：${theme.displayGradeMeta.label}（系统自动判定）`,
    '',
    '## 知识点掌握度',
    '',
    '| 知识点 | 掌握度 | 答题 |',
    '| --- | --- | --- |',
    ...mastery.map(
      (m) => `| ${kpNames[m.kpId] ?? m.kpId} | ${Math.round(m.score * 100)}% | ${m.correct}/${m.attempts} |`
    ),
    '',
    '## 学段变化轨迹',
    '',
    ...gradeHistory.map((h) => `- ${h.at}：${h.from} → ${h.to}（${h.reason}）`),
    '',
    '## 本周学习量',
    '',
    '| 日 | 问答 | 动画 | 编程 | 闯关 |',
    '| --- | --- | --- | --- | --- |',
    ...weeklyActivity.map((d) => `| ${d.day} | ${d.qa} | ${d.animation} | ${d.coding} | ${d.quiz} |`)
  ]
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `学习报告-${student.nickname}.md`
  a.click()
  URL.revokeObjectURL(url)
  exported.value = true
  if (exportTimer !== null) clearTimeout(exportTimer)
  exportTimer = window.setTimeout(() => (exported.value = false), 2000)
}

onBeforeUnmount(() => {
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  if (exportTimer !== null) clearTimeout(exportTimer)
})
</script>

<template>
  <div class="pf">
    <PageActions>
      <el-button @click="refresh">
        <RefreshCw :size="14" />
        <span class="btn__label">{{ refreshed ? '已是最新' : '刷新' }}</span>
      </el-button>
      <el-button type="primary" @click="exportReport">
        <FileDown :size="14" />
        <span class="btn__label">{{ exported ? '已导出' : '导出报告' }}</span>
      </el-button>
    </PageActions>

    <!-- ① 身份行：这页回答什么问题 + 先看什么（主路径提示） -->
    <PageIdentity
      main="这孩子现在会什么、卡在哪"
      meta="数据来自本地 learning.db"
      hint="先看顶部的掌握度与近 7 日走向，再看下面三段：继续学习 / 学段依据 / 学习量"
    />

    <!-- ② hero：全页唯一的焦点数字 -->
    <SurfacePanel class="hero">
      <div class="hero__top">
        <div class="hero__id">
          <p class="hero__name">{{ student.nickname }}</p>
          <p class="hero__grade">当前学段：{{ theme.displayGradeMeta.label }}（系统自动判定）</p>
        </div>

        <div class="hero__mastery">
          <p class="hero__num k12-num">
            {{ derived.avgMastery }}<span class="hero__unit">%</span>
          </p>
          <p class="hero__cap">
            平均掌握度 · {{ mastery.length }} 个知识点 · 按最近一次答题时间排序
          </p>
        </div>

        <div class="hero__trend">
          <div class="hero__spark" aria-hidden="true">
            <span v-for="d in weekDays" :key="d.day" class="hero__spark-col">
              <span class="hero__spark-fill" :style="{ height: sparkHeight(d.total) }" />
            </span>
          </div>
          <p class="hero__trend-txt">
            近 7 日合计 {{ totalInteractions }} 次<template v-if="peakDay">
              · 峰值 {{ peakDay }}（{{ maxDayTotal }} 次）</template>
          </p>
        </div>
      </div>

      <p class="hero__stats">
        已掌握 <span class="hero__n k12-num">{{ derived.mastered }}</span> 个 · 待加强
        <span class="hero__n k12-num">{{ derived.needWork }}</span> 个 · 近 7 日交互
        <span class="hero__n k12-num">{{ totalInteractions }}</span> 次
      </p>
    </SurfacePanel>

    <!-- ③-1 继续学习 -->
    <section class="sec">
      <header class="sec__head">
        <Route :size="15" />
        <h2 class="sec__title">继续学习</h2>
        <span class="sec__meta">按依赖图推荐 · 已使用 {{ daysWithApp }} 天</span>
      </header>

      <!-- ★ 这里必须是**白面**（SurfacePanel tone=card），不能直接摊在页面上：
           本页三段现在是「细线分隔的裸内容」，背景就是**带学段色的页面底色**；
           而 base.css 的软色调（accent-soft 等）语义是 **inset = 卡片内的嵌入块**，
           它们与 page 属同一色家族 —— 实测初中档下 accent-soft 对 page 只有
           **1.014:1**，边界会整个消失（软色块直接放页面上 ≈ 看不见）。
           白面把「这是一块被抬升的推荐」这层重新建立起来（白 vs 页面 ≥1.10）。 -->
      <SurfacePanel class="reco" padding="13px 15px">
        <span class="reco__pill">{{ recommendation.kpName }}</span>
        <p class="reco__desc">{{ recommendation.reason }}</p>
        <el-button type="primary" class="reco__btn" @click="router.push(recommendation.targetRoute)">
          {{ recommendation.ctaLabel }}
          <ArrowUpRight :size="14" />
        </el-button>
      </SurfacePanel>

      <div class="sub">
        <h3 class="sub__title">知识点掌握度</h3>
        <div class="rows">
          <div v-for="m in masteryRows" :key="m.kpId" class="row">
            <span class="row__name">{{ m.name }}</span>
            <el-progress
              :percentage="m.percent"
              :stroke-width="7"
              :show-text="false"
              :color="m.color"
              class="row__bar"
            />
            <span class="row__pct">{{ m.percent }}%</span>
            <span class="row__detail">{{ m.detail }}</span>
          </div>
        </div>
      </div>

      <div class="sub">
        <h3 class="sub__title">闯关进度</h3>
        <div class="rows">
          <div v-for="r in progressRows" :key="r.kpId" class="row">
            <span class="row__name">{{ r.name }}</span>
            <el-tag
              size="small"
              effect="plain"
              :type="r.stage === 'mastered' ? 'success' : r.stage === 'quizzed' ? 'primary' : r.stage === 'learning' ? 'warning' : 'info'"
            >
              {{ { locked: '未解锁', learning: '学习中', quizzed: '已闯关', mastered: '已掌握' }[r.stage] }}
            </el-tag>
            <el-progress
              :percentage="Math.round(r.score * 100)"
              :stroke-width="7"
              :show-text="false"
              :color="LEVEL_COLOR(r.score)"
              class="row__bar"
            />
            <span class="row__pct">{{ Math.round(r.score * 100) }}%</span>
          </div>
        </div>
      </div>

      <div class="sub">
        <h3 class="sub__title">近 7 日学习量</h3>
        <div class="bars">
          <div v-for="d in weeklyActivity" :key="d.day" class="bar">
            <div class="bar__stack">
              <span class="bar__seg bar__seg--quiz" :style="{ height: `${(d.quiz / maxBar) * 100}%` }" />
              <span class="bar__seg bar__seg--coding" :style="{ height: `${(d.coding / maxBar) * 100}%` }" />
              <span class="bar__seg bar__seg--anim" :style="{ height: `${(d.animation / maxBar) * 100}%` }" />
              <span class="bar__seg bar__seg--qa" :style="{ height: `${(d.qa / maxBar) * 100}%` }" />
            </div>
            <span class="bar__label">{{ d.day.slice(-1) }}</span>
          </div>
        </div>
        <div class="legend">
          <span class="legend__i"><i class="dot dot--qa" />问答</span>
          <span class="legend__i"><i class="dot dot--anim" />动画</span>
          <span class="legend__i"><i class="dot dot--coding" />编程</span>
          <span class="legend__i"><i class="dot dot--quiz" />闯关</span>
        </div>
      </div>
    </section>

    <!-- ③-2 学段依据 -->
    <section class="sec">
      <header class="sec__head">
        <ShieldCheck :size="15" />
        <h2 class="sec__title">学段依据</h2>
        <span class="sec__meta">只读 · 置信度 {{ Math.round(gradeSignals.confidence * 100) }}%</span>
      </header>

      <div class="sub">
        <h3 class="sub__title">变化轨迹</h3>
        <el-timeline class="trail">
          <el-timeline-item
            v-for="(h, i) in gradeHistory"
            :key="i"
            :timestamp="`${h.at} · 来源 ${h.source}`"
            placement="top"
          >
            <p class="trail__move">{{ h.from }} → {{ h.to }}</p>
            <p class="trail__reason">{{ h.reason }}</p>
          </el-timeline-item>
        </el-timeline>
      </div>

      <div class="sub">
        <h3 class="sub__title">判定信号</h3>
        <div class="signals">
          <div v-for="s in gradeSignals.signals" :key="s.signalType" class="sig">
            <div class="sig__top">
              <span class="sig__type">{{ signalTypeLabel[s.signalType] ?? s.signalType }}</span>
              <span class="sig__val">{{ Math.round(s.value * 100) }}%</span>
            </div>
            <el-progress
              :percentage="Math.round(s.value * 100)"
              :stroke-width="7"
              :show-text="false"
              color="var(--k12-accent)"
            />
            <p class="sig__raw">{{ s.raw }}</p>
          </div>
        </div>
      </div>

      <div class="sub">
        <div class="sub__head">
          <h3 class="sub__title">学段隔离检索</h3>
          <span class="sub__meta">SQL 层强制</span>
        </div>
        <div class="iso">
          <div v-for="r in isolationRows" :key="r.label" class="iso__row">
            <span class="k12-dot" :class="r.on ? 'iso__dot-on' : 'iso__dot-off'" />
            <span class="iso__label" :class="{ 'iso__label--off': !r.on }">{{ r.label }}</span>
            <span class="iso__state" :class="{ 'iso__state--on': r.on }">{{ r.state }}</span>
          </div>
        </div>
        <div class="iso__notice">
          <BookOpen :size="14" />
          <span>{{ isolationNotice.text }}</span>
        </div>
      </div>
    </section>

    <!-- ③-3 附注：各段的口径与边界（12px 连续文字） -->
    <section class="sec">
      <header class="sec__head">
        <Info :size="15" />
        <h2 class="sec__title">附注</h2>
        <span class="sec__meta">规则与口径</span>
      </header>

      <div class="notes">
        <p class="notes__i">
          <span class="notes__k">学段判定规则：</span>置信度 &lt; 0.6 不改 · 连续 3 轮同向才动 ·
          单次最多动一级 · 5 轮冷却。
        </p>
        <p class="notes__i">
          <span class="notes__k">学段的写路径：</span>唯一写路径是服务端推断；学生端没有选择入口，
          也没有确认步骤。
        </p>
        <p class="notes__i">
          <span class="notes__k">检索隔离：</span>过滤写在 SQL 里，不在应用层筛 ——
          否则会被 KNN top-k 提前截断。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pf {
  /* 与 PageActions 的吸顶内边距一致（--pa-pad-y/x 默认 18/22），无需覆盖 */
  padding: 18px 22px 24px;
  display: flex;
  flex-direction: column;
  /* 页面级节奏用契约的「块之间」档（不是 --k12-gap：那是**并列卡片**的间距，
   * 本页已经不是卡片矩阵了）。段与段再叠一条细线 + 内上边距（见 .sec + .sec）。 */
  gap: var(--k12-gap-block);
}

/* ── hero：全页唯一的焦点数字（22px 只出现一次）────────────────────────── */
.hero {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hero__top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px 28px;
}
.hero__id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* ⚠️ 学生名刻意停在 13px：hero 里只允许「掌握度」一个 22px，
 *    其余一律 ≤13px，否则焦点又会被摊平成"处处同权"。 */
.hero__name {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.hero__grade {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.hero__mastery {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hero__num {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  letter-spacing: -0.01em;
  color: var(--k12-fg);
}
/* 单位不跟着 22px 放大：否则「%」成了第二个大元素 */
.hero__unit {
  margin-left: 2px;
  font-size: var(--k12-fs-sm);
  color: var(--k12-muted);
}
.hero__cap {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.hero__trend {
  margin-left: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  min-width: 0;
}
.hero__spark {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 22px;
}
.hero__spark-col {
  width: 8px;
  height: 100%;
  display: flex;
  align-items: flex-end;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.hero__spark-fill {
  display: block;
  width: 100%;
  background: var(--k12-accent);
}
.hero__trend-txt {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  text-align: right;
}
/* 原 4 个等价磁贴里剩下的三个数，降为 hero 第二行的 12px meta */
.hero__stats {
  padding-top: 10px;
  border-top: 1px solid var(--k12-border);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.hero__n {
  font-weight: 650;
  color: var(--k12-fg-2);
}

/* ── 三段叙事区：段间 1px 细线，不再各自套卡片 ─────────────────────────── */
.sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sec + .sec {
  padding-top: 16px;
  border-top: 1px solid var(--k12-border);
}
.sec__head {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--k12-muted);
}
/* 段标题 16px —— 本页除了 hero 的 22px 之外唯一的大档 */
.sec__title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  color: var(--k12-fg);
}
.sec__meta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  text-align: right;
}

/* ── 段内次级小节（13px 标签）──────────────────────────────────────────── */
.sub {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.sub__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.sub__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.sub__meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ── 推荐：段内唯一的**白面**（SurfacePanel tone=card，理由见模板注释）────
 * 表面（白底 / 边框 / 圆角 / 阴影）由 SurfacePanel 提供，这里只管排布 ——
 * 免得同一块表面又出现"两处各写一份"的老问题。 */
.reco {
  display: flex;
  align-items: center;
  gap: 14px;
}
/* 胶囊改用 accent-soft（inset 语义：卡内的嵌入块）。
 * 角色与原实现互换：原先是"软底块里放白胶囊"，现在是"白面里放软底胶囊"，
 * 两者的前景/背景对比关系不变。 */
.reco__pill {
  flex: none;
  padding: 4px 11px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.reco__desc {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.reco__btn {
  flex: none;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  align-items: center;
  gap: 11px;
}
.row__name {
  width: 150px;
  flex: none;
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__bar {
  flex: 1;
  min-width: 0;
}
.row__pct {
  width: 44px;
  flex: none;
  text-align: right;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg-2);
  font-variant-numeric: tabular-nums;
}
.row__detail {
  width: 74px;
  flex: none;
  text-align: right;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ── 学段轨迹 ─────────────────────────────────────────────────────────── */
.trail {
  padding-left: 2px;
}
.trail__move {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.trail__reason {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}

/* ── 判定信号 ─────────────────────────────────────────────────────────── */
.signals {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.sig {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sig__top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sig__type {
  font-size: var(--k12-fs-xs);
  font-weight: 620;
  color: var(--k12-fg-2);
}
.sig__val {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-accent-ink);
}
.sig__raw {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  line-height: var(--k12-lh-ui);
}

/* ── 学段隔离 ─────────────────────────────────────────────────────────── */
.iso {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.iso__row {
  display: flex;
  align-items: center;
  gap: 9px;
}
.iso__dot-on {
  background: var(--k12-good);
}
.iso__dot-off {
  background: var(--k12-border-strong);
}
.iso__label {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
}
.iso__label--off {
  color: var(--k12-muted);
}
.iso__state {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
  flex: none;
}
.iso__state--on {
  color: var(--k12-good);
}
/* ⚠️ 这块也直接落在页面底色上（不再是卡内），所以**必须显式描边**：
 * good-soft 与 page 是同家族浅色，实测 junior/soft 下只有 1.002:1 ——
 * 只靠填充色看不出边界。补一圈 good-border 把"这是一块提示"钉住，
 * 文字本身仍是 good on good-soft（5.0:1），不受影响。 */
.iso__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 11px;
  border-radius: var(--k12-r-control);
  background: var(--k12-good-soft);
  border: 1px solid var(--k12-good-border);
  color: var(--k12-good);
  font-size: var(--k12-fs-xs);
  font-weight: 550;
  line-height: var(--k12-lh-ui);
}

/* ── 附注：12px 连续文字 ──────────────────────────────────────────────── */
.notes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.notes__i {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}
.notes__k {
  font-weight: 650;
  color: var(--k12-fg);
}

/* ── 柱状（近 7 日学习量）────────────────────────────────────────────── */
.bars {
  display: flex;
  align-items: flex-end;
  gap: 9px;
  height: 120px;
}
.bar {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  height: 100%;
}
.bar__stack {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  border-radius: var(--k12-r-flat);
  overflow: hidden;
  background: var(--k12-surface-2);
}
.bar__seg {
  display: block;
  width: 100%;
}
.bar__seg--qa {
  background: var(--k12-accent);
}
.bar__seg--anim {
  background: var(--k12-accent-2);
}
.bar__seg--coding {
  background: var(--k12-cyan);
}
.bar__seg--quiz {
  background: var(--k12-good);
}
.bar__label {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.legend__i {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.dot--qa {
  background: var(--k12-accent);
}
.dot--anim {
  background: var(--k12-accent-2);
}
.dot--coding {
  background: var(--k12-cyan);
}
.dot--quiz {
  background: var(--k12-good);
}

/**
 * 窄屏只收「判定信号」的两列 —— hero **不转单列**。
 *
 * ⚠️ 这里曾把 `.hero__top` 强制成 `flex-direction: column`，是个真实缺陷：
 * 本应用 `#app` 有 `min-width: 1120px`（见 base.css），侧栏收到 64px 后
 * 内容区仍有 ~969px；而 hero 三项的固有宽度合计约 719px —— **本来放得下**。
 * 强制堆叠的后果是三项各占满一行（实测 hero 从 53px 变成 170px 高），
 * 且那条 22px 高的迷你走势条孤零零占掉一整行、左边还跟着一句说明，
 * 看起来像画坏了的残留元素，而不是一张图。
 *
 * 正确做法是**不干预**：`flex-wrap: wrap` + 默认的 `align-items: flex-start`
 * 会让它在放不下时自然折行（折下来的项保持自身宽度，不会拉满），
 * 放得下时就是设计稿那一行。
 */
@media (max-width: 1279px) {
  .signals {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
