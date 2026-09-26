<script setup lang="ts">
/**
 * 学习档案 · **历史会话**（搜索 + 只读回看）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是「只读回看」而不是「点开继续聊」
 * ---------------------------------------------------------------------------
 * 数据其实**一直在存**（Pi 每个会话写一个 JSONL），缺的一直是「能看见」。本页补上
 * 「列出来 + 搜一搜 + 打开看」，但**故意不做**「切到这个会话继续对话」：
 * 那要求 dispose 当前 runtime（否则 JSONL 半写）、把历史条目投影成前端的轮次、
 * 并处理「装配期间被 dispose」的代际竞态 —— 是另一件事（见
 * `architecture/pending/03-会话保存与恢复.md`）。把「看得见」和「接着聊」分开落地，
 * 比半途接管会话安全得多。
 *
 * ★ `readSessionTranscript` **只传会话 id**：主进程先与 Pi 列出的会话做白名单对齐，
 *   再用 Pi 给的 path 打开（渲染进程无法指定路径 —— 见 `main/study/sessions.ts`）。
 * ★ 回看里**只有你问的与助手答的文本**：模型的思考过程与工具调用参数不投影进来
 *   （那可能含题干与答案，且回看不需要）。
 */
import { computed, ref } from 'vue'
import { useStudyStore, type SessionTranscriptShape } from '../stores/study'
import { useChatStore } from '../stores/chat'
import { formatMs } from '../study/report-markdown'
import { displaySessionTitle } from '../study/session-title'
import MarkdownProse from '../components/MarkdownProse.vue'

defineOptions({ name: 'StudySessionsTab' })

const study = useStudyStore()
/** 回看历史时要借用它的「学生版译文」（见 `open()` 里的说明）。 */
const chat = useChatStore()

const openTranscript = ref<SessionTranscriptShape | null>(null)
const openId = ref<string | null>(null)
const loadingTranscript = ref(false)

/** 正在列出的那批：搜索时用命中结果，否则用全部会话。 */
const shown = computed(() => {
  if (study.searchHits) {
    return study.searchHits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      modifiedAt: hit.modifiedAt,
      snippet: hit.snippet,
      messageCount: null as number | null
    }))
  }
  return study.sessions.map((session) => ({
    id: session.id,
    title: session.title,
    modifiedAt: session.modifiedAt,
    snippet: session.preview,
    messageCount: session.messageCount as number | null
  }))
})

async function open(sessionId: string): Promise<void> {
  if (openId.value === sessionId) {
    // 再点一次 = 收起（省得学生找不到关闭的地方）
    openTranscript.value = null
    openId.value = null
    return
  }
  loadingTranscript.value = true
  openId.value = sessionId
  try {
    const transcript = await study.readTranscript(sessionId)
    // ★★ 回看的正文必须过一遍**学生版译文**（与对话页恢复会话同一条纪律）。
    //   主进程项目里的 `message.text` 是 JSONL 里的**wire 原文** —— 里面带着
    //   卡片写给模型的内部指令（「请用 submit_quiz 提交批改…」）与嵌着知识点 slug 的
    //   题目编号（`gen-ai-definition-jr-…`）。实时路径与对话页恢复都挡住了这两样，
    //   而**这一条路曾经漏着**：学生在档案页点开自己的历史会话，又能读到它们。
    //   翻译的唯一实现是 `stores/chat.ts` 的 `studentFacingUserText`（别再写第二份）。
    openTranscript.value =
      transcript === null
        ? null
        : {
            ...transcript,
            messages: transcript.messages.map((message) =>
              message.role === 'user'
                ? { ...message, text: chat.studentFacingUserText(message.text) }
                : message
            )
          }
  } finally {
    loadingTranscript.value = false
  }
}

function close(): void {
  openTranscript.value = null
  openId.value = null
}
</script>

<template>
  <section class="tab-body" data-testid="study-sessions">
    <div class="toolbar">
      <label class="sr-only" for="session-search">搜索历史会话</label>
      <input
        id="session-search"
        class="search"
        type="search"
        placeholder="搜索以前聊过的内容…"
        data-testid="session-search"
        :value="study.searchQuery"
        @input="study.search(($event.target as HTMLInputElement).value)"
      />
      <button class="btn" type="button" data-testid="sessions-reload" @click="study.loadSessions()">
        刷新
      </button>
    </div>

    <p v-if="study.sessionsLoading" class="state" data-testid="sessions-loading">
      正在读取历史会话…
    </p>
    <p v-else-if="study.sessionsError" class="state state--error" data-testid="sessions-error">
      {{ study.sessionsError }}
    </p>
    <p v-else-if="shown.length === 0" class="state" data-testid="sessions-empty">
      {{ study.searchHits ? '没有匹配的会话。' : '还没有历史会话，到对话页问第一个问题吧。' }}
    </p>

    <ul v-else class="list" data-testid="sessions-list">
      <li v-for="item in shown" :key="item.id" class="item" :data-session-id="item.id">
        <button
          class="item__head"
          type="button"
          :data-testid="`session-open-${item.id}`"
          @click="open(item.id)"
        >
          <!-- ★ P1-3：标题走**共享**兜底（`session-title.ts`）。此前这里直接渲染
               `item.title`，于是英文占位 `(no messages)` 在学习记录页露了出来
               （对话页左栏一直有兜底，两处判据分叉的结果）。 -->
          <span class="item__title">{{ displaySessionTitle(item.title) }}</span>
          <span v-if="item.messageCount !== null" class="item__meta">{{ item.messageCount }} 条消息</span>
          <span class="item__meta">{{ formatMs(item.modifiedAt) }}</span>
        </button>
        <p v-if="item.snippet" class="item__snippet">{{ item.snippet }}</p>

        <div v-if="openId === item.id" class="detail" :data-testid="`session-detail-${item.id}`">
          <p v-if="loadingTranscript" class="state">正在读取会话内容…</p>
          <template v-else-if="openTranscript">
            <p v-if="openTranscript.truncated > 0" class="detail__note">
              这个会话很长，只显示最近 {{ openTranscript.messages.length }} 条
              （另有 {{ openTranscript.truncated }} 条更早的内容未显示）。
            </p>
            <p v-if="openTranscript.messages.length === 0" class="state">
              这个会话里没有可显示的文字内容。
            </p>
            <ul v-else class="messages">
              <li
                v-for="(message, index) in openTranscript.messages"
                :key="index"
                class="message"
                :class="message.role === 'user' ? 'message--user' : 'message--assistant'"
              >
                <span class="message__role">{{ message.role === 'user' ? '我' : '助手' }}</span>
                <!-- ★★ P1-4：正文按与对话页**同一套** Markdown 渲染（共享组件）。
                     此前这里是 `{{ message.text }}`，于是学生展开历史会话时看到的是
                     `**贴着标签的盒子**` 与 ``` ```python ``` 围栏 —— 同一段话在对话页
                     是排版好的、在档案页是带星号的原文。 -->
                <MarkdownProse :text="message.text" class="message__text" />
              </li>
            </ul>
            <button class="btn btn--mini" type="button" @click="close()">收起</button>
          </template>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.tab-body {
  padding: 16px 24px 32px;
}

.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

/* 无障碍标签用的是**全局** `.sr-only`（定义在 `assets/base.css`）——
 * 这里不再自带一份：两份定义迟早分叉，而 CSS 分叉是静默的。 */

.search {
  flex: 1;
  padding: 6px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg);
  font-family: inherit;
  font-size: var(--k12-fs-sm);
}

.search::placeholder {
  color: var(--k12-muted-2);
}

/* 页面级操作按钮（刷新）：控件层统一 --k12-r-control。
 * ⚠️ 全局 .btn 已随旧 base.css 移除，本页自带一份。 */
.btn {
  padding: 5px 12px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

.btn--mini {
  padding: 3px 10px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* E2 卡片：白面 + 可见边框 + 浅投影 */
.item {
  padding: 10px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.item__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0;
}

.item__title {
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  color: var(--k12-fg);
}

.item__meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.item__snippet {
  margin-top: 5px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

/* 回看内容 = 卡片内的嵌入块（E3）：surface-2 底 + 一档圆角。
 * ⚠️ 原来的「虚线分隔 + 白底」在白卡里读不出层次，card 套 card 是同一类病。 */
.detail {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}

.detail__note {
  margin-bottom: 8px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted-2);
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow: auto;
  margin-bottom: 8px;
}

.message {
  display: flex;
  gap: 8px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
}

.message__role {
  flex-shrink: 0;
  width: 32px;
  font-weight: 600;
  color: var(--k12-muted-2);
}

/* 正文渲染器（`MarkdownProse`）按 `inherit` 取字号与字色，这里只给两处配色差
 * （学生原话用前景色、助手回答用次级色）—— 与对话页的 `.message--user/assistant` 同口径。 */
.message--user .message__text {
  flex: 1;
  min-width: 0;
  color: var(--k12-fg);
}

.message--assistant .message__text {
  flex: 1;
  min-width: 0;
  color: var(--k12-fg-2);
}

.state {
  padding: 10px 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.state--error {
  color: var(--k12-warn);
  line-height: var(--k12-lh-body);
}
</style>
