<script setup lang="ts">
/**
 * 空状态 / 加载态 / 错误态 —— 三种"没有正常内容"的时刻，共用一个组件。
 *
 * 为什么合成一个：它们在同一位置出现、结构相同（图标 + 一句话 + 可选操作），
 * 只是语义与色调不同。分开写三个组件会让每个调用点都要判断该用哪个，
 * 而合起来只需传一个 `tone`。
 *
 * 文案规则（frontend-design 的口径）：**空态是引导，不是情绪**。
 * 说清楚"为什么空"与"下一步能做什么"，不要写"暂时没有数据哦～"这类无信息的话。
 */
withDefaults(
  defineProps<{
    tone?: 'empty' | 'loading' | 'error'
    title: string
    /** 补充说明：为什么空 / 怎么办 */
    desc?: string
  }>(),
  { tone: 'empty', desc: '' }
)
</script>

<template>
  <div class="es" :data-tone="tone">
    <div class="es__mark">
      <!-- loading 用旋转描边；其余用简单图形，避免为一个空态引入图标依赖 -->
      <span v-if="tone === 'loading'" class="es__spinner" />
      <span v-else-if="tone === 'error'" class="es__bang">!</span>
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
  padding: 40px 24px;
  text-align: center;
}
.es__mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
}
.es[data-tone='error'] .es__mark {
  background: var(--k12-bad-soft);
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
/* 加载：一个旋转的环。这是唯一允许的循环动画，且它表达的是"在进行中"。 */
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
