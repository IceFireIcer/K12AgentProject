<script setup lang="ts">
/**
 * 只读机制浮窗 —— 在**真实页面里就地证明机制存在**的那块玻璃。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 与「追问窗」（`FloatPanel.vue`）的关系
 * ══════════════════════════════════════════════════════════════════════════
 * 两只窗都挂在 `App.vue` 的 `#overlay` 上、都用同一份拖拽逻辑
 * （`composables/useDraggablePanel.ts`），但**是两只独立实例**：
 *   · 追问窗是**可交互**的（学生写问题、看回答）；
 *   · 这只窗**只读** —— 它一个可写控件都没有（只有「展开详情 / 在运行透视里打开 / 固定 / 关闭」），
 *     也**不接受任何指向运行时的参数**。演示时最怕手滑把状态改了，所以从结构上让它改不了。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 出场与纪律
 * ══════════════════════════════════════════════════════════════════════════
 *   · **默认关闭**（不遮挡学生正常操作；入口按钮本身也只在教师 / 演示档渲染）；
 *   · 可拖动、可折叠、可固定（固定 = 折叠按钮之外的第二档形态，这里用「固定」把窗钉在
 *     当前轮的摘要上，不随新轮次跳走）；
 *   · 内容**不进 6 事件流**（它不是对话的一部分，是这一轮的旁路证据）。
 *
 * ★ 数据源是 `stores/diagnostics.ts` 的**同一个 store**：与运行透视页共用一份快照、共用
 *   `DiagSummary` 组件 —— 浮窗说 3 次调用，运行透视页就是 3 次。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { GripHorizontal, Maximize2, Minus, Pin, X } from 'lucide-vue-next'
// ★ 子代理 span 的形状由 V1 落在 @shared/diagnostics；这里只 import 不另声明。
import type { RuntimeSpan, TurnDiagnostics } from '@shared/diagnostics'
import { useDiagnosticsPanel } from '../stores/diagnosticsPanel'
import { useDiagnosticsStore } from '../stores/diagnostics'
import { useUiStore } from '../stores/ui'
import { useViewModeStore } from '../stores/viewMode'
import { useDraggablePanel } from '../composables/useDraggablePanel'
import { useEscape } from '../composables/useEscape'
import { useFocusReturn } from '../composables/useFocusReturn'
import DiagSummary from './diag/DiagSummary.vue'

const panel = useDiagnosticsPanel()
const diagnostics = useDiagnosticsStore()
const ui = useUiStore()
const viewMode = useViewModeStore()

const rootRef = ref<HTMLElement | null>(null)
const bodyRef = ref<HTMLElement | null>(null)

/** 固定 = 锁在「固定的那一轮」上，新轮次不把它顶走（演示时讲解需要停住）。 */
const pinnedTurn = ref<number | null>(null)

const shown = computed(() => {
  if (pinnedTurn.value !== null) {
    return diagnostics.turns.find((turn) => turn.turn === pinnedTurn.value) ?? diagnostics.latest
  }
  return diagnostics.latest
})

function togglePin(): void {
  pinnedTurn.value = pinnedTurn.value === null ? (diagnostics.latest?.turn ?? null) : null
}

/**
 * 这一轮的**子代理调用**（旁路模型调用：五问概括 / 画像刷新 / 画像小结…）。
 *
 * ★ 缺失就是空数组：V1 之前 / 落盘回放的那份信封可能没有 `spans`，
 *   浮窗如实不显示这一行，而不是渲染一个「0 次」的假读数。
 */
function spansOf(turn: TurnDiagnostics | null): RuntimeSpan[] {
  if (turn === null) return []
  const raw = (turn as TurnDiagnostics & { spans?: unknown }).spans
  return Array.isArray(raw) ? (raw as RuntimeSpan[]) : []
}

/**
 * 浮窗只报**计数**，细节在运行透视的时间轴里（那里有子代理泳道与真实时刻）。
 * ★ 为什么不并进 `DiagSummary`：那一份讲的是**主轮的分块**，子代理是旁路 ——
 *   混进去会让「这一轮几次工具调用」这类读数对不上（浮窗与运行透视共用那份摘要）。
 */
/**
 * 这一屏该显示的 span。
 *
 * ★★ 有轮次：取这一轮的（轮外那些已被主进程**迁移**进来）；
 *   **零轮次：取快照级的那一份**（`diagnostics.offTurnSpans`）——
 *   学生首次启动答完五问、一次还没聊过就是这一档，而那些旁路调用已经发生了。
 *   不读它，主进程即时推来的数据就白推了（V5）。
 */
const spansForPanel = computed<RuntimeSpan[]>(() =>
  shown.value === null ? diagnostics.offTurnSpans : spansOf(shown.value)
)

/**
 * 计数行的**唯一**文案来源。
 *
 * ★ 三种情形分开说，别让一句话绕圈：零轮次时「N 次」全是轮外，
 *   写成「子代理调用 N 次（其中轮外 N 次）」既啰嗦又像在强调一个恒等式。
 */
const spanLine = computed(() => {
  const all = spansForPanel.value
  if (all.length === 0) return ''
  const offTurn = all.filter((span) => span.offTurn).length
  if (offTurn === 0) return `子代理调用 ${all.length} 次`
  if (offTurn === all.length) return `轮外子代理调用 ${all.length} 次`
  return `子代理调用 ${all.length} 次（其中轮外 ${offTurn} 次）`
})

const position = computed(() => panel.pos ?? panel.defaultPos())

const originStyle = computed(() => {
  const p = position.value
  const o = panel.origin
  if (!o) return { transformOrigin: 'top right' }
  const x = Math.min(Math.max(o.x - p.x, 0), panel.size.w)
  const y = Math.min(Math.max(o.y - p.y, 0), panel.size.h)
  return { transformOrigin: `${Math.round(x)}px ${Math.round(y)}px` }
})

const style = computed(() => ({
  left: `${position.value.x}px`,
  top: `${position.value.y}px`,
  width: `${panel.size.w}px`,
  ...originStyle.value
}))

const drag = useDraggablePanel({
  rootRef,
  size: panel.size,
  margin: panel.margin,
  position: () => panel.pos,
  moveTo: (x, y) => panel.moveTo(x, y),
  isOpen: () => panel.open
})

/** 跳到运行透视并定位到这一轮（讲解从「就地说一句」升级成「摊开讲」）。 */
function openInDemo(): void {
  const turn = shown.value
  if (turn) diagnostics.select(turn.turn)
  ui.go('demo')
  panel.close()
}

/** 新轮次落地时保持在底部（浮窗默认跟最新一轮）。 */
watch(
  () => diagnostics.turns.length,
  () => {
    void nextTick(() => {
      const el = bodyRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)

useEscape(() => panel.close(), () => panel.open)

/** 焦点契约（优化报告 §3.1）：只读机制浮窗同样是**非模态**（不锁 Tab），
 *  但要「打开移入 / 关闭归还」—— `rootRef` 见模板根节点。 */
useFocusReturn(rootRef, () => panel.open, { trap: false })
</script>

<template>
  <Teleport to="body">
    <Transition name="dpanel">
      <!-- ★ 双保险：`open` 只能由教师 / 演示档里的按钮打开，这里再挡一次 -->
      <section
        v-if="panel.open && viewMode.isTeacher"
        ref="rootRef"
        class="dp k12-float"
        :class="{ 'dp--collapsed': panel.collapsed }"
        :style="style"
        role="dialog"
        aria-label="这一轮发生了什么"
        data-testid="diagnostics-panel"
      >
        <header
          class="dp__bar"
          title="拖动以移动窗口"
          @pointerdown="drag.onPointerDown"
          @pointermove="drag.onPointerMove"
          @pointerup="drag.onPointerUp"
          @pointercancel="drag.onPointerUp"
        >
          <GripHorizontal :size="14" class="dp__grip" />
          <span class="dp__chip">后台</span>
          <span class="dp__title">
            第 {{ shown?.turn ?? '—' }} 轮<template v-if="pinnedTurn !== null">（已固定）</template>
          </span>
          <button
            type="button"
            class="dp__btn"
            :title="pinnedTurn === null ? '固定在这一轮' : '取消固定'"
            :data-on="String(pinnedTurn !== null)"
            data-testid="diag-pin"
            @click.stop="togglePin()"
          >
            <Pin :size="14" />
          </button>
          <button
            type="button"
            class="dp__btn"
            :title="panel.collapsed ? '展开' : '折叠'"
            @click.stop="panel.toggleCollapsed()"
          >
            <Minus :size="14" />
          </button>
          <button type="button" class="dp__btn" title="关闭" @click.stop="panel.close()">
            <X :size="14" />
          </button>
        </header>

        <template v-if="!panel.collapsed">
          <div ref="bodyRef" class="dp__body">
            <p v-if="!shown" class="dp__empty">还没有轮次记录。先问一句，再打开这里。</p>
            <DiagSummary v-else :turn="shown" />
            <!-- 子代理（旁路模型调用）：只报计数，细节在运行透视的时间轴里。
                 ★ 零轮次时这一行照样在（数据源是快照级的 offTurnSpans，见 spanLine 的说明）。 -->
            <p v-if="spanLine" class="dp__spans" data-testid="diag-panel-spans">{{ spanLine }}</p>
            <p v-if="diagnostics.bridgeError" class="dp__warn">{{ diagnostics.bridgeError }}</p>
          </div>
          <footer class="dp__foot">
            <button type="button" class="dp__cta" data-testid="diag-open-demo" @click="openInDemo()">
              <Maximize2 :size="13" />
              在运行透视里打开
            </button>
          </footer>
        </template>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dp {
  position: fixed;
  z-index: 61;
  display: flex;
  flex-direction: column;
  border-radius: var(--k12-r-card);
  overflow: hidden;
}
.dp--collapsed {
  height: auto !important;
}
.dp__bar {
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
.dp__bar:active {
  cursor: grabbing;
}
.dp__grip {
  color: var(--k12-muted-2);
  flex: none;
}
.dp__chip {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-label);
  font-weight: 650;
}
.dp__title {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dp__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 28px：与追问窗同一条可点区判据（手指按得准才算按钮） */
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--k12-r-flat);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
.dp__btn[data-on='true'] {
  color: var(--k12-accent-ink);
  background: var(--k12-accent-soft);
}
@media (hover: hover) and (pointer: fine) {
  .dp__btn:hover {
    background: var(--k12-surface);
    color: var(--k12-fg-2);
  }
}
.dp__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--k12-surface);
}
.dp__empty {
  margin: 0;
  padding: 18px 12px;
  text-align: center;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
/* 子代理计数：与摘要同为「读数」，所以同档字号与弱色 —— 它不抢主读数。 */
.dp__spans {
  margin: 0;
  padding: 0 12px 10px;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.dp__warn {
  margin: 0;
  padding: 0 12px 10px;
  font-size: var(--k12-fs-caption);
  color: var(--k12-warn);
}
.dp__foot {
  border-top: 1px solid var(--k12-border);
  background: var(--k12-surface);
  padding: 8px 10px;
}
.dp__cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .dp__cta:hover {
    background: var(--k12-surface-2);
  }
}
.dpanel-enter-from,
.dpanel-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
