/**
 * 判分失败的文案与空 qid 守卫（2026-10-01 真机缺陷 D-134）。
 *
 * 用户截图报的现象：「明明有题目却显示没有」—— 提交按钮下面那行红字写着
 * 「这一关还没有题目。换一关试试，或者先让智团团讲讲这个知识点。」，
 * 而屏幕上摆着第 4 / 20 题。
 *
 * 根因两条，都在这里钉住：
 *   ① 判分失败沿用了**取题**（quiz）那一句：取题失败该换关，判分失败该重试这一题。
 *   ② `submit()` 没有挡空 qid —— 列表在自动追加生成题时重建，那一瞬间提交会带着空 qid
 *      打到后端，必然 404（而 404 又被翻成上面那句）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const studentFacing = readFileSync('src/renderer/src/api/student-facing.ts', 'utf8')
const quizStore = readFileSync('src/renderer/src/stores/quiz.ts', 'utf8')

test('守卫：判分失败有**自己的** topic，且那句话不说「这一关还没有题目」', () => {
  assert.match(
    studentFacing,
    /\| 'grade'/,
    'student-facing 必须有一个独立的 grade topic（判分与取题是两件事）'
  )
  const line = studentFacing.split('\n').find((l) => /^\s*grade:/.test(l)) ?? ''
  assert.ok(line.length > 0, 'grade 必须有兜底句')
  assert.ok(
    !line.includes('还没有题目'),
    '★ 判分失败的句子**不许**说「这一关还没有题目」：学生明明在答题，那句话只会让他以为关卡空了'
  )
  assert.ok(
    line.includes('提交这题') || line.includes('再试'),
    '判分失败的句子要给出**这一题**的下一步（重试），而不是「换一关」'
  )
})

test('守卫：判分失败的调用点用的是 grade，不是 quiz', () => {
  assert.match(
    quizStore,
    /topic: 'grade'/,
    'stores/quiz.ts 的判分失败必须走 grade topic'
  )
  assert.doesNotMatch(
    quizStore,
    /error: toStudentFacingMessage\(result\.message, \{ topic: 'quiz' \}\)/,
    '判分失败不得再套取题那一句（曾被真机截图抓到）'
  )
})

test('守卫：没拿到 qid 就不发判分请求（列表重建的竞态）', () => {
  assert.match(
    quizStore,
    /if \(qid\.trim\(\) === ''\) return/,
    '★ submit() 必须在任何 bridge 调用之前挡掉空 qid —— 否则必然 404，还会把「这关没题」摆到学生眼前'
  )
})