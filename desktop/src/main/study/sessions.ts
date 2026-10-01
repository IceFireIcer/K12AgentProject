/**
 * 历史会话的读取与投影（会话列表 / 单条正文 / 搜索 / 历史消息投影）。
 *
 * ---------------------------------------------------------------------------
 * 这个模块负责什么、不负责什么
 * ---------------------------------------------------------------------------
 * - **本模块**：纯投影（`SessionInfo[]` → 界面用的摘要；`SessionEntry[]` → 可显示的问答）
 *   与两个「真的去问 Pi」的只读函数（`listStudentSessions` / `readStudentSessionEntries`）。
 * - **不在这里**：会话的**切换 / 新建 / 恢复续聊**。那要 dispose 当前 runtime、
 *   重装一个新 runtime、并处理「装配期间被 dispose」的代际竞态 —— 全部在
 *   `ipc/handlers.ts`（`swapRuntime` / `openSession` / `newSession`）与
 *   `agent/runtime.ts`（`sessionSource`）里。放在这里会让本模块持有会话单例，
 *   而单例只能有一处（现在那处是 `handlers.ts` 的 `runtime`）。
 * - ★ 但**投影是共用的**：`agent/runtime.ts` 恢复历史时也调这里的 `projectTranscript`
 *   —— 与回看走同一个纯函数，「回看里看到的」与「继续聊时读到的」才不会不一致。
 *
 * ---------------------------------------------------------------------------
 * ★★ 两条安全约束（这两条不满足就是漏洞，不是「待优化」）
 * ---------------------------------------------------------------------------
 * 1. **只接受会话 id，绝不接受路径**。渲染进程递进来的东西一律先与
 *    `SessionManager.list()` 的结果**对齐**（在白名单里才认），再用**Pi 自己给的 `path`**
 *    去打开。若直接 `open(前端给的路径)`，渲染进程就等于拿到了「读任意文件」的能力
 *    （`..\\..\\config.json` 这类）。这是本模块存在的**首要理由**。
 * 2. **会话目录必须显式指向该学生**（`resolveStudentPiPaths(...).sessionDir`）。
 *    Pi 的默认目录是 `~/.pi/agent/sessions/`，漏传第二个参数会静默读到**用户自己 Pi CLI 的会话**
 *    —— 既是隐私问题，也让「跨学生隔离」失效（`pi-paths.ts` 的断言守的就是这条）。
 *
 * 纯函数与「需要 Pi」的部分**分开**：投影、切片、搜索都是纯函数（可在 `node --test` 里跑），
 * 只有 `listSessions` / `readTranscript` 需要真的去问 Pi。
 */

import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import type { PayloadKind } from '@shared/ipc-events'
// ★ `isInside` 是纯路径判定（只用 `node:path`），所以可以静态引入 ——
//   它把「这条路径真的在当前学生的会话目录里吗」收口成一个可单测的纯函数，
//   **删除会话**（本项目唯一的破坏性文件操作）靠的正是它。
import { isInside } from '../agent/pi-paths.ts'

/** 会话列表里的一项（**给界面看的投影**，不是 Pi 的原始 `SessionInfo`）。 */
export interface SessionSummary {
  /** ★ 恢复/读取时只认它（**不是** path：path 绝不进渲染进程） */
  id: string
  /** 标题：优先 Pi 的 `name`，否则取首条消息截断 */
  title: string
  /** 消息条数 */
  messageCount: number
  /** 最后修改时间（Unix 毫秒） */
  modifiedAt: number
  /** 创建时间（Unix 毫秒） */
  createdAt: number
  /** 首条消息的预览（可能为空：会话刚建、还没说话） */
  preview: string
}

/** 一条会话消息（投影后的形态，渲染进程直接渲染）。 */
export interface TranscriptMessage {
  role: 'user' | 'assistant'
  /**
   * ★★ 开场白指向的知识点（只有「开场引导」那条消息会带）。
   *
   * 为什么把它**写进会话文件**（2026-09-30 修）：开场引导的动作按钮要指向一个知识点，
   * 而恢复会话时原先只能靠「重新取到的开场语与文件里那句**逐字相同**」来认它 ——
   * 推荐池随画像变化，重启后重取的那句往往不同（模板说法 + 随机知识点都会变），
   * 于是按钮被撤掉：卡片上留着一句「要不我们从 X 聊起？」却点不动。
   * 现在写入时把目标一起落在消息里，恢复时**直接读**，不再依赖文案比对。
   * 老会话没有这份元数据 → 退回原来的逐字判据（不猜、不编）。
   */
  openingKp?: { kpId: string; kpName: string }
  /**
   * ★★ 这条**助手回答**当时带来的卡片（2026-09-30 用户裁决：全部卡片都要能恢复）。
   *
   * 从哪来：`runtime.ts` 在轮次收尾把本轮的 `payload` 卡片写进一条 `custom` 条目
   * （`customType: 'k12.cards'`），这里把那条条目**挂回助手消息**上。
   *
   * 为什么按 id 挂而不按顺序：Pi 的条目流里还混着 `model_change` /
   * `thinking_level_change` / 开场引导 等条目，而失败或被拦下的轮次**不留助手条目** ——
   * 「第几条」与「第几轮」会漂（本文件里已有同类的教训）。写入口落的是助手条目 id，
   * 认不出时才退回「条目之前最近的一条助手消息」，那只是兜底、不是主判据。
   *
   * ★ 动画卡也在这条路上（用户裁决）：卡片是**当时交互的产物**，回看要能再看见；
   *   动画的**重放策略**由渲染层决定（它按 kind 重新取资源），主进程只负责把当时那份
   *   payload 原样还回去 —— 不在投影层解释它、也不改写它。
   *
   * ⚠️ 结构不对 / `kind` 不在白名单里的一律**跳过**（宁可少一张卡）：白名单就是
   *   `ipc/tool-kinds.ts` 那张表的值 —— 与「发 `payload` 事件」查的是同一张表，
   *   所以「能发出来的」与「能恢复的」恒等，不另写第三份。
   */
  cards?: Array<{ kind: PayloadKind; payload: unknown }>
  text: string
  /** Unix 毫秒（来自 entry 的 timestamp） */
  at: number
  /**
   * ★★ 这条消息在会话文件里的**条目 id**（Pi 的 `SessionEntry.id`）。
   *
   * 为什么必须带上它：**「从这里重新问」要拿它去找 Pi 的分叉点**
   * （`createBranchedSession(entryId)` 只认条目 id）。
   *
   * ⚠️ 为什么不用「第几条消息」当分支点：**编号会漂**。实测过的两种漂法：
   *   ① 开场引导是一条 assistant 消息，但它在前端是**独立卡片**（不算一轮），
   *      学生一开口那张卡片就收起 —— 于是同一段会话里「第几轮」与「第几条消息」
   *      差一个（取决于卡片还在不在）；② 失败 / 被拦下的轮次**不会**留下 assistant
   *      条目，编号跟着错位。
   *   而**条目 id 是文件里的稳定标识**，不受显示形态影响。
   */
  entryId: string
  /** 项目类型（`message` / `custom_message` …）—— 只有 `message` 能当分支点。 */
  entryType: string
}

/** 一条会话的正文（只读回看用）。 */
export interface SessionTranscript {
  id: string
  title: string
  messages: TranscriptMessage[]
  /** 被截断掉的消息条数（超过上限时 > 0；界面据此提示「只显示最近 N 条」） */
  truncated: number
}

/** 单条会话最多回传的消息数（防一个超长会话把 IPC 载荷撑爆）。 */
export const MAX_TRANSCRIPT_MESSAGES = 200

/** 标题/预览的截断长度（**按字符**，不是字节 —— 按字节会把汉字切成半个）。 */
export const TITLE_MAX_CHARS = 24
const PREVIEW_MAX_CHARS = 80

/**
 * 按**字符**截断（不按字节）。
 *
 * ★ 用 `Array.from` 而不是 `slice`：`'😀'.length === 2`，直接 `slice` 会把代理对
 *   劈成两半，界面上显示成 ``。汉字虽然只在 BMP 里（一个 code unit），
 *   但学生的会话里完全可能出现 emoji。
 */
export function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, maxChars).join('')}…`
}

/**
 * ★★ 机器 wire 标签的还原（**纯函数**；判据 v2，2026-09-30）。
 *
 * 为什么必须有（2026-09-30 真机实测）：从学习地图点「开始学习」时，界面会替学生发出一条
 * **机器文本**，它第一行形如「【学习计划】kp_id=…」，于是这条文本成了会话的**首条
 * user 消息**。Pi 在会话还没有名字时会拿首条消息当标题 —— 列表上就直接印出了这串
 * 本来就只该发给模型的标记（学生会看到「【学习计划】kp_i…」）。同类首行还有
 * 「【练习检验】」「【编程求助】」。
 *
 * ★ 判据**只看形状，不看语义，也不引入任何前缀白名单**（白名单要主进程抄一份渲染层的
 *   常量，将来新增前缀还得回来改主进程；而形状判据对未来新前缀自动生效）。
 *   第一行必须同时满足：
 *     · 形状：「【」开头、「】」收尾，标签 1~12 字；
 *     · 并命中下面两条机器特征之一：
 *       ① 含 `kp_id=` 或 `kpId=`（【学习计划】/【练习检验】这类 wire 都带它）；
 *       ② 含一对角括号包起来的**机器 id 形状** `「[A-Za-z0-9][A-Za-z0-9._-]{2,}」`
 *          （纯 ASCII、无空格无汉字，例如编程求助的真实首行
 *          `【编程求助】我在做「prog-loop-jr」这道题，卡住了…`）。
 *
 * ★ 为什么可以这么放宽：
 *   · 学生自己打的「【学习计划】我想自己学」「【重要】记得复习」两条特征都不含 → 原样，
 *     一个字不改；角括号里写成汉字（「循环结构」）同样不命中；
 *   · 命中也只改**列表标题这一段显示文本** —— 磁盘上的会话、发给模型的原文一个字节不动，
 *     最坏情况是把标签当成标题，属**外观级**代价；
 *   · ⚠️ 已知边界（不假装不存在）：学生**原样引用我们的特征 token** 时会被当成标签
 *     （手打「【笔记】看 kp_id= 那段」）—— 判据认不出「谁写的」。这条在测试里有显式断言。
 *
 * 返回标签本身（如「学习计划」）；认不出返回空串，由调用方**原样保留**。
 */
export function wireLabelOf(text: string): string {
  const firstLine = (text ?? '').split('\n', 1)[0].trim()
  // 先认特征再取标签：普通学生文本里的「【…】」不该被白白匹配一遍。
  const hasKpField = /(?:kp_id=|kpId=)/.test(firstLine)
  const hasMachineId = /「[A-Za-z0-9][A-Za-z0-9._-]{2,}」/.test(firstLine)
  if (!hasKpField && !hasMachineId) return ''
  return /^【([^【】]{1,12})】/.exec(firstLine)?.[1] ?? ''
}

/**
 * 会话标题的**唯一实现**（列表标题、搜索命中标题、主进程写标题三处共用）。
 *
 * 优先级写死：**有名字（LLM 生成 / 会话命名）就用名字**；没有才退回首条消息，
 * 而退回首条消息时**必须先过 `wireLabelOf`** —— 否则机器标记会从这一条缝漏到标题上。
 * 两者都没有时保留原来的占位「（空会话）」。
 */
export function sessionTitleFrom(
  name: string | undefined,
  firstMessage: string | undefined,
  maxChars: number = TITLE_MAX_CHARS
): string {
  const explicit = (name ?? '').replace(/\s+/g, ' ').trim()
  if (explicit) return truncateChars(explicit, maxChars)
  return truncateChars(firstMessageBody(firstMessage) || '（空会话）', maxChars)
}

/**
 * 首条消息在**学生眼前那一行**的投影（标题与列表预览共用，避免两处口径漂移）。
 * 空串保持空串 —— 预览允许为空（会话刚建、还没说话）；标题的空由调用方给占位。
 */
function firstMessageBody(firstMessage: string | undefined): string {
  const raw = (firstMessage ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  return wireLabelOf(firstMessage ?? '') || raw
}

/**
 * 把 Pi 的 `SessionInfo[]` 投影成界面用的摘要列表（**纯函数**）。
 *
 * 排序：**最后修改时间倒序**（最近用过的在最上面）。平局按 id 兜底 ——
 * 否则同一毫秒的两条会话顺序会随 Pi 的返回顺序漂，列表每次刷新都在跳。
 */
export function projectSessionList(infos: SessionInfo[]): SessionSummary[] {
  return infos
    .map((info) => ({
      id: info.id,
      // ★ 标题与预览都走**同一处投影**（`sessionTitleFrom` / `firstMessageBody`）：
      //   name 优先；退回首条消息时先还原机器 wire 标签 —— 否则列表上会直接印出
      //   那串只该发给模型的标记。两者都没有才显示占位，**不要**把 path 当标题。
      title: sessionTitleFrom(info.name, info.firstMessage),
      messageCount: info.messageCount,
      modifiedAt: toMs(info.modified),
      createdAt: toMs(info.created),
      preview: truncateChars(firstMessageBody(info.firstMessage), PREVIEW_MAX_CHARS)
    }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id))
}

/**
 * ★★ **会话树**（分支关系的投影；纯函数）。
 *
 * 为什么用「父会话」而不是「树」这个词：Pi 的分叉**产生一个新文件**
 * （`createBranchedSession` → `header.parentSession = <父文件路径>`），
 * 而不是在同一棵树里长出一条枝。所以「会话树」在**存储层**就是
 * 「一串带 `parentSession` 指向的会话」——没有嵌套结构可画，
 * 有的是「这条是从哪条分出来的 + 从第几条消息分的」。
 *
 * ★ `SessionInfo.parentSessionPath` 是 **Pi 给的**（`list()` 的字段），不是我们算的：
 *   自己去读每个 JSONL 的头部等于把 Pi 的文件格式抄第二遍。
 *
 * ⚠️ **指向文件不存在时降级**（`parentId: null` 但保留 `parentTitle` 提示）：
 *   父会话可能已被删除 / 被清理过 —— 那种情况下**不能声称它有父**，
 *   否则界面会显示一个点不开的「来自…」。这与「悬空 to_kp_id 应报错而非静默跳过」
 *   那条纪律不冲突：这里是展示层，诚实地说「父会话不在了」比整条不显示更有用。
 */
export interface SessionTreeEntry {
  id: string
  title: string
  messageCount: number
  modifiedAt: number
  /** 从哪条会话分出来的（`null` = 独立会话，不是分支）。 */
  parentId: string | null
  /** 父会话的标题（父不在本列表里时仍可能有；仅用于展示）。 */
  parentTitle: string | null
  /** 从父会话的第几条消息分出来的（1-based；`null` = 不知道）。 */
  branchedAtMessage: number | null
  /**
   * ★★ **树里的层级**（0 = 根）。
   *
   * 为什么是「深度优先展开后的扁平数组 + depth」而不是嵌套的 `children`：
   * 界面用 `v-for` 渲染一个列表最省事，而嵌套结构要让组件递归（Vue 里得再写一个
   * 自引用组件）。**扁平 + depth 是树形列表的标准做法** —— 缩进由 depth 算出来。
   */
  depth: number
  /** 直接子分支数（界面据此决定给不给展开/收起箭头）。 */
  childCount: number
  /** 是不是同层里的最后一个（决定画 `└` 还是 `├`）。 */
  isLast: boolean
  /**
   * ★ 每个祖先层要不要画竖线（长度 = `depth`）。
   *
   * `guides[i] === true` 表示「深度 i 那个祖先**后面还有兄弟**」，所以那条竖线
   * 必须一直连下去。这是画树形连接线的标准做法 —— 没有它就只能画缩进，
   * 而缩进看不出「谁挂在谁下面」。
   */
  guides: boolean[]
}

/** 会话树里一项的原始输入（`SessionSummary` + Pi 的父路径）。 */
export interface SessionTreeInput {
  id: string
  title: string
  messageCount: number
  modifiedAt: number
  /** Pi 的 `SessionInfo.parentSessionPath`（**文件路径**，只在主进程内用）。 */
  parentPath?: string
}

/**
 * 把会话列表投影成**带分支关系**的树（纯函数，`node --test` 可直测）。
 *
 * `pathToId` 是「文件路径 → 会话 id」的映射（由调用方从同一批 `SessionInfo` 建）——
 * 我们不在这里猜路径怎么对应 id（那是 Pi 的命名规则，不该抄第二遍）。
 *
 * `branchedAtMessage` 目前**恒为 `null`**：要知道「从第几条消息分出来的」，
 * 得去比对父子两个文件的共同前缀 —— 那要读**两个** JSONL，代价不小，
 * 而它在界面上只是一句锦上添花的话。**宁可不说，也不说错的**（宁缺勿假）。
 */
export function projectSessionTree(
  items: readonly SessionTreeInput[],
  pathToId: ReadonlyMap<string, string>
): SessionTreeEntry[] {
  const byId = new Map(items.map((item) => [item.id, item]))

  // ① 解析父：**只认本列表里真实存在、且不是自己的**父 ——
  //    父已被删除时不能声称有父（否则界面给出一个点不开的「来自…」，那是谎话）。
  const parentOf = new Map<string, string | null>()
  for (const item of items) {
    const key = item.parentPath?.trim() ?? ''
    const candidate = key ? pathToId.get(key) ?? null : null
    parentOf.set(
      item.id,
      candidate !== null && candidate !== item.id && byId.has(candidate) ? candidate : null
    )
  }

  // ② ★ 断环：`parentSession` 是我们**读来的**字段，手改过的会话文件完全可能
  //    造出 A→B→A。不断的话下面的递归会**栈溢出**（而不是给一句可读错误）——
  //    一个坏文件把整个列表打不开，代价完全不成比例。
  for (const id of byId.keys()) {
    const seen = new Set<string>([id])
    let cursor = parentOf.get(id) ?? null
    while (cursor !== null) {
      if (seen.has(cursor)) {
        parentOf.set(id, null)
        break
      }
      seen.add(cursor)
      cursor = parentOf.get(cursor) ?? null
    }
  }

  // ③ children 索引（顺序在 ④ 里统一排）
  const childrenOf = new Map<string, string[]>()
  for (const id of byId.keys()) {
    const parentId = parentOf.get(id) ?? null
    if (parentId === null) continue
    const bucket = childrenOf.get(parentId)
    if (bucket) bucket.push(id)
    else childrenOf.set(parentId, [id])
  }

  /**
   * ④ 子树里的**最新活动时间**（后序一次算完，供排序用）。
   *
   * ★★ 为什么排序要用这个而不是每条会话自己的 `modifiedAt`：
   * 从一条**很旧**的会话分叉出新会话时，父文件的 mtime **不会变** ——
   * 若按各自的 mtime 排根节点，那个家族会一直沉在列表底部，
   * 而学生刚刚才在里面聊过（B 是最新的，却排在最后）。
   * 取「家族最新」当排序键，任何一条被用过都会把整个家族顶上去 ——
   * 这也是文件树/IDE 的通行做法。
   *
   * ★ 一条重要的性质：**没有分支时它退化成 `modifiedAt` 本身** ——
   * 所以「从没分叉过的学生」看到的顺序与改造前**一模一样**（不是重新洗牌）。
   */
  const activity = new Map<string, number>()
  const visitActivity = (id: string): number => {
    const cached = activity.get(id)
    if (cached !== undefined) return cached
    let best = byId.get(id)?.modifiedAt ?? 0
    for (const childId of childrenOf.get(id) ?? []) {
      best = Math.max(best, visitActivity(childId))
    }
    activity.set(id, best)
    return best
  }
  for (const id of byId.keys()) visitActivity(id)

  /** 同层排序：家族最新活动倒序；平局按 id 兜底（否则同毫秒的两条会随 Pi 的返回顺序漂）。 */
  const sortSiblings = (ids: string[]): string[] =>
    [...ids].sort((a, b) => {
      const diff = (activity.get(b) ?? 0) - (activity.get(a) ?? 0)
      return diff !== 0 ? diff : a.localeCompare(b)
    })

  // ⑤ 深度优先展开成扁平数组（界面按 depth 缩进、按 guides 画连接线）
  const roots = sortSiblings([...byId.keys()].filter((id) => (parentOf.get(id) ?? null) === null))
  const out: SessionTreeEntry[] = []
  const walk = (id: string, depth: number, guides: boolean[], isLast: boolean): void => {
    const item = byId.get(id)
    if (!item) return
    const parentId = parentOf.get(id) ?? null
    const kids = sortSiblings(childrenOf.get(id) ?? [])
    out.push({
      id: item.id,
      title: item.title,
      messageCount: item.messageCount,
      modifiedAt: item.modifiedAt,
      parentId,
      parentTitle: parentId ? byId.get(parentId)?.title ?? null : null,
      // 要知道「从第几条消息分的」得比对父子两个文件的共同前缀 —— 那要读**两个** JSONL，
      // 而它在界面上只是一句锦上添花的话。**宁可不说，也不说错的**。
      branchedAtMessage: null,
      depth,
      childCount: kids.length,
      isLast,
      guides: [...guides]
    })
    kids.forEach((childId, index) => {
      // 下一层的 guides = 本层 guides + 「我自己后面还有兄弟吗」
      walk(childId, depth + 1, [...guides, !isLast], index === kids.length - 1)
    })
  }
  roots.forEach((id, index) => walk(id, 0, [], index === roots.length - 1))
  return out
}

/** `Date` → Unix 毫秒（非法日期回 0，不抛）。 */
export function toMs(value: Date | string | number | undefined): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * 把一段**纯文本**投影成标题（导出的文件名等场合用；纯函数）。
 *
 * 这里刻意不做字符截断之外的任何处理：不翻译、不补标点 —— 标题应当就是学生自己说的话。
 */
export function titleFromText(text: string, maxChars = TITLE_MAX_CHARS): string {
  return truncateChars(text.replace(/\s+/g, ' ').trim() || '未命名', maxChars)
}

/** Pi 的一条 session entry 里我们关心的字段（**结构检查**用，不 import Pi 的类型）。 */
interface RawEntry {
  type?: unknown
  /** ★ 条目 id：分支点（`createBranchedSession` 只认它）。 */
  id?: unknown
  timestamp?: unknown
  message?: { role?: unknown; content?: unknown }
}

/**
 * 把 Pi 的会话条目投影成可显示的问答（**纯函数**，不碰文件系统）。
 *
 * Pi 的 `getEntries()` 返回的是一串**条目**（`message` / `model_change` /
 * `thinking_level_change` / `custom_message` …），而不是「一问一答」。
 * 这里只挑 `type === 'message'` 且角色是 user/assistant 的，把 content 里的
 * **文本块**抽出来拼成正文。
 *
 * ★ **为什么只取 text 块**：assistant 的 content 里还有 `thinking`（思考）与
 *   `toolCall`（工具调用）两种块。思考过程是模型内部推理，工具参数可能含题干/答案；
 *   回看历史对话**不需要**它们，且把它们显示出来会泄漏不该给学生看的内容。
 *
 * @param entries Pi 的条目数组（`unknown[]`：这里做结构检查，不信任任何字段）
 * @param limit 最多回传多少条（超出部分丢弃，返回 `truncated` 计数）
 */
export function projectTranscript(
  entries: unknown[],
  options: { limit?: number } = {}
): { messages: TranscriptMessage[]; truncated: number } {
  const limit = options.limit ?? MAX_TRANSCRIPT_MESSAGES
  const messages: TranscriptMessage[] = []
  /** 还没挂到消息上的卡片条目（见 {@link attachCards}）。 */
  const pendingCards: PendingCards[] = []
  for (const entry of entries) {
    // ★ `k12.cards` 这类 `custom` 条目**不是对话**：只把卡片收下，绝不产生可见消息 ——
    //   产出的话，回看里会多出一条没有正文的空白问答。
    const cards = readCardsEntry(entry)
    if (cards !== null) {
      pendingCards.push({ ...cards, afterMessageIndex: messages.length })
      continue
    }
    const projected = projectEntry(entry)
    if (projected) messages.push(projected)
  }
  attachCards(messages, pendingCards)
  if (messages.length <= limit) return { messages, truncated: 0 }
  // ★ 保留**最近**的 limit 条（学生回看通常关心最后聊了什么）
  return { messages: messages.slice(messages.length - limit), truncated: messages.length - limit }
}

/** 单条 entry → 一条可显示消息（认不出返回 `null`）。 */
function projectEntry(entry: unknown): TranscriptMessage | null {
  if (typeof entry !== 'object' || entry === null) return null
  const raw = entry as RawEntry
  if (raw.type !== 'message') return null
  const message = raw.message
  if (typeof message !== 'object' || message === null) return null
  const role = message.role
  if (role !== 'user' && role !== 'assistant') return null
  const text = extractText(message.content)
  if (!text) return null
  const openingKp = readOpeningKp(message)
  return {
    role,
    text,
    at: toMs(typeof raw.timestamp === 'string' ? raw.timestamp : undefined),
    // ★ 缺 id 的条目用空串（老版本会话或手改过的文件）：空 id 会在分支时被挡住，
    //   而不是拿一个 `undefined` 去问 Pi（那会抛 `Entry undefined not found`）。
    entryId: typeof raw.id === 'string' ? raw.id : '',
    entryType: raw.type,
    ...(openingKp === null ? {} : { openingKp })
  }
}

/** `custom` 条目里那份卡片载荷的 `customType`（写入口在 `runtime.ts` 的 `persistTurnCards`）。 */
const CARDS_CUSTOM_TYPE = 'k12.cards'

/**
 * 卡片 `kind` 的白名单（**读回历史时的独立判据**）。
 *
 * ★ 为什么不 import 主进程那张 Tool→kind 映射表：架构守卫 G10 钉着「那张表的名字
 *   只能出现在它自己的文件里」（连注释里提到都算违规）—— 这里改为从**契约类型**
 *   直接展开，效果等价，且不新增一条跨模块依赖。
 * ★ 用 Record 而不是数组是刻意的：契约以后新增一个 kind，这里会因为**缺键**
 *   当场编译不过 —— 把「忘了同步」从「界面静默少一张卡」变成红的。
 */
const KNOWN_PAYLOAD_KIND_FLAGS: Record<PayloadKind, true> = {
  animation: true,
  coding: true,
  quiz: true
}
const KNOWN_PAYLOAD_KINDS: ReadonlySet<string> = new Set(Object.keys(KNOWN_PAYLOAD_KIND_FLAGS))

/** 一条待挂载的卡片条目。 */
interface PendingCards {
  /** 写入口记下的助手条目 id；缺 / 认不出时是空串（那时退回位置判据）。 */
  entryId: string
  cards: Array<{ kind: PayloadKind; payload: unknown }>
  /** 这条 `custom` 条目出现时**已经投影出**的消息条数（= 它后面那条消息的下标）。 */
  afterMessageIndex: number
}

/** `custom` 条目的结构（只读我们关心的三个字段，其余一律不信任）。 */
interface RawCustomEntry {
  type?: unknown
  customType?: unknown
  data?: unknown
}

/**
 * 一条 `custom` 条目 → 卡片清单（认不出 / 结构不对 / 一张有效卡都没有 → `null`）。
 *
 * ★ 判据**窄**：只认 `customType === 'k12.cards'`；`cards` 必须是数组；每一项的 `kind`
 *   必须在白名单里、`payload` 必须是对象。任何一条不满足就**跳过它** —— 宁可少一张卡，
 *   也不要往界面塞一张渲染不出来的空卡（与渲染侧 `restoredCards` 同一个口径）。
 */
function readCardsEntry(
  entry: unknown
): { entryId: string; cards: Array<{ kind: PayloadKind; payload: unknown }> } | null {
  if (typeof entry !== 'object' || entry === null) return null
  const raw = entry as RawCustomEntry
  if (raw.type !== 'custom' || raw.customType !== CARDS_CUSTOM_TYPE) return null
  if (typeof raw.data !== 'object' || raw.data === null) return null
  const data = raw.data as { entryId?: unknown; cards?: unknown }
  const cards = readCardList(data.cards)
  if (cards.length === 0) return null
  return { entryId: typeof data.entryId === 'string' ? data.entryId : '', cards }
}

/** 卡片数组的结构检查（窄判据见 {@link readCardsEntry}）。 */
function readCardList(value: unknown): Array<{ kind: PayloadKind; payload: unknown }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ kind: PayloadKind; payload: unknown }> = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { kind?: unknown; payload?: unknown }
    if (typeof record.kind !== 'string' || !KNOWN_PAYLOAD_KINDS.has(record.kind)) continue
    if (typeof record.payload !== 'object' || record.payload === null) continue
    out.push({ kind: record.kind as PayloadKind, payload: record.payload })
  }
  return out
}

/**
 * 把卡片挂到对应的**助手消息**上（就地改 `messages`）。
 *
 * ★ 主判据是 `entryId` 精确匹配（写入口落的就是它）—— **不按顺序猜**：Pi 的条目流里
 *   混着 `model_change` / `thinking_level_change` / 开场引导，失败或被拦下的轮次也不留
 *   助手条目，「第几条」会漂。
 * ★ 兜底：写入口认不出助手条目时**不编** id，那时才用「这条 `custom` 之前最近的一条
 *   助手消息」—— 诚实地说这是位置判据，只在同一条会话的同一段里成立。
 */
function attachCards(messages: TranscriptMessage[], pending: readonly PendingCards[]): void {
  for (const item of pending) {
    let index = -1
    if (item.entryId !== '') {
      index = messages.findIndex((message) => message.entryId !== '' && message.entryId === item.entryId)
    }
    if (index < 0) {
      const before = item.afterMessageIndex - 1
      if (before >= 0 && messages[before]?.role === 'assistant') index = before
    }
    const target = index >= 0 ? messages[index] : undefined
    if (!target || target.role !== 'assistant') continue
    // ★ 同一条助手消息可能有多批卡片（分次写入）：**合并**而不是互相覆盖。
    target.cards = [...(target.cards ?? []), ...item.cards]
  }
}

/**
 * 读开场白那条消息里附带的**目标知识点**（`k12Opening`）。
 *
 * ★ 结构检查、不信任任何字段：`kpId` 必须是非空字符串，`kpName` 缺了就空串
 *   （界面在名字为空时退回含糊说法，绝不把 slug 印给学生）。
 * ★ 认不出就返回 `null` —— 这是「老会话 / 手改过的文件」的正常形态，
 *   调用方据此退回逐字判据，而不是拿半个元数据去猜。
 */
function readOpeningKp(message: Record<string, unknown>): { kpId: string; kpName: string } | null {
  const raw = message['k12Opening']
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const kpId = typeof record['kpId'] === 'string' ? record['kpId'].trim() : ''
  const kpName = typeof record['kpName'] === 'string' ? record['kpName'].trim() : ''
  return kpId === '' ? null : { kpId, kpName }
}

/** 从 message.content 里抽纯文本（字符串直取；数组只取 `type === 'text'` 的块）。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n').trim()
}

/**
 * 在会话列表里按 id 找一条（**白名单对齐**，纯函数）。
 *
 * ★ 这是「只接受 id」那条安全约束的落点：`readTranscript` 拿到 id 后**必须**先过这里，
 *   拿到的 `path` 由 Pi 提供（而不是前端给的字符串）。
 * ★ 泛型只为**参数放宽**：调用方传 `SessionInfo[]` 拿到的仍是 `SessionInfo | null`，
 *   而删除判据（只需要 id + path）可以在测试里造两条最小数据就调用它。
 */
export function findSessionById<T extends { id: string }>(infos: readonly T[], id: string): T | null {
  return infos.find((info) => info.id === id) ?? null
}

/**
 * ★★ **删除一条会话前的两道防线**（纯函数；`session:delete` 的唯一判据实现）。
 *
 * 为什么必须收口成一个纯函数、而不是写在 `handlers.ts` 的处理器里：
 *   这是全项目**唯一一处破坏性文件操作**（`unlink`），而它的安全判据必须能被
 *   `node --test` 直接测 —— 处理器里那句 `await unlink(...)` 是不可单测的
 *   （它会真的删文件），判据本身却是纯的。分开之后：判据有单测与负向对照，
 *   副作用留在处理器里，只有一行。
 *
 * 两道防线（缺一不可）：
 *   ① **白名单对齐**：`id` 必须在 `SessionManager.list()` 的结果里 ——
 *      拿到的 `path` 是 **Pi 自己给的**，渲染进程递进来的字符串永远只是 id；
 *   ② **目录包含**：那条 `path` 必须落在**当前学生**的 `sessionDir` 内
 *      （`isInside`）。单靠 ① 不够：列表是「当下的观测」，而路径是字符串 ——
 *      这一条挡的是「有人绕过调用方，直接拿一个手造的 `info` 进来」。
 *
 * ★ 「找不到这条」按**幂等成功**回（`path: null`，什么都不删）：目标状态已经达成
 *   （另一处删过 / 上次删到一半）。把它报成失败只会让学生反复重试一条不存在的会话。
 * ⚠️ 也因此**不区分**「id 打错了」与「别的学生的 id」：两者在这里同形，
 *   而唯一能造成的后果都是「什么都没删」。
 */
export type SessionDeletionTarget =
  | { ok: true; path: string | null }
  | { ok: false; message: string }

/**
 * 删除判据只需要 `id` 与 `path` 两个字段 —— 不必是完整的 `SessionInfo`。
 *
 * ★ 这样写是为了让判据**真的可单测**（造两条最小数据就能跑一遍两道防线），
 *   而生产路径传进来的就是 Pi 的 `SessionInfo[]`（结构上多几个字段，照样满足它）。
 */
export interface DeletionCandidate {
  id: string
  path: string
}

export function resolveDeletionTarget(options: {
  infos: readonly DeletionCandidate[]
  id: string
  sessionDir: string
}): SessionDeletionTarget {
  const id = options.id.trim()
  if (!id) return { ok: false, message: '删除失败：没有给出会话 id。' }
  const info = findSessionById(options.infos, id)
  if (!info) return { ok: true, path: null }
  if (!isInside(options.sessionDir, info.path)) {
    return {
      ok: false,
      message: '删除失败：这条对话不在当前学生的会话目录里（已拒绝）。'
    }
  }
  return { ok: true, path: info.path }
}

/**
 * 会话搜索（**纯函数**）：在标题与全文里找关键词。
 *
 * `allMessagesText` 是 Pi 已经提供的全文字段（无需我们遍历 JSONL），
 * 这里只做匹配与片段提取。
 *
 * ★ 返回**片段**而不是整段全文：命中的位置前后各取一段（像 grep 的上下文），
 *   否则一个长会话会把整篇正文塞进搜索结果里。
 */
export interface SessionSearchHit {
  id: string
  title: string
  /** 命中处周围的片段（已截断） */
  snippet: string
  modifiedAt: number
}

/** 片段长度上限（命中位置前后各取多少字符）。 */
export const SNIPPET_CONTEXT_CHARS = 30

export function searchSessions(
  infos: SessionInfo[],
  query: string,
  options: { limit?: number } = {}
): SessionSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const limit = options.limit ?? 20
  const hits: SessionSearchHit[] = []
  for (const info of infos) {
    const haystack = `${info.name ?? ''}\n${info.allMessagesText ?? ''}`
    const at = haystack.toLowerCase().indexOf(needle)
    if (at < 0) continue
    hits.push({
      id: info.id,
      // 与列表标题同一条投影（搜索结果里同样不该出现机器标记）。
      title: sessionTitleFrom(info.name, info.firstMessage),
      snippet: snippetAround(haystack, at, needle.length),
      modifiedAt: toMs(info.modified)
    })
  }
  return hits.sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id)).slice(0, limit)
}

/** 抽命中处前后的片段（把换行压成空格，便于单行显示）。 */
function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT_CHARS)
  const end = Math.min(text.length, at + length + SNIPPET_CONTEXT_CHARS)
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${slice}${suffix}`
}

/* ------------------------------------------------------------------ *
 * 需要真的去问 Pi 的两个函数（**本文件里唯一碰文件系统/Pi 的地方**）
 *
 * ★ 为什么用动态 import：`@earendil-works/pi-coding-agent` 从包根导入会 evaluate CLI 的
 *   `main.js`（拖入 esbuild，见 AGENTS §8.2）。虽然主进程本来就会加载 Pi，
 *   但这两个函数**只属于「学习档案」这一条支线** —— 推迟到真的点开会话列表那一刻，
 *   能让「应用启动 → 对话」这条主路径完全不依赖这条支线（也让纯函数测试不必加载 Pi）。
 *   与 `extensions/profile.ts` 的调用点动态 import 同一手法。
 * ------------------------------------------------------------------ */

/**
 * 列出某学生的历史会话（**只读**）。
 *
 * ★ `sessionDir` **必须显式传**（第二个参数）：漏传的话 Pi 会静默退回
 *   `~/.pi/agent/sessions/--<cwd>--/` —— 那是**用户自己 Pi CLI 的目录**，
 *   既读到了不该读的东西，也让跨学生隔离失效。这里用 `resolveStudentPiPaths`
 *   拼出该学生自己的目录（与其他地方共用同一个拼装点，守卫 G9-6c 会扫「别处手写 students 目录」）。
 */
export async function listStudentSessions(
  userDataDir: string,
  studentId: string
): Promise<SessionInfo[]> {
  const { piSessionCwd, resolveStudentPiPaths } = await import('../agent/pi-paths.ts')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const paths = resolveStudentPiPaths(userDataDir, studentId)
  // ★★ cwd 必须与**建会话时那个**逐字相同，否则列表恒为空（见 `piSessionCwd` 的注释：
  //    Pi 在传了自定义 sessionDir 时会**额外按 cwd 过滤**，而它不报错、不告警）。
  //    ⚠️ 历史注释曾写「第一个参数只用于推导默认目录，第二个参数给了就以它为准」——
  //      那句话是**错的**（实测 P-102）：cwd 从「只是推导用」变成了**过滤器**。
  return await SessionManager.list(piSessionCwd(paths), paths.sessionDir)
}

/**
 * 按**白名单里的那条 `SessionInfo`** 读出它的条目（**只读**）。
 *
 * ★★ `info.path` 必须来自 `listStudentSessions()` 的返回（见文件头安全约束 1）：
 *   渲染进程只能给 id，path 由 Pi 提供。这一点由调用方（`handlers.ts`）保证 ——
 *   它先 `findSessionById` 对齐白名单，再把 `info` 传进来。
 * ★ 这里再**复核一次**路径确实落在该学生的会话目录内：单靠调用方守规矩不够，
 *   这个函数自己也要能挡住「有人直接在别处传了个路径进来」。
 */
export async function readStudentSessionEntries(
  userDataDir: string,
  studentId: string,
  info: { path: string }
): Promise<unknown[]> {
  const { isInside, resolveStudentPiPaths } = await import('../agent/pi-paths.ts')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const paths = resolveStudentPiPaths(userDataDir, studentId)
  if (!isInside(paths.sessionDir, info.path)) {
    throw new Error(
      `拒绝读取学生会话目录之外的文件（${info.path} 不在 ${paths.sessionDir} 内）`
    )
  }
  const manager = SessionManager.open(info.path, paths.sessionDir, paths.studentDir)
  return manager.getEntries()
}
