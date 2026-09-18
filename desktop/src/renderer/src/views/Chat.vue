<script setup lang="ts">
/**
 * 对话视图（对话优先布局的主界面，执行文档 §11.1）。
 *
 * 大对话区 + 底部输入框；所有内容都来自 `stores/chat.ts`（它订阅 IPC 6 事件流）。
 * 新消息贴底滚动 —— 流式回答时正文会不断变长，这里用「轮次数 + 末尾正文长度」作为触发点。
 *
 * ★ 顶部常驻**学段只读指示器**：学段由系统从对话里判定，学生改不了，
 *   指示器只把「当前按哪个年级讲」显示出来（判定变化时给一句提示）。
 * ★ 紧跟着**章节指示器**（`ChapterIndicator`）：学段下面紧接着「这一章学到哪儿了」，
 *   学生选的章节是一份**软偏好**（回答与检索优先围绕它），同样可以随时改。
 */
import { nextTick, ref, watch } from 'vue'
import ChatMessage from '../components/ChatMessage.vue'
import ChapterIndicator from '../components/ChapterIndicator.vue'
import GradeIndicator from '../components/GradeIndicator.vue'
import MessageComposer from '../components/MessageComposer.vue'
import { useChatStore } from '../stores/chat'

const chat = useChatStore()
const logEl = ref<HTMLElement | null>(null)

/** 学生可以点的示例问题（点一下直接发送，省去打字）。 */
const starterQuestions = [
  '人工智能是怎么认出一只猫的？',
  '什么是神经网络？',
  '帮我出两道题练一练'
]

watch(
  () => {
    const last = chat.turns[chat.turns.length - 1]
    return `${chat.turns.length}:${last ? last.text.length : 0}:${last ? last.cards.length : 0}`
  },
  async () => {
    await nextTick()
    const el = logEl.value
    if (el) el.scrollTop = el.scrollHeight
  }
)

function onSend(text: string): void {
  void chat.send(text)
}
</script>

<template>
  <section class="chat" data-testid="chat-area">
    <GradeIndicator />
    <ChapterIndicator />

    <div ref="logEl" class="chat__log" data-testid="chat-log">
      <div class="shell">
        <div v-if="chat.turns.length === 0" class="empty" data-testid="chat-empty">
          <h2 class="empty__title">想问点什么？</h2>
          <p class="empty__text">
            我是你的 AI 通识课老师。可以问我概念、让我用动画讲一遍，也可以出几道题练练手。
          </p>
          <ul class="empty__list">
            <li v-for="question in starterQuestions" :key="question">
              <button
                class="btn"
                type="button"
                data-testid="starter-question"
                :disabled="chat.streaming"
                @click="onSend(question)"
              >
                {{ question }}
              </button>
            </li>
          </ul>
        </div>

        <ChatMessage v-for="turn in chat.turns" :key="turn.requestId" :turn="turn" />
      </div>
    </div>

    <div class="chat__composer">
      <div class="shell shell--composer">
        <MessageComposer :streaming="chat.streaming" @send="onSend" />
        <p v-if="chat.localNotice" class="notice" data-testid="local-notice">{{ chat.localNotice }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.chat__log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.shell {
  max-width: 920px;
  margin: 0 auto;
  padding: 8px 24px 24px;
}

.shell--composer {
  padding: 0 24px 4px;
}

.chat__composer {
  border-top: 1px solid var(--border);
  background: var(--surface);
  padding: 12px 0 14px;
}

.empty {
  padding: 40px 4px 24px;
}

.empty__title {
  font-size: 22px;
  font-weight: 650;
}

.empty__text {
  margin-top: 8px;
  font-size: 14px;
  color: var(--text-muted);
  max-width: 640px;
}

.empty__list {
  list-style: none;
  margin: 20px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.notice {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--danger);
}
</style>
