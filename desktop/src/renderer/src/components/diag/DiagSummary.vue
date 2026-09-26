<script setup lang="ts">
/**
 * 一轮的**摘要**（演示浮窗与演示页顶部共用同一个组件）。
 *
 * ★ 五条固定摘要 + 一条拦截记录 —— 顺序与措辞在两处**必须一致**：
 *   浮窗说「Prompt 2,847 tok」，演示页就得说同一件事（同一份数据、同一个格式化函数）。
 *   各写一份渲染就会漂移成「浮窗 3 次调用、演示页 4 次」这种对不上的场面。
 *
 * ⚠️ 本组件**只渲染教师 / 演示面**的内容（技术口径的原值）。调用方必须保证它只在
 *   `<TeacherGate>` 之内或演示页里出现 —— 学生视角看不到它（守卫钉着两条通路）。
 */
import { computed } from 'vue'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL } from '../../labels'
import type { TurnDiagnostics } from '@shared/diagnostics'

const props = defineProps<{
  /** 要展示的那一轮（`null` = 还没有任何一轮）。 */
  turn: TurnDiagnostics | null
}>()

const gradeLabel = computed(() =>
  props.turn ? (GRADE_LABELS[props.turn.grade.applied] ?? GRADE_UNKNOWN_LABEL) : GRADE_UNKNOWN_LABEL
)

/** 工具一行的摘要：`rag_search 142ms ✓ · evaluate_code 890ms ✗`。 */
const toolLine = computed(() => {
  const tools = props.turn?.tools ?? []
  if (tools.length === 0) return '这一轮没有调用工具'
  return tools
    .map((tool) => `${tool.name} ${Math.round(tool.latencyMs)}ms ${tool.ok ? '✓' : '✗'}`)
    .join(' · ')
})

/** 安全三阶段：`入口 ✓ · 流式 ✓ · 终审 ✓`。 */
const safetyLine = computed(() => {
  const stages = props.turn?.safetyFinal.stages ?? []
  if (stages.length === 0) return '未记录'
  const mark = (verdict: string): string => (verdict === 'pass' ? '✓' : verdict === 'blocked' ? '✗' : '—')
  const label: Record<string, string> = { input: '入口', stream: '流式', final: '终审' }
  return stages.map((stage) => `${label[stage.stage] ?? stage.stage} ${mark(stage.verdict)}`).join(' · ')
})

const hashLine = computed(() => {
  const context = props.turn?.studentContext
  if (!context?.injected) return '本轮没有注入画像'
  return `${context.byteHash} ${context.sameAsPrev ? '与上轮逐字节相同' : '与上轮不同'}`
})
</script>

<template>
  <dl class="sum" data-testid="diag-summary">
    <div class="sum__row">
      <dt>Prompt</dt>
      <dd>
        <template v-if="turn">{{ turn.prompt.totalTokens }} tok · {{ turn.prompt.segments.length }} 段</template>
        <template v-else>还没有数据</template>
      </dd>
    </div>
    <div class="sum__row">
      <dt>学段</dt>
      <dd>
        <template v-if="turn">
          {{ gradeLabel }} · {{ turn.grade.decidedBy ?? '待判定' }} · 累计 {{ turn.grade.cumulativeTurns }} 轮
        </template>
        <template v-else>还没有数据</template>
      </dd>
    </div>
    <div class="sum__row">
      <dt>画像 hash</dt>
      <dd>{{ hashLine }}</dd>
    </div>
    <div class="sum__row">
      <dt>工具</dt>
      <dd>{{ toolLine }}</dd>
    </div>
    <div class="sum__row">
      <dt>安全</dt>
      <dd>{{ safetyLine }}</dd>
    </div>
    <div v-if="turn && turn.interceptions.length > 0" class="sum__row sum__row--block">
      <dt>拦截</dt>
      <dd>{{ turn.interceptions.map((item) => item.reason).join('；') }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.sum {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 10px 12px;
}
.sum__row {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.sum__row dt {
  flex: none;
  width: 72px;
  font-size: var(--k12-fs-label);
  font-weight: 650;
  color: var(--k12-muted);
}
.sum__row dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
  word-break: break-word;
}
/* 拦截那一行是重点：它证明「规则在跑」，用警示底把视线拉过去 */
.sum__row--block dd {
  color: var(--k12-warn);
}
</style>
