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
  border-radius: var(--radius);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex-wrap: wrap;
}

.notice--warn {
  background: var(--warn-soft);
  border: 1px solid rgba(154, 100, 0, 0.22);
}

.notice--danger {
  background: var(--danger-soft);
  border: 1px solid rgba(179, 38, 30, 0.22);
}

.text {
  flex: 1 1 240px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-muted);
  word-break: break-word;
}
</style>
