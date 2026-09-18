/**
 * 学习档案在渲染进程侧的**桥接**（`window.api` 上那批方法的探测与包装）。
 *
 * 为什么要有这一层（而不是 store 里直接 `window.api.readStudyReport(...)`）：
 *
 * 1. **缺方法时不白屏**：preload 白名单与主进程 handler 是分步落地的，
 *    运行时可能还没有这批方法。按方法名探测 → 缺了就返回一句**可照着做的话**，
 *    而不是抛 `window.api.readStudyReport is not a function` 把整页打空
 *    （与 `api/grade.ts` 的 `resolveGradeBridge` 完全同一口径）；
 * 2. **契约类型只 import 一次**：`components['schemas'][...]` 的生成类型在这里
 *    收口，store 与组件都不直接碰 `@shared/api-types` 的深层路径；
 * 3. **渲染进程不 import 主进程模块**（守卫 G2/G3）：这里用**相对路径 type-only**
 *    import（编译后完全擦除，运行时不加载主进程代码），与 `stores/sidecar.ts`
 *    引 `main/sidecar/protocol` 同一写法。
 */

import type { K12Api } from '../../../preload/index'
import type { FileExportResult, StudyCallResult } from '../../../main/ipc/channels'
import type { GradeLevel } from '@shared/ipc-events'

/** 四个档案端点 + 会话 + 导出在渲染进程侧需要的方法（**从 preload 白名单里挑**）。 */
export interface StudyBridge {
  readStudyReport(payload?: { days?: number }): Promise<StudyCallResult>
  readStudyMistakes(): Promise<StudyCallResult>
  readStudyChapters(payload: { gradeLevel: GradeLevel }): Promise<StudyCallResult>
  readStudyGraph(payload: { gradeLevel: GradeLevel }): Promise<StudyCallResult>
  listSessions(): Promise<StudyCallResult>
  readSessionTranscript(sessionId: string): Promise<StudyCallResult>
  searchSessions(payload: { query: string }): Promise<StudyCallResult>
  exportMarkdown(payload: { fileName: string; content: string }): Promise<FileExportResult>
}

export type StudyBridgeLookup =
  | { ready: true; bridge: StudyBridge }
  | { ready: false; message: string }

/** 缺通道时给学生看的那句话（照它就能把线接上）。 */
export const STUDY_BRIDGE_MISSING_HINT =
  '学习档案还没有接线：preload 白名单缺少 readStudyReport 等 8 个方法 —— ' +
  '需要先在主进程注册 `study:*` / `session:*` / `file:export` 通道' +
  '（由 preload 白名单暴露，渲染进程不直接持有通道名）。接线后刷新页面即可生效。'

/** 这个方法名清单是本层**唯一**的必需能力（少一个就用不了）。 */
const REQUIRED_METHODS = [
  'readStudyReport',
  'readStudyMistakes',
  'readStudyChapters',
  'readStudyGraph',
  'listSessions',
  'readSessionTranscript',
  'searchSessions',
  'exportMarkdown'
] as const

/**
 * 从 `window.api` 上取学习档案能力。
 *
 * ★ 逐方法确认后再显式拼桥：不写 `host as unknown as StudyBridge` ——
 *   那种双重断言会把 `window.api` 的真实签名整条抹掉，
 *   主进程改名或改签名时渲染侧一行都不会报错（`api/grade.ts` 里有同样的教训）。
 */
export function resolveStudyBridge(host: K12Api | undefined = globalThis.window?.api): StudyBridgeLookup {
  if (typeof host === 'undefined') {
    return { ready: false, message: '预加载脚本未生效（window.api 缺失），学习档案暂时读不到。' }
  }
  const missing = REQUIRED_METHODS.filter(
    (name) => typeof (host as unknown as Record<string, unknown>)[name] !== 'function'
  )
  if (missing.length > 0) {
    return {
      ready: false,
      message: `${STUDY_BRIDGE_MISSING_HINT}（缺：${missing.join(', ')}）`
    }
  }
  const api = host as K12Api
  return {
    ready: true,
    bridge: {
      readStudyReport: (payload) => api.readStudyReport(payload),
      readStudyMistakes: () => api.readStudyMistakes(),
      readStudyChapters: (payload) => api.readStudyChapters(payload),
      readStudyGraph: (payload) => api.readStudyGraph(payload),
      listSessions: () => api.listSessions(),
      readSessionTranscript: (sessionId) => api.readSessionTranscript(sessionId),
      searchSessions: (payload) => api.searchSessions(payload),
      exportMarkdown: (payload) => api.exportMarkdown(payload)
    }
  }
}
