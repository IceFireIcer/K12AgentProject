<script setup lang="ts">
/**
 * 设置：供应商 / 嵌入模型 / 外观主题 / 隐私与本地服务。
 *
 * ── 结构（本轮改造）：左「章节索引」+ 右「单列字段」────────────────────────
 * 上一版是 **4 张等价卡片竖排**（供应商 / 嵌入 / 主题 / 隐私）—— 主任务
 * （填供应商与 Key）与"主题饱和度"这种次要设置**同权**，学生看不出先做什么。
 * 现在：左栏 180px 是可点跳转的章节索引，右栏是当前章节的字段，供应商章节
 * 排在最前且占满右栏宽度，字段完整展开（它才是这一页的主任务）。
 * 跳转用 `scrollTop` 直接赋值（`behavior: 'auto'`）—— 本版**动效为零**，
 * `smooth` 也算动效，不要加。
 *
 * ⚠️ 焦点：全页内容区最大字号是身份行的 22px（PageIdentity），
 *    章节标题 16px 必须**小于**它 —— 否则"卡片的重量盖过内容"。
 *
 * ── 领域不变量（改动前逐条读）────────────────────────────────────────────
 * ⚠️ 学段设置**不存在**（AGENTS.md §5.1）：这里没有学段选择器 / 下拉 / 确认按钮 /
 *    纠偏入口，学段只以**只读说明**出现（`theme.gradeIndicatorText`）。
 * ⚠️ API Key 保存前必须做**真实连通性探测**（执行文档要求）：
 *    两种 /v1 写法都可能连通，不要静默改写用户填的地址，也不要「只存不验」。
 *
 * ★ `providerId` 与 `providerName` 是**两个字段，不能合并**（后端 contracts.py 明确要求）：
 *   - `providerId` 进 Pi，决定用哪份 provider 定义（认证方式 / 模型目录 / 协议）；
 *   - `providerName` 只用于显示与排查，填什么都行。
 *   原实现只放了「供应商名称」一个输入框 —— 于是学生改了显示名，Pi 那边纹丝不动。
 *   `providerId` 目前不在 `types/contract.ts` 的镜像里（见 README「已知取舍」），
 *   与 `apiKey` 一样先在本页局部补上，等接线换成 openapi-typescript 生成物即消失。
 *
 * ── 左栏跳转怎么保证"真的能用" ──────────────────────────────────────────
 * 滚动位置判定（章节顶越过容器顶 1/4 视口为界）有个固有极限：页尾那一节
 * **永远滚不到容器顶端**（scrollTop 被 clamp），纯位置判定会与点击目标不一致。
 * 所以点击是**权威**的：点完把滚动位置钉住（`pinnedTop`），只有当
 * 用户真的把容器滚到了别处（scrollTop 离开钉住点 >2px）才交还给位置判定。
 * 没有定时器、没有 rAF、没有"等滚动结束"的猜测 —— 状态完全由 scrollTop 决定。
 */
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Database, Palette, ShieldCheck, Plug, Eye, EyeOff, Server, HardDrive, Cpu, KeyRound } from 'lucide-vue-next'
import { useThemeStore, SATS } from '@/stores/theme'
import SurfacePanel from '@/components/SurfacePanel.vue'
import PageIdentity from '@/components/PageIdentity.vue'
import { settings, kbStats } from '@/mocks'

const theme = useThemeStore()

const llm = reactive({
  providerId: 'deepseek',
  ...settings.llm,
  apiKey: ''
})
const emb = reactive({ ...settings.embedding })
const probing = ref(false)
const showKey = ref(false)

/**
 * 保存：原型不真写盘，但**状态要完整**：脏 → 保存中 → 已保存。
 * 脏标记从表单变更那一刻起就出现 —— 学生才能知道"我有东西没存"。
 * 接线后这里是「写 config.json → 重写 models.json → 重建会话」三步，
 * 所以必须有进行中与失败两种状态。
 */
type SavePhase = 'clean' | 'dirty' | 'saving' | 'saved'
const savePhase = ref<SavePhase>('clean')
let saveTimer: number | null = null

/** 表单任一字段变化即置脏 */
function markDirty() {
  if (savePhase.value === 'saving') return
  savePhase.value = 'dirty'
}

function save() {
  if (savePhase.value === 'saving') return
  savePhase.value = 'saving'
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    savePhase.value = 'saved'
    ElMessage({ message: '已保存。接线后这一步会真实写入配置并让 Pi 重新读取。', type: 'success' })
    saveTimer = null
  }, 700)
}

function probe() {
  probing.value = true
  // 原型不发真实请求；接线时这里调用 sidecar 的探测端点并展示真实结果
  window.setTimeout(() => {
    probing.value = false
    ElMessage({
      message: '原型未接线：保存时会由后端发起真实连通性探测，并回显实际可用性',
      type: 'warning'
    })
  }, 600)
}

// ── 章节索引与跳转 ────────────────────────────────────────────────────────
const SECTIONS = [
  { id: 'provider', label: '供应商' },
  { id: 'embedding', label: '嵌入模型' },
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
/** 滚动祖先（`.shell__content`）与四个章节块：onMounted 时取一次，避免每帧查询 */
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

onMounted(() => {
  scroller = rootRef.value?.closest<HTMLElement>('.shell__content') ?? null
  if (!scroller) return
  sectionEls = [...(rootRef.value?.querySelectorAll<HTMLElement>('[data-section]') ?? [])]
  // 滚动是 passive 的：判定只读几何，不写 DOM 布局（不会触发滚动锁定）
  scroller.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
  onScroll()
})

onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onScroll)
  if (saveTimer !== null) clearTimeout(saveTimer)
})
</script>

<template>
  <div ref="rootRef" class="st">
    <!-- 身份行：本页在讲什么。22px，是全页内容区的**最大**字号 -->
    <PageIdentity
      main="模型接哪家、数据存在哪"
      meta="配置写入本地 config.json，API Key 仅存本机"
      hint="先填供应商与 Key 并测试连通，再保存"
    />

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
        <SurfacePanel class="card" data-section="provider">
          <header class="card__head">
            <Plug :size="15" />
            <h2 class="card__title">供应商</h2>
            <span class="card__meta">支持下改供应商 / BaseURL / Model ID</span>
          </header>

          <el-form label-position="top" class="form" @input="markDirty">
            <el-form-item label="Provider ID（进 Pi）">
              <el-input v-model="llm.providerId" placeholder="deepseek" />
              <p class="hint">
                决定用哪份 provider 定义。自定义或校内网关请自取一个 id（如 <code>custom</code>），
                并在 Pi 的 <code>models[]</code> 里声明模型，否则该供应商下一个模型都没有。
              </p>
            </el-form-item>

            <el-form-item label="供应商名称（仅显示）">
              <el-input v-model="llm.providerName" placeholder="DeepSeek" />
              <p class="hint">只用于界面与排查，不参与任何调用逻辑。</p>
            </el-form-item>

            <el-form-item label="BaseURL">
              <el-input v-model="llm.baseUrl" placeholder="https://api.deepseek.com" />
              <p class="hint">
                默认值不带 <code>/v1</code>。两种写法都可能连通，所以保存时<strong>以真实探测结果为准</strong>，
                系统不会替你改写地址。
              </p>
            </el-form-item>

            <el-form-item label="Model ID">
              <el-input v-model="llm.modelId" placeholder="deepseek-v4-flash" />
              <p class="hint">
                必须是该 provider 模型目录里<strong>真实存在</strong>的 id。DeepSeek 目录里只有
                <code>deepseek-v4-flash</code> / <code>-vision-exp</code> / <code>-pro</code>；
                填错会让首轮对话直接报「找不到模型」。
              </p>
            </el-form-item>

            <el-form-item label="API Key">
              <div class="row-inline">
                <el-input
                  v-model="llm.apiKey"
                  :type="showKey ? 'text' : 'password'"
                  :placeholder="llm.hasKey ? '已保存（留空则不修改）' : '请输入 API Key'"
                />
                <el-button text :title="showKey ? '隐藏' : '显示'" @click="showKey = !showKey">
                  <component :is="showKey ? EyeOff : Eye" :size="16" />
                </el-button>
              </div>
              <p class="hint">
                <KeyRound :size="12" class="hint__ico" />
                Key 仅存本机（<code>config.json</code>），不进日志、不进渲染进程。
                渲染进程永远拿不到明文 —— 只有主进程能读它。
              </p>
            </el-form-item>
          </el-form>

          <div class="card__foot">
            <span class="save-state" :data-phase="savePhase">
              {{ { clean: '', dirty: '有未保存的修改', saving: '正在保存…', saved: '已保存' }[savePhase] }}
            </span>
            <el-button :loading="probing" @click="probe">连通性探测</el-button>
            <el-button type="primary" :loading="savePhase === 'saving'" @click="save">保存并生效</el-button>
          </div>
        </SurfacePanel>

        <!-- ② 嵌入模型 -->
        <SurfacePanel class="card" data-section="embedding">
          <header class="card__head">
            <Database :size="15" />
            <h2 class="card__title">嵌入模型</h2>
            <span class="card__meta">本地 CPU 推理</span>
          </header>

          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="当前模式">本地 fastembed</el-descriptions-item>
            <el-descriptions-item label="模型">
              <code class="mono">{{ emb.modelId }}</code>
            </el-descriptions-item>
            <el-descriptions-item label="向量维度">{{ kbStats.embeddingDim }} 维</el-descriptions-item>
            <el-descriptions-item label="模型大小">约 90MB（随安装包分发）</el-descriptions-item>
          </el-descriptions>

          <p class="hint">
            不引入 torch，不依赖 Ollama。升级到 <code>bge-base-zh-v1.5</code>（768 维）须同步改
            <code>vec0</code> 维度并重建索引。
          </p>
        </SurfacePanel>

        <!-- ③ 外观主题（学段在此**只读出现**，没有选择入口） -->
        <SurfacePanel class="card" data-section="theme">
          <header class="card__head">
            <Palette :size="15" />
            <h2 class="card__title">外观主题</h2>
            <span class="card__meta">学段色调由系统决定</span>
          </header>

          <div class="field">
            <p class="field__label">当前学段色调（只读）</p>
            <div class="readonly">
              <span class="k12-dot readonly__dot" />
              <span class="readonly__text">{{ theme.gradeIndicatorText }}</span>
            </div>
            <p class="hint">
              这里没有学段选择器 —— 学段由系统根据对话自动推断并生效，学生端只读。
            </p>
          </div>

          <div class="field">
            <p class="field__label">饱和度</p>
            <el-radio-group v-model="theme.sat">
              <el-radio-button v-for="s in SATS" :key="s.key" :value="s.key">
                {{ s.label }}
              </el-radio-button>
            </el-radio-group>
            <p class="hint">{{ theme.satMeta.desc }}</p>
          </div>
        </SurfacePanel>

        <!-- ④ 隐私与本地服务 -->
        <SurfacePanel class="card" data-section="privacy">
          <header class="card__head">
            <ShieldCheck :size="15" />
            <h2 class="card__title">隐私与本地服务</h2>
          </header>

          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="数据存储">全本地，不上传</el-descriptions-item>
            <el-descriptions-item label="对话历史">Pi JSONL（每人一份，落在 students/&lt;id&gt;/）</el-descriptions-item>
            <el-descriptions-item label="代码执行">渲染进程 Worker 隔离</el-descriptions-item>
          </el-descriptions>

          <ul class="rules">
            <li><Server :size="14" /><span>Python 服务只绑 <code>127.0.0.1</code>，端口由系统分配，启动时握手告知。</span></li>
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
.save-state[data-phase='saved'] {
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
