<script setup lang="ts">
/**
 * 学习档案 · **学习历史**（2026-09-30 新增，用户裁决）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它补的是哪个洞
 * ══════════════════════════════════════════════════════════════════════════
 * 档案页原来只有**聚合**读数：「这一周共 N 条、正确率多少、连续几天」（概览页）。
 * 学生想问的却是另一件事：「**我昨天到底做了什么**」——
 * 聚合数字回答不了这个问题，`learning_history` 里逐条的流水此前**没有任何读出口**。
 * 这一页把它按时间倒序铺出来（数据源：`GET /api/profile/{id}/history`）。
 *
 * ── ★★ 三条纪律（改这里之前先读完）─────────────────────────────────────
 *
 * 1. **动作名由后端给**（`activityLabel`）：`qa` / `animation` / `coding` / `quiz`
 *    这类内部标识一个都不出现在这一页 —— 映射的唯一来源是后端契约
 *    （`LEARNING_ACTIVITY_LABELS`）。本文件只按类型换**图标**（图标不是文字，
 *    它不承载语义，所以可以在这里分派）。
 *
 * 2. **知识点名走共用口径**（`study/kp-label.ts` 的 `kpLabel`）：中文名取不到时
 *    给中性标签 + 把 id 放进 `title`，**绝不把 slug 摆在正文里**。
 *
 * 3. **不显示「你的作答」**（与错题本同一条合规边界）：库里根本没有学生原话 ——
 *    `learning_history.question` 恒为空串（G-K「SQLite 不存对话正文」）。
 *    所以这一页只记「什么时候做了什么」，不做「答案对照」。
 *
 * ── 分页是「追加」不是「替换」───────────────────────────────────────────
 * `loadHistory({ append: true })` 把更早的一页**接在**后面。替换会让「看更早的」
 * 变成「刚才那页不见了」—— 而学生点这个按钮的意图恰恰是「往更早翻」。
 */

import { computed, onMounted } from 'vue'
import { Clapperboard, Code, MessageCircle, RefreshCw, Trophy } from 'lucide-vue-next'
import EmptyState from '../components/EmptyState.vue'
import { useKnowledgeStore } from '../stores/knowledge'
import { useStudyStore, type HistoryEventShape } from '../stores/study'
import { kpLabel, kpLabelResolved } from '../study/kp-label'

defineOptions({ name: 'StudyHistoryTab' })

const study = useStudyStore()
const knowledge = useKnowledgeStore()

onMounted(() => {
  // ★ 名字的来源是教材知识点清单（取不到时退化成中性标签，见 nameOf）。
  //   幂等：取到过就不发请求；失败不阻断本页。
  void knowledge.ensureNames().catch(() => {})
  // ★ 懒加载（与历史会话一致）：点进这一页才读，且已经有数据就不再拉。
  if (study.historyEvents.length === 0 && !study.historyLoading) void study.loadHistory()
})

/** 活动类型 → 图标。★ 只分派图标，**不分派文字**（动作名由后端给，见文件头纪律 1）。 */
function iconOf(activity: string): typeof MessageCircle {
  if (activity === 'quiz') return Trophy
  if (activity === 'animation') return Clapperboard
  if (activity === 'coding') return Code
  return MessageCircle
}

/** 知识点显示名（共用口径：取不到给中性标签，绝不显示 slug）。 */
function nameOf(kpId: string): string {
  return kpLabel(kpId, null, (id) => knowledge.kpNameOf(id))
}
function nameResolved(kpId: string): boolean {
  return kpLabelResolved(kpId, null, (id) => knowledge.kpNameOf(id))
}

/** 一天的本地日期键（`YYYY-MM-DD`）—— 分组用。 */
function dayKey(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 一天的标题：今天 / 昨天 / M月D日（「今天」比「9月30日」好读得多）。 */
function dayLabel(key: string): string {
  const today = dayKey(Date.now())
  if (key === today) return '今天'
  if (key === dayKey(Date.now() - 86_400_000)) return '昨天'
  const parts = key.split('-')
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

/** 一条的钟点（`HH:mm`）。 */
function timeOf(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 按天分组（保持倒序：最近的在前）。
 *
 * ★ 为什么在后端没分组：后端给的是**扁平流水**（它不知道学生机器上的时区与
 *   「今天」是哪天）。分组是**展示**行为，时区口径归渲染层 —— 这与
 *   「中文名归后端」并不矛盾：那是文案，这是时间轴。
 */
const dayGroups = computed(() => {
  const groups: { key: string; label: string; items: HistoryEventShape[] }[] = []
  for (const event of study.historyEvents) {
    const key = dayKey(event.at)
    if (key === '') continue
    const last = groups[groups.length - 1]
    if (last !== undefined && last.key === key) last.items.push(event)
    else groups.push({ key, label: dayLabel(key), items: [event] })
  }
  return groups
})

const isEmpty = computed(() => !study.historyLoading && study.historyEvents.length === 0)
</script>

<template>
  <section class="tab-body" data-testid="study-history">
    <div class="toolbar">
      <p class="toolbar__hint">
        你做过的事都按时间记在这里（最新的在最上面），一共 {{ study.historyTotal }} 条。
      </p>
      <div class="toolbar__actions">
        <button
          type="button"
          class="btn k12-tap"
          data-testid="history-refresh"
          :disabled="study.historyLoading"
          @click="study.loadHistory()"
        >
          <RefreshCw :size="14" />
          <span>刷新</span>
        </button>
      </div>
    </div>

    <p
      v-if="study.historyLoading && study.historyEvents.length === 0"
      class="state"
      data-testid="history-loading"
    >
      正在读你的学习记录…
    </p>
    <p v-else-if="study.historyError" class="state state--error" data-testid="history-error">
      {{ study.historyError }}
    </p>
    <EmptyState
      v-else-if="isEmpty"
      data-testid="history-empty"
      title="还没有学习记录"
      desc="去问一个问题、做一道题，或者看一段动画，这里就会按时间记下来。"
    />

    <template v-else>
      <section v-for="group in dayGroups" :key="group.key" class="day">
        <h3 class="day__title">{{ group.label }}</h3>
        <ul class="items" data-testid="history-list">
          <li
            v-for="event in group.items"
            :key="event.id"
            class="item"
            :data-activity="event.activity"
          >
            <span class="item__time k12-num">{{ timeOf(event.at) }}</span>
            <component :is="iconOf(event.activity)" :size="14" class="item__icon" />
            <span class="item__text">
              <span class="item__what">{{ event.activityLabel }}</span>
              <!-- ★ 知识点名走共用口径；名字没取到时把 id 放进 title（排障用，不上正文） -->
              <span
                v-if="event.kpId"
                class="item__kp"
                :title="nameResolved(event.kpId) ? undefined : event.kpId"
              >
                {{ nameOf(event.kpId) }}
              </span>
            </span>
            <!-- ★ 只有判过分的活动才有对错（`null` = 没有对错，不是「错了」） -->
            <span
              v-if="event.isCorrect !== null"
              class="item__mark"
              :data-correct="event.isCorrect ? 'yes' : 'no'"
            >
              {{ event.isCorrect ? '答对了' : '答错了' }}
            </span>
          </li>
        </ul>
      </section>

      <button
        v-if="study.historyHasMore"
        type="button"
        class="more k12-tap"
        data-testid="history-more"
        :disabled="study.historyLoading"
        @click="study.loadHistory({ append: true })"
      >
        {{ study.historyLoading ? '正在读…' : '看更早的' }}
      </button>
      <p v-else class="day__end">没有更早的记录了。</p>
    </template>
  </section>
</template>

<style scoped>
.tab-body {
  padding: 16px 24px 32px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.toolbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar__hint {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}

/* 按钮：与其它分页同一档（描边 + tappable 最小高度） */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 12px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.state {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.state--error {
  color: var(--k12-warn);
}

/* ── 按天分组 ── */
.day + .day {
  margin-top: 16px;
}

.day__title {
  margin: 0 0 8px;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg-2);
  letter-spacing: 0.02em;
}

.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 一条 = 一行：[钟点] [图标] [做了什么 · 关于什么] [对错]
 * ★ 用 grid 固定前两列，整天的钟点与图标就能对齐 —— 读起来才像一条时间轴。 */
.item {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
}

.item__time {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted-2);
  font-variant-numeric: tabular-nums;
}

.item__icon {
  color: var(--k12-muted);
}

.item__text {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.item__what {
  font-size: var(--k12-fs-body-sm);
  color: var(--k12-fg);
  white-space: nowrap;
}

.item__kp {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 对错标记：**只有判过分的活动才有这一格**（没判分的行右边是空的）。
 * ★ 用双色区分：答错用 warn 档（要留意），答对用主题色 ——
 *   不用纯红/纯绿：这一页是给孩子的，红绿在中文语境里另有「涨跌」的联想。 */
.item__mark {
  font-size: var(--k12-fs-caption);
  white-space: nowrap;
}
.item__mark[data-correct='yes'] {
  color: var(--k12-accent-ink);
}
.item__mark[data-correct='no'] {
  color: var(--k12-warn);
}

.more {
  display: block;
  margin: 16px auto 0;
  min-height: 32px;
  padding: 5px 16px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
.more:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.day__end {
  margin-top: 16px;
  text-align: center;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted-2);
}
</style>
