/**
 * Sidecar 生命周期里的**纯逻辑**：不 import electron、不碰 IO，可直接被 `node --test` 单测
 * （见 `tests/sidecar-protocol.test.ts`）。
 *
 * 票 01 只放「启动命令解析」与本模块共享的状态类型。票 02 在此基础上追加：
 *   - **行缓冲**：Node 的 `data` 事件会把握手 JSON 切成半行，必须缓冲到 `\n` 再 parse；
 *     非 JSON 行只记日志、绝不当错误。
 *   - **握手解析**：Python 绑 `127.0.0.1:0` 由系统分配端口，把 `{"event":"ready","port":N,"pid":P}`
 *     以**单行 JSON** 打到 stdout（stdout 只允许这一行，uvicorn 日志全走 stderr）。
 *   - **端口改造**：命令里的固定端口（`--port 8756`）将被 `--port 0` 取代，端口从握手结果取。
 *   - **重启决策**：非正常退出重启一次，再失败则提示用户并落 `userData/logs/`。
 */

import { join } from 'node:path'

/** 开发态固定端口（执行文档 §7.5：`uv run uvicorn app.main:app --port 8756`）。 */
export const DEV_PORT = 8756

/** 打包态 sidecar 在 `process.resourcesPath` 下的目录名（见 electron-builder.yml 的 extraResources）。 */
export const PACKAGED_SERVER_DIR = 'server'

/** 打包态 sidecar 可执行文件名（PyInstaller `--onedir` 产物）。 */
export const PACKAGED_SERVER_EXE = 'k12-agent-server.exe'

export type SidecarMode = 'dev' | 'packaged'

/** sidecar 生命周期阶段。`starting` 期间 UI 显示启动动画，不允许白屏。 */
export type SidecarPhase = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'

/**
 * 主进程与渲染进程共享的 sidecar 状态。
 * ★ 结构里**没有 token**，也不许加回来：token 只存在于主进程内存中（票 02），
 *   渲染进程只需要知道「几阶段 / 哪个端口 / 什么错」。
 */
export interface SidecarState {
  phase: SidecarPhase
  /** sidecar 监听端口；未启动时为 null。票 02 之后该值来自 stdout 握手。 */
  port: number | null
  /** 子进程 pid；未启动时为 null。 */
  pid: number | null
  mode: SidecarMode
  /** 崩溃重启次数（票 02 使用；票 01 恒为 0）。 */
  restarts: number
  /** 最近一次可读错误（直接展示给学生/开发者，不要塞堆栈）。 */
  lastError: string | null
}

/** 解析启动命令所需的路径。 */
export interface SidecarPaths {
  /** 开发态：仓库内的 `server/` 目录（dev 在该目录下用 `uv run` 启动）。 */
  serverDir: string
  /** 打包态：`process.resourcesPath`。 */
  resourcesPath: string
  /** `--data-dir`：Electron 的 `userData`，`config.json` 与 SQLite 都落这里。 */
  dataDir: string
}

export interface SidecarCommand {
  command: string
  args: string[]
  cwd: string
}

/**
 * 解析 sidecar 的启动命令。
 *
 * - `dev`：`uv run python -m app.main ...`，cwd 指向仓库的 `server/`（本机裸 `python` 不可用，
 *   **一律用 uv**；见 AGENTS.md 第 5.10 条）。
 * - `packaged`：直接跑冻结产物 `<resourcesPath>/server/k12-agent-server.exe`——
 *   终端用户不需要 Python 环境。
 */
export function resolveSidecarCommand(mode: SidecarMode, paths: SidecarPaths): SidecarCommand {
  const commonArgs = ['--host', '127.0.0.1', '--port', String(DEV_PORT), '--data-dir', paths.dataDir]

  if (mode === 'packaged') {
    const serverDir = join(paths.resourcesPath, PACKAGED_SERVER_DIR)
    return {
      command: join(serverDir, PACKAGED_SERVER_EXE),
      args: [...commonArgs],
      cwd: serverDir
    }
  }

  return {
    command: 'uv',
    args: ['run', 'python', '-m', 'app.main', ...commonArgs],
    cwd: paths.serverDir
  }
}

/**
 * `/health` 探活地址。只绑定 `127.0.0.1`（绝不监听外部网卡）。
 * `/health` 允许匿名访问，是探活的唯一入口。
 */
export function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`
}
