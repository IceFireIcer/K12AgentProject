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
 * ★★ 两个刻意的「没有」（改动前先读 —— 它们不是缺漏，是合规边界）
 * ---------------------------------------------------------------------------
 * 1. **没有「你的作答」**：数据里**根本不存在** —— 学生原话与模型回答不入 `SQLite`
 *    （合规红线），`learning_history.question` 只放**题干前 120 字**。
 *    所以这一页不能做成「你的答案 vs 标准答案」那种对照（竞品有，我们不做）。
 * 2. **没有「参考答案」、也拿不到「解析」**：错题端点**刻意不 join** 带
 *    `reference_answer` / `explanation` 的 `generated_question` 表 ——
 *    `QuizQuestionOut` 连 `explanation` 都刻意不下发（实测 295/684 道真题的解析
 *    里含答案原文，见 `server/app/contracts.py` 的说明），
 *    因为「答完再讲为什么」才是有教育意义的那一步，而「答前先看到为什么」只是送答案。
 *    ★ 解析仍然有：它随**判分回执**的 `feedback` 回到学生面前（对话内题卡）。
 *
 * 所以本页给出的「继续学」入口是**可执行动作**，不是解释文本：
 *   · `去练一练` —— 预填一句提问、切回对话页（模型据此出变式题）；
 *   · `再练这类题` —— 直接去闯关页做同类题（题库按知识点取，判分仍在 Python）。
 */

import { computed, onMounted } from 'vue'
import { useStudyStore } from '../stores/study'
import { useChatStore } from '../stores/chat'
import { useKnowledgeStore } from '../stores/knowledge'
import { useUiStore } from '../stores/ui'
import { useQuizStore } from '../stores/quiz'
import { formatMs } from '../study/report-markdown'
import { kpLabel, kpLabelResolved } from '../study/kp-label'
import EmptyState from '../components/EmptyState.vue'

defineOptions({ name: 'StudyMistakesTab' })

const study = useStudyStore()
const chat = useChatStore()
const knowledge = useKnowledgeStore()
const ui = useUiStore()
const quiz = useQuizStore()

const mistakes = computed(() => study.mistakes)

onMounted(() => {
  // ★ 名字的来源是教材知识点清单（错题端点给的 `kpName` 查不到时会退化成 id）。
  //   幂等：取到过就不发请求；失败不阻断本页（退化成中性标签，见 `nameOf`）。
  void knowledge.ensureNames().catch(() => {})
  // ★ 关卡阶段决定「再练这类题」该不该出现（锁着的关卡点下去只会得到一句拒绝）。
  //   同一个幂等动作，概览页也会调。
  void quiz.loadProgress()
})

/** 知识点显示名：中文名优先，取不到给中性标签，**绝不显示 slug**（见 `study/kp-label.ts`）。 */
function nameOf(item: { kpId: string; kpName?: string | null }): string {
  return kpLabel(item.kpId, item.kpName, (id) => knowledge.kpNameOf(id))
}

/** 名字是否真的取到了 —— 取不到时把原始 id 放进 `title`（排障/答辩可见，学生看不到 slug）。 */
function nameResolved(item: { kpId: string; kpName?: string | null }): boolean {
  return kpLabelResolved(item.kpId, item.kpName, (id) => knowledge.kpNameOf(id))
}

/**
 * 这个知识点**现在能不能直接做题库里的题**。
 *
 * ★ 判据来自闯关进度（服务端权威）：锁着的关卡点下去只会得到一句「还没解锁」，
 *   那还不如一开始就别给按钮 —— 按钮出现了却什么也不发生，学生会以为坏了。
 *   进度还没读回来时（`levels` 为空）也判「不行」，此时卡片上仍留着「去练一练」
 *   （那条路永远通），所以不会出现「一条路都没有」的卡片。
 */
function canRetry(item: { kpId: string }): boolean {
  const stage = quiz.levels.find((level) => level.kpId === item.kpId)?.stage ?? null
  return stage !== null && stage !== 'locked'
}

/**
 * 「去练一练」：**预填一句提问**并切回对话页。
 *
 * ★ 不直接发消息（见 `stores/chat.ts` 的 `prepareQuestion` 注释）：学生看得见自己要问什么，
 *   才有机会补一句「我想练简单的」；也让「主动替学生消耗一次云端调用」这件事不发生。
 * ★ 带上知识点名：模型据此决定用哪个知识点出题，而不是从「再练一遍」这四个字去猜。
 */
function goPractice(item: { kpId: string; kpName?: string | null }): void {
  const label = nameOf(item)
  chat.prepareQuestion(`我在「${label}」上错了几次，请再出几道题让我练一练。`)
  ui.show('chat')
}

/**
 * 「再练这类题」：**直接去闯关页做这个知识点的题**（不走对话、不消耗云端调用）。
 *
 * ★ 为什么两条路都要有：「去练一练」是模型带着讲的变式题（有讲解、要等模型），
 *   「再练这类题」是题库里的同知识点题（立刻开始、判分仍在 Python）。
 *   错题本的价值在于「错过的点还能再练一次」，两条路都不该缺。
 * ★ 落点用 `ui.go('quiz')` + `quiz.selectLevel(kpId)`：闯关页的关卡条选中态由
 *   `activeKpId` 决定，所以到了那儿标题与题目都是这个知识点（不是「首页」）。
 * ★ 锁着的关卡**不给这个按钮**（`canRetry`）：点下去只会得到一句「还没解锁」，
 *   不如一开始就别让它出现。
 * ★ 它刻意**不是**主色按钮（`.k12-cta`）：一屏上有 N 条错题就会变成 N 个主色按钮，
 *   而设计系统里「主色 = 这一屏做完这件事就算完成」**一屏只允许一个**
 *   （见 `assets/base.css` 的 `.k12-cta` 说明）。这里用强调描边的次级按钮。
 */
function retrySameKind(item: { kpId: string }): void {
  void quiz.selectLevel(item.kpId)
  ui.go('quiz')
}
</script>

<template>
  <section class="tab-body" data-testid="study-mistakes">
    <div class="toolbar">
      <p class="toolbar__hint">
        按知识点汇总。错题只记录「错过了什么题」，不记录你的作答内容。
      </p>
      <div class="toolbar__actions">
        <button
          class="btn k12-tap"
          type="button"
          data-testid="mistakes-refresh"
          :disabled="study.loading.mistakes"
          @click="study.loadMistakes(true)"
        >
          {{ study.loading.mistakes ? '整理中…' : '刷新' }}
        </button>
        <button
          class="btn k12-tap"
          type="button"
          data-testid="mistakes-export"
          :disabled="!mistakes || study.exporting"
          @click="study.exportMistakes()"
        >
          {{ study.exporting ? '导出中…' : '导出 Markdown' }}
        </button>
      </div>
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
      <!-- ★★ 「没有错题」是**做得好**，不是「没有数据」：用 success 调性的空态给一次
           正向反馈（mascot = 吉祥物智团团）。这里以前是一句平铺直叙的灰字，
           学生会读成「功能坏了 / 还没加载出来」。 -->
      <EmptyState
        v-if="mistakes.items.length === 0"
        data-testid="mistakes-empty"
        tone="success"
        mascot
        title="太棒啦！目前还没有错题，继续保持这份认真～"
        desc="每一道做过的题都答对了。想挑战更难的内容，就去对话里问一句「接下来学什么」吧。"
      />

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
              <!-- 显示名取不到时给中性标签（`未命名知识点`），原始 id 只进 title：
                   一个 slug 摆在 10 岁学生面前看起来就像报错 -->
              <span class="item__name" :title="nameResolved(item) ? undefined : item.kpId">
                {{ nameOf(item) }}
              </span>
              <span v-if="item.chapterTitle" class="item__chapter">{{ item.chapterTitle }}</span>
              <span class="item__count">错 {{ item.wrongCount }} 次</span>
            </div>

            <p v-if="item.stem" class="item__stem">{{ item.stem }}</p>
            <p v-else class="item__stem item__stem--none">
              这次答错没有留下题目（发生在问答或编程练习里），可以回到对话里再练一遍。
            </p>

            <div class="item__foot">
              <span class="item__meta">最近一次：{{ formatMs(item.lastWrongAt) }}</span>
              <div class="item__actions">
                <!-- per-card 的次要动作（两条都点得动，语义不同：一条是模型带讲，
                     一条是题库立刻开始）。刻意都不做主色按钮，理由见 `retrySameKind`。 -->
                <button
                  class="btn k12-tap"
                  type="button"
                  :data-testid="`mistakes-practice-${item.kpId}`"
                  @click="goPractice(item)"
                >
                  去练一练
                </button>
                <button
                  v-if="canRetry(item)"
                  class="btn btn--strong k12-tap"
                  type="button"
                  :data-testid="`mistakes-retry-${item.kpId}`"
                  @click="retrySameKind(item)"
                >
                  再练这类题
                </button>
              </div>
            </div>
          </li>
        </ul>

        <p v-if="mistakes.withoutStem > 0" class="footnote" data-testid="mistakes-without-stem">
          另有 {{ mistakes.withoutStem }} 次答错发生在问答或编程练习里（没有题目记录），
          已经算进上面的错次统计。
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

.toolbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
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

/* 页面级操作按钮（刷新 / 导出）：控件层统一 --k12-r-control。
 * ⚠️ 全局 .btn 已随旧 base.css 移除，本页自带一份（触控下限由 .k12-tap 补上）。 */
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

/* 「再练这类题」比旁边那条更值得先按（它是立刻开始的那条），所以给它强调描边；
 * 但**不是**主色填充 —— 一屏 N 条错题就会有 N 个主色按钮，那是设计系统明令禁止的。 */
.btn--strong {
  border-color: var(--k12-accent-border);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
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

/* 页脚一行：左边是「最近一次」，右边是动作 —— 窄窗口下自动折行 */
.item__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.item__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.item__meta {
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
