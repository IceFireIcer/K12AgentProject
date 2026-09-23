/**
 * 编程（Pinia）：脚手架 / 分级提示 / 运行后的分析。
 *
 * ★★ 本 store **不执行任何代码**。
 *   学生代码只在渲染进程的 Pyodide Worker 里跑（`sandbox/pyodide-runner.ts`），
 *   跑完把 `stdout` / `stderr` 交给后端做「中文报错归一 + 定下一级提示」。
 *   架构硬约束：主进程与 sidecar 都不执行学生代码（有守卫测试盯着）。
 *
 * ★ 分级提示**逐级要**（1 → 2 → 3），不一次给全：
 *   一次全给等于把答案摆在旁边，学生就不会先自己想一遍了 ——
 *   「分级求助」这条链路的全部价值就在于**一次只多给一点**。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  resolveDataBridge,
  type CodeEvaluationView,
  type CodeTemplateView,
  type CodingHintView
} from '../api/data'
// ★ 面向学生的失败文案：判据（HTTP 状态码 / 服务器路径 / 内部 kp_id …）与连接层归一
//   只有一处实现，本文件与 quiz / animation 共用 —— 同一个缺陷原本三处都有。
import {
  CONNECTION_FAILURE_TEXT,
  describeClientError,
  looksLikeConnectionFailure,
  looksLikeTroubleshooting,
  toStudentFacingMessage
} from '../api/student-facing'

/** 提示级别的上下限（与后端 `GET /api/code/hint` 的 `level` 约束一致）。 */
export const CODE_HINT_MIN = 1
export const CODE_HINT_MAX = 3

export const useCodeStore = defineStore('code', () => {
  /** 当前正在做的知识点（空串 = 还没选）。 */
  const activeKpId = ref('')
  const template = ref<CodeTemplateView | null>(null)
  const templateLoading = ref(false)
  const templateError = ref<string | null>(null)

  /** 已取回来的提示（按级别递增堆叠）。 */
  const hints = ref<CodingHintView[]>([])
  const hintLoading = ref(false)
  const hintError = ref<string | null>(null)

  /** 最近一次运行后的分析结果（后端给的反馈 + 下一级提示）。 */
  const evaluation = ref<CodeEvaluationView | null>(null)
  const analyzing = ref(false)
  const analyzeError = ref<string | null>(null)

  /** 学生在编辑器里的代码（**只在本页内存里**；不落库、不进会话）。 */
  const draft = ref('')

  const bridgeError = ref<string | null>(null)

  /**
   * 非响应式：**同一请求键**的并发取模板只发一次。
   *
   * ★★ 「在途去重」必须看**请求键**（这里就是 kpId），不能只看「有没有请求在飞」：
   *   旧写法 `if (templateInFlight) return await templateInFlight` 会在学生连点两个
   *   知识点时把**第二个请求静默丢掉** —— 而 `activeKpId` 已经切到 B、`template` 还是 A 的。
   *   编程页更重：视图的 `selectedKpId` 已是 B，`analyzeRun` 拿 `activeKpId`（= A）
   *   把 B 的代码按 A 的知识点去分析并给提示。
   *   现在：键相同才去重（同一知识点的重复点击确实不必发两次），键不同就**并发发新的**；
   *   并且**只让最后一次请求写结果**（迟到的旧响应不许把新题目的模板盖回去）。
   *   对照组是 `stores/study.ts` 的 `chaptersInFlight === gradeLevel`。
   */
  let templateInFlight: { key: string; promise: Promise<void> } | null = null
  /** 取模板的请求序号：**只让最后一次**发出的请求写结果（迟到的旧响应不许盖回来）。 */
  let templateRequestSeq = 0

  const currentHintLevel = computed(() =>
    hints.value.reduce((max, hint) => Math.max(max, hint.level), 0)
  )
  /** 还能不能再要一级（到 3 就不给了 —— 再给就是直接写答案）。 */
  const canAskMoreHints = computed(() => currentHintLevel.value < CODE_HINT_MAX)
  const latestHint = computed(() => hints.value[hints.value.length - 1] ?? null)

  /**
   * 记下一条**已经给到**学生的提示（同级别去重：重复返回时不要堆两条一样的）。
   *
   * ★ 两条来源都走这里，缺一条就会出现「提示倒退」：
   *   ① 学生点「求助」拿回来的那一级（`askForHint`）；
   *   ② 运行失败时后端随 `evaluation.nextHint` 一并给的提示 —— 它此前**只被页面显示、
   *      没有写回 store**，于是 `currentHintLevel` 低估，学生再点「求助」反而要回
   *      **更低**一级的提示。主进程侧早已修好同类问题（`agent/extensions/coding.ts` 的 F7：
   *      「不记会导致更低一级的提示，与设计口径正相反」），这条是渲染进程漏掉的。
   */
  function recordHint(hint: CodingHintView): void {
    if (hints.value.some((item) => item.level === hint.level)) return
    hints.value = [...hints.value, hint]
  }

  /**
   * 清空「已给的提示」与它的失败原因（**换知识点时**调，见 `loadTemplate`）。
   *
   * ★ 为什么必须清：提示是**按知识点**给的 —— A 的第 1/2 级文本出现在 B 的任务卡里
   *   就是串台；而 `canAskMoreHints` 由 `hints` 派生，A 给到第 3 级会让 B 的「求助」
   *   按钮**直接 disabled**（学生以为 B 没有提示可给）。
   * ★ 同一知识点内**不清**：那是学生已经看过的提示，重读一遍不该消失。
   */
  function resetHints(): void {
    hints.value = []
    hintError.value = null
  }

  /**
   * ★★ 把「后端/开发者视角的失败原因」翻成**学生看得懂的一句话**。
   *
   * 为什么必须在界面这一层做（实测抓到的缺陷）：编程页的默认状态是
   * 「这个知识点还没有预置模板」—— 后端为此回的是**面向排障**的 404 文案：
   * ```
   * 读取失败（HTTP 404）：知识点 'ai-definition-pl' 还没有预置代码模板。
   * 现有模板：prog-list-jr、prog-loop-jr、prog-variable-jr（模板文件：server/resources/code-templates/）。
   * ```
   * 一个 10 岁的学生打开编程页，看到的是 **HTTP 状态码 + 内部 kp_id + 服务器上的文件路径**。
   * 这既像「软件坏了」（他会关掉页面，而不是「换个知识点」），
   * 又暴露了不该给学生看的内部结构。
   *
   * ★ 为什么不改后端文案：那句话对**排障**是有用的（开发/日志里正需要知道有哪些模板、
   *   目录在哪），而且 `get_code_template` Tool 也会用到同一份错误。
   *   正确做法是**在渲染层按受众改写** —— 内部细节留在内层，给学生的那层说人话。
   *
   * ★ 判据用「像不像技术信息」而不是精确匹配某一句：后端文案会变（也可能换成别的
   *   404 原因），而 **HTTP 状态码 / server 路径 / `/api/` 地址 / 引号里的 kp_id /
   *   traceback** 这类特征稳定。判据的**唯一实现**是 `api/student-facing.ts` 的
   *   `looksLikeTroubleshooting()` —— 同一个缺陷原本在 code / quiz / animation
   *   三处都有，各写一份必然漂移。
   * ★ 命中技术信息 → 换成可读一句话，且**原文只进控制台**（`console.warn(...)`，
   *   老师与开发者排障要看），界面上给的是：
   *   「这道题还没有配套的代码模板。换一个知识点试试，或者先让智团团用文字讲讲。」
   *   （这句下一步动作是编程页特有的，所以留在本文件，不放共享的兜底表里。）
   */
  function studentFacingTemplateError(raw: unknown): string {
    // 连接层失败（`fetch failed` / `ECONNREFUSED`）单独一类：它说的是「服务正在重启」，
    // 不是「这个知识点没有模板」—— 处置动作完全不同，不能混进同一句话。
    // ⚠️ 真正的原因在 `error.cause.code` 里（Node 的 fetch 只把 message 写成 `fetch failed`）。
    if (raw instanceof Error && looksLikeConnectionFailure(raw)) return CONNECTION_FAILURE_TEXT
    const text = (typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : '').trim()
    if (text.length === 0) return '暂时取不到这道题的代码模板。'
    // 判据：这段文字像不像**面向排障**的技术信息 ——
    //   HTTP 状态码 / server 路径 / /api/ 地址 / 引号里的 kp_id / traceback。
    // 唯一实现在 `api/student-facing.ts` 的 `looksLikeTroubleshooting()`
    // （同一个缺陷在 code / quiz / animation 三处都有，各写一份判据必然漂移）。
    if (!looksLikeTroubleshooting(text)) return text
    // 原文只进控制台（老师/开发者排障要看），界面上不出现
    console.warn('[coding] 模板读取失败（原始原因，仅排查用）：', text)
    return '这道题还没有配套的代码模板。换一个知识点试试，或者先让智团团用文字讲讲。'
  }

  /**
   * 取某知识点的脚手架。
   *
   * ★ 载荷里**没有 `solution`**（结构上就不存在）。所以「参考答案」这条路径
   *   在本页一开始就是不存在的 —— 不是靠界面藏起来。
   * ★ 换知识点即换一道题：提示随之清空（同一知识点内保留）。
   */
  async function loadTemplate(kpId: string): Promise<void> {
    // 键相同 → 复用那一次在途请求；键不同 → 往下走，**并发发新的**（不静默丢掉）
    if (templateInFlight !== null && templateInFlight.key === kpId) {
      return await templateInFlight.promise
    }
    if (activeKpId.value !== kpId) resetHints()
    activeKpId.value = kpId
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    templateLoading.value = true
    templateError.value = null
    // 只有**最后一次**发出的请求能写结果：迟到的旧响应若照写，学生已经切到 B 了，
    // 却会被 A 的模板 / 失败文案盖回去 —— 界面与所选题目就此分叉。
    const seq = (templateRequestSeq += 1)
    const request = (async () => {
      try {
        const result = await lookup.bridge.readCodeTemplate({ kpId })
        if (seq !== templateRequestSeq) return
        if (result.ok) {
          template.value = result.data as CodeTemplateView
          // 脚手架就是编辑器的初始内容（学生的改动在 draft 里，不覆盖已有草稿）
          if (draft.value.length === 0) draft.value = template.value.scaffold
        } else {
          templateError.value = studentFacingTemplateError(result.message)
          template.value = null
        }
      } catch (thrown) {
        if (seq !== templateRequestSeq) return
        // ★ 调用点的这个函数**绝不同步抛**：回执失败与抛异常两条路都要过同一套翻译
        templateError.value = studentFacingTemplateError(thrown)
      }
    })()
    templateInFlight = { key: kpId, promise: request }
    try {
      await request
    } finally {
      // 只有**仍然登记在案**的那次请求负责收尾（关加载态、摘掉在途标记）：
      // 被更新的一次顶掉的那次不该把新请求的加载态关掉。
      if (templateInFlight !== null && templateInFlight.promise === request) {
        templateInFlight = null
        templateLoading.value = false
      }
    }
  }

  /**
   * 要下一级提示。
   *
   * ★ 每次只请求**当前级别 + 1**：这样「学生已经看到第几级」这件事
   *   由本 store 的 `hints` 数组如实反映，服务端不需要为每个学生记这个状态。
   */
  async function askForHint(): Promise<void> {
    const kpId = activeKpId.value
    if (!kpId) return
    if (hintLoading.value) return
    if (!canAskMoreHints.value) {
      // ★ 学生面不用破折号（走查 C16）：两句短句比一个「——」更好读。
      hintError.value = `提示已经给到第 ${CODE_HINT_MAX} 级了。再往下就等于直接给答案，先按这个方向试一试。`
      return
    }
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    const nextLevel = Math.min(currentHintLevel.value + 1, CODE_HINT_MAX)
    hintLoading.value = true
    hintError.value = null
    try {
      const result = await lookup.bridge.readCodeHint({ kpId, level: nextLevel })
      // 换题了就丢掉这次的结果，别把 A 的提示挂到 B 的任务卡上
      if (activeKpId.value !== kpId) return
      if (result.ok) recordHint(result.data as CodingHintView)
      // ★ 失败也要说人话：后端 detail 里带着内部 kp_id 与服务器上的模板目录
      //   （`知识点 'prog-variable-jr' 还没有分级提示（模板文件：server/resources/code-templates/）。`）
      else hintError.value = toStudentFacingMessage(result.message, { topic: 'hint' })
    } catch (thrown) {
      if (activeKpId.value === kpId) hintError.value = describeClientError(thrown, { topic: 'hint' })
    } finally {
      hintLoading.value = false
    }
  }

  /**
   * 把**已经跑完**的代码与输出交给后端分析。
   *
   * ★ `code` / `stdout` / `stderr` 都是**执行结果**，不是要执行的东西 ——
   *   执行发生在本函数被调用**之前**（渲染进程的 Pyodide Worker 里）。
   * ★ 调用方负责把 `attempt` 传对（第几次尝试）：它决定后端给哪一级提示。
   */
  async function analyzeRun(input: {
    code: string
    stdout: string
    stderr: string
    attempt: number
  }): Promise<void> {
    const kpId = activeKpId.value
    if (!kpId) return
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    analyzing.value = true
    analyzeError.value = null
    try {
      const result = await lookup.bridge.analyzeCodeRun({
        kpId,
        code: input.code,
        language: template.value?.language ?? 'python',
        stdout: input.stdout,
        stderr: input.stderr,
        attempt: input.attempt
      })
      if (result.ok) {
        const evaluated = result.data as CodeEvaluationView
        evaluation.value = evaluated
        // ★★ 后端随失败一并给的 `nextHint` 也要**写回「已给到的级别」**（F7 的渲染进程一半）。
        //   只把它显示在输出区是不够的：`currentHintLevel` 由 `hints` 派生，不记就会低估，
        //   学生随后点「求助」时会算出 level 1（比已经给过的还低），与「逐级加深、只升不降」
        //   的设计口径正相反。主进程 `agent/extensions/coding.ts` 的 F7 是同一条理由。
        if (evaluated.nextHint) recordHint(evaluated.nextHint)
      } else {
        analyzeError.value = toStudentFacingMessage(result.message, { topic: 'analyze' })
      }
    } catch (thrown) {
      analyzeError.value = describeClientError(thrown, { topic: 'analyze' })
    } finally {
      analyzing.value = false
    }
  }

  /** 重置编辑器内容回脚手架（**学生的改动会丢**，调用方要先确认）。 */
  function resetToScaffold(): void {
    draft.value = template.value?.scaffold ?? ''
    evaluation.value = null
    analyzeError.value = null
  }

  return {
    activeKpId,
    template,
    templateLoading,
    templateError,
    hints,
    hintLoading,
    hintError,
    currentHintLevel,
    canAskMoreHints,
    latestHint,
    evaluation,
    analyzing,
    analyzeError,
    draft,
    bridgeError,
    loadTemplate,
    askForHint,
    analyzeRun,
    resetToScaffold
  }
})
