/**
 * SSE 管道自检面板的状态。
 *
 * S02 的验收要求「前端能逐条收到 6 种事件」。把这件事做成一个**可见、可复现**
 * 的界面（而不是只在控制台打日志），是因为：
 * 1. 演示/答辩时能当场证明管道通了；
 * 2. 六种事件里的 `blocked` / `error` 在真实链路中极难触发，没有这个开关就永远
 *    测不到（S12 的内容安全与弱网降级会直接依赖这两条分支）。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  BackendUnavailableError,
  streamSse,
  type ChatRequest,
  type GradeLevel
} from '../api/client'
import { readSubagentPayload, type SseEvent, type SseEventName } from '../api/sse-parser'
import { useSidecarStore } from './sidecar'

/** 已收到的事件条目（保留原始事件，便于详情展开）。 */
export interface SseLogEntry {
  index: number
  event: SseEventName
  /** 一行摘要（列表里直接看）。 */
  summary: string
  at: number
}

export const useSseProbeStore = defineStore('sseProbe', () => {
  const entries = ref<SseLogEntry[]>([])
  const running = ref(false)
  const finished = ref(false)
  const error = ref<string | null>(null)
  /** 6 种事件的计数（验收时"是否全覆盖"一眼可见）。 */
  const counts = ref<Record<string, number>>({})
  /** 累加后的正文（验证中文不乱码、逐字到达顺序正确）。 */
  const text = ref('')
  const requestId = ref<string | null>(null)
  /** `done` 事件的 messageId（证明流正常收尾）。 */
  const messageId = ref<string | null>(null)
  const degraded = ref(false)
  const blocked = ref<string | null>(null)
  /** 解析器诊断（异常事件块；正常情况下为空）。 */
  const diagnostics = ref<string[]>([])
  const elapsedMs = ref(0)

  let controller: AbortController | null = null

  const coveredEvents = computed(() => Object.keys(counts.value).sort())
  const allSixCovered = computed(() => coveredEvents.value.length === 6)

  function reset(): void {
    entries.value = []
    counts.value = {}
    text.value = ''
    requestId.value = null
    messageId.value = null
    degraded.value = false
    blocked.value = null
    diagnostics.value = []
    elapsedMs.value = 0
    error.value = null
    finished.value = false
  }

  /** 停止当前流（验收项：中途停止要真的断）。 */
  function stop(): void {
    controller?.abort()
    controller = null
    running.value = false
  }

  async function run(options: { allEvents: boolean; intervalMs?: number }): Promise<void> {
    const sidecar = useSidecarStore()
    const info = sidecar.info
    if (!info?.port || !info.token) {
      error.value = new BackendUnavailableError().message
      return
    }

    reset()
    running.value = true
    const started = Date.now()
    controller = new AbortController()

    const payload: ChatRequest = {
      studentId: 's02-selfcheck',
      grade: 'junior' as GradeLevel,
      message: '什么是循环？'
    }

    try {
      await streamSse(
        { port: info.port, token: info.token },
        {
          path: `/api/chat/stream/echo?interval_ms=${options.intervalMs ?? 15}&all_events=${options.allEvents}`,
          body: payload,
          signal: controller.signal,
          onEvent: (event) => record(event)
        }
      )
      finished.value = true
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        entries.value.push({ index: -1, event: 'error', summary: '已手动停止', at: Date.now() })
      } else {
        error.value = err instanceof Error ? err.message : String(err)
      }
    } finally {
      elapsedMs.value = Date.now() - started
      running.value = false
      controller = null
    }
  }

  /** 单事件落账（`onEvent` 回调）。 */
  function record(event: SseEvent): void {
    counts.value = { ...counts.value, [event.event]: (counts.value[event.event] ?? 0) + 1 }
    if (event.data.requestId) requestId.value = event.data.requestId

    let summary = ''
    switch (event.event) {
      case 'delta':
        text.value += event.data.delta
        summary = JSON.stringify(event.data.delta)
        break
      case 'citation':
        summary = `${event.data.citations.length} 条引用（compat=${event.data.citations.filter((c) => c.compat).length}）`
        break
      case 'payload': {
        const sub = readSubagentPayload(event)
        summary = `kind=${event.data.kind}${sub?.kind === 'quiz' ? `，题目 ${sub.value.questions.length} 道` : ''}`
        break
      }
      case 'blocked':
        blocked.value = event.data.safeText
        summary = `已拦截并替换为安全话术：${event.data.reason}`
        break
      case 'done':
        messageId.value = event.data.messageId
        summary = `messageId=${event.data.messageId}`
        break
      case 'error':
        degraded.value = event.data.degraded
        summary = event.data.message
        break
    }

    entries.value.push({ index: entries.value.length + 1, event: event.event, summary, at: Date.now() })
  }

  return {
    entries,
    running,
    finished,
    error,
    counts,
    text,
    requestId,
    messageId,
    degraded,
    blocked,
    diagnostics,
    elapsedMs,
    coveredEvents,
    allSixCovered,
    run,
    stop,
    reset
  }
})
