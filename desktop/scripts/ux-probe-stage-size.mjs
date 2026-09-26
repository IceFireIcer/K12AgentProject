/**
 * 探针：动画舞台的**屏幕有效字号**（P-140 / D-085 的门槛）。
 *
 * 跑法：`K12_DEBUG_PORT=9224 npm run dev` 之后，另一个终端 `npm run ux:stage`
 *      （端口用 `K12_DEBUG_BASE` 覆盖，默认 9222）
 *
 * 为什么需要它：模板在 **720×420** 坐标系里画（`_shared/runtime.js`），到屏幕上是**等比缩放** ——
 * 容器给的高度越小，里面每个字就越小。而 `.anim__frame` 的高度曾经是**死值 340px**，
 * iframe 外壳自己还要吃掉标题/字幕/步骤条 ≈ 125px，于是缩放掉到 ~0.5×：
 * 标称 20px 的节点字在屏上只有 ~10px。这类缺陷**屏幕截图看不出来**（图缩小了看着还挺整齐），
 * 只有把「有效字号 = 标称字号 × 缩放」量出来才知道学生到底在读几号字。
 *
 * 量法：CDP 进 iframe 自己的执行上下文（`Page.createIsolatedWorld`），
 * 读 SVG 的 `viewBox` 与它的屏幕 rect → `缩放 = min(rect.w/viewBox.w, rect.h/viewBox.h)`，
 * 再乘上节点的 computed font-size。三视口各量一遍。
 *
 * 退出码：0 = 三条门槛全过；1 = 有发现（字太小/舞台太矮/内部出现滚动条）；2 = 脚本自身出错或环境不对。
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'

/** 三个视口：最窄（窗口下限）/ 常见 / 设计基准。与 `ux-layout-audit.mjs` 同一组。 */
const VIEWPORTS = [
  [1120, 700],
  [1280, 800],
  [1440, 900]
]

/** 设计基准视口（唯一断言「读到 18px」的视口；见下面门槛说明）。 */
const BASELINE_VIEWPORT = '1440×900'
/**
 * 门槛。
 *
 * ★★ 为什么「节点 ≥ 18px」只断言在设计基准视口上（而不是三个视口都要）：
 *   动画是 720×420，学生窗口最小时是 1120×700 —— 那 700px 里要先扣掉
 *   顶栏 72 + 身份行 + 卡头 ≈ 190px（不然动画会被自己的卡头挤出屏幕）、
 *   再扣掉外壳的标题/字幕/步骤条 ≈ 124px，剩下给画布的**物理上限只有 ~386px**
 *   ⇒ 缩放上限 ~0.92×（标称 16 → 17px 就是那一档的天花板）。
 *   想把最小窗口也推到 18px，只有两条路，都不该在「页面几何」这一层做：
 *     ① 让动画超出视口（页面出现滚动，学生看不到底部的步骤条）；
 *     ② 抬高 SVG 里的字号令牌（`--k12-fs-node`）——那是 720×420 坐标系里的布局预算，
 *        改它要连生成期几何校验与全库资产一起重跑（阶段 C）。
 *   所以这里量的是**页面几何能做到的部分**：画布不许被缩到原尺寸以下（缩放 ≥ 0.85×），
 *   且**设计基准视口**上必须真的读到 ≥ 18px。三个视口的实测值都会打印出来，供人眼复核。
 */
const MIN_SCALE = 0.85
const MIN_NODE_PX = 18
const MIN_CAPTION_PX = 15
const MIN_CHIP_PX = 13.5

class Cdp {
  #ws
  #id = 0
  #pending = new Map()
  #listeners = new Map()

  static async attach() {
    const list = await (await fetch(`${BASE}/json/list`)).json()
    const page = list.find((i) => i.type === 'page')
    if (!page) throw new Error('找不到 page 目标')
    const cdp = new Cdp()
    await cdp.#connect(page.webSocketDebuggerUrl)
    return cdp
  }

  /**
   * 连到**动画 iframe 自己的目标**。
   *
   * ★★ 为什么不能像别的探针那样在页面里 `querySelector('iframe')` 就拿它的 document：
   *   动画 iframe 是 `sandbox`（没有 `allow-same-origin`）+ `srcdoc` → 不透明源，
   *   父页面读不到它的 DOM；而且 Chromium 把它放进**独立进程（OOPIF）**，
   *   `Page.getFrameTree` 里**看不到这一层**（实测：父 frame 下 0 个子 frame，
   *   而 `/json/list` 里多出一个 `type: "iframe"` 的目标）。
   *   所以取值必须连到那个目标自己的会话上。
   */
  static async attachIframe() {
    for (let i = 0; i < 40; i += 1) {
      const list = await (await fetch(`${BASE}/json/list`)).json()
      const frame = list.find((t) => t.type === 'iframe')
      if (frame?.webSocketDebuggerUrl) {
        const cdp = new Cdp()
        await cdp.#connect(frame.webSocketDebuggerUrl)
        return cdp
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('找不到动画 iframe 目标（/json/list 里没有 type=iframe）—— 舞台没挂上？')
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

  /** 在**本目标**里求值（连的是 iframe 目标时，就是动画自己那套 DOM）。 */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result?.value
  }

  /** 让渲染器真的在渲染 + 窗口前台可见（后台窗口会被 Chromium 停掉渲染生命周期）。 */
  async ensureRendering() {
    for (const [method, params] of [
      ['Page.bringToFront', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.setWebLifecycleState', { state: 'active' }]
    ]) {
      try {
        await this.send(method, params)
      } catch {
        /* 旧 CDP 上不存在：继续试下一个 */
      }
    }
    return this.evaluate('document.visibilityState')
  }

  close() {
    this.#ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/** 切到某一页（按侧栏文字点；标签要与 `PAGES.title` 一致）。 */
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

/** 页面侧读数：舞台卡 / iframe / 播放控制条的实际框。 */
const PAGE_PROBE = `(() => {
  const frame = document.querySelector('[data-testid="animation-view-frame"]')
  const stage = document.querySelector('[data-testid="animation-view-stage"]')
  const identity = document.querySelector('.k12-identity__main')
  const bar = document.querySelector('[data-testid="animation-gradebar"]')
  const foot = document.querySelector('[data-testid="animation-view-play"]')
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } }
  const f = rect(foot)
  return {
    viewport: { w: innerWidth, h: innerHeight },
    identity: rect(identity),
    iframe: rect(frame),
    footerTop: f ? f.top : null,
    footerBottom: f ? f.bottom : null,
    stageState: stage ? stage.getAttribute('data-state') : null,
    gradebar: rect(bar),
    ready: foot !== null
  }
})()`

/**
 * iframe 内读数（在动画自己的执行上下文里跑）。
 *
 * ★ 缩放一律由 **SVG 的 viewBox 与它的屏幕 rect** 反推，而不是「拿容器宽除以 720」——
 *   容器可能被 `preserveAspectRatio` 留白，只有 rect ÷ viewBox 才是真正生效的比例。
 *
 * ★★ 两类文字的缩放规则**不一样**，必须分开算（第一版踩过）：
 *   · **SVG 内**（节点标签 / 副标签 / 读数 / 角色名）：跟着 viewBox 缩放 ⇒ 有效字号 = 标称 × 缩放；
 *   · **外壳 HTML**（模板标题 / 字幕行 / 步骤条 chip）：不缩放 ⇒ 有效字号 = 标称（它不会因为舞台变大而变大）。
 *   第一版把 `.k12-node-body`（那是节点的**底板矩形**，不是文字）当成节点文字，量出「标称 14px」——
 *   `getComputedStyle(rect).fontSize` 读的是它继承来的字号，与屏幕上那行字无关。
 */
const FRAME_PROBE = `(() => {
  const svg = document.querySelector('#stage svg') || document.querySelector('svg')
  const stageEl = document.getElementById('stage')
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) } }
  const fs = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null)
  let scale = null
  if (svg) {
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number)
    const r = svg.getBoundingClientRect()
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0 && r.width > 0 && r.height > 0) {
      scale = +Math.min(r.width / vb[2], r.height / vb[3]).toFixed(3)
    }
  }
  /** SVG 内的文字：随舞台缩放。 */
  const inSvg = (sel) => {
    const nominal = fs(document.querySelector(sel))
    return { nominal, effective: nominal !== null && scale !== null ? +(nominal * scale).toFixed(1) : null }
  }
  /** 外壳的 HTML 文字：不随舞台缩放。 */
  const inShell = (sel) => {
    const nominal = fs(document.querySelector(sel))
    return { nominal, effective: nominal }
  }
  return {
    stageBox: rectOf(stageEl),
    svgBox: rectOf(svg),
    viewBox: svg ? svg.getAttribute('viewBox') : null,
    scale,
    node: inSvg('.k12-node-label'),
    nodeSub: inSvg('.k12-node-sub'),
    readout: inSvg('.k12-readout-value') || inSvg('.metric'),
    actor: inSvg('.k12-actor-label'),
    title: inShell('.anim-title'),
    caption: inShell('.anim-caption'),
    chip: inShell('.chip'),
    // ★ 步骤条的**原文**：它必须说这套动画自己的量词（「第 2 段 / 共 4 段」而不是运行时的兜底「步」），
    //   序号还要与正文里的编号同值 —— 这两件事只有真跑起来才看得出（D-087）。
    chipText: (document.querySelector('.chip') || {}).textContent || null,
    // 正文里出现的编号（节点标签 / 字幕），用来与 chip 对照
    ordinals: (function () {
      var out = [];
      var nodes = document.querySelectorAll('#stage text');
      for (var i = 0; i < nodes.length && out.length < 6; i += 1) {
        var text = (nodes[i].textContent || '').trim();
        if (/^第\\s*\\d+/.test(text)) out.push(text.slice(0, 18));
      }
      return out;
    })(),
    innerScroll: {
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
      overflow: document.documentElement.scrollHeight > document.documentElement.clientHeight + 2
    }
  }
})()`

/* ── 脚本自身出错 → 退出码 2（1 代表「有发现」，崩溃不许伪装成缺陷） ── */
process.on('uncaughtException', (error) => {
  console.error(`\u001b[31m✗ 探针自身出错（不是产品缺陷）：${error?.stack ?? error}\u001b[0m`)
  process.exit(2)
})
process.on('unhandledRejection', (error) => {
  console.error(`\u001b[31m✗ 探针自身出错（不是产品缺陷）：${error?.stack ?? error}\u001b[0m`)
  process.exit(2)
})

const cdp = await Cdp.attach()
const visibility = await cdp.ensureRendering()
if (visibility !== 'visible') {
  console.error(
    `\u001b[31m✗ 测量环境不对：document.visibilityState=${visibility}\u001b[0m\n` +
      '   窗口不在前台时 Chromium 停掉渲染生命周期，几何读数不作数。把窗口切到前台再跑。'
  )
  cdp.close()
  process.exit(2)
}

await cdp.send('Page.enable', {})
console.log(`\u001b[1m【打开动画讲解页】\u001b[0m`)
await goto(cdp, '动画讲解')
for (let i = 0; i < 40; i += 1) {
  const state = await cdp.evaluate(PAGE_PROBE)
  if (state.ready) break
  await sleep(500)
}

/* ★ 先**暂停**再量：字幕行的折行数随动画帧变化（长句会多占一行），
   量到的画布高度会因此抖动 ±20px。暂停后画面停在同一帧 ⇒ 三视口读数可比。 */
const paused = await cdp.evaluate(`(() => {
  const btn = document.querySelector('[data-testid="animation-view-play"]')
  if (!btn) return false
  if (btn.getAttribute('title') !== '暂停') return false
  btn.click()
  return true
})()`)
if (paused) await sleep(400)

/* 舞台挂上了才继续：先等页面侧读到 ready（播放控件出现 = live + 沙箱就绪） */
const frameCdp = await Cdp.attachIframe()
console.log(`\u001b[1m【三视口实测】\u001b[0m`)
const rows = []
for (const [width, height] of VIEWPORTS) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(900)
  const page = await cdp.evaluate(PAGE_PROBE)
  const inner = await frameCdp.evaluate(FRAME_PROBE)
  rows.push({ viewport: `${width}×${height}`, page, inner })
  const px = (node) => (node?.effective ?? '—')
  console.log(
    `  ${String(width + '×' + height).padEnd(9)}` +
      ` iframe ${page.iframe ? page.iframe.w + '×' + page.iframe.h : '—'}` +
      ` 舞台 ${inner.svgBox ? inner.svgBox.w + '×' + inner.svgBox.h : '—'}` +
      ` 缩放 ${inner.scale ?? '—'}×` +
      ` 节点 ${px(inner.node)}px（标称 ${inner.node?.nominal ?? '—'}）` +
      ` 副标签 ${px(inner.nodeSub)}px` +
      ` 标题 ${px(inner.title)}px  字幕 ${px(inner.caption)}px  步骤条 ${px(inner.chip)}px`
  )
  // ★ 步骤条的**原文**与正文里的编号（D-087）：量词必须是这套动画自己的那个词
  //   （「第 2 段 / 共 4 段」，而不是运行时的兜底「步」），序号要与正文同值。
  //   源码级守卫看不出这件事 —— 量词要经 `defer` 的透传才到得了 runtime，只有真跑起来才知道。
  console.log(
    `\u001b[2m             步骤条原文「${inner.chipText ?? '—'}」  正文编号 ${JSON.stringify(inner.ordinals ?? [])}\u001b[0m`
  )
}
await cdp.send('Emulation.clearDeviceMetricsOverride')
frameCdp.close()

console.log(`\n\u001b[1m【门槛判定】\u001b[0m`)
for (const row of rows) {
  const { page, inner } = row
  check(
    `${row.viewport} 动画缩放 ≥ ${MIN_SCALE}×（不许把画面缩到原尺寸以下）`,
    (inner.scale ?? 0) >= MIN_SCALE,
    `实测 ${inner.scale ?? '—'}×（画布 ${inner.svgBox?.w ?? '—'}×${inner.svgBox?.h ?? '—'}，` +
      `外壳 ${inner.stageBox?.h ?? '—'}px / iframe ${page.iframe?.h ?? '—'}px）`
  )
  if (row.viewport === BASELINE_VIEWPORT) {
    check(
      `${row.viewport}（设计基准）节点标签有效字号 ≥ ${MIN_NODE_PX}px`,
      (inner.node?.effective ?? 0) >= MIN_NODE_PX,
      `实测 ${inner.node?.effective ?? '—'}px = 标称 ${inner.node?.nominal ?? '—'} × ${inner.scale ?? '—'}`
    )
    // ★ 这条是**眼看出来**才补的：舞台长高后播放控制被顶到折线以下（截图里一眼可见），
    //   而「看的时候随时要按暂停」的控件不该藏起来 —— 所以预留量按「舞台 + 控制条」算。
    check(
      `${row.viewport}（设计基准）播放控制条在视口内`,
      (page.footerBottom ?? Number.POSITIVE_INFINITY) <= page.viewport.h,
      `控制条底边 ${page.footerBottom ?? '—'}px / 视口 ${page.viewport.h}px`
    )
  }
  check(
    `${row.viewport} 外壳字幕 ≥ ${MIN_CAPTION_PX}px、步骤条 ≥ ${MIN_CHIP_PX}px（不随舞台缩放，必须自己够大）`,
    (inner.caption?.nominal ?? 0) >= MIN_CAPTION_PX && (inner.chip?.nominal ?? 0) >= MIN_CHIP_PX,
    `实测字幕 ${inner.caption?.nominal ?? '—'}px / 步骤条 ${inner.chip?.nominal ?? '—'}px`
  )
  check(
    `${row.viewport} iframe 内部没有纵向滚动条`,
    inner.innerScroll?.overflow === false,
    `scrollH ${inner.innerScroll?.scrollH} / clientH ${inner.innerScroll?.clientH}`
  )
}

const first = rows[0]?.inner
const last = rows[rows.length - 1]?.inner
console.log(
  `\n\u001b[1m结果：${findings.length === 0 ? '\u001b[32m通过' : '\u001b[31m有发现'}\u001b[0m  ` +
    `通过 ${passed} 项 / 发现 ${findings.length} 项` +
    `\u001b[2m（缩放 ${first?.scale ?? '—'}×…${last?.scale ?? '—'}×；` +
    `节点 ${first?.node?.effective ?? '—'}…${last?.node?.effective ?? '—'}px）\u001b[0m`
)
cdp.close()
process.exit(findings.length === 0 ? 0 : 1)
