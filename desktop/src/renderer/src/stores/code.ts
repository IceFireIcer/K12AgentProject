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
  /** 非响应式：同一知识点的并发取模板只发一次。 */
  let templateInFlight: Promise<void> | null = null

  const currentHintLevel = computed(() =>
    hints.value.reduce((max, hint) => Math.max(max, hint.level), 0)
  )
  /** 还能不能再要一级（到 3 就不给了 —— 再给就是直接写答案）。 */
  const canAskMoreHints = computed(() => currentHintLevel.value < CODE_HINT_MAX)
  const latestHint = computed(() => hints.value[hints.value.length - 1] ?? null)

  /**
   * 取某知识点的脚手架。
   *
   * ★ 载荷里**没有 `solution`**（结构上就不存在）。所以「参考答案」这条路径
   *   在本页一开始就是不存在的 —— 不是靠界面藏起来。
   */
  async function loadTemplate(kpId: string): Promise<void> {
    if (templateInFlight) return await templateInFlight
    activeKpId.value = kpId
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    templateLoading.value = true
    templateError.value = null
    templateInFlight = (async () => {
      try {
        const result = await lookup.bridge.readCodeTemplate({ kpId })
        if (result.ok) {
          template.value = result.data as CodeTemplateView
          // 脚手架就是编辑器的初始内容（学生的改动在 draft 里，不覆盖已有草稿）
          if (draft.value.length === 0) draft.value = template.value.scaffold
        } else {
          templateError.value = result.message
          template.value = null
        }
      } catch (thrown) {
        templateError.value = thrown instanceof Error ? thrown.message : String(thrown)
      } finally {
        templateLoading.value = false
        templateInFlight = null
      }
    })()
    await templateInFlight
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
      hintError.value = `提示已经给到第 ${CODE_HINT_MAX} 级了 —— 再往下就等于直接给答案，先按这个方向试一试。`
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
      if (result.ok) {
        const hint = result.data as CodingHintView
        // 去重：同级别重复返回时不要堆两条一样的提示
        if (!hints.value.some((item) => item.level === hint.level)) hints.value = [...hints.value, hint]
      } else {
        hintError.value = result.message
      }
    } catch (thrown) {
      hintError.value = thrown instanceof Error ? thrown.message : String(thrown)
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
      if (result.ok) evaluation.value = result.data as CodeEvaluationView
      else analyzeError.value = result.message
    } catch (thrown) {
      analyzeError.value = thrown instanceof Error ? thrown.message : String(thrown)
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
