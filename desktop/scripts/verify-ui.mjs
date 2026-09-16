/**
 * UI 冒烟：用 Chrome DevTools Protocol 读**真实 DOM** 做断言。
 *
 * 为什么不截图：本机截图受前台窗口 / DPI 影响，经常截到别的窗口，结论不可信。
 * 前置条件：应用已带调试端口启动，例如
 *   PowerShell:  $env:K12_DEBUG_PORT=9222; npm run dev
 *   Git Bash:    K12_DEBUG_PORT=9222 npm run dev
 * 端口不同时用 K12_DEBUG_BASE 覆盖（默认 9222）。
 *
 * 用法：node scripts/verify-ui.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 脚本自身出错（连不上 / 找不到页面目标）。
 *
 * 只用 Node 内置能力（需要 Node >= 22 的全局 fetch / WebSocket），不引入任何依赖。
 */

const debugBase = process.env.K12_DEBUG_BASE ?? '9222'
const listUrl = `http://127.0.0.1:${debugBase}/json/list`
const commandTimeoutMs = 15_000

/** 期望的 sidecar 阶段文案与 data-phase 取值（与 src/renderer/src/App.vue 一致）。 */
const EXPECTED_PHASE_TEXT = ['等待启动', '启动中', '已就绪', '启动失败', '已停止']
const EXPECTED_PHASE_ATTR = ['idle', 'starting', 'ready', 'failed', 'stopped']
/** preload 白名单：window.api 只允许暴露这些方法。 */
const EXPECTED_API_METHODS = ['getSidecarInfo', 'onSidecarChanged']

const failures = []

function check(name, passed, detail) {
  if (passed) {
    console.log(`[PASS] ${name} — ${detail}`)
  } else {
    failures.push(name)
    console.log(`[FAIL] ${name} — ${detail}`)
  }
}

function scriptError(message) {
  console.error(`[ERROR] ${message}`)
  process.exit(2)
}

/** 在页面里读取真实 DOM + 白名单对象形状。 */
const PAGE_PROBE = `(() => {
  const el = document.querySelector('[data-testid="sidecar-status"]')
  const api = window.api
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').trim()
  return {
    readyState: document.readyState,
    title: document.title,
    bodyTextLength: bodyText.length,
    bodyTextPreview: bodyText.slice(0, 120),
    apiType: typeof api,
    apiKeys: api && typeof api === 'object' ? Object.keys(api).sort() : [],
    getSidecarInfoType: api ? typeof api.getSidecarInfo : 'undefined',
    onSidecarChangedType: api ? typeof api.onSidecarChanged : 'undefined',
    statusText: el && el.textContent ? el.textContent.trim().replace(/\\s+/g, '') : '',
    statusPhase: el ? el.getAttribute('data-phase') || '' : '',
    errorText: (() => {
      const err = document.querySelector('[data-testid="sidecar-error"]')
      return err && err.textContent ? err.textContent.trim().slice(0, 200) : ''
    })()
  }
})()`

async function findPageTarget() {
  let response
  try {
    response = await fetch(listUrl)
  } catch (error) {
    scriptError(
      `连不上 CDP（${listUrl}）：${String(error)}\n` +
        `请带调试端口启动应用，例如：K12_DEBUG_PORT=${debugBase} npm run dev`
    )
  }
  if (!response.ok) {
    scriptError(`CDP 目标列表返回 HTTP ${response.status}（${listUrl}）`)
  }

  const targets = await response.json()
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (pages.length === 0) {
    scriptError(`CDP 里没有可用页面目标（共 ${targets.length} 个目标）：${JSON.stringify(targets.map((t) => t.type))}`)
  }
  // 优先应用窗口，避开 DevTools 自身的页面
  return pages.find((page) => !page.url.startsWith('devtools://')) ?? pages[0]
}

function createClient(socket) {
  const pending = new Map()
  let nextId = 1

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`CDP 错误：${JSON.stringify(message.error)}`))
    else entry.resolve(message.result)
  })

  return function send(method, params) {
    const id = nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP 命令超时（${method}，${commandTimeoutMs}ms）`))
      }, commandTimeoutMs)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      socket.send(payload)
    })
  }
}

const target = await findPageTarget()
console.log(`CDP 目标：${target.title || '(无标题)'} · ${target.url}`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
const send = createClient(socket)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), commandTimeoutMs)
  socket.addEventListener('open', () => {
    clearTimeout(timer)
    resolve()
  })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    reject(new Error('WebSocket 连接失败'))
  })
}).catch((error) => {
  scriptError(`${String(error)}（${target.webSocketDebuggerUrl}）`)
})

let probe
try {
  const evaluated = await send('Runtime.evaluate', {
    expression: PAGE_PROBE,
    returnByValue: true,
    awaitPromise: true
  })
  probe = evaluated?.result?.value
} catch (error) {
  scriptError(`Runtime.evaluate 失败：${String(error)}`)
}

if (!probe || typeof probe !== 'object') {
  scriptError(`页面探测没有返回预期对象：${JSON.stringify(probe)}`)
}

// ── 断言 ────────────────────────────────────────────────────────────────

check(
  '页面已渲染（body 有文本）',
  probe.bodyTextLength > 0,
  `body 文本长度 ${probe.bodyTextLength}${probe.bodyTextPreview ? `，开头：「${probe.bodyTextPreview}」` : ''}（readyState=${probe.readyState}）`
)

check('标题包含 K12', String(probe.title).includes('K12'), `document.title = "${probe.title}"`)

check(
  'window.api 已注入且方法齐备',
  probe.apiType === 'object' &&
    probe.getSidecarInfoType === 'function' &&
    probe.onSidecarChangedType === 'function',
  `typeof window.api = ${probe.apiType}，getSidecarInfo=${probe.getSidecarInfoType}，onSidecarChanged=${probe.onSidecarChangedType}`
)

check(
  'window.api 只暴露白名单方法',
  probe.apiKeys.length > 0 && probe.apiKeys.every((key) => EXPECTED_API_METHODS.includes(key)),
  `实际方法：${probe.apiKeys.join(', ') || '(空)'}；白名单：${EXPECTED_API_METHODS.join(', ')}`
)

check(
  'sidecar 状态文案属于预期阶段',
  EXPECTED_PHASE_TEXT.includes(probe.statusText),
  `data-phase="${probe.statusPhase}"，文案="${probe.statusText || '(未找到 [data-testid=sidecar-status])'}"，` +
    `期望其中之一：${EXPECTED_PHASE_TEXT.join(' / ')}`
)

check(
  'sidecar data-phase 取值合法',
  EXPECTED_PHASE_ATTR.includes(probe.statusPhase),
  `data-phase="${probe.statusPhase}"，期望其中之一：${EXPECTED_PHASE_ATTR.join(' / ')}`
)

if (probe.errorText) {
  console.log(`[INFO] 页面上的错误行：「${probe.errorText}」`)
}

socket.close()

if (failures.length > 0) {
  console.log(`\n结果：${failures.length} 项断言失败 → ${failures.join('、')}`)
  process.exit(1)
}

console.log('\n结果：全部通过')
process.exit(0)
