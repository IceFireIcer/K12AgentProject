/**
 * 运行透视的**技术口原文案**（唯一集中处）。
 *
 * ★ 为什么单独成文件：`student-view-discipline.test.ts` 对每个渲染进程文件做零豁免扫描
 *   （SQL / FTS5 / Pyodide / nonce / 契约 / 兜底 / 降级链 …），而这一页恰恰要把这些词
 *   一个不少地摊开。处置与 `components/rail-evidence.ts`（右栏证据）同一手法：
 *   把技术原文集中到一个**只在教师档及以上可达**的模块，守卫按文件豁免它。
 *
 * ⚠️ 本文件里的字不许流到学生面前：谁把它 import 进学生可见的组件，守卫会立刻红
 *   （那条凭证读的就是「谁 import 了它」，见 `tests/demo-mode.test.ts`）。
 */

/** 一个分块的静态说明（标题 + 一句话「这一块看的是什么」）。 */
export interface DiagBlockCopy {
  id: string
  /** 序号 + 标题（左上角那行）。 */
  title: string
  /** 一句话说明它对应哪些运行时字段。 */
  lead: string
}

/** 十二个分块（顺序 = 从上到下阅读的顺序）。数据全部来自 `TurnDiagnostics`。 */
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

/** 降级链四档的**技术口径**名字（四级链的档位名就是这四个词）。 */
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

/**
 * 第二层（模型复核）的**八个状态**各自是什么意思。
 *
 * ★ 取值集合来自主进程 `agent/extensions/grade.ts` 的 `Layer2Status`（`not_due` /
 *   `due` / `used` / `no_llm` / `judge_error` / `retry` / `insufficient_evidence` /
 *   `already_proposed`）。它们是**运行时原值**，界面上要能分辨「还没到轮次」与
 *   「到了但没模型可用」——那两件事对答辩的含义完全不同，不能都写成「未复核」。
 * ★ 一个字都不许改成技术名词（`layer2` / `LAYER2` 这类实现词不上面）。
 */
export const LAYER2_LABELS: Record<string, string> = {
  not_due: '还没到复核的轮次',
  due: '到轮次了，等复核',
  used: '复核跑过，结论用上了',
  retry: '复核要再试一次',
  insufficient_evidence: '证据还不够，先不下结论',
  already_proposed: '已经提过同样的结论',
  no_llm: '没有可用的模型，复核跳过了',
  judge_error: '复核出错，这一轮按原学段走'
}

/** 三道运行时注入的名字（Prompt 那一块用）。 */
export const PROMPT_STAGE_LABELS: Record<string, string> = {
  override: '建会话时整段替换默认提示词',
  'per-turn': '每轮重拼（抹掉宿主路径尾巴 + 换成本轮学段）',
  authority: '权威段恒追加（学段指令离生成最近）'
}

/** 契约与守卫静态卡的一行。 */
export interface GuardCatalogRow {
  id: string
  what: string
}

/**
 * 架构守卫的编号清单（由 `tests/demo-mode.test.ts` 断言与守卫文件的编号集合一致）。
 *
 * ★ 这不是讲解稿：每一条都是仓库里**真实存在**的守卫（`tests/architecture-guards.test.ts`
 *   里按同一个编号写着），所以它留在这里当「这一轮跑在什么约束之下」的清单。
 */
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

/**
 * 运行透视的**两个子页**（顶栏分段切换的文案；顺序 = 从左到右）。
 *
 * ★ 为什么这两句放在这里而不是直接写进 `views/Demo.vue` 的模板：
 *   本文件是运行透视技术口原文案的**唯一集中处**，由守卫按文件豁免；而 `views/Demo.vue`
 *   **不在**豁免名单里（它的可见文案必须干净）。子页名字里就有技术词（「分块总览」），
 *   写进模板会当场把那条守卫变红 —— 所以和 `DIAG_BLOCKS` / `PAGE_HEADINGS` 一样收在这里。
 * ★ `id` 就是切换的取值（`views/Demo.vue` 的 `view` 状态），`hint` 只进 `title` 属性。
 */
export const DIAG_VIEWS: readonly { id: 'blocks' | 'sequence'; label: string; hint: string }[] = [
  { id: 'blocks', label: '分块总览', hint: '按主题看这一轮：时间轴 / 十二个分块 / 原始信封' },
  { id: 'sequence', label: '调用顺序', hint: '按真实发生的先后，把这一轮一条横条一个步骤摊开' }
]

/** 运行透视的标题与空态文案。 */
export const PAGE_HEADINGS = {
  title: '运行透视',
  lead: '这一页摊开每一轮的运行时证据：输入被怎么判、提示词怎么拼、检索走到哪一级、安全在哪一步拦下。',
  timelineEmpty: '还没有轮次记录。先回对话页问一句，再回来。',
  rawHint: '下面是这一轮的原始信封（脱敏后的结构化数据）。'
} as const
