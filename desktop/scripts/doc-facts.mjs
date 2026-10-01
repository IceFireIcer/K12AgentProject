/**
 * 把 `README.md`（入库）与 `architecture/index.html`（**本地文件，不入库**）里
 * 声明过的数字，与磁盘上的真实值逐项对照。
 *
 * 为什么需要它：这两份文档面向评委与新人，里面写的是「回归 627 项」「228 个知识点」
 * 这类**会随每次提交变化**的量。靠人记得同步必然漂移 —— 这个仓库已经发生过
 * （`tests 1,289`、`33 篇教材`、`13 个方法` 都过期过一轮）。所以让机器来查。
 *
 * ⚠️ 它**不做自动改写**：只报「文档说 X、磁盘是 Y」。
 *    数字该不该写进文档、写哪个口径，仍要人来判断（比如测试数就不该写死得太细）。
 * ⚠️ `architecture/` 是被 `.git/info/exclude` 挡住的本地目录，别人克隆下来没有它 ——
 *    所以缺了它只跳过、不报错（这个脚本是入库的，不能在干净克隆上一跑就红）。
 *
 * ---------------------------------------------------------------------------
 * 两层判据（测试数为什么要分两层）
 * ---------------------------------------------------------------------------
 *
 * 第一层（**默认就跑**，毫秒级）：文档**自洽性**——
 *   README 里声明的三个数（后端 / 桌面 / 合计）必须彼此对得上（合计 = 两者之和），
 *   且「声明了一部分」也算失败（半更新正是这条要抓的形态）。
 *   兜住的是最常发生的那种漂移：改了 `627` 却忘了改 badge 上的 `1546`。
 *
 * 第二层（`--tests`，**慢**）：与**真实值**比对 —— 真跑两个套件取用例数。
 *   ⚠️ 为什么不默认跑：后端套件实测约 95s，塞进 `npm test` 会把每次回归的时间翻倍
 *     （而 `npm test` 本来就已经跑了一遍桌面套件）。数字的正确性属于「收口前查一次」，
 *     不属于「每次提交都查」—— 所以留在显式开关后面，由第一层保证不会静默半更新。
 *   ⚠️ 拿到真实值之后，判据是**关键词锚定 + 逐处枚举**（见下方 checks 表），
 *     **不是** `text.includes(String(count))` —— 那种全文档子串匹配任何一处命中就算过，
 *     正是同一份文件里已经批评过的写法（见 checks 表的注释）。
 *
 * 跑法：`npm run check:docs`（加 `--tests` 会真跑两个套件，慢但最准）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOT = dirname(DESKTOP)

/** 递归收集匹配扩展名的文件。 */
function collect(dir, exts) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collect(full, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

/** 这些行数用于文档展示，数的是**手写源码**，所以要排掉自动生成的声明文件。 */
const GENERATED = new Set(['auto-imports.d.ts', 'components.d.ts'])

/**
 * 行数按 `wc -l` 的语义（数**换行符**，不是 `split('\n').length`）——
 * 后者对「以换行结尾」的文件会多算一行，与文档里已经写下的数字对不上。
 * 这两种口径混用过一次，整整一屏数字差 1，查起来很费劲。
 */
const wcLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

const lineCount = (files) =>
  files
    .filter((f) => !GENERATED.has(f.split(/[\\/]/).pop()))
    .reduce((sum, f) => sum + wcLines(readFileSync(f, 'utf8')), 0)

/** 跑测试套件取真实用例数（慢，但这是唯一不会漂移的口径）。 */
function testCounts() {
  const py = execFileSync('uv', ['run', 'python', '-m', 'unittest', 'discover', '-s', 'tests'], {
    cwd: join(ROOT, 'server'),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const pyMatch = py.match(/Ran (\d+) tests/)
  const node = execFileSync('npx', ['node', '--test', '--test-reporter=tap', ...collect(join(DESKTOP, 'tests'), ['.test.ts'])], {
    cwd: DESKTOP,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const nodeMatch = node.match(/^# tests (\d+)$/m)
  return { backend: pyMatch ? Number(pyMatch[1]) : null, desktop: nodeMatch ? Number(nodeMatch[1]) : null }
}

/** 从 kb.sqlite 读知识库规模（需要 sqlite3，Windows 上可能没有 → 允许跳过）。 */
function kbStats() {
  try {
    const out = execFileSync(
      'sqlite3',
      [
        join(ROOT, 'server', '_data', 'shared', 'kb.sqlite'),
        'select (select count(*) from kp), (select count(*) from chunk), (select count(*) from knowledge_dependencies), (select count(distinct chapter_title) from chunk);',
      ],
      { encoding: 'utf8' },
    )
    const [kp, chunk, deps, chapters] = out.trim().split('|').map(Number)
    return { kp, chunk, deps, chapters }
  } catch {
    return null
  }
}

const docs = { README: readFileSync(join(ROOT, 'README.md'), 'utf8') }
// architecture/ 不入库 → 干净克隆里不存在，跳过而不是报错
const archPage = join(ROOT, 'architecture', 'index.html')
if (existsSync(archPage)) docs['index.html'] = readFileSync(archPage, 'utf8')

const preload = readFileSync(join(DESKTOP, 'src', 'preload', 'index.ts'), 'utf8')
const preloadMethods = (preload.match(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*:\s*\(/gm) || []).length

const channels = readFileSync(join(DESKTOP, 'src', 'main', 'ipc', 'channels.ts'), 'utf8')
const channelCount = (channels.match(/^\s+[a-zA-Z]+: '[a-z-]+:[a-z-]+'/gm) || []).length

const facts = {
  '主进程行数': lineCount(collect(join(DESKTOP, 'src', 'main'), ['.ts'])),
  '渲染进程行数': lineCount(collect(join(DESKTOP, 'src', 'renderer'), ['.ts', '.vue'])),
  'Python app 行数': lineCount(collect(join(ROOT, 'server', 'app'), ['.py'])),
  'preload 方法数': preloadMethods,
  'IPC 通道数': channelCount,
  '契约模型数': (() => {
    const c = readFileSync(join(ROOT, 'server', 'app', 'contracts.py'), 'utf8')
    return Number((c.match(/CONTRACT_MODELS: tuple\[type\[BaseModel\], \.\.\.\] = \(([\s\S]*?)\n\)/) || [, ''])[1].split('\n').filter((l) => l.trim().endsWith(',')).length)
  })(),
}

const kb = kbStats()
const kbPoints = collect(join(ROOT, 'server', 'knowledge'), ['.md']).filter((f) => !f.endsWith('README.md')).length

/**
 * 断言表：每条给一个**带捕获组的关键词正则**，把「数字 + 关键词」的每一处都抓出来，
 * 要求**每一处**都等于磁盘真实值。
 *
 * ★ 为什么不是 `text.includes('228')`：那种写法**任何一处**命中就算过 ——
 *   文档里同一个数字往往出现两三次（正文一处、目录树一处），
 *   只改一处留下的「半更新」会被它放行。第一版就是这么写的，变异验证时当场漏了。
 *   所以这里改成「全量枚举 + 逐一比对」：漏改任何一处都红。
 *
 * ⚠️ 正则**只锚定「当时的声明」那种写法**，不去抓所有带同一个词的句子 ——
 *   文档里还有大量**历史叙事**（「preload 方法 13 → 21」「当时 13 条起步」），
 *   那些数字是正确的历史记录，不该按当前值判错。第一版用 `([\d,]+) 条?通道`
 *   这种宽松式，把历史叙事全卷进来误报了一屏。锚得越窄越可信。
 *
 * ⚠️ 也要容忍排版噪声：`**228** 个知识点`、`228 个知识点`、`228 知识点` 是同一件事，
 *   HTML 那边还有标签，所以匹配前先做一次「去标记」归一化。
 */
const checks = [
  { label: '知识点数', re: /([\d,]+)\s*个?\s*知识点/g, value: kbPoints, where: ['README', 'index.html'] },
  // ⚠️ 每个 check 默认取「第 1 个非空捕获组」；`group` 用于**一条声明里含两个数**的写法
  //   （例如「后端 919 + 桌面 627」），此时同一条正则按 group 拆成多条 check。
  //   见下方 testCountChecks()。
  { label: '教材篇数', re: /([\d,]+)\s*篇/g, value: kbPoints, where: ['index.html'] },
  { label: '契约模型数', re: /([\d,]+)\s*个?\s*契约模型/g, value: facts['契约模型数'], where: ['index.html'] },
  { label: 'preload 白名单通道', re: /白名单\s*([\d,]+)\s*通道/g, value: channelCount, where: ['index.html'] },
  { label: 'preload 方法数', re: /([\d,]+)\s*个?\s*方法/g, value: preloadMethods, where: ['index.html'] },
]
// README 里 preload 方法数写成「48 个方法」时才算声明过 —— 没有就不查（别造一个假要求）
if (docs.README && /preload[^\n]{0,60}[\d,]+ 个方法/.test(docs.README)) {
  checks.push({ label: 'preload 方法数', re: /([\d,]+)\s*个?\s*方法/g, value: preloadMethods, where: ['README'] })
}

// kb.sqlite 只在本地有（`server/_data*/` 被忽略），拿到才校验
if (kb) {
  checks.push(
    { label: '随包分块数', re: /([\d,]+)\s*chunk/g, value: kb.chunk, where: ['index.html'] },
    { label: '依赖边数', re: /([\d,]+)\s*条?\s*依赖边/g, value: kb.deps, where: ['README', 'index.html'] },
  )
}

/** 去掉会影响匹配的排版标记：HTML 标签、Markdown 粗体、全角空格。 */
/*
 * 取「像人读的那份文本」：剥掉 HTML 标签与 Markdown 加粗、把不换行空格换成普通空格。
 *
 * ★★ 2026-10-01 修一个**会静默吃掉半篇文档**的既有缺陷（P-170）：
 *   原来这里是 `<[^>]+>` —— 只要正文里出现一个裸的 `<`（例如写「学生 < 教师 < 调试」），
 *   它就会从那个 `<` 一路匹配到**后文下一个 `>`**，把中间整段（连同登记的数字）一起删掉，
 *   于是守卫报「文档里找不到对应的数字」—— 明明写在那儿。
 *   现在只认**真的像标签**的开头（字母或 `/`），裸 `<` 一律保留。
 */
const plain = (text) =>
  text.replace(/<[a-zA-Z/][^>]*>/g, '').replace(/\*\*/g, '').replace(/\u00a0/g, ' ')

/* ------------------------------------------------------------------ *
 * 测试数：声明点逐处锚定
 * ------------------------------------------------------------------ */

/**
 * README / index.html 里「测试数」的声明点锚（**一处一条**，不写宽泛的 `([\d,]+)\s*项`）。
 *
 * ★ 为什么每条都带一大串前后文：同一个文档里还有大量**别的**「N 项」
 *   （`26 项产物自检` / `23 项` UX 体检 / `28 项决策` / 历史叙事里的 `877 项测试全绿`），
 *   宽泛正则会把它们全卷进来，然后按当前值判错（第一版就是这么误报一屏的）。
 *   锚得越窄越可信 —— 代价是措辞改动会让它报「没找到」，那是**响亮失败**，可以接受。
 *
 * `group` 的语义：一条声明里含多个数时，用同一个正则按捕获组拆成多条 check。
 */
const TEST_COUNT_ANCHORS = {
  /** README 顶部 badge：`回归测试-1546%20项%20全绿` */
  readmeTotal: { re: /回归测试-([\d,]+)%20项/g, where: ['README'], label: '测试总数（badge）' },
  /** README 两条命令注释：`npm test  # 627 项 …` */
  readmeDesktop: { re: /npm test[^\n]*?([\d,]+)\s*项/g, where: ['README'], label: '桌面测试数（npm test）' },
  /** README 命令注释：`unittest discover -s tests  # 919 项` */
  readmeBackend: {
    re: /unittest discover -s tests[^\n]*?([\d,]+)\s*项/g,
    where: ['README'],
    label: '后端测试数（unittest）'
  },
  /** README 目录树：桌面那行带括号说明，后端那行不带 —— 用括号反选区分（同一写法两处） */
  readmeTreeDesktop: { re: /tests\/\s+([\d,]+)\s*项回归（/g, where: ['README'], label: '目录树-桌面测试数' },
  readmeTreeBackend: { re: /tests\/\s+([\d,]+)\s*项回归(?!（)/g, where: ['README'], label: '目录树-后端测试数' },
  /** index.html 的合并声明：`1,546 项测试（后端 919 + 桌面 627）`（同一句式出现两处，值必须一致） */
  archCombined: {
    re: /([\d,]+)\s*项测试（后端\s*([\d,]+)\s*\+\s*桌面\s*([\d,]+)）/g,
    where: ['index.html'],
    label: '合并声明'
  },
  /** index.html 的「规模」行：`规模：后端 919 项（…）+ 桌面 627 项（…）= 1,546 项` */
  archScale: {
    re: /规模：后端\s*([\d,]+)\s*项[^\n]*?桌面\s*([\d,]+)\s*项[^\n]*?([\d,]+)\s*项/g,
    where: ['index.html'],
    label: '规模行'
  },
  /** index.html 的另一处合计：`npm test 1,546 项全绿时` */
  archGreen: { re: /([\d,]+)\s*项全绿/g, where: ['index.html'], label: '合计（全绿）' }
}

/**
 * 真实测试数 → 一组**关键词锚定**的 checks（逐处枚举，任一处不对就红）。
 *
 * ⚠️ 这里刻意**不**写成 `docs.README.includes(String(count))`：
 *   那种全文档子串匹配任何一处命中就算过，而同一个数字在文档里往往出现两三处
 *   （正文一处、目录树一处、命令注释一处），只改一处留下的「半更新」会被它放行。
 *   本文件 checks 表上方的注释已经把这条判据讲得很清楚了 —— 测试数没有理由例外。
 */
function testCountChecks(counts) {
  const { backend, desktop } = counts
  const total = backend !== null && desktop !== null ? backend + desktop : null
  const entries = []

  if (total !== null) {
    entries.push({ ...TEST_COUNT_ANCHORS.readmeTotal, value: total })
    entries.push({ ...TEST_COUNT_ANCHORS.archGreen, value: total })
    // index.html 的合并声明 / 规模行：同一正则按 group 拆成三条
    entries.push({ label: `${TEST_COUNT_ANCHORS.archCombined.label}-合计`, ...TEST_COUNT_ANCHORS.archCombined, group: 1, value: total })
    entries.push({ label: `${TEST_COUNT_ANCHORS.archScale.label}-合计`, ...TEST_COUNT_ANCHORS.archScale, group: 3, value: total })
  }
  if (backend !== null) {
    entries.push({ ...TEST_COUNT_ANCHORS.readmeBackend, value: backend })
    entries.push({ ...TEST_COUNT_ANCHORS.readmeTreeBackend, value: backend })
    entries.push({ label: `${TEST_COUNT_ANCHORS.archCombined.label}-后端`, ...TEST_COUNT_ANCHORS.archCombined, group: 2, value: backend })
    entries.push({ label: `${TEST_COUNT_ANCHORS.archScale.label}-后端`, ...TEST_COUNT_ANCHORS.archScale, group: 1, value: backend })
  }
  if (desktop !== null) {
    entries.push({ ...TEST_COUNT_ANCHORS.readmeDesktop, value: desktop })
    entries.push({ ...TEST_COUNT_ANCHORS.readmeTreeDesktop, value: desktop })
    entries.push({ label: `${TEST_COUNT_ANCHORS.archCombined.label}-桌面`, ...TEST_COUNT_ANCHORS.archCombined, group: 3, value: desktop })
    entries.push({ label: `${TEST_COUNT_ANCHORS.archScale.label}-桌面`, ...TEST_COUNT_ANCHORS.archScale, group: 2, value: desktop })
  }
  return entries.filter((entry) => entry.value !== null && entry.value !== undefined)
}

/**
 * ★ 第一层（默认跑的）：**文档自洽性** —— 三个声明数彼此必须对得上。
 *
 * 不跑套件，只比文档里的数字，所以是毫秒级：能挂在 `npm test` 上。
 * 它抓的是最常见的那种漂移：**改了套件数、忘了改合计**（或反过来）。
 * 真实值比对留给 `--tests`（慢），两者分工见文件头。
 *
 * @returns 问题描述数组（空数组 = 通过 / 或文档没声明过、无从判断）
 */
function readmeConsistencyIssues(text) {
  const numbers = {
    backend: firstNumber(text, TEST_COUNT_ANCHORS.readmeBackend.re),
    desktop: firstNumber(text, TEST_COUNT_ANCHORS.readmeDesktop.re),
    total: firstNumber(text, TEST_COUNT_ANCHORS.readmeTotal.re)
  }
  const known = Object.entries(numbers).filter(([, value]) => value !== null)
  if (known.length === 0) return [] // 文档不再声明测试数：无从判断，静默跳过（不造一个假要求）
  if (known.length < 3) {
    const missing = Object.entries(numbers).filter(([, value]) => value === null).map(([key]) => key)
    return [`README 的测试数声明不完整：缺 ${missing.join(' / ')} —— 半更新正是这条要抓的形态`]
  }
  if (numbers.total !== numbers.backend + numbers.desktop) {
    return [
      `README 的测试数彼此对不上：后端 ${numbers.backend} + 桌面 ${numbers.desktop} ` +
        `= ${numbers.backend + numbers.desktop}，但 badge 写的是 ${numbers.total}`
    ]
  }
  return []
}

/** 取某个锚的**第一个**捕获值（去掉千分位逗号）。 */
function firstNumber(text, re) {
  const match = [...text.matchAll(re)][0]
  if (!match) return null
  const raw = (match[1] ?? '').trim()
  return raw ? Number(raw.replace(/,/g, '')) : null
}

console.log('── 磁盘真实值 ──────────────────────────────')
for (const [k, v] of Object.entries(facts)) console.log(`  ${k.padEnd(16)} ${v}`)
console.log(`  ${'教材篇数'.padEnd(16)} ${kbPoints}`)
if (kb) console.log(`  ${'知识库'.padEnd(16)} kp=${kb.kp} chunk=${kb.chunk} deps=${kb.deps} 章=${kb.chapters}`)
else console.log(`  ${'知识库'.padEnd(16)} （没找到 kb.sqlite 或 sqlite3，跳过）`)

const failures = []

/* ------------------------------------------------------------------ *
 * 第一层：文档自洽性（默认跑；毫秒级）
 * ------------------------------------------------------------------ */

if (docs.README) {
  const issues = readmeConsistencyIssues(plain(docs.README))
  for (const issue of issues) failures.push(issue)
  if (issues.length === 0) {
    console.log('  ✓ README 的测试数彼此自洽（后端 + 桌面 = 合计）')
  }
}

/* ------------------------------------------------------------------ *
 * 第二层：真跑两个套件取真实值（`--tests`，慢）
 * ------------------------------------------------------------------ */

if (process.argv.includes('--tests')) {
  console.log('\n── 真实测试数（较慢）───────────────────────')
  const t = testCounts()
  console.log(`  后端 ${t.backend} / 桌面 ${t.desktop} / 合计 ${t.backend + t.desktop}`)
  // ★ 逐处锚定 + 全量枚举（**不是** includes 子串匹配）——
  //   同一份文档里每个数字都声明了不止一处，只改一处必须红。
  checks.push(...testCountChecks(t))
}

console.log('\n── 文档是否与磁盘一致 ──────────────────────')
for (const { label, re, value, where, group } of checks) {
  for (const name of where) {
    if (docs[name] === undefined) continue
    const text = plain(docs[name])
    // 抓出所有「数字 + 关键词」，默认取第 1 个非空捕获组（`group` 指定时按它取）
    const found = [...text.matchAll(re)]
      .map((m) => ((group === undefined ? (m[1] ?? m[2]) : m[group]) ?? '').trim())
      .filter(Boolean)
    const bad = found.filter((s) => Number(s.replace(/,/g, '')) !== value)
    if (found.length === 0) {
      failures.push(`${name} 的「${label}」：磁盘是 ${value}，但文档里找不到对应的「数字+关键词」`)
      console.log(`  ✗ ${name.padEnd(11)} ${label.padEnd(14)} 没找到（应为 ${value}）`)
    } else if (bad.length) {
      failures.push(`${name} 的「${label}」出现了旧值 ${bad.join(' / ')}（应为 ${value}）`)
      console.log(`  ✗ ${name.padEnd(11)} ${label.padEnd(14)} 旧值 ${bad.join(' / ')}（应为 ${value}）`)
    } else {
      console.log(`  ✓ ${name.padEnd(11)} ${label.padEnd(14)} ${value} ×${found.length} 处`)
    }
  }
}

if (failures.length) {
  console.log(`\n✗ ${failures.length} 处对不上：`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exitCode = 1
} else {
  console.log('\n✓ 文档里登记的数字与磁盘一致')
}
