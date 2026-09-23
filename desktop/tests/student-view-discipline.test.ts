/**
 * 「学生视角不得出现开发者 / 运维信息」的**源码级守卫**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一组守卫为什么存在
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-09-20 的界面走查把 83 张真机截图交给外部评审，结论集中在同一件事上：
 * **界面把「开发者的调试视角」当成了产品前端**。典型原句（全部来自真机截图）：
 *
 *   · 「检索降级链 … FTS5 关键词兜底 / 未走到」（右栏）
 *   · 「本次仅使用「初中」及以下教材块（隔离在 SQL 层强制，模型改不了 WHERE）」
 *   · 「路由由模型自选；学段隔离、参数校验、内容终审均在代码层强制」
 *   · 「`t4|答题=连对10,正确率1.0`」（Python 侧 `encode_turn_raw` 的诊断串）
 *   · 「数据层检视视图：C:\Users\<用户名>\AppData\Roaming\…\kb.sqlite」
 *   · 「命中内容安全规则：越狱/绕过规则（regex:reveal_system_prompt）」
 *   · 「代码经 POST /api/code/run-hint 之外的两条本地链路完成…」
 *
 * 这些信息对**评委**是「设计合理性」的证据（25% 那一项），对**学生**是噪音甚至是
 * 恐吓。所以处置不是删除，而是**分视角**：学生默认看不见，教师 / 答辩视角里全留着
 * （`components/TeacherGate.vue` + `stores/viewMode.ts`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么是「源码级」而不是「渲染后量 DOM」
 * ══════════════════════════════════════════════════════════════════════════
 * 真机扫描（`scripts/ux-pages-audit.mjs` 的「没有裸露的技术词」）只能扫到**当前这一屏**
 * —— 它看不见「点开某个下拉才出现的那段话」、也看不见「某个状态分支下才渲染的报错」。
 * 而这类泄露恰恰大量存在于那些位置（截图里被抓到的正是在各种展开态 / 状态态下）。
 * 源码级守卫的覆盖面是**全文**：所有字面量、所有分支，一个都跑不掉。
 * 两者互补：源码守卫保证「没有漏网之鱼」，真机扫描保证「拼装出来的句子也干净」
 * （例如模板字符串拼出来的技术词，源码里看不到完整句子）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 每条都做过变异验证
 * ══════════════════════════════════════════════════════════════════════════
 * 「没验过会红的守卫不算守卫」——本文件每条断言都在**修复前**的代码上跑过一次，
 * 确认它真的变红；注释里记的是当时的原句。改动本文件时请照做。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = join(desktopRoot, 'src', 'renderer', 'src')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

/**
 * 递归列出渲染进程下的所有 `.vue` / `.ts`（含子目录）。
 *
 * ⚠️ 类型都写全：本文件是 `.ts`（不是 `.mjs`），空数组会被推断成 `never[]`，
 *    `out.push(full)` 于是直接编译不过 —— 这个目录下已经有一批 `.mjs` 脚本
 *    是「不参与 tsc」的，别把两者的写法混起来。
 */
function rendererFiles(dir: string = rendererRoot): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...rendererFiles(full))
    else if (/\.(vue|ts)$/.test(entry)) out.push(full)
  }
  return out
}

/** 相对 `src/renderer/src` 的路径（报错信息里短一些）。 */
const rel = (file: string): string => file.slice(rendererRoot.length + 1).replaceAll('\\', '/')

/**
 * 剥掉注释（**保留换行**，否则行号会整体偏移、报错指向错误的位置）。
 *
 * ★ 为什么必须剥：本项目的注释**刻意引用坏写法**（「原来是 `nowrap` + `overflow: hidden`」
 *   这种说明书式注释遍布全仓），不剥的话守卫会被自己的说明绊倒 ——
 *   `ux-pages-regression.test.ts` 里已经因为同一个原因踩过两次。
 * ★ 三种注释形态都要处理：`/* … *\/`、`// …`、以及 .vue 模板里的 `<!-- … -->`。
 *   （第一版只剥了前两种，结果 `.vue` 的模板注释里的 kp_id 被当成泄露报了出来。）
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')) // 多行注释 → 等长空白，保住行号
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1') // 前面不是冒号/引号，避开 https:// 与字符串里的 //
}

/**
 * 抽出**会渲染给用户看的文本**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 这是本文件最容易写错的地方，第一版就写错了
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版直接 `stripComments(全文).includes(词)`，结果：
 *   · `kpId` 这个词在 `cards/coding.ts` 里出现 450 次，**全是属性名**（`record.kpId`、
 *     `kpId: string`）—— 它们一个字都不会印到屏幕上，却全被报成「泄露」；
 *   · 反过来真正要抓的**字符串里的**技术词被淹没在噪音里。
 * 一个 450 条假阳性的守卫比没有守卫更糟：看两次就会有人把词表调松，然后再也没人信它。
 * 所以这里**只抽两类东西**：
 *   ① `.vue` 模板里的**文本节点**与**面向用户的属性**（title / placeholder / aria-label…）；
 *   ② `.ts` / `<script>` 里的**字符串字面量**（单引号、双引号、反引号）。
 * 其余的标识符、类名、data-* 属性一律不看 —— 它们不可见。
 */
function visibleText(file, source) {
  const isVue = file.endsWith('.vue')
  /** 抽出来的可见文本片段（类型必须显式 —— 本文件是 .ts，空数组会被推断成 never[]）。 */
  const chunks: string[] = []

  if (isVue) {
    const template = /<template>([\s\S]*)<\/template>/.exec(source)
    if (template) {
      let body = stripComments(template[1])
      // ① 先摘掉 <TeacherGate> 的**整棵子树**：它本来就是「只给老师 / 评委看」的内容，
      //    （含它自己的 label 属性），里面的技术词是刻意的，不是泄露。
      body = body.replace(/<TeacherGate\b[\s\S]*?<\/TeacherGate>/g, ' ').replace(/<TeacherGate\b[^>]*\/>/g, ' ')
      // ② 摘掉 mustache 插值：`{{ nameOf(item.kpId) }}` 渲染出来的是**函数结果**，
      //    表达式本身（含 `.kpId` 这种属性名）不会出现在屏幕上。
      //    第一版把它当成文本，于是 `{{ levelLabel(level.kpId) }}` 被报成「泄露 kpId」。
      body = body.replace(/\{\{[\s\S]*?\}\}/g, ' ')
      // ③ 静态属性：可能被读到的那些。**必须排除绑定属性**（`:title="…"`）——
      //    绑定的是表达式，同样不是字面文本。用「前面必须是空白」来排除 `:` / `v-bind:` 前缀。
      const ATTRS =
        'title|placeholder|aria-label|aria-description|alt|label|desc|hint|subtitle|content|confirm-text|cancel-text'
      const attrRe = new RegExp(`(?:^|\\s)(?:${ATTRS})="([^"]*)"`, 'gm')
      for (const match of body.matchAll(attrRe)) chunks.push(match[1])
      // ④ 抽完属性之后，**先抹掉所有属性值**再做文本抽取。
      //    ⚠️ 这一步是必须的：`<Badge v-if="earnedBadges.length > 0" :name="x.kpId" />`
      //    里的 `>` 会让下面那条「去掉标签」的正则在**属性值内部**提前闭合，
      //    剩下的 `:name="…kpId"` 就被当成文本节点了（第一版就这样误报过 ProgressCard）。
      body = body.replace(/[\w:@.#-]+="[^"]*"/g, ' ')
      // ⑤ 文本节点：标签之间的裸文本（去掉标签本身）
      const textOnly = body.replace(/<[^>]*>/g, '\u0000').replace(/<[^\u0000]*$/g, '\u0000')
      for (const run of textOnly.split('\u0000')) {
        const trimmed = run.trim()
        if (trimmed.length > 0) chunks.push(trimmed)
      }
    }
  }

  // ③ 脚本里的字符串字面量（三种引号）。
  const script = isVue ? (/<script[^>]*>([\s\S]*?)<\/script>/.exec(source)?.[1] ?? '') : source
  let scriptBody = stripComments(script)
  // ⚠️ console.* 的输出**不是界面文本**（它去终端/DevTools，学生看不到）。
  //    排障话本来就该写在 console 里，把它们算成「泄露」会逼着人删掉排障信息。
  scriptBody = scriptBody.replace(/console\.\w+\([^;]*\)/g, ' ').replace(/console\.\w+\([\s\S]*?\)\n/g, ' ')
  // ⚠️ 同一条纪律也适用于**接线诊断**：`api/wiring-notice.ts` 的 `warnWiring(key, detail)`
  //    只把 detail 转给 `console.warn`（凭据见文件末尾「接线诊断只在控制台」那条测试里
  //    对它的函数体做的断言），所以**实参里的方法名 / 通道名 / `window.api`** 都不是界面文本。
  //    ★ 2026-09-22 补这条：这四个桥的接线细节刚从 `*_HINT`（学生会看到的字符串）挪到
  //      `warnWiring(...)` 的实参里 —— 不剥的话，守卫会把「写给接线人的话」当成学生面泄露，
  //      而那种假红的下场通常是把真正有用的排障信息删掉（这正是上面 console 那条注释的教训）。
  scriptBody = scriptBody.replace(/warnWiring\([\s\S]*?\)\n/g, ' ')
  for (const match of scriptBody.matchAll(/'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`]*)`/g)) {
    // ⚠️ 模板字符串里 `${…}` 是**表达式**（`${item.kpId}` 渲染出来是主键的值，
    //    而 `kpId` 这三个字符本身不显示）—— 与 `.vue` 里剥 mustache 是同一个道理。
    //    不剥的话 `nodeLabel(node.name, node.kpId)`、缓存键 `${kpId}#${count}` 全被误报。
    const literal = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[\s\S]*?\}/g, '')
    chunks.push(literal)
  }

  return chunks
}

/** 从 `<script setup>` 起（跳过文件头注释）到文件末尾 —— 用于「只扫渲染内容」。 */

/* ================================================================== *
 * ① 学生视角的可见文本里不得出现开发 / 运维术语
 * ================================================================== */

/**
 * 技术词表。
 *
 * ★ 分两类，因为它们的「豁免方式」不同：
 *   · `TERMS` —— 只要出现在**面向学生的渲染文件**里就要报（除非包在 TeacherGate 内，
 *     见第 ② 条守卫：那里会按行做归属判定）。
 *   · 这里刻意**不列**「函数 / 接口 / 数据」这类中文词：它们在正常教学文案里也会出现
 *     （「这个函数的作用是……」是编程课的内容）。只列**只可能是技术实现**的写法。
 *
 * ⚠️ 加词的门槛：一个词如果学生能合理地在学习语境里读到，就**不要**加进来 ——
 *    误报会让人开始「调松词表」，而调松一次这份守卫就废了。
 */
const TERMS = [
  'SQL',
  'FTS5',
  'WHERE',
  'regex',
  'kp_id',
  'kpId', // 变量的显示形态（模板里 {{ kpId }} 会直接印出来）
  'kb.sqlite',
  'learning.db',
  'Pyodide',
  'nonce',
  'sandboxed',
  'allow-scripts',
  'embedding',
  'Embedding',
  'POST /api',
  'GET /api',
  'HTTP 200',
  'HTTP 4',
  'HTTP 5',
  '端点',
  '契约',
  '兜底',
  '降级链',
  '向量维度',
  '分块',
  '已嵌入',
  '进程号',
  '端口号'
]

/**
 * 允许出现这些词的文件（**逐条写明理由**，不是「技术面文件」这一类的笼统豁免）。
 *
 * ★ 为什么要有这张表而不是「凡是技术文件都跳过」：
 *   这条守卫的价值全在**具体到文件 + 理由**上。笼统豁免等于把守卫关掉 ——
 *   「技术面文件」这个筐一大，真正的泄露（某个视图里夹了一句运维话）就藏在里面了。
 * ★ 每一条都必须回答同一个问题：**这个词会渲染到学生眼前吗？** 答不上来就不该豁免。
 */
const TERM_EXEMPT_FILES = new Set([
  // 教师专用的数据检视页（`PAGES.knowledge.nav === 'teacher'`，学生侧栏里进不去，守卫 ③ 钉着）
  'views/Knowledge.vue',
  // 取数层：只把契约字段搬进 store，自己一个字都不渲染
  'stores/knowledge.ts',
  'stores/settings.ts',
  'stores/sidecar.ts',
  'api/events.ts',
  'api/http.ts',
  /**
   * ★★ `api/settings.ts` 的豁免理由 2026-09-23 **实测重写**（旧理由「自己一个字都不渲染」已不成立：
   * 它现在有学生可见的桥缺失提示，也持有渲染在设置页上的标签）。拿掉它试过 —— 这条守卫会红 4 处，
   * 那 4 处**两类都不在学生眼前**，两类都由下面「豁免必须名副其实」里的凭据逐条兑现：
   *   ① 类型名字符串 `components['schemas']['EmbeddingConfig']`（**类型索引**，一个字都不渲染）；
   *   ② 嵌入模式的中文标签（`EMBEDDING_MODE_LABELS`）：只在设置页**高级设置**区渲染
   *      （`viewMode.isTeacher` 或学生主动点开才出现 —— 与 `views/Settings.vue` 的豁免同一性质）。
   * ⚠️ 谁把这两类搬到别处（例如把标签挪进学生那一节），下面那条凭据会立刻变红。
   * ★ 同批 `api/data.ts` 已从名单里**删掉**（实测：拿掉后这条守卫仍全绿 —— 它剩下的串只有
   *   学生话与 `warnWiring` 实参，后者按控制台通路被剥离）。
   */
  'api/settings.ts'
])

/**
 * 逐条豁免：`文件 → 词 → 理由`。
 *
 * ⚠️ 加一条前先问：**这个字符串真的到不了学生眼前吗？** 「大概是给模型看的」不算理由 ——
 *    要能指出它只出现在哪条不渲染的通路上。
 * ★ 表按**文件**算条目（同一文件的多条理由通常相同），并且**条数被断言钉住**：
 *   这张表一旦长大，这条守卫就变成了它的豁免清单。
 * ⚠️ **按文件豁免有一个已知的弱化**（复审指出，已补第二条守卫）：
 *    它放行的是「这个词在这个文件里任何位置」，而理由说的往往是「它只在某一节里」。
 *    所以凡是以「它只在 <某块区域> 里」为由豁免的文件，都必须再有一条断言钉住
 *    **那块区域确实存在且确实把它包住**（见下面「豁免必须名副其实」那条）。
 */
const TERM_EXEMPT = [
  {
    file: 'components/rail-evidence.ts',
    terms: ['Embedding', 'FTS5', '兜底', 'SQL', 'WHERE'],
    why:
      '这是**专门收教师 / 答辩证据文本**的模块（本轮新建）：四级降级链的档位名、学段隔离那句硬边界原文。' +
      '它只被 `<TeacherGate>` 包着渲染，一个字都没删 —— 单独成文件就是为了让**本文件的扫描零豁免**：' +
      '实测把技术原句塞进学生那一半时，豁免版的守卫照样绿（所以按文件豁免是错的，按模块归属才对）。' +
      '凭据由「右栏的豁免必须真的有 TeacherGate 兜着」那条守卫提供。'
  },
  {
    file: 'views/Settings.vue',
    terms: ['embedding', '端点', '向量维度', 'SQLite', 'SQL', '端口号', '进程号', '降级链', '分块'],
    why:
      '这些串全部位于「高级设置（教师 / 答辩）」区（`v-if="advancedVisible"`）：供应商 BaseURL / APIKey、嵌入模型、隐私与本地服务。' +
      '★ 这是**刻意的取舍**（决策记录见 `docs/report-material/decisions.md` 的「双视角」）：' +
      '供应商可自定义是赛题硬性要求，不能删；但它不该默认摊在学生面前。' +
      '所以判据不是「学生永远读不到」，而是「学生日常使用不会撞见」—— 开关是防误入，不是权限（本应用没有账号体系）。' +
      '⚠️ 本条豁免**必须**配「豁免必须名副其实」那条守卫：它钉住高级区真的存在、且这些词真的落在它里面。'
  },
  {
    file: 'cards/coding.ts',
    terms: ['kpId'],
    why:
      '这是**发给模型的 wire 文本**（`buildHintRequestMessage` 等）。给学生看的是 `hintRequestDisplayText()`／`runRequestDisplayText()`，' +
      '二者分离由守卫 ⑥ 钉着；回看历史也过 `codingUserTextDisplay()`。'
  },
  {
    file: 'cards/quiz.ts',
    terms: ['kpId'],
    why: '同上：`buildQuizSubmissionMessage` 是 wire 文本，展示走 `quizSubmissionDisplayText()`'
  },
  {
    file: 'sandbox/iframe-host.ts',
    terms: ['allow-scripts'],
    why: '沙箱属性的**取值常量**（`SANDBOX_ATTRIBUTE`），写在 iframe 的 `sandbox` 属性里，不是文案'
  },
  {
    file: 'sandbox/pyodide-runner.ts',
    terms: ['Pyodide'],
    why:
      '只有 console 排障话与内部错误对象（`console.error` 已被 `visibleText()` 排除，这里剩下的是带 Pyodide 字样的内部标识）。' +
      '★ 界面上的那句已改成学生话（`failure` 变量）—— 这正是走查抓到的那条「请检查 <renderer>/pyodide/ 下的本地资源是否完整」。'
  },
  {
    file: 'sandbox/pyodide.worker.ts',
    terms: ['Pyodide'],
    why: '同上：Worker 内部的日志与错误构造；发给界面的 `failure` 文案已改为学生话'
  },
  {
    file: 'stores/ui.ts',
    terms: ['分块'],
    why: '教师专属页（教材知识库）的副标题**元数据**；学生视角下侧栏不渲染它（守卫 ③ 钉着 nav === \'teacher\'）'
  }
]

test('★★ 学生视角的文件里不得出现开发者术语（源码级，全文扫描）', () => {
  // 先钉住豁免表本身：它一旦长大，这条守卫就退化成「豁免清单」
  assert.ok(
    TERM_EXEMPT.length <= 8,
    `逐条豁免已经有 ${TERM_EXEMPT.length} 个文件 —— 超过 8 个说明多半是「改文案」被换成了「加豁免」。` +
      '正确的处置是让那些字符串真的到不了学生眼前（包 TeacherGate / 换成学生话）。'
  )
  for (const entry of TERM_EXEMPT) {
    assert.ok(entry.why.length >= 40, `${entry.file} 的豁免理由太短 —— 要写清「它为什么到不了学生眼前」`)
    assert.ok(entry.terms.length > 0, `${entry.file} 的豁免没写词`)
  }

  const hits: string[] = []
  for (const file of rendererFiles()) {
    const name = rel(file)
    if (TERM_EXEMPT_FILES.has(name)) continue
    // 教师视角专属组件自己就是放技术词的地方，跳过
    if (name === 'components/TeacherGate.vue') continue

    const source = readFileSync(file, 'utf8')
    // ⚠️ 只看「会渲染出来的文本」（见 `visibleText()` 的说明）——
    //    第一版扫全文，把 `record.kpId` 这种属性名报了 450 次，全是假阳性。
    for (const text of visibleText(file, source)) {
      for (const term of TERMS) {
        if (!text.includes(term)) continue
        const exempt = TERM_EXEMPT.some((entry) => entry.file === name && entry.terms.includes(term))
        if (exempt) continue
        hits.push(`${name} 出现「${term}」 → ${text.trim().slice(0, 110)}`)
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    '这些技术词会直接渲染给学生（或它的译文）。处置方式二选一：\n' +
      '  ① 包进 <TeacherGate>…</TeacherGate>（教师 / 答辩视角才显示）；\n' +
      '  ② 换成学生话（例：「隔离在 SQL 层强制」→「只会用你学段和更低的教材，不会超纲」）。\n' +
      `命中 ${hits.length} 处：\n  ${hits.join('\n  ')}`
  )
})

test('★★ 豁免必须名副其实：被豁免的词要真的落在「只给技术视角」的那块区域里', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 为什么必须有这一条（复审实测出来的漏洞，别删）
  // ══════════════════════════════════════════════════════════════════════
  // 上面那条守卫对 `views/Settings.vue` 是**按文件**豁免的，而豁免理由说的是
  // 「这些词只在高级区里」。实测：往**学生那一节**（学段区块）塞一句
  // 「端口号 8756，向量维度 512」，上面那条守卫**照样绿** ——
  // 因为它的判据是「这个词在这个文件里被豁免了」，而不是「这个词在这块区域里」。
  //
  // 按文件豁免本身是有意的（逐词豁免会膨胀成一张 9 条 × 2 文件的表），
  // 但**理由必须被另一条断言兑现**，所以这里做三件事：
  //   ① 高级区真的存在，且真的是 `v-if="advancedVisible"`（不是被谁改成恒真/恒假）；
  //   ② 那些被豁免的词**确实出现在高级区那一段源码里**（不是出现在学生那半）；
  //   ③ 学生那半（学段 / 章节 / 主题三节）里**没有**这些词。
  // 三条一起，才等价于「按区域豁免」——而区域是被钉住的。
  const settings = read('src', 'renderer', 'src', 'views', 'Settings.vue')
  const code = stripComments(settings)

  // ① 高级区存在且由唯一的判据控制。⚠️ 用「不是恒真」的写法钉住：
  //    `v-if="true || advancedVisible"` 这种「为了调试打开」的改动会让下面变红。
  const advancedAt = code.indexOf('data-testid="settings-advanced"')
  assert.ok(advancedAt > 0, '设置页必须有高级设置区（data-testid="settings-advanced"）')
  const advancedOpen = code.slice(Math.max(0, advancedAt - 600), advancedAt)
  assert.match(
    advancedOpen,
    /v-if="advancedVisible"/,
    '高级区必须由 `advancedVisible` 控制 —— 写成恒真（`v-if="true || …"`）就等于把它摊给学生了'
  )

  // ② 被豁免的词确实在高级区那一段里。
  //    ⚠️ 切法用「高级区起点 → 区域内最后一个分节的结束」，不假设它是 `<section>`：
  //    实测它是个 `<div>`（`<section v-if="advancedVisible" class="adv">` 之外还套了一层），
  //    写 `</section>` 会切到错误的边界（甚至切出一段空串，让断言静默通过）。
  const advancedEnd = code.indexOf('<!-- ── 高级设置结束', advancedAt)
  const advancedRegion =
    advancedEnd > advancedAt
      ? code.slice(advancedAt, advancedEnd)
      : // 没有结束标记时退回「一直到文件末尾的最后一个 </template>」——
        // 宁可扫多（可能把学生那半也扫进来，那样下面的断言会假红、逼着人补标记）
        code.slice(advancedAt, code.lastIndexOf('</template>'))
  for (const term of ['BaseURL', 'API Key', '向量维度', 'SQLite']) {
    assert.ok(
      advancedRegion.includes(term),
      `「${term}」应当落在高级区里（它就是那段被豁免的内容）—— 若它搬走了，豁免理由也要跟着改`
    )
  }

  // ③ 学生那三节（学段 / 教材章节 / 外观主题）里不许有这些词。
  //    定位方式：分别取三个 learner 分节的 `data-section` 到它的闭合标签之间。
  for (const section of ['grade', 'chapter', 'theme']) {
    const at = code.indexOf(`data-section="${section}"`)
    if (at < 0) continue
    const end = code.indexOf('</SurfacePanel>', at)
    const region = code.slice(at, end > at ? end : at + 4000)
    // ⚠️ 只查「学生读到会困惑」的那几个：`SQL`/`端口号` 这类运维词
    for (const term of ['SQL', '端口号', '进程号', '向量维度', '已嵌入', 'kb.sqlite', 'BaseURL', 'API Key']) {
      assert.ok(
        !region.includes(term),
        `学生那一节「${section}」里出现了「${term}」—— 它属于高级区（豁免只覆盖高级区，不是整个文件）`
      )
    }
  }

  // ④ 同理钉住「教材知识库」页的整体定位：它虽然整页都是技术面，但**导入 / 重建**
  //    这两个真功能不能因为「反正教师才看」而被删掉（删了就是 D-040 那个坑：
  //    做了却进不去的功能等于没做）。判据落在**按钮的点击处理器**上 ——
  //    「文件里出现过 `rebuild`」会被 store 的引用喂饱（复审实测：把两个按钮整段删掉，
  //    旧判据照样绿，因为 store 里还有 `knowledge.rebuild()`）。
  const kb = stripComments(read('src', 'renderer', 'src', 'views', 'Knowledge.vue'))
  assert.match(
    kb,
    /@click="rebuild"/,
    '「重建索引」必须有按钮真的接上（`@click="rebuild"`）—— 只有 store 里有这个方法不算'
  )
  assert.match(
    kb,
    /@click="fileInput\?\.click\(\)"/,
    '「导入教材」必须有按钮真的接上（打开文件选择框）'
  )
  assert.match(kb, /导入教材/, '两个按钮的可见文案也要在（教师看得到才谈得上能用）')
  assert.match(kb, /重建索引/, '「重建索引」的文案要在')

  // ⑥ `api/settings.ts` 的豁免（★ 2026-09-23 实测重写理由，见 `TERM_EXEMPT_FILES` 的注释）：
  //    它是**按文件**豁免的，而新理由说的是「命中分两类，两类都不在学生眼前」。
  //    按本仓纪律，这个理由必须被机械兑现 —— 否则它就是一句新的「大概是给人看的」。
  const apiSettingsSource = read('src', 'renderer', 'src', 'api', 'settings.ts')
  const apiSettingsLines = stripComments(apiSettingsSource).split('\n')
  const labelStart = apiSettingsLines.findIndex((line) => line.includes('export const EMBEDDING_MODE_LABELS'))
  const labelEnd = apiSettingsLines.findIndex((line, index) => index > labelStart && line.startsWith('}'))
  assert.ok(labelStart > 0 && labelEnd > labelStart, '`EMBEDDING_MODE_LABELS` 必须还是一个独立的值映射（凭据的锚点）')
  const strayTerms: string[] = []
  for (const chunk of visibleText('api/settings.ts', apiSettingsSource)) {
    const terms = ['Embedding', 'embedding', '兜底', '端点', '契约', '分块', '已嵌入', '进程号', '端口号'].filter((term) =>
      chunk.includes(term)
    )
    if (terms.length === 0) continue
    const where = apiSettingsLines.findIndex((line) => line.includes(chunk))
    const isTypeIndex = where >= 0 && apiSettingsLines[where].includes("components['schemas']")
    const isModeLabel = where > labelStart && where < labelEnd
    if (!isTypeIndex && !isModeLabel) {
      strayTerms.push(`${terms.join('/')} → ${chunk.slice(0, 80)}（第 ${where + 1} 行）`)
    }
  }
  assert.deepEqual(
    strayTerms,
    [],
    'api/settings.ts 里出现了「既不是类型索引、也不在 EMBEDDING_MODE_LABELS 里」的技术词 ——\n' +
      '那说明豁免理由（两类都不在学生眼前）不再成立：要么把它挪走，要么重写这条豁免的理由与凭据'
  )
  // ② 那一类的兑现：标签只在设置页的**高级区**渲染，且别处不许消费
  const settingsView = stripComments(read('src', 'renderer', 'src', 'views', 'Settings.vue'))
  assert.ok(settingsView.includes('EMBEDDING_MODE_LABELS['), '嵌入模式标签必须仍由设置页渲染（否则豁免该删）')
  assert.ok(
    settingsView.indexOf('EMBEDDING_MODE_LABELS[') > settingsView.indexOf('data-testid="settings-advanced"'),
    '嵌入模式标签必须在**高级区**里渲染（学生默认看不到 —— 这正是豁免的理由）'
  )
  for (const file of rendererFiles()) {
    const name = rel(file)
    if (name === 'api/settings.ts' || name === 'views/Settings.vue') continue
    assert.ok(
      !readFileSync(file, 'utf8').includes('EMBEDDING_MODE_LABELS'),
      `${name} 也消费了 EMBEDDING_MODE_LABELS —— 那「只在高级区」这条豁免理由就不成立了`
    )
  }
})

test('★★ 右栏的豁免必须真的有 `<TeacherGate>` 兜着（免得豁免变成后门）', () => {
  // 上一个测试放行了 ContextRail 里的技术词，理由是「它们在 TeacherGate 里」。
  // 这条守卫就是那个理由的凭据：**没有 gate 就不许豁免**。
  // （改法示例：把 DEGRADE_LEVELS 搬出 gate 渲染 → 这条不会红，但上一个测试会；
  //   把 gate 删掉而技术词留在原处 → 两个都会红。所以两条要一起看。）
  const rail = read('src', 'renderer', 'src', 'components', 'ContextRail.vue')
  assert.match(rail, /import TeacherGate from '\.\/TeacherGate\.vue'/, '右栏必须真的引了 TeacherGate')
  assert.ok(
    (rail.match(/<TeacherGate/g) ?? []).length >= 3,
    '降级链 / 工具轨迹 / 学段原始信号 三块都必须有各自的 gate（实测至少 3 处）'
  )

  // 学生版本必须同时存在（只 gate、不给学生替代说法 = 学生那边空了一块）
  assert.match(rail, /studentText/, '隔离说明必须有学生版本（`studentText`）')
  assert.match(rail, /basisSentence|answer-basis/, '必须有「本次参考了…」这类学生能读懂的说明')

  // Settings 的豁免同理：高级区必须真的存在，且默认与学生隔开
  const settings = read('src', 'renderer', 'src', 'views', 'Settings.vue')
  assert.match(settings, /advancedVisible/, '设置页必须有「高级区是否可见」这一个判据')
  assert.match(
    settings,
    /viewMode\.isTeacher\s*\|\|\s*viewMode\.advancedOpen|advancedOpen\s*\|\|\s*viewMode\.isTeacher/,
    '高级区可见性 = 教师视角，或学生主动点开（两个条件二选一）'
  )
})

test('★★ 学生视角的可见文本里不得出现原始 kp slug（ai-definition-jr 这种）', () => {
  // 形态：<slug>-<学段后缀>，学段后缀恰好四个 —— 这是本仓 kp_id 的构造规则
  // （`server/scripts/import_knowledge.py` 的 SLUGS + `-pl|-ph|-jr|-sr`）。
  const SLUG = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+-(?:pl|ph|jr|sr)\b/g
  const hits: string[] = []
  for (const file of rendererFiles()) {
    const name = rel(file)
    if (TERM_EXEMPT_FILES.has(name)) continue
    const source = readFileSync(file, 'utf8')
    for (const text of visibleText(file, source)) {
      const found = text.match(SLUG)
      if (found) hits.push(`${name} → ${found.join('、')}（出现在：${text.trim().slice(0, 80)}）`)
    }
  }
  assert.deepEqual(
    hits,
    [],
    'kp_id 是数据库主键，学生看不懂（走查原话：「立刻隐藏所有 ID，只展示知识点的中文标题」）。\n' +
      '取名字的唯一口径是 `study/kp-label.ts` 的 `kpLabel()`／`knowledge.kpNameOf()`；\n' +
      '取不到名字时给中性标签或整条不渲染，**不要回落成 id**。\n' +
      `命中 ${hits.length} 处：\n  ${hits.join('\n  ')}`
  )
})

/* ================================================================== *
 * ② 双视角的机制本身：默认必须是学生视角
 * ================================================================== */

test('★★ 默认视角必须是学生，且切换入口只在设置页', () => {
  const store = read('src', 'renderer', 'src', 'stores', 'viewMode.ts')

  // ① 默认值：判错方向的代价不对称 —— 判成学生视角只是评委多按一下开关，
  //    判成教师视角则是学生直接撞见一堆运维术语。
  //    判据是**行为**（只有明确等于 'teacher' 才走 teacher 分支），不是某一行的写法：
  //    注释里引用了这句话、或者写成 if/else，都不该让守卫变红或变绿。
  const readFn = store.slice(
    store.indexOf('export function readStoredViewMode'),
    store.indexOf('export function readStoredViewMode') + 700
  )
  assert.match(readFn, /===\s*'teacher'/, '必须显式比较存下来的值等不等于 teacher')
  assert.match(readFn, /\?\s*'teacher'/, '等于 teacher 才返回 teacher')
  assert.match(readFn, /:\s*'student'/, '其余一律 student —— 判错方向代价不对称，默认必须是学生')
  assert.match(readFn, /catch\s*\{[\s\S]{0,120}?'student'/, 'localStorage 读失败也必须回落到学生视角')

  // ② 读取要 try/catch（file:// + 沙箱组合下 localStorage 会抛，不能因此白屏）
  assert.match(readFn, /try\s*\{[\s\S]{0,200}?localStorage/, 'localStorage 访问必须在 try 里')

  // ③ 切换入口只在设置页 —— 顶栏 / 侧栏不许有开关（学生会误触，且顶栏是常驻 chrome）
  for (const file of ['components/AppTopbar.vue', 'components/AppSidebar.vue', 'layouts/AppShell.vue']) {
    const source = stripComments(readFileSync(join(rendererRoot, ...file.split('/')), 'utf8'))
    assert.doesNotMatch(
      source,
      /viewMode\.(?:toggle|set)\(/,
      `${file} 不得直接切换视角（入口只允许在设置页的「高级设置」区）`
    )
  }
})

/* ================================================================== *
 * ③ 教师专属页必须真的进不去（且切回来时能把人带走）
 * ================================================================== */

test('★★ 参考资料库是教师专属页：侧栏判定走唯一谓词，且切回学生视角会把人带走', () => {
  const ui = read('src', 'renderer', 'src', 'stores', 'ui.ts')
  const sidebar = read('src', 'renderer', 'src', 'components', 'AppSidebar.vue')
  const app = read('src', 'renderer', 'src', 'App.vue')

  // ★ 判据必须是**这条页面项的 nav 字段本身**，而不是「文件里出现过 'teacher'」——
  //   后者在文件里任何一处出现都能喂饱它。
  const knowledgeBlock = ui.slice(ui.indexOf('  knowledge: {'), ui.indexOf('  knowledge: {') + 400)
  assert.match(
    knowledgeBlock,
    /nav:\s*'teacher'/,
    "参考资料库必须标成教师专属：`PAGES.knowledge.nav = 'teacher'`（学生侧栏里进不去）"
  )
  assert.match(ui, /nav:\s*boolean\s*\|\s*'teacher'/, "PageMeta.nav 必须是三态联合（true / 'teacher' / false）")

  assert.match(
    ui,
    /export function isTeacherOnlyPage\(/,
    '需要「切回学生视角时把停在教师页的人带走」的判据'
  )

  // 侧栏必须真的调那个谓词（只定义不调 = 页面照旧进侧栏）
  assert.match(
    sidebar,
    /visibleInSidebar\(PAGES\[name\],\s*viewMode\.isTeacher\)/,
    '侧栏的过滤必须调 visibleInSidebar，并把视角传进去'
  )

  // App.vue：切回学生视角要把人从教师专属页带回对话
  const watchAt = app.indexOf('isTeacherOnlyPage(ui.page)')
  assert.ok(watchAt > 0, 'App.vue 必须处理「切回学生视角时停在教师专属页」这一状态迁移')
  const block = app.slice(Math.max(0, watchAt - 500), watchAt + 200)
  assert.match(block, /ui\.go\('chat'\)/, '落点是对话页')
  // 只处理「教师 → 学生」这一个方向（反过来把评委弹走是没道理的）
  assert.match(block, /wasTeacher === true && !isTeacher/, '只在从教师切回学生时触发')
})

test('★★ 上面那些判据必须**真的按三态工作**（不是只看函数在不在）', async () => {
  // ══════════════════════════════════════════════════════════════════════
  // 为什么另起一条（复审实测出来的漏洞）
  // ══════════════════════════════════════════════════════════════════════
  // 上一条守卫全是**源码文本匹配**：它证明「函数存在」「侧栏调了它」，
  // 但**从没执行过它**。实测：把 `visibleInSidebar` 的第一行从
  // `if (meta.nav === true) return true` 改成 `if (meta.nav !== false) return true`
  // —— 三态语义整个塌掉（`'teacher'` 也返回 true，知识库回到学生侧栏），
  // 上一条守卫**照样全绿**（变异验证抓到的）。
  // 所以这里把谓词**当函数调**，用三个代表值把三态钉死。
  const { PAGES, visibleInSidebar, isTeacherOnlyPage } = await import('../src/renderer/src/stores/ui.ts')

  // ① 普通页：两种视角都进侧栏
  assert.equal(visibleInSidebar(PAGES.chat, false), true, '对话页在学生视角下必须可见')
  assert.equal(visibleInSidebar(PAGES.chat, true), true, '对话页在教师视角下也必须可见')

  // ② 教师专属页：**学生视角不可见、教师视角可见**（两侧都要断，少一侧就不算三态）
  assert.equal(
    visibleInSidebar(PAGES.knowledge, false),
    false,
    '学生视角下「参考资料库」**不许**进侧栏（它是数据检视页，含 kb.sqlite 路径与两个破坏性按钮）'
  )
  assert.equal(
    visibleInSidebar(PAGES.knowledge, true),
    true,
    '教师视角下「参考资料库」必须可见（功能没被删，只是默认不给学生看）'
  )

  // ③ `isTeacherOnlyPage` 与它同源
  assert.equal(isTeacherOnlyPage('knowledge'), true, 'knowledge 是教师专属页')
  assert.equal(isTeacherOnlyPage('chat'), false, 'chat 不是教师专属页')
  assert.equal(isTeacherOnlyPage('dependency'), false, '学习地图不是教师专属页（学生会用它）')

  // ④ 反面对照：**没有哪一页会在两种视角下都不可见** ——
  //    那等于做出一个谁都不用的页面（D-040 那个「做了却进不去」的坑）。
  for (const [name, meta] of Object.entries(PAGES)) {
    const anywhere = visibleInSidebar(meta, false) || visibleInSidebar(meta, true)
    if (meta.nav === false) continue // `false` 的页明确不进侧栏，靠别的入口（本项目当前没有这种页）
    assert.ok(anywhere, `「${meta.title}」（${name}）在两种视角下都进不了侧栏 —— 做了却点不到`)
  }
})

/* ================================================================== *
 * ④ 主行动按钮只有一套配方（走查：核心入口颜色 / 大小 / 形状全不一致）
 * ================================================================== */

test('★★ 五处核心主行动按钮必须共用 .k12-cta（而不是各写一份皮肤）', () => {
  const base = read('src', 'renderer', 'src', 'assets', 'base.css')
  assert.match(base, /^\.k12-cta\s*\{/m, '设计系统里必须有 .k12-cta 这一套配方')
  // 禁用态不许用 opacity 压（会掉到不可读）；用实心灰底
  const ctaAt = base.indexOf('.k12-cta {')
  const ctaBlock = base.slice(ctaAt, ctaAt + 1400)
  assert.doesNotMatch(ctaBlock, /opacity/, '禁用态不得靠降低透明度（文字会掉到不可读）')
  assert.match(ctaBlock, /:disabled/, '必须显式给禁用态')
  assert.match(ctaBlock, /min-height/, '高度必须是下限（固定 height 会在大字号下裁字，P-071）')

  // 五处核心入口（右栏两处「去闯关检验」+ 闯关提交 + 编程运行 / 求助 + 依赖图「开始学习」）
  //
  // ⚠️ 判据必须是**类名令牌**，不能是 `source.includes('k12-cta')` ——
  //   后者会被 `k12-cta--mutated` 这种子串喂饱（变异测试当场抓到：
  //   把类名整片改掉，第一版断言照样绿）。
  //   `(?:[^"]*\s)?` 让 `class="k12-cta"` 与 `class="reco__btn k12-cta"` 都算，
  //   `(?![\w-])` 把 `k12-cta--mutated` / `foo-k12-cta` 排除在外。
  const CTA_CLASS = /class="(?:[^"]*\s)?k12-cta(?![\w-])(?:\s[^"]*)?"/g
  const sites: Array<[string, string, number]> = [
    ['components/ContextRail.vue', '右栏「去闯关检验」', 2],
    ['views/Quiz.vue', '闯关页「提交这题」', 1],
    ['views/Coding.vue', '编程页「运行」', 1],
    ['views/Dependency.vue', '依赖图「开始学习这个知识点」', 1]
  ]
  for (const [file, label, expected] of sites) {
    // ⚠️ 用 join(rendererRoot, …) 而不是 read(...)：`read()` 自己会拼 desktopRoot，
    //    再传一个绝对路径进去会拼成 `…/desktop/E:\…`（第一版就这么错的）。
    const source = readFileSync(join(rendererRoot, ...file.split('/')), 'utf8')
    const hits = (source.match(new RegExp(CTA_CLASS, 'g')) ?? []).length
    assert.ok(
      hits >= expected,
      `${label}（${file}）必须用 .k12-cta 类（实测 ${hits} 处，至少 ${expected} 处）—— ` +
        '走查结论是「最重要的操作入口在颜色/大小/形状上完全不一致」，新增主行动入口时抄第六份皮肤必然又漂移一次'
    )
  }
})

test('★★ 教师 / 答辩视角的**原始证据一个字都没丢**（反向对照）', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 这条守卫存在的理由：上面那条「学生视角不得出现技术词」**天然有一个坏解法** ——
  // 把技术串全删掉，字面上也能让它变绿（而且更容易）。
  // 但那些串是「设计合理性」25% 的证据：四级降级链、工具调用轨迹、
  // 学段判定原始信号、SQL 层隔离说明、知识库统计。删掉它们等于把答辩材料删了。
  //
  // 所以这里做**反向断言**：它们必须仍然存在于**教师视角能到的地方**。
  // 两条守卫一起看，才是「分视角」而不是「删信息」：
  //   · 学生视角出现 → 上一条变红；
  //   · 谁都没了     → 这一条变红。
  // ⚠️ 变异验证：把 `rail-evidence.ts` 里的档位名换成学生话，这一条会红。
  // ══════════════════════════════════════════════════════════════════════
  const rail = read('src', 'renderer', 'src', 'components', 'ContextRail.vue')
  const evidence = read('src', 'renderer', 'src', 'components', 'rail-evidence.ts')

  // ① 四级降级链（vector → cloud → fts → outline）四档名都在
  for (const level of ['vector', 'cloud', 'fts', 'outline']) {
    assert.ok(evidence.includes(`'${level}'`), `降级链少了 ${level} 这一档 —— 它是四级降级链的证据`)
  }
  for (const label of ['向量检索', 'Embedding', 'FTS5', '依赖图']) {
    assert.ok(evidence.includes(label), `降级链档位名少了「${label}」（答辩要看的就是这四个词）`)
  }

  // ② 学段隔离那句**硬边界原文**（含 SQL / WHERE）仍在
  assert.match(
    evidence,
    /隔离在 SQL 层强制，模型改不了 WHERE/,
    '「隔离在 SQL 层强制」是架构边界的直接证据，必须留在教师视角可到的地方'
  )

  // ③ 工具轨迹那句「四条强制在代码层」仍在
  assert.match(evidence, /代码层强制/, '「路由由模型自选；学段隔离、参数校验、内容终审均在代码层强制」必须保留')

  // ④ 右栏确实把这三块都渲染在 gate 里（不是只定义不渲染）
  assert.ok((rail.match(/<TeacherGate/g) ?? []).length >= 3, '降级链 / 工具轨迹 / 学段信号三块都要有 gate')
  assert.match(rail, /degradeChain/, '降级链的数据通路仍在（只改「默认给谁看」，不改数据）')
  assert.match(rail, /DEGRADE_LEVELS/, '档位表仍被引用')
  assert.match(rail, /TRACE_TEACHER_NOTE/, '轨迹说明仍被引用')
  assert.match(rail, /isolationTeacherText/, '隔离原文仍被引用')

  // ⑤ 知识库页（教师专属）的统计与路径读数还在
  const kb = read('src', 'renderer', 'src', 'views', 'Knowledge.vue')
  const kbCode = stripComments(kb)
  assert.match(kbCode, /kbPath|stats\.kbPath/, '知识库页仍要能读出库文件位置（数据检视的用途）')
  assert.match(kbCode, /knowledge\.rebuild|rebuild/, '「重建索引」能力不能被删（它是真实功能）')
  assert.match(kbCode, /knowledge\.import|importKnowledge|import.*file/, '「导入教材」能力不能被删')
  assert.match(kbCode, /kpId|kp_id/, '知识点表仍要有 id 列（教师排障要看）')
  assert.match(kbCode, /embedded|已嵌入|未嵌入/, '向量索引状态仍要能看到')
})

/* ================================================================== *
 * ⑤ 内容安全提示不得把规则细节印给学生
 * ================================================================== */

test('★★ 安全拦截提示只给学生一句人话，规则 id / 正则不进界面', () => {
  const notice = read('src', 'renderer', 'src', 'components', 'BlockedNotice.vue')

  // 后端 reason 的形态是「命中内容安全规则：越狱/绕过规则（regex:reveal_system_prompt）」——
  // 它既吓学生（「越狱」），又把防御策略交代给试图绕过的人。
  assert.match(
    notice,
    /BLOCKED_STUDENT_NOTICE/,
    '学生看到的那句必须取自 labels.ts 的 BLOCKED_STUDENT_NOTICE（唯一来源）'
  )
  const reasonAt = notice.indexOf('{{ notice.reason }}')
  assert.ok(reasonAt > 0, 'reason 仍然要展示（给老师 / 评委），只是不该在学生视角')
  const around = notice.slice(Math.max(0, reasonAt - 400), reasonAt + 120)
  assert.match(
    around,
    /TeacherGate/,
    'reason 必须包在教师视角里 —— 否则「regex:reveal_system_prompt」会直接印给学生'
  )
  // ⚠️ 判据取 `{{ notice.reason }}`（模板里的渲染点）而不是裸 `notice.reason`：
  //    后者第一次出现在**文件头的注释**里（讲这段为什么不能给学生看），
  //    拿它当锚点会让「注释在 template 之前」这件事决定断言方向（第一版就这么写错了）。
  assert.doesNotMatch(
    notice.slice(0, reasonAt).split('</script>').pop() ?? '',
    /\{\{\s*notice\.reason/,
    '学生那一半不许再出现第二处 reason 渲染',
  )

  // labels.ts 里那句人话不许自带技术词
  const labels = read('src', 'renderer', 'src', 'labels.ts')
  const constAt = labels.indexOf('BLOCKED_STUDENT_NOTICE')
  const line = labels.slice(constAt, constAt + 220)
  for (const bad of ['regex', '规则', '命中', '拦截', '越狱']) {
    assert.ok(!line.includes(bad), `BLOCKED_STUDENT_NOTICE 里不得出现「${bad}」`)
  }
})

/* ================================================================== *
 * ⑥ 求助指令与用户气泡必须分离（走查：把 AI 的「底牌」印在学生自己的气泡里）
 * ================================================================== */

test('★★ 发给模型的指令不得原样渲染成学生气泡', () => {
  const coding = read('src', 'renderer', 'src', 'cards', 'coding.ts')

  // wire 文本必须一字不动地保留（模型行为不能因为「界面好看」而变弱）
  assert.match(
    coding,
    /不要直接给我完整答案/,
    'buildHintRequestMessage 仍必须把「不要直接给答案」的约束交给模型'
  )
  assert.match(coding, /get_coding_hint/, '仍然要指名 Tool（否则模型可能自己写答案）')

  // 显示文本必须另有其人
  assert.match(
    coding,
    /export function hintRequestDisplayText\(/,
    '必须有一个「给学生看的那句话」的函数 —— 否则学生气泡里就是那句内部指令'
  )
  // 显示文本里不许带 Tool 名 / 内部 kp_id
  const at = coding.indexOf('export function hintRequestDisplayText(')
  const body = coding.slice(at, at + 400)
  assert.doesNotMatch(body, /get_coding_hint/, '学生那句话里不许出现 Tool 名')
  assert.doesNotMatch(body, /kpId|kp_id/, '也不许带上内部知识点 id')

  // store 的发送口必须能分别收到两段文本
  const store = read('src', 'renderer', 'src', 'stores', 'chat.ts')
  assert.match(
    store,
    /studentFacingMessages|studentFacingUserText/,
    '恢复历史时也要过一遍翻译（JSONL 里存的是 wire 原文，回看会重新印出来）'
  )
})

/* ================================================================== *
 * ⑦ 导出必须走原生保存对话框，且文件名是人话
 * ================================================================== */

test('★★ 导出文件名用品牌名 + 日期，不含 slug / 开发者词；且走主进程的保存对话框', () => {
  const dep = read('src', 'renderer', 'src', 'views', 'Dependency.vue')
  // ⚠️ 先剥注释：文件里**刻意**引用了旧名字（「之前是 `dependency-edges-junior.csv`，
  //    界面语言是中文，文件名却是英文 slug」）—— 那是决策记录，不该让断言变红。
  const depCode = stripComments(dep)

  // 走查原句：文件名 `dependency-edges-junior.csv` 暴露了内部的命名法
  assert.doesNotMatch(
    depCode,
    /dependency-edges/,
    '导出文件名不得再出现 dependency-edges（学生会拿去 Excel 却不知道那是什么）'
  )
  assert.match(depCode, /BRAND_NAME/, '文件名要带品牌名（唯一来源 @shared/brand，不要写字面量）')
  assert.match(depCode, /学习地图/, '文件名要能自解释')

  // 不许再走 blob + <a download>（Electron 里会冒出 blob:http://localhost… 的原生保存框）
  assert.doesNotMatch(
    depCode,
    /createObjectURL/,
    '不得再用 URL.createObjectURL 走浏览器下载（截图里那个 blob: 保存框就是它）'
  )
  assert.match(
    depCode,
    /exportMarkdown|file:export|fileExport/,
    '必须复用已有的 file:export 通道（主进程 dialog.showSaveDialog）'
  )

  // 主进程侧：扩展名白名单，且 .md 的既有行为一个都不能变
  const naming = read('src', 'main', 'study', 'export-naming.ts')
  assert.match(naming, /EXPORT_EXTENSIONS/, '扩展名必须走白名单（不能由渲染进程随便指定）')
  assert.match(naming, /'\.csv'/, '要允许 .csv')
  assert.match(
    naming,
    /DEFAULT_EXPORT_EXTENSION:\s*ExportExtension\s*=\s*'\.md'/,
    '默认扩展名必须仍是 .md（`study-bridge.test.ts` 的 20 条都按 .md 钉着）'
  )

  // 编程页的「下载代码」也一样（它原来也是 Blob + <a download>）
  const coding = stripComments(read('src', 'renderer', 'src', 'views', 'Coding.vue'))
  assert.doesNotMatch(coding, /createObjectURL/, '编程页下载代码也不得走 blob')
  assert.match(coding, /exportMarkdown/, '编程页下载要走同一条 file:export 通道')
})

/* ================================================================== *
 * ⑧ 错题本必须会刷新（走查：答错之后错题本还是空的）
 * ================================================================== */

test('★★ 判分之后错题本必须失效重拉（缺陷根因是「读侧只拉一次」）', () => {
  const store = read('src', 'renderer', 'src', 'stores', 'study.ts')
  const view = read('src', 'renderer', 'src', 'views', 'Study.vue')

  // 根因：写侧一直是好的（每次判分都往 learning_history 写一行），
  // 是读侧只在 onMounted 拉一次，而页面被 KeepAlive 缓存 → 回来后还是旧快照。
  assert.match(
    store,
    /export function invalidateMistakes|function invalidateMistakes|invalidateMistakes\(\)/,
    '必须有一个「把错题本标记为过期」的入口'
  )
  assert.match(store, /mistakesStale/, '过期要有一个真的标记（不是靠调用方记得传 force）')
  assert.match(
    view,
    /^onActivated\(/m,
    'Study.vue 必须在 onActivated 重新取数 —— KeepAlive 下组件不会重挂，onMounted 只跑一次'
  )
  // ⚠️ 锚点用 `^onActivated(`（真正的调用）而不是裸 `onActivated` ——
  //    后者第一次出现在文件头的注释里（讲这件事为什么重要），
  //    拿注释当锚点会让断言在校验一段说明文字（第一版就这么写错了）。
  const activated = view.slice(view.indexOf('\nonActivated('), view.indexOf('\nonActivated(') + 400)
  assert.match(activated, /loadMistakes|loadAll/, 'onActivated 里要真的去取错题本')
  // 判分信号要能触发失效（否则「答完就切回档案页」仍然看到旧快照）
  assert.match(
    view,
    /invalidateMistakes\(\)/,
    'Study.vue 要监听判分信号并失效（只在 onActivated 拉还不够：留在本页时不会触发）'
  )
})

/* ================================================================== *
 * ⑨ 答对之后不许再劝学生「再提交一次」
 * ================================================================== */

test('★★ 答对后提交键必须是禁用的「已完成」；答错才可重试', () => {
  const card = read('src', 'renderer', 'src', 'cards', 'QuizCard.vue')
  const page = read('src', 'renderer', 'src', 'views', 'Quiz.vue')

  for (const [name, source] of [
    ['cards/QuizCard.vue', card],
    ['views/Quiz.vue', page]
  ]) {
    assert.match(source, /function submitLabel\(/, `${name} 必须有单独的「提交键文案」函数（不能挤在一行三元里）`)
    assert.match(source, /function submitDisabled\(/, `${name} 必须有一处禁用判定`)
    const labelAt = source.indexOf('function submitLabel(')
    const disabledAt = source.indexOf('function submitDisabled(')
    const block = source.slice(labelAt, disabledAt + 500)
    assert.match(block, /已完成/, `${name} 答对后按钮文案应是「已完成」`)
    assert.match(
      block,
      /correct/,
      `${name} 禁用判定必须读判分结果的 correct（前端不自己判对错 —— 判分只在后端）`
    )
    // ★ 判据是**「禁用的依据是 correct」**（`submitDisabled` 这个名字里就有 Disabled），
    //   不是字面量 `/disabled/` —— 第一版按字面量断言，被 `submitDisabled` 的大写 D
    //   绊倒，报了一个不存在的缺陷。
    assert.match(
      block,
      /result\??\.?correct\s*===\s*true|correct\s*===\s*true/,
      `${name} 「答对」必须被判成**终态**（=== true），而不是只要答过就禁用`
    )
    // 模板上真的绑上去了（只定义不绑 = 学生还是能连点）
    assert.match(
      stripComments(source),
      /:disabled="submitDisabled\(/,
      `${name} 模板上必须把禁用判定绑到提交键上`
    )
  }

  // 前端不得自己算对错（判分口径只在后端）
  assert.doesNotMatch(
    stripComments(card),
    /answer\s*===|=== \s*question\.answer/,
    '前端不得拿 answer 比对（答案根本不下发；判分只走后端 /api/quiz/grade）'
  )
})

/* ================================================================== *
 * ⑩ 动画模板必须装进自己的 viewBox（走查外还查出的真实缺陷）
 * ================================================================== */

/**
 * 模板几何检查：**画在 viewBox 外面 = 学生看到被裁掉一半的图**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么是「坐标本身越界」这一条判据（而不是「坐标 ± 半径」）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版拿固定半宽（±48 / ±20）去套所有模板的 `x:` / `y:`，结果误报了两个：
 *    · `python-variable` 的 `x: 40`、`train-predict` 的 `x: 24` 是**盒子的左边沿**，
 *      不是中心 —— 它们离左边界 24~40px，而盒子只有几十像素宽，其实完全放得下；
 *    · 而真正的缺陷（决策树 `y: 232` + 半高 15，viewBox 高只有 230）是**中心点本身就在画布外**。
 * 所以「固定半宽」这个判据既会误报（左沿当中心）又会漏报（盒子比固定半宽更宽）。
 * 真正无假阳性的判据是**坐标本身是否落在画布内** —— 中心点在画布外的元素不可能被看见。
 * 元素外沿的溢出由第二条判据覆盖：模板自己声明了节点高度（`h = … ? A : B`）时，
 * 要求「最外沿 + 半高」也在画布内。两条都不依赖任何硬编码的半宽。
 *
 * ★ 这个函数被单元测试**直接喂合成模板**验证（见下面那条 `变异验证`）——
 *   不靠「希望它有用」，而是证明「把决策树那个 bug 塞回去，它真的会红」。
 */
function templateGeometryProblems(templates) {
  /** 几何问题（每条都是「哪个模板、哪个坐标、超出多少」）。 */
  const problems: string[] = []
  for (const { name, body, script } of templates) {
    const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(body ?? '')
    if (!viewBox) continue // 纯 DOM 动画（不走 SVG）不适用
    const width = Number(viewBox[1])
    const height = Number(viewBox[2])

    // ① 坐标本身必须在画布内（中心点在画布外 = 一定看不见）
    const points: Array<{ axis: string; value: number }> = []
    for (const match of (script ?? '').matchAll(/\b([xy]):\s*(-?[\d.]+)/g)) {
      points.push({ axis: match[1], value: Number(match[2]) })
    }
    for (const match of (script ?? '').matchAll(/setAttribute\('(cx|cy)',\s*'?(-?[\d.]+)/g)) {
      points.push({ axis: match[1] === 'cx' ? 'x' : 'y', value: Number(match[2]) })
    }
    for (const point of points) {
      const limit = point.axis === 'x' ? width : height
      if (point.value < -0.5 || point.value > limit + 0.5) {
        problems.push(`${name}: ${point.axis}=${point.value} 落在 viewBox 0 0 ${width} ${height} 之外`)
      }
    }

    // ② 模板自己给了节点高/宽（`h = … ? A : B`）时，连外沿一起算
    const sizeMatch = /var\s+(w|h)\s*=\s*[^;]*?\?\s*(\d+)\s*:\s*(\d+)/.exec(script ?? '')
    if (sizeMatch) {
      const half = Math.max(Number(sizeMatch[2]), Number(sizeMatch[3])) / 2
      const axis = sizeMatch[1] === 'w' ? 'x' : 'y'
      const limit = axis === 'x' ? width : height
      const onAxis = points.filter((point) => point.axis === axis).map((point) => point.value)
      if (onAxis.length > 0) {
        const min = Math.min(...onAxis)
        const max = Math.max(...onAxis)
        if (min - half < -0.5 || max + half > limit + 0.5) {
          problems.push(
            `${name}: ${axis} 范围 ${min - half}…${max + half} 超出 viewBox（半${axis === 'x' ? '宽' : '高'} ${half}）`
          )
        }
      }
    }
  }
  return problems
}

test('★★ 动画模板画的内容必须全部落在自己声明的 viewBox 内', () => {
  const dir = join(desktopRoot, '..', 'server', 'resources', 'templates')
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.ok(files.length >= 8, `模板数量应当至少 8 份（实测 ${files.length}）`)

  const templates = files.map((name) => {
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    return { name, body: String(raw.body ?? ''), script: String(raw.script ?? '') }
  })

  const problems = templateGeometryProblems(templates)
  assert.deepEqual(
    problems,
    [],
    '模板内容超出 viewBox = 学生在默认视图下看到被裁掉一半的图（点「全屏」才看得全，而学生不会去点）。\n' +
      '走查截图里决策树的底部叶子就是这样被切掉的。\n' +
      `命中 ${problems.length} 处：\n  ${problems.join('\n  ')}`
  )
})

test('★★ 上面那条几何检查**真的会红**（变异验证）', () => {
  // 守卫自己也要被验证：把决策树当时的坏几何原样塞进来，检查必须报出来。
  // 没有这一条，一个「永远返回空数组」的实现也能让上一条测试通过。
  const brokenTree = {
    name: 'synthetic-broken-tree',
    body: '<svg viewBox="0 0 460 230"></svg>',
    // 与修复前的 decision-tree 一致：根在 y=34，而**叶子画在 y=232**（画布只有 230 高）
    script:
      "var ROOT = { x: 230, y: 34, yes: { x: 110, y: 110 }, no: { x: 340, y: 188, yes: { x: 190, y: 232 }, no: { x: 350, y: 232 } } };\n" +
      'var h = node.leaf ? 30 : 32;'
  }
  const problems = templateGeometryProblems([brokenTree])
  assert.ok(
    problems.length > 0,
    '把决策树的坏几何塞回去之后检查必须报出来（否则这个守卫形同虚设）'
  )
  assert.match(problems[0], /y=232|超出 viewBox/, `报了但理由不对：${problems[0]}`)

  // 反向对照：修好之后必须放行（防「把判据调成永远报错」）
  const fixedTree = { ...brokenTree, body: '<svg viewBox="0 0 460 268"></svg>' }
  assert.deepEqual(
    templateGeometryProblems([fixedTree]),
    [],
    '修好之后的几何不该再被报出来'
  )
})


/* ================================================================== *
 * ⑫ 「不会上传」这类承诺必须与**同一屏上的按钮**一致（复审抓到的假承诺）
 * ================================================================== */

test('★★ 编程卡片的「不会上传」不许与它自己的「求助」按钮打脸', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 为什么要有这一条（真机上会让学生理解错的一句话）
  // ══════════════════════════════════════════════════════════════════════
  // 编程卡片底下原来写着：「代码在你电脑上的浏览器沙箱里运行，不会上传、
  // 也碰不到学习数据。卡住就点「求助」。」
  // 而**同一张卡片上的「求助」按钮**会把学生代码的前 400 字发给模型
  // （`buildHintRequestMessage` 里的 `codePreview(code)`）。
  // 一个把字面意思当真的 10 岁学生，刚读完「不会上传」就去点「求助」，
  // 会以为求助也是本地的 —— 这是我们**主动写进界面**的误解。
  //
  // ★ 判据不是「不许出现『不会上传』」（那句话本身没错：运行确实只在本机），
  //   而是**它必须与「求助会发代码」这件事同时被说清楚**。
  const card = read('src', 'renderer', 'src', 'cards', 'CodingCard.vue')
  const code = stripComments(card)

  if (/不会上传|不上传/.test(code)) {
    assert.match(
      code,
      /求助[^。]{0,40}(发|上传|看到|看)|(发|上传)[^。]{0,30}团团/,
      '既然写了「不会上传」，就**必须**在同一段里说明「求助会把代码发给团团」——\n' +
        '否则学生读完那句、再点同屏的「求助」，会对「代码有没有离开这台电脑」形成错误认知。\n' +
        '（这是承诺与按钮的一致性，不是措辞偏好。）'
    )
  }

  // 另一半：wire 文本里那个 `codePreview` 是否真的在（判据的来源）。
  // 若哪天求助不带代码了，上面那句话就该改回去 —— 这条断言是那个改动的提醒。
  const coding = read('src', 'renderer', 'src', 'cards', 'coding.ts')
  assert.match(
    coding,
    /buildHintRequestMessage[\s\S]{0,400}?codePreview\(/,
    '「求助带代码」这条事实来自 buildHintRequestMessage 里的 codePreview —— 若它变了，界面文案要跟着改'
  )
})

/* ================================================================== *
 * ⑬ 三张在对话里渲染的卡片：不许把 kp_id / qid 当文字印出来
 * ================================================================== */

test('★★ 对话里的卡片（编程 / 练习 / 进度）不得直接渲染 kp_id 或 qid', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 为什么单列一条：上面那条 slug 扫描**看不见插值**
  // ══════════════════════════════════════════════════════════════════════
  // `visibleText()` 抽的是「静态文本 + 静态属性」，而 `{{ view.kpId }}` 这类
  // **mustache 插值**渲染出来的才是 slug —— 它在源码里是表达式，扫描器把它当表达式剥掉了。
  // 所以凡是「把 id 直接插值出来」的地方，都得靠这一条专门盯住
  // （复审正是这样找到三处漏网的：编程卡的 kp 芯片、练习卡的 qid 芯片、进度卡的关卡名）。
  const cards = [
    ['cards/CodingCard.vue', '编程卡'],
    ['cards/QuizCard.vue', '练习卡'],
    ['cards/ProgressCard.vue', '进度卡']
  ]
  for (const [file, label] of cards) {
    const code = stripComments(readFileSync(join(rendererRoot, ...file.split('/')), 'utf8'))
    // ① 不许有 `{{ xxx.kpId }}` / `{{ xxx.qid }}` 这类「把内部 id 直接渲染出来」的模板。
    //    ⚠️ 判据必须精确到「**这个插值的输出就是 id 本身**」：
    //       · `{{ view.kpId }}`          → 输出就是 slug，**报**；
    //       · `{{ levelName(level.kpId) }}` → 输出是解析后的中文名，**不报**
    //         （第一版用 `[^}]*\.kpId` 宽匹配，把后者也报出来了 —— 假阳性，白排查一轮）。
    //       所以正则要求花括号里**除了那个属性访问什么都没有**。
    //    ⚠️ 教师视角里的插值不算（那是分视角的落点：原始 id 正是给老师 / 评委看的）。
    const direct: string[] = []
    const lines = code.split('\n')
    for (const [index, line] of lines.entries()) {
      if (!/\{\{\s*[A-Za-z_$][\w$]*\.(?:kpId|qid)\s*\}\}/.test(line)) continue
      const context = lines.slice(Math.max(0, index - 4), index + 1).join('\n')
      if (/viewMode\.isTeacher|<TeacherGate/.test(context)) continue
      direct.push(line.trim())
    }
    assert.deepEqual(
      direct,
      [],
      `${label}（${file}）把内部 id 直接渲染出来了：${direct.join('、')}\n` +
        '学生看到的是数据库主键（`ai-definition-jr` / `gen-ai-definition-jr-…`）。\n' +
        '改用 `study/kp-label.ts` 的中文名；取不到就不渲染那一格，**绝不回落成 id**。'
    )
    // ② 名字必须走共用口径（有 `kpLabel` 就说明取了名字；三张卡都该有）
    assert.match(
      code,
      /kpLabel/,
      `${label} 必须用 \`study/kp-label.ts\` 的共用口径取名字（别在本组件另写一份兜底）`
    )
  }
})

/* ================================================================== *
 * ⑭ 历史回看的**三条路**都要过学生版译文
 * ================================================================== */

test('★★ 回看历史的三条路都必须过学生版译文（漏一条就从后门漏出内部指令）', () => {
  // JSONL 里存的是**发给模型的原文**（它本来就该存原文），所以任何「把历史正文渲染出来」
  // 的地方都要过一遍翻译，否则学生会在自己的气泡里读到内部指令与嵌着 slug 的题目编号。
  // 已知的三条路：① 对话页冷启动恢复 ② 对话页切换/分叉 ③ 学习档案 →「历史会话」回看。
  // ⚠️ ③ 曾经漏着（复审实测）：那条路直接渲染主进程投影的 `message.text`。
  const chat = read('src', 'renderer', 'src', 'stores', 'chat.ts')
  assert.match(
    chat,
    /function studentFacingUserText\(/,
    '翻译的实现必须在（唯一一份）'
  )
  assert.match(
    chat,
    /export[\s\S]{0,40}studentFacingUserText|studentFacingUserText\s*\n?\s*[,}]/,
    '翻译函数要**导出**给别的回看路径用（否则每条路都得自己再写一份）'
  )
  // ① ② 对话页内部两处恢复：`session:state`（冷启动）与 `openSession`/`startNewSession`/`branchSession`。
  //    ⚠️ 数的是**调用**（`studentFacingMessages(`），不含定义那一行
  //    （定义写作 `function studentFacingMessages<T extends …>(`，带泛型参数，不该被算进来）。
  const restoreCalls = (chat.match(/[^a-zA-Z]studentFacingMessages\(/g) ?? []).length
  assert.ok(
    restoreCalls >= 2,
    `对话 store 里两处恢复都要过翻译（冷启动 + 切换/分叉），实测 ${restoreCalls} 处`
  )

  // ③ 档案页的历史会话回看
  //
  // ⚠️ **必须剥注释再断言**：那个文件的注释里**刻意**引用了 `studentFacingUserText`
  //   （「翻译的唯一实现是 stores/chat.ts 的 studentFacingUserText」）——
  //   不剥的话，把真正的调用删掉、注释留着，守卫照样绿（变异验证当场抓到这个假绿）。
  //   而且判据要落在**调用形状**上，不是「文件里出现过这个名字」。
  const sessions = stripComments(read('src', 'renderer', 'src', 'study', 'SessionsTab.vue'))
  assert.match(
    sessions,
    /chat\.studentFacingUserText\(/,
    '「历史会话」回看必须**真的调用**译文 —— 这条路漏过：' +
      '学生在档案页又能读到「请用 submit_quiz…」与 gen-* 题号（只留注释不算修好）'
  )
})

/* ================================================================== *
 * ⑮ 存疑的失败文案：交给学生前必须过面向学生的翻译
 * ================================================================== */

test('★★ 关卡进度这类后端失败文案不得直出（HTTP 状态码会印到学生页面上）', () => {
  // 走查原句：「界面文案不得包含服务器路径 / HTTP 状态码」。
  // `stores/quiz.ts` 的 `progressError` 曾经直出 wire 层的
  // `读取失败（HTTP 503）：<detail>`，而它与 `bankError` 不同，**没有**过翻译 ——
  // 于是编程页左侧的关卡列表与闯关页都会把 HTTP 状态码印给学生。
  const quiz = stripComments(read('src', 'renderer', 'src', 'stores', 'quiz.ts'))
  const assignments = [...quiz.matchAll(/progressError\.value\s*=\s*([^\n]+)/g)].map((m) => m[1].trim())
  assert.ok(assignments.length > 0, 'progressError 应当有赋值点（改了字段名就同步这条守卫）')
  for (const rhs of assignments) {
    if (rhs === 'null') continue
    assert.match(
      rhs,
      /toStudentFacingMessage|describeClientError/,
      `progressError 的赋值没有过面向学生的翻译：${rhs}\n` +
        'wire 层的文案形如「读取失败（HTTP 503）：…」，它会直接出现在编程页与闯关页上'
    )
  }
})

test('★★ 空态必须是引导 / 高光，不是系统占位', () => {
  const mistakes = read('src', 'renderer', 'src', 'study', 'MistakesTab.vue')
  const empty = read('src', 'renderer', 'src', 'components', 'EmptyState.vue')

  // 「没有错题」对学生是**好事**，要用高光态而不是灰色占位
  assert.match(
    mistakes,
    /tone="success"/,
    '错题本空态必须用 success 色调 —— 它是一份「全对」的成绩，不是加载失败'
  )
  // 空态组件必须支持这一档（否则上面的 tone 会被忽略、静默退化成普通空态）
  assert.match(empty, /'empty' \| 'loading' \| 'error' \| 'success'/, 'EmptyState 必须支持 success 档')
  assert.match(empty, /data-tone='success'|\[data-tone='success'\]/, 'success 档要有自己的视觉（不能与 empty 同款）')

  // 导出成 Markdown 的那一份也要跟着改（它是同一个空态的另一种出口）
  const md = read('src', 'renderer', 'src', 'study', 'report-markdown.ts')
  assert.match(md, /还没有错题记录/, 'Markdown 里的那句仍要含「还没有错题记录」（既有断言按它匹配）')
  // ⚠️ 剥注释再断言：文件里**刻意**引用了旧句子（讲为什么它太冷），那是决策记录
  assert.doesNotMatch(
    stripComments(md),
    /保持住/,
    '但语气要与界面同步改暖（「保持住」是命令式，冷）'
  )
})

/* ================================================================== *
 * ⑯ 人设定位（2026-09-21 微调，D-064）
 * ================================================================== */

test('★★ 四个学段 + baseline + 挡话里的**自称统一**是「智团团」', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 为什么要有这一条：改之前自称有**三套** ——
  //   · `primary-low.ts`：「小 AI 老师」
  //   · 另外三份：「AI 通识课老师」
  //   · `rules.ts` / `baseline.ts` 被追问时：「老师为你配置的学习助手」
  // 而产品名（`@shared/brand` 的 BRAND_NAME）、开场白（`profile.py`）又是「智团团」/「团团」。
  // 五处不一致 → 学生问「你是谁」会得到四个不同答案。这是**人格分裂**，不是措辞问题。
  // ══════════════════════════════════════════════════════════════════════
  const files = [
    ['prompts/primary-low.ts', '小学低年级'],
    ['prompts/primary-high.ts', '小学高年级'],
    ['prompts/junior.ts', '初中'],
    ['prompts/senior.ts', '高中'],
    ['prompts/baseline.ts', '基线（冒烟）']
  ] as const
  for (const [file, label] of files) {
    const src = read('src', 'main', 'agent', ...file.split('/'))
    assert.match(src, /智团团/, `${label}模板里必须出现「智团团」（自称与产品名统一）`)
    for (const stale of ['小 AI 老师', 'AI 通识课老师', '人工智能通识课', '老师为你配置的学习助手', '老师配置的教学工具']) {
      assert.ok(
        !src.includes(stale),
        `${label}模板里还残留旧自称／旧定位「${stale}」—— 五处不一致会让学生问「你是谁」得到不同答案`
      )
    }
  }

  // 提示词（发给模型的那份）里必须有名字：`composePrompt` 的 `name` 参数
  for (const file of ['primary-low.ts', 'primary-high.ts', 'junior.ts', 'senior.ts']) {
    const src = read('src', 'main', 'agent', 'prompts', file)
    assert.match(src, /name:\s*\w*NAME/, `${file} 必须把自称传给 composePrompt（否则 mood 段里没有名字）`)
  }

  // 品牌定位语也去掉「通识课」，对齐需求原文的「7×24 小时在线 AI 教师」
  // ⚠️ **剥注释再断言**：`brand.ts` 的注释里**刻意**写了旧值「陪你学 AI 的通识课小老师」
  //   （作为「不要再改回去」的警示）—— 不剥的话，那条警示会把守卫自己绊倒（实测踩到）。
  const brand = stripComments(read('src', 'shared', 'brand.ts'))
  assert.match(brand, /BRAND_TAGLINE\s*=\s*'[^']*7×24/, '定位语要含需求原文的「7×24」')
  assert.ok(!brand.includes('通识课'), '定位语里不要「通识课」（我们已经没有课程这个概念了）')
})

test('★★ 「按需调用」与「闲聊／情绪」两节必须在，且措辞是「不必」而不是「禁止」', () => {
  const rules = read('src', 'main', 'agent', 'prompts', 'rules.ts')

  // ① 「什么时候不必用工具」—— 这一节原来**完全不存在**
  assert.match(rules, /need:\s*'# 什么时候要用工具，什么时候不用'/, '必须有这一节（原来只写了「该用」）')
  assert.match(rules, /不必检索/, '必须写明哪些情形**不必**检索（否则模型会每轮都查一遍）')
  assert.match(rules, /值得检索/, '也要写明什么时候值得检索（只写「不必」会走到另一个极端）')
  // 反向：不许把「不必」写成「从不」—— 必须保留「要查」的情形
  assert.match(rules, /需要原话、出处/, '必须保留「需要教材原话 / 出处时要查」这一半')
  // 也不许假装查了（防走过头）
  assert.match(rules, /不要假装查了/, '「不假装查了」这条反向要求必须保留')

  // ② 「闲聊、跑题与情绪」—— 这一类策略原来**一条都没有**
  assert.match(rules, /mood:\s*'# 闲聊、跑题与学生的情绪'/, '必须有这一节（原来没有任何情绪／跑题策略）')
  assert.match(rules, /不要硬拽/, '跑题时要「不要硬拽」')
  assert.match(rules, /先把情绪接住/, '受挫时要先接住情绪')
  // ★ 关键：它必须是「允许接话」，**不是**「禁止跑题」——两者的产品含义相反
  assert.ok(
    !/禁止(跑题|闲聊)|不许(跑题|闲聊)|拒绝回答(跑题|闲聊)/.test(rules),
    '这一节不能写成「禁止跑题 / 拒绝闲聊」（那是把学生挡回去）'
  )
  // 「你是谁」这类正常问题要**正常回答**，不能一律用挡话
  assert.match(rules, /这是正常的问题/, '要明确「你是谁」这类问题正常回答，而不是拿挡话顶回去')
})

test('★★ 不得再有「先查教材再讲」这类硬绑定（去课程中心化）', () => {
  const rules = read('src', 'main', 'agent', 'prompts', 'rules.ts')
  const code = stripComments(rules)

  // 原句：「回答教材里的知识点**前，先**用检索工具取回教材原文再讲」——「先…再」把它写成了前置条件
  assert.ok(
    !/回答教材里的知识点前，先用检索工具取回教材原文再讲/.test(code),
    '硬绑定措辞必须已经软化（教材是**参考**，不是每轮的前置条件）'
  )
  assert.match(code, /教材是\*\*参考\*\*/, '要明确写出「教材是参考」这个口径')

  // 工具自述里同样的硬绑定
  const rag = stripComments(read('src', 'main', 'agent', 'extensions', 'rag-search.ts'))
  assert.ok(
    !/需要教材依据时先调用/.test(rag),
    '`rag-search.ts` 的 promptGuidelines 不许再写「需要教材依据时**先调用**」'
  )
  assert.match(rag, /不要.*说「我查一下」却不去查/, '但「不假装查了」要保留')

  // 画像块里的路径压力
  const profile = stripComments(read('src', 'main', 'agent', 'extensions', 'profile.ts'))
  assert.ok(
    !/照这个意思用学生能听懂的话说/.test(profile),
    '推荐不再是命令式（「照这个意思说」→「想带方向时可以说」）'
  )
  assert.ok(
    !/优先顺着这条线引导，不要跳到更后面的内容/.test(profile),
    '不许再要求模型「不要跳到更后面」——学生想聊什么就聊什么'
  )
})

test('★★ 章节在提示词里是**纯背景**，不给行动指引', () => {
  const profile = stripComments(read('src', 'main', 'agent', 'extensions', 'profile.ts'))
  assert.ok(
    !/回答与检索优先围绕本章/.test(profile),
    '章节行不许再有「优先围绕本章」这种行动指引（它是背景，不是任务）'
  )
  assert.match(profile, /学生当前在看/, '章节行的口径是「学生当前在看」')
  assert.match(profile, /只是背景，不必刻意围绕它/, '要明说它只是背景')
})

test('★★ 页面标题与分组：去课程色彩 + 三组（只改给人看的，内部 id 不动）', () => {
  const ui = read('src', 'renderer', 'src', 'stores', 'ui.ts')

  // ① 标题：五处改名（D-064）
  assert.match(ui, /title: '问问智团团'/, '对话页标题改成「问问智团团」')
  assert.match(ui, /title: '闯关挑战'/, '闯关页标题改成「闯关挑战」')
  assert.match(ui, /title: '学习记录'/, '学习档案改成「学习记录」')
  assert.match(ui, /title: '参考资料库'/, '教材知识库改成「参考资料库」')
  assert.match(ui, /title: '知识图谱'/, '学习地图改成「知识图谱」')
  // 三个功能名本来就没有课程色，**不许**跟着乱改
  for (const keep of ["title: '动画讲解'", "title: '编程环境'", "title: '设置'"]) {
    assert.ok(ui.includes(keep), `${keep} 不该被改（它没有课程色彩）`)
  }
  // 课程色彩词不许再出现在标题里
  for (const banned of ['对话课堂', '闯关练习', '学习档案', '教材知识库', '学习地图']) {
    assert.ok(!ui.includes(`title: '${banned}'`), `标题里还有课程色彩的旧名「${banned}」`)
  }

  // ② 分组：恰好三组（跟团团聊 / 动手试试 / 我的记录），且没有空串分组
  const sections = [...ui.matchAll(/section: '([^']*)'/g)].map((m) => m[1])
  assert.ok(sections.length >= 8, `应当能解析出每个页面的 section（实测 ${sections.length}）`)
  const unique = [...new Set(sections)]
  assert.deepEqual(
    [...unique].sort(),
    ['动手试试', '我的记录', '跟团团聊'].sort(),
    `分组必须恰好是这三组（实测 ${JSON.stringify(unique)}）`
  )
  assert.ok(!unique.includes(''), '不该再有「空串 = 独占一组」的页面（三组都有名字）')

  // ③ 顶栏按钮文案与页面标题一致（否则「按钮写着去 A，点下去到了 B」）
  assert.match(ui, /chat: '学习记录'/, '`VIEW_LABELS.chat` 必须跟着改成新名')
  assert.match(ui, /study: '学习记录'/, '`VIEW_TITLES.study` 必须跟着改')

  // ④ 内部 id 一个都没动（改 id 会牵动探针 / testid / 文档计数，而学生看不见它）
  assert.match(ui, /export type PageName =/, 'PageName 联合必须还在')
  for (const id of ["'chat'", "'animation'", "'coding'", "'quiz'", "'study'", "'settings'", "'knowledge'", "'dependency'"]) {
    assert.ok(ui.includes(id), `内部 id ${id} 必须保留（改名会牵动一大片，且学生看不见）`)
  }
})

/* ================================================================== *
 * ⑰ 学生可见文本的**排版纪律**：不写未渲染的 Markdown 标记、不用破折号连接句子
 *    （2026-09-22 设计评审报告 1.8「Markdown 泄漏」+ 第 3 章「破折号专项」）
 * ================================================================== */

/**
 * 会被**原样印上屏**的两种标记写法。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有这两条（真事，不是排版洁癖）
 * ══════════════════════════════════════════════════════════════════════════
 * 动画页的 `fallback_text` 与编程页的反馈都是**裸插值**渲染的
 * （`{{ }}` + `white-space: pre-wrap`，**不经** `markdown.ts`），所以文案里写的
 * `**加粗**` 会原样上屏 —— 走查截图里学生读到的正是「一串**是 / 否**问题」那一堆字面星号
 * （报告 1.8）。反引号同理：它只有在走 Markdown 渲染的通路里才会变成等宽字体，
 * 在裸插值的文案里就是两个反引号字符。`views/Quiz.vue` 里留了一句人工纪律注释
 * （「纯文本插值不许写星号」）—— 注释拦不住下一个人，所以这里补一条机器守卫。
 *
 * ★ 分工（别把这条守卫误读成「全仓禁用星号」）：
 *   · **模型输出**走 `ChatMessage` → `markdown.ts`，那里的 `**` 会被解析成 `<strong>`，
 *     那是**该有的** Markdown；`src/main/agent/prompts/**` 的提示词同理，不在本守卫范围
 *     （本文件的扫描范围本来就只有 `src/renderer/src`）；
 *   · 本条守的是**我们自己写给学生的文案**：模板文本节点 + 面向用户的属性 + 字符串字面量。
 */
const MARK_SYNTAX = ['**', '`'] as const

/**
 * 破折号（报告第 3 章「破折号专项」）。
 *
 * ★ 它是**本产品学生文案的 LLM 指纹**：除数学区间、专有名词外，不许用 `——` 作句间连接。
 *   处置方式永远是「改成两句短句 / 逗号 / 直接删掉后半个安抚句」，
 *   而不是「把破折号换个写法」（`–` `—` 只是换个字符，读起来还是同一股味）。
 */
const DASH_MARK = '——'

/** 一条命中（哪个文件、哪个标记、命中在哪段文本里）。 */
interface MarkHit {
  file: string
  mark: string
  text: string
}

/**
 * 复用本文件既有的 {@link visibleText} 提取机制，扫**全部**渲染进程文件。
 *
 * ★ 与技术词守卫（第 ① 条）共用同一份「这里没有学生可见文案」的名单
 *   （`TERM_EXEMPT_FILES`）：那份名单的含义就是「这些文件里的字到不了学生眼前」，
 *   对排版标记同样成立。两份名单**故意不分家** —— 分开维护一定会漂移。
 */
function scanVisibleMarks(marks: readonly string[]): MarkHit[] {
  const hits: MarkHit[] = []
  for (const file of rendererFiles()) {
    const name = rel(file)
    if (TERM_EXEMPT_FILES.has(name)) continue
    const source = readFileSync(file, 'utf8')
    for (const text of visibleText(file, source)) {
      for (const mark of marks) {
        if (text.includes(mark)) hits.push({ file: name, mark, text: text.trim().slice(0, 110) })
      }
    }
  }
  return hits
}

/** 命中是否被例外表放行（**逐条按文件 + 标记**，不是「整个文件不算」之外还放行别的标记）。 */
function exempted(hits: readonly MarkHit[], table: ReadonlyArray<{ file: string; marks: string[] }>): MarkHit[] {
  return hits.filter((hit) => !table.some((entry) => entry.file === hit.file && entry.marks.includes(hit.mark)))
}

/** 报错信息里一行一条（`文件 出现「标记」 → 命中原文`）。 */
const describeHits = (hits: readonly MarkHit[]): string[] =>
  hits.map((hit) => `${hit.file} 出现「${hit.mark}」 → ${hit.text}`)

/**
 * 例外表（**欠债清单，不是许可清单**）—— 每条都必须能回答：
 * **这段字到底会不会出现在学生眼前？** 答不上来就去改源码，别加条目。
 *
 * ★ 三条纪律（下面那条「例外必须名副其实」的测试会逐条机械复核）：
 *   ① 表长**按现状封顶**：想加一条，必须先删一条（也就是先修掉一处源码）；
 *   ② 每条理由 ≥40 字，且要指出**为什么到不了学生眼前**（或哪条通路才到得了）；
 *   ③ 条目一旦用不上（源码已经清干净了）就必须删掉 —— 留着就是假豁免。
 */
const MARK_EXEMPT: Array<{ file: string; marks: string[]; why: string }> = [
  {
    file: 'markdown.ts',
    marks: ['**', '`'],
    why:
      '这是 **Markdown 解析器本身**（`parseInline` / `parseMarkdown`）：`**` 与反引号在这里是**被查找的标记**' +
      '（`startsWith` / `indexOf` 的比较串，以及「未闭合围栏照原样当段落」的字节保留），不是文案 —— ' +
      '它恰恰决定了模型正文里的 `**` 会被渲染成 `<strong>`。从这里把这些标记删掉，等于把渲染关掉。'
  },
  {
    file: 'study/report-markdown.ts',
    marks: ['**'],
    why:
      '这是**导出那份 .md 的拼装器**：`**` 只出现在喂给 `lines.push(...)` 的文档行里' +
      '（`- 平均掌握度：**62%**`），而导出物的消费方是 Markdown 阅读器 —— 文件头第 3 条纪律写着' +
      '「导出物是给学生/家长看的：中文、分节、可用 Markdown 阅读器打开」，`**` 在那里是**正确语法**，不是泄漏。' +
      '⚠️ 它与屏幕文案**共用同一份字**（`STAGE_LABELS` 等），所以「只在文档行里」这条必须由下面那条凭据断言钉住。'
  }
]

/**
 * 破折号的例外表（同上，逐条带理由）。
 *
 * ★ 报告允许「数学区间、专有名词」例外 —— 但**当前一处都没有**，所以表里没有数学区间的条目。
 *   真出现时按同样格式加一条（写清为什么这里必须用破折号），别把断言改松。
 */
const DASH_EXEMPT: Array<{ file: string; marks: string[]; why: string }> = [
  {
    file: 'labels.ts',
    marks: ['——'],
    why:
      '唯一一处 `——` 在 `llmChipTitle()` 的**教师半**（`isTeacher ? … : …`）：「还没配置模型 —— 在设置页填写 API Key 后就能对话」。' +
      '学生半由 `llm-unconfigured.test.ts` 钉着（不含 API Key / 不含「点击更换」），下面那条凭据断言再用**行为面**复核一次' +
      '（真的调 `llmChipTitle(llm, false)`，看学生那半有没有破折号）。'
  },
  {
    file: 'views/Settings.vue',
    marks: ['——'],
    why:
      '五处 `——` 全都只出现在**高级设置**里：模板那三处在 `v-if="advancedVisible"` 区内（供应商 / 嵌入模型 / 隐私与本地服务三块的说明，' +
      '是教师视角的技术文案）；脚本那两处是 `presetHint` / `probeSummary`（供应商目录与连通探测的白话结论），也只在高级区渲染。' +
      '报告的破折号专项只约束学生面，学生那三节（学段 / 教材章节 / 外观）里一个 `——` 都没有 —— ' +
      '下面那条凭据断言按**区域 + 持有者**复核（与技术词那条「豁免必须名副其实」同一手法）。'
  },
  {
    file: 'sandbox/pyodide.worker.ts',
    marks: ['——'],
    why:
      '唯一一处 `——` 在 `capability.detail`（「SharedArrayBuffer 不可用（需要主进程开启 enable-features=…）——本次只能靠主线程的墙钟超时」）：' +
      '它的**唯一消费点**是 `pyodide-runner.ts` 里那句 console 排障日志，从不上屏（界面只读 `capability.interruptible`）。'
  }
]

test('★★ 学生可见文本里不得出现未渲染的 Markdown 标记（`**` / 反引号）', () => {
  // 先钉住例外表本身：它一旦长大，这条守卫就退化成「例外清单」（与技术词那张表同一纪律）
  // ★★ 2026-09-22：原来这里还有 4 条 `api/{chapter,grade,study,sessions}.ts` 的例外
  //    （接线诊断里的反引号）。那一族已经**改源码**处理掉了：屏幕上是学生话、
  //    细节走 `warnWiring`（控制台），所以表里只剩下面两条「标记语法的主人」。
  //    封顶数跟着降到**实际条数**：想加一条就必须先删一条（先修掉一处源码）。
  assert.ok(
    MARK_EXEMPT.length <= 2,
    `Markdown 标记的例外已经有 ${MARK_EXEMPT.length} 条 —— 超过 2 条说明多半是「改文案」被换成了「加例外」。`
  )
  for (const entry of MARK_EXEMPT) {
    assert.ok(entry.why.length >= 40, `${entry.file} 的例外理由太短 —— 要写清「它为什么到不了学生眼前」`)
    assert.ok(entry.marks.length > 0, `${entry.file} 的例外没写标记`)
  }

  const hits = scanVisibleMarks(MARK_SYNTAX)
  // ★ 例外必须**确实用得上**：源码清干净之后还留着条目，就是一条假豁免（会掩护下一次泄漏）
  for (const entry of MARK_EXEMPT) {
    assert.ok(
      hits.some((hit) => hit.file === entry.file && entry.marks.includes(hit.mark)),
      `${entry.file} 的例外已经用不上了（那个标记在该文件里找不到了）—— 请删掉这条条目，别留着`
    )
  }

  const real = exempted(hits, MARK_EXEMPT)
  assert.deepEqual(
    real.map((hit) => `${hit.file} 出现「${hit.mark}」 → ${hit.text}`),
    [],
    '学生看到的会是**字面星号 / 字面反引号**：这些文本走的不是 Markdown 渲染通路\n' +
      '（动画页 `fallback_text`、编程页反馈、闯关反馈都是裸插值 `{{ }}` + `white-space: pre-wrap`）。\n' +
      '处置：① 换成 `<strong>` / 等宽类名（走模板）；② 或者把这段文案交给 `markdown.ts` 渲染。\n' +
      '**不要**在裸插值的文案里写 `**加粗**` —— 报告 1.8 的那张截图就是这么来的。\n' +
      `命中 ${real.length} 处：\n  ${describeHits(real).join('\n  ')}`
  )
})

test('★★ 学生可见文本里不得用破折号连接句子（报告第 3 章「破折号专项」）', () => {
  assert.ok(
    DASH_EXEMPT.length <= 3,
    `破折号的例外已经有 ${DASH_EXEMPT.length} 条 —— 超过 3 条说明多半是「改文案」被换成了「加例外」。`
  )
  for (const entry of DASH_EXEMPT) {
    assert.ok(entry.why.length >= 40, `${entry.file} 的例外理由太短 —— 要写清「它为什么到不了学生眼前」`)
  }

  const hits = scanVisibleMarks([DASH_MARK])
  // 同上：用不上的例外必须删掉（否则改回破折号时它会被「反正有例外」混过去）
  for (const entry of DASH_EXEMPT) {
    assert.ok(
      hits.some((hit) => hit.file === entry.file),
      `${entry.file} 的例外已经用不上了（该文件里没有 \`——\` 了）—— 请删掉这条条目，别留着`
    )
  }

  const real = exempted(hits, DASH_EXEMPT)
  assert.deepEqual(
    real.map((hit) => `${hit.file} → ${hit.text}`),
    [],
    '`——` 是本产品学生文案的 **LLM 指纹**（报告第 3 章）：除数学区间 / 专有名词外禁用。\n' +
      '处置：改成两句短句、逗号，或者直接删掉后半个安抚句（C16 就是这么处理的）。\n' +
      '⚠️ 换个字符（`–` / `—`）不算修好 —— 读起来还是同一股味。\n' +
      `命中 ${real.length} 处：\n  ${describeHits(real).join('\n  ')}`
  )
})

/* ================================================================== *
 * ⑱ 「桥没接上」时：屏幕上是学生话，接线细节只在控制台
 *    （2026-09-22 设计评审报告 0.2 + 双视角 D-063）
 * ================================================================== */

/**
 * 取一个 `export const NAME = …` 里**拼出来的字符串值**（把跨行拼接的字面量接起来）。
 *
 * ★ 为什么要这么取（而不是断言「等于某个常量」）：断言等于常量只证明「实现与常量一致」，
 *   常量里塞满方法名它也照样绿。这里要判的是**学生看到的那串字本身**。
 * ⚠️ 取法是「从声明处到下一个空行」——这四句都是紧跟着空行的普通常量；
 *   改形状（包进函数 / 加三元）会让这里取到空串，那时下面的「找不到」会立刻报出来。
 */
function constStringValue(source: string, name: string): string {
  const at = source.indexOf(`export const ${name} =`)
  if (at < 0) return ''
  const end = source.indexOf('\n\n', at)
  const decl = source.slice(at, end > at ? end : at + 1200)
  return [...decl.matchAll(/'([^']*)'/g)].map((match) => match[1]).join('')
}

/**
 * 每个「桥没接上」的落点：**学生可见文本**不许有什么、**控制台**必须点什么名。
 *
 * ★ 它们该出现在两处、不该出现在第三处：
 *   · ✅ `warnWiring(…)` 的实参里（接线的人在 DevTools 看）；
 *   · ✅ 文件头的注释里（读代码的人看 —— 注释本来就被 `visibleText()` 剥掉）；
 *   · ❌ **学生可见文本里**（`*_HINT` 常量、模板文本、面向用户的属性）——
 *     那是这次改口的全部意义：学生读到「preload 白名单缺少 setChapter」既看不懂也管不着。
 *
 * 字段：
 *   · `tokens` = 一律不许出现在学生可见文本里的（含运行时动态拼的那批方法名）；
 *   · `wiredByKey` = **每个 `warnWiring` 分支各自**必须在自己的 detail 里点名的东西；
 *   · `hints`（可选）= 该文件里承载学生话的常量名（有就顺带断言「存在 + 是中文人话」——
 *     没写常量的（学生话内联在 store / 模板里）靠 `tokens` 那一半兜）；
 *   · `wiringFile`（可选）= 接线诊断**不在本文件**时去哪读（`views/Chat.vue` 的细节
 *     由 `stores/chat.ts` 的 `connect()` 打 —— 同一件事只在有能力的那一层 warn 一次）。
 *
 * ⚠️ 为什么按 **key** 而不是「整个文件里出现过」：变异验证当场抓到过假绿 ——
 *   把 `chapter.set` 那句里的方法名删掉之后守卫照样绿，因为**另一个分支**（push 那句）
 *   顺带列着 `onChapterChanged / getChapter / setChapter` 这一族。一句话的意义在于
 *   「**这一条**缺的是哪一个」，所以判据必须落在**同一个 key 的 detail** 上。
 */
const BRIDGE_WIRING_TOKENS: ReadonlyArray<{
  file: string
  hints?: string[]
  tokens: string[]
  wiredByKey: ReadonlyArray<{ key: string; tokens: string[] }>
  wiringFile?: string
}> = [
  {
    file: 'src/renderer/src/api/chapter.ts',
    hints: ['CHAPTER_BRIDGE_MISSING_HINT', 'CHAPTER_SET_MISSING_HINT'],
    tokens: ['onChapterChanged', 'getChapter', 'setChapter', 'chapter:changed', 'chapter:get', 'chapter:set', 'preload', 'window.api'],
    wiredByKey: [
      { key: 'chapter', tokens: ['window.api'] },
      { key: 'chapter.push', tokens: ['onChapterChanged', 'chapter:changed'] },
      { key: 'chapter.set', tokens: ['setChapter', 'chapter:set'] }
    ]
  },
  {
    file: 'src/renderer/src/api/grade.ts',
    hints: ['GRADE_BRIDGE_MISSING_HINT', 'GRADE_SET_MISSING_HINT'],
    tokens: ['onGradeChanged', 'getGrade', 'setGrade', 'grade:changed', 'grade:get', 'grade:set', 'preload', 'window.api'],
    wiredByKey: [
      { key: 'grade', tokens: ['window.api'] },
      { key: 'grade.push', tokens: ['onGradeChanged', 'grade:changed'] },
      { key: 'grade.set', tokens: ['setGrade', 'grade:set'] }
    ]
  },
  {
    file: 'src/renderer/src/api/study.ts',
    hints: ['STUDY_BRIDGE_MISSING_HINT'],
    tokens: [
      'readStudyReport',
      'readStudyMistakes',
      'readStudyChapters',
      'readStudyGraph',
      'listSessions',
      'readSessionTranscript',
      'searchSessions',
      'exportMarkdown',
      'study:',
      'session:',
      'file:export',
      'preload',
      'window.api'
    ],
    wiredByKey: [
      { key: 'study', tokens: ['window.api'] },
      { key: 'study.methods', tokens: ['study:', 'file:export'] }
    ]
  },
  {
    file: 'src/renderer/src/api/sessions.ts',
    hints: ['SESSION_BRIDGE_MISSING_HINT'],
    tokens: [
      'getSessionState',
      'openSession',
      'startNewSession',
      'branchSession',
      'deleteSession',
      'onSessionChanged',
      'session:open',
      'session:new',
      'session:branch',
      'session:delete',
      'session:state',
      'session:changed',
      'preload',
      'window.api'
    ],
    wiredByKey: [
      { key: 'session', tokens: ['window.api'] },
      { key: 'session.methods', tokens: ['session:open', 'session:changed'] }
    ]
  },
  {
    file: 'src/renderer/src/api/data.ts',
    hints: ['DATA_BRIDGE_MISSING_HINT'],
    tokens: ['getStudent', 'readProfile', 'readQuizBank', 'gradeQuiz', 'readCodeHint', 'hostAnimation', 'rebuildKnowledge', 'onTraceChanged', 'window.api', 'preload'],
    wiredByKey: [
      { key: 'data', tokens: ['window.api'] },
      { key: 'data.methods', tokens: ['preload'] }
    ]
  },
  {
    file: 'src/renderer/src/api/settings.ts',
    hints: ['SETTINGS_BRIDGE_MISSING_HINT'],
    tokens: ['readSettings', 'saveSettings', 'probeSettings', 'readProviderCatalog', 'fetchProviderModels', 'window.api', 'preload', 'IPC'],
    wiredByKey: [
      { key: 'settings', tokens: ['window.api'] },
      { key: 'settings.methods', tokens: ['preload', 'IPC'] }
    ]
  },
  {
    // ★ 学生会话两条提示（`localNotice`）内联在 store 里（没有 `*_HINT` 常量）——
    //   所以这里只靠 `tokens` 那一半（`visibleText()` 会扫到 `localNotice.value = '…'`）。
    file: 'src/renderer/src/stores/chat.ts',
    tokens: ['window.api', 'preload'],
    wiredByKey: [
      { key: 'chat.connect', tokens: ['window.api', 'preload'] },
      { key: 'chat.send', tokens: ['window.api', 'preload'] }
    ]
  },
  {
    // ★ 侧栏状态位那一句（`AppSidebar` 的 `data-testid="sidecar-error"`）
    file: 'src/renderer/src/stores/sidecar.ts',
    tokens: ['window.api', 'preload'],
    wiredByKey: [{ key: 'sidecar', tokens: ['window.api', 'preload'] }]
  },
  {
    // ★★ 这个文件里**只有学生话**（模板文本）：接线细节在 store 里（见 `wiringFile`）——
    //    同一件事只在有能力的那一层 warn 一次（`warnWiring` 按 key 去重）。
    file: 'src/renderer/src/views/Chat.vue',
    tokens: ['window.api', 'preload'],
    wiredByKey: [{ key: 'chat.connect', tokens: ['window.api', 'preload'] }],
    wiringFile: 'src/renderer/src/stores/chat.ts'
  }
]

test('★★ 桥没接上时：屏幕上是学生话，缺哪个方法 / 哪条通道只在控制台（`warnWiring`）', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 这条守卫守的是什么（与它换掉的那条旧断言的关系）
  // ══════════════════════════════════════════════════════════════════════
  // 在此之前，`*_MISSING_HINT`（会渲染给学生的那句话）本身就是**接线说明**：
  // 「preload 白名单缺少 setChapter，需要先在主进程注册「章节设定」通道（invoke，带回执）……
  //   接线后刷新页面即可生效。」——对**接线的人**这是最有用的那句话，
  // 对**学生**是：他看不懂的词 + 一件他做不到的事（「刷新页面」对「线没接」是假承诺）。
  // 现在同一件事分两条通路，这条守卫**同时钉住两边**（少一边都不算改好）：
  //   ① 屏幕：`*_HINT` 必须是中文学生话，且**一个机器 token 都不许有**；
  //   ② 控制台：那些 token 必须仍写在一个 `warnWiring(…)` 调用里（意图一个字都没丢）。
  // ⚠️ 「实参不算界面文本」的凭据在下面那条「例外表必须名副其实」里（读 warnWiring 的函数体）。
  const problems: string[] = []
  for (const entry of BRIDGE_WIRING_TOKENS) {
    const source = read(...entry.file.split('/'))
    // ① 学生面：常量值必须存在、是中文人话、且不含任何机器 token
    for (const name of entry.hints ?? []) {
      const value = constStringValue(source, name)
      if (value.length === 0) {
        problems.push(`${entry.file} 取不到 ${name} 的值（改形状就同步 constStringValue 的取法）`)
        continue
      }
      if (!/[\u4e00-\u9fff]/.test(value)) problems.push(`${entry.file} 的 ${name} 不是中文人话：${value}`)
      for (const token of entry.tokens) {
        if (value.includes(token)) problems.push(`${entry.file} 的 ${name} 里出现了「${token}」→ ${value}`)
      }
    }
    // ② 学生可见文本（整份文件，含模板 / 属性 / 其它字面量）里也不许有 ——
    //    这一半顺带是「剥离规则没漏」的自检：`warnWiring(...)` 若没被剥干净，token 会在这里冒出来。
    //    ⚠️ 只看**含中文的**片段：这些文件里纯 ASCII 的字面量大多是**代码**（模块路径
    //    `'../../../preload/index'`、`REQUIRED_METHODS` 那张方法名清单、
    //    `components['schemas']['EmbeddingConfig']` 这种类型索引）—— 它们一个字都印不到屏幕上，
    //    只是恰好也是「字符串字面量」（`visibleText()` 抽的是字符串，不区分用途）。
    //    「我们写给学生的文案」在这个仓里一律是中文 ⇒ **带中文 + 带机器 token** 才是真泄露。
    for (const chunk of visibleText(entry.file, source)) {
      if (!/[\u4e00-\u9fff]/.test(chunk)) continue
      for (const token of entry.tokens) {
        if (chunk.includes(token)) problems.push(`${entry.file} 的学生可见文本里出现了「${token}」→ ${chunk.slice(0, 90)}`)
      }
    }
    // ③ 控制台面：**每个分支各自**点出自己缺的那一个（见 `wiredByKey` 的说明）。
    //    ⚠️ 接线诊断可能不在本文件（`wiringFile`：`views/Chat.vue` 的细节在 store 里 ——
    //    同一件事只在有能力的那一层 warn 一次，靠 key 去重）。
    const wiringSource = read(...(entry.wiringFile ?? entry.file).split('/'))
    const wiringWhere = entry.wiringFile ?? entry.file
    const wiringCalls = [...wiringSource.matchAll(/warnWiring\(\s*'([^']+)',\s*([\s\S]*?)\)\n/g)].map((match) => ({
      key: match[1],
      span: match[0]
    }))
    for (const expectation of entry.wiredByKey) {
      const call = wiringCalls.find((item) => item.key === expectation.key)
      if (!call) {
        problems.push(`${wiringWhere} 少了 \`warnWiring('${expectation.key}', …)\` 这条接线诊断（${entry.file} 的细节就靠它）`)
        continue
      }
      for (const token of expectation.tokens) {
        if (!call.span.includes(token)) {
          problems.push(`${wiringWhere} 的 \`warnWiring('${expectation.key}', …)\` 里没点名「${token}」—— 那句话是「照它就能把线接上」的唯一落点`)
        }
      }
    }
  }
  assert.deepEqual(
    problems,
    [],
    '屏幕面向学生、控制台面向接线人 —— 这一族文案必须分两条通路：\n' +
      '  · 学生面（`*_HINT`）：只说他能感知的三件事（什么用不了 / 还能做什么 / 找谁），\n' +
      '    写法参照对话页空态那句「请老师或家长在『设置 → 高级设置』里配置一下」；\n' +
      '  · 控制台（`warnWiring(key, detail)`，见 `api/wiring-notice.ts`）：缺哪个方法、要注册哪条通道、\n' +
      '    接完为什么要重启渲染进程 —— 「照它就能把线接上」这个意图**不许丢**，只是不许印给学生。\n' +
      `命中 ${problems.length} 处：\n  ${problems.join('\n  ')}`
  )
})

test('★★ 上面两张例外表必须名副其实（逐条机械复核，不写「大概是给人看的」）', async () => {
  // ══════════════════════════════════════════════════════════════════════
  // 为什么必须另起一条
  // ══════════════════════════════════════════════════════════════════════
  // 例外表最容易变成**后门**：理由写得很像那么回事（「这是导出的」「这是给老师看的」），
  // 而哪天有人把那段字搬到了学生那一半，判据不会发现 —— 它只看「这个文件在表里」。
  // 所以每条例外都要在这里被**再验一次**，而且尽量验在**行为 / 区域**上，不是再读一遍理由。
  // （与技术词那张表的「豁免必须名副其实」同一条纪律，别删。）

  // ① markdown.ts：带标记的字面量里**不许有中文**。
  //    解析器处理的是标记本身（`'**'`、反引号那个单字符字面量、'```'，长度都 ≤3、无中文）；
  //    「拼出来的句子」才会带中文 —— 而那正是要拦的写法。
  const parser = read('src', 'renderer', 'src', 'markdown.ts')
  assert.match(parser, /export function parseMarkdown/, 'markdown.ts 仍必须是解析入口（例外的前提）')
  const parserProse = visibleText('markdown.ts', parser).filter((text) => /[`*]/.test(text) && /[\u4e00-\u9fff]/.test(text))
  assert.deepEqual(
    parserProse,
    [],
    'markdown.ts 里出现了「带标记 + 带中文」的字面量 —— 那是在拼句子，不是在处理标记（例外不再成立）'
  )

  // ② report-markdown.ts：`**` 只许落在喂给 `lines.push(...)` 的文档行里（±3 行窗口）。
  //    这一条卡的是「屏幕上与导出物共用同一份字」那个坑：谁把 `**` 写进 `summaryLine()` 之类
  //    会被页面直接渲染的函数，窗口里就看不到 `lines.push(`，这里立刻红。
  const reportLines = stripComments(read('src', 'renderer', 'src', 'study', 'report-markdown.ts')).split('\n')
  const strayBold: string[] = []
  for (const [index, line] of reportLines.entries()) {
    if (!line.includes('**')) continue
    const window = reportLines.slice(Math.max(0, index - 3), index + 2).join('\n')
    if (!/lines\.push\(/.test(window)) strayBold.push(`${index + 1}: ${line.trim()}`)
  }
  assert.deepEqual(strayBold, [], 'report-markdown.ts 的 `**` 必须写在导出文档行里（`lines.push(...)`）')

  // ③ `warnWiring(...)` 的实参凭什么不算界面文本（见 `visibleText()` 里那条剥离规则）。
  //    凭据 = 读 `api/wiring-notice.ts` 的**函数体本身**：它的输出只能进 console，
  //    一个字节都到不了 DOM（有 `console.warn`、没有任何写 DOM / 返回值）。
  //    ⚠️ 这条不是「大概给人看的」：谁把这个函数改成会渲染（或让它 return 一段字给界面用），
  //       下面两条断言立刻红 —— 那时「接线细节不算学生可见文本」就不再成立。
  const wiring = stripComments(read('src', 'renderer', 'src', 'api', 'wiring-notice.ts'))
  const warnBody = wiring.slice(
    wiring.indexOf('export function warnWiring'),
    wiring.indexOf('export function resetWiringNotices')
  )
  assert.ok(warnBody.length > 0, 'api/wiring-notice.ts 里必须有 warnWiring（接线诊断的唯一出口）')
  assert.match(warnBody, /console\.warn\(/, 'warnWiring 必须把 detail 交给 console.warn')
  for (const domSink of ['innerText', 'textContent', 'innerHTML', 'document.', 'return ']) {
    assert.ok(
      !warnBody.includes(domSink),
      `warnWiring 里出现了「${domSink}」—— 它一旦能把字交回界面，接线细节就不再是「只在控制台」了`
    )
  }

  // ④ labels.ts：**行为面** —— 学生那一半不许有破折号，教师那一半有（两半本来就该不同）。
  const labels = await import('../src/renderer/src/labels.ts')
  const forStudent = labels.llmChipTitle({ hasKey: false, modelId: 'deepseek-v4-flash' }, false)
  const forTeacher = labels.llmChipTitle({ hasKey: false, modelId: 'deepseek-v4-flash' }, true)
  assert.ok(!forStudent.includes(DASH_MARK), `学生看到的模型说明里出现了破折号：${forStudent}`)
  assert.ok(forTeacher.includes(DASH_MARK), '教师那一半仍是带破折号的原句（例外就是为它开的）')

  // ⑤ Settings.vue：破折号全部落在高级设置里。
  //    ★ 分两半判，因为两半的「在高级区」是两件事：
  //      · **模板**里的破折号 → 按**区域**判（它就在高级区那一段里）；
  //      · **脚本**里的破折号（`presetHint` / `probeSummary` 这两句白话结论）→ 按**持有者**判：
  //        持有它的 computed 必须在高级区被渲染（`{{ presetHint }}`），学生那三节里没有它。
  //    只按文件豁免是假绿：那段字随时可能被搬到学生那一节去（这正是技术词那条守卫踩过的坑）。
  const settings = stripComments(read('src', 'renderer', 'src', 'views', 'Settings.vue'))
  const advancedAt = settings.indexOf('data-testid="settings-advanced"')
  assert.ok(advancedAt > 0, '设置页必须有高级设置区（例外的前提）')
  const advancedEnd = settings.indexOf('<!-- ── 高级设置结束', advancedAt)
  const advancedRegion =
    advancedEnd > advancedAt ? settings.slice(advancedAt, advancedEnd) : settings.slice(advancedAt, settings.lastIndexOf('</template>'))
  const templateAt = settings.indexOf('<template>')
  assert.ok(
    templateAt > 0 && advancedAt > templateAt,
    `设置页必须是「script 在前、高级区在 template 里」的形状（实测 template 在 ${templateAt}、高级区在 ${advancedAt}）`
  )
  const dashes = [...settings.matchAll(/——/g)].map((match) => match.index)
  assert.ok(dashes.length > 0, '这条例外的前提是「破折号都在高级区里」—— 现在一个都没有了，请删掉这条条目')
  for (const at of dashes.filter((index) => index > templateAt)) {
    assert.ok(
      at > advancedAt && at < advancedAt + advancedRegion.length,
      '设置页的模板里出现了**高级区之外**的破折号（学生默认就能看到那一块）—— 例外不再成立'
    )
  }
  /**
   * 脚本里那几处破折号的持有者（`const X = computed(() => …)`）。
   * ⚠️ 找的是**它前面最近的那个 computed**：`presetHint` / `probeSummary` 都是这一形状。
   */
  const holders = [...settings.slice(0, templateAt).matchAll(/const (\w+) = computed\(/g)].map((match) => ({
    name: match[1],
    at: match.index
  }))
  const dashHolders: string[] = []
  for (const at of dashes.filter((index) => index < templateAt)) {
    const holder = holders.filter((entry) => entry.at < at).pop()
    assert.ok(holder, '脚本里的破折号必须落在一个 computed 里（找不到持有者就说明形状变了，同步这条凭据）')
    dashHolders.push(holder.name)
    assert.match(
      advancedRegion,
      new RegExp(`\\{\\{\\s*${holder.name}\\s*\\}\\}`),
      `破折号在 \`${holder.name}\` 里，但高级区没有渲染它 —— 那它渲染到哪去了？`
    )
  }
  for (const section of ['grade', 'chapter', 'theme']) {
    const at = settings.indexOf(`data-section="${section}"`)
    const end = settings.indexOf('</SurfacePanel>', at)
    const region = settings.slice(at, end > at ? end : at + 4000)
    assert.ok(!region.includes(DASH_MARK), `学生那一节「${section}」里出现了破折号 —— 它没有例外`)
    for (const holder of dashHolders) {
      assert.ok(!region.includes(holder), `学生那一节「${section}」渲染了 \`${holder}\`（那里面有破折号）`)
    }
  }

  // ⑥ pyodide.worker.ts：`capability.detail` 的唯一消费点必须是**一句 console**（从不上屏）。
  const runner = stripComments(read('src', 'renderer', 'src', 'sandbox', 'pyodide-runner.ts'))
  const detailLines = runner.split('\n').flatMap((line, index) => (line.includes('capability.detail') ? [index] : []))
  assert.ok(detailLines.length > 0, 'pyodide-runner.ts 仍要读 capability.detail（例外的前提）')
  for (const index of detailLines) {
    const around = runner.split('\n').slice(Math.max(0, index - 6), index + 2).join('\n')
    assert.match(around, /log\(/, '`capability.detail` 必须仍只进 console 日志（`log(...)`）—— 它一旦上屏，这条例外就不成立')
  }
  const card = read('src', 'renderer', 'src', 'cards', 'CodingCard.vue')
  assert.ok(!card.includes('capability.detail'), '关卡卡片只许读 `capability.interruptible`，不许把 detail 渲染出来')
})
