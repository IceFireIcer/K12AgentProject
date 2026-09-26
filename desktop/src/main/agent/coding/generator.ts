/**
 * 编程题**生成适配器**（D-089 的第二条路径：随包模板兜不住时的「按学生要求现出一题」）。
 *
 * ## 为什么需要单独一个文件
 *
 * `extensions/coding.ts` 原来只有三条**只读**工具（取随包模板 / 取分级提示 / 评估运行结果）——
 * 而随包模板只有第八章那三份（`prog-variable-jr` / `prog-loop-jr` / `prog-list-jr`）。
 * 学生说「给我一道关于**循环**的题，要能用外星人送快递来写」时，那条路没有任何东西可给。
 *
 * 本文件是那条注入：`runtime.ts` 把它接到 `createCodingExtension({ generate })` 上。
 *
 * ## ★ 分工：模型出**结构化的题**，Python 负责**校验与存储**
 *
 *     ① 模型产出一个 JSON 对象（题名 / 要求 / 脚手架 / 预期输出 / 三级提示 / 参照实现）
 *     ② 主进程 POST 给 Python：**服务端二次校验**（缺 TODO、提示不是三级、第 1 级带代码…一律 422）
 *     ③ 222 → 带原因重试（≤2）→ 仍不过 → 工具失败（可读中文，模型改用对话讲）
 *     ④ 过了 → 存进**该学生名下**（`generated_code_template`），回执带回 `savedId`
 *
 * ⚠️ **`solution` 只走服务端**：它进库、绝不进卡片载荷（与题库的 `answer` 同一条纪律）。
 *    本文件把整份 JSON 交给服务端，回执里的 `savedId` 才是卡片要用的东西。
 *
 * ## 无 Key 时的行为
 *
 * `complete` 为 `null` → 直接抛「出题不可用（没有 API Key）」→ 扩展把这句话变成
 * **可读的失败**（模型据此改用对话讲）—— 不发网络请求、不写盘、不白屏。
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TextCompleter } from '../safety/review.ts'

/** 生成超时（比动画长一点：一道题要把脚手架与三级提示一起写顺）。 */
const CODE_GENERATE_TIMEOUT_MS = Number(process.env.K12_CODE_GENERATE_TIMEOUT_MS ?? 45_000)

/** 一次出题请求（扩展填好交给适配器）。 */
export interface CodeExerciseRequest {
  kpId: string
  gradeLevel: string
  /** 学生的那句要求（原话只进提示词；库里只留指纹）。 */
  request: string
  /** 第几次尝试（0 起）——重试时带上一次的原因。 */
  attempt: number
  previousReason?: string
}

/** 模型产出的题（**服务端还要再校验一遍**，这里只保证是合法 JSON + 字段齐）。 */
export interface CodeExerciseDraft {
  title: string
  expectedBehavior: string
  scaffold: string
  expectedOutput: string
  hints: Array<{ level: number; hint: string }>
  solution: string
}

export interface CodeExerciseGeneratorOptions {
  /** 模型文本补全（`runtime.ts` 用 `createModelCompleter` 接上来；**无 Key 时为 `null`**）。 */
  complete: TextCompleter | null
  log?: (line: string) => void
}

/**
 * 建一个 `generate`（交给 `createCodingExtension({ generate })`）。
 *
 * ★ **无 Key 时直接抛**：扩展会把它收敛成可读失败（模型改用对话讲），不产生任何副作用。
 */
export function createCodeExerciseGenerator(
  options: CodeExerciseGeneratorOptions
): (request: CodeExerciseRequest) => Promise<CodeExerciseDraft> {
  const log = options.log ?? ((line: string) => console.warn(line))

  return async (request) => {
    const complete = options.complete
    if (!complete) {
      throw new Error('出题不可用：本机没有配置 API Key（这条是随包模板兜不住时的补充路径）')
    }
    const prompt = buildCodeExercisePrompt(request)
    const raw = await complete({ prompt, timeoutMs: CODE_GENERATE_TIMEOUT_MS })
    const draft = parseCodeExercise(raw)
    if (!draft) {
      // ⚠️ 临时诊断（本轮真机联调）：主进程的 console.warn 不进 dev 终端，原始输出落盘最直接。
      try {
        appendFileSync(
          join(tmpdir(), 'k12-code-generate-raw.txt'),
          `
===== ${new Date().toISOString()} attempt=${request.attempt} =====
${String(raw).slice(0, 4000)}
`,
          'utf8'
        )
      } catch {
        /* 诊断写不进去不影响主流程 */
      }
      // ★ 解析失败必须**留下原始输出**：模型偶尔会把多行脚手架写成字符串里的真实换行
      //   （那不是合法 JSON）。只报「不是合法 JSON」的话，下次还得再跑一遍才知道原因。
      log(`[coding] 出题解析失败，原始输出（前 600 字符）：
${String(raw).slice(0, 600)}`)
      throw new Error('生成的结果不是合法的题目 JSON（缺 title / scaffold / hints / solution）')
    }
    log(
      `[coding] 出题：知识点「${request.kpId}」第 ${request.attempt + 1} 次尝试` +
        `（脚手架 ${draft.scaffold.length} 字符 / 提示 ${draft.hints.length} 级）`
    )
    return draft
  }
}

/**
 * 出题用的 prompt。
 *
 * 五条硬性约束各自对应一条会被服务端拒收（422）或让学生做不成题的失败：
 *   1. 只能用标准库 —— 沙箱里没有第三方包，import 了就当场报错；
 *   2. `scaffold` 必须含 `TODO` —— 那是卡片的「待填」与判据（没有它就等于把答案给了学生）；
 *   3. 三级提示的第 1 级不许出现代码 —— 服务端会拒（「只指方向」）；
 *   4. `solution` 必须完整可运行 —— 它是参照实现（只留后端，用于核对）；
 *   5. 面向本学段的语言与篇幅 —— 太长学生读不完，太难打击信心。
 */
export function buildCodeExercisePrompt(request: CodeExerciseRequest): string {
  const lines = [
    '你在为一个面向 K12 学生的 AI 学习应用出一道**编程练习小题**（Python）。',
    `知识点 id：${request.kpId}`,
    `学段：${request.gradeLevel}（primary_low / primary_high / junior / senior；语言与难度要贴这一档）。`,
    `学生的要求：${request.request}`,
    '',
    '只输出**一个 JSON 对象**（不要解释、不要 Markdown 代码围栏），字段与要求：',
    '  "title"            : ≤14 字的题名（中文，学生读的）',
    '  "expectedBehavior" : 一句话说清「做对了会怎样」（中文，别写代码）',
    '  "scaffold"         : Python 脚手架，**必须含大写 TODO 标记**，≤12 行；待填的只有一两处',
    '  "expectedOutput"   : 程序正确运行后屏幕上会出现什么（逐行写出来）',
    '  "hints"            : 恰好三级 [{"level":1,…},{"level":2,…},{"level":3,…}]',
    '                       level 1 只指方向（**不许出现代码**：不要括号、等号、函数名）',
    '                       level 2 给结构性提示；level 3 贴近脚手架（仍不要整段答案）',
    '  "solution"         : 一份**完整可运行**的正确实现（学生看不到，只用于核对）',
    '',
    '硬性约束（违反会被服务端拒收）：',
    '1. 只用 Python 标准库；不要文件读写、不要网络、不要任何第三方包（沙箱里没有）。',
    '2. `scaffold` 里不许包含正确实现（待填处写 `TODO`），也不要贴出答案。',
    '3. 数据直接写在代码里或 `input()` 读入都可以，但要让学生跑一次就能看到结果。',
    '4. 中文注释短句，变量名用拼音或英文都行；不要出现教材以外的技术名词。'
  ]
  if (request.previousReason) {
    lines.push('', `上一次尝试被拒的原因（这次必须避开）：${request.previousReason}`)
  }
  lines.push('', '现在只输出那个 JSON 对象。')
  return lines.join('\n')
}

/**
 * 把模型回的那段文本解析成题目草稿（认不出返回 `null`）。
 *
 * ★★ 这里必须**比想象中宽容**（实测踩到）：真实模型回抄回来的 JSON 有三种常见偏差，
 *    每一种都会让一道本来合格的题白白失败（学生那边只看到「这次没能出成题」）：
 *      ① **字符串里写了真实换行**（脚手架是多行 Python，模型常直接把换行写进去）——
 *         JSON 规范里那是非法的，`JSON.parse` 直接抛；
 *      ② 字段名用 **snake_case**（`expected_behavior`）；
 *      ③ 前后带解释性文字、或多个 `{}` 片段 —— 贪婪匹配会把两段粘在一起。
 *    所以：先按「括号配平」取第一个完整对象（字符串状态要跟着走），再对字符串内的
 *    裸控制字符做一次转义修复，最后才 `JSON.parse`。
 *    ⚠️ **服务端仍会二次校验**（缺 TODO / 提示不是三级 / 第 1 级带代码）——
 *       这里宽容的只是「怎么把模型的话读成对象」，不是「合格线」。
 */
export function parseCodeExercise(raw: string): CodeExerciseDraft | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const candidate = extractJsonObject(raw)
  if (!candidate) return null
  let parsed: unknown = null
  try {
    parsed = JSON.parse(candidate)
  } catch {
    // ①：字符串里的裸换行/制表符 —— 转义后再试一次（只动字符串内部的字符）
    try {
      parsed = JSON.parse(escapeControlCharsInStrings(candidate))
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>

  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value : null

  const title = text(record.title)
  const expectedBehavior = text(record.expectedBehavior ?? record.expected_behavior)
  const scaffold = text(record.scaffold)
  const solution = text(record.solution)
  const expectedOutputRaw = record.expectedOutput ?? record.expected_output
  const expectedOutput = typeof expectedOutputRaw === 'string' ? expectedOutputRaw : ''
  const rawHints = Array.isArray(record.hints) ? record.hints : null
  if (!title || !expectedBehavior || !scaffold || !solution || !rawHints) return null

  const hints = rawHints
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      // ★★ 提示字段名**不要猜**（真机联调实测三次三个名字：`hint` → `text` → `content`）：
      //   `{"level":n,"hint"|"text"|"content":"…"}` 都出现过，只认其中一个 = 三连败。
      //   判据改成结构性的：**这一条里唯一的字符串值**就是提示正文（多余字段一律忽略）。
      const strings = Object.entries(item)
        .filter(([key]) => !/^level$/i.test(key))
        .map(([, value]) => value)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      return {
        level: Number(item.level ?? item.Level ?? 0),
        hint: strings[0] ?? ''
      }
    })
    .filter((item) => Number.isFinite(item.level) && item.hint.trim().length > 0)
  if (hints.length !== 3) return null

  return { title, expectedBehavior, scaffold, expectedOutput, hints, solution }
}

/**
 * 从一段可能带前后文的文本里取出**第一个完整且括号配平**的 JSON 对象。
 *
 * ★ 为什么不用 `/{[\s\S]*}/`（贪心）：模型常在 JSON 前后写一句解释、或在结尾再补一个
 *   `{...}` 例子，贪婪匹配会把它们粘成一个非法串 —— 上一版就是这么丢掉一道好题的。
 * ★ 括号计数必须**认得字符串状态**（`"…{…"` 里的花括号不算结构），否则脚手架里的
 *   `{}`（Python 字典/空块）会把配平算错。
 */
export function extractJsonObject(raw: string): string | null {
  const text = raw.replace(/```(?:json)?/gi, ' ')
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === BACKSLASH) escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

//: 控制字符用**码点**构造，不写字面量：本文件经过多轮补丁，字面量里的反斜杠很容易被
//: 中间环节吃掉一次（实测踩到），码点最稳。
const LINE_FEED = String.fromCharCode(10)
const CARRIAGE_RETURN = String.fromCharCode(13)
const TAB = String.fromCharCode(9)
const BACKSLASH = String.fromCharCode(92)
const ESCAPED_LINE_FEED = BACKSLASH + 'n'
const ESCAPED_CARRIAGE_RETURN = BACKSLASH + 'r'
const ESCAPED_TAB = BACKSLASH + 't'

/** 把**字符串字面量内部**的裸换行/制表符转义掉（模型把多行代码直接写进 JSON 时的修复）。 */
export function escapeControlCharsInStrings(source: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of source) {
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === BACKSLASH) {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      if (ch === LINE_FEED) out += ESCAPED_LINE_FEED
      else if (ch === CARRIAGE_RETURN) out += ESCAPED_CARRIAGE_RETURN
      else if (ch === TAB) out += ESCAPED_TAB
      else out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}
