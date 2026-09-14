/**
 * sidecar 状态契约（main ↔ preload ↔ renderer 共享）。
 *
 * ⚠️ 这是桌面壳内部契约；与后端 HTTP 契约（`server/app/models.py`）是两回事。
 * 后端契约的唯一来源是 pydantic，前端类型由 OpenAPI 生成（S02 建立）。
 */

/** sidecar 生命周期阶段。 */
export type SidecarPhase =
  | 'idle' // 尚未启动
  | 'starting' // 已 spawn，等待握手 JSON
  | 'handshaking' // 收到端口，正在探活
  | 'ready' // /health 通过
  | 'restarting' // 异常退出后重启中
  | 'failed' // 重启后仍失败，或启动超时
  | 'stopped' // 正常退出（应用关闭）

export type SidecarMode = 'dev' | 'packaged'

/** 推给渲染层的 sidecar 快照（全量状态，不是增量事件）。 */
export interface SidecarInfo {
  phase: SidecarPhase
  mode: SidecarMode
  /** 系统分配的端口；未握手成功前为 null。 */
  port: number | null
  pid: number | null
  /** 随机 hex token。渲染层调用 /api/* 时须放在 X-Auth-Token 头里。 */
  token: string
  version: string | null
  /** 后端是否运行在 PyInstaller 打包产物中。 */
  frozen: boolean
  /** 后端 /health 返回的嵌入模型就绪标志。 */
  embedderReady: boolean | null
  dataDir: string
  /** 已发生的自动重启次数。 */
  restarts: number
  /** 面向用户的中文可读错误；无错误为 null。 */
  lastError: string | null
  /**
   * 原始错误原文（进日志、便于排查）。
   * 界面展示请用 `lastError`（已映射为可读文案），原文只在「查看详情」处露出。
   */
  lastErrorDetail: string | null
  /** sidecar stderr 日志文件路径（用于排查）。 */
  logFile: string | null
  /** 是否正在优雅退出（应用关闭中）。 */
  shuttingDown: boolean
  updatedAt: number
}

/** 后端 /health 响应（与 server/app/api/system.py 的 HealthResponse 对应）。 */
export interface HealthPayload {
  status: string
  version: string
  embedder_ready: boolean
  frozen: boolean
  data_dir: string
}
