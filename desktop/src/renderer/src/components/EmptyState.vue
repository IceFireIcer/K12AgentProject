<script setup lang="ts">
/**
 * 空状态 / 加载态 / 错误态 / 高光态 —— 「没有正常内容」的几种时刻，共用一个组件。
 *
 * 为什么合成一个：它们在同一位置出现、结构相同（标记 + 一句话 + 可选操作），
 * 只是语义与色调不同。分开写会让每个调用点都要判断该用哪个，合起来只需传 `tone`。
 *
 * ── 文案规则（改文案前先读；这里是**给学生**看的）────────────────────────
 * ① **空态是引导，不是情绪**：说清楚「为什么空」与「下一步能做什么」，
 *    不写「暂时没有数据哦～」这类无信息的话；
 * ② ★★ **不许出现系统视角的说明**：没有内容时不要解释「后端的规则怎么算的」
 *    「哪个字段没下发」——那是开发笔记，学生读到只会以为软件坏了
 *    （实测踩到过的原句：「还没有错题记录——保持住。」、
 *      「端点只给活动总量 / 练习数 / 答对数三个数，所以图上只分这三段」）；
 * ③ ★ **「空」不总是坏事**：错题本为空、全部答对，是学生做得好 ——
 *    这种时刻用 `tone="success"`，让「没有内容」变成一次正向反馈，
 *    而不是一个看起来像加载失败的灰色占位。
 *
 * ── 图标而不是插画 ─────────────────────────────────────────────────────
 * `mascot` 打开时显示吉祥物「团团」（素材见 `components/MascotMark.vue`）。
 * 它只用在真正需要情感的位置（空态 / 高光态）—— 每个空态都摆一张图
 * 反而会把「这里没内容」变成视觉噪音。
 */
import MascotMark from './MascotMark.vue'

withDefaults(
  defineProps<{
    tone?: 'empty' | 'loading' | 'error' | 'success'
    title: string
    /** 补充说明：为什么空 / 怎么办 */
    desc?: string
    /** 用吉祥物「团团」作标记（空态 / 高光态用；加载与错误态不用）。 */
    mascot?: boolean
  }>(),
  { tone: 'empty', desc: '', mascot: false }
)
</script>

<template>
  <div class="es" :data-tone="tone">
    <div class="es__mark">
      <!-- 加载态：旋转描边（全站唯一允许的循环动画，且它表达的是"在进行中"） -->
      <span v-if="tone === 'loading'" class="es__spinner" />
      <MascotMark v-else-if="mascot" :size="48" />
      <span v-else-if="tone === 'error'" class="es__bang">!</span>
      <span v-else-if="tone === 'success'" class="es__ok">✓</span>
      <span v-else class="es__dash" />
    </div>
    <p class="es__title">{{ title }}</p>
    <p v-if="desc" class="es__desc">{{ desc }}</p>
    <div v-if="$slots.default" class="es__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.es {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  /* 底部留白比顶部大一点：视觉重心落在文案上，而不是被下方的空白拖下去 */
  padding: 40px 24px 48px;
  text-align: center;
}
.es__mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
}
.es[data-tone='error'] .es__mark {
  background: var(--k12-bad-soft);
}
/* 高光态：用学段色的浅底（accent-soft 随学段变色），与"出错"的红底区分开 */
.es[data-tone='success'] .es__mark {
  background: var(--k12-accent-soft);
}
.es__dash {
  width: 16px;
  height: 2px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-muted-2);
}
.es__bang {
  font-size: var(--k12-fs-lg);
  font-weight: 700;
  color: var(--k12-bad);
}
.es__ok {
  font-size: var(--k12-fs-lg);
  font-weight: 700;
  color: var(--k12-accent-ink);
}
/* 加载：一个旋转的环。 */
.es__spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--k12-border-strong);
  border-top-color: var(--k12-accent-ink);
  animation: es-spin 0.8s linear infinite;
}
@keyframes es-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .es__spinner {
    animation: none;
  }
}
.es__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.es__desc {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
  max-width: 44ch;
}
.es__actions {
  margin-top: 4px;
  display: flex;
  gap: 8px;
}
</style>
