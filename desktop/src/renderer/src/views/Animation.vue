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
 *   身份行（22px，全页唯一） → 舞台（全宽） → 舞台说明 → 底部横向胶片条
 *
 * 模板从「左侧竖栏」变为**底部横向条**：舞台独占一行拿到全宽，模板仍是页面级选择，
 * 但退到内容之下。条高固定（项高 108px）、项宽固定 220px、横向滚动不换行 ——
 * 于是条的高度不随模板数量长高，永远不会反过来挤压舞台。
 * 舞台标题 16px（块标题档），模板名 13px，标记 / 说明 12px。
 *
 * ⚠️ 本页**刻意不做动效**（无 transition / animation）：动画本身在沙箱里跑，
 *    页面这一层不需要再用动效抢注意力。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Library, Pause, Play, RotateCcw, Wand2 } from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import PageIdentity from '@/components/PageIdentity.vue'
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

/** 学段字面量 → 中文名（模板声明的是机器字面量 `junior` 这种；本页不另写一张表）。 */
function gradeText(levels: string[]): string {
  return levels.map((level) => GRADE_LABELS[level as GradeLevel] ?? level).join(' / ')
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
const DEGRADED_NOTICE_TEXT = '动画没能加载，已用文字讲解顶上'

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

/** 主按钮文案：没渲染过是「渲染到舞台」，已渲染过是「重新生成」。 */
const renderLabel = computed(() => {
  if (anim.rendering) return '正在渲染…'
  if (anim.hosting) return '正在托管…'
  return anim.payload === null ? '渲染到舞台' : '重新生成'
})

/** 进度读数（百分比；模板总时长单独按标称值显示，不拿它冒充实测耗时）。 */
const progressPercent = computed(() => `${Math.round(progress.value * 100)}%`)
const stageDuration = computed(() =>
  anim.payload === null || anim.payload.durationMs <= 0 ? '' : fmtDuration(anim.payload.durationMs)
)

/** 胶片条上那句口径：本机共几份、本次匹配几份、按谁匹配的。 */
const stripMeta = computed(() => {
  const total = anim.availableIds.length
  const matchedCount = anim.matched.length
  return gradeLabel.value === null
    ? `本机 ${total} 个模板 · 本次匹配 ${matchedCount} 个（学段待判定，按全部列出）`
    : `本机 ${total} 个模板 · 本次匹配 ${matchedCount} 个（${gradeLabel.value}）`
})

/** 载荷来源徽章（模板直取 / 即时生成）—— 只有真的渲染出产物时才显示。 */
const sourceLabel = computed(() => {
  if (anim.payload === null) return ''
  return anim.payload.source === 'generated' ? '即时生成' : '模板直取'
})

/** 脚手架：模板里可调的参数（本页一律用模板默认值，不假装调过参）。 */
const paramNote = computed(() => {
  const params = anim.activeTemplate?.params ?? []
  return params.length === 0 ? '' : `可调参数 ${params.length} 项（本次用默认值）`
})
</script>

<template>
  <div class="anim" data-testid="animation-view">
    <!-- 身份行（22px，全页唯一）：内容区的最大字号在这里。
         `main` 说的是「这页在讲什么」，不是重复顶栏的「动画讲解」；
         `meta` 承接原先写在左侧栏里的口径（模板优先 / 真沙箱），同一句话说一遍。 -->
    <PageIdentity
      main="把过程一步步画出来看"
      meta="模板优先，生成补充；舞台在沙箱里真播"
      hint="先挑模板，再在舞台上播放"
    />

    <!-- ══ 舞台：全宽主对象 ══════════════════════════════════════════════ -->
    <SurfacePanel flush class="anim__stage-card">
      <header class="anim__head">
        <div class="anim__head-text">
          <!-- 16px：块标题档。不得用 22px 去与身份行争焦点 —— 本页最大字号只有一个。 -->
          <h2 class="anim__title">{{ stageTitle }}</h2>
          <p v-if="anim.activeTemplate" class="anim__sub">
            模板 <code>{{ anim.activeTemplate.id }}</code>
            · 适配 {{ gradeText(anim.activeTemplate.gradeLevels) }}
            · 标称时长 {{ fmtDuration(anim.activeTemplate.durationMs) }}
            <template v-if="paramNote"> · {{ paramNote }}</template>
          </p>
          <p v-else class="anim__sub">从下面的模板条里挑一个，渲染到舞台上。</p>
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
            动画加载中…（超过 5 秒会自动切换成文字讲解）
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

        <!-- ③ 加载 / 空 / 错误 / 未渲染：四种「没有画面」的时刻，各说各的原因 -->
        <EmptyState
          v-else-if="stageState === 'loading'"
          tone="loading"
          title="正在准备这一页的动画"
          desc="在读模板清单 / 渲染 / 换一次性地址 —— 都是本机完成，不需要联网。"
        />
        <EmptyState
          v-else-if="stageState === 'error'"
          tone="error"
          title="动画没能渲染出来"
          :desc="stageError"
          data-testid="animation-view-error"
        >
          <el-button :disabled="busy || anim.activeTemplate === null" @click="renderStage()">再试一次</el-button>
        </EmptyState>
        <EmptyState
          v-else-if="stageState === 'empty'"
          tone="empty"
          title="本机没有匹配上的动画模板"
          :desc="`共有 ${anim.availableIds.length} 份模板，但都不适配当前学段（${gradeLabel ?? '待判定'}）。先去对话里问一问，或者换一档学段再回来。`"
        />
        <EmptyState
          v-else
          tone="empty"
          title="舞台还空着"
          desc="上面选中的模板还没有渲染 —— 点「渲染到舞台」就能看到它真的动起来。"
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

    <p class="anim__note">
      舞台是 <strong>sandboxed iframe</strong>（沙箱属性只有 <code>allow-scripts</code>），
      动画库内联进 HTML，断网也能演示；资源地址是一次性 nonce（绑定学生 + 知识点 + 有效期，用一次即失效）。
    </p>

    <!-- ══ 底部横向胶片条：舞台在上、模板条在下 ═════════════════════════────
         项宽固定 220px、项高**下限** 108px（随内容长高），横向滚动不换行 ——
         条的高度不随模板数量长高，也不会反过来挤压舞台。 -->
    <section class="anim__strip" aria-label="动画模板">
      <header class="strip__head">
        <Library :size="14" class="strip__ico" />
        <span class="strip__title">动画模板</span>
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
          <span class="tpl__grades">
            <span v-for="g in t.gradeLevels" :key="g" class="tpl__grade">{{ gradeText([g]) }}</span>
          </span>
          <span class="tpl__concept">{{ t.concept }} · 时长 {{ fmtDuration(t.durationMs) }}</span>
        </button>

        <p v-if="anim.matched.length === 0" class="strip__empty">
          没有适配当前学段的模板 —— 先去对话里问一问，或者换一档学段再回来。
        </p>
      </div>

      <!-- 「模板优先，生成补充」的**真实分工**：本页只走模板这条路，
           自由生成那条（校验 → 失败重试 ≤3 → 降级文字/静态图）在对话里由
           `generate_animation` 完成 —— 本页不重复实现一遍。 -->
      <p class="anim__strip-note">
        <span class="k12-label">链路</span>
        模板清单 → 按模板渲染 → 一次性地址托管给沙箱：本页走的就是这三步（每一步都是后端端点）。
        自由生成（校验 → 失败重试 ≤3 次 → 降级为文字或静态图）在对话里由 <code>generate_animation</code> 完成。
        模板内不得内联 CDN（沙箱断网会白屏）。
      </p>
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
/* 16px 块标题档（旧版 22px：与身份行同权，焦点不在「这页在讲什么」上） */
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
/* 13px：次级区块标题，不得与身份行的 22px 相争。 */
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
