#!/usr/bin/env node
/**
 * 学生视角技术词扫描（**真机 + 真相 DOM**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它补的是哪些洞（为什么不能只靠 `ux-pages-audit.mjs` 与源码级守卫）
 * ══════════════════════════════════════════════════════════════════════════
 * 这一轮的走查结论是「界面把开发者的调试视角当成了产品前端」，而它最集中的地方
 * **不在八个一级页面的首屏**里，而在：
 *   · 对话页右栏的三个页签（检索降级链 / 工具调用轨迹 / 学段判定信号）；
 *   · 三个浮层（学段 / 章节 / 模型选择器）；
 *   · 确认弹窗；
 *   · **聊天正文里由模板字符串拼出来的句子**。
 * 前两类是「要点开才出现」的，第三类是「要进入某个状态才出现」的 ——
 * `ux-pages-audit.mjs` 逐页扫首屏，这两类它一个都扫不到；
 * 源码级守卫（`tests/student-view-discipline.test.ts`）扫得到字符串，
 * 但拼装出来的句子（`${label}` 插值）在源码里看不到全貌。
 * 所以这一份专门扫**这些位置的真实 DOM**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 反向对照（本脚本最重要的一半）
 * ══════════════════════════════════════════════════════════════════════════
 * 切到教师视角后，**同一批探针必须能扫到东西**（`[data-teacher]` 节点与非空的
 * 证据文本）。只做「学生视角干净」那一半的话，**把技术信息全删掉**也能过 ——
 * 而那些正是答辩「设计合理性」25% 的证据。两边一起量，才是「分视角」。
 *
 * 用法（先起带调试端口的应用）：
 *   cd desktop
 *   K12_DEBUG_PORT=9222 npm run dev     # 另一个终端
 *   npm run ux:student
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9222'
const DESKTOP = resolve(HERE, '..')

/** 与学生视角**不能出现**的技术词同口径（与两个源码/真机扫描保持一致）。 */
const LEAK_PATTERNS = [
  [/\bSQL\b|SQLite|kb\.sqlite|learning\.db/, '数据库术语'],
  [/\bWHERE\b|regex|FTS5|\bnonce\b|allow-scripts|sandboxed/, '安全/检索实现细节'],
  [/\bkp_id\b/, '内部字段名'],
  [/\bPyodide\b|POST \/api|GET \/api|HTTP \d{3}/, '接口/运行时细节'],
  [/[a-z][a-z0-9]*(?:-[a-z0-9]+)+-(?:pl|ph|jr|sr)\b/, '知识点 slug'],
  [/检索降级链|降级链|兜底|向量检索|云端 Embedding/, '检索实现黑话'],
  [/已嵌入|向量维度|分块/, '向量库术语'],
  [/端口号|进程号|端口 \d|进程 \d/, '运维数字'],
  [/\bundefined\b|\[object Object\]|\bNaN\b/, '未处理的值'],
  [/TypeError|ReferenceError|Cannot read prop/, '异常堆栈']
]

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
  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve_, reject) => {
      this.#pending.set(id, { resolve: resolve_, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '页面求值失败')
    }
    return result.result?.value
  }
  close() {
    this.#ws.close()
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 把应用的视角恢复成**学生**（默认状态）并重载。
 *
 * ★ 成功路径与出错路径**都**要调它 —— 见文件末尾 `main().then(...)` 里的说明：
 *   本脚本会把 `localStorage.k12.viewMode` 改成 `teacher`，漏恢复就等于
 *   把这个应用留在「学生一打开就看到运维术语」的状态里。
 * ⚠️ 用当前连接的 `cdp`；拿不到连接时（比如已经断开）**吞掉异常**——
 *   恢复失败不该再抛一个错盖住真正的原因，但会在控制台留一行。
 */
let cdpForRestore = null
async function restoreStudentView() {
  if (!cdpForRestore) return
  await cdpForRestore.evaluate(`localStorage.setItem('k12.viewMode', 'student')`)
  await cdpForRestore.send('Page.reload')
  await wait(3000)
}

const results = []
function check(where, label, ok, detail = '') {
  results.push({ where, label, ok, detail })
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'
  console.log(`  ${mark} ${label}${detail ? `  \u001b[2m(${detail})\u001b[0m` : ''}`)
}

/** 对一段文本跑词表，返回命中的类别。 */
function leaksIn(text) {
  return LEAK_PATTERNS.filter(([re]) => re.test(text)).map(([, name]) => name)
}

/** 读某个容器（或整页）的可见文本 + 教师视角证据节点数。 */
const READ_STATE = (selector) => `(() => {
  const root = ${selector === null ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`}
  if (!root) return null
  const text = (root.innerText || '').replace(/\\s+/g, ' ').trim()
  return {
    text: text.slice(0, 4000),
    len: text.length,
    teacherNodes: root.querySelectorAll('[data-teacher]').length
  }
})()`

async function main() {
  const cdp = await Cdp.attach()
  cdpForRestore = cdp // 出错时也要用它把视角恢复成学生（见文件末尾）
  console.log('\u001b[1m【学生视角】技术与运维信息扫描\u001b[0m')

  // ── 回到对话页（默认起点），并确保右栏是打开状态 ──────────────────────
  await cdp.evaluate(`(() => {
    const entry = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '对话课堂')
    if (entry) entry.click()
    return true
  })()`)
  await wait(600)

  // 右栏：默认在 ≥1280px 是常驻栏；保险起见显式打开一次
  await cdp.evaluate(`(() => {
    const rail = document.querySelector('[data-testid="context-rail"]')
    if (rail && rail.classList.contains('rail--closed')) {
      const toggle = Array.from(document.querySelectorAll('button')).find((b) => /学习上下文|收起/.test(b.title || ''))
      if (toggle) toggle.click()
    }
    return true
  })()`)
  await wait(500)

  // ① 右栏三个页签
  const tabs = [
    ['context', '右栏 · 参考资料'],
    ['tools', '右栏 · 本轮工具'],
    ['grade', '右栏 · 学段']
  ]
  let railSeen = false
  for (const [key, label] of tabs) {
    const clicked = await cdp.evaluate(`(() => {
      const tab = document.querySelector('[data-testid="rail-tabs"] [data-tab="${key}"]')
      if (!tab) return false
      tab.click()
      return true
    })()`)
    if (!clicked) continue
    railSeen = true
    await wait(350)
    const state = await cdp.evaluate(READ_STATE('[data-testid="context-rail"]'))
    if (!state) continue
    const leaks = leaksIn(state.text)
    check(label, '不含开发者术语', leaks.length === 0, leaks.length ? `出现：${leaks.join('、')}` : `正文 ${state.len} 字`)
    check(label, '不含教师视角证据块', state.teacherNodes === 0, `data-teacher 节点 ${state.teacherNodes} 个`)
  }
  if (!railSeen) check('右栏', '三个页签都可点开', false, '没找到 rail-tabs（应用起了吗？）')

  // ② 三个浮层：学段 / 章节 / 模型
  //
  // ★ 触发器按**测试 id / 控件角色**找，不按文案找：顶栏与输入条上各有模型 chip，
  //   学段指示器还有「紧凑形态」，按文案匹配会点到错误的那个（第一版就点错了，
  //   三个浮层全报「未打开」——那是探针的 bug，不是界面的）。
  const popovers = [
    ['grade-options', '浮层 · 学段选择', 'grade'],
    ['chapter-options', '浮层 · 章节选择', 'chapter'],
    ['model-picker', '浮层 · 模型选择', 'model']
  ]
  for (const [testid, label, kind] of popovers) {
    // 先 Esc 收掉可能开着的面板（否则会点到「面板里的东西」）
    await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await wait(150)
    const opened = await cdp.evaluate(`(() => {
      const panel = document.querySelector('[data-testid="${testid}"]')
      if (panel) return 'already'
      // 三类触发器的可辨识特征：模型 chip 有 data-testid，学段/章节是带 aria-expanded 的按钮
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      const pick = () => {
        if ('${kind}' === 'model') {
          return document.querySelector('[data-testid="composer-model"], [data-testid="topbar-model"]')
        }
        // 学段与章节的触发器：拿的是同一套「下拉触发器」约定（aria-expanded），
        // 用所在容器或自身 testid 区分（文案在不同学段下会变，靠文案匹配不可靠）
        // ⚠️ 本段在**模板字符串里**，注释中不能出现反引号（会提前结束字符串，实测踩过一次）
        if ('${kind}' === 'grade') {
          return document.querySelector('[data-testid="grade-indicator"] [aria-expanded], [data-testid="grade-set"]')
        }
        return document.querySelector('[data-testid="chapter-set"]')
      }
      const trigger = pick() ?? (() => {
        // 兜底：按 aria-expanded + 文案（不同窗口宽度下组件形态不同）
        const byExpanded = candidates.filter((el) => el.hasAttribute('aria-expanded'))
        return '${kind}' === 'grade'
          ? byExpanded.find((el) => /学段|手动选中|AI 引擎推算|待判定/.test(el.textContent || ''))
          : byExpanded.find((el) => /章节|不限章节|正在学/.test(el.textContent || ''))
      })()
      if (!trigger) return 'no-trigger'
      trigger.click()
      return 'clicked'
    })()`)
    await wait(450)
    const state = await cdp.evaluate(READ_STATE(`[data-testid="${testid}"]`))
    if (!state) {
      // 面板没打开不算失败（不同窗口宽度下触发器可能不同），但要如实记一笔：
      // 没覆盖到就说没覆盖到，绝不写成「通过」
      check(label, '能打开并检查', false, `未打开（${opened}）—— 该浮层本次未覆盖`)
      continue
    }
    const leaks = leaksIn(state.text)
    check(label, '不含开发者术语', leaks.length === 0, leaks.length ? `出现：${leaks.join('、')}` : `正文 ${state.len} 字`)
    check(label, '不含教师视角证据块', state.teacherNodes === 0, `data-teacher 节点 ${state.teacherNodes} 个`)
    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await wait(200)
  }

  // ③ 聊天正文（模板字符串拼出来的句子都在这儿）
  const chat = await cdp.evaluate(READ_STATE(null))
  if (chat) {
    const leaks = leaksIn(chat.text)
    check('对话正文', '整页可见文本不含开发者术语', leaks.length === 0, leaks.length ? `出现：${leaks.join('、')}` : `正文 ${chat.len} 字`)
    check('对话正文', '整页不含教师视角证据块', chat.teacherNodes === 0, `data-teacher 节点 ${chat.teacherNodes} 个`)
  }

  // ── 反向对照：切到教师视角，同一批探针**必须能扫到东西** ──────────────
  console.log('\n\u001b[1m【教师视角】同一批探针的反向对照\u001b[0m')
  await cdp.evaluate(`localStorage.setItem('k12.viewMode', 'teacher')`)
  await cdp.send('Page.reload')
  await wait(6000)

  const teacherRail = await cdp.evaluate(READ_STATE('[data-testid="context-rail"]'))
  if (!teacherRail) {
    check('教师视角', '右栏仍可读', false, '重载后找不到右栏')
  } else {
    check(
      '教师视角 · 右栏',
      '★ 证据重新出现（data-teacher 节点 ≥ 1）',
      teacherRail.teacherNodes >= 1,
      `data-teacher 节点 ${teacherRail.teacherNodes} 个`
    )
    const evidence = /FTS5|隔离在 SQL 层强制|代码层强制|向量检索/.test(teacherRail.text)
    check(
      '教师视角 · 右栏',
      '★ 四级降级链 / SQL 隔离原文仍在（答辩要看的证据）',
      evidence,
      evidence ? '降级链与硬边界原文都在' : '证据没了 —— 那不是「分视角」，是把答辩材料删了'
    )
  }

  const teacherSidebar = await cdp.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('nav a, nav button, aside button'))
      .map((el) => (el.textContent || '').trim())
    return { hasKnowledge: items.some((t) => t.includes('教材知识库')), count: items.length }
  })()`)
  check(
    '教师视角 · 侧栏',
    '★ 「教材知识库」入口出现（教师专属页）',
    teacherSidebar?.hasKnowledge === true,
    `侧栏项 ${teacherSidebar?.count ?? 0} 个`
  )

  // ── 恢复学生视角（下次跑脚本 / 人工打开时是默认状态）─────────────────
  await restoreStudentView()

  const failed = results.filter((r) => !r.ok)
  console.log('\n' + '═'.repeat(66))
  if (failed.length === 0) {
    console.log(`\u001b[32m✓ 学生视角技术词扫描全部通过（${results.length} 项，含教师视角反向对照）\u001b[0m`)
    console.log('  已恢复为学生视角。')
    return 0
  }
  console.log(`\u001b[31m✗ ${failed.length} 项未通过（共 ${results.length} 项）\u001b[0m\n`)
  for (const f of failed) console.log(`【${f.where}】${f.label}\n   ${f.detail}\n`)
  console.log('  已恢复为学生视角。')
  return 1
}

main().then(
  (code) => process.exit(code),
  async (error) => {
    // ══════════════════════════════════════════════════════════════════════
    // ★★ 出错时也必须把视角恢复成学生（复审实测出来的隐患）
    // ══════════════════════════════════════════════════════════════════════
    // 本脚本在中途把 `localStorage.k12.viewMode` 改成 `teacher`。
    // 早先的版本只在**成功路径**的末尾改回来 —— 一旦中途抛异常（页面被重载、
    // 目标断开、`evaluate` 超时），应用就被留在了**教师视角**持久化状态：
    //   · 下次人打开应用，学生直接看到检索降级链 / kp_id / kb.sqlite；
    //   · `ux-pages-audit` / `ux-layout-audit` 自称「按学生视角跑」，
    //     却会在教师视角下静默审计另一个世界（它们的页清单也变了）。
    // 这是**最糟的一类脚本缺陷**：它不改产品，但会让产品看起来是坏的。
    // 所以恢复动作放在这里，与成功路径用同一个 helper。
    await restoreStudentView().catch(() => {})
    console.error(`\u001b[31m脚本自身出错：\u001b[0m${error.message}`)
    process.exit(2)
  }
)
