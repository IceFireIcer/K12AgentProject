/**
 * 工具调用轨迹（Pinia）：把主进程推来的**本轮快照**收下来给右栏显示。
 *
 * ★ 它是**独立于 6 事件流**的通道（见 `shared/ipc-events.ts` 的说明）：
 *   轨迹是工程证据（哪次调了什么 Tool、多快、有没有降级），
 *   与对话状态机不是一回事。混进事件词表会让每个消费方都被迫理解它。
 *
 * ★ 快照语义：主进程每记录一条就推一次**全量**，这里直接替换。
 *   不攒增量、不做合并 —— 一轮只有几个 Tool，全量替换省掉一整套
 *   「对不上号就重来」的恢复协议。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { TraceEntry, TraceSnapshot } from '@shared/ipc-events'
import { resolveDataBridge } from '../api/data'

export const useTraceStore = defineStore('trace', () => {
  const entries = ref<TraceEntry[]>([])
  /** 快照覆盖的最大轮次（0 = 还没有任何记录）。 */
  const turn = ref(0)
  /** 桥缺失时的可读说明（分步接线 / 测试替身没装全）。 */
  const bridgeError = ref<string | null>(null)

  let unsubscribe: (() => void) | null = null

  /** 有没有出现过降级（右栏据此在标题上标一个小点，提示「这次能力受限」）。 */
  const hasDegraded = computed(() => entries.value.some((entry) => Boolean(entry.degraded)))
  /** 失败过几次（含被安全阀拦下的）。 */
  const failureCount = computed(() => entries.value.filter((entry) => !entry.ok).length)

  /**
   * 按轮次分组（右栏把同一轮的调用折叠成一组）。
   *
   * ★ 分组顺序 = 轮次升序；组内保持**记录顺序**（那是真实调用顺序，
   *   按 toolName 排会看不出先后）。
   */
  const byTurn = computed(() => {
    const groups = new Map<number, TraceEntry[]>()
    for (const entry of entries.value) {
      const list = groups.get(entry.turn)
      if (list) list.push(entry)
      else groups.set(entry.turn, [entry])
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([turnIndex, items]) => ({ turn: turnIndex, entries: items }))
  })

  /** 订阅轨迹推送（幂等）。组件挂载时调一次即可。 */
  function connect(): void {
    if (unsubscribe !== null) return
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bridgeError.value = null
    unsubscribe = lookup.bridge.onTraceChanged((snapshot) => applySnapshot(snapshot))
  }

  function disconnect(): void {
    if (unsubscribe !== null) {
      unsubscribe()
      unsubscribe = null
    }
  }

  /**
   * 收一份快照。
   *
   * ★ 形状在 preload 边界已经过滤过（`isTraceSnapshot`），这里再挡一次
   *   「比当前更旧的快照」：网络/IPC 没有顺序保证，一份迟到的旧快照
   *   会把界面上已经出现的轨迹**擦回去**（看起来像「工具调用突然消失了」）。
   */
  function applySnapshot(snapshot: TraceSnapshot): void {
    if (Array.isArray(snapshot.entries) && snapshot.turn < turn.value) return
    entries.value = Array.isArray(snapshot.entries) ? snapshot.entries : []
    turn.value = typeof snapshot.turn === 'number' ? snapshot.turn : 0
  }

  /** 清空（开始新会话时用）。 */
  function reset(): void {
    entries.value = []
    turn.value = 0
  }

  return { entries, turn, bridgeError, hasDegraded, failureCount, byTurn, connect, disconnect, reset }
})
