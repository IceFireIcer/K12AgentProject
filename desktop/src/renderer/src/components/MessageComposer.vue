<script setup lang="ts">
/**
 * 输入框：Enter 发送、Shift+Enter 换行。
 *
 * ★ 只做「把文字交给上层」，不自己碰 IPC —— 发送链路是
 *   组件 → `stores/chat.ts` → `window.api.sendChat()`（preload 白名单）。
 */
import { computed, ref } from 'vue'

const props = defineProps<{ streaming: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()

const draft = ref('')
const canSend = computed(() => draft.value.trim().length > 0 && !props.streaming)

function submit(): void {
  if (!canSend.value) return
  const text = draft.value
  draft.value = ''
  emit('send', text)
}

function onKeydown(event: KeyboardEvent): void {
  // 中文输入法组词期间不要抢 Enter
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <label class="sr-only" for="composer-input">输入你的问题</label>
    <textarea
      id="composer-input"
      v-model="draft"
      class="composer__input"
      data-testid="composer-input"
      rows="2"
      placeholder="把你的问题打在这里，例如：人工智能是怎么认出一只猫的？"
      :disabled="streaming"
      @keydown="onKeydown"
    ></textarea>
    <div class="composer__side">
      <button class="btn btn--primary" type="submit" data-testid="composer-send" :disabled="!canSend">
        {{ streaming ? '回答中…' : '发送' }}
      </button>
      <p class="composer__hint">Enter 发送 · Shift+Enter 换行</p>
    </div>
  </form>
</template>

<style scoped>
/* 外层容器（Chat.vue 的 `.chat__composer`）提供边框、底色与上下留白 */
.composer {
  display: flex;
  gap: 12px;
  align-items: flex-end;
}

.composer__input {
  flex: 1;
  resize: none;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--surface-muted);
  font: inherit;
  line-height: 1.7;
  color: var(--text);
  max-height: 140px;
}

.composer__input:focus {
  outline: 2px solid rgba(47, 111, 208, 0.35);
  outline-offset: 1px;
  background: var(--surface);
}

.composer__input:disabled {
  opacity: 0.6;
}

.composer__side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.composer__hint {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}
</style>
