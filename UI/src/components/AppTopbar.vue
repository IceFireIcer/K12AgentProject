<script setup lang="ts">
/**
 * 顶栏：页面标题 + 副标题 + ★只读学段指示器。
 *
 * ⚠️ 与设计稿的一处**有意偏离**：
 *   画布顶栏是 `Segmented`（初中 / 高中 / 小学高）学段选择器，但 AGENTS.md §5.1
 *   明令学段「没有人工选择入口 / 没有确认 / 没有纠偏」——那套交互已作废。
 *   这里替换为 `GradeIndicator`（纯只读）。这是按架构修正，不是遗漏。
 *
 * 原「新会话」按钮已移入 ChatView：它作用于**当前这段对话**，而本顶栏在每一页都
 * 渲染（原实现 emit 了 new-session 但全仓库没有任何地方监听，等于一个死按钮）。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Cpu } from 'lucide-vue-next'
import GradeIndicator from './GradeIndicator.vue'
import { useModel } from '@/stores/model'
import { currentTopic } from '@/mocks'

const route = useRoute()
const model = useModel()

const title = computed(() => String(route.meta.title ?? ''))

/** 学习类页面显示当前主题；其余页面用路由表里的静态副标题 */
const TOPIC_PAGES = new Set(['chat', 'animation', 'coding', 'quiz'])

const subtitle = computed(() => {
  if (TOPIC_PAGES.has(String(route.name))) {
    return `主题：${currentTopic.kpName} · 教材${currentTopic.textbook}${currentTopic.chapter}`
  }
  return String(route.meta.subtitle ?? '')
})
</script>

<template>
  <header class="tb">
    <div class="tb__title-block">
      <h1 class="tb__title">{{ title }}</h1>
      <p v-if="subtitle" class="tb__sub">{{ subtitle }}</p>
    </div>

    <div class="tb__right">
      <!-- 模型指示器：与学段指示器并列，都是"当前环境"的一部分。
           可点即换 —— 不然学生只能去设置页改，而他在对话中间想换模型时不会想到那。 -->
      <button
        type="button"
        class="tb__model"
        :title="`当前模型：${model.current.providerName} · ${model.current.modelId}（点击更换）`"
        @click="model.openPicker()"
      >
        <Cpu :size="13" />
        <span class="tb__model-name">{{ model.shortLabel }}</span>
      </button>
      <GradeIndicator />
    </div>
  </header>
</template>

<style scoped>
.tb {
  --el-box-shadow-light: none;
  --el-box-shadow: var(--k12-shadow-float);

  height: var(--k12-h-topbar);
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 24px;
  background: var(--k12-surface);
  border-bottom: 1px solid var(--k12-border);
  position: relative;
  z-index: 2;
  color: var(--k12-fg);
}
.tb__title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.tb__title {
  /* ★ 15px —— 刻意**小于**内容区的身份行（22px）与卡片标题（16px）。
   *
   * 顶栏是 chrome：它回答「你在哪一页」，不回答「这页在讲什么」。
   * 此前是 18px，比内容区最大的字号（16px）还大 —— 于是整页的重心落在外壳上，
   * 内容反而退到后面。这是本轮排版返工的第一个根因。
   * 现在内容区的最大字号由各页的 `.k12-identity`（22px）承担，chrome 退后。 */
  font-size: var(--k12-fs-title);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  color: var(--k12-fg);
}
/* 副标题说明「你现在在学什么」，是内容不是装饰，用 fg-2（9.2:1）而非 muted */
.tb__sub {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
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
/* 模型指示器：描边式，与只读的学段指示器（实底）在形态上分开 ——
 * 一个可点、一个只读，视觉上就不该长得一样。 */
.tb__model {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: transparent;
  color: var(--k12-fg-2);
  cursor: pointer;
  white-space: nowrap;
}
@media (hover: hover) and (pointer: fine) {
  .tb__model:hover {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}
/* 模型名是**识别信息**，不是角标 —— 学生要读它才知道现在用的是哪个模型，
 * 所以用 12px（meta 档）而不是 11px（角标档）。11px 只给 ≤4 字的记号。 */
.tb__model-name {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
}
</style>
