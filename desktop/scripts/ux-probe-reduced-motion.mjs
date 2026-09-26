/**
 * 探针：减少动效「三档开关」的真机验证（优化报告 §3.3 的第二、三件）。
 *
 * 要证的四件事（每一条都对应一种「看着像做了、其实没生效」的失败）：
 *   ① 自动：系统偏好 reduce 时有减动效（媒体块带 `:not(off)` 后仍要成立）；
 *   ② 关闭：系统偏好 reduce 时**仍然给完整动效**（第三档不是假选项）；
 *   ③ 开启：系统偏好 no-preference 时也能强制减动效（属性块在起作用）；
 *   ④ 实时生效：在设置页点一下，`<html>` 属性当场变、动画时长当场变（不重启、不刷新）。
 *
 * 做法：
 *   · 用 CDP 的 `Emulation.setEmulatedMedia` 精确控制「系统偏好」（不依赖本机设置）；
 *   · 在页面上挂一个「探针元素」（2s 无限动画），读它的 `animation-duration` ——
 *     `0.01ms` 代表减动效生效、`2s` 代表完整动效。这比「数页面上有几个动画」可靠：
 *     页面上本来可能一个动画都没有，那种「全过」是空转。
 *
 * 前置：应用带 `K12_DEBUG_PORT` 启动（见 AGENTS.md 的 UX / 跨层探针一节）。
 * 跑法：`npm run ux:motion`
 * 退出码：0 = 全过；1 = 有断言不达标；2 = 脚本自身出错（连不上 / 找不到页面）。
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'
const MODE_KEY = 'k12.reducedMotion'
const MODE_ATTR = 'data-k12-reduced-motion'

import { CLEANUP_SCRIPT, captureFailureScreenshot } from './probe-lib.mjs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

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

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((res, rej) => {
      this.#pending.set(id, { resolve: res, reject: rej })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result?.value
  }

  /** 让窗口真的在渲染（隐藏窗口下渲染生命周期会停）。 */
  async ensureRendering() {
    for (const [m, p] of [
      ['Page.bringToFront', {}],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Page.setWebLifecycleState', { state: 'active' }]
    ]) {
      try {
        await this.send(m, p)
      } catch {
        /* 旧 CDP 上某个方法可能不存在：继续试下一个 */
      }
    }
    return this.evaluate('document.visibilityState')
  }

  /** 模拟「系统偏好」（不依赖本机设置）。value 传 'no-preference' 表示清掉。 */
  async emulateSystemMotion(value) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value }]
    })
  }

  close() {
    this.#ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读：模式属性 + 探针元素的动画时长（探针元素由下面的 ENSURE_PROBE 注入）。 */
const READ = `(() => {
  const el = document.querySelector('[data-motion-probe]')
  return {
    attr: document.documentElement.getAttribute(${JSON.stringify(MODE_ATTR)}),
    stored: (() => { try { return localStorage.getItem(${JSON.stringify(MODE_KEY)}) } catch (e) { return null } })(),
    duration: el ? getComputedStyle(el).animationDuration : null,
    reduceMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
})()`

/** 注入探针元素：一个 2 秒的无限动画（时长会被减动效规则改写）。 */
const ENSURE_PROBE = `(() => {
  if (!document.getElementById('k12-motion-probe-style')) {
    const style = document.createElement('style')
    style.id = 'k12-motion-probe-style'
    style.textContent =
      '@keyframes k12MotionProbe { from { opacity: 1 } to { opacity: .2 } } ' +
      '[data-motion-probe] { animation: k12MotionProbe 2s linear infinite; }'
    document.head.appendChild(style)
  }
  if (!document.querySelector('[data-motion-probe]')) {
    const el = document.createElement('div')
    el.setAttribute('data-motion-probe', '')
    el.setAttribute('aria-hidden', 'true')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    el.style.width = '1px'
    el.style.height = '1px'
    document.body.appendChild(el)
  }
  return true
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

/** 「减动效生效」的判据：探针动画的时长被压到 ≤1ms。 */
function isReducedDuration(value) {
  if (typeof value !== 'string') return false
  const ms = value.trim().endsWith('ms')
    ? Number.parseFloat(value)
    : Number.parseFloat(value) * 1000
  return Number.isFinite(ms) && ms <= 1
}

async function waitReady(cdp) {
  for (let i = 0; i < 40; i += 1) {
    const ok = await cdp.evaluate(`Boolean(document.querySelector('#app'))`)
    if (ok) return true
    await sleep(250)
  }
  return false
}

async function setMode(cdp, mode) {
  await cdp.evaluate(`(() => {
    try { localStorage.setItem(${JSON.stringify(MODE_KEY)}, ${JSON.stringify(mode)}) } catch (e) {}
    return true
  })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1200)
  await waitReady(cdp)
  await cdp.evaluate(ENSURE_PROBE)
}

async function main() {
  const cdp = await Cdp.attach()
  const visibility = await cdp.ensureRendering()
  if (visibility !== 'visible') {
    console.log(`⚠️ 窗口仍是 ${visibility}：渲染相关的断言可能失真（把应用窗口点到前台再跑）`)
  }
  await waitReady(cdp)

  // ★ 探针隔离（报告 §5.3）：把跑之前的值记下来，收尾时**原样还回去** ——
  //   否则体检会把学生自己的偏好改成探针最后写的那一档。
  const priorMode = await cdp.evaluate(
    `(() => { try { return localStorage.getItem(${JSON.stringify(MODE_KEY)}) } catch (e) { return null } })()`
  )

  console.log('\n\u001b[1m① 自动：系统偏好 reduce → 减动效\u001b[0m')
  await cdp.emulateSystemMotion('reduce')
  await setMode(cdp, 'auto')
  let s = await cdp.evaluate(READ)
  check('①a', 'html 属性 = auto（媒体查询接管）', s.attr === 'auto', `attr=${s.attr}, 系统偏好=${s.reduceMatches}`)
  check('①b', '探针动画被压到 ≤1ms', isReducedDuration(s.duration), `animation-duration=${s.duration}`)

  console.log('\n\u001b[1m② 关闭：系统偏好仍然 reduce，但给完整动效\u001b[0m')
  await setMode(cdp, 'off')
  s = await cdp.evaluate(READ)
  check('②a', 'html 属性 = off', s.attr === 'off', `attr=${s.attr}, 系统偏好=${s.reduceMatches}`)
  check(
    '②b',
    '★ 探针动画保持 2s（系统偏好被「关闭」档覆盖）',
    s.duration === '2s',
    `animation-duration=${s.duration}（应为 2s）`
  )

  console.log('\n\u001b[1m③ 开启：系统偏好 no-preference，也要减动效\u001b[0m')
  await cdp.emulateSystemMotion('no-preference')
  await setMode(cdp, 'on')
  s = await cdp.evaluate(READ)
  check('③a', 'html 属性 = on', s.attr === 'on', `attr=${s.attr}, 系统偏好=${s.reduceMatches}`)
  check(
    '③b',
    '★ 探针动画被属性块压到 ≤1ms',
    isReducedDuration(s.duration),
    `animation-duration=${s.duration}（应为 0.01ms）`
  )

  console.log('\n\u001b[1m④ 实时生效：设置页点一下，当场变（不重启、不刷新）\u001b[0m')
  await cdp.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('aside button, nav button'))
      .find((b) => (b.innerText || '').trim().startsWith('设置'))
    if (btn) { btn.click(); return true }
    return false
  })()`)
  await sleep(900)
  const block = await cdp.evaluate(
    `Boolean(document.querySelector('[data-testid="settings-motion-block"]'))`
  )
  if (!block) {
    check('④a', '设置页有「减少动效」三档', false, '找不到 [data-testid="settings-motion-block"]')
  } else {
    const clicked = await cdp.evaluate(`(() => {
      const opts = Array.from(document.querySelectorAll('[data-testid^="settings-motion-"]'))
        .filter((el) => el.getAttribute('role') === 'radio')
      const target = opts.find((el) => (el.innerText || '').trim().startsWith('开启'))
      if (!target) return { ok: false, count: opts.length }
      target.click()
      return { ok: true, count: opts.length }
    })()`)
    check(
      '④a',
      '设置页有「减少动效」三档（自动 / 开启 / 关闭）',
      clicked.ok && clicked.count === 3,
      `找到 ${clicked.count} 档`
    )
    await sleep(400)
    const afterOn = await cdp.evaluate(READ)
    check(
      '④b',
      '★ 点「开启」后当场生效（属性 + 时长都变）',
      afterOn.attr === 'on' && isReducedDuration(afterOn.duration) && afterOn.stored === 'on',
      `attr=${afterOn.attr}, 动画=${afterOn.duration}, localStorage=${afterOn.stored}`
    )
    await cdp.evaluate(`(() => {
      const target = Array.from(document.querySelectorAll('[data-testid^="settings-motion-"]'))
        .find((el) => (el.innerText || '').trim().startsWith('关闭'))
      if (target) target.click()
      return true
    })()`)
    await sleep(400)
    const afterOff = await cdp.evaluate(READ)
    check(
      '④c',
      '★ 点「关闭」后当场恢复完整动效',
      afterOff.attr === 'off' && afterOff.duration === '2s',
      `attr=${afterOff.attr}, 动画=${afterOff.duration}`
    )
  }

  // 收尾：把偏好与模拟媒体都还原（别把体检档留在设置档上）。
  // ★ 隔离两步走：① 去掉探针注入的元素 / 临时键；② 把跑之前的偏好写回去。
  await cdp.evaluate(CLEANUP_SCRIPT([]))
  if (priorMode === null) {
    await cdp.evaluate(
      `(() => { try { localStorage.removeItem(${JSON.stringify(MODE_KEY)}) } catch (e) {} return true })()`
    )
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(1200)
  } else {
    await cdp.evaluate(
      `(() => { try { localStorage.setItem(${JSON.stringify(MODE_KEY)}, ${JSON.stringify(priorMode)}) } catch (e) {} return true })()`
    )
  }
  await cdp.emulateSystemMotion('no-preference')

  // ★ 失败自动截图（报告 §5.3）：红了留现场
  if (fail > 0) {
    const file = await captureFailureScreenshot(
      cdp,
      `ux-motion-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      resolve(HERE, '..', '.probe-artifacts')
    )
    console.log(file ? `失败现场截图：${file}` : '（失败截图没拍成）')
  }

  cdp.close()
  console.log(`\n${'═'.repeat(60)}`)
  console.log(
    fail === 0
      ? `\u001b[32m✓ 减少动效三档全部符合预期（${pass} 项）\u001b[0m`
      : `\u001b[31m✗ ${fail} 项不符合预期\u001b[0m`
  )
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('探针出错：', e.message)
  process.exit(2)
})
