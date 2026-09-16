/**
 * Pi 运行时的**三处目录隔离**（票 03；执行文档 §9.4 第 2 条、风险 #18）。
 *
 * Pi 的默认行为：
 *   - `getAgentDir()`           → `~/.pi/agent`      （用户自己 Pi CLI 的配置目录！）
 *   - `SessionManager.create()` → `~/.pi/agent/sessions/<encoded-cwd>/`
 * 直接用默认值会**读写用户全局 Pi 配置**，且把学生对话写进全局目录 —— 既是跨学生数据混放
 * （合规硬伤），也会污染用户自己的 Pi CLI。
 *
 * 本文件的职责：把三个入口全部钉死在**本应用自己的** `<userData>/pi-agent/` 内：
 *   - `ModelRuntime.create({ authPath, modelsPath })`
 *   - `DefaultResourceLoader({ agentDir })`
 *   - `SessionManager.create(cwd, sessionDir)`
 *
 * ⚠️ 票 09 会把 `agentDir` / `sessionDir` 再下沉到 `students/<id>/pi-agent/`（一人一份）；
 *    本文件是那一层的**唯一入口**，届时只改这里，不要在别处拼路径。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 本应用在 `<userData>` 下的 Pi 根目录名（不是 `~/.pi`）。 */
export const PI_APP_DIR_NAME = 'pi-agent'

export interface PiPaths {
  /** `<userData>/pi-agent` —— 本应用 Pi 数据的根，**唯一允许被写入的目录**。 */
  root: string
  /** `agentDir`：Pi 的全局配置目录（settings.json / skills / prompts / tools 都在这里）。 */
  agentDir: string
  /** `authPath`：API Key 落盘位置（只存本应用自己的 Key，绝不碰用户全局 `auth.json`）。 */
  authPath: string
  /** `modelsPath`：自定义 provider / BaseURL / ModelID 的配置文件（赛题硬要求）。 */
  modelsPath: string
  /** `sessionDir`：Pi JSONL 会话树落盘位置（一人一份，票 09 下沉到学生目录）。 */
  sessionDir: string
  /** system prompt 落盘检查用的目录（冒烟证据，仅供排查）。 */
  logDir: string
}

/**
 * 由 Electron 的 `app.getPath('userData')` 推导出全部 Pi 路径。
 * **不接受任何默认值**：调用方必须显式给 userDataDir，避免有人图省事退回 `~/.pi`。
 */
export function resolvePiPaths(userDataDir: string): PiPaths {
  if (!userDataDir) {
    throw new Error('resolvePiPaths: userDataDir 不能为空（禁止回退到 ~/.pi）')
  }
  const root = join(userDataDir, PI_APP_DIR_NAME)
  const agentDir = join(root, 'agent')
  return {
    root,
    agentDir,
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    sessionDir: join(root, 'sessions'),
    logDir: join(root, 'logs')
  }
}

/** 建目录（幂等）。只允许建在 `paths.root` 之内 —— 越界直接抛，防止误改全局目录。 */
export function ensurePiDirs(paths: PiPaths): void {
  for (const dir of [paths.root, paths.agentDir, paths.sessionDir, paths.logDir]) {
    if (!dir.startsWith(paths.root)) {
      throw new Error(`ensurePiDirs: 拒绝在 Pi 根目录之外创建目录：${dir}`)
    }
    mkdirSync(dir, { recursive: true })
  }
}
