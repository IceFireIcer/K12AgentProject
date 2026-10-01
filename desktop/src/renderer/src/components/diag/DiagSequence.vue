<script setup lang="ts">
/**
 * 「调用顺序」子页：把**这一轮真实发生的事**按真实先后，一条横条一个步骤地摊开。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 与「分块总览」的分工（同一份 `TurnDiagnostics`，两种读法）
 * ══════════════════════════════════════════════════════════════════════════
 *   · 分块总览（`views/Demo.vue` 的三栏）= **按主题**看：十二个分块各讲一件事，
 *     适合逐块讲解（「这是 Prompt 拼接，这是四级链」）。
 *   · 本组件 = **按时间**看：学生输入 → 入口预检 → 学段 → 提示词（逐段）→ 画像 →
 *     组装完成 → 推理 → 工具（逐次）→ 检索（逐级）→ 输出 → 终审 → 拦截 → 结束。
 *     适合回答「到底按什么顺序发出去的」这类问题 —— 那是分块视图答不了的。
 *
 * ★★ 每一条横条最前面是**分类**（固定宽度的左列，带色条），后面依次是步骤标题、
 *   要点文字、右侧的数字。分类共八个：用户 / 安全 / 学段 / 提示词 / 检索 / 工具 / 模型 / 收尾。
 * ★ 顺序**不是排出来的**：`buildSteps()` 里就是上面那 13 步的字面顺序，
 *   每一步的判据是「这一步真的发生了没有」—— 没发生就整条不渲染，不留空壳。
 * ★ 展开看原文走**既有交互**（原生 `<details>` / `<summary>`，与三栏视图里的
 *   Prompt 分段折叠同一套），不新造第三种展开机制。
 *
 * ⚠️ 本组件只被教师档专属的 `views/Demo.vue` import（凭据见
 *   `tests/demo-mode.test.ts` 的「子页组件只被运行透视页 import」那条断言）：
 *   它整份摊开的是运行时技术原文（提示词分段原文、工具名、逐级检索记录、安全结论），
 *   学生档根本进不到这一页。技术词的整文件豁免见 `tests/student-view-discipline.test.ts`。
 */
import { computed } from 'vue'
import { GRADE_LABELS, GRADE_ORIGIN_LABELS, GRADE_UNKNOWN_LABEL } from '../../labels'
import { LAYER2_LABELS, RETRIEVAL_LEVEL_LABELS, SAFETY_STAGE_LABELS } from './evidence'
// ★ RuntimeSpan 由 V1（task-49）落在 @shared/diagnostics；这里**只 import 不另声明**
//   （两份形状迟早漂，而这一页要按它画子代理泳道）。
import type { RuntimeSpan, TurnDiagnostics } from '@shared/diagnostics'
// ★ 零轮次时轮外 span 只存在于快照级（没有轮可挂）—— 组件因此要读一次 store，
//   而不只是读 props 里那一轮（见下面 offTurnSpans 的说明）。
import { useDiagnosticsStore } from '../../stores/diagnostics'

const props = defineProps<{
  /** 要摊开的那一轮（`null` = 还没有任何一轮 / 还没选中）。 */
  turn: TurnDiagnostics | null
}>()

const diagnostics = useDiagnosticsStore()

/**
 * 九个分类（泳道文案的**唯一来源**）。
 *
 * ★★ 2026-10-01 加第九类 `subagent`：子代理（五问概括 / 画像刷新 / 画像小结这些
 *   **旁路模型调用**）不经过 Pi，只在主进程唯一的出网口打点（V1 的 `spans`），
 *   但在「这一轮到底发生了什么」这件事上，它们和主轮步骤是同一层事实 ——
 *   所以给它们自己一条泳道，而不是塞进「模型」里冒充主轮调用。
 */
type DiagCategory =
  | 'user'
  | 'safety'
  | 'grade'
  | 'prompt'
  | 'retrieval'
  | 'tool'
  | 'model'
  | 'subagent'
  | 'wrap'

const CATEGORY_LABELS: Record<DiagCategory, string> = {
  user: '用户',
  safety: '安全',
  grade: '学段',
  prompt: '提示词',
  retrieval: '检索',
  tool: '工具',
  model: '模型',
  subagent: '子代理',
  wrap: '收尾'
}

/** 图例与泳道的顺序（= 分类的固定顺序，与块在时间轴上的先后无关）。 */
const CATEGORY_ORDER: readonly DiagCategory[] = [
  'user',
  'safety',
  'grade',
  'prompt',
  'retrieval',
  'tool',
  'model',
  'subagent',
  'wrap'
]

/** 一条横条。`text` 有值时整条可点开（原生 `<details>`）。 */
interface DiagStep {
  key: string
  category: DiagCategory
  title: string
  /** 要点文字（单行，长了走省略号；全文在 `text` 里）。 */
  detail: string
  /** 右侧的数字（字符数 / 耗时 / 命中数……）。 */
  metric: string
  /** 补充说明（第二行，允许换行）。 */
  note?: string
  /** 这条真的出了问题（安全拦下 / 工具失败）时给它一个警示态。 */
  state?: 'ok' | 'blocked' | 'failed'
  /** 可展开的原文（没有就不给展开，避免一个点了没反应的空开关）。 */
  text?: string
  /** 展开区的抬头（默认「原文」）。 */
  textLabel?: string
  /** 展示的原文被截断过（原文更长，界面上要看得出来）。 */
  cut?: boolean
  /**
   * 这一步**记录到的耗时**（毫秒）。
   *
   * ★ 只有拿得到才填：工具调用有 `latencyMs`、模型输出有整轮 `totalMs`、
   *   子代理有 `ms`。**没有就不填** —— 时间轴上按最小宽度画并标「没记耗时」，
   *   绝不用一个猜出来的数字冒充真实耗时（这一页是证据页）。
   */
  ms?: number
}

/** 把多行文本压成一行要点（全文仍在 `text` 里，一个字都没丢）。 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 0 ? flat : '（空白）'
}

/**
 * 学段判定层的可读名。
 *
 * ★ 走 `labels.ts` 的 `GRADE_ORIGIN_LABELS`（**唯一**的「学段来源 → 中文」实现：
 *   顶栏指示器与设置页都调它）。这里另写一份的话，同一个 `llm` 会出现两种说法。
 */
function decidedByLabel(decidedBy: string | null): string {
  if (decidedBy === null) return '还没判过'
  return (GRADE_ORIGIN_LABELS as Record<string, string>)[decidedBy] ?? decidedBy
}

/** 第二层（模型复核）状态的可读名；读不到原值就原样显示，不编。 */
function layer2Label(layer2: string): string {
  return LAYER2_LABELS[layer2] ?? layer2
}

/** 安全阶段的结论名。 */
const VERDICT_LABELS: Record<string, string> = { pass: '通过', blocked: '拦下', skipped: '没跑' }

/** 一秒内的毫秒数按整数显示（`Math.round` 而不是 toFixed，免得出现 "12.0ms"）。 */
function ms(value: number): string {
  return `${Math.round(value)}ms`
}

/**
 * 这一轮的横条流。
 *
 * ★ 每一步都先问「它发生了没有」：没发生就整条不 push —— 界面上不会出现
 *   「工具调用 0 次」这种占位横条（那正是「一横条一横条」想避免的东西）。
 */
function buildSteps(turn: TurnDiagnostics): DiagStep[] {
  const steps: DiagStep[] = []

  // ── ① 用户：学生原话 ──────────────────────────────────────────────
  if (turn.input.text === '') {
    steps.push({
      key: 'input',
      category: 'user',
      title: '学生输入',
      detail: '这一轮没有留下正文：落盘只留长度与结论，正文一个字节都不落盘。',
      metric: '正文未留'
    })
  } else {
    steps.push({
      key: 'input',
      category: 'user',
      title: '学生输入',
      detail: oneLine(turn.input.text),
      metric: `${turn.input.text.length} 字符`,
      text: turn.input.text
    })
  }

  // ── ② 安全：入口预检 ─────────────────────────────────────────────
  const inputVerdict = turn.input.safetyInput.verdict
  steps.push({
    key: 'safety-input',
    category: 'safety',
    title: '入口预检（发模型之前）',
    detail:
      inputVerdict === 'pass'
        ? '通过，这一轮真的发给了模型。'
        : `拦下：${turn.input.safetyInput.reason ?? '命中拦截规则'}`,
    metric: VERDICT_LABELS[inputVerdict] ?? inputVerdict,
    state: inputVerdict === 'pass' ? 'ok' : 'blocked',
    text: inputVerdict === 'blocked' ? turn.input.safetyInput.reason : undefined,
    textLabel: '看拦截原因'
  })

  // ── ③ 学段：这一轮按谁的话、用哪一层判的 ─────────────────────────
  const grade = turn.grade
  const gradeFacts = [
    `复核状态：${layer2Label(grade.layer2)}`,
    `下一轮待生效：${grade.pending ?? '没有变化'}`
  ]
  if (grade.note !== '') gradeFacts.push(`最近结论：${grade.note}`)
  steps.push({
    key: 'grade',
    category: 'grade',
    title: '这一轮按哪个学段答',
    detail:
      `${GRADE_LABELS[grade.applied] ?? GRADE_UNKNOWN_LABEL}` +
      ` · 判定层：${decidedByLabel(grade.decidedBy)}` +
      ` · 累计第 ${grade.cumulativeTurns} 轮`,
    metric: `冷却剩 ${grade.cooldownRemainingTurns} 轮`,
    note: gradeFacts.join(' · ')
  })

  // ── ④ 提示词：每一段一条 ─────────────────────────────────────────
  for (const segment of turn.prompt.segments) {
    steps.push({
      key: `segment-${segment.id}`,
      category: 'prompt',
      title: segment.label,
      detail: oneLine(segment.text),
      metric: `${segment.chars} 字符 · 约 ${segment.tokens} tok`,
      text: segment.text,
      textLabel: '看这一段原文',
      cut: segment.truncated
    })
  }

  // ── ⑤ 提示词：画像注入 ───────────────────────────────────────────
  const context = turn.studentContext
  if (context.injected || context.chars > 0) {
    steps.push({
      key: 'context',
      category: 'prompt',
      title: '画像注入',
      detail: context.injected
        ? context.sameAsPrev
          ? '与上一轮逐字节相同，前面的内容可以接着复用。'
          : '与上一轮不同，从这一块往后要重新算。'
        : '本轮没有注入画像。',
      metric: `${context.chars} 字符`,
      // 两个原始字段都明写出来（答辩看的就是「逐字节稳定」这件事实本身）
      note:
        `字节指纹 ${context.byteHash === '' ? '没有指纹' : context.byteHash}` +
        ` · 与上一轮逐字节相同：${context.sameAsPrev ? '是' : '否'}`,
      text: context.text === '' ? undefined : context.text,
      textLabel: '看画像块原文',
      cut: context.truncated
    })
  }

  // ── ⑥ 提示词：组装完成（就是发给模型的那一份）────────────────────
  if (turn.prompt.chars > 0) {
    steps.push({
      key: 'prompt-ready',
      category: 'prompt',
      title: '组装完成，发给模型',
      detail: `共 ${turn.prompt.segments.length} 段 · 学段模板 ${turn.prompt.gradeTemplate}`,
      metric: `${turn.prompt.chars} 字符 · 约 ${turn.prompt.totalTokens} tok`,
      note: turn.prompt.hostPathClean
        ? '上屏前的本机路径检查：干净。'
        : '上屏前的本机路径检查：出现了本机路径，这一轮被记为缺陷。',
      state: turn.prompt.hostPathClean ? 'ok' : 'failed'
    })
  }

  // ── ⑦ 模型：推理增量（拿不到就如实写）────────────────────────────
  const reasoning = turn.reasoning
  if (reasoning.available || reasoning.note !== '') {
    steps.push({
      key: 'reasoning',
      category: 'model',
      title: '推理过程（可选）',
      detail: reasoning.available ? '拿到了这一轮的推理，默认折叠。' : `没拿到：${reasoning.note}`,
      metric: reasoning.available ? `${reasoning.filtered.length} 字符` : '没拿到',
      text: reasoning.available ? reasoning.filtered : undefined,
      textLabel: '展开已过滤的推理'
    })
  }

  // ── ⑧ 工具：每调一次一条 ─────────────────────────────────────────
  for (const tool of turn.tools) {
    steps.push({
      key: `tool-${tool.seq}-${tool.name}`,
      category: 'tool',
      title: tool.name,
      detail: `第 ${tool.seq} 次调用 · ${tool.ok ? '成功' : '失败'}`,
      metric: ms(tool.latencyMs),
      note: tool.degraded === undefined ? undefined : `降级档位：${tool.degraded}`,
      state: tool.ok ? 'ok' : 'failed',
      // 工具调用是**唯一天然带耗时**的主轮步骤（别的步骤只有字符数）
      ms: tool.latencyMs
    })
  }

  // ── ⑨ 检索：先一条总账，再逐级一条 ───────────────────────────────
  const retrieval = turn.retrieval
  if (retrieval !== null) {
    const filterLine =
      retrieval.gradeFilter === ''
        ? '学段过滤条件：后端这一轮没有给原文。'
        : `学段过滤条件：${oneLine(retrieval.gradeFilter)}`
    steps.push({
      key: 'retrieval',
      category: 'retrieval',
      title: '检索词',
      detail: retrieval.query === '' ? '这一轮没有留下检索词（不落盘）。' : oneLine(retrieval.query),
      metric: `${retrieval.hitCount} 条命中`,
      note:
        `最终档位 ${RETRIEVAL_LEVEL_LABELS[retrieval.degraded] ?? retrieval.degraded}` +
        ` · 跨学段延伸 ${retrieval.compatCount} 条 · ${filterLine}`,
      text: retrieval.gradeFilter === '' ? undefined : retrieval.gradeFilter,
      textLabel: '看学段过滤条件原文'
    })
    for (const level of retrieval.levels) {
      steps.push({
        key: `level-${level.level}`,
        category: 'retrieval',
        title: RETRIEVAL_LEVEL_LABELS[level.level] ?? level.level,
        detail: level.tried ? (level.ok ? `命中 ${level.hits} 条` : '未命中，往下一级走') : '没走到这一级',
        metric: level.tried ? `${level.hits} 条` : '未走到',
        note: level.note === '' ? undefined : level.note,
        state: level.tried ? (level.ok ? 'ok' : 'failed') : undefined
      })
    }
  }

  // ── ⑩ 模型：输出时序 ─────────────────────────────────────────────
  if (turn.done.firstTokenMs !== null || turn.done.ok) {
    steps.push({
      key: 'output',
      category: 'model',
      title: '模型输出',
      detail:
        turn.done.firstTokenMs === null
          ? '首字延迟没记到。'
          : `首字延迟 ${ms(turn.done.firstTokenMs)}，全程 ${ms(turn.done.totalMs)}。`,
      metric: ms(turn.done.totalMs),
      state: turn.done.ok ? 'ok' : 'failed',
      // 整轮耗时挂在「模型输出」这一步上（它就是这一轮里最长的那一段）
      ms: turn.done.totalMs
    })
  }

  // ── ⑪ 安全：生成侧终审，**每个阶段各一条** ───────────────────────
  //    三个阶段各是一件事（入口预检 / 流式转发 / 整段终审），并成一条就分不出
  //    「哪一阶段拦下的」—— 而那正是答辩要问的。
  const safety = turn.safetyFinal
  for (const stage of safety.stages) {
    const verdict = VERDICT_LABELS[stage.verdict] ?? stage.verdict
    steps.push({
      key: `safety-${stage.stage}`,
      category: 'safety',
      title: SAFETY_STAGE_LABELS[stage.stage] ?? stage.stage,
      detail:
        stage.reason !== undefined && stage.reason !== ''
          ? stage.reason
          : stage.verdict === 'pass'
            ? '这一阶段跑过，没有发现问题。'
            : stage.verdict === 'blocked'
              ? '这一阶段把内容拦下了。'
              : '这一阶段没跑（这一轮没有可审的正文，或没有可用的模型）。',
      metric: verdict,
      state: stage.verdict === 'blocked' ? 'blocked' : stage.verdict === 'skipped' ? undefined : 'ok'
    })
  }
  if (safety.stages.length > 0) {
    steps.push({
      key: 'safety-counts',
      category: 'safety',
      title: '终审计数',
      detail: `整段终审跑了 ${safety.finalizations} 次 · 正文撤回 ${safety.retractions} 次`,
      metric: `缓冲 ${safety.bufferedChars} 字符`,
      note: '缓冲字符数 = 终审下结论之前先攒着、还没放给学生的正文字数。'
    })
  }

  // ── ⑫ 收尾：被拦下的每一条 ───────────────────────────────────────
  for (const [index, item] of turn.interceptions.entries()) {
    steps.push({
      key: `interception-${index}`,
      category: 'wrap',
      title: item.source,
      detail: item.reason,
      metric: '被拦下',
      note: item.detail,
      state: 'blocked'
    })
  }

  // ── ⑬ 收尾：结束 ─────────────────────────────────────────────────
  steps.push({
    key: 'done',
    category: 'wrap',
    title: '本轮结束',
    detail: `状态 ${turn.done.status} · ${turn.done.ok ? '正常结束' : '没有正常结束'}`,
    metric: ms(turn.done.totalMs),
    state: turn.done.ok ? 'ok' : 'failed'
  })

  return steps
}

const steps = computed<DiagStep[]>(() => (props.turn === null ? [] : buildSteps(props.turn)))

/* ══════════════════════════════════════════════════════════════════════════
 * 时间轴模型（2026-10-01 用户裁决：竖向列表 → 横向时间线 + 子代理泳道）
 * ══════════════════════════════════════════════════════════════════════════
 * 三条口径，别改（这一页是证据页，画出来的每一个宽度都要有出处）：
 *   ① **块宽 ∝ 记录到的耗时**：工具调用有 `latencyMs`、模型输出有整轮 `totalMs`、
 *      子代理有 `ms`；**没有记录耗时的步骤按最小宽度画**，并在提示里标「没记耗时」——
 *      绝不用猜出来的数字冒充真实耗时。
 *   ② **主轮步骤的横向位置 = 前面各步已知耗时的累加**：这条流水线本身是串行的
 *      （输入 → 预检 → 学段 → 拼接 → 推理 → 工具 → 检索 → 终审），
 *      信封里没有逐步的开始时刻，累加是唯一不编数字的定位法。
 *      没记耗时的步骤按 {@link MIN_SLOT_MS} 占一格，否则它们会叠在同一像素上。
 *   ③ **子代理块用真实发生时刻**：`spans[].startedAt` 是主进程出网口记的真时间戳，
 *      相对本轮开始就是它的真实横向位置 —— 这一条与上面那条不是一个来源，别混。
 *
 * ★ offTurn=true 的 span（启动补跑，不属于任何一轮）**不进本轮轴**：
 *   它们另起一段，并标「轮外」（见模板里的 `.tl--offturn`）。
 */

/** 没记耗时的一步在轴上占的最小推进量（ms）。 */
const MIN_SLOT_MS = 120
/** 块的最小可见宽度（px）：宽度是 0 的块也得看得见、点得到。 */
const MIN_BLOCK_PX = 8
/** 时间轴刻度条数（0 与总时长必在各一端）。 */
const AXIS_TICKS = 5

/** 时间轴上的一块：`DiagStep` 加上位置与宽度。 */
interface TimelineBlock extends DiagStep {
  /** 相对本轮开始的起始位置（ms）。 */
  startMs: number
  /** 块宽对应的耗时（ms）。 */
  ms: number
  /** 这个耗时**是记录到的**（false = 按最小宽度画的占位）。 */
  timed: boolean
}

/**
 * 这一轮信封里带的子代理 span。
 *
 * ★ 用可选链读 `turn.spans`（V1 之前 / 落盘回放的那份可能没有这个字段）：
 *   缺失就是空数组 —— 时间轴上就不出子代理泳道，而不是渲染一条空泳道。
 */
function spansOf(turn: TurnDiagnostics | null): RuntimeSpan[] {
  if (turn === null) return []
  const raw = (turn as TurnDiagnostics & { spans?: unknown }).spans
  return Array.isArray(raw) ? (raw as RuntimeSpan[]) : []
}

/** 属于**本轮**的子代理调用（真实发生在本轮时间窗内）。 */
const inTurnSpans = computed<RuntimeSpan[]>(() => spansOf(props.turn).filter((span) => !span.offTurn))

/**
 * 轮外（启动补跑）的子代理调用：不进本轮轴，另起一段。
 *
 * ★★ 零轮次时**回落到快照级的那一份**（`diagnostics.offTurnSpans`）：
 *   主进程的规则是「轮外 span 要么挂在快照的 `offTurnSpans`（**还没有轮次可挂**），
 *   要么已迁移进最新一轮的 `spans`」—— 学生首次启动答完五问、一次没聊过，
 *   正是前者。只读 `props.turn` 会让主进程即时推来的那几次调用白推（V5 修的就是这一条）。
 * ★ 有轮次时**只**读这一轮（迁移后的那份）：两处都读会在同一屏出现两份。
 */
const offTurnSpans = computed<RuntimeSpan[]>(() =>
  props.turn === null
    ? diagnostics.offTurnSpans
    : spansOf(props.turn).filter((span) => span.offTurn)
)

/** 把一条 span 变成时间轴上的一块（`baseMs` = 这一段的零点）。 */
function spanBlock(span: RuntimeSpan, baseMs: number): TimelineBlock {
  const facts = [
    span.model === null ? '模型没有记录' : `模型 ${span.model}`,
    `提示词 ${span.promptChars} 字符 · 约 ${span.promptTokEst} tok`,
    span.offTurn ? '轮外（启动补跑）' : `第 ${span.turnIndex ?? '—'} 轮`
  ]
  return {
    key: `span-${span.id}`,
    category: 'subagent',
    title: span.label,
    detail: span.purpose,
    metric: ms(span.ms),
    note: facts.join(' · '),
    state: span.ok ? 'ok' : 'failed',
    // 失败原因（已脱敏）只有拿得到时才给展开，避免一个点了没反应的空开关
    text: span.note === null || span.note === '' ? undefined : span.note,
    textLabel: '看这次调用的问题',
    startMs: Math.max(0, span.startedAt - baseMs),
    ms: span.ms,
    timed: true
  }
}

/** 主轮步骤按顺序累加定位 —— 见文件头口径 ②。 */
const laid = computed<TimelineBlock[]>(() => {
  const out: TimelineBlock[] = []
  let cursor = 0
  for (const step of steps.value) {
    const duration = step.ms ?? 0
    const timed = step.ms !== undefined
    out.push({ ...step, startMs: cursor, ms: duration, timed })
    cursor += Math.max(duration, MIN_SLOT_MS)
  }
  return out
})

/** 本轮子代理块（真实时刻定位）。 */
const spanBlocks = computed<TimelineBlock[]>(() => {
  const base = props.turn?.at ?? 0
  return inTurnSpans.value.map((span) => spanBlock(span, base))
})

/** 主轴上的全部块（主轮 + 本轮子代理）。 */
const blocks = computed<TimelineBlock[]>(() => [...laid.value, ...spanBlocks.value])

/** 轴长：取「累加到哪、子代理到哪、整轮花了多久」三者里的最大值。 */
const axisMs = computed(() => {
  let end = 0
  for (const block of blocks.value) end = Math.max(end, block.startMs + block.ms)
  const total = props.turn?.done.totalMs ?? 0
  return Math.max(end, total, 1)
})

/** 只渲染**有块**的泳道：没发生的分类不摆一条空泳道（那正是「一横条一横条」要避免的）。 */
const lanes = computed(() => {
  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    blocks: blocks.value.filter((block) => block.category === category)
  }))
  return grouped.filter((lane) => lane.blocks.length > 0)
})

/** 轮外那一段自己的零点（最早的一次启动补跑）。 */
const offTurnBaseMs = computed(() =>
  offTurnSpans.value.reduce((min, span) => Math.min(min, span.startedAt), Number.POSITIVE_INFINITY)
)
const offTurnBlocks = computed<TimelineBlock[]>(() =>
  offTurnBaseMs.value === Number.POSITIVE_INFINITY
    ? []
    : offTurnSpans.value.map((span) => spanBlock(span, offTurnBaseMs.value))
)
const offTurnAxisMs = computed(() => {
  let end = 0
  for (const block of offTurnBlocks.value) end = Math.max(end, block.startMs + block.ms)
  return Math.max(end, 1)
})

/** 点开的块（点第二下收起）。 */
const selectedKey = ref('')

/**
 * 点开的块 **同时**在主轴与轮外段里找。
 *
 * ★ 轮外段的块不在主轴 `blocks` 里（它有自己的零点），只查主轴会让
 *   「轮外那一条点不开」—— 而零轮次时它恰恰是**唯一**能点的东西。
 */
const selected = computed<TimelineBlock | null>(
  () =>
    blocks.value.find((block) => block.key === selectedKey.value) ??
    offTurnBlocks.value.find((block) => block.key === selectedKey.value) ??
    null
)

function toggleBlock(key: string): void {
  selectedKey.value = selectedKey.value === key ? '' : key
}

/** 百分比定位（末尾的块夹在 99%：再往右就出框了）。 */
function leftOf(block: TimelineBlock): string {
  const pct = (block.startMs / axisMs.value) * 100
  return `${Math.min(pct, 99).toFixed(2)}%`
}

function widthOf(block: TimelineBlock): string {
  const pct = (block.ms / axisMs.value) * 100
  return block.timed && pct > 0 ? `max(${pct.toFixed(2)}%, ${MIN_BLOCK_PX}px)` : `${MIN_BLOCK_PX}px`
}

function offLeftOf(block: TimelineBlock): string {
  return `${Math.min((block.startMs / offTurnAxisMs.value) * 100, 99).toFixed(2)}%`
}

function offWidthOf(block: TimelineBlock): string {
  return `max(${((block.ms / offTurnAxisMs.value) * 100).toFixed(2)}%, ${MIN_BLOCK_PX}px)`
}

/** 轴上的读数：1 秒以内按毫秒，超过按秒（一位小数；10 秒以上不要小数）。 */
function tickLabel(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`
  return `${Math.round(value)}ms`
}

const ticks = computed(() =>
  Array.from({ length: AXIS_TICKS }, (_, index) => {
    const ratio = index / (AXIS_TICKS - 1)
    return { key: `tick-${index}`, left: `${(ratio * 100).toFixed(2)}%`, label: tickLabel(axisMs.value * ratio) }
  })
)

/** 块上的悬停说明（块本身可能只有 8px 宽，文字放不下）。 */
function blockTitle(block: TimelineBlock): string {
  return [block.title, block.metric, block.timed ? '' : '没记耗时'].filter((part) => part !== '').join(' · ')
}
</script>

<template>
  <section class="seq" data-testid="diag-sequence">
    <p v-if="!turn" class="seq__empty">
      还没有轮次记录。先在左边点一轮，或回对话页问一句再回来。
    </p>

      <header v-if="turn" class="seq__head">
        <h2 class="seq__title">第 {{ turn.turn }} 轮真实发生的先后</h2>
        <!-- ⚠️ 这一段是**上屏文案**：不许出现星号标记（渲染层不解析 Markdown，会原样显示）。 -->
        <p class="seq__lead">
          横向是时间：块的宽度按记录的耗时画，位置按前面各步的耗时依次累加（这条流水线本身就是串行的）。
          没记耗时的步骤按最小宽度排在轴上。点子代理泳道的块看旁路调用，点任意块看这一步的全文。
        </p>
        <ol class="legend" data-testid="diag-sequence-legend">
          <li v-for="cat in CATEGORY_ORDER" :key="cat" class="legend__item" :data-cat="cat">
            <span class="legend__dot" aria-hidden="true" />{{ CATEGORY_LABELS[cat] }}
          </li>
        </ol>
      </header>

      <!-- ── 时间轴（主视图，2026-10-01 用户裁决：竖向列表 → 横向时间线）────
           横向是时间：块宽 ∝ 记录的耗时；主轮步骤的位置按前面各步耗时累加
           （这条流水线是串行的），子代理块用它**真实的发生时刻**（见 script 里三条口径）。
           点任意块看这一步的全文（既有详情内容与文案口径一字未改）。 -->
      <div v-if="turn" class="tl" data-testid="diag-sequence-timeline">
        <div class="tl__axis" aria-hidden="true">
          <span v-for="tick in ticks" :key="tick.key" class="tl__tick" :style="{ left: tick.left }">
            {{ tick.label }}
          </span>
        </div>

        <div
          v-for="lane in lanes"
          :key="lane.category"
          class="tl__lane"
          :data-cat="lane.category"
          :data-testid="`diag-sequence-lane-${lane.category}`"
        >
          <span class="tl__cat">
            <span class="tl__dot" aria-hidden="true" />{{ lane.label }}
          </span>
          <div class="tl__track">
            <button
              v-for="block in lane.blocks"
              :key="block.key"
              type="button"
              class="blk"
              :data-state="block.state ?? ''"
              :data-timed="String(block.timed)"
              :data-on="String(block.key === selectedKey)"
              :style="{ left: leftOf(block), width: widthOf(block) }"
              :title="blockTitle(block)"
              @click="toggleBlock(block.key)"
            >
              <span class="blk__label">{{ block.title }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- ── 轮外（启动补跑）──────────────────────────────────────────
           这些调用发生在某轮对话之外（`offTurn`），不属于任何一轮 —— 所以另起一段、自带零点。
           ★★ 这一段**两个分支都要渲染**：学生首次启动答完五问、一次还没聊过时，
              轮次是空的，而轮外的子代理调用**已经发生**（主进程即时推在快照的
              `offTurnSpans` 上）—— 放进「有轮次」那个分支里就等于把那段数据白推了（V5）。
           ★ 有轮次时这些 span 已被**迁移**进那一轮的 `spans`（主进程保证两处不会同时有），
              所以不会出现两份。 -->
      <section v-if="offTurnBlocks.length > 0" class="tl tl--offturn" data-testid="diag-sequence-offturn">
        <p class="tl__offhead">
          轮外（启动补跑）：这些调用不在某轮对话里<template v-if="turn">，所以不在上面那条轴上</template>。
        </p>
        <div class="tl__lane" data-cat="subagent">
          <span class="tl__cat"><span class="tl__dot" aria-hidden="true" />子代理</span>
          <div class="tl__track">
            <button
              v-for="block in offTurnBlocks"
              :key="block.key"
              type="button"
              class="blk"
              :data-state="block.state ?? ''"
              :data-on="String(block.key === selectedKey)"
              :style="{ left: offLeftOf(block), width: offWidthOf(block) }"
              :title="blockTitle(block)"
              @click="toggleBlock(block.key)"
            >
              <span class="blk__label">{{ block.title }}</span>
            </button>
          </div>
        </div>
      </section>

      <!-- ── 点开的详情（复用既有详情内容与文案口径）────────────────── -->
      <div v-if="selected" class="detail" data-testid="diag-sequence-detail">
        <p class="detail__head">
          <span class="detail__cat">{{ CATEGORY_LABELS[selected.category] }}</span>
          <span class="detail__title">{{ selected.title }}</span>
          <span v-if="selected.metric" class="detail__metric k12-num">{{ selected.metric }}</span>
        </p>
        <p class="detail__line">{{ selected.detail }}</p>
        <p v-if="selected.note" class="detail__note">{{ selected.note }}</p>
        <p v-if="!selected.timed" class="detail__note">
          这一步没有记录耗时，所以它在轴上只占最小宽度（不用猜出来的数字冒充耗时）。
        </p>
        <div v-if="selected.text" class="step__full">
          <p class="step__fullhead">
            {{ selected.textLabel ?? '原文' }}
            <span v-if="selected.cut" class="step__cut">（展示已截断，原文更长）</span>
          </p>
          <pre class="step__pre">{{ selected.text }}</pre>
        </div>
      </div>

      <!-- ── 完整清单（原竖向读法，默认折叠）──────────────────────────
           时间轴答「先后与耗时」，清单答「每一步的全文」——同一份数据两种读法，
           所以一条都没删，只是不再默认占满这一屏。 -->
      <details v-if="turn" class="list">
        <summary class="list__sum">完整清单（{{ steps.length }} 步）</summary>
        <ol class="seq__list" data-testid="diag-sequence-steps">
          <li v-for="step in steps" :key="step.key" class="seq__item">
            <!-- ★ 可展开的横条用**原生 `<details>`**（与三栏视图里的 Prompt 分段折叠同一套）；
                 没有原文可看的横条就是一只普通 div —— 不留一个点了没反应的开关。
                 两者共用同一段行内结构，所以这里用 `<component :is>` 换外壳。 -->
            <component
              :is="step.text ? 'details' : 'div'"
              class="step"
              :data-cat="step.category"
              :data-state="step.state ?? ''"
            >
              <component :is="step.text ? 'summary' : 'div'" class="step__row">
                <span class="step__cat">
                  <span class="step__bar" aria-hidden="true" />{{ CATEGORY_LABELS[step.category] }}
                </span>
                <span class="step__body">
                  <span class="step__title">{{ step.title }}</span>
                  <span class="step__detail">{{ step.detail }}</span>
                  <span v-if="step.note" class="step__note">{{ step.note }}</span>
                </span>
                <span class="step__right">
                  <span v-if="step.metric" class="step__metric k12-num">{{ step.metric }}</span>
                  <span v-if="step.text" class="step__more">可展开</span>
                </span>
              </component>
              <div v-if="step.text" class="step__full">
                <p class="step__fullhead">
                  {{ step.textLabel ?? '原文' }}
                  <span v-if="step.cut" class="step__cut">（展示已截断，原文更长）</span>
                </p>
                <pre class="step__pre">{{ step.text }}</pre>
              </div>
            </component>
          </li>
        </ol>
      </details>
  </section>
</template>

<style scoped>
.seq {
  /* 与三栏视图的 `.cols` 同级：撑满「运行透视」页给子页留的那一块，滚动在内部 */
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  /* ⚠️ 上边距为 0：吸顶的图例自己带 `padding-top`。留在这里的话，横条会从吸顶块
     上方那 12px 的缝里透出来（滚动时能看到前一条的边）。 */
  padding: 0 14px 16px;
}
.seq__head {
  /* 图例要**一直看得见**：几十条横条滚起来之后，没有图例就得回头数颜色。
     所以它吸在滚动区顶部（底色必须铺上，否则下面的横条会从字缝里透出来）。 */
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 上边距住在吸顶块里（见 `.seq` 那条注释），下边距是它与第一条横条的分隔 */
  padding: 12px 0 8px;
  border-bottom: 1px solid var(--k12-border);
  background: var(--k12-surface);
}
.seq__title {
  margin: 0;
  font-size: var(--k12-fs-body-sm);
  font-weight: 700;
  color: var(--k12-fg);
}
.seq__lead,
.seq__empty {
  margin: 0;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
/* ── 分类图例：八个分类与它们的颜色 ───────────────────────────────── */
.legend {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}
.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--cat-soft, var(--k12-surface-2));
  color: var(--cat-ink, var(--k12-fg-2));
  font-size: var(--k12-fs-label);
  font-weight: 650;
}
.legend__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--cat-ink, var(--k12-fg-2));
}
/* ── 横条流 ─────────────────────────────────────────────────────── */
.seq__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.seq__item {
  min-width: 0;
}
.step {
  /* 左缘那 3px 是分类的颜色（与左列色条同一个 --cat-ink），一眼看出这一条属于哪一类 */
  --cat-ink: var(--k12-fg-2);
  --cat-soft: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  border-left: 3px solid var(--cat-ink);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
}
.step__row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: baseline;
  padding: 8px 10px;
}
summary.step__row {
  cursor: pointer;
  /* 原生三角收掉：颜色条与左列分类已经够表达「这一条是什么」，多一个三角只是噪音 */
  list-style: none;
}
summary.step__row::-webkit-details-marker {
  display: none;
}
.step__cat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-self: start;
  padding: 2px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--cat-soft);
  color: var(--cat-ink);
  font-size: var(--k12-fs-label);
  font-weight: 650;
  white-space: nowrap;
}
.step__bar {
  flex: none;
  width: 3px;
  height: 12px;
  border-radius: var(--k12-r-pill);
  background: var(--cat-ink);
}
.step__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.step__title {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg);
  word-break: break-word;
}
/* 要点只占一行，长了省略号；全文永远在展开区里（一个字都不丢） */
.step__detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
}
.step__note {
  font-size: var(--k12-fs-label);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
  word-break: break-word;
}
.step__right {
  justify-self: end;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  text-align: right;
  /* 数字那一列**不许把要点挤没**：封顶之后长句子只会占满自己的那一格 */
  max-width: 260px;
}
.step__metric {
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
  /* 极长的数字串（例如一整条过滤条件被后端塞进 metric）也只会换行，不会撑破那一格 */
  overflow-wrap: anywhere;
}
.step__more {
  font-size: var(--k12-fs-label);
  color: var(--k12-accent-ink);
  white-space: nowrap;
}
/* ── 展开区（原生 details 的体）──────────────────────────────────── */
.step__full {
  padding: 0 10px 10px 10px;
}
.step__fullhead {
  margin: 0 0 4px;
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.step__cut {
  color: var(--k12-warn);
}
.step__pre {
  margin: 0;
  padding: 8px;
  max-height: 240px;
  overflow: auto;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-family: var(--k12-font-mono, monospace);
  font-size: var(--k12-fs-label);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
/* ── 真的出问题的那几条：左缘 + 底色 + 右端数字一起换成警示色 ─────────
 * ★ 为什么底色也要换：分类里「安全」这一档本身就是红的（它的业务就是拦下），
 *   只把左缘变红的话，「通过」与「拦下」两条看上去差不多。底色一铺就没有歧义了。 */
.step[data-state='blocked'],
.step[data-state='failed'] {
  border-left-color: var(--k12-bad);
  background: var(--k12-bad-soft);
}
.step[data-state='blocked'] .step__metric,
.step[data-state='failed'] .step__metric {
  color: var(--k12-bad);
  font-weight: 650;
}
/* ── 九个分类的配色（只用既有令牌；文字色都是能读的深色，底是它自己的浅底）
 * 泳道、块、图例、清单行**共用这一份映射**：新增分类只改这里一处，
 * 四处各写一遍必然漂（第 3 个消费者就是这次的时间轴）。
 *
 * ★ 子代理为什么复用「模型」那对令牌：它本质就是一次**旁路模型调用**
 *   （五问概括 / 画像刷新 / 画像小结都打在主进程唯一的模型出网口上）。
 *   不新造色系（这一页只允许既有分类令牌），与主轮模型步骤的区分交给
 *   **虚线边 + 独立泳道**（见 .blk[data-cat='subagent']）——形状而不是颜色，
 *   色觉障碍下也读得出来。 */
.step[data-cat='user'],
.tl__lane[data-cat='user'],
.legend__item[data-cat='user'] {
  --cat-ink: var(--k12-accent-ink);
  --cat-soft: var(--k12-accent-soft);
}
.step[data-cat='safety'],
.tl__lane[data-cat='safety'],
.legend__item[data-cat='safety'] {
  --cat-ink: var(--k12-bad);
  --cat-soft: var(--k12-bad-soft);
}
.step[data-cat='grade'],
.tl__lane[data-cat='grade'],
.legend__item[data-cat='grade'] {
  --cat-ink: var(--k12-warn);
  --cat-soft: var(--k12-warn-soft);
}
.step[data-cat='prompt'],
.tl__lane[data-cat='prompt'],
.legend__item[data-cat='prompt'] {
  --cat-ink: var(--k12-cyan);
  --cat-soft: var(--k12-cyan-soft);
}
.step[data-cat='retrieval'],
.tl__lane[data-cat='retrieval'],
.legend__item[data-cat='retrieval'] {
  --cat-ink: var(--k12-good);
  --cat-soft: var(--k12-good-soft);
}
.step[data-cat='tool'],
.tl__lane[data-cat='tool'],
.legend__item[data-cat='tool'] {
  --cat-ink: var(--k12-fg-2);
  --cat-soft: var(--k12-surface-2);
}
.step[data-cat='model'],
.tl__lane[data-cat='model'],
.legend__item[data-cat='model'] {
  --cat-ink: var(--k12-chip-fg);
  --cat-soft: var(--k12-chip-bg);
}
.step[data-cat='subagent'],
.tl__lane[data-cat='subagent'],
.legend__item[data-cat='subagent'] {
  --cat-ink: var(--k12-chip-fg);
  --cat-soft: var(--k12-chip-bg);
}
.step[data-cat='wrap'],
.tl__lane[data-cat='wrap'],
.legend__item[data-cat='wrap'] {
  --cat-ink: var(--k12-muted);
  --cat-soft: var(--k12-surface-2);
}
/* ══ 时间轴（2026-10-01 用户裁决：竖向列表 → 横向时间线）══════════════════
 * 一条泳道一个分类：左边固定宽的分类名，右边轨道；块在轨道里**绝对定位**。
 * 位置与宽度都是轴的百分比 ⇒ 泳道之间天然对齐，一眼看出「检索与工具是不是
 * 同一段时间里的事」。轨道铺一层浅底：这一段就是这一轮的时间范围。 */
.tl {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 轴刻度：与轨道的起点对齐（分类列 70px + gap 6px），下缘一条线就是时间轴 */
.tl__axis {
  position: relative;
  height: 16px;
  margin-left: 76px;
  border-bottom: 1px solid var(--k12-border);
}
.tl__tick {
  position: absolute;
  bottom: 1px;
  transform: translateX(-50%);
  font-size: var(--k12-fs-label);
  color: var(--k12-muted-2);
  white-space: nowrap;
}
.tl__lane {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
}
.tl__cat {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: 70px;
  padding: 1px 6px;
  border-radius: var(--k12-r-pill);
  background: var(--cat-soft);
  color: var(--cat-ink);
  font-size: var(--k12-fs-label);
  font-weight: 650;
  white-space: nowrap;
}
.tl__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--cat-ink);
}
.tl__track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 20px;
  border-radius: var(--k12-r-control);
  background: var(--k12-surface-2);
}
/* 块：颜色走分类令牌（.tl__lane[data-cat] 给的 --cat-*），宽高由模板的 style 给 */
.blk {
  position: absolute;
  top: 3px;
  height: 14px;
  padding: 0 4px;
  border: 1px solid var(--cat-ink);
  border-radius: var(--k12-r-control);
  background: var(--cat-soft);
  color: var(--cat-ink);
  font-family: inherit;
  font-size: var(--k12-fs-label);
  line-height: 1;
  text-align: left;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}
.blk__label {
  pointer-events: none;
}
.blk[data-on='true'] {
  outline: 2px solid var(--k12-accent);
  outline-offset: 1px;
}
/* ★ 没记耗时：**虚线边 + 透明底** —— 形状上就说明「这一块的宽度不是量出来的」，
 *   不靠颜色（色觉障碍下也读得出来），也不给它一个假数字。 */
.blk[data-timed='false'] {
  border-style: dashed;
  background: transparent;
}
/* ★ 子代理：虚线边与主轮步骤区分（颜色复用「模型」那对令牌，理由见配色段） */
.blk[data-cat='subagent'] {
  border-style: dashed;
}
.blk[data-state='blocked'],
.blk[data-state='failed'] {
  border-color: var(--k12-bad);
  background: var(--k12-bad-soft);
  color: var(--k12-bad);
}
@media (hover: hover) and (pointer: fine) {
  .blk:hover {
    border-color: var(--k12-accent-ink);
  }
}

/* ── 轮外（启动补跑）：另起一段、自带零点，与主轴用一条竖线分开 ────────── */
.tl--offturn {
  margin-top: 4px;
  padding-left: 8px;
  border-left: 2px solid var(--k12-border);
}
.tl__offhead {
  margin: 0 0 2px;
  font-size: var(--k12-fs-label);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

/* ── 点开的详情（内容与文案口径与清单行完全相同）────────────────────── */
.detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.detail__head {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.detail__cat {
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.detail__title {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg);
}
.detail__metric {
  margin-left: auto;
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.detail__line {
  margin: 0;
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
}
.detail__note {
  margin: 0;
  font-size: var(--k12-fs-label);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

/* ── 完整清单（原来的竖向读法，默认折叠）────────────────────────────── */
.list {
  margin-top: 2px;
}
.list__sum {
  padding: 4px 0;
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
  cursor: pointer;
}
</style>
