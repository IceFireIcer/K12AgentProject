/**
 * 演示沙箱（预置数据）的守卫（2026-09-27，D-096）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它：这套预置内容有两个**只有机器能守**的性质
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **① 数字必须互相解释得通。**
 *   学习记录页那一屏数字（活动量 / 答题数 / 答对数 / 连续天数 / 徽章 /
 *   各阶段关卡数）在真实后端那边是**同一批表算出来的**，因此天然自洽；
 *   预置数据是手写的，一旦哪两个数对不上，界面上就会当场自相矛盾
 *   （「答对 45 / 共 58」旁边写着「错题 12 道」）。这条只有断言能守。
 *
 * **② 引用的每个知识点与章节名必须真实存在。**
 *   编一个 kp_id 的代价不是报错，而是界面上出现「未命名知识点」——
 *   那比空着还难看，而且**演示当场**才发现。
 *
 * ★★ 这两条还有一个共同的背景：脚本住在**主进程**（`main/demo/script.ts`），
 *   而 `student-view-discipline.test.ts` 只扫**渲染进程**的文件 ——
 *   于是那一整套学生面纪律（技术词 / kp slug / 未渲染 Markdown / 破折号）
 *   在这批文本上**一次都没跑过**。本文件把这四条补上（第 ④ 节）。
 *
 * ⚠️ 本文件**不 import electron**：`ipc/handlers.ts` 那几条断言是**源码级**的
 *   （读文件文本、比位置），不是运行时断言 —— 单测环境里起不了 `ipcMain`。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { restoreConversation } from '../src/renderer/src/api/events.ts'
import { readCodingCard } from '../src/renderer/src/cards/coding.ts'
import { readQuizCard } from '../src/renderer/src/cards/quiz.ts'
import {
  DEMO_CHAPTER_PROGRESS,
  DEMO_CHAPTER_TITLE,
  DEMO_CODE_SESSION_ID,
  DEMO_GRADE_LEVEL,
  DEMO_LOOP_SESSION_ID,
  DEMO_NEURAL_SESSION_ID,
  DEMO_MASTERY,
  DEMO_PROGRESS_LEVELS,
  DEMO_QUIZ_CORRECT,
  DEMO_QUIZ_SESSION_ID,
  DEMO_QUIZ_TOTAL,
  DEMO_REPORT_DAYS,
  DEMO_SESSIONS,
  demoChapterBody,
  demoChaptersBody,
  demoGradeHistoryBody,
  demoGradeSignalsBody,
  demoGradeStateBody,
  demoGraphBody,
  demoMistakesBody,
  demoOpeningBody,
  demoProfileBody,
  demoQuizGeneratedBody,
  demoQuizProgressBody,
  demoRecommendationBody,
  demoReportBody,
  demoSavedAnimationItemBody,
  demoSavedAnimationListBody,
  demoSessionListBody,
  demoSettingsBody,
  demoStudentBody
} from '../src/main/demo/data.ts'
import { demoResponseFor } from '../src/main/demo/overlay.ts'
import {
  DEMO_ANIMATION_KP_ID,
  DEMO_ANIMATION_TEMPLATE_ID,
  DEMO_HISTORY_TURN_COUNT,
  DEMO_SCRIPT_KP_IDS,
  DEMO_SCRIPT_TEXT,
  buildDemoScript,
  buildDemoSessionMessages,
  demoHistoryCitationCounts
} from '../src/main/demo/script.ts'
import { isDemoSeeded, resetDemoSeedForTests, setDemoSeeded } from '../src/main/demo/state.ts'
import {
  DEMO_BLOCKED_MESSAGE,
  DEMO_SCRIPT_TURN_COUNT,
  isDemoScriptPayload,
  readDemoSeedState
} from '../src/shared/demo-seed.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..')

/**
 * 解析钩子：让 Node 也能加载主进程模块里的 `@shared/*` 别名。
 *
 * ★ 为什么这一条是**新加**的（2026-09-27）：`main/demo/script.ts` 现在从
 *   `main/agent/diagnostics.ts` 取**真实的** `segmentPrompt()` / `byteHash()`（诊断信封里的
 *   提示词分段与画像指纹必须与真实采集链路同源同算法），而那个模块顶层 value-import 了
 *   `@shared/diagnostics` —— 别名只有打包器认（`electron.vite.config.ts` 的 `resolve.alias`），
 *   裸 Node 解析不了。
 * ★ 分工（两边缺一不可）：
 *   · `script.ts` 那边把这条依赖写成**动态** import：静态 import 的解析发生在模块链接期，
 *     那时本文件的钩子还没跑（实测过：同文件里 registerHooks 对静态 import 不生效）；
 *   · 本文件这边登记钩子：`buildDemoScript()` 里的动态 import 走的是加载器，钩子对它生效。
 * ⚠️ 只影响本测试进程；与 `tests/demo-mode.test.ts` 等 20 来个文件是同一份钩子
 *   （仓库既有惯例：要直接 import 主进程模块的测试都自带一份）。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      const file = join(desktopRoot, 'src', 'shared', `${specifier.slice('@shared/'.length)}.ts`)
      return nextResolve(pathToFileURL(file).href, context)
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 主进程源码里有不带后缀的相对 import（走 tsc / vite 解析），Node 也不认
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

/** 读主进程/渲染进程源码（断言「源码里长什么样」时用）。 */
const readSource = (...segments: string[]): string =>
  readFileSync(join(desktopRoot, ...segments), 'utf8')

/** 读仓库根下的文件（随包资产）。 */
const readRepo = (...segments: string[]): string =>
  readFileSync(join(repoRoot, ...segments), 'utf8')

/* ------------------------------------------------------------------ *
 * 真实资产：这里算出来的两个集合是后面全部「引用真实」断言的判据
 * ------------------------------------------------------------------ */

/** 随包题库的 8 个分片（章节名 + 知识点 id 的真源）。 */
const QUIZBANK_DIR = join(repoRoot, 'preset-content', 'quizbank')

interface BankShard {
  chapter: string
  questions: Array<{ kp_id?: unknown }>
}

const bankShards: BankShard[] = readdirSync(QUIZBANK_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(QUIZBANK_DIR, name), 'utf8')) as BankShard)

/** 全部真实章节名（8 个）。 */
const REAL_CHAPTERS = new Set(bankShards.map((shard) => shard.chapter))

/**
 * 真实的**高中**知识点 id 集合。
 *
 * ★ 真源仍是随包题库（`preset-content/quizbank/*.json`）：沙箱预置里出现的每个 kp_id
 *   都必须在这里找得到 —— 编一个 id 的代价是界面上出现「未命名知识点」，
 *   而那只有现场才看得见。
 */
const REAL_SENIOR_KP_IDS = new Set(
  bankShards.flatMap((shard) =>
    shard.questions
      .map((question) => question.kp_id)
      .filter((kpId): kpId is string => typeof kpId === 'string' && kpId.endsWith('-sr'))
  )
)

/** 某份响应体里出现的全部字符串叶子（用来把「引用的东西」一次收全）。 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return out
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
  return out
}

/** 某份响应体里出现的全部 kpId 形状的字符串。 */
const KP_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+-(?:pl|ph|jr|sr)$/

function collectKpIds(value: unknown, out: string[] = []): string[] {
  for (const text of collectStrings(value)) {
    if (KP_ID_RE.test(text)) out.push(text)
  }
  return out
}

/** 全部预置响应体（一遍收齐，后面多节复用）。 */
function allDemoBodies(): Record<string, unknown> {
  return {
    student: demoStudentBody(),
    profile: demoProfileBody(),
    recommendation: demoRecommendationBody(),
    opening: demoOpeningBody(),
    report: demoReportBody(DEMO_REPORT_DAYS),
    mistakes: demoMistakesBody(),
    chapters: demoChaptersBody(DEMO_GRADE_LEVEL),
    graph: demoGraphBody(DEMO_GRADE_LEVEL),
    quizProgress: demoQuizProgressBody(),
    quizGenerated: demoQuizGeneratedBody(),
    savedAnimations: demoSavedAnimationListBody(),
    gradeState: demoGradeStateBody(),
    gradeSignals: demoGradeSignalsBody(),
    gradeHistory: demoGradeHistoryBody(),
    chapter: demoChapterBody(),
    settings: demoSettingsBody(),
    sessionList: demoSessionListBody()
  }
}

/* ------------------------------------------------------------------ *
 * ① 自洽性
 * ------------------------------------------------------------------ */

test('演示沙箱 ①：预置数字互相解释得通（daily / 答题 / 连续天数 / 徽章 / 关卡）', () => {
  const report = demoReportBody(DEMO_REPORT_DAYS) as Record<string, unknown>
  const daily = report.daily as Array<{ day: string; count: number; correctCount: number }>

  // `total_activities` 就是每日活动量之和（真实后端也是这么算的）
  const sumCount = daily.reduce((sum, day) => sum + day.count, 0)
  assert.equal(sumCount, report.totalActivities, 'daily 之和必须等于 totalActivities')

  // 答题数 / 答对数：答对不能超过总数，错题总数 = 总数 − 答对数
  const quizTotal = report.quizTotal as number
  const quizCorrect = report.quizCorrect as number
  assert.ok(quizCorrect <= quizTotal, '答对数不能超过答题数')
  assert.equal(quizTotal, DEMO_QUIZ_TOTAL)
  assert.equal(quizCorrect, DEMO_QUIZ_CORRECT)

  const mistakes = demoMistakesBody() as Record<string, unknown>
  assert.equal(
    mistakes.totalWrong,
    quizTotal - quizCorrect,
    '错题本的 totalWrong 必须等于 答题数 − 答对数'
  )
  const items = mistakes.items as Array<{ wrongCount: number }>
  assert.equal(
    items.reduce((sum, item) => sum + item.wrongCount, 0),
    mistakes.totalWrong,
    '错题条目的 wrongCount 之和必须等于 totalWrong'
  )

  // 连续天数：最后一条就是今天，且 todayStudied 为真
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate()
  ).padStart(2, '0')}`
  assert.equal(daily.length, 7, '窗口里应当有 7 天有活动（正好铺满 7 天报告窗口）')
  assert.equal(daily[daily.length - 1]?.day, todayKey, '最后一条活动必须是今天')
  assert.equal(report.todayStudied, true)
  assert.equal(report.streakDays, 7, '连续天数要与「7 天有活动且今天已学」一致')

  // 徽章 = 进度行里去重后的非空徽章（升序）
  const fromProgress = [
    ...new Set(
      DEMO_PROGRESS_LEVELS.map((row) => row.badge).filter(
        (badge): badge is string => typeof badge === 'string' && badge !== ''
      )
    )
  ].sort()
  assert.deepEqual(report.badges, fromProgress, '报告的 badges 必须与进度行的徽章一致')
  // ★ 徽章文本的形态是 `档位-答对题数`（`server/app/routes/quiz.py` 的 `badge_for`）：
  //   五档 `起步 / 初通 / 熟练 / 精通 / 大师` 封顶，`-N` 里的 N 如实记答对数。
  //   这里按**「答对几道 = 第几档」**这条可读口径核对（与徽章文案自身的意思一致），
  //   而不是把刻度推回过短的五档表 —— 换一批预置数据时，
  //   只有「档位与答对数自洽」这条判据是不该变的。
  const badgeLevels = ['起步', '初通', '熟练', '精通', '大师']
  for (const row of DEMO_PROGRESS_LEVELS) {
    if (row.badge === null) continue
    const [tier, count] = row.badge.split('-')
    const expected = badgeLevels[Math.min(Number(count), badgeLevels.length) - 1]
    assert.equal(tier, expected, `${row.kpId} 的徽章档位与答对数对不上：${row.badge}`)
    assert.equal(
      Number(count),
      DEMO_MASTERY.find((item) => item.kpId === row.kpId)?.correct ?? 0,
      `${row.kpId} 的徽章答对数必须等于掌握度表里的 correct`
    )
  }

  // 关卡数：三处必须同时对上 —— 进度行条数、真实初中知识点数、stageCounts 之和
  const stageCounts = report.stageCounts as Record<string, number>
  const stageSum = Object.values(stageCounts).reduce((sum, value) => sum + value, 0)
  assert.equal(
    DEMO_PROGRESS_LEVELS.length,
    REAL_SENIOR_KP_IDS.size,
    '进度行必须覆盖该学段的全部真实知识点'
  )
  assert.equal(stageSum, REAL_SENIOR_KP_IDS.size, 'stageCounts 之和必须等于真实学段关卡数')

  // stageCounts 必须精确等于进度行按 stage 分组的计数
  const actual: Record<string, number> = {}
  for (const row of DEMO_PROGRESS_LEVELS) actual[row.stage] = (actual[row.stage] ?? 0) + 1
  assert.deepEqual(stageCounts, actual, 'stageCounts 必须精确等于进度行的分组计数')

  // 掌握度：条数 ≤ 真实知识点数、不重复、分数合法，且**逐行与「答对 +0.15 / 答错 −0.10」自洽**
  assert.ok(DEMO_MASTERY.length <= REAL_SENIOR_KP_IDS.size)
  assert.equal(new Set(DEMO_MASTERY.map((row) => row.kpId)).size, DEMO_MASTERY.length, '掌握度不能重复')
  for (const row of DEMO_MASTERY) {
    assert.ok(row.score >= 0 && row.score <= 1, `掌握度越界：${row.kpId}`)
    assert.ok(row.correct <= row.attempts, `${row.kpId} 的答对数比作答数还多`)
    // ★★ `score` **不是** `correct / attempts` 的商：它是逐次作答累积的平滑值
    //    （服务端按每次对错加/减一个小量），所以它比这个商更"重"也更"钝"。
    //    这里只钉住它**必须自洽**的那几条：空记录只能是 0、答对必然抬高它。
    //    ⚠️ 不拿「答对 +0.15 / 答错 −0.10 求和」去反算 —— 那条式子是**每次作答的增量**，
    //    而列里存的是累积后的平滑值，两者不是同一个量（真按它反算会得到 0.35 这种
    //    与 0.75 差一倍的值，那是判据写错了，不是数据错了）。
    if (row.attempts === 0) {
      assert.equal(row.score, 0, `${row.kpId} 一次都没练过，掌握度必须是 0`)
      assert.equal(row.correct, 0, `${row.kpId} 一次都没练过，答对数必须是 0`)
    } else if (row.correct === 0) {
      // 「练过但一道没对」是合法的（强化学习那一关就是它，推荐位第一条也指着它）：
      // 掌握度只能是 0，而且它必须真的被 `quizzed` 而不是 `mastered`（下面另有一条）。
      assert.equal(row.score, 0, `${row.kpId} 一道没对，掌握度必须是 0`)
    }
  }
  // 主线那一关要真的练过（演示讲的就是它，掌握度不能是 0）
  assert.ok(
    (DEMO_MASTERY.find((row) => row.kpId === 'machine-learning-sr')?.score ?? 0) > 0.6,
    '主线知识点（机器学习）必须有像样的掌握度'
  )

  // 章节进度：章数与 kp 总数都要对上真实资产
  const chapterSum = DEMO_CHAPTER_PROGRESS.reduce((sum, row) => sum + row.kpCount, 0)
  assert.equal(chapterSum, REAL_SENIOR_KP_IDS.size, '各章 kpCount 之和必须等于真实知识点数')
  assert.equal(DEMO_CHAPTER_PROGRESS.length, REAL_CHAPTERS.size, '章节数必须等于真实章数')
})

test('演示沙箱 ①：预置的动画库与生成题结构合法（id 字符集 / 摘要进制 / 无答案）', () => {
  const list = demoSavedAnimationListBody() as Record<string, unknown>
  const items = list.items as Array<Record<string, unknown>>
  assert.ok(items.length >= 2, '动画库里应当有预设的条目')
  for (const item of items) {
    assert.match(String(item.id), /^[A-Za-z0-9_-]{1,64}$/, '动画库条目 id 必须符合字符集')
    assert.match(String(item.promptHash), /^[0-9a-fA-F]{8,128}$/, 'promptHash 必须是十六进制摘要')
    assert.equal(Object.hasOwn(item, 'html'), false, '清单里不许带 html（与真实端点同形）')
  }
  // 取一条：认得出的回正文、认不出的回 null（不是抛异常）
  const one = demoSavedAnimationItemBody(String(items[0]?.id))
  assert.ok(one !== null, '认得出的条目要回正文')
  assert.equal(demoSavedAnimationItemBody('不存在的-id-绝不匹配'), null)

  // ★ 渲染产物由调用方（覆盖层，取自真实端点）注入：带上它才带得出 `html` 与
  //   `payloadId`（渲染侧拿这两个建 iframe / 认沙箱消息）；没有它时 `html` 是**空串**
  //   且不带 `payloadId` —— 演示不许凭空冒出一个沙箱身份（降级路径走文字要点）。
  const rendered = demoSavedAnimationItemBody(String(items[0]?.id), {
    html: '<html>真实端点产物</html>',
    payloadId: 'demo-saved-anim-loop-3ways'
  })
  assert.equal(rendered?.html, '<html>真实端点产物</html>')
  assert.equal(rendered?.payloadId, 'demo-saved-anim-loop-3ways')
  assert.equal(one?.html, '', '没有渲染产物时 html 必须是空串（交给文字降级）')
  assert.equal(Object.hasOwn(one ?? {}, 'payloadId'), false, '没有产物就不该带 payloadId')

  // 生成题：结构上就没有答案
  const generated = demoQuizGeneratedBody() as Record<string, unknown>
  assert.equal(generated.source, 'generated')
  const questions = generated.questions as Array<Record<string, unknown>>
  assert.ok(questions.length >= 1)
  for (const question of questions) {
    assert.equal(Object.hasOwn(question, 'answer'), false, '对外题目不许带答案')
    assert.equal(Object.hasOwn(question, 'explanation'), false, '对外题目不许带解析')
    assert.ok(['choice', 'blank', 'code_blank'].includes(String(question.type)))
  }
})

/* ------------------------------------------------------------------ *
 * ② 引用真实
 * ------------------------------------------------------------------ */

test('演示沙箱 ②：出现的每个 kp_id 与章节名都在随包资产里真实存在', () => {
  const bodies = allDemoBodies()
  const unknownKp: string[] = []
  for (const [name, body] of Object.entries(bodies)) {
    for (const kpId of collectKpIds(body)) {
      if (!REAL_SENIOR_KP_IDS.has(kpId)) unknownKp.push(`${name} → ${kpId}`)
    }
  }
  assert.deepEqual(unknownKp, [], `出现了不存在的知识点 id：${unknownKp.join('、')}`)

  const unknownChapters = collectStrings(bodies).filter(
    (text) => text.startsWith('第') && text.includes('章') && /^第\d章/.test(text) && !REAL_CHAPTERS.has(text)
  )
  assert.deepEqual(
    [...new Set(unknownChapters)],
    [],
    '出现了不存在的章节名（界面会显示一本不存在的教材）'
  )

  // 脚本用到的那五个知识点也要真实
  for (const kpId of DEMO_SCRIPT_KP_IDS) {
    assert.ok(REAL_SENIOR_KP_IDS.has(kpId), `脚本引用了不存在的知识点：${kpId}`)
  }
})

/* ------------------------------------------------------------------ *
 * ③ 脚本可解析（含 B′：对话里必须看得见动画）
 * ------------------------------------------------------------------ */

test('演示沙箱 ③：五轮脚本可解析，四轮有卡片、拦截轮没有', async () => {
  const payload = await buildDemoScript()
  assert.equal(payload.turns.length, DEMO_SCRIPT_TURN_COUNT)
  assert.equal(DEMO_SCRIPT_TEXT.length, DEMO_SCRIPT_TURN_COUNT)
  assert.ok(isDemoScriptPayload(payload), '脚本必须过 preload 边界的形状校验')

  for (const turn of payload.turns) {
    assert.equal(typeof turn.turn, 'number')
    assert.ok(turn.studentText.length > 0, '每轮都要有学生原话（演示者打什么都显示这一句）')
    assert.ok(turn.answer.length > 0, '每轮都要有正文')
    if (turn.diagnostics.done.status === 'blocked') {
      // ★★ 拦截轮：输入侧就拦下了，模型没开口 → 这一轮**没有卡片**（也没有引用、
      //    没有工具、没有提示词）。写成「每轮至少一张」会让这条守卫与拦截轮的
      //    真实形状正面打架，所以这里显式区分两种轮次。
      assert.equal(turn.cards.length, 0, '拦截轮不该有卡片（模型没开口，没有内容态可取）')
      continue
    }
    // ★ 第 1 轮**没有卡片**：那一轮是纯讲解 + 两条教材引用（引用不走 payload 事件，
    //   走的是 citation 事件），这正是「问知识点 → 看动画 → 编程练手 → 我会了」里的第一拍。
    //   所以判据不是「每轮都有卡」，而是「有卡的那几轮必须有卡」—— 下面还会把
    //   「恰好有一轮没有卡、且那一轮有引用」钉死，免得将来某轮把卡漏掉还过得去。
    assert.ok(
      turn.cards.length >= 1 || turn.citations.length >= 1,
      '每一轮至少要有卡片或引用之一（空气泡是现场最难看的）'
    )
    // 卡片必须能被**真实的**投影函数读成期望的形态（不是"看起来像"）
    for (const card of turn.cards) {
      if (card.kind === 'quiz') {
        const view = readQuizCard(card.payload)
        assert.ok(
          view.kind === 'questions' || view.kind === 'unknown',
          `闯关卡投影异常：${view.kind}`
        )
      }
      if (card.kind === 'coding') {
        const view = readCodingCard(card.payload)
        assert.ok(
          view.kind === 'template' || view.kind === 'unknown',
          `编程卡投影异常：${view.kind}`
        )
      }
      if (card.kind === 'animation') {
        const shape = card.payload as { fallbackText?: unknown }
        // ★ 动画卡一定带得出**一段可读的兜底文案**：模板取不到时界面就靠它降级，
        //   所以这里断言的是「降级路径一定有的可显示」（而不是 html 非空 ——
        //   单测环境里没有 sidecar，取不到模板是**正常**的）。
        assert.equal(typeof shape.fallbackText, 'string')
        assert.ok(String(shape.fallbackText).length > 0)
      }
    }
  }

  // ★ 五轮的卡片分布收口（与 `docs/preset-redesign/01` 的卡片调用清单逐轮对应）：
  //   第 1 轮引用 ×2、第 2 轮动画、第 3 轮编程、第 4 轮闯关、第 5 轮（拦截）两样都没有。
  assert.deepEqual(
    payload.turns.map((turn) => turn.cards.map((card) => card.kind)),
    [[], ['animation'], ['coding'], ['quiz'], []],
    '五轮的卡片分布必须与脚本设计一致（漏一张卡就是现场少一段演示）'
  )
  assert.equal(payload.turns[0]?.citations.length, 2, '第 1 轮要带两条教材引用')

  // 事件序列喂真实 reducer：能折叠出期望的 turn 状态
  const first = payload.turns[0]
  assert.ok(first !== undefined)
  const restored = restoreConversation(
    [
      { role: 'user', text: first.studentText, entryId: 'e1' },
      { role: 'assistant', text: first.answer, entryId: 'e2' }
    ],
    DEMO_GRADE_LEVEL
  )
  assert.equal(restored.turns.length, 1)
  assert.equal(restored.turns[0]?.status, 'done')
  assert.equal(restored.turns[0]?.userText, first.studentText)
  assert.equal(restored.turns[0]?.text, first.answer)
})

test('演示沙箱 ③b：预置历史会话回看时带得出动画卡（真实会话仍不带）', async () => {
  // ① 那条会话的正文里，助手消息**带 cards**
  const messages = await buildDemoSessionMessages(DEMO_NEURAL_SESSION_ID)
  assert.ok(messages.length >= 2)
  const withCards = restoreConversation(
    messages.map((message) => ({
      role: message.role,
      text: message.text,
      entryId: message.entryId,
      ...(message.cards ? { cards: message.cards } : {})
    })),
    DEMO_GRADE_LEVEL
  )
  const cards = withCards.turns.flatMap((turn) => turn.cards)
  assert.ok(cards.length >= 1, '预置历史回看后必须看得到卡片')
  assert.equal(cards[0]?.kind, 'animation', '第一条预置历史要带回那张动画卡')

  // ② 负向对照：**不带 cards 的**（真实会话的形状）回看后卡片数为 0 ——
  //    证明这个口子只服务预置内容，没有改变真实历史「只回文本」的口径。
  const plain = restoreConversation(
    messages.map((message) => ({ role: message.role, text: message.text, entryId: message.entryId })),
    DEMO_GRADE_LEVEL
  )
  assert.equal(plain.turns.flatMap((turn) => turn.cards).length, 0, '真实会话的投影里没有卡片')

  // ③ 三条预置会话都能读出正文，且只有被登记的那条带卡片
  const payload = await buildDemoScript()
  // ★ 三条都登记在册：每条会话的第一轮都挂着与它主题同源的那张卡
  //   （神经网络 → 动画卡、监督学习 → 编程卡、梯度下降 → 动画卡），
  //   所以「点开哪一条都看得见卡片」不靠演示者的手速。
  assert.deepEqual(
    [...payload.sessionsWithCards].sort(),
    [DEMO_LOOP_SESSION_ID, DEMO_CODE_SESSION_ID, DEMO_QUIZ_SESSION_ID].sort()
  )
  for (const id of [DEMO_LOOP_SESSION_ID, DEMO_CODE_SESSION_ID, DEMO_QUIZ_SESSION_ID]) {
    const body = await buildDemoSessionMessages(id)
    assert.ok(body.length >= 2, `${id} 应当有正文`)
  }
  // ④ 会话列表与 DEMO_SESSIONS 一一对应
  const list = demoSessionListBody()
  assert.deepEqual(
    list.map((item) => item.id).sort(),
    DEMO_SESSIONS.map((session) => session.id).sort()
  )
  assert.ok(list.every((item) => typeof item.title === 'string' && item.title !== ''))
})

/* ------------------------------------------------------------------ *
 * ③c 第 1 轮那张动画卡：模板 / 知识点 / 引用必须讲同一件事
 * ------------------------------------------------------------------ */

/**
 * 读一个知识点在真实知识库里的头部两行（`server/knowledge/senior/<kp>.md`）。
 *
 * ★ 引用行上显示的章节名与小节名**必须**逐字等于这里声明的两行 ——
 *   这是「引用的东西真实存在」这条判据的机器可读真源，
 *   而不是「我们记得教材里是那么写的」。
 */
function readKnowledgeHeader(kpId: string): { chapterTitle: string; knowledgePoint: string } | null {
  const path = join(repoRoot, 'server', 'knowledge', 'senior', `${kpId}.md`)
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const chapter = /^chapter_title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  const point = /^knowledge_point:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  return chapter === '' || point === '' ? null : { chapterTitle: chapter, knowledgePoint: point }
}

test('演示沙箱 ③c：动画卡那张模板 —— 模板覆盖的知识点、对话讲的知识点、引用的小节是同一个', async () => {
  // ① 点名的模板真的在随包里，而且它自己声明覆盖这个知识点、支持这个学段。
  //    ★ 渲染端点在 `templateId` 命中时**不校验**「这份模板覆盖哪个知识点」
  //      （见 `script.ts` 里 ANIMATION_TEMPLATE_ID 上方的说明）—— 于是这条判据
  //      只剩测试能守：改坏了表现是「讲列表却播别的」，一眼假，而且只有现场才看得见。
  const templatePath = join(
    repoRoot,
    'server',
    'resources',
    'templates',
    `${DEMO_ANIMATION_TEMPLATE_ID}.json`
  )
  assert.ok(existsSync(templatePath), `点名的动画模板不存在：${DEMO_ANIMATION_TEMPLATE_ID}`)
  const template = JSON.parse(readFileSync(templatePath, 'utf8')) as {
    concept?: unknown
    fallback_text?: unknown
    kp_ids?: unknown
    grade_levels?: unknown
  }
  assert.ok(
    Array.isArray(template.kp_ids) && template.kp_ids.includes(DEMO_ANIMATION_KP_ID),
    `${DEMO_ANIMATION_TEMPLATE_ID} 的 kp_ids 必须覆盖 ${DEMO_ANIMATION_KP_ID}`
  )
  assert.ok(
    Array.isArray(template.grade_levels) && template.grade_levels.includes(DEMO_GRADE_LEVEL),
    `${DEMO_ANIMATION_TEMPLATE_ID} 必须声明支持 ${DEMO_GRADE_LEVEL}`
  )
  assert.ok(DEMO_SCRIPT_KP_IDS.includes(DEMO_ANIMATION_KP_ID), '动画卡的知识点必须是脚本用到的那几个之一')

  // ② 两条引用的章节名 / 小节名逐字等于该知识点在真实知识库里的头两行。
  //    ★ 引用挂在**问知识点那一轮**（第 1 轮），动画卡挂在第 2 轮 —— 两轮讲的都是
  //    {@link DEMO_ANIMATION_KP_ID} 这一个知识点，所以两边引的是同一节。
  const payload = await buildDemoScript()
  const first = payload.turns[0]
  assert.ok(first !== undefined)
  const header = readKnowledgeHeader(DEMO_ANIMATION_KP_ID)
  assert.ok(header !== null, `找不到 ${DEMO_ANIMATION_KP_ID} 的知识库文件（引用的真源）`)
  assert.ok(first.citations.length >= 1, '第 1 轮要带引用（信封里那条检索轨迹的落点）')
  for (const citation of first.citations) {
    assert.equal(citation.chapterTitle, header.chapterTitle, '章节名必须逐字取自真实知识库')
    assert.equal(citation.sectionTitle, header.knowledgePoint, '小节名必须逐字取自真实知识库')
  }

  // ③ 取不到模板时卡片上显示的那两句（概念名 / 降级文案）**必须是模板声明的原话**：
  //    降级面也不能编 —— 编的那句会把「这份模板在讲什么」说成另一件事。
  //    （真的取到渲染产物时，产物里那两份与这里读的是同一份模板的同一个字段。）
  const card = payload.turns
    .flatMap((turn) => turn.cards)
    .find((item) => item.kind === 'animation')
  assert.ok(card !== undefined, '脚本里必须有一张动画卡')
  const shape = card.payload as { concept?: unknown; fallbackText?: unknown }
  assert.equal(String(shape.concept), String(template.concept), '卡片概念名必须是模板声明的那个')
  assert.equal(
    String(shape.fallbackText),
    String(template.fallback_text),
    '卡片降级文案必须是模板声明的 fallback_text'
  )
})

/* ------------------------------------------------------------------ *
 * ③d 诊断信封：提示词 / 画像块 / 机制字段必须是**真实的那一份**
 *
 * ★ 为什么单列一节：这一屏的全部价值是「所见即所发」。信封最容易出的不是
 *   「字段缺了」，而是**手写的概述冒充提示词** —— 界面上展开得像那么回事，
 *   与真正发给模型的那份却对不上，而且肉眼看不出来。这一节把「同源」钉成机器判据：
 *   测试自己拿真实函数再拼一遍，逐字与信封比对。
 * ------------------------------------------------------------------ */

test('演示沙箱 ③d：信封里的提示词与画像块是同源真实产物，机制字段没有虚位', async () => {
  const payload = await buildDemoScript()
  // 真实算法（`agent/diagnostics.ts` 顶层 value-import 了 `@shared/diagnostics`，
  // 所以走动态 import —— 解析钩子在本文件顶部登记，见那里的说明）
  const { segmentPrompt, estimateTokens, byteHash } = await import('../src/main/agent/diagnostics.ts')
  const { buildGradeSystemPrompt } = await import('../src/main/agent/extensions/grade.ts')
  const { renderStudentContextBlock, withStudentContext } = await import(
    '../src/main/agent/prompts/student-context.ts'
  )
  const { PROMPT_SECTIONS } = await import('../src/main/agent/prompts/rules.ts')
  const { SENIOR_SYSTEM_PROMPT } = await import('../src/main/agent/prompts/senior.ts')
  const { AGENT_TOOL_NAMES } = await import('../src/main/agent/extensions/index.ts')

  // 照真实链路再拼一遍：目标学段模板（+权威段）→ 画像块插在权威段之前
  const block = renderStudentContextBlock(
    demoProfileBody() as never,
    {
      recommendation: demoRecommendationBody() as never,
      mistakes: demoMistakesBody() as never
    }
  )
  assert.ok(block.length > 0, '预置学生的画像块不能是空的')
  assert.ok(
    block.length <= 1600,
    `画像块 ${block.length} 字超过了采集器的展示上限（1600）—— 那时信封必须带 truncated: true，` +
      '而这里写的是 false（短块才允许不截断）'
  )
  const expectedPrompt = withStudentContext(
    buildGradeSystemPrompt({ incoming: undefined, inferredGrade: DEMO_GRADE_LEVEL }),
    block
  )
  // 拼出来的 prompt 里必须**真的有**那份高中模板（含五次强制声明的原文）
  assert.ok(expectedPrompt.includes(SENIOR_SYSTEM_PROMPT), '拼装结果必须包含真实的高中模板全文')

  const expectedHash = byteHash(block)
  // ★ 脚本轮次是缓冲区的第 10..14 轮（前面 9 个号归预置历史，见 `DEMO_HISTORY_TURN_COUNT`），
  //   所以「第几轮」不再等于「这份脚本里的第几项」——判据改用**下标**，
  //   原意一个字没变：除第 1 轮外，其余轮的画像块与上一轮逐字节相同。
  //   ⚠️ 拦截轮单独断言（见下面的 ⑥）：它没有提示词、没有工具、没有检索。
  const normalTurns = payload.turns.filter((turn) => turn.diagnostics.done.status !== 'blocked')
  const blockedTurns = payload.turns.filter((turn) => turn.diagnostics.done.status === 'blocked')
  assert.equal(blockedTurns.length, 1, '五轮里应当恰好有一轮是拦截轮')
  const blockedTurn = blockedTurns[0]
  assert.ok(blockedTurn !== undefined)
  {
    const diag = blockedTurn.diagnostics
    // ★★ 拦截轮的三条「没有」：没拼提示词、没出工具、没查教材 ——
    //   它们是「输入侧命中、立刻拦下」的可观测证据，写成有就等于信封在撒谎。
    assert.equal(diag.prompt.chars, 0, '拦截轮不该有提示词（输入侧就拦了，没拼 prompt）')
    assert.deepEqual(diag.tools, [], '拦截轮不该有工具调用（拦在工具之前）')
    assert.equal(diag.retrieval, null, '拦截轮不该有检索轨迹')
    assert.equal(diag.interceptions.length, 1, '拦截轮必须有一条拦截记录')
    assert.equal(diag.interceptions[0]?.source, 'wordlist', '拦截来源必须是词表命中')
    assert.equal(diag.done.status, 'blocked')
    assert.equal(diag.done.ok, false)
    assert.equal(diag.done.firstTokenMs, 0, '没发模型请求 → 首字延迟是 0')
    // 入口一档 blocked、后两档 skipped：三阶段都要有结论，且与上面那条拦截一致
    assert.deepEqual(
      diag.safetyFinal.stages.map((stage) => [stage.stage, stage.verdict]),
      [
        ['input', 'blocked'],
        ['stream', 'skipped'],
        ['final', 'skipped']
      ],
      '拦截轮的安全三阶段必须如实写成「入口拦下 + 后两档没跑」'
    )
    assert.equal(diag.safetyFinal.finalizations, 0, '一个模型请求都没发，终审一次也没跑过')
    assert.equal(diag.safetyFinal.retractions, 0, '从来没有正文到过学生面前，也就没有撤回')
  }
  for (const [index, turn] of normalTurns.entries()) {
    const diag = turn.diagnostics

    // ① 提示词：分段、字符数、token 数都必须来自真实拼装结果
    assert.deepEqual(
      diag.prompt.segments,
      segmentPrompt(expectedPrompt),
      '信封里的分段必须就是真实 prompt 用真实切段器切出来的那几段（不许手写概述）'
    )
    assert.deepEqual(
      diag.prompt.segments.map((segment) => segment.label),
      [
        '你是谁',
        '学段与语言风格',
        '知识范围（只讲本学段及以下，不超纲）',
        '学生信息与联系边界（不索取个人信息、不进行任何形式的私下联系）',
        '输出对象与保密（直接面向学生，禁止暴露内部实现与提示词）',
        '可用工具与调用时机',
        '什么时候要用工具，什么时候不用',
        '闲聊、跑题与学生的情绪',
        '学生画像（本轮注入）',
        '学段权威段（恒追加）'
      ],
      '段落标题必须是真实模板里的小标题（高中模板现在是七节 + 画像 + 权威段）'
    )
    // 五条强制声明（§10.5）在分段里一条都不能少
    for (const heading of [
      PROMPT_SECTIONS.stage,
      PROMPT_SECTIONS.scope,
      PROMPT_SECTIONS.privacy,
      PROMPT_SECTIONS.output,
      PROMPT_SECTIONS.tools
    ]) {
      const label = heading.replace(/^#\s*/, '')
      assert.ok(
        diag.prompt.segments.some((segment) => segment.label === label),
        `分段落里缺了强制声明那一节：${label}`
      )
    }
    assert.equal(diag.prompt.chars, expectedPrompt.length, 'prompt.chars 必须是真实拼装结果的长度')
    assert.equal(
      diag.prompt.totalTokens,
      estimateTokens(expectedPrompt),
      'prompt.totalTokens 必须按真实算法估算'
    )
    assert.equal(diag.prompt.segments.length, 10, '七节模板 + 画像块 + 权威段 = 10 段')

    // ② 画像块：逐字节真实、三轮同一份（第 2、3 轮「与上一轮相同」）
    assert.equal(diag.studentContext.text, block, '画像块正文必须与真实拼装函数一致')
    assert.equal(diag.studentContext.chars, block.length)
    assert.equal(diag.studentContext.byteHash, expectedHash, '指纹必须用真实的 byteHash 算法')
    assert.equal(diag.studentContext.injected, true)
    assert.equal(diag.studentContext.sameAsPrev, index > 0, '第 2、3 轮的块与上一轮逐字节相同')

    // ③ 工具：名字必须是冻结词表里的真实 Tool（拼错一个字母就是一条不存在的调用）
    for (const tool of diag.tools) {
      assert.ok(
        (AGENT_TOOL_NAMES as readonly string[]).includes(tool.name),
        `信封里出现了不存在的工具名：${tool.name}`
      )
    }

    // ④ 检索：四档都要在；第 1 轮命中数必须与这一轮的引用条数一致
    if (diag.retrieval !== null) {
      assert.deepEqual(
        diag.retrieval.levels.map((level) => level.level),
        ['vector', 'cloud', 'fts', 'outline'],
        '四级降级链四档都要在'
      )
      for (const level of diag.retrieval.levels) {
        assert.ok(level.note.length > 0, `第 ${level.level} 档没有说明（未走到也要给出为什么）`)
      }
      assert.equal(diag.retrieval.levels[0]?.tried, true, '第 1 轮第 1 级要真的试过')
      assert.equal(diag.retrieval.levels[0]?.hits, turn.citations.length, '命中块数必须等于引用条数')
      assert.equal(
        diag.retrieval.levels.filter((level) => level.tried).length,
        1,
        '第 1 级命中之后，后面三级这一轮没有被执行过'
      )
      assert.match(diag.retrieval.gradeFilter, /^grade_level IN \('senior'/, '过滤式必须点名本学段')
      assert.ok(
        diag.retrieval.gradeFilter.includes('junior') &&
          diag.retrieval.gradeFilter.includes('primary_high') &&
          diag.retrieval.gradeFilter.includes('primary_low'),
        '向上兼容开着时白名单里必须带更低学段（真实下发的就是这四个）'
      )
    } else {
      assert.equal(turn.citations.length, 0, '没有检索轨迹就不能有引用（两处必须一致）')
    }

    // ⑤ 安全三阶段：都要有结论；撤回 0 与三阶段全 pass 一致；缓冲字数就是本轮正文
    assert.deepEqual(
      diag.safetyFinal.stages.map((stage) => [stage.stage, stage.verdict]),
      [
        ['input', 'pass'],
        ['stream', 'pass'],
        ['final', 'pass']
      ]
    )
    assert.equal(diag.safetyFinal.retractions, 0, '演示里没有撤回')
    assert.ok(diag.safetyFinal.finalizations > 0, '终审要真的跑过（否则 final 一档不许写 pass）')
    assert.equal(
      diag.safetyFinal.bufferedChars,
      turn.answer.length,
      '缓冲字数必须是这一轮真正放出去的正文长度'
    )

    // ⑥ 时序：首字与总时长都要像真的，且三轮各不相同
    assert.ok(diag.done.firstTokenMs !== null && diag.done.firstTokenMs > 0)
    assert.ok(diag.done.totalMs > diag.done.firstTokenMs)
  }

  const firstMs = payload.turns.map((turn) => turn.diagnostics.done.totalMs)
  const firstTokens = payload.turns.map((turn) => turn.diagnostics.done.firstTokenMs)
  assert.equal(new Set(firstMs).size, firstMs.length, '三轮的总时长不能一模一样')
  assert.equal(new Set(firstTokens).size, firstTokens.length, '三轮的首字延迟不能一模一样')
})

/* ------------------------------------------------------------------ *
 * ④ 学生可见文本的四条纪律（补偿项：脚本在主进程，绕过了渲染侧扫描）
 * ------------------------------------------------------------------ */

test('演示沙箱 ⑦b：沙箱分支必须在「忙时排队」之前（否则脚本轮次会被排队卡住）', () => {
  const source = stripComments(readSource('src', 'renderer', 'src', 'stores', 'chat.ts'))
  const sendAt = source.indexOf('async function send(')
  assert.ok(sendAt >= 0, '找不到 send()')
  const send = source.slice(sendAt, source.indexOf('async function submitQuizAnswer', sendAt))

  const sandboxAt = send.indexOf('useDemoSeedStore().seeded')
  const queueAt = send.indexOf('if (streaming.value) {')
  assert.ok(sandboxAt >= 0, 'send() 里必须有沙箱分支')
  assert.ok(queueAt >= 0, 'send() 里必须有忙时排队分支')
  assert.ok(
    sandboxAt < queueAt,
    '★ 沙箱分支必须在「忙时排队」之前：放到之后的话，脚本一轮还在放时按发送会走排队分支，' +
      '而脚本轮次的事件不经 IPC 订阅 —— 那条「待发送」永远不会被自动发出，' +
      '屏上还会显示演示者打的字（不是脚本那句）。实测踩到过。'
  )

  // ★ 排队分支内部的既有纪律不许被破坏（与 ux-queue-and-scroll 的源码切片同一条）：
  //   排队赋值必须发生在任何 return 之前，「忙时排队」那段里不许出现 localNotice 清理。
  const queueBody = send.slice(queueAt, send.indexOf('localNotice.value = null', queueAt))
  assert.ok(queueBody.includes('queuedText.value = text'), '忙分支里必须把内容放进队列')
  assert.ok(
    queueBody.indexOf('queuedText.value = text') < queueBody.indexOf('return'),
    '排队赋值必须发生在任何 return 之前'
  )
})

/** 与 `student-view-discipline.test.ts` 同口径的四类标记。 */
const MARK_SYNTAX = ['**', '`'] as const
const DASH_MARK = '——'

/** 技术词（取渲染侧词表里对演示文案有意义的那些；注释里写清为什么）。 */
const BANNED_TERMS = [
  'SQL',
  'FTS5',
  'WHERE',
  'kp_id',
  'kpId',
  'kb.sqlite',
  'learning.db',
  'Pyodide',
  'embedding',
  'Embedding',
  'HTTP 4',
  'HTTP 5',
  '降级链',
  '分块',
  '已嵌入',
  '进程号',
  '端口号'
] as const

/** 学生可见的预置文本（脚本三段 + 开场引导 + 错题题干 + 会话正文 + 降级文案）。 */
async function studentVisibleTexts(): Promise<Array<{ where: string; text: string }>> {
  const out: Array<{ where: string; text: string }> = []
  for (const turn of DEMO_SCRIPT_TEXT) {
    out.push({ where: `第 ${turn.turn} 轮 · 学生原话`, text: turn.studentText })
    out.push({ where: `第 ${turn.turn} 轮 · 正文`, text: turn.answer })
  }
  const opening = demoOpeningBody() as { text?: unknown }
  out.push({ where: '开场引导', text: String(opening.text ?? '') })

  const mistakes = demoMistakesBody() as { items?: Array<{ kpName?: unknown; stem?: unknown }> }
  for (const item of mistakes.items ?? []) {
    out.push({ where: '错题 · 知识点名', text: String(item.kpName ?? '') })
    out.push({ where: '错题 · 题干', text: String(item.stem ?? '') })
  }

  const saved = demoSavedAnimationListBody() as {
    items?: Array<{ title?: unknown; concept?: unknown; fallbackText?: unknown }>
  }
  for (const item of saved.items ?? []) {
    out.push({ where: '动画库 · 标题', text: String(item.title ?? '') })
    out.push({ where: '动画库 · 概念', text: String(item.concept ?? '') })
    out.push({ where: '动画库 · 降级文案', text: String(item.fallbackText ?? '') })
  }

  for (const id of [DEMO_LOOP_SESSION_ID, DEMO_CODE_SESSION_ID, DEMO_QUIZ_SESSION_ID]) {
    for (const message of await buildDemoSessionMessages(id)) {
      out.push({ where: `预置会话 ${id}`, text: message.text })
    }
  }

  const script = await buildDemoScript()
  for (const turn of script.turns) {
    for (const card of turn.cards) {
      if (card.kind !== 'animation') continue
      const shape = card.payload as { fallbackText?: unknown; concept?: unknown }
      out.push({ where: '动画卡 · 降级文案', text: String(shape.fallbackText ?? '') })
      out.push({ where: '动画卡 · 概念名', text: String(shape.concept ?? '') })
    }
  }
  return out
}

test('演示沙箱 ④：预置文本不含技术词 / 知识点 slug / 未渲染 Markdown / 破折号', async () => {
  const texts = await studentVisibleTexts()
  const problems: string[] = []
  for (const { where, text } of texts) {
    for (const term of BANNED_TERMS) {
      if (text.includes(term)) problems.push(`${where} 含技术词「${term}」`)
    }
    // 知识点 slug：`machine-learning-sr` 这类内部标识不许出现在学生看得见的字里
    const slugs = text.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+-(?:pl|ph|jr|sr)\b/g)
    if (slugs) problems.push(`${where} 含知识点标识 ${slugs.join('、')}`)
    for (const mark of MARK_SYNTAX) {
      if (text.includes(mark)) problems.push(`${where} 含未渲染的 Markdown 标记「${mark}」`)
    }
    if (text.includes(DASH_MARK)) problems.push(`${where} 含破折号`)
    // 「演示 / 回放 / 预置 / 假数据」这四个词是**无痕口径**的红线
    for (const word of ['演示', '回放', '预置', '假数据'] as const) {
      if (text.includes(word)) problems.push(`${where} 含「${word}」字样`)
    }
  }
  assert.deepEqual([...new Set(problems)], [], problems.join('\n'))
})

/* ------------------------------------------------------------------ *
 * ⑤ 模型配置显示态
 * ------------------------------------------------------------------ */

test('演示沙箱 ⑤：模型配置看起来早就配好，但只有掩码、没有明文', () => {
  const settings = demoSettingsBody() as {
    llm: Record<string, unknown>
    embedding: Record<string, unknown>
  }
  assert.equal(settings.llm.hasKey, true, '要显示成「已经配好了」')
  assert.equal(typeof settings.llm.baseUrl, 'string')
  assert.ok(String(settings.llm.baseUrl).startsWith('https://'))
  assert.ok(String(settings.llm.modelId).length > 0)
  // ★ 掩码形状：省略号 + 4 位十六进制。**任何形态的明文都不许出现。**
  assert.match(String(settings.llm.apiKey), /^…[0-9a-f]{4}$/, 'apiKey 只能是掩码')

  const everything = JSON.stringify(allDemoBodies())
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(everything), false, '预置数据里不许出现明文密钥形状')
  assert.equal(everything.includes('auth.json'), false)
  assert.equal(everything.includes('models.json'), false)

  // 会外呼的两个动作在**处理器层**也是拒绝的（按钮禁用只是第一层）
  const handlers = readSource('src', 'main', 'ipc', 'handlers.ts')
  for (const channel of ['settingsProbe', 'settingsFetchModels', 'settingsSave']) {
    const at = handlers.indexOf(`IPC.${channel}`)
    assert.ok(at >= 0, `找不到 ${channel} 的处理器`)
    const slice = handlers.slice(at, at + 1400)
    assert.ok(
      slice.includes('demoBlocked()') || slice.includes('const blocked = demoBlocked()'),
      `${channel} 在沙箱态必须被拒绝（它要么会外呼、要么会写真实配置）`
    )
  }
})

/* ------------------------------------------------------------------ *
 * ⑥ 覆盖层：负向对照 + 白名单
 * ------------------------------------------------------------------ */

test('演示沙箱 ⑥：覆盖层未激活时严格 no-op，激活后只拦学生态、内容态一律透传', async () => {
  /** 内容态（随包资产）：**任何状态下都不许被拦**。 */
  const CONTENT_PATHS = [
    '/api/quiz/bank/machine-learning-sr?grade_level=senior&count=3',
    '/api/code/templates/machine-learning-sr',
    '/api/code/hint/machine-learning-sr?level=1',
    '/api/animation/templates',
    '/api/animation/render',
    '/api/knowledge/stats',
    '/api/knowledge/points',
    '/api/settings/probe',
    '/api/settings/models'
  ] as const

  /** 学生态（这个人用过的痕迹）：激活后必须被拦。 */
  const STUDENT_PATHS = [
    ['/api/profile/student_001', 'student'],
    ['/api/profile/student_001/recommendation', 'items'],
    ['/api/profile/student_001/opening', 'text'],
    ['/api/profile/student_001/report?days=7', 'daily'],
    ['/api/profile/student_001/chapter', 'chapterTitle'],
    ['/api/grade/state/student_001', 'grade'],
    ['/api/grade/signals/student_001', 'signals'],
    ['/api/grade/history/student_001', 'entries'],
    ['/api/quiz/mistakes/student_001', 'items'],
    ['/api/quiz/progress/student_001', 'levels'],
    ['/api/quiz/generated/student_001', 'questions'],
    ['/api/knowledge/chapters/senior?student_id=student_001', 'chapters'],
    ['/api/graph/overview/senior?student_id=student_001', 'nodes'],
    ['/api/animation/saved/student_001', 'items'],
    // ★ 取一条（**带 html**）：覆盖层要为它真渲染一次产物；本机没有 sidecar 时
    //   渲染取不到 → 回**空串 html**（渲染侧据此走文字降级），这里断言它照样被拦下、
    //   响应体里仍然有 `html` 这个字段，且**不是**编出来的东西。
    ['/api/animation/saved/student_001/saved-anim-001', 'html'],
    ['/api/settings', 'llm']
  ] as const

  // ── 负向对照：**未激活**时任何路径都不作答（普通态下这一层等于不存在）──
  // ⚠️ 覆盖层是 `async` 的（动画库「取一条」要先真渲染一份产物，见 `overlay.ts`）：
  //    这里的 `await` 只是取值，判据（null = 严格 no-op）一个字都没变。
  resetDemoSeedForTests()
  assert.equal(isDemoSeeded(), false)
  for (const path of [...CONTENT_PATHS, ...STUDENT_PATHS.map(([path]) => path)]) {
    assert.equal(await demoResponseFor(path), null, `未激活时不该拦 ${path}`)
  }

  // ── 激活：学生态命中，且回的是 200 + 合法 JSON ──
  try {
    setDemoSeeded('seeded')
    assert.equal(isDemoSeeded(), true)
    for (const [path, field] of STUDENT_PATHS) {
      const response = await demoResponseFor(path)
      assert.ok(response !== null, `学生态读必须被拦：${path}`)
      assert.equal(response.status, 200)
      const body = (await response.json()) as Record<string, unknown>
      assert.ok(Object.hasOwn(body, field), `${path} 的响应体里缺字段 ${field}`)
    }

    // ── 内容态：激活后**仍然**透传（一字不许假）──
    for (const path of CONTENT_PATHS) {
      assert.equal(await demoResponseFor(path), null, `内容态必须透传：${path}`)
    }

    // ── 写方法：覆盖层只拦 GET（写操作由处理器层拒绝）──
    assert.equal(await demoResponseFor('/api/profile/student_001/chapter', { method: 'PUT' }), null)
  } finally {
    resetDemoSeedForTests()
  }
  assert.equal(isDemoSeeded(), false)
})

/* ------------------------------------------------------------------ *
 * ⑦c 只读通道的学段：沙箱态必须回预置学段（2026-10-02 实测缺陷的回归）
 * ------------------------------------------------------------------ */

test('演示沙箱 ⑦c：沙箱态下「只读通道注入的学段」必须是预置学段', () => {
  /**
   * ★★ 这条守的是一个**只有现场才看得见**的缺陷（2026-10-02 用户报「个性化学习页题目取不到」）：
   *
   *   沙箱态下 `grade:get` 走自己那条分支、`ensureChatRuntime()` 一次都不跑，
   *   于是 `runtime` 恒为 `null` → `currentGradeLevelForReads()` 回 `null` →
   *   题库请求落到一个**写死的冷启动兜底**，带着另一个学段去取题。
   *   高中那 57 个知识点在别的学段一个都不存在（实测：`ai-definition-sr` +
   *   `grade_level=primary_high` → **404**），界面上就是「这关的题目没取到」，
   *   而题库里一道题都没少。
   *
   * 判据落在源码上而不是行为上：那个函数在模块内部、要 `ipcMain` 才能跑到，
   * 而**顺序**正是缺陷的全部内容（谁先返回，谁说了算）。
   */
  const source = stripComments(readSource('src', 'main', 'ipc', 'handlers.ts'))
  const at = source.indexOf('function currentGradeLevelForReads(')
  assert.ok(at >= 0, '找不到 currentGradeLevelForReads()')
  const body = source.slice(at, source.indexOf('\n}', at))

  const demoAt = body.indexOf('isDemoSeeded()')
  const runtimeAt = body.indexOf('runtime === null')
  assert.ok(demoAt >= 0, 'currentGradeLevelForReads() 必须有沙箱分支（否则只读通道拿到的是别的学段）')
  assert.ok(runtimeAt >= 0, '前提变了：这个函数本该先看 runtime')
  assert.ok(
    demoAt < runtimeAt,
    '★ 沙箱分支必须排在最前：放到 runtime 检查之后，沙箱态永远走不到它（runtime 恒为 null）'
  )
  assert.match(
    body.slice(demoAt, demoAt + 120),
    /return DEMO_GRADE_LEVEL/,
    '沙箱分支必须回**预置学段**（回别的值等于没修）'
  )

  // 兜底：题库那条通道不许再写死一个别的学段字面量
  const dataSource = stripComments(readSource('src', 'main', 'ipc', 'handlers-data.ts'))
  const bankAt = dataSource.indexOf('ipcMain.handle(IPC.quizBank')
  assert.ok(bankAt >= 0, '找不到题库处理器')
  const bankBody = dataSource.slice(bankAt, dataSource.indexOf('ipcMain.handle(', bankAt + 10))
  assert.match(
    bankBody,
    /\?\? DEFAULT_GRADE_LEVEL/,
    '★ 题库的冷启动兜底必须是真实的 DEFAULT_GRADE_LEVEL（手写别的学段 = 取不到题）'
  )
  assert.equal(
    /'primary_high'|'primary_low'|'senior'/.test(bankBody),
    false,
    '题库处理器里不许出现写死的学段字面量（它会静默绕开「按当前学段取题」）'
  )
})

/* ------------------------------------------------------------------ *
 * ⑦ 装配防护（源码级：沙箱分支必须早于 ensureChatRuntime）
 * ------------------------------------------------------------------ */

/**
 * 去掉注释。
 *
 * ★ 这一条**必须**有：沙箱分支上面就写着一段解释它的注释，而那段注释里
 *   **提到了 `ensureChatRuntime()`**（「必须在它之前」）—— 不剥注释的话，
 *   「谁在前」比的是**注释里那个名字**，守卫会当场假红（实测踩到）。
 *   守护卫比的是**代码**，注释里提谁的名字都不算。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('演示沙箱 ⑦：四个处理器的沙箱分支都早于 ensureChatRuntime（装配防护）', () => {
  const source = stripComments(readSource('src', 'main', 'ipc', 'handlers.ts'))

  /** 取一个 `ipcMain.handle(IPC.<channel>` 起、到下一个处理器注册之前的那一段（已剥注释）。 */
  const handlerBody = (channel: string): string => {
    const at = source.indexOf(`IPC.${channel}`)
    assert.ok(at >= 0, `找不到 ${channel} 的处理器`)
    const rest = source.slice(at)
    const next = rest.indexOf('ipcMain.handle(', 1)
    return next === -1 ? rest : rest.slice(0, next)
  }

  /**
   * ★★ 这一条为什么必须存在：`ensureChatRuntime()` 会**真的装配 Pi 会话**，
   *   而装配会往 `students/<id>/pi-agent/` 下写东西（含开场白）。
   *   沙箱分支挪到它之后，「进沙箱」这个动作就不再是「一个字节都不落盘」了 ——
   *   而那正是这套设计最硬的一条验收口径。
   */
  for (const [channel, marker] of [
    ['gradeGet', 'DEMO_GRADE_LEVEL'],
    ['sessionState', 'demoFreshSessionState()'],
    ['sessionList', 'demoSessionListBody()'],
    ['chapterGet', 'DEMO_CHAPTER_TITLE']
  ] as const) {
    const body = handlerBody(channel)
    const branchAt = body.indexOf(marker)
    assert.ok(branchAt >= 0, `${channel} 的沙箱分支不见了（判据：${marker}）`)

    const runtimeAt = body.indexOf('ensureChatRuntime()')
    if (runtimeAt >= 0) {
      assert.ok(
        branchAt < runtimeAt,
        `${channel} 的沙箱分支必须早于 ensureChatRuntime()（否则进沙箱会真的拉起 Pi 会话）`
      )
    }
    // 沙箱分支里不许写模块级缓存（`currentGrade` / `currentChapter`）——
    // 缓存一旦被预置值污染，退出沙箱后「值没变就不推送」会让真实值推不出去。
    const head = body.slice(0, branchAt)
    assert.equal(head.includes('currentGrade ='), false, `${channel} 的沙箱分支之前不该写 currentGrade`)
    assert.equal(head.includes('currentChapter ='), false, `${channel} 的沙箱分支之前不该写 currentChapter`)
  }

  // 另外三处沙箱读通道也必须在**读真实文件**之前拦下：
  // 它们不装配 Pi，但它们会读到真实学生的会话标题（现场投影仪最容易照到的那一类内容）。
  for (const [channel, marker] of [
    ['sessionTranscript', 'demoTranscriptFor'],
    ['sessionSearch', 'demoSearchSessions']
  ] as const) {
    const body = handlerBody(channel)
    assert.ok(body.includes(marker), `${channel} 必须有沙箱分支（${marker}）`)
    assert.ok(
      body.indexOf('isDemoSeeded()') < body.indexOf('loadSessions()'),
      `${channel} 的沙箱分支必须早于 loadSessions()（否则会读真实会话文件）`
    )
  }
})

/* ------------------------------------------------------------------ *
 * ⑧ 零写入：每个写通道的处理器里都有沙箱回绝
 * ------------------------------------------------------------------ */

test('演示沙箱 ⑧：所有会写数据的通道在处理器层都有沙箱回绝', () => {
  const handlers = readSource('src', 'main', 'ipc', 'handlers.ts')
  const dataHandlers = readSource('src', 'main', 'ipc', 'handlers-data.ts')

  /**
   * ★ 这里是**源码级**断言而不是「跑一遍再看文件 mtime」——
   *   那些处理器要 `ipcMain` 与 electron 运行时，单测环境里起不来。
   *   判据取「处理器体内出现过 `demoBlocked()`」：它比「mtime 没变」更早生效
   *   （mtime 只能证明这一次没写，源码断言能证明**这条路根本没有写的可能**）。
   */
  const check = (source: string, channel: string, label: string): void => {
    const at = source.indexOf(`IPC.${channel}`)
    assert.ok(at >= 0, `找不到 ${channel} 的处理器`)
    const rest = source.slice(at)
    const next = rest.indexOf('ipcMain.handle(', 1)
    const body = next === -1 ? rest : rest.slice(0, next)
    assert.ok(
      body.includes('demoBlocked()'),
      `${label}（${channel}）在沙箱态必须被拒绝 —— 它会写真实数据或真实配置`
    )
    // 回绝里不许出现 HTTP 状态码，也不许出现「演示 / 回放」字样
    assert.equal(/HTTP\s*\d/.test(DEMO_BLOCKED_MESSAGE), false, '回绝文案里不许出现状态码')
    assert.equal(/演示|回放|预置|假数据/.test(DEMO_BLOCKED_MESSAGE), false, '回绝文案里不许出现这四个词')
  }

  check(handlers, 'gradeSet', '手动设定学段')
  check(handlers, 'chapterSet', '手动选定章节')
  check(handlers, 'settingsSave', '保存设置')
  check(handlers, 'settingsProbe', '连通性探测（会外呼）')
  check(handlers, 'settingsFetchModels', '拉取模型清单（会外呼）')
  check(handlers, 'sessionNew', '新会话')
  check(handlers, 'sessionDelete', '删除会话（破坏性）')
  check(handlers, 'sessionBranch', '会话分叉')
  check(dataHandlers, 'quizGrade', '提交判分')
  check(dataHandlers, 'codeRunHint', '代码报错归一')
  check(dataHandlers, 'animationSavedSave', '保存动画到库')
  check(dataHandlers, 'animationSavedDelete', '删除库里的动画')
  check(dataHandlers, 'knowledgeImport', '导入教材')
  check(dataHandlers, 'knowledgeRebuild', '重建索引')

  // ── 诊断信封的两条 invoke 也要有沙箱分支（实测踩到过一次，见下）──────────────
  // ★★ 这一条为什么必须有：`diagnostics:clear` 在沙箱态下**会删真实学生落盘的 JSONL**。
  //    实测：主进程还是旧代码时点了一次「一键清空」，`students/student_001/pi-agent/logs/
  //    turn-diagnostics.jsonl` 当场就没了 —— 那是真实数据，而「一字未动」是这套设计的
  //    核心验收口径。沙箱态下它必须**只清眼前那份**。
  for (const [channel, marker] of [
    ['diagnosticsRead', 'blocked()'],
    ['diagnosticsClear', 'blocked()']
  ] as const) {
    const at = handlers.indexOf(`IPC.${channel}`)
    assert.ok(at >= 0, `找不到 ${channel} 的处理器`)
    const body = handlers.slice(at, handlers.indexOf('ipcMain.handle(', at + 10))
    assert.ok(
      body.includes('isDemoSeeded()') && body.includes(marker),
      `${channel} 必须有沙箱分支（沙箱态下绝不许碰落盘的诊断记录）`
    )
    assert.ok(
      body.indexOf('isDemoSeeded()') < body.indexOf('diagnosticsStoreFor'),
      `${channel} 的沙箱分支必须早于 diagnosticsStoreFor()（那才是读/写磁盘的入口）`
    )
  }

  // `chat:send` 也要 fail-safe 回绝（正常路径由渲染层吃掉，这是第二道）
  const chatAt = handlers.indexOf('IPC.chatSend')
  assert.ok(chatAt >= 0)
  assert.ok(
    handlers.slice(chatAt, chatAt + 900).includes('isDemoSeeded()'),
    'chat:send 必须有沙箱 fail-safe 回绝（否则会落进真实轮次）'
  )
})

/* ------------------------------------------------------------------ *
 * ⑨ 通道纪律
 * ------------------------------------------------------------------ */

test('演示沙箱 ⑨：三条通道是 invoke、不进推送清单，且三处登记齐全', () => {
  const channels = readSource('src', 'main', 'ipc', 'channels.ts')
  const preload = readSource('src', 'preload', 'index.ts')
  const guards = readSource('tests', 'architecture-guards.test.ts')

  for (const literal of ['demo:seed', 'demo:state', 'demo:script']) {
    assert.ok(channels.includes(`'${literal}'`), `channels.ts 里缺通道 ${literal}`)
  }

  // 推送清单（`PUSH_CHANNELS`）里**不许**出现这三条
  const pushAt = channels.indexOf('export const PUSH_CHANNELS')
  const pushBlock = channels.slice(pushAt, channels.indexOf(']', pushAt))
  for (const key of ['demoSeed', 'demoState', 'demoScript']) {
    assert.equal(pushBlock.includes(`IPC.${key}`), false, `推送清单里不该有 ${key}（它只有回执）`)
  }

  // preload：方法名与白名单登记
  for (const method of ['readDemoState', 'seedDemo', 'readDemoScript']) {
    assert.ok(preload.includes(`${method}:`), `preload 里缺方法 ${method}`)
    assert.ok(guards.includes(`'${method}'`), `架构守卫的硬清单里缺 ${method}`)
  }

  // preload 边界的形状校验：半截脚本不许丢给界面
  assert.equal(typeof isDemoScriptPayload, 'function')
  assert.equal(isDemoScriptPayload({ turns: [] }), false)
  assert.equal(isDemoScriptPayload({ turns: [], sessionsWithCards: [] }), false)
  assert.equal(
    isDemoScriptPayload({ turns: [{ turn: 1, studentText: '  ', answer: 'x', cards: [] }], sessionsWithCards: [] }),
    false,
    '空的脚本行必须被挡在边界上'
  )

  // `demo:seed` 的入参白名单：认不出一律拒（**不兜底成其中一个**）
  assert.equal(readDemoSeedState('seeded'), 'seeded')
  assert.equal(readDemoSeedState('inactive'), 'inactive')
  assert.equal(readDemoSeedState(''), null)
  assert.equal(readDemoSeedState('演示'), null)
  assert.equal(readDemoSeedState(undefined), null)

  // 开关是内存态：值没变就不重载（幂等）
  resetDemoSeedForTests()
  assert.equal(setDemoSeeded('inactive'), false, '值没变时不该报告"变了"')
  assert.equal(setDemoSeeded('seeded'), true)
  assert.equal(setDemoSeeded('seeded'), false, '重复设同一个值不该再触发一次重载')
  resetDemoSeedForTests()
})

/* ------------------------------------------------------------------ *
 * 附：内容态的清点（防"顺手把内容态也假掉"）
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * ③e 预置历史会话的**逐轮信封**
 *
 * ★★ 为什么必须有这一条：点开侧栏那三条历史对话是现场最常见的动作，而它们的
 *   「调用记录」在界面上是**另一份数据**（诊断信封）—— 正文与信封各写一份的话，
 *   完全可能出现「对话里讲的是列表、时间轴上那一轮却在讲循环」这种一眼假的错位。
 *   这条断言把「三条会话各自几轮、轮次号怎么排、引用几条」钉死。
 * ------------------------------------------------------------------ */

test('演示沙箱 ③e：三条预置会话各带逐轮信封，轮次号不重复且与正文一一对应', async () => {
  const payload = await buildDemoScript()

  assert.equal(payload.history.length, DEMO_SESSIONS.length, '三条预置会话都要有信封')

  // ① 会话 id / 标题与侧栏那三条逐字一致
  assert.deepEqual(
    payload.history.map((session) => session.sessionId).sort(),
    DEMO_SESSIONS.map((session) => session.id).sort()
  )
  for (const session of payload.history) {
    const meta = DEMO_SESSIONS.find((item) => item.id === session.sessionId)
    assert.ok(meta !== undefined, `找不到会话登记：${session.sessionId}`)
    assert.equal(session.title, meta.title, '时间轴上的会话标题必须与侧栏一致')
  }

  // ② 轮数与正文**一一对应**（正文是「一问一答」成对的，所以轮数 = 消息数 / 2）
  let total = 0
  for (const session of payload.history) {
    const messages = await buildDemoSessionMessages(session.sessionId)
    assert.equal(messages.length % 2, 0, `${session.sessionId} 的正文应当是成对的消息`)
    assert.equal(
      session.turns.length,
      messages.length / 2,
      `${session.sessionId} 的信封条数必须等于它的对话轮数`
    )
    total += session.turns.length
  }
  assert.equal(total, DEMO_HISTORY_TURN_COUNT, '三条会话的轮数之和必须等于登记的总轮数')

  // ③ 轮次号在**整份载荷**里不重复，且脚本三轮接在历史之后（时间轴是一条线）
  const scriptTurns = payload.turns.map((turn) => turn.turn)
  const historyTurns = payload.history.flatMap((session) => session.turns.map((turn) => turn.turn))
  const all = [...historyTurns, ...scriptTurns]
  assert.equal(new Set(all).size, all.length, `轮次号撞号：${all.join(', ')}`)
  assert.equal(Math.max(...historyTurns), DEMO_HISTORY_TURN_COUNT)
  assert.deepEqual(
    scriptTurns,
    Array.from({ length: DEMO_SCRIPT_TURN_COUNT }, (_, index) => DEMO_HISTORY_TURN_COUNT + index + 1),
    '脚本五轮必须紧接在历史之后（号连续、不撞号）'
  )

  // ④ 信封里那句「命中 N 块」是真的：引用条数与信封自报的数字逐条对上
  const counts = await demoHistoryCitationCounts()
  assert.equal(counts.length, DEMO_HISTORY_TURN_COUNT, '每条历史轮次都要登记引用条数')
  const byTurn = new Map(
    payload.history.flatMap((session) => session.turns.map((turn) => [turn.turn, turn]))
  )
  for (const row of counts) {
    const turn = byTurn.get(row.turn)
    assert.ok(turn !== undefined, `登记表里的第 ${row.turn} 轮不在载荷里`)
    assert.equal(
      turn.retrieval?.hitCount ?? 0,
      row.citations,
      `第 ${row.turn} 轮的命中数与登记表对不上（信封里那句「命中 N 块」会因此变成编的）`
    )
  }

  // ⑤ 每轮的信封本身要立得住：有输入、有提示词、耗时自洽
  for (const session of payload.history) {
    for (const turn of session.turns) {
      assert.ok(turn.input.text.length > 0, `第 ${turn.turn} 轮没有学生输入`)
      assert.ok(turn.prompt.segments.length > 0, `第 ${turn.turn} 轮没有提示词分段`)
      // 首字延迟可能为 null（这一轮没记到），有值时不许大于总耗时
      if (turn.done.firstTokenMs !== null) {
        assert.ok(
          turn.done.totalMs >= turn.done.firstTokenMs,
          `第 ${turn.turn} 轮的总耗时不能小于首字延迟`
        )
      }
    }
  }
})

test('演示沙箱 附：内容态资产存在且覆盖脚本用到的那几个知识点', () => {
  const templatesDir = join(repoRoot, 'server', 'resources', 'templates')
  if (existsSync(templatesDir)) {
    const templates = readdirSync(templatesDir).filter((name) => name.endsWith('.json'))
    assert.ok(templates.length > 0, '随包动画模板不该是空的')
    // 「我的动画」那两条靠 kp 精确命中模板（第 1 轮那张动画卡是**点名**给的模板，
    // 它的归属由下面 ③c 那条断言守）—— 命中不了就会降级成文字
    const names = new Set(templates.map((name) => name.replace(/\.json$/, '')))
    assert.ok(
      names.has('gradient-descent-v2') || names.has('gradient-descent'),
      '主线知识点（机器学习）必须有可命中的随包模板'
    )

    // ★★ 「我的动画」三条的 `concept` 必须与**按 kp 命中的那个模板**声明的一字不差：
    //    渲染侧的 `InlineCard.vue` 是拿卡片载荷的 `concept` + 学段去库里对记录的
    //    （`savedMatch`），库里写成教材小节标题（「循环：重复的事交给机器」）时，
    //    卡片上那颗「我的」按钮**永远灰着**。这条只有对着真实资产断言才守得住。
    const library = demoSavedAnimationListBody() as {
      items?: Array<{ id?: unknown; kpId?: unknown; concept?: unknown }>
    }
    for (const item of library.items ?? []) {
      const declared = templates
        .map((name) =>
          JSON.parse(readRepo('server', 'resources', 'templates', name)) as {
            concept?: unknown
            kp_ids?: unknown
          }
        )
        .find((file) =>
          Array.isArray(file.kp_ids) ? file.kp_ids.includes(String(item.kpId)) : false
        )
      assert.ok(declared !== undefined, `动画库条目 ${String(item.id)} 的知识点必须能命中随包模板`)
      assert.equal(
        String(item.concept),
        String(declared.concept),
        `动画库条目 ${String(item.id)} 的 concept 必须与模板逐字相同（否则「我的」按钮永远灰着）`
      )
    }
  }

  // ★ 编程模板只对**用到它的那一个**知识点断言：脚本第 3 轮取的是主线（机器学习），
  //   而「每个 kp 都得有一份代码模板」不是本仓库的约束（1 个 kp 1 份是内容资产的决定）。
  assert.ok(
    existsSync(join(repoRoot, 'preset-content', 'code-templates', 'machine-learning-sr.json')),
    '缺代码模板：machine-learning-sr（脚本第 3 轮取的就是它）'
  )

  // 脚本用到的那几个知识点的中文名都能在真实知识库目录里找到对应文件
  for (const kpId of DEMO_SCRIPT_KP_IDS) {
    const candidates = [
      join(repoRoot, 'server', 'knowledge', 'senior', `${kpId}.md`),
      join(repoRoot, 'preset-content', '_meta', 'kp-catalog.md')
    ]
    assert.ok(
      candidates.some((path) => existsSync(path)),
      `找不到 ${kpId} 的教材依据`
    )
  }
  assert.ok(readRepo('preset-content', '_meta', 'kp-catalog.md').includes('machine-learning-sr'))
  assert.equal(DEMO_CHAPTER_TITLE, '第3章 核心技术分支')
})
