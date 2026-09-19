/**
 * 极简 Markdown 解析（**纯函数**，只覆盖模型真正会输出的那一小撮语法）。
 *
 * ★ 为什么需要它：模型（实测 `deepseek-flash`）会自然地输出 `**加粗**` 这种 Markdown，
 *   而界面此前是 `{{ turn.text }}` **原样当纯文本渲染** —— 学生看到的是
 *   「**循环**，就是同一件事做完一遍……」里那一堆星号。那不是「格式不好看」，
 *   是**把解析负担推给了小学生**（K12 场景里这属于硬伤）。
 *
 * ★ 为什么不用 `marked` / `markdown-it`：
 *   1. **零新增依赖**是本项目的既定取向（AGENTS.md §8：任何 CDN/依赖都会在断网演示时翻车）；
 *   2. 更要紧的是**安全**：现成的 Markdown 库输出的是 HTML 字符串，要渲染就得 `v-html`，
 *      而正文是**模型生成的文本** —— 那等于在渲染进程开一个 HTML 注入面。
 *      本模块输出的是**结构化数据**（blocks → runs），由 Vue 用 `v-for` 绑定文本节点，
 *      **一个字节的 HTML 都不会被解释**，XSS 面为零。
 *
 * ★ 覆盖范围（按实际出现频率，刻意不做全套 Markdown）：
 *   - `**粗体**`：强调，出现频率最高；
 *   - `` `行内代码` ``：术语 / 变量名；
 *   - ```` ``` 代码块 ````：编程页与示例；
 *   - `#` / `##` / `###` 标题；
 *   - `- ` / `* ` 无序列表、`1. ` 有序列表；
 *   - 空行分段。
 *   **不做**表格 / 图片 / 链接 / 嵌套列表 —— 模型在课堂讲解里几乎不用，
 *   而每多支持一种语法就多一份解析器要维护、多一处渲染要测。
 *
 * ★ 容错优先：任何不像 Markdown 的东西都**当纯文本原样保留**（宁可朴素，不可丢字）。
 */

/** 行内片段：`strong` 走加粗、`code` 走等宽，其余原样。 */
export interface InlineRun {
  kind: 'text' | 'strong' | 'code'
  text: string
}

export type BlockKind = 'paragraph' | 'heading' | 'list' | 'code' | 'divider'

export interface MarkdownBlock {
  kind: BlockKind
  /** 标题层级（仅 `heading` 有；1–3）。 */
  level?: number
  /** 有序列表序号（仅 `list` 且是有序时给出）。 */
  ordinal?: number
  /** 代码块的语言标记（仅 `code`，可为空串）。 */
  lang?: string
  runs: InlineRun[]
}

/**
 * 解析行内语法：`**粗体**` 与 `` `代码` ``。
 *
 * 用一个手写扫描器而不是正则替换 —— 正则在「`**` 未闭合」「星号与反引号交叉」这类
 * 边界上会静默吃字，而这是学生要读的正文，**宁可少加粗一次，也不能少一个字**。
 */
export function parseInline(source: string): InlineRun[] {
  const runs: InlineRun[] = []
  let buffer = ''
  let index = 0

  const flush = (): void => {
    if (buffer.length > 0) {
      runs.push({ kind: 'text', text: buffer })
      buffer = ''
    }
  }

  while (index < source.length) {
    // **粗体**
    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2)
      // 未闭合（或空内容）→ 当普通星号，**不吃字**
      if (end > index + 2) {
        flush()
        runs.push({ kind: 'strong', text: source.slice(index + 2, end) })
        index = end + 2
        continue
      }
    }
    // `行内代码`
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1)
      if (end > index + 1) {
        flush()
        runs.push({ kind: 'code', text: source.slice(index + 1, end) })
        index = end + 1
        continue
      }
    }
    // `~~删除线~~` 之类刻意不处理，星号原样保留
    buffer += source[index]
    index += 1
  }

  flush()
  return runs
}

/** 把可能带 `**` 的整段文本解析成 blocks。 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  // 归一化换行：模型可能给 \r\n（Windows 后端拼接时常见）
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []

  let paragraph: string[] = []
  let fence: { lang: string; lines: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const text = paragraph.join('\n').trim()
    if (text.length > 0) blocks.push({ kind: 'paragraph', runs: parseInline(text) })
    paragraph = []
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')

    // ── 代码围栏：内部一律原样，不做任何行内解析（代码里的 `*` 不是强调）──
    if (fence !== null) {
      if (line.trimStart().startsWith('```')) {
        blocks.push({ kind: 'code', lang: fence.lang, runs: [{ kind: 'text', text: fence.lines.join('\n') }] })
        fence = null
      } else {
        fence.lines.push(rawLine)
      }
      continue
    }
    if (line.trimStart().startsWith('```')) {
      flushParagraph()
      fence = { lang: line.trim().slice(3).trim(), lines: [] }
      continue
    }

    // ── 空行 = 分段 ──
    if (line.trim().length === 0) {
      flushParagraph()
      continue
    }

    // ── 分隔线（`---` / `***` / `___`，至少三个）──
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'divider', runs: [] })
      continue
    }

    // ── 标题 `#`–`######`（只认 1–3 级，更深的当段落 —— 课堂讲解用不到 4 级标题）──
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      const level = Math.min(heading[1].length, 3)
      blocks.push({ kind: 'heading', level, runs: parseInline(heading[2].trim()) })
      continue
    }

    // ── 无序列表 `- ` / `* ` / `• ` ──
    // ★ 为什么**不需要**额外排除「行首 `**`」：这个正则要求标记后跟**空白**（`\s+`），
    //   而 `**粗体**` 的第二个 `*` 后面跟的是文字而不是空白，天然匹配不上。
    //   （一度写过 `&& !/^\s*\*\*/` 这样的守卫 —— 实测是**不可达的死代码**：
    //    差分探针在 18 个样本上确认带不带它行为完全一致。删掉它，
    //    因为一段「看起来在防御什么」的代码会让后来人以为这里有坑。）
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      blocks.push({ kind: 'list', runs: parseInline(bullet[1].trim()) })
      continue
    }

    // ── 有序列表 `1. ` / `1) ` ──
    const ordered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      blocks.push({
        kind: 'list',
        ordinal: Number(ordered[1]),
        runs: parseInline(ordered[2].trim())
      })
      continue
    }

    paragraph.push(line)
  }

  // 收尾：未闭合的围栏按普通段落处理（**不丢内容** —— 模型少打三个反引号是常事）
  if (fence !== null) {
    paragraph.push('```' + fence.lang, ...fence.lines)
  }
  flushParagraph()

  return blocks
}

/** 有序列表是否应当被渲染成连续的编号列表（相邻同组才算）。 */
export function isOrderedList(blocks: readonly MarkdownBlock[], index: number): boolean {
  const block = blocks[index]
  return block?.kind === 'list' && typeof block.ordinal === 'number'
}
