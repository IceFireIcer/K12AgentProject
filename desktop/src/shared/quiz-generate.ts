/**
 * 练习页「动态出题」的跨边界类型（渲染进程 → 主进程的 invoke 载荷）。
 *
 * ★ 为什么放 shared：渲染层组装它、主进程逐条校验它，两边 import 同一个定义 ——
 *   各写一份的典型故障是「渲染层多塞一个字段，主进程静默丢掉」，而这里被丢掉的
 *   恰恰是最敏感的那种字段（context 里是学生的作答原文）。
 * ★ 它是**内部 IPC 形态，不进冻结契约**：本功能不加端点、不改 pydantic。
 *   所以不写进 @shared/api-types（那是生成物，禁手写）。
 *
 * ★★ 载荷里**没有** studentId / gradeLevel：身份与学段一律由主进程注入
 *   （与 QuizBankRequest / QuizGeneratedListRequest 同一条纪律）——
 *   渲染进程若能给这两个字段，就等于能替主进程决定「读谁的数据、按哪一档出题」。
 */

/** 一道题的作答轨迹（需求里的「决策记录」）：出题服务据此判断该生卡在哪一步。 */
export interface DecisionTrace {
  /** 题目 id（题库题与生成题同一命名空间）。 */
  qid: string
  /** 题号（**展示序** = 合并列表下标 + 1；只让模型能说「第 3 题」，不落库）。 */
  index: number
  /** 题型（与题库载荷的 type 同口径）。 */
  type: 'choice' | 'blank' | 'code_blank'
  /** 来源：内置题库 / 智团团此前生成的题（后者用于「别重复出」）。 */
  source: 'bank' | 'generated'
  /** 题干开头若干字（主进程会再截一次，不信任渲染层给的完整题干）。 */
  stemHead: string
  /**
   * 每次提交的作答与判分结果。
   * ★ correct 为 null 是「这一次判分没回来」，**不是**「答错」：
   *   两者对出题的价值相反（一个是不确定，一个是知道错了），Prompt 里要分开说。
   */
  tries: Array<{ answer: string; correct: boolean | null }>
  /** 首次判分就对；null = 还没有拿到过任何判分结论。 */
  firstTryCorrect: boolean | null
  /** 尝试次数（与 tries.length 同值，冗余一份省得主进程再数）。 */
  triesCount: number
}

/**
 * quiz:generate-auto / quiz:generate-more 的入参。
 *
 * ★ 只有两个字段：**出几道、按什么策略出，全由主进程决定** ——
 *   渲染层传了也不作数（与题库通道的 count 处理同一条纪律）。
 */
export interface QuizGenerateRequest {
  /** 为哪个知识点出题（字符集由主进程再校验一次）。 */
  kpId: string
  /** 决策记录；主进程逐条做白名单投影（条数上限、字段限长、认不出的整条丢）。 */
  context: DecisionTrace[]
}
