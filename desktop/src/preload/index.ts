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
import {
  IPC,
  type ChatSendRequest,
  type ChatSendResult,
  type CodeExecuteRequest,
  type CodeExecuteResult,
  type GradeCallResult,
  type GradeState,
  type IpcChannel,
  type ProbeRequest,
  type ProbeResult,
  type SettingsCallResult,
  type SettingsSnapshot,
  type SettingsUpdateRequest
} from '../main/ipc/channels'
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
  /** 读设置（`GET /api/settings`；Key 只回掩码，明文永不进渲染进程）。 */
  readSettings(): Promise<SettingsCallResult<SettingsSnapshot>>
  /** 保存设置（`PUT /api/settings`；`apiKey` 空串/掩码 = 保留已存值）。 */
  saveSettings(payload: SettingsUpdateRequest): Promise<SettingsCallResult<SettingsSnapshot>>
  /** 真实连通性探测（`POST /api/settings/probe`；失败原因可读，不落库、不改配置）。 */
  probeSettings(payload: ProbeRequest): Promise<SettingsCallResult<ProbeResult>>
  /**
   * 读**当前学段**（只读）。
   * ★ 故意**没有** `setGrade`：学段完全由系统推断，前端连请求改的能力都不该有（D-020）。
   */
  getGrade(): Promise<GradeCallResult<GradeState>>
  /** 订阅学段变化（推进只读徽章），返回取消订阅函数。 */
  onGradeChanged(listener: (state: GradeState) => void): () => void
  /**
   * 订阅「下发学生代码去执行」的请求（渲染进程侧在沙箱 Worker 里跑），返回取消订阅函数。
   * ★ 主进程绝不执行学生代码 —— 它只把代码推下来，结果由 {@link sendCodeResult} 回传。
   */
  onCodeExecute(listener: (request: CodeExecuteRequest) => void): () => void
  /** 回传执行结果（`requestId` 必须**原样带回**，主进程按它配对，否则每次都会超时）。 */
  sendCodeResult(result: CodeExecuteResult): void
}

/**
 * ★ `window.api` 的全局声明**放在这里**（而不是只放 `index.d.ts`）。
 *
 * 为什么不只靠 `src/preload/index.d.ts`：tsconfig 的 `include` 同时匹配 `index.ts` 与
 * `index.d.ts` 时，TypeScript 会**丢掉同名的 .d.ts**（`index.ts` 胜出），于是
 * `tsconfig.node.json`（含 `tests/**`，而 `tests/renderer-quiz.test.ts` 会 import 渲染进程模块）
 * 里 `window.api` 就成了未声明属性 —— 实测报 `TS2339: Property 'api' does not exist`。
 * 两份 `declare global` 类型完全相同（都指向本文件的 `K12Api`），接口合并不会冲突；
 * `tsconfig.web.json` 只收 `src/preload/*.d.ts`，因此两边各自只看到一份声明。
 */
declare global {
  interface Window {
    api: K12Api
  }
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
  },

  // 设置域：纯 invoke 转发（回执是判别联合 `{ok,data} | {ok,message}`，失败不抛异常）。
  // token 与地址全在主进程（`bridge/client.ts`），这里只是把参数照原样递过去。
  readSettings: (): Promise<SettingsCallResult<SettingsSnapshot>> =>
    ipcRenderer.invoke(IPC.settingsRead) as Promise<SettingsCallResult<SettingsSnapshot>>,

  saveSettings: (payload): Promise<SettingsCallResult<SettingsSnapshot>> =>
    ipcRenderer.invoke(IPC.settingsSave, payload) as Promise<SettingsCallResult<SettingsSnapshot>>,

  probeSettings: (payload): Promise<SettingsCallResult<ProbeResult>> =>
    ipcRenderer.invoke(IPC.settingsProbe, payload) as Promise<SettingsCallResult<ProbeResult>>,
  getGrade: (): Promise<GradeCallResult<GradeState>> =>
    ipcRenderer.invoke(IPC.gradeGet) as Promise<GradeCallResult<GradeState>>,
  onCodeExecute: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, request: unknown): void => {
      if (!isCodeExecuteRequest(request)) return
      listener(request)
    }
    ipcRenderer.on(IPC.codeExecute, handler)
    return () => {
      ipcRenderer.removeListener(IPC.codeExecute, handler)
    }
  },
  sendCodeResult: (result): void => {
    ipcRenderer.invoke(IPC.codeResult, result).catch((error: unknown) => {
      console.error('[preload] 回传代码执行结果失败：', error)
    })
  },
  onGradeChanged: (listener): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      // 边界处过滤：只认四个冻结字面量，别把主进程的半截对象丢给界面去渲染
      if (!isGradeState(state)) return
      listener(state)
    }
    ipcRenderer.on(IPC.gradeChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.gradeChanged, handler)
    }
  }
}

/** 学段状态的最小形状检查（`origin` 缺省按 `default` 处理：宁可显示待判定）。 */
function isGradeState(value: unknown): value is GradeState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { gradeLevel?: unknown; origin?: unknown }
  return (
    typeof record.gradeLevel === 'string' &&
    (GRADE_LEVELS as readonly string[]).includes(record.gradeLevel) &&
    (record.origin === 'inferred' || record.origin === 'default')
  )
}

/** 下发执行请求的最小形状检查（缺 `requestId`/`code` 的直接丢掉，别让渲染侧拿到半截对象）。 */
function isCodeExecuteRequest(value: unknown): value is CodeExecuteRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { requestId?: unknown; code?: unknown }
  return typeof record.requestId === 'string' && typeof record.code === 'string'
}

/** 四个学段字面量（与 `shared/ipc-events.ts` 的 `GradeLevel` 同源，此处只做运行期校验）。 */
const GRADE_LEVELS = ['primary_low', 'primary_high', 'junior', 'senior'] as const

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
  IPC.chatEvent,
  IPC.settingsRead,
  IPC.settingsSave,
  IPC.settingsProbe,
  IPC.gradeGet,
  IPC.gradeChanged,
  IPC.codeExecute,
  IPC.codeResult
]

contextBridge.exposeInMainWorld('api', api)
