/**
 * UI 冒烟：用 Chrome DevTools Protocol 读**真实 DOM** 做断言（票 05 扩到对话事件流）。
 *
 * 为什么不截图：本机截图受前台窗口 / DPI 影响，经常截到别的窗口，结论不可信。
 * 前置条件：应用已带调试端口启动，例如
 *   PowerShell:  $env:K12_DEBUG_PORT=9222; npm run dev
 *   Git Bash:    K12_DEBUG_PORT=9222 npm run dev
 * 端口不同时用 K12_DEBUG_BASE 覆盖（默认 9222）。
 *
 * 断言覆盖（票 05）：
 *   - 外壳与白名单：对话区 / 输入框 / 发送按钮在位；`window.api` 恰好暴露 4 个白名单方法；
 *   - **6 事件逐个在真实 DOM 里出现**：
 *       delta    → 正文逐字增长（多轮采样证明是「流」而不是一次性插入）
 *       citation → 来源标签（含「向上兼容」标注）
 *       payload  → 三种 kind 的占位卡片各一张
 *       done     → 本轮状态收尾
 *       blocked  → 撤回提示 + 安全文案替换
 *       error    → 可读降级提示（不是堆栈）
 *   - **中文跨段正确**：按码点切分的中文（含代理对字符）在 DOM 里逐字相等，且全文无 U+FFFD。
 *
 * 用法：node scripts/verify-ui.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 脚本自身出错（连不上 / 找不到页面目标）。
 *
 * 只用 Node 内置能力（需要 Node >= 22 的全局 fetch / WebSocket），不引入任何依赖。
 */

const debugBase = process.env.K12_DEBUG_BASE ?? '9222'
const listUrl = `http://127.0.0.1:${debugBase}/json/list`
const commandTimeoutMs = 15_000
/** 一轮流式回答最多等多久（票 05 的假数据源约 1–2 秒；给足余量以免机器慢时误判）。 */
const streamTimeoutMs = 20_000

/** 期望的 sidecar 阶段文案与 data-phase 取值（与 src/renderer/src/components/SidecarBadge.vue 一致）。 */
const EXPECTED_PHASE_TEXT = ['等待启动', '启动中', '已就绪', '启动失败', '已停止']
const EXPECTED_PHASE_ATTR = ['idle', 'starting', 'ready', 'failed', 'stopped']
/** preload 白名单：window.api 只允许暴露这些方法（顺序无关，集合必须完全相等）。 */
const EXPECTED_API_METHODS = ['getSidecarInfo', 'onSidecarChanged', 'sendChat', 'onChatEvent']
/** payload 事件的三种 kind（执行文档 §9.3）。 */
const EXPECTED_CARD_KINDS = ['animation', 'coding', 'quiz']
/** 端到端中文探针：含中文标点、书名号、以及一个代理对字符（按码点切分才不会被劈开）。 */
const CHINESE_PROBE = '中文测试：人工智能怎么认出猫？𠀀'
/** 触发假数据源另外两条链条的关键词（见 src/main/ipc/stub-chat.ts）。 */
const BLOCKED_PROBE = 'blocked 演示'
const ERROR_PROBE = 'error 演示'

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

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    apiMethodTypes: {
      getSidecarInfo: api ? typeof api.getSidecarInfo : 'undefined',
      onSidecarChanged: api ? typeof api.onSidecarChanged : 'undefined',
      sendChat: api ? typeof api.sendChat : 'undefined',
      onChatEvent: api ? typeof api.onChatEvent : 'undefined'
    },
    // 运行时确认：渲染进程里没有 Node / Electron 的通用口子（只应有 window.api）
    leakedGlobals: ['require', 'process', 'ipcRenderer', 'electron', 'Buffer', 'module']
      .filter((name) => typeof window[name] !== 'undefined'),
    hasChatArea: !!document.querySelector('[data-testid="chat-area"]'),
    hasChatLog: !!document.querySelector('[data-testid="chat-log"]'),
    hasComposer: !!document.querySelector('[data-testid="composer-input"]'),
    hasSendButton: !!document.querySelector('[data-testid="composer-send"]'),
    hasSettingsEntry: !!document.querySelector('[data-testid="settings-entry"]'),
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

function createClient(socket, onEvent) {
  const pending = new Map()
  let nextId = 1

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.id === undefined) {
      // CDP 事件（非响应）：交给调用方记录
      onEvent?.(message)
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
/** 渲染进程里的未捕获异常 / 控制台错误（网络资源 404 之类不计入）。 */
const pageErrors = []
const send = createClient(socket, (message) => {
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails
    pageErrors.push(`未捕获异常：${details?.exception?.description ?? details?.text ?? '未知'}`)
  }
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
    const entry = message.params.entry
    if (entry.source !== 'network') pageErrors.push(`控制台错误：${entry.text}`)
  }
})

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

/** 在页面里求值并取回 JSON 结果。 */
async function evaluate(expression) {
  const evaluated = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (evaluated?.exceptionDetails) {
    throw new Error(`页面执行异常：${evaluated.exceptionDetails.text ?? JSON.stringify(evaluated.exceptionDetails)}`)
  }
  return evaluated?.result?.value
}

// 订阅控制台/异常事件（要在交互之前打开，才能把整轮交互期间的报错都收到）
try {
  await send('Runtime.enable')
  await send('Log.enable')
} catch (error) {
  console.log(`[INFO] 打开控制台监听失败（不影响其余断言）：${describe(error)}`)
}

/** 轮询一个布尔表达式直到为真（超时抛错，由外层计为断言失败）。 */
async function waitFor(expression, description, timeoutMs = streamTimeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (last) return last
    await delay(120)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${description}；最后一次求值 = ${JSON.stringify(last)}`)
}

/** 第 index 轮的状态与正文快照。 */
function turnSnapshotExpression(index) {
  return `(() => {
    const turns = document.querySelectorAll('[data-testid="chat-turn"]')
    const turn = turns[${index}]
    if (!turn) return null
    const textEl = turn.querySelector('[data-testid="assistant-text"]')
    return {
      status: turn.getAttribute('data-status') || '',
      text: textEl && textEl.textContent ? textEl.textContent : '',
      citationCount: turn.querySelectorAll('[data-testid="citation-chip"]').length,
      compatCount: turn.querySelectorAll('[data-testid="citation-compat"]').length,
      cardKinds: Array.from(turn.querySelectorAll('[data-testid="inline-card"]')).map((card) =>
        card.getAttribute('data-kind') || ''
      ),
      blockedText: (() => {
        const el = turn.querySelector('[data-testid="blocked-notice"]')
        return el && el.textContent ? el.textContent.trim() : ''
      })(),
      errorText: (() => {
        const el = turn.querySelector('[data-testid="error-text"]')
        return el && el.textContent ? el.textContent.trim() : ''
      })(),
      statusLabel: (() => {
        const el = turn.querySelector('[data-testid="turn-status"]')
        return el && el.textContent ? el.textContent.trim() : ''
      })()
    }
  })()`
}

/** 在输入框里填字并点发送（走真实 DOM 事件，和学生的操作一样）。 */
async function sendMessage(text) {
  const filled = await evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]')
    if (!input) return false
    input.value = ${JSON.stringify(text)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!filled) throw new Error('找不到输入框（[data-testid=composer-input]）')

  await waitFor(
    `(() => { const b = document.querySelector('[data-testid="composer-send"]'); return !!b && !b.disabled })()`,
    '发送按钮变为可用（v-model 更新后才会解除 disabled）'
  )
  const clicked = await evaluate(
    `(() => { const b = document.querySelector('[data-testid="composer-send"]'); if (!b) return false; b.click(); return true })()`
  )
  if (!clicked) throw new Error('点不到发送按钮（[data-testid=composer-send]）')
}

/**
 * 采样本轮正文长度直到本轮不再是 streaming：
 * 「长度多次变化」才是流式渲染的证据（一次性插入只会有一个样本值）。
 */
async function collectStream(index) {
  const samples = []
  const deadline = Date.now() + streamTimeoutMs
  let snapshot = null

  while (Date.now() < deadline) {
    snapshot = await evaluate(turnSnapshotExpression(index))
    if (snapshot) {
      samples.push(snapshot.text.length)
      if (snapshot.status && snapshot.status !== 'streaming') break
    }
    await delay(80)
  }
  return { samples, snapshot }
}

// ── 外壳与白名单 ────────────────────────────────────────────────────────

// 应用可能刚启动（页面还在挂载），先等外壳与 preload 就绪再探测，
// 否则会把「还没渲染完」误报成「布局缺失」。
try {
  await waitFor(
    `(() => document.readyState === 'complete' && typeof window.api === 'object' && !!document.querySelector('[data-testid="chat-area"]'))()`,
    '应用外壳与 preload 就绪',
    20_000
  )
} catch (error) {
  console.log(`[INFO] 等待外壳就绪超时（继续探测并给出细节）：${describe(error)}`)
}

let probe
try {
  probe = await evaluate(PAGE_PROBE)
} catch (error) {
  scriptError(`Runtime.evaluate 失败：${describe(error)}`)
}

if (!probe || typeof probe !== 'object') {
  scriptError(`页面探测没有返回预期对象：${JSON.stringify(probe)}`)
}

check(
  '页面已渲染（body 有文本）',
  probe.bodyTextLength > 0,
  `body 文本长度 ${probe.bodyTextLength}${probe.bodyTextPreview ? `，开头：「${probe.bodyTextPreview}」` : ''}（readyState=${probe.readyState}）`
)

check('标题包含 K12', String(probe.title).includes('K12'), `document.title = "${probe.title}"`)

check(
  'window.api 已注入且方法齐备',
  probe.apiType === 'object' && Object.values(probe.apiMethodTypes).every((type) => type === 'function'),
  `typeof window.api = ${probe.apiType}，方法类型 = ${JSON.stringify(probe.apiMethodTypes)}`
)

check(
  'window.api 只暴露白名单方法（集合完全相等）',
  JSON.stringify(probe.apiKeys) === JSON.stringify([...EXPECTED_API_METHODS].sort()),
  `实际方法：${probe.apiKeys.join(', ') || '(空)'}；白名单：${EXPECTED_API_METHODS.join(', ')}`
)

check(
  '渲染进程没有 Node / Electron 通用口子（只应有 window.api）',
  probe.leakedGlobals.length === 0,
  probe.leakedGlobals.length === 0 ? 'require / process / ipcRenderer / electron / Buffer / module 均不可见' : `可见：${probe.leakedGlobals.join(', ')}`
)

check(
  '对话优先布局到位（对话区 / 消息区 / 输入框 / 发送按钮 / 设置入口）',
  probe.hasChatArea && probe.hasChatLog && probe.hasComposer && probe.hasSendButton && probe.hasSettingsEntry,
  `chat-area=${probe.hasChatArea}，chat-log=${probe.hasChatLog}，composer=${probe.hasComposer}，send=${probe.hasSendButton}，settings=${probe.hasSettingsEntry}`
)

// 设置入口是「二级页面」：点进去能看到设置视图，再点回来还是对话区（对话优先布局）
try {
  await evaluate(`(() => { document.querySelector('[data-testid="settings-entry"]').click(); return true })()`)
  const openedSettings = await waitFor(
    `(() => !!document.querySelector('[data-testid="settings-view"]'))()`,
    '设置视图出现',
    5000
  )
  await evaluate(`(() => { document.querySelector('[data-testid="settings-entry"]').click(); return true })()`)
  const backToChat = await waitFor(
    `(() => !!document.querySelector('[data-testid="chat-area"]') && !document.querySelector('[data-testid="settings-view"]'))()`,
    '返回对话视图',
    5000
  )
  check('设置入口可进可出（对话优先布局）', openedSettings === true && backToChat === true, `打开设置=${openedSettings}，返回对话=${backToChat}`)
} catch (error) {
  check('设置入口可进可出（对话优先布局）', false, describe(error))
}

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

// ── 6 事件在真实 DOM 里的表现 ──────────────────────────────────────────

try {
  // 脚本可重复运行：先记住当前已有多少轮，之后只断言本次新增的三轮
  const baseIndex = await evaluate(`(() => document.querySelectorAll('[data-testid="chat-turn"]').length)()`)

  // 第 1 轮：delta + citation + payload + done
  await sendMessage(CHINESE_PROBE)
  const first = await collectStream(baseIndex)
  const snapshot = first.snapshot

  if (!snapshot) {
    check('delta：流式正文出现在 DOM 里', false, '第 1 轮没有出现在消息区（[data-testid=chat-turn]）')
  } else {
    const distinct = [...new Set(first.samples.filter((length) => length > 0))]
    check(
      'delta：正文是「流」而不是一次性插入（长度多次增长）',
      distinct.length >= 3 && Math.max(...distinct) > Math.min(...distinct),
      `采样到的正文长度：${first.samples.join(' → ')}`
    )
    check(
      `中文逐字渲染正确（含代理对字符，长度 ${CHINESE_PROBE.length}）`,
      snapshot.text.includes(CHINESE_PROBE) && !snapshot.text.includes('\uFFFD'),
      `正文长度 ${snapshot.text.length}${snapshot.text.includes(CHINESE_PROBE) ? '' : '，未找到原样回显的提问'}`
    )
    check(
      'citation：来源标签渲染出来（含向上兼容标注）',
      snapshot.citationCount >= 1 && snapshot.compatCount >= 1,
      `来源标签 ${snapshot.citationCount} 条，其中「向上兼容」${snapshot.compatCount} 条`
    )
    check(
      'payload：三种 kind 的占位卡片各一张',
      JSON.stringify([...snapshot.cardKinds].sort()) === JSON.stringify([...EXPECTED_CARD_KINDS].sort()),
      `卡片 kind：${snapshot.cardKinds.join(', ') || '(无)'}`
    )
    check(
      'done：本轮已收尾（状态不再是「正在回答」）',
      snapshot.status === 'done' && snapshot.statusLabel.length > 0,
      `data-status=${snapshot.status}，状态文案="${snapshot.statusLabel}"`
    )
  }

  // 第 2 轮：blocked（撤回 + 安全文案）
  await sendMessage(BLOCKED_PROBE)
  const second = await collectStream(baseIndex + 1)
  check(
    'blocked：正文被撤回并替换成安全提示',
    second.snapshot?.status === 'blocked' &&
      second.snapshot.blockedText.length > 0 &&
      second.snapshot.text.length > 0 &&
      !second.snapshot.text.includes('\uFFFD'),
    `data-status=${second.snapshot?.status}，撤回提示「${second.snapshot?.blockedText ?? ''}」，正文「${(second.snapshot?.text ?? '').slice(0, 40)}」`
  )

  // 第 3 轮：error（降级提示）
  await sendMessage(ERROR_PROBE)
  const third = await collectStream(baseIndex + 2)
  check(
    'error：给出可读降级提示（不是堆栈）',
    third.snapshot?.status === 'error' &&
      third.snapshot.errorText.length > 0 &&
      !third.snapshot.errorText.includes('\uFFFD') &&
      !/\n\s+at\s/.test(third.snapshot.errorText),
    `data-status=${third.snapshot?.status}，提示「${third.snapshot?.errorText.slice(0, 60) ?? ''}」`
  )

  const pageText = await evaluate(
    `(() => (document.body.innerText || '').includes('\\uFFFD'))()`
  )
  check('全文没有 U+FFFD（中文没有乱码）', pageText === false, `body.innerText 里出现替换字符 = ${pageText}`)

  const turnCount = await evaluate(`(() => document.querySelectorAll('[data-testid="chat-turn"]').length)()`)
  check(
    '三轮对话都留在消息区（旧轮不被新轮清掉）',
    turnCount === baseIndex + 3,
    `消息区里的轮次数量 = ${turnCount}（本次开始前 ${baseIndex} 轮，新增 3 轮）`
  )

  check(
    '整轮交互期间渲染进程没有未捕获异常 / 控制台错误',
    pageErrors.length === 0,
    pageErrors.length === 0 ? '未捕获异常与控制台错误均为 0' : pageErrors.slice(0, 3).join(' ｜ ')
  )
} catch (error) {
  check('对话事件流端到端交互', false, describe(error))
}

socket.close()

if (failures.length > 0) {
  console.log(`\n结果：${failures.length} 项断言失败 → ${failures.join('、')}`)
  process.exit(1)
}

console.log('\n结果：全部通过')
process.exit(0)
