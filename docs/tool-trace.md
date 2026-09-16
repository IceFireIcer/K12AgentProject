# 工具调用轨迹（自动导出）

> 由 `desktop/src/main/agent/trace.ts` 从 Pi 的 `tool_call` / `tool_execution_start` / `tool_execution_end` 事件导出。**本文件替代原方案的 LangGraph 状态流转图**（执行文档 §9.4 第 4 条）。
> 参数只记摘要：键名 + 规模（`«文本 12 字»`），密钥与个人信息类键一律省略 —— 轨迹图是要进报告与答辩 PPT 的，不落原始输入是数据合规要求。

- 生成时间：2026-09-16T19:39:53.944Z
- 轮数：1
- Tool 调用次数：4
- 模型：deepseek/stub-model

```mermaid
flowchart TD
  %% 由 desktop/src/main/agent/trace.ts 自动生成，请勿手改
  %% 生成时间：2026-09-16T19:39:53.944Z｜轮数：1｜调用：4 次
  %% 参数只记摘要（不含原文 / 密钥 / 学生个人信息）
  classDef turn fill:#e3f2fd,stroke:#1565c0,stroke-width:1px,color:#0d47a1
  classDef ok fill:#e8f5e9,stroke:#2e7d32,stroke-width:1px,color:#1b5e20
  classDef fail fill:#ffebee,stroke:#c62828,stroke-width:1px,color:#b71c1c
  classDef blocked fill:#fff8e1,stroke:#f9a825,stroke-width:1px,color:#795548
  T1_START(["第 1 轮 · 学生提问"]):::turn
  T1_START --> T1_C_1["rag_search<br/>ok · 546ms · degraded:vector<br/>gradeLevel=primary_high, query=«文本 2 字»"]:::ok
  T1_C_1 --> T1_C_2["generate_quiz<br/>ok · 85ms<br/>count=2, gradeLevel=primary_high, kpId=pl-ai-around-me"]:::ok
  T1_C_2 --> T1_C_3["get_student_profile<br/>ok · 33ms<br/>#40;无参数#41;"]:::ok
  T1_C_3 --> T1_C_4["generate_animation<br/>ok · 22ms<br/>concept=«文本 9 字», gradeLevel=primary_high, kpId=pl-machine-sees"]:::ok
  T1_C_4 --> T1_END(["第 1 轮 · 回复学生"]):::turn
```

## 调用明细

| # | 轮次 | Tool | 参数摘要 | 结果 | 耗时 | 降级 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | rag_search | gradeLevel=primary_high, query=«文本 2 字» | ok | 546ms | vector |  |
| 2 | 1 | generate_quiz | count=2, gradeLevel=primary_high, kpId=pl-ai-around-me | ok | 85ms | — |  |
| 3 | 1 | get_student_profile | (无参数) | ok | 33ms | — |  |
| 4 | 1 | generate_animation | concept=«文本 9 字», gradeLevel=primary_high, kpId=pl-machine-sees | ok | 22ms | — |  |

