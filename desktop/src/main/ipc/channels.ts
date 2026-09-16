/**
 * ★ IPC 通道名的**唯一来源**：主进程（`ipcMain`）与 preload（`ipcRenderer`）都从这里 import。
 * 不要在 handlers / preload / renderer 里手写通道字符串——那会让白名单与处理器悄悄对不上。
 *
 * 这里同时放**跨边界的请求/回执类型**（`ChatSendRequest` / `ChatSendResult`），
 * 让 preload 只 import 一个模块就能拿到完整的 IPC 边界定义。
 *
 * ⚠️ 6 个**事件**的名字与载荷类型**不在这里**——它们是契约，在 `src/shared/ipc-events.ts`。
 *    一个通道（`chatEvent`）承载全部 6 种事件，靠 `event.name` 区分（见 `shared/ipc-events.ts`）。
 *
 * 架构守卫（`tests/architecture-guards.test.ts`）会扫描 `desktop/src/**`，
 * 断言下面这些字面量只在本文件出现。
 */

import type { GradeLevel } from '@shared/ipc-events'

export const IPC = {
  /** 渲染进程 → 主进程：读当前 sidecar 状态（`ipcMain.handle` / `ipcRenderer.invoke`）。 */
  sidecarGetInfo: 'sidecar:get-info',
  /** 主进程 → 渲染进程：sidecar 状态变化推送（`webContents.send`）。 */
  sidecarChanged: 'sidecar:changed',
  /** 渲染进程 → 主进程：发一轮对话，立刻拿到本轮的 `requestId`。 */
  chatSend: 'chat:send',
  /** 主进程 → 渲染进程：本轮对话的 6 事件流。 */
  chatEvent: 'chat:event'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * 主进程 → 渲染进程的**单向推送**通道。
 * 守卫据此断言事件流走的是推送通道（不是拿 invoke 回执当流用）。
 */
export const PUSH_CHANNELS: readonly IpcChannel[] = [IPC.sidecarChanged, IPC.chatEvent]

/** 一轮对话的入参。 */
export interface ChatSendRequest {
  /** 学生输入（主进程会再次校验非空，不信任渲染进程）。 */
  text: string
  /**
   * 显式选择的学段（执行文档 §10.1：显式选择是权威）。
   * 当前由渲染进程的冷启动默认值带入；选择器与 `before_agent_start` 注入在票 06 落地。
   */
  gradeLevel?: GradeLevel
}

/**
 * 一轮对话的回执。
 *
 * ★ 结构里**没有 token、没有任何 HTTP 细节**：渲染进程只需要「本轮请求号」。
 * ★ 入参不合法时返回 `ok: false`（而不是抛异常穿过 IPC 变成一堆栈文本）。
 */
export type ChatSendResult =
  | { ok: true; requestId: string; message: null }
  | { ok: false; requestId: null; message: string }
