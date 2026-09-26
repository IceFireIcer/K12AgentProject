<script setup lang="ts">
/**
 * 「看看这一步背后发生了什么」——把只读机制浮窗从**卡片上**打开的那颗小按钮。
 *
 * ★ 为什么收口成一个组件，而不是在编程 / 动画 / 练习三张卡片里各写一遍：
 *   ① 三处各写一遍就会出现三种「打开方式」（有的带锚点、有的不带、有的忘了 gate）；
 *   ② 它**必须在 `<TeacherGate>` 里**（学生视角下不在 DOM 里）—— 收口之后这一条无处可漏。
 *   ③ 文案与图标只有一份：三张卡片上「打开同一只浮窗」的按钮长得不一样，是最廉价的破绽。
 *
 * ⚠️ 只读：这颗按钮打开的那只窗**一个可写控件都没有**（见 `DiagnosticsPanel.vue`）。
 */
import { Activity } from 'lucide-vue-next'
import TeacherGate from '../TeacherGate.vue'
import { useDiagnosticsPanel } from '../../stores/diagnosticsPanel'

const panel = useDiagnosticsPanel()

function open(event: MouseEvent): void {
  // 锚点取自触发按钮：浮窗从这颗按钮长出来、关掉时沿同路径收回
  panel.openFrom(event.currentTarget as Element | null)
}
</script>

<template>
  <TeacherGate>
    <button
      type="button"
      class="peek"
      title="看看这一步背后发生了什么"
      data-testid="diag-peek"
      @click="open"
    >
      <Activity :size="12" />
      <span>机制</span>
    </button>
  </TeacherGate>
</template>

<style scoped>
/* 与卡片头其它 chip 同一配方（浅底 + 胶囊形 + micro 字号），但它是**可点的** —— 
 * 所以加边框与 hover，让「这颗能按」一眼看得出来。 */
.peek {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 2px 9px;
  min-height: 24px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-label);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .peek:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}
</style>
