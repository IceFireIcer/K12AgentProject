# Stage 04 · LangGraph 状态机骨架 + 意图路由 + SqliteSaver

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D4** |
| 关卡 | —（但直接服务 25% 设计合理性） |
| 前置 | S03 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

把线性流式对话升级为 **LangGraph 状态机**：`profile_load → intent_route → 四路分支 → safety_final → profile_upd`，并挂上 `SqliteSaver` 获得跨会话记忆。**同时导出状态流转图给报告用。**

---

## 2. 任务清单

- [ ] `app/agents/state.py`：`TutorState`（TypedDict，字段见执行文档 6.6）
- [ ] `app/agents/graph.py`：`StateGraph` 组装
  - [ ] 节点：`profile_load` / `intent_route` / `qa_answer` / `animation_gen` / `animation_val` / `quiz_gen` / `coding_handle` / `safety_final` / `profile_upd`
  - [ ] 固定边：START → profile_load → intent_route
  - [ ] 条件边：`route_by_intent` → 四路
  - [ ] 动画自环条件边：`animation_retry_or_pass`（retry / degrade / ok）
  - [ ] 全部汇聚 → safety_final → profile_upd → END
- [ ] `intent_route`：LLM 意图分类（qa|animation|coding|quiz），输出严格 JSON
- [ ] **学段在 `profile_load` 注入**，SubAgent 只读不推断
- [ ] `SqliteSaver` 挂载（**注意下面的陷阱 #1**）
- [ ] 四学段 System Prompt：`app/agents/main_agent/prompts/{primary_low,primary_high,junior,senior}.py`
- [ ] **导出流转图**：`graph.get_graph().draw_mermaid()` → `docs/graph.mmd`
- [ ] 用 `graph.stream(..., stream_mode=["messages","updates"])` 替换 S03 的直接 LLM 调用

---

## 3. 关键代码要点

```python
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.sqlite import SqliteSaver

builder = StateGraph(TutorState)
builder.add_node("profile_load", profile_load)
builder.add_node("intent_route", intent_route)
builder.add_node("qa_answer",    qa_answer)
builder.add_node("animation_gen", animation_gen)
builder.add_node("animation_val", animation_val)
builder.add_node("quiz_gen",      quiz_gen)
builder.add_node("coding_handle", coding_handle)
builder.add_node("safety_final",  safety_final)
builder.add_node("profile_upd",   profile_upd)

builder.add_edge(START, "profile_load")
builder.add_edge("profile_load", "intent_route")
builder.add_conditional_edges("intent_route", route_by_intent, {
    "qa": "qa_answer", "animation": "animation_gen",
    "quiz": "quiz_gen", "coding": "coding_handle",
})
builder.add_conditional_edges("animation_val", animation_retry_or_pass,
                              {"retry": "animation_gen", "degrade": "safety_final", "ok": "safety_final"})

# ★ 按 student_id 缓存已编译图（见陷阱 #1）
_GRAPH_CACHE: dict[str, "CompiledGraph"] = {}
```

---

## 4. 验收标准（DoD）

- [ ] 问不同类型的问题，`updates` 事件显示路由到了正确节点
- [ ] **同一问题在四学段下回答的语气/深度可明显区分**（留 4 张截图 → 报告直接用）
- [ ] `docs/graph.mmd` 生成成功，贴进 mermaid 渲染器图形正确
- [ ] **跨会话记忆**：同一 session 第二轮能感知第一轮上下文
- [ ] 关闭应用重开，同一 `thread_id` 的 checkpoint 仍在（查 student 库表）

---

## 5. 陷阱与注意

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **`compile(checkpointer=...)` 绑死图实例** | 学生库一人一文件 → **不能"编译一次全局复用"**。做法：① 按 `student_id` 缓存已编译图（**推荐**）；② 切学生时重建。**切勿**改用共享 DB + thread_id 前缀，会破坏「一人一库」合规叙事，答辩被问穿。 |
| 2 | `thread_id` 语义 | `thread_id = session_id`，不是 student_id；别混。 |
| 3 | 状态字段并发写 | 用 `Annotated[list, add]` 之类的 reducer，避免覆盖。 |
| 4 | 意图分类不稳定 | 要求 LLM 输出严格 JSON，失败则兜底为 `qa`（永远有路可走）。 |
| 5 | checkpoint 表手写 | **不要手写**，由 `SqliteSaver.setup()` 自动建立。 |
| 6 | mermaid 中文/特殊字符 | 节点名用英文 id，显示名另配，避免 mermaid 解析失败。 |

---

## 6. 产出记录

| 项 | 结果 |
| --- | --- |
| 意图路由准确率（目测） | （待填） |
| 流转图路径 | docs/graph.mmd |
| 踩坑 | （待填） |
