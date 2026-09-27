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
import type { TurnDiagnostics } from '@shared/diagnostics'

const props = defineProps<{
  /** 要摊开的那一轮（`null` = 还没有任何一轮 / 还没选中）。 */
  turn: TurnDiagnostics | null
}>()

/** 八个分类（左列文案的**唯一来源**）。 */
type DiagCategory = 'user' | 'safety' | 'grade' | 'prompt' | 'retrieval' | 'tool' | 'model' | 'wrap'

const CATEGORY_LABELS: Record<DiagCategory, string> = {
  user: '用户',
  safety: '安全',
  grade: '学段',
  prompt: '提示词',
  retrieval: '检索',
  tool: '工具',
  model: '模型',
  wrap: '收尾'
}

/** 图例的顺序（= 分类的固定顺序，与横条流无关）。 */
const CATEGORY_ORDER: readonly DiagCategory[] = [
  'user',
  'safety',
  'grade',
  'prompt',
  'retrieval',
  'tool',
  'model',
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
      state: tool.ok ? 'ok' : 'failed'
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
      state: turn.done.ok ? 'ok' : 'failed'
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
</script>

<template>
  <section class="seq" data-testid="diag-sequence">
    <p v-if="!turn" class="seq__empty">
      还没有轮次记录。先在左边点一轮，或回对话页问一句再回来。
    </p>

    <template v-else>
      <header class="seq__head">
        <h2 class="seq__title">第 {{ turn.turn }} 轮真实发生的先后</h2>
        <p class="seq__lead">自上而下就是它的真实顺序。每条横条最前面是分类，右侧是这一步的数字。</p>
        <ol class="legend" data-testid="diag-sequence-legend">
          <li v-for="cat in CATEGORY_ORDER" :key="cat" class="legend__item" :data-cat="cat">
            <span class="legend__dot" aria-hidden="true" />{{ CATEGORY_LABELS[cat] }}
          </li>
        </ol>
      </header>

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
    </template>
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
/* ── 八个分类的配色（只用既有令牌；文字色都是能读的深色，底是它自己的浅底）*/
.step[data-cat='user'],
.legend__item[data-cat='user'] {
  --cat-ink: var(--k12-accent-ink);
  --cat-soft: var(--k12-accent-soft);
}
.step[data-cat='safety'],
.legend__item[data-cat='safety'] {
  --cat-ink: var(--k12-bad);
  --cat-soft: var(--k12-bad-soft);
}
.step[data-cat='grade'],
.legend__item[data-cat='grade'] {
  --cat-ink: var(--k12-warn);
  --cat-soft: var(--k12-warn-soft);
}
.step[data-cat='prompt'],
.legend__item[data-cat='prompt'] {
  --cat-ink: var(--k12-cyan);
  --cat-soft: var(--k12-cyan-soft);
}
.step[data-cat='retrieval'],
.legend__item[data-cat='retrieval'] {
  --cat-ink: var(--k12-good);
  --cat-soft: var(--k12-good-soft);
}
.step[data-cat='tool'],
.legend__item[data-cat='tool'] {
  --cat-ink: var(--k12-fg-2);
  --cat-soft: var(--k12-surface-2);
}
.step[data-cat='model'],
.legend__item[data-cat='model'] {
  --cat-ink: var(--k12-chip-fg);
  --cat-soft: var(--k12-chip-bg);
}
.step[data-cat='wrap'],
.legend__item[data-cat='wrap'] {
  --cat-ink: var(--k12-muted);
  --cat-soft: var(--k12-surface-2);
}
</style>
