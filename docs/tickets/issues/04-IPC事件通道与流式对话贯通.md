# 04 — IPC 事件通道 + 流式对话贯通

**What to build:** 用户第一次能在真实 UI 里与大模型流式对话。传输层从 S02 的 HTTP + SSE 改为 **IPC 事件流**，但**事件词表一字不改**——前端的解析/分发语义应当能直接复用。

**Blocked by:** 02 — Pi 可加载性 + 最小流式会话

**Status:** ready-for-agent

- [ ] 渲染进程 ↔ 主进程改为 IPC（`ipcRenderer.on` / `webContents.send`），preload 白名单同步更新
- [ ] **6 事件词表保持不变**：`delta | citation | payload | blocked | done | error`
- [ ] 建立事件来源映射：`delta`←`message_update`，`done`←`agent_end`，`error`←provider/Tool 异常或降级
- [ ] `requestId` 由主进程生成并贯穿一轮；`done` 事件带 `messageId`
- [ ] 前端 `delta` 实时渲染，**中文跨 chunk 不乱码**
- [ ] 保留架构守卫测试中的 **`EventSource` 禁用断言**，防止回退到 SSE 时重踩鉴权 header 的坑
- [ ] `npm run typecheck` 通过（契约漂移的第一道防线）

## 进度

（在此记录关键决策与踩坑）
