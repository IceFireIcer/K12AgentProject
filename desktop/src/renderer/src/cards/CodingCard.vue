<script setup lang="ts">
/**
 * 编程卡片（票 18/19）：Monaco 编辑器 + **Worker 内执行** + 中文反馈 + 分级求助。
 *
 * 数据流（三条入口，前端只负责"显示"与"发起"）：
 *
 *   模板卡片   ← `payload` 事件（`get_code_template` 的 details）→ 渲染 Monaco + 脚手架
 *   点「运行」  → **本卡片内**在 Pyodide Worker 里执行 → 立即显示真实 stdout/stderr
 *   反馈 / 提示 ← `payload` 事件（`evaluate_code` / `get_coding_hint` 的 details）
 *
 * 载荷的解释规则全在 `./coding`（纯函数、可单测，与 `cards/quiz.ts` 同一构型）。
 *
 * ★★ 四条红线（改这个文件前先读）：
 *
 * 1. **执行只发生在 Worker 里**（`sandbox/pyodide-runner.ts`）。
 *    本组件**不 import pyodide**、不 `eval` —— 它只调 `runStudentCode()`。
 *    学生代码在主线程执行会冻住界面；在主进程执行会击穿安全边界（执行文档 §12）。
 * 2. **原始 traceback 不直接展示给学生**：主角是后端翻译好的中文 `feedback`；
 *    原始报错默认折叠（`<details>`），留给家长/教师排查 —— 一屏红字会把学生吓退。
 * 3. **不给答案**：卡片只展示后端给的 `hint` 原文，**不做任何本地的"补充提示"**。
 *    连"跳过前两级直接要第三级"的口子都不提供（级别由主进程的状态表推进）。
 * 4. **失败也要可读**：Pyodide 没加载起来 / Worker 崩了 / 载荷认不出，
 *    一律退化成一句中文说明，**绝不白屏、绝不把异常抛到渲染树**。
 *
 * ★ 为什么「运行」不走对话（和练习卡片不一样）：练习判分必须走后端（答案在后端），
 *   而**代码执行**必须在渲染进程的 Worker 里 —— 这是沙箱边界规定的落点。
 *   所以"点运行 → 立刻看到输出"是本地的、离线的、可中断的；
 *   而"老师怎么讲这个错"由模型经既有对话输出给出（模型那边会调 `evaluate_code`）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { useKnowledgeStore } from '../stores/knowledge'
import type { InlineCard } from '../api/events'
import { createCodeEditor, observeEditorResize, type CodeEditorHandle } from '../sandbox/monaco-setup'
import { kpLabel } from '../study/kp-label'
import {
  runStudentCode,
  subscribeRunnerStatus,
  runnerStatusSnapshot,
  type RunnerStatus
} from '../sandbox/pyodide-runner'
import {
  buildHintRequestMessage,
  buildRunRequestMessage,
  collectHints,
  collectResult,
  formatRunMeta,
  hintRequestDisplayText,
  readCodingCard,
  retryCardDisplayText,
  retryRequestWireText,
  runRequestDisplayText
} from './coding'

const props = defineProps<{ card: InlineCard }>()
const chat = useChatStore()
const knowledge = useKnowledgeStore()

const view = computed(() => readCodingCard(props.card.payload))
const kpId = computed(() => (view.value.kind === 'unknown' ? '' : view.value.kpId))

/**
 * 卡片头上那个知识点 chip 的文字（**教材里的中文名**，不是 slug）。
 *
 * ★ 用 `study/kp-label.ts` 的共用规则（取不到名字给中性标签，不回落成 id）——
 *   与学习档案 / 闯关 / 依赖图同一条口径，不在这里另写一份兜底。
 * ★ 名字表可能还没取到（`knowledge.ensureNames()` 是异步的），所以这里**取不到就先不显示**
 *   那个 chip（`v-if="kpName"`）：一个空的 chip 比一个写着 `prog-loop-jr` 的 chip 好，
 *   而清单到齐之后它会自动出现。
 */
const kpName = computed(() => {
  const id = kpId.value
  if (id === '') return ''
  const name = kpLabel(id, null, knowledge.kpNameOf)
  return name === '未命名知识点' ? '' : name
})

/**
 * 整段对话里的卡片（提示与评估结果都可能在别的轮次里）。
 *
 * ★ 取 store 的 `cards`（**只在卡片增删时换引用**）而不是自己 `flatMap(turns)`：
 *   逐字增量会让 `turns` 每帧换引用，于是 `collectHints` / `collectResult` 会对
 *   全部卡片做一遍白名单投影，流式期间每秒上百次（见 `stores/chat.ts` 的说明）。
 */
const allCards = computed(() => chat.cards)
/** 该知识点已给出的分级提示（1→2→3 累积显示）。 */
const hints = computed(() => (kpId.value ? collectHints(allCards.value, kpId.value) : []))
/** 该知识点最新一次评估结果（跨轮回来；本地运行的结果优先显示）。 */
const remoteResult = computed(() => (kpId.value ? collectResult(allCards.value, kpId.value) : null))

/** 本地运行的结果（点「运行」立刻产生；优先于远端结果展示）。 */
const localResult = ref<{
  stdout: string
  stderr: string
  interrupted: boolean
  elapsedMs: number
  failure: string | null
} | null>(null)
/** 正在运行（禁用按钮，避免并发执行）。 */
const running = ref(false)
/** 本地提示（无编辑器、空代码之类），不是 `error` 事件。 */
const localHint = ref<string | null>(null)

const editorHost = ref<HTMLElement | null>(null)
let editor: CodeEditorHandle | null = null
let stopResizeObserver: (() => void) | null = null
/** 编辑器是否已就绪（模板卡片挂载后异步装配 Monaco）。 */
const editorReady = ref(false)
/** Monaco 装配失败时的可读说明（**绝不白屏**）。 */
const editorFailure = ref<string | null>(null)

/** Pyodide 加载状态（进卡片才开始加载，界面要能看出来）。 */
const runnerStatus = ref<RunnerStatus>(runnerStatusSnapshot())
let unsubscribeStatus: (() => void) | null = null

/** 展示用的结果：本地跑过就用本地的（更即时），否则用远端 payload 的。 */
const display = computed(() => {
  if (localResult.value) {
    return {
      ok: localResult.value.failure === null && localResult.value.stderr.trim() === '',
      stdout: localResult.value.stdout,
      stderr: localResult.value.stderr,
      interrupted: localResult.value.interrupted,
      elapsedMs: localResult.value.elapsedMs,
      failure: localResult.value.failure,
      feedback: remoteResult.value?.feedback ?? null,
      consecutiveFailures: remoteResult.value?.consecutiveFailures ?? 0,
      shouldIntervene: remoteResult.value?.shouldIntervene ?? false
    }
  }
  if (remoteResult.value) {
    return {
      ok: remoteResult.value.ok,
      stdout: remoteResult.value.stdout,
      // 远端结果里没有单独的 stderr 字段：原始报错在 error.rawTraceback 里
      stderr: remoteResult.value.error?.rawTraceback ?? '',
      interrupted: remoteResult.value.interrupted,
      elapsedMs: remoteResult.value.elapsedMs,
      failure: null,
      feedback: remoteResult.value.feedback,
      consecutiveFailures: remoteResult.value.consecutiveFailures,
      shouldIntervene: remoteResult.value.shouldIntervene
    }
  }
  return null
})

/** 连续失败到阈值时，界面上给出一条"老师要介入了"的提示（与模型的主动介入呼应）。 */
const interventionNotice = computed(() => {
  const result = display.value
  if (!result || result.ok || !result.shouldIntervene) return null
  return `你已经连续试了 ${result.consecutiveFailures} 次，老师这就帮你一起看看。`
})

/** 当前源码（编辑器里学生改过的版本）。 */
function currentCode(): string {
  if (editor) return editor.getValue()
  return view.value.kind === 'template' ? view.value.scaffold : ''
}

/** 装配 Monaco（模板卡片才需要；异步、失败可读）。 */
async function mountEditor(): Promise<void> {
  if (view.value.kind !== 'template') return
  await nextTick()
  const host = editorHost.value
  if (!host) return
  try {
    editor = await createCodeEditor({
      container: host,
      value: view.value.scaffold,
      theme: 'vs'
    })
    stopResizeObserver = observeEditorResize(host, editor)
    editorReady.value = true
    editorFailure.value = null
  } catch (error) {
    // ★ 装配失败不许白屏：给一句中文 + 仍然允许用「复制脚手架」的方式继续学
    editorFailure.value = `代码编辑器没能加载起来：${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

onMounted(() => {
  // 订阅共享运行器的状态（多张卡片同时挂着的场景下，每张都能收到更新）
  unsubscribeStatus = subscribeRunnerStatus((status) => {
    runnerStatus.value = status
  })
  // 知识点中文名（卡片头那个 chip）——**失败不阻断卡片**：取不到就不显示 chip，
  // 卡片其余部分照常可用（`ensureNames` 自己幂等，多张卡片同时调也只发一次）。
  void knowledge.ensureNames().catch(() => {})
})

/**
 * 卸载：释放编辑器与订阅（Worker 是窗口级共享的，交给整页卸载时统一收）。
 *
 * ★ 本卡片处在 `App.vue` 的 `<KeepAlive>` 里：切到设置页再回来时**编辑器内容与本地运行结果
 *   都还在**（正是 KeepAlive 的目的）。切走走的是 `onDeactivated`，这里只在真正卸载时执行；
 *   `onMounted` 也只跑一次，所以订阅不会重复注册。Monaco 在隐藏期间尺寸变 0、
 *   切回来后 ResizeObserver 会再报一次真实尺寸并触发 `layout()`，不会留下空白编辑器。
 */
onBeforeUnmount(() => {
  stopResizeObserver?.()
  stopResizeObserver = null
  unsubscribeStatus?.()
  unsubscribeStatus = null
  editor?.dispose()
  editor = null
})

// 模板变了（例如模型重新取了一次模板）：把编辑器内容换掉
watch(
  () => (view.value.kind === 'template' ? view.value.scaffold : null),
  (next) => {
    if (next && editor) editor.setValue(next)
  }
)

watch(
  () => view.value.kind,
  (kind) => {
    if (kind === 'template') void mountEditor()
  },
  { immediate: true }
)

/**
 * 点「运行」：**在 Worker 里执行**（本卡片自己跑，离线可用、可中断）。
 *
 * 三件事，按顺序：
 *   1. 懒加载 Pyodide（第一次点运行时才开始拉那 16 MB —— 票 18 的验收项）；
 *   2. 交给 Worker 执行（**主线程掌握超时并写 SIGINT**，死循环因此不冻界面）；
 *   3. 把结果落到 localResult 上显示（原始 stdout/stderr）。
 *
 * ★ 执行完再请模型讲一讲（`buildRunRequestMessage`）—— 那一步会调 `evaluate_code`，
 *   给出中文反馈、推进失败计数、并在需要时触发主动介入。
 *   那一步失败时（比如无 API Key），第 2 步的输出**已经显示出来了**，学生不会白等。
 */
async function run(): Promise<void> {
  const code = currentCode()
  if (code.trim().length === 0) {
    localHint.value = '先写一点代码，再点运行。'
    return
  }
  if (running.value) return

  localHint.value = null
  running.value = true
  // 运行期间锁住编辑器：避免"边跑边改"导致显示的输出与眼前的代码对不上
  editor?.setReadOnly(true)

  try {
    const outcome = await runStudentCode(code, {
      log: (line) => console.info(line)
    })
    localResult.value = {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      interrupted: outcome.interrupted,
      elapsedMs: outcome.elapsedMs,
      failure: outcome.failure ?? null
    }
  } catch (error) {
    // 兜底：`runStudentCode` 自己已收敛异常，这里防的是"兜底逻辑本身出错"
    localResult.value = {
      stdout: '',
      stderr: '',
      interrupted: false,
      elapsedMs: 0,
      failure: `运行失败：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    running.value = false
    editor?.setReadOnly(false)
  }

  // 真实输出已经显示了；再请模型给中文反馈（那一步失败不影响上面的展示）
  // ★★ 两个文本必须一起给（评审抓到的缺陷）：wire 里那句「请用 evaluate_code…不要直接给正确代码」
  //   是**写给模型的指令**，只准进 wire；学生气泡里显示的是 `runRequestDisplayText()` 那句自然的话。
  if (!chat.streaming) {
    void chat.send(runRequestDisplayText(), buildRunRequestMessage(kpId.value, code))
  }
}

/** 点「求助」：请主 Agent 给**下一级**提示（级别由主进程决定，前端不许指定）。 */
function askForHint(): void {
  if (chat.streaming) return
  const kpIdValue = kpId.value
  if (kpIdValue === '') {
    localHint.value = '这张卡片没有知识点信息，提示暂时给不出来。'
    return
  }
  localHint.value = null
  // ★ 同上：wire 里有内部指令，气泡里只显示学生语言（两个文本成对给出）。
  void chat.send(hintRequestDisplayText(), buildHintRequestMessage(kpIdValue, currentCode()))
}

/**
 * 卡片没画出来时的出口：请智团团**重新取一次**这个知识点的模板。
 *
 * ★ 这是学生自己能走的一条路（旧版只有一句"老师重新来一遍就好"，而他没有任何按钮）。
 * ★ wire 文本还是走同一条纪律（见 `buildHintRequestMessage` 的说明）：
 *   括号里那句是给模型看的指令；学生气泡里显示的是 `retryCardDisplayText()`。
 * ★ 读不出知识点 id 时不渲染按钮（模板里 v-if）—— 点了也不知道要重取哪一题。
 */
function retryCard(): void {
  const kpIdValue = view.value.kind === 'unknown' ? view.value.kpId : ''
  if (kpIdValue === '' || chat.streaming) return
  void chat.send(retryCardDisplayText(), retryRequestWireText(kpIdValue))
}

/** 重置为脚手架（学生改乱了之后想重来）。 */
function resetToScaffold(): void {
  if (view.value.kind !== 'template') return
  editor?.setValue(view.value.scaffold)
  localResult.value = null
  localHint.value = null
}

/** 把脚手架复制走（Monaco 装配失败时的兜底学习路径）。 */
async function copyScaffold(): Promise<void> {
  if (view.value.kind !== 'template') return
  try {
    await navigator.clipboard.writeText(view.value.scaffold)
    localHint.value = '脚手架已复制，可以粘到别处继续。'
  } catch {
    localHint.value = '复制没成功，可以手动选中脚手架代码再复制。'
  }
}

/**
 * 加载状态的展示文案（含懒加载耗时 —— 票 18 要求记录"进卡片才加载"的证据）。
 *
 * ★ 待加载那一档只说「什么时候能跑」（角标不该摆加载时机这类实现细节），
 *   与编程页 `views/Coding.vue` 的 `pyodideBadge` **同一口径**：
 *   两处同义角标写两种话，学生只会以为其中一个是另一种故障。
 *   细节（第一次点运行时才准备环境）进 `title`。
 */
const pyodideBadge = computed(() => {
  const status = runnerStatus.value
  if (status.phase === 'ready') {
    const seconds = status.loadMs === null ? null : (status.loadMs / 1000).toFixed(1)
    return {
      text: seconds ? `Python 就绪（${seconds} s）` : 'Python 就绪',
      tone: 'ok' as const,
      title: '可以点「运行」了。'
    }
  }
  if (status.phase === 'loading') {
    return { text: '正在准备 Python 环境…', tone: 'busy' as const, title: '正在准备运行环境，要等几秒。' }
  }
  if (status.phase === 'failed') {
    return { text: 'Python 环境不可用', tone: 'warn' as const, title: '运行环境没能起来，可以让老师看看。' }
  }
  return {
    text: '代码区就绪后可运行',
    tone: 'idle' as const,
    title: '运行环境会在你第一次点「运行」时准备，要等几秒。'
  }
})

/** ★ 中断能力自检结果（拿不到 SharedArrayBuffer 时必须如实告知"无法中断"）。 */
const interruptNotice = computed(() => {
  const capability = runnerStatus.value.capability
  if (capability && !capability.interruptible) {
    return '当前环境不支持中断死循环（将只等待代码自己结束）。'
  }
  return null
})
</script>

<template>
  <!-- 模板卡片：Monaco + 运行 / 求助 -->
  <article
    v-if="view.kind === 'template'"
    class="coding"
    data-testid="coding-card"
    :data-kp-id="view.kpId"
    :data-tool="card.tool ?? ''"
  >
    <header class="coding__head">
      <span class="title">编程练习</span>
      <!-- ★★ 这里原来直接印 `{{ view.kpId }}`（`prog-loop-jr` 这种 slug）——
           卡片在**对话正文里**，那是学生看得最多的地方，摆一个内部主键
           与走查那条「立刻隐藏所有 ID」正面冲突。改成教材里的中文名；
           取不到名字时**整个 chip 不出现**（不回落成 slug）。
           原始 id 仍在容器的 `data-kp-id` 上（排障与断言要用，但不渲染）。 -->
      <span v-if="kpName" class="chip tool" data-testid="coding-kp" :title="view.kpId">{{ kpName }}</span>
      <span
        class="chip"
        :class="`chip--${pyodideBadge.tone}`"
        :title="pyodideBadge.title"
        data-testid="coding-pyodide"
      >
        {{ pyodideBadge.text }}
      </span>
    </header>

    <p v-if="view.expectedBehavior" class="coding__goal" data-testid="coding-goal">
      <span class="coding__goal-label">做到这样就算完成：</span>{{ view.expectedBehavior }}
    </p>

    <!-- 编辑器宿主（Monaco 挂载点） -->
    <div class="coding__editor-wrap">
      <div ref="editorHost" class="coding__editor" data-testid="coding-editor"></div>
      <p v-if="editorFailure" class="coding__editor-failure" data-testid="coding-editor-failure">
        {{ editorFailure }}
      </p>
      <pre v-else-if="!editorReady" class="coding__scaffold" data-testid="coding-scaffold-raw">{{
        view.scaffold
      }}</pre>
    </div>

    <div class="coding__actions">
      <button
        class="btn btn--primary"
        type="button"
        data-testid="coding-run"
        :disabled="running || chat.streaming"
        @click="run"
      >
        {{ running ? '正在运行…' : '运行' }}
      </button>
      <button
        class="btn"
        type="button"
        data-testid="coding-help"
        :disabled="running || chat.streaming"
        @click="askForHint"
      >
        求助
      </button>
      <button class="btn" type="button" data-testid="coding-reset" @click="resetToScaffold">
        重置代码
      </button>
      <button
        v-if="editorFailure"
        class="btn"
        type="button"
        data-testid="coding-copy"
        @click="copyScaffold"
      >
        复制脚手架
      </button>
    </div>

    <p v-if="interruptNotice" class="coding__warn" data-testid="coding-interrupt-notice">
      {{ interruptNotice }}
    </p>

    <!-- 运行结果（点「运行」立刻出现） -->
    <section v-if="display" class="out" data-testid="coding-output">
      <header class="out__head">
        <span class="chip" :class="display.ok ? 'chip--ok' : 'chip--warn'" data-testid="coding-verdict">
          {{ display.ok ? '运行成功' : display.interrupted ? '已中断' : '运行失败' }}
        </span>
        <span class="chip" data-testid="coding-elapsed">
          {{ formatRunMeta(display.elapsedMs, display.interrupted) }}
        </span>
        <span v-if="display.consecutiveFailures > 0" class="chip" data-testid="coding-failures">
          连续失败 {{ display.consecutiveFailures }} 次
        </span>
      </header>

      <!-- 运行器故障（不是学生的报错）：单独一条，别和学生报错混在一起 -->
      <p v-if="display.failure" class="out__failure" data-testid="coding-runner-failure">
        {{ display.failure }}
      </p>

      <!-- ★ 中文反馈（后端翻译好的）：界面上的主角 -->
      <p v-if="display.feedback" class="out__feedback" data-testid="coding-feedback">
        {{ display.feedback }}
      </p>

      <!-- stdout：程序真实打印出来的东西 -->
      <div v-if="display.stdout" class="block">
        <span class="block__label">程序输出</span>
        <pre class="block__code" data-testid="coding-stdout">{{ display.stdout }}</pre>
      </div>

      <!-- ★ 原始 traceback 默认折叠：给学生看的是中文反馈，原文留给排查 -->
      <details v-if="display.stderr" class="raw" data-testid="coding-raw-details">
        <summary>原始报错（给老师/家长看）</summary>
        <pre class="block__code" data-testid="coding-stderr">{{ display.stderr }}</pre>
      </details>
    </section>

    <!-- ★ 分级提示：1→2→3 累积显示，越往后越具体 -->
    <section v-if="hints.length > 0" class="hints" data-testid="coding-hints">
      <span class="block__label">提示（越往下越具体）</span>
      <ol class="hints__list">
        <li
          v-for="hint in hints"
          :key="hint.level"
          class="hint"
          data-testid="coding-hint"
          :data-level="hint.level"
        >
          <span class="chip chip--accent" data-testid="coding-hint-level">第 {{ hint.level }} 级</span>
          <span class="hint__text" data-testid="coding-hint-text">{{ hint.hint }}</span>
        </li>
      </ol>
    </section>

    <p v-if="interventionNotice" class="coding__intervene" data-testid="coding-intervene">
      {{ interventionNotice }}
    </p>

    <p v-if="localHint" class="coding__hint" data-testid="coding-hint-local">{{ localHint }}</p>
    <!-- ★★ 这一行只剩下**真实的行为告知**（走查 C7：同一件安全承诺说三遍 = 一遍都记不住）。
         原来前半句还写着「代码在你电脑上的沙箱里运行，不会上传」，与编程页页脚那句重复；
         现在**全应用只留一处**常驻安全声明 = `views/Coding.vue` 页脚
         （`data-testid="coding-view-run-locally"`），这里不再复读。
         保留下来的这半句是**必须说**的（走查后修正、且 D-063 要求承诺与实际一致）：
         点「求助」会把**学生代码的前 400 字**发给智团团
         （见 `cards/coding.ts` 的 `buildHintRequestMessage` + `codePreview`）——
         一个把字面意思当真的 10 岁学生，若只读到「不会上传」就去点求助，
         会以为求助也是本地的。
         ⚠️ 改这句话之前先读 `buildHintRequestMessage`：它带 `codePreview(code)`。 -->
    <p class="coding__foot">
      点「求助」时，会把你写的那几行发给智团团看。它是靠这个帮你找问题的。
    </p>
  </article>

  <!-- ── 认不出的载荷：不猜内容，但**残余能读到的部分照样给学生** ──────────
       ★ 旧版这里是一句「编程卡片的内容格式不对，老师重新来一遍就好」——
         它把「格式不对」这种系统内部的话摆给了学生，而且一旦卡片没能渲染，
         学生连这题要干什么都看不到了。现在分三层：
         ① 有题目要求就照常显示（那是学习材料，不是调试信息）；
         ② 一句学生话说明「卡片这次没画出来」，配上能自己走的路（再出一遍 / 用话讲）；
         ③ 主进程给的排障原文只进 `data-*` 属性（与动画卡片的 `data-degrade-reason` 同一手法），
            脚本与排障能读到，学生不用看。 -->
  <article
    v-else-if="view.kind === 'unknown'"
    class="coding coding--unknown"
    data-testid="coding-card-unknown"
    :data-tool="card.tool ?? ''"
    :data-detail="view.text || null"
  >
    <header class="coding__head">
      <span class="title">编程练习</span>
      <span class="chip chip--warn">这张卡片这次没画出来</span>
    </header>
    <p v-if="view.task" class="coding__goal" data-testid="coding-unknown-task">
      <span class="coding__goal-label">这题要做的：</span>{{ view.task }}
    </p>
    <!-- ★ 这一句**永远是学生话**：编程侧的失败文本是写给模型/排障的
         （例如「取代码模板需要知识点 id…请先确认要练哪个知识点」），
         照搬进学生气泡就是又一份"开发者视角"。原文只进上面的 `data-detail`。 -->
    <p class="coding__fallback" data-testid="coding-unknown-notice">
      卡片里原来的代码框和运行按钮这次没能准备好。你可以点下面的按钮让智团团重出一遍，也可以直接问它「这道题用中文讲讲怎么做」。
    </p>
    <div class="coding__actions">
      <!-- ★ 读不出知识点 id 时不渲染（点了也不知道要重取哪道题 —— 那是假按钮） -->
      <button
        v-if="view.kpId"
        class="btn btn--primary"
        type="button"
        data-testid="coding-unknown-retry"
        :disabled="chat.streaming"
        @click="retryCard"
      >
        让智团团再出一遍
      </button>
    </div>
  </article>
</template>

<style scoped>
.coding {
  padding: 14px 16px;
  /* 卡片本体 → 卡片圆角；白面（paper）+ 可见边框 + 近距离投影，与 base.css 的 .k12-card 同配方 */
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-card);
}

.coding--unknown {
  border-style: dashed;
}

/* 卡片没画出来时给学生的说明：一句完整的、能照做的话 → 次级正文档
 * （与 `.coding__goal` 同一落点；不是红色报错 —— 这一条不是故障，是"这次没成"）。 */
.coding__fallback {
  margin-top: 10px;
  /* 说明文字是**给学生读的** → 次级正文档（与 `.coding__goal` 同档） */
  font-size: var(--k12-fs-sm);
  line-height: 1.8;
  color: var(--k12-muted);
}

/* ── 状态胶囊（角标语义）─────────────────────────────────────────────
 * ⚠️ 旧样式表留下过全局 `.chip` / `.chip--*`，它们**已随新设计系统整体移除**
 *   （`base.css` 只保留材质层与排版层）—— 模板里的类名照旧写着，于是这些胶囊
 *   一直是无样式渲染（无底色、无圆角、字号继承）。这里自带一份，配方与
 *   `ProgressCard` 的 `.chip` 一致（同一目录的兄弟卡片，视觉上必须同族）。
 * `.chip` 必须在 `.tool` **之前**：`.tool` 用同权重选择器覆盖字重与字号。 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
}

/* 运行成功 / Python 就绪：用「好」的语义色（浅底 + 深字，保证可读） */
.chip--ok {
  background: var(--k12-good-soft);
  border-color: var(--k12-good-border);
  color: var(--k12-good);
}

/* 正在准备（进行中，不是故障）：走主色，与下面的 --warn 明显分开 ——
 * 两者都撮成黄色的话，学生分不清「在加载」和「加载失败」。 */
.chip--busy {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}

/* 运行失败 / Python 环境不可用：这是**问题** → 用 bad 语义色 */
.chip--warn {
  background: var(--k12-bad-soft);
  border-color: var(--k12-bad-border);
  color: var(--k12-bad);
}

/* 待加载：中性态，不抢注意力 */
.chip--idle {
  background: var(--k12-surface-2);
  border-color: var(--k12-border-strong);
  color: var(--k12-muted);
}

.chip--accent {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}

.coding__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.title {
  /* 卡片标题：按语义走区块标题档（14px 的原值是正文档，对「标题」太轻） */
  font-size: var(--k12-fs-lg);
  font-weight: 650;
}

.tool {
  font-family: var(--k12-font-mono);
  /* 知识点 id：是 id 不是角标（长度也远超 4 字）→ meta 档，micro 档不适用 */
  font-size: var(--k12-fs-xs);
  font-weight: 500;
}

.coding__goal {
  margin-top: 8px;
  /* 学习目标：可读的说明文字（学生要照着做）→ 次级正文档 */
  font-size: var(--k12-fs-sm);
  line-height: 1.8;
  color: var(--k12-muted);
  word-break: break-word;
}

.coding__goal-label {
  font-weight: 650;
  color: var(--k12-fg);
}

.coding__editor-wrap {
  margin-top: 10px;
  border: 1px solid var(--k12-border-strong);
  /* 卡内嵌入块（编辑器外框）→ inset 档 */
  border-radius: var(--k12-r-inset);
  overflow: hidden;
  /* 白面：Monaco 的 vs 主题本身就是白底，这里必须同为 paper，否则外框与
   * 编辑器之间会露出一条色差缝 */
  background: var(--k12-surface);
}

.coding__editor {
  width: 100%;
  height: 300px;
}

/* Monaco 未就绪时的脚手架回显（**保底可读**，不是空白） */
.coding__scaffold {
  margin: 0;
  padding: 12px;
  min-height: 120px;
  font-family: var(--k12-font-mono);
  /* 旧值不在 8 档之内：等宽脚手架回显 → meta 档（与下面的代码块同一个落点） */
  font-size: var(--k12-fs-xs);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--k12-muted);
}

.coding__editor-failure {
  margin: 0;
  padding: 12px;
  /* 编辑器没起来时给学生看的说明 → 次级正文档（可读的失败说明，不是脚注） */
  font-size: var(--k12-fs-sm);
  line-height: 1.7;
  color: var(--k12-bad);
}

.coding__actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* ── 按钮 ────────────────────────────────────────────────────────────
 * ⚠️ 同上：全局 `.btn` / `.btn--primary` 已随旧样式表移除，模板里的类名
 *   一直是无样式渲染。这里自带一份（配方取自 `study/MistakesTab.vue` 的 `.btn`
 *   与 `ConfirmDialog` 的 `.cd__btn--primary`：填充色用 accent-ink —— 它是
 *   base.css 里指定的「按钮填充」那一支，accent 是画得好看的浅色，配白字读不清）。
 * 高度由 padding + line-height 决定，不钉像素 —— 字号抬升不会把它挤变形。 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover:not(:disabled) {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn--primary {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
}

.out {
  margin-top: 12px;
  padding: 10px 12px;
  /* 卡内嵌入块（结果面板）→ surface-2 底 + inset 圆角 */
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
}

.out__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.out__feedback {
  margin-top: 8px;
  /* 后端翻译好的中文反馈：这张卡片上的主角 → 次级正文档 */
  font-size: var(--k12-fs-sm);
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.out__failure {
  margin-top: 8px;
  /* 运行器故障说明：整句可读文案 → 次级正文档 */
  font-size: var(--k12-fs-sm);
  line-height: 1.7;
  color: var(--k12-bad);
}

.block {
  margin-top: 10px;
}

.block__label {
  display: block;
  /* 块内小标签（「程序输出」）→ meta 档 */
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
  margin-bottom: 4px;
}

.block__code {
  margin: 0;
  padding: 10px 12px;
  /* 代码块是在 surface-2 面板上的白纸 → 圆角回 inset 档；底色回到 paper */
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  font-family: var(--k12-font-mono);
  /* 旧值不在 8 档之内：程序输出 / 原始报错是等宽读数 → meta 档 */
  font-size: var(--k12-fs-xs);
  line-height: 1.7;
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
  /* 折叠条的说明文字 → meta 档（与 views/Coding.vue 的 `.raw summary` 同一落点） */
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.raw summary:hover {
  color: var(--k12-muted);
}

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
  /* 提示条 = 卡内嵌入块（与 views/Coding.vue 的 `.hint` 同一配方） */
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
}

.hint__text {
  flex: 1;
  /* 分级提示正文：学生要照着改代码 → 次级正文档 */
  font-size: var(--k12-fs-sm);
  line-height: 1.8;
  word-break: break-word;
}

.coding__intervene {
  margin-top: 10px;
  padding: 9px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-accent-soft);
  /* 边框是「画」的那一层 → accent（不是 accent-ink：那是给文字用的） */
  border: 1px solid var(--k12-accent);
  /* 老师要介入的提示：一句写给学生的完整话 → 次级正文档 */
  font-size: var(--k12-fs-sm);
  line-height: 1.7;
}

.coding__warn {
  margin-top: 8px;
  /* 能力自检的说明（「不支持中断死循环」）→ meta 档 */
  font-size: var(--k12-fs-xs);
  line-height: 1.7;
  color: var(--k12-bad);
}

.coding__hint {
  margin-top: 8px;
  /* 本卡片的即时提示（「先写一点代码」）→ meta 档。
   * 这一条**是要读的文字** → accent-ink（accent 配在这个字号上对比度不够）。 */
  font-size: var(--k12-fs-xs);
  color: var(--k12-accent-ink);
}

.coding__foot {
  margin-top: 12px;
  /* 卡片脚注（「求助会把你的代码发给智团团」这条行为告知）→ meta 档 */
  font-size: var(--k12-fs-xs);
  line-height: 1.6;
  color: var(--k12-muted-2);
}
</style>
