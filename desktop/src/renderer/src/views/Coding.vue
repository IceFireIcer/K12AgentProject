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
 * ── 布局（改动前先读）────────────────────────────────────────────────
 *
 *   左 268px 任务简报（要做什么 / 学习路径 / 分级求助 / 机制说明折叠）
 *   右侧主区（操作栏 → 身份行 → 编辑器 + 运行 + 输出 + 提示）
 *
 * 内容区的最大字号（22px）落在身份行上：任务名 16px（块标题档）、正文 13–14px、
 * meta 12px —— 「这页在干什么」永远比「这题叫什么」重。
 *
 * ★ 为什么不再复用 `cards/CodingCard.vue`：那张卡片的入参是**对话里的一张卡**
 *   （`InlineCard`），数据来自 `payload` 事件；本页没有那张卡，数据来自上面那几条取数端点。
 *   两处各写一份会立刻分叉（同一件事两份实现），所以本页自己装配编辑器与运行区，
 *   而**共用**同一套底层件：`monaco-setup.ts` / `pyodide-runner.ts` / `cards/coding.ts` 的纯函数。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertTriangle, Check, Download, FileText, FlaskConical, Lightbulb, RotateCcw } from 'lucide-vue-next'
import PageIdentity from '@/components/PageIdentity.vue'
import { useCodeStore, CODE_HINT_MAX } from '../stores/code'
import { useKnowledgeStore } from '../stores/knowledge'
import { useQuizStore } from '../stores/quiz'
import { createCodeEditor, observeEditorResize, type CodeEditorHandle } from '../sandbox/monaco-setup'
import {
  runStudentCode,
  runnerStatusSnapshot,
  subscribeRunnerStatus,
  type RunnerStatus
} from '../sandbox/pyodide-runner'
import { formatRunMeta } from '../cards/coding'

const code = useCodeStore()
const quiz = useQuizStore()
const knowledge = useKnowledgeStore()

/* ------------------------------------------------------------------ *
 * 题目从哪来：学生的**学习路径**（真实取数，不是写死的三步）
 * ------------------------------------------------------------------ */

/** 关卡顺序与阶段由服务端决定（依赖图拓扑序）——本页只显示，不重排、不推断。 */
const levels = computed(() => quiz.levels)
const selectedKpId = ref('')

/**
 * 关卡阶段的中文名（措辞与 `cards/ProgressCard.vue` 里那张表一致，全站一个说法）。
 * 认不出的阶段按「未解锁」显示 —— 不猜「大概已经通过了」（那是在给学生假进度）。
 */
const STAGE_LABELS: Record<string, string> = {
  locked: '未解锁',
  learning: '学习中',
  quizzed: '已通过',
  mastered: '已掌握'
}

/** 知识点中文名（来自教材知识库；取不到就如实显示 kp id，不编一个名字）。 */
function kpName(kpId: string): string {
  // `points` 在契约里是可选的（`KnowledgePointListResponse.points?`）—— 缺省当空清单，
  // 于是取不到名字时如实退回 kp id（与 store 的 `filteredPoints` 同一口径）。
  const point = (knowledge.points?.points ?? []).find((item) => item.kpId === kpId) ?? null
  return point?.name ?? ''
}

function levelLabel(kpId: string): string {
  return kpName(kpId) || kpId
}

/** 当前题目的显示名：优先教材里的名字，其次 kp id（mono 显示）。 */
const taskName = computed(() => {
  const kpId = code.template?.kpId ?? code.activeKpId
  if (kpId === '') return ''
  return levelLabel(kpId)
})

/** 脚手架里的 TODO 处数（真实数出来的；填完它们就是这一题的目标）。 */
const todoCount = computed(() => (code.template?.scaffold.match(/TODO/g) ?? []).length)

/** 本页的尝试计数（第几次运行）——`attempt` 决定后端给哪一级提示，所以必须自己数对。 */
const attempts = ref(0)
/** 已经拿到分析结果的那一次尝试号（对不上就说明反馈是上一次的，不该冒充这一次）。 */
const analyzedAttempt = ref(0)

/**
 * 读学习路径 + 知识点名，并**默认打开第一个已解锁的关卡**。
 *
 * ★ 默认值不猜：`levels` 里 `stage !== 'locked'` 的第一条就是学生现在该做的那一关；
 *   一个都没有（路径全锁 / 读不到）时**什么都不选**，界面显示诚实的空态。
 */
async function loadPath(): Promise<void> {
  await Promise.all([quiz.loadProgress(), knowledge.loadPoints()])
  if (selectedKpId.value !== '') return
  const first = levels.value.find((level) => level.stage !== 'locked') ?? null
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
  editor?.setValue(scaffold)
}

/* ------------------------------------------------------------------ *
 * 编辑器：Monaco（懒加载，卸载时释放）
 * ------------------------------------------------------------------ */

const editorHost = ref<HTMLElement | null>(null)
/** 非响应式：编辑器句柄只在装配 / 释放时进出。 */
let editor: CodeEditorHandle | null = null
let stopResizeObserver: (() => void) | null = null
const editorReady = ref(false)
/** 装配失败时的可读说明（**绝不白屏**：脚手架会以只读文本顶上）。 */
const editorFailure = ref('')

/**
 * 装配 Monaco（异步：内部才动态 import，vite 因此把它切成独立 chunk）。
 *
 * ★ 这里是「进编程页才加载 Monaco」的落点 —— 对话为主的应用不该为这一页付启动成本。
 */
async function mountEditor(): Promise<void> {
  if (editor !== null) return
  await nextTick()
  const host = editorHost.value
  if (host === null) return
  try {
    editor = await createCodeEditor({
      container: host,
      value: code.draft,
      theme: 'vs',
      // 学生的改动**只回写 store**（页面内存里的一份草稿，不落库、不进会话、不上传）
      onChange: (value) => {
        code.draft = value
      }
    })
    stopResizeObserver = observeEditorResize(host, editor)
    editorReady.value = true
    editorFailure.value = ''
    // ★ 装配是异步的，期间模板可能已经读回来了 —— 再对齐一次，
    //   免得出现「编辑器空着、store 里已经有脚手架」这种两边不一致的状态。
    if (editor.getValue() !== code.draft) editor.setValue(code.draft)
  } catch (error) {
    editorFailure.value = `代码编辑器没能加载起来：${
      error instanceof Error ? error.message : String(error)
    }（下面的脚手架可以手动复制出去练）`
  }
}

onBeforeUnmount(() => {
  stopResizeObserver?.()
  stopResizeObserver = null
  unsubscribeStatus?.()
  unsubscribeStatus = null
  editor?.dispose()
  editor = null
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

const pyodideBadge = computed(() => {
  const status = runnerStatus.value
  if (status.phase === 'ready') {
    const seconds = status.loadMs === null ? null : (status.loadMs / 1000).toFixed(1)
    return seconds === null ? 'Python 就绪' : `Python 就绪（${seconds} s）`
  }
  if (status.phase === 'loading') return '正在准备 Python 环境…'
  if (status.phase === 'failed') return 'Python 环境不可用'
  return 'Python 待加载（第一次点运行时才加载）'
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
  editor?.setReadOnly(true)

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
    editor?.setReadOnly(false)
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

/** 回到这一题的起点（脚手架）。草稿会丢，所以只在学生自己按的时候做。 */
function resetToScaffold(): void {
  code.resetToScaffold()
  editor?.setValue(code.draft)
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
 * 下载（前端就能做，所以它是真的：Blob + a[download]）
 * ------------------------------------------------------------------ */

const downloaded = ref(false)

/**
 * 下载当前代码（.py）。
 *
 * ★ 文件头用的是**真实模板信息**：题目名（教材里的中文名，取不到就 kp id）与
 *   `expectedBehavior` 都来自 `useCodeStore()`，不是原型里那份假数据。
 * ★ 之前那个「1.5 秒后把按钮文字还原」的计时器一并删掉了 —— 按钮状态由学生的动作驱动，
 *   装一个定时器只为了演一下「我变回去了」，是本轮要清掉的那种假动作。
 */
function downloadCode(): void {
  const template = code.template
  if (template === null) return
  const header = `# ${levelLabel(template.kpId)}\n# 期望效果：${template.expectedBehavior}\n\n`
  const blob = new Blob([header + code.draft], { type: 'text/x-python;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${template.kpId}.py`
  anchor.click()
  URL.revokeObjectURL(url)
  downloaded.value = true
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

onMounted(() => {
  // 订阅共享运行器的状态（懒加载耗时是有价值的证据：进页面才开始拉 wasm）
  unsubscribeStatus = subscribeRunnerStatus((status) => {
    runnerStatus.value = status
  })
  void mountEditor()
  void loadPath()
})

// 模板到位后把脚手架推进编辑器（编辑器还没装配好时由它自己的兜底对齐负责）
watch(
  () => code.template?.scaffold ?? '',
  (scaffold) => {
    if (scaffold !== '' && editor !== null && editor.getValue() !== scaffold) editor.setValue(scaffold)
  }
)
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
          <el-descriptions-item label="对应知识点">{{ code.template.kpId }}</el-descriptions-item>
          <el-descriptions-item label="脚手架里的 TODO">{{ todoCount }} 处</el-descriptions-item>
        </el-descriptions>
      </template>
      <p v-else-if="code.templateLoading" class="code__desc">正在读这一题的脚手架…</p>
      <p v-else-if="code.templateError" class="code__brief-err" data-testid="coding-view-template-error">
        <AlertTriangle :size="14" />{{ code.templateError }}
      </p>
      <p v-else class="code__desc">从下面的学习路径里选一关，就会读来对应的脚手架。</p>

      <section class="code__sec">
        <span class="code__sec-label">学习路径</span>
        <!-- ★ 这一块是原型里那份写死的「完成步骤」的**真实版本**：顺序与阶段都来自
             服务端的闯关进度（按依赖图拓扑序排好），本页只显示、不重排。 -->
        <p class="code__sec-note">
          {{ levels.length }} 关 · 顺序与是否解锁由闯关闭环决定；点一关就换到那一题。
        </p>
      </section>

      <ul v-if="levels.length > 0" class="path" data-testid="coding-view-path">
        <li
          v-for="level in levels"
          :key="level.kpId"
          class="path__item"
          :data-stage="level.stage"
          :class="{ 'path__item--on': level.kpId === selectedKpId }"
        >
          <button
            v-if="level.stage !== 'locked'"
            type="button"
            class="path__btn"
            :data-testid="`coding-view-level-${level.kpId}`"
            :data-active="level.kpId === selectedKpId ? 'true' : 'false'"
            :disabled="running"
            @click="openTask(level.kpId)"
          >
            <span class="path__dot" aria-hidden="true" />
            <span class="path__name">{{ levelLabel(level.kpId) }}</span>
            <span class="path__stage">{{ STAGE_LABELS[level.stage] ?? level.stage }}</span>
          </button>
          <div v-else class="path__btn path__btn--locked" :data-testid="`coding-view-level-${level.kpId}`">
            <span class="path__dot" aria-hidden="true" />
            <span class="path__name">{{ levelLabel(level.kpId) }}</span>
            <span class="path__stage">{{ STAGE_LABELS.locked }}</span>
          </div>
        </li>
      </ul>
      <p v-else-if="quiz.progressLoading || knowledge.pointsLoading" class="code__desc">正在读学习路径…</p>
      <p v-else class="code__brief-err" data-testid="coding-view-path-error">
        <AlertTriangle :size="14" />
        {{ quiz.progressError ?? quiz.bridgeError ?? '学习路径里还没有关卡 —— 先去对话里问几句，让它把学段判出来。' }}
      </p>

      <div class="code__hint-note">
        <Lightbulb :size="15" />
        <div>
          <p class="code__hint-title">分级求助</p>
          <p class="code__hint-text">
            卡住时用右侧的「求助」，提示按 1 → {{ CODE_HINT_MAX }} 逐级给，不会一次把答案说满。
            第 {{ CODE_HINT_MAX }} 级才会给出完整写法。
          </p>
          <p v-if="code.currentHintLevel > 0" class="code__hint-text" data-testid="coding-view-hint-progress">
            已给到第 {{ code.currentHintLevel }} 级（最多 {{ CODE_HINT_MAX }} 级）。
          </p>
        </div>
      </div>

      <!-- ── 机制 / 合规说明：默认折叠（不是每轮都要读，但接线时是硬约束）──── -->
      <el-collapse class="code__fold">
        <el-collapse-item name="runtime">
          <template #title>
            <span class="code__fold-t"><FlaskConical :size="14" />代码在哪里执行 · 安全边界</span>
          </template>
          <p class="code__fold-p">
            代码在<strong>本机浏览器的 Pyodide Web Worker</strong> 里执行（带超时中断）：
            既不进应用主进程，也不进 Python 数据服务，运行完只把 stdout / stderr 交给后端。
          </p>
          <p class="code__fold-p">
            后端那个端点<strong>不执行任何代码</strong>：它只把报错翻译成中文、挑下一级提示 ——
            「谁能跑代码」与「谁解释报错」因此是两条互不相通的线。
          </p>
          <p class="code__fold-p">
            编辑器是 Monaco（资源随包分发，断网可用）；第一次点「运行」时才加载 Python 运行环境。
          </p>
        </el-collapse-item>
      </el-collapse>
    </aside>

    <!-- 右：主区。PageActions 在这个滚动容器内 → 吸顶有效。 -->
    <section class="code__stage">
      <PageActions>
        <template #info>
          <span v-if="code.template !== null">
            题目 {{ code.template.kpId }} · 期望 <code class="code__mono">{{ code.template.expectedBehavior }}</code>
          </span>
          <span v-else>还没有可做的题目</span>
        </template>
        <el-button
          v-if="code.templateError !== null"
          @click="openTask(selectedKpId !== '' ? selectedKpId : code.activeKpId, true)"
        >
          <RotateCcw :size="14" />
          <span class="btn__label">重新读模板</span>
        </el-button>
        <el-button :disabled="code.template === null" data-testid="coding-view-download" @click="downloadCode">
          <Check v-if="downloaded" :size="14" />
          <Download v-else :size="14" />
          <span class="btn__label">{{ downloaded ? '已下载' : '下载代码' }}</span>
        </el-button>
      </PageActions>

      <!-- 身份行（22px，全页唯一）：说的是「这页在干什么」，不是重复顶栏的「编程环境」。 -->
      <PageIdentity
        main="在这里把刚才学的写成代码"
        meta="代码在学生机本地执行，不上传"
        hint="先看任务要求，再在下面补全 TODO 并运行"
      />

      <SurfacePanel class="code__panel" padding="14px 16px">
        <header class="code__panel-head">
          <span class="code__panel-title">代码</span>
          <span class="chip" :data-phase="runnerStatus.phase" data-testid="coding-view-pyodide">
            {{ pyodideBadge }}
          </span>
          <span v-if="code.hintLoading" class="chip">正在取下一级提示…</span>
        </header>

        <div class="code__editor-wrap">
          <div ref="editorHost" class="code__editor" data-testid="coding-view-editor"></div>
          <!-- 编辑器没装配好（还在加载 / 加载失败）时，脚手架以只读文本顶上 —— 保底可读 -->
          <pre
            v-if="!editorReady"
            class="code__scaffold"
            data-testid="coding-view-scaffold-raw"
          >{{ code.draft }}</pre>
          <p v-if="editorFailure" class="code__brief-err" data-testid="coding-view-editor-failure">
            <AlertTriangle :size="14" />{{ editorFailure }}
          </p>
        </div>

        <!-- 操作栏。★ 原型上那个「提交批改」按钮**刻意不在这里**：
             本项目没有教师批改端点（批改只有后端判客观题 `/api/quiz/grade` 与
             本页的报错归一 `/api/code/run-hint` 这两条真实通道），所以与其摆一个
             永远只会假装转 900ms 的按钮，不如不给 —— 要请老师看代码，真实路径是
             在对话里说「帮我看看这段代码」（模型经 `evaluate_code` 走的那条线）。 -->
        <div class="code__actions">
          <el-button
            type="primary"
            :loading="running"
            :disabled="running || code.template === null"
            data-testid="coding-view-run"
            @click="run"
          >
            {{ running ? '正在运行…' : '运行' }}
          </el-button>
          <el-button
            :loading="code.hintLoading"
            :disabled="running || code.hintLoading || !code.canAskMoreHints"
            data-testid="coding-view-hint"
            @click="askForHint"
          >
            {{
              code.canAskMoreHints
                ? `求助（下一级：第 ${Math.min(code.currentHintLevel + 1, CODE_HINT_MAX)} 级）`
                : '提示已给完'
            }}
          </el-button>
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

      <p class="code__foot-note">
        代码经 <code class="code__mono">POST /api/code/run-hint</code> 之外的两条本地链路完成：
        执行在本页的 Pyodide Worker 里，报错归一与提示挑选在后端 ——
        发送给模型的内容里不含你的运行输出。
      </p>
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
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 任务名 = **块标题档**。不得回到 22px：那是身份行的档位。 */
.code__name {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
}
.code__desc {
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.code__brief-err {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-warn);
}
.code__brief-err svg {
  flex: none;
  margin-top: 2px;
}
.code__mono {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-accent-ink);
}
.code__desc-list {
  margin-top: -2px;
}
/* 键值对的标签与取值都是 meta：12px（EP 默认 14px 在 268px 的简报里比正文还重）。 */
.code__desc-list :deep(.el-descriptions__label),
.code__desc-list :deep(.el-descriptions__content) {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
}
.code__sec {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 2px 0 0;
}
.code__sec-label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.code__sec-note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

/* ── 学习路径（原型的「完成步骤」的真实版本）────────────────────────── */
.path {
  list-style: none;
  margin: -6px 0 0;
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
  font-size: var(--k12-fs-xs);
  text-align: left;
  cursor: pointer;
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
 * 已通过 / 已掌握 = 实心绿点；学习中 = accent 空心环；未解锁 = 灰空心点 */
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
.path__btn--locked {
  color: var(--k12-muted);
  cursor: default;
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
  font-size: var(--k12-fs-xs);
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

.code__hint-note {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-radius: var(--k12-r-card);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
  color: var(--k12-warn);
}
.code__hint-note svg {
  flex: none;
  margin-top: 2px;
}
.code__hint-title {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-warn);
}
.code__hint-text {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

/* ── 折叠：机制 / 合规说明（默认折叠，标题 13px / 内容 12px）────────── */
.code__fold {
  border: none;
}
.code__fold :deep(.el-collapse-item__header) {
  min-height: 44px;
  line-height: var(--k12-lh-ui);
  border-top: 1px solid var(--k12-border);
  border-bottom: none;
}
.code__fold :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}
.code__fold-t {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.code__fold :deep(.el-collapse-item__content) {
  padding-bottom: 12px;
}
.code__fold-p {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.code__fold-p + .code__fold-p {
  margin-top: 6px;
}
.code__fold-p strong {
  color: var(--k12-fg);
  font-weight: 650;
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
  padding: 18px 22px 20px;
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
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 角标（≤4 字）→ 11px 档；其余 chip 都落 12px */
.chip {
  padding: 2px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
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
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-inset);
  overflow: hidden;
  background: var(--k12-surface);
}
.code__editor {
  width: 100%;
  height: 360px;
}
/* Monaco 未就绪时的脚手架回显（**保底可读**，不是空白） */
.code__scaffold {
  margin: 0;
  padding: 12px;
  min-height: 140px;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--k12-fg-2);
}
.code__actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.code__attempts {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.code__local-hint {
  margin-top: 8px;
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  white-space: pre-wrap;
  word-break: break-word;
}
.out__error {
  margin-top: 8px;
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-bad);
}
.out__failure {
  margin-top: 8px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-bad);
}
.out__next {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--k12-border-strong);
  font-size: var(--k12-fs-sm);
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  word-break: break-word;
}

.code__foot-note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}
</style>
