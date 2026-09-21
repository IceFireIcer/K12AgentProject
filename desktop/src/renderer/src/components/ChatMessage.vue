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
import { BookMarked, Ellipsis, GitBranch, X } from 'lucide-vue-next'
import type { ChatTurn } from '../api/events'
import type { CitationDetail } from '@shared/ipc-events'
import { GRADE_LABELS, TURN_STATUS_LABELS, showsStatusChip } from '../labels'
import { DEFAULT_LOGO_URL } from '../brand-logo'
import { parseMarkdown } from '../markdown'
import { useDismissable } from '../composables/useDismissable'
import { useEscape } from '../composables/useEscape'
import { useFocusReturn } from '../composables/useFocusReturn'
import InlineCard from '../cards/InlineCard.vue'
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
 * 正文按**极简 Markdown** 渲染（`../markdown.ts` 的纯函数，输出结构化数据、不用 v-html）。
 *
 * ★ 不这么做的实测后果：模型输出 `**循环**，就是……`，而模板此前是 `{{ turn.text }}`，
 *   于是小学生读到的是**带星号的句子**。星号不是格式问题，是「把解析负担推给学生」。
 * ★ 流式期间也照常解析：模型是逐字吐的，`**` 可能只到一半 ——
 *   `parseInline` 对未闭合的星号**原样保留**，所以不会出现「字忽然消失再出现」的闪动。
 */
const blocks = computed(() => parseMarkdown(props.turn.text))

/** 回答还没吐出任何字时的占位说明（不是空白气泡）。 */
const awaiting = computed(() => streaming.value && props.turn.text.trim().length === 0)

/**
 * 教材原文抽屉（二级界面）。
 *
 * ★ 引用行此前是**不可点的 div** —— 学生看到「教材依据：一、从原始数据到特征」
 *   却看不到那句话到底出自哪里（`text` / `score` / `parentChunkId` 本来就在返回里）。
 */
const sourceOpen = ref<string | null>(null)
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
    <!-- 学生消息：右侧气泡 + 轮次时间戳（时间锚点让「隔了多久」一眼可见） -->
    <div class="turn__user" data-testid="user-message">
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
            <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
              <pre v-if="block.kind === 'code'" class="md-code"><code>{{ block.runs[0]?.text ?? '' }}</code></pre>
              <hr v-else-if="block.kind === 'divider'" class="md-hr" />
              <p
                v-else-if="block.kind === 'heading'"
                class="md-heading"
                :class="`md-heading--${block.level ?? 3}`"
              >
                <template v-for="(run, runIndex) in block.runs" :key="runIndex">
                  <strong v-if="run.kind === 'strong'">{{ run.text }}</strong>
                  <code v-else-if="run.kind === 'code'">{{ run.text }}</code>
                  <template v-else>{{ run.text }}</template>
                </template>
              </p>
              <ul v-else-if="block.kind === 'list' && block.ordinal === undefined" class="md-list">
                <li>
                  <template v-for="(run, runIndex) in block.runs" :key="runIndex">
                    <strong v-if="run.kind === 'strong'">{{ run.text }}</strong>
                    <code v-else-if="run.kind === 'code'">{{ run.text }}</code>
                    <template v-else>{{ run.text }}</template>
                  </template>
                </li>
              </ul>
              <ol v-else-if="block.kind === 'list'" class="md-list" :start="block.ordinal">
                <li>
                  <template v-for="(run, runIndex) in block.runs" :key="runIndex">
                    <strong v-if="run.kind === 'strong'">{{ run.text }}</strong>
                    <code v-else-if="run.kind === 'code'">{{ run.text }}</code>
                    <template v-else>{{ run.text }}</template>
                  </template>
                </li>
              </ol>
              <p v-else class="md-p">
                <template v-for="(run, runIndex) in block.runs" :key="runIndex">
                  <strong v-if="run.kind === 'strong'">{{ run.text }}</strong>
                  <code v-else-if="run.kind === 'code'">{{ run.text }}</code>
                  <template v-else>{{ run.text }}</template>
                </template>
              </p>
            </template>
            <span v-if="streaming" class="caret" aria-hidden="true" />
          </div>

          <!-- 引用：既有 chips（沿用既有契约），也可点开原文。
               ★ 列表本身保留（`citation-sources` 的 `li` 条数被体检脚本用来判「引用渲染出来了没」），
                 但排版从「编号 + 两行元信息」改成**一条书目**：
                 小节标题是主行、章节是它的出处、再补一行节级摘录 —— 读起来是
                 「这句话出自《第 3 章 · 核心技术分支》」，而不是一次查询的结果集。 -->
          <div v-if="turn.citations.length > 0" class="cites">
            <p class="cites__label">这段话参考了这些地方</p>
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
        </div>

        <!-- 内联卡片组：与正文分离（先给依据、再给互动） -->
        <div v-if="turn.cards.length > 0" class="cards" data-testid="inline-cards">
          <InlineCard v-for="card in turn.cards" :key="card.id" :card="card" />
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
  font-size: var(--k12-fs-md);
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
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
}
.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--k12-r-pill);
  font-size: var(--k12-fs-xs);
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
.text {
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  /* ★ 不再用 `white-space: pre-wrap` 承载换行 —— 换行现在由 Markdown 的**
     分段**表达（`parseMarkdown` 按空行切块）。留着 pre-wrap 会让「每行一个
     `<p>`」与「源文本里的换行」叠成双倍行距。 */
  word-break: break-word;
}
.text > * + * {
  margin-top: 0.7em;
}
.text strong {
  color: var(--k12-fg);
  font-weight: 650;
}
.text code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  font-family: var(--k12-font-mono);
  font-size: 0.92em;
}
.md-heading {
  color: var(--k12-fg);
  font-weight: 650;
  line-height: 1.4;
}
.md-heading--1 {
  font-size: var(--k12-fs-lg);
}
.md-heading--2 {
  font-size: var(--k12-fs-title);
}
.md-heading--3 {
  font-size: var(--k12-fs-md);
}
.md-list {
  margin: 0;
  padding-left: 1.35em;
  display: flex;
  flex-direction: column;
  gap: 0.35em;
}
.md-list li::marker {
  color: var(--k12-muted);
}
.md-code {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  overflow-x: auto;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-sm);
  line-height: 1.6;
}
.md-hr {
  margin: 0;
  border: 0;
  border-top: 1px solid var(--k12-border);
}
/* 检索中：一句话说明当前在做什么（刻意不用三点脉冲 —— 那是 AI 味最重的 loader） */
.awaiting {
  font-size: var(--k12-fs-xs);
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

/* ── 引用 ── */
.cites {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cites__label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
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
  font-size: var(--k12-fs-micro);
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
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srcs__path {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
/* 摘录：正文的**同族**（它是教材里那句话本身），所以比元信息实一档，
 * 但比回答正文小一档 —— 引用整体是「依据」，不跟回答抢注意力。 */
.srcs__excerpt {
  margin-top: 2px;
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.src__sub code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
/* 副标题在两种视角下共用一个类：学生看到的是「第3章 · 核心技术分支」，
 * 教师看到的是等宽的 `chunk:<uuid>` —— 所以字号/颜色共用，等宽字体只给 `code`。 */
.src__sub {
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  white-space: pre-wrap;
}
.src__missing {
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
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
