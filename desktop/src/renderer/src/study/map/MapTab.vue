<script setup lang="ts">
/**
 * 学习档案 · **学习地图**（依赖图全览）。
 *
 * 这是需求里「多模态教学」那一项的**图形化子集**：不做视频 / PPT，
 * 但把教材的知识结构画出来 —— 而依赖图数据本来就有两个用途
 * （推荐路径 + 检索扩展），现在多了第三个：**给学生看的结构图**。
 *
 * ★ 图是**自绘 SVG**（`map/layout.ts` 纯函数 + `map/GraphMap.vue` 渲染），
 *   不引任何图表库（零依赖、断网可用）。
 * ★ 布局由服务端给的 `layer` 决定纵向（最长前置链），所以箭头永远朝下 ——
 *   「先学上面的、再学下面的」不需要解释。
 *
 * ---------------------------------------------------------------------------
 * ★★ 本轮补上的三件事（走查结论：图「溢出屏幕、节点点不动、回不到自己的进度」）
 * ---------------------------------------------------------------------------
 * 前两条里其实只有**一条**是真的：
 *   · 「溢出屏幕、没有水平滚动条」—— **不成立**：`.canvas` 本来就是 `overflow: auto`，
 *     图按 1:1 固定像素渲染（1610×1600）并靠容器滚动（`GraphMap.vue` 的样式注释
 *     解释了为什么不能等比缩小：13px 的字会被压到 6.5px）。
 *   · 「节点不可点击」—— **成立**，已修：节点现在是真按钮（单击 / Tab / Enter / Space）。
 *   · 「回不到自己的进度」—— **成立**，已修：`定位到我最近的进度` 把容器滚到
 *     「下一个该学的知识点」（规则见 `focusTarget()`），并顺手选中它。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useStudyStore, type GraphView } from '../../stores/study'
import { useInsightStore } from '../../stores/insight'
import { useChatStore } from '../../stores/chat'
import { useQuizStore } from '../../stores/quiz'
import { useUiStore } from '../../stores/ui'
import { useReducedMotion } from '../../composables/useReducedMotion'
import { UNKNOWN_KP_LABEL, kpLabel } from '../kp-label'
import { GRADE_LABELS } from '../../labels'
import GraphMap from './GraphMap.vue'
import { layoutGraph } from './layout'

defineOptions({ name: 'StudyMapTab' })

const study = useStudyStore()
const insight = useInsightStore()
const chat = useChatStore()
const quiz = useQuizStore()
const ui = useUiStore()
const reducedMotion = useReducedMotion()

const graph = computed(() => study.graph)
const gradeLabel = computed(() => {
  const level = graph.value?.gradeLevel
  return level ? (GRADE_LABELS[level] ?? level) : '待判定'
})

/** 画布容器（**唯一**的滚动者 —— 定位只改它的 scrollLeft / scrollTop，不动 SVG）。 */
const canvas = ref<HTMLElement | null>(null)

/** 当前选中的知识点（`''` = 还没选，右侧详情卡不渲染）。 */
const selected = ref('')

/**
 * 把契约形状投影成布局输入（**只取布局需要的字段**）。
 *
 * ★ 不直接把 `graph.nodes` 丢给布局：那样布局函数就得依赖生成类型，
 *   而它是纯函数、要能在 `node --test` 里跑（生成类型能 import 但没必要 ——
 *   投影这一层也让「服务端多返回一个字段」不会悄悄改变布局行为）。
 */
const layout = computed(() =>
  layoutGraph(
    (graph.value?.nodes ?? []).map((node) => ({
      kpId: node.kpId,
      name: node.name,
      chapterTitle: node.chapterTitle,
      layer: node.layer,
      mastered: node.mastered
    })),
    (graph.value?.edges ?? []).map((edge) => ({
      fromKpId: edge.fromKpId,
      toKpId: edge.toKpId,
      relation: edge.relation
    }))
  )
)

const masteredCount = computed(() => (graph.value?.nodes ?? []).filter((n) => n.mastered).length)

/* ------------------------------------------------------------------ *
 * 知识点名（**不显示 slug**：取不到名字时也不把 id 摆出来）
 * ------------------------------------------------------------------ */

const nodeByKp = computed(() => {
  const map = new Map<string, GraphView['nodes'][number]>()
  for (const node of graph.value?.nodes ?? []) map.set(node.kpId, node)
  return map
})

/**
 * kp_id → 中文名。
 *
 * ★ 名字取**图节点自带的** `name`（服务端已 join 好）；契约里查不到名字时它等于 id
 *   —— 那种情况按「没有名字」处理：界面显示中性标签，原始 id 只进 `title`
 *   （完整口径与唯一实现在 `study/kp-label.ts`）。
 */
function nameOf(kpId: string, fallbackName = ''): string {
  const node = nodeByKp.value.get(kpId)
  return kpLabel(kpId, node?.name || fallbackName || null, null)
}

/** 名字是否真的取到了（取不到时把原始 id 放进 `title`）。 */
function nameResolved(kpId: string): boolean {
  return nameOf(kpId) !== UNKNOWN_KP_LABEL
}

/* ------------------------------------------------------------------ *
 * 选中：详情卡（名称 / 章节 / 掌握度 / 前置 / 下一步动作）
 * ------------------------------------------------------------------ */

const selectedNode = computed(() => nodeByKp.value.get(selected.value) ?? null)

const selectedChapter = computed(() => selectedNode.value?.chapterTitle || '未分章')

/**
 * 该知识点的**前置**（依赖边 `to → from`：全项目一致，`from` 是前置）。
 *
 * ★ 只列**本学段图内**的前置：跨学段的边在 `GraphOverview` 里本来就不返回
 *   （没有落点，画不出来），所以这里也不需要额外过滤。
 * ★ 一个都没有 = 它是入口知识点（没有要先学的东西），界面上如实说。
 */
const prereqs = computed(() => {
  const kpId = selected.value
  if (!kpId) return []
  const edges = study.graph?.edges ?? []
  const seen = new Set<string>()
  const list: Array<{ kpId: string; name: string }> = []
  for (const edge of edges) {
    if (edge.toKpId !== kpId || seen.has(edge.fromKpId)) continue
    seen.add(edge.fromKpId)
    list.push({ kpId: edge.fromKpId, name: nameOf(edge.fromKpId) })
  }
  return list
})

/** 掌握度（0–100，来自画像端点；**取不到就是 `null`，不按 0 显示**）。 */
const selectedMastery = computed(() => {
  const kpId = selected.value
  if (!kpId) return null
  const row = insight.masteryRows.find((item) => item.kpId === kpId)
  return row ? Math.round(Math.max(0, Math.min(1, row.score)) * 100) : null
})

/** 关卡的阶段（`locked` 等，来自闯关进度；没有这一关时为 `null`）。 */
const selectedStage = computed(() => {
  const kpId = selected.value
  if (!kpId) return null
  return quiz.levels.find((level) => level.kpId === kpId)?.stage ?? null
})

/**
 * 这个知识点有没有可练的关卡（没有关卡 / 关卡锁着 → 不给按钮，也不给一句假承诺）。
 *
 * ★ 判据只看闯关进度：进度读失败时 `levels` 为空 → 按钮不出现（而不是出现一个
 *   点下去什么都不发生的按钮）。「去学」那条主行动**不受它影响**，永远可用。
 */
const quizReady = computed(() => selectedStage.value !== null && selectedStage.value !== 'locked')

/**
 * 主行动「去学这个知识点 →」**落在对话页**（选择理由）：
 *   · 它要能对**任何**节点都可用 —— 入口知识点可能还没解锁关卡、也可能还没有题库，
 *     而「问一句」这条路永远通；
 *   · 「学」这件事在本项目里的主场就是对话（7×24 的 AI 教师），
 *     练习题是**检验**（次要动作用它，见 `goQuiz()`）；
 *   · 走 `chat.prepareQuestion()` 预填，学生看得见自己要问什么、也**不会**被替着消耗一次调用
 *     （与错题本的「去练一练」同一条纪律）。
 */
function goLearn(): void {
  const kpId = selected.value
  if (!kpId) return
  chat.prepareQuestion(`我想学「${nameOf(kpId)}」这个知识点，先给我讲讲它是怎么一回事吧。`)
  ui.show('chat')
}

/** 次要动作「去闯关练一练」：题库里这个知识点的题（判分仍在 Python）。 */
function goQuiz(): void {
  const kpId = selected.value
  if (!kpId || !quizReady.value) return
  void quiz.selectLevel(kpId)
  ui.go('quiz')
}

/** 选一个节点（图上点、前置 chip 点、`定位` 都走这一入口）。 */
function select(kpId: string): void {
  selected.value = kpId
}

/* ------------------------------------------------------------------ *
 * 定位到我最近的进度
 * ------------------------------------------------------------------ */

/**
 * 「我该从哪儿接着学」的落点规则（**只影响滚动位置，不改图、不改数据**）：
 *
 *   1. 取**还没掌握**且层级最浅（`layer` 最小）的那批节点；
 *   2. 其中**至少有一个已掌握的前置**的，按 (layer, x) 取第一个 ——
 *      这正是「前置都学过了、现在轮到它」的那个点（学生的真实进度前沿）；
 *   3. 一个这样的点都没有（比如刚入门，什么都还没掌握；或者图里压根没有边）→
 *      退回到「层级最浅的未掌握节点」；全都掌握了 → 取层级**最深**的那个
 *      （「你已经走到这儿了」比把学生丢回起点更像是在说进度）。
 *
 * ★ 规则写在注释里是因为它是一条**展示选择**：服务端不认识「进度前沿」这个概念，
 *   也没有推荐端点参与 —— 这里的推荐位仍然是 `/recommendation`（唯一出口）。
 */
function focusTarget(): string {
  const nodes = layout.value.nodes
  if (nodes.length === 0) return ''
  const masteredIds = new Set(nodes.filter((node) => node.mastered).map((node) => node.kpId))
  const byPosition = (a: { layer: number; x: number }, b: { layer: number; x: number }) =>
    a.layer - b.layer || a.x - b.x

  const pending = nodes.filter((node) => !node.mastered).sort(byPosition)
  if (pending.length === 0) {
    // 全掌握了：给学生看「走得最远的那一个」
    const deepest = [...nodes].sort((a, b) => b.layer - a.layer || a.x - b.x)[0]
    return deepest ? deepest.kpId : ''
  }
  if (masteredIds.size > 0) {
    const frontier = pending.filter((node) =>
      (study.graph?.edges ?? []).some((edge) => edge.toKpId === node.kpId && masteredIds.has(edge.fromKpId))
    )
    if (frontier.length > 0) return frontier.sort(byPosition)[0].kpId
  }
  return pending[0].kpId
}

/**
 * 把画布滚到某个节点（居中）并选中它。
 *
 * ★ 只改**容器的** `scrollLeft` / `scrollTop`：SVG 仍然是 1:1 固定像素，
 *   没有 `transform: scale` 那一套（守卫盯着这条）。
 * ★ 减动效偏好下用瞬时跳转（`behavior: 'auto'`）：
 *   平滑滚动是动效，`prefers-reduced-motion` 的用户不该被迫看完它。
 */
async function focusNode(kpId: string): Promise<void> {
  if (!kpId) return
  selected.value = kpId
  await nextTick()
  const box = canvas.value
  const node = layout.value.nodes.find((item) => item.kpId === kpId)
  if (!box || !node) return
  const left = Math.max(0, node.x - box.clientWidth / 2)
  const top = Math.max(0, node.y - box.clientHeight / 2)
  box.scrollTo({
    left,
    top,
    behavior: reducedMotion.value ? 'auto' : 'smooth'
  })
}

/** 工具栏按钮：定位到「下一个该学的知识点」。 */
function locate(): void {
  void focusNode(focusTarget())
}

onMounted(() => {
  // 详情卡要的两份「旁证数据」，都是幂等的（取到过就不再发请求）：
  //   · 掌握度 → 画像端点（与概览页、对话右栏同一个数据源）；
  //   · 关卡阶段 → 闯关进度（决定「去闯关练一练」这个按钮该不该出现）。
  void insight.loadProfile()
  void quiz.loadProgress()
})

/* ------------------------------------------------------------------ *
 * 按章节分组列出（图之外的一份清单：图看结构，清单看「这一章有哪些点」）
 * ------------------------------------------------------------------ */

const byChapter = computed(() => {
  const groups = new Map<string, Array<{ kpId: string; label: string; mastered: boolean }>>()
  for (const node of graph.value?.nodes ?? []) {
    const key = node.chapterTitle || '未分章'
    const bucket = groups.get(key)
    const label = kpLabel(node.kpId, node.name, null)
    // ★ 名字取不到的**整条不列**（多半是上一代教材的残留 id）：显示 slug 比不显示更糟
    if (label === UNKNOWN_KP_LABEL) continue
    const item = { kpId: node.kpId, label, mastered: node.mastered }
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }
  // 章节顺序按**章号**排（与章节进度页同一口径：字典序会把「第10章」排错）
  return [...groups.entries()].sort((a, b) => chapterNumber(a[0]) - chapterNumber(b[0]))
})

/** 从「第N章 …」里取 N（取不到给一个大数，排到末尾）。 */
function chapterNumber(title: string): number {
  const match = /^第\s*(\d+)\s*章/.exec(title.trim())
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}
</script>

<template>
  <section class="tab-body" data-testid="study-map">
    <p v-if="study.loading.graph" class="state" data-testid="map-loading">正在读取知识结构…</p>
    <p v-else-if="study.errors.graph" class="state state--error" data-testid="map-error">
      {{ study.errors.graph }}
    </p>

    <template v-else-if="graph">
      <p class="summary" data-testid="map-summary">
        {{ gradeLabel }}知识结构 · {{ graph.nodes.length }} 个知识点 ·
        {{ graph.edges.length }} 条依赖 ·
        已掌握 <strong>{{ masteredCount }}</strong> 个
      </p>

      <p v-if="graph.nodes.length === 0" class="state" data-testid="map-empty">
        这个学段还没有知识点依赖数据。
      </p>

      <template v-else>
        <!-- ★ 两个学生真正会用的动作：点一个节点（看图 + 详情）、
             或者「我从哪儿接着学」。前者在图上，后者在这里。 -->
        <div class="bar">
          <button class="btn k12-tap" type="button" data-testid="map-locate" @click="locate()">
            定位到我最近的进度
          </button>
          <span class="bar__hint">点一下图上的知识点，可以看到它的前置和下一步。</span>
        </div>

        <div ref="canvas" class="canvas" data-testid="map-canvas">
          <GraphMap :layout="layout" :selected="selected" @select="select" />
        </div>
        <p class="legend">
          <span class="legend__item"><span class="dot dot--mastered"></span>已掌握</span>
          <span class="legend__item"><span class="dot"></span>还没掌握</span>
          <span class="legend__item">箭头方向：前置 → 后继（从上往下学）</span>
          <span class="legend__item">选中：外面会多一圈</span>
        </p>

        <!-- 选中详情：内联卡片（不是模态）—— 学生要在「看详情」与「看图」之间来回，
             模态会每次都多一次关闭动作 -->
        <div v-if="selectedNode" class="detail" data-testid="map-detail">
          <div class="detail__head">
            <p class="detail__name" data-testid="map-detail-name" :title="nameResolved(selectedNode.kpId) ? undefined : selectedNode.kpId">
              {{ nameOf(selectedNode.kpId) }}
            </p>
            <button
              class="detail__close"
              type="button"
              aria-label="收起知识点详情"
              data-testid="map-detail-close"
              @click="selected = ''"
            >
              ×
            </button>
          </div>
          <p class="detail__meta">
            <span>{{ selectedChapter }}</span>
            <span v-if="selectedMastery !== null">· 掌握度 {{ selectedMastery }}%</span>
            <span v-else-if="selectedNode.mastered">· 已掌握</span>
            <span v-else>· 还没掌握</span>
            <span v-if="selectedStage === 'locked'">· 这一关还没解锁</span>
          </p>

          <div class="detail__prereq">
            <span class="detail__label">先学会：</span>
            <template v-if="prereqs.length > 0">
              <button
                v-for="item in prereqs"
                :key="item.kpId"
                class="chip k12-tap"
                type="button"
                :data-testid="`map-prereq-${item.kpId}`"
                @click="focusNode(item.kpId)"
              >
                {{ item.name }}
              </button>
            </template>
            <span v-else class="detail__none">没有前置 —— 这是可以最先开始学的知识点。</span>
          </div>

          <div class="detail__actions">
            <!-- 主行动：去对话里学（对任何节点都可用；见 `goLearn()` 的注释） -->
            <button class="k12-cta" type="button" data-testid="map-go-learn" @click="goLearn()">
              去学这个知识点 →
            </button>
            <!-- 次要行动：去闯关练（没有可练的关卡时不给按钮，也不给一句假承诺） -->
            <button
              v-if="quizReady"
              class="btn k12-tap"
              type="button"
              data-testid="map-go-quiz"
              @click="goQuiz()"
            >
              去闯关练一练
            </button>
          </div>
        </div>

        <h3 class="section">按章节查看</h3>
        <ul class="chapters" data-testid="map-chapters">
          <li v-for="[title, items] in byChapter" :key="title" class="chapter">
            <p class="chapter__title">{{ title }}</p>
            <p class="chapter__kps">
              <button
                v-for="item in items"
                :key="item.kpId"
                class="kp k12-tap"
                type="button"
                :class="{ 'kp--mastered': item.mastered }"
                @click="focusNode(item.kpId)"
              >
                {{ item.label }}
              </button>
            </p>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>

<style scoped>
.tab-body {
  padding: 16px 24px 32px;
}

.summary {
  margin-bottom: 12px;
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.bar__hint {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

/* 图谱画布 = 一张卡片（E2）：自绘 SVG 压在白面上，边界靠底色差与细线。
 * ★ 它是**唯一**的滚动者（图按 1:1 固定像素渲染，横向靠这里滚）。 */
.canvas {
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.legend {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: var(--k12-r-flat);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
}

.dot--mastered {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent);
}

/* ── 选中详情（内联卡片）──────────────────────────────────────────────── */
.detail {
  margin-top: 10px;
  padding: 12px 14px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.detail__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.detail__name {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}

.detail__close {
  margin-left: auto;
  min-width: 28px;
  min-height: 28px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-muted);
  font-size: var(--k12-fs-sm);
  line-height: 1;
  cursor: pointer;
}

.detail__meta {
  margin-top: 4px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.detail__prereq {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.detail__label {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.detail__none {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

/* 前置 chip = 可点（点了跳到那个知识点）→ 控件层圆角 + 触控下限 */
.chip {
  padding: 2px 10px;
  border: 1px solid var(--k12-accent-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}

.detail__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

/* 本页的次级按钮（与 `MistakesTab` 的 `.btn` 同一配方：全局 .btn 已随旧 base.css 移除） */
.btn {
  padding: 5px 12px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

.section {
  margin: 18px 0 8px;
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}

.chapters {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chapter__title {
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  margin-bottom: 5px;
  color: var(--k12-fg);
}

.chapter__kps {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

/* 章节清单里的知识点 chip：**也可点**（点了图上的同一个节点会被选中并滚到眼前） */
.kp {
  padding: 2px 9px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  cursor: pointer;
}

.kp--mastered {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
  font-weight: 600;
}

.state {
  padding: 10px 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.state--error {
  color: var(--k12-warn);
  line-height: var(--k12-lh-body);
}
</style>
