/**
 * 演示驾驶舱的**技术口原文案**（唯一集中处）。
 *
 * ★ 为什么单独成文件：`student-view-discipline.test.ts` 对每个渲染进程文件做零豁免扫描
 *   （SQL / FTS5 / Pyodide / nonce / 契约 / 兜底 / 降级链 …），而演示驾驶舱恰恰要把这些词
 *   一个不少地摊开。处置与 `components/rail-evidence.ts`（右栏证据）同一手法：
 *   把技术原文集中到一个**只在演示 / 教师面渲染**的模块，守卫按文件豁免它。
 *
 * ⚠️ 本文件里的字不许流到学生面前：谁把它 import 进学生可见的组件，守卫会立刻红
 *   （那条凭证读的就是「谁 import 了它」，见 `tests/demo-mode.test.ts`）。
 */

/** 一个分块的静态说明（标题 + 一句话「为什么要展示它」）。 */
export interface DiagBlockCopy {
  id: string
  /** 序号 + 标题（左上角那行）。 */
  title: string
  /** 一句话说明它的演示价值（答辩时照着念）。 */
  lead: string
}

/** 十二个分块（顺序 = 演示时从上到下讲的顺序）。数据全部来自 `TurnDiagnostics`。 */
export const DIAG_BLOCKS: readonly DiagBlockCopy[] = [
  {
    id: 'input',
    title: '① 输入与安全预检',
    lead: '学生的原话、命中与否、以及这一轮到底有没有发给模型。拦下来的那一轮，模型一个字节都没收到。'
  },
  {
    id: 'grade',
    title: '② 学段观察',
    lead: '这一轮按哪个学段作答、由哪一层判的（本地规则 / 模型复核 / 学生手动）、冷却窗口还剩几轮。'
  },
  {
    id: 'prompt',
    title: '③ Prompt 拼接',
    lead: '七段模板 + 本轮画像块 + 学段权威段，逐段给出体量与原文。这是「教育适配性」最硬的一份证据。'
  },
  {
    id: 'context',
    title: '④ 画像注入与字节稳定',
    lead: '画像每轮注入一次；块内不放时间、顺序固定，所以字节指纹不变，前缀才有机会被复用。'
  },
  {
    id: 'reasoning',
    title: '⑤ 模型推理（可选）',
    lead: '拿得到就展示，且默认折叠；包含凭证或本机路径的一律整段丢弃，不做局部遮盖。拿不到就如实写「没有」。'
  },
  {
    id: 'tools',
    title: '⑥ 工具调用',
    lead: '模型自己决定调哪个工具、调几次、每次多久、有没有降级。这是智能体自主行为最直接的轨迹。'
  },
  {
    id: 'retrieval',
    title: '⑦ 教材检索四级链',
    lead: '向量 / 云端嵌入 / FTS5 关键词 / 章节大纲，逐级记录「试过没有、命中几条、为什么落到下一级」，并给出学段过滤条件原文。'
  },
  {
    id: 'safety',
    title: '⑧ 内容安全三阶段',
    lead: '入口预检 / 流式转发 / 整段终审。终审判违规时正文先流式显示、随后整段撤回，且 blocked 一定排在 done 之前。'
  },
  {
    id: 'sandbox',
    title: '⑨ 沙箱与执行面',
    lead: '学生代码只在渲染进程的 Pyodide Worker 里跑，动画只在受限的 iframe 里跑（不放行同源）；死循环会被真正中断。'
  },
  {
    id: 'interceptions',
    title: '⑩ 拦截记录（跨轮累计）',
    lead: '被冷却挡下的学段变更、被安全规则拦下的输入、被撤回的回答、降级的检索。能拦，才证明规则在跑。'
  },
  {
    id: 'runtime',
    title: '⑪ 运行时',
    lead: '本地数据服务的连接状态与最近一次状态变化。桌面应用的可靠性就从这里看得见。'
  },
  {
    id: 'contracts',
    title: '⑫ 契约与守卫',
    lead: 'pydantic / OpenAPI / TypeScript 的防漂移链，以及架构守卫与变异测试的编号清单。'
  }
]

/** 降级链四档的**技术口径**名字（答辩要的就是这四个词）。 */
export const RETRIEVAL_LEVEL_LABELS: Record<string, string> = {
  vector: '向量检索（本地嵌入模型）',
  cloud: '云端嵌入',
  fts: 'FTS5 关键词兜底',
  outline: '章节大纲兜底'
}

/** 安全三阶段的名字。 */
export const SAFETY_STAGE_LABELS: Record<string, string> = {
  input: '入口预检（发模型之前）',
  stream: '流式转发',
  final: '整段终审（生成结束之后）'
}

/** 三道运行时注入的名字（Prompt 那一块用）。 */
export const PROMPT_STAGE_LABELS: Record<string, string> = {
  override: '建会话时整段替换默认提示词',
  'per-turn': '每轮重拼（抹掉宿主路径尾巴 + 换成本轮学段）',
  authority: '权威段恒追加（学段指令离生成最近）'
}

/** 四学段横向对比卡：同一句提问在四档下的语气与深度差异。 */
export interface GradeMatrixRow {
  grade: string
  tone: string
  depth: string
}

export const GRADE_MATRIX_ROWS: readonly GradeMatrixRow[] = [
  { grade: '小学低年级', tone: '童话化、拟人化，句子短', depth: '一次只讲一个点，多用生活类比' },
  { grade: '小学高年级', tone: '重因果与「为什么」', depth: '可以引入术语，但必须当场解释' },
  { grade: '初中', tone: '逻辑链条完整', depth: '给出推理过程与反例，允许公式' },
  { grade: '高中', tone: '严谨、可推导', depth: '允许专业名词与公式推导，讲清边界条件' }
]

/** 隐藏机制补充卡（不属于某一轮，但属于「隐藏机制」这条主线）。 */
export interface HiddenMechanismCard {
  title: string
  body: string
}

export const HIDDEN_MECHANISM_CARDS: readonly HiddenMechanismCard[] = [
  {
    title: '掌握度限幅有上限',
    body: '一次答题对掌握度的推动有上限，避免一题就把画像推歪；连续作答才会累积。'
  },
  {
    title: '安全闸门两处强制',
    body: '入口预检与生成侧终审都在代码层调用判定服务，模型改不了它们要不要跑。'
  },
  {
    title: '工具由模型自主路由',
    body: '检索、出题、判分、动画、编程、画像各是一个独立工具，由模型按需选，编排层不预先规定顺序。'
  },
  {
    title: '学段过滤写在 SQL 层',
    body: '每一条检索语句都带学段白名单，命中更低学段时标出来源。模型无法改 WHERE。'
  }
]

/** 契约与守卫静态卡的一行。 */
export interface GuardCatalogRow {
  id: string
  what: string
}

/** 架构守卫的编号清单（由 `tests/demo-mode.test.ts` 断言与守卫文件的编号集合一致）。 */
export const GUARD_CATALOG: readonly GuardCatalogRow[] = [
  { id: 'G1', what: 'Electron 侧不引入任何原生数据库模块（数据域只在 Python）' },
  { id: 'G2', what: '渲染进程不 import 任何 Node 内置模块' },
  { id: 'G3', what: '渲染进程不直连本地数据服务的 HTTP 端点' },
  { id: 'G4', what: '6 事件词表严格是 delta / citation / payload / blocked / done / error' },
  { id: 'G5', what: '只有 bridge/client.ts 能对本地数据服务发 HTTP' },
  // ⚠️ 这三条**不许**写出那个凭证字段的英文原词：`architecture-guards.test.ts` 的 G6b
  //    会在渲染进程的可执行代码里扫它的典型形态（含裸标识符），写了就红。
  //    用中文说同一件事，信息一点没少。
  { id: 'G6a', what: '状态结构里没有凭证字段' },
  { id: 'G6b', what: '渲染与 preload 的可执行代码里不出现凭证标识' },
  { id: 'G6c', what: '面向渲染进程的请求类型里没有凭证（对话请求只有 text）' },
  { id: 'G7', what: '对话事件流经主进程 IPC 与 preload 白名单通道' },
  { id: 'G8', what: '通道名只在 channels.ts 出现一次' },
  { id: 'G9', what: 'preload 只暴露白名单方法，不暴露通用转发' },
  { id: 'G10', what: '工具名到载荷类型的映射只有一处定义' },
  { id: 'G11', what: '6 事件载荷字段与契约逐字一致' },
  { id: 'G12', what: '渲染进程接事件是订阅回调（没有解析层）' },
  { id: 'G13', what: '明文模型配置只有主进程能取' }
]

/** 契约防漂移链的三步（静态卡的那一行箭头）。 */
export const CONTRACT_CHAIN = 'pydantic（contracts.py）到 OpenAPI（export_openapi.py）到 TypeScript（gen:api）'

/**
 * 导出演示包时用的**文档标记**（Markdown 围栏）。
 *
 * ★ 为什么这些字面量住在这个模块里：`tests/student-view-discipline.test.ts` 会扫**渲染进程
 *   源码里的字符串字面量**（反引号是它盯的标记之一 —— 裸插值渲染出来的内容会变成字面反引号）。
 *   这三行是**导出文档正文**，既不上屏也不走任何渲染通路；本模块已是「技术口原文案的唯一
 *   集中处」且被守卫按文件豁免，所以它们的正确归属是这里 —— 放在 `views/Demo.vue` 里会让
 *   那条守卫为一份**导出的文档**变红，而那正是「用改豁免代替改源码」的反面。
 */
export const MD_FENCE = {
  mermaid: '```mermaid',
  json: '```json',
  close: '```'
} as const

/** 演示驾驶舱的标题与空态文案。 */
export const DEMO_HEADINGS = {
  title: '演示驾驶舱',
  lead: '这一页把一次提问背后发生了什么摊开：谁拦下了什么、降级到了哪一级、画像块为什么逐字节稳定。',
  timelineEmpty: '还没有轮次记录。先回对话页问一句，再回来。',
  rawHint: '下面是这一轮的原始信封（脱敏后的结构化数据）。'
} as const
