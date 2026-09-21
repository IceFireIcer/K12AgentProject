# -*- coding: utf-8 -*-
"""学段信号提取与规则引擎（票 21）—— ★ **默认由系统推断并自动生效；学生也可手动指定**。

★ 头一行曾经写「没有人工选择」——那是 **D-020 的旧口径**，已被 **D-037** 推翻：
  学生点指示器或设置页即可**立即**改学段（`grade:set` → `POST /api/grade/override`），
  之后进入更长的冷却（10 轮）再平滑回归自动。

```text
每轮对话 ──▶ signals.py（三路信号，纯规则，**不调 LLM**）──▶ grade_signals 表
                    │
            第 3 轮（证据不足则第 5 轮）
                    ▼
      第二层：一次轻量 LLM 判定 → {suggestedGrade, confidence}（**只是提议**）
                    │
                    ▼
   rules.py 的规则引擎（**最终决策者**）——四条硬约束：
     置信度 < 0.6 不改 · 连续 3 轮同方向 · 改后 5 轮冷却 · 单次最多动 1 级
                    │
                    ▼
   原子写入 learning.db：student.grade_level + grade_history(source="inferred")
                    │
                    ▼
   下一轮 before_agent_start 自动按新学段拼 system prompt（自动调整学生无感）
```

模块分工：

- :mod:`app.grade.signals`：三路信号（词汇复杂度 / 问题深度 / 元认知表达）
  的提取，**唯一实现**（桌面端只上交证据，不在 TS 里再写一份）。
  ★ 2026-09-21（D-065）：原第四路「答题表现」已移除（概念错位 + 与元认知重复计数），
  且深度 / 词汇改成**只上不下** —— 下调只由元认知负责。见该模块 docstring；
- :mod:`app.grade.rules`：阈值常量 + 决策纯函数 :func:`app.grade.rules.decide`
  + 落库的 :class:`app.grade.rules.GradeEngine`；
- :mod:`app.routes.grade`：薄控制器（``GET /api/grade/signals/{id}`` /
  ``GET /api/grade/state/{id}`` / ``GET /api/grade/history/{id}`` /
  ``POST /api/grade/turns/{id}``）。

**无 API Key 时**：第二层整层跳过，第一层照常工作、照常能改学段，
但判定结果里会带 ``degraded="no_llm"`` —— **降级可见，不静默**。
"""

from app.grade.rules import (
    CONFIDENCE_THRESHOLD,
    COOLDOWN_TURNS,
    DEFAULT_GRADE_LEVEL,
    DECISION_ORDER,
    LAYER2_FIRST_TURN,
    LAYER2_RETRY_TURN,
    MAX_STEP_LEVELS,
    SIGNALS_REQUIRED_FOR_CHANGE,
    Decision,
    GradeDecision,
    GradeEngine,
    GradeProposal,
    GradeState,
    decide,
)
from app.grade.signals import (
    SignalReading,
    TurnSignals,
    extract_turn_signals,
)

__all__ = [
    "CONFIDENCE_THRESHOLD",
    "COOLDOWN_TURNS",
    "DEFAULT_GRADE_LEVEL",
    "DECISION_ORDER",
    "Decision",
    "GradeDecision",
    "GradeEngine",
    "GradeProposal",
    "GradeState",
    "LAYER2_FIRST_TURN",
    "LAYER2_RETRY_TURN",
    "MAX_STEP_LEVELS",
    "SIGNALS_REQUIRED_FOR_CHANGE",
    "SignalReading",
    "TurnSignals",
    "decide",
    "extract_turn_signals",
]
