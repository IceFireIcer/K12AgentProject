/**
 * 忙时发送的**排队**行为（UX 体检抓到的缺陷 → 回归）。
 *
 * 缺陷是什么：回答还在生成时学生又打了一句按回车 —— 旧实现 `send()` 直接 `return`，
 * **消息没发出去、也没有任何提示**。学生的结论不是「上一个回答还在生成」，
 * 而是「键盘坏了 / 软件卡了」。实测脚本 `scripts/ux-probe-busy-send.mjs`。
 *
 * 这一组测**可判定的那部分**（纯逻辑，不需要真模型）：
 *   - 忙时排队而不是丢弃，并清空草稿（「已被接收」的可见证据在排队条上）；
 *   - 只保留最新一条，且**被替换的那条要说出来**（静默替换 = 把学生刚敲的字扔掉）；
 *   - 取消排队要把内容**还回输入框**（那是他自己敲的，不是我们替他删的）；
 *   - 一轮结束（边沿）时自动把排队的那条发出去；
 *   - `error` 结束也要发 —— 出错的是上一轮，不该连坐。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const storeFile = join(desktopRoot, 'src', 'renderer', 'src', 'stores', 'chat.ts')

const source = readFileSync(storeFile, 'utf8')

/** 从 `anchor`（形如 `if (x) {`）开始，取出到花括号配平为止的那一段体。 */
function braceBody(text, anchor) {
  const start = text.indexOf(anchor)
  assert.ok(start >= 0, `找不到锚点：${anchor}`)
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  throw new Error(`锚点 ${anchor} 的花括号不配平`)
}

/** 取 `function name(...) { ... }` 的函数体（按花括号配平）。
 *
 * ⚠️ 不能用 `indexOf('}')` 偷懒：注释里出现 `{@link stick}` 这类花括号时会提前截断，
 *    于是断言扫不到真正的代码 —— 实测踩到过，报「必须恢复跟随」而代码明明写着（假红）。 */
function functionBody(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `chat.ts 里找不到 ${name}()`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`${name}() 的花括号不配平`)
}

test('★ 忙时发送**排队**而不是静默丢弃（缺陷回归）', () => {
  const body = functionBody('send')
  assert.match(body, /if \(streaming\.value\) \{/, '必须有显式的「忙」分支')

  // ★ 断言要盯住**语义**（排队赋值发生在任何 return 之前），而不是某一句具体写法。
  //   第一版只写了 `doesNotMatch(/streaming\.value\)\s*return/)` —— 变异测试证明它拦不住
  //   「在分支开头插一个 return」这种改法（正则要求 `)` 紧跟 return，而实际是 `) {`），
  //   三条断言里只有一条无关的变红，**没覆盖到这个缺陷本身**。
  const busy = braceBody(body, 'if (streaming.value) {')
  const assignAt = busy.indexOf('queuedText.value = text')
  assert.ok(assignAt >= 0, '忙分支里必须把内容放进队列（queuedText.value = text）')
  const firstReturn = busy.indexOf('return')
  assert.ok(
    firstReturn === -1 || assignAt < firstReturn,
    '排队赋值必须发生在任何 return **之前** —— 否则就是「按了回车什么都没发生」'
  )
})

test('★ 排队时清空草稿（字已被接收，留在框里会让人以为没发出去）', () => {
  const body = functionBody('send')
  const busyBranch = body.slice(body.indexOf('if (streaming.value) {'), body.indexOf('localNotice.value = null'))
  assert.match(busyBranch, /draft\.value = ''/, '忙分支里必须清空草稿')
  assert.match(busyBranch, /return/, '忙分支必须提前返回（不能继续走发送流程）')
})

test('★ 只保留最新一条，且**被替换的要告诉学生**', () => {
  const body = functionBody('send')
  const busyBranch = body.slice(body.indexOf('if (streaming.value) {'), body.indexOf('localNotice.value = null'))
  assert.match(busyBranch, /queueNotice\.value =/, '连发两次必须有可读提示')
  assert.match(
    busyBranch,
    /已被这一条替换|替换/,
    '提示要讲清「上一条被替换了」—— 静默替换等于把学生刚敲的字扔掉'
  )
})

test('★ 取消排队要把内容**还回输入框**', () => {
  const body = functionBody('cancelQueued')
  assert.match(body, /draft\.value = queuedText\.value/, '取消时应把内容还给输入框（那是学生自己敲的）')
  assert.match(body, /queuedText\.value = null/, '取消后队列要清空')
})

test('★★ 一轮结束时自动发出排队的那条（用**边沿**判定，不是状态）', () => {
  const body = functionBody('connect')
  const block = body.slice(body.indexOf('const wasStreaming'), body.indexOf('if (wasStreaming && !streaming.value)'))
  assert.ok(
    block.includes('const wasStreaming = streaming.value'),
    '必须记录「事件处理之前」是否在流式 —— 用「现在不流式」当判据会在每个非流式事件上误触发'
  )
  assert.match(
    body,
    /if \(wasStreaming && !streaming\.value\)/,
    '刷新队列的条件必须是「之前流式 → 现在不流式」这个边沿'
  )
  assert.match(body, /void send\(pending\)/, '边沿命中后要把排队内容真的发出去')
})

test('★ error 结束时也要发排队内容（出错的是上一轮，不连坐）', () => {
  const body = functionBody('connect')
  // 判据是「不再流式」而不是「收到 done」—— error 会让 streaming 变 false，同样命中
  assert.doesNotMatch(
    body,
    /event\.type === 'done'[\s\S]{0,80}queuedText/,
    '不要把刷新队列绑死在 done 上：error 结束时学生排的队也该发出去'
  )
  assert.match(body, /!streaming\.value/, '判据应当是「不再流式」这个事实')
})

test('★ 新会话要清掉队列（不把上一段对话的待发内容带过来）', () => {
  const body = functionBody('resetConversation')
  assert.match(body, /queuedText\.value = null/, '新会话必须清队列')
  assert.match(body, /queueNotice\.value = null/, '新会话必须清排队提示')
})

test('商店对外暴露排队状态与取消动作（界面据此渲染排队条）', () => {
  const returned = source.slice(source.indexOf('  return {'), source.indexOf('  }\n}') + 1)
  for (const key of ['queuedText', 'queueNotice', 'cancelQueued']) {
    assert.match(returned, new RegExp(`\\b${key}\\b`), `store 必须暴露 ${key}（界面要用）`)
  }
})

test('界面必须**看得见**排队（有排队条，而不是只有内部状态）', () => {
  const chatView = readFileSync(join(desktopRoot, 'src', 'renderer', 'src', 'views', 'Chat.vue'), 'utf8')
  assert.match(chatView, /data-testid="chat-queued"/, '必须有排队条元素')
  assert.match(chatView, /data-testid="chat-queued-cancel"/, '排队条上必须能取消')
  assert.match(chatView, /chat\.queuedText/, '排队条要读 store 的排队内容')
  // 「回到最新」是「停住不打扰」的配套（停住却没路回去 = 卡住）
  assert.match(chatView, /data-testid="chat-jump-latest"/, '必须提供「回到最新」按钮')
})

test('★★ 自动滚动由**容器尺寸变化**驱动，而不是手写依赖清单（缺陷根因的回归）', () => {
  const chatView = readFileSync(join(desktopRoot, 'src', 'renderer', 'src', 'views', 'Chat.vue'), 'utf8')

  // ★ 缺陷根因：旧实现 `watch(() => \`${轮数}:${正文长度}:${卡片数}\`, scrollToBottom)` ——
  //   那是一份**手写的依赖清单**，而会长高的东西远不止这三样（实测漏了引用块：
  //   一次插入 376–663px，视图掉队 759px）。
  //   所以这里断言的不是「有没有 ResizeObserver 这个字符串」，而是两条**语义**：
  //     ① 滚动是由 ResizeObserver 的回调触发的；
  //     ② 没有任何 watch 承担滚动职责。
  //   （第一版只查 `/new ResizeObserver\(/` + doesNotMatch 一个具体模板串 ——
  //     变异测试证明它拦不住「外面套一层 stub、把观察器塞进 IIFE」这种改法：0 条断言变红。）
  const observer = braceBody(chatView, 'resizeObserver = new ResizeObserver(')
  assert.match(observer, /scrollToBottom\(\)/, 'ResizeObserver 的回调里必须真的触发滚动')

  // ② 逐个检查所有 watch：**没有一个可以依赖「内容尺寸」来滚动**
  //
  //   为什么放行 watch、但只放行一种：`turns.length` 是「新的一轮开始了」这个
  //   **离散事件**（一轮 = 一次提问），语义明确、必然触发；而 `text.length` /
  //   `cards.length` 是**尺寸代理量** —— 想靠它们覆盖「所有会长高的东西」永远会漏
  //   （实测漏了引用块）。所以规则是：watch 可以响应「有新轮次」，但不能响应「变长了」。
  let cursor = 0
  let watchCount = 0
  for (;;) {
    const at = chatView.indexOf('watch(', cursor)
    if (at < 0) break
    watchCount += 1
    // ★ 要连**依赖（getter）**一起看：只取回调体的话会漏掉
    //   「它依赖的是什么」这个最关键的信息（`turns.value.length` 写在 getter 里）。
    const call = braceBody(chatView, chatView.slice(at, at + 6))
    const getterEnd = chatView.indexOf('{', at)
    const whole = chatView.slice(at, getterEnd + call.length)

    if (/scrollToBottom/.test(whole)) {
      assert.doesNotMatch(
        whole,
        /\.text\.length|\.cards\.length|scrollHeight/,
        `第 ${watchCount} 个 watch 用**内容尺寸**（text.length / cards.length / scrollHeight）` +
          '驱动滚动 —— 那就是手写依赖清单的写法，必然漏项（引用块就没被算进去）'
      )
      assert.match(
        whole,
        /turns\.value\.length/,
        `第 ${watchCount} 个 watch 若负责滚动，只允许依赖「新轮次」这个离散事件`
      )
    }
    cursor = at + 6
  }

  // 跟随/停住的开关必须在
  assert.match(chatView, /const stick = ref\(true\)/, '必须有「是否跟随」开关')
  assert.match(chatView, /STICK_TOLERANCE_PX/, '判定贴底要有容差（0 容差会把「在底部」误判成「翻上去了」）')
})

test('★ 学生往上翻时要能停住（不打扰阅读）', () => {
  const chatView = readFileSync(join(desktopRoot, 'src', 'renderer', 'src', 'views', 'Chat.vue'), 'utf8')
  const body = functionBodyIn(chatView, 'onColScroll')

  assert.match(body, /stick\.value = distanceFromBottom\(el\) <= STICK_TOLERANCE_PX/, '滚动时重算跟随状态')
  // ★ 「回到最新」必须在这里控制 —— 只写在 ResizeObserver 里会让「学生翻上去」这一场景
  //   根本不出现按钮（没有内容增长，观察器不触发），于是「停住」变成「卡住」。实测抓到过。
  assert.match(body, /showJump\.value = !stick\.value/, '往上翻时必须露出「回到最新」')
})

test('★★ 程序性滚动不得被当成「学生翻上去了」（竞态防线）', () => {
  const chatView = readFileSync(join(desktopRoot, 'src', 'renderer', 'src', 'views', 'Chat.vue'), 'utf8')

  // 竞态是什么：我们给 `scrollTop` 赋值也会派发 scroll 事件，而派发时机在**布局之后**。
  // 若内容恰好在这中间又长高（流式输出时是常态），事件里量到的
  // `distanceFromBottom` 就是「刚长出来的那段高度」→ 可能超过容差 →
  // 把 stick 误判成 false → **从此停止跟随**（表现正是「视图停在旧消息上」）。
  //
  // ★★ 判据从「布尔标记」改成「位置比对」（2026-09-21 实测改）
  //    原来断言的是 `selfScrolled.value = true` + `onColScroll` 里消费一次。
  //    那套写法**有一个实测的洞**：流式输出时 `scrollToBottom()` 会被连续调用多次，
  //    而浏览器会**合并** scroll 事件 → 多出来的事件看到 `false` → 按「学生滚的」重算 →
  //    跟随被**永久**关掉。实测指纹：`npm run ux:attribute` 里离底部的距离
  //    **单调递增且不回落**（37→143→…→759px）——「单调递增」正是「跟随被关掉」的指纹
  //    （只是慢的话距离会上下浮动）。所以这里改断言「记位置 + 按位置放过」。
  const scroller = functionBodyIn(chatView, 'scrollToBottom')
  assert.match(
    scroller,
    /selfScrollTop\.value = el\.scrollTop/,
    '程序性滚动后要**读回实际位置**并记下来（赋值会被夹到 maxScroll，记 scrollHeight 等于没防）'
  )

  const onScroll = functionBodyIn(chatView, 'onColScroll')
  assert.match(
    onScroll,
    /Math\.abs\(el\.scrollTop - selfScrollTop\.value\) <= 1/,
    'onColScroll 必须按**位置**判断「这次是不是我们自己滚的」（这样才扛得住事件合并）'
  )
  // 提前返回必须发生在**重算之前**：否则标记就白打了
  const markCheck = onScroll.indexOf('selfScrollTop.value')
  const recompute = onScroll.indexOf('stick.value = distanceFromBottom')
  assert.ok(
    markCheck >= 0 && markCheck < recompute,
    '「自己滚的」判断必须在重算 stick **之前** —— 反了就等于没防'
  )
  // 学生真滚走之后要清掉标记：否则之后长内容时，那个陈旧位置会继续被放过
  assert.match(
    onScroll,
    /selfScrollTop\.value = -1/,
    '学生真的滚动过之后必须清掉标记（否则陈旧位置会一直放过事件）'
  )
  // ⚠️ 反向对照：不许改回布尔标记 —— 那正是被实测证伪的写法。
  //    必须先**剥注释**：`Chat.vue` 里刻意写了「原来是一个 selfScrolled: boolean …」
  //    来解释为什么换掉它，不剥的话这条断言会被自己的说明书绊倒（实测踩到）。
  const chatCode = chatView
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
  assert.ok(
    !/selfScrolled/.test(chatCode),
    '不许改回布尔标记（`selfScrolled`）——它在「事件合并」下会漏放，让跟随被永久关掉'
  )
})

test('★ 发新消息必须强制恢复跟随（学生就是在等这条回答）', () => {
  const chatView = readFileSync(join(desktopRoot, 'src', 'renderer', 'src', 'views', 'Chat.vue'), 'utf8')
  // ⚠️ 取函数体**必须按花括号配平**：直接 `indexOf('}')` 会停在注释里的 `{@link stick}`
  //    上（实测踩到，报「必须恢复跟随」而代码明明写着 —— 假红）。
  const body = functionBodyIn(chatView, 'onSend')
  assert.match(body, /stick\.value = true/, '发送时必须恢复跟随')
  assert.match(body, /scrollToBottom\(\)/, '发送时应当立刻滚到底（回应「我发了消息」这个动作）')
})

/** 从一段源码里按花括号配平取出 `function name(...) { ... }` 的函数体。 */
function functionBodyIn(text, name) {
  const start = text.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 ${name}()`)
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  throw new Error(`${name}() 的花括号不配平`)
}
