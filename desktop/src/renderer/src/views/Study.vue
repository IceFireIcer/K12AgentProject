<script setup lang="ts">
/**
 * 学习档案（二级页面）：**对话优先**原则下的一处汇合点。
 *
 * 五个分页（报告 / 错题本 / 章节进度 / 学习地图 / 历史会话）共用这一层外壳，
 * 而不是各占一个顶级视图 —— 顶栏只有「对话 ↔ 学习档案 ↔ 设置」三步循环，
 * 不会因为功能变多而挤满按钮（见 `stores/ui.ts` 的注释）。
 *
 * 三件事在这一层做完，各分页只管渲染：
 *   ① **进入时取数**（`onMounted` / `onActivated` / 切页时按需）；
 *   ② **分页切换**（`ui.studyTab`，允许从「错题本」直接跳到「会话」）；
 *   ③ **学段变化的重新取数**：章节与地图按学段查，系统推断出学段后要重取
 *      —— 否则学生会一直看着**上一个学段**的章节（这是最容易漏的一处）。
 *
 * ★ 分页组件挂在 `<KeepAlive>` 里：地图的缩放/滚动位置、会话搜索框的内容
 *   都属于组件本地状态，切到别的页再回来不该丢（与对话页的卡片同一条理由）。
 *
 * ★★ 本页自己也在 `App.vue` 的 `<KeepAlive>` 里 —— `onMounted` 一辈子只跑一次，
 *   「答错一题后回到档案页」的那次**不重挂**。所以「回到这一页时补一次取数」
 *   必须由 `onActivated` 承担（见下方 `onActivated` 的注释：这是错题本
 *   永远不刷新的那条真实缺陷的落点）。
 */
import { computed, onActivated, onMounted, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { useStudyStore } from '../stores/study'
import { useQuizStore } from '../stores/quiz'
import { useUiStore } from '../stores/ui'
import { STUDY_TABS, findStudyTab } from '../study/tabs'

const chat = useChatStore()
const study = useStudyStore()
const quiz = useQuizStore()
const ui = useUiStore()

const current = computed(() => findStudyTab(ui.studyTab))

onMounted(() => {
  // 进入档案页：四个区块一起拉（它们互不依赖，串行只会让首屏更慢）。
  // 学段可能还没判定出来（`chat.currentGrade === null`）——那时章节/地图会给出
  // 一句「还没判定出学段」而不是编一个默认学段去查（见 store 里的注释）。
  void study.loadAll(chat.currentGrade)
})

/**
 * ★★ 每次**回到**档案页都补一次错题本（`KeepAlive` 不重挂，所以只能挂这里）。
 *
 * 为什么非有它不可：错题在别处产生（对话内题卡、闯关页判分），而学生回到这一页时
 * `onMounted` 不会重跑 —— 于是他会看到一份**逐字节相同**的旧错题本，
 * 误以为「这次错的题没记上」。
 *
 * ★ 便宜且不打扰：`loadMistakes()` 自带判据（有数据且没过期就立刻返回），
 *   真的重取时也只换列表数据，**不重置** `ui.studyTab`、不动滚动位置（那些在组件本地状态里）。
 * ★ 只补这一块：报告 / 地图 / 章节各自有自己的刷新入口（概览页的「刷新」按钮、
 *   学段变化触发的重取），没必要每次回来都全量重取。
 */
onActivated(() => {
  void study.loadMistakes()
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

/**
 * ★ 两条判分路径各自留下一个**响应式信号** → 都把错题本标记为过期（只翻标记，不发请求）。
 *
 * 为什么在这里观察、而不是在判分那两个 store 里「顺手刷新错题本」：
 *   · 判分写入发生在别的 store（`stores/chat.ts` 负责对话内题卡、`stores/quiz.ts`
 *     负责闯关页），本页不拥有它们，**也不该在它们里面塞一条学习档案的副作用**
 *     （判分失败/重试/登出都会连带触发）；
 *   · 档案页在 `App.vue` 的 `<KeepAlive>` 里常驻 —— 学生正在对话页答题时，
 *     这里的 watch 照样在跑。
 * ★ 判对判错都翻标记：多花一次本机 HTTP 的代价，远小于「错题本停在旧快照」。
 * ★ 只认**增长**：`quiz.gradedCount` 在换关卡/重做时会归零，那不是新的判分。
 */
watch(
  () => chat.quizResults.size,
  (size, previous) => {
    if (size > previous) study.invalidateMistakes()
  }
)

watch(
  () => quiz.gradedCount,
  (count, previous) => {
    if (count > previous) study.invalidateMistakes()
  }
)

// 切到历史会话时才去读 Pi 的会话目录（`list()` 要扫盘，没必要一进页面就做）
watch(
  () => ui.studyTab,
  (tab) => {
    if (tab === 'sessions' && study.sessions.length === 0 && !study.sessionsLoading) {
      void study.loadSessions()
    }
    // ★ 切到「错题本」分页也补一次（同一个幂等动作；学生在这一页待着时
    //   不会有别的写入，所以这一条主要覆盖「切去闯关做题 → 切回档案 → 再点错题本」）。
    if (tab === 'mistakes') void study.loadMistakes()
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

/* ★ 这条 `border-bottom` 已按报告 4.1 删掉：窗口级横线（侧栏竖线 + 顶栏下线 +
 *   章节条下线 + 「本轮对话」条下线 + 这一条）「不携带层级」——
 *   它们只是让内容区看起来像被一层层框住。页级分区靠留白分工。 */
.study__head {
  padding: 14px 24px 10px;
  /* 这一条是**纸**（本页的头部横条），不是身后的桌面 ——
   * 桌面底色已经由 `.shell__content` 铺好（`--k12-page`） */
  background: var(--k12-surface);
}

.study__title {
  /* 这一层的区块标题（分页外壳的头）→ 区块标题档。
   * 它**不是**页面身份行：身份行走 PageIdentity（24px），本页内容区的最大字号
   * 由各分页自己的 hero 承担（ReportTab 的 `.hero__num`），所以这里不能取 xl ——
   * 取了就会与内容抢焦点、且与顶栏 17px 的页面名重复两遍。 */
  font-size: var(--k12-fs-body-lg);
  font-weight: 700;
}

.study__sub {
  margin-top: 3px;
  /* 当前分页的一句话说明 → meta 档 */
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted-2);
}

.study__tabs {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}

/* 分页胶囊：与 `study/ReportTab.vue` 的时间范围胶囊同一配方（同一组导航，
 * 学生在这两处做的都是「换一个视图」这件事，长相必须一致）。 */
.tab {
  padding: 5px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: transparent;
  color: var(--k12-muted-2);
  /* 分页按钮 = 学生要点的一串列表项 → 次级正文档。
   * 高度由 padding + line-height 撑着，不钉像素高度 —— 字号抬升不会把它挤变形。 */
  font-size: var(--k12-fs-body-sm);
  cursor: pointer;
}

.tab:hover {
  /* 这一行是**要读的文字** → fg；描边是画出来的一层 → accent */
  color: var(--k12-fg);
  border-color: var(--k12-accent);
}

.tab--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  /* 选中态的颜色是要读的 → accent-ink（accent 本身在这个字号上对比度不够） */
  color: var(--k12-accent-ink);
  font-weight: 600;
}

.study__error {
  margin: 10px 24px 0;
  padding: 8px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  /* 桥接失败说明 → meta 档 */
  font-size: var(--k12-fs-caption);
  line-height: 1.6;
}

.study__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
