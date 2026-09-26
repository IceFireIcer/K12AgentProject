/**
 * 渲染进程 → 主进程的**诊断信封桥**（演示模式的取数层）。
 *
 * ★ 独立成文件而不并进 `api/data.ts`：那个模块的 `REQUIRED_METHODS` 是**整块数据面**的
 *   就绪判据（少一个方法 ⇒ 整块判定为「没接完」），而演示模式是**可选的旁路** ——
 *   老产物 / 测试替身没有这三个方法时，演示页应当显示「这条能力没接上」，
 *   而不是把编程页、闯关页、动画页一起判成不可用（那会是一次假红）。
 *
 * ★ 与 `api/study.ts` / `api/data.ts` 同一手法：**能力探测 + 薄包装**，
 *   回执从不抛异常（失败也是一句可读中文）。
 */

import type { DiagnosticsSnapshot } from '@shared/diagnostics'
import type { K12Api } from '../../../preload/index'
import { warnWiring } from './wiring-notice'

/** 诊断桥两条 invoke 的回执（与主进程 `DiagnosticsCallResult` 同形）。 */
export type DiagnosticsCallResult =
  | { ok: true; data: DiagnosticsSnapshot }
  | { ok: false; message: string }

/** 演示模式浮窗 / 演示页顶栏显示的那句话（**学生话**：学生视角看不到这块，但文案仍不许出现运维词）。 */
export const DIAGNOSTICS_BRIDGE_MISSING_HINT = '这块演示信息暂时读不到，需要时请老师帮忙看看。'

export interface DiagnosticsBridge {
  readDiagnostics(): Promise<DiagnosticsCallResult>
  clearDiagnostics(): Promise<DiagnosticsCallResult>
  onDiagnosticsChanged(listener: (snapshot: DiagnosticsSnapshot) => void): () => void
}

export type DiagnosticsBridgeLookup =
  | { ready: true; bridge: DiagnosticsBridge }
  | { ready: false; message: string }

/** 探测的三个方法（少一个就判定「这条旁路没接完」）。 */
export const DIAGNOSTICS_METHODS = [
  'readDiagnostics',
  'clearDiagnostics',
  'onDiagnosticsChanged'
] as const satisfies readonly (keyof DiagnosticsBridge)[]

export function resolveDiagnosticsBridge(
  host: unknown = globalThis.window?.api
): DiagnosticsBridgeLookup {
  if (typeof host !== 'object' || host === null) {
    warnWiring('diagnostics', 'window.api 缺失：preload 没有加载（诊断信封这条旁路不可用）。')
    return { ready: false, message: DIAGNOSTICS_BRIDGE_MISSING_HINT }
  }
  const api = host as Partial<K12Api>
  const missing = DIAGNOSTICS_METHODS.filter((method) => typeof api[method] !== 'function')
  if (missing.length > 0) {
    warnWiring(
      'diagnostics.methods',
      `preload 白名单缺少这 ${missing.length} 个方法：${missing.join(' / ')}。` +
        '需要主进程注册 diagnostics:read / diagnostics:clear（invoke）与 diagnostics:changed（push），' +
        '再由 preload 白名单暴露 readDiagnostics / clearDiagnostics / onDiagnosticsChanged。'
    )
    return { ready: false, message: DIAGNOSTICS_BRIDGE_MISSING_HINT }
  }
  return {
    ready: true,
    bridge: {
      readDiagnostics: () => api.readDiagnostics!(),
      clearDiagnostics: () => api.clearDiagnostics!(),
      onDiagnosticsChanged: (listener) => api.onDiagnosticsChanged!(listener)
    }
  }
}
