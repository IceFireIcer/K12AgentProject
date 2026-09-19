<script setup lang="ts">
/**
 * 当前学段的**显示 + 手动指定入口（一）**（另一个入口在设置页）。
 *
 * 为什么保留这个条：学段是**系统自动判定**的，学生没有做过任何操作；
 * 不给一点可见证据的话，「系统在适配我」这件事就完全看不出来。
 * 所以这里首先是**状态显示**（当前学段 / 它是怎么定下来的）。
 *
 * ★ 为什么还要有一个手动入口：自动推断有它的代价 —— 判错了（或还没判出来）
 *   学生只能干等。给一个显式指定，学生就能自己说了算；指定后 10 轮内系统不再自动改。
 * ★ 入口默认**收起来**：指示器平时只有一小行，点「自己指定」才展开四个选项。
 *   摊开着会让「系统自己在判」这件事看起来像「每次都让我填一遍」。
 * ★ 手动写路径**只有 store 里那一条** `chat.setGrade`（走 `grade:set` 独立通道）。
 *   这里不自己拼请求、也不改本地状态：界面显示的学段必须来自服务端回执 / 推送，
 *   否则会出现「指示器写着初中、回答却按小学讲」。
 *
 * 判定链路（主进程）：对话 → 规则引擎 + 轻量 LLM 判定 → `grade:changed` 推送
 * → `stores/chat.ts` 的 `currentGrade` → 这里显示。
 *
 * ── 两种用法（`compact` 属性）────────────────────────────────────────────
 *   - **顶栏用法（`compact`）**：顶栏是「当前环境」那一条（学段 + 模型并列），
 *     而它只有 64px 高、还要和标题 / 模型 chip / 视图切换按钮 / 窗口按钮共处一行 ——
 *     所以这里只留「chip + 短触发器」：
 *       · chip = 「当前档位 + 来源标签」挤成一枚小胶囊（来源文案仍由 labels.ts 唯一实现）；
 *       · 那句长说明**不进顶栏**（对话页空态已经写着「由系统根据对话自动判定，
 *         你也可以自己指定。」）；它的节点仍在 DOM 里，只是不显示 ——
 *         CDP 冒烟脚本按 testid 读它的 textContent，删掉节点会让那条探针落空，
 *         所以用 CSS 隐藏而不是 `v-if`；
 *       · 选项面板与一次性提示都**挂在这一格的绝对定位层**里，不占文档流行高 ——
 *         否则提示一出现，整条顶栏会往下长一截（行高抖动）。
 *   - **页面用法（默认，非紧凑）**：一整条带下边框的状态栏（说明 + 触发器 + 选项）。
 *     对话页**不再**用它（学段是全局的、章节是对话级的，见 `views/Chat.vue` 的说明），
 *     但这条用法保留给「需要一条完整状态栏」的页面。
 *
 * 显示分档：
 *   - 还没定下来（`currentGrade === null`）：`当前：待判定`，**不显示来源那一句**
 *     （还没定下来的东西没有「怎么定下来的」可言），也**不拿冷启动默认值冒充判定结果**；
 *   - 已定下来：`当前：初中` + 来源标签（「谁定的」这件事只有 labels.ts 一处说法）；
 *   - 变化时多一行一次性提示：系统判出来的是「我按初中的说法来讲。」，
 *     学生自己选的是「已按你选的初中的来讲。」（见 store 的 `gradeNotice`）。
 */
import { computed, ref } from 'vue'
import { GRADE_LEVELS } from '../api/grade'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL, gradeOriginLabel } from '../labels'
import { useChatStore } from '../stores/chat'
import type { GradeLevel } from '@shared/ipc-events'

/**
 * `compact` = 顶栏用法（见文件头）。默认 `false`：页面里那一整条完整状态栏。
 */
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const chat = useChatStore()

const label = computed(() => chat.currentGradeLabel ?? GRADE_UNKNOWN_LABEL)
const determined = computed(() => chat.currentGrade !== null)
/** 「学段是怎么定下来的」：只在真定下来之后显示（`null` 时整句不渲染）。 */
const originLabel = computed(() => gradeOriginLabel(chat.gradeOrigin))

/** 触发器文案：顶栏那一格和模型 chip 一样宽（「自己指定学段」在顶栏里太长）。 */
const triggerLabel = computed(() => (props.compact ? '自己指定' : '自己指定学段'))

const pickerOpen = ref(false)
/** 请求在飞：防连点（连点会重复写库，且第二次的回执会覆盖第一次的提示）。 */
const busy = ref(false)
const errorText = ref<string | null>(null)

function togglePicker(): void {
  pickerOpen.value = !pickerOpen.value
  // 重新展开时清掉上一次的失败文案（否则「选成功了」和「上次失败」会同时挂在界面上）
  if (pickerOpen.value) errorText.value = null
}

async function choose(level: GradeLevel): Promise<void> {
  if (busy.value) return
  busy.value = true
  errorText.value = null
  try {
    const result = await chat.setGrade(level)
    // 成功就收起选项（学生要看到的就是「选完了」）；失败留着选项，并说明原因
    if (result.ok) pickerOpen.value = false
    else errorText.value = result.message ?? '设定学段失败。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="grade"
    :class="{ 'grade--compact': compact, 'grade--picker-open': pickerOpen }"
    data-testid="grade-indicator"
    :data-grade="chat.currentGrade ?? ''"
    :data-origin="chat.gradeOrigin ?? 'unknown'"
    :data-determined="String(determined)"
  >
    <div class="grade__row">
      <!-- 一格里说清两件事：现在是哪一档（黑色粗体）+ 它是谁定的（来源标签）。
           来源说法只有 labels.ts 那一处实现，这里不重写文案。 -->
      <span class="grade__badge">
        <span class="grade__prefix">当前：</span>
        <strong class="grade__level" data-testid="grade-current-label">{{ label }}</strong>
        <template v-if="determined">
          <span class="grade__sep" aria-hidden="true">·</span>
          <span class="grade__origin" data-testid="grade-origin-label">{{ originLabel }}</span>
        </template>
      </span>

      <span class="grade__hint" data-testid="grade-indicator-hint">
        系统会根据你问的问题自动判断，你也可以自己指定。
      </span>

      <button
        type="button"
        class="grade__set"
        data-testid="grade-set"
        :disabled="chat.streaming"
        @click="togglePicker"
      >
        {{ triggerLabel }}
      </button>
    </div>

    <!-- 选项默认收起：点上面的按钮才展开（四个学段，当前生效的那个标出来）。
         失败文案放在面板**内部**：它在「面板还开着」时才可能出现（选成功就收起），
         放进面板里就不必再为它单独安排一个绝对定位的位置。 -->
    <div v-if="pickerOpen" class="grade__picker" data-testid="grade-options">
      <ul class="grade__list">
        <li v-for="level in GRADE_LEVELS" :key="level">
          <button
            type="button"
            class="grade__option"
            :class="{ 'grade__option--active': chat.currentGrade === level }"
            :data-testid="`grade-option-${level}`"
            :data-active="String(chat.currentGrade === level)"
            :disabled="chat.streaming || busy"
            @click="choose(level)"
          >
            {{ GRADE_LABELS[level] }}
          </button>
        </li>
      </ul>

      <!-- 设定失败：说清原因，不白屏、不抛异常（学生要能再点一次） -->
      <p v-if="errorText" class="grade__warn" data-testid="grade-set-error">{{ errorText }}</p>
    </div>

    <!-- 两截「额外信息」包一层：非紧凑时它是普通块（与原来一样逐条占行），
         紧凑时整层浮到 chip 下方 —— 见下面 `.grade--compact .grade__extras`。
         包一层而不是各自绝对定位：两条同时出现（提示 + 通道缺失）会叠在一起。 -->
    <div class="grade__extras">
      <!-- 学段变化时的一次性提示：适配发生了（或学生自己选了）也要看得出来 -->
      <p v-if="chat.gradeNotice" class="grade__notice" data-testid="grade-notice">{{ chat.gradeNotice }}</p>

      <!-- 判定通道缺失（主进程尚未接线）：说清原因，不让指示器永远沉默地停在「待判定」 -->
      <p v-if="chat.gradeBridgeError" class="grade__warn" data-testid="grade-indicator-note">
        {{ chat.gradeBridgeError }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.grade {
  padding: 8px 24px;
  background: var(--k12-surface);
  border-bottom: 1px solid var(--k12-border);
}

.grade__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.grade__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  border: 1px solid var(--k12-accent-border);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  white-space: nowrap;
}

/* 「当前：」是标签，比档位名轻一档 —— 学生要读的是档位本身 */
.grade__prefix {
  font-weight: 500;
}

.grade__level {
  font-weight: 650;
}

/* 分隔点：「桥接」两个事实（哪一档 / 谁定的），不是正文的一部分 */
.grade__sep {
  opacity: 0.65;
}

/* 来源标签：与档位名同格同色 —— 学生据此判断「我刚选的那一下有没有生效」 */
.grade__origin {
  font-weight: 550;
}

.grade__hint {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.grade__set {
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font: inherit;
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}

.grade__set:hover:not(:disabled) {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}

.grade__set:disabled {
  cursor: not-allowed;
  color: var(--k12-muted-2);
}

.grade__picker {
  margin-top: 8px;
}

.grade__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.grade__option {
  padding: 3px 12px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font: inherit;
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}

.grade__option:hover:not(:disabled) {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}

.grade__option:disabled {
  cursor: not-allowed;
  color: var(--k12-muted-2);
}

/* 当前生效的那一档：与 `.grade__badge` 同一视觉语言（选中 = 强调色） */
.grade__option--active {
  border-color: var(--k12-accent-border);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-weight: 600;
}

.grade__notice {
  margin-top: 5px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-good);
}

/* 一次性提示与通道缺失说明的**共同容器**（见模板里的说明）。
 * 非紧凑时是普通块：两条各自占一行，与改造前逐字一样。 */
.grade__extras {
  min-width: 0;
}

.grade__warn {
  margin-top: 5px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-warn);
}

/* ── 紧凑用法（顶栏）────────────────────────────────────────────────────
 * 只保留「chip + 触发器」这一行；其余两块都挂在**绝对定位层**里：
 *   · 选项面板 = 下拉；
 *   · 一次性提示 / 通道缺失说明 = chip 下方的一小片纸条（`--k12-shadow-float` 那一层）。
 * 两者都不进文档流 → 顶栏那一行不会因为它们出现而抖一下（顶栏是固定 64px 的单行，
 * 塞进流里只会溢出到内容区上）。
 *
 * ★ 纵向落点 = **顶栏下沿再往 6px**，而不是「紧贴 chip 下沿」：
 *   顶栏 `align-items: center`，所以指示器的中心就是那一行的中心 ——
 *   从中心再往下「半个顶栏高 + 6px」就到了顶栏外面。这比猜 chip 与行的间距稳，
 *   且 `--k12-h-topbar` 一改就跟着改（不留裸数字）。
 *
 * ⚠️ 顶栏整行是窗口拖拽区（无边框窗口）：这里的**每个可点元素**都要自己
 *   退出拖拽，否则点在它们身上会被窗口拖动吃掉。
 */
.grade--compact {
  position: relative;
  display: flex;
  align-items: center;
  padding: 0;
  background: transparent;
  border-bottom: none;
}

.grade--compact .grade__row {
  flex-wrap: nowrap;
  gap: 8px;
}

/* 长说明在顶栏里是冗余的（对话页空态已有一份）；节点保留给 CDP 探针读 */
.grade--compact .grade__hint {
  display: none;
}

.grade--compact .grade__badge,
.grade--compact .grade__set,
.grade--compact .grade__option,
.grade--compact .grade__picker {
  -webkit-app-region: no-drag;
}

.grade--compact .grade__picker {
  position: absolute;
  top: calc(50% + var(--k12-h-topbar) / 2 + 6px);
  right: 0;
  z-index: 4;
  margin: 0;
  padding: 10px;
  width: max-content;
  max-width: 260px;
  background: var(--k12-surface);
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-card);
  box-shadow: var(--k12-shadow-float);
}

.grade--compact .grade__list {
  flex-direction: column;
  flex-wrap: nowrap;
  align-items: stretch;
}

.grade--compact .grade__option {
  display: block;
  width: 100%;
  text-align: left;
}

/* 提示与通道说明都是浮层里的**流内**子项（纸条底色 + 浮层阴影）。
 * 包一层而不是各自绝对定位：两条同时出现（提示 + 通道缺失）会叠在一起。
 * ⚠️ 选择器用 `.grade__extras >` 限定：`grade-set-error` 也是 `.grade__warn`，
 *    但它住在选项面板里，不该被染成顶栏的纸条（下面单独给它一条间距）。 */
.grade--compact .grade__extras {
  position: absolute;
  top: calc(50% + var(--k12-h-topbar) / 2 + 6px);
  right: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  width: max-content;
  max-width: 320px;
  /* 通道缺失说明是长句：允许换行，但不许把顶栏撑宽（浮层不进流） */
  text-align: right;
  /* 纸条是**通知**、不是控件：它浮在内容上方，不该把底下的点击吃掉 */
  pointer-events: none;
}

.grade--compact .grade__extras > .grade__notice {
  margin: 0;
  padding: 3px 10px;
  white-space: nowrap;
  border-radius: var(--k12-r-pill);
  background: var(--k12-good-soft);
  border: 1px solid var(--k12-good-border);
  box-shadow: var(--k12-shadow-float);
}

.grade--compact .grade__extras > .grade__warn {
  margin: 0;
  padding: 3px 10px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
  box-shadow: var(--k12-shadow-float);
}

/* 选项面板打开时，把纸条让开：
 * 两者锚在**同一处**（都从顶栏下沿往右对齐），同时显示会叠在一起 ——
 * 而这一层里最该看的就是选项本身。学生正在选，旧提示也读不进去了
 * （点中之后会立刻出现一条新的回执）。
 * 用类而不是 `v-if`：节点留在 DOM 里，CDP 探针读 textContent 不受影响。 */
.grade--picker-open .grade__extras {
  display: none;
}

/* 选项面板里的失败说明：与选项之间留一点空，别贴着最后一个按钮 */
.grade--compact .grade__picker .grade__warn {
  margin-top: 8px;
  color: var(--k12-warn);
}
</style>
