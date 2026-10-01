<script setup lang="ts">
/**
 * 操作日志卡 —— 「导入教材 / 重建索引 / 读取」这三类一次性操作的**事后流水**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么默认折叠，且叠在卡片里而不是单开一页
 * ══════════════════════════════════════════════════════════════════════════
 *   · 它是**旁证**，不是主路径：没人会为了看日志而打开知识库页。默认展开会让
 *     最长 280px 的一块流水账压住正文，学生每次进页面都得先跨过它。
 *   · 折叠态只有一条 ~40px 的标题条，计数（成功/警告/错误）仍然可见 ——
 *     「值不值得展开」这个判断不需要先展开就能做，这是折叠能成立的前提。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么数据只从 store 读、组件不接 props
 * ══════════════════════════════════════════════════════════════════════════
 *   写入口分散在几处（知识库页的导入/重建、读取动作），若走 props，每个宿主
 *   都要自带一份日志、切页即丢；而日志的价值恰恰是**跨动作累计**。所以唯一
 *   真相是 `stores/opLog.ts`，本组件只是它的一个视图，没有可传的参数——
 *   无 props/emits 是「视图不能反过来影响数据源」的表述，不是省事。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 自动跟随的三条判据（缺一条都会变成"抢滚动条"）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① 新条目出现 → 滚到底：列表时间升序，新的一条永远在末尾；
 *   ② 用户上滚离开底部 **>40px** → 暂停跟随。40px 而不是 1px：滚轮的惯性回位
 *      与触控板的微小抖动都会让 scrollTop 差几个像素，判据太紧会把"我只是在
 *      读倒数第二条"误判成"我要看最新的"；
 *   ③ 悬停期间不自动滚：鼠标停在其中一行时列表自己跳动，等于从用户手里抢走
 *      正在读的那一行。移开且**仍在底部**才恢复——若用户已滚走，那是他的意图。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { ElMessage } from 'element-plus'
import SurfacePanel from './SurfacePanel.vue'
import { useConfirm } from '../stores/confirm'
import {
  ACTION_LABEL,
  LEVEL_LABEL,
  filterEntries,
  formatClock,
  formatDuration,
  formatEntriesForCopy,
  useOpLog,
  type OpLogLevel
} from '../stores/opLog'

/** 唯一的数据源：面板不缓存、不复制，读写都回到 store（见文件头第 2 段）。 */
const opLog = useOpLog()
const confirm = useConfirm()

/**
 * 展开状态（2026-09-30 用户裁决：**有记录就默认展开**）。
 *
 * 三档规则，缺一条都会变成「跟用户抢」：
 *   ① 初始值 = 「store 里已经有记录」：一条都没有时展开只是白占 280px；
 *   ② 新记录到来、而用户**没手动碰过**这块面板 → 自动展开 —— 这正是「有输入的时候
 *      默认展开」要的效果：导入 / 重建一按下去，流水自己露出来，不必再点一下；
 *   ③ 用户一旦手动折叠或展开，`manual` 置位，此后**只跟用户**：他折起来看正文时，
 *      后台再来一条日志不该把面板顶开（那会变成「抢滚动条」的翻版）。
 *
 * ★ 清空到 0 条时（未手动干预）回到折叠 —— 空流水没有理由占着版面。
 */
const open = ref(opLog.total > 0)

/** 用户是否亲手切过这块面板（切过之后自动展开/折叠一律让位）。 */
let manual = false

type LevelFilter = OpLogLevel | 'all'

/** 筛选档位（值与 store 的 level 词表同源，标签只在这里写一份）。 */
const FILTERS: ReadonlyArray<{ value: LevelFilter, label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'success', label: '成功' },
  { value: 'info', label: '提示' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' }
]

const LEVEL_VALUES: readonly LevelFilter[] = FILTERS.map((item) => item.value)

const level = ref<LevelFilter>('all')

/**
 * ★ 不写 `v-model`：Element Plus 的 radio-group 向外抛的是
 * `string | number | boolean | undefined`，直接 v-model 到收窄的联合类型上
 * 要么类型不通过、要么被迫把 ref 放宽成 string（筛选就失去类型保护）。
 * 这里把"收窄"显式写成一个判据，非法值一律回落到 'all'——
 * 比断言更安全的地方在于：即便组件库将来多抛一种值，界面也只是回到全部。
 */
function isFilter(value: unknown): value is LevelFilter {
  return typeof value === 'string' && (LEVEL_VALUES as readonly string[]).includes(value)
}

function setLevel(value: unknown): void {
  level.value = isFilter(value) ? value : 'all'
}

/** 列表里真正渲染的那些（筛选只影响显示，不影响 store 里的原始流水）。 */
const visible = computed(() => filterEntries(opLog.entries, level.value))

/**
 * 标题条上的微型计数：只报「值得注意」的三档。
 * 提示（info）是常态——每次读取都记一条，把它也印出来只会稀释信号。
 */
const flagged = computed(() => {
  const counts = opLog.counts
  return [
    { key: 'success', label: '成功', n: counts.success },
    { key: 'warn', label: '警告', n: counts.warn },
    { key: 'error', label: '错误', n: counts.error }
  ].filter((item) => item.n > 0)
})

const listRef = ref<HTMLElement | null>(null)

/** 是否跟随最新一条（见文件头第 3 段的三条判据）。 */
const following = ref(true)
/** 鼠标是否停在列表上；悬停期间不自动滚。 */
const hovering = ref(false)

/** 距底部 40px 以内都算"还在看最新"——判据见文件头第 3 段 ②。 */
const FOLLOW_SLACK_PX = 40

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
}

function scrollToBottom(): void {
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/**
 * 滚动由用户驱动：这里只**记录**他是否还在底部，不反向写 scrollTop——
 * 在 scroll 事件里改 scrollTop 会与用户的滚动互相顶，表现为列表"跳一下"。
 */
function onScroll(): void {
  const el = listRef.value
  if (el) following.value = atBottom(el)
}

function onEnter(): void {
  hovering.value = true
}

function onLeave(): void {
  hovering.value = false
  const el = listRef.value
  // 移开时若还停在底部，说明用户没有主动离开最新一条，恢复跟随。
  if (el && atBottom(el)) {
    following.value = true
    scrollToBottom()
  }
}

/** 新条目出现时滚到底；用户已滚走或正悬停则不打扰。 */
function followNewest(): void {
  if (!open.value || hovering.value || !following.value) return
  void nextTick(scrollToBottom)
}

// 判据用「最后一条的 id」而不是「长度」：到达 200 条上限后长度不再变化，
// 只看长度会让环形裁剪之后的新条目**永远不再触发**跟随。
watch(() => opLog.entries[opLog.entries.length - 1]?.id ?? 0, followNewest)

// 切换筛选等于换了一份列表（行数、行高都变），此时"看最新的"是明确意图。
watch(level, () => {
  following.value = true
  followNewest()
})

// 展开是一次新的进入：无论此前滚到哪里，都从最新一条看起。
watch(open, (value) => {
  if (!value) return
  following.value = true
  void nextTick(scrollToBottom)
})

function toggle(): void {
  manual = true
  open.value = !open.value
}

// 记录条数的变化 → 未手动干预时「有记录就展开、清空就收起来」（见 open 的说明）。
watch(
  () => opLog.total,
  (total) => {
    if (manual) return
    open.value = total > 0
  }
)

/** 复制的是**当前可见**的条目——筛过之后再复制，粘出来的就是屏幕上那一份。 */
async function copyVisible(): Promise<void> {
  try {
    await navigator.clipboard.writeText(formatEntriesForCopy(visible.value))
    ElMessage.success('已复制操作日志')
  } catch {
    // 剪贴板也可能被系统策略拒绝；给一句可执行的替代动作，而不是静默失败。
    ElMessage.error('复制失败，请手动选择文本')
  }
}

async function clearAll(): Promise<void> {
  const ok = await confirm.ask({
    title: '清空操作日志？',
    body: '清空后无法恢复。',
    danger: true,
    confirmText: '清空'
  })
  if (!ok) return
  opLog.clear()
}
</script>

<template>
  <!--
    flush：标题条要通栏（卡头贴边是这套卡片语言的一部分），内边距由 .oplog__bar 自己给；
    背景/圆角/投影全部由壳提供，这里一个都不重写。
  -->
  <SurfacePanel class="oplog" data-testid="op-log-panel" flush>
    <!-- 整条标题都是开关：折叠态只有这一行，热区就是它自己（不要只让箭头可点）。 -->
    <div
      class="oplog__bar"
      role="button"
      tabindex="0"
      :aria-expanded="open ? 'true' : 'false'"
      data-testid="op-log-toggle"
      @click="toggle()"
      @keydown.enter.prevent="toggle()"
      @keydown.space.prevent="toggle()"
    >
      <span class="oplog__title">操作日志 · {{ opLog.total }} 条</span>
      <span
        v-for="item in flagged"
        :key="item.key"
        class="oplog__chip"
        :data-level="item.key"
      >
        {{ item.label }} {{ item.n }}
      </span>
      <ChevronDown v-if="open" :size="15" class="oplog__chev" aria-hidden="true" />
      <ChevronRight v-else :size="15" class="oplog__chev" aria-hidden="true" />
    </div>

    <div v-show="open" class="oplog__body">
      <div class="oplog__tools">
        <el-radio-group
          class="oplog__filter"
          size="small"
          :model-value="level"
          @update:model-value="setLevel"
        >
          <el-radio-button v-for="item in FILTERS" :key="item.value" :value="item.value">
            {{ item.label }}
          </el-radio-button>
        </el-radio-group>
        <button type="button" class="oplog__btn" data-testid="op-log-copy" @click="copyVisible()">
          复制
        </button>
        <button type="button" class="oplog__btn" data-testid="op-log-clear" @click="clearAll()">
          清空
        </button>
      </div>

      <ul
        ref="listRef"
        class="oplog__list"
        data-testid="op-log-list"
        @scroll="onScroll()"
        @mouseenter="onEnter()"
        @mouseleave="onLeave()"
      >
        <li v-if="visible.length === 0" class="oplog__empty">
          {{ opLog.total === 0 ? '还没有操作记录。导入或重建教材后，这里会留下记录。' : '当前筛选下没有记录。' }}
        </li>
        <template v-else>
          <li
            v-for="entry in visible"
            :key="entry.id"
            class="oplog__row"
            data-testid="op-log-entry"
          >
            <span class="oplog__time">{{ formatClock(entry.at) }}</span>
            <!--
              级别只用这一个 3px 色点表达：整行铺底色会让列表变成一堵色墙，反而看不出级别。
              ★ 但颜色是**唯一**通道的话，色觉障碍与读屏用户就拿不到这个信息——
                所以色点带一个 role="img" + aria-label 的可访问名（改的是语义，不是外观）。
            -->
            <span
              class="oplog__dot"
              role="img"
              :data-level="entry.level"
              :aria-label="LEVEL_LABEL[entry.level]"
            />
            <span class="oplog__action">{{ ACTION_LABEL[entry.action] }}</span>
            <span v-if="entry.target" class="oplog__target">{{ entry.target }}</span>
            <span class="oplog__detail">{{ entry.detail }}</span>
            <span class="oplog__dur">{{ formatDuration(entry.durationMs) }}</span>
          </li>
        </template>
      </ul>
    </div>
  </SurfacePanel>
</template>

<style scoped>
/*
 * 高度上限：折叠态由标题条撑（~40px），展开态整体不许超过 280px——
 * 列表本身限 240px，再由根节点 280px 的上限兜住标题条与工具条，
 * 两者一起保证「日志再长也不会把页面顶下去」。
 */
.oplog {
  display: flex;
  flex-direction: column;
  max-height: 280px;
}

.oplog__bar {
  display: flex;
  align-items: center;
  gap: var(--k12-sp-2);
  flex: none;
  padding: var(--k12-sp-2) var(--k12-sp-3);
  cursor: pointer;
  user-select: none;
}

.oplog__title {
  font-size: var(--k12-fs-body-lg);
  line-height: var(--k12-lh-tight);
  font-weight: 650;
  color: var(--k12-fg);
}

/* 微型计数：小一号色块字，不与标题抢主次 */
.oplog__chip {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--k12-r-pill);
  font-size: var(--k12-fs-label);
  font-weight: 650;
  color: var(--k12-muted);
  background: var(--k12-surface-2);
}

.oplog__chip[data-level='success'] {
  color: var(--k12-good);
}

.oplog__chip[data-level='warn'] {
  color: var(--k12-warn);
}

.oplog__chip[data-level='error'] {
  color: var(--k12-bad);
}

.oplog__chev {
  flex: none;
  /* 箭头推到最后：它表达的是"这一条能展开"，不参与左侧信息的阅读顺序 */
  margin-left: auto;
  color: var(--k12-muted);
}

.oplog__body {
  display: flex;
  flex-direction: column;
  /* min-height: 0 是让列表能在 280px 上限内被压缩的前提（flex 子项默认不缩） */
  min-height: 0;
  border-top: 1px solid var(--k12-border);
}

.oplog__tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--k12-sp-2);
  flex: none;
  padding: var(--k12-sp-2) var(--k12-sp-3);
  border-bottom: 1px solid var(--k12-border);
}

.oplog__filter {
  min-width: 0;
}

.oplog__btn {
  flex: none;
  min-height: 26px;
  padding: 0 var(--k12-sp-3);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .oplog__btn:hover {
    background: var(--k12-surface-2);
  }
}

.oplog__list {
  /* 240px 是列表自己的上限；实际高度还会被根节点的 280px 上限再压一次 */
  max-height: 240px;
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.oplog__empty {
  padding: var(--k12-sp-4) var(--k12-sp-3);
  text-align: center;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}

.oplog__row {
  display: flex;
  align-items: center;
  gap: var(--k12-sp-2);
  padding: 3px var(--k12-sp-3);
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
}

.oplog__time {
  flex: none;
  font-family: var(--k12-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--k12-muted);
}

.oplog__dot {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: var(--k12-r-pill);
}

.oplog__dot[data-level='info'] {
  background: var(--k12-accent);
}

.oplog__dot[data-level='success'] {
  background: var(--k12-good);
}

.oplog__dot[data-level='warn'] {
  background: var(--k12-warn);
}

.oplog__dot[data-level='error'] {
  background: var(--k12-bad);
}

.oplog__action {
  flex: none;
  font-weight: 600;
  color: var(--k12-fg);
}

.oplog__target {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--k12-muted);
}

/* detail 吃掉剩余宽度并截断：一行一条才看得出"这是同一时刻的一件事" */
.oplog__detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.oplog__dur {
  flex: none;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--k12-muted);
}
</style>
