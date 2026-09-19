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

/* ================================================================== *
 * ④ 教材换代后的历史数据不得渲染成裸 kp_id
 *    （2026-09-19 截图实测：闯关页 55 关、顶栏与档案页显示 ph-data-train-predict）
 * ================================================================== */

const serverRoute = (...segments) =>
  readFileSync(join(desktopRoot, '..', 'server', ...segments), 'utf8')

test('★★ 进度 / 推荐 / 报告三处都必须丢掉**已删除知识点**的残留行', () => {
  // 缺陷形态：`learning.db` 按学生长期保留，而教材会换代。
  // 换代后老学生库里还留着一批指向已删除 kp 的 mastery / progress 行，
  // 一旦当正常数据渲染，界面上就出现**裸 kp_id**（查不到中文名 → 各处兜底显示 id 原文）。
  // 实测三处中招：闯关进度（0/55，含 15 个旧关）、顶栏「建议接着练」、档案页「继续学习」。
  const quiz = serverRoute('app', 'routes', 'quiz.py')
  const profile = serverRoute('app', 'routes', 'profile.py')
  const study = serverRoute('app', 'routes', 'study.py')

  // 判据是**行为**（有没有把「当前教材里真实存在的 kp」当白名单），不是某个函数名 ——
  // quiz.py 走 `_known_kp_ids()`（按 kb mtime 缓存的全库 id），与 all_kp_ids 同源但少一次查库。
  // ⚠️ 不能只查「有没有 _known_kp_ids 这个名字」—— 变异测试里把它改名就骗过了守卫。
  //    要断言**三件事**：白名单函数读全库 kp、它被调用、调用处真的把结果传下去。
  assert.match(quiz, /SELECT kp_id FROM kp/, 'quiz.py 的白名单要真的读 kb 里的全部 kp')
  assert.match(
    quiz,
    /known_kp_ids=_known_kp_ids\(request\)/,
    '进度端点必须把「当前教材全库 kp」传进去（只定义不传 = 没过滤）'
  )
  assert.match(
    quiz,
    /known_kp_ids: Collection\[str\] \| None = None/,
    'progress_snapshot 必须真的接受这个白名单参数'
  )
  for (const [name, src] of [['profile.py', profile], ['study.py', study]]) {
    assert.match(src, /all_kp_ids\(/, `${name} 必须用 all_kp_ids() 过滤掉已删除知识点`)
  }
  // kb 读不到时**不得**退化成「空集」——那会把「库没打开」伪装成「没有学习记录」
  assert.match(
    study,
    /if live:/,
    'study.py 只在真的读到 kp 时才过滤（空集会让报告看起来像「什么都没学」）'
  )
})

test('★ 卡方里的 kp_id 过滤必须**不删库里的行**（只不显示，不销毁数据）', () => {
  const quiz = serverRoute('app', 'routes', 'quiz.py')
  const body = quiz.slice(quiz.indexOf('def progress_snapshot('), quiz.indexOf('def progress_snapshot(') + 2600)
  // 过滤发生在**读出来的列表**上，不是 DELETE
  assert.match(body, /row\.kp_id in known_kp_ids/, '过滤应当是「读时筛掉」，不是删行')
  assert.doesNotMatch(body, /DELETE\s+FROM\s+progress/i, '绝不能在读的时候删学生的历史数据')
})

/* ================================================================== *
 * ⑤ 层级：浮层不得压住别的东西（三处实测缺陷）
 * ================================================================== */

test('★★ 顶栏学段气泡必须让开右栏（实测被压住 27px）', () => {
  const grade = read('src', 'renderer', 'src', 'components', 'GradeIndicator.vue')
  const rule = grade.slice(
    grade.indexOf('.grade--compact .grade__extras {'),
    grade.indexOf('.grade--compact .grade__extras {') + 1400
  )
  // 缺陷：气泡锚在顶栏右缘（x=1179），而右栏从 x=1152 起 —— 右边被盖住，
  // 看到的是缺一角的绿纸片（文字恰好完整，只读文字发现不了）。
  assert.doesNotMatch(
    rule,
    /^\s*right:\s*0;/m,
    '不得锚在顶栏右缘（顶栏比对话栏宽，会越进右栏）'
  )
  assert.match(rule, /position:\s*fixed/, '应当用视口定位，与顶栏多宽无关')
  assert.match(
    rule,
    /right:\s*calc\(var\(--k12-w-rail\)/,
    '右边界要按**右栏宽度令牌**让开，而不是写一个魔数'
  )
  // 右栏收起时贴回右缘
  assert.match(grade, /:has\(\.rail--closed\)/, '右栏收起时气泡要贴回右边，否则像飘在半空')
})

test('★ 右栏宽度只能有一个来源（曾经 300px 令牌 vs 288px 硬写）', () => {
  const rail = read('src', 'renderer', 'src', 'components', 'ContextRail.vue')
  const rule = rail.slice(rail.indexOf('.rail {'), rail.indexOf('.rail {') + 400)
  assert.match(rule, /width:\s*var\(--k12-w-rail\)/, '宽度必须读设计令牌')
  assert.doesNotMatch(rule, /^\s*width:\s*\d+px;/m, '不得再硬写一个像素宽度（会与令牌差开）')
})

test('★★ 依赖图谱的检查器不得盖住节点卡片', () => {
  const dep = read('src', 'renderer', 'src', 'views', 'Dependency.vue')
  // 缺陷：检查器 absolute 叠在右上角，而 `.layer__nodes` 是 flex-wrap，
  // 节点会流到它底下被盖住 —— 卡片只露一半、kp_id 被裁成「algor…」。
  // ⚠️ 断言**规则体**而不是选择器是否出现：只查选择器的话，
  //    把选择器改一个字符（`.layer__nodes--OFF`）就能骗过守卫 —— 变异测试暴露过。
  const reserveStart = dep.indexOf('.dg__stage:has(> .insp) .layer__nodes')
  assert.ok(reserveStart > 0, '节点行必须为检查器留出右内边距')
  const reserveRule = dep.slice(reserveStart, reserveStart + 400)
  assert.match(
    reserveRule,
    /padding-right:\s*calc\(var\(--insp-w\)/,
    '避让量必须真的写在 padding-right 里，且用同一个 --insp-w 变量算'
  )
  // 宽度只有一个来源：检查器自身与其避让量都读同一个变量
  assert.match(dep, /--insp-w:/, '检查器宽度要提成变量（否则改一处忘一处又会压住）')
  const inspRule = dep.slice(dep.indexOf('.dg__stage > .insp {'), dep.indexOf('.dg__stage > .insp {') + 400)
  assert.match(inspRule, /width:\s*var\(--insp-w\)/, '检查器自身宽度也必须读那个变量')
})

test('★ 知识库表格的列宽要按**内容**定（实测两列被裁出省略号）', () => {
  const kb = read('src', 'renderer', 'src', 'views', 'Knowledge.vue')
  // 缺陷：学段列 width=96 而内容需要 111px → 被裁成「小学低年级 …」；
  // 知识点列 min-width=150 而最长的「教学短板（难自动分层适配）」需要 ~222px。
  assert.match(kb, /prop="gradeLevel"[\s\S]{0,80}?width="120"/, '学段列要放得下「小学高年级」标签')
  assert.match(kb, /prop="name"[\s\S]{0,80}?min-width="180"/, '知识点列要放得下最长的那条知识点名')
})
