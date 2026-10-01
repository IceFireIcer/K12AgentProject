/**
 * 画像标签的**白名单投影**（票 25 地基）—— 全项目唯一的「模型能看见什么」的真相。
 *
 * ★★ 这个文件是整套方案的**安全边界本体**（执行报告 §0.6）：模型**只能**看见
 *   LLM_VISIBLE_TAGS 里那 25 个结构化标签值；不在里面的字段**没有出口** ——
 *   （★ 计数以本文件的实际成员为准：集成期发现原计划写的「26」是错的，真源就是 25。）
 *   不是「被过滤掉」，是「压根拼不进 prompt」。
 *
 * ## 为什么是白名单而不是黑名单
 *
 * v2 的做法是发模型前用正则过滤敏感词。那是**黑名单思路**，只能挡「已知要挡的模式」：
 * 「小明，五年级，我在 XX 小学二班」里的「XX 小学二班」未必命中任何正则，
 * 但那是学生没同意外传的东西。白名单是**白名单思路** —— 没被显式允许的，一个字节都出不去。
 * 它同时让「不漏」这件事**可审计**：本文件就是一个常量，能直接写守卫。
 *
 * ## 两张表物理隔离（后端迁移 v5）
 *
 * | 表 | 装什么 | 出口 |
 * | --- | --- | --- |
 * | identity_local | 真名 / 精确年级 / 学校 / 班级 / 两道闸 / 引导流程状态 | **无出口函数**（代码里不存在「读它再拼 prompt」这条路径） |
 * | profile_tags | 结构化标签，key 必须是本文件的 tag | 只经 profile-block 的投影函数 |
 *
 * ## ⚠️ 与执行报告 §0.6.6 G-B 的一处口径修正（Lead 裁决）
 *
 * 报告里 G-B 写的是「identity_local 的**任何列**都不在白名单里（两张表永不重叠）」，
 * 但 §0.6.2 的 DDL 把 anon_student_id 放进了 identity_local，§0.6.3 的白名单里
 * 又**包含** anon_student_id —— 两句话互相矛盾。
 *
 * 裁决：anon_student_id 是**两表共有的那把 join 钥匙**，它本身不是身份信息
 * （它就是个随机串，模型看到它也无从还原任何真人）。G-B 的准确表述是：
 * **除 anon_student_id 这把 join 钥匙外，identity_local 的任何身份列都不在白名单里。**
 * 守卫按这个口径写，IDENTITY_LOCAL_FIELDS 与 LLM_VISIBLE_TAGS 的差集必须恰好是
 * 「除 anon_student_id 以外的全集」—— 这条断言本身就把 join 钥匙钉住了。
 */

/* ------------------------------------------------------------------ *
 * 白名单：模型可见的标签键
 * ------------------------------------------------------------------ */

/**
 * ★ **唯一真相**。新增一个标签必须先在这里显式加一行，**没加就出不了网**
 *   （这正是我们要的性质：新增是显式动作，不是「忘了过滤」的意外）。
 *
 * 📌 与执行报告 §0.6.3 的对照：报告列了 24 个键，另有 prerequisite /
 *   hint_dependency / long_term_goal / adult_help_needed 属 v2 档（MVP 之外）。
 *   **白名单是「允许的集合」，不是「已产出的集合」** ——
 *   键在白名单里但库里没有行，等价于「没这个标签」，不构成漏洞。
 *   所以这里保留全集，让后续票落地时不需要改边界。
 */
export const LLM_VISIBLE_TAGS = [
  'anon_student_id',
  // 维度 2：学段与课程
  'grade_band',
  'subject',
  'course_module',
  'current_topic',
  // 维度 3：AI 通识知识掌握
  'knowledge_point',
  'mastery',
  // 维度 4：错误模式与最近发展区
  'error_type',
  'zpd_level',
  // 维度 7：学习偏好
  'explain_style',
  'output_length',
  'pace',
  'practice_type',
  // 维度 8：兴趣类比
  'interest_topic',
  // 维度 9：短期情绪与动机
  'emotion',
  'intensity',
  'trigger',
  'confidence',
  // 维度 10：交互偏好
  'tone',
  'encouragement_freq',
  'challenge_level',
  // 维度 11：场景与目标
  'scene',
  'task_goal',
  // 维度 12：安全边界与反馈
  'safety_level',
  'boundary_topics',
  // 维度 13：学习类型与性格（2026-09-30 新增，见下方「维度 13」一节）
  'learner_style',
  'personality'
] as const

/** 白名单键的联合类型。写 profile_tags 的 key 只能是它。 */
export type LlmVisibleTag = (typeof LLM_VISIBLE_TAGS)[number]

/** 运行期集合形态（做守卫 / 做过滤时用这个，**不要**重新 includes，避免 O(n) 又漏拼写）。 */
export const LLM_VISIBLE_TAG_SET: ReadonlySet<string> = new Set(LLM_VISIBLE_TAGS)

/** 某个键是不是模型可见的。**写入端与 prompt 拼装端都要过这一道。** */
export function isLlmVisibleTag(key: string): key is LlmVisibleTag {
  return LLM_VISIBLE_TAG_SET.has(key)
}

/* ------------------------------------------------------------------ *
 * 本地身份层：永不过桥
 * ------------------------------------------------------------------ */

/**
 * identity_local 表的列（后端迁移 v5）。★ **一个都不进 prompt。**
 *
 * parent_consent / memory_switch 是**闸**不是**信息**：主进程读它们决定行为
 * （不同意不外发、关掉就不写标签），但它们本身**不告诉模型任何事**。
 */
export const IDENTITY_LOCAL_FIELDS = [
  'anon_student_id',
  'real_name',
  'real_grade',
  'school',
  'class',
  'parent_consent',
  'memory_switch',
  'onboarding_state'
] as const

export type IdentityLocalField = (typeof IDENTITY_LOCAL_FIELDS)[number]

/**
 * ★ **两张表唯一共有的那把 join 钥匙**（见文件头 G-B 口径修正）。
 *   它是随机串，模型看到它也无从还原任何真人，所以允许可见；
 *   **除它以外，identity_local 的任何列都不得出现在白名单里。**
 */
export const JOIN_KEY: LlmVisibleTag = 'anon_student_id'

/**
 * 身份列里**绝不可见**的那些（= 差集，后端守卫 G-B 直接断言它等于这个集合）。
 * 写成常量而不是测试里内联，是为了让「白名单加了某个敏感字段」这类事故
 * 在**两个方向**上都能被发现：白名单加它、或这个集合漏它。
 */
export const IDENTITY_LOCAL_FORBIDDEN: ReadonlySet<string> = new Set(
  IDENTITY_LOCAL_FIELDS.filter((field) => field !== JOIN_KEY)
)

/* ------------------------------------------------------------------ *
 * 短期情绪：TTL 是红线实现，不是优化
 * ------------------------------------------------------------------ */

/**
 * ★ **短期情绪标签**（执行报告 §0.6.5）。这三个**必须**带过期时间：
 *   把一个孩子「上次考试崩了、情绪低落」长期记着，既伤人也可能被用来**操控**他
 *   —— 这是禁做清单第 11 条「长期负面情绪档案」的实现。
 *
 * ⚠️ 读取时：任一条超过 TTL → **当作不存在**（不是降权、不是打折，是读不到）。
 *   守卫 G-E 会断言「写入很久之后这三个键读不出来」。
 */
export const EPHEMERAL_TAGS = ['emotion', 'intensity', 'trigger'] as const

export type EphemeralTag = (typeof EPHEMERAL_TAGS)[number]

export const EPHEMERAL_TAG_SET: ReadonlySet<string> = new Set(EPHEMERAL_TAGS)

/** 情绪标签的 TTL：**3 轮会话**或 **24 小时**，取先到（执行报告 §0.6.5 建议值）。 */
export const EPHEMERAL_TTL_TURNS = 3
export const EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------------ *
 * 禁做清单 #12：情绪的取值域是有限枚举，**不是**临床词汇
 * ------------------------------------------------------------------ */

/**
 * ★ 之所以**枚举**而不是自由文本：自由文本会让「我最近有点抑郁」原样进库，
 *   那就从「记录情绪」变成了**心理诊断**（禁做清单第 12 条）。
 *   任何不在这个集合里的候选值一律回落，不允许出现临床词汇。
 */
export const EMOTION_VALUES = ['happy', 'calm', 'confused', 'frustrated', 'angry'] as const

export type EmotionValue = (typeof EMOTION_VALUES)[number]

export const EMOTION_VALUE_SET: ReadonlySet<string> = new Set(EMOTION_VALUES)

/** 情绪的中文名（渲染层直接用，**不要**在组件里另写一份映射）。 */
export const EMOTION_LABELS: Readonly<Record<EmotionValue, string>> = {
  happy: '开心',
  calm: '平静',
  confused: '困惑',
  frustrated: '沮丧',
  angry: '生气'
}

/** 情绪强度：0–3 的小整数（**不是** 0–100 的分 —— 分值会诱发「优化分数」的坏文化）。 */
export const INTENSITY_MIN = 0
export const INTENSITY_MAX = 3

/* ------------------------------------------------------------------ *
 * 维度 13：学习类型与性格（2026-09-30 用户裁决）
 * ------------------------------------------------------------------ */

/**
 * ★★ 这一节的存在本身就是一次**红线移动的记录**（决策日 2026-09-30）。
 *
 * 既有禁做红线原文：「不要推断学生的**性格、心理状态、家庭情况或智能水平**」。
 * 本轮用户裁决：**允许 AI 推断「性格」单一维度**（用于学习档案的展示行）。
 * 落地口径 = **最小移动原则** —— 只放开 `personality` 一个键，其余三条禁令
 * （心理状态 / 家庭情况 / 智能水平）**原样保留**，守卫 G-M-7 改写而非删除
 * （三条新断言钉死「只放开了性格」）。
 *
 * ★ 为什么两个词表都必须**封闭枚举**（与 {@link EMOTION_VALUES} 同一条纪律）：
 *   自由文本会把「我最近有点抑郁」这类话原样进库 —— 那就从「记录特征」变成了
 *   **心理诊断**（禁做清单第 12 条）。任何不在词表里的候选值一律拒绝，不允许
 *   出现医学 / 心理学术语。性格这一维尤其重要：它是本轮新开的口子，词表是那道闸。
 *
 * ★ 与后端 `learning.py` 的 `LEARNER_STYLE_VALUES` / `PERSONALITY_VALUES`
 *   **逐字一致**（判据唯一、落点两处的既有纪律）；两处都在写入侧硬校验，
 *   越界值直接 ValueError / 解析侧丢弃。
 */

/**
 * 学习类型（`learner_style`）的封闭词表。
 *
 * ★ 两条写入路径（分档矩阵天然仲裁，见 `learning.py` 的 `sync_learner_style`）：
 *   · **规则投影**（`observed`，`origin=projection`）—— 后端按学习数据判定，权威；
 *   · **持续概括**（`inferred`，`origin=refresh`）—— LLM 从对话里判断，候补。
 *   `observed` 不被 `inferred` 覆盖 → 规则判定的结果模型推不翻；
 *   数据不足时 `inferred` 先占位，规则一旦能判就升级为 `observed`（零新代码）。
 *
 * ⚠️ 值是**中文**、也是**显示值**（与 `OBSERVED_ERROR_TYPES` 同一条纪律）：
 *   它要进画像卡给学生看，所以库里存的就是给人看的那几个字，封闭性由本常量保证。
 * ⚠️「均衡型」在词表里但**规则不主动打**（数据充分且各特征都不显著时宁可不写，
 *   不把「没看出来」冒充成「观察到了」—— 与「还没练过」不写占位值同一条纪律）。
 */
export const LEARNER_STYLE_VALUES = ['天赋型', '努力型', '钻研型', '速通型', '均衡型'] as const

export type LearnerStyleValue = (typeof LEARNER_STYLE_VALUES)[number]

export const LEARNER_STYLE_VALUE_SET: ReadonlySet<string> = new Set(LEARNER_STYLE_VALUES)

/**
 * 性格（`personality`）的封闭词表 —— **中性、口语、无临床色彩**。
 *
 * ★ 选词的三个约束（改词表前先读完）：
 *   ① 无医学 / 心理学色彩（「多动」「焦虑型」这类词一个都不许进来）；
 *   ② 是**学生自己也能读懂并认同**的日常说法（这一栏是要给他本人看的）；
 *   ③ 不评价能力高低（那是 `learner_style` 的事，且「聪明 / 笨」这类词永远不进本表）。
 */
export const PERSONALITY_VALUES = [
  '开朗',
  '安静',
  '好奇',
  '沉稳',
  '细心',
  '勇敢',
  '急性子',
  '慢性子',
  '爱提问',
  '爱琢磨'
] as const

export type PersonalityValue = (typeof PERSONALITY_VALUES)[number]

export const PERSONALITY_VALUE_SET: ReadonlySet<string> = new Set(PERSONALITY_VALUES)

/* ------------------------------------------------------------------ *
 * 引导（对话式五问）的流程状态
 * ------------------------------------------------------------------ */

/**
 * ★★ 引导的触发与终态（票 31，2026-09-29 用户裁决）：
 *
 * · **唯一终态是 done** —— 五问答完才算结束；
 * · **not_started / in_progress / skipped 都要问**：没答完就续问（跨重启也续）。
 *   历史库里落了 `skipped` 的学生（跳过入口已全链路删除，新数据不再产生它）
 *   按「没答完」处理；
 * · 明确**不**作为触发依据的（v2/v4 都用过，全推翻）：
 * · 画像是否为空 —— 学生之后手动改了学段/偏好，画像本来就会「不空」，但**不该重问**；
 * · grade.get 的 source 是否 explicit —— 手动定过学段 ≠ 需要重问五问；
 * · 是不是新会话 —— 五问**只跟学生走**，不跟会话走；
 * · 装机时间 / localStorage —— 本地 DB 里已经有权威状态，不该再有第二份。
 */
export const ONBOARDING_STATES = ['not_started', 'in_progress', 'done', 'skipped'] as const

export type OnboardingState = (typeof ONBOARDING_STATES)[number]

export const ONBOARDING_STATE_SET: ReadonlySet<string> = new Set(ONBOARDING_STATES)

/** 引导的**唯一终态**：到了它就永不再问；其余三态（含历史 skipped）都要把没答完的问完。 */
export const ONBOARDING_DONE_STATE: OnboardingState = 'done'

/**
 * 流程的初始态（identity_local.onboarding_state 的 DEFAULT 同值；脏值回落也用它）。
 * ★ 它**不是**触发判据 —— 触发判据是「未到终态」（见 {@link ONBOARDING_DONE_STATE}）。
 */
export const ONBOARDING_INITIAL_STATE: OnboardingState = 'not_started'

/* ------------------------------------------------------------------ *
 * 五问本身（渲染层 / 主进程共用同一份脚本，不各写一份）
 * ------------------------------------------------------------------ */

export const ONBOARDING_QUESTION_IDS = ['q1', 'q2', 'q3', 'q4', 'q5'] as const

export type OnboardingQuestionId = (typeof ONBOARDING_QUESTION_IDS)[number]

/** 一问的形态：`chips` 非空 = 带可点选项（点一下**直接提交**，见下）。 */
export interface OnboardingQuestionSpec {
  id: OnboardingQuestionId
  /** ★ 问句就是一条**普通助手消息**（不是卡片）—— 决策①「混进对话正文」。 */
  text: string
  /** 可点选项；空数组 = 纯自由输入（学生自己写）。 */
  chips: readonly string[]
}

/**
 * ★ 五个问句。**唯一一份** —— 主进程算 pendingQuestionId、渲染层渲染、测试断言
 *   都从这里读（同一份脚本三处各写一遍，迟早会漂）。
 *
 * ★★ 只有**第 1 问**带选项（2026-09-30 用户裁决）：年级是唯一一个「闭集」问题，
 *   点一下比打字快；其余四问（想学什么 / 喜欢怎么讲 / 快慢 / 课外兴趣）**必须学生自己写** ——
 *   给选项等于替他把话说了，而画像要的正是他自己的说法。
 *
 * ★★ 2026-10-01 换题（q5）：原问句是「我该怎么称呼你」—— **称呼已由账号门负责**
 *   （建号 / 改名那条路），五问里再问一次等于同一个门出现两遍；现改为补**兴趣 / 动机**
 *   这一维（落到 `interest_topic`），与 q1 学段、q2 学科兴趣、q3 讲法、q4 节奏一起，
 *   五问各覆盖一个不同的画像维度。
 *   ★ **新题明确不收集姓名 / 称呼**（那是账号门的职责，见上），只收兴趣 / 动机这一维。
 *   措辞口径：口语、开放、可自由作答；**不得引向心理侧写**（禁做清单第 10~14 条）。
 *
 * ⚠️ Q1 的点选**当场写学段**（决策②走 explicit，立即生效 + 10 轮冷却），
 *   不等任何后端概括。
 */
export const ONBOARDING_QUESTIONS: readonly OnboardingQuestionSpec[] = [
  {
    id: 'q1',
    text: '你现在上几年级呀？',
    chips: ['小学低年级', '小学高年级', '初中', '高中']
  },
  { id: 'q2', text: '最近在学什么呀？有没有特别想搞懂的？', chips: [] },
  { id: 'q3', text: '我讲的时候，你更喜欢哪种方式？', chips: [] },
  { id: 'q4', text: '想讲快一点还是慢一点？', chips: [] },
  { id: 'q5', text: '除了学习，你平时还喜欢琢磨什么？', chips: [] }
]

/** 第 N 问（0 基）之后还剩几问 —— 渲染层显示进度用。 */
export function remainingOnboarding(answeredCount: number): number {
  return Math.max(0, ONBOARDING_QUESTIONS.length - answeredCount)
}

/* ------------------------------------------------------------------ *
 * 家长同意（决策：**B = 默认同意，家长可在设置页关**）
 * ------------------------------------------------------------------ */

/**
 * ★ 本轮用户裁决：**默认同意**，家长可在设置页关（执行报告 §8② 的选项 B）。
 *
 * 「默认同意」的风险由三道闸兜住（而不是靠默认值本身）：
 * ① 学生随时可在设置页一键关闭，关闭后 memory_switch=0 → **不写任何标签**（G-F）；
 * ② parent_consent=0 → **不外发任何画像**（G-G）—— 默认同意，但一旦被关掉立刻生效；
 * ③ 真名 / 精确年级 / 学校 / 班级**永远**不在白名单里 —— 它关不关都出不去（G-B）。
 * 换句话说：默认同意买的是「冷启动前 30 秒不被家长同意流程拦住」，
 * 真正的隐私边界**不依赖**这个默认值。
 */
export const PARENT_CONSENT_DEFAULT = true

/** 学生面称呼的回落值（落库的称呼被脱敏判定不可用、或学生还没给过称呼时的统一回落）。 */
export const STUDENT_FALLBACK_NAME = '同学'
