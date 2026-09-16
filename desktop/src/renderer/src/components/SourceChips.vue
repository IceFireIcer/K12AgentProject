<script setup lang="ts">
/**
 * `citation` 事件的呈现：教材来源（章节 + 学段）。
 *
 * `compat === true` 表示这条来源是**跨学段向上兼容**取用的（§6.4 要求显式标注），
 * 所以单独打一个「向上兼容」的标记，而不是混在其它来源里。
 */
import type { Citation } from '@shared/ipc-events'
import { GRADE_LABELS } from '../labels'

defineProps<{ citations: Citation[] }>()
</script>

<template>
  <ul class="sources" data-testid="citation-list">
    <li v-for="citation in citations" :key="citation.chunkId" class="chip" data-testid="citation-chip">
      <span class="chapter">{{ citation.chapterTitle }}</span>
      <span class="sep" aria-hidden="true">·</span>
      <span class="section">{{ citation.sectionTitle }}</span>
      <span class="grade">{{ GRADE_LABELS[citation.gradeLevel] }}</span>
      <span v-if="citation.compat" class="compat" data-testid="citation-compat">向上兼容</span>
    </li>
  </ul>
</template>

<style scoped>
.sources {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sources .chip {
  max-width: 100%;
  font-weight: 500;
  color: var(--text-muted);
}

.chapter {
  color: var(--text);
  font-weight: 600;
}

.sep {
  color: var(--text-faint);
}

.section {
  color: var(--text-muted);
}

.grade {
  padding-left: 8px;
  border-left: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11px;
}

.compat {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 11px;
}
</style>
