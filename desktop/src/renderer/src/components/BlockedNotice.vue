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
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
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
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
}

.chip--warn {
  background: var(--k12-warn-soft);
  border-color: var(--k12-warn-border);
  color: var(--k12-warn);
}

.label {
  font-size: var(--k12-fs-sm);
  color: var(--k12-muted);
}

.reason {
  margin-top: 6px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted-2);
  word-break: break-word;
}
</style>
