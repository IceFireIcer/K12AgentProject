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
const plain = (text) => text.replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/\u00a0/g, ' ')

console.log('── 磁盘真实值 ──────────────────────────────')
for (const [k, v] of Object.entries(facts)) console.log(`  ${k.padEnd(16)} ${v}`)
console.log(`  ${'教材篇数'.padEnd(16)} ${kbPoints}`)
if (kb) console.log(`  ${'知识库'.padEnd(16)} kp=${kb.kp} chunk=${kb.chunk} deps=${kb.deps} 章=${kb.chapters}`)
else console.log(`  ${'知识库'.padEnd(16)} （没找到 kb.sqlite 或 sqlite3，跳过）`)

console.log('\n── 文档是否与磁盘一致 ──────────────────────')
const failures = []
for (const { label, re, value, where } of checks) {
  for (const name of where) {
    if (docs[name] === undefined) continue
    const text = plain(docs[name])
    // 抓出所有「数字 + 关键词」，第 1 个非空捕获组就是那个数字
    const found = [...text.matchAll(re)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean)
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

if (process.argv.includes('--tests')) {
  console.log('\n── 真实测试数（较慢）───────────────────────')
  const t = testCounts()
  console.log(`  后端 ${t.backend} / 桌面 ${t.desktop} / 合计 ${t.backend + t.desktop}`)
  if (t.backend !== null && !docs.README.includes(String(t.backend))) {
    failures.push(`README 的『后端测试数』应为 ${t.backend}，文档里找不到`)
  }
  if (t.desktop !== null && !docs.README.includes(String(t.desktop))) {
    failures.push(`README 的『桌面测试数』应为 ${t.desktop}，文档里找不到`)
  }
}

if (failures.length) {
  console.log(`\n✗ ${failures.length} 处对不上：`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exitCode = 1
} else {
  console.log('\n✓ 文档里登记的数字与磁盘一致')
}
