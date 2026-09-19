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
 * 所以它挂在对话页的消息区上方（`views/Chat.vue` 的 `.chat__indicators` 行），
 * 且顶栏**不再**渲染学段以外的那一枚（同一件事出现两次就是「界面错位」本身）。
 * ★ 分隔线由**外面那一行**（`.chat__indicators`）画：两个组件各自再画一条就会叠成双线。
 *   所以本组件自己不画下边框（页面用法需要时由所在容器决定）。
 *
 * 显示的三种状态：
 *   - 还没判定出学段（`chat.currentGrade === null`）：给一句可读提示，**不列空列表**
 *     （章节按学段分，学段未知列不出任何东西）；
 *   - 清单读取中 / 读失败：各说各的（复用档案页那套 `loading.chapters` / `errors.chapters`）；
 *   - 正常：当前学段的章节按钮 + 「不限章节（自由问答）」。
 *
 * 选章**不会改变学段**（两件事各自独立）——设置页那条入口把这句话写在界面上。
 */
import { computed, ref, watch } from 'vue'
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
const chapters = computed(() => study.chapters?.chapters ?? [])
const determined = computed(() => chat.currentGrade !== null)
const unavailable = computed(() => !determined.value)

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

    <!-- 选项默认收起：点上面的按钮才展开（当前学段的章 + 不限章节） -->
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

        <ul v-if="chapters.length > 0" class="chapter__list" data-testid="chapter-list">
          <li v-for="chapter in chapters" :key="chapter.chapterTitle">
            <button
              type="button"
              class="chapter__option"
              :class="{ 'chapter__option--active': chat.currentChapter === chapter.chapterTitle }"
              :data-testid="`chapter-option-${chapter.chapterTitle}`"
              :data-active="String(chat.currentChapter === chapter.chapterTitle)"
              :disabled="chat.streaming || busy"
              @click="choose(chapter.chapterTitle)"
            >
              {{ chapter.chapterTitle }}
            </button>
          </li>
        </ul>
        <p v-else-if="!study.errors.chapters" class="chapter__note" data-testid="chapter-list-empty">
          这个学段还没有编入教材章节。
        </p>

        <!-- 「不限章节」永远可选：选了它 = 清空当前章节，回到自由问答 -->
        <button
          type="button"
          class="chapter__option chapter__option--none"
          data-testid="chapter-option-none"
          :data-active="String(chat.currentChapter === '')"
          :disabled="chat.streaming || busy"
          @click="choose('')"
        >
          不限章节（自由问答）
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
/* ★ 不画底色、不画下边框：这一行是**桌面层**（与下面的会话工具条同层），
 *   分隔线属于外面那一行（`Chat.vue` 的 `.chat__indicators`）。
 *   这里再铺一层白 / 再画一条线，就会与外层叠成「白条 + 双线」——
 *   那正是「元素错位」看起来的样子。
 * 单行布局（badge + 触发器）在窄窗口下**不换行**：让章节名截断，而不是把行撑成两行。 */
.chapter {
  padding: 7px 24px 8px;
}

.chapter__line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  min-width: 0;
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
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

.chapter__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.chapter__option {
  padding: 3px 12px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font: inherit;
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}

.chapter__option:hover:not(:disabled) {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}

.chapter__option:disabled {
  cursor: not-allowed;
  color: var(--k12-muted-2);
}

/* 「不限章节」跟章按钮分开一点：它不是一章，是「不限定」 */
.chapter__option--none {
  margin-top: 8px;
}

/* 当前生效的那一章：与 `.chapter__badge` 同一视觉语言（选中 = 强调色） */
.chapter__option--active {
  border-color: var(--k12-accent-border);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-weight: 600;
}

.chapter__note {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.chapter__notice {
  margin-top: 5px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-good);
}

.chapter__warn {
  margin-top: 5px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-warn);
}
</style>
