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
import type { InlineCard } from '../api/events'
import { createCodeEditor, observeEditorResize, type CodeEditorHandle } from '../sandbox/monaco-setup'
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
  readCodingCard
} from './coding'

const props = defineProps<{ card: InlineCard }>()
const chat = useChatStore()

const view = computed(() => readCodingCard(props.card.payload))
const kpId = computed(() => (view.value.kind === 'unknown' ? '' : view.value.kpId))

/** 整段对话里的卡片（提示与评估结果都可能在别的轮次里）。 */
const allCards = computed(() => chat.turns.flatMap((turn) => turn.cards))
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
})

/** 卸载：释放编辑器与订阅（Worker 是窗口级共享的，交给整页卸载时统一收）。 */
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
  if (!chat.streaming) {
    void chat.send(buildRunRequestMessage(kpId.value, code))
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
  void chat.send(buildHintRequestMessage(kpIdValue, currentCode()))
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

/** 加载状态的展示文案（含懒加载耗时 —— 票 18 要求记录"进卡片才加载"的证据）。 */
const pyodideBadge = computed(() => {
  const status = runnerStatus.value
  if (status.phase === 'ready') {
    const seconds = status.loadMs === null ? null : (status.loadMs / 1000).toFixed(1)
    return {
      text: seconds ? `Python 就绪（${seconds} s）` : 'Python 就绪',
      tone: 'ok' as const
    }
  }
  if (status.phase === 'loading') return { text: '正在准备 Python 环境…', tone: 'busy' as const }
  if (status.phase === 'failed') return { text: 'Python 环境不可用', tone: 'warn' as const }
  return { text: 'Python 待加载', tone: 'idle' as const }
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
      <span class="chip tool" data-testid="coding-kp">{{ view.kpId }}</span>
      <span class="chip" :class="`chip--${pyodideBadge.tone}`" data-testid="coding-pyodide">
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
    <p class="coding__foot">
      代码在你电脑上的浏览器沙箱里运行，不会上传、也碰不到学习数据。卡住就点「求助」。
    </p>
  </article>

  <!-- 认不出的载荷：一句说明，绝不猜 -->
  <article
    v-else-if="view.kind === 'unknown'"
    class="coding coding--unknown"
    data-testid="coding-card-unknown"
    :data-tool="card.tool ?? ''"
  >
    <header class="coding__head">
      <span class="title">编程练习</span>
      <span class="chip chip--warn">这张卡片没能显示出来</span>
    </header>
    <p class="coding__goal">{{ view.text || '编程卡片的内容格式不对，老师重新来一遍就好。' }}</p>
  </article>
</template>

<style scoped>
.coding {
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.coding--unknown {
  border-style: dashed;
}

.coding__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.title {
  font-size: 14px;
  font-weight: 650;
}

.tool {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
}

.coding__goal {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-muted);
  word-break: break-word;
}

.coding__goal-label {
  font-weight: 650;
  color: var(--text);
}

.coding__editor-wrap {
  margin-top: 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface);
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
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-muted);
}

.coding__editor-failure {
  margin: 0;
  padding: 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--danger);
}

.coding__actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.out {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  border: 1px solid var(--border);
}

.out__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.out__feedback {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.out__failure {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--danger);
}

.block {
  margin-top: 10px;
}

.block__label {
  display: block;
  font-size: 12px;
  font-weight: 650;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.block__code {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12.5px;
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
  font-size: 12px;
  color: var(--text-faint);
}

.raw summary:hover {
  color: var(--text-muted);
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
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  border: 1px solid var(--border);
}

.hint__text {
  flex: 1;
  font-size: 13px;
  line-height: 1.8;
  word-break: break-word;
}

.coding__intervene {
  margin-top: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  font-size: 13px;
  line-height: 1.7;
}

.coding__warn {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--danger);
}

.coding__hint {
  margin-top: 8px;
  font-size: 13px;
  color: var(--accent);
}

.coding__foot {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-faint);
}
</style>
