/**
 * 逐页 UX 体检抓到的缺陷 → 回归守卫（`scripts/ux-pages-audit.mjs` 的配套）。
 *
 * 覆盖三处（都在真机上先复现、再修、再验）：
 *   ① 编程页把**后端排障文案**原样摆给学生看（HTTP 404 + 内部 kp_id + 服务器路径）；
 *   ② 一批可点元素低于 28px 触控下限（散布在五六个页面，靠设计 token 层统一抬）；
 *   ③ 「回到最新」浮标压住输入框 17px（魔数定位导致）。
 *
 * 这些都是**源码/结构级**断言 —— 它们钉住「改法」，真机效果由 `ux-pages-audit.mjs` 量。
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments) => readFileSync(join(desktopRoot, ...segments), 'utf8')

/* ================================================================== *
 * ① 编程页不得把后端排障文案摆给学生
 * ================================================================== */

test('★★ 编程页的模板失败文案必须**按受众改写**，不能直出后端原文', () => {
  const code = read('src', 'renderer', 'src', 'stores', 'code.ts')

  // 缺陷现场：后端 404 的 detail 是给排障用的 ——
  //   「读取失败（HTTP 404）：知识点 'pl-ai-around-me' 还没有预置代码模板。
  //     现有模板：jr-data-features、…（模板文件：server/resources/code-templates/）。」
  // 一个 10 岁学生打开编程页，看到的是 HTTP 状态码 + 内部 kp_id + 服务器文件路径。
  assert.match(code, /function studentFacingTemplateError\(/, '必须有一个「翻译给学生看」的函数')
  const body = code.slice(
    code.indexOf('function studentFacingTemplateError('),
    code.indexOf('function studentFacingTemplateError(') + 1200
  )

  // 判据要能认出「技术信息」，而不是精确匹配某一句（后端文案会变）。
  // ⚠️ 用普通字符串包含判断而不是构造正则 —— 判据里写的是 `server[\/]`、`\/api\/`
  //   这种转义形式，套进 new RegExp 要多层转义，实测把自己绕晕了（第一次写成 server[\\/] 匹配不到）。
  for (const needle of ['HTTP', 'server', 'api', 'kp_id', 'traceback']) {
    assert.ok(body.includes(needle), `判据里要能认出 ${needle} 这类技术信息`)
  }
  // 命中技术信息 → 换成可读一句话，且**原文只进控制台**
  assert.match(body, /console\.warn\(/, '原始原因要留在控制台（开发/老师排障要看）')
  assert.match(body, /还没有配套的代码模板/, '给学生的那句要讲人话：告诉他「换个知识点」而不是「HTTP 404」')

  // 两处失败分支都必须过这个翻译（漏一处就等于没修）
  const load = code.slice(code.indexOf('async function loadTemplate('), code.indexOf('async function loadTemplate(') + 1600)
  const calls = (load.match(/studentFacingTemplateError\(/g) ?? []).length
  assert.ok(calls >= 2, `loadTemplate 的「后端返回失败」与「抛异常」两条分支都要过翻译（实测只有 ${calls} 处）`)
  assert.doesNotMatch(
    load,
    /templateError\.value = result\.message/,
    '不得把后端原文直接塞进 templateError'
  )
})

test('★ 界面文案不得包含服务器路径 / HTTP 状态码（学生看到的字里）', () => {
  // 扫所有渲染层的错误赋值：允许在 console.warn 里出现，不允许直接进 *Error.value
  const stores = ['code.ts', 'knowledge.ts', 'quiz.ts', 'animation.ts', 'study.ts']
  for (const file of stores) {
    const source = read('src', 'renderer', 'src', 'stores', file)
    const direct = [...source.matchAll(/(\w*Error)\.value = (result\.message|raw)\b/g)].map((m) => m[0])
    // 这里**不**强制每条都改写（有些后端的 message 本来就是给人看的可读中文），
    // 只钉住「编程页那条已改」这一处 —— 其它页由 ux-pages-audit 真机量（它扫界面上是否出现技术词）。
    if (file === 'code.ts') {
      assert.equal(
        direct.filter((line) => line.includes('templateError')).length,
        0,
        `code.ts 里仍有直出的写法：${direct.join('、')}`
      )
    }
  }
})

/* ================================================================== *
 * ② 触控下限（设计 token 层统一定义，而不是逐页调）
 * ================================================================== */

test('★★ 触控下限必须在**设计 token 层**统一（逐页调会漏、且新页面会重新踩）', () => {
  const base = read('src', 'renderer', 'src', 'assets', 'base.css')

  // Element Plus 一侧
  for (const selector of [
    '.el-button:not(.el-button--text):not(.el-button--link)',
    '.el-radio-button__inner',
    '.el-segmented__item',
    '.el-check-tag'
  ]) {
    assert.ok(base.includes(selector), `设计系统里必须给 ${selector} 定下限（否则那个组件就是 22px）`)
  }

  // 手写按钮一侧：五份 `.btn` 各自漂移过，所以要有共享工具类
  assert.match(base, /\.k12-tap\s*\{/, '必须给手写按钮一个共享的 .k12-tap 工具类')

  // 下限值本身：28px，且说明为什么不是 44（桌面应用，精度由鼠标决定）
  const tapBlocks = [...base.matchAll(/min-height:\s*28px/g)].length
  assert.ok(tapBlocks >= 4, `设计系统里至少要有 4 处 28px 下限（实测 ${tapBlocks} 处）`)
  assert.match(base, /桌面应用/, '要写清「为什么是 28 而不是 44」——否则后人会照搬移动端标准把界面撑松')

  // ⚠️ 必须是 min-height 而不是 height：多行/大字号要能撑高（P-071 踩过「钉死高度裁字」）
  const rules = [...base.matchAll(/\.(el-button[^,{]*|el-radio-button__inner|el-segmented__item|el-check-tag|k12-tap)\s*\{([^}]*)\}/g)]
  const offenders = rules.filter(([, , body]) => /[^-]height:\s*\d+px/.test(body))
  assert.deepEqual(
    offenders.map((m) => m[1].trim()),
    [],
    '这些规则里不得用固定 height（字号一变就裁字）—— 一律 min-height'
  )
})

test('★ 表格列头的排序按钮也要有触控面积（它是可点的，但默认只有 24×14）', () => {
  const base = read('src', 'renderer', 'src', 'assets', 'base.css')
  assert.match(base, /\.el-table th \.caret-wrapper\s*\{/, '排序按钮必须有触控下限')
  const rule = base.slice(base.indexOf('.el-table th .caret-wrapper {'), base.indexOf('.el-table th .caret-wrapper {') + 300)
  assert.match(rule, /min-height:\s*28px/, '排序按钮至少 28px 高')
  assert.match(rule, /cursor:\s*pointer/, '要让它看起来可点（默认像一段普通文字）')
})

/* ================================================================== *
 * ③ 浮层不得压住可交互元素
 * ================================================================== */

test('★★ 「回到最新」的定位不得依赖魔数（实测压住输入框 17px）', () => {
  const chatView = read('src', 'renderer', 'src', 'views', 'Chat.vue')

  // 缺陷现场：`bottom: 92px` —— 按「输入条大约 92px 高」试出来的。
  // 实测按钮下边缘 810px、输入条上边缘 793px，**重叠 17px**；
  // 而输入条一变成多行、高度一变，这个魔数就彻底失效。
  const jumpRule = chatView.slice(chatView.indexOf('.chat__jump {'), chatView.indexOf('.chat__jump {') + 700)
  assert.doesNotMatch(jumpRule, /bottom:\s*\d+px/, '不得用固定像素定位（那正是重叠的成因）')
  assert.match(jumpRule, /bottom:\s*calc\(100% \+ \d+px\)/, '应当相对底部区容器定位（100% + 间距）')

  // 而且底部区必须是一个**定位上下文**，否则 calc(100%) 无从计算
  assert.match(chatView, /\.chat__foot\s*\{[^}]*position:\s*relative/, '底部区必须是 relative 容器')
  // 模板里三者要在同一个 foot 里（否则按钮的 100% 参照物不是它们）
  const footStart = chatView.indexOf('class="chat__foot"')
  assert.ok(footStart > 0, '模板里必须有 chat__foot 容器')
  const footSection = chatView.slice(footStart, footStart + 2500)
  for (const id of ['chat-jump-latest', 'chat-queued']) {
    assert.ok(footSection.includes(id), `${id} 必须位于 chat__foot 内（否则定位参照物不一致）`)
  }
  // `composer-input` 在子组件 MessageComposer 里，这里只能确认**输入条容器**在里面
  assert.ok(footSection.includes('chat__composer'), '输入条容器必须在 chat__foot 内')

  // 真机几何断言在 ux-audit.mjs 的 H1/H2 —— 这里只确认它还在（别被删掉）
  const audit = read('scripts', 'ux-audit.mjs')
  assert.match(audit, /H1/, 'ux-audit 里必须保留「浮标不压住输入框」的几何断言')
  assert.match(audit, /getBoundingClientRect/, '几何断言要真的量矩形，而不是只看元素存在')
})
