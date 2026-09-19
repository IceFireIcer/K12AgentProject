/**
 * CDP 工具：重载渲染进程页面（HMR 改过 `onMounted` 一类生命周期代码后，
 * 旧实例不会重新执行 onMounted —— 此时量出来的现象是「改动完全没生效」，
 * 会把人带到错误的方向）。跑探针前先重载一次，保证量的是**当前代码**。
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'

const list = await (await fetch(`${BASE}/json/list`)).json()
const page = list.find((i) => i.type === 'page')
if (!page) {
  console.error('找不到 page 目标')
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('连接失败')), { once: true })
})

const send = (id, method, params) =>
  new Promise((res) => {
    const onMsg = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      res(m)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send(1, 'Page.enable', {})
await send(2, 'Page.reload', { ignoreCache: true })
console.log('已请求页面重载（等 6 秒让 sidecar 与首屏取数就绪）…')
await new Promise((r) => setTimeout(r, 6000))

// 确认重载后是新代码：查一个只可能来自新实现的标记
const probe = await send(3, 'Runtime.evaluate', {
  expression: `(() => ({
    url: location.href,
    hasLog: Boolean(document.querySelector('[data-testid="chat-log"]')),
    hasJump: Boolean(document.querySelector('[data-testid="chat-jump-latest"]')),
    turns: document.querySelectorAll('[data-testid="chat-turn"]').length
  }))()`,
  returnByValue: true
})
console.log('重载后状态 =', JSON.stringify(probe.result?.result?.value))
ws.close()
