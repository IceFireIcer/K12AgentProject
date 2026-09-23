/**
 * 学习报告的 **Markdown 拼装 + 报告文案**（纯函数，可单测）。
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
 *
 * ---------------------------------------------------------------------------
 * 为什么这里还有两个**文案映射**（`STAGE_LABELS` / `SIGNAL_TYPE_LABELS`）
 * ---------------------------------------------------------------------------
 * 因为它们是「屏幕上」与「导出物里」**共用的同一份字**：概览页（`ReportTab.vue`）
 * 与这里各写一份的话，改一处忘另一处就会出现「页面写『已测验』、导出写『已闯关』」。
 * 契约本身只给英文枚举（`locked|learning|quizzed|mastered`、
 * `vocab|depth|quiz_perf|meta_cognition`），中文说法必须有唯一出处。
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

/**
 * 闯关四个阶段的中文名（键 = `progress.stage` 的取值，也是报告里 `stageCounts` 的键）。
 *
 * ★ 唯一出处：概览页的「逐关进度」与这里的「四、闯关进度」都读它。
 */
export const STAGE_LABELS: Record<string, string> = {
  locked: '未解锁',
  learning: '学习中',
  quizzed: '已测验',
  mastered: '已掌握'
}

/** 四类学段判定信号的中文名（键 = 契约 `GradeSignalType` 的四个字面量）。 */
export const SIGNAL_TYPE_LABELS: Record<string, string> = {
  vocab: '术语使用',
  depth: '提问深度',
  quiz_perf: '答题表现',
  meta_cognition: '元认知表达'
}

/**
 * 「概览」页比 `LearningReport` **多出来的那几块数据**（可选参数，不传就是老行为）。
 *
 * 结构与 `stores/insight.ts` 的派生值**逐字段对得上**，但不 import 那边：
 * 这是纯函数，参数一律是**结构类型** —— 免得一个格式化函数被绑死在某个 store 上。
 * ⚠️ 三个字段**都不参与判定**：掌握度平均与分档是服务端算好的展示口径、
 * 信号与推荐是服务端给的结论，这里只把它们排成可读文本。
 */
export interface ReportOverview {
  /** 掌握度概览（`insight.masterySummary`；`total` 为 0 时整行不出现）。 */
  masterySummary?: {
    average: number
    mastered: number
    needWork: number
    total: number
  } | null
  /** 学段判定信号（`insight.gradeSignals`）。 */
  gradeSignals?: {
    confidence: number
    signals?: readonly { signalType: string; value: number; raw?: string | null }[] | null
  } | null
  /**
   * 推荐下一步（`insight.recommended` 那一条）。
   *
   * ★ 形状是**平铺**的（不是 `{ item }`）：调用方手里拿到的就是那一条，
   *   包一层只会让每个调用点都写一次 `{ item: recommended }`。
   */
  recommended?: {
    kpId: string
    name: string
    reason: string
  } | null
}

/**
 * 拿不到昵称时学生被称作什么（页面 hero 与导出件**共用**这一份字）。
 *
 * ★★ 绝不回落成主键（报告 1.7 / C10）：这一行以前是 `report.nickname || report.studentId`，
 *   导出件里还有一处**无条件**写 `mistakes.studentId` —— 于是学生 / 家长在报告最显眼
 *   的位置读到的是 `student_001`。昵称缺失是服务端冷启动的正常状态（会先落一行空昵称），
 *   显示口径就该是「同学」这种人话，而不是数据库主键。
 * ⚠️ 主键仍然照常留在 wire 层与教师视角里：这里只改**显示**。
 */
export const STUDENT_FALLBACK_NAME = '同学'

/** 0..1 之外的数不进导出物（脏数据不该在报告里变成 137%）——**只夹紧，不判断对错**。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** 0..1 → 百分比整数（导出物里不写 62.0000001%）。 */
function percentOf(value: number): number {
  return Math.round(clamp01(value) * 100)
}

/**
 * 那些**只能由一次真实作答**产生的关卡阶段（见 {@link hasLearningActivity} 的判据 ②）。
 * `locked` / `learning` 都可能在学生一个题都没做时存在（冷启动把第一关播成 `learning`）。
 */
const ATTEMPTED_STAGES = ['quizzed', 'mastered'] as const

/**
 * ★ 有没有**任何学习活动** —— 页面空态与摘要行共用的判据（**唯一实现**）。
 *
 * 两个消费点必须问同一个问题，否则会拼出「页面说『还没有学习记录』、摘要行却在报
 * 三个 0」这种自相矛盾的屏：
 *   · `ReportTab.vue` 的空态（报告 1.6：没有任何学习活动时只给一句话 + 一个主行动）；
 *   · 本文件的 {@link summaryLine}（报告 C9）。
 *
 * ★★ 判据只认**真的做过事**留下的痕迹，两条不能当活动的陷阱写在这里（都实测过）：
 *
 *   ① `chapters` **不算**：`_chapter_progress()` 是把**教材章节目录**（`kb.sqlite`）
 *      铺成一行行进度 —— 一个从没学过的新学生也会有全部章节、每章 `已掌握 0 / N`。
 *      拿它当判据，空态就永远不会出现（报告 1.6 点名的正是这排 0/N 条）。
 *   ② `stageCounts` 里只有 `quizzed` / `mastered` 算：冷启动播种关卡路径时
 *      **第一关就是 `learning`**（`routes/quiz.py` 的 `seed_progress(..., stage="learning")`），
 *      那是系统铺的路，不是学生做过的事。而 `quizzed` / `mastered` 只可能由一次
 *      真实作答（判分时 `upsert_progress`）产生。
 *
 * 其余各项都是真实痕迹：窗口内的活动量 / 题量 / 每日明细 / 连续天数，
 * 以及跨整段历史的掌握度行、徽章（两者都由判分写入 `learning.db`）。
 * ⚠️ `gradeHistory` **刻意不算**：冷启动会写一行基线学段，那不是学习活动。
 */
export function hasLearningActivity(report: ReportView): boolean {
  return (
    report.totalActivities > 0 ||
    report.quizTotal > 0 ||
    report.daily.length > 0 ||
    report.streakDays > 0 ||
    report.mastery.length > 0 ||
    report.badges.length > 0 ||
    ATTEMPTED_STAGES.some((stage) => (report.stageCounts[stage] ?? 0) > 0)
  )
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

/**
 * 一行「学习概况」的统计（报告第二节直接用）。
 *
 * ★★ 没有任何活动时**只给一句话**（报告 C9）：原来的三段式在空数据下拼成
 *    「近 7 天共 0 次学习活动，做了 0 道题，还没有作答记录。」——
 *    读起来像系统在报障，而事实只是「还没开始」。
 *    这一函数**同时供页面与导出 Markdown 用**，所以两边一起改口径。
 * ★ 有数据时保留原来的三段（活动量 → 题量 → 正确率），一个字不改：
 *   它的每一段都是真数字，且「还没有作答记录」这一句有单测钉着（quizTotal 为 0 但
 *   确实有活动时仍然要出现 —— 那不是「没数据」，是「做了别的活动但没做题」）。
 */
export function summaryLine(report: ReportView, days: number): string {
  if (!hasLearningActivity(report)) return '这段时间还没有学习记录。'
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
 * `overview` 是**可选**的第三参：传了就把概览页独有的那两块数据
 * （掌握度平均与分档、学段判定信号）与推荐一起写进文件；
 * **不传时输出与从前逐字节相同**（既有单测就是按两参调用的，不许改它们的期望）。
 * 三块新增内容都是**追加**，不动任何既有分节的标题与顺序 —— 报告的六个分区是
 * 被单测钉住的对外结构。
 *
 * 「下一步学什么」**不由本函数算**：推荐有唯一出口（`/api/profile/{id}/recommendation`），
 * 这里只在 `overview.recommendation` 传进来时把它写出来（算推荐是 Python 的事）。
 */
export function composeReportMarkdown(
  report: ReportView,
  days: number,
  overview?: ReportOverview,
  /**
   * 知识点显示名（`kpId → 中文名`）。
   *
   * ★ 为什么必须由调用方传进来：报告里的 `mastery` 行**只带 kpId**
   *   （契约 `Mastery` 结构上没有名字），名字的唯一来源是 kb 的知识点清单。
   *   本函数是纯函数，不该去够 store —— 所以由 `stores/study.ts` 在导出时把
   *   已经取到的名字映射传进来（它本来就会 `ensureNames()`）。
   * ★ 不传 = 保持既有行为（只有 id）。⚠️ 但**能拿到名字时必须用名字**：
   *   导出的报告是给家长看的，`prog-loop-jr` 对他们和乱码没有区别
   *   （这正是走查里那条「立刻隐藏所有 ID」的落点之一）。
   */
  names?: { get(kpId: string): string | undefined }
): string {
  /** kpId → 表格里显示的名字（拿不到名字就退回「id（知识点编号）」，与原口径一致）。 */
  const labelOf = (kpId: string): string => {
    const name = names?.get(kpId)
    return name && name.trim().length > 0 && name !== kpId ? name : `${kpId}（知识点编号）`
  }
  const lines: string[] = []
  lines.push(`# 学习报告（近 ${days} 天）`)
  lines.push('')
  // ★ 昵称缺失时写「同学」（`STUDENT_FALLBACK_NAME`）——**绝不写主键**（报告 1.7）
  lines.push(`- 学生：${report.nickname || STUDENT_FALLBACK_NAME}`)
  lines.push(`- 当前学段：${gradeLabel(report.gradeLevel)}`)
  lines.push(`- 生成时间：${formatMs(report.generatedAt)}`)
  lines.push('')

  lines.push('## 一、学习概况')
  lines.push('')
  lines.push(summaryLine(report, days))
  // 掌握度概览（概览页 hero 上的那几个数）——口径写在括号里，
  // 免得家长把 0.6 这条界面分档线当成判分规则（判分规则在后端，另有阈值）。
  const masterySummary = overview?.masterySummary
  if (masterySummary && masterySummary.total > 0) {
    lines.push('')
    lines.push(
      `- 平均掌握度：**${percentOf(masterySummary.average)}%**` +
        `（共 ${masterySummary.total} 个知识点：已掌握（≥0.6）${masterySummary.mastered} 个 · ` +
        `待加强（<0.6）${masterySummary.needWork} 个）`
    )
  }
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
    // 表头写「知识点」而不是「知识点编号」：有名字时这一列就是名字
    // （拿不到名字时才退回「id（知识点编号）」，见 labelOf）。
    lines.push('| 知识点 | 掌握度 | 状态 | 作答次数 | 答对 |')
    lines.push('| --- | ---: | --- | ---: | ---: |')
    for (const item of report.mastery) {
      lines.push(
        `| ${labelOf(item.kpId)} | ${item.score.toFixed(2)} | ${masteryLabel(item.score)} | ` +
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
      // 进度数字与页面同一格式：`已掌握 N / M`（报告 2.3 —— 一种进度语言）
      lines.push(
        `- ${chapter.chapterTitle}：已掌握 ${chapter.masteredCount} / ${chapter.kpCount}` +
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
    for (const key of stageKeys) {
      lines.push(`- ${STAGE_LABELS[key] ?? key}：${report.stageCounts[key]} 个知识点`)
    }
  }
  if (report.badges.length > 0) {
    lines.push('')
    lines.push(`已获得徽章：${report.badges.join('、')}`)
  }
  lines.push('')

  lines.push('## 五、学段变化轨迹')
  lines.push('')
  // 判定信号（概览页「学段依据」里的那四格）插在轨迹**之前**：
  // 「按什么判的」是因、「变成了什么」是果，读起来是一条线。
  const gradeSignals = overview?.gradeSignals
  const signals = gradeSignals?.signals ?? []
  if (gradeSignals && signals.length > 0) {
    lines.push(`判定信号（当前置信度 ${percentOf(gradeSignals.confidence)}%）：`)
    lines.push('')
    for (const signal of signals) {
      const signalLabel = SIGNAL_TYPE_LABELS[signal.signalType] ?? signal.signalType
      const raw = signal.raw && signal.raw.trim().length > 0 ? `（${signal.raw.trim()}）` : ''
      lines.push(`- ${signalLabel}：${percentOf(signal.value)}%${raw}`)
    }
    lines.push('')
  }
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
  // 推荐是**服务端给的**：传进来就写出来，不传就只留那句指引（绝不本地猜一个）。
  const recommended = overview?.recommended
  if (recommended) {
    const name =
      recommended.name && recommended.name !== recommended.kpId
        ? recommended.name
        : `${recommended.kpId}（知识点编号）`
    lines.push(`- 建议接着练：**${name}**。${recommended.reason}`)
    lines.push('')
  }
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
  // ★ 错题数据里**没有昵称字段**（契约 `MistakeListResponse` 只有 student_id），
  //   所以这里写死中性称呼 —— 以前是**无条件**写 `- 学生：${mistakes.studentId}`，
  //   等于把主键印在导出件第一行（报告 1.7 / C10 点名）。
  lines.push(`- 学生：${STUDENT_FALLBACK_NAME}`)
  lines.push(`- 当前学段：${gradeLabel(mistakes.gradeLevel)}`)
  lines.push(`- 共 ${mistakes.items.length} 个知识点有错题，累计答错 ${mistakes.totalWrong} 次`)
  lines.push('')

  if (mistakes.items.length === 0) {
    // ★ 导出的也是**给学生/家长读的**（见文件头第 3 条纪律），所以这里不能出现
    //   「还没有错题记录 —— 保持住。」那种系统口径的冷句子：全对是一件**值得高兴**的事，
    //   报告里也该这么说。（`desktop/tests/study-views.test.ts` 钉住「还没有错题记录」
    //   这几个字还在，所以只在它后面接着把话说暖。）
    lines.push('太棒啦！还没有错题记录，继续保持这份认真～')
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

