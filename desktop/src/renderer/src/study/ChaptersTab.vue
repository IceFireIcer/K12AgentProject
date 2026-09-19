<script setup lang="ts">
/**
 * 学习档案 · **章节进度**。
 *
 * 把 `progress` 按 `chapter_title` 聚合成「第 4 章：3/5 已掌握」。
 *
 * ★ 章节**清单**来自 `kb.sqlite`（随包只读的教材资产），**进度**来自该学生自己的
 *   `learning.db` —— 两者在服务端并到一起（`routes/knowledge.py`）。
 *   渲染进程只是显示，既不拼目录也不数关卡。
 * ★ 清单顺序是**教材顺序**（服务端按章号排，不是字典序、也不是入库顺序 ——
 *   那两个都会把「第 10 章」或「第 6 章」排错位置）。
 */
import { computed } from 'vue'
import { useStudyStore } from '../stores/study'
import { GRADE_LABELS } from '../labels'

defineOptions({ name: 'StudyChaptersTab' })

const study = useStudyStore()

const chapters = computed(() => study.chapters)
const gradeLabel = computed(() => {
  const level = chapters.value?.gradeLevel
  return level ? (GRADE_LABELS[level] ?? level) : '待判定'
})

/** 一章的完成度（0..1）。**只用于显示进度条**，不参与任何判定。 */
function ratio(mastered: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, mastered / total))
}
</script>

<template>
  <section class="tab-body" data-testid="study-chapters">
    <p v-if="study.loading.chapters" class="state" data-testid="chapters-loading">
      正在读取教材章节…
    </p>
    <p v-else-if="study.errors.chapters" class="state state--error" data-testid="chapters-error">
      {{ study.errors.chapters }}
    </p>

    <template v-else-if="chapters">
      <p class="summary" data-testid="chapters-grade">
        {{ gradeLabel }}教材 · 共 {{ chapters.chapters.length }} 章
        <span v-if="!chapters.withProgress" class="summary__note">（未带学习进度）</span>
      </p>

      <p v-if="chapters.chapters.length === 0" class="state" data-testid="chapters-empty">
        这个学段还没有编入教材章节。
      </p>

      <ul v-else class="list" data-testid="chapters-list">
        <li
          v-for="chapter in chapters.chapters"
          :key="chapter.chapterTitle"
          class="chapter"
          :data-chapter-title="chapter.chapterTitle"
        >
          <div class="chapter__head">
            <span class="chapter__title">{{ chapter.chapterTitle }}</span>
            <span class="chapter__count">
              {{ chapter.masteredCount }}/{{ chapter.kpCount }} 已掌握
            </span>
          </div>
          <div class="bar">
            <span
              class="bar__fill"
              :style="{ width: `${Math.round(ratio(chapter.masteredCount, chapter.kpCount) * 100)}%` }"
            ></span>
          </div>
          <p class="chapter__kps">
            <span v-for="kpId in chapter.kpIds" :key="kpId" class="kp">{{ kpId }}</span>
          </p>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.tab-body {
  padding: 16px 24px 32px;
}

.summary {
  margin-bottom: 12px;
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
}

.summary__note {
  color: var(--k12-muted-2);
  font-size: var(--k12-fs-xs);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* E2 卡片：白面 + 可见边框 + 浅投影 */
.chapter {
  padding: 10px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.chapter__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.chapter__title {
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  color: var(--k12-fg);
}

.chapter__count {
  font-size: var(--k12-fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--k12-accent-ink);
  font-weight: 600;
}

.bar {
  margin-top: 7px;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-border);
  overflow: hidden;
}

.bar__fill {
  display: block;
  height: 100%;
  background: var(--k12-accent);
}

.chapter__kps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

/* 知识点 chip：极小元素 → 圆角 flat 档 */
.kp {
  padding: 1px 7px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.state {
  padding: 10px 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.state--error {
  color: var(--k12-warn);
  line-height: var(--k12-lh-body);
}
</style>
