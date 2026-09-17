<script setup lang="ts">
/**
 * ★ 当前学段的**只读指示器**。
 *
 * 架构约束（AGENTS.md §5.1）：学段没有人工入口 —— 没有选择器、没有确认、没有纠偏。
 * 所以本组件是**状态显示**，不是控件：内部没有 button / select / radio，
 * 也**不调用任何 setGrade**（只有开发页在 devMode 下才允许改，见 views/dev/ThemeConsoleView.vue）。
 *
 * 这里之所以要显示，是因为学段是系统自动判定的：不给可见证据，
 * 「系统在适配我」这件事就完全看不出来。
 *
 * 三态：
 *   - 未判定        → 「待判定」（不拿冷启动默认值冒充判定结果）
 *   - 已判定        → 「当前：初中」
 *   - 设计系统档位  → 「设计系统：默认色调」（仅 /system 与 /dev 页面出现）
 */
import { computed } from 'vue'
import { useThemeStore } from '@/stores/theme'

const theme = useThemeStore()

const text = computed(() => theme.gradeIndicatorText)
</script>

<template>
  <span
    class="gi"
    data-testid="grade-indicator"
    :data-grade="theme.displayGrade"
    data-source="inferred"
  >
    <span class="gi__dot" :class="{ 'gi__dot--idle': !theme.isRealGrade }" />
    <span class="gi__text">{{ text }}</span>
    <span class="gi__sep" />
    <span class="gi__tone">{{ theme.satMeta.label }}</span>
  </span>
</template>

<style scoped>
.gi {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  font-size: var(--k12-fs-xs);
  font-weight: 550;
  color: var(--k12-fg-2);
  white-space: nowrap;
}
.gi__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--k12-good);
  flex: none;
}
.gi__dot--idle {
  background: var(--k12-muted-2);
}
.gi__text {
  color: var(--k12-fg);
  font-weight: 600;
}
.gi__sep {
  width: 1px;
  height: 10px;
  background: var(--k12-border-strong);
}
.gi__tone {
  color: var(--k12-muted);
}
</style>
