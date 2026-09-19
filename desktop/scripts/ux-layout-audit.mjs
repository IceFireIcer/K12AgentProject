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

/** 三个视口：最窄（窗口下限）/ 常见 / 设计基准。 */
const VIEWPORTS = [
  [1120, 700],
  [1280, 800],
  [1440, 900]
]

/** 侧栏八页（窄侧栏下 innerText 可能为空，所以按 title 兜底匹配）。 */
const PAGES = ['对话课堂', '动画讲解', '编程环境', '闯关练习', '学习档案', '教材知识库', '依赖图谱', '设置']

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
  let bad = 0
  let cells = 0

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
