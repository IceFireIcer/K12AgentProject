/**
 * 演示沙箱（预置数据）的**跨边界类型与常量**——主进程与渲染进程共用。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它是什么
 * ══════════════════════════════════════════════════════════════════════════
 * 演示驾驶舱顶栏那颗按钮把应用切进一个**内存态沙箱**：学生态（画像 / 掌握度 /
 * 闯关进度 / 学习报告 / 会话 / 动画库 / 模型配置显示态）全部换成预置值，
 * 而**内容态**（题库 / 代码模板 / 动画模板 / 知识点名 / 知识库统计）照旧走真实资产。
 *
 * ★★ 这条分界是判据，不是风格：内容态一旦被假掉，演示里就会出现
 *   「假题目配假答案」这种一戳就破的东西；而学生态不预置，页面就是空的。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 本文件被主进程与渲染进程**同时** import：不许出现任何 Node 内建模块，
 *    也不许 import 主进程模块（与 `shared/diagnostics.ts` 同一条纪律）。
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { DemoSafetyRules } from './demo-safety-rules'
import type { TurnDiagnostics } from './diagnostics'
import type { Citation, CitationDetail, Degraded, PayloadKind } from './ipc-events'

/**
 * 沙箱开关的两态。
 *
 * ★ 只有两态（不是三态）：`inactive` = 一切照旧，`seeded` = 学生态被预置。
 *   第三种「正在切换」状态只存在于那颗按钮的本地 loading 里 ——
 *   把它抬到这里会让每个消费方都要处理一个与它无关的中间态。
 */
export type DemoSeedState = 'inactive' | 'seeded'

/**
 * 沙箱态下**写操作被拒**时统一回的那句话。
 *
 * ★★ 三条纪律（守卫会红）：
 *   ① **不出现 HTTP 状态码**：学生看到「HTTP 409」既不知道发生了什么、也不知道能做什么；
 *   ② **不出现「演示 / 回放 / 预置 / 假数据」字样**：这是无痕口径的落点 ——
 *      界面里除了那颗按钮本身，不出现任何标注；
 *   ③ **一句话说清"现在不行"**，不含内部 id、不含机制名。
 *
 * ⚠️ 它在 `shared/` 而不是主进程：渲染进程要用它做**兜底提示**（桥缺失 / 回执异常时），
 *    两处各写一句的话，两句话迟早不一样。
 */
export const DEMO_BLOCKED_MESSAGE = '这一项在当前状态下暂不可用。'

/**
 * 一张内联卡片的**预置载荷**。
 *
 * ★ 与 6 事件的 `payload` 事件同形（`kind` + 原始载荷）：渲染侧**不新写一套卡片渲染**，
 *   而是把它喂给与 live 路径**同一批**投影函数
 *   （`readAnimationCard` / `readQuizCard` / `readCodingCard`）——
 *   卡片长什么样只有一处定义，预置内容与真实轮次就不会长得不一样。
 */
export interface DemoSeedCard {
  kind: PayloadKind
  /** 工具产出的原始载荷（形状由各投影函数决定；主进程只负责原样搬运）。 */
  payload: unknown
}

/**
 * 三轮脚本的**一轮**。
 *
 * ★★ 它是「写死的一轮对话」的全部内容，四个表面缺一不可：
 *   学生原话（演示者打什么都显示这一句）/ 助手正文（逐字回放）/ 引用与降级档位 /
 *   卡片 + **该轮的诊断信封**（驾驶舱看的就是它）。
 *
 * ★ 脚本**住在主进程**（`main/demo/script.ts`）而不是渲染进程：
 *   预置载荷里带着 `kpId` 这类内部标识，而渲染进程的源码会被
 *   `student-view-discipline.test.ts` 的 kp slug 守卫扫到 ——
 *   写在渲染侧等于为了让演示好看而给守卫开一个洞。所以脚本经 `demo:script` 下发。
 */
export interface DemoScriptTurn {
  /** 第几轮（1-based）。放完最后一轮**循环回第 1 轮**。 */
  turn: number
  /**
   * 脚本里那句**学生原话**。
   *
   * ★★ 演示者无论打什么、只要按发送就推进一轮，**屏幕上出现的是这一句** ——
   *   这是"看起来像真的用过"与"看起来像在放录像"的分界：现场演示不可能每次都
   *   把那几句话原样打对（打字、错字、来不及），而脚本必须稳定。
   * ⚠️ 唯一的例外见 {@link studentTextFromInput}。
   */
  studentText: string
  /**
   * ★★ **拦截轮**专用：学生气泡显示**演示者真正打进去的那句话**（不预置、不打码）。
   *
   * 判据是「这一轮要让学生看清被拦下的输入是什么」：把敏感词换成脚本里某一句
   * 等于把证据抹掉；而其余几轮反过来 —— 演示者打什么都显示脚本里那句（见
   * {@link studentText} 的说明）。两种口径各有各的用处，所以由这一位显式区分，
   * **不用「`studentText` 是空串」当哨兵**：空串会被
   * {@link isDemoScriptPayload} 的「去空白后还有字」判据挡在边界上。
   * ⚠️ 为 `true` 时 {@link studentText} 仍必须非空 —— 它只是「取不到真输入时的兜底」，
   * 而不是「这一轮没有原话」。
   */
  studentTextFromInput?: boolean
  /** 助手正文（渲染侧按 18ms/字逐字回放）。 */
  answer: string
  /** 这一轮的教材引用（`citation` 事件的载荷）。 */
  citations: Citation[]
  /** 引用的细节（右栏「教材原文」抽屉用；与 `citations` 按 `chunkId` 对齐）。 */
  details?: CitationDetail[]
  /** 这一轮检索落在降级链的哪一档（右栏据此点亮）。 */
  degraded?: Degraded
  /** 这一轮要投的卡片（在正文流到约 70% 处投，与真实路径的观感一致）。 */
  cards: DemoSeedCard[]
  /**
   * 这一轮的**诊断信封**（驾驶舱与机制浮窗的数据底座）。
   *
   * ⚠️ 不带 `sandbox` 字段：沙箱事件**只由渲染进程采集**（Worker 与 iframe 都在它那里，
   *    主进程看不到）。预置信封在这里编一份沙箱事件等于凭空造证据 ——
   *    渲染侧拿到 `code` 类型的卡片时会自己补上它真实观测到的那几条。
   */
  diagnostics: TurnDiagnostics
}

/**
 * 一条**预置历史会话**的逐轮诊断信封（运行透视的时间轴读它）。
 *
 * ★★ 为什么它不是 `TurnDiagnostics` 自身的一部分、而要单独包一层：
 *   那三条会话是**已经聊过**的历史（每轮一条信封），而当前会话的三轮脚本信封
 *   要等演示者真的放出那一轮才允许进时间轴。两者都进同一个快照，
 *   但**来路不同**，所以在这里分开装（渲染侧展平后交给同一个 `applySnapshot`）。
 *
 * ⚠️ `turns` 里的信封与那条会话的**正文同长度、同顺序**（`main/demo/script.ts`
 *    的同一张表生成）：点开会话看到的字与时间轴上的那一轮讲的是同一件事。
 */
export interface DemoHistorySession {
  /** 会话 id（与 `main/demo/data.ts` 的 `DEMO_SESSIONS` 逐字一致）。 */
  sessionId: string
  /** 会话标题（与侧栏那一条逐字一致；时间轴上用它标出「这是哪条会话」）。 */
  title: string
  /** 这条会话的逐轮信封（按时间升序，`turn` 在整份载荷里不重复）。 */
  turns: TurnDiagnostics[]
}

/**
 * `demo:script` 的回执载荷：三轮脚本 + 预置历史的逐轮信封 + 预置会话要挂的卡片。
 *
 * ★ 历史会话的卡片与三轮脚本**共用同一份常量**（`main/demo/data.ts` 里只写一份）：
 *   两处各写一份的话，"点开历史对话看到的动画"与"演示时放的那张"迟早不是同一个。
 */
export interface DemoScriptPayload {
  turns: DemoScriptTurn[]
  /**
   * 拦截演示用的**安全规则**（随包词表的逐字镜像：词表 + 越狱正则 + 各类目回执）。
   *
   * ★ 渲染侧据它决定「这一条要不要放拦截回执」—— 打了才拦、没打就照常推进脚本。
   * ★ 形状与 `shared/demo-safety-rules.ts` 的 `DEMO_SAFETY_RULES` **同一个类型**
   *   （那里定义、这里转发：渲染侧与主进程各写一份的话，两处迟早不是同一套规则）。
   *   `undefined` = 这份载荷没带（老载荷 / 构建到一半），那就**一律不拦**
   *   （宁可少演一段，也不要把正常输入误判成敏感词）。
   */
  safetyRules?: DemoSafetyRules
  /**
   * 预置历史会话的**会话 id**（侧栏点开哪一条能回看到卡片）。
   * 空数组 = 没有任何预置会话带卡片。
   */
  sessionsWithCards: string[]
  /**
   * 三条预置历史会话的逐轮信封（**按时间升序**：最旧的一条在前）。
   *
   * ★★ 为什么连它们一起下发：那三条会话点开就有正文，而原先**一条信封都没有** ——
   *   时间轴上「点开历史对话」是空的，看起来像这套机制只在脚本那一轮跑过。
   *   信封里的每一格都由主进程用真实模块拼出来（见 `main/demo/script.ts` 的信封一节）。
   * ⚠️ 轮次号与 `turns` 里的**不重复**：历史占 1..N，脚本三轮接在 N+1 起。
   */
  history: DemoHistorySession[]
}

/**
 * 脚本的轮数（渲染侧据它做循环；写成导出的常量而不是猜数组长度）。
 *
 * ★ 2026-10-02：3 → 5（加了「我会了」与拦截轮），同一天又 5 → **4** ——
 *   拦截轮被移出脚本：它按**轮次**强制触发时，演示者打「机器学习到底是什么」
 *   也会被拦（环回被吃掉）。现在拦截是一条**由原话决定**的分支
 *   （命中随包词表才走，见 `DEMO_BLOCKED_WORDS`），不该占脚本里的一格。
 * ★ 它同时被 `main/demo/script.ts` 的轮次偏移引用 —— 扩轮时只改这里，
 *   偏移表达式跟着走（写死一个裸数字会让每条信封的累计轮次整体偏掉）。
 */
export const DEMO_SCRIPT_TURN_COUNT = 4

/**
 * 运行期浅校验：`demo:script` 的下发载荷。
 *
 * ★ 为什么"浅"就够：它只用来挡住**半截对象**（主进程构建出错 / IPC 载荷被截断），
 *   而不是代替类型系统。判据是"界面渲染它时不会炸"——三轮必须都在、
 *   每轮的原话与正文必须是非空字符串、卡片必须是数组。
 * ★ 校验不过时**渲染侧不进入脚本态**（而不是带着半截脚本跑）：
 *   宁可按钮点了没反应，也不要在学生面前放一段缺字的回答。
 * ★ `history`（预置历史的逐轮信封）**给了就要完整**：它是可选地带的这一段
 *   （老载荷 / 构建到一半时它先缺席），但一旦在，就必须是「会话 id + 标题 + 逐轮信封」
 *   的形状 —— 缺一条会话的标题会让时间轴上那一轮认不出是哪条会话。
 */
export function isDemoScriptPayload(value: unknown): value is DemoScriptPayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as {
    turns?: unknown
    safetyRules?: unknown
    sessionsWithCards?: unknown
    history?: unknown
  }
  if (!Array.isArray(record.turns) || record.turns.length === 0) return false
  if (!Array.isArray(record.sessionsWithCards)) return false
  if (!isDemoHistory(record.history)) return false
  // ★ 拦截词表是**可选地带的**那一段（老载荷没有它），但一旦在就必须条条完整：
  //   缺 `safeText` 的词会在界面上显示成一个空回执 —— 那比不拦还糟
  //   （学生看到一颗空的红气泡，不知道发生了什么）。
  if (!isDemoSafetyRules(record.safetyRules)) return false
  return record.turns.every((turn) => {
    if (typeof turn !== 'object' || turn === null) return false
    const item = turn as { turn?: unknown; studentText?: unknown; answer?: unknown; cards?: unknown }
    // ★ 判据是「**去了空白之后**还有字」而不是「不是空串」：一行纯空格在界面上
    //   就是一个空气泡（学生看到的是一轮什么都没发生的对话），它必须被挡在边界上。
    return (
      typeof item.turn === 'number' &&
      typeof item.studentText === 'string' &&
      item.studentText.trim() !== '' &&
      typeof item.answer === 'string' &&
      item.answer.trim() !== '' &&
      Array.isArray(item.cards)
    )
  })
}

/**
 * 安全规则那一段的形状检查（`undefined` = 这份载荷没带它，容忍；给了就必须是完整形状）。
 *
 * ★ 判据是「四样都在」：类目表（每类有 label + safeText）、词表、越狱正则、类目优先级。
 *   少任何一样，拦截演示要么不触发、要么弹一颗没有来路（或空白）的红气泡。
 * ★ 语义上的**真伪**不在这里管（词是不是真在随包词表里、回执有没有抄错），
 *   那是 `tests/demo-seed.test.ts` 的 ⑩ 对着 `sensitive-words.json` 逐条核对的事 ——
 *   这里是运行期浅校验，只挡半截对象。
 */
export function isDemoSafetyRules(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false
  const rules = value as {
    categories?: unknown
    words?: unknown
    patterns?: unknown
    categoryPriority?: unknown
  }
  if (!Array.isArray(rules.categoryPriority) || rules.categoryPriority.length === 0) return false
  if (typeof rules.categories !== 'object' || rules.categories === null) return false
  for (const entry of Object.values(rules.categories as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) return false
    const category = entry as { label?: unknown; safeText?: unknown }
    if (typeof category.label !== 'string' || category.label.trim() === '') return false
    if (typeof category.safeText !== 'string' || category.safeText.trim() === '') return false
  }
  if (!Array.isArray(rules.words)) return false
  for (const entry of rules.words) {
    if (typeof entry !== 'object' || entry === null) return false
    const word = entry as { word?: unknown; category?: unknown; severity?: unknown }
    if (typeof word.word !== 'string' || word.word.trim() === '') return false
    if (typeof word.category !== 'string' || word.category.trim() === '') return false
    if (typeof word.severity !== 'string' || word.severity.trim() === '') return false
  }
  if (!Array.isArray(rules.patterns)) return false
  for (const entry of rules.patterns) {
    if (typeof entry !== 'object' || entry === null) return false
    const pattern = entry as { id?: unknown; pattern?: unknown; category?: unknown }
    if (typeof pattern.id !== 'string' || pattern.id.trim() === '') return false
    if (typeof pattern.pattern !== 'string' || pattern.pattern.trim() === '') return false
    if (typeof pattern.category !== 'string' || pattern.category.trim() === '') return false
  }
  return true
}

/**
 * 预置历史那一段的形状检查（`undefined` = 这份载荷没带它，容忍；给了就必须是完整形状）。
 *
 * ★ 逐轮信封用的判据与 `@shared/diagnostics` 的 `isTurnDiagnostics` **同一把尺子**
 *   （轮次号 + 请求号 + `done` 三样都在）：那三样是「它是一条信封」的最小结构面。
 * ⚠️ 为什么不直接 value-import 那个函数：`@shared/diagnostics` 是**值 import**，
 *   而本文件被 `tests/demo-seed.test.ts` 直接加载（Node 的 ESM 链接期在钩子注册之前，
 *   解析不了不带扩展名的相对导入）—— 值 import 会让那份测试当场加载不起来。
 *   判据是「三行重复」与「一条测试路径」之间选前者，所以这里照抄那三样，
 *   **判据一个字都不放宽**（少一样就挡住）。
 */
function isDemoHistory(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every((session) => {
    if (typeof session !== 'object' || session === null) return false
    const item = session as { sessionId?: unknown; title?: unknown; turns?: unknown }
    if (typeof item.sessionId !== 'string' || item.sessionId.trim() === '') return false
    if (typeof item.title !== 'string' || item.title.trim() === '') return false
    if (!Array.isArray(item.turns) || item.turns.length === 0) return false
    return item.turns.every((turn) => {
      if (typeof turn !== 'object' || turn === null) return false
      const envelope = turn as { turn?: unknown; requestId?: unknown; done?: unknown }
      return (
        typeof envelope.turn === 'number' &&
        typeof envelope.requestId === 'string' &&
        typeof envelope.done === 'object' &&
        envelope.done !== null
      )
    })
  })
}

/**
 * 运行期浅校验：`demo:seed` 的入参。
 *
 * ★ 渲染进程递来的值**一律不当真**（与 `grade:set` / `chapter:set` 同一条纪律）：
 *   认不出就拒，**不兜底成其中一个**（兜底会让一个拼错的枚举值静默地退出沙箱）。
 */
export function readDemoSeedState(value: unknown): DemoSeedState | null {
  return value === 'inactive' || value === 'seeded' ? value : null
}
