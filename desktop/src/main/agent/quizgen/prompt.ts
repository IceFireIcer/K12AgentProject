/**
 * 个性化出题 Prompt（主进程，**纯函数**）—— 2026-10-01「练习动态出题」计划 §4.2。
 *
 * ★★ 为什么骨架直接复用 `buildVariantPrompt` 而不是照抄一遍：下游解析
 *    （`parseVariantPayload` → `prepareVariants` → `registerVariants`）认的是
 *    **一行 JSON `{"questions":[…]}`** 这个约定。抄一遍就等于有了两份「约定」，
 *    改一处漏一处，表现是「模型输出突然解析不了」而这个文件看起来完全正常。
 *    所以本文件只做**内容层**的个性化：把「这名学生刚做完什么、哪几道做得不顺、
 *    别重复出哪些题」插进骨架的 JSON 输出要求**之前**，其余一字不动。
 *
 * ★ 纯函数：输入全是数据（不读 store、不发请求、不碰学生 id），所以 `node --test`
 *    能直接覆盖它。出几道、出给谁由服务层决定 —— 这里只管「怎么跟模型说」。
 */
import type { DecisionTrace } from '../../../shared/quiz-generate.ts'
import { buildVariantPrompt } from '../extensions/quiz.ts'

/** 出题素材与约束（字段名与冻结接口 v1 一致）。 */
export interface PersonalizedQuizPromptInput {
  gradeLevel: string
  kpId: string
  count: number
  /** 刚做完那一批的总体表现（判分数 / 答对数 / 一次就对数 / 反复尝试数）。 */
  summary: { graded: number; correct: number; firstTryCorrect: number; multiTry: number }
  /** 逐题轨迹（错题的**错选原文**就在 tries 里，是本次个性化最值钱的素材）。 */
  traces: DecisionTrace[]
  /** 已有题干（内置 + 之前生成的），作为**去重约束**写进 Prompt。 */
  existingStems: string[]
}

/** 去重清单最多列几条 / 每条截多长（Prompt 不是日志，超量只会稀释指令）。 */
const MAX_EXISTING_STEMS = 40
const MAX_STEM_CHARS = 80
/** 单次作答最多引用多少个字（错选原文要留住，长填空不必铺满 Prompt）。 */
const MAX_ANSWER_CHARS = 60
/** 一次答对率到这条线以上就加深（§4.2：换情境 / 提升一步推理）。 */
const DEEPEN_RATIO = 0.8

/** 单行化 + 截断（模型读的是指令，不是要还原原文）。 */
function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? single.slice(0, max) + '…' : single
}

/**
 * 一次作答 + 判分结论。
 * ★ `correct === null` 是「**这一次没判出来**」，与「答错」对出题的价值相反
 *   （一个是不确定、一个是知道错了），所以两种说法必须分开 —— 与 shared/quiz-generate.ts
 *   里 DecisionTrace.tries 的注释是同一条口径。
 */
function describeTry(tried: { answer: string; correct: boolean | null }): string {
  const answer = clip(tried.answer, MAX_ANSWER_CHARS)
  if (tried.correct === false) return answer + '（不对）'
  if (tried.correct === true) return answer + '（对了）'
  return answer + '（这次没判出来）'
}

/** 需要重点巩固的题：没一次答对的都算（答错 / 反复尝试 / 判分没回来）。 */
function hardTraces(traces: DecisionTrace[]): DecisionTrace[] {
  return traces.filter((trace) => trace.firstTryCorrect !== true)
}

/**
 * 组装这一次的个性化出题 Prompt。
 *
 * 结构 = 骨架（`buildVariantPrompt`，含学段 / kpId / 题数 / 题型 / JSON 形态）
 *        + 【这名学生刚刚做完的练习】（总体定档）
 *        + 【需要重点巩固的题】（错题题干 + 错选原文）
 *        + 【不要与这些题重复】（existingStems 去重约束）
 *        + 骨架原有的一行 JSON 输出要求（**永远留在最后**）。
 */
export function buildPersonalizedQuizPrompt(input: PersonalizedQuizPromptInput): string {
  const { graded, correct, firstTryCorrect, multiTry } = input.summary
  const personal: string[] = []

  personal.push(
    '【这名学生刚刚做完的练习】判分 ' + graded + ' 道，答对 ' + correct + ' 道，一次就答对 ' +
      firstTryCorrect + ' 道，反复尝试过 ' + multiTry + ' 道。'
  )
  if (graded > 0 && firstTryCorrect >= graded * DEEPEN_RATIO) {
    // 一次答对率高 → 加深变式；不是加深题量（题量由服务层按配额定）
    personal.push('他掌握得不错：这批题要比刚才那批再深一步（换情境 / 多一步推理），不要原地重复同一个问法。')
  } else if (graded > 0) {
    personal.push('他还没完全稳：先保住基础变式，把同一个考查点换几种问法练到能做对，不要堆偏题怪题。')
  }

  const hard = hardTraces(input.traces)
  if (hard.length > 0) {
    personal.push('')
    personal.push('【需要重点巩固的题】下面是学生做得不顺的题，请围绕它们考查的同一个子概念出同类型题：')
    for (const trace of hard) {
      const tried = trace.tries.length > 0 ? trace.tries.map(describeTry).join('；') : '（没有留下作答）'
      personal.push(
        '- 第 ' + trace.index + ' 题（' + clip(trace.stemHead, MAX_STEM_CHARS) + '）：学生作答 ' + tried + '。'
      )
    }
    personal.push('新题要换数字 / 换问法再练一遍，不要原题照搬。')
  } else if (input.traces.length === 0) {
    // v1 已知局限（计划 §10）：轨迹是页面内存态，切走再回来可能只剩题干清单 —— 明说，不编
    personal.push('这名学生的历史作答不可用 —— 按这个知识点最常见的学习难点出题。')
  }

  if (input.existingStems.length > 0) {
    personal.push('')
    personal.push('【不要与这些题重复】以下是这个知识点已经出现过的题干（换数字 / 换问法算新题）：')
    for (const stem of input.existingStems.slice(0, MAX_EXISTING_STEMS)) {
      const text = clip(stem, MAX_STEM_CHARS)
      if (text !== '') personal.push('- ' + text)
    }
  }

  /*
   * ★★ 题型配比**交给模型现场判断**（2026-10-01 用户裁决 D-133）：「开放题比例我不管，
   *   你可以动态调配，根据 LLM 的意图来」。
   *
   * 骨架（`buildVariantPrompt`）里那条「最多一道可以是开放的问答题」是**通用变式题**的口径；
   * 练习页这条链路现在显式作废它 —— 因为这里手上有**逐题作答轨迹**：哪几道反复错、错选了什么，
   * 都在上面喂给了模型。哪些考查点该用选择题辨、哪些该让学生自己组织语言，模型比一条固定比例更清楚。
   *
   * ⚠️ 只保留一条**成本护栏**（不是配比）：开放题（rubric 非空）由模型判分，学生提交后要等
   *   十几秒 —— 所以「整批不超过一半」，其余尽量给能立即判分的题型。这条也写进 Prompt 让模型自己权衡，
   *   而不是在代码里硬切。
   * ⚠️ 本节**优先于**骨架里那条旧限制：必须写明，否则两段话打架时模型多半听先出现的那句。
   */
  personal.push('')
  personal.push('【题型由你决定】上面骨架里「最多一道开放题」的限制**作废**，以本节为准：')
  personal.push('按每道题要考的能力现场挑题型，不必凑固定比例：')
  personal.push('- 概念辨析、易混点、需要排除干扰项 → choice（2-4 个 options）')
  personal.push('- 术语、步骤、数值的回忆 → blank；代码语境 → code_blank')
  personal.push('- 需要学生自己组织语言或多步推理 → 开放题：type 仍填 blank，**必须给 rubric**（答出哪些要点），answer 是参考答案而非唯一解')
  personal.push('开放题由模型判分，学生提交后要等一会儿 —— 所以整批**不要超过一半**；')
  personal.push('如果上面的轨迹显示他反复答错、需要自己讲一遍才算真懂，可以多给一两道，但先保住其余题的即答体验。')

  // 骨架的最后一段是「只输出一行 JSON…」+ 示例：个性化内容必须插在它**之前** ——
  // 否则输出形态那条约定不再压轴，而模型最容易照抄的正是最后一句。
  const skeleton = buildVariantPrompt({
    kpId: input.kpId,
    gradeLevel: input.gradeLevel,
    count: input.count
  }).split('\n')
  const tailAt = skeleton.findIndex((line) => line.startsWith('只输出一行 JSON'))
  const head = tailAt >= 0 ? skeleton.slice(0, tailAt) : skeleton
  const tail = tailAt >= 0 ? skeleton.slice(tailAt) : []
  return [...head, '', ...personal, '', ...tail].join('\n')
}
