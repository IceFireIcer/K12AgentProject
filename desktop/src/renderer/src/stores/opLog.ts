/**
 * 操作日志（Pinia，渲染进程侧旁路）：把「导入教材 / 重建索引 / 读取」这类
 * 一次性操作记成一条可读流水，供置顶日志卡显示与「一键复制」。
 *
 * ★ 为什么放在渲染进程：这是给**操作者当下**看「刚才那步做了什么、花了多久」的，
 *   不是审计留痕。所以刻意不新增 IPC 通道、也不写磁盘 ——
 *   通道名单的唯一来源是主进程侧那份白名单，为一张只读卡片加通道会连带改
 *   preload 暴露面；写盘则要求先想清楚轮转与清理，收益远小于成本。
 *   窗口重启，这里就归零，这是设计而非缺陷。
 *
 * ★ 为什么有 200 条环形上限（OP_LOG_LIMIT）：面板只需要回看最近一段，
 *   无上限会让长时间开着的窗口内存单调上涨。裁剪发生在 push 之后立刻执行，
 *   而不是等渲染时再截 —— 留在 store 里的**永远**不超过上限。
 *
 * ★ 为什么时间升序（最旧在 [0]，最新在末尾）：面板采用「滚到底 = 最新」这一
 *   最符合聊天窗口直觉的锚点。若倒序存放，「自动滚到底」和「复制出来的行序」
 *   两处都要再翻一次，正是最容易翻漏的地方。
 *
 * ★ 纯函数与 store 同文件导出：这些格式化只用 entry 本身、不碰响应式状态，
 *   拆成两个文件会让「显示什么」与「存什么」各漂一半；测试也直接 import 纯函数。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** 日志级别（决定左侧色条与图标，不决定要不要记录）。 */
export type OpLogLevel = 'info' | 'success' | 'warn' | 'error'
/** 记录的操作类别：只有这三类值得占用面板位置。 */
export type OpLogAction = 'import' | 'rebuild' | 'read'

/** 一条日志。`at` 是本地时间戳（毫秒），`durationMs` 为 null 表示「瞬时操作，没有耗时概念」。 */
export interface OpLogEntry {
  id: number
  at: number
  level: OpLogLevel
  action: OpLogAction
  target: string
  detail: string
  durationMs: number | null
}

/** 环形上限：只保留最近 200 条，超出即从最旧一端丢弃。 */
export const OP_LOG_LIMIT = 200

/** 级别的中文标签（复制出去的文本用；界面另配色，不再各写一份中文）。 */
export const LEVEL_LABEL: Record<OpLogLevel, string> = {
  info: '提示',
  success: '成功',
  warn: '警告',
  error: '错误'
}

/** 动作的中文标签（同上，复制与界面共用一份）。 */
export const ACTION_LABEL: Record<OpLogAction, string> = {
  import: '导入教材',
  rebuild: '重建索引',
  read: '读取'
}

/** 两位补零（时分秒共用）。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 裁剪到最近 `limit` 条（默认 OP_LOG_LIMIT）。
 *
 * ★ 总是返回**新数组**：调用方拿它整体替换 store 里的引用，
 *   于是「有没有真的变」由数组身份决定，不必做深比较；
 *   原地 splice 会让 Vue 的依赖追踪在边界情况下漏掉一次更新。
 * ★ limit 为 0（或负数）时结果为「一条都不留」——按「保留最近 N 条」直译，
 *   而不是退化成 slice(-0) 那种「全留下」的意外行为。
 */
export function trimEntries(entries: readonly OpLogEntry[], limit: number = OP_LOG_LIMIT): OpLogEntry[] {
  const cap = Math.max(0, Math.floor(limit))
  if (cap === 0) return []
  if (entries.length <= cap) return entries.slice()
  return entries.slice(entries.length - cap)
}

/** 按级别筛选；`'all'` 表示不筛（同样返回新数组，避免调用方误改 store 里的那份）。 */
export function filterEntries(entries: readonly OpLogEntry[], level: OpLogLevel | 'all'): OpLogEntry[] {
  if (level === 'all') return entries.slice()
  return entries.filter((entry) => entry.level === level)
}

/** 各级别条数。四个键恒在（界面上的「0 条」格子不该因为没数据而消失）。 */
export function countLevels(entries: readonly OpLogEntry[]): Record<OpLogLevel, number> {
  const counts: Record<OpLogLevel, number> = { info: 0, success: 0, warn: 0, error: 0 }
  for (const entry of entries) {
    if (entry && entry.level in counts) counts[entry.level] += 1
  }
  return counts
}

/**
 * 耗时的人类可读形式：不足 1s 用毫秒，超过用一位小数的秒。
 *
 * ★ 拿不到耗时（null / undefined / 负数 / 非有限数）时给空串而不是 '-'：
 *   调用方据此**整段省略**方括号，行里不会出现「[--]」这种占位噪音。
 */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 时间戳 → 本地时区 'HH:mm:ss'（24 小时制，两位补零）。
 *
 * ★ 刻意不用 toLocaleTimeString：它的输出随系统区域设置变（有的区域给 12 小时制
 *   或不同的分隔符），而复制出去的日志要跨机器可比；这里只借用本地时区取值。
 */
export function formatClock(at: number): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/**
 * 复制用的多行文本：一行一条，字段间两个空格，空字段整段省略。
 *
 * 行形状：`HH:mm:ss  级别中文  动作中文  [target]  [detail]  [耗时]`
 * ★ 这里再按 `at` 升序排一次（稳定排序，同刻保持原序）：store 里本来就是升序，
 *   但复制可能发生在筛选之后，排序保证「复制出来的顺序」永远等于「面板上的顺序」。
 * ★ 空串直接过滤掉，而不是留下两个空格：粘到聊天窗口里看不出哪一段是空的，
 *   省掉目标或耗时时不该在行中间留一段空白。
 */
export function formatEntriesForCopy(entries: readonly OpLogEntry[]): string {
  if (entries.length === 0) return ''
  return [...entries]
    .sort((a, b) => a.at - b.at)
    .map((entry) => {
      const parts: string[] = [
        formatClock(entry.at),
        LEVEL_LABEL[entry.level],
        ACTION_LABEL[entry.action]
      ]
      if (entry.target) parts.push(`[${entry.target}]`)
      if (entry.detail) parts.push(`[${entry.detail}]`)
      const duration = formatDuration(entry.durationMs)
      if (duration) parts.push(`[${duration}]`)
      return parts.filter((part) => part.length > 0).join('  ')
    })
    .join('\n')
}

export const useOpLog = defineStore('opLog', () => {
  /** 时间升序：最旧在 [0]，最新在末尾。 */
  const entries = ref<OpLogEntry[]>([])

  /**
   * 单调自增的 id。
   *
   * ★ 放在 store 闭包里而不是从 entries 反推：裁剪会把最旧的挤掉，
   *   反推 max(id)+1 在「刚裁完又 push」时可能撞上已存在的号。
   * ★ clear() 不重置它：清空是「清屏幕」而不是「重开会话」，
   *   清空前后两份复制文本里不该出现同号的两条。
   */
  let nextId = 1

  const counts = computed(() => countLevels(entries.value))
  const total = computed(() => entries.value.length)

  /**
   * 追加一条并返回它。
   *
   * ★ 追加与裁剪在同一步完成：中间不留给调用方「先拿到 201 条」的窗口，
   *   否则界面会闪一下超限的列表。
   * ★ `??` 而非 `||`：at=0、durationMs=0 都是**合法**值（后者正是「秒回」），
   *   用逻辑或会把它们悄悄换成默认值。
   */
  function push(input: {
    level: OpLogLevel
    action: OpLogAction
    target?: string
    detail: string
    durationMs?: number | null
    at?: number
  }): OpLogEntry {
    const entry: OpLogEntry = {
      id: nextId,
      at: input.at ?? Date.now(),
      level: input.level,
      action: input.action,
      target: input.target ?? '',
      detail: input.detail,
      durationMs: input.durationMs ?? null
    }
    nextId += 1
    entries.value = trimEntries([...entries.value, entry], OP_LOG_LIMIT)
    return entry
  }

  /** 清空当前流水（id 继续往前发，见 nextId 的说明）。 */
  function clear(): void {
    entries.value = []
  }

  return { entries, counts, total, push, clear }
})
