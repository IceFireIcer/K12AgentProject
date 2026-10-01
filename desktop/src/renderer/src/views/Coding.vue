<script setup lang="ts">
/**
 * 智码工坊页（内部 id 仍是 `coding`）—— 对话内联编程卡的**展开视图**。
 *
 * ── 数据全部来自真实链路（本页不造任何一条数据）─────────────────────────
 *
 *   学习路径  `GET  /api/quiz/progress`        → `useQuizStore().levels`（服务端按依赖图拓扑序排好）
 *   知识点名  `GET  /api/knowledge/points`     → `useKnowledgeStore().points`（教材里的中文名）
 *   脚手架    `GET  /api/code/templates/{kp}`  → `useCodeStore().loadTemplate()`（**结构上没有 solution**）
 *   分级提示  `GET  /api/code/hint/{kp}?level` → `useCodeStore().askForHint()`（一次只升一级）
 *   执行      **本机浏览器里的 Pyodide Worker**（`sandbox/pyodide-runner.ts`，带超时中断）
 *   反馈      `POST /api/code/run-hint`        → `useCodeStore().analyzeRun()`（**不执行代码**，只翻译报错）
 *
 * ★★ 三条硬约束（改这个文件前先读）：
 *
 * 1. **执行只发生在渲染进程的 Worker 里**：本页不 import pyodide、不 `eval`，
 *    只调 `runStudentCode()`。学生代码在主线程执行会冻住界面，在主进程执行会击穿安全边界。
 * 2. **「运行」不跑第二次**：真实输出先显示（本地、离线、可中断），再把那份结果交给后端分析。
 *    ⚠️ 运行器自己故障时**不**送去分析（stderr 为空会被后端判成「成功」——那是假绿灯）。
 * 3. **没有「提交批改」这条路**：本项目的批改只有两条真实通道 ——
 *    ① 客观题走后端判分（`/api/quiz/grade`，练习页）；② 代码反馈走后端报错归一（本页的 run-hint）。
 *    原型上那个「提交批改」按钮**没有任何后端可接**（没有教师批改端点），
 *    所以它被**删掉**了，而不是换一个名字继续假装。要请老师看代码，
 *    真实路径是在对话里说一句「帮我看看这段代码」——那是模型经 `evaluate_code` 走的那条线。
 *
 * ★★ **受众分离（本条是这一页的读改纪律）**：
 *    上面那些机制（端点名 / Worker / 后端怎么归一）**只进教师视角**
 *    （`<TeacherGate>`，学生视角下不在 DOM 里），学生看到的是「你现在该做什么」：
 *      · 页面上的层级说明 → **已整块删除**（走查 C7：它与底部那句常驻声明是同一件事）；
 *      · 底部那句运行说明 → 「只在这台电脑上运行、结果只用来给你中文解释」，
 *        现在是全应用**唯一**一处常驻安全声明；
 *      · 关卡名 → 教材里的中文名（取不到用中性的「未命名知识点」，**绝不摆 kp id 这种 slug**）。
 *
 * ── 布局（改动前先读）────────────────────────────────────────────────
 *
 *   左 268px **课程总览**：按教材章节分块的关卡导航（总进度 + 继续闯关 + 手风琴）
 *        + 沉在底部的一句「卡住了怎么办」—— 左栏只回答「我在哪 / 接下来去哪」。
 *   右侧主区：**无题时只有一块空态**（一个主行动 + 一句话，报告 1.6）；
 *             有题时（或在装配编辑器）才排满态框架：
 *             操作栏（info 位是面包屑：智码工坊 › 模块 › 关卡）→ 身份行 →
 *             【代码区（**独占整列**）】→ 运行 + 输出 + 提示 → 页脚那句安全声明。
 *             ★ 任务简报**仍是主工作区的浮层**（不在左栏）：要照着「做到这样算完成」补 TODO。
 *             ★★ 2026-09-30 用户裁决：简报从「常驻卡」改成「悬浮窗，默认关闭」——
 *               它常驻时白占 240–300px，编辑器因此窄了近 300px（代码才是这一屏的主角）。
 *
 * 内容区的最大字号（22px）落在身份行上：任务名 16px（块标题档）、正文 13–14px、
 * meta 12px —— 「这页在干什么」永远比「这题叫什么」重。
 *
 * ★ 为什么不再复用 `cards/CodingCard.vue`：那张卡片的入参是**对话里的一张卡**
 *   （`InlineCard`），数据来自 `payload` 事件；本页没有那张卡，数据来自上面那几条取数端点。
 *   两处各写一份会立刻分叉（同一件事两份实现），所以本页自己装配编辑器与运行区，
 *   而**共用**同一套底层件：`monaco-setup.ts` / `pyodide-runner.ts` / `cards/coding.ts` 的纯函数。
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Download,
  FileText,
  Lightbulb,
  RotateCcw,
  X
} from 'lucide-vue-next'
import PageIdentity from '@/components/PageIdentity.vue'
import EmptyState from '@/components/EmptyState.vue'
import TeacherGate from '@/components/TeacherGate.vue'
import { useCodeStore, CODE_HINT_MAX } from '../stores/code'
import { useFloatPanel } from '../stores/floatPanel'
import { useKnowledgeStore } from '../stores/knowledge'
import { useQuizStore } from '../stores/quiz'
import { useOnBackendReady } from '../composables/useOnBackendReady'
import CodeEditorSkeleton from '@/components/CodeEditorSkeleton.vue'
import { MONACO_MAX_LOAD_ATTEMPTS } from '../sandbox/monaco-setup'
import {
  runStudentCode,
  runnerStatusSnapshot,
  subscribeRunnerStatus,
  type RunnerStatus
} from '../sandbox/pyodide-runner'
// `goalOfScaffold`：把脚手架里那句「目标：…」抽出来给学生看（纯函数 + 单测）
import { formatRunMeta, goalOfScaffold } from '../cards/coding'
// ★ 「拿不到中文名时显示什么」的唯一口径是 `study/kp-label.ts`：有名字用名字，
//   没名字用中性的「未命名知识点」（原始 id 只进 `title` 悬停可见）——
//   绝不退回 `prog-loop-jr` 这种 slug（学生看到只会以为报错）。这套规则原本在三页各写一份。
import { kpLabel, kpLabelResolved } from '../study/kp-label'
// ★ 学习路径的**分块**规则（按教材章节分组 / 「继续闯关」跳哪一关）不写在本页：
//   本页只做「取数 + 折叠」，判据集中在 `study/workshop-path.ts`（纯函数，有单测）。
import {
  groupLevelsByChapter,
  isLevelDone,
  nextLevelId,
  type WorkshopLevel
} from '../study/workshop-path'

const code = useCodeStore()
const quiz = useQuizStore()
const floatPanel = useFloatPanel()

/**
 * 「边写边问」—— 打开 / 收起悬浮追问窗。
 * 与动画页同一个手法（`toggleFrom`：再点一次收起）。
 * 标题复用本页已有的 `levelLabel()`（自带"拿不到中文名 → 未命名知识点"的兜底，
 * 绝不把 `prog-loop-jr` 这种 slug 摆到窗口标题上）。
 */
function askAboutTask(event: MouseEvent): void {
  const kpId = code.template?.kpId
  floatPanel.toggleFrom(event.currentTarget as Element | null, {
    kind: 'coding',
    title: kpId ? levelLabel(kpId) : '这道编程题',
    hint: '卡住的时候可以问，问题会带上这道题的上下文。'
  })
}
const knowledge = useKnowledgeStore()

/* ------------------------------------------------------------------ *
 * 题目从哪来：学生的**学习路径**（真实取数，不是写死的三步）
 * ------------------------------------------------------------------ */

/**
 * 关卡顺序与阶段由服务端决定（依赖图拓扑序）——本页只显示，不重排、不推断。
 *
 * ★★ 用 `pathLevels`（**本学段关卡路径**）而不是 `levels`（整张进度表）：这一页是
 *   **学习路径**，而学段换过的学生名下还留着更低学段的旧关卡（合法记录，取题兼容）——
 *   按整张表渲染，同一个大章节里同一个概念会出现三次（名字一字不差、内容按学段不同）。
 *   口径与纯函数都在 `study/workshop-path.ts`（`pathLevelsOf`）。
 */
const levels = computed(() => quiz.pathLevels)
const selectedKpId = ref('')

/**
 * 关卡阶段的中文名（措辞与 `cards/ProgressCard.vue` 里那张表一致，全站一个说法）。
 *
 * ★★ 2026-09-25 去掉关卡锁定：不再有「未解锁」这一档，**每一关都能点开始练习**。
 *   阶段只剩三种进度标记 —— 学习中 / 已通过 / 已掌握。
 */
const STAGE_LABELS: Record<string, string> = {
  learning: '学习中',
  quizzed: '已通过',
  mastered: '已掌握'
}

/**
 * 展示用的阶段名（认不出的字面量兜一手）。
 *
 * ★ 契约枚举值**没有改**（`ProgressStage` 里仍留着 `locked` 这个旧字面量），所以万一真收到它，
 *   这里按「可作答」显示、照样可点、**不做任何禁用** —— 防御性兼容：
 *   绝不把学生挡在门外。
 */
function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? '可作答'
}

/**
 * 知识点显示名（教材里的中文名）。
 *
 * ★ 名字的唯一来源是教材知识点清单（`stores/knowledge.ts` 的 `kpIndex`，经 `kpLabel` 消费）——
 *   本页**不自己建第二份名字表**，也不逐行 `.find()`（那既贵又是第二处实现）。
 * ★ 这一段的兜底原本是 `kpName(kpId) || kpId` —— 于是拿不到名字时，10 岁的学生看到的是
 *   `ph-data-train-predict` 这样的 slug（实测形态：教材换代后老库里查不到名字的残留行）。
 *   现在退回中性的「未命名知识点」，原始 id 只进 `title`（悬停可见，排障/答辩要它）。
 */
function levelLabel(kpId: string): string {
  return kpLabel(kpId, null, (id) => knowledge.kpNameOf(id))
}

/** 名字是否真的取到了（取不到时把 kp id 放进 `title`，界面上不显示它）。 */
function levelNameResolved(kpId: string): boolean {
  return kpLabelResolved(kpId, null, (id) => knowledge.kpNameOf(id))
}

/** 当前题目的显示名：教材里的中文名；取不到用中性标签（不再显示 kp id）。 */
const taskName = computed(() => {
  const kpId = code.template?.kpId ?? code.activeKpId
  if (kpId === '') return ''
  return levelLabel(kpId)
})

/** 当前题目**有没有**中文名（没有就不显示「对应知识点」那一行 —— 见模板里的说明）。 */
const taskNameResolved = computed(() => {
  const kpId = code.template?.kpId ?? code.activeKpId
  return kpId !== '' && levelNameResolved(kpId)
})

/** 脚手架里的 TODO 处数（真实数出来的；填完它们就是这一题的目标）。 */
const todoCount = computed(() => (code.template?.scaffold.match(/TODO/g) ?? []).length)

/**
 * ★★ 简报的**任务名**：用模板自己的 `title`（「函数：求人工智能的特征平均值」），
 *   而不是知识点名（「人工智能的定义」）。
 *
 * 为什么（2026-09-30 用户反馈「看不懂任务简报想让我干什么」）：知识点名回答的是
 * 「这是哪一课」，学生点开简报要的是「**我现在要写什么代码**」—— 前者他早就知道了
 * （左栏正停在这一关上），后者原来整个简报里一个字都没说。228 份随包模板全都带
 * `title`（服务端资产测试钉着完整性），缺省时才回落到知识点名。
 */
const taskTitle = computed(() => {
  const fromTemplate = (code.template?.title ?? '').trim()
  return fromTemplate !== '' ? fromTemplate : taskName.value
})

/**
 * 「这次的目标」那句 —— 从脚手架第一行的 `# 目标：…` 注释里抽（纯函数在 cards/coding.ts）。
 *
 * ★ 它是**模板作者写给学生的原话**（「写一个求平均值的函数，再用它算一遍」），
 *   比任何界面自造的一句话都准；抽不到就整行不渲染（不编）。
 */
const taskGoal = computed(() => goalOfScaffold(code.template?.scaffold ?? ''))

/** 做完以后程序应当打印什么（等宽块展示；去尾换行，免得留一行空白）。 */
const expectedOutputText = computed(() => (code.template?.expectedOutput ?? '').replace(/\s+$/, ''))

/** 本页的尝试计数（第几次运行）——`attempt` 决定后端给哪一级提示，所以必须自己数对。 */
const attempts = ref(0)
/** 已经拿到分析结果的那一次尝试号（对不上就说明反馈是上一次的，不该冒充这一次）。 */
const analyzedAttempt = ref(0)

/**
 * ★★ 任务简报的**悬浮窗开关**（2026-09-30 用户裁决：简报改成悬浮窗，可关可开，**默认关闭**）。
 *
 * 为什么默认关：简报是「需要时瞄一眼」的东西，而代码才是这一屏的主角。它常驻时
 * 既占掉主工作区的一整列（把编辑器挤窄 ~280px），又在学生记住要求之后继续占着视线。
 * ★ 关掉不丢任何东西：内容照常渲染（`v-if` 只是不挂进 DOM），从「代码」卡头的
 *   「任务简报」按钮随时打开 —— 开关状态只活在本次页面会话里，不做持久化。
 */
const briefOpen = ref(false)

/* ------------------------------------------------------------------ *
 * 学习路径的分组：整条路径有几十关，平铺出来就是一堵墙
 * ------------------------------------------------------------------ */

/**
 * ★ 分组的目的只有一个：**「我走到哪一坨了 / 接下来做什么」要一眼能答**。
 *
 * 模块 = 教材的一章（`chapterTitle`），关序与模块序都来自服务端（依赖图拓扑序），
 * 本页只做「投影 + 折叠」—— 不重排、也不自己定义一套知识体系。
 *
 * ★★ 这里**没有**「未解锁」这一档（2026-09-25 起后端不再产出锁定态，
 *   播种时每一关都是 `learning`）：所以模块头上的计数只有「已通关 N / M」，
 *   关卡**全部可点**，不做任何置灰 / 禁用。
 */
const modules = computed(() =>
  groupLevelsByChapter(
    levels.value.map((level): WorkshopLevel => ({ kpId: level.kpId, stage: level.stage })),
    (kpId) => knowledge.kpChapterOf(kpId)
  )
)

/** 已通关的关卡总数（顶部那块进度读它）。 */
const doneCount = computed(() => levels.value.filter((level) => isLevelDone(level.stage)).length)

/** 「继续闯关」的落点（第一个还没通关的关卡；全通关了回到第一关）。 */
const nextKpId = computed(() => nextLevelId(levels.value))

/**
 * 模块的展开状态。
 *
 * ★ 默认值**跟着当前关走**，而不是写死「第一组展开」：默认展开的是
 *   ① 当前正在做的那一关所在模块、② 第一个还没走完的模块 ——
 *   学生一进页面看到的就是「我在哪」和「接下来做什么」，其余收起。
 * ★ 手动点过之后**以手动为准**（`moduleOverrides`）：默认值会随换关而变，
 *   不记这一份的话，学生刚展开的模块会在下一次换关时被系统收回去。
 */
const moduleOverrides = ref<Record<string, boolean>>({})

/** 默认展开的模块键。 */
const defaultOpenKeys = computed(() => {
  const keys = new Set<string>()
  const current = modules.value.find((mod) =>
    mod.levels.some((level) => level.kpId === selectedKpId.value)
  )
  if (current) keys.add(current.key)
  const pending = modules.value.find((mod) => mod.doneCount < mod.total)
  if (pending) keys.add(pending.key)
  return keys
})

/** 这一块现在是展开的还是收起的（手动优先，没手动过用默认值）。 */
function isModuleOpen(key: string): boolean {
  return moduleOverrides.value[key] ?? defaultOpenKeys.value.has(key)
}

function toggleModule(key: string): void {
  moduleOverrides.value = { ...moduleOverrides.value, [key]: !isModuleOpen(key) }
}

/** 点「继续闯关」：跳到第一个还没通关的关卡（没有关卡时按钮是置灰的，不会走到这里）。 */
function continuePath(): void {
  const kpId = nextKpId.value
  if (kpId !== '') void openTask(kpId)
}

/**
 * 面包屑：`智码工坊 › 模块 › 关卡` —— 学生在编辑器里往下滚时也要知道**自己在哪**。
 *
 * ★ 它挂在**吸顶操作栏**的 info 位上（不另起一行）：那一栏滚到哪儿都在，
 *   正是面包屑该在的地方；另起一行则会在滚动后消失，等于白给。
 *   原先 info 位写的是「题目 X · 期望 Y」，与任务简报卡逐字重复 ——
 *   现在那一栏换成**位置**（模块 + 关卡），卡片负责**内容**（要做到什么），
 *   一处说位置、一处说内容，不再说两遍。
 * ★ 关卡名取不到（教材换代留下的残留 kp）时**只显示到模块**：
 *   摆一个「未命名知识点」当面包屑的最后一级没有信息量。
 */
const crumbs = computed<string[]>(() => {
  if (selectedKpId.value === '') return []
  const items = ['智码工坊']
  const module = modules.value.find((mod) =>
    mod.levels.some((level) => level.kpId === selectedKpId.value)
  )
  if (module) items.push(module.title)
  if (levelNameResolved(selectedKpId.value)) items.push(levelLabel(selectedKpId.value))
  return items
})

/** 编辑器区有没有「要做的事」：读到模板了，或者手里还有一份草稿。都没有才是空态。 */
const editorHasWork = computed(() => code.template !== null || code.draft.trim() !== '')

/**
 * 编辑器区的空态分三种，**原因分开说**（取数失败不该看起来像「你还没选题目」）：
 * 正在读 / 读取失败 / 还没有题目可选。文案都指下一步动作，不解释内部机制。
 *
 * ★ `quiz.progressLoading` 也要算进「正在读」：进页面时先读学习路径，
 *   读完之后才会自动打开第一关 —— 不挡这一段的话，学生会先看到一帧
 *   「还没有选题目」，紧接着它自己变掉（像刚刚点坏了什么）。
 */
const editorStage = computed<'loading' | 'error' | 'empty'>(() => {
  if (code.templateLoading || quiz.progressLoading) return 'loading'
  if (code.templateError !== null) return 'error'
  return 'empty'
})

/** 空态里那句「下一步做什么」——按「有没有可做的关卡」分开写，不硬凑一句万能话。 */
const editorEmptyDesc = computed(() => {
  if (levels.value.length === 0) {
    return '左边还没读到学习路径。先回对话里问几句，让智团团把学段判出来，这里就会有第一关。'
  }
  return '在左边的「课程总览」里点一关，这里就会出现那一题的代码骨架。标着 TODO 的地方就是你要补的地方。'
})

/**
 * 读学习路径 + 知识点名，并**默认打开第一个该做的关卡**。
 *
 * ★ 默认值不猜：优先 `learning`（服务端标出来的「现在该学」那一关），
 *   否则按服务端给的顺序取第一关 —— 每一关都能作答，落位只回答「先停在哪儿」。
 *   一关都没有（读不到）时**什么都不选**，界面显示诚实的空态。
 */
async function loadPath(): Promise<void> {
  await Promise.all([quiz.loadProgress(), knowledge.loadPoints()])
  if (selectedKpId.value !== '') return
  const first =
    levels.value.find((level) => level.stage === 'learning') ?? levels.value[0] ?? null
  if (first !== null) await openTask(first.kpId)
}

/** 换一道题：读脚手架 → 换上它的草稿 → 重置本页的尝试计数。 */
async function openTask(kpId: string, force = false): Promise<void> {
  if (kpId === '') return
  if (!force && kpId === code.activeKpId && code.template !== null) return
  selectedKpId.value = kpId
  attempts.value = 0
  analyzedAttempt.value = 0
  runOutput.value = null
  localFailure.value = ''
  localHint.value = ''
  downloaded.value = false
  await code.loadTemplate(kpId)
  // ★ 没读到模板就不动草稿：**换题目失败不该把学生已经写的那份清掉**
  //   （他可能是网络/数据层抖了一下，眼前这份代码本身没问题）。
  if (code.template === null || code.template.kpId !== kpId) return
  const scaffold = code.template.scaffold
  // ★ store 只在草稿为空时才填脚手架；**换题目必须显式换上这一题的草稿**，
  //   否则学生会带着上一题的代码继续做（草稿是页面内存里的一份，不落库）。
  code.draft = scaffold
  editorRef.value?.setValue(scaffold)
}

/**
 * 重新读一次这一题的模板（取数失败后的**恢复动作**）。
 *
 * ★ 两个入口共用它：任务栏上的按钮（手里还有上一题草稿时用），
 *   以及代码区空态里的那个主行动（手里什么都没有时用）——
 *   「原因 + 恢复动作」必须在**同一栏**里闭环（走查 1.3：学生不该被指到左栏去找原因）。
 * ★ 读不到就什么都不做（没有题目可重读时按下去也不该有假动作）。
 */
function retryTemplate(): void {
  const kpId = selectedKpId.value !== '' ? selectedKpId.value : code.activeKpId
  if (kpId === '') return
  void openTask(kpId, true)
}

/* ------------------------------------------------------------------ *
 * 编辑器：Monaco（懒加载，卸载时释放）
 * ------------------------------------------------------------------ */

/**
 * 代码编辑器（异步组件，报告 §5.1）—— 与 `cards/CodingCard.vue` 同一个组件、同一个上限。
 *
 * ★ 三个包装件各自的落点（与卡片里的注释同源，改一处要一起想）：
 *   · `loader` 把 `CodeEditor.vue` 切成独立 chunk（进这一页才下载）；
 *   · `loadingComponent` 是 chunk 在途的骨架；
 *   · `onError` 在 chunk 读取失败时重试 **≤3 次**。
 */
const AsyncCodeEditor = defineAsyncComponent({
  loader: () => import('@/components/CodeEditor.vue'),
  loadingComponent: CodeEditorSkeleton,
  delay: 200,
  timeout: 10000,
  onError(_error, retry, fail, attempts) {
    if (attempts <= MONACO_MAX_LOAD_ATTEMPTS) retry()
    else fail()
  }
})

/**
 * 编辑器组件句柄（`CodeEditor.vue` 的 `defineExpose`）。
 * ★ 装配 / 释放归组件自己；本页只用句柄（运行锁、换题 setValue、出现后补布局）。
 */
const editorRef = ref<{
  isReady(): boolean
  getValue(): string
  setValue(text: string): void
  setReadOnly(readOnly: boolean): void
  layout(): void
  focus(): void
} | null>(null)
const editorReady = ref(false)
/** 装配失败时的可读说明（**绝不白屏**：脚手架会以只读文本顶上）。 */
const editorFailure = ref('')

/**
 * 有没有「有活干」的编辑区 —— 也就是**右栏要不要排满态框架**（报告 1.6）。
 *
 * ★ 空态之外还有**一个必须一直能看见**的东西：Monaco 自己装配失败时的说明
 *   （`data-testid="coding-view-editor-failure"`）。它此前挂在一个总是可见的框里；
 *   现在这个框会被空态换掉，所以判据要把「有故障说明」也算进来 ——
 *   否则「编辑器起不来」这条最需要被看见的信息会跟着空态一起消失（白屏且无解释）。
 * ★ 本判据现在管的是**整栏**（任务栏 / 身份行 / 代码盒 / 按钮行 / 页脚）：
 *   为真时排满态框架，为假时整栏只有一块空态。所以它也决定了 Monaco 的宿主节点
 *   在不在 DOM 里 —— 见文件末尾 `watch(editorVisible, …)` 里补的那次 `mountEditor()`。
 */
const editorVisible = computed(() => editorHasWork.value || editorFailure.value !== '')

/** 右栏的引导空态。与 {@link editorVisible} **互为补集**：两者不会同时出现（否则同一句话读两遍）。 */
const showEditorEmpty = computed(() => !editorHasWork.value && editorFailure.value === '')

/**
 * 装配成功（`CodeEditor.vue` 的 ready 事件）。
 *
 * ★ 「装配是异步的，期间模板可能已经读回来了」这条对齐**不能删**：
 *   组件挂载那一刻的 `:value="code.draft"` 可能还是空串（模板在途），
 *   ready 回来时再对齐一次，免得出现「编辑器空着、store 里已经有脚手架」。
 */
function onEditorReady(): void {
  editorReady.value = true
  editorFailure.value = ''
  const handle = editorRef.value
  if (handle && handle.getValue() !== code.draft) handle.setValue(code.draft)
}

/** 装配失败：一句可读说明（下面的脚手架可以手动复制出去练）。 */
function onEditorFailure(message: string): void {
  editorReady.value = false
  editorFailure.value = `代码编辑器没能加载起来：${message}（下面的脚手架可以手动复制出去练）`
}

/** 学生的改动**只回写 store**（页面内存里的一份草稿，不落库、不进会话、不上传）。 */
function onEditorChange(value: string): void {
  code.draft = value
}

onBeforeUnmount(() => {
  unsubscribeStatus?.()
  unsubscribeStatus = null
})

/* ------------------------------------------------------------------ *
 * 运行：Worker 里真执行 → 真实输出 → 交给后端分析
 * ------------------------------------------------------------------ */

const running = ref(false)
/** 本次运行的原始结果（Worker 回传的那份，**未加工**）。 */
const runOutput = ref<{
  stdout: string
  stderr: string
  interrupted: boolean
  elapsedMs: number
} | null>(null)
/** 运行器层面的故障（Pyodide 没起来 / Worker 崩了）——**不是**学生的报错。 */
const localFailure = ref('')
/** 本页的轻提示（没代码、没模板之类），不是 `error` 事件。 */
const localHint = ref('')

/** Pyodide 状态（进页面后才开始加载，界面要能看出来）。 */
const runnerStatus = ref<RunnerStatus>(runnerStatusSnapshot())
let unsubscribeStatus: (() => void) | null = null

/**
 * 编辑器工具条上的状态角标。
 *
 * ★ 角标只说「现在能不能跑」；「第一次点运行时才准备环境」是实现细节，
 *   挪进 `title`（走查 0.2：把加载时机写在角标上等于把内部机制摆到学生面前）。
 *   它仍然是**真话**（第一次点运行确实要等几秒），所以不删，改成第二层。
 */
const pyodideBadge = computed(() => {
  const status = runnerStatus.value
  if (status.phase === 'ready') {
    const seconds = status.loadMs === null ? null : (status.loadMs / 1000).toFixed(1)
    return {
      text: seconds === null ? 'Python 就绪' : `Python 就绪（${seconds} s）`,
      title: '可以点「运行」了。'
    }
  }
  if (status.phase === 'loading') {
    return { text: '正在准备 Python 环境…', title: '正在准备运行环境，要等几秒。' }
  }
  if (status.phase === 'failed') {
    return { text: 'Python 环境不可用', title: '运行环境没能起来，可以让老师看看。' }
  }
  return {
    text: '代码区就绪后可运行',
    title: '运行环境会在你第一次点「运行」时准备，要等几秒。'
  }
})

/**
 * 点「运行」：三条真实步骤，顺序不能变。
 *
 *   ① 在 **Worker 里**执行（离线可用、死循环可中断，主线程掌握超时并写 SIGINT）；
 *   ② 立刻显示原始 stdout / stderr（学生不必等模型）；
 *   ③ 把这份**已经跑完**的结果交给后端：它把 traceback 归一成中文、定下一级提示。
 *
 * ★ 运行器自己故障（`failure` 非空）时**不走第 ③ 步**、也不计一次尝试：
 *   那不是学生的代码问题，拿空的 stderr 去分析只会得到一句「运行成功」的假反馈。
 */
async function run(): Promise<void> {
  const source = code.draft
  if (source.trim() === '') {
    localHint.value = '先写一点代码，再点运行。'
    return
  }
  if (running.value) return

  localHint.value = ''
  downloaded.value = false
  running.value = true
  // 运行期间锁住编辑器：避免「边跑边改」让显示的输出与眼前的代码对不上
  editorRef.value?.setReadOnly(true)

  try {
    const outcome = await runStudentCode(source, { log: (line) => console.info(line) })
    runOutput.value = {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      interrupted: outcome.interrupted,
      elapsedMs: outcome.elapsedMs
    }
    localFailure.value = outcome.failure ?? ''
  } catch (error) {
    // 兜底：`runStudentCode` 自己已收敛异常，这里防的是「兜底逻辑本身出错」
    runOutput.value = { stdout: '', stderr: '', interrupted: false, elapsedMs: 0 }
    localFailure.value = `运行失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    running.value = false
    editorRef.value?.setReadOnly(false)
  }

  if (localFailure.value !== '') return

  attempts.value += 1
  await code.analyzeRun({
    code: source,
    stdout: runOutput.value?.stdout ?? '',
    stderr: runOutput.value?.stderr ?? '',
    attempt: attempts.value
  })
  analyzedAttempt.value = attempts.value
}

/** 点「求助」：一次只要一级（级别由 store 按已给到第几级推进，前端不指定）。 */
async function askForHint(): Promise<void> {
  if (!code.canAskMoreHints || code.hintLoading) return
  await code.askForHint()
}

/**
 * 「求助」按钮的 `title`（悬停可见）。
 *
 * ★ 按钮 label 只说「求助」（走查 1.4 / C12）：`求助（下一级：第 2 级）`把**提示栈机制**
 *   写在了主行动上 —— 学生要的是「点一下会有人帮我」，不是「这个栈还有几格」。
 *   分级那件事本身是**真状态**（左栏「已给到第 N 级」还在如实显示），所以它进 `title`，
 *   不在界面上删掉。
 */
const hintButtonTitle = computed(
  () => `提示共 ${CODE_HINT_MAX} 级，当前已给到第 ${code.currentHintLevel} 级。`
)

/** 回到这一题的起点（脚手架）。草稿会丢，所以只在学生自己按的时候做。 */
function resetToScaffold(): void {
  code.resetToScaffold()
  editorRef.value?.setValue(code.draft)
  runOutput.value = null
  localFailure.value = ''
  localHint.value = ''
  attempts.value = 0
  analyzedAttempt.value = 0
}

/* ------------------------------------------------------------------ *
 * 结果展示（本地真实输出 + 后端反馈，两者都只读）
 * ------------------------------------------------------------------ */

/**
 * 分析结果只认**本次尝试**那一份。
 *
 * ★ 为什么要三条判据（缺一条就会显示错误的反馈）：
 *   ① `attempts.value > 0` —— 刚换题目 / 刚重置时两个计数都是 0，光比相等会把**上一题**
 *      的 `evaluation` 当成这一题的结论显示出来（换题即串台）；
 *   ② `analyzedAttempt === attempts` —— store 里的 `evaluation` 会保留上一次的结果，
 *      而重新运行的那一瞬间本地输出已经刷新、反馈还没回来，不判新旧就会拿上一次的
 *      「哪里错了」去解释这一次的输出；
 *   ③ `code.analyzeError === null` —— 这一轮的后端分析**失败**时 store 会保留上一条
 *      `evaluation`（不清空），不挡掉就变成了「用上一次的反馈冒充这一次的结论」；
 *      此时界面上只显示那条失败原因，两个来源都如实标注。
 */
const evaluation = computed(() =>
  attempts.value > 0 && analyzedAttempt.value === attempts.value && code.analyzeError === null
    ? code.evaluation
    : null
)

/** 展示用的结果：本地输出（真）+ 后端反馈（真），来源分得清清楚楚。 */
const result = computed(() => {
  const run = runOutput.value
  const evaluated = evaluation.value
  if (run === null && evaluated === null) return null
  return {
    // 成败以后端判据为准（它只看 stderr 是否为空；跑通但没打印也算成功）
    ok: evaluated !== null ? evaluated.ok : run !== null && run.stderr.trim() === '',
    stdout: run?.stdout ?? evaluated?.stdout ?? '',
    interrupted: run?.interrupted === true,
    elapsedMs: run?.elapsedMs ?? 0,
    feedback: evaluated?.feedback ?? '',
    error: evaluated?.error ?? null,
    nextHint: evaluated?.nextHint ?? null,
    rawTraceback: (run?.stderr ?? '').trim() === '' ? evaluated?.error?.rawTraceback ?? '' : run?.stderr ?? ''
  }
})

const verdictLabel = computed(() => {
  const current = result.value
  if (current === null) return ''
  if (current.ok) return '运行成功'
  return current.interrupted ? '已中断' : '运行失败'
})

/* ------------------------------------------------------------------ *
 * 下载（走主进程的原生保存对话框，见 downloadCode 的说明）
 * ------------------------------------------------------------------ */

const downloaded = ref(false)
/** 导出进行中（按钮据此禁用，避免连点弹两次保存框）。 */
const downloading = ref(false)
/** 导出回执（已保存 / 取消了 / 失败了）—— 只说文件名，不说完整路径。 */
const downloadNote = ref<string | null>(null)

/**
 * 下载当前代码（.py）。
 *
 * ★ 文件头用的是**真实模板信息**：题目名（教材里的中文名，取不到就 kp id）与
 *   `expectedBehavior` 都来自 `useCodeStore()`，不是原型里那份假数据。
 * ★ 之前那个「1.5 秒后把按钮文字还原」的计时器一并删掉了 —— 按钮状态由学生的动作驱动，
 *   装一个定时器只为了演一下「我变回去了」，是本轮要清掉的那种假动作。
 *
 * ★★ 走**系统原生保存对话框**（`file:export`，与学习报告 / 学习地图同一条通道），
 *   不再用 `Blob` + `<a download>`：后者在 Electron 里弹出来的是**浏览器那套下载保存框**，
 *   地址栏位置会显示一段 `blob:` 开头的内部地址（走查截图里抓到就是这个）。
 *   ⚠️ 这里刻意不写出那个完整地址：渲染进程里出现回环地址字面量会被
 *      `architecture-guards.test.ts` 的 G3 拦下（那条守卫是防「渲染进程直连 sidecar」的，
 *      按文件整体扫描、不区分注释）。
 * ⚠️ 文件名用**题目中文名**（`taskName`），不是 `template.kpId` ——
 *   下载下来的文件叫 `prog-loop-jr.py` 对学生没有任何意义。
 */
async function downloadCode(): Promise<void> {
  const template = code.template
  if (template === null) return
  const api = window.api
  if (typeof api?.exportMarkdown !== 'function') {
    downloadNote.value = '导出还没接线：保存对话框暂时用不了。'
    return
  }
  // 导出文件头用**任务名 + 这次的目标**（与学生刚才在简报里读到的一致）；
  // 抽不到目标时退回契约里的 expectedBehavior，绝不写一个空标题。
  const goal = goalOfScaffold(template.scaffold)
  const header = `# ${taskTitle.value}\n# ${goal !== '' ? `这次的目标：${goal}` : `期望效果：${template.expectedBehavior}`}\n\n`
  downloading.value = true
  downloadNote.value = null
  try {
    const result = await api.exportMarkdown({
      fileName: `${taskName.value} - 我的代码`,
      content: header + code.draft,
      extension: '.py'
    })
    if (result.ok) {
      // ★ 回执只回**文件名**（完整路径不进渲染进程，见 D-035）
      downloadNote.value = `已保存：${result.fileName}`
      downloaded.value = true
      return
    }
    // 取消不是失败（学生主动关掉对话框），不该报错吓人
    downloadNote.value = result.canceled ? '这次没有保存。' : '这次没能保存，稍后再试试。'
    if (!result.canceled) console.warn('[coding] 导出代码失败：', result.message)
  } catch (error) {
    console.warn('[coding] 导出代码异常：', error)
    downloadNote.value = '这次没能保存，稍后再试试。'
  } finally {
    downloading.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

onMounted(() => {
  // 订阅共享运行器的状态（懒加载耗时是有价值的证据：进页面才开始拉 wasm）
  unsubscribeStatus = subscribeRunnerStatus((status) => {
    runnerStatus.value = status
  })
})

/**
 * 首屏取数（学习路径 + 知识点名）走**统一的重试机制**。
 *
 * ★ 为什么不能只在 `onMounted` 里发一次（本项目已有过一次同类缺陷，见 `views/Dependency.vue`
 *   的注释）：本页在 `App.vue` 的 `<KeepAlive>` 里，切走再切回来**不会重挂**；
 *   而 sidecar 是独立进程，冷启动头几秒必然还没就绪 —— 只发一次的话，
 *   「路径为空」会就地定格成永久状态，学生看到的是一个再也变不出东西的页面。
 * `loadPath` 本身是幂等的（两个 store 的读取都带「已有数据/在途就短路」），
 * 正是 `useOnBackendReady` 要求的形态（它先立刻跑一次，就绪后再补跑一次）。
 */
useOnBackendReady(() => {
  void loadPath()
})

// 模板到位后把脚手架推进编辑器（编辑器还没装配好时由它自己的兜底对齐负责）
watch(
  () => code.template?.scaffold ?? '',
  (scaffold) => {
    const handle = editorRef.value
    if (scaffold !== '' && handle && handle.isReady() && handle.getValue() !== scaffold) {
      handle.setValue(scaffold)
    }
  }
)

/**
 * ★ 编辑区从「空态」变回「有活干」时：补一次布局。
 *
 * ★ 装配**不再**需要在这里补：编辑器是异步组件（`AsyncCodeEditor`），
 *   它跟着这一支一起挂载，`onMounted` 自己会去装配（旧实现里那个「宿主节点晚出现，
 *   必须在 watch 里补一次 mountEditor()」的问题从结构上消失了）。
 * ★ 布局仍要在这里补一次：Monaco 的 `automaticLayout: false` 意味着**它自己不会去量**
 *    （见 `sandbox/monaco-setup.ts` 的注释：布局由本页的 ResizeObserver 显式驱动）。
 *    不等 ResizeObserver 那一拍，学生点完关卡会先看到一帧**空白的编辑框**
 *    （有时长到下一帧才恢复）—— 那正好是「我点了没反应」的观感。
 *    这里显式补一次，让它与脚手架同帧出现。
 */
watch(editorVisible, (visible) => {
  if (!visible) return
  void nextTick(() => {
    editorRef.value?.layout()
  })
})
</script>

<template>
  <div class="code" data-testid="coding-view">
    <!-- 左：**纯导航**（课程总览 → 模块 → 关卡）。
         ★ 任务简报已搬到右栏主工作区顶部（与代码区同处一屏、同一视线）：
           学生要照着「做到这样算完成」写代码，那一句与代码隔开一整列时，
           他得先跨栏读一遍再回来 —— 左栏从此只回答「我在哪 / 接下来去哪」。 -->
    <aside class="code__brief">
      <!-- ── 课程总览：按教材章节分块（先看大块，再进小关）─────────────────
           ★ 模块名来自教材的 `chapterTitle`，顺序来自服务端的依赖图拓扑序 ——
             本页不自己定义知识体系：教材加一章，这里就自动多一块，不会错位。
           ★★ 没有「未解锁」这一档（后端播种时每一关都是 `learning`），
             所以这里只有「已通关 / 可作答」两态，且**每一关都能点**。 -->
      <section class="code__sec">
        <span class="code__sec-label">课程总览</span>
        <!-- ★ 进度数字只有一种格式（报告 2.3）：`已通关 N / M`。
               模块头上的 `N / M` 是**同一口径的分块读数**，不是第二个指标。
               没有关卡时整行不显示（空态下不该出现「0 / 0」这种仪表盘读数）。 -->
        <p
          v-if="levels.length > 0"
          class="code__sec-note"
          data-testid="coding-view-path-summary"
        >
          {{ modules.length }} 个模块 / {{ levels.length }} 关
        </p>
      </section>

      <!-- ── 模块导航 ──────────────────────────────────────────────────
           `data-testid="coding-view-path"` 仍落在**外层容器**上：
           「这一页有没有路径」这个判断与分块细节无关（分块以后还会再调）。 -->
      <div v-if="levels.length > 0" class="mods" data-testid="coding-view-path">
        <div class="mods__total">
          <span class="mods__done k12-num" data-testid="coding-view-done-count">
            已通关 {{ doneCount }} / {{ levels.length }}
          </span>
          <!-- ★ 「继续闯关」是**次要动作**（这一屏的主色填充是右栏的「运行」），
               所以沿用 `.k12-cta` 的几何 + 描边变体，不抢主色。 -->
          <button
            type="button"
            class="k12-cta code__act--quiet mods__go"
            :disabled="nextKpId === '' || running"
            data-testid="coding-view-continue"
            @click="continuePath"
          >
            继续闯关
          </button>
        </div>

        <section
          v-for="(mod, modIndex) in modules"
          :key="mod.key"
          class="mod"
          :data-key="mod.key"
        >
          <!-- 模块头：可点的折叠开关（键盘可达，`aria-expanded` 如实报状态） -->
          <button
            type="button"
            class="mod__head k12-tap"
            :aria-expanded="isModuleOpen(mod.key)"
            :data-open="isModuleOpen(mod.key)"
            :data-testid="`coding-view-module-${modIndex}`"
            @click="toggleModule(mod.key)"
          >
            <ChevronRight
              :size="13"
              class="mod__ico"
              :data-open="isModuleOpen(mod.key)"
              aria-hidden="true"
            />
            <span class="mod__title">{{ mod.title }}</span>
            <span class="mod__count k12-num">{{ mod.doneCount }} / {{ mod.total }}</span>
          </button>
          <ul v-show="isModuleOpen(mod.key)" class="path">
            <li
              v-for="level in mod.levels"
              :key="level.kpId"
              class="path__item"
              :data-stage="level.stage"
              :class="{ 'path__item--on': level.kpId === selectedKpId }"
            >
              <button
                type="button"
                class="path__btn"
                :data-testid="`coding-view-level-${level.kpId}`"
                :data-active="level.kpId === selectedKpId ? 'true' : 'false'"
                :title="
                  levelNameResolved(level.kpId)
                    ? `${levelLabel(level.kpId)} · ${stageLabel(level.stage)}`
                    : level.kpId
                "
                :disabled="running"
                @click="openTask(level.kpId)"
              >
                <span class="path__dot" aria-hidden="true" />
                <span class="path__name">{{ levelLabel(level.kpId) }}</span>
                <!-- ★ 状态标记**只在真的有结论时出现**：已通关画一个勾，
                     当前这一关写「当前」。其余关卡不留任何标签 ——
                     57 关全挂一个「学习中」等于没有状态（报告 §3.2）。 -->
                <Check v-if="isLevelDone(level.stage)" :size="13" class="path__tick" aria-hidden="true" />
                <span v-else-if="level.kpId === selectedKpId" class="path__now">当前</span>
              </button>
            </li>
          </ul>
        </section>
      </div>
      <p v-else-if="quiz.progressLoading || knowledge.pointsLoading" class="code__desc">正在读学习路径…</p>
      <p v-else class="code__brief-err" data-testid="coding-view-path-error">
        <AlertTriangle :size="14" />
        {{ quiz.progressError ?? quiz.bridgeError ?? '学习路径里还没有关卡。先去对话里问几句，让它把学段判出来。' }}
      </p>

      <!-- ★ 一句话就够（走查 C11：这一块原来写着提示分级机制 + 「别急着一次点到底」，
           属于把机制摆在学生面前；现在只留「卡住了该点哪」）。
           分级机制本身是**真话**，所以挪进 `title`，不删。 -->
      <!-- ★ 毛玻璃圆角块（2026-09-30 用户裁决，见样式里那段说明）。
           `k12-glass` 是 base.css 里那条**唯一的毛玻璃配方**（带 @supports 兜底），
           这里不自己再写一遍 backdrop-filter。 -->
      <div
        class="code__hint-note"
        title="提示是一级一级给的：先是方向，再具体一点，最后一级才会把写法写全。"
      >
        <Lightbulb :size="16" class="code__hint-ico" />
        <div>
          <p class="code__hint-title">卡住了怎么办</p>
          <p class="code__hint-text">
            先自己想，想不出来再点右边的<strong class="code__hint-key">求助</strong>。
          </p>
          <p v-if="code.currentHintLevel > 0" class="code__hint-text" data-testid="coding-view-hint-progress">
            已给到第 {{ code.currentHintLevel }} 级（一共 {{ CODE_HINT_MAX }} 级）。
          </p>
        </div>
      </div>

      <!-- ★ 这里原来有一个「代码在哪里执行 · 安全边界」折叠块 —— 整块删除（走查 C7）。
           它和右栏页脚那句常驻声明说的是同一件事：同一个承诺说三遍，学生不会读三遍，
           却要为另外两遍付出注意力（同一件安全承诺在左栏 + 页脚 + 对话卡上各写了一份）。
           现在全应用只留**一处**常驻声明：右栏页脚的
           `data-testid="coding-view-run-locally"`（学生话）+ 紧挨着它的 `<TeacherGate>`
           （教师 / 答辩要的技术口径，学生视角下不在 DOM 里）。
           ⚠️ 要往左栏加回这段话之前，先回答「页脚那句为什么不够」——
              答不上来就会变成第二处同义声明（左栏现在只留课程总览与关卡导航）。 -->
    </aside>

    <!-- 右：主区。PageActions 在这个滚动容器内 → 吸顶有效。 -->
    <section class="code__stage">
      <!-- ── 还没有题目可做时的引导态（报告 1.6：空态 = 一个主行动 + 一句话）────
           ★ 空态是**整栏**的，不再套在代码壳里：无题时任务栏 / 身份行 / 代码盒 /
             运行·求助·重置按钮行 / 页脚安全声明**全部不渲染** ——
             没有内容的页面不该排出满态的框架（那是「空仪表盘」）。
           ★ 原因与恢复动作都在这块里（走查 1.3）：原因就是 `code.templateError`
             （store 已经把技术原文换成学生话），恢复动作是下面那个按钮。
             原来那句「左边写清了原因」已删 —— 它逼学生跨栏读，而左边现在**不再重复**这条警告。
           · `data-testid="coding-view-editor-empty"` 仍落在这个空态上；
           · 装配失败（`editorFailure` 非空）走 `<template v-else>` 那一支：
             `showEditorEmpty` 与 `editorVisible` 互为补集，两边不会同时出现
             （那条「编辑器起不来」的说明必须看得见）。 -->
      <EmptyState
        v-if="showEditorEmpty"
        :tone="editorStage === 'error' ? 'error' : editorStage === 'loading' ? 'loading' : 'empty'"
        :mascot="editorStage === 'empty'"
        :title="
          editorStage === 'loading'
            ? '正在准备这一题的代码'
            : editorStage === 'error'
              ? '这道题还没读上来'
              : '还没有选题目'
        "
        :desc="
          editorStage === 'loading'
            ? '马上就好。读完这里就会出现这一题的代码骨架。'
            : editorStage === 'error'
              ? code.templateError ?? editorEmptyDesc
              : editorEmptyDesc
        "
        data-testid="coding-view-editor-empty"
      >
        <!-- 恢复动作只给**一个**：原因（上一行）→「重新读模板」。
             「换一关」指的是左栏的课程总览，不在这里再排一个按钮（两个并列的主行动等于没有主行动）。 -->
        <button
          v-if="editorStage === 'error'"
          class="k12-cta"
          type="button"
          data-testid="coding-view-empty-retry"
          @click="retryTemplate"
        >
          重新读模板
        </button>
      </EmptyState>

      <!-- 有题可做（或编辑器装配中 / 装配失败）时才排满态框架 -->
      <template v-else>
        <PageActions>
          <template #info>
            <!-- ★ 面包屑（`智码工坊 › 模块 › 关卡`）：挂在**吸顶**的这一栏里，
                 所以学生滚到代码区下面时仍然看得到自己在哪。
                 它替换掉的「题目 X · 期望 Y」与右上的任务简报卡逐字重复 ——
                 那一句现在是卡片里的「做到这样就算完成」（见 `crumbs` 的说明）。 -->
            <span v-if="crumbs.length > 0" class="code__crumb" data-testid="coding-view-crumb">
              <template v-for="(crumb, index) in crumbs" :key="crumb">
                <span v-if="index > 0" class="code__crumb-sep" aria-hidden="true">›</span>
                <span :class="{ 'code__crumb-now': index === crumbs.length - 1 }">{{ crumb }}</span>
              </template>
            </span>
            <span v-else>还没有可做的题目</span>
          </template>
          <el-button
            v-if="code.templateError !== null"
            data-testid="coding-view-retry-template"
            @click="retryTemplate"
          >
            <RotateCcw :size="14" />
            <span class="btn__label">重新读模板</span>
          </el-button>
          <el-button
            :disabled="code.template === null || downloading"
            :loading="downloading"
            data-testid="coding-view-download"
            @click="downloadCode"
          >
            <Check v-if="downloaded" :size="14" />
            <Download v-else :size="14" />
            <span class="btn__label">{{ downloaded ? '已下载' : '下载代码' }}</span>
          </el-button>
        </PageActions>
        <!-- 导出回执（含「取消了」这一档：学生自己关掉对话框不该被当成出错） -->
        <p v-if="downloadNote" class="code__download-note" data-testid="coding-view-download-note">
          {{ downloadNote }}
        </p>

        <!-- 身份行（22px，全页唯一）：说的是「这页在干什么」，不是重复顶栏的「智码工坊」。 -->
        <PageIdentity
          main="在这里把刚才学的写成代码"
          meta="代码在学生机本地执行，不上传"
          hint="先看任务要求，再在下面补全 TODO 并运行"
        />

        <!-- ── 任务说明入口：**紧贴代码卡片上方**、右对齐（2026-09-30 用户裁决）。
             ★ 为什么单独占一行而不是并进身份行：并进身份行时它跟大标题齐平，位置太靠上 ——
               学生的视线落在「大标题 → 代码卡片」这条线上，入口贴住卡片上沿才在动线上。
             ★ 文案是人话（原「任务简报」是内部叫法）：`看看要做什么` —— 一眼知道点开是什么。
             ★ 走 `.k12-cta` 的几何（与「运行」「求助」同一档尺寸，比卡头那排 chip 大一圈），
               但用 quiet 变体：这一屏**唯一的主色填充仍然只有「运行」**。 -->
        <div class="code__brief-entry">
          <button
            type="button"
            class="k12-cta code__act--quiet code__brief-open"
            :aria-expanded="briefOpen"
            data-testid="coding-view-task-toggle"
            :title="briefOpen ? '收起这道题的要求' : '打开看看这道题要做什么、代码里要补哪几处'"
            @click="briefOpen = !briefOpen"
          >
            <FileText :size="15" />
            <span>{{ briefOpen ? '收起任务说明' : '看看要做什么' }}</span>
          </button>
        </div>

        <!-- ── 任务简报（**悬浮窗**）+ 代码区 ──────────────────────────────
             ★★ 2026-09-30 用户裁决：任务简报收进悬浮窗、**默认关闭**，代码区独占整列 ——
                简报常驻时要白占 240–300px（编辑器被挤窄），而学生记住要求之后它就只是噪音。
                入口是**紧贴本卡上沿**的那个按钮（`coding-view-task-toggle`，文案「看看要做什么」）。
             ⚠️ 编辑器宿主（`.code__editor`）的尺寸归属不变：这里改的是**父级网格**，
                不碰那个盒子（`tests/code-editor-mount.test.ts` 钉着）。 -->
        <div class="code__work">
          <!-- 浮层位置自己算：不把 `position: absolute` 直接加在 SurfacePanel 上 ——
               它的 `.sf` 带 `position: relative`，同权重谁生效取决于样式注入顺序（本项目踩过）。
               浮窗只在打开时挂进 DOM：关掉它连内容一起离场，不留不可见的大块。 -->
          <div v-if="briefOpen" class="code__brief-float">
          <SurfacePanel
            class="code__task"
            tone="float"
            padding="md"
            role="region"
            aria-label="任务简报"
            data-testid="coding-view-task"
          >
            <header class="code__task-head">
              <FileText :size="15" />
              <span class="code__task-title">任务简报</span>
              <el-tag size="small" type="info" effect="plain">{{ code.template?.language ?? 'python' }}</el-tag>
              <!-- 关闭键：浮窗盖在代码上，必须一眼能关掉（Esc 之外的第二条路，且能点到） -->
              <button
                type="button"
                class="chip code__brief-close"
                data-testid="coding-view-task-close"
                title="收起任务简报"
                @click="briefOpen = false"
              >
                <X :size="13" />
              </button>
            </header>

            <!-- 任务名 = **块标题档（16px）**。不得回到 22px：那是身份行的档位。 -->
            <!-- ★★ 2026-09-30 用户反馈「看不懂任务简报想让我干什么」→ 整块重写为
                 「一、要做的是什么；二、代码里要动哪几处；三、做完长什么样」这个顺序。
                 此前那三行（做到这样就算完成 / 对应知识点 / 要补的 TODO）读起来像一张规格表：
                 标题是知识点名（学生早就知道自己在哪一关），却没有一句说清要写什么代码。
                 ⚠️ 文案纪律：不写 TODO 这类开发词当标题（写成「要补的地方」），
                    技术词只留在代码注释里（脚手架原文不动）。 -->
            <h2 class="code__name" data-testid="coding-view-task-name">
              {{ taskTitle === '' ? '还没有选题目' : taskTitle }}
            </h2>

            <template v-if="code.template !== null">
              <!-- ① 要做什么：模板作者写在脚手架第一行的「目标：…」（抽不到就整行不渲染） -->
              <p v-if="taskGoal !== ''" class="code__goal" data-testid="coding-view-task-goal">
                {{ taskGoal }}
              </p>
              <!-- ② 要动哪几处：把「TODO」翻成学生读得懂的说法 + 下一步动作 -->
              <p class="code__desc" data-testid="coding-view-task-todos">
                代码里已经搭好了架子，留了 <b class="k12-num">{{ todoCount }}</b> 处要补的地方（代码里标着
                <code class="code__mono">TODO</code>），把它们补完再点「运行」。
              </p>
              <!-- ③ 做完长什么样：程序真实应当打印的东西（等宽块，因为它是程序输出） -->
              <div v-if="expectedOutputText !== ''" class="code__expected">
                <span class="block__label">做完以后，程序会打印</span>
                <pre class="block__code" data-testid="coding-view-task-expected">{{ expectedOutputText }}</pre>
              </div>
              <!-- 元信息：这是哪一课（学生排障 / 老师看课时要的，不占主视线）。
                   ⚠️ 只在**真的取到中文名**时渲染：这里曾经直接摆 `prog-loop-jr` 这种 slug，
                   学生对着一串英文短横线只会以为软件坏了。 -->
              <p v-if="taskNameResolved" class="code__task-meta" data-testid="coding-view-task-point">
                对应知识点：{{ taskName }}
              </p>
            </template>
            <p v-else-if="code.templateLoading" class="code__desc">正在读这一题的脚手架…</p>
            <!-- ★ 到不了这里的分支留一句兜底（真正没题时走上面的空态）：
                 不解释机制，只说下一步。 -->
            <p v-else class="code__desc">在左边「课程总览」里选一关，这里就会出现那一题的要求。</p>
          </SurfacePanel>
          </div>

          <!-- 内边距走 SurfacePanel 的枚举（报告 §4.2）：md = sp-4（16px，8 点网格） -->
          <SurfacePanel class="code__panel" padding="md">
          <header class="code__panel-head">
            <span class="code__panel-title">代码</span>
            <!-- 状态角标：`title` 里那句「第一次点运行时才准备环境」= 学生在意但不该占位的信息 -->
            <span
              class="chip"
              :data-phase="runnerStatus.phase"
              :title="pyodideBadge.title"
              data-testid="coding-view-pyodide"
            >
              {{ pyodideBadge.text }}
            </span>
            <span v-if="code.hintLoading" class="chip">正在取提示…</span>
            <!-- 「边写边问」：打开悬浮追问窗（与动画页同一个入口形态）。
                 它是**次要动作**，所以不进 `.code__actions` 那一行 ——
                 那一行里的「运行」才是这一屏唯一的主色填充（一屏一个主行动）。 -->
            <button
              type="button"
              class="chip code__ask"
              data-testid="coding-view-ask"
              title="打开追问窗，边写边问"
              @click="askAboutTask"
            >
              边写边问
            </button>
          </header>

          <!-- ★ 这里是 Monaco 的宿主（异步组件 `AsyncCodeEditor` 自己装配）。
               ⚠️ 本块只在「有活干」（`editorVisible`）时渲染 —— 原来它靠 `v-show` 常驻 DOM
                  来保证挂载那一刻宿主存在，现在空态是**整栏的另一个分支**，宿主会跟着这一支
                  一起出现/消失。异步组件跟着这一支一起挂载，装配时机天然跟着它走 ——
                  文件末尾那个 watch 只剩「补一次 layout」这一个职责。 -->
          <div class="code__editor-wrap">
            <!-- ★★ 尺寸盒子必须由**本页**给（2026-09-27 真机事故的修复）。
                 事故现象：编辑区只剩一条黑边。根因不是 Monaco，而是样式归属 ——
                 把 `class="code__editor"`（`height: 420px`）挂在异步组件上时，它会与
                 `CodeEditor.vue` 自己的 `.code-editor{width:100%;height:100%}` **同权重**，
                 而那份 CSS 随 chunk **后加载** → `100%` 赢；外层 `.code__editor-wrap`
                 高度是 auto 时，100% 就解析成内容高度（实测 5px）。
                 修法：尺寸挂在本页自己的普通盒子上，异步组件的 100% 永远有确定的父高度。
                 ⚠️ 不许把 `class="code__editor"` 挪回 `<AsyncCodeEditor>` 上
                 （守卫：`tests/code-editor-mount.test.ts`）。
                 ⚠️ 装配失败时整块收起：固定高度的盒子会把下面那句说明顶出
                 `overflow: hidden`，学生就只剩一片空白。 -->
            <div v-if="editorFailure === ''" class="code__editor">
              <!-- ★ 异步组件（报告 §5.1）：chunk 在途时由它自己的 loadingComponent 顶上；
                   下面那层骨架覆盖的是 **Monaco 内核装配**那一段等待（同一个骨架组件）。 -->
              <AsyncCodeEditor
                ref="editorRef"
                data-testid="coding-view-editor"
                :value="code.draft"
                @ready="onEditorReady"
                @failure="onEditorFailure"
                @change="onEditorChange"
              />
            </div>
            <CodeEditorSkeleton v-if="!editorReady && editorFailure === ''" class="code__editor-skeleton" />
            <p v-if="editorFailure" class="code__brief-err" data-testid="coding-view-editor-failure">
              <AlertTriangle :size="14" />{{ editorFailure }}
            </p>
          </div>

          <!-- 操作栏。★ 原型上那个「提交批改」按钮**刻意不在这里**：
               本项目没有教师批改端点（批改只有后端判客观题 `/api/quiz/grade` 与
               本页的报错归一 `/api/code/run-hint` 这两条真实通道），所以与其摆一个
               永远只会假装转 900ms 的按钮，不如不给 —— 要请老师看代码，真实路径是
               在对话里说「帮我看看这段代码」（模型经 `evaluate_code` 走的那条线）。
               ★★ 按钮走设计系统：几何 / 字重 / 焦点环 / 禁用观感全部来自 `.k12-cta`
               （`assets/base.css` 里**唯一**的一套主行动配方，不再各页自己调色）。
                 · 「运行」= 这一屏的主行动（做完它这一轮就算完成）→ 实心主色，**只此一个**；
                 · 「求助」= 同一条路上的第二步 → 沿用 `.k12-cta` 的几何与交互态，
                   填充改成描边（`code__act--quiet`）。base.css 的判据写得很明白：
                   「同一屏里只允许一个主色填充按钮 —— 两个等于没有主色按钮」；
                 · 「重置代码」= 次要动作 → 保持 Element Plus 的默认观感（不给主色）。
               ★ 「求助」的 label **就是两个字**（走查 1.4 / C12）：提示分级机制（下一级是第几级）
                 进 `title`（`hintButtonTitle`），不占主行动的 label ——
                 学生要的是「点一下会有人帮我」，不是「这个提示栈还有几格」。
               ⚠️ 空态里的「重新读模板」也用 `.k12-cta`，但它与这里**不同屏**
                 （空态是整栏的另一个分支，见上面的 `EmptyState`）：同一屏仍然只有一个主色按钮。 -->
          <div class="code__actions">
            <button
              class="k12-cta"
              type="button"
              :disabled="running || code.template === null"
              data-testid="coding-view-run"
              @click="run"
            >
              {{ running ? '正在运行…' : '运行' }}
            </button>
            <button
              class="k12-cta code__act--quiet"
              type="button"
              :disabled="running || code.hintLoading || !code.canAskMoreHints"
              :title="hintButtonTitle"
              data-testid="coding-view-hint"
              @click="askForHint"
            >
              {{ code.hintLoading ? '正在取提示…' : code.canAskMoreHints ? '求助' : '提示已给完' }}
            </button>
            <el-button :disabled="running || code.template === null" data-testid="coding-view-reset" @click="resetToScaffold">
              <RotateCcw :size="14" />
              <span class="btn__label">重置代码</span>
            </el-button>
            <span v-if="attempts > 0" class="code__attempts k12-num">第 {{ attempts }} 次运行</span>
          </div>


          <p v-if="localHint" class="code__local-hint" data-testid="coding-view-local-hint">{{ localHint }}</p>
          <p v-if="code.hintError" class="code__local-hint" data-testid="coding-view-hint-error">
            {{ code.hintError }}
          </p>

          <!-- ── 运行结果：本地产出的原文 + 后端给的中文反馈 ───────────────── -->
          <section v-if="result !== null" class="out" data-testid="coding-view-output">
            <header class="out__head">
              <span class="chip" :class="result.ok ? 'chip--ok' : 'chip--warn'" data-testid="coding-view-verdict">
                {{ verdictLabel }}
              </span>
              <span class="chip k12-num" data-testid="coding-view-elapsed">
                {{ formatRunMeta(result.elapsedMs, result.interrupted) }}
              </span>
              <span v-if="code.analyzing" class="chip">正在请后端分析…</span>
            </header>

            <!-- 运行器故障（不是学生的报错）：单独一条，别和学生报错混在一起 -->
            <p v-if="localFailure" class="out__failure" data-testid="coding-view-runner-failure">
              {{ localFailure }}
            </p>

            <!-- ★ 后端归一化后的中文解释：界面上的主角 -->
            <p v-if="result.error" class="out__error" data-testid="coding-view-error">
              {{ result.error.type }}：{{ result.error.message }}
              <span v-if="result.error.line !== null && result.error.line !== undefined">
                （第 {{ result.error.line }} 行）
              </span>
            </p>
            <p v-if="result.feedback" class="out__feedback" data-testid="coding-view-feedback">
              {{ result.feedback }}
            </p>

            <!-- stdout：程序真实打印出来的东西 -->
            <div v-if="result.stdout" class="block">
              <span class="block__label">程序输出</span>
              <pre class="block__code" data-testid="coding-view-stdout">{{ result.stdout }}</pre>
            </div>

            <!-- ★ 原始 traceback 默认折叠：给学生看的是中文解释，原文留给家长 / 老师排查 -->
            <details v-if="result.rawTraceback" class="raw" data-testid="coding-view-raw-details">
              <summary>原始报错（给老师 / 家长看）</summary>
              <pre class="block__code" data-testid="coding-view-traceback">{{ result.rawTraceback }}</pre>
            </details>

            <p v-if="result.nextHint" class="out__next" data-testid="coding-view-next-hint">
              <span class="chip chip--accent">第 {{ result.nextHint.level }} 级提示</span>
              {{ result.nextHint.hint }}
            </p>

            <p v-if="code.analyzeError" class="out__failure" data-testid="coding-view-analyze-error">
              这一轮的反馈没拿到：{{ code.analyzeError }}（上面的运行输出是真的，不受影响）
            </p>
          </section>

          <!-- ── 已给过的分级提示：1 → 2 → 3 累积显示 ─────────────────────── -->
          <section v-if="code.hints.length > 0" class="hints" data-testid="coding-view-hints">
            <span class="block__label">已给的提示（越往下越具体）</span>
            <ol class="hints__list">
              <li
                v-for="hint in code.hints"
                :key="hint.level"
                class="hint"
                :data-level="hint.level"
                data-testid="coding-view-hint-item"
              >
                <span class="chip chip--accent">第 {{ hint.level }} 级</span>
                <span class="hint__text">{{ hint.hint }}</span>
              </li>
            </ol>
          </section>

          <p v-if="code.bridgeError" class="code__brief-err" data-testid="coding-view-bridge-error">
            <AlertTriangle :size="14" />{{ code.bridgeError }}
          </p>
        </SurfacePanel>
        <!-- ↑ 关掉 `.code__work`：**运行结果 / 提示 / 页脚那句安全声明留在网格外**，
             它们在宽屏下横跨整列（输出比简报更需要宽度，不该被挤进 300px 的那一格）。 -->
        </div>

        <!-- ── 运行说明 ──────────────────────────────────────────────────────
             ★★ **全应用只此一处**常驻安全声明（走查 C7）：同一件事原来写了三遍
             （左栏「代码在哪里执行 · 安全边界」折叠块 + 本句 + 对话卡脚注），
             三遍里学生一遍都不会记住。现在：
               · 左栏那个折叠块**整块删除**（报告 4.3 也要求左栏只留导航 + 路径）；
               · 对话卡 `cards/CodingCard.vue` 只留「求助会把你的几行发给智团团」那条**行为告知**
                 （它是另一件事，不是这句的复读）。
             ⚠️ 想再加一处同义声明之前，先回答「这一处为什么不够」。
             ★★ 这一行为什么必须分开写两版（本条是受众分离的落点）：
             原来它直接摆在页面上，写的是「代码经 POST /api/code/run-hint 之外的两条本地链路完成：
             执行在本页的 Pyodide Worker 里，报错归一与提示挑选在后端 —— 发送给模型的内容里不含
             你的运行输出」。这是**设计说明**（HTTP 动词、端点路径、Worker、什么没发给模型），
             学生读了只会想「我是不是哪里搞错了」；它同时是「设计合理性」的证据，不能删。
             所以分成两层：
               · 学生看见的那一句 —— 只留**他真正在意的两个承诺**，学生话；
               · 原句 —— 原样进 `<TeacherGate>`（学生视角下不在 DOM 里）。
             ⚠️ 这两句都逐条对着代码核过（只说自己真的做到的事）：
               ① 「只在这台电脑上运行」= 渲染进程的 Pyodide Worker，资源本地自托管
                  （`sandbox/pyodide-runner.ts`，无 CDN 引用）；
               ② 「不会上传」= 没有任何一条链路把代码送出这台机器（sidecar 只监听**回环地址**，
                  不对局域网开放 —— 地址本身只在主进程的 `sidecar/manager.ts` 里出现）；
               ③ 「结果只用来给你中文解释」= 本页的运行结果只走 `code:run-hint` →
                  `/api/code/run-hint`，那个端点只做报错归一与提示挑选，**不调用任何 LLM**
                  （`server/app/routes/code.py` 连 `exec` / `subprocess` 都不 import）。
             ⚠️ **刻意不写「不会发给智团团」**：那句话在**本页**成立（本页的「求助」只送
                `kpId + level`，见 `stores/code.ts` 的 `askForHint`），但学生在对话里
                点编程卡的「求助」时走的是另一条路（`buildHintRequestMessage` 会带上
                代码前 400 字）—— 同一句话在一个地方成立、在另一个地方不成立，
                就不该印在面板上。**本页这句话是准确的**：执行在本机沙箱、
                运行结果只送到本机 sidecar 做报错归一（那个端点不调 LLM）。 -->
        <p class="code__foot-note" data-testid="coding-view-run-locally">
          你的代码只在<strong>这台电脑上</strong>运行，不会上传；运行结果只用来给你中文解释。
        </p>
        <TeacherGate>
          <p class="code__foot-note" data-testid="coding-view-run-note-teacher">
            代码经 <code class="code__mono">POST /api/code/run-hint</code> 之外的两条本地链路完成：
            执行在本页的 Pyodide Worker 里，报错归一与提示挑选在后端 ——
            发送给模型的内容里不含你的运行输出。
          </p>
        </TeacherGate>
      </template>
    </section>
  </div>
</template>

<style scoped>
.code {
  display: flex;
  height: 100%;
  min-height: 0;
}
/* 左栏只剩**导航**（课程总览 → 模块 → 关卡），任务简报搬到主工作区了（见 `.code__work`）。 */
.code__brief {
  --el-box-shadow-light: none;
  --el-box-shadow: var(--k12-shadow-float);

  width: 268px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 16px;
  border-right: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  overflow-y: auto;
}
/* ── 面包屑（吸顶操作栏的 info 位）─────────────────────────────────
 * 位置信息用 meta 档（12px）：它回答的是「我在哪」，不是这一屏的主角
 * （主角是「做到这样算完成」那张卡）。 */
.code__crumb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.code__crumb-sep {
  color: var(--k12-muted-2);
}
/* 最后一级（当前关卡）用正文色 + 600 字重：其余是「路过的层级」。 */
.code__crumb-now {
  font-weight: 600;
  color: var(--k12-fg-2);
}
/* ── 主工作区：代码区独占整列（任务简报是**浮层**，不占列）──────────
 * ★★ 2026-09-30 用户裁决：简报收进悬浮窗（默认关闭）→ 代码区拿回整列宽度。
 *   此前 ≥1440 是「简报 240–300px + 代码」两列，编辑器因此窄了近 300px。
 * ★ `position: relative` 是**浮层的定位上下文**（`.code__brief-float` 相对它定位）。
 * ⚠️ 这里只改**父级网格**：`.code__editor` 的高度仍钉在它自己那个盒子上
 *   （`tests/code-editor-mount.test.ts` 盯着，Monaco 塌成 5px 那次事故就是这么来的）。 */
.code__work {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--k12-gap);
  align-items: start;
}
/* 任务简报浮层：贴主工作区右上角，限宽限高（内容超出时内部滚动）。
 * ★ 盖在代码上是有意的：它是「需要时瞄一眼」，不需要时学生一键收起（`.code__brief-close`）。
 * ★ `z-index: 6` 大于编辑器宿主（1）与骨架（1），小于吸顶操作栏那一档。 */
.code__brief-float {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 6;
  width: min(360px, 100%);
  max-height: 100%;
  overflow-y: auto;
}
/* 关闭键：靠右对齐（卡头里除它之外都是左对齐的信息）。 */
.code__brief-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  padding: 3px 7px;
  cursor: pointer;
}
.code__task {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.code__task-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
}
.code__task-title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 任务名 = **块标题档**。不得回到 22px：那是身份行的档位。 */
.code__name {
  font-size: var(--k12-fs-body-lg);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
}
.code__desc {
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
/* 任务说明入口：单独一行、右对齐，紧贴代码卡片上沿。 */
.code__brief-entry {
  display: flex;
  justify-content: flex-end;
}
/* 入口按钮：几何沿用 `.k12-cta`（与「运行 / 求助」同档），填充走 quiet 变体。 */
.code__brief-open {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* ①「这次的目标」：模板作者写给学生的原话 —— 正文档（它是简报里最该被读到的一句）。 */
.code__goal {
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg);
}
/* ③「做完以后，程序会打印」：与运行输出那一块同族（`block__label` + `block__code`）。 */
.code__expected {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* 元信息（对应知识点）：meta 档灰字，不抢主视线。 */
.code__task-meta {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.code__brief-err {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-warn);
}
.code__brief-err svg {
  flex: none;
  margin-top: 2px;
}
.code__mono {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-accent-ink);
}
/* ⚠️ 2026-09-30：`.code__desc-list`（el-descriptions 键值表）随简报重写一起删了 ——
 *   那张表把「做到这样就算完成 / 对应知识点 / 要补的 TODO」摆成规格表，学生读完仍不知道
 *   要写什么。现在是「目标 → 要补几处 → 做完打印什么」的叙事顺序，不再需要它。 */
.code__sec {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 2px 0 0;
}
.code__sec-label {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.code__sec-note {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

/* ── 课程总览：按教材章节分块（模块 → 关卡）──────────────────────────
 * ★ 原来的写法是「按 stage 分两组平铺」：正在学那组就是几十关的一堵墙 ——
 *   学生既看不出自己在哪一坨，也看不出这一坨走完了没有。
 *   现在先出现几个**模块头**（`第一章的标题  3 / 7`），展开才是关卡。
 * ★ 模块名来自教材 `chapterTitle`，顺序来自服务端拓扑序（本页都不重排）。 */
.mods {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: -6px;
}
/* 顶部进度块：一屏里**唯一**说「我通关了几关」的地方（模块头上的 N/M 是它的分块读数）。 */
.mods__total {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
}
.mods__done {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.mods__go {
  flex: none;
}
.mod {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
/* 模块头：可点的折叠开关（`.k12-tap` 保底 28px 触控高度）。
 * ★ 常态就带底 + 边：它是**导航里的一个块**，不是纯文字标签 ——
 *   旧实现的「已经走过 N 关」是透明底，看着像一句说明而不是能点的东西。 */
.mod__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .mod__head:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}
/* 展开中的模块：accent 淡底 + accent 边（与「关卡被选中」是同一种材质） */
.mod__head[data-open='true'] {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}
/* 箭头：收起时向右、展开时向下 —— 形状本身说明「里面还有东西」。 */
.mod__ico {
  flex: none;
  color: var(--k12-muted);
  /* 状态过渡（不是入场动效）：与 `ProgressBar` / `ConfirmDialog` 同一口径，
   * `prefers-reduced-motion` 下关掉 —— 方向本身仍由旋转角度表达，信息不丢。 */
  transition: transform var(--k12-dur-state) var(--k12-ease-state);
}
.mod__head[data-open='true'] .mod__ico {
  color: var(--k12-accent-ink);
}
.mod__ico[data-open='true'] {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-k12-reduced-motion='off']) .mod__ico {
    transition: none;
  }
}
.mod__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mod__count {
  flex: none;
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-muted);
}
.mod__head[data-open='true'] .mod__count {
  color: var(--k12-accent-ink);
}
.path {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.path__btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-fg-2);
  /* ★ 列表项按字号阶梯是 **sm（14px）**，不是 meta 档 —— 关卡名是学生要读的内容
   *   （原来这里是 `--k12-fs-xs` 13px，与「列表项 = 14px」那条档位不符）。 */
  font-size: var(--k12-fs-body-sm);
  text-align: left;
  cursor: pointer;
  min-height: 30px;
}
@media (hover: hover) and (pointer: fine) {
.path__btn:hover:not(:disabled) {
  background: var(--k12-surface);
  border-color: var(--k12-border);
}
}
.path__btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
/* ★★ 只有**两态**（已通关 / 可作答），且差异落在颜色上：
 * 已通关 = 绿点 + 绿名 + 一个勾；可作答 = 中性灰点 + 常规字色。
 * ⚠️ 为什么不给「可作答」强调色：后端播种时**每一关都是 `learning`**
 *   （2026-09-25 起没有锁定态），给这一档上强调色 = 57 关全强调
 *   （旧实现正是如此，于是「状态」等于没有状态）。
 *   当前这一关的高亮由 `.path__item--on` 单独给（那是选中，不是进度）。 */
.path__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--k12-muted-2);
}
.path__item[data-stage='quizzed'] .path__dot,
.path__item[data-stage='mastered'] .path__dot {
  background: var(--k12-good);
}
.path__item[data-stage='quizzed'] .path__name,
.path__item[data-stage='mastered'] .path__name {
  color: var(--k12-good);
}
.path__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 已通关的勾（与绿点是同一件事的第二个通道：形状 + 颜色） */
.path__tick {
  flex: none;
  color: var(--k12-good);
}
/* 「当前」：只落在**正在做的那一关**上（不是进度档，是选中档） */
.path__now {
  flex: none;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-accent-ink);
}
/* 当前这一题：accent-soft 底 + accent 边 —— 与「哪一关在学」是两件事，所以两种标记都在 */
.path__item--on .path__btn {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.path__item--on .path__name {
  color: var(--k12-accent-ink);
  font-weight: 650;
}

/* ── 「卡住了怎么办」：**毛玻璃圆角块**（2026-09-30 用户裁决）────────────────
 * 报告 C11 / 4.3 当时把它去框、退成普通说明文字，理由是「它原来用 warn 底 + warn 边，
 * 和真警报（`.code__brief-err`）长得一样」。用户裁决改回**有底**，但换一种底：
 *   · 中性毛玻璃面（`.k12-glass`，base.css 那条唯一配方）+ 圆角 + 卡片影；
 *   · **不再用告警色** —— 当初的问题是「像警报」，不是「有框」。
 * 它沉在左栏底部，是学生卡住时唯一要找的那句话，值得一块独立的底把它从导航里拎出来。
 * ⚠️ 分层仍走 D-106 三件套（底色差 + 一支线 + 单侧影），不靠加色。 */
.code__hint-note {
  display: flex;
  gap: 9px;
  /* 不支持 backdrop-filter 的环境退回**实色**（下面的 @supports 会覆盖这一条），
     否则半透明底会把下面的导航文字透上来（可读性事故）。 */
  background: var(--k12-surface);
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-card);
  box-shadow: var(--k12-shadow-card);
  padding: 12px 14px;
  /* ★ 贴在左栏**底部**：任务简报搬走之后，导航下面会空出一截 ——
     这一块沉到底部，既填空，又保证它**一直在**（学生滚代码区时抬头就能看见）。 */
  margin-top: auto;
}
/* ⚠️ 毛玻璃配方不直接用全局的 `.k12-glass`：本组件的 scoped 规则带属性选择器，
 *   权重高于那个单类全局规则 —— 实测会把它的半透明底压回不透明（blur 也就白做了）。
 *   所以照 `FloatPanel.vue` / `ConfirmDialog.vue` 的既有做法在本文件里写一份：
 *   **blur 参数与 base.css 一致**（12px / saturate 1.4），不透明度按表面分档。
 *   ★ 72%：四档里最透的一档 —— 它背后是**平板色的左栏**，没有内容经过，
 *   卡片感靠边框 + 卡片影撑，不需要靠不透明度（分档表见 base.css 的 `.k12-glass`）。 */
@supports (backdrop-filter: blur(1px)) {
  .code__hint-note {
    background: color-mix(in srgb, var(--k12-surface) 72%, transparent);
    backdrop-filter: blur(12px) saturate(1.4);
  }
}
.code__hint-ico {
  flex: none;
  margin-top: 2px;
  /* 图标取强调色：它是这一块里唯一的视觉锚点（文字保持正文墨色）。 */
  color: var(--k12-accent-ink);
}
/* 标题：正文档 + 700 —— 原来 12px/650/muted 在毛玻璃底上读起来发灰。 */
.code__hint-title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 700;
  color: var(--k12-fg);
}
/* 正文：正文档 + `--k12-fg`（不是 muted）—— 用户要求「鲜艳显眼、可读性高」。 */
.code__hint-text {
  margin-top: 3px;
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg);
}
/* 「求助」是这句话的动作词：强调色 + 700，但不做按钮（按钮在右栏，这里只是指路）。 */
.code__hint-key {
  color: var(--k12-accent-ink);
  font-weight: 700;
}

/* ── 主区 ──────────────────────────────────────────────────────────── */
.code__stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 兄弟块是「操作栏 / 身份行 / 卡片 / 脚注」，按契约用卡片之间那一档（16px）。
   * ⚠️ 内边距（18 / 22 / 20）必须与 PageActions 的默认 `--pa-pad-y/x` 一致，
   *    否则吸顶时会漏出/盖住内容。 */
  gap: var(--k12-gap);
  /* 优化报告 §1.2：18/22/20 → 16/24/24（8 点网格）。 */
  padding: var(--k12-sp-4) var(--k12-sp-5) var(--k12-sp-5);
  overflow-y: auto;
}
.code__panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.code__panel-title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 角标（≤4 字）→ 11px 档；其余 chip 都落 12px */
.chip {
  padding: 2px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
}
.chip[data-phase='ready'],
.chip--ok {
  background: var(--k12-good-soft);
  color: var(--k12-good);
}
.chip[data-phase='loading'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
/* 「边写边问」：chip 形态的**按钮**（次要动作，与旁边的状态角标同一行）。
 * ⚠️ 它是按钮不是角标：必须有 border + cursor + 够点的高度 —— 角标是只读记号，
 *   这里要能按（`min-height` 不用写死：padding 撑出来的高度已 ≥28px，
 *   由 `ux:pages` 的触控目标断言兜底）。 */
.code__ask {
  border: 1px solid var(--k12-border);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .code__ask:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
.chip[data-phase='failed'],
.chip--warn {
  background: var(--k12-bad-soft);
  color: var(--k12-bad);
}
.chip--accent {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}

.code__editor-wrap {
  /* 骨架是**覆盖层**（见 `.code__editor-skeleton`）：这里必须是定位上下文，
   * 否则骨架会排在编辑器下面，把右栏撑高一倍。 */
  position: relative;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-inset);
  overflow: hidden;
  /* 深色面：Monaco 固定 vs-dark（报告 §5.1 的主题精简），外框与编辑器同底才没有色缝 */
  background: var(--k12-editor-bg);
}
/* ★ 420px 的由来（与 `sandbox/monaco-setup.ts` 的 lineHeight 24 + padding 上下各 8 配套）：
 *   (420 − 8 − 8) ÷ 24 ≈ 16 行 —— 一份模板的脚手架通常 10–20 行，
 *   一屏基本能看全，补 TODO 时不用来回滚（360px 只剩 14 行，首屏就要滚）。
 * ⚠️ 这个数是**容器高度**（Monaco 不带 `automaticLayout`，靠本页的 ResizeObserver 量这个盒子），
 *   改它要连同 `editorOptions()` 的 lineHeight 一起想：行高变了，同样的高度看到的行数就变了。
 * ⚠️ 页面纵向是 `.code__stage` 自己在滚（`overflow-y: auto`），所以这里长高只会让页面多滚一点，
 *   不会把内容挤出视口（`npm run ux:layout` 量的是横向裁切，与这里无关）。
 * ★★ 这个 `height` **必须**挂在本页自己的 `<div class="code__editor">` 上（模板里有说明）：
 *   挂到异步组件 `<AsyncCodeEditor>` 上时，会被它自己**随 chunk 后加载**的
 *   `.code-editor{height:100%}` 同权重覆盖 → 外层高度是 auto 时编辑器塌成几像素
 *   （2026-09-27 真机事故：编辑区只剩一条黑边）。 */
.code__editor {
  width: 100%;
  /* ★ 420px 仍是**基准高度**：Monaco 的 100% 靠它解析（守卫 `code-editor-mount.test.ts`
   *   逐字钉着这个数）。2026-09-30 用户裁决「编辑器尽量放大」→ 用 `min-height` 按视口抬高：
   *   高窗口里编辑区跟着长，矮窗口里退回基准，不会再出现「编辑器只占半屏」。
   *   上限 820px 是给超大窗口的：再高就超出「一屏看全一份脚手架」的需要。 */
  height: 420px;
  min-height: clamp(420px, calc(100vh - 420px), 820px);
}
/* Monaco 内核装配中：骨架盖住编辑区（不占第二块高度） */
.code__editor-skeleton {
  position: absolute;
  inset: 0;
}
.code__actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
/* ★ 次要动作变体（「求助」）：几何、字重、焦点环、禁用观感**全部沿用 `.k12-cta`**
 *   （base.css 的那份配方是唯一来源，这里只换「填充」这一件事）。
 *   ⚠️ 选择器写成 `.k12-cta.code__act--quiet...` 是**刻意**的：`.k12-cta` 与
 *      本类是**同权重**的单类选择器，谁生效取决于样式表顺序（构建产物说了算）；
 *      加上 `.k12-cta` 与 `:not(:disabled)` 把权重抬到一定高于 base.css 那一支。 */
.k12-cta.code__act--quiet {
  border-color: var(--k12-accent-border);
  background: var(--k12-surface);
  color: var(--k12-accent-ink);
}
@media (hover: hover) and (pointer: fine) {
  .k12-cta.code__act--quiet:hover:not(:disabled) {
    border-color: var(--k12-accent-ink);
    background: var(--k12-accent-soft);
  }
}
.k12-cta.code__act--quiet:disabled {
  border-color: var(--k12-border-strong);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
}
.code__attempts {
  margin-left: auto;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.code__local-hint {
  margin-top: 8px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-warn);
}

/* ── 运行结果 ──────────────────────────────────────────────────────── */
.out {
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
}
.out__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.out__feedback {
  margin-top: 8px;
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  white-space: pre-wrap;
  word-break: break-word;
}
.out__error {
  margin-top: 8px;
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-bad);
}
.out__failure {
  margin-top: 8px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-bad);
}
.out__next {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--k12-border-strong);
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.out__next .chip {
  margin-right: 6px;
}
.block {
  margin-top: 10px;
}
.block__label {
  display: block;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
  margin-bottom: 4px;
}
.block__code {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}
.raw {
  margin-top: 10px;
}
.raw summary {
  cursor: pointer;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.raw summary:hover {
  color: var(--k12-fg-2);
}

/* ── 分级提示 ──────────────────────────────────────────────────────── */
.hints {
  margin-top: 12px;
}
.hints__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
}
.hint__text {
  flex: 1;
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  word-break: break-word;
}

.code__foot-note {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}

/* 导出回执：与操作行同一屏，紧跟在按钮区下面（学生刚点完就在手边） */
.code__download-note {
  margin-top: var(--k12-sp-2);
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
  word-break: break-all;
}
</style>
