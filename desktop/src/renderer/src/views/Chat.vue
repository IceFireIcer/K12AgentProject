<script setup lang="ts">
/**
 * 对话课堂 —— **默认主界面**（打开应用落到的第一页）。
 *
 * 三种辅助形态（动画 / 编程 / 闯关）以内联卡片出现在回答里，也可以通过卡片右上角
 * 的「展开」进入各自的独立页；侧栏的「能力」分组里也能直达。所以本页是全应用的骨架屏。
 *
 * ── 与 6 事件词表的对应（**全部真实接线**）────────────────────────────────
 *   delta     → 往这一轮的正文尾部追加文字（`turn.text`）
 *   citation  → 来源行（含「教材原文」抽屉，细节来自事件的可选 `details`）
 *   payload   → 内联卡片（kind 由 Tool 名映射，见 `ipc/tool-kinds.ts`）
 *   blocked   → 该轮正文替换为 `blocked.safeText` + 撤回说明
 *   done      → 收尾：解除 streaming，允许下一条
 *   error     → 降级提示（`degraded: true` 只提示**不终结**本轮，正文还会继续来）
 * 事件名来自冻结词表；本页不解释传输层（IPC 在 preload 白名单里）。
 *
 * ★ 本页**只把文字交给 store**（`chat.send`）：发送链路是
 *   `ChatView` → `stores/chat.ts` → `window.api.sendChat(`（守卫 G7 断言只有 store 调它）。
 *
 * ── 空态：能力入口 + 建议问题 ─────────────────────────────────────────────
 * 对话是主入口，所以「这页怎么用」由空态承担（而不是顶栏上一个常驻仪表盘）。
 * 四张能力入口卡对应本项目核心范围内的四种交互；建议问题**只预填不直接发**
 * （学生永远可以改完再发）。
 *
 * ── 学段与章节：各出现一次，各在自己的位置 ────────────────────────────────
 * 学段是**全局环境**（「按什么年级的口吻讲」）→ 顶栏那一枚紧凑指示器（含手动入口），
 * 本页**不再**渲染它（同一件事出现两次就是「界面错位」本身）。
 * 章节是**这段对话在学什么** → 消息区上方那一行（`chat__indicators`）。
 * 对话正文不再被横幅挤掉一屏；空态里那一句「由系统根据对话自动判定，你也可以自己指定。」
 * 就是学段的说明（顶栏只留状态，不摊说明）。
 *
 * ── 右栏折叠 ──────────────────────────────────────────────────────────────
 * ≥1280 常驻（可收），<1280 变浮层（进入该区间自动收起）。断点判断写在 CSS 里，
 * 只在这里维护**一套**媒体查询监听（进窄屏自动收起、离开窄屏还原，
 * 但不覆盖学生自己主动关掉的选择）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  BookMarked,
  Clapperboard,
  Code,
  MessageCircle,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  ShieldAlert,
  TriangleAlert,
  Trophy
} from 'lucide-vue-next'
import ContextRail from '../components/ContextRail.vue'
import MessageComposer from '../components/MessageComposer.vue'
import ChatMessage from '../components/ChatMessage.vue'
import ChapterIndicator from '../components/ChapterIndicator.vue'
import { useChatStore } from '../stores/chat'
import { useConfirm } from '../stores/confirm'
import { useInsightStore } from '../stores/insight'
import { useStudentStore } from '../stores/student'
import { useUiStore, type PageName } from '../stores/ui'
// ★ 来源说法（手动选中 / AI 引擎推算）只有 `labels.ts` 一处实现 ——
//   本页与右栏各写一份映射迟早对不上，而那种不一致是「界面自相矛盾」。
import { gradeOriginLabel } from '../labels'
// ★ 品牌 logo 的 URL 只有 `brand-logo.ts` 一处实现（侧栏 / 空态 / 头像共用一张图）
import { DEFAULT_LOGO_URL } from '../brand-logo'

const chat = useChatStore()
const confirm = useConfirm()
const insight = useInsightStore()
const student = useStudentStore()
const ui = useUiStore()

/* ── 消息列表：直接读 store（6 事件折叠的结果）──────────────────────────── */
const turns = computed(() => chat.turns)
const isEmpty = computed(() => turns.value.length === 0)

/**
 * 自动滚到底。
 *
 * ★ 依赖三个量：轮数、最后一轮正文长度、最后一轮卡片数。
 *   只依赖文本长度不够 —— 一轮里先来卡片、正文不再增长时（模型先出卡片再补话）
 *   界面不会跟着滚，学生要自己往下拽。
 */
const colRef = ref<HTMLElement | null>(null)
async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = colRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => {
    const last = turns.value[turns.value.length - 1]
    return `${turns.value.length}:${last?.text.length ?? 0}:${last?.cards.length ?? 0}`
  },
  () => void scrollToBottom(),
  { immediate: true }
)

/* ── 发送：只把文字交给 store ───────────────────────────────────────────── */
const composerRef = ref<{ fill?: (value: string) => void; focus?: () => void } | null>(null)

function onSend(text: string): void {
  void chat.send(text)
}

/* ── 右栏：≥1280 常驻（可收），<1280 变浮层（进入该区间自动收起）──────────── */
const railOpen = ref(true)
const NARROW = '(max-width: 1279px)'
let mql: MediaQueryList | null = null
/** 记录「这次收起是断点自动做的」—— 离开窄屏时才还原，不覆盖学生主动关掉的选择。 */
let autoClosed = false

function onBreakpoint(): void {
  if (!mql) return
  if (mql.matches) {
    if (railOpen.value) {
      railOpen.value = false
      autoClosed = true
    }
  } else if (autoClosed) {
    railOpen.value = true
    autoClosed = false
  }
}

onMounted(() => {
  mql = window.matchMedia(NARROW)
  onBreakpoint()
  mql.addEventListener('change', onBreakpoint)
  // 画像/推荐：空态与右栏都要用（store 会判「已有数据就不重复请求」）
  void insight.loadAll().catch(() => {})
  void scrollToBottom()
})
onBeforeUnmount(() => mql?.removeEventListener('change', onBreakpoint))

function toggleRail(): void {
  railOpen.value = !railOpen.value
  // 学生自己动手了：之后跨断点不再自动改他的选择
  autoClosed = false
}

/* ── 新会话：清空不可撤销 → 先确认 ──────────────────────────────────────── */
async function newSession(): Promise<void> {
  if (turns.value.length > 0) {
    const ok = await confirm.ask({
      title: '开始新会话？',
      body:
        `当前这段对话有 ${turns.value.length} 轮，清空后界面上不再显示。` +
        '（记录仍留在本机这一名学生自己的会话文件里，学习档案的「历史会话」可以回看。）',
      confirmText: '清空并开始'
    })
    if (!ok) return
  }
  chat.resetConversation()
  await nextTick()
}

/* ── 空态：四张能力入口 + 建议问题 ─────────────────────────────────────── */
interface EntryItem {
  key: string
  label: string
  desc: string
  icon: unknown
  to: PageName | null
}

const entries: EntryItem[] = [
  { key: 'chat', label: '直接提问', desc: '随时问，按你的学段讲', icon: MessageCircle, to: null },
  { key: 'animation', label: '动画讲解', desc: '把过程画出来看', icon: Clapperboard, to: 'animation' },
  { key: 'coding', label: '编程环境', desc: '在本地跑一段 Python', icon: Code, to: 'coding' },
  { key: 'quiz', label: '闯关练习', desc: '几道题检验一下', icon: Trophy, to: 'quiz' }
]

function onEntry(to: PageName | null): void {
  if (to === null) composerRef.value?.focus?.()
  else ui.go(to)
}

/** 建议问题：点一下填进输入条，**不直接发**（学生可以改）。 */
const suggestions = [
  '用动画讲讲特征是怎么提取的',
  '给我出 3 道数据与特征的题',
  '我还是不太明白，换个说法再讲一遍'
]

function fillComposer(text: string): void {
  composerRef.value?.fill?.(text)
}

/* ── 空态之后的专题行：真实数据，没有就整段不出现 ───────────────────────── */

/**
 * 推荐知识点的显示名。
 *
 * ★ 用 `item.name` —— **服务端已经解析好了**（`RecommendationItem.name` 由依赖图的
 *   `kp` 表查出来，图里查不到才退化成 `kp_id`）。
 *   渲染进程再拿 `kpId` 去知识点清单反查一遍是**多做一次**，而且两条路给出的名字
 *   可能不一致（一边是服务端快照、一边是当前清单）。谁解析的就用谁的。
 */
const recommendedName = computed(() => {
  const item = insight.recommended
  if (item === null) return null
  return item.name.trim() || item.kpId
})

const hasRecommended = computed(() => recommendedName.value !== null)

const hasTopic = computed(() => chat.currentChapter.length > 0 || hasRecommended.value)

/**
 * 空态里那句「这个学段是怎么定下来的」。
 *
 * ★ 三种来源说三种话（`gradeOriginLabel()` 是来源说法的**唯一实现**）：
 *   - 学生手动选的 → 如实说「你选的」（否则与顶栏的「手动选中」当场矛盾）；
 *   - 系统判出来的 → 说「系统根据对话自动判定」，并提醒**学生可以自己改**
 *     （D-037 之后确实可以，这句是入口的提示）；
 *   - 冷启动默认值（`default`，`applyGradeState` 会把它整条丢掉，理论上到不了这里）
 *     → 按「还没判出来」的口径说，**不冒充判定结果**。
 */
const gradeSourceSentence = computed(() => {
  switch (chat.gradeOrigin) {
    case 'explicit':
      return `（这是你自己选的 · ${gradeOriginLabel('explicit')}）想换个年级的话，点上面的学段指示器。`
    case 'inferred':
      return `（${gradeOriginLabel('inferred')}）你也可以自己指定。`
    default:
      return '（还没判出来，系统会先看几轮你的提问。）'
  }
})
</script>

<template>
  <div class="chat" data-testid="chat-area">
    <!-- ── 主列 ─────────────────────────────────────────────────────── -->
    <div class="chat__main">
      <!-- 教材章节指示器：**这一页只放它**。
           学段是全局环境（在哪一页都成立）→ 已经在顶栏；
           章节是「这轮对话围绕哪一章」→ 与消息区同处一列。
           两者都放这里 = 同一件事出现两次、还白占一整行（就是这次报的错位）。 -->
      <div class="chat__indicators">
        <ChapterIndicator />
      </div>

      <!-- 会话工具条：会话状态 + 新会话 + 右栏开关 -->
      <div class="chat__bar">
        <div class="chat__bar-left">
          <span class="chat__bar-title">本轮对话</span>
          <span class="chat__bar-meta">{{ isEmpty ? '尚未开始' : `${turns.length} 轮` }}</span>
        </div>
        <div class="chat__bar-right">
          <button
            type="button"
            class="chat__bar-btn"
            data-testid="new-session"
            title="开始一段新对话（清空当前消息）"
            @click="newSession"
          >
            <Plus :size="14" />
            <span>新会话</span>
          </button>
          <button
            type="button"
            class="chat__bar-icon"
            data-testid="rail-toggle"
            :title="railOpen ? '收起学习上下文' : '展开学习上下文'"
            :aria-pressed="railOpen"
            @click="toggleRail"
          >
            <component :is="railOpen ? PanelRightClose : PanelRightOpen" :size="16" />
          </button>
        </div>
      </div>

      <!-- 对话区 -->
      <div ref="colRef" class="chat__col" data-testid="chat-log">
        <div class="chat__inner">
          <!-- ── 空态 ─────────────────────────────────────────────────── -->
          <div v-if="isEmpty" class="chat__empty" data-testid="chat-empty">
            <div class="chat__hello">
              <!-- 空态问候的标记：用品牌 logo（吉祥物团团）。
                   ★ 这里**不跟学段换图** —— 它是「这个应用是谁」的品牌位，
                     与「这一轮按哪个年级讲」无关（那是顶栏学段指示器的事）。
                     学段换图只在侧栏品牌标那一处（见 `brand-logo.ts` 的说明）。 -->
              <img class="chat__hello-mark" :src="DEFAULT_LOGO_URL" :alt="''" aria-hidden="true" draggable="false" />
              <h2 class="chat__hello-title">你好，{{ student.nickname }}</h2>
              <p class="chat__hello-sub">
                我是团团。你可以直接提问，也可以让我换个方式讲 —— 我会按你的学段来回答。
              </p>
              <div class="chat__hello-grade">
                <span class="k12-dot chat__hello-dot" />
                <p class="chat__hello-grade-text">
                  当前按<strong>{{ chat.currentGradeLabel ?? '待判定' }}</strong>的讲法回答。
                  <!-- ★ 括号里那句必须**跟着来源走**：学生手动选过之后，
                       写死「由系统根据对话自动判定」会与顶栏的「手动选中」当场矛盾
                       （实测截图里就是这句话自相矛盾）。来源说法只有 labels.ts 一处实现。 -->
                  <template v-if="chat.currentGrade">{{ gradeSourceSentence }}</template>
                  <template v-else>系统会先看几轮你的提问，再定成哪个年级。</template>
                </p>
              </div>
            </div>

            <div class="chat__entries">
              <button
                v-for="e in entries"
                :key="e.key"
                type="button"
                class="chat__entry"
                @click="onEntry(e.to)"
              >
                <span class="chat__entry-ico"><component :is="e.icon" :size="16" /></span>
                <span class="chat__entry-text">
                  <span class="chat__entry-label">{{ e.label }}</span>
                  <span class="chat__entry-desc">{{ e.desc }}</span>
                </span>
              </button>
            </div>

            <div class="chat__suggests">
              <button
                v-for="s in suggestions"
                :key="s"
                type="button"
                class="chat__suggest"
                data-testid="starter-question"
                @click="fillComposer(s)"
              >
                {{ s }}
              </button>
            </div>

            <p class="k12-path">
              直接提问就能开始 · 想要动画 / 编程 / 闯关，说一句或点上面的入口
            </p>
          </div>

          <!-- ── 消息列表 ─────────────────────────────────────────────── -->
          <template v-else>
            <ChatMessage
              v-for="turn in turns"
              :key="turn.requestId"
              :turn="turn"
              :detail-of="chat.citationDetailOf"
            />

            <!-- 本轮专题（真实数据：教材章节 + 推荐知识点），没有就整段不出现 -->
            <p v-if="hasTopic" class="chat__topic" data-testid="chat-topic">
              <BookMarked :size="13" />
              <span v-if="chat.currentChapter">{{ chat.currentChapter }}</span>
              <span v-if="chat.currentChapter && hasRecommended">·</span>
              <span v-if="hasRecommended">建议接着练：{{ recommendedName }}</span>
            </p>
          </template>
        </div>
      </div>

      <!-- 输入条 -->
      <div class="chat__composer">
        <MessageComposer ref="composerRef" @send="onSend" />
      </div>

      <!-- 本地提示（桥缺失、发送被拒等；这些不是 6 事件里的 error） -->
      <p v-if="chat.localNotice" class="chat__notice" data-testid="local-notice">
        <ShieldAlert :size="13" />
        <span>{{ chat.localNotice }}</span>
      </p>
      <p v-else-if="!chat.bridgeReady" class="chat__notice" data-testid="local-notice">
        <TriangleAlert :size="13" />
        <span>对话通道未接通（preload 没有加载）。</span>
      </p>
    </div>

    <!-- ── 右栏 ─────────────────────────────────────────────────────── -->
    <ContextRail v-model:open="railOpen" />
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100%;
  min-height: 0;
  position: relative;
}
/* 主列 = 一整张纸。对话区是**方格纸工作面本身**（透出外壳的页面底色），
 * 回答与卡片是**压在方格纸上的白纸**：有厚度、有边界，与桌面区分开。
 * 这个层次关系是整个视觉的地基 —— 桌面是「能画能算的地方」，纸是「内容」。 */
.chat__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 指示器行：**只有教材章节**（学段在顶栏，见模板里的说明）。
 * 分隔线由这一行画、不由指示器自己画 —— 各画一条就会叠成双线（「错位」观感的一半）。
 * 底色**不铺白**：这一行和下面的会话工具条同属「桌面层」（透出页面底色），
 * 白色只留给纸张（消息与卡片）；铺白会把顶栏那条 chrome 一路拖到内容区里。 */
.chat__indicators {
  flex: none;
  border-bottom: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
}

/* ── 会话工具条 ───────────────────────────────────────────────────────── */
.chat__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 24px;
  /* 工具条属于桌面层，不铺纸 —— 它是「桌上的工具」，不是内容 */
  border-bottom: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
}
.chat__bar-left {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.chat__bar-title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.chat__bar-meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat__bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.chat__bar-btn {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chat__bar-btn:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
.chat__bar-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chat__bar-icon:hover {
    color: var(--k12-fg-2);
  }
}
.chat__bar-icon[aria-pressed='true'] {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}

/* ── 对话滚动区 ───────────────────────────────────────────────────────── */
.chat__col {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 8px;
  display: flex;
  flex-direction: column;
}
/* 阅读栏：14px 中文约 55 字/行；窄窗口下自动收窄而不是被裁掉 */
.chat__inner {
  width: 100%;
  max-width: var(--k12-w-reading);
  margin: 0 auto;
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap-msg);
}
.chat__composer {
  width: 100%;
  max-width: calc(var(--k12-w-reading) + 40px);
  margin: 0 auto;
  flex: none;
  padding: 0 20px 16px;
}

/* ── 空态 ─────────────────────────────────────────────────────────────── */
.chat__empty {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 24px;
  min-height: 100%;
  padding-bottom: 24px;
}
@media (max-height: 640px) {
  .chat__empty {
    justify-content: flex-start;
    gap: 18px;
  }
}
.chat__hello {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 空态的品牌标记：吉祥物原图。
 * ★ 原实现是一个 44px 的 accent 实心方块 + 一个图标 —— 那是「占位标记」的画法。
 *   换成真图之后**不能保留那个色块底**：logo 本身带透明通道与完整配色，
 *   再垫一层 accent 底会在边缘露出一圈不属于它的颜色（且四个学段的 accent 各不相同，
 *   等于同一个 logo 在每个学段边缘都不一样）。
 * ★ `object-fit: contain` + 稍大的尺寸：素材是 256×256 的正方形插画，
 *   直接用 `cover` 会把耳朵切掉。 */
.chat__hello-mark {
  width: 52px;
  height: 52px;
  object-fit: contain;
  margin-bottom: 2px;
  /* 图片不可拖拽（`draggable="false"` 在模板上）：否则按住它会把图拖出去，
   * 在 Electron 里表现为「窗口突然开始拖拽」或是拖出一个幽灵图。 */
  user-select: none;
}
.chat__hello-title {
  font-size: var(--k12-fs-2xl);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  letter-spacing: -0.01em;
  color: var(--k12-fg);
}
.chat__hello-sub {
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  max-width: 58ch;
}
.chat__hello-grade {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 13px;
  max-width: 72ch;
}
.chat__hello-dot {
  margin-top: 7px;
  background: var(--k12-good);
}
.chat__hello-grade-text {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.chat__hello-grade-text strong {
  color: var(--k12-fg);
  font-weight: 650;
}

.chat__entries {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.chat__entry {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 9px;
  padding: 13px 13px 14px;
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
  .chat__entry:hover {
    border-color: var(--k12-accent-ink);
    background: var(--k12-accent-soft);
  }
}
.chat__entry-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--k12-r-control);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.chat__entry-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.chat__entry-label {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.chat__entry-desc {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

.chat__suggests {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chat__suggest {
  padding: 8px 13px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chat__suggest:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}

/* 本轮专题：正文下方一行「在学什么」 */
.chat__topic {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.chat__notice {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 0 24px 12px;
  padding: 9px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
}

/* ── 空态在窄窗口下的收拢 ─────────────────────────────────────────────── */
@media (max-width: 1439px) {
  .chat__entries {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
