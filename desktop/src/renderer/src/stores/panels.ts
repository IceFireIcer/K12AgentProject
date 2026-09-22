/**
 * 对话页两栏的展开状态：左侧「历史对话」+ 右侧「上下文 / 工具 / 学段」。
 *
 * ---------------------------------------------------------------------------
 * 为什么默认**都收起**（2026-09-22 定案）
 * ---------------------------------------------------------------------------
 * 对话页是打开应用落到的第一屏，而两栏在首次进入时都不是学生此刻要读的东西：
 *   · 左栏是「以前聊过什么」—— 第一次打开时它是空的（甚至没有会话）；
 *   · 右栏是检索依据 / 工具轨迹 / 学段证据 —— 那些要等他真的问了一句才有内容。
 * 两栏摊在首屏上的代价是**主列被挤窄**（236 + 300 = 536px 的固定开销），
 * 而首屏真正要读的是开场引导与输入框。
 * 所以：默认收起，各给一个开关（左栏在会话工具条的**左端**、右栏在**右端**），
 * 展开过一次就记住（下次打开保持学生自己选的样子）。
 *
 * ---------------------------------------------------------------------------
 * 为什么用 localStorage 而不是走 IPC 存进 config.json
 * ---------------------------------------------------------------------------
 * 与 `stores/viewMode.ts` 完全同一条理由（照抄它的判断，不要在这里另立一套）：
 *   1. 它**纯属界面偏好**，与「这台机器上是谁在用」无关，不该进 `config.json`
 *      （那是 LLM 配置的权威源，由设置页整体重写）；
 *   2. 走 IPC 就要**新增通道**，而通道总数被 `scripts/doc-facts.mjs` 与
 *      `architecture-guards.test.ts` 双重计数 —— 为一个人机工程开关动契约不划算。
 * localStorage 在 Electron 里是**随 userData 目录持久化**的，重启照常保留。
 *
 * ⚠️ 读写都要 try/catch：localStorage 在 `file://` + 某些沙箱组合下会抛，
 *    而这两个值都是「读不到就回默认」的东西 —— 绝不能因为读偏好失败就让整个应用白屏。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 两栏「没存过偏好时」的默认状态：**收起**（`false` = 收起）。
 *
 * ★ 单独导出一个常量是为了让守卫能直接断言它（「默认必须是收起」这条纪律
 *   不能只活在某个 ref 的初始值里）。
 */
export const PANEL_DEFAULT_OPEN = false

/** localStorage 的键（带应用前缀，避免与同源下别的东西撞名）。 */
export const HISTORY_OPEN_STORAGE_KEY = 'k12.historyOpen'
export const RAIL_OPEN_STORAGE_KEY = 'k12.railOpen'

/**
 * 读一个面板的持久化状态。
 *
 * ★ 只认 `'1'`：读到任何别的东西（旧版本写的、手改的、别的应用同键写进来的）一律回默认。
 */
export function readStoredPanel(key: string): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw === '1') return true
    if (raw === '0') return false
    return PANEL_DEFAULT_OPEN
  } catch {
    return PANEL_DEFAULT_OPEN
  }
}

/** 写一个面板的持久化状态（写不进去只是「下次打开回到默认」，不影响这次）。 */
export function writeStoredPanel(key: string, open: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, open ? '1' : '0')
  } catch {
    /* 忽略：偏好写不进去不该让界面出错 */
  }
}

export const usePanelsStore = defineStore('panels', () => {
  /** 左侧「历史对话」列是否展开。 */
  const historyOpen = ref(readStoredPanel(HISTORY_OPEN_STORAGE_KEY))
  /** 右侧「学习上下文」栏是否展开。 */
  const railOpen = ref(readStoredPanel(RAIL_OPEN_STORAGE_KEY))

  /** 学生自己动手（会持久化）。 */
  function setHistory(open: boolean): void {
    historyOpen.value = open
    writeStoredPanel(HISTORY_OPEN_STORAGE_KEY, open)
  }

  function toggleHistory(): void {
    setHistory(!historyOpen.value)
  }

  /**
   * 改右栏状态。
   *
   * ★ `persist: false` 是给**断点自动收起**用的（窗口变窄时右栏变浮层，那是视口决定的
   *   临时状态，不该覆盖学生自己的选择）—— 见 `Chat.vue` 的 `onBreakpoint`：
   *   离开窄屏时要能把它还原回**学生上次选的样子**，所以那次收起不能落进 localStorage。
   */
  function setRail(open: boolean, options: { persist?: boolean } = {}): void {
    railOpen.value = open
    if (options.persist !== false) writeStoredPanel(RAIL_OPEN_STORAGE_KEY, open)
  }

  function toggleRail(): void {
    setRail(!railOpen.value)
  }

  return { historyOpen, railOpen, setHistory, toggleHistory, setRail, toggleRail }
})
