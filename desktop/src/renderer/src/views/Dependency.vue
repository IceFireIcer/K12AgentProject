<script setup lang="ts">
/**
 * 依赖图谱（**当前学段的全览图**）。
 *
 * ── 数据来源（全部来自 store，本页不再自带任何节点 / 边 / 名字表）────────────
 *   节点与边 `GET /api/graph/overview/{grade}` → `study.graph`
 *     · `nodes[]`：`kpId` / `name` / `gradeLevel` / `chapterTitle` / **`layer`** / **`mastered`**
 *     · `edges[]`：`fromKpId` / `toKpId` / `relation` / `weight`，**`from` 是前置、`to` 是后继**
 *   每点掌握度 `GET /api/profile/{id}` → `insight.masteryRows`（kpId → score）
 *   当前学段   `chat.currentGrade`（主进程推送的判定结果；`null` = 还没判定）
 *
 * ⚠️ 分层（`layer`）与"是否已掌握"（`mastered`）都是**服务端算好的**，本页照抄：
 *    前端不再自己 BFS、不再自建名字表 —— 那两件事都不属于展示层，
 *    而且各写一份迟早与服务端的遍历口径（递归 CTE + depth 上限）漂移。
 *
 * ⚠️ 依赖语义全项目一致：**`from` 是前置、`to` 是后继**（方向搞反是静默错）。
 *    画布上箭头永远从 `from` 指向 `to`；「前置 / 后继视图」只决定**高亮哪一侧的边**，
 *    绝不翻转边的书写方向（一翻转就会读成「数据与特征 是 图像分类 的前置」，与事实相反）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { GitBranch, Download, Search, Layers, Check } from 'lucide-vue-next'
import { useStudyStore, type GraphView } from '../stores/study'
import { useInsightStore } from '../stores/insight'
import { useChatStore } from '../stores/chat'
import { GRADE_LABELS } from '../labels'

const study = useStudyStore()
const insight = useInsightStore()
const chat = useChatStore()

type GraphNode = GraphView['nodes'][number]
type GraphEdge = GraphView['edges'][number]

const VIEWS = [
  { label: '后继视图', value: 'successor' },
  { label: '前置视图', value: 'prerequisite' }
]

/** 视图方向：`successor` = 看「学完这个能学什么」，`prerequisite` = 看「学这个之前要先会什么」。 */
const view = ref<'successor' | 'prerequisite'>('successor')
/** 当前选中的知识点（高亮的中心）。图到位后自动落到 0 层入口。 */
const focus = ref('')

const nodes = computed(() => study.graph?.nodes ?? [])
const edges = computed(() => study.graph?.edges ?? [])

/** kp_id → 节点（名字、分层、章节、已掌握都在节点里）。 */
const nodeByKp = computed(() => {
  const map = new Map<string, GraphNode>()
  for (const node of nodes.value) map.set(node.kpId, node)
  return map
})

function nameOf(kpId: string): string {
  return nodeByKp.value.get(kpId)?.name || kpId
}

/** kp_id → 掌握度（0–1）。取不到就是"还没有记录"，界面显示 `—`，不按 0 处理。 */
const masteryByKp = computed(() => {
  const map = new Map<string, number>()
  for (const row of insight.masteryRows) map.set(row.kpId, row.score)
  return map
})

/** 掌握度百分比（没有记录时为 `null`）。 */
function masteryOf(kpId: string): number | null {
  const score = masteryByKp.value.get(kpId)
  return score === undefined ? null : Math.round(score * 100)
}

/** 学段名：以**图自己回显的学段**为准（服务端的产物），拿不到才退回待判定。 */
const graphGrade = computed(() => study.graph?.gradeLevel ?? null)
const gradeLabel = computed(() =>
  graphGrade.value ? (GRADE_LABELS[graphGrade.value] ?? graphGrade.value) : '待判定'
)

/* ---------------------------------------------------------------- 分层 */

/**
 * 按服务端的 `layer` 分行（**不自己遍历**）。
 * 同一层内按「章节名 → kp_id」排：顺序只与数据有关，不随返回顺序抖动
 * （与学习档案里的学习地图同一口径）。
 */
const layers = computed(() => {
  const buckets = new Map<number, GraphNode[]>()
  for (const node of nodes.value) {
    const layer = Number.isInteger(node.layer) ? node.layer : 0
    const bucket = buckets.get(layer)
    if (bucket) bucket.push(node)
    else buckets.set(layer, [node])
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([layer, list]) => ({
      layer,
      nodes: [...list].sort(
        (a, b) =>
          (a.chapterTitle || '').localeCompare(b.chapterTitle || '') || a.kpId.localeCompare(b.kpId)
      )
    }))
})

/** 层号文案：0 层是「没有前置」的入口知识点，直接叫入口比 `layer 0` 好读。 */
function layerLabel(layer: number): string {
  return layer === 0 ? '入口' : `第 ${layer} 层`
}

/** 「快速定位」的可选节点：整张图的节点，按图层 → kp_id（与画布顺序一致）。 */
const quickNodes = computed(() => layers.value.flatMap((layer) => layer.nodes))

/* ---------------------------------------------------------------- 高亮 */

/**
 * 与选中知识点相连、**且方向与当前视图一致**的边。
 *
 * ★ 方向只影响这里（高亮谁），不影响画布上任何一条边的写法：
 *   `successor` → `from === 选中`（它的后继）；`prerequisite` → `to === 选中`（它的前置）。
 */
const focusedEdges = computed(() => {
  const kpId = focus.value
  if (!kpId) return []
  return view.value === 'successor'
    ? edges.value.filter((edge) => edge.fromKpId === kpId)
    : edges.value.filter((edge) => edge.toKpId === kpId)
})

/** 高亮边的集合（键与画布上一致：`from>to`）。 */
const focusedKeys = computed(
  () => new Set(focusedEdges.value.map((edge) => `${edge.fromKpId}>${edge.toKpId}`))
)

const directionLabel = computed(() =>
  view.value === 'successor' ? '后继（学完能学什么）' : '前置（要先会什么）'
)

/** 浮层跟随当前选中节点；节点被换掉（换学段）时回落到 `null`，整块不渲染。 */
const focusedNode = computed(() => nodeByKp.value.get(focus.value) ?? null)

/**
 * 选中节点后沿一条边走到另一端：后继视图走向 `to`，前置视图走向 `from`。
 * 高亮方向保持不变 —— 学生是在"顺着链往下看"或"逆着链往回看"。
 */
function walkTo(edge: GraphEdge) {
  focus.value = view.value === 'successor' ? edge.toKpId : edge.fromKpId
}

/* ---------------------------------------------------------------- 取数 */

/**
 * 学段 → 图 + 画像。
 *
 * ★ **不猜学段**：`currentGrade` 为 `null`（还没判定出来）时不发请求 ——
 *   拿一个默认学段去查会画出**别的学段**的图，比空着更糟（界面上会显示"待判定"）。
 * ★ `loadProfile` 是幂等的（已取到就不再发），所以每次学段变化顺手刷一遍画像的成本很低。
 */
watch(
  () => chat.currentGrade,
  (grade) => {
    if (!grade) return
    void study.loadGraph(grade)
    void insight.loadProfile()
  },
  { immediate: true }
)

/** 图变了：焦点若已不在图里（换学段 / 首次到位），落到 0 层的第一个入口知识点。 */
watch(
  nodes,
  (list) => {
    if (list.length === 0) {
      focus.value = ''
      return
    }
    if (focus.value && list.some((node) => node.kpId === focus.value)) return
    const entry = [...list].sort((a, b) => a.layer - b.layer || a.kpId.localeCompare(b.kpId))[0]
    focus.value = entry ? entry.kpId : ''
  },
  { immediate: true }
)

/* ---------------------------------------------------------------- 连线层 */

/**
 * ── 连线层 ──────────────────────────────────────────────────────────────
 * 分层布局里节点会**换行**（一层的知识点数量不定），所以连线位置无法靠公式算，
 * 只能渲染后**测量真实 DOM 位置**再画。
 *
 * 做法：
 *   ① 每个节点挂一个 ref 登记到 nodeEls；
 *   ② 分层 / 高亮 / 选中变化后，等一帧让布局稳定，再量每个节点的 rect；
 *   ③ 换算成 SVG 局部坐标，生成贝塞尔路径；
 *   ④ 用 ResizeObserver 盯住画布，字体加载完、窗口缩放、换行变化都能跟上。
 *
 * 箭头方向**不写死**：`from` 是前置、`to` 是后继（语义固定），落笔时按两端真实几何相接。
 */
const svgRef = ref<SVGSVGElement | null>(null)
const nodeEls = new Map<string, HTMLElement>()

/** 函数式 ref：登记/注销节点元素 */
function bindNode(kpId: string) {
  return (el: unknown) => {
    if (el instanceof HTMLElement) nodeEls.set(kpId, el)
    else nodeEls.delete(kpId)
  }
}

interface EdgePath {
  key: string
  d: string
  /** 与当前选中节点相连（且方向与视图一致）的边 —— 加墨，让"这个点连到哪"一眼可见 */
  hot: boolean
  relation: string
}

const edgePaths = ref<EdgePath[]>([])

/** 两个矩形之间连线的起止点：从**相对的那条边**出发，不穿模 */
function anchors(a: DOMRect, b: DOMRect) {
  const acx = a.left + a.width / 2
  const acy = a.top + a.height / 2
  const bcx = b.left + b.width / 2
  const bcy = b.top + b.height / 2
  const dx = bcx - acx
  const dy = bcy - acy
  // 纵向差更大 → 上下相接；否则左右相接
  if (Math.abs(dy) >= Math.abs(dx)) {
    const down = dy > 0
    return {
      x1: acx,
      y1: down ? a.bottom : a.top,
      x2: bcx,
      y2: down ? b.top : b.bottom,
      vertical: true
    }
  }
  const right = dx > 0
  return {
    x1: right ? a.right : a.left,
    y1: acy,
    x2: right ? b.left : b.right,
    y2: bcy,
    vertical: false
  }
}

function measure() {
  const svg = svgRef.value
  if (!svg) return
  const base = svg.getBoundingClientRect()
  // 画布还没撑开（比如刚切过来第一帧）时不画，等下一次 remeasure
  if (base.width === 0 || base.height === 0) return

  const hot = focusedKeys.value
  const paths: EdgePath[] = []
  for (const edge of edges.value) {
    const na = nodeEls.get(edge.fromKpId)
    const nb = nodeEls.get(edge.toKpId)
    if (!na || !nb) continue
    const p = anchors(na.getBoundingClientRect(), nb.getBoundingClientRect())
    // 局部坐标
    const x1 = p.x1 - base.left
    const y1 = p.y1 - base.top
    const x2 = p.x2 - base.left
    const y2 = p.y2 - base.top
    // 三次贝塞尔：控制点沿相接方向外推。
    // 外推量取"距离的 45% 与 24px 中的较大者"——短连线因此也有足够的弧度，
    // 不会退化成一条贴着卡片边缘的硬折角。
    const d = p.vertical
      ? (() => {
          const k = Math.max(Math.abs(y2 - y1) * 0.45, 24) * (y2 > y1 ? 1 : -1)
          return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`
        })()
      : (() => {
          const k = Math.max(Math.abs(x2 - x1) * 0.45, 24) * (x2 > x1 ? 1 : -1)
          return `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`
        })()
    const key = `${edge.fromKpId}>${edge.toKpId}`
    paths.push({ key, d, hot: hot.has(key), relation: edge.relation })
  }
  edgePaths.value = paths
}

async function remeasure() {
  await nextTick()
  // 再等一帧：换行与字体度量要等浏览器完成布局才准
  requestAnimationFrame(() => measure())
}

/**
 * 观测对象是 **SVG 自己**（真实 DOM 元素），不是外层 SurfacePanel ——
 * Vue 的模板 ref 挂在组件上拿到的是组件实例而非元素，`observe()` 会直接抛错。
 * SVG 铺满画布，尺寸变化它就变，正好当观测点。
 */
let ro: ResizeObserver | null = null
onMounted(() => {
  void remeasure()
  if (svgRef.value) {
    ro = new ResizeObserver(() => void remeasure())
    ro.observe(svgRef.value)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

/** 分层 / 高亮 / 选中变化都要重测（节点集合与位置都会变） */
watch([layers, focus, view], () => void remeasure())

/* ---------------------------------------------------------------- 导出 */

/**
 * 导出当前学段的**全部依赖边**为 CSV。
 *
 * ★ 导出的是真实数据（来自 `GET /api/graph/overview`），不是界面投影：
 *   列里 `from` / `to` 保留原始语义（**from 是前置**），不随视图翻转 —— 与画布上的规则一致。
 * ★ 回执只是一个计数与文件名，**不设自动消失的定时器**（本版不做装饰性动效/假进度）。
 */
const exported = ref<{ rows: number; fileName: string } | null>(null)

function exportCsv() {
  if (edges.value.length === 0) return
  const header = 'from,to,relation,weight'
  const rows = edges.value.map(
    (edge) => `${edge.fromKpId},${edge.toKpId},${edge.relation},${edge.weight}`
  )
  const csv = [header, ...rows].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const fileName = `dependency-edges-${graphGrade.value ?? 'unknown'}.csv`
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
  exported.value = { rows: rows.length, fileName }
}
</script>

<template>
  <div class="dg">
    <!-- 页面级操作：视图切换 + 导出。
         `from` / `to` 的语义说明是**科普文本**，已收进下方附录（默认折叠），
         不再挤在这一行里与身份行抢宽度。

         `#info` 留一句**规模读数**（与身份行的 meta「数据来源」不重复）：
         全站约定是「说明在左、操作在右」，这一槽为空时 `.pa__info:empty` 会整个
         收掉、操作会被挤到左边，与其它页不一致。 -->
    <PageActions>
      <template #info>
        <span>{{ gradeLabel }}图谱含 {{ nodes.length }} 个知识点 · {{ edges.length }} 条依赖边</span>
      </template>
      <el-segmented v-model="view" :options="VIEWS" size="small" />
      <el-button :disabled="edges.length === 0" @click="exportCsv">
        <Check v-if="exported" :size="14" />
        <Download v-else :size="14" />
        <span class="btn__label">{{ exported ? '已导出' : '导出依赖边' }}</span>
      </el-button>
    </PageActions>

    <PageIdentity
      main="一个知识点，卡在它的前置上就学不动"
      meta="节点、分层与依赖边都来自本地知识库（kb.sqlite）"
      hint="先点一个知识点，再看它两侧的边 —— 切「前置 / 后继」换看的方向"
    />

    <!-- 还没判定出学段：**不猜**一个去查图（那会画出别的学段的图），如实说清怎么才会有。 -->
    <EmptyState
      v-if="!chat.currentGrade && !study.graph"
      tone="empty"
      title="还没判定出学段"
      desc="依赖图按学段分开。先在对话里问几句（或到设置里手动指定学段），系统判定出学段后这里就会画出对应的知识结构。"
    />

    <template v-else>
      <!-- 取数失败（sidecar 没起来 / 端点报错）：一句可读中文，不让画布静默空着。 -->
      <EmptyState
        v-if="study.errors.graph"
        tone="error"
        title="依赖图没取上来"
        :desc="study.errors.graph"
      />
      <EmptyState v-else-if="study.loading.graph && nodes.length === 0" tone="loading" title="正在读取知识结构…" />

      <!-- 服务端没有这一学段的知识点：如实说清"库里还没有"，而不是画一张空图 -->
      <EmptyState
        v-else-if="nodes.length === 0"
        tone="empty"
        title="这个学段还没有知识点依赖"
        desc="知识库里这个学段还没有编入知识点，或依赖边还没建。检查「教材知识库」页的导入与重建索引。"
      />

      <template v-else>
        <!-- 导出回执：导了多少条、写进了哪个文件（没有自动消失的定时器）。 -->
        <p v-if="exported" class="dg__done">
          已导出 {{ exported.rows }} 条依赖边 → <code>{{ exported.fileName }}</code>
        </p>

        <!-- 快速定位：**留在画布上方而不是收进附录**。
             它是主路径的第一步（hint 里那句「先点一个知识点」），是操作不是科普 ——
             收进默认折叠的说明区，就等于把"怎么开始"藏了起来。
             单行 chips，不占画布宽度。 -->
        <div class="quick">
          <Search :size="14" class="quick__ic" />
          <span class="quick__l">快速定位</span>
          <button
            v-for="node in quickNodes"
            :key="node.kpId"
            type="button"
            class="quick__b"
            :class="{ 'quick__b--on': focus === node.kpId }"
            @click="focus = node.kpId"
          >
            {{ node.name || node.kpId }}
          </button>
        </div>

        <!-- 画布舞台：只装「画布 + 浮动检查器」两件事。
             检查器 absolute 叠在右上角，因此**不占画布宽度** —— 画布是全幅的。 -->
        <div class="dg__stage">
          <SurfacePanel class="dg__canvas">
            <!-- 当前方向上没有相邻边：这不是错误（依赖图是"部分有序"的），
                 但要说清是"它就到头了"还是"图上没连"，免得学生以为图坏了。
                 ⚠️ 画布**仍然画整张图** —— 这里只是一句说明，不替换画布。 -->
            <p v-if="focusedEdges.length === 0" class="dg__none" data-testid="dependency-none">
              「{{ nameOf(focus) }}」在{{ view === 'successor' ? '后继' : '前置' }}方向上没有依赖边 ——
              {{ view === 'successor' ? '它是这条链的末端' : '它是这条链的起点' }}。
            </p>

            <!-- 连线层：绝对定位铺在画布上，pointer-events 关掉让点击穿过到节点。
                 必须在节点**下面**（z-index 更低），否则线会压住卡片文字。 -->
            <svg ref="svgRef" class="dg__wires" aria-hidden="true">
              <defs>
                <marker
                  id="dg-arrow"
                  viewBox="0 0 8 8"
                  refX="7.5"
                  refY="4"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto"
                >
                  <path class="dg__arrow" d="M 0 0 L 8 4 L 0 8 Z" />
                </marker>
                <marker
                  id="dg-arrow-hot"
                  viewBox="0 0 8 8"
                  refX="7.5"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path class="dg__arrow-hot" d="M 0 0 L 8 4 L 0 8 Z" />
                </marker>
              </defs>
              <path
                v-for="p in edgePaths"
                :key="p.key"
                :d="p.d"
                class="dg__wire"
                :class="{ 'dg__wire--hot': p.hot }"
                :data-rel="p.relation"
                :marker-end="p.hot ? 'url(#dg-arrow-hot)' : 'url(#dg-arrow)'"
              />
            </svg>

            <div v-for="layer in layers" :key="layer.layer" class="layer">
              <div class="layer__rail">
                <span class="layer__badge">{{ layerLabel(layer.layer) }}</span>
              </div>
              <div class="layer__nodes">
                <button
                  v-for="node in layer.nodes"
                  :key="node.kpId"
                  :ref="bindNode(node.kpId)"
                  type="button"
                  class="node"
                  :class="{ 'node--on': focus === node.kpId }"
                  :data-testid="`dependency-node-${node.kpId}`"
                  :data-mastered="node.mastered ? 'true' : 'false'"
                  :data-layer="node.layer"
                  @click="focus = node.kpId"
                >
                  <span class="node__name">{{ node.name || node.kpId }}</span>
                  <span class="node__id">{{ node.kpId }}</span>
                  <span class="node__foot">
                    <!-- `mastered` 是服务端判的（掌握度过阈值），前端不自己算 -->
                    <span class="node__tag" :data-mastered="node.mastered ? 'true' : 'false'">
                      {{ node.mastered ? '已掌握' : '未掌握' }}
                    </span>
                    <span v-if="masteryOf(node.kpId) !== null" class="node__pct">
                      {{ masteryOf(node.kpId) }}%
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </SurfacePanel>

          <!-- ── 浮动检查器（当前节点 + 它在当前方向上的依赖边）────────────────
               它「跟随选中节点」，是**上下文信息**而不是页面的固定结构 ——
               所以做成浮层叠在画布右上角，而不是占一条 330px 的固定右栏。
               好处有二：① 画布拿回全幅宽度（连线节点不再被挤）；
                         ② 视线不必横跨半屏去右栏核对「我刚点的是哪个」。

               ⚠️ 材质用 `tone="float"`（四层材质里的 E4），不自己发明第五种。
               ⚠️ **不是模态**：不做焦点收束（不用 useFocusReturn）、不抢焦点、
                  也不拦 Esc —— 它只是一块常驻的展示面板。 -->
          <SurfacePanel
            v-if="focusedNode"
            class="insp"
            tone="float"
            :padding="'var(--k12-sp-3)'"
            data-testid="dependency-inspector"
          >
            <header class="insp__head">
              <Layers :size="14" />
              <span class="insp__title">当前知识点</span>
              <span class="insp__meta">{{ directionLabel }}</span>
            </header>

            <!-- 选中节点名 14px：**低于**身份行 22px，也与画布节点同档 ——
                 它是「我刚才点了啥」的回执，不是这一页的主角。 -->
            <p class="insp__name">{{ focusedNode.name || focusedNode.kpId }}</p>
            <code class="insp__id">{{ focusedNode.kpId }}</code>
            <p class="insp__hint">点任意节点即可切换高亮的中心</p>

            <dl class="insp__kv">
              <div class="insp__row">
                <dt>掌握度</dt>
                <dd>{{ masteryOf(focusedNode.kpId) ?? '—' }}{{ masteryOf(focusedNode.kpId) !== null ? '%' : '' }}</dd>
              </div>
              <div class="insp__row">
                <dt>状态</dt>
                <dd>
                  <span class="insp__tag" :data-mastered="focusedNode.mastered ? 'true' : 'false'">
                    {{ focusedNode.mastered ? '已掌握' : '未掌握' }}
                  </span>
                </dd>
              </div>
              <div class="insp__row">
                <dt>分层</dt>
                <dd>
                  <span class="insp__dim">{{ layerLabel(focusedNode.layer) }}</span>
                  <span class="insp__dim">（服务端按最长前置链算）</span>
                </dd>
              </div>
              <div class="insp__row">
                <dt>章节</dt>
                <dd>{{ focusedNode.chapterTitle || '—' }}</dd>
              </div>
              <div class="insp__row">
                <dt>学段</dt>
                <dd>{{ GRADE_LABELS[focusedNode.gradeLevel] ?? focusedNode.gradeLevel }}</dd>
              </div>
              <div class="insp__row">
                <dt>用作</dt>
                <dd>推荐路径 + 检索扩展</dd>
              </div>
            </dl>

            <!-- 依赖边清单：从这里可以直接沿一条边走到它的另一端。
                 ⚠️ 结构上分成「小节头（不动） + 清单（可滚）」：
                    边数随图谱增长，而上面的"当前节点"信息必须始终可见 ——
                    让整个浮层滚动的话，用户滚两下就看不见自己点的是谁了。 -->
            <div class="insp__sep" />
            <div class="insp__edges">
              <header class="insp__head insp__head--sub">
                <GitBranch :size="14" />
                <span class="insp__title">{{ view === 'successor' ? '后继边' : '前置边' }}</span>
                <span class="insp__meta">{{ focusedEdges.length }} 条</span>
              </header>
              <div class="edges">
                <!-- 显示中文名而不是 kp_id：id 对使用者没有意义，
                     需要精确 id 时看 title（也方便核对数据）。整行可点，沿边走到另一端。 -->
                <button
                  v-for="edge in focusedEdges"
                  :key="`${edge.fromKpId}>${edge.toKpId}`"
                  type="button"
                  class="edge"
                  :title="`${edge.fromKpId} → ${edge.toKpId}`"
                  @click="walkTo(edge)"
                >
                  <span class="edge__name">{{ nameOf(edge.fromKpId) }}</span>
                  <span class="edge__arrow">→</span>
                  <span class="edge__name">{{ nameOf(edge.toKpId) }}</span>
                  <span class="edge__rel">{{ edge.relation === 'prerequisite' ? '前置边' : '相关边' }}</span>
                </button>
                <p v-if="focusedEdges.length === 0" class="edges__none">
                  这个方向上没有依赖边。
                </p>
              </div>
            </div>
          </SurfacePanel>
        </div>
      </template>
    </template>

    <!-- ── 附录：科普性说明 ──────────────────────────────────────────────
         它们是「这一页背后的规则」，不是每次都要读的上下文 ——
         所以收进折叠区、**默认折叠**，不抢画布高度。
         放在画布**下方**：先看画布（主对象），读完了想深究再往下展开。

         ⚠️ 用 el-collapse 而不是自写手风琴：EP 的折叠有正确的
            `aria-expanded` / 键盘语义，且 `--el-transition-duration: 0s`
            已在 base.css 里把展开动画归零（本版不做装饰性动效）。 -->
    <SurfacePanel class="appendix" :padding="'0 var(--k12-sp-4)'">
      <el-collapse class="appendix__collapse">
        <el-collapse-item name="rules">
          <template #title>
            <span class="appendix__t">依赖关系怎么读 · 用途与约束</span>
          </template>
          <div class="appendix__grid">
            <section class="appendix__sec">
              <h3 class="appendix__h">关系语义</h3>
              <p class="appendix__p">
                每条边写成 <code>from → to</code>，含义固定为
                <code>from</code> 是<strong>前置</strong>、<code>to</code> 是<strong>后继</strong>
                —— 全项目一致，不随视图翻转。切到「前置视图」只是改**高亮哪一侧的边**，
                边的书写方向不变（翻转会读成"数据与特征 是 图像分类 的前置"，与事实相反）。
              </p>
              <p class="appendix__p">
                分层（<code>layer</code>）由服务端按**最长前置链**算好：0 层是没有前置的入口知识点。
                谁在什么位置、有没有掌握，都在服务端的返回里，前端只负责画。
              </p>
            </section>
            <section class="appendix__sec">
              <h3 class="appendix__h">分层与高亮</h3>
              <p class="appendix__p">
                每行是一层，层号来自服务端；同一层内按章节名聚簇、再按
                <code>kp_id</code> 排，保证每次渲染顺序稳定（不依赖返回顺序）。
              </p>
              <p class="appendix__p">
                与选中知识点相连、且方向与当前视图一致的边用学段墨色加粗（这是唯一的"高亮"手段，
                本版不做动效）；虚线表示<strong>相关边</strong>，实线表示<strong>前置边</strong>。
                其余边照常画出来 —— 它们是这张图的结构，只是不着墨。
              </p>
            </section>
            <section class="appendix__sec">
              <h3 class="appendix__h">用途与约束</h3>
              <ul class="notes">
                <li>依赖图同时服务「推荐路径规划」与「检索上下文扩展」，两个用途都保留。</li>
                <li>服务端沿依赖图展开时带 depth 上限防环；导入阶段用 DFS 检测环。</li>
                <li>扩展只作补充上下文，且有数量上限。</li>
                <li>悬空 <code>to_kp_id</code> 报错而非静默跳过。</li>
              </ul>
            </section>
          </div>
        </el-collapse-item>
      </el-collapse>
    </SurfacePanel>
  </div>
</template>

<style scoped>
.dg {
  padding: 18px 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* 吸顶对齐：PageActions 靠负外边距抵消页面内边距，
   这里的值必须与 .dg 的 padding **保持一致**（否则吸住时会错位一行）。
   ⚠️ 改 .dg 的 padding 就必须同步改这两个变量。 */
.dg :deep(.pa) {
  --pa-pad-y: 18px;
  --pa-pad-x: 22px;
}
/* 代码 / 标识是 meta → 12px（判据：11px 只留给 ≤4 字的角标）。
 * 本页的标识类元素：附录与回执里的 `code`。
 * （选中节点的 id 在 `.insp__id` 里单独定，同样 12px。） */
.dg__done code,
.notes code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
}
.btn__label {
  margin-left: 6px;
}
/* 导出回执：一行 meta（不占版面，也不做自动消失的定时器） */
.dg__done {
  font-size: var(--k12-fs-xs);
  color: var(--k12-good);
}
.dg__done code {
  padding: 1px 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}

/* ── 画布舞台 ─────────────────────────────────────────────────────────────
 * **全幅画布**：原来这里是 `grid-template-columns: minmax(0, 1fr) 330px`，
 * 一条 330px 的固定右栏把画布挤窄，而右栏里装的却是四块说明面板 ——
 * 结果「标签比内容重」（右栏标题 16px vs 画布节点 13px）。
 *
 * 现在画布占满内容区宽度，检查器 absolute 叠在右上角（**不占位**）。
 * `position: relative` 是给检查器定位用的。高度由画布自己撑（见 .dg__canvas）。 */
.dg__stage {
  position: relative;
  /* ★ 检查器宽度**只有一个来源**：下面 `.dg__stage > .insp` 用它定宽，
   *   而 `:has(.insp)` 那条用它算「节点要避让多少」。
   *   两处各写一个 264px 的话，改一处忘一处就会重新压住节点。 */
  --insp-w: 264px;
}

.dg__canvas {
  display: flex;
  flex-direction: column;
  /* 层间留出连线的走线空间：太小的话线只能挤出 10px 的折角，等于看不见 */
  gap: 30px;
  /* 连线层要相对它定位 */
  position: relative;
  /* 下限：空态与单层图也有足够的体积，浮层不会顶到画布外。
     同时保证 ResizeObserver 第一帧能拿到非零尺寸（否则不画线）。 */
  min-height: 420px;
}

/* 方向上的"到头了"说明：12px meta，压在画布顶部（不替换画布） */
.dg__none {
  padding: 8px 11px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

/* ── 连线层 ──────────────────────────────────────────────────────────────
 * 绝对定位铺满画布，**指针事件关掉** —— 否则线会挡住节点点击。
 * z-index 比节点低：线在卡片下面，不压文字。 */
.dg__wires {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
  overflow: visible;
}
.dg__wire {
  fill: none;
  stroke: var(--k12-border-strong);
  stroke-width: 1.5;
}
/* 与当前选中节点相连（且方向一致）的边：用学段墨色加粗，一眼看出"这个点连到哪" */
.dg__wire--hot {
  stroke: var(--k12-accent);
  stroke-width: 2;
}
/* 相关边（非前置）用虚线，与前置边区分 —— 语义不同的两类边不该长得一样 */
.dg__wire[data-rel='related'] {
  stroke-dasharray: 4 3;
}
.dg__arrow {
  fill: var(--k12-border-strong);
}
.dg__arrow-hot {
  fill: var(--k12-accent);
}

/* 节点层要盖在连线之上 */
.layer {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.layer__rail {
  width: 64px;
  flex: none;
  padding-top: 8px;
}
.layer__badge {
  display: inline-block;
  padding: 3px 8px;
  white-space: nowrap;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-micro);
}
.layer__nodes {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  /* 同层节点之间也要留出走线空间 */
  gap: 24px;
}

/* ★★ 检查器**是浮层**（不占画布宽度），但节点**不能流到它底下** ——
 * 这是实测截图抓到的层级错误：右上角那一列节点被检查器盖住，
 * 卡片只露出一半，kp_id 被裁成「algor…」，看着像画布坏了。
 *
 * 修法：检查器在时，给节点行留出等宽的右内边距，让它提前换行。
 * 用 `:has()` 而不是给模板加类 —— 「节点要不要避让」完全由「检查器在不在」决定，
 * 两件事写在两处就会不同步。`:has()` 在本机 Electron（Chromium 152）可用；
 * ⚠️ 万一失效，退回的是**原样覆盖**（不是更坏的状态）。
 * `--k12-sp-4` 是检查器自己的右偏移，再加一份做间隔。 */
.dg__stage:has(> .insp) .layer__nodes {
  padding-right: calc(var(--insp-w) + var(--k12-sp-4) * 2);
}
.node {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 170px;
  padding: 11px 12px;
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
  .node:hover {
    border-color: var(--k12-accent-ink);
  }
}
.node--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-ink);
}
/* ★ 节点是这一页的**主对象**：14px / 650。
 * 之前是 13px，而右栏「当前根节点」标题 16px —— 标签比内容重。
 * 现在节点 ≥14px（与正文同级、字重更高），任何侧栏 / 浮层的标签都不得压过它。
 * ⚠️ 这是本页的焦点规则：不要为了"塞下更多标签"把节点降回 13px。 */
.node__name {
  font-size: var(--k12-fs-md);
  font-weight: 650;
  color: var(--k12-fg);
}
/* kp_id 是长标识（meta）→ 12px。节点名 14px/650 仍在层级之上 */
.node__id {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.node__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
}
/* 掌握状态标签（「已掌握」「未掌握」是 3 字角标）→ 12px，扫读为主 */
.node__tag {
  padding: 2px 7px;
  border-radius: var(--k12-r-flat);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  background: var(--k12-surface-2);
  color: var(--k12-muted);
}
.node__tag[data-mastered='true'] {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
/* 掌握度百分比是读数（meta）→ 12px */
.node__pct {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg-2);
}

/* ── 浮动检查器（E4 浮层）─────────────────────────────────────────────────
 * 叠在画布右上角：不占画布宽度，且**离"刚点的那个节点"最近的那一角**。
 * 选右上而不是左上，是因为分层图从左侧 rail 起排、入口节点在左上，
 * 浮层压过去会挡住"从哪开始看"的那个点；右上通常是链路末端的空白。
 *
 * `max-height` + 内部滚动：依赖边多的节点能列十几条，
 * 不设上限会顶出画布、把浮层变成一堵墙。
 * 它**不是模态**：不收束焦点、不拦 Esc（那会让人以为整页被锁住）。
 *
 * ⚠️ 选择器写成 `.dg__stage > .insp` 而不是裸 `.insp`：SurfacePanel 自带的
 *    `.sf { position: relative }` 与本条是**同等特异性**，谁生效取决于打包后的
 *    CSS 插入顺序（不稳定）。加上一级父选择器后本条必然胜出，
 *    浮层的位置不再依赖打包顺序。 */
.dg__stage > .insp {
  position: absolute;
  top: var(--k12-sp-4);
  right: var(--k12-sp-4);
  z-index: 3;
  width: var(--insp-w);
  max-height: calc(100% - var(--k12-sp-7));
  display: flex;
  flex-direction: column;
  gap: 7px;
  /* ⚠️ 浮层本身**不滚**，只让底部的边清单滚（见 .insp__edges / .edges）。
   * 整层滚动会让"当前节点"跟着滚走 —— 用户点了一个节点、滚两下之后
   * 就看不见自己点的是谁了，面板失去意义。 */
  overflow: hidden;
}
/* 边清单区：小节头固定、清单可滚。`min-height: 0` 是 flex 子项能收缩的前提 ——
 * 少了它，这个块会按内容高度撑开，内层永远滚不起来（浮层会先被撑破）。 */
.insp__edges {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-height: 0;
}
.insp__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--k12-muted);
}
/* 13px：不得压过画布节点的 14px —— 它只是浮层的分组标签。 */
.insp__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.insp__head--sub {
  margin-top: 2px;
}
.insp__meta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
/* 选中节点名 14px：明显低于身份行的 22px，且与它所描述的那个节点**同档** ——
 * 它是"我刚点了啥"的回执，不是主角。
 * ⚠️ 不得升回 16px 以上；也不要用 --k12-fs-title（15px）——
 *    契约里那个档位**只给顶栏页面名（chrome）**，不得用于内容区。 */
.insp__name {
  font-size: var(--k12-fs-md);
  font-weight: 650;
  color: var(--k12-fg);
  line-height: var(--k12-lh-snug);
}
.insp__id {
  align-self: flex-start;
  padding: 2px 7px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  /* 长 kp_id 不换行会把浮层顶宽 */
  word-break: break-all;
}
.insp__hint {
  margin-top: -2px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.insp__kv {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.insp__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.insp__row dt {
  flex: none;
  width: 52px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.insp__row dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg-2);
}
.insp__tag {
  padding: 1px 7px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.insp__tag[data-mastered='true'] {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.insp__dim {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  font-weight: 400;
}
/* 浮层内部的分隔：检查器（上下文回执）与边清单（可操作列表）是两件事 */
.insp__sep {
  height: 1px;
  margin: 3px 0 1px;
  background: var(--k12-border);
}

/* 边清单：**唯一可滚**的一段。
 * 它是"随图谱增长"的那部分，让它在浮层内部滚动，
 * 而不是把整个浮层（连同"当前节点"）一起滚走。 */
.edges {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-height: 0;
  overflow-y: auto;
  /* 滚动时留一点右侧余量，免得滚动条压住边名 */
  padding-right: 2px;
}
.edges__none {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}
.edge {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  width: 100%;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: var(--k12-r-inset);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .edge:hover {
    background: var(--k12-surface-2);
    border-color: var(--k12-border);
  }
}
.edge__name {
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg-2);
}
.edge__arrow {
  color: var(--k12-accent-ink);
  font-weight: 700;
}
.edge__rel {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ── 附录：科普说明（默认折叠）────────────────────────────────────────────
 * 折叠标题 13px、内容 12px —— 它是附录，不与画布争字号。
 * `padding` 由 SurfacePanel 的属性传入（留白交给折叠头自己控制），
 * 这里只去掉 EP 折叠自身的两条边框（外层 SurfacePanel 已有卡边框）。 */
.appendix__collapse {
  border: none;
}
.appendix__collapse :deep(.el-collapse-item__header),
.appendix__collapse :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}
.appendix__collapse :deep(.el-collapse-item__header) {
  min-height: 44px;
  line-height: var(--k12-lh-ui);
}
.appendix__collapse :deep(.el-collapse-item__content) {
  padding-bottom: var(--k12-sp-4);
}
.appendix__t {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 三栏并排：用 flex + flex-basis 而不是 `auto-fit` 网格 ——
 * `auto-fit` 会被静态布局审计归类成「规格密排」页（那是规格页的骨架），
 * 而这一页的骨架是**全幅画布**，不该因为一个附录里的排版技巧被改名。
 * 窄了自动换行，附录不该出横向滚动条。 */
.appendix__grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k12-sp-5);
}
.appendix__sec {
  flex: 1 1 260px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.appendix__h {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.appendix__p {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.appendix__p code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.appendix__p strong {
  font-weight: 650;
  color: var(--k12-fg);
}

.notes {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.notes li {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.notes code {
  color: var(--k12-accent-ink);
}
/* ── 快速定位（画布上方的一行 chips）────────────────────────────────────── */
.quick {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.quick__ic {
  color: var(--k12-muted);
  flex: none;
}
.quick__l {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  margin-right: 2px;
}
/* 按钮文字是 meta → 12px（判据：11px 只给 ≤4 字的角标） */
.quick__b {
  padding: 4px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .quick__b:hover {
    border-color: var(--k12-accent-ink);
  }
}
.quick__b--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
  font-weight: 650;
}
</style>
