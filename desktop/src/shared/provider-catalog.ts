/**
 * 设置页「供应商预设 / 拉取模型」两个能力的**跨进程类型**（主进程与渲染进程共用）。
 *
 * ★ 为什么这两个类型**不进 pydantic 契约**：它们是 Pi（TypeScript 包）自带的 provider
 *   目录形状 —— **Python 侧根本不存在这份数据**，只有主进程能加载 Pi 读到它。
 *   往 `server/app/contracts.py` 里塞一份 TS 独有的形状，等于给「pydantic 是唯一契约来源」
 *   这条规则开一个破口（那样 TS 也能「凭需要造契约」，防漂移链就废了）。
 *
 * 放在 `shared/` 而不是 `main/ipc/channels.ts`：渲染进程要 import 这两个类型，
 * 而它**不该** import 主进程模块（会把 IPC 常量一起拖进渲染包）。
 * `shared/ipc-events.ts`（6 事件词表）用的就是同一条安排。
 *
 * 两条纪律：
 *   - 这些类型只承载**界面展示用的候选清单**，不参与持久化、不参与任何业务判定；
 *   - ★ 里面**不允许**出现任何凭证字段（Key / token）。有架构守卫（G13）盯着这条。
 */

/** Pi 内置供应商预设里的一项（设置页「供应商预设」下拉的数据源）。 */
export interface ProviderCatalogEntry {
  /** Pi 的 provider id（写进设置的 `providerId`）。 */
  id: string
  /** 显示名（Pi 目录里的 name）。 */
  name: string
  /** 该 provider 的内置端点（`null` = Pi 目录没给，需用户自填）。 */
  baseUrl: string | null
  /** 该 provider 的内置模型清单（顺序即 Pi 目录顺序）。 */
  models: Array<{ id: string; name: string }>
}

/**
 * 「拉取模型」的回执。
 *
 * ★ 两个来源**分开给**（而不是只给一个合并结果）：界面要能如实标注候选是从哪来的 ——
 * 「Pi 内置目录里的」意味着兼容性有保障，「端点实时拉的」意味着该服务确实有这个模型。
 * 合成一份会让界面失去这个区分能力（而它正是用户判断「该选哪个」的依据）。
 */
export interface FetchModelsResult {
  /** 端点实时拉取是否成功（`false` 时 `preset` 仍然可用 —— 不是「全有或全无」）。 */
  ok: boolean
  /** 可读结论（成功条数 / 失败原因）。 */
  message: string
  /** 端点实时拉到的模型 id（去重后）。 */
  endpoint: string[]
  /** Pi 内置预设里该 provider 的模型 id（去重后）。 */
  preset: string[]
  /** 两者合并去重后的候选（顺序：预设在前；界面直接渲染这一份）。 */
  candidates: string[]
}

/**
 * 合并「Pi 预设」与「端点实时」两份模型候选。
 *
 * ★★ **主进程与渲染进程共用这一份实现**（刻意放在 shared 里）：
 *   - 主进程在 `settings:fetch-models` 里用它产出 `candidates`；
 *   - 渲染进程在切换预设时要**就地重算**（不必再走一轮 IPC）。
 *   两处各写一份的话，规则会悄悄分叉 —— 表现为「界面显示的候选」与
 *   「主进程实际返回的候选」不一致，而两边单测都绿。
 *
 * 规则：**预设在前**（它们带 Pi 已知的完整元数据，选它们兼容性最好），
 * 端点独有项追加在后；两者都按原顺序去重。
 * **不排序** —— 顺序本身就是「推荐程度」的信号（Pi 目录的第一个是官方首选）。
 */
export function mergeModelCandidates(preset: readonly string[], endpoint: readonly string[]): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const id of [...preset, ...endpoint]) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    merged.push(trimmed)
  }
  return merged
}
