/**
 * 「当前教材章节」的**读取 + 学生显式设定**入口（渲染进程侧）。
 *
 * 章节是一份**软偏好**，不是检索契约的一部分：
 *   - 学生选一章 → 该章标题进入每轮 System Prompt 的画像块（「回答与检索优先围绕本章」）；
 *   - 它**不做 SQL 硬过滤**：学生问到别的章节照常回答，不给检索加 WHERE。
 *
 * 与学段的关系（两条独立的线，但**学段一变就清空章节**）：
 *   - 学段决定「按什么水平讲」，章节决定「围绕哪一章讲」；
 *   - 学段换了，那本教材就不存在了 —— 清空规则在**服务端**（`rules` 里那两个落点），
 *     渲染进程只在学段变化时**真去读一次**，不自己猜、不自己清（见 `stores/chat.ts`）。
 *
 * ★ 手动章节**绝不混进对话请求**：`ChatSendRequest` 的字段集合被架构守卫 G6c 钉死为 `['text']`。
 *   混进去的话「发一条消息」会顺带写一次章节 —— 写入从「学生的显式动作」退化成「聊天的副作用」。
 *
 * ---------------------------------------------------------------------------
 * ★ 需要主进程提供的能力（分步接线；缺哪条本模块给可读说明，不抛异常、不白屏）
 * ---------------------------------------------------------------------------
 *
 * 通道名（唯一来源 `src/main/ipc/channels.ts`，本文件不写死通道字符串）：
 *
 *   `IPC.chapterChanged`（主进程 → 渲染进程，**推送**）
 *       webContents.send(IPC.chapterChanged, state: ChapterState)
 *       学生设定成功后推一条（值没变不推）。已登记进 `PUSH_CHANNELS`。
 *
 *   `IPC.chapterGet`（渲染进程 → 主进程，invoke，**可选**）
 *       ipcMain.handle(IPC.chapterGet, () => ChapterCallResult<ChapterState>)
 *       挂载时拉一次当前值；学段变化后也靠它重取（服务端那时会把章节清空）。
 *
 *   `IPC.chapterSet`（渲染进程 → 主进程，invoke，**可选**）
 *       ipcMain.handle(IPC.chapterSet, ({ chapterTitle }) => ChapterCallResult<ChapterSetResult>)
 *       学生显式选章（唯一的人工写入口）。必须**有回执**：学生要看到「改没改成」。
 *
 * preload 白名单（`K12Api`）三个方法：
 *
 *     getChapter(): Promise<ChapterCallResult<ChapterState>>                              // 可选
 *     setChapter(chapterTitle: string): Promise<ChapterCallResult<ChapterSetResult>>       // 可选
 *     onChapterChanged(listener: (state: ChapterState) => void): () => void                // 必需
 *
 * `ChapterState.chapterTitle` 的语义：**空串 = 未选择章节**（不是 null，界面不用处理两种空值）。
 */

import type { K12Api } from '../../../preload/index'
import type {
  ChapterCallResult,
  ChapterSetResult,
  ChapterState
} from '../../../main/ipc/channels'
import { readGradeLevel } from './grade'

/**
 * ★ 这三个类型**不在渲染进程重写一遍**：唯一来源是 `src/main/ipc/channels.ts`
 *   （preload 也 import 那里）。形状在这里各写一份的话，主进程改了字段渲染侧不会报错 ——
 *   正是契约漂移的起点。跨目录用**相对路径** type-only 导入（与 `api/grade.ts` 同一写法）：
 *   纯类型导入编译后被完全擦除，渲染进程运行时不加载任何主进程模块。
 */
export type { ChapterCallResult, ChapterSetResult, ChapterState }

/**
 * 主进程需要暴露的章节能力。
 *
 * `onChapterChanged` **必需**（没有它界面永远是「未选择章节」）；
 * `getChapter` / `setChapter` **可选** —— 白名单是分步接线的：主进程若在订阅后主动推一次
 * 当前值，就不需要 `getChapter`；写入那条线还没接时，界面照常显示，只是「选章节」不可用。
 */
export interface ChapterBridge {
  getChapter?(): Promise<ChapterCallResult<ChapterState>>
  /** ★ 学生显式设定章节（空串 = 回到「不限章节，自由问答」）。缺失 = 主进程还没接线。 */
  setChapter?(chapterTitle: string): Promise<ChapterCallResult<ChapterSetResult>>
  onChapterChanged(listener: (state: ChapterState) => void): () => void
}

/** 取桥接的结果：要么拿到能力，要么拿到**可读的缺失原因**（不抛异常、不白屏）。 */
export type ChapterBridgeLookup =
  | { ready: true; bridge: ChapterBridge }
  | { ready: false; message: string }

/** 缺推送通道时给学生/开发者看的那句话（照它就能把线接上）。 */
export const CHAPTER_BRIDGE_MISSING_HINT =
  '教材章节还没有接线：preload 白名单缺少 onChapterChanged —— 需要先在主进程注册' +
  '「章节推送」通道（chapter:changed，由 preload 白名单暴露，渲染进程不直接持有通道名），' +
  '再由 preload 暴露 `onChapterChanged` / `getChapter` / `setChapter`。接线后刷新页面即可生效。'

/**
 * 桥在、但**缺少写入方法**时的说明。
 *
 * ★ 单独一条的理由：读与写是**两条**分步接线的能力（`chapterGet` / `chapterSet`）。
 *   只有读能力时，指示器照常显示「正在学：第X章」，只是「选章节」这个动作不可用 ——
 *   这时要让学生知道**是写入没接线**，而不是以为「章节功能整个坏了」。
 */
export const CHAPTER_SET_MISSING_HINT =
  '选择章节还没有接线：preload 白名单缺少 setChapter —— 需要先在主进程注册' +
  '「章节设定」通道（invoke，带回执：学生要看到改没改成），再由 preload 暴露 `setChapter`。' +
  '接线后刷新页面即可生效。'

/**
 * 从 `window.api` 上取章节能力。
 *
 * 为什么「按方法名探测」而不是直接调：主进程的章节能力与只读指示器是并行落地的两条改动，
 * 通道没落地时界面必须显示「未选择章节 + 一句能照着做的话」，
 * 而不是抛 `window.api.onChapterChanged is not a function` 把整页打空。
 *
 * ★ 逐方法确认后**显式拼桥**，不写 `host as unknown as ChapterBridge`：
 *   那种双重断言会把 `window.api` 的真实签名整条抹掉，主进程改名或改签名时渲染侧一行都不报错。
 */
export function resolveChapterBridge(
  host: K12Api | undefined = globalThis.window?.api
): ChapterBridgeLookup {
  if (typeof host === 'undefined') {
    return { ready: false, message: '预加载脚本未生效（window.api 缺失），当前教材章节暂时读不到。' }
  }

  const api: K12Api = host
  if (typeof api.onChapterChanged !== 'function') {
    return { ready: false, message: CHAPTER_BRIDGE_MISSING_HINT }
  }

  const bridge: ChapterBridge = {
    // 包一层：不把白名单上的方法原样转出去（订阅的是「我们的回调」，不是别人的方法引用）
    onChapterChanged: (listener) => api.onChapterChanged(listener)
  }
  // ★ 可选能力：读/写各自晚一步接线时，界面照常展示（只是对应的动作不可用）
  if (typeof api.getChapter === 'function') bridge.getChapter = () => api.getChapter()
  if (typeof api.setChapter === 'function') bridge.setChapter = (title) => api.setChapter(title)
  return { ready: true, bridge }
}

/**
 * 章节载荷的**白名单投影**：认得出就返回规范化对象，认不出返回 `null`（调用方忽略该条）。
 *
 * 与 `api/grade.ts` / `api/events.ts` 同一原则：脏数据一律「忽略而不抛异常」。
 *   - 学段**必须在四学段白名单里**（不认得的学段说明载荷不是本应用发的）；
 *   - `chapterTitle` 不是字符串一律折成**空串**（= 未选择），
 *     而不是 `undefined`：界面只处理一种空值形态（`''`），
 *     多一种空值就多一处「忘了一个分支就渲染出 undefined」的地方。
 */
export function normalizeChapterState(raw: unknown): ChapterState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  const gradeLevel = readGradeLevel(record.gradeLevel)
  if (gradeLevel === null) return null

  return {
    gradeLevel,
    chapterTitle: typeof record.chapterTitle === 'string' ? record.chapterTitle : ''
  }
}
