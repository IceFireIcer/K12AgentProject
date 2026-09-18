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
   * 渲染进程 → 主进程：**Pi 内置供应商预设**（离线可用的端点 + 模型清单）。
   *
   * 数据源是 Pi 自己的目录（40 个 provider，含 baseUrl 与模型），所以设置页
   * 不用手输端点地址 —— 选中一个预设就把端点与候选模型带出来。
   * ★ 必须经主进程：只有主进程能加载 Pi（渲染进程没有 Node 能力，守卫 G2 拦着）。
   */
  settingsProviderCatalog: 'settings:provider-catalog',
  /**
   * 渲染进程 → 主进程：**拉取某个地址可见的模型清单**。
   *
   * 主进程做两件事：① 经 sidecar 的 `POST /api/settings/models` 真实外呼拿实时清单；
   * ② 与 Pi 内置预设合并去重。即使 ① 失败（断网 / 该服务没有 `/models`），
   * ② 的预设清单照样返回 —— 界面永远有候选可选。
   */
  settingsFetchModels: 'settings:fetch-models',
  /** 渲染进程 → 主进程：读**当前学段**（指示器展示用）。 */
  gradeGet: 'grade:get',
  /**
   * 渲染进程 → 主进程：**学生手动设定学段**（写入的唯一入口）。
   *
   * ★ 学段的手动写入**只走这条独立通道，绝不混进对话请求** ——
   *   `ChatSendRequest` 依旧只有 `text`（架构守卫 G6c 钉着这一点）。
   *   混进去的话，「这一轮按哪个学段作答」会跟着每一轮对话漂移，而清空输入框、
   *   重发同一句话都会再写一次学段（写入变成了聊天的副作用，不再是显式动作）。
   * ★ 它是 invoke（有回执）：学生要看到「改没改成、冷却还剩几轮」，推送通道给不了这个回执。
   */
  gradeSet: 'grade:set',
  /** 主进程 → 渲染进程：推断出的学段发生变化时推送（指示器据此更新）。 */
  gradeChanged: 'grade:changed',
  /**
   *
   * ★ 与 `grade:set` 完全对称：**不混进 `ChatSendRequest`**（那个请求只有 `text`，
   * ★ 它是 invoke（有回执）：学生要看到「选没选上」，推送通道给不了这个。
   */
  /**
   * 主进程 → 渲染进程：**把学生代码下发到渲染进程执行**（票 18 的硬约束）。
   * ★ 主进程**绝不执行学生代码** —— Pi 的 Extension 与 UI 同进程且拥有完整系统权限，
   *   代码只能在渲染进程的 Pyodide Worker 里跑。这条通道就是那座桥。
   */
  codeExecute: 'code:execute',
  /** 渲染进程 → 主进程：回传执行结果（按 requestId 与下发配对）。 */
  codeResult: 'code:result',

  //
  // ★ 这四条都是**纯转发**：主进程把请求发给 sidecar，把 JSON 原样回给渲染进程。
  //   聚合、排序、学段过滤、连续天数**全部在 Python 侧**（混合后端的硬边界：
  //   数据域只在 Python；TS 不读 SQLite、不自己算这些）。
  // ★ 四条都是 invoke（有回执），**不要**登记进 `PUSH_CHANNELS`。
  // ★ 渲染进程不直连 sidecar（守卫 G3）：token 与地址全留在主进程。
  /** 渲染进程 → 主进程：学习报告（`GET /api/profile/{id}/report?days=N`）。 */
  /** 渲染进程 → 主进程：错题本（`GET /api/quiz/mistakes/{id}`）。 */
  /** 渲染进程 → 主进程：某学段依赖图全览（`GET /api/graph/overview/{grade}`）。 */

  /** 渲染进程 → 主进程：按 id 读一条会话的正文（**绝不接受路径**）。 */

  /**
   *
   * ★ **只回文件名，不回完整路径** —— 宿主目录结构不进渲染进程。
   * ★ 文件名由主进程清理（去掉分隔符与 `..`、限长、强制 `.md`）。
   * ★ 它是 invoke（有回执，学生可能取消保存）；**不**登记进 `PUSH_CHANNELS`。
   */
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * 设置页「预设 / 拉取模型」两个通道的载荷类型。
 *
 * ★ 形状定义在 `src/shared/provider-catalog.ts`（渲染进程也要用，而它不该 import 主进程模块）。
 * 这里只 re-export，让 `channels.ts` 仍然是「IPC 边界类型」的单一入口。
 */
export type { FetchModelsResult, ProviderCatalogEntry } from '@shared/provider-catalog'

/**
 * 主进程 → 渲染进程的**单向推送**通道。
 * 守卫据此断言事件流走的是推送通道（不是拿 invoke 回执当流用）。
 *
 * ⚠️ 设置域三条与 `gradeGet` 是 invoke（有回执），**不要**登记到这里。
 * **不要**登记到这里。
 */
export const PUSH_CHANNELS: readonly IpcChannel[] = [
  IPC.sidecarChanged,
  IPC.chatEvent,
  IPC.gradeChanged,
  IPC.codeExecute
]

/**
 * 学段来源（三态）：
 *   - `inferred` = 系统判定过（推断引擎写过库，或已经攒够信号判出结论）；
 *   - `explicit` = 学生手动选择（显式设定，`grade:set` 那条通道写进去的）；
 *   - `default`  = 冷启动默认值 —— 还没判出来、也没人选过。
 */
export type GradeOrigin = 'inferred' | 'explicit' | 'default'

/**
 * 学段状态（展示用）。
 *
 * ★ 学段的**写入只有一条**：`grade:set` 这条独立通道（学生显式设定）。
 *   **绝不混进 `ChatSendRequest`** —— 那个请求的字段集合被守卫 G6c 钉死为 `['text']`，
 *   一旦塞进 `gradeLevel`，「每轮对话」就成了「每轮改学段」的副作用。
 * ★ 宁可显示「待判定」也不要拿冷启动默认值冒充系统判定结果 —— 那是在骗演示。
 * ★ `source` 是后端 `GradeStateOut.source`（那次写入的**来源**，例如 `inferred` / `explicit`）的透传，
 *   它同时决定 `origin`（见 `ipc/handlers.ts` 的 `readGradeState`）：来源以**服务端为准**，
 *   前端不能自己猜 —— 猜出来的后果是「学生手动选的」被显示成「AI 推的」。
 * ★ 它替代了历史上那个恒为 null 的 `reason` —— 后端回执里根本没有
 *   `reason` 字段（`reason` 只出现在 `/api/grade/turns` 的响应里），旧字段是死字段。
 *   渲染进程那边有自己的 `GradeState` 副本（`renderer/src/api/grade.ts`），
 *   它按「未知字段忽略」处理，因此这里改名不会影响界面。
 */
export interface GradeState {
  gradeLevel: GradeLevel
  origin: GradeOrigin
  /** 后端 `GradeStateOut.source`（写入来源，如 `inferred` / `explicit`）；取不到时为 `null`。 */
  source?: string | null
}

/** 学段读取的回执（与 `SettingsCallResult` 同形，便于前端统一处理）。 */
export type GradeCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string }

/** 手动设定学段的回执（`cooldownRemainingTurns` = 手动冷却还剩几轮）。 */
export interface GradeSetResult {
  changed: boolean
  cooldownRemainingTurns: number
}

/**
 *
 *   所以渲染进程在学段变化后要重新读一次（不要自己猜成空串）。
 */
  gradeLevel: GradeLevel
}

  | { ok: true; data: T }
  | { ok: false; message: string }

}

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

/** 下发到渲染进程执行的学生代码（票 18）。 */
export interface CodeExecuteRequest {
  /** 与执行结果配对（桥生成，渲染进程必须原样带回）。 */
  requestId: string
  code: string
  /** 执行超时；超时必须**中断**（Pyodide setInterruptBuffer），不是干等。 */
  timeoutMs?: number
  /** 发起这次执行的 Tool 调用号（轨迹与求助计数用）。 */
  toolCallId?: string
}

/** 渲染进程回传的执行结果。 */
export interface CodeExecuteResult {
  requestId: string
  stdout: string
  stderr: string
  /** 是否被超时中断（`while True: pass` 必须走这条，而不是把界面卡死）。 */
  interrupted: boolean
  elapsedMs: number
  /** 执行器自身的失败说明（如 Worker 没起来）；学生代码的报错走 stderr。 */
  failure?: string
}

/* ------------------------------------------------------------------ *
 * ------------------------------------------------------------------ */

/**
 *
 * ⚠️ `data` 是 `unknown` 而**不是**具体契约类型，这是刻意的：
 *    这些端点的字段全部由 pydantic 生成类型定义（`@shared/api-types`），
 *    主进程只是**搬运工**。在这里再写一遍 TS 接口等于把契约抄第二份 ——
 *    渲染进程按生成类型消费（它有 `npm run typecheck` 兜着），
 *    主进程这边多写一份只会漂移。
 */
  | { ok: true; data: unknown }
  | { ok: false; message: string }

  gradeLevel: GradeLevel
  /** 可选：带上就把「已掌握」标注进来（读该学生自己的 `learning.db`）。 */
  studentId?: string
}

/** 学习报告的入参。 */
  /** 时间窗天数；省略即 7 天（服务端有默认，这里显式给一个便于界面回显）。 */
  days?: number
}

  query: string
}

/**
 *
 * ★ `content` 是**已经拼好的 Markdown 文本**：拼装发生在渲染进程
 *   （它手里有报告/错题本的数据），主进程只负责「问路径 + 写盘」。
 */
  /** 建议的文件名（主进程会清理：去分隔符与 `..`、限长、强制 `.md`）。 */
  fileName: string
  content: string
}

  | { ok: true; fileName: string }
  | { ok: false; message: string; canceled?: boolean }

/**
 *
 * 1 MiB 对一个学生的单次会话足够宽松（实测一个 4 轮的会话约 4 KB）。
 */
export const MAX_EXPORT_BYTES = 1_048_576

