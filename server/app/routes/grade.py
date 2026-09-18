# -*- coding: utf-8 -*-
"""学段推断的五个薄控制器（票 21）—— 提取在 ``app/grade/signals.py``、决策在 ``app/grade/rules.py``。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET  | ``/api/grade/signals/{student_id}`` | 契约 :class:`app.contracts.GradeSignals`：当前学段 + 最近信号 + 待生效建议 |
| GET  | ``/api/grade/state/{student_id}``   | 轻量状态：当前学段 / 连续轮次 / 冷却剩余（桌面端每轮取「当前学段」用这个） |
| GET  | ``/api/grade/history/{student_id}`` | ``grade_history`` 轨迹（报告与汇报的叙事素材） |
| POST | ``/api/grade/turns/{student_id}``   | ★ 上交**一批轮次证据** → 服务端提取信号 + 判定 + 必要时改学段 |
| POST | ``/api/grade/override/{student_id}`` | 学生**手动**设定学段（写 grade_history(source="explicit")，之后 MANUAL_COOLDOWN_TURNS 轮内不再自动调整；契约 :class:`app.contracts.GradeOverrideResponse`） |

学段**默认自动推断、自动生效**；学生可以手动覆盖，覆盖后进入更长的冷却
（:data:`app.grade.rules.MANUAL_COOLDOWN_TURNS`），冷却期满平滑回归自动。

★ 第 4 行的入参是**证据**（学生原话 + 答题表现 + 第二层 LLM 的提议），
**不是**桌面端算好的信号 —— 信号提取只有一份实现（Python 侧），免得两边漂移。
学生原话经 HTTP 传进来，**不入库**（``grade_signals.raw`` 只写自有词表的命中项，
见 ``signals.SignalReading``）—— SQLite 不存对话正文是合规硬约束（执行文档 §8.1）。
手动覆盖的入参更小：只有一个学段字面量，**没有**说明文本框（见
:class:`app.contracts.GradeOverrideRequest` 的注释：库表没有可写列，写日志又违反合规）。

一人一库：每次请求现开现关该学生的 ``learning.db``（``app.routes.students.open_learning_store``），
**不跨学生复用连接**；表结构由 ``app/store/learning.py`` 的迁移器负责，本文件**不写任何 DDL**。

> ⚠️ 路由挂载：本 router 需要在 ``app/main.py`` 里 ``include_router``（与其他新路由一起由
> main.py 维护者登记）。**注册后必须重跑** ``uv run python scripts/export_openapi.py`` 与
> ``cd desktop && npm run gen:api``，否则 ``test_committed_artifact_matches_contracts``
> 与 ``npm run check:api`` 会红。在挂载之前，本模块的单测按 ``tests/test_profile_routes.py``
> 的做法**显式挂载** router，HTTP 层（鉴权中间件 / pydantic 校验 / camelCase 序列化）照样真跑。

## 需要 ``contracts.py`` 补的模型（本文件先用本地模型顶住，**已报备**）

1. ``GradeTurnRequest`` / ``GradeTurnResponse``（上交轮次证据 → 返回判定结果）；
2. ``GradeHistoryEntry``（``grade_history`` 一行：``turn / fromLevel / toLevel / source / confidence``）；
3. ``GradeStateOut``（轻量状态：当前学段 + 连续轮次 + 冷却剩余 + 待生效建议）。

时间戳口径：``grade_signals.ts`` / ``grade_history.ts`` 是**秒**，本模块按契约一律转**毫秒**
（走 ``app.routes.students.to_contract_ms``，与画像路由同一处换算）。
"""

from __future__ import annotations

import logging
import sqlite3

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field

from app.contracts import (
    CamelModel,
    GradeHistoryEntry,
    GradeLevel,
    GradeOverrideRequest,
    GradeOverrideResponse,
    GradeSignal,
    GradeSignals,
)
from app.grade.rules import SIGNAL_LIST_LIMIT, GradeEngine, GradeProposal
from app.grade.signals import QuizPerformance
from app.routes.students import (
    as_grade_level,
    open_learning_store,
    require_data_dir,
    to_contract_ms,
    validate_student_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["grade"])

#: 单轮学生原话的长度上限：它只用来做**正则匹配**，超长粘贴没有意义（也避免无谓的传输）。
MAX_TURN_CHARS = 2000

#: 一批最多多少轮（演示脚本一次导入历史时用；正常每轮一调）。
MAX_BATCH_TURNS = 20


# --------------------------------------------------------------------------- #
# 本地模型（契约模型补齐后应迁进 contracts.py，本文件只做「形状」）
# --------------------------------------------------------------------------- #
class QuizPerformanceInput(CamelModel):
    """答题表现（从 ``learning.db`` 读出来的结构化摘要，由桌面端带上来）。

    **不带题干与作答正文**，只有数字 —— 与 ``learning_history`` 的口径一致。
    """

    attempts: int = Field(default=0, ge=0, le=1000)
    correct: int = Field(default=0, ge=0, le=1000)
    #: 正数 = 连对几题；负数 = 连错几题；0 = 没记录
    current_streak: int = Field(default=0, ge=-100, le=100)
    hints_requested: int = Field(default=0, ge=0, le=1000)
    too_hard: bool = False


class GradeProposalInput(CamelModel):
    """第二层 LLM 的**提议**（``{suggestedGrade, confidence}``）。

    ★ 它只是提议：规则引擎可以采纳（同向时抬高置信度）、可以无视，也可以否决（反向）。
    """

    suggested_grade: GradeLevel
    confidence: float = Field(ge=0.0, le=1.0)
    note: str = Field(default="", max_length=200)


class GradeTurnInput(CamelModel):
    """**一轮**证据：轮次号 + 学生原话 + （可选）答题表现与第二层提议。"""

    turn: int = Field(ge=0, le=100_000)
    text: str = Field(default="", max_length=MAX_TURN_CHARS)
    session_id: str | None = Field(default=None, max_length=128)
    quiz: QuizPerformanceInput | None = None
    proposal: GradeProposalInput | None = None


class GradeTurnsRequest(CamelModel):
    """``POST /api/grade/turns/{student_id}`` 的请求体（**一批轮次证据**，按轮次升序）。"""

    turns: list[GradeTurnInput] = Field(min_length=1, max_length=MAX_BATCH_TURNS)


class GradeEvaluationOut(CamelModel):
    """一轮的判定结论（演示脚本与报告直接用它叙述「第 N 轮为什么没改」）。"""

    turn: int
    direction: int
    streak: int
    confidence: float
    changed: bool
    grade: GradeLevel
    reason: str


class GradeTurnResponse(CamelModel):
    """上交证据后的判定结果（**服务端决策**，桌面端只负责按它换下一轮的 prompt）。"""

    student_id: str
    #: 判定后的**当前生效**学段
    grade: GradeLevel
    previous_grade: GradeLevel
    changed: bool
    source: str
    reason: str
    confidence: float
    rule_confidence: float
    llm_confidence: float | None = None
    turn: int
    direction: int
    streak: int
    cooldown_remaining_turns: int
    #: 第二层被跳过时**可见**（``no_llm``）；正常为 ``null``。降级不许静默。
    degraded: str | None = None
    #: 本批写入 ``grade_signals`` 的读数（含中性读数：它们同样是证据）
    signals: list[GradeSignal] = Field(default_factory=list)
    #: 每一轮的判定轨迹（第 3 轮为什么改、第 6 轮为什么被冷却挡住，一眼可见）
    evaluations: list[GradeEvaluationOut] = Field(default_factory=list)


class GradeStateOut(CamelModel):
    """轻量状态（桌面端每轮取「当前学段」；不含信号列表）。"""

    student_id: str
    grade: GradeLevel
    source: str
    last_turn: int
    last_change_turn: int | None = None
    cooldown_remaining_turns: int = 0
    streak: int = 0
    direction: int = 0
    confidence: float = 0.0
    suggested_level: GradeLevel | None = None


class GradeHistoryResponse(CamelModel):
    """``grade_history`` 轨迹（报告叙事：「第 3 轮调为小学低年级（0.75）」）。

    ★ ``entries`` 用契约里的 :class:`app.contracts.GradeHistoryEntry`：学习报告的
      ``/api/profile/{id}/report`` 要给出**同一份**轨迹，两处各定义一个同形模型迟早分叉
      （这原是本文件模块头「需要 contracts.py 补的模型」第 2 条，现已兑现）。
    """

    student_id: str
    current_level: GradeLevel
    entries: list[GradeHistoryEntry] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# 取数据根（与画像 / 练习 / 动画路由同源，不再本地复制一份）
# --------------------------------------------------------------------------- #
def _require_data_dir(request: Request) -> str:
    """取学生数据根；缺失时给**可读**的 503。

    ★ 实现归口在 :func:`app.routes.students.require_data_dir` —— 画像 / 练习 / 学段 / 动画
    四条轨必须**同一口径**（只认显式传入的 ``--data-dir``）。保留这个私有名字只是为了
    少改调用点；本地再抄一份实现的风险是实测过的（文案差一个词、口径迟早分叉，见 D4）。
    """
    return require_data_dir(request)


def _open_engine(request: Request, student_id: str) -> GradeEngine:
    """开这个学生的库并包一个引擎（调用方负责 ``close()``）。"""
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)
    return GradeEngine(open_learning_store(data_dir, student_id))


def _read_signals(engine: GradeEngine, limit: int = SIGNAL_LIST_LIMIT) -> list[GradeSignal]:
    """读最近若干条信号并**把秒转成毫秒**（契约口径）。"""
    signals = engine.recent_signals(limit)
    return [
        GradeSignal(
            signal_type=signal.signal_type,
            value=signal.value,
            raw=signal.raw,
            ts=to_contract_ms(signal.ts) or None,
        )
        for signal in signals
    ]


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
@router.get(
    "/grade/signals/{student_id}",
    response_model=GradeSignals,
    summary="学段信号与待生效的推断建议",
)
def grade_signals(request: Request, student_id: str) -> GradeSignals:
    """当前学段 + 最近信号 + （够格但被挡住时的）待生效建议。

    ``source`` 现在有**两种**取值：默认是 ``inferred``（系统自动推断），
    学生手动设定过则是 ``explicit``（见 ``POST /grade/override/{student_id}``）。
    ``suggested_level`` 的含义不变：「证据已够、但被冷却期或置信度挡住的下一个学段」，
    供前端显示「将在下一轮生效」。
    """
    engine = _open_engine(request, student_id)
    try:
        state = engine.state(student_id)
        return GradeSignals(
            student_id=student_id,
            current_level=state.grade_level,
            # 与 /grade/state 同一口径：来源跟着最近一次写入走（手动后是 explicit）
            source=state.source,
            suggested_level=state.suggested_level,
            confidence=state.confidence,
            signals=_read_signals(engine),
        )
    except sqlite3.Error as exc:
        logger.exception("学段信号读取失败：%s", student_id)
        raise HTTPException(status_code=503, detail=f"读取学段信号失败（本地数据库异常）：{exc}") from exc
    finally:
        engine.store.close()


@router.get("/grade/state/{student_id}", response_model=GradeStateOut, summary="当前学段状态（轻量）")
def grade_state(request: Request, student_id: str) -> GradeStateOut:
    """桌面端每轮取「当前学段」的入口（不含信号列表，载荷最小）。

    当前学段可能是**推断引擎自动写入**的，也可能是**学生手动设定**的
    （后者 ``source="explicit"``、``cooldownRemainingTurns`` 更长）。

    学生还没建库时**冷启动**：建默认学段（小学高年级）并写一条基线轨迹，
    而不是 404 —— 学段推断从第一轮就要开始工作。
    """
    engine = _open_engine(request, student_id)
    try:
        state = engine.state(student_id)
        return GradeStateOut(
            student_id=student_id,
            grade=state.grade_level,
            source=state.source,
            last_turn=state.last_turn,
            last_change_turn=state.last_change_turn,
            cooldown_remaining_turns=state.cooldown_remaining,
            streak=state.streak,
            direction=state.direction,
            confidence=state.confidence,
            suggested_level=state.suggested_level,
        )
    except sqlite3.Error as exc:
        logger.exception("学段状态读取失败：%s", student_id)
        raise HTTPException(status_code=503, detail=f"读取学段状态失败（本地数据库异常）：{exc}") from exc
    finally:
        engine.store.close()


@router.get(
    "/grade/history/{student_id}",
    response_model=GradeHistoryResponse,
    summary="学段变化轨迹",
)
def grade_history(request: Request, student_id: str) -> GradeHistoryResponse:
    """``grade_history`` 全量轨迹（含冷启动基线那行：``from_level`` 为空）。"""
    engine = _open_engine(request, student_id)
    try:
        level = engine.current_level(student_id)
        entries = [
            GradeHistoryEntry(
                ts=to_contract_ms(row["ts"]) or 0,
                turn=row["turn"],
                from_level=as_grade_level(row["from_level"]) if row["from_level"] else None,
                to_level=as_grade_level(row["to_level"]),
                source=row["source"],
                confidence=row["confidence"],
            )
            for row in engine.history()
        ]
        return GradeHistoryResponse(student_id=student_id, current_level=level, entries=entries)
    except sqlite3.Error as exc:
        logger.exception("学段轨迹读取失败：%s", student_id)
        raise HTTPException(status_code=503, detail=f"读取学段轨迹失败（本地数据库异常）：{exc}") from exc
    finally:
        engine.store.close()


@router.post(
    "/grade/turns/{student_id}",
    response_model=GradeTurnResponse,
    summary="上交一批轮次证据，由服务端提取信号并判定学段",
)
def submit_grade_turns(
    request: Request, student_id: str, payload: GradeTurnsRequest
) -> GradeTurnResponse:
    """★ **学段推断的主入口**：一批轮次证据 → 信号 → 判定 → （必要时）改学段。

    依次处理 ``turns``（按给定顺序 = 轮次升序），**逐轮判定**，
    返回最后一轮的结论 + 每一轮的轨迹。信号逐轮落库：即使中途失败，
    已写入的信号也不会丢，下一次调用照样能算出正确的连续轮次。
    """
    engine = _open_engine(request, student_id)
    try:
        before = engine.current_level(student_id)
        decisions = []
        for item in payload.turns:
            decision = engine.observe_turn(
                student_id=student_id,
                turn=item.turn,
                text=item.text,
                session_id=item.session_id or "",
                quiz=_as_quiz_performance(item.quiz),
                proposal=_as_proposal(item.proposal),
            )
            decisions.append(decision)

        last = decisions[-1]
        core = last.decision
        after = engine.current_level(student_id)
        # 日志**只记轮次与结论**，绝不记学生原话（合规：日志里也不出现对话正文）
        logger.info(
            "学段判定：%s 第 %s 轮 → %s（changed=%s reason=%s 置信度=%.2f 连续=%d%s）",
            student_id,
            [decision.turn for decision in decisions],
            after,
            after != before,
            core.reason,
            core.confidence,
            core.streak,
            "；第二层已跳过（no_llm）" if core.degraded else "",
        )
        return GradeTurnResponse(
            student_id=student_id,
            grade=after,
            previous_grade=before,
            changed=after != before,
            source="inferred",
            reason=core.reason,
            confidence=core.confidence,
            rule_confidence=core.rule_confidence,
            llm_confidence=core.llm_confidence,
            turn=last.turn,
            direction=core.direction,
            streak=core.streak,
            cooldown_remaining_turns=core.cooldown_remaining,
            degraded=core.degraded,
            signals=[
                reading.to_contract()
                for decision in decisions
                for reading in decision.readings
                if reading.has_evidence
            ],
            evaluations=[
                GradeEvaluationOut(
                    turn=decision.turn,
                    direction=decision.decision.direction,
                    streak=decision.decision.streak,
                    confidence=decision.decision.confidence,
                    changed=decision.decision.changed,
                    grade=decision.decision.target_level,
                    reason=decision.decision.reason,
                )
                for decision in decisions
            ],
        )
    except sqlite3.Error as exc:
        logger.exception("学段判定失败：%s", student_id)
        raise HTTPException(status_code=503, detail=f"学段判定失败（本地数据库异常）：{exc}") from exc
    finally:
        engine.store.close()


@router.post(
    "/grade/override/{student_id}",
    response_model=GradeOverrideResponse,
    summary="学生手动设定学段（写 grade_history(source=explicit)，之后进入更长冷却）",
)
def override_grade(
    request: Request, student_id: str, payload: GradeOverrideRequest
) -> GradeOverrideResponse:
    """★ **唯一的人工写路径**：学生选定学段 → 立即生效 + 进入 :data:`MANUAL_COOLDOWN_TURNS` 冷却。

    与 ``POST /grade/turns`` 的分工：那条路径收的是**证据**（可能改变学段，也可能不），
    这条路径收的是**决定**（一定按学生的意思生效）。两者写的是同一张 ``grade_history``，
    区别只有 ``source`` 与冷却窗口长度 —— 冷却期一过，自动推断照常接管。
    """
    engine = _open_engine(request, student_id)
    try:
        result = engine.override_level(student_id=student_id, level=payload.grade_level)
        # 日志只记 id / 学段 / 是否真的变了 / 轮次 —— 手动切换本来就不带学生文本，别在这里加。
        logger.info(
            "学段手动设定：%s grade=%s changed=%s turn=%s",
            student_id,
            result["grade_level"],
            result["changed"],
            result["turn"],
        )
        return GradeOverrideResponse(
            student_id=student_id,
            grade_level=result["grade_level"],
            previous_level=result["previous_level"],
            source=result["source"],
            changed=result["changed"],
            turn=result["turn"],
            cooldown_remaining_turns=result["cooldown_remaining_turns"],
        )
    except sqlite3.Error as exc:
        logger.exception("学段手动设定失败：%s", student_id)
        raise HTTPException(status_code=503, detail=f"设定学段失败（本地数据库异常）：{exc}") from exc
    finally:
        engine.store.close()


def _as_quiz_performance(value: QuizPerformanceInput | None) -> QuizPerformance | None:
    if value is None:
        return None
    return QuizPerformance(
        attempts=value.attempts,
        correct=value.correct,
        current_streak=value.current_streak,
        hints_requested=value.hints_requested,
        too_hard=value.too_hard,
    )


def _as_proposal(value: GradeProposalInput | None) -> GradeProposal | None:
    if value is None:
        return None
    return GradeProposal(
        suggested_grade=value.suggested_grade,
        confidence=value.confidence,
        note=value.note,
    )


__all__ = [
    "GradeEvaluationOut",
    "GradeHistoryEntry",
    "GradeHistoryResponse",
    "GradeOverrideRequest",
    "GradeOverrideResponse",
    "GradeProposalInput",
    "GradeStateOut",
    "GradeTurnInput",
    "GradeTurnResponse",
    "GradeTurnsRequest",
    "MAX_BATCH_TURNS",
    "MAX_TURN_CHARS",
    "QuizPerformanceInput",
    "router",
]
