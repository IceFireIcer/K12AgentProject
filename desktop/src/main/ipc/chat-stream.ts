/**
 * 一轮对话的**流式句柄**与**生命周期登记**。
 *
 * 纯逻辑：不 import electron、不碰 IO —— 目标窗口以 `StreamTarget` 接口注入，
 * 因此可被 `node --test` 直接单测（见 `tests/ipc-events.test.ts`）；
 * electron 适配器在 `handlers.ts`（`webContents` → `StreamTarget`）。
 *
 * 职责三条：
 *   1. **请求号由主进程生成并贯穿一轮**：`emit()` 统一注入 `requestId`，
 *      调用方（票 06 的 Pi 桥）没有「发错请求号」的机会；`done` 另带 `messageId`。
 *   2. **窗口销毁即停**：窗口销毁后不再 `send`（对已销毁的 `webContents` 调用会抛异常），
 *      并顺手注销 `destroyed` 监听 —— 监听器**按窗口登记、随最后一个轮次结束注销**，
 *      不按轮次堆积（`trackedTargets` 在无活跃轮次时必须回到 0）。
 *   3. **可观测**：`activeTurns` / `trackedTargets` / `droppedEvents` 供测试与诊断断言。
 */

import { randomUUID } from 'node:crypto'
import type {
  BlockedEvent,
  CitationEvent,
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  IpcEvent,
  PayloadEvent
} from '@shared/ipc-events'

/**
 * 一轮里主进程能发的事件：载荷与 `shared/ipc-events.ts` 的契约**逐字段一致**，
 * 只是不带 `requestId`（由句柄注入）。这样调用方不可能把事件发到别的轮次上。
 */
export type TurnEvent =
  | { name: 'delta'; data: Omit<DeltaEvent, 'requestId'> }
  | { name: 'citation'; data: Omit<CitationEvent, 'requestId'> }
  | { name: 'payload'; data: Omit<PayloadEvent, 'requestId'> }
  | { name: 'blocked'; data: Omit<BlockedEvent, 'requestId'> }
  | { name: 'done'; data: Omit<DoneEvent, 'requestId'> }
  | { name: 'error'; data: Omit<ErrorEvent, 'requestId'> }

/** 目标窗口（electron 侧由 `webContents` 适配而来）。 */
export interface StreamTarget {
  readonly id: number
  isDestroyed(): boolean
  send(event: IpcEvent): void
  onDestroyed(listener: () => void): void
  offDestroyed(listener: () => void): void
}

/** 一轮对话的句柄：只暴露「发事件」与「结束本轮」。 */
export interface TurnHandle {
  readonly requestId: string
  readonly userText: string
  /** 本轮是否还活着（已结束 / 窗口已销毁 → false）。 */
  readonly active: boolean
  /** 发一个事件；本轮已结束或窗口已销毁时丢弃并返回 false（绝不抛异常）。 */
  emit(event: TurnEvent): boolean
  /** 结束本轮（清理登记；窗口若无活跃轮次，`destroyed` 监听一并注销）。 */
  finish(): void
}

export interface ChatStreamRegistryOptions {
  /** 请求号生成器（测试注入计数器以得到确定性 id）。 */
  generateRequestId?: () => string
}

/** 请求号前缀：日志与工具调用轨迹里一眼能认出「这是一轮对话的 id」。 */
export const REQUEST_ID_PREFIX = 'turn_'

interface TargetEntry {
  readonly target: StreamTarget
  readonly onDestroyed: () => void
  readonly requestIds: Set<string>
}

interface TurnState {
  readonly requestId: string
  readonly userText: string
  readonly entry: TargetEntry
  active: boolean
}

export class ChatStreamRegistry {
  private readonly targets = new Map<number, TargetEntry>()
  private readonly turns = new Map<string, TurnState>()
  private readonly generateRequestId: () => string
  private dropped = 0

  constructor(options: ChatStreamRegistryOptions = {}) {
    this.generateRequestId = options.generateRequestId ?? (() => `${REQUEST_ID_PREFIX}${randomUUID()}`)
  }

  /** 开一轮：登记目标窗口（该窗口首次出现时挂 `destroyed` 监听），生成请求号。 */
  open(target: StreamTarget, userText: string): TurnHandle {
    const entry = this.ensureTarget(target)
    const requestId = this.generateRequestId()
    const state: TurnState = { requestId, userText, entry, active: true }
    this.turns.set(requestId, state)
    entry.requestIds.add(requestId)

    const registry = this
    return {
      requestId,
      userText,
      get active(): boolean {
        return state.active && !state.entry.target.isDestroyed()
      },
      emit(event: TurnEvent): boolean {
        return registry.emit(requestId, event)
      },
      finish(): void {
        registry.finish(requestId)
      }
    }
  }

  /** 发一个事件（自动补上本轮的 `requestId`）。返回是否真的发出去了。 */
  emit(requestId: string, event: TurnEvent): boolean {
    const state = this.turns.get(requestId)
    if (!state || !state.active) {
      this.dropped += 1
      return false
    }
    if (state.entry.target.isDestroyed()) {
      // 窗口已经没了：注销监听 + 结束该窗口的全部轮次，然后丢弃本次事件
      this.closeTarget(state.entry.target.id)
      this.dropped += 1
      return false
    }
    state.entry.target.send(withRequestId(event, requestId))
    return true
  }

  /** 本轮结束：清掉登记。 */
  finish(requestId: string): void {
    const state = this.turns.get(requestId)
    if (!state) return
    state.active = false
    this.turns.delete(requestId)
    state.entry.requestIds.delete(requestId)
    if (state.entry.requestIds.size === 0) this.releaseTarget(state.entry)
  }

  /** 窗口销毁（或被发现有已销毁窗口）时结束它的全部轮次。 */
  closeTarget(targetId: number): void {
    const entry = this.targets.get(targetId)
    if (!entry) return
    for (const requestId of [...entry.requestIds]) {
      const state = this.turns.get(requestId)
      if (state) state.active = false
      this.turns.delete(requestId)
    }
    entry.requestIds.clear()
    this.releaseTarget(entry)
  }

  /** 进行中的轮次数。 */
  get activeTurns(): number {
    return this.turns.size
  }

  /** 仍挂着 `destroyed` 监听的窗口数（无活跃轮次时应为 0）。 */
  get trackedTargets(): number {
    return this.targets.size
  }

  /** 因窗口销毁 / 轮次已结束而丢弃的事件数（背压与清理的可观测证据）。 */
  get droppedEvents(): number {
    return this.dropped
  }

  private ensureTarget(target: StreamTarget): TargetEntry {
    const existing = this.targets.get(target.id)
    if (existing) return existing
    const entry: TargetEntry = {
      target,
      requestIds: new Set<string>(),
      onDestroyed: () => {
        this.closeTarget(target.id)
      }
    }
    target.onDestroyed(entry.onDestroyed)
    this.targets.set(target.id, entry)
    return entry
  }

  private releaseTarget(entry: TargetEntry): void {
    entry.target.offDestroyed(entry.onDestroyed)
    // 只删自己那条登记：同一 id 的窗口可能已经被重新登记过了
    if (this.targets.get(entry.target.id) === entry) this.targets.delete(entry.target.id)
  }
}

/** 把「不带 requestId 的事件」与本轮请求号合成契约事件（逐字段显式写，避免多余字段漏出去）。 */
export function withRequestId(event: TurnEvent, requestId: string): IpcEvent {
  switch (event.name) {
    case 'delta':
      return { name: 'delta', data: { requestId, delta: event.data.delta } }
    case 'citation': {
      // ★ `details` / `degraded` 必须跟着走：右栏「四级降级链」与回答里的「教材原文」抽屉
      //   **只认这两个字段**（渲染侧归约见 `renderer/src/api/events.ts`）。上一版在这里只搬了
      //   `citations`，那两个消费方于是恒显示「本轮没有查教材」—— 降级链是关卡 C 的核心演示证据，
      //   实际却是死的。上游（`agent/events.ts`）已经按「有内容才挂」产出它们，这里照同样的约定透传。
      // ★ 省略（而不是发 `details: []` / `degraded: null`）= 「没有这项信息」，与「空数组」不是一回事：
      //   多发一个空值会让「本轮没检索」与「检索了但没降级信息」在链路上变得无法区分。
      const { citations, details, degraded } = event.data
      const data: CitationEvent = { requestId, citations }
      if (details !== undefined && details.length > 0) data.details = details
      if (degraded !== undefined && degraded !== null) data.degraded = degraded
      return { name: 'citation', data }
    }
    case 'payload':
      return { name: 'payload', data: { requestId, kind: event.data.kind, payload: event.data.payload } }
    case 'blocked':
      return { name: 'blocked', data: { requestId, reason: event.data.reason, safeText: event.data.safeText } }
    case 'done':
      return { name: 'done', data: { requestId, messageId: event.data.messageId } }
    case 'error':
      return { name: 'error', data: { requestId, message: event.data.message, degraded: event.data.degraded } }
  }
}
