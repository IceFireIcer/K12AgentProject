<script setup lang="ts">
/**
 * 闯关进度卡片（票 15，执行文档 §11.4 的游戏化部分）：进度条 + 逐关徽章。
 *
 * ★ 数据全部来自**后端**（`learning.db` 的 `progress` 表 → `POST /api/quiz/grade` 的
 *   payload 里带回 → 这里渲染）。**前端不自持状态机**（票 15 的 grep 验收）：
 *   本组件里没有 `quizzed → mastered` 的任何推导，只有一个「stage → 中文/配色」
 *   的映射表；一关算不算走完，全由 `routes/quiz.py` 的 `apply_level_progress` 决定。
 *   ★ 2026-09-25 去掉关卡锁定：不再有「未解锁」这一档（所有关卡都能做），
 *     前端也不再有「哪一关什么时候解锁」的任何判断。
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
import { computed, onMounted, ref } from 'vue'
import Badge from '../components/Badge.vue'
import ProgressBar from '../components/ProgressBar.vue'
import CardHeader from '../components/card/CardHeader.vue'
import CardBody from '../components/card/CardBody.vue'
import CardFoot from '../components/card/CardFoot.vue'
import { useKnowledgeStore } from '../stores/knowledge'
import { kpLabel } from '../study/kp-label'
// ★ 玻璃边缘光效（2026-09-30 报告 §4.3 一期）：根元素挂 k12-shine，变量由 composable 写。
import { useCardShine } from '../composables/useCardShine'

/** 知识点在界面上的名字（**教材里的中文名**，取不到就不显示名字那一格）。 */
const knowledge = useKnowledgeStore()

/**
 * ★★ 关卡名原来直接印 `{{ level.kpId }}` —— 于是这张卡片在对话里长成
 *   `ai-definition-jr  学习中  0.00`：学生看到的是**数据库主键**，不是知识点的名字。
 *   走查把它列为「开发测试数据泄漏」的典型（「一个读不懂的机器串 0.00」那一屏就是它）。
 * ★ 与 `CodingCard` / `QuizCard` / 学习档案同一条口径（`study/kp-label.ts`）：
 *   取不到中文名就**不显示名字那一格**，绝不回落成 slug；
 *   原始 id 仍在 `<li>` 的 `data-kp-id` 上（排障与断言要用，但不渲染）。
 */
function levelName(kpId: string): string {
  const name = kpLabel(kpId, null, knowledge.kpNameOf)
  return name === '未命名知识点' ? '' : name
}

/** 徽章的 `name` 会进 tooltip（`Badge.vue` 的 `title`）—— 同样不许把 slug 写进去。 */
function badgeName(kpId: string): string {
  return levelName(kpId)
}

onMounted(() => {
  // 名字表是异步取的；失败不阻断卡片（最多少显示一列名字）
  void knowledge.ensureNames().catch(() => {})
})

/** 一个关卡（`progress` 表的一行 + 该知识点的掌握度）。 */
interface LevelView {
  kpId: string
  /**
   * `learning | quizzed | mastered`（契约 `ProgressStage` 里仍留着旧的 `locked`，
   * 但去掉关卡锁定后后端不再下发它，前端也不再据此做任何限制）。**后端是唯一权威**。
   */
  stage: string
  badge: string | null
  mastery: number
}

const props = defineProps<{
  /** `payload` 事件里的载荷（`unknown`，这里做白名单投影）。 */
  payload?: unknown
}>()

/** 卡片根元素（光效写 CSS 变量的落点；两条分支共用它，同时只渲染一条）。 */
const rootRef = ref<HTMLElement | null>(null)
useCardShine(rootRef)

/** 状态 → 中文（只做展示映射，**不推导**下一个状态）。 */
const STAGE_LABELS: Record<string, string> = {
  learning: '学习中',
  quizzed: '已通过',
  mastered: '已掌握'
}

/**
 * 展示用的状态名（认不出的字面量兜一手）。
 *
 * ★ 契约枚举值**没有改**（`ProgressStage` 里仍留着 `locked` 这个旧字面量），
 *   万一真收到它，这里按「可作答」显示 —— 防御性兼容：去掉关卡锁定后所有关卡都能做，
 *   界面上不再出现任何「未解锁」的呈现。
 */
function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? '可作答'
}

/** 状态 → 徽标配色（CSS 类名，样式在下面；认不出的状态没有专属配色）。 */
const STAGE_CLASSES: Record<string, string> = {
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
    // 认不出的 stage 原样带出，由 `stageLabel` 按「可作答」显示 —— 去掉关卡锁定后
    // 不再把任何状态呈现成「未解锁」（旧写法把认不出的状态一律挡成锁态）。
    stage,
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
  <!-- ★ 光效挂载点：静态 class 被 card-structure 守卫逐个钉着（不能改字符），
       所以 k12-shine 走 :class；两条分支共用同一个 rootRef。 -->
  <article
    v-if="view.kind === 'ok'"
    ref="rootRef"
    class="k12-card levels"
    :class="{ 'k12-shine': true }"
    data-testid="progress-card"
    data-probe-id="progress-card"
    :data-probe-count="view.levels.length"
    :data-done="view.done"
    :data-total="view.total"
  >
    <CardHeader>
      <template #title>
        <span class="title">闯关进度</span>
      </template>
      <template #meta>
        <Badge
          v-if="earnedBadges.length > 0"
          :badge="earnedBadges[earnedBadges.length - 1].badge"
          :name="badgeName(earnedBadges[earnedBadges.length - 1].kpId)"
          compact
        />
        <span v-else class="chip" data-testid="progress-no-badge">还没有徽章</span>
      </template>
    </CardHeader>

    <CardBody>
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
          <!-- ★ 名字取不到时这一格不渲染（见 `levelName` 的说明）；
               原始 id 在 `<li>` 的 `data-kp-id` 上，不在这里显示。 -->
          <span v-if="levelName(level.kpId)" class="level__name">{{ levelName(level.kpId) }}</span>
          <span class="level__stage" data-testid="progress-stage">{{ stageLabel(level.stage) }}</span>
          <span class="level__mastery" data-testid="progress-mastery">
            {{ level.mastery.toFixed(2) }}
          </span>
          <Badge v-if="level.badge" :badge="level.badge" :name="levelName(level.kpId)" compact />
        </li>
      </ol>
    </CardBody>

    <CardFoot>
      <p class="levels__foot">
        每答对一题，这里的进度与掌握度都会跟着变一点；徽章也记在本机的学习记录里。
      </p>
    </CardFoot>
  </article>

  <!-- 认不出的载荷：一句说明，绝不猜（与练习卡片同一口径） -->
  <article
    v-else
    ref="rootRef"
    class="k12-card levels levels--unknown"
    :class="{ 'k12-shine': true }"
    data-testid="progress-card-unknown"
  >
    <CardHeader>
      <template #title>
        <span class="title">闯关进度</span>
      </template>
      <template #meta>
        <span class="chip chip--warn">暂时读不到进度</span>
      </template>
    </CardHeader>
    <CardBody>
      <p class="levels__foot">进度数据还没准备好，做一道题之后就会显示出来。</p>
    </CardBody>
  </article>
</template>

<style scoped>
/* 卡片皮肤（白面 / 边框 / 圆角 / 投影）唯一来源 = base.css 的 `.k12-card`；
 * 三段结构的内边距与底色 = `.k12-card-head/-body/-foot`。
 * ⚠️ 不在这里写 color-mix 造第五种表面 —— 层次只有 page / surface / surface-2 / float 四层。 */
.levels {
  min-width: 0;
}

.levels--unknown {
  border-style: dashed;
}

.title {
  /* 档位由 `.k12-card-head` 给（h3 20px）；这里只补字重 */
  font-weight: 650;
  color: var(--k12-fg);
}

/* 状态胶囊：全局不再提供 .chip（见 base.css 的材质层），本组件自带一份。 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
}

.chip--warn {
  background: var(--k12-warn-soft);
  border-color: var(--k12-warn-border);
  color: var(--k12-warn);
}

.levels__list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

/* 每一关 = 卡片内的嵌入块（E3）：surface-2 底 + 一档圆角 */
.level {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  font-size: var(--k12-fs-body-sm);
  transition:
    border-color var(--k12-dur-state) var(--k12-ease-state),
    background var(--k12-dur-state) var(--k12-ease-state);
}

.level__dot {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  background: var(--k12-border-strong);
}

/* 三档配色：学习中主色、已通过绿、已掌握金（都是主题色，不写死色值）。
 * ★ 2026-09-25 去掉关卡锁定后不再有「未解锁」灰档与锁态呈现。 */
.stage--learning {
  border-color: color-mix(in srgb, var(--k12-accent) 50%, transparent);
}

.stage--learning .level__dot {
  background: var(--k12-accent);
}

.stage--quizzed {
  border-color: color-mix(in srgb, var(--k12-good) 50%, transparent);
  background: color-mix(in srgb, var(--k12-good) 8%, var(--k12-surface-2));
}

.stage--quizzed .level__dot {
  background: var(--k12-good);
}

.stage--mastered {
  border-color: color-mix(in srgb, var(--k12-warn) 55%, transparent);
  background: color-mix(in srgb, var(--k12-warn) 10%, var(--k12-surface-2));
}

.stage--mastered .level__dot {
  background: var(--k12-warn);
}

.level__name {
  flex: 1;
  min-width: 0;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
  word-break: break-all;
}

.level__stage {
  flex: none;
  font-weight: 650;
  color: var(--k12-muted);
}

.level__mastery {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--k12-muted-2);
  font-size: var(--k12-fs-caption);
}

.levels__foot {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted-2);
}
</style>
