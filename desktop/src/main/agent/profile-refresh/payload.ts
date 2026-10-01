/**
 * 持续画像概括的**载荷构建 + 回执解析**（持续画像迭代二期）。
 *
 * ── 它与五问概括（`onboarding/summarize-llm.ts`）的关系 ─────────────────────
 *
 * 两条 prompt **用途不同，绝不合并**（计划 §5.3「不动五问的 buildSummaryPayload」）：
 *   · 五问版：输入是「首次见面的五个问答」，**一次性**，产出 `source='declared'`；
 *   · 本文件：输入是「最近 N 轮的**真实对话**」，**周期性**，产出 `observed`/`inferred`。
 * 唯一的共同点是「都是让模型把文本整理成白名单标签」—— 但纪律不同、来源不同、
 * 单次上限不同（12 vs 4），合并成一个函数会让每一处差异都变成 `if (isRefresh)`。
 *
 * ★ 复用（不重写）的东西：
 *   · 白名单：`LLM_VISIBLE_TAGS`（shared/profile-tags.ts）—— 安全边界只有一份；
 *   · 脱敏：`sanitizeStudentText`（onboarding/sanitize.ts）—— PII 模式表只有一份；
 *   · 出网：`llmFetch` / `chatCompletionsUrl` 等仍由 `onboarding/summarize-llm.ts` 导出，
 *     本文件**自己不发请求**（见 `runRefresh` 的编排）。
 *
 * ── ★★ 本文件要守住的三条（计划 §2.4「三个必须做对的细节」）────────────────
 *
 *  ① **脱敏**：学生文本与**助手文本**都必须过 `sanitizeStudentText`。
 *     助手文本也要过 —— 助手可能复述了学生的话（「你刚才说你住在……」），漏了就是侧漏。
 *  ② **截断**：每条消息截到 {@link REFRESH_MSG_MAX_CHARS}。助手回复尤其长，
 *     10 轮不截断能把 token 预算吃光（而这只是一次**尽力而为**的后台增强）。
 *  ③ **助手消息的定位**：助手的话**不是**画像证据，它是**上下文** ——
 *     用来判断「学生那句话在回应什么」。prompt 里必须明说这一点，
 *     否则模型会把助手说的知识点当成学生的偏好。
 *
 * ── ★ 与五问版最大的一处不同：**教模型分辨证据性质**（计划 §2.3.1）──────────
 *
 * 五问版一律 `declared`（全是学生自己说的）。持续迭代版必须让模型**自己判断**：
 *    · 这是学生**自己说过的** → `source='observed'`（他表现过的事实，可写全 25 键）；
 *    · 这是你**从他行为里推出来的** → `source='inferred'`（只限情绪/风格 8 键，禁做 #10）。
 * 这条口径不能含糊：`inferred` 受禁做 #10 限制只能写 8 个键，
 * 若概括一律标 `inferred`，「兴趣/场景/目标/互动偏好」**永远填不上**，
 * 整个持续迭代就白做了；若为填满维度就放开 `inferred` 限键，那是**移动安全边界**。
 * 所以唯一的正解是在 prompt 里教模型分辨，并让它据此选 source。
 *
 * ⚠️ `declared` **绝不由概括产出**：那是「学生自述」的专属来源，只能来自五问
 *    那条真实路径。本文件的解析器**收不到** `declared`（`parseRefreshTags` 显式拒绝），
 *    后端契约层 `RefreshApplyTag._no_declared` 再挡一次（纵深防御）。
 *
 * ⚠️ 本文件是**纯函数**（除传进来的参数外不读任何 IO），会被 node --test 直接加载。
 */

import {
  EPHEMERAL_TAG_SET,
  LLM_VISIBLE_TAGS,
  LEARNER_STYLE_VALUE_SET,
  LEARNER_STYLE_VALUES,
  PERSONALITY_VALUE_SET,
  PERSONALITY_VALUES
} from '../../../shared/profile-tags.ts'
import { sanitizeStudentText } from '../onboarding/sanitize.ts'
import type { TranscriptTurn } from './transcript-window.ts'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/**
 * 持续概括能产出的 key —— 与五问版**逐字相同**的一条算式（白名单 ∩ 非 join 钥匙 ∩ 非短期情绪）。
 *
 * ★ 为什么再算一遍而不是 import 五问版的常量：那个常量名为
 *   `ONBOARDING_SUMMARY_ALLOWED_KEYS`，语义是「五问能写哪些键」—— 两者**当前**相等，
 *   但它们的**理由不同**（五问是「学生自述可得」，本次是「对话可得」）。
 *   共用一个名字会让将来某一侧要收窄时的改动看起来像「顺手改了另一侧的安全边界」。
 *   算式只有一行，重复它的代价远小于把两条纪律绑在一起。
 */
export const REFRESH_ALLOWED_KEYS: readonly string[] = LLM_VISIBLE_TAGS.filter(
  (key) => key !== 'anon_student_id' && !EPHEMERAL_TAG_SET.has(key)
)

/**
 * `inferred` 来源允许的键（禁做 #10 的可执行形态）。
 *
 * ★ 与后端 `INFERRED_ALLOWED_TAG_KEYS`（store/learning.py）**逐字一致** ——
 *   但这里是**prompt 侧的前置收窄**（告诉模型「这几个键你不许用 inferred 写」），
 *   后端那份是**写库侧的硬校验**（越界直接 ValueError）。两处都要有：
 *   prompt 收窄是为了少浪费 token（让模型一开始就别写），后端硬校验是为了
 *   「模型不听话时也写不进去」。**判据唯一，落点两处，不是两套规则。**
 *
 * ★★ 8 → 10（2026-09-30）：新增 `learner_style` / `personality` 两键，
 *   这是一次**红线的最小移动**（原红线含「性格」，本轮用户裁决放开性格一维）。
 *   新键与既有八键**同属一类** —— 都是「从表现里看出的倾向」，不是客观量；
 *   移动边界与配套的三道闸写在 shared/profile-tags.ts 的「维度 13」一节。
 */
export const REFRESH_INFERRED_KEYS: readonly string[] = [
  'explain_style',
  'output_length',
  'pace',
  'practice_type',
  'emotion',
  'intensity',
  'trigger',
  'confidence',
  // 维度 13（2026-09-30）
  'learner_style',
  'personality'
]

/**
 * 一次持续概括最多写几条。
 *
 * ★ 比五问版的 12 **小得多**（=4）。理由：五问是**一次性冷启动**（要一次把画像填满），
 *   而持续迭代是**小步修正**（每 5 轮微调几条）。一次改 4 条以上说明模型在编 ——
 *   5 轮真实对话里能提取的**新**信息本来就不多，模型说改 8 条，多半是把已知的重述一遍
 *   或凭空补维。宁可少写，交给下一个周期。
 */
export const REFRESH_MAX_TAGS = 4

/**
 * 单条消息进载荷前截断到的字符数。
 *
 * ★ 助手回复尤其长（一段讲解动辄上千字）。10 轮各 1000 字 = 10000 字 ≈ 吃光预算，
 *   而这里要的只是「学生那句话在回应什么」这个上下文 —— 前 500 字足够判断，
 *   后面的展开对**画像**没有增量信息。截断点**在脱敏之后**（先脱敏再截断：
 *   反过来会把「…路 88 号」截在中间，剩下半段反而看不出是地址）。
 */
export const REFRESH_MSG_MAX_CHARS = 500

/** 单条 value 的长度上限（与五问版同口径：短语，不是正文）。 */
export const REFRESH_MAX_VALUE_CHARS = 30

/** 模型没给置信度时的默认值（低于五问的 0.6 —— 持续迭代是「从对话里读出来的」，更不确定）。 */
export const REFRESH_DEFAULT_CONFIDENCE = 0.5

/* ------------------------------------------------------------------ *
 * 载荷
 * ------------------------------------------------------------------ */

/** 载荷构建的输入。 */
export interface RefreshPayloadInput {
  /** 最近几轮对话（时间升序；由 `transcript-window.ts` 的 `recentTurns` 提供）。 */
  turns: readonly TranscriptTurn[]
  /**
   * 已有的画像标签（`key=value` 对）—— 告诉模型「这些已经有了」，避免重复输出。
   * ★ 只能是白名单键（调用方负责过滤）；**不含** `anon_student_id`。
   */
  knownTags: readonly { key: string; value: string }[]
  /**
   * 已经写过的键（尤其是 `declared` 的）—— prompt 里点名「这些别碰」。
   *
   * ★ 为什么把 declared 单独列出来：那些是学生亲口说的，后端**永不覆盖**（G-M-1）。
   *   提前告诉模型能省一次无效输出；但**不能只靠它**（模型可能不听），
   *   所以后端分档矩阵与解析侧仍各挡一次。
   */
  protectedKeys?: readonly string[]
}

/** 载荷（两条消息）。 */
export interface RefreshPayload {
  system: string
  user: string
}

/** 把一轮里的文本脱敏 + 截断（顺序不能反，见 {@link REFRESH_MSG_MAX_CHARS}）。 */
function sanitizeAndTruncate(raw: string): string {
  const outcome = sanitizeStudentText(raw)
  const text = outcome.text
  return text.length > REFRESH_MSG_MAX_CHARS ? text.slice(0, REFRESH_MSG_MAX_CHARS) + '…' : text
}

/**
 * 组持续概括的出网载荷。
 *
 * ★★ 出网边界（与五问版同一条红线，逐条对齐 `summarize-llm.ts` 的文件头）：
 *   ① 进载荷的只有**白名单键的画像快照** + **已脱敏的对话文本**，没有 image of 身份；
 *   ② **`displayName` 连本函数的入参都不存在** —— 真名的显示口径绝不进任何出网载荷
 *      （G-M-5）；这里刻意**不设** displayName 参数，让「不传」成为结构上的事实，
 *      而不是靠调用方自觉；
 *   ③ 助手文本也过 `sanitizeStudentText`（G-M-4）—— 它可能复述了学生的话；
 *   ④ 输出的 key 只能是 {@link REFRESH_ALLOWED_KEYS}，脏值逐条丢；
 *   ⑤ source 只能是 `observed` / `inferred`（解析侧再挡 `declared`）。
 */
export function buildRefreshPayload(input: RefreshPayloadInput): RefreshPayload {
  const turns = Array.isArray(input.turns) ? input.turns : []
  const known =
    input.knownTags.length > 0
      ? input.knownTags.map((item) => item.key + '=' + item.value).join('；')
      : '（无）'
  const protectedList =
    input.protectedKeys && input.protectedKeys.length > 0 ? input.protectedKeys.join('、') : ''

  // 每轮两行（学生 / 助手），轮次号从 1 开始编号（"第几轮"比内部 turn 号更好读）。
  const transcript = turns
    .map((turn, index) => {
      const ordinal = index + 1
      const student = sanitizeAndTruncate(turn.user)
      const assistant = sanitizeAndTruncate(turn.assistant)
      return (
        '[轮 ' + String(ordinal) + ']\n' +
        '  学生：' + (student === '' ? '（本轮学生没有说话）' : student) + '\n' +
        '  助手：' + (assistant === '' ? '（本轮助手没有回复）' : assistant)
      )
    })
    .join('\n')

  const system = [
    '你是学生画像的整理助手。',
    '输入是一位 K12 学生最近几轮的**真实对话**（学生的话与助手的回复，均已脱敏，',
    '不含真名、学校、班级、联系方式），以及他现在的画像标签。',
    '任务：从这段对话里，把**学生自己表现出的**偏好、兴趣、困扰，整理成结构化的画像标签，',
    '用来**持续修正与补充**他已有的画像。',
    '规则：',
    '1. 只输出一个 JSON 对象，形如 {"tags":[{"key":"interest_topic","value":"太空","confidence":0.6,"source":"observed"}]}，不要输出别的文字。',
    '2. key 只能是这些之一：' + REFRESH_ALLOWED_KEYS.join('、') + '。',
    '3. value 是中文短语，不超过 20 个字，**必须能在对话里找到依据**；没有依据的不要编。',
    '4. ★★ **每条标签都要判断来源（source）**：',
    '   · 学生**自己说过的**（他说喜欢什么、想怎么学、哪里卡住了）→ source = "observed"；',
    '   · 你**从他的表现里推出来的**（他没明说，是你根据他的反应猜的）→ source = "inferred"。',
    '   ⚠️ 用 inferred 时，key 只能取这 ' + String(REFRESH_INFERRED_KEYS.length) + ' 类：' + REFRESH_INFERRED_KEYS.join('、') + '。',
    '   属于别的维度（学科 / 兴趣 / 场景 / 目标 / 互动偏好…）时，**必须是他说过的**才能写，且用 observed。',
    '   ★ 想写学习类型（learner_style）时，值只能是这几个之一：' + LEARNER_STYLE_VALUES.join('、') + '；',
    '     只有从对话里**明确看出**他的学习倾向时才写，拿不准就不写。',
    '5. 拿不准的条目不要输出；最多 ' + String(REFRESH_MAX_TAGS) + ' 条；已经是现在画像里的标签不要重复输出。',
    '6. ★★ **助手的话不是学生的偏好**。助手说的话只帮你理解「学生那句话是在回应什么」，',
    '   绝不要把助手讲的知识点、给的例子、说的话当成学生的兴趣或偏好。',
    '7. 不要推断学生的心理状态、家庭情况或智能水平；不要因为他说了什么就给他下结论。',
    '   性格（personality）**可以记**，但值只能用这几个词：' + PERSONALITY_VALUES.join('、') + '；',
    '   要基于他在对话里的实际表现，不用任何医学或心理学术语。',
    '8. 不要输出真名、学校、班级、手机号、身份证号；不要输出任何情绪或心理判断。',
    '9. 宁可少写，不要为凑数而编。这一轮没发现值得更新的东西，就回 {"tags":[]}。'
  ].join('\n')

  const user = [
    '现在的画像（不必重复输出）：' + known,
    protectedList !== '' ? '★ 这几项是学生亲口说的，不要改写：' + protectedList : '',
    '最近几轮对话：',
    transcript === '' ? '（没有可用的对话）' : transcript
  ]
    .filter((line) => line !== '')
    .join('\n')

  return { system, user }
}

/* ------------------------------------------------------------------ *
 * 回执解析
 * ------------------------------------------------------------------ */

/** 一条解析出来的持续迭代标签（**source 只可能是 observed / inferred**）。 */
export interface RefreshTagWrite {
  key: string
  value: string
  source: 'observed' | 'inferred'
  confidence: number
}

/**
 * 解析模型回执（**宽松读、严格校验、脏值丢弃**，与 `parseSummaryTags` 同一条纪律）。
 *
 * ★ 相对五问版的四处收紧（每一条都对应一个红线）：
 *   ① 输出**必须**带合法的 `source`：
 *        · `declared` → **直接丢掉**（概括无权产出学生自述，G-M-1 的另一半）；
 *        · 认不出 / 省缺 → 丢（**不兜底成 observed**：兜底会让"没声明来源"静默变成
 *          "学生说过的"，那是把最需要甄别的信息默认成最高可信度）；
 *        · `inferred` 但 key 不在 {@link REFRESH_INFERRED_KEYS} → 丢（禁做 #10 在解析侧生效）。
 *   ② 上限 {@link REFRESH_MAX_TAGS}（超出只取前 N 条，**不补位**，G-M-8）。
 *   ③ 同 key 重复留第一条。
 *   ④ key 不在 {@link REFRESH_ALLOWED_KEYS} → 丢。
 *   ⑤ **维度 13 的两个键值必须在封闭词表内**（2026-09-30）：`learner_style` 与
 *      `personality` 的候选值不在词表 → 丢。性格那一键是**红线移动的那道闸**
 *      （越界的医学/心理学词在这里就被挡住，与后端 `upsert_tag` 的取值域校验
 *      同源判据、两处落点 —— 与 `inferred` 限键同一条纵深防御纪律）。
 *
 * ⚠️ 为什么 `inferred` 的限键校验也放这里（后端已经挡了）：这是**纵深防御**。
 *   后端挡的是「最终写不进去」，这里挡的是「根本不给它机会写」——
 *   而且这里挡住之后日志里能看出「模型试图用 inferred 写 interest_topic」，
 *   那是 prompt 需要改进的信号（后端只看到一个 422）。两处判据同源（同一个键集）。
 */
export function parseRefreshTags(raw: string): RefreshTagWrite[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const stripped = raw.replace(/```(?:json)?/gi, ' ')
  const matched = /\{[\s\S]*\}/.exec(stripped)
  if (!matched) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(matched[0])
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const list = Array.isArray(record.tags) ? record.tags : []
  const out: RefreshTagWrite[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const key = typeof entry.key === 'string' ? entry.key.trim() : ''
    const value =
      typeof entry.value === 'string' ? entry.value.trim().slice(0, REFRESH_MAX_VALUE_CHARS) : ''
    if (value === '') continue
    if (!REFRESH_ALLOWED_KEYS.includes(key)) continue
    // ★★ 维度 13（2026-09-30）：两个新键的值必须是**封闭词表里的中文词**。
    //   性格那一键是红线移动的闸：越界的医学/心理学词在这里就丢掉，不给它机会写库。
    if (key === 'personality' && !PERSONALITY_VALUE_SET.has(value)) continue
    if (key === 'learner_style' && !LEARNER_STYLE_VALUE_SET.has(value)) continue
    // ★ source 必须显式且合法：declared 一律拒（概括无权产出学生自述）
    const source = typeof entry.source === 'string' ? entry.source.trim().toLowerCase() : ''
    if (source !== 'observed' && source !== 'inferred') continue
    // ★ inferred 的限键（禁做 #10）
    if (source === 'inferred' && !REFRESH_INFERRED_KEYS.includes(key)) continue
    if (out.some((own) => own.key === key)) continue
    const rawConfidence = typeof entry.confidence === 'number' ? entry.confidence : Number(entry.confidence)
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : REFRESH_DEFAULT_CONFIDENCE
    out.push({ key, value, source, confidence })
    if (out.length >= REFRESH_MAX_TAGS) break
  }
  return out
}
