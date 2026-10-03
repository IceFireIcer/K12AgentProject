/**
 * 演示沙箱的**预置学生态数据**：纯数据 + 纯函数（无 IO、无副作用，可单测）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个文件里放什么、不放什么
 * ══════════════════════════════════════════════════════════════════════════
 * 只放**学生态**（这个人用过的痕迹）：画像 / 掌握度 / 闯关进度 / 学习报告 / 错题 /
 * 章节进度 / 会话列表 / 动画库 / 生成题 / 学段状态 / 设置显示态。
 * **内容态一律不放**——题库 / 代码模板 / 动画模板 / 知识库统计仍然走真实资产：
 * 内容态一旦被假掉，演示里就会出现「假题目配假答案」这种一戳就破的东西。
 * （下面出现的中文知识点名与依赖边是**内容态的只读快照**：图谱与错题本两条响应体
 *   在结构上必须自带它们，而覆盖层拿不到 `kb.sqlite`——逐字抄自随包资产的同一份值。）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 四条纪律（改动前先读，每一条都有单测或守卫盯着）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **每个数字必须互相解释得通**：日活之和 = 活动总数、报告里的答题对错与错题本同源、
 *      徽章与进度行同源、`stageCounts` 与进度行同源、各章 kp 数合计 = 该学段真实 kp 数。
 *      改任何一个数，都要把同一组里的其它数一起改（`tests/demo-seed.test.ts` 逐条断言）。
 *   ② **每个 kp_id 与章节名都真实存在**（逐字取自随包 `kb.sqlite`）：界面上一出现
 *      「未命名知识点」，演示的可信度就少一分。57 这个数是**算出来的**
 *      （`DEMO_KP_IDS.length`），不是写死的字面量。
 *   ③ **相对时间一律现算**（`Date.now() - agoMs`），不写死任何时间戳：
 *      什么时候点开都该像「刚刚还在用」。
 *   ④ **学生可见文本里不出现「演示 / 回放 / 预置 / 假数据 / demo」字样**：
 *      界面里除了那颗按钮本身不该有任何标注（无痕口径）；本文件的注释不受此限。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 谁读它
 * ══════════════════════════════════════════════════════════════════════════
 *   · `main/demo/overlay.ts`  —— 把这里的返回值当 HTTP JSON 响应体合成给 `apiFetch`；
 *   · `main/demo/animation.ts` —— 动画库那条的**渲染目标**（`kpId` / `payloadId` 的来源）；
 *   · `main/ipc/handlers.ts`  —— 章节指示器与会话列表那两个处理器；
 *   · `main/demo/script.ts`   —— 三条历史会话的 id 与标题（脚本与卡片共用同一份）；
 *   · `tests/demo-seed.test.ts` —— 直接 import 本文件做自洽断言（**不碰 Electron**）。
 *
 * ⚠️ 出参一律 `Record<string, unknown>`：形状由 `server/app/contracts.py` 的 pydantic 定，
 *    这里不抄第二份 TS 接口（与 `main/wire/data.ts` 的搬运工哲学一致）；
 *    所有键一律 **camelCase**（服务端 `CamelModel` 的出参形态）。
 * ⚠️ 纯函数：不读写文件、不发网络、不引 Node 内建模块，只碰 `Date.now()` 与 `new Date()`。
 */

/* ------------------------------------------------------------------ *
 * 基础常量
 * ------------------------------------------------------------------ */

/** 高中（本沙箱使用的学段）。 */
export const DEMO_GRADE_LEVEL = 'senior'

/**
 * 学生昵称（**唯一一处真相**：学生响应体、画像、报告、身份层都引它，不许两处各写一遍）。
 *
 * ★★ 2026-10-03：它同时是**演示里学生对外的名字** —— 称呼/头像/问候语/画像全走它。
 *   身份层（{@link demoIdentityBody} 的 `displayName`）也从这里取，
 *   这样"侧栏说小同、画像说另一个人"这件事不会再发生。
 * ★ 为什么不用真实感更强的姓名（如"范思远"）：那是**本机真实学生的名字**，
 *   演示里出现真实姓名是泄漏（见 demoIdentityBody 的说明）。
 *   「小同」与品牌「智团团」同源、一看就是预置身份，也避免了误认。
 */
export const DEMO_STUDENT_NICKNAME = '小同'

/** 学生 id（白名单字符集，与 `student_id` 同形；不采集任何真实身份信息）。 */
const DEMO_STUDENT_ID = 'student_001'

/** 学生当前在学的章节（= 真实章名之一；学生响应体与章节响应体都引它）。 */
export const DEMO_CHAPTER_TITLE = '第3章 核心技术分支'

/* ------------------------------------------------------------------ *
 * 相对时间的尺度（**只用来把时间往前推，不写死任何时间戳**）
 * ------------------------------------------------------------------ */

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/* ------------------------------------------------------------------ *
 * 教材：8 章 × 57 个初中知识点
 * ------------------------------------------------------------------ */

/**
 * 高中教材的**全部知识点**（逐字来自随包 `kb.sqlite` 的 `kp` 表）。
 *
 * - 章的**顺序 = 教材定义序**（第 1 章 → 第 8 章，与服务端解析「第N章」里那个 N 同口径）；
 * - 每章内**按 `kp_id` 排**（服务端 `chapters_by_grade` 就是 `ORDER BY kp_id`，
 *   不是入库顺序——入库顺序随文件名变化，同章的列表会无缘无故重排）；
 * - 第 8 章的键**引 `DEMO_CHAPTER_TITLE`**：章节名一旦要改，只改那一处。
 */
export const DEMO_CHAPTER_KP_IDS: Readonly<Record<string, readonly string[]>> = {
  '第1章 人工智能的基础概念': [
    'ai-definition-sr',
    'ai-hierarchy-sr',
    'ai-three-values-sr',
    'genai-sr',
    'narrow-ai-sr',
    'strong-ai-agi-sr'
  ],
  '第2章 人工智能三大底层支柱(AI的构造地基)': [
    'algorithm-sr',
    'computing-power-sr',
    'data-processing-sr',
    'data-sr',
    'hardware-accelerator-sr',
    'training-inference-sr'
  ],
  [DEMO_CHAPTER_TITLE]: [
    'artificial-neuron-sr',
    'computer-vision-sr',
    'deep-learning-sr',
    'machine-learning-sr',
    'neural-network-sr',
    'nlp-sr',
    'reinforcement-learning-sr',
    'speech-recognition-sr',
    'speech-synthesis-sr',
    'supervised-learning-sr',
    'token-sr',
    'transformer-sr',
    'unsupervised-learning-sr'
  ],
  '第4章 大模型与AI智能体Agent': [
    'agent-action-sr',
    'agent-perception-sr',
    'agent-planning-sr',
    'agent-reflection-sr',
    'agent-tool-use-sr',
    'llm-sr',
    'long-term-memory-sr',
    'prompt-sr',
    'rag-sr',
    'short-term-memory-sr'
  ],
  '第5章 人工智能主要应用领域': [
    'aigc-media-sr',
    'autonomous-driving-sr',
    'edu-agent-sr',
    'edu-mistake-review-sr',
    'edu-notes-mindmap-sr',
    'edu-preview-review-sr',
    'edu-qa-sr',
    'industrial-inspection-sr',
    'medical-imaging-sr',
    'voice-assistant-sr'
  ],
  '第6章 人工智能的局限性': [
    'limit-hallucination-sr',
    'limit-interaction-sr',
    'limit-knowledge-cutoff-sr',
    'limit-teaching-sr',
    'limit-understanding-sr'
  ],
  '第7章 人工智能伦理与安全': [
    'ethics-anti-misuse-sr',
    'ethics-fairness-sr',
    'ethics-information-sr',
    'ethics-privacy-sr'
  ],
  '第8章 编程实践（补充）': ['prog-list-sr', 'prog-loop-sr', 'prog-variable-sr']
}

/** 全学段知识点 id（**57 这个数就是这么算出来的**，不是写死的常量）。 */
const DEMO_KP_IDS: readonly string[] = Object.values(DEMO_CHAPTER_KP_IDS).flat()

/** 该学段的真实知识点数（闯关进度条数 / 节点数都必须等于它）。 */
export const DEMO_KP_COUNT: number = DEMO_KP_IDS.length

/** `kp_id → 章标题`（由上面那张表反推，**不写第二份「谁属于哪一章」的真相**）。 */
const DEMO_CHAPTER_OF_KP: Readonly<Record<string, string | undefined>> = (() => {
  const table: Record<string, string> = {}
  for (const [chapterTitle, kpIds] of Object.entries(DEMO_CHAPTER_KP_IDS)) {
    for (const kpId of kpIds) table[kpId] = chapterTitle
  }
  return table
})()

/** `kp_id → 中文名`（逐字来自 `kb.sqlite` 的 `kp.name`；界面直接显示，不许改写）。 */
const DEMO_KP_NAME_BY_ID: Readonly<Record<string, string | undefined>> = {
  // 第 1 章
  'ai-definition-sr': '人工智能的定义',
  'ai-hierarchy-sr': 'AI 技术的包含层级关系',
  'ai-three-values-sr': '模拟、延伸、扩展：AI 的三层价值',
  'genai-sr': '生成式大模型（GenAI）',
  'narrow-ai-sr': '弱人工智能（专用 AI）',
  'strong-ai-agi-sr': '强人工智能（AGI）',
  // 第 2 章
  'algorithm-sr': '算法',
  'computing-power-sr': '算力',
  'data-processing-sr': '数据处理流程',
  'data-sr': '数据',
  'hardware-accelerator-sr': '硬件载体：GPU / CPU / TPU',
  'training-inference-sr': '训练阶段与推理阶段',
  // 第 3 章
  'artificial-neuron-sr': '人工神经元',
  'computer-vision-sr': '计算机视觉（CV）',
  'deep-learning-sr': '深度学习（DL）',
  'machine-learning-sr': '机器学习（ML）',
  'neural-network-sr': '神经网络',
  'nlp-sr': '自然语言处理（NLP）',
  'reinforcement-learning-sr': '强化学习',
  'speech-recognition-sr': '语音识别（ASR）',
  'speech-synthesis-sr': '语音合成（TTS）',
  'supervised-learning-sr': '监督学习',
  'token-sr': 'Token',
  'transformer-sr': 'Transformer 架构',
  'unsupervised-learning-sr': '无监督学习',
  // 第 4 章
  'agent-action-sr': '执行模块',
  'agent-perception-sr': '感知模块',
  'agent-planning-sr': '规划模块',
  'agent-reflection-sr': '反思模块',
  'agent-tool-use-sr': '工具调用模块',
  'llm-sr': '大语言模型（LLM）',
  'long-term-memory-sr': '长期记忆',
  'prompt-sr': 'Prompt 提示词',
  'rag-sr': 'RAG 检索增强生成（外挂知识库）',
  'short-term-memory-sr': '短期记忆',
  // 第 5 章
  'aigc-media-sr': '文生图 / 文生视频（AIGC）',
  'autonomous-driving-sr': '自动驾驶',
  'edu-agent-sr': 'AI 教育智能体',
  'edu-mistake-review-sr': '错题复盘',
  'edu-notes-mindmap-sr': '自动生成讲义、思维导图',
  'edu-preview-review-sr': '预习复习',
  'edu-qa-sr': '智能答疑',
  'industrial-inspection-sr': '工业质检',
  'medical-imaging-sr': '医疗影像识别',
  'voice-assistant-sr': '语音助手',
  // 第 6 章
  'limit-hallucination-sr': '模型幻觉',
  'limit-interaction-sr': '交互短板',
  'limit-knowledge-cutoff-sr': '知识截止',
  'limit-teaching-sr': '教学短板（难自动分层适配）',
  'limit-understanding-sr': '理解局限',
  // 第 7 章
  'ethics-anti-misuse-sr': '防滥用：防止学生直接抄答案',
  'ethics-fairness-sr': '公平性：面向不同人群适配',
  'ethics-information-sr': '信息真实性校验',
  'ethics-privacy-sr': '用户隐私保护（学生学习数据）',
  // 第 8 章
  'prog-list-sr': '列表与字典：把一批数据放在一起',
  'prog-loop-sr': '循环：重复的事交给机器',
  'prog-variable-sr': '变量：给数据起名字'
}

/**
 * 取知识点中文名（查不到时**退化成 kp_id**——与服务端「绝不把 kp slug 推给界面」
 * 相反的那条只在库里真没有名字时才会走到，真实资产里每个 kp 都有名字）。
 */
function demoKpName(kpId: string): string {
  return DEMO_KP_NAME_BY_ID[kpId] ?? kpId
}

/** 取知识点所属章标题（查不到时空串，与契约默认值一致）。 */
function demoChapterOf(kpId: string): string {
  return DEMO_CHAPTER_OF_KP[kpId] ?? ''
}

/* ------------------------------------------------------------------ *
 * 历史会话（侧栏「历史对话」）
 * ------------------------------------------------------------------ */

/**
 * 三条预置会话的 id（脚本与卡片都引它们，不要在别处再写一遍字面量）。
 *
 * ★ 形态与真实会话 id 无关（它由 Pi 给），覆盖层与处理器只把它当**不透明字符串**：
 *   `session:open` 的沙箱分支认这三个值来回放对应的预置问答。
 */
export const DEMO_LOOP_SESSION_ID = 'sess-ml-9c41'
/**
 * 上一条的**语义化别名**：这条会话讲的是神经网络（回看时带一张动画卡）。
 *
 * ★ 旧名 `DEMO_LOOP_SESSION_ID` 是从上一版（初中「循环是怎么工作的」）沿用的，
 *   而它现在与另外两条一样只是「一条带卡片的预置会话」——留旧名是因为它出现在
 *   `script.ts` 与守卫里多处，改名只会换来一次无收益的机械替换；
 *   新写的代码（尤其是读起来要看语义的地方）用这个名字。
 */
export const DEMO_NEURAL_SESSION_ID = DEMO_LOOP_SESSION_ID
/** 「监督学习为什么要带答案」那条会话的 id（三条里唯一带编程卡的一条）。 */
export const DEMO_CODE_SESSION_ID = 'sess-sup-7b25'
/** 「梯度下降学太小学了，是初中讲的吗」那条会话的 id（回看时带一张动画卡）。 */
export const DEMO_QUIZ_SESSION_ID = 'sess-gd-3e08'

/**
 * 预置的 3 条历史会话（侧栏「历史对话」用）。
 *
 * ★ `agoMs` 是**相对「现在」往前推的毫秒数**，不是时间戳：什么时候点开都像刚用过。
 * ★ `messageCount` 与 `main/demo/script.ts` 里那两条预置消息**必须一样多**
 *   （那条路回看时给几条消息，列表上就显示几条）。
 */
export const DEMO_SESSIONS: readonly {
  id: string
  title: string
  messageCount: number
  /** 相对「现在」往前推的毫秒数（**不要写死时间戳** —— 演示什么时候都该像刚用过）。 */
  agoMs: number
}[] = [
  { id: DEMO_LOOP_SESSION_ID, title: '神经网络到底长什么样', messageCount: 6, agoMs: 26 * HOUR_MS },
  { id: DEMO_CODE_SESSION_ID, title: '监督学习为什么要带答案', messageCount: 6, agoMs: 25 * HOUR_MS },
  { id: DEMO_QUIZ_SESSION_ID, title: '梯度下降学太小学了，是初中讲的吗', messageCount: 6, agoMs: 2 * HOUR_MS }
]

/**
 * 每条会话的**首条消息预览**（列表那一列显示的就是它）。
 *
 * ★ 与 `main/demo/script.ts` 里三句学生原话是同一份文案：两处各写一句的话，
 *   「列表上看到的开头」与「点进去看到的第一句」迟早不是同一句。
 * ★ 每个会话的创建时间比最后修改时间早一点（一条两句话的会话不会持续几小时）。
 */
const DEMO_SESSION_PREVIEWS: Readonly<Record<string, string | undefined>> = {
  [DEMO_LOOP_SESSION_ID]: '训练的时候，它怎么知道该往哪儿调？',
  [DEMO_CODE_SESSION_ID]: '我觉得我会了这个知识点。',
  [DEMO_QUIZ_SESSION_ID]: '机器学习到底是什么？和普通程序有什么不一样？'
}

/** 会话「创建 → 最后修改」之间的跨度（两句话的会话，分钟级）。 */
const DEMO_SESSION_SPAN_MS = 4 * MINUTE_MS

/* ------------------------------------------------------------------ *
 * 掌握度（画像 + 报告共用这一份）
 * ------------------------------------------------------------------ */

/**
 * 掌握度明细（**与「现在」无关的稳定常量**，按分数降序 = 服务端 `ORDER BY score DESC`）。
 *
 * ★ `score` 是**逐次作答累积出来的平滑值**（答对 +0.15 / 答错 −0.10，且钳在 0..1）：
 *   六关的分数都能由 `attempts` / `correct` 按这条规则反算出来（`0.15·correct − 0.10·(attempts−correct)`
 *   后钳到 0..1），所以三列不会互相打架。
 * ★ `attempts = correct + 答错次数`：答错的 6 次全部落在 `DEMO_MISTAKES` 那三关上。
 * ★ 三列合计 = 16 次作答 / 10 次答对（= `DEMO_QUIZ_TOTAL` / `DEMO_QUIZ_CORRECT`），
 *   答错 16 − 10 = 6 次 = `DEMO_MISTAKES` 的错次之和 —— 报告与错题本因此是同一个故事。
 */
export const DEMO_MASTERY: readonly {
  kpId: string
  score: number
  attempts: number
  correct: number
}[] = [
  { kpId: 'neural-network-sr', score: 0.75, attempts: 4, correct: 3 },
  { kpId: 'machine-learning-sr', score: 0.67, attempts: 6, correct: 4 },
  { kpId: 'supervised-learning-sr', score: 0.67, attempts: 3, correct: 2 },
  { kpId: 'unsupervised-learning-sr', score: 0.5, attempts: 2, correct: 1 },
  { kpId: 'reinforcement-learning-sr', score: 0.0, attempts: 1, correct: 0 },
  { kpId: 'deep-learning-sr', score: 0.0, attempts: 0, correct: 0 }
]

/**
 * `kp_id → 最近一次作答距今多久`（**相对量**，不写死时间戳）。
 *
 * ★ 全部落在**报告窗口之内**（≤ 5 天）：报告里「58 次作答」是这 16 关的作答之和，
 *   而窗口外的作答不在那 58 次里 —— 两处说的必须是同一批作答。
 * ★ 对应的日子也都在 `DEMO_DAILY_ACTIVITY` 那 6 天里（不会出现「这几天没学，
 *   却有关卡显示这几天刚练过」）。
 */
const DEMO_MASTERY_SEEN_AGO_MS: Readonly<Record<string, number | undefined>> = {
  'neural-network-sr': 3 * HOUR_MS,
  'machine-learning-sr': 1 * DAY_MS,
  'supervised-learning-sr': 4 * DAY_MS,
  'unsupervised-learning-sr': 5 * DAY_MS,
  'reinforcement-learning-sr': 2 * DAY_MS,
  'deep-learning-sr': 5 * DAY_MS
}

/** 取某关的掌握度（没有记录 = 0，与库里「没有那一行」同义）。 */
function demoMasteryScoreOf(kpId: string): number {
  const row = DEMO_MASTERY.find((item) => item.kpId === kpId)
  return row === undefined ? 0 : row.score
}

/** 画像与报告共用的掌握度出参（`lastSeenAt` 现算）。 */
function demoMasteryRows(now: number): Array<Record<string, unknown>> {
  return DEMO_MASTERY.map((row) => ({
    kpId: row.kpId,
    score: row.score,
    attempts: row.attempts,
    correct: row.correct,
    lastSeenAt: now - (DEMO_MASTERY_SEEN_AGO_MS[row.kpId] ?? DAY_MS)
  }))
}

/* ------------------------------------------------------------------ *
 * 闯关进度（报告与闯关页共用这一份）
 * ------------------------------------------------------------------ */

/**
 * 已掌握的 12 关（`stage = mastered`）。
 *
 * ★ 第 3 章 13 关里掌握 6 关、测验过 7 关（4 关完成度 2/3、2/3、1/4、1/4，合计正好 6/13）。
 *   其中 `artificial-neuron-sr` 与 `deep-learning-sr` 属于「通关了但没再练」——
 *   `DEMO_MASTERY` 里它们没有作答记录，所以掌握度是 0（不编造作答次数）。
 * ★ 服务端的状态机只有 `learning → quizzed → mastered`（**不再产出 `locked`**：
 *   所有关卡一开始就可作答，冷启动全部播种成 `learning`）。
 */
const DEMO_MASTERED_KP_IDS: readonly string[] = [
  'supervised-learning-sr',
  'unsupervised-learning-sr',
  'artificial-neuron-sr',
  'deep-learning-sr',
  'computer-vision-sr',
  'transformer-sr'
]

/** 已测验但还没掌握的 7 关（`stage = quizzed`）—— 推荐「重练」就是从这几关里出。 */
const DEMO_QUIZZED_KP_IDS: readonly string[] = [
  'reinforcement-learning-sr',
  'neural-network-sr',
  'nlp-sr',
  'speech-recognition-sr',
  'speech-synthesis-sr',
  'token-sr',
  'machine-learning-sr'
]

/**
 * 徽章：**只有练过的那几关有**（第 3 章四关）。
 *
 * ★ 徽章文本的形态是服务端算的：`档位-答对题数`，档位取自那五档
 *   `起步 / 初通 / 熟练 / 精通 / 大师`，判据就是 `min(答对数, 5) - 1`
 *   （`routes/quiz.py` 的 `badge_for`）。所以下面每一条的 `-N`
 *   必须与 `DEMO_MASTERY` 里**同一关的 `correct`** 逐字相等 ——
 *   写错档位就会与「答对几道」自相矛盾。
 * ★ 徽章是「曾经通关」的事实，答错不会把它抹掉 —— 所以它与 `stage` 一样只增不减。
 * ★ `neural-network-sr` 与 `machine-learning-sr` 是 `quizzed`（还没通关）却有徽章的那两关：
 *   徽章只记「答对过几道」，与关卡状态是两个轴，真实链路里也允许并存。
 */
const DEMO_BADGE_BY_KP: Readonly<Record<string, string | undefined>> = {
  'unsupervised-learning-sr': '起步-1',
  'supervised-learning-sr': '初通-2',
  'neural-network-sr': '熟练-3',
  'machine-learning-sr': '精通-4'
}

/**
 * 学生的**闯关进度行**（57 条，`stage` / `badge` / `mastery` 的真实分布）。
 *
 * ★ 行数由 `DEMO_KP_IDS` 决定（= 该学段真实关卡数 57），顺序 = 教材定义序。
 * ★ `mastery` 与 `DEMO_MASTERY` 同源（同一关在两处一定是同一个数）。
 */
export const DEMO_PROGRESS_LEVELS: readonly {
  kpId: string
  stage: string
  badge: string | null
  mastery: number
  /** 这 57 关全是**本学段**关卡路径（演示学生只有一个学段，没有路径外的历史行）。 */
  inPath: boolean
}[] = DEMO_KP_IDS.map((kpId) => ({
  kpId,
  inPath: true,
  stage: DEMO_MASTERED_KP_IDS.includes(kpId)
    ? 'mastered'
    : DEMO_QUIZZED_KP_IDS.includes(kpId)
      ? 'quizzed'
      : 'learning',
  badge: DEMO_BADGE_BY_KP[kpId] ?? null,
  mastery: demoMasteryScoreOf(kpId)
}))

/** `stage → 关卡数`（服务端就是拿进度行现算的；键按字典序，与 `sorted(stage_counts)` 同形）。 */
const DEMO_STAGE_COUNTS: Readonly<Record<string, number>> = (() => {
  const counts: Record<string, number> = {}
  for (const row of DEMO_PROGRESS_LEVELS) counts[row.stage] = (counts[row.stage] ?? 0) + 1
  const sorted: Record<string, number> = {}
  for (const key of Object.keys(counts).sort()) sorted[key] = counts[key] ?? 0
  return sorted
})()

/** 已获得的徽章（**去重后升序**——与服务端 `SELECT DISTINCT badge … ORDER BY badge` 同口径）。 */
const DEMO_BADGES: readonly string[] = [
  ...new Set(
    DEMO_PROGRESS_LEVELS.map((row) => row.badge).filter((badge): badge is string => badge !== null)
  )
].sort()

/**
 * 各章的闯关进度（8 章，按教材定义序）。
 *
 * ★ 四个数都由上面两张表**算出来**：`kpCount` 之和 = 57、`masteredCount` 之和 = 12、
 *   `quizzedCount` 之和 = 4，与 `DEMO_STAGE_COUNTS` 永远一致。
 */
export const DEMO_CHAPTER_PROGRESS: readonly {
  chapterTitle: string
  kpCount: number
  masteredCount: number
  quizzedCount: number
}[] = Object.entries(DEMO_CHAPTER_KP_IDS).map(([chapterTitle, kpIds]) => ({
  chapterTitle,
  kpCount: kpIds.length,
  masteredCount: kpIds.filter((kpId) => DEMO_MASTERED_KP_IDS.includes(kpId)).length,
  quizzedCount: kpIds.filter((kpId) => DEMO_QUIZZED_KP_IDS.includes(kpId)).length
}))

/** 已掌握关卡的集合（图谱节点与报告都用它，避免又写一份 `stage === 'mastered'`）。 */
const DEMO_MASTERED_SET: ReadonlySet<string> = new Set(
  DEMO_PROGRESS_LEVELS.filter((row) => row.stage === 'mastered').map((row) => row.kpId)
)

/* ------------------------------------------------------------------ *
 * 答题与错题（报告与错题本)**同一个故事**
 * ------------------------------------------------------------------ */

/**
 * 答题总数（= 掌握度明细里各关作答次数之和）。
 *
 * ★ **算出来的**：报告里的 `quizTotal` 与掌握度表因此不可能对不上。
 */
export const DEMO_QUIZ_TOTAL: number = DEMO_MASTERY.reduce((sum, row) => sum + row.attempts, 0)

/** 答对总数（= 掌握度明细里各关答对次数之和）；`quizTotal − quizCorrect` 就是错次之和。 */
export const DEMO_QUIZ_CORRECT: number = DEMO_MASTERY.reduce((sum, row) => sum + row.correct, 0)

/**
 * 错题本的三条（按最近一次答错的时间倒序，与服务端 `ORDER BY ts DESC` 同口径）。
 *
 * ★ 题干是**该 kp 真实题目的题干原文**（`preset-content/quizbank/ch03.json` 与
 *   本文件的 `DEMO_QUIZ_VARIANTS`，按 `lastQid` 那一题的 `stem` 逐字抄；
 *   服务端入库的也是题干前 120 字）。
 * ★ 三条错次 3 / 2 / 1 合计 **6** = `DEMO_QUIZ_TOTAL − DEMO_QUIZ_CORRECT`：
 *   报告里的「答错 6 次」与错题本的「累计答错 6 次」是同一个数。
 * ★ 第 2 条的 `qid` 是**预置变式题**（`gen-` 前缀，见本文件的 `DEMO_QUIZ_VARIANTS`）：
 *   它必须真在那份预置清单里，否则「再练一遍」会指向一道取不出来的题。
 */
const DEMO_MISTAKES: readonly {
  kpId: string
  /** 最近一次答错的那道题的题号（供「再练一遍」定位变式题；题号不是答案）。 */
  lastQid: string
  /** 该题真实题干的原文（≤ 120 字）。 */
  stem: string
  wrongCount: number
  lastWrongAgoMs: number
}[] = [
  {
    kpId: 'machine-learning-sr',
    lastQid: 'machine-learning-sr-q3',
    stem: '训练时要避免过拟合，教材提到的控制手段是？',
    wrongCount: 3,
    lastWrongAgoMs: 26 * HOUR_MS
  },
  {
    kpId: 'machine-learning-sr',
    lastQid: 'gen-machine-learning-sr-demo-1',
    stem: '下面哪个例子属于无监督学习？',
    wrongCount: 2,
    lastWrongAgoMs: 25 * HOUR_MS
  },
  {
    kpId: 'reinforcement-learning-sr',
    lastQid: 'reinforcement-learning-sr-q1',
    stem: '「探索与利用的权衡」指的是什么？',
    wrongCount: 1,
    lastWrongAgoMs: 2 * DAY_MS
  }
]

/* ------------------------------------------------------------------ *
 * 学习报告的时间窗
 * ------------------------------------------------------------------ */

/** 学习报告的 `daily` 窗口天数（服务端默认值）。 */
export const DEMO_REPORT_DAYS = 7

/**
 * 窗口内**有活动的那几天**（`offsetDays` = 相对今天往前几天；只有这 6 天，且含今天）。
 *
 * ★ 7 天**连成一片**（0..6，正好铺满报告窗口），所以「连续学习 7 天」与这张表是同一件事
 *   （今天是最后一条 → `todayStudied = true`）。
 * ★ 每天的活动数 ≥ 当天的答题数（答题本身也是一条活动，不可能比活动总数还多）。
 * ★ 7 天合计：25 条活动 / 16 次答题 / 10 次答对 —— 后两个数与
 *   `DEMO_QUIZ_TOTAL` / `DEMO_QUIZ_CORRECT`（= 掌握度表合计）**同一个数**，
 *   差值 6 就是错题本那三条的错次之和。
 */
const DEMO_DAILY_ACTIVITY: readonly {
  offsetDays: number
  count: number
  quizCount: number
  correctCount: number
}[] = [
  { offsetDays: 6, count: 3, quizCount: 2, correctCount: 1 },
  { offsetDays: 5, count: 4, quizCount: 3, correctCount: 2 },
  { offsetDays: 4, count: 2, quizCount: 1, correctCount: 1 },
  { offsetDays: 3, count: 5, quizCount: 3, correctCount: 2 },
  { offsetDays: 2, count: 4, quizCount: 3, correctCount: 2 },
  { offsetDays: 1, count: 3, quizCount: 2, correctCount: 1 },
  { offsetDays: 0, count: 4, quizCount: 2, correctCount: 1 }
]

/** 连续学习天数（= 上面那 7 个连续的日子，今天在内）。 */
const DEMO_STREAK_DAYS = 7

/** 本地日期串（`YYYY-MM-DD`）。**按本地日历往前推**，不是拿时间戳减天数（跨夏令时会错一天）。 */
function demoLocalDay(now: Date, offsetDays: number): string {
  const shifted = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays)
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const day = String(shifted.getDate()).padStart(2, '0')
  return `${shifted.getFullYear()}-${month}-${day}`
}

/* ------------------------------------------------------------------ *
 * 学段（状态 / 信号 / 轨迹三处必须互相解释得通）
 * ------------------------------------------------------------------ */

/**
 * 学段判定的**合并置信度**（状态、信号、最后一条轨迹三处共用这一个数）。
 *
 * ★ 0.91 是最近一次判定（第 27 轮 AI 引擎复核）的置信度：判定 prompt 要求自报
 *   0.6 以上才算有把握，复核报的是 0.91（高中词频特征明显）—— 略高于规则层
 *   能给出的**上限** 0.9 一档，正是「复核层敢下结论」与「规则层只敢给 0.75」的差别。
 * ★ 规则层同一窗口只给到 0.75（末尾三轮同向、强度各 0.5，
 *   口径 `min(0.9, 平均强度 × 1.5)`）。
 * ★ 状态体 / 信号体 / 轨迹末条**三处共用这一个数**（改一处就要改三处，
 *   否则界面上「依据」与「结论」的置信度对不上）。
 * ★ 声明在轨迹 / 信号两张表**之前**：它们都要引它（`const` 有暂时性死区，
 *   写在后面会在模块加载时直接抛错）。
 */
const DEMO_GRADE_CONFIDENCE = 0.91

/**
 * 学段变化轨迹（第一条是**冷启动基线**：`fromLevel` 为空 = 学生还没有「上一段」）。
 *
 * ★ 故事（一条可读的轨迹：基线 → 规则层两级下探 → 规则层回调 → **复核层两次改判** → 稳定）：
 *   ① 第 1 轮 冷启动基线 → 小学高年级。基线值是**当时**的冷启动默认值
 *      （服务端 2026-09-22 起才把默认值改成初中），这条基线写于 60 天前，
 *      所以它保留旧默认值是如实的；
 *   ② 第 3 轮 规则层**下调**到小学低年级：开头几轮学生连着说「太难了 / 听不懂」，
 *      元认知那一路指向下走（这一轮还没到 LLM 接管的累计第 5 轮）；
 *   ③ 第 8 轮 规则层**调回**小学高年级：术语与提问深度两路证据攒够了；
 *   ④ 第 13 轮 **AI 引擎复核判定为初中**（`decidedBy: 'llm'`）：累计轮次早已越过
 *      `LLM_DECIDES_FROM_TURN`（第 5 轮），这一轮由复核层定方向；
 *   ⑤ 第 18 / 23 轮 复核层继续**按同一方向抬档**（初中 → 初中）：
 *      相邻两次都隔 5 轮，正好走完 `COOLDOWN_TURNS`；
 *   ⑥ 第 27 轮 **复核判定为高中**：本次演示的现状（`toLevel` = `DEMO_GRADE_LEVEL`）。
 *   ★ 相邻两次自动调整都隔 ≥5 轮（`COOLDOWN_TURNS`），所以第 3 / 8 / 13 / 18 / 23 / 27 轮各动一次；
 *     基线那行（`fromLevel` 为空）**不参与冷却**，所以第 3 轮动得起来。
 *   ★ 最后一次在第 27 轮、当前是第 31 轮 → 与 `demoGradeStateBody()` 的
 *     `lastTurn: 31` / `lastChangeTurn: 27` / `cooldownRemainingTurns: 0` 一一对应
 *     （31 − 27 = 4，已走完自动冷却窗口 `COOLDOWN_TURNS` = 5 —— 冷却按「距锚点的
 *     真实交互轮数」算，锚点之前的轮次不计）。
 * ★ 置信度只升不降（0 / 0.75 / 0.75 / 0.85 / 0.85 / 0.85 / 0.91）：规则层两次都是
 *   「三轮同向、强度各 0.5」，按 `min(0.9, 0.5 × 1.5)` 得 0.75；
 *   13 / 18 / 23 三轮复核自报 0.85；末轮复核自报 0.91（= `DEMO_GRADE_CONFIDENCE`）。
 */
const DEMO_GRADE_HISTORY: readonly {
  agoMs: number
  turn: number
  fromLevel: string | null
  toLevel: string
  source: string
  decidedBy: string | null
  confidence: number
}[] = [
  {
    agoMs: 60 * DAY_MS,
    turn: 1,
    fromLevel: null,
    toLevel: 'primary_high',
    source: 'inferred',
    decidedBy: null,
    confidence: 0.0
  },
  {
    agoMs: 52 * DAY_MS,
    turn: 3,
    fromLevel: 'primary_high',
    toLevel: 'primary_low',
    source: 'inferred',
    decidedBy: 'rules',
    confidence: 0.75
  },
  {
    agoMs: 41 * DAY_MS,
    turn: 8,
    fromLevel: 'primary_low',
    toLevel: 'primary_high',
    source: 'inferred',
    decidedBy: 'rules',
    confidence: 0.75
  },
  {
    agoMs: 21 * DAY_MS,
    turn: 13,
    fromLevel: 'primary_high',
    toLevel: 'junior',
    source: 'inferred',
    decidedBy: 'llm',
    confidence: 0.85
  },
  {
    agoMs: 13 * DAY_MS,
    turn: 18,
    fromLevel: 'junior',
    toLevel: 'junior',
    source: 'inferred',
    decidedBy: 'llm',
    confidence: 0.85
  },
  {
    agoMs: 9 * DAY_MS,
    turn: 23,
    fromLevel: 'junior',
    toLevel: 'junior',
    source: 'inferred',
    decidedBy: 'llm',
    confidence: 0.85
  },
  {
    agoMs: 7 * DAY_MS,
    turn: 27,
    fromLevel: 'junior',
    toLevel: DEMO_GRADE_LEVEL,
    source: 'inferred',
    decidedBy: 'llm',
    confidence: DEMO_GRADE_CONFIDENCE
  }
]

/** 学段轨迹的出参（毫秒时间戳现算）。 */
function demoGradeHistoryRows(now: number): Array<Record<string, unknown>> {
  return DEMO_GRADE_HISTORY.map((row) => ({
    ts: now - row.agoMs,
    turn: row.turn,
    fromLevel: row.fromLevel,
    toLevel: row.toLevel,
    source: row.source,
    decidedBy: row.decidedBy,
    confidence: row.confidence
  }))
}

/**
 * 学段信号（最近四条 = 四类各一条；**升序**，与 `recent_signals()` 的回传顺序一致）。
 *
 * ★ 四类都给：`vocab` / `depth` / `quiz_perf` / `meta_cognition`（= 契约
 *   `GradeSignalType` 的全部取值）—— 界面上「学段依据」那几格不会缺项。
 * ★ `value` 的口径（`app/grade/signals.py`）：差一个学段 = ±0.5，差两级及以上封顶 ±1.0，
 *   中性 / 无证据 = 0（所以不会出现 0.26 这种数）。这里四条全落在 [0, 1]。
 * ★ 末尾两条（词汇 / 深度）各 **+0.5**：都指向「讲得比他能接的浅了一档」→
 *   `direction: 1`；它们前面是一条中性读数（答题表现 0.0），所以「连续同向」
 *   只数到 **2 轮**（< `SIGNALS_REQUIRED_FOR_CHANGE` 3 轮）—— 还没有待生效的调整。
 * ★ 这一组信号与「当前是高中」是同一件事的两面：词汇那一路命中的
 *   `梯度下降` / `损失函数` 本来就是 `min_grade=senior` 的术语。
 * ★ `quiz_perf` 是**历史取值**：2026-09-21（D-065）起答题表现不再参与学段判定
 *   （那是掌握度的事，还会与元认知重复计数），但契约的联合类型刻意留着它 ——
 *   库里升级前写入的行还要读得出来。这里如实记成中性 0.0。
 * ★ `meta_cognition` 那条（受挫表达）也记成中性 0.0：它记录的是一次**已经消费过**的
 *   下调证据（第 3 轮那次回调的起因，见轨迹表），演示里只作为「这条路上真的有证据」
 *   的留档；它同时是末尾连续同向窗口的**起点**（它之后才连着两轮同向）。
 * ★ `raw` 是服务端那种证据摘要（自有词表命中项 / 档位 / 命中模式），
 *   术语与档位都逐字取自真实词表（`knowledge/terminology.json` 的 `梯度下降` /
 *   `损失函数` 确实是 `min_grade=senior`；`推导` 确实是 senior 的提问框架）。
 * ★ `ts` 是**相对现在**往前推的毫秒数（什么时候点开都像刚判过）。
 */
const DEMO_GRADE_SIGNALS: readonly {
  signalType: string
  value: number
  raw: string
  agoMs: number
}[] = [
  {
    signalType: 'meta_cognition',
    value: 0.0,
    raw: '元认知=受挫=太难了,听不懂',
    agoMs: 2 * DAY_MS
  },
  {
    signalType: 'quiz_perf',
    value: 0.0,
    raw: '正确率=0.63;样本=近一周 16 题',
    agoMs: 1 * DAY_MS
  },
  {
    signalType: 'vocab',
    value: 0.5,
    raw: '术语=梯度下降(min_grade=senior),损失函数(min_grade=senior)',
    agoMs: 3 * HOUR_MS
  },
  {
    signalType: 'depth',
    value: 0.5,
    raw: '深度=senior;命中=推导',
    agoMs: 1 * HOUR_MS
  }
]

/* ------------------------------------------------------------------ *
 * 推荐与开场引导（两处同源：同一批薄弱关卡）
 * ------------------------------------------------------------------ */

/**
 * 推荐重练的关卡（来源 `review` = 「练过但没稳住」）。
 *
 * ★ 就是那 7 个 `quizzed` 关卡里**掌握度最低的四关**，按掌握度从低到高排 ——
 *   最弱的一关在最前面，开场引导指的也是它（服务端那边开场语与推荐结论出自同一个函数）。
 * ★ 只列四关而不是七关：推荐位本来就是「下一步先做哪个」，一屏四条足够，
 *   而且四条各自的理由都能在 `DEMO_MASTERY` 里找到依据。
 */
const DEMO_REVIEW_ITEMS: readonly { kpId: string; reason: string }[] = [
  { kpId: 'reinforcement-learning-sr', reason: '这块还没掌握，先分清「靠标签学」和「靠奖励学」。' },
  { kpId: 'nlp-sr', reason: '只做过一道题，趁热把自然语言处理这一关补上。' },
  { kpId: 'token-sr', reason: '差一点就过了，再来两道就能拿下徽章。' },
  { kpId: 'neural-network-sr', reason: '练过几道还没稳住，先把分层结构这条线走一遍。' }
]

/* ------------------------------------------------------------------ *
 * 动画库
 * ------------------------------------------------------------------ */

/**
 * 「我的动画」三条。
 *
 * ★ `html` **不在这里编**（见 `demoSavedAnimationItemBody`）：它由覆盖层从**真实渲染端点**
 *   取来注入（`demo/animation.ts`）；取不到时渲染侧既有的降级路径会显示 `fallbackText`，
 *   那才是诚实的行为。
 * ★★ `concept` **必须与渲染端点返回的 `concept` 逐字相同**（这三条分别是
 *   `gradient-descent-v2` / `neural-forward` / `sorting-bars` 模板的产物）：
 *   渲染侧 `cards/InlineCard.vue` 的 `savedMatch` 是拿**卡片载荷的 concept + 学段**
 *   去库里对记录的 —— 库里写成别的说法时，卡片上那颗「我的」按钮永远灰着。
 *   所以这里取**模板自己声明的概念名**，`title` 才是那个有区分度的说法。
 * ★ `durationMs` 与 `fallbackText` 同样取自**那份模板自己的声明**（不另编）：
 *   库里存的是成品，而演示不落盘，这两个展示字段只能由模板说明。
 * ★ `promptHash` 只收**十六进制摘要**（形状由 `ANIMATION_PROMPT_HASH_PATTERN` 定）；
 *   `id` 必须匹配 `^[A-Za-z0-9_-]{1,64}$`。
 */
const DEMO_SAVED_ANIMATIONS: readonly {
  id: string
  kpId: string
  concept: string
  promptHash: string
  title: string
  durationMs: number
  fallbackText: string
  createdAtAgoMs: number
  uses: number
}[] = [
  {
    id: 'saved-anim-001',
    kpId: 'machine-learning-sr',
    // ★ 逐字取自 `gradient-descent-v2` 模板的 `concept`（真实渲染端点返回的就是这个）——
    //   写成别的说法会让卡片上的「我的」永远对不上（见上面那段）。
    concept: '梯度下降',
    promptHash: 'de941d637a6b9367c139475f8480089931ec34f9',
    title: '梯度下降·视觉化',
    durationMs: 10_655,
    fallbackText:
      '训练开始时，机器先随便给预测线一个位置，再看每个数据点离这条线有多远。所有距离加起来就是一个损失值，损失越小说明预测越接近这批数据。接下来每一步都沿着让损失下降最快的方向挪一点，学习率决定每一步挪多大。挪到损失不再明显下降时，参数就接近最合适的位置了。',
    createdAtAgoMs: 27 * HOUR_MS,
    uses: 4
  },
  {
    id: 'saved-anim-002',
    kpId: 'neural-network-sr',
    // ★ 逐字取自 `neural-forward` 模板的 `concept`（同上）。
    concept: '神经网络',
    promptHash: '4cf6dc64d7d48a0edbfb71e2ad38aa7386efa8f1',
    title: '神经网络分层结构',
    durationMs: 4_600,
    fallbackText:
      '一层层算过去：上一层的每个数都要按权重传给下一层的每个节点，下一层再把收到的加权和过一次激活函数。层与层之间的连接就是那些权重，训练调的就是它们。',
    createdAtAgoMs: 26 * HOUR_MS,
    uses: 2
  },
  {
    id: 'saved-anim-003',
    kpId: 'prog-list-sr',
    // ★ 逐字取自 `sorting-bars` 模板的 `concept`（同上）。
    concept: '排序',
    promptHash: '14c474b46ce9ab7dda9c0e6de9404a4cdee4bcda',
    title: '排序：把数据排好',
    durationMs: 5_200,
    fallbackText:
      '排序做的事，是反复比较相邻的两个数：如果左边的比右边的大，就把它们交换过来。一遍走完，最大的数就被推到了最后；再来一遍，第二大的也到了位置。重复「比较 + 交换」直到没有需要交换的，一整排数就排好了。',
    createdAtAgoMs: 25 * HOUR_MS,
    uses: 1
  }
]

/**
 * 渲染产物的**最小投影**：一条库记录要成为「能播的一份」，只缺这两样。
 *
 * ★ 两个字段都取自**真实产物**（`demo/animation.ts` 渲染后回传）：
 *   `html` 是自包含的沙箱产物本体，`payloadId` 是从它里面读回来的那把防串台 id。
 * ★ 本文件是纯数据模块（不发网络），所以这里只**声明形状**，IO 在调用方那一侧。
 */
export interface DemoSavedAnimationRender {
  html: string
  payloadId: string
}

/**
 * 按 id 取动画库的一条登记（认不出回 `null`）。
 *
 * ★ `kpId` 是「这条要渲染成什么」的唯一依据（覆盖层据此去真实端点取产物），
 *   所以取登记这件事只写在这里，不散成两处 `.find`。
 */
export function demoSavedAnimationRow(savedId: string): (typeof DEMO_SAVED_ANIMATIONS)[number] | null {
  return DEMO_SAVED_ANIMATIONS.find((item) => item.id === savedId) ?? null
}

/** 动画库清单里的一条（**不含 `html`**，与服务端 `AnimationSavedItem` 同形）。 */
function demoSavedAnimationItem(
  row: (typeof DEMO_SAVED_ANIMATIONS)[number],
  now: number
): Record<string, unknown> {
  return {
    id: row.id,
    kpId: row.kpId,
    gradeLevel: DEMO_GRADE_LEVEL,
    concept: row.concept,
    promptHash: row.promptHash,
    title: row.title,
    durationMs: row.durationMs,
    fallbackText: row.fallbackText,
    fallbackImage: null,
    createdAt: now - row.createdAtAgoMs,
    uses: row.uses
  }
}

/* ------------------------------------------------------------------ *
 * 「智团团给我出过的题」
 * ------------------------------------------------------------------ */

/**
 * 学生生成过的 2 道题（`source: 'generated'`）。
 *
 * ★ `type` 只允许 `choice | blank | code_blank`；**结构上没有 `answer` / `explanation`**
 *   （答案下发是明令禁止的那条红线，这里连字段都不给）。
 * ★ `qid` 前缀 `gen-` 与服务端 `GENERATED_QID_PREFIX` 一致；判分仍按 `qid` 走。
 * ★★ 这两条的 `qid` / `stem` / `options` 与 {@link DEMO_QUIZ_VARIANTS} 的**第 1 道与第 3 道**
 *   逐字相同（同一批预置变式题的两种读法：那里是「登记进库」的形态，这里是
 *   「智团团给我出过的题」的对外形态）—— 两处写岔了，同一个学生会看到两道不同的题。
 */
const DEMO_GENERATED_KP_ID = 'machine-learning-sr'

const DEMO_GENERATED_QUESTIONS: readonly {
  qid: string
  kpId: string
  type: string
  stem: string
  options: readonly string[] | null
}[] = [
  {
    qid: 'gen-machine-learning-sr-demo-0',
    kpId: DEMO_GENERATED_KP_ID,
    type: 'choice',
    stem: '监督学习和强化学习的根本区别在于什么？',
    options: [
      '监督学习需要标签，强化学习靠奖励信号',
      '监督学习用于图像，强化学习用于文本',
      '监督学习要大数据，强化学习要小数据'
    ]
  },
  {
    qid: 'gen-machine-learning-sr-demo-2',
    kpId: DEMO_GENERATED_KP_ID,
    type: 'choice',
    stem: '训练时如果损失一直在降但验证集损失开始上升，说明什么？',
    options: ['过拟合了，应该早停', '欠拟合了，应该加层', '学习率太大了']
  }
]

/* ------------------------------------------------------------------ *
 * 预置变式题（「我想再练几道」在沙箱态下拿到的就是这三道）
 * ------------------------------------------------------------------ */

/**
 * 三道**预置的**变式题（对应主线知识点 `machine-learning-sr`）。
 *
 * ★★ 为什么要有它：真实链路里「再练几道」走 `generate_variants`（模型现场出题 +
 *   登记答案）。沙箱态**不能真调 LLM**，于是提前把题写好、载入即可用 ——
 *   演示者点那一下拿到的是精挑细选的三道，而不是一个转圈的等待。
 *
 * ★ 字段与真实登记的形态逐字段对齐：`qid` 必须带 `gen-` 前缀且与
 *   `variantQid(kpId, index, seed)` 同形（`gen-<kp>-<seed>-<i>`，seed 用 `demo`）——
 *   前缀不对会被真实链路判成「伪装成题库真题」。
 * ★★ `answer` / `rubric` 只在这份**内部**清单里（供判分与「再练一遍」定位），
 *   **绝不进任何下发载荷**：`demoQuizGeneratedBody()` 投影出去的三个字段
 *   （`qid` / `type` / `stem` / `options`）结构上没有答案，与真实链路同一条纪律。
 * ★ 为什么是 `.ts` 常量而不是文档里那个独立 JSON：本模块被
 *   `tests/demo-seed.test.ts` 在纯 node 下直接加载，而 `handlers-data.ts`（读它的那一侧）
 *   同样要能在不起 Electron 的情况下被加载 —— 一个 `node:fs` 读盘会给这两处各加一条
 *   与功能无关的依赖。预置数据全部住在本文件里也更好审：一处就能看全。
 */
export const DEMO_QUIZ_VARIANTS: readonly {
  qid: string
  type: string
  stem: string
  options: readonly string[]
  /** 标准答案：**只在主进程内部**用于判分/定位，绝不下发。 */
  answer: string
  /** 判分细则：同上，不进任何对外载荷。 */
  rubric: string
}[] = [
  {
    qid: 'gen-machine-learning-sr-demo-0',
    type: 'choice',
    stem: '监督学习和强化学习的根本区别在于什么？',
    options: [
      '监督学习需要标签，强化学习靠奖励信号',
      '监督学习用于图像，强化学习用于文本',
      '监督学习要大数据，强化学习要小数据'
    ],
    answer: '监督学习需要标签，强化学习靠奖励信号',
    rubric: '三类学习的根本判据是反馈形式：监督=标签、强化=奖励、无监督=无反馈。'
  },
  {
    qid: 'gen-machine-learning-sr-demo-1',
    type: 'choice',
    stem: '下面哪个例子属于无监督学习？',
    options: [
      '把学生做题记录按行为聚类找出共性薄弱点',
      '用标注好的猫狗图片训练分类器',
      '让 AI 通过试错学下围棋'
    ],
    answer: '把学生做题记录按行为聚类找出共性薄弱点',
    rubric: '无监督学习的判据是数据没有标签，目标是发现结构（聚类、降维）。'
  },
  {
    qid: 'gen-machine-learning-sr-demo-2',
    type: 'choice',
    stem: '训练时如果损失一直在降但验证集损失开始上升，说明什么？',
    options: ['过拟合了，应该早停', '欠拟合了，应该加层', '学习率太大了'],
    answer: '过拟合了，应该早停',
    rubric: '过拟合的典型现象是训练损失继续降、验证损失回升，控制手段是早停与正则化。'
  }
]

/**
 * 沙箱态「再练几道」的回执载荷（**对外形态，结构上没有答案**）。
 *
 * ★ 形态与 `handlers-data.ts` 里 `quizGeneratedList` 的产出一致：
 *   渲染侧的练习页拿它当「这一批新题」直接追加，不需要另写一套渲染。
 */
export function demoQuizVariantsBody(): Record<string, unknown> {
  return {
    kpId: 'machine-learning-sr',
    questions: DEMO_QUIZ_VARIANTS.map((row) => ({
      qid: row.qid,
      kpId: 'machine-learning-sr',
      type: row.type,
      stem: row.stem,
      options: [...row.options]
    })),
    source: 'generated'
  }
}

/* ------------------------------------------------------------------ *
 * 学习偏好（键是服务端的封闭词表，值 ≤ 40 字、单行、只描述学习方式）
 * ------------------------------------------------------------------ */

const DEMO_PREFERENCES: Readonly<Record<string, string>> = {
  explain_style: '先举生活里的例子，再给结论',
  pace: '一次讲一小步，讲完等我跟上',
  interest: '喜欢用动画和跑代码来理解概念',
  note: '错在细节时先让我自己找一遍'
}

/* ------------------------------------------------------------------ *
 * 依赖图（节点与边的值逐字来自随包 `kb.sqlite`；只有「已掌握」是学生态）
 * ------------------------------------------------------------------ */

/**
 * 高中内部的**全部 78 条依赖边**（当前教材里这一层全是 `related`、权重 0.6）。
 *
 * ★ 只保留**两端都在本学段**的边（跨学段的边在单学段视图里没有落点）——
 *   与服务端 `/api/graph/overview/{grade}` 的过滤口径一致。
 * ★ 图谱的**分层**由这些边现算（服务端也是现算的），见 `demoGraphLayers`。
 * ★ 边的清单与 `kb.sqlite` 的 `knowledge_dependencies` 逐条对齐（同 78 条、同权重），
 *   只是顺序按「从 `ai-definition-sr` 起读得顺」重排了一遍 —— 分层是现算的，
 *   所以重排只影响可读性，不影响任何层号。
 */
const DEMO_GRAPH_EDGE_PAIRS: readonly (readonly [string, string])[] = [
  ['agent-action-sr', 'edu-notes-mindmap-sr'],
  ['agent-perception-sr', 'agent-planning-sr'],
  ['agent-planning-sr', 'agent-reflection-sr'],
  ['agent-planning-sr', 'agent-tool-use-sr'],
  ['agent-reflection-sr', 'limit-hallucination-sr'],
  ['agent-tool-use-sr', 'agent-action-sr'],
  ['ai-definition-sr', 'ai-hierarchy-sr'],
  ['ai-definition-sr', 'ai-three-values-sr'],
  ['ai-hierarchy-sr', 'deep-learning-sr'],
  ['ai-hierarchy-sr', 'genai-sr'],
  ['ai-hierarchy-sr', 'machine-learning-sr'],
  ['algorithm-sr', 'machine-learning-sr'],
  ['artificial-neuron-sr', 'neural-network-sr'],
  ['computer-vision-sr', 'agent-perception-sr'],
  ['computer-vision-sr', 'autonomous-driving-sr'],
  ['computer-vision-sr', 'industrial-inspection-sr'],
  ['computer-vision-sr', 'medical-imaging-sr'],
  ['computing-power-sr', 'algorithm-sr'],
  ['computing-power-sr', 'hardware-accelerator-sr'],
  ['computing-power-sr', 'training-inference-sr'],
  ['data-sr', 'algorithm-sr'],
  ['data-sr', 'data-processing-sr'],
  ['data-sr', 'prog-list-sr'],
  ['data-sr', 'prog-variable-sr'],
  ['data-processing-sr', 'limit-hallucination-sr'],
  ['deep-learning-sr', 'artificial-neuron-sr'],
  ['deep-learning-sr', 'neural-network-sr'],
  ['edu-agent-sr', 'edu-qa-sr'],
  ['edu-agent-sr', 'ethics-privacy-sr'],
  ['edu-preview-review-sr', 'edu-notes-mindmap-sr'],
  ['edu-qa-sr', 'edu-mistake-review-sr'],
  ['edu-qa-sr', 'ethics-anti-misuse-sr'],
  ['ethics-privacy-sr', 'ethics-fairness-sr'],
  ['genai-sr', 'aigc-media-sr'],
  ['genai-sr', 'llm-sr'],
  ['genai-sr', 'nlp-sr'],
  ['limit-hallucination-sr', 'ethics-information-sr'],
  ['limit-hallucination-sr', 'limit-knowledge-cutoff-sr'],
  ['limit-hallucination-sr', 'limit-understanding-sr'],
  ['limit-teaching-sr', 'ethics-fairness-sr'],
  ['limit-understanding-sr', 'limit-interaction-sr'],
  ['llm-sr', 'edu-agent-sr'],
  ['llm-sr', 'limit-hallucination-sr'],
  ['llm-sr', 'prompt-sr'],
  ['llm-sr', 'rag-sr'],
  ['long-term-memory-sr', 'edu-agent-sr'],
  ['long-term-memory-sr', 'edu-mistake-review-sr'],
  ['long-term-memory-sr', 'edu-preview-review-sr'],
  ['machine-learning-sr', 'deep-learning-sr'],
  ['machine-learning-sr', 'reinforcement-learning-sr'],
  ['machine-learning-sr', 'supervised-learning-sr'],
  ['machine-learning-sr', 'unsupervised-learning-sr'],
  ['medical-imaging-sr', 'ethics-information-sr'],
  ['narrow-ai-sr', 'llm-sr'],
  ['narrow-ai-sr', 'strong-ai-agi-sr'],
  ['neural-network-sr', 'transformer-sr'],
  ['nlp-sr', 'computer-vision-sr'],
  ['nlp-sr', 'llm-sr'],
  ['prog-loop-sr', 'prog-list-sr'],
  ['prog-variable-sr', 'prog-loop-sr'],
  ['prompt-sr', 'ethics-fairness-sr'],
  ['prompt-sr', 'limit-teaching-sr'],
  ['rag-sr', 'agent-tool-use-sr'],
  ['rag-sr', 'limit-hallucination-sr'],
  ['rag-sr', 'limit-knowledge-cutoff-sr'],
  ['reinforcement-learning-sr', 'agent-reflection-sr'],
  ['short-term-memory-sr', 'limit-interaction-sr'],
  ['short-term-memory-sr', 'long-term-memory-sr'],
  ['speech-recognition-sr', 'agent-perception-sr'],
  ['speech-recognition-sr', 'speech-synthesis-sr'],
  ['speech-recognition-sr', 'voice-assistant-sr'],
  ['speech-synthesis-sr', 'voice-assistant-sr'],
  ['supervised-learning-sr', 'reinforcement-learning-sr'],
  ['supervised-learning-sr', 'unsupervised-learning-sr'],
  ['token-sr', 'llm-sr'],
  ['training-inference-sr', 'autonomous-driving-sr'],
  ['transformer-sr', 'llm-sr'],
  ['transformer-sr', 'token-sr']
]

/**
 * 给每个知识点算**分层**（0 = 该子图的入口）。
 *
 * ★ 算法与服务端 `_assign_layers` 同一份：节点的层 = 它全部前置的层 + 1 取最大，
 *   迭代松弛到不再变化（有环时也会在 N 轮内停下，结果稳定）。
 * ★ 在这里现算而不是写死一串层号：层是**边的函数**，写死就会出现
 *   「层号与边对不上」这种自相矛盾的数据。
 */
function demoGraphLayers(): Readonly<Record<string, number | undefined>> {
  const predecessors: Record<string, string[]> = {}
  for (const kpId of DEMO_KP_IDS) predecessors[kpId] = []
  for (const [fromKpId, toKpId] of DEMO_GRAPH_EDGE_PAIRS) {
    const bucket = predecessors[toKpId]
    if (bucket !== undefined) bucket.push(fromKpId)
  }

  const layers: Record<string, number> = {}
  for (const kpId of DEMO_KP_IDS) layers[kpId] = 0
  for (let round = 0; round < DEMO_KP_IDS.length; round += 1) {
    let changed = false
    for (const kpId of DEMO_KP_IDS) {
      let best = 0
      for (const pred of predecessors[kpId] ?? []) best = Math.max(best, (layers[pred] ?? 0) + 1)
      if (best !== layers[kpId]) {
        layers[kpId] = best
        changed = true
      }
    }
    if (!changed) break
  }
  return layers
}

/** `kp_id → 层号`（模块加载时算一次；边是常量，层也就是常量）。 */
const DEMO_GRAPH_LAYERS: Readonly<Record<string, number | undefined>> = demoGraphLayers()

/* ------------------------------------------------------------------ *
 * 设置显示态（**只有掩码，绝无明文**）
 * ------------------------------------------------------------------ */

/**
 * 模型配置的显示态：看起来「早就配好、一直在用」。
 *
 * ★★ `apiKey` 只许是**掩码形状**（`…` + 末 4 位，与服务端 `mask_api_key` 同形）：
 *    明文 Key 不出现在这个文件里的任何地方，也不经任何通道下发。
 * ★ `embedding.mode` 是本机模型（`local_fastembed`）：不需要联网，演示断网也成立。
 */
const DEMO_LLM_DISPLAY: Readonly<Record<string, unknown>> = {
  providerId: 'deepseek',
  providerName: 'DeepSeek',
  // ★ BaseURL 只改到根（不带 /v1）：Pi 内置 DeepSeek provider 用的就是这个形态，
  //   多一个 /v1 会被当成另一个端点（见 `shared/api-types.ts` 的「BaseURL 的 /v1 陷阱」）。
  baseUrl: 'https://api.deepseek.com',
  apiKey: '…9f3a',
  hasKey: true,
  // ★ 演示用的模型名由需求方指定（2026-10-02）。
  modelId: 'deepseek-flash'
}

const DEMO_EMBEDDING_DISPLAY: Readonly<Record<string, unknown>> = {
  mode: 'local_fastembed',
  baseUrl: null,
  apiKey: '',
  hasKey: false,
  modelId: null
}

/* ================================================================== *
 * 各端点的响应体（纯函数）
 * ================================================================== */

/** `GET /api/students/{id}`（学生一行）。 */
export function demoStudentBody(): Record<string, unknown> {
  const now = Date.now()
  return {
    studentId: DEMO_STUDENT_ID,
    nickname: DEMO_STUDENT_NICKNAME,
    gradeLevel: DEMO_GRADE_LEVEL,
    // 「用了两个月」：注册在约 60 天前，最后活跃就是现在
    createdAt: now - 60 * DAY_MS,
    lastActiveAt: now,
    currentChapter: DEMO_CHAPTER_TITLE
  }
}

/**
 * `GET /api/profile/{id}/tags`（画像标签 + 五行结构）。
 *
 * ★★ 2026-10-03 补（用户报障：「载入演示数据时候 画像部分你是不是忘记作假了」）：
 *   覆盖层此前**只拦了** `/api/profile/{id}`，而右栏画像那一块读的是**另外这个端点** ——
 *   于是它透传到真实后端，而演示学生没有画像数据 ⇒ 四个字段全走空态兜底文案
 *   （「还不知道你属于哪一种」「这个还没聊到」…）。用户看到的就是那份兜底。
 *
 * ★ 为什么连 `dimensionLabels` / `portraitRowKeys` / `portraitEmptyNotes` 一起给：
 *   这三张表是**后端唯一来源**（`contracts.py` 的 `TAG_DIMENSION_LABELS` /
 *   `PORTRAIT_ROW_KEYS` / `PORTRAIT_EMPTY_NOTES`），渲染层一个字都不自己拼 ——
 *   只给 `tags` 而不给表，渲染层就拼不出行标题（`portraitRowLabels[id] ?? ''` 会是空串）。
 *   表里的值**逐字对齐**后端，改后端那张表时这里要一起改。
 *
 * ⚠️ 每个 key 都必须在 `shared/profile-tags.ts` 的 `LLM_VISIBLE_TAGS` 白名单里 ——
 *   不在的会被 `readProfileTagsPayload` 静默丢掉（那一道是纵深防御，不是可绕过的）。
 */
export function demoProfileTagsBody(): Record<string, unknown> {
  const now = Date.now()
  /** 一条标签（形状与 `ProfileTagView` 同：key/value/confidence/source/ts/dimension/label）。 */
  const tag = (key: string, value: string, dimension: number, label: string): Record<string, unknown> => ({
    key,
    value,
    confidence: 0.82,
    // source 三档（declared / inferred / tag）：这些是引导问答里学生自己说的 → declared
    source: 'declared',
    ts: now - 2 * DAY_MS,
    dimension,
    label
  })
  return {
    tags: [
      // 维度 13「类型与性格」→ 五行里的 类型 / 性格
      tag('learner_style', '钻题型', 13, '学习类型'),
      tag('personality', '安静专注', 13, '性格'),
      // 维度 7「怎么讲更好」+ 维度 10「互动偏好」→ 五行里的 偏好
      tag('explain_style', '多打比方', 7, '讲解风格'),
      tag('pace', '慢一点', 7, '节奏'),
      tag('practice_type', '多做几道', 7, '练习方式'),
      tag('challenge_level', '先保基础', 10, '挑战度'),
      // 维度 8「兴趣与类比」+ 维度 11「场景与目标」→ 五行里的 兴趣
      tag('interest_topic', '机器人', 8, '感兴趣的话题'),
      tag('task_goal', '把机器学习的基础打牢', 11, '想达成什么')
    ],
    // 家长同意：预置态下**明说已同意**（否则画像卡上会出现一条要家长处理的提示）
    parentConsent: true,
    memorySwitch: true,
    // 维度序号 → 中文名（字符串化的序号，与后端 `TAG_DIMENSION_LABELS` 逐字一致）
    dimensionLabels: {
      '1': '学段与身份',
      '2': '在学什么',
      '3': '知识掌握',
      '4': '卡在哪里',
      '7': '怎么讲更好',
      '8': '兴趣与类比',
      '9': '此刻的心情',
      '10': '互动偏好',
      '11': '场景与目标',
      '12': '安全边界',
      '13': '类型与性格'
    },
    // 五行：行标题（`PORTRAIT_ROW_LABELS`）
    portraitRowLabels: {
      style: '类型',
      personality: '性格',
      preference: '偏好',
      interest: '兴趣',
      summary: '小结'
    },
    // 五行：每行从哪些键取数（`PORTRAIT_ROW_KEYS`；顺序即展示顺序）
    portraitRowKeys: {
      style: ['learner_style'],
      personality: ['personality'],
      preference: [
        'explain_style',
        'output_length',
        'pace',
        'practice_type',
        'tone',
        'encouragement_freq',
        'challenge_level'
      ],
      interest: ['interest_topic', 'scene', 'task_goal']
    },
    // 五行各自的空态文案（`PORTRAIT_EMPTY_NOTES`，逐字一致）
    portraitEmptyNotes: {
      style: '还不知道你属于哪一种，多练几道题我就看出来了。',
      personality: '这个还没聊到，你愿意说的话我就记下来。',
      preference: '还不知道你喜欢我怎么讲，告诉我一声？',
      interest: '还没发现你喜欢什么，跟我说说你感兴趣的事吧。',
      summary: '我们再聊几次，我就给你写一段小结。'
    }
  }
}

/**
 * 画像小结（第五行）的**预置正文**。
 *
 * ★★ 2026-10-03 补：主进程那条通道原本在沙箱态**故意回空串**
 *   （注释：「预置演示数据下没有真实画像变更，也就不会有小结」）——
 *   于是界面上摆的是空态那句「我们再聊几次，我就给你写一段小结」，
 *   而旁边四行都填着数据：**看着像"功能坏了"**。
 *   演示数据既然连偏好/兴趣都预置了，小结就没有理由空着（用户报障的原话就是这里）。
 *
 * ★ 文案口径与 `demoRecommendationBody` 的 summary 同源：说"练过还没稳"那件事，
 *   不用「AI 引擎」「画像」这类实现语言（学生面纪律）。
 * ⚠️ 与合成器产出的那份不同：这里是**预置文本**，不经过模型，也不落盘。
 */
export function demoProfileSummaryText(): string {
  return '这几轮聊下来，你偏好把过程画出来看，做题时愿意多想一步。已经练过 6 个知识点，其中 4 个还没完全稳住，下次可以从「强化学习」接着走。'
}

/**
 * `GET /api/profile/{id}/identity`（身份层：称呼 + 两道闸 + 引导状态）。
 *
 * ★★ 2026-10-03 用户报障「你那个名字什么的也应该替换成预设的名字吧 你做戏要做全套啊」——
 *   查出来的是**比"名字不统一"严重**的一件事：这条端点**既没有沙箱分支、也不在覆盖层里**，
 *   于是它透传到真实后端，把**本机真实学生的姓名**（`identity_local.real_name`，
 *   见 `server/app/store/learning.py`）回给了渲染层做本地替换。
 *   表现就是同一屏两个名字：侧栏/问候语用预置昵称，**右栏画像却挂着本机真名**。
 *   这既是"做戏没做全套"，也是**演示泄漏真实数据**。
 *
 * ★ `realName` 刻意留空：它的用途是「渲染层把 `{{student_name}}` 本地替换成真名」，
 *   演示没有真名可替换 —— 留空就是**不注入任何真实身份**（比编一个更安全）。
 * ★ `displayName` 与 {@link DEMO_STUDENT_NICKNAME} **同一个来源**：两处一旦漂，
 *   就又回到"侧栏一个名字、画像另一个名字"。
 * ★ `onboardingState: 'done'`：预置画像是个"用了两个月的老学生"，
 *   引导五问早该问完（否则首屏会弹引导卡，与预置数据打架）。
 */
export function demoIdentityBody(): Record<string, unknown> {
  return {
    anonStudentId: DEMO_STUDENT_ID,
    realName: '',
    displayName: DEMO_STUDENT_NICKNAME,
    parentConsent: true,
    memorySwitch: true,
    onboardingState: 'done'
  }
}

/** `GET /api/profile/{id}`（画像：学生 + 掌握度 + 偏好 + 推荐）。 */
export function demoProfileBody(): Record<string, unknown> {
  const now = Date.now()
  return {
    student: demoStudentBody(),
    mastery: demoMasteryRows(now),
    preferences: { ...DEMO_PREFERENCES },
    recommendedKpIds: DEMO_REVIEW_ITEMS.map((item) => item.kpId)
  }
}

/** `GET /api/profile/{id}/recommendation`（下一步学什么；来源 `review` = 先重练）。 */
export function demoRecommendationBody(): Record<string, unknown> {
  return {
    studentId: DEMO_STUDENT_ID,
    source: 'review',
    items: DEMO_REVIEW_ITEMS.map((item) => ({
      kpId: item.kpId,
      name: demoKpName(item.kpId),
      gradeLevel: DEMO_GRADE_LEVEL,
      // depth = 0：重练是「回到原地」，不是往下走一跳
      depth: 0,
      mastery: demoMasteryScoreOf(item.kpId),
      reason: item.reason
    })),
    summary: '有 4 个知识点练过还没稳住，建议先挑一个重练一遍。'
  }
}

/**
 * `GET /api/profile/{id}/opening`（新会话的开场引导）。
 *
 * ★ **响应键恰好四个**（`text` / `kpId` / `kpName` / `source`），多一个少一个都算改契约。
 * ★ `text` 里必须出现 `kpName` 原文：界面上的动作按钮拼的是「我想学『X』」，
 *   两处用同一个名字才不会出现「按钮点不开」。
 */
export function demoOpeningBody(): Record<string, unknown> {
  const opening = DEMO_REVIEW_ITEMS[0]
  const kpId = opening.kpId
  const kpName = demoKpName(kpId)
  return {
    text: `上次「${kpName}」那一关你只走到一半，今天要不要把它补完？点一下，我们就从那里接着往下走。`,
    kpId,
    kpName,
    source: 'review'
  }
}

/**
 * `GET /api/profile/{id}/report?days=N`（学习报告：学生 / 家长看的是同一份）。
 *
 * ★ `daily` 的日期**按「今天」现算**（本地日），最后一条就是今天 → `todayStudied` 为真。
 * ★ 窗口 `days` 天里只有 6 天有活动（没有活动的那天**不补 0**：铺满整周是界面的事）。
 * ★ 报告里的每个数都是上面那几张表算出来的，不存在第二处真相。
 */
export function demoReportBody(days: number): Record<string, unknown> {
  const now = Date.now()
  const today = new Date(now)
  const daily = DEMO_DAILY_ACTIVITY.filter((row) => row.offsetDays < days).map((row) => ({
    day: demoLocalDay(today, row.offsetDays),
    count: row.count,
    quizCount: row.quizCount,
    correctCount: row.correctCount
  }))
  return {
    studentId: DEMO_STUDENT_ID,
    nickname: DEMO_STUDENT_NICKNAME,
    gradeLevel: DEMO_GRADE_LEVEL,
    days,
    generatedAt: now,
    daily,
    totalActivities: daily.reduce((sum, row) => sum + row.count, 0),
    quizTotal: DEMO_QUIZ_TOTAL,
    quizCorrect: DEMO_QUIZ_CORRECT,
    streakDays: DEMO_STREAK_DAYS,
    todayStudied: daily.some((row) => row.day === demoLocalDay(today, 0)),
    mastery: demoMasteryRows(now),
    chapters: DEMO_CHAPTER_PROGRESS.map((row) => ({ ...row })),
    stageCounts: { ...DEMO_STAGE_COUNTS },
    badges: [...DEMO_BADGES],
    gradeHistory: demoGradeHistoryRows(now)
  }
}

/** `GET /api/quiz/mistakes/{id}`（错题本；`totalWrong` 与报告里的答错次数同源）。 */
export function demoMistakesBody(): Record<string, unknown> {
  const now = Date.now()
  const items = DEMO_MISTAKES.map((row) => ({
    kpId: row.kpId,
    kpName: demoKpName(row.kpId),
    chapterTitle: demoChapterOf(row.kpId),
    stem: row.stem,
    wrongCount: row.wrongCount,
    lastWrongAt: now - row.lastWrongAgoMs,
    lastQid: row.lastQid
  }))
  return {
    studentId: DEMO_STUDENT_ID,
    gradeLevel: DEMO_GRADE_LEVEL,
    items,
    totalWrong: items.reduce((sum, row) => sum + row.wrongCount, 0),
    // 每条错题都带题干（题干来自真实题库，没有「答错但没题干」的那一类）
    withoutStem: 0
  }
}

/** `GET /api/knowledge/chapters/{grade}`（章节清单；每章的关卡数与掌握数来自进度行）。 */
export function demoChaptersBody(gradeLevel: string): Record<string, unknown> {
  return {
    gradeLevel,
    chapters: DEMO_CHAPTER_PROGRESS.map((row) => ({
      chapterTitle: row.chapterTitle,
      kpCount: row.kpCount,
      kpIds: [...(DEMO_CHAPTER_KP_IDS[row.chapterTitle] ?? [])],
      masteredCount: row.masteredCount
    })),
    // 带上了学生进度：界面据此显示「3/3 已掌握」而不是「3 个知识点」
    withProgress: true
  }
}

/** `GET /api/graph/overview/{grade}`（依赖图全览；节点与边是真实资产，只有掌握态是学生态）。 */
export function demoGraphBody(gradeLevel: string): Record<string, unknown> {
  return {
    gradeLevel,
    nodes: DEMO_KP_IDS.map((kpId) => ({
      kpId,
      name: demoKpName(kpId),
      gradeLevel: DEMO_GRADE_LEVEL,
      chapterTitle: demoChapterOf(kpId),
      layer: DEMO_GRAPH_LAYERS[kpId] ?? 0,
      mastered: DEMO_MASTERED_SET.has(kpId)
    })),
    edges: DEMO_GRAPH_EDGE_PAIRS.map(([fromKpId, toKpId]) => ({
      fromKpId,
      toKpId,
      relation: 'related',
      weight: 0.6
    }))
  }
}

/** `GET /api/quiz/progress/{id}`（闯关进度；`levels` 与报告、闯关页共用同一份）。 */
export function demoQuizProgressBody(): Record<string, unknown> {
  return {
    studentId: DEMO_STUDENT_ID,
    gradeLevel: DEMO_GRADE_LEVEL,
    seeded: DEMO_PROGRESS_LEVELS.length,
    levels: DEMO_PROGRESS_LEVELS.map((row) => ({ ...row }))
  }
}

/** `GET /api/quiz/generated/{id}`（「智团团给我出过的题」；**没有答案字段**）。 */
export function demoQuizGeneratedBody(): Record<string, unknown> {
  return {
    kpId: DEMO_GENERATED_KP_ID,
    questions: DEMO_GENERATED_QUESTIONS.map((row) => ({
      qid: row.qid,
      kpId: row.kpId,
      type: row.type,
      stem: row.stem,
      options: row.options === null ? null : [...row.options]
    })),
    source: 'generated'
  }
}

/** `GET /api/animation/saved/{id}`（动画库清单；**不含 `html`**）。 */
export function demoSavedAnimationListBody(): Record<string, unknown> {
  const now = Date.now()
  const items = DEMO_SAVED_ANIMATIONS.map((row) => demoSavedAnimationItem(row, now))
  return {
    studentId: DEMO_STUDENT_ID,
    gradeLevel: DEMO_GRADE_LEVEL,
    kpId: null,
    items,
    total: items.length
  }
}

/**
 * `GET /api/animation/saved/{id}/{savedId}`（取一条，**带 `html`**）。
 *
 * ★ `rendered` 由调用方（覆盖层）从**真实渲染端点**取来注入：本文件不发网络，
 *   IO 留在 `demo/animation.ts`。真实那边库里存着的是成品 HTML，而演示**不落盘**
 *   （磁盘上没有任何文件可读），所以这里按登记的知识点**现渲染一份真模板产物**。
 * ★★ 没有产物时 `html` 就是**空串**，这里**绝不编一份 HTML 顶上**：
 *   编出来的动画在沙箱里跑不起来（现场是一整块空白），而渲染侧两条路都已有
 *   「没有 HTML 就显示 `fallbackText`」的降级路径 —— 那才是诚实的行为。
 * ★ 认不出 `savedId` → `null`（覆盖层会当作「未命中」透传，而不是回一条错的东西）。
 */
export function demoSavedAnimationItemBody(
  savedId: string,
  rendered: DemoSavedAnimationRender | null = null
): Record<string, unknown> | null {
  const row = demoSavedAnimationRow(savedId)
  if (row === null) return null
  return {
    ...demoSavedAnimationItem(row, Date.now()),
    html: rendered?.html ?? '',
    // ★ 只在这种情况带 `payloadId`：它是从产物里读回来的那把防串台 id
    //   （沙箱按它认消息）。没有产物时带一个空串，等于给渲染侧一个假身份。
    ...(rendered === null ? {} : { payloadId: rendered.payloadId })
  }
}

/**
 * `GET /api/grade/state/{id}`（轻量学段状态；每轮取一次「当前学段」）。
 *
 * ★ `decidedBy: 'llm'` 是**界面显示「AI 引擎判定」的唯一开关**：
 *   渲染侧读学段的判据在 `main/ipc/handlers.ts` 的 `readGradeState()`
 *   （`source === 'explicit'` → 手动；`decidedBy === 'llm'` → `origin = 'llm'`
 *   → 文案「AI 引擎判定」；`decidedBy === 'rules' || source === 'inferred'` → 「本地规则判定」）。
 *   `source` 仍是 `inferred`：写入方依然是**系统**而不是学生手选 ——
 *   「谁写的」（source）与「哪一层判的」（decidedBy）是两个轴，别混成一条。
 * ★ `cumulativeTurns` / `lastTurn` 都是 31（跨会话连续）：早已越过
 *   `LLM_DECIDES_FROM_TURN`（第 5 轮）那条「请 AI 复核」的水位线。
 * ★ `lastChangeTurn: 27`：最后一次改判发生在第 27 轮（见 `DEMO_GRADE_HISTORY` 的最后一条），
 *   之后过了 4 轮 —— 已经走完自动冷却窗口（`COOLDOWN_TURNS` = 5），所以
 *   `cooldownRemainingTurns` 是 0（没有手动设定，也就不存在 10 轮的手动冷却）。
 * ★ 31 这个数**跟着脚本轮数走**：缓冲区末轮 = 预置历史 9 + 脚本 4 + 偏移 =
 *   累计第 31 轮（偏移的来路见 `script.ts` 的 `DEMO_TURN_OFFSET`）。脚本轮数一改，
 *   这里与偏移表达式要一起改 —— 两处对不上的表现是信箱里的「第几轮」与顶栏不一致。
 * ★ `streak: 2` / `direction: 1`：末尾 2 轮同向（都偏浅），但还不够 3 轮 →
 *   没有待生效的调整（`suggestedLevel` 为空，不是「被挡住」，是「证据还不够」）。
 *   ★ 与 `DEMO_GRADE_SIGNALS` 的那四条同源：词汇 / 深度两条各 +0.5 指向「讲浅了」。
 *
 * ⚠️ **已知缺口（留给接线人，本文件管不到）**：演示态下顶栏那枚 chip 与「我选年级」
 *   读的是 `IPC.gradeGet`，而那条通道的**沙箱分支**（`main/ipc/handlers.ts` 里
 *   `if (isDemoSeeded())` 那一段）直接把 `origin` / `decidedBy` 硬编码成 `'rules'`，
 *   并**不**经过本响应体（它刻意不走 `ensureChatRuntime()`，见那段注释）。
 *   所以本文件把 `decidedBy` 改成 `llm` 之后，「运行透视 / 学习报告 / 推送路径」显示
 *   「AI 引擎判定」，而顶栏 chip 仍会显示「本地规则判定」—— 要让两者一致，
 *   需要把那条沙箱分支的 `origin` / `decidedBy` 一起改成 `'llm'`（一处两行）。
 */
export function demoGradeStateBody(): Record<string, unknown> {
  return {
    studentId: DEMO_STUDENT_ID,
    grade: DEMO_GRADE_LEVEL,
    source: 'inferred',
    decidedBy: 'llm',
    cumulativeTurns: 31,
    lastTurn: 31,
    lastChangeTurn: 27,
    cooldownRemainingTurns: 0,
    streak: 2,
    direction: 1,
    confidence: DEMO_GRADE_CONFIDENCE,
    suggestedLevel: null
  }
}

/** `GET /api/grade/signals/{id}`（学段信号与推断检视面；右栏那四路）。 */
export function demoGradeSignalsBody(): Record<string, unknown> {
  const now = Date.now()
  return {
    studentId: DEMO_STUDENT_ID,
    currentLevel: DEMO_GRADE_LEVEL,
    source: 'inferred',
    suggestedLevel: null,
    confidence: DEMO_GRADE_CONFIDENCE,
    signals: DEMO_GRADE_SIGNALS.map((row) => ({
      signalType: row.signalType,
      value: row.value,
      raw: row.raw,
      ts: now - row.agoMs
    }))
  }
}

/** `GET /api/grade/history/{id}`（学段轨迹；报告里的 `gradeHistory` 与它同一份）。 */
export function demoGradeHistoryBody(): Record<string, unknown> {
  return {
    studentId: DEMO_STUDENT_ID,
    currentLevel: DEMO_GRADE_LEVEL,
    entries: demoGradeHistoryRows(Date.now())
  }
}

/** `GET` / `PUT /api/profile/{id}/chapter`（当前章节；学段与章名一起回）。 */
export function demoChapterBody(): Record<string, unknown> {
  return {
    gradeLevel: DEMO_GRADE_LEVEL,
    chapterTitle: DEMO_CHAPTER_TITLE
  }
}

/** `GET /api/settings`（设置显示态；Key 只回掩码，**一个明文字符都没有**）。 */
export function demoSettingsBody(): Record<string, unknown> {
  return {
    llm: { ...DEMO_LLM_DISPLAY },
    embedding: { ...DEMO_EMBEDDING_DISPLAY }
  }
}

/**
 * `session:list` 的沙箱回执（侧栏「历史对话」）。
 *
 * ★ 返回的是**数组**（与 `handlers.ts` 里 `projectSessionTree(...)` 的产物同形，
 *   渲染进程直接吃），不是包一层对象。
 * ★ 顺序 = `modifiedAt` 降序（最新的一条在最前），平局按 id 兜底 ——
 *   与真实投影 `projectSessionList` 的排序口径一字不差。
 * ★ `parentId` / `parentTitle` 恒为空：这三条都是独立会话，没有从谁那里分出来。
 * ★ `createdAt` 比 `modifiedAt` 早一点（一条两句话的会话不会持续几小时）。
 */
export function demoSessionListBody(): Array<Record<string, unknown>> {
  const now = Date.now()
  return DEMO_SESSIONS.map((session) => {
    const modifiedAt = now - session.agoMs
    return {
      id: session.id,
      title: session.title,
      messageCount: session.messageCount,
      modifiedAt,
      createdAt: modifiedAt - DEMO_SESSION_SPAN_MS,
      preview: DEMO_SESSION_PREVIEWS[session.id] ?? '',
      parentId: null,
      parentTitle: null
    }
  }).sort(
    (left, right) =>
      Number(right.modifiedAt) - Number(left.modifiedAt) ||
      String(left.id).localeCompare(String(right.id))
  )
}
