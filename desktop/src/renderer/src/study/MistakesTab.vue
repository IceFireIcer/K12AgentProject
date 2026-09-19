<script setup lang="ts">
/**
 * 学习档案 · **错题本**。
 *
 * 数据来自 `GET /api/quiz/mistakes/{id}`（`learning_history` 里 `is_correct = 0` 的记录
 * 按知识点聚合）。这一页是「**Prompt 要求 vs 数据能力**之间那道断层」的补口：
 * `senior.ts` 早就要求「错题要给变式题巩固」，但模型手里一直没有错题数据
 * （每轮注入的错题摘要在 `student-context.ts`，与本页同源）。
 *
 * ---------------------------------------------------------------------------
 * ★★ 两个刻意的「没有」
 * ---------------------------------------------------------------------------
 * 1. **没有「你的作答」**：数据里**根本不存在** —— 学生原话与模型回答不入 `SQLite`
 *    （合规红线），`learning_history.question` 只放**题干前 120 字**。
 *    所以这一页不能做成「你的答案 vs 标准答案」那种对照（竞品有，我们不做，
 *    不是漏了，是数据边界如此）。
 * 2. **没有「参考答案」**：错题端点**刻意不 join** 带 `reference_answer` 的
 *    `generated_question` 表（那是答案泄漏）。学生要的是「再练一遍」，不是看答案。
 */
import { computed } from 'vue'
import { useStudyStore } from '../stores/study'
import { useChatStore } from '../stores/chat'
import { useUiStore } from '../stores/ui'
import { formatMs } from '../study/report-markdown'

defineOptions({ name: 'StudyMistakesTab' })

const study = useStudyStore()
const chat = useChatStore()
const ui = useUiStore()

const mistakes = computed(() => study.mistakes)

/**
 * 「去练一练」：**预填一句提问**并切回对话页。
 *
 * ★ 不直接发消息（见 `stores/chat.ts` 的 `prepareQuestion` 注释）：学生看得见自己要问什么，
 *   才有机会补一句「我想练简单的」；也让「主动替学生消耗一次云端调用」这件事不发生。
 * ★ 带上知识点名：模型据此决定用哪个知识点出题，而不是从「再练一遍」这四个字去猜。
 */
function goPractice(kpId: string, kpName: string): void {
  const label = kpName && kpName !== kpId ? kpName : kpId
  chat.prepareQuestion(`我在「${label}」上错了几次，请再出几道题让我练一练。`)
  ui.show('chat')
}
</script>

<template>
  <section class="tab-body" data-testid="study-mistakes">
    <div class="toolbar">
      <p class="toolbar__hint">
        按知识点汇总。错题只记录「错过了什么题」，不记录你的作答内容。
      </p>
      <button
        class="btn"
        type="button"
        data-testid="mistakes-export"
        :disabled="!mistakes || study.exporting"
        @click="study.exportMistakes()"
      >
        {{ study.exporting ? '导出中…' : '导出 Markdown' }}
      </button>
    </div>

    <p v-if="study.exportNotice" class="notice" data-testid="mistakes-export-notice">
      {{ study.exportNotice }}
    </p>

    <p v-if="study.loading.mistakes" class="state" data-testid="mistakes-loading">
      正在汇总错题…
    </p>
    <p v-else-if="study.errors.mistakes" class="state state--error" data-testid="mistakes-error">
      {{ study.errors.mistakes }}
    </p>

    <template v-else-if="mistakes">
      <p v-if="mistakes.items.length === 0" class="state" data-testid="mistakes-empty">
        还没有错题记录 —— 保持住。
      </p>

      <template v-else>
        <p class="summary">
          共 <strong>{{ mistakes.items.length }}</strong> 个知识点有错题，累计答错
          <strong>{{ mistakes.totalWrong }}</strong> 次。
        </p>

        <ul class="list" data-testid="mistakes-list">
          <li
            v-for="item in mistakes.items"
            :key="item.kpId"
            class="item"
            :data-kp-id="item.kpId"
          >
            <div class="item__head">
              <span class="item__name">
                {{ item.kpName && item.kpName !== item.kpId ? item.kpName : item.kpId }}
              </span>
              <span v-if="item.chapterTitle" class="item__chapter">{{ item.chapterTitle }}</span>
              <span class="item__count">错 {{ item.wrongCount }} 次</span>
              <button
                class="btn btn--mini"
                type="button"
                :data-testid="`mistakes-practice-${item.kpId}`"
                @click="goPractice(item.kpId, item.kpName)"
              >
                去练一练
              </button>
            </div>
            <p v-if="item.stem" class="item__stem">{{ item.stem }}</p>
            <p v-else class="item__stem item__stem--none">
              这次答错没有对应的题目记录（发生在问答或编程练习里）。
            </p>
            <p class="item__meta">最近一次：{{ formatMs(item.lastWrongAt) }}</p>
          </li>
        </ul>

        <p v-if="mistakes.withoutStem > 0" class="footnote" data-testid="mistakes-without-stem">
          另有 {{ mistakes.withoutStem }} 次答错没有题目记录（问答 / 编程练习），已计入上面的错次统计。
        </p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.tab-body {
  padding: 16px 24px 32px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.toolbar__hint {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.summary {
  margin-bottom: 10px;
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* E2 卡片：白面 + 可见边框 + 浅投影 */
.item {
  padding: 10px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.item__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.item__name {
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  color: var(--k12-fg);
}

.item__chapter {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.item__count {
  padding: 1px 8px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
  color: var(--k12-warn);
  /* 错次角标（「错 3 次」）：选择器名含 count，走角标档 */
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}

/* 页面级操作按钮（导出）：控件层统一 --k12-r-control。
 * ⚠️ 全局 .btn 已随旧 base.css 移除，本页自带一份。 */
.btn {
  padding: 5px 12px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover:not(:disabled) {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

.btn--mini {
  margin-left: auto;
  padding: 3px 10px;
}

/* 题干引用：左侧一条竖线（引用行用极小圆角） */
.item__stem {
  margin-top: 6px;
  padding-left: 8px;
  border-left: 2px solid var(--k12-border-strong);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

.item__stem--none {
  color: var(--k12-muted-2);
  font-style: italic;
}

.item__meta {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.footnote {
  margin-top: 12px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
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

.notice {
  margin-bottom: 10px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-good);
}
</style>
