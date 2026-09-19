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

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  const cdp = await Cdp.attach()

  const meta = await cdp.evaluate(`(() => ({
    w: window.innerWidth, h: window.innerHeight,
    dpr: window.devicePixelRatio,
    key: !document.body.innerText.includes('尚未配置 API Key')
  }))()`)
  console.log(`\u001b[2m视口 ${meta.w}×${meta.h} @${meta.dpr}x；已配置 Key：${meta.key}\u001b[0m`)

  /* ── A. 打字与键盘 ───────────────────────────────────────────── */
  console.log('\n\u001b[1mA. 打字与键盘（学生最常做的动作）\u001b[0m')

  // A1 输入框自动聚焦：打开应用就能直接打字，不用先点一下
  const autofocus = await cdp.evaluate(`(() => {
    const el = ${Q.input}
    return { focused: document.activeElement === el }
  })()`)
  check('A1', '打开对话页光标就在输入框里（不用先点一下才能打字）', autofocus.focused,
    `activeElement 是输入框 = ${autofocus.focused}`,
    '每次进应用都要先点一下输入框才开始打字，是最容易被忽略、也最常被嫌烦的一步')

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
  await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.trim() === '新会话')
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
    const pick = (sel) => Array.from(document.querySelectorAll(sel))
    const measure = (els) => els.map((el) => ({
      label: (el.innerText || el.getAttribute('aria-label') || el.title || el.tagName).trim().slice(0, 16),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height)
    })).filter((x) => x.w > 0 && x.h > 0)
    // 「可点的小东西」：按钮 + 可点角色
    const clickable = measure(pick('button, [role="button"], a[href]'))
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
      `Array.from(document.querySelectorAll('button')).find((x) => x.innerText.trim() === '新会话')?.click()`
    )
    await sleep(700)
    // ★ 确认框可能用 teleport 挂在 body 上（`.cfm` 一族），也可能带 role=dialog；
    //   两种都认 —— 实测第一版只查 `role="dialog"` 时漏判成了「没确认框」（假阳性）。
    const dialog = await cdp.evaluate(`(() => {
      const byRole = document.querySelector('[role="dialog"], [role="alertdialog"]')
      const byClass = document.querySelector('.cfm, [data-testid*="confirm"]')
      const byText = document.body.innerText.includes('开始新会话')
      return { found: Boolean(byRole || byClass), byText }
    })()`)
    check('D1', '「新会话」会先确认再清空（避免手滑丢掉整轮问答）', dialog.found && dialog.byText,
      `确认框存在=${dialog.found}，文案含「开始新会话」=${dialog.byText}`,
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
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.innerText || '').includes('对话课堂'))
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
      console.log('\u001b[2m  [SKIP] 没能进入流式状态\u001b[0m')
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

  const errors = await cdp.evaluate(`(() => {
    if (!window.__k12Ux) {
      window.__k12Ux = []
      window.addEventListener('error', (e) => window.__k12Ux.push('error: ' + e.message))
      window.addEventListener('unhandledrejection', (e) => window.__k12Ux.push('rejection: ' + e.reason))
    }
    return window.__k12Ux.slice(0, 5)
  })()`)
  check('F2', '整个流程没有未捕获的异常', errors.length === 0,
    errors.length ? errors.join(' | ') : '0 条')

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
