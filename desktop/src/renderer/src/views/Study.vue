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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 两列外壳（左：原有五个分页 / 右：画像栏）
 * ══════════════════════════════════════════════════════════════════════════
 * 学生回看自己的时候，看到的是「五张成绩单」——却看不到**智团团记住了他什么**。
 * 画像那套链路（冷启动五问 → 白名单标签 → 每轮注入）早就通了，只是此前只在
 * 对话页右栏露出来。这一版把右侧 20% 划出来交给 `StudyPortrait`：
 *   · 左列**一个像素都不动**（`.study__head` 与 `.study__body` 原样留在左列里，
 *     否则「五个分页」这一层既有布局会被顺手改坏）；
 *   · 右列是 20%（`clamp(232px, 20%, 288px)`，见样式里的上下限理由）；
 *   · `<1024` 时上下堆叠（见样式末尾的 `@media`）。
 */
import { computed, onActivated, onMounted, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { useStudyStore } from '../stores/study'
import { useQuizStore } from '../stores/quiz'
import { useUiStore } from '../stores/ui'
import { useProfileCardStore } from '../stores/profileCard'
import StudyPortrait from '../components/StudyPortrait.vue'
import { STUDY_TABS, findStudyTab } from '../study/tabs'

const chat = useChatStore()
const study = useStudyStore()
const quiz = useQuizStore()
const ui = useUiStore()
const profileCard = useProfileCardStore()

const current = computed(() => findStudyTab(ui.studyTab))

onMounted(() => {
  // 进入档案页：四个区块一起拉（它们互不依赖，串行只会让首屏更慢）。
  // 学段可能还没判定出来（`chat.currentGrade === null`）——那时章节/地图会给出
  // 一句「还没判定出学段」而不是编一个默认学段去查（见 store 里的注释）。
  void study.loadAll(chat.currentGrade)
  // ★ 右栏画像要单独拉：档案页此前**不取**画像那一份数据（它在对话页右栏 /
  //   设置页各自取过）。`profileCard.load()` 自带幂等与降级（桥不可用时只置
  //   `bridgeError` 不抛），失败也不影响左边的五个分页。
  // ★ 只在这里拉、不放进 `onActivated`：`load()` 内部每次都打三条桥（标签 /
  //   身份 / 时间线），学生每切回档案页都重打一遍是白跑；画像在会话页有
  //   `profile:changed` 推送会自己刷新，回到档案页读到的就是新值。
  void profileCard.load().catch(() => {})
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
    // ★ 学习历史（2026-09-30）：与「历史会话」同一条懒加载口径 —— 点进这一页才读，
    //   已经有数据就不再拉（`loadHistory` 里判一次）。
    if (tab === 'history' && study.historyEvents.length === 0 && !study.historyLoading) {
      void study.loadHistory()
    }
  }
)
</script>

<template>
  <section class="study" data-testid="study-view">
    <!-- ── 左列：原有的一切原样搬进来（head + 错误条 + 五个分页）──────
         ★ 这一列用 `<section class="study__main">` 而不是 class 直接挂在
           `.study__body` 上：头部横条与滚动体是两件事，包一层才能让
           「头部不滚、内容滚」这条既有行为原封不动。 -->
    <section class="study__main">
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

    <!-- ── 右列：学生画像（只读一瞥，见 `components/StudyPortrait.vue`）── -->
    <StudyPortrait />
  </section>
</template>

<style scoped>
/* ── 两列外壳 ──────────────────────────────────────────────────────────
 * 左列 `minmax(0, 1fr)`（不是 `1fr`）：`1fr` 的最小值是 `auto`，
 * 分页里任何一处 `overflow: auto` 之外的宽内容（表格 / 长串）会把它顶宽，
 * 右列被挤到窗口外。`minmax(0, 1fr)` 把最小宽度钉成 0，右列恒定 20%。
 *
 * 右列宽度 `clamp(280px, 25%, 348px)`（2026-09-30 从 `clamp(232px, 20%, 288px)` 调大）：
 *   · 调大的理由：右栏从「几行标签 + 四条掌握度」变成了**五行结构（类型/性格/偏好/兴趣/小结）
 *     + 最近在学**，内容量翻了倍 —— 20% 宽下「偏好」行（两个键值对）会折成竖条；
 *   · 下限 280px —— 再窄的话三格掌握度行（名字 / 条 / 百分比）会把名字压成两三个字；
 *   · 上限 348px —— 窗口宽到 1920 时纯 25% 是 480px，而这一栏承载的内容撑不起那么宽，
 *     留白会把它读成「空面板」（与调大前同一条收口理由）；
 *   · 中间段就是 25%（1440 窗口下 = 360 → 落在带内取 348，1280 下 = 320 直接生效）。
 */
.study {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(280px, 25%, 348px);
  height: 100%;
  min-height: 0;
}

/* 左列自己是一根纵向 flex（头不滚、体滚） —— 与改造前的 `.study` 同一条口径，
 * 原样下移到这一层，头部/错误条/内容的行为一个像素都没动。 */
.study__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
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

/* ── 窄窗：上下堆叠 ────────────────────────────────────────────────────
 * ★ 断点取 1023px（沿用全站 `1024` 那条主断点）：再窄下去两列各自都在
 *   自己的下限附近，左右并排会把分页内容挤成一条竖井。
 * ★ 堆叠后**左侧内容在上、画像在下**（DOM 顺序天然如此）：
 *   学生打开这一页第一眼要看的仍是成绩单，画像是一段可以往下滚到的补充。
 * ★ 堆叠时右列的 `height: 100%` 在 grid 自动行下会失效（那一行由内容撑），
 *   所以要显式给回一个 `height: auto`，否则画像栏的身高会塌成 0
 *   —— 它内部是 `flex-direction: column` + `flex: 1` 的滚动体，没有外部
 *   高度就是一屏空白。（`.portrait` 自带 `min-height: 0`，这里只需覆盖 height。）
 */
@media (max-width: 1023px) {
  .study {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  /* 堆叠后给画像栏一个可读的固定高度：不给的话它按内容撑开，
   * 内部那段 `overflow-y: auto` 就永远不触发（内容全摊开、页面变很长）。 */
  .study :deep(.portrait) {
    height: auto;
    max-height: 46vh;
  }
}
</style>
