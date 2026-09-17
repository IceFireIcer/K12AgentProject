<script setup lang="ts">
/**
 * 对话课堂 —— 旗舰屏（首屏定风格）。
 *
 * 布局对齐画布「1. 对话课堂」：
 *   Chat Column（居中 110px 内边距，窄阅读栏）
 *     ├ 学段提示条    ← 设计稿此处是「确认调整 / 保持初中」按钮，**已按架构删除**
 *     ├ 用户气泡（右对齐，渐变底）
 *     └ AI 回答：正文卡 + 引用 + 内联卡组（动画 / 闯关）
 *   Composer（玻璃输入条）
 *   Right Rail（272px，学习上下文 / 工具调用 / 学段）
 *
 * ⚠️ 有意偏离设计稿处（用户选择「以架构为准修正」）：
 *   1. 「Grade Suggestion」条原含两个按钮（确认调整 / 保持初中）。
 *      AGENTS.md §5.1：学段无人工入口、无确认、无纠偏 → 改为**只读说明条**，无按钮。
 *   2. 顶栏的学段 Segmented 选择器（在 AppTopbar 里）→ 改为只读指示器。
 */
import { ref } from 'vue'
import { Sparkles, BookOpen } from 'lucide-vue-next'
import ContextRail from '@/components/ContextRail.vue'
import AnimationCard from '@/cards/AnimationCard.vue'
import QuizCard from '@/cards/QuizCard.vue'
import MessageComposer from '@/components/MessageComposer.vue'
import { aiAnswer, citations, gradeSignals, userQuestion } from '@/mocks'

/** 本地追加的消息（仅演示，不落库、不发给任何进程） */
const extraMessages = ref<string[]>([])

function onSend(text: string) {
  extraMessages.value.push(text)
}

const signalSummary = gradeSignals.signals
  .filter((s) => s.signalType !== 'meta_cognition')
  .map((s) => `「${s.raw}」`)
  .join('、')
</script>

<template>
  <div class="chat">
    <!-- ── 对话列 ─────────────────────────────────────────────── -->
    <div class="chat__col-wrap">
      <div class="chat__col">
        <!-- 学段提示：**只读**，没有按钮（设计稿的两个按钮已按架构删除） -->
        <div class="chat__grade-note">
          <div class="chat__gn-ico"><Sparkles :size="15" /></div>
          <div class="chat__gn-text">
            <p class="chat__gn-line1">学段信号：{{ signalSummary }}</p>
            <p class="chat__gn-line2">
              当前学段为「初中」，由系统自动判定；讲解深度与用词已随之调整。学生端没有学段选择入口。
            </p>
          </div>
        </div>

        <!-- 用户气泡 -->
        <div class="chat__msg-user">
          <div class="chat__bubble">{{ userQuestion }}</div>
        </div>

        <!-- AI 回答 -->
        <div class="chat__msg-ai">
          <div class="chat__avatar"><Sparkles :size="15" /></div>
          <div class="chat__ai-col">
            <!-- 正文卡 -->
            <div class="chat__answer">
              <p class="chat__para">{{ aiAnswer.lead }}</p>
              <p class="chat__sec-title">{{ aiAnswer.stepsTitle }}</p>
              <div v-for="(step, i) in aiAnswer.steps" :key="i" class="chat__step">
                <span class="chat__step-dot" />
                <p class="chat__step-body">{{ step }}</p>
              </div>
              <div class="chat__highlight">
                <Sparkles :size="14" class="chat__hl-ico" />
                <p class="chat__hl-text">{{ aiAnswer.highlight }}</p>
              </div>
            </div>

            <!-- 引用来源（citation 事件的 5 字段投影） -->
            <div class="chat__cites">
              <div v-for="(c, i) in citations" :key="c.chunkId" class="chat__cite">
                <span class="chat__cite-num">{{ i + 1 }}</span>
                <div class="chat__cite-text">
                  <p class="chat__cite-title">{{ c.sectionTitle }}</p>
                  <p class="chat__cite-path">
                    {{ c.gradeLevel === 'junior' ? '初中' : c.gradeLevel }} · {{ c.chapterTitle }}
                    <span v-if="c.compat" class="chat__compat">跨学段兼容</span>
                  </p>
                </div>
                <span class="chat__cite-score">{{ ['0.86', '0.79'][i] ?? '—' }}</span>
              </div>
            </div>

            <!-- 内联卡组：动画 + 闯关 -->
            <div class="chat__bundle">
              <AnimationCard />
              <QuizCard compact />
            </div>

            <!-- 本地演示追加的消息 -->
            <div v-for="(m, i) in extraMessages" :key="`x${i}`" class="chat__local">
              <BookOpen :size="13" />
              <span>已接收（原型未接线，不会真实送往模型）：{{ m }}</span>
            </div>
          </div>
        </div>
      </div>

      <MessageComposer @send="onSend" />
    </div>

    <!-- ── 右栏 ───────────────────────────────────────────────── -->
    <ContextRail />
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100%;
  min-height: 0;
}

.chat__col-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 阅读栏与输入条共用这个宽度上限，两者始终左右对齐 */
  --chat-reading-width: 860px;
}
.chat__col {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 设计稿 padding: 16px 110px 8px —— 窄阅读栏，长文更好读 */
  padding: 16px 110px 8px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  /* 宽屏时把阅读栏收在舒适宽度内，不让正文行长无限拉长 */
  width: 100%;
  max-width: var(--chat-reading-width);
  margin: 0 auto;
}
/* 输入条跟随同一宽度上限，避免与正文错位 */
.chat__col-wrap :deep(.cp) {
  width: 100%;
  max-width: var(--chat-reading-width);
  margin: 0 auto;
}

/* 学段只读说明条（设计稿此处的两个按钮已删） */
.chat__grade-note {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 11px 13px;
  border-radius: var(--k12-r-4xl);
  background: linear-gradient(120deg, color-mix(in srgb, var(--k12-accent) 8%, #fff) 0%, color-mix(in srgb, var(--k12-accent-2) 8%, #fff) 100%);
  border: 1px solid var(--k12-accent-border);
}
.chat__gn-ico {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface);
  color: var(--k12-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}
.chat__gn-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.chat__gn-line1 {
  font-size: var(--k12-fs-sm-2);
  font-weight: 600;
  color: var(--k12-fg);
}
.chat__gn-line2 {
  font-size: var(--k12-fs-xs);
  line-height: 1.6;
  color: var(--k12-muted);
}

/* 用户气泡 */
.chat__msg-user {
  display: flex;
  justify-content: flex-end;
}
.chat__bubble {
  max-width: 430px;
  padding: 11px 14px;
  border-radius: var(--k12-r-4xl);
  background: linear-gradient(135deg, var(--k12-accent) 0%, color-mix(in srgb, var(--k12-accent) 45%, var(--k12-accent-2)) 100%);
  color: #fff;
  font-size: var(--k12-fs-md);
  line-height: 1.65;
}

/* AI 回答 */
.chat__msg-ai {
  display: flex;
  gap: 10px;
}
.chat__avatar {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: var(--k12-r-lg);
  background: linear-gradient(135deg, var(--k12-accent) 0%, var(--k12-accent-2) 100%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.chat__ai-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chat__answer {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 16px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
}
.chat__para {
  font-size: var(--k12-fs-md);
  line-height: 1.75;
  color: var(--k12-fg-2);
}
.chat__sec-title {
  font-size: var(--k12-fs-md);
  font-weight: 650;
  color: var(--k12-fg);
}
.chat__step {
  display: flex;
  gap: 9px;
  align-items: flex-start;
}
.chat__step-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--k12-accent);
  flex: none;
  margin-top: 7px;
}
.chat__step-body {
  font-size: var(--k12-fs-md);
  line-height: 1.75;
  color: var(--k12-fg-2);
}
.chat__highlight {
  display: flex;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--k12-r-xl);
  background: var(--k12-accent-soft);
}
.chat__hl-ico {
  color: var(--k12-accent);
  flex: none;
  margin-top: 2px;
}
.chat__hl-text {
  font-size: var(--k12-fs-base);
  font-weight: 550;
  line-height: 1.7;
  color: color-mix(in srgb, var(--k12-accent) 65%, var(--k12-fg));
}

/* 引用 */
.chat__cites {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.chat__cite {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-radius: var(--k12-r-2xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.chat__cite-num {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--k12-r-sm);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-size: var(--k12-fs-tiny);
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
  gap: 2px;
}
.chat__cite-title {
  font-size: var(--k12-fs-sm-2);
  font-weight: 620;
  color: var(--k12-fg);
}
.chat__cite-path {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.chat__compat {
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-warn-soft);
  color: #8a5a08;
  font-weight: 600;
}
.chat__cite-score {
  font-size: var(--k12-fs-tiny);
  font-weight: 600;
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
}

/* 内联卡组 */
.chat__bundle {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat__local {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
}
</style>
