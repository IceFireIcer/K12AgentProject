<script setup lang="ts">
/**
 * `error` 事件的呈现：**可读的降级提示**，不是堆栈。
 *
 * `degraded === true` 表示「能力受限但仍可用」（检索降级到 FTS5/大纲、云端模型不可用等），
 * 文案由主进程给（已折叠空白、截断），这里只负责说清楚「发生了什么 + 还能做什么」。
 */
import type { ErrorNotice } from '../api/events'

defineProps<{ notice: ErrorNotice }>()
</script>

<template>
  <div class="notice" :class="notice.degraded ? 'notice--warn' : 'notice--danger'" data-testid="error-notice">
    <span class="chip" :class="notice.degraded ? 'chip--warn' : 'chip--danger'" data-testid="error-badge">
      {{ notice.degraded ? '能力受限' : '出错了' }}
    </span>
    <p class="text" data-testid="error-text">{{ notice.message }}</p>
  </div>
</template>

<style scoped>
.notice {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--k12-r-inset);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex-wrap: wrap;
}

.notice--warn {
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
}

.notice--danger {
  background: var(--k12-bad-soft);
  border: 1px solid var(--k12-bad-border);
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

.chip--danger {
  background: var(--k12-bad-soft);
  border-color: var(--k12-bad-border);
  color: var(--k12-bad);
}

.text {
  flex: 1 1 240px;
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
  word-break: break-word;
}
</style>
