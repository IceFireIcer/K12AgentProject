/**
 * ★ 学生情况（画像）在 System Prompt 里的**唯一拼装器**（票 20 的对话侧落点）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这个块
 * ---------------------------------------------------------------------------
 * `extensions/profile.ts` 早就把画像渲染成了一段**给模型看**的中文摘要
 * （`renderProfileText`：掌握度分档、学习偏好、依赖图推荐的下一步），
 * 但它此前**只在 `get_student_profile` 这个 Tool 被模型主动调用时才用得上** ——
 * 模型不主动调，画像就是「算好了却从不进 Prompt」的死数据，个性化等价于没有。
 *
 * 本模块把那段摘要变成**每轮固定注入**的一节：学生一开口，模型手上就已经有
 * 「这个学生会什么、卡在哪、适合下一步学什么」。注入点见 `runtime.ts` 的
 * `buildSystemPrompt()`（6 个落盘/发出口共用它，见那里的注释）。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须幂等（每轮都会重拼）
 * ---------------------------------------------------------------------------
 * `before_agent_start` **每一轮**都会重拼整份 system prompt，而 Pi 传进来的
 * `event.systemPrompt` 就是上一轮的产物（含上一轮注入的块）。拼装若不幂等，
 * 块会一轮一层地叠上去：prompt 预算被自己吃掉，`chat-system-prompt.txt` 那份证据
 * 也会和真正发出去的文本不一样。所以语义定成：
 *   ① 先 {@link stripStudentContext} 清掉旧块 → ② 再在**学段权威段之前**插新块。
 * 重复调用 `withStudentContext(withStudentContext(x, b), b) === withStudentContext(x, b)`。
 *
 * ---------------------------------------------------------------------------
 * ★ 第三条纪律：块必须**逐字节稳定**（缓存前缀，比省 token 重要得多）
 * ---------------------------------------------------------------------------
 * 本块的产物进的是 system prompt，而 system prompt 是**前缀缓存的最前面一段**。
 * 前缀缓存按「从头开始的最长相同前缀」命中，所以块里**任何**每轮都变的字节
 * （时间戳、计数器、会话 id、随机的键序）都会让整段前缀连同**它后面的全部对话历史**
 * 一起丢掉命中 —— 学生的直接感受是响应变慢（重新预填充），间接代价是成本。
 * 因此：
 *   ① 块里**不放时间**（`renderProfileText` 已经去掉了「最近活跃」那一行；
 *      「错过的地方」也**只放知识点名与错次**，不放 `lastWrongAt` —— 时间每天都在变）；
 *   ② 偏好按 `PREFERENCE_ORDER` 的固定顺序渲染（不用 `Object.entries` 的原始顺序，
 *      它取决于 SQLite 行序 —— 重写同一个键就可能让整块变样）；
 *   ③ 掌握度平局按 kpId 排（不依赖调用方给的数组顺序）；错题同理，平局也按 kpId。
 * 所以：**同样的画像 → 逐字节相同的块**；只有画像真的变了，块才变 ——
 * 那时候丢掉一次缓存命中是**应该付的**，因为它换来了真实的个性化更新。
 *
 * 纪律（承上）：**纯函数**、**正文渲染只有一份实现**（`renderProfileText`）。
 */

import { GRADE_OVERRIDE_HEADING } from '../extensions/grade.ts'
// ★ 复用画像渲染的唯一实现（不要在本文件里再写一份掌握度/推荐的行渲染）
import {
  renderProfileText,
  type MistakesResponse,
  type ProfileResponse,
  type RecommendationResponse
} from '../extensions/profile.ts'

/**
 * 块的二级标题（与 `GRADE_OVERRIDE_HEADING` 同形：`## ` 开头的二级标题）。
 *
 * 两处用途，**同一个字面量**：
 *   - 拼装时写在块首（{@link renderStudentContextBlock}）；
 *   - 幂等清理时按它找旧块（{@link stripStudentContext}）—— 所以它必须是**唯一**的识别标志，
 *     改字面量等于让历史 prompt 里的旧块再也清不掉（因此这里只定义一次，别处一律引用）。
 *
 * 括号里那句「不要逐条念给学生」是给模型的：块里带知识点 id 与分数（机器口径），
 * 直接念出来学生完全听不懂（`renderProfileText` 的结尾也重申了这条）。
 */
export const STUDENT_CONTEXT_HEADING = '## 该学生当前情况（系统自动汇总，不要逐条念给学生）'

export interface StudentContextOptions {
  /** 掌握度条目上限（Prompt 预算控制；`renderProfileText` 内部再夹到 1–20）。 */
  maxMastery?: number
  /** 推荐详细版（票 20 的 `/recommendation`）；取不到就退回画像里的 kp_id 列表。 */
  recommendation?: RecommendationResponse | null
  /**
   * 错题摘要（`/api/quiz/mistakes`，与「学习档案 → 错题本」**同一个端点**）。
   *
   * ★ 只注入**知识点名 + 错次**，不注入题干与时间：见 `MistakesResponse` 的注释
   *   与第三条第 ① 款（块里不放每轮会变的字节）。
   */
  mistakes?: MistakesResponse | null
  /** 画像里没有 `student.studentId` 时的兜底（主进程注入的学生 id）。 */
  fallbackStudentId?: string
}

/**
 * 把画像渲染成可直接拼进 system prompt 的一节（**纯函数**）。
 *
 * `profile === null`（新学生 404 / sidecar 不可用 / 结构不认）→ 返回 `''`：
 * **没有画像就不注入**，绝不产生一个只有标题、正文空着的空壳段
 * （空壳段会让模型以为「系统查过了，什么都没有」，而事实是「这次没查到」）。
 *
 * 返回值形态：`## 标题\n<renderProfileText 的输出>`；块与其它段落之间的分隔
 * 由 {@link withStudentContext} 负责，本函数不负责首尾空行。
 */
export function renderStudentContextBlock(
  profile: ProfileResponse | null,
  options: StudentContextOptions = {}
): string {
  if (!profile || typeof profile !== 'object') return ''
  const body = renderProfileText(profile, {
    maxMastery: options.maxMastery,
    recommendation: options.recommendation ?? null,
    mistakes: options.mistakes ?? null,
    fallbackStudentId: options.fallbackStudentId
  })
  if (typeof body !== 'string' || body.trim() === '') return ''
  return `${STUDENT_CONTEXT_HEADING}\n${body}`
}

/**
 * 去掉上一次注入的学生情况块（幂等的前提）。**找不到标题时原样返回**（不动别人的 prompt）。
 *
 * ★ 手法与 `extensions/grade.ts` 的 `stripGradeOverride` 一致（`lastIndexOf` + 切尾 + 去掉尾随空白），
 *   但有一处**必须**不同：那块权威段（{@link GRADE_OVERRIDE_HEADING}）就排在本块**后面**，
 *   若照「切到字符串末尾」的做法，被切掉的会是**学段权威段**本身 ——
 *   本轮 prompt 就丢了「按哪个学段作答」这一节，`chat-system-prompt.txt` 里也 grep 不到学段，
 *   于是变成「隔轮才有学段」（下一轮由 grade 扩展补回来，再下一轮又被切掉）。
 *   所以：块后面跟着权威段时，**只切到权威段之前**，权威段原样保留。
 *
 * 有界循环（最多 4 次）是为了兜「历史 prompt 里已经叠了多块」的脏数据：
 * 单次调用只清掉最后一块，循环不会无限（每次至少往后截断一次）。
 */
export function stripStudentContext(prompt: string): string {
  if (typeof prompt !== 'string' || prompt.length === 0) return prompt
  let out = prompt
  for (let index = 0; index < 4; index += 1) {
    const next = stripLastStudentContextBlock(out)
    if (next === out) break
    out = next
  }
  return out
}

/** 清掉**最后一块**（{@link stripStudentContext} 的单步；导出仅为可单测，别处一律用外层那个）。 */
function stripLastStudentContextBlock(prompt: string): string {
  const at = prompt.lastIndexOf(STUDENT_CONTEXT_HEADING)
  if (at < 0) return prompt
  const tail = prompt.slice(at)
  const gradeAt = tail.indexOf(GRADE_OVERRIDE_HEADING)
  if (gradeAt < 0) return prompt.slice(0, at).replace(/\s+$/, '')
  const head = prompt.slice(0, at).replace(/\s+$/, '')
  const rest = tail.slice(gradeAt)
  return head === '' ? rest : `${head}\n\n${rest}`
}

/**
 * 把学生情况块拼进 prompt：**先清旧块**（幂等），再插在**学段权威段之前**。
 *
 * 为什么插在学段权威段**之前**而不是末尾：
 *   - 学段权威段是「本轮按哪个学段作答」的**最后一句权威指令**，必须离生成最近
 *     （`grade.ts` 的链式语义：多个扩展的 prompt 覆盖是**叠加**的，排最后的说话最响）；
 *   - 这个位置同时让两件事自动成立：① `grade.ts` 的 `stripGradeOverride` 每轮会从权威段
 *     起头截断，块在它前面因此**不会**被带进下一轮的 `bare` 里反复累积；
 *     ② 反过来本模块清理旧块时只要保住权威段即可（见 {@link stripStudentContext}）。
 *
 * `block` 为空串（没有画像 / 取画像失败降级）→ **原样返回清理后的 prompt**：
 * 绝不留下空标题，也绝不因为「这次没取到画像」把上一段别的扩展写的内容也改掉。
 * 找不到权威段标题时**追加到末尾**（认不出的自定义 prompt：不丢别人的内容，也不假装插得进去）。
 */
export function withStudentContext(prompt: string, block: string): string {
  const cleaned = stripStudentContext(typeof prompt === 'string' ? prompt : '')
  if (typeof block !== 'string' || block.trim() === '') return cleaned
  const at = cleaned.lastIndexOf(GRADE_OVERRIDE_HEADING)
  if (at < 0) return cleaned.trim() === '' ? block : `${cleaned}\n\n${block}`
  const head = cleaned.slice(0, at).replace(/\s+$/, '')
  const rest = cleaned.slice(at)
  return head === '' ? `${block}\n\n${rest}` : `${head}\n\n${block}\n\n${rest}`
}
