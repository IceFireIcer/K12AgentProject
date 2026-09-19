<script setup lang="ts">
/**
 * 右侧栏：三页签（学习上下文 / 工具调用 / 学段）。
 *
 * 这一栏是答辩的「设计合理性」证据区 —— 三页签各自对着一条硬约束：
 *
 *  ① **学习上下文**：四级降级链（vector → cloud → fts → outline）与学段隔离。
 *     降级档位**只读** Python 的判定（`citation` 事件里的 `degraded`），
 *     TS 侧不重新推理 —— 那条链必须在一个调用里走完（混合后端硬边界）。
 *     学段隔离同理：隔离在 SQL 层强制（模型改不了 WHERE），这里只如实展示。
 *
 *  ② **工具调用**：轨迹服务 25% 设计分。数据来自**独立于 6 事件**的
 *     `trace:changed` 推送通道（`stores/trace.ts`），按轮次折叠 ——
 *     一轮里的工具调用可能十几条，平铺会把学段页挤到屏幕外。
 *
 *  ③ **学段**：当前学段 + 各信号分值 + 变化轨迹。
 *     ★ 来源标签（手动选中 / AI 引擎推算）只有 `labels.ts` 那一处实现，
 *       两处各写一份映射迟早对不上。
 *
 * 响应式：≥1280px 是常驻栏（`open` 控制显隐）；<1280px 变成浮层面板 + 遮罩，
 * 点遮罩即关。判断放在 CSS 里，`open` 由 ChatView 持有 —— 组件自己不去监听窗口，
 * 免得同一份断点逻辑在两个地方各写一遍。
 *
 * ⚠️ 降级链在**没有检索发生时**是「本轮未检索」，**不是失败**：
 *   学生问一句寒暄时本来就不会查教材，那时把整条链画成红的是撒谎。
 */
import { computed, ref, watch } from 'vue'
import { BookOpen, GitBranch, Info, Radar, Route, Sparkles, TrendingUp, X } from 'lucide-vue-next'
import EmptyState from './EmptyState.vue'
import { useChatStore } from '../stores/chat'
import { useInsightStore } from '../stores/insight'
import { useKnowledgeStore } from '../stores/knowledge'
import { useTraceStore } from '../stores/trace'
import { useUiStore } from '../stores/ui'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL, gradeOriginLabel } from '../labels'
import { useEscape } from '../composables/useEscape'
import { useOnBackendReady } from '../composables/useOnBackendReady'
import type { Degraded } from '@shared/ipc-events'

const props = withDefaults(defineProps<{ open?: boolean }>(), { open: true })
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const chat = useChatStore()
const insight = useInsightStore()
const knowledge = useKnowledgeStore()
const trace = useTraceStore()
const ui = useUiStore()

/*
 * 进入右栏时取一次画像 / 推荐 / 学段证据 + 知识点名索引。
 * ★ store 各自判「已有数据就不重复请求」，所以这里不必再判。
 * ★ `ensureNames()` 只为拿到知识点显示名（画像端点只回 kpId）——
 *   名字的唯一来源是 kb 的知识点清单，不在这里另存一份。
 * ★★ 走 `useOnBackendReady`：冷启动时这一批请求必然早于 sidecar 就绪，
 *   只发一次会让右栏永远挂着「读取失败：sidecar 尚未就绪」（实测踩到）。
 */
useOnBackendReady(() => {
  void insight.loadAll().catch(() => {})
  void knowledge.ensureNames().catch(() => {})
  void chat.refreshChapter().catch(() => {})
})

type TabKey = 'context' | 'tools' | 'grade'
const tab = ref<TabKey>('context')

/**
 * `el-segmented` 的选项形态。
 *
 * ★ 文案刻意**压到 4/2/2 字**（「上下文 / 工具 / 学段」而不是「学习上下文 / 工具调用 / 学段」）：
 *   右栏只有 288px，三个等宽段各约 88px —— 五字标签会被截成「学习…」，
 *   看起来像排版坏了（实测截图里就是这样）。三段的语义在各自页内已由小标题说清
 *   （「检索降级链」「本轮工具调用」「当前学段」），这里只需要能区分。
 */
/** 页签的取值（与 `TabKey` 同一联合，`satisfies` 让漏项在编译期报出来）。 */
const TABS = [
  { label: '上下文', value: 'context' },
  { label: '工具', value: 'tools' },
  { label: '学段', value: 'grade' }
] as const satisfies ReadonlyArray<{ label: string; value: TabKey }>

/* ------------------------------------------------------------------ *
 * ① 学习上下文
 * ------------------------------------------------------------------ */

/**
 * 四级降级链的展示行。
 *
 * ★ 三态必须分开（**只有实际命中的那一档是「命中」**）：
 *   - 比命中档**更强**的档位是「不可用」（链按强度依次尝试，走到第 N 档
 *     说明前 N-1 档都失败了）；
 *   - 比命中档**更弱**的档位是「未走到」（还没轮到它，不能画成失败）。
 * ★ `null`（这一轮没检索）时四档统一「本轮未检索」。
 *
 * ★ 档位名**刻意压到最短**（「向量检索 · 本地模型」而不是「向量检索 · fastembed 本地」）：
 *   右栏只有 288px，而这一行还要并排放状态标签 —— 名字一长就折成两行，
 *   四档高度参差不齐（实测截图里就是第一档比其它三档高一倍）。
 *   技术名词（fastembed）在这里没有信息价值：学生关心的是「本地 / 云端」这个区别，
 *   具体用的哪个模型在设置页与右栏统计里都写着。
 */
const DEGRADE_LEVELS: Array<{ key: Degraded; label: string }> = [
  { key: 'vector', label: '向量检索 · 本地模型' },
  { key: 'cloud', label: '云端 Embedding' },
  { key: 'fts', label: 'FTS5 关键词兜底' },
  { key: 'outline', label: '依赖图 + 大纲' }
]

const lastDegraded = computed<Degraded | null>(() => chat.lastCitationDegraded)

const degradeChain = computed(() => {
  const hit = lastDegraded.value
  const hitIndex = hit === null ? -1 : DEGRADE_LEVELS.findIndex((level) => level.key === hit)
  return DEGRADE_LEVELS.map((level, index) => {
    if (hitIndex < 0) return { ...level, state: '本轮未检索', active: false, skipped: false }
    if (index === hitIndex) return { ...level, state: '命中', active: true, skipped: false }
    if (index < hitIndex) return { ...level, state: '不可用', active: false, skipped: true }
    return { ...level, state: '未走到', active: false, skipped: false }
  })
})

/** 学段隔离提示：只在**真的检索过**时给（没检索时说「隔离生效」是无意义的话）。 */
const isolationNotice = computed(() => {
  if (lastDegraded.value === null) return null
  const label = chat.currentGradeLabel ?? GRADE_UNKNOWN_LABEL
  return {
    gradeLabel: label,
    text: `本次仅使用「${label}」及以下教材块（隔离在 SQL 层强制，模型改不了 WHERE）`
  }
})

/** 知识点显示名（拿不到回退 id —— **不编名字**）。 */
function kpName(kpId: string): string {
  return knowledge.kpNameOf(kpId) ?? kpId
}

/**
 * 推荐知识点的显示名。
 *
 * ★ 用服务端给的 `name`（`RecommendationItem.name` 已经是人读的名字），
 *   **不**再拿 `kpId` 去知识点清单反查 —— 那是多做一次，且两条路可能不一致
 *   （一边是服务端出推荐时的快照、一边是当前清单）。
 */
const recommendedName = computed(() => {
  const item = insight.recommended
  if (item === null) return ''
  return item.name.trim() || item.kpId
})

/** 掌握度行（store 已按分数降序排好，同分按 kpId 兜底）。 */
const masteryRows = computed(() =>
  insight.masteryRows.map((row) => ({
    kpId: row.kpId,
    name: kpName(row.kpId),
    score: row.score,
    attempts: row.attempts,
    correct: row.correct
  }))
)

/**
 * 知识点详情（二级界面）。
 * 掌握度行此前是**不可点的 div** —— 学生看到「决策树 42%」却点不开，
 * 不知道这 42% 是怎么来的、还能做什么。
 */
const kpDetail = ref<string | null>(null)
const kpRow = computed(() => masteryRows.value.find((row) => row.kpId === kpDetail.value) ?? null)

/* ------------------------------------------------------------------ *
 * ② 工具调用轨迹
 * ------------------------------------------------------------------ */

const traceGroups = computed(() => trace.byTurn)
const latestTurn = computed(() => trace.turn)
const traceNote = '路由由模型自选；学段隔离、参数校验、内容终审均在代码层强制。'

/**
 * Tool 名的中文说法（轨迹里给人看的一句）。
 * ★ 表里只放**真的会出现在轨迹里**的那些（与 `ipc/tool-kinds.ts` 的 7 个 + 不发 payload 的 3 个）。
 *   不在这张表里的按原名显示 —— 那是新 Tool 上了但这里还没登记，如实显示比猜一个准。
 */
const TOOL_LABELS: Record<string, string> = {
  rag_search: '查教材',
  generate_animation: '生成动画',
  get_code_template: '取代码模板',
  get_coding_hint: '分级求助',
  evaluate_code: '代码评估',
  generate_quiz: '出题',
  submit_quiz: '判分',
  generate_variants: '生成变式题',
  get_student_profile: '读画像',
  remember_preference: '记偏好'
}

function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName
}

/* ------------------------------------------------------------------ *
 * ③ 学段
 * ------------------------------------------------------------------ */

const gradeLabel = computed(() => chat.currentGradeLabel ?? GRADE_UNKNOWN_LABEL)
/** ★ 来源说法只有 `labels.ts` 一处实现（两处各写一份映射迟早对不上）。 */
const gradeOrigin = computed(() => gradeOriginLabel(chat.gradeOrigin))
const gradeSignals = computed(() => insight.gradeSignals?.signals ?? [])
const confidence = computed(() => insight.confidence)

/** 各信号的显示名（四类固定信号）。 */
const SIGNAL_LABELS: Record<string, string> = {
  vocab: '用词水平',
  depth: '追问深度',
  quiz_perf: '练习表现',
  meta_cognition: '元认知'
}

function signalLabel(type: string): string {
  return SIGNAL_LABELS[type] ?? type
}

/** 轨迹 `source` 只有两态（`inferred` / `explicit`）；其余按系统推算显示。 */
function historyOrigin(source: string): string {
  return gradeOriginLabel(source === 'explicit' ? 'explicit' : 'inferred')
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

function close(): void {
  emit('update:open', false)
}

/**
 * 「去闯关检验」= **真的切到闯关页**。
 *
 * ★ 这里此前两处都是 `@click="$emit('update:open', true)"` —— 一个**死按钮**：
 *   它们本来就在**已经打开**的右栏里，那个 emit 只是把右栏再设成「打开」，
 *   点下去恒等于空操作（抽屉里那一处更糟：点完抽屉还盖在原处，像按坏了）。
 *   落点按 `stores/ui.ts` 的页面清单走 —— 闯关页的页名是 `quiz`，
 *   与学习档案页推荐卡用的是**同一个** `ui.go(...)`（`ReportTab.vue`）。
 *
 * ★ 顺手把知识点详情抽屉关掉：它 `Teleport` 到 body，而本组件挂在 `<KeepAlive>`
 *   的对话页里 —— 不显式关掉就可能跟着盖到闯关页上（切页不等于关浮层）。
 */
function goQuiz(): void {
  kpDetail.value = null
  ui.go('quiz')
}

/** Esc 关闭详情抽屉（模态必须有键盘出口，否则键盘用户被卡在里面）。 */
useEscape(
  () => {
    kpDetail.value = null
  },
  () => kpDetail.value !== null
)

/** 换页签时收起详情抽屉：它属于「学习上下文」那一页，留着会跟着换到别的页上。 */
watch(tab, () => {
  kpDetail.value = null
})
</script>

<template>
  <aside class="rail" :class="{ 'rail--closed': !props.open }" data-testid="context-rail">
    <!-- 窄屏遮罩：点一下关闭（浮层必须有逃生口） -->
    <div class="rail__scrim" @click="close" />

    <div class="rail__panel">
      <header class="rail__head">
        <!-- 页签：**手写**而不是 `el-segmented`。
             ★ 原因（实测）：`el-segmented` 的 `block` 模式把轨道等分成三段后，
               每段的内容宽度被它的内边距吃掉一部分，"上下文" 这种三字标签会被截成
               「上…」—— 而右栏只有 288px，没有富余去猜它的尺寸规则。
               手写三段只有 15 行，宽度分配 `flex: 1 1 0` + `min-width: 0` 完全可预测，
               且与仓库其余部分（大量手写控件）一致。 -->
        <div class="rail__tabs" role="tablist" aria-label="学习上下文分页" data-testid="rail-tabs">
          <button
            v-for="item in TABS"
            :key="item.value"
            type="button"
            role="tab"
            class="rail__tab"
            :class="{ 'rail__tab--on': tab === item.value }"
            :aria-selected="tab === item.value"
            :data-tab="item.value"
            @click="tab = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <button
          type="button"
          class="rail__close"
          data-testid="rail-close"
          title="收起学习上下文"
          @click="close"
        >
          <X :size="16" />
        </button>
      </header>

      <div class="rail__body">
        <!-- ══ ① 学习上下文 ═══════════════════════════════════════════════ -->
        <section v-if="tab === 'context'" class="sec">
          <div class="sec__head">
            <Radar :size="14" />
            <h3 class="sec__title">检索降级链</h3>
          </div>
          <p class="sec__hint">
            四级在一次调用内走完（Python 侧），前端只读结果。
            <template v-if="lastDegraded === null">本轮没有查教材，所以四档都还没走到。</template>
          </p>

          <ul class="chain" data-testid="degrade-chain">
            <li
              v-for="level in degradeChain"
              :key="level.key"
              class="chain__row"
              :class="{ 'chain__row--on': level.active, 'chain__row--skip': level.skipped }"
              :data-level="level.key"
              :data-active="String(level.active)"
            >
              <span class="chain__dot" />
              <span class="chain__label">{{ level.label }}</span>
              <span class="chain__state">{{ level.state }}</span>
            </li>
          </ul>

          <p v-if="isolationNotice" class="isolation" data-testid="isolation-notice">
            <Info :size="13" />
            <span>{{ isolationNotice.text }}</span>
          </p>

          <div class="sec__head sec__head--gap">
            <TrendingUp :size="14" />
            <h3 class="sec__title">掌握度</h3>
          </div>
          <p v-if="insight.errors.profile" class="warn" data-testid="rail-profile-error">
            {{ insight.errors.profile }}
          </p>
          <p v-else-if="masteryRows.length === 0" class="sec__hint">还没有练习记录。</p>
          <ul v-else class="mastery" data-testid="rail-mastery">
            <li v-for="row in masteryRows" :key="row.kpId">
              <button type="button" class="mastery__row" @click="kpDetail = row.kpId">
                <span class="mastery__name">{{ row.name }}</span>
                <el-progress
                  :percentage="Math.round(row.score * 100)"
                  :stroke-width="6"
                  :show-text="false"
                  class="mastery__bar"
                />
                <span class="mastery__pct k12-num">{{ Math.round(row.score * 100) }}%</span>
              </button>
            </li>
          </ul>

          <!-- 推荐下一步：依赖图推导，落在对话右栏而不是独立仪表盘 -->
          <div v-if="insight.recommended" class="reco" data-testid="rail-recommendation">
            <div class="reco__text">
              <p class="reco__title">建议下一步：{{ recommendedName }}</p>
              <p class="reco__desc">{{ insight.recommended.reason }}</p>
            </div>
            <button type="button" class="reco__btn" @click="goQuiz()">去闯关检验</button>
          </div>
        </section>

        <!-- ══ ② 工具调用轨迹 ═════════════════════════════════════════════ -->
        <section v-else-if="tab === 'tools'" class="sec">
          <div class="sec__head">
            <Route :size="14" />
            <h3 class="sec__title">本轮工具调用</h3>
            <span v-if="trace.hasDegraded" class="tag tag--warn" data-testid="trace-degraded">有降级</span>
            <span v-if="trace.failureCount > 0" class="tag tag--bad" data-testid="trace-failures">
              {{ trace.failureCount }} 次未成功
            </span>
          </div>

          <p v-if="trace.bridgeError" class="warn" data-testid="trace-bridge-error">
            {{ trace.bridgeError }}
          </p>
          <EmptyState
            v-else-if="traceGroups.length === 0"
            tone="empty"
            title="还没有工具调用"
            desc="问一个需要查教材、出题或生成动画的问题，这里会实时显示模型调了哪些工具。"
          />

          <el-collapse v-else :model-value="[latestTurn]" data-testid="trace-groups">
            <el-collapse-item
              v-for="group in traceGroups"
              :key="group.turn"
              :name="group.turn"
              :title="`第 ${group.turn} 轮 · ${group.entries.length} 次调用`"
            >
              <ul class="trace" :data-testid="`trace-turn-${group.turn}`">
                <li
                  v-for="(entry, index) in group.entries"
                  :key="`${group.turn}-${index}`"
                  class="trace__row"
                  :data-ok="String(entry.ok)"
                >
                  <span class="trace__dot" :class="entry.ok ? 'is-ok' : 'is-bad'" />
                  <span class="trace__name">{{ toolLabel(entry.toolName) }}</span>
                  <span class="trace__args">{{ entry.argsSummary }}</span>
                  <span class="trace__meta k12-num">
                    {{ entry.latencyMs }}ms<template v-if="entry.degraded"> · {{ entry.degraded }}</template>
                  </span>
                </li>
              </ul>
            </el-collapse-item>
          </el-collapse>

          <p class="note">{{ traceNote }}</p>
        </section>

        <!-- ══ ③ 学段 ═════════════════════════════════════════════════════ -->
        <section v-else class="sec">
          <div class="sec__head">
            <Sparkles :size="14" />
            <h3 class="sec__title">当前学段</h3>
          </div>

          <p class="grade" data-testid="rail-grade">
            <strong>{{ gradeLabel }}</strong>
            <span v-if="chat.currentGrade" class="grade__origin">{{ gradeOrigin }}</span>
            <span v-else class="grade__origin">还没判出来</span>
          </p>

          <p v-if="confidence !== null" class="sec__hint" data-testid="rail-confidence">
            判定置信度 {{ Math.round(confidence * 100) }}%（低于 60% 时系统不会改动学段）
          </p>

          <p v-if="insight.errors.gradeSignals" class="warn" data-testid="rail-signals-error">
            {{ insight.errors.gradeSignals }}
          </p>
          <ul v-else-if="gradeSignals.length > 0" class="signals" data-testid="rail-signals">
            <li
              v-for="(signal, index) in gradeSignals"
              :key="`${signal.signalType}-${index}`"
              class="signals__row"
            >
              <span class="signals__type">{{ signalLabel(signal.signalType) }}</span>
              <span class="signals__bar">
                <span
                  class="signals__fill"
                  :style="{ width: `${Math.round(Math.max(0, Math.min(1, signal.value)) * 100)}%` }"
                />
              </span>
              <span class="signals__raw">{{ signal.raw ?? '—' }}</span>
            </li>
          </ul>
          <p v-else class="sec__hint">系统还没从对话里攒到足够的判定依据。</p>

          <div class="sec__head sec__head--gap">
            <BookOpen :size="14" />
            <h3 class="sec__title">学段变化</h3>
          </div>
          <p v-if="insight.historyDesc.length === 0" class="sec__hint">还没有发生过学段变化。</p>
          <el-timeline v-else data-testid="rail-grade-history">
            <el-timeline-item
              v-for="(entry, index) in insight.historyDesc"
              :key="`${entry.ts}-${index}`"
              :timestamp="`第 ${entry.turn} 轮`"
              placement="top"
            >
              <p class="hist__line">
                {{ entry.fromLevel ? GRADE_LABELS[entry.fromLevel] : '起点' }}
                →
                <strong>{{ GRADE_LABELS[entry.toLevel] }}</strong>
              </p>
              <p class="hist__src">{{ historyOrigin(entry.source) }}</p>
            </el-timeline-item>
          </el-timeline>
        </section>
      </div>
    </div>

    <!-- 知识点详情抽屉（二级界面） -->
    <Teleport to="body">
      <div v-if="kpRow" class="kpd" role="dialog" aria-modal="true" @click.self="kpDetail = null">
        <aside class="kpd__panel" data-testid="kp-detail">
          <header class="kpd__head">
            <div class="kpd__head-text">
              <p class="kpd__title">{{ kpRow.name }}</p>
              <p class="kpd__sub"><code>{{ kpRow.kpId }}</code></p>
            </div>
            <button type="button" class="kpd__close" title="关闭" @click="kpDetail = null">
              <X :size="16" />
            </button>
          </header>
          <div class="kpd__body">
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="掌握度">{{ Math.round(kpRow.score * 100) }}%</el-descriptions-item>
              <el-descriptions-item label="练习次数">{{ kpRow.attempts }}</el-descriptions-item>
              <el-descriptions-item label="答对次数">{{ kpRow.correct }}</el-descriptions-item>
            </el-descriptions>
            <p class="kpd__hint">
              掌握度由判分规则算出（单次变化限幅 ±0.2）——模型改不了它，只有答题结果能改。
            </p>
          </div>
          <footer class="kpd__foot">
            <button type="button" class="kpd__btn kpd__btn--primary" @click="goQuiz()">
              <GitBranch :size="14" /> 去闯关检验
            </button>
          </footer>
        </aside>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.rail {
  flex: none;
  /* ★ 宽度**只认设计令牌**（`base.css` 的 `--k12-w-rail`，300px）。
   * 此前这里硬写 288px，而令牌是 300px —— 两处真相，差 12px。
   * 后果不只是「数字不一致」：顶栏里那个**浮在对话栏上方的学段气泡**
   * 要靠这个宽度算自己的右边界（见 `GradeIndicator.vue` 的 `.grade__extras`），
   * 拿 300 去算 288 的实际盒宽，气泡就会越进右栏被裁掉一角。
   * 现在两侧同源，改一处即可。 */
  width: var(--k12-w-rail);
  min-height: 0;
  position: relative;
}
.rail--closed {
  width: 0;
}
.rail--closed .rail__panel {
  display: none;
}
/* 窄屏：变成浮层 + 遮罩（点遮罩即关） */
.rail__scrim {
  display: none;
}
.rail__panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--k12-border);
  background: var(--k12-surface);
}
.rail__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--k12-border);
}
/* 页签轨道：三段等分。`min-width: 0` 是让 `flex: 1 1 0` 真的能压到等分的关键 ——
 * 少了它，`flex-basis: 0` 会被内容的 min-content 宽度顶开，三段就不等了。 */
.rail__tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--k12-r-control);
  background: var(--k12-surface-2);
}
.rail__tab {
  flex: 1 1 0;
  min-width: 0;
  padding: 5px 4px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-muted);
  font-family: inherit;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  /* 真的放不下时**省略号**，不是硬切半个字（截断要看得出来是截断） */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (hover: hover) and (pointer: fine) {
  .rail__tab:hover:not(.rail__tab--on) {
    color: var(--k12-fg-2);
  }
}
.rail__tab--on {
  background: var(--k12-surface);
  color: var(--k12-accent-ink);
  box-shadow: var(--k12-shadow-card);
}
.rail__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
.rail__close:hover {
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
}
.rail__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 12px 20px;
}

.sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sec__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--k12-muted);
}
.sec__head--gap {
  margin-top: 8px;
}
.sec__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.sec__hint {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.warn {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-warn);
}
.note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}

/* ── 降级链 ── */
.chain {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chain__row {
  display: flex;
  /* ★ `align-items: center` → `flex-start` + 让圆点自己下移对齐首行。
   *   原因（字号抬升后才暴露）：档位名（「向量检索 · fastembed 本地」）在三档里
   *   最长，窄栏下会折成两行 —— 而 `center` 会把圆点、档位名、状态标签三者
   *   各自垂直居中，于是状态标签飘到**两行之间**，读起来像"这一档的状态是哪个"
   *   都要猜。改成顶对齐后：圆点贴首行、状态标签也贴首行，折行只发生在档位名内部。 */
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--k12-r-inset);
}
.chain__row--on {
  background: var(--k12-accent-soft);
}
.chain__dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--k12-border-strong);
  /* 顶对齐后圆点会贴到行顶；下移半个行高让它落在**首行的视觉中线**上
   * （行高 1.6 × 13px ≈ 21px，中线 ≈ 10.5px，减去自身半径 ≈ 7px）。 */
  margin-top: 7px;
}
.chain__row--on .chain__dot {
  background: var(--k12-accent);
}
.chain__row--skip .chain__dot {
  background: var(--k12-warn);
}
.chain__label {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}
.chain__row--on .chain__label {
  color: var(--k12-accent-ink);
  font-weight: 600;
}
.chain__state {
  flex: none;
  font-size: var(--k12-fs-xs);
  /* 状态标签只占首行：`align-self` 让它跟着顶对齐，不在两行之间飘 */
  align-self: flex-start;
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

.isolation {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 9px 10px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

/* ── 掌握度 ── */
.mastery {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mastery__row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
}
.mastery__row:hover {
  background: var(--k12-surface-2);
}
.mastery__name {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mastery__bar {
  width: 64px;
  flex: none;
}
.mastery__pct {
  flex: none;
  width: 34px;
  text-align: right;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.reco {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.reco__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.reco__title {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg);
}
.reco__desc {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.reco__btn {
  flex: none;
  padding: 7px 11px;
  border: 1px solid var(--k12-accent);
  border-radius: var(--k12-r-control);
  background: var(--k12-accent);
  color: var(--k12-surface);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
}

/* ── 工具轨迹 ── */
.tag {
  padding: 2px 7px;
  border-radius: var(--k12-r-flat);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
  /* k12-mark：≤4 字的角标（「有降级」「3 次未成功」按角标口径） */
}
.tag--warn {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.tag--bad {
  background: var(--k12-bad);
  color: var(--k12-surface);
}

.trace {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.trace__row {
  display: grid;
  grid-template-columns: 8px auto 1fr;
  align-items: baseline;
  gap: 7px;
  font-size: var(--k12-fs-xs);
}
.trace__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--k12-border-strong);
}
.trace__dot.is-ok {
  background: var(--k12-good);
}
.trace__dot.is-bad {
  background: var(--k12-bad);
}
.trace__name {
  font-weight: 600;
  color: var(--k12-fg-2);
  white-space: nowrap;
}
.trace__args {
  min-width: 0;
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace__meta {
  grid-column: 3;
  color: var(--k12-muted-2);
}

/* ── 学段 ── */
.grade {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.grade strong {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.grade__origin {
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-accent-ink);
}

.signals {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.signals__row {
  display: grid;
  grid-template-columns: 60px 1fr;
  align-items: center;
  gap: 8px;
}
.signals__type {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.signals__bar {
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.signals__fill {
  display: block;
  height: 100%;
  background: var(--k12-accent);
}
.signals__raw {
  grid-column: 2;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist__line {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.hist__src {
  margin-top: 2px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ── 知识点详情抽屉 ── */
.kpd {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--k12-fg) 30%, transparent);
}
.kpd__panel {
  width: min(420px, 94vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--k12-surface);
  border-left: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-float);
}
.kpd__head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 15px 16px;
  border-bottom: 1px solid var(--k12-border);
}
.kpd__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kpd__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.kpd__sub code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.kpd__close {
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
.kpd__close:hover {
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
}
.kpd__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.kpd__hint {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.kpd__foot {
  padding: 12px 16px;
  border-top: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
}
.kpd__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--k12-r-control);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
}
.kpd__btn--primary {
  border-color: var(--k12-accent);
  background: var(--k12-accent);
  color: var(--k12-surface);
}

/* 窄屏：常驻栏变浮层（判断放 CSS，`open` 由 ChatView 持有） */
@media (max-width: 1279px) {
  .rail {
    position: fixed;
    inset: 0;
    z-index: 60;
    width: auto;
  }
  .rail--closed {
    pointer-events: none;
  }
  .rail--closed .rail__panel {
    display: none;
  }
  .rail:not(.rail--closed) .rail__scrim {
    display: block;
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--k12-fg) 26%, transparent);
  }
  .rail__panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(320px, 92vw);
    z-index: 1;
  }
}
</style>
