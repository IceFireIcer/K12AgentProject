# 05 — IPC 事件通道 + preload 白名单

**What to build:** 打通「主进程 → 渲染进程」的 IPC 事件流：通道名单一来源、preload 白名单、6 事件载荷类型、`requestId` 贯穿一轮、Tool 名 → `kind` 映射表，并先用**假数据源**把端到端链路验通（不接 Pi、不接 LLM）。为什么在这个顺序：06（对话贯通）只是把假数据源换成 Pi 的 `message_update`；通道与载荷先冻结，换数据源时才不会连带动 UI。**传输层是 IPC，不存在 SSE。**

**Blocked by:** 04 契约冻结 + OpenAPI→TS 防漂移链

**Status:** ready-for-human

- [x] `desktop/src/main/ipc/channels.ts` 是**通道名单一来源**（常量导出，禁止在 handlers / preload / renderer 里散落字符串字面量）；守卫测试断言全仓只有这一处声明通道名
- [x] `desktop/src/preload/index.ts` 用 `contextBridge` 暴露**白名单方法**，不暴露 `ipcRenderer` 本身；`preload/index.d.ts` 同步类型；窗口保持 `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`
- [x] **渲染进程不直连 sidecar 的 HTTP**：主进程是 sidecar 的唯一 HTTP 客户端（`bridge/client.ts`），token 永不进入渲染进程——由此「CORS 401 被伪装成 `TypeError: Failed to fetch`」整类故障消失；架构守卫断言 `desktop/src/renderer/**` 无 `fetch(` 指向 `/api` 的调用、无 `X-Auth-Token` 字符串
- [x] `desktop/src/shared/ipc-events.ts` 定义 6 事件载荷类型，字段与契约逐字一致：`delta{requestId,delta}`、`citation{requestId,citations[]}`、`payload{requestId,kind,payload}`、`blocked{requestId,reason,safeText}`、`done{requestId,messageId}`、`error{requestId,message,degraded}`
- [x] `requestId` 由主进程生成并**贯穿一轮**（首个事件到 `done`/`error` 全部带同一个 `requestId`）；`done` 带 `messageId`；渲染进程按 `requestId` 分派，旧轮事件不得污染新轮
- [x] `TOOL_TO_KIND`（`animation | coding | quiz` 三类）落在单一文件：`generate_animation→animation`；`get_code_template` / `get_coding_hint` / `evaluate_code→coding`；`generate_quiz` / `submit_quiz` / `generate_variants→quiz`。守卫断言**这 7 个已在表内**，且 `get_student_profile` / `rag_search` **明确不在表内**（它们不发 `payload`）
- [x] 用假数据源跑通端到端：主进程循环发 6 种事件 → `desktop/src/renderer/src/api/events.ts` 订阅并分发（**只是订阅回调，没有解析层**）→ 页面可见（含 `kind` 分派到不同卡片占位）
- [x] 中文跨 chunk 不乱码：把一段中文按 1 字/次拆成多个 `delta` 发出，页面拼接结果与原文**逐字相等**（验证 UTF-8 边界不断字）
- [x] `desktop/tests/agent-events.test.ts`：事件分发为纯函数并可单测，覆盖未知 `kind`、缺字段、乱序 `requestId` 三种容错（不得抛异常到 UI）
- [x] `npm run typecheck` + `node --test` 全绿；提交一次，报告素材记一条「为什么用 IPC 而不是 HTTP + SSE / postMessage」

## 进度

### ✅ 完成

- 通道名单一来源（守卫断言 `src/` 下除 `channels.ts` 外不得出现通道字面量）
- `requestId` 由主进程生成并注入每个事件 → 调用方**无法**张冠李戴；
  窗口销毁/回合结束后的事件直接丢弃；监听器随窗口销毁清理（不泄漏）
- preload 恰好 4 个方法、**无 `ipcRenderer` 透传**、**token 不出现于任何渲染侧**
- `renderer/api/events.ts` 是**订阅回调 + 纯 reducer**：本项目没有 SSE，
  不需要分帧/`TextDecoder`（守卫断言渲染侧不得出现 `TextDecoder`）
- 6 事件各有明确渲染语义；`blocked` 撤回并替换 safeText；`error` 给可读降级提示
- 架构守卫扩到 14 条，**全部正向断言**

**CDP 读真实 DOM 证据**：`delta` 长度 `0→8→16→…→126`（真逐片到达，非一次插入）；
citation chips 2；三种内联卡片各 1；`blocked` 撤回成功；`body.innerText` **无 U+FFFD**；
含扩展区汉字（𠀀）的探针串字节级往返一致；渲染进程内 `require`/`process`/`Buffer` 均不可见。

> 当前数据源是**明确标注的桩**（`stub-chat.ts`），票 06 换成 Pi 真流；`handlers.ts` 里只有
> 一个调用点需要替换，preload 与 UI 不用动。

