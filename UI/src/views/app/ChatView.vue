<script setup lang="ts">
/**
 * 对话课堂 —— **默认主界面**（`/` 直接落到这里）。
 *
 * 三种辅助形态（动画 / 编程 / 闯关）以内联卡出现在回答里，并通过卡片右上角的
 * 「展开」进入各自的独立页；导航上它们同属「能力」分组。所以本页是全应用的骨架屏。
 *
 * ── 与 6 事件词表的对应（接线时的落点）────────────────────────────────────
 * 本页现在跑的是 mock，但消息结构是**按事件形状**建模的，接线时只换数据源：
 *   delta     → 往最后一条 assistant 消息的尾部 text 块追加文字（打字机效果）
 *   citation  → 追加一个 citations 块
 *   payload   → 追加一个 payload 块（kind 由 Tool 名映射，见 §6 映射表）
 *   blocked   → 把该条消息替换为 notice(blocked)，用 blocked.safeText 作正文
 *   done      → 收尾：解除 streaming，允许下一条
 *   error     → 追加一个 notice(error)，带 degraded
 * 事件名来自冻结词表；本页不解释传输层（IPC 在 preload 白名单里，不在渲染进程拼）。
 *
 * ── 相对设计稿的有意偏离 ──────────────────────────────────────────────────
 * 「Grade Suggestion」条原含「确认调整 / 保持初中」两个按钮。AGENTS.md §5.1：
 * 学段无人工入口、无确认、无纠偏 → 改为**只读说明**，无按钮。顶栏的学段 Segmented
 * 选择器同样换成了只读指示器（见 AppTopbar）。
 *
 * ── 布局改动 ─────────────────────────────────────────────────────────────
 * 学段说明原先在「顶栏指示器 / 对话顶部横幅 / 右栏学段页」三处重复，现在只在
 * **空态**（首屏最需要解释的时刻）与**右栏**出现。对话正文不再被横幅挤掉一屏。
 *
 * ── 本次重排：把「节奏」还给对话流 ───────────────────────────────────────
 * 消息之间 36px（--k12-gap-msg）、块之间 20px（--k12-gap-block）、并列卡片之间 16px
 * （--k12-gap）。此前三者是 20 / 12 / 12 —— 段落间距（实测 35.8px）反而大于消息间距，
 * 四个层级里三个挤在同一个值上，于是「一轮对话」比「一段话」还黏。段落本身**不加 margin**：
 * 行高 1.7 已经承担了段间停顿，再加就与「块之间」撞车。
 * 同时拆掉两处配方撞车：学生气泡才是重点（accent 竖线、不降档），
 * 引用只是「依据」（灰竖线 + 整体降一档）；AI 头像从实心色块降为浅底，它属于 chrome。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Sparkles,
  MessageCircle,
  Clapperboard,
  Code,
  Trophy,
  Plus,
  PanelRightClose,
  PanelRightOpen,
  ShieldAlert,
  TriangleAlert,
  X,
  BookMarked
} from 'lucide-vue-next'
import ContextRail from '@/components/ContextRail.vue'
import MessageComposer from '@/components/MessageComposer.vue'
import AnimationCard from '@/cards/AnimationCard.vue'
import CodingCard from '@/cards/CodingCard.vue'
import QuizCard from '@/cards/QuizCard.vue'
import { useThemeStore } from '@/stores/theme'
import { useConfirm } from '@/stores/confirm'
import { aiAnswer, citations, currentTopic, gradeSignals, recommendation, retrievalHits, student } from '@/mocks'
import type { Citation, PayloadKind } from '@/types/contract'
import { useEscape } from '@/composables/useEscape'

const router = useRouter()
const theme = useThemeStore()
const confirm = useConfirm()

/**
 * 教材原文查看（二级界面）。
 * 引用行此前是**不可点的 div** —— 而 `retrievalHits` 里明明带着 `text` 全文、
 * `score`、`parentChunkId`，一个都没展示。学生看到"教材依据：一、从原始数据到特征"
 * 却看不到那句话到底出自哪里。
 */
const sourceOpen = ref<string | null>(null)
const activeSource = computed(() =>
  retrievalHits.find((h) => h.chunkId === sourceOpen.value) ?? null
)

/** ── 消息模型：形状对齐 6 事件，接线时替换数据源即可 ────────────────────── */
type Block =
  | { kind: 'text'; text: string }
  | { kind: 'steps'; title: string; items: string[] }
  | { kind: 'highlight'; text: string }
  | { kind: 'citations'; items: Citation[] }
  | { kind: 'payload'; payloadKind: PayloadKind }
  | { kind: 'notice'; tone: 'blocked' | 'error'; text: string }

type Message =
  | { id: number; role: 'user'; text: string; at: string }
  | { id: number; role: 'assistant'; blocks: Block[]; streaming?: boolean }

let seq = 0
const nextId = () => ++seq

/**
 * 轮次时间戳。它不是「报时」，而是**轮次边界**的视觉锚点 ——
 * 一眼看出「哪几句是我的、隔了多久」，比任何分隔线都便宜。
 * 原型没有真实会话时间，取本机时钟；接线后换成事件自带的时间。
 * 刻意写成**必填**而非可选：可选字段会被逐渐遗忘，必填则让「漏填」在类型层面先暴露。
 */
function stamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 首轮问答的演示数据（与 mock 一致）。点「新会话」即回到空态，方便对照检查。 */
function seedConversation(): Message[] {
  return [
    {
      id: nextId(),
      role: 'user',
      at: stamp(),
      text: '电脑是怎么「认出」一张照片里是猫还是狗的？它又没有眼睛。'
    },
    {
      id: nextId(),
      role: 'assistant',
      blocks: [
        { kind: 'text', text: aiAnswer.lead },
        { kind: 'steps', title: aiAnswer.stepsTitle, items: aiAnswer.steps },
        { kind: 'highlight', text: aiAnswer.highlight },
        { kind: 'citations', items: citations },
        { kind: 'payload', payloadKind: 'animation' },
        { kind: 'payload', payloadKind: 'coding' },
        { kind: 'payload', payloadKind: 'quiz' }
      ]
    }
  ]
}

const messages = ref<Message[]>(seedConversation())
const isEmpty = computed(() => messages.value.length === 0)

/** ── 右栏：≥1280 常驻（可收），<1280 变浮层（进入该区间自动收起）───────── */
const railOpen = ref(true)

/**
 * 进入窄屏时自动收起 —— 否则浮层会盖住对话。离开窄屏时只还原「因窄屏而收起」
 * 的那种情况，不覆盖用户自己主动关掉的选择。
 */
const NARROW = '(max-width: 1279px)'
let mql: MediaQueryList | null = null
let autoClosed = false

function onBreakpoint() {
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
})
onBeforeUnmount(() => mql?.removeEventListener('change', onBreakpoint))

function toggleRail() {
  railOpen.value = !railOpen.value
  // 用户自己动手了：之后跨断点不再自动改他的选择
  autoClosed = false
}

/** ── 滚动到底 ─────────────────────────────────────────────────────────── */
const colRef = ref<HTMLElement | null>(null)
async function scrollToBottom() {
  await nextTick()
  const el = colRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/**
 * 发送：原型只把学生的话追加进去，不请求任何进程。
 *
 * 这里**不做逐字输出**：动效已整体移除，设计要能靠静态层次站住。
 * 接线后 `delta` 事件会往最后一条 assistant 消息的 text 块追加文字 ——
 * 消息结构已经按事件形状建模，换数据源即可。
 */
const composerRef = ref<InstanceType<typeof MessageComposer> | null>(null)

function onSend(text: string) {
  messages.value.push({ id: nextId(), role: 'user', at: stamp(), text })
  messages.value.push({
    id: nextId(),
    role: 'assistant',
    blocks: [
      {
        kind: 'notice',
        tone: 'error',
        text:
          '本原型未接线，这句话不会真的送往模型。接线后这里会按事件时序推进：' +
          '先流式输出正文，再给出引用依据，最后按需升起动画、编程或闯关卡片。'
      }
    ]
  })
  void scrollToBottom()
}

/**
 * 新会话：**清空是不可撤销的**，所以先确认。
 * 此前它一点就把整段对话抹掉，学生没有任何反悔机会。
 * 空会话不需要确认（没有东西可丢）—— 滥用确认会训练人无脑点确定。
 */
async function newSession() {
  if (messages.value.length > 0) {
    const ok = await confirm.ask({
      title: '开始新会话？',
      body: `当前这段对话有 ${messages.value.length} 条消息，清空后无法恢复。（原型阶段不落库；接线后旧会话会留在 Pi 的 JSONL 里，仍可回看。）`,
      confirmText: '清空并开始'
    })
    if (!ok) return
  }
  messages.value = []
  return nextTick()
}

function fillComposer(text: string) {
  composerRef.value?.fill(text)
}

/** 空态的四张能力入口 —— 正是本项目核心范围内的四种交互 */
const entries = [
  { key: 'chat', label: '直接提问', desc: '随时问，按你的学段讲', icon: MessageCircle, to: '' },
  { key: 'animation', label: '动画讲解', desc: '把过程画出来看', icon: Clapperboard, to: 'animation' },
  { key: 'coding', label: '编程环境', desc: '在本地跑一段 Python', icon: Code, to: 'coding' },
  { key: 'quiz', label: '闯关练习', desc: '几道题检验一下', icon: Trophy, to: 'quiz' }
]

function onEntry(to: string) {
  if (to) router.push({ name: to })
  else composerRef.value?.focus()
}

/** 建议问题：点一下填进输入条，不直接发（学生可以改） */
const suggestions = [
  '用动画讲讲特征是怎么提取的',
  '给我出 3 道数据与特征的题',
  '我还是不太明白，换个说法再讲一遍'
]

const signalSummary = computed(() =>
  gradeSignals.signals
    .filter((s) => s.signalType !== 'meta_cognition')
    .map((s) => `「${s.raw}」`)
    .join('、')
)

/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => { sourceOpen.value = null }, () => !!sourceOpen.value)
</script>

<template>
  <div class="chat">
    <!-- ── 主列 ─────────────────────────────────────────────────────── -->
    <div class="chat__main">
      <!-- 会话工具条：会话状态 + 新会话 + 右栏开关 -->
      <div class="chat__bar">
        <div class="chat__bar-left">
          <span class="chat__bar-title">本轮对话</span>
          <span class="chat__bar-meta">
            {{ isEmpty ? '尚未开始' : `${messages.length} 条消息` }} · 主题：{{ currentTopic.kpName }}
          </span>
        </div>
        <div class="chat__bar-right">
          <button type="button" class="chat__bar-btn" title="开始一段新对话（清空当前消息）" @click="newSession">
            <Plus :size="14" />
            <span>新会话</span>
          </button>
          <button
            type="button"
            class="chat__bar-icon"
            :title="railOpen ? '收起学习上下文' : '展开学习上下文'"
            :aria-pressed="railOpen"
            @click="toggleRail"
          >
            <component :is="railOpen ? PanelRightClose : PanelRightOpen" :size="16" />
          </button>
        </div>
      </div>

      <!-- 对话区 -->
      <div ref="colRef" class="chat__col">
        <div class="chat__inner">
          <!-- ── 空态：落地的首屏就是它，不是一段预置对话 ──────────────── -->
          <div v-if="isEmpty" class="chat__empty">
            <div class="chat__hello">
              <div class="chat__hello-mark"><Sparkles :size="22" /></div>
              <h2 class="chat__hello-title">你好，{{ student.nickname }}</h2>
              <p class="chat__hello-sub">
                我是知了同学。这一轮我们继续《{{ currentTopic.chapter }}》，主题是「{{ currentTopic.kpName }}」。
                你可以直接提问，也可以让我换个方式讲。
              </p>
              <!-- 说明文字必须包在一个元素里：它是 flex 容器，裸文本节点会被拆成
                   一个个独立的 flex item，每行只剩两三个字 -->
              <div class="chat__hello-grade">
                <span class="k12-dot chat__hello-dot" />
                <p class="chat__hello-grade-text">
                  当前按<strong>{{ theme.displayGradeMeta.label }}</strong>的讲法回答，由系统根据对话自动判定。判定依据：{{ signalSummary }}
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
                @click="fillComposer(s)"
              >
                {{ s }}
              </button>
            </div>

            <!-- 主路径提示（D1）：对话页不插 22px 身份行（见契约第 3 节「对话页例外」），
                 于是"这页怎么用"由空态承担。用全局 .k12-path，不另起类写字号 -->
            <p class="k12-path">
              直接提问就能开始 · 想要动画 / 编程 / 闯关，说一句或点上面的入口
            </p>
          </div>

          <!-- ── 消息列表 ──────────────────────────────────────────────── -->
          <template v-else>
            <div
              v-for="m in messages"
              :key="m.id"
              class="chat__msg"
              :class="m.role === 'user' ? 'chat__msg--user' : 'chat__msg--ai'"
            >
              <template v-if="m.role === 'user'">
                <!-- 从右侧滑入：这句话是"我"说的，来处要有方向 -->
                <div class="chat__bubble">{{ m.text }}</div>
                <!-- 轮次时间戳：贴在气泡下方、右对齐，与气泡同宽 -->
                <p class="chat__stamp">{{ m.at }}</p>
              </template>

              <template v-else>
                <div class="chat__avatar"><Sparkles :size="14" /></div>
                <div class="chat__ai-col">
                  <!-- 检索中：不确定进度线。刻意不用三点脉冲（AI 味最重的 loader）。 -->
                  <div class="chat__answer">
                    <template v-for="(b, bi) in m.blocks" :key="bi">
                      <p v-if="b.kind === 'text'" class="chat__para">{{ b.text }}</p>

                      <template v-else-if="b.kind === 'steps'">
                        <p class="chat__sec-title">{{ b.title }}</p>
                        <div v-for="(step, si) in b.items" :key="si" class="chat__step">
                          <span class="chat__step-dot" />
                          <p class="chat__step-body">{{ step }}</p>
                        </div>
                      </template>

                      <div v-else-if="b.kind === 'highlight'" class="chat__highlight">
                        <Sparkles :size="15" class="chat__hl-ico" />
                        <p class="chat__hl-text">{{ b.text }}</p>
                      </div>

                      <div v-else-if="b.kind === 'notice'" class="chat__notice" :data-tone="b.tone">
                        <component :is="b.tone === 'blocked' ? ShieldAlert : TriangleAlert" :size="15" class="chat__notice-ico" />
                        <p class="chat__notice-text">{{ b.text }}</p>
                      </div>

                      <!-- 引用：citation 事件的 5 字段投影。**不显示相关度分数** ——
                           冻结契约里没有 score 字段，显示了等于承诺一个送不到的值。 -->
                      <div v-else-if="b.kind === 'citations'" class="chat__cites">
                        <p class="chat__cites-label">教材依据</p>
                        <button
                          v-for="(c, ci) in b.items"
                          :key="c.chunkId"
                          type="button"
                          class="chat__cite"
                          :title="`查看教材原文：${c.sectionTitle}`"
                          @click="sourceOpen = c.chunkId"
                        >
                          <span class="chat__cite-num">{{ ci + 1 }}</span>
                          <span class="chat__cite-text">
                            <span class="chat__cite-title">{{ c.sectionTitle }}</span>
                            <span class="chat__cite-path">{{ c.chapterTitle }}</span>
                          </span>
                          <span v-if="c.compat" class="chat__compat" title="使用了低于当前学段的教材块，已显式标注">
                            跨学段兼容
                          </span>
                          <span class="chat__cite-more">原文</span>
                        </button>
                      </div>
                    </template>
                  </div>

                  <!-- 内联卡组：与正文分离，卡片自带「追问」与「展开」入口。
                       卡片比正文晚 80ms 升起 —— 顺序是"先给依据、再给互动"，
                       同时出现会让卡片抢掉正文的注意力。 -->
                  <div
                    v-if="m.blocks.some((b) => b.kind === 'payload')"
                    class="chat__bundle"
                  >
                    <template v-for="(b, bi) in m.blocks" :key="`p${bi}`">
                      <AnimationCard
                        v-if="b.kind === 'payload' && b.payloadKind === 'animation'"
                      />
                      <CodingCard
                        v-else-if="b.kind === 'payload' && b.payloadKind === 'coding'"
                      />
                      <QuizCard
                        v-else-if="b.kind === 'payload' && b.payloadKind === 'quiz'"
                        compact
                      />
                    </template>
                  </div>

                  <!-- 推荐下一步：依赖图推导，落在对话里而不是独立仪表盘 -->
                  <div class="chat__reco">
                    <div class="chat__reco-text">
                      <p class="chat__reco-title">建议下一步：{{ recommendation.kpName }}</p>
                      <p class="chat__reco-desc">{{ recommendation.reason }}</p>
                    </div>
                    <button type="button" class="chat__reco-btn" @click="router.push(recommendation.targetRoute)">
                      {{ recommendation.ctaLabel }}
                    </button>
                  </div>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>

      <!-- 输入条：与阅读栏同宽，避免和正文错位 -->
      <div class="chat__composer">
        <MessageComposer ref="composerRef" @send="onSend" />
      </div>
    </div>

    <!-- ── 右栏 ─────────────────────────────────────────────────────── -->
    <ContextRail v-model:open="railOpen" />

    <!-- 教材原文（二级界面）：把 citation 背后那条检索命中的全文摊开。
         数据来自 retrievalHits —— score / parentChunkId / expanded 都在那里，
         此前一个都没展示。 -->
    <Teleport to="body">
      <div v-if="activeSource" class="src" role="dialog" aria-modal="true" @click.self="sourceOpen = null">
        <aside class="src__panel">
          <header class="src__head">
            <BookMarked :size="16" />
            <div class="src__head-text">
              <p class="src__title">{{ activeSource.sectionTitle }}</p>
              <p class="src__sub">{{ activeSource.chapterTitle }}</p>
            </div>
            <button type="button" class="src__close" title="关闭" @click="sourceOpen = null">
              <X :size="16" />
            </button>
          </header>

          <div class="src__body">
            <!-- 纯文本渲染，**不解析 Markdown**：只为这一处引入 Markdown 库不划算，
                 所以教材正文的约定是"不带标记"（强调用「」）。 -->
            <p class="src__text">{{ activeSource.text }}</p>
          </div>

          <footer class="src__foot">
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="命中学段">
                {{ activeSource.gradeLevel === 'junior' ? '初中' : activeSource.gradeLevel }}
              </el-descriptions-item>
              <el-descriptions-item label="相关度">
                {{ activeSource.score != null ? activeSource.score.toFixed(2) : '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="检索方式">
                <el-tag size="small" effect="plain">{{ activeSource.degraded ?? 'vector' }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="chunk">
                <code class="src__mono">{{ activeSource.chunkId }}</code>
              </el-descriptions-item>
            </el-descriptions>
          </footer>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100%;
  min-height: 0;
  position: relative;
}
/* 主列 = 一整张纸。纸面上不再给回答套框 ——
 * 套框是"卡片堆"的读法；纸的读法是「字就写在纸上」，靠留白与栏宽分层。 */
/* 对话区 = 方格纸工作面本身（透出外壳的网格）。
 * 回答与卡片是**压在方格纸上的白纸**：有厚度、有边界，与桌面区分开。
 * 这个层次关系是整个视觉的地基 —— 桌面是"能画能算的地方"，纸是"内容"。 */
.chat__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ── 会话工具条 ───────────────────────────────────────────────────────── */
.chat__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 24px;
  /* 工具条属于桌面层，不铺纸 —— 它是"桌上的工具"，不是内容 */
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
  /* meta 档（12px）：它说的是"几条消息 · 主题是什么"，不是角标 */
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
  /* 让内层能撑满，空态才谈得上垂直居中（min-height:100% 需要父级高度确定） */
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
  /* 消息之间：一轮对话是一个单元。此前这里是 20px，比段落自身的视觉间距
   * （行高 1.7，约 36px）还小 —— 于是"换人说话"看起来比"换段"还轻。用最大档。 */
  gap: var(--k12-gap-msg);
}
.chat__composer {
  width: 100%;
  max-width: calc(var(--k12-w-reading) + 40px);
  margin: 0 auto;
  flex: none;
}

/* ── 空态 ─────────────────────────────────────────────────────────────── */
/* 首选垂直居中（首屏最舒服的落点）；窗口矮于 640px 时退回顶对齐并把 spacing
 * 收紧，否则内容会被挤出可滚动区域、反而要滚动才能看到能力入口。 */
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
.chat__hello-mark {
  width: 44px;
  height: 44px;
  border-radius: var(--k12-r-card);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--k12-accent);
  color: var(--k12-surface);
  margin-bottom: 2px;
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
/* 学段说明：只在首屏出现一次（不再在顶栏 / 横幅 / 右栏三处重复） */
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
@media (hover: hover) and (pointer: fine) {
.chat__entry:hover .chat__entry-ico {
  background: var(--k12-surface);
}
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
  /* 说明文字是 meta（12px）。11px 只留给 ≤4 字的角标 —— 见契约第 1 节。 */
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

/* ── 消息 ─────────────────────────────────────────────────────────────── */
.chat__msg--user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.chat__bubble {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  max-width: 78%;
  padding: 10px 14px;
  color: var(--k12-fg);
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-ui);
  /* 右侧一道墨线代替满块着色：位置说明"这是我说的"，颜色不必喊。
   * 全页**只有这一处**用 accent 竖线 —— 引用行已让位（见 .chat__cite）。 */
  border-right: 3px solid var(--k12-accent);
}
/* 轮次时间戳：右对齐贴在气泡下方，天然标出「这一轮是谁在什么时候说的」。
 * 12px（不是 11px）：它是 meta，不是角标。 */
.chat__stamp {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.chat__msg--ai {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
/* 头像属于 chrome（它是"谁在说"的标记，不是内容），所以：
 * 尺寸收到 26px、底色从实心 accent 降为浅底、图形用 accent-ink 保证可读。
 * 此前它是 30px 实心色块 —— 在整条回答里它是最抢眼的东西，而它一句话都没说。 */
.chat__avatar {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: var(--k12-r-control);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  display: flex;
  align-items: center;
  justify-content: center;
}
.chat__ai-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 回答 → 卡片组 → 推荐卡：语义上都是**块**，不是并列卡片，故用 block 档。
   * 并列卡片之间的 16px 由 .chat__bundle 内部承担。 */
  gap: var(--k12-gap-block);
}
/* 回答：**无框**。纸面上的正文就是正文，不是一张卡。
 * 层次靠"有没有左边线"与字号，不靠描边。 */
.chat__answer {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  /* 块之间：正文 → 步骤 → 要点 → 引用。切换必须比段落自身的停顿更明显，
   * 否则「换块」读起来像「换行」。 */
  gap: var(--k12-gap-block);
  padding: 16px 18px;
  /* 靠阴影分层而不是边框：边框会给每个元素画格子 */
}
/* 检索中：不确定进度线 + 一句话。回答出现前它先占位，
 * 于是"正在查教材"是一个可见阶段，而不是空白等待。 */
.chat__loading {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  padding: 16px 18px;
  overflow: hidden;
}
.chat__loading-text {
  margin-top: 9px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.chat__para {
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.chat__sec-title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
  /* 标题上方的额外间距：父容器是 flex + gap，margin 会与 gap **叠加**，
   * 于是「上方留白 > 下方留白」，标题视觉上吸附到它统领的步骤去（proximity）。
   * 不用负 margin 抵消下方的 gap —— 那会把标题推回"居中漂浮"，正好是本次要修的毛病。 */
  margin-top: 10px;
}
.chat__step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.chat__step-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--k12-accent);
  flex: none;
  margin-top: 8px;
}
.chat__step-body {
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.chat__highlight {
  display: flex;
  gap: 9px;
  padding: 2px 0 2px 13px;
  border-left: 3px solid var(--k12-accent);
}
.chat__hl-ico {
  color: var(--k12-accent-ink);
  flex: none;
  margin-top: 2px;
}
.chat__hl-text {
  font-size: var(--k12-fs-sm);
  font-weight: 550;
  line-height: var(--k12-lh-body);
  color: color-mix(in srgb, var(--k12-accent) 55%, var(--k12-fg));
}

.chat__notice {
  display: flex;
  gap: 9px;
  padding: 11px 13px;
  border-radius: var(--k12-r-control);
  line-height: var(--k12-lh-ui);
}
.chat__notice[data-tone='error'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.chat__notice[data-tone='blocked'] {
  background: var(--k12-bad);
  color: var(--k12-surface);
}
.chat__notice-ico {
  flex: none;
  margin-top: 1px;
}
.chat__notice-text {
  font-size: var(--k12-fs-xs);
}

/* ── 引用 ─────────────────────────────────────────────────────────────── */
.chat__cites {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat__cites-label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
}
/* 引用行是 <button>（可点开原文），所以要把浏览器默认按钮样式清干净，
 * 否则会带上系统边框与居中文本。 */
.chat__cite {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 11px;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  border: none;
  /* 竖线用中性色，**不用 accent**：引用是「依据」，不是重点。
   * 此前它与学生气泡同为「浅底 + accent 竖线」，只差左右方向 ——
   * 两个不同语义的东西长同一副样子，重点就被稀释了（accent 留给气泡）。
   * 可点性改由 hover 表达：只有真的指上去，左线才回到 accent。 */
  border-left: 2px solid var(--k12-border-strong);
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
}
@media (hover: hover) and (pointer: fine) {
  .chat__cite:hover {
    background: var(--k12-accent-soft);
    border-left-color: var(--k12-accent);
  }
}
.chat__cite-num {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  /* 11px 保留：这是 1、2 这样的**序号角标**（≤4 字），正是 micro 档的用途 */
  font-size: var(--k12-fs-micro);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.chat__cite-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.chat__cite-title {
  /* 引用整体比正文低一档（13 → 12）：它是脚注层的"依据"，
   * 不该和回答正文（14px）争读。这是"降一档"的落点，标题是这一行的主文字。 */
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat__cite-path {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.chat__cite-more {
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
  .chat__cite:hover .chat__cite-more {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}
.chat__compat {
  flex: none;
  padding: 2px 7px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  /* k12-mark：这是 5 字 chip（「跨学段兼容」），是**角标**不是 meta。
   * 类名含 compat、不含角标词，所以显式标注给审计看。
   * 不升 12px 的理由：升了它就和相邻的引用标题（12px）同权，
   * 而它本来要表达的是"贴在行尾的一个记号"，同权后这层意思就没了。 */
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}

/* ── 内联卡组 / 推荐 ─────────────────────────────────────────────────── */
/* ── 教材原文抽屉 ────────────────────────────────────────────────────── */
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
.src__sub {
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
@media (hover: hover) and (pointer: fine) {
  .src__close:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg-2);
  }
}
.src__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
}
/* 原文用较大的行高与更宽的字距：它是要被**读**的段落，不是 UI 文案 */
.src__text {
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  white-space: pre-wrap;
}
.src__foot {
  padding: 14px 18px;
  border-top: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
}
.src__mono {
  font-family: var(--k12-font-mono);
  /* chunk_id 是长标识（meta），不是 ≤4 字的角标 → 12px */
  font-size: var(--k12-fs-xs);
  color: var(--k12-accent-ink);
}

.chat__bundle {
  display: flex;
  flex-direction: column;
  /* 卡片之间：并列卡片的统一间距（外层 ai-col 用的 block 档是"块之间"） */
  gap: var(--k12-gap);
}
.chat__reco {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 15px;
}
.chat__reco-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.chat__reco-title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.chat__reco-desc {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.chat__reco-btn {
  flex: none;
  padding: 9px 15px;
  border: 1px solid var(--k12-accent);
  border-radius: var(--k12-r-control);
  background: var(--k12-accent);
  color: var(--k12-surface);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
.chat__reco-btn:hover {
  filter: brightness(1.06);
}
}

/* ── 空态在窄窗口下的收拢 ─────────────────────────────────────────────── */
@media (max-width: 1439px) {
  .chat__entries {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
