<script setup lang="ts">
/**
 * 悬浮追问窗 —— 「边看动画边问」的那个窗。
 *
 * 形态决策（用户拍板）：**渲染进程内的可拖拽浮层、单实例**。
 *   - 不用独立 BrowserWindow：跨进程状态同步成本高，15 天冲刺里是高风险；
 *   - 不做右侧停靠抽屉：会把阅读栏从 820px 压到 460px 以下，正文没法读；
 *   - 固定视口（position: fixed），**不随对话滚动跑掉** —— 否则一边滚一边追窗口。
 *
 * 直接操纵的细节（这几条决定了拖起来"跟不跟手"）：
 *   - Pointer Events + `setPointerCapture`：指针移出窗口边界也不丢事件；
 *   - **保留抓取点偏移**：从标题栏中间按下就从中间拖，不吸附到元素中心
 *     （吸附会让窗口"跳一下"，是最容易被感知到的廉价感）；
 *   - 限制在视口内，且**不做回弹**：这是精确摆放，不是甩动交互；
 *   - 松手记住位置（位置存在 store 里，关掉再开还在原处）。
 *
 * ── 追问接的是**真实对话链路**（本次接线）───────────────────────────────
 * ★ 发送 = `chat.send(正文)`，`ChatSendRequest` 只有 `{text}`（守卫 G6c 钉死），
 *   所以「围绕哪份内容在问」必须编进**正文**（与 `cards/coding.ts` 的
 *   `buildHintRequestMessage` 同一条路子），不能给请求加字段。
 * ★ 回答**不在这里另存一份**：发出去的那一轮就在 `chat.turns` 里（`requestId` 认得出来），
 *   面板直接显示它的正文 —— 于是流式增量、撤回、能力受限三种终态与对话页**天然一致**。
 *   原型那句「本原型未接线：这句话不会送往模型」的假回答随之删除。
 *
 * 出场：从触发的那个按钮锚定（`transform-origin` 指向按钮），scale(0.96) + 淡入。
 * 退场沿同一路径返回 —— 从哪来、回哪去。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEscape } from '../composables/useEscape'
import { useFocusReturn } from '../composables/useFocusReturn'
import { ChevronUp, GripHorizontal, Minus, MessageCircleQuestion, X, Sparkles } from 'lucide-vue-next'
import { useFloatPanel } from '../stores/floatPanel'
import { useChatStore } from '../stores/chat'
import type { ChatTurn } from '../api/events'
import MessageComposer from './MessageComposer.vue'

const floatPanel = useFloatPanel()
const chat = useChatStore()

const rootRef = ref<HTMLElement | null>(null)
const bodyRef = ref<HTMLElement | null>(null)

/**
 * 从这个窗里问出去的话。
 *
 * ★ 只存**学生自己问的那句 + 认领回来的 `requestId`**，不存回答正文：
 *   回答永远从 `chat.turns` 现取（那是唯一真相，流式增量也在那里更新）。
 */
interface Ask {
  id: number
  question: string
  /** 认领到的轮次；`null` = 这一句没送出去（桥缺失 / 上一条还在回答中）。 */
  requestId: string | null
}
let seq = 0
const asks = ref<Ask[]>([])

/**
 * 换关联对象就清空上一轮的追问，避免串场。
 * ★ 判据必须带上 `kind`（与 store 的 `toggleFrom` 同一条理由）：
 *   三页的入口常常指向**同一个知识点**，只比 title 时"换了页却不清空"，
 *   学生会在编程页的窗里读到刚才动画页的问法。
 */
watch(
  () => `${floatPanel.subject?.kind ?? ''}\u0000${floatPanel.subject?.title ?? ''}`,
  (now, prev) => {
    if (now !== prev) asks.value = []
  }
)

/** 视口坐标。首次打开落在内容区右下角（`defaultPos` 按围栏算）。 */
const position = computed(() => floatPanel.pos ?? floatPanel.defaultPos())

/** 出场锚点：把 transform-origin 指向触发按钮（相对窗口左上角） */
const originStyle = computed(() => {
  const p = position.value
  const o = floatPanel.origin
  if (!o) return { transformOrigin: 'top right' }
  const x = Math.min(Math.max(o.x - p.x, 0), floatPanel.size.w)
  const y = Math.min(Math.max(o.y - p.y, 0), floatPanel.size.h)
  return { transformOrigin: `${Math.round(x)}px ${Math.round(y)}px` }
})

const style = computed(() => ({
  left: `${position.value.x}px`,
  top: `${position.value.y}px`,
  width: `${floatPanel.size.w}px`,
  // ★★ 高度**必须显式给**（2026-09-27 走查）：此前只给了 width，
  //   于是窗高完全由内容决定 —— 追问几轮后它自己长到出屏。
  //   折叠态走 `.fp--collapsed` 的 `height: auto`（那一档就是要贴着标题栏收起来）。
  ...(floatPanel.collapsed ? {} : { height: `${floatPanel.size.h}px` }),
  ...originStyle.value
}))

// ── 拖拽 ────────────────────────────────────────────────────────────────
let drag: { pointerId: number; dx: number; dy: number } | null = null

/**
 * 在标题栏上按下时开始拖动。
 *
 * ★★ 必须**放过可交互子元素**（2026-09-27 走查的真 bug）：标题栏里有关闭 / 折叠两个按钮，
 *   而 `setPointerCapture` 会把后续指针事件**全部重定向到捕获元素**（标题栏），
 *   于是按钮上的 `click` 永远不触发 —— 表现就是「X 点不动、最小化没反应」。
 *   `.stop` 修饰符挡不住它：那是**点击**事件的冒泡，不是指针捕获的重定向。
 *   → 判据放在这里：从按钮（或任何表单控件）上按下的，不进入拖拽路径，也不捕获指针。
 */
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, input, textarea, select, a[href]') !== null
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  if (isInteractive(e.target)) return
  const rect = rootRef.value?.getBoundingClientRect()
  if (!rect) return
  // 保留抓取点偏移：从哪儿按下的，就从哪儿拖
  drag = { pointerId: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function onPointerMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return
  // ★ 夹紧交给 store（`moveTo`）：围栏是"内容区"而不是视口 —— 这样窗永远不会
  //   压到顶栏的窗口按钮或侧栏导航上（用户要求"不能拖到外面或者挡住按钮"）。
  //   组件只负责把指针位置换算成窗的左上角。
  floatPanel.moveTo(e.clientX - drag.dx, e.clientY - drag.dy)
}

function onPointerUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return
  drag = null
}

/** 视口变化时把窗拉回围栏内（否则缩放窗口后它可能跑到围栏外 / 比围栏还大）。 */
function clampToViewport() {
  if (!floatPanel.open) return
  // 交给 store：它会按当前围栏重算尺寸与位置（含面积比例与围栏上限）。
  floatPanel.reclamp()
}

onMounted(() => {
  window.addEventListener('resize', clampToViewport)
  // ★ 「只在动手试试三页存在」：这只窗挂在外壳上（换页不卸载，追问连续性靠它），
  //   所以必须**主动**在离开那三页时关掉 —— 否则它会跟着学生跑到对话页。
  floatPanel.initPageFence()
  // 首次打开就按当前窗口/围栏校正一次尺寸（默认值是名义尺寸，不是最终值）。
  floatPanel.setSize(floatPanel.size.w, floatPanel.size.h)
})
onBeforeUnmount(() => window.removeEventListener('resize', clampToViewport))

// ── 改大小（右下角手柄）─────────────────────────────────────────────────
/*
 * 为什么要有这个：窗的内容是**对话**，而对话长度不可预知 ——
 * 固定尺寸会让长回答只能在小窗里滚动，短回答又留着大片空白。
 * 让学生自己拉一把是最省事也最符合直觉的解法（窗本来就是他的）。
 * 上限夹紧放在 store 里（`setSize`），组件只负责把指针位移换算成尺寸。
 */
let resizing: { pointerId: number; startW: number; startH: number; x: number; y: number } | null = null

function onResizeDown(e: PointerEvent) {
  if (e.button !== 0) return
  resizing = {
    pointerId: e.pointerId,
    startW: floatPanel.size.w,
    startH: floatPanel.size.h,
    x: e.clientX,
    y: e.clientY
  }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
  e.stopPropagation()
}

function onResizeMove(e: PointerEvent) {
  if (!resizing || e.pointerId !== resizing.pointerId) return
  floatPanel.setSize(resizing.startW + (e.clientX - resizing.x), resizing.startH + (e.clientY - resizing.y))
}

function onResizeUp(e: PointerEvent) {
  if (!resizing || e.pointerId !== resizing.pointerId) return
  resizing = null
}

// ── 追问 ────────────────────────────────────────────────────────────────
/**
 * ⚠️ 这里**不写死 `InstanceType<typeof MessageComposer>`**：输入条正在被并发改造，
 *   若把它的组件实例类型固化下来，它每动一次 props（例如增删 `streaming`）都会
 *   让本文件编译不过。浮层只需要两件事 —— 「有 focus 就调用」「有 fill 就填」。
 */
type ComposerHandle = { fill?: (value: string) => void; focus?: () => void }
const composerRef = ref<ComposerHandle | null>(null)

/**
 * 把「围绕谁在问」编进**消息正文**。
 *
 * ★ `ChatSendRequest` 的字段集合被守卫 G6c 钉死为 `['text']` —— 上下文只能进正文。
 *   （编程卡片的 `buildHintRequestMessage`、练习卡的提交消息都是这么带上 kpId 的。）
 */
function buildAskMessage(question: string, kindLabel: string, title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return question
  return `【追问 · ${kindLabel}】关于「${trimmed}」：${question}`
}

/** 认领这一句对应的轮次（`chat.turns` 是对话正文的唯一真相）。 */
function turnOf(ask: Ask): ChatTurn | null {
  if (ask.requestId === null) return null
  return chat.turns.find((turn) => turn.requestId === ask.requestId) ?? null
}

/** 一条追问的**回答侧**显示内容：直接读真实轮次的状态，不编造。 */
function replyOf(ask: Ask): { text: string; tone: 'ai' | 'pending' | 'failed' } {
  const turn = turnOf(ask)
  if (turn === null) {
    const reason =
      chat.localNotice ??
      (chat.streaming
        ? '上一条还在回答中，等它回答完再问。'
        : '这句话没有送出去（本地数据服务未就绪）。')
    return { text: reason, tone: 'failed' }
  }
  if (turn.status === 'error') return { text: turn.error?.message ?? '这一轮回答失败了。', tone: 'failed' }
  if (turn.status === 'blocked') {
    return { text: turn.blocked?.safeText ?? '这段回答已被撤回。', tone: 'failed' }
  }
  if (turn.text.length === 0) return { text: '正在回答…', tone: 'pending' }
  return { text: turn.text, tone: 'ai' }
}

async function onSend(text: string): Promise<void> {
  const before = chat.turns.length
  await chat.send(buildAskMessage(text, floatPanel.kindLabel, floatPanel.subject?.title ?? ''))

  /*
   * ★ 「追加了一轮」就是「这次发出去了」的判据：
   *   `send()` 在未接线 / 正在回答中 / 服务端拒收时会**不建轮次**地返回，
   *   所以按长度差认领比按文本回找可靠（同一句话可以问两次）。
   */
  const created = chat.turns.length > before ? (chat.turns[chat.turns.length - 1] ?? null) : null
  asks.value.push({ id: ++seq, question: text, requestId: created?.requestId ?? null })

  await nextTick()
  const el = bodyRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 新回答落地（含流式增量）时保持在底部 —— 追问窗是"看着它答"的场景。 */
watch(
  () => chat.turns,
  () => {
    void nextTick(() => {
      const el = bodyRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)

onMounted(() => {
  void nextTick(() => composerRef.value?.focus?.())
})

/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => floatPanel.close(), () => floatPanel.open)

/**
 * 焦点契约（优化报告 §3.1）：打开时把焦点移入窗内，关闭时归还触发它的那颗按钮。
 * ★ `trap: false` —— 这是**非模态**浮窗（要能一边看动画一边追问），
 *   把 Tab 锁在窗里反而让学生回不到页面。
 */
useFocusReturn(rootRef, () => floatPanel.open, { trap: false })
</script>

<template>
  <Teleport to="body">
    <Transition name="float">
      <section
        v-if="floatPanel.open"
        ref="rootRef"
        class="fp k12-float"
        :class="{ 'fp--collapsed': floatPanel.collapsed }"
        :style="style"
        role="dialog"
        aria-label="追问"
        data-testid="float-panel"
      >
        <!-- 标题栏 = 拖拽手柄 -->
        <header
          class="fp__bar"
          title="拖动以移动窗口"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <GripHorizontal :size="14" class="fp__grip" />
          <MessageCircleQuestion :size="14" class="fp__ico" />
          <span class="fp__chip">{{ floatPanel.kindLabel }}</span>
          <span class="fp__title">{{ floatPanel.subject?.title }}</span>
          <button
            type="button"
            class="fp__btn"
            :title="floatPanel.collapsed ? '展开' : '折叠（只留标题栏）'"
            data-testid="float-panel-toggle"
            @click.stop="floatPanel.toggleCollapsed()"
          >
            <!-- 图标随状态换，不原地留着减号：折叠后点"减号"来放大读不出来
                 （走查问过"最小化以后在哪儿点回来"）。 -->
            <component :is="floatPanel.collapsed ? ChevronUp : Minus" :size="14" />
          </button>
          <button
            type="button"
            class="fp__btn"
            title="关闭"
            data-testid="float-panel-close"
            @click.stop="floatPanel.close()"
          >
            <X :size="14" />
          </button>
        </header>

        <!-- 折叠态：只剩标题，用来给动画让位 -->
        <template v-if="!floatPanel.collapsed">
          <p v-if="floatPanel.subject?.hint" class="fp__hint">
            <Sparkles :size="13" />
            <span>{{ floatPanel.subject.hint }}</span>
          </p>

          <div ref="bodyRef" class="fp__body">
            <div v-if="!asks.length" class="fp__empty">
              围绕「{{ floatPanel.subject?.title }}」提问，问题会带上这份内容的上下文。
            </div>
            <template v-for="ask in asks" :key="ask.id">
              <div class="fp__turn fp__turn--user">
                <p class="fp__text">{{ ask.question }}</p>
              </div>
              <div
                class="fp__turn fp__turn--ai"
                :data-tone="replyOf(ask).tone"
              >
                <p class="fp__text">{{ replyOf(ask).text }}</p>
              </div>
            </template>
          </div>

          <div class="fp__foot">
            <MessageComposer ref="composerRef" compact @send="onSend" />
          </div>

          <!-- 右下角改大小手柄：对话长度不可预知，让窗能跟着学生的需要变。
               尺寸上下限在 store 的 `setSize` 里夹紧（含视口约束）。 -->
          <span
            class="fp__resize"
            data-testid="float-panel-resize"
            title="拖动改变窗口大小"
            aria-hidden="true"
            @pointerdown="onResizeDown"
            @pointermove="onResizeMove"
            @pointerup="onResizeUp"
            @pointercancel="onResizeUp"
          />
        </template>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 浮层 = **毛玻璃**（半透明白 + blur）。
 * ★ 这个窗是「边看动画边问」的那只 —— 它背后**真的有内容经过**（动画舞台、
 *   正文），毛玻璃在这里不是装饰：它让学生能感到"舞台还在我身后"，
 *   而不是被一块实心白板挡住（浮层一旦读起来像墙，就不敢一边看一边问了）。
 * ⚠️ 为什么不用全局的 `.k12-glass` 类：scoped 选择器带 `[data-v-x]`，优先级高于
 *   单个全局类 —— 这里必须自己给「兜底 → 半透明」两条，两套机制并存会打架。
 *   兜底：不支持 backdrop-filter 的环境保持实色白（半透明底会让下层文字透上来）。 */
.fp {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  border-radius: var(--k12-r-card);
  overflow: hidden;
  /* 出场/退场：从锚点长出来、沿同路径返回 */
  background: var(--k12-surface);
}
.fp--collapsed {
  /* 折叠态高度自适应 */
  height: auto !important;
}

/* ── 标题栏 ───────────────────────────────────────────────────────────── */
.fp__bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.fp__bar:active {
  cursor: grabbing;
}
.fp__grip {
  color: var(--k12-muted-2);
  flex: none;
}
.fp__ico {
  color: var(--k12-accent-ink);
  flex: none;
}
/* 分类角标：`kindLabel` 是「动画 / 编程 / 闯关 / 问答」—— 2 字的分类记号，
 * 填充底 + 胶囊形 + 11px（角标档）。升到 12px 它会与紧邻的标题（13px）拉平，
 * 「这是角上的一个记号」这层意思就没了。 */
.fp__chip {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-label);
  font-weight: 650;
}
.fp__title {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 28px（原 24）：浮窗上的图标按钮，24px 对 K12 学生来说点不准。
   * 图标按钮的可点区不该小于 28 —— 尺寸由「手指能不能按到」定，不由视觉定。 */
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--k12-r-flat);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .fp__btn:hover {
    background: var(--k12-surface);
    color: var(--k12-fg-2);
  }
}

/* ── 提示 / 正文 / 输入 ───────────────────────────────────────────────── */
.fp__hint {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 9px 11px;
  background: var(--k12-accent-soft);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
}
.fp__hint svg {
  flex: none;
  margin-top: 2px;
  color: var(--k12-accent-ink);
}
.fp__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--k12-surface);
}
.fp__empty {
  padding: 18px 8px;
  text-align: center;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.fp__turn {
  display: flex;
}
.fp__turn--user {
  justify-content: flex-end;
}
.fp__turn--user .fp__text {
  /* ⚠️ 填充底用 accent-ink（压深版）而不是 accent：accent 是「被看」的图形色，
   * 白字压在上面在低龄档只有 ~2.6:1；accent-ink 与白底 ≥4.5:1（对比度脚本在校验）。 */
  background: var(--k12-accent-ink);
  color: var(--k12-on-fill);
  border-radius: var(--k12-r-flat);
  padding: 8px 11px;
  max-width: 88%;
}
.fp__turn--ai .fp__text {
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  border-radius: var(--k12-r-flat);
  padding: 8px 11px;
  max-width: 92%;
}
/* 未落地 / 失败的那一侧：底与字都换成警示色（回答没出来时不该长得像回答） */
.fp__turn--ai[data-tone='failed'] .fp__text {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.fp__turn--ai[data-tone='pending'] .fp__text {
  color: var(--k12-muted);
}
.fp__text {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.fp__foot {
  border-top: 1px solid var(--k12-border);
  background: var(--k12-surface);
  /* 旧版这里用负外边距去啃 MessageComposer 自带的 20px 边距 —— 输入条正在改造，
   * 它的边距随时会变，负边距会让内容溢出被裁。改成自己给内边距，不再依赖别人。 */
  padding: 8px 10px 10px;
}

/* ── 改大小手柄（右下角）────────────────────────────────────────────────
 * ⚠️ 尺寸必须够点：18px 的可点区对 K12 学生偏小（图标按钮的下限是 28px，
 *   而它是**拖拽**目标而不是点击目标 —— 拖拽对准要求更低，18 是折中：
 *   再大就会盖住输入框右下角的发送键）。命中区用 padding 撑，视觉仍是一条细纹。 */
.fp__resize {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  touch-action: none;
  /* 斜纹（两道）用渐变画，不引图：零 CDN 纪律同样适用于装饰 */
  background: repeating-linear-gradient(
    135deg,
    transparent 0 3px,
    color-mix(in srgb, var(--k12-muted-2) 55%, transparent) 3px 5px
  );
  border-bottom-right-radius: var(--k12-r-card);
}

/* ── 出场 / 退场 ──────────────────────────────────────────────────────── */
.float-enter-from,
.float-leave-to {
  opacity: 0;
  transform: scale(0.96);
}

/* ── 毛玻璃（必须放在本文件**末尾**，见下面的顺序说明）────────────────────
 * ⚠️⚠️ 顺序是硬要求：这几条与被覆盖的规则**优先级完全相同**（都是
 *   `.fp__x[data-v-xxx]`，0-2-0）—— 同优先级下**源序靠后者胜**。
 *   把这块放在文件前面时实测：只有 `.fp` 生效（它的基础规则在它之前），
 *   `.fp__bar/__body/__foot` 三条全被后面各自的基础规则盖回去（面板仍是实心白）。
 *   所以这块**只能贴在文件末尾**，且新增 `.fp*` 背景时不要写到它之后。
 *
 * ⚠️ 玻璃化必须落在**真正铺底的那一层**（实测：父容器铺不透明白底时，
 *   子元素的 backdrop-filter 只会采到那层白，"模糊"等于没发生）。这个窗的
 *   三层内部块原本都自铺不透明底，会把根的玻璃整个盖死 —— 所以：
 *     · 根 = 唯一的玻璃面（一次 backdrop-filter，不是三层各糊一次）；
 *     · 正文 / 输入区 → 透明（它们铺的本来就是与根同色的 surface）；
 *     · 标题栏 → 半透明学段浅底，**保留"这是能抓的把手"那点底色**，
 *       只是不再是一块实心板。
 *   兜底：不支持 backdrop-filter 的环境，上面那些基础规则里的实色底原样生效
 *   （半透明底会让下层文字透上来，可读性是事故不是审美）。 */
@supports (backdrop-filter: blur(1px)) {
  .fp {
    /* ⚠️ 90%，**唯一一处不按 70–80 分档走的表面**（2026-09-30 整档下调时也只在 94→90 挪了一格）：
     *   这个窗**压在动画舞台上**，舞台是高对比图形 + 节点文字 ——
     *   真机实测 88% 时背后的「第 4 段 / 流经」会透上来，与窗里的回答正文抢读
     *   （学生要读的是窗里的字）。模糊负责"透出背景的存在感"，
     *   不透明度的下限由**可读性**决定（分档表见 base.css 的 `.k12-glass`）。 */
    background: color-mix(in srgb, var(--k12-surface-solid) 90%, transparent);
    backdrop-filter: blur(12px) saturate(1.4);
  }
  .fp__bar {
    background: color-mix(in srgb, var(--k12-surface-2) 80%, transparent);
  }
  .fp__body,
  .fp__foot {
    background: transparent;
  }
}
</style>
