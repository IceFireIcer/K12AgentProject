/**
 * 版式体检：**三个视口 × 八个页面**逐格查「画出来对不对」。
 *
 * ★ 与 `ux-audit.mjs` / `ux-pages-audit.mjs` 的分工：
 *   那两个在**默认窗口**下查交互（键盘/滚动/触控目标/浮层几何），
 *   本脚本换一个**被测维度**：**窗口宽度** —— 响应式是错位与裁切的高发区，
 *   而「默认窗口下是对的」说明不了「窄窗口下也对」。
 *
 * ★ 四类判据（全部是**关系**，不是单个元素的属性 —— 后者查不出这些）：
 *   ① `scrollWidth > clientWidth` **且不可滚**（`overflow-x: hidden` 且没有省略号）
 *      → 内容**永久够不着**；
 *      ⚠️ `auto/scroll` 是刻意的横向滚动条（长列表都靠它），**不算问题**；
 *      ⚠️ Monaco 的 `16777215/16777216` 是内部哨兵值，也要排除。
 *   ② 元素跑出视口且不在任何可横向滚动的容器里；
 *   ③ 表格**表头与表体宽度不一致**：Element Plus 在横向溢出时表头不跟着表体收，
 *      于是表头被切掉一半、还与表体错位（实测 1280 下「向量」列只剩一个「向」字）；
 *   ④ 触控目标低于 28px（与 `ux-pages-audit.mjs` 同一口径）。
 *
 * 跑法：应用已带调试端口启动后
 *   K12_DEBUG_PORT=9222 npm run dev      # 另一个终端
 *   node scripts/ux-layout-audit.mjs
 * 退出码：0 = 24 格全通过；1 = 有发现；2 = 脚本自身出错。
 * 依赖：只用 Node 内置能力（≥22 的 fetch / WebSocket），**零依赖**。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = readFileSync(join(HERE, 'ux-page-probe.js'), 'utf8')
const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'

/**
 * 四个视口（优化报告 §2.2：新增 1024 档）：
 *   1024 平板/小笔记本（窗口下限，1024 起不再横向滚动）
 *   1280 标准笔记本（右栏可折） · 1440 设计基准 · 1920 超宽
 */
const VIEWPORTS = [
  [1024, 700],
  [1280, 800],
  [1440, 900],
  [1920, 1080]
]

/**
 * 侧栏页面（窄侧栏下 innerText 可能为空，所以按 title 兜底匹配）。
 *
 * ★★ 「参考资料库」（原「教材知识库」）**不在**这份清单里：它现在是教师 / 答辩专属页
 *    （`PAGES.knowledge.nav === 'teacher'`），学生视角的侧栏不渲染它。
 *    本脚本按学生视角跑（应用默认视角），列上它会整格红成「进不去」——
 *    那是跑法不对，不是排版坏了。它要在教师视角下单独走查。
 */
const PAGES = ['问问智团团', '动画讲解', '智码工坊', '个性化学习', '学习记录', '知识图谱', '设置']

class Cdp {
  #ws
  #id = 0
  #pending = new Map()
  static async attach() {
    const list = await (await fetch(`${BASE}/json/list`)).json()
    const page = list.find((i) => i.type === 'page')
    if (!page) throw new Error('找不到 page 目标（应用起了吗？K12_DEBUG_PORT 设了吗？）')
    const cdp = new Cdp()
    await cdp.#connect(page.webSocketDebuggerUrl)
    return cdp
  }
  /**
   * ★★ 让渲染器**真的在渲染**（2026-09-21 实测补，不然后面一半的断言都是假的）。
   *
   * 背景：CDP 连上的窗口如果处于 `document.visibilityState === 'hidden'`
   * （后台窗口 / 无人操作时的常见状态），Chromium 会**停掉渲染生命周期** ——
   * 实测 `requestAnimationFrame` 一秒 0 次，而 `setInterval` 照常（2 次/秒）。
   * 后果：`ResizeObserver` **一次都不回调**，于是
   *   · 「内容长高后是否自动滚到底」测不到（B1/B2 永远红，而代码是对的）；
   *   · 「容器变化驱动重排」这类断言全部失真。
   * 实测指纹：`roFires: 0` 而 `dist` 单调递增。
   * ★ 修法：`Page.bringToFront` + `Emulation.setFocusEmulationEnabled` ——
   *   之后 `visibilityState` 变 `visible`、rAF 回到 ~240/秒（实测）。
   * ⚠️ 这两条只影响**测量环境**，不改产品行为；少了它们，探针会给出**看起来像产品缺陷**的红。
   */
  async ensureRendering() {
    // ★★ 让窗口**真的可见**：hidden 状态下 Chromium 停掉渲染生命周期，
    //    rAF 实测 0 次/秒（而 setInterval 正常）→ ResizeObserver 一次都不回调。
    //    实测里 `Page.bringToFront` 单独用**不管用**（窗口在后台时它不顶事），
//    ★★ 2026-09-22 补漏：三个方法里原先是 `Emulation.setPageVisibility`，
//       而**这个 CDP 方法在 Electron 44 上不存在**（`-32601 wasn't found`）——
//       于是这条“修法”一直是**静默失效**的：脚本照样只印一句 ⚠️ 就往下跑，
//       而 B1/B2（滚动跟随）与任何量几何的断言在后台窗口里**全是假红**。
//       换成 `Page.setWebLifecycleState({state:'active'})`（实测：调用后
//       `document.visibilityState` 立刻变 visible）。
    //    必须连 `Emulation.setFocusEmulationEnabled` 一起上；两者都调完之后
    //    `visibilityState` 变 visible、rAF 回到 ~240/秒（实测）。
    // ⚠️ 幂等：重复调用无副作用。
    for (const [method, params] of [
      ['Page.bringToFront', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.setWebLifecycleState', { state: 'active' }]
    ]) {
      try {
        await this.send(method, params)
      } catch {
        // 某个方法在旧 CDP 上不存在：继续试下一个（三个里中一个就够）
      }
    }
    return this.evaluate('document.visibilityState')
  }

  async #connect(url) {
    this.#ws = new WebSocket(url)
    await new Promise((res, rej) => {
      this.#ws.addEventListener('open', res, { once: true })
      this.#ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true })
    })
    this.#ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      const slot = this.#pending.get(m.id)
      if (!slot) return
      this.#pending.delete(m.id)
      m.error ? slot.reject(new Error(JSON.stringify(m.error))) : slot.resolve(m.result)
    })
  }
  send(method, params) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result?.value
  }
  close() {
    this.#ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const cdp = await Cdp.attach()
  // ★★ 先让渲染器真的在渲染：hidden 窗口下 ResizeObserver 一次都不触发，
  //    「内容长高后有没有跟随」这类测量会**全部失真**（实测踩到，见 ensureRendering 的说明）。
  const visibility = await cdp.ensureRendering()
  if (visibility !== 'visible') {
    console.log(`[33m⚠️ 窗口仍是 ${visibility}：与渲染时序相关的断言可能失真（见 ensureRendering 的说明）[0m`)
  }
  let bad = 0
  let cells = 0

  /**
   * ★★ 先把两栏展开（2026-09-22）：两栏默认收起（`stores/panels.ts`），而本脚本量的是
   * **版式**（错位 / 裁切 / 表格宽度）—— 收起状态下的版式是「主列很宽」，
   * 那正是本脚本要压的那一档。展开后才回到「三列同时在场」这个最紧的版式。
   * ★ 状态落在 localStorage（随 userData 持久化，reload 后依然生效），
   *   所以每个视口重载前展开一次即可。⚠️ 这是**测量前提**，不是产品行为。
   */
  await cdp.evaluate(`(() => {
    for (const id of ['history-toggle', 'rail-toggle']) {
      const btn = document.querySelector('[data-testid="' + id + '"]')
      if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click()
    }
    return true
  })()`)
  await sleep(400)

  for (const [width, height] of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false
    })
    await cdp.send('Page.reload', {})
    await sleep(8000)

    for (let index = 0; index < PAGES.length; index += 1) {
      const label = PAGES[index]
      // 侧栏在窄窗口下只显示图标（文字隐藏），所以先用 title / innerText 找，找不到再按下标兜底
      await cdp.evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('aside button'))
        const b = btns.find((x) => (x.getAttribute('title') || '').includes(${JSON.stringify(label)})
          || (x.innerText || '').includes(${JSON.stringify(label)})) || btns[1 + ${index}]
        if (b) b.click()
        return true
      })()`)
      await sleep(2400)

      const state = JSON.parse((await cdp.evaluate(PROBE)) || '{}')
      const issues = []
      if (state.hOverflow) issues.push('页面横向滚动')
      if (state.clipped?.length) {
        issues.push(`内容够不着: ${state.clipped.map((c) => `${c.cls}(${c.sw}>${c.cw})`).join('、')}`)
      }
      if (state.outside?.length) {
        issues.push(`跑出视口: ${state.outside.map((c) => c.cls).join('、')}`)
      }
      if (state.table && (state.table.clipped || !state.table.aligned)) {
        issues.push(`表格表头/表体错位（${state.table.headerW} vs ${state.table.bodyW}）`)
      }
      if (state.tiny?.length) issues.push(`触控目标过小 ×${state.tiny.length}`)

      cells += 1
      if (issues.length === 0) continue
      bad += 1
      console.log(`\u001b[31m✗\u001b[0m ${width}px ${label}：${issues.join(' | ')}`)
    }
    console.log(`\u001b[32m✓\u001b[0m ${width}×${height} 八页走查完成`)
  }

  await cdp.send('Emulation.clearDeviceMetricsOverride')
  cdp.close()

  console.log(`\n${'═'.repeat(60)}`)
  if (bad === 0) {
    console.log(`\u001b[32m✓ 版式体检通过（${cells} 格 = ${VIEWPORTS.length} 视口 × ${PAGES.length} 页）\u001b[0m`)
    return 0
  }
  console.log(`\u001b[31m✗ ${bad} / ${cells} 格有问题\u001b[0m`)
  return 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\u001b[31m脚本自身出错：\u001b[0m${error.message}`)
    process.exit(2)
  }
)
