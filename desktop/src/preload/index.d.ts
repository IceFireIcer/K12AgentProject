/**
 * 渲染进程侧的类型声明：`window.api` 就是 `src/preload/index.ts` 里那份白名单（`K12Api`）。
 *
 * ★ 两处必须同步：本文件只做「把 `K12Api` 挂到 `Window` 上」这一件事，
 *   方法增删都改 `src/preload/index.ts` 的 `K12Api`，这里**不重复声明**任何方法。
 * ★ 结构里没有 token、没有任何 sidecar HTTP 能力（见 `src/main/ipc/channels.ts` 的注释）。
 */

import type { K12Api } from './index'

declare global {
  interface Window {
    api: K12Api
  }
}
