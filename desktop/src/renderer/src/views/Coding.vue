<script setup lang="ts">
/**
 * 编程环境页 —— 对话内联编程卡的**展开视图**。
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
 *   左 268px 任务简报（要做什么 / 学习路径（分两组收起）/ 一句「卡住了怎么办」）
 *   右侧主区：**无题时只有一块空态**（一个主行动 + 一句话，报告 1.6）；
 *             有题时（或在装配编辑器）才排满态框架：
 *             操作栏 → 身份行 → 编辑器 + 运行 + 输出 + 提示 → 页脚那句安全声明。
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
  RotateCcw
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
import { formatRunMeta } from '../cards/coding'
// ★ 「拿不到中文名时显示什么」的唯一口径是 `study/kp-label.ts`：有名字用名字，
//   没名字用中性的「未命名知识点」（原始 id 只进 `title` 悬停可见）——
//   绝不退回 `prog-loop-jr` 这种 slug（学生看到只会以为报错）。这套规则原本在三页各写一份。
import { kpLabel, kpLabelResolved } from '../study/kp-label'

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

/** 关卡顺序与阶段由服务端决定（依赖图拓扑序）——本页只显示，不重排、不推断。 */
const levels = computed(() => quiz.levels)
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

/** 本页的尝试计数（第几次运行）——`attempt` 决定后端给哪一级提示，所以必须自己数对。 */
const attempts = ref(0)
/** 已经拿到分析结果的那一次尝试号（对不上就说明反馈是上一次的，不该冒充这一次）。 */
const analyzedAttempt = ref(0)

/* ------------------------------------------------------------------ *
 * 学习路径的分组：整条路径有几十关，平铺出来就是一堵墙
 * ------------------------------------------------------------------ */

/**
 * ★ 分组的目的只有一个：**「我做过什么 / 接下来做什么」要一眼能答**。
 *
 * 分组只按**服务端给的 stage** 切，顺序仍是服务端的拓扑序（本页不重排）。
 * ★★ 2026-09-25 去掉关卡锁定：原来那第三组「还没解锁」（点不动的关卡）整组删掉 ——
 *   所有关卡都能点开练习。剩下两组仍有信息价值，默认开合不变：
 *   · 「正在学」默认展开 —— 它就是「接下来做什么」，学生一进页面要直接看到；
 *   · 「已经走过」默认收起 —— 它回答的是过去，关数会越攒越多。
 *   两组都是可点的按钮（键盘可达）。
 */
const openLevels = computed(() => levels.value.filter((level) => level.stage === 'learning'))
const doneLevels = computed(() =>
  levels.value.filter((level) => level.stage === 'quizzed' || level.stage === 'mastered')
)
const showDone = ref(false)

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
  return '在左边的「学习路径」里点一关，这里就会出现那一题的代码骨架。标着 TODO 的地方就是你要补的地方。'
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
  const header = `# ${levelLabel(template.kpId)}\n# 期望效果：${template.expectedBehavior}\n\n`
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
    <!-- 左：任务简报。**收窄到 268px** —— 它是必要的任务上下文（保留），
         但不许挤住编辑区；省下的宽度全给右侧。 -->
    <aside class="code__brief">
      <header class="code__brief-head">
        <FileText :size="15" />
        <span class="code__brief-title">任务简报</span>
        <el-tag size="small" type="info" effect="plain">{{ code.template?.language ?? 'python' }}</el-tag>
      </header>

      <!-- 任务名 = **块标题档（16px）**。不得回到 22px：那是身份行的档位。 -->
      <h2 class="code__name" data-testid="coding-view-task-name">
        {{ taskName === '' ? '还没有选题目' : taskName }}
      </h2>

      <template v-if="code.template !== null">
        <el-descriptions :column="1" size="small" border class="code__desc-list">
          <el-descriptions-item label="做到这样就算完成">
            <code class="code__mono">{{ code.template.expectedBehavior }}</code>
          </el-descriptions-item>
          <!-- ★ 「对应知识点」只在**真的取到中文名**时出现。
               ⚠️ 这里原本直接摆 `code.template.kpId`（`prog-loop-jr` 这种 slug）——
               学生对着一串英文短横线只会以为软件坏了。名字取不到就**整行不显示**：
               摆一个「未命名知识点」在这里没有增量信息（任务名那一行已经在说同一件事了）。 -->
          <el-descriptions-item v-if="taskNameResolved" label="对应知识点">
            {{ taskName }}
          </el-descriptions-item>
          <el-descriptions-item label="要补的 TODO">{{ todoCount }} 处</el-descriptions-item>
        </el-descriptions>
      </template>
      <p v-else-if="code.templateLoading" class="code__desc">正在读这一题的脚手架…</p>
      <!-- ★ 模板读失败时这里**什么都不说**（走查 1.3）：原因与恢复动作一起放在右栏代码区里，
           学生不必跨栏找原因。任务简报只保留「这一题是什么」这一类上下文。 -->
      <p v-else class="code__desc">从下面的学习路径里选一关，就会读来对应的脚手架。</p>

      <section class="code__sec">
        <span class="code__sec-label">学习路径</span>
        <!-- ★ 这一块是原型里那份写死的「完成步骤」的**真实版本**：顺序与阶段都来自
             服务端的闯关进度（按依赖图拓扑序排好），本页只显示、不重排。
             ★ 进度数字**只有一种格式**（报告 2.3）：`已掌握 N / M`。
               下面两组的标题（正在学 / 已经走过）是**导航分组**，不是第二个指标 ——
               原来这里那句「共 N 关 · 已经走过 N 关 · 正在学 N 关 · 还有 N 关没解锁」
               把同一批数字又说了一遍，已删。
             ★ 没有关卡时整行不显示（空态下不该出现「已掌握 0 / 0」这种仪表盘读数）。 -->
        <p
          v-if="levels.length > 0"
          class="code__sec-note"
          data-testid="coding-view-path-summary"
        >
          已掌握 {{ doneLevels.length }} / {{ levels.length }}
        </p>
      </section>

      <!-- ── 学习路径：按 stage 分两组（正在学默认展开，「已经走过」默认收起）────
           `data-testid="coding-view-path"` 落在**外层容器**上：两组共用它，
           于是「这一页有没有路径」这个判断与分组细节无关（分组以后还会再调）。 -->
      <div v-if="levels.length > 0" class="pathgrps" data-testid="coding-view-path">
        <!-- ① 正在学（默认展开 —— 这就是「接下来做什么」） -->
        <section v-if="openLevels.length > 0" class="pathgrp">
          <p class="pathgrp__label">正在学（{{ openLevels.length }} 关）</p>
          <ul class="path">
            <li
              v-for="level in openLevels"
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
                :title="levelNameResolved(level.kpId) ? undefined : level.kpId"
                :disabled="running"
                @click="openTask(level.kpId)"
              >
                <span class="path__dot" aria-hidden="true" />
                <span class="path__name">{{ levelLabel(level.kpId) }}</span>
                <span class="path__stage">{{ stageLabel(level.stage) }}</span>
              </button>
            </li>
          </ul>
        </section>

        <!-- ② 已经走过（默认收起：它回答的是过去，关数只会越攒越多） -->
        <section v-if="doneLevels.length > 0" class="pathgrp">
          <button
            type="button"
            class="pathgrp__toggle k12-tap"
            :aria-expanded="showDone"
            data-testid="coding-view-path-done-toggle"
            @click="showDone = !showDone"
          >
            <ChevronRight :size="13" class="pathgrp__ico" :data-open="showDone" aria-hidden="true" />
            已经走过 {{ doneLevels.length }} 关
          </button>
          <ul v-show="showDone" class="path">
            <li
              v-for="level in doneLevels"
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
                :title="levelNameResolved(level.kpId) ? undefined : level.kpId"
                :disabled="running"
                @click="openTask(level.kpId)"
              >
                <span class="path__dot" aria-hidden="true" />
                <span class="path__name">{{ levelLabel(level.kpId) }}</span>
                <span class="path__stage">{{ stageLabel(level.stage) }}</span>
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
      <div
        class="code__hint-note"
        title="提示是一级一级给的：先是方向，再具体一点，最后一级才会把写法写全。"
      >
        <Lightbulb :size="15" />
        <div>
          <p class="code__hint-title">卡住了怎么办</p>
          <p class="code__hint-text">先自己想，想不出来再点右边的「求助」。</p>
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
              答不上来就会变成第二处同义声明（报告 4.3 也要求左栏只留任务简报 + 学习路径）。 -->
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
             「换一关」指的是左栏的学习路径，不在这里再排一个按钮（两个并列的主行动等于没有主行动）。 -->
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
            <!-- ★ 题目名用**教材里的中文名**（`taskName`），不再摆 `template.kpId` 那种 slug。 -->
            <span v-if="code.template !== null">
              题目 {{ taskName }} · 期望 <code class="code__mono">{{ code.template.expectedBehavior }}</code>
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

        <!-- 身份行（22px，全页唯一）：说的是「这页在干什么」，不是重复顶栏的「编程环境」。 -->
        <PageIdentity
          main="在这里把刚才学的写成代码"
          meta="代码在学生机本地执行，不上传"
          hint="先看任务要求，再在下面补全 TODO 并运行"
        />

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

        <!-- ── 运行说明 ──────────────────────────────────────────────────────
             ★★ **全应用只此一处**常驻安全声明（走查 C7）：同一件事原来写了三遍
             （左栏「代码在哪里执行 · 安全边界」折叠块 + 本句 + 对话卡脚注），
             三遍里学生一遍都不会记住。现在：
               · 左栏那个折叠块**整块删除**（报告 4.3 也要求左栏只留任务简报 + 学习路径）；
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
/* 简报：340px → **268px**。它有必要的任务上下文（保留），但不许挤住编辑区。 */
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
.code__brief-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
}
.code__brief-title {
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
.code__desc-list {
  margin-top: -2px;
}
/* 键值对的标签与取值都是 meta：12px（EP 默认 14px 在 268px 的简报里比正文还重）。 */
.code__desc-list :deep(.el-descriptions__label),
.code__desc-list :deep(.el-descriptions__content) {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
}
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

/* ── 学习路径（原型的「完成步骤」的真实版本）──────────────────────────
 * ★ 分两组：正在学（默认展开）/ 已经走过（默认收起）。
 *   原来的写法是 `levels.map` 平铺 57 关 —— 一堵墙，学生既找不到「我在哪」，
 *   也看不出「下一步是哪一关」。
 *   ★ 2026-09-25 去掉关卡锁定后不再有第三组「还没解锁」：每一关都能点开练习。
 *   分组只按服务端的 `stage`，顺序仍是服务端的拓扑序（本页不重排）。 */
.pathgrps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: -6px;
}
.pathgrp {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
/* 分组标签：meta 档 13px（不是 micro —— 它是标签不是角标）。 */
.pathgrp__label {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 收起/展开的开关：`.k12-tap` 保底 28px 触控高度（设计系统的共享下限）。 */
.pathgrp__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .pathgrp__toggle:hover {
    background: var(--k12-surface);
    border-color: var(--k12-border);
  }
}
/* 箭头：收起时向右、展开时向下（180° 旋转）—— 形状本身说明有更多内容。 */
.pathgrp__ico {
  flex: none;
  color: var(--k12-muted);
  /* 状态过渡（不是入场动效）：与 `ProgressBar` / `ConfirmDialog` 同一口径，
   * `prefers-reduced-motion` 下关掉 —— 方向本身仍然由旋转角度表达，信息不丢。 */
  transition: transform var(--k12-dur-state) var(--k12-ease-state);
}
.pathgrp__ico[data-open='true'] {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-k12-reduced-motion='off']) .pathgrp__ico {
    transition: none;
  }
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
/* 三态在**颜色与形状**上都不同，不只差一个图标：
 * 已通过 / 已掌握 = 实心绿点；学习中 = accent 空心环；认不出的阶段 = 灰空心点 */
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
.path__item[data-stage='learning'] .path__dot {
  background: transparent;
  box-shadow: inset 0 0 0 2px var(--k12-accent-ink);
}
.path__item[data-stage='quizzed'] .path__name,
.path__item[data-stage='mastered'] .path__name {
  color: var(--k12-good);
}
.path__item[data-stage='learning'] .path__name {
  color: var(--k12-accent-ink);
  font-weight: 650;
}
.path__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path__stage {
  flex: none;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
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

/* ── 「卡住了怎么办」：caption 档的说明文字，**不成框** ──────────────────
 * ★ 报告 C11 / 4.3：它原来是一个 warn 底 + 1px warn 边的圆角盒，和真正的警报
 *   （`.code__brief-err`）长一样 —— 而它说的只是「想不出来再点求助」。
 *   现在去框、去告警色，退成普通说明文字；提示分级机制在 `title` 里（模板上）。 */
.code__hint-note {
  display: flex;
  gap: 8px;
  color: var(--k12-muted);
}
.code__hint-note svg {
  flex: none;
  margin-top: 2px;
}
.code__hint-title {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.code__hint-text {
  margin-top: 2px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
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
  height: 420px;
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
