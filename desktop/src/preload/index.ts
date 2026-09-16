/**
 * preload 白名单：渲染进程能看到的**全部**主进程能力，就这一个 `window.api`。
 *
 * 纪律：
 *   - 不暴露通用 `ipcRenderer` / `ipcRenderer.invoke` / `ipcRenderer.send`；
 *     每加一个能力都必须在这里显式加一个方法（通道名来自 `src/main/ipc/channels.ts`，唯一来源）。
 *   - 不暴露 sidecar token、不暴露任何 sidecar HTTP 能力。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../main/ipc/channels'
import type { SidecarState } from '../main/sidecar/protocol'

/** ★ 类型名与 `src/preload/index.d.ts` 保持一致（`K12Api`）。 */
export interface K12Api {
  /** 读当前 sidecar 状态（不含 token）。 */
  getSidecarInfo(): Promise<SidecarState>
  /** 订阅 sidecar 状态变化，返回取消订阅函数。 */
  onSidecarChanged(listener: (state: SidecarState) => void): () => void
}

const api: K12Api = {
  getSidecarInfo: () => ipcRenderer.invoke(IPC.sidecarGetInfo) as Promise<SidecarState>,

  onSidecarChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, state: SidecarState): void => {
      listener(state)
    }
    ipcRenderer.on(IPC.sidecarChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.sidecarChanged, handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
