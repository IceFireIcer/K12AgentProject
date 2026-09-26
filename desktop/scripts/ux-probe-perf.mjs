/**
 * 探针：性能基准线（优化报告 §5.2 阶段 14.3「性能埋点 + 真机探针 + 基准线」）。
 *
 * 量三件事（都是**学生真会等**的时刻）：
 *   ① FCP（首次有内容）—— 应用冷启动后多久能看见东西；
 *   ② LCP（最大内容绘制）—— 主内容什么时候画完；
 *   ③ FID（首次输入延迟）—— 学生第一次点击/按键到界面开始响应的延迟
 *      （没有真实输入就没有这个数：如实打 SKIP，不编一个 0）。
 *
 * 附带量 DCL / load（导航计时），它们与 FCP/LCP 一起构成可对比的基准线。
 *
 * 跑法：应用带 K12_DEBUG_PORT 启动后，`npm run ux:perf`
 * 退出码：0 = 采集成功且门槛达标；1 = 有指标超门槛；2 = 脚本自身出错。
 *
 * 门槛（报告 §7.1 的定性目标 + Web Vitals 的"good"档，取较宽的一档）：
 *   FCP < 2500ms · LCP < 4000ms · FID < 100ms
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'
/** 基准线门槛（ms）。 */
const BUDGET = { fcp: 2500, lcp: 4000, fid: 100 }

class Cdp {
  #ws
  #id = 0
  #pending = new Map()

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
      const slot = this.#pending.get(m.id)
      if (!slot) return
      this.#pending.delete(m.id)
      m.error ? slot.reject(new Error(JSON.stringify(m.error))) : slot.resolve(m.result)
    })
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

  async ensureRendering() {
    for (const [m, p] of [
      ['Page.bringToFront', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.setWebLifecycleState', { state: 'active' }]
    ]) {
      try {
        await this.send(m, p)
      } catch {
        /* 旧 CDP 上某个方法可能不存在：继续试下一个 */
      }
    }
    return this.evaluate('document.visibilityState')
  }

  close() {
    this.#ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const READ = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || null
  const app = window.__k12Perf || { fcp: null, lcp: null, fid: null }
  return {
    fcp: app.fcp,
    lcp: app.lcp,
    fid: app.fid,
    dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd || nav.duration) : null
  }
})()`

let fail = 0
function report(label, value, budget) {
  if (value === null || value === undefined) {
    console.log(`  \u001b[33m[SKIP]\u001b[0m ${label}：这一轮没有这个数（例如没有真实输入）`)
    return
  }
  const ok = budget === undefined || value <= budget
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'
  console.log(`  ${mark} ${label}：${value}ms${budget === undefined ? '' : `（门槛 ${budget}ms）`}`)
  if (!ok) fail += 1
}

async function main() {
  const cdp = await Cdp.attach()
  const visibility = await cdp.ensureRendering()
  if (visibility !== 'visible') {
    console.log(`⚠️ 窗口仍是 ${visibility}：渲染时序可能失真（把应用窗口点到前台再跑）`)
  }

  // 重载一次，拿到**干净的一次导航**（否则读到的是上次启动时的旧数据）
  await cdp.send('Page.reload', { ignoreCache: false })
  for (let i = 0; i < 60; i += 1) {
    await sleep(250)
    const ready = await cdp.evaluate(`document.readyState === 'complete' && Boolean(window.__k12PerfReady)`)
    if (ready) break
  }
  // LCP 在校准期（3s 内）还会更新：多等一会儿再读，否则读到一个偏小的中间值
  await sleep(3200)

  const s = await cdp.evaluate(READ)
  console.log('\n\u001b[1m性能基准线（本次实测）\u001b[0m')
  report('FCP 首次内容绘制', s.fcp === null ? null : Math.round(s.fcp), BUDGET.fcp)
  report('LCP 最大内容绘制', s.lcp === null ? null : Math.round(s.lcp), BUDGET.lcp)
  report('FID 首次输入延迟', s.fid === null ? null : Math.round(s.fid), BUDGET.fid)
  report('DCL DOMContentLoaded', s.dcl)
  report('load 载入完成', s.load)

  cdp.close()
  console.log(`\n${'═'.repeat(60)}`)
  console.log(
    fail === 0
      ? '\u001b[32m✓ 性能指标全部在门槛内（把上面这几行抄进 docs/optimise-baseline.md 的 §7）\u001b[0m'
      : `\u001b[31m✗ ${fail} 项超出门槛\u001b[0m`
  )
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('探针出错：', e.message)
  process.exit(2)
})
