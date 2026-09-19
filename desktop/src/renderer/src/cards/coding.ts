/**
 * 编程卡片的**纯逻辑**（票 18/19 的前端一半）：把 `payload` 事件的 `unknown` 载荷
 * 投影成可渲染的结构，并生成发给主 Agent 的两条消息。
 *
 * ★ 与 `cards/quiz.ts` + `QuizCard.vue` 是同一套构型：逻辑纯函数化、组件只管渲染。
 *   这样做的好处是投影规则能被 `node --test` 直接单测（`tests/coding-extension.test.ts`
 *   里的 G19-hint-* 与 coding-* 就覆盖了本文件）——
 *   组件里的模板语法测不了，但"载荷怎么解释"这件事必须测。
 *
 * 四条纪律（本文件是它们的落点，改动前先读）：
 *
 * 1. **认不出的载荷不许猜**：返回 `{ kind: 'unknown', text }`，卡片退化成一句说明。
 *    绝不因为"看起来像"就当成模板或结果 —— 猜错会渲染出一张骗人的卡片。
 * 2. **原始 traceback 与中文反馈分开存**：界面上展示中文 `feedback`，
 *    原文只进折叠区。两者混在一起就会"一屏红字吓退学生"。
 * 3. **前端不许指定提示级别**：{@link buildHintRequestMessage} 只说"我卡住了"，
 *    级别由主进程的状态表推进（那里才记得住"已经给到第几级"）。
 * 4. **不给答案**：本文件不生成任何提示文本，只搬运后端给的 `hint` 原文。
 */

/** 一条分级提示（契约 `CodingHint`；载荷里还会带 `kpId` 用于卡片归属）。 */
export interface CodingHintView {
  level: 1 | 2 | 3
  hint: string
}

/** 模板视图（契约 `CodeTemplate`；**没有 `solution`**）。 */
export interface CodingTemplateView {
  kind: 'template'
  kpId: string
  scaffold: string
  expectedBehavior: string
}

/** 运行结果视图（契约 `CodeEvaluation` + 卡片需要的补充字段）。 */
export interface CodingResultView {
  kind: 'result'
  kpId: string
  ok: boolean
  stdout: string
  /** 归一化后的错误：中文解释与原始 traceback 分开存（见纪律 2）。 */
  error: {
    type: string
    message: string
    rawTraceback: string
    line: number | null
  } | null
  feedback: string
  /** 连续失败次数（后端按 kp 计数，答对清零）。 */
  consecutiveFailures: number
  /** 是否应当由主 Agent 主动介入（阈值见 `coding.ts` 的 `MAX_CONSECUTIVE_FAILURES`）。 */
  shouldIntervene: boolean
  /** 是否被超时中断（死循环的正向证据，票 18 的头号演示）。 */
  interrupted: boolean
  elapsedMs: number
}

/** 认不出的载荷：退化成一句说明，不做任何猜测。 */
export interface CodingUnknownView {
  kind: 'unknown'
  /** 主进程在失败形态里带的兜底文本，可能为空。 */
  text: string
}

export type CodingCardView = CodingTemplateView | CodingResultView | CodingUnknownView

/** 编辑器里拿不到的代码时，消息里最多带多少字的预览（别把长代码灌进 prompt）。 */
export const MAX_CODE_PREVIEW_CHARS = 400

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 把 `payload` 事件里的载荷投影成卡片视图。
 *
 * 判别顺序（**结构判别**，不看 `tool` 字段 —— `tool` 只是提示，不可信）：
 *   1. 有 `codeOk`（布尔，老载荷回落 `ok`）且有 `feedback` → 评估结果；
 *   2. 有非空 `scaffold` → 模板；
 *   3. 其余 → `unknown`（含失败形态 `{tool, kind, text}`，把文本原样交给卡片展示）。
 *
 * ★ **提示载荷不在这里分支**：`get_coding_hint` 的载荷形状是 `{kpId, level, hint}`，
 *   它**不单独成卡** —— 交给 {@link collectHints} 收进对应知识点的卡片，
 *   让学生看到 1→2→3 逐级加深的过程。判据是"有 level 与 hint、但没有 scaffold/feedback"。
 */
export function readCodingCard(payload: unknown): CodingCardView {
  if (typeof payload !== 'object' || payload === null) return { kind: 'unknown', text: '' }
  const record = payload as Record<string, unknown>

  // 1) 评估结果（`evaluate_code`）：用**两个**字段一起判，降低误判概率
  //
  // ★★ 判据优先读 `codeOk`：主进程把「学生代码跑通没有」（`codeOk`）与「工具本身成功没有」
  //   （`toolOk`）**分开命名**了 —— 因为 `details.ok` 一旦同时承载两者，学生写错一行代码
  //   （工具完全正常）会在工具调用轨迹里被画成 `fail` 节点。
  // ★ 但对**历史载荷 / 别处来的数据**保留对 `ok` 的兜底：两者同值，读谁都一样，
  //   而少了这条兜底，一份还没更新的老载荷会让卡片退化成「认不出」。
  const codeOk = typeof record.codeOk === 'boolean' ? record.codeOk : record.ok
  if (typeof codeOk === 'boolean' && typeof record.feedback === 'string') {
    return {
      kind: 'result',
      kpId: readText(record.kpId) ?? '',
      ok: codeOk,
      stdout: typeof record.stdout === 'string' ? record.stdout : '',
      error: projectError(record.error),
      feedback: record.feedback,
      consecutiveFailures: readNumberOr(record.consecutiveFailures, 0),
      shouldIntervene: record.shouldIntervene === true,
      interrupted: record.interrupted === true,
      elapsedMs: readNumberOr(record.elapsedMs, 0)
    }
  }

  // 2) 模板（`get_code_template`）
  const scaffold = typeof record.scaffold === 'string' ? record.scaffold : null
  if (scaffold !== null && scaffold.length > 0) {
    return {
      kind: 'template',
      kpId: readText(record.kpId) ?? '',
      scaffold,
      expectedBehavior: readText(record.expectedBehavior) ?? ''
    }
  }

  // 3) 认不出
  return { kind: 'unknown', text: readText(record.text) ?? '' }
}

/** 错误投影（字段不齐就当作"没有错误"，而不是渲染半个对象）。 */
function projectError(raw: unknown): CodingResultView['error'] {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const type = readText(record.type)
  // `message` 允许是空串（认不出类名时后端会给通用文案，但字段一定在）；
  // 缺 `message` 字段才是契约漂移 —— 那种情况下当作"没有错误"更安全。
  const message = typeof record.message === 'string' ? record.message : null
  if (type === null || message === null) return null
  return {
    type,
    message,
    rawTraceback: typeof record.rawTraceback === 'string' ? record.rawTraceback : '',
    line: typeof record.line === 'number' && Number.isFinite(record.line) ? record.line : null
  }
}

/**
 * 一条提示载荷的投影（认不出返回 `null`，整条丢掉）。
 *
 * ★ 只认 `level` ∈ {1,2,3} 且 `hint` 非空 —— 契约就是这么定的；
 *   认不准的提示宁可丢掉，也不要给学生一条"第 undefined 级"的怪东西。
 */
export function projectHint(payload: unknown): CodingHintView | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const level = record.level
  const hint = readText(record.hint)
  if (hint === null) return null
  if (level !== 1 && level !== 2 && level !== 3) return null
  return { level, hint }
}

/** 载荷里带的 `kpId`（用于把提示/结果挂到正确的卡片上）。 */
export function payloadKpId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  return readText((payload as Record<string, unknown>).kpId) ?? ''
}

/**
 * 收集**整段对话**里某个知识点的提示（按 level 去重、升序返回）。
 *
 * 为什么要跨轮收集：提示在某一轮以独立载荷到达，而模板卡片在**更早**的一轮里。
 * 只看本轮的话，学生点了「求助」却看不到提示出现（提示与题目不在同一张卡片上）。
 * 与练习卡片的 `collectQuizResults` 同一手法。
 */
export function collectHints(cards: Array<{ payload: unknown }>, kpId: string): CodingHintView[] {
  const byLevel = new Map<number, CodingHintView>()
  for (const card of cards) {
    const hint = projectHint(card.payload)
    if (hint === null) continue
    const cardKp = payloadKpId(card.payload)
    // 归属：载荷带 kpId 时必须匹配（防多知识点串台）；不带 kpId 的提示归到当前卡片
    if (cardKp !== '' && kpId !== '' && cardKp !== kpId) continue
    byLevel.set(hint.level, hint)
  }
  return [...byLevel.values()].sort((left, right) => left.level - right.level)
}

/**
 * 收集**整段对话**里某个知识点的**最新一次**评估（后到的覆盖先前的）。
 *
 * 为什么是最新一次：学生可能改了代码再跑一遍 —— 界面上该显示现在这份代码的结果，
 * 而不是他五分钟前那次失败的结论。
 */
export function collectResult(
  cards: Array<{ payload: unknown }>,
  kpId: string
): CodingResultView | null {
  let latest: CodingResultView | null = null
  for (const card of cards) {
    const view = readCodingCard(card.payload)
    if (view.kind !== 'result') continue
    if (kpId !== '' && view.kpId !== '' && view.kpId !== kpId) continue
    latest = view // 遍历顺序即时间顺序：后面的覆盖前面的
  }
  return latest
}

/** 代码预览（消息里带上学生写的代码，模型才看得见问题在哪）。 */
function codePreview(code: string): string {
  const trimmed = code.trim()
  return trimmed.length > MAX_CODE_PREVIEW_CHARS
    ? `${trimmed.slice(0, MAX_CODE_PREVIEW_CHARS)}…`
    : trimmed
}

/**
 * 学生点「求助」时发给主 Agent 的那条消息。
 *
 * ★ **不指定级别**：只说"我卡住了 + 我现在的代码"。级别由主进程的状态表推进
 *   （那里才记得住"已经给到第几级"）—— 前端一旦能指定级别，
 *   就会出现"直接要第 3 级"绕开引导的路子（陷阱：直接给答案）。
 */
export function buildHintRequestMessage(kpId: string, code: string): string {
  const preview = codePreview(code)
  return (
    `【编程求助】我在做「${kpId}」这道题，卡住了，请给我一点提示。\n` +
    (preview.length > 0 ? `我现在的代码：\n\`\`\`python\n${preview}\n\`\`\`\n` : '') +
    '（请用 get_coding_hint 给提示。不要直接给我完整答案，我想自己试。）'
  )
}

/**
 * 学生点「运行」时发给主 Agent 的那条消息。
 *
 * ★ 分工：**卡片已经在 Worker 里跑过一次**（真实输出立刻显示在界面上），
 *   这条消息是请模型**讲一讲**这份代码 —— 模型的 `evaluate_code` 会给出
 *   中文反馈与下一步提示，并顺带推进连续失败计数（进而可能触发主动介入）。
 *   所以消息里给的是代码，而不是"运行结果"：对错的判据永远是真实执行。
 */
export function buildRunRequestMessage(kpId: string, code: string): string {
  const preview = codePreview(code)
  return (
    `【编程练习】我写完「${kpId}」的代码了，刚在卡片上运行过。请用 evaluate_code 帮我看看。\n` +
    `\`\`\`python\n${preview}\n\`\`\`\n` +
    '（运行结果以真实执行为准；请简短引导，不要直接给正确代码。）'
  )
}

/**
 * 状态条文案：把毫秒数与"是否被中断"拼成一句话。
 *
 * 中断时**不显示毫秒数是不够的** —— 学生需要知道"是程序停不下来被我叫停了"，
 * 而不是"我的代码错了"。所以中断与普通失败在文案上必须能分开。
 */
export function formatRunMeta(elapsedMs: number, interrupted: boolean): string {
  const ms = Math.max(0, Math.round(elapsedMs))
  return interrupted ? `已中断（运行 ${ms} ms）` : `运行 ${ms} ms`
}
