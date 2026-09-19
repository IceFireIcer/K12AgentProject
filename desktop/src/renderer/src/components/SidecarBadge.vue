<script setup lang="ts">
/**
 * 本地数据服务状态徽章。
 *
 * 数据来自主进程推送（`sidecar:changed` / `sidecar:get-info`），
 * 渲染进程既不直连 sidecar，也拿不到 token。
 * ★ `data-phase` 与文案是 `scripts/verify-ui.mjs` 的断言对象，改文案请同步脚本。
 */
import { PHASE_HINT, useSidecarStore } from '../stores/sidecar'

const sidecar = useSidecarStore()
</script>

<template>
  <div class="badge-wrap">
    <span
      class="chip"
      :class="`chip--${sidecar.phase}`"
      data-testid="sidecar-status"
      :data-phase="sidecar.phase"
    >
      <span class="dot" aria-hidden="true"></span>
      {{ sidecar.phaseText }}
    </span>
    <p v-if="sidecar.errorText" class="error" data-testid="sidecar-error">{{ sidecar.errorText }}</p>
    <p v-else class="hint">{{ PHASE_HINT[sidecar.phase] }}</p>
  </div>
</template>

<style scoped>
.badge-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  max-width: 420px;
}

/* 状态胶囊：全局不再提供 .chip（见 base.css 的材质层），本组件自带一份。 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
}

.chip--idle,
.chip--stopped {
  background: var(--k12-surface-2);
  border-color: var(--k12-border-strong);
  color: var(--k12-muted);
}

.chip--starting {
  background: var(--k12-warn-soft);
  border-color: var(--k12-warn-border);
  color: var(--k12-warn);
}

/* 启动中的呼吸点：表达「正在进行」（与 EmptyState 的加载环同一口径），
 * 不是装饰性动效，且 prefers-reduced-motion 下关闭。 */
.chip--starting .dot {
  animation: pulse 1.1s ease-in-out infinite;
}

.chip--ready {
  background: var(--k12-good-soft);
  border-color: var(--k12-good-border);
  color: var(--k12-good);
}

.chip--failed {
  background: var(--k12-bad-soft);
  border-color: var(--k12-bad-border);
  color: var(--k12-bad);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.hint {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
  text-align: right;
  line-height: var(--k12-lh-ui);
}

.error {
  font-size: var(--k12-fs-xs);
  color: var(--k12-bad);
  text-align: right;
  line-height: var(--k12-lh-ui);
  word-break: break-word;
}

@media (prefers-reduced-motion: reduce) {
  .chip--starting .dot {
    animation: none;
  }
}
</style>
