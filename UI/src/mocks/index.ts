/**
 * 统一 mock 数据层。
 *
 * 内容尽量取自仓库真实资产，避免「看起来像真的但接不上」：
 *  - 知识点 / 章节 / 小节名：`server/_data/shared/kb.sqlite` 的 `chunk` 表
 *  - 依赖边：`server/knowledge/manifest.json` 的 `dependencies`
 *  - 题目：`server/resources/quizbank/*.json`
 *
 * ⚠️ 形状对齐 `server/app/contracts.py`（见 src/types/contract.ts）。
 * 接线时整个 mocks/ 目录删除，改为 IPC 事件流与 sidecar HTTP 响应。
 */
import type {
  AnimationPayload,
  Citation,
  CodingHint,
  CodeTemplate,
  DepNode,
  GradeSignals,
  Mastery,
  QuizPayload,
  RagHit,
  SettingsResponse,
  StudentProfile,
  ToolTraceEntry
} from '@/types/contract'

/** 当前学生（画布 B 组：林小雨 · 小学低年级；此处按 mock 主场景取初中林小雨以贴合检索演示） */
export const student = {
  studentId: 'stu-linxiaoyu',
  nickname: '林小雨',
  gradeLevel: 'junior' as const,
  createdAt: 1756000000,
  lastActiveAt: 1757600000
}

/** 学期使用天数（学习台副标题用） */
export const daysWithApp = 12

/** 本轮专题（顶栏副标题） */
export const currentTopic = {
  chapter: '第1章 数据与特征',
  textbook: '《人工智能初步》',
  kpId: 'jr-data-features',
  kpName: '数据与特征'
}

/** 掌握度：kp 名取自真实 kp 表 */
export const mastery: Mastery[] = [
  { kpId: 'jr-data-features', score: 0.78, attempts: 9, correct: 7, lastSeenAt: 1757590000 },
  { kpId: 'jr-decision-tree', score: 0.42, attempts: 5, correct: 2, lastSeenAt: 1757550000 },
  { kpId: 'jr-neural-basics', score: 0.16, attempts: 2, correct: 0, lastSeenAt: 1757300000 },
  { kpId: 'jr-py-variable', score: 0.63, attempts: 6, correct: 4, lastSeenAt: 1757500000 }
]

/** kp_id → 中文名（右栏掌握度条与推荐卡用） */
export const kpNames: Record<string, string> = {
  'jr-data-features': '数据与特征',
  'jr-decision-tree': '决策树',
  'jr-neural-basics': '神经网络基础',
  'jr-py-variable': '变量',
  'jr-py-loop': '循环',
  'jr-py-list-dict': '列表与字典',
  'jr-task-types': '分类任务与回归任务',
  'jr-model-train-eval': '模型训练与评估入门'
}

export const studentProfile: StudentProfile = {
  student,
  mastery,
  preferences: { theme: 'junior-vivid', tone: '严谨逻辑' },
  recommendedKpIds: ['jr-decision-tree']
}

/** 推荐下一步（依赖图推导：jr-data-features → jr-decision-tree 是前置关系，已在 manifest 核实） */
export const recommendation = {
  kpId: 'jr-decision-tree',
  kpName: '决策树',
  reason:
    '「数据与特征」已掌握 78%，按依赖图它是「决策树」的前置。建议先做 3 题快速检验。',
  ctaLabel: '去闯关检验',
  targetRoute: '/app/quiz'
}

/** 检索命中（章节/小节名取自 kb.sqlite chunk 表真实值） */
export const retrievalHits: RagHit[] = [
  {
    chunkId: 'jr-data-features::s0::p0',
    chapterTitle: '第1章 数据与特征',
    sectionTitle: '一、从原始数据到特征',
    gradeLevel: 'junior',
    compat: false,
    parentChunkId: null,
    knowledgePoint: 'jr-data-features',
    kpId: 'jr-data-features',
    score: 0.86,
    degraded: 'vector',
    expanded: false
  },
  {
    chunkId: 'jr-data-features::s1::p1',
    chapterTitle: '第1章 数据与特征',
    sectionTitle: '二、特征选得好，模型才聪明',
    gradeLevel: 'junior',
    compat: false,
    parentChunkId: null,
    knowledgePoint: 'jr-data-features',
    kpId: 'jr-data-features',
    score: 0.79,
    degraded: 'vector',
    expanded: false
  }
]

/** citation 事件的 5 字段投影（注意：不是 hit 全量） */
export const citations: Citation[] = retrievalHits.map((h) => ({
  chunkId: h.chunkId,
  chapterTitle: h.chapterTitle,
  sectionTitle: h.sectionTitle,
  gradeLevel: h.gradeLevel,
  compat: h.compat
}))

/** 四级降级链状态（真实链：vector → cloud → fts → outline） */
export const degradeChain = [
  { key: 'vector', label: '向量检索 · fastembed 本地', state: '命中', active: true },
  { key: 'cloud', label: '云端 Embedding', state: '未启用', active: false },
  { key: 'fts', label: 'FTS5 关键词兜底', state: '未启用', active: false },
  { key: 'outline', label: '依赖图 + 大纲', state: '未启用', active: false }
] as const

/** 学段隔离提示（学段在 SQL 层强制，模型改不了 WHERE） */
export const isolationNotice = {
  gradeLabel: '初中',
  text: '学段隔离生效：本次仅使用「初中」及以下教材块'
}

/** 本轮工具调用轨迹（与 tool_execution_start / _end 对齐，服务 25% 设计分） */
export const toolTrace: ToolTraceEntry[] = [
  { turn: 1, toolName: 'rag_search', argsSummary: 'query="图像分类 特征" · topK=5', ok: true, latencyMs: 128, degraded: 'vector' },
  { turn: 1, toolName: 'generate_animation', argsSummary: 'concept="特征提取" · template="神经网络前向传播"', ok: true, latencyMs: 2140, degraded: null },
  { turn: 1, toolName: 'generate_quiz', argsSummary: 'kpId="jr-data-features" · count=3', ok: true, latencyMs: 486, degraded: null }
]

export const traceNote =
  '路由由模型自选；学段隔离、参数校验、内容终审均在代码层强制。'

/** 对话：一轮问答（用户气泡 + AI 回答 + 内联卡） */
export const userQuestion = '电脑是怎么「认出」一张照片里是猫还是狗的？它又没有眼睛。'

export const aiAnswer = {
  lead: '它确实没有眼睛，但它有「特征」。电脑「看」一张照片时，看到的是密密麻麻的数字 —— 每个像素的亮度，组成一个很大的数字表格。',
  stepsTitle: '它做三步',
  steps: [
    '找特征：从数字里提取有用的线索，比如「有没有尖耳朵」「边缘是不是毛茸茸的」。',
    '学规律：给它看几千张已标好的猫狗照片，让它自己调参数，直到猜得越来越准。',
    '做预测：来一张新照片，按学到的规律给出判断 —— 它给的其实是「可能性」，比如 87% 是猫。'
  ],
  highlight:
    '最关键的一点：它并不知道「猫」是什么，它只是学会了数字表格和标签之间的对应关系。这也是它会被骗的原因。'
}

/** 动画卡（视觉完整、引擎不接：此处只放静态结构，不载入 Anime.js / iframe） */
export const animationPayload: AnimationPayload = {
  concept: '特征提取过程',
  html: '',
  durationMs: 12000,
  fallbackText: '神经网络把输入的像素逐层转换成「边缘 / 尖耳」这类特征，最后输出「猫 87%」。',
  fallbackImage: null,
  source: 'template'
}

export const animationStages = [
  { name: '输入层', detail: '像素 28×28', nodes: 3 },
  { name: '特征层', detail: '边缘 / 尖耳', nodes: 4 },
  { name: '全连接', detail: '权重求和', nodes: 4 },
  { name: '输出层', detail: '猫 87%', nodes: 2 }
]

export const animationPlayback = { elapsedLabel: '00:04', totalLabel: '00:12', progress: 0.33 }

/** 闯关卡（题目取自 resources/quizbank/junior.json，qid 与选项为真实值） */
export const quizPayload: QuizPayload = {
  kpId: 'jr-data-features',
  source: 'bank',
  questions: [
    {
      qid: 'jr-data-features-q1',
      kpId: 'jr-data-features',
      type: 'choice',
      stem: '电脑「看」一张图片时，最先拿到的是什么？',
      options: ['每个像素的亮度数值', '一个词袋', '已经标好的标签'],
      explanation:
        '图片在电脑眼里就是一个数字表格：每个像素的亮度是一个数，机器从这些数里再提取特征。'
    },
    {
      qid: 'jr-data-features-q2',
      kpId: 'jr-data-features',
      type: 'blank',
      stem: '把每个样本的几个特征写成一列数字，例如 [165, 52]，这样的一列数字叫 ______。',
      options: null,
      explanation: '把多个特征按固定顺序排成一组数字，就是特征向量。'
    },
    {
      qid: 'jr-data-features-q3',
      kpId: 'jr-data-features',
      type: 'choice',
      stem: '要给同一批同学的身高和体重各画一张图，下面哪一组更适合作为「特征」？',
      options: ['同学的名字的笔画数', '身高、体重这些可以量出来的数值', '同学今天的心情'],
      explanation: '特征要能被量出来、又能用来区分对象。'
    }
  ]
}

/** 编程：脚手架与分级求助（题面与提示对齐 resources/code-templates 的结构） */
export const codeTemplate: CodeTemplate = {
  kpId: 'jr-data-features',
  language: 'python',
  scaffold: `# 任务：用列表装下一组特征，并算出平均值
# 每个同学的身高（cm）已经给出，请补全 TODO 部分

heights = [165, 152, 178, 160, 171]

# TODO 1: 把 heights 里的数字加起来，结果存到 total
total = 0

# TODO 2: 算出平均值，结果存到 avg
avg = 0

print(avg)`,
  expectedBehavior: '输出 165.2'
}

export const codingHints: CodingHint[] = [
  { level: 1, hint: 'Python 里可以用 sum(heights) 把一列数字加起来，先试试把 total 换成它。' },
  { level: 2, hint: '平均值是「总和 ÷ 个数」。个数可以用 len(heights) 得到。' },
  { level: 3, hint: '写成：avg = sum(heights) / len(heights)，然后 print(avg)。' }
]

export const codeRunResult = {
  stdout: '165.2',
  error: null,
  feedback: '输出正确，平均值算对了。你已经会用列表装特征、用内置函数求统计量。',
  nextHint: null
}

/** 学段推断信号（只读展示，写路径只有服务端） */
export const gradeSignals: GradeSignals = {
  studentId: 'stu-linxiaoyu',
  currentLevel: 'junior',
  source: 'inferred',
  suggestedLevel: null,
  confidence: 0.72,
  signals: [
    { signalType: 'vocab', value: 0.81, raw: '主动使用术语「特征」「样本」', ts: 1757590000 },
    { signalType: 'depth', value: 0.68, raw: '追问「为什么会过拟合」', ts: 1757590100 },
    { signalType: 'quiz_perf', value: 0.75, raw: '连续 3 题全对', ts: 1757590200 },
    { signalType: 'meta_cognition', value: 0.2, raw: '未出现「听不懂」表达', ts: 1757590300 }
  ]
}

/** 学段变化轨迹（只读历史；source 恒为 inferred） */
export const gradeHistory = [
  { at: '09-10', from: '小学高年级', to: '初中', reason: '术语使用密度与答题表现同步上移', source: 'inferred' as const },
  { at: '09-03', from: '小学低年级', to: '小学高年级', reason: '提问句式变长，开始追问原因', source: 'inferred' as const }
]

/** 设置页默认值（注意：Pi 内置 DeepSeek baseUrl 无 /v1，与前端默认形如 /v1 不同，保存时须真实探测） */
export const settings: SettingsResponse = {
  llm: {
    providerName: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    hasKey: true,
    modelId: 'deepseek-chat'
  },
  embedding: {
    mode: 'local_fastembed',
    baseUrl: null,
    hasKey: false,
    modelId: 'BAAI/bge-small-zh-v1.5'
  }
}

/**
 * 依赖边（**逐条取自 manifest.json 的真实 `dependencies`**）。
 * 语义全项目一致：`from` 是**前置**，`to` 是**后继**（方向搞反是静默错）。
 */
export const dependencyEdges: { from: string; to: string; relation: 'prerequisite' | 'related'; weight: number }[] = [
  { from: 'ph-image-classification', to: 'jr-data-features', relation: 'prerequisite', weight: 1 },
  { from: 'jr-data-features', to: 'jr-decision-tree', relation: 'prerequisite', weight: 1 },
  { from: 'jr-data-features', to: 'jr-py-variable', relation: 'prerequisite', weight: 1 },
  { from: 'jr-data-features', to: 'jr-task-types', relation: 'prerequisite', weight: 1 },
  { from: 'jr-py-variable', to: 'jr-py-loop', relation: 'prerequisite', weight: 1 },
  { from: 'jr-py-loop', to: 'jr-py-list-dict', relation: 'prerequisite', weight: 1 },
  { from: 'jr-task-types', to: 'jr-model-train-eval', relation: 'prerequisite', weight: 1 },
  { from: 'jr-decision-tree', to: 'jr-neural-basics', relation: 'prerequisite', weight: 1 },
  { from: 'jr-neural-basics', to: 'jr-model-train-eval', relation: 'prerequisite', weight: 1 }
]

/** 依赖图谱默认根节点 */
export const dependencyRoot = 'jr-data-features'

/** 依赖图谱节点（由 dependencyEdges 做 BFS 得到，此处仅为最初一屏的默认视图） */
export const dependencyNodes: DepNode[] = [
  { kpId: 'jr-data-features', name: '数据与特征', gradeLevel: 'junior', relation: 'related', direction: 'prerequisite', weight: 1, depth: 0 },
  { kpId: 'jr-decision-tree', name: '决策树', gradeLevel: 'junior', relation: 'prerequisite', direction: 'successor', weight: 1, depth: 1 },
  { kpId: 'jr-py-variable', name: '变量', gradeLevel: 'junior', relation: 'prerequisite', direction: 'successor', weight: 1, depth: 1 },
  { kpId: 'jr-task-types', name: '分类任务与回归任务', gradeLevel: 'junior', relation: 'prerequisite', direction: 'successor', weight: 1, depth: 1 },
  { kpId: 'jr-py-loop', name: '循环', gradeLevel: 'junior', relation: 'prerequisite', direction: 'successor', weight: 1, depth: 2 },
  { kpId: 'jr-neural-basics', name: '神经网络基础', gradeLevel: 'junior', relation: 'prerequisite', direction: 'successor', weight: 1, depth: 2 },
  { kpId: 'jr-model-train-eval', name: '模型训练与评估入门', gradeLevel: 'junior', relation: 'prerequisite', direction: 'successor', weight: 1, depth: 3 }
]

/** 学习档案：近 7 日活动量（热力/柱状用） */
export const weeklyActivity = [
  { day: '周一', qa: 4, animation: 1, coding: 0, quiz: 3 },
  { day: '周二', qa: 6, animation: 2, coding: 1, quiz: 2 },
  { day: '周三', qa: 3, animation: 0, coding: 0, quiz: 5 },
  { day: '周四', qa: 7, animation: 1, coding: 2, quiz: 4 },
  { day: '周五', qa: 5, animation: 2, coding: 1, quiz: 6 },
  { day: '周六', qa: 9, animation: 3, coding: 2, quiz: 8 },
  { day: '周日', qa: 2, animation: 0, coding: 0, quiz: 1 }
]

/** 闯关进度（阶段对齐 progress.stage：locked / learning / quizzed / mastered） */
export const progressRows = [
  { kpId: 'jr-data-features', name: '数据与特征', stage: 'mastered' as const, score: 0.78 },
  { kpId: 'jr-decision-tree', name: '决策树', stage: 'quizzed' as const, score: 0.42 },
  { kpId: 'jr-neural-basics', name: '神经网络基础', stage: 'learning' as const, score: 0.16 },
  { kpId: 'jr-py-loop', name: '循环', stage: 'locked' as const, score: 0.0 }
]

/** 教材知识库（管理视图：真实 kp 数与 chunk 数） */
export const kbStats = {
  gradeLevels: 4,
  knowledgePoints: 33,
  chunks: 271,
  dependencies: 47,
  embeddingDim: 512,
  embeddingModel: 'BAAI/bge-small-zh-v1.5'
}
