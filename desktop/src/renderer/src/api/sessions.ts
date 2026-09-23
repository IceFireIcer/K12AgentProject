/**
 * 会话切换在渲染进程侧的**桥接**（`window.api` 上那批方法的探测与包装）。
 *
 * 与 `api/study.ts` / `api/grade.ts` 完全同一口径，三条理由也一样：
 *
 * 1. **缺方法时不白屏**：preload 白名单是分步落地的，运行时可能还没有这三条新通道。
 *    按方法名探测 → 缺了就返回一句**可照着做的话**，而不是抛
 *    `window.api.openSession is not a function` 把整个对话页打空；
 * 2. **契约类型只 import 一次**：`SessionCurrent` / `SessionOpenResult` 在这里收口，
 *    store 与组件都不直接碰 `main/ipc/channels` 的深层路径；
 * 3. **渲染进程不 import 主进程模块**（守卫 G2/G3）：用**相对路径 type-only** import
 *    （编译后完全擦除，运行时不加载主进程代码）。
 *
 * ★★ 这一层**不做任何判定**：哪个会话是高亮的、要不要发开场引导、
 *    恢复出来的消息怎么排序 —— 全部由主进程给出（它才知道 JSONL 里有什么）。
 *    渲染进程「自己算一个」的后果是两侧对不上，而那种不一致不会报错。
 */

import type { K12Api } from '../../../preload/index'
import type {
  SessionBranchRequest,
  SessionBranchResult,
  SessionCurrent,
  SessionDeleteResult,
  SessionOpenResult,
  SessionStateResult
} from '../../../main/ipc/channels'
import { warnWiring } from './wiring-notice'

/** 会话切换在渲染进程侧需要的方法（**从 preload 白名单里挑**）。 */
export interface SessionBridge {
  /** ★ 读当前会话的完整状态（冷启动恢复那条路：带去恢复出来的正文与开场引导）。 */
  getSessionState(): Promise<SessionStateResult>
  openSession(sessionId: string): Promise<SessionOpenResult>
  startNewSession(): Promise<SessionOpenResult>
  /** ★★ 从某条消息处重新问（分叉出新会话，原会话不动）。 */
  branchSession(request: SessionBranchRequest): Promise<SessionBranchResult>
  /** ★★ 删掉一条历史会话（**不可撤销**）。删的是当前会话时，主进程会先切到一条新会话再删文件。 */
  deleteSession(sessionId: string): Promise<SessionDeleteResult>
  onSessionChanged(listener: (state: SessionCurrent) => void): () => void
}

export type SessionBridgeLookup =
  | { ready: true; bridge: SessionBridge }
  | { ready: false; message: string }

/**
 * 整块会话切换能力不可用时**给学生看的那句话**（侧栏历史对话那一行的提示）。
 *
 * ★★ 2026-09-22 改口（设计评审报告 0.2 + 双视角 D-063）：原来这句把
 *   `openSession` / `startNewSession` / … 六个方法名与 `session:open` / `session:state`
 *   六条通道名一起印在侧栏上（学生看得到），末尾还写「接线后刷新页面即可生效」。
 *   现在只说三件事：历史对话打不开、**当前这段还能接着聊**、需要时找老师。
 *   ⚠️ 缺哪几个方法不在这里 —— 它经 {@link resolveSessionBridge} 的 `warnWiring` 进控制台。
 */
export const SESSION_BRIDGE_MISSING_HINT = '历史对话暂时打不开，当前这段还能接着聊。需要时请老师帮忙看看。'

/** 这一层**唯一**的必需能力（少一个就用不了「切会话续聊 / 删会话」）。 */
const REQUIRED_METHODS = [
  'getSessionState',
  'openSession',
  'startNewSession',
  'branchSession',
  'deleteSession',
  'onSessionChanged'
] as const

/**
 * 从 `window.api` 上取会话切换能力。
 *
 * ★★ 缺方法时：**屏幕上是学生话**（{@link SESSION_BRIDGE_MISSING_HINT}），
 *   **缺哪几个方法进控制台**（`warnWiring`，一次把清单列全）——
 *   两条通路的分工见 `api/wiring-notice.ts` 的文件头。
 *
 * ★ 逐方法确认后再显式拼桥：不写 `host as unknown as SessionBridge` ——
 *   那种双重断言会把 `window.api` 的真实签名整条抹掉，主进程改签名时渲染侧一行都不会报错。
 */
export function resolveSessionBridge(
  host: K12Api | undefined = globalThis.window?.api
): SessionBridgeLookup {
  if (typeof host === 'undefined') {
    warnWiring(
      'session',
      'window.api 缺失：preload 没有加载（整块会话切换能力不可用）。检查 preload 入口与 contextIsolation / sandbox 配置。'
    )
    return { ready: false, message: SESSION_BRIDGE_MISSING_HINT }
  }
  const missing = REQUIRED_METHODS.filter(
    (name) => typeof (host as unknown as Record<string, unknown>)[name] !== 'function'
  )
  if (missing.length > 0) {
    warnWiring(
      'session.methods',
      `preload 白名单缺少这 ${missing.length} 个方法：${missing.join(' / ')}。` +
        '需要先在主进程注册 session:open / session:new / session:branch / session:delete / ' +
        'session:state / session:changed 六条通道（前五条 invoke 带回执、最后一条是推送，' +
        '已登记进 PUSH_CHANNELS），再由 preload 白名单逐方法暴露。接线后重启渲染进程即可生效。'
    )
    return { ready: false, message: SESSION_BRIDGE_MISSING_HINT }
  }
  const api = host as K12Api
  return {
    ready: true,
    bridge: {
      getSessionState: () => api.getSessionState(),
      openSession: (sessionId) => api.openSession(sessionId),
      startNewSession: () => api.startNewSession(),
      branchSession: (request) => api.branchSession(request),
      deleteSession: (sessionId) => api.deleteSession(sessionId),
      onSessionChanged: (listener) => api.onSessionChanged(listener)
    }
  }
}

/** 会话状态的最小形状检查（与 preload 的 `isSessionCurrent` 同一判据）。 */
export function readSessionCurrent(value: unknown): SessionCurrent | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { sessionId?: unknown; title?: unknown; messageCount?: unknown }
  if (
    typeof record.sessionId !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.messageCount !== 'number'
  ) {
    return null
  }
  return {
    sessionId: record.sessionId,
    title: record.title,
    messageCount: record.messageCount
  }
}
