<script setup lang="ts">
/**
 * 编程环境：左任务面板 + 右编程舞台。
 * 对齐画布「3. 编程环境」：顶栏 + 主体（任务面板 / 编程舞台）。
 *
 * ⚠️ Monaco / Pyodide 均未接入（用户决策）。代码区为高亮只读展示。
 * 接线时硬约束：学生代码**绝不在主进程执行**，必须经 IPC 交给渲染进程的 Pyodide Worker。
 */
import { computed, ref } from 'vue'
import { Play, Lightbulb, RotateCcw, CheckCircle2, FlaskConical, FileText } from 'lucide-vue-next'
import CodingCard from '@/cards/CodingCard.vue'
import { codeTemplate, codingHints } from '@/mocks'

const hintLevel = ref<0 | 1 | 2 | 3>(0)
const currentHint = computed(() => (hintLevel.value === 0 ? null : codingHints[hintLevel.value - 1] ?? null))

const tasks = [
  { id: 1, title: '把一组身高装进列表', done: true },
  { id: 2, title: '用 sum() 求和', done: true },
  { id: 3, title: '算出平均值并打印', done: false }
]
</script>

<template>
  <div class="code">
    <!-- 左：任务面板 -->
    <aside class="code__task">
      <header class="code__task-head">
        <FileText :size="14" />
        <span class="code__task-title">任务</span>
      </header>
      <h2 class="code__task-name">用列表装特征并求平均值</h2>
      <p class="code__task-desc">
        把一组身高装进列表，算出平均值。运行在本地 Pyodide Worker，代码不离开本机。
      </p>
      <div class="code__expect">
        <span class="code__expect-k">期望输出</span>
        <code class="code__expect-v">{{ codeTemplate.expectedBehavior }}</code>
      </div>

      <ul class="code__steps">
        <li v-for="t in tasks" :key="t.id" class="step" :class="{ 'step--done': t.done }">
          <CheckCircle2 v-if="t.done" :size="13" class="step__ico" />
          <span v-else class="step__dot" />
          <span class="step__text">{{ t.title }}</span>
        </li>
      </ul>

      <div class="code__hint-box">
        <header class="code__hb-head">
          <Lightbulb :size="13" />
          <span>分级求助</span>
          <span class="code__hb-level">{{ hintLevel }} / 3</span>
        </header>
        <p v-if="currentHint" class="code__hb-text">{{ currentHint.hint }}</p>
        <p v-else class="code__hb-text code__hb-text--idle">
          卡住时点「求助」，提示会一级一级给，不会一次把答案说满。
        </p>
        <button type="button" class="code__hb-btn" :disabled="hintLevel >= 3" @click="hintLevel = (hintLevel < 3 ? hintLevel + 1 : 3) as 1 | 2 | 3">
          给下一级提示
        </button>
      </div>

      <div class="code__safety">
        <FlaskConical :size="13" />
        <span>代码在独立 Worker 中执行，带超时中断；不与主进程共享环境。</span>
      </div>
    </aside>

    <!-- 右：编程舞台 -->
    <section class="code__stage">
      <header class="code__stage-head">
        <h2 class="code__stage-title">用列表装特征并求平均值</h2>
        <span class="code__stage-meta">Python · 本地执行</span>
        <button type="button" class="code__btn code__btn--ghost"><RotateCcw :size="13" /><span>重置</span></button>
        <button type="button" class="code__btn"><Play :size="13" /><span>运行</span></button>
      </header>

      <CodingCard />

      <div class="code__console">
        <span class="code__console-k">控制台</span>
        <span class="code__console-v">静态展示：本原型不执行代码</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.code {
  display: flex;
  height: 100%;
  min-height: 0;
}
.code__task {
  width: 300px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 14px;
  border-right: 1px solid var(--k12-border);
  background: var(--k12-glass-2);
  overflow-y: auto;
}
.code__task-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--k12-muted);
}
.code__task-title {
  font-size: var(--k12-fs-tiny);
  font-weight: 650;
}
.code__task-name {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}
.code__task-desc {
  font-size: var(--k12-fs-xs);
  line-height: 1.7;
  color: var(--k12-muted);
}
/* 期望输出应当是任务说明的一部分，不要拿它当标题 */
.code__expect {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
}
.code__expect-k {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-muted);
}
.code__expect-v {
  margin-left: auto;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-accent);
}
.code__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.step {
  display: flex;
  align-items: center;
  gap: 8px;
}
.step__ico {
  color: var(--k12-good);
  flex: none;
}
.step__dot {
  width: 13px;
  height: 13px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--k12-border-strong);
}
.step__text {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.step--done .step__text {
  color: var(--k12-muted);
  text-decoration: line-through;
}
.code__hint-box {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
}
.code__hb-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--k12-warn);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
}
.code__hb-level {
  margin-left: auto;
  color: #8a5a08;
}
.code__hb-text {
  font-size: var(--k12-fs-xs);
  line-height: 1.7;
  color: var(--k12-fg-2);
}
.code__hb-text--idle {
  color: var(--k12-muted);
}
.code__hb-btn {
  align-self: flex-start;
  padding: 6px 11px;
  border: 1px solid var(--k12-warn-border);
  border-radius: var(--k12-r-md);
  background: var(--k12-surface);
  color: #8a5a08;
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  cursor: pointer;
}
.code__hb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.code__safety {
  display: flex;
  gap: 7px;
  padding: 9px 10px;
  border-radius: var(--k12-r-xl);
  background: var(--k12-good-soft);
  color: #0b7a57;
  font-size: var(--k12-fs-micro);
  line-height: 1.6;
}

.code__stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 18px;
  overflow-y: auto;
}
.code__stage-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.code__stage-title {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}
.code__stage-meta {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
  flex: 1;
}
.code__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: none;
  border-radius: var(--k12-r-md);
  background: var(--k12-accent);
  color: #fff;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
  flex: none;
}
.code__btn--ghost {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  color: var(--k12-fg-2);
}
.code__console {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--k12-r-xl);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
}
.code__console-k {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-muted);
}
.code__console-v {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
</style>
