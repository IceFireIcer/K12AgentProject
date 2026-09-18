/**
 * 界面文案映射（学段名 / 学段提示语 / 卡片种类 / 轮次状态 / 练习卡片）。
 *
 * 只做「枚举 → 中文」这一件事：四学段字面量、`PayloadKind` 与题型都来自冻结契约
 * （`@shared/ipc-events` 与 OpenAPI 生成物），这里不新增任何枚举值。
 */

/*
 * 设计备忘：内联卡片种类（§9.3 的三个 `kind`）。这里原来还有
 * `PAYLOAD_KIND_LABELS` / `PAYLOAD_KIND_HINTS` 两组映射，**不要把它们加回来**：
 * 唯一消费点是 `cards/InlineCard.vue` 里那个「未识别 kind」的占位卡片，
 * 而 `kind` 在 `api/events.ts` 已由白名单收窄成 `animation | coding | quiz` 三种，
 * 三个分支互相穷尽 —— 那个 v-else 永不渲染（连带一个永远禁用的按钮）。
 * 卡片标题如今由各卡片自己写（「动画讲解」「编程练习」「随堂练习」）。
 * 新增卡片种类时：改 `shared/ipc-events.ts` 的 `PayloadKind` + `events.ts` 的白名单 + 这里加分支。
 */

import type { GradeLevel } from '@shared/ipc-events'
// ★ `GradeOrigin` 只存在于 `main/ipc/channels.ts`（`shared/ipc-events.ts` 里没有它），
//   从 `./api/grade` 取 —— 那里已经 re-export 过（渲染进程不重复声明同一形状）。
//   必须写成 **type-only import**：纯类型导入编译后被完全擦除，
//   所以「labels.ts 依赖 api/grade」在运行时**不存在**，不会有循环加载。
import type { GradeOrigin } from './api/grade'
import type { QuizQuestionType } from './cards/quiz'
import type { TurnStatus } from './api/events'

/** 四学段的中文名（执行文档 §6.2 的字面量，一一对应）。 */
export const GRADE_LABELS: Record<GradeLevel, string> = {
  primary_low: '小学低年级',
  primary_high: '小学高年级',
  junior: '初中',
  senior: '高中'
}

/** 学段还没判出来时指示器上的字（★ 不许拿冷启动默认值冒充判定结果）。 */
export const GRADE_UNKNOWN_LABEL = '待判定'

/**
 * 「学段是怎么定下来的」这件事的说法（指示器上必须能看出来，否则手动选完看不出生效）。
 *
 * ★ 为什么 `default` 也映射成「AI 引擎推算」：冷启动的默认值走的就是引擎那条线 ——
 *   系统还没判出来，随时会改写它。而「还没判出来」这一档在界面上已经由
 *   {@link GRADE_UNKNOWN_LABEL}（「待判定」）表达，且指示器在未判定时**不显示**这一句，
 *   所以这里不需要第三种说法（也不需要「默认」这种对学生毫无意义的字眼）。
 */
export const GRADE_ORIGIN_LABELS: Record<GradeOrigin, string> = {
  explicit: '手动选中',
  inferred: 'AI 引擎推算',
  default: 'AI 引擎推算'
}

/**
 * ★ **唯一**的「学段来源 → 中文」实现（指示器与设置页都调它）。
 *
 * 为什么必须收口成一个函数：两个入口各写一份映射，改一处忘另一处时
 * 表现是「同一个学段，指示器说『手动选中』、设置页说『AI 引擎推算』」——
 * 学生据此判断自己刚才那一下有没有生效，两处不一致等于告诉他没生效。
 *
 * `null`（还没收到任何推送）显示「AI 引擎推算」，与 `default` 同口径：
 * 那时 `currentGrade` 也是 `null`，界面已经写着「待判定」，
 * 括号里再写一遍「待判定」会变成「当前：待判定（待判定）」。
 */
export function gradeOriginLabel(origin: GradeOrigin | null): string {
  return origin === null ? GRADE_ORIGIN_LABELS.default : GRADE_ORIGIN_LABELS[origin]
}

/**
 * 系统判定出学段（或判定结果变化）时，给学生的一句**简短**提示。
 *
 * ★ 为什么要有这句话：学段是**系统自己判的**，学生没做过任何操作；
 *   不说一声的话，适配发生了也看不出来。所以这里只陈述「我按什么说法讲」，
 *   不邀功、不解释规则、不需要学生确认。
 * ★ 只在 `origin === 'inferred'` 时给（见 `stores/chat.ts` 的 `applyGradeState`）：
 *   学生自己刚选完的那一下有 {@link gradeManualNotice} 这条更贴切的回执，
 *   再叠一句「我按X的说法来讲」等于跟他说「系统替你改成了X」—— 事实反了。
 */
export function gradeAdaptNotice(grade: GradeLevel): string {
  return `我按${GRADE_LABELS[grade]}的说法来讲。`
}

/**
 * 学生**手动选定**学段后的回执（与 {@link gradeAdaptNotice} 并列的一次性提示）。
 *
 * ★ 为什么这句必须存在：手动入口是一个显式动作，学生点完要**当场**看到它生效；
 *   而生效与否只有一个可见证据 —— 指示器上的学段名变了（服务端真的写了库，
 *   主进程再把结果推回来）。这句提示让「变没变」不必靠学生自己比对。
 * ★ 措辞用「已按你选的…」而不是「我按…来讲」：主语的差别就是来源的差别，
 *   学生要能一眼分清「我选的」与「系统推的」。
 */
export function gradeManualNotice(grade: GradeLevel): string {
  return `已按你选的${GRADE_LABELS[grade]}来讲。`
}

  quiz: '做几道题，检验一下刚学的'

/**
 * 「正在学哪一章」这一行的**唯一**拼装实现（对话页顶栏指示器与设置页都调它）。
 *
 * ★ 为什么收口：两个入口各拼一次，改一处忘另一处时表现是「同一个状态，一处写『正在学：第4章…』、
 * ★ 章标题本身已经含学段语境（「第4章 用 Python 处理数据」），**后面不再重复学段标签**。
 */
  return title.length === 0 ? CHAPTER_NONE_LABEL : `正在学：${title}`
}

export const TURN_STATUS_LABELS: Record<TurnStatus, string> = {
  streaming: '正在回答',
  done: '回答完成',
  blocked: '已撤回',
  error: '能力受限'
}

/** 三种题型的中文名（`QuizQuestionType`，契约里的三个字面量）。 */
export const QUIZ_TYPE_LABELS: Record<QuizQuestionType, string> = {
  choice: '选择题',
  blank: '填空题',
  code_blank: '代码填空'
}

/** 判分方式（`QuizResult.scoredBy`）：客观题规则判分 / 主观题模型判分。 */
export const SCORED_BY_LABELS: Record<'rule' | 'llm', string> = {
  rule: '规则判分',
  llm: '模型判分'
}

/**
 * 掌握度变化的中文展示（`QuizResult.masteryDelta`，后端已限幅 ±0.2）。
 *
 * ★ 只做**格式化**：不重新计算、不判对错、不做第二套限幅 —— 判分只在后端（§6.3）。
 */
export function formatMasteryDelta(delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return '掌握度不变'
  const sign = delta > 0 ? '+' : ''
  return `掌握度 ${sign}${delta.toFixed(2)}`
}
