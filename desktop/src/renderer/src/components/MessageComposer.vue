<script setup lang="ts">
/**
 * 输入条（Composer）：Enter 发送、Shift+Enter 换行。
 *
 * ★ 只做「把文字交给上层」，**不自己碰 IPC**：
 *   发送链路是 组件 → `ChatView` → `stores/chat.ts` → `window.api.sendChat()`
 *   （preload 白名单）。守卫 G7 断言 `window.api.sendChat(` 只出现在 store 里 ——
 *   组件里直接调它会让「发送」这件事出现第二条路径。
 *
 * ★ 草稿**存在 store 里**（`chat.draft`）而不是组件本地：
 *   学习档案的「去练一练」要往这个输入框里预填一句提问，而它在另一个视图的另一个组件里
 *   （见 `stores/chat.ts` 的 `prepareQuestion`）。
 *   这里 `v-model` 直接绑 store 的那个 ref —— 组件卸载 / 视图切换时草稿也不丢，
 *   与 `<KeepAlive>` 保住的其它本地状态同一条思路。
 *
 * ★ `streaming` 不再由 props 传：它本来就是**全局对话状态**（在 store 里），
 *   从 props 传进来会让「谁负责把它传对」成为一个每个调用点都要记得的问题。
 *   现在组件自己读 store —— 悬浮追问窗（`FloatPanel`）也因此不必再传它。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ArrowUp, Cpu, Mic } from 'lucide-vue-next'
import { useChatStore } from '../stores/chat'
import { useModelStore } from '../stores/model'

const props = withDefaults(
  defineProps<{
    /** 窄容器里用（悬浮追问窗）：隐去键位提示等次要元素。 */
    compact?: boolean
  }>(),
  { compact: false }
)

const emit = defineEmits<{ (e: 'send', text: string): void }>()

const chat = useChatStore()
const model = useModelStore()

/** 草稿直接绑 store（见文件头的理由）。 */
const draft = computed({
  get: () => chat.draft,
  set: (value: string) => {
    chat.draft = value
  }
})

/** 回答中不许再发：一轮没走完就发第二条会让两轮事件交织在同一个气泡里。 */
const busy = computed(() => chat.streaming)
const canSend = computed(() => draft.value.trim().length > 0 && !busy.value)

const inputRef = ref<HTMLTextAreaElement | null>(null)

/** 随内容长高（上限由 CSS `max-height` 兜住），否则多行输入只会在单行框里滚动。 */
function autoGrow(): void {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
onMounted(autoGrow)
watch(draft, () => void nextTick(autoGrow))

function submit(): void {
  if (!canSend.value) return
  const text = draft.value.trim()
  draft.value = ''
  void nextTick(autoGrow)
  emit('send', text)
}

/** Enter 发送、Shift+Enter 换行；中文输入法组词期间不抢 Enter。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

/**
 * 供上层预填（空态的建议问题、`chat.draft` 的「去练一练」交接）。
 * ★ 只**填进去**不直接发 —— 学生永远可以改完再发。
 */
function fill(value: string): void {
  draft.value = value
  void nextTick(() => {
    const el = inputRef.value
    if (el === null) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

function focus(): void {
  inputRef.value?.focus()
}

/**
 * 语音输入：项目把它列为 P2（后置），本期确无路由。
 * 但**不做成永远灰着的死按钮** —— 点一下给出解释，比让人怀疑「是不是坏了」诚实。
 */
const voiceNote = ref(false)
let voiceTimer: number | null = null
function explainVoice(): void {
  voiceNote.value = true
  if (voiceTimer !== null) window.clearTimeout(voiceTimer)
  voiceTimer = window.setTimeout(() => (voiceNote.value = false), 4000)
}
onUnmounted(() => {
  if (voiceTimer !== null) window.clearTimeout(voiceTimer)
})

defineExpose({ fill, focus })
</script>

<template>
  <div class="cp" :class="{ 'cp--compact': props.compact }">
    <div class="cp__box">
      <label class="sr-only" for="composer-input">输入你的问题</label>
      <textarea
        id="composer-input"
        ref="inputRef"
        v-model="draft"
        class="cp__input"
        data-testid="composer-input"
        rows="1"
        placeholder="问我任何问题，或直接说「用动画讲一下冒泡排序」"
        @keydown="onKeydown"
      ></textarea>

      <div class="cp__row">
        <button type="button" class="cp__att" :title="voiceNote ? '' : '语音输入'" @click="explainVoice">
          <Mic :size="15" />
        </button>

        <!-- 模型 chip：可点开切换（此前它是个不可点的 span，学生看到模型名却换不掉） -->
        <button
          type="button"
          class="cp__model"
          data-testid="composer-model"
          :title="`当前模型：${model.label} —— 点这里更换`"
          @click="model.openPicker()"
        >
          <Cpu :size="12" />
          <span class="cp__model-name">{{ model.shortLabel }}</span>
        </button>

        <span v-if="!props.compact" class="cp__hint">Enter 发送 · Shift+Enter 换行</span>

        <button
          type="button"
          class="cp__send"
          data-testid="composer-send"
          :disabled="!canSend"
          :title="busy ? '正在回答…' : '发送'"
          @click="submit"
        >
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
/* 聚焦：墨线出现 + 纸被「拿起来」一点。键盘与鼠标用户都能看见「现在在这里」。 */
.cp__box:focus-within {
  border-color: var(--k12-accent-ink);
  box-shadow:
    var(--k12-shadow-float),
    0 0 0 3px var(--k12-accent-ring);
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
  /* 28px（原 26）：与 `.cp__send` 同一档触控目标。
   * 它俩在输入条上并排 —— 一个大一个小会让整行看着是歪的。 */
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--k12-r-flat);
  background: transparent;
  color: var(--k12-muted-2);
  cursor: pointer;
}
.cp__att:hover {
  color: var(--k12-muted);
}
/* 模型 chip 里的模型名是**识别信息**（学生要读它），不是角标：
 * 「记号感」由底色与圆角承担，不靠把字缩小一档。 */
.cp__model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* ★ 高度不再写死（原 22px）：里面是 13px 等宽字 + 上下内边距，
   *   22px 是按旧字号（12px）定的 —— 字号一抬，固定高度就会把字**裁掉一半**。
   *   改成由内边距撑开，字号再变也不会裁字。 */
  padding: 4px 8px;
  border: none;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  line-height: var(--k12-lh-tight);
  color: var(--k12-fg-2);
  white-space: nowrap;
  cursor: pointer;
  max-width: 220px;
}
.cp__model:hover {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.cp__model-name {
  overflow: hidden;
  text-overflow: ellipsis;
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
