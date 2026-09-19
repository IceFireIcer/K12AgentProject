<script setup lang="ts">
/**
 * 窗口按钮：最小化 / 最大化（还原）/ 关闭。
 *
 * ★★ 为什么由页面画：窗口是 `frame: false`（见 `main/index.ts` 的说明）——
 *   Windows 原生标题栏是系统灰 + 应用图标 + 菜单，与本设计（浅色纸面 + 学段配色）
 *   不是一套视觉，而且会在顶栏之上再压一行，把「对话优先」的纵向空间吃掉一截。
 *
 * ★ 三条约束（少任何一条，无边框窗口就会变得不好用）：
 *   ① **可点**：整个顶栏是拖拽区（`AppShell.vue`），所以本组按钮必须
 *      `-webkit-app-region: no-drag`，否则点下去会被拖拽吃掉 —— 表现得像「按钮坏了」。
 *   ② **图标要对**：最大化状态由主进程推来（双击标题栏、Win+↑/↓、
 *      拖到屏幕上边缘都会改它，渲染进程自己观察不到）。所以订阅
 *      `onWindowMaximizedChanged`，而不是自己记一个本地布尔。
 *   ③ **关闭走正常流程**：`window.close()` → `close`/`closed`/`before-quit`
 *      （Pi 会话 flush + sidecar 收尾都在那里）。**不是**强杀。
 *
 * ★ 视觉：这是**窗口 chrome**，不是内容 —— 所以离开内容层（不用纸面卡片样式），
 *   图标中性色、hover 才显形；**只有关闭键用红**（它是破坏性的，也符合 Windows 习惯：
 *   三个键里永远只有它变红）。不引入动画（版式契约的零动效纪律）。
 *
 * ★ 尺寸纪律：44×32 的可点区（Windows 原生就是 45×30 上下），比导航项矮一档 ——
 *   它是窗口 chrome，不该和「对话 / 闯关」那些导航项抢同一档视觉权重。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, Minus, Square, X } from 'lucide-vue-next'

/** 主进程推来的最大化状态（`null` = 还没收到，按「未最大化」画）。 */
const maximized = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(() => {
  const api = globalThis.window?.api
  // 桥缺失（分步接线 / 测试替身）：按钮仍在，只是状态不跟 —— 不抛异常
  if (typeof api?.onWindowMaximizedChanged !== 'function') return
  unsubscribe = api.onWindowMaximizedChanged((next) => {
    maximized.value = next
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})

/*
 * 三个动作都**不吞回执**：主进程回 false 表示「窗口已销毁 / 正在退出」，
 * 那时点什么都不会发生 —— 这正是需要知道的情况（否则表现成「按钮点了没反应」）。
 * 回执只用于诊断，不进界面：无边框窗口在退出瞬间就把自己拆了，
 * 往界面上写一句「操作失败」既看不到、也没有意义。
 */
async function minimize(): Promise<void> {
  await globalThis.window?.api?.minimizeWindow?.()
}

async function toggleMaximize(): Promise<void> {
  await globalThis.window?.api?.toggleMaximizeWindow?.()
}

async function close(): Promise<void> {
  await globalThis.window?.api?.closeWindow?.()
}
</script>

<template>
  <div class="wc" data-testid="window-controls">
    <button
      type="button"
      class="wc__btn"
      data-testid="window-minimize"
      title="最小化"
      aria-label="最小化"
      @click="minimize"
    >
      <Minus :size="14" />
    </button>

    <button
      type="button"
      class="wc__btn"
      data-testid="window-maximize"
      :title="maximized ? '向下还原' : '最大化'"
      :aria-label="maximized ? '向下还原' : '最大化'"
      @click="toggleMaximize"
    >
      <!-- 还原态用「两个叠起来的方框」，最大化态用「一个方框」——
           与 Windows 的语义相反是刻意的：**图标表示「按下去会发生什么」**，
           所以已最大化时显示的是「还原」那个图形。 -->
      <Copy v-if="maximized" :size="13" />
      <Square v-else :size="12" />
    </button>

    <button
      type="button"
      class="wc__btn wc__btn--close"
      data-testid="window-close"
      title="关闭"
      aria-label="关闭"
      @click="close"
    >
      <X :size="15" />
    </button>
  </div>
</template>

<style scoped>
.wc {
  display: flex;
  align-items: stretch;
  flex: none;
  /* ★ 必须的：整个顶栏是拖拽区，不排除的话点按钮会被当成拖窗口。
   * 少了这一条的表现是「三个按钮全都点不动」——最容易被误判成 IPC 没接上。 */
  -webkit-app-region: no-drag;
}

.wc__btn {
  width: 44px;
  height: var(--k12-h-topbar);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
  /* 三个按钮之间不描边、不留缝：它们是**一整块窗口 chrome**，
   * 描边会让顶栏右端碎成三个小方块。 */
  padding: 0;
}
@media (hover: hover) and (pointer: fine) {
  .wc__btn:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg);
  }
}
.wc__btn:active {
  background: var(--k12-border);
}

/* 关闭键：hover 时红底白字。这是 Windows 上唯一变红的那个键 ——
 * 学生不需要读它就认得出「这是关窗」。 */
.wc__btn--close:hover {
  background: var(--k12-bad);
  color: var(--k12-surface);
}
.wc__btn--close:active {
  filter: brightness(0.92);
}

/* 窄窗口：窗口按钮是**最后才让位**的东西（没有它就没法关窗），
 * 只把可点区收窄一点，不隐藏。 */
@media (max-width: 1279px) {
  .wc__btn {
    width: 38px;
  }
}
</style>
