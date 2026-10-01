<script setup lang="ts">
/**
 * 画像标签卡：「我记住了什么」的**唯一渲染实现** —— **当前只在对话页右栏**（`ContextRail.vue`）挂载。
 *
 * ⚠️ 2026-10-01 更正一句过时的说明：学习档案右栏**已不再引用本组件**，
 *   它换成了 `components/PortraitFacts.vue`（五行结构那份，见那个文件头部的取舍）。
 *   本组件保留「分组 + 来源标注 + 可撤回」这套维护能力 —— 那是**对话页**才需要的入口。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么抽这一个组件
 * ══════════════════════════════════════════════════════════════════════════
 * 这段 UI 原先**只长在** `components/ContextRail.vue` 里（票 27）。
 * 学习档案页开出右侧 20% 之后，同一份画像要在**两处**出现 ——
 * 各抄一份的后果不是「重复代码」，而是两条会各自漂移的口径：
 *   · 来源那三句话改一处忘另一处 → 学生在一个页面被告知「这是猜的」，
 *     到另一个页面同样的标签却看不出它是猜的；
 *   · 「哪些标签能撤」的规则一旦分叉，界面就开始替学生做他没做的事。
 * 所以落点是一个组件 + 一个 `retractable` 开关，而不是两份近似实现。
 *
 * ── ★★ `retractable` 是**模式开关**，不是功能删的一半 ──────────────────
 *   `true`（对话页右栏）：猜出来的那些带「不对」按钮，撤销是学生纠错的地方；
 *   `false`（学习档案右栏）：**同一份数据的只读视图** ——
 *     猜的那一条照样左侧一道 accent 竖线、照样写「我猜的（把握 72%）」，
 *     只是不给那个按钮。少的是动作，**不是信息**：
 *     把「这是猜的」藏起来才是真的删功能。
 *     （档案页那一栏的定位是「看看智团团记住了什么」，不是在这一栏里维护它 ——
 *      同一屏摆两个能做同一件事的入口，学生只会搞不清刚才点的是哪个。）
 *
 * ── 三条纪律（改这里之前先读完）─────────────────────────────────────────
 *   1. **每一个中文字都由后端给**：`tag.label`（这一条叫什么）来自
 *      `server/app/contracts.py` 的 `TAG_LABELS`，维序来自同一侧的 `TAG_DIMENSIONS`，
 *      **组标题**（这一组叫什么）来自 `TAG_DIMENSION_LABELS` —— 随载荷的
 *      `dimensionLabels` 下发。本文件**一个标签名/维度名都不写死** ——
 *      渲染进程的每个字符串字面量都会被 `tests/student-view-discipline.test.ts`
 *      扫到，写一个等于给守卫开一个洞。
 *   2. **来源必须一眼看得见**：猜的那一档左边一道 accent 竖线，另两档是普通线。
 *      三档同款排版 = 没说 —— 而「我记得他说过」与「我猜的」是两类东西。
 *   3. **撤销等回执、不做乐观更新**（纪律在 `stores/profileCard.ts`）：
 *      本组件只调 `retract()`，界面重画与否由回执里的完整清单决定。
 */

import { computed } from 'vue'
import { History, Tags } from 'lucide-vue-next'
import {
  SOURCE_LABELS,
  canRetract,
  confidencePercent,
  useProfileCardStore
} from '../../stores/profileCard'

const props = withDefaults(
  defineProps<{
    /**
     * 是否带「不对」撤回按钮。
     *
     * ★ 对话页右栏 `true`（那里是画像的维护入口）；学习档案右栏 `false`（只读视图）。
     * ⚠️ 关掉它**不改变**任何数据与视觉分层，只移除那个按钮。
     */
    retractable?: boolean
    /** 是否自带「我记住了什么」这一节的小标题（宿主已有分组标题时可关掉）。 */
    heading?: boolean
    /** 是否带画像变化时间线。 */
    timeline?: boolean
  }>(),
  { retractable: true, heading: true, timeline: true }
)

const profileCard = useProfileCardStore()

/**
 * 「能不能撤」的界面判据 = 「后端说它可撤」**且**「本视图允许撤」。
 *
 * ★★ 两个条件缺一不可：只判前者，档案页那一栏会长出按钮；只判后者，
 *    学生会把「你告诉我的」那些也撤掉 —— 他真说过，撤了不是纠错，是抹证据。
 */
function retractableTag(tag: Parameters<typeof canRetract>[0]): boolean {
  return props.retractable && canRetract(tag)
}

/** 有没有「变化」这一段（同理：`false` 时尊重消失）。 */
const hasTimeline = computed(
  () => props.timeline && profileCard.timelineAvailable && profileCard.timeline.length > 0
)

/**
 * 时间线的日期（毫秒 → 「9月26日」）。
 *
 * ★ 只到「日」：画像的变化是天级尺度的事（学段调整、兴趣改变），
 *   精确到分钟对 10 岁的孩子没有意义，反而像系统日志。
 * ★ 取不到返回空串：渲染成空白，而不是 Invalid Date 这种技术话。
 */
function timelineWhen(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.getMonth() + 1 + '月' + date.getDate() + '日'
}
</script>

<template>
  <section class="pt" data-testid="profile-tags">
    <template v-if="props.heading">
      <div class="pt__head">
        <Tags :size="14" />
        <h3 class="pt__title">我记住了什么</h3>
      </div>
    </template>

    <p v-if="profileCard.bridgeError" class="pt__hint" data-testid="profile-tags-bridge">
      {{ profileCard.bridgeError }}
    </p>
    <p v-else-if="!profileCard.hasTags" class="pt__hint" data-testid="profile-tags-empty">
      还没记住什么。你多问几句、做几道题，我就会慢慢记住你的偏好。
    </p>

    <template v-else>
      <div v-for="group in profileCard.groups" :key="group.dimension" class="pt__group">
        <!-- ★ 组标题（后端给的维度名）：光有一串标签、看不出「讲解风格 / 节奏 /
             练习方式」是同类，学生记不住也读不出结构。空标题**整行不渲染** ——
             宁可没有小标题，也不在这里拼一个名字出来。 -->
        <h4 v-if="group.title" class="pt__group-title" data-testid="profile-group-title">
          {{ group.title }}
        </h4>
        <ul class="pt__list">
          <li v-for="tag in group.tags" :key="tag.key" class="pt__tag" :data-source="tag.source">
            <span class="pt__text">
              <span class="pt__label">{{ tag.label }}</span>
              <span class="pt__value">{{ tag.value }}</span>
            </span>
            <span class="pt__src">
              {{ SOURCE_LABELS[tag.source] }}
              <template v-if="confidencePercent(tag) !== null">
                （把握 {{ confidencePercent(tag) }}%）
              </template>
            </span>
            <button
              v-if="retractableTag(tag)"
              type="button"
              class="pt__drop"
              data-testid="profile-tag-retract"
              :title="`这条是猜的，点一下就不留了：${tag.label}`"
              :disabled="profileCard.retracting === tag.key"
              @click="profileCard.retract(tag)"
            >
              不对
            </button>
          </li>
        </ul>
      </div>
      <p v-if="profileCard.notice" class="pt__warn" data-testid="profile-tag-notice">
        {{ profileCard.notice }}
      </p>
    </template>

    <!-- ★★ 画像变化时间线（§5.2 #11）：`profile:tags` 只给当前值，回答不了「过程」。
         ⚠️ 它是**后加的一条读通道**，preload 没接上时整段不渲染，
            而不该把上面的标签卡一起拖下线（既有能力被新能力连坐，是踩过的坑）。 -->
    <template v-if="hasTimeline">
      <div v-if="props.heading" class="pt__head pt__head--gap">
        <History :size="14" />
        <h3 class="pt__title">画像的变化</h3>
      </div>
      <ol class="pt__timeline" data-testid="profile-timeline">
        <li
          v-for="event in profileCard.timeline"
          :key="event.at + '-' + event.kind + '-' + event.title"
          class="pt__timeline-item"
          :data-kind="event.kind"
          :data-origin="event.origin ?? ''"
        >
          <span class="pt__when">{{ timelineWhen(event.at) }}</span>
          <span class="pt__what">{{ event.title }}</span>
          <!-- ★ 出处（迁移 v7）只在 `detail` 里以**中文句子**出现（后端拼好）。
               这里**不**把 origin 的枚举值翻成文字 —— 渲染层写死一份映射就是
               给 student-view-discipline 守卫开洞（与「每个中文字都由后端给」同一纪律）。
               origin 只用来驱动 `data-origin`（配色/图标），文本仍由 detail 承担。 -->
          <span v-if="event.detail" class="pt__why">{{ event.detail }}</span>
        </li>
      </ol>
    </template>
  </section>
</template>

<style scoped>
.pt {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pt__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--k12-muted);
}

/* 与上面那段内容之间补 8px：它是**跟在内容后面**的一节小标题，
 * 不是一屏内容的开头（与原先 ContextRail 的 `.sec__head--gap` 同一口径）。 */
.pt__head--gap {
  margin-top: 8px;
}

.pt__title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
}

.pt__hint {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}

.pt__warn {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-warn);
}

.pt__group + .pt__group {
  margin-top: 10px;
}

/* 组标题（维度名，后端给）：比标签名稍重、比页面标题稍轻 ——
 * 它是分组的分隔线而不是又一级标题，所以不抢主标题的份量。 */
.pt__group-title {
  margin: 0 0 6px;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg-2);
  letter-spacing: 0.02em;
}

.pt__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 一条 = **两行**（2026-10-01 用户报「上下文那一页设计得不好」后重排）：
 *   第一行：[中文名 + 值]；第二行：来源说明（「我从你的学习里看到的（把握 0%）」），
 *   可撤的那条把「不对」跟在来源同一行右端。
 *
 * ★★ 为什么必须换行（真机实测的塌陷）：原来这一行是**不换行的 flex**，而 `.pt__src`
 *   是 `flex: none` —— 它按最长内容占宽（那句话 16 个字），把 `.pt__text` 挤到只剩一个字宽，
 *   「知识点」于是被压成 **竖排单字**（知/识/点），「错误类型」压成 错/误/类/型。
 *   学习记录页那栏更宽所以一直没暴露，右栏 288px 一放就崩。
 *   → 让来源说明整段走第二行，第一行就永远够宽；窄栏宽栏都成立。
 * ★ 左侧那道 2px 竖线是**来源的视觉分层**：猜的那一档换成 accent，
 *   学生不必先读字就能分出「他知道」与「他在猜」。 */
.pt__tag {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  padding: 8px 10px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border-left: 2px solid var(--k12-border-strong);
}
.pt__tag[data-source='inferred'] {
  border-left-color: var(--k12-accent);
}

/* 第一行 =「键 值」**同一行**（2026-10-01 复核时定的版）：
 *   原先键在上、值在下（两行），加上来源说明就是**三行**一条 —— 右栏 288px 里五条就把整栏撑满，
 *   扫读时要上下跳。键（知识点 / 掌握度 / 错误类型）都是两三个字、值也短，
 *   并成一行既省一半高度，又和站内其余「键 + 值」的读法一致（如「掌握度 20%」）。
 *   `flex-wrap` 让长值自然换到键的下一行，不会把键压扁。 */
.pt__text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 6px;
  min-width: 0;
  /* 第一行整行归它：`100%` 让它独占一行，来源说明只能挪到下一行（见 `.pt__tag` 的说明）。 */
  flex: 1 1 100%;
}

.pt__label {
  /* 键不参与伸缩：它一旦被挤，就会退回「一个字一行」的塌陷（本文件头部记的那次真机事故）。 */
  flex: none;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}

.pt__value {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--k12-fs-body-sm);
  color: var(--k12-fg);
  word-break: break-word;
}

.pt__src {
  /* 第二行：整段可换行、左对齐（当年「右对齐」是为了在宽栏里与值并排，现在它自成一行）。 */
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted-2);
}
/* 「不对」跟在来源同一行的右端（它只在可撤的那条出现）。 */
.pt__tag .pt__drop {
  margin-left: auto;
}

.pt__drop {
  flex: none;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .pt__drop:hover:not(:disabled) {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}
.pt__drop:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.pt__timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k12-space-2, 8px);
}

.pt__timeline-item {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--k12-space-2, 8px);
  font-size: var(--k12-fs-caption);
  line-height: 1.5;
}

.pt__when {
  color: var(--k12-fg-3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.pt__what {
  color: var(--k12-fg);
}

.pt__why {
  grid-column: 2;
  color: var(--k12-fg-3);
}
</style>
