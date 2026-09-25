/**
 * UI 冒烟：用 Chrome DevTools Protocol 读**真实 DOM** 做断言（票 06 重写：无 Key 也能跑绿）。
 *
 * 前置条件：应用已带调试端口启动，例如
 *   PowerShell:  $env:K12_DEBUG_PORT=9222; npm run dev
 *   Git Bash:    K12_DEBUG_PORT=9222 npm run dev
 * 端口不同时用 `K12_DEBUG_BASE` 覆盖（默认 9222）。
 * 跑法：`node scripts/verify-ui.mjs`
 * 退出码：**0 = 全部通过；1 = 有断言失败；2 = 脚本自身出错**（连不上 / 找不到页面目标）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么要重写（票 06 的 6 项断言已经「按设计失败」）
 * ---------------------------------------------------------------------------
 * 旧版把「假数据源」当数据源：delta 增长、中文回显、citation、三种 kind 的占位卡片、
 * done、blocked —— 这些都靠 `ipc/stub-chat.ts` 的确定性事件序列。票 06 起实时对话走
 * **真实 Pi 会话**（`agent/runtime.ts`），而无 Key 时一轮对话会以 `error` 事件结束
 * （「云端模型暂时不可用…」），于是那 6 项**必然失败**：不是回归，是世界变了。
 *
 * 现在的分层（**两个世界都要绿**）：
 *
 *   A. 静态契约（不需要应用）：6 事件词表冻结、渲染进程只认这 6 个名、
 *      ★ 学段改动**只经 `window.api.setGrade`**（绝不混进对话请求）；
 *      ★ 章节改动同理，只经 store 的 `chat.setChapter`（两个入口共用同一条）。
 *   B. 外壳与边界（始终执行）：布局、preload 白名单（必需方法齐全 + 无通用 IPC 口子）、
 *      无 Node/Electron 全局泄漏、设置页可进可出、sidecar 阶段文案合法、整轮无未捕获异常。
 *   C. 学段指示器 + 两个手动入口（始终执行）：指示器在位且文案自洽；
 *      选项**默认收起**（点「自己指定学段」才出现四档）—— 展开是**学生主动动作**的结果，
 *      而不是顶栏上一直摊着一个选择控件；设置页的学段区块同样可点。
 *      ⚠️ 这两条断言于 2026-09-17 随「学段手动切换」落地而**翻转**：旧版断言的是
 *      「指示器内部没有任何控件」「`grade-selector` 不存在」——那描述的是 D-020 的
 *      「完全自动、无人工入口」世界。现在人工入口回来了（D-037），所以断言改成
 *      「**默认收起 + 点开可用**」，测的是新设计真正的不变量。
 *      C2 = 学段端到端（真的点一档 → 落库 + 回推）；C3 = 教材章节端到端
 *      （真的选一章 → 落库 + **进落盘的 system prompt**，见上面那段说明）。
 *   D. **无 Key 路径**（仅无 Key 世界）：发一条消息 → 得到**可读的「能力受限」提示**
 *      （不是堆栈、不是白屏、不是卡在「正在回答」）。
 *      —— 这一条正是「没有 API Key 时应用仍然可用」的验收口径。
 *   E. 内容断言（**仅当检测到已配置 API Key**）：delta 流式增长、终态 done、
 *      出现的卡片 kind 合法、无 U+FFFD。无 Key 世界跳过（打印 [SKIP] 并说明原因）。
 *   F. 练习卡片（dev 模式必须过）：用**真实形状的 `payload` 事件**驱动渲染进程自己的
 *      事件归约器（`applyChatEvent`），断言题目/作答/逐题反馈/掌握度变化都渲染出来，
 *      并且**标准答案与解析不出现在 DOM 里**（§6.3 答案泄漏防线的界面侧证据）。
 *
 * ★ C2/C3（2026-09-18 起）：两个**显式选择**的端到端取证 —— C2 = 学段，C3 = 教材章节。
 *   它们共同的形式是「点一下 → 断言某个只有『服务端真的写库了、主进程把结果推回来了』
 *   才可能出现的变化」。C3 还多一层：读主进程落盘的那份 `chat-system-prompt.txt`，
 *   断言选中的章节**真的进了要发给模型的文本**（软偏好最容易假绿的一处）。
 *
 * 为什么 F 要「注入事件」而不是等模型出题：无 Key 时模型不会调用 `generate_quiz`，
 * 而卡片渲染是纯前端行为 —— 所以用真实结构的事件走**真实的归约器与真实组件**，
 * 数据取自 `server/resources/quizbank/junior.json`（真实题库，不是编的）。
 * 注入路径依赖 dev 模式的 Vite 模块图；打包产物（file://）下会打印 [SKIP]。
 *
 * ---------------------------------------------------------------------------
 * 环境开关（全部可选，默认自动判定）
 * ---------------------------------------------------------------------------
 *   K12_DEBUG_BASE=9333         CDP 端口（应用用 `K12_DEBUG_PORT=9333 npm run dev` 启动）
 *   K12_VERIFY_HAS_KEY=1|0      强制指定「已配置 API Key」世界（默认：问主进程读设置）
 *   K12_OFFLINE_PROBE=1         应用跑了离线探针模式时同步设置：加宽等待上限，
 *                               并接受「离线探针模式」这句可读文案（`runtime.ts` 的 PROBE_NOTICE）
 *   K12_UI_DUMP=1               结束时把关键区域的真实 DOM 文本打出来（报告素材）
 *   K12_SKIP_GRADE_SET=1        跳过 C2 层的**端到端学段切换**（它会真的改本机学生的
 *                               `learning.db`）。默认**不跳过**：那条链路跨四层、每层失败
 *                               都是静默的，是这套改动里最值得端到端取证的一条。
 *   K12_SKIP_CHAPTER_SET=1      跳过 C3 层的**端到端章节选择**（同样会改本机学生的
 *                               `learning.db`）。默认不跳过，理由同上（且它还要送一两轮对话
 *                               去拿落盘 prompt 证据；无 Key 世界这两轮是毫秒级收尾的）。
 *   K12_REQUIRE_LAYERS=E,F      ★ 把某些层声明为**必需**：该层被跳过时按失败计（非零退出）。
 *                               收口（打包产物）时必须设：F 层（标准答案不进 DOM）在非 dev 服务下
 *                               会被跳过，不设它就等于「收口环境里没有采集这条证据，却打印全部通过」。
 *
 * 只用 Node 内置能力（Node >= 22 的全局 fetch / WebSocket），不引入任何依赖。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '..')

const debugBase = process.env.K12_DEBUG_BASE ?? '9222'
const listUrl = `http://127.0.0.1:${debugBase}/json/list`
const commandTimeoutMs = 15_000
/** 无 Key 路径：一轮应在毫秒级结束；给足余量，但超了就是「卡住」。 */
const noKeyTimeoutMs = 30_000
/** 离线探针（`K12_OFFLINE_PROBE=1`）会走真实供应商重试链（3 次），给更宽的上限。 */
const probeTimeoutMs = 90_000
/** 有 Key 世界的内容断言：等真实流式回答（含检索与工具调用）。 */
const contentTimeoutMs = 90_000

/** 冻结的 6 事件词表（顺序也是冻结的一部分）。 */
const EXPECTED_EVENT_NAMES = ['delta', 'citation', 'payload', 'blocked', 'done', 'error']
/** payload 事件的三种合法 kind（执行文档 §9.3）。 */
const EXPECTED_CARD_KINDS = ['animation', 'coding', 'quiz']
/** preload **必须**暴露的方法（学段指示器 + 设置页 + 对话）。 */
const REQUIRED_API_METHODS = [
  'getSidecarInfo',
  'onSidecarChanged',
  'sendChat',
  'onChatEvent',
  'readSettings',
  'saveSettings',
  'probeSettings'
]
/** **绝不能**出现在 `window.api` 上的通用口子（白名单之外的一切都是越界）。 */
const FORBIDDEN_API_METHODS = ['invoke', 'send', 'sendSync', 'on', 'once', 'emit', 'postMessage']
/** 预期不会泄漏到渲染进程的 Node / Electron 全局。 */
const LEAKY_GLOBALS = ['require', 'process', 'ipcRenderer', 'electron', 'Buffer', 'module']
/** sidecar 阶段文案与 `data-phase` 取值（与 SidecarBadge.vue 一致）。 */
const EXPECTED_PHASE_TEXT = ['等待启动', '启动中', '已就绪', '启动失败', '已停止']
const EXPECTED_PHASE_ATTR = ['idle', 'starting', 'ready', 'failed', 'stopped']
/** 四学段中文名（指示器文案只允许出现这四个 + 「还没认出年级」）。 */
const GRADE_LABELS = ['小学低年级', '小学高年级', '初中', '高中']
/**
 * 四学段**机器字面量**（与 `data-grade` 属性同源）。
 *
 * ★ 与 {@link GRADE_LABELS}（中文名）是**两套**取值，别混用：`badgeText` 是「初中」，
 *   `data-grade` 是 `junior`。这里曾经把中文名数组拿来判 `data-grade`，在
 *   「data-grade 恒为空」的年代**假装通过**（双方都是 falsy），学段一真判出来就暴露了。
 */
const GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior']
/**
 * 还没判出学段时指示器上的字（**必须与 `src/renderer/src/labels.ts` 的
 * `GRADE_UNKNOWN_LABEL` 逐字一致**，否则下面那条「指示器文案可读」会在未判定状态下假红）。
 *
 * ★ 2026-09-22（报告 0.2 术语表）：原词「待判定」改成「还没认出年级」——
 *   旧词是后端规则引擎视角（「判定」是 `rules.py` 的动作），学生读到的是自己没做过的事。
 *   ⚠️ 这个探针**不在 CI 里**（`npm run test` 不跑它），所以它是最容易漏同步的一处：
 *   改词时如果只跑单测，这条会在真机上安静地报假红。
 */
const GRADE_UNKNOWN_LABEL = '还没认出年级'
/** 无 Key / 供应商不可用时，主进程给学生的**可读**文案判据（`agent/events.ts` / `runtime.ts`）。 */
const DEGRADED_NOTICE_MARKERS = [
  // 正常路径：缺 Key 或连不上模型（describeProviderError / MISSING_KEY_MESSAGE）
  '云端模型暂时不可用',
  // 离线探针模式（K12_OFFLINE_PROBE=1）：文案被换成说清「这是探针」的那句，避免误读成真实网络故障
  '离线探针模式'
]
/** 降级徽章文案（`DegradedNotice.vue` 的 `degraded === true` 分支）。 */
const DEGRADED_BADGE_TEXT = '能力受限'
/** 「这不是堆栈」的判据：出现这些形状就说明把异常原文漏给了界面。 */
const STACK_PATTERNS = [/\bERR_[A-Z_]+\b/, /\bat\s+\S+\.(ts|js|mjs):\d+/, /\b(TypeError|ReferenceError|SyntaxError)\b/]
/** 判断「已配置 API Key」：环境变量优先，其次问主进程读设置。 */
const FORCED_HAS_KEY = process.env.K12_VERIFY_HAS_KEY

const results = { passed: 0, failed: 0, skipped: 0 }
const failures = []
const pageErrors = []

/* ------------------------------------------------------------------ *
 * 断言与输出
 * ------------------------------------------------------------------ */

function check(name, passed, detail) {
  if (passed) {
    results.passed += 1
    console.log(`[PASS] ${name} — ${detail}`)
  } else {
    results.failed += 1
    failures.push(name)
    console.log(`[FAIL] ${name} — ${detail}`)
  }
}

/**
 * ★ 「必需层」语义：`K12_REQUIRE_LAYERS=E,F` 时，被跳过的层算**失败**（非零退出）。
 *
 * 为什么需要它（关卡 E 的收口口径）：打包产物上 `F` 层会因为「不是 dev 服务」
 * 被跳过，而「标准答案与解析不出现在 DOM 里」这条界面的证据恰恰只能在 F 层采到 ——
 * 跳过却打印「全部通过」等于在收口环境里**没有**采集那条证据。
 * 默认（不设该变量）行为不变：跳过只打印 [SKIP]，不污染通过计数、不影响退出码。
 */
const REQUIRED_LAYERS = (process.env.K12_REQUIRE_LAYERS ?? '')
  .split(',')
  .map((item) => item.trim().toUpperCase())
  .filter(Boolean)
/** 本次跑动里被跳过的层名（汇总时单列一行，避免「跳过」被读者忽略）。 */
const skippedLayers = new Set()

function skip(name, reason, layer = '') {
  results.skipped += 1
  const tag = layer ? `[层 ${layer}] ` : ''
  if (layer) skippedLayers.add(layer)
  if (layer && REQUIRED_LAYERS.includes(layer)) {
    // 关键层被跳过 = 这条证据没有采集到 → 按失败计（这是「跳过也要出声」的强形式）
    results.failed += 1
    failures.push(`${tag}${name}（被 K12_REQUIRE_LAYERS 声明为必需层，却在本环境下被跳过）`)
    console.log(`[FAIL] ${tag}${name} — ${reason}；★ 该层被 K12_REQUIRE_LAYERS 声明为必需，跳过按失败计`)
    return
  }
  console.log(`[SKIP] ${tag}${name} — ${reason}`)
}

function info(message) {
  console.log(`[INFO] ${message}`)
}

function scriptError(message) {
  console.error(`[ERROR] ${message}`)
  process.exit(2)
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** 读源码做静态断言（读不到就当脚本错误，不静默跳过）。 */
function readSource(relativePath) {
  const absolute = join(DESKTOP_ROOT, relativePath)
  if (!existsSync(absolute)) scriptError(`静态断言需要的文件不存在：${relativePath}`)
  return readFileSync(absolute, 'utf8')
}

/** 去掉注释后再做「有没有某个写入口」这类文本断言（注释里写出反例不算数）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/* ------------------------------------------------------------------ *
 * A. 静态契约断言（不依赖应用在不在跑）
 * ------------------------------------------------------------------ */

console.log('== A. 静态契约（6 事件词表 / 渲染进程分派 / 学段无写入口）==')

{
  const ipcEventsSource = readSource('src/shared/ipc-events.ts')
  const declared =
    /export const IPC_EVENT_NAMES[^=]*=\s*\[([^\]]*)\]/.exec(ipcEventsSource)?.[1] ??
    ''
  const actualNames = [...declared.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  check(
    '6 事件词表冻结（shared/ipc-events.ts）',
    JSON.stringify(actualNames) === JSON.stringify(EXPECTED_EVENT_NAMES),
    `IPC_EVENT_NAMES = [${actualNames.join(', ')}]（期望 [${EXPECTED_EVENT_NAMES.join(', ')}]）`
  )

  const eventsSource = stripComments(readSource('src/renderer/src/api/events.ts'))
  const caseLabels = [...eventsSource.matchAll(/case\s+'([a-z_]+)'/g)].map((match) => match[1])
  const uniqueCases = [...new Set(caseLabels)].sort()
  check(
    '渲染进程只分派这 6 个事件名（没有第 7 个，也没有漏）',
    JSON.stringify(uniqueCases) === JSON.stringify([...EXPECTED_EVENT_NAMES].sort()),
    `api/events.ts 里的 case 分支：[${uniqueCases.join(', ')}]`
  )

  /*
   * ★ 设计变更（2026-09-17）：人工入口回来了（学段手动切换，D-037）。
   *
   * 旧版断言的是「渲染进程里不许存在 setGrade*」——那是 D-020「完全自动、无人工入口」
   * 世界的正确不变量。现在写入口**必须**存在，所以断言换成**新设计的两个真不变量**：
   *   ① 学段的手动写入**只走** `window.api.setGrade`（preload 白名单），
   *      而不是某个绕过 IPC 的本地写；
   *   ② 对话请求仍然**只有 text** —— 「学段不随每轮请求走」这条架构决策没有回退。
   *      这条才是这套机制里真正容易退化的地方（把 gradeLevel 加回 ChatSendRequest
   *      会让「每轮对话」变成「每轮改学段」的副作用）。守卫 G6c 在单测里已钉死它，
   *      这里从 UI 冒烟脚本再钉一次（两层证据，互不替代）。
   */
  const rendererSources = [
    'src/renderer/src/stores/chat.ts',
    'src/renderer/src/views/Chat.vue',
    'src/renderer/src/views/Settings.vue',
    'src/renderer/src/components/ChatMessage.vue',
    'src/renderer/src/components/GradeIndicator.vue',
    'src/renderer/src/labels.ts',
    'src/renderer/src/api/grade.ts'
  ]
  const gradeSetCallers = rendererSources.filter((path) =>
    /\.setGrade\s*\(/.test(stripComments(readSource(path)))
  )
  check(
    '★ 学段手动写入经 store 的 setGrade（而不是界面各处各写一份）',
    gradeSetCallers.includes('src/renderer/src/stores/chat.ts') &&
      gradeSetCallers.includes('src/renderer/src/components/GradeIndicator.vue') &&
      gradeSetCallers.includes('src/renderer/src/views/Settings.vue'),
    `调用点：${gradeSetCallers.join('、') || '（一个都没有）'}`
  )

  const chatStoreSource = stripComments(readSource('src/renderer/src/stores/chat.ts'))
  check(
    '★ 手动设定走 preload 白名单（window.api.setGrade），不经本地直接改状态',
    /lookup\.bridge\.setGrade\s*\(|api\.setGrade\s*\(/.test(chatStoreSource),
    'stores/chat.ts 里 setGrade 必须调桥上的方法（渲染进程不直连 sidecar、不自己算学段）'
  )
  check(
    '发送链路不传学段（sendChat 只带 text）',
    /sendChat\(\{\s*text\s*\}\)/.test(chatStoreSource) && !/sendChat\(\{[^}]*gradeLevel/.test(chatStoreSource),
    'stores/chat.ts 里 sendChat 的入参只有 { text }'
  )

  /*
   * ★ 教材章节（D-038）：与学段**同一套纪律**，只是换了对象。
   *
   * 章节是学生的**显式选择**（不是「说话顺带产生的」），所以：
   *   ① 写入口只有一条 —— store 的 `chat.setChapter` → `window.api.setChapter`（preload 白名单）；
   *   ② 两个界面入口（对话页指示器 + 设置页区块）**共用**那一条，不各写一份；
   *   ③ 界面文件里**不出现通道名字面量**（通道名只在 `main/ipc/channels.ts`，守卫 G8）；
   *   ④ 章节目录复用既有的 `study:chapters` 取数路径（`loadChapters`），没有第二条。
   *      —— ③④ 这两条才是这套东西真正会退化的地方：随手 `import { IPC }` 或
   *      再加一条「章节专用」取数通道，都不会有测试红，只会悄悄多出一份真相。
   */
  const chapterSources = [
    ...rendererSources,
    'src/renderer/src/components/ChapterIndicator.vue',
    'src/renderer/src/api/chapter.ts'
  ]
  const chapterText = chapterSources.map((path) => stripComments(readSource(path))).join('\n')
  const chapterSetCallers = chapterSources.filter((path) =>
    /\.setChapter\s*\(/.test(stripComments(readSource(path)))
  )
  check(
    '★ 章节写入经 store 的 setChapter（两个入口共用同一条，不各写一份）',
    chapterSetCallers.includes('src/renderer/src/stores/chat.ts') &&
      chapterSetCallers.includes('src/renderer/src/components/ChapterIndicator.vue') &&
      chapterSetCallers.includes('src/renderer/src/views/Settings.vue'),
    `调用点：${chapterSetCallers.join('、') || '（一个都没有）'}`
  )
  check(
    '★ 章节写入走 preload 白名单（window.api.setChapter），界面不直接持有通道',
    /lookup\.bridge\.setChapter\s*\(/.test(chatStoreSource) && !/'chapter:(get|set|changed)'/.test(chapterText),
    'stores/chat.ts 里 setChapter 调桥上的方法；界面文件里没有通道名字面量'
  )
  check(
    '章节清单复用既有取数路径（没有「章节专用」的第二条取数通道）',
    !/'chapter:(list|chapters|overview)'/.test(chapterText) &&
      /studyChapters|loadChapters/.test(
        chapterSources.filter((path) => path.includes('ChapterIndicator') || path.includes('Settings')).map((path) => stripComments(readSource(path))).join('\n')
      ),
    '章节清单走 study:chapters（loadChapters），界面没有新增取数通道'
  )
}

/* ------------------------------------------------------------------ *
 * CDP 客户端
 * ------------------------------------------------------------------ */

async function findPageTarget() {
  let response
  try {
    response = await fetch(listUrl)
  } catch (error) {
    scriptError(
      `连不上 CDP（${listUrl}）：${String(error)}\n` +
        `请带调试端口启动应用，例如：K12_DEBUG_PORT=${debugBase} npm run dev`
    )
  }
  if (!response.ok) {
    scriptError(`CDP 目标列表返回 HTTP ${response.status}（${listUrl}）`)
  }

  const targets = await response.json()
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (pages.length === 0) {
    scriptError(`CDP 里没有可用页面目标（共 ${targets.length} 个目标）：${JSON.stringify(targets.map((t) => t.type))}`)
  }
  // 优先应用窗口，避开 DevTools 自身的页面
  return pages.find((page) => !page.url.startsWith('devtools://')) ?? pages[0]
}

function createClient(socket, onEvent) {
  const pending = new Map()
  let nextId = 1

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.id === undefined) {
      onEvent?.(message)
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`CDP 错误：${JSON.stringify(message.error)}`))
    else entry.resolve(message.result)
  })

  return function send(method, params) {
    const id = nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP 命令超时（${method}，${commandTimeoutMs}ms）`))
      }, commandTimeoutMs)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolvePromise(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      socket.send(payload)
    })
  }
}

const target = await findPageTarget()
console.log(`\nCDP 目标：${target.title || '(无标题)'} · ${target.url}`)
const isDevServer = /^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(target.url)

const socket = new WebSocket(target.webSocketDebuggerUrl)
const send = createClient(socket, (message) => {
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails
    pageErrors.push(`未捕获异常：${details?.exception?.description ?? details?.text ?? '未知'}`)
  }
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
    const entry = message.params.entry
    if (entry.source !== 'network') pageErrors.push(`控制台错误：${entry.text}`)
  }
})

await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), commandTimeoutMs)
  socket.addEventListener('open', () => {
    clearTimeout(timer)
    resolvePromise()
  })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    reject(new Error('WebSocket 连接失败'))
  })
}).catch((error) => {
  scriptError(`${String(error)}（${target.webSocketDebuggerUrl}）`)
})

/** 在页面里求值并取回 JSON 结果。 */
async function evaluate(expression) {
  const evaluated = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (evaluated?.exceptionDetails) {
    throw new Error(`页面执行异常：${evaluated.exceptionDetails.text ?? JSON.stringify(evaluated.exceptionDetails)}`)
  }
  return evaluated?.result?.value
}

// 订阅控制台/异常事件（要在交互之前打开，才能把整轮交互期间的报错都收到）
try {
  await send('Runtime.enable')
  await send('Log.enable')
} catch (error) {
  info(`打开控制台监听失败（不影响其余断言）：${describe(error)}`)
}

/** 轮询一个布尔表达式直到为真（超时抛错，由外层计为断言失败）。 */
async function waitFor(expression, description, timeoutMs = noKeyTimeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (last) return last
    await delay(120)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${description}；最后一次求值 = ${JSON.stringify(last)}`)
}

/** 第 index 轮的状态与内容快照（全部来自真实 DOM 文本）。 */
function turnSnapshotExpression(index) {
  return `(() => {
    const turns = document.querySelectorAll('[data-testid="chat-turn"]')
    const turn = turns[${index}]
    if (!turn) return null
    const text = (sel) => {
      const el = turn.querySelector(sel)
      return el && el.textContent ? el.textContent.trim() : ''
    }
    const textEl = turn.querySelector('[data-testid="assistant-text"]')
    const chips = turn.querySelectorAll('[data-testid="citation-chip"]')
    return {
      status: turn.getAttribute('data-status') || '',
      text: textEl && textEl.textContent ? textEl.textContent : '',
      citations: chips.length,
      compatCitations: turn.querySelectorAll('[data-testid="citation-compat"]').length,
      // ★ 标签的**文字**也要带回来：只数节点数的话，「渲染出来了但全是空标签」也会通过。
      citationLabels: Array.from(chips).map((chip) => (chip.textContent || '').replace(/\\s+/g, ' ').trim()),
      // ★ 卡片 kind 取自**卡片容器的直接子节点**的 testid（animation-card / coding-card / quiz-card）。
      //   旧写法查的是 [data-testid="inline-card"] + data-kind —— 那套标记只存在于
      //   InlineCard.vue 的「未识别 kind」占位分支里，该分支不可达、已被删除；
      //   于是这个选择器恒不匹配，cardKinds 恒为空数组，下面的合法性断言**空过**。
      //   ⚠️ 不能直接查 [data-testid$="-card"]：progress-card / quiz-result-card
      //   是 QuizCard **内部**的嵌套节点，会被一起数进来（一张练习卡能出 2~3 个）。
      //   卡片容器（inline-cards）的直接子节点才是「一轮里画了几张卡」，且每个卡组件都是单根 <article>。
      cardKinds: Array.from(turn.querySelectorAll('[data-testid="inline-cards"] > *')).map(
        (card) => (card.getAttribute('data-testid') || '').replace(/-card$/, '')
      ),
      cardCount: turn.querySelectorAll('[data-testid="inline-cards"] > *').length,
      quizCards: turn.querySelectorAll('[data-testid="quiz-card"]').length,
      blockedText: text('[data-testid="blocked-notice"]'),
      errorBadge: text('[data-testid="error-badge"]'),
      errorText: text('[data-testid="error-text"]'),
      statusLabel: text('[data-testid="turn-status"]'),
      userText: text('[data-testid="user-message"]')
    }
  })()`
}

/** 在输入框里填字并点发送（走真实 DOM 事件，和学生的操作一样）。 */
async function sendMessage(text) {
  const filled = await evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]')
    if (!input) return false
    input.value = ${JSON.stringify(text)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!filled) throw new Error('找不到输入框（[data-testid=composer-input]）')

  await waitFor(
    `(() => { const b = document.querySelector('[data-testid="composer-send"]'); return !!b && !b.disabled })()`,
    '发送按钮变为可用（v-model 更新后才会解除 disabled）',
    10_000
  )
  const clicked = await evaluate(
    `(() => { const b = document.querySelector('[data-testid="composer-send"]'); if (!b) return false; b.click(); return true })()`
  )
  if (!clicked) throw new Error('点不到发送按钮（[data-testid=composer-send]）')
}

/** 轮次数量。 */
async function turnCount() {
  return await evaluate(`(() => document.querySelectorAll('[data-testid="chat-turn"]').length)()`)
}

/**
 * 采样本轮正文长度直到本轮不再是 streaming（用来证明「是流，不是一次性插入」）。
 */
async function collectUntilTerminal(index, timeoutMs) {
  const samples = []
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await evaluate(turnSnapshotExpression(index))
    if (snapshot) {
      samples.push(snapshot.text.length)
      if (snapshot.status && snapshot.status !== 'streaming') return { samples, snapshot, timedOut: false }
    }
    await delay(120)
  }
  return { samples, snapshot, timedOut: true }
}

const looksLikeStack = (text) => STACK_PATTERNS.some((pattern) => pattern.test(text))

/* ------------------------------------------------------------------ *
 * B. 外壳 / 白名单 / 布局（始终执行）
 * ------------------------------------------------------------------ */

console.log('\n== B. 外壳、preload 白名单与布局 ==')

// 应用可能刚启动（页面还在挂载），先等外壳与 preload 就绪再探测，
// 否则会把「还没渲染完」误报成「布局缺失」。
try {
  await waitFor(
    `(() => document.readyState === 'complete' && typeof window.api === 'object' && !!document.querySelector('[data-testid="chat-area"]'))()`,
    '应用外壳与 preload 就绪',
    20_000
  )
} catch (error) {
  info(`等待外壳就绪超时（继续探测并给出细节）：${describe(error)}`)
}

const PAGE_PROBE = `(() => {
  const el = document.querySelector('[data-testid="sidecar-status"]')
  const api = window.api
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').trim()
  const apiKeys = api && typeof api === 'object' ? Object.keys(api).sort() : []
  return {
    readyState: document.readyState,
    title: document.title,
    bodyTextLength: bodyText.length,
    bodyTextPreview: bodyText.slice(0, 120),
    hasUfffd: bodyText.includes('\\uFFFD'),
    apiType: typeof api,
    apiKeys,
    apiNonFunctions: api && typeof api === 'object'
      ? apiKeys.filter((key) => typeof api[key] !== 'function')
      : [],
    leakedGlobals: ${JSON.stringify(LEAKY_GLOBALS)}.filter((name) => typeof window[name] !== 'undefined'),
    hasChatArea: !!document.querySelector('[data-testid="chat-area"]'),
    hasChatLog: !!document.querySelector('[data-testid="chat-log"]'),
    hasComposer: !!document.querySelector('[data-testid="composer-input"]'),
    hasSendButton: !!document.querySelector('[data-testid="composer-send"]'),
    hasViewEntry: !!document.querySelector('[data-testid="view-entry"]'),
    hasStudyView: !!document.querySelector('[data-testid="study-view"]'),
    statusText: el && el.textContent ? el.textContent.trim().replace(/\\s+/g, '') : '',
    statusPhase: el ? el.getAttribute('data-phase') || '' : '',
    errorText: (() => {
      const err = document.querySelector('[data-testid="sidecar-error"]')
      return err && err.textContent ? err.textContent.trim().slice(0, 200) : ''
    })()
  }
})()`

let probe
try {
  probe = await evaluate(PAGE_PROBE)
} catch (error) {
  scriptError(`Runtime.evaluate 失败：${describe(error)}`)
}
if (!probe || typeof probe !== 'object') {
  scriptError(`页面探测没有返回预期对象：${JSON.stringify(probe)}`)
}

/*
 * ★ 前置条件自愈：**必须从对话页开始**。
 *
 * 下面 B 层的布局断言（chat-area / chat-log / composer）以及 C 层的「顶栏按钮循环」
 * （对话 → 学习档案 → 设置 → 对话）都假定应用此刻停在对话页。如果上一轮手工探针或
 * 别的证据采集把界面留在设置页，这个假定就静默不成立：布局断言报「找不到 chat-area」，
 * 之后的循环点击还会因为读不到 view-entry 直接抛异常 —— 两条**看起来像产品坏了**的失败，
 * 实际只是起点不对。所以这里先把它转回对话页再说。
 *
 * 最多点 3 次（循环一圈就是三站：对话 → 学习档案 → 设置 → 对话）；点不动就如实记下来，
 * 不假装成功 —— 那属于真问题（顶栏接线断了）。
 */
if (!probe.hasChatArea) {
  let recovered = false
  for (let attempt = 0; attempt < 3 && !recovered; attempt += 1) {
    const clicked = await evaluate(`(() => {
      const entry = document.querySelector('[data-testid="view-entry"]')
      if (!entry) return false
      entry.click()
      return true
    })()`)
    if (clicked !== true) break
    await new Promise((resolve) => setTimeout(resolve, 250))
    recovered = await evaluate(`(() => !!document.querySelector('[data-testid="chat-area"]'))()`)
  }
  if (recovered) {
    info('起点不在对话页 —— 已自动切回（否则 B/C 两组断言会因为起点不对而假红）')
    probe = await evaluate(PAGE_PROBE)
  } else {
    info('起点不在对话页，且「视图切换」按钮转不回来：下面的布局断言会如实失败')
  }
}

check(
  '页面已渲染（body 有文本，不是白屏）',
  probe.bodyTextLength > 0,
  `body 文本长度 ${probe.bodyTextLength}${probe.bodyTextPreview ? `，开头：「${probe.bodyTextPreview}」` : ''}（readyState=${probe.readyState}）`
)
// ★ 窗口标题必须等于品牌名（`brand.ts` 的 `BRAND_NAME`）。
//   这里原先断言的是「包含 K12」—— 品牌名从「K12 AI 教学助手」改成「智团团」之后，
//   这条断言就成了**过期的期望**（而它守的东西其实已经有更强的守卫：
//   `tests/brand.test.ts` 断言 index.html 的 <title> 与 BRAND_NAME 逐字相等）。
//   所以这里改成「非空 + 与主进程品牌一致」之外的最小形态：非空且不含占位符。
check(
  '窗口标题是品牌名（非空、非模板占位）',
  String(probe.title).trim().length > 0 && !String(probe.title).includes('{{'),
  `document.title = "${probe.title}"（与 brand.ts 的 BRAND_NAME 逐字一致性由 tests/brand.test.ts 断言）`
)

check(
  'window.api 已注入且必需方法齐备',
  probe.apiType === 'object' && REQUIRED_API_METHODS.every((name) => probe.apiKeys.includes(name)),
  `实际方法：${probe.apiKeys.join(', ') || '(空)'}；必需：${REQUIRED_API_METHODS.join(', ')}`
)

check(
  'window.api 上全是函数（没有把数据/对象直接漏出去）',
  Array.isArray(probe.apiNonFunctions) && probe.apiNonFunctions.length === 0,
  probe.apiNonFunctions?.length === 0 ? `${probe.apiKeys.length} 个成员都是函数` : `非函数成员：${probe.apiNonFunctions.join(', ')}`
)

check(
  'window.api 没有通用 IPC 口子（白名单之外的能力一律不存在）',
  FORBIDDEN_API_METHODS.every((name) => !probe.apiKeys.includes(name)),
  `实际方法：${probe.apiKeys.join(', ')}`
)

check(
  '渲染进程没有 Node / Electron 通用口子（只应有 window.api）',
  probe.leakedGlobals.length === 0,
  probe.leakedGlobals.length === 0
    ? `${LEAKY_GLOBALS.join(' / ')} 均不可见`
    : `可见：${probe.leakedGlobals.join(', ')}`
)

check(
  '对话优先布局到位（对话区 / 消息区 / 输入框 / 发送按钮 / 视图切换入口）',
  probe.hasChatArea && probe.hasChatLog && probe.hasComposer && probe.hasSendButton && probe.hasViewEntry,
  `chat-area=${probe.hasChatArea}，chat-log=${probe.hasChatLog}，composer=${probe.hasComposer}，send=${probe.hasSendButton}，view-entry=${probe.hasViewEntry}`
)

// ★ 顶栏按钮按「对话 → 学习档案 → 设置 → 对话」循环（顺序的唯一来源是 `stores/ui.ts`）。
//   这里真的点两下走完整圈，并断言每一站都到位 —— 只看按钮在不在，
//   抓不住「点了没反应」那种断线（顶栏按钮的 handler 曾整条漏接）。
try {
  const clickEntry = `(() => { document.querySelector('[data-testid="view-entry"]').click(); return true })()`
  await evaluate(clickEntry)
  const openedStudy = await waitFor(
    `(() => !!document.querySelector('[data-testid="study-view"]'))()`,
    '学习档案视图出现',
    5000
  )
  // 档案页里的五个分页按钮都应当在（报告 / 错题本 / 章节进度 / 学习地图 / 历史会话）
  const studyTabs = await evaluate(`(() => {
    const ids = ['report', 'mistakes', 'chapters', 'map', 'sessions']
    return ids.filter((id) => !!document.querySelector('[data-testid="study-tab-' + id + '"]'))
  })()`)
  const allTabs = Array.isArray(studyTabs) && studyTabs.length === 5

  await evaluate(clickEntry)
  const openedSettings = await waitFor(
    `(() => !!document.querySelector('[data-testid="settings-view"]'))()`,
    '设置视图出现',
    5000
  )
  // ★ 设置页的学段区块（第二个手动入口）：必须**在设置页里**就能看到当前值与四档，
  //   而不是只有对话页顶栏那一个入口 —— 两处入口共享同一个 store action（见 A 层静态断言）。
  const settingsGrade = await evaluate(`(() => {
    const block = document.querySelector('[data-testid="settings-grade-block"]')
    if (!block) return { present: false }
    const buttons = Array.from(document.querySelectorAll('[data-testid^="settings-grade-option-"]'))
    return {
      present: true,
      levels: buttons.map((b) => (b.getAttribute('data-testid') || '').replace('settings-grade-option-', '')),
      allHaveActive: buttons.every((b) => b.getAttribute('data-active') !== null),
      activeCount: buttons.filter((b) => b.getAttribute('data-active') === 'true').length,
      sourceText: (block.querySelector('[data-testid="settings-grade-source"]') || {}).textContent || '',
      // 只读的那一行（诊断卡片里）仍在，别为了新区块把它删了
      hasReadonlyRow: !!document.querySelector('[data-testid="settings-grade"]')
    }
  })()`)

  // ★ 设置页的章节区块（第二个入口，D-038）：与学段区块**并列**的显式选择。
  //   这里只断言「区块在位 + 当前章节可读 + 说清了与学段的关系」；
  //   真正点一章落库的端到端在 C3（两个入口共用同一条写路径，点哪儿效果一样）。
  //   ⚠️ 必须**在切回对话页之前**读 —— 这条曾经读成 undefined：探针写在第三次
  //      `clickEntry`（回对话）之后，那时设置页已经不在 DOM 里了。
  const settingsChapter = await evaluate(`(() => {
    const block = document.querySelector('[data-testid="settings-chapter-block"]')
    if (!block) return { present: false }
    const buttons = Array.from(document.querySelectorAll('[data-testid^="settings-chapter-option-"]'))
    const text = (sel) => {
      const el = block.querySelector(sel)
      return el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : ''
    }
    return {
      present: true,
      lineText: text('[data-testid="settings-chapter-line"]'),
      optionCount: buttons.length,
      allHaveActive: buttons.every((b) => b.getAttribute('data-active') !== null),
      activeCount: buttons.filter((b) => b.getAttribute('data-active') === 'true').length,
      hintText: text('[data-testid="settings-chapter-hint"]'),
      noGradeText: text('[data-testid="settings-chapter-no-grade"]')
    }
  })()`)

  await evaluate(clickEntry)
  const backToChat = await waitFor(
    `(() => !!document.querySelector('[data-testid="chat-area"]') && !document.querySelector('[data-testid="settings-view"]'))()`,
    '返回对话视图',
    5000
  )
  check(
    '三态视图入口可进可出（对话 → 学习档案 → 设置 → 对话）',
    openedStudy === true && openedSettings === true && backToChat === true,
    `学习档案=${openedStudy}，设置=${openedSettings}，返回对话=${backToChat}`
  )
  check(
    '学习档案五个分页都在（报告 / 错题本 / 章节进度 / 学习地图 / 历史会话）',
    allTabs,
    allTabs ? '五个分页按钮齐备' : `缺：${JSON.stringify(studyTabs)}`
  )
  check(
    '★ 设置页有学段区块（四档可点，且标出当前生效那一档）',
    settingsGrade?.present === true &&
      (settingsGrade?.levels ?? []).length === 4 &&
      settingsGrade?.allHaveActive === true &&
      (settingsGrade?.activeCount ?? 0) <= 1,
    settingsGrade?.present === true
      ? `选项=[${(settingsGrade?.levels ?? []).join(', ')}]，标出生效的档数=${settingsGrade?.activeCount}，当前：${String(settingsGrade?.sourceText).replace(/\s+/g, ' ').trim()}`
      : '没找到 [data-testid=settings-grade-block]'
  )
  check(
    '设置页的只读那行仍在（新区块是**新增**，不是替换）',
    settingsGrade?.hasReadonlyRow === true,
    `[data-testid=settings-grade] 在位=${settingsGrade?.hasReadonlyRow}`
  )

  // ★ 设置页的章节区块（第二个入口，D-038）：与学段区块**并列**的显式选择。
  //   这里只断言「区块在位 + 当前章节可读 + 说清了与学段的关系」；
  //   真正点一章落库的端到端在 C3（两个入口共用同一条写路径，点哪儿效果一样）。
  //   ⚠️ 必须**在切回对话页之前**读 —— 这条曾经读成 undefined：探针写在第三次
  //      `clickEntry`（回对话）之后，那时设置页已经不在 DOM 里了。
  check(
    '★ 设置页有章节区块（当前章节可读；选得出时标出生效那一章）',
    settingsChapter?.present === true &&
      String(settingsChapter?.lineText).length > 0 &&
      settingsChapter?.allHaveActive !== false &&
      (settingsChapter?.activeCount ?? 0) <= 1,
    settingsChapter?.present === true
      ? `当前：${settingsChapter.lineText}；选项数=${settingsChapter.optionCount}；标出生效的章数=${settingsChapter.activeCount}` +
        (settingsChapter.noGradeText ? `；未判定学段提示=「${settingsChapter.noGradeText}」` : '')
      : '没找到 [data-testid=settings-chapter-block]'
  )
  check(
    '★ 设置页章节区块写明「选择章节不会改变学段」（两件事各自独立）',
    String(settingsChapter?.hintText).includes('不会改变学段'),
    `说明文案：「${String(settingsChapter?.hintText).slice(0, 90)}」`
  )
} catch (error) {
  check('设置入口可进可出（对话优先布局）', false, describe(error))
}

check(
  'sidecar 状态文案属于预期阶段',
  EXPECTED_PHASE_TEXT.includes(probe.statusText),
  `data-phase="${probe.statusPhase}"，文案="${probe.statusText || '(未找到 [data-testid=sidecar-status])'}"，期望其中之一：${EXPECTED_PHASE_TEXT.join(' / ')}`
)
check(
  'sidecar data-phase 取值合法',
  EXPECTED_PHASE_ATTR.includes(probe.statusPhase),
  `data-phase="${probe.statusPhase}"，期望其中之一：${EXPECTED_PHASE_ATTR.join(' / ')}`
)
if (probe.errorText) info(`页面上的错误行：「${probe.errorText}」`)

/* ------------------------------------------------------------------ *
 * B2. 是否已配置 API Key（决定后面走哪个世界）
 * ------------------------------------------------------------------ */

const keyProbe = await evaluate(`(async () => {
  if (!window.api || typeof window.api.readSettings !== 'function') {
    return { ok: false, reason: 'preload 没有 readSettings（设置通道未接线）' }
  }
  try {
    const result = await window.api.readSettings()
    if (!result || !result.ok) return { ok: false, reason: (result && result.message) || '读取设置失败' }
    const llm = result.data && result.data.llm ? result.data.llm : {}
    return { ok: true, hasKey: llm.hasKey === true, modelId: llm.modelId || '', baseUrl: llm.baseUrl || '' }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`)

let hasKey = false
let keyReason = ''
if (FORCED_HAS_KEY === '1' || FORCED_HAS_KEY === '0') {
  hasKey = FORCED_HAS_KEY === '1'
  keyReason = `环境变量 K12_VERIFY_HAS_KEY=${FORCED_HAS_KEY} 强制指定`
} else if (keyProbe?.ok) {
  hasKey = keyProbe.hasKey === true
  keyReason = `主进程读设置：hasKey=${keyProbe.hasKey}${keyProbe.modelId ? `，modelId=${keyProbe.modelId}` : ''}`
} else {
  keyReason = `读设置不可用（${keyProbe?.reason ?? '未知原因'}）→ 按「无 Key」处理`
}
info(`API Key 判定：${hasKey ? '已配置' : '未配置'}（${keyReason}）`)

/* ------------------------------------------------------------------ *
 * C. 学段指示器 + 两个手动入口（始终执行）
 *
 * ★ 2026-09-17 翻转：人工入口回来了（学段手动切换，D-037）。旧版断言「内部没有任何控件」
 *   「grade-selector 不存在」描述的是 D-020 的世界；现在测的是新设计的真不变量：
 *   选项**默认收起**（学生不点就看不见控件），点开后四档都在且可点。
 * ------------------------------------------------------------------ */

console.log('\n== C. 学段指示器与手动入口（默认收起，点开可指定）==')

const gradeProbe = await evaluate(`(() => {
  const indicator = document.querySelector('[data-testid="grade-indicator"]')
  if (!indicator) return { present: false }
  const text = (sel) => {
    const el = indicator.querySelector(sel)
    return el && el.textContent ? el.textContent.trim() : ''
  }
  const options = document.querySelector('[data-testid="grade-options"]')
  const optionButtons = Array.from(
    document.querySelectorAll('[data-testid^="grade-option-"]')
  )
  return {
    present: true,
    determined: indicator.getAttribute('data-determined') || '',
    grade: indicator.getAttribute('data-grade') || '',
    origin: indicator.getAttribute('data-origin') || '',
    badgeText: text('[data-testid="grade-current-label"]'),
    originText: text('[data-testid="grade-origin-label"]'),
    hintText: text('[data-testid="grade-indicator-hint"]'),
    noticeText: text('[data-testid="grade-notice"]'),
    // ★ 2026-09-25：顶栏那两张「切换学段」浮动纸条已彻底去掉，节点本身不该再存在。
    hasNoticeNode: document.querySelector('[data-testid="grade-notice"]') !== null,
    hasNoticeDetailNode: document.querySelector('[data-testid="grade-notice-detail"]') !== null,
    missingChannelNote: text('[data-testid="grade-indicator-note"]'),
    // ★ 默认收起：这里必须是 false（不点开就没有选项列表、也没有任何选项按钮）
    optionsVisibleBeforeClick: options !== null,
    optionCountBeforeClick: optionButtons.length,
    // 触发器必须存在且可点
    hasTrigger: !!document.querySelector('[data-testid="grade-set"]'),
    triggerDisabled: document.querySelector('[data-testid="grade-set"]')?.disabled === true,
    // 旧世界的遗物：这套产物已经不存在了，出现即说明有人在往回写
    hasLegacySelector: !!document.querySelector('[data-testid="grade-selector"]'),
    hasLegacyOption: !!document.querySelector('[data-testid="grade-option"]')
  }
})()`)

if (gradeProbe?.present !== true) {
  check(
    '学段指示器在位（[data-testid=grade-indicator]）',
    false,
    '没找到指示器：学段判定结果必须在界面上可见，否则适配发生了也看不出来'
  )
} else {
  check('学段指示器在位（[data-testid=grade-indicator]）', true, `data-grade="${gradeProbe.grade}"，data-origin="${gradeProbe.origin}"`)
  check(
    '★ 选项**默认收起**（不点开时没有 grade-options、也没有任何选项按钮）',
    gradeProbe.optionsVisibleBeforeClick === false && gradeProbe.optionCountBeforeClick === 0,
    `默认可见列表=${gradeProbe.optionsVisibleBeforeClick}，默认选项数=${gradeProbe.optionCountBeforeClick}`
  )
  check(
    '★ 有「自己指定学段」的展开按钮（且默认可用）',
    gradeProbe.hasTrigger && gradeProbe.triggerDisabled === false,
    `按钮在位=${gradeProbe.hasTrigger}，初始禁用=${gradeProbe.triggerDisabled}`
  )
  check(
    '旧世界的选择器遗物不存在（grade-selector / grade-option）',
    gradeProbe.hasLegacySelector === false && gradeProbe.hasLegacyOption === false,
    `grade-selector=${gradeProbe.hasLegacySelector}，grade-option=${gradeProbe.hasLegacyOption}`
  )
  check(
    '指示器文案可读（四学段中文名之一，或「还没认出年级」）',
    GRADE_LABELS.includes(gradeProbe.badgeText) || gradeProbe.badgeText === GRADE_UNKNOWN_LABEL,
    `显示「当前：${gradeProbe.badgeText}」；旁边说明「${gradeProbe.hintText}」`
  )
  check(
    '★ 来源标签说清了「怎么定下来的」（手动选中 / AI 引擎判定 / 本地规则判定）',
    // 未判定时不显示这句（还没定下来的东西没有「怎么定下来的」可言），
    // 所以判据分两支：判出来了必须有来源标签；没判出来必须**没有**。
    gradeProbe.grade === ''
      ? gradeProbe.originText === ''
      : ['手动选中', 'AI 引擎判定', '本地规则判定'].includes(gradeProbe.originText),
    `data-grade="${gradeProbe.grade}"，来源标签「${gradeProbe.originText}」`
  )
  check(
    'data-determined 与 data-grade 自洽（判出来才有学段）',
    // ★ 修 bug（2026-09-16）：原来拿**中文名**数组（GRADE_LABELS）去判 `data-grade`，
    //   而 `data-grade` 是机器字面量（`junior`）—— 两边取值域不同，这条断言**永远通过**，
    //   属于「假绿」。学段推断修好、`data-grade` 真的有值之后才暴露出来。
    //   现在两边各自比对自己的取值域，并额外断言「中文名与机器字面量指向同一档」。
    (gradeProbe.determined === 'true') === GRADE_LEVELS.includes(gradeProbe.grade),
    `data-determined="${gradeProbe.determined}"，data-grade="${gradeProbe.grade}"`
  )
  check(
    'data-grade 与徽章文案指向同一档学段（机器字面量 ↔ 中文名）',
    GRADE_LEVELS.indexOf(gradeProbe.grade) === GRADE_LABELS.indexOf(gradeProbe.badgeText),
    `data-grade="${gradeProbe.grade}" ↔ 徽章「${gradeProbe.badgeText}」`
  )
  check(
    '★ 顶栏不再有「切换学段」浮动纸条（grade-notice / grade-notice-detail 节点都不存在）',
    // ★ 2026-09-25 用户口径「把这两个弹出提示彻底去掉」：这两张纸条是**浮**在内容之上、
    //   出现在每一页的通知，层级放错了。学段生效的证据是 chip 上的值本身（上面几条已验）。
    gradeProbe.hasNoticeNode === false && gradeProbe.hasNoticeDetailNode === false,
    `grade-notice=${gradeProbe.hasNoticeNode}，grade-notice-detail=${gradeProbe.hasNoticeDetailNode}`
  )

  // ── 展开后四档都在（点一下就真的点开了）──
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('[data-testid="grade-set"]')
    if (!trigger) return { clicked: false }
    trigger.click()
    return { clicked: true }
  })()`)
  if (opened?.clicked !== true) {
    check('★ 点「自己指定学段」后展开四档选项', false, '找不到触发器，无法展开')
  } else {
    // Vue 的下一次 DOM 更新在微任务里；给一帧
    await new Promise((resolve) => setTimeout(resolve, 120))
    const expanded = await evaluate(`(() => {
      const list = document.querySelector('[data-testid="grade-options"]')
      const buttons = Array.from(document.querySelectorAll('[data-testid^="grade-option-"]'))
      return {
        listVisible: list !== null,
        levels: buttons.map((b) => (b.getAttribute('data-testid') || '').replace('grade-option-', '')),
        // 每档都必须带 data-active（当前生效的那档为 true），学生才知道自己现在在哪一档
        allHaveActive: buttons.every((b) => b.getAttribute('data-active') !== null),
        activeCount: buttons.filter((b) => b.getAttribute('data-active') === 'true').length
      }
    })()`)
    check(
      '★ 点「自己指定学段」后展开四档选项',
      expanded?.listVisible === true && expanded.levels.length === 4,
      `列表可见=${expanded?.listVisible}，选项=[${(expanded?.levels ?? []).join(', ')}]`
    )
    check(
      '四档机器字面量与 GRADE_LEVELS 一致（不是中文名冒充 data 值）',
      JSON.stringify([...(expanded?.levels ?? [])].sort()) === JSON.stringify([...GRADE_LEVELS].sort()),
      `选项=[${(expanded?.levels ?? []).join(', ')}]`
    )
    check(
      '★ 当前生效那一档被标出来（data-active 可读，至多一档为 true）',
      expanded?.allHaveActive === true && (expanded?.activeCount ?? 0) <= 1,
      `每档都有 data-active=${expanded?.allHaveActive}，被标为生效的档数=${expanded?.activeCount}`
    )
  }

  if (gradeProbe.grade === '' && gradeProbe.missingChannelNote) {
    info(
      '学段判定通道尚未接线（指示器显示「还没认出年级」）：' +
        `${gradeProbe.missingChannelNote.slice(0, 80)}… —— 需要主进程提供 grade:changed 推送（见 src/renderer/src/api/grade.ts 的通道说明）`
    )
  }

  /* ---------------------------------------------------------------- *
   * C2. ★★ 端到端：真的点一档，看它有没有落到服务端
   *
   * 前面几条只证明「按钮在那里、点得开」。这一条**真的点一个学段**，然后断言
   * 界面上发生了只有「服务端真的写了库、主进程把结果推回来」才可能出现的变化：
   *   ① `data-origin` 变成 `explicit`（来源标签认这个值 → 说明读的是服务端 source，
   *      不是前端自己改的本地状态）；
   *   ② 出现「已按你选的X来讲。」的一次性回执（只有成功路径才有这句话）；
   *   ③ 选项列表自动收起（成功才收，失败会留着让重试）。
   *
   * ★ 为什么值得单独做一条：这条链路跨了四层（组件 → store → preload IPC → 主进程 HTTP
   *   → Python 写 learning.db → 回程推送），而每一层的失败形态都是**静默**的 ——
   *   任何一层断线，界面上都只是「点了没反应」，前面那些断言一条都不会红。
   *
   * ⚠️ 它**会改这台机器上的学段**（写进学生的 learning.db）。这是有意的：验证的就是
   *   「写进去了没有」。选一个与当前值不同的档，是因为切到同一档 `changed=false`，
   *   拿不到「值真的变了」这条证据。
   * ---------------------------------------------------------------- */
  if (process.env.K12_SKIP_GRADE_SET !== '1') {
    const before = gradeProbe.grade
    // 挑一个与当前不同的档（当前没判出来时就用初中）
    const target = GRADE_LEVELS.find((level) => level !== before) ?? 'junior'
    const targetLabel = GRADE_LABELS[GRADE_LEVELS.indexOf(target)]

    // 先确保列表是展开的（上一条断言可能已经把它展开；这里幂等地点一下触发器）
    await evaluate(`(() => {
      const trigger = document.querySelector('[data-testid="grade-set"]')
      if (trigger && !document.querySelector('[data-testid="grade-options"]')) trigger.click()
      return true
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const clicked = await evaluate(`(() => {
      const button = document.querySelector('[data-testid="grade-option-${target}"]')
      if (!button) return { ok: false, reason: '选项按钮不在' }
      if (button.disabled) return { ok: false, reason: '选项被禁用（流式中？）' }
      button.click()
      return { ok: true }
    })()`)

    if (clicked?.ok !== true) {
      check(
        `★★ 点「${targetLabel}」后学段真的写进服务端并回到界面`,
        false,
        `点不了：${clicked?.reason ?? '未知原因'}`
      )
    } else {
      let applied = null
      try {
        applied = await waitFor(
          `(() => {
            const indicator = document.querySelector('[data-testid="grade-indicator"]')
            if (!indicator) return false
            return indicator.getAttribute('data-grade') === '${target}' &&
              indicator.getAttribute('data-origin') === 'explicit'
          })()`,
          `学段切到 ${target}（data-origin=explicit）`,
          // 四层链路 + 一次 HTTP：比纯 DOM 断言慢，给足预算
          12_000
        )
      } catch (error) {
        applied = false
        info(`等待学段切换超时：${describe(error)}`)
      }

      const after = await evaluate(`(() => {
        const indicator = document.querySelector('[data-testid="grade-indicator"]')
        const text = (sel) => {
          const el = document.querySelector(sel)
          return el && el.textContent ? el.textContent.trim() : ''
        }
        return {
          grade: indicator ? indicator.getAttribute('data-grade') || '' : '',
          origin: indicator ? indicator.getAttribute('data-origin') || '' : '',
          originText: text('[data-testid="grade-origin-label"]'),
          noticeText: text('[data-testid="grade-notice"]'),
          // ★ 2026-09-25：顶栏两张浮动纸条已去掉 —— 这里验的是「点了之后也没冒出来」
          hasNoticeNode: document.querySelector('[data-testid="grade-notice"]') !== null,
          hasNoticeDetailNode: document.querySelector('[data-testid="grade-notice-detail"]') !== null,
          errorText: text('[data-testid="grade-set-error"]'),
          optionsStillOpen: !!document.querySelector('[data-testid="grade-options"]')
        }
      })()`)

      check(
        `★★ 点「${targetLabel}」后学段真的写进服务端并回到界面（data-grade=${target} / data-origin=explicit）`,
        applied === true,
        `data-grade="${after?.grade}"，data-origin="${after?.origin}"，来源标签「${after?.originText}」` +
          (after?.errorText ? `，界面报错：「${after.errorText}」` : '')
      )
      check(
        '★ 手动切换后来源标签说「手动选中」（证明读的是服务端 source，不是本地猜的）',
        after?.originText === '手动选中',
        `来源标签「${after?.originText}」`
      )
      check(
        '★ 点完后顶栏也不冒纸条（学段生效的证据就是 chip 上的值，不靠通知）',
        after?.hasNoticeNode === false && after?.hasNoticeDetailNode === false,
        `grade-notice=${after?.hasNoticeNode}，grade-notice-detail=${after?.hasNoticeDetailNode}`
      )
      check(
        '成功之后选项列表自动收起（失败才留着让学生重试）',
        after?.optionsStillOpen === false,
        `列表仍展开=${after?.optionsStillOpen}`
      )
      info(
        `端到端学段切换：${before || '（还没认出年级）'} → ${after?.grade}` +
          `（这次会写进本机学生的 learning.db，属预期副作用）`
      )
    }
  } else {
    info('端到端学段切换：已由 K12_SKIP_GRADE_SET=1 跳过（避免改动本机学生的学段）')
  }
}

/* ------------------------------------------------------------------ *
 * C3. ★★ 端到端：选一章教材，看它**有没有真的进到下一轮的 System Prompt**
 *
 * 前两节证明的是「学段那条链路通」。这一节换一个对象（教材章节，D-038），
 * 验的是**软偏好**这条设计里最关键、也最容易假绿的一点：
 *
 *   章节选了之后**进了 prompt 没有**。
 *
 * ★ 为什么必须验落盘的那份文本，而不是只看界面：界面上的「正在学：第4章」是
 *   `chat.currentChapter` 渲染出来的 —— 只要 store 写对了，界面就对了；而「有没有
 *   送进模型」完全是另一条路（`fetchStudentContext` → `renderProfileText` →
 *   `buildSystemPrompt` → 落盘）。任何一处断线，界面上**一点异常都看不到**，
 *   学生只会觉得「我明明选了第 4 章，它怎么还在讲别的」。
 *
 * ★ 证据文件是主进程每轮结束时写的那份真实文本
 *   （`students/<id>/logs/chat-system-prompt.txt`，`runtime.ts` 的 `dumpPrompts`），
 *   不是脚本自己拼出来的期望值 —— 这是「同一份文本发给模型也落盘」的既有口径。
 *
 * ⚠️ 它**会改这台机器上学生的当前章节**（写进 learning.db）。这是有意的：
 *   要验的就是「写进去了、并且进了 prompt」。脚本每次挑一个与当前不同的章。
 *   `K12_SKIP_CHAPTER_SET=1` 可跳过（与学段那条同一手法）。
 * ------------------------------------------------------------------ */

{
  const chapterProbe = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="chapter-indicator"]')
    if (!el) return { present: false }
    const text = (sel) => {
      const node = document.querySelector(sel)
      return node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : ''
    }
    return {
      present: true,
      chapter: el.getAttribute('data-chapter') || '',
      lineText: text('[data-testid="chapter-current-label"]'),
      hasTrigger: !!document.querySelector('[data-testid="chapter-set"]'),
      triggerDisabled: document.querySelector('[data-testid="chapter-set"]')?.disabled === true,
      optionsVisibleBeforeClick: !!document.querySelector('[data-testid="chapter-options"]'),
      optionCountBeforeClick: document.querySelectorAll('[data-testid^="chapter-option-"]').length,
      noteText: text('[data-testid="chapter-indicator-note"]')
    }
  })()`)

  if (chapterProbe?.present !== true) {
    check(
      '教材章节指示器在位（[data-testid=chapter-indicator]）',
      false,
      '没找到指示器：学生选了章节却看不到「正在学哪一章」，这个选择就是隐形的'
    )
  } else {
    check(
      '教材章节指示器在位，且显示的是可读文案（不是空串 / kp_id）',
      String(chapterProbe.lineText).length > 0,
      `data-chapter="${chapterProbe.chapter}"，显示「${chapterProbe.lineText}」`
    )
    check(
      '★ 章节目录默认收起（不点开时没有选项列表）',
      chapterProbe.optionsVisibleBeforeClick === false && chapterProbe.optionCountBeforeClick === 0,
      `默认可见列表=${chapterProbe.optionsVisibleBeforeClick}，默认选项数=${chapterProbe.optionCountBeforeClick}`
    )
    check(
      '有「选择章节」的展开按钮（且默认可用）',
      chapterProbe.hasTrigger && chapterProbe.triggerDisabled === false,
      `按钮在位=${chapterProbe.hasTrigger}，初始禁用=${chapterProbe.triggerDisabled}`
    )

    // ── 展开：章节目录 + 「不限章节」 ──
    await evaluate(`(() => {
      const trigger = document.querySelector('[data-testid="chapter-set"]')
      if (trigger && !document.querySelector('[data-testid="chapter-options"]')) trigger.click()
      return true
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 200))

    const options = await evaluate(`(() => {
      const list = document.querySelector('[data-testid="chapter-options"]')
      if (!list) return { visible: false }
      const text = (sel) => {
        const node = document.querySelector(sel)
        return node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : ''
      }
      const buttons = Array.from(
        document.querySelectorAll('[data-testid^="chapter-option-"]:not([data-testid="chapter-option-none"])')
      )
      return {
        visible: true,
        titles: buttons.map((b) => (b.getAttribute('data-testid') || '').replace('chapter-option-', '')),
        allHaveActive: buttons.every((b) => b.getAttribute('data-active') !== null),
        activeCount: buttons.filter((b) => b.getAttribute('data-active') === 'true').length,
        hasNone: !!document.querySelector('[data-testid="chapter-option-none"]'),
        noGradeText: text('[data-testid="chapter-no-grade"]'),
        loading: !!document.querySelector('[data-testid="chapter-loading"]'),
        listError: text('[data-testid="chapter-list-error"]')
      }
    })()`)

    check(
      '★ 点「选择章节」后展开章节目录（当前学段的章 + 「不限章节」）',
      options?.visible === true &&
        (options.titles.length > 0 || options.noGradeText.length > 0 || options.listError.length > 0),
      options?.visible !== true
        ? '没展开出 [data-testid=chapter-options]'
        : `章数=${options.titles.length}，有「不限章节」=${options.hasNone}` +
          (options.noGradeText ? `；未判定学段提示=「${options.noGradeText}」` : '') +
          (options.listError ? `；读失败=「${options.listError}」` : '')
    )

    const current = chapterProbe.chapter
    const titles = Array.isArray(options?.titles) ? options.titles : []
    // 挑一个**与当前不同**的目标：换一章；若已经在某一章上，也可以换成「不限章节」清空
    const target = titles.find((title) => title !== current) ?? (current !== '' ? '' : null)

    if (process.env.K12_SKIP_CHAPTER_SET === '1') {
      info('端到端章节选择：已由 K12_SKIP_CHAPTER_SET=1 跳过（避免改动本机学生的章节）')
    } else if (target === null) {
      info(
        '端到端章节选择：跳过 —— 当前学段还没判定出来（章节目录按学段分），没有可验证的变化。' +
          '先让学生在对话里说几句把学段判出来，再跑这一节。'
      )
    } else {
      const clicked = await evaluate(`(() => {
        const want = ${JSON.stringify(target)}
        const buttons = Array.from(document.querySelectorAll('[data-testid^="chapter-option-"]'))
        const button = buttons.find((b) => {
          const id = b.getAttribute('data-testid') || ''
          return id.replace('chapter-option-', '') === (want === '' ? 'none' : want)
        })
        if (!button) return { ok: false, reason: '选项按钮不在' }
        if (button.disabled) return { ok: false, reason: '选项被禁用（流式中？）' }
        button.click()
        return { ok: true }
      })()`)

      const targetLabel = target === '' ? '不限章节（自由问答）' : target

      if (clicked?.ok !== true) {
        check(`★★ 选「${targetLabel}」后当前章节真的写进服务端并回到界面`, false, `点不了：${clicked?.reason ?? '未知原因'}`)
      } else {
        let applied = false
        try {
          applied = await waitFor(
            `(() => {
              const el = document.querySelector('[data-testid="chapter-indicator"]')
              return !!el && el.getAttribute('data-chapter') === ${JSON.stringify(target)}
            })()`,
            `当前章节切到 ${targetLabel}`,
            // 四层链路 + 一次 HTTP：比纯 DOM 断言慢，给足预算
            12_000
          )
        } catch (error) {
          applied = false
          info(`等待章节切换超时：${describe(error)}`)
        }

        const after = await evaluate(`(() => {
          const el = document.querySelector('[data-testid="chapter-indicator"]')
          const text = (sel) => {
            const node = document.querySelector(sel)
            return node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : ''
          }
          return {
            chapter: el ? el.getAttribute('data-chapter') || '' : '',
            lineText: text('[data-testid="chapter-current-label"]'),
            errorText: text('[data-testid="chapter-set-error"]'),
            optionsStillOpen: !!document.querySelector('[data-testid="chapter-options"]')
          }
        })()`)

        check(
          `★★ 选「${targetLabel}」后当前章节真的写进服务端并回到界面`,
          applied === true && String(after?.chapter) === target,
          `data-chapter="${after?.chapter}"，界面显示「${after?.lineText}」` +
            (after?.errorText ? `，界面报错：「${after.errorText}」` : '')
        )
        check(
          '成功之后选项列表自动收起（失败才留着让学生重试）',
          after?.optionsStillOpen === false,
          `列表仍展开=${after?.optionsStillOpen}`
        )

        // ★ 回读一条独立证据：**不经界面**，直接问一次 preload → 主进程 → Python。
        //   界面那一条只能证明 store 里的值对了；这一条证明库里也对了。
        const readBack = await evaluate(`(async () => {
          if (!window.api || typeof window.api.getChapter !== 'function') {
            return { ok: false, reason: 'preload 没有 getChapter（章节通道未接线）' }
          }
          try {
            const result = await window.api.getChapter()
            if (!result || !result.ok) return { ok: false, reason: (result && result.message) || '读取失败' }
            return { ok: true, chapterTitle: result.data.chapterTitle, gradeLevel: result.data.gradeLevel }
          } catch (error) {
            return { ok: false, reason: String(error) }
          }
        })()`)
        check(
          '★ 章节能被**回读**（window.api.getChapter → 主进程 → learning.db）',
          readBack?.ok === true && readBack.chapterTitle === target,
          readBack?.ok === true
            ? `回读 chapterTitle="${readBack.chapterTitle}"，gradeLevel="${readBack.gradeLevel}"（界面写的是 "${target}"）`
            : `回读失败：${readBack?.reason ?? '未知原因'}`
        )

        /* ------------------------------------------------------------ *
         * ★★ 本节的核心：选中的章节有没有进**落盘的 system prompt**
         *
         * 送一轮对话，然后读主进程写下的那份真实文本。无 Key 世界这一轮是
         * 「能力受限」收尾（毫秒级），有 Key 世界是一次真实回答 —— 两条路
         * 都会走到 `dumpPrompts`，所以证据都在。
         * ------------------------------------------------------------ */
        const slugMatch = /STABLE_USER_DATA_SLUG\s*=\s*'([^']+)'/.exec(readSource('src/main/index.ts'))
        const userDataRoot = process.env.APPDATA ? join(process.env.APPDATA, slugMatch?.[1] ?? 'k12-agent-desktop') : null
        const studentId = process.env.K12_STUDENT_ID ?? 'student_001'
        // 路径形状 = `<userData>/students/<id>/pi-agent/logs/chat-system-prompt.txt`。
        // ★ 中间的 `pi-agent` 段不能漏（`pi-paths.ts` 的 `resolveStudentPiPaths`：
        //   logDir = `<studentDir>/pi-agent/logs`）—— 漏了就永远「找不到落盘文件」，
        //   而那看起来像「章节没进 prompt」的失败，其实只是读错路径。
        const promptFile = userDataRoot
          ? join(userDataRoot, 'students', studentId, 'pi-agent', 'logs', 'chat-system-prompt.txt')
          : null

        try {
          const beforeTurn = await turnCount()
          await sendMessage('章节偏好冒烟：这一章里最该先学的是什么？')
          // ★ 用 noKeyTimeoutMs / contentTimeoutMs（文件开头的常量）而不是 D 节那个
          //   `noKeyTimeout`：它在本节之后才声明，这里引用会踩 TDZ（实测报
          //   「Cannot access 'noKeyTimeout' before initialization」）。离线探针模式
          //   下这一轮也只是「发一条 → 收终态」，用基准上限即可。
          const settled = await collectUntilTerminal(beforeTurn, hasKey ? contentTimeoutMs : noKeyTimeoutMs)
          const gradeAfterTurn = await evaluate(
            `(() => { const el = document.querySelector('[data-testid="grade-indicator"]'); return el ? el.getAttribute('data-grade') || '' : '' })()`
          )

          if (!promptFile || !existsSync(promptFile)) {
            skip(
              '★★ 选中的章节进了 system prompt（落盘证据）',
              `找不到落盘文件：${promptFile ?? '（无法确定 userData 目录：APPDATA 未设置）'}`,
              'C'
            )
          } else {
            const promptText = readFileSync(promptFile, 'utf8')
            const chapterLine = promptText
              .split(/\r?\n/)
              .find((line) => line.includes('当前教材章节')) ?? ''
            if (target === '') {
              check(
                '★★ 选「不限章节」后 prompt 里**没有**章节行（清空是真的清空）',
                chapterLine === '',
                chapterLine ? `仍出现：「${chapterLine.slice(0, 100)}」` : '章节行已消失'
              )
            } else {
              check(
                '★★ 选中的章节进了 system prompt（落盘的那份文本里能找到该章标题）',
                chapterLine.includes(target),
                chapterLine
                  ? `章节行：「${chapterLine.slice(0, 120)}」`
                  : `落盘 prompt 里没有「当前教材章节」这一行（文件 ${promptFile}）`
              )
            }
            info(
              `Prompt 证据：${promptFile}\n` +
                `  · 本轮终态=${settled?.snapshot?.status ?? '（未采样到）'}，落盘 prompt ${promptText.length} 字符`
            )

            /* D-032：同一章节下连问两轮，落盘的那份 prompt 必须**逐字节相同**。
             * 只在无 Key 世界做 —— 有 Key 时模型可能调 Tool 改画像（掌握度/偏好/错题变了，
             * 块本来就该变），那就不是「不稳定」，而是「画像真的变了」。
             * 学段中途变了也同理（学段段+章节都会被换掉），那种情况如实跳过而不是报假红。 */
            if (!hasKey && !settled?.timedOut) {
              const gradeBefore = gradeAfterTurn
              const secondBefore = await turnCount()
              await sendMessage('章节偏好冒烟：再问一次，看 prompt 有没有变。')
              // 同上一处：用文件开头的常量，不要引用后面才声明的 `noKeyTimeout`（TDZ）。
              await collectUntilTerminal(secondBefore, noKeyTimeoutMs)
              const gradeNow = await evaluate(
                `(() => { const el = document.querySelector('[data-testid="grade-indicator"]'); return el ? el.getAttribute('data-grade') || '' : '' })()`
              )
              const secondText = readFileSync(promptFile, 'utf8')
              if (gradeNow !== gradeBefore) {
                info(`逐字节稳定：跳过（两轮之间学段从 ${gradeBefore || '（还没认出年级）'} 变成 ${gradeNow}，学段段理应变化）`)
              } else {
                check(
                  '★★ 同一章节下两轮 prompt 逐字节相同（D-032：块里没有每轮会变的字节）',
                  secondText === promptText,
                  secondText === promptText
                    ? `两轮均为 ${secondText.length} 字符、内容完全一致`
                    : `两轮长度 ${promptText.length} → ${secondText.length}（前缀缓存会整段失效）`
                )
              }
            }
          }

          /* ------------------------------------------------------------ *
           * ★★ 反向路径：选「不限章节」必须真的**回到自由问答**
           *
           * 这条为什么值得单独验：清空是**合法入参**（空串），而「空串」在这条链路上
           * 至少有三处会被误当成「没填 / 非法」而拒掉 —— IPC 的入参白名单、
           * 后端的请求体校验、渲染层把空串渲染成「未选择」。任何一处收紧过头，
           * 学生选了章节之后就**再也回不到自由问答**了，而界面只会显示一次失败提示。
           *
           * 代价控制：无 Key 世界再送一轮，顺带把「清空后 prompt 里章节行消失」也拿到证据；
           * 有 Key 世界只做回读（不再多打一次真实模型调用）—— 那半条本来就由
           * 渲染层的 G23 组单测覆盖（无章节 → 整行不出现）。
           * ------------------------------------------------------------ */
          if (target !== '' && !settled?.timedOut && !process.env.K12_SKIP_CHAPTER_SET) {
            // ★ 先确保列表是展开的：**选中一章之后列表会自动收起**（那是设计：
            //   学生要看到的就是「选完了」）。这里幂等地点一下触发器 —— 少了这一步，
            //   「找不到 chapter-option-none」会被读成「清空功能坏了」，而它只是收起来了。
            await evaluate(`(() => {
              const trigger = document.querySelector('[data-testid="chapter-set"]')
              if (trigger && !document.querySelector('[data-testid="chapter-options"]')) trigger.click()
              return true
            })()`)
            await new Promise((resolve) => setTimeout(resolve, 200))

            const cleared = await evaluate(`(() => {
              const button = document.querySelector('[data-testid="chapter-option-none"]')
              if (!button) return { ok: false, reason: '「不限章节」按钮不在（列表没展开？）' }
              button.click()
              return { ok: true }
            })()`)
            let clearedApplied = false
            try {
              clearedApplied = await waitFor(
                `(() => {
                  const el = document.querySelector('[data-testid="chapter-indicator"]')
                  return !!el && el.getAttribute('data-chapter') === ''
                })()`,
                '当前章节被清空',
                12_000
              )
            } catch (error) {
              info(`等待清空章节超时：${describe(error)}`)
            }
            check(
              '★★ 选「不限章节（自由问答）」能回到未选择状态（空串不是「没填」，不许被拒）',
              cleared?.ok === true && clearedApplied === true,
              cleared?.ok === true
                ? 'data-chapter 已回到 ""（清空链路通）'
                : `点不了：${cleared?.reason ?? '未知原因'}`
            )

            if (!hasKey) {
              const thirdBefore = await turnCount()
              await sendMessage('章节偏好冒烟：清空之后再问一次。')
              await collectUntilTerminal(thirdBefore, noKeyTimeoutMs)
              const clearedText = readFileSync(promptFile, 'utf8')
              const clearedLine =
                clearedText.split(/\r?\n/).find((line) => line.includes('当前教材章节')) ?? ''
              check(
                '★★ 清空后落盘 prompt 里的章节行消失（回读同一份落盘文本）',
                clearedLine === '',
                clearedLine
                  ? `仍出现：「${clearedLine.slice(0, 100)}」`
                  : `章节行已消失（prompt ${clearedText.length} 字符）`
              )
            }
            info('反向路径：已选章节 → 「不限章节」→ 回到自由问答（同时把本机学生的章节清空）')
          }
        } catch (error) {
          // ★ 标签与上面那条断言**不同名**：否则「脚本自己出错」会伪装成
          //   「章节没进 prompt」—— 错误信息指错方向比没有信息更费时间。
          check('★★ 章节偏好端到端取证（送一轮 + 读落盘 prompt）', false, describe(error))
        }

        info(
          `端到端章节选择：${current || '（未选）'} → ${after?.chapter || '（未选）'}` +
            `（这次会写进本机学生的 learning.db，属预期副作用）`
        )
      }
    }
  }

  if (chapterProbe?.noteText) {
    info(`章节指示器提示：「${chapterProbe.noteText.slice(0, 100)}」`)
  }
}

/* ------------------------------------------------------------------ *
 * D. 无 Key 路径（仅无 Key 世界）—— 「能力受限」必须是可读的
 * ------------------------------------------------------------------ */

console.log('\n== D. 无 Key 路径（本轮以 error 收尾，但必须是可读的降级提示）==')

const probeMode = process.env.K12_OFFLINE_PROBE === '1'
const noKeyTimeout = probeMode ? probeTimeoutMs : noKeyTimeoutMs

if (hasKey) {
  skip(
    '无 Key 路径：一轮以「能力受限」收尾',
    '当前已配置 API Key（K12_VERIFY_HAS_KEY=1 或主进程报告 hasKey=true），本项不适用',
    'D'
  )
} else {
  try {
    const before = await turnCount()
    await sendMessage('无 Key 冒烟：人工智能是怎么认出猫的？')
    const { samples, snapshot, timedOut } = await collectUntilTerminal(before, noKeyTimeout)

    if (timedOut) {
      check(
        '无 Key 路径：本轮能结束（不卡在「正在回答」）',
        false,
        `超过 ${noKeyTimeout}ms 仍未到终态；采样到的正文长度：${samples.join(' → ')}`
      )
    } else {
      check(
        '无 Key 路径：本轮能结束（不卡在「正在回答」）',
        snapshot.status !== 'streaming',
        `data-status=${snapshot.status}，状态文案="${snapshot.statusLabel}"（${Math.round(noKeyTimeout / 1000)}s 上限内收尾）`
      )
      // ★ 这条原先断言 `status === 'error'`，与渲染进程折叠器的**既定设计**矛盾：
      //   `degraded === true` 的 error 是「降级提示，不是终态」——UI 保持 streaming，
      //   等后面的 `done`（主进程的 `emitTerminal` 就是先发 error 再发 done）。
      //   所以无 Key 这一轮的终态本来就是 `done` + 一条「能力受限」提示。
      //   真正要守的是「本轮没有正文产出、且终态已到、且提示带 degraded 标记」。
      check(
        '无 Key 路径：本轮没有产出正文（空回答，不是半截内容）',
        snapshot.text.length === 0,
        `正文长度 ${snapshot.text.length}（data-status=${snapshot.status}）`
      )
      check(
        `无 Key 路径：给出「${DEGRADED_BADGE_TEXT}」提示（degraded === true）`,
        snapshot.errorBadge === DEGRADED_BADGE_TEXT,
        `错误徽章 = "${snapshot.errorBadge || '(缺失)'}"`
      )
      check(
        `无 Key 路径：提示是**可读中文原因**（${DEGRADED_NOTICE_MARKERS.join(' / ')}）`,
        DEGRADED_NOTICE_MARKERS.some((marker) => snapshot.errorText.includes(marker)) &&
          snapshot.errorText.length >= 12,
        `提示文案：「${snapshot.errorText.slice(0, 120)}」`
      )
      check(
        '无 Key 路径：提示不是堆栈 / 异常原文',
        snapshot.errorText.length > 0 && !looksLikeStack(snapshot.errorText),
        `未命中堆栈特征（${STACK_PATTERNS.length} 条判据）：「${snapshot.errorText.slice(0, 80)}」`
      )
      check(
        '无 Key 路径：界面没有乱码（无 U+FFFD）且不是白屏',
        !snapshot.errorText.includes('\uFFFD') && probe.bodyTextLength > 0,
        '错误文案与 body 文本均无替换字符'
      )
      check(
        '无 Key 路径：学生消息与本轮都留在消息区（旧轮不被清掉）',
        (await turnCount()) === before + 1 && snapshot.userText.includes('无 Key 冒烟'),
        `消息区轮次 = ${await turnCount()}（开始时 ${before} 轮）`
      )
    }
  } catch (error) {
    check('无 Key 路径：一轮以「能力受限」收尾', false, describe(error))
  }
}

/* ------------------------------------------------------------------ *
 * E. 内容断言（仅「已配置 API Key」世界）
 * ------------------------------------------------------------------ */

console.log('\n== E. 内容断言（delta / done / 卡片 kind，仅已配置 Key 时执行）==')

if (!hasKey) {
  skip(
    'delta 流式增长 / 终态 done / 卡片 kind 合法',
    '未配置 API Key：这些断言依赖真实模型回答，按设计跳过（不是失败）；配好 Key 后重跑即可覆盖',
    'E'
  )
} else {
  try {
    const before = await turnCount()
    await sendMessage('请用一两句话讲讲：人工智能是怎么认出一只猫的？')
    const { samples, snapshot, timedOut } = await collectUntilTerminal(before, contentTimeoutMs)
    if (timedOut) {
      check('delta：本轮在超时前结束', false, `超过 ${contentTimeoutMs}ms 仍在 streaming；采样：${samples.join(' → ')}`)
    } else {
      const distinct = [...new Set(samples.filter((length) => length > 0))]
      check(
        'delta：正文是「流」而不是一次性插入（长度多次增长）',
        snapshot.status === 'done' || distinct.length >= 2,
        `采样到的正文长度：${samples.join(' → ')}`
      )
      check(
        'done：本轮以 done 收尾（不是 error / 卡住）',
        snapshot.status === 'done',
        `data-status=${snapshot.status}，状态文案="${snapshot.statusLabel}"`
      )
      check(
        '正文可读（有实际内容、无 U+FFFD）',
        snapshot.text.trim().length > 0 && !snapshot.text.includes('\uFFFD'),
        `正文长度 ${snapshot.text.length}，开头：「${snapshot.text.trim().slice(0, 60)}」`
      )
      const illegalKinds = snapshot.cardKinds.filter((kind) => !EXPECTED_CARD_KINDS.includes(kind))
      // ★ 同时断言「渲染出来的卡片节点数 == 识别出的 kind 数」：只判 illegalKinds 为空的话，
      //   一旦选择器失效（本轮卡片明明画出来了、却一条都没收集到），断言会**空过**。
      const kindsMatchNodes = snapshot.cardKinds.length === snapshot.cardCount
      check(
        'payload：出现的卡片 kind 合法（animation / coding / quiz）',
        illegalKinds.length === 0 && kindsMatchNodes,
        `本轮卡片 kind：[${snapshot.cardKinds.join(', ') || '(本轮没有卡片)'}]；` +
          `卡片节点 ${snapshot.cardCount} 个、需全部可识别为三种 kind 之一`
      )
      // ★ citation：判据取自**真实 DOM**（`[data-testid="citation-chip"]`，见 turnSnapshotExpression）。
      //   原来这里写 `check(…, true, …)` —— 无条件计入通过，把「事件里出现过 citation」
      //   当成了「标签渲染出来了」，是一条不检查的假绿。现在断言到**每条标签的文字**：
      //   节点数与文字条数一致、且没有空标签（空标签 = 渲染了壳子没渲染内容）。
      const labels = Array.isArray(snapshot.citationLabels) ? snapshot.citationLabels : []
      if (snapshot.citations > 0) {
        check(
          'citation：来源标签渲染出来（每条都有可读文字）',
          labels.length === snapshot.citations && labels.every((label) => label.length > 0),
          `DOM 里的来源标签 ${snapshot.citations} 条，文字：[${labels.join(' ｜ ')}]`
        )
        check(
          'citation：「向上兼容」标注只出现在真实存在的兼容条目上',
          snapshot.compatCitations <= snapshot.citations,
          `来源标签 ${snapshot.citations} 条，其中带「向上兼容」标注 ${snapshot.compatCitations} 条`
        )
      } else {
        info('citation：本轮没有渲染来源标签（模型没调 rag_search 或本轮无命中）—— 取决于模型这一轮的动作，不做硬断言')
      }
    }
  } catch (error) {
    check('内容断言（delta / done / 卡片 kind）', false, describe(error))
  }
}

/* ------------------------------------------------------------------ *
 * F. 练习卡片（真实形状的 payload 事件 → 真实归约器 → 真实 DOM）
 * ------------------------------------------------------------------ */

console.log('\n== F. 练习卡片渲染（payload 事件 → 卡片 → 逐题反馈 / 掌握度）==')

/** 从真实题库文件取一道题，投影成**对外形态**（丢掉 answer，保留 explanation 之外的说明）。 */
function readBankQuestion(gradeBankPath, type) {
  const absolute = join(REPO_ROOT, gradeBankPath)
  if (!existsSync(absolute)) scriptError(`读不到题库文件：${gradeBankPath}`)
  const bank = JSON.parse(readFileSync(absolute, 'utf8'))
  const question = (bank.questions ?? []).find((item) => item.type === type)
  if (!question) scriptError(`题库 ${gradeBankPath} 里没有 ${type} 题型（练习卡片的渲染断言需要它）`)
  return {
    out: {
      qid: question.qid,
      kpId: question.kp_id,
      type: question.type,
      stem: question.stem,
      options: question.options ?? null,
      // explanation 是后端为了让模型组织语言才带的：**卡片不许渲染它**（里面常直接写着答案）
      explanation: question.explanation ?? ''
    },
    answer: question.answer
  }
}

const choiceSource = readBankQuestion('server/resources/quizbank/junior.json', 'choice')
const blankSource = readBankQuestion('server/resources/quizbank/junior.json', 'blank')
const codeBlankSource = readBankQuestion('server/resources/quizbank/junior.json', 'code_blank')

/** `generate_quiz` 的 `details`（= payload 事件的 payload），形状与 `quiz.ts` 的 `QuizPayloadShape` 一致。 */
const quizPayloadEvent = {
  name: 'payload',
  data: {
    requestId: 'verify-quiz-questions',
    kind: 'quiz',
    payload: {
      kpId: choiceSource.out.kpId,
      source: 'bank',
      questions: [choiceSource.out, blankSource.out, codeBlankSource.out],
      // 事件层附加的两个提示字段（`agent/events.ts` 的 readPayload）
      tool: 'generate_quiz',
      kind: 'quiz'
    }
  }
}
/** `submit_quiz` 的 `details`（= 批改结果载荷）。 */
const quizResultEvent = {
  name: 'payload',
  data: {
    requestId: 'verify-quiz-result',
    kind: 'quiz',
    payload: {
      qid: choiceSource.out.qid,
      correct: true,
      scoredBy: 'rule',
      feedback: '答对了！能被量出来、又能区分对象的数值才适合当特征。',
      masteryDelta: 0.15,
      tool: 'submit_quiz',
      kind: 'quiz'
    }
  }
}

/**
 * 把两条 payload 事件注入**渲染进程自己的事件归约器**（`applyChatEvent`）并落到 store。
 *
 * 为什么可以这么做：`applyChatEvent` 是纯函数，事件对象与主进程推来的**逐字段一致**；
 * 这条路径经过真实的 store 与真实的 `QuizCard.vue`，只有「谁把事件递进来」不同
 * （无 Key 时模型不会调用 generate_quiz，只能这样驱动渲染侧）。
 * 模块 URL 依赖 dev 模式的 Vite 模块图，打包产物下拿不到（返回 skipped）。
 */
const INJECTION = `(async () => {
  const candidates = ['/src/api/events.ts', '/src/renderer/src/api/events.ts']
  let events = null
  let modulesLoadedFrom = ''
  for (const path of candidates) {
    try {
      events = await import(/* @vite-ignore */ path)
      modulesLoadedFrom = path
      break
    } catch (error) {
      events = null
    }
  }
  if (!events) return { ok: false, reason: '取不到渲染进程模块图（不是 dev 模式？）' }

  const storeCandidates = ['/src/stores/chat.ts', '/src/renderer/src/stores/chat.ts']
  let stores = null
  for (const path of storeCandidates) {
    try {
      stores = await import(/* @vite-ignore */ path)
      break
    } catch (error) {
      stores = null
    }
  }
  if (!stores || typeof stores.useChatStore !== 'function') {
    return { ok: false, reason: '取不到 stores/chat.ts（不是 dev 模式？）' }
  }

  const chat = stores.useChatStore()
  const questionsEvent = ${JSON.stringify(quizPayloadEvent)}
  const resultEvent = ${JSON.stringify(quizResultEvent)}

  // 第 1 轮：题目卡片（与主进程推来的 payload 事件逐字段一致）
  let state = events.startTurn(chat.conversation, questionsEvent.data.requestId, '帮我出两道题练一练', chat.currentGrade ?? null)
  state = events.applyChatEvent(state, questionsEvent)
  state = events.applyChatEvent(state, { name: 'done', data: { requestId: questionsEvent.data.requestId, messageId: 'verify-quiz-1' } })
  // 第 2 轮：批改结果（跨轮回来，题目卡片要能按 qid 认领它）
  state = events.startTurn(state, resultEvent.data.requestId, '【练习作答】我做完这道题了，请帮我批改。', chat.currentGrade ?? null)
  state = events.applyChatEvent(state, resultEvent)
  state = events.applyChatEvent(state, { name: 'done', data: { requestId: resultEvent.data.requestId, messageId: 'verify-quiz-2' } })

  chat.conversation = state
  return { ok: true, modulesLoadedFrom, requestId: questionsEvent.data.requestId }
})()`

let injected = null
try {
  injected = await evaluate(INJECTION)
} catch (error) {
  injected = { ok: false, reason: describe(error) }
}

if (injected?.ok !== true) {
  const message = `注入 payload 事件失败：${injected?.reason ?? '未知原因'}`
  if (isDevServer) {
    check('练习卡片：payload 事件驱动渲染（题目 / 作答 / 反馈）', false, message)
  } else {
    skip('练习卡片：payload 事件驱动渲染', `${message}（当前不是 dev 服务，无法驱动渲染进程模块图）`, 'F')
  }
} else {
  try {
    await waitFor(
      `(() => document.querySelectorAll('[data-testid="quiz-card"]').length >= 1)()`,
      '练习卡片出现在消息区',
      5000
    )

    const quizProbe = await evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="quiz-card"]'))
      const card = cards[cards.length - 1]
      const questions = Array.from(card.querySelectorAll('[data-testid="quiz-question"]'))
      const text = (el, sel) => {
        const node = el.querySelector(sel)
        return node && node.textContent ? node.textContent.trim() : ''
      }
      return {
        cardCount: cards.length,
        questionCount: questions.length,
        types: questions.map((item) => item.getAttribute('data-type') || ''),
        qids: questions.map((item) => item.getAttribute('data-qid') || ''),
        stems: questions.map((item) => text(item, '[data-testid="quiz-stem"]')),
        typeLabels: questions.map((item) => text(item, '[data-testid="quiz-type"]')),
        optionCounts: questions.map((item) => item.querySelectorAll('[data-testid="quiz-option"]').length),
        blankInputs: card.querySelectorAll('[data-testid="quiz-blank"]').length,
        codeBlankInputs: card.querySelectorAll('[data-testid="quiz-code-blank"]').length,
        submitButtons: card.querySelectorAll('[data-testid="quiz-submit"]').length,
        feedbackBlocks: card.querySelectorAll('[data-testid="quiz-feedback"]').length,
        verdicts: Array.from(card.querySelectorAll('[data-testid="quiz-verdict"]')).map((el) => el.textContent.trim()),
        mastery: Array.from(card.querySelectorAll('[data-testid="quiz-mastery"]')).map((el) => el.textContent.trim()),
        feedbackTexts: Array.from(card.querySelectorAll('[data-testid="quiz-feedback-text"]')).map((el) => el.textContent.trim()),
        // ★ 答案泄漏防线的界面侧证据：整个页面文本里不许出现标准答案与解析
        pageText: document.body.innerText || '',
        domAttributes: Array.from(card.querySelectorAll('*'))
          .flatMap((el) => Array.from(el.attributes).map((attr) => attr.name + '=' + attr.value))
          .join(' | ')
      }
    })()`)

    check(
      '练习卡片：题目渲染出来（3 道题，题型标签正确）',
      quizProbe.questionCount === 3 &&
        JSON.stringify(quizProbe.types) === JSON.stringify(['choice', 'blank', 'code_blank']) &&
        JSON.stringify(quizProbe.typeLabels) === JSON.stringify(['选择题', '填空题', '代码填空']),
      `题目 ${quizProbe.questionCount} 道，题型 ${quizProbe.types.join(' / ')}，标签「${quizProbe.typeLabels.join('、')}」`
    )
    check(
      '练习卡片：题干是题库原文（不是占位文字）',
      quizProbe.stems[0] === choiceSource.out.stem && quizProbe.stems[0].length > 5,
      `第 1 题题干：「${quizProbe.stems[0].slice(0, 40)}…」`
    )
    check(
      '练习卡片：选择题渲染全部选项（可作答）',
      quizProbe.optionCounts[0] === (choiceSource.out.options ?? []).length && quizProbe.optionCounts[0] >= 2,
      `选项数 = ${quizProbe.optionCounts[0]}（题库里 ${(choiceSource.out.options ?? []).length} 个）`
    )
    check(
      '练习卡片：填空 / 代码填空各有输入框',
      quizProbe.blankInputs >= 1 && quizProbe.codeBlankInputs >= 1,
      `填空输入框 ${quizProbe.blankInputs} 个，代码填空输入框 ${quizProbe.codeBlankInputs} 个`
    )
    check(
      '练习卡片：每题都有提交按钮（作答入口）',
      quizProbe.submitButtons === 3,
      `提交按钮 ${quizProbe.submitButtons} 个`
    )
    check(
      '★ 逐题反馈：批改结果跨轮回来后，落在对应的题目下面',
      quizProbe.feedbackBlocks >= 1 &&
        quizProbe.verdicts.includes('答对了') &&
        quizProbe.feedbackTexts.some((text) => text.includes('答对了')),
      `反馈块 ${quizProbe.feedbackBlocks} 个，判定「${quizProbe.verdicts.join(', ')}」`
    )
    check(
      '★ 掌握度变化显示出来（掌握度 +0.15）',
      quizProbe.mastery.includes('掌握度 +0.15'),
      `掌握度标签：${quizProbe.mastery.join(', ') || '(缺失)'}`
    )

    // ★★ 答案泄漏防线：标准答案与解析都不许出现在界面（文本与属性一起查）
    const blankAnswer = Array.isArray(blankSource.answer) ? blankSource.answer : [blankSource.answer]
    const leaked = [
      { label: '填空题标准答案', value: blankAnswer[0] },
      { label: '填空题解析（含答案）', value: blankSource.out.explanation },
      { label: '选择题解析（含答案）', value: choiceSource.out.explanation }
    ].filter((item) => typeof item.value === 'string' && item.value.length > 3)
    const leakedHits = leaked.filter(
      (item) => quizProbe.pageText.includes(item.value) || quizProbe.domAttributes.includes(item.value)
    )
    check(
      '★★ 答案不泄漏到界面（标准答案 / 解析既不在文本里，也不在属性里）',
      leakedHits.length === 0,
      leakedHits.length === 0
        ? `已检查 ${leaked.length} 条敏感文本（题库答案 + 解析），界面里 0 命中`
        : `泄漏：${leakedHits.map((item) => item.label).join('、')}`
    )

    // 作答 → 提交：走真实的聊天链路（无 Key 时本轮会以 error 收尾，这不影响卡片的断言）
    //
    // ⚠️ 必须点**还没作答**的那一题：实现层把答对之后的提交键改成禁用的「已完成」
    //   （学生答对了再点一次没有意义，见 `cards/QuizCard.vue` 的 `submitLabel`）。
    //   而上面注入的那条判分结果对应的正是**第 1 题** —— 直接 querySelector 拿第一个
    //   `quiz-submit`，拿到的必然是个禁用按钮，`click()` 静默无效，
    //   于是后面「出现【练习作答】」永远等不到。所以这里挑**第一个可点的**提交键。
    const beforeSubmit = await turnCount()
    const submitted = await evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('[data-testid="quiz-card"]')).pop()
      if (!card) return { ok: false, reason: '找不到练习卡片' }
      const button = Array.from(card.querySelectorAll('[data-testid="quiz-submit"]')).find(
        (candidate) => !candidate.disabled
      )
      if (!button) return { ok: false, reason: '找不到可提交的作答按钮（全部已判分或禁用）' }
      const question = button.closest('[data-testid="quiz-question"]')
      const option = question && question.querySelector('[data-testid="quiz-option"] input[type="radio"]')
      if (option) option.click()
      const blank = question && question.querySelector('[data-testid="quiz-blank"], [data-testid="quiz-code-blank"]')
      if (blank) {
        blank.value = '1'
        blank.dispatchEvent(new Event('input', { bubbles: true }))
      }
      button.click()
      const stem = question && question.querySelector('[data-testid="quiz-stem"]')
      return { ok: true, stem: stem ? stem.textContent : '' }
    })()`)
    if (submitted?.ok !== true) {
      check('练习卡片：选中选项后可以提交作答', false, submitted?.reason ?? '点击失败')
    } else {
      // ★ 断言的是**题干**而不是 qid：qid（`gen-ai-definition-jr-…`）里嵌着知识点 slug，
      //   已从学生气泡里撤掉（见 `cards/quiz.ts` 的 `submissionBody` 说明）——
      //   它对学生的唯一用处是「我知道自己答的是哪题」，而那由题干承担。
      //   题号仍在 **wire 文本**里（模型调 submit_quiz 要用），由
      //   `tests/renderer-quiz.test.ts` 的单元测试钉着。
      const submittedStem = String(submitted.stem ?? '').slice(0, 12)
      const submittedTurn = await waitFor(
        `(() => {
          const turns = document.querySelectorAll('[data-testid="chat-turn"]')
          const last = turns[turns.length - 1]
          if (!last) return null
          const user = last.querySelector('[data-testid="user-message"]')
          const text = user && user.textContent ? user.textContent.trim() : ''
          return text.includes('【练习作答】') ? text : null
        })()`,
        '提交后出现「【练习作答】…」的学生消息',
        10_000
      )
      check(
        '练习卡片：提交把「题目 + 作答」交给主 Agent（前端不判分）',
        typeof submittedTurn === 'string' && submittedStem.length > 0 && submittedTurn.includes(submittedStem),
        `学生消息：「${String(submittedTurn).slice(0, 90)}…」（轮次 ${beforeSubmit} → ${await turnCount()}）`
      )
      // 提交这一轮由主进程回应（无 Key 时是能力受限提示，有 Key 时是真批改）——不在此断言内容
    }
  } catch (error) {
    check('练习卡片：payload 事件驱动渲染（题目 / 作答 / 反馈）', false, describe(error))
  }
}

/* ------------------------------------------------------------------ *
 * G. 全局收尾断言
 * ------------------------------------------------------------------ */

console.log('\n== G. 全局 ==')

// 报告素材：`K12_UI_DUMP=1` 时把关键区域的**真实 DOM 文本**打出来
// （本机截图不可靠：受前台窗口 / DPI 影响，经常截到别的窗口）
if (process.env.K12_UI_DUMP === '1') {
  try {
    const dump = await evaluate(`(() => {
      const text = (sel) => {
        const el = document.querySelector(sel)
        return el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '(缺失)'
      }
      const card = Array.from(document.querySelectorAll('[data-testid="quiz-card"]')).pop()
      return {
        indicator: text('[data-testid="grade-indicator"]'),
        chatTail: (document.querySelector('[data-testid="chat-log"]') || {}).innerText || '',
        quizCard: card ? card.innerText.replace(/\\s*\\n\\s*/g, ' | ').slice(0, 900) : '(本轮没有练习卡片)',
        lastTurn: text('[data-testid="chat-turn"]:last-of-type')
      }
    })()`)
    console.log('\n[DOM] 学段指示器：', dump.indicator)
    console.log('[DOM] 练习卡片（题目 + 逐题反馈 + 掌握度）：', dump.quizCard)
    console.log('[DOM] 对话区尾部（最后一轮）：', String(dump.lastTurn).slice(0, 300))
  } catch (error) {
    info(`DOM 证据导出失败（不影响断言）：${describe(error)}`)
  }
}

try {
  const bodyHasUfffd = await evaluate(`(() => (document.body.innerText || '').includes('\\uFFFD'))()`)
  check('全文没有 U+FFFD（中文没有乱码）', bodyHasUfffd === false, `body.innerText 里出现替换字符 = ${bodyHasUfffd}`)
} catch (error) {
  check('全文没有 U+FFFD（中文没有乱码）', false, describe(error))
}

check(
  '整轮交互期间渲染进程没有未捕获异常 / 控制台错误',
  pageErrors.length === 0,
  pageErrors.length === 0 ? '未捕获异常与控制台错误均为 0' : pageErrors.slice(0, 3).join(' ｜ ')
)

socket.close()

/* ------------------------------------------------------------------ *
 * H. 汇总
 * ------------------------------------------------------------------ */

console.log(
  `\n结果：通过 ${results.passed} 项，失败 ${results.failed} 项，跳过 ${results.skipped} 项` +
    `（世界：${hasKey ? '已配置 API Key' : '无 Key'}${probeMode ? ' + 离线探针' : ''}）`
)
if (results.skipped > 0) {
  // ★ 跳过**点名到层**：报告里不能只写「跳过 N 项」，否则读者无法判断
  //   「关键层（F：答案不进 DOM）是不是在这一轮里被跳过了」。
  if (skippedLayers.size > 0) {
    console.log(`  被跳过涉及的层：${[...skippedLayers].sort().join('、')}（跳过 = 该世界下不适用，不算失败）`)
  }
  console.log('跳过项的说明见上方的 [SKIP] 行。')
  if (REQUIRED_LAYERS.length > 0) {
    console.log(`  K12_REQUIRE_LAYERS=${REQUIRED_LAYERS.join(',')}：被声明为必需层的跳过已按失败计。`)
  } else {
    console.log('  ⚠️ 收口（打包产物）建议设 K12_REQUIRE_LAYERS=E,F —— 否则关键层被跳过时本脚本仍会打印「全部通过」。')
  }
}

if (results.failed > 0) {
  console.log(`\n失败清单：${failures.join('、')}`)
  process.exit(1)
}

console.log('\n结果：全部通过')
process.exit(0)
