<script setup lang="ts">
/**
 * 练习卡片（票 14）：三类题型作答 → 提交 → 展示逐题反馈与掌握度变化。
 *
 * 数据流（一条闭环，前端只负责「问」与「显示」）：
 *
 *   题目卡片  ←  `payload` 事件（`generate_quiz` / `generate_variants` 的 details）
 *   学生作答  →  `chat.submitQuizAnswer()` → 主 Agent → `submit_quiz` Tool → Python 判分
 *   批改结果  ←  `payload` 事件（`submit_quiz` 的 details，按 `qid` 找到对应题目）
 *
 * ★★ 三条红线（改这个文件前先读）：
 *
 * 1. **前端没有答案，也不判分**：题目载荷里结构上没有 `answer`（§6.3），
 *    卡片也**不渲染 `explanation`**（解析里往往直接写着答案）。判分只认后端返回的
 *    `QuizResult`；这里连一个「对/错」的本地推断都不许有（`cards/quiz.ts` 的投影已经把
 *    用不到的字段全丢了）。
 * 2. **不加字段、不猜字段**：看到认不出的载荷就退化成一句说明（`kind: 'unknown'`），
 *    绝不去 payload 里翻 `answer` 之类的「兜底」。
 * 3. **失败也要可读**：提交只是一个动作（走对话），失败由 6 事件里的 `error` 呈现，
 *    本组件不额外造一套错误形态。
 */
import { computed, reactive, ref } from 'vue'
import { QUIZ_TYPE_LABELS, SCORED_BY_LABELS, formatMasteryDelta } from '../labels'
import { useChatStore } from '../stores/chat'
import type { InlineCard } from '../api/events'
import ProgressCard from './ProgressCard.vue'
import { isBlankAnswer, optionLetter, readQuizCard, type QuizQuestionView } from './quiz'

const props = defineProps<{ card: InlineCard }>()
const chat = useChatStore()

const view = computed(() => readQuizCard(props.card.payload))

/** 学生已填的作答（三类题型共用一张表，键是 qid）。 */
const answers = reactive<Record<string, string>>({})
/** 选择题用「选项序号」驱动单选（作答本体仍是选项文本，与后端判分口径一致）。 */
const picked = reactive<Record<string, number>>({})
/** 本地提示（空作答之类），不是 `error` 事件。 */
const localHint = ref<string | null>(null)

/** 题目列表（认不出的载荷时为 0 条，走「未知卡片」分支）。 */
const questions = computed<QuizQuestionView[]>(() =>
  view.value.kind === 'questions' ? view.value.questions : []
)

/**
 * 每道题 + 它当前对应的批改结果。
 *
 * 结果按 `qid` 从**整段对话**里找（见 `chat.quizResults`）：题目卡片在某一轮出现，
 * 批改结果通常**下一轮**才回来 —— 只在本轮里找的话，题目永远等不到反馈。
 */
const items = computed(() =>
  questions.value.map((question) => ({ question, result: chat.quizResults.get(question.qid) ?? null }))
)

const sourceLabel = computed(() => {
  if (view.value.kind !== 'questions') return ''
  if (view.value.source === 'bank') return '本地题库'
  if (view.value.source === 'generated') return '模型生成'
  return ''
})

/** 本轮回复还没结束：提交按钮先禁用（主进程也有并发守卫）。 */
const submitting = computed(() => chat.streaming)

/**
 * 载荷里是否带了闯关进度（票 15）。
 *
 * ★ 只判断「有没有 `levels` 数组」，**不在前端推导任何关卡状态** ——
 *   状态机在后端（`routes/quiz.py` 的 `apply_level_progress`），前端只读。
 */
const hasProgress = computed(() => {
  const payload = props.card.payload
  if (typeof payload !== 'object' || payload === null) return false
  return Array.isArray((payload as { levels?: unknown }).levels)
})

function pick(qid: string, index: number, option: string): void {
  picked[qid] = index
  answers[qid] = option
  localHint.value = null
}

function onInput(qid: string, event: Event): void {
  const target = event.target as HTMLInputElement | null
  answers[qid] = target ? target.value : ''
  localHint.value = null
}

function submit(question: QuizQuestionView): void {
  const answer = (answers[question.qid] ?? '').trim()
  if (isBlankAnswer(answer)) {
    localHint.value = '先写下你的答案，再点提交。'
    return
  }
  if (submitting.value) return
  localHint.value = null
  // ★ 不判分、不比对答案：只把作答交给主 Agent（`submit_quiz` 是模型的工具）
  chat.submitQuizAnswer({ qid: question.qid, stem: question.stem }, answer)
}
</script>

<template>
  <!-- 出题：题目列表 -->
  <article
    v-if="view.kind === 'questions'"
    class="quiz"
    data-testid="quiz-card"
    data-quiz="questions"
    :data-kp-id="view.kpId"
  >
    <header class="quiz__head">
      <span class="title">随堂练习</span>
      <span class="chip chip--accent" data-testid="quiz-count">{{ questions.length }} 道题</span>
      <span v-if="sourceLabel" class="chip" data-testid="quiz-source">{{ sourceLabel }}</span>
      <span v-if="view.kpId" class="chip tool">{{ view.kpId }}</span>
    </header>

    <ol class="quiz__list">
      <li
        v-for="(item, index) in items"
        :key="item.question.qid"
        class="item"
        data-testid="quiz-question"
        :data-qid="item.question.qid"
        :data-type="item.question.type"
      >
        <div class="item__head">
          <span class="item__no">第 {{ index + 1 }} 题</span>
          <span class="chip" data-testid="quiz-type">{{ QUIZ_TYPE_LABELS[item.question.type] }}</span>
          <span v-if="item.result" class="chip chip--ok" data-testid="quiz-done">已批改</span>
        </div>
        <p class="item__stem" data-testid="quiz-stem">{{ item.question.stem }}</p>

        <!-- 选择题：点选项即选中（提交的是选项文本；字母与原文后端都认） -->
        <div v-if="item.question.type === 'choice'" class="options">
          <label
            v-for="(option, optionIndex) in item.question.options"
            :key="`${item.question.qid}-${optionIndex}`"
            class="option"
            :class="{ 'is-picked': picked[item.question.qid] === optionIndex }"
            data-testid="quiz-option"
          >
            <input
              type="radio"
              :name="`quiz-${item.question.qid}`"
              :value="option"
              :checked="picked[item.question.qid] === optionIndex"
              @change="pick(item.question.qid, optionIndex, option)"
            />
            <span class="option__letter">{{ optionLetter(optionIndex) }}</span>
            <span class="option__text">{{ option }}</span>
          </label>
        </div>

        <!-- 填空：单空文本作答 -->
        <input
          v-else-if="item.question.type === 'blank'"
          class="ans"
          type="text"
          :value="answers[item.question.qid] ?? ''"
          placeholder="把你想到的答案写在这里"
          data-testid="quiz-blank"
          @input="onInput(item.question.qid, $event)"
        />

        <!-- 代码填空：等宽输入（答案通常是一个运算符或表达式） -->
        <input
          v-else
          class="ans ans--code"
          type="text"
          :value="answers[item.question.qid] ?? ''"
          placeholder="填进空里的代码，例如 + 或 +="
          spellcheck="false"
          data-testid="quiz-code-blank"
          @input="onInput(item.question.qid, $event)"
        />

        <!-- 逐题反馈：结果来自后端判分，前端只展示 -->
        <div v-if="item.result" class="feedback" data-testid="quiz-feedback">
          <span class="chip" :class="item.result.correct ? 'chip--ok' : 'chip--warn'" data-testid="quiz-verdict">
            {{ item.result.correct ? '答对了' : '再想一想' }}
          </span>
          <span class="chip" data-testid="quiz-mastery">{{ formatMasteryDelta(item.result.masteryDelta) }}</span>
          <span v-if="item.result.scoredBy" class="chip tool">
            {{ SCORED_BY_LABELS[item.result.scoredBy] }}
          </span>
          <p class="feedback__text" data-testid="quiz-feedback-text">{{ item.result.feedback }}</p>
        </div>

        <div class="item__foot">
          <button
            class="btn btn--primary"
            type="button"
            data-testid="quiz-submit"
            :data-qid="item.question.qid"
            :disabled="submitting"
            @click="submit(item.question)"
          >
            {{ submitting ? '老师正在回应…' : item.result ? '再提交一次' : '提交这题' }}
          </button>
        </div>
      </li>
    </ol>

    <p class="quiz__foot">判分由本地题库完成（答案不下发到界面）。批改结果与掌握度变化会显示在题目下面。</p>
    <p v-if="localHint" class="quiz__hint" data-testid="quiz-hint">{{ localHint }}</p>

    <!-- ★ 闯关进度（票 15）：`submit_quiz` 的载荷带 `levels` 时显示进度条 + 徽章。
         载荷里没有这个键就整块不渲染（不猜、不占位）—— 闯关 UI 不该影响普通练习卡片。 -->
    <ProgressCard v-if="hasProgress" class="quiz__progress" :payload="card.payload" />
  </article>

  <!-- 批改结果：单题的结论卡片 -->
  <article
    v-else-if="view.kind === 'result'"
    class="quiz quiz--result"
    data-quiz="result"
    :data-qid="view.qid"
    :data-correct="String(view.correct)"
    data-testid="quiz-result-card"
  >
    <header class="quiz__head">
      <span class="title">练习批改</span>
      <span class="chip" :class="view.correct ? 'chip--ok' : 'chip--warn'" data-testid="quiz-verdict">
        {{ view.correct ? '答对了' : '再想一想' }}
      </span>
      <span class="chip" data-testid="quiz-mastery">{{ formatMasteryDelta(view.masteryDelta) }}</span>
      <span v-if="view.scoredBy" class="chip tool">{{ SCORED_BY_LABELS[view.scoredBy] }}</span>
      <span class="chip tool">{{ view.qid }}</span>
    </header>
    <p class="item__stem" data-testid="quiz-feedback-text">{{ view.feedback }}</p>

    <!-- ★ 闯关进度（票 15）：**批改结果卡片是「进度变了」的那一张** ——
         题目卡片的载荷是出题时的那一份（那时还没作答），进度要更新只能看结果卡片。
         载荷里没有 `levels` 就不渲染（不猜、不占位）。 -->
    <ProgressCard v-if="hasProgress" class="quiz__progress" :payload="card.payload" />
  </article>

  <!-- 认不出的载荷：一句说明，绝不猜 -->
  <article
    v-else
    class="quiz quiz--unknown"
    data-quiz="unknown"
    :data-tool="card.tool ?? ''"
    data-testid="quiz-card-unknown"
  >
    <header class="quiz__head">
      <span class="title">随堂练习</span>
      <span class="chip chip--warn">这张卡片没能显示出来</span>
    </header>
    <p class="item__stem">{{ view.text || '练习卡片的内容格式不对，老师重新出一遍就好。' }}</p>
  </article>
</template>

<style scoped>
.quiz {
  padding: 14px 16px;
  /* 卡片本体 → 卡片圆角 + paper 白面（与 base.css 的 .k12-card 同配方） */
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-card);
}

/* 批改结果卡片：仍然是**纸**，只是不再叠在题目卡片的嵌入块上 ——
 * 用 surface-2 把「结论卡」和「出题卡」在白面上区分开。 */
.quiz--result {
  background: var(--k12-surface-2);
}

.quiz--unknown {
  border-style: dashed;
}

/* ── 状态胶囊（角标语义）─────────────────────────────────────────────
 * ⚠️ 全局 `.chip` / `.chip--*` 已随新设计系统移除（`base.css` 只剩材质层与
 *   排版层）。模板里的类名照旧写着，于是这些胶囊一直无样式渲染 ——
 *   自带一份，配方与同目录的 `ProgressCard.vue` 一致（同一叠卡片要同族）。
 * `.chip` 必须在 `.tool` **之前**：`.tool` 用同权重选择器覆盖字重与字号。 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
}

/* 答对了 / 已批改 */
.chip--ok {
  background: var(--k12-good-soft);
  border-color: var(--k12-good-border);
  color: var(--k12-good);
}

/* 再想一想 / 未知载荷：走 **warn**（琥珀）而不是 bad。
 * 两条依据：① 同一个动作在 `views/Quiz.vue` 里也是琥珀（`.fb__verdict` / `.hw__score`
 * 答错都用 `--k12-warn`）—— 卡片与它所在的页面不能两种颜色；
 * ② 文案本身是「再想一想」这种鼓励口径，涂成报错红与它自相矛盾。
 * `BlockedNotice` / `DegradedNotice` / `ProgressCard` 的 `.chip--warn` 同为琥珀。 */
.chip--warn {
  background: var(--k12-warn-soft);
  border-color: var(--k12-warn-border);
  color: var(--k12-warn);
}

.chip--accent {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}

.quiz__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.title {
  /* 卡片标题 → 区块标题档（与 ProgressCard 的 `.title` 同一落点） */
  font-size: var(--k12-fs-lg);
  font-weight: 650;
}

.tool {
  font-family: var(--k12-font-mono);
  /* 知识点 id / qid / 判分方：是 id 与标签，不是 ≤4 字角标 → meta 档 */
  font-size: var(--k12-fs-xs);
  font-weight: 500;
}

.quiz__list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: grid;
  gap: 14px;
}

.item {
  padding: 12px 14px;
  /* 题目 = 卡片内的嵌入块 → surface-2 底 + inset 圆角 */
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
}

.item__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.item__no {
  /* 「第 1 题」是题号 meta（与 Quiz.vue 的 .qitem__no 同一落点） */
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
}

.item__stem {
  margin-top: 8px;
  /* 题干 = 这一块的主对象 → 正文档 */
  font-size: var(--k12-fs-md);
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.item__foot {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.options {
  margin-top: 10px;
  display: grid;
  gap: 8px;
}

.option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  /* 选项是在题块（surface-2）上的可点白片 → inset 圆角 + paper 底 */
  border-radius: var(--k12-r-inset);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
  cursor: pointer;
  /* 选项 = 学生要读且要选的对象 → 正文档（与 Quiz.vue 的 .opt 同一落点） */
  font-size: var(--k12-fs-md);
  line-height: 1.7;
}

.option:hover {
  /* 状态描边是「画」的一层 → accent */
  border-color: var(--k12-accent);
}

.option.is-picked {
  border-color: var(--k12-accent);
  background: var(--k12-accent-soft);
}

.option input {
  margin-top: 5px;
  /* radio 的原生染色：浏览器拿它直接画控件，必须给可用的实色 → accent */
  accent-color: var(--k12-accent);
}

.option__letter {
  font-weight: 650;
  color: var(--k12-muted);
}

.option__text {
  flex: 1;
  word-break: break-word;
}

/* ── 按钮 ────────────────────────────────────────────────────────────
 * ⚠️ 全局 `.btn` / `.btn--primary` 已随旧样式表移除，模板里的类名一直无样式。
 *   自带一份（配方取自 `ConfirmDialog` 的 `.cd__btn` / `.cd__btn--primary`）。
 * 高度由 padding + line-height 决定，不钉像素。 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover:not(:disabled) {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 提交键是这一块的主要动作 → 填充用 accent-ink（文字色那一支），
 * 白字压在 accent-ink 上才够对比度；accent 是画得好看的浅色，配白字读不清。 */
.btn--primary {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
}

.ans {
  margin-top: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--k12-r-control);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
  font: inherit;
  color: var(--k12-fg);
}

.ans--code {
  font-family: var(--k12-font-mono);
}

.ans:focus {
  /* 焦点环用派生 token（`--k12-accent-ring`），不在组件里自己 color-mix */
  outline: 2px solid var(--k12-accent-ring);
  outline-offset: 1px;
}

.feedback {
  margin-top: 12px;
  padding: 10px 12px;
  /* 逐题反馈是题块上的白片（结论区）→ inset 圆角 + paper 底 */
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.feedback__text {
  flex: 1 1 100%;
  margin-top: 4px;
  /* 逐题反馈：后端判分写给学生的话 → 次级正文档（与 Quiz.vue 的 .fb__text 同一落点） */
  font-size: var(--k12-fs-sm);
  line-height: 1.7;
  color: var(--k12-muted);
  word-break: break-word;
}

.quiz__foot {
  margin-top: 12px;
  /* 卡片脚注（判分口径说明）→ meta 档 */
  font-size: var(--k12-fs-xs);
  line-height: 1.6;
  color: var(--k12-muted-2);
}

.quiz__hint {
  margin-top: 8px;
  /* 本卡片的即时提示（「先写下你的答案」）：是句劝告不是报错 → 与
   * `views/Quiz.vue` 的 `.qlist__hint` 同为琥珀（那一页里 bad 只留给真正的故障）。 */
  font-size: var(--k12-fs-xs);
  color: var(--k12-warn);
}

/* 闯关进度块：与题目列表拉开一点距离，避免看起来像第 N+1 道题 */
.quiz__progress {
  margin-top: 14px;
}
</style>
