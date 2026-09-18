<script setup lang="ts">
/**
 * 依赖图谱。
 *
 * ⚠️ 依赖语义全项目一致：**`from` 是前置、`to` 是后继**（方向搞反是静默错）。
 * 后端对应递归 CTE（带 depth 上限防环），这里用等价的 BFS 做前端展示。
 *
 * 两个方向必须都支持，且**不能只换标签不换数据**：
 *  - `successor`：沿 `from === 当前` 向外走 → 看「学完这个能学什么」
 *  - `prerequisite`：沿 `to === 当前` 向外走 → 看「学这个之前要先会什么」
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
// GitCompare 已不再需要：原来「用途与约束」面板改成折叠附录后不再带图标
import { GitBranch, Download, Search, Layers, Check } from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import PageActions from '@/components/PageActions.vue'
import PageIdentity from '@/components/PageIdentity.vue'
import EmptyState from '@/components/EmptyState.vue'
import { dependencyEdges, dependencyNodes, dependencyRoot, mastery, kpNames } from '@/mocks'

/** 图谱里出现的所有 kp（用于按 kp_id 取名） */
const ALL_KP: Record<string, { name: string; grade: 'junior' | 'primary_high' }> = {
  'ph-image-classification': { name: '图像分类', grade: 'primary_high' },
  'jr-data-features': { name: '数据与特征', grade: 'junior' },
  'jr-decision-tree': { name: '决策树', grade: 'junior' },
  'jr-py-variable': { name: '变量', grade: 'junior' },
  'jr-task-types': { name: '分类任务与回归任务', grade: 'junior' },
  'jr-py-loop': { name: '循环', grade: 'junior' },
  'jr-py-list-dict': { name: '列表与字典', grade: 'junior' },
  'jr-neural-basics': { name: '神经网络基础', grade: 'junior' },
  'jr-model-train-eval': { name: '模型训练与评估入门', grade: 'junior' }
}

const VIEWS = [
  { label: '后继视图', value: 'successor' },
  { label: '前置视图', value: 'prerequisite' }
]

const view = ref<'successor' | 'prerequisite'>('successor')
const highlight = ref<string>(dependencyRoot)

/**
 * BFS：按当前方向从选中的 kp 向外逐层展开。
 * 同一层内按 kp_id 排序，保证渲染稳定（不随对象键顺序抖动）。
 */
const graph = computed(() => {
  const dir = view.value
  const start = highlight.value
  const seen = new Map<string, { kpId: string; depth: number; relation: 'prerequisite' | 'related'; via: string }>()
  seen.set(start, { kpId: start, depth: 0, relation: 'related', via: '' })

  let frontier = [start]
  let depth = 0
  // 图上最大深度有限（<10），但显式加上限防脏数据成环
  while (frontier.length && depth < 12) {
    depth += 1
    const next: string[] = []
    for (const cur of frontier) {
      for (const e of dependencyEdges) {
        const [a, b] = dir === 'successor' ? [e.from, e.to] : [e.to, e.from]
        if (a !== cur || seen.has(b)) continue
        seen.set(b, { kpId: b, depth, relation: e.relation, via: cur })
        next.push(b)
      }
    }
    frontier = next
  }

  const nodes = [...seen.values()].sort((a, b) => a.depth - b.depth || a.kpId.localeCompare(b.kpId))

  const layers = new Map<number, typeof nodes>()
  for (const n of nodes) {
    const arr = layers.get(n.depth) ?? []
    arr.push(n)
    layers.set(n.depth, arr)
  }

  // 当前视图下真正被用到的边（只保留相邻层之间、且方向正确的那些）
  //
  // ⚠️ 显示时**始终按 `from` = 前置 → `to` = 后继 的原始语义输出**，
  //    不随视图翻转端点 —— 一翻转就会读成「数据与特征 是 图像分类 的前置」，
  //    与事实正好相反。视图只决定「从根往哪个方向走」，不改边的书写方向。
  const usedEdges = dependencyEdges
    .filter((e) => seen.has(e.from) && seen.has(e.to))
    .filter((e) => {
      const f = seen.get(e.from)!
      const t = seen.get(e.to)!
      // 后继视图：前置在浅层、后继在深层；前置视图：前置在深层
      return view.value === 'successor' ? t.depth === f.depth + 1 : f.depth === t.depth + 1
    })

  return {
    nodes,
    layers: [...layers.entries()].sort((a, b) => a[0] - b[0]).map(([d, ns]) => ({ depth: d, nodes: ns })),
    usedEdges
  }
})

/**
 * ── 连线层 ──────────────────────────────────────────────────────────────
 * 分层布局里节点会**换行**（一层的知识点数量不定），所以连线位置无法靠公式算，
 * 只能渲染后**测量真实 DOM 位置**再画。
 *
 * 做法：
 *   ① 每个节点挂一个 ref 登记到 nodeEls；
 *   ② graph / 视图 / 选中变化后，等一帧让布局稳定，再量每个节点的 rect；
 *   ③ 换算成 SVG 局部坐标，生成贝塞尔路径；
 *   ④ 用 ResizeObserver 盯住画布，字体加载完、窗口缩放、换行变化都能跟上。
 *
 * 箭头方向**不写死**：`from` 是前置、`to` 是后继（语义固定），但前置视图里
 * 前置节点被排在更深的位置，所以箭头会朝上。方向由几何决定，不是假设。
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
  /** 与当前选中节点直接相连的边 —— 高亮它们，让"这个点连到哪"一眼可见 */
  hot: boolean
  relation: 'prerequisite' | 'related'
}

const edgePaths = ref<EdgePath[]>([])
const svgSize = ref({ w: 0, h: 0 })

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
  svgSize.value = { w: base.width, h: base.height }

  const paths: EdgePath[] = []
  for (const e of graph.value.usedEdges) {
    const na = nodeEls.get(e.from)
    const nb = nodeEls.get(e.to)
    if (!na || !nb) continue
    const a = na.getBoundingClientRect()
    const b = nb.getBoundingClientRect()
    const p = anchors(a, b)
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
    paths.push({
      key: `${e.from}>${e.to}`,
      d,
      hot: e.from === highlight.value || e.to === highlight.value,
      relation: e.relation
    })
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

/** 图结构或选中项变化都要重测（节点集合与位置都会变） */
watch([graph, highlight], () => void remeasure())

/**
 * 层号文案：`depth 0` 这种英文代号对使用者没有意义。
 * 0 层是"从它开始看"的那个点，所以直接叫「起点」。
 */
function layerLabel(depth: number) {
  return depth === 0 ? '起点' : `第 ${depth} 层`
}

function nameOf(kpId: string) {
  return ALL_KP[kpId]?.name ?? kpNames[kpId] ?? kpId
}

function masteryOf(kpId: string) {
  const m = mastery.find((x) => x.kpId === kpId)
  return m ? Math.round(m.score * 100) : null
}

/** 可切换的根节点：图谱里出现过的全部 kp */
const quickList = Object.keys(ALL_KP).filter((id) => dependencyNodes.some((n) => n.kpId === id))

/**
 * 操作栏的规模读数（`#info`）。
 * 用 `ALL_KP` 而不是 `quickList`：后者是「可快速定位的根节点」，
 * 会漏掉只在依赖边里出现、没进默认一屏的那些 kp（如小学高年级的「图像分类」）。
 * 这里要说的是图谱**覆盖了多少**，不是"能一键选几个"。
 */
const graphKpCount = Object.keys(ALL_KP).length

const directionLabel = computed(() =>
  view.value === 'successor' ? '后继（学完能学什么）' : '前置（要先会什么）'
)

/**
 * 浮层检查器的数据源 —— **跟随当前选中节点**。
 *
 * ⚠️ 这里的 `direction` 与 `relation` 是两个不同概念，浮层里必须分开写（同上文节点脚注）：
 *  - `direction`：相对当前选中根的**方向**（后继 / 前置），随视图切换 —— 根节点自身无方向
 *  - `relation`：它在当前图谱里那条边的**类型**（前置边 / 相关边）
 */
const selected = computed(() => graph.value.nodes.find((n) => n.kpId === highlight.value) ?? null)

/**
 * 导出当前视图的依赖边为 CSV。
 * 原型阶段就**真的导出**（数据都在前端），不做一个按了没反应的按钮 ——
 * 而且导出的列里 from/to 保留原始语义（from 是前置），不随视图翻转，
 * 与屏幕上的规则一致。
 */
const exported = ref(false)
let exportTimer: number | null = null

function exportCsv() {
  const header = 'from,to,relation,weight'
  const rows = graph.value.usedEdges.map((e) => `${e.from},${e.to},${e.relation},${e.weight}`)
  const csv = [header, ...rows].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `dependency-edges-${view.value}.csv`
  a.click()
  URL.revokeObjectURL(url)
  exported.value = true
  if (exportTimer !== null) clearTimeout(exportTimer)
  exportTimer = window.setTimeout(() => (exported.value = false), 2000)
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
        <span>图谱含 {{ graphKpCount }} 个知识点 · {{ dependencyEdges.length }} 条依赖边</span>
      </template>
      <el-segmented v-model="view" :options="VIEWS" size="small" />
      <el-button @click="exportCsv">
        <Check v-if="exported" :size="14" />
        <Download v-else :size="14" />
        <span class="btn__label">{{ exported ? '已导出' : '导出' }}</span>
      </el-button>
    </PageActions>

    <PageIdentity
      main="一个知识点，卡在它的前置上就学不动"
      meta="依赖边取自 knowledge/manifest.json"
      hint="先选根节点，再切前置 / 后继视图看它两侧"
    />

    <!-- 快速定位（原面板 4）：**留在画布上方而不是收进附录**。
         它是主路径的第一步（hint 里那句「先选根节点」），是操作不是科普 ——
         收进默认折叠的说明区，就等于把"怎么开始"藏了起来。
         单行 chips，不占画布宽度。 -->
    <div class="quick">
      <Search :size="14" class="quick__ic" />
      <span class="quick__l">快速定位</span>
      <button
        v-for="id in quickList"
        :key="id"
        type="button"
        class="quick__b"
        :class="{ 'quick__b--on': highlight === id }"
        @click="highlight = id"
      >
        {{ nameOf(id) }}
      </button>
    </div>

    <!-- 画布舞台：只装「画布 + 浮动检查器」两件事。
         检查器 absolute 叠在右上角，因此**不占画布宽度** —— 画布是全幅的。 -->
    <div class="dg__stage">
      <SurfacePanel class="dg__canvas">
        <!-- 空态：选中的知识点在这个方向上没有相邻节点。
             依赖图是"部分有序"的，末端的知识点确实没有后继 —— 这不是错误。 -->
        <EmptyState
          v-if="graph.usedEdges.length === 0"
          :title="view === 'successor' ? '它是这条链的末端' : '它是这条链的起点'"
          :desc="
            view === 'successor'
              ? `「${nameOf(highlight)}」之后没有更多后继知识点，可以换一个根节点看。`
              : `「${nameOf(highlight)}」之前没有更基础的前置知识点，它就是从零开始的那一课。`
          "
        />

        <template v-else>
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

          <div v-for="layer in graph.layers" :key="layer.depth" class="layer">
            <div class="layer__rail">
              <span class="layer__badge">{{ layerLabel(layer.depth) }}</span>
            </div>
          <div class="layer__nodes">
            <button
              v-for="n in layer.nodes"
              :key="n.kpId"
              :ref="bindNode(n.kpId)"
              type="button"
              class="node"
              :class="{ 'node--on': highlight === n.kpId, 'node--root': n.depth === 0 }"
              @click="highlight = n.kpId"
            >
              <span class="node__name">{{ nameOf(n.kpId) }}</span>
              <span class="node__id">{{ n.kpId }}</span>
              <span class="node__foot">
                <!--
                  两个概念必须分开显示，否则语义会读反：
                  - `direction`：相对当前选中根的**方向**（后继 / 前置）—— 随视图切换
                  - `relation`：这条边的**类型**（前置边 prerequisite / 相关边 related）
                -->
                <span class="node__dir">{{ view === 'successor' ? '后继' : '前置' }}</span>
                <span class="node__rel" :data-rel="n.relation">
                  {{ n.relation === 'prerequisite' ? '前置边' : '相关边' }}
                </span>
                <span v-if="masteryOf(n.kpId) !== null" class="node__pct">{{ masteryOf(n.kpId) }}%</span>
              </span>
            </button>
            </div>
          </div>
        </template>
      </SurfacePanel>

      <!-- ── 浮动检查器（原右栏「当前根节点」+ 依赖边清单）──────────────────
           它「跟随选中节点」，是**上下文信息**而不是页面的固定结构 ——
           所以做成浮层叠在画布右上角，而不是占一条 330px 的固定右栏。
           好处有二：① 画布拿回全幅宽度（连线节点不再被挤）；
                     ② 视线不必横跨半屏去右栏核对「我刚点的是哪个」。

           ⚠️ 材质用 `tone="float"`（四层材质里的 E4），不自己发明第五种。
           ⚠️ **不是模态**：不做焦点收束（不用 useFocusReturn）、不抢焦点、
              也不拦 Esc —— 它只是一块常驻的展示面板。 -->
      <SurfacePanel v-if="selected" class="insp" tone="float" :padding="'var(--k12-sp-3)'">
        <header class="insp__head">
          <Layers :size="14" />
          <span class="insp__title">当前根节点</span>
          <span class="insp__meta">{{ directionLabel }}</span>
        </header>

        <!-- 选中节点名 15px：**低于**身份行 22px，也低于画布节点的 14px 权重竞争 ——
             它是「我刚才点了啥」的回执，不是这一页的主角。 -->
        <p class="insp__name">{{ nameOf(highlight) }}</p>
        <code class="insp__id">{{ highlight }}</code>
        <p class="insp__hint">点任意节点即以它为根重新展开</p>

        <dl class="insp__kv">
          <div class="insp__row">
            <dt>掌握度</dt>
            <dd>{{ masteryOf(highlight) ?? '—' }}{{ masteryOf(highlight) !== null ? '%' : '' }}</dd>
          </div>
          <div class="insp__row">
            <dt>方向 / 关系</dt>
            <dd>
              <!-- 根节点自身没有"方向"，只有"关系"；子节点两者都有。
                   两个概念分开写，否则会读成"这个点是前置"（方向 + 关系混淆）。 -->
              <template v-if="selected.depth === 0">
                <span class="insp__tag">起点</span>
                <span class="insp__tag" :data-rel="selected.relation">
                  {{ selected.relation === 'prerequisite' ? '前置边' : '相关边' }}
                </span>
              </template>
              <template v-else>
                <span class="insp__tag">{{ view === 'successor' ? '后继' : '前置' }}</span>
                <span class="insp__tag" :data-rel="selected.relation">
                  {{ selected.relation === 'prerequisite' ? '前置边' : '相关边' }}
                </span>
                <span class="insp__dim">第 {{ selected.depth }} 层</span>
              </template>
            </dd>
          </div>
          <div class="insp__row">
            <dt>用作</dt>
            <dd>推荐路径 + 检索扩展</dd>
          </div>
        </dl>

        <!-- 依赖边清单（原「依赖边」面板）：从这里可以直接点进任一邻接知识点。
             ⚠️ 结构上分成「小节头（不动） + 清单（可滚）」：
                边数随图谱增长，而上面的"当前节点"信息必须始终可见 ——
                让整个浮层滚动的话，用户滚两下就看不见自己点的是谁了。 -->
        <div class="insp__sep" />
        <div class="insp__edges">
          <header class="insp__head insp__head--sub">
            <GitBranch :size="14" />
            <span class="insp__title">依赖边</span>
            <span class="insp__meta">{{ graph.usedEdges.length }} 条</span>
          </header>
          <div class="edges">
          <!-- 显示中文名而不是 kp_id：id 对使用者没有意义，
               需要精确 id 时看 title（也方便核对数据）。整行可点，选中起点。 -->
          <button
            v-for="e in graph.usedEdges"
            :key="e.from + '>' + e.to"
            type="button"
            class="edge"
            :class="{ 'edge--hot': e.from === highlight || e.to === highlight }"
            :title="`${e.from} → ${e.to}`"
            @click="highlight = e.from"
          >
            <span class="edge__name">{{ nameOf(e.from) }}</span>
            <span class="edge__arrow">→</span>
            <span class="edge__name">{{ nameOf(e.to) }}</span>
            <span class="edge__rel">{{ e.relation === 'prerequisite' ? '前置边' : '相关边' }}</span>
          </button>
          </div>
        </div>
      </SurfacePanel>
    </div>

    <!-- ── 附录：科普性说明（原面板 3/4）─────────────────────────────────
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
                —— 全项目一致，不随视图翻转。切到「前置视图」只是改**从根往哪个方向走**，
                边的书写方向不变（翻转会读成"数据与特征 是 图像分类 的前置"，与事实相反）。
              </p>
              <p class="appendix__p">
                后端用递归 CTE 沿依赖图展开（带 depth 上限防环），此处为等价的前端 BFS。
              </p>
            </section>
            <section class="appendix__sec">
              <h3 class="appendix__h">分层与高亮</h3>
              <p class="appendix__p">
                每行是一层：第 0 层是选中的根节点，往下逐层展开。同一层内按
                <code>kp_id</code> 排序，保证每次渲染顺序稳定。
              </p>
              <p class="appendix__p">
                与选中节点直接相连的边用学段墨色加粗（这是唯一的"高亮"手段，
                本版不做动效）；虚线表示<strong>相关边</strong>，实线表示<strong>前置边</strong>。
              </p>
            </section>
            <section class="appendix__sec">
              <h3 class="appendix__h">用途与约束</h3>
              <ul class="notes">
                <li>依赖图同时服务「推荐路径规划」与「检索上下文扩展」，两个用途都保留。</li>
                <li>导入阶段用 DFS 检测环，防止递归 CTE 死循环。</li>
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
 * 本页的标识类元素：附录里的 `code`、边清单将来的 `from`/`to` 片。
 * （选中节点的 id 在 `.insp__id` 里单独定，同样 12px。） */
.edge__from,
.edge__to,
.notes code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
}
.btn__label {
  margin-left: 6px;
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
/* 与当前选中节点直接相连的边：用学段墨色加粗，一眼看出"这个点连到哪" */
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
  white-space: nowrap;
}
.layer__nodes {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  /* 同层节点之间也要留出走线空间 */
  gap: 24px;
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
.node--root {
  border-width: 2px;
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
/* 关系标签（「后继」「前置边」）是 meta，不是角标 → 12px */
.node__dir,
.node__rel {
  padding: 2px 7px;
  border-radius: var(--k12-r-flat);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.node__dir {
  background: var(--k12-surface-2);
  color: var(--k12-muted);
}
.node__rel[data-rel='prerequisite'] {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.node__rel[data-rel='related'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
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
 * 选右上而不是左上，是因为分层图从左侧 rail 起排、根节点在左上，
 * 浮层压过去会挡住"从哪开始看"的那个点；右上通常是链路末端的空白。
 *
 * `max-height` + 内部滚动：依赖边多的根节点能列十几条，
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
  width: 264px;
  max-height: calc(100% - var(--k12-sp-7));
  display: flex;
  flex-direction: column;
  gap: 7px;
  /* ⚠️ 浮层本身**不滚**，只让底部的边清单滚（见 .insp__edges / .edges）。
   * 整层滚动会让"当前节点"跟着滚走 —— 用户点了一个节点、滚两下之后
   * 就看不见自己点的是谁了，面板失去意义。
   * `overflow: hidden` 同时保证圆角与内部滚动区不打架。 */
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
/* 选中节点名 14px：明显低于身份行的 22px。
 * 原本这里是 16px（--k12-fs-lg），比画布节点还重 —— 那正是"标签比内容重"的来源之一。
 * 现在它与它所描述的那个节点**同档**（节点也是 14px），退成一个"我刚点了啥"的回执。
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
  width: 64px;
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
.insp__tag[data-rel='prerequisite'] {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.insp__tag[data-rel='related'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
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
 * 它是"随图谱增长"的那部分（7 条 → 更多），让它在浮层内部滚动，
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
/* 与当前选中节点相连的边：同样高亮，和画布上的连线呼应 */
.edge--hot {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.edge__name {
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg-2);
}
.edge--hot .edge__name {
  color: var(--k12-accent-ink);
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
