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

/* 来源胶囊：一条来源 = 一个 chip（章节 · 小节 · 学段）。 */
.sources .chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-xs);
  font-weight: 500;
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

.chapter {
  color: var(--k12-fg);
  font-weight: 600;
}

.sep {
  color: var(--k12-muted-2);
}

.section {
  color: var(--k12-muted);
}

.grade {
  padding-left: 8px;
  border-left: 1px solid var(--k12-border);
  color: var(--k12-muted-2);
}

.compat {
  padding: 0 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
  color: var(--k12-warn);
  /* k12-mark：「向上兼容」是 4 字角标（§6.4 要求显式标注跨学段取用），
   * 不是正文 —— 升到 12px 会与相邻的章节/小节同权，角标语义消失。 */
  font-size: var(--k12-fs-micro);
}
</style>
