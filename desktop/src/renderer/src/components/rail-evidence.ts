/**
 * 右栏的**教师 / 答辩证据文本**（学生视角下不渲染）。
 *
 * ── 为什么把这些串单独放一个文件 ──────────────────────────────────────────
 * 它们是「设计合理性」那 25% 的原始证据：四级降级链的档位名、以及学段隔离
 * 那句硬边界原文（「隔离在 SQL 层强制，模型改不了 WHERE」）。W1 之前它们
 * 直接印在学生面前；现在只有 `<TeacherGate>` 里渲染 —— 一个字都没删。
 *
 * ★★ 单独成文件是**为了让守卫能守住**，不是为了「好看」：
 *   扫描器（`tests/student-view-discipline.test.ts`）对绝大多数文件是**零豁免**的；
 *   豁免只给「整份文件都只喂给教师视角」的模块。
 *   如果这些串留在 `ContextRail.vue` 里，那条守卫就必须给整个右栏开豁免 ——
 *   而开了豁免之后，谁往学生那一半塞一句 SQL，扫描器也看不出来了
 *   （实测：把技术原句塞进 `isolationNotice.studentText`，豁免版守卫**照样绿**）。
 *   所以「技术原文」与「学生话」必须能被文件级区分开。
 *
 * ⚠️ 引用本文件的组件**必须**把内容放进 `<TeacherGate>`，不许直接摊在学生面前。
 *    这一条由 `student-view-discipline.test.ts` 的「右栏的豁免必须真的有 TeacherGate 兜着」钉着。
 */

import type { Degraded } from '@shared/ipc-events'

/**
 * 四级降级链的档位名（**技术口径**，答辩要看的就是这四个词）。
 *
 * ★ 档位名刻意压到最短（「向量检索 · 本地模型」而不是「向量检索 · fastembed 本地」）：
 *   右栏只有 300px，这一行还要并排放状态标签 —— 名字一长就折成两行，
 *   四档高度参差不齐（实测截图里就是第一档比其它三档高一倍）。
 */
export const DEGRADE_LEVELS: ReadonlyArray<{ key: Degraded; label: string }> = [
  { key: 'vector', label: '向量检索 · 本地模型' },
  { key: 'cloud', label: '云端 Embedding' },
  { key: 'fts', label: 'FTS5 关键词兜底' },
  { key: 'outline', label: '依赖图 + 大纲' }
]

/** 降级链的档位名（按 key 取；取不到回 key 本身）。 */
export function degradeLevelLabel(key: Degraded): string {
  return DEGRADE_LEVELS.find((level) => level.key === key)?.label ?? key
}

/**
 * 学段隔离那句**硬边界原文**（教师 / 答辩视角）。
 *
 * 「隔离在 SQL 层强制，模型改不了 WHERE」是「关键约束必须在代码层强制」
 * 这条架构边界的直接证据 —— 它必须能在答辩时被指出来，所以原句保留。
 * ★ 学生读到的是另一句（`ContextRail.vue` 里按同一份 label 拼的「不会超纲」），
 *   两句由同一个 `label` 派生，不会出现「一处说初中、一处说高中」。
 */
export function isolationTeacherText(gradeLabel: string): string {
  return `本次仅使用「${gradeLabel}」及以下教材块（隔离在 SQL 层强制，模型改不了 WHERE）`
}

/**
 * 工具轨迹那一行说明（教师 / 答辩视角）：这条讲的是**代码层的四条强制**，
 * 学生视角该看到的是「团团这轮做了什么」（`TOOL_LABELS` 拼出来的那句）。
 */
export const TRACE_TEACHER_NOTE = '路由由模型自选；学段隔离、参数校验、内容终审均在代码层强制。'
