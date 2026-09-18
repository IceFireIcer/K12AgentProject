<script setup lang="ts">
/**
 * 编程练习内联卡。
 *
 * ⚠️ 引擎不接（用户决策）：**不引入 Monaco、不加载 Pyodide**。
 * 代码区是带语法着色的只读展示，「运行」给出的是**标注过的示例输出**（不是真跑出来的）。
 *
 * 接线时的两条硬约束（别忘）：
 *  1. 学生代码**绝不在主进程执行**：`evaluate_code` 必须经 IPC 交给渲染进程的
 *     Pyodide Worker，结果回传（每条都要有架构守卫测试）；
 *  2. 报错感知 + 分级求助走 `CodingHint.level` 1→2→3 递进，不要一次给满。
 *
 * 修掉的两个既有毛病：
 *  1. 代码区没有高度上限 —— 脚手架一长，卡片就跟着无限变高，把对话列顶穿；现在
 *     编辑区自身可滚，行号列 sticky 跟随，横竖滚动都不错行。
 *  2. 着色先包注释、再替换关键字，于是注释里的 `print` 会被套上关键字 span；
 *     现在按「`#` 到行尾是注释」先切分，只对代码段着色。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Copy,
  Play,
  Lightbulb,
  RotateCcw,
  Maximize2,
  CheckCircle2,
  AlertTriangle,
  MessagesSquare
} from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import { useFloatPanel } from '@/stores/floatPanel'
import { codeTemplate, codingHints, codeRunResult, codeRunFailure, kpNames } from '@/mocks'
import type { CodeEvaluation, CodingHint, CodeTemplate } from '@/types/contract'

const props = withDefaults(
  defineProps<{
    template?: CodeTemplate
    hints?: CodingHint[]
    result?: CodeEvaluation
    /** 失败分支的演示数据：接线后由 Worker 真实返回，不需要这个 prop */
    failure?: CodeEvaluation
  }>(),
  {
    template: () => codeTemplate,
    hints: () => codingHints,
    result: () => codeRunResult,
    failure: () => codeRunFailure
  }
)

const router = useRouter()
const floatPanel = useFloatPanel()

/** 打开悬浮追问窗，带着「我在做这道题」这个上下文 */
function ask(e: MouseEvent) {
  floatPanel.openFrom(e.currentTarget as Element, {
    kind: 'coding',
    title: kpName.value,
    hint: '可以问：这一步为什么要用 sum / 报错是什么意思'
  })
}

const hintLevel = ref<0 | 1 | 2 | 3>(0)

const lines = computed(() => props.template.scaffold.split('\n'))
const kpName = computed(() => kpNames[props.template.kpId] ?? props.template.kpId)

const currentHint = computed(() =>
  hintLevel.value === 0 ? null : (props.hints[hintLevel.value - 1] ?? null)
)

/** 极简 Python 语法着色：仅用于展示（不引入高亮库，避免为样稿增加依赖） */
function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const KEYWORDS =
  /\b(sum|len|min|max|print|range|int|float|str|list|dict|for|in|if|else|elif|return|def|import|from|while)\b/g

const highlighted = computed(() =>
  lines.value
    .map((line) => {
      const at = line.indexOf('#')
      const codePart = at === -1 ? line : line.slice(0, at)
      const commentPart = at === -1 ? '' : line.slice(at)
      const codeHtml = esc(codePart)
        .replace(KEYWORDS, '<span class="tk-k">$1</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tk-n">$1</span>')
      return codeHtml + (commentPart ? `<span class="tk-c">${esc(commentPart)}</span>` : '')
    })
    .join('\n')
)

/**
 * 运行：走**完整状态机**（idle → running → done）。
 *
 * 这里的两种结果是同一个 `CodeEvaluation` 的两支：
 *   ok=true  → 示例输出 + 反馈
 *   ok=false → 报错（type / message / line / rawTraceback）+ 建议的下一步
 *
 * ⚠️ 「报错感知」是本项目的核心功能之一，而此前 `CodeEvaluation.error` 与
 *    `nextHint` **一条都没渲染过** —— 契约里有、界面上没有，等于这条功能不存在。
 * 接线后由 Pyodide Worker 返回真实结果；这里演示两支是为了让它们可见。
 */
type RunPhase = 'idle' | 'running' | 'done'
const runPhase = ref<RunPhase>('idle')
/** 演示用：下一次运行给哪一支的结果（接线后不存在这个开关） */
const nextRunFails = ref(false)
let runTimer: number | null = null

function run(fail = false) {
  if (runPhase.value === 'running') return
  nextRunFails.value = fail
  runPhase.value = 'running'
  if (runTimer !== null) clearTimeout(runTimer)
  runTimer = window.setTimeout(() => {
    runPhase.value = 'done'
    runTimer = null
  }, 750)
}

const evaluation = computed<CodeEvaluation>(() =>
  nextRunFails.value ? props.failure : props.result
)

/** 报错解析出的行号：用来在编辑区里标出问题行 */
const errorLine = computed(() => evaluation.value.error?.line ?? null)

function reset() {
  runPhase.value = 'idle'
  hintLevel.value = 0
}

/**
 * 复制代码到剪贴板。
 * 审计发现全站**没有任何复制功能** —— 而代码区恰恰是最需要"我要把这段拿走"的地方。
 * 剪贴板 API 在非安全上下文会失败（file:// 下 Electron 是安全的），所以要兜底。
 */
const copied = ref(false)
let copyTimer: number | null = null
async function copyCode() {
  const ok = await navigator.clipboard
    .writeText(props.template.scaffold)
    .then(() => true)
    .catch(() => false)
  if (!ok) return
  copied.value = true
  if (copyTimer !== null) clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => (copied.value = false), 1800)
}

onBeforeUnmount(() => {
  if (copyTimer !== null) clearTimeout(copyTimer)
  if (runTimer !== null) clearTimeout(runTimer)
})

function askHint() {
  if (hintLevel.value < 3) hintLevel.value = (hintLevel.value + 1) as 1 | 2 | 3
}
</script>

<template>
  <SurfacePanel flush tone="card" class="cd">
    <div class="cd__head">
      <span class="cd__tag">编程</span>
      <div class="cd__head-text">
        <p class="cd__title">{{ kpName }}</p>
        <p class="cd__meta">编程练习 · {{ template.language === 'python' ? 'Python' : template.language }}</p>
      </div>
      <button type="button" class="cd__copy" :title="copied ? '已复制' : '复制代码'" @click="copyCode">
        <CheckCircle2 v-if="copied" :size="14" />
        <Copy v-else :size="14" />
        <span>{{ copied ? '已复制' : '复制' }}</span>
      </button>
      <button type="button" class="cd__ask" title="就地追问这道题" @click="ask">
        <MessagesSquare :size="14" />
        <span>追问</span>
      </button>
      <button
        type="button"
        class="cd__icon"
        title="在编程环境页展开"
        @click="router.push({ name: 'coding' })"
      >
        <Maximize2 :size="14" />
      </button>
    </div>

    <!-- 期望行为：是任务说明的一部分，不要拿它当标题 -->
    <div class="cd__task">
      <span class="cd__task-k">期望输出</span>
      <span class="cd__task-v">{{ template.expectedBehavior }}</span>
    </div>

    <!-- 编辑区：只读展示，避免误导为可执行；自身可滚，行号列 sticky -->
    <div class="cd__editor">
      <div class="cd__gutter" aria-hidden="true">
        <span v-for="(_, i) in lines" :key="i">{{ i + 1 }}</span>
      </div>
      <pre class="cd__code" v-html="highlighted" />
    </div>

    <!-- 运行中：进度线 + 一句话 -->
    <div v-if="runPhase === 'running'" class="cd__running">
      <div class="cd__running-line"><span class="cd__running-fill" /></div>
      <p class="cd__running-text">正在本地 Worker 中执行…</p>
    </div>

    <!-- 运行结果：**两支**。成功与失败长得不一样，因为学生要做的事不一样。 -->
    <template v-else-if="runPhase === 'done'">
      <!-- 成功 -->
      <div v-if="evaluation.ok" class="cd__out">
        <div class="cd__out-head">
          <CheckCircle2 :size="14" class="cd__ok" />
          <span class="cd__out-title">示例输出</span>
          <span class="cd__out-tag">未真实执行</span>
          <span class="cd__out-stdout">{{ evaluation.stdout }}</span>
        </div>
        <p class="cd__feedback">{{ evaluation.feedback }}</p>
      </div>

      <!-- 失败：报错感知。说清"哪一行、什么错、先看哪儿"。 -->
      <div v-else class="cd__err">
        <div class="cd__err-head">
          <AlertTriangle :size="14" class="cd__err-ico" />
          <span class="cd__err-type">{{ evaluation.error?.type ?? '运行错误' }}</span>
          <span v-if="errorLine" class="cd__err-line">第 {{ errorLine }} 行</span>
          <span class="cd__out-tag">未真实执行</span>
        </div>
        <p class="cd__err-msg">{{ evaluation.error?.message }}</p>
        <p class="cd__feedback">{{ evaluation.feedback }}</p>
        <details v-if="evaluation.error?.rawTraceback" class="cd__tb">
          <summary>原始报错</summary>
          <pre class="cd__tb-text">{{ evaluation.error.rawTraceback }}</pre>
        </details>
      </div>

      <!-- 建议的下一步：nextHint 此前也从未渲染 -->
      <div v-if="evaluation.nextHint" class="cd__next">
        <Lightbulb :size="14" class="cd__next-ico" />
        <div>
          <p class="cd__next-label">建议的下一步（提示 {{ evaluation.nextHint.level }} / 3）</p>
          <p class="cd__next-text">{{ evaluation.nextHint.hint }}</p>
        </div>
      </div>
    </template>

    <!-- 分级求助：level 1 → 2 → 3 递进，不要一次给满 -->
    <div v-if="currentHint" class="cd__hint">
      <Lightbulb :size="14" class="cd__hint-ico" />
      <div>
        <p class="cd__hint-level">提示 {{ currentHint.level }} / 3</p>
        <p class="cd__hint-text">{{ currentHint.hint }}</p>
      </div>
    </div>

    <div class="cd__foot">
      <button
        type="button"
        class="cd__btn cd__btn--primary"
        :disabled="runPhase === 'running'"
        @click="run(false)"
      >
        <Play :size="14" /><span>{{ runPhase === 'running' ? '运行中…' : '运行' }}</span>
      </button>
      <!-- 演示失败分支的入口：不提供它，报错感知这条链路在原型里就永远看不见 -->
      <button
        type="button"
        class="cd__btn"
        :disabled="runPhase === 'running'"
        title="演示：运行一段会报错的代码"
        @click="run(true)"
      >
        <AlertTriangle :size="14" /><span>试一下报错</span>
      </button>
      <button type="button" class="cd__btn" :disabled="hintLevel >= 3" @click="askHint">
        <Lightbulb :size="14" /><span>求助</span>
      </button>
      <button type="button" class="cd__btn cd__btn--ghost" @click="reset">
        <RotateCcw :size="14" /><span>重置</span>
      </button>
      <span class="cd__note">
        <AlertTriangle :size="13" />
        代码在学生机本地执行，本原型未接入运行引擎
      </span>
    </div>
  </SurfacePanel>
</template>

<style scoped>
.cd__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}
.cd__tag {
  padding: 3px 8px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-micro);
  font-weight: 700;
  flex: none;
}
.cd__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.cd__title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
}
.cd__meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
/* 追问：卡头一级动作，用描边按钮而不是图标按钮 —— 它是这轮新增的主入口 */
.cd__copy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 5px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .cd__copy:hover {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}
.cd__ask {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 5px 10px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .cd__ask:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
.cd__icon {
  border: none;
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
  padding: 5px;
  border-radius: var(--k12-r-flat);
  display: inline-flex;
  flex: none;
}
@media (hover: hover) and (pointer: fine) {
.cd__icon:hover {
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
}
}

.cd__task {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 14px 10px;
  padding: 8px 11px;
  border-radius: var(--k12-r-control);
  background: var(--k12-accent-soft);
}
.cd__task-k {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-accent-ink);
  flex: none;
}
.cd__task-v {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}

/* 编辑区：单层滚动容器，行号列 sticky，横竖滚都对齐。
 * 高度上限做成变量，展开页（CodingView）把它调大，卡片在对话里保持紧凑。 */
.cd__editor {
  display: flex;
  align-items: flex-start;
  margin: 0 14px;
  max-height: var(--cd-editor-max, 260px);
  overflow: auto;
  border-radius: var(--k12-r-control);
  background: var(--k12-fg);
}
.cd__gutter {
  position: sticky;
  left: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 9px;
  background: color-mix(in srgb, var(--k12-fg) 88%, var(--k12-surface));
  color: var(--k12-screen-dim);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  line-height: 1.8;
  text-align: right;
  user-select: none;
  flex: none;
}
.cd__code {
  flex: 1;
  margin: 0;
  padding: 12px 14px;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  line-height: 1.8;
  color: var(--k12-screen-fg);
  white-space: pre;
}
.cd__code :deep(.tk-c) {
  color: var(--k12-screen-dim);
  font-style: italic;
}
.cd__code :deep(.tk-k) {
  color: var(--k12-screen-key);
}
.cd__code :deep(.tk-n) {
  color: var(--k12-screen-num);
}

.cd__out {
  margin: 10px 14px 0;
  padding: 10px 12px;
  border-radius: var(--k12-r-control);
  background: var(--k12-good-soft);
}
.cd__out-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.cd__ok {
  color: var(--k12-good);
  flex: none;
}
.cd__out-title {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-good);
}
.cd__out-tag {
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: color-mix(in srgb, var(--k12-good) 12%, var(--k12-surface));
  color: var(--k12-good);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}
.cd__out-stdout {
  margin-left: auto;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-fg);
}
.cd__feedback {
  margin-top: 6px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}

/* ── 运行中 ──────────────────────────────────────────────────────────── */
.cd__running {
  margin: 10px 14px 0;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.cd__running-line {
  position: relative;
  height: 3px;
  border-radius: var(--k12-r-pill);
  overflow: hidden;
  background: color-mix(in srgb, var(--k12-accent) 16%, transparent);
}
.cd__running-fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--k12-accent);
}
.cd__running-text {
  margin-top: 8px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/* ── 失败分支（报错感知）───────────────────────────────────────────────
 * 与成功分支在**颜色和信息结构**上都不同：失败要先回答
 * "哪一行、什么错、先看哪儿"，成功只要一个输出值。 */
.cd__err {
  margin: 10px 14px 0;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-bad-soft);
  border: 1px solid var(--k12-bad-border);
}
.cd__err-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.cd__err-ico {
  color: var(--k12-bad);
  flex: none;
}
.cd__err-type {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 700;
  color: var(--k12-bad);
}
.cd__err-line {
  padding: 1px 7px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-bad);
  color: var(--k12-surface);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.cd__err-msg {
  margin-top: 6px;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg);
  word-break: break-word;
}
/* 原始报错默认收起：学生先看"人话版"，需要细节再展开 */
.cd__tb {
  margin-top: 8px;
}
.cd__tb summary {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  cursor: pointer;
}
.cd__tb-text {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-fg);
  color: var(--k12-screen-fg);
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  overflow-x: auto;
  white-space: pre;
}

/* 建议的下一步（nextHint） */
.cd__next {
  display: flex;
  gap: 9px;
  margin: 10px 14px 0;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
}
.cd__next-ico {
  color: var(--k12-warn);
  flex: none;
  margin-top: 2px;
}
.cd__next-label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-warn);
}
.cd__next-text {
  margin-top: 3px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

.cd__hint {
  display: flex;
  gap: 9px;
  margin: 10px 14px 0;
  padding: 10px 12px;
  border-radius: var(--k12-r-control);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
}
.cd__hint-ico {
  color: var(--k12-warn);
  flex: none;
  margin-top: 1px;
}
.cd__hint-level {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-warn);
}
.cd__hint-text {
  margin-top: 3px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}

.cd__foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 14px;
}
.cd__btn {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
.cd__btn:hover:not(:disabled) {
  border-color: var(--k12-accent-border);
}
}
.cd__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.cd__btn--primary {
  background: var(--k12-accent);
  border-color: var(--k12-accent-ink);
  color: var(--k12-surface);
}
@media (hover: hover) and (pointer: fine) {
.cd__btn--primary:hover:not(:disabled) {
  filter: brightness(1.06);
  border-color: var(--k12-accent-ink);
}
}
.cd__btn--ghost {
  border-color: transparent;
  background: transparent;
}
.cd__note {
  flex: 1 1 200px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
</style>
