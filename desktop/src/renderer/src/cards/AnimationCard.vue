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
 * 3. ★ **失败/超时一律降级成文字 + 静态图，绝不白屏**。
 *    四条降级入口：载荷里 `html` 为空（编排层已降级）、iframe 5s 没 `ready`、
 *    沙箱自报 `error`、`resourceUrl` 与 `srcdoc` 都没有。四条都走同一个 {@link goDegraded}。
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

/** 挂 iframe 的条件：有 HTML **且**有可加载的地址/内联内容。 */
const mountIframe = ref<boolean>(shouldMountIframe(view.html) && (view.resourceUrl !== null || view.html !== ''))

/** 是否已进入降级视图（文字 + 静态图）。 */
const degraded = ref<boolean>(false)
/**
 * 降级的可读原因（**只进 `data-*` 属性**，不摆给学生看 —— 学生只该看到「能动/不能动」）。
 * 例：「沙箱在 5 秒内没有就绪（payloadId=xxxxx）」；这类内部细节（含 payloadId）留在这里，
 * 由 CDP 脚本（`scripts/verify-ui.mjs` 一类）读 `[data-degrade-reason]` 做断言。
 */
const degradeReason = ref<string>('')
/** 降级气泡上给学生看的**固定中文**（不随原因变化，也不含任何内部标识）。 */
const DEGRADED_NOTICE_TEXT = '动画没能加载，已用文字讲解'
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

function goDegraded(reason: string): void {
  if (degraded.value) return
  degraded.value = true
  degradeReason.value = reason
  phase.value = 'degraded'
  // 拆掉 iframe：它已经不可用了，留着只会占内存（也可能继续发消息）
  mountIframe.value = false
  host.value?.dispose()
}

function buildHost(): AnimationSandboxHost {
  const instance = new AnimationSandboxHost({
    payloadId: payloadId.value,
    resourceUrl: view.resourceUrl ?? undefined,
    srcdoc: view.html || undefined,
    onReady: () => {
      phase.value = 'ready'
    },
    onProgress: (value) => {
      progress.value = value
    },
    onTimeout: (id) => {
      // ★ 5s 没 ready：发过 timeout 之后走降级视图（**绝不白屏**）
      goDegraded(`沙箱在 5 秒内没有就绪（payloadId=${id}）`)
    },
    onError: (message) => {
      goDegraded(`沙箱自报错误：${message || '(无说明)'}`)
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
    degradeReason.value = view.degradeReason ?? '本次没有可播放的动画内容（已用文字讲解顶上）'
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
      <iframe
        ref="iframeEl"
        class="anim__frame"
        :sandbox="iframeAttrs.sandbox"
        :referrerpolicy="iframeAttrs.referrerpolicy"
        :src="view.resourceUrl ?? undefined"
        :srcdoc="view.resourceUrl ? undefined : view.html"
        title="动画演示"
        data-testid="animation-frame"
        :data-sandbox="SANDBOX_ATTRIBUTE"
        :data-resource="view.resourceUrl ? 'hosted' : 'inline'"
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

    <!-- ── 降级视图：文字 + 静态图（**这条分支的存在就是为了不白屏**） ── -->
    <div v-else class="anim__fallback" data-testid="animation-fallback">
      <p class="anim__fallback-text" data-testid="animation-fallback-text">{{ view.fallbackText }}</p>
      <img
        v-if="view.fallbackImage"
        class="anim__fallback-img"
        :src="view.fallbackImage"
        alt="概念静态示意图"
        data-testid="animation-fallback-image"
      />
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
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.anim--degraded {
  border-style: dashed;
  background: var(--surface-muted);
}

.anim--expanded {
  position: fixed;
  inset: 24px;
  z-index: 50;
  overflow: auto;
  box-shadow: var(--shadow-lg, 0 18px 48px rgba(0, 0, 0, 0.22));
}

.anim__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.title {
  font-size: 14px;
  font-weight: 650;
}

.tool {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
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
  height: 300px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: #ffffff;
}

.anim--expanded .anim__frame {
  height: min(70vh, 640px);
}

.anim__loading {
  position: absolute;
  inset: 0 0 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.86);
  border-radius: var(--radius-sm);
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
  font-size: 12.5px;
  color: var(--text-muted);
}

.anim__fallback {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
}

.anim__fallback-text {
  font-size: 14px;
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}

.anim__fallback-img {
  display: block;
  width: 100%;
  max-width: 480px;
  height: auto;
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.anim__reason {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-faint);
}
</style>
