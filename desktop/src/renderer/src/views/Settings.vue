<script setup lang="ts">
/**
 * 设置：供应商 / 嵌入模型 / 学段 / 教材章节 / 外观主题 / 隐私与本地服务。
 *
 * ── 结构：左「章节索引」+ 右「单列字段」──────────────────────────────────
 * 左栏 180px 是可点跳转的章节索引，右栏是当前章节的字段；供应商章节排在最前
 * 且占满右栏宽度，字段完整展开（它才是这一页的主任务）。
 * 跳转用 `scrollTop` 直接赋值（`behavior: 'auto'`）—— 本版**动效为零**，
 * `smooth` 也算动效，不要加。
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
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
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
  ShieldCheck
} from 'lucide-vue-next'
import { GRADE_LEVELS } from '../api/grade'
import { EMBEDDING_MODE_LABELS, MANUAL_PRESET_ID, type EmbeddingMode } from '../api/settings'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL, chapterLineLabel, gradeOriginLabel } from '../labels'
import { useChatStore } from '../stores/chat'
import { useKnowledgeStore } from '../stores/knowledge'
import { useSettingsStore } from '../stores/settings'
import { useSidecarStore } from '../stores/sidecar'
import { useStudyStore } from '../stores/study'
import { SATS, useThemeStore } from '../stores/theme'
import PageIdentity from '../components/PageIdentity.vue'
import SurfacePanel from '../components/SurfacePanel.vue'
import type { GradeLevel } from '@shared/ipc-events'

const settings = useSettingsStore()
const chat = useChatStore()
const study = useStudyStore()
const knowledge = useKnowledgeStore()
const sidecar = useSidecarStore()
const theme = useThemeStore()

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
    if (!result.ok) gradeError.value = result.message ?? '设定学段失败，请稍后再试。'
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

function setSat(value: unknown): void {
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
const SECTIONS = [
  { id: 'provider', label: '供应商' },
  { id: 'embedding', label: '嵌入模型' },
  { id: 'grade', label: '学段' },
  { id: 'chapter', label: '教材章节' },
  { id: 'theme', label: '外观主题' },
  { id: 'privacy', label: '隐私与本地服务' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** 跳转落点：章节顶离容器顶留一点余量（与判定线配合，见 SPY_LINE_RATIO） */
const NAV_OFFSET = 12
/** 章节判定线：容器顶往下 1/4 视口处；容器很矮时至少留 24px */
const SPY_FLOOR = 24
const SPY_LINE_RATIO = 0.25

const rootRef = ref<HTMLElement | null>(null)
/** 滚动祖先（`.shell__content`）与各章节块：onMounted 时取一次，避免每帧查询 */
let scroller: HTMLElement | null = null
let sectionEls: HTMLElement[] = []

const activeId = ref<SectionId>('provider')
/** 点击后的"钉子"：记住跳转落点的 scrollTop，直到用户真的滚开才交还给位置判定 */
let pinnedTop: number | null = null

function isSectionId(v: string | undefined): v is SectionId {
  return SECTIONS.some((s) => s.id === v)
}

/** 纯位置判定：章节顶越过判定线的**最后一个**章节就是"当前章节" */
function derivedSection(): SectionId {
  const c = scroller
  if (!c) return 'provider'
  // 已到底：页尾那一节可能永远到不了判定线（scrollTop 被 clamp），直接认它
  if (c.scrollTop + c.clientHeight >= c.scrollHeight - 2) {
    const last = sectionEls[sectionEls.length - 1]?.dataset.section
    if (isSectionId(last)) return last
  }
  const line = c.getBoundingClientRect().top + Math.max(SPY_FLOOR, c.clientHeight * SPY_LINE_RATIO)
  let current: SectionId = 'provider'
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

onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onScroll)
})
</script>

<template>
  <div ref="rootRef" class="st" data-testid="settings-view">
    <!-- 身份行：本页在讲什么。22px，是全页内容区的**最大**字号 -->
    <PageIdentity
      main="模型接哪家、数据存在哪"
      meta="配置写入本地 config.json，API Key 仅存本机"
      hint="先填供应商与 Key 并测试连通，再保存"
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
      <!-- 左栏：章节索引（可点跳转，当前章节高亮） -->
      <nav class="nav" aria-label="设置章节">
        <p class="k12-label nav__title">章节</p>
        <ul class="nav__list">
          <li v-for="s in SECTIONS" :key="s.id">
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
      </nav>

      <!-- 右栏：各章节的字段（**单列**，不再用 2 列网格） -->
      <div class="st__sections">
        <!-- ① 供应商：本页主任务，占满右栏宽度，字段完整展开 -->
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

          <!-- 探测结果：成功与失败都显示，一字不改（探测不会修改你填的内容） -->
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
            <p class="probe__title">
              探测结果（{{ settings.probeAt }}）· {{ settings.probe.ok ? '连通成功' : '未能连通' }}
            </p>
            <p class="probe__msg" data-testid="settings-probe-message">{{ settings.probe.message }}</p>
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
            <el-button
              type="primary"
              data-testid="settings-save"
              :loading="settings.saving"
              :disabled="settings.busy"
              @click="runSave()"
            >
              保存并生效
            </el-button>
          </div>
        </SurfacePanel>

        <!-- ② 嵌入模型 -->
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

        <!-- ③ 学段（第二个手动入口，D-037）：与对话页顶栏指示器**共用同一条写路径** -->
        <SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block">
          <header class="card__head">
            <GraduationCap :size="15" />
            <h2 class="card__title">学段</h2>
            <span class="card__meta">系统自动判定，你也能自己指定</span>
          </header>

          <div class="field">
            <p class="field__label">当前学段</p>
            <div class="readonly">
              <span class="k12-dot readonly__dot" />
              <span class="readonly__text">{{ gradeText }}</span>
              <span class="readonly__origin" data-testid="settings-grade-source">
                {{ gradeSource }}
              </span>
            </div>
            <p class="hint">
              学段由系统按你问的问题自动判断（判错了或还没判出来，就自己指定一档）。
              自己指定后 10 轮内系统不再自动改，期满照旧按你的实际水平调整。
            </p>
          </div>

          <div class="opts">
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

          <p v-if="gradeError" class="warn" data-testid="settings-grade-error">{{ gradeError }}</p>
          <p v-if="chat.gradeNotice" class="notice" data-testid="settings-grade-notice">
            {{ chat.gradeNotice }}
          </p>
          <p v-if="chat.gradeBridgeError" class="warn" data-testid="settings-grade-bridge">
            {{ chat.gradeBridgeError }}
          </p>
        </SurfacePanel>

        <!-- ④ 教材章节（软偏好，D-038）：与学段是两件独立的事 -->
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
              选择章节不会改变学段 —— 章节只让回答与检索优先围绕这一章，问到别的章照常回答。
              两件事各自独立：改学段会清空章节（那本教材不存在了），清空后回到自由问答。
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

        <!-- ⑤ 外观主题（配色跟着学段走；改学段的入口在上面那一区块） -->
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
            <p class="hint">
              强调色与页面底色跟着学段一起换。要改学段用上面的「学段」区块 —— 那一处与对话页
              顶栏的指示器是同一个开关，改一次两处都变。
            </p>
          </div>

          <div class="field">
            <p class="field__label">饱和度</p>
            <el-radio-group :model-value="theme.sat" @change="setSat">
              <el-radio-button v-for="s in SATS" :key="s.key" :value="s.key">
                {{ s.label }}
              </el-radio-button>
            </el-radio-group>
            <p class="hint">{{ theme.satMeta.desc }}</p>
          </div>
        </SurfacePanel>

        <!-- ⑥ 隐私与本地服务 -->
        <SurfacePanel class="card" data-section="privacy">
          <header class="card__head">
            <ShieldCheck :size="15" />
            <h2 class="card__title">隐私与本地服务</h2>
          </header>

          <!-- 本地数据服务的**真实**阶段（不再是写死的一行状态） -->
          <div class="sidecar" data-testid="settings-sidecar" :data-phase="sidecar.phase">
            <span class="k12-dot" />
            <span class="sidecar__text">本地数据服务：{{ sidecar.phaseText }}</span>
            <span v-if="sidecar.state?.port" class="mono">端口 {{ sidecar.state.port }}</span>
            <span v-if="sidecar.state?.pid" class="mono">进程 {{ sidecar.state.pid }}</span>
          </div>
          <p v-if="sidecar.errorText" class="warn" data-testid="settings-sidecar-error">
            {{ sidecar.errorText }}
          </p>

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
        </SurfacePanel>
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
/* 选项：与指示器上的选项同一视觉语言（选中 = 强调浅底 + 强调墨） */
.opt,
.chip {
  padding: 4px 11px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
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
}
</style>
