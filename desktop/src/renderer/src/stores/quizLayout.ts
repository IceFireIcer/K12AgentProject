/**
 * 闯关页的**答题排版**：一次一张（默认）/ 全部铺开。
 *
 * ── 为什么需要它（用户 2026-09-26 的设计裁决）─────────────────────────────
 * 旧版把一关的题**全部铺开**排在同一张卡里。三题还行，但学生做的是「先做完这一题
 * 再看下一题」的节奏：一屏里同时摆着三份题面 / 选项 / 提交键时，他不知道**现在**该做哪一道，
 * 而且每答对一道，视线还要自己在页面上找下一道在哪。
 * 新排版「一次一张」把节奏交给界面：答对 → 点「下一题」→ 卡片换成下一题。
 * **旧排版一字不改地保留**（列表里一题一块、答对后自动滚到下一道没做对的），
 * 所以这是个**开关**，不是替换。
 *
 * ── 为什么默认是「一次一张」──────────────────────────────────────────────
 * 判错方向的代价不对称：默认一次一张，想要总览的学生点一下开关就有；
 * 而默认全部铺开，等于这次改动对「打开就看」的学生完全没生效。
 *
 * ── 为什么用 localStorage 而不是走 IPC 存进 config.json ──────────────────
 * 与 `stores/viewMode.ts` / `stores/panels.ts` **完全同一条理由**（照抄那两处，不要另立一套）：
 *   1. 它纯属界面偏好，与「这台机器上是谁在用」无关，不该进 `config.json`
 *      （那是 LLM 配置的权威源，由设置页整体重写）；
 *   2. 走 IPC 就要**新增通道**，而通道总数被 `scripts/doc-facts.mjs` 与
 *      `architecture-guards.test.ts` 双重计数 —— 为一个人机工程开关动契约不划算。
 * localStorage 在 Electron 里是**随 userData 目录持久化**的，重启照常保留。
 *
 * ⚠️ 读写都要 try/catch：localStorage 在 `file://` + 某些沙箱组合下会抛，
 *    而这是一个「读不到就回默认值」的场景 —— 绝不能因为读偏好失败就让整个应用白屏。
 *
 * ★ 本文件**必须自包含**（没有相对 import）：`tests/quiz-layout-mode.test.ts` 会直接用
 *   Node 的 ESM 加载器 import 它来断言默认值与白名单行为，而 Node 解析不了渲染进程里
 *   那种不带后缀的相对 import（与 `stores/ui.ts` / `stores/panels.ts` 同一条纪律）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 两种排版的字面量（`single` = 一次一张，`list` = 全部铺开）。 */
export type QuizLayout = 'single' | 'list'

/**
 * 没存过偏好时的默认排版：**一次一张**。
 *
 * ★ 单独导出一个常量是为了让守卫能直接断言它（「默认必须是一次一张」这条纪律
 *   不能只活在某个 ref 的初始值里）。
 */
export const QUIZ_LAYOUT_DEFAULT: QuizLayout = 'single'

/** localStorage 的键（带应用前缀，避免与同源下别的东西撞名）。 */
export const QUIZ_LAYOUT_STORAGE_KEY = 'k12.quizLayout'

/**
 * 读持久化的排版模式。
 *
 * ★ 只认 `'single'` / `'list'` 两个字面量：读到任何别的东西（旧版本写的、手改的、
 *   别的应用同键写进来的）一律回默认 —— 默认是「一次一张」。
 */
export function readStoredQuizLayout(): QuizLayout {
  try {
    const raw = globalThis.localStorage?.getItem(QUIZ_LAYOUT_STORAGE_KEY)
    if (raw === 'list') return 'list'
    if (raw === 'single') return 'single'
    return QUIZ_LAYOUT_DEFAULT
  } catch {
    return QUIZ_LAYOUT_DEFAULT
  }
}

export const useQuizLayoutStore = defineStore('quizLayout', () => {
  /** 当前排版（初值来自 localStorage，读不到就是默认的一次一张）。 */
  const mode = ref<QuizLayout>(readStoredQuizLayout())

  /** 切换排版：写完立刻落盘（写不进去只是「下次打开回到默认」，不影响这次）。 */
  function set(next: QuizLayout): void {
    mode.value = next
    try {
      globalThis.localStorage?.setItem(QUIZ_LAYOUT_STORAGE_KEY, next)
    } catch {
      /* 忽略：偏好写不进去不该让界面出错 */
    }
  }

  return { mode, set }
})
