/**
 * 探针：运行透视的**三栏布局与可读性**（D-093 / D-094 的现场门槛）。
 *
 * 跑法：`K12_DEBUG_PORT=9222 npm run dev` 之后，另一个终端 `npm run ux:demo`
 *      （端口用 `K12_DEBUG_BASE` 覆盖，默认 9222）
 *
 * 为什么需要它：运行透视是**三栏**（轮次时间轴 / 分块 / 原始信封）。三栏最容易出的不是崩，
 * 而是「以为摊开了、其实看不了」：某一栏被挤到几十像素宽、内容横向溢出被裁、窄屏下三栏叠成一团。
 * 这些在截图里看着「还行」，只有把每栏的实际宽度与溢出量量出来才知道。
 *
 * ⚠️ 前置：应用必须**已经停在「运行透视」页**（教师档及以上时侧栏里就有它；
 *    也可以从设置页高级区的入口进去，那条会顺手把档位切到最高档）。
 *    探针不替人点那个开关 —— 档位开关是防误入机制的一部分，脚本去点它会让「谁都能进」
 *    变成既成事实。
 *
 * 退出码：0 = 全过；1 = 有发现；2 = 脚本自身出错或环境不对（没停在运行透视页）。
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'

/** 三视口：窗口下限 / 常见 / 设计基准（与 `ux-layout-audit.mjs` 同一组）。 */
const VIEWPORTS = [
  [1120, 700],
  [1280, 800],
  [1440, 900]
]

/** 每一栏的最小可用宽度（低于这个数就不是「能读」而是「占了一条缝」）。 */
const MIN_COLUMN_PX = 200

/**
 * 在页面里量一次三栏几何。
 *
 * ★ 写成**一个函数表达式**而不是一串语句：CDP 只传表达式，函数体里可以正常换行，
 *   也就不必把测量逻辑压成一行（可读性对探针同样重要 —— 它是给人看结论的工具）。
 */
const MEASURE = `(() => {
  const root = document.querySelector('[data-testid="demo-view"]')
  if (!root) return { missing: true }
  const cols = root.querySelector(':scope > .cols')
  if (!cols) return { missing: true }
  const panes = [...cols.children].map((el) => {
    const rect = el.getBoundingClientRect()
    return {
      width: Math.round(rect.width),
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight
    }
  })
  const panel = document.querySelector('[data-testid="diagnostics-panel"]')
  return {
    missing: false,
    panes,
    total: Math.round(cols.getBoundingClientRect().width),
    timelineVisible: Boolean(root.querySelector('[data-testid="demo-timeline"]')),
    panelOpen: Boolean(panel),
    panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0
  }
})()`

class Cdp {
  #ws
  #id = 0
  #pending = new Map()

  static async attach() {
    const list = await (await fetch(`${BASE}/json/list`)).json()
    const page = list.find((item) => item.type === 'page')
    if (!page) throw new Error('找不到 page 目标（应用没起来？）')
    const cdp = new Cdp()
    await cdp.#connect(page.webSocketDebuggerUrl)
    return cdp
  }

  async #connect(url) {
    this.#ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true })
      this.#ws.addEventListener('error', reject, { once: true })
    })
    this.#ws.addEventListener('message', (event) => {
      const payload = JSON.parse(String(event.data))
      const item = this.#pending.get(payload.id)
      if (!item) return
      this.#pending.delete(payload.id)
      if (payload.error) item.reject(new Error(JSON.stringify(payload.error)))
      else item.resolve(payload.result)
    })
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    this.#ws?.close()
  }
}

const COLUMN_NAMES = ['时间轴', '分块', '原始信封']

async function main() {
  const cdp = await Cdp.attach()
  const findings = []
  try {
    // 让窗口真的在前台渲染（隐藏窗口下几何断言会假红，见 `ux-probe-busy-send.mjs` 的说明）
    for (const [method, params] of [
      ['Page.bringToFront', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.setWebLifecycleState', { state: 'active' }]
    ]) {
      try {
        await cdp.send(method, params)
      } catch {
        /* 单条不支持不影响测量 */
      }
    }

    for (const [width, height] of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
      // 让布局跑完两帧（一帧改样式、一帧重排）
      await cdp.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
      const data = await cdp.eval(MEASURE)
      const label = `${width}×${height}`
      if (data.missing) {
        findings.push(`${label}：找不到运行透视页（先切到教师档及以上并在侧栏打开「运行透视」再跑这个探针）`)
        continue
      }
      if (data.panes.length !== 3) {
        findings.push(`${label}：运行透视页应当是三栏（实测 ${data.panes.length} 栏）`)
        continue
      }
      data.panes.forEach((pane, index) => {
        const name = COLUMN_NAMES[index] ?? `第 ${index + 1} 栏`
        if (pane.width < MIN_COLUMN_PX) {
          findings.push(`${label}：${name}只有 ${pane.width}px（下限 ${MIN_COLUMN_PX}px）—— 那一栏已经读不了了`)
        }
        if (pane.overflowX > 2) {
          findings.push(`${label}：${name}横向溢出 ${pane.overflowX}px（内容被横向裁掉）`)
        }
      })
      if (!data.timelineVisible) findings.push(`${label}：轮次时间轴不在 DOM 里（演示时点不了轮次）`)
      if (data.panelOpen && data.panelWidth < 320) {
        findings.push(`${label}：机制浮窗只有 ${data.panelWidth}px 宽（摘要行会折成一团）`)
      }
      console.log(
        `【${label}】三栏宽度 ${data.panes.map((pane) => `${pane.width}px`).join(' / ')}` +
          `${data.panelOpen ? '（浮窗已开）' : ''}`
      )
    }
  } finally {
    try {
      await cdp.send('Emulation.clearDeviceMetricsOverride')
    } catch {
      /* 忽略 */
    }
    cdp.close()
  }

  if (findings.length > 0) {
    console.log('\n发现：')
    for (const item of findings) console.log(`  ✗ ${item}`)
    process.exitCode = 1
    return
  }
  console.log('\n✓ 三视口下三栏都可用、时间轴在、没有横向溢出')
}

main().catch((error) => {
  console.error(`探针自身出错：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})
