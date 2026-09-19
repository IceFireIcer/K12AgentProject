/**
 * 接线冒烟：**主进程的取数层 → 真实 Python sidecar**（真跑，不 mock）。
 *
 * 为什么需要它：`npm test` 里的渲染进程单测用的是**假桥**（证明前端逻辑对），
 * 而 `server/tests` 用的是 TestClient（证明后端逻辑对）。**两者之间那一层**
 * —— `main/wire/data.ts` 的路径拼接、超时、错误归一化 —— 谁都没覆盖到。
 * 路径拼错（`?grade_level=` 写成 `?gradeLevel=`）、超时给错、
 * 把 422 当成 500 处理，这些都只会在**真连一次**的时候才暴露。
 *
 * 跑法（**两处参数都不能省**）：
 *   ```bash
 *   SMOKE_DATA=$(mktemp -d)                       # 一个**非默认**的 data-dir
 *   mkdir -p "$SMOKE_DATA/shared"
 *   cp server/_data/shared/kb.sqlite "$SMOKE_DATA/shared/"   # 学生路由与检索都要 kb
 *   cd server && uv run python -m app.main --port 8799 --token smoke-token --data-dir "$SMOKE_DATA" &
 *   cd desktop && node scripts/wire-smoke.mjs
 *   ```
 * ⚠️ **`--data-dir` 必须传，且必须不是 `server/_data`**：
 *   ① 不传 → `resolve_student_data_root()` 返回 None（有意设计：共享目录不能当学生数据根），
 *      profile / grade / quiz 判分 / 动画托管**一共 7 条**会全红成 503；
 *   ② 传成默认的 `server/_data` → 同样判为「未显式传入」，且真跑会往仓库里写学生目录。
 *   用临时目录 + 拷贝一份 kb，既不污染仓库也能把 21 条全跑绿。
 *
 * ★ 它只读、不改任何数据（重建那一条会被跳过 —— 那是重活且会写库）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DESKTOP = resolve(HERE, '..')

const PORT = Number(process.env.K12_SMOKE_PORT ?? 8799)
const TOKEN = process.env.K12_SMOKE_TOKEN ?? 'smoke-token'
const BASE = `http://127.0.0.1:${PORT}`
const STUDENT = process.env.K12_SMOKE_STUDENT ?? 'student_001'

/** 直接读 `wire/data.ts` 的路径工厂源码，断言函数名还在（路径本身由下面的真请求验证）。 */
function readPathFactories() {
  const source = readFileSync(resolve(DESKTOP, 'src/main/wire/data.ts'), 'utf8')
  // 允许 `export const` / `export function` / `export async function` / `export type`
  const names = [...source.matchAll(/^export (?:const|function|async function|type) (\w+)/gm)].map(
    (m) => m[1]
  )
  return { source, names }
}

const { source, names } = readPathFactories()
const REQUIRED = [
  'profilePath',
  'recommendationPath',
  // ★ 开场引导（主动发起对话）：与推荐是两条端点（前者只在会话为空时有意义）
  'openingPath',
  'gradeSignalsPath',
  'gradeHistoryPath',
  'quizBankPath',
  'quizProgressPath',
  'codeTemplatePath',
  'codeHintPath',
  'animationTemplatesPath',
  'animationHostPath',
  'knowledgePointsPath',
  'requestJson',
  'dataRequests'
]
for (const name of REQUIRED) {
  assert.ok(names.includes(name), `wire/data.ts 必须导出 ${name}`)
}
console.log(`✓ wire/data.ts 导出了 ${REQUIRED.length} 个必需符号`)

/** 带 token 的真请求（与 `bridge/client.ts` 同一手法：只在此处注入鉴权头）。 */
async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'X-Auth-Token': TOKEN,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(20_000)
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // 非 JSON（500 的纯文本）——留给下面按状态码断言
  }
  return { status: response.status, json, text }
}

let passed = 0
let failed = 0

async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`\n对真实 sidecar 发请求：${BASE}（学生 ${STUDENT}）\n`)

/* ── 健康（匿名，不带 token）──────────────────────────────────────────── */
await check('GET /health 匿名可达且回 camelCase', async () => {
  const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok('embedderReady' in body, '出参必须是 camelCase（pydantic alias）')
})

/* ── 画像 / 推荐 / 学段证据 ────────────────────────────────────────────── */
await check('GET /api/students 列出学生；库里没有就建一个（首跑路径）', async () => {
  const listed = await api('/api/students')
  assert.equal(listed.status, 200)
  assert.ok(Array.isArray(listed.json), '必须是数组')
  if (listed.json.some((item) => item.studentId === STUDENT)) return

  // 首跑的机器上没有学生 —— 这正是 `student:get` 通道要处理的路径
  const created = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({ nickname: '同学', gradeLevel: 'primary_high' })
  })
  assert.equal(created.status, 200, `建学生应成功：${created.text}`)
  assert.ok(typeof created.json.studentId === 'string' && created.json.studentId.length > 0)
})

await check('GET /api/profile/{id} 回画像（掌握度数组 + 推荐点）', async () => {
  const { status, json } = await api(`/api/profile/${STUDENT}`)
  assert.equal(status, 200, `画像应可读（先确保学生存在）：${JSON.stringify(json)}`)
  assert.ok(Array.isArray(json.mastery), 'mastery 必须是数组')
  assert.ok(Array.isArray(json.recommendedKpIds), 'recommendedKpIds 必须是数组')
})

await check('GET /api/profile/{id}/recommendation 回 source + items', async () => {
  const { status, json } = await api(`/api/profile/${STUDENT}/recommendation`)
  assert.equal(status, 200)
  assert.ok(typeof json.source === 'string' && json.source.length > 0, 'source 必须有值')
  assert.ok(Array.isArray(json.items), 'items 必须是数组')
})

await check('★★ GET /api/profile/{id}/opening 的开场语与推荐接口**同源**（主动发起对话）', async () => {
  const { status, json } = await api(`/api/profile/${STUDENT}/opening`)
  assert.equal(status, 200, '开场引导必须回 200（推不出内容时也是 200 + 空串，不是 404）')
  // 契约三字段一个都不能少（前端按它们决定「发不发」「有没有动作按钮」）
  assert.deepEqual(
    Object.keys(json).sort(),
    ['kpId', 'source', 'text'],
    `开场引导的字段集合必须恰好是 kpId/source/text，实际：${Object.keys(json).join(', ')}`
  )
  assert.equal(typeof json.text, 'string')
  assert.equal(typeof json.source, 'string')

  // ★★ 最关键的一条：开场语指向的知识点必须与推荐接口第一位**一致** ——
  //    两个端点各推各的 = 界面上一处说「建议学 X」、另一处说「我们从 Y 开始吧」。
  const rec = await api(`/api/profile/${STUDENT}/recommendation`)
  const first = rec.json.items?.[0]
  if (first && json.text) {
    assert.equal(
      json.kpId,
      first.kpId,
      `开场引导指向 ${json.kpId}，而推荐第一位是 ${first.kpId}（两个端点必须同源）`
    )
    // ★ 中文名来自依赖图（裸 kp_id 说明拼接绕过了推荐接口）
    if (first.name) {
      assert.ok(
        json.text.includes(first.name),
        `开场语里必须出现图里解析出的中文名「${first.name}」，实际：${json.text}`
      )
    }
  }
  // ★ 反向对照：没有开场语时**不许**给 kpId（否则前端会渲染一个没有目标的按钮）
  if (!json.text) {
    assert.equal(json.kpId, null, '没有开场语时 kpId 必须是 null')
  }
})

await check('GET /api/grade/signals/{id} 回 currentLevel + signals', async () => {
  const { status, json } = await api(`/api/grade/signals/${STUDENT}`)
  assert.equal(status, 200)
  assert.ok(['primary_low', 'primary_high', 'junior', 'senior'].includes(json.currentLevel))
  assert.ok(Array.isArray(json.signals))
})

await check('GET /api/grade/history/{id} 回 currentLevel + entries', async () => {
  const { status, json } = await api(`/api/grade/history/${STUDENT}`)
  assert.equal(status, 200)
  assert.ok(Array.isArray(json.entries), 'entries 必须是数组')
})

/* ── 闯关（★ 载荷不许带答案）──────────────────────────────────────────── */
await check('GET /api/quiz/progress/{id} 回 levels（阶段 + 分数）', async () => {
  const { status, json } = await api(`/api/quiz/progress/${STUDENT}`)
  assert.equal(status, 200)
  assert.ok(Array.isArray(json.levels), 'levels 必须是数组')
  for (const level of json.levels) {
    assert.ok(['locked', 'learning', 'quizzed', 'mastered'].includes(level.stage), `阶段取值：${level.stage}`)
  }
})

await check('★★ GET /api/quiz/bank/{kp} 的题目**不含 answer**（答案防泄漏）', async () => {
  const { status, json } = await api(
    `/api/quiz/bank/prog-loop-jr?gradeLevel=junior&count=3`
  )
  assert.equal(status, 200)
  assert.ok(Array.isArray(json.questions) && json.questions.length > 0, '至少要有一道题')
  const text = JSON.stringify(json)
  assert.ok(!text.includes('"answer"'), '★ 题库载荷里出现了 answer —— 答案泄漏')
  for (const question of json.questions) {
    assert.ok(typeof question.qid === 'string' && question.qid.length > 0)
    assert.ok(typeof question.stem === 'string' && question.stem.length > 0)
  }
})

await check('判分：真提交一题拿到 correct / feedback / masteryDelta', async () => {
  const bank = await api(`/api/quiz/bank/prog-loop-jr?gradeLevel=junior&count=1`)
  const qid = bank.json.questions[0].qid
  const { status, json } = await api('/api/quiz/grade', {
    method: 'POST',
    body: JSON.stringify({ studentId: STUDENT, qid, answer: '__smoke_wrong__' })
  })
  assert.equal(status, 200, `判分应成功，实际 ${status}：${JSON.stringify(json)}`)
  assert.equal(typeof json.correct, 'boolean')
  assert.ok(typeof json.feedback === 'string' && json.feedback.length > 0, '必须有可读反馈')
  assert.ok(Math.abs(json.masteryDelta) <= 0.2, '★ 掌握度变化必须限幅 ±0.2')
})

/* ── 编程（★ 结构上不存在参考答案；后端不执行代码）────────────────────── */
await check('GET /api/code/templates/{kp} 的模板**没有 solution**', async () => {
  const { status, json } = await api(`/api/code/templates/prog-loop-jr?gradeLevel=junior`)
  assert.equal(status, 200)
  assert.ok(typeof json.scaffold === 'string' && json.scaffold.length > 0, '要有脚手架')
  assert.ok(!('solution' in json), '★ 模板里出现了 solution —— 答案泄漏')
})

await check('GET /api/code/hint/{kp}?level=1 回一级提示（逐级要）', async () => {
  const { status, json } = await api(`/api/code/hint/prog-loop-jr?level=1`)
  assert.equal(status, 200)
  assert.equal(json.level, 1)
  assert.ok(typeof json.hint === 'string' && json.hint.length > 0)
})

await check('POST /api/code/run-hint 只做报错归一，不执行代码', async () => {
  const { status, json } = await api('/api/code/run-hint', {
    method: 'POST',
    body: JSON.stringify({
      studentId: STUDENT,
      kpId: 'prog-loop-jr',
      code: 'print(totle)',
      language: 'python',
      stdout: '',
      stderr: "NameError: name 'totle' is not defined",
      attempt: 1
    })
  })
  assert.equal(status, 200)
  assert.equal(json.ok, false, 'stderr 非空即判不通过')
  assert.ok(typeof json.feedback === 'string' && json.feedback.length > 0, '要给出中文反馈')
})

/* ── 动画（模板 → 渲染 → 一次性托管）─────────────────────────────────── */
await check('GET /api/animation/templates 列模板（含参数定义）', async () => {
  const { status, json } = await api('/api/animation/templates')
  assert.equal(status, 200)
  assert.ok(typeof json.total === 'number' && json.total > 0, '本机应有随包模板')
  assert.ok(Array.isArray(json.available) && json.available.length > 0)
})

await check('POST /api/animation/render 产出**自包含** HTML（断网可跑）', async () => {
  const list = await api('/api/animation/templates')
  const templateId = list.json.available[0]
  const { status, json } = await api('/api/animation/render', {
    method: 'POST',
    body: JSON.stringify({ templateId, gradeLevel: 'junior' })
  })
  assert.equal(status, 200, `渲染应成功，实际 ${status}：${JSON.stringify(json)}`)
  assert.ok(typeof json.html === 'string' && json.html.length > 0, '要有 HTML')
  // ★ 断网演示的硬约束：不许有 CDN 引用
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(json.html), '★ 动画 HTML 里出现了外部地址（断网会白屏）')
  assert.ok(typeof json.fallbackText === 'string' && json.fallbackText.length > 0, '必须有降级文案')
})

await check('POST /api/animation/host/{sid}/{kp} 回一次性 nonce 地址', async () => {
  // 渲染按**知识点**命中模板（`training-inference-jr` → `train-predict`），
  // 托管用同一个 kp —— 与真实调用方的做法一致（渲染什么就托管什么）。
  const rendered = await api('/api/animation/render', {
    method: 'POST',
    body: JSON.stringify({ kpId: 'training-inference-jr', gradeLevel: 'junior' })
  })
  const { status, json } = await api(`/api/animation/host/${STUDENT}/training-inference-jr`, {
    method: 'POST',
    body: JSON.stringify({ html: rendered.json.html, payloadId: 'smoke-payload-1' })
  })
  assert.equal(status, 200, `托管应成功，实际 ${status}：${JSON.stringify(json)}`)
  assert.equal(json.payloadId, 'smoke-payload-1', 'payloadId 必须原样带回（沙箱防串台用）')
  assert.ok(typeof json.url === 'string' && json.url.includes('nonce='), '地址里必须带一次性 nonce')
  assert.equal(json.singleUse, true)
  assert.ok(json.expiresInMs > 0)
})

/* ── 检索（`citation` 事件与「教材原文」抽屉的源头）──────────────────── */
await check('★★ RAG 检索回 hits，且每条都带**节级正文**（原文抽屉的数据源）', async () => {
  const { status, json } = await api('/api/rag/search', {
    method: 'POST',
    body: JSON.stringify({ query: '什么是特征', gradeLevel: 'junior', topK: 3 })
  })
  assert.equal(status, 200)
  assert.ok(Array.isArray(json.hits) && json.hits.length > 0, '要有命中（先确认 kb 已建好）')
  assert.ok(
    ['vector', 'cloud', 'fts', 'outline'].includes(json.degraded),
    `degraded 必须是四档之一，实际 ${json.degraded}`
  )
  for (const hit of json.hits) {
    assert.ok(typeof hit.chunkId === 'string' && hit.chunkId.length > 0)
    assert.ok(['primary_low', 'primary_high', 'junior', 'senior'].includes(hit.gradeLevel))
    // ★ 这两条是「教材原文」抽屉能工作的前提：正文与相关度必须随命中一起回来
    assert.ok(typeof hit.text === 'string' && hit.text.length > 0, '命中必须带节级正文')
    assert.ok(typeof hit.score === 'number', '命中必须带相关度分数')
  }
  // ★ 学段隔离：绝不能命中高于学生的学段
  const order = ['primary_low', 'primary_high', 'junior', 'senior']
  for (const hit of json.hits) {
    assert.ok(
      order.indexOf(hit.gradeLevel) <= order.indexOf('junior'),
      `★ 学段隔离破了：初中生命中了 ${hit.gradeLevel}（${hit.chunkId}）`
    )
  }
  console.log(
    `      命中 ${json.hits.length} 条 · 最高分 ${Math.max(...json.hits.map((h) => h.score)).toFixed(3)} · ` +
      `优先档位 ${json.degraded} · 上下文 ${(json.context ?? '').length} 字`
  )
})

/* ── 教材知识库 ────────────────────────────────────────────────────────── */
await check('GET /api/knowledge/stats 回体检数字（含向量可用性）', async () => {
  const { status, json } = await api('/api/knowledge/stats')
  assert.equal(status, 200)
  assert.ok(json.counts.kp > 0, '知识点数应大于 0')
  assert.ok(json.counts.chunk > 0, '分块数应大于 0')
  assert.equal(typeof json.vecReady, 'boolean')
  console.log(
    `      知识点 ${json.counts.kp} · 分块 ${json.counts.chunk} · 依赖边 ${json.counts.dependencies} · ` +
      `向量 ${json.vecReady ? '可用' : '不可用'} · ${json.userRebuilt ? '用户重建' : '随包资产'}`
  )
})

await check('GET /api/knowledge/points 回知识点清单（教材顺序）', async () => {
  const { status, json } = await api('/api/knowledge/points')
  assert.equal(status, 200)
  assert.ok(json.points.length > 0, '清单不能为空')
  for (const point of json.points) {
    assert.ok(typeof point.kpId === 'string' && point.kpId.length > 0)
    assert.ok(typeof point.name === 'string' && point.name.length > 0, '每个点都要有显示名')
  }
})

await check('非法学段是 422（不是静默回空表）', async () => {
  const { status } = await api('/api/knowledge/points?grade_level=bogus')
  assert.equal(status, 422)
})

await check('★ 缺 token 是 401（鉴权真的在）', async () => {
  const response = await fetch(`${BASE}/api/knowledge/stats`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(response.status, 401)
})

/* ── 重建：**只验拒绝路径**（成功路径会写库且要跑嵌入，属于重活）────────── */
await check('教材导入：格式不对时回 200 + ok:false + 逐条原因（内容问题不是请求非法）', async () => {
  const { status, json } = await api('/api/knowledge/import', {
    method: 'POST',
    body: JSON.stringify({ fileName: 'smoke-bad.md', markdown: 'no front matter' })
  })
  assert.equal(status, 200, '内容问题应当 200（界面要在同一张卡片里列出原因）')
  assert.equal(json.ok, false)
  assert.ok(Array.isArray(json.problems) && json.problems.length > 0, '必须逐条给出原因')
})

/* ── 结果 ──────────────────────────────────────────────────────────────── */
console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exitCode = 1
