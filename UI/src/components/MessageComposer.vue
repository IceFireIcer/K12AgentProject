<script setup lang="ts">
/**
 * 输入条（Composer）。
 *
 * ⚠️ 这里**不发请求**：本原型不接 IPC。输入后只把文本回抛给父组件做本地演示。
 * 接线时的形状（冻结）：
 *   渲染进程 → IPC 白名单通道 → 主进程 → Pi Agent。
 *   `ChatSendRequest` **不带学段**（学段由服务端推断，§5.1）。
 *   流式来自 6 事件词表：delta / citation / payload / blocked / done / error。
 */
import { computed, ref } from 'vue'
import { Paperclip, Mic, Image as ImageIcon, Sparkles, ArrowUp } from 'lucide-vue-next'

const emit = defineEmits<{ (e: 'send', text: string): void }>()

const text = ref('')
/** 模型标识（设计稿右下角 chip） */
const modelLabel = 'deepseek-chat'

const canSend = computed(() => text.value.trim().length > 0)

function send() {
  if (!canSend.value) return
  emit('send', text.value.trim())
  text.value = ''
}

/** Enter 发送，Shift+Enter 换行 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="cp">
    <div class="cp__box">
      <Sparkles :size="15" class="cp__spark" />
      <textarea
        v-model="text"
        class="cp__input"
        rows="1"
        placeholder="问我任何问题，或直接说「用动画讲一下冒泡排序」…"
        @keydown="onKeydown"
      />
      <div class="cp__atts">
        <button type="button" class="cp__att" title="语音（P2 后置）"><Mic :size="15" /></button>
        <button type="button" class="cp__att" title="图片"><ImageIcon :size="15" /></button>
        <button type="button" class="cp__att" title="附件"><Paperclip :size="15" /></button>
      </div>
      <button type="button" class="cp__send" :disabled="!canSend" @click="send" title="发送">
        <ArrowUp :size="14" />
      </button>
    </div>
    <span class="cp__model">{{ modelLabel }}</span>
  </div>
</template>

<style scoped>
.cp {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 4px 20px 14px;
}
.cp__box {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
  transition: border-color 0.16s ease;
}
.cp__box:focus-within {
  border-color: var(--k12-accent-border);
}
.cp__spark {
  color: var(--k12-accent);
  flex: none;
}
.cp__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-family: inherit;
  font-size: var(--k12-fs-md);
  line-height: 1.5;
  color: var(--k12-fg);
  max-height: 96px;
}
.cp__input::placeholder {
  color: var(--k12-muted-2);
}
.cp__atts {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.cp__att {
  border: none;
  background: transparent;
  color: var(--k12-muted-2);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--k12-r-sm);
  display: inline-flex;
}
.cp__att:hover {
  color: var(--k12-fg-2);
  background: var(--k12-surface-2);
}
.cp__send {
  width: 28px;
  height: 28px;
  flex: none;
  border: none;
  border-radius: var(--k12-r-lg);
  background: linear-gradient(135deg, var(--k12-accent) 0%, var(--k12-accent-2) 100%);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cp__send:disabled {
  background: var(--k12-border-strong);
  cursor: not-allowed;
}
.cp__model {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 40px;
  padding: 0 11px;
  border-radius: var(--k12-r-xl);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-tiny);
  font-weight: 600;
  color: var(--k12-muted);
}
</style>
