<script setup lang="ts">
/**
 * 编程环境内联/独立卡。
 *
 * ⚠️ 引擎不接（用户决策）：**不引入 Monaco、不加载 Pyodide**。
 * 代码区是带语法着色的只读展示，运行结果为静态 mock。
 *
 * 接线时的两条硬约束（别忘）：
 *  1. 学生代码**绝不在主进程执行**：`evaluate_code` 必须经 IPC 交给渲染进程的
 *     Pyodide Worker，结果回传（每条都要有架构守卫测试）；
 *  2. 报错感知 + 分级求助走 `CodingHint.level` 1→2→3 递进，不要一次给满。
 */
import { computed, ref } from 'vue'
import { Play, Lightbulb, RotateCcw, Maximize2, CheckCircle2, AlertTriangle } from 'lucide-vue-next'
import { codeTemplate, codingHints, codeRunResult } from '@/mocks'

const code = ref(codeTemplate.scaffold)
const hintLevel = ref<0 | 1 | 2 | 3>(0)
const ran = ref(false)

const currentHint = computed(() =>
  hintLevel.value === 0 ? null : codingHints[hintLevel.value - 1] ?? null
)

/** 极简 Python 语法着色：仅用于展示（不引入高亮库，避免为样稿增加依赖） */
const highlighted = computed(() =>
  code.value
    .split('\n')
    .map((line) => {
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return escaped
        .replace(/(#[^\n]*)/g, '<span class="tk-c">$1</span>')
        .replace(/\b(heights|total|avg|len|sum|print)\b/g, '<span class="tk-f">$1</span>')
        .replace(/\b(\d+)\b/g, '<span class="tk-n">$1</span>')
    })
    .join('\n')
)

function run() {
  ran.value = true
}

function reset() {
  code.value = codeTemplate.scaffold
  ran.value = false
  hintLevel.value = 0
}

function askHint() {
  if (hintLevel.value < 3) hintLevel.value = (hintLevel.value + 1) as 1 | 2 | 3
}
</script>

<template>
  <div class="cd">
    <div class="cd__head">
      <span class="cd__tag">编程</span>
      <div class="cd__head-text">
        <p class="cd__title">用列表装特征并求平均值</p>
        <p class="cd__meta">Python · Pyodide Worker（本原型未接入运行引擎）</p>
      </div>
      <button type="button" class="cd__icon" title="全屏"><Maximize2 :size="13" /></button>
    </div>

    <!-- 任务说明 -->
    <div class="cd__task">
      <span class="cd__task-k">期望行为</span>
      <span class="cd__task-v">{{ codeTemplate.expectedBehavior }}</span>
    </div>

    <!-- 编辑区：只读展示，避免误导为可执行 -->
    <div class="cd__editor">
      <div class="cd__gutter" aria-hidden="true">
        <span v-for="(_, i) in code.split('\n')" :key="i">{{ i + 1 }}</span>
      </div>
      <pre class="cd__code" v-html="highlighted" />
    </div>

    <!-- 运行结果 -->
    <div v-if="ran" class="cd__out">
      <div class="cd__out-head">
        <CheckCircle2 :size="13" class="cd__ok" />
        <span class="cd__out-title">输出</span>
        <span class="cd__out-stdout">{{ codeRunResult.stdout }}</span>
      </div>
      <p class="cd__feedback">{{ codeRunResult.feedback }}</p>
    </div>

    <!-- 分级求助：level 1 → 2 → 3 递进，不要一次给满 -->
    <div v-if="currentHint" class="cd__hint">
      <Lightbulb :size="13" class="cd__hint-ico" />
      <div>
        <p class="cd__hint-level">提示 {{ currentHint.level }} / 3</p>
        <p class="cd__hint-text">{{ currentHint.hint }}</p>
      </div>
    </div>

    <div class="cd__foot">
      <button type="button" class="cd__btn cd__btn--primary" @click="run">
        <Play :size="13" /><span>运行</span>
      </button>
      <button type="button" class="cd__btn" @click="askHint" :disabled="hintLevel >= 3">
        <Lightbulb :size="13" /><span>求助</span>
      </button>
      <button type="button" class="cd__btn cd__btn--ghost" @click="reset">
        <RotateCcw :size="13" /><span>重置</span>
      </button>
      <span class="cd__note"><AlertTriangle :size="12" /> 本原型不执行代码</span>
    </div>
  </div>
</template>

<style scoped>
.cd {
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
  overflow: hidden;
}

.cd__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 13px;
}
.cd__tag {
  padding: 3px 8px;
  border-radius: var(--k12-r-sm);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-size: var(--k12-fs-micro);
  font-weight: 700;
  flex: none;
}
.cd__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cd__title {
  font-size: var(--k12-fs-base);
  font-weight: 650;
  color: var(--k12-fg);
}
.cd__meta {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.cd__icon {
  border: none;
  background: transparent;
  color: var(--k12-muted-2);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--k12-r-sm);
  display: inline-flex;
  flex: none;
}
.cd__icon:hover {
  background: var(--k12-surface-2);
}

.cd__task {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 13px 10px;
  padding: 8px 10px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-accent-soft);
}
.cd__task-k {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-chip-fg);
}
.cd__task-v {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}

.cd__editor {
  display: flex;
  margin: 0 13px;
  border-radius: var(--k12-r-2xl);
  background: var(--k12-fg);
  overflow: hidden;
}
.cd__gutter {
  display: flex;
  flex-direction: column;
  padding: 12px 8px;
  background: color-mix(in srgb, #000 18%, var(--k12-fg));
  color: #5b6482;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  line-height: 1.75;
  text-align: right;
  user-select: none;
}
.cd__code {
  flex: 1;
  margin: 0;
  padding: 12px 14px;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  line-height: 1.75;
  color: #dbe2f5;
  white-space: pre;
  overflow-x: auto;
}
.cd__code :deep(.tk-c) {
  color: #7f8bb0;
  font-style: italic;
}
.cd__code :deep(.tk-f) {
  color: #8ab4ff;
}
.cd__code :deep(.tk-n) {
  color: #ffc98a;
}

.cd__out {
  margin: 10px 13px 0;
  padding: 9px 11px;
  border-radius: var(--k12-r-xl);
  background: var(--k12-good-soft);
}
.cd__out-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.cd__ok {
  color: var(--k12-good);
  flex: none;
}
.cd__out-title {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: #0b7a57;
}
.cd__out-stdout {
  margin-left: auto;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg);
}
.cd__feedback {
  margin-top: 5px;
  font-size: var(--k12-fs-xs);
  line-height: 1.6;
  color: var(--k12-fg-2);
}

.cd__hint {
  display: flex;
  gap: 8px;
  margin: 10px 13px 0;
  padding: 9px 11px;
  border-radius: var(--k12-r-xl);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
}
.cd__hint-ico {
  color: var(--k12-warn);
  flex: none;
  margin-top: 1px;
}
.cd__hint-level {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: #8a5a08;
}
.cd__hint-text {
  margin-top: 2px;
  font-size: var(--k12-fs-xs);
  line-height: 1.6;
  color: var(--k12-fg-2);
}

.cd__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 13px;
}
.cd__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-md);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
.cd__btn:hover:not(:disabled) {
  border-color: var(--k12-accent-border);
}
.cd__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.cd__btn--primary {
  background: var(--k12-accent);
  border-color: var(--k12-accent);
  color: #fff;
}
.cd__btn--ghost {
  border-color: transparent;
  background: transparent;
}
.cd__note {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
</style>
