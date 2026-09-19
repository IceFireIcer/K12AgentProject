<script setup lang="ts">
/**
 * 一轮对话的呈现：一条学生消息 + 它对应的助手回答（同一个 `requestId`）。
 *
 * 6 事件在这里各自找到位置：
 *   `delta`   → 正文实时增长（`assistant-text`）
 *   `citation`→ 来源行（`SourceChips`）+「教材原文」抽屉（点开看节级全文）
 *   `payload` → 内联卡片（`InlineCard`：动画 / 编程 / 练习三种）
 *   `blocked` → 正文已被替换成安全提示 + 撤回说明（`BlockedNotice`）
 *   `done`    → 状态变成「回答完成」
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
 */
import { computed, ref } from 'vue'
import { BookMarked, X } from 'lucide-vue-next'
import type { ChatTurn } from '../api/events'
import type { CitationDetail } from '@shared/ipc-events'
import { GRADE_LABELS, TURN_STATUS_LABELS } from '../labels'
import { DEFAULT_LOGO_URL } from '../brand-logo'
import { parseMarkdown } from '../markdown'
import { useEscape } from '../composables/useEscape'
import InlineCard from '../cards/InlineCard.vue'
import BlockedNotice from './BlockedNotice.vue'
import DegradedNotice from './DegradedNotice.vue'
import SourceChips from './SourceChips.vue'

const props = defineProps<{
  turn: ChatTurn
  /** 取某个引用的详情（来自 `stores/chat.ts` 的 `citationDetailOf`）。 */
  detailOf?: (chunkId: string) => CitationDetail | null
}>()

const streaming = computed(() => props.turn.status === 'streaming')
const statusLabel = computed(() => TURN_STATUS_LABELS[props.turn.status])
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

useEscape(
  () => {
    sourceOpen.value = null
  },
  () => sourceOpen.value !== null
)
</script>

<template>
  <article class="turn" :data-status="turn.status" data-testid="chat-turn">
    <!-- 学生消息：右侧气泡 + 轮次时间戳（时间锚点让「隔了多久」一眼可见） -->
    <div class="turn__user" data-testid="user-message">
      <p class="bubble">{{ turn.userText }}</p>
    </div>

    <!-- 助手回答：头像 + 正文纸面 + 引用 + 卡片 -->
    <div class="turn__ai">
      <!-- 「团团」的头像：用品牌 logo（与侧栏、空态同一张）。
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
          <span class="who">团团</span>
          <span
            v-if="gradeLabel"
            class="chip chip--accent"
            data-testid="turn-grade"
            :data-grade="turn.gradeLevel"
          >
            {{ gradeLabel }}
          </span>
          <span
            class="chip"
            :class="streaming ? 'chip--accent' : 'chip--ok'"
            data-testid="turn-status"
          >
            {{ statusLabel }}
          </span>
          <span v-if="turn.messageId" class="chip chip--quiet">消息 {{ turn.messageId }}</span>
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

          <!-- 引用：既有 chips（沿用既有契约），也可点开原文 -->
          <div v-if="turn.citations.length > 0" class="cites">
            <p class="cites__label">教材依据</p>
            <SourceChips :citations="turn.citations" />
            <ul class="srcs" data-testid="citation-sources">
              <li v-for="(citation, index) in turn.citations" :key="citation.chunkId">
                <button
                  type="button"
                  class="srcs__btn"
                  :title="`查看教材原文：${citation.sectionTitle}`"
                  @click="sourceOpen = citation.chunkId"
                >
                  <span class="srcs__num k12-num">{{ index + 1 }}</span>
                  <span class="srcs__text">
                    <span class="srcs__title">{{ citation.sectionTitle }}</span>
                    <span class="srcs__path">{{ citation.chapterTitle }}</span>
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
      </div>
    </div>

    <!-- ── 教材原文抽屉 ────────────────────────────────────────────────── -->
    <Teleport to="body">
      <div
        v-if="sourceOpen !== null"
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
              <p class="src__sub"><code>{{ sourceOpen }}</code></p>
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
              你可以直接按上面那句话去问团团。
            </p>
          </div>

          <footer v-if="activeSource" class="src__foot">
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="相关度">
                {{ activeSource.score != null ? activeSource.score.toFixed(2) : '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="检索方式">
                <el-tag size="small" effect="plain">{{ activeSource.degraded ?? 'vector' }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="来源">
                {{ activeSource.expanded ? '依赖图扩展补充' : '直接命中' }}
              </el-descriptions-item>
              <el-descriptions-item label="父块">
                <code class="src__mono">{{ activeSource.parentChunkId ?? '—' }}</code>
              </el-descriptions-item>
            </el-descriptions>
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
</style>
