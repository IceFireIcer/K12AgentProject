/**
 * ★ IPC 通道名的**唯一来源**：主进程（`ipcMain`）与 preload（`ipcRenderer`）都从这里 import。
 * 不要在任一侧手写通道字符串——那会让白名单与处理器悄悄对不上。
 */

export const IPC = {
  /** 渲染进程 → 主进程：读当前 sidecar 状态（invoke / handle）。 */
  sidecarGetInfo: 'sidecar:get-info',
  /** 主进程 → 渲染进程：sidecar 状态变化推送。 */
  sidecarChanged: 'sidecar:changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
