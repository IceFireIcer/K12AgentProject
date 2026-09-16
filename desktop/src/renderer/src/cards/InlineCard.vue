<script setup lang="ts">
/**
 * `payload` 事件的内联卡片**分派器**：按 `kind` 选卡片组件。
 *
 *   `quiz`                → `cards/QuizCard.vue`（票 14：已落地，做题 + 批改结果）
 *   `animation` / `coding` → 占位卡片（票 16–19 落地）
 *
 * 载荷是契约里的 `unknown`，所以占位分支只读**明确认识的字段**（`note` / `tool`），
 * 读不到就退回到「按 kind 给一句通用说明」—— 结构变化最多让卡片变朴素，不会让页面报错。
 */
import { computed } from 'vue'
import type { InlineCard } from '../api/events'
import { PAYLOAD_KIND_HINTS, PAYLOAD_KIND_LABELS } from '../labels'
import QuizCard from './QuizCard.vue'

const props = defineProps<{ card: InlineCard }>()

const isQuiz = computed(() => props.card.kind === 'quiz')
const title = computed(() => PAYLOAD_KIND_LABELS[props.card.kind])

const note = computed(() => readNote(props.card.payload) ?? PAYLOAD_KIND_HINTS[props.card.kind])

function readNote(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const note = (payload as { note?: unknown }).note
  return typeof note === 'string' && note.trim().length > 0 ? note.trim() : null
}
</script>

<template>
  <!-- 练习卡片：题目 / 批改结果都由它自己按载荷结构判断 -->
  <QuizCard v-if="isQuiz" :card="card" />

  <!-- 动画与编程卡片（票 16–19） -->
  <article v-else class="card" :data-kind="card.kind" data-testid="inline-card">
    <header class="card__head">
      <span class="title">{{ title }}</span>
      <span class="chip chip--accent" data-testid="inline-card-placeholder">占位卡片</span>
      <span v-if="card.tool" class="chip tool">{{ card.tool }}</span>
    </header>
    <p class="card__note">{{ note }}</p>
    <footer class="card__foot">
      <button class="btn" type="button" disabled>展开（后续票实现）</button>
    </footer>
  </article>
</template>

<style scoped>
.card {
  margin-top: 10px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--surface-muted);
  border: 1px dashed var(--border-strong);
}

.card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.title {
  font-size: 14px;
  font-weight: 650;
}

.tool {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
}

.card__note {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-muted);
}

.card__foot {
  margin-top: 12px;
}
</style>
