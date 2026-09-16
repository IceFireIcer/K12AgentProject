/**
 * 主进程 IPC 处理器注册。
 *
 * 渲染进程只能通过 preload 白名单访问这些通道（见 `src/preload/index.ts`）。
 */

import { ipcMain } from 'electron'
import type { SidecarManager } from '../sidecar/manager'
import type { SidecarState } from '../sidecar/protocol'
import { IPC } from './channels'

/**
 * ★ 返回值里绝不带 token —— `SidecarState` 结构上就没有 token 字段（别在票 02 里加回来）。
 */
export function registerIpcHandlers(sidecar: SidecarManager): void {
  ipcMain.handle(IPC.sidecarGetInfo, (): SidecarState => sidecar.getState())
}
