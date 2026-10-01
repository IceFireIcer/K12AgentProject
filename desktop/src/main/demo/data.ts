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

/** 初中（本沙箱使用的学段）。 */
export const DEMO_GRADE_LEVEL = 'junior'

/** 学生昵称（**唯一一处真相**：学生响应体、画像、报告都引它，不许两处各写一遍）。 */
export const DEMO_STUDENT_NICKNAME = '小同'

/** 学生 id（白名单字符集，与 `student_id` 同形；不采集任何真实身份信息）。 */
const DEMO_STUDENT_ID = 'student_001'

/** 学生当前在学的章节（= 真实章名之一；学生响应体与章节响应体都引它）。 */
export const DEMO_CHAPTER_TITLE = '第8章 编程实践（补充）'

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
 * 初中教材的**全部知识点**（逐字来自随包 `kb.sqlite` 的 `kp` 表）。
 *
 * - 章的**顺序 = 教材定义序**（第 1 章 → 第 8 章，与服务端解析「第N章」里那个 N 同口径）；
 * - 每章内**按 `kp_id` 排**（服务端 `chapters_by_grade` 就是 `ORDER BY kp_id`，
 *   不是入库顺序——入库顺序随文件名变化，同章的列表会无缘无故重排）；
 * - 第 8 章的键**引 `DEMO_CHAPTER_TITLE`**：章节名一旦要改，只改那一处。
 */
export const DEMO_CHAPTER_KP_IDS: Readonly<Record<string, readonly string[]>> = {
  '第1章 人工智能的基础概念': [
    'ai-definition-jr',
    'ai-hierarchy-jr',
    'ai-three-values-jr',
    'genai-jr',
    'narrow-ai-jr',
    'strong-ai-agi-jr'
  ],
  '第2章 人工智能三大底层支柱(AI的构造地基)': [
    'algorithm-jr',
    'computing-power-jr',
    'data-jr',
    'data-processing-jr',
    'hardware-accelerator-jr',
    'training-inference-jr'
  ],
  '第3章 核心技术分支': [
    'artificial-neuron-jr',
    'computer-vision-jr',
    'deep-learning-jr',
    'machine-learning-jr',
    'neural-network-jr',
    'nlp-jr',
    'reinforcement-learning-jr',
    'speech-recognition-jr',
    'speech-synthesis-jr',
    'supervised-learning-jr',
    'token-jr',
    'transformer-jr',
    'unsupervised-learning-jr'
  ],
  '第4章 大模型与AI智能体Agent': [
    'agent-action-jr',
    'agent-perception-jr',
    'agent-planning-jr',
    'agent-reflection-jr',
    'agent-tool-use-jr',
    'llm-jr',
    'long-term-memory-jr',
    'prompt-jr',
    'rag-jr',
    'short-term-memory-jr'
  ],
  '第5章 人工智能主要应用领域': [
    'aigc-media-jr',
    'autonomous-driving-jr',
    'edu-agent-jr',
    'edu-mistake-review-jr',
    'edu-notes-mindmap-jr',
    'edu-preview-review-jr',
    'edu-qa-jr',
    'industrial-inspection-jr',
    'medical-imaging-jr',
    'voice-assistant-jr'
  ],
  '第6章 人工智能的局限性': [
    'limit-hallucination-jr',
    'limit-interaction-jr',
    'limit-knowledge-cutoff-jr',
    'limit-teaching-jr',
    'limit-understanding-jr'
  ],
  '第7章 人工智能伦理与安全': [
    'ethics-anti-misuse-jr',
    'ethics-fairness-jr',
    'ethics-information-jr',
    'ethics-privacy-jr'
  ],
  [DEMO_CHAPTER_TITLE]: ['prog-list-jr', 'prog-loop-jr', 'prog-variable-jr']
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
  'ai-definition-jr': '人工智能的定义',
  'ai-hierarchy-jr': 'AI 技术的包含层级关系',
  'ai-three-values-jr': '模拟、延伸、扩展：AI 的三层价值',
  'genai-jr': '生成式大模型（GenAI）',
  'narrow-ai-jr': '弱人工智能（专用 AI）',
  'strong-ai-agi-jr': '强人工智能（AGI）',
  // 第 2 章
  'algorithm-jr': '算法',
  'computing-power-jr': '算力',
  'data-jr': '数据',
  'data-processing-jr': '数据处理流程',
  'hardware-accelerator-jr': '硬件载体：GPU / CPU / TPU',
  'training-inference-jr': '训练阶段与推理阶段',
  // 第 3 章
  'artificial-neuron-jr': '人工神经元',
  'computer-vision-jr': '计算机视觉（CV）',
  'deep-learning-jr': '深度学习（DL）',
  'machine-learning-jr': '机器学习（ML）',
  'neural-network-jr': '神经网络',
  'nlp-jr': '自然语言处理（NLP）',
  'reinforcement-learning-jr': '强化学习',
  'speech-recognition-jr': '语音识别（ASR）',
  'speech-synthesis-jr': '语音合成（TTS）',
  'supervised-learning-jr': '监督学习',
  'token-jr': 'Token',
  'transformer-jr': 'Transformer 架构',
  'unsupervised-learning-jr': '无监督学习',
  // 第 4 章
  'agent-action-jr': '执行模块',
  'agent-perception-jr': '感知模块',
  'agent-planning-jr': '规划模块',
  'agent-reflection-jr': '反思模块',
  'agent-tool-use-jr': '工具调用模块',
  'llm-jr': '大语言模型（LLM）',
  'long-term-memory-jr': '长期记忆',
  'prompt-jr': 'Prompt 提示词',
  'rag-jr': 'RAG 检索增强生成（外挂知识库）',
  'short-term-memory-jr': '短期记忆',
  // 第 5 章
  'aigc-media-jr': '文生图 / 文生视频（AIGC）',
  'autonomous-driving-jr': '自动驾驶',
  'edu-agent-jr': 'AI 教育智能体',
  'edu-mistake-review-jr': '错题复盘',
  'edu-notes-mindmap-jr': '自动生成讲义、思维导图',
  'edu-preview-review-jr': '预习复习',
  'edu-qa-jr': '智能答疑',
  'industrial-inspection-jr': '工业质检',
  'medical-imaging-jr': '医疗影像识别',
  'voice-assistant-jr': '语音助手',
  // 第 6 章
  'limit-hallucination-jr': '模型幻觉',
  'limit-interaction-jr': '交互短板',
  'limit-knowledge-cutoff-jr': '知识截止',
  'limit-teaching-jr': '教学短板（难自动分层适配）',
  'limit-understanding-jr': '理解局限',
  // 第 7 章
  'ethics-anti-misuse-jr': '防滥用：防止学生直接抄答案',
  'ethics-fairness-jr': '公平性：面向不同人群适配',
  'ethics-information-jr': '信息真实性校验',
  'ethics-privacy-jr': '用户隐私保护（学生学习数据）',
  // 第 8 章
  'prog-list-jr': '列表与字典：把一批数据放在一起',
  'prog-loop-jr': '循环：重复的事交给机器',
  'prog-variable-jr': '变量：给数据起名字'
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
export const DEMO_LOOP_SESSION_ID = 'sess-loop-9c41'
/** 「那用代码试试」那条会话的 id（回看时带一张编程卡）。 */
export const DEMO_CODE_SESSION_ID = 'sess-code-7b25'
/** 「这几道题我错了」那条会话的 id（回看时带一张闯关卡）。 */
export const DEMO_QUIZ_SESSION_ID = 'sess-quiz-3e08'

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
  { id: DEMO_LOOP_SESSION_ID, title: '列表是怎么工作的', messageCount: 2, agoMs: 26 * HOUR_MS },
  { id: DEMO_CODE_SESSION_ID, title: '那用代码试试', messageCount: 2, agoMs: 25 * HOUR_MS },
  { id: DEMO_QUIZ_SESSION_ID, title: '这几道题我错了', messageCount: 2, agoMs: 2 * HOUR_MS }
]

/**
 * 每条会话的**首条消息预览**（列表那一列显示的就是它）。
 *
 * ★ 与 `main/demo/script.ts` 里三句学生原话是同一份文案：两处各写一句的话，
 *   「列表上看到的开头」与「点进去看到的第一句」迟早不是同一句。
 * ★ 每个会话的创建时间比最后修改时间早一点（一条两句话的会话不会持续几小时）。
 */
const DEMO_SESSION_PREVIEWS: Readonly<Record<string, string | undefined>> = {
  [DEMO_LOOP_SESSION_ID]: '老师，列表里的数是怎么排好顺序的？',
  [DEMO_CODE_SESSION_ID]: '那我们用代码试试？',
  [DEMO_QUIZ_SESSION_ID]: '我想做几道题检验一下。'
}

/** 会话「创建 → 最后修改」之间的跨度（两句话的会话，分钟级）。 */
const DEMO_SESSION_SPAN_MS = 4 * MINUTE_MS

/* ------------------------------------------------------------------ *
 * 掌握度（画像 + 报告共用这一份）
 * ------------------------------------------------------------------ */

/**
 * 掌握度明细（**与「现在」无关的稳定常量**，按分数降序 = 服务端 `ORDER BY score DESC`）。
 *
 * ★ `score` 是**逐次作答累积出来的平滑值**（答对 +0.15 / 答错 −0.10，且钳在 0..1），
 *   不是 `correct / attempts` 的商 —— 所以它无法由后两列反算，两列也不用凑出商。
 * ★ `attempts = correct + 答错次数`：答错的 13 次全部落在第 8 章那三关上
 *   （见 `DEMO_MISTAKES`），其余各关都是答对过的。
 * ★ 三列合计 = 58 次作答 / 45 次答对（= `DEMO_QUIZ_TOTAL` / `DEMO_QUIZ_CORRECT`），
 *   答错 58 − 45 = 13 次 = `DEMO_MISTAKES` 的错次之和 —— 报告与错题本因此是同一个故事。
 */
export const DEMO_MASTERY: readonly {
  kpId: string
  score: number
  attempts: number
  correct: number
}[] = [
  { kpId: 'prog-list-jr', score: 0.92, attempts: 12, correct: 9 },
  { kpId: 'ai-definition-jr', score: 0.86, attempts: 3, correct: 3 },
  { kpId: 'prog-loop-jr', score: 0.85, attempts: 12, correct: 6 },
  { kpId: 'machine-learning-jr', score: 0.84, attempts: 3, correct: 3 },
  { kpId: 'ai-three-values-jr', score: 0.82, attempts: 3, correct: 3 },
  { kpId: 'neural-network-jr', score: 0.78, attempts: 3, correct: 3 },
  { kpId: 'llm-jr', score: 0.7, attempts: 3, correct: 3 },
  { kpId: 'computing-power-jr', score: 0.66, attempts: 2, correct: 2 },
  { kpId: 'edu-qa-jr', score: 0.64, attempts: 2, correct: 2 },
  { kpId: 'prompt-jr', score: 0.62, attempts: 2, correct: 2 },
  { kpId: 'limit-hallucination-jr', score: 0.6, attempts: 2, correct: 2 },
  { kpId: 'prog-variable-jr', score: 0.6, attempts: 7, correct: 3 },
  { kpId: 'narrow-ai-jr', score: 0.4, attempts: 1, correct: 1 },
  { kpId: 'data-jr', score: 0.26, attempts: 1, correct: 1 },
  { kpId: 'supervised-learning-jr', score: 0.22, attempts: 1, correct: 1 },
  { kpId: 'rag-jr', score: 0.15, attempts: 1, correct: 1 }
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
  'prog-list-jr': 3 * DAY_MS,
  'ai-definition-jr': 5 * DAY_MS,
  'prog-loop-jr': 2 * HOUR_MS,
  'machine-learning-jr': 4 * DAY_MS,
  'ai-three-values-jr': 5 * DAY_MS,
  'neural-network-jr': 4 * DAY_MS,
  'llm-jr': 2 * DAY_MS,
  'computing-power-jr': 3 * DAY_MS,
  'edu-qa-jr': 1 * DAY_MS,
  'prompt-jr': 2 * DAY_MS,
  'limit-hallucination-jr': 3 * DAY_MS,
  'prog-variable-jr': 25 * HOUR_MS,
  'narrow-ai-jr': 5 * DAY_MS,
  'data-jr': 4 * DAY_MS,
  'supervised-learning-jr': 3 * DAY_MS,
  'rag-jr': 2 * DAY_MS
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
 * ★ 第 8 章那三关都在里面：学生最近在学编程实践，练得最多（见 `DEMO_MASTERY`）。
 * ★ 服务端的状态机只有 `learning → quizzed → mastered`（**不再产出 `locked`**：
 *   所有关卡一开始就可作答，冷启动全部播种成 `learning`）。
 */
const DEMO_MASTERED_KP_IDS: readonly string[] = [
  'ai-definition-jr',
  'ai-three-values-jr',
  'computing-power-jr',
  'machine-learning-jr',
  'neural-network-jr',
  'llm-jr',
  'prompt-jr',
  'edu-qa-jr',
  'limit-hallucination-jr',
  'prog-variable-jr',
  'prog-loop-jr',
  'prog-list-jr'
]

/** 已测验但还没掌握的 4 关（`stage = quizzed`）—— 推荐「重练」就是从这几关里出。 */
const DEMO_QUIZZED_KP_IDS: readonly string[] = [
  'narrow-ai-jr',
  'data-jr',
  'supervised-learning-jr',
  'rag-jr'
]

/**
 * 徽章：**只有第 8 章那三关有**，且三关都是 `mastered`。
 *
 * ★ 徽章文本的形态是服务端定的：`档位-答对题数`，档位取自那五档
 *   `起步 / 初通 / 熟练 / 精通 / 大师`。下面这三条里的 `-N`
 *   与 `DEMO_MASTERY` 里**同一关的 `correct`** 是同一个数
 *   （练得越多档位越高，三关正好落在初通 / 熟练 / 精通）。
 * ★ 徽章是「曾经通关」的事实，答错不会把它抹掉 —— 所以它与 `stage` 一样只增不减。
 */
const DEMO_BADGE_BY_KP: Readonly<Record<string, string | undefined>> = {
  'prog-variable-jr': '初通-3',
  'prog-loop-jr': '熟练-6',
  'prog-list-jr': '精通-9'
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
 * ★ 题干是**该 kp 真实题目的题干原文**（`preset-content/quizbank/ch08.json`，
 *   按 `lastQid` 那一题的 `stem` 逐字抄；服务端入库的也是题干前 120 字）。
 * ★ 三条错次 6 / 4 / 3 合计 **13** = `DEMO_QUIZ_TOTAL − DEMO_QUIZ_CORRECT`：
 *   报告里的「答错 13 次」与错题本的「累计答错 13 次」是同一个数。
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
    kpId: 'prog-loop-jr',
    lastQid: 'prog-loop-jr-q2',
    stem: '重复次数事先不知道、要靠条件决定停不停（比如一直猜到对为止），应该用哪种循环？',
    wrongCount: 6,
    lastWrongAgoMs: 2 * HOUR_MS
  },
  {
    kpId: 'prog-variable-jr',
    lastQid: 'prog-variable-jr-q3',
    stem: '程序里的变量和数学里的 x，最大的不同是什么？',
    wrongCount: 4,
    lastWrongAgoMs: 25 * HOUR_MS
  },
  {
    kpId: 'prog-list-jr',
    lastQid: 'prog-list-jr-q1',
    stem: '有一份按顺序排好的分数 scores，要取第一个元素，应该写哪个？',
    wrongCount: 3,
    lastWrongAgoMs: 3 * DAY_MS
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
 * ★ 6 天**连成一片**（0..5），所以「连续学习 6 天」与这张表是同一件事
 *   （今天是最后一条 → `todayStudied = true`）。
 * ★ 每天的活动数 ≥ 当天的答题数（答题本身也是一条活动，不可能比活动总数还多）。
 * ★ 6 天合计：65 条活动 / 58 次答题 / 45 次答对 —— 后两个数与
 *   `DEMO_QUIZ_TOTAL` / `DEMO_QUIZ_CORRECT`（= 掌握度表合计）**同一个数**。
 */
const DEMO_DAILY_ACTIVITY: readonly {
  offsetDays: number
  count: number
  quizCount: number
  correctCount: number
}[] = [
  { offsetDays: 5, count: 7, quizCount: 6, correctCount: 4 },
  { offsetDays: 4, count: 9, quizCount: 8, correctCount: 6 },
  { offsetDays: 3, count: 12, quizCount: 11, correctCount: 9 },
  { offsetDays: 2, count: 10, quizCount: 9, correctCount: 7 },
  { offsetDays: 1, count: 11, quizCount: 10, correctCount: 8 },
  { offsetDays: 0, count: 16, quizCount: 14, correctCount: 11 }
]

/** 连续学习天数（= 上面那 6 个连续的日子，今天在内）。 */
const DEMO_STREAK_DAYS = 6

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
 * ★ 0.85 是最近一次判定（第 13 轮 AI 引擎复核）的置信度：判定 prompt 要求自报
 *   0.6 以上才算有把握，复核报的是 0.85 —— 比规则层能给出的**上限** 0.9 略低，
 *   留下了一点余地（复核没有把话说满）。
 * ★ 规则层同一窗口只给到 0.75（末尾三轮同向、强度各 0.5，
 *   口径 `min(0.9, 平均强度 × 1.5)`）—— 复核把置信度抬了上去，这正是
 *   「AI 引擎判定」与「本地规则判定」在数据上的差别之一。
 * ★ 声明在轨迹 / 信号两张表**之前**：它们都要引它（`const` 有暂时性死区，
 *   写在后面会在模块加载时直接抛错）。
 */
const DEMO_GRADE_CONFIDENCE = 0.85

/**
 * 学段变化轨迹（第一条是**冷启动基线**：`fromLevel` 为空 = 学生还没有「上一段」）。
 *
 * ★ 故事（一条可读的轨迹：基线 → 规则层两次调整 → **AI 引擎复核改判** → 稳定）：
 *   ① 第 1 轮 冷启动基线 → 小学高年级。基线值是**当时**的冷启动默认值
 *      （服务端 2026-09-22 起才把默认值改成初中），这条基线写于 60 天前，
 *      所以它保留旧默认值是如实的；
 *   ② 第 3 轮 规则层**下调**到小学低年级：开头几轮学生连着说「太难了 / 听不懂」，
 *      元认知那一路指向下走（这一轮还没到 LLM 接管的累计第 5 轮）；
 *   ③ 第 8 轮 规则层**调回**小学高年级：术语与提问深度两路证据攒够了；
 *   ④ 第 13 轮 **AI 引擎复核判定为初中**（`decidedBy: 'llm'`）：累计轮次早已越过
 *      `LLM_DECIDES_FROM_TURN`（第 5 轮），这一轮由复核层定方向。
 *   ★ 相邻两次自动调整都隔 ≥5 轮（`COOLDOWN_TURNS`），所以第 3 / 8 / 13 轮各动一次；
 *     基线那行（`fromLevel` 为空）**不参与冷却**，所以第 3 轮动得起来。
 *   ★ 最后一次在第 13 轮、当前是第 18 轮 → 与 `demoGradeStateBody()` 的
 *     `lastTurn: 18` / `lastChangeTurn: 13` / `cooldownRemainingTurns: 0` 一一对应。
 * ★ 置信度只升不降（0 / 0.75 / 0.75 / 0.85）：规则层两次都是「三轮同向、强度各 0.5」，
 *   按 `min(0.9, 0.5 × 1.5)` 得 0.75；最后一次是复核自报的 0.85（= `DEMO_GRADE_CONFIDENCE`）。
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
    raw: '正确率=0.78;样本=近一周 58 题',
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
 * ★ 就是那 4 个 `quizzed` 的关卡，按掌握度**从低到高**排 —— 最弱的一关在最前面，
 *   开场引导指的也是它（服务端那边开场语与推荐结论出自同一个函数）。
 */
const DEMO_REVIEW_ITEMS: readonly { kpId: string; reason: string }[] = [
  { kpId: 'rag-jr', reason: '练过但还没稳住，先把外挂知识库这条线走一遍。' },
  { kpId: 'supervised-learning-jr', reason: '概念容易混，先分清「有标签」和「没标签」。' },
  { kpId: 'data-jr', reason: '只做过一道题，趁热把数据这一关补上。' },
  { kpId: 'narrow-ai-jr', reason: '差一点就过了，再来两道就能拿下徽章。' }
]

/* ------------------------------------------------------------------ *
 * 动画库
 * ------------------------------------------------------------------ */

/**
 * 「我的动画」两条。
 *
 * ★ `html` **不在这里编**（见 `demoSavedAnimationItemBody`）：它由覆盖层从**真实渲染端点**
 *   取来注入（`demo/animation.ts`）；取不到时渲染侧既有的降级路径会显示 `fallbackText`，
 *   那才是诚实的行为。
 * ★★ `concept` **必须与渲染端点返回的 `concept` 逐字相同**（这两条分别是 `python-loop` /
 *    `python-variable` 模板的产物）：渲染侧 `cards/InlineCard.vue` 的 `savedMatch` 是拿
 *   **卡片载荷的 concept + 学段**去库里对记录的 —— 库里写成教材那一节的长标题
 *   （「循环：重复的事交给机器」）时，卡片上那颗「我的」按钮永远灰着。
 *   所以这里取**模板自己声明的概念名**，`title` 才是那个有区分度的说法。
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
    id: 'anim-loop-3ways',
    kpId: 'prog-loop-jr',
    // ★ 逐字取自 `python-loop` 模板的 `concept`（真实渲染端点返回的就是这个）——
    //   写成教材小节标题会让卡片上的「我的」永远对不上（见上面那段）。
    concept: '循环',
    promptHash: '29080e6f87d3370dce8cafa8e3173a923d7e5adc',
    title: '循环的三种问法',
    durationMs: 12_000,
    fallbackText:
      '循环把「重复做的事」和「什么时候停」分开写：重复的动作放在循环体里，停下来的条件写在开头。次数知道的用 for，次数靠条件决定的用 while，两种写法都能把同一件事重复做完。',
    createdAtAgoMs: 26 * HOUR_MS,
    uses: 3
  },
  {
    id: 'anim-variable-basics',
    kpId: 'prog-variable-jr',
    // ★ 逐字取自 `python-variable` 模板的 `concept`（同上）。
    concept: '变量',
    promptHash: 'd1c665e1f52e9e215dfd47afcb64c25d2dcaf156',
    title: '什么是变量',
    durationMs: 9_000,
    fallbackText:
      '变量是给一份数据起的名字。起好名字以后，读它、改它都用这个名字：赋值就是把新值放进这个名字里，旧值随之被覆盖。名字取得能看懂，代码读起来就像一句话。',
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
 */
const DEMO_GENERATED_KP_ID = 'prog-loop-jr'

const DEMO_GENERATED_QUESTIONS: readonly {
  qid: string
  kpId: string
  type: string
  stem: string
  options: readonly string[] | null
}[] = [
  {
    qid: 'gen-4f2a91c7',
    kpId: DEMO_GENERATED_KP_ID,
    type: 'choice',
    stem: '循环跑完一轮之后，下面哪一步是必须做的？',
    options: ['检查结束条件，决定要不要再来一轮', '把计数变量清零', '重新写一遍循环体']
  },
  {
    qid: 'gen-b7c3d0e5',
    kpId: DEMO_GENERATED_KP_ID,
    type: 'code_blank',
    stem: '补全下面这段代码，让它把 1 到 5 依次打印出来。\n\nfor i in range(1, 6):\n    print(______)',
    options: null
  }
]

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
 * 初中内部的**全部 78 条依赖边**（当前教材里这一层全是 `related`、权重 0.6）。
 *
 * ★ 只保留**两端都在本学段**的边（跨学段的边在单学段视图里没有落点）——
 *   与服务端 `/api/graph/overview/{grade}` 的过滤口径一致。
 * ★ 图谱的**分层**由这些边现算（服务端也是现算的），见 `demoGraphLayers`。
 */
const DEMO_GRAPH_EDGE_PAIRS: readonly (readonly [string, string])[] = [
  ['agent-action-jr', 'edu-notes-mindmap-jr'],
  ['agent-perception-jr', 'agent-planning-jr'],
  ['agent-planning-jr', 'agent-reflection-jr'],
  ['agent-planning-jr', 'agent-tool-use-jr'],
  ['agent-reflection-jr', 'limit-hallucination-jr'],
  ['agent-tool-use-jr', 'agent-action-jr'],
  ['ai-definition-jr', 'ai-hierarchy-jr'],
  ['ai-definition-jr', 'ai-three-values-jr'],
  ['ai-hierarchy-jr', 'deep-learning-jr'],
  ['ai-hierarchy-jr', 'genai-jr'],
  ['ai-hierarchy-jr', 'machine-learning-jr'],
  ['algorithm-jr', 'machine-learning-jr'],
  ['artificial-neuron-jr', 'neural-network-jr'],
  ['computer-vision-jr', 'agent-perception-jr'],
  ['computer-vision-jr', 'autonomous-driving-jr'],
  ['computer-vision-jr', 'industrial-inspection-jr'],
  ['computer-vision-jr', 'medical-imaging-jr'],
  ['computing-power-jr', 'algorithm-jr'],
  ['computing-power-jr', 'hardware-accelerator-jr'],
  ['computing-power-jr', 'training-inference-jr'],
  ['data-jr', 'algorithm-jr'],
  ['data-jr', 'data-processing-jr'],
  ['data-jr', 'prog-list-jr'],
  ['data-jr', 'prog-variable-jr'],
  ['data-processing-jr', 'limit-hallucination-jr'],
  ['deep-learning-jr', 'artificial-neuron-jr'],
  ['deep-learning-jr', 'neural-network-jr'],
  ['edu-agent-jr', 'edu-qa-jr'],
  ['edu-agent-jr', 'ethics-privacy-jr'],
  ['edu-preview-review-jr', 'edu-notes-mindmap-jr'],
  ['edu-qa-jr', 'edu-mistake-review-jr'],
  ['edu-qa-jr', 'ethics-anti-misuse-jr'],
  ['ethics-privacy-jr', 'ethics-fairness-jr'],
  ['genai-jr', 'aigc-media-jr'],
  ['genai-jr', 'llm-jr'],
  ['genai-jr', 'nlp-jr'],
  ['limit-hallucination-jr', 'ethics-information-jr'],
  ['limit-hallucination-jr', 'limit-knowledge-cutoff-jr'],
  ['limit-hallucination-jr', 'limit-understanding-jr'],
  ['limit-teaching-jr', 'ethics-fairness-jr'],
  ['limit-understanding-jr', 'limit-interaction-jr'],
  ['llm-jr', 'edu-agent-jr'],
  ['llm-jr', 'limit-hallucination-jr'],
  ['llm-jr', 'prompt-jr'],
  ['llm-jr', 'rag-jr'],
  ['long-term-memory-jr', 'edu-agent-jr'],
  ['long-term-memory-jr', 'edu-mistake-review-jr'],
  ['long-term-memory-jr', 'edu-preview-review-jr'],
  ['machine-learning-jr', 'deep-learning-jr'],
  ['machine-learning-jr', 'reinforcement-learning-jr'],
  ['machine-learning-jr', 'supervised-learning-jr'],
  ['machine-learning-jr', 'unsupervised-learning-jr'],
  ['medical-imaging-jr', 'ethics-information-jr'],
  ['narrow-ai-jr', 'llm-jr'],
  ['narrow-ai-jr', 'strong-ai-agi-jr'],
  ['neural-network-jr', 'transformer-jr'],
  ['nlp-jr', 'computer-vision-jr'],
  ['nlp-jr', 'llm-jr'],
  ['prog-loop-jr', 'prog-list-jr'],
  ['prog-variable-jr', 'prog-loop-jr'],
  ['prompt-jr', 'ethics-fairness-jr'],
  ['prompt-jr', 'limit-teaching-jr'],
  ['rag-jr', 'agent-tool-use-jr'],
  ['rag-jr', 'limit-hallucination-jr'],
  ['rag-jr', 'limit-knowledge-cutoff-jr'],
  ['reinforcement-learning-jr', 'agent-reflection-jr'],
  ['short-term-memory-jr', 'limit-interaction-jr'],
  ['short-term-memory-jr', 'long-term-memory-jr'],
  ['speech-recognition-jr', 'agent-perception-jr'],
  ['speech-recognition-jr', 'speech-synthesis-jr'],
  ['speech-recognition-jr', 'voice-assistant-jr'],
  ['speech-synthesis-jr', 'voice-assistant-jr'],
  ['supervised-learning-jr', 'reinforcement-learning-jr'],
  ['supervised-learning-jr', 'unsupervised-learning-jr'],
  ['token-jr', 'llm-jr'],
  ['training-inference-jr', 'autonomous-driving-jr'],
  ['transformer-jr', 'llm-jr'],
  ['transformer-jr', 'token-jr']
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
  baseUrl: 'https://api.deepseek.com',
  apiKey: '…9f3a',
  hasKey: true,
  modelId: 'deepseek-v4-flash'
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
 * ★ `cumulativeTurns` / `lastTurn` 都是 18（跨会话连续）：早已越过
 *   `LLM_DECIDES_FROM_TURN`（第 5 轮）那条「请 AI 复核」的水位线。
 * ★ `lastChangeTurn: 13`：改判发生在第 13 轮（见 `DEMO_GRADE_HISTORY` 的最后一条），
 *   之后已经稳稳过了 5 轮 —— 自动冷却窗口（5 轮）正好走完，所以
 *   `cooldownRemainingTurns` 是 0（没有手动设定，也就不存在 10 轮的手动冷却）。
 * ★ `streak: 2` / `direction: 1`：末尾 2 轮同向（都偏浅），但还不够 3 轮 →
 *   没有待生效的调整（`suggestedLevel` 为空，不是「被挡住」，是「证据还不够」）。
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
    cumulativeTurns: 18,
    lastTurn: 18,
    lastChangeTurn: 13,
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
