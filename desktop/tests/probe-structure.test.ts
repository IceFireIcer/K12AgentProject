/**
 * 探针结构化守卫：优化报告 §5.3（WP-15）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 报告 §5.3 的执行计划：① 结构化锚点接口（id / selector / attribute / expected /
 * description）；② 组件加 `data-probe-*`（D12 范围：只给"量行为"的锚点）；
 * ③ 探针开跑前自动锚点自检（失配显式报"部分失败"）；④ 探针隔离；⑤ 失败自动截图；
 * ⑥ 维护指南与 checklist；⑦ axe 类规则（报告 §6.4 的自研等价物）。
 *
 * 本文件把 ①②③④⑤⑥⑦ 变成机器判据：
 *   · `scripts/probe-lib.mjs` 的锚点表**每条**字段齐全，且它的 selector 指向的
 *     `data-probe-id` / `data-testid` **真的存在于渲染层源码**；
 *   · 学生面探针真的 import 了这份库（自检 / 隔离 / 截图 / axe 规则是"用了"而不是"写了"）；
 *   · 维护指南存在且含 checklist。
 *
 * 跑法：`npm test`（纯源码扫描，不需要真机）。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

const lib = await import('../scripts/probe-lib.mjs')

function rendererText(): string {
  const files = readdirSync(join(desktopRoot, 'src', 'renderer', 'src'), {
    withFileTypes: true,
    recursive: true
  })
    .filter((entry) => entry.isFile() && /\.(vue|ts)$/.test(entry.name))
    .map((entry) => {
      const parent =
        (entry as unknown as { parentPath?: string }).parentPath ??
        (entry as unknown as { path?: string }).path ??
        'src/renderer/src'
      return readFileSync(join(parent, entry.name), 'utf8')
    })
  return files.join('\n')
}

/* ------------------------------------------------------------------ *
 * 1. ★★ 结构化锚点接口
 * ------------------------------------------------------------------ */

test('★★ 锚点表每条都有 id/selector/attribute/expected/description（接口齐全）', () => {
  assert.ok(lib.ANCHORS.length >= 5, `锚点表太小（${lib.ANCHORS.length} 条）—— 判据本身可能失效了`)
  for (const anchor of lib.ANCHORS) {
    for (const field of ['id', 'selector', 'description']) {
      assert.ok(
        typeof anchor[field] === 'string' && anchor[field].length > 0,
        `锚点 ${anchor.id ?? '(无 id)'} 缺 ${field}`
      )
    }
    // attribute / expected 允许为 null（= 只检查存在），但字段本身必须在
    assert.ok('attribute' in anchor, `锚点 ${anchor.id} 缺 attribute 字段（只检查存在时写 null）`)
    assert.ok('expected' in anchor, `锚点 ${anchor.id} 缺 expected 字段`)
    assert.ok(anchor.selector.startsWith('['), `锚点 ${anchor.id} 的 selector 必须是属性选择器`)
  }
})

test('★★ 锚点的选择器必须真的存在于渲染层（锚点腐烂的机器防线）', () => {
  const renderer = rendererText()
  const missing: string[] = []
  for (const anchor of lib.ANCHORS) {
    const matched = /^\[(data-(?:probe-id|testid))="([^"]+)"\]$/.exec(anchor.selector)
    if (matched === null) {
      missing.push(`${anchor.id} 的选择器形态不认（${anchor.selector}）`)
      continue
    }
    const [, attribute, value] = matched
    if (!renderer.includes(`${attribute}="${value}"`)) {
      missing.push(`${anchor.id} → ${attribute}="${value}" 在渲染层找不到`)
    }
  }
  assert.deepEqual(missing, [], `这些锚点只在探针库里存在：\n${missing.join('\n')}`)
})

test('★ 自检脚本可解析，且能报出「缺失 / 行为不符」两类结果', () => {
  assert.ok(
    lib.VERIFY_ANCHORS_SCRIPT.includes('mismatched') && lib.VERIFY_ANCHORS_SCRIPT.includes('missing'),
    '自检脚本要同时汇报 missing 与 mismatched（报告 §5.3 的「部分失败」口径）'
  )
  // 语法自检（不执行：它要 document）
  new Function(lib.VERIFY_ANCHORS_SCRIPT)
  const report = lib.formatAnchorReport({
    checked: 1,
    total: 2,
    missing: [{ id: 'x', selector: '[data-probe-id="x"]', description: 'd' }],
    mismatched: [{ id: 'y', attribute: 'a', expected: '1', actual: '2', description: 'd' }]
  })
  assert.match(report, /缺锚点/)
  assert.match(report, /行为不符/)
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 隔离 / 截图 / axe 类规则：写了且被用
 * ------------------------------------------------------------------ */

test('★★ 隔离与截图：helper 存在，且学生面探针真的接了', () => {
  const cleanup = lib.CLEANUP_SCRIPT(['k12.reducedMotion'])
  assert.match(cleanup, /k12\.reducedMotion/, '隔离脚本要能按给定的键清 localStorage')
  assert.match(
    cleanup,
    /removeItem\(key\)/,
    '隔离要**按给定的键逐个删除** —— `localStorage.clear()` 会顺手删掉学生自己的偏好'
  )
  assert.match(cleanup, /data-probe-injected/, '隔离脚本要能移除探针注入的元素')
  assert.equal(typeof lib.captureFailureScreenshot, 'function', '失败截图 helper 要导出')

  const pages = read('scripts', 'ux-pages-audit.mjs')
  assert.match(pages, /from '\.\/probe-lib\.mjs'/, 'ux-pages-audit 要接公共库')
  assert.match(
    pages,
    /cdp\.evaluate\(VERIFY_ANCHORS_SCRIPT\)/,
    'ux-pages-audit 开跑前要**真的跑**锚点自检（只 import 不算）'
  )
  assert.match(pages, /captureFailureScreenshot/, 'ux-pages-audit 失败时要截图')
  assert.match(pages, /A11Y_SCRIPT/, 'ux-pages-audit 要跑 axe 类规则')

  const motion = read('scripts', 'ux-probe-reduced-motion.mjs')
  assert.match(motion, /CLEANUP_SCRIPT/, '减动效探针要用隔离脚本')
  assert.match(motion, /priorMode/, '减动效探针要先记住旧偏好（收尾写回，别改学生的设置）')
})

test('★★ axe 类规则覆盖报告点名的三类（键盘 / 语义 / 对比度）', () => {
  const script = lib.A11Y_SCRIPT
  assert.match(script, /no-focusable-hidden/, '要有「aria-hidden 子树里的可聚焦元素」这条（键盘）')
  assert.match(script, /interactive-name/, '要有「可交互元素没有名字」这条（语义）')
  assert.match(script, /text-contrast/, '要有对比度那条')
  assert.match(script, /4\.5/, '对比度阈值是 4.5:1')
})

/* ------------------------------------------------------------------ *
 * 3. ★★ D12：只有"量行为"的锚点才配 data-probe-*
 * ------------------------------------------------------------------ */

test('★★ data-probe-* 只加在量行为的锚点上（题数 / 开合态 / 进度卡数）', () => {
  const targets: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['cards/QuizCard.vue', '练习卡', ['data-probe-id="quiz-card"', ':data-probe-count=']],
    ['cards/ProgressCard.vue', '进度卡', ['data-probe-id="progress-card"', ':data-probe-count=']],
    [
      'components/ChatMessage.vue',
      '引用折叠',
      ['data-probe-id="citation-disclosure"', ':data-probe-expanded=']
    ],
    ['components/SessionList.vue', '会话折叠', ['data-probe-id="session-fold"']]
  ]
  for (const [file, label, tokens] of targets) {
    const source = read(...`src/renderer/src/${file}`.split('/'))
    for (const token of tokens) {
      assert.ok(source.includes(token), `${label}（${file}）缺 ${token}`)
    }
  }
  // 别把 data-probe-* 撒到所有组件上（D12 的判据：量行为才加）
  const components = readdirSync(join(desktopRoot, 'src', 'renderer', 'src', 'components'), {
    withFileTypes: true
  }).filter((entry) => entry.isFile() && entry.name.endsWith('.vue'))
  const withProbe = components.filter((entry) =>
    read('src', 'renderer', 'src', 'components', entry.name).includes('data-probe-')
  )
  assert.ok(
    withProbe.length <= 6,
    `带 data-probe-* 的组件有 ${withProbe.length} 个（${withProbe.map((e) => e.name).join('、')}）—— ` +
      'D12 的范围是「只给量行为的锚点」，全量铺开会让每个组件都背一层探针属性'
  )
})

/* ------------------------------------------------------------------ *
 * 4. ★ 维护指南
 * ------------------------------------------------------------------ */

test('★ 维护指南存在，且含「改组件 checklist」与「CI」两节', () => {
  const guide = readFileSync(join(repoRoot, 'docs', 'agents', 'probe-guide.md'), 'utf8')
  assert.match(guide, /checklist/, '指南要有改组件的 checklist')
  assert.match(guide, /data-probe-/, '指南要解释两类锚点的分工')
  assert.match(guide, /CLEANUP_SCRIPT/, '指南要写清隔离怎么做')
  assert.match(guide, /CI/, '指南要说明 CI 那条由 npm test 满足')
})
