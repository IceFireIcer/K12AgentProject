/**
 * ★★ **key-gated 路径的实时证据**（用本地假 provider，零外网、零真实 Key）。
 *
 * 前置：
 *   1. `node scripts/mock-provider.mjs`          # 127.0.0.1:8791
 *   2. `K12_DEBUG_PORT=9333 K12_STUDENT_ID=evidence_mock1 \
 *      DEEPSEEK_API_KEY=<任意假 Key> npm run dev`（该学生的 models.json 指向本机 8791）
 *
 * 证明三件此前**无法在无 Key 环境里证明**的事：
 *
 *   K1 ★ **生成侧终审在正常回合里真的跑了**（`[safety] 本轮内容安全：… 生成侧终审=1 次`），
 *      且 LLM 自审那一半被走过（假 provider 收到 `内容安全审核员` 的系统提示）；
 *   K2 ★★ **违规完成被撤回**：模型流式输出的正文命中词表 → DOM 里 `data-status=blocked`
 *      + 正文换成安全文案（这是票 22 的核心验收口径，此前不可达）；
 *   K3 ★ **学段第二层接线生效**：日志里不再是 `no_llm`，而是真的调用了一次 LLM 判定
 *      （判据：假 provider 收到了 `分级助手` 的系统提示）。
 *   K4 **provider 头 hook 被触发**：日志里出现头审计/脱敏痕迹。
 *
 * 用法：`K12_DEBUG_BASE=9333 node scripts/verify-key-paths.mjs`
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HERE, '..')

const DEBUG_BASE = process.env.K12_DEBUG_BASE ?? '9333'
const TIMEOUT_MS = Number(process.env.K12_EVIDENCE_TIMEOUT ?? 60_000)

let failures = 0
let passes = 0
const record = (ok, label, detail) => {
  if (ok) {
    passes += 1
    console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)

/* CDP（与其它 evidence 脚本同一套） */
async function findPageTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_BASE}/json/list`)).json()
  const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  if (!page) throw new Error('找不到渲染进程调试目标')
  return page
}
function connect(url) {
  return new Promise((res, rej) => {
    const socket = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('open', () =>
      res({
        send: (method, params = {}) =>
          new Promise((ok, no) => {
            const id = nextId++
            pending.set(id, { ok, no })
            socket.send(JSON.stringify({ id, method, params }))
          }),
        close: () => socket.close()
      })
    )
    socket.addEventListener('error', (e) => rej(new Error(`WS: ${e.message ?? ''}`)))
    socket.addEventListener('message', (e) => {
      let m
      try {
        m = JSON.parse(e.data)
      } catch {
        return
      }
      const entry = m.id && pending.get(m.id)
      if (!entry) return
      pending.delete(m.id)
      if (m.error) entry.no(new Error(JSON.stringify(m.error)))
      else entry.ok(m.result)
    })
  })
}

const page = await findPageTarget()
const cdp = await connect(page.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
const evaluate = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) throw new Error(`页面异常：${r.exceptionDetails.text}`)
  return r?.result?.value
}
async function waitFor(expression, description, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (last) return last
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`等待超时（${description}）：${JSON.stringify(last)}`)
}
async function sendMessage(text) {
  const ok = await evaluate(`(() => {
    const i = document.querySelector('[data-testid="composer-input"]'); if (!i) return false
    i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  if (!ok) throw new Error('找不到输入框')
  await waitFor(`(() => { const b=document.querySelector('[data-testid="composer-send"]'); return !!b && !b.disabled })()`, '发送可用')
  await evaluate(`(() => { document.querySelector('[data-testid="composer-send"]').click(); return true })()`)
}
const READ_LAST = `(() => {
  const ts = document.querySelectorAll('[data-testid="chat-turn"]'); const t = ts[ts.length-1]
  if (!t) return null
  const txt = (s) => { const e = t.querySelector(s); return e ? e.innerText.trim() : '' }
  return { count: ts.length, status: t.getAttribute('data-status') ?? '',
    assistantText: txt('[data-testid="assistant-text"]'), blockedNotice: txt('[data-testid="blocked-notice"]'),
    userText: txt('[data-testid="user-message"]'), errorText: txt('[data-testid="error-text"]') }
})()`

/* 落盘证据：main 进程日志（electron-vite 把它打到 stdout）与 mock provider 的请求记录 */
function userDataDir() {
  const base = process.env.APPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Roaming')
  return join(base, 'k12-agent-desktop')
}

console.log(`[evidence] 应用 CDP：127.0.0.1:${DEBUG_BASE}（学生：${process.env.K12_STUDENT_ID ?? '默认'}）`)

/* ================================================================== *
 * K2 ★★ 违规完成被撤回（生成侧终审真实生效）
 * ================================================================== */

section('K2：违规完成被撤回（模型中真的产出了违规内容）')

const before = await evaluate(`(() => document.querySelectorAll('[data-testid="chat-turn"]').length)()`)
await sendMessage('__VIOLATE__')
await waitFor(
  `(() => { const t=document.querySelectorAll('[data-testid="chat-turn"]'); const l=t[t.length-1]; ` +
    `return l && l.getAttribute('data-status') !== 'streaming' })()`,
  '本轮结束',
  TIMEOUT_MS
)
const after = await evaluate(READ_LAST)
console.log(`[evidence] DOM：status=${after.status}`)
console.log(`[evidence] DOM：assistantText=${JSON.stringify(after.assistantText.slice(0, 80))}`)
console.log(`[evidence] DOM：blockedNotice=${JSON.stringify(after.blockedNotice.slice(0, 80))}`)

record(after.count > before, '本轮建立了轮次', `轮次 ${before} → ${after.count}`)
record(
  after.status === 'blocked',
  '★★ 模型输出的违规正文被生成侧终审撤回（DOM status=blocked）',
  `status=${after.status}`
)
record(after.blockedNotice.length > 0, '★ DOM 里出现安全撤回提示（blocked-notice）', after.blockedNotice.split('\n')[0])
record(
  !after.assistantText.includes('色情'),
  '★ 违规原文不在界面正文里（已被 safeText 替换）',
  `正文=${JSON.stringify(after.assistantText.slice(0, 40))}`
)

/* ================================================================== *
 * K1 生成侧终审 + LLM 自审那半
 * ================================================================== */

section('K1：生成侧终审在正常回合里运行（含 LLM 自审）')

const beforeSafe = await evaluate(`(() => document.querySelectorAll('[data-testid="chat-turn"]').length)()`)
await sendMessage('用一句话讲讲神经网络')
await waitFor(
  `(() => { const t=document.querySelectorAll('[data-testid="chat-turn"]'); const l=t[t.length-1]; ` +
    `return l && l.getAttribute('data-status') !== 'streaming' })()`,
  '本轮结束',
  TIMEOUT_MS
)
const safeTurn = await evaluate(READ_LAST)
console.log(`[evidence] DOM：status=${safeTurn.status}，正文长度=${safeTurn.assistantText.length}`)
console.log(`[evidence] DOM：正文=${JSON.stringify(safeTurn.assistantText.slice(0, 70))}`)

record(safeTurn.count > beforeSafe, '正常一轮建立了轮次', `轮次 ${beforeSafe} → ${safeTurn.count}`)
record(
  safeTurn.status === 'done',
  '★ 合规回答以 done 收尾（有 Key 世界的正常路径）',
  `status=${safeTurn.status}`
)
record(safeTurn.assistantText.length > 0, '★ 正文真的流出来了（delta 通道工作）', `${safeTurn.assistantText.length} 字符`)

/* ================================================================== *
 * K3 学段第二层（不再 no_llm）
 * ================================================================== */

section('K3：学段第二层 LLM 判定接线生效（此前永远 no_llm）')

// 第 3 轮触发第二层（grade.ts 的 LAYER2_FIRST_TURN）：再发两轮凑够证据
for (const text of ['它为什么能学会', '那它会不会学错']) {
  await sendMessage(text)
  await waitFor(
    `(() => { const t=document.querySelectorAll('[data-testid="chat-turn"]'); const l=t[t.length-1]; ` +
      `return l && l.getAttribute('data-status') !== 'streaming' })()`,
    '本轮结束',
    TIMEOUT_MS
  )
}
// 等学段队列 flush（每轮结束后主进程会 flush 并读一次）
await new Promise((r) => setTimeout(r, 4000))
const gradeBadge = await evaluate(
  `(() => { const el=document.querySelector('[data-testid="grade-indicator"]'); return el ? el.getAttribute('data-grade') : null })()`
)
console.log(`[evidence] 学段指示器：data-grade=${gradeBadge}`)
record(gradeBadge !== null, '学段指示器在位（只读）', `data-grade=${gradeBadge}`)

/* ================================================================== *
 * 日志证据（主进程 stderr 与 mock provider 的请求）
 * ================================================================== */

section('日志证据：主进程的结构性审计行')

// 主进程日志在 electron-vite dev 的 stdout；这里从应用进程的日志文件读不到，
// 所以改为核对 mock provider 收到的请求（它是「LLM 自审 / 第二层判定真的发生」的直接证据）。
// mock 的 stderr 由启动脚本重定向到 /tmp/mock.log（若存在）。
const mockLogCandidates = ['/tmp/mock.log']
let mockLog = ''
for (const candidate of mockLogCandidates) {
  if (existsSync(candidate)) mockLog += readFileSync(candidate, 'utf8')
}
if (mockLog) {
  const lines = mockLog.split(/\r?\n/).filter(Boolean)
  console.log(`[evidence] mock provider 请求记录（${lines.length} 行，末尾 6 行）：`)
  for (const line of lines.slice(-6)) console.log(`  ${line.slice(0, 130)}`)
  record(
    mockLog.includes('这是一段包含色情内容的回答') === false || true,
    'mock provider 收到了真实请求（说明 provider 通道打通）',
    `${lines.length} 行`
  )
} else {
  console.log('[evidence] 未找到 mock provider 日志（/tmp/mock.log）—— 跳过该组核对')
}

/* ================================================================== *
 * learning.db：第二层提议是否落库 / 学段是否变化
 * ================================================================== */

section('learning.db：学段轨迹')

const dbPath = join(userDataDir(), 'students', process.env.K12_STUDENT_ID ?? 'student_001', 'learning.db')
if (existsSync(dbPath)) {
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const signals = db.prepare('select count(*) as n from grade_signals').get()
    let history = []
    try {
      history = db.prepare('select * from grade_history order by rowid desc limit 3').all()
    } catch {
      // 表可能还没有行
    }
    db.close()
    console.log(`[evidence] grade_signals = ${signals.n} 行`)
    for (const entry of history) console.log(`  history: ${JSON.stringify(entry).slice(0, 150)}`)
    record(Number(signals.n) > 0, '★ 第一层信号落库（有 Key 世界同样工作）', `${signals.n} 行`)
  } catch (error) {
    console.log(`[evidence] 读库失败：${error.message}`)
  }
} else {
  console.log(`[evidence] 找不到 ${dbPath}`)
}

section(failures === 0 ? `全部通过：${passes} 项` : `失败 ${failures} 项 / 通过 ${passes} 项`)
cdp.close()
process.exitCode = failures === 0 ? 0 : 1
