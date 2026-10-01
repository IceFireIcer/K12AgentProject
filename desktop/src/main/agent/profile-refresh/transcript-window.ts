/**
 * 对话环形缓冲（持续画像迭代一期）—— **给概括看哪几轮**。
 *
 * ★★ 这个文件要回答的唯一问题：**最近 N 轮的「学生 ⇄ 助手」原文，上哪儿取？**
 *
 * ## 为什么是内存缓冲，不是新建一张表
 *
 * 对话正文的**唯一真相是 Pi 的会话文件**（`session:transcript` 通道能读，
 * 见 `ipc/handlers.ts`）。本项目有一条不变量的红线：**SQLite 不存对话正文**
 * （唯一例外是冷启动五问那 5 条，见 `extensions/profile.ts` 文件头）。
 * 所以这里**绝不能**把对话写进库 —— 那既违反不变量，也会与 Pi 会话文件**漂移**
 * （两份数据，迟早对不上）。
 *
 * 内存缓冲是唯一正确的选择：
 *   · 它只在**本进程生命周期内**存在（重启即空 —— 那没关系，重启后从头攒）；
 *   · 它**不落盘**（关上电脑什么都没有，与「模型能看见什么」的边界一致）；
 *   · 它的大小**有界**（环形，最多留 `PROFILE_REFRESH_WINDOW_TURNS` 轮，不为长对话吃内存）。
 *
 * ## 为什么按学生分桶
 *
 * 与轮次时钟同一条纪律：轮次与对话是**学生**的属性，不是会话的。
 * 切换学生会话时空缓冲会串味 —— 更糟的是，B 同学可能继承 A 同学的对话文本
 * 并被送进概括（那是一条**跨学生的数据泄漏**，禁做 #9）。
 *
 * ## 为什么存「轮」而不是「条消息」
 *
 * 概括要的是「学生说了什么 + 助手怎么回应」的**配对**上下文（计划 §2.4 三个细节之一：
 * 助手的话只帮你理解上下文的来龙去脉）。存成扁平的消息数组会让"这一句是对谁的回应"
 * 无法还原，而存成 turn 对象天然成对。
 */

/**
 * 缓冲保留几轮。
 *
 * ★ 它**不是**触发周期（那是 `PROFILE_REFRESH_EVERY_TURNS`）：触发周期决定
 *   "多久跑一次"，窗口大小决定"每次跑时回看多远"。
 * ★ 为什么允许窗口 ≥ 周期：这样即使某次概括被"没有实质内容"挡下、顺延到下一轮，
 *   回看时仍能看到被挡下的那几轮（否则会被静默丢掉）。
 *   取 2×周期是"够用且不失控"的默认：10 轮的对话正文，配合每条 500 字截断，
 *   载荷体量可控（计划 §2.4 细节 2）。
 */
export const PROFILE_REFRESH_WINDOW_TURNS = 10

/** 一轮对话（学生一句 + 助手一句）。 */
export interface TranscriptTurn {
  /** 学生这一轮说的话（原文；**脱敏与截断在载荷构建时做**，见二期 buildRefreshPayload）。 */
  readonly user: string
  /** 助手这一轮的回复（原文；同上）。 */
  readonly assistant: string
  /** 这一轮的序号（= 记进来时的轮次号，便于日志与去重）。 */
  readonly turn: number
}

/** 按学生分桶的环形缓冲。 */
const windows = new Map<string, TranscriptTurn[]>()

/**
 * 推入一轮对话（环形：超过窗口大小就丢最旧的）。
 *
 * @param studentId 学生。
 * @param user      学生原文（空串 = 本轮学生没说话，如系统触发；仍会记，但 user 为空）。
 * @param assistant 助手原文。
 * @param turn      轮次号（一般来自 `turn-clock` 的 `noteTurn` 返回值）。
 *
 * ★ 为什么**不用** `push` + `shift`：那在长对话下是 O(n)。这里用定长数组 + 覆盖写
 *   （环形），推入是 O(1)。窗口只有 10 轮，其实两种写法都无所谓 ——
 *   但"有界"这件事要**从代码结构上看得出来**，而不是靠"反正只有 10 个"。
 */
export function pushTurn(studentId: string, user: string, assistant: string, turn: number): void {
  let window = windows.get(studentId)
  if (!window) {
    window = []
    windows.set(studentId, window)
  }
  window.push({
    user: typeof user === 'string' ? user : '',
    assistant: typeof assistant === 'string' ? assistant : '',
    turn: Number.isFinite(turn) ? Math.floor(turn) : 0
  })
  // 环形：只留最近 PROFILE_REFRESH_WINDOW_TURNS 轮
  while (window.length > PROFILE_REFRESH_WINDOW_TURNS) window.shift()
}

/**
 * 读最近几轮（**新的在后**，与对话发生顺序一致）。
 *
 * @param studentId 学生。
 * @param limit     最多取几轮；不传 = 全窗口。传入超过窗口的值会被窗口大小截断。
 * @returns 副本（调用方改动不影响缓冲 —— 缓冲是主进程的**唯一真相**，
 *          不能被一次载荷构建顺手改掉）。
 */
export function recentTurns(studentId: string, limit?: number): TranscriptTurn[] {
  const window = windows.get(studentId) ?? []
  const capped =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(0, Math.min(Math.floor(limit), window.length))
      : window.length
  // 从尾部取 capped 条（最近 capped 轮），保持时间升序
  return window.slice(window.length - capped).map((turn) => ({ ...turn }))
}

/** 当前窗口里有几轮（诊断 / 测试用）。 */
export function turnWindowSize(studentId: string): number {
  return windows.get(studentId)?.length ?? 0
}

/** 清空一个学生的缓冲（切换/删除学生时调）。
 *
 * ★ 切换学生时**必须**调：否则 B 同学会继承 A 同学的对话文本，
 *   并被送进概括 —— 跨学生数据泄漏（禁做 #9）。
 */
export function clearTranscriptWindow(studentId: string): void {
  windows.delete(studentId)
}

/** 清空全部（仅供测试；生产无调用点）。 */
export function clearAllTranscriptWindows(): void {
  windows.clear()
}
