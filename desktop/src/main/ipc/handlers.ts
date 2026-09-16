/**
 * 主进程 IPC 处理器注册。
 *
 * 渲染进程只能通过 preload 白名单访问这些通道（见 `src/preload/index.ts`）。
 *
 * 本文件是**唯一**把 `ipcMain` / `webContents` 与纯逻辑接起来的地方：
 *   - 通道名 → `./channels`（唯一来源）
 *   - 轮次生命周期（请求号、窗口销毁清理）→ `./chat-stream`
 *   - 入参校验 → `./chat-request`
 *   - 事件内容 → `./stub-chat`（★ 假数据源，票 06 替换）
 */

import { ipcMain, type WebContents } from 'electron'
import type { SidecarManager } from '../sidecar/manager.ts'
import type { SidecarState } from '../sidecar/protocol.ts'
import { IPC, type ChatSendResult } from './channels.ts'
import { parseChatSendRequest } from './chat-request.ts'
import { ChatStreamRegistry, type StreamTarget } from './chat-stream.ts'
import { runStubTurn } from './stub-chat.ts'

/**
 * ★★ 票 06 接线点：把 `runStubTurn(...)` 换成「Pi 的 `message_update` / `tool_execution_end`
 *    → 同一批 `TurnEvent`」。**本文件其余部分、preload、渲染进程都不需要改** ——
 *    通道与载荷已冻结，换数据源不动 UI。
 */
const chatStreams = new ChatStreamRegistry()

/**
 * ★ 返回值里绝不带 token —— `SidecarState` 结构上就没有 token 字段（别在票 02 里加回来）。
 */
export function registerIpcHandlers(sidecar: SidecarManager): void {
  ipcMain.handle(IPC.sidecarGetInfo, (): SidecarState => sidecar.getState())

  ipcMain.handle(IPC.chatSend, (event, payload: unknown): ChatSendResult => {
    const parsed = parseChatSendRequest(payload)
    if (!parsed.ok) return { ok: false, requestId: null, message: parsed.message }

    // 请求号由主进程生成，并贯穿本轮全部事件（`done` 另带 `messageId`）
    const handle = chatStreams.open(toStreamTarget(event.sender), parsed.request.text)
    // ★ 假数据源：确定性 6 事件序列。真实数据源在票 06 接上（见上方接线点注释）。
    runStubTurn(handle, parsed.request.text)
    return { ok: true, requestId: handle.requestId, message: null }
  })
}

/**
 * `webContents` → `StreamTarget` 适配器。
 * 只在这里碰 electron：销毁后不再 `send`（对已销毁 webContents 调用会抛异常），
 * `destroyed` 监听的注销由 registry 负责（无活跃轮次即注销）。
 */
function toStreamTarget(webContents: WebContents): StreamTarget {
  return {
    id: webContents.id,
    isDestroyed: () => webContents.isDestroyed(),
    send: (event) => {
      if (webContents.isDestroyed()) return
      webContents.send(IPC.chatEvent, event)
    },
    onDestroyed: (listener) => {
      webContents.on('destroyed', listener)
    },
    offDestroyed: (listener) => {
      webContents.removeListener('destroyed', listener)
    }
  }
}
