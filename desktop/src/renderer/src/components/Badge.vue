<script setup lang="ts">
/**
 * 闯关徽章（票 15）：纯 CSS/内联 SVG，**不引图标库、不引 Anime.js**（§11.4）。
 *
 * 徽章文本形如 ``熟练-3``（后端 `progress.badge` 的原样值，见 `routes/quiz.py` 的
 * `badge_for`）：前半是**档位名**，后半是**答对题数**。本组件只做**展示**：
 * 把档位映射成颜色/图形，**不判对错、不算进度、不推导状态**（那些都在后端）。
 *
 * ★ 没有徽章时不渲染一个空占位 —— 父组件用 `v-if` 判断（见 ProgressCard.vue），
 *   这里拿到空串就显示「还没拿到」（中性措辞，**不出现任何锁语义**，避免出现一个
 *   「看起来拿到了但其实是空的」徽章）。
 */
import { computed } from 'vue'
import type { BadgeLevel } from '../types/component-props'
import { badgeLevelIndex, badgeLevelOf } from './badge-level'

const props = defineProps<{
  /** 徽章原值（如 `熟练-3`）；空 = 还没有徽章。 */
  badge: string | null
  /** 徽章对应的知识点名（悬停提示用，可空）。 */
  name?: string
  /**
   * 档位（**严格枚举**，报告 §4.2 的「Badge.level 改枚举」）。
   *
   * ★ 后端下发的是**中文档位名 + 计数**的原样串（`熟练-3`），所以默认从 `badge` 里解析；
   *   调用方若已经知道英文档位（将来服务端直接给 level 的场景），可以显式传它覆盖解析。
   *   两条路的取值都收在 {@link BADGE_LEVELS} 这五个字面量上 —— 不再有「任意字符串」。
   */
  level?: BadgeLevel
  /** 紧凑模式（列表里的小尺寸）。 */
  compact?: boolean
}>()

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

/**
 * 档位序号（0 = 起步；认不出的档位名退回 0，不猜高档）。
 * ★ 序号来自**枚举**（`props.level` 显式给的那一档，或从原值解析出来的那一档），
 *   不再直接拿字符串去 indexOf 中文名。
 */
const tierIndex = computed(() => {
  const level = props.level ?? badgeLevelOf(props.badge)
  return badgeLevelIndex(level)
})

const color = computed(() => TIER_COLORS[tierIndex.value] ?? TIER_COLORS[0])

/**
 * 未拿到徽章时的中性文案。
 *
 * ★ 2026-09-25 去掉关卡锁定：这里原来写「未解锁」，把「还没有徽章」说成了锁态 ——
 *   学生读到的是一道门，而不是「再答对几题就有」。现在是一句中性说明，也没有锁图标。
 */
const EMPTY_LABEL = '还没拿到'

const label = computed(() => (props.badge ? parts.value.tier : EMPTY_LABEL))

const title = computed(() => {
  if (!props.badge) return '还没有拿到徽章'
  const subject = props.name ? `${props.name}：` : ''
  return `${subject}${parts.value.tier}（答对 ${parts.value.count} 题）`
})
</script>

<template>
  <span
    class="badge"
    :class="{ 'badge--compact': compact, 'badge--empty': !badge }"
    :style="badge ? { '--badge-color': color } : undefined"
    data-testid="level-badge"
    :data-tier="badge ? parts.tier : ''"
    :data-count="badge ? parts.count : 0"
    :title="title"
  >
    <!-- 徽章图形：内联 SVG（无外链、断网可见）；还没拿到时画一颗空心星（不是锁） -->
    <svg class="badge__icon" viewBox="0 0 24 24" aria-hidden="true">
      <template v-if="badge">
        <path
          d="M12 2.5l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.35 6.2 20.4l1.1-6.45-4.7-4.6 6.5-.95z"
          :style="{ fill: color }"
        />
      </template>
      <template v-else>
        <path
          d="M12 2.5l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.35 6.2 20.4l1.1-6.45-4.7-4.6 6.5-.95z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linejoin="round"
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
  font-size: var(--k12-fs-caption);
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
  font-size: var(--k12-fs-label);
}

/* 还没拿到：中性虚线档（**不是锁态** —— 去掉关卡锁定后这里只表示「再答对几题就有」） */
.badge--empty {
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
  /* «关闭»档要能覆盖系统偏好（见 base.css 的减动效说明）：:not(...) 是那半个开关 */
  :root:not([data-k12-reduced-motion='off']) .badge {
    animation: none;
  }
}
</style>
