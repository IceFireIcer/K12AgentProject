/**
 * 「当前学段」的**只读**读取入口（渲染进程侧）。
 *
 * ★★ 设计已变更（2026-09）：**没有手动学段选择器了**。
 *
 *   学段由系统从对话里判定（规则引擎 + 轻量 LLM 判定，主进程侧实现；票 21）。
 *   渲染进程因此只做两件事：
 *     1. 订阅「当前学段」的推送，把它当**状态**显示（只读指示器，不是控件）；
 *     2. 判定结果变化时给一句可读提示，让学生**感知**到系统在适配他，而不需要他做任何操作。
 *
 *   `ChatSendRequest` 里**没有** `gradeLevel` 字段：前端既不能决定学段，也不发送学段。
 *
 * ---------------------------------------------------------------------------
 * ★ 需要主进程提供的能力（唯一缺口；主进程侧落地后本模块自动生效）
 * ---------------------------------------------------------------------------
 *
 * 通道名（唯一来源 `src/main/ipc/channels.ts`，本文件不写死通道字符串）：
 *
 *   `IPC.gradeChanged`（主进程 → 渲染进程，**推送**）
 *       webContents.send(IPC.gradeChanged, state: GradeState)
 *       系统判定出学段时推一条（首次判定 / 判定结果变化都要推）。
 *       ★ 必须登记进 `PUSH_CHANNELS`（架构守卫据此断言推送通道白名单）。
 *
 *   `IPC.gradeGet`（渲染进程 → 主进程，invoke，**可选**）
 *       ipcMain.handle(IPC.gradeGet, () => GradeCallResult<GradeState>)
 *       挂载时拉一次当前值，避免「刚打开时指示器空着」。
 *       若主进程在 `did-finish-load` 后主动推一次，这条可以不做——渲染进程已按可选处理。
 *
 * payload（建议与 `GradeLevel` 同源放在 `src/shared/ipc-events.ts`）：
 *
 *     export interface GradeState {
 *       gradeLevel: GradeLevel          // 四冻结字面量之一
 *       origin: 'inferred' | 'default'  // 系统判定的 / 冷启动默认值（还没判出来）
 *       reason?: string | null          // 判定依据摘要（给开发者看；UI 不展示）
 *     }
 *
 * preload 白名单（`K12Api`）两个方法：
 *
 *     getGrade(): Promise<GradeCallResult<GradeState>>                    // 可选
 *     onGradeChanged(listener: (state: GradeState) => void): () => void   // 必需
 *
 * ★ 缺通道时**不许崩、不许白屏**：`resolveGradeBridge()` 返回 `{ready:false, message}`，
 *   store 记下原因，指示器显示「待判定」并附一句可读说明（与 `api/settings.ts`
 *   的 `resolveSettingsBridge()` 同一口径）。
 */

import type { GradeLevel } from '@shared/ipc-events'

/** 判定来源：`inferred` = 系统真判出来了；`default` = 冷启动默认值（还没判）。 */
export type GradeOrigin = 'inferred' | 'default'

/** 当前学段（主进程推送 / 拉取的载荷）。 */
export interface GradeState {
  gradeLevel: GradeLevel
  origin: GradeOrigin
  /** 判定依据摘要（给开发者；界面不展示）。 */
  reason?: string | null
}

/** IPC 回执（与 `channels.ts` 的 `SettingsCallResult` 同一写法：失败也回一句人话）。 */
export type GradeCallResult<T> = { ok: true; data: T } | { ok: false; message: string }

/**
 * 主进程需要暴露的学段能力。
 *
 * `onGradeChanged` **必需**（没有它指示器永远是「待判定」）；
 * `getGrade` **可选**（主进程若在订阅后主动推一次当前值，就不需要它）。
 */
export interface GradeBridge {
  getGrade?(): Promise<GradeCallResult<GradeState>>
  onGradeChanged(listener: (state: GradeState) => void): () => void
}

/** 取桥接的结果：要么拿到能力，要么拿到**可读的缺失原因**（不抛异常、不白屏）。 */
export type GradeBridgeLookup =
  | { ready: true; bridge: GradeBridge }
  | { ready: false; message: string }

/** 缺通道时给学生/开发者看的那句话（照它就能把线接上）。 */
export const GRADE_BRIDGE_MISSING_HINT =
  '学段自动判定还没有接线：preload 白名单缺少 onGradeChanged —— 需要先在主进程注册' +
  '「学段推送」通道（由 preload 白名单暴露，渲染进程不直接持有通道名），再由 preload 暴露' +
  ' `onGradeChanged` / `getGrade`。接线后刷新页面即可生效。'

/**
 * 从 `window.api` 上取学段能力。
 *
 * 为什么「按方法名探测」而不是直接调：学段判定（主进程）与只读指示器（渲染进程）
 * 是两条并行的改动，通道没落地时指示器必须显示「待判定 + 一句能照着做的话」，
 * 而不是抛 `window.api.onGradeChanged is not a function` 把整页打空。
 */
export function resolveGradeBridge(): GradeBridgeLookup {
  if (typeof window === 'undefined' || typeof window.api === 'undefined') {
    return { ready: false, message: '预加载脚本未生效（window.api 缺失），学段判定暂时读不到。' }
  }

  const host = window.api as unknown as Record<string, unknown>
  if (typeof host.onGradeChanged !== 'function') {
    return { ready: false, message: GRADE_BRIDGE_MISSING_HINT }
  }

  return { ready: true, bridge: host as unknown as GradeBridge }
}

/** 四学段字面量（冻结；与 `shared/ipc-events.ts` 逐字一致）。 */
export const GRADE_LEVELS: readonly GradeLevel[] = ['primary_low', 'primary_high', 'junior', 'senior']

/**
 * 学段载荷的**白名单投影**：认得出就返回规范化对象，认不出返回 `null`（调用方忽略该条）。
 *
 * 与 `api/events.ts` 同一原则：脏数据一律「忽略而不抛异常」，绝不猜一个最近的学段。
 * `origin` 只认两个字面量；缺省时按 `default` 处理（**宁可显示待判定，也不要假装系统判过**）。
 */
export function normalizeGradeState(raw: unknown): GradeState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  const gradeLevel = readGradeLevel(record.gradeLevel)
  if (gradeLevel === null) return null

  const reason = typeof record.reason === 'string' && record.reason.trim().length > 0
    ? record.reason.trim()
    : null

  return { gradeLevel, origin: record.origin === 'inferred' ? 'inferred' : 'default', reason }
}

/** 字符串 → 学段字面量（认不出返回 `null`，不映射、不猜测）。 */
export function readGradeLevel(value: unknown): GradeLevel | null {
  return typeof value === 'string' && (GRADE_LEVELS as readonly string[]).includes(value)
    ? (value as GradeLevel)
    : null
}
