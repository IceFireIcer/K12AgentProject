/**
 * 学习计划 / 练习检验的**纯逻辑**：把「开始学习」这个动作编码成一对**成对**的文本，
 * 并在回看历史时把发给模型的原文翻译回学生语言。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么学生气泡与发给模型的两段必须分开（本文件存在的第一理由）
 * ══════════════════════════════════════════════════════════════════════════
 * 两条 wire 里都写着**写给模型的指令**：
 *   · 学习计划那条规定了输出结构（是什么 / 解决什么问题 → 3~5 步 → 自测小目标）
 *     与「讲完提醒我可以用按钮检验」；
 *   · 练习检验那条规定了「用变式生成现场出 3 道新题、不要直接给教材原题、
 *     不要口头出题、题面别直接给答案」—— 2026-09-30 真机实测发现模型默认走教材题库
 *     （`generate_quiz` 的自述就写着「题目优先取自本地题库」），所以这条 wire 从
 *     「出 3 道题」改成了**点名变式生成**（见 {@link buildQuizAskMessage}）。
 * 这些是**界面的底牌**：学生一旦在自己的气泡里读到「不要口头出题」，
 * 就知道还有一条不走工具的捷径，那条规定也就白写了。所以每条 wire 都配一个
 * `xxxDisplayText()`，两段由 `stores/chat.ts` 的 `send(显示文本, wire 文本)` 分别承载
 * —— 与 `cards/coding.ts` 的 `buildHintRequestMessage` / `hintRequestDisplayText`
 * 是**同一条先例**，改动时两边必须成对改。
 *
 * ★★ 只做实时路径是不够的（本仓有前科）：Pi 的会话 JSONL 里存的是 wire **原文**
 *    （那是对的 —— 模型续聊要看到完整上下文），但学生重启应用回看自己的气泡时，
 *    会**第二次**读到那段写给模型的指令：同一个缺陷换条路回来。所以渲染历史前
 *    还要再过一遍 {@link planUserTextDisplay}。只改显示，磁盘上的原文一个字不动。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么「认不出一律原样返回」（保守口径）
 * ══════════════════════════════════════════════════════════════════════════
 * 翻译只认本模块自己生成的两条前缀，且必须能从正文里读出 `kp_id=`（缺了就是残文，
 * 不猜）。其余文本 —— 包括学生自己手打的、看起来像同款的话 —— **一个字都不改**：
 * 宁可少翻译一句，也绝不改写学生自己打的字。
 *
 * 每条 wire 都带 `kp_id=` 的原因：知识点名可能取不到（那就不显示），也可能是重名；
 * 只有内部主键能把请求钉到确切的知识点上。它只进 wire，不进气泡。
 * 名字取不到时「知识点：」整行省略 —— 不留一个空标签让模型去猜。
 *
 * 结构对齐 `cards/coding.ts`：buildXxxRequestMessage（wire）+ xxxDisplayText（学生面）
 * + xxxUserTextDisplay（回看翻译），三者由源码级守卫钉在一起。
 */

/** 学习计划请求的固定开头（也是回看时认领它的依据）。 */
export const PLAN_REQUEST_PREFIX = '【学习计划】'
/** 练习检验请求的固定开头（同上）。 */
export const QUIZ_ASK_PREFIX = '【练习检验】'

/**
 * 「学习计划」时**学生气泡里**显示的那一句（与 {@link buildPlanRequestMessage} 成对）。
 *
 * ★ 刻意不带内部主键：那串东西学生读它没有任何意义，和「亮底牌」是同一类问题。
 * ★ 名字取不到时用通用说法，**不回落成主键**，也不留「我想学「」，…」这种空书名号。
 */
export function planRequestDisplayText(kpName: string): string {
  const name = normalizeKpName(kpName)
  return name === ''
    ? '我想学一个知识点，帮我安排一下学习计划。'
    : `我想学「${name}」，帮我安排一下学习计划。`
}

/**
 * 点「现在考考我」时**学生气泡里**显示的那一句（与 {@link buildQuizAskMessage} 成对）。
 *
 * ★ 同样不提任何工具名与内部主键：气泡里是学生的话，不是界面的操作说明。
 * 「刚才那个知识点」在只有一轮计划对话的上下文里不会指错（巩固条只在本轮计划答完后出现）。
 */
export function quizAskDisplayText(kpName: string): string {
  const name = normalizeKpName(kpName)
  return name === '' ? '就刚才那个知识点考考我。' : `就「${name}」考考我。`
}

/**
 * 「这几道题是谁出的」——**对话侧的来源标注**用这一句。
 *
 * ★★ 基础文案是**三个落点共用的一条文案，改一处要三处一起改**
 *   （少改一处，同一批题就会在界面上出现两种叫法，学生以为是两批）：
 *   · `cards/QuizCard.vue` 的 `sourceLabel`（对话内卡片头）；
 *   · `views/Quiz.vue` 的 `sourceLabel`（个性化学习页）；
 *   · 本函数（紧接卡片的那条巩固条）。
 *   三处**一字不差**的两个值是：`'教材配套题'`（题库）与 `'智团团出的题'`（生成）。
 * ★ 对话侧多一个**带数量的变体**「智团团刚出的 N 道题」：这里紧跟着这一批题，
 *   说得出数量是学生要的信息；数量取不到时回落成上面那条基础文案，不编数字。
 * ★ 来源认不出（老载荷 / 认不出结构）→ 返回空串，调用方整行不渲染 —— 不编一个来源。
 */
export function quizSourceLabel(source: string | null, count: number): string {
  if (source === 'bank') return '教材配套题'
  if (source !== 'generated') return ''
  const total = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
  return total > 0 ? `智团团刚出的 ${total} 道题` : '智团团出的题'
}

/**
 * ★★ **回看历史**时把「发给模型的原文」还原成学生语言（其余文本原样返回）。
 *
 * 判据有两道，缺一不可：① 以本模块生成的前缀开头；② 能解析出内部主键
 * （{@link parsePlanRequest} 为 null 就不认）。第二条把「学生手打了同款前缀但没带主键」
 * 挡在门外 —— 那种文本里没有我们编码进去的字段，翻译它等于读心。
 * 认不出**一律原样返回**：宁可显示原文，也绝不改写学生自己打的字。
 * 只改显示，JSONL 原文不动（与 `cards/coding.ts` 的 codingUserTextDisplay 同一口径）。
 */
export function planUserTextDisplay(text: string): string {
  const prefix = matchedPrefix(text)
  if (prefix === null) return text
  const parsed = parsePlanRequest(text)
  if (parsed === null) return text
  return prefix === PLAN_REQUEST_PREFIX
    ? planRequestDisplayText(parsed.kpName)
    : quizAskDisplayText(parsed.kpName)
}

/**
 * 「开始学习」时**发给主 Agent** 的那条消息（= wire 文本）。
 *
 * ★★ 括号里那句结构要求是**写给模型的指令**，不是给学生看的：学生面走
 *    {@link planRequestDisplayText}，两者由 `stores/chat.ts` 的 send 分开承载。
 * ★ 3~5 步与「别一次塞太多」是**粒度约束**：计划天然会长，不写死条数模型就会铺满一屏，
 *   而学生要的是「先做什么」。
 */
export function buildPlanRequestMessage(kpId: string, kpName: string): string {
  return `${PLAN_REQUEST_PREFIX}kp_id=${kpId}\n${kpNameLine(kpName)}请为这个知识点安排一份学习计划：先用两三句话讲清它是什么、解决什么问题，再按顺序给出 3~5 个学习步骤（每一步写清「看什么 / 练什么」），最后给一个能自测的小目标。贴合我的学段，别一次塞太多。讲完提醒我可以用下方的按钮检验。`
}

/**
 * 「现在考考我」时**发给主 Agent** 的那条消息（= wire 文本；同一条纪律：
 * 这里写给模型的指令，学生面走 {@link quizAskDisplayText}）。
 *
 * ★★ 2026-09-30 真机实测（A5）：学生点了「现在考考我」，模型走了**教材题库**，
 *   学生库里生成题 0 行 —— 而用户要的是「AI 现场生成、存本地、可复用」。
 *   所以这条 wire 从「请用练习工具出 3 道题」改成**点名变式生成**：
 *   `generate_variants` 现场出题、登记答案，学生做完还能在个性化学习里再做一遍。
 *   ⚠️ 为什么点名工具而不是只说「变式题能力」：`generate_quiz` 的自述写着
 *   「题目优先取自本地题库」，只说能力时模型最省事的选择正是它（实测就是这么发生的）；
 *   这与 `cards/coding.ts` 的求助 wire 点名 `get_coding_hint` 是同一条先例。
 * ★ 两条旧约束**一个字都没删**（它们是本模块的既有承诺）：「不要口头出题」
 *   （题要落到卡片上，不然学生嘴上答完没人判分）、「不要在题面里直接给答案」
 *   （否则等于把作业连答案发下去）。
 * ★ 另外两条是这次新加的：「不要直接给教材原题」（否则又退回题库那条路）、
 *   「出完不要念题干」（题干已经在卡片上，念一遍是重复）。
 */
export function buildQuizAskMessage(kpId: string, kpName: string): string {
  return `${QUIZ_ASK_PREFIX}kp_id=${kpId}\n${kpNameLine(kpName)}请用变式生成（generate_variants）就这个知识点现场出 3 道新题（换数字、换问法，可以有一道开放题），不要直接给教材原题，除非我明确说要教材题。不要口头出题，不要在题面里直接给答案，出完也不要念题干。`
}

/**
 * 从 wire 原文里认领「这一轮是给哪个知识点做的计划 / 检验」。
 *
 * 判据：① 以两条前缀之一开头（trimStart 之后，容忍历史文本前面的空白）；
 * ② 正文里有一行 `kp_id=` 且值非空。缺任何一条 → `null`（调用方据此放弃认领，
 * 不要拿着残文去猜一个可能错的主键）。名字读不到给空串，由显示层走通用说法。
 *
 * 两条前缀共用同一个解析：它们编码的是同一对字段，分别识别前缀是**显示层**的事
 * （{@link planUserTextDisplay}），这里不重复分支。
 */
export function parsePlanRequest(text: string): { kpId: string; kpName: string } | null {
  if (typeof text !== 'string') return null
  const prefix = matchedPrefix(text)
  if (prefix === null) return null
  const body = text.trimStart().slice(prefix.length)
  const kpId = readKpId(body)
  if (kpId === '') return null
  return { kpId, kpName: readKpName(body) }
}

/** 字段名与标签的**唯一**写法（解析侧不许再写第二份字面量，否则两边会漂）。 */
const KP_ID_FIELD = 'kp_id='
const KP_NAME_LABEL = '知识点：'

/** 名字归一：空串 / 只有空白都当成「取不到」，走通用显示文本。 */
function normalizeKpName(kpName: string): string {
  return typeof kpName === 'string' ? kpName.trim() : ''
}

/** wire 里的名字行（取不到就整行省略，不留空标签）。 */
function kpNameLine(kpName: string): string {
  const name = normalizeKpName(kpName)
  return name === '' ? '' : `${KP_NAME_LABEL}${name}\n`
}

/** 命中的前缀（认不出返回 null）。两条前缀互不为前缀，判定顺序不影响结果。 */
function matchedPrefix(text: string): string | null {
  const head = text.trimStart()
  if (head.startsWith(PLAN_REQUEST_PREFIX)) return PLAN_REQUEST_PREFIX
  if (head.startsWith(QUIZ_ASK_PREFIX)) return QUIZ_ASK_PREFIX
  return null
}

/** 读 `kp_id=` 那一行的值（只认行首，避免正文里偶然出现的同名片段被当字段）。 */
function readKpId(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(KP_ID_FIELD)) return line.slice(KP_ID_FIELD.length).trim()
  }
  return ''
}

/** 读「知识点：」那一行的值（认不出给空串 —— 名字是可选信息，不值得因此丢掉整个请求）。 */
function readKpName(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith(KP_NAME_LABEL)) continue
    return line.slice(KP_NAME_LABEL.length).trim()
  }
  return ''
}
