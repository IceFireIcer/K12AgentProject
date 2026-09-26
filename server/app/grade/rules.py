# -*- coding: utf-8 -*-
"""学段推断的**规则引擎**（执行文档 §10.3，票 21）—— ★ **最终决策权在这里，不在 LLM**。

设计：**默认由系统推断并自动生效**，学生也可以**手动覆盖**（§ ``override_level``）——
手动是明确意图，写一条 ``grade_history(source="explicit")`` 的轨迹行，
之后进入更长的冷却（:data:`MANUAL_COOLDOWN_TURNS`），冷却期满再平滑回归自动。

- 第一层（每轮，**不调 LLM**）：``signals.py`` 的三路读数 → 写 ``grade_signals``；
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

> ⚠️ **轮次号是每会话计数器**（桌面端换会话就从 1 重来），而冷却算的是
> ``elapsed = turn - anchor_turn`` —— **两个值可能来自不同的轮次空间**。
> 这个偏差（D1）原先只做了安全裁剪，实测证明裁剪**不够**：锚点在旧会话时
> ``turn`` 常小于 ``anchor_turn``，``elapsed`` 被钳到 0，冷却就变成了**永不释放的锁**
> （实测 450 次判定里 50% 卡在 ``cooldown``，证据早就双双重超标）。
>
> **本次已按会话隔离解掉**（而不是全局单调序号）：``grade_history`` 有 ``session_id``
> 列（``store/migrations.py`` 的 v3），冷却只在**同一会话内**比较轮次、换会话即归零；
> ``verdicts()`` 的连续计数同理只认本会话。细节见 :func:`_cooldown_remaining`
> 与 :meth:`GradeEngine.verdicts` 的注释，接手时先读那两处。
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Sequence

from app.contracts import GradeLevel, GradeSignal, GradeSignalType
from app.grade.signals import (
    GRADE_ORDER,
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
from app.routes.students import (
    DEFAULT_COLD_START_GRADE,
    DEFAULT_STUDENT_NICKNAME,
    as_grade_level,
)
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
#:
#: ⚠️ 2026-09-21（D-066）起这两个值只描述「**规则决策期**内 LLM 可以提前给意见」的旧口径；
#: **决策权已移交给 LLM**，真正的门槛是下面的 :data:`LLM_DECIDES_FROM_TURN`。
LAYER2_FIRST_TURN = 3
LAYER2_RETRY_TURN = 5

#: ★★ **LLM 从第几个「累计轮次」起成为决策者**（D-066，2026-09-21；用户裁决）。
#:
#: 这是 D-020 那半条「LLM 只是提议、反向即否决」的**正面修订**：
#:
#: - **前 4 个累计轮次**：只有规则引擎在判（``decided_by="rules"``）——
#:   标签老实写「本地规则判定」，判不出来就**保持冷启动默认值**并显示「待判定」，
#:   **不冒充 AI 推算**（修掉「发一句『你好』就被标成『AI 引擎推算·小学高年级』」）；
#: - **第 5 个累计轮次起**：桌面端跑一次 LLM 判定，它的提议**直接定方向**
#:   （``decided_by="llm"``，标签「AI 引擎判定」）—— 规则引擎退居**安全网**，
#:   只保留 ④ 冷却、⑤ ±1 级/边界、以及 LLM 自报置信度的门槛；
#: - **LLM 不可用 / 调用失败**：规则照常接管（``decided_by="rules"``），标签回落。
#:
#: ★ 计数单位是「**累计轮次**」（跨会话连续，见 :meth:`GradeEngine.cumulative_turns`），
#: 与冷却的口径一致 —— 实测会话普遍只有 3–8 轮，按会话重数会让很多会话永远等不到 LLM。
LLM_DECIDES_FROM_TURN = 5

#: ``grade_history.decided_by``：当前学段是**哪一层**产出的。
#:
#: ★ 它回答的是「**哪一层判的**」，与 ``source``（「**谁写的**」：系统 / 学生）是**两个轴**：
#:
#: - ``source``     = ``inferred`` / ``explicit`` —— 学生手动指定过没有；
#: - ``decided_by`` = ``rules`` / ``llm`` / ``NULL`` —— 这次自动判定是规则还是 LLM 说的。
#:
#: 界面标签由两者共同决定：手动 → 「手动选中」；``llm`` → 「AI 引擎判定」；
#: ``rules`` → 「本地规则判定」；两者都取不到（冷启动基线）→ 「待判定」。
#: ★ explicit 行写 ``NULL``：那是学生的决定，谈不上哪层引擎。
DECIDED_BY_RULES = "rules"
DECIDED_BY_LLM = "llm"

#: 规则置信度的换算：``置信度 = min(上限, 平均强度 × 增益)``。
#: 单路差一级 = 0.5 强度 → ``0.5 × 1.5 = 0.75 ≥ 0.6``（三路单级证据刚好够）；
#: 三路弱证据（各 0.2）→ ``0.3 < 0.6``（不够，这是有意的）。
RULE_CONFIDENCE_GAIN = 1.5

#: 规则置信度的上限：**刻意留 0.1 给第二层**（有 LLM 复核时才可能更高），
#: 同时避免「规则置信度 1.0」给人「绝对确定」的错觉。
MAX_RULE_CONFIDENCE = 0.9

#: 冷启动默认学段（无历史 → **初中**），与 ``routes.students.DEFAULT_COLD_START_GRADE`` 同一口径。
#: ★ 2026-09-22 由「小学高年级」改成「初中」（D-073，用户裁决）：先按初中讲，再由 LLM 判定接手。
#:   ⚠️ 它只是**起点**而不是判定结果 —— 基线行的 ``decided_by`` 仍为空，界面显示「待判定」，
#:     不冒充任何一层引擎的结论（D-066 那条纪律在这里同样成立）。
DEFAULT_GRADE_LEVEL: GradeLevel = DEFAULT_COLD_START_GRADE

#: ``grade_history.source``：系统推断（规则引擎自己改的）。
SOURCE_INFERRED = "inferred"

#: ``grade_history.source``：学生手动选择（:meth:`GradeEngine.override_level` 写入）。
#: 表结构当初就预留了这个取值（``app/store/migrations.py`` 的列注释里本来就写着
#: ``explicit | inferred | confirmed``），所以放开它**不需要新增列或表**。
SOURCE_EXPLICIT = "explicit"

#: 从 ``grade_signals`` 里往回读多少行来还原「每轮方向」（够覆盖冷却期 + 连续窗口）。
#:
#: ★ 预算口径（M-10 之后每轮**至少**一行）：一轮最多写 3 行（三路各有证据），
#: 所以 120 行**最坏**覆盖 30 轮 —— 仍远大于「冷却期（10 轮）+ 连续窗口（3 轮）」，
#: 无论怎么组合都不会把判定期需要的轮次挤出窗口。逐轮写一行占位读数（见
#: :data:`NO_EVIDENCE_RAW`）只会让**无证据的轮次**从 0 行变成 1 行，不改变这个上界。
RECENT_SIGNAL_ROWS = 120

#: 「本轮三路都没有证据」时也要落的那一行读数（M-10）。
#:
#: ★ 为什么必须落：:meth:`GradeEngine.verdicts` 是**从 ``grade_signals`` 还原轮次**的 ——
#: 一行都不写的轮次在那张表里**不存在**，于是「连续 3 轮同向」实际退化成
#: 「3 个有证据的轮次」：隔一周、跨会话的三次同向证据也能累成「连续 3 轮」把学段推走。
#: 写一行值恒为 0 的占位读数，这一轮就会以**中性轮**的身份出现，
#: :func:`consecutive_same_direction` 于是照常被它打断（方向 0 = 证据断了）。
#:
#: ★ 为什么借用 ``vocab`` 这个类型：``grade_signals.signal_type`` 的取值由契约
#: （``contracts.GradeSignalType``）与 :data:`signals.SIGNAL_TYPES` 冻结为三路**证据通道**，
#: 里面没有「无证据」这一档；新增取值要同时改契约 / 提取器 / 前端标签（跨端改动，本次不做）。
#: 占位读数的 ``raw`` 明写「本轮无证据」、``value`` 恒为 0 —— 判定侧只把它读成一条中性轮，
#: 不会贡献任何方向或强度（:func:`mean_strength` 也会跳过方向为 0 的轮次）。
NO_EVIDENCE_SIGNAL_TYPE: GradeSignalType = "vocab"

#: 占位读数的 ``raw``（它**不是**证据摘要，只是一句可读的说明；绝不放学生原话）。
NO_EVIDENCE_RAW = "本轮无证据"

#: ``recent_signals()`` 用的 ``LIKE`` 模式：按 ``raw`` 末尾那句说明认出占位读数。
#: 真实证据的 ``raw`` 一律是「词表命中项」的形状（``口语=…`` / ``深度=…`` / …），
#: 不会以这句话结尾，所以这个过滤不会误伤任何真证据。
_NO_EVIDENCE_LIKE = f"%|{NO_EVIDENCE_RAW}"

#: ``GET /api/grade/signals`` 最多回多少条信号（Prompt/网络预算；证据够看就行）。
SIGNAL_LIST_LIMIT = 20

#: ``grade_history`` 的读取上限。
HISTORY_LIMIT = 50


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

#: 降级标注（``Decision.degraded``）：第二层**真的没跑成**时才置位。
DEGRADED_NO_LLM = "no_llm"

#: 桌面端报上来的 ``Layer2Status`` 里，**哪些才算真降级**。
#:
#: ★ 为什么需要这份白名单：``Layer2Status`` 有 8 个取值，而其中只有两个是「第二层没工作」：
#:
#: - ``no_llm``      —— 根本没接上模型通道（无 Key / 启动期降级）→ **真降级**；
#: - ``judge_error`` —— 接上了但调用失败（超时 / 解析不出 JSON）→ **真降级**。
#:
#: 其余取值都**不是**降级，最典型的是 ``already_proposed``（本窗口已经提过议了，
#: 一个窗口只判一次是**设计**）与 ``not_due``（还没到第 3 轮）。
#: 旧口径把后者一并报成 ``no_llm``，等于说「一台正常工作的机器坏了」——
#: 实测 436 次判定里 218 次被这么标，而其中 63 次第 3 轮里 48 次真的带上了提议。
#:
#: 这份白名单是**唯一**的判定点；``grade.ts`` 的 ``isDegradedLayer2()`` 是它的 TS 镜像，
#: 两边由 ``desktop/tests/grade-inference.test.ts`` 的一致性断言钉在一起。
DEGRADED_LAYER2_STATUSES: frozenset[str] = frozenset({DEGRADED_NO_LLM, "judge_error"})


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
    #: **哪一层产出了当前学段**（D-066）：``rules`` / ``llm`` / ``None``。
    #: ``None`` = 冷启动基线（还没判过）或学生手动指定的行 ——
    #: 界面标签由 ``source`` 与它共同决定（手动 → 手动选中；NULL → 待判定）。
    decided_by: str | None = None
    last_turn: int = 0
    last_change_turn: int | None = None
    cooldown_remaining: int = 0
    #: 末尾连续同方向的轮数与方向（``0`` = 没有连续证据）
    streak: int = 0
    direction: int = 0
    #: 规则的置信度（当前连续窗口）
    confidence: float = 0.0
    #: 「够格但被挡住」时给出目标学段（``None`` = 没有待生效的调整）
    suggested_level: GradeLevel | None = None


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
    #: 第二层的**通道状态**（由桌面端在请求里带上；见 ``DECISION`` 里的 ``degraded`` 说明）。
    #: ``None`` = 调用方没报（旧客户端），此时退回「没提议就报降级」的老口径。
    layer2_status: str | None = None
    #: **这一轮是谁定的**（``rules`` / ``llm``）。D-066 起由 :data:`LLM_DECIDES_FROM_TURN` 决定。
    decided_by: str | None = None


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
    anchor_source: str | None = None,
    elapsed_turns: int | None = None,
    anchor_turn: int | None = None,
    layer2_status: str | None = None,
    cumulative_turns: int | None = None,
) -> Decision:
    """规则引擎的决策核心（纯函数）。

    ``verdicts`` 是**按轮次升序**的读数序列（末尾是最近的轮）。判定顺序见 :data:`DECISION_ORDER`。

    ★★ ``anchor_source`` / ``elapsed_turns`` 是冷却锚点的**同一行**推出来的两个量 ——
    由 :meth:`GradeEngine.last_cooldown_anchor` 取出 ``(signal_mark, source, turn)``、
    再用 :meth:`GradeEngine.turns_since` 把位标换算成「之后又过了几轮」。
    :func:`_cooldown_remaining` 按**真实发生的轮数**算冷却，
    取代了原先那种拿两个会话的 ``turn`` 相减的做法（那会算出**永不释放**的锁，详见该函数）。

    ``anchor_turn`` 只在**兜底**时用：历史锚点没有信号位标（v3 迁移前写入）时退回旧的
    轮次钳位算法，保证老库不会比修复前更糟。

    ★★ **``cumulative_turns``（累计轮次）决定决策权归谁**（D-066）：
    ``None`` = 退回用 ``turn``（纯函数既有调用方与旧测试不必传）。

    默认全 ``None`` = 没有冷却约束（纯函数的既有调用方不必传）。
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

    # ★★ **谁说了算**（D-066）：到了累计第 N 轮，LLM 的提议**直接定方向**，
    #    规则引擎退居安全网（只剩冷却 / ±1 级 / 边界 / LLM 自报置信度的门槛）。
    cumulative = int(cumulative_turns) if cumulative_turns is not None else int(turn)
    llm_decides = proposal is not None and cumulative >= LLM_DECIDES_FROM_TURN
    decided_by = DECIDED_BY_LLM if llm_decides else DECIDED_BY_RULES

    # ★★ 降级标注（``degraded``）：**诚实报告第二层通道的状态**。
    #
    #  旧口径是 ``proposal is None and turn >= LAYER2_FIRST_TURN`` → 一律报 ``no_llm``。
    #  那是个**谎**：同一轮没有提议有多种原因，而「本窗口早就提过议了」
    #  （``already_proposed``）根本**不是降级** —— 它恰恰说明第二层正常工作过。
    #  实测后果（``logs/sidecar.log`` 5 天）：436 次判定里 218 次被标成 ``no_llm``，
    #  但其中 63 次第 3 轮判定里有 48 次**真的带上了提议** —— 标注与实际相反，
    #  报告叙事（「创新性：学段信号双层判定」）因此拿不出可信证据。
    #
    #  现在由**桌面端**把自己那一侧的通道状态（`Layer2Status`）带上来 ——
    #  只有它知道「是没接线、还是调用失败、还是本窗口已提过议」。
    #  服务端只做归类：**真降级**才置位，其余一律 ``None``。
    if layer2_status is not None:
        degraded = layer2_status if layer2_status in DEGRADED_LAYER2_STATUSES else None
    else:
        # 兼容旧客户端（没带状态）：沿用老口径 —— 宁可多报，不要漏报降级。
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
            else _cooldown_remaining(
                turn,
                anchor_source,
                elapsed_turns=elapsed_turns,
                anchor_turn=anchor_turn,
            )
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
            decided_by=decided_by,
        )

    # ★★ 决策权分支（D-066）。
    #
    # 【LLM 分支】到了累计第 5 轮且第二层给了提议：**提议直接定方向**，
    # 规则引擎不再参与「方向」与「方向一致性 / 置信度」这两条判定 ——
    # 那两条本来就是为「规则是决策者」设计的，套在 LLM 头上会让它永远只配当配角。
    # 但仍保留**三条安全网**（它们防的是「学段乱跳」，与「谁来判」无关）：
    #   ④ 冷却期 —— 刚调整过不立刻再调；
    #   ⑤ ±1 级 / 到顶到底 —— 一次最多动一级（体验保护，评分表明文验收）；
    #   LLM 自报置信度 < 0.6 → 不动（判定 prompt 里就是这么要求它的）。
    if llm_decides:
        # LLM 自己说「还是这个学段」→ 没有方向，本轮不动（不算降级也不算失败）
        if llm_direction == 0:
            return outcome(REASON_NO_DIRECTION, confidence=rule_confidence)

        # LLM 自报的把握度照旧是门槛（prompt 里要求「0.6 以上表示比较有把握」）
        llm_own = min(1.0, max(0.0, float(proposal.confidence))) if proposal is not None else 0.0
        if llm_own < CONFIDENCE_THRESHOLD:
            return outcome(REASON_LOW_CONFIDENCE, confidence=llm_own)

        # ④ 冷却期
        if (
            _cooldown_remaining(
                turn, anchor_source, elapsed_turns=elapsed_turns, anchor_turn=anchor_turn
            )
            > 0
        ):
            return outcome(REASON_COOLDOWN, confidence=llm_own)

        # ⑤ 单次最多动 MAX_STEP_LEVELS 级；到顶/到底则无可动
        step = max(-MAX_STEP_LEVELS, min(MAX_STEP_LEVELS, llm_direction))
        target = level_at(current_rank + step)
        if target is None or target == level:
            return outcome(REASON_AT_BOUNDARY, confidence=llm_own)

        return outcome(
            REASON_CHANGED, confidence=llm_own, changed=True, target=target
        )

    # 【规则分支】前 4 个累计轮次，或 LLM 不可用/调用失败 —— 规则引擎照旧全权判定。
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
    if (
        _cooldown_remaining(
            turn, anchor_source, elapsed_turns=elapsed_turns, anchor_turn=anchor_turn
        )
        > 0
    ):
        return outcome(REASON_COOLDOWN, confidence=confidence)

    # ⑤ 单次最多动 MAX_STEP_LEVELS 级；到顶/到底则无可动
    step = max(-MAX_STEP_LEVELS, min(MAX_STEP_LEVELS, direction))
    target = level_at(current_rank + step)
    if target is None or target == level:
        return outcome(REASON_AT_BOUNDARY, confidence=confidence)

    return outcome(REASON_CHANGED, confidence=confidence, changed=True, target=target)


def _cooldown_remaining(
    turn: int,
    anchor_source: str | None,
    *,
    elapsed_turns: int | None = None,
    anchor_turn: int | None = None,
) -> int:
    """距下次允许调整还剩几轮（``0`` = 现在就可以调）。

    窗口长度由来源推导 —— 手动（:data:`SOURCE_EXPLICIT`）用 :data:`MANUAL_COOLDOWN_TURNS`、
    其余用 :data:`COOLDOWN_TURNS`。**所以不需要为「手动冷却更长」新增列**：
    来源本来就在那一行里，冷却长度是它的函数。

    ``elapsed_turns`` = **锚点之后又发生了几个轮次**，由 :meth:`GradeEngine.turns_since`
    数出来。这是本次修复的核心：

    ★★ **为什么不再用「两个轮次号相减」**。``turn`` 是**每会话**计数器
    （桌面端换一个会话就从 1 重来），而锚点长期留在库里 ——
    于是 ``turn - anchor_turn`` 是**两个不同轮次空间相减**：新会话里 ``turn`` 常小于
    ``anchor_turn``，钳到 0 之后 ``remaining`` **恒等于整个窗口**，冷却成了**一把永不释放的锁**。

    实测（``logs/sidecar.log`` 5 天）：450 次判定里 ``reason=cooldown`` **226 次（50%）**，
    其中 ``连续=4 / 置信度 0.90`` 的达标证据照样不生效；锚点 ``turn=22`` 让随后每个会话的
    第 1–8 轮全部卡死，唯一出路是**在同一个会话里聊到第 23 轮**（实测会话上限 8 轮）。

    ``elapsed_turns`` 数的是**真实发生的交互轮数**（跨会话连续累计），
    所以既不依赖两个会话的 ``turn`` 可比，也不把冷却缩成 0 ——
    「调整后 5 轮 / 手动后 10 轮」两条口径于是**字面成立**（报告与验收都照旧这么说）。

    ⚠️ **兜底**：``elapsed_turns`` 为 ``None``（历史锚点没有信号位标 —— v3 迁移之前写入的行，
    位置已不可考）时，退回**旧的轮次钳位算法**，保证老库不会比修复前更糟：
    旧锚点最多再挡一个窗口，此后新锚点就带上位标了。
    """
    window = MANUAL_COOLDOWN_TURNS if anchor_source == SOURCE_EXPLICIT else COOLDOWN_TURNS
    if elapsed_turns is not None:
        return max(0, window - max(0, int(elapsed_turns)))
    # 兜底：历史锚点或调用方没给「已过几轮」→ 沿用旧的轮次钳位（绝不拉长）。
    if anchor_turn is None:
        return 0
    return max(0, window - max(0, int(turn) - int(anchor_turn)))


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
        """确保学生行存在；不存在则建（默认初中）并留一条**基线**轨迹。

        基线那行的 ``from_level`` 是 ``NULL``：它**不是一次变更**，
        因此不参与冷却期计算（否则学生会在第 5 轮前一直被误冷却）。

        ★ 建行时昵称用 :data:`routes.students.DEFAULT_STUDENT_NICKNAME`（**不许留空**）：
          本方法是「学段引擎先看到一个陌生人 id」时的落库点，而空昵称会一路传到
          学习记录页 / 侧栏（渲染侧只能回落成主键或留白，见 D-063 与报告 1.7）。
          口径与桌面端建号（``handlers-data.ts`` 的 ``nickname: '同学'``）一致。
          ⚠️ **不覆盖已有行**：``upsert_student`` 走 ``ON CONFLICT`` 分支会整行回写
             ``nickname`` —— 只在 ``existing is None`` 时调用它，所以学生自己改过的
             昵称不会被这里抹掉。
        """
        existing = self.store.get_student(student_id)
        if existing is not None:
            return as_grade_level(existing.grade_level)

        self.store.upsert_student(
            student_id, nickname=DEFAULT_STUDENT_NICKNAME, grade_level=self.default_level
        )
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

        ★★ **每轮至少一行**（M-10）：没有证据的轮次由 :data:`NO_EVIDENCE_RAW` 占位读数留痕，
        所以「这一轮存在且是中性轮」与「这一轮压根没来过」在库里是可区分的 ——
        前者出现在这里、方向为 0，会像任何一条中性轮那样**打断**连续
        （:func:`consecutive_same_direction` 遇到 ``direction == 0`` 直接返回 ``(0, 0)``）。
        ⚠️ 不要改成「没证据就不写」：那会让三次**隔着任意多轮空白**的同向证据累成
        「连续 3 轮」，与执行文档「连续 3 轮同方向」的口径不符。

        ★ 分桶键是 ``(session_id, turn)`` 而**不是**光看 ``turn``（D1 ③）：轮次号是**每会话**
        计数器，换会话就从 1 重来，只按 ``turn`` 分桶会把「上一会话第 1 轮」与「本会话第 1 轮」
        的读数**求和**成同一轮 —— 两次不同交互的强度被叠加（各 0.2 合成 0.4），
        而 ``rule_confidence = 平均强度 × 1.5`` 直接吃这个和，于是**连续轮数**被虚报、
        置信度被抬高；反过来若两轮方向相反，还会互相抵消成一条中性轮，白丢一轮证据。
        按 ``(session_id, turn)`` 分桶后，一条信号只属于它真正的那个会话轮次。

        ★★ **不按会话过滤**（有意为之）：连续计数问的是「他最近是不是一直在这样问」，
        换一个会话接着问仍然是同一个人在同方向地问。冷却改用单调的信号位标之后
        （见 :func:`_cooldown_remaining`），两个口径就统一了 —— 都不需要会话概念。
        ⚠️ 不要顺手加「只算本会话」：实测会话普遍只有 3–8 轮，那会让每个新会话
        都要从零重攒 3 轮，学生永远等不到适配。
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

    def cumulative_turns(self) -> int:
        """**累计轮次**：这个学生从第一次对话到现在一共聊了几轮（跨会话连续）。

        ★ 它是「第 5 轮起 LLM 接管」的计数单位（D-066）。**必须跨会话累计**：
        实测会话普遍只有 3–8 轮，按会话重数会让很多会话永远等不到 LLM ——
        而学生的学段是跟着**他这个人**走的，不是跟着某一次对话。

        口径与 :meth:`verdicts` 完全一致：按 ``(session_id, turn)`` 去重、
        跳过没有轮次锚点的旧行。用 SQL 直接数（不拉全表到 Python）：

        - ``substr(raw, 1, instr(raw,'|')-1)`` 取出 ``t<n>`` 这段轮次锚点；
        - 与 ``session_id`` 拼起来去重计数。
        """
        row = self.store.conn.execute(
            "SELECT COUNT(DISTINCT COALESCE(session_id, '') || '|' || "
            "substr(raw, 1, instr(raw, '|') - 1)) AS turns "
            "FROM grade_signals WHERE raw LIKE 't%|%'"
        ).fetchone()
        if row is None or row["turns"] is None:
            return 0
        return int(row["turns"])

    def last_change_turn(self) -> int | None:
        """上一次**真正发生变更**的轮次（``from_level`` 为空/相等的行不算）。"""
        row = self.store.conn.execute(
            "SELECT turn FROM grade_history "
            "WHERE from_level IS NOT NULL AND from_level <> to_level "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return int(row["turn"]) if row is not None and row["turn"] is not None else None

    def last_cooldown_anchor(self) -> tuple[int | None, str | None, int | None, str | None]:
        """最近一条 ``from_level`` 非空的 ``grade_history`` 行。

        返回 ``(signal_mark, source, turn, decided_by)``：

        - ``signal_mark`` = 写这行时 ``grade_signals`` 的**最大 id**（冷却的真正锚点）；
          它是 **AUTOINCREMENT、全局单调、跨会话连续** 的，所以「锚点之后过了几轮」
          可以直接由它算出来（见 :func:`_cooldown_remaining`）——
          这正是修掉「冷却永不释放」的关键。
        - ``source`` = 窗口长度的来源（手动 10 / 自动 5）。
        - ``turn`` = 那一行的轮次号，**只用于兜底**（``signal_mark`` 为 ``None`` 的历史行）。
        - ``decided_by`` = 那一行的判定层（``rules`` / ``llm`` / ``NULL``）。
          ★ ``NULL`` 有两种含义：D-066 之前写入的旧行，或**学生手动指定**的行 ——
          两种都由读取端按「``source`` 优先」处理（见 :meth:`state` 的标签口径）。

        与 :meth:`last_change_turn` 的区别：它把「学生显式确认了当前学段」
        （``from_level == to_level`` 的 ``explicit`` 行）**也算作锚点** ——
        那种行当然不改变学段，但它是冷却期的起点（学生刚说「我就是初中」，
        系统当然不该马上把学段推走）。所以冷却读的是这一条，而不是只认真正变更的那条。

        ★★ **四者必须一起用**（H-1 的纪律）：窗口长度取自 ``source``、位置取自
        ``signal_mark``、判定层取自 ``decided_by``。拆开取会让两个出口
        （``GET /grade/state`` 与 ``POST /grade/turns``）报出互相矛盾的值 ——
        那正是 P-094 被当成缺陷报上来的形态。

        返回 ``(None, None, None, None)`` = 库里还没有任何锚点（学生只有冷启动基线那一行）。
        """
        row = self.store.conn.execute(
            "SELECT signal_mark, source, turn, decided_by FROM grade_history "
            "WHERE from_level IS NOT NULL ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None, None, None, None
        mark = int(row["signal_mark"]) if row["signal_mark"] is not None else None
        source = str(row["source"]) if row["source"] is not None else None
        turn = int(row["turn"]) if row["turn"] is not None else None
        decided_by = str(row["decided_by"]) if row["decided_by"] is not None else None
        return mark, source, turn, decided_by

    def live_mark(self) -> int:
        """当前 ``grade_signals`` 的**最大 id**（``0`` = 表还是空的）。

        ★ 它是**信号位标**：AUTOINCREMENT、全局单调、跨会话连续。
        写作锚点用（``grade_history.signal_mark``），再由 :meth:`turns_since`
        换算成「之后又过了几轮」。``MAX(id)`` 走主键，表再大也是常数级开销。
        """
        row = self.store.conn.execute("SELECT MAX(id) AS mark FROM grade_signals").fetchone()
        if row is None or row["mark"] is None:
            return 0
        return int(row["mark"])

    def turns_since(self, mark: int | None) -> int | None:
        """信号位标 ``mark`` **之后又发生了几个轮次**（冷却的真正度量）。

        ★★ 为什么不直接 ``MAX(id) - mark``：**一轮最多写 3 行**（三路信号各有证据，
          M-10 又给每轮至少留下 1 行），所以 id 之差数的是**信号条数**而不是轮数 ——
          拿它当冷却会把 5 轮窗口缩成「一两轮就过完」。这里数的是
          **不同的 ``(session_id, turn)`` 桶**，与 :meth:`verdicts` 的分桶口径完全一致。

        ★ 数轮次**跨会话连续累计**（不按会话隔离）：冷却要回答的是
          「他上一次调整之后又聊了几轮」，换会话接着聊当然也算。
          这正是它比「两个会话的 ``turn`` 相减」强的地方 —— 后者算不出一把**永不释放的锁**
          （见 :func:`_cooldown_remaining`）。

        ``mark`` 为 ``None``（历史锚点没有位标）→ 返回 ``None``，
        调用方据此走兜底算法（绝不比修复前更糟）。
        """
        if mark is None:
            return None
        rows = self.store.conn.execute(
            "SELECT raw, session_id FROM grade_signals WHERE id > ? ORDER BY id",
            (int(mark),),
        ).fetchall()
        buckets: set[tuple[str, int]] = set()
        for row in rows:
            turn, _evidence = decode_turn_raw(row["raw"])
            if turn is None:
                continue  # 没有轮次锚点的旧行不属于任何一轮，与 verdicts() 同一口径
            buckets.add((str(row["session_id"] or ""), turn))
        return len(buckets)

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
        # ★ 锚点现在是 ``(signal_mark, source, turn)`` —— 水位要的是**第三个**（turn）。
        #   冷却已经不吃 ``turn`` 了（改用 signal_mark，见 _cooldown_remaining），
        #   但 ``grade_history.turn`` 仍要写一个合理值：它进报告叙事、也是
        #   「锚点没有位标」时的兜底算法的输入。
        _mark, _source, anchor_turn, _decided_by = self.last_cooldown_anchor()
        return max([*signal_turns, int(anchor_turn or 0), 0])

    def recent_signals(self, limit: int = SIGNAL_LIST_LIMIT) -> list[GradeSignal]:
        """最近若干条**证据**读数（按时间升序；``raw`` 原样带上轮次锚点，便于对齐演示脚本）。

        ★ **不含** :data:`NO_EVIDENCE_RAW` 占位读数（M-10）：那一行是给 :meth:`verdicts`
          还原轮次用的**账本**，不是从学生话里读出来的证据。它们要是跟着回传，界面与学习报告
          上会冒出「词汇复杂度 · 本轮无证据」这种卡片，还会把真正的证据挤出这个 20 条的列表
          —— 而「每轮都可能是无证据轮」正是 D2 的常态（课堂用语不许产生信号），
          连续几轮「继续吧」就能把证据列表刷空。**所以过滤只发生在这里，判定侧照常读全表。**

        ★★ **脏行容错**（P1-2，实测）：``signal_type`` 列是宽松 ``TEXT``，而
          :class:`GradeSignal` 的 ``signal_type`` 是**收窄联合**。历史库 / 人工改过的库里
          可能出现认不出的取值（空串、``NULL``、升级前写入的旧字面量），
          构造 ``GradeSignal`` 会抛 pydantic ``ValidationError`` —— 那**不是**
          ``sqlite3.Error``，路由层的兜底拦不住，``GET /api/grade/signals`` 于是整个
          500（现象：同栏「当前学段」正常、信号列表报 500，非常迷惑）。
          这里跳过认不出的行并记日志：一行脏数据不该打掉整个读接口。
        """
        rows = self.store.conn.execute(
            "SELECT ts, signal_type, value, raw FROM grade_signals "
            "WHERE raw IS NULL OR raw NOT LIKE ? "  # 占位读数是轮次账本，不是证据
            "ORDER BY id DESC LIMIT ?",
            (_NO_EVIDENCE_LIKE, int(limit)),
        ).fetchall()
        out: list[GradeSignal] = []
        for row in reversed(rows):
            try:
                out.append(
                    GradeSignal(
                        signal_type=str(row["signal_type"]),  # type: ignore[arg-type]
                        value=float(row["value"] or 0.0),
                        raw=row["raw"],
                        ts=int(row["ts"] or 0),
                    )
                )
            except Exception:  # noqa: BLE001 - pydantic ValidationError 不在 sqlite3.Error 里
                logger.warning(
                    "跳过一条无法归类的学段信号（signal_type=%r，value=%r）",
                    row["signal_type"],
                    row["value"],
                )
        return out

    def history(self, limit: int = HISTORY_LIMIT) -> list[dict]:
        """``grade_history`` 轨迹（报告/汇报的叙事素材：「第 3 轮调为小学低年级（0.75）」）。

        ``decided_by`` 一并带出（D-066）：报告要能区分「第 3 轮**本地规则判定**为初中」
        与「第 12 轮**AI 引擎判定**为高中」—— 那是两种不同的证据，
        也是「双层判定」这条创新性叙事在报告里唯一的落地形式。
        """
        rows = self.store.conn.execute(
            "SELECT ts, turn, from_level, to_level, source, confidence, decided_by "
            "FROM grade_history ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [
            {
                "ts": int(row["ts"] or 0),
                "turn": int(row["turn"] or 0),
                "from_level": row["from_level"],
                "to_level": str(row["to_level"] or ""),
                "source": str(row["source"] or SOURCE_INFERRED),
                # ★ NULL 照原样透出（历史行 / 手动行）——**不猜**，
                #   读取端把它显示成「手动选中」或留空，而不是编一个层级出来。
                "decided_by": str(row["decided_by"]) if row["decided_by"] else None,
                "confidence": float(row["confidence"] or 0.0),
            }
            for row in reversed(rows)
        ]

    def state(self, student_id: str) -> GradeState:
        """当前状态快照（当前学段 + 连续轮次 + 冷却 + 待生效建议）。

        ★★ 本方法报的冷却值必须与 :meth:`observe_turn` **一致**（H-1 的回声）：
        两者读同一行锚点、用同一套 ``_cooldown_remaining`` 参数
        （``anchor_mark`` / ``anchor_source`` / ``live_mark``）。
        少传一个就会让「读状态说还剩 10 轮」和「上交证据说剩 0 轮」同时成立 ——
        那正是 P-094 被当成缺陷报上来的形态，不要再制造一次。
        """
        level = self.current_level(student_id)
        verdicts = self.verdicts()
        # ★★ 两个「上一次」不是一回事（H-1 的根源）：
        #   - `last_change` = 上一次**真正变更**的轮次（from<>to）→ **只作展示字段**
        #     （`GradeState.last_change_turn` / `GradeStateOut.lastChangeTurn`，界面与报告用它）；
        #   - `anchor_mark` / `anchor_source` = 最近一次**写入** grade_history 的那一行
        #     （含「学生确认了当前学段」这种 from==to 的 explicit 行）→ **冷却读的是这一条**，
        #     而且必须成组取出（窗口长度取自 source、位置取自 signal_mark）。
        last_change = self.last_change_turn()
        anchor_mark, anchor_source, anchor_turn, anchor_decided_by = self.last_cooldown_anchor()
        # 轮次水位要**同时**看信号与冷却锚点：手动覆盖可以在没有任何信号的轮次发生
        # （学生一进来就点切换），那时锚点就是唯一已知的轮次号（细节见 turn_watermark）。
        turn = self.turn_watermark()
        # ★ 冷却的度量：锚点之后**真实又发生了几轮**（跨会话连续累计）。
        elapsed = self.turns_since(anchor_mark)

        direction, streak = consecutive_same_direction(verdicts)
        window = verdicts[-streak:] if streak else []
        confidence = rule_confidence_for(window)

        decision = decide(
            current_level=level,
            turn=turn,
            verdicts=verdicts,
            proposal=None,
            anchor_source=anchor_source,
            elapsed_turns=elapsed,
            anchor_turn=anchor_turn,
            cumulative_turns=self.cumulative_turns(),
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
            # ★ 判定层跟着**同一行**走（H-1 的纪律）：``NULL`` = 旧行，或学生手动指定的行
            #   （那种行 ``source`` 是 explicit，标签由它接管）。两者都取不到 → 「待判定」。
            decided_by=anchor_decided_by,
            last_turn=turn,
            last_change_turn=last_change,
            cooldown_remaining=_cooldown_remaining(
                turn,
                anchor_source,
                elapsed_turns=elapsed,
                anchor_turn=anchor_turn,
            ),
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
        proposal: GradeProposal | None = None,
        terminology: dict | None = None,
        layer2_status: str | None = None,
    ) -> GradeDecision:
        """**一轮对话的完整处理**：提取 → 写信号 → 判定 → （必要时）改学段。

        步骤顺序有意如此：信号**先落库**，判定再基于库里的连续证据做 ——
        所以即使判定失败（进程被杀），信号也不会丢，下一次调用照样能算出正确的连续轮次。

        ★ 证据**只来自 ``text``**（学生这一轮的原文）+ ``proposal``（第二层的 LLM 提议）。
        原先还有一个 ``quiz`` 入参（答题表现）—— 2026-09-21 随那条信号一起移除：
        它把「知识点没掌握」当成「学段更低」，还会从原文里捡「太难了」重复计数。
        """
        level = self.current_level(student_id)
        turn_signals: TurnSignals = extract_turn_signals(
            text=text,
            turn=turn,
            current_level=level,
            session_id=session_id,
            terminology=terminology,
        )

        for reading in turn_signals.evidence:
            self.store.add_grade_signal(
                signal_type=reading.signal_type,
                value=reading.value,
                raw=encode_turn_raw(turn, reading.raw),
                session_id=session_id,
            )
        if not turn_signals.evidence:
            # ★★ 三路全空的轮次也要留一行（M-10）：「连续 3 轮同方向」的**单位是轮**，
            #   而轮次是从 ``grade_signals`` 的轮次锚点还原出来的（:meth:`verdicts`）——
            #   一行都不写，这一轮在那张表里就不存在，连续计数会**跨过它**继续累加。
            #   实测后果：第 1 轮童言 + 第 2..8 轮全无证据（不留行）+ 第 9、10 轮童言
            #   → 累成「连续 3 轮同向」并把学段改走（其中两轮间隔一周、跨了会话）。
            #   写一行值恒为 0 的占位读数，它就变成一条**中性轮**：既参与「这一轮来过」的事实，
            #   又照常打断连续（:func:`consecutive_same_direction` 见 0 即返回 ``(0, 0)``）。
            self.store.add_grade_signal(
                signal_type=NO_EVIDENCE_SIGNAL_TYPE,
                value=0.0,
                raw=encode_turn_raw(turn, NO_EVIDENCE_RAW),
                session_id=session_id,
            )

        # ★ 连续轮次**跨会话摊平**（不按会话隔离）：证据属于**学生**，不属于某一段对话。
        #   「连续 3 轮同向」问的是「他最近是不是一直在这样问」—— 换一个会话继续问，
        #   那仍然是他连续在这样问。冷却改用单调的信号位标之后（见 _cooldown_remaining），
        #   这里也不再需要会话概念，两个口径由此统一。
        #   ⚠️ 不要顺手加回「按会话过滤」：那会让每个新会话都要重新攒 3 轮，
        #   而实测会话普遍只有 3–8 轮 —— 学生永远等不到适配。
        verdicts = self.verdicts()
        # ★★ 冷却锚点必须是**同一行**的一组（H-1）：
        #   窗口长度取自 `anchor_source`、位置取自 `anchor_mark`（信号位标）；
        #   三者都来自 :meth:`last_cooldown_anchor`（认「任何 from_level 非空的行」，
        #   含学生显式确认当前学段的那一行）。**绝不要**把 `anchor_mark` 换成
        #   :meth:`last_change_turn`（它只认 from<>to 的真变更，拿不到「学生刚确认了当前学段
        #   但学段没变」那一行）—— 那会让手动冷却当场失效，并与 `GET /api/grade/state`
        #   报出的冷却值互相矛盾（实测缺陷 H-1）。
        anchor_mark, anchor_source, anchor_turn, _anchor_decided_by = self.last_cooldown_anchor()
        # ★ 冷却度量：锚点之后真实又发生了几轮。注意要**先**算它、**再**写本轮的信号 ——
        #   本轮的读数还没入库时，"anchor_mark 之后的轮次" 不含本轮（这正是我们要的：
        #   本轮是第 N 轮，冷却要数的就是它之前已经走过的轮数）。
        elapsed = self.turns_since(anchor_mark)
        mark = self.live_mark()
        decision = decide(
            current_level=level,
            turn=turn,
            verdicts=verdicts,
            proposal=proposal,
            anchor_source=anchor_source,
            elapsed_turns=elapsed,
            anchor_turn=anchor_turn,
            layer2_status=layer2_status,
            cumulative_turns=self.cumulative_turns(),
        )
        if decision.changed:
            decision = self._apply(
                decision, student_id=student_id, turn=turn, signal_mark=mark
            )
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

    def _apply(
        self, decision: Decision, *, student_id: str, turn: int, signal_mark: int | None = None
    ) -> Decision:
        """把变更**原子性**写进 ``student`` + ``grade_history``（同一事务）。

        ★ **学段一变就清空当前章节**（``current_chapter = NULL``）：学生选了小学低年级的
          「第4章」，学段判定成初中之后那本教材就不存在了 —— 不清空就会出现
          「学段已是初中、Prompt 还说在学小学低年级第4章」这条**第二处真相**。
          ``current_chapter`` 是软偏好，清空只影响 Prompt 提示，不影响任何数据。
          ⚠️ 只在**真的换了学段**时清：本方法只在 ``decision.changed`` 为真时被调用
          （见 :meth:`decide_and_apply`），所以这条 UPDATE 天然不会误伤「学段没变」的情形。

        ``signal_mark`` 写进轨迹行：这一行同时是**下一个冷却窗口的锚点**，
        所以必须记下它当时在信号序列里的位置 —— 否则下一个新会话读到「不知道在哪」的锚点，
        冷却又会退回那把永不释放的锁（见 :func:`_cooldown_remaining`）。
        """
        try:
            with self.store.conn:  # 事务：两条要么都成功，要么都不生效
                self.store.conn.execute(
                    "UPDATE student SET grade_level = ?, current_chapter = NULL WHERE student_id = ?",
                    (decision.target_level, student_id),
                )
                self.store.conn.execute(
                    "INSERT INTO grade_history"
                    "(ts, turn, from_level, to_level, source, confidence, signal_mark, decided_by) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (
                        int(time.time()),
                        int(turn),
                        decision.previous_level,
                        decision.target_level,
                        SOURCE_INFERRED,
                        float(decision.confidence),
                        signal_mark,
                        decision.decided_by,
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
                decided_by=decision.decided_by,
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

        ★★ ``signal_mark``（写这一行时 ``grade_signals`` 的最大 id）**由本方法自己取**：
          它是下一个冷却窗口的锚点，而手动选的 10 轮保护**跨会话照常成立**
          （学生换一个会话接着说，那依然是他刚做完的一次明确选择），
          所以要记的是**信号序列里的位置**（全局单调），不是会话。
          这也是「手动冷却 10 轮」这条验收能字面成立的原因。
        """
        before = self.current_level(student_id)  # 顺带 ensure_student：冷启动学生也能切换
        target = as_grade_level(level)
        changed = before != target
        # 缺省用轮次水位：写 0 会让冷却在下一轮直接算成「已经过了好几轮」，详见 turn_watermark。
        effective_turn = self.turn_watermark() if turn is None else int(turn)
        mark = self.live_mark()
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
                    "INSERT INTO grade_history"
                    "(ts, turn, from_level, to_level, source, confidence, signal_mark) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (
                        int(time.time()),
                        effective_turn,
                        before,
                        target,
                        SOURCE_EXPLICIT,
                        1.0,
                        mark,
                    ),
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
    "NO_EVIDENCE_RAW",
    "NO_EVIDENCE_SIGNAL_TYPE",
    "REASON_AT_BOUNDARY",
    "REASON_CHANGED",
    "REASON_COOLDOWN",
    "REASON_LLM_CONFLICT",
    "REASON_LOW_CONFIDENCE",
    "REASON_NO_DIRECTION",
    "REASON_WRITE_FAILED",
    "RECENT_SIGNAL_ROWS",
    "RULE_CONFIDENCE_GAIN",
    "SIGNALS_REQUIRED_FOR_CHANGE",
    "SIGNAL_LIST_LIMIT",
    "SOURCE_EXPLICIT",
    "SOURCE_INFERRED",
    "TurnVerdict",
    "decide",
    "proposal_direction",
    "rule_confidence_for",
]
