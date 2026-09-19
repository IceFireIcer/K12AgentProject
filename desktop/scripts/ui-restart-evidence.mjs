// ★ 重启后 UI 证据：从**真实 sidecar** 拉进度 → 注入真实形状的 payload → 读真实 DOM。
// 跑法：node scripts/ui-restart-evidence.mjs <sidecarPort> <token>
const [port, token] = process.argv.slice(2)
if (!port || !token) {
  console.error('用法: node ui-restart-evidence.mjs <port> <token>')
  process.exit(2)
}
const STUDENT = process.env.K12_EVIDENCE_STUDENT ?? 'student_gate_d_fresh'
// ★ CDP 端口读 `K12_DEBUG_BASE`（与 verify-ui.mjs 同一口径，默认 9333）——
//   写死端口会让本脚本只在作者的启动参数下可跑。
const DEBUG_BASE = process.env.K12_DEBUG_BASE ?? '9333'

const page = (await (await fetch(`http://127.0.0.1:${DEBUG_BASE}/json/list`)).json()).find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) =>
  new Promise((res) => {
    const my = ++id
    pending.set(my, res)
    ws.send(JSON.stringify({ id: my, method, params }))
  })
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}

// 从**真实 sidecar** 读进度（新进程、新 token —— 这就是「重启后」）
const raw = await (
  await fetch(`http://127.0.0.1:${port}/api/quiz/progress/${STUDENT}`, {
    headers: { 'X-Auth-Token': token }
  })
).json()
const done = raw.levels.filter((l) => ['quizzed', 'mastered'].includes(l.stage)).length
console.log('真实 sidecar（重启后的新进程）进度：', JSON.stringify({
  studentId: raw.studentId,
  总关数: raw.levels.length,
  已通过: done,
  非锁定关卡: raw.levels.filter((l) => l.stage !== 'locked').map((l) => `${l.kpId}=${l.stage}`),
  徽章: raw.levels.filter((l) => l.badge).map((l) => `${l.kpId}:${l.badge}`)
}, null, 1))

const payload = {
  kpId: 'ai-definition-pl',
  source: 'generated',
  tool: 'submit_quiz',
  kind: 'quiz',
  qid: 'c6',
  correct: true,
  scoredBy: 'llm',
  feedback: '答对了！',
  masteryDelta: 0.15,
  levels: raw.levels,
  progress: { done, total: raw.levels.length }
}

await ev(`(async () => {
  const events = await import('/src/api/events.ts')
  const stores = await import('/src/stores/chat.ts')
  const chat = stores.useChatStore()
  chat.conversation = events.emptyConversation()
  const e = { name:'payload', data:{ requestId:'persist-1', kind:'quiz', payload: ${JSON.stringify(payload)} } }
  let s = events.startTurn(chat.conversation,'persist-1','重启后接着练', chat.currentGrade ?? null)
  s = events.applyChatEvent(s, e)
  s = events.applyChatEvent(s,{name:'done',data:{requestId:'persist-1',messageId:'p1'}})
  chat.conversation = s
  return true })()`)
await new Promise((r) => setTimeout(r, 1200))

console.log('\n=== 重启后 UI（从真实 DOM 读回）===')
console.log(
  JSON.stringify(
    await ev(`(() => {
  const c = Array.from(document.querySelectorAll('[data-testid="progress-card"]')).pop()
  if (!c) return { found: false }
  const lv = Array.from(c.querySelectorAll('[data-testid="progress-level"]'))
  return {
    found: true,
    done: c.getAttribute('data-done'),
    total: c.getAttribute('data-total'),
    barLabel: c.querySelector('[data-testid="progress-label"]')?.textContent?.trim(),
    barValue: c.querySelector('[data-testid="progress-bar"]')?.getAttribute('data-value'),
    advanced: lv.filter(l => l.getAttribute('data-stage') !== 'locked').map(l => l.getAttribute('data-kp-id') + '=' + l.getAttribute('data-stage')),
    badges: lv.map(l => l.getAttribute('data-badge')).filter(Boolean),
    masteryOfFirst: lv.filter(l => l.getAttribute('data-kp-id') === 'ai-definition-pl').map(l => l.querySelector('[data-testid="progress-mastery"]')?.textContent?.trim())
  }
})()`),
    null,
    1
  )
)
ws.close()
