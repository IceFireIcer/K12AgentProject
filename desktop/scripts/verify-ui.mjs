/**
 * UI 校验脚本：通过 CDP 读取**真实渲染进程的 DOM**。
 *
 * 为什么不用截图：本机屏幕截图受前台窗口/DPI 影响，不可靠且不可断言。
 * 读 DOM 是确定性的，能给出可断言的证据（含文本、可见性、元素数量）。
 *
 * 用法（需先以 K12_DEBUG_PORT 启动 dev）：
 *   K12_DEBUG_PORT=9222 npm run dev
 *   node scripts/verify-ui.mjs                 # 断言「就绪」态
 *   node scripts/verify-ui.mjs --expect failed # 断言「失败」态（不白屏）
 *
 * 退出码 0 = 全部断言通过；非 0 = 有断言失败。
 */

const DEBUG_BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'
const TIMEOUT_MS = 60_000
const POLL_MS = 500

/** 期望的终态：ready（默认）或 failed。 */
const EXPECT = readExpect()
function readExpect() {
  const i = process.argv.indexOf('--expect')
  const value = i >= 0 ? process.argv[i + 1] : 'ready'
  if (value !== 'ready' && value !== 'failed') {
    throw new Error(`--expect 只支持 ready | failed，收到 ${value}`)
  }
  return value
}

async function findPage() {
  const res = await fetch(`${DEBUG_BASE}/json/list`)
  const targets = await res.json()
  return targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
}

/** 极简 CDP 客户端：只用到 Runtime.evaluate。 */
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })

  return { send, close: () => ws.close() }
}

/** 在页面里求值并取回 JSON 值。 */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    throw new Error(`页面求值异常：${result.exceptionDetails.text}`)
  }
  return result.result.value
}

const PROBE = `JSON.stringify({
  title: document.title,
  bodyText: document.body.innerText,
  hasApi: typeof window.api === 'object' && window.api !== null,
  apiMethods: window.api ? Object.keys(window.api) : [],
  readyText: (document.querySelector('.headline') || {}).textContent || '',
  phaseBadge: (document.querySelector('.badge') || {}).textContent || '',
  portText: (document.querySelector('code') || {}).textContent || '',
  hasRetryButton: !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('重试')),
  visibleCards: document.querySelectorAll('.card').length
})`

const failures = []

function check(name, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(name)
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS
  let page = null
  while (Date.now() < deadline) {
    page = await findPage()
    if (page) break
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  if (!page) throw new Error('未找到可调试的渲染进程（确认已用 K12_DEBUG_PORT 启动 dev）')
  console.log(`调试目标：${page.url}\n`)

  const cdp = await connect(page.webSocketDebuggerUrl)

  // 等到 sidecar 就绪（或失败）再断言
  let state = null
  while (Date.now() < deadline) {
    state = JSON.parse(await evaluate(cdp, PROBE))
    if (state.bodyText.includes('握手成功') || state.hasRetryButton) break
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  cdp.close()

  console.log('--- 渲染结果 ---')
  console.log(`标题：${state.title}`)
  console.log(`状态徽章：${state.phaseBadge}`)
  console.log(`窗口正文：\n${state.bodyText.split('\n').slice(0, 12).join('\n')}`)
  console.log('--- 断言 ---')

  check('窗口已渲染（非白屏）', state.visibleCards > 0, `卡片数=${state.visibleCards}`)
  check('页面标题正确', state.title.includes('K12'), state.title)
  check('preload 白名单已注入', state.hasApi, `方法=${state.apiMethods.join(',')}`)
  check(
    '白名单只暴露最小接口',
    state.apiMethods.length === 4,
    `实际 ${state.apiMethods.length} 个：${state.apiMethods.join(',')}`
  )

  if (EXPECT === 'ready') {
    check('界面显示「握手成功」', state.bodyText.includes('握手成功'))
    check('界面显示真实端口', /port=\d{2,5}/.test(state.bodyText), state.portText)
    check('状态徽章为已就绪', state.phaseBadge.includes('已就绪'), state.phaseBadge)
    check('未误显示失败态', !state.hasRetryButton)
  } else {
    // 失败态的验收重点：**有可读错误 + 有重试入口**，而不是白屏
    check('界面显示「启动失败」', state.bodyText.includes('启动失败'))
    check('给出可读的中文错误原因', state.bodyText.includes('仍未恢复'))
    check('提供「重试」按钮', state.hasRetryButton)
    check('未误显示成功态', !state.bodyText.includes('握手成功'))
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`✗ ${failures.length} 项断言失败：${failures.join('；')}`)
    process.exit(1)
  }
  console.log(`✓ 全部断言通过（期望态：${EXPECT}）`)
}

main().catch((err) => {
  console.error(`校验脚本异常：${err.message}`)
  process.exit(2)
})
