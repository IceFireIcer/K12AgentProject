<script setup lang="ts">
/**
 * 闯关进度卡片（票 15，执行文档 §11.4 的游戏化部分）：进度条 + 逐关徽章。
 *
 * ★ 数据全部来自**后端**（`learning.db` 的 `progress` 表 → `POST /api/quiz/grade` 的
 *   payload 里带回 → 这里渲染）。**前端不自持状态机**（票 15 的 grep 验收）：
 *   本组件里没有 `locked → learning → …` 的任何推导，只有一个「stage → 中文/配色」
 *   的映射表；谁该解锁谁、什么时候解锁，全由 `routes/quiz.py` 的 `apply_level_progress` 决定。
 *
 * ★ 载荷形状（`quiz.levels`，由 `quiz.ts` 出题/判分的结果带回）：
 *
 *     { levels: [{ kpId, stage, badge, mastery }], progress: { done, total } }
 *
 *   认不出的载荷 → 渲染成一句说明，**不猜字段**（与 `cards/quiz.ts` 同一口径）。
 *   脏数据绝不让整轮对话渲染炸掉。
 *
 * ★ 轻量实现（§11.4）：动画只用 CSS `transition` / `@keyframes`，**不引游戏引擎、不引 Anime.js**。
 */
import { computed } from 'vue'
import Badge from '../components/Badge.vue'
import ProgressBar from '../components/ProgressBar.vue'

/** 一个关卡（`progress` 表的一行 + 该知识点的掌握度）。 */
interface LevelView {
  kpId: string
  /** `locked | learning | quizzed | mastered`（契约 `ProgressStage`，**后端是唯一权威**）。 */
  stage: string
  badge: string | null
  mastery: number
}

const props = defineProps<{
  /** `payload` 事件里的载荷（`unknown`，这里做白名单投影）。 */
  payload?: unknown
}>()

/** 状态 → 中文（只做展示映射，**不推导**下一个状态）。 */
const STAGE_LABELS: Record<string, string> = {
  locked: '未解锁',
  learning: '学习中',
  quizzed: '已通过',
  mastered: '已掌握'
}

/** 状态 → 徽标配色（CSS 类名，样式在下面）。 */
const STAGE_CLASSES: Record<string, string> = {
  locked: 'stage--locked',
  learning: 'stage--learning',
  quizzed: 'stage--quizzed',
  mastered: 'stage--mastered'
}

/** 白名单投影：只认这四个字段，其余一律丢掉。 */
function projectLevel(raw: unknown): LevelView | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const kpId = typeof record.kpId === 'string' && record.kpId.trim() ? record.kpId.trim() : null
  if (kpId === null) return null
  const stage = typeof record.stage === 'string' ? record.stage : ''
  const badge = typeof record.badge === 'string' && record.badge.trim() ? record.badge.trim() : null
  const masteryRaw = Number(record.mastery)
  return {
    kpId,
    // 认不出的 stage 当 `locked` 显示（**不猜**「可能已经通过了」——那是在给学生假进度）
    stage: stage in STAGE_LABELS ? stage : 'locked',
    badge,
    mastery: Number.isFinite(masteryRaw) ? Math.max(0, Math.min(1, masteryRaw)) : 0
  }
}

const view = computed(() => {
  const raw = props.payload
  if (!raw || typeof raw !== 'object') return { kind: 'unknown' as const, levels: [], done: 0, total: 0 }
  const record = raw as Record<string, unknown>
  const levels = Array.isArray(record.levels)
    ? record.levels.map(projectLevel).filter((item): item is LevelView => item !== null)
    : []
  if (levels.length === 0) return { kind: 'unknown' as const, levels: [], done: 0, total: 0 }

  // ★ 已通过关数**按 stage 数**（不是按徽章数：徽章只在答对时给，两者在边界上可能不同），
  //   并且与后端 `progress_snapshot` 给的结果保持同一口径。
  const done = levels.filter((item) => item.stage === 'quizzed' || item.stage === 'mastered').length
  // 总关数：后端可在载荷里显式给（`progress.total` 或顶层 `total`）；给不出就用条目数。
  const progressMeta = (record.progress ?? {}) as Record<string, unknown>
  const declared = Number(progressMeta.total ?? record.total)
  const total = Number.isFinite(declared) && declared > 0 ? declared : levels.length
  return { kind: 'ok' as const, levels, done, total }
})

const ratio = computed(() => (view.value.total > 0 ? view.value.done / view.value.total : 0))

/** 拿到的徽章（展示在头部，最近的一个）。 */
const earnedBadges = computed(() => view.value.levels.filter((item) => item.badge))
</script>

<template>
  <article
    v-if="view.kind === 'ok'"
    class="levels"
    data-testid="progress-card"
    :data-done="view.done"
    :data-total="view.total"
  >
    <header class="levels__head">
      <span class="title">闯关进度</span>
      <Badge
        v-if="earnedBadges.length > 0"
        :badge="earnedBadges[earnedBadges.length - 1].badge"
        :name="earnedBadges[earnedBadges.length - 1].kpId"
        compact
      />
      <span v-else class="chip" data-testid="progress-no-badge">还没有徽章</span>
    </header>

    <ProgressBar :value="ratio" :total="view.total" :done="view.done" />

    <ol class="levels__list" data-testid="progress-levels">
      <li
        v-for="level in view.levels"
        :key="level.kpId"
        class="level"
        :class="STAGE_CLASSES[level.stage]"
        data-testid="progress-level"
        :data-kp-id="level.kpId"
        :data-stage="level.stage"
        :data-badge="level.badge ?? ''"
      >
        <span class="level__dot" aria-hidden="true"></span>
        <span class="level__name">{{ level.kpId }}</span>
        <span class="level__stage" data-testid="progress-stage">{{ STAGE_LABELS[level.stage] }}</span>
        <span class="level__mastery" data-testid="progress-mastery">
          {{ level.mastery.toFixed(2) }}
        </span>
        <Badge v-if="level.badge" :badge="level.badge" :name="level.kpId" compact />
      </li>
    </ol>

    <p class="levels__foot">
      答对当前关卡后，依赖图里它的下一关会自动解锁；徽章与掌握度都记在本机的学习记录里。
    </p>
  </article>

  <!-- 认不出的载荷：一句说明，绝不猜（与练习卡片同一口径） -->
  <article v-else class="levels levels--unknown" data-testid="progress-card-unknown">
    <header class="levels__head">
      <span class="title">闯关进度</span>
      <span class="chip chip--warn">暂时读不到进度</span>
    </header>
    <p class="levels__foot">进度数据还没准备好，做一道题之后就会显示出来。</p>
  </article>
</template>

<style scoped>
.levels {
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.levels--unknown {
  border-style: dashed;
}

.levels__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.title {
  font-size: 14px;
  font-weight: 650;
}

.levels__list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.level {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  border: 1px solid var(--border);
  font-size: 13px;
  transition: border-color 200ms ease-out, background 200ms ease-out;
}

.level__dot {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  background: var(--border-strong);
}

/* 四档配色：未解锁灰、学习中蓝、已通过绿、已掌握金 */
.stage--locked {
  opacity: 0.62;
}

.stage--learning {
  border-color: rgba(47, 111, 208, 0.5);
}

.stage--learning .level__dot {
  background: var(--accent);
}

.stage--quizzed {
  border-color: rgba(46, 160, 92, 0.5);
  background: color-mix(in srgb, #2ea05c 8%, var(--surface-muted));
}

.stage--quizzed .level__dot {
  background: #2ea05c;
}

.stage--mastered {
  border-color: rgba(217, 160, 36, 0.55);
  background: color-mix(in srgb, #d9a024 10%, var(--surface-muted));
}

.stage--mastered .level__dot {
  background: #d9a024;
}

.level__name {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  word-break: break-all;
}

.level__stage {
  flex: none;
  font-weight: 650;
  color: var(--text-muted);
}

.level__mastery {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
  font-size: 12px;
}

.levels__foot {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-faint);
}
</style>
