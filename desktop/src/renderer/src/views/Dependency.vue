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
import { BRAND_NAME } from '@shared/brand'
import { useStudyStore, type GraphView } from '../stores/study'
import { useInsightStore } from '../stores/insight'
import { useChatStore } from '../stores/chat'
import { useUiStore } from '../stores/ui'
import { kpLabel, kpLabelResolved } from '../study/kp-label'
import { buildPlanRequestMessage, planRequestDisplayText } from '../study/plan-request'
import { todayStamp } from '../study/export-naming'
import ProgressBar from '../components/ProgressBar.vue'
import TeacherGate from '../components/TeacherGate.vue'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL } from '../labels'

const study = useStudyStore()
const insight = useInsightStore()
const chat = useChatStore()
const ui = useUiStore()

type GraphNode = GraphView['nodes'][number]

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

/**
 * kp_id → 界面上显示的名字。
 *
 * ★★ **绝不显示 slug**（`ai-definition-jr` 这种 id 摆到 10 岁学生面前，看起来像报错）。
 *    完整口径与唯一实现在 `study/kp-label.ts`：有中文名用中文名，取不到就回
 *    「未命名知识点」，**原始 id 只进 `title`**（悬停可见，学生不会被它吓到）。
 */
function nameOf(kpId: string): string {
  return kpLabel(kpId, nodeByKp.value.get(kpId)?.name ?? null, null)
}

/** 名字是否真的取到了（取不到时把原始 id 放进 `title`，见 `study/kp-label.ts`）。 */
function nameResolved(kpId: string): boolean {
  return kpLabelResolved(kpId, nodeByKp.value.get(kpId)?.name ?? null, null)
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

/** 学段名：以**图自己回显的学段**为准（服务端的产物），拿不到才退回 `GRADE_UNKNOWN_LABEL`。 */
const graphGrade = computed(() => study.graph?.gradeLevel ?? null)
const gradeLabel = computed(() =>
  graphGrade.value ? (GRADE_LABELS[graphGrade.value] ?? graphGrade.value) : GRADE_UNKNOWN_LABEL
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

/**
 * ── 快速定位：按**章节**分组 ──────────────────────────────────────────────
 *
 * ★★ 原来是**一整片几十个 chip 平铺**：一个学生想找某个知识点，面对的是
 *    57 个名字排成五六行、没有任何分界的一堆东西 —— 那不是「快速定位」，
 *    那是把整本目录倒在他面前。现在按教材章节分组、可折叠：
 *    · `<details>` / `<summary>` 是**原生**的可折叠控件（键盘 Tab + Enter 就能开合，
 *      不用自己写 aria-expanded 与 keydown —— 自己写就必然有人的实现漏掉一条）；
 *    · 默认只展开**一章**（当前选中的知识点所在章，其次学生正在学的章），
 *      其余收起 —— 一屏之内既看得到结构、也不至于淹掉画布；
 *    · 展开全部 / 收起全部一次给到（平铺的需求仍然被满足，只是不再是默认）。
 *
 * ★ 章节顺序**按章号解析**（`第N章`），不能按字典序（会把「第10章」排到「第2章」前），
 *   也不能按 rowid（本项目实测会排成 1,6,1,3,5,2，见 P-057）。
 */
const chapterGroups = computed(() => {
  const groups = new Map<string, GraphNode[]>()
  for (const node of quickNodes.value) {
    const key = node.chapterTitle || '未分章'
    const bucket = groups.get(key)
    if (bucket) bucket.push(node)
    else groups.set(key, [node])
  }
  return [...groups.entries()]
    .sort((a, b) => chapterNumber(a[0]) - chapterNumber(b[0]) || a[0].localeCompare(b[0]))
    .map(([title, list]) => ({ title, nodes: list }))
})

/** 从「第N章 …」里取 N（取不到给一个大数，排到末尾）。与学习地图同一口径。 */
function chapterNumber(title: string): number {
  const match = /^第\s*(\d+)\s*章/.exec(title.trim())
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

/** 已展开的章节标题（**只有一处真相**：`<details>` 的 `open` 由它派生）。 */
const openChapters = ref<Set<string>>(new Set())

function isChapterOpen(title: string): boolean {
  return openChapters.value.has(title)
}

/**
 * `<details>` 自己会先把 DOM 打开/关上，再抛 `toggle` —— 这里只是**跟上**它的状态。
 * （反向写（先改 state 再靠模板 setAttribute）会出现「点一下闪两下」：
 *  属性与用户操作互相覆盖。）
 */
function onChapterToggle(title: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLDetailsElement)) return
  const next = new Set(openChapters.value)
  if (target.open) next.add(title)
  else next.delete(title)
  openChapters.value = next
}

const allChaptersOpen = computed(
  () =>
    chapterGroups.value.length > 0 &&
    chapterGroups.value.every((group) => openChapters.value.has(group.title))
)

function toggleAllChapters(): void {
  openChapters.value = allChaptersOpen.value
    ? new Set()
    : new Set(chapterGroups.value.map((group) => group.title))
}

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

/** 浮层跟随当前选中节点；节点被换掉（换学段）时回落到 `null`，整块不渲染。 */
const focusedNode = computed(() => nodeByKp.value.get(focus.value) ?? null)

/* ------------------------------------------------- 给学生的两句学习建议 */

/**
 * 「建议先学」= 指向当前知识点的那些边的**起点**（`to === 选中` 的 `from`）。
 * 「学完它就能学」= 从当前知识点出发的那些边的**终点**（`from === 选中` 的 `to`）。
 *
 * ★ 这两句是**同一份依赖数据的学生话版本**（原来浮层里只有「前置边 / 后继边」
 *   这种数据库口吻的标题）：依赖图的用途之一本来就是「推荐下一条路」，
 *   而学生真正要问的是「我该先学什么」「学完这个然后呢」。
 * ★ 方向语义不翻转：`from` 永远是前置、`to` 永远是后继（全项目一致）。
 * ★★ 两张清单**同时显示**，不再按页面的「前置 / 后继」开关各露一半
 *   （2026-10-01 用户裁决）：那个开关此后只决定**画布高亮**哪一侧；
 *   卡片里两种关系都要看得见，否则学生切到哪边就少一半信息。
 *   ⚠️ 早先这里是「只截前 3 个 + 还有 N 个」，而卡片底部另有一份按开关过滤的边列表
 *   —— 同一份数据在一张卡里出现了两次（用户原话「信息密度太大」）。
 *   现在两份截断版与底部那份**合并成两张完整列表**（在内层滚动），一条数据只出现一处。
 * ★ 连同 `relation` 与两端 id 一起带上：行里的关系标注、教师视角的内部 slug 都要用。
 */
interface AdvisedNode {
  kpId: string
  name: string
  relation: string
  fromKpId: string
  toKpId: string
}

function listOf(direction: 'from' | 'to'): AdvisedNode[] {
  const kpId = focus.value
  if (!kpId) return []
  const seen = new Set<string>()
  const list: AdvisedNode[] = []
  for (const edge of edges.value) {
    const other = direction === 'from' ? edge.fromKpId : edge.toKpId
    const own = direction === 'from' ? edge.toKpId : edge.fromKpId
    if (own !== kpId || seen.has(other)) continue
    seen.add(other)
    list.push({
      kpId: other,
      name: nameOf(other),
      relation: edge.relation,
      fromKpId: edge.fromKpId,
      toKpId: edge.toKpId
    })
  }
  return list
}

/** 前置（要先会的）—— 「建议先学」。 */
const prerequisites = computed(() => listOf('from'))
/** 后继（学完能学的）—— 「学完它就能学」。 */
const consequences = computed(() => listOf('to'))

/* ------------------------------------------- 快速定位：默认展开哪一章 */

/**
 * 默认展开：当前选中知识点所在的章 → 学生手动选的当前章 → 第一章。
 *
 * ★ 只在「已展开的章一个都不在图里」时重设（换学段换了教材）——
 *   否则学生手动打开的章会被每一次图刷新关掉，手感像坏了。
 * ⚠️ 这个 watch 必须写在 `focusedNode` **之后**：它 immediate 执行，
 *    放在前面会在取到数据的那一刻读到还没初始化的绑定（TDZ 直接抛）。
 */
watch(
  chapterGroups,
  (groups) => {
    if (groups.length === 0) return
    if (groups.some((group) => openChapters.value.has(group.title))) return
    const preferred = focusedNode.value?.chapterTitle || chat.currentChapter || ''
    const hit = groups.find((group) => group.title === preferred) ?? groups[0]
    openChapters.value = new Set(hit ? [hit.title] : [])
  },
  { immediate: true }
)

/**
 * 主行动「开始学习这个知识点 →」**落在对话页**（与学习档案的「学习地图」
 * `MapTab.vue` 的 `goLearn()` 完全同一条路，理由见那里的注释）：
 *   · 它对**任何**节点都可用（入口知识点可能还没有题库，
 *     而「问一句」永远通）；
 *   · 「学」这件事在本项目里的主场就是对话（7×24 的 AI 教师）；闯关是**检验**；
 *   · ★★ 2026-09-30 用户裁决：**推翻「只预填」**——现在先切到对话页、再直发一条
 *     学习计划请求（学生气泡里是 `planRequestDisplayText` 那句自然话，
 *     真正发给模型的是带 `kp_id` 的 wire 文本，见 `study/plan-request.ts`）。
 *     ⚠️ 错题本的「去练一练」**仍然只预填**：两条路从这里起**不再是同一条纪律**，
 *     别再照搬那一侧的说法。
 *
 * ★ 名字取不到（中性标签）时给 plan-request 传**空串**、而不是占位词 ——
 *   发给模型一句「我想学『未命名知识点』」等于给它一个它认不出的名字；
 *   空串那条路径会退化成不带名字的说法，屏幕上仍是自然的一句。
 */
function goLearn(): void {
  const kpId = focus.value
  if (!kpId) return
  const name = nameResolved(kpId) ? nameOf(kpId) : ''
  ui.show('chat')
  void chat.send(planRequestDisplayText(name), buildPlanRequestMessage(kpId, name))
}

/**
 * ★ 2026-10-01 起，浮层里**不再有**「当前方向」那行说明，也**不再**按开关只显示一侧：
 *   卡片两侧都列（见 `listOf` 的说明），开关只决定**画布高亮**哪一侧。
 *   原来服务「卡片里只有一半数据」的那三块（`directionLabel` / `edgeSectionTitle` /
 *   沿边走的 `walkTo`）一并删除 —— 留着就是界面在撒谎，或纯粹的死代码。
 *   ⚠️ 行本身仍然可点：点一下直接跳到那一端，与原来「沿这条边走过去」**同一个落点**。
 */

/* ---------------------------------------------------------------- 取数 */

/**
 * 学段 → 图 + 画像。
 *
 * ★ **不猜学段**：`currentGrade` 为 `null`（还没判定出来）时不发请求 ——
 *   拿一个默认学段去查会画出**别的学段**的图，比空着更糟（界面上会显示"还没认出年级"）。
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

/**
 * 手动重试：再发一次图请求。
 *
 * ★ 这一页**必须**有它（实测缺陷）：取数只由上面那个 watch 触发，而它的依赖是
 *   `chat.currentGrade` —— 学段不变就永远不会再发一次；本页又挂在 `<KeepAlive>` 里、
 *   也不走 `useOnBackendReady`，切走再切回来组件不重挂 ——
 *   于是「冷启动头几秒（sidecar 还在起）就点进来」会得到一个**点了也没救**的红框。
 * ★ 不需要额外的「强制刷新」参数：`study.loadGraph` 每次都真发请求
 *   （没有「已取到同一学段就短路」那层缓存，那是 `loadChapters` 才有的），
 *   重调一次就是强制刷新。
 */
function retryGraph(): void {
  void study.loadGraph(chat.currentGrade)
}

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
/**
 * 导出失败 / 取消时的一句话状态。
 *
 * ★ 分成两层：`text` 是**给学生读的**一句（说清发生了什么、下一步怎么办），
 *   `tech` 是原始原因（写盘失败的系统消息）—— 后者只在教师视角里出现。
 *   不能把 `写入失败：EPERM: operation not permitted, open 'C:\Users\…'` 这类
 *   原文直接摆到页面上：那是**排障信息**，学生会以为整个软件坏了。
 * ★ `tone: 'canceled'` 与 `'failed'` 分开：取消是学生自己按的（中性灰），
 *   失败才需要他知道（提醒色）。
 */
const exportNotice = ref<{ text: string; tech?: string; tone: 'canceled' | 'failed' } | null>(null)
const exporting = ref(false)

/**
 * 文件名：**给学生看的名字**，不是给程序看的。
 *
 * ★ 之前是 `dependency-edges-junior.csv` —— 界面语言是中文，文件名却是英文 slug，
 *   而那份文件是要交作业 / 发给老师的。现在按「谁生成的 + 哪个学段 + 哪一天」拼：
 *   `智团团-初中学习地图-20260920.csv`。
 * ★ 品牌名**不写死**：从 `@shared/brand` 取（`brand.test.ts` 那条守卫盯着三处同步）。
 * ★ 学段名取 `GRADE_LABELS`（中文标签的唯一来源）；学段还没判定时用「学习地图」
 *   而不是 `unknown` —— 不把内部字面量摆到学生的文件名里。
 * ★ 日期用**本地时区**的 `YYYYMMDD`（不能用 `toISOString()`：它是 UTC，
 *   东八区下午四点之后会写成前一天，学生看到文件名与今天不符）。
 * ★ 整串必须能过 `sanitizeFileName`（中文 / 数字 / `-` 都在白名单里，实测原样通过；
 *   主进程仍会再洗一次，这里只是不做无谓的加工）。
 */
function csvFileName(): string {
  return `${BRAND_NAME}-${gradeLabel.value}学习地图-${todayStamp()}.csv`
}

/* 本地时区的 `YYYYMMDD` 已归口到 `study/export-naming.ts`（学习报告 / 错题本 / 本页
 * 三处导出共用同一份实现 —— 各写一份会在时区口径上分叉，见那个文件的说明）。 */

/**
 * 导出当前学段的**全部依赖边**为 CSV —— 走**主进程的原生保存对话框**。
 *
 * ★★ 为什么不再用 `Blob` + `URL.createObjectURL` + `<a download>`：
 *   在 Electron 里那条路会落到 Chromium 的下载流，**保存对话框的来源栏显示的是
 *   一个 `blob:` 开头的内部地址**（把 dev server 的地址与端口摆给了学生看）——
 *   看着就像坏了，也更像是「从某个网站下载了个东西」。
 *   改走 `file:export`（`dialog.showSaveDialog`），与 Markdown 导出**同一条通道**：
 *   学生自己选路径、系统对话框、回执只有文件名（完整路径不进渲染进程，D-035）。
 * ★ 通道**不新增**：`file:export` 的入参多一个 `extension`（`.md` / `.csv` 白名单），
 *   于是通道总数一个都不动（那份计数被三处守卫与文档盯着）。
 * ★ 导出的是真实数据（来自 `GET /api/graph/overview`），不是界面投影：
 *   列里 `from` / `to` 保留原始语义（**from 是前置**），不随视图翻转 —— 与画布上的规则一致。
 * ★ 回执只是一个计数与文件名，**不设自动消失的定时器**（本版不做装饰性动效/假进度）。
 * ★ 失败与取消**分开说**：取消是学生自己按的（中性一句话），失败才需要他知道
 *   （而且是可照着处理的一句话，不是把原始异常摆出来）。
 */
async function exportCsv(): Promise<void> {
  if (edges.value.length === 0 || exporting.value) return
  const header = 'from,to,relation,weight'
  const rows = edges.value.map(
    (edge) => `${edge.fromKpId},${edge.toKpId},${edge.relation},${edge.weight}`
  )
  // ★ 内容仍然带 BOM：Excel 打开不带 BOM 的 UTF-8 CSV 会把中文读成乱码
  //   （Windows 简中默认按 GBK 解析）。这是**给 CSV 这一种导出物**的必要处理，
  //   不是「前端自己写文件」——写盘仍然只发生在主进程。
  const content = '\uFEFF' + [header, ...rows].join('\n')

  // ★ 与 `stores/chat.ts` 探测推送通道同一条写法：preload 白名单是分步落地的，
  //   缺方法时给一句可照着做的话，而不是抛 `is not a function` 把页面打空。
  const api = window.api
  if (typeof api?.exportMarkdown !== 'function') {
    exportNotice.value = { text: '导出还没接线：保存对话框暂时用不了。', tone: 'failed' }
    return
  }

  exporting.value = true
  exportNotice.value = null
  // ★ 开始新一次导出就把上一次的回执清掉：否则「已导出 xxx.csv」会与这一次的
  //   「没有导出（取消了）」同时挂在页面上 —— 两句话自相矛盾，学生不知道该信哪句。
  exported.value = null
  try {
    const result = await api.exportMarkdown({
      fileName: csvFileName(),
      content,
      extension: '.csv'
    })
    if (result.ok) {
      exported.value = { rows: rows.length, fileName: result.fileName }
      return
    }
    if (result.canceled) {
      // 取消不是错误：说一句「没有导出」就够了，不弹「导出失败」
      exportNotice.value = { text: '没有导出，你在保存对话框里取消了。', tone: 'canceled' }
      return
    }
    // ★ 写盘失败：给学生一句人话（不是把系统的 EPERM / 路径原文摆出来）——
    //   原始原因进 `tech`，只在教师视角里显示。
    exportNotice.value = {
      text: '没能保存这个文件。换个位置（比如桌面）再试一次，或者看看文件是不是正被别的程序占用。',
      tech: result.message,
      tone: 'failed'
    }
  } catch (error) {
    exportNotice.value = {
      text: '没能保存这个文件。保存对话框这次没打开成功，再试一次。',
      tech: error instanceof Error ? error.message : String(error),
      tone: 'failed'
    }
  } finally {
    exporting.value = false
  }
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
      <el-button :loading="exporting" :disabled="edges.length === 0" @click="exportCsv()">
        <Check v-if="exported && !exporting" :size="14" />
        <Download v-else-if="!exporting" :size="14" />
        <span class="btn__label">{{ exported && !exporting ? '已导出' : '导出依赖边' }}</span>
      </el-button>
    </PageActions>

    <PageIdentity
      main="一个知识点，卡在它的前置上就学不动"
      hint="先点一个知识点，再看它两侧的边，切「前置 / 后继」换看的方向"
    />

    <!-- ★ 数据来源那句（「节点、分层与依赖边都来自本地知识库 kb.sqlite」）
         是**引擎证据**（答辩要看），不是给学生读的话 —— 收进教师视角。
         放在身份行**下面**而不是身份行的 meta 位：`PageIdentity` 的 meta 是一个
         字符串 prop（没有对应插槽），而这句话只该在教师视角出现 ——
         塞进 prop 就得在页面里再判一次视角，两处判断迟早不同步。 -->
    <TeacherGate label="数据来源">
      <p class="dg__tech">节点、分层与依赖边都来自本地知识库（kb.sqlite），前端只负责画。</p>
    </TeacherGate>

    <!-- 还没判定出学段：**不猜**一个去查图（那会画出别的学段的图），如实说清怎么才会有。 -->
    <EmptyState
      v-if="!chat.currentGrade && !study.graph"
      tone="empty"
      title="还没判定出学段"
      desc="依赖图按学段分开。先在对话里问几句（或到设置里手动指定学段），系统判定出学段后这里就会画出对应的知识结构。"
    />

    <template v-else>
      <!-- 取数失败（sidecar 没起来 / 端点报错）：一句可读中文 + **重试**，
           不让画布静默空着，也不让这一页变成「只能重启应用」的死胡同。
           按钮文案与 `.disabled` 态与闯关 / 知识库 / 动画三页一致（同一种失败同一套出口）。 -->
      <EmptyState
        v-if="study.errors.graph"
        tone="error"
        title="依赖图没取上来"
        :desc="study.errors.graph"
        data-testid="dependency-error"
      >
        <el-button :disabled="study.loading.graph" @click="retryGraph()">重试</el-button>
      </EmptyState>
      <EmptyState v-else-if="study.loading.graph && nodes.length === 0" tone="loading" title="正在读取知识结构…" />

      <!-- 服务端没有这一学段的知识点：如实说清"库里还没有"，而不是画一张空图。
           ★ 学生看不到「教材知识库」那一页（它已在教师区），所以**不给学生指路到那一页** ——
             指向一个自己进不去的地方，等于让他去找一个不存在的入口。
             处置说明只给教师视角。 -->
      <template v-else-if="nodes.length === 0">
        <EmptyState
          tone="empty"
          title="这个学段还没有知识点依赖"
          desc="这一册教材的知识结构还没来得及编进来。先问问智团团别的内容吧。"
        />
        <TeacherGate label="处置">
          <p class="dg__tech">到「教材知识库」页导入教材并重建索引，这一页就会有内容。</p>
        </TeacherGate>
      </template>

      <template v-else>
        <!-- 导出回执：导了多少条、存进了哪个文件（没有自动消失的定时器）。
             ⚠️ **只显示文件名**：完整路径（含宿主用户名与目录结构）不进渲染进程
                （D-035 / `export-naming.ts` 的契约），主进程也只会回文件名。 -->
        <p v-if="exported" class="dg__done" data-testid="dependency-export-done">
          已导出 {{ exported.rows }} 条依赖边 → <code>{{ exported.fileName }}</code>
        </p>
        <!-- 取消 / 失败：一句可读状态（取消是中性、失败才提醒），不摆原始异常。
             原始原因在下面的教师视角块里（学生读不懂 `EPERM ... open 'C:\…'`）。 -->
        <template v-else-if="exportNotice">
          <p
            class="dg__export-note"
            :data-tone="exportNotice.tone"
            data-testid="dependency-export-note"
          >
            {{ exportNotice.text }}
          </p>
          <TeacherGate v-if="exportNotice.tech" label="导出失败的原始原因">
            <p class="dg__tech">{{ exportNotice.tech }}</p>
          </TeacherGate>
        </template>

        <!-- 快速定位：**留在画布上方而不是收进附录**。
             它是主路径的第一步（hint 里那句「先点一个知识点」），是操作不是科普 ——
             收进默认折叠的说明区，就等于把"怎么开始"藏了起来。

             ★★ 按**章节**分组、可折叠（原来是一片几十个 chip 的平铺）：
                学生找某个知识点时，面对的应该是「在讲哪一章」的目录，不是一堆名字。
             ★ 结构用**原生** `<details>` / `<summary>`：键盘 Tab + Enter 就能开合，
                自带正确的 aria 语义 —— 自己写手风琴就必然有人漏掉一条（本项目踩过）。
             ★ 默认只展开一章（选中节点所在章 / 学生正在学的章），另有「展开全部 / 收起全部」。 -->
        <div class="quick">
          <div class="quick__head">
            <Search :size="14" class="quick__ic" />
            <span class="quick__l">快速定位</span>
            <button
              type="button"
              class="quick__toggle k12-tap"
              data-testid="dependency-quick-toggle-all"
              @click="toggleAllChapters()"
            >
              {{ allChaptersOpen ? '收起全部' : '展开全部' }}
            </button>
          </div>
          <div class="quick__groups" data-testid="dependency-quick-groups">
            <details
              v-for="group in chapterGroups"
              :key="group.title"
              class="qgroup"
              :open="isChapterOpen(group.title)"
              @toggle="onChapterToggle(group.title, $event)"
            >
              <summary class="qgroup__sum k12-tap">
                <span class="qgroup__title">{{ group.title }}</span>
                <span class="qgroup__count k12-unit">{{ group.nodes.length }} 个</span>
              </summary>
              <div class="qgroup__items">
                <button
                  v-for="node in group.nodes"
                  :key="node.kpId"
                  type="button"
                  class="quick__b k12-tap"
                  :class="{ 'quick__b--on': focus === node.kpId }"
                  :title="nameResolved(node.kpId) ? undefined : node.kpId"
                  @click="focus = node.kpId"
                >
                  {{ nameOf(node.kpId) }}
                </button>
              </div>
            </details>
          </div>
        </div>

        <!-- 画布舞台：只装「画布 + 浮动检查器」两件事。
             检查器 absolute 叠在右上角，因此**不占画布宽度** —— 画布是全幅的。 -->
        <div class="dg__stage">
          <SurfacePanel class="dg__canvas">
            <!-- 当前方向上没有相邻边：这不是错误（依赖图是"部分有序"的），
                 但要说清是"它就到头了"还是"图上没连"，免得学生以为图坏了。
                 ⚠️ 画布**仍然画整张图** —— 这里只是一句说明，不替换画布。 -->
            <!-- ⚠️ 两句必须写在同一行：原先它们是两行，Vue 会把换行折成一个空格，
                 渲染出来是「…没有要学的东西。 它是这条链的末端。」—— 全角句号后面
                 多一个半角空格（原句那里是 ` —— ` 的排版残留，标点换成句号后就露出来了）。 -->
            <p v-if="focusedEdges.length === 0" class="dg__none" data-testid="dependency-none">
              「{{ nameOf(focus) }}」在{{ view === 'successor' ? '后面' : '前面' }}没有要学的东西。{{ view === 'successor' ? '它是这条链的末端' : '它是这条链的起点' }}。
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
                  :data-name-resolved="nameResolved(node.kpId) ? 'true' : 'false'"
                  :title="nameResolved(node.kpId) ? undefined : node.kpId"
                  @click="focus = node.kpId"
                >
                  <span class="node__name">{{ nameOf(node.kpId) }}</span>
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
            padding="sm"
            data-testid="dependency-inspector"
          >
            <!-- 头部只留「我刚才点了谁」：原来右侧那行「看它后面能学什么」描述的是
                 **开关方向**，而卡片现在两侧都显示（见 script 里 listOf 的说明）——
                 留着就是界面撒谎（2026-10-01 用户裁决：直接删，不换成另一句）。 -->
            <header class="insp__head">
              <Layers :size="14" />
              <span class="insp__title">当前知识点</span>
            </header>

            <!-- 选中节点名 14px：**低于**身份行 22px，也与画布节点同档 ——
                 它是「我刚才点了啥」的回执，不是这一页的主角。 -->
            <p
              class="insp__name"
              :title="nameResolved(focusedNode.kpId) ? undefined : focusedNode.kpId"
            >
              {{ nameOf(focusedNode.kpId) }}
            </p>
            <!-- ── 学习建议：两张并列清单（建议先学 / 学完它就能学）─────────────
                 ★★ 数据只有一份（依赖图的边），按方向拆成两张：学生真正要问的就是这两句。
                    两张**同时显示** —— 页面顶部的「前置 / 后继」开关自此只决定**画布高亮**
                    哪一侧（2026-10-01 用户裁决；理由见 script 里 listOf 的说明）。
                 ★ 行样式沿用原来卡片底部那份清单（整行可点、逐行带「前置边 / 相关边」标注），
                    不再用 chips —— chips 与底部清单曾是同一份数据的两份呈现。
                 ★ 上移到指标区（掌握度）之前：它比「我掌握得怎样」更该先被读到。
                 ★ 这一块是浮层里**唯一可滚**的一段：边数随图谱增长，
                    让它内部滚动，上面的「当前节点」与下面的指标始终留在原位。 -->
            <div class="insp__advice" data-testid="dependency-advice">
              <section class="advice__group">
                <header class="insp__head insp__head--sub">
                  <GitBranch :size="14" />
                  <span class="insp__title">建议先学</span>
                  <span class="insp__meta">{{ prerequisites.length }} 条</span>
                </header>
                <div class="advice__list">
                  <button
                    v-for="item in prerequisites"
                    :key="item.kpId"
                    type="button"
                    class="edge k12-tap"
                    :title="`${nameOf(item.fromKpId)} → ${nameOf(item.toKpId)}`"
                    @click="focus = item.kpId"
                  >
                    <span class="edge__name">{{ item.name }}</span>
                    <span class="edge__rel">{{ item.relation === 'prerequisite' ? '前置边' : '相关边' }}</span>
                    <!-- 内部 slug（教师 / 答辩视角）：这条边到底是哪两个知识点，
                         用可核对的 id 写出来 —— 报告与排障要按它对齐数据。 -->
                    <TeacherGate>
                      <span class="edge__ids" :data-from="item.fromKpId" :data-to="item.toKpId">
                        {{ item.fromKpId }} → {{ item.toKpId }}
                      </span>
                    </TeacherGate>
                  </button>
                  <p v-if="prerequisites.length === 0" class="insp__none">没有前置，可以从它开始。</p>
                </div>
              </section>

              <section class="advice__group">
                <header class="insp__head insp__head--sub">
                  <GitBranch :size="14" />
                  <span class="insp__title">学完它就能学</span>
                  <span class="insp__meta">{{ consequences.length }} 条</span>
                </header>
                <div class="advice__list">
                  <button
                    v-for="item in consequences"
                    :key="item.kpId"
                    type="button"
                    class="edge k12-tap"
                    :title="`${nameOf(item.fromKpId)} → ${nameOf(item.toKpId)}`"
                    @click="focus = item.kpId"
                  >
                    <span class="edge__name">{{ item.name }}</span>
                    <span class="edge__rel">{{ item.relation === 'prerequisite' ? '前置边' : '相关边' }}</span>
                    <TeacherGate>
                      <span class="edge__ids" :data-from="item.fromKpId" :data-to="item.toKpId">
                        {{ item.fromKpId }} → {{ item.toKpId }}
                      </span>
                    </TeacherGate>
                  </button>
                  <p v-if="consequences.length === 0" class="insp__none">这条链到这里就结束了。</p>
                </div>
              </section>
            </div>

            <!-- ── 掌握度：进度条而不是一个裸数字 ──────────────────────────
                 学生读得懂「走到哪了」，读不懂一个孤零零的「62%」。
                 没有记录时**不画 0% 的条**（那看起来像「你完全不会」），
                 而是如实说一句「还没有练习记录」。 -->
            <div class="insp__mastery" data-testid="dependency-mastery">
              <div class="insp__mastery-head">
                <span class="insp__label">掌握度</span>
                <span v-if="masteryOf(focusedNode.kpId) !== null" class="insp__mastery-num k12-num">
                  {{ masteryOf(focusedNode.kpId) }}%
                </span>
              </div>
              <ProgressBar
                v-if="masteryOf(focusedNode.kpId) !== null"
                :value="(masteryOf(focusedNode.kpId) ?? 0) / 100"
                :total="100"
                :done="masteryOf(focusedNode.kpId) ?? 0"
                compact
              />
              <p v-else class="insp__none">还没有练习记录，做几道题就知道你到哪一步了。</p>
            </div>

            <!-- 主行动：去对话里学它（对任何节点都可用；与学习档案的「学习地图」
                 `MapTab.vue` 的 goLearn 同一条路，理由见 `<script>` 里的注释）。 -->
            <button
              type="button"
              class="k12-cta insp__cta"
              data-testid="dependency-go-learn"
              @click="goLearn()"
            >
              开始学习这个知识点 →
            </button>

            <!-- 状态 / 章节 / 学段：三个「一眼扫过」的事实，收紧成**内联定义式**。
                 原来是三行、左侧 52px 标签列的 dl（实测固定占 80px），读起来像三条表格行；
                 现在按 flex-wrap 折行：事实一个不少，短章节名一行装得下（~23px），
                 本章这种长标题折成三行也只占 68px（实测）。 -->
            <dl class="insp__facts">
              <div>
                <dt>状态</dt>
                <dd>
                  <span class="insp__tag" :data-mastered="focusedNode.mastered ? 'true' : 'false'">
                    {{ focusedNode.mastered ? '已掌握' : '未掌握' }}
                  </span>
                </dd>
              </div>
              <div>
                <dt>章节</dt>
                <dd>{{ focusedNode.chapterTitle || '—' }}</dd>
              </div>
              <div>
                <dt>学段</dt>
                <dd>{{ GRADE_LABELS[focusedNode.gradeLevel] ?? focusedNode.gradeLevel }}</dd>
              </div>
            </dl>

            <!-- ★ 引擎口径（分层怎么算出来的、这张图还用在哪儿）——
                 是设计证据而不是给学生读的话：收进教师视角，一条都不删。 -->
            <TeacherGate label="引擎口径">
              <dl class="insp__kv">
                <div class="insp__row">
                  <dt>分层</dt>
                  <dd>
                    <span class="insp__dim">{{ layerLabel(focusedNode.layer) }}</span>
                    <span class="insp__dim">（服务端按最长前置链算）</span>
                  </dd>
                </div>
                <div class="insp__row">
                  <dt>kp_id</dt>
                  <dd><code class="insp__id">{{ focusedNode.kpId }}</code></dd>
                </div>
                <div class="insp__row">
                  <dt>用作</dt>
                  <dd>推荐路径 + 检索扩展</dd>
                </div>
              </dl>
            </TeacherGate>

          </SurfacePanel>
        </div>
      </template>
    </template>

    <!-- ── 附录：怎么读这张图（默认折叠）────────────────────────────────
         它们是「这一页背后的规则」，不是每次都要读的上下文 ——
         所以收进折叠区、**默认折叠**，不抢画布高度。
         放在画布**下方**：先看画布（主对象），读完了想深究再往下展开。

         ★★ 分两层：**学生层**先讲人话（箭头怎么读、加粗是什么意思），
            **教师层**（<TeacherGate>）里放引擎口径（`from`/`to` 的书写方向、
            `layer` 的算法、`kp_id` 的排序、depth 上限与悬空引用）—— 一条都没删，
            只是不再默认摆在学生面前。

         ⚠️ 用 el-collapse 而不是自写手风琴：EP 的折叠有正确的
            `aria-expanded` / 键盘语义，且 `--el-transition-duration: 0s`
            已在 base.css 里把展开动画归零（本版不做装饰性动效）。 -->
    <SurfacePanel class="appendix" padding="none">
      <el-collapse class="appendix__collapse">
        <el-collapse-item name="rules">
          <template #title>
            <span class="appendix__t">这张图怎么读</span>
          </template>
          <div class="appendix__grid">
            <section class="appendix__sec">
              <h3 class="appendix__h">箭头怎么读</h3>
              <p class="appendix__p">
                箭头从<strong>要先学的</strong>指向<strong>后面学的</strong>：
                跟着箭头走，就是一条能一步步学下去的路。
              </p>
              <p class="appendix__p">
                切「前置 / 后继」不改变箭头方向，只是换个方向看。「前置视图」回答「学它之前要先会什么」，「后继视图」回答「学完它然后呢」。
              </p>
              <p class="appendix__p">
                每行是一层：越往下的知识点，要先会的东西越多。0 层是从头就能开始学的入口。
              </p>
            </section>
            <section class="appendix__sec">
              <h3 class="appendix__h">加粗与虚线</h3>
              <p class="appendix__p">
                与选中知识点相连的边会加粗变深，那是「这个点连到哪」。其余边照常画出来，它们是这张图的结构，只是不着墨。
              </p>
              <p class="appendix__p">
                虚线是<strong>相关</strong>（学过它对你理解这个有帮助），
                实线是<strong>前置</strong>（不先学它，后面那个会学不懂）。
              </p>
            </section>
            <section class="appendix__sec">
              <h3 class="appendix__h">点了能做什么</h3>
              <ul class="notes">
                <li>点任意知识点卡片：右侧浮层显示它的前置、后继与掌握度。</li>
                <li>浮层里的「开始学习这个知识点 →」会带着它去对话页找智团团。</li>
                <li>「快速定位」按章节分组，找不到就用「展开全部」。</li>
              </ul>
            </section>
          </div>

          <!-- ★ 引擎口径：评委/老师要的证据，学生看不到（但一个字段都没删） -->
          <TeacherGate label="引擎口径（from/to 语义 · 分层算法 · 约束）">
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
                </p>
              </section>
              <section class="appendix__sec">
                <h3 class="appendix__h">用途与约束</h3>
                <ul class="notes">
                  <li>依赖图同时服务「推荐路径规划」与「检索上下文扩展」，两个用途都保留。</li>
                  <li>服务端沿依赖图展开时带 depth 上限防环；导入阶段用 DFS 检测环。</li>
                  <li>扩展只作补充上下文，且有数量上限。</li>
                  <li>悬空 <code>to_kp_id</code> 报错而非静默跳过。</li>
                  <li>
                    导出文件名由主进程经 <code>sanitizeFileName</code> 白名单重建，
                    回执只含文件名（完整路径不进渲染进程）。
                  </li>
                </ul>
              </section>
            </div>
          </TeacherGate>
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
  font-size: var(--k12-fs-caption);
}
.btn__label {
  margin-left: 6px;
}
/* 导出回执：一行 meta（不占版面，也不做自动消失的定时器） */
.dg__done {
  font-size: var(--k12-fs-caption);
  color: var(--k12-good);
}
.dg__done code {
  padding: 1px 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
/* 导出取消 / 失败：一行状态，不是横幅（它不是页面的主要状态） */
.dg__export-note {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.dg__export-note[data-tone='failed'] {
  color: var(--k12-warn);
}
/* 教师视角里的口径句（数据来源 / 处置）：12px meta，与栅格里的说明同档 */
.dg__tech {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
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
  font-size: var(--k12-fs-caption);
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
  font-size: var(--k12-fs-label);
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
  font-size: var(--k12-fs-body);
  font-weight: 650;
  color: var(--k12-fg);
}
/* ★ 节点卡片上**没有** kp_id 那一行了：学生看到的永远是中文名，
 *   取不到名字时是「未命名知识点」，原始 id 只进 `title`
 *   （唯一口径见 `study/kp-label.ts`）。id 本身移进浮层的教师视角「引擎口径」里。 */
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
  font-size: var(--k12-fs-caption);
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
  font-size: var(--k12-fs-caption);
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
  /* ⚠️ 浮层本身**不滚**，只让中间那块建议清单滚（见 .insp__advice）。
   * 整层滚动会让"当前节点"跟着滚走 —— 用户点了一个节点、滚两下之后
   * 就看不见自己点的是谁了，面板失去意义。 */
  overflow: hidden;
}
.insp__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--k12-muted);
}
/* 13px：不得压过画布节点的 14px —— 它只是浮层的分组标签。 */
.insp__title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.insp__head--sub {
  margin-top: 2px;
}
.insp__meta {
  margin-left: auto;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
/* 选中节点名 14px：明显低于身份行的 22px，且与它所描述的那个节点**同档** ——
 * 它是"我刚点了啥"的回执，不是主角。
 * ⚠️ 不得升回 16px 以上；也不要用 --k12-fs-title（15px）——
 *    契约里那个档位**只给顶栏页面名（chrome）**，不得用于内容区。 */
.insp__name {
  font-size: var(--k12-fs-body);
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
  font-size: var(--k12-fs-caption);
  /* 长 kp_id 不换行会把浮层顶宽 */
  word-break: break-all;
}
.insp__kv {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
/* ── 掌握度块（进度条 + 读数）─────────────────────────────────────────────
 * 学生读得懂「走到哪了」。读数与标签同档（12px），**进度条本身才是重的东西** ——
 * 数字不再独自承担「我学到哪了」这件事。 */
.insp__mastery {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.insp__mastery-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.insp__mastery-num {
  margin-left: auto;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.insp__label {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
/* 「还没有记录」这类中性说明：与 muted 同档，不吓人也不消失 */
.insp__none {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
/* ── 学习建议（建议先学 / 学完它就能学）：两张并列清单 ────────────────────
 * ★ 这一块是浮层里**唯一可滚**的一段（边数随图谱增长，而上面的"当前节点"
 *   必须始终可见）。`min-height: 0` 是 flex 子项能收缩的前提 ——
 *   少了它这个块会按内容高度撑开，浮层先被撑破、内层永远滚不起来；
 *   `flex: 1 1 auto` 让超限时**优先压缩它**，其余各行保持自然高度。 */
.insp__advice {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 9px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.advice__group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.advice__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* 主行动：**铺满浮层宽度**（它是这一块里唯一「现在该按的」东西） */
.insp__cta {
  width: 100%;
}
/* 状态 / 章节 / 学段：**一行内联定义式**（原来是三行、左侧 52px 标签列的 dl，竖着占 80px）。
 * 事实一个不少，换行交给 flex-wrap；标签弱化、值加粗，读起来仍是「标签 值」的定义式。 */
.insp__facts {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  margin: 0;
  /* 折行时每一行都更紧：走 ui 档行高（1.6）而不是正文的 1.75 ——
   * 这三条是「扫一眼」的事实，不需要正文的呼吸。 */
  line-height: var(--k12-lh-ui);
}
.insp__facts > div {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.insp__facts dt {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.insp__facts dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-fg-2);
}
.insp__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.insp__row dt {
  flex: none;
  width: 52px;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.insp__row dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-fg-2);
}
.insp__tag {
  padding: 1px 7px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  font-weight: 650;
}
.insp__tag[data-mastered='true'] {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.insp__dim {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  font-weight: 400;
}
/* 清单行：整行可点，点了跳到那一端（与原来「沿这条边走过去」同一个落点）。 */
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
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-fg-2);
}
.edge__rel {
  margin-left: auto;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
/* 内部 slug（教师视角）：等宽 + 折行，它是要被**核对**的值，不截断。 */
.edge__ids {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
  word-break: break-all;
}

/* ── 附录：科普说明（默认折叠）────────────────────────────────────────────
 * 折叠标题 13px、内容 12px —— 它是附录，不与画布争字号。
 * `padding` 由 SurfacePanel 的属性传入（留白交给折叠头自己控制），
 * 这里只去掉 EP 折叠自身的两条边框（外层 SurfacePanel 已有卡边框）。 */
.appendix__collapse {
  border: none;
}
/* ★ 内边距走 SurfacePanel 的枚举（报告 §4.2）之后，这里补回「横向 16 / 纵向 0」：
 *   折叠头的分隔线要通到卡片边缘，所以纵向不能有 padding（见 .appendix__collapse 的 border 归零）。 */
.appendix {
  padding: 0 var(--k12-sp-4);
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
  font-size: var(--k12-fs-body-sm);
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
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.appendix__p {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.appendix__p code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
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
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.notes code {
  color: var(--k12-accent-ink);
}
/* ── 快速定位（按章节分组）────────────────────────────────────────────────
 * ★ 原来是一整片 chip 平铺（几十个点排成五六行、没有分界）——
 *   现在按章节分成可折叠的小组，头部一行「快速定位 + 展开全部」，
 *   下面是各章。`.quick` 因此从「一行 flex」变成「一段竖排」。
 *
 * 为什么用 `flex-wrap` 而不是横向滚动：横向滚动在桌面端会把一半内容藏到
 * 「看不见也没有提示」的地方（本项目对动画模板卡的那条结论完全一样）。 */
.quick {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.quick__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.quick__ic {
  color: var(--k12-muted);
  flex: none;
}
.quick__l {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  margin-right: 2px;
}
/* 「展开全部 / 收起全部」：一行里的小按钮（触控下限由 .k12-tap 兜） */
.quick__toggle {
  margin-left: auto;
  padding: 2px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .quick__toggle:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
/* 章节组：横向排开、自动换行（一章一个块） */
.quick__groups {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.qgroup {
  /* 组本身是一块浅底卡片：收起时只占一个标题的宽度，展开时会自行变高 */
  flex: 0 1 auto;
  max-width: 100%;
  padding: 3px 8px 3px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
/* 折叠头：**原生 `<summary>`**（Tab + Enter 就能开合，aria 语义由浏览器给）。
 * ⚠️ `list-style` 去掉的是默认三角，用自己的 `::before` 画一个更明确的指示符
 *    （默认三角在 13px 下几乎看不见，学生不知道这一块能展开）。 */
.qgroup__sum {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
}
.qgroup__sum::-webkit-details-marker {
  display: none;
}
.qgroup__sum::before {
  content: '▸';
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  transition: transform var(--k12-dur-state) var(--k12-ease-state);
}
.qgroup[open] > .qgroup__sum::before {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-k12-reduced-motion='off']) .qgroup__sum::before {
    transition: none;
  }
}
.qgroup__title {
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-fg-2);
}
.qgroup__count {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.qgroup__items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0 3px;
}
/* 按钮文字是 meta → 13px（判据：12px 只给 ≤4 字的角标） */
.quick__b {
  padding: 4px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
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
