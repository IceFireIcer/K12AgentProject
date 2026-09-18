<script setup lang="ts">
/**
 * 学习档案（二级页面）：**对话优先**原则下的一处汇合点。
 *
 * 五个分页（报告 / 错题本 / 章节进度 / 学习地图 / 历史会话）共用这一层外壳，
 * 而不是各占一个顶级视图 —— 顶栏只有「对话 ↔ 学习档案 ↔ 设置」三步循环，
 * 不会因为功能变多而挤满按钮（见 `stores/ui.ts` 的注释）。
 *
 * 三件事在这一层做完，各分页只管渲染：
 *   ① **进入时取数**（`onMounted` / 切页时按需）；
 *   ② **分页切换**（`ui.studyTab`，允许从「错题本」直接跳到「会话」）；
 *   ③ **学段变化的重新取数**：章节与地图按学段查，系统推断出学段后要重取
 *      —— 否则学生会一直看着**上一个学段**的章节（这是最容易漏的一处）。
 *
 * ★ 分页组件挂在 `<KeepAlive>` 里：地图的缩放/滚动位置、会话搜索框的内容
 *   都属于组件本地状态，切到别的页再回来不该丢（与对话页的卡片同一条理由）。
 */
import { computed, onMounted, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { useStudyStore } from '../stores/study'
import { useUiStore } from '../stores/ui'
import { STUDY_TABS, findStudyTab } from '../study/tabs'

const chat = useChatStore()
const study = useStudyStore()
const ui = useUiStore()

const current = computed(() => findStudyTab(ui.studyTab))

onMounted(() => {
  // 进入档案页：四个区块一起拉（它们互不依赖，串行只会让首屏更慢）。
  // 学段可能还没判定出来（`chat.currentGrade === null`）——那时章节/地图会给出
  // 一句「还没判定出学段」而不是编一个默认学段去查（见 store 里的注释）。
  void study.loadAll(chat.currentGrade)
})

// ★ 学段是**系统推断**的，学生不会主动改它 —— 但它会在对话进行中变化。
//   章节与地图按学段查，所以学段一变就要重取，否则显示的是上一个学段的目录。
watch(
  () => chat.currentGrade,
  (next, previous) => {
    if (next && next !== previous) {
      void study.loadChapters(next)
      void study.loadGraph(next)
    }
  }
)

// 切到历史会话时才去读 Pi 的会话目录（`list()` 要扫盘，没必要一进页面就做）
watch(
  () => ui.studyTab,
  (tab) => {
    if (tab === 'sessions' && study.sessions.length === 0 && !study.sessionsLoading) {
      void study.loadSessions()
    }
  }
)
</script>

<template>
  <section class="study" data-testid="study-view">
    <header class="study__head">
      <div>
        <h2 class="study__title">学习档案</h2>
        <p class="study__sub">{{ current.hint }}</p>
      </div>
      <nav class="study__tabs" role="tablist" aria-label="学习档案分页">
        <button
          v-for="tab in STUDY_TABS"
          :key="tab.id"
          class="tab"
          type="button"
          role="tab"
          :class="{ 'tab--on': tab.id === ui.studyTab }"
          :aria-selected="tab.id === ui.studyTab"
          :data-testid="`study-tab-${tab.id}`"
          :title="tab.hint"
          @click="ui.show('study', tab.id)"
        >
          {{ tab.label }}
        </button>
      </nav>
    </header>

    <p v-if="study.bridgeError" class="study__error" data-testid="study-bridge-error">
      {{ study.bridgeError }}
    </p>

    <div class="study__body">
      <KeepAlive>
        <component :is="current.component" :key="current.id" />
      </KeepAlive>
    </div>
  </section>
</template>

<style scoped>
.study {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.study__head {
  padding: 14px 24px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.study__title {
  font-size: 16px;
  font-weight: 700;
}

.study__sub {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-faint);
}

.study__tabs {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.tab {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-faint);
  font-size: 13px;
  cursor: pointer;
}

.tab:hover {
  color: var(--text);
  border-color: var(--accent);
}

.tab--on {
  background: var(--accent-soft);
  border-color: rgba(47, 111, 208, 0.28);
  color: var(--accent-strong);
  font-weight: 600;
}

.study__error {
  margin: 10px 24px 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--warn-soft, rgba(214, 158, 46, 0.12));
  color: var(--warn);
  font-size: 12px;
  line-height: 1.6;
}

.study__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
