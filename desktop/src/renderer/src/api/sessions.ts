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
  SessionOpenResult,
  SessionStateResult
} from '../../../main/ipc/channels'

/** 会话切换在渲染进程侧需要的方法（**从 preload 白名单里挑**）。 */
export interface SessionBridge {
  /** ★ 读当前会话的完整状态（冷启动恢复那条路：带去恢复出来的正文与开场引导）。 */
  getSessionState(): Promise<SessionStateResult>
  openSession(sessionId: string): Promise<SessionOpenResult>
  startNewSession(): Promise<SessionOpenResult>
  /** ★★ 从某条消息处重新问（分叉出新会话，原会话不动）。 */
  branchSession(request: SessionBranchRequest): Promise<SessionBranchResult>
  onSessionChanged(listener: (state: SessionCurrent) => void): () => void
}

export type SessionBridgeLookup =
  | { ready: true; bridge: SessionBridge }
  | { ready: false; message: string }

/** 缺通道时给学生看的那句话（照它就能把线接上）。 */
export const SESSION_BRIDGE_MISSING_HINT =
  '还不能切换会话：preload 白名单缺少 openSession / startNewSession / branchSession / ' +
  'getSessionState / onSessionChanged —— 需要先在主进程注册 `session:open` / ' +
  '`session:new` / `session:branch` / `session:state` / `session:changed` 五条通道' +
  '（由 preload 白名单暴露，渲染进程不直接持有通道名）。接线后刷新页面即可生效。'

/** 这一层**唯一**的必需能力（少一个就用不了「切会话续聊」）。 */
const REQUIRED_METHODS = [
  'getSessionState',
  'openSession',
  'startNewSession',
  'branchSession',
  'onSessionChanged'
] as const

/**
 * 从 `window.api` 上取会话切换能力。
 *
 * ★ 逐方法确认后再显式拼桥：不写 `host as unknown as SessionBridge` ——
 *   那种双重断言会把 `window.api` 的真实签名整条抹掉，主进程改签名时渲染侧一行都不会报错。
 */
export function resolveSessionBridge(
  host: K12Api | undefined = globalThis.window?.api
): SessionBridgeLookup {
  if (typeof host === 'undefined') {
    return { ready: false, message: '预加载脚本未生效（window.api 缺失），会话切换暂时不可用。' }
  }
  const missing = REQUIRED_METHODS.filter(
    (name) => typeof (host as unknown as Record<string, unknown>)[name] !== 'function'
  )
  if (missing.length > 0) {
    return {
      ready: false,
      message: `${SESSION_BRIDGE_MISSING_HINT}（缺：${missing.join(', ')}）`
    }
  }
  const api = host as K12Api
  return {
    ready: true,
    bridge: {
      getSessionState: () => api.getSessionState(),
      openSession: (sessionId) => api.openSession(sessionId),
      startNewSession: () => api.startNewSession(),
      branchSession: (request) => api.branchSession(request),
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
