/**
 * 「当前学段」的**读取 + 手动设定**入口（渲染进程侧）。
 *
 * 学段的来源有两条线：
 *   1. **自动推断**（主进程侧：规则引擎 + 轻量 LLM 判定，票 21）→ 推 `grade:changed`；
 *   2. **学生手动指定**（本文件的 {@link GradeBridge.setGrade}）→ 服务端照单生效，
 *      冷却期内不再自动改（回执里的 `cooldownRemainingTurns`）。
 *
 * 渲染进程因此做三件事：
 *   1. 订阅「当前学段」的推送，把它当**状态**显示（指示器 / 设置页的只读行）；
 *   2. 判定结果变化时给一句可读提示，让学生**感知**到系统在适配他；
 *   3. 学生想自己指定时，把「他选了什么」**原样**交给服务端 —— 前端不推断、不预判、不算。
 *
 * ★ 手动学段**绝不混进对话请求**：`ChatSendRequest` 只有 `text`（架构守卫 G6c 钉死）。
 *   混进去的话「发一条消息」会顺带写一次学段，清空输入框重发、同一句话重试都会再写一遍 ——
 *   写入从「学生的显式动作」退化成「聊天的副作用」，而且没有回执可以告诉学生冷却还剩几轮。
 *
 * ---------------------------------------------------------------------------
 * ★ 需要主进程提供的能力（分步接线；缺哪条本模块给可读说明，不抛异常、不白屏）
 * ---------------------------------------------------------------------------
 *
 * 通道名（唯一来源 `src/main/ipc/channels.ts`，本文件不写死通道字符串）：
 *
 *   `IPC.gradeChanged`（主进程 → 渲染进程，**推送**）
 *       webContents.send(IPC.gradeChanged, state: GradeState)
 *       判定出学段、或学生手动设定后都要推一条。
 *       ★ 已登记进 `PUSH_CHANNELS`（架构守卫据此断言推送通道白名单）。
 *
 *   `IPC.gradeGet`（渲染进程 → 主进程，invoke，**可选**）
 *       ipcMain.handle(IPC.gradeGet, () => GradeCallResult<GradeState>)
 *       挂载时拉一次当前值，避免「刚打开时指示器空着」。
 *       若主进程在 `did-finish-load` 后主动推一次，这条可以不做——渲染进程已按可选处理。
 *
 *   `IPC.gradeSet`（渲染进程 → 主进程，invoke，**可选**）
 *       ipcMain.handle(IPC.gradeSet, (level) => GradeCallResult<GradeSetResult>)
 *       学生手动设定学段（唯一的人工写入口）。必须**有回执**（invoke 而不是 send）：
 *       学生要看到「改没改成、冷却还剩几轮」，推送通道给不了这个。
 *
 * preload 白名单（`K12Api`）三个方法：
 *
 *     getGrade(): Promise<GradeCallResult<GradeState>>                              // 可选
 *     setGrade(level: GradeLevel): Promise<GradeCallResult<GradeSetResult>>          // 可选
 *     onGradeChanged(listener: (state: GradeState) => void): () => void             // 必需
 *
 * ★ 缺通道时**不许崩、不许白屏**：`resolveGradeBridge()` 返回 `{ready:false, message}`，
 *   store 记下原因，指示器显示「待判定」并附一句可读说明（与 `api/settings.ts`
 *   的 `resolveSettingsBridge()` 同一口径）。
 */

import type { K12Api } from '../../../preload/index'
import type { GradeCallResult, GradeOrigin, GradeSetResult, GradeState } from '../../../main/ipc/channels'
import type { GradeLevel } from '@shared/ipc-events'
import { warnWiring } from './wiring-notice'

/**
 * ★ 这三个类型**不在渲染进程重写一遍**（H12）：
 *   它们的唯一来源是 `src/main/ipc/channels.ts`（preload 也 import 那里），
 *   形状在这里各写一份的话，主进程改了字段渲染侧不会报错 —— 正是契约漂移的起点。
 *   跨目录用**相对路径** type-only 导入（与 `stores/sidecar.ts` 引 `main/sidecar/protocol` 同一写法）；
 *   纯类型导入在编译后被完全擦除，渲染进程运行时不加载任何主进程模块。
 */
export type { GradeCallResult, GradeOrigin, GradeSetResult, GradeState }

/**
 * 主进程需要暴露的学段能力。
 *
 * `onGradeChanged` **必需**（没有它指示器永远是「待判定」）；
 * `getGrade` / `setGrade` **可选** —— 白名单是分步接线的：主进程若在订阅后主动推一次
 * 当前值，就不需要 `getGrade`；还没做手动入口时，就不需要 `setGrade`。
 */
export interface GradeBridge {
  getGrade?(): Promise<GradeCallResult<GradeState>>
  /** ★ 学生手动设定学段。缺失 = 主进程还没接线，界面给一句可读说明而不是抛异常。 */
  setGrade?(gradeLevel: GradeLevel): Promise<GradeCallResult<GradeSetResult>>
  onGradeChanged(listener: (state: GradeState) => void): () => void
}

/** 取桥接的结果：要么拿到能力，要么拿到**可读的缺失原因**（不抛异常、不白屏）。 */
export type GradeBridgeLookup =
  | { ready: true; bridge: GradeBridge }
  | { ready: false; message: string }

/**
 * 整块学段能力不可用时**给学生看的那句话**（指示器那一行）。
 *
 * ★★ 两种成因共用这一句：preload 没加载（`window.api` 缺失）与缺推送通道
 *   （`onGradeChanged` 不在白名单里）—— 学生的可见后果一样（看不出年级），
 *   区别只进控制台（见 {@link resolveGradeBridge}）。
 *
 * ★★ 2026-09-22 改口（设计评审报告 0.2 + 双视角 D-063）：原来这句是接线说明
 *   （「preload 白名单缺少 onGradeChanged……接线后刷新页面即可生效」）——
 *   学生读到的是两个他看不懂的词（preload / 方法名），而「刷新页面」对他也是假承诺。
 *   现在只说三件事：看不出年级、问答照常、找谁。
 *   ⚠️ 别写成「学段判定还没接上」这类系统口吻：「判定」是 `rules.py` 的动作（报告 0.2）。
 */
export const GRADE_BRIDGE_MISSING_HINT = '暂时看不出你的年级，我会照常回答。需要时请老师帮忙看看。'

/**
 * 桥在、但**缺写入方法**（`setGrade`）时给学生看的那句话。
 *
 * ★ 单独一条的理由：读与写是**两条**分步接线的能力（`gradeGet` / `gradeSet`）。
 *   只有读能力时，指示器照常显示系统认出来的学段，只是「我自己选年级」这个动作不可用 ——
 *   这句话要说清「现在改不了、但系统仍会跟着你调整」，而不是让学生以为「学段整个坏了」。
 *   （技术细节走控制台，见 `resolveGradeBridge`。）
 */
export const GRADE_SET_MISSING_HINT = '暂时改不了年级，我会自己跟着你的问题调整。需要时请老师帮忙看看。'

/**
 * 从 `window.api` 上取学段能力。
 *
 * 为什么「按方法名探测」而不是直接调：学段判定（主进程）与只读指示器（渲染进程）
 * 是两条并行的改动，通道没落地时指示器必须显示「一句学生能读的话」，
 * 而不是抛 `window.api.onGradeChanged is not a function` 把整页打空。
 *
 * ★★ 缺哪一条线时，**接线细节进控制台**（`warnWiring`）、**屏幕上是学生话**
 * （{@link GRADE_BRIDGE_MISSING_HINT} / {@link GRADE_SET_MISSING_HINT}）——
 *   两条通路的分工见 `api/wiring-notice.ts` 的文件头。
 */
export function resolveGradeBridge(): GradeBridgeLookup {
  if (typeof window === 'undefined' || typeof window.api === 'undefined') {
    warnWiring(
      'grade',
      'window.api 缺失：preload 没有加载（整块学段能力不可用）。检查 preload 入口与 contextIsolation / sandbox 配置。'
    )
    return { ready: false, message: GRADE_BRIDGE_MISSING_HINT }
  }

  // ★ 结构检查替代双重断言（H12）：先按**主进程白名单的真实类型**拿到 `window.api`，
  //   再逐方法确认（白名单是分步接线的，运行时可能缺方法），最后显式拼出要交给上层的桥。
  //   原来那句 `host as unknown as GradeBridge` 把 `window.api` 的真实签名整条抹掉 ——
  //   主进程把 `onGradeChanged` 改名或改签名，渲染侧一行都不会报错。
  const api: K12Api = window.api
  if (typeof api.onGradeChanged !== 'function') {
    warnWiring(
      'grade.push',
      'preload 白名单缺少 onGradeChanged：需要主进程注册 grade:changed 推送通道' +
        '（已登记进 PUSH_CHANNELS），再由 preload 暴露 onGradeChanged / getGrade / setGrade。接线后重启渲染进程即可生效。'
    )
    return { ready: false, message: GRADE_BRIDGE_MISSING_HINT }
  }

  const bridge: GradeBridge = {
    // 包一层：不把白名单上的方法原样转出去（订阅的是「我们的回调」，不是别人的方法引用）
    onGradeChanged: (listener) => api.onGradeChanged(listener)
  }
  if (typeof api.getGrade === 'function') {
    bridge.getGrade = () => api.getGrade()
  } else {
    warnWiring('grade.get', 'preload 白名单缺少 getGrade：挂载时拉不到当前学段（指示器要等一次推送才有值）。')
  }
  // ★ 同样是「可选能力」：`grade:set` 晚一步接线时，界面照常展示（只是不能手动指定），
  //   不能因为缺这一个方法就把整块学段显示变成一句「未接线」。
  if (typeof api.setGrade === 'function') {
    bridge.setGrade = (level) => api.setGrade(level)
  } else {
    warnWiring(
      'grade.set',
      'preload 白名单缺少 setGrade：需要主进程注册 grade:set（invoke，带回执 —— 学生要看到改没改成、冷却还剩几轮），' +
        '再由 preload 暴露 setGrade。接线后重启渲染进程即可生效；在那之前界面只读（系统照样自动跟学段）。'
    )
  }
  return { ready: true, bridge }
}

/** 四学段字面量（冻结；与 `shared/ipc-events.ts` 逐字一致）。 */
export const GRADE_LEVELS: readonly GradeLevel[] = ['primary_low', 'primary_high', 'junior', 'senior']

/**
 * 学段载荷的**白名单投影**：认得出就返回规范化对象，认不出返回 `null`（调用方忽略该条）。
 *
 * 与 `api/events.ts` 同一原则：脏数据一律「忽略而不抛异常」，绝不猜一个最近的学段。
 *
 * ★★ `origin` 现在是**五态**（D-066，2026-09-21）：`explicit` / `llm` / `rules` /
 *   `inferred`（历史值，等价于 `rules`）/ 其余 → `default`。
 *   把 `explicit` 漏成 `default` 的后果不是「显示得不准」，而是**整条推送被丢掉**：
 *   store 只让「真的判过或学生选过」的态上屏，学生刚点完学段、主进程立刻推来的那条
 *   `origin: 'explicit'` 会被归一化成一个「不算判定结果」的值，界面停在上一个状态 ——
 *   表现成**点了没反应**（学生以为自己没点中，于是反复点）。
 *
 *   ★ `default` = **还没判过**（冷启动基线）：宁可显示「待判定」，
 *   也不要假装系统判过 —— 那正是用户点名要修的「发一句你好就成了 AI 引擎推算」。
 *
 * ★ 只投影**两个字段**（`gradeLevel` / `origin`）：它们是界面真正消费的部分，也是
 *   `GradeState` 两个版本都有的字段。传输类型里那些诊断字段（`reason` / `source` 之类，
 *   只给开发者看）**不复制、也不在这里另起名字** —— 渲染进程不该为了排查再维护一份契约。
 */
const KNOWN_GRADE_ORIGINS: readonly GradeOrigin[] = ['explicit', 'llm', 'rules', 'inferred']

export function normalizeGradeState(raw: unknown): GradeState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  const gradeLevel = readGradeLevel(record.gradeLevel)
  if (gradeLevel === null) return null

  const origin = record.origin
  return {
    gradeLevel,
    origin: KNOWN_GRADE_ORIGINS.includes(origin as GradeOrigin)
      ? (origin as GradeOrigin)
      : 'default'
  }
}

/** 字符串 → 学段字面量（认不出返回 `null`，不映射、不猜测）。 */
export function readGradeLevel(value: unknown): GradeLevel | null {
  return typeof value === 'string' && (GRADE_LEVELS as readonly string[]).includes(value)
    ? (value as GradeLevel)
    : null
}
