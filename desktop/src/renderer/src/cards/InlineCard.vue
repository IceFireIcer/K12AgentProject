<script setup lang="ts">
/**
 * `payload` 事件的内联卡片**占位**（真实卡片：动画 16/17、编程 18/19、练习 14/15）。
 *
 * 载荷是契约里的 `unknown`，所以这里只读**明确认识的字段**（`placeholder` / `tool` / `note`），
 * 读不到就退回到「按 kind 给一句通用说明」——结构变化最多让卡片变朴素，不会让页面报错。
 */
import { computed } from 'vue'
import type { InlineCard } from '../api/events'
import { PAYLOAD_KIND_HINTS, PAYLOAD_KIND_LABELS } from '../labels'

const props = defineProps<{ card: InlineCard }>()

const title = computed(() => PAYLOAD_KIND_LABELS[props.card.kind])

const note = computed(() => readNote(props.card.payload) ?? PAYLOAD_KIND_HINTS[props.card.kind])

function readNote(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const note = (payload as { note?: unknown }).note
  return typeof note === 'string' && note.trim().length > 0 ? note.trim() : null
}
</script>

<template>
  <article class="card" :data-kind="card.kind" data-testid="inline-card">
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
