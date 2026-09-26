#!/usr/bin/env node
/**
 * 键盘可用性真机探针（优化报告 §3.1 执行计划第三条：键盘导航端到端）。
 *
 * 判据（三条，都只看**真实焦点**）：
 *   ① 从页面起点 Tab N 次，焦点**一次都不许掉回 body**（掉回去 = 键盘用户迷路）；
 *   ② 第一站必须是「跳到主内容」（`.skip-link`）；
 *   ③ 任意时刻按 Esc，焦点仍在文档内（模态有出口，不是把焦点关没了）。
 *
 * 跑法（应用需带调试端口启动）：
 *   K12_DEBUG_PORT=9222 npm run dev     # 另一个终端
 *   K12_DEBUG_BASE=http://127.0.0.1:9222 node scripts/ux-keyboard.mjs
 * 退出码：0 = 通过；1 = 有发现；2 = 脚本自身出错（连不上等）。
 *
 * ⚠️ 它**不进** `npm test`（需要真机）；CI 里的键盘纪律由 `tests/keyboard-a11y.test.ts` 守。
 */
const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'
const STEPS = Number(process.env.K12_KEYBOARD_STEPS ?? 24)

const list = await (await fetch(`${BASE}/json/list`)).json()
const page = list.find((entry) => entry.type === 'page')
if (!page) {
  console.error('找不到 page 目标（应用起了吗？K12_DEBUG_PORT 设了吗？）')
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
})

let seq = 0
function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== id) return
      ws.removeEventListener('message', onMessage)
      resolve(message.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text ?? '页面异常')
  return result?.result?.value
}

async function pressKey(key, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 27, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 27, modifiers })
}

const describeFocus = `(() => {
  const active = document.activeElement
  if (!active || active === document.body) return { tag: 'BODY', label: '(掉回 body)' }
  return {
    tag: active.tagName.toLowerCase(),
    testid: active.getAttribute('data-testid') || '',
    cls: String(active.className || '').split(' ')[0] || '',
    label: (active.getAttribute('aria-label') || active.innerText || active.value || '').trim().slice(0, 24)
  }
})()`

const findings = []
let passed = 0
function check(what, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`\u001b[32m✓\u001b[0m ${what}${detail ? `  \u001b[2m(${detail})\u001b[0m` : ''}`)
  } else {
    findings.push({ what, detail })
    console.log(`\u001b[31m✗\u001b[0m ${what}\n    实测：${detail}`)
  }
}

// 起点：焦点交回文档首（点侧栏太不可靠 —— 我们量的是键盘本身）。
await evaluate(`(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); return true })()`)

const trail = []
let dropped = 0
for (let index = 0; index < STEPS; index += 1) {
  await pressKey('Tab')
  const focus = await evaluate(describeFocus)
  trail.push(focus)
  if (focus?.tag === 'BODY') dropped += 1
}

check(
  `Tab ${STEPS} 次，焦点一次都不掉回 body`,
  dropped === 0,
  dropped === 0 ? `${STEPS} 次全落在可聚焦元素上` : `${dropped} 次掉回 body（键盘用户会迷路）`
)
check(
  '第一站是「跳到主内容」（Tab 顺序的第 0 站）',
  trail[0]?.cls === 'skip-link' || trail[0]?.label.includes('跳到主内容'),
  `第一站：${JSON.stringify(trail[0])}`
)

await pressKey('Escape')
const afterEsc = await evaluate(describeFocus)
check('按 Esc 之后焦点仍在文档内（模态有出口，不把焦点关丢）', afterEsc?.tag !== 'BODY', `Esc 后焦点：${JSON.stringify(afterEsc)}`)

console.log(`\n键盘轨迹（前 8 站）：${trail.slice(0, 8).map((item) => item.testid || item.cls || item.tag).join(' → ')}`)
console.log(`\n通过 ${passed} 项，失败 ${findings.length} 项`)
ws.close()
process.exit(findings.length === 0 ? 0 : 1)
