<script setup lang="ts">
/**
 * 设置：**学段 / 教材章节 / 外观主题**（学生视角）+ **高级设置（教师 / 答辩）**。
 *
 * ── 结构：左「章节索引」+ 右「单列字段」──────────────────────────────────
 * 左栏 180px 是可点跳转的章节索引，右栏是当前章节的字段。
 * 跳转用 `scrollTop` 直接赋值（`behavior: 'auto'`）—— 本版**动效为零**，
 * `smooth` 也算动效，不要加。
 *
 * ── ★★ 两段式：学生看三节，技术三节进「高级设置」────────────────────────
 * 走查结论：这一页此前把「供应商 / 嵌入模型 / 隐私与本地服务」直接摆在学生面前 ——
 * 一个 10 岁学生打开「设置」看到 BaseURL、端口号、进程号，那不是设置页，是运维控制台。
 * 现在分成两段：
 *   · **学生段**（默认可见）：学段 / 教材章节 / 外观主题 —— 这三节是学生真的会改的东西；
 *   · **高级段**（`viewMode.advancedOpen` 或教师视角时展开）：供应商 / 嵌入模型 /
 *     隐私与本地服务，外加「教师视角」开关。
 *
 * ⚠️ **这不是权限系统**（见 `stores/viewMode.ts`）：没有账号体系，开关是可绕过的。
 *    它保证的只是「学生日常不会撞见运维术语」，文案里**不许**写成安全边界。
 * ⚠️ ★ **供应商那三节是「移到后面」，不是「删掉」**：赛题硬要求供应商 / BaseURL /
 *    API Key / Model ID 全部可改（不写死供应商）。谁把 BaseURL 输入框删掉，谁就违反了需求。
 *    本页只改「默认给谁看」（默认收起 = 学生日常不需要），能力一个字没减。
 *
 * ⚠️ 焦点：全页内容区最大字号是身份行的 22px（PageIdentity），
 *    章节标题 16px 必须**小于**它 —— 否则"卡片的重量盖过内容"。
 *
 * ── 数据来源（本页**只渲染与收集输入**，一条请求都不自己发）──────────────
 *   `stores/settings.ts`   供应商 / 嵌入的读、存、探测（含 Pi 预设与拉取模型）
 *   `stores/chat.ts`       学段与教材章节的读写（与对话页指示器**同一条** action）
 *   `stores/study.ts`      章节清单（复用 `loadChapters`，不新增第二条取数路径）
 *   `stores/knowledge.ts`  嵌入体检数字（模型 / 维度 / 向量索引是否可用）
 *   `stores/sidecar.ts`    本地数据服务的真实阶段（不再是一行写死的状态）
 *   `stores/theme.ts`      饱和度（学生的本地偏好）+ 只读的学段色调
 *
 * ★ 学段与章节各有**两个入口**（对话页顶栏指示器 / 本页），但**只有一条写路径**：
 *   两处都调 store 的 `chat.setGrade` / `chat.setChapter`。各写一份就会出现
 *   「在设置页改了、顶栏指示器还显示旧值」。本文件因此不直连主进程能力、
 *   不拼请求、失败时也不改本地状态 —— 失败就如实显示可读原因（失败不撒谎）。
 *
 * ⚠️ API Key **永远不回填**（渲染进程只拿得到掩码）：Key 栏始终是空的密码框，
 *    留空 = 沿用已存的 Key；删除只能走「清除已保存的 Key」。
 * ⚠️ 保存前必须做**真实连通性探测**（执行文档要求）：两种 /v1 写法都可能连通，
 *    不要静默改写用户填的地址，也不要「只存不验」。
 *
 * ★ `providerId` 与 `providerName` 是**两个字段，不能合并**（后端 contracts.py 明确要求）：
 *   - `providerId` 进 Pi，决定用哪份 provider 定义（认证方式 / 模型目录 / 协议）；
 *   - `providerName` 只用于显示与排查，填什么都行。
 *
 * ── 左栏跳转怎么保证"真的能用" ──────────────────────────────────────────
 * 滚动位置判定（章节顶越过容器顶 1/4 视口为界）有个固有极限：页尾那一节
 * **永远滚不到容器顶端**（scrollTop 被 clamp），纯位置判定会与点击目标不一致。
 * 所以点击是**权威**的：点完把滚动位置钉住（`pinnedTop`），只有当
 * 用户真的把容器滚到了别处（scrollTop 离开钉住点 >2px）才交还给位置判定。
 * 没有定时器、没有 rAF、没有"等滚动结束"的猜测 —— 状态完全由 scrollTop 决定。
 */
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Check,
  ChevronRight,
  Cpu,
  Database,
  Eye,
  EyeOff,
  GraduationCap,
  HardDrive,
  KeyRound,
  ListChecks,
  Palette,
  Plug,
  Server,
  ShieldCheck,
  SlidersHorizontal
} from 'lucide-vue-next'
import { GRADE_LEVELS } from '../api/grade'
import { EMBEDDING_MODE_LABELS, MANUAL_PRESET_ID, type EmbeddingMode } from '../api/settings'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL, chapterLineLabel, gradeOriginLabel } from '../labels'
import { useChatStore } from '../stores/chat'
import { useKnowledgeStore } from '../stores/knowledge'
import { useSettingsStore } from '../stores/settings'
import { useSidecarStore } from '../stores/sidecar'
import { useStudyStore } from '../stores/study'
import { SATS, useThemeStore, type SatKey } from '../stores/theme'
import { useViewModeStore } from '../stores/viewMode'
import PageIdentity from '../components/PageIdentity.vue'
import SurfacePanel from '../components/SurfacePanel.vue'
import type { GradeLevel } from '@shared/ipc-events'

const settings = useSettingsStore()
const chat = useChatStore()
const study = useStudyStore()
const knowledge = useKnowledgeStore()
const sidecar = useSidecarStore()
const theme = useThemeStore()
/** 学生 / 教师视角（见文件头：这是**防误入**，不是权限）。 */
const viewMode = useViewModeStore()

/* ------------------------------------------------------------ 供应商 */

const showKey = ref(false)
const showEmbeddingKey = ref(false)

/** 预设下拉的说明（读目录 / 读失败 / 读到了几家，三种都说清）。 */
const presetHint = computed(() => {
  if (settings.loadingCatalog) return '正在读取 Pi 内置的供应商目录…'
  if (settings.catalogError) return settings.catalogError
  if (settings.catalog.length === 0) {
    return '没有读到 Pi 内置供应商 —— 可以在下面手动填写 Provider ID / BaseURL / Model ID。'
  }
  return (
    `已读到 Pi 内置的 ${settings.catalog.length} 个供应商：选一个会自动带出端点与常见模型，` +
    '也可以停在「手动填写」自己填。'
  )
})

const saveState = computed(() => {
  if (settings.loading) return 'loading'
  if (settings.saving) return 'saving'
  return settings.dirty ? 'dirty' : 'clean'
})
const saveStateText = computed(() => {
  if (settings.loading) return '正在读取设置…'
  if (settings.saving) return '正在保存…'
  if (settings.dirty) return '有未保存的修改'
  return settings.snapshot ? '已保存到本机' : ''
})

/** 嵌入 Key 栏的占位（掩码只做状态文案，绝不回填到输入框）。 */
const embeddingHasStoredKey = computed(() => settings.snapshot?.embedding.hasKey ?? false)

function onPresetChange(event: Event): void {
  const target = event.target
  if (target instanceof HTMLSelectElement) settings.applyPreset(target.value)
}

/** 保存（成功给一次 toast；失败原因由 store 的 errorText 落在页面上）。 */
async function runSave(probeAfter = true): Promise<void> {
  const ok = await settings.save({ probeAfter })
  if (ok) ElMessage({ message: settings.notice ?? '已保存并生效。', type: 'success' })
}

function runSaveOnly(): void {
  void runSave(false)
}

function runProbe(): void {
  void settings.probeNow()
}

function runFetchModels(): void {
  void settings.fetchModels()
}

/**
 * 探测结论的**一句话白话**（给不懂 HTTP 的人看）。
 *
 * ★ 后端那句原文是**排障文案**，形态是
 *   「连通成功：https://api.deepseek.com/models 返回 HTTP 200，可见模型 2 个（示例：…）。
 *     保存后即以 … 调用。」——信息完整，但一个学生读到 URL + HTTP 状态码只会以为出了问题。
 *   **后端文案不在这里改**（有测试盯着「连通成功」「重新填写 API Key」等字符串）：
 *   这里只把同一份结果**再表述一次**，原文一字不改地放在下面的「技术详情」里。
 * ★ 判据用正则从原文里**取事实**（模型个数 / HTTP 状态码），取不到就说一句不含细节的
 *   「连通正常」—— 不编一个具体数字出来。
 */
const probeSummary = computed(() => {
  const result = settings.probe
  if (result === null) return ''
  if (!result.ok) return '还没连通 —— 具体原因和改法在下面的「技术详情」里。'
  const models = /可见模型\s*(\d+)\s*个/.exec(result.message)
  if (models) return `连通正常（这个地址上有 ${models[1]} 个模型可用）`
  const http = /返回 HTTP\s*(\d{3})/.exec(result.message)
  if (http) return `连通正常（对方返回 HTTP ${http[1]}）`
  return '连通正常'
})

/** 探测结果的标题那两个词（学生可见口径，与后端文案同一个词，不要改）。 */
const probeTitle = computed(() => (settings.probe?.ok ? '连通成功' : '未能连通'))

/* ------------------------------------------------------------ 嵌入模型 */

const EMBEDDING_MODES: readonly EmbeddingMode[] = ['local_fastembed', 'cloud_api', 'none']

const statsModel = computed(() => knowledge.stats?.embeddingModel ?? '')
const statsDim = computed(() => knowledge.stats?.embeddingDim ?? null)

function setEmbeddingMode(value: unknown): void {
  if (value === 'local_fastembed' || value === 'cloud_api' || value === 'none') {
    settings.embedding.mode = value
  }
}

/* ------------------------------------------------------------ 学段 */

/**
 * 学段的手动入口（第二个入口，D-037）。
 *
 * ★ 写路径只有一条：store 的 `chat.setGrade`（走 `grade:set` 独立通道，服务端写库，
 *   主进程再把结果推回来）。前端**不推断、不改写、失败也不改本地状态** ——
 *   否则界面显示「高中」而库里还是初中，下一轮回答就按初中讲（对着界面撒谎）。
 */
const gradeBusy = ref(false)
const gradeError = ref<string | null>(null)

/**
 * 「改一改」：四档收在标题行后面（报告 2.1 —— 这块原先把「当前学段」说了四遍：
 * 标题 / `当前学段` 字段名 / chip 值 / 来源标签）。
 *
 * ★ 四档用 `v-show` 收起来而不是 `v-if`：`scripts/verify-ui.mjs` 一进设置页就按
 *   `[data-testid^="settings-grade-option-"]` 取那四档，`v-if` 会让它一个都取不到
 *   （那条探针会假红）。收起只是视觉上的，DOM 里始终在。
 */
const gradePickerOpen = ref(false)

const gradeText = computed(() =>
  chat.currentGradeLabel === null ? GRADE_UNKNOWN_LABEL : chat.currentGradeLabel
)
/** 「学段是怎么定下来的」（唯一实现是 labels.ts 的 `gradeOriginLabel`，两处不许各写一份）。 */
const gradeSource = computed(() => gradeOriginLabel(chat.gradeOrigin))

async function chooseGrade(level: GradeLevel): Promise<void> {
  if (gradeBusy.value) return
  gradeBusy.value = true
  gradeError.value = null
  try {
    const result = await chat.setGrade(level)
    if (!result.ok) {
      gradeError.value = result.message ?? '设定学段失败，请稍后再试。'
    } else {
      // 选成功了就把四档收回去：标题行已经写着当前值，留着选项等于把同一件事再说一遍
      gradePickerOpen.value = false
    }
  } finally {
    gradeBusy.value = false
  }
}

/* ------------------------------------------------------------ 教材章节 */

/**
 * 教材章节（软偏好，D-038）：选了「第 4 章」，回答与检索会优先围绕它，
 * 但学生问到别的章节照常回答 —— **不做检索硬过滤**。
 *
 * ★ 学段与章节**相互独立**：选章节不改学段；反过来，学段一变服务端会清空章节
 *   （那本教材不存在了），本页读到的是服务端推回来的真值。
 * ★ 清单复用既有取数路径（`study.loadChapters`，同一份数据也供
 *   「学习档案 → 章节进度」分页使用）—— 不新增第二条取数路径。
 */
const chapterBusy = ref(false)
const chapterError = ref<string | null>(null)

/** 「正在学：第4章…」这一行字的**唯一**拼装实现是 labels.ts 的 `chapterLineLabel`。 */
const chapterLine = computed(() => chapterLineLabel(chat.currentChapter))
const chapterOptions = computed(() => study.chapters?.chapters ?? [])
const chapterListGrade = computed(() => {
  const level = study.chapters?.gradeLevel
  return level ? GRADE_LABELS[level] : null
})
/** 学段还没判定出来：章节按学段分，列不出任何东西（不列空列表）。 */
const chapterUnavailable = computed(() => chat.currentGrade === null)

async function chooseChapter(title: string): Promise<void> {
  if (chapterBusy.value) return
  chapterBusy.value = true
  chapterError.value = null
  try {
    const result = await chat.setChapter(title)
    if (!result.ok) chapterError.value = result.message ?? '设定章节失败，请稍后再试。'
  } finally {
    chapterBusy.value = false
  }
}

/* ------------------------------------------------------------ 外观主题 */

/**
 * 切饱和度（应用**立刻**生效 —— store 的 `watchEffect` 把 `data-sat` 写到 `<html>` 上，
 * 三张预览卡看的也正是同一组令牌，所以「点完页面就变」不需要保存这一步）。
 * ★ 参数仍在运行时收窄一次：模板来的值在类型上可信，但这条写路径是 store 的
 *   公开入口之一，多一道白名单不花什么（与 store 内部的三档字面量一致）。
 */
function setSat(value: SatKey): void {
  if (value === 'vivid' || value === 'soft' || value === 'mono') theme.setSat(value)
}

/* ------------------------------------------------------------ 生命周期 */

onMounted(() => {
  // 本地数据服务的状态是应用级的一条订阅（`connect()` 幂等：App.vue 已连上时是空操作）
  sidecar.connect()
  // ★ 只在还没有快照时真读一次：本页挂在 `<KeepAlive>` 里，切走再回来
  //   **不许把没保存的草稿冲掉**（草稿在 store 里，重读会整份覆盖它）。
  if (settings.snapshot === null && !settings.loading) void settings.load()
  void settings.loadCatalog()
  void knowledge.loadStats()
  // 章节清单与对话页指示器共用同一条取数路径（学段缺失时它只给一句提示，不发请求）
  void study.loadChapters(chat.currentGrade)
  bindSectionSpy()
})

onActivated(() => {
  // 回到本页：学段可能在别处变了（章节清单跟着换），教材也可能刚导入过（体检数字要刷新）。
  // 两条都是幂等的：清单没换学段、统计已读过时，store 自己会直接返回。
  void study.loadChapters(chat.currentGrade)
  void knowledge.loadStats()
})

// 学段在别处（系统自动判定 / 对话页指示器）变了 → 章节目录跟着换
// （章节属于某一本教材；服务端在学段变更时也会清空已选章节）
watch(
  () => chat.currentGrade,
  (level) => {
    gradeError.value = null
    void study.loadChapters(level)
  }
)

// ── 章节索引与跳转 ────────────────────────────────────────────────────────
/**
 * 子导航（**学生段在前，技术节在后**，与右栏的渲染顺序一一对应）。
 *
 * ★ 两段合并成一个数组，是因为左栏的滚动判定（`derivedSection`）与跳转（`goTo`）
 *   都按 `data-section` 在同一套元素上跑 —— 拆成两个数组会让「当前在哪一节」
 *   出现两套判据。段落归属由 `group` 字段表达，渲染时各自渲染一段。
 */
const SECTIONS = [
  { id: 'grade', label: '学段', group: 'learner' },
  { id: 'chapter', label: '教材章节', group: 'learner' },
  { id: 'theme', label: '外观主题', group: 'learner' },
  { id: 'provider', label: '供应商', group: 'advanced' },
  { id: 'embedding', label: '嵌入模型', group: 'advanced' },
  { id: 'privacy', label: '隐私与本地服务', group: 'advanced' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const LEARNER_SECTIONS = SECTIONS.filter((s) => s.group === 'learner')
const ADVANCED_SECTIONS = SECTIONS.filter((s) => s.group === 'advanced')

/**
 * 高级区是否展开 = 学生主动点开了它，**或者**本来就在教师视角。
 *
 * ★ 为什么教师视角下强制展开：高级区里那三节正是「设计合理性」的证据
 *   （供应商可改 / 嵌入与索引状态 / 本地服务边界），评委切了视角还要再点一次
 *   才看得见，等于把证据藏起来。而 `advancedOpen` 是纯内存状态，不会带到下次启动。
 */
const advancedVisible = computed(() => viewMode.isTeacher || viewMode.advancedOpen)

/** 跳转落点：章节顶离容器顶留一点余量（与判定线配合，见 SPY_LINE_RATIO） */
const NAV_OFFSET = 12
/** 章节判定线：容器顶往下 1/4 视口处；容器很矮时至少留 24px */
const SPY_FLOOR = 24
const SPY_LINE_RATIO = 0.25

const rootRef = ref<HTMLElement | null>(null)
/** 滚动祖先（`.shell__content`）与各章节块：onMounted 时取一次，避免每帧查询 */
let scroller: HTMLElement | null = null
let sectionEls: HTMLElement[] = []

const activeId = ref<SectionId>('grade')
/** 点击后的"钉子"：记住跳转落点的 scrollTop，直到用户真的滚开才交还给位置判定 */
let pinnedTop: number | null = null

function isSectionId(v: string | undefined): v is SectionId {
  return SECTIONS.some((s) => s.id === v)
}

/**
 * 默认落点：学生段的**第一节**。
 *
 * ⚠️ 高级区未展开时，右栏里根本没有 `[data-section="provider"]` 那两个节点 ——
 * 初值若还写 `'provider'`，左栏会在进页面时把「供应商」标成当前章节，
 * 而那一条此刻并不存在（点它既滚不动、也不该被高亮）。
 */
function defaultSection(): SectionId {
  return LEARNER_SECTIONS[0].id
}

/** 纯位置判定：章节顶越过判定线的**最后一个**章节就是"当前章节" */
function derivedSection(): SectionId {
  const c = scroller
  if (!c) return defaultSection()
  // 已到底：页尾那一节可能永远到不了判定线（scrollTop 被 clamp），直接认它
  if (c.scrollTop + c.clientHeight >= c.scrollHeight - 2) {
    const last = sectionEls[sectionEls.length - 1]?.dataset.section
    if (isSectionId(last)) return last
  }
  const line = c.getBoundingClientRect().top + Math.max(SPY_FLOOR, c.clientHeight * SPY_LINE_RATIO)
  let current: SectionId = defaultSection()
  for (const el of sectionEls) {
    const id = el.dataset.section
    if (isSectionId(id) && el.getBoundingClientRect().top <= line) current = id
  }
  return current
}

function onScroll() {
  const c = scroller
  if (!c) return
  // 还停在点击落点上：以点击为准（位置判定在页尾会失真，见文件头）
  if (pinnedTop !== null && Math.abs(c.scrollTop - pinnedTop) <= 2) return
  pinnedTop = null
  activeId.value = derivedSection()
}

function goTo(id: SectionId) {
  const c = scroller
  const el = sectionEls.find((e) => e.dataset.section === id)
  if (!c || !el) return
  const delta = el.getBoundingClientRect().top - c.getBoundingClientRect().top
  // `behavior: 'auto'`（直接改 scrollTop）—— 不动效，不要 smooth
  c.scrollTop += delta - NAV_OFFSET
  activeId.value = id // 立刻反馈，不等滚动事件回来
  pinnedTop = c.scrollTop
}

/** 挂上滚动判定（取一次滚动祖先与各章节块，避免每帧查询）。 */
function bindSectionSpy(): void {
  scroller = rootRef.value?.closest<HTMLElement>('.shell__content') ?? null
  if (!scroller) return
  sectionEls = [...(rootRef.value?.querySelectorAll<HTMLElement>('[data-section]') ?? [])]
  // 滚动是 passive 的：判定只读几何，不写 DOM 布局（不会触发滚动锁定）
  scroller.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
  onScroll()
}

/**
 * 高级区展开/收起后，右栏的 `[data-section]` 节点**整批换掉**了 ——
 * 必须重新收集，否则那些新出现的章节既不参与判定、也跳不过去
 * （`goTo` 在旧数组里找不到 `provider`，点了没反应）。
 */
watch(advancedVisible, async (visible) => {
  await nextTick()
  sectionEls = [...(rootRef.value?.querySelectorAll<HTMLElement>('[data-section]') ?? [])]
  if (!visible && ADVANCED_SECTIONS.some((s) => s.id === activeId.value)) {
    activeId.value = defaultSection()
  }
  onScroll()
})

/**
 * 展开高级区（唯一入口：左栏底部那一条）。
 *
 * ★ 展开之后**顺势滚到「供应商」那一节**：学生点的是「高级设置」，
 *   期待的是「看到那批设置」，而不是「页面下方的某处凭空多了一段」——
 *   尤其在窄窗口里（左栏变成顶部一行 tab、当前视口停在「外观主题」附近）。
 * ★ 与 `goTo` 同一套「钉子」手法：滚动位置钉住，直到用户真的滚开。
 */
async function openAdvancedArea(): Promise<void> {
  viewMode.openAdvanced()
  await nextTick()
  sectionEls = [...(rootRef.value?.querySelectorAll<HTMLElement>('[data-section]') ?? [])]
  const first = ADVANCED_SECTIONS[0].id
  const el = sectionEls.find((e) => e.dataset.section === first)
  const c = scroller
  if (c && el) {
    c.scrollTop += el.getBoundingClientRect().top - c.getBoundingClientRect().top - NAV_OFFSET
    pinnedTop = c.scrollTop
  }
  activeId.value = first
}

/** 收起高级区（只在学生视角下给这个按钮：教师视角下它是强制展开的）。 */
function closeAdvancedArea(): void {
  viewMode.closeAdvanced()
}

onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onScroll)
})
</script>

<template>
  <div ref="rootRef" class="st" data-testid="settings-view">
    <!-- 身份行：本页在讲什么。22px，是全页内容区的**最大**字号。
         ⚠️ 文案跟着分区改过：学生的三节是「学段 / 章节 / 外观」，
            「填供应商与 Key」那条主路径只对老师 / 评委成立（它现在在高级区里）。 -->
    <PageIdentity
      main="学段、教材章节与外观"
      meta="偏好存在本机，随时可以改回来"
      hint="学段与章节随时可换，之前学过的记录都还在"
    />

    <!-- 三条全局状态：桥没接线 / 读写失败 / 正向提示。
         都必须可见 —— 静默失败会让学生以为「保存过了」。 -->
    <p v-if="settings.bridgeError" class="banner banner--bad" data-testid="settings-bridge-missing">
      {{ settings.bridgeError }}
    </p>
    <p v-if="settings.errorText" class="banner banner--bad" data-testid="settings-error">
      {{ settings.errorText }}
    </p>
    <p v-if="settings.notice" class="banner banner--good" data-testid="settings-notice">
      {{ settings.notice }}
    </p>

    <div class="st__body">
      <!-- 左栏：章节索引（可点跳转，当前章节高亮）。
           两段：学生段（学段 / 教材章节 / 外观主题）+ 高级段（仅展开时列出）。
           ⚠️ 标题用「设置项」**不要**用「章节」：本产品里「章节」专指**教材章节**
              （同页就有一节叫「教材章节」、一行叫「当前章节」），拿它当导航标题会让学生
              以为这里列的是教材目录（见报告 0.2 术语表：同一个词只指一件事）。 -->
      <nav class="nav" aria-label="设置项">
        <p class="k12-label nav__title">设置项</p>
        <ul class="nav__list">
          <li v-for="s in LEARNER_SECTIONS" :key="s.id">
            <button
              type="button"
              class="nav__item"
              :class="{ 'is-active': s.id === activeId }"
              :aria-current="s.id === activeId ? 'true' : undefined"
              @click="goTo(s.id)"
            >
              {{ s.label }}
            </button>
          </li>
        </ul>

        <!-- 高级段：展开后才列出来。未展开时这里只有一条入口 ——
             学生日常看不到「供应商 / 嵌入模型 / 隐私」这三节的存在。 -->
        <ul v-if="advancedVisible" class="nav__list nav__list--sub">
          <li v-for="s in ADVANCED_SECTIONS" :key="s.id">
            <button
              type="button"
              class="nav__item"
              :class="{ 'is-active': s.id === activeId }"
              :aria-current="s.id === activeId ? 'true' : undefined"
              @click="goTo(s.id)"
            >
              {{ s.label }}
            </button>
          </li>
        </ul>

        <button
          type="button"
          class="nav__advanced"
          data-testid="settings-advanced-entry"
          :aria-expanded="advancedVisible"
          @click="openAdvancedArea"
        >
          <span class="nav__advanced-text">高级设置（教师 / 答辩）</span>
          <ChevronRight :size="12" class="nav__advanced-ico" />
        </button>
      </nav>

      <!-- 右栏：各章节的字段（**单列**，不再用 2 列网格）。
           ★ DOM 顺序 = 视觉顺序 = 左栏索引顺序，三者必须一致：滚动判定
             （`derivedSection`）按 DOM 顺序取「最后一个越过判定线的章节」，
             一旦用 CSS `order` 调换视觉顺序，判定就会指向另一节。 -->
      <div class="st__sections">
        <!-- ① 学段（第二个手动入口，D-037）：与对话页顶栏指示器**共用同一条写路径**。
             ★ 报告 2.1：这块原先把「当前学段」说了四遍（标题 / 字段名 / chip 值 / 来源）。
               现在标题行直接写清当前值 + 来源，右侧只留一个「改一改」的动作入口。
             ⚠️ 四档受 `v-show` 控制，**不是** `v-if`：见 `gradePickerOpen` 的说明。
             ⚠️ 失败 / 回执那三行放在收起区**外面**：收起来时出错也要看得见
               （静默失败会让学生以为「保存过了」）。 -->
        <SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block">
          <header class="card__head">
            <GraduationCap :size="15" />
            <h2 class="card__title">学段</h2>
            <!-- 当前值 + 来源。来源文案的唯一实现仍是 labels.ts 的 `gradeOriginLabel()`；
                 `settings-grade-source` 这个 testid 是 `scripts/verify-ui.mjs` 的取值锚点。
                 ★ 未判定时**不显示来源**：那时 `gradeText` 与 `gradeSource` 都是
                   `GRADE_UNKNOWN_LABEL`（「还没认出年级」），并排就是同一句话说两遍 ——
                   正是报告 2.1 / 2.2 要消灭的形态「大字给值、小字否定值」。
                 ⚠️ 用 `v-show` 而不是 `v-if`：`verify-ui.mjs` 会把那个节点的 textContent
                   打进诊断行 —— `display:none` 不影响 `textContent`，删掉节点却会读成空串。 -->
            <p class="card__now">
              <span class="readonly__text">{{ gradeText }}</span>
              <span
                v-show="gradeSource !== gradeText"
                class="readonly__origin"
                data-testid="settings-grade-source"
              >
                {{ gradeSource }}
              </span>
            </p>
            <button
              type="button"
              class="card__act"
              data-testid="settings-grade-edit"
              :aria-expanded="gradePickerOpen"
              @click="gradePickerOpen = !gradePickerOpen"
            >
              改一改
            </button>
          </header>

          <div class="field field--grade">
            <p class="hint">系统会自动跟着你的年级；也可以自己选，选了之后一段时间内保持不变。</p>

            <div v-show="gradePickerOpen" class="opts">
              <button
                v-for="level in GRADE_LEVELS"
                :key="level"
                type="button"
                class="opt"
                :class="{ 'opt--on': chat.currentGrade === level }"
                :data-testid="`settings-grade-option-${level}`"
                :data-active="String(chat.currentGrade === level)"
                :disabled="chat.streaming || gradeBusy"
                @click="chooseGrade(level)"
              >
                {{ GRADE_LABELS[level] }}
              </button>
            </div>
          </div>

          <p v-if="gradeError" class="warn" data-testid="settings-grade-error">{{ gradeError }}</p>
          <p v-if="chat.gradeNotice" class="notice" data-testid="settings-grade-notice">
            {{ chat.gradeNotice }}
          </p>
          <p v-if="chat.gradeBridgeError" class="warn" data-testid="settings-grade-bridge">
            {{ chat.gradeBridgeError }}
          </p>
        </SurfacePanel>

        <!-- ② 教材章节（软偏好，D-038）：与学段是两件独立的事 -->
        <SurfacePanel class="card" data-section="chapter" data-testid="settings-chapter-block">
          <header class="card__head">
            <ListChecks :size="15" />
            <h2 class="card__title">教材章节</h2>
            <span class="card__meta">只影响「优先围绕哪一章讲」</span>
          </header>

          <div class="field">
            <p class="field__label">当前章节</p>
            <div class="readonly">
              <span class="readonly__text" data-testid="settings-chapter-line">{{ chapterLine }}</span>
            </div>
            <p class="hint" data-testid="settings-chapter-hint">
              选择章节不会改变学段，只影响优先讲哪一章，问到别的章也照常回答。
            </p>
            <p v-if="chapterListGrade" class="hint">
              清单来自{{ chapterListGrade }}的教材，与「学习档案 → 章节进度」是同一份。
            </p>
          </div>

          <p v-if="chapterUnavailable" class="hint" data-testid="settings-chapter-no-grade">
            还没有判定出你的学段：教材章节按学段分，判定出来之后就能从这里选。
          </p>
          <p v-else-if="study.loading.chapters" class="hint" data-testid="settings-chapter-loading">
            正在读取教材章节…
          </p>
          <template v-else>
            <p v-if="study.errors.chapters" class="warn" data-testid="settings-chapter-list-error">
              {{ study.errors.chapters }}
            </p>
            <div v-if="chapterOptions.length > 0" class="opts">
              <button
                v-for="chapter in chapterOptions"
                :key="chapter.chapterTitle"
                type="button"
                class="opt"
                :class="{ 'opt--on': chat.currentChapter === chapter.chapterTitle }"
                :data-testid="`settings-chapter-option-${chapter.chapterTitle}`"
                :data-active="String(chat.currentChapter === chapter.chapterTitle)"
                :disabled="chat.streaming || chapterBusy"
                @click="chooseChapter(chapter.chapterTitle)"
              >
                {{ chapter.chapterTitle }}
              </button>
            </div>
            <p v-else-if="!study.errors.chapters" class="hint" data-testid="settings-chapter-empty">
              这个学段还没有编入教材章节。
            </p>
            <!-- 「不限章节」永远可选：选了它 = 清空当前章节，回到自由问答 -->
            <button
              type="button"
              class="opt opt--none"
              data-testid="settings-chapter-option-none"
              :data-active="String(chat.currentChapter === '')"
              :disabled="chat.streaming || chapterBusy"
              @click="chooseChapter('')"
            >
              不限章节（自由问答）
            </button>
          </template>

          <p v-if="chapterError" class="warn" data-testid="settings-chapter-error">{{ chapterError }}</p>
          <p v-if="chat.chapterNotice" class="notice" data-testid="settings-chapter-notice">
            {{ chat.chapterNotice }}
          </p>
          <p v-if="chat.chapterBridgeError" class="warn" data-testid="settings-chapter-bridge">
            {{ chat.chapterBridgeError }}
          </p>
        </SurfacePanel>

        <!-- ③ 外观主题（配色跟着学段走；改学段的入口在上面那一区块） -->
        <SurfacePanel class="card" data-section="theme">
          <header class="card__head">
            <Palette :size="15" />
            <h2 class="card__title">外观主题</h2>
            <span class="card__meta">学段色调由系统决定</span>
          </header>

          <div class="field">
            <p class="field__label">当前学段色调（只读）</p>
            <div class="readonly" data-testid="settings-grade">
              <span class="k12-dot readonly__dot" />
              <span class="readonly__text">{{ theme.gradeIndicatorText }}</span>
            </div>
            <p class="hint">颜色跟着学段换；要改年级请用上面的「学段」。</p>
          </div>

          <!-- ★★ 饱和度 = 三张**预览卡**，不是三个纯文字按钮。
               走查结论：原先是「高饱和 / 柔和 / 素净」三个没有配色的文字按钮 ——
               学生根本看不出点下去会发生什么，只能靠试。
               ★ 卡里那些小色块**不写任何色值**：每张卡带 `data-grade` / `data-sat`，
                 由 tokens.generated.css 的 `.k12-swatch[data-grade][data-sat]` 把那一组
                 主题令牌就地重新定义（与「配色总览」页同一手法），卡内色块再引用
                 `var(--k12-page)` / `var(--k12-accent)` —— 看到的就是真的会生效的那一组。
               ★ 选中态**不只是颜色**：描边 + 勾选标记 + `aria-checked` 三样同时给。 -->
          <div class="field">
            <p class="field__label">饱和度</p>
            <div class="sats" role="radiogroup" aria-label="饱和度">
              <button
                v-for="s in SATS"
                :key="s.key"
                type="button"
                role="radio"
                class="sat k12-swatch"
                :class="{ 'sat--on': theme.sat === s.key }"
                :data-grade="theme.displayGrade"
                :data-sat="s.key"
                :data-testid="`settings-sat-${s.key}`"
                :data-active="String(theme.sat === s.key)"
                :aria-checked="theme.sat === s.key"
                @click="setSat(s.key)"
              >
                <span class="sat__mock" aria-hidden="true">
                  <span class="sat__mock-bar" />
                  <span class="sat__mock-chip" />
                  <span class="sat__mock-card">
                    <span class="sat__mock-line" />
                    <span class="sat__mock-line sat__mock-line--short" />
                  </span>
                </span>
                <span class="sat__foot">
                  <span class="sat__label">{{ s.label }}</span>
                  <span class="sat__check">
                    <Check v-if="theme.sat === s.key" :size="13" />
                  </span>
                </span>
                <span class="sat__desc">{{ s.desc }}</span>
              </button>
            </div>
            <p class="hint">{{ theme.satMeta.desc }}。点一下立刻生效，不用保存。</p>
          </div>
        </SurfacePanel>

        <!-- ── 高级设置（教师 / 答辩）────────────────────────────────────────
             ★ 学生视角下**整段不在 DOM 里**（`v-if`，不是 CSS 隐藏）：
               「供应商 / 嵌入模型 / 隐私」这三节是技术设置，学生日常用不到。
             ⚠️ 这不是权限：没有账号体系，开关可绕过（见 `stores/viewMode.ts`）。
                文案里不许把它说成安全边界 —— 它只是「默认不摆出来」。 -->
        <section v-if="advancedVisible" class="adv" data-testid="settings-advanced">
          <header class="adv__head">
            <SlidersHorizontal :size="15" />
            <h2 class="adv__title">高级设置（教师 / 答辩）</h2>
            <button
              v-if="!viewMode.isTeacher"
              type="button"
              class="adv__close"
              data-testid="settings-advanced-close"
              @click="closeAdvancedArea"
            >
              收起
            </button>
          </header>

          <p class="adv__note">
            这里是给老师 / 评委看的技术设置（供应商、嵌入模型、本地服务），学生日常不需要。
            <strong>它不是权限开关</strong>：本应用没有账号体系，谁都能打开 ——
            它只保证学生平时不会撞见端口号、BaseURL 这类术语。
          </p>

          <!-- 教师视角开关：`viewMode.toggle()`（localStorage 持久化，重启照常保留） -->
          <div class="adv__switch">
            <div class="adv__switch-text">
              <p class="adv__switch-title">教师视角</p>
              <p class="adv__switch-desc">
                打开后，对话页右栏会多出「检索降级链」「工具调用轨迹」这类原始证据，侧栏也会多出
                「教材知识库」—— 答辩时用来展示设计依据。
              </p>
            </div>
            <button
              type="button"
              role="switch"
              class="adv__toggle"
              data-testid="settings-teacher-toggle"
              :aria-checked="viewMode.isTeacher"
              :data-on="String(viewMode.isTeacher)"
              @click="viewMode.toggle()"
            >
              <span class="adv__knob" aria-hidden="true" />
              <span class="adv__toggle-text">{{ viewMode.isTeacher ? '已打开' : '未打开' }}</span>
            </button>
          </div>

        <!-- ④ 供应商：技术设置（默认收起在高级区里）。
             ⚠️ ★ 赛题硬要求：供应商 / BaseURL / API Key / Model ID **必须可改** ——
                这里只是「默认不摆给学生」，字段与能力一个都没删。 -->
        <SurfacePanel class="card" data-section="provider" data-testid="settings-llm">
          <header class="card__head">
            <Plug :size="15" />
            <h2 class="card__title">供应商</h2>
            <span class="card__meta">支持下改供应商 / BaseURL / Model ID</span>
          </header>

          <el-form label-position="top" class="form">
            <el-form-item label="供应商预设（Pi 内置目录）">
              <select
                class="pick"
                data-testid="settings-llm-preset"
                :value="settings.presetValue"
                @change="onPresetChange"
              >
                <option :value="MANUAL_PRESET_ID">手动填写（自己填端点与模型）</option>
                <option v-for="preset in settings.catalog" :key="preset.id" :value="preset.id">
                  {{ preset.label }}
                </option>
              </select>
              <p class="hint" data-testid="settings-preset-hint">{{ presetHint }}</p>
            </el-form-item>

            <el-form-item label="Provider ID（进 Pi）">
              <el-input
                v-model="settings.draft.providerId"
                data-testid="settings-llm-providerid"
                placeholder="deepseek"
              />
              <p class="hint">
                决定用哪份 provider 定义。自定义或校内网关请自取一个 id（如 <code>custom</code>），
                并在 Pi 的 <code>models[]</code> 里声明模型，否则该供应商下一个模型都没有。
              </p>
            </el-form-item>

            <el-form-item label="供应商名称（仅显示）">
              <el-input
                v-model="settings.draft.providerName"
                data-testid="settings-llm-provider"
                placeholder="DeepSeek"
              />
              <p class="hint">只用于界面与排查，不参与任何调用逻辑。</p>
            </el-form-item>

            <el-form-item label="BaseURL">
              <el-input
                v-model="settings.draft.baseUrl"
                data-testid="settings-llm-baseurl"
                placeholder="https://api.deepseek.com"
              />
              <p class="hint" data-testid="settings-baseurl-hint">{{ settings.baseUrlHintText }}</p>
            </el-form-item>

            <el-form-item label="Model ID">
              <el-input
                v-model="settings.draft.modelId"
                data-testid="settings-llm-modelid"
                placeholder="deepseek-v4-flash"
              />
              <p class="hint">
                必须是该 provider 模型目录里<strong>真实存在</strong>的 id。
                DeepSeek 目录里只有 <code>deepseek-v4-flash</code> / <code>-vision-exp</code> /
                <code>-pro</code>；填错会让首轮对话直接报「找不到模型」。
              </p>
            </el-form-item>

            <el-form-item label="候选模型">
              <div class="cands">
                <div class="cands__head">
                  <el-button
                    size="small"
                    data-testid="settings-fetch-models"
                    :loading="settings.fetching"
                    :disabled="settings.busy"
                    @click="runFetchModels"
                  >
                    拉取模型清单
                  </el-button>
                  <span class="cands__note">从当前端点实时拉取，并与 Pi 目录里的清单合并。</span>
                </div>
                <p v-if="settings.fetched" class="hint" data-testid="settings-fetch-message">
                  {{ settings.fetched.message }}
                </p>
                <ul
                  v-if="settings.candidatesOpen && settings.modelCandidates.length > 0"
                  class="cands__list"
                  data-testid="settings-model-candidates"
                >
                  <li v-for="id in settings.modelCandidates" :key="id">
                    <button
                      type="button"
                      class="chip"
                      :class="{ 'chip--on': settings.draft.modelId === id }"
                      :data-testid="`settings-model-candidate-${id}`"
                      @click="settings.chooseModel(id)"
                    >
                      {{ id }}
                    </button>
                  </li>
                </ul>
              </div>
            </el-form-item>

            <el-form-item label="API Key">
              <div class="row-inline">
                <el-input
                  v-model="settings.draft.apiKey"
                  data-testid="settings-llm-apikey"
                  :type="showKey ? 'text' : 'password'"
                  autocomplete="new-password"
                  :placeholder="settings.hasStoredKey ? '已保存（留空则不修改）' : '请输入 API Key'"
                  @input="settings.markKeyEdited()"
                />
                <el-button text :title="showKey ? '隐藏' : '显示'" @click="showKey = !showKey">
                  <component :is="showKey ? EyeOff : Eye" :size="16" />
                </el-button>
              </div>
              <p class="key-row">
                <span class="key-state" data-testid="settings-key-status">{{ settings.keyStatus }}</span>
                <span class="key-hint">{{ settings.keyStatusHint }}</span>
                <span v-if="settings.keyCleared" class="key-cleared" data-testid="settings-key-cleared">
                  保存后将删除已存的 Key
                </span>
                <el-button
                  text
                  size="small"
                  data-testid="settings-clear-key"
                  :disabled="settings.busy || !settings.hasStoredKey"
                  @click="settings.clearStoredKey()"
                >
                  清除已保存的 Key
                </el-button>
              </p>
              <p class="hint">
                <KeyRound :size="12" class="hint__ico" />
                Key 仅存本机（<code>config.json</code>），不进日志、也进不了渲染进程 ——
                这一栏从头到尾只拿得到掩码，明文只有主进程能读。
              </p>
            </el-form-item>
          </el-form>

          <!-- 探测结果：**分两层，谁都能看懂，谁都能查到**。
               · 标题那两个词（`连通成功` / `未能连通`）是**既有的学生可见口径**，一字不改 ——
                 它足够短，学生读得懂，也是验收脚本与后端文案共同认的那个串；
               · 中间那句是白话结论（不带 URL、不带状态码）；
               · 后端那一整段诊断原文收进「技术详情」里**一字不改** ——
                 排障、截图、答辩要的都是它（`<details>` 折叠不影响 `textContent`，
                 所以按文本取值的检查照样能读到 `连通成功：… HTTP 200 …`）。
               ★ 探测不会修改你填的内容。 -->
          <div v-if="settings.probing" class="probe probe--pending" data-testid="settings-probe-pending">
            正在向该端点发起一次真实请求…
          </div>
          <div
            v-else-if="settings.probe"
            class="probe"
            :class="settings.probe.ok ? 'probe--ok' : 'probe--fail'"
            data-testid="settings-probe-result"
            :data-ok="String(settings.probe.ok)"
          >
            <p class="probe__title" data-testid="settings-probe-title">
              {{ probeTitle }}
              <span class="probe__at">探测于 {{ settings.probeAt }}</span>
            </p>
            <p class="probe__msg" data-testid="settings-probe-summary">{{ probeSummary }}</p>
            <details class="tech">
              <summary class="tech__sum" data-testid="settings-probe-raw-summary">
                技术详情（服务端原始回执）
              </summary>
              <p class="probe__msg" data-testid="settings-probe-message">{{ settings.probe.message }}</p>
            </details>
          </div>

          <div class="card__foot">
            <span class="save-state" :data-phase="saveState" data-testid="settings-dirty">
              {{ saveStateText }}
            </span>
            <el-button
              data-testid="settings-reset"
              :disabled="!settings.dirty || settings.busy"
              @click="settings.resetDraft()"
            >
              放弃修改
            </el-button>
            <el-button
              data-testid="settings-probe"
              :loading="settings.probing"
              :disabled="settings.busy"
              @click="runProbe"
            >
              仅探测
            </el-button>
            <el-button data-testid="settings-save-only" :disabled="settings.busy" @click="runSaveOnly">
              仅保存
            </el-button>
            <!-- 本页的主动作：走共享的 `.k12-cta` 配方（主按钮的样式只允许有一处实现） -->
            <button
              type="button"
              class="k12-cta"
              data-testid="settings-save"
              :disabled="settings.busy"
              @click="runSave()"
            >
              {{ settings.saving ? '正在保存…' : '保存并生效' }}
            </button>
          </div>
        </SurfacePanel>

        <!-- ⑤ 嵌入模型（技术设置，与供应商同属高级区） -->
        <SurfacePanel class="card" data-section="embedding" data-testid="settings-embedding">
          <header class="card__head">
            <Database :size="15" />
            <h2 class="card__title">嵌入模型</h2>
            <span class="card__meta">本地 CPU 推理</span>
          </header>

          <div class="field">
            <p class="field__label">当前模式</p>
            <el-radio-group :model-value="settings.embedding.mode" @change="setEmbeddingMode">
              <el-radio-button
                v-for="mode in EMBEDDING_MODES"
                :key="mode"
                :value="mode"
                :data-testid="`settings-embedding-${mode}`"
              >
                {{ EMBEDDING_MODE_LABELS[mode] }}
              </el-radio-button>
            </el-radio-group>
          </div>

          <!-- 云端接口才需要地址与 Key（切模式**不会**清掉已填的值） -->
          <el-form v-if="settings.embedding.mode === 'cloud_api'" label-position="top" class="form">
            <el-form-item label="接口地址">
              <el-input
                v-model="settings.embedding.baseUrl"
                data-testid="settings-embedding-baseurl"
                placeholder="https://…（OpenAI 兼容的 /embeddings）"
              />
            </el-form-item>
            <el-form-item label="模型名">
              <el-input
                v-model="settings.embedding.modelId"
                data-testid="settings-embedding-modelid"
                placeholder="text-embedding-3-small"
              />
            </el-form-item>
            <el-form-item label="API Key">
              <div class="row-inline">
                <el-input
                  v-model="settings.embedding.apiKey"
                  data-testid="settings-embedding-apikey"
                  :type="showEmbeddingKey ? 'text' : 'password'"
                  autocomplete="new-password"
                  :placeholder="embeddingHasStoredKey ? '已保存（留空则不修改）' : '请输入 API Key'"
                  @input="settings.markEmbeddingKeyEdited()"
                />
                <el-button
                  text
                  :title="showEmbeddingKey ? '隐藏' : '显示'"
                  @click="showEmbeddingKey = !showEmbeddingKey"
                >
                  <component :is="showEmbeddingKey ? EyeOff : Eye" :size="16" />
                </el-button>
              </div>
              <p class="key-row">
                <span class="key-state" data-testid="settings-embedding-key-status">
                  {{ settings.embeddingKeyStatus }}
                </span>
                <span
                  v-if="settings.embeddingKeyCleared"
                  class="key-cleared"
                  data-testid="settings-embedding-key-cleared"
                >
                  保存后将删除已存的 Key
                </span>
                <el-button
                  text
                  size="small"
                  data-testid="settings-embedding-clear-key"
                  :disabled="settings.busy || !embeddingHasStoredKey"
                  @click="settings.clearStoredEmbeddingKey()"
                >
                  清除已保存的 Key
                </el-button>
              </p>
            </el-form-item>
          </el-form>

          <!-- 体检数字全部来自后端（`GET /api/knowledge/stats`）：
               渲染进程既不读 SQLite，也不自己数一遍已知的行 -->
          <el-descriptions :column="1" size="small" border data-testid="settings-embedding-stats">
            <el-descriptions-item label="模型">
              <code class="mono">{{ statsModel || '（尚未读到）' }}</code>
            </el-descriptions-item>
            <el-descriptions-item label="向量维度">
              {{ statsDim === null ? '（尚未读到）' : `${statsDim} 维` }}
            </el-descriptions-item>
            <el-descriptions-item label="向量索引">
              {{ knowledge.vecReady ? '可用' : '不可用 —— 检索会退回关键词 / 大纲降级' }}
            </el-descriptions-item>
            <el-descriptions-item label="已入库">
              {{ knowledge.chunkCount }} 个分块 · {{ knowledge.knowledgePointCount }} 个知识点
            </el-descriptions-item>
          </el-descriptions>
          <p v-if="knowledge.statsLoading" class="hint" data-testid="settings-embedding-stats-loading">
            正在读取教材知识库的体检数字…
          </p>
          <p v-else-if="knowledge.statsError" class="warn" data-testid="settings-embedding-stats-error">
            {{ knowledge.statsError }}
          </p>

          <p class="hint">
            不引入 torch，不依赖 Ollama。升级到 <code>bge-base-zh-v1.5</code>（768 维）须同步改
            <code>vec0</code> 维度并重建索引。
          </p>

          <div class="card__foot">
            <el-button
              data-testid="settings-embedding-save"
              :disabled="settings.busy"
              @click="runSaveOnly"
            >
              保存嵌入设置
            </el-button>
          </div>
        </SurfacePanel>

        <!-- ⑥ 隐私与本地服务（技术状态，高级区最后一张；先讲「东西存在哪」这件安心的事） -->
        <SurfacePanel class="card" data-section="privacy">
          <header class="card__head">
            <ShieldCheck :size="15" />
            <h2 class="card__title">隐私与本地服务</h2>
          </header>

          <!-- 先给结论（学生与家长要读的是这三条），端口 / 进程号收进下面的「技术详情」：
               一个 10 岁学生读到「端口 51234」什么也判断不了，只会觉得界面很怪。 -->
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="数据存储">全本地，不上传</el-descriptions-item>
            <el-descriptions-item label="对话历史">
              Pi 会话文件（每人一份，落在 students/&lt;id&gt;/）
            </el-descriptions-item>
            <el-descriptions-item label="代码执行">渲染进程 Worker 隔离</el-descriptions-item>
          </el-descriptions>

          <ul class="rules">
            <li><Server :size="14" /><span>Python 服务只绑<strong>本机回环地址</strong>，端口由系统分配，启动时握手告知。</span></li>
            <li><HardDrive :size="14" /><span>对话正文不进 SQLite；一人一库，不跨学生复用连接。</span></li>
            <li><Cpu :size="14" /><span>涉未成年人数据最小化采集，不采集生物特征。</span></li>
          </ul>

          <!-- 本地数据服务的**真实**阶段（不再是写死的一行状态）。
               端口 / 进程号是排障数字：留在 `<details>` 里，需要时才展开
               （`<details>` 是原生折叠，键盘与读屏都直接可用，不必自己写一个）。 -->
          <details class="tech">
            <summary class="tech__sum">技术详情（端口 / 进程号）</summary>
            <div class="sidecar" data-testid="settings-sidecar" :data-phase="sidecar.phase">
              <span class="k12-dot" />
              <span class="sidecar__text">本地数据服务：{{ sidecar.phaseText }}</span>
              <span v-if="sidecar.state?.port" class="mono">端口 {{ sidecar.state.port }}</span>
              <span v-if="sidecar.state?.pid" class="mono">进程 {{ sidecar.state.pid }}</span>
            </div>
            <p v-if="sidecar.errorText" class="warn" data-testid="settings-sidecar-error">
              {{ sidecar.errorText }}
            </p>
          </details>
        </SurfacePanel>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st {
  padding: 18px 22px 24px;
  display: flex;
  flex-direction: column;
  /* 身份行 → 正文：块之间（20px），与"卡片之间"（16px）分开 */
  gap: var(--k12-gap-block);
}
.st__body {
  display: grid;
  /* 固定 180px 索引 + 弹性字段区。`align-items: start` 是 sticky 生效的前提：
   * 索引栏必须是"内容高"，它才有在网格行里移动的余量（被拉伸成满高就动不了）。 */
  grid-template-columns: 180px minmax(0, 1fr);
  gap: var(--k12-gap);
  align-items: start;
}
.st__sections {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap);
  min-width: 0;
}

/* ── 顶部三条状态（读失败 / 保存失败 / 已保存）──────────────────────────── */
.banner {
  padding: 9px 13px;
  border-radius: var(--k12-r-inset);
  border: 1px solid var(--k12-border-strong);
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
}
.banner--bad {
  background: var(--k12-bad-soft);
  border-color: var(--k12-bad-border);
  color: var(--k12-bad);
}
.banner--good {
  background: var(--k12-good-soft);
  border-color: var(--k12-good-border);
  color: var(--k12-good);
}

/* ── 左栏：章节索引 ─────────────────────────────────────────────────────
 * 不套卡片（本页层次是"页面 + 白卡片"，索引是导航不是内容），
 * 只靠一项浅底 + 强调墨表达"你在这里"。底色是页面底，所以吸顶时不会透出下边内容。 */
.nav {
  position: sticky;
  top: 0;
  min-width: 0;
}
.nav__title {
  margin-bottom: 6px;
}
.nav__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav__item {
  width: 100%;
  padding: 7px 11px;
  border: none;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-ui);
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .nav__item:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg);
  }
}
/* 当前章节：浅底 + 强调墨（不靠字重独自表达） */
.nav__item.is-active {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-weight: 650;
}

/* 高级段与上面那三条之间画一条细线：它们是**另一组东西**（技术设置），
 * 不是第五个学生设置项。分隔线是组与组之间的关系，不额外加标题（省一行视觉噪音）。 */
.nav__list--sub {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--k12-border);
}

/* 「高级设置（教师 / 答辩）」入口：quiet 的一条 —— 它在左栏底部，
 * 是**次级**入口而不是第四个设置项，所以不用 `.nav__item` 那套高亮语言。
 *
 * ★★ 这个串必须**一行放得下**（报告 1.9：180px 的左栏里它原来会折成两行）。
 *    按字宽算账（左栏 180px）：13px 字号下「高级设置（教师 / 答辩）」约 141px
 *    （10 个全角 + ` / `），再加两个 13px 图标 + 两处 6px 间距 + 22px 内边距
 *    ≈ 203px > 180px —— 它折行不是窗口太窄，是这个串本身比左栏宽。
 *    所以三处一起收：字号降到最小的一档 `--k12-fs-micro`（12px）、内边距 11px → 9px、
 *    间距 6px → 4px，并去掉左边那个**纯装饰**的滑块图标（收完约 166px，放得下）。
 *    （`ChevronRight` 留着 —— 它表达「点它是展开」，不是装饰；滑块图标那条语言
 *    在展开区标题上仍然有。）`white-space: nowrap` 是**兜底**：即便换了字体、
 *    某个学段配色的字宽略宽，也不会再折行（宁可挤，不许断）。
 *    ⚠️ 别把滑块图标加回来：加回来就又会折行（这正是这一条要解决的事）。 */
.nav__advanced {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  margin-top: 10px;
  padding: 7px 9px;
  /* 触控下限（守卫在 base.css 层给 Element Plus 与 `.k12-tap` 定 28px；
   * 这里是自绘按钮，自己也要够高） */
  min-height: 28px;
  border: 1px dashed var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-muted);
  font-family: inherit;
  font-size: var(--k12-fs-micro);
  line-height: var(--k12-lh-ui);
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .nav__advanced:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}
.nav__advanced-text {
  /* ★ 与按钮上的 `white-space: nowrap` 成对：文案不参与收缩、也不折行 */
  flex: none;
  white-space: nowrap;
}
.nav__advanced-ico {
  margin-left: auto;
  flex: none;
}

/* ── 右栏：章节卡片 ─────────────────────────────────────────────────────── */
.card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.card__head {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--k12-muted);
}
.card__title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  color: var(--k12-fg);
}
/* meta 不是角标：12px */
.card__meta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  text-align: right;
}
/* ★ 标题行里的「当前值 + 来源」（学段那一块）。
 * 为什么放这儿：报告 2.1 要去掉的就是「标题 / 字段名 / chip 值 / 来源」四遍复读 ——
 * 值既然是这一块唯一的状态，就写在标题后面，一块只读框与一行字段名都省掉。
 * 里面复用 `.readonly__text` / `.readonly__origin`：与「外观主题」那张卡的只读行
 * 是同一套字（同一个东西在两处必须长得一样）。 */
.card__now {
  display: inline-flex;
  align-items: baseline;
  gap: 9px;
  min-width: 0;
}
/* 标题行右缘的**唯一**动作入口（「改一改」= 展开下面那四档）。
 * 与 `.card__meta` 同一格：本页「右侧那一格」只放一种东西。
 * ⚠️ `min-height: 28px` 是触控下限（自绘按钮自己也要够高，与 `.adv__close` 同一配方）。 */
.card__act {
  flex: none;
  margin-left: auto;
  padding: 3px 11px;
  min-height: 28px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .card__act:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}
.card__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
/* 保存状态：说清"有没有东西没存" —— 比一个孤零零的保存按钮有用 */
.save-state {
  margin-right: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
}
.save-state[data-phase='dirty'] {
  color: var(--k12-warn);
}
.save-state[data-phase='saving'] {
  color: var(--k12-muted);
}
.save-state[data-phase='clean'] {
  color: var(--k12-good);
}

/* ── 表单：单列 ─────────────────────────────────────────────────────────── */
.form :deep(.el-form-item) {
  margin-bottom: 14px;
}
.form :deep(.el-form-item__label) {
  padding-bottom: 4px;
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.form :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}
.row-inline {
  display: flex;
  gap: 6px;
  width: 100%;
}
.hint {
  margin-top: 6px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.hint strong {
  color: var(--k12-fg);
  font-weight: 650;
}
.hint__ico {
  vertical-align: -2px;
  margin-right: 4px;
  color: var(--k12-muted);
}
/* 代码片不是角标：12px（原来是 11px，与角标同档，读不清） */
.hint code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.mono {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-accent-ink);
}
.warn {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-warn);
}
.notice {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-good);
}

/* ── 供应商预设下拉（原生 select：与 el-input 同一视觉语言，零新增依赖）── */
.pick {
  width: 100%;
  padding: 7px 11px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg);
  font-family: inherit;
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-ui);
  cursor: pointer;
}

/* ── 候选模型 / 选项按钮（学段四档、章节清单共用同一形态）─────────────── */
.cands {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.cands__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.cands__note {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.cands__list,
.opts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
/* 选项：与指示器上的选项同一视觉语言（选中 = 强调浅底 + 强调墨）
 * ★ 报告 4.1：卡内 chip 原来**自己带一圈描边**，而它已经坐在一张白卡里 ——
 *   外框（SurfacePanel）+ 内框（chip）= 两层边框，层级被说糊了。现在
 *   未选中**不描边**，只靠浅底把「这是一片可点的东西」说出来；描边留给选中态。
 *   ⚠️ 用 `transparent` 而不是删掉 `border`：hover / 选中加边时**不挤动文字**，
 *     几何一个字不变（与 `views/Quiz.vue` 的选项行同一手法）。 */
.opt,
.chip {
  padding: 4px 11px;
  /* ★ 触控下限 28px（K12 硬要求，由 `ux-pages-audit.mjs` 量出：这里曾只有 27px）。
   *   它们**都是可点的**（点了就选中那个模型 / 那一档），而旁边还有几个同样大小的兄弟，
   *   点偏一下就选错 —— 学生不会发现，只会觉得「回答怎么变差了」。
   *   `min-height` 而非 `height`：长模型名换行时要能撑高，不能被裁掉。 */
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  border: 1px solid transparent;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .opt:hover:not(:disabled),
  .chip:hover:not(:disabled) {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}
.opt:disabled,
.chip:disabled {
  cursor: not-allowed;
  color: var(--k12-muted-2);
}
.opt--on,
.chip--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
  font-weight: 650;
}
/* 「不限章节」与章按钮分开一点：它不是一章，是「不限定」 */
.opt--none {
  align-self: flex-start;
}
.chip {
  font-family: var(--k12-font-mono);
}

/* ── Key 栏的状态行（掩码 + 提示 + 清除）───────────────────────────────── */
.key-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.key-state {
  padding: 2px 8px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.key-hint,
.key-cleared {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.key-cleared {
  color: var(--k12-warn);
  font-weight: 600;
}

/* ── 探测结果 ──────────────────────────────────────────────────────────── */
.probe {
  padding: 9px 13px;
  border-radius: var(--k12-r-inset);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface-2);
}
.probe--ok {
  border-color: var(--k12-good-border);
  background: var(--k12-good-soft);
}
.probe--fail {
  border-color: var(--k12-warn-border);
  background: var(--k12-warn-soft);
}
.probe__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.probe__msg {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

/* ── 只读块（学段 / 章节 / 学段色调）──────────────────────────────────── */
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field__label {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 学段那一块：标题行已经写了当前值，正文只剩「一句说明 + 四档」——
 * 说明行的 `margin-top` 归零，否则卡片的 14px 与它的 6px 会叠出一个空档。 */
.field--grade > .hint {
  margin-top: 0;
}
.readonly {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  display: inline-flex;
  align-items: center;
  gap: 9px;
  align-self: flex-start;
  padding: 9px 13px;
}
.readonly__dot {
  background: var(--k12-good);
}
.readonly__text {
  font-size: var(--k12-fs-sm);
  font-weight: 620;
  color: var(--k12-fg);
}
.readonly__origin {
  padding-left: 9px;
  border-left: 1px solid var(--k12-border);
  font-size: var(--k12-fs-xs);
  color: var(--k12-accent-ink);
  font-weight: 600;
}

/* ── 本地数据服务状态 ──────────────────────────────────────────────────── */
.sidecar {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  padding: 9px 13px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
}
.sidecar__text {
  font-size: var(--k12-fs-sm);
  font-weight: 620;
  color: var(--k12-fg);
}

.rules {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.rules li {
  display: flex;
  gap: 9px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.rules li svg {
  flex: none;
  margin-top: 3px;
  color: var(--k12-muted);
}
.rules code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
}

/* ── 高级设置（教师 / 答辩）──────────────────────────────────────────────
 * 它是右栏里的一段**说明 + 开关 + 三张技术卡片**的共同容器，不是第五张卡片。
 * 用虚线框圈起来：与「白卡片 = 内容面」区分开 —— 这一块本身没有字段，
 * 底色**保持透出页面底**（不新造第 5 种表面，见 base.css 的层次规则：
 * paper-2 是「卡片**内**的嵌入块」，用它去包卡片会把材质关系反过来）。 */
.adv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px dashed var(--k12-border-strong);
  border-radius: var(--k12-r-card);
  background: transparent;
}
.adv__head {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--k12-muted);
}
.adv__title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  color: var(--k12-fg);
}
/* 收起键在右缘，与卡片头的 meta 同一位置（本页「右侧那一格」只放一种东西） */
.adv__close {
  margin-left: auto;
  padding: 3px 11px;
  min-height: 28px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .adv__close:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}
/* ★ 这段文案里**不许**出现「安全 / 权限 / 保护」这类词：开关是可绕过的，
 *   把它说成安全边界会让人以为界面藏起来的东西是安全的（见 stores/viewMode.ts）。 */
.adv__note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.adv__note strong {
  color: var(--k12-fg);
  font-weight: 650;
}
.adv__switch {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 11px 13px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
}
.adv__switch-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.adv__switch-title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.adv__switch-desc {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
/* 开关：轨道 + 滑块。
 * ⚠️ 状态**不只靠颜色**：轨道上的字写着「已打开 / 未打开」，滑块位置也不同
 *   （色盲学生、以及把界面调成素净主题时都还分得清）。 */
.adv__toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 11px 3px 4px;
  min-height: 28px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-family: inherit;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
.adv__toggle[data-on='true'] {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}
.adv__knob {
  width: 14px;
  height: 14px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-muted-2);
}
.adv__toggle[data-on='true'] .adv__knob {
  background: var(--k12-accent-ink);
}
.adv__toggle-text {
  white-space: nowrap;
}

/* ── 饱和度预览卡 ────────────────────────────────────────────────────────
 * 三张卡各带自己的 `data-grade` / `data-sat`，`.k12-swatch[...]` 那一组规则
 * （tokens.generated.css）就地重定义主题令牌 —— 所以卡内的色块引用
 * `var(--k12-page)` / `var(--k12-accent)` 时，取到的就是**那一档**的真实取值。
 * 组件里因此没有、也不该有任何硬编码色值。 */
.sats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.sat {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  min-height: 28px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .sat:hover {
    border-color: var(--k12-accent-border);
  }
}
/* 选中：描边 + 勾（**不只靠颜色**）。两张卡同时「看起来选中」是不可能的：
 * 勾只有一个，`aria-checked` 也只有一个为 true。 */
.sat--on {
  border-color: var(--k12-accent);
  box-shadow: inset 0 0 0 1px var(--k12-accent);
}
/* 小样：一个「页面底色 + 强调条 + 标签胶囊 + 白卡」的等比缩影。
 * ★ 为什么放这四样：三档饱和度的差别**不在强调色本身**（accent 由学段决定），
 *   而在「页面底色 / 浅底分级 / 胶囊底色」这三处（实测 vivid `#FFF2E4` vs
 *   soft `#fff9f3` vs mono `#FAFAFB`）。摆一个只有强调色的方块，三张卡会长得一样。 */
.sat__mock {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-page);
  border: 1px solid var(--k12-border);
}
.sat__mock-bar {
  height: 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent);
}
/* 胶囊：`--k12-chip-bg` / `--k12-chip-fg` 是饱和度轴上差别最大的一组
 * （vivid `#feede1` → soft `#fff5ef` → mono `#FFFFFF`）。 */
.sat__mock-chip {
  height: 8px;
  width: 44%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-chip-bg);
  border: 1px solid var(--k12-chip-fg);
}
.sat__mock-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface);
}
.sat__mock-line {
  height: 3px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
}
.sat__mock-line--short {
  width: 62%;
}
.sat__foot {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sat__label {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.sat__check {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--k12-r-pill);
  color: var(--k12-accent-ink);
}
.sat--on .sat__check {
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
}
.sat__desc {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}

/* ── 「技术详情」折叠块（原生 `<details>`：键盘与读屏直接可用）────────────
 * 端口号 / 进程号 / 服务端原始回执都收在这里：需要的人点开就有，
 * 学生日常不会先读到它们。 */
.tech {
  border-top: 1px solid var(--k12-border);
  padding-top: 6px;
}
.tech__sum {
  /* 可点目标：给足高度（原生 summary 默认约 20px） */
  min-height: 28px;
  display: flex;
  align-items: center;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .tech__sum:hover {
    color: var(--k12-accent-ink);
  }
}
.tech__sum:focus-visible {
  outline: 2px solid var(--k12-accent);
  outline-offset: 2px;
}
.tech .sidecar {
  margin-top: 6px;
}
/* 探测结果里的时刻：它是时间戳不是标题，比主句轻一档 */
.probe__at {
  font-weight: 500;
  color: var(--k12-muted);
}

/* ── 窄窗口：索引收成一行横向 tab，右栏单列满宽 ───────────────────────── */
@media (max-width: 1279px) {
  .st__body {
    grid-template-columns: minmax(0, 1fr);
  }
  .nav {
    position: static;
  }
  .nav__title {
    display: none;
  }
  .nav__list {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 6px;
  }
  .nav__item {
    width: auto;
  }
  /* 高级入口在窄窗口里也排进那一行，不再占一整个块 */
  .nav__advanced {
    width: auto;
    margin-top: 6px;
  }
  .nav__list--sub {
    border-top: none;
    padding-top: 0;
  }
}
</style>
