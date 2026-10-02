<script setup lang="ts">
/**
 * 「智团团正在出题」占位卡（2026-10-02 用户裁决）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这条卡片的全部理由）
 * ══════════════════════════════════════════════════════════════════════════
 * 自动追加此前是**纯静默**的：`autoGenerating` 这个状态存在，但全仓**零个消费者**，
 * 于是学生在「什么都没有」的状态下等几十秒（配额 17 = 两批串行 + 每批最多 2 次重试），
 * 然后突然发现多了十七道题；而一旦失败，他**连失败都不知道**（失败只进主进程日志）。
 *
 * 用户的原话是「雷霆自己一个大出题还不告诉学生，学生还蒙蔽」——
 * 问题不是"没弹窗"，是**没有那三句话**：
 *   ① 正在做什么（这一条在飞）② 大概多久 ③ 没出成的话为什么、还能怎么办。
 *
 * ★ 为什么**不弹模态**：模态的语义是「我必须等你」，而学生此刻并没有被挡住 ——
 *   他刚答完最后一题，正在看小结。把它做成模态等于用一个假的前置条件去打断他。
 *   这张卡是**非阻塞**的：它就摆在"新题将要出现的位置"（题流尾部），
 *   到了就原地变成题，列表不跳。
 * ★ 为什么**不做进度条**：后端不报进度（一次模型调用要么成要么不成，没有中间态）。
 *   给假进度是最容易让学生不信我们的一种做法，所以只用不确定态 + 一句话。
 *
 * ★ 三态都由 store 判，本组件不自己推断（与练习页"状态全部读 store"同一条纪律）：
 *   pending → 正在出 · error → 没出成（可重试）· notice → 出了但没新题 / 没有可用模型
 */

import { computed } from 'vue'
// ★ 头像用品牌 logo（与侧栏 / 空态 / 对话头像**同一张**，见 brand-logo.ts）——
//   这里是"谁在说"，不是"按哪个年级讲"，所以**不跟学段换图**。
import { DEFAULT_LOGO_URL } from '../brand-logo'
import { useQuizStore } from '../stores/quiz'

const quiz = useQuizStore()

/**
 * 三种收尾说法，优先级：失败 > 降级/空回执 > 正常补余。
 *
 * ★ 为什么"降级"不算失败：主进程明确回了 `degraded`（"现在没有可用模型"），
 *   那是**可用性说明**不是错误 —— 与 `MORE_UNAVAILABLE_TEXT` 的既有口径一致。
 */
const mode = computed<'working' | 'empty' | 'broken'>(() => {
  if (quiz.autoError !== null) return 'broken'
  if (quiz.autoNotice !== null) return 'empty'
  return 'working'
})

const title = computed(() => {
  if (mode.value === 'broken') return '这次没能出成新题'
  if (mode.value === 'empty') return '这一关的题先到这里'
  return '智团团正在照着你刚才的作答出几道练习题'
})

const hint = computed(() => {
  if (mode.value === 'broken') {
    // ⚠️ 不复述后端的原始 message：它可能带内部标识（用 toStudentFacingMessage 过一遍
    //    之后才写进 autoError，这里只补"还能怎么办"）。
    return quiz.autoError ?? '可以再试一次，或者先去下一关。'
  }
  if (mode.value === 'empty') return quiz.autoNotice ?? ''
  return '正在挑你这几道题里还没稳的概念，大概十几秒。这几道做完了也不耽误，可以先看着小结。'
})
</script>

<template>
  <div class="qwait k12-card" data-testid="quiz-wait-card" :data-state="mode">
    <div class="qwait__head">
      <img
        class="qwait__avatar"
        :src="DEFAULT_LOGO_URL"
        :alt="''"
        aria-hidden="true"
        draggable="false"
      />
      <span class="qwait__name">智团团</span>
      <span v-if="mode === 'working'" class="qwait__chip" data-testid="quiz-wait-chip">
        <span class="qwait__spin" aria-hidden="true" />
        正在出题
      </span>
      <span v-else-if="mode === 'broken'" class="qwait__chip qwait__chip--bad">没出成</span>
      <span v-else class="qwait__chip">没有新题</span>
    </div>

    <p class="qwait__title" data-testid="quiz-wait-title">{{ title }}</p>
    <p v-if="hint.length > 0" class="qwait__hint" data-testid="quiz-wait-hint">{{ hint }}</p>

    <div v-if="mode === 'broken'" class="qwait__foot">
      <!-- ⚠️ 次要动作形态（el-button），不用 .k12-cta：一屏只允许一个主色填充，
           而且 verify-guard-mutations 的 ⑤ 只替换第一处 .k12-cta（多一处会静默失效）。 -->
      <el-button
        :loading="quiz.autoGenerating"
        :disabled="quiz.autoGenerating"
        data-testid="quiz-wait-retry"
        @click="quiz.retryAuto()"
      >
        {{ quiz.autoGenerating ? '正在重试' : '再试一次' }}
      </el-button>
    </div>

    <TeacherGate label="自动出题的机制">
      <p class="qwait__mech">
        做完这一关的内置题后自动追加生成题（配额：内置 + 生成 ≤ 20，见
        <code>AUTO_PHASE_LIMIT</code>）。分两段下发：第一段 ≤ 10 道
        （<code>AUTO_FIRST_BATCH</code>）先到先做，剩下的在后台补 ——
        分段只改"分几次给"，两段之和仍是补齐到 20。题目先登记到这名学生自己的题库、
        再下发无答案的投影。
      </p>
    </TeacherGate>
  </div>
</template>

<style scoped>
/* 材质走既有令牌（.k12-card 给底与投影），这里只排版。 */
.qwait {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
}
.qwait__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.qwait__avatar {
  width: 24px;
  height: 24px;
  flex: none;
}
.qwait__name {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.qwait__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-label);
  font-weight: 600;
}
/* 「没出成」是可用性说明，不是错误卡：走 muted 档而不是 bad（不摆红）。 */
.qwait__chip--bad {
  background: var(--k12-surface-2);
  color: var(--k12-muted);
}
/* 不确定态转圈：**没有百分比**（后端不报进度，给假进度比不给更糟）。 */
.qwait__spin {
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: qwait-spin 800ms linear infinite;
}
@keyframes qwait-spin {
  to {
    transform: rotate(360deg);
  }
}
/* ★ 减少动效档：转圈是"系统在忙"的唯一信号，关掉就什么都不动了 ——
   所以这里**不压掉它**，只放慢，并且一旦用户要"完全不动"由 base.css 的全局规则收口。 */
@media (prefers-reduced-motion: reduce) {
  .qwait__spin {
    animation-duration: 2400ms;
  }
}
.qwait__title {
  font-size: var(--k12-fs-body);
  font-weight: 600;
  color: var(--k12-fg);
}
.qwait__hint {
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}
.qwait__foot {
  margin-top: 2px;
}
.qwait__mech {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
</style>
