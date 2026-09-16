# 07 — 主 Agent + 6 个 Extension 骨架 + rag_search→citation

**What to build:** 主 Agent 具备「按需调用工具」的完整骨架——学生提问时，LLM 自主决定要不要调 `rag_search`，命中后引用来源以 `citation` 事件呈现到 UI。本票不追求各模块的教学质量，只要求**骨架、契约、事件链路全部贯通**。

**Blocked by:** 04 — IPC 事件通道 + 流式对话贯通

**Status:** ready-for-agent

- [ ] 六个 Extension 落位：动画 / 编程 / 练习 / 画像 / 学段 / 学习记录
- [ ] Extension 形态为默认工厂 `(pi: ExtensionAPI) => { pi.on(...); pi.registerTool(...) }`；加载器用 jiti，**不臆造 `registerExtension`**
- [ ] 所有 Tool 用 TypeBox 声明参数，并建立与 pydantic 的一致性断言（防静默漂移）
- [ ] Tool 名 → 事件 `kind` 映射表建立且冻结；**新增 Tool 必须同步登记**
- [ ] `rag_search` 经 HTTP 调 Python sidecar，结果映射为 `citation` 事件并在 UI 可见
- [ ] **每个 Tool 的 `execute()` 自己兜异常**，返回可读错误而不抛出（Pi 与 UI 同进程，抛出会同时带走两者）
- [ ] 不设置 `intent` 字段；不引入 `ModuleResult<T>` / `ModuleError` 包装；失败统一走 `error` 事件（带 `degraded`）
- [ ] 引入 `session.dispose()` 并在 `before-quit` 调用，避免 JSONL 半写

## 进度

（在此记录关键决策与踩坑）
