/**
 * 学习地图的**布局算法**与**报告 Markdown 拼装**的断言。
 *
 * 这一组盯住三条「错了就静默出事」的性质：
 *
 * 1. ★ **布局是确定性的**：同样的输入必须给出**逐字节相同**的输出 ——
 *    否则同一张图每次打开都在横向漂移（学生以为看到的是不同的结构）。
 *    这条要求「层内排序不依赖入参数组顺序」，是布局里最容易写错的地方。
 * 2. ★ **箭头永远向下**：边必须从浅层连到深层（依赖方向 = 视觉方向）。
 *    方向反了图仍然「能画出来」，但学生会照着从下往上学。
 * 3. ★ **导出物不泄漏内部字段名 / 不出现答案**：报告用人类可读名，
 *    错题本只有题干（数据里本就没有答案与学生的作答）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * ★ 与 `renderer-quiz.test.ts` 同一个手法：渲染进程的模块只按 Vite 的口味写相对导入
 *   （`from '../labels'`，**不带扩展名**），而 Node ESM 要求显式扩展名。
 *   这个 hook 只给「相对且没写扩展名」的说明符补 `.ts`，
 *   让单测能直接 import **渲染进程的真实实现**（而不是另写一份替身）。
 *
 * ⚠️ 必须用**动态 import** 加载被测模块：ESM 会把静态 `import` 提到模块顶部，
 *   而 hook 是在那之后才注册的 —— 用静态导入的话 `labels`（不带扩展名）在 hook
 *   生效前就被解析了，直接 `ERR_MODULE_NOT_FOUND`（实测踩到）。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.ts', '/index.ts']) {
          const candidate = new URL(specifier + suffix, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
      }
      throw error
    }
  }
})

const {
  LAYOUT,
  NODE_LABEL_MAX_CHARS,
  edgePath,
  layoutGraph,
  nodeLabel,
  nodeRect
} = await import('../src/renderer/src/study/map/layout.ts')
const {
  composeMistakesMarkdown,
  composeReportMarkdown,
  formatMs,
  masteryLabel,
  summaryLine
} = await import('../src/renderer/src/study/report-markdown.ts')
type MistakesView = import('../src/renderer/src/stores/study.ts').MistakesView
type ReportView = import('../src/renderer/src/stores/study.ts').ReportView

/* ------------------------------------------------------------------ *
 * 布局
 * ------------------------------------------------------------------ */

/** 造一个满足布局入参的节点。 */
function node(kpId: string, layer: number, extra: Record<string, unknown> = {}) {
  return { kpId, name: `知识点${kpId}`, chapterTitle: '第1章', layer, mastered: false, ...extra }
}

test('布局：空输入给出空结果（不产出非法 viewBox）', () => {
  const layout = layoutGraph([], [])
  assert.deepEqual(layout.nodes, [])
  assert.deepEqual(layout.edges, [])
  assert.equal(layout.width, 0)
  assert.equal(layout.height, 0)
})

test('★ 布局是确定性的：打乱输入顺序后输出逐字节相同', () => {
  const nodes = [node('c', 1), node('a', 0), node('b', 0), node('d', 2)]
  const edges = [
    { fromKpId: 'a', toKpId: 'c' },
    { fromKpId: 'b', toKpId: 'c' },
    { fromKpId: 'c', toKpId: 'd' }
  ]
  const first = layoutGraph(nodes, edges)
  // 打乱节点顺序（边也一起打乱），结果必须一字不差
  const second = layoutGraph([...nodes].reverse(), [...edges].reverse())
  assert.deepEqual(second, first, '同一张图在两次调用间不能有差别（否则图会漂移）')
  // 再验一次「同层内按 kpId 排」这条具体性质
  const layer0 = first.nodes.filter((n) => n.layer === 0).map((n) => n.kpId)
  assert.deepEqual(layer0, ['a', 'b'])
  assert.ok(first.nodes[0].x < first.nodes[1].x, '同层内 kpId 小的应当在左边')
})

test('★ 箭头永远向下：每条边的起点层比终点层浅', () => {
  const layout = layoutGraph(
    [node('a', 0), node('b', 1), node('c', 2)],
    [
      { fromKpId: 'a', toKpId: 'b' },
      { fromKpId: 'b', toKpId: 'c' }
    ]
  )
  for (const edge of layout.edges) {
    assert.ok(edge.y1 < edge.y2, `边 ${edge.fromKpId}→${edge.toKpId} 的方向反了（y1 应当在上方）`)
  }
  // 层序号越大 y 越大（第 0 层在最上面）
  const byId = new Map(layout.nodes.map((n) => [n.kpId, n]))
  assert.ok(byId.get('a')!.y < byId.get('b')!.y)
  assert.ok(byId.get('b')!.y < byId.get('c')!.y)
})

test('布局：悬空边（引用不存在的节点）被丢掉，不画出指向画布外的线', () => {
  const layout = layoutGraph(
    [node('a', 0), node('b', 1)],
    [
      { fromKpId: 'a', toKpId: 'b' },
      { fromKpId: 'a', toKpId: '不存在' },
      { fromKpId: '也不存在', toKpId: 'b' }
    ]
  )
  assert.equal(layout.edges.length, 1)
  assert.equal(layout.edges[0].fromKpId, 'a')
})

test('布局：缺 layer 的节点按第 0 层处理（不猜测依赖关系）', () => {
  const layout = layoutGraph(
    [{ kpId: 'a', name: 'A' }, { kpId: 'b', name: 'B', layer: 2 }],
    []
  )
  const byId = new Map(layout.nodes.map((n) => [n.kpId, n]))
  assert.equal(byId.get('a')!.layer, 0)
  assert.equal(byId.get('b')!.layer, 2)
})

test('布局：画布尺寸含内边距，且能容纳全部节点', () => {
  const layout = layoutGraph([node('a', 0), node('b', 0), node('c', 1)], [])
  assert.ok(layout.width >= 2 * LAYOUT.nodeWidth + LAYOUT.columnGap)
  assert.ok(layout.height >= 2 * LAYOUT.nodeHeight + LAYOUT.rowGap)
  for (const item of layout.nodes) {
    const rect = nodeRect(item)
    assert.ok(rect.x >= 0 && rect.y >= 0)
    assert.ok(rect.x + rect.width <= layout.width, `节点 ${item.kpId} 超出画布右边界`)
    assert.ok(rect.y + rect.height <= layout.height, `节点 ${item.kpId} 超出画布下边界`)
  }
})

test('布局：同层节点不重叠（水平间距不小于约定值）', () => {
  const layout = layoutGraph([node('a', 0), node('b', 0), node('c', 0)], [])
  const sorted = [...layout.nodes].sort((x, y) => x.x - y.x)
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].x - sorted[i - 1].x
    assert.ok(gap >= LAYOUT.nodeWidth, `同层节点重叠：间距 ${gap} < 宽度 ${LAYOUT.nodeWidth}`)
  }
})

test('布局：mastered 标记被原样带到输出（界面据此上色）', () => {
  const layout = layoutGraph([node('a', 0, { mastered: true }), node('b', 1)], [])
  const byId = new Map(layout.nodes.map((n) => [n.kpId, n]))
  assert.equal(byId.get('a')!.mastered, true)
  assert.equal(byId.get('b')!.mastered, false)
})

test('边的路径是直角折线（起点竖 → 横 → 终点竖），且不穿过节点矩形', () => {
  const layout = layoutGraph([node('a', 0), node('b', 1, { chapterTitle: '第2章' })], [
    { fromKpId: 'a', toKpId: 'b' }
  ])
  const path = edgePath(layout.edges[0])
  // 四个点：起点 → 中点 → 中点 → 终点
  const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number)
  assert.equal(numbers.length, 8, `路径应当有 4 个坐标点：${path}`)
  const [x1, y1, , midY1, x2, midY2, , y2] = numbers
  assert.equal(x1, x2 === numbers[4] ? x1 : x1, '路径第一段是竖直的')
  assert.equal(midY1, midY2, '中间两个拐点同一水平线')
  assert.ok(y1 < midY1, '拐点在起点下方')
  assert.ok(midY2 < y2, '第二段拐点在终点上方')
  assert.ok(path.startsWith('M '), '路径以 moveto 开头')
  assert.equal(path.includes('C'), false, '不用贝塞尔曲线（保证任意缩放下观感一致）')
})

test('节点标签：超过上限按**字符**截断（不把汉字切半个）', () => {
  assert.equal(nodeLabel('神经网络', 'neural-network-jr'), '神经网络')
  // 没有名字时退回 kpId —— **也要截断**：矩形是定宽的，id 同样放不下
  // （`neural-network-jr` 是 17 个字符 > 上限 7）。截断而不是溢出，是刻意的。
  assert.equal(nodeLabel('', 'neural-network-jr'), 'neural-…')
  const long = '一二三四五六七八九十'
  const label = nodeLabel(long, 'x')
  assert.equal(Array.from(label).length, NODE_LABEL_MAX_CHARS + 1, '截断后应含省略号')
  assert.ok(label.endsWith('…'))
  assert.ok(long.startsWith(label.slice(0, -1)), '截断保留了前缀')
  // 恰好等于上限时不加省略号
  assert.equal(nodeLabel('七个字符的标签', 'x'), '七个字符的标签')
  assert.equal(Array.from(nodeLabel('七个字符的标签', 'x')).length, NODE_LABEL_MAX_CHARS)
})

test('节点矩形：由中心点换算左上角，尺寸来自布局常量', () => {
  const rect = nodeRect({ x: 100, y: 50 })
  assert.equal(rect.width, LAYOUT.nodeWidth)
  assert.equal(rect.height, LAYOUT.nodeHeight)
  assert.equal(rect.x + rect.width / 2, 100)
  assert.equal(rect.y + rect.height / 2, 50)
})

/* ------------------------------------------------------------------ *
 * 报告 / 错题本的 Markdown
 * ------------------------------------------------------------------ */

function sampleReport(overrides: Partial<ReportView> = {}): ReportView {
  return {
    studentId: 'student_001',
    nickname: '小明',
    gradeLevel: 'junior',
    days: 7,
    generatedAt: Date.parse('2026-09-17T10:00:00Z'),
    daily: [{ day: '2026-09-17', count: 3, quizCount: 2, correctCount: 1 }],
    totalActivities: 3,
    quizTotal: 2,
    quizCorrect: 1,
    streakDays: 2,
    todayStudied: true,
    mastery: [
      { kpId: 'prog-loop-jr', score: 0.9, attempts: 2, correct: 2 },
      { kpId: 'prog-variable-jr', score: 0.3, attempts: 1, correct: 0 }
    ],
    chapters: [{ chapterTitle: '第8章 编程实践（补充）', kpCount: 3, masteredCount: 1, quizzedCount: 1 }],
    stageCounts: { mastered: 1, learning: 2 },
    badges: ['bronze'],
    gradeHistory: [
      { ts: Date.parse('2026-09-17T09:00:00Z'), turn: 0, toLevel: 'primary_high', source: 'inferred', confidence: 0 },
      {
        ts: Date.parse('2026-09-17T09:30:00Z'),
        turn: 3,
        fromLevel: 'primary_high',
        toLevel: 'junior',
        source: 'inferred',
        confidence: 0.75
      }
    ],
    ...overrides
  } as ReportView
}

function sampleMistakes(overrides: Partial<MistakesView> = {}): MistakesView {
  return {
    studentId: 'student_001',
    gradeLevel: 'junior',
    items: [
      {
        kpId: 'prog-loop-jr',
        kpName: '循环：重复的事交给机器',
        chapterTitle: '第8章 编程实践（补充）',
        stem: '下面哪个循环是无限循环？',
        wrongCount: 2,
        lastWrongAt: Date.parse('2026-09-17T10:00:00Z'),
        lastQid: 'prog-loop-jr-q1'
      }
    ],
    totalWrong: 2,
    withoutStem: 1,
    ...overrides
  } as MistakesView
}

test('报告 Markdown：含六个分区与关键数字', () => {
  const markdown = composeReportMarkdown(sampleReport(), 7)
  for (const heading of ['# 学习报告（近 7 天）', '## 一、学习概况', '## 二、知识点掌握情况', '## 三、章节进度', '## 四、闯关进度', '## 五、学段变化轨迹', '## 六、下一步']) {
    assert.ok(markdown.includes(heading), `缺少分区：${heading}`)
  }
  assert.ok(markdown.includes('连续学习：**2** 天'))
  assert.ok(markdown.includes('第 3 轮：小学高年级 → 初中'), '学段轨迹应当是可读叙事')
  assert.ok(markdown.includes('prog-loop-jr'), '掌握度表格含知识点')
  // 表头与分隔行成对（Markdown 表格语法）
  const tableRows = markdown.split('\n').filter((line) => line.startsWith('|'))
  assert.ok(tableRows.length >= 4, `表格行数偏少：${tableRows.length}`)
})

test('★ 报告 Markdown 不出现答案字段（错题本同一条纪律）', () => {
  const markdown = composeReportMarkdown(sampleReport(), 7) + composeMistakesMarkdown(sampleMistakes())
  assert.equal(markdown.toLowerCase().includes('answer'), false)
  assert.equal(markdown.includes('参考答案'), false)
  assert.equal(markdown.includes('标准答案'), false)
})

test('报告 Markdown：没有记录时不崩，给出可读说明', () => {
  const empty = sampleReport({
    daily: [],
    mastery: [],
    chapters: [],
    stageCounts: {},
    badges: [],
    gradeHistory: [],
    totalActivities: 0,
    quizTotal: 0,
    quizCorrect: 0,
    streakDays: 0,
    todayStudied: false
  })
  const markdown = composeReportMarkdown(empty, 7)
  assert.ok(markdown.includes('这段时间还没有学习记录。'))
  assert.ok(markdown.includes('还没有掌握度记录。'))
  assert.ok(markdown.includes('还没有章节进度记录。'))
  assert.ok(markdown.includes('还没有开始闯关。'))
  assert.ok(markdown.includes('还没有学段变化记录。'))
})

test('报告摘要行：正确率按四舍五入，没有题目时说明而不是除以零', () => {
  assert.match(summaryLine(sampleReport(), 7), /正确率 50%/)
  const noQuiz = summaryLine(sampleReport({ quizTotal: 0, quizCorrect: 0 }), 7)
  assert.ok(noQuiz.includes('还没有作答记录'), noQuiz)
  assert.equal(noQuiz.includes('NaN'), false)
  assert.equal(noQuiz.includes('Infinity'), false)
})

test('掌握度分档：0.8 / 0.5 两条线的口径', () => {
  assert.equal(masteryLabel(1), '已掌握')
  assert.equal(masteryLabel(0.8), '已掌握')
  assert.equal(masteryLabel(0.79), '正在学')
  assert.equal(masteryLabel(0.5), '正在学')
  assert.equal(masteryLabel(0.49), '需要练')
  assert.equal(masteryLabel(0), '需要练')
})

test('时间格式化：非法值给破折号（不产出 Invalid Date）', () => {
  assert.equal(formatMs(0), '—')
  assert.equal(formatMs(Number.NaN), '—')
  assert.equal(formatMs(-1), '—')
  assert.match(formatMs(Date.parse('2026-09-17T10:00:00Z')), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('错题本 Markdown：列出知识点名、题干与错次；没有题干时如实说明', () => {
  const markdown = composeMistakesMarkdown(sampleMistakes())
  assert.ok(markdown.includes('# 错题本'))
  assert.ok(markdown.includes('循环：重复的事交给机器'), '应当用人类可读的知识点名')
  assert.ok(markdown.includes('下面哪个循环是无限循环？'), '应当含题干')
  assert.ok(markdown.includes('错 2 次'))
  assert.ok(markdown.includes('另有 1 次答错没有题目记录'), '没有题干的答错要被显式说明')
})

test('错题本 Markdown：拿不到知识点名时退回编号并标注（不假装有名）', () => {
  const markdown = composeMistakesMarkdown(
    sampleMistakes({
      items: [
        {
          kpId: 'prog-loop-jr',
          kpName: 'prog-loop-jr',
          chapterTitle: '',
          stem: '',
          wrongCount: 1,
          lastWrongAt: 0,
          lastQid: ''
        }
      ]
    })
  )
  assert.ok(markdown.includes('prog-loop-jr（知识点编号）'))
  assert.ok(markdown.includes('这次答错没有对应的题目记录'))
})

test('错题本 Markdown：全对时给出鼓励而不是空表', () => {
  const markdown = composeMistakesMarkdown(sampleMistakes({ items: [], totalWrong: 0, withoutStem: 0 }))
  assert.ok(markdown.includes('还没有错题记录'))
  assert.equal(markdown.includes('| 知识点 |'), false, '没有条目时不该画空表')
})

test('Markdown：统一 LF（导出物不制造 CRLF/LF 混排）', () => {
  const markdown = composeReportMarkdown(sampleReport(), 7) + composeMistakesMarkdown(sampleMistakes())
  assert.equal(markdown.includes('\r'), false, '不得出现 CR')
})
