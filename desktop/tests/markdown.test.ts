/**
 * 极简 Markdown 解析的回归（`src/renderer/src/markdown.ts`）。
 *
 * 为什么值得单测：这是**学生要读的正文**的解析器，两类错误都很贵 ——
 *   ① **吃字**：解析器把不该吃的字符吃掉（学生读到的句子少一截）；
 *   ② **漏解析**：星号原样露出来（学生读到 `**循环**`）。
 * 所以下面每条断言都在正反两个方向上验，并且**用实测的真实模型输出**做样本。
 *
 * ★ 真实样本从哪来：给临时测试 Key 接 DeepSeek 跑一轮真对话，模型就是这样回的 ——
 *   正文里既有 `**循环**，就是……` 这样的加粗，也有「换行 = 分段」的排版习惯。
 *   解析器必须对**这一份真样本**给出「无星号 + 不丢字」的结果。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseInline, parseMarkdown } from '../src/renderer/src/markdown.ts'

const textOf = (runs: readonly { kind: string; text: string }[]): string =>
  runs.map((run) => run.text).join('')

/** 把 blocks 拍平回纯文本：用来断言「一个字都没丢」。
 *
 * ★ 块之间用 `\n\n` 接（块 = 段落 = 空行切出来的），这样拍平后与**源文本**可比。
 *   一开始用 `\n` 接是错的：那会把「空行分段」这个信息抹掉，于是源文本里的空行
 *   在拍平结果里就"消失"了，看起来像丢内容，其实只是拍平函数自己丢了信息。 */
const flatten = (blocks: readonly ReturnType<typeof parseMarkdown>[number][]): string =>
  blocks
    .map((block) => (block.kind === 'code' ? `\`\`\`${block.runs[0]?.text ?? ''}\`\`\`` : textOf(block.runs)))
    .join('\n\n')

/** 只留下**内容字**（去掉 Markdown 标记字符）—— 判「有没有丢字」时用。 */
const letters = (source: string): string => source.replace(/[*`#]/g, '')

/* ------------------------------------------------------------------ *
 * 行内解析
 * ------------------------------------------------------------------ */

test('parseInline：加粗被识别，星号不进文本', () => {
  const runs = parseInline('**循环**，就是同一件事做完一遍')
  assert.deepEqual(runs, [
    { kind: 'strong', text: '循环' },
    { kind: 'text', text: '，就是同一件事做完一遍' }
  ])
})

test('parseInline：行内代码被识别', () => {
  const runs = parseInline('用 `for` 循环')
  assert.deepEqual(runs, [
    { kind: 'text', text: '用 ' },
    { kind: 'code', text: 'for' },
    { kind: 'text', text: ' 循环' }
  ])
})

test('★ parseInline：不丢字（正反样本都要逐个内容字对得上）', () => {
  const samples = [
    '**循环**，就是同一件事做完一遍，回到开头，再做一遍。',
    '**注意看**：那一圈是怎么转回去的。**',
    '先 `data` 再 `train`，最后 `predict`。',
    '一个星号 * 不该被吃掉',
    '****空加粗****',
    '`未闭合的反引号',
    '混合：**粗** 与 `码` 与普通字'
  ]
  for (const sample of samples) {
    // ★ 判据用「去掉所有标记字符后是否逐字相同」，而不是「去掉 `**` 后相同」：
    //   未闭合的标记是**故意保留**的（见下一条），所以标记字符的个数本来就会不一样。
    //   真正不能变的是**内容** —— 学生读到的字一个都不能少。
    assert.equal(letters(textOf(parseInline(sample))), letters(sample), `内容对不上：${sample}`)
  }
})

test('★ parseInline：未闭合的标记保留原样（含末尾的孤立 `**`）', () => {
  // 模型逐字吐时 `**循` 这种中间态必然出现。若在此时吞掉星号，
  // 学生看到的是字在闪烁 / 消失 —— 比偶尔多俩星号糟得多。
  const runs = parseInline('这是**未闭合的加粗')
  assert.equal(textOf(runs), '这是**未闭合的加粗')
  assert.equal(runs.filter((run) => run.kind === 'strong').length, 0)

  // 末尾孤立的 `**`（整段回答结束时模型偶尔会多打）同样保留，不吞
  const trailing = parseInline('一句话。**')
  assert.equal(textOf(trailing), '一句话。**')
})

/* ------------------------------------------------------------------ *
 * 块级解析
 * ------------------------------------------------------------------ */

test('空行分段：两段各成一个 paragraph', () => {
  const blocks = parseMarkdown('第一段\n还在第一段\n\n第二段')
  assert.equal(blocks.length, 2)
  assert.ok(blocks.every((block) => block.kind === 'paragraph'))
  assert.equal(textOf(blocks[0].runs), '第一段\n还在第一段')
  assert.equal(textOf(blocks[1].runs), '第二段')
})

test('标题：`##` 认成 level 2，且更深的不超过 3', () => {
  const blocks = parseMarkdown('# 一\n\n### 三\n\n##### 五')
  assert.deepEqual(
    blocks.map((block) => block.level),
    [1, 3, 3]
  )
  assert.ok(blocks.every((block) => block.kind === 'heading'))
})

test('列表：无序与有序分开，有序保留序号', () => {
  const blocks = parseMarkdown('- 第一项\n- 第二项\n\n1. 甲\n2. 乙')
  const lists = blocks.filter((block) => block.kind === 'list')
  assert.equal(lists.length, 4)
  assert.equal(lists[0].ordinal, undefined)
  assert.equal(lists[1].ordinal, undefined)
  assert.equal(lists[2].ordinal, 1)
  assert.equal(lists[3].ordinal, 2)
})

test('★ 行首 `**粗体**` 不会被误判成无序列表（真实原因是 `\\s+` 要求标记后跟空白）', () => {
  // ★ 这条测试的存在理由是**防止一个具体的回退**：源码里曾有过
  //   `if (bullet && !/^\s*\*\*/.test(line))` 这样的守卫去挡这个 case，
  //   但差分探针证明它是**不可达的死代码**（`\s+` 已经排除了 `**`），于是删掉了。
  //   删掉之后「`**粗体**` 会不会变成列表」就只由正则本身保证 —— 所以这里把它钉住。
  // 段落类：这些都不该变成列表
  for (const line of ['**循环**是这样', '**粗**', '**', '**粗** 后面还有字', '** x']) {
    const blocks = parseMarkdown(line)
    assert.equal(blocks.length, 1, `「${line}」不该被拆成多块`)
    assert.equal(blocks[0].kind, 'paragraph', `「${line}」必须是段落，不能是列表`)
    // 判据与别处一致：**内容字**一个不少（未闭合的标记按设计保留，见 parseInline 的用例）
    assert.equal(letters(textOf(blocks[0].runs)), letters(line), `「${line}」的文本内容出错`)
  }

  // ★ 唯一的例外：`****` 是**分隔线**而不是段落 —— 这不是漏判，是按 Markdown 的规矩来：
  //   `***` / `---` / `___` 三个以上同类字符就是水平分隔线（CommonMark 的 thematic break）。
  //   模型偶尔用它分段，渲染成一条细线比让学生看见四个星号好。
  const divider = parseMarkdown('****')
  assert.equal(divider.length, 1)
  assert.equal(divider[0].kind, 'divider')

  // 对照：真的列表项还是要认出来（不能为了防误判把列表功能一起关掉）
  for (const line of ['- 项', '* 项', '• 项', '  * 缩进项', '* **加粗的项**']) {
    const blocks = parseMarkdown(line)
    assert.equal(blocks[0]?.kind, 'list', `「${line}」应当是列表项`)
  }
})

test('代码围栏：内部原样，星号不当强调', () => {
  const blocks = parseMarkdown('说明：\n\n```python\nfor i in range(3):  # **不是加粗**\n    print(i)\n```\n\n完了')
  const code = blocks.find((block) => block.kind === 'code')
  assert.ok(code, '必须认出代码块')
  assert.equal(code.lang, 'python')
  assert.equal(code.runs[0].text, 'for i in range(3):  # **不是加粗**\n    print(i)')
  assert.equal(blocks.filter((block) => block.kind === 'paragraph').length, 2)
})

test('★ 未闭合的代码围栏不丢内容（模型少打三个反引号是常事）', () => {
  const blocks = parseMarkdown('看这段：\n\n```\nprint(1)\nprint(2)')
  const joined = flatten(blocks)
  assert.match(joined, /print\(1\)/, '未闭合围栏里的内容不能消失')
  assert.match(joined, /print\(2\)/)
})

test('分隔线被识别，且不与列表混淆', () => {
  const blocks = parseMarkdown('上\n\n---\n\n下')
  assert.equal(blocks.filter((block) => block.kind === 'divider').length, 1)
  // `- 项` 是列表，不是分隔线
  const withList = parseMarkdown('- 项')
  assert.equal(withList[0].kind, 'list')
})

test('CRLF 与行尾空格：归一化后分段正确（后端拼接可能给 \\r\\n）', () => {
  const blocks = parseMarkdown('第一段\r\n\r\n第二段  \r\n')
  assert.equal(blocks.length, 2)
  assert.equal(textOf(blocks[1].runs), '第二段')
})

/* ------------------------------------------------------------------ *
 * 真实模型输出（端到端样本）
 * ------------------------------------------------------------------ */

test('★★ 真实模型输出：无星号残留，且一个字都没丢', () => {
  // 这段是从 DeepSeek deepseek-flash 的真实回答里抄下来的形态（含它的排版习惯：
  // 「一句话一行、空行分段、关键句用 `**` 包住」）
  const real = [
    '**循环**，就是同一件事做完一遍，回到开头，再做一遍。',
    '',
    '生活里到处都是循环。',
    '比如跳绳数数：跳一下、数一下，再跳一下、再数一下。',
    '你数到 100，就是这一小圈转了 100 遍。',
    '',
    '**注意看**：那一圈是怎么转回去、又从同一个地方重新开始的。',
    '',
    '还有一个小秘密：循环必须有一个「够了就停」的条件。',
    '这一点先告诉你：用电脑亲手写出循环，是初中用 Python 才学的。',
    '现在你只要抓住一句话就够了 —— **循环就是让重复的事，交给机器一遍遍做。**',
    '',
    '想一想：你每天刷牙的时候，哪几个动作在循环？'
  ].join('\n')

  const blocks = parseMarkdown(real)

  // ① 星号不能出现在**渲染结果**里（这正是学生此前看到「**」的直接原因）
  const rendered = flatten(blocks)
  assert.doesNotMatch(rendered, /\*\*/, '渲染结果里不该再有 ** —— 那正是这个解析器要消灭的东西')

  // ② 一个字都不能丢（判据见 `letters` 的说明）
  assert.equal(letters(rendered), letters(real))

  // ③ 结构：空行切块 → 5 段（那 3 行「连着的句子」属于同一段）
  assert.equal(blocks.length, 5)
  assert.ok(blocks.every((block) => block.kind === 'paragraph'))

  // ④ 加粗**确实生效**（不是「把所有标记都删了」这种假修复）
  assert.equal(blocks[0].runs[0].kind, 'strong')
  assert.equal(blocks[0].runs[0].text, '循环')
  assert.equal(blocks[2].runs[0].kind, 'strong')
  assert.equal(blocks[2].runs[0].text, '注意看')
  // 最后一段里的整句加粗（它在第 4 块 = 那三条连着的句子里，不在最后的「想一想」）
  const longBlock = blocks[3]
  const lastStrong = longBlock.runs.find((run) => run.kind === 'strong')
  assert.ok(lastStrong, '整句加粗必须被识别')
  assert.match(lastStrong.text, /循环就是让重复的事/)

  // ⑤ 换了行但**没**空行的那三行属于同一段（不能被拆开）
  assert.equal(textOf(longBlock.runs).split('\n').length, 3)
})

test('空输入与纯空白：返回空数组而不是抛异常', () => {
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('   \n\n  \n'), [])
})
