/**
 * 逐页 UX 体检：把侧栏八个页面**逐个走一遍**，量「人用起来顺不顺」。
 *
 * 为什么需要它：`ux-audit.mjs` 只覆盖对话页（最高频，但不是全部）。
 * 动画 / 编程 / 闯关 / 学习记录 / 知识图谱 / 设置 这六页（学生视角；
 * 参考资料库是教师专属页，不在学生侧栏里）
 * 各有各的交互形态 —— 编辑器能不能打字、列表空态有没有说明、按钮点下去有没有反馈，
 * 这些在对话页的量法里都体现不出来。
 *
 * 跑法：`node scripts/ux-pages-audit.mjs`（需要 K12_DEBUG_PORT=9222/9224 启动的应用）
 * 退出码：0 = 通过；1 = 有发现；2 = 脚本自身出错
 */

import {
  A11Y_SCRIPT,
  VERIFY_ANCHORS_SCRIPT,
  captureFailureScreenshot,
  formatAnchorReport
} from './probe-lib.mjs'
import { resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

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

/**
 * 闯关页专用断言（2026-09-26）：默认「一次一张」，可切「全部铺开」。
 *
 * ★ 为什么要有这一格：通用体检只看「页面有内容 / 没技术词 / 点得到 / 不溢出」，
 *   而这次改动要证的是**一次渲染几道题** —— 只能按 DOM 里的题目节点数量。
 * ★ 先切到「一次一张」再量：排版偏好是持久化的（`k12.quizLayout`），上一次跑或学生
 *   自己切过「全部铺开」都会让默认档那条断言假红。跑完再切回默认档，别把偏好留在体检档。
 */
async function auditQuizLayout(cdp) {
  const label = '个性化学习'
  const probe = `(() => {
    const questions = document.querySelectorAll('[data-testid^="quiz-question-"]')
    const steps = document.querySelectorAll('[data-testid^="quiz-step-"]')
    const group = document.querySelector('[data-testid="quiz-layout-toggle"]')
    const selected = group ? group.querySelector('.el-segmented__item.is-selected') : null
    const position = document.querySelector('[data-testid="quiz-position"]')
    return {
      questions: questions.length,
      steps: steps.length,
      hasToggle: Boolean(group),
      selectedLabel: selected && selected.innerText ? selected.innerText.trim() : '',
      position: position && position.textContent ? position.textContent.replace(/\\s+/g, ' ').trim() : '',
      hasNav: Boolean(document.querySelector('[data-testid="quiz-nav"]')),
      hasSteps: Boolean(document.querySelector('[data-testid="quiz-steps"]'))
    }
  })()`
  const pick = (name) => `(() => {
    const group = document.querySelector('[data-testid="quiz-layout-toggle"]')
    if (!group) return false
    const item = Array.from(group.querySelectorAll('.el-segmented__item')).find((el) => (el.innerText || '').trim() === ${JSON.stringify(name)})
    if (!item) return false
    item.click()
    return true
  })()`

  const initial = await cdp.evaluate(probe)
  if (!initial.hasToggle) {
    // 题卡与开关只在「这一关真的有题」时渲染 —— 题库为空 / 还没选关卡时这一格**量不到**，
    // 那是环境状态不是缺陷：如实打一条 SKIP，别假装通过，也别误报成红。
    console.log(
      '  \u001b[33m[SKIP]\u001b[0m 闯关页没有题卡（这一关没有题目 / 还没选关卡）—— 「一次一张」这一格未量到'
    )
    return
  }

  await cdp.evaluate(pick('一次一张'))
  await sleep(250)
  const single = await cdp.evaluate(probe)
  // 这一关一共几题 = 单卡模式里的步骤条颗数（列表模式下步骤条**不渲染**，拿不到这个数）
  const total = single.steps
  check(
    label,
    '★★ 默认排版是「一次一张」：同一时刻只渲染一道题',
    single.questions === 1 && single.selectedLabel === '一次一张' && single.hasNav && single.hasSteps,
    `选中「${single.selectedLabel}」，DOM 里的题 ${single.questions} 道（这一关共 ${total} 题）；` +
      `位置行「${single.position}」，卡脚=${single.hasNav}，步骤条=${single.hasSteps}`,
    '一屏同时摆三份题面 / 选项 / 提交键，学生看不出现在该做哪一道'
  )

  await cdp.evaluate(pick('全部铺开'))
  await sleep(250)
  const list = await cdp.evaluate(probe)
  check(
    label,
    '切「全部铺开」= 这一关的题全部渲染出来（原排版一字未改）',
    list.questions === total &&
      list.selectedLabel === '全部铺开' &&
      list.hasNav === false &&
      list.hasSteps === false,
    `选中「${list.selectedLabel}」，DOM 里的题 ${list.questions} 道 / 这一关 ${total} 题；` +
      `卡脚=${list.hasNav}（列表模式应为 false），步骤条=${list.hasSteps}（列表模式应为 false）`,
    '两种排版共用同一段模板，差别只有一次渲染几行 —— 对不上就说明多了一份实现'
  )

  // 收尾：切回默认档（偏好是持久化的，别把它留在体检脚本选的那一档）
  await cdp.evaluate(pick('一次一张'))
  await sleep(150)
}

/**
 * 对话页的练习卡：**一次只渲染一道题** + 进度卡不嵌题卡（报告 §2.3）。
 *
 * ★ 为什么放在这里而不是通用体检里：通用体检只看「有内容 / 没技术词 / 点得到 / 不溢出」，
 *   而「一次渲染几道题」「进度卡长在哪一层」只能按 DOM 结构量。
 * ★ 对话页有没有练习卡取决于这轮对话：量不到就如实 SKIP（环境状态不是缺陷）。
 */
async function auditChatQuizCard(cdp) {
  const label = '问问智团团'
  const probe = `(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="quiz-card"]'))
    const last = cards.length ? cards[cards.length - 1] : null
    const progress = Array.from(document.querySelectorAll('[data-testid="progress-card"]'))
    return {
      cards: cards.length,
      questions: last ? last.querySelectorAll('[data-testid="quiz-question"]').length : 0,
      probeCount: last ? last.getAttribute('data-probe-count') : null,
      steps: last ? last.querySelectorAll('[data-testid^="quiz-step-"]').length : 0,
      progress: progress.length,
      progressInsideQuiz: progress.filter((el) => el.closest('[data-testid="quiz-card"]') !== null).length
    }
  })()`
  const state = await cdp.evaluate(probe)
  if (state.cards === 0) {
    console.log(
      '  \u001b[33m[SKIP]\u001b[0m 对话页当前没有练习卡（这轮对话没做题）—— 「单题渲染 / 进度卡外置」两格未量到'
    )
    return
  }
  check(
    label,
    '★★ 对话内练习卡只渲染一道题（单题模式）',
    state.questions === 1 && state.probeCount === '1',
    `卡片里渲染的题 ${state.questions} 道（应为 1），data-probe-count=${state.probeCount}，题号步骤 ${state.steps} 颗`,
    '一屏同时摆三份题面 / 选项 / 提交键，学生看不出现在该做哪一道（报告 §2.3 的现状问题）'
  )
  check(
    label,
    '★★ 闯关进度卡独立成卡（不嵌在练习卡里）',
    state.progress === 0 ? true : state.progressInsideQuiz === 0,
    `页面上进度卡 ${state.progress} 张，其中嵌在练习卡里的 ${state.progressInsideQuiz} 张`,
    '进度卡挂在练习卡内部会把卡片拉得极长（报告 §2.3 的现状问题二）'
  )
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
  // ★★ 先让渲染器真的在渲染：hidden 窗口下 ResizeObserver 一次都不触发，
  //    「内容长高后有没有跟随」这类测量会**全部失真**（实测踩到，见 ensureRendering 的说明）。
  const visibility = await cdp.ensureRendering()
  if (visibility !== 'visible') {
    console.log(`[33m⚠️ 窗口仍是 ${visibility}：与渲染时序相关的断言可能失真（见 ensureRendering 的说明）[0m`)
  }
  // ★★ 锚点自检（报告 §5.3）：**开跑之前**先确认探针要找的结构锚点在不在。
  //    · 缺锚点 → 只打「部分失败」提示（多半是"这一页/这个状态还没出现"，不是产品红）；
  //    · 行为不符（找到了但属性对不上）→ 判红（那才是真的行为不符）。
  try {
    const anchors = await cdp.evaluate(VERIFY_ANCHORS_SCRIPT)
    console.log(`\n\u001b[1m${formatAnchorReport(anchors)}\u001b[0m`)
    if (anchors.mismatched.length > 0) {
      check(
        '锚点自检',
        '结构锚点的行为与期望一致',
        false,
        formatAnchorReport(anchors).split('\n').slice(1).join('；')
      )
    }
  } catch (error) {
    console.log(`⚠️ 锚点自检没跑成：${error.message}`)
  }

  // ★★ 学生视角的侧栏里**没有**「参考资料库」：它现在是教师 / 答辩专属页
  //    （`PAGES.knowledge.nav === 'teacher'`）。这个体检脚本跑的是**学生视角**
  //    （应用默认就是学生视角，且脚本不改视角），所以清单里不能有它 ——
  //    列了它会红成「侧栏找不到这个入口」，那是**跑法不对**而不是产品坏了。
  //    （那一页的教师侧体检由 `ux-layout-audit.mjs` 或人工走查看；它不进学生路径。）
  const pages = ['动画讲解', '智码工坊', '个性化学习', '学习记录', '知识图谱', '设置']

  // ★★ 先把两栏展开（2026-09-22）：两栏默认收起（`stores/panels.ts`），收起时是
  //    `display: none`；本脚本逐页量版式，左栏（历史对话）在对话页参与布局 ——
  //    不展开就是在量一个学生看不到的版式。⚠️ 测量前提，不是产品行为。
  await cdp.evaluate(`(() => {
    for (const id of ['history-toggle', 'rail-toggle']) {
      const btn = document.querySelector('[data-testid="' + id + '"]')
      if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click()
    }
    return true
  })()`)
  await sleep(400)

  // 起点：先回对话页，保证每次切换都从同一状态出发
  await goto(cdp, '问问智团团')

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
    // 闯关页多量一格：默认「一次一张」（这一页的行为不是通用体检能覆盖的）
    if (label === '个性化学习') await auditQuizLayout(cdp)
  }

  // 回对话页：练习卡的两格（单题渲染 / 进度卡外置）只在有卡片时量得到
  await goto(cdp, '问问智团团')
  console.log('\n\u001b[1m【对话页 · 练习卡】\u001b[0m')
  await auditChatQuizCard(cdp)

  // ★★ axe 类规则（报告 §6.4 的自研等价物，见 probe-lib.mjs 的说明）：
  //    键盘（aria-hidden 子树里的可聚焦元素）/ 语义（可交互元素没有名字）/ 对比度（≥4.5:1）。
  console.log('\n\u001b[1m【axe 类规则 · 键盘 / 语义 / 对比度】\u001b[0m')
  try {
    const problems = await cdp.evaluate(A11Y_SCRIPT)
    check(
      'axe 类规则',
      '键盘 / 语义 / 对比度三类规则零违规',
      problems.length === 0,
      problems.length === 0
        ? '三类规则全过'
        : problems.map((p) => `${p.rule} @ ${p.target}：${p.detail}`).join('；')
    )
  } catch (error) {
    console.log(`⚠️ axe 类规则没跑成：${error.message}`)
  }

  // ★ 失败自动截图（报告 §5.3）：红了留现场（`desktop/.probe-artifacts/`，已 gitignore）。
  if (findings.length > 0) {
    const file = await captureFailureScreenshot(
      cdp,
      `ux-pages-audit-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      resolve(HERE, '..', '.probe-artifacts')
    )
    console.log(file ? `\n失败现场截图：${file}` : '\n（失败截图没拍成）')
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
