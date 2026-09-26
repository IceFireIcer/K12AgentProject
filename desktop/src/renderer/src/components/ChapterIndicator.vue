<script setup lang="ts">
/**
 * 当前教材章节的**显示 + 选择入口（一）**（另一个入口在设置页）。
 *
 * 这是一份**软偏好**，不是检索契约：选了「第 4 章」，回答与检索会优先围绕它，
 * 但学生问到别的章节照常回答（不做 SQL 硬过滤）。
 * 所以这里首先是**状态显示**（「正在学：…」），其次才是一个可选的选择入口。
 *
 * ★ 入口默认**收起来**（与 `GradeIndicator` 同一理由）：平时只有一行字，
 *   点「选择章节」才展开章节目录 —— 顶栏一直摊着几十个章节按钮会把对话挤没。
 * ★ 写路径**只有 store 里那一条** `chat.setChapter`（走 `chapter:set` 独立通道）。
 *   这里不自己拼请求、也不改本地状态：界面上显示的章节必须来自服务端回执 / 推送，
 *   否则会出现「指示器写着第 4 章、Prompt 里却是另一章」。
 * ★ 章节**清单**复用既有的取数路径（`stores/study.ts` 的 `loadChapters`，
 *   同一份数据也供「学习档案 → 章节进度」分页使用）—— 不新增第二条取数路径。
 *
 * ── 它住在哪里（与学段指示器的分工）──────────────────────────────────────
 * 学段是**全局环境**（在哪一页都成立），所以那一枚在顶栏；章节是**这段对话在学什么**，
 * 所以它挂在对话页消息区上方的那条信息条里（`views/Chat.vue` 的 `.chat__bar`，
 * 2026-09-22 报告 4.4 之后与「本轮对话」并排同处一行）。
 * ★ 分隔线由**外面那一行**（`.chat__bar`）画：两个组件各自再画一条就会叠成双线。
 *   所以本组件自己不画下边框（页面用法需要时由所在容器决定）。
 *
 * 显示的三种状态：
 *   - 还没判定出学段（`chat.currentGrade === null`）：给一句可读提示，**不列空列表**
 *     （章节按学段分，学段未知列不出任何东西）；
 *   - 清单读取中 / 读失败：各说各的（复用档案页那套 `loading.chapters` / `errors.chapters`）；
 *   - 正常：**目录式**的一列章节（章号在左、标题在右、当前那一章带勾）
 *     + 与目录分开的「不限章节（自由问答）」。
 *     ★ 「目录」这一版是走查改出来的：原先是几十个平铺的胶囊按钮，看不出这是一本教材的目录。
 *       样式是纯投影（`chapterRows`），**没有编造章节简介** —— 契约里没有这个字段。
 *
 * 选章**不会改变学段**（两件事各自独立）——设置页那条入口把这句话写在界面上。
 */
import { computed, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import { useDismissable } from '../composables/useDismissable'
import { chapterLineLabel } from '../labels'
import { useChatStore } from '../stores/chat'
import { useStudyStore } from '../stores/study'

const chat = useChatStore()
const study = useStudyStore()

const pickerOpen = ref(false)
/** 面板与触发键：Esc / 点外部要用它们判断「点在不在里面」。 */
const panelRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLElement | null>(null)

/** ★ 与学段下拉同一条纪律：Esc + 点外部都能收起（见 useDismissable 的说明）。 */
useDismissable({
  panel: panelRef,
  trigger: triggerRef,
  open: () => pickerOpen.value,
  close: () => {
    pickerOpen.value = false
  }
})
/** 请求在飞：防连点（连点会重复写库，且第二次的回执会覆盖第一次的提示）。 */
const busy = ref(false)
const errorText = ref<string | null>(null)

const line = computed(() => chapterLineLabel(chat.currentChapter))
const determined = computed(() => chat.currentGrade !== null)
const unavailable = computed(() => !determined.value)

/**
 * 把「第4章 大模型与AI智能体Agent」拆成**序号 + 标题**两件东西。
 *
 * ★ 为什么拆：走查结论原话是「一堆平铺的按钮，看不出这是一本教材的目录」。
 *   目录的样子应该是「左边一列章号、右边标题」——章号对齐之后，学生扫一眼
 *   就知道自己在第几章、旁边还有几章，而不是在一行文字里找「第几章」。
 * ★ 只认阿拉伯数字（与 `kb.py` 的 `_CHAPTER_NUMBER_RE` 同口径）：中文序号
 *   （「第一章」）由导入脚本 `normalize_chapter()` 统一转换过，运行时不该再出现；
 *   万一出现也不猜 —— 整串当标题，序号徽标不渲染（比编一个「第?章」诚实）。
 */
function chapterParts(title: string): { num: string; text: string } {
  const match = /^第\s*(\d+)\s*章\s*(.*)$/.exec(title.trim())
  if (match === null) return { num: '', text: title.trim() }
  return { num: `第${match[1]}章`, text: match[2].trim() }
}

/**
 * 目录行 = 契约字段的**纯投影**（序号 / 标题 / 一行说明）。
 *
 * ★ 一行说明只用契约里真有的字段（`kpCount` / `masteredCount`）——
 *   `ChapterInfo` 里**没有**「章节简介」这种字段，所以这里不许编一句「本章介绍…」：
 *   编出来的说明与教材实际内容无关，学生按它选章会选错。
 * ★ 「已掌握」只在大于 0 时出现：一串「0/5」会让目录看起来像一张成绩单。
 */
const chapterRows = computed(() =>
  (study.chapters?.chapters ?? []).map((chapter) => {
    const parts = chapterParts(chapter.chapterTitle)
    const base = `${chapter.kpCount} 个知识点`
    return {
      title: chapter.chapterTitle,
      num: parts.num,
      name: parts.text,
      meta: chapter.masteredCount > 0 ? `${base} · 已掌握 ${chapter.masteredCount}` : base
    }
  })
)

function togglePicker(): void {
  pickerOpen.value = !pickerOpen.value
  if (pickerOpen.value) {
    errorText.value = null
    // 展开时按需取清单：已有当前学段的清单就不会重复请求（见 study store 的注释）
    void study.loadChapters(chat.currentGrade)
  }
}

/**
 * ★ 学段变化会**换掉整个章节目录**（还可能在服务端清空已选章节）——
 *   展开着的时候必须重取，否则学生看到的是上一个学段的章，选中必然失败。
 *   学段未判定时 `loadChapters(null)` 只给一句提示，不发请求。
 */
watch(
  () => chat.currentGrade,
  (level, previous) => {
    if (pickerOpen.value && level !== previous) void study.loadChapters(level)
  }
)

async function choose(title: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  errorText.value = null
  try {
    const result = await chat.setChapter(title)
    // 成功就收起选项（学生要看到的就是「选完了」）；失败留着选项，并说明原因
    if (result.ok) pickerOpen.value = false
    else errorText.value = result.message ?? '设定章节失败。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="chapter" data-testid="chapter-indicator" :data-chapter="chat.currentChapter">
    <p class="chapter__line">
      <span class="chapter__badge" data-testid="chapter-current-label">{{ line }}</span>
      <button
        type="button"
        ref="triggerRef"
        class="chapter__set"
        data-testid="chapter-set"
        :disabled="chat.streaming"
        @click="togglePicker"
      >
        选择章节
      </button>
    </p>

    <!-- 选项默认收起：点上面的按钮才展开。
         ★ 展开后是**一本教材的目录**（不是一堆平铺的按钮）：一行一章、
           左边章号、右边标题与知识点数，当前生效的那一行带勾。
           这样「这是第几章、总共几章、我在哪一章」一眼可读。 -->
    <div v-if="pickerOpen" ref="panelRef" class="chapter__picker" data-testid="chapter-options">
      <p v-if="unavailable" class="chapter__note" data-testid="chapter-no-grade">
        还没有判定出你的学段：教材章节按学段分，判定出来之后就能从这里选。
      </p>
      <p v-else-if="study.loading.chapters" class="chapter__note" data-testid="chapter-loading">
        正在读取教材章节…
      </p>
      <template v-else>
        <p v-if="study.errors.chapters" class="chapter__warn" data-testid="chapter-list-error">
          {{ study.errors.chapters }}
        </p>

        <ul v-if="chapterRows.length > 0" class="chapter__list" data-testid="chapter-list">
          <li v-for="row in chapterRows" :key="row.title">
            <button
              type="button"
              class="chapter__option"
              :class="{ 'chapter__option--active': chat.currentChapter === row.title }"
              :data-testid="`chapter-option-${row.title}`"
              :data-active="String(chat.currentChapter === row.title)"
              :disabled="chat.streaming || busy"
              @click="choose(row.title)"
            >
              <span v-if="row.num" class="chapter__num">{{ row.num }}</span>
              <span class="chapter__body">
                <span class="chapter__title">{{ row.name }}</span>
                <span class="chapter__meta">{{ row.meta }}</span>
              </span>
              <!-- 选中标记：**不只靠颜色**（描边 + 勾同时给） -->
              <span class="chapter__check">
                <Check v-if="chat.currentChapter === row.title" :size="13" />
              </span>
            </button>
          </li>
        </ul>
        <p v-else-if="!study.errors.chapters" class="chapter__note" data-testid="chapter-list-empty">
          这个学段还没有编入教材章节。
        </p>

        <!-- 「不限章节」永远可选：选了它 = 清空当前章节，回到自由问答。
             ★ 它**不是一章**：放在目录下面、用虚线隔开、并且不参与上面的章号对齐 ——
               混进目录里会成为「第 9 章 不限章节」，那是个假章节。 -->
        <button
          type="button"
          class="chapter__option chapter__option--none"
          data-testid="chapter-option-none"
          :data-active="String(chat.currentChapter === '')"
          :disabled="chat.streaming || busy"
          @click="choose('')"
        >
          <span class="chapter__none-ico" aria-hidden="true"></span>
          <span class="chapter__body">
            <span class="chapter__title">不限章节（自由问答）</span>
            <span class="chapter__meta">问到哪一章就讲哪一章，不优先某一章</span>
          </span>
          <span class="chapter__check">
            <Check v-if="chat.currentChapter === ''" :size="13" />
          </span>
        </button>
      </template>

      <p v-if="errorText" class="chapter__warn" data-testid="chapter-set-error">{{ errorText }}</p>
    </div>

    <!-- 章节被清空（学段变了）时的一次性提示 -->
    <p v-if="chat.chapterNotice" class="chapter__notice" data-testid="chapter-notice">
      {{ chat.chapterNotice }}
    </p>

    <!-- 章节通道缺失（主进程尚未接线）：说清原因，不让指示器沉默地停在「未选择章节」 -->
    <p v-if="chat.chapterBridgeError" class="chapter__warn" data-testid="chapter-indicator-note">
      {{ chat.chapterBridgeError }}
    </p>
  </div>
</template>

<style scoped>
/* ★ 不画底色、不画下边框：这一行是**桌面层**（与它并排的「本轮对话」同一层），
 *   分隔线属于外面那一行（`Chat.vue` 的 `.chat__bar`）。
 *   这里再铺一层白 / 再画一条线，就会与外层叠成「白条 + 双线」——
 *   那正是「元素错位」看起来的样子。
 * ★★ **不留内边距**（2026-09-22 报告 4.4）：它现在与「本轮对话」并排在同一条信息条里
 *   （`Chat.vue` 的 `.chat__bar`），横向留白与竖向节奏由那一行统一给 ——
 *   本组件自己再垫一层，就会让两半在同一条线上各带一份内边距（对不齐）。
 * 单行布局（badge + 触发器）在窄窗口下**不换行**：让章节名截断，而不是把行撑成两行。 */
.chapter {
  padding: 0;
}

.chapter__line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  min-width: 0;
  /* ★★ 首行高度钉成 32px：与同一条信息条里的图标开关（32px）**中心线对齐** ——
   *   内容居中，所以那两行字与两枚开关落在同一条线上。
   * ★ 它同时保证了「章节目录展开时这一行只往下长」：所在的 `.chat__bar` 是
   *   `align-items: flex-start`（见那边的说明），首行盒子不跟着目录一起挪。 */
  min-height: 32px;
}

/* ⚠️ 用 `inline-block` 而不是 `inline-flex`：里面是一整句可截断的章标题，
 *   而 `text-overflow` 只对**块容器里的行内内容**生效 —— 换成 flex，
 *   文字会被包成一个匿名 flex 项，截断只会硬切、不出省略号。 */
.chapter__badge {
  display: inline-block;
  min-width: 0;
  padding: 3px 10px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  border: 1px solid var(--k12-accent-border);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chapter__set {
  flex: none;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font: inherit;
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}

.chapter__set:hover:not(:disabled) {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}

.chapter__set:disabled {
  cursor: not-allowed;
  color: var(--k12-muted-2);
}

.chapter__picker {
  margin-top: 8px;
}

/* ★ 目录：**一列**，不是一堆换行的按钮。
 *   走查结论是一堆平铺按钮看不出「这是一本教材的目录」——目录的关键是
 *   章号在左、标题在右、上下对齐，扫一眼就知道自己在第几章。 */
.chapter__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-width: 560px;
}

.chapter__option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  /* 触控下限（自绘按钮，自己也要够高 —— 与 base.css 那条 28px 同一口径） */
  min-height: 28px;
  border: 1px solid transparent;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-fg-2);
  font: inherit;
  font-size: var(--k12-fs-caption);
  text-align: left;
  cursor: pointer;
}

.chapter__option:hover:not(:disabled) {
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}

.chapter__option:disabled {
  cursor: not-allowed;
  color: var(--k12-muted-2);
}

/* 章号：固定宽度，各行的标题因此**左边对齐**（不固定宽度的话
 * 「第1章」与「第10章」会让下面每一行各自错开一点，看起来像没排过版）。 */
.chapter__num {
  flex: none;
  width: 48px;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
}

.chapter__body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.chapter__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k12-fs-caption);
}

/* 一行说明：只用契约里真有的计数（知识点数 / 已掌握数），不编简介。
 * ⚠️ 用 `--k12-fs-xs`（13px）而不是 `--k12-fs-micro`（12px）：
 *    micro 那一档只给 ≤4 字的角标，而“3 个知识点”是要被读的说明文字。 */
.chapter__meta {
  flex: none;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  white-space: nowrap;
}

.chapter__check {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--k12-r-pill);
  color: var(--k12-accent-ink);
}

/* 当前生效的那一章：浅底 + 强调描边 + 勾（**不只靠颜色**） */
.chapter__option--active {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
  font-weight: 600;
}
.chapter__option--active .chapter__check {
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
}
.chapter__option--active .chapter__num {
  color: var(--k12-accent-ink);
}

/* 「不限章节」不是一章（见模板注释）：虚线隔开 + 这一行用同宽的空占位，
 * 让它的标题与上面各章的标题**左边对齐**（不对齐会看起来像另一份列表）。 */
.chapter__option--none {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--k12-border-strong);
  border-radius: 0;
}
.chapter__option--none:hover:not(:disabled) {
  border-radius: var(--k12-r-inset);
}
.chapter__none-ico {
  flex: none;
  width: 48px;
}

.chapter__note {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}

.chapter__notice {
  margin-top: 5px;
  font-size: var(--k12-fs-caption);
  color: var(--k12-good);
}

.chapter__warn {
  margin-top: 5px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-warn);
}
</style>
