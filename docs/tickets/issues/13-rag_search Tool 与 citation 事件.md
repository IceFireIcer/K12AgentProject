# 13 — rag_search Tool 与 citation 事件

**What to build:** 把票 11 在 Python 侧已经跑通的四级降级检索，经 `rag_search` Tool 接进主 Agent：LLM 自主决定何时检索，结果以冻结的 `citation` 事件下发前端。这是「对话 + RAG」主链路的最后一段，也是 §15 演示脚本 2:30–4:00 那一环成立的前提。**降级链一步都不许搬到 TS 侧**——TS 只读 `degraded`，不重新实现一遍向量/FTS/兜底判断。

**Blocked by:** 08（主 Agent + 6 Extension 骨架 + 轨迹导出）、11（RAG 四级降级链，关卡 C）

**Status:** ready-for-human

- [x] `rag_search` Tool 已注册，参数用 TypeBox 声明 `{ query: string, gradeLevel: GradeLevel, kpId?: string, topK?: number }`，并纳入 `desktop/scripts/check-tool-schema.mjs` 的一致性断言（与 pydantic 对应请求模型逐字段比对，防静默漂移）
- [x] 唯一出口：Tool 只经 `desktop/src/main/bridge/client.ts` 调 `POST /api/rag/search`；`grep -rn "X-Auth-Token" desktop/src/main/agent desktop/src/main/bridge` 在 Tool 代码里零命中（token 由客户端统一注入）；`desktop/src/main/agent/` 下不出现第二处 `fetch(` / `axios`
- [x] `rag_search` **不**登记进 §9.3 冻结的 `TOOL_TO_KIND`——它发 `citation` 事件而不是 `payload`；`grep -n "TOOL_TO_KIND" -A 10` 复查表内仍只有 7 个 Tool
- [x] `citation` 事件载荷与 §6.4 一字不差：`{requestId, citations:[{chunkId, chapterTitle, sectionTitle, gradeLevel, compat}]}`，camelCase，`requestId` 与同轮的 `delta`/`done` 一致
- [x] `degraded` 由 TS 原样透传进事件与 `desktop/src/main/agent/trace.ts` 的轨迹记录；`grep -rni "fts5\|vec0\|numpy\|cosine" desktop/src/main` 零命中（降级逻辑不得出现在编排层）
- [x] **学段不泄漏**：以 `junior` 学生提问一个只存在于高中教材的知识点，返回的每条 citation 都满足 `gradeLevel == "junior"` 或 `compat == true`；该场景写成固定用例（`server/tests/` 或 `desktop/tests/` 内），断言不得出现未标注的 `senior` chunk
- [ ] 向上兼容命中时前端有可见的 `compat` 标注（citation 卡片显示「延伸阅读 · 高年级内容」之类），留一张截图——**未完成：无截图**（`compat` 字段已透传到事件载荷，渲染标注未单独留证）
- [x] 父块注入生效：命中子 chunk 时进入 LLM 上下文的是**父块正文**（`parent_chunk_id` 已解析），断言 text 明显长于子块、不是碎片
- [x] `execute()` 自行兜异常：sidecar 未启动 / 返回 500 / 超时 → 返回可读中文错误并发 `error` 事件（`degraded: true`），**不抛出**（Pi 与 UI 同在主进程）
- [x] 降级演示：把 `server/resources/models/fastembed/` 改名后重启 → 仍能返回 citation 且 `degraded == "fts"`；改回后恢复 `degraded == "vector"`（两条证据各留一次输出）
- [x] 检索延迟为百毫秒级：本机同一问题跑 20 次，记录 p95（目标 < 500ms），数值写进票尾
- [x] 工具轨迹里能看到本次检索的 `{turn, toolName:"rag_search", args 摘要, ok, latencyMs, degraded}`，并能在 `docs/tool-trace.mmd` 里体现

## 进度

### ✅ 已交付（提交 `b72fa90`）

`rag_search` 经 `desktop/src/main/bridge/client.ts`（唯一的 HTTP 客户端）调 `POST /api/rag/search`：
**TS 侧不重新实现降级链**，只把结果里的 `degraded` **原样透传**（`extensions/rag-search.ts` 文件头第 1 条明确写了「不判断、不排序、不重试降级」）；
认不出的 `degraded` 值按**最弱的一档** `outline` 处理（宁可说得保守）。
citation 只投影冻结的 5 个字段 `{chunkId, chapterTitle, sectionTitle, gradeLevel, compat}`，
认不准的条目**直接丢掉**，不给前端猜一个学段标签。

★ **实测：20 次真实 `rag_search` 调用的 p95 = 39 ms**（同一问题重复提问）。

★ **学段隔离经编排层验证**：`resolveGradeLevel()` 里**会话学段为权威**，
模型填的 `gradeLevel` 只可能被用来「确认」、**永远不会覆盖会话值**。
实测：即便模型「说谎」把 `gradeLevel` 填成 `senior`，初中生的会话也**拿不到任何 senior citation**
（Python 侧 SQL 过滤是第二道，见票 11）。

`rag_search` 断言**不在** `TOOL_TO_KIND` 内（它发 `citation` 而非 `payload`），守卫 G10 覆盖。

### 2026-09-26 补：引用区**默认收起**（用户设计裁决，D-097）

真机上暴露的问题：一次检索常常回来 3～5 条引用，每条「小节 + 出处 + 节级摘录」三行，
**立刻铺开**时一次插入 376～663px，把学生要读的正文压到屏幕下方（引用往往先于正文到达）。

改法：引用区换成**原生 `<details>` / `<summary>`**，摘要行写「这段话参考了这些地方 · N 段」，
点开才出现章节胶囊与「原文」书目；列表、摘录、原文抽屉、`citation-sources` 的条数**一个都没动**
（体检脚本仍按它判「引用渲染出来了没」）。

★ **「向上兼容」标注留在收起态**：跨学段取用必须显式标注（§6.4 / 陷阱清单 §2），而收起是默认态 ——
标注跟着一起藏起来等于没有。所以摘要行有自己的角标（`citation-compat-summary`），展开后每条的
`citation-compat` 仍在（那一层回答的是「哪一条」）。上面那条「留一张截图」的验收**仍未完成**
（本次只保证收起态可见，不补截图）。

守卫：`desktop/tests/citation-collapse.test.ts` 5 条（默认不带 `open` / `:open`、`summary` 带 `.k12-tap`、
收起态角标、条目一条不少、原文链路未断）+ 变异 69；真机证据由 `scripts/verify-ui.mjs` 的 F2 节提供
（注入 5 条引用的 `citation` 事件 → 真实 DOM 量收起高度 ≤ 40px、点开条目一条不少、抽屉打得开）。
