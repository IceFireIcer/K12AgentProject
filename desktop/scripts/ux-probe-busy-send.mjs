/**
 * 探针：回答正在流式输出时，学生**又打了一句并按下 Enter** —— 会发生什么？
 *
 * 这是聊天类界面最常见的「手快」场景：学生一边读回答一边把追问打好了，
 * 读到一半发现答案不对，回车就想再问一句。若此时什么都没发生，
 * 他会以为键盘坏了 / 软件卡了（而不是「系统正在回答」）。
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
   * ★★ 让窗口**真的在渲染**（2026-09-22 补，见 P-120）。
   *
   * hidden 状态下 Chromium 停掉渲染生命周期（`ResizeObserver` 一次都不回调），
   * 而本脚本量的正是「内容长高 → 到底了吗」—— 少了这一步，B 段那几个断言
   * **全部假红**（实测：窗口在后台时报「离底部 742px」，而代码是对的）。
   * ⚠️ `Emulation.setPageVisibility` 在 Electron 44 上**不存在**（-32601），
   *    必须用 `Page.setWebLifecycleState`（实测调用后 `document.visibilityState` 立刻变 visible）。
   */
  async ensureRendering() {
    for (const [m, p] of [
      ['Page.bringToFront', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.setWebLifecycleState', { state: 'active' }]
    ]) {
      try {
        await this.send(m, p)
      } catch {
        // 旧 CDP 上某个方法可能不存在：继续试下一个
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
  async key(key) {
    const dispatch = (type) =>
      new Promise((res) => {
        const id = ++this.#id
        this.#pending.set(id, { resolve: res, reject: () => {} })
        this.#ws.send(
          JSON.stringify({
            id,
            method: 'Input.dispatchKeyEvent',
            params: { type, key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0 }
          })
        )
      })
    await dispatch('keyDown')
    await dispatch('keyUp')
  }
  close() {
    this.#ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const cdp = await Cdp.attach()
  // ★★ 先让窗口真的在渲染（见 ensureRendering 的说明）—— 否则下面每一条都是假红
  const visibility = await cdp.ensureRendering()
  if (visibility !== 'visible') {
    console.log(`[33m⚠️ 窗口仍是 ${visibility}：滚动跟随的断言会失真（把应用窗口点到前台再跑）[0m`)
  }

  // 发一条会产生较长回答的问题
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '请用三句话介绍什么是机器学习，并各举一个例子')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    return true
  })()`)
  await sleep(150)
  await cdp.evaluate(`document.querySelector('[data-testid="composer-send"]').click()`)

  // 等流式真的开始
  let streaming = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(400)
    const s = await cdp.evaluate(
      `document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length`
    )
    if (s > 0) {
      streaming = true
      break
    }
  }
  if (!streaming) {
    console.log('没能进入流式状态（跳过）')
    cdp.close()
    return
  }
  console.log('✓ 已进入流式输出状态，现在模拟「学生边读边打好追问并按 Enter」\n')

  const turnsBefore = await cdp.evaluate(`document.querySelectorAll('[data-testid="chat-turn"]').length`)

  // 打字（真实输入路径）
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]')
    input.focus()
    document.execCommand('insertText', false, '那深度学习呢')
    return input.value
  })()`)
  await sleep(300)

  const beforeEnter = await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]')
    const send = document.querySelector('[data-testid="composer-send"]')
    return {
      value: input.value,
      sendDisabled: send ? send.disabled : null,
      sendTitle: send ? send.title : '',
      anyHint: document.body.innerText.includes('正在回答'),
      hintTexts: Array.from(document.querySelectorAll('[data-testid="composer-input"] ~ *'))
        .map((el) => el.innerText).filter(Boolean).slice(0, 3)
    }
  })()`)
  console.log('按 Enter 前：')
  console.log(`  输入框内容 = ${JSON.stringify(beforeEnter.value)}`)
  console.log(`  发送键禁用 = ${beforeEnter.sendDisabled}（title=${JSON.stringify(beforeEnter.sendTitle)}）`)
  console.log(`  界面某处写着「正在回答」= ${beforeEnter.anyHint}`)

  // 按 Enter
  await cdp.key('Enter')
  await sleep(900)

  const afterEnter = await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]')
    return {
      value: input.value,
      turns: document.querySelectorAll('[data-testid="chat-turn"]').length,
      queued: document.body.innerText.includes('待发送') || document.body.innerText.includes('排队'),
      toast: Boolean(document.querySelector('[class*="toast"], [class*="tip"], [role="status"]'))
    }
  })()`)

  console.log('\n按 Enter 之后（仍在流式中）：')
  console.log(`  输入框内容 = ${JSON.stringify(afterEnter.value)}`)
  console.log(`  轮次数 ${turnsBefore} → ${afterEnter.turns}`)
  console.log(`  有「待发送/排队」提示 = ${afterEnter.queued}`)
  console.log(`  出现任何提示条 = ${afterEnter.toast}`)

  const silent = afterEnter.turns === turnsBefore && !afterEnter.queued && !afterEnter.toast
  if (silent) {
    console.log(
      '\n\u001b[31m★ 缺陷：按 Enter 完全没有任何反馈\u001b[0m —— 消息没发出去、也没告诉学生为什么'
    )
    console.log('   学生体感：键盘失灵 / 软件卡住（而不是「上一个回答还在生成」）')
    console.log(`   唯一的线索是发送键被禁用 + title 提示，而 title 要**悬停**才看得到`)
  } else {
    console.log('\n\u001b[32m✓ 至少给出了反馈\u001b[0m')
  }

  // 等这一轮结束
  for (let i = 0; i < 90; i += 1) {
    await sleep(500)
    const s = await cdp.evaluate(
      `document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length`
    )
    if (s === 0) break
  }
  const final = await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]')
    return { value: input.value, turns: document.querySelectorAll('[data-testid="chat-turn"]').length }
  })()`)
  console.log(`\n一轮结束后：输入框 = ${JSON.stringify(final.value)}；轮次 = ${final.turns}`)
  console.log('（若输入框内容还在，说明学生打的那句话既没发出去、也没被清掉 —— 只能自己再按一次）')

  cdp.close()
}

main().catch((e) => {
  console.error('探针出错：', e.message)
  process.exit(2)
})
