# -*- coding: utf-8 -*-
"""学段推断的**规则引擎**（执行文档 §10.3，票 21）—— ★ **最终决策权在这里，不在 LLM**。

设计：**默认由系统推断并自动生效**，学生也可以**手动覆盖**（§ ``override_level``）——
手动是明确意图，写一条 ``grade_history(source="explicit")`` 的轨迹行，
之后进入更长的冷却（:data:`MANUAL_COOLDOWN_TURNS`），冷却期满再平滑回归自动。

- 第一层（每轮，**不调 LLM**）：``signals.py`` 的四路读数 → 写 ``grade_signals``；
- 第二层（第 3 轮触发，证据不足则第 5 轮）：**一次**轻量 LLM 判定，产出
  ``{suggestedGrade, confidence}`` —— 它只是**提议**，与第一层同向时抬高置信度，
  反向时被引擎否决（:data:`REASON_LLM_CONFLICT`）；
- **规则引擎**（本模块）按四条硬约束决定是否真的改：

  ① 置信度 < :data:`CONFIDENCE_THRESHOLD`（0.6）→ 不改；
  ② 连续 :data:`SIGNALS_REQUIRED_FOR_CHANGE`（3）个**同方向**信号才够；
  ③ 调整后进入冷却期（自动 :data:`COOLDOWN_TURNS` = 5 轮、
     手动 :data:`MANUAL_COOLDOWN_TURNS` = 10 轮）内不再调整；
  ④ 每次最多动 :data:`MAX_STEP_LEVELS`（1）级 —— 从小学低年级看到高中术语也只上一级。

  判定顺序是**冻结**的（:data:`DECISION_ORDER`）：一条证据同时被多个条件挡住时，
  ``reason`` 取最先失败的那条 —— 报告与演示脚本都按这个顺序解释现象。

- 状态读写落在 ``learning.db``：``student.grade_level`` + ``grade_history``
  （自动 ``source="inferred"`` / 手动 ``source="explicit"``）**原子性**写入（同一个事务）。
  改完之后，**下一轮**的 ``before_agent_start`` 会按新学段拼
  system prompt，学生不会看到「学段切换」这种事件（执行文档 §10.4）。

> ⚠️ 无 API Key 时第二层**整层跳过**（``proposal=None``）：第一层照常工作、照常能改学段，
> 但 ``degraded="no_llm"`` 会在判定结果里显式可见 —— **降级不许静默**。

> ★ 阈值全部是**具名常量**（本模块唯一的数字来源）：不要在别处再写字面量 ``0.6`` / ``3`` / ``5``。
> 桌面的 ``extensions/grade.ts`` 有第二层触发轮次（3 / 5），由 ``tests/grade-inference.test.ts``
> 反向读本文件做一致性断言，防止两边各改一半。

> ⚠️ **轮次号是每会话计数器**（桌面端换会话就从 1 重来），而 ``last_change_turn`` /
> ``grade_signals`` 的轮次锚点跨会话长期留在 ``learning.db`` 里。这带来两处已知偏差
> （D1）：冷却期在换会话后被拉长、同号不同会话的信号被当成同一轮。
> 本次只做了**安全裁剪**（冷却钳到 ``≤ COOLDOWN_TURNS`` + 按会话分桶），
> **跨会话的严格解（全局单调序号）尚未实施** —— 细节见 :func:`_cooldown_remaining`
> 与 :meth:`GradeEngine.verdicts` 的注释，接手时先读那两处。
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Sequence

from app.contracts import GradeLevel, GradeSignal
from app.grade.signals import (
    GRADE_ORDER,
    QuizPerformance,
    SignalReading,
    TurnSignals,
    consecutive_same_direction,
    decode_turn_raw,
    direction_of,
    encode_turn_raw,
    extract_turn_signals,
    level_at,
    mean_strength,
    rank_of,
)
from app.routes.students import DEFAULT_COLD_START_GRADE, as_grade_level
from app.store.learning import LearningStore

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# ★★ 阈值（**唯一来源**；四条硬约束逐条对应执行文档 §10.3）
# --------------------------------------------------------------------------- #
#: ① 置信度阈值：``< 0.6`` 不调整（边界口径：``0.59`` 不改、``0.60`` 才进入后续判定）。
CONFIDENCE_THRESHOLD = 0.6

#: ② 方向一致性：连续这么多个**轮次**同方向才算数（一轮里的多条信号只算一轮）。
SIGNALS_REQUIRED_FOR_CHANGE = 3

#: ③ 冷却期：调整后这么多轮内不再调整。
COOLDOWN_TURNS = 5

#: ③ 手动覆盖后的冷却期。比自动冷却长一倍：
#: 手动设定是学生的**明确意图**，不该被两三轮信号立刻推翻 —— 否则学生刚选完，
#: 下一轮两句童言又把它改回去，学生会觉得「选了不算数」；
#: 但也不能永久停用自动（那一来学生选错就再没救，二来赛题要的是「智能体自适应」），
#: 所以冷却期一满就照常回归自动推断。
MANUAL_COOLDOWN_TURNS = 10

#: ④ 单次最多动几级。
MAX_STEP_LEVELS = 1

#: 第二层 LLM 判定的触发轮次（第 3 轮没攒够证据则退到第 5 轮）。
#: 桌面端 `extensions/grade.ts` 用同一组数值，有跨语言一致性断言。
LAYER2_FIRST_TURN = 3
LAYER2_RETRY_TURN = 5

#: 规则置信度的换算：``置信度 = min(上限, 平均强度 × 增益)``。
#: 单路差一级 = 0.5 强度 → ``0.5 × 1.5 = 0.75 ≥ 0.6``（三路单级证据刚好够）；
#: 三路弱证据（各 0.2）→ ``0.3 < 0.6``（不够，这是有意的）。
RULE_CONFIDENCE_GAIN = 1.5

#: 规则置信度的上限：**刻意留 0.1 给第二层**（有 LLM 复核时才可能更高），
#: 同时避免「规则置信度 1.0」给人「绝对确定」的错觉。
MAX_RULE_CONFIDENCE = 0.9

#: 冷启动默认学段（无历史 → 小学高年级），与 ``routes.students.DEFAULT_COLD_START_GRADE`` 同一口径。
DEFAULT_GRADE_LEVEL: GradeLevel = DEFAULT_COLD_START_GRADE

#: ``grade_history.source``：系统推断（规则引擎自己改的）。
SOURCE_INFERRED = "inferred"

#: ``grade_history.source``：学生手动选择（:meth:`GradeEngine.override_level` 写入）。
#: 表结构当初就预留了这个取值（``app/store/migrations.py`` 的列注释里本来就写着
#: ``explicit | inferred | confirmed``），所以放开它**不需要新增列或表**。
SOURCE_EXPLICIT = "explicit"

#: 从 ``grade_signals`` 里往回读多少行来还原「每轮方向」（够覆盖冷却期 + 连续窗口）。
RECENT_SIGNAL_ROWS = 120

#: ``GET /api/grade/signals`` 最多回多少条信号（Prompt/网络预算；证据够看就行）。
SIGNAL_LIST_LIMIT = 20

#: ``grade_history`` 的读取上限。
HISTORY_LIMIT = 50

#: 从 ``learning_history`` 里往回看多少条答题记录来算「连对/连错」（答题表现信号）。
#: 只取最近一小段：连对连错本来就是**近期**状态，翻半年前的记录没有意义。
QUIZ_HISTORY_WINDOW = 20


# ---- 判定结果的原因（冻结词表：前端/报告/演示脚本都按它解释现象）----
REASON_CHANGED = "changed"
REASON_NO_DIRECTION = "no_direction"
REASON_LOW_CONFIDENCE = "low_confidence"
REASON_COOLDOWN = "cooldown"
REASON_LLM_CONFLICT = "llm_conflict"
REASON_AT_BOUNDARY = "at_boundary"
#: 写库失败（``sqlite3.Error``）：**不等于改过** —— 学段保持原值，本轮如实报失败。
REASON_WRITE_FAILED = "write_failed"

#: 判定的检查顺序（**冻结**：多条件同时挡住时，``reason`` 取最先失败的那条）。
#:
#: ★ 它必须与 :func:`decide` 里 ``outcome(...)`` 的实际顺序**逐项一致** ——
#: 报告与演示脚本都按这个顺序解释现象（「为什么第 6 轮没改？因为冷却，不是置信度不够」）。
#: 早先这份常量漏了 ``llm_conflict``、且把 ``low_confidence`` 写在它前面，
#: 与实现不符（D8）。``tests/test_grade.py`` 有一条**读源码**的结构断言钉住两者一致，
#: 改判定顺序却忘了改这里会直接红。
#:
#: 末项是 ``changed``：它是「没被任何条件挡住」时的出口，不是一条拦截条件；
#: :data:`REASON_WRITE_FAILED` 是**落库阶段**的失败（判定已经通过），不在这条链上。
DECISION_ORDER: tuple[str, ...] = (
    REASON_NO_DIRECTION,
    REASON_LLM_CONFLICT,
    REASON_LOW_CONFIDENCE,
    REASON_COOLDOWN,
    REASON_AT_BOUNDARY,
    REASON_CHANGED,
)

#: 降级标注（``GradeDecision.degraded``）：第二层本应触发却没有提议时可见。
DEGRADED_NO_LLM = "no_llm"


# --------------------------------------------------------------------------- #
# 结构
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class GradeProposal:
    """第二层 LLM 的**提议**（`{suggestedGrade, confidence}`）。

    ★ 它没有决策权：只是引擎的一个输入（同向抬高置信度、反向被否决）。
    """

    suggested_grade: str
    confidence: float
    note: str = ""


@dataclass(frozen=True)
class TurnVerdict:
    """从 ``grade_signals`` 还原出来的**每一轮**读数（方向 + 强度）。"""

    turn: int
    direction: int
    strength: float


@dataclass(frozen=True)
class GradeState:
    """一名学生当前的学段状态（读快照，供 ``GET`` 端点与诊断使用）。"""

    student_id: str
    grade_level: GradeLevel
    source: str
    last_turn: int
    last_change_turn: int | None
    cooldown_remaining: int
    #: 末尾连续同方向的轮数与方向（``0`` = 没有连续证据）
    streak: int
    direction: int
    #: 规则的置信度（当前连续窗口）
    confidence: float
    #: 「够格但被挡住」时给出目标学段（``None`` = 没有待生效的调整）
    suggested_level: GradeLevel | None


@dataclass(frozen=True)
class Decision:
    """**纯函数** :func:`decide` 的产物（不含任何 IO，可单独断言）。"""

    changed: bool
    reason: str
    target_level: GradeLevel
    previous_level: GradeLevel
    direction: int
    streak: int
    confidence: float
    rule_confidence: float
    llm_confidence: float | None
    cooldown_remaining: int
    degraded: str | None = None


@dataclass(frozen=True)
class GradeDecision:
    """一轮观察的完整结果（``Decision`` + 上下文，路由据此组装出参）。"""

    student_id: str
    turn: int
    decision: Decision
    #: 本轮写进 ``grade_signals`` 的读数（含中性读数：它们也是证据）
    readings: tuple[SignalReading, ...] = ()
    #: 本轮之前库里已有的轮次读数（不再回传，只给日志/被测断言用）
    history_turns: tuple[int, ...] = field(default_factory=tuple)

    @property
    def grade_level(self) -> GradeLevel:
        return self.decision.target_level

    @property
    def changed(self) -> bool:
        return self.decision.changed


# --------------------------------------------------------------------------- #
# 纯决策（★ 四条硬约束都在这里，无 IO、可单独单测）
# --------------------------------------------------------------------------- #
def proposal_direction(proposal: GradeProposal | None, current_level: str) -> int:
    """提议相对当前学段的方向（``0`` = 同档 / 非法，视作「没有主见」）。"""
    if proposal is None:
        return 0
    current_rank = rank_of(current_level)
    target_rank = rank_of(proposal.suggested_grade)
    if current_rank is None or target_rank is None:
        return 0
    return direction_of(float(target_rank - current_rank))


def rule_confidence_for(turns: Sequence[TurnVerdict]) -> float:
    """规则置信度 = ``min(0.9, 平均强度 × 1.5)``。

    只用**末尾连续同方向**的那几轮算平均（一轮中性就打断，不跨过去累加）。
    """
    return min(MAX_RULE_CONFIDENCE, mean_strength(turns) * RULE_CONFIDENCE_GAIN)


def decide(
    *,
    current_level: str,
    turn: int,
    verdicts: Sequence[TurnVerdict],
    proposal: GradeProposal | None = None,
    last_change_turn: int | None = None,
    last_change_source: str | None = None,
) -> Decision:
    """规则引擎的决策核心（纯函数）。

    ``verdicts`` 是**按轮次升序**的读数序列（末尾是最近的轮）。判定顺序见 :data:`DECISION_ORDER`。

    ``last_change_source`` 是最近一次写入 ``grade_history`` 的来源，只用来推导冷却**窗口长度**
    （手动 :data:`MANUAL_COOLDOWN_TURNS` / 自动 :data:`COOLDOWN_TURNS`）。
    默认 ``None`` = 按自动窗口处理（纯函数的老调用方不必传）。
    """
    level = as_grade_level(current_level)
    current_rank = rank_of(level)
    assert current_rank is not None  # as_grade_level 已把脏值收敛到四学段之一

    direction, streak = consecutive_same_direction(verdicts)
    # 置信度只在「够格的窗口」上算：末尾连续同方向的那几轮
    window = list(verdicts)[-streak:] if streak else []
    rule_confidence = rule_confidence_for(window)

    llm_confidence = float(proposal.confidence) if proposal is not None else None
    llm_direction = proposal_direction(proposal, level)

    # 第 3 轮起第二层本应触发：这一轮没有提议 → 降级可见（不是静默）
    degraded = DEGRADED_NO_LLM if (proposal is None and turn >= LAYER2_FIRST_TURN) else None

    def outcome(
        reason: str,
        *,
        confidence: float,
        changed: bool = False,
        target: str = level,
    ) -> Decision:
        # 刚改过 → 冷却从头开始（报一个完整窗口而不是 0：前端与报告看到的是「接下来 N 轮不动」）。
        # ★ 这里固定用 COOLDOWN_TURNS 而不是按来源推导：`changed=True` 只可能来自**自动调整**
        #   （手动覆盖压根不走这个纯函数，它自己写库、自己报 MANUAL_COOLDOWN_TURNS），
        #   所以「刚改过」的窗口必然是自动窗口。
        remaining = (
            COOLDOWN_TURNS
            if changed
            else _cooldown_remaining(turn, last_change_turn, last_change_source)
        )
        return Decision(
            changed=changed,
            reason=reason,
            target_level=as_grade_level(target),
            previous_level=level,
            direction=direction,
            streak=streak,
            confidence=round(confidence, 4),
            rule_confidence=round(rule_confidence, 4),
            llm_confidence=llm_confidence,
            cooldown_remaining=remaining,
            degraded=degraded,
        )

    # ① 方向一致性（先看有没有「够格的证据」，再看它有多可信）
    if direction == 0 or streak < SIGNALS_REQUIRED_FOR_CHANGE:
        return outcome(REASON_NO_DIRECTION, confidence=rule_confidence)

    # ② 提议与规则**反向** → 否决（分歧 = 不确定；宁可不动）
    if llm_direction != 0 and llm_direction != direction:
        return outcome(REASON_LLM_CONFLICT, confidence=rule_confidence)

    # ③ 置信度：有同向提议时取二者较高者（提议只是抬高，不改变方向）
    confidence = rule_confidence
    if proposal is not None and llm_direction == direction:
        confidence = max(rule_confidence, min(1.0, float(proposal.confidence)))
    if confidence < CONFIDENCE_THRESHOLD:
        return outcome(REASON_LOW_CONFIDENCE, confidence=confidence)

    # ④ 冷却期
    if _cooldown_remaining(turn, last_change_turn, last_change_source) > 0:
        return outcome(REASON_COOLDOWN, confidence=confidence)

    # ⑤ 单次最多动 MAX_STEP_LEVELS 级；到顶/到底则无可动
    step = max(-MAX_STEP_LEVELS, min(MAX_STEP_LEVELS, direction))
    target = level_at(current_rank + step)
    if target is None or target == level:
        return outcome(REASON_AT_BOUNDARY, confidence=confidence)

    return outcome(REASON_CHANGED, confidence=confidence, changed=True, target=target)


def _cooldown_remaining(
    turn: int, anchor_turn: int | None, anchor_source: str | None
) -> int:
    """距下次允许调整还剩几轮（``0`` = 现在就可以调）。

    ``anchor_turn`` / ``anchor_source`` 是**最近一次写入 ``grade_history`` 的锚点**：
    前者是那次写入的轮次号、后者是它的 ``source``。窗口长度由来源推导 ——
    手动（:data:`SOURCE_EXPLICIT`）用 :data:`MANUAL_COOLDOWN_TURNS`、其余用
    :data:`COOLDOWN_TURNS`。**所以不需要为「手动冷却更长」新增列**：
    来源本来就在那一行里，冷却长度是它的函数。

    ★★ 轮次号是**每会话**计数器（桌面端换一个会话就从 1 重来），而 ``anchor_turn``
    是上一会话写进库里、**长期保留**的那个号 —— 于是新会话的 ``turn`` 常常**小于**
    ``anchor_turn``：

    - 旧行为：``elapsed = 1 - 8 = -7`` → ``remaining = 5 - (-7) = 12``，
      冷却期被跨会话**拉长到 12 轮**（设计只有 :data:`COOLDOWN_TURNS` = 5）；
    - 现在：``elapsed`` 钳到 ``≥ 0`` → ``remaining`` **绝不会超过**本窗口的长度。
      代价是「新会话会重新获得一段完整的冷却」，方向上是**保守**的
      （宁可多观察几轮，也不要让冷却被无限拉长）。

    ⚠️ **跨会话的严格解尚未实施**：正确做法是给信号与变更记一个**全局单调序号**
    （或 ``(session_id, turn)`` 复合键 + 会话起始时刻），使冷却期是「真实的 N 轮交互」。
    那需要改 ``grade_signals`` / ``grade_history`` 的表结构（归 ``app/store/**``）
    与桌面端上交的口径，属于**跨端改动**，不在本次修复范围 —— 这里只做上面这一处安全裁剪。
    读到这条注释的接手人：改的时候 ``DECISION_ORDER`` 的测试与 ``desktop/tests/grade-inference.test.ts``
    里的常量一致性断言都要一起看。
    """
    if anchor_turn is None:
        return 0
    window = MANUAL_COOLDOWN_TURNS if anchor_source == SOURCE_EXPLICIT else COOLDOWN_TURNS
    elapsed = max(0, int(turn) - int(anchor_turn))
    return max(0, window - elapsed)


def quiz_performance_from_history(
    store: LearningStore, *, window: int = QUIZ_HISTORY_WINDOW
) -> QuizPerformance:
    """★ 答题表现信号的数据来源：**从 ``learning.db`` 读**（执行文档 §10.2 第三行）。

    只读 ``learning_history`` 里 ``activity="quiz"`` 且 ``is_correct`` 非空的行
    （最近 ``window`` 条），算出：

    - ``attempts`` / ``correct``：这一段窗口里的作答数与答对数（→ 正确率）；
    - ``current_streak``：**最近的连续**同一结果数（正 = 连对，负 = 连错）。

    桌面端**不需要**上交任何答题数据：库在服务端，服务端自己读 —— 少一次跨进程搬运，
    也少一处可能漂移的实现（票 14/15 写进去的记录在这里直接被用上）。
    """
    rows = store.conn.execute(
        "SELECT is_correct FROM learning_history "
        "WHERE activity = 'quiz' AND is_correct IS NOT NULL "
        "ORDER BY id DESC LIMIT ?",
        (int(window),),
    ).fetchall()
    if not rows:
        return QuizPerformance()

    flags = [int(row["is_correct"]) for row in rows]  # 最新在前
    streak = 0
    for flag in flags:
        if flag != flags[0]:
            break
        streak += 1
    return QuizPerformance(
        attempts=len(flags),
        correct=sum(flags),
        current_streak=streak if flags[0] == 1 else -streak,
    )


# --------------------------------------------------------------------------- #
# 引擎（IO 部分：读/写 learning.db）
# --------------------------------------------------------------------------- #
class GradeEngine:
    """一名学生的学段推断引擎（**一人一库**，用完即关连接，不跨学生复用）。

    调用方负责开库/关库：``routes/grade.py`` 用 ``open_learning_store`` 现开现关。
    """

    def __init__(self, store: LearningStore, *, default_level: str = DEFAULT_GRADE_LEVEL) -> None:
        self.store = store
        self.default_level = as_grade_level(default_level)

    # ------------------------------------------------------------ 冷启动 --
    def ensure_student(self, student_id: str) -> str:
        """确保学生行存在；不存在则建（默认小学高年级）并留一条**基线**轨迹。

        基线那行的 ``from_level`` 是 ``NULL``：它**不是一次变更**，
        因此不参与冷却期计算（否则学生会在第 5 轮前一直被误冷却）。
        """
        existing = self.store.get_student(student_id)
        if existing is not None:
            return as_grade_level(existing.grade_level)

        self.store.upsert_student(student_id, nickname="", grade_level=self.default_level)
        with self.store.conn:
            self.store.conn.execute(
                "INSERT INTO grade_history(ts, turn, from_level, to_level, source, confidence) "
                "VALUES(?,?,?,?,?,?)",
                (int(time.time()), 0, None, self.default_level, SOURCE_INFERRED, 0.0),
            )
        logger.info(
            "学段推断冷启动：%s 默认 %s（无历史 → 从第一轮开始推断）", student_id, self.default_level
        )
        return self.default_level

    # ------------------------------------------------------------ 读 --
    def current_level(self, student_id: str) -> GradeLevel:
        return as_grade_level(self.ensure_student(student_id))

    def verdicts(self, *, limit_rows: int = RECENT_SIGNAL_ROWS) -> list[TurnVerdict]:
        """从 ``grade_signals`` 还原**每一轮**的方向与强度（按**入库顺序** = 时间升序）。

        ★ 为什么按轮聚合：见 ``signals.TurnSignals`` 的说明 —— 一轮里的多条同向信号
        只算一轮，否则学生多说两句就能把学段推走一级。
        没有轮次锚点（``t<n>|``）的旧行会被跳过：它们不属于任何一轮，不该参与连续计数。

        ★ 分桶键是 ``(session_id, turn)`` 而**不是**光看 ``turn``（D1 ③）：轮次号是**每会话**
        计数器，换会话就从 1 重来，只按 ``turn`` 分桶会把「上一会话第 1 轮」与「本会话第 1 轮」
        的读数**求和**成同一轮 —— 两次不同交互的强度被叠加（各 0.2 合成 0.4），
        而 ``rule_confidence = 平均强度 × 1.5`` 直接吃这个和，于是**连续轮数**被虚报、
        置信度被抬高；反过来若两轮方向相反，还会互相抵消成一条中性轮，白丢一轮证据。
        按 ``(session_id, turn)`` 分桶后，一条信号只属于它真正的那个会话轮次。

        ⚠️ 仍未解决的部分（**跨端改动，本次不做**）：这里的顺序是**入库顺序**，
        而 ``turn`` 号本身仍然只是「会话内第几轮」—— 因此
        :func:`decide` 里的 ``turn`` / ``last_change_turn`` 比较仍是跨会话不可比的
        （靠 :func:`_cooldown_remaining` 钳位兜住）。严格解见那里。
        """
        rows = self.store.conn.execute(
            "SELECT raw, value, session_id FROM grade_signals ORDER BY id DESC LIMIT ?",
            (int(limit_rows),),
        ).fetchall()
        # 分桶键带上会话：同号不同会话是**两次不同的交互**，不能相加
        buckets: dict[tuple[str, int], list[float]] = {}
        for row in reversed(rows):  # 还原成时间升序
            turn, _evidence = decode_turn_raw(row["raw"])
            if turn is None:
                continue
            session = str(row["session_id"] or "")
            buckets.setdefault((session, turn), []).append(float(row["value"] or 0.0))

        verdicts: list[TurnVerdict] = []
        for (_session, turn), values in buckets.items():  # dict 保序 = 入库顺序
            total = sum(values)
            verdicts.append(
                TurnVerdict(turn=turn, direction=direction_of(total), strength=min(1.0, abs(total)))
            )
        return verdicts

    def last_change_turn(self) -> int | None:
        """上一次**真正发生变更**的轮次（``from_level`` 为空/相等的行不算）。"""
        row = self.store.conn.execute(
            "SELECT turn FROM grade_history "
            "WHERE from_level IS NOT NULL AND from_level <> to_level "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return int(row["turn"]) if row is not None and row["turn"] is not None else None

    def last_cooldown_anchor(self) -> tuple[int | None, str | None]:
        """最近一条 ``from_level`` 非空的 ``grade_history`` 行 → ``(turn, source)``。

        与 :meth:`last_change_turn` 的区别：它把「学生显式确认了当前学段」
        （``from_level == to_level`` 的 ``explicit`` 行）**也算作锚点** ——
        那种行当然不改变学段，但它是冷却期的起点（学生刚说「我就是初中」，
        系统当然不该马上把学段推走）。所以冷却读的是这一条，而不是只认真正变更的那条。

        返回 ``(None, None)`` = 库里还没有任何锚点（学生只有冷启动基线那一行）。
        """
        row = self.store.conn.execute(
            "SELECT turn, source FROM grade_history "
            "WHERE from_level IS NOT NULL ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None, None
        turn = int(row["turn"]) if row["turn"] is not None else None
        source = str(row["source"]) if row["source"] is not None else None
        return turn, source

    def turn_watermark(self) -> int:
        """当前轮次水位 = ``max(最近一轮信号里的轮次号, 最近一个冷却锚点的轮次号, 0)``。

        ★ 为什么手动覆盖的 ``turn`` 非要用它来算：桌面端交上来的轮次号是**每会话**计数器，
        服务端这一侧并不知道「现在第几轮」—— 只能从已知的痕迹里取一个**不小于**真实轮次的
        水位。手动覆盖多半发生在学生刚输入完一句话之后，此时 ``grade_signals`` 里
        正好有那一刻的轮次号；取两者较大值能保证写进 ``grade_history`` 的 ``turn``
        至少与当下同量级。

        不这么做的后果是实打实的：如果 override 图省事写 ``turn=0``，
        而学生是在**第 3 轮**点的切换，``state()`` 一算 ``elapsed = 3 - 0 = 3``，
        于是「冷却剩余 10」当场报成 7，第 3 轮再上交证据时直接报成 0 ——
        「10 轮内不再自动改学段」这条验收会**假绿**（窗口其实只有 7 轮）。
        """
        # 取最近一段信号的**轮次号最大值**（不是「最后一行」：批量上交时行序与轮次
        # 由调用方给定，取最大值才与 verdicts() 的口径一致）。
        rows = self.store.conn.execute(
            "SELECT raw FROM grade_signals ORDER BY id DESC LIMIT ?",
            (int(RECENT_SIGNAL_ROWS),),
        ).fetchall()
        signal_turns = [
            turn for turn, _evidence in (decode_turn_raw(row["raw"]) for row in rows) if turn is not None
        ]
        anchor_turn, _source = self.last_cooldown_anchor()
        return max([*signal_turns, int(anchor_turn or 0), 0])

    def recent_signals(self, limit: int = SIGNAL_LIST_LIMIT) -> list[GradeSignal]:
        """最近若干条信号（按时间升序；``raw`` 原样带上轮次锚点，便于对齐演示脚本）。"""
        rows = self.store.conn.execute(
            "SELECT ts, signal_type, value, raw FROM grade_signals ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [
            GradeSignal(
                signal_type=str(row["signal_type"]),  # type: ignore[arg-type]
                value=float(row["value"] or 0.0),
                raw=row["raw"],
                ts=int(row["ts"] or 0),
            )
            for row in reversed(rows)
        ]

    def history(self, limit: int = HISTORY_LIMIT) -> list[dict]:
        """``grade_history`` 轨迹（报告/汇报的叙事素材：「第 3 轮调为小学低年级（0.75）」）。"""
        rows = self.store.conn.execute(
            "SELECT ts, turn, from_level, to_level, source, confidence FROM grade_history "
            "ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [
            {
                "ts": int(row["ts"] or 0),
                "turn": int(row["turn"] or 0),
                "from_level": row["from_level"],
                "to_level": str(row["to_level"] or ""),
                "source": str(row["source"] or SOURCE_INFERRED),
                "confidence": float(row["confidence"] or 0.0),
            }
            for row in reversed(rows)
        ]

    def state(self, student_id: str) -> GradeState:
        """当前状态快照（当前学段 + 连续轮次 + 冷却 + 待生效建议）。"""
        level = self.current_level(student_id)
        verdicts = self.verdicts()
        last_change = self.last_change_turn()
        anchor_turn, anchor_source = self.last_cooldown_anchor()
        # 轮次水位要**同时**看信号与冷却锚点：手动覆盖可以在没有任何信号的轮次发生
        # （学生一进来就点切换），那时锚点就是唯一已知的轮次号（细节见 turn_watermark）。
        turn = self.turn_watermark()

        direction, streak = consecutive_same_direction(verdicts)
        window = verdicts[-streak:] if streak else []
        confidence = rule_confidence_for(window)

        decision = decide(
            current_level=level,
            turn=turn,
            verdicts=verdicts,
            proposal=None,
            last_change_turn=last_change,
            last_change_source=anchor_source,
        )
        suggested: GradeLevel | None = None
        if direction != 0 and streak >= SIGNALS_REQUIRED_FOR_CHANGE:
            # 「够格但被挡住」→ 给出目标（前端/报告可以显示「待生效：初中」）
            if decision.reason in (REASON_LOW_CONFIDENCE, REASON_COOLDOWN):
                suggested = _next_level(level, direction)

        return GradeState(
            student_id=student_id,
            grade_level=level,
            # 来源跟着最近一次写入走：手动覆盖后就是 explicit（学生端据此显示「手动选中」）。
            # 取不到（冷启动）**或取到历史遗留取值**（DDL 注释里还提过 ``confirmed``）时
            # 一律报 inferred：契约把这一项收窄成两种取值，外面那一个不能因为一行旧数据
            # 就把整个读接口打成 500。
            source=_contract_source(anchor_source),
            last_turn=turn,
            last_change_turn=last_change,
            cooldown_remaining=_cooldown_remaining(turn, anchor_turn, anchor_source),
            streak=streak,
            direction=direction,
            confidence=round(confidence, 4),
            suggested_level=suggested,
        )

    # ------------------------------------------------------------ 写 --
    def observe_turn(
        self,
        *,
        turn: int,
        text: str,
        student_id: str,
        session_id: str = "",
        quiz: QuizPerformance | None = None,
        proposal: GradeProposal | None = None,
        terminology: dict | None = None,
    ) -> GradeDecision:
        """**一轮对话的完整处理**：提取 → 写信号 → 判定 → （必要时）改学段。

        步骤顺序有意如此：信号**先落库**，判定再基于库里的连续证据做 ——
        所以即使判定失败（进程被杀），信号也不会丢，下一次调用照样能算出正确的连续轮次。
        """
        level = self.current_level(student_id)
        # ★ 答题表现由服务端**自己从 learning.db 读**（票 14/15 写进去的答题记录）；
        #   入参 `quiz` 只是覆盖项（演示脚本/单测用来喂一次特定表现，不必先造历史）。
        effective_quiz = quiz if quiz is not None else quiz_performance_from_history(self.store)
        turn_signals: TurnSignals = extract_turn_signals(
            text=text,
            turn=turn,
            current_level=level,
            session_id=session_id,
            quiz=effective_quiz,
            terminology=terminology,
        )

        for reading in turn_signals.evidence:
            self.store.add_grade_signal(
                signal_type=reading.signal_type,
                value=reading.value,
                raw=encode_turn_raw(turn, reading.raw),
                session_id=session_id,
            )

        verdicts = self.verdicts()
        last_change = self.last_change_turn()
        # 冷却窗口按**最近一次写入的来源**推导（手动覆盖后是 10 轮，自动调整是 5 轮）。
        _anchor_turn, anchor_source = self.last_cooldown_anchor()
        decision = decide(
            current_level=level,
            turn=turn,
            verdicts=verdicts,
            proposal=proposal,
            last_change_turn=last_change,
            last_change_source=anchor_source,
        )
        if decision.changed:
            decision = self._apply(decision, student_id=student_id, turn=turn)
            logger.info(
                "学段自动调整：%s %s → %s（第 %d 轮，置信度 %.2f，连续 %d 轮同向）",
                student_id,
                decision.previous_level,
                decision.target_level,
                turn,
                decision.confidence,
                decision.streak,
            )
        else:
            logger.debug(
                "学段保持不变：%s 第 %d 轮 reason=%s 置信度=%.2f 连续=%d 方向=%d",
                student_id,
                turn,
                decision.reason,
                decision.confidence,
                decision.streak,
                decision.direction,
            )

        return GradeDecision(
            student_id=student_id,
            turn=turn,
            decision=decision,
            readings=turn_signals.readings,
            history_turns=tuple(verdict.turn for verdict in verdicts),
        )

    def _apply(self, decision: Decision, *, student_id: str, turn: int) -> Decision:
        """把变更**原子性**写进 ``student`` + ``grade_history``（同一事务）。

        ★ **学段一变就清空当前章节**（``current_chapter = NULL``）：学生选了小学低年级的
          「第4章」，学段判定成初中之后那本教材就不存在了 —— 不清空就会出现
          「学段已是初中、Prompt 还说在学小学低年级第4章」这条**第二处真相**。
          ``current_chapter`` 是软偏好，清空只影响 Prompt 提示，不影响任何数据。
          ⚠️ 只在**真的换了学段**时清：本方法只在 ``decision.changed`` 为真时被调用
          （见 :meth:`decide_and_apply`），所以这条 UPDATE 天然不会误伤「学段没变」的情形。
        """
        try:
            with self.store.conn:  # 事务：两条要么都成功，要么都不生效
                self.store.conn.execute(
                    "UPDATE student SET grade_level = ?, current_chapter = NULL WHERE student_id = ?",
                    (decision.target_level, student_id),
                )
                self.store.conn.execute(
                    "INSERT INTO grade_history(ts, turn, from_level, to_level, source, confidence) "
                    "VALUES(?,?,?,?,?,?)",
                    (
                        int(time.time()),
                        int(turn),
                        decision.previous_level,
                        decision.target_level,
                        SOURCE_INFERRED,
                        float(decision.confidence),
                    ),
                )
        except sqlite3.Error as exc:  # 写不进去就**不等于改过**：把结果退回原学段
            logger.error("学段变更写入失败（本轮不改，学段仍为 %s）：%s", decision.previous_level, exc)
            return Decision(
                changed=False,
                reason=REASON_WRITE_FAILED,
                target_level=decision.previous_level,
                previous_level=decision.previous_level,
                direction=decision.direction,
                streak=decision.streak,
                confidence=decision.confidence,
                rule_confidence=decision.rule_confidence,
                llm_confidence=decision.llm_confidence,
                cooldown_remaining=decision.cooldown_remaining,
                degraded=decision.degraded,
            )
        return decision

    def override_level(self, *, student_id: str, level: str, turn: int | None = None) -> dict:
        """学生**手动**设定学段（唯一的人工写路径）。

        与自动推断共用同一张表与同一种轨迹行，差别只有两处：``source="explicit"``
        与更长的冷却窗口（:data:`MANUAL_COOLDOWN_TURNS`）。冷却机制不必改——
        它读的是「最近一条 ``from_level`` 非空的行」的来源（:meth:`last_cooldown_anchor`），
        这一行写下去就自动接管了。

        ``from_level`` **一律写切换前的值**，即使它与 ``to_level`` 相同：
        重复选同一个学段不改学段，但那一行仍然是「学生确认过当前学段」的留痕，
        也仍然是冷却期的锚点（否则学生点两下就等于白点，系统下一轮照样把他推走）。

        ``confidence = 1.0``：学生明确选择不是推断，不存在置信度这个量 ——
        写它只是不让该列留空，**不要**把它读成「引擎很确定学生是这个学段」。

        ``sqlite3.Error`` 不吞（照 :meth:`_apply` 的口径向上抛）：手动覆盖是学生按下去的
        一次动作，写不进去必须让调用方看见（路由层翻 503），而不是假装成功。

        ★ **换学段才清空当前章节**（``current_chapter = NULL``，与 :meth:`_apply` 同一口径）：
          学生重复点自己现在的学段 = **确认现状**，不是换教材 —— 顺手清掉他已经选好的章节
          会让学生「点一下学段，章节就没了」，那是纯粹的数据丢失。所以按 ``changed`` 分两条 SQL。
        """
        before = self.current_level(student_id)  # 顺带 ensure_student：冷启动学生也能切换
        target = as_grade_level(level)
        changed = before != target
        # 缺省用轮次水位：写 0 会让冷却在下一轮直接算成「已经过了好几轮」，详见 turn_watermark。
        effective_turn = self.turn_watermark() if turn is None else int(turn)
        try:
            with self.store.conn:  # 事务：student 与 grade_history 要么都成功，要么都不生效
                if changed:
                    self.store.conn.execute(
                        "UPDATE student SET grade_level = ?, current_chapter = NULL "
                        "WHERE student_id = ?",
                        (target, student_id),
                    )
                else:
                    self.store.conn.execute(
                        "UPDATE student SET grade_level = ? WHERE student_id = ?",
                        (target, student_id),
                    )
                self.store.conn.execute(
                    "INSERT INTO grade_history(ts, turn, from_level, to_level, source, confidence) "
                    "VALUES(?,?,?,?,?,?)",
                    (int(time.time()), effective_turn, before, target, SOURCE_EXPLICIT, 1.0),
                )
        except sqlite3.Error as exc:
            # 日志里只有 id / 学段 / 轮次 —— 手动切换不带学生文本，这里也不许顺手加。
            logger.error(
                "学段手动切换写入失败：student=%s %s → %s（第 %s 轮）", student_id, before, target, effective_turn
            )
            raise
        logger.info(
            "学段手动切换：%s %s → %s（第 %d 轮，之后 %d 轮内不再自动调整）",
            student_id,
            before,
            target,
            effective_turn,
            MANUAL_COOLDOWN_TURNS,
        )
        return {
            "grade_level": target,
            "previous_level": before,
            "changed": changed,
            "source": SOURCE_EXPLICIT,
            "turn": effective_turn,
            "cooldown_remaining_turns": MANUAL_COOLDOWN_TURNS,
        }


def _next_level(current: str, direction: int) -> GradeLevel | None:
    rank = rank_of(current)
    if rank is None:
        return None
    return level_at(rank + max(-MAX_STEP_LEVELS, min(MAX_STEP_LEVELS, direction)))


def _contract_source(source: str | None) -> str:
    """库里的 ``grade_history.source`` → 契约允许的两种取值之一。

    ``GradeSignals.source`` 是收窄的 ``Literal["inferred", "explicit"]``，
    而 ``grade_history`` 的列是宽松的 ``TEXT``（DDL 注释里还列着 ``confirmed``）。
    一行历史遗留取值不该让整个读接口 500，所以这里收敛到 ``inferred``；
    判定「手动还是自动」只看非 ``explicit`` 即非手动，收敛不会影响冷却窗口的选择。
    """
    return SOURCE_EXPLICIT if source == SOURCE_EXPLICIT else SOURCE_INFERRED


__all__ = [
    "CONFIDENCE_THRESHOLD",
    "COOLDOWN_TURNS",
    "DEFAULT_GRADE_LEVEL",
    "DECISION_ORDER",
    "DEGRADED_NO_LLM",
    "Decision",
    "GRADE_ORDER",
    "GradeDecision",
    "GradeEngine",
    "GradeProposal",
    "GradeState",
    "HISTORY_LIMIT",
    "LAYER2_FIRST_TURN",
    "LAYER2_RETRY_TURN",
    "MANUAL_COOLDOWN_TURNS",
    "MAX_RULE_CONFIDENCE",
    "MAX_STEP_LEVELS",
    "REASON_AT_BOUNDARY",
    "REASON_CHANGED",
    "REASON_COOLDOWN",
    "REASON_LLM_CONFLICT",
    "REASON_LOW_CONFIDENCE",
    "REASON_NO_DIRECTION",
    "REASON_WRITE_FAILED",
    "RECENT_SIGNAL_ROWS",
    "RULE_CONFIDENCE_GAIN",
    "QUIZ_HISTORY_WINDOW",
    "SIGNALS_REQUIRED_FOR_CHANGE",
    "SIGNAL_LIST_LIMIT",
    "SOURCE_EXPLICIT",
    "SOURCE_INFERRED",
    "TurnVerdict",
    "decide",
    "proposal_direction",
    "quiz_performance_from_history",
    "rule_confidence_for",
]
