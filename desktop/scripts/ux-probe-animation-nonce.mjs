/**
 * 探针：动画讲解页的「一次性托管地址被取第二次」缺陷（P-131 的同类残留）。
 *
 * 跑法：`K12_DEBUG_PORT=9222 npm run dev` 之后，另一个终端 `node scripts/ux-probe-animation-nonce.mjs`
 *
 * 为什么需要它：动画资源的托管地址是**一次性 nonce**（服务端 `NonceStore.consume` 消费即废）。
 * 只要同一个地址被取第二次，iframe 里就会渲染出一段 JSON 报错
 * （`{"detail":"动画资源未通过 nonce 校验（used）"}`）——学生直接看到这串字。
 * 单测钉不住这类缺陷（它发生在浏览器与 KeepAlive 的生命周期里），所以用真机探针量：
 *   · Network 域数 `/resources/animation` 的**每一次**请求与状态码；
 *   · 每次切页往返后读舞台的 `data-state` 与 frame 的 `src`/`srcdoc`；
 *   · 结论判据是「同一个 URL 有没有被取两次（第二次 403）」。
 *
 * 退出码：0 = 没发现二次取用；1 = 发现（含 403）；2 = 脚本自身出错。
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'

class Cdp {
  #ws
  #id = 0
  #pending = new Map()
  /** 收到的 CDP 事件回调（method → handlers）。 */
  #listeners = new Map()

  static async attach() {
    const list = await (await fetch(`${BASE}/json/list`)).json()
    const page = list.find((i) => i.type === 'page')
    if (!page) throw new Error('找不到 page 目标')
    const cdp = new Cdp()
    await cdp.#connect(page.webSocketDebuggerUrl)
    return cdp
  }

  async #connect(url) {
    this.#ws = new WebSocket(url)
    await new Promise((res, rej) => {
      this.#ws.addEventListener('open', res, { once: true })
      this.#ws.addEventListener('error', () => rej(new Error('连接失败')), { once: true })
    })
    this.#ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id === undefined) {
        for (const handler of this.#listeners.get(m.method) ?? []) handler(m.params)
        return
      }
      const slot = this.#pending.get(m.id)
      if (!slot) return
      this.#pending.delete(m.id)
      m.error ? slot.reject(new Error(JSON.stringify(m.error))) : slot.resolve(m.result)
    })
  }

  on(method, handler) {
    const list = this.#listeners.get(method) ?? []
    list.push(handler)
    this.#listeners.set(method, list)
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((res, rej) => {
      this.#pending.set(id, { resolve: res, reject: rej })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result?.value
  }

  /**
   * 让渲染器真的在渲染。
   *
   * 窗口在后台时 Chromium 会停掉渲染生命周期（`visibilityState === 'hidden'`），
   * 而「隐藏的 iframe 文档会不会被丢弃」正是本探针要量的东西 —— 测量环境必须与
   * 学生用的时候一致（前台可见）。三个方法里中一个就够，逐个试。
   */
  async ensureRendering() {
    for (const [method, params] of [
      ['Page.bringToFront', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.setWebLifecycleState', { state: 'active' }]
    ]) {
      try {
        await this.send(method, params)
      } catch {
        // 旧 CDP 上不存在：继续试下一个
      }
    }
    return this.evaluate('document.visibilityState')
  }

  close() {
    this.#ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 所有动画资源请求（按发现顺序），以及 url → 最后一次响应状态。 */
const requests = []
const statuses = new Map()

let passed = 0
const findings = []

function check(what, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  \u001b[32m✓\u001b[0m ${what}${detail ? `  \u001b[2m(${detail})\u001b[0m` : ''}`)
  } else {
    findings.push({ what, detail })
    console.log(`  \u001b[31m✗\u001b[0m ${what}`)
    if (detail) console.log(`      实测：${detail}`)
  }
}

/**
 * 切到某一页（按侧栏文字点）。
 *
 * ★ 找不到那颗按钮就**抛**（→ 退出码 2）：页面没打开时的「0 次请求」不是通过，是**没测**。
 *   这类假绿正是本探针要防的东西（见 P-138）。
 */
async function goto(cdp, label) {
  const clicked = await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('aside button, nav button'))
      .find((x) => (x.innerText || '').trim().startsWith(${JSON.stringify(label)}))
    if (b) { b.click(); return true }
    return false
  })()`)
  if (!clicked) throw new Error(`找不到侧栏页面「${label}」——探针的前提不成立，本次读数全部作废`)
  await sleep(900)
}

/** 舞台读数：state、frame 的 src/srcdoc、沙箱是否真就绪。 */
function stageProbe(cdp) {
  return cdp.evaluate(`(() => {
    const stage = document.querySelector('[data-testid="animation-view-stage"]')
    const frame = document.querySelector('[data-testid="animation-view-frame"]')
    const frames = Array.from(document.querySelectorAll('iframe'))
    return {
      state: stage?.getAttribute('data-state') ?? null,
      hasFrame: frame !== null,
      frameSrc: frame?.getAttribute('src') ?? null,
      frameSrcdocLen: (frame?.getAttribute('srcdoc') ?? '').length,
      frameResource: frame?.getAttribute('data-resource') ?? null,
      frameCount: frames.length,
      allIframeSrcs: frames.map((f) => f.getAttribute('src')),
      // ★ 就绪的**直接**读数：播放控件只在 live 且 sandboxPhase==='ready' 时渲染；
      //   遮罩只在 loading 时出现。没有这两项的话，「没降级」可能只是**还没到 5 秒超时**。
      ready: document.querySelector('[data-testid="animation-view-play"]') !== null,
      veil: document.querySelector('[data-testid="animation-view-loading"]') !== null,
      errorText: document.querySelector('[data-testid="animation-view-error"]')?.innerText ?? '',
      degraded: Boolean(document.querySelector('[data-testid="animation-view-degrade-notice"]'))
    }
  })()`)
}

/**
 * 脚本自身出错（连不上调试端口 / 锚点漂了 / 抛异常）→ **退出码 2**。
 *
 * ⚠️ 必须有：本文件是顶层 await 的模块，异常默认会让 node 以 1 退出 ——
 *   而 1 在本脚本里代表「**发现了二次取用**」。把崩溃读成产品缺陷，
 *   和把没测读成通过是同一类错误（P-138）。
 */
process.on('uncaughtException', (error) => {
  console.error(`\u001b[31m✗ 探针自身出错（不是产品缺陷）：${error?.stack ?? error}\u001b[0m`)
  process.exit(2)
})
process.on('unhandledRejection', (error) => {
  console.error(`\u001b[31m✗ 探针自身出错（不是产品缺陷）：${error?.stack ?? error}\u001b[0m`)
  process.exit(2)
})

const cdp = await Cdp.attach()

/**
 * ★ 测量环境不对就不测：窗口在后台时 Chromium 会停掉渲染生命周期
 *   （实测 `requestAnimationFrame` 一秒 0 次），而本探针要量的恰恰是
 *   「隐藏/显示之间 iframe 文档会不会被丢弃」—— 环境不对时的「0 次请求」毫无意义。
 *   宁可退出码 2 报环境问题，也不给一个看起来通过的假绿。
 */
const visibility = await cdp.ensureRendering()
if (visibility !== 'visible') {
  console.error(
    `\u001b[31m✗ 测量环境不对：document.visibilityState=${visibility}\u001b[0m\n` +
      '   窗口不在前台时 Chromium 会停掉渲染生命周期，本轮的请求计数不作数。\n' +
      '   把应用窗口切到前台再跑一次（脚本已经试过 Page.bringToFront / 焦点模拟 / 置 active）。'
  )
  cdp.close()
  process.exit(2)
}
console.log(`页面前台可见性 = ${visibility}`)

cdp.on('Network.requestWillBeSent', (p) => {
  if (!String(p.request?.url ?? '').includes('/resources/animation')) return
  requests.push({ url: p.request.url, at: Date.now(), kind: 'request' })
})
cdp.on('Network.responseReceived', (p) => {
  const url = String(p.response?.url ?? '')
  if (!url.includes('/resources/animation')) return
  statuses.set(url, p.response.status)
  requests.push({ url, at: Date.now(), kind: 'response', status: p.response.status })
})

await cdp.send('Network.enable', {})

console.log('\n\u001b[1m【① 打开动画讲解页】\u001b[0m')
await goto(cdp, '动画讲解')
// 等舞台就绪（渲染要走一个后端调用，沙箱 ready 由 postMessage 上报）
for (let i = 0; i < 40; i += 1) {
  const state = await stageProbe(cdp)
  if (state.ready || state.degraded || state.errorText !== '') break
  await sleep(500)
}
const first = await stageProbe(cdp)
console.log('  舞台 =', JSON.stringify(first))
check('打开后舞台进入 live 且有 iframe', first.state === 'live' && first.hasFrame, `state=${first.state}`)
check('沙箱真的就绪（播放控件在、遮罩已撤）', first.ready && !first.veil, `ready=${first.ready} veil=${first.veil}`)
const firstRequests = requests.length
console.log(`  动画资源请求数 = ${firstRequests}`)

console.log('\n\u001b[1m【② 切走再切回（KeepAlive 往返）】\u001b[0m')
// ★ 标签必须与侧栏**实际渲染的文字**一致（它取自 `stores/ui.ts` 的 PAGES.title）：
//   对话页叫「问问智团团」不是「对话」、编程页叫「智码工坊」（2026-09-29 从「编程环境」改的名）。
//   ⚠️ 这里写错过一次：「对话」匹配不到 → 那一轮**根本没切页**，却打印成「停 1.2 秒 0 次重取」，
//      被当成「短停留不触发重取」的证据用了半天（与 P-122 同一类：锚点没命中也算成功）。
const rounds = [
  { away: '问问智团团', dwell: 1200 },
  { away: '智码工坊', dwell: 3000 },
  { away: '设置', dwell: 8000 }
]
for (const [index, round] of rounds.entries()) {
  const before = requests.length
  console.log(`  —— 第 ${index + 1} 轮：动画讲解 → ${round.away}（停 ${round.dwell}ms）→ 动画讲解`)
  await goto(cdp, round.away)
  await sleep(round.dwell)
  await goto(cdp, '动画讲解')
  await sleep(2500)
  const state = await stageProbe(cdp)
  const delta = requests.length - before
  console.log(
    `     切回后 舞台=${state.state} frame=${state.hasFrame} src=${state.frameSrc ? '有' : '无'}` +
      ` 就绪=${state.ready} 新增请求=${delta}`
  )
}

// ★ 最后一次等足 6 秒再看：5 秒的 ready 超时（`READY_TIMEOUT_MS`）只可能在这之后才判降级，
//   不然「没降级」这个读数是「还没到时间」，不是「就绪了」。
await sleep(6000)

console.log('\n\u001b[1m【③ 判定】\u001b[0m')
const animReqs = requests.filter((r) => r.kind === 'request')
const statusList = [...statuses.entries()].map(([url, status]) => ({ url, status }))
console.log(`  动画资源请求 ${animReqs.length} 次：`)
for (const item of statusList) {
  const short = item.url.replace(/^https?:\/\/[^/]+/, '').replace(/nonce=[^&]+/, 'nonce=…')
  console.log(`    ${item.status}  ${short}`)
}
const uniqueUrls = new Set(animReqs.map((r) => r.url))
check(
  '同一个动画地址没有被取第二次',
  animReqs.length === uniqueUrls.size,
  `请求 ${animReqs.length} 次 / 不同地址 ${uniqueUrls.size} 个`
)
const forbidden = statusList.filter((s) => s.status === 403)
check('没有出现 403（nonce 被拒）', forbidden.length === 0, forbidden.map((f) => f.url).join('\n      '))
const final = await stageProbe(cdp)
check(
  '最终舞台没有降级、没有错误态，且沙箱仍就绪',
  !final.degraded && final.errorText === '' && final.ready && !final.veil,
  `state=${final.state} ready=${final.ready} veil=${final.veil}`
)

console.log(
  `\n\u001b[1m结果：${findings.length === 0 ? '\u001b[32m通过' : '\u001b[31m有发现'}\u001b[0m  ` +
    `通过 ${passed} 项 / 发现 ${findings.length} 项`
)
cdp.close()
process.exit(findings.length === 0 ? 0 : 1)
