<script setup lang="ts">
/**
 * ★ 当前学段的**只读指示器**（替代已删除的学段选择器）。
 *
 * 为什么保留这个条：学段是**系统自动判定**的，学生没有做过任何操作；
 * 不给一点可见证据的话，「系统在适配我」这件事就完全看不出来。
 * 所以这里是**状态显示**，不是控件 —— 组件里没有 button / select / radio，
 * 也没有任何 `setGrade*` 调用（store 里根本不存在写入口）。
 *
 * 判定链路（全部在主进程）：对话 → 规则引擎 + 轻量 LLM 判定 → `grade:changed` 推送
 * → `stores/chat.ts` 的 `currentGrade` → 这里显示。
 *
 * 三档显示：
 *   - 还没判出来（`currentGrade === null`）：「待判定」——**不拿冷启动默认值冒充判定结果**；
 *   - 判出来了：`当前：初中`（旁边那句话解释它是自动的）；
 *   - 判定结果变化：多一行「我按初中的说法来讲。」（一次性提示，见 store 的 `gradeNotice`）。
 */
import { computed } from 'vue'
import { GRADE_UNKNOWN_LABEL } from '../labels'
import { useChatStore } from '../stores/chat'

const chat = useChatStore()

const label = computed(() => chat.currentGradeLabel ?? GRADE_UNKNOWN_LABEL)
const determined = computed(() => chat.currentGrade !== null)
</script>

<template>
  <div
    class="grade"
    data-testid="grade-indicator"
    :data-grade="chat.currentGrade ?? ''"
    :data-origin="chat.gradeOrigin ?? 'unknown'"
    :data-determined="String(determined)"
  >
    <p class="grade__line">
      <span class="grade__badge">
        当前：<strong data-testid="grade-current-label">{{ label }}</strong>
      </span>
      <span class="grade__hint" data-testid="grade-indicator-hint">
        系统会根据你问的问题自动判断，你不用自己选。
      </span>
    </p>

    <!-- 判定结果变化时的一次性提示：适配发生了也要看得出来 -->
    <p v-if="chat.gradeNotice" class="grade__notice" data-testid="grade-notice">{{ chat.gradeNotice }}</p>

    <!-- 判定通道缺失（主进程尚未接线）：说清原因，不让指示器永远沉默地停在「待判定」 -->
    <p v-if="chat.gradeBridgeError" class="grade__warn" data-testid="grade-indicator-note">
      {{ chat.gradeBridgeError }}
    </p>
  </div>
</template>

<style scoped>
.grade {
  padding: 8px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.grade__line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.grade__badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  border: 1px solid rgba(47, 111, 208, 0.24);
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 600;
}

.grade__hint {
  font-size: 12px;
  color: var(--text-faint);
}

.grade__notice {
  margin-top: 5px;
  font-size: 12px;
  color: var(--ok);
}

.grade__warn {
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--warn);
}
</style>
