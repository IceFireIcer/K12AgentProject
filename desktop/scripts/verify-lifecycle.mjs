/**
 * 票 02 关卡 A 的「退出无孤儿」判据验证器（一次性驱动，放在 /tmp）。
 *
 * 判定用两个**直接探针**，不用解析 netstat 文本：
 *   - 进程存活：process.kill(pid, 0)
 *   - 端口监听：真实 TCP 连接
 *
 * 连跑两轮：第二轮额外证明「端口随机分配，连续启停不会撞端口 / 文件锁」。
 */
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ★ 路径与端口都从**本脚本的位置**推出来（换目录 / 换机器照样能跑）：
//   DESKTOP = 本脚本的上一级；CDP 端口读 `K12_DEBUG_PORT`（默认 9222，与 verify-ui 同一口径）。
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEBUG_PORT = process.env.K12_DEBUG_PORT ?? '9222'
const CDP = `http://127.0.0.1:${DEBUG_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 800 })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => resolve(false))
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
  })
}

function electronCount() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV'], {
      encoding: 'latin1',
      windowsHide: true
    })
    return out.split('\n').filter((l) => l.toLowerCase().includes('electron.exe')).length
  } catch {
    return 0
  }
}

function sidecarPids() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
       "Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.CommandLine -like '*app.main*' } | Select-Object -ExpandProperty ProcessId"],
      { encoding: 'latin1', windowsHide: true }
    )
    return out.split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number)
  } catch {
    return []
  }
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
    const id = 1
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id === id) res(m.result?.result?.value)
    })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    setTimeout(() => res(undefined), 8000)
  })
  ws.close()
  return value
}

async function waitForCdp(seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    try {
      const r = await fetch(`${CDP}/json/list`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(1000)
  }
  return false
}

async function runCycle(n) {
  console.log(`\n=========== 第 ${n} 轮 ===========`)

  // Node ≥20 起，spawn 一个 .cmd 必须带 shell:true（CVE-2024-27980 的修复），
  // 否则直接 EINVAL。带 shell 后 npm.pid 是 cmd.exe，用 taskkill /T 收整棵树。
  const npm = spawn('npm run dev', {
    cwd: DESKTOP,
    env: { ...process.env, K12_DEBUG_PORT: DEBUG_PORT },
    stdio: 'ignore',
    detached: true,
    shell: true,
    windowsHide: true
  })

  check(`${n}: 启动 electron-vite dev`, await waitForCdp(), 'CDP 端点就绪')
  await sleep(8000)

  const raw = await cdpEval('window.api.getSidecarInfo().then(i => JSON.stringify(i))')
  if (!raw) {
    check(`${n}: 读到 sidecar 状态`, false, 'CDP 求值失败')
    return
  }
  const info = JSON.parse(raw)
  console.log(`  侧车：port=${info.port} pid=${info.pid} phase=${info.phase}`)

  check(`${n}: 状态为 ready（握手成功）`, info.phase === 'ready', info.phase)
  check(`${n}: 端口来自系统分配（不是固定 8756）`, Number.isInteger(info.port) && info.port > 0 && info.port !== 8756, String(info.port))
  check(`${n}: pid 存活`, alive(info.pid), `pid=${info.pid}`)
  check(`${n}: 端口可连接`, await portOpen(info.port), `port=${info.port}`)
  check(`${n}: 状态对象不含 token`, !('token' in info), Object.keys(info).join(','))

  // ★ 优雅退出：关窗口 → window-all-closed → before-quit → 杀进程树
  await cdpEval('window.close()')
  await sleep(7000)

  check(`${n}: ★ sidecar 进程已随应用退出（无孤儿）`, !alive(info.pid), `pid=${info.pid}`)
  check(`${n}: ★ 端口已释放`, !(await portOpen(info.port)), `port=${info.port}`)
  check(`${n}: Electron 进程已清空`, electronCount() === 0, `剩 ${electronCount()} 个`)

  // 收掉 dev server 本身（Electron 退出后 vite 可能还在）
  try { execFileSync('taskkill', ['/PID', String(npm.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 已退出 */ }
  await sleep(1500)
}

console.log('起点检查：')
const stray = sidecarPids()
check('起跑线干净（无遗留 sidecar）', stray.length === 0, stray.length ? `残留 ${stray.join(',')}` : '')

await runCycle(1)
await runCycle(2)

console.log(`\n${'='.repeat(56)}`)
console.log(failures ? `✗ ${failures} 项失败` : '✓ 全部通过')
process.exit(failures ? 1 : 0)
