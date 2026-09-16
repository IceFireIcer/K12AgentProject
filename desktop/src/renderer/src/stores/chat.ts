/**
 * 对话状态（Pinia）：只负责「收事件 → 交给纯函数折叠 → 暴露给学生界面」。
 *
 * ★ 渲染进程不直连 sidecar 的 HTTP：这里是 `window.api`（preload 白名单）的唯一使用者之一。
 * ★ 事件分发的逻辑全在 `api/events.ts` 的纯函数里（可单测），本文件不做任何解析。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import {
  applyChatEvent,
  emptyConversation,
  startTurn,
  subscribeToChatEvents,
  type ConversationState
} from '../api/events'

/** 冷启动默认学段（执行文档 §10.1：学生从未选择时生效；选择器归票 06）。 */
export const DEFAULT_GRADE_LEVEL: GradeLevel = 'primary_high'

export const useChatStore = defineStore('chat', () => {
  const conversation = ref<ConversationState>(emptyConversation())
  const bridgeReady = ref(true)
  /** 本地提示（桥接缺失、发送被拒等），不是 6 事件里的 `error`。 */
  const localNotice = ref<string | null>(null)
  const gradeLevel = ref<GradeLevel>(DEFAULT_GRADE_LEVEL)
  let unsubscribe: (() => void) | null = null

  const turns = computed(() => conversation.value.turns)
  const streaming = computed(() => turns.value.some((turn) => turn.status === 'streaming'))

  /** 连上主进程事件流（幂等：重复调用不会重复订阅）。 */
  function connect(): void {
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
  }

  /** 发一轮对话：本地先落学生消息，拿到 `requestId` 后建立本轮（事件可能已在前头到达，会被回放）。 */
  async function send(rawText: string): Promise<void> {
    const text = rawText.trim()
    if (text.length === 0 || streaming.value) return

    localNotice.value = null
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      localNotice.value = '预加载脚本未生效（window.api 缺失），无法发送。'
      return
    }

    try {
      const result = await window.api.sendChat({ text, gradeLevel: gradeLevel.value })
      if (!result.ok) {
        localNotice.value = result.message
        return
      }
      conversation.value = startTurn(conversation.value, result.requestId, text)
    } catch (error) {
      localNotice.value = `发送失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  return {
    conversation,
    turns,
    streaming,
    bridgeReady,
    localNotice,
    gradeLevel,
    connect,
    disconnect,
    send
  }
})
