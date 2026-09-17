<script setup lang="ts">
/**
 * 顶栏：页面标题 + 副标题 + ★只读学段指示器 + 新会话。
 *
 * ⚠️ 与设计稿的一处**有意偏离**：
 *   画布顶栏是 `Segmented`（初中 / 高中 / 小学高）学段选择器，但 AGENTS.md §5.1
 *   明令学段「没有人工选择入口 / 没有确认 / 没有纠偏」——那套交互已作废。
 *   这里替换为 `GradeIndicator`（纯只读）。这是按架构修正，不是遗漏。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Plus } from 'lucide-vue-next'
import GradeIndicator from './GradeIndicator.vue'
import { daysWithApp, currentTopic } from '@/mocks'

const route = useRoute()

const title = computed(() => String(route.meta.title ?? ''))

/** 副标题：设计稿是「主题：xxx · 教材《xxx》第N章」 */
const subtitle = computed(() => {
  if (route.name === 'home') return `今天是你使用知了同学的第 ${daysWithApp} 天`
  return `主题：${currentTopic.kpName} · 教材${currentTopic.textbook}${currentTopic.chapter}`
})

const emit = defineEmits<{ (e: 'new-session'): void }>()
</script>

<template>
  <header class="tb">
    <div class="tb__title-block">
      <h1 class="tb__title">{{ title }}</h1>
      <p class="tb__sub">{{ subtitle }}</p>
    </div>

    <div class="tb__right">
      <GradeIndicator />
      <button type="button" class="tb__new" @click="emit('new-session')">
        <Plus :size="13" />
        <span>新会话</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.tb {
  height: var(--k12-h-topbar);
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 22px;
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border-bottom: 1px solid var(--k12-border);
  position: relative;
  z-index: 2;
}
.tb__title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tb__title {
  font-size: var(--k12-fs-title);
  font-weight: 650;
  color: var(--k12-fg);
}
.tb__sub {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb__right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.tb__new {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 13px;
  border: none;
  border-radius: var(--k12-r-lg);
  background: var(--k12-accent);
  color: #fff;
  font-size: var(--k12-fs-base);
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.16s ease;
}
.tb__new:hover {
  filter: brightness(1.06);
}
</style>
