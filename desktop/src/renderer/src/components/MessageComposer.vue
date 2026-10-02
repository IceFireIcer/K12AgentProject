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
import { useSettingsStore } from '../stores/settings'
import { useViewModeStore } from '../stores/viewMode'
import { llmChipTitle } from '../labels'

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
const settings = useSettingsStore()
const viewMode = useViewModeStore()

/**
 * 模型 chip 的 title（**三态 + 随视角变**，唯一实现在 `labels.ts` 的 `llmChipTitle`）。
 *
 * ★ 三态：读取中 / **还没配置模型** / 当前模型。中间那一档是 2026-09-22 补的
 *   （实测缺陷）：chip 此前直接显示服务端默认的模型名，于是首次安装、没填 Key 时
 *   界面上也写着 `deepseek-v4-flash` —— 看起来像「配好了」，而第一句话会直接失败。
 * ★ 学生视角下弹层是只读的（换模型是老师 / 评委的事，见 `ModelPicker.vue`）——
 *   那时还写「点这里更换」就是在承诺一件做不到的事：学生点开只会看到一个
 *   没有可点项的清单，然后开始怀疑是不是自己点错了（一个**界面撒谎**的缺陷，
 *   与「按钮文案指向下一个视图」那条纪律同类）。
 */
const modelChipTitle = computed(() => llmChipTitle(settings.snapshot?.llm, viewMode.isTeacher))

/** 草稿直接绑 store（见文件头的理由）。 */
const draft = computed({
  get: () => chat.draft,
  set: (value: string) => {
    chat.draft = value
  }
})

/**
 * 回答中「不许再发」的理由是**事件会交织**（两轮 delta 混进同一个气泡）——
 * 这条理由仍然成立，所以不放开并发。
 *
 * ★ 但「不许发」不等于「按了没反应」（UX 体检抓到的缺陷）：
 *   忙的时候 `submit()` 现在走**排队**（`stores/chat.ts` 的 `queuedText`），
 *   于是 `canSend` 的语义从「能不能发」拆成两条：
 *     - {@link hasText}：有没有内容可提交（决定按钮是否可点 / Enter 是否接管）；
 *     - {@link busy}：忙不忙（决定提交后是「立刻发」还是「排队」，由 store 判定）。
 *   旧写法把 `!busy` 并进 `canSend` 并让 `submit()` 直接 return ——
 *   学生按了回车却什么都没发生，只会以为键盘坏了（`scripts/ux-probe-busy-send.mjs` 实测）。
 */
const busy = computed(() => chat.streaming)
const hasText = computed(() => draft.value.trim().length > 0)
/** 有内容就能提交（忙时进队列）—— 按钮的可点状态与 Enter 的接管条件都用它。 */
const canSend = computed(() => hasText.value)

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
  // 忙的时候**不要**在这里清空/清空由 store 负责（它要在排队成功后才清 draft，
  // 并且清的是同一个 draft —— 两边都清会重复触发 autoGrow，也会让「排队失败」时字丢了）。
  if (!busy.value) {
    draft.value = ''
    void nextTick(autoGrow)
  }
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

        <!-- 模型 chip：可点开看当前模型（此前它是个不可点的 span，学生看到模型名却换不掉）
             ★ title 随视角变：学生视角下弹层只读，写「点这里更换」就是在承诺做不到的事。 -->
        <button
          type="button"
          class="cp__model"
          data-testid="composer-model"
          :title="modelChipTitle"
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

      <!-- ★★ 学生话（P2-4 复查）：原来写的是「语音输入在项目里列为 P2（后置），本期没有接入」——
           「P2」「后置」「本期」都是**内部项目管理语言**，一个 10 岁学生读到只会以为界面坏了。
           改成「这个按钮现在还不能用 + 你能怎么办」，技术口径（为什么后置）不进学生面。
           ⚠️ 不提「语音助手」：那是**教材里的知识点**（第五章 5.2.2），与这个麦克风按钮不是一回事，
              在这里并排出现反而制造「说好的功能没了」那种误读（P2-4 的原始形态）。 -->
      <p v-if="voiceNote" class="cp__voice-note">
        这个按钮现在还不能用。想用嘴说、让电脑帮你打字的话，可以用系统自带的语音输入法，
        文字会照常进到输入框里。
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
  /* 静息线走 strong 档：输入条是这一屏里**唯一可以打字**的地方，
   * 它的边界要在一眼扫过时就认出来（1.50:1 的 border 对「一块内容」够用，
   * 对「一处入口」偏弱）。旁边四张能力卡的线仍归 border 档，层次不冲突。 */
  border: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 10px;
}
/* 聚焦：墨线出现 + 纸被「拿起来」一点。键盘与鼠标用户都能看见「现在在这里」。
 * ★ 光环从 34%（`--k12-accent-ring`）减淡到 16%（`--k12-accent-ring-soft`），
 *   投影从 float 降一档到 raise：本应用**开机即聚焦**输入条（那是功能，
 *   ux-audit 的 A1 与键盘可访问性都依赖它），34% 的光环会让首屏出现
 *   「全页面唯一一处强对比元素」，把注意力从内容上拽走。
 *   ⚠️ 那 3px 的环宽**不许减**：它是键盘焦点可见性（≥3:1 非文本对比）的载体，
 *      淡的是颜色强度，不是尺寸。 */
.cp__box:focus-within {
  border-color: var(--k12-accent-ink);
  box-shadow:
    var(--k12-shadow-raise),
    0 0 0 3px var(--k12-accent-ring-soft);
}
.cp__input {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-family: inherit;
  font-size: var(--k12-fs-body);
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
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.cp__att {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 28px（原 26）：与 `.cp__send` 同一档触控目标。
   * 它俩在输入条上并排 —— 一个大一个小会让整行看着是歪的。 */
  /* ★★ 2026-09-27（ux:layout 1024 真机体检抓到）：必须 `flex: none` ——
   *   输入条在 1024 宽时是**过约束**的，宽度写死 28px 的按钮会被 flex 压到 15px
   *   （实测 `cp__att 15x28`，触控目标低于 28px 下限）。`width` 只是"建议值"，
   *   不写 `flex: none` 就等于把"点得准"交给剩余空间。 */
  flex: none;
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
   *   改成由内边距撑开，字号再变也不会裁字。
   *
   * ★★ 同样的理由再来一次（UX 体检 C1 抓到）：`4px 8px` 让它只有 **24px 高**，
   *   低于「手指/触控板都点得准」的 28px 下限 —— 它是**可点的**（点了换模型），
   *   而它就在发送键左边，点偏一下就会开出模型选择器。所以纵向补到 30px。 */
  min-height: 30px;
  padding: 6px 10px;
  border: none;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
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
  font-size: var(--k12-fs-caption);
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
  color: var(--k12-on-fill);
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
