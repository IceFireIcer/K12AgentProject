/**
 * 滚动掉队的**归因**工具：涨到「哪一类内容」时视图没跟上。
 *
 * ★ 为什么值得单独留着：`ux-audit.mjs` 的 B1 只说「有没有掉队」，
 *   而真正定位 P-078 靠的是**把内容分类量**（正文 / 引用块 / 卡片各占多少高度）。
 *   粗粒度断言会说「最后到底了」，把过程中那次掉队完全掩盖 —— 实测引用块
 *   一次插入 376–663px，就是这个工具量出来的（当时叫 ux-scroll-probe3）。
 *
 * 现在它是**诊断工具**（修完 P-078 后应当一直报 0 次掉队）；
 * 如果 B1 又红了，先跑它看是哪一类内容在掉队。
 *
 * 跑法：`node scripts/ux-scroll-attribution.mjs`（需要应用带 K12_DEBUG_PORT=9222 启动）
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'

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
    //    必须连 `Emulation.setFocusEmulationEnabled` 一起上；两者都调完之后
    //    `visibilityState` 变 visible、rAF 回到 ~240/秒（实测）。
    // ⚠️ 幂等：重复调用无副作用。
    for (const [method, params] of [
      ['Page.bringToFront', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setPageVisibility', { visibility: 'visible' }]
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
  async evaluate(expression) {
    const id = ++this.#id
    const r = await new Promise((res, rej) => {
      this.#pending.set(id, { resolve: res, reject: rej })
      this.#ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result?.value
  }
  close() {
    this.#ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 采样：整体高度 + 各区块的**分项高度**。
 * 分项高度是关键 —— 它们能告诉我们「这次长高是谁造成的」。
 */
const SAMPLE = `(() => {
  const col = document.querySelector('[data-testid="chat-log"]')
  const inner = col?.firstElementChild
  if (!col || !inner) return null
  const turns = document.querySelectorAll('[data-testid="chat-turn"]')
  const last = turns[turns.length - 1]
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0)
  return {
    scrollHeight: Math.round(col.scrollHeight),
    scrollTop: Math.round(col.scrollTop),
    clientHeight: Math.round(col.clientHeight),
    dist: Math.round(col.scrollHeight - col.scrollTop - col.clientHeight),
    innerH: h(inner),
    turns: turns.length,
    lastH: h(last),
    lastTextH: h(last?.querySelector('[data-testid="assistant-text"]')),
    lastAnswerH: h(last?.querySelector('[data-testid="assistant-message"]')),
    lastCardsH: h(last?.querySelector('[data-testid="inline-cards"]')),
    lastCards: last ? last.querySelectorAll('[data-testid="inline-cards"] > *').length : 0,
    lastSrcsH: h(last?.querySelector('[data-testid="citation-sources"]')),
    lastCites: last ? last.querySelectorAll('[data-testid="citation-sources"] li').length : 0,
    streaming: document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length
  }
})()`

async function main() {
  const cdp = await Cdp.attach()
  // ★★ 先让渲染器真的在渲染：hidden 窗口下 ResizeObserver 一次都不触发，
  //    「内容长高后有没有跟随」这类测量会**全部失真**（实测踩到，见 ensureRendering 的说明）。
  const visibility = await cdp.ensureRendering()
  if (visibility !== 'visible') {
    console.log(`[33m⚠️ 窗口仍是 ${visibility}：与渲染时序相关的断言可能失真（见 ensureRendering 的说明）[0m`)
  }

  // 新会话：把最「干净」的首轮场景造出来（首轮的高度变化最剧烈）
  await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.includes('新会话'))
    if (b) b.click()
    return Boolean(b)
  })()`)
  await sleep(800)

  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '人工神经网络是怎么学习的？请讲得详细一些，多举几个例子')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await cdp.evaluate(`document.querySelector('[data-testid="composer-send"]').click()`)

  console.log('\u001b[1m采样中（每 200ms）…\u001b[0m')
  const rows = []
  for (let i = 0; i < 180; i += 1) {
    await sleep(200)
    const s = await cdp.evaluate(SAMPLE)
    if (!s) continue
    rows.push(s)
    if (s.streaming === 0 && rows.length > 3 && s.lastTextH > 0) break
  }

  // 找出「长高了但没贴底」的采样
  const problems = []
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]
    const now = rows[i]
    const grew = now.scrollHeight - prev.scrollHeight
    if (grew > 8 && now.dist > 8) {
      const causes = []
      if (now.lastTextH > prev.lastTextH + 4) causes.push(`正文 +${now.lastTextH - prev.lastTextH}px`)
      if (now.lastSrcsH > prev.lastSrcsH + 4) causes.push(`引用块 +${now.lastSrcsH - prev.lastSrcsH}px`)
      if (now.lastCardsH > prev.lastCardsH + 4)
        causes.push(`卡片 +${now.lastCardsH - prev.lastCardsH}px（${prev.lastCards}→${now.lastCards} 张）`)
      if (now.lastH > prev.lastH + 4 && causes.length === 0)
        causes.push(`轮次整体 +${now.lastH - prev.lastH}px`)
      if (causes.length === 0) causes.push(`其它 +${grew}px`)
      problems.push({ i, grew, dist: now.dist, causes: causes.join('、'), streaming: now.streaming })
    }
  }

  console.log(`\n本轮共 ${rows.length} 次采样，回答结束时离底部 ${rows.at(-1)?.dist}px`)
  const grewTotal = rows.at(-1).scrollHeight - rows[0].scrollHeight
  console.log(`总高度增长 ${grewTotal}px（${rows[0].scrollHeight} → ${rows.at(-1).scrollHeight}）`)

  if (problems.length === 0) {
    console.log('\n\u001b[32m✓ 每一次高度增长，视图都在 200ms 内贴回了底部\u001b[0m')
  } else {
    console.log(`\n\u001b[31m★ ${problems.length} 次「内容长高了但视图没跟上」\u001b[0m`)
    for (const p of problems.slice(0, 10)) {
      console.log(
        `  第 ${p.i} 次采样：+${p.grew}px（${p.causes}）→ 离底部还差 ${p.dist}px` +
          `  [${p.streaming > 0 ? '仍在流式' : '已结束'}]`
      )
    }
    const cardOnes = problems.filter((p) => p.causes.includes('卡片'))
    const srcOnes = problems.filter((p) => p.causes.includes('引用'))
    console.log(
      `\n  按成因统计：卡片 ${cardOnes.length} 次｜引用块 ${srcOnes.length} 次｜正文 ${
        problems.filter((p) => p.causes.includes('正文')).length
      } 次`
    )
  }

  cdp.close()
}

main().catch((e) => {
  console.error('探针出错：', e.message)
  process.exit(2)
})
