<script setup lang="ts">
/**
 * 闯关进度条（票 15）：一条纯 CSS 的横向进度 + 关卡节点。
 *
 * ★ 三条纪律（改这个文件前先读）：
 *
 * 1. **不引游戏引擎、不引 Anime.js**（执行文档 §11.4 明确要求）：动画只用 CSS
 *    `transition` / `@keyframes`。Anime.js 只服务动画卡片（票 16/17），
 *    闯关 UI 引它等于把一个 40KB 的库拖进对话首屏。
 * 2. **不持有状态机**（票 15 的 grep 验收：前端不许自持 `locked|mastered` 的实现）：
 *    `stage` 一律由父组件从**后端返回的 progress 数据**透传进来，本组件只做
 *    「把 stage 映射成颜色/文案」，**不推导**下一个状态。
 * 3. **素材全部本地**：没有图标字体、没有外链 SVG、没有 CDN —— 断网演示时进度条
 *    必须照常显示（徽章的图形用内联 SVG path，见 `Badge.vue`）。
 */
import { computed } from 'vue'

const props = defineProps<{
  /** 当前进度（0..1）。**由后端给的已通过关数 / 总关数算出**，组件不自己数。 */
  value: number
  /** 总关卡数（0 时退化成「准备中」，而不是除零）。 */
  total: number
  /** 已通过关数（展示用）。 */
  done: number
  /** 紧凑模式（放在卡片头部时用）。 */
  compact?: boolean
}>()

/** 夹紧到 0..1（后端理论上已经算好，这里是最后一道防呆，**不参与业务判定**）。 */
const ratio = computed(() => {
  const raw = Number(props.value)
  if (!Number.isFinite(raw)) return 0
  return Math.max(0, Math.min(1, raw))
})

const percent = computed(() => Math.round(ratio.value * 100))

const label = computed(() => {
  if (props.total <= 0) return '准备中'
  return `已通过 ${props.done} / ${props.total} 关`
})
</script>

<template>
  <div
    class="progress"
    :class="{ 'progress--compact': compact }"
    data-testid="progress-bar"
    :data-value="ratio.toFixed(3)"
    :data-total="total"
    :data-done="done"
    role="progressbar"
    :aria-valuenow="percent"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="label"
  >
    <div class="progress__track">
      <div class="progress__fill" :style="{ width: `${percent}%` }"></div>
    </div>
    <span class="progress__label" data-testid="progress-label">{{ label }}</span>
  </div>
</template>

<style scoped>
.progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress--compact {
  gap: 8px;
}

.progress__track {
  position: relative;
  flex: 1;
  height: 10px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  overflow: hidden;
}

.progress--compact .progress__track {
  height: 7px;
}

.progress__fill {
  position: relative;
  height: 100%;
  border-radius: var(--k12-r-pill);
  /* accent → accent-2：同一组主题色的两端，不写死色值 */
  background: linear-gradient(90deg, var(--k12-accent) 0%, var(--k12-accent-2) 100%);
  /* ★ 进度变化时只做一次状态过渡（CSS，不引动画库）；prefers-reduced-motion 下关掉。
   * 时长与曲线用全站唯一的两个 token（版式契约 §6）。 */
  transition: width var(--k12-dur-state) var(--k12-ease-state);
}

.progress__label {
  flex: none;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .progress__fill {
    transition: none;
  }
}
</style>
