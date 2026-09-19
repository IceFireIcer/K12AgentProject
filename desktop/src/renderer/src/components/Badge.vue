<script setup lang="ts">
/**
 * 闯关徽章（票 15）：纯 CSS/内联 SVG，**不引图标库、不引 Anime.js**（§11.4）。
 *
 * 徽章文本形如 ``熟练-3``（后端 `progress.badge` 的原样值，见 `routes/quiz.py` 的
 * `badge_for`）：前半是**档位名**，后半是**答对题数**。本组件只做**展示**：
 * 把档位映射成颜色/图形，**不判对错、不算进度、不推导状态**（那些都在后端）。
 *
 * ★ 没有徽章时不渲染一个空占位 —— 父组件用 `v-if` 判断（见 ProgressCard.vue），
 *   这里拿到空串就显示「未解锁」，避免出现一个「看起来拿到了但其实是空的」徽章。
 */
import { computed } from 'vue'

const props = defineProps<{
  /** 徽章原值（如 `熟练-3`）；空 = 还没有徽章。 */
  badge: string | null
  /** 徽章对应的知识点名（悬停提示用，可空）。 */
  name?: string
  /** 紧凑模式（列表里的小尺寸）。 */
  compact?: boolean
}>()

/** 五档（与 `routes/quiz.py` 的 `BADGE_LEVELS` 一一对应，**顺序也是契约**）。 */
const BADGE_TIERS = ['起步', '初通', '熟练', '精通', '大师'] as const
/**
 * 每档的配色（按档位递进：灰 → 学段色 → 学段压深色 → 青 → 金）。
 *
 * ★ 只给 **token 名**，不写色值：色板随学段变（`tokens.generated.css`），
 *   写死 hex 会让徽章在四学段里各错一次，也会绕过对比度校验。
 */
const TIER_COLORS = [
  'var(--k12-muted-2)',
  'var(--k12-accent)',
  'var(--k12-accent-ink)',
  'var(--k12-cyan)',
  'var(--k12-warn)'
] as const

/** 拆出档位名与计数（认不出就整体当档位名，**不抛异常**）。 */
const parts = computed(() => {
  const raw = (props.badge ?? '').trim()
  if (!raw) return { tier: '', count: 0 }
  // 徽章是 `档位-计数`（如 `熟练-3`）；用第一个 `-` 分割，计数部分认不出就当 0
  const at = raw.indexOf('-')
  const tier = at >= 0 ? raw.slice(0, at) : raw
  const tail = at >= 0 ? raw.slice(at + 1) : ''
  const count = Number.parseInt(tail, 10)
  return { tier, count: Number.isFinite(count) ? count : 0 }
})

/** 档位序号（0 = 起步；认不出的档位名退回 0，不猜高档）。 */
const tierIndex = computed(() => {
  const index = BADGE_TIERS.indexOf(parts.value.tier as (typeof BADGE_TIERS)[number])
  return index >= 0 ? index : 0
})

const color = computed(() => TIER_COLORS[tierIndex.value] ?? TIER_COLORS[0])

const label = computed(() => (props.badge ? parts.value.tier : '未解锁'))

const title = computed(() => {
  if (!props.badge) return '还没有拿到徽章'
  const subject = props.name ? `${props.name}：` : ''
  return `${subject}${parts.value.tier}（答对 ${parts.value.count} 题）`
})
</script>

<template>
  <span
    class="badge"
    :class="{ 'badge--compact': compact, 'badge--locked': !badge }"
    :style="badge ? { '--badge-color': color } : undefined"
    data-testid="level-badge"
    :data-tier="badge ? parts.tier : ''"
    :data-count="badge ? parts.count : 0"
    :title="title"
  >
    <!-- 徽章图形：内联 SVG（无外链、断网可见）；锁定时画一把小锁 -->
    <svg class="badge__icon" viewBox="0 0 24 24" aria-hidden="true">
      <template v-if="badge">
        <path
          d="M12 2.5l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.35 6.2 20.4l1.1-6.45-4.7-4.6 6.5-.95z"
          :style="{ fill: color }"
        />
      </template>
      <template v-else>
        <path
          d="M8 10V7.5A4 4 0 0 1 16 7.5V10h.5a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 16.5 19h-9A1.5 1.5 0 0 1 6 17.5v-6A1.5 1.5 0 0 1 7.5 10H8zm2 0h4V7.5a2 2 0 0 0-4 0V10z"
          fill="currentColor"
        />
      </template>
    </svg>
    <span class="badge__text">{{ label }}</span>
    <span v-if="badge && !compact" class="badge__count">×{{ parts.count }}</span>
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px 3px 6px;
  border-radius: var(--k12-r-pill);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
  background: color-mix(in srgb, var(--badge-color, var(--k12-accent)) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--badge-color, var(--k12-accent)) 42%, transparent);
  /* 授予徽章时弹一下：250ms 的 CSS 关键帧，不引动画库。
   * 这是「刚刚拿到了」的一次性状态反馈（非装饰性循环动效），
   * 与 EmptyState 的加载环同一口径：prefers-reduced-motion 下关闭。 */
  animation: badge-pop 250ms ease-out;
}

.badge--compact {
  padding: 2px 7px 2px 5px;
  /* k12-mark：紧凑徽章（列表里的小记号），角标档 11px —— 与 .badge 的 12px 拉开一档 */
  font-size: var(--k12-fs-micro);
}

.badge--locked {
  color: var(--k12-muted-2);
  background: transparent;
  border-color: var(--k12-border-strong);
  border-style: dashed;
  animation: none;
}

.badge__icon {
  width: 14px;
  height: 14px;
  flex: none;
}

.badge--compact .badge__icon {
  width: 12px;
  height: 12px;
}

.badge__count {
  font-variant-numeric: tabular-nums;
  color: var(--k12-muted);
  font-weight: 500;
}

@keyframes badge-pop {
  0% {
    transform: scale(0.82);
    opacity: 0.4;
  }
  60% {
    transform: scale(1.06);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .badge {
    animation: none;
  }
}
</style>
