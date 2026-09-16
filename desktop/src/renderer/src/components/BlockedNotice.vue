<script setup lang="ts">
/**
 * `blocked` 事件的呈现：内容被安全终审撤回。
 *
 * ★ 原则（执行文档 §5）：**撤回正文、换成安全提示**（正文已由 `api/events.ts` 的
 *   分发函数替换成 `safeText`）。撤回原因只作为开发者线索展示，不当作回答正文。
 * ★ 学生看到的是 `safeText`（已经在气泡正文里），这里是那句「为什么刚才变了」。
 */
import type { BlockedNotice } from '../api/events'

defineProps<{ notice: BlockedNotice }>()
</script>

<template>
  <div class="blocked" data-testid="blocked-notice">
    <div class="head">
      <span class="chip chip--warn" data-testid="blocked-badge">已撤回不安全内容</span>
      <span class="label">我们换了一个更合适的说法</span>
    </div>
    <p class="reason">{{ notice.reason }}</p>
  </div>
</template>

<style scoped>
.blocked {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--warn-soft);
  border: 1px solid rgba(154, 100, 0, 0.22);
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.label {
  font-size: 13px;
  color: var(--text-muted);
}

.reason {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-faint);
  word-break: break-word;
}
</style>
