/**
 * S02 端到端验收：真实 Electron + 真实 sidecar，用 CDP 读真实 DOM 断言。
 *
 * 为什么必须做这一层（单测/接口测试都不够）：
 * 1. **token 只在运行期存在**（每次启动随机生成），单测里是假的；
 * 2. **CORS 只在真实浏览器语义下生效**——`file://` 页面发 `Origin: null`，
 *    单测用 TestClient 根本走不到这条路径，中间件写错也测不出来；
 * 3. **中文跨 chunk 解码**只有真实网络分片才会暴露；
 * 4. **设置持久化**要跨"真实文件 + 重启读取"才算数。
 *
 * 用法（另开一个终端先起 dev；脚本自己不做进程管理）：
 *   K12_DEBUG_PORT=9222 npm run dev
 *   node scripts/verify-s02.mjs
 *
 * 退出码 0 = 全部断言通过。
 */

const DEBUG_BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'
const TIMEOUT_MS = 90_000
const POLL_MS = 400
/** 灌进设置页的假 key（**不是真凭据**，仅用于验证脱敏链路）。 */
const FAKE_KEY = 'sk-e2e-verify-abcdefghijklmnop1234'

const failures = []
const passes = []

function check(name, condition, detail = '') {
  if (condition) {
    passes.push(name)
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(name)
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// --------------------------------------------------------------------------
// CDP 客户端
// --------------------------------------------------------------------------

async function findPage() {
  const res = await fetch(`${DEBUG_BASE}/json/list`)
  const targets = await res.json()
  return targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
}

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
      pending.set(id, (msg) =>
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      )
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { send, close: () => ws.close() }
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到表达式为真（返回其值），超时抛错。 */
async function waitFor(cdp, expression, label, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression)
    if (last) return last
    await sleep(POLL_MS)
  }
  throw new Error(`等待超时：${label}（最后取值 ${JSON.stringify(last)?.slice(0, 200)}）`)
}

// --------------------------------------------------------------------------
// 断言集
// --------------------------------------------------------------------------

/** 等界面进入就绪态（Dashboard 出现）。 */
const READY_EXPR = `(() => {
  const t = document.body.innerText || ''
  return t.includes('运行状态') && t.includes('握手成功')
})()`

async function stepReadyState(cdp) {
  console.log('\n=== 1. 后端就绪与握手 ===')
  await waitFor(cdp, READY_EXPR, '界面进入就绪态')

  const state = JSON.parse(
    await evaluate(
      cdp,
      `JSON.stringify({
        body: document.body.innerText,
        navItems: Array.from(document.querySelectorAll('.nav-item')).map(b => b.querySelector('.nav-label')?.textContent?.trim()),
        port: (document.body.innerText.match(/port=(\\d{2,5})/) || [])[1] || ''
      })`
    )
  )

  check('界面显示「运行状态」（S02 导航壳生效）', state.body.includes('运行状态'))
  check('界面显示握手端口', /^\d{2,5}$/.test(state.port), `port=${state.port}`)
  check(
    '三个导航项就位（状态/设置/流式自检）',
    ['状态', '设置', '流式自检'].every((n) => state.navItems.includes(n)),
    state.navItems.join(' / ')
  )
  return state
}

/** 用页面内 fetch 打后端（带真实 token），验证鉴权与中文。 */
async function stepBackendProbe(cdp) {
  console.log('\n=== 2. 真实 token 鉴权（页面内 fetch 走真实 CORS）===')
  const result = JSON.parse(
    await evaluate(
      cdp,
      `(async () => {
        const info = await window.api.getSidecarInfo()
        if (!info?.port) return JSON.stringify({ error: '拿不到 sidecar 端口' })
        const base = 'http://127.0.0.1:' + info.port
        const noToken = await fetch(base + '/api/settings').then(r => r.status).catch(e => 'err:' + e.message)
        const badToken = await fetch(base + '/api/settings', { headers: { 'X-Auth-Token': 'nope' } }).then(r => r.status).catch(e => 'err:' + e.message)
        const good = await fetch(base + '/api/settings', { headers: { 'X-Auth-Token': info.token } })
        const body = good.ok ? await good.json() : null
        const meta = await fetch(base + '/api/meta', { headers: { 'X-Auth-Token': info.token } }).then(r => r.ok ? r.json() : null)
        return JSON.stringify({ noToken, badToken, goodStatus: good.status, body, meta })
      })()`
    )
  )

  check('无 token → 401（真实 CORS 路径）', result.noToken === 401, String(result.noToken))
  check('错 token → 401', result.badToken === 401, String(result.badToken))
  check('正确 token → 200', result.goodStatus === 200, String(result.goodStatus))
  check('embeddingMode 默认 local_fastembed', result.body?.embedding?.mode === 'local_fastembed')
  check(
    '中文经 HTTP 全程无乱码（/api/meta）',
    result.meta?.appName === 'K12 AI 教学助手',
    JSON.stringify(result.meta?.appName)
  )
  check('嵌入模型 ID 可读', typeof result.meta?.embeddingModelId === 'string' && result.meta.embeddingModelId.length > 0, result.meta?.embeddingModelId)
  return result
}

/** 走真实 UI 保存设置。 */
async function stepSettingsSave(cdp) {
  console.log('\n=== 3. 设置页保存与脱敏回显 ===')
  await evaluate(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('设置'))
      btn.click()
      return true
    })()`
  )
  await waitFor(cdp, `document.body.innerText.includes('模型供应商') || document.body.innerText.includes('主模型')`, '设置页渲染')

  // 等设置加载完成（providerName 有值）
  await waitFor(
    cdp,
    `(document.querySelector('input')?.value || '').length > 0`,
    '设置加载完成'
  )

  const before = JSON.parse(
    await evaluate(
      cdp,
      `JSON.stringify({
        inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, value: i.value })),
        hasKeyTag: document.body.innerText.includes('未配置') || document.body.innerText.includes('已配置'),
        leaksMaskedIntoInput: Array.from(document.querySelectorAll('input')).some(i => i.type === 'password' && i.value.length > 0)
      })`
    )
  )
  check('设置页有输入框', before.inputs.length >= 4, `${before.inputs.length} 个`)
  check('显示 Key 配置状态标签', before.hasKeyTag)
  check('★ 密码框初始为空（掩码不回填进输入框）', before.leaksMaskedIntoInput === false)

  // 填表并保存（用原生 setter 触发 v-model）
  const fill = JSON.parse(
    await evaluate(
      cdp,
      `(async () => {
        const setVal = (el, v) => {
          const proto = Object.getPrototypeOf(el)
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
          desc.set.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const inputs = Array.from(document.querySelectorAll('input'))
        const urlInput = inputs.find(i => i.type === 'url') || inputs[3]
        const pwd = inputs.find(i => i.type === 'password')
        setVal(urlInput, 'https://api.example.com/v1')
        setVal(pwd, ${JSON.stringify(FAKE_KEY)})
        await new Promise(r => setTimeout(r, 60))
        const saveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '保存')
        if (!saveBtn) return JSON.stringify({ error: '找不到保存按钮' })
        saveBtn.click()
        // 等保存完成（提示出现 / 错误消失）
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 150))
          const t = document.body.innerText
          if (t.includes('已保存')) return JSON.stringify({ ok: true, text: t })
          if (t.includes('失败') || t.includes('错误')) return JSON.stringify({ ok: false, text: t.slice(0, 300) })
        }
        return JSON.stringify({ ok: false, text: '保存后未见反馈：' + document.body.innerText.slice(0, 300) })
      })()`
    )
  )
  check('点击保存后得到成功反馈', fill.ok === true, fill.ok ? '' : fill.text)

  const after = JSON.parse(
    await evaluate(
      cdp,
      `JSON.stringify({
        text: document.body.innerText,
        pwdValues: Array.from(document.querySelectorAll('input')).filter(i => i.type === 'password').map(i => i.value),
        bodyHasKey: document.body.innerText.includes(${JSON.stringify(FAKE_KEY)})
      })`
    )
  )
  check('★ 保存后界面不出现明文 Key', after.bodyHasKey === false)
  check('★ 保存后密码框被清空（不会把 key 留在 DOM）', after.pwdValues.every((v) => v === ''), JSON.stringify(after.pwdValues))
  check('显示「已配置」标签', after.text.includes('已配置'))
  check('掩码可见', /…1234/.test(after.text), (after.text.match(/…\w+/) || [])[0] ?? '')
}

/** SSE 六种事件逐条到达（真实流）。 */
async function stepSseAllEvents(cdp) {
  console.log('\n=== 4. SSE 六种事件（真实 fetch + ReadableStream）===')
  await evaluate(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('流式自检'))
      btn.click()
      return true
    })()`
  )
  await waitFor(cdp, `document.body.innerText.includes('流式管道自检')`, '自检页渲染')

  await evaluate(
    cdp,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('全事件模式'))
      btn.click()
      return true
    })()`
  )

  // 等 6 种事件全部收到
  const coverage = JSON.parse(
    await waitFor(
      cdp,
      `(() => {
        const t = document.body.innerText
        const m = t.match(/(\\d) \\/ 6/)
        if (!m || m[1] !== '6') return ''
        // ★ 乱码检查只看**流式正文**（.stream），不能扫全页：
        //   页面上那句"若出现 � 说明…"的静态提示本身就含 U+FFFD。
        const streamText = (document.querySelector('.stream') || {}).textContent || ''
        return JSON.stringify({
          text: t,
          summary: m[0],
          streamText,
          hasBrokenChar: streamText.includes('\\uFFFD')
        })
      })()`,
      '6 种事件全部到达'
    )
  )

  check('★ 6 种事件全部收到（6/6）', coverage.summary === '6 / 6', coverage.summary)
  check('★ 流式正文无乱码替换字符', coverage.hasBrokenChar === false, JSON.stringify(coverage.streamText?.slice(0, 40)))
  check('事件日志逐条可见', /事件日志/.test(coverage.text))
  // 注意：DOM 里是 <dt>requestId</dt><dd>xxx</dd>，innerText 用换行分隔、没有冒号
  check('显示 requestId', /requestId/.test(coverage.text))
  check('显示 messageId（done 事件已收）', /messageId/.test(coverage.text))
  check('error 事件显示 degraded=true', /degraded=true/.test(coverage.text))
  check('blocked 事件显示安全替换话术', /安全拦截/.test(coverage.text))
  check('累积正文含完整中文句子', coverage.streamText.includes('循环会重复执行同一段代码'))

  // 停止功能：重新起一条慢流并中断
  const stopped = JSON.parse(
    await evaluate(
      cdp,
      `(async () => {
        const norm = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('正常流'))
        norm.click()
        // ★ 必须等「停止」按钮真的可用：上一轮流刚结束时按钮还是 disabled 状态
        let stop = null
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 100))
          stop = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '停止')
          if (stop && !stop.disabled) break
        }
        if (!stop || stop.disabled) {
          return JSON.stringify({ error: '停止按钮始终不可用：流可能已经结束（interval 太小）' })
        }
        stop.click()
        await new Promise(r => setTimeout(r, 600))
        return JSON.stringify({ text: document.body.innerText })
      })()`
    )
  )
  check('★ 流进行中可「停止」（中断生效）', stopped.text?.includes('已手动停止'), stopped.error ?? '')
}

/** 重启后端 → token 轮换后前端仍能工作（不缓存 token 的验证）。 */
async function stepRestartRecovers(cdp) {
  console.log('\n=== 5. 后端重启后前端自愈（token 轮换）===')
  const before = JSON.parse(await evaluate(cdp, `window.api.getSidecarInfo().then(i => JSON.stringify(i))`))
  check('重启前有端口与 token', !!before?.port && !!before?.token, `port=${before?.port}`)

  await evaluate(cdp, `window.api.restartSidecar().then(() => true)`)

  const after = JSON.parse(
    await waitFor(
      cdp,
      `window.api.getSidecarInfo().then(i => (i && i.phase === 'ready') ? JSON.stringify(i) : '')`,
      '重启后重新就绪'
    )
  )
  check('重启后重新就绪', after.phase === 'ready', after.phase)
  check(
    '★ token 已轮换（未被前端缓存）',
    after.token !== before.token,
    `${before.token.slice(0, 8)}… → ${after.token.slice(0, 8)}…`
  )

  // 用新 token 再打一次受保护接口，证明前端拿到的是新凭据
  const probe = JSON.parse(
    await evaluate(
      cdp,
      `(async () => {
        const i = await window.api.getSidecarInfo()
        const r = await fetch('http://127.0.0.1:' + i.port + '/api/settings', { headers: { 'X-Auth-Token': i.token } })
        return JSON.stringify({ status: r.status })
      })()`
    )
  )
  check('重启后用新 token 访问成功', probe.status === 200, `HTTP ${probe.status}`)
  check('重启计数已记录', after.restarts >= 1, `restarts=${after.restarts}`)
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS
  let page = null
  while (Date.now() < deadline) {
    page = await findPage()
    if (page) break
    await sleep(POLL_MS)
  }
  if (!page) throw new Error('未找到可调试的渲染进程（确认已用 K12_DEBUG_PORT 启动 dev）')

  const cdp = await connect(page.webSocketDebuggerUrl)
  try {
    await stepReadyState(cdp)
    await stepBackendProbe(cdp)
    await stepSettingsSave(cdp)
    await stepSseAllEvents(cdp)
    await stepRestartRecovers(cdp)
  } finally {
    cdp.close()
  }

  console.log(`\n${'='.repeat(64)}`)
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败 / 共 ${passes.length + failures.length} 项`)
    for (const f of failures) console.error(`   - ${f}`)
    process.exit(1)
  }
  console.log(`✓ 全部 ${passes.length} 项通过`)
}

main().catch((err) => {
  console.error(`\n校验脚本异常：${err.message}`)
  process.exit(2)
})
