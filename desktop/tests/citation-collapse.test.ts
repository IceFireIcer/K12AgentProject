/**
 * 教材引用**默认收起**（用户 2026-09-26 的设计裁决）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 缺陷现场：一次检索常常回来 3～5 条引用，每条是「小节标题 + 出处 + 节级摘录」三行 ——
 * 铺开时一次插入 376～663px（`views/Chat.vue` 的文件头记着这个实测值），学生要读的正文
 * 被压到屏幕下方。现在把它收成一行摘要，点开才展开。
 *
 * 三条纪律，每条都对应一种「看起来只是不好看了、其实是内容丢了」的缺陷：
 *
 * 1. ★★ **默认必须是收起**：这一条就是这次改动的全部目的。写成 `<details open>`、
 *    或者拿 `:open="true"` 绑一个初始值，都等于没改。
 * 2. ★★ **收起态也要看得见「向上兼容」**：执行文档 §6.4 与 `docs/业务陷阱清单.md` §2
 *    要求跨学段向上兼容取用必须**显式标注**。收起是默认态 —— 把标注一起藏起来，
 *    等于把「参考了高年级内容」这件事从学生眼前拿掉（票 13 的验收里正有一条指着它）。
 * 3. ★★ **引用一条都不能少**：`citation-sources` 的 `li` 条数被体检脚本
 *    （`scripts/ux-scroll-attribution.mjs` / `scripts/verify-ui.mjs`）用来判「引用真的
 *    渲染出来了没」。折叠只允许改变**可见性**，不允许改变条数与顺序（`v-for` 仍走 `sourceRows`）。
 *
 * ⚠️ 为什么用原生 `<details>/<summary>`（而不是自己写「按钮 + aria-expanded + v-if」）：
 *    展开语义、键盘 Tab + Enter、读屏播报全部自带；而收起时内层是**真的不渲染**
 *    （不是裁剪宽度）—— `tests/panel-collapse.test.ts` 记过这一类缺陷：被裁剪的元素仍有
 *    矩形，体检脚本会把看不见的东西量成「学生能点的目标」。
 *    先例：`views/Dependency.vue` 的章节折叠组（「自己写手风琴就必然有人漏掉一条」）。
 *
 * 跑法：`npm test`（源码级断言）；真机效果由 `scripts/verify-ui.mjs` 的注入那一节量。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

/** 剥掉 HTML 与 JS 注释：注释里**刻意**引了旧写法（讲为什么改），不剥会被注释喂饱。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const CHAT_MESSAGE = 'src/renderer/src/components/ChatMessage.vue'

/**
 * 取某个标签的**开标签全文**（含跨行的属性）。
 *
 * ⚠️ 不能用 `[^>]*>` 这种朴素写法：属性值里就会出现 `>`（`v-if="turn.citations.length > 0"`），
 *    第一版就这么截在了 `turn.citations.length >` 上，报了一个不存在的缺陷。
 */
function openTag(source: string, name: string): string {
  const match = new RegExp(`<${name}\\b(?:"[^"]*"|[^>"])*>`).exec(source)
  assert.ok(match !== null, `找不到 <${name}> 开标签`)
  return match[0]
}

/* ------------------------------------------------------------------ *
 * 1. ★★ 默认收起：`<details>` 不带 `open`、也不绑 `:open`
 * ------------------------------------------------------------------ */

test('★★ 教材引用默认收起：折叠块是 `<details>`，且**不带** `open` / `:open`', () => {
  const source = read(...CHAT_MESSAGE.split('/'))
  const code = stripComments(source)

  assert.ok(code.includes('<details'), '找不到引用折叠块（`<details>`）——默认收起这一条就无从谈起')
  const tag = openTag(code, 'details')

  assert.match(
    tag,
    /data-testid="citation-disclosure"/,
    '折叠块要有稳定的锚点（体检脚本按它判收起 / 展开）'
  )
  assert.doesNotMatch(tag, /\bopen\b/, '★★ 不许写 `open` 属性——那会让引用**默认就是展开**的')
  assert.doesNotMatch(tag, /:open=/, '★★ 不许绑 `:open`——初值一旦漂了，默认收起这条纪律就没了')

  // `v-if` 留在 details 上（没有引用就整块不渲染），且判据仍是「这一轮有没有引用」
  assert.match(
    tag,
    /v-if="turn\.citations\.length > 0"/,
    '没有引用时整块不渲染（不要留一个空的可点行）'
  )
})

test('★★ 摘要行本身就是开关：`<summary>` 带 `.k12-tap`（28px 触控下限）', () => {
  const code = stripComments(read(...CHAT_MESSAGE.split('/')))

  assert.ok(code.includes('<summary'), '折叠块里必须有 `<summary>`（原生展开开关）')
  const summary = openTag(code, 'summary')

  assert.match(
    summary,
    /class="cites__toggle k12-tap"/,
    '★★ `<summary>` 要带 `.k12-tap` —— 手写按钮的 28px 触控下限住在设计系统里，页面不许自己写死尺寸'
  )
  // 摘要行只讲「参考了哪些地方」，不写「展开」二字（原生 details 自带展开语义）
  assert.doesNotMatch(summary, /展开/, '摘要行不写「展开」二字：`<details>` 自己会播报收起 / 展开')
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 收起态仍要看得见「向上兼容」
 * ------------------------------------------------------------------ */

test('★★ 收起态也要标出「向上兼容」（跨学段取用不能因为默认收起就从学生眼前消失）', () => {
  const code = stripComments(read(...CHAT_MESSAGE.split('/')))

  assert.match(
    code,
    /const hasCompat = computed\(\(\) => props\.turn\.citations\.some\(\(citation\) => citation\.compat\)\)/,
    '是否跨学段取用的判据只有一处：`turn.citations` 里的 `compat`（前端不重新推理检索）'
  )
  assert.match(
    code,
    /data-testid="citation-compat-summary"/,
    '★ 收起那一行必须有自己的「向上兼容」角标锚点（票 13 的可见性要求指着它）'
  )
  assert.match(
    code,
    /<span v-if="hasCompat" class="cites__compat" data-testid="citation-compat-summary">向上兼容<\/span>/,
    '收起行的角标与展开后每条的角标（`citation-compat`）是两个问题：这里回答「有没有」，那条回答「哪一条」'
  )
  // 展开后逐条标注仍在（SourceChips 一个字没改）
  const chips = read('src', 'renderer', 'src', 'components', 'SourceChips.vue')
  assert.match(
    chips,
    /data-testid="citation-compat">向上兼容<\/span>/,
    '展开后的逐条标注必须保留（SourceChips 不改）'
  )
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 一条都不许少：胶囊与书目都搬进折叠体，`v-for` 仍走 `sourceRows`
 * ------------------------------------------------------------------ */

test('★★ 折叠只改可见性，不改条数：胶囊与书目都在折叠体里，顺序仍跟随 `sourceRows`', () => {
  const code = stripComments(read(...CHAT_MESSAGE.split('/')))

  const detailsAt = code.indexOf('data-testid="citation-disclosure"')
  const bodyAt = code.indexOf('class="cites__body"')
  const chipsAt = code.indexOf('<SourceChips')
  const listAt = code.indexOf('data-testid="citation-sources"')
  const closeAt = code.indexOf('</details>')
  assert.ok(detailsAt > 0 && bodyAt > 0 && chipsAt > 0 && listAt > 0 && closeAt > 0, '折叠块的结构缺了一块')
  assert.ok(
    detailsAt < bodyAt && bodyAt < chipsAt && chipsAt < listAt && listAt < closeAt,
    '章节胶囊与「原文」书目都必须在折叠体里（`cites__body` 内、`</details>` 之前）'
  )

  // 条数与顺序的唯一来源仍是 `sourceRows`（＝ `turn.citations` 逐条映射），不许在这里过滤 / 截断
  assert.match(
    code,
    /<li v-for="\(row, index\) in sourceRows" :key="row\.citation\.chunkId">/,
    '★ 书目仍按 `sourceRows` 逐条渲染（体检脚本按 `citation-sources` 的 `li` 条数判引用渲染出来了没）'
  )
  assert.doesNotMatch(
    code,
    /<SourceChips[^>]*v-if=/,
    '胶囊不许自己加条件（`turn.citations.length > 0` 已经由折叠块判过一次）'
  )
  assert.doesNotMatch(code, /v-html/, '引用区不许出现 `v-html`（正文渲染同样不走它）')
})

test('★ 摘录与「原文」按钮一个字没改（点开折叠后仍是原来的那条链路）', () => {
  const code = stripComments(read(...CHAT_MESSAGE.split('/')))

  for (const anchor of [
    'class="srcs__num k12-num"',
    'class="srcs__title"',
    'class="srcs__path"',
    'class="srcs__excerpt"',
    'class="srcs__more"',
    '@click="sourceOpen = row.citation.chunkId"'
  ]) {
    assert.ok(code.includes(anchor), `引用行缺少「${anchor}」——折叠不该动这条链路`)
  }
  // 教材原文抽屉的模态焦点契约仍挂在同一个 ref 上（`views/ux-pages-regression` 另有一条钉着）
  assert.match(code, /useFocusReturn\(drawerRef/, '原文抽屉的焦点契约不许被折叠改造碰掉')
})
