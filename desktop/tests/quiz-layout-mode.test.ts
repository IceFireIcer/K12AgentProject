/**
 * 闯关页的**答题排版**：一次一张（默认）/ 全部铺开（用户 2026-09-26 的设计裁决）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 旧版把一关的题**全部铺开**排在同一张卡里：一屏里同时摆着三份题面 / 选项 / 提交键，
 * 学生看不出「现在该做哪一道」，答完一题还得自己在页面上找下一道在哪。新版默认
 * **一次一张**：答对 → 点「下一题」→ 卡片换成下一题；旧的排版**一字不改地保留**，
 * 两者之间只有一个开关。
 *
 * 五条纪律，每条都对应一种「看起来只是排版不同、其实是状态分家」的缺陷：
 *
 * 1. ★★ **默认必须是一次一张**：判错方向的代价不对称 —— 默认铺开等于这次改动对
 *    「打开就看」的学生完全没生效。存过偏好的学生按自己的选择走（重启也保留）。
 * 2. ★★ **两种排版共用同一段模板与同一份状态**：差别只有「一次渲染几行」（`visibleRows`）。
 *    另写一份题体，等于同一条规则有了两份实现 —— 缺陷只会出现在没改的那一份上（P-143）。
 * 3. ★★ **推进只认后端判分结论**：`下一题` 的可用条件读 `result.correct === true`，
 *    前端不比对答案、不自己判对错（判分只在 Python）。
 * 4. ★★ **切排版 / 切关卡不许丢状态**：切排版不重置草稿与判分；换关卡与「重做本关」
 *    才把单卡复位到第一题（那时作答本来就被清掉了）。
 * 5. ★ **一屏只允许一个主色填充**（`.k12-cta`）：`上一题 / 下一题` 走 `el-button`；
 *    收尾卡替换掉题体与卡脚，所以它那里那个 `.k12-cta` 是那一屏唯一的主行动。
 *    这条同时保护 `scripts/verify-guard-mutations.mjs` 的 ⑤（它只替换**第一处** `.k12-cta`，
 *    多一处就会让那条变异验证静默失效）。
 *
 * 跑法：`npm test`（源码级 + 纯 store 断言）；真机交互由 `scripts/ux-pages-audit.mjs`
 * 的闯关页那一格量。
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

/** 取函数体（从一个 `function xxx(` / `const xxx = computed(` 起，到花括号配平处）。 */
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

const QUIZ_VIEW = 'src/renderer/src/views/Quiz.vue'
const quizSource = read(...QUIZ_VIEW.split('/'))
const quizCode = stripComments(quizSource)

/* ------------------------------------------------------------------ *
 * 1. ★★ 默认一次一张（纯 store：默认值 / 键 / 白名单 / 读异常兜底）
 * ------------------------------------------------------------------ */

test('★★ 默认排版是「一次一张」，键是 `k12.quizLayout`（没存过偏好就回默认）', async () => {
  const mod = await import('../src/renderer/src/stores/quizLayout.ts')
  assert.equal(
    mod.QUIZ_LAYOUT_DEFAULT,
    'single',
    '★★ 默认必须是**一次一张**：判错方向的代价不对称 —— 默认铺开等于这次改动对「打开就看」的学生完全没生效'
  )
  assert.equal(mod.QUIZ_LAYOUT_STORAGE_KEY, 'k12.quizLayout', 'localStorage 的键带应用前缀，别和同源下别的东西撞名')
})

test('★ 只认两个字面量：手改的、旧版本写的、别的应用写进来的一律回默认', async () => {
  const mod = await import('../src/renderer/src/stores/quizLayout.ts')
  const original = (globalThis as { localStorage?: unknown }).localStorage
  try {
    const stub = (value: string | null): void => {
      ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => value }
    }
    stub('list')
    assert.equal(mod.readStoredQuizLayout(), 'list', "存过 'list' → 全部铺开（学生自己选的）")
    stub('single')
    assert.equal(mod.readStoredQuizLayout(), 'single', "存过 'single' → 一次一张")
    stub('grid')
    assert.equal(mod.readStoredQuizLayout(), mod.QUIZ_LAYOUT_DEFAULT, '认不出的值 → 回默认')
    stub(null)
    assert.equal(mod.readStoredQuizLayout(), mod.QUIZ_LAYOUT_DEFAULT, '没存过 → 回默认')

    // localStorage 在 file:// + 某些沙箱组合下会抛：读偏好失败绝不能让页面白屏
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      }
    }
    assert.equal(mod.readStoredQuizLayout(), mod.QUIZ_LAYOUT_DEFAULT, '读异常 → 回默认（不抛）')
  } finally {
    ;(globalThis as { localStorage?: unknown }).localStorage = original
  }
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 一段模板两种排版：只改「可见行数」
 * ------------------------------------------------------------------ */

test('★★ 两种排版共用同一个 `v-for`，差别只有 `visibleRows`（不许有第二份题体）', () => {
  assert.match(
    quizCode,
    /<li\s+v-for="row in visibleRows"/,
    '★ 题目列表的渲染源必须是 `visibleRows`（单卡 = 一行，列表 = 全部）'
  )
  // 唯一允许按 `questionRows` 全量遍历的是**题号步骤条**（它要的就是「一共几题」）；
  // 题体本身只许走 `visibleRows` —— 出现第二处就是「同一件事两份实现」。
  const railAt = quizCode.indexOf('class="steps"')
  const railEnd = quizCode.indexOf('</ol>', railAt)
  assert.ok(railAt > 0 && railEnd > railAt, '找不到题号步骤条')
  assert.match(
    quizCode.slice(railAt, railEnd),
    /v-for="row in questionRows"/,
    '步骤条按全部题渲染（一题一颗）'
  )
  const fullScans = quizCode.match(/v-for="row in questionRows"/g) ?? []
  assert.equal(
    fullScans.length,
    1,
    `★ 全量遍历只许出现在步骤条里（实测 ${fullScans.length} 处）—— 题体必须走 visibleRows`
  )

  const visible = blockOf(quizCode, 'const visibleRows = computed(')
  assert.match(visible, /if \(layout\.value === 'list'\) return questionRows\.value/, '列表模式 = 全部题（原排版的行为一字不改）')
  assert.match(visible, /return currentRow\.value === null \? \[\] : \[currentRow\.value\]/, '单卡模式 = 只有当前那一行')
  assert.match(visible, /if \(showFinish\.value\) return \[\]/, '走完最后一题 → 题体不渲染（换成收尾卡）')
})

test('★ 排版模式只住在 store 里（页面不另存一份 ref）', () => {
  assert.match(quizCode, /import \{ useQuizLayoutStore, type QuizLayout \} from '\.\.\/stores\/quizLayout'/, '排版模式来自专用 store')
  const layout = blockOf(quizCode, 'const layout = computed<QuizLayout>(')
  assert.match(layout, /get: \(\) => layoutStore\.mode/, '读：直接读 store')
  assert.match(layout, /set: \(next\) => layoutStore\.set\(next\)/, '写：走 store（顺手落盘），页面不自己存一份')
  assert.match(quizCode, /v-model="layout"/, '开关直接绑这个可写 computed')
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 推进只认后端判分结论
 * ------------------------------------------------------------------ */

test('★★ 「下一题」只在**后端判为答对**之后可点；答错留在原地重试', () => {
  const settled = blockOf(quizCode, 'const currentSettled = computed(')
  assert.match(
    settled,
    /correct === true/,
    '★ 判据只读后端判分的 `correct === true`（前端不比对答案、不推断对错）'
  )

  const next = blockOf(quizCode, 'function nextQuestion(): void')
  assert.match(next, /if \(!currentSettled\.value\) return/, '没答对 → 「下一题」不做任何事（答错留下来接着想）')
  assert.match(
    next,
    /finished\.value = true/,
    '最后一题答对后点「下一题」→ 收尾卡'
  )
  assert.match(
    quizCode,
    /:disabled="!currentSettled"/,
    '按钮上真的绑了可用条件（只定义不绑 = 学生还是能跳过没做的题）'
  )
  assert.match(
    blockOf(quizCode, 'function goTo(index: number): void'),
    /cursorQid\.value = target\.question\.qid/,
    '跳题记的是 **qid** 而不是下标（生成题晚到不会把学生面前的题换掉）'
  )
})

test('★ 列表模式才自动滚到下一道；单卡模式的推进由学生点「下一题」触发', () => {
  const submit = blockOf(quizCode, 'async function submit(qid: string, index: number)')
  assert.match(
    submit,
    /layout\.value === 'list'/,
    '`advanceAfterCorrect` 只在列表模式调用（单卡模式换卡由 `nextQuestion` 负责）'
  )
})

/* ------------------------------------------------------------------ *
 * 4. ★ 步骤条：可点、状态来自后端、读屏有话说
 * ------------------------------------------------------------------ */

test('★ 题号步骤条可点（自由跳题），状态与「我在哪一题」分开表达', () => {
  assert.match(quizCode, /data-testid="quiz-steps"/, '步骤条要有稳定锚点')
  assert.match(quizCode, /:data-testid="`quiz-step-\$\{row\.index \+ 1\}`"/, '每一颗步骤要能单独定位（体检脚本按题号量）')
  assert.match(quizCode, /@click="goTo\(row\.index\)"/, '★ 步骤条是可点的：想回看哪一题就点哪一题（「一次一张」是节奏，不是门禁）')
  assert.match(quizCode, /:aria-current="!showFinish && row\.index === currentIndex \? 'step' : undefined"/, '当前题要有 `aria-current`（读屏 / 键盘用户靠它定位）')
  assert.match(quizCode, /:aria-label="stepLabel\(row\.index, row\.attempt\)"/, '每一颗步骤的读屏文案要带题号与状态')

  const label = blockOf(quizCode, 'function stepLabel(index: number, attempt: QuizAttempt | null): string')
  assert.match(label, /答对了/, '答对的步骤要读得出来')
  assert.match(label, /还没做对/, '答错的步骤要读得出来')

  const state = blockOf(quizCode, 'function stepState(attempt: QuizAttempt | null)')
  assert.match(state, /result\?\.correct === true/, '步骤状态同样只读后端结论')
  assert.match(quizCode, /class="step k12-tap"/, '步骤条的 28px 触控下限走设计系统的 `.k12-tap`（页面不写死尺寸）')
})

/* ------------------------------------------------------------------ *
 * 5. ★ 收尾卡：答对几题 + 三个出口
 * ------------------------------------------------------------------ */

test('★ 收尾卡只在单卡模式、且真的走完最后一题时出现', () => {
  const show = blockOf(quizCode, 'const showFinish = computed(')
  assert.match(show, /layout\.value === 'single'/, '列表模式没有收尾卡（那里一题都不藏）')
  assert.match(show, /questions\.value\.length > 0/, '一关没题时走空态分支，不摆一张「做完了」的假卡')
  assert.match(quizCode, /v-if="showFinish"[\s\S]{0,200}data-testid="quiz-finish"/, '收尾卡有自己的锚点')
})

test('★ 收尾卡三个出口：回去接着做 / 看本轮小结 / 去下一关', () => {
  assert.match(quizCode, /data-testid="quiz-finish-score"/, '要把「答对几题」说清楚（数字来自后端判分）')
  assert.match(
    blockOf(quizCode, 'const correctRows = computed('),
    /result\?\.correct === true/,
    '答对题数只数后端判成 correct 的（不引入第二套统计口径）'
  )
  assert.match(
    blockOf(quizCode, 'const firstUnsettledIndex = computed('),
    /correct !== true/,
    '「还有几题没做对」= 还没拿到 correct 的那些'
  )
  assert.match(quizCode, /data-testid="quiz-finish-back"[\s\S]{0,120}@click="backToUnsettled\(\)"/, '「回去接着做」要真的跳回第一道没答对的题')
  assert.match(quizCode, /data-testid="quiz-finish-summary" @click="historyOpen = true"/, '「看本轮小结」开的是既有那个抽屉（不另造一份小结）')
  assert.match(quizCode, /data-testid="quiz-finish-next-level"[\s\S]{0,120}@click="goNextLevel\(\)"/, '「去下一关」要接真动作')

  const nextLevel = blockOf(quizCode, 'const nextLevel = computed(')
  assert.match(nextLevel, /levels\.value/, '下一关来自服务端给的关卡顺序（前端不排序）')
  assert.match(nextLevel, /list\[index \+ 1\] \?\? null/, '按拓扑序取下一关；没有下一关就是 null')
  assert.match(
    blockOf(quizCode, 'function goNextLevel(): void'),
    /quiz\.selectLevel\(target\.kpId\)/,
    '去下一关走既有的 `selectLevel`（取题 / 清作答 / 播进度那条链路一字不改）'
  )
  assert.match(quizCode, /v-if="nextLevel"/, '已经是最后一关就不渲染这个按钮（不摆一个点了没反应的入口）')
})

/* ------------------------------------------------------------------ *
 * 6. ★★ 切排版不许丢状态；换关卡 / 重做本关才复位
 * ------------------------------------------------------------------ */

test('★★ 换关卡与「重做本关」把单卡复位到第一题（切排版不碰这些状态）', () => {
  const restart = blockOf(quizCode, 'function restartLevel(): void')
  assert.match(restart, /cursorQid\.value = ''/, '「重做本关」要把单卡送回第一题（作答全清了，停在第三题会像没生效）')
  assert.match(restart, /finished\.value = false/, '「重做本关」要收掉收尾卡')

  assert.match(
    quizCode,
    /watch\(\s*\(\) => quiz\.activeKpId,/,
    '★ 换关卡要复位（判据是「哪一关」这个身份：切走再切回来停在第一题）'
  )
  // 复位只发生在 `restartLevel` 与那条 watch 里：切排版（`layoutStore.set`）不许顺手清东西
  const resets = (quizCode.match(/cursorQid\.value = ''/g) ?? []).length
  assert.equal(
    resets,
    2,
    `复位只允许 2 处（重做本关 + 换关卡 watch，实测 ${resets} 处）—— 多出来的那处很可能是在切排版时顺手把作答状态清了`
  )
})

/* ------------------------------------------------------------------ *
 * 7. ★ 一屏一个主色填充：导航键不是 `.k12-cta`
 * ------------------------------------------------------------------ */

test('★★ 主列不许压扁子项：滚动列里的每一块必须 `flex: none`', () => {
  // ★★ 用户 2026-09-30 报「个性化学习底部那条白条是什么，是不是删东西没删干净」。
  //   实测**不是**删码留下的残渣：那是「判分与掌握度说明」那张卡 ——
  //   flex 列的默认 `flex-shrink: 1` 让浏览器在内容超高时**先压缩子项**，
  //   它被从 56px 压成 21px，而内部的折叠标题仍有 48px 且被卡片的圆角裁掉
  //   ⇒ 屏幕上只剩一条**没有任何字**的白条（看起来就像残留元素）。
  //   判据：`overflow-y: auto` 的列空间不够时**滚动**，不许改写子项高度（P-168）。
  const css = stripComments(read('src', 'renderer', 'src', 'views', 'Quiz.vue'))
  const mainRule = /\.quiz__main\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? ''
  assert.match(mainRule, /overflow-y:\s*auto/, '锚点漂了：`.quiz__main` 不再是那个滚动列')
  assert.match(
    css,
    /\.quiz__main\s*>\s*\*\s*\{[^}]*flex:\s*none/,
    '★★ 滚动列里的子项必须 `flex: none` —— 否则内容一超高就把最后一块压成「白条」'
  )
})

test('★ 上一题 / 下一题走 el-button，不再多一个主色填充（.k12-cta）', () => {
  for (const id of ['quiz-prev', 'quiz-next']) {
    const at = quizCode.indexOf(`data-testid="${id}"`)
    assert.ok(at > 0, `找不到 ${id}`)
    const before = quizCode.lastIndexOf('<el-button', at)
    assert.ok(before > 0, `${id} 必须是 el-button`)
    const tag = quizCode.slice(before, at)
    assert.doesNotMatch(
      tag,
      /k12-cta/,
      `★ ${id} 不得用 .k12-cta：一屏只允许一个主色填充，且变异脚本 ⑤ 只替换第一处`
    )
  }
  // 收尾卡的主行动是那个唯一的 `.k12-cta`（题体与卡脚这时都不渲染）
  const finishAt = quizCode.indexOf('data-testid="quiz-finish-next-level"')
  const finishTag = quizCode.slice(quizCode.lastIndexOf('<button', finishAt), finishAt)
  assert.match(finishTag, /class="k12-cta"/, '收尾卡那一屏的主行动要有主色填充（它是那一屏唯一的）')
})
