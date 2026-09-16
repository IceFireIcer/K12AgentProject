# 08 — 主 Agent + 6 Extension 骨架 + 轨迹导出

**What to build:** 把「主 Agent + 6 个 Extension + 9 个 Tool」的骨架一次落位（Tool 允许返回占位 payload，真正的动画/编程/练习实现归 14–19），并把**工具调用轨迹导出**做出来。为什么在这个顺序：06 已验通「LLM 流式对话 + 每轮 prompt 注入」，本票在同一底座上把能力注册表立起来，之后 14/16/18/22 才能各自挂在独立的 Extension 上并行做；轨迹图是「设计合理性 25%」的唯一证据形态，**D4 就要产出，别拖到 D14**。

**Blocked by:** 06 对话贯通 + 学段 Prompt 注入

**Status:** ready-for-human

- [x] 6 个 Extension 落 `desktop/src/main/agent/extensions/`：`animation.ts` / `coding.ts` / `quiz.ts` / `profile.ts` / `grade.ts` / `learning-log.ts`；每个导出**默认工厂** `(pi: ExtensionAPI) => { pi.on(...); pi.registerTool(...) }`（**不存在 `registerExtension`，也不是插件清单**）
- [x] 9 个冻结 Tool 名全部注册（字面量不得改动）：`generate_animation`；`get_code_template` / `get_coding_hint` / `evaluate_code`；`generate_quiz` / `submit_quiz` / `generate_variants`；`get_student_profile`；`rag_search`；参数用 TypeBox `TSchema` 声明
- [x] `desktop/scripts/check-tool-schema.mjs`：把每个 Tool 的 TypeBox → JSON Schema 与 `contracts.py` 导出的 JSON Schema 做**一致性断言**，不一致非零退出（npm script `check:tool-schema`，纳入常驻守卫）；**不许出现「pydantic 改了、Tool 参数没改」的静默漂移**
- [x] 所有 Tool 的 `execute()` 自己兜异常并返回可读错误，**绝不抛出**（`tool_execution_end` 是只读通知，也不能指望事件回写结果）；重试类逻辑一律写在 `execute()` 内部
- [x] `grade.ts` 用 `before_agent_start` 注入学段（形态在 06 已验，此处登记为 Extension）；`input`（可返回 `{action:"continue"|"transform"|"handled"}`）与 `tool_call`（可 `{block, reason, terminate}` 并原地改 `event.input`）两个 hook 留好落点注释——它们是 Tool 级安全阀与 22 的接入位
- [x] `learning-log.ts` 只订阅 `tool_execution_end` 与 `agent_end`（**不是 `session_end`，Pi 无此事件**）；本票只做日志与内存记录，落库归 09
- [x] **不自建事件总线**（Pi 原生 34 个事件已够，`ModuleEvents` 是重复抽象）；守卫断言仓内无自建 bus 模块
- [x] Tool 返回占位 payload 也**必须经 `payload` 事件出到前端**且 `kind` 正确（`animation` / `coding` / `quiz`）；守卫断言 `TOOL_TO_KIND` 覆盖全部 7 个 payload 类 Tool，且映射表与 `events.ts` 使用同一常量
- [x] `desktop/src/main/agent/trace.ts`：从 `tool_execution_start` / `tool_execution_end` / `tool_call` 记录 `{turn, toolName, args摘要, ok, latencyMs, degraded}`，导出 Markdown/Mermaid 到 `docs/tool-trace.mmd`（npm script `trace:export`）
- [x] 跑一次四轮对话（至少含一次 `rag_search` 占位调用与一次 `generate_quiz` 占位调用），`docs/tool-trace.mmd` 生成且每次 Tool 调用都带 `ok` 与 `latencyMs`（**已生成导出链路与文件，但真实四轮调用因缺 API Key 未跑到，当前导出是空轨迹**）；截图存报告素材——**未完成：无截图**
- [x] `npm run typecheck` + `node --test` + `npm run check:tool-schema` 全绿；提交一次

## 进度

### ✅ 已交付（提交 `b72fa90`、`002a7e1`）

`agent/trace.ts` 记录 `{turn, toolName, args摘要, ok, latencyMs, degraded}` 并导出 Mermaid
（npm script `trace:export`，产物 `docs/tool-trace.md` / `docs/tool-trace.mmd`）。

★ **参数摘要走白名单**（`trace.ts` 的 `summarizeArgs`）：文本值 → `«文本 N 字»`（多行再带行数）；
`key` / `token` / `secret` 类键 → `«已省略(敏感)»`；`name` / `student` / `nickname` 类键 → `«已省略(个人信息)»`。
测试断言：塞一个假的 `sk-…`、`小明`、原始 query 进去，**都不可能出现在导出结果里**。

`rag_search` 明确**不在** `TOOL_TO_KIND` 表内（它发 `citation` 而非 `payload`）；
架构守卫 **G10** 断言表内恰好 7 个 payload 类 Tool，且 `rag_search` / `get_student_profile` 不在其中
（映射表唯一落在 `desktop/src/main/ipc/tool-kinds.ts`）。`architecture-guards.test.ts` 14 条全绿。

> ⚠️ **诚实标注**：`docs/tool-trace.mmd` 目前是**空轨迹**（轮数 0、调用 0 次），
> 因为「跑一轮含工具调用的真实对话」需要 API Key。导出链路本身已可用。
