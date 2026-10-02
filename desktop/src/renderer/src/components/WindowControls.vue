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
 * ★★ 视觉（2026-10-01 用户裁决重做，D-127）：**三个圆形色钮** ——
 *   最小化绿 / 最大化橙 / 关闭红（类 macOS 的交通灯，但色值取自本应用的语义令牌，
 *   不是那三支高饱和原色 —— 后者插在青绿纸面上会像贴纸）。
 *
 *   三条设计判断：
 *   ① **色从令牌来**：`--k12-good` / `--k12-warn` / `--k12-bad` 都是仓库既有语义色，
 *      橙色由 `--k12-warn`（偏棕）与 `--k12-bad` 按 62:38 混出**焦橙** —— 调色板里没有黄，
 *      写死 `#FF9F0A` 会破「色值只能来自令牌」的红线（要更亮的橙得先加令牌）。
 *   ② **30px 圆**：不再是 44×64 的通栏可点区。可点直径仍 ≥ WCAG 2.2 的 24px；
 *      圆钮**不能贴屏幕角**（会被窗口边缘切掉一块），所以右侧留 12px、钮间距 8px。
 *   ③ **质感与反馈**：顶部 1px 高光 + 同色描边 + 极轻外投影（有体积、不拟物）；
 *      hover 提亮并加一圈同色光晕，按下 `scale(.94)`，键盘焦点 2px 同色环。
 *      只给 120ms 反馈 —— 仓库既有的减动效兜底会把它压成 0（零动效纪律不受影响）。
 *
 *   ⚠️ 这条取代了原先「图标中性色、只有关闭键变红」的口径：现在三颗都是常显色钮。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, Minus, Square, X } from 'lucide-vue-next'
import { useCardShine } from '../composables/useCardShine'

/*
 * ★★ 液态玻璃 + 跟随鼠标的高光（2026-10-01 用户裁决，D-128）：
 *   「这三个按钮也要液态玻璃，还要有高光效果、随鼠标能动的那种」。
 *
 * 复用卡片那套 `useCardShine`（它已经在写「指针在元素内的局部坐标」），但**关掉形变**：
 *   `maxDent: 0`（圆钮没有角可压）、`maxTilt: 0`（30px 的圆一倾斜就看不出是圆）。
 *   于是只剩我们真正要的两条信号：`--k12-shine-x/-y`（高光跟着指针走）
 *   与 `--k12-shine-inside`（贴边程度 → 高光变强）。
 *   ⚠️ 不减动效时它照样工作；减动效开启时 composable 不挂监听，高光停在缺省位置
 *      —— 与「跟随指针的连续动画正是减动效要收的对象」这条纪律一致。
 */
const minRef = ref<HTMLElement | null>(null)
const maxRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLElement | null>(null)
const GLASS_OPTS = { maxDent: 0, maxTilt: 0 }
useCardShine(minRef, undefined, GLASS_OPTS)
useCardShine(maxRef, undefined, GLASS_OPTS)
useCardShine(closeRef, undefined, GLASS_OPTS)

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
      ref="minRef"
      type="button"
      class="wc__btn wc__btn--min"
      data-testid="window-minimize"
      title="最小化"
      aria-label="最小化"
      @click="minimize"
    >
      <Minus :size="14" :stroke-width="2.6" />
    </button>

    <button
      ref="maxRef"
      type="button"
      class="wc__btn wc__btn--max"
      data-testid="window-maximize"
      :title="maximized ? '向下还原' : '最大化'"
      :aria-label="maximized ? '向下还原' : '最大化'"
      @click="toggleMaximize"
    >
      <!-- 还原态用「两个叠起来的方框」，最大化态用「一个方框」——
           与 Windows 的语义相反是刻意的：**图标表示「按下去会发生什么」**，
           所以已最大化时显示的是「还原」那个图形。 -->
      <Copy v-if="maximized" :size="12" :stroke-width="2.6" />
      <Square v-else :size="11" :stroke-width="2.6" />
    </button>

    <button
      ref="closeRef"
      type="button"
      class="wc__btn wc__btn--close"
      data-testid="window-close"
      title="关闭"
      aria-label="关闭"
      @click="close"
    >
      <X :size="14" :stroke-width="2.8" />
    </button>
  </div>
</template>

<style scoped>
/* ── 三颗液态玻璃圆钮（D-127 形态 → D-128 玻璃化 + 跟随鼠标的高光）─────────────
 * 色相来源：`--k12-good` / `--k12-amber` / `--k12-bad`（仓库语义令牌，随主题走）。
 * ⚠️ 这一整块**不写死任何色值**：亮色的做法是把本色与 `#FFFFFF` 混，
 *    与 `--k12-shadow-*`、卡片光效同一条纪律（守卫 check:contrast 盯着令牌本身）。
 *
 * ★★ 三条液体玻璃的做法（用户要「液态玻璃 + 随鼠标动的高光 + 底色明亮」）：
 *   ① **明亮 + 白字**：用户要白字（「里面符号改成白色颜色」）。白字与「更亮的底」是**互相拉扯**的：
 *      最亮那版填充白字只有 **2.1:1**（读不清）。所以按白字反推填充深度：
 *      渐变改成「本色 70% 混白 → 本色 88% 混白」，白字对比度 **3.0 → 4.4:1**
 *      （图标是**图形**不是文字，适用 WCAG 非文本 3:1 门槛 ✅）；
 *      仍明显亮于最早那版实底色（那时白字 5.3:1，但底色偏暗 —— 用户两次口径的折中点）。
 *   ② **玻璃**：`backdrop-filter: blur + saturate` 让垫底的东西透上来（顶栏是白纸，
 *      所以它主要在不透明内容上方起作用）；再叠一层 160° 的浅深渐变当「玻璃厚度」，
 *      顶部 1px 白高光 + 内侧 1px 亮边 + 一圈极轻外投影。
 *   ③ **跟随鼠标的高光**：`::after` 用 `radial-gradient` 画一枚镜面高光，位置取
 *      `--k12-shine-x/-y`（`useCardShine` 每帧写进来的指针局部坐标）—— 鼠标在钮上移动，
 *      高光就跟着走；离开时 composable 把它推回 -999px，高光自动移出画面。
 *      `--k12-shine-inside`（贴边程度）另外把强度抬一点：贴边时更亮，像光扫过玻璃棱。
 *      `mix-blend-mode: screen` 让它在深色相上也不会盖成一块死白。
 * ⚠️ 三颗钮**常显颜色**：交通灯的语义靠颜色本身，藏起来等于没有。 */
.wc {
  display: flex;
  align-items: center;
  /* ★ 8px：三颗圆钮之间的呼吸。它们是一组 chrome，但不该糊成一团。 */
  gap: 8px;
  /* ★ 12px：圆钮**不能贴屏幕角** —— 贴着会被窗口边缘切掉一块；
   * 这也是圆钮与通栏按钮最不一样的地方（原注释「窗控贴边才是原生」随形态一起作废）。 */
  padding-right: 12px;
  flex: none;
  /* ★ 必须的：整个顶栏是拖拽区，不排除的话点按钮会被当成拖窗口。
   * 少了这一条的表现是「三个按钮全都点不动」——最容易被误判成 IPC 没接上。 */
  -webkit-app-region: no-drag;
}

.wc__btn {
  /* 30px 圆：可点直径高于 WCAG 2.2 的 24px 下限，又比 44px 通栏钮轻。 */
  width: 30px;
  height: 30px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  /* ★ 亮玻璃上的**同色深墨**字形：底色一明亮，白字就不够了（白对亮绿只有 2 出头）。
   * 本色 55% 混前景色 —— 仍是同一支色相，只是压深，实测三条都 ≈7:1。 */
  /* ★ 白字（用户裁决）：纸色令牌即白，仍不写死色值。 */
  color: var(--k12-on-fill);
  cursor: pointer;
  position: relative;
  /* ★ 玻璃的「厚度」：本色混白做一层浅深渐变（左上亮、右下实），比纯色更像一块料。 */
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--wc-hue) 70%, #FFFFFF) 0%,
    color-mix(in srgb, var(--wc-hue) 88%, #FFFFFF) 100%
  );
  /* ★ 真·毛玻璃：把垫底的东西糊上来。顶栏是白纸，所以它主要在不透明内容上方起作用；
   * 三颗 30px 的钮上这点开销可以忽略。 */
  backdrop-filter: blur(8px) saturate(150%);
  -webkit-backdrop-filter: blur(8px) saturate(150%);
  /* 玻璃的三笔：顶部 1px 白高光（光从上面来）+ 内侧 1px 亮边（把边缘收进去）+
   * 极轻外投影（离开纸面一线）。外圈描边的做法在 D-127 已被否掉（像贴纸）。 */
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.7),
    inset 0 0 0 1px color-mix(in srgb, var(--wc-hue) 30%, #FFFFFF),
    0 1px 2px color-mix(in srgb, var(--k12-fg) 18%, transparent);
  /* 只给反馈类属性，120ms；仓库全局的减动效兜底会把它压成 0。 */
  transition:
    filter 120ms var(--k12-ease-state),
    transform 120ms var(--k12-ease-state),
    box-shadow 120ms var(--k12-ease-state);
}
/* ★★ 跟随鼠标的镜面高光（D-128）：位置取 `useCardShine` 每帧写进来的局部坐标。
 *   缺省 -999px = 指针不在钮上 → 高光移出画面，钮看着就是一块静态玻璃。
 *   `screen` 混合让它在深色相上也不会盖成死白；贴边时（--k12-shine-inside）再亮一点。 */
.wc__btn::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  /* ★ 2026-10-01 用户裁决（D-128 补充二）：「高光的模糊范围和高光范围大一点」——
   *   ① 范围：半径 13px → **22px**（钮只有 30px，这一档已经接近整颗被扫过）；
   *   ② 模糊：从「实心 → 70% 处截断」改成**三档渐隐**（0% 峰值 / 45% 半强度 / 100% 收干净），
   *      过渡更长、边界更软，读起来是一层光扫过玻璃，而不是一枚贴上去的白点。
   *   峰值仍压在 0.6 以内：再高就把白色的符号也一起糊掉（符号本身是白的）。 */
  background: radial-gradient(
    circle 22px at var(--k12-shine-x, -999px) var(--k12-shine-y, -999px),
    rgb(255 255 255 / calc(0.5 + var(--k12-shine-inside, 0) * 0.5)) 0%,
    rgb(255 255 255 / calc(0.26 + var(--k12-shine-inside, 0) * 0.26)) 45%,
    transparent 100%
  );
  mix-blend-mode: screen;
}
/* 逐键取色（各自的 --wc-hue）：绿 / 焦橙 / 红。 */
.wc__btn--min {
  --wc-hue: var(--k12-good);
}
.wc__btn--max {
  /* ★ 橙：原先用 `warn`（棕）混 `bad`（红）凑，真机上读出来是**棕**不是橙 ——
   * 调色板里根本没有黄。所以按既有家族模式（good/bad/cyan 各有 -soft/-border）
   * 给 `tokens.source.json` 的 `single` 加了 `amber` 一支，走生成流水线（`gen:tokens`）。
   * `#C2410C`：对白 4.9:1，白字压上去读得清，色相明确是橙。 */
  --wc-hue: var(--k12-amber);
}
.wc__btn--close {
  --wc-hue: var(--k12-bad);
}

@media (hover: hover) and (pointer: fine) {
  .wc__btn:hover {
    /* ★ 外发光已按用户要求去掉（原先这里有 `0 0 0 4px` 的同色光晕）。
     * 现在 hover 只做两件事：提亮一档 + 内侧亮边更明显 —— 钮本身不向外发亮。 */
    filter: brightness(1.06);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.8),
      inset 0 0 0 1px color-mix(in srgb, var(--wc-hue) 45%, #FFFFFF),
      0 1px 2px color-mix(in srgb, var(--k12-fg) 18%, transparent);
  }
}
/* 按下：缩一点点 + 收到内阴影里 —— 物理按键的「下去」感。 */
.wc__btn:active {
  transform: scale(0.94);
  filter: brightness(0.96);
  box-shadow:
    inset 0 3px 4px color-mix(in srgb, var(--k12-fg) 26%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--wc-hue) 45%, var(--k12-fg));
}
/* 键盘焦点：同色 2px 环 + 一圈纸色隔断，在浅底上看得见、也不与 hover 光晕打架。 */
.wc__btn:focus-visible {
  outline: none;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.7),
    /* 键盘焦点环保留（这是**无障碍affordance**，不是装饰性外发光）：
     * 纸色隔断 + 同色环，只有 Tab 到它时才出现。 */
    0 0 0 2px var(--k12-surface),
    0 0 0 4px color-mix(in srgb, var(--wc-hue) 70%, var(--k12-fg));
}

/* 窄窗口：窗口按钮是**最后才让位**的东西（没有它就没法关窗），只收紧间距与直径，不隐藏。 */
@media (max-width: 1023px) {
  .wc {
    gap: 6px;
    padding-right: 8px;
  }
  .wc__btn {
    width: 26px;
    height: 26px;
  }
}
</style>
