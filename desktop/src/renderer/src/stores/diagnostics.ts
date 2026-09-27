/**
 * 轮次诊断信封（Pinia）：演示驾驶舱与机制浮窗的**共同数据源**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一份数据，两处渲染（这是本模块存在的全部理由）
 * ══════════════════════════════════════════════════════════════════════════
 * 演示页（总览 / 答辩讲解）与浮窗（真实页面里就地解释）读的是**同一个 store 的同一份快照**，
 * 只是密度不同。分成两个 store 或两份拷贝，第一次改字段就会漂移成「浮窗说 3 次调用、
 * 演示页说 4 次」—— 而演示时最不能出的就是这种对不上。
 *
 * ★ 快照语义与 `stores/trace.ts` 一致：主进程每轮推**全量**，这里直接替换；
 *   不做增量合并（轮数上限 20，全量替换省掉一整套「对不上号就重来」的恢复协议）。
 * ★ 迟到的旧快照要挡住（`updatedAt` 比当前小就丢）：IPC 没有顺序保证，
 *   一份迟到的旧快照会把界面上已经出现的轮次**擦回去**。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
// ⚠️ 相对路径 + `.ts` 后缀，**不用 `@shared/*` 别名**：本模块现在会被 `stores/chat.ts`
//    经 `stores/demoSeed.ts` 间接拉进若干 node 单测的模块图，而那些用例没有别名的解析钩子
//    （写成别名会让它们当场 `Cannot find package '@shared/diagnostics'`，实测踩到）。
import {
  emptyDiagnosticsSnapshot,
  type DiagSandbox,
  type DiagnosticsSnapshot,
  type TurnDiagnostics
} from '../../../shared/diagnostics'
import { resolveDiagnosticsBridge, type DiagnosticsCallResult } from '../api/diagnostics'

export const useDiagnosticsStore = defineStore('diagnostics', () => {
  const snapshot = ref<DiagnosticsSnapshot>(emptyDiagnosticsSnapshot())
  /** 桥缺失时的可读说明（分步接线 / 测试替身没装全）。 */
  const bridgeError = ref<string | null>(null)
  /** 当前在演示页里选中的轮次（`null` = 还没选，界面回落到最后一轮）。 */
  const selectedTurn = ref<number | null>(null)
  /** 最近一次操作的失败说明（清空失败等；`null` = 没有）。 */
  const lastError = ref<string | null>(null)

  let unsubscribe: (() => void) | null = null

  /** 最近 N 轮，按轮次升序。 */
  const turns = computed<TurnDiagnostics[]>(() => snapshot.value.turns)
  /** 最后一轮（浮窗的默认展示对象）。 */
  const latest = computed<TurnDiagnostics | null>(() => turns.value[turns.value.length - 1] ?? null)
  /** 这一份是不是从落盘记录暖机来的（重启前的记录）。 */
  const fromDisk = computed(() => snapshot.value.persisted && turns.value.length > 0)
  /** 跨轮累计的拦截记录（演示模式的高潮：被拦下了什么）。 */
  const interceptions = computed(() =>
    turns.value.flatMap((turn) =>
      turn.interceptions.map((item) => ({ turn: turn.turn, ...item }))
    )
  )

  /** 当前展示的那一轮（选中的，否则最后一轮）。 */
  const active = computed<TurnDiagnostics | null>(() => {
    const want = selectedTurn.value
    if (want === null) return latest.value
    return turns.value.find((turn) => turn.turn === want) ?? latest.value
  })

  function select(turn: number | null): void {
    selectedTurn.value = turn
  }

  /** 合并沙箱事件（**只在渲染进程采集得到**：Worker 与 iframe 都在这一侧）。 */
  function noteSandbox(patch: Partial<DiagSandbox>): void {
    const current = latest.value
    if (!current) return
    const merged: DiagSandbox = {
      codeExecutedIn: null,
      interrupted: false,
      outputTruncated: false,
      animationReadyTimeout: false,
      ...(current.sandbox ?? {}),
      ...patch
    }
    snapshot.value = {
      ...snapshot.value,
      turns: snapshot.value.turns.map((turn) =>
        turn.turn === current.turn ? { ...turn, sandbox: merged } : turn
      )
    }
  }

  /** 订阅推送（幂等）。组件挂载时调一次即可；同时补一次读取（推送只覆盖「之后的轮次」）。 */
  function connect(): void {
    if (unsubscribe !== null) return
    const lookup = resolveDiagnosticsBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bridgeError.value = null
    unsubscribe = lookup.bridge.onDiagnosticsChanged((next) => applySnapshot(next))
    void lookup.bridge.readDiagnostics().then((result) => {
      if (result.ok) applySnapshot(result.data)
      else bridgeError.value = result.message
    })
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
   * ★ 「更旧的快照」判据用 `updatedAt`：主进程每份快照都盖时间戳，迟到的旧包一定更小。
   *   （相等时**接受**：同一毫秒内的两次推送，后到的那份内容不会更旧。）
   */
  function applySnapshot(next: DiagnosticsSnapshot): void {
    if (!Array.isArray(next.turns)) return
    if (next.updatedAt > 0 && next.updatedAt < snapshot.value.updatedAt) return
    snapshot.value = { ...next, turns: [...next.turns] }
  }

  /** 一键清空（内存 + 落盘）。演示前清残留、演示后清敏感。 */
  async function clear(): Promise<DiagnosticsCallResult> {
    const lookup = resolveDiagnosticsBridge()
    if (!lookup.ready) {
      lastError.value = lookup.message
      return { ok: false, message: lookup.message }
    }
    const result = await lookup.bridge.clearDiagnostics()
    if (result.ok) {
      applySnapshot(result.data)
      selectedTurn.value = null
      lastError.value = null
    } else {
      lastError.value = result.message
    }
    return result
  }

  /** 重新读一次（导出前 / 演示页手动刷新）。 */
  async function refresh(): Promise<void> {
    const lookup = resolveDiagnosticsBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    const result = await lookup.bridge.readDiagnostics()
    if (result.ok) applySnapshot(result.data)
    else bridgeError.value = result.message
  }

  return {
    snapshot,
    bridgeError,
    lastError,
    selectedTurn,
    turns,
    latest,
    active,
    fromDisk,
    interceptions,
    select,
    noteSandbox,
    connect,
    disconnect,
    applySnapshot,
    clear,
    refresh
  }
})
