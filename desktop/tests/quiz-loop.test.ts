/**
 * 票 15 / 20 的**编排层（TS）纯逻辑**测试。
 *
 * 盯住四条不能被「顺手改坏」的红线：
 *
 * 1. ★★ **答案不出后端**：变式题登记时，含答案的那一份只发给后端；
 *    发给前端的载荷结构上就没有 `answer` / `rubric`（用哨兵串断言）；
 * 2. ★ **主观题判分 Prompt 含评分细则 + 示例对照**（票 15 的「防漂移」口径）；
 * 3. ★ **判分结果的解析是严格校验**：认不准的分数返回 `null`，绝不把脏分数送去落库；
 * 4. ★ **无 API Key 时干净降级**：不判分、不抛异常、给出可读文案（挂起是最坏形态）。
 *
 * 这些函数都是纯函数（不 import Pi、不发 HTTP），所以 `node --test` 能直接覆盖。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildSubjectiveGradingPrompt,
  buildVariantPrompt,
  completeViaContext,
  parseSubjectiveScore,
  parseVariantPayload,
  prepareVariants,
  projectProgress,
  readCompletionContext,
  registerVariants,
  RUBRIC_SCAFFOLD,
  SUBJECTIVE_SCORE_STEPS,
  SUBJECTIVE_UNAVAILABLE_TEXT,
  variantQid,
  type PiCompletionContext
} from '../src/main/agent/extensions/quiz.ts'

/** ★ 哨兵：只可能来自题目的标准答案。它一旦出现在**给前端的**载荷里就是泄漏。 */
const SENTINEL_ANSWER = '哨兵标准答案-ZX91-不得出现在前端载荷里'
const SENTINEL_RUBRIC = '哨兵评分细则-ZX92-不得出现在前端载荷里'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quizSourceFile = join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'quiz.ts')

/** 去掉注释，只留可执行代码（与 architecture-guards.test.ts 同一口径）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/* ------------------------------------------------------------------ *
 * 1. ★★ 变式题：登记含答案、展示不含答案
 * ------------------------------------------------------------------ */

test('★ 变式题准备：含答案的那一份给后端，投影后的一份给前端', () => {
  const result = prepareVariants(
    {
      questions: [
        {
          qid: 'q1',
          type: 'blank',
          stem: '1 + 1 = ___',
          answer: SENTINEL_ANSWER,
          explanation: '加法用 + 号'
        }
      ]
    },
    { kpId: 'jr-py-variable', gradeLevel: 'junior', seed: 'seed1' }
  )
  assert.equal(result.ok, true)
  if (!result.ok) return

  // 登记用：**有**答案（后端要判分）
  assert.equal(result.questions.length, 1)
  assert.equal(result.questions[0].referenceAnswer, SENTINEL_ANSWER)

  // ★ 投影后（下发给前端的形态）：所有值里都不许出现哨兵
  const projected = JSON.stringify(
    result.questions.map((q) => ({
      qid: q.qid,
      kpId: q.kpId,
      type: q.type,
      stem: q.stem,
      options: q.options,
      explanation: q.explanation
    }))
  )
  assert.ok(!projected.includes(SENTINEL_ANSWER), '★ 哨兵答案出现在投影结果里')
})

test('★ 主观题的评分细则同样不出后端（只进 rubricCache 与登记请求）', () => {
  const result = prepareVariants(
    {
      questions: [
        {
          qid: 'q1',
          type: 'blank',
          stem: '说说什么是变量',
          answer: '给数据起名字',
          rubric: SENTINEL_RUBRIC,
          explanation: '开放题'
        }
      ]
    },
    { kpId: 'jr-py-variable', gradeLevel: 'junior', seed: 'seed2' }
  )
  assert.equal(result.ok, true)
  if (!result.ok) return

  // 细则给后端与判分用
  assert.equal(result.questions[0].rubric, SENTINEL_RUBRIC)
  assert.equal(result.subjective.length, 1)
  assert.equal(result.subjective[0].rubric, SENTINEL_RUBRIC)
  assert.equal(result.subjective[0].answer, '给数据起名字')
})

test('★ qid 由本侧统一生成（带随机段），模型给的 qid 不进载荷', () => {
  const result = prepareVariants(
    { questions: [{ qid: 'q1', type: 'blank', stem: 'x', answer: '2' }] },
    { kpId: 'jr-py-loop', gradeLevel: 'junior', seed: 'abc123' }
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const qid = String(result.questions[0].qid)
  assert.ok(qid.startsWith('gen-jr-py-loop-abc123-'), `qid 形状不对：${qid}`)
  assert.ok(!qid.includes('q1'), '模型给的 qid 不该原样进载荷（会互相撞）')
})

test('变式题 qid 形状稳定且可读', () => {
  assert.equal(variantQid('jr-py-variable', 0, 'ab'), 'gen-jr-py-variable-ab-1')
  // 非法字符被清掉（qid 要能当 URL 段与 JSON 键用）
  assert.equal(variantQid('a/b c', 1, 'ab'), 'gen-abc-ab-2')
})

test('变式题校验：没有题 / 没有答案 / 题型认不出都拒', () => {
  const bad = [
    prepareVariants({}, { kpId: 'k', gradeLevel: 'junior' }),
    prepareVariants({ questions: [] }, { kpId: 'k', gradeLevel: 'junior' }),
    prepareVariants(
      { questions: [{ qid: 'a', type: 'blank', stem: 'x' }] },
      { kpId: 'k', gradeLevel: 'junior' }
    ),
    prepareVariants(
      { questions: [{ qid: 'a', type: '排序题', stem: 'x', answer: '2' }] },
      { kpId: 'k', gradeLevel: 'junior' }
    ),
    prepareVariants(
      { questions: [{ qid: 'a', type: 'choice', stem: 'x', answer: '2', options: ['只有一个'] }] },
      { kpId: 'k', gradeLevel: 'junior' }
    )
  ]
  for (const [index, item] of bad.entries()) {
    assert.equal(item.ok, false, `第 ${index + 1} 个用例应当被拒`)
    if (!item.ok) assert.ok(item.reason.length > 0, '拒绝时必须给可读原因')
  }
})

test('变式题校验：kpId 与请求不一致时拒（否则答案会登记到错的关卡上）', () => {
  const result = prepareVariants(
    { questions: [{ qid: 'a', type: 'blank', stem: 'x', answer: '2', kpId: '别的知识点' }] },
    { kpId: 'jr-py-loop', gradeLevel: 'junior' }
  )
  assert.equal(result.ok, false)
})

test('变式题校验：超过上限时截断到上限（不 silently 全收）', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    qid: `q${i}`,
    type: 'blank',
    stem: `题 ${i}`,
    answer: '2'
  }))
  const result = prepareVariants(
    { questions: many },
    { kpId: 'kp', gradeLevel: 'junior', maxQuestions: 3 }
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.questions.length, 3)
})

/* ------------------------------------------------------------------ *
 * 2. ★ 主观题判分 Prompt：评分细则 + 示例对照
 * ------------------------------------------------------------------ */

test('★ 判分 Prompt 含：学段、题干、本题要点、四档细则、示例对照、输出格式', () => {
  const prompt = buildSubjectiveGradingPrompt({
    gradeLevel: 'junior',
    stem: '说说什么是变量',
    rubric: '要点一：给数据起名字；要点二：值可以变',
    answer: '就是一个盒子，可以往里放东西'
  })
  // 题干与要点
  assert.ok(prompt.includes('说说什么是变量'))
  assert.ok(prompt.includes('要点一：给数据起名字'))
  assert.ok(prompt.includes('就是一个盒子'))
  // 学段（语气/难度要贴合）
  assert.ok(prompt.includes('初中'), 'Prompt 里应写明学段')
  // ★ 四档 + 示例对照（票 15：「prompt 内含评分细则 + 示例对照」）
  assert.ok(prompt.includes(RUBRIC_SCAFFOLD), 'Prompt 应含固定的评审骨架（防漂移）')
  for (const step of SUBJECTIVE_SCORE_STEPS) {
    assert.ok(prompt.includes(String(step)), `细则里应含档位 ${step}`)
  }
  assert.ok(prompt.includes('示例对照'), '应含示例对照（抽象档位会让模型把两档判成同一档）')
  // 输出格式必须是一行 JSON
  assert.ok(prompt.includes('{"score"'), '应给出明确的输出格式')
  assert.ok(prompt.includes('不要代码块'), '应明确要求不要包代码块')
})

test('★ 判分 Prompt 不注入对话历史（判一道题不需要上一轮聊了什么）', () => {
  const prompt = buildSubjectiveGradingPrompt({
    gradeLevel: 'primary_low',
    stem: '小问题',
    rubric: '要点',
    answer: '作答'
  })
  // 只有四段内容；不该出现「对话」「历史」「上一轮」这类上下文注入
  assert.ok(!/对话历史|上一轮|历史消息/.test(prompt), '不该注入对话历史')
})

test('变式题生成 Prompt 写明学段，并限定题型与开放题规则', () => {
  const prompt = buildVariantPrompt({ kpId: 'jr-py-variable', gradeLevel: 'junior', count: 3 })
  assert.ok(prompt.includes('jr-py-variable'))
  assert.ok(prompt.includes('初中'))
  assert.ok(prompt.includes('3 道'))
  for (const kind of ['choice', 'blank', 'code_blank']) {
    assert.ok(prompt.includes(kind), `应列出合法题型 ${kind}`)
  }
  assert.ok(prompt.includes('rubric'), '应说明开放题要额外给评分要点')
  // 重试时带上上次的失败原因（模型才知道要改什么）
  const retry = buildVariantPrompt({
    kpId: 'kp',
    gradeLevel: 'junior',
    count: 1,
    previousError: '输出不是合法 JSON'
  })
  assert.ok(retry.includes('输出不是合法 JSON'))
})

/* ------------------------------------------------------------------ *
 * 3. ★ 判分结果的解析：严格校验
 * ------------------------------------------------------------------ */

test('★ 主观题分数解析：合法输出通过，并吸附到最近的合法档位', () => {
  const ok = parseSubjectiveScore('{"score": 0.8, "feedback": "说得清楚"}')
  assert.deepEqual(ok, { score: 0.8, feedback: '说得清楚' })

  // 模型给 0.79 这种「就近」值：吸附到 0.8（而不是判失败 —— 否则一半判分白跑）
  assert.equal(parseSubjectiveScore('{"score": 0.79, "feedback": "x"}')?.score, 0.8)
  assert.equal(parseSubjectiveScore('{"score": 0.11, "feedback": "x"}')?.score, 0.2)
})

test('★ 主观题分数解析：剥掉 ```json 代码块也能读', () => {
  const wrapped = parseSubjectiveScore('好的，结果如下：\n```json\n{"score": 1, "feedback": "很好"}\n```')
  assert.deepEqual(wrapped, { score: 1, feedback: '很好' })
})

test('★ 主观题分数解析：认不出就返回 null（绝不把脏分数送去落库）', () => {
  const bad = [
    '',
    '模型说了一堆话但没有 JSON',
    '{"score": "很高"}',
    '{"score": null}',
    '{"feedback": "没有分数"}',
    '{"score": NaN}',
    '不是 JSON'
  ]
  for (const raw of bad) {
    assert.equal(parseSubjectiveScore(raw), null, `不该接受：${raw}`)
  }
})

test('主观题分数解析：分数被夹在合法档位集合内', () => {
  const snapped = parseSubjectiveScore('{"score": 5, "feedback": "x"}')
  assert.equal(snapped?.score, 1, '越界值应吸附到最接近的合法档（1.0）')
  assert.ok(
    SUBJECTIVE_SCORE_STEPS.includes(snapped!.score as (typeof SUBJECTIVE_SCORE_STEPS)[number])
  )
})

test('生成结果解析：剥代码块 / 认不出返回 null', () => {
  assert.deepEqual(parseVariantPayload('```json\n{"questions":[]}\n```'), { questions: [] })
  assert.equal(parseVariantPayload('not json at all'), null)
  assert.equal(parseVariantPayload(''), null)
})

/* ------------------------------------------------------------------ *
 * 4. ★ 无 API Key：干净降级
 * ------------------------------------------------------------------ */

test('★ 无 ctx（无 API Key 世界）：模型调用抛可读错误，而不是挂起', async () => {
  await assert.rejects(
    () => completeViaContext(undefined, { prompt: '任意' }),
    /没有可用的模型|未设置 API Key|没有提供/
  )
})

test('★ 无凭证时提前失败（不去发请求）', async () => {
  let called = false
  const context: PiCompletionContext = {
    model: { id: 'deepseek-chat' },
    modelRegistry: {
      hasConfiguredAuth: () => false,
      complete: async () => {
        called = true
        return { content: [] }
      }
    }
  }
  await assert.rejects(() => completeViaContext(context, { prompt: 'x' }), /未设置 API Key/)
  assert.equal(called, false, '没有凭证时不该真的发出请求')
})

test('★ 有凭证时走 ctx 的模型，并原样取出文本', async () => {
  const context: PiCompletionContext = {
    model: { id: 'deepseek-chat' },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async (_model, body) => {
        // 送进去的 Prompt 就是判分 Prompt 本身
        assert.ok(body.messages[0].content[0].text.includes('评分细则'))
        return { content: [{ type: 'text', text: '{"score":0.5,"feedback":"部分正确"}' }] }
      }
    }
  }
  const text = await completeViaContext(context, { prompt: '评分细则：要点' })
  assert.deepEqual(parseSubjectiveScore(text), { score: 0.5, feedback: '部分正确' })
})

test('无 Key 时的降级文案可读，且明确说「不判分」', () => {
  assert.ok(SUBJECTIVE_UNAVAILABLE_TEXT.includes('API Key'))
  assert.ok(SUBJECTIVE_UNAVAILABLE_TEXT.includes('不给你判分'), '必须明说不判（不瞎判）')
  assert.ok(!/Error|error|undefined/.test(SUBJECTIVE_UNAVAILABLE_TEXT), '不该出现英文错误串')
})

test('readCompletionContext：认不出返回 undefined（不猜）', () => {
  assert.equal(readCompletionContext(undefined), undefined)
  assert.equal(readCompletionContext(null), undefined)
  assert.equal(readCompletionContext('ctx'), undefined)
  assert.equal(readCompletionContext({}), undefined)
  assert.equal(readCompletionContext({ model: {} }), undefined, '缺 modelRegistry 也算认不出')
  const ok = readCompletionContext({ model: { id: 'm' }, modelRegistry: { complete: () => {} } })
  assert.ok(ok, '两个字段都在时应认出')
})

/* ------------------------------------------------------------------ *
 * 5. ★ 登记出口：答案发后端、出参不含答案
 * ------------------------------------------------------------------ */

test('★ registerVariants 只走 bridge/client.ts（token 注入的唯一出口）', () => {
  // ★ 这条以前是**空转**：测试体只有 `assert.equal(typeof registerVariants, 'function')`，
  //   注释里那句「真正的 HTTP 断言在 verify-ui 与架构守卫里」也不成立 ——
  //   `grep -rn "registerVariants|api/quiz/variants" desktop/scripts/verify-ui.mjs` → 0 命中，
  //   而架构守卫 G5 只扫 `src/main/**` 里有没有 fetch，证明不了这条路径的 URL/头正确。
  //   现在改成与同类守卫一致的**两条真断言**：
  //     ① 本模块不自己拼 URL/不碰 fetch（token 只能由 client.ts 注入）；
  //     ② 这个函数确实经 `bridge/client.ts` 发请求，且发的是那个冻结路径。
  const code = stripComments(readSource(quizSourceFile))

  assert.ok(
    !/\bfetch\s*\(/.test(code),
    'quiz.ts 不得自己调 fetch —— 那会绕过 bridge/client.ts 的 token 注入与唯一出口纪律'
  )
  assert.ok(
    !/127\.0\.0\.1|localhost|https?:\/\//.test(code),
    'quiz.ts 不得出现主机名/协议 —— 端点由 bridge/client.ts 的握手结果注入'
  )
  assert.ok(
    /await\s+import\(\s*['"][^'"]*bridge\/client\.ts['"]\s*\)/.test(code),
    'registerVariants 必须经 `bridge/client.ts`（token 注入的唯一出口）'
  )

  // ② 发出去的路径必须是冻结的那个（这条是 verify-ui 与架构守卫都没覆盖的那一段）
  const at = code.indexOf('export async function registerVariants')
  assert.ok(at > 0, 'quiz.ts 必须有 registerVariants')
  const snippet = code.slice(at, code.indexOf('\nexport ', at + 10) > 0 ? code.indexOf('\nexport ', at + 10) : undefined)
  assert.ok(
    snippet.includes('/api/quiz/variants?student_id='),
    `registerVariants 必须发 POST /api/quiz/variants?student_id=…（实际片段：${snippet.slice(0, 200)}）`
  )
  assert.ok(
    /method:\s*'POST'/.test(snippet),
    'registerVariants 必须是 POST（题库登记是写操作）'
  )
  assert.ok(
    /Content-Type['"]?\s*:\s*['"]application\/json['"]/.test(snippet),
    'registerVariants 必须声明 JSON 内容类型（否则 FastAPI 收不到结构体）'
  )
  // ★ 而且它真的把函数导出出去了（空转形态的另一半：函数存在但没被任何地方用）
  assert.equal(typeof registerVariants, 'function')
})

/** 读源码（helper：与 `read` 分开命名，避免和上面导入的纯函数混淆）。 */
function readSource(file: string): string {
  return readFileSync(file, 'utf8')
}

/* ------------------------------------------------------------------ *
 * 6. 闯关进度投影（前端只读后端结果）
 * ------------------------------------------------------------------ */

test('★ 进度投影：只认四个字段，认不出的关卡整关丢掉', () => {
  const projected = projectProgress({
    studentId: 'student_001',
    seeded: 3,
    levels: [
      { kpId: 'jr-py-variable', stage: 'mastered', badge: '精通-4', mastery: 0.6, extra: '丢掉' },
      { kpId: 'jr-py-loop', stage: 'learning', badge: null, mastery: 0 },
      { stage: 'locked' }, // 没有 kpId → 丢掉
      { kpId: 'no-stage', mastery: 0.1 }, // 没有 stage → 丢掉
      'garbage'
    ]
  })
  assert.ok(projected)
  assert.equal(projected!.levels.length, 2, '认不出的关卡应整关丢掉')
  assert.deepEqual(
    Object.keys(projected!.levels[0]),
    ['kpId', 'stage', 'badge', 'mastery'],
    '投影只保留白名单字段（多余字段不带出去）'
  )
  assert.equal(projected!.progress.done, 1, '已通过关数按 stage 数')
  assert.equal(projected!.progress.total, 2)
})

test('进度投影：空/脏载荷返回 null（调用方据此不渲染进度块）', () => {
  assert.equal(projectProgress(null), null)
  assert.equal(projectProgress({}), null)
  assert.equal(projectProgress({ levels: [] }), null)
  assert.equal(projectProgress({ levels: ['全是垃圾'] }), null)
})

test('★ 进度投影不缓存、每次调用都重新计算（票 20「不落第二份副本」）', () => {
  const first = projectProgress({
    levels: [{ kpId: 'a', stage: 'learning', badge: null, mastery: 0 }]
  })
  const second = projectProgress({
    levels: [
      { kpId: 'a', stage: 'mastered', badge: '大师-3', mastery: 1 },
      { kpId: 'b', stage: 'learning', badge: null, mastery: 0 }
    ]
  })
  assert.equal(first!.progress.done, 0)
  assert.equal(second!.progress.done, 1, '第二次必须反映新状态（缓存了就会停在旧值）')
  assert.equal(second!.levels.length, 2)
})
