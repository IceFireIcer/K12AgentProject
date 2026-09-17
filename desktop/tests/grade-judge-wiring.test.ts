/**
 * ★ 学段**第二层（LLM 判定）**接线测试（票 21）—— 审计结论：`useJudge()` 此前**没有生产调用方**，
 * 于是第二层**永远**报 `no_llm`（即便本机配好了 Key），§10.3 的「第 3 轮触发一次轻量 LLM 判定」
 * 从未真正生效。
 *
 * 这一份盯住「接线之后行为不变（对无 Key 世界） / 有通道时真的用上」：
 *
 *   J1 **模型补全原语**（`createModelCompleter`，三个用途共用）：
 *      无凭证时**同步抛**也要被收敛成可读错误（绝不挂起、绝不冒成未捕获异常）；
 *      `stopReason=error` 与「没有文本」也算失败；成功时只取 `text` 段。
 *   J2 ★ **judge 的组装形状**：用 `runtime.ts` 的同一套零件
 *      （`createModelCompleter` + `buildJudgePrompt` + `parseProposal`）装一个 judge，
 *      第 3 轮触发 → 提议被用上（`layer2 === 'used'`），服务端拿到 `proposal`。
 *   J3 ★ **无 Key 的世界（本机现状）**：judge 抛可读错误 →
 *      扩展标记 `judge_error`、**第一层照常上交**（学段仍能改）、不崩不挂。
 *   J4 **接线守卫**：runtime.ts 装配 judge 时复用了 `buildJudgePrompt` / `parseProposal`
 *      （不另写一份 prompt 或解析），且无 Key 时传 `null`（走 `no_llm`）。
 *
 * 跑法：`npm test`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildJudgePrompt,
  createGradeExtension,
  parseProposal,
  type GradeProposal
} from '../src/main/agent/extensions/grade.ts'
import { createModelCompleter } from '../src/main/agent/safety/review.ts'
import type { GradeLevel } from '../src/shared/ipc-events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HERE, '..')

/* ================================================================== *
 * J1 模型补全原语
 * ================================================================== */

test('J1 补全原语：成功路径只取 text 段，并带上 system prompt 与 maxTokens', async () => {
  const seen: Array<Record<string, unknown>> = []
  const runtime = {
    completeSimple: async (_model: unknown, context: unknown, options: unknown) => {
      seen.push({ context, options })
      return { content: [{ type: 'thinking', text: '想想' }, { type: 'text', text: '{"ok":true}' }], stopReason: 'stop' }
    }
  }
  const complete = createModelCompleter(runtime as never, { fake: 'model' }, { maxTokens: 512, systemPrompt: 'S' })
  const text = await complete({ prompt: 'P', timeoutMs: 1000 })
  assert.equal(text, '{"ok":true}')
  const call = seen[0]
  assert.equal((call.context as { systemPrompt: string }).systemPrompt, 'S')
  assert.equal((call.context as { messages: Array<{ content: string }> }).messages[0].content, 'P')
  assert.equal((call.options as { maxTokens: number }).maxTokens, 512)
  assert.ok((call.options as { signal: AbortSignal }).signal, '必须带超时信号（不能把收尾吊死）')
})

test('J1 补全原语：缺凭证时**同步抛**也要收敛成可读错误（Pi 的真实行为）', async () => {
  const runtime = {
    completeSimple: (): Promise<never> => {
      // ★ 实测：Pi 的 streamSimple/completeSimple 在缺认证时**同步抛**（不是 reject）
      throw new Error('No API key found for deepseek.')
    }
  }
  const complete = createModelCompleter(runtime as never, {}, {})
  await assert.rejects(
    () => complete({ prompt: 'P', timeoutMs: 1000 }),
    /No API key found/,
    '同步抛必须被收敛成 reject（否则调用方拿到的是未捕获异常）'
  )
})

test('J1 补全原语：stopReason=error 与「没有文本」都算失败（绝不当成空回答）', async () => {
  const errorRuntime = {
    completeSimple: async () => ({ stopReason: 'error', errorMessage: '429 限流' })
  }
  await assert.rejects(
    () => createModelCompleter(errorRuntime as never, {}, {})({ prompt: 'P', timeoutMs: 1000 }),
    /429 限流/
  )

  const emptyRuntime = { completeSimple: async () => ({ content: [], stopReason: 'stop' }) }
  await assert.rejects(
    () => createModelCompleter(emptyRuntime as never, {}, {})({ prompt: 'P', timeoutMs: 1000 }),
    /没有返回任何文本/
  )
})

/* ================================================================== *
 * J2 ★ judge 的组装形状（runtime.ts 用的同一套零件）
 * ================================================================== */

/** 与 `runtime.ts` 装配 judge 的方式**逐行对齐**（这是被测的接线形状）。 */
function judgeFromCompleter(complete: (request: { prompt: string; timeoutMs: number }) => Promise<string>) {
  return async ({ turns, currentGrade }: { turns: Array<{ turn: number; text: string }>; currentGrade: GradeLevel }) => {
    const raw = await complete({
      prompt: buildJudgePrompt(turns, currentGrade),
      timeoutMs: 8000
    })
    return parseProposal(raw)
  }
}

test('★ J2 接上通道后，第 3 轮的 LLM 提议被用上（layer2 === used，服务端拿到 proposal）', async () => {
  const submitted: Array<{ turns: Array<{ proposal?: GradeProposal }> }> = []
  let prompts = 0
  const extension = createGradeExtension({
    judge: judgeFromCompleter(async (request) => {
      prompts += 1
      // 断言 prompt 是 grade.ts 的那一份（含四个取值与 JSON 输出要求）
      assert.match(request.prompt, /primary_low/)
      assert.match(request.prompt, /suggestedGrade/)
      return '```json\n{"suggestedGrade":"primary_low","confidence":0.82,"note":"用词像低年级"}\n```'
    }),
    submitter: async (_studentId, body) => {
      submitted.push(body as never)
      return {
        grade: 'primary_low',
        previousGrade: 'primary_high',
        changed: true,
        reason: '第二层提议 + 第一层同向',
        confidence: 0.8,
        turn: 3,
        direction: -1,
        streak: 3,
        cooldownRemainingTurns: 0,
        degraded: null
      }
    },
    fetcher: async () => ({ grade: 'primary_high' } as never),
    sessionProvider: () => ({ studentId: 'student_001', sessionId: 'sess-1', gradeLevel: 'primary_high' as GradeLevel }),
    log: () => {}
  })

  for (const text of ['电脑怎么认图片呀？', '它为什么会认错呢', '那它是不是也要先看很多张图']) {
    extension.observeTurn(text)
  }
  await extension.flush()

  assert.equal(prompts, 1, '第 3 轮触发**一次**轻量 LLM 判定（一个窗口只判一次）')
  assert.equal(extension.snapshot().layer2, 'used', '提议被采纳 → 状态是 used')
  const last = submitted.at(-1)!
  assert.equal(last.turns[0].proposal?.suggestedGrade, 'primary_low')
  assert.equal(last.turns[0].proposal?.confidence, 0.82)
})

/* ================================================================== *
 * J3 ★ 无 Key 的世界：judge 抛错 → judge_error，第一层照常工作
 * ================================================================== */

test('★★ J3 无 Key：judge 抛可读错误 → judge_error，第一层证据照常上交、学段照常能改', async () => {
  const logs: string[] = []
  const submitted: Array<{ turns: Array<{ text: string; proposal?: GradeProposal }> }> = []
  const extension = createGradeExtension({
    // ★ 无 Key 的真实形态：补全器抛「没有 API Key」
    judge: judgeFromCompleter(async () => {
      throw new Error('模型通道未接线：本机没有可用的 API Key')
    }),
    submitter: async (_studentId, body) => {
      submitted.push(body as never)
      // 第一层照常给出判定（服务端把 no proposal 标成 degraded）
      return {
        grade: 'junior',
        previousGrade: 'primary_high',
        changed: true,
        reason: '第一层信号足够',
        confidence: 0.7,
        turn: 3,
        direction: 1,
        streak: 3,
        cooldownRemainingTurns: 0,
        degraded: 'no_llm'
      }
    },
    fetcher: async () => ({ grade: 'primary_high' } as never),
    sessionProvider: () => ({ studentId: 'student_001', sessionId: 'sess-1', gradeLevel: 'primary_high' as GradeLevel }),
    log: (line) => logs.push(line)
  })

  for (const text of ['一', '二', '三']) extension.observeTurn(text)
  await extension.flush()

  assert.equal(extension.snapshot().layer2, 'judge_error', '判定失败必须可见（不是静默 no_llm）')
  assert.equal(submitted.length, 3, '★ 第一层照常上交三轮证据（judge 挂着不影响第一层）')
  assert.equal(submitted.at(-1)!.turns[0].proposal, undefined, '失败时不带脏提议')
  assert.ok(
    logs.some((line) => line.includes('第二层判定失败')),
    '必须留下可查的日志'
  )

  // ★ 「下一轮生效」（grade.ts 的既定语义）：服务端判出的学段先落进 `pendingGrade`……
  assert.equal(extension.snapshot().pendingGrade, 'junior', '第一层判出的学段已就绪（下一轮生效）')
  // ……下一次 `observeTurn` 才交接给 `appliedGrade`（学生无感，没有「切换」事件）
  extension.observeTurn('第四轮')
  await extension.flush()
  assert.equal(
    extension.snapshot().appliedGrade,
    'junior',
    '★ 第一层仍然把学段改了（这就是「无 Key 也能用」——没有 LLM 也不影响学段可动）'
  )
})

test('J3 no key 世界：完全不接线（useJudge(null)）→ no_llm，且第一层照常', async () => {
  const logs: string[] = []
  const extension = createGradeExtension({
    judge: null,
    submitter: async () => ({
      grade: 'junior',
      previousGrade: 'primary_high',
      changed: true,
      reason: '第一层',
      confidence: 0.7,
      turn: 3,
      direction: 1,
      streak: 3,
      cooldownRemainingTurns: 0,
      degraded: 'no_llm'
    }),
    fetcher: async () => ({ grade: 'primary_high' } as never),
    sessionProvider: () => ({ studentId: 'student_001', sessionId: 'sess-1', gradeLevel: 'primary_high' as GradeLevel }),
    log: (line) => logs.push(line)
  })
  for (const text of ['一', '二', '三']) extension.observeTurn(text)
  await extension.flush()
  assert.equal(extension.snapshot().layer2, 'no_llm')
  assert.equal(extension.snapshot().pendingGrade, 'junior', '第一层照常判定（下一轮生效）')
  assert.ok(logs.some((line) => line.includes('no_llm')))
})

/* ================================================================== *
 * J4 接线守卫
 * ================================================================== */

test('★ J4 接线守卫：runtime.ts 用同一套零件装 judge，且无 Key 时传 null', () => {
  const source = readFileSync(join(DESKTOP_ROOT, 'src', 'main', 'agent', 'runtime.ts'), 'utf8')
  const at = source.indexOf('gradeExtension.useJudge(')
  assert.ok(at > 0, 'runtime.ts 必须调用 gradeExtension.useJudge')
  const snippet = source.slice(at, at + 900)

  assert.ok(snippet.includes('buildJudgePrompt('), '必须复用 buildJudgePrompt（不另写一份 prompt）')
  assert.ok(snippet.includes('parseProposal('), '必须复用 parseProposal（不另写一份解析）')
  assert.ok(snippet.includes('lazyComplete('), '判定要走 `lazyComplete`（无 Key 时抛可读错误 → judge_error）')
  assert.match(
    snippet,
    /:\s*null\s*\)/,
    '无凭证/未就绪/探针时必须传 null（走 no_llm，不假装有通道）'
  )
  // 判据必须与补全器的填充判据一致（三处共用同一个「有 Key 吗」口径）
  assert.ok(snippet.includes('credentials.apiKey'), 'judge 的可达性由 apiKey 判定')
  assert.ok(snippet.includes('authReady'), 'judge 的可达性还要过 checkAuth')
  assert.ok(snippet.includes('!useProbe'), '探针（假 Key）不算可用通道')
})
