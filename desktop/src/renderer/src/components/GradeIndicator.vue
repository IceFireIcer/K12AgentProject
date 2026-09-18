<script setup lang="ts">
/**
 * 当前学段的**显示 + 手动指定入口（一）**（另一个入口在设置页）。
 *
 * 为什么保留这个条：学段是**系统自动判定**的，学生没有做过任何操作；
 * 不给一点可见证据的话，「系统在适配我」这件事就完全看不出来。
 * 所以这里首先是**状态显示**（当前学段 / 它是怎么定下来的）。
 *
 * ★ 为什么还要有一个手动入口：自动推断有它的代价 —— 判错了（或还没判出来）
 *   学生只能干等。给一个显式指定，学生就能自己说了算；指定后 10 轮内系统不再自动改。
 * ★ 入口默认**收起来**：指示器平时只有一行字，点「自己指定学段」才展开四个选项。
 *   摊在顶栏上会让「系统自己在判」这件事看起来像「每次都让我填一遍」。
 * ★ 手动写路径**只有 store 里那一条** `chat.setGrade`（走 `grade:set` 独立通道）。
 *   这里不自己拼请求、也不改本地状态：界面显示的学段必须来自服务端回执 / 推送，
 *   否则会出现「指示器写着初中、回答却按小学讲」。
 *
 * 判定链路（主进程）：对话 → 规则引擎 + 轻量 LLM 判定 → `grade:changed` 推送
 * → `stores/chat.ts` 的 `currentGrade` → 这里显示。
 *
 * 显示分档：
 *   - 还没定下来（`currentGrade === null`）：`当前：待判定`，**不显示来源那一句**
 *     （还没定下来的东西没有「怎么定下来的」可言），也**不拿冷启动默认值冒充判定结果**；
 *   - 已定下来：`当前：初中` + `手动选中` / `AI 引擎推算`；
 *   - 变化时多一行一次性提示：系统判出来的是「我按初中的说法来讲。」，
 *     学生自己选的是「已按你选的初中的来讲。」（见 store 的 `gradeNotice`）。
 */
import { computed, ref } from 'vue'
import { GRADE_LEVELS } from '../api/grade'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL, gradeOriginLabel } from '../labels'
import { useChatStore } from '../stores/chat'
import type { GradeLevel } from '@shared/ipc-events'

const chat = useChatStore()

const label = computed(() => chat.currentGradeLabel ?? GRADE_UNKNOWN_LABEL)
const determined = computed(() => chat.currentGrade !== null)
/** 「学段是怎么定下来的」：只在真定下来之后显示（`null` 时整句不渲染）。 */
const originLabel = computed(() => gradeOriginLabel(chat.gradeOrigin))

const pickerOpen = ref(false)
/** 请求在飞：防连点（连点会重复写库，且第二次的回执会覆盖第一次的提示）。 */
const busy = ref(false)
const errorText = ref<string | null>(null)

function togglePicker(): void {
  pickerOpen.value = !pickerOpen.value
  // 重新展开时清掉上一次的失败文案（否则「选成功了」和「上次失败」会同时挂在界面上）
  if (pickerOpen.value) errorText.value = null
}

async function choose(level: GradeLevel): Promise<void> {
  if (busy.value) return
  busy.value = true
  errorText.value = null
  try {
    const result = await chat.setGrade(level)
    // 成功就收起选项（学生要看到的就是「选完了」）；失败留着选项，并说明原因
    if (result.ok) pickerOpen.value = false
    else errorText.value = result.message ?? '设定学段失败。'
  } finally {
    busy.value = false
  }
}
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
      <!-- 来源标签：学生手动选完之后，「它是不是我选的」必须能一眼看出来 -->
      <span v-if="determined" class="grade__origin" data-testid="grade-origin-label">{{ originLabel }}</span>
      <span class="grade__hint" data-testid="grade-indicator-hint">
        系统会根据你问的问题自动判断，你也可以自己指定。
      </span>
      <button
        type="button"
        class="grade__set"
        data-testid="grade-set"
        :disabled="chat.streaming"
        @click="togglePicker"
      >
        自己指定学段
      </button>
    </p>

    <!-- 选项默认收起：点上面的按钮才展开（四个学段，当前生效的那个标出来） -->
    <ul v-if="pickerOpen" class="grade__options" data-testid="grade-options">
      <li v-for="level in GRADE_LEVELS" :key="level">
        <button
          type="button"
          class="grade__option"
          :class="{ 'grade__option--active': chat.currentGrade === level }"
          :data-testid="`grade-option-${level}`"
          :data-active="String(chat.currentGrade === level)"
          :disabled="chat.streaming || busy"
          @click="choose(level)"
        >
          {{ GRADE_LABELS[level] }}
        </button>
      </li>
    </ul>

    <!-- 设定失败：说清原因，不白屏、不抛异常（学生要能再点一次） -->
    <p v-if="errorText" class="grade__warn" data-testid="grade-set-error">{{ errorText }}</p>

    <!-- 学段变化时的一次性提示：适配发生了（或学生自己选了）也要看得出来 -->
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

/* 来源标签：比徽章轻，比提示语重 —— 它回答的是「这是谁定的」 */
.grade__origin {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-strong);
}

.grade__hint {
  font-size: 12px;
  color: var(--text-faint);
}

.grade__set {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.grade__set:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.grade__set:disabled {
  cursor: not-allowed;
  color: var(--text-faint);
}

.grade__options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.grade__option {
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.grade__option:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.grade__option:disabled {
  cursor: not-allowed;
  color: var(--text-faint);
}

/* 当前生效的那一档：与 `.grade__badge` 同一视觉语言（选中 = 强调色） */
.grade__option--active {
  border-color: rgba(47, 111, 208, 0.45);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
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
