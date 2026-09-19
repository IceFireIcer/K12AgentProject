/**
 * 探针：「回到最新」按钮与「跟随/停住」这套行为的端到端验证。
 *
 * 三条契约：
 *   ① 学生**在底部**时：新内容自动跟随（按钮不出现 —— 没有需要「回到」的东西）；
 *   ② 学生**往上翻**后：视图停住不动（不打扰阅读），并露出「回到最新」；
 *   ③ 点「回到最新」：回到最新一条，按钮消失，跟随恢复。
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

const STATE = `(() => {
  const el = document.querySelector('[data-testid="chat-log"]')
  return el ? {
    dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    scrollable: el.scrollHeight > el.clientHeight + 100,
    jumpVisible: Boolean(document.querySelector('[data-testid="chat-jump-latest"]'))
  } : null
})()`

let pass = 0
let fail = 0
function check(id, what, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`\u001b[32m✓\u001b[0m ${id} ${what}  \u001b[2m(${detail})\u001b[0m`)
  } else {
    fail += 1
    console.log(`\u001b[31m✗\u001b[0m ${id} ${what}\n    实测：${detail}`)
  }
}

async function main() {
  const cdp = await Cdp.attach()

  let s = await cdp.evaluate(STATE)
  if (!s?.scrollable) {
    console.log('内容不够长，先聊两句垫一下…')
    for (const q of ['什么是数据', '为什么要训练']) {
      await cdp.evaluate(`(() => {
        const i = document.querySelector('[data-testid="composer-input"]')
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        set.call(i, ${JSON.stringify(q)})
        i.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(150)
      await cdp.evaluate(`document.querySelector('[data-testid="composer-send"]').click()`)
      for (let i = 0; i < 100; i += 1) {
        await sleep(500)
        const st = await cdp.evaluate(
          `document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length`
        )
        if (st === 0) break
      }
    }
    s = await cdp.evaluate(STATE)
  }
  if (!s?.scrollable) {
    console.log('内容仍不够长（回答太短），跳过')
    cdp.close()
    return
  }

  console.log('\n\u001b[1m① 在底部时：不该出现「回到最新」\u001b[0m')
  await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="chat-log"]')
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
    return true
  })()`)
  await sleep(500)
  s = await cdp.evaluate(STATE)
  check('①', '贴着底时「回到最新」不出现', !s.jumpVisible, `dist=${s.dist}px, 按钮可见=${s.jumpVisible}`)

  console.log('\n\u001b[1m② 往上翻后：停住不动 + 露出「回到最新」\u001b[0m')
  await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="chat-log"]')
    el.scrollTop = Math.max(0, el.scrollTop - 500)
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
    return true
  })()`)
  await sleep(900)
  const up = await cdp.evaluate(STATE)
  check('②a', '学生往上翻后视图停住', up.dist > 100, `离底部 ${up.dist}px（应 >100）`)
  check('②b', '露出「回到最新」按钮', up.jumpVisible, `按钮可见=${up.jumpVisible}`)

  console.log('\n\u001b[1m③ 点「回到最新」→ 回到底部、按钮消失\u001b[0m')
  await cdp.evaluate(`document.querySelector('[data-testid="chat-jump-latest"]')?.click()`)
  await sleep(900)
  const back = await cdp.evaluate(STATE)
  check('③a', '点一下回到底部', back.dist <= 8, `离底部 ${back.dist}px`)
  check('③b', '回到底部后按钮消失', !back.jumpVisible, `按钮可见=${back.jumpVisible}`)

  console.log('\n\u001b[1m④ 发新消息时必须跟随（学生就是在等这条）\u001b[0m')
  // 先翻上去，制造 stick=false
  await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="chat-log"]')
    el.scrollTop = Math.max(0, el.scrollTop - 500)
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
    return true
  })()`)
  await sleep(400)
  await cdp.evaluate(`(() => {
    const i = document.querySelector('[data-testid="composer-input"]')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(i, '那测试集又是做什么的')
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await cdp.evaluate(`document.querySelector('[data-testid="composer-send"]').click()`)
  await sleep(1500)
  const sending = await cdp.evaluate(STATE)
  check('④', '发送后视图跟随新回答（哪怕之前翻上去过）', sending.dist <= 24,
    `发送后离底部 ${sending.dist}px`)

  for (let i = 0; i < 100; i += 1) {
    await sleep(500)
    const st = await cdp.evaluate(
      `document.querySelectorAll('[data-testid="chat-turn"][data-status="streaming"]').length`
    )
    if (st === 0) break
  }
  await sleep(800)
  const end = await cdp.evaluate(STATE)
  check('④b', '回答结束后停在最新一条', end.dist <= 8, `离底部 ${end.dist}px`)

  cdp.close()
  console.log(`\n${'═'.repeat(60)}`)
  console.log(fail === 0 ? `\u001b[32m✓ 滚动行为全部符合预期（${pass} 项）\u001b[0m` : `\u001b[31m✗ ${fail} 项不符合预期\u001b[0m`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('探针出错：', e.message)
  process.exit(2)
})
