#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""LangGraph 冒烟测试：验证 S04 要用到的全部关键能力在本机可用。

覆盖：
  1. StateGraph 组装 + 条件边路由
  2. SqliteSaver 持久化（跨"会话"记忆 / 断点续跑）
  3. add_conditional_edges 自环重试（动画重试模式的预演）
  4. graph.stream(stream_mode=["messages","updates"])
  5. graph.get_graph().draw_mermaid() → docs/graph.mmd（报告直接用）

用法：
    cd server
    uv run python scripts/smoke_langgraph.py
"""
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path
from typing import Annotated, Literal, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph

ROOT = Path(__file__).resolve().parent.parent
GRAPH_MMD = ROOT.parent / "docs" / "graph-smoke.mmd"


def _keep_last(_a, b):
    """reducer：后写覆盖"""
    return b


class St(TypedDict, total=False):
    user_input: str
    intent: str
    reply: Annotated[str, _keep_last]
    hits: Annotated[list, lambda a, b: (a or []) + (b or [])]
    retry_count: int
    payload: dict | None


# ---------- 节点 ----------
def profile_load(state: St) -> St:
    return {"retry_count": 0, "hits": ["profile_loaded"]}


def intent_route(state: St) -> St:
    text = state.get("user_input", "")
    intent = "animation" if "动画" in text else "qa"
    return {"intent": intent, "hits": [f"intent={intent}"]}


def qa_answer(state: St) -> St:
    return {"reply": f"[QA] 收到：{state['user_input']}", "hits": ["qa_answer"]}


def animation_gen(state: St) -> St:
    n = state.get("retry_count", 0)
    # 演示：前 2 次故意失败，触发条件边自环重试
    if n < 2:
        return {"retry_count": n + 1, "payload": None,
                "hits": [f"animation_gen(fail#{n + 1})"]}
    return {"payload": {"concept": "排序", "source": "template"},
            "reply": "[动画] 已生成排序动画", "hits": ["animation_gen(ok)"]}


def animation_val(state: St) -> St:
    return {"hits": ["animation_val"]}


def safety_final(state: St) -> St:
    return {"hits": ["safety_final"]}


def profile_upd(state: St) -> St:
    return {"hits": ["profile_upd"]}


def route_by_intent(state: St) -> Literal["qa", "animation"]:
    return state["intent"]  # type: ignore[return-value]


def animation_retry_or_pass(state: St) -> Literal["retry", "ok", "degrade"]:
    if state.get("payload"):
        return "ok"
    if state.get("retry_count", 0) >= 3:
        return "degrade"
    return "retry"


def build() -> StateGraph:
    b = StateGraph(St)
    for name, fn in [
        ("profile_load", profile_load), ("intent_route", intent_route),
        ("qa_answer", qa_answer), ("animation_gen", animation_gen),
        ("animation_val", animation_val), ("safety_final", safety_final),
        ("profile_upd", profile_upd),
    ]:
        b.add_node(name, fn)

    b.add_edge(START, "profile_load")
    b.add_edge("profile_load", "intent_route")
    b.add_conditional_edges("intent_route", route_by_intent,
                            {"qa": "qa_answer", "animation": "animation_gen"})
    b.add_edge("qa_answer", "safety_final")
    b.add_edge("animation_gen", "animation_val")
    b.add_conditional_edges("animation_val", animation_retry_or_pass,
                            {"retry": "animation_gen", "ok": "safety_final",
                             "degrade": "safety_final"})
    b.add_edge("safety_final", "profile_upd")
    b.add_edge("profile_upd", END)
    return b


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "student-demo.sqlite"
        conn = sqlite3.connect(str(db), check_same_thread=False)
        saver = SqliteSaver(conn)
        saver.setup()
        graph = build().compile(checkpointer=saver)

        print("=== [1] 条件边 + 自环重试（动画路径）===")
        cfg = {"configurable": {"thread_id": "t-anim"}}
        for mode, chunk in graph.stream(
            {"user_input": "用动画讲排序", "student_id": "s1", "grade": "junior"},
            cfg, stream_mode=["updates"],
        ):
            node = list(chunk.keys())[0] if chunk else "?"
            print(f"  updates -> {node}")

        snap = graph.get_state(cfg)
        print("  最终 hits :", snap.values.get("hits"))
        print("  payload   :", snap.values.get("payload"))

        print("\n=== [2] 跨会话记忆（同一 thread_id 第二轮）===")
        graph.invoke({"user_input": "第二个问题"}, {"configurable": {"thread_id": "t-anim"}})
        snap2 = graph.get_state({"configurable": {"thread_id": "t-anim"}})
        print("  累计 hits :", snap2.values.get("hits"))

        print("\n=== [3] 会话隔离（不同 thread_id 不串台）===")
        cfg_b = {"configurable": {"thread_id": "t-qa"}}
        graph.invoke({"user_input": "什么是循环"}, cfg_b)
        print("  t-qa hits :", graph.get_state(cfg_b).values.get("hits"))

        print("\n=== [4] checkpoint 落盘 ===")
        tables = {r[0] for r in conn.execute(
            "select name from sqlite_master where type='table'").fetchall()}
        n = conn.execute("select count(*) from checkpoints").fetchone()[0]
        print(f"  表: {sorted(t for t in tables if not t.startswith('sqlite'))}")
        print(f"  checkpoints 行数 = {n}")
        print(f"  db 文件存在 = {db.exists()} ({db.stat().st_size} bytes)")

        print("\n=== [5] 导出状态流转图（报告素材）===")
        GRAPH_MMD.parent.mkdir(parents=True, exist_ok=True)
        GRAPH_MMD.write_text(graph.get_graph().draw_mermaid(), encoding="utf-8")
        print(f"  -> {GRAPH_MMD} ({GRAPH_MMD.stat().st_size} bytes)")

        conn.close()

    print("\n[OK] LangGraph 全部关键能力验证通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
