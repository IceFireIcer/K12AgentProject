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

.chip--idle,
.chip--stopped {
  background: var(--surface-muted);
  border-color: var(--border-strong);
  color: var(--text-muted);
}

.chip--starting {
  background: var(--warn-soft);
  border-color: rgba(154, 100, 0, 0.24);
  color: var(--warn);
}

.chip--starting .dot {
  animation: pulse 1.1s ease-in-out infinite;
}

.chip--ready {
  background: var(--ok-soft);
  border-color: rgba(26, 127, 75, 0.24);
  color: var(--ok);
}

.chip--failed {
  background: var(--danger-soft);
  border-color: rgba(179, 38, 30, 0.24);
  color: var(--danger);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
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
  font-size: 12px;
  color: var(--text-faint);
  text-align: right;
  line-height: 1.5;
}

.error {
  font-size: 12px;
  color: var(--danger);
  text-align: right;
  line-height: 1.5;
  word-break: break-word;
}
</style>
