/**
 * 界面文案映射（学段名 / 学段提示语 / 卡片种类 / 轮次状态 / 练习卡片）。
 *
 * 只做「枚举 → 中文」这一件事：四学段字面量、`PayloadKind` 与题型都来自冻结契约
 * （`@shared/ipc-events` 与 OpenAPI 生成物），这里不新增任何枚举值。
 */

/*
 * 设计备忘：内联卡片种类（§9.3 的三个 `kind`）。这里原来还有
 * `PAYLOAD_KIND_LABELS` / `PAYLOAD_KIND_HINTS` 两组映射，**不要把它们加回来**：
 * 唯一消费点是 `cards/InlineCard.vue` 里那个「未识别 kind」的占位卡片，
 * 而 `kind` 在 `api/events.ts` 已由白名单收窄成 `animation | coding | quiz` 三种，
 * 三个分支互相穷尽 —— 那个 v-else 永不渲染（连带一个永远禁用的按钮）。
 * 卡片标题如今由各卡片自己写（「动画讲解」「编程练习」「随堂练习」）。
 * 新增卡片种类时：改 `shared/ipc-events.ts` 的 `PayloadKind` + `events.ts` 的白名单 + 这里加分支。
 */

import type { GradeLevel } from '@shared/ipc-events'
// ★ `GradeOrigin` 只存在于 `main/ipc/channels.ts`（`shared/ipc-events.ts` 里没有它），
//   从 `./api/grade` 取 —— 那里已经 re-export 过（渲染进程不重复声明同一形状）。
//   必须写成 **type-only import**：纯类型导入编译后被完全擦除，
//   所以「labels.ts 依赖 api/grade」在运行时**不存在**，不会有循环加载。
import type { GradeOrigin } from './api/grade'
import type { QuizQuestionType } from './cards/quiz'
import type { TurnStatus } from './api/events'

/** 四学段的中文名（执行文档 §6.2 的字面量，一一对应）。 */
export const GRADE_LABELS: Record<GradeLevel, string> = {
  primary_low: '小学低年级',
  primary_high: '小学高年级',
  junior: '初中',
  senior: '高中'
}

/**
 * 学段还没判出来时指示器上的字（★ 不许拿冷启动默认值冒充判定结果）。
 *
 * ★★ 2026-09-22 改词（报告 0.2 术语表）：「待判定」→「还没认出年级」。
 *   原词是从后端规则引擎的视角写的（「判定」是 `rules.py` 的动作），学生读到的是
 *   三个自己没做过、也不知道谁在做的事。新词只说**现在是什么状态**，不点破机制。
 *   ⚠️ 这是**唯一**的字面量来源：视图 / store / 提示语一律引用它，别再写死一遍中文。
 */
export const GRADE_UNKNOWN_LABEL = '还没认出年级'

/**
 * 「学段是怎么定下来的」这件事的说法（指示器上必须能看出来，否则手动选完看不出生效）。
 *
 * ★★ **2026-09-21（D-066）改口径**：原先 `default` 被映射成「AI 引擎推算」，
 *   于是学生发一句「你好」就看到「当前：小学高年级（AI 引擎推算）」——
 *   而那一刻**一次推断都没发生过**（那只是冷启动基线值）。用户点名说这「过于粗暴」。
 *
 * 现在按**决策权**如实分档（与 `rules.py` 的 `LLM_DECIDES_FROM_TURN = 5` 一致）：
 *
 * | origin | 谁判的 | 界面 |
 * | --- | --- | --- |
 * | `explicit` | 学生手动选的 | 手动选中 |
 * | `llm` | 累计第 5 轮起，LLM（**决策者**） | AI 引擎判定 |
 * | `rules` | 前 4 轮 / LLM 不可用，规则引擎 | 本地规则判定 |
 * | `default` | **还没判过**（冷启动基线） | 还没认出年级 |
 *
 * ★ 学生看得见的词都是人话：「本地规则判定」「AI 引擎判定」说的是**判断方式**，
 *   不暴露 `rules.py` / `LAYER2` 这类实现名词（双视角纪律 D-063）。
 * ★ `inferred` 是历史值，等价于 `rules` —— 读取端（`ipc/handlers.ts`）已经折过去了，
 *   这里保留映射只为兜住极旧的推送。
 */
export const GRADE_ORIGIN_LABELS: Record<GradeOrigin, string> = {
  explicit: '手动选中',
  llm: 'AI 引擎判定',
  rules: '本地规则判定',
  inferred: '本地规则判定',
  default: GRADE_UNKNOWN_LABEL
}

/**
 * ★ **唯一**的「学段来源 → 中文」实现（指示器与设置页都调它）。
 *
 * 为什么必须收口成一个函数：两个入口各写一份映射，改一处忘另一处时
 * 表现是「同一个学段，指示器说『手动选中』、设置页说『本地规则判定』」——
 * 学生据此判断自己刚才那一下有没有生效，两处不一致等于告诉他没生效。
 *
 * `null`（还没收到任何推送）与 `default` 同口径（`GRADE_UNKNOWN_LABEL`）：
 * 那时 `currentGrade` 也是 `null`，界面本来就在说「等系统看几轮」——
 * 这一档**不是**「AI 判过了」，如实写「还没认出年级」。
 */
export function gradeOriginLabel(origin: GradeOrigin | null): string {
  return origin === null ? GRADE_UNKNOWN_LABEL : GRADE_ORIGIN_LABELS[origin]
}

/**
 * 系统判定出学段（或判定结果变化）时，给学生的一句**简短**提示。
 *
 * ★ 为什么要有这句话：学段是**系统自己判的**，学生没做过任何操作；
 *   不说一声的话，适配发生了也看不出来。所以这里只陈述「我按什么说法讲」，
 *   不邀功、不解释规则、不需要学生确认。
 * ★ 只在 `origin === 'inferred'` 时给（见 `stores/chat.ts` 的 `applyGradeState`）：
 *   学生自己刚选完的那一下有 {@link gradeManualNotice} 这条更贴切的回执，
 *   再叠一句「我按X的说法来讲」等于跟他说「系统替你改成了X」—— 事实反了。
 */
export function gradeAdaptNotice(grade: GradeLevel): string {
  return `我按${GRADE_LABELS[grade]}的说法来讲。`
}

/**
 * 学生**手动选定**学段后的回执（与 {@link gradeAdaptNotice} 并列的一次性提示）。
 *
 * ★ 为什么这句必须存在：手动入口是一个显式动作，学生点完要**当场**看到它生效；
 *   而生效与否只有一个可见证据 —— 指示器上的学段名变了（服务端真的写了库，
 *   主进程再把结果推回来）。这句提示让「变没变」不必靠学生自己比对。
 * ★ 措辞用「已按你选的…」而不是「我按…来讲」：主语的差别就是来源的差别，
 *   学生要能一眼分清「我选的」与「系统推的」。
 */
export function gradeManualNotice(grade: GradeLevel): string {
  return `已按你选的${GRADE_LABELS[grade]}来讲。`
}

/**
 * 内容被安全规则拦下时，学生看到的**唯一**一句话。
 *
 * ★★ 为什么必须收口、且**不渲染后端给的 reason**：
 *   后端 `SafetyVerdict.to_payload()` 的 `reason` 是给排障用的诊断串，
 *   实测形态是「命中内容安全规则：越狱/绕过规则（regex:reveal_system_prompt）」。
 *   把它摆给学生有三重问题：
 *     ① 学生看不懂「regex」「越狱」，只会以为自己犯了错；
 *     ② 它把防御策略（用正则匹配哪几类词）交代给了试图绕过的人 ——
 *        这类细节不该出现在任何面向使用者的界面上（后端日志与教师视角除外）；
 *     ③ 它和智团团那句得体的回复并排出现，等于把 AI 的「底牌」摊开。
 *   `reason` 本身**不删**：它仍进轨迹（教师视角）与主进程日志，排障能力不变。
 */
export const BLOCKED_STUDENT_NOTICE = '这句话我没法照着答，换个说法我们接着聊。'

/** 没选章节时的说法（指示器与设置页共用**同一句**，两处不一致学生会以为没生效）。 */
export const CHAPTER_NONE_LABEL = '未选择章节（自由问答）'

/**
 * 「正在学哪一章」这一行的**唯一**拼装实现（对话页顶栏指示器与设置页都调它）。
 *
 * ★ 为什么收口：两个入口各拼一次，改一处忘另一处时表现是「同一个状态，一处写『正在学：第4章…』、
 *   另一处写『未选择章节』」—— 学生据此判断自己刚选的那一下有没有生效。
 * ★ 章标题本身已经含学段语境（「第4章 用 Python 处理数据」），**后面不再重复学段标签**。
 * ★ 空串 = 未选择（契约里只有这一种空值形态，见 `api/chapter.ts` 的注释）。
 */
export function chapterLineLabel(chapterTitle: string): string {
  const title = chapterTitle.trim()
  return title.length === 0 ? CHAPTER_NONE_LABEL : `正在学：${title}`
}

export const TURN_STATUS_LABELS: Record<TurnStatus, string> = {
  streaming: '正在回答',
  done: '回答完成',
  blocked: '已撤回',
  error: '能力受限'
}

/**
 * 需要显示轮次状态角标的那几个状态（**`done` 不在其中**）。
 *
 * ★★ 为什么 `done` 不显示：走查结论原话是「『回复完成』状态标签极其多余且令人困惑 ——
 *   文字显示出来了就代表回复完成了」。聊天界面里「内容已经出现在屏幕上」本身就是完成信号，
 *   再挂一个角标只会让学生想「完成？那还有什么没完成？」。
 * ★ 其余三个**必须保留**，它们说的是「你看到的这些字不是最终答案」：
 *   `streaming` 还在写、`blocked` 内容被换过、`error` 这轮没正常结束。
 * ★ 这个判断必须收口成函数：三处渲染（气泡、卡片、导出）各写一遍 `!== 'done'`
 *   迟早会有一处漏掉 `done`，表现是「有的地方还挂着『回答完成』」。
 */
export function showsStatusChip(status: TurnStatus): boolean {
  return status !== 'done'
}

/**
 * 安全审查徽章的两种文案（用户 2026-10-01 真机走查给定，**一个字都不改**）。
 *
 * ★ 与 `TURN_STATUS_LABELS` 的分工：那是「这一轮现在什么状态」，这是「内容安全
 *   审查的结论」—— 两者是独立的两件事，一轮可以既「回答完成」又「已通过安全审查」。
 * ★ 放在这里的理由与其它文案相同：组件只决定**摆在哪**，措辞与显隐判据都不进组件
 *   （否则导出 / 卡片再抄一份时就漂移了）。
 */
export const SAFETY_REVIEW_PASSED_LABEL = '已通过安全审查'
export const SAFETY_REVIEW_FAILED_LABEL = '未通过安全审查'

/**
 * 何时显示安全审查徽章（绿 = 通过 / 红 = 被撤回）。
 *
 * ★ 只在**审查已经有结论**的终态显示：
 *   · `done`    —— 整段终审通过，屏幕上的正文就是给学生的最终答案；
 *   · `blocked` —— 终审判定违规，正文已被安全提示替换（红徽章）。
 * ★ `streaming` 不显示：终审要等生成结束才跑，此刻先标「已通过」是一句**还没发生**
 *   的承诺（本仓对承诺文案的纪律：不得超出该路径的实际行为）。
 * ★ `error`（真失败）也不显示：本轮根本没走到终审，没结论就不标 —— 与学段徽章
 *   「宁可不标，也不标一个假的」同一条判据。
 */
export function showsSafetyReviewChip(status: TurnStatus): boolean {
  return status === 'done' || status === 'blocked'
}

/** 三种题型的中文名（`QuizQuestionType`，契约里的三个字面量）。 */
export const QUIZ_TYPE_LABELS: Record<QuizQuestionType, string> = {
  choice: '选择题',
  blank: '填空题',
  code_blank: '代码填空'
}

/** 判分方式（`QuizResult.scoredBy`）：客观题规则判分 / 主观题模型判分。 */
export const SCORED_BY_LABELS: Record<'rule' | 'llm', string> = {
  rule: '规则判分',
  llm: '模型判分'
}

/**
 * 掌握度变化的中文展示（`QuizResult.masteryDelta`，后端已限幅 ±0.2）。
 *
 * ★ 只做**格式化**：不重新计算、不判对错、不做第二套限幅 —— 判分只在后端（§6.3）。
 */
export function formatMasteryDelta(delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return '掌握度不变'
  const sign = delta > 0 ? '+' : ''
  return `掌握度 ${sign}${delta.toFixed(2)}`
}

/* ------------------------------------------------------------------ *
 * 模型配置状态（顶栏与输入条的模型 chip）
 * ------------------------------------------------------------------ */

/**
 * 「模型配好了没有」的三种状态。
 *
 * ★★ 为什么需要它（2026-09-22 的实测缺陷）：chip 上原来直接显示
 *   `settings.snapshot.llm.modelId`，而那是**服务端默认值**（`deepseek-v4-flash`）——
 *   首次安装、**一个 Key 都没填**的时候它也照样显示，学生/老师看到的第一眼就是
 *   「已经配好了一个模型」。事实是那时**一句话都发不出去**（主进程会走「缺 Key」早退）。
 *   界面显示一个并不存在的「已配置」，比显示「未配置」坏得多：它会让人以为自己
 *   只是网络不好，而不是「这里还缺一步配置」。
 *
 * 判据：**`hasKey` 且 modelId 非空**（`hasKey` 来自设置回执的 `llm.has_key`）。
 * ⚠️ 底层默认值**不改**：Pi 建会话必须有供应商与端点，填了 Key 就该立刻能用
 *   （详见 `pi-bootstrap.ts` 的 `DEFAULT_*` 说明）—— 这里只改**显示**。
 */
export type LlmReadyState = 'loading' | 'unconfigured' | 'ready'

/** 设置快照里与「配没配好」有关的那几个字段（只读投影，不引契约类型）。 */
export interface LlmReadiness {
  hasKey?: boolean
  modelId?: string
}

/**
 * 设置快照 → 三态（**唯一实现**，顶栏 chip、输入条 chip、选择弹层都调它）。
 *
 * `snapshot === null`（还没读到设置）时是 `loading`，**不许**当 `unconfigured`：
 * 首屏抢在设置回执之前就说「未配置」是一次假报警（`App.vue` 已经为此在启动时
 * 主动拉一次设置，见那里的注释）。
 */
export function llmReadyState(llm: LlmReadiness | null | undefined): LlmReadyState {
  if (!llm) return 'loading'
  const hasKey = llm.hasKey === true
  const modelId = (llm.modelId ?? '').trim()
  return hasKey && modelId !== '' ? 'ready' : 'unconfigured'
}

/** 模型 chip 上显示的字（学生要能一眼看出「这里还缺一步」）。 */
export const LLM_UNCONFIGURED_LABEL = '未配置'
/** 还在读设置时 chip 上的字（不假报一个模型名）。 */
export const LLM_LOADING_LABEL = '读取中…'

/**
 * chip 标签：三态各自说自己的话。
 *
 * ★ `'未配置'` 是给**学生**看的字：不含 API Key / BaseURL 这类技术词
 *   （双视角纪律 D-063 —— 完整的配置说法在设置页的高级设置里）。
 */
export function llmDisplayLabel(llm: LlmReadiness | null | undefined): string {
  const state = llmReadyState(llm)
  if (state === 'loading') return LLM_LOADING_LABEL
  if (state === 'unconfigured') return LLM_UNCONFIGURED_LABEL
  return (llm?.modelId ?? '').trim()
}

/**
 * chip 的悬停说明（**按视角分措辞**）。
 *
 * ★ 与「换模型请去设置里的高级设置」同一口径：学生视角下模型弹层是只读的，
 *   所以未配置时给他的说明是「请老师或家长去设置」，而不是「去填 API Key」——
 *   后者既是技术词，又指向一个学生自己不会去动的地方（配置入口在设置页的
 *   「高级设置（教师 / 家长）」里）。
 */
export function llmChipTitle(llm: LlmReadiness | null | undefined, isTeacher: boolean): string {
  const state = llmReadyState(llm)
  if (state === 'loading') {
    return isTeacher ? '正在读取模型设置…（点击查看）' : '正在读取模型设置…'
  }
  if (state === 'unconfigured') {
    return isTeacher
      ? '还没配置模型 —— 在设置页填写 API Key 后就能对话（点击查看）'
      : '还没配置模型（请老师或家长在设置里的高级设置中配置）'
  }
  const name = `当前模型：${llmDisplayLabel(llm)}`
  return isTeacher ? `${name}（点击更换）` : `${name}（想换模型请去设置里的高级设置）`
}
