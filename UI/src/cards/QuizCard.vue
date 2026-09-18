<script setup lang="ts">
/**
 * 闯关练习内联卡。
 *
 * ⚠️ 判分不在这里：`QuizQuestionOut` **没有 answer 字段**（§6.3 答案泄漏防护），
 * 判分只走后端 `/api/quiz/grade`。本原型只做选择交互与视觉，不本地判对错。
 * 接线时：选中 → 提交 → 经 IPC 请主进程转 sidecar 判分 → 用返回的 `QuizResult` 渲染反馈。
 *
 * 修掉的三个既有毛病：
 *  1. 填空题**永远提交不了** —— `canSubmit` 只看 `picked`（选择题的游标），填空题填了词
 *     也进不去提交态；
 *  2.「下一题」不清空填空题的输入，上一题的答案会串到下一题；
 *  3. 选项字母硬编码 `['A','B','C','D']`，第 5 个选项会渲染成 `undefined`。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Maximize2, MessagesSquare } from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import { useFloatPanel } from '@/stores/floatPanel'
import { kpNames, quizPayload } from '@/mocks'

const props = withDefaults(
  defineProps<{
    /** 内联在对话里时用：收窄到舒适阅读宽度，不铺满整列 */
    compact?: boolean
  }>(),
  { compact: false }
)

/**
 * 掌握度增减：与后端 `server/app/routes/quiz.py` 的
 * `MASTERY_GAIN_CORRECT = 0.15` / `MASTERY_LOSS_WRONG = 0.10` 对齐。
 * 前端只显示规则，**不参与计算** —— 真正的 delta 由 `QuizResult.masteryDelta` 带回。
 */
const GAIN_CORRECT = 0.15
const LOSS_WRONG = 0.1

const router = useRouter()
const floatPanel = useFloatPanel()

/** 打开悬浮追问窗，带着「我在做这道题」这个上下文 */
function ask(e: MouseEvent) {
  floatPanel.openFrom(e.currentTarget as Element, {
    kind: 'quiz',
    title: `${kpNames[quizPayload.kpId] ?? quizPayload.kpId} · 第 ${index.value + 1} 题`,
    hint: '可以问：这题到底在问什么 / 这两个选项有什么区别'
  })
}

const questions = quizPayload.questions
const index = ref(0)
const picked = ref<number | null>(null)
const pickedBlank = ref('')
const submitted = ref(false)

/**
 * 本轮是否已答完。最后一题提交后进入**结算态**，而不是直接重来 ——
 * 此前点「本轮完成」等于清空重开，学生拿不到任何"我这一轮做了什么"的反馈。
 *
 * ⚠️ 结算里**不显示对错统计**：`QuizQuestionOut` 没有 answer，判分只走后端
 * `/api/quiz/grade`。这里能如实说的只有"我提交了什么"（作答摘要），
 * 对错与 masteryDelta 要等 `QuizResult` 回来才能填。
 */
const finished = ref(false)
/** 逐题作答摘要：只记"答了什么"，不记"对不对" */
const answers = ref<{ qid: string; summary: string; kind: string; explanation: string }[]>([])

const current = computed(() => questions[index.value]!)
const isChoice = computed(() => current.value.type === 'choice')
const isLast = computed(() => index.value >= questions.length - 1)

/** 不设 4 项上限：选项多于 4 个时继续给 E、F… */
function letter(i: number) {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1)
}

/** 提交后显示反馈区，但**不显示对错**——对错只有后端判分才知道 */
const canSubmit = computed(() =>
  isChoice.value ? picked.value !== null : pickedBlank.value.trim().length > 0
)

function pick(i: number) {
  if (submitted.value) return
  picked.value = picked.value === i ? null : i
}

function submit() {
  if (!canSubmit.value) return
  submitted.value = true
  const q = current.value
  answers.value.push({
    qid: q.qid,
    kind: q.type === 'choice' ? '选择' : q.type === 'blank' ? '填空' : q.type,
    explanation: q.explanation,
    summary:
      q.type === 'choice'
        ? `${letter(picked.value ?? 0)}. ${q.options?.[picked.value ?? 0] ?? ''}`
        : pickedBlank.value.trim()
  })
}

function next() {
  if (isLast.value) return
  index.value += 1
  // 两种题型的状态都要清干净，否则答案会串到下一题
  picked.value = null
  pickedBlank.value = ''
  submitted.value = false
}

/** 最后一题提交后进入结算 */
function finish() {
  finished.value = true
}

function restart() {
  index.value = 0
  picked.value = null
  pickedBlank.value = ''
  submitted.value = false
  finished.value = false
  answers.value = []
}
</script>

<template>
  <SurfacePanel flush class="qz" :class="{ 'qz--compact': props.compact }">
    <!-- ── 结算态：整卡换成"这一轮我做了什么" ──────────────────────────
         不显示对错（前端拿不到 answer），只列作答摘要 + 说明判分去向。 -->
    <template v-if="finished">
      <div class="qz__head">
        <div class="qz__top">
          <span class="qz__tag">闯关</span>
          <span class="qz__title">本轮完成</span>
          <span class="qz__step">{{ answers.length }} / {{ questions.length }} 题已作答</span>
        </div>
      </div>

      <div class="qz__body">
        <!-- 解析：QuizQuestionOut 带 explanation，此前**从未渲染过**。
             注意它讲的是"这题考什么"，不含答案的对错判定（那要等 QuizResult）。 -->
        <ol class="sum">
          <li v-for="(a, i) in answers" :key="a.qid" class="sum__row">
            <span class="sum__idx">{{ i + 1 }}</span>
            <div class="sum__text">
              <span class="sum__qid">{{ kpNames[quizPayload.kpId] ?? quizPayload.kpId }} · {{ a.kind }}题</span>
              <span class="sum__ans">{{ a.summary || '（未填）' }}</span>
              <span v-if="a.explanation" class="sum__why">{{ a.explanation }}</span>
            </div>
          </li>
        </ol>

        <div class="sum__pending">
          <span class="k12-dot sum__dot" />
          <span>
            作答已提交，等待后端判分。对错与掌握度变化由
            <code>/api/quiz/grade</code> 返回的 <code>QuizResult</code> 决定 ——
            答案不下发前端，所以这里不显示对错。
          </span>
        </div>
      </div>

      <div class="qz__foot">
        <span class="qz__xp">掌握度变化：待后端返回</span>
        <button type="button" class="qz__submit qz__submit--done" @click="restart">
          再来一次
        </button>
      </div>
    </template>

    <template v-else>
    <div class="qz__head">
      <div class="qz__top">
        <span class="qz__tag">闯关</span>
        <span class="qz__title">{{ quizPayload.questions.length }} 题</span>
        <span class="qz__step">第 {{ index + 1 }} / {{ questions.length }} 题</span>
        <button type="button" class="qz__ask" title="就地追问这道题" @click="ask">
          <MessagesSquare :size="14" />
          <span>追问</span>
        </button>
        <button
          v-if="props.compact"
          type="button"
          class="qz__icon"
          title="在闯关练习页展开"
          @click="router.push({ name: 'quiz' })"
        >
          <Maximize2 :size="14" />
        </button>
      </div>
      <p class="qz__stem">{{ current.stem }}</p>
    </div>

    <div class="qz__body">
      <!-- 选择题 -->
      <template v-if="isChoice">
        <button
          v-for="(opt, i) in current.options ?? []"
          :key="opt"
          type="button"
          class="qz__opt"
          :class="{ 'qz__opt--on': picked === i }"
          :disabled="submitted"
          @click="pick(i)"
        >
          <span class="qz__key" :class="{ 'qz__key--on': picked === i }">{{ letter(i) }}</span>
          <span class="qz__opt-text">{{ opt }}</span>
        </button>
      </template>

      <!-- 填空：题干里的空格用输入框承接 -->
      <div v-else class="qz__blank">
        <el-input
          v-model="pickedBlank"
          placeholder="填写答案"
          :disabled="submitted"
          @keydown.enter="submit"
        />
      </div>

      <div v-if="submitted" class="qz__pending">
        <span class="k12-dot qz__pending-dot" />
        <span>已提交，等待后端判分（正确性由 <code>/api/quiz/grade</code> 返回，答案不下发前端）</span>
      </div>
    </div>

    <div class="qz__foot">
      <span class="qz__xp">答对掌握度 +{{ GAIN_CORRECT }} · 答错 −{{ LOSS_WRONG }}</span>

      <button
        v-if="!submitted"
        type="button"
        class="qz__submit"
        :disabled="!canSubmit"
        @click="submit"
      >
        提交
      </button>
      <button v-else-if="!isLast" type="button" class="qz__submit" @click="next">下一题</button>
      <button v-else type="button" class="qz__submit" @click="finish">查看本轮小结</button>
    </div>
    </template>
  </SurfacePanel>
</template>

<style scoped>
/* 内联在对话里时收窄：选项文字短，一行拉太长反而不好读 */
.qz--compact {
  width: 100%;
  max-width: 560px;
}

.qz__head {
  padding: 12px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.qz__top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.qz__tag {
  padding: 3px 8px;
  border-radius: var(--k12-r-flat);
  background: color-mix(in srgb, var(--k12-bad) 10%, var(--k12-surface));
  color: var(--k12-bad);
  font-size: var(--k12-fs-micro);
  font-weight: 700;
  flex: none;
}
.qz__title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  color: var(--k12-fg);
}
.qz__step {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
/* 追问：卡头一级动作，用描边按钮而不是图标按钮 —— 它是这轮新增的主入口 */
.qz__ask {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 4px 9px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .qz__ask:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
/* 追问占了 auto 边距后，展开键不再需要 */
.qz__ask + .qz__icon {
  margin-left: 0;
}
.qz__icon {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
  padding: 5px;
  border-radius: var(--k12-r-flat);
  display: inline-flex;
  flex: none;
}
@media (hover: hover) and (pointer: fine) {
.qz__icon:hover {
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
}
}
.qz__stem {
  font-size: var(--k12-fs-sm);
  font-weight: 550;
  color: var(--k12-fg-2);
  line-height: var(--k12-lh-body);
}

.qz__body {
  padding: 0 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 选项用实色而非玻璃：卡面本身已是半透明玻璃，浅色叠浅色会糊 */
/* ── 结算态 ──────────────────────────────────────────────────────────── */
.sum {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sum__row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 11px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.sum__idx {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-micro);
  font-weight: 700;
}
.sum__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sum__qid {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.sum__ans {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
  word-break: break-word;
}
/* 解析：比作答摘要低一档，用左侧细线标出它是"讲解"不是"作答"
 * （低一档由颜色/边线承担，字号同为 12px —— 11px 只许给角标） */
.sum__why {
  margin-top: 3px;
  padding-left: 9px;
  border-left: 2px solid var(--k12-border-strong);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.sum__pending {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 11px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
}
.sum__pending code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
}
.sum__dot {
  margin-top: 6px;
  background: var(--k12-warn);
}

.qz__opt {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
.qz__opt:hover:not(:disabled) {
  border-color: var(--k12-accent-ink);
}
}
.qz__opt--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-ink);
}
.qz__opt:disabled {
  cursor: default;
}
/* 选项字母（A / B / C）：单字**角标**，装在 22×22 方框里 —— 它是"记号"不是正文。
 * 用 11px：升到 12px 会与选项正文（13px）贴得太近，记号感就没了。
 * （注：审计的角标词表已加入 `key`，这条本就是合规角标。） */
.qz__key {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--k12-r-flat);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  font-weight: 700;
}
.qz__key--on {
  background: var(--k12-accent);
  color: var(--k12-surface);
}
.qz__opt-text {
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
}
.qz__opt--on .qz__opt-text {
  color: var(--k12-accent-ink);
  font-weight: 550;
}
.qz__blank {
  padding: 2px 0;
}

.qz__pending {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--k12-r-control);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
}
.qz__pending-dot {
  background: var(--k12-warn);
}
.qz__pending code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
}

.qz__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px 14px;
}
.qz__xp {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.qz__submit {
  margin-left: auto;
  padding: 8px 14px;
  border: 1px solid var(--k12-accent);
  border-radius: var(--k12-r-control);
  background: var(--k12-accent);
  color: var(--k12-surface);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
.qz__submit:hover:not(:disabled) {
  filter: brightness(1.06);
}
}
.qz__submit:disabled {
  background: var(--k12-border-strong);
  border-color: transparent;
  color: var(--k12-muted);
  cursor: not-allowed;
}
.qz__submit--done {
  background: var(--k12-surface-2);
  border-color: var(--k12-border);
  color: var(--k12-fg-2);
}
@media (hover: hover) and (pointer: fine) {
.qz__submit--done:hover {
  filter: none;
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}
}
</style>
