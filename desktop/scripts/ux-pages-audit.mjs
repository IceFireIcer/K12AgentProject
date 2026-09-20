/**
 * 逐页 UX 体检：把侧栏八个页面**逐个走一遍**，量「人用起来顺不顺」。
 *
 * 为什么需要它：`ux-audit.mjs` 只覆盖对话页（最高频，但不是全部）。
 * 动画 / 编程 / 闯关 / 学习档案 / 学习地图 / 设置 这六页（学生视角；
 * 教材知识库是教师专属页，不在学生侧栏里）
 * 各有各的交互形态 —— 编辑器能不能打字、列表空态有没有说明、按钮点下去有没有反馈，
 * 这些在对话页的量法里都体现不出来。
 *
 * 跑法：`node scripts/ux-pages-audit.mjs`（需要 K12_DEBUG_PORT=9222/9224 启动的应用）
 * 退出码：0 = 通过；1 = 有发现；2 = 脚本自身出错
 */

const BASE = process.env.K12_DEBUG_BASE ?? 'http://127.0.0.1:9224'

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

const findings = []
let passed = 0

function check(page, what, ok, detail = '', why = '') {
  if (ok) {
    passed += 1
    console.log(`  \u001b[32m✓\u001b[0m ${what}${detail ? `  \u001b[2m(${detail})\u001b[0m` : ''}`)
  } else {
    findings.push({ page, what, detail, why })
    console.log(`  \u001b[31m✗\u001b[0m ${what}`)
    if (detail) console.log(`      实测：${detail}`)
    if (why) console.log(`      为什么要紧：${why}`)
  }
}

/** 切到某一页（按侧栏文字点）。 */
async function goto(cdp, label) {
  const ok = await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('aside button, nav button'))
      .find((x) => (x.innerText || '').trim().startsWith(${JSON.stringify(label)}))
    if (b) { b.click(); return true }
    return false
  })()`)
  await sleep(900)
  return ok
}

/** 一页的通用体检：空态说明、加载遮罩、横向滚动、可点目标尺寸、报错文案。 */
async function auditPage(cdp, label) {
  console.log(`\n\u001b[1m【${label}】\u001b[0m`)

  const state = await cdp.evaluate(`(() => {
    const main = document.querySelector('.shell__content') || document.body
    const text = main.innerText || ''
    /**
     * 量「**有效**可点区域」，而不是元素自己的矩形。
     *
     * ★ 为什么要往上找 label：radio 的本体只有 13×13（那是它画的那个小圆点），
     *   但学生实际点的是包着它的 label（实测 46×22）。直接量 input 会**报假阳性** ——
     *   第一版就这么误报了三个页面，白改一轮。
     *   规则：有 label 就用 label 的框；el-checkbox / role=button 的容器同理。
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
    const clickable = Array.from(main.querySelectorAll('button, [role="button"], a[href], input, textarea, select'))
      .map((el) => {
        const r = effectiveBox(el)
        return {
          label: (el.innerText || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 20),
          w: Math.round(r.width), h: Math.round(r.height)
        }
      })
      .filter((x) => x.w > 0 && x.h > 0)
    return {
      text: text.slice(0, 400),
      textLen: text.length,
      /**
       * 过小的可点目标。
       *
       * ★ 判据是「**至少一维**达标」，而不是「两维都必须 ≥28px」——
       *   实测纠结过：列头那个排序按钮是 24×28（宽 24、高 28）。
       *   它是「点得中」的（高够、而且是**竖向**目标，手指/光标从上下接近最自然），
       *   硬把宽度也顶到 28 只会让表头多出一块无语义的空白。
       *   真正点不中的是**两维都小**（如 13×13 的裸 radio、24×14 的排序图标）。
       *   所以规则：两维的较小者 < 20，或较大者 < 28，才算过小。
       */
      tiny: clickable.filter((x) => Math.min(x.w, x.h) < 20 || Math.max(x.w, x.h) < 28),
      clickableCount: clickable.length,
      // 卡在加载态？（页面上只有「加载中」而没有任何可操作的东西）
      loadingOnly: /加载中|正在载入/.test(text) && clickable.length <= 3,
      // 裸露的技术词（学生看不懂 / 像是坏了）
      //
      // ★★ 2026-09-20 扩表：原来的六条只抓「明显的坏味道」（undefined / 堆栈 / 失败）。
      //    但 83 张真机截图的走查发现的问题**不是坏味道**，是「太专业」——
      //    「FTS5 关键词兜底」「隔离在 SQL 层强制」「kp_id」「sandboxed iframe」
      //    这些每一句都"正常渲染"，原来那六条一条都抓不到。
      //    所以这里补上**开发者 / 运维术语**那一类。
      // ⚠️ 与 tests/student-view-discipline.test.ts 的 TERMS 同口径：那份扫源码全文
      //    （能覆盖展开态 / 状态分支），这份扫**真实 DOM**（能覆盖模板字符串拼出来的句子）。
      //    两份互补，改一份时另一份要跟着改。
      // ⚠️ 本段是**模板字符串里的页面代码**，所以注释里不能出现反引号（会提前结束字符串）
      //    也不能出现美元加大括号（会被当成插值）—— 这条注释本身就是踩过之后写的。
      leaks: [
        /\\bundefined\\b/.test(text) && 'undefined',
        /\\[object Object\\]/.test(text) && '[object Object]',
        /\\bNaN\\b/.test(text) && 'NaN',
        /TypeError|ReferenceError|Cannot read prop/.test(text) && '异常堆栈',
        /HTTP\\s*5\\d\\d/.test(text) && 'HTTP 5xx',
        /读取失败|加载失败/.test(text) && '失败文案',
        // ── 开发者 / 运维术语（走查新增）────────────────────────────────
        /\\bSQL\\b|SQLite|kb\\.sqlite|learning\\.db/.test(text) && '数据库术语',
        /\\bWHERE\\b|regex|FTS5|\\bnonce\\b|allow-scripts|sandboxed/.test(text) && '安全/检索实现细节',
        /\\bkp_id\\b/.test(text) && '内部字段名 kp_id',
        /\\bPyodide\\b|POST \\/api|GET \\/api|HTTP 200/.test(text) && '接口/运行时细节',
        // kp slug 形态（ai-definition-jr 这种）：本仓 kp_id 的构造规则
        /[a-z][a-z0-9]*(?:-[a-z0-9]+)+-(?:pl|ph|jr|sr)\\b/.test(text) && '知识点 slug',
        /检索降级链|降级链|兜底|向量检索|云端 Embedding/.test(text) && '检索实现黑话',
        /已嵌入|向量维度|分块/.test(text) && '向量库术语',
        /端口号|进程号/.test(text) && '运维数字'
      ].filter(Boolean),
      // 横向溢出
      overflow: (() => {
        const de = document.documentElement
        const bad = Array.from(main.querySelectorAll('*'))
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
          .slice(0, 3)
          .map((el) => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''))
        return { isOver: de.scrollWidth > de.clientWidth + 1, bad }
      })()
    }
  })()`)

  check(label, '页面有内容（不是空白页 / 卡在加载态）', state.textLen > 20 && !state.loadingOnly,
    `正文 ${state.textLen} 字${state.loadingOnly ? '，且只有加载态' : ''}`,
    '打开一页看到空白或永远转圈，学生只会以为「这里坏了」')

  check(label, '没有裸露的技术词（undefined / NaN / 堆栈 / HTTP 5xx / 失败文案）',
    state.leaks.length === 0,
    state.leaks.length ? `出现了：${state.leaks.join('、')}` : '干净',
    '技术词一旦出现在界面上，学生会以为软件坏了，而不是「这里暂时没数据」')

  check(label, '没有横向滚动', !state.overflow.isOver,
    state.overflow.bad.length ? `溢出元素：${state.overflow.bad.join(', ')}` : `${state.clickableCount} 个可点元素`,
    '横向滚动是「网页错版」最直观的信号，也会把内容裁掉')

  check(label, '可点目标不小于 28px', state.tiny.length === 0,
    state.tiny.length ? `${state.tiny.length} 个过小：${state.tiny.slice(0, 4).map((t) => `「${t.label}」${t.w}×${t.h}`).join('、')}` : `共 ${state.clickableCount} 个`,
    'K12 学生手指精度有限，小目标会让他反复点不中')

  return state
}

async function main() {
  const cdp = await Cdp.attach()
  // ★★ 学生视角的侧栏里**没有**「教材知识库」：它现在是教师 / 答辩专属页
  //    （`PAGES.knowledge.nav === 'teacher'`）。这个体检脚本跑的是**学生视角**
  //    （应用默认就是学生视角，且脚本不改视角），所以清单里不能有它 ——
  //    列了它会红成「侧栏找不到这个入口」，那是**跑法不对**而不是产品坏了。
  //    （那一页的教师侧体检由 `ux-layout-audit.mjs` 或人工走查看；它不进学生路径。）
  const pages = ['动画讲解', '编程环境', '闯关练习', '学习档案', '学习地图', '设置']

  // 起点：先回对话页，保证每次切换都从同一状态出发
  await goto(cdp, '对话课堂')

  const summary = []
  for (const label of pages) {
    const ok = await goto(cdp, label)
    if (!ok) {
      console.log(`\n\u001b[1m【${label}】\u001b[0m`)
      check(label, '能从侧栏进入该页', false, '侧栏找不到这个入口', '做了却点不到的页面等于没做')
      continue
    }
    const st = await auditPage(cdp, label)
    summary.push({ label, textLen: st.textLen, clickable: st.clickableCount })
  }

  cdp.close()

  console.log(`\n${'═'.repeat(66)}`)
  console.log('各页概览：')
  for (const s of summary) console.log(`  ${s.label.padEnd(12)} 正文 ${String(s.textLen).padStart(5)} 字 / 可点 ${s.clickable} 个`)

  console.log('')
  if (findings.length === 0) {
    console.log(`\u001b[32m✓ 七个页面的 UX 体检全部通过（${passed} 项）\u001b[0m`)
    return 0
  }
  console.log(`\u001b[31m✗ 发现 ${findings.length} 处问题\u001b[0m（通过 ${passed} 项）\n`)
  for (const f of findings) {
    console.log(`【${f.page}】${f.what}`)
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
