<script setup lang="ts">
/**
 * 一轮对话的呈现：一条学生消息 + 它对应的助手回答（同一个 `requestId`）。
 *
 * 6 事件在这里各自找到位置：
 *   `delta`   → 正文实时增长（`assistant-text`）
 *   `citation`→ 来源小标签（SourceChips）
 *   `payload` → 内联卡片（InlineCard：练习卡片已落地，动画/编程为占位）
 *   `blocked` → 正文已被替换成安全提示 + 撤回说明（BlockedNotice）
 *   `done`    → 状态徽章变成「回答完成」
 *   `error`   → 可读的降级提示（DegradedNotice）
 *
 * ★ 每条回答都标出**这一轮用的学段**（`turn.gradeLevel`）：这个值来自系统对学段的
 *   自动判定（学生不选学段），标出来是为了让「同一道题换个年级问，回答不一样」看得见。
 *   还没判出学段时该徽章不显示（宁可不标，也不标一个假的）。
 */
import { computed } from 'vue'
import type { ChatTurn } from '../api/events'
import { GRADE_LABELS, TURN_STATUS_LABELS } from '../labels'
import InlineCard from '../cards/InlineCard.vue'
import BlockedNotice from './BlockedNotice.vue'
import DegradedNotice from './DegradedNotice.vue'
import SourceChips from './SourceChips.vue'

const props = defineProps<{ turn: ChatTurn }>()

const streaming = computed(() => props.turn.status === 'streaming')
const statusLabel = computed(() => TURN_STATUS_LABELS[props.turn.status])
const gradeLabel = computed(() => (props.turn.gradeLevel ? GRADE_LABELS[props.turn.gradeLevel] : null))
</script>

<template>
  <article class="turn" :data-status="turn.status" data-testid="chat-turn">
    <div class="bubble bubble--user" data-testid="user-message">
      <p class="bubble__text">{{ turn.userText }}</p>
    </div>

    <div class="bubble bubble--assistant" data-testid="assistant-message">
      <div class="meta">
        <span class="who">AI 老师</span>
        <span
          v-if="gradeLabel"
          class="chip chip--accent"
          data-testid="turn-grade"
          :data-grade="turn.gradeLevel"
        >
          {{ gradeLabel }}
        </span>
        <span class="chip" :class="streaming ? 'chip--accent' : 'chip--ok'" data-testid="turn-status">
          {{ statusLabel }}
        </span>
        <span v-if="turn.messageId" class="chip">消息 {{ turn.messageId }}</span>
      </div>

      <!-- 正文：delta 逐字累积；为空时也保留节点，便于实时观察「开始回答」 -->
      <p class="bubble__text" data-testid="assistant-text">{{ turn.text }}<span v-if="streaming" class="caret" aria-hidden="true"></span></p>

      <SourceChips v-if="turn.citations.length > 0" :citations="turn.citations" />

      <div v-if="turn.cards.length > 0" class="cards" data-testid="inline-cards">
        <InlineCard v-for="card in turn.cards" :key="card.id" :card="card" />
      </div>

      <BlockedNotice v-if="turn.blocked" :notice="turn.blocked" />
      <DegradedNotice v-if="turn.error" :notice="turn.error" />
    </div>
  </article>
</template>

<style scoped>
.turn {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 0;
  border-bottom: 1px solid var(--border);
}

.turn:last-child {
  border-bottom: none;
}

.bubble {
  border-radius: var(--radius-lg);
  padding: 14px 18px;
  max-width: 100%;
}

.bubble--user {
  align-self: flex-end;
  max-width: min(560px, 82%);
  background: var(--accent);
  color: #ffffff;
  border-bottom-right-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
}

.bubble--assistant {
  align-self: flex-start;
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom-left-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
}

.bubble__text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 15px;
  line-height: 1.85;
}

.bubble--user .bubble__text {
  white-space: pre-wrap;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.who {
  font-size: 13px;
  font-weight: 650;
  color: var(--text-muted);
}

.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--accent);
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

.cards {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}
</style>
