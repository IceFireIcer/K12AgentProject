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
import { computed, onMounted, reactive, ref } from 'vue'
import { QUIZ_TYPE_LABELS, SCORED_BY_LABELS, formatMasteryDelta } from '../labels'
import { useChatStore } from '../stores/chat'
import { useKnowledgeStore } from '../stores/knowledge'
import { useViewModeStore } from '../stores/viewMode'
import type { InlineCard } from '../api/events'
import { kpLabel } from '../study/kp-label'
import CardHeader from '../components/card/CardHeader.vue'
import CardBody from '../components/card/CardBody.vue'
import CardFoot from '../components/card/CardFoot.vue'
import DiagPeekButton from '../components/diag/DiagPeekButton.vue'
import {
  isBlankAnswer,
  optionLetter,
  readQuizCard,
  type QuizQuestionView,
  type QuizResultView
} from './quiz'

const props = defineProps<{ card: InlineCard }>()
const chat = useChatStore()
const knowledge = useKnowledgeStore()
const viewMode = useViewModeStore()

const view = computed(() => readQuizCard(props.card.payload))

/**
 * 卡片头那个知识点 chip 的文字（**教材里的中文名**，不是 slug）。
 *
 * ★ 与 `CodingCard.vue` / 学习档案 / 闯关同一条口径（`study/kp-label.ts`）：
 *   取不到名字时**整个 chip 不出现**，绝不回落成 `ai-definition-jr`。
 *   原始 id 仍在头的 `data-*` / `title` 上（排障用），但不作为文字渲染。
 */
const kpName = computed(() => {
  const id = view.value.kind === 'questions' ? view.value.kpId : ''
  if (id === '') return ''
  const name = kpLabel(id, null, knowledge.kpNameOf)
  return name === '未命名知识点' ? '' : name
})

onMounted(() => {
  // 名字表可能还没到（异步）；失败不阻断卡片，取不到就不显示那个 chip
  void knowledge.ensureNames().catch(() => {})
})

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
interface QuizItem {
  /** 这一题在**本张卡片**里的序号（0 基；步骤条与「第 N 题」共用它）。 */
  index: number
  question: QuizQuestionView
  result: QuizResultView | null
}

const items = computed<QuizItem[]>(() =>
  questions.value.map((question, index) => ({
    index,
    question,
    result: chat.quizResults.get(question.qid) ?? null
  }))
)

const sourceLabel = computed(() => {
  if (view.value.kind !== 'questions') return ''
  // ★ 说人话：`本地题库` 是实现细节（学生不知道什么叫"题库"，也不该关心它在哪）。
  //   对学生的意义是「这题是教材配套的、断网也能做」，那句话才是他需要的。
  if (view.value.source === 'bank') return '教材配套题'
  if (view.value.source === 'generated') return '智团团出的题'
  return ''
})

/** 本轮回复还没结束：提交按钮先禁用（主进程也有并发守卫）。 */
const submitting = computed(() => chat.streaming)

/* ---------------------------------------------------------------- 单卡排版 */

/**
 * 对话内练习卡**一次只渲染一道题**（优化报告 §2.3：默认「单卡」，
 * 全铺开是闯关页的可选模式，对话内不提供）。
 *
 * ★ 与 `views/Quiz.vue` 的 `cursorQid` / `finished` **同构**：
 *   停在哪一题记 **qid**（不记下标）—— 批改结果按 qid 回来，
 *   题集顺序怎么变都对得上；对不上（新的一张卡）就落回第一题。
 */
const cursorQid = ref('')
/** 最后一题答对、并且点了「下一题」→ 卡片换成收尾说明。 */
const finished = ref(false)

/** 当前停在第几题（0 基）。找不到 `cursorQid` 就落到第一题。 */
const currentIndex = computed(() => {
  const rows = items.value
  if (rows.length === 0) return 0
  const index = rows.findIndex((row) => row.question.qid === cursorQid.value)
  return index >= 0 ? index : 0
})

/** 当前那一行（题集为空时为 `null`）。 */
const currentItem = computed<QuizItem | null>(() => items.value[currentIndex.value] ?? null)

/** 当前这道题是不是已经有**终态**（后端判为答对）—— 与 `submitDisabled` 同一口径。 */
const currentSettled = computed(() => currentItem.value?.result?.correct === true)

/** 走完最后一题 → 题体与卡脚不渲染，换成收尾说明。 */
const showFinish = computed(() => questions.value.length > 0 && finished.value)

/**
 * 这一次**渲染出来**的题：单卡模式只有当前一行（收尾时一行都没有）。
 *
 * ★ 与 `views/Quiz.vue` 的 `visibleRows` 同构 —— 差别只有一个：
 *   对话内没有「全部铺开」这一档（报告 §2.3：全铺开是闯关页的可选模式）。
 */
const visibleRows = computed<QuizItem[]>(() => {
  if (showFinish.value) return []
  return currentItem.value === null ? [] : [currentItem.value]
})

/** 答对题数 / 第一道还没答对的题号：只读后端判分结论，前端不另立统计口径。 */
const correctCount = computed(() => items.value.filter((item) => item.result?.correct === true).length)
const firstUnsettledIndex = computed(() =>
  items.value.findIndex((item) => item.result?.correct !== true)
)

/** 步骤条状态：只读后端判分结论（前端不推断对错）。 */
function stepState(item: QuizItem): 'correct' | 'wrong' | 'todo' {
  if (item.result?.correct === true) return 'correct'
  if (item.result) return 'wrong'
  return 'todo'
}

/** 步骤条的读屏文案（含题号与状态，读屏用户不必去猜颜色）。 */
function stepLabel(index: number, item: QuizItem): string {
  const name = `第 ${index + 1} 题`
  const state = stepState(item)
  if (state === 'correct') return `${name}，答对了`
  if (state === 'wrong') return `${name}，还没做对`
  return `${name}，还没做过`
}

/** 跳到第 index 题 —— 步骤条、上一题、下一题**共用的唯一入口**（跳题自由，不设门禁）。 */
function goTo(index: number): void {
  const rows = items.value
  if (rows.length === 0) return
  const target = rows[Math.min(Math.max(index, 0), rows.length - 1)]
  if (target === undefined) return
  finished.value = false
  cursorQid.value = target.question.qid
}

function prevQuestion(): void {
  if (currentIndex.value <= 0) return
  goTo(currentIndex.value - 1)
}

/** 「下一题」：只有当前题被后端判为答对才可点（答错留在原地接着想）；最后一题 → 收尾。 */
function nextQuestion(): void {
  if (!currentSettled.value) return
  if (currentIndex.value >= items.value.length - 1) {
    finished.value = true
    return
  }
  goTo(currentIndex.value + 1)
}

/** 收尾说明里的「回去接着做」：跳到第一道还没答对的题。 */
function backToUnsettled(): void {
  if (firstUnsettledIndex.value < 0) return
  goTo(firstUnsettledIndex.value)
}

/**
 * 提交键的文案与状态（**一题一个终态**）。
 *
 * ★★ 修的是什么（评审发现的真实缺陷）：旧文案是
 *   `submitting ? '老师正在回应…' : item.result ? '再提交一次' : '提交这题'` ——
 *   **答对之后按钮还在请学生「再提交一次」**，于是他会再点一次，而后端的反馈里
 *   写着"这次不计入"。一个邀请学生做无用功、而且做了之后被系统告诉"不算"的按钮。
 *
 * 判据只读**后端判分结果**里的 `correct`（`cards/quiz.ts` 的 `QuizResultView`，
 * 那一个布尔是唯一权威）：答对 → `已完成` 且**禁用**；答错 → 仍然可点，文案是
 * 「再试一次」（那是这个按钮真正在邀请他做的事）。
 * ★ 不发 `data-*` 之外的任何东西，也不在前端"顺便判个对错"。
 */
function submitLabel(item: QuizItem | null): string {
  if (submitting.value) return '老师正在回应…'
  if (item === null || item.result === null) return '提交这题'
  return item.result.correct ? '已完成' : '再试一次'
}

/** 提交键是否禁用：正在回答，或**这道题已经答对**（终态，再点没有意义）。 */
function submitDisabled(item: QuizItem | null): boolean {
  return submitting.value || item?.result?.correct === true
}

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

/** 卡脚提交键的动作：把**当前这一题**交给 `submit`（模板里不做非空断言）。 */
function submitCurrent(): void {
  const item = currentItem.value
  if (item === null) return
  submit(item.question)
}
</script>

<template>
  <!-- 出题：**一次一张**（报告 §2.3：对话内练习卡默认单卡，全铺开只在闯关页提供）。
       三段结构 = 卡头（题号 + 步骤条 + 对象级动作）/ 卡身（当前这一题）/ 卡脚（上一题 / 提交 / 下一题）。
       ★★ 三段走 `components/card/` 的子组件（类名直通 base.css 的 `.k12-card-*`，皮肤唯一来源）；
          卡片根元素只给 `k12-card`（白面 + 边框 + 圆角 + 投影）—— 本文件不再自带卡片皮肤。 -->
  <article
    v-if="view.kind === 'questions'"
    class="k12-card quiz"
    data-testid="quiz-card"
    data-quiz="questions"
    :data-kp-id="view.kpId"
    data-probe-id="quiz-card"
    :data-probe-count="showFinish ? 0 : 1"
  >
    <CardHeader>
      <template #title>
        <span class="title">随堂练习</span>
      </template>
      <template #meta>
        <span class="chip chip--accent" data-testid="quiz-count">{{ questions.length }} 道题</span>
        <span v-if="!showFinish" class="chip k12-num" data-testid="quiz-position">
          第 {{ currentIndex + 1 }} / {{ questions.length }} 题
        </span>
        <span v-if="sourceLabel" class="chip" data-testid="quiz-source">{{ sourceLabel }}</span>
        <!-- ★★ 原来这里是 `{{ view.kpId }}`（`ai-definition-jr` 这种内部主键）。
             卡片长在**对话正文里**，那是学生看得最多的地方 —— 走查那条
             「立刻隐藏所有 ID，只展示知识点的中文标题」正指这里。
             改成中文名，取不到就整个不显示（原始 id 只进 `title`）。 -->
        <span v-if="kpName" class="chip tool" data-testid="quiz-kp" :title="view.kpId">{{ kpName }}</span>
        <!-- 题号步骤条：一颗 = 一题，**可点**（想回看哪一题就点哪一题）；
             状态只读后端判分结论，「我在哪一题」用 `aria-current` 与 `.step--on` 单独表达。 -->
        <ol v-if="!showFinish" class="steps" data-testid="quiz-steps">
          <li v-for="(item, index) in items" :key="item.question.qid">
            <button
              type="button"
              class="step k12-tap"
              :class="{ 'step--on': index === currentIndex }"
              :data-state="stepState(item)"
              :aria-current="index === currentIndex ? 'step' : undefined"
              :aria-label="stepLabel(index, item)"
              :data-testid="`quiz-step-${index + 1}`"
              @click="goTo(index)"
            >
              <span class="k12-num">{{ index + 1 }}</span>
            </button>
          </li>
        </ol>
      </template>
      <template #actions>
        <!-- 演示档专用：就地看「判分与掌握度那一套是怎么走的」 -->
        <DiagPeekButton />
      </template>
    </CardHeader>

    <CardBody>
      <!-- 收尾说明：最后一题答对 + 点了「下一题」——题体与卡脚这时都不渲染 -->
      <div v-if="showFinish" class="quiz__finish" data-testid="quiz-finish" tabindex="-1">
        <p class="quiz__finish-title">这一组做完了</p>
        <p class="quiz__finish-score k12-num" data-testid="quiz-finish-score">
          答对 {{ correctCount }} / 共 {{ questions.length }} 题
        </p>
        <p v-if="firstUnsettledIndex >= 0" class="quiz__finish-left">
          还有 {{ questions.length - correctCount }} 题没做对
        </p>
        <button
          v-if="firstUnsettledIndex >= 0"
          class="btn"
          type="button"
          data-testid="quiz-finish-back"
          @click="backToUnsettled()"
        >
          回去接着做
        </button>
      </div>

      <!-- 当前这一题：**只渲染一行**（`visibleRows`），卡头/卡脚围着它转 -->
      <template v-else>
      <div
        v-for="row in visibleRows"
        :key="row.question.qid"
        class="item"
        data-testid="quiz-question"
        :data-qid="row.question.qid"
        :data-type="row.question.type"
      >
        <div class="item__head">
          <span class="item__no">第 {{ row.index + 1 }} 题</span>
          <span class="chip" data-testid="quiz-type">{{ QUIZ_TYPE_LABELS[row.question.type] }}</span>
          <span v-if="row.result" class="chip chip--ok" data-testid="quiz-done">已批改</span>
        </div>
        <p class="item__stem" data-testid="quiz-stem">{{ row.question.stem }}</p>

        <!-- 选择题：点选项即选中（提交的是选项文本；字母与原文后端都认） -->
        <div v-if="row.question.type === 'choice'" class="options">
          <label
            v-for="(option, optionIndex) in row.question.options"
            :key="`${row.question.qid}-${optionIndex}`"
            class="option"
            :class="{ 'is-picked': picked[row.question.qid] === optionIndex }"
            data-testid="quiz-option"
          >
            <input
              type="radio"
              :name="`quiz-${row.question.qid}`"
              :value="option"
              :checked="picked[row.question.qid] === optionIndex"
              @change="pick(row.question.qid, optionIndex, option)"
            />
            <span class="option__letter">{{ optionLetter(optionIndex) }}</span>
            <span class="option__text">{{ option }}</span>
          </label>
        </div>

        <!-- 填空：单空文本作答 -->
        <input
          v-else-if="row.question.type === 'blank'"
          class="ans"
          type="text"
          :value="answers[row.question.qid] ?? ''"
          placeholder="把你想到的答案写在这里"
          data-testid="quiz-blank"
          @input="onInput(row.question.qid, $event)"
        />

        <!-- 代码填空：等宽输入（答案通常是一个运算符或表达式） -->
        <input
          v-else
          class="ans ans--code"
          type="text"
          :value="answers[row.question.qid] ?? ''"
          placeholder="填进空里的代码，例如 + 或 +="
          spellcheck="false"
          data-testid="quiz-code-blank"
          @input="onInput(row.question.qid, $event)"
        />

        <!-- 逐题反馈：结果来自后端判分，前端只展示 -->
        <div v-if="row.result" class="feedback" data-testid="quiz-feedback">
          <span class="chip" :class="row.result.correct ? 'chip--ok' : 'chip--warn'" data-testid="quiz-verdict">
            {{ row.result.correct ? '答对了' : '再想一想' }}
          </span>
          <span class="chip" data-testid="quiz-mastery">{{ formatMasteryDelta(row.result.masteryDelta) }}</span>
          <span v-if="row.result.scoredBy" class="chip tool">
            {{ SCORED_BY_LABELS[row.result.scoredBy] }}
          </span>
          <p class="feedback__text" data-testid="quiz-feedback-text">{{ row.result.feedback }}</p>
        </div>
      </div>

      <!-- ★ 脚注只讲**对学生有意义**的两件事：答案不摆在界面上（这是功能上的承诺，
           学生知道自己不会被"抄答案"这条路带偏），结果会出现在题目下面（他知道去哪找）。
           旧文案里那句「判分由本地题库完成」是实现细节，已去。 -->
      <p class="quiz__foot">
        答案不会摆在界面上，这样你才是在自己练。批改结果与掌握度变化会显示在题目下面。
      </p>
      </template>

      <p v-if="localHint" class="quiz__hint" data-testid="quiz-hint">{{ localHint }}</p>
    </CardBody>

    <!-- 卡脚：上一题 / 提交 / 下一题（状态提交类动作才收进卡脚，页面级动作不许放这里）。
         ★ 一屏只允许一个主色填充 = 这里的「提交这题」；上一题 / 下一题是次要动作。 -->
    <CardFoot v-if="!showFinish && currentItem">
      <div class="quiz__nav" data-testid="quiz-nav">
        <button
          class="btn"
          type="button"
          data-testid="quiz-prev"
          :disabled="currentIndex === 0"
          @click="prevQuestion()"
        >
          上一题
        </button>
        <div class="quiz__nav-main">
          <button
            class="k12-cta"
            type="button"
            data-testid="quiz-submit"
            :data-qid="currentItem.question.qid"
            :disabled="submitDisabled(currentItem)"
            @click="submitCurrent()"
          >
            {{ submitLabel(currentItem) }}
          </button>
          <button
            class="btn"
            type="button"
            data-testid="quiz-next"
            :disabled="!currentSettled"
            :title="currentSettled ? '换到下一题' : '答对这一题，就能往下走'"
            @click="nextQuestion()"
          >
            下一题
          </button>
        </div>
      </div>
    </CardFoot>
  </article>

  <!-- 批改结果：单题的结论卡片 -->
  <article
    v-else-if="view.kind === 'result'"
    class="k12-card quiz quiz--result"
    data-quiz="result"
    :data-qid="view.qid"
    :data-correct="String(view.correct)"
    data-testid="quiz-result-card"
  >
    <CardHeader>
      <template #title>
        <span class="title">练习批改</span>
      </template>
      <template #meta>
        <span class="chip" :class="view.correct ? 'chip--ok' : 'chip--warn'" data-testid="quiz-verdict">
          {{ view.correct ? '答对了' : '再想一想' }}
        </span>
        <span class="chip" data-testid="quiz-mastery">{{ formatMasteryDelta(view.masteryDelta) }}</span>
        <span v-if="view.scoredBy" class="chip tool">{{ SCORED_BY_LABELS[view.scoredBy] }}</span>
        <!-- ★★ 这一格原来直接印 `{{ view.qid }}` —— 而 qid 的真实形状是
             `gen-ai-definition-jr-45238405-1`：**里面嵌着一个知识点 slug**。
             它出现在学生自己的批改结果卡上，等于把内部主键再印一遍。
             学生不需要它（他知道自己刚答了哪题），排障需要 —— 所以**只在教师视角显示**。
             ⚠️ 不用 `<TeacherGate>`：那会渲染一个 `<section>`，塞进这个横向排版的
                `<header>` 里会破坏 flex 布局（与 `SessionList.vue` 同一处取舍）。
             ★ 学生那半边**不给替代文字**：编一个「第 N 题」需要结果载荷里根本没有的序号，
               猜一个等于在界面上写假话。 -->
        <span v-if="viewMode.isTeacher" class="chip tool" data-testid="quiz-qid-mark">{{ view.qid }}</span>
      </template>
    </CardHeader>
    <CardBody>
      <p class="item__stem" data-testid="quiz-feedback-text">{{ view.feedback }}</p>
    </CardBody>
  </article>

  <!-- 认不出的载荷：不猜内容，但**不说系统内部的话** ──────────────────────────
       ★ 旧文案「练习卡片的内容格式不对，老师重新出一遍就好」里的"内容格式不对"
         是写给开发者看的判断，学生只该知道"这次没出出来 + 我能做什么"。
         （与 `cards/CodingCard.vue` 的未知分支同一口径。主进程
         `agent/extensions/quiz.ts` 里有一句注释引用了旧串，那句注释会跟着过期。） -->
  <article
    v-else
    class="k12-card quiz quiz--unknown"
    data-quiz="unknown"
    :data-tool="card.tool ?? ''"
    :data-detail="view.text || null"
    data-testid="quiz-card-unknown"
  >
    <CardHeader>
      <template #title>
        <span class="title">随堂练习</span>
      </template>
      <template #meta>
        <span class="chip chip--warn">这次的题目没能出出来</span>
      </template>
    </CardHeader>
    <CardBody>
      <!-- ★ 主进程有时会带一句**本来就是写给学生看的**说明（例如主观题缺模型时的
           `SUBJECTIVE_UNAVAILABLE_TEXT`）—— 那种情况下以它为准，它比泛泛的兜底有用；
           没有才用兜底那句（旧实现把兜底写成「内容格式不对」，那是开发者视角）。
           ★ 兜底句里的「题库」也一并去掉了（与本文件 `sourceLabel` 那条口径一致：
             学生不知道什么叫题库，他是从「再去要两道题」这个动作里恢复的）。 -->
      <p class="item__stem" data-testid="quiz-unknown-notice">
        {{ view.text || '这次的题目没能出出来。跟智团团说一句「再出两道题练一练」就能重新来一遍。' }}
      </p>
    </CardBody>
  </article>
</template>

<style scoped>
/* 卡片皮肤（白面 / 边框 / 圆角 / 投影 / min-width）唯一来源 = base.css 的 `.k12-card`；
 * 三段结构（卡头 / 卡身 / 卡脚）的底色与内边距 = `.k12-card-head/-body/-foot`。
 * 本组件只补「卡片内部自己的排布」，不再自带一份卡片皮肤（抄一份必然漂移）。 */
.quiz {
  min-width: 0;
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
  font-size: var(--k12-fs-caption);
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

.title {
  /* 卡片标题的档位由 `.k12-card-head` 给（h3 20px，base.css 的唯一落点）——
   * 这里只补字重：卡头是「这一块叫什么」，比正文重一档。 */
  font-weight: 650;
}

.tool {
  font-family: var(--k12-font-mono);
  /* 知识点 id / qid / 判分方：是 id 与标签，不是 ≤4 字角标 → meta 档 */
  font-size: var(--k12-fs-caption);
  font-weight: 500;
}

/* ── 题号步骤条（卡头里）─────────────────────────────────────────────────
 * 一颗 = 一题，**可点**（想回看哪一题就点哪一题）。
 * 高度由 `.k12-tap` 给（28px 触控下限），这里只定宽度与形状，不写死高度。 */
.steps {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  padding: 0;
  list-style: none;
}
.step {
  width: 28px;
  border-radius: var(--k12-r-flat);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  cursor: pointer;
}
/* 状态色（只读后端判分结论）：答对 = good、还没做对 = warn、还没做 = 中性。
 * 「我在哪一题」是另一个问题 —— 用 `.step--on` 的 accent 描边表达，两者不互相顶掉。 */
.step[data-state='correct'] {
  border-color: var(--k12-good);
  background: color-mix(in srgb, var(--k12-good) 14%, var(--k12-surface));
  color: var(--k12-fg);
}
.step[data-state='wrong'] {
  border-color: var(--k12-warn-border);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.step--on {
  border-color: var(--k12-accent-ink);
  box-shadow: 0 0 0 2px var(--k12-accent-soft);
}
.step:focus-visible {
  outline: 2px solid var(--k12-accent);
  outline-offset: 2px;
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
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
}

.item__stem {
  margin-top: 8px;
  /* 题干 = 这一块的主对象 → 正文档 */
  font-size: var(--k12-fs-body);
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 卡脚：上一题 / 提交 / 下一题 ─────────────────────────────────────────
 * 提交键走 `.k12-cta`（全站主要动作唯一配方，也是这一屏唯一的主色填充）；
 * 上一题 / 下一题是次要动作 → 本文件的 `.btn`。 */
.quiz__nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.quiz__nav-main {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

/* ── 收尾说明：这一组走完（题体与卡脚这时都不渲染）──────────────────────── */
.quiz__finish {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.quiz__finish:focus-visible {
  outline: 2px solid var(--k12-accent);
  outline-offset: 2px;
}
.quiz__finish-title {
  font-size: var(--k12-fs-body-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.quiz__finish-score {
  font-size: var(--k12-fs-body);
  font-weight: 650;
  color: var(--k12-fg);
}
.quiz__finish-left {
  font-size: var(--k12-fs-body-sm);
  color: var(--k12-muted);
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
  font-size: var(--k12-fs-body);
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
  font-size: var(--k12-fs-body-sm);
  font-weight: 600;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover:not(:disabled) {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

/* 禁用态：`.k12-cta`（主提交键）自带一套**实心灰底**的禁用样式 —— base.css 里明确
 * 要求「不要用低透明度，那会让文字掉到不可读」。所以低透明度这一支只留给我们自己的
 * 普通按钮；提交键的禁用观感由 `.k12-cta:disabled` 负责（禁用 ≠ 看不清）。 */
.btn:disabled:not(.k12-cta) {
  opacity: 0.5;
  cursor: not-allowed;
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
  font-size: var(--k12-fs-body-sm);
  line-height: 1.7;
  color: var(--k12-muted);
  word-break: break-word;
}

.quiz__foot {
  margin-top: 12px;
  /* 卡片脚注（判分口径说明）→ meta 档 */
  font-size: var(--k12-fs-caption);
  line-height: 1.6;
  color: var(--k12-muted-2);
}

.quiz__hint {
  margin-top: 8px;
  /* 本卡片的即时提示（「先写下你的答案」）：是句劝告不是报错 → 与
   * `views/Quiz.vue` 的 `.qlist__hint` 同为琥珀（那一页里 bad 只留给真正的故障）。 */
  font-size: var(--k12-fs-caption);
  color: var(--k12-warn);
}
</style>
