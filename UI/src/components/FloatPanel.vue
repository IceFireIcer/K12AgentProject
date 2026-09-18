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
 * 出场：从触发的那个按钮锚定（`transform-origin` 指向按钮），scale(0.96) + 淡入。
 * 退场沿同一路径返回 —— 从哪来、回哪去。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEscape } from '@/composables/useEscape'
import { GripHorizontal, Minus, MessageCircleQuestion, X, Sparkles } from 'lucide-vue-next'
import { useFloatPanel } from '@/stores/floatPanel'
import MessageComposer from '@/components/MessageComposer.vue'

const floatPanel = useFloatPanel()

const rootRef = ref<HTMLElement | null>(null)
const bodyRef = ref<HTMLElement | null>(null)

/** 追问记录（原型不接线，只本地回显） */
interface Turn {
  id: number
  role: 'user' | 'assistant'
  text: string
}
let seq = 0
const turns = ref<Turn[]>([])

watch(
  () => floatPanel.subject?.title,
  (title, prev) => {
    // 换关联对象：清空上一轮的追问，避免串场
    if (title !== prev) turns.value = []
  }
)

/** 视口坐标。首次打开落在右下角。 */
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
  ...originStyle.value
}))

// ── 拖拽 ────────────────────────────────────────────────────────────────
let drag: { pointerId: number; dx: number; dy: number } | null = null

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  const rect = rootRef.value?.getBoundingClientRect()
  if (!rect) return
  // 保留抓取点偏移：从哪儿按下的，就从哪儿拖
  drag = { pointerId: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function onPointerMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return
  const { w } = floatPanel.size
  const h = rootRef.value?.offsetHeight ?? floatPanel.size.h
  const m = floatPanel.margin
  // 限制在视口内；到边就停住（不回弹——这是精确摆放，不是甩动）
  const x = Math.min(Math.max(e.clientX - drag.dx, m), window.innerWidth - w - m)
  const y = Math.min(Math.max(e.clientY - drag.dy, m), window.innerHeight - h - m)
  floatPanel.moveTo(x, y)
}

function onPointerUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return
  drag = null
}

/** 视口变化时把窗口拉回可见区域（否则缩放后可能跑到屏幕外） */
function clampToViewport() {
  if (!floatPanel.open || !floatPanel.pos) return
  const { w } = floatPanel.size
  const h = rootRef.value?.offsetHeight ?? floatPanel.size.h
  const m = floatPanel.margin
  floatPanel.moveTo(
    Math.min(Math.max(floatPanel.pos.x, m), window.innerWidth - w - m),
    Math.min(Math.max(floatPanel.pos.y, m), window.innerHeight - h - m)
  )
}

onMounted(() => window.addEventListener('resize', clampToViewport))
onBeforeUnmount(() => window.removeEventListener('resize', clampToViewport))

// ── 追问 ────────────────────────────────────────────────────────────────
const composerRef = ref<InstanceType<typeof MessageComposer> | null>(null)

function onSend(text: string) {
  turns.value.push({ id: ++seq, role: 'user', text })
  turns.value.push({
    id: ++seq,
    role: 'assistant',
    text: `本原型未接线：这句话不会送往模型。接线后主进程会带上「${floatPanel.subject?.title ?? '当前内容'}」这个上下文提问，回答只围绕它展开。`
  })
  void nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

onMounted(() => {
  void nextTick(() => composerRef.value?.focus())
})

/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => floatPanel.close(), () => floatPanel.open)
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
            :title="floatPanel.collapsed ? '展开' : '折叠'"
            @click.stop="floatPanel.toggleCollapsed()"
          >
            <Minus :size="14" />
          </button>
          <button type="button" class="fp__btn" title="关闭" @click.stop="floatPanel.close()">
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
            <div v-if="!turns.length" class="fp__empty">
              围绕「{{ floatPanel.subject?.title }}」提问，回答不会跑题。
            </div>
            <div
              v-for="t in turns"
              :key="t.id"
              class="fp__turn"
              :class="t.role === 'user' ? 'fp__turn--user' : 'fp__turn--ai'"
            >
              <p class="fp__text">{{ t.text }}</p>
            </div>
          </div>

          <div class="fp__foot">
            <MessageComposer ref="composerRef" compact @send="onSend" />
          </div>
        </template>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fp {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  border-radius: var(--k12-r-card);
  overflow: hidden;
  /* 出场/退场：从锚点长出来、沿同路径返回 */
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
  font-size: var(--k12-fs-micro);
  font-weight: 650;
}
.fp__title {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
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
  width: 24px;
  height: 24px;
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
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
  background: var(--k12-accent);
  color: var(--k12-surface);
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
.fp__text {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  margin: 0;
}
.fp__foot {
  border-top: 1px solid var(--k12-border);
  background: var(--k12-surface);
  /* MessageComposer 自带 20px 外边距，这里收掉一部分 */
  margin: 0 -8px -6px;
}

/* ── 出场 / 退场 ──────────────────────────────────────────────────────── */
.float-enter-from,
.float-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
