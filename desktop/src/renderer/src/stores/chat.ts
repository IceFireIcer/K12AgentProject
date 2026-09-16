/**
 * 对话状态（Pinia）：只负责「收事件 → 交给纯函数折叠 → 暴露给学生界面」。
 *
 * ★ 渲染进程不直连 sidecar 的 HTTP：这里是 `window.api`（preload 白名单）的唯一使用者之一。
 * ★ 事件分发的逻辑全在 `api/events.ts` 的纯函数里（可单测），本文件不做任何解析。
 *
 * ★★ 学段是**系统自己判的，学生改不了**（2026-09 设计变更）：
 *   - 本 store **不发送**学段：`sendChat({ text })`，`ChatSendRequest` 里也没有 `gradeLevel`；
 *   - 「当前学段」来自主进程推送（`api/grade.ts` 描述的 `grade:changed` 通道），
 *     只作为**状态**显示（`currentGrade` + 一次性提示 `gradeNotice`）；
 *   - **没有任何写入口** —— 这个 store 里不存在 `setGrade*`，界面也没有可选学段的控件。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import { GRADE_LABELS, gradeAdaptNotice } from '../labels'
import { normalizeGradeState, resolveGradeBridge, type GradeOrigin } from '../api/grade'
import { buildQuizSubmissionMessage, collectQuizResults, type QuizResultView } from '../cards/quiz'
import {
  applyChatEvent,
  emptyConversation,
  startTurn,
  subscribeToChatEvents,
  type ConversationState
} from '../api/events'

export const useChatStore = defineStore('chat', () => {
  const conversation = ref<ConversationState>(emptyConversation())
  const bridgeReady = ref(true)
  /** 本地提示（桥接缺失、发送被拒等），不是 6 事件里的 `error`。 */
  const localNotice = ref<string | null>(null)
  /**
   * 当前学段（**只读**）：`null` = 系统还没判出来。
   *
   * ★ 只认 `origin === 'inferred'` 的推送：冷启动默认值不是判定结果，
   *   拿它冒充会让学生看到一句错的「我按…来讲」。
   */
  const currentGrade = ref<GradeLevel | null>(null)
  /** 判定来源（`inferred` / `default`；`null` = 还没收到任何推送）。 */
  const gradeOrigin = ref<GradeOrigin | null>(null)
  /** 判定结果**变化**时的一次性提示（下一个问题发出时清掉）。 */
  const gradeNotice = ref<string | null>(null)
  /** 学段推送通道缺失时的可读说明（缺通道不白屏，只说明原因）。 */
  const gradeBridgeError = ref<string | null>(null)
  let unsubscribe: (() => void) | null = null
  let unsubscribeGrade: (() => void) | null = null

  const turns = computed(() => conversation.value.turns)
  const streaming = computed(() => turns.value.some((turn) => turn.status === 'streaming'))

  /** 指示器上的学段名（还没判出来时是「待判定」）。 */
  const currentGradeLabel = computed(() =>
    currentGrade.value === null ? null : GRADE_LABELS[currentGrade.value]
  )

  /**
   * 全对话的批改结果（按 `qid` 索引）。
   *
   * 为什么跨轮收集：题目卡片在某一轮，学生作答后**下一轮**才带回 `QuizResult`；
   * 只在本轮找的话，题干那张卡片永远等不到「答对了 / 掌握度 +0.15」。
   */
  const quizResults = computed<Map<string, QuizResultView>>(() =>
    collectQuizResults(turns.value.flatMap((turn) => turn.cards))
  )

  /** 连上主进程事件流（幂等：重复调用不会重复订阅）。 */
  function connect(): void {
    connectGrade()
    if (unsubscribe !== null) return
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      localNotice.value = '预加载脚本未生效（window.api 缺失），对话通道不可用。'
      return
    }
    bridgeReady.value = true
    unsubscribe = subscribeToChatEvents(window.api, (event) => {
      conversation.value = applyChatEvent(conversation.value, event)
    })
  }

  /** 断开事件流（组件卸载时必须调用，避免监听器堆积）。 */
  function disconnect(): void {
    unsubscribe?.()
    unsubscribe = null
    unsubscribeGrade?.()
    unsubscribeGrade = null
  }

  /**
   * 订上学段推送（幂等；缺通道时只记原因，不抛异常）。
   *
   * 主进程推什么就显示什么 —— 渲染进程**不做第二套判定**，也不缓存成可写的选择。
   */
  function connectGrade(): void {
    if (unsubscribeGrade !== null) return
    const lookup = resolveGradeBridge()
    if (!lookup.ready) {
      gradeBridgeError.value = lookup.message
      return
    }
    gradeBridgeError.value = null

    try {
      unsubscribeGrade = lookup.bridge.onGradeChanged((raw) => {
        applyGradeState(raw)
      })
    } catch (error) {
      gradeBridgeError.value = `学段推送订阅失败：${error instanceof Error ? error.message : String(error)}`
      return
    }

    // 初始值（可选能力）：拿不到就等推送，不报错
    void lookup.bridge.getGrade?.().then(
      (result) => {
        if (result.ok) applyGradeState(result.data)
      },
      () => {
        /* 拉取失败不影响推送路径 */
      }
    )
  }

  /**
   * 应用一条学段状态（纯折叠 + 一次性提示）。
   *
   * 提示只在「显示出来的学段真的变了」时给：初次收到 `default` 不算变化，
   * 第一次判定成功（`default` → `inferred`）与后续改判都算 —— 这正是学生该感知的时刻。
   */
  function applyGradeState(raw: unknown): void {
    const next = normalizeGradeState(raw)
    if (next === null) return

    const previous = currentGrade.value
    gradeOrigin.value = next.origin
    if (next.origin !== 'inferred') return

    currentGrade.value = next.gradeLevel
    if (previous !== next.gradeLevel) gradeNotice.value = gradeAdaptNotice(next.gradeLevel)
  }

  /** 发一轮对话：本地先落学生消息，拿到 `requestId` 后建立本轮（事件可能已在前头到达，会被回放）。 */
  async function send(rawText: string): Promise<void> {
    const text = rawText.trim()
    if (text.length === 0 || streaming.value) return

    localNotice.value = null
    gradeNotice.value = null
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      localNotice.value = '预加载脚本未生效（window.api 缺失），无法发送。'
      return
    }

    // ★ 这一轮用的学段由**系统**决定：这里只是把「当前判定结果」记在轮次上，供界面标注
    const gradeAtSend = currentGrade.value

    try {
      // ★ 不传学段：`ChatSendRequest` 里没有 `gradeLevel`（学段由系统判定，前端说了不算）
      const result = await window.api.sendChat({ text })
      if (!result.ok) {
        localNotice.value = result.message
        return
      }
      conversation.value = startTurn(conversation.value, result.requestId, text, gradeAtSend)
    } catch (error) {
      localNotice.value = `发送失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 练习卡片提交作答（票 14 的前端一半）。
   *
   * ★ **前端不判分**：这里只把「题目编号 + 学生的作答」说清楚，交给主 Agent 调 `submit_quiz`，
   *   判分与掌握度更新都在 Python 侧（§6.3 答案泄漏防护）。渲染进程拿不到答案，也不需要。
   */
  async function submitQuizAnswer(question: { qid: string; stem: string }, answer: string): Promise<void> {
    await send(buildQuizSubmissionMessage(question, answer))
  }

  return {
    conversation,
    turns,
    streaming,
    bridgeReady,
    localNotice,
    currentGrade,
    currentGradeLabel,
    gradeOrigin,
    gradeNotice,
    gradeBridgeError,
    quizResults,
    connect,
    connectGrade,
    disconnect,
    send,
    submitQuizAnswer
  }
})
