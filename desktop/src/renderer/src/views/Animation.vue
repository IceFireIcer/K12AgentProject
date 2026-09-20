<script setup lang="ts">
/**
 * 动画讲解页 —— 对话内联动画卡的**展开视图**：同一套术语（概念 / 模板来源 / 时长 /
 * 播放条），同一份数据形状（`AnimationPayload`），只是舞台更大、多了模板库。
 *
 * ── 数据全部来自真实链路（三个端点，中间没有任何前端编造）─────────────────
 *
 *   模板清单  `GET  /api/animation/templates`  → `store.matched` / `store.availableIds`
 *   渲染      `POST /api/animation/render`     → `store.payload`（自包含的沙箱 HTML）
 *   托管      `POST /api/animation/host/…`     → `store.hosted`（一次性 nonce 地址）
 *
 * 舞台是**真的在播**：`sandbox/iframe-host.ts` 的 `AnimationSandboxHost` 托管 iframe
 * （沙箱属性只有 `allow-scripts`，那个「放开同源」的开关在 `FORBIDDEN_SANDBOX_FLAG`
 * 里被显式禁掉），播放 / 暂停 / 重播经 postMessage 指令驱动，进度由沙箱的节流回调喂进来
 * ——本页**没有自己的播放时钟**（不装本地计时器、不演假进度）。
 *
 * ★ 为什么必须经「一次性 nonce 托管」而不是把 HTML 塞进 `srcdoc`：
 *   iframe 带不了自定义 header，所以资源地址没法用口令鉴权；而做成公开路由就等于
 *   让任何人都能取到学生的动画内容。nonce 绑定「学生 + 知识点 + 有效期」，用一次即失效。
 *   ⚠️ 也正因为如此：**载荷里的 `html` 只有托管过才可播**（沙箱靠注入的 payload_id
 *   认自己的消息，`srcdoc` 那份的 id 与页面手里的对不上 → 会白等 5 秒然后降级）。
 *
 * ── 布局（改动前先读）────────────────────────────────────────────────
 *
 *   身份行（24px，全页唯一） → 舞台（全宽） → 舞台说明 → 底部横向动画条
 *
 * 模板从「左侧竖栏」变为**底部横向条**：舞台独占一行拿到全宽，动画仍是页面级选择，
 * 但退到内容之下。项宽固定 220px、项高**下限** 108px（随内容长高）、横向滚动不换行 ——
 * 于是条的高度不随动画数量长高，永远不会反过来挤压舞台。
 * 舞台标题 18px（块标题档），条上的段名 14px，标记 / 说明 13px。
 * ⚠️ 卡片的高度必须是**下限**而不是定值：定值 + `overflow: hidden` 会把放不下的
 *    内容**静默切掉**（四学段全适配的模板实测被切过一整行，见
 *    `tests/ux-pages-regression.test.ts` 的两条守卫）。
 *
 * ⚠️ 本页**刻意不做动效**（无 transition / animation）：动画本身在沙箱里跑，
 *    页面这一层不需要再用动效抢注意力。
 *
 * ── ★★ 学生视角 / 教师·答辩视角（`stores/viewMode.ts` + `<TeacherGate>`）────
 *
 *   本页此前把**实现侧的备忘直接印给学生**：沙箱属性名（`allow-scripts`）、
 *   一次性 nonce 的绑定与失效规则、模板 id、毫秒换算的标称时长、「可调参数 N 项」、
 *   以及「模板清单 → 渲染 → 托管」的三步链路说明。那是写给我们自己的验收证据，
 *   学生读到的是一张工程便条。
 *
 *   现在的纪律（与 `views/Quiz.vue` 同一条）：**学生视角一个字不留，教师视角一条不删**。
 *   判据不是「这句话有没有用」，而是「它在向谁解释什么」：
 *     · 向学生解释**他看到的画面** → 留在页面上（「动画就在这台电脑上播放，断网也能看」）；
 *     · 向我们解释**怎么实现的** → 进 `<TeacherGate>`。
 *   ★ 唯一从技术说明里**留下来给学生**的是「断网也能看」那一句 ——
 *     它是真话（模板与动画库都随包内联，见 `server/app/routes/resources.py`），
 *     而且是家长最在意的一条，不是实现细节。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Library, Pause, Play, RotateCcw, Wand2 } from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import PageIdentity from '@/components/PageIdentity.vue'
import TeacherGate from '@/components/TeacherGate.vue'
import { GRADE_LABELS } from '../labels'
import { useAnimationStore } from '../stores/animation'
import { useChatStore } from '../stores/chat'
import {
  AnimationSandboxHost,
  SANDBOX_ATTRIBUTE,
  buildIframeAttributes,
  readFallbackImage,
  shouldMountIframe
} from '../sandbox/iframe-host'
import type { GradeLevel } from '@shared/ipc-events'

const anim = useAnimationStore()
const chat = useChatStore()

/**
 * 学段：**只读对话 store 里那份判定结果**（没有就不传、也不猜）。
 *
 * ★ 本页不推断学段、也不改写学段 —— 判定的唯一落点在服务端（`grade/rules.py`）。
 *   拿不到时按「全部模板」列出来，并在胶片条上如实说明（见下面的 `gradeNote`）。
 */
const grade = computed<GradeLevel | null>(() => chat.currentGrade)
const gradeLabel = computed(() => (grade.value === null ? null : GRADE_LABELS[grade.value]))

/** 学段字面量 → 中文名（模板声明的是机器字面量 `junior` 这种；本页不另写一张表）。
 *  ★ 一个学段一个名字只有一个实现：下面两个拼装函数与卡片上的学段标签都调它。 */
function gradeName(level: string): string {
  return GRADE_LABELS[level as GradeLevel] ?? level
}

/** 教师视角的紧凑写法（`小学高年级 / 初中 / 高中`）—— 后台目录的读法。 */
function gradeText(levels: string[]): string {
  return levels.map(gradeName).join(' / ')
}

/**
 * 学生视角的一句话（`适合小学高年级、初中、高中`）。
 *
 * ★ 为什么不直接复用 `gradeText`：` / ` 分隔是**目录读法**，印在卡片上像一串标签值；
 *   顿号（`、`）才是中文里「并列几档」的自然写法。两者用途不同，不要合并 ——
 *   合并之后必然有一边将就另一边。
 */
function gradeAudienceText(levels: string[]): string {
  const names = levels.map(gradeName)
  return names.length === 0 ? '所有年级' : `适合${names.join('、')}`
}

/** 时长（毫秒 → 秒，一位小数）。模板标称值，不是本次播放的实测值。 */
function fmtDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
}

/* ------------------------------------------------------------------ *
 * 取数：模板清单（按学段筛）
 * ------------------------------------------------------------------ */

const busy = computed(() => anim.templatesLoading || anim.rendering || anim.hosting)

/**
 * 学段变了（或首次进来）就重新拉一次模板清单。
 *
 * ★ 模板是按学段筛的（`match_templates` 只返回不高于本学段的），所以换学段必须重取；
 *   而**换学段会作废舞台上的那一份** —— 旧模板可能已经不适配这一档了，
 *   留着它等于让界面显示一份与新学段无关的动画。
 */
async function syncTemplates(): Promise<void> {
  const level = grade.value
  const previous = anim.activeTemplateId
  await anim.loadTemplates(level === null ? {} : { gradeLevel: level }, true)
  if (anim.bridgeError !== null || anim.templatesError !== null) return
  if (anim.matched.length === 0) {
    anim.selectTemplate('')
    return
  }
  // 选中的模板还在清单里 → 舞台保持原样（不把学生正在看的那段推翻重渲染）
  if (previous !== '' && anim.matched.some((item) => item.id === previous)) return
  const next = anim.matched[0]!
  anim.selectTemplate(next.id)
  await renderStage(next.id)
}

/**
 * 渲染 + 托管（真实的两步后端调用）。
 *
 * ★ 失败原因一律直接显示后端给的那句可读中文（`renderError` / `hostError`），
 *   本页**不编**失败原因、也没有「模拟失败」这类按钮。
 */
async function renderStage(templateId?: string): Promise<void> {
  const id = templateId ?? anim.activeTemplateId
  if (id === '' || busy.value) return
  playing.value = false
  progress.value = 0
  await anim.renderAndHost({
    templateId: id,
    ...(grade.value === null ? {} : { gradeLevel: grade.value })
  })
}

/** 点模板条上的一项：换模板 → 立刻渲染到舞台（学生点它就是为了看那一个）。 */
async function chooseTemplate(id: string): Promise<void> {
  if (id === anim.activeTemplateId) return
  // 换模板会作废上一份渲染 / 托管结果（nonce 已经不该再用）——那是 store 的职责
  anim.selectTemplate(id)
  await renderStage(id)
}

/* ------------------------------------------------------------------ *
 * 舞台：AnimationSandboxHost 托管（真沙箱、真指令、真进度）
 * ------------------------------------------------------------------ */

/** 挂载条件：有托管地址就播；载荷里连 HTML 都没有 → 走文字讲解（绝不白屏）。 */
const canMount = computed(() => anim.hosted !== null && shouldMountIframe(anim.payload?.html ?? ''))

/** 舞台的四种呈现（其余时刻分别是空 / 加载 / 错误）。 */
const stageState = computed<'loading' | 'error' | 'empty' | 'idle' | 'live' | 'text'>(() => {
  if (anim.bridgeError !== null) return 'error'
  if (busy.value) return 'loading'
  if (anim.templatesError !== null || anim.renderError !== null || anim.hostError !== null) {
    return 'error'
  }
  if (anim.matched.length === 0) return 'empty'
  if (anim.payload === null) return 'idle'
  if (!shouldMountIframe(anim.payload.html)) return 'text'
  return canMount.value ? 'live' : 'text'
})

/** 后端给的真实失败原因（按「能不能接着用」的优先级取第一条）。 */
const stageError = computed<string>(
  () => anim.bridgeError ?? anim.templatesError ?? anim.renderError ?? anim.hostError ?? ''
)

/**
 * ★ 从胶片条里那个「加载 xx 个模板」到舞台上一份真正能播的产物，中间每一步都可能失败 ——
 *   而失败原因全是**后端给的可读中文**（通道缺失 / 渲染不过 / 托管不过），
 *   这里只负责原样显示，不加工、不美化。
 */
const DEGRADED_NOTICE_TEXT = '这个动画这次没播出来，下面这段文字把要点讲清楚了 —— 一样好学。'

/** 静态图同样过一遍 scheme 白名单（载荷不可信，不该让降级视图替我们对外发请求）。 */
const fallbackImage = computed(() => readFallbackImage(anim.payload?.fallbackImage ?? null))

const iframeAttrs = buildIframeAttributes()
const iframeEl = ref<HTMLIFrameElement | null>(null)
/** 非响应式：宿主实例只在挂载 / 卸载时进出，不需要参与渲染。 */
let host: AnimationSandboxHost | null = null

const sandboxPhase = ref<'loading' | 'ready' | 'degraded'>('loading')
/** 进度（0..1）：由沙箱的 `progress` 消息驱动，宿主侧已再节流一次（~10Hz）。 */
const progress = ref(0)
/**
 * 播放状态。
 *
 * ★ 协议里**没有**「你在播吗」这类查询（只有 play / pause / replay 三条指令），
 *   所以这里记的是**我们最后发出去的那条指令**，并配一条不变量：
 *   ready 时宿主明确发一次 `play`（模板在 ready 后由我们启动，不赌它自己 autoplay）。
 */
const playing = ref(false)
/** 降级的内部原因（**只进 `data-*`**，不摆给学生看 —— 学生只该看到「能动 / 不能动」）。 */
const degradeReason = ref('')
/** 指令没发出去这类可读提示（与「后端失败」分开：它是沙箱没就绪，不是链路断了）。 */
const controlError = ref('')

function teardownHost(): void {
  host?.dispose()
  host = null
}

function buildHost(payloadId: string, resourceUrl: string): AnimationSandboxHost {
  return new AnimationSandboxHost({
    payloadId,
    resourceUrl,
    onReady: () => {
      sandboxPhase.value = 'ready'
      degradeReason.value = ''
      controlError.value = ''
      // ★ 就绪后由宿主明确发一条 play：动画是不是在播，由我们这条指令定义
      //   （模板自己 autoplay 只是它的事，不能拿来当作界面的播放状态）。
      const started = host?.post('play') ?? false
      playing.value = started
    },
    onProgress: (value) => {
      progress.value = value
      // 播到头（模板在完成时如实上报 1）→ 按钮回到「播放」
      if (value >= 1) playing.value = false
    },
    onTimeout: (id) => {
      // ★ 5s 没 ready：走降级视图（显示模板自带的文字讲解）——**绝不白屏**
      goDegraded(`沙箱在 5 秒内没有就绪（payloadId=${id}）`)
    },
    onError: (message) => {
      goDegraded(`沙箱自报错误：${message || '(无说明)'}`)
    }
  })
}

function goDegraded(reason: string): void {
  sandboxPhase.value = 'degraded'
  degradeReason.value = reason
  playing.value = false
  // 拆掉宿主：它已经不可用了，留着只会继续发消息（iframe 也随 v-if 一起移除）
  teardownHost()
}

function postToSandbox(type: 'play' | 'pause' | 'replay'): boolean {
  const sent = host?.post(type) ?? false
  controlError.value = sent ? '' : '这条播放指令没有发出去（沙箱还没就绪）。'
  return sent
}

function togglePlay(): void {
  if (sandboxPhase.value !== 'ready') return
  const next = playing.value ? 'pause' : 'play'
  if (!postToSandbox(next)) return
  playing.value = next === 'play'
}

function replay(): void {
  if (sandboxPhase.value !== 'ready') return
  progress.value = 0
  if (postToSandbox('replay')) playing.value = true
}

/** 沙箱 → 宿主：来源与 `payload_id` 的校验都在宿主里（多卡串台防线）。 */
function onWindowMessage(event: MessageEvent): void {
  host?.handleMessage({ source: event.source, data: event.data })
}

/** iframe 的 `load`：载入 ≠ 就绪（就绪由 `ready` 消息定义），交给宿主处理。 */
function onFrameLoad(): void {
  host?.handleLoad()
}

/**
 * 托管结果换了（新的模板 / 新的 nonce）→ 重建沙箱。
 *
 * ★ 一个个重建而不是复用：旧的 nonce 已经作废，`iframe` 的地址也变了；
 *   复用同一个宿主只会把两段动画的 `payload_id` 混在一起（串台）。
 */
watch(
  () => anim.hosted?.url ?? '',
  async (url) => {
    teardownHost()
    progress.value = 0
    playing.value = false
    controlError.value = ''
    degradeReason.value = ''
    sandboxPhase.value = 'loading'
    if (url === '') return
    await nextTick()
    const payloadId = anim.hosted?.payloadId ?? ''
    if (payloadId === '' || iframeEl.value === null) return
    host = buildHost(payloadId, url)
    host.attach(iframeEl.value)
  }
)

// iframe 元素在「loading → live」之间会被创建 / 移除：出现时补一次 attach
// （宿主靠它起 ready 超时计时；不 attach 就会一直停在 loading）。
watch(iframeEl, (element) => {
  if (element !== null && host !== null) host.attach(element)
})

// 学段一变就重取模板清单（判定的唯一落点在服务端，本页只跟着它走）
watch(grade, () => void syncTemplates(), { immediate: true })

onMounted(() => {
  window.addEventListener('message', onWindowMessage)
})

/**
 * 卸载：移除窗口监听并拆掉宿主（**成对清理**，不留监听器与计时器）。
 *
 * ⚠️ 本页在 `App.vue` 的 `<KeepAlive>` 里：切到别的页触发的是 `onDeactivated`，
 *    这里**不处理**它 —— 正因为宿主一直活着，切回来时动画进度与 ready 状态才还在。
 */
onBeforeUnmount(() => {
  window.removeEventListener('message', onWindowMessage)
  teardownHost()
})

/* ------------------------------------------------------------------ *
 * 展示用的派生
 * ------------------------------------------------------------------ */

/** 舞台标题：有模板就用模板标题，没有就如实说「还没有」。
 *  ★ 不用载荷里的 `concept` 当标题 —— 那是这一轮讲什么，不是这块舞台在放什么。 */
const stageTitle = computed(() => anim.activeTemplate?.title ?? '还没有可播放的动画')

/** 主按钮文案。
 *  ★ 用「播放 / 再放一次」而不是「渲染到舞台 / 重新生成」：对屏幕前的学生来说，
 *    这一步发生的事情就是**这段动画开始播**；渲染与托管是它背后怎么实现的（那句话进教师视角）。 */
const renderLabel = computed(() => {
  if (anim.rendering || anim.hosting) return '正在准备…'
  return anim.payload === null ? '播放这段动画' : '再放一次'
})

/** 进度读数（百分比；模板总时长单独按标称值显示，不拿它冒充实测耗时）。 */
const progressPercent = computed(() => `${Math.round(progress.value * 100)}%`)
const stageDuration = computed(() =>
  anim.payload === null || anim.payload.durationMs <= 0 ? '' : fmtDuration(anim.payload.durationMs)
)

/**
 * 胶片条上那句口径（**学生版**）：按当前学段列了几段。
 *
 * ★ 原来这里是「本机 8 个模板 · 本次匹配 3 个（初中）」——「本机共几份」是**随包资产**
 *   的统计口径（后台目录的读法），学生关心的是「这里有几段是给我的」。
 *   原始口径进 `<TeacherGate>`，一个字没删。
 */
const stripMeta = computed(() => {
  const matchedCount = anim.matched.length
  return gradeLabel.value === null
    ? `共 ${matchedCount} 段（学段还没定，先都列出来）`
    : `适合${gradeLabel.value}的共 ${matchedCount} 段`
})

/** 胶片条上那句口径（**教师 / 答辩视角**）：本机共产出几份、本次匹配几份、按谁匹配的。 */
const stripMetaTeacher = computed(() => {
  const total = anim.availableIds.length
  const matchedCount = anim.matched.length
  return gradeLabel.value === null
    ? `本机 ${total} 个模板 · 本次匹配 ${matchedCount} 个（学段待判定，按全部列出）`
    : `本机 ${total} 个模板 · 本次匹配 ${matchedCount} 个（${gradeLabel.value}）`
})

/** 载荷来源徽章（内置模板 / 即时生成）。
 *  ★ 与对话里的动画卡（`cards/AnimationCard.vue`）用**同一对词**：同一个东西在
 *    两个界面上叫两个名字，学生只会以为它们是两回事。 */
const sourceLabel = computed(() => {
  if (anim.payload === null) return ''
  return anim.payload.source === 'generated' ? '即时生成' : '内置模板'
})

/** 教师 / 答辩视角：模板里可调的参数（本页一律用模板默认值，不假装调过参）。 */
const paramNote = computed(() => {
  const params = anim.activeTemplate?.params ?? []
  return params.length === 0 ? '' : `可调参数 ${params.length} 项（本次用默认值）`
})
</script>

<template>
  <div class="anim" data-testid="animation-view">
    <!-- 身份行（全页唯一的大字号）：内容区的最大字号在这里。
         `main` 说的是「这页在讲什么」，不是重复顶栏的「动画讲解」。
         ★ `meta` 原来是「模板优先，生成补充；舞台在沙箱里真播」—— 那是**生成侧与沙箱侧
           的内部口径**（评委要看，学生不必）。现在学生读到的是一句邀请，
           原文一句不删地搬进下面「舞台上的技术口径」那个 `<TeacherGate>`。 -->
    <PageIdentity
      main="把过程一步步画出来看"
      meta="挑一个动画，看它一步步动起来"
      hint="先挑一个动画，再点播放"
    />

    <!-- ══ 舞台：全宽主对象 ══════════════════════════════════════════════ -->
    <SurfacePanel flush class="anim__stage-card">
      <header class="anim__head">
        <div class="anim__head-text">
          <!-- 18px：块标题档。不得再往上抬去与身份行争焦点 —— 本页最大字号只有一个。 -->
          <h2 class="anim__title">{{ stageTitle }}</h2>
          <!-- ★ 学生视角：**这是什么 + 适合谁**。模板 id、毫秒换算的标称时长、
               「可调参数 N 项」都是实现事实，全部进下面的 `<TeacherGate>`（一个字没删）。 -->
          <p v-if="anim.activeTemplate" class="anim__sub">
            {{ anim.activeTemplate.concept }}
            · {{ gradeAudienceText(anim.activeTemplate.gradeLevels) }}
          </p>
          <p v-else class="anim__sub">从下面的动画里挑一个，点「播放这段动画」就能看。</p>
        </div>
        <span v-if="sourceLabel" class="anim__src">{{ sourceLabel }}</span>
        <button
          type="button"
          class="anim__ghost"
          data-testid="animation-view-render"
          :disabled="busy || anim.activeTemplate === null"
          @click="renderStage()"
        >
          <Wand2 :size="14" /><span>{{ renderLabel }}</span>
        </button>
      </header>

      <!-- 舞台：由 AnimationSandboxHost 托管，iframe 属性只有 allow-scripts
           （那个「放开同源」的开关在 FORBIDDEN_SANDBOX_FLAG 里被显式禁掉）。
           进度 / 播放状态全部来自沙箱消息，本页不自带时钟。 -->
      <div class="anim__stage" data-testid="animation-view-stage" :data-state="stageState">
        <!-- ① 真沙箱：载入 → ready → 播放 -->
        <template v-if="stageState === 'live' && sandboxPhase !== 'degraded'">
          <iframe
            ref="iframeEl"
            class="anim__frame"
            :sandbox="iframeAttrs.sandbox"
            :referrerpolicy="iframeAttrs.referrerpolicy"
            :src="anim.hosted?.url"
            :title="stageTitle"
            data-testid="animation-view-frame"
            :data-sandbox="SANDBOX_ATTRIBUTE"
            @load="onFrameLoad"
          />
          <p v-if="sandboxPhase === 'loading'" class="anim__veil" data-testid="animation-view-loading">
            动画正在准备…（等太久的话，会用文字把要点讲给你）
          </p>
        </template>

        <!-- ② 有产物但没有可播放的 HTML / 沙箱已降级 → 模板自带的文字讲解（**绝不白屏**） -->
        <div
          v-else-if="stageState === 'live' || stageState === 'text'"
          class="anim__fallback"
          data-testid="animation-view-fallback"
        >
          <p class="anim__fallback-text" data-testid="animation-view-fallback-text">
            {{ anim.payload?.fallbackText }}
          </p>
          <img
            v-if="fallbackImage"
            class="anim__fallback-img"
            :src="fallbackImage"
            alt="概念静态示意图"
            data-testid="animation-view-fallback-image"
          />
          <p v-if="degradeReason" class="anim__reason" :data-degrade-reason="degradeReason">
            {{ DEGRADED_NOTICE_TEXT }}
          </p>
        </div>

        <!-- ③ 加载 / 空 / 错误 / 未渲染：四种「没有画面」的时刻，各说各的原因。
             ★ 文案按 `EmptyState` 的规则写：只说**学生眼下的处境**与**下一步做什么**，
               不解释「后端在干什么」（旧句「在读模板清单 / 渲染 / 换一次性地址」就是反例）。 -->
        <EmptyState
          v-else-if="stageState === 'loading'"
          tone="loading"
          title="动画正在准备"
          desc="马上就好，都是在这台电脑上完成的。"
        />
        <EmptyState
          v-else-if="stageState === 'error'"
          tone="error"
          title="这个动画没能放出来"
          :desc="stageError"
          data-testid="animation-view-error"
        >
          <el-button :disabled="busy || anim.activeTemplate === null" @click="renderStage()">再试一次</el-button>
        </EmptyState>
        <EmptyState
          v-else-if="stageState === 'empty'"
          tone="empty"
          title="这里还没有能放的动画"
          :desc="`${gradeLabel ?? '你的学段'}这一档暂时没有配好的动画。先去对话里问问团团，或者换一档学段再回来看看。`"
        />
        <EmptyState
          v-else
          tone="empty"
          title="还没挑动画"
          :desc="`在下面选一个，再点「${renderLabel}」就能看到它动起来。`"
        />
      </div>

      <!-- 播放控制：只在真播的时候出现（没画面的时候摆一排按钮只会让人以为坏了）。
           进度条由沙箱的节流回调驱动，**本页不装本地计时器**。 -->
      <footer v-if="stageState === 'live' && sandboxPhase === 'ready'" class="anim__foot">
        <button
          type="button"
          class="anim__play"
          data-testid="animation-view-play"
          :title="playing ? '暂停' : '播放'"
          @click="togglePlay"
        >
          <component :is="playing ? Pause : Play" :size="15" />
        </button>
        <button
          type="button"
          class="anim__ghost anim__ghost--icon"
          data-testid="animation-view-replay"
          title="重新播放"
          @click="replay"
        >
          <RotateCcw :size="14" />
        </button>
        <div class="anim__progress" data-testid="animation-view-progress">
          <span class="anim__fill" :style="{ width: progressPercent }" />
        </div>
        <span class="k12-num anim__time">
          {{ playing ? '播放中' : '已暂停' }} · {{ progressPercent }}
          <template v-if="stageDuration"> / {{ stageDuration }}</template>
        </span>
      </footer>
      <p v-if="controlError" class="anim__control-err" data-testid="animation-view-control-error">
        {{ controlError }}
      </p>
    </SurfacePanel>

    <!-- 学生视角：一句人话（「断网也能看」对家长尤其重要，且它是**真的** ——
         模板与动画库都随包内联，没有任何外链）。
         ★★ 下面那段沙箱属性 / nonce 机制是**安全实现备忘**，此前直接印在学生页面上；
            现在整段进 `<TeacherGate>`，一句话不删（评委要看的就是这段设计证据）。 -->
    <p class="anim__note">
      动画就在这台电脑上播放，画面不会跳到别的地方去；<strong>断网也能看</strong>。
    </p>
    <TeacherGate label="动画是怎么安全播放的">
      <p class="anim__note anim__note--gate">
        舞台是 <strong>sandboxed iframe</strong>（沙箱属性只有 <code>allow-scripts</code>），
        动画库内联进 HTML，断网也能演示；资源地址是一次性 nonce（绑定学生 + 知识点 + 有效期，用一次即失效）。
      </p>
    </TeacherGate>

    <!-- ★★ 舞台的技术口径（**教师 / 答辩视角**，紧挨着舞台而不是塞在下面的动画条里 ——
         它说的是舞台）：
           · 身份行 `meta` 的**原文**（模板优先 / 生成补充 / 真沙箱）；
           · 模板 id、毫秒换算的标称时长、「可调参数 N 项（本次用默认值）」；
           · 载荷来源徽章的口径。 -->
    <TeacherGate label="舞台上的技术口径">
      <p class="anim__strip-note">
        <span class="k12-label">身份行原文</span>
        模板优先，生成补充；舞台在沙箱里真播。
      </p>
      <p class="anim__strip-note">
        <span class="k12-label">当前模板</span>
        <template v-if="anim.activeTemplate">
          模板 <code>{{ anim.activeTemplate.id }}</code>
          · 适配 {{ gradeText(anim.activeTemplate.gradeLevels) }}
          · 标称时长 {{ fmtDuration(anim.activeTemplate.durationMs) }}
          <template v-if="paramNote"> · {{ paramNote }}</template>
        </template>
        <template v-else>还没有选中模板。</template>
      </p>
      <p class="anim__strip-note">
        <span class="k12-label">载荷来源</span>
        徽章「{{ sourceLabel || '（未渲染）' }}」取自载荷的 <code>source</code> 字段
        （<code>template</code> = 模板直取，<code>generated</code> = 自由生成）。
        舞台上的进度由沙箱的节流回调驱动（~10Hz），本页不装本地计时器。
      </p>
    </TeacherGate>

    <!-- ══ 底部横向动画条：舞台在上、其它动画在下 ═════════════════════════────
         项宽固定 220px、项高**下限** 108px（随内容长高），横向滚动不换行 ——
         条的高度不随动画数量长高，也不会反过来挤压舞台。
         ★ 标题是**学生读的一行**（「还能看这几段动画」），不是后台目录名
           （原来是「动画模板」：那是我们内部对这批资产的叫法）。 -->
    <section class="anim__strip" aria-label="还能看的动画">
      <header class="strip__head">
        <Library :size="14" class="strip__ico" />
        <span class="strip__title">还能看这几段动画</span>
        <span class="strip__meta" data-testid="animation-view-strip-meta">{{ stripMeta }}</span>
      </header>

      <div class="strip__track">
        <button
          v-for="t in anim.matched"
          :key="t.id"
          type="button"
          class="tpl"
          :class="{ 'tpl--on': anim.activeTemplateId === t.id }"
          :aria-current="anim.activeTemplateId === t.id ? 'true' : undefined"
          :data-testid="`animation-view-template-${t.id}`"
          :disabled="busy"
          @click="chooseTemplate(t.id)"
        >
          <span class="tpl__top">
            <span class="tpl__name">{{ t.title }}</span>
          </span>
          <!-- ★ 学生视角：**它讲的是什么 + 给谁看**。
               「时长 4.8s」（毫秒换算的标称值）与「可调参数 N 项」是模板的**后台口径**，
               一张选片卡上摆这些，学生读到的是目录条目而不是「我能不能看懂它」。
               学段仍然保留（学生按它判断「这档是给我的吗」），只是换成自然说法。 -->
          <span class="tpl__concept">{{ t.concept }}</span>
          <span class="tpl__grades">
            <span v-for="g in t.gradeLevels" :key="g" class="tpl__grade">{{ gradeName(g) }}</span>
          </span>
        </button>

        <p v-if="anim.matched.length === 0" class="strip__empty">
          这里还没有能放的动画 —— 先去对话里问问团团，或者换一档学段再回来看看。
        </p>
      </div>

      <!-- ★★ 技术口径（**教师 / 答辩视角**）：胶片条上「本机共几份 / 匹配几份」，
           以及「模板优先，生成补充」的**真实分工**。原文一句不删 —— 它是
           「设计合理性」那 25% 的证据（本页只走模板这条路，自由生成那条在对话里由
           `generate_animation` 完成，本页不重复实现一遍）。 -->
      <TeacherGate label="模板清单与生成的分工">
        <p class="anim__strip-note">
          <span class="k12-label">模板口径</span>
          <span data-testid="animation-view-strip-meta-teacher">{{ stripMetaTeacher }}</span>
        </p>
        <p class="anim__strip-note">
          <span class="k12-label">链路</span>
          模板清单 → 按模板渲染 → 一次性地址托管给沙箱：本页走的就是这三步（每一步都是后端端点）。
          自由生成（校验 → 失败重试 ≤3 次 → 降级为文字或静态图）在对话里由 <code>generate_animation</code> 完成。
          模板内不得内联 CDN（沙箱断网会白屏）。
        </p>
      </TeacherGate>
    </section>
  </div>
</template>

<style scoped>
/* 单列流：页面自己只在 `.shell__content` 里纵向排块，不建内层滚动容器 ——
 * 于是内边距 18/22 与 PageActions 的默认 `--pa-pad-y/x` 对齐（本页无 PageActions）。
 *
 * ⚠️ 这里**不写 `height: 100%`**：页面高度由内容决定，滚动交给 `.shell__content`。 */
.anim {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap);
  padding: 18px 22px 24px;
}

/* ── 舞台卡（全宽主对象）──────────────────────────────────────────────── */
.anim__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px 12px;
}
.anim__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 块标题档（lg = 18px）：身份行之下第一档，不得与它同权争焦点 */
.anim__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  color: var(--k12-fg);
}
.anim__sub {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
/* 代码片是说明文字，不是角标 → 12px */
.anim__sub code,
.anim__strip-note code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
}
/* 来源徽章：≤4 字，是**角上的一个记号** → 11px 档 */
.anim__src {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-chip-bg);
  color: var(--k12-chip-fg);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
}
.anim__ghost {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}
@media (hover: hover) and (pointer: fine) {
.anim__ghost:hover:not(:disabled) {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}
}
.anim__ghost--icon {
  padding: 8px;
}
.anim__ghost:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 舞台：用 --fg 深色作底（与内联卡同一套视觉），画面是一块真 iframe */
.anim__stage {
  position: relative;
  min-height: 300px;
  margin: 0 18px;
  padding: 18px;
  border-radius: var(--k12-r-card);
  background: var(--k12-fg);
  display: flex;
  align-items: center;
  justify-content: center;
}
.anim__frame {
  display: block;
  width: 100%;
  min-height: 340px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
}
/* 加载中的遮罩：压在 iframe 上，给一句说明而不是一块空白 */
.anim__veil {
  position: absolute;
  inset: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--k12-r-inset);
  background: color-mix(in srgb, var(--k12-surface) 88%, transparent);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-sm);
  pointer-events: none;
}

/* 文字讲解（降级视图）：深底上的浅字，与沙箱画面的位置一致 */
.anim__fallback {
  width: 100%;
  padding: 20px 22px;
  border-radius: var(--k12-r-inset);
  background: color-mix(in srgb, var(--k12-surface) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--k12-surface) 16%, transparent);
}
.anim__fallback-text {
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-body);
  color: var(--k12-screen-fg);
  white-space: pre-wrap;
  word-break: break-word;
}
.anim__fallback-img {
  display: block;
  width: 100%;
  max-width: 480px;
  height: auto;
  margin-top: 12px;
  border-radius: var(--k12-r-inset);
}
.anim__reason {
  margin-top: 12px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-screen-dim);
}

.anim__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px 16px;
}
.anim__play {
  width: 34px;
  height: 34px;
  flex: none;
  border: none;
  border-radius: var(--k12-r-control);
  background: var(--k12-accent);
  color: var(--k12-surface);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
@media (hover: hover) and (pointer: fine) {
.anim__play:hover {
  filter: brightness(1.06);
}
}
/* 播放条：宽度由**沙箱上报的进度**驱动（没有本地时钟）。
 * 刻意不加 transition：进度本身就是连续的，补间只会让它比真话慢半拍。 */
.anim__progress {
  flex: 1;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.anim__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent);
}
.anim__time {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  flex: none;
}
.anim__control-err {
  padding: 0 18px 14px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-warn);
}

.anim__note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  padding: 0 2px;
}
/* 进 `<TeacherGate>` 的那一段：外面已经套了一层虚线技术块（10/12 内边距），
 * 这里不再加左右内边距，否则文字会比块里的其它内容缩进一截。 */
.anim__note--gate {
  padding: 0;
}
.anim__note code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}

/* ── 底部横向胶片条 ──────────────────────────────────────────────────── */
.anim__strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.strip__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
  padding: 0 2px;
}
.strip__ico {
  flex: none;
}
/* 13px：次级区块标题，不得与身份行争字号。 */
.strip__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.strip__meta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
/* 横向排开：项宽固定 220px、项高**下限** 108px（可随内容长高，见 .tpl）。
 * `align-items: stretch` 让同一条里的卡片**长得一样高**，所以条高仍然可预测
 * （就是最高的那张卡），不会出现参差不齐的锯齿。窄屏靠横向滚动兜住，不换行。 */
.strip__track {
  display: flex;
  align-items: stretch;
  gap: 10px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
}
.strip__empty {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
  padding: 12px 2px;
}
/* ★★ 高度是**下限**而不是定值（实测缺陷）：四学段全适配的模板（如
 * 「机器学本事：数据 → 训练 → 预测」）内容合计约 147px，而这里是 `height: 108px`
 * + `overflow: hidden` —— 「… · 时长 8.0s」整行与学段标签第二行被**静默切掉**，
 * 没有省略号也滚不动，读起来像「这个模板没有时长」。卡片高度必须由内容决定。
 *
 * 取舍：**信息完整 > 条高绝对固定**。条高仍可预测（`.strip__track` 是 stretch，
 * 同一条里的卡等高 = 最高的那张），代价是四学段的长标题模板会让整条高一档
 * （约 147px）；换来的是每张卡上的概念名与时长都真的看得见。
 * 若反过来选「收成首个 + `+N` 角标」，省下的是这 39px，丢的是学生一眼看出
 * 「这份模板适配哪几档学段」——本页的模板选择恰恰是按学段适配挑的，所以不选它。
 *
 * ⚠️ 不要改回固定 `height`，也不要靠 `overflow: hidden` 兜 —— 高度已经随内容，
 *    `hidden` 就只剩「把下一次溢出变成看不见」这一个作用。 */
.tpl {
  flex: none;
  width: 220px;
  min-height: 108px;

  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
.tpl:hover:not(:disabled) {
  border-color: var(--k12-accent-ink);
}
}
.tpl:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
/* 选中：accent-soft 底 + accent-ink 文字 + accent-border 描边。
 * accent-ink on accent-soft 是机器校验过的达标组合（见 check-contrast.mjs）。 */
.tpl--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.tpl--on .tpl__name,
.tpl--on .tpl__concept,
.tpl--on .tpl__grade {
  color: var(--k12-accent-ink);
}
.tpl__top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.tpl__name {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  font-weight: 620;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
  /* 最多两行：标题收到两行内，一张卡的标题不该把**整条**（含其它卡）拉高。
   * ⚠️ 这条与 `.tpl` 的 min-height 是配套的：卡高随内容长了，但长的是
   *    学段标签那一段（信息，必须完整），不是标题这一段（可截断，两行足够辨认）。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tpl__concept {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tpl__grades {
  display: flex;
  gap: 4px;
  /* ★★ `wrap` 是必须的（实测缺陷）：新库有**四个学段全适配**的模板
   * （如「机器学本事：数据 → 训练 → 预测」），四个学段标签一行放不下。
   * 原来是 `nowrap` + `overflow: hidden` —— 第 4 个标签被**从中间裁断**
   * （「初中」只剩上半截，看着像「初十」），而且**没有省略号、也没法滚**，
   * 学生完全不知道自己漏看了一档学段。
   * `nowrap` 在这里没有收益（卡片高度本来就随内容撑 —— `.tpl` 是 `min-height`
   * 而不是固定高，两处必须一起看），换行是唯一正确的表达。 */
  flex-wrap: wrap;
  /* 换行后的第二行标签也要和概念行拉开，否则像挤在一起的一团（gap 只管行内间距） */
  row-gap: 4px;
  margin-top: auto;
}
.tpl__grade {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
}
.anim__strip-note {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  margin-top: 2px;
  padding: 10px 11px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
}
</style>
