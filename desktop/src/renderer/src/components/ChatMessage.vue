<script setup lang="ts">
/**
 * 一轮对话的呈现：一条学生消息 + 它对应的助手回答（同一个 `requestId`）。
 *
 * 6 事件在这里各自找到位置：
 *   `delta`   → 正文实时增长（`assistant-text`）
 *   `citation`→ 来源行（`SourceChips`）+「教材原文」抽屉（点开看节级全文）
 *   `payload` → 内联卡片（`InlineCard`：动画 / 编程 / 练习三种）
 *   `blocked` → 正文已被替换成安全提示 + 撤回说明（`BlockedNotice`）
 *   `done`    → 状态不再是角标（`showsStatusChip`：内容出现就是完成）
 *   `error`   → 可读的降级提示（`DegradedNotice`）
 *
 * ★ 每条回答都标出**这一轮用的学段**（`turn.gradeLevel`）：这个值来自系统对学段的
 *   判定（D-037：默认自动，学生也可手动指定），标出来是为了让「同一道题换个年级问，
 *   回答不一样」看得见。还没判出学段时该徽章不显示（宁可不标，也不标一个假的）。
 *
 * ── 视觉：把「节奏」还给对话流 ────────────────────────────────────────────
 * 学生气泡是重点（右侧、surface-2 底 + accent 竖线），回答是**纸面上的正文**
 * （白底卡片、无重描边）。引用只是「依据」，整体降一档（12px，灰竖线）。
 * AI 头像属于 chrome（它是「谁在说」的标记，不是内容），所以保持浅底小尺寸。
 *
 * ★ 「教材原文」抽屉从 `api/events.ts` 的 `citationDetails` 取 —— 那里面是
 *   Python 一直就在返回、之前被投影丢掉的那几个字段（节级正文 / 相关度 / 父块 id）。
 *   取不到时按钮显示「原文暂时取不到」，而不是点下去毫无反应。
 *
 * ── ★★ 视角分层（学生 / 教师，2026-09-20）────────────────────────────────
 *   ① `消息 pi-message:<uuid>`（内部 id）、抽屉里的「检索方式 `vector`」「父块 chunk-id」
 *      —— 全是排障字段，学生看不懂 → 进 `<TeacherGate>`；
 *   ② 「回答完成」角标不再渲染（`showsStatusChip`：内容已经出现在屏幕上就是完成信号）；
 *   ③ 「从这里重新问」原本是一条**常显在主流程里的链接**：学生会误点、读起来像 Git 概念。
 *      现在收进一个 `⋯` 小菜单，文案改成学生的话「换个思路再问」——
 *      点击链路（`emit('branch')` → 页面确认框）**一字未改**。
 */
import { computed, ref } from 'vue'
import { BookMarked, ChevronRight, Ellipsis, GitBranch, X } from 'lucide-vue-next'
import type { ChatTurn } from '../api/events'
import type { CitationDetail } from '@shared/ipc-events'
import { GRADE_LABELS, TURN_STATUS_LABELS, showsStatusChip } from '../labels'
import { DEFAULT_LOGO_URL } from '../brand-logo'
import { useDismissable } from '../composables/useDismissable'
import { useEscape } from '../composables/useEscape'
import { useFocusReturn } from '../composables/useFocusReturn'
import InlineCard from '../cards/InlineCard.vue'
import ProgressCard from '../cards/ProgressCard.vue'
import MarkdownProse from './MarkdownProse.vue'
import BlockedNotice from './BlockedNotice.vue'
import DegradedNotice from './DegradedNotice.vue'
import SourceChips from './SourceChips.vue'
import TeacherGate from './TeacherGate.vue'

const props = defineProps<{
  turn: ChatTurn
  /** 取某个引用的详情（来自 `stores/chat.ts` 的 `citationDetailOf`）。 */
  detailOf?: (chunkId: string) => CitationDetail | null
  /** 分叉进行中（界面据此禁用按钮 + 显示「正在准备…」）。 */
  branching?: boolean
}>()

/**
 * ★★ 「从这里重新问」——把分叉点交给上层（`Chat.vue` → `chat.branchSession`）。
 *
 * ★ 组件**自己不调 store**：消息组件只负责「哪条消息被点了」，
 *   「分叉之后界面怎么变」是 store 与页面的责任（与 `MessageComposer` 把文字
 *   交给 `@send` 同一条纪律：组件不持有会话状态）。
 * ★ 事件带的是**条目 id**（不是「第几轮」）：编号会漂，id 不会
 *   （见 `main/study/sessions.ts` 的 `TranscriptMessage.entryId` 注释）。
 */
const emit = defineEmits<{ (event: 'branch', entryId: string): void }>()

/**
 * 这一轮能不能当分叉点。
 *
 * ★ 判据是「状态已终结 **且** 有助手那条回答的条目 id」：
 *   - `streaming` 时不给（如上：分支点不该是半句话）；
 *   - `entryId` 为空时不给（老会话 / 手改过的文件里认不出条目）。
 */
const branchable = computed(() => {
  if (props.turn.status === 'streaming') return false
  if (!props.turn.entryId) return false
  return true
})

function emitBranch(): void {
  const id = props.turn.entryId
  if (id) emit('branch', id)
}

const streaming = computed(() => props.turn.status === 'streaming')
const statusLabel = computed(() => TURN_STATUS_LABELS[props.turn.status])
/**
 * 要不要显示状态角标。
 *
 * ★ 判据收口在 `labels.showsStatusChip()`（`done` 不显示）——**不要**在这里写
 *   `!== 'done'`：那个条件还有别的消费方（导出 / 卡片），各写一份迟早漏一处，
 *   表现是「有的地方还挂着『回答完成』」。
 * ★ 角标元素与 `:data-status`（挂在 `<article>` 上）都保留：`data-status` 是
 *   体检脚本判「正在流式 / 已结束」的稳定锚点，与角标显不显示是两件事。
 */
const showStatus = computed(() => showsStatusChip(props.turn.status))
const gradeLabel = computed(() => (props.turn.gradeLevel ? GRADE_LABELS[props.turn.gradeLevel] : null))

/**
 * 正文按**极简 Markdown** 渲染（`components/MarkdownProse.vue` → `../markdown.ts` 的纯函数，
 * 输出结构化数据、不用 `v-html`）。
 *
 * ★ 不这么做的实测后果：模型输出 `**循环**，就是……`，而模板此前是 `{{ turn.text }}`，
 *   于是小学生读到的是**带星号的句子**。星号不是格式问题，是「把解析负担推给学生」。
 * ★ 渲染实现已**归口**到 `MarkdownProse`（P1-4）：历史会话只读回看曾经自己插值，
 *   同一段话在两处长不一样。本文件只负责「哪一段要渲染、生成中要不要光标」。
 */

/** 回答还没吐出任何字时的占位说明（不是空白气泡）。 */
const awaiting = computed(() => streaming.value && props.turn.text.trim().length === 0)

/**
 * 教材原文抽屉（二级界面）。
 *
 * ★ 引用行此前是**不可点的 div** —— 学生看到「教材依据：一、从原始数据到特征」
 *   却看不到那句话到底出自哪里（`text` / `score` / `parentChunkId` 本来就在返回里）。
 */
const sourceOpen = ref<string | null>(null)
/**
 * 引用折叠行的开合态（原生 `<details>` 的变化同步过来）。
 *
 * ★ 为什么同步一份：结构化探针锚点量的是「引用默认收起」这条**行为**
 *   （`data-probe-expanded`，见 `scripts/probe-lib.mjs`）—— 原生 `open` 属性在 DOM 上
 *   也能读，但探针自检的接口要求一个**稳定的数据属性**（不依赖属性是布尔还是字符串）。
 */
const citationOpen = ref(false)
function onCitationToggle(event: Event): void {
  citationOpen.value = (event.target as HTMLDetailsElement).open
}
const activeSource = computed<CitationDetail | null>(() =>
  sourceOpen.value === null ? null : (props.detailOf?.(sourceOpen.value) ?? null)
)

/**
 * 抽屉标题下那一行副标题的来源：**从本轮的引用行里按 chunkId 找回来**。
 *
 * ★ 原先那里显示的是 `chunk:<uuid>`（切片 id）—— 学生视角里它比「检索方式 vector」
 *   更难懂。同一份信息（这一条出自哪一章哪一节）在 `turn.citations` 里本来就有
 *   （那一行同时给了 `chapterTitle` / `sectionTitle`），只是原始对象 `activeSource`
 *   不带它。所以这里按 id 反查一次，把**人话**填进副标题。
 * ★ 找不到就不显示（不编一个「未知章节」）。
 */
const activeCitation = computed(() => {
  const id = sourceOpen.value
  if (id === null) return null
  return props.turn.citations.find((citation) => citation.chunkId === id) ?? null
})

useEscape(
  () => {
    sourceOpen.value = null
  },
  () => sourceOpen.value !== null
)

/**
 * 焦点契约（打开移入 → Tab 层内循环 → 关闭归还触发元素）。
 *
 * ★ 这一层已经是 `role="dialog" aria-modal="true"`，**只差焦点**（实测缺口）：
 *   此前只有上面那个 `useEscape` —— 打开后 Tab 会一路跑到遮罩**后面**的按钮上
 *   （读屏用户按自己的方式关掉它之后，还得从头 Tab 回去，且中途可能误触到别处）。
 * ★ 初焦点交给 composable 的默认规则（面板里第一个可聚焦元素 = 关闭键）：
 *   这一层没有「危险默认」，无需像确认对话框那样指定初始目标。
 */
const drawerRef = ref<HTMLElement | null>(null)
useFocusReturn(drawerRef, () => sourceOpen.value !== null)

/* ── 引用行：摘录（把「数据库查询结果」读成「一本书的条目」）─────────────────
 * ★ 走查结论原话：编号列表重复着「第3章 核心技术分支 + 原文」，像一次 SQL 的结果集。
 *   学生要的是「这句话出自哪儿、大概说了什么」——
 *   所以每一条引用补一行**节级正文的摘录**（`CitationDetail.text` 本来就在手里，
 *   只是此前只有点开抽屉才看得到）。
 * ★ 摘录**只做截断**，不做摘要、不改写：改一个字的教材正文都会让「原文」按钮撒谎。
 * ★ 详情还没到位时（事件里没带 details）整行不渲染 —— 不编一句更像样的假原文。
 */
const EXCERPT_MAX_CHARS = 58

function excerptOf(chunkId: string): string {
  const detail = props.detailOf?.(chunkId) ?? null
  const text = detail === null ? '' : detail.text.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return ''
  return text.length > EXCERPT_MAX_CHARS ? `${text.slice(0, EXCERPT_MAX_CHARS)}…` : text
}

/**
 * 引用行 + 它自己的摘录（**一次算好**，模板里不再两处各调一次 `excerptOf`）。
 *
 * ★ 条数与顺序**严格跟随 `turn.citations`**：`[data-testid="citation-sources"] li`
 *   的条数被体检脚本用来判「引用真的渲染出来了没」，一条都不能少。
 */
const sourceRows = computed(() =>
  props.turn.citations.map((citation) => ({
    citation,
    excerpt: excerptOf(citation.chunkId)
  }))
)

/**
 * 这一张卡片旁边要不要跟一张**独立的闯关进度卡**（报告 §2.3：进度/掌握度独立成卡，
 * 不嵌进题卡）。
 *
 * ★ 判据只读「载荷里有没有 `levels` 数组」，**不在前端推导任何关卡状态** ——
 *   状态机在后端（`routes/quiz.py` 的 `apply_level_progress`），前端只读。
 * ★ 出题载荷（还没作答）与判分结果载荷都可能带 `levels`：前者是初始进度，
 *   后者是「进度变了」的那一份 —— 谁带就跟着谁渲染，两条路径一个规则。
 */
function hasLevels(card: { payload?: unknown }): boolean {
  const payload = card.payload
  if (typeof payload !== 'object' || payload === null) return false
  return Array.isArray((payload as { levels?: unknown }).levels)
}

/**
 * 这一轮里有没有**跨学段向上兼容**取用的条目。
 *
 * ★ 它决定收起那一行要不要挂「向上兼容」角标。收起是默认态，而执行文档 §6.4 与
 *   `docs/业务陷阱清单.md` §2 要求跨学段取用必须**显式标注** —— 标注不能因为默认收起
 *   就从学生眼前消失（展开后每一条仍有自己的 `citation-compat`，那回答的是「哪一条」）。
 */
const hasCompat = computed(() => props.turn.citations.some((citation) => citation.compat))

/* ── 分叉点：收进 `⋯` 小菜单 ───────────────────────────────────────────────
 * ★ 为什么不再是一条常显的链接：它挂在**每条回答**下面，学生划着读的时候
 *   很容易误点到（一点就会换一条会话线），而且「从这里重新问」读起来像 Git 的
 *   分支概念，不像一句人话。收进 `⋯` 之后：默认只有一个安静的小圆点菜单，
 *   展开才看到「换个思路再问」。
 * ★ 浮层必须有键盘出口与「点外部关掉」：用 `useDismissable`（全站唯一实现，
 *   见 `composables/useDismissable.ts` 里那段「为什么 Esc 与点外部要写在一起」）。
 */
const branchMenuOpen = ref(false)
const branchBoxRef = ref<HTMLElement | null>(null)
useDismissable({
  panel: branchBoxRef,
  open: () => branchMenuOpen.value,
  close: () => {
    branchMenuOpen.value = false
  }
})

/** 点了菜单里的那一项：收起菜单，再把分叉点交给上层（**链路与从前完全一样**）。 */
function pickBranch(): void {
  branchMenuOpen.value = false
  emitBranch()
}
</script>

<template>
  <article class="turn" :data-status="turn.status" data-testid="chat-turn">
    <!-- 学生消息：右侧气泡 + 轮次时间戳（时间锚点让「隔了多久」一眼可见）
         ★★ **没有学生文字就不渲染这一块**：恢复出来的「开场白」是**助手**先说的那条
           （`restoreConversation` 会给它单独一轮，`userText` 是空串），无条件渲染会在
           问候语上方挂出一个**空气泡** —— 实测截图里就是它。
           判据是「这一轮有没有学生的话」，不是「这条消息是谁发的」：轮次里
           assistant 那半永远有正文，user 那半可以合理地空着（开场白 / 上一轮失败）。 -->
    <div v-if="turn.userText" class="turn__user" data-testid="user-message">
      <p class="bubble">{{ turn.userText }}</p>
    </div>

    <!-- 助手回答：头像 + 正文纸面 + 引用 + 卡片 -->
    <div class="turn__ai">
      <!-- 「智团团」的头像：用品牌 logo（与侧栏、空态同一张）。
           ★ 这里**不跟学段换图** —— 头像标的是「谁在说」，不是「按哪个年级讲」；
             同一个说话人每条回答换一副面孔是反直觉的。
             学段换图只在侧栏品牌标那一处（见 `brand-logo.ts`）。 -->
      <img
        class="avatar"
        :src="DEFAULT_LOGO_URL"
        :alt="''"
        aria-hidden="true"
        draggable="false"
      />

      <div class="ai-col">
        <div class="meta">
          <span class="who">智团团</span>
          <span
            v-if="gradeLabel"
            class="chip chip--accent"
            data-testid="turn-grade"
            :data-grade="turn.gradeLevel"
          >
            {{ gradeLabel }}
          </span>
          <!-- 状态角标：`done` 不再渲染（内容出现就是完成），其余三态保留。
               `data-testid="turn-status"` 与 `:data-status` 都留着 —— 体检脚本按它们量状态。 -->
          <span
            v-if="showStatus"
            class="chip"
            :class="streaming ? 'chip--accent' : 'chip--ok'"
            data-testid="turn-status"
          >
            {{ statusLabel }}
          </span>
          <!-- 内部消息 id（`pi-message:<uuid>`）是排障字段，学生视角下不出现。
               ★ `v-if` 放在 gate 上而不是里面的 chip 上：空元素在 flex 行里也会占一个
                 `gap`（`.meta` 的 8px），虽然看不见却会把后面的东西推一下。 -->
          <TeacherGate v-if="turn.messageId">
            <span class="chip chip--quiet">消息 {{ turn.messageId }}</span>
          </TeacherGate>
        </div>

        <!-- 正文（delta 逐字累积，按极简 Markdown 渲染成结构化节点）。为空且还在流式时给一句「正在查教材」而不是空白。 -->
        <div class="answer" data-testid="assistant-message">
          <p v-if="awaiting" class="awaiting">
            正在查教材、组织讲法…
          </p>
          <div v-else class="text" data-testid="assistant-text">
            <!-- ★★ 正文渲染归口 `MarkdownProse`（唯一实现，P1-4）：历史会话只读回看曾经
                 各自插值 `{{ text }}`，于是同一段话在档案页露出 `**粗体**` 与代码围栏。
                 模板与样式都搬去了那个组件，两处再也不会漂移。 -->
            <MarkdownProse :text="turn.text" :streaming="streaming" />
          </div>

          <!-- 引用：**默认收起**，点这一行才展开（用户 2026-09-26 的设计裁决）。
               ★★ 为什么用原生 <details>/<summary> 而不是自己写「按钮 + aria-expanded + v-if」：
                  · 展开/收起语义、键盘 Tab + Enter、读屏播报全部自带 —— 本项目在
                    `views/Dependency.vue` 的折叠组上已经定过这条（「自己写手风琴就必然有人漏掉一条」）；
                  · 收起时内层是**真的不渲染**（不是裁剪宽度）—— `tests/panel-collapse.test.ts`
                    记过这一类缺陷：被裁剪的元素仍有矩形，体检脚本会把看不见的东西量成「学生能点的目标」。
               ★★ 为什么默认收起：一次检索常常回来 3～5 条，每条是「小节 + 出处 + 摘录」三行，
                  实测一次插入 376～663px，学生要读的正文被压到屏幕下方。收起来之后这行只占一行，
                  想知道「具体参考了哪些地方」的学生点一下就有 —— 信息一条没删。
               ★ 列表本身与既有锚点一个字没改（`citation-sources` 的 `li` 条数被体检脚本用来
                 判「引用真的渲染出来了没」），只是搬进了折叠体里。 -->
          <details
            v-if="turn.citations.length > 0"
            class="cites"
            data-testid="citation-disclosure"
            data-probe-id="citation-disclosure"
            :data-probe-expanded="citationOpen ? 'true' : 'false'"
            @toggle="onCitationToggle"
          >
            <summary class="cites__toggle k12-tap">
              <span class="cites__label">这段话参考了这些地方 · {{ turn.citations.length }} 段</span>
              <!-- 跨学段取用必须**显式标注**（§6.4 / 陷阱清单 §2）：收起态也要看得见，
                   展开后每条自己的角标回答的是「哪一条」。 -->
              <span v-if="hasCompat" class="cites__compat" data-testid="citation-compat-summary">向上兼容</span>
              <ChevronRight :size="13" class="cites__ico" aria-hidden="true" />
            </summary>
            <div class="cites__body">
              <SourceChips :citations="turn.citations" />
              <ul class="srcs" data-testid="citation-sources">
                <li v-for="(row, index) in sourceRows" :key="row.citation.chunkId">
                  <button
                    type="button"
                    class="srcs__btn"
                    :title="`查看教材原文：${row.citation.sectionTitle}`"
                    @click="sourceOpen = row.citation.chunkId"
                  >
                    <span class="srcs__num k12-num">{{ index + 1 }}</span>
                    <span class="srcs__text">
                      <span class="srcs__title">{{ row.citation.sectionTitle }}</span>
                      <span class="srcs__path">出自 {{ row.citation.chapterTitle }}</span>
                      <span v-if="row.excerpt" class="srcs__excerpt">{{ row.excerpt }}</span>
                    </span>
                    <span class="srcs__more">原文</span>
                  </button>
                </li>
              </ul>
            </div>
          </details>
        </div>

        <!-- 内联卡片组：与正文分离（先给依据、再给互动）。
             ★★ 闯关进度卡**由这一层独立渲染**（报告 §2.3：进度卡从练习卡内移出）——
                练习卡只管题目/作答，进度/掌握度是另一块内容，不该把题卡拉长。 -->
        <div v-if="turn.cards.length > 0" class="cards" data-testid="inline-cards">
          <template v-for="card in turn.cards" :key="card.id">
            <InlineCard :card="card" />
            <ProgressCard
              v-if="hasLevels(card)"
              data-probe-id="progress-detached"
              :payload="card.payload"
            />
          </template>
        </div>

        <BlockedNotice v-if="turn.blocked" :notice="turn.blocked" />
        <DegradedNotice v-if="turn.error" :notice="turn.error" />

        <!-- ── 分叉点：换个思路再问 ────────────────────────────────────────
             ★ 只在**这一轮已经结束**时出现：流式途中点它，学生拿到的是一段
               没写完的回答当分支点（他不会想要那个）。
             ★ 只在**真的有条目 id** 时出现（`branchable`）：老会话 / 认不出条目
               的历史消息没有分叉点 —— 宁可不给按钮，也不要给一个点了就报错的。
             ★★ 呈现方式（2026-09-20 走查）：它原来是一条**常显的链接**，
                挂在每条回答下面 —— 学生划着读时容易误点（一点就换会话线），
                而且「从这里重新问」读起来像 Git 概念。现在收进 `⋯` 菜单：
                默认只是一个安静的小圆点，展开才看到「换个思路再问」这句话。
                ★★ `data-testid="branch-restart"` **留在那个常显的 `⋯` 触发器上**
                   （不是菜单项）：`ux-audit.mjs` 的 D7/D9 是拿它**数 + 量**的 ——
                   「每条有回答的轮次旁都有可点入口」，而挂在菜单项上的话，
                   菜单没展开时它在 DOM 里根本不存在（D7 会假红）。
                   真正的动作是菜单项（`branch-restart-action`），点击链路一字未改。 -->
        <div v-if="branchable" ref="branchBoxRef" class="branch" data-testid="turn-branch">
          <button
            type="button"
            class="branch__more"
            data-testid="branch-restart"
            :aria-expanded="branchMenuOpen"
            aria-haspopup="menu"
            aria-label="换个思路再问"
            title="换个思路再问"
            :disabled="branching"
            @click="branchMenuOpen = !branchMenuOpen"
          >
            <Ellipsis :size="15" />
          </button>
          <div v-if="branchMenuOpen" class="branch__menu" role="menu">
            <button
              type="button"
              class="branch__item"
              role="menuitem"
              data-testid="branch-restart-action"
              title="保留这段对话，另开一条从这里接着问（原来的不会被改动）"
              :disabled="branching"
              @click="pickBranch()"
            >
              <GitBranch :size="13" />
              <span>换个思路再问</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 教材原文抽屉 ────────────────────────────────────────────────── -->
    <Teleport to="body">
      <div
        v-if="sourceOpen !== null"
        ref="drawerRef"
        class="src"
        role="dialog"
        aria-modal="true"
        data-testid="source-drawer"
        @click.self="sourceOpen = null"
      >
        <aside class="src__panel">
          <header class="src__head">
            <BookMarked :size="16" />
            <div class="src__head-text">
              <p class="src__title">
                {{ activeSource && activeSource.text ? '教材原文' : '原文暂时取不到' }}
              </p>
              <!-- 学生视角：这里是「出自哪一章哪一节」这句人话（此前是 `chunk:<uuid>`） -->
              <p v-if="activeCitation" class="src__sub">
                {{ activeCitation.chapterTitle }} · {{ activeCitation.sectionTitle }}
              </p>
              <!-- 内部切片 id 只在教师视角里出现（排障要按它去库里捞） -->
              <TeacherGate>
                <p class="src__sub"><code>{{ sourceOpen }}</code></p>
              </TeacherGate>
            </div>
            <button type="button" class="src__close" title="关闭" @click="sourceOpen = null">
              <X :size="16" />
            </button>
          </header>

          <div class="src__body">
            <!-- 纯文本渲染，**不解析 Markdown**：只为这一处引入 Markdown 库不划算，
                 所以教材正文的约定是「不带标记」（强调用「」）。 -->
            <p v-if="activeSource && activeSource.text" class="src__text">{{ activeSource.text }}</p>
            <p v-else class="src__missing">
              这一条引用的原文没有随事件送达（可能是本地服务版本较旧）。
              你可以直接按上面那句话去问智团团。
            </p>
          </div>

          <!-- ★★ 抽屉底部只有**相关度**是学生看得懂的（「这句话跟问题有多贴」）；
               「检索方式 vector」「来源（依赖图扩展补充）」「父块 chunk-id」都是排障字段
               → 整块进教师视角。
               ⚠️ 相关度对**还没拿到细节**的情形显示「—」（不补 0）。 -->
          <footer v-if="activeSource" class="src__foot">
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="相关度">
                {{ activeSource.score != null ? activeSource.score.toFixed(2) : '—' }}
              </el-descriptions-item>
            </el-descriptions>
            <TeacherGate label="检索细节">
              <el-descriptions :column="1" size="small" border>
                <el-descriptions-item label="检索方式">
                  <el-tag size="small" effect="plain">{{ activeSource.degraded ?? 'vector' }}</el-tag>
                </el-descriptions-item>
                <el-descriptions-item label="来源">
                  {{ activeSource.expanded ? '依赖图扩展补充' : '直接命中' }}
                </el-descriptions-item>
                <el-descriptions-item label="父块">
                  <code class="src__mono">{{ activeSource.parentChunkId ?? '—' }}</code>
                </el-descriptions-item>
                <el-descriptions-item label="切片 id">
                  <code class="src__mono">{{ activeSource.chunkId }}</code>
                </el-descriptions-item>
              </el-descriptions>
            </TeacherGate>
          </footer>
        </aside>
      </div>
    </Teleport>
  </article>
</template>

<style scoped>
.turn {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap-msg);
}

/* ── 学生消息 ── */
.turn__user {
  display: flex;
  justify-content: flex-end;
}
.bubble {
  max-width: min(560px, 78%);
  padding: 10px 14px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  /* 右侧一道墨线代替满块着色：位置说明「这是我说的」，颜色不必喊。
   * 全页**只有这一处**用 accent 竖线 —— 引用行让位（见 .srcs__btn）。 */
  border-right: 3px solid var(--k12-accent);
  color: var(--k12-fg);
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-ui);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 助手回答 ── */
.turn__ai {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
/* 头像属于 chrome（「谁在说」的标记，不是内容）：小尺寸、不带色块底。
 * ★ 换成真图后**去掉了原来的 accent-soft 底** —— logo 自带透明通道，
 *   垫色底会在边缘露一圈不属于它的颜色（且四个学段的 accent 各不相同）。
 * ★ `object-fit: contain`：素材是 256×256 方形插画，`cover` 会切掉耳朵。 */
.avatar {
  width: 28px;
  height: 28px;
  object-fit: contain;
  flex: none;
  user-select: none;
}
.ai-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap-block);
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.who {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
}
.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--k12-r-pill);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  background: var(--k12-surface-2);
  color: var(--k12-muted);
}
.chip--accent {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.chip--ok {
  background: color-mix(in srgb, var(--k12-good) 14%, transparent);
  color: var(--k12-good);
}
.chip--quiet {
  font-weight: 500;
  color: var(--k12-muted-2);
}

/* 回答 = 纸面上的正文（**无重描边**：层次靠底色与留白，不靠描边） */
.answer {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap-block);
  padding: 16px 18px;
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
}
/* ★★ 正文的排版（标题 / 列表 / 代码块 / 光标）已随渲染实现一起搬到
 * `MarkdownProse.vue`（P1-4：实现与样式必须同组件，否则又会分叉）。
 * 本文件只给**对话气泡自己的**那几条：字号档与字色（共享组件按 `inherit` 取）。 */
.text {
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  word-break: break-word;
}
/* 检索中：一句话说明当前在做什么（刻意不用三点脉冲 —— 那是 AI 味最重的 loader） */
.awaiting {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--k12-accent);
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

/* ── 引用：默认收起的一行摘要 + 折叠体 ───────────────────────────────────
 * 摘要行**本身就是开关**（原生 `<summary>`）：这里只给它一个「可点」的样子，
 * 高度由设计系统的 `.k12-tap` 兜底（28px）—— 不再在页面里写死尺寸。 */
.cites {
  display: block;
}
.cites__toggle {
  padding: 2px 8px 2px 4px;
  border-radius: var(--k12-r-control);
  /* 去掉浏览器默认那个三角：我们自己给箭头（收起与展开只差一个旋转）。 */
  list-style: none;
  cursor: pointer;
}
.cites__toggle::-webkit-details-marker {
  display: none;
}
@media (hover: hover) and (pointer: fine) {
  .cites__toggle:hover {
    background: var(--k12-surface-2);
  }
}
.cites__label {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
}
/* 「向上兼容」角标：与 `SourceChips` 里那条**同一套令牌**（同一件事在收起态与展开态
 * 不能长成两个样子）。4 字角标 → micro 档，不是正文。 */
.cites__compat {
  padding: 0 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
  color: var(--k12-warn);
  font-size: var(--k12-fs-label);
  font-weight: 500;
}
.cites__ico {
  flex: none;
  color: var(--k12-muted-2);
  transition: transform var(--k12-dur-state) var(--k12-ease-state);
}
.cites[open] .cites__ico {
  transform: rotate(90deg);
}
/* 减动效偏好：这是一个纯装饰的旋转，直接关掉（信息由箭头方向本身表达）。 */
@media (prefers-reduced-motion: reduce) {
  :root:not([data-k12-reduced-motion='off']) .cites__ico {
    transition: none;
  }
}
.cites__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.srcs {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* 引用行是 <button>（可点开原文），所以要把浏览器默认按钮样式清干净。
 * 竖线用中性色，**不用 accent**：引用是「依据」不是重点（accent 留给学生气泡）。 */
.srcs__btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 11px;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  border: none;
  border-left: 2px solid var(--k12-border-strong);
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
}
@media (hover: hover) and (pointer: fine) {
  .srcs__btn:hover {
    background: var(--k12-accent-soft);
    border-left-color: var(--k12-accent);
  }
}
.srcs__num {
  /* 24px（原 22）：里面是 12px 的序号。序号角标本身不放大（它是记号不是内容），
   * 但盒子要留得住字号 —— 写死 22px 时字号一抬就会把数字顶到边上。 */
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  /* 角标档：这是 1、2 这样的**序号**（≤4 字），正是 `--k12-fs-micro` 的用途 */
  font-size: var(--k12-fs-label);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.srcs__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.srcs__title {
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srcs__path {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
/* 摘录：正文的**同族**（它是教材里那句话本身），所以比元信息实一档，
 * 但比回答正文小一档 —— 引用整体是「依据」，不跟回答抢注意力。 */
.srcs__excerpt {
  margin-top: 2px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srcs__more {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
}
@media (hover: hover) and (pointer: fine) {
  .srcs__btn:hover .srcs__more {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}

.cards {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap);
}

/* ── 教材原文抽屉 ── */
.src {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--k12-fg) 30%, transparent);
}
.src__panel {
  width: min(520px, 94vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--k12-surface);
  border-left: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-float);
}
.src__head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--k12-border);
  color: var(--k12-muted);
}
.src__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.src__title {
  font-size: var(--k12-fs-body-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.src__sub code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
/* 副标题在两种视角下共用一个类：学生看到的是「第3章 · 核心技术分支」，
 * 教师看到的是等宽的 `chunk:<uuid>` —— 所以字号/颜色共用，等宽字体只给 `code`。 */
.src__sub {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.src__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
.src__close:hover {
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
}
.src__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
}
/* 原文用较大的行高：它是要被**读**的段落，不是 UI 文案 */
.src__text {
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  white-space: pre-wrap;
}
.src__missing {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.src__foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 18px;
  border-top: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
}
.src__mono {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  color: var(--k12-accent-ink);
  word-break: break-all;
}
/* ── 分叉点（换个思路再问）─────────────────────────────────────────────────
 * 它是**每条回答的附属动作**，不是主干控件：常态只是一个安静的小圆点，
 * 悬停才明显 —— 免得整页回答下面挂一排按钮把阅读节奏打散，
 * 也免得学生划着读的时候**误点**（一点就会换一条会话线）。
 * ★ 尺寸走 28px 见方（UX 体检 C1 的触控下限）—— 它虽小，但学生真会点。 */
.branch {
  position: relative;
  display: flex;
  margin-top: 6px;
}
.branch__more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  min-height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .branch__more:hover:not(:disabled) {
    border-color: var(--k12-border-strong);
    background: var(--k12-surface-2);
    color: var(--k12-accent-ink);
  }
}
.branch__more:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 展开后的小菜单：**向左对齐触发器、向下展开**（它在阅读栏左缘，
 * 向右展开会伸进正文里把字压住）。 */
.branch__menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 5;
  min-width: 156px;
  padding: 4px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-float);
}
.branch__item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 5px 9px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .branch__item:hover:not(:disabled) {
    background: var(--k12-accent-soft);
    color: var(--k12-accent-ink);
  }
}
.branch__item:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
