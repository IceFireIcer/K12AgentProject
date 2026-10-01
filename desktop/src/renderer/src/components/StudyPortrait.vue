<script setup lang="ts">
/**
 * 学习档案右栏：学生画像（头像 / 名字 / 学段 / **五行结构** / 最近在学 / 下一步）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一栏为什么存在
 * ══════════════════════════════════════════════════════════════════════════
 * 画像这套能力（冷启动五问 → 白名单标签 → 每轮注入 Prompt）早就通了，
 * 但它此前**只在对话页右栏**露出来 —— 而学习档案页是学生「回看自己」的地方，
 * 恰好是最该看见「智团团记住了我什么」的那一屏。
 * 这一栏 = 把已经存在的数据摆到它该在的位置。
 *
 * ── 2026-09-30 改版（本次）─────────────────────────────────────────────
 * 「我记住了什么」的**分组标签列表** + 掌握度 → **五行结构 + 最近在学**：
 *   · 五行 = 类型 / 性格 / 偏好 / 兴趣 / AI 小结（渲染在 `PortraitFacts.vue`，
 *     行标题、空态文案、行↔键映射全部由后端下发）；
 *   · 掌握度 → **最近在学**（按最近接触时间排，回答「我最近在碰什么」）；
 *   · **画像变动时间线在这一栏不再显示**（需求「不内置画像变动信息」）；
 *     时间线与撤回等维护能力仍在**对话页右栏**（那里是维护入口）。
 *
 * ── 2026-09-30 视觉调整（同一天第二批）──────────────────────────────────
 * 用户对右栏观感的四条要求，落点都在本文件与 `PortraitFacts.vue`：
 *   · 头像 64 → 72px（圆底/形状口径不动）；名字与学段仍在头像下方、居中堆叠
 *     —— 顶部那块**带分隔线的结构一个像素没动**；
 *   · 五行行首标签 → **彩色胶囊**（各行一支 token 色，反白字），取值 → 同色系小标签；
 *   · 「最近在学」整块收纵向空间（空态把 EmptyState 的整页留白按本栏收窄）；
 *   · 删掉收尾那句「这些都是从我俩的对话和你的练习里来的。」。
 *
 * ── ★★ 三条纪律（改这里之前先读完）─────────────────────────────────────
 *
 * 1. **本组件与 `PortraitFacts` 都不写标签名**。标签中文名来自 `server/app/contracts.py`
 *    的 `TAG_LABELS`，行标题 / 空态文案随载荷下发。渲染进程的每个字符串字面量都会被
 *    `tests/student-view-discipline.test.ts` 扫到 —— 写死一个「兴趣话题」就等于
 *    在渲染层留了一个内部标识，而那种字样迟早会随某次改版漏到学生眼前。
 *    （本文件自己那几句区块标题 ——「最近在学」「建议下一步」—— 是**界面文案**而不是
 *     标签名，与既有的「还没练过」「去闯关里做第一道题」同类。）
 *
 * 2. **技术词一个都不许有**。这一栏是学生面：不出现 `kpId`、不出现 ID 形态的串、
 *    不出现 HTTP 状态码。知识点名走 `study/kp-label.ts` 的共用口径（取不到名字时
 *    给中性标签 + 把 id 放进 `title`，**不把 slug 摆在正文里**）。
 *
 * 3. **只读**。这一栏不写任何东西：撤回标签只发生在对话页右栏。少的是动作，
 *    不是信息 —— 五行里的值照常显示。
 *
 * ── 空态是这一栏最需要认真对待的一屏 ────────────────────────────────────
 * 新学生 / 五问没答完 / 家长把「记住我」关掉时，标签是**空数组**。
 * 一个空面板会被读成「这里坏了」，所以每一节都有自己的空话（五行那几句由后端给），
 * 而且它们说的是**下一步做什么**，不是「无数据」。
 */
import { computed } from 'vue'
import { BookOpen, Compass } from 'lucide-vue-next'
import EmptyState from './EmptyState.vue'
import PortraitFacts from './PortraitFacts.vue'
import { DEFAULT_LOGO_URL } from '../brand-logo'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL, gradeOriginLabel } from '../labels'
import { STUDENT_FALLBACK_NAME } from '@shared/profile-tags'
import { kpLabel, kpLabelResolved } from '../study/kp-label'
import { useChatStore } from '../stores/chat'
import { useInsightStore } from '../stores/insight'
import { useKnowledgeStore } from '../stores/knowledge'
import { useProfileCardStore } from '../stores/profileCard'
import { useUiStore } from '../stores/ui'

const chat = useChatStore()
const insight = useInsightStore()
const knowledge = useKnowledgeStore()
const profileCard = useProfileCardStore()
const ui = useUiStore()

/* ------------------------------------------------------------------ *
 * 头像与名字
 * ------------------------------------------------------------------ */

/**
 * 头像素材：**复用品牌吉祥物**（`resources/brand/main.png`，抱蜂蜜的小熊）。
 *
 * ★ 为什么不是「从图标库搜一张默认头像」：本项目**零 CDN**（联网拉图会被
 *   `resources/` 的打包口径与离线要求同时否掉），而那五张本地图是**智团团自己的形象**
 *   —— 对 10 岁的学生来说，「这是教我的人」比一张通用的灰色人形剪影更亲近。
 * ★ 为什么走 `brand-logo.ts` 的常量而不是硬写路径：那个模块的理由写在它自己的头部
 *   （同一张图在三处出现，各写一遍路径时换素材漏一处就是裂图且不报错）。
 */
const avatarUrl = DEFAULT_LOGO_URL

/**
 * 名字：`identity.displayName`（后端已过 `safe_display_name`）。
 *
 * ★★ 拿不到时回落 `STUDENT_FALLBACK_NAME`（「同学」），**绝不回落学生真名那个字段**：
 *   真名只给渲染层做 `{{student_name}}` 本地替换，混进显示层就是把它推上台面。
 *   这与 `api/profile-card.ts` 的 `normalizeIdentity` 是同一条口径。
 *   ⚠️ 这里**刻意不写出那个字段名**：本文件会被守卫按字面量扫，
 *      注释里提一次就等于给「显示层不许出现真名字段」这条断言开了一个洞。
 */
const displayName = computed(() => {
  const name = profileCard.identity?.displayName?.trim() ?? ''
  return name.length > 0 ? name : STUDENT_FALLBACK_NAME
})

/**
 * 学段那一行：「初中 · 手动选中」。
 *
 * ★★ 来源**必须显示**：没有它，学生看不出「这个年级是我选的还是系统猜的」，
 *   而这两件事的后果不同（手动定过之后 10 轮内不再自动改）。
 * ★ 用 `chat.currentGrade` 而不是 `codex` 的画像端点：学段的权威展示口径在
 *   `stores/chat.ts`（`grade:changed` 推送 + `grade:get`），画像端点回的是另一条线上的快照。
 *   两处都取会出现「顶栏写初中、这一栏写小学高年级」。
 */
const gradeLabel = computed(() => {
  const grade = chat.currentGrade
  return grade === null ? GRADE_UNKNOWN_LABEL : GRADE_LABELS[grade]
})

/** 学段来源的中文（唯一实现在 `labels.ts`，本文件不写第二份映射）。 */
const gradeOriginLabelText = computed(() => gradeOriginLabel(chat.gradeOrigin))

/* ------------------------------------------------------------------ *
 * 我记住了什么（标签）
 * ------------------------------------------------------------------ */

/**
 * 家长关掉「记住我」时那两扇闸的状态。
 *
 * ★ 这一句必须在**标签之前**说：学生（或陪他看的家长）看到空标签时的第一反应是
 *   「怎么啥都没记住」，而真实原因可能是**他自己关掉了那个开关**。
 *   不说清这一点，界面就是在让人怀疑一个正常工作的功能。
 * ★ 这一栏**不改开关**（改的地方在设置页），只如实告知当前状态。
 */
const memoryOff = computed(() => profileCard.loaded && !profileCard.memorySwitch)
/** 家长同意闸关掉时标签为空数组（G-G）—— 同上，如实说。 */
const consentOff = computed(() => profileCard.loaded && !profileCard.parentConsent)

/* ------------------------------------------------------------------ *
 * 掌握度
 * ------------------------------------------------------------------ */

/** 知识点显示名（共用口径：取不到给中性标签，不把 slug 摆在正文里）。 */
function kpName(kpId: string): string {
  return kpLabel(kpId, null, knowledge.kpNameOf)
}
function kpNameResolved(kpId: string): boolean {
  return kpLabelResolved(kpId, null, knowledge.kpNameOf)
}

/**
 * 「最近在学」只列前几个知识点。
 *
 * ★ 为什么按**最近接触时间**排（而不是掌握度）：这一节回答的是「我最近在碰什么」——
 *   掌握度全表在左边的「概览」分页里（有排序、有导出）。口径见 `stores/insight.ts`
 *   的 `recentRows`（右栏与概览是两种读法，不是同一个排序的两处实现）。
 * ★ 为什么截断：这一栏是右栏的**一瞥**，不是全表 —— 铺太多会把下面「建议下一步」
 *   挤到一屏之外，而那才是这一栏想让学生看见的。
 */
const RECENT_LIMIT = 5

const recentRows = computed(() =>
  insight.recentRows.slice(0, RECENT_LIMIT).map((row) => ({
    kpId: row.kpId,
    name: kpName(row.kpId),
    percent: Math.round(row.score * 100)
  }))
)

/** 知识点总数 > 截断条数时给一个「还有 N 个」的去处（不让学生以为只有这几行）。 */
const recentMore = computed(() => Math.max(0, insight.recentRows.length - RECENT_LIMIT))

const recentError = computed(() => insight.errors.profile)

/**
 * 第五行（AI 小结）的正文 —— 来自画像 store（主进程缓存的只读一瞥）。
 *
 * ★ 它是**可选能力**：桥没接上 / 还没生成过 → 空串，`PortraitFacts` 会显示
 *   后端给的空态文案（「我们再聊几次，我就给你写一段小结」）。
 * ★ 打开这一页**不触发任何生成**（生成发生在画像变更之后，见 `profile-refresh`）。
 */
const summaryText = computed(() => profileCard.summary)

/* ------------------------------------------------------------------ *
 * 建议下一步
 * ------------------------------------------------------------------ */

const recommendedName = computed(() => {
  const item = insight.recommended
  if (item === null) return ''
  // ★ 服务端在查不到名字时会把 id 原样填进 name —— 那时等于没有名字（与右栏同一条口径）
  return kpLabel(item.kpId, item.name, knowledge.kpNameOf)
})

/**
 * 「去闯关检验」= 真的切到闯关页（`PAGES.quiz`）。
 * ★ 不关浮层、不改状态：本组件没有任何浮层，跳页是这一栏唯一的动作。
 */
function goQuiz(): void {
  ui.go('quiz')
}

/** 「去看看我的记录」= 切到左边的概览分页（学生看到「还有 N 个」时的下一步）。 */
function goReport(): void {
  ui.show('study', 'report')
}
</script>

<template>
  <aside class="portrait" data-testid="study-portrait" aria-label="我的画像">
    <!-- ── 头像 + 名字 + 学段 ──────────────────────────────────────── -->
    <header class="portrait__id">
      <img class="portrait__avatar" :src="avatarUrl" alt="" aria-hidden="true" draggable="false" />
      <p class="portrait__name" data-testid="portrait-name">{{ displayName }}</p>
      <!-- ★ 学段与来源之间用 `·` 连成一句，不是两个并排的 chip：
           它们是同一件事（这个学段是什么、怎么来的），拆开会读成两个独立信息。 -->
      <p class="portrait__grade" data-testid="portrait-grade">
        {{ gradeLabel }}<span class="portrait__dot">·</span>{{ gradeOriginLabelText }}
      </p>
    </header>

    <div class="portrait__body">
      <!-- ── 两扇闸关掉时的如实告知（排在标签之前，见 memoryOff 的注释）── -->
      <p v-if="memoryOff || consentOff" class="portrait__notice" data-testid="portrait-memory-off">
        <template v-if="memoryOff">
          你关掉了「记住我」，所以这里不会再增加新的内容。想打开就去设置里改。
        </template>
        <template v-else>家长暂时关掉了画像记录，所以这里没有内容。</template>
      </p>

      <!-- ── 五行结构（名字下方）────────────────────────────────────────
           ★ 类型 / 性格 / 偏好 / 兴趣 + AI 小结。行标题、空态文案、行↔键映射
             全部由后端给（`portraitRowLabels` / `portraitEmptyNotes` / `portraitRowKeys`），
             `PortraitFacts` 里一个中文名都不写（双视角纪律 D-063）。
           ★ 它**替代**了原来的「我记住了什么」分组标签列表：同一份标签按主题行重组，
             读起来更像「我是什么样的人」；撤回与「画像的变化」时间线仍只在对话页右栏
             （那里是维护入口，这里是只读一瞥）。 -->
      <PortraitFacts :summary="summaryText" />

      <!-- ── 最近在学 ────────────────────────────────────────────────
           ★ 按**最近一次接触时间**排（不是掌握度）—— 回答「我最近在碰什么」。 -->
      <section class="portrait__sec">
        <div class="portrait__head">
          <BookOpen :size="14" />
          <h3 class="portrait__title">最近在学</h3>
        </div>
        <p v-if="recentError" class="portrait__hint" data-testid="portrait-recent-error">
          {{ recentError }}
        </p>
        <EmptyState
          v-else-if="recentRows.length === 0"
          data-testid="portrait-recent-empty"
          title="还没练过"
          desc="去闯关里做第一道题，这里就会记下你最近在学什么。"
        >
          <button class="k12-cta" type="button" data-testid="portrait-empty-cta" @click="goQuiz()">
            去做第一道题
          </button>
        </EmptyState>
        <template v-else>
          <ul class="portrait__mastery" data-testid="portrait-recent">
            <li v-for="row in recentRows" :key="row.kpId" class="portrait__mrow">
              <!-- ★ `title` 只在**名字没取到**时给 id：名字正常时把一个 slug 挂在悬停里
                   毫无意义，而取不到名字时它是排障唯一的线索。 -->
              <span class="portrait__mname" :title="kpNameResolved(row.kpId) ? undefined : row.kpId">
                {{ row.name }}
              </span>
              <span class="portrait__mbar">
                <span class="portrait__mfill" :style="{ width: `${row.percent}%` }" />
              </span>
              <span class="portrait__mpct k12-num">{{ row.percent }}%</span>
            </li>
          </ul>
          <!-- ★ 截断了就说清「还有多少」（没说清的话，学生会把这一栏当成全部） -->
          <button
            v-if="recentMore > 0"
            type="button"
            class="portrait__more"
            data-testid="portrait-recent-more"
            :title="`左边「概览」里有全部 ${recentRows.length + recentMore} 个知识点的掌握度`"
            @click="goReport()"
          >
            还有 {{ recentMore }} 个，去概览里看全部
          </button>
        </template>
      </section>

      <!-- ── 建议下一步 ───────────────────────────────────────────────
           ★ 它排在最末是有意的：这一栏自上而下的读法是「我是谁 → 记住了我什么 →
             我练到哪了 → 接下来做什么」，行动落在最后才读得顺。
           ★ 没有推荐时整块不渲染，而不是摆一张空卡片。 -->
      <section v-if="insight.recommended" class="portrait__reco k12-inset">
        <div class="portrait__head">
          <Compass :size="14" />
          <h3 class="portrait__title">建议下一步</h3>
        </div>
        <p class="portrait__recotitle" data-testid="portrait-reco-title">{{ recommendedName }}</p>
        <p v-if="insight.recommended.reason" class="portrait__recodesc">
          {{ insight.recommended.reason }}
        </p>
        <button class="k12-cta portrait__recobtn" type="button" @click="goQuiz()">
          去闯关检验
        </button>
      </section>

    </div>
  </aside>
</template>

<style scoped>
/* 这一栏是**纸**（与右栏、左栏同为白纸面），而不是更深一层的卡：
 * 学习档案页的左侧内容本来就已经是「纸上的卡片」，右栏再套一层卡会读成
 * 「卡里的卡」。边界靠三件套给（右栏那一条 strong 线 + 朝桌面一侧的投影）。 */
.portrait {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--k12-surface);
  border-left: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-edge-left);
}

/* ── 身份块 ── */
.portrait__id {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 22px var(--k12-sp-4) 18px;
  /* 与下面的内容之间用一条淡线分开：这一块是「人」，下面几块是「关于他的数据」 */
  border-bottom: 1px solid color-mix(in srgb, var(--k12-border) 60%, transparent);
}

/* 头像：**一个圆底 + 蒙版成像**（不是直接摆一个方图）。
 * ★ 圆底给的是「这是一个头像位」的语义（没有它，一张 PNG 落在窄栏顶部
 *   会被读成一张插图）；`object-fit: contain` 保住吉祥物的完整形态
 *   （裁切成圆会把耳朵与蜂蜜裁掉）。
 * ★ 2026-09-30：64px → 72px。它此前比下面几行字还轻，读起来像张插图；
 *   放大到这一栏的「人」该有的分量，形状与圆底口径不动（只调尺寸）。 */
.portrait__avatar {
  width: 72px;
  height: 72px;
  padding: 3px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  object-fit: contain;
}

/* ★ 名字与学段都在头像**下方**、垂直堆叠居中；离头像留一点气口，
 *   让「人」与下面的数据块读起来是两段（顶部那条分隔线的结构不动）。 */
.portrait__name {
  margin-top: 12px;
  /* 这一栏最大的一行字 → 区块标题档（与页面 h2 同级，不抢页面身份行的层） */
  font-size: var(--k12-fs-body-lg);
  font-weight: 700;
  color: var(--k12-fg);
  text-align: center;
  word-break: break-word;
}

.portrait__grade {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  text-align: center;
}

.portrait__dot {
  margin: 0 5px;
  color: var(--k12-muted-2);
}

/* ── 内容 ── */
.portrait__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-4);
  padding: var(--k12-sp-4) var(--k12-sp-3) var(--k12-sp-5);
}

/* ★ 2026-09-30：这一块（最近在学）此前一屏吃掉太多纵向空间，
 *   内部间距整体收一档（空态与有数据两种形态都收，见下）。 */
.portrait__sec {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.portrait__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--k12-muted);
}

.portrait__title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
}

.portrait__hint {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}

/* 两扇闸关掉的告知：**warn 档**而不是 muted —— 它说的是「这里为什么是空的」，
 * 学生看一眼就要明白不是坏了。 */
.portrait__notice {
  padding: 9px 10px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
}

/* ── 空态（EmptyState）在本栏的上下文压缩 ──
 * EmptyState 的留白是按「整页空态」定的（上下 40/48 + 56px 标记）；
 * 搬进 288px 宽的画像栏里，它一个块就吃掉半屏。这里只收窄**本栏这个上下文**，
 * 不动 EmptyState 自己的配方（它还要服务整页空态）。 */
.portrait__sec :deep(.es) {
  padding: 12px 4px 14px;
  gap: 6px;
}
.portrait__sec :deep(.es__mark) {
  width: 32px;
  height: 32px;
}
.portrait__sec :deep(.es__title) {
  font-size: var(--k12-fs-body-sm);
}

/* ── 掌握度 ──
 * 自绘进度条而不是 `el-progress`：这一栏窄，`el-progress` 的轨道与文字布局
 * 在小宽度下会自己决定收缩策略（实测右栏 288px 时名字被压成两三个字）。
 * 自绘三格（名字 / 条 / 百分比）用 `minmax(0,1fr)` + `flex: none` 完全可预测。 */
/* ★ 2026-09-30：行距 7→4、行高走 snug、进度条 6→5 —— 五行一屏读得下，
 *   又不至于挤成一条线（名字仍然单行省略号）。 */
.portrait__mastery {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.portrait__mrow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 46px auto;
  align-items: center;
  gap: 6px;
}

.portrait__mname {
  min-width: 0;
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
  line-height: var(--k12-lh-snug);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.portrait__mbar {
  height: 5px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}

.portrait__mfill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent);
}

.portrait__mpct {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-snug);
  color: var(--k12-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 「还有 N 个」是一个文字动作，不是按钮：它去的地方（左边概览）在这一屏就能看到，
 * 描边按钮会把它的分量抬到与「去闯关检验」同级，而那不是这一栏想给学生的主行动。 */
.portrait__more {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k12-accent-ink);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
  .portrait__more:hover {
    text-decoration: underline;
  }
}

/* ── 建议下一步 ── */
.portrait__reco {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px 12px;
}

.portrait__recotitle {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
  word-break: break-word;
}

.portrait__recodesc {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

/* 全站同一档主行动（皮肤归 `base.css` 的 `.k12-cta`），这里只留布局。 */
.portrait__recobtn {
  align-self: flex-start;
  margin-top: 2px;
}

</style>
