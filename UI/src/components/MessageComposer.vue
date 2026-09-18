<script setup lang="ts">
/**
 * 输入条（Composer）。
 *
 * ⚠️ 这里**不发请求**：本原型不接 IPC。输入后只把文本回抛给父组件做本地演示。
 * 接线时的形状（冻结）：
 *   渲染进程 → IPC 白名单通道 → 主进程 → Pi Agent。
 *   `ChatSendRequest` **不带学段**（学段由服务端推断，§5.1）。
 *   流式来自 6 事件词表：delta / citation / payload / blocked / done / error。
 *
 * 布局改动：输入区在上、控件行在下（模型标识与发送键同一行）。原实现把「模型 chip」
 * 做成输入框右侧一个独立的 40px 高块，既占横向空间，又和输入框在视觉上分了家；
 * 说明性的键盘提示也没有落点。
 *
 * 附件按钮只保留语音一个且**置灰**：语音是本项目里真实规划过的 P2 能力，标注状态
 * 是有信息的；图片与附件则没有任何后端路由，留着就是纯假按钮。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Mic, ArrowUp, Cpu } from 'lucide-vue-next'
import { useModel } from '@/stores/model'

const props = withDefaults(
  defineProps<{
    /** 窄容器里用（悬浮追问窗）：隐去键位提示等次要元素 */
    compact?: boolean
  }>(),
  { compact: false }
)

const emit = defineEmits<{ (e: 'send', text: string): void }>()

const text = ref('')
/** 模型标识来自全局 store（不再是写死的字面量，也不再只读） */
const model = useModel()

const canSend = computed(() => text.value.trim().length > 0)

const inputRef = ref<HTMLTextAreaElement | null>(null)

/** 随内容长高（上限由 CSS max-height 兜住），否则多行输入只会在单行框里滚动 */
function autoGrow() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
onMounted(autoGrow)
watch(text, () => void nextTick(autoGrow))

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

/**
 * 供 ChatView 的空态调用：建议问题与「直接提问」入口都走这里。
 * 只**填进去**不直接发 —— 学生永远可以改完再发。
 */
function fill(value: string) {
  text.value = value
  void nextTick(() => {
    inputRef.value?.focus()
    const el = inputRef.value
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  })
}

function focus() {
  inputRef.value?.focus()
}

/**
 * 语音输入：项目把它列为 P2（后置），本期确无路由。
 * 但**不做成永远灰着的死按钮** —— 点一下给出解释，比让人怀疑"是不是坏了"诚实。
 */
const voiceNote = ref(false)
let voiceTimer: number | null = null
function explainVoice() {
  voiceNote.value = true
  if (voiceTimer !== null) clearTimeout(voiceTimer)
  voiceTimer = window.setTimeout(() => (voiceNote.value = false), 4000)
}

onBeforeUnmount(() => {
  if (voiceTimer !== null) clearTimeout(voiceTimer)
})

defineExpose({ fill, focus })
</script>

<template>
  <div class="cp" :class="{ 'cp--compact': props.compact }">
    <div class="cp__box">
      <textarea
        ref="inputRef"
        v-model="text"
        class="cp__input"
        rows="1"
        placeholder="问我任何问题，或直接说「用动画讲一下冒泡排序」"
        @keydown="onKeydown"
      />
      <div class="cp__row">
        <button
          type="button"
          class="cp__att"
          :title="voiceNote ? '' : '语音输入'"
          @click="explainVoice"
        >
          <Mic :size="15" />
        </button>
        <!-- 模型 chip：可点开切换。此前它是个不可点的 span，
             学生看到模型名却没有任何办法换掉它。 -->
        <button
          type="button"
          class="cp__model"
          :title="`当前模型：${model.current.modelId} —— 点这里更换`"
          @click="model.openPicker()"
        >
          <Cpu :size="12" />
          <span class="cp__model-name">{{ model.shortLabel }}</span>
        </button>
        <span v-if="!props.compact" class="cp__hint">Enter 发送 · Shift+Enter 换行</span>
        <button type="button" class="cp__send" :disabled="!canSend" title="发送" @click="send">
          <ArrowUp :size="16" />
        </button>
      </div>
      <p v-if="voiceNote" class="cp__voice-note">
        语音输入在项目里列为 P2（后置），本期没有接入。需要时可以先用系统的语音输入法，
        文字会正常进到输入框。
      </p>
    </div>
  </div>
</template>

<style scoped>
.cp {
  width: 100%;
  padding: 0 20px 16px;
}
/* 窄容器（悬浮追问窗）：键位提示会被挤掉，直接不显示；外边距也收紧 */
.cp--compact {
  padding: 0;
}
.cp__box {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 10px;
}
/* 聚焦：墨线出现 + 纸被"拿起来"一点。
 * 这是键盘用户与鼠标用户都能看见的"现在在这里"的提示。 */
.cp__box:focus-within {
  border-color: var(--k12-accent-ink);
  box-shadow:
    var(--k12-shadow-raise),
    0 0 0 3px color-mix(in srgb, var(--k12-accent) 12%, transparent);
}
.cp__input {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-family: inherit;
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg);
  max-height: 180px;
  overflow-y: auto;
}
.cp__input::placeholder {
  color: var(--k12-muted);
}

.cp__row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cp__voice-note {
  margin-top: 2px;
  padding: 8px 10px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.cp__att {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--k12-r-flat);
  background: transparent;
  color: var(--k12-muted-2);
  cursor: not-allowed;
}
/* 模型 chip 里的模型名：是**识别信息**（学生要读它），不是角标。
 * chip 的「记号感」由底色与圆角承担，不靠把字缩小一档。 */
.cp__model {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg-2);
  white-space: nowrap;
}
/* 键位提示（「Enter 发送 · Shift+Enter 换行」）：主路径提示，是 meta 档（12px） */
.cp__hint {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  white-space: nowrap;
}
.cp__send {
  width: 32px;
  height: 32px;
  flex: none;
  border: none;
  border-radius: var(--k12-r-control);
  background: var(--k12-accent);
  color: var(--k12-surface);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
@media (hover: hover) and (pointer: fine) {
.cp__send:hover:not(:disabled) {
  filter: brightness(1.06);
}
}
.cp__send:disabled {
  background: var(--k12-border-strong);
  cursor: not-allowed;
}
</style>
