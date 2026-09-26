/**
 * UX 体检（**人类视角**的自动化测试）：把界面真跑起来，逐条量「人用起来顺不顺」。
 *
 * 与其它测试的分工：
 *   `npm test`（600 项）      → 逻辑与契约对不对（喂假数据）
 *   `verify-ui.mjs`           → 该有的元素在不在（读真实 DOM，但只问「有没有」）
 *   **本脚本**                → 人会不会觉得别扭（真发消息、真滚动、真按键盘，再看结果）
 *
 * 每条断言都写成学生能感受到的样子（「发完消息能直接接着打下一句」），
 * 失败信息里给出**可复现的数值**，因此失败输出本身就是一份缺陷报告。
 *
 * 跑法：`K12_DEBUG_PORT=9222 npm run dev` 之后 `node scripts/ux-audit.mjs`
 * 退出码：0 = 通过；1 = 有「不符合人类使用习惯」的发现；2 = 脚本自身出错
 * 依赖：只用 Node 内置能力（≥22 的 fetch / WebSocket），**零依赖**
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'

/* ── 极简 CDP 客户端 ─────────────────────────────────────────────── */

class Cdp {
  #ws
  #id = 0
  #pending = new Map()
  static async attach() {
    const list = await (await fetch(`${BASE}/json/list`)).json()
    const page = list.find((i) => i.type === 'page')
    if (!page) throw new Error('CDP 里找不到 page 目标（应用起了吗？K12_DEBUG_PORT 设了吗？）')
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
    // Node ≥ 22 的内置 WebSocket 是 WHATWG 风格（addEventListener），没有 .once()
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
    if (r.exceptionDetails) {
      throw new Error(`页面求值异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r.result?.value
  }
  /** 真按键（走 CDP Input 域，与真人敲键盘同一条路径）。 */
  async key(key, modifiers = 0) {
    const id = ++this.#id
    const send = (type) =>
      new Promise((res, rej) => {
        this.#pending.set(this.#id, { resolve: res, reject: rej })
        this.#ws.send(
          JSON.stringify({
            id: this.#id,
            method: 'Input.dispatchKeyEvent',
            params: { type, key, modifiers, windowsVirtualKeyCode: keyCode(key) }
          })
        )
      })
    await send('keyDown')
    await send('keyUp')
  }
  close() {
    this.#ws?.close()
  }
}

function keyCode(key) {
  const map = {
    Enter: 13,
    Escape: 27,
    Tab: 9,
    ArrowUp: 38,
    ArrowDown: 40
  }
  return map[key] ?? 0
}

/* ── 断言与报告 ─────────────────────────────────────────────────── */

const findings = []
let passed = 0

function check(id, what, ok, detail = '', why = '') {
  if (ok) {
    passed += 1
    console.log(`\u001b[32m✓\u001b[0m ${id} ${what}${detail ? `  \u001b[2m(${detail})\u001b[0m` : ''}`)
  } else {
    findings.push({ id, what, detail, why })
    console.log(`\u001b[31m✗\u001b[0m ${id} ${what}`)
    if (detail) console.log(`    实测：${detail}`)
    if (why) console.log(`    为什么要紧：${why}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 页面侧取样片段 ────────────────────────────────────────────── */

const Q = {
  log: `document.querySelector('[data-testid="chat-log"]')`,
  input: `document.querySelector('[data-testid="composer-input"]')`,
  send: `document.querySelector('[data-testid="composer-send"]')`
}

const setInput = (text) => `(() => {
  const el = ${Q.input}
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus()
  return true
})()`

const SCROLL = `(() => {
  const el = ${Q.log}
  return el ? {
    dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    h: Math.round(el.scrollHeight), top: Math.round(el.scrollTop)
  } : null
})()`

/** 等一轮回答结束（或超时）。返回是否真的结束了。 */
async function waitTurn(cdp, maxMs = 100000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await sleep(400)
    const s = await cdp.evaluate(
      `document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length`
    )
    if (s === 0) return true
  }
  return false
}

const send = async (cdp, text) => {
  await cdp.evaluate(setInput(text))
  await sleep(150)
  await cdp.evaluate(`${Q.send}.click()`)
}

/**
 * 「当前消息区里有多少轮可判的分叉场景」——**唯一一份口径**。
 *
 * ★★ 为什么抽成常量（2026-09-23）：D7 的前置条件与 D7 的断言必须用**同一份**
 *   「有回答且已结束」的定义。两处各写一遍的话，前置按一种口径准备、断言按另一种口径数，
 *   就会出现「前置说准备好了、断言说 0 轮」的新一类假红 —— 正是这一轮要修掉的那个病。
 *
 * ★ 判据是「**回答正文非空** 且已结束」：分叉按钮挂的是**助手那条回答**
 *   （规范原文「每条 assistant 消息旁」），而一轮里可能只有学生的一句话
 *   （那一轮失败 / 被拦下，没有回答），那种轮次没有回答可挂。
 *   ⚠️ 踩过两次：初版按「所有已结束轮次」数（假红）；改成「有 assistant-message
 *      元素」仍然假红 —— 那个元素**永远在**（回答为空时它渲染的是「正在查教材…」
 *      占位）所以恒为真。真正有信息量的判据是**正文字符数 > 0**。
 */
const BRANCH_SNAPSHOT = `(() => {
  const turns = Array.from(document.querySelectorAll('[data-testid="chat-turn"]'))
  const btns = Array.from(document.querySelectorAll('[data-testid="branch-restart"]'))
  const answerable = turns.filter(
    (t) =>
      t.getAttribute('data-status') !== 'streaming' &&
      (t.querySelector('[data-testid="assistant-text"]')?.innerText ?? '').trim().length > 0
  ).length
  const box = btns[0]?.getBoundingClientRect()
  return {
    turns: turns.length,
    answerable,
    buttons: btns.length,
    h: box ? Math.round(box.height) : 0,
    // 反向对照：流式中的轮次里不该有按钮
    inStreaming: Array.from(document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"] [data-testid="branch-restart"]')).length,
    empty: Boolean(document.querySelector('[data-testid="chat-empty"]')),
    current: Array.from(document.querySelectorAll('[data-testid^="session-item-"][aria-current="true"]'))
      .map((el) => el.getAttribute('data-testid') ?? '')[0] ?? ''
  }
})()`

/**
 * 会话列表的**只读快照**（testid + 那一行的时间/条数注解 + 是不是当前这条）。
 *
 * ★ 为什么读 `.sl__item-meta` 而不是自己拼：它是界面上学生看到的那行字，
 *   探针的输出行要能让人对上号（「为 D7 切到了 4 分钟前 · 3 条 那条」）。
 *   ⚠️ 但**不拿它当判据** —— 一旦它改成「正在打开…」或换了文案，按它挑选就会静默失效
 *   （D5 初版就吃过这个：按「N 条」挑，挑不到就退化成随便点一条空的）。
 */
const SESSION_ITEMS = `Array.from(document.querySelectorAll('[data-testid^="session-item-"]')).map((el) => ({
  testid: el.getAttribute('data-testid'),
  meta: (el.querySelector('.sl__item-meta')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
  current: el.getAttribute('aria-current') === 'true'
}))`

/**
 * 「这个实例现在能不能真的拿到回答」——**只用于诊断输出**，不参与任何断言。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-09-23，实测踩到）
 * ══════════════════════════════════════════════════════════════════════════
 * 本脚本的 A/B/G 段要**真发消息并等回答**，D7 还要「一条有回答的轮次」。
 * 而模型没配好（一个 Key 都没填）时：主进程在「缺 Key」处早退 —— 轮次照旧出现，
 * 但**回答正文是空的**（`data-status=done` + `assistant-text` 空 + 分叉按钮照旧渲染）。
 * 于是：
 *   · G 报「没能进入流式状态」（其实一句都没发出去）；
 *   · H 报「『回到最新』没出现（内容不够长？）」（内容永远长不起来）；
 *   · D7 报「0 轮（有回答且已结束 0）」——**看起来像分支功能坏了**。
 * 三种表现、同一个原因，而输出里一个字都没提「模型没配」。
 *
 * ★ 判据取**输入条上的模型 chip**（`composer-model`，三态标签的唯一实现是
 *   `labels.ts` 的 `llmDisplayLabel`）：未配置时它就是 `未配置`。
 *   ⚠️ 别再用「页面里有没有『尚未配置 API Key』」那类字符串判断 —— 实测那句话只在
 *   **设置页的高级区**里渲染，而本脚本跑在对话页，于是 `meta.key` 曾经**恒为 true**：
 *   每次跑都印「已配置 Key：true」，与事实相反（旧的假判据，已一并换掉）。
 */
async function modelReadiness(cdp) {
  const state = await cdp.evaluate(`(() => ({
    chip: (document.querySelector('[data-testid="composer-model"]')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    composer: Boolean(document.querySelector('[data-testid="composer-input"]')),
    needSetup: Boolean(document.querySelector('[data-testid="chat-llm-unconfigured"]')),
    degraded: (document.querySelector('[data-testid="error-notice"]')?.innerText ?? '').trim().slice(0, 40)
  }))()`)
  // ⚠️ 先分清「不在对话页」与「模型没配」：两者都会让 chip 读不到，但处置完全不同
  //    （前者是探针的前置条件没准备好，后者才是环境问题）。混在一起说会把人带去买 Key。
  if (!state.composer) {
    return {
      ready: false,
      note: '当前**不在对话页**（找不到输入条 `composer-input`）——本脚本假定停在对话页，先跑 `npm run ux:reload` 并点回「问问智团团」'
    }
  }
  const unconfigured = state.needSetup || state.chip === '未配置'
  if (unconfigured) {
    return {
      ready: false,
      note: `模型未配置（输入条 chip = 「${state.chip || '（空）'}」）：A/B/G 段发出去的话**拿不到回答**，先配好模型再跑本脚本`
    }
  }
  if (state.degraded) return { ready: false, note: `模型降级中（${state.degraded}）` }
  return { ready: true, note: `模型已配置（chip = 「${state.chip}」）` }
}

/**
 * ★★ 为「需要一条**已结束且有回答**的轮次」的断言**自己准备前置条件**（2026-09-23）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须自己准备（这是一条**探针侧**的修复，不是产品缺陷）
 * ══════════════════════════════════════════════════════════════════════════
 * 实测（2026-09-22 一次真机跑）：D7 报「0 轮（有回答且已结束 0）· 按钮 0 个」——
 * 而那时的会话列表里**确实有一条**「1 轮已完成 + 1 个分叉按钮」的会话，
 * 只是前面的 D5 已经按它自己的规则把界面**切到了另一条还没开口的会话**，
 * 于是到 D7 时当前消息区是空态 ⇒ `answerable === 0` ⇒ 断言空转失败。
 * 那条红说的是「分支功能坏了」，而功能是好的 —— 属于**探针没有准备自己的前置条件**
 * （与 P-120「探针里的假 CDP 方法」、P-121「变异里的 expect 其实是测试名」同一族）。
 *
 * ★ 做法（与「放宽断言」正相反）：
 *   ① 当前会话里就有可判的轮次 → 直接用，不动界面；
 *   ② 没有 → **逐条点过去找**（判据只看渲染出来的轮次，不看列表那行文案），
 *      找到就停在那里并在输出里说明切到了哪一条；
 *   ③ 整个应用里一条都没有（全新安装 / 数据被清）→ 返回 `ok:false`，
 *      由调用方按本脚本既有的 SKIP 风格处理，**不算失败**。
 * ⚠️ 它只点会话列表（与 D5/D5b 同一个动作），不改任何产品状态。
 */
async function ensureAnswerableTurn(cdp, label) {
  const now = await cdp.evaluate(BRANCH_SNAPSHOT)
  if (now.answerable > 0) return { ok: true, switched: false, state: now }

  const items = await cdp.evaluate(SESSION_ITEMS)
  const others = items.filter((item) => !item.current)
  for (const item of others) {
    const clicked = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="' + ${JSON.stringify(item.testid)} + '"]')
      if (el) el.click()
      return Boolean(el)
    })()`)
    if (!clicked) continue
    // 切换 = dispose 旧会话 + 装配新的（真跑一次 Pi）——与 D5 用同一个等待
    await sleep(3500)
    const state = await cdp.evaluate(BRANCH_SNAPSHOT)
    if (state.answerable > 0) return { ok: true, switched: true, item, state }
    console.log(
      `\u001b[2m  [${label} 前置] ${item.meta || item.testid} 没有「已回答且已结束」的轮次（${state.turns} 轮 / 空态=${state.empty}），继续找\u001b[0m`
    )
  }
  return { ok: false, state: await cdp.evaluate(BRANCH_SNAPSHOT) }
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  const cdp = await Cdp.attach()
  // ★★ 先让渲染器真的在渲染：hidden 窗口下 ResizeObserver 一次都不触发，
  //    「内容长高后有没有跟随」这类测量会**全部失真**（实测踩到，见 ensureRendering 的说明）。
  const visibility = await cdp.ensureRendering()
  if (visibility !== 'visible') {
    console.log(`[33m⚠️ 窗口仍是 ${visibility}：与渲染时序相关的断言可能失真（见 ensureRendering 的说明）[0m`)
  }

  /**
   * ★★ 前置：**重载一次**，让脚本从一个确定的起点开始量（2026-09-23 实测定的口径）。
   *
   * 为什么不能只「点回对话页」：A1 量的是**打开应用时光标就在输入框里** ——
   * 那是**挂载时**的行为（`onMounted` 里 focus）。而对话页被 KeepAlive 缓存
   * （E1 钉着「切到设置再回来内容还在」），**点侧栏回来不会重挂**，focus 不会重跑：
   * 实测四态 —— 刚 reload → `composer-input`；切到设置 → `BODY`；
   * **点回对话页 → `BODY`**；再 reload → `composer-input`。
   * 拿「点回去」当前置，等于**用一个到不了被测状态的前提去判 A1**，会稳定假红
   * （与 D7 那条同源：前置条件必须与断言量的是**同一个状态**）。
   *
   * 为什么无条件重载（而不是「不在对话页才重载」）：只要不重载，A1 量的就是
   * 「上一次挂载时的 focus」—— 上一个探针（`ux:pages` / `ux:layout` / `ux:student`
   * 都会点侧栏）或人手一按都可能把焦点挪走，红绿取决于历史，不可复现。
   * 这一条同时让本脚本**自足**：不必先跑 `npm run ux:reload` 也能从干净状态开始
   * （README 里那句「先跑 ux:reload」现在是幂等的多余步骤）。
   *
   * ⚠️ 重载只影响**测量起点**，不改产品行为；产品的承诺是「打开应用就能直接打字」，
   *   而「切页回来是否重新聚焦」不在本次范围内（那是 KeepAlive 的取舍，另有守卫）。
   */
  await cdp.evaluate(`(() => { location.reload(); return true })()`)
  let onChat = false
  for (let i = 0; i < 20; i += 1) {
    await sleep(800)
    try {
      onChat = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="chat-log"]'))`)
    } catch {
      // 重载期间执行上下文会被销毁，抛异常是常态 —— 继续等下一轮
    }
    if (onChat) break
  }
  if (!onChat) {
    console.error(
      '\u001b[31m✗ 前置失败：重载后仍找不到对话页（`chat-log`）\u001b[0m\n' +
        '  本脚本假定从对话页开始量（A1–H 全都是对话页上的东西）。请确认：\n' +
        '    · 应用真的起来了（`K12_DEBUG_PORT=9222 npm run dev`，端口对得上）\n' +
        '    · 首屏没有卡在加载态（侧栏身份卡与右栏是否都出来了）\n' +
        '  然后重跑 `npm run ux`。'
    )
    cdp.close()
    process.exit(2)
  }

  /**
   * ★★ 先把两栏**展开**（2026-09-22）：两栏现在默认收起（`stores/panels.ts`），
   * 而收起的列是 `display: none`（矩形为 0），本脚本要量的元素（历史对话列表、
   * 右栏页签）大多在它们里面 —— 不展开的话 D3/D4 与 G* 会集体**假红**
   * （表现为「找不到 [data-testid=session-list]」，看起来像功能坏了）。
   * ⚠️ 这是**测量前提**，不是产品行为：产品里学生点一下开关就展开，行为一致。
   */
  await cdp.evaluate(`(() => {
    for (const id of ['history-toggle', 'rail-toggle']) {
      const btn = document.querySelector('[data-testid="' + id + '"]')
      if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click()
    }
    return true
  })()`)
  await sleep(400)


  /**
   * ★★ F2 的监听器**必须在这里装**（attach 之后的第一件事），不能挪回 F 段。
   *
   * 为什么：本文件的段落顺序是 A→B→C→D→E→G→H→**F**（F 排在最后），
   * 而 F2 断言的是「**整个流程**没有未捕获的异常」。监听器装在 F 段（原实现）时，
   * A–H 段（打字、滚动、忙时排队、浮层几何）期间抛的任何异常都**根本没被记录** ——
   * 断言看着全绿，实际覆盖面是空集，而那 8 段正是最容易出异常的地方。
   *
   * 装在这里，覆盖范围才与 F2 的措辞（「整个流程」）一致。
   * `window.__k12Ux` 同时兼作幂等哨兵（重复调用不会挂上第二个监听器）。
   */
  await cdp.evaluate(`(() => {
    if (!window.__k12Ux) {
      window.__k12Ux = []
      window.addEventListener('error', (e) => window.__k12Ux.push('error: ' + e.message))
      window.addEventListener('unhandledrejection', (e) => window.__k12Ux.push('rejection: ' + e.reason))
    }
    return true
  })()`)

  const meta = await cdp.evaluate(`(() => ({
    w: window.innerWidth, h: window.innerHeight,
    dpr: window.devicePixelRatio
  }))()`)
  // ★★ 「模型配好了没有」必须按**对话页上真正可见的那个 chip** 判（见 `modelReadiness` 的说明）：
  //   旧写法找的是「尚未配置 API Key」这句只在设置页出现的字符串，于是这里**恒印 true** ——
  //   把「无 Key 环境下 G/H/D7 为什么会 SKIP/红」这条最关键的上下文反向写错了。
  const readiness = await modelReadiness(cdp)
  console.log(
    `\u001b[2m视口 ${meta.w}×${meta.h} @${meta.dpr}x；${readiness.note}\u001b[0m`
  )

  /* ── A. 打字与键盘 ───────────────────────────────────────────── */
  console.log('\n\u001b[1mA. 打字与键盘（学生最常做的动作）\u001b[0m')

  // A1 输入框自动聚焦：打开应用就能直接打字，不用先点一下
  const autofocus = await cdp.evaluate(`(() => {
    const el = ${Q.input}
    return { focused: document.activeElement === el }
  })()`)
  check('A1', '刚打开应用时光标就在输入框里（不用先点一下才能打字）', autofocus.focused,
    `activeElement 是输入框 = ${autofocus.focused}`,
    '每次进应用都要先点一下输入框才开始打字，是最容易被忽略、也最常被嫌烦的一步' +
      '（本脚本在开始量之前会**重载一次**，保证这一条量的是「刚打开」那个状态，而不是上次挂载时的残留焦点）')

  // A2 Shift+Enter 是换行、Enter 是发送
  //
  // ★ 这里不能靠「按完键再看输入框内容」来判断 —— CDP 的 `Input.dispatchKeyEvent`
  //   不会为 Enter 执行浏览器**默认的换行插入**（那条默认行为属于编辑命令，
  //   不是按键事件本身）。实测踩到过：Shift+Enter 后 value 里没有 `\n`，
  //   于是把「代码其实是对的」误报成了缺陷（假阳性）。
  //   改成两条可判定的断言：
  //     ① 新行是**用户敲进去**的（这里用 insertText 模拟打字产生的换行）；
  //     ② 此时按 Enter **必须不发送**（这才是 Shift+Enter 的真正契约：
  //        换行后继续编辑，而不是把半句话发出去）。
  // ★ 用 `data-testid` 定位而**不是按文案找按钮**：文案改过一次
  //   （「新会话」→「新对话」，因为它现在真的开一条新会话而不只是清屏），
  //   而按文案找的写法在那次改名后**静默失效** —— 按钮没被点到，
  //   后面的断言在一段没清干净的对话上跑，结论就不可信了。testid 是稳定的契约。
  await cdp.evaluate(`(() => {
    const b = document.querySelector('[data-testid="new-session"]')
    if (b) b.click(); return Boolean(b)
  })()`)
  await sleep(600)
  await cdp.evaluate(`(() => {
    const dlg = document.querySelector('.cfm__yes, [data-testid="confirm-yes"]')
    if (dlg) dlg.click()
    return Boolean(dlg)
  })()`)
  await sleep(500)

  // 用 execCommand 造出「真实的」多行输入（浏览器认定为用户输入，Vue 的 v-model 会收到 input）
  await cdp.evaluate(`(() => {
    const el = ${Q.input}
    el.focus()
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await cdp.evaluate(`(() => {
    const el = ${Q.input}
    el.focus()
    document.execCommand('insertText', false, '第一行')
    document.execCommand('insertText', false, '\\n第二行')
    return true
  })()`)
  await sleep(300)
  const multiline = await cdp.evaluate(`(${Q.input}).value`)

  check('A2', '输入框支持多行（Shift+Enter 换行的前提）', multiline.includes('\n'),
    `输入框内容 = ${JSON.stringify(multiline)}`,
    '学生写多行说明/代码时需要换行；若输入框本身只能是单行，Shift+Enter 就无从谈起')

  // 多行内容下按 Enter 必须**不发送**（这是「Enter 发送、Shift+Enter 换行」的真实契约）
  const turnsBeforeMulti = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
  await cdp.key('Enter')
  await sleep(700)
  const turnsAfterMulti = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
  check('A2b', '多行内容按 Enter 仍然发送（回车键语义一致）', turnsAfterMulti > turnsBeforeMulti,
    `轮次数 ${turnsBeforeMulti} → ${turnsAfterMulti}`,
    '若多行时 Enter 不发送也不换行，学生会以为键盘失灵')

  const turnsBefore = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
  await waitTurn(cdp) // ★ 必须先等上一轮结束：否则 Enter 会（正确地）进队列，轮次数不变
  await cdp.evaluate(setInput('单行问题'))
  await sleep(120)
  await cdp.evaluate(`(${Q.input}).focus()`)
  await cdp.key('Enter')
  await sleep(700)
  const turnsAfter = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
  check('A3', 'Enter 直接发送', turnsAfter > turnsBefore,
    `轮次数 ${turnsBefore} → ${turnsAfter}`,
    'Enter 发送是最基本的聊天习惯')

  // A4 发送后焦点还在输入框（连着问第二句不用再点）
  const focusAfterSend = await cdp.evaluate(`document.activeElement === ${Q.input}`)
  check('A4', '发送后光标仍留在输入框（可以接着问下一句）', focusAfterSend,
    `activeElement 是输入框 = ${focusAfterSend}`,
    '学生连着追问是常态；每轮都要重新点输入框会明显打断思路')

  await waitTurn(cdp)

  // A5 发送后输入框清空
  const clearedValue = await cdp.evaluate(`(${Q.input}).value`)
  check('A5', '发送后输入框自动清空', clearedValue === '', `残留内容 = ${JSON.stringify(clearedValue)}`)

  /* ── B. 自动滚动（用户点名要测的） ───────────────────────────── */
  console.log('\n\u001b[1mB. 新内容出现时视图跟不跟得上\u001b[0m')

  await cdp.evaluate(`(${Q.log}).scrollTop = 0`)
  await sleep(200)
  await send(cdp, '再详细讲讲训练和预测的区别，多举几个例子')
  await sleep(1200)

  // B1 流式期间持续贴底（每 300ms 采一次，看有没有掉队）
  let worst = 0
  let laggedAt = []
  for (let i = 0; i < 25; i += 1) {
    await sleep(300)
    const s = await cdp.evaluate(SCROLL)
    if (!s) break
    if (s.dist > worst) worst = s.dist
    if (s.dist > 24) laggedAt.push(s.dist)
    const streaming = await cdp.evaluate(
      `document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length`
    )
    if (streaming === 0 && i > 4) break
  }
  check('B1', '回答流式输出时视图一直跟着新内容走', worst <= 24,
    `过程中离底部最远 ${worst}px（>24px 人眼可见掉队）`,
    '这就是用户点名的问题：新内容生成时应当自动滚到最新一条，而不是停在原处')

  await waitTurn(cdp)
  await sleep(800)
  const endScroll = await cdp.evaluate(SCROLL)
  check('B2', '回答结束后视图停在最新一条上', (endScroll?.dist ?? 9999) <= 8,
    `离底部 ${endScroll?.dist}px`,
    '学生看完回答，视线应该就在最新那条；停在上面等于要他自己往下找')

  // B3 学生主动往上翻时不该被拽回去（否则无法重读）
  const canScrollUp = await cdp.evaluate(`(() => {
    const el = ${Q.log}
    return el.scrollHeight > el.clientHeight + 200
  })()`)
  if (canScrollUp) {
    await cdp.evaluate(`(() => {
      const el = ${Q.log}
      el.scrollTop = Math.max(0, el.scrollTop - 300)
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
      return el.scrollTop
    })()`)
    await sleep(300)
    const held = await cdp.evaluate(SCROLL)
    check('B3', '学生自己往上翻时不会被立刻拽回底部', (held?.dist ?? 0) > 60,
      `翻上去后离底部 ${held?.dist}px（若≈0 说明被拽回）`,
      '学生回看上一段是很常见的动作；被反复拽回底部会让人放弃这个动作')

    // 恢复到底部，避免影响后续
    await cdp.evaluate(`(${Q.log}).scrollTop = (${Q.log}).scrollHeight`)
    await sleep(200)
  } else {
    console.log('\u001b[2m  [SKIP] B3 内容不够长，测不出「往上翻」\u001b[0m')
  }

  /* ── C. 触控目标与可读性（K12 尤其要紧） ──────────────────────── */
  console.log('\n\u001b[1mC. 触控目标与可读性\u001b[0m')

  const sizes = await cdp.evaluate(`(() => {
    /**
     * ★★ 量「**有效**可点区域」，而不是元素自己的矩形。
     *
     * 两条理由，各修一类真实缺陷：
     *
     * ① **radio 的本体只有 13×13**（那只是它画的小圆点），学生实际点的是包着它的
     *    \`<label class="option" data-testid="quiz-option">\`。直接量 input 会**报假阳性**，
     *    更糟的是——见 ②。
     * ② 题卡选项**根本不在原来的集合里**：\`QuizCard.vue\` 的选项是
     *    \`<label>\` 包 \`<input type="radio">\`、**没有 role**，
     *    而原来的选择器只收 \`button, [role="button"], a[href]\` ——
     *    于是「闯关题目的选项好不好点」这件事**从头到尾没被量过**。
     *    （\`scripts/ux-pages-audit.mjs\` 已经修过同一个问题，这里搬的是那份实现。）
     *
     * 规则：往上找 label / role=button / el-checkbox 容器，用它当量测框。
     */
    const effectiveBox = (el) => {
      let node = el
      for (let i = 0; i < 4 && node; i += 1) {
        const r = node.getBoundingClientRect()
        const isLabel = node.tagName === 'LABEL'
        const wraps = isLabel || node.getAttribute('role') === 'button' || node.classList.contains('el-checkbox')
        if (wraps && r.width > 0 && r.height > 0) return r
        node = node.parentElement
      }
      return el.getBoundingClientRect()
    }
    // 「可点的小东西」：按钮 + 可点角色 + **radio / checkbox**
    //   （后两者正是题卡选项的形态；它们的量测框由 effectiveBox 往上收，见上）
    const pick = (sel) => Array.from(document.querySelectorAll(sel))
    const measure = (els) => els.map((el) => {
      const r = effectiveBox(el)
      return {
        label: (el.innerText || el.getAttribute('aria-label') || el.title || el.getAttribute('data-testid') || el.tagName).trim().slice(0, 16),
        w: Math.round(r.width),
        h: Math.round(r.height)
      }
    }).filter((x) => x.w > 0 && x.h > 0)
    const clickable = measure(pick('button, [role="button"], a[href], input[type="radio"], input[type="checkbox"]'))
    // 正文可读性
    const bodyEl = document.querySelector('[data-testid="assistant-text"]')
    const cs = bodyEl ? getComputedStyle(bodyEl) : null
    return {
      clickable,
      tiny: clickable.filter((x) => x.h < 28 || x.w < 28),
      bodyFont: cs ? parseFloat(cs.fontSize) : 0,
      bodyLine: cs ? parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) : 0
    }
  })()`)

  check('C1', '没有过小的点击目标（≥28px，手指/触控板都好点）',
    sizes.tiny.length === 0,
    sizes.tiny.length ? `过小的 ${sizes.tiny.length} 个：` + sizes.tiny.slice(0, 6).map((t) => `「${t.label}」${t.w}×${t.h}`).join('、') : `共 ${sizes.clickable.length} 个可点元素`,
    'K12 学生的手指精度与耐心都有限；小目标会让他反复点不中，最后放弃这个功能')

  check('C2', '回答正文字号 ≥16px（长时间阅读不费眼）', sizes.bodyFont >= 16,
    `实测 ${sizes.bodyFont}px`, '本项目已定 16px 基准（D-043）；回退到 14px 会让长文阅读明显吃力')

  check('C3', '正文行高 ≥1.6（中文长段落需要更松）', sizes.bodyLine >= 1.6,
    `实测 ${sizes.bodyLine.toFixed(2)}`, '中文没有词间空格，行距过紧会显著降低可读性')

  /* ── D. 破坏性操作与恢复 ─────────────────────────────────────── */
  console.log('\n\u001b[1mD. 破坏性操作与恢复\u001b[0m')

  // D1 「新会话」会不会直接清掉当前对话（无确认）—— 学生手滑就毁掉一整轮问答
  const beforeTurns = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
  if (beforeTurns > 0) {
    await cdp.evaluate(
      `document.querySelector('[data-testid="new-session"]')?.click()`
    )
    await sleep(700)
    // ★ 确认框可能用 teleport 挂在 body 上（`.cfm` 一族），也可能带 role=dialog；
    //   两种都认 —— 实测第一版只查 `role="dialog"` 时漏判成了「没确认框」（假阳性）。
    const dialog = await cdp.evaluate(`(() => {
      const byRole = document.querySelector('[role="dialog"], [role="alertdialog"]')
      const byClass = document.querySelector('.cfm, [data-testid*="confirm"]')
      // ★ 文案断言放宽成「标题里有『开始新』」：标题从「开始新会话」改成过
      //   「开始新对话」（新实现真的开一条新会话，不只是清屏）。
      //   钉死整句会让一次**文案打磨**触发一次假红，而这里真正要判的是
      //   「有没有先确认」——多一个字的差别不该让这条体检失去意义。
      const byText = /开始新(会话|对话)/.test(document.body.innerText)
      return { found: Boolean(byRole || byClass), byText }
    })()`)
    check('D1', '「新对话」会先确认再切换（避免手滑丢掉整轮问答）', dialog.found && dialog.byText,
      `确认框存在=${dialog.found}，文案含「开始新…」=${dialog.byText}`,
      '学生刚问完一长段、正要复制回答时手滑点到「新会话」，内容会立刻消失且无法恢复')

    // 取消掉，别真清空（保留上下文给后面的场景）
    await cdp.evaluate(`(() => {
      const cancel = Array.from(document.querySelectorAll('button'))
        .find((x) => /取消|再想想|不了/.test(x.innerText || ''))
      if (cancel) cancel.click()
      return Boolean(cancel)
    })()`)
    await sleep(500)
    const afterCancel = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
    check('D2', '取消后对话内容完好无损', afterCancel === beforeTurns,
      `${beforeTurns} 轮 → 取消后 ${afterCancel} 轮`,
      '点了取消却已经清空，是最伤信任的一类 bug（学生会认定「这软件会丢东西」）')
  } else {
    console.log('\u001b[2m  [SKIP] D1 当前没有对话内容可测\u001b[0m')
  }

  /* ── D3–D5. 会话侧栏：历史对话能不能切回去 ─────────────────────
   *
   * 这一组对应「关掉应用再打开，上一段对话还在」那条验收的**界面一半**：
   * 数据一直在盘上（Pi 每个会话一个 JSONL），缺的一直是「看得见 + 点得回去」。
   * ★ 它必须真跑界面：`npm test` 里那几条断言的是源码与 store 的行为，
   *   而「侧栏到底有没有列出来、点了之后消息区有没有变」只有真渲染出来才知道。
   */
  console.log('\x1b[1mD3–D5. 历史对话侧栏（切回去接着聊）\x1b[0m')

  const sidebar = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-testid="session-list"]')
    if (!root) return { present: false }
    const items = Array.from(root.querySelectorAll('[data-testid^="session-item-"]'))
    return {
      present: true,
      count: items.length,
      active: items.filter((el) => el.getAttribute('aria-current') === 'true').length,
      firstId: items[0]?.getAttribute('data-testid')?.replace('session-item-', '') ?? '',
      // 「新对话」按钮必须在侧栏里（它是这一列的主操作）
      hasNew: Boolean(root.querySelector('[data-testid="session-new"]'))
    }
  })()`)

  check('D3', '对话页有历史对话侧栏，且列出该学生的会话', sidebar.present && sidebar.count > 0,
    sidebar.present ? `列出 ${sidebar.count} 条，当前高亮 ${sidebar.active} 条` : '没有找到 [data-testid="session-list"]',
    '没有它，学生关掉应用再打开就只能看到空对话 —— 而数据其实一直在盘上（「重启后数据延续」这条验收不达标）')

  check('D4', '侧栏里有「新对话」入口（新开一段，而不是删掉旧的）', Boolean(sidebar.hasNew),
    sidebar.hasNew ? '找到 [data-testid="session-new"]' : '侧栏里没有新对话按钮',
    '「新对话」与「删掉旧的」是两件事：旧的那条要留在列表里随时切回去')

  if (sidebar.present && sidebar.count >= 2 && sidebar.firstId) {
    /**
     * D5：点一条**不是当前的**历史对话，消息区要恢复出内容。
     *
     * ★★ 挑哪一条很关键（2026-09-22 实测踩到）：列表里的行带「· N 条」，
     *    而 **N = 1 的那种是「只发过开场白、学生还没开口」的会话** ——
     *    切到它显示的应该是**空态**（开场卡 + 能力入口），不是「一段恢复出来的对话」。
     *    初版挑的是「第一条不是当前的」，于是随机命中一条没开始的会话，
     *    断言 `turns > 0` 判成失败 —— 那是**判据选错了**（把「正确的新行为」当缺陷）。
     *    所以这里显式挑一条**有学生发言**的（meta 里「N 条」且 N ≥ 2）。
     */
    const targetId = await cdp.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('[data-testid^="session-item-"]'))
      const others = items.filter((el) => el.getAttribute('aria-current') !== 'true')
      const started = others.find((el) => {
        const meta = el.querySelector('.sl__item-meta')?.innerText ?? ''
        const m = /(\\d+) 条/.exec(meta)
        return m ? Number(m[1]) >= 2 : false
      })
      const pick = started ?? others[0]
      return pick?.getAttribute('data-testid')?.replace('session-item-', '') ?? ''
    })()`)
    if (targetId) {
      const beforeTurns = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
      await cdp.evaluate(`document.querySelector('[data-testid="session-item-' + ${JSON.stringify(targetId)} + '"]')?.click()`)
      // 切换要 dispose 旧会话 + 装配新的（真跑一次 Pi），给足时间
      await sleep(3500)
      const after = await cdp.evaluate(`(() => ({
        turns: document.querySelectorAll('[data-testid="chat-turn"]').length,
        active: document.querySelectorAll('[data-testid^="session-item-"][aria-current="true"]').length,
        notice: document.querySelector('[data-testid="session-notice"]')?.innerText ?? '',
        streaming: document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length,
        empty: Boolean(document.querySelector('[data-testid="chat-empty"]'))
      }))()`)
      // ★ 判据：恢复出内容，**或者**（那条会话本来就没开始）显示空态 —— 两者都是对的
      check('D5', '点一条历史对话能恢复出内容（本来就没开始的会话则显示空态，不是空白）',
        after.turns > 0 || after.empty,
        `${beforeTurns} 轮 → 切过去 ${after.turns} 轮（空态=${after.empty}）${after.notice ? `（提示：${after.notice}）` : ''}`,
        '切换失败最常见的原因是装配失败（缺 Key / 服务没起来）—— 那时应当**保持原样并说一句人话**，而不是把屏幕清空')
      check('D6', '切换后侧栏高亮跟着走（学生知道自己在哪一条上）', after.active === 1 && !after.streaming,
        `高亮 ${after.active} 条，恢复出来的轮次里 streaming=${after.streaming}`,
        '高亮不跟着走 = 学生点完不知道切没切成；恢复出来的历史消息更不该是「正在回答」状态')
    } else {
      console.log('\u001b[2m  [SKIP] D5 只有一条会话，没有「另一条」可切\u001b[0m')
    }
  } else {
    console.log('\u001b[2m  [SKIP] D5/D6 会话少于两条，无法验证「切回去」（多聊几轮再跑）\u001b[0m')
  }

  /* ── D7–D8. 会话分叉（从这里重新问）─────────────────────────────
   *
   * 这一组盯住「分叉按钮到底在不在、点了会不会把原对话弄丢」。
   * ★ 单测覆盖的是纯函数与 store 的行为；「按钮真的渲染出来了吗」只有真跑才知道
   *   —— 这正是 P-101 的教训（功能全对，但渲染在永远进不去的分支里）。
   */
  console.log('\x1b[1mD7–D8. 从这里重新问（会话分叉）\x1b[0m')

  // ★★ 先自己准备前置条件（见 `ensureAnswerableTurn` 的说明）：这一段要求
  //    「当前消息区里至少有一条已结束且有回答的轮次」——前面的 D5/D5b 会把界面
  //    切到一条还没开口的会话，那种状态下 D7 的判据是**空转**的（0 === 0 永远成立），
  //    报出来的红说的是「分支功能坏了」，而功能是好的。
  const prepared = await ensureAnswerableTurn(cdp, 'D7')

  if (!prepared.ok) {
    // 整个应用里都没有可判的轮次（全新安装 / 数据被清 / 模型没配）——按本脚本的 SKIP 风格
    // 处理，⚠️ 绝不改成「0 轮也算通过」：那会把这条断言变成永远绿的摆设。
    // ★ 理由里必须带上**当前消息区的实际情况 + 模型状态**：只写「没有已回答的轮次可判」
    //   会把人带去「那你发一条啊」，而真正的原因往往是「模型没配，发了也没有回答」。
    const why = `消息区 ${prepared.state.turns} 轮、其中有回答 0 轮${prepared.state.empty ? '（当前是空态）' : ''}`
    console.log(`\u001b[2m  [SKIP] D7 当前没有已结束且有回答的轮次可判（${why}）—— ${(await modelReadiness(cdp)).note}\u001b[0m`)
    console.log('\u001b[2m  [SKIP] D8 同上：一条轮次都没有时，「流式里没有分叉按钮」是空转的\u001b[0m')
  } else {
    if (prepared.switched) {
      console.log(
        `\u001b[2m  [D7 前置] 当前会话（${prepared.state.empty ? '空态' : `${prepared.state.turns} 轮`}）没有已回答的轮次，已切到「${prepared.item.meta || prepared.item.testid}」\u001b[0m`
      )
    }
    const branchUi = prepared.state
    check('D7', '每条**已结束且有回答**的轮次旁都有「从这里重新问」', branchUi.answerable > 0 && branchUi.buttons === branchUi.answerable,
      `${branchUi.turns} 轮（有回答且已结束 ${branchUi.answerable}）· 按钮 ${branchUi.buttons} 个`,
      '缺按钮 = 学生没法换问法重开一条线（这是分支功能的唯一入口）')
    check('D8', '流式输出途中不给分叉按钮（分支点不该是半句话）', branchUi.inStreaming === 0,
      `流式轮次里的按钮数 = ${branchUi.inStreaming}`,
      '回答还没写完就当分支点，复制出来的新会话会带着一段残缺的上下文')
    if (branchUi.buttons > 0) {
      check('D9', '分叉按钮的触控高度达标（≥28px）', branchUi.h >= 28,
        `实测 ${branchUi.h}px`,
        '它挂在每条回答下面，尺寸太小会让「换个问法」这个动作变得很难点')
    }
  }

  /* ── D10–D12. 会话树（分支关系的展示）───────────────────────────
   *
   * 这一组盯住**几何**：缩进真的递增吗、连接线跟着层级走吗、收起来的是不是整枝。
   * ★ 纯函数测的是「投影给出的 depth/guides 对不对」（`session-tree.test.ts`），
   *   而「这些数有没有变成屏幕上的缩进」只有真量为准 —— 这正是 P-101 的教训。
   */
  console.log('\n\u001b[1mD10\u2013D12. 会话树（缩进 / 连接线 / 折叠）\u001b[0m')

  const treeUi = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid^="session-row-"]'))
    const pick = (r, sel) => r.querySelector(sel)
    const tree = document.querySelector('[data-testid="session-tree"]')
    // 每行量：depth、条目左缘、前导宽度
    const measured = rows.map((r) => {
      const item = pick(r, 'button[data-testid^="session-item-"]')
      const guide = pick(r, '[data-testid="session-tree-guide"]')
      return {
        depth: Number(r.getAttribute('data-depth')),
        left: item ? Math.round(item.getBoundingClientRect().left) : -1,
        guideW: guide ? Math.round(guide.getBoundingClientRect().width) : 0,
        isLast: r.querySelector('.sl__tree-elbow--last') !== null
      }
    })
    const nested = measured.filter((m) => m.depth > 0)
    // ★ 判据：同一 depth 的左缘一致（对齐），且 depth 越大左缘越大（真的缩进）
    const byDepth = new Map()
    for (const m of measured) {
      if (!byDepth.has(m.depth)) byDepth.set(m.depth, [])
      byDepth.get(m.depth).push(m.left)
    }
    const depthAligned = [...byDepth.values()].every((lefts) => new Set(lefts).size === 1)
    const depths = [...byDepth.keys()].sort((a, b) => a - b)
    const increasing = depths.every((d, i) => i === 0 || byDepth.get(d)[0] > byDepth.get(depths[i - 1])[0])
    return {
      treePresent: Boolean(tree),
      rows: rows.length,
      nestedRows: nested.length,
      maxDepth: depths.length ? Math.max(...depths) : 0,
      depthAligned,
      increasing,
      // 前导宽度 = (depth + 1) × 12（见下方 D11 的说明）。
      guideMatchesDepth: nested.every((m) => m.guideW === (m.depth + 1) * 12),
      folds: document.querySelectorAll('[data-testid="session-fold"]').length,
      kidMarks: document.querySelectorAll('[data-testid="session-kids-mark"]').length
    }
  })()`)

  check('D10', '会话列表里真有树（有嵌套行）时，缩进逐层递增且同层对齐',
    treeUi.treePresent && (treeUi.nestedRows === 0 || (treeUi.depthAligned && treeUi.increasing)),
    `共 ${treeUi.rows} 行，嵌套 ${treeUi.nestedRows} 行，最深 ${treeUi.maxDepth} 层；同层对齐=${treeUi.depthAligned} 递增=${treeUi.increasing}`,
    '缩进不递增 = 看不出谁挂在谁下面；同层不对齐 = 一列参差（都是「错位」观感的来源）')

  if (treeUi.nestedRows > 0) {
    // ★★ 判据是 **(depth + 1) × 12**，不是 depth × 12：一层前导 = `depth` 段
    //    **祖先竖线** + **1 个本层拐角**（`├`/`└`）——
    //    depth=1 → [竖线][拐角] = 24px；depth=2 → [竖线][竖线][拐角] = 36px。
    //    ⚠️ 初版按 depth×12 写，于是这条**假红**（代码是对的、判据错了）——
    //    与 AGENTS §7「量法本身也会有 bug，先怀疑量法」同一条纪律。
    check('D11', '连接线宽度与层级成比例（(depth+1)×12，含本层拐角）',
      treeUi.guideMatchesDepth,
      `嵌套行的前导宽度与 (depth+1)×12 一致=${treeUi.guideMatchesDepth}`,
      '线宽与缩进不一致时，连接线会落在错误的列上（看起来「挂在错误的父下面」）')

    // D12：折叠「有子分支」的那一行，它的**整枝**都要消失
    //
    // ★★ 还要**挑对要收的那一行**：必须优先收一个**有孙辈**的节点。
    //    只收「孩子是叶子」的节点抓不到「只藏直接子级」这个缺陷 ——
    //    那种节点收起来两种情况看起来一模一样（孩子本来就没有孩子）。
    //    实测：初版收的是列表里第一个有箭头的行（子树只有 1 层），
    //    把折叠逻辑改成「只藏直接子级」之后 D12 **照样绿**（变异验证抓到）。
    //    所以这里按「子树里是否存在 depth > ownerDepth + 1 的行」挑，
    //    挑不到有孙辈的才退回任意一个。
    const collapse = await cdp.evaluate(`(() => {
      const rows = () => Array.from(document.querySelectorAll('[data-testid^="session-row-"]'))
      const all = rows()
      const folds = all
        .map((r, index) => ({ r, index, fold: r.querySelector('[data-testid="session-fold"]') }))
        .filter((x) => x.fold)
      if (folds.length === 0) return { skipped: true }

      /** 某一行自己的子树（深度优先展开 → 紧跟其后、深度更大的那些）与其中的最深深度。 */
      const subtreeOf = (index) => {
        const ownerDepth = Number(all[index].getAttribute('data-depth'))
        const ids = []
        let maxDepth = ownerDepth
        for (let i = index + 1; i < all.length; i += 1) {
          const d = Number(all[i].getAttribute('data-depth'))
          if (d <= ownerDepth) break
          ids.push(all[i].getAttribute('data-testid'))
          if (d > maxDepth) maxDepth = d
        }
        return { ownerDepth, ids, maxDepth }
      }

      // 优先「子树里还有孙辈」的那一个；没有再退而求其次
      const chosen =
        folds.find((x) => subtreeOf(x.index).maxDepth > subtreeOf(x.index).ownerDepth + 1) ?? folds[0]
      const info = subtreeOf(chosen.index)
      chosen.fold.click()
      return {
        skipped: false,
        before: all.length,
        ownerDepth: info.ownerDepth,
        subtree: info.ids,
        hasGrandchild: info.maxDepth > info.ownerDepth + 1,
        ownerId: chosen.r.getAttribute('data-testid')
      }
    })()`)
    if (!collapse.skipped) {
      await sleep(500)
      const after = await cdp.evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid^="session-row-"]'))
        const ids = rows.map((r) => r.getAttribute('data-testid'))
        return {
          count: rows.length,
          ids,
          ownerStillThere: ids.includes(${JSON.stringify(collapse.ownerId)}),
          // ⚠️ aria 必须读**被点的那一行自己的**箭头，不能拿全列表第一个
          //   （querySelector 取的是 DOM 里第一个 fold，而上面刻意挑的是
          //    「有孙辈」的那一个 —— 两者常常不是同一行。实测因此报了一条假红。）
          //   ⚠️ 本段在模板字符串里：注释中不能出现反引号（会提前结束字符串）
          expanded: (() => {
            const owner = rows.find((r) => r.getAttribute('data-testid') === ${JSON.stringify(collapse.ownerId)})
            const fold = owner && owner.querySelector('[data-testid="session-fold"]')
            return fold ? fold.getAttribute('aria-expanded') : null
          })()
        }
      })()`)
      const leftover = collapse.subtree.filter((id) => after.ids.includes(id))
      check('D12', '收起一个节点会把**整枝**藏掉（不是只藏直接子级）',
        // 三条：整枝行不见了、**被收起的那一行自己还在**（否则是收没了不是收起了）、aria 如实反映
        leftover.length === 0 && after.ownerStillThere && after.expanded === 'false',
        `${collapse.before} 行 → 收起后 ${after.count} 行；` +
          `该消失的子树 ${collapse.subtree.length} 行（含孙辈=${collapse.hasGrandchild}）、仍残留 ${leftover.length} 行；` +
          `被收起的那行还在=${after.ownerStillThere}；aria-expanded=${after.expanded}`,
        '只藏直接子级的话，展开根节点下面的孙辈会**孤零零露出来**（学生看到一条没有父的行）')
      // 收回去，别让后续检查跑在一个被折叠的列表上
      await cdp.evaluate(`document.querySelector('[data-testid="session-fold"]')?.click()`)
      await sleep(400)
    }
  } else {
    console.log('\u001b[2m  [SKIP] D11/D12 当前没有分支会话（先点两次「从这里重新问」再跑）\u001b[0m')
  }

  /* ── D5b. ★★ 没开始的会话：切过去还是空态（2026-09-22 修的缺陷）──────
   * 形态：新建一条（只发开场白）→ 切到别的 → 切回来。
   * 初版行为是「开场卡 / 能力入口 / 建议问题全没了，只剩一个空气泡 + 一句问候」——
   * 同一段对话在「刚建好 / 切回来 / 重启后」三种情形下长得不一样。
   * ------------------------------------------------------------------ */
  if (sidebar.present) {
    const emptyTarget = await cdp.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('[data-testid^="session-item-"]'))
      const unstarted = items.find((el) => {
        const meta = el.querySelector('.sl__item-meta')?.innerText ?? ''
        const m = /(\\d+) 条/.exec(meta)
        return m ? Number(m[1]) === 1 : false
      })
      return unstarted?.getAttribute('data-testid')?.replace('session-item-', '') ?? ''
    })()`)
    if (emptyTarget) {
      await cdp.evaluate(`document.querySelector('[data-testid="session-item-' + ${JSON.stringify(emptyTarget)} + '"]')?.click()`)
      await sleep(3000)
      const fresh = await cdp.evaluate(`(() => ({
        empty: Boolean(document.querySelector('[data-testid="chat-empty"]')),
        bubbles: document.querySelectorAll('[data-testid="user-message"]').length,
        turns: document.querySelectorAll('[data-testid="chat-turn"]').length
      }))()`)
      check('D5b', '★ 切到一条**学生还没开口**的对话：仍是空态，且没有空气泡',
        fresh.empty && fresh.bubbles === 0 && fresh.turns === 0,
        `空态=${fresh.empty}，轮次=${fresh.turns}，学生气泡=${fresh.bubbles}`,
        '同一段对话在「刚建好 / 切回来 / 重启后」必须长得一样 —— 否则学生会以为自己的对话丢了')
    } else {
      console.log('\u001b[2m  [SKIP] D5b 列表里没有「只发过开场白」的会话（先新建一条再跑）\u001b[0m')
    }
  }

  /* ── D13/D14. 删除一条对话的入口（2026-09-22）────────────────────
   * ★★ **刻意不真的删**：本脚本跑在开发机上，库里是真实会话（含学生数据）。
   *    这里只验「菜单打得开、关闭方式对、菜单里那一项在」——
   *    真正的删除由 `tests/session-delete.test.ts`（判据与顺序）与人工走查覆盖。
   * ------------------------------------------------------------------ */
  {
    // D13：右键弹菜单（学生最常见的入口是右键）
    const menu = await cdp.evaluate(`(() => {
      const row = document.querySelector('[data-testid^="session-row-"]')
      if (!row) return { present: false }
      const box = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(box.left + 20), clientY: Math.round(box.top + 20)
      }))
      return { present: true }
    })()`)
    await sleep(350)
    const menuUi = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="session-row-menu"]')
      if (!el) return { open: false }
      const item = el.querySelector('[data-testid="session-delete-action"]')
      const r = el.getBoundingClientRect()
      return {
        open: true,
        hasDelete: Boolean(item),
        label: (item?.innerText || '').trim(),
        // 菜单不能被窗口裁掉（贴边回吸）：右缘/下缘都要在视口内
        insideViewport: r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
        // 删除项必须是**警示色**（与确认框的 danger 同一套语义）
        dangerColor: item ? getComputedStyle(item).color : ''
      }
    })()`)
    check('D13', '在一条历史对话上右键，会弹出「删除这条对话」的菜单（要点两下才删得掉）',
      menu.present && menuUi.open && menuUi.hasDelete,
      menu.present
        ? (menuUi.open ? `菜单已打开，操作项：「${menuUi.label}」` : '右键后没有出现菜单')
        : '列表里没有可右键的行',
      '删除是本项目唯一会真的丢东西的操作，入口必须先能看见（再确认一次）——' +
        '菜单打不开 / 没有那一项，学生就只能靠猜')
    if (menuUi.open) {
      check('D14', '菜单不会被窗口裁掉，且删除项是警示色', menuUi.insideViewport && menuUi.dangerColor !== '',
        `在视口内=${menuUi.insideViewport}，颜色=${menuUi.dangerColor}`,
        '菜单被裁掉一半时，学生点不到它（列表贴着窗口左缘，这一条尤其容易发生）')
      // ★ 关掉菜单（Esc）—— 顺便验键盘出口在，别把菜单留在屏幕上影响后续断言
      const closed = await cdp.evaluate(`(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      })()`)
      await sleep(300)
      const stillOpen = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="session-row-menu"]'))`)
      check('D15', 'Esc 能关掉行菜单（键盘出口）', closed && !stillOpen,
        stillOpen ? '按 Esc 之后菜单还在' : 'Esc 已关闭',
        '浮层关不掉时，学生会以为界面卡住了（本项目实测过同类缺陷）')
    }
  }

  /* ── E. 页面切换的记忆 ───────────────────────────────────────── */
  console.log('\n\u001b[1mE. 页面切换后的连续性\u001b[0m')

  const pageNav = await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('aside button, nav button'))
    return btns.map((b) => (b.innerText || '').trim().split('\\n')[0]).filter(Boolean).slice(0, 10)
  })()`)
  console.log(`\u001b[2m  侧栏项目：${pageNav.join(' / ')}\u001b[0m`)

  // E1 切到设置再切回来，对话内容还在（KeepAlive 的意义）
  const turnsBeforeNav = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
  const navOk = await cdp.evaluate(`(() => {
    const click = (name) => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.innerText || '').includes(name))
      if (b) { b.click(); return true }
      return false
    }
    return click('设置')
  })()`)
  await sleep(700)
  await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.innerText || '').includes('问问智团团'))
    if (b) b.click()
    return true
  })()`)
  await sleep(700)
  const turnsAfterNav = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
  check('E1', '切到设置再回来，对话内容还在', navOk && turnsAfterNav === turnsBeforeNav,
    `${turnsBeforeNav} 轮 → ${turnsAfterNav} 轮`,
    '切走一趟回来发现对话没了，学生会以为「刚才那条没保存」')

  /* ── G. 忙时发送：必须看得见地排队 ────────────────────────────── */
  console.log('\n\u001b[1mG. 回答生成中又发一条（最常见的「手快」）\u001b[0m')

  {
    // 先发一条长的，进入流式
    await send(cdp, '请用三句话介绍什么是机器学习，并各举一个例子')
    let streaming = false
    for (let i = 0; i < 60; i += 1) {
      await sleep(400)
      const n = await cdp.evaluate(
        `document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length`
      )
      if (n > 0) {
        streaming = true
        break
      }
    }
    if (!streaming) {
      // ★★ SKIP 的理由要能定位原因（2026-09-23）：光是「没能进入流式状态」会把
      //    排查方向指向「流式实现坏了」，而实测最常见的两个原因是**探针/环境**问题：
      //    ① 模型没配好（主进程在「缺 Key」处早退，轮次照样出现、回答正文为空）；
      //    ② 这一轮直接以失败/撤回结束（`data-status` 不是 streaming）。
      //    所以这里把「有几轮、最后一轮什么状态、回答多长、模型配没配」一并印出来。
      const diag = await cdp.evaluate(`(() => {
        const turns = Array.from(document.querySelectorAll('[data-testid="chat-turn"]'))
        const last = turns[turns.length - 1]
        return {
          turns: turns.length,
          status: last ? last.getAttribute('data-status') : '(没有轮次)',
          answerLen: (last?.querySelector('[data-testid="assistant-text"]')?.innerText ?? '').trim().length,
          notice: (document.querySelector('[data-testid="local-notice"]')?.innerText ?? '').trim().slice(0, 60)
        }
      })()`)
      console.log(
        `\u001b[2m  [SKIP] G 没能进入流式状态（发送后等 24s：${diag.turns} 轮，最后一轮 status=${diag.status}，回答正文 ${diag.answerLen} 字${diag.notice ? `，提示「${diag.notice}」` : ''}）—— ${(await modelReadiness(cdp)).note}\u001b[0m`
      )
    } else {
      const before = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)
      await cdp.evaluate(setInput('那深度学习呢'))
      await sleep(200)
      await cdp.evaluate(`(${Q.input}).focus()`)
      await cdp.key('Enter')
      await sleep(800)

      const queued = await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-testid="chat-queued"]')
        const input = ${Q.input}
        return {
          visible: Boolean(el),
          text: el ? el.innerText : '',
          inputCleared: input.value === '',
          turns: document.querySelectorAll('[data-testid="chat-turn"]').length
        }
      })()`)

      check('G1', '忙时按发送会出现「待发送」条（不再是零反馈）', queued.visible,
        queued.visible ? `排队条文案 = ${JSON.stringify(queued.text.slice(0, 40))}` : '没有排队条',
        '学生按了回车却毫无反应，只会以为键盘坏了 / 软件卡了；有排队条他才知道「系统收下了」')

      check('G2', '排队后输入框清空（字已被接收，不是让他再按一次）', queued.inputCleared,
        `输入框为空 = ${queued.inputCleared}`,
        '字留在框里，学生会以为没发出去而反复按回车')

      // 等这一轮结束 → 排队的那条应当自动发出去
      let autoSent = false
      for (let i = 0; i < 150; i += 1) {
        await sleep(500)
        const s = await cdp.evaluate(`(() => ({
          streaming: document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length,
          turns: document.querySelectorAll('[data-testid="chat-turn"]').length,
          queued: Boolean(document.querySelector('[data-testid="chat-queued"]'))
        }))()`)
        if (s.turns > before && !s.queued) {
          autoSent = true
          break
        }
        if (s.streaming === 0 && s.turns > before) {
          autoSent = true
          break
        }
      }
      check('G3', '回答讲完，排队的那条自动发出去（学生不用再按一次）', autoSent,
        `轮次数 ${before} →（等待后）${await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)}`,
        '「举手排队」的完整含义就是轮到他就发；否则等于只是把「请稍等」换了个说法')

      // 收尾：等最后一轮结束，别把流式状态留给后续检查
      await waitTurn(cdp)
    }
  }

  /* ── H. 浮层不压住可交互元素（实测踩到过） ──────────────────── */
  console.log('\n\u001b[1mH. 浮动元素会不会挡住别的东西\u001b[0m')

  {
    // ★ 为什么必须专门测这个：`回到最新` 初版用 `bottom: 92px` 这种**魔数**定位，
    //   实测它的下边缘（810px）压住了输入条上边缘（793px）—— **重叠 17px**。
    //   数字检查（「按钮存在吗」「点得动吗」）全都通过，只有量几何关系才发现。
    //   学生体感：想点输入框却点到按钮，然后被滚到底部，一脸茫然。
    // ⚠️ 取不到 `chat-log` 时**不要**让求值抛异常（2026-09-23）：那会让整个脚本以
    //    「脚本自身出错：TypeError: Cannot read properties of null」收场 ——
    //    看起来像探针坏了，实际原因是界面被留在了非对话页（见 main() 开头的前置检查）。
    //    返回 false 后下面的 `geometry.present === false` 会走本段既有的 SKIP 分支，
    //    并由 `modelReadiness()` 说明「当前不在对话页」。
    const scrolled = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="chat-log"]')
      if (!el) return false
      el.scrollTop = Math.max(0, el.scrollTop - 600)
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
      return true
    })()`)
    if (!scrolled) console.log('\u001b[2m  [H 前置] 找不到 [data-testid=chat-log]（不在对话页？）\u001b[0m')
    await sleep(600)

    const geometry = await cdp.evaluate(`(() => {
      const btn = document.querySelector('[data-testid="chat-jump-latest"]')
      if (!btn) return { present: false }
      const b = btn.getBoundingClientRect()
      // 底部区里所有「可交互 + 可见」的元素：这些都不该被浮层压住
      const targets = Array.from(
        document.querySelectorAll(
          '[data-testid="composer-input"], [data-testid="composer-send"], .cp__model, [data-testid="chat-queued"]'
        )
      ).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-testid') || el.className,
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height)
        }
      }).filter((t) => t.h > 0)

      const overlaps = targets.filter(
        (t) => b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top
      )
      return {
        present: true,
        button: { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) },
        // ⚠️ 这里**不能**用模板字符串：整个求值表达式本身就在反引号里（会提前终止）
        overlaps: overlaps.map((t) => t.id + '(' + t.top + '-' + t.bottom + ')'),
        targets
      }
    })()`)

    if (!geometry.present) {
      // ★★ SKIP 的理由要能定位原因（2026-09-23）：这个按钮**只在学生自己往上翻时出现**，
      //    而「翻得动」的前提是消息区真的比视口高。所以把「几轮 / 内容多高 / 视口多高 /
      //    模型配没配」一并印出来：只写「内容不够长？」会让人以为要手动多聊几句，
      //    而模型没配好时内容**永远**长不起来（G 段那句也拿不到回答）。
      const scrollDiag = await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-testid="chat-log"]')
        return {
          turns: document.querySelectorAll('[data-testid="chat-turn"]').length,
          contentH: el ? Math.round(el.scrollHeight) : 0,
          viewH: el ? Math.round(el.clientHeight) : 0,
          top: el ? Math.round(el.scrollTop) : 0
        }
      })()`)
      console.log(
        `\u001b[2m  [SKIP] H 「回到最新」没出现（消息区 ${scrollDiag.turns} 轮 / 内容高 ${scrollDiag.contentH}px ≤ 可视高 ${scrollDiag.viewH}px，往上翻 600px 后 scrollTop=${scrollDiag.top}）—— 没有可滚的距离时学生根本翻不上去，这个按钮也就无从出现；${(await modelReadiness(cdp)).note}\u001b[0m`
      )
    } else {
      /**
       * ★★ H1/H2 的前置条件：**必须真的量到了被测对象**。
       *
       * 缺口（审计结论）：`targets` 是从一组**类名 / data-testid 选择器**收集来的，
       * 而 `targets = []` 时两条断言都退化成恒真 ——
       *   · H1：`[].length === 0` → 通过（「没有重叠」和「什么都没量到」长得一模一样）；
       *   · H2：`Math.min(...[])` = `Infinity`，`Infinity >= 4` → 通过。
       * 于是选择器一旦失效（`.cp__model` 改了名、输入条换成别的组件、
       * 元素因为某个条件没渲染），这两条会**静默通过**，而它们本来是
       * 「浮层压住输入框 17px」那次缺陷的唯一回归防线（P-082）。
       *
       * 所以先判「量到了几个」：找不到被测对象 = **失败**，不是「没问题」。
       * 要求 ≥2 是因为 H2 说的是「与**下方控件们**的间距」——只量到一个时，
       * 那句话其实没被验证过（输入框或发送键任一没量到，就已经漏了一半）。
       */
      const targetCount = (geometry.targets ?? []).length
      check('H0', '量得到底部可交互元素（选择器还有效 —— 否则 H1/H2 是空断言）', targetCount >= 2,
        `量到 ${targetCount} 个：${(geometry.targets ?? []).map((t) => t.id).join('、') || '（一个都没有）'}`,
        'H1 的「没有重叠」与 H2 的「最小间距 Infinity」在量到 0 个时都会恒真；' +
          '选择器失效等于这两条防线不存在，而浮层压住输入框正是实测踩到过的缺陷')

      check('H1', '「回到最新」不压住输入框 / 发送键 / 待发送条',
        targetCount >= 2 && geometry.overlaps.length === 0,
        geometry.overlaps.length
          ? `与这些元素重叠：${geometry.overlaps.join('、')}（按钮 ${geometry.button.top}–${geometry.button.bottom}）`
          : `按钮 ${geometry.button.top}–${geometry.button.bottom}，${targetCount} 个底部元素均在下方`,
        '浮层压住输入框时，学生想点输入框会点到按钮，然后被滚到底部 —— 他不知道发生了什么')

      // ★ 补一条「有呼吸感」的检查：仅仅「不重叠」还不够 ——
      //   贴着边（间距 0~2px）在视觉上就是「粘在一起」，而且 DPI 取整后随时可能变成重叠。
      //   ⚠️ 不用 `Math.min(...[])`：空数组会给出 `Infinity`（恒真），改用显式判空。
      const gap = targetCount > 0
        ? Math.min(...geometry.targets.map((t) => t.top - geometry.button.bottom))
        : Number.NaN
      check('H2', '浮标与下方控件留有余量（≥4px，不贴边）', Number.isFinite(gap) && gap >= 4,
        Number.isFinite(gap) ? `最小间距 ${gap}px` : `量不到下方控件（${targetCount} 个）—— 无法判定`,
        '贴边在视觉上像「粘住了」，而且 DPI 取整一旦变化就会变成重叠（实测踩到过 17px 重叠）')
    }
  }

  /* ── F. 运行期健康 ───────────────────────────────────────────── */
  console.log('\n\u001b[1mF. 运行期健康\u001b[0m')

  const horizontallyFine = await cdp.evaluate(`(() => {
    const de = document.documentElement
    const offenders = Array.from(document.querySelectorAll('*'))
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
      .slice(0, 4)
      .map((el) => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''))
    return { overflow: de.scrollWidth > de.clientWidth + 1, offenders }
  })()`)
  check('F1', '页面没有横向滚动', !horizontallyFine.overflow,
    horizontallyFine.offenders.length ? `溢出元素：${horizontallyFine.offenders.join(', ')}` : '无溢出元素',
    '横向滚动条是「网页错版」最直观的信号，也会让内容被裁掉')

  // ★ 监听器在 main() 开头就装好了（见那里的注释）—— 这里只取累计结果，
  //   所以它覆盖的是 A 到 H 的**全程**，而不只是 F 段自己跑的那几行。
  const errors = await cdp.evaluate(`(() => {
    // 兜底：万一监听器没装上（例如中途重新导航过页面），这里至少别静默通过
    if (!window.__k12Ux) return null
    return window.__k12Ux.slice(0, 5)
  })()`)
  check('F2', '整个流程没有未捕获的异常', Array.isArray(errors) && errors.length === 0,
    errors === null ? '★ 监听器没装上（页面可能被重新导航过）—— 本次结果不可信'
      : errors.length ? errors.join(' | ') : '0 条',
    '异常被吞掉时，学生看到的是「点一下没反应」，而日志里什么都没有')

  const unresolvedText = await cdp.evaluate(`(() => {
    const text = document.body.innerText
    return {
      hasUndefined: /\\bundefined\\b/.test(text),
      hasNull: />\\s*null\\s*</.test(document.body.innerHTML),
      hasObjectObject: text.includes('[object Object]'),
      hasNaN: /\\bNaN\\b/.test(text)
    }
  })()`)
  const leaks = Object.entries(unresolvedText).filter(([, v]) => v).map(([k]) => k)
  check('F3', '界面上没有裸露的 undefined / null / NaN / [object Object]', leaks.length === 0,
    leaks.length ? `出现了：${leaks.join(', ')}` : '干净',
    '这类字样一旦出现在正文或卡片里，学生会以为「这个软件坏了」')

  /* ── 收尾 ───────────────────────────────────────────────────── */
  cdp.close()

  console.log(`\n${'═'.repeat(66)}`)
  if (findings.length === 0) {
    console.log(`\u001b[32m✓ UX 体检全部通过（${passed} 项）\u001b[0m`)
    return 0
  }
  console.log(`\u001b[31m✗ 发现 ${findings.length} 处不符合人类使用习惯的问题\u001b[0m（通过 ${passed} 项）\n`)
  for (const f of findings) {
    console.log(`${f.id} ${f.what}`)
    if (f.detail) console.log(`   实测：${f.detail}`)
    if (f.why) console.log(`   为什么要紧：${f.why}`)
    console.log('')
  }
  return 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\u001b[31m脚本自身出错：\u001b[0m${error.message}`)
    process.exit(2)
  }
)
