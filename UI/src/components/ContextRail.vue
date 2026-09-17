<script setup lang="ts">
/**
 * 右侧栏：三页签（学习上下文 / 工具调用 / 学段）。
 * 设计稿宽 272px。
 *
 * 这一栏是答辩的「设计合理性」证据区：
 *  - 四级降级链（vector → cloud → fts → outline）来自 Python 单次调用，TS 只读结果；
 *  - 学段隔离在 SQL 层强制（模型改不了 WHERE）；
 *  - 工具调用轨迹服务 25% 设计分（票 08 产出）。
 */
import { computed, ref } from 'vue'
import { BookOpen, Sparkles, Route, GitBranch, TrendingUp, Info } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import {
  degradeChain,
  isolationNotice,
  mastery,
  kpNames,
  recommendation,
  toolTrace,
  traceNote,
  student
} from '@/mocks'

type TabKey = 'context' | 'tools' | 'grade'
const tab = ref<TabKey>('context')
const router = useRouter()

const tabs: { key: TabKey; label: string }[] = [
  { key: 'context', label: '学习上下文' },
  { key: 'tools', label: '工具调用' },
  { key: 'grade', label: '学段' }
]

const masteryRows = computed(() =>
  mastery.map((m) => ({
    ...m,
    name: kpNames[m.kpId] ?? m.kpId,
    percent: Math.round(m.score * 100)
  }))
)

/** 工具名 → 中文说明与事件 kind（与 §9.3 映射表一致） */
const TOOL_META: Record<string, { label: string; kind: string }> = {
  rag_search: { label: '教材检索', kind: 'citation' },
  generate_animation: { label: '生成动画', kind: 'animation' },
  get_code_template: { label: '取编程模板', kind: 'coding' },
  get_coding_hint: { label: '分级求助', kind: 'coding' },
  evaluate_code: { label: '代码评估', kind: 'coding' },
  generate_quiz: { label: '生成练习', kind: 'quiz' },
  submit_quiz: { label: '提交批改', kind: 'quiz' },
  generate_variants: { label: '变式题', kind: 'quiz' }
}

function toolKind(name: string) {
  return TOOL_META[name]?.kind ?? '—'
}
</script>

<template>
  <aside class="rail">
    <!-- 页签 -->
    <div class="rail__tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        class="rail__tab"
        :class="{ 'rail__tab--on': tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- ① 学习上下文 -->
    <template v-if="tab === 'context'">
      <section class="rail__card rail__card--retrieval">
        <header class="rail__card-head">
          <span class="rail__card-title">本轮检索</span>
          <span class="rail__card-meta">4 级降级链</span>
        </header>
        <div v-for="step in degradeChain" :key="step.key" class="rail__chain-row">
          <span class="k12-dot" :class="step.active ? 'rail__dot-on' : 'rail__dot-off'" />
          <span class="rail__chain-label" :class="{ 'rail__chain-label--off': !step.active }">
            {{ step.label }}
          </span>
          <span class="rail__chain-state" :class="{ 'rail__chain-state--on': step.active }">
            {{ step.state }}
          </span>
        </div>
        <div class="rail__isolation">
          <BookOpen :size="13" />
          <span>{{ isolationNotice.text }}</span>
        </div>
      </section>

      <section class="rail__sec">
        <Sparkles :size="13" />
        <span class="rail__sec-label">当前知识点掌握度</span>
      </section>
      <div class="rail__mastery">
        <div v-for="row in masteryRows" :key="row.kpId" class="rail__m">
          <div class="rail__m-row">
            <span class="rail__m-name">{{ row.name }}</span>
            <span class="rail__m-pct" :data-level="row.percent >= 70 ? 'high' : row.percent >= 40 ? 'mid' : 'low'">
              {{ row.percent }}%
            </span>
          </div>
          <div class="rail__track">
            <span
              class="rail__fill"
              :data-level="row.percent >= 70 ? 'high' : row.percent >= 40 ? 'mid' : 'low'"
              :style="{ width: `${row.percent}%` }"
            />
          </div>
        </div>
      </div>

      <section class="rail__sec">
        <Route :size="13" />
        <span class="rail__sec-label">推荐下一步</span>
      </section>
      <div class="rail__reco">
        <span class="rail__pill">
          <GitBranch :size="10" />
          <span>依赖图前置已满足</span>
        </span>
        <p class="rail__reco-title">{{ recommendation.kpName }}</p>
        <p class="rail__reco-desc">{{ recommendation.reason }}</p>
        <button type="button" class="rail__reco-btn" @click="router.push(recommendation.targetRoute)">
          <TrendingUp :size="13" />
          <span>{{ recommendation.ctaLabel }}</span>
        </button>
      </div>
    </template>

    <!-- ② 工具调用轨迹 -->
    <template v-else-if="tab === 'tools'">
      <section class="rail__sec rail__sec--flush">
        <Route :size="13" />
        <span class="rail__sec-label">本轮工具调用轨迹</span>
        <span class="rail__sec-meta">{{ toolTrace.length }} 次</span>
      </section>
      <div class="rail__trace">
        <div v-for="t in toolTrace" :key="t.toolName" class="rail__t">
          <div class="rail__t-head">
            <span class="k12-dot" :class="t.ok ? 'rail__dot-on' : 'rail__dot-bad'" />
            <code class="rail__t-name">{{ t.toolName }}</code>
            <span class="rail__t-kind">{{ toolKind(t.toolName) }}</span>
            <span class="rail__t-ms">{{ t.latencyMs }}ms</span>
          </div>
          <p class="rail__t-args">{{ t.argsSummary }}</p>
        </div>
      </div>
      <div v-if="toolTrace.some((t) => t.degraded && t.degraded !== 'vector')" class="rail__warn">
        存在降级命中，结果已标注 degraded
      </div>
      <div class="rail__note">
        <Info :size="13" />
        <span>{{ traceNote }}</span>
      </div>
    </template>

    <!-- ③ 学段：只读 -->
    <template v-else>
      <section class="rail__sec rail__sec--flush">
        <Sparkles :size="13" />
        <span class="rail__sec-label">学段判定</span>
        <span class="rail__sec-meta">自动 · 只读</span>
      </section>
      <div class="rail__grade">
        <div class="rail__g-row">
          <span class="rail__g-k">当前学段</span>
          <span class="rail__g-v">{{ student.gradeLevel === 'junior' ? '初中' : student.gradeLevel }}</span>
        </div>
        <div class="rail__g-row">
          <span class="rail__g-k">判定来源</span>
          <span class="rail__g-v">服务端推断（inferred）</span>
        </div>
        <p class="rail__g-note">
          学段由系统根据对话信号自动判定，学生端没有选择入口，也不需要确认。
        </p>
      </div>
      <div class="rail__note">
        <Info :size="13" />
        <span>置信度不足时保持当前学段；单次最多调整一级，调整后进入冷却期。</span>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.rail {
  width: var(--k12-w-rail);
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 13px 14px 14px;
  background: var(--k12-surface);
  border-left: 1px solid var(--k12-border);
  overflow-y: auto;
}

.rail__tabs {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
}
.rail__tab {
  flex: 1;
  padding: 6px 0;
  border: none;
  border-radius: var(--k12-r-md);
  background: transparent;
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}
.rail__tab--on {
  background: var(--k12-surface);
  color: var(--k12-accent);
  font-weight: 650;
}

.rail__card {
  padding: 12px;
  border-radius: var(--k12-r-3xl);
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.rail__card--retrieval {
  background: color-mix(in srgb, var(--k12-accent) 5%, #fff);
  border: 1px solid var(--k12-accent-border);
}
.rail__card-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.rail__card-title {
  font-size: var(--k12-fs-sm-2);
  font-weight: 650;
  color: var(--k12-fg);
}
.rail__card-meta {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.rail__chain-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.rail__dot-on {
  background: var(--k12-good);
}
.rail__dot-off {
  background: var(--k12-muted-2);
}
.rail__dot-bad {
  background: var(--k12-bad);
}
.rail__chain-label {
  flex: 1;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.rail__chain-label--off {
  color: var(--k12-muted-2);
}
.rail__chain-state {
  font-size: var(--k12-fs-micro);
  font-weight: 600;
  color: var(--k12-muted-2);
}
.rail__chain-state--on {
  color: var(--k12-good);
}
.rail__isolation {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 9px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-good-soft);
  color: #0b7a57;
  font-size: var(--k12-fs-tiny);
  font-weight: 550;
  line-height: 1.5;
}

.rail__sec {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 0 4px;
  color: var(--k12-muted);
}
.rail__sec--flush {
  padding: 0;
}
.rail__sec-label {
  font-size: var(--k12-fs-tiny);
  font-weight: 650;
  color: var(--k12-muted);
}
.rail__sec-meta {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}

.rail__mastery {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rail__m {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rail__m-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rail__m-name {
  flex: 1;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.rail__m-pct {
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.rail__m-pct[data-level='high'] {
  color: var(--k12-good);
}
.rail__m-pct[data-level='mid'] {
  color: var(--k12-warn);
}
.rail__m-pct[data-level='low'] {
  color: var(--k12-bad);
}
.rail__track {
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.rail__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent);
}
.rail__fill[data-level='high'] {
  background: var(--k12-good);
}
.rail__fill[data-level='mid'] {
  background: var(--k12-warn);
}
.rail__fill[data-level='low'] {
  background: var(--k12-bad);
}

.rail__reco {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.rail__pill {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}
.rail__reco-title {
  font-size: var(--k12-fs-md);
  font-weight: 650;
  color: var(--k12-fg);
}
.rail__reco-desc {
  font-size: var(--k12-fs-xs);
  line-height: 1.7;
  color: var(--k12-muted);
}
.rail__reco-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  padding: 8px 0;
  border: none;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.16s ease;
}
.rail__reco-btn:hover {
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
}

.rail__trace {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 0 2px 2px;
}
.rail__t {
  padding-left: 11px;
  border-left: 2px solid var(--k12-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rail__t-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rail__t-name {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
  color: var(--k12-fg);
}
.rail__t-kind {
  padding: 1px 6px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-size: 8.5px;
  font-weight: 650;
}
.rail__t-ms {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
  font-variant-numeric: tabular-nums;
}
.rail__t-args {
  font-family: var(--k12-font-mono);
  font-size: 9px;
  line-height: 1.6;
  color: var(--k12-muted);
  word-break: break-all;
}
.rail__warn {
  padding: 8px 9px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-warn-soft);
  color: #8a5a08;
  font-size: var(--k12-fs-micro);
}
.rail__note {
  display: flex;
  gap: 7px;
  padding: 8px 9px;
  border-radius: var(--k12-r-xl);
  background: #f7f9fd;
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  line-height: 1.6;
}

.rail__grade {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.rail__g-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rail__g-k {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.rail__g-v {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg);
}
.rail__g-note {
  font-size: var(--k12-fs-micro);
  line-height: 1.7;
  color: var(--k12-muted);
}
</style>
