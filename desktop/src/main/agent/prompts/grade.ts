/**
 * 学段 → System Prompt 的唯一查表点（票 06；执行文档 §10.5 / §9.4 #1）。
 *
 * ★ 用途：`before_agent_start` 每轮把本轮 system prompt **整段替换**成这里的模板。
 *   - **学段由服务端推断引擎决定**（`server/app/grade/rules.py`），达到阈值时自动生效；
 *     主进程只把**当前生效值**（`gradeExtension.appliedGrade()`）读出来查表。
 *     `ChatSendRequest` 里没有学段字段，学生端也没有选择入口（D-020 翻转）。
 *   - 四份模板的共性纪律在 `rules.ts`，学段差异在各自文件里。
 *
 * ★ 为什么不复用 `baseline.ts`：baseline 是票 03 的**学段无关**冒烟基线（关卡 B₁ 用），
 *   它没有学段语气、也没有工具边界声明。聊天路径必须用学段模板，否则「同一问题四学段可区分」
 *   这条验收（20% 教育适配性）不成立。baseline 保留给冒烟脚本，不动它。
 */

import type { GradeLevel } from '@shared/ipc-events'
import { PRIMARY_LOW_STYLE, PRIMARY_LOW_SYSTEM_PROMPT } from './primary-low.ts'
import { PRIMARY_HIGH_STYLE, PRIMARY_HIGH_SYSTEM_PROMPT } from './primary-high.ts'
import { JUNIOR_STYLE, JUNIOR_SYSTEM_PROMPT } from './junior.ts'
import { SENIOR_STYLE, SENIOR_SYSTEM_PROMPT } from './senior.ts'

/**
 * 冷启动默认学段（执行文档 §10.1：学生从未选择时生效）。
 *
 * ★ 2026-09-22 由 `primary_high` 改成 **`junior`**（D-073，用户裁决：「本地规则先默认初中，
 *   然后后续再进行 AI 引擎判断」）。理由见 `server/app/routes/students.py` 的
 *   `DEFAULT_COLD_START_GRADE` 注释（一句话：从小高起步讲高中内容学生会直接看不懂，
 *   而从初中起步往下调一档只是讲得更细）。
 * ⚠️ 必须与服务端那个常量**逐字一致**（`desktop/tests/grade-prompts.test.ts` 钉着），
 *   否则「服务端说初中、桌面 template 用小学高年级」会在第一轮就对不上。
 */
export const DEFAULT_GRADE_LEVEL: GradeLevel = 'junior'

/** 四个学段（冻结字面量，顺序与执行文档 §10.5 的矩阵一致）。 */
export const GRADE_LEVELS: readonly GradeLevel[] = ['primary_low', 'primary_high', 'junior', 'senior']

/** 学段中文名（给学生看的 UI 文案与日志用；不改学段字面量）。 */
export const GRADE_LABELS: Record<GradeLevel, string> = {
  primary_low: '小学低年级',
  primary_high: '小学高年级',
  junior: '初中',
  senior: '高中'
}

/** 语言风格名（§10.5 矩阵；「四学段语气可明显区分」这条验收的机器可读依据）。 */
export const GRADE_STYLES: Record<GradeLevel, string> = {
  primary_low: PRIMARY_LOW_STYLE,
  primary_high: PRIMARY_HIGH_STYLE,
  junior: JUNIOR_STYLE,
  senior: SENIOR_STYLE
}

/** 学段 → 模板。四份都必须非空（由 `tests/grade-prompts.test.ts` 断言）。 */
export const GRADE_PROMPTS: Record<GradeLevel, string> = {
  primary_low: PRIMARY_LOW_SYSTEM_PROMPT,
  primary_high: PRIMARY_HIGH_SYSTEM_PROMPT,
  junior: JUNIOR_SYSTEM_PROMPT,
  senior: SENIOR_SYSTEM_PROMPT
}

/**
 * 取学段模板。
 * ★ 拿不到合法学段时**回落到默认值**（而不是回落到 Pi 的默认 prompt）：
 *   宁可多讲半个学段，也绝不能把宿主环境信息发出去。
 */
export function gradePromptFor(grade: GradeLevel | string | undefined): string {
  if (typeof grade === 'string' && (GRADE_LEVELS as readonly string[]).includes(grade)) {
    return GRADE_PROMPTS[grade as GradeLevel]
  }
  return GRADE_PROMPTS[DEFAULT_GRADE_LEVEL]
}

/** 归一化学段：非法值一律落到默认学段（脏值不往下传，绝不把非法值当成某个学段）。 */
export function normalizeGradeLevel(grade: GradeLevel | string | undefined): GradeLevel {
  return typeof grade === 'string' && (GRADE_LEVELS as readonly string[]).includes(grade)
    ? (grade as GradeLevel)
    : DEFAULT_GRADE_LEVEL
}
