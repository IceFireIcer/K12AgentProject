/**
 * 验证「非正常退出 → 自动重启一次」这条判据。
 *
 * 做法：起应用 → 记下 sidecar pid → **直接杀掉它**（模拟崩溃，不是优雅退出）
 *      → 等 → 断言出现了一个**新的** sidecar pid 且状态回到 ready、restarts >= 1。
 */
import { spawn, execFileSync } from 'node:child_process'

const DESKTOP = 'E:/FolderForVibeCoding/Zcode/K12Agent/desktop'
const CDP = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function cdpEval(expression) {
  const targets = await (await fetch(`${CDP}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const value = await new Promise((res) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id === 1) res(m.result?.result?.value)
    })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    setTimeout(() => res(undefined), 8000)
  })
  ws.close()
  return value
}

const info = async () => {
  const raw = await cdpEval('window.api.getSidecarInfo().then(i => JSON.stringify(i))')
  return raw ? JSON.parse(raw) : null
}

const npm = spawn('npm run dev', {
  cwd: DESKTOP,
  env: { ...process.env, K12_DEBUG_PORT: '9222' },
  stdio: 'ignore',
  detached: true,
  shell: true,
  windowsHide: true
})

for (let i = 0; i < 90; i++) {
  try { if ((await fetch(`${CDP}/json/list`)).ok) break } catch { /* 等 */ }
  await sleep(1000)
}
await sleep(8000)

const before = await info()
console.log(`  崩溃前：port=${before?.port} pid=${before?.pid} restarts=${before?.restarts}`)
check('崩溃前已就绪', before?.phase === 'ready', String(before?.phase))

// ★ 只杀 sidecar 本身（不是优雅退出），模拟进程崩溃
execFileSync('taskkill', ['/PID', String(before.pid), '/F'], { stdio: 'ignore', windowsHide: true })
console.log(`  已强杀 pid=${before.pid}`)

// 等自动重启 + 重新探活
let after = null
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  const cur = await info()
  if (cur && cur.phase === 'ready' && cur.pid && cur.pid !== before.pid) {
    after = cur
    break
  }
  if (i % 5 === 4) console.log(`  等待中… phase=${cur?.phase} pid=${cur?.pid} restarts=${cur?.restarts}`)
}

console.log(`  崩溃后：port=${after?.port} pid=${after?.pid} restarts=${after?.restarts}`)

check('★ 崩溃后自动重启并重新就绪', after !== null, after ? `新 pid=${after.pid}` : '未在 40s 内恢复')
check('★ 重启后是**新的**进程（不是原进程诈活）', after ? after.pid !== before.pid : false, `${before.pid} → ${after?.pid}`)
check('restarts 计数已增加', after ? after.restarts >= 1 : false, String(after?.restarts))

// 收尾
await cdpEval('window.close()')
await sleep(6000)
try { execFileSync('taskkill', ['/PID', String(npm.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 已退 */ }

console.log(`\n${'='.repeat(56)}`)
console.log(failures ? `✗ ${failures} 项失败` : '✓ 全部通过')
process.exit(failures ? 1 : 0)
