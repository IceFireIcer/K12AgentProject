/**
 * UI 冒烟：用 Chrome DevTools Protocol 读**真实 DOM** 做断言（票 06 重写：无 Key 也能跑绿）。
 *
 * 前置条件：应用已带调试端口启动，例如
 *   PowerShell:  $env:K12_DEBUG_PORT=9222; npm run dev
 *   Git Bash:    K12_DEBUG_PORT=9222 npm run dev
 * 端口不同时用 `K12_DEBUG_BASE` 覆盖（默认 9222）。
 * 跑法：`node scripts/verify-ui.mjs`
 * 退出码：**0 = 全部通过；1 = 有断言失败；2 = 脚本自身出错**（连不上 / 找不到页面目标）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么要重写（票 06 的 6 项断言已经「按设计失败」）
 * ---------------------------------------------------------------------------
 * 旧版把「假数据源」当数据源：delta 增长、中文回显、citation、三种 kind 的占位卡片、
 * done、blocked —— 这些都靠 `ipc/stub-chat.ts` 的确定性事件序列。票 06 起实时对话走
 * **真实 Pi 会话**（`agent/runtime.ts`），而无 Key 时一轮对话会以 `error` 事件结束
 * （「云端模型暂时不可用…」），于是那 6 项**必然失败**：不是回归，是世界变了。
 *
 * 现在的分层（**两个世界都要绿**）：
 *
 *   A. 静态契约（不需要应用）：6 事件词表冻结、渲染进程只认这 6 个名、
 *      渲染进程里**没有**可以让学段被手选的写入口。
 *   B. 外壳与边界（始终执行）：布局、preload 白名单（必需方法齐全 + 无通用 IPC 口子）、
 *      无 Node/Electron 全局泄漏、设置页可进可出、sidecar 阶段文案合法、整轮无未捕获异常。
 *   C. 只读学段指示器（始终执行）：指示器在位、**内部没有任何控件**、
 *      手动选择器（`grade-selector` / `grade-option`）**不存在**。
 *   D. **无 Key 路径**（仅无 Key 世界）：发一条消息 → 得到**可读的「能力受限」提示**
 *      （不是堆栈、不是白屏、不是卡在「正在回答」）。
 *      —— 这一条正是「没有 API Key 时应用仍然可用」的验收口径。
 *   E. 内容断言（**仅当检测到已配置 API Key**）：delta 流式增长、终态 done、
 *      出现的卡片 kind 合法、无 U+FFFD。无 Key 世界跳过（打印 [SKIP] 并说明原因）。
 *   F. 练习卡片（dev 模式必须过）：用**真实形状的 `payload` 事件**驱动渲染进程自己的
 *      事件归约器（`applyChatEvent`），断言题目/作答/逐题反馈/掌握度变化都渲染出来，
 *      并且**标准答案与解析不出现在 DOM 里**（§6.3 答案泄漏防线的界面侧证据）。
 *
 * 为什么 F 要「注入事件」而不是等模型出题：无 Key 时模型不会调用 `generate_quiz`，
 * 而卡片渲染是纯前端行为 —— 所以用真实结构的事件走**真实的归约器与真实组件**，
 * 数据取自 `server/resources/quizbank/junior.json`（真实题库，不是编的）。
 * 注入路径依赖 dev 模式的 Vite 模块图；打包产物（file://）下会打印 [SKIP]。
 *
 * ---------------------------------------------------------------------------
 * 环境开关（全部可选，默认自动判定）
 * ---------------------------------------------------------------------------
 *   K12_DEBUG_BASE=9333         CDP 端口（应用用 `K12_DEBUG_PORT=9333 npm run dev` 启动）
 *   K12_VERIFY_HAS_KEY=1|0      强制指定「已配置 API Key」世界（默认：问主进程读设置）
 *   K12_OFFLINE_PROBE=1         应用跑了离线探针模式时同步设置：加宽等待上限，
 *                               并接受「离线探针模式」这句可读文案（`runtime.ts` 的 PROBE_NOTICE）
 *   K12_UI_DUMP=1               结束时把关键区域的真实 DOM 文本打出来（报告素材）
 *
 * 只用 Node 内置能力（Node >= 22 的全局 fetch / WebSocket），不引入任何依赖。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '..')

const debugBase = process.env.K12_DEBUG_BASE ?? '9222'
const listUrl = `http://127.0.0.1:${debugBase}/json/list`
const commandTimeoutMs = 15_000
/** 无 Key 路径：一轮应在毫秒级结束；给足余量，但超了就是「卡住」。 */
const noKeyTimeoutMs = 30_000
/** 离线探针（`K12_OFFLINE_PROBE=1`）会走真实供应商重试链（3 次），给更宽的上限。 */
const probeTimeoutMs = 90_000
/** 有 Key 世界的内容断言：等真实流式回答（含检索与工具调用）。 */
const contentTimeoutMs = 90_000

/** 冻结的 6 事件词表（顺序也是冻结的一部分）。 */
const EXPECTED_EVENT_NAMES = ['delta', 'citation', 'payload', 'blocked', 'done', 'error']
/** payload 事件的三种合法 kind（执行文档 §9.3）。 */
const EXPECTED_CARD_KINDS = ['animation', 'coding', 'quiz']
/** preload **必须**暴露的方法（学段指示器 + 设置页 + 对话）。 */
const REQUIRED_API_METHODS = [
  'getSidecarInfo',
  'onSidecarChanged',
  'sendChat',
  'onChatEvent',
  'readSettings',
  'saveSettings',
  'probeSettings'
]
/** **绝不能**出现在 `window.api` 上的通用口子（白名单之外的一切都是越界）。 */
const FORBIDDEN_API_METHODS = ['invoke', 'send', 'sendSync', 'on', 'once', 'emit', 'postMessage']
/** 预期不会泄漏到渲染进程的 Node / Electron 全局。 */
const LEAKY_GLOBALS = ['require', 'process', 'ipcRenderer', 'electron', 'Buffer', 'module']
/** sidecar 阶段文案与 `data-phase` 取值（与 SidecarBadge.vue 一致）。 */
const EXPECTED_PHASE_TEXT = ['等待启动', '启动中', '已就绪', '启动失败', '已停止']
const EXPECTED_PHASE_ATTR = ['idle', 'starting', 'ready', 'failed', 'stopped']
/** 四学段中文名（指示器文案只允许出现这四个 + 「待判定」）。 */
const GRADE_LABELS = ['小学低年级', '小学高年级', '初中', '高中']
const GRADE_UNKNOWN_LABEL = '待判定'
/** 无 Key / 供应商不可用时，主进程给学生的**可读**文案判据（`agent/events.ts` / `runtime.ts`）。 */
const DEGRADED_NOTICE_MARKERS = [
  // 正常路径：缺 Key 或连不上模型（describeProviderError / MISSING_KEY_MESSAGE）
  '云端模型暂时不可用',
  // 离线探针模式（K12_OFFLINE_PROBE=1）：文案被换成说清「这是探针」的那句，避免误读成真实网络故障
  '离线探针模式'
]
/** 降级徽章文案（`DegradedNotice.vue` 的 `degraded === true` 分支）。 */
const DEGRADED_BADGE_TEXT = '能力受限'
/** 「这不是堆栈」的判据：出现这些形状就说明把异常原文漏给了界面。 */
const STACK_PATTERNS = [/\bERR_[A-Z_]+\b/, /\bat\s+\S+\.(ts|js|mjs):\d+/, /\b(TypeError|ReferenceError|SyntaxError)\b/]
/** 判断「已配置 API Key」：环境变量优先，其次问主进程读设置。 */
const FORCED_HAS_KEY = process.env.K12_VERIFY_HAS_KEY

const results = { passed: 0, failed: 0, skipped: 0 }
const failures = []
const pageErrors = []

/* ------------------------------------------------------------------ *
 * 断言与输出
 * ------------------------------------------------------------------ */

function check(name, passed, detail) {
  if (passed) {
    results.passed += 1
    console.log(`[PASS] ${name} — ${detail}`)
  } else {
    results.failed += 1
    failures.push(name)
    console.log(`[FAIL] ${name} — ${detail}`)
  }
}

function skip(name, reason) {
  results.skipped += 1
  console.log(`[SKIP] ${name} — ${reason}`)
}

function info(message) {
  console.log(`[INFO] ${message}`)
}

function scriptError(message) {
  console.error(`[ERROR] ${message}`)
  process.exit(2)
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** 读源码做静态断言（读不到就当脚本错误，不静默跳过）。 */
function readSource(relativePath) {
  const absolute = join(DESKTOP_ROOT, relativePath)
  if (!existsSync(absolute)) scriptError(`静态断言需要的文件不存在：${relativePath}`)
  return readFileSync(absolute, 'utf8')
}

/** 去掉注释后再做「有没有某个写入口」这类文本断言（注释里写出反例不算数）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/* ------------------------------------------------------------------ *
 * A. 静态契约断言（不依赖应用在不在跑）
 * ------------------------------------------------------------------ */

console.log('== A. 静态契约（6 事件词表 / 渲染进程分派 / 学段无写入口）==')

{
  const ipcEventsSource = readSource('src/shared/ipc-events.ts')
  const declared =
    /export const IPC_EVENT_NAMES[^=]*=\s*\[([^\]]*)\]/.exec(ipcEventsSource)?.[1] ??
    ''
  const actualNames = [...declared.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  check(
    '6 事件词表冻结（shared/ipc-events.ts）',
    JSON.stringify(actualNames) === JSON.stringify(EXPECTED_EVENT_NAMES),
    `IPC_EVENT_NAMES = [${actualNames.join(', ')}]（期望 [${EXPECTED_EVENT_NAMES.join(', ')}]）`
  )

  const eventsSource = stripComments(readSource('src/renderer/src/api/events.ts'))
  const caseLabels = [...eventsSource.matchAll(/case\s+'([a-z_]+)'/g)].map((match) => match[1])
  const uniqueCases = [...new Set(caseLabels)].sort()
  check(
    '渲染进程只分派这 6 个事件名（没有第 7 个，也没有漏）',
    JSON.stringify(uniqueCases) === JSON.stringify([...EXPECTED_EVENT_NAMES].sort()),
    `api/events.ts 里的 case 分支：[${uniqueCases.join(', ')}]`
  )

  // ★ 设计变更的静态守护：学生不能选学段 —— 渲染进程里不许有写入口
  const rendererSources = [
    'src/renderer/src/stores/chat.ts',
    'src/renderer/src/views/Chat.vue',
    'src/renderer/src/views/Settings.vue',
    'src/renderer/src/components/ChatMessage.vue',
    'src/renderer/src/components/GradeIndicator.vue',
    'src/renderer/src/labels.ts',
    'src/renderer/src/api/grade.ts'
  ]
  const gradeWriters = rendererSources.filter((path) =>
    /setGrade(Level)?\s*\(/.test(stripComments(readSource(path)))
  )
  check(
    '渲染进程里没有「选学段」的写入口（不存在 setGrade() / setGradeLevel()）',
    gradeWriters.length === 0,
    gradeWriters.length === 0 ? `已扫描 ${rendererSources.length} 个渲染进程文件，0 处写入口` : `发现写入口：${gradeWriters.join('、')}`
  )

  const chatStoreSource = stripComments(readSource('src/renderer/src/stores/chat.ts'))
  check(
    '发送链路不传学段（sendChat 只带 text）',
    /sendChat\(\{\s*text\s*\}\)/.test(chatStoreSource) && !/sendChat\(\{[^}]*gradeLevel/.test(chatStoreSource),
    'stores/chat.ts 里 sendChat 的入参只有 { text }'
  )
}

/* ------------------------------------------------------------------ *
 * CDP 客户端
 * ------------------------------------------------------------------ */

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
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP 命令超时（${method}，${commandTimeoutMs}ms）`))
      }, commandTimeoutMs)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolvePromise(value)
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
console.log(`\nCDP 目标：${target.title || '(无标题)'} · ${target.url}`)
const isDevServer = /^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(target.url)

const socket = new WebSocket(target.webSocketDebuggerUrl)
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

await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), commandTimeoutMs)
  socket.addEventListener('open', () => {
    clearTimeout(timer)
    resolvePromise()
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
  info(`打开控制台监听失败（不影响其余断言）：${describe(error)}`)
}

/** 轮询一个布尔表达式直到为真（超时抛错，由外层计为断言失败）。 */
async function waitFor(expression, description, timeoutMs = noKeyTimeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (last) return last
    await delay(120)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${description}；最后一次求值 = ${JSON.stringify(last)}`)
}

/** 第 index 轮的状态与内容快照（全部来自真实 DOM 文本）。 */
function turnSnapshotExpression(index) {
  return `(() => {
    const turns = document.querySelectorAll('[data-testid="chat-turn"]')
    const turn = turns[${index}]
    if (!turn) return null
    const text = (sel) => {
      const el = turn.querySelector(sel)
      return el && el.textContent ? el.textContent.trim() : ''
    }
    const textEl = turn.querySelector('[data-testid="assistant-text"]')
    return {
      status: turn.getAttribute('data-status') || '',
      text: textEl && textEl.textContent ? textEl.textContent : '',
      citations: turn.querySelectorAll('[data-testid="citation-chip"]').length,
      compatCitations: turn.querySelectorAll('[data-testid="citation-compat"]').length,
      cardKinds: Array.from(turn.querySelectorAll('[data-testid="inline-card"]')).map((card) =>
        card.getAttribute('data-kind') || ''
      ),
      quizCards: turn.querySelectorAll('[data-testid="quiz-card"]').length,
      blockedText: text('[data-testid="blocked-notice"]'),
      errorBadge: text('[data-testid="error-badge"]'),
      errorText: text('[data-testid="error-text"]'),
      statusLabel: text('[data-testid="turn-status"]'),
      userText: text('[data-testid="user-message"]')
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
    '发送按钮变为可用（v-model 更新后才会解除 disabled）',
    10_000
  )
  const clicked = await evaluate(
    `(() => { const b = document.querySelector('[data-testid="composer-send"]'); if (!b) return false; b.click(); return true })()`
  )
  if (!clicked) throw new Error('点不到发送按钮（[data-testid=composer-send]）')
}

/** 轮次数量。 */
async function turnCount() {
  return await evaluate(`(() => document.querySelectorAll('[data-testid="chat-turn"]').length)()`)
}

/**
 * 采样本轮正文长度直到本轮不再是 streaming（用来证明「是流，不是一次性插入」）。
 */
async function collectUntilTerminal(index, timeoutMs) {
  const samples = []
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await evaluate(turnSnapshotExpression(index))
    if (snapshot) {
      samples.push(snapshot.text.length)
      if (snapshot.status && snapshot.status !== 'streaming') return { samples, snapshot, timedOut: false }
    }
    await delay(120)
  }
  return { samples, snapshot, timedOut: true }
}

const looksLikeStack = (text) => STACK_PATTERNS.some((pattern) => pattern.test(text))

/* ------------------------------------------------------------------ *
 * B. 外壳 / 白名单 / 布局（始终执行）
 * ------------------------------------------------------------------ */

console.log('\n== B. 外壳、preload 白名单与布局 ==')

// 应用可能刚启动（页面还在挂载），先等外壳与 preload 就绪再探测，
// 否则会把「还没渲染完」误报成「布局缺失」。
try {
  await waitFor(
    `(() => document.readyState === 'complete' && typeof window.api === 'object' && !!document.querySelector('[data-testid="chat-area"]'))()`,
    '应用外壳与 preload 就绪',
    20_000
  )
} catch (error) {
  info(`等待外壳就绪超时（继续探测并给出细节）：${describe(error)}`)
}

const PAGE_PROBE = `(() => {
  const el = document.querySelector('[data-testid="sidecar-status"]')
  const api = window.api
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').trim()
  const apiKeys = api && typeof api === 'object' ? Object.keys(api).sort() : []
  return {
    readyState: document.readyState,
    title: document.title,
    bodyTextLength: bodyText.length,
    bodyTextPreview: bodyText.slice(0, 120),
    hasUfffd: bodyText.includes('\\uFFFD'),
    apiType: typeof api,
    apiKeys,
    apiNonFunctions: api && typeof api === 'object'
      ? apiKeys.filter((key) => typeof api[key] !== 'function')
      : [],
    leakedGlobals: ${JSON.stringify(LEAKY_GLOBALS)}.filter((name) => typeof window[name] !== 'undefined'),
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
  '页面已渲染（body 有文本，不是白屏）',
  probe.bodyTextLength > 0,
  `body 文本长度 ${probe.bodyTextLength}${probe.bodyTextPreview ? `，开头：「${probe.bodyTextPreview}」` : ''}（readyState=${probe.readyState}）`
)
check('标题包含 K12', String(probe.title).includes('K12'), `document.title = "${probe.title}"`)

check(
  'window.api 已注入且必需方法齐备',
  probe.apiType === 'object' && REQUIRED_API_METHODS.every((name) => probe.apiKeys.includes(name)),
  `实际方法：${probe.apiKeys.join(', ') || '(空)'}；必需：${REQUIRED_API_METHODS.join(', ')}`
)

check(
  'window.api 上全是函数（没有把数据/对象直接漏出去）',
  Array.isArray(probe.apiNonFunctions) && probe.apiNonFunctions.length === 0,
  probe.apiNonFunctions?.length === 0 ? `${probe.apiKeys.length} 个成员都是函数` : `非函数成员：${probe.apiNonFunctions.join(', ')}`
)

check(
  'window.api 没有通用 IPC 口子（白名单之外的能力一律不存在）',
  FORBIDDEN_API_METHODS.every((name) => !probe.apiKeys.includes(name)),
  `实际方法：${probe.apiKeys.join(', ')}`
)

check(
  '渲染进程没有 Node / Electron 通用口子（只应有 window.api）',
  probe.leakedGlobals.length === 0,
  probe.leakedGlobals.length === 0
    ? `${LEAKY_GLOBALS.join(' / ')} 均不可见`
    : `可见：${probe.leakedGlobals.join(', ')}`
)

check(
  '对话优先布局到位（对话区 / 消息区 / 输入框 / 发送按钮 / 设置入口）',
  probe.hasChatArea && probe.hasChatLog && probe.hasComposer && probe.hasSendButton && probe.hasSettingsEntry,
  `chat-area=${probe.hasChatArea}，chat-log=${probe.hasChatLog}，composer=${probe.hasComposer}，send=${probe.hasSendButton}，settings=${probe.hasSettingsEntry}`
)

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
  check(
    '设置入口可进可出（对话优先布局）',
    openedSettings === true && backToChat === true,
    `打开设置=${openedSettings}，返回对话=${backToChat}`
  )
} catch (error) {
  check('设置入口可进可出（对话优先布局）', false, describe(error))
}

check(
  'sidecar 状态文案属于预期阶段',
  EXPECTED_PHASE_TEXT.includes(probe.statusText),
  `data-phase="${probe.statusPhase}"，文案="${probe.statusText || '(未找到 [data-testid=sidecar-status])'}"，期望其中之一：${EXPECTED_PHASE_TEXT.join(' / ')}`
)
check(
  'sidecar data-phase 取值合法',
  EXPECTED_PHASE_ATTR.includes(probe.statusPhase),
  `data-phase="${probe.statusPhase}"，期望其中之一：${EXPECTED_PHASE_ATTR.join(' / ')}`
)
if (probe.errorText) info(`页面上的错误行：「${probe.errorText}」`)

/* ------------------------------------------------------------------ *
 * B2. 是否已配置 API Key（决定后面走哪个世界）
 * ------------------------------------------------------------------ */

const keyProbe = await evaluate(`(async () => {
  if (!window.api || typeof window.api.readSettings !== 'function') {
    return { ok: false, reason: 'preload 没有 readSettings（设置通道未接线）' }
  }
  try {
    const result = await window.api.readSettings()
    if (!result || !result.ok) return { ok: false, reason: (result && result.message) || '读取设置失败' }
    const llm = result.data && result.data.llm ? result.data.llm : {}
    return { ok: true, hasKey: llm.hasKey === true, modelId: llm.modelId || '', baseUrl: llm.baseUrl || '' }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`)

let hasKey = false
let keyReason = ''
if (FORCED_HAS_KEY === '1' || FORCED_HAS_KEY === '0') {
  hasKey = FORCED_HAS_KEY === '1'
  keyReason = `环境变量 K12_VERIFY_HAS_KEY=${FORCED_HAS_KEY} 强制指定`
} else if (keyProbe?.ok) {
  hasKey = keyProbe.hasKey === true
  keyReason = `主进程读设置：hasKey=${keyProbe.hasKey}${keyProbe.modelId ? `，modelId=${keyProbe.modelId}` : ''}`
} else {
  keyReason = `读设置不可用（${keyProbe?.reason ?? '未知原因'}）→ 按「无 Key」处理`
}
info(`API Key 判定：${hasKey ? '已配置' : '未配置'}（${keyReason}）`)

/* ------------------------------------------------------------------ *
 * C. 只读学段指示器（始终执行）
 * ------------------------------------------------------------------ */

console.log('\n== C. 学段只读指示器（学生不能选学段）==')

const gradeProbe = await evaluate(`(() => {
  const indicator = document.querySelector('[data-testid="grade-indicator"]')
  if (!indicator) return { present: false }
  const controls = indicator.querySelectorAll(
    'button, select, input, textarea, [role="radio"], [role="radiogroup"], [role="listbox"], [role="option"]'
  )
  const text = (sel) => {
    const el = indicator.querySelector(sel)
    return el && el.textContent ? el.textContent.trim() : ''
  }
  return {
    present: true,
    determined: indicator.getAttribute('data-determined') || '',
    grade: indicator.getAttribute('data-grade') || '',
    origin: indicator.getAttribute('data-origin') || '',
    controlCount: controls.length,
    badgeText: text('[data-testid="grade-current-label"]'),
    hintText: text('[data-testid="grade-indicator-hint"]'),
    noticeText: text('[data-testid="grade-notice"]'),
    missingChannelNote: text('[data-testid="grade-indicator-note"]'),
    hasLegacySelector: !!document.querySelector('[data-testid="grade-selector"]'),
    hasLegacyOption: !!document.querySelector('[data-testid="grade-option"]')
  }
})()`)

if (gradeProbe?.present !== true) {
  check(
    '学段只读指示器在位（[data-testid=grade-indicator]）',
    false,
    '没找到指示器：学段是系统判定的，但「判定结果」必须在界面上可见，否则适配发生了也看不出来'
  )
} else {
  check('学段只读指示器在位（[data-testid=grade-indicator]）', true, `data-grade="${gradeProbe.grade}"，data-origin="${gradeProbe.origin}"`)
  check(
    '★ 指示器是只读的（内部没有任何控件：button / select / input / radio）',
    gradeProbe.controlCount === 0,
    `指示器内部控件数 = ${gradeProbe.controlCount}`
  )
  check(
    '★ 手动学段选择器已删除（grade-selector / grade-option 都不存在）',
    gradeProbe.hasLegacySelector === false && gradeProbe.hasLegacyOption === false,
    `grade-selector=${gradeProbe.hasLegacySelector}，grade-option=${gradeProbe.hasLegacyOption}`
  )
  check(
    '指示器文案可读（四学段中文名之一，或「待判定」）',
    GRADE_LABELS.includes(gradeProbe.badgeText) || gradeProbe.badgeText === GRADE_UNKNOWN_LABEL,
    `显示「当前：${gradeProbe.badgeText}」；旁边说明「${gradeProbe.hintText}」`
  )
  check(
    'data-determined 与 data-grade 自洽（判出来才有学段）',
    (gradeProbe.determined === 'true') === GRADE_LABELS.includes(gradeProbe.grade),
    `data-determined="${gradeProbe.determined}"，data-grade="${gradeProbe.grade}"`
  )
  if (gradeProbe.noticeText) {
    check(
      '学段变化提示可读（「我按…的说法来讲。」）',
      /^我按.+的说法来讲。$/.test(gradeProbe.noticeText),
      `提示文案：「${gradeProbe.noticeText}」`
    )
  }
  if (gradeProbe.grade === '' && gradeProbe.missingChannelNote) {
    info(
      '学段判定通道尚未接线（指示器显示「待判定」）：' +
        `${gradeProbe.missingChannelNote.slice(0, 80)}… —— 需要主进程提供 grade:changed 推送（见 src/renderer/src/api/grade.ts 的通道说明）`
    )
  }
}

/* ------------------------------------------------------------------ *
 * D. 无 Key 路径（仅无 Key 世界）—— 「能力受限」必须是可读的
 * ------------------------------------------------------------------ */

console.log('\n== D. 无 Key 路径（本轮以 error 收尾，但必须是可读的降级提示）==')

const probeMode = process.env.K12_OFFLINE_PROBE === '1'
const noKeyTimeout = probeMode ? probeTimeoutMs : noKeyTimeoutMs

if (hasKey) {
  skip(
    '无 Key 路径：一轮以「能力受限」收尾',
    '当前已配置 API Key（K12_VERIFY_HAS_KEY=1 或主进程报告 hasKey=true），本项不适用'
  )
} else {
  try {
    const before = await turnCount()
    await sendMessage('无 Key 冒烟：人工智能是怎么认出猫的？')
    const { samples, snapshot, timedOut } = await collectUntilTerminal(before, noKeyTimeout)

    if (timedOut) {
      check(
        '无 Key 路径：本轮能结束（不卡在「正在回答」）',
        false,
        `超过 ${noKeyTimeout}ms 仍未到终态；采样到的正文长度：${samples.join(' → ')}`
      )
    } else {
      check(
        '无 Key 路径：本轮能结束（不卡在「正在回答」）',
        snapshot.status !== 'streaming',
        `data-status=${snapshot.status}，状态文案="${snapshot.statusLabel}"（${Math.round(noKeyTimeout / 1000)}s 上限内收尾）`
      )
      check(
        '无 Key 路径：以 error 事件收尾（本轮没有生成内容）',
        snapshot.status === 'error',
        `data-status=${snapshot.status}（期望 error；正文长度 ${snapshot.text.length}）`
      )
      check(
        `无 Key 路径：给出「${DEGRADED_BADGE_TEXT}」提示（degraded === true）`,
        snapshot.errorBadge === DEGRADED_BADGE_TEXT,
        `错误徽章 = "${snapshot.errorBadge || '(缺失)'}"`
      )
      check(
        `无 Key 路径：提示是**可读中文原因**（${DEGRADED_NOTICE_MARKERS.join(' / ')}）`,
        DEGRADED_NOTICE_MARKERS.some((marker) => snapshot.errorText.includes(marker)) &&
          snapshot.errorText.length >= 12,
        `提示文案：「${snapshot.errorText.slice(0, 120)}」`
      )
      check(
        '无 Key 路径：提示不是堆栈 / 异常原文',
        snapshot.errorText.length > 0 && !looksLikeStack(snapshot.errorText),
        `未命中堆栈特征（${STACK_PATTERNS.length} 条判据）：「${snapshot.errorText.slice(0, 80)}」`
      )
      check(
        '无 Key 路径：界面没有乱码（无 U+FFFD）且不是白屏',
        !snapshot.errorText.includes('\uFFFD') && probe.bodyTextLength > 0,
        '错误文案与 body 文本均无替换字符'
      )
      check(
        '无 Key 路径：学生消息与本轮都留在消息区（旧轮不被清掉）',
        (await turnCount()) === before + 1 && snapshot.userText.includes('无 Key 冒烟'),
        `消息区轮次 = ${await turnCount()}（开始时 ${before} 轮）`
      )
    }
  } catch (error) {
    check('无 Key 路径：一轮以「能力受限」收尾', false, describe(error))
  }
}

/* ------------------------------------------------------------------ *
 * E. 内容断言（仅「已配置 API Key」世界）
 * ------------------------------------------------------------------ */

console.log('\n== E. 内容断言（delta / done / 卡片 kind，仅已配置 Key 时执行）==')

if (!hasKey) {
  skip(
    'delta 流式增长 / 终态 done / 卡片 kind 合法',
    '未配置 API Key：这些断言依赖真实模型回答，按设计跳过（不是失败）；配好 Key 后重跑即可覆盖'
  )
} else {
  try {
    const before = await turnCount()
    await sendMessage('请用一两句话讲讲：人工智能是怎么认出一只猫的？')
    const { samples, snapshot, timedOut } = await collectUntilTerminal(before, contentTimeoutMs)
    if (timedOut) {
      check('delta：本轮在超时前结束', false, `超过 ${contentTimeoutMs}ms 仍在 streaming；采样：${samples.join(' → ')}`)
    } else {
      const distinct = [...new Set(samples.filter((length) => length > 0))]
      check(
        'delta：正文是「流」而不是一次性插入（长度多次增长）',
        snapshot.status === 'done' || distinct.length >= 2,
        `采样到的正文长度：${samples.join(' → ')}`
      )
      check(
        'done：本轮以 done 收尾（不是 error / 卡住）',
        snapshot.status === 'done',
        `data-status=${snapshot.status}，状态文案="${snapshot.statusLabel}"`
      )
      check(
        '正文可读（有实际内容、无 U+FFFD）',
        snapshot.text.trim().length > 0 && !snapshot.text.includes('\uFFFD'),
        `正文长度 ${snapshot.text.length}，开头：「${snapshot.text.trim().slice(0, 60)}」`
      )
      const illegalKinds = snapshot.cardKinds.filter((kind) => !EXPECTED_CARD_KINDS.includes(kind))
      check(
        'payload：出现的卡片 kind 合法（animation / coding / quiz）',
        illegalKinds.length === 0,
        `本轮卡片 kind：[${snapshot.cardKinds.join(', ') || '(本轮没有卡片)'}]`
      )
      if (snapshot.citations > 0) {
        check('citation：来源标签渲染出来（含向上兼容标注时单独标注）', true, `来源标签 ${snapshot.citations} 条，其中「向上兼容」${snapshot.compatCitations} 条`)
      } else {
        info('citation：本轮没有触发检索（模型没有调 rag_search）—— 卡片与来源都取决于模型这一轮的动作，这里不做硬断言')
      }
    }
  } catch (error) {
    check('内容断言（delta / done / 卡片 kind）', false, describe(error))
  }
}

/* ------------------------------------------------------------------ *
 * F. 练习卡片（真实形状的 payload 事件 → 真实归约器 → 真实 DOM）
 * ------------------------------------------------------------------ */

console.log('\n== F. 练习卡片渲染（payload 事件 → 卡片 → 逐题反馈 / 掌握度）==')

/** 从真实题库文件取一道题，投影成**对外形态**（丢掉 answer，保留 explanation 之外的说明）。 */
function readBankQuestion(gradeBankPath, type) {
  const absolute = join(REPO_ROOT, gradeBankPath)
  if (!existsSync(absolute)) scriptError(`读不到题库文件：${gradeBankPath}`)
  const bank = JSON.parse(readFileSync(absolute, 'utf8'))
  const question = (bank.questions ?? []).find((item) => item.type === type)
  if (!question) scriptError(`题库 ${gradeBankPath} 里没有 ${type} 题型（练习卡片的渲染断言需要它）`)
  return {
    out: {
      qid: question.qid,
      kpId: question.kp_id,
      type: question.type,
      stem: question.stem,
      options: question.options ?? null,
      // explanation 是后端为了让模型组织语言才带的：**卡片不许渲染它**（里面常直接写着答案）
      explanation: question.explanation ?? ''
    },
    answer: question.answer
  }
}

const choiceSource = readBankQuestion('server/resources/quizbank/junior.json', 'choice')
const blankSource = readBankQuestion('server/resources/quizbank/junior.json', 'blank')
const codeBlankSource = readBankQuestion('server/resources/quizbank/junior.json', 'code_blank')

/** `generate_quiz` 的 `details`（= payload 事件的 payload），形状与 `quiz.ts` 的 `QuizPayloadShape` 一致。 */
const quizPayloadEvent = {
  name: 'payload',
  data: {
    requestId: 'verify-quiz-questions',
    kind: 'quiz',
    payload: {
      kpId: choiceSource.out.kpId,
      source: 'bank',
      questions: [choiceSource.out, blankSource.out, codeBlankSource.out],
      // 事件层附加的两个提示字段（`agent/events.ts` 的 readPayload）
      tool: 'generate_quiz',
      kind: 'quiz'
    }
  }
}
/** `submit_quiz` 的 `details`（= 批改结果载荷）。 */
const quizResultEvent = {
  name: 'payload',
  data: {
    requestId: 'verify-quiz-result',
    kind: 'quiz',
    payload: {
      qid: choiceSource.out.qid,
      correct: true,
      scoredBy: 'rule',
      feedback: '答对了！能被量出来、又能区分对象的数值才适合当特征。',
      masteryDelta: 0.15,
      tool: 'submit_quiz',
      kind: 'quiz'
    }
  }
}

/**
 * 把两条 payload 事件注入**渲染进程自己的事件归约器**（`applyChatEvent`）并落到 store。
 *
 * 为什么可以这么做：`applyChatEvent` 是纯函数，事件对象与主进程推来的**逐字段一致**；
 * 这条路径经过真实的 store 与真实的 `QuizCard.vue`，只有「谁把事件递进来」不同
 * （无 Key 时模型不会调用 generate_quiz，只能这样驱动渲染侧）。
 * 模块 URL 依赖 dev 模式的 Vite 模块图，打包产物下拿不到（返回 skipped）。
 */
const INJECTION = `(async () => {
  const candidates = ['/src/api/events.ts', '/src/renderer/src/api/events.ts']
  let events = null
  let modulesLoadedFrom = ''
  for (const path of candidates) {
    try {
      events = await import(/* @vite-ignore */ path)
      modulesLoadedFrom = path
      break
    } catch (error) {
      events = null
    }
  }
  if (!events) return { ok: false, reason: '取不到渲染进程模块图（不是 dev 模式？）' }

  const storeCandidates = ['/src/stores/chat.ts', '/src/renderer/src/stores/chat.ts']
  let stores = null
  for (const path of storeCandidates) {
    try {
      stores = await import(/* @vite-ignore */ path)
      break
    } catch (error) {
      stores = null
    }
  }
  if (!stores || typeof stores.useChatStore !== 'function') {
    return { ok: false, reason: '取不到 stores/chat.ts（不是 dev 模式？）' }
  }

  const chat = stores.useChatStore()
  const questionsEvent = ${JSON.stringify(quizPayloadEvent)}
  const resultEvent = ${JSON.stringify(quizResultEvent)}

  // 第 1 轮：题目卡片（与主进程推来的 payload 事件逐字段一致）
  let state = events.startTurn(chat.conversation, questionsEvent.data.requestId, '帮我出两道题练一练', chat.currentGrade ?? null)
  state = events.applyChatEvent(state, questionsEvent)
  state = events.applyChatEvent(state, { name: 'done', data: { requestId: questionsEvent.data.requestId, messageId: 'verify-quiz-1' } })
  // 第 2 轮：批改结果（跨轮回来，题目卡片要能按 qid 认领它）
  state = events.startTurn(state, resultEvent.data.requestId, '【练习作答】我做完这道题了，请帮我批改。', chat.currentGrade ?? null)
  state = events.applyChatEvent(state, resultEvent)
  state = events.applyChatEvent(state, { name: 'done', data: { requestId: resultEvent.data.requestId, messageId: 'verify-quiz-2' } })

  chat.conversation = state
  return { ok: true, modulesLoadedFrom, requestId: questionsEvent.data.requestId }
})()`

let injected = null
try {
  injected = await evaluate(INJECTION)
} catch (error) {
  injected = { ok: false, reason: describe(error) }
}

if (injected?.ok !== true) {
  const message = `注入 payload 事件失败：${injected?.reason ?? '未知原因'}`
  if (isDevServer) {
    check('练习卡片：payload 事件驱动渲染（题目 / 作答 / 反馈）', false, message)
  } else {
    skip('练习卡片：payload 事件驱动渲染', `${message}（当前不是 dev 服务，无法驱动渲染进程模块图）`)
  }
} else {
  try {
    await waitFor(
      `(() => document.querySelectorAll('[data-testid="quiz-card"]').length >= 1)()`,
      '练习卡片出现在消息区',
      5000
    )

    const quizProbe = await evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="quiz-card"]'))
      const card = cards[cards.length - 1]
      const questions = Array.from(card.querySelectorAll('[data-testid="quiz-question"]'))
      const text = (el, sel) => {
        const node = el.querySelector(sel)
        return node && node.textContent ? node.textContent.trim() : ''
      }
      return {
        cardCount: cards.length,
        questionCount: questions.length,
        types: questions.map((item) => item.getAttribute('data-type') || ''),
        qids: questions.map((item) => item.getAttribute('data-qid') || ''),
        stems: questions.map((item) => text(item, '[data-testid="quiz-stem"]')),
        typeLabels: questions.map((item) => text(item, '[data-testid="quiz-type"]')),
        optionCounts: questions.map((item) => item.querySelectorAll('[data-testid="quiz-option"]').length),
        blankInputs: card.querySelectorAll('[data-testid="quiz-blank"]').length,
        codeBlankInputs: card.querySelectorAll('[data-testid="quiz-code-blank"]').length,
        submitButtons: card.querySelectorAll('[data-testid="quiz-submit"]').length,
        feedbackBlocks: card.querySelectorAll('[data-testid="quiz-feedback"]').length,
        verdicts: Array.from(card.querySelectorAll('[data-testid="quiz-verdict"]')).map((el) => el.textContent.trim()),
        mastery: Array.from(card.querySelectorAll('[data-testid="quiz-mastery"]')).map((el) => el.textContent.trim()),
        feedbackTexts: Array.from(card.querySelectorAll('[data-testid="quiz-feedback-text"]')).map((el) => el.textContent.trim()),
        // ★ 答案泄漏防线的界面侧证据：整个页面文本里不许出现标准答案与解析
        pageText: document.body.innerText || '',
        domAttributes: Array.from(card.querySelectorAll('*'))
          .flatMap((el) => Array.from(el.attributes).map((attr) => attr.name + '=' + attr.value))
          .join(' | ')
      }
    })()`)

    check(
      '练习卡片：题目渲染出来（3 道题，题型标签正确）',
      quizProbe.questionCount === 3 &&
        JSON.stringify(quizProbe.types) === JSON.stringify(['choice', 'blank', 'code_blank']) &&
        JSON.stringify(quizProbe.typeLabels) === JSON.stringify(['选择题', '填空题', '代码填空']),
      `题目 ${quizProbe.questionCount} 道，题型 ${quizProbe.types.join(' / ')}，标签「${quizProbe.typeLabels.join('、')}」`
    )
    check(
      '练习卡片：题干是题库原文（不是占位文字）',
      quizProbe.stems[0] === choiceSource.out.stem && quizProbe.stems[0].length > 5,
      `第 1 题题干：「${quizProbe.stems[0].slice(0, 40)}…」`
    )
    check(
      '练习卡片：选择题渲染全部选项（可作答）',
      quizProbe.optionCounts[0] === (choiceSource.out.options ?? []).length && quizProbe.optionCounts[0] >= 2,
      `选项数 = ${quizProbe.optionCounts[0]}（题库里 ${(choiceSource.out.options ?? []).length} 个）`
    )
    check(
      '练习卡片：填空 / 代码填空各有输入框',
      quizProbe.blankInputs >= 1 && quizProbe.codeBlankInputs >= 1,
      `填空输入框 ${quizProbe.blankInputs} 个，代码填空输入框 ${quizProbe.codeBlankInputs} 个`
    )
    check(
      '练习卡片：每题都有提交按钮（作答入口）',
      quizProbe.submitButtons === 3,
      `提交按钮 ${quizProbe.submitButtons} 个`
    )
    check(
      '★ 逐题反馈：批改结果跨轮回来后，落在对应的题目下面',
      quizProbe.feedbackBlocks >= 1 &&
        quizProbe.verdicts.includes('答对了') &&
        quizProbe.feedbackTexts.some((text) => text.includes('答对了')),
      `反馈块 ${quizProbe.feedbackBlocks} 个，判定「${quizProbe.verdicts.join(', ')}」`
    )
    check(
      '★ 掌握度变化显示出来（掌握度 +0.15）',
      quizProbe.mastery.includes('掌握度 +0.15'),
      `掌握度标签：${quizProbe.mastery.join(', ') || '(缺失)'}`
    )

    // ★★ 答案泄漏防线：标准答案与解析都不许出现在界面（文本与属性一起查）
    const blankAnswer = Array.isArray(blankSource.answer) ? blankSource.answer : [blankSource.answer]
    const leaked = [
      { label: '填空题标准答案', value: blankAnswer[0] },
      { label: '填空题解析（含答案）', value: blankSource.out.explanation },
      { label: '选择题解析（含答案）', value: choiceSource.out.explanation }
    ].filter((item) => typeof item.value === 'string' && item.value.length > 3)
    const leakedHits = leaked.filter(
      (item) => quizProbe.pageText.includes(item.value) || quizProbe.domAttributes.includes(item.value)
    )
    check(
      '★★ 答案不泄漏到界面（标准答案 / 解析既不在文本里，也不在属性里）',
      leakedHits.length === 0,
      leakedHits.length === 0
        ? `已检查 ${leaked.length} 条敏感文本（题库答案 + 解析），界面里 0 命中`
        : `泄漏：${leakedHits.map((item) => item.label).join('、')}`
    )

    // 作答 → 提交：走真实的聊天链路（无 Key 时本轮会以 error 收尾，这不影响卡片的断言）
    const beforeSubmit = await turnCount()
    const submitted = await evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('[data-testid="quiz-card"]')).pop()
      if (!card) return { ok: false, reason: '找不到练习卡片' }
      const option = card.querySelector('[data-testid="quiz-option"] input[type="radio"]')
      if (!option) return { ok: false, reason: '找不到选择题选项' }
      option.click()
      const button = card.querySelector('[data-testid="quiz-submit"]')
      if (!button) return { ok: false, reason: '找不到提交按钮' }
      button.click()
      return { ok: true }
    })()`)
    if (submitted?.ok !== true) {
      check('练习卡片：选中选项后可以提交作答', false, submitted?.reason ?? '点击失败')
    } else {
      const submittedTurn = await waitFor(
        `(() => {
          const turns = document.querySelectorAll('[data-testid="chat-turn"]')
          const last = turns[turns.length - 1]
          if (!last) return null
          const user = last.querySelector('[data-testid="user-message"]')
          const text = user && user.textContent ? user.textContent.trim() : ''
          return text.includes('【练习作答】') ? text : null
        })()`,
        '提交后出现「【练习作答】…」的学生消息',
        10_000
      )
      check(
        '练习卡片：提交把「题号 + 作答」交给主 Agent（前端不判分）',
        typeof submittedTurn === 'string' && submittedTurn.includes(choiceSource.out.qid),
        `学生消息：「${String(submittedTurn).slice(0, 90)}…」（轮次 ${beforeSubmit} → ${await turnCount()}）`
      )
      // 提交这一轮由主进程回应（无 Key 时是能力受限提示，有 Key 时是真批改）——不在此断言内容
    }
  } catch (error) {
    check('练习卡片：payload 事件驱动渲染（题目 / 作答 / 反馈）', false, describe(error))
  }
}

/* ------------------------------------------------------------------ *
 * G. 全局收尾断言
 * ------------------------------------------------------------------ */

console.log('\n== G. 全局 ==')

// 报告素材：`K12_UI_DUMP=1` 时把关键区域的**真实 DOM 文本**打出来
// （本机截图不可靠：受前台窗口 / DPI 影响，经常截到别的窗口）
if (process.env.K12_UI_DUMP === '1') {
  try {
    const dump = await evaluate(`(() => {
      const text = (sel) => {
        const el = document.querySelector(sel)
        return el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '(缺失)'
      }
      const card = Array.from(document.querySelectorAll('[data-testid="quiz-card"]')).pop()
      return {
        indicator: text('[data-testid="grade-indicator"]'),
        chatTail: (document.querySelector('[data-testid="chat-log"]') || {}).innerText || '',
        quizCard: card ? card.innerText.replace(/\\s*\\n\\s*/g, ' | ').slice(0, 900) : '(本轮没有练习卡片)',
        lastTurn: text('[data-testid="chat-turn"]:last-of-type')
      }
    })()`)
    console.log('\n[DOM] 学段指示器：', dump.indicator)
    console.log('[DOM] 练习卡片（题目 + 逐题反馈 + 掌握度）：', dump.quizCard)
    console.log('[DOM] 对话区尾部（最后一轮）：', String(dump.lastTurn).slice(0, 300))
  } catch (error) {
    info(`DOM 证据导出失败（不影响断言）：${describe(error)}`)
  }
}

try {
  const bodyHasUfffd = await evaluate(`(() => (document.body.innerText || '').includes('\\uFFFD'))()`)
  check('全文没有 U+FFFD（中文没有乱码）', bodyHasUfffd === false, `body.innerText 里出现替换字符 = ${bodyHasUfffd}`)
} catch (error) {
  check('全文没有 U+FFFD（中文没有乱码）', false, describe(error))
}

check(
  '整轮交互期间渲染进程没有未捕获异常 / 控制台错误',
  pageErrors.length === 0,
  pageErrors.length === 0 ? '未捕获异常与控制台错误均为 0' : pageErrors.slice(0, 3).join(' ｜ ')
)

socket.close()

/* ------------------------------------------------------------------ *
 * H. 汇总
 * ------------------------------------------------------------------ */

console.log(
  `\n结果：通过 ${results.passed} 项，失败 ${results.failed} 项，跳过 ${results.skipped} 项` +
    `（世界：${hasKey ? '已配置 API Key' : '无 Key'}${probeMode ? ' + 离线探针' : ''}）`
)
if (results.skipped > 0) {
  console.log('跳过项的说明见上方的 [SKIP] 行（跳过 = 该世界下不适用，不算失败）。')
}

if (results.failed > 0) {
  console.log(`\n失败清单：${failures.join('、')}`)
  process.exit(1)
}

console.log('\n结果：全部通过')
process.exit(0)
