# 13 — rag_search Tool 与 citation 事件

**What to build:** 把票 11 在 Python 侧已经跑通的四级降级检索，经 `rag_search` Tool 接进主 Agent：LLM 自主决定何时检索，结果以冻结的 `citation` 事件下发前端。这是「对话 + RAG」主链路的最后一段，也是 §15 演示脚本 2:30–4:00 那一环成立的前提。**降级链一步都不许搬到 TS 侧**——TS 只读 `degraded`，不重新实现一遍向量/FTS/兜底判断。

**Blocked by:** 08（主 Agent + 6 Extension 骨架 + 轨迹导出）、11（RAG 四级降级链，关卡 C）

**Status:** ready-for-agent

- [ ] `rag_search` Tool 已注册，参数用 TypeBox 声明 `{ query: string, gradeLevel: GradeLevel, kpId?: string, topK?: number }`，并纳入 `desktop/scripts/check-tool-schema.mjs` 的一致性断言（与 pydantic 对应请求模型逐字段比对，防静默漂移）
- [ ] 唯一出口：Tool 只经 `desktop/src/main/bridge/client.ts` 调 `POST /api/rag/search`；`grep -rn "X-Auth-Token" desktop/src/main/agent desktop/src/main/bridge` 在 Tool 代码里零命中（token 由客户端统一注入）；`desktop/src/main/agent/` 下不出现第二处 `fetch(` / `axios`
- [ ] `rag_search` **不**登记进 §9.3 冻结的 `TOOL_TO_KIND`——它发 `citation` 事件而不是 `payload`；`grep -n "TOOL_TO_KIND" -A 10` 复查表内仍只有 7 个 Tool
- [ ] `citation` 事件载荷与 §6.4 一字不差：`{requestId, citations:[{chunkId, chapterTitle, sectionTitle, gradeLevel, compat}]}`，camelCase，`requestId` 与同轮的 `delta`/`done` 一致
- [ ] `degraded` 由 TS 原样透传进事件与 `desktop/src/main/agent/trace.ts` 的轨迹记录；`grep -rni "fts5\|vec0\|numpy\|cosine" desktop/src/main` 零命中（降级逻辑不得出现在编排层）
- [ ] **学段不泄漏**：以 `junior` 学生提问一个只存在于高中教材的知识点，返回的每条 citation 都满足 `gradeLevel == "junior"` 或 `compat == true`；该场景写成固定用例（`server/tests/` 或 `desktop/tests/` 内），断言不得出现未标注的 `senior` chunk
- [ ] 向上兼容命中时前端有可见的 `compat` 标注（citation 卡片显示「延伸阅读 · 高年级内容」之类），留一张截图
- [ ] 父块注入生效：命中子 chunk 时进入 LLM 上下文的是**父块正文**（`parent_chunk_id` 已解析），断言 text 明显长于子块、不是碎片
- [ ] `execute()` 自行兜异常：sidecar 未启动 / 返回 500 / 超时 → 返回可读中文错误并发 `error` 事件（`degraded: true`），**不抛出**（Pi 与 UI 同在主进程）
- [ ] 降级演示：把 `server/resources/models/fastembed/` 改名后重启 → 仍能返回 citation 且 `degraded == "fts"`；改回后恢复 `degraded == "vector"`（两条证据各留一次输出）
- [ ] 检索延迟为百毫秒级：本机同一问题跑 20 次，记录 p95（目标 < 500ms），数值写进票尾
- [ ] 工具轨迹里能看到本次检索的 `{turn, toolName:"rag_search", args 摘要, ok, latencyMs, degraded}`，并能在 `docs/tool-trace.mmd` 里体现

## 进度

（在此记录关键决策与踩坑）
