/**
 * 轮次时钟（持续画像迭代一期）—— **什么时候该跑一次概括**。
 *
 * ★★ 这个文件要回答的唯一问题：**现在到第几轮了，该不该概括？**
 *
 * ## 为什么需要它（不能只靠后端已有的位标）
 *
 * 后端 `grade_signals` 的 `max(id)` 是**信号位标**，`turn_mark` 那一套用它算「过了几轮」。
 * 但它的粒度是**信号条数桶**（`(session_id, turn)`），不是「学生说了几句话」——
 * 用它当"每 N 轮触发"的计数器需要每轮都发一次 HTTP，且轮次语义会与这里的定义漂移。
 *
 * ## 双保险：本地计数 + 后端校准
 *
 * ```
 *   本地计数（快、零 IO） ──► 正常连续对话靠它
 *         │
 *         └─ 跨重启会丢 ──► 启动时用后端 max(id) 校准一次（只往下限兜，不往上顶）
 * ```
 *
 * ★ **为什么校准是「取下限」而不是「直接赋值」**：
 *   后端位标数的是**信号条数**（一轮可能写 3 行），天然 ≥ 真实轮数。
 *   如果拿它**直接覆盖**本地计数，本地计数会被虚高，于是「每 5 轮触发」变成
 *   「每 2 轮触发」（调用量直接翻倍）。
 *   所以校准的正确语义是：**只保证不因重启而清零**（取两者较大值），
 *   而不是用后端值去覆盖一个更精确的本地值。
 *
 * ## 为什么是模块级单例而非类
 *
 * 生产里整个主进程只有一个活动会话的轮次在跑（切会话 = dispose 旧的再装配新的）。
 * 类实例化会引入「谁来持有它 / 什么时候换」这种生命周期问题，而它**没有**会话归属：
 * 「轮」是**学生**的属性，不是会话的（与 grade_signals 的口径一致：证据跨会话连续）。
 * 纯函数 + 一个模块级 Map（按 studentId 分桶）即可，也最好测。
 */

/**
 * 每几轮跑一次持续画像概括。
 *
 * ★ 5 是可调常量（计划 §7 待确认项 1 的建议值）。调大的后果：画像跟不上学生变化；
 *   调小的后果：LLM 调用量线性上升（长对话成本可观，见计划 §5.1 风险 4）。
 * ★ 做成常量而不是散在调用点，是为了「调整 = 改一个数」而不是「找齐所有 % N 的地方」。
 */
export const PROFILE_REFRESH_EVERY_TURNS = 5

/**
 * 轮次计数的最小实质内容门槛（字符数）。
 *
 * ★ 计划 §5.1 的优化「轮次只是必要条件，不是充分条件」：学生连着回
 *   「嗯」「好的」「懂了」三轮，也走满了 3 轮计数，但**没有任何可概括的内容** ——
 *   这时候调一次 LLM 纯属浪费（还会产出空结果）。
 * ★ 门槛取「去空白后的字符数」。**2 是下界，不能再高**：
 *   「不会」「不懂」「太快」这些**两字回答是真实的学习信号**（学生卡住了），
 *   把它们判成「没有内容」会把最重要的那类回答静默丢掉 —— 而那恰恰是
 *   画像最该记下的一类。
 * ★ 1 太低（「嗯」「哦」「是」「对」全是单字，挡不住）；
 *   3 太高（会误伤「不会」）。所以正好取 2，与「最短的有意义回答」等长。
 */
export const MIN_MEANINGFUL_TURN_CHARS = 2

/** 一个学生的轮次状态。 */
interface TurnState {
  /** 已经走过的轮次数（每次 noteTurn 加一）。 */
  turn: number
  /** 上次触发概括时的轮次号（避免同一轮被触发两次）。 */
  lastRefreshTurn: number
  /** 累积的「有实质内容」轮次数（用于「全是嗯嗯啊啊就跳过」的判断）。 */
  meaningfulTurns: number
}

/**
 * 按学生分桶的轮次状态。
 *
 * ★ 用 Map 而不是单个变量：一人一库的隔离在**计数**这一层也要成立 ——
 *   换学生不清零的话，B 同学会继承 A 同学的轮次（虽然生产里通常只有一个学生，
 *   但测试与将来多学生场景下，这是正确性问题而非优化）。
 */
const clocks = new Map<string, TurnState>()

function stateOf(studentId: string): TurnState {
  let state = clocks.get(studentId)
  if (!state) {
    state = { turn: 0, lastRefreshTurn: 0, meaningfulTurns: 0 }
    clocks.set(studentId, state)
  }
  return state
}

/**
 * 记一轮对话，返回**记完之后**的轮次号。
 *
 * @param studentId 学生（计数按学生隔离）。
 * @param text      本轮学生说的话（只用来判断「有没有实质内容」，**不存储、不外发**）。
 */
export function noteTurn(studentId: string, text = ''): number {
  const state = stateOf(studentId)
  state.turn += 1
  if (isMeaningful(text)) state.meaningfulTurns += 1
  return state.turn
}

/**
 * 一段文本算不算「有实质内容」。
 *
 * ★ 判据有意做得**极简**（长度）：任何更"聪明"的判断（关键词表、模型分类）
 *   都会引入第二套需要维护的规则，而这里只是决定"要不要省一次 LLM 调用" ——
 *   判错的代价是「多跑一次」，不是「漏掉学生」。
 * ★ 但门槛**不能高**：判成「没内容」的代价其实是**漏掉真实信号**
 *   （「不会」这类卡壳回答），所以下界取 2（见 {@link MIN_MEANINGFUL_TURN_CHARS}）。
 */
export function isMeaningful(text: string): boolean {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, '') : ''
  return flat.length >= MIN_MEANINGFUL_TURN_CHARS
}

/**
 * 现在该不该跑概括（纯读，不改变状态）。
 *
 * 两个条件**同时**满足：
 *   ① 轮次够了：`turn - lastRefreshTurn >= PROFILE_REFRESH_EVERY_TURNS`；
 *   ② 这段窗口里**有实质内容**（`meaningfulTurns > 0`，见 {@link MIN_MEANINGFUL_TURN_CHARS}）。
 *
 * ★ 为什么用「距上次概括的差值」而不是 `turn % N === 0`：
 *   `% N` 在"某几次被实质内容门槛挡下"时会**错过触发点** —— 第 5 轮被挡（全是嗯嗯），
 *   第 10 轮才 % 5 === 0 才触发，中间白等了 5 轮；更糟的是如果第 5、10 轮都被挡，
 *   触发点会一路错过。用差值语义则"攒够 N 轮且这期间有内容"就触发，不会漏。
 */
export function shouldRefresh(studentId: string): boolean {
  const state = clocks.get(studentId)
  if (!state) return false
  if (state.meaningfulTurns <= 0) return false
  return state.turn - state.lastRefreshTurn >= PROFILE_REFRESH_EVERY_TURNS
}

/**
 * 标记「刚刚跑过概括」，把 `lastRefreshTurn` 推到当前轮次。
 *
 * ★ 必须**在概括成功发起之后**调（而不是在 shouldRefresh 里顺手调）：
 *   如果概括发起了但立刻失败（模型不可用），我们仍应推进计数 —— 否则
 *   下一轮 `shouldRefresh` 又为真、又立刻重试，变成**失败风暴**。
 *   概括是尽力而为的增强，失败就等下一个周期，这正是不重试策略的落点。
 */
export function markRefreshed(studentId: string): void {
  const state = stateOf(studentId)
  state.lastRefreshTurn = state.turn
  state.meaningfulTurns = 0
}

/**
 * 用后端位标**校准**轮次（启动时调一次；只保证不因重启清零）。
 *
 * @param studentId     学生。
 * @param backendMark   后端 `grade_signals` 的 `max(id)`（拿不到就给 0）。
 *
 * ★ 语义是 `max(本地, 后端)`（见文件头「为什么是取下限」）：
 *   重启后本地是 0，后端是 42 → 取 42，于是「第 45 轮」会正常触发而不是从 0 重来；
 *   本地已经在 43（没重启），后端 42 → 取 43，**不倒退**。
 * ★ 校准**不动** `lastRefreshTurn`：重启后"上次概括在第几轮"确实不知道了，
 *   保守做法是让它保持 0（= 校准后的第一轮就可能触发一次）。这是对的 ——
 *   重启往往意味着离开了一段时间，跑一次概括补上这段变化是符合预期的。
 */
export function calibrateTurn(studentId: string, backendMark: number): number {
  const state = stateOf(studentId)
  const mark = Number.isFinite(backendMark) ? Math.max(0, Math.floor(backendMark)) : 0
  if (mark > state.turn) state.turn = mark
  return state.turn
}

/** 读当前轮次（诊断 / 测试用）。 */
export function currentTurn(studentId: string): number {
  return clocks.get(studentId)?.turn ?? 0
}

/** 清空一个学生的计数（切换/删除学生时调；测试之间调）。 */
export function resetTurnClock(studentId: string): void {
  clocks.delete(studentId)
}

/** 清空全部（仅供测试）。
 *
 * ★ 生产路径**没有**这个调用点，也不该有：真实学生的轮次要跨重启留着（靠校准），
 *   清空全部会把所有人一起归零。
 */
export function resetAllTurnClocks(): void {
  clocks.clear()
}
