/**
 * ★ IPC 通道名的**唯一来源**：主进程（`ipcMain`）与 preload（`ipcRenderer`）都从这里 import。
 * 不要在 handlers / preload / renderer 里手写通道字符串——那会让白名单与处理器悄悄对不上。
 *
 * 这里同时放**跨边界的请求/回执类型**（`ChatSendRequest` / `ChatSendResult` /
 * `SettingsCallResult`），让 preload 只 import 一个模块就能拿到完整的 IPC 边界定义。
 *
 * ⚠️ 6 个**事件**的名字与载荷类型**不在这里**——它们是契约，在 `src/shared/ipc-events.ts`。
 *    一个通道（`chatEvent`）承载全部 6 种事件，靠 `event.name` 区分（见 `shared/ipc-events.ts`）。
 *
 * 架构守卫（`tests/architecture-guards.test.ts`）会扫描 `desktop/src/**`，
 * 断言下面这些字面量只在本文件出现。
 */

import type { components } from '@shared/api-types'
import type { GradeLevel } from '@shared/ipc-events'

/**
 * 设置域的三个契约类型：**全部来自 `@shared/api-types`（pydantic → OpenAPI → TS 生成物）**，
 * 这里一个字段都不手写 —— 改了 `server/app/contracts.py` 会在 `npm run typecheck` 当场报出来。
 */
export type SettingsSnapshot = components['schemas']['SettingsResponse']
export type SettingsUpdateRequest = components['schemas']['SettingsUpdateRequest']
export type ProbeRequest = components['schemas']['ProbeRequest']
export type ProbeResult = components['schemas']['ProbeResult']

/**
 * 设置域三条 invoke 通道的回执形态（渲染进程侧的镜像定义在 `renderer/src/api/settings.ts`）。
 *
 * ★ 判别联合，**失败也带一句可读中文**：处理器绝不抛异常穿过 IPC（那会变成界面上的堆栈文本），
 *   与 `ChatSendResult` 同一条纪律（见 `src/main/ipc/chat-request.ts` 的注释）。
 */
export type SettingsCallResult<T> = { ok: true; data: T } | { ok: false; message: string }

export const IPC = {
  /** 渲染进程 → 主进程：读当前 sidecar 状态（`ipcMain.handle` / `ipcRenderer.invoke`）。 */
  sidecarGetInfo: 'sidecar:get-info',
  /** 主进程 → 渲染进程：sidecar 状态变化推送（`webContents.send`）。 */
  sidecarChanged: 'sidecar:changed',
  /** 渲染进程 → 主进程：发一轮对话，立刻拿到本轮的 `requestId`。 */
  chatSend: 'chat:send',
  /** 主进程 → 渲染进程：本轮对话的 6 事件流。 */
  chatEvent: 'chat:event',
  /** 渲染进程 → 主进程：读设置（`GET /api/settings`，Key 只回掩码）。 */
  settingsRead: 'settings:read',
  /** 渲染进程 → 主进程：保存设置（`PUT /api/settings`，原子写 config.json）。 */
  settingsSave: 'settings:save',
  /** 渲染进程 → 主进程：真实连通性探测（`POST /api/settings/probe`，不落库、不改配置）。 */
  settingsProbe: 'settings:probe',
  /**
   * 渲染进程 → 主进程：读**当前学段**（只读展示用；前端没有选择器）。
   * ★ 学段完全由系统推断（`agent/extensions/grade.ts`），**没有写入通道** ——
   *   这条通道只有读，学生改不了学段（D-020）。
   */
  gradeGet: 'grade:get',
  /** 主进程 → 渲染进程：推断出的学段发生变化时推送（只读徽章据此更新）。 */
  gradeChanged: 'grade:changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * 主进程 → 渲染进程的**单向推送**通道。
 * 守卫据此断言事件流走的是推送通道（不是拿 invoke 回执当流用）。
 *
 * ⚠️ 设置域三条与 `gradeGet` 是 invoke（有回执），**不要**登记到这里。
 */
export const PUSH_CHANNELS: readonly IpcChannel[] = [
  IPC.sidecarChanged,
  IPC.chatEvent,
  IPC.gradeChanged
]

/** 学段来源：`inferred` = 系统判定过；`default` = 冷启动默认值（还没判出来）。 */
export type GradeOrigin = 'inferred' | 'default'

/**
 * 学段状态（只读展示）。
 *
 * ★ **没有 `setGrade`/`gradeSet` 之类的写入口**，这是刻意的：学段由推断引擎独占，
 *   前端连"请求改学段"的能力都不该有（D-020）。
 * ★ 宁可显示「待判定」也不要拿冷启动默认值冒充系统判定结果 —— 那是在骗演示。
 */
export interface GradeState {
  gradeLevel: GradeLevel
  origin: GradeOrigin
  /** 可读的可选说明（例如推断依据），不保证有。 */
  reason?: string | null
}

/** 学段读取的回执（与 `SettingsCallResult` 同形，便于前端统一处理）。 */
export type GradeCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string }

/** 一轮对话的入参。 */
export interface ChatSendRequest {
  /** 学生输入（主进程会再次校验非空，不信任渲染进程）。 */
  text: string
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
