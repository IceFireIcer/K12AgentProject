# -*- coding: utf-8 -*-
"""学段信号提取与规则引擎（票 21）—— ★ **学段由系统推断，没有人工选择**。

最终设计（旧设计「学生手选 + 推断只给建议」**已废止**）：

```text
每轮对话 ──▶ signals.py（四类信号，纯规则，**不调 LLM**）──▶ grade_signals 表
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
   下一轮 before_agent_start 自动按新学段拼 system prompt（学生无感）
```

模块分工：

- :mod:`app.grade.signals`：四类信号（词汇复杂度 / 问题深度 / 答题表现 / 元认知表达）
  的提取，**唯一实现**（桌面端只上交证据，不在 TS 里再写一份）；
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
    QuizPerformance,
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
    "QuizPerformance",
    "SIGNALS_REQUIRED_FOR_CHANGE",
    "SignalReading",
    "TurnSignals",
    "decide",
    "extract_turn_signals",
]
