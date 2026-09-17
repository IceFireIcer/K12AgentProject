<script setup lang="ts">
/**
 * 闯关练习内联卡（客观题）。
 *
 * ⚠️ 判分不在这里：`QuizQuestionOut` **没有 answer 字段**（§6.3 答案泄漏防护），
 * 判分只走后端 `/api/quiz/grade`。本原型只做选择交互与视觉，不本地判对错。
 * 接线时：选中 → 提交 → 经 IPC 请主进程转 sidecar 判分 → 用返回的 `QuizResult` 渲染反馈。
 */
import { computed, ref } from 'vue'
import { quizPayload } from '@/mocks'

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const questions = quizPayload.questions
const index = ref(0)
const picked = ref<number | null>(null)
const pickedBlank = ref('')
const submitted = ref(false)

const current = computed(() => questions[index.value]!)
const isChoice = computed(() => current.value.type === 'choice')
const letters = ['A', 'B', 'C', 'D']

/** 提交后显示反馈区，但**不显示对错**——对错只有后端判分才知道 */
const canSubmit = computed(() => picked.value !== null)

function pick(i: number) {
  if (submitted.value) return
  picked.value = picked.value === i ? null : i
}

function submit() {
  if (!canSubmit.value) return
  submitted.value = true
}

function next() {
  if (index.value < questions.length - 1) {
    index.value += 1
    picked.value = null
    submitted.value = false
  }
}
</script>

<template>
  <div class="qz" :class="{ 'qz--compact': props.compact }">
    <div class="qz__head">
      <div class="qz__top">
        <span class="qz__tag">闯关</span>
        <span class="qz__title">快速检验 · {{ questions.length }} 题</span>
        <span class="qz__step">第 {{ index + 1 }} / {{ questions.length }} 题</span>
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
          <span class="qz__key" :class="{ 'qz__key--on': picked === i }">{{ letters[i] }}</span>
          <span class="qz__opt-text">{{ opt }}</span>
        </button>
      </template>

      <!-- 填空：题干里的空格用输入框承接 -->
      <div v-else class="qz__blank">
        <el-input v-model="pickedBlank" placeholder="填写答案" :disabled="submitted" />
      </div>

      <div v-if="submitted" class="qz__pending">
        <span class="k12-dot qz__pending-dot" />
        <span>本原型不判分：正确性由后端 <code>/api/quiz/grade</code> 返回（答案不下发前端）</span>
      </div>
    </div>

    <div class="qz__foot">
      <span class="qz__xp">答对 +10 经验 · 掌握度 +0.05</span>
      <button v-if="!submitted" type="button" class="qz__submit" :disabled="!canSubmit" @click="submit">
        提交
      </button>
      <button
        v-else-if="index < questions.length - 1"
        type="button"
        class="qz__submit"
        @click="next"
      >
        下一题
      </button>
      <span v-else class="qz__done">本轮完成</span>
    </div>
  </div>
</template>

<style scoped>
.qz {
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
  overflow: hidden;
}
.qz--compact {
  max-width: 300px;
}

.qz__head {
  padding: 11px 13px;
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
  border-radius: var(--k12-r-sm);
  background: #fff1f2;
  color: var(--k12-bad);
  font-size: var(--k12-fs-micro);
  font-weight: 700;
  flex: none;
}
.qz__title {
  font-size: var(--k12-fs-base);
  font-weight: 650;
  color: var(--k12-fg);
}
.qz__step {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.qz__stem {
  font-size: var(--k12-fs-sm-2);
  font-weight: 550;
  color: var(--k12-fg-2);
  line-height: 1.6;
}

.qz__body {
  padding: 0 13px 11px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.qz__opt {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface);
  cursor: pointer;
  text-align: left;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.qz__opt:hover:not(:disabled) {
  border-color: var(--k12-accent-border);
}
.qz__opt--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.qz__opt:disabled {
  cursor: default;
  opacity: 0.85;
}
.qz__key {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: var(--k12-r-xs);
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
  color: #fff;
}
.qz__opt-text {
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
}
.qz__opt--on .qz__opt-text {
  color: var(--k12-accent);
}
.qz__blank {
  padding: 2px 0;
}
.qz__pending {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 9px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-warn-soft);
  color: #8a5a08;
  font-size: var(--k12-fs-micro);
  line-height: 1.5;
}
.qz__pending-dot {
  background: var(--k12-warn);
}
.qz__pending code {
  font-family: var(--k12-font-mono);
  font-size: 9px;
}

.qz__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 13px 13px;
}
.qz__xp {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.qz__submit {
  margin-left: auto;
  padding: 7px 12px;
  border: none;
  border-radius: var(--k12-r-md);
  background: var(--k12-accent);
  color: #fff;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
}
.qz__submit:disabled {
  background: var(--k12-border-strong);
  cursor: not-allowed;
}
.qz__done {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-good);
}
</style>
