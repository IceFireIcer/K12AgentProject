/**
 * 对话内练习卡「单题渲染 + 进度卡外置」守卫：优化报告 §2.3 的执行计划 7.2 / 7.3。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 报告 §2.3 的三条现状问题里，有两条落在对话内的练习卡上：
 *   ① 「内联练习卡不一致」：对话内**全铺开**、闯关页**单卡**；
 *   ② 「进度卡挂载位置」：114 关进度挂在练习卡底部，把卡片拉得极长。
 *
 * 处置（与闯关页同构，见 `tests/quiz-layout-mode.test.ts`）：
 *   · 对话内练习卡**默认单题**：卡头「第 N / M 题」+ 步骤条、卡身当前题、
 *     卡脚「上一题 / 提交 / 下一题」；「下一题」只在**后端判为答对**之后可点；
 *   · 进度卡从练习卡模板里**整块移出**，改由 `ChatMessage.vue` 的消息层
 *     按载荷里的 `levels` 独立渲染（紧跟题卡之后）。
 *
 * 每条断言都对应一种「看起来只是排版不同、其实是状态分家」的缺陷：
 *   · 题体若走 `items`（全量）→ 一屏同时摆 M 份题面 / 选项 / 提交键（回到了旧版）；
 *   · 「下一题」若没绑 `currentSettled` → 学生可以跳过没做的题（推进节奏被击穿）；
 *   · 进度卡若留在 `QuizCard.vue` → 卡片又被拉长，且换一张卡就得再实现一遍外置逻辑。
 *
 * 跑法：`npm test`（源码级）；真机由 `scripts/verify-ui.mjs` 的 F 节量「题卡渲染题数」。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

/** 剥注释：文件里**刻意**引了旧写法（讲为什么改），不剥的话断言会被注释本身喂饱。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 取函数体（从一个锚点起，到花括号配平处）。 */
function blockOf(source: string, anchor: string): string {
  const start = source.indexOf(anchor)
  assert.ok(start >= 0, `找不到锚点：${anchor}`)
  const open = source.indexOf('{', start)
  assert.ok(open > start, `锚点后没有函数体：${anchor}`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`函数体没有闭合：${anchor}`)
}

const quizCard = stripComments(read('src', 'renderer', 'src', 'cards', 'QuizCard.vue'))
const chatMessage = stripComments(
  read('src', 'renderer', 'src', 'components', 'ChatMessage.vue')
)

/* ------------------------------------------------------------------ *
 * 1. ★★ 默认单题：题体只渲染一行
 * ------------------------------------------------------------------ */

test('★★ 对话内练习卡只渲染当前一道题（题体唯一渲染源是 visibleRows）', () => {
  const visibleRows = blockOf(quizCard, 'const visibleRows = computed<QuizItem[]>(')
  assert.match(
    visibleRows,
    /if \(showFinish\.value\) return \[\]/,
    '收尾时一行都不渲染（换成收尾说明）'
  )
  assert.match(
    visibleRows,
    /return currentItem\.value === null \? \[\] : \[currentItem\.value\]/,
    '★ 单题模式 = 只有当前那一行（与 views/Quiz.vue 的 visibleRows 同构）'
  )

  // 题体的唯一 v-for 源必须是 visibleRows —— 出现 `v-for="row in items"` 就是全铺开回来了
  const bodyLoops = quizCard.match(/v-for="row in visibleRows"/g) ?? []
  assert.equal(bodyLoops.length, 1, `题体的渲染源只允许是一处 visibleRows（实测 ${bodyLoops.length} 处）`)
  assert.doesNotMatch(
    quizCard,
    /v-for="row in items"/,
    '题体不得全量遍历 items（那等于一屏摆开 M 份题面 / 选项 / 提交键）'
  )
  // 唯一允许全量遍历的是**题号步骤条**（它要的就是「一共几题」）
  const stepLoops = quizCard.match(/v-for="\(item, index\) in items"/g) ?? []
  assert.equal(stepLoops.length, 1, `全量遍历只许出现在步骤条里（实测 ${stepLoops.length} 处）`)
})

test('★ 卡头有「第 N / M 题」与题号步骤条；卡脚有上一题 / 提交 / 下一题', () => {
  assert.match(quizCard, /data-testid="quiz-position"/, '卡头要有位置行（第 N / M 题）')
  assert.match(
    quizCard,
    /第 \{\{ currentIndex \+ 1 \}\} \/ \{\{ questions\.length \}\} 题/,
    '位置行的数字来自当前下标与题数（不另存一份状态）'
  )
  assert.match(quizCard, /data-testid="quiz-steps"/, '卡头要有题号步骤条')
  assert.match(quizCard, /:data-testid="`quiz-step-\$\{index \+ 1\}`"/, '每一颗步骤要能单独定位')
  assert.match(quizCard, /@click="goTo\(index\)"/, '步骤条可点（想回看哪一题就点哪一题）')

  // 三个卡脚动作：上一题 / 提交 / 下一题（提交键保留既有锚点 quiz-submit）
  for (const id of ['quiz-prev', 'quiz-submit', 'quiz-next']) {
    assert.match(quizCard, new RegExp(`data-testid="${id}"`), `卡脚缺 ${id}`)
  }
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 推进只认后端判分结论
 * ------------------------------------------------------------------ */

test('★★ 「下一题」只在**后端判为答对**之后可点；答错留在原地重试', () => {
  const settled = blockOf(quizCard, 'const currentSettled = computed(')
  assert.match(
    settled,
    /correct === true/,
    '★ 判据只读后端判分的 `correct === true`（前端不比对答案、不推断对错）'
  )

  const next = blockOf(quizCard, 'function nextQuestion(): void')
  assert.match(next, /if \(!currentSettled\.value\) return/, '没答对 → 「下一题」不做任何事')
  assert.match(next, /finished\.value = true/, '最后一题答对后点「下一题」→ 收尾说明')
  assert.match(
    quizCard,
    /:disabled="!currentSettled"/,
    '按钮上真的绑了可用条件（只定义不绑 = 学生还是能跳过没做的题）'
  )
  assert.match(
    blockOf(quizCard, 'function goTo(index: number): void'),
    /cursorQid\.value = target\.question\.qid/,
    '跳题记的是 **qid** 而不是下标（生成题晚到不会把学生面前的题换掉）'
  )
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 进度卡外置
 * ------------------------------------------------------------------ */

test('★★ 进度卡**不再出现在对话里**：题卡只管题目，进度看个性化学习 / 学习记录', () => {
  // ★ 两段历史，别混起来读：
  //   ① 2026-09-20（报告 §2.3）：进度卡从**练习卡里**拆出来，改由消息层独立渲染 —— 那一步是对的，
  //      「题卡不被进度拉长」这条至今成立；
  //   ② 2026-09-30 用户裁决（D-123）：**整个搬出对话** —— 对话里那张是**当时的进度快照**（会过期、占满屏），
  //      学生真正看进度的地方是「个性化学习」与「学习记录」两页。
  //   所以下面的断言从「消息层必须独立渲染」翻成「消息层不得再渲染」。
  assert.doesNotMatch(
    quizCard,
    /ProgressCard/,
    '练习卡不得引用 ProgressCard（进度/掌握度独立成卡，不塞进题卡）'
  )
  assert.doesNotMatch(
    quizCard,
    /Array\.isArray\([^)]*levels/,
    '练习卡也不判断 levels（进度不是题卡的事）'
  )

  assert.doesNotMatch(
    chatMessage,
    /import ProgressCard from/,
    '★ 消息层不得再引入进度卡（D-123：进度卡搬出对话，看个性化学习 / 学习记录）'
  )
  assert.doesNotMatch(
    chatMessage,
    /<ProgressCard/,
    '★ 对话里不得渲染进度卡 —— 要加回来先读 D-123 的理由，别当成「塞回题卡」那件事重做'
  )
  assert.doesNotMatch(
    chatMessage,
    /function hasLevels\(/,
    'hasLevels 判据随进度卡一起撤掉（留着它就是一条没人用的死判据）'
  )
  // 卡片组本身仍在：载荷自己的那张卡（题卡 / 动画卡 / 编程卡）照旧渲染
  assert.match(
    chatMessage,
    /data-testid="inline-cards"[\s\S]{0,260}<InlineCard/,
    '内联卡片组仍要渲染载荷自己的那张卡'
  )
})

/* ------------------------------------------------------------------ *
 * 4. ★ 探针锚点：渲染题数是结构性属性
 * ------------------------------------------------------------------ */

test('★ 题卡带 data-probe-* 结构性锚点（探针量「渲染题数」不用猜 DOM 形状）', () => {
  assert.match(quizCard, /data-probe-id="quiz-card"/, '题卡要有稳定的探针 id')
  assert.match(
    quizCard,
    /:data-probe-count="showFinish \? 0 : 1"/,
    '★ 渲染题数直接写在 data-probe-count 上（单题 = 1；收尾 = 0）'
  )
})
