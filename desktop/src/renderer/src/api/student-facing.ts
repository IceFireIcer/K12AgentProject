/**
 * 「排障文案 → 学生看得懂的一句话」的**唯一翻译处**（渲染进程一侧）。
 *
 * ★★ 为什么需要这一层（实测抓到的缺陷）：后端的失败 `detail` 是写给**排障**的 ——
 *   它正需要说清 HTTP 状态码、内部 kp_id、模板/题库在服务器上的目录，
 *   日志与开发者照它才好查。可同一句话经 IPC 原样落到 store 的 `*Error` 上、
 *   再被界面直出给一个 10 岁的学生，就变成了：
 *   ```
 *   读取失败（HTTP 404）：知识点 'prog-variable-jr' 还没有分级提示
 *   （模板文件：server/resources/code-templates/）。
 *   ```
 *   他看到的既像「软件坏了」（于是关掉页面，而不是换个知识点接着试），
 *   又暴露了不该给他看的内部结构。
 *
 * ★ 为什么不改后端文案：那句话对**排障**是有用的（开发/日志里正需要知道有哪些模板、
 *   目录在哪），而且同一个错误还被 Pi 的 Tool（`get_code_template` / `get_coding_hint`）
 *   用着。正确做法是**在渲染层按受众改写** —— 内部细节留在内层，给学生的那层说人话。
 *
 * ★ 判据用「像不像技术信息」而不是精确匹配某一句：后端文案会变（也可能换成别的
 *   404 原因），而「含 HTTP 状态码 / 服务器路径 / 引号里的 kp_id」这类特征稳定。
 *   命中就换成统一的**可读中文**，并把原文留在控制台（排查时仍要看）。
 *
 * ⚠️ 三个 store（`code.ts` / `quiz.ts` / `animation.ts`）都必须过这里 ——
 *   同一个缺陷原本就同时存在于三处，各写一份判据必然漂移（只改一处不算改好）。
 */

/** 失败发生在哪个能力上（决定翻译后那句话指向什么 —— 学生才知道下一步该做什么）。 */
export type StudentFacingTopic =
  /**
   * 代码模板（编程页的脚手架）。
   *
   * ⚠️ 这个 topic 的**兜底句由调用点给**（`stores/code.ts` 的 `studentFacingTemplateError()`）：
   *   那句话带编程页特有的下一步动作，而它被一条既有守卫（`ux-pages-regression.test.ts`）
   *   钉在 `code.ts` 里。判据仍然是这一份，不重复。
   */
  | 'template'
  /** 分级提示（编程页的「求助」）。 */
  | 'hint'
  /** 题库 / 闯关（**取题**这一类：这一关有没有题）。 */
  | 'quiz'
  /**
   * 判分（提交一题的这一次请求）。
   *
   * ★★ 为什么必须与 `quiz` 分开（2026-10-01 真机缺陷）：两者原先共用「这一关还没有题目。
   *   换一关试试…」——于是学生**明明在答第 4 题**、只是这一次判分请求失败了，
   *   屏幕却告诉他「这一关还没有题目」（用户截图报的就是这句）。
   *   取题失败与判分失败是两件事：前者该换关，后者该重试这一题。
   */
  | 'grade'
  /** 动画模板与渲染。 */
  | 'animation'
  /** 运行结果分析（`run-hint`）。 */
  | 'analyze'
  /** 连不上本地数据服务（sidecar）。 */
  | 'connection'
  /** 说不出更具体的场景时的中性兜底。 */
  | 'generic'

/** 「连不上 sidecar」那一句（主进程 `ipc/handlers.ts` 用同一句，两处口径一致）。 */
export const CONNECTION_FAILURE_TEXT =
  '连不上本地数据服务（sidecar）：它可能正在重启或已经不可用。请稍等几秒后重试。'

/**
 * 各场景的兜底句（**可读中文 + 下一步动作**）。
 *
 * ★ 「保留可操作的信息」是硬要求：翻掉的是 HTTP 状态码与服务器路径，
 *   不是「这个知识点还没有预置内容」这件事本身 —— 学生要靠它决定
 *   「换个知识点」还是「等一会儿重试」。
 * ★ `template`（代码模板）**不在这里**：那句话带编程页特有的下一步
 *   （「换一个知识点试试，或者先让智团团用文字讲讲」），由
 *   `stores/code.ts` 的 `studentFacingTemplateError()` 给 —— 一处一句，不两处都写。
 */
const TOPIC_FALLBACK: Record<Exclude<StudentFacingTopic, 'template'>, string> = {
  hint: '这道题还没有分级提示。先按现在的思路自己试一下，或者回对话里让智团团讲讲思路。',
  quiz: '这一关还没有题目。换一关试试，或者先让智团团讲讲这个知识点。',
  // ★ 判分失败：**不**说「这关没题」（那是取题的句子，见上面 topic 的说明）。
  grade: '这一题没能判分。再点一次「提交这题」试试；要是一直不行，先做下一题，或者回对话里问问智团团。',
  animation: '这个知识点还没有配套的动画。换个知识点试试，或者让智团团用文字讲讲。',
  analyze: '这次的运行结果暂时没能分析出来。上面的运行输出是真的，不受影响，稍后再试一次。',
  connection: CONNECTION_FAILURE_TEXT,
  generic: '这一步暂时没走通，稍等一会儿再试，或者换一个知识点。'
}

/** 翻译选项：只说清「这是哪个能力上的失败」。 */
export interface StudentFacingOptions {
  topic?: StudentFacingTopic
  /** 直接指定兜底句（比 `topic` 更具体时用；仍会走同一套判据）。 */
  fallback?: string
}

function fallbackFor(options: StudentFacingOptions): string {
  if (options.fallback !== undefined) return options.fallback
  const topic = options.topic ?? 'generic'
  // `template` 的句子由调用点给（见 TOPIC_FALLBACK 的说明），漏传时退到中性兜底
  if (topic === 'template') return TOPIC_FALLBACK.generic
  return TOPIC_FALLBACK[topic]
}

/**
 * 这段文本像不像「写给排障的技术信息」。
 *
 * 四类特征（都是**稳定**的，不随文案改版消失）：
 *   ① HTTP 状态码（`HTTP 404` / `HTTP 503`）；
 *   ② 服务器文件路径（`server/resources/…`、`resources/quizbank/`、`E:\…`）；
 *   ③ 接口地址（`/api/…`）；
 *   ④ 内部标识（引号里的 kp_id 形态 `'prog-variable-jr'`、裸 `kp_id`、`traceback`）。
 */
export function looksLikeTroubleshooting(text: string): boolean {
  return /HTTP\s*\d{3}|server[\\/]|resources[\\/]|\/api\/|[A-Za-z]:[\\/]|'[a-z][a-z0-9]*-[a-z][a-z0-9-]*'|\bkp_id\b|traceback/i.test(
    text
  )
}

/**
 * 把一句**可能面向排障**的文案翻成学生看得懂的话。
 *
 * ★ 本来就可读的中文（例如「渲染失败：没有匹配的模板」「本地数据服务响应超时」）
 *   原样返回 —— 判据是「像不像技术信息」，不是「一定要改写」。
 * ★ 空串 / 非字符串（`String(undefined)` 这类产物）→ 兜底句，**绝不把 `undefined` 摆上屏**。
 */
export function toStudentFacingMessage(raw: unknown, options: StudentFacingOptions = {}): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return fallbackFor(options)
  if (!looksLikeTroubleshooting(text)) return text
  // 原文只进控制台（老师/开发者排障要看），界面上不出现
  console.warn('[student-facing] 失败原因（原始文案，仅排查用）：', text)
  return fallbackFor(options)
}

/**
 * 异常 → 学生看得懂的一句话（**连接层失败必须变成中文**）。
 *
 * ★★ 为什么必须单独判「连不上」：`fetch` 在连接被拒时抛的是
 *   `TypeError: fetch failed`（真正的原因 `ECONNREFUSED` 在 `error.cause.code` 里）——
 *   直接 `return error.message` 就是把纯英文递给用户。而这条**恰恰是最常发生的一种**：
 *   sidecar 崩溃自愈的那 500ms 窗口里，任何一个请求都会命中它。
 *   口径与主进程 `ipc/handlers.ts` 的同名实现一致（同类回执不该有两种说法）。
 */
export function describeClientError(error: unknown, options: StudentFacingOptions = {}): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时（本地数据服务没有在超时时间内响应）。'
    if (error.name === 'AbortError') return '请求被取消。'
    if (error.message.includes('sidecar 尚未就绪')) {
      return '本地数据服务（sidecar）尚未就绪：请等界面上的状态变成「已就绪」后重试。'
    }
    if (looksLikeConnectionFailure(error)) return CONNECTION_FAILURE_TEXT
    return toStudentFacingMessage(error.message, options)
  }
  return toStudentFacingMessage(error, options)
}

/**
 * 「连不上」的判据（`fetch failed` 的英文原文 + Node 的 errno 形态）。
 *
 * 为什么要连 `cause` 一起看：Node 的 `fetch` 在连接被拒时抛的 `TypeError` 的 message
 * **只有** `fetch failed`，真正的原因（`ECONNREFUSED`）在 `error.cause.code` 里 ——
 * 只看 message 会漏掉最典型的那一种（与主进程同名实现同一口径）。
 */
export function looksLikeConnectionFailure(error: Error): boolean {
  const parts = [error.message]
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) parts.push(cause.message)
  else if (typeof cause === 'string') parts.push(cause)
  const code = (cause as { code?: unknown } | undefined)?.code
  if (typeof code === 'string') parts.push(code)
  const text = parts.join(' ').toLowerCase()
  return (
    text.includes('fetch failed') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('enotfound') ||
    text.includes('econnaborted') ||
    text.includes('socket hang up') ||
    text.includes('connection error')
  )
}
