/**
 * 学习报告 / 错题本的 **Markdown 拼装**（纯函数，可单测）。
 *
 * ---------------------------------------------------------------------------
 * 为什么拼装放在渲染进程（而不是 Python）
 * ---------------------------------------------------------------------------
 * 两个理由，都是刻意的：
 * 1. **导出是界面动作**：学生点「导出」时数据已经在这台机器上了（`stores/study.ts` 的 ref）。
 *    把它再送回 Python 拼一遍，等于为了一个格式转换多开一趟 HTTP，还要再定义一对契约模型；
 * 2. **它不产生任何业务判定**：这是一份**展示文本**，不参与持久化、不影响推荐、不进 Prompt。
 *    把它放在渲染进程不会让「数据域只在 Python」这条边界松动一分
 *    （对比：掌握度、推荐、学段——它们必须在 Python，因为那是业务判定）。
 *
 * ---------------------------------------------------------------------------
 * 三条纪律
 * ---------------------------------------------------------------------------
 * 1. ★ **不泄漏内部字段名**：正文里用的是知识点的**人类可读名**（`kpName`）与章节名，
 *    只有拿不到名字时才退回 `kpId`（且明确写成「（知识点编号）」）。
 * 2. ★ **不出现答案**：错题本的数据源里本来就没有答案（`MistakeItem` 结构上没有），
 *    所以这里**不需要**做任何过滤 —— 但也不许「顺手」去补一列「参考答案」。
 * 3. ★ **导出物是给学生/家长看的**：中文、分节、可用 Markdown 阅读器打开；
 *    连续天数/掌握度这类数字要写清口径（「近 7 天」而不是一个光秃秃的「7」）。
 */

import type { MistakesView, ReportView } from '../stores/study'
import { GRADE_LABELS } from '../labels'
import type { GradeLevel } from '@shared/ipc-events'

/** 报告里的学段中文名（`labels.ts` 是唯一来源；这里只做「取不到就退回原值」的兜底）。 */
function gradeLabel(level: GradeLevel | undefined): string {
  if (!level) return '未知'
  return GRADE_LABELS[level] ?? level
}

/** 掌握度的中文分档（与画像块 `renderProfileText` 的口径一致：≥0.8 已掌握 / ≥0.5 正在学 / 更低要练）。 */
export function masteryLabel(score: number): string {
  if (score >= 0.8) return '已掌握'
  if (score >= 0.5) return '正在学'
  return '需要练'
}

/** 毫秒时间戳 → `YYYY-MM-DD HH:mm`（本地时间；导出物上没有时区换算的需求）。 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** 一行「学习概况」的统计（报告第二节直接用）。 */
export function summaryLine(report: ReportView, days: number): string {
  const accuracy = report.quizTotal > 0 ? Math.round((report.quizCorrect / report.quizTotal) * 100) : null
  const parts = [
    `近 ${days} 天共 ${report.totalActivities} 次学习活动`,
    `做了 ${report.quizTotal} 道题`,
    accuracy === null ? '还没有作答记录' : `答对 ${report.quizCorrect} 道（正确率 ${accuracy}%）`
  ]
  return parts.join('，') + '。'
}

/**
 * 拼装**学习报告**的 Markdown。
 *
 * 分节与页面上一致（概况 / 掌握度 / 章节进度 / 闯关 / 学段轨迹 / 下一步），
 * 这样「屏幕上看到的」与「导出的文件」不会各说各话。
 *
 * 「下一步学什么」**不由本函数算**：`report` 里没有推荐（推荐有唯一出口
 * `/api/profile/{id}/recommendation`）。所以这里只写一句指向对话的提示，
 * 绝不自己猜一个推荐 —— 猜出来的推荐与页面上的会不一致。
 */
export function composeReportMarkdown(report: ReportView, days: number): string {
  const lines: string[] = []
  lines.push(`# 学习报告（近 ${days} 天）`)
  lines.push('')
  lines.push(`- 学生：${report.nickname || report.studentId}`)
  lines.push(`- 当前学段：${gradeLabel(report.gradeLevel)}`)
  lines.push(`- 生成时间：${formatMs(report.generatedAt)}`)
  lines.push('')

  lines.push('## 一、学习概况')
  lines.push('')
  lines.push(summaryLine(report, days))
  if (report.daily.length > 0) {
    lines.push('')
    lines.push('| 日期 | 活动数 | 练习题数 | 答对 |')
    lines.push('| --- | ---: | ---: | ---: |')
    for (const day of report.daily) {
      lines.push(`| ${day.day} | ${day.count} | ${day.quizCount} | ${day.correctCount} |`)
    }
  } else {
    lines.push('')
    lines.push('这段时间还没有学习记录。')
  }
  lines.push('')
  lines.push(`- 连续学习：**${report.streakDays}** 天${report.todayStudied ? '（今天已学习）' : ''}`)
  lines.push('')

  lines.push('## 二、知识点掌握情况')
  lines.push('')
  if (report.mastery.length === 0) {
    lines.push('还没有掌握度记录。')
  } else {
    lines.push('| 知识点编号 | 掌握度 | 状态 | 作答次数 | 答对 |')
    lines.push('| --- | ---: | --- | ---: | ---: |')
    for (const item of report.mastery) {
      lines.push(
        `| ${item.kpId} | ${item.score.toFixed(2)} | ${masteryLabel(item.score)} | ` +
          `${item.attempts} | ${item.correct} |`
      )
    }
  }
  lines.push('')

  lines.push('## 三、章节进度')
  lines.push('')
  if (report.chapters.length === 0) {
    lines.push('还没有章节进度记录。')
  } else {
    for (const chapter of report.chapters) {
      lines.push(
        `- ${chapter.chapterTitle}：已掌握 ${chapter.masteredCount}/${chapter.kpCount}` +
          `（已测验 ${chapter.quizzedCount}）`
      )
    }
  }
  lines.push('')

  lines.push('## 四、闯关进度')
  lines.push('')
  const stageKeys = Object.keys(report.stageCounts)
  if (stageKeys.length === 0) {
    lines.push('还没有开始闯关。')
  } else {
    const stageNames: Record<string, string> = {
      locked: '未解锁',
      learning: '学习中',
      quizzed: '已测验',
      mastered: '已掌握'
    }
    for (const key of stageKeys) {
      lines.push(`- ${stageNames[key] ?? key}：${report.stageCounts[key]} 个知识点`)
    }
  }
  if (report.badges.length > 0) {
    lines.push('')
    lines.push(`已获得徽章：${report.badges.join('、')}`)
  }
  lines.push('')

  lines.push('## 五、学段变化轨迹')
  lines.push('')
  if (report.gradeHistory.length === 0) {
    lines.push('还没有学段变化记录。')
  } else {
    for (const entry of report.gradeHistory) {
      const from = entry.fromLevel ? gradeLabel(entry.fromLevel) : '（初始）'
      lines.push(
        `- 第 ${entry.turn} 轮：${from} → ${gradeLabel(entry.toLevel)}` +
          `（置信度 ${entry.confidence.toFixed(2)}，${formatMs(entry.ts)}）`
      )
    }
  }
  lines.push('')

  lines.push('## 六、下一步')
  lines.push('')
  lines.push('回到对话里问一句「我接下来该学什么」，助手会按依赖图与掌握度给出建议。')
  lines.push('')

  return lines.join('\n')
}

/**
 * 拼装**错题本**的 Markdown。
 *
 * ★ 只输出「错在哪个知识点 + 题干摘要 + 错了几次」：
 *   页面上有的就是这些（`MistakeItem` 结构上没有「你的作答」与「参考答案」），
 *   导出物也不该多出任何一列 —— 数据里根本没有的东西不能在报告里被编出来。
 */
export function composeMistakesMarkdown(mistakes: MistakesView): string {
  const lines: string[] = []
  lines.push('# 错题本')
  lines.push('')
  lines.push(`- 学生：${mistakes.studentId}`)
  lines.push(`- 当前学段：${gradeLabel(mistakes.gradeLevel)}`)
  lines.push(`- 共 ${mistakes.items.length} 个知识点有错题，累计答错 ${mistakes.totalWrong} 次`)
  lines.push('')

  if (mistakes.items.length === 0) {
    lines.push('还没有错题记录 —— 保持住。')
    lines.push('')
    return lines.join('\n')
  }

  lines.push('| 知识点 | 章节 | 错次 | 最近一次 |')
  lines.push('| --- | --- | ---: | --- |')
  for (const item of mistakes.items) {
    const name = item.kpName && item.kpName !== item.kpId ? item.kpName : `${item.kpId}（知识点编号）`
    lines.push(
      `| ${name} | ${item.chapterTitle || '—'} | ${item.wrongCount} | ${formatMs(item.lastWrongAt)} |`
    )
  }
  lines.push('')

  lines.push('## 题目摘要')
  lines.push('')
  for (const item of mistakes.items) {
    const name = item.kpName && item.kpName !== item.kpId ? item.kpName : item.kpId
    lines.push(`### ${name}`)
    lines.push('')
    if (item.stem) {
      lines.push(`> ${item.stem}`)
    } else {
      // QA / 编程轨答错时没有题干记录（`question` 列是空串）：如实说明，
      // 而不是留一个空块让学生以为是导出坏了。
      lines.push('（这次答错没有对应的题目记录，回到对话里再练一遍即可。）')
    }
    lines.push('')
    lines.push(`错 ${item.wrongCount} 次，最近一次：${formatMs(item.lastWrongAt)}`)
    lines.push('')
  }

  // ★ 这些答错没有题干（QA / 编程轨）：显式列出来，别让学生以为记录少了
  if (mistakes.withoutStem > 0) {
    lines.push(
      `> 另有 ${mistakes.withoutStem} 次答错没有题目记录（发生在问答或编程练习里），` +
        '它们已经计入上面的错次统计。'
    )
    lines.push('')
  }

  return lines.join('\n')
}
