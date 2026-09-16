/**
 * preload 白名单：渲染进程能看到的**全部**主进程能力，就这一个 `window.api`。
 *
 * 纪律：
 *   - 不暴露通用 `ipcRenderer` / `ipcRenderer.invoke` / `ipcRenderer.send` / `ipcRenderer.on`；
 *     每加一个能力都必须在这里显式加一个方法（通道名来自 `src/main/ipc/channels.ts`，唯一来源）。
 *   - 不暴露 sidecar token、不暴露任何 sidecar HTTP 能力（token 只在主进程内存里）。
 *   - 回调**只交载荷**：`IpcRendererEvent`（带 `sender` 等内部对象）绝不漏给渲染进程。
 *   - 6 事件流只转发**冻结词表内**的事件名，脏数据在边界上就被丢掉。
 *
 * ★ 类型名与 `src/preload/index.d.ts` 保持一致（`K12Api`）。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type ChatSendRequest, type ChatSendResult, type IpcChannel } from '../main/ipc/channels'
import type { SidecarState } from '../main/sidecar/protocol'
import { IPC_EVENT_NAMES, type IpcEvent } from '../shared/ipc-events'

export interface K12Api {
  /** 读当前 sidecar 状态（不含 token）。 */
  getSidecarInfo(): Promise<SidecarState>
  /** 订阅 sidecar 状态变化，返回取消订阅函数。 */
  onSidecarChanged(listener: (state: SidecarState) => void): () => void
  /** 发一轮对话：立刻拿到本轮 `requestId`，事件随后经 `onChatEvent` 推来。 */
  sendChat(request: ChatSendRequest): Promise<ChatSendResult>
  /** 订阅 6 事件流（`delta|citation|payload|blocked|done|error`），返回取消订阅函数。 */
  onChatEvent(listener: (event: IpcEvent) => void): () => void
}

const api: K12Api = {
  getSidecarInfo: (): Promise<SidecarState> =>
    ipcRenderer.invoke(IPC.sidecarGetInfo) as Promise<SidecarState>,

  onSidecarChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, state: SidecarState): void => {
      listener(state)
    }
    ipcRenderer.on(IPC.sidecarChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.sidecarChanged, handler)
    }
  },

  sendChat: (request): Promise<ChatSendResult> =>
    ipcRenderer.invoke(IPC.chatSend, request) as Promise<ChatSendResult>,

  onChatEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 白名单校验：只转发冻结词表内的事件（未知/畸形载荷在这里就丢掉，渲染进程看不到脏数据）
      if (!isIpcEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(IPC.chatEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, handler)
    }
  }
}

/** 事件名是否在冻结的 6 个之内（`IPC_EVENT_NAMES` 是 `shared/ipc-events.ts` 的运行时副本）。 */
function isIpcEvent(payload: unknown): payload is IpcEvent {
  if (typeof payload !== 'object' || payload === null) return false
  const name = (payload as { name?: unknown }).name
  return typeof name === 'string' && (IPC_EVENT_NAMES as readonly string[]).includes(name)
}

/** 仅用于类型引用的自检：这些通道名必须来自唯一来源（守卫会另外扫字面量）。 */
export const WHITELISTED_CHANNELS: readonly IpcChannel[] = [
  IPC.sidecarGetInfo,
  IPC.sidecarChanged,
  IPC.chatSend,
  IPC.chatEvent
]

contextBridge.exposeInMainWorld('api', api)
