<script setup lang="ts">
/**
 * 右侧栏：三页签（学习上下文 / 工具调用 / 学段）。
 *
 * 这一栏是答辩的「设计合理性」证据区：
 *  - 四级降级链（vector → cloud → fts → outline）来自 Python 单次调用，TS 只读结果；
 *  - 学段隔离在 SQL 层强制（模型改不了 WHERE）；
 *  - 工具调用轨迹服务 25% 设计分（票 08 产出）。
 *
 * 响应式：≥1280px 是常驻栏（`open` 控制显隐）；<1280px 变成浮层面板 + 遮罩，
 * 点遮罩即关。判断放在 CSS 里，`open` 由 ChatView 持有 —— 组件自己不去监听窗口，
 * 免得同一份断点逻辑在两个地方各写一遍。
 *
 * 控件换成 Element Plus：页签用 `el-segmented`（原来的三段手写按钮没有键盘语义，
 * 也没有 aria 状态），掌握度条用 `el-progress`（同一套进度条此前在 7 个文件里
 * 各手写了一遍）。工具轨迹按「轮次」用 `el-collapse` 折叠 —— 一轮里的工具调用
 * 可能十几条，平铺会把学段页挤到屏幕外。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, Sparkles, Route, GitBranch, TrendingUp, Info, X, Radar } from 'lucide-vue-next'
import EmptyState from '@/components/EmptyState.vue'
import { useThemeStore } from '@/stores/theme'
import {
  degradeChain,
  isolationNotice,
  mastery,
  kpNames,
  recommendation,
  toolTrace,
  traceNote
} from '@/mocks'
import { useEscape } from '@/composables/useEscape'

const theme = useThemeStore()

/**
 * 知识点详情（二级界面）。
 * 掌握度行此前是**不可点的 div** —— 学生看到"决策树 42%"却点不开，
 * 不知道这 42% 是怎么来的、还能做什么。
 */
const kpDetail = ref<string | null>(null)
const kpMastery = computed(() => mastery.find((m) => m.kpId === kpDetail.value) ?? null)

const props = withDefaults(defineProps<{ open?: boolean }>(), { open: true })
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

type TabKey = 'context' | 'tools' | 'grade'
const tab = ref<TabKey>('context')
const router = useRouter()

/** el-segmented 的选项形态（label 给学生看，value 给代码用） */
const TABS = [
  { label: '学习上下文', value: 'context' },
  { label: '工具调用', value: 'tools' },
  { label: '学段', value: 'grade' }
]

const masteryRows = computed(() =>
  mastery.map((m) => {
    const percent = Math.round(m.score * 100)
    return {
      ...m,
      name: kpNames[m.kpId] ?? m.kpId,
      percent,
      level: percent >= 70 ? 'high' : percent >= 40 ? 'mid' : 'low'
    }
  })
)

const LEVEL_COLOR: Record<string, string> = {
  high: 'var(--k12-good)',
  mid: 'var(--k12-warn)',
  low: 'var(--k12-bad)'
}

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

/** 轨迹按轮次分组：一轮里的工具调用有序列关系，跨轮没有 */
const traceGroups = computed(() => {
  const byTurn = new Map<number, typeof toolTrace>()
  for (const t of toolTrace) {
    const list = byTurn.get(t.turn) ?? []
    list.push(t)
    byTurn.set(t.turn, list)
  }
  return [...byTurn.entries()].map(([turn, items]) => ({ turn, items }))
})

const hasDegraded = computed(() => toolTrace.some((t) => t.degraded && t.degraded !== 'vector'))

function close() {
  emit('update:open', false)
}
/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => { kpDetail.value = null }, () => !!kpDetail.value)
</script>

<template>
  <!-- 窄屏遮罩：点空白即关（只在浮层模式下渲染，由 CSS 控制显隐） -->
  <div v-if="props.open" class="rail__scrim" @click="close" />

  <aside v-show="props.open" class="rail">
    <div class="rail__head">
      <el-segmented v-model="tab" :options="TABS" size="small" block class="rail__tabs" />
      <button type="button" class="rail__close" title="收起" @click="close">
        <X :size="15" />
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
          <BookOpen :size="14" />
          <span>{{ isolationNotice.text }}</span>
        </div>
      </section>

      <section class="rail__sec">
        <Sparkles :size="14" />
        <span class="rail__sec-label">当前知识点掌握度</span>
      </section>
      <div class="rail__mastery">
        <!-- 可点开知识点详情：审计指出这些行"看起来像列表行但不可交互" -->
        <button
          v-for="row in masteryRows"
          :key="row.kpId"
          type="button"
          class="rail__m"
          :title="`查看「${row.name}」详情`"
          @click="kpDetail = row.kpId"
        >
          <span class="rail__m-row">
            <span class="rail__m-name">{{ row.name }}</span>
            <span class="rail__m-pct" :style="{ color: LEVEL_COLOR[row.level] }">
              {{ row.percent }}%
            </span>
          </span>
          <el-progress
            :percentage="row.percent"
            :stroke-width="6"
            :show-text="false"
            :color="LEVEL_COLOR[row.level]"
          />
        </button>
      </div>

      <section class="rail__sec">
        <Route :size="14" />
        <span class="rail__sec-label">推荐下一步</span>
      </section>
      <div class="rail__reco">
        <span class="rail__pill">
          <GitBranch :size="11" />
          <span>依赖图前置已满足</span>
        </span>
        <p class="rail__reco-title">{{ recommendation.kpName }}</p>
        <p class="rail__reco-desc">{{ recommendation.reason }}</p>
        <button type="button" class="rail__reco-btn" @click="router.push(recommendation.targetRoute)">
          <TrendingUp :size="14" />
          <span>{{ recommendation.ctaLabel }}</span>
        </button>
      </div>
    </template>

    <!-- ② 工具调用轨迹 -->
    <template v-else-if="tab === 'tools'">
      <section class="rail__sec rail__sec--flush">
        <Route :size="14" />
        <span class="rail__sec-label">本轮工具调用轨迹</span>
        <span class="rail__sec-meta">{{ toolTrace.length }} 次</span>
      </section>

      <EmptyState
        v-if="!toolTrace.length"
        title="本轮还没有工具调用"
        desc="主 Agent 会按需调用教材检索、动画生成、练习生成等 Tool，调用记录会显示在这里。"
      />

      <el-collapse v-else class="rail__collapse">
        <el-collapse-item
          v-for="g in traceGroups"
          :key="g.turn"
          :name="g.turn"
          :title="`第 ${g.turn} 轮 · ${g.items.length} 次调用`"
        >
          <div class="rail__trace">
            <div v-for="t in g.items" :key="t.toolName" class="rail__t">
              <div class="rail__t-head">
                <span class="k12-dot" :class="t.ok ? 'rail__dot-on' : 'rail__dot-bad'" />
                <code class="rail__t-name">{{ t.toolName }}</code>
                <span class="rail__t-tag">{{ toolKind(t.toolName) }}</span>
                <span class="rail__t-ms">{{ t.latencyMs }}ms</span>
              </div>
              <p class="rail__t-args">{{ t.argsSummary }}</p>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>

      <div v-if="hasDegraded" class="rail__warn">存在降级命中，结果已标注 degraded</div>
      <div class="rail__note">
        <Info :size="14" />
        <span>{{ traceNote }}</span>
      </div>
    </template>

    <!-- ③ 学段：只读 -->
    <template v-else>
      <section class="rail__sec rail__sec--flush">
        <Sparkles :size="14" />
        <span class="rail__sec-label">学段判定</span>
        <span class="rail__sec-meta">自动 · 只读</span>
      </section>
      <div class="rail__grade">
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="当前学段">
            {{ theme.displayGradeMeta.label }}
          </el-descriptions-item>
          <el-descriptions-item label="判定来源">服务端推断（inferred）</el-descriptions-item>
        </el-descriptions>
        <p class="rail__g-note">
          学段由系统根据对话信号自动判定，学生端没有选择入口，也不需要确认。
        </p>
      </div>
      <div class="rail__note">
        <Info :size="14" />
        <span>置信度不足时保持当前学段；单次最多调整一级，调整后进入冷却期。</span>
      </div>
    </template>

    <!-- 知识点详情（二级界面）：掌握度从哪来、还能做什么 -->
    <Teleport to="body">
      <div v-if="kpDetail" class="kd" role="dialog" aria-modal="true" @click.self="kpDetail = null">
        <aside class="kd__panel">
          <header class="kd__head">
            <Radar :size="16" />
            <div class="kd__head-text">
              <p class="kd__title">{{ kpNames[kpDetail] ?? kpDetail }}</p>
              <code class="kd__id">{{ kpDetail }}</code>
            </div>
            <button type="button" class="kd__close" title="关闭" @click="kpDetail = null">
              <X :size="16" />
            </button>
          </header>

          <div class="kd__body">
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="掌握度">
                {{ kpMastery ? Math.round(kpMastery.score * 100) + '%' : '暂无记录' }}
              </el-descriptions-item>
              <el-descriptions-item label="答题情况">
                {{ kpMastery ? `${kpMastery.correct} / ${kpMastery.attempts} 题` : '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="最近练习">
                {{ kpMastery?.lastSeenAt ? new Date(kpMastery.lastSeenAt * 1000).toLocaleDateString('zh-CN') : '—' }}
              </el-descriptions-item>
            </el-descriptions>

            <p class="kd__note">
              掌握度由每次答题的 <code>masteryDelta</code> 累加而来，单次变化限幅 ±0.2；
              答对 +0.15、答错 −0.10（与后端 <code>quiz.py</code> 的常量一致）。
            </p>

            <div class="kd__actions">
              <el-button type="primary" @click="router.push('/app/quiz'); kpDetail = null">
                去闯关检验
              </el-button>
              <el-button @click="router.push('/app/dependency'); kpDetail = null">
                看依赖关系
              </el-button>
            </div>
          </div>
        </aside>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.rail {
  --el-box-shadow-light: none;
  --el-box-shadow: var(--k12-shadow-float);

  width: var(--k12-w-rail);
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 16px;
  /* 右栏同属结构层：实色桌面，与正文工作面（方格纸）区分 */
  background: var(--k12-surface);
  border-left: 1px solid var(--k12-border);
  overflow-y: auto;
  color: var(--k12-fg);
}

.rail__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rail__tabs {
  flex: 1;
  min-width: 0;
}
/* 关闭键只在浮层模式下有意义（常驻栏直接用顶栏那个开关） */
.rail__close {
  display: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
.rail__close:hover {
  color: var(--k12-fg-2);
}
}
.rail__scrim {
  display: none;
}

/* ── 卡片与分区 ───────────────────────────────────────────────────────── */
.rail__card {
  padding: 13px;
  border-radius: var(--k12-r-card);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail__card--retrieval {
  background: var(--k12-accent-soft);
  border: 1px solid var(--k12-accent-border);
}
.rail__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rail__card-title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
/* 「4 级降级链」是这条卡片的说明性 meta，不是角标 */
.rail__card-meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.rail__chain-row {
  display: flex;
  align-items: center;
  gap: 8px;
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
  min-width: 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.rail__chain-label--off {
  color: var(--k12-muted);
}
/* 「命中 / 未启用」是降级链每行的**键值**（值），不是角上的记号 */
.rail__chain-state {
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-muted);
  flex: none;
}
.rail__chain-state--on {
  color: var(--k12-good);
}
/* 卡中卡：内层换实色，不与外层浅底叠透明度 */
.rail__isolation {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--k12-r-control);
  background: var(--k12-good-soft);
  color: var(--k12-good);
  font-size: var(--k12-fs-xs);
  font-weight: 550;
  line-height: var(--k12-lh-ui);
}

.rail__sec {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  color: var(--k12-muted);
}
.rail__sec--flush {
  padding: 0;
}
.rail__sec-label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 分区标题右侧的计数（「4 次」/「自动 · 只读」）：是 meta，不是角标 */
.rail__sec-meta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ── 掌握度 ───────────────────────────────────────────────────────────── */
.rail__mastery {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail__m {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 4px 5px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .rail__m:hover {
    background: var(--k12-surface-2);
  }
}
/* 行内元素从 div 变成 span：放进 button 里不能有块级祖先链断裂 */
.rail__m-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ── 知识点详情抽屉 ──────────────────────────────────────────────────── */
.kd {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--k12-fg) 30%, transparent);
}
.kd__panel {
  width: min(420px, 92vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--k12-surface);
  border-left: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-float);
}
.kd__head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--k12-border);
  color: var(--k12-muted);
}
.kd__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kd__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
/* 知识点 id（`kp_decision_tree`）：是要被读懂的**代码标识**，不是角标 */
.kd__id {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.kd__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .kd__close:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg-2);
  }
}
.kd__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.kd__note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
/* 注释里的行内代码（`masteryDelta` / `quiz.py`）：与所在正文同档（12px），
 * 靠 mono 字体与底色区分，不靠缩小字号 —— 缩了就成了「比正文还轻的注脚」。 */
.kd__note code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 5px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.kd__actions {
  display: flex;
  gap: 10px;
}
.rail__m-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rail__m-name {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 掌握度百分比（「42%」）：是列表行的**键值**（值），行名在左、值在右，
 * 两半必须同权，否则「42%」会看成行名的脚注。 */
.rail__m-pct {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  flex: none;
}

/* ── 推荐 ─────────────────────────────────────────────────────────────── */
.rail__reco {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px;
}
.rail__pill {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}
.rail__reco-title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.rail__reco-desc {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.rail__reco-btn {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  padding: 9px 0;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
.rail__reco-btn:hover {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}
}

/* ── 轨迹 ─────────────────────────────────────────────────────────────── */
.rail__collapse {
  border: none;
}
.rail__trace {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail__t {
  padding-left: 12px;
  border-left: 2px solid var(--k12-border);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rail__t-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
/* 工具名（`rag_search` / `evaluate_code`）：是这一行的**主体识别信息**。 */
.rail__t-name {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg);
}
/* 工具类别 chip（citation / animation / coding / quiz）：填充底 + 小圆角的
 * 分类记号，11px（角标档）。它与工具名同处一行，必须明确比工具名（12px）轻一档。 */
.rail__t-tag {
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
}
/* 延迟（「412ms」）：单位数值，与工具名同行的 meta */
.rail__t-ms {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
}
/* 工具调用参数摘要：内容是**要读懂的一段文本**（不是角标） */
.rail__t-args {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
  word-break: break-all;
}
.rail__warn {
  padding: 9px 10px;
  border-radius: var(--k12-r-control);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
}
.rail__note {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  display: flex;
  gap: 8px;
  padding: 9px 10px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
}
.rail__note svg {
  flex: none;
  margin-top: 2px;
}

.rail__grade {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail__g-note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

/* ── 窄窗口：变浮层 ───────────────────────────────────────────────────── */
@media (max-width: 1279px) {
  .rail {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    width: min(340px, 86vw);
    box-shadow: var(--k12-shadow-float);
    border-left-color: var(--k12-border);
  }
  .rail__close {
    display: inline-flex;
  }
  .rail__scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 19;
    background: color-mix(in srgb, var(--k12-fg) 26%, transparent);
  }
}
</style>
