<script setup lang="ts">
/**
 * 动画卡片（票 16/17）：沙箱播放 + 播放/暂停/重播/进度 + **失败绝不白屏**。
 *
 * ★★ 三条红线（改这个文件前先读）：
 *
 * 1. **沙箱属性只有 `allow-scripts`**，永远不加「放开同源」那个属性
 *    （加了沙箱形同虚设：iframe 里能读宿主 DOM 与 localStorage）。
 *    属性值来自 `sandbox/iframe-host.ts` 的 `SANDBOX_ATTRIBUTE` 常量，本文件**不自己写** ——
 *    属性写两处，迟早有一处漏改。架构守卫会扫本文件。
 *
 * 2. **每条 postMessage 都带 `payload_id`，并校验来源**（多卡片同屏会串台）。
 *    校验逻辑全在 `AnimationSandboxHost.handleMessage()` 里（纯逻辑、可单测），
 *    本组件只负责把 window 事件转进去。
 *
 * 3. ★ **失败/超时一律降级成文字讲解，绝不白屏**。
 *    三条降级入口：载荷里 `html` 为空（编排层已降级）、iframe 5s 没 `ready`、
 *    沙箱自报 `error`。三条都走同一个 {@link goDegraded}。
 *
 *    ⚠️ 2026-09-23：本卡片**不再走托管地址**（原实现「托管优先、失败回退内联」已删），
 *      理由见 `mountIframe` 上那段 —— 一句话：一次性 nonce 落到持久载荷里就必然是死地址，
 *      再让 iframe 去取它，学生就会直面一个 `{"detail":"动画资源未通过 nonce 校验（used）"}`。
 *
 *    ⚠️ 2026-09-22（报告 1.8 / 4.3「动画内嵌白卡：删除」）：降级态原来还渲染一张
 *    `<img class="anim__fallback-img">` —— 它是主进程按**同一段降级文案**生成的 SVG
 *    （`src/main/agent/extensions/animation.ts` 的 `buildInlineFallbackImage`，
 *    正文截 34 字），摆在完整文案下面等于同一段话说了两遍，第二遍还带截断。
 *    现在删掉：降级态只剩「文字要点 + 一句提示」，学生读到的是一个说法而不是两个。
 *    ⚠️ 主进程那段 SVG 生成**照旧保留**（它随载荷发给渲染端，也进对话历史与降级产物，
 *    要删得先确认没有别的消费者 —— 那是载荷契约改动，不在本轮范围）；本卡片不再引用
 *    `view.fallbackImage`（页面 `views/Animation.vue` 同理）。
 *
 * 展开/全屏：内联卡片受对话框宽度限制，全屏用 fixed 覆盖层（同一个 iframe 元素**移动**过去，
 * 不重建 —— 重建会让动画从头开始播，学生看到的是「一按全屏就重播」这种莫名其妙的行为）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { InlineCard } from '../api/events'
import {
  AnimationSandboxHost,
  SANDBOX_ATTRIBUTE,
  buildIframeAttributes,
  readAnimationPayload,
  shouldMountIframe,
  type AnimationPayloadView
} from '../sandbox/iframe-host'

const props = defineProps<{ card: InlineCard }>()

const view: AnimationPayloadView = readAnimationPayload(props.card.payload)

/** 载荷里带的 `payload_id`；缺省时自己造一个（旧载荷 / 手写测试数据）。 */
const payloadId = ref<string>(
  typeof (props.card.payload as { payloadId?: unknown })?.payloadId === 'string' &&
    ((props.card.payload as { payloadId: string }).payloadId ?? '').length > 0
    ? (props.card.payload as { payloadId: string }).payloadId
    : `card-${props.card.id.replace(/[^A-Za-z0-9_-]/g, '_')}`
)

/**
 * 挂 iframe 的条件：**载荷里有 HTML**（`shouldMountIframe`），否则直接进降级视图。
 *
 * ★★ 为什么本卡片**只用内联 `srcdoc`，绝不把托管地址放进 `<iframe src>`**（2026-09-23 修复）：
 *
 * 旧实现「托管优先、失败再回退内联」有两处硬伤，实测都被用户撞到：
 *
 *   ① **载荷是持久化的，nonce 不是**。托管地址带一次性 nonce、TTL 只有 120 秒
 *      （`server/app/routes/resources.py`：`单次消费` + `Cache-Control: no-store`）。
 *      而这条 `resourceUrl` 会跟着会话**落盘**：切页回来重建卡片、回看历史、
 *      隔了 2 分钟再看、甚至 Chromium 丢弃一个隐藏 iframe 文档后再加载 ——
 *      每一种都会把同一个地址再取一次 → 403 `used` / `expired`。
 *   ② **失败的表现是把后端错误原文摆给学生**：iframe 拿到 403 就把
 *      `{"detail":"动画资源未通过 nonce 校验（used）"}` 当作文档渲染出来，
 *      于是学生在对话里看到一串英文 JSON；然后还要干等 5 秒超时才回退。
 *
 * 而内联 HTML **永远都在**：本行的挂载条件就是 `view.html` 非空（空则根本不会建 iframe），
 * 且托管的文件就是同一份 HTML（`hostAnimation({kpId, html})` 原样落盘）——
 * 也就是说「内联」与「托管」内容逐字相同，走内联却没有任何网络往返、不消耗 nonce、
 * 也不依赖 sidecar 存活（sidecar 挂了卡片照样能播）。
 *
 * ⚠️ 规格 D10 的「资源服务（Python 托管，带 nonce）」**没有被架空**：托管服务照旧签发与校验，
 *   **动画讲解页**的舞台就是它的正常消费者（它每次 `renderAndHost` 现签新地址，不会复用旧地址，
 *   实测切页回来也**不会**二次请求）。本文件只是不再当第二个消费者。
 */
const mountIframe = ref<boolean>(shouldMountIframe(view.html))

/** 是否已进入降级视图（文字讲解）。 */
const degraded = ref<boolean>(false)
/**
 * 降级的可读原因（**只进 `data-*` 属性**，不摆给学生看 —— 学生只该看到「能动/不能动」）。
 * 例：「沙箱在 5 秒内没有就绪（payloadId=xxxxx）」；这类内部细节（含 payloadId）留在这里，
 * 由 CDP 脚本（`scripts/verify-ui.mjs` 一类）读 `[data-degrade-reason]` 做断言。
 */
const degradeReason = ref<string>('')
/** 降级气泡上给学生看的**固定中文**（不随原因变化，也不含任何内部标识）。 */
// ★ 文案口径（评审）：旧句「动画没能加载，已用文字讲解」读起来像一句**故障通告**
//   （"没能加载"是系统的口径，不是学生关心的），而且听不出"我现在能做什么"。
//   新句先说清楚**现在有什么**（文字讲解已经把这件事讲清楚了），再说**可以怎么办**
//   （让智团团换个说法）—— 降级不是坏消息，只是换了种讲法。
// ⚠️ 页面（`views/Animation.vue`）的同一句按报告 C15 改短成「动画没播出来，先看文字要点。」，
//   这里**故意不改**：卡片上没有「再放一次」这类按钮，这句里的「想换个说法就问智团团」
//   是本卡片降级态**唯一**的下一步。两处**不是**同一个组件的两份实现，别顺手统一 ——
//   统一之后卡片会变成「只说坏消息、不给下一步」。
const DEGRADED_NOTICE_TEXT = '这段动画这次没能播出来，下面这段文字已经把要点讲清楚了；想换个说法就问智团团。'
/** 沙箱阶段（`loading` 时显示加载提示，而不是一块空白）。 */
const phase = ref<'loading' | 'ready' | 'degraded'>('loading')
const progress = ref<number>(0)
const expanded = ref<boolean>(false)

const iframeEl = ref<HTMLIFrameElement | null>(null)
const host = ref<AnimationSandboxHost | null>(null)

const iframeAttrs = buildIframeAttributes()

/** 卡片上的状态文案（学生看到的）。 */
const statusText = computed(() => {
  if (degraded.value) return '已切换为文字讲解'
  if (phase.value === 'ready') return '动画已就绪'
  return '动画加载中…'
})

/** 进度百分比（整数，避免尾数抖动）。 */
const progressPercent = computed(() => `${Math.round(progress.value * 100)}%`)

/**
 * 是否走**托管地址**（票 16 的一次性 nonce 路径）。
 *
 * ★★ 为什么需要这个开关（实测发现的真实缺陷）：
 *   托管地址带的是**一次性 nonce，TTL 只有 120 秒**（`app/routes/resources.py`）。
 *   一旦 iframe 重新加载它（应用重启后回看历史、组件被重建），后端会拒收
 *   （日志里 `动画资源被拒 … 原因=used / expired`），而**载荷里明明还躺着完整的内联 HTML**。
 *   旧实现把这种失败直接当终态 → 学生看到「动画没能加载，已用文字讲解」，
 *   动画白做了一次。现在改成：托管路径失败**先回退内联 HTML 再试一次**，
 *   只有连内联都没有时才是真降级。
 */
/** ★ 上面注释解释了为什么本卡片**没有** `useHosted` 这种开关：
 *    内联是唯一数据源，也就没有「两个数据源之间切换」可言。 */

function goDegraded(reason: string): void {
  if (degraded.value) return
  degraded.value = true
  degradeReason.value = reason
  phase.value = 'degraded'
  // 拆掉 iframe：它已经不可用了，留着只会占内存（也可能继续发消息）
  mountIframe.value = false
  host.value?.dispose()
}

/**
 * 挂载时的一次性通知（保持 `handleFailure` 这个名字：两个失败入口都走它）。
 *
 * ⚠️ **不再有「切换数据源」那条分支**（见 {@link mountIframe} 的说明）：
 *   内联是唯一数据源，所以失败 = 没救了 = 降级成文字讲解（绝不白屏）。
 *   原来的 `useHosted=false / fellBackToInline / buildHost()` 三步已删 ——
 *   它存在的前提是「托管地址可用」，而那个地址一旦落进会话就已经是死地址。
 */
function handleFailure(reason: string): void {
  goDegraded(reason)
}

function buildHost(): AnimationSandboxHost {
  const instance = new AnimationSandboxHost({
    payloadId: payloadId.value,
    srcdoc: view.html || undefined,
    onReady: () => {
      phase.value = 'ready'
    },
    onProgress: (value) => {
      progress.value = value
    },
    onTimeout: (id) => {
      // ★ 5s 没 ready：发过 timeout 之后走降级视图（**绝不白屏**）
      handleFailure(`沙箱在 5 秒内没有就绪（payloadId=${id}）`)
    },
    onError: (message) => {
      handleFailure(`沙箱自报错误：${message || '(无说明)'}`)
    }
  })
  return instance
}

/** iframe 的 `load`：交给宿主（载入 ≠ 就绪，就绪由 `ready` 消息定义）。 */
function onIframeLoad(): void {
  host.value?.handleLoad()
}

/** 窗口消息 → 宿主（来源与 payload_id 的校验都在宿主里）。 */
function onWindowMessage(event: MessageEvent): void {
  host.value?.handleMessage({ source: event.source, data: event.data })
}

function play(): void {
  if (!host.value?.post('play')) goDegraded('播放指令没有发出去（沙箱未就绪）')
}

function pause(): void {
  host.value?.post('pause')
}

function replay(): void {
  progress.value = 0
  if (!host.value?.post('replay')) goDegraded('重播指令没有发出去（沙箱未就绪）')
}

function toggleExpand(): void {
  expanded.value = !expanded.value
  // 全屏只是换容器：同一个 iframe 元素被 Vue 移动过去（`<Teleport>` 用了同一个 vnode，
  // 不会重建），所以动画不会从头开始。
}

onMounted(() => {
  // 载荷本身就是降级产物（编排层给的 `html` 为空）：直接进降级视图
  if (!mountIframe.value) {
    degraded.value = true
    phase.value = 'degraded'
    degradeReason.value = view.degradeReason ?? '这次没有可播放的动画（已用文字讲解顶上）'
    return
  }
  host.value = buildHost()
  window.addEventListener('message', onWindowMessage)
  if (iframeEl.value) host.value.attach(iframeEl.value)
})

/**
 * 卸载：移除 window 监听并拆掉宿主（**成对清理**，不留监听器与计时器）。
 *
 * ★ 本卡片处在 `App.vue` 的 `<KeepAlive>` 里（切到设置页再回来不该丢掉动画进度）：
 *   切走触发的是 `onDeactivated`，这里**不处理**它 —— 正因为监听器与宿主一直活着，
 *   切回来时进度与 ready 状态才还在；`onMounted` 也只跑一次，所以监听器不会重复注册。
 *   真正的卸载（卡片被移除 / 应用退出）仍会走到这里。
 */
onBeforeUnmount(() => {
  window.removeEventListener('message', onWindowMessage)
  host.value?.dispose()
  host.value = null
})

// iframe 元素在「收起 → 全屏」时会被移动，但 `ref` 指向的还是同一个元素；
// 这里只在挂载时机变化时重新 attach（保证超时计时器一定被起上）。
watch(iframeEl, (element) => {
  if (element && host.value) host.value.attach(element)
})
</script>

<template>
  <article
    class="anim"
    :class="{ 'anim--expanded': expanded, 'anim--degraded': degraded }"
    data-testid="animation-card"
    :data-degraded="String(degraded)"
    :data-phase="phase"
    :data-payload-id="payloadId"
  >
    <header class="anim__head">
      <span class="title">动画讲解</span>
      <span v-if="view.concept" class="chip" data-testid="animation-concept">{{ view.concept }}</span>
      <span class="chip chip--accent" data-testid="animation-source">
        {{ view.source === 'generated' ? '即时生成' : '内置模板' }}
      </span>
      <span
        class="chip"
        :class="degraded ? 'chip--warn' : phase === 'ready' ? 'chip--ok' : ''"
        data-testid="animation-status"
      >{{ statusText }}</span>
      <span v-if="view.source === 'template' && phase === 'ready'" class="chip tool" data-testid="animation-duration">
        {{ (view.durationMs / 1000).toFixed(1) }}s
      </span>
      <span class="spacer" />
      <button class="btn btn--ghost" type="button" data-testid="animation-expand" @click="toggleExpand">
        {{ expanded ? '收起' : '全屏' }}
      </button>
    </header>

    <!-- ── 可播放的沙箱 ─────────────────────────────────────────── -->
    <div v-if="mountIframe" class="anim__stage">
      <!-- ── 可播放的沙箱（**只用内联 `srcdoc`**，理由见 script 里 mountIframe 的注释）──
         ⚠️ 不要给 `:src` 或把一次性 nonce 地址绑上来：载荷里的地址是**持久化的**，
         而 nonce 单次消费 + TTL 120s，任何第二次加载都会拿到 403 JSON 被渲染给学生。
         `data-resource` 固定为 `inline`（CDP/探针据此确认走了哪条路）。 -->
      <iframe
        ref="iframeEl"
        class="anim__frame"
        :sandbox="iframeAttrs.sandbox"
        :referrerpolicy="iframeAttrs.referrerpolicy"
        :srcdoc="view.html"
        title="动画演示"
        data-testid="animation-frame"
        :data-sandbox="SANDBOX_ATTRIBUTE"
        data-resource="inline"
        @load="onIframeLoad"
      />

      <!-- 加载中：给一块有说明的占位，不要让学生盯着一片空白 -->
      <p v-if="phase === 'loading'" class="anim__loading" data-testid="animation-loading">
        动画加载中…（超过 5 秒会自动切换成文字讲解）
      </p>

      <div class="anim__controls" data-testid="animation-controls">
        <button class="btn btn--primary" type="button" data-testid="animation-play" @click="play">播放</button>
        <button class="btn" type="button" data-testid="animation-pause" @click="pause">暂停</button>
        <button class="btn" type="button" data-testid="animation-replay" @click="replay">重播</button>
        <span class="anim__progress" data-testid="animation-progress">
          进度 <span class="metric">{{ progressPercent }}</span>
        </span>
      </div>
    </div>

    <!-- ── 降级视图：文字讲解（**这条分支的存在就是为了不白屏**） ── -->
    <div v-else class="anim__fallback" data-testid="animation-fallback">
      <p class="anim__fallback-text" data-testid="animation-fallback-text">{{ view.fallbackText }}</p>
      <!-- ★ 这里原来还有一张 `<img class="anim__fallback-img">`：主进程按**同一段文案**
           生成的静态 SVG（正文截 34 字，见 `src/main/agent/extensions/animation.ts` 的
           `buildInlineFallbackImage`）。它与上面那段完整文案说的是同一件事，现在整段删掉 ——
           降级说明只留一处（报告 1.8 / 4.3）。主进程那段生成照旧保留：载荷契约那一侧
           还有别的消费者，要删得先确认；本卡片只是不再引用 `view.fallbackImage`。 -->
      <p
        v-if="degraded"
        class="anim__reason"
        data-testid="animation-degrade-reason"
        :data-degrade-reason="degradeReason || null"
      >
        {{ DEGRADED_NOTICE_TEXT }}
      </p>
    </div>
  </article>
</template>

<style scoped>
.anim {
  padding: 14px 16px;
  /* 卡片本体 → 卡片圆角 + paper 白面（与 base.css 的 .k12-card 同配方） */
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-card);
  /**
   * ★★ 舞台高度 = **按比例 + 下限 + 上限**，不是定值（本次修复的核心之一）。
   *
   * 修的是什么：旧样式是 `.anim__frame { height: 300px }` —— 一个**钉死的 300px**。
   * 动画 HTML 自己是「标题 + 说明 + 画布」的纵向布局（见 `_shared/base.css` 的 `#stage`
   * 与 `flex: 1` 的 `.anim-canvas`），内容一多（长标题 / 两句说明 / 方形画布）就超出 300px，
   * 而 iframe 内部是 `overflow: hidden` —— 多出来的部分被**静默切掉**，没有省略号也不能滚
   * （与 P-057 那类「固定高 + overflow = 悄悄少一行」同一个病）。
   *
   * 三个数为什么是这三个：
   *   - `--k12-anim-ratio: 16 / 9`：对话栏里卡片宽度约 640–820px → 自然高度约 360–460px，
   *     **比原来的 300px 高**，长内容有了位置；纵向还能再长（下面上限封着）。
   *   - `--k12-anim-min: 300px`：就是原来那个值的唯一价值 —— 简单动画
   *     （只有一行标题 + 一根柱子）在任何宽度下都不会塌成一条窄缝。保留它。
   *   - `--k12-anim-max: 420px`：对话栏是**阅读**栏，动画不该把一段回答挤到屏幕外。
   *     ⚠️ 上限会影响到能放下的内容量，所以一旦又出现「被切了」，先调这里，
   *     不要用 `overflow: auto` 兜住（那会把滚动条装进 iframe，学生滚的时候以为在滚对话）。
   * 代价（明说）：同屏多张动画卡片的高度随宽度一起缩放，不再每张都是同一个 300px ——
   * 这是想要的（内容放得下优先于绝对等高）。
   */
  --k12-anim-ratio: 16 / 9;
  --k12-anim-min: 300px;
  --k12-anim-max: 420px;
}

.anim--degraded {
  border-style: dashed;
  background: var(--k12-surface-2);
}

.anim--expanded {
  position: fixed;
  inset: 24px;
  z-index: 50;
  overflow: auto;
  /* 全屏是**浮层**（压在所有东西之上）→ float 档投影，而不是卡片那一档 */
  box-shadow: var(--k12-shadow-float);
}

/* ── 状态胶囊（角标语义）─────────────────────────────────────────────
 * ⚠️ 全局 `.chip` / `.chip--*` 已随新设计系统移除（`base.css` 只剩材质层与
 *   排版层）。模板里的类名照旧写着，于是这些胶囊一直无样式渲染 ——
 *   自带一份，配方与同目录的 `ProgressCard.vue` 一致（同一叠卡片必须同族）。
 * `.chip` 必须在 `.tool` **之前**：`.tool` 用同权重选择器覆盖字重与字号。 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
}

/* 动画已就绪 */
.chip--ok {
  background: var(--k12-good-soft);
  border-color: var(--k12-good-border);
  color: var(--k12-good);
}

/* 已切换为文字讲解（沙箱超时 / 自报错误）：这是**降级** → warn 语义色
 * （「能用，但不理想」），而不是 bad —— 文字讲解仍然把知识讲到了，
 * 涂成红色会让学生以为「坏了、学不成了」。 */
.chip--warn {
  background: var(--k12-warn-soft);
  border-color: var(--k12-warn-border);
  color: var(--k12-warn);
}

.chip--accent {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}

.anim__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.title {
  /* 卡片标题 → 区块标题档（与 ProgressCard / QuizCard 的 `.title` 同一落点） */
  font-size: var(--k12-fs-lg);
  font-weight: 650;
}

.tool {
  font-family: var(--k12-font-mono);
  /* 时长读数这类等宽小字：meta 档（不是 ≤4 字角标，角标另走 .chip） */
  font-size: var(--k12-fs-xs);
  font-weight: 500;
}

/* ── 按钮 ────────────────────────────────────────────────────────────
 * ⚠️ 全局 `.btn` / `.btn--ghost` 已随旧样式表移除，模板里的类名一直无样式
 *   （「全屏」此前就是个没有形状的纯文字）。自带一份；全屏是描边式次要动作，
 *   配方取 `views/Animation.vue` 的 `.anim__ghost`（同族页面）。
 * 高度由 padding + line-height 决定，不钉像素。 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover:not(:disabled) {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 播放是这一块的主要动作 → 填充用 accent-ink（文字色那一支），白字压上去才够对比度；
 * accent 是画得好看的浅色，配白字读不清。 */
.btn--primary {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
}

/* 「全屏」是卡片头右上角的**次要**动作：与 `.btn` 同一支描边样式（无色底填充）。
 * 单独立一条是因为模板里确实写着这个修饰类 —— 留一个没有对应规则的类名，
 * 下一个读代码的人会以为它被漏掉了（本文件已经因为这类「类名在、规则没了」
 * 的旧账白屏过一轮）。 */
.btn--ghost {
  background: var(--k12-surface);
  border-color: var(--k12-border);
  color: var(--k12-fg-2);
}

.spacer {
  flex: 1 1 auto;
}

.anim__stage {
  position: relative;
  margin-top: 12px;
}

.anim__frame {
  display: block;
  width: 100%;
  /* ★ 高度按比例生长（三个数与理由见 `.anim` 上的说明）——
   * 定值 300px 会把放不下的内容静默切掉（iframe 内部是 overflow:hidden）。 */
  aspect-ratio: var(--k12-anim-ratio);
  min-height: var(--k12-anim-min);
  max-height: var(--k12-anim-max);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  /* iframe 里的动画 HTML 按白底绘制 → 必须给**不透明**的 paper 白。
   * `--k12-surface` 在全部 18 组主题里都是 #FFFFFF，是白底的唯一来源。 */
  background: var(--k12-surface);
}

/* 全屏：舞台要大（这个模式的目的就是看动画），所以这里**放开对话栏那个上限**；
 * 视口高的 70% 与原值一致，保留 640px 的兜底上限。 */
.anim--expanded .anim__frame {
  aspect-ratio: auto;
  min-height: 0;
  max-height: none;
  height: min(70vh, 640px);
}

.anim__loading {
  position: absolute;
  inset: 0 0 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  /* 加载说明是一整句给学生看的话 → 次级正文档（与 views/Animation.vue 的 `.anim__veil` 同一落点） */
  font-size: var(--k12-fs-sm);
  color: var(--k12-muted);
  /* 半透明遮罩：压在 iframe 之上（与 views/Animation.vue 的 `.anim__veil` 同一手法） */
  background: color-mix(in srgb, var(--k12-surface) 86%, transparent);
  border-radius: var(--k12-r-inset);
  pointer-events: none;
}

.anim__controls {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.anim__progress {
  /* 旧值不在 8 档之内：进度读数是 meta → meta 档（与 views/Animation.vue 的 `.anim__time` 同一落点） */
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* 进度里的百分比：同一句里「进度」是标签、数字才是值 —— 把值提出来，
 * 且数字定宽（否则 9%→10% 跳动时整行会左右抖）。 */
.metric {
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
  font-weight: 650;
  color: var(--k12-fg-2);
}

.anim__fallback {
  margin-top: 12px;
  padding: 12px 14px;
  /* 文字讲解 = 沙箱位置的替代（卡内嵌入块）→ inset 圆角 + paper 底 */
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
}

.anim__fallback-text {
  /* 降级后的文字讲解 = 沙箱位置的替代正文 → 正文档 */
  font-size: var(--k12-fs-md);
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ⚠️ `.anim__fallback-img` 已删（报告 1.8 / 4.3）：那张白卡是主进程按**同一段降级文案**
 * 生成的 SVG（正文截 34 字），与上面那段完整文案重复。主进程仍在生成它（载荷契约的
 * 一部分），本卡片不再引用 —— 见 `<script>` 里的说明。这里不留空容器。 */
.anim__reason {
  margin-top: 10px;
  /* 降级气泡下的脚注 → meta 档（与 views/Animation.vue 的 `.anim__reason` 同一落点） */
  font-size: var(--k12-fs-xs);
  line-height: 1.6;
  color: var(--k12-muted-2);
}
</style>
