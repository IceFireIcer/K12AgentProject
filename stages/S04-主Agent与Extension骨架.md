# Stage 04 · 主 Agent + Extension 骨架

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D4** |
| 关卡 | —（但直接服务 **25% 设计合理性**） |
| 前置 | S03 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

落 6 个 Extension 与 Tool 注册；学段经 `before_agent_start` 注入；
**并提供工具调用轨迹导出**（替代原 `draw_mermaid()` 状态流转图，作为设计合理性维度的证据）。

## 2. 任务清单

### 2.1 六个 Extension

> 形态：导出默认工厂 `(pi: ExtensionAPI) => { pi.on(...); pi.registerTool(...) }`。
> **不存在 `registerExtension`，也不是插件清单。**

- [ ] 动画：`generate_animation`
- [ ] 编程：`get_code_template` / `get_coding_hint` / `evaluate_code`
- [ ] 练习：`generate_quiz` / `submit_quiz` / `generate_variants`
- [ ] 画像：`get_student_profile`
- [ ] 学段：`before_agent_start` + `input` 钩子
- [ ] 学习记录：`tool_execution_end` + **`agent_end`**
      ⚠️ **不是 `session_end`，该事件不存在**（真实终态是 `session_shutdown`）

### 2.2 路由与映射

- [ ] **Tool 名 → 事件 `kind` 映射**按执行文档 9.3 节冻结登记
      （新增 Tool **必须同步登记**，否则前端收到未知 `kind`）
- [ ] 主 Agent 由 LLM 自主选 Tool，**不设 `intent` 字段**
- [ ] **关键约束在代码层强制**（不要交给模型）：学段隔离在 Tool 内由 Python 强制、
      安全终审独立成步、沙箱是运行时属性、Tool 参数由 TypeBox 校验

### 2.3 学段注入与画像

- [ ] `before_agent_start` 返回 `{ systemPrompt }`（四学段模板放 `desktop/src/main/agent/prompts/`）
- [ ] 底层打底用 `systemPromptOverride`
- [ ] 画像加载走 `get_student_profile` Tool → HTTP → Python sidecar
- [ ] **Tool → sidecar 的 HTTP 桥**（统一注入 token）；
      Tool 的 `execute()` **自行兜异常**（返回可读错误而非抛出）

### 2.4 ★ 轨迹导出（25% 设计分的证据）

- [ ] 从 `tool_execution_start` / `tool_execution_end` / `tool_call` 记录
      `{turn, toolName, args摘要, ok, latencyMs, degraded}` → **`docs/tool-trace.mmd`**

### 2.5 ★ 会话落盘改道（合规硬伤）

- [ ] `DefaultResourceLoader({ agentDir })` 或 `settings.sessionDir` 落到 `students/<id>/pi-agent/`
- [ ] **加自动化断言**：`students/<id>/` 之外**不得出现本应用 `.jsonl`**

### 2.6 契约一致性

- [ ] **Tool TypeBox 参数 ↔ pydantic 模型一致性断言**脚本
      （`desktop/scripts/check-tool-schema.mjs`）

## 3. 验收标准（DoD）

- [ ] 6 个 Extension 均能注册，Tool 可被 LLM 正常调用
- [ ] 四学段 system prompt 经 `before_agent_start` 生效（同一 Tool 调用在四学段下**语气可区分**）
- [ ] **工具调用轨迹图可导出**（`docs/tool-trace.mmd`）
- [ ] **会话文件只在 `students/<id>/pi-agent/`，断言通过**
- [ ] Tool 契约一致性断言通过
- [ ] `npm run typecheck` 通过

## 4. 陷阱

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **`tool_execution_end` 是只读通知** | **不能回写结果** → 重试逻辑写在 Tool 的 `execute()` 内部。 |
| 2 | **`session_end` 不存在** | 见 `pitfalls.md` P-103。 |
| 3 | **会话默认落 `~/.pi/agent/`** | 不改道 → **跨学生数据混放**（合规硬伤）。见 P-104。 |
| 4 | **默认 system prompt 泄漏宿主路径** | 必须 `systemPromptOverride`。见 P-105。 |
| 5 | 不要引入 `ModuleResult` / `ModuleError` | 失败统一走 `error` 事件（带 `degraded`），**避免两套失败形态**。 |
| 6 | 不要引入 `pi-subagents` | 非官方第三方包；Pi 官方哲学即「No sub-agents」。SubAgent 用**自有 Extension** 实现。 |

---

## 5. 产出记录

| 项 | 结果 |
| --- | --- |
| Extension 数量 / Tool 数量 | （待填） |
| 轨迹图导出结果 | （待填） |
| 会话落盘断言结果 | （待填） |
