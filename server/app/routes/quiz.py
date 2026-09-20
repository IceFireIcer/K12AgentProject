"""练习路由（票 14 客观题 + 票 15 主观题/变式/闯关闭环）。

四条端点，各自只做一件事，且都守住同一条红线：**标准答案出不了 Python**。

| 端点 | 做什么 | 红线 |
| --- | --- | --- |
| ``GET /api/quiz/bank/{kp_id}`` | 按知识点 + 学段从题库取题 | 返回 :class:`QuizQuestionOut`（**没有** ``answer``）；内部 :class:`QuizQuestion` 一步都不出这个文件 |
| ``POST /api/quiz/grade`` | 按 ``qid`` 查库 → **规则**判分 → 写掌握度与学习记录 | 判分**只在这里**做；请求里的 ``answer`` 是学生的作答，不是标准答案 |
| ``POST /api/quiz/variants`` | 登记 LLM 生成的变式题（含标准答案），返回**对外**载荷 | 答案只进 ``learning.db``，出参仍走 :class:`QuizQuestionOut` |
| ``POST /api/quiz/grade-subjective`` | 落库**模型**判分的主观题结论（LLM 调用在 TS 侧） | 只接受**主观题**（有评分细则）的 ``qid``，客观题走这条一律 409 |

**为什么规则判分必须留在这里**（执行文档 §6.3 的答案泄漏防护）：前端拿到题面就能作答，
只有「拿学生的作答去和库里的答案比」这一步必须留在后端；一旦把答案下发给前端、
或者让前端本地判分，答案就等于公开 —— 题目当场作废，``mastery`` 也不再可信。

**为什么主观题判分反而是「TS 判、Python 落库」**（票 15 的关键分叉）：编排层在
Electron 主进程（Pi），LLM 调用归它独占；**Python 侧不许装任何 LLM 客户端**。
所以主观题的批改结论由 TS 侧用评分细则问出来，再交给本文件的
``POST /api/quiz/grade-subjective`` 落库。为了让这条路径**不能被用来绕过规则判分**：
只有「登记过评分细则的生成题」才走得通 —— 拿一道选择题的 ``qid`` 走主观路径直接 409。

**闯关闭环（票 15 / 关卡 D）**：``progress`` 表是**唯一权威**（前端只读、不自持状态机）。
状态机是纯函数 :func:`advance_stage`，解锁规则是 :func:`unlocked_successor_ids`；
两者都被 ``server/tests/test_quiz_loop.py`` 端到端跑过。

**判分口径（客观题，``scored_by="rule"``）**：choice / blank / code_blank 三类都走
:func:`normalize_answer` 归一化后比较 —— 空白、全角、大小写、中英文标点一律等价
（业务陷阱清单 §「客观题误判」）。归一化只影响**比较**，不影响落库与回显。
"""

from __future__ import annotations

import heapq
import json
import logging
import os
import re
import secrets
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Collection, Iterable, Sequence

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import Field, field_validator

from app.config import KNOWLEDGE_DIR, RESOURCES_DIR
from app.contracts import (
    MASTERY_DELTA_LIMIT,
    CamelModel,
    GradeLevel,
    QuizGradeRequest,
    QuizPayload,
    QuizQuestion,
    QuizQuestionOut,
    QuizQuestionType,
    QuizResult,
)
from app.knowledge.library import (
    GRADE_LEVELS,
    compatible_grades,
    grade_index,
    load_terminology,
)
from app.routes.students import (
    DEFAULT_COLD_START_GRADE,
    as_grade_level,
    open_learning_store,
    require_data_dir,
    student_learning_db_path,
)
from app.store.learning import GeneratedQuestionRecord, LearningStore, ProgressRecord

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["quiz"])

# ---------------------------------------------------------------- 常量 --
#: 题库目录名（``server/resources/quizbank/``）
QUIZ_BANK_DIRNAME = "quizbank"
#: ``app.state`` 上的题库目录注入点（测试与演示用临时题库）
BANK_DIR_STATE_ATTR = "quiz_bank_dir"
#: 环境变量覆盖（演示时指向「故意少题」的那一份）
BANK_DIR_ENV = "K12_QUIZ_BANK_DIR"

DEFAULT_QUESTION_COUNT = 3
MAX_QUESTION_COUNT = 10

#: 冷启动学段（与 ``app/routes/students.py`` 的同名常量同源 —— 从那里 import，
#: 免得两处各写一个默认值，将来改一个忘一个）。
COLD_START_GRADE = DEFAULT_COLD_START_GRADE

#: ★ 冷启动的**种子关卡**：依赖图里一个可用知识点都没有时的最后兜底
#: （人工骨架的四个入口知识点，见 ``knowledge/manifest.json``）。
#: 没有它的话，「新学生 + 空图」会得到一条空路径 —— 而冷启动必须能开始，
#: 这是票 15/20 明确列出的验收项（「不报空指针、有默认路径」）。
#:
#: ★ 它是**按学段**给的（不是一条固定两关的列表）：给小学高年级学生一个初中知识点
#:   会得到一条取题必然 404 的死关 —— 与关卡路径同一个学段口径（见 :func:`_allowed_grades`）。
#:
#: ⚠️ 2026-09-19 随 K12KnowledgeBase 接入更新：新库的入口根是
#:   ``ai-definition-pl``（「人工智能的定义」，小学低年级），它同时是整张依赖图的根，
#:   对四个学段都在兼容范围内，因此是所有分支共同的兜底。
#:   每个学段再各给一个**本学段**的起点，让路径不必都从小学低年级那一条线开始走。
COLD_START_LEVEL_SEEDS: dict[str, tuple[str, ...]] = {
    "primary_low": ("ai-definition-pl",),
    "primary_high": ("ai-definition-ph",),
    "junior": ("ai-definition-jr",),
    "senior": ("ai-definition-sr",),
}

#: 种子兜底**退无可退**时的起点：全图的唯一根（``primary_low``），任何学段都兼容。
COLD_START_LEVEL_SEED_FALLBACK: tuple[str, ...] = ("ai-definition-pl",)

#: 一次答对/答错的掌握度变化。**绝对值必须 < MASTERY_DELTA_LIMIT**，
#: 并且 :meth:`app.store.learning.LearningStore.apply_mastery` 还会再限幅一次
#: （陷阱：不限幅则一次答题就从 0 直接到 1）。
MASTERY_GAIN_CORRECT = 0.15
MASTERY_LOSS_WRONG = 0.10

#: 选择题选项序号（学生可能提交 ``B``、也可能提交选项原文，两种都要认）
_OPTION_LETTERS = "ABCDEF"

#: 学生 id 白名单：它会被拼进文件路径（``students/<id>/learning.db``），
#: **必须**先卡死字符集，否则 ``../../`` 就能跑到别的目录去建库（本机任意文件写入）。
STUDENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# ------------------------------------------------------------------ 闯关 --
#: 关卡状态机（``contracts.py`` 的 ``ProgressStage``，**唯一权威在 learning.db 的 progress 表**）。
PROGRESS_STAGES: tuple[str, ...] = ("locked", "learning", "quizzed", "mastered")

#: 一道题的分值：一次答对 ``quizzed + 1``。**不是掌握度**（掌握度按题累加、限幅 ±0.2）。
#: ``progress`` 表没有数值列，所以「答对几道」记在徽章里（见 :func:`award_level`）。
BADGE_LEVELS: tuple[str, ...] = ("起步", "初通", "熟练", "精通", "大师")

#: ★ 解锁后继关卡的**门槛**（票 15 的验收口径，写在这里以便测试直接引用）：
#:
#:     「目标 kp 掌握度 ≥ 阈值 且 当前 kp 已 quizzed」才解锁**后继**
#:
#: 注意主语：判定的是**当前这一关**够不够格把**它的后继**放出来，而不是后继自己的掌握度。
MASTERY_UNLOCK_THRESHOLD = 0.6
#: 当前关卡进入 ``quizzed`` 所需的答对题数（答错不加，答对才加）。
QUIZZED_CORRECT_NEEDED = 1
#: 当前关卡进入 ``mastered`` 所需的答对题数（**且**掌握度还要过阈值）。
MASTERED_CORRECT_NEEDED = 2


@dataclass(frozen=True)
class LevelOutcome:
    """一次答题对闯关进度的影响（供出参与日志；**不含答案信息**）。"""

    kp_id: str
    stage: str
    badge: str | None
    correct_count: int
    #: 本次是否**新解锁**了关卡（题目所属关卡按 ``K12_QUIZ_BANK_DIR``… 不，按依赖图后继算）
    unlocked: tuple[str, ...] = ()

    @property
    def badge_level(self) -> int:
        """徽章档位（1 起步 … 5 大师）；无徽章为 0。"""
        if not self.badge:
            return 0
        try:
            return BADGE_LEVELS.index(self.badge.split("-", 1)[0]) + 1
        except ValueError:  # pragma: no cover - 库被人手改过
            return 0


def badge_for(correct_count: int) -> str | None:
    """答对题数 → 徽章（``0`` = 还没有徽章，**不是**「徽章被撤销」）。

    徽章文本形如 ``熟练-3``：前半是**档位名**，后半是**答对题数**。
    档位封顶在 :data:`BADGE_LEVELS` 的最后一档（练 20 遍不会变成「大师-20」而是一个
    稳定的「大师」档），避免徽章变成刷题计数器而与掌握度脱节；
    但 ``-N`` 里的 N 仍如实记录，以便 :func:`correct_count_from_badge` 还原计数。
    """
    if correct_count <= 0:
        return None
    index = min(correct_count, len(BADGE_LEVELS)) - 1
    return f"{BADGE_LEVELS[index]}-{correct_count}"


def correct_count_from_badge(badge: str | None) -> int:
    """从徽章文本还原答对题数（**徽章是唯一的计数载体**，见 :data:`BADGE_LEVELS`）。

    认不出就返回 0（库被人手改过时退回「这一关还没答对」），绝不抛异常 ——
    它不是判分依据，只用于状态机推进。
    """
    if not badge:
        return 0
    _, _, tail = badge.partition("-")
    try:
        return max(0, int(tail))
    except ValueError:
        return 0


def advance_stage(
    *,
    current_stage: str | None,
    mastery_score: float,
    correct_count: int,
) -> str:
    """关卡状态机的**唯一实现**（纯函数，可单测）。

    ``locked → learning → quizzed → mastered``，单调不回退：

    | 目标状态 | 条件 |
    | --- | --- |
    | ``learning`` | 学生开始做这一关的题（第一次作答即进入） |
    | ``quizzed`` | 答对 ≥ :data:`QUIZZED_CORRECT_NEEDED` 道 |
    | ``mastered`` | 答对 ≥ :data:`MASTERED_CORRECT_NEEDED` 道 **且** 掌握度 ≥ 阈值 |

    ★ **答错不改状态**（只让 ``correct_count`` 不增长）：状态**单调**是刻意的 ——
    如果答错能把 ``quizzed`` 打回 ``learning``，学生看到的是「我的进度条倒着走」，
    而掌握度那边已经在如实下降了（``mastery`` 才是能力，``progress`` 是走过没走过）。
    这也让「关卡进度」「掌握度」两个量各自承担意义，不会互相污染。
    """
    if correct_count <= 0:
        return "learning"
    if current_stage == "mastered":
        return "mastered"
    if correct_count >= MASTERED_CORRECT_NEEDED and mastery_score >= MASTERY_UNLOCK_THRESHOLD:
        return "mastered"
    if correct_count >= QUIZZED_CORRECT_NEEDED:
        return "quizzed"
    return "learning"


def unlocked_successor_ids(
    *,
    current_kp_id: str,
    current_stage: str,
    mastery_score: float,
    successor_ids: Sequence[str],
) -> list[str]:
    """★ 解锁条件（票 15 验收口径）：**「当前 kp 已 quizzed 且 当前 kp 掌握度 ≥ 阈值」才解锁后继**。

    ``successor_ids`` 由调用方从依赖图取（``from → to``，见 ``app/knowledge/deps.py``）——
    本函数**不做图遍历**，只做规则判定（图的数据来源与本函数的职责分开，
    这样「图拿错了」和「规则判错了」是两件可分别定位的事）。

    答错时掌握度会掉、``stage`` 也不会到 ``quizzed``，因此**关卡保持锁定**。
    """
    if not successor_ids:
        return []
    if current_stage not in ("quizzed", "mastered"):
        return []
    if mastery_score < MASTERY_UNLOCK_THRESHOLD:
        return []
    return [kp for kp in successor_ids if kp and kp != current_kp_id]


def level_order_from_graph(
    conn,
    *,
    start_kp_ids: Sequence[str],
    limit: int | None = None,
    max_depth: int | None = None,
    allowed_grades: Sequence[str] | None = None,
) -> list[str]:
    """按**依赖图拓扑序**给出关卡顺序（票 15：「关卡顺序由依赖图拓扑序决定」）。

    从 ``start_kp_ids`` 出发做 BFS（沿 ``from → to`` 的后继边），先去重、再按
    (跳数, kp_id) 排序。**depth 上限由 ``deps.py`` 的递归 CTE 保证**（防环死循环），
    本函数只负责把多棵树拼成一条稳定的顺序。

    ★★ ``limit`` 默认**不截断**（``None``），这是有意的修复，不是「忘了给默认值」：
      早年这里是 ``limit: int = 40``，而 K12KnowledgeBase 接入后**每个学段有 57 个知识点**
      —— 每学段后缀 17 关不进路径，其中 **9 关的前置就在前 40 关里**（正常游玩就会被
      :func:`unlocked_successor_ids` 解锁，于是它出现在 ``progress`` 表里、却不在路径上）。
      结果：这些关被 :func:`progress_snapshot` 的 ``rank.get(kp_id, fallback)`` 兜到最后，
      学生看到的是「下一关明明已经解锁了，却排在所有旧关后面」。
      40 这个数字的来历查无性能依据（路径长度按学段规模本就不同），
      因此改成「按实际规模给全」，而不是把它调成另一个魔法数字（57 也会被下一次扩容撞破）。
      给得出理由的调用方仍可显式传 ``limit``（截断语义原样保留）。

    ★ ``max_depth`` 默认取 :data:`app.knowledge.deps.MAX_DEPTH_LIMIT`（不是 ``DEFAULT_DEPTH``）：
      关卡路径要覆盖**整条链**，而 ``DEFAULT_DEPTH=3`` 恰好会在第四跳把
      「循环」（``ai-definition-jr→…→prog-loop-jr``）截掉 ——
      实测踩到过：进度里根本没有学生真正要练的那个知识点，
      表现为「依赖图明明有这条线，关卡列表里却没有」。防环仍然成立
      （``MAX_DEPTH_LIMIT`` 本身就是硬上限，且 CTE 用 UNIQUE 去重）。

    ★★ ``allowed_grades`` 给了就**只保留这些学段的关卡**（``None`` = 不过滤，保留原行为）。
      判据由调用方给（:func:`_default_level_order` 用 :func:`_allowed_grades`，
      与取题/检索同源）。**必须过滤**，否则冷启动的 ``primary_high`` 学生会拿到
      含初中/高中知识点的 33 关路径 —— 而 ``select_questions`` 的学段隔离
      注定让其中 16 关取题 **404**，学生的进度条上会出现一排点不开的死关。

    ★ 顺序是**真拓扑序**（Kahn + (跳数, kp_id) 为稳定优先级），不是「按跳数分层再按 id 排」：
      分层排序在**同层有依赖边**时会破坏前置先于后继（实测：``ai-definition-pl → ai-hierarchy-pl``
      与 ``ai-definition-pl → data-pl`` 都是 1 跳，按 id 排会把后继 ``data`` 排到前置 ``ai-hierarchy`` 前面）。
      同层内的顺序仍需确定，所以用最小堆而不是普通队列 —— 同一份图两次调用结果一致。
    """
    from app.knowledge.deps import MAX_DEPTH_LIMIT, successors

    allowed = None if allowed_grades is None else set(allowed_grades)
    depth_cap = max(1, min(int(max_depth or MAX_DEPTH_LIMIT), MAX_DEPTH_LIMIT))
    seen: dict[str, int] = {}
    for root in start_kp_ids:
        if not root:
            continue
        seen.setdefault(root, 0)
        for row in successors(conn, root, max_depth=depth_cap):
            if allowed is not None and row.grade_level not in allowed:
                continue
            previous = seen.get(row.kp_id)
            if previous is None or row.depth < previous:
                seen[row.kp_id] = row.depth

    ordered = _topological_order(conn, seen)
    if limit is None:
        return ordered
    return ordered[: max(1, int(limit))]


def _topological_order(conn, seen: dict[str, int]) -> list[str]:
    """把「可达知识点 + 各自最短跳数」排成一条**稳定的拓扑序**。

    只考虑 ``seen`` 内部的边（外部前置不算入度）：从 ``start_kp_ids`` 出发时，
    起点自身的祖先不在结果里，不该因此把起点永远排在后面。

    ``seen`` 里的每个节点都会出现在结果里（图成环时退化为按 (跳数, kp_id) 排 ——
    导入阶段的 DFS 已挡掉环，这里是最后一道保险，**宁可顺序不完美也不要漏关**）。
    """
    picked = set(seen)
    succs: dict[str, list[str]] = {kp_id: [] for kp_id in picked}
    indegree: dict[str, int] = {kp_id: 0 for kp_id in picked}
    for row in conn.execute("SELECT from_kp_id, to_kp_id FROM knowledge_dependencies"):
        from_kp, to_kp = str(row["from_kp_id"]), str(row["to_kp_id"])
        if from_kp in picked and to_kp in picked:
            succs[from_kp].append(to_kp)
            indegree[to_kp] += 1

    ready = [(seen[kp_id], kp_id) for kp_id in picked if indegree[kp_id] == 0]
    heapq.heapify(ready)
    ordered: list[str] = []
    while ready:
        _, kp_id = heapq.heappop(ready)
        ordered.append(kp_id)
        for successor in sorted(succs[kp_id]):
            indegree[successor] -= 1
            if indegree[successor] == 0:
                heapq.heappush(ready, (seen[successor], successor))
    if len(ordered) != len(picked):  # pragma: no cover - 环已被导入阶段挡掉
        logger.warning("关卡排序遇到环（%d 个节点未排出），退回按跳数排序", len(picked) - len(ordered))
        ordered.extend(sorted(picked - set(ordered), key=lambda kp_id: (seen[kp_id], kp_id)))
    return ordered


# ------------------------------------------------------------------ 主观题 --
#: 无 API Key 时的**可读降级文案**（TS 侧原样展示给学生；不是 error 事件的兜底文案）。
#: 判分口径不变：宁可**不判**（降级），也不要瞎判 —— 主观题乱判会直接污染掌握度。
SUBJECTIVE_DEGRADED_TEXT = (
    "这道题需要老师逐句看你的表达，但当前没有可用的大模型（还没配置 API Key）。"
    "我先不给你判分，免得判错；你可以先说说思路，或者换一道客观题练手。"
)

#: 主观题判分结论的反馈长度上限（落库的是**说明**，不是对话正文，§8.1 合规口径）。
SUBJECTIVE_FEEDBACK_MAX_CHARS = 200

#: 主观题得分占比达到这个值即判「答对」（0.6 = 及格线）。
#: ★ 判定在**服务端**做（只认 ``score``）：TS 侧送来的只是一个分数，
#: 「多少分算过」这条规则如果两边各写一份，迟早会漂移成两个答案。
SUBJECTIVE_PASS_RATIO = 0.6

#: 主观题题干的长度上限（生成的题干不该是一篇文章）。
STEM_MAX_CHARS = 600
#: 主观题评分细则的长度上限（细则要能被模型一次读完，也防 Prompt 注入式塞料）。
RUBRIC_MAX_CHARS = 800
#: 选项文本长度上限。
OPTION_MAX_CHARS = 200

#: ★ **生成题的 qid 前缀**（``gen-``），与 ``desktop/src/main/agent/extensions/quiz.ts``
#: 的 ``variantQid()`` 逐字同源（``gen-<kpId>-<随机段>-<序号>``）。
#:
#: 为什么要卡这个前缀（不只是"统一命名"）：``_locate_question`` 的查题次序是
#: **先生成题、后题库**，而 ``save_generated_questions`` 是 ``ON CONFLICT(qid) DO UPDATE``
#: —— 一个与真题同名的生成 qid 会把那道真题的**标准答案静默改写**（学生做的是真题、
#: 判分用的是模型的答案）。前缀让生成题与题库真题在**命名空间上**不可能相交
#: （题库 qid 形如 ``<slug>-q<序号>``，而 ``slug`` 来自导入脚本的 SLUGS），
#: 这比"每次登记去对比一遍全库"更早、更便宜地挡住同一类错误。
#: ⚠️ 两道都不删：前缀挡"将来可能出现的怪异 qid"，撞名检查挡"前缀规则被放宽"，
#: 各自的失败信息也指向不同的人（生成侧 / 题库维护侧）。
GENERATED_QID_PREFIX = "gen-"

#: 客观题 / 主观题两种判分路径（``contracts.py`` 的 ``QuizResult.scored_by``）。
GRADED_BY_RULE = "rule"
GRADED_BY_LLM = "llm"

#: 中文标点 → ASCII（NFKC 覆盖不到 ``、`` ``。`` ``“`` 这类 CJK 标点，单独补一张表）
_PUNCT_TRANSLATION = str.maketrans(
    {
        "，": ",",
        "。": ".",
        "、": ",",
        "；": ";",
        "：": ":",
        "（": "(",
        "）": ")",
        "【": "[",
        "】": "]",
        "《": "<",
        "》": ">",
        "“": '"',
        "”": '"',
        "‘": "'",
        "’": "'",
        "！": "!",
        "？": "?",
        "－": "-",
        "—": "-",
        "…": ".",
        "～": "~",
        "　": " ",
    }
)


# ---------------------------------------------------------------- 请求/出参 --
# ⚠️ 这些模型**不放进 `contracts.py`**（并行开发的边界：契约文件由票 04 独占）。
#    它们是本路由的**入参**，按 `app/routes/profile.py` 的既有先例就地声明；
#    出参一律用 `contracts.py` 的 `QuizPayload` / `QuizResult`（对外形态的唯一来源）。


class VariantQuestionIn(CamelModel):
    """登记一道 LLM 生成的变式题（**必须带标准答案**，否则后端判不了分）。

    ``reference_answer`` 就是**标准答案**：它进 ``learning.db``，绝不出现在任何出参里。
    方向与 :class:`app.contracts.QuizGradeRequest.answer`（学生作答）**相反**，别混。

    ★ ``qid`` 必须带 :data:`GENERATED_QID_PREFIX` 前缀（``gen-``，与
      ``desktop/src/main/agent/extensions/quiz.ts`` 的 ``variantQid()`` 同源）——
      见 :func:`register_variants` 的说明：不带前缀的 qid 能**伪装成题库真题**。
    """

    qid: str = Field(min_length=1, max_length=64)
    kp_id: str = Field(default="", max_length=64)
    type: QuizQuestionType
    stem: str = Field(min_length=1, max_length=STEM_MAX_CHARS)
    options: list[str] | None = None
    reference_answer: str | list[str]
    explanation: str = Field(default="", max_length=STEM_MAX_CHARS)
    #: 主观题（开放题）的评分细则。给了就是主观题 → 只能走 ``/api/quiz/grade-subjective``。
    #: 选择题/填空题给了也**不算主观题**（客观题永远走规则判分，见 :func:`is_subjective`）。
    rubric: str | None = Field(default=None, max_length=RUBRIC_MAX_CHARS)

    @field_validator("options")
    @classmethod
    def _check_options(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned = [str(item).strip() for item in value if str(item).strip()]
        if any(len(item) > OPTION_MAX_CHARS for item in cleaned):
            raise ValueError(f"选项过长（上限 {OPTION_MAX_CHARS} 字）")
        return cleaned


class RegisterVariantsRequest(CamelModel):
    """``POST /api/quiz/variants`` 的请求体：把 LLM 生成的题登记到该学生的库里。

    ``student_id`` 在 query 里（与 ``/api/quiz/bank`` 的取题口径一致）；
    这里只放题目本身。**至少要有一道题**（空数组等于一次毫无意义的写入）。
    """

    questions: list[VariantQuestionIn] = Field(min_length=1, max_length=MAX_QUESTION_COUNT)
    #: 学段（生成时用的那一个；校验层复查，防模型给出超纲的题）。
    grade_level: GradeLevel


class SubjectiveGradeRequest(CamelModel):
    """``POST /api/quiz/grade-subjective`` 的请求体：**TS 侧判完分，交服务端落库**。

    ★ LLM 调用在 TS 侧（Pi 独占），Python 不装任何 LLM 客户端。本端点只做三件事：
    校验（这道题真的是主观题吗）→ 按 ``score`` 定对错（**规则在服务端**）→ 写掌握度与进度。
    """

    student_id: str
    qid: str = Field(min_length=1, max_length=64)
    #: 模型给的得分占比 0..1（缺 ``score`` 一律 422，不允许「没判就落库」）。
    score: float = Field(ge=0.0, le=1.0)
    #: 模型给的中文反馈（会被压成单行并截断 —— 它是说明，不是正文容器）。
    feedback: str = Field(default="", max_length=SUBJECTIVE_FEEDBACK_MAX_CHARS)
    session_id: str | None = Field(default=None, max_length=128)
def normalize_answer(value: str) -> str:
    """把一段答案归一化成**只保留语义**的形式（比较用，不落库、不回显）。

    依次做四件事：NFKC（全角→半角、兼容字符）、中文标点转 ASCII、大小写折叠、去掉全部空白。

    - 空白差异（``1 到 5`` vs ``1到5``）、引号差异（``"x"`` vs ``“x”``）、
      全角括号（``（1）`` vs ``(1)``）都会归一成同一个串，因此不会误判；
    - 去掉空白是有意的：代码填空里 ``x = 1`` 与 ``x=1`` 必须等价；
    - 末尾分号一并去掉（``x += 1;`` 与 ``x += 1`` 等价）。
    """
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.translate(_PUNCT_TRANSLATION)
    text = text.casefold()
    text = "".join(text.split())
    return text.rstrip(";")


def _as_list(value: str | Sequence[str]) -> list[str]:
    """把 ``str | list[str]`` 统一成 list（契约里这两种形态都合法）。"""
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value]


def _choice_variants(value: str, options: Sequence[str]) -> set[str]:
    """选择题一个值的全部等价写法：字母 ``B`` ⇄ 选项原文。

    学生可能填字母，也可能把选项整句抄进来；两种都算对，且不接受「半截选项」。
    """
    token = normalize_answer(value)
    variants = {token} if token else set()
    if len(token) == 1:
        index = _OPTION_LETTERS.find(token.upper())
        if 0 <= index < len(options):
            variants.add(normalize_answer(options[index]))
    else:
        for index, option in enumerate(options):
            if normalize_answer(option) == token and index < len(_OPTION_LETTERS):
                variants.add(_OPTION_LETTERS[index].casefold())
    return variants


def is_correct_answer(
    question: QuizQuestion, submitted: str | Sequence[str]
) -> bool:
    """客观题规则判分（``scored_by="rule"``）。**唯一判分入口。**"""
    expected = _as_list(question.answer)
    got = _as_list(submitted)

    if question.type == "choice":
        options = question.options or []
        accepted: set[str] = set()
        for value in expected:
            accepted |= _choice_variants(value, options)
        given: set[str] = set()
        for value in got:
            given |= _choice_variants(value, options)
        return bool(accepted & given)

    # blank / code_blank：多空时按位置逐空比对；单空时「任一可接受答案」都算对。
    if len(expected) > 1 and len(got) > 1:
        if len(expected) != len(got):
            return False
        return all(
            normalize_answer(want) == normalize_answer(has)
            for want, has in zip(expected, got)
        )
    accepted = {normalize_answer(value) for value in expected}
    return any(normalize_answer(value) in accepted for value in got)


def feedback_for(question: QuizQuestion, correct: bool) -> str:
    """面向学生的中文反馈。**绝不回显标准答案**（回显等于送答案）。"""
    if correct:
        return f"答对了！{question.explanation}"
    return f"这次还差一点，先看看思路：{question.explanation} 想一想再选一次吧。"


#: 重复作答时附加在反馈后面的说明（**要说实话**：读起来必须像「又练了一次」，
#: 而不是「你刚答对了」。判分口径是**首次作答决定**，见 :func:`_record_attempt`）。
#:
#: ⚠️ 措辞规则（改这句话前先读）：它必须**对两种重复作答都成立** ——
#:   重复提交可能这次答对、也可能又答错，而这是同一个常量，所以它**不能**说
#:   「又答对啦」这类带结论的话（那会在答错时变成假话）。结论由 :func:`feedback_for`
#:   按本次判分结果给出，这里只补「这一次算不算数」。
#: ★★ 为什么改成这个说法（评审实测缺陷）：旧文案是
#:   「（这道题你之前已经答过，这次不计分，掌握度和闯关进度都不会变。）」——
#:   它把**系统记账**讲给了孩子听（「不计分」「都不会变」），一句夸奖都没有，
#:   答对的那点成就感当场被抹掉。现在把同一件事说成「又练了一遍」：
#:   信息一个字没少（**仍然明说这次不计分**，且掌握度/进度确实不动 ——
#:   这不是措辞软化，是同一件事实换了个学生听得进去的说法），
#:   但落点是「接着往下走」，而不是「你这次白答了」。
REPEAT_ATTEMPT_SUFFIX = (
    "（这道题你之前已经答过啦，这次就算再练一遍，不计分 —— "
    "掌握度和闯关进度都不会因此改变。我们接着往下练吧～）"
)


def repeat_attempt_feedback(feedback: str) -> str:
    """给重复作答的反馈加一句说明（**不改判分结论**，只把「计不计分」讲清楚）。

    ★ 为什么必须加：判分口径是「首次作答决定」，而反馈文案不说的话，
      学生（和模型）会以为「我刚才这一次答对了，掌握度涨了」——
      界面上的掌握度却纹丝不动，看起来就像系统坏了。
      **不加一句实话都不行**，但也**只加这一句**：把对错结论原样保留
      （学生要看到自己这次对没对，这正是他重复作答的原因）。
    ★ 这句话的**口气**同样是契约的一部分：它出现在每一次重复作答的反馈末尾
      （含答对之后），所以要像老师拍拍肩膀，而不是像系统打的一张对账单。
    """
    return f"{feedback}{REPEAT_ATTEMPT_SUFFIX}"


def is_subjective(record: GeneratedQuestionRecord) -> bool:
    """这道生成题是不是**主观题**（有评分细则）。

    ★ 判据只看「``rubric`` 非空」，与题型**无关**：prompt 里能让模型输出一段文本
    作为开放题（``type`` 仍是个合法题型，``reference_answer`` 是参考答案而非唯一解）。
    判据放在服务端，TS 侧无法自己声明「我是主观题」—— 否则随便一道选择题的 ``qid``
    都能走主观路径，`scored_by` 就失去了意义。
    """
    return bool(record.rubric and record.rubric.strip())


def subjective_feedback(*, score: float, correct: bool, raw_feedback: str) -> str:
    """主观题的最终中文反馈：**模型的话在前，规则判定在后**。

    为什么还要把「答对/答错」显式写进去：模型给的分与它自己的措辞经常不一致
    （比如 score=0.3 却说「回答得不错」）。学生需要知道系统最终怎么判 ——
    措辞可以温和，但结论必须是确定的。
    """
    flat = " ".join(str(raw_feedback or "").split())
    if len(flat) > SUBJECTIVE_FEEDBACK_MAX_CHARS:
        flat = f"{flat[:SUBJECTIVE_FEEDBACK_MAX_CHARS]}…"
    verdict = "思路到位，这题算过了。" if correct else "方向还差一点，我们再对着要点捋一遍。"
    return f"{flat}（得分 {round(score * 100)}%，{verdict}）" if flat else verdict


# ---------------------------------------------------------------- 超纲自检 --
def load_terminology_table() -> dict:
    """读术语文表（``knowledge/terminology.json``）；不可用时返回空表并**告警一次**。

    读失败不让取题/判分失败，只是失去超纲自检能力 —— 与 ``app.grade.signals``
    对同一份表的处理口径一致。

    ★ 之所以单独抽出来：``load_bank`` 要逐题自检，而 ``load_terminology`` 每次都读盘
    （D5 实测：题库 81 题 → 一次取题就是 **81 次文件读**）。
    调用方**每次遍历只读一次**，把结果当参数传下去。
    """
    try:
        return load_terminology(KNOWLEDGE_DIR)
    except Exception as exc:  # noqa: BLE001 - 表缺失不该让取题失败，只是失去自检能力
        logger.warning("术语文表不可用，跳过超纲自检：%s", exc)
        return {"terms": [], "tone_markers": []}


#: 术语文表的进程内缓存：值是 ``(mtime, 表)``。按 ``(路径, mtime)`` 失效，
#: 因此测试替换 ``KNOWLEDGE_DIR`` 或现场改表都会自动重读（不缓存「读不到」的空表，
#: 否则一次启动期的失败会被永久记住）。
_terminology_cache: tuple[float, dict] | None = None


def default_terminology_table() -> dict:
    """带 mtime 缓存的 :func:`load_terminology_table`（判分/取题这类高频路径用）。"""
    global _terminology_cache
    path = Path(KNOWLEDGE_DIR) / "terminology.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = -1.0
    if _terminology_cache is not None and _terminology_cache[0] == mtime and mtime >= 0:
        return _terminology_cache[1]
    table = load_terminology_table()
    if mtime >= 0:
        _terminology_cache = (mtime, table)
    return table


def reset_terminology_cache() -> None:
    """清缓存（测试与「换了教材目录」的脚本用）。"""
    global _terminology_cache
    _terminology_cache = None


def out_of_scope_terms(
    text: str, grade_level: str, *, terminology: dict | None = None
) -> list[str]:
    """题干里出现了**高于该学段**的术语 → 返回这些术语（空列表 = 合格）。

    术语文表就是教材自检用的那一份（``knowledge/terminology.json``，票 10），
    判据同 :func:`app.knowledge.checker.audit_library`：``min_grade`` 高于目标学段即超纲。
    小学低年级题干里的「算法」「特征向量」属于**明确点名**的验收口径（票 14）。

    ``terminology`` 可显式传入（遍历场景下**由调用方读一次**再传进来，避免每题读盘一次，
    见 :func:`load_bank`）；不传时退回带缓存的 :func:`default_terminology_table`，
    因此**旧的单参调用照常工作**。
    """
    if grade_level not in GRADE_LEVELS:
        return []
    table = terminology if terminology is not None else default_terminology_table()
    try:
        rank = grade_index(grade_level)
    except (KeyError, ValueError):
        return []

    hits: list[str] = []
    for entry in table.get("terms") or []:
        if not isinstance(entry, dict):
            continue
        term = str(entry.get("term") or "")
        if not term or term not in text:
            continue
        min_grade = str(entry.get("min_grade") or "primary_low")
        if min_grade in GRADE_LEVELS and rank < grade_index(min_grade):
            hits.append(term)
    return hits


# ---------------------------------------------------------------- 题库 --
@dataclass(frozen=True)
class BankEntry:
    """一条题库记录：内部题（含答案）+ 它来自哪个学段文件。"""

    question: QuizQuestion
    grade_level: str


@dataclass
class BankReport:
    """加载报告（供日志与测试断言「题库本身是干净的」）。"""

    entries: list[BankEntry] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    out_of_scope: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)

    @property
    def questions(self) -> list[QuizQuestion]:
        return [entry.question for entry in self.entries]


def default_bank_dir() -> Path:
    """题库目录（``K12_QUIZ_BANK_DIR`` 可覆盖，便于演示与排障）。"""
    override = os.environ.get(BANK_DIR_ENV)
    if override:
        return Path(override)
    return RESOURCES_DIR / QUIZ_BANK_DIRNAME


def bank_dir_for(request: Request) -> Path:
    """路由取题库目录：``app.state.quiz_bank_dir`` 优先（测试注入），否则用默认目录。"""
    injected = getattr(request.app.state, BANK_DIR_STATE_ATTR, None)
    return Path(injected) if injected else default_bank_dir()


#: kp_id **后缀** → 学段。章分片里每题的学段就靠它推导（见 ``load_bank`` 的说明）。
#:
#: ★ 为什么按后缀推，而不是查 ``kb.sqlite`` 或 ``knowledge/``：
#:   题库要能在**没有 kb 的环境**下加载（``K12_QUIZ_BANK_DIR`` 指向别处时是常态），
#:   查库会把「加载题库」变成「必须先有知识库」。
#:   后缀是 ``scripts/import_knowledge.py`` 生成的**约定**（``<slug>-<suffix>``），
#:   而「约定是否被遵守」由 ``tests/test_quizbank_coverage.py`` 对着真教材交叉核对 ——
#:   推导错会被那条测试抓住，不需要在这里再查一次盘。
KP_ID_GRADE_SUFFIX: dict[str, str] = {
    "pl": "primary_low",
    "ph": "primary_high",
    "jr": "junior",
    "sr": "senior",
}


def grade_from_kp_id(kp_id: str) -> str | None:
    """从 ``kp_id`` 后缀推学段（``ai-definition-pl`` → ``primary_low``）。

    推不出来返回 ``None``（调用方必须跳过该题并报告，**不要默认成某个学段**）。
    """
    _, _, suffix = str(kp_id or "").rpartition("-")
    return KP_ID_GRADE_SUFFIX.get(suffix)


def load_bank(bank_dir: str | Path) -> BankReport:
    """读整个题库目录并逐题校验。

    **坏题只跳过、不抛异常**：现场演示时一条手滑的记录不该让「出题」整条链路挂掉；
    跳过的 qid 与原因都进日志。超纲（术语高于本学段）只记录、不剔除 ——
    题库是人工编写的，需要人看到报告去改；LLM 生成的题由票 15 在生成侧直接拒。

    ★ 术语文表**在本函数里读一次**（D5），逐题自检时把同一份表传下去：
    早先每题各读一次盘，题库 81 题 → 一次取题/一次判分就是 81 次文件读，
    而判分路径每答一题都要调一次 —— 纯属浪费。
    """
    report = BankReport()
    root = Path(bank_dir)
    if not root.is_dir():
        logger.warning("题库目录不存在：%s（取题将全部落空）", root)
        return report

    # 整趟遍历共用一份术语文表（带 mtime 缓存，表被改动会自动重读）
    terminology = default_terminology_table()

    for path in sorted(root.glob("*.json")):
        report.files.append(path.name)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            report.skipped.append(f"{path.name}: 无法解析（{exc}）")
            logger.warning("题库文件无法解析，已跳过：%s（%s）", path, exc)
            continue

        declared_grade = str(raw.get("grade_level") or "")
        # ★★ 两种分片形态（2026-09-19 接入 K12KnowledgeBase 后新增第二种）：
        #
        #   ① **一学段一文件**（``primary_low.json`` 那一代）：文件级 ``grade_level``，
        #      文件里所有题同属一个学段；
        #   ② **一章节一文件**（``ch01.json`` 这一代）：教材扩到 57 个概念之后，
        #      再按学段切会让同一个知识点的题被摊进四个文件，作者根本管不过来。
        #      章分片**一个文件横跨四学段** —— 结构上给不出文件级 ``grade_level``，
        #      于是每题的学段由它自己的 ``kp_id`` 决定。
        #
        # ⚠️ 漏掉第二种的后果实测过：五份章分片**全被整文件跳过**，
        #   题库覆盖率静默掉到 0/228，而 ``load_bank`` 只往 ``skipped`` 里塞一行字 ——
        #   没人看就没人知道。所以判据改成「文件级学段**或**章节分片」二选一。
        is_chapter_shard = declared_grade not in GRADE_LEVELS and bool(raw.get("chapter"))
        if declared_grade not in GRADE_LEVELS and not is_chapter_shard:
            report.skipped.append(f"{path.name}: grade_level 非法（{declared_grade!r}）")
            logger.warning("题库文件学段非法，整文件跳过：%s（%r）", path, declared_grade)
            continue

        questions = raw.get("questions") or []
        if not isinstance(questions, list):
            report.skipped.append(f"{path.name}: questions 不是数组")
            continue

        for item in questions:
            try:
                question = QuizQuestion.model_validate(item)
            except Exception as exc:  # noqa: BLE001 - pydantic ValidationError 的字段名已在消息里
                qid = item.get("qid") if isinstance(item, dict) else None
                report.skipped.append(f"{path.name}/{qid or '?'}: {exc}")
                logger.warning("题库坏题已跳过：%s/%s（%s）", path.name, qid, exc)
                continue
            if question.type == "choice" and not question.options:
                report.skipped.append(f"{path.name}/{question.qid}: 选择题没有 options")
                logger.warning("选择题缺少选项，已跳过：%s", question.qid)
                continue

            entry_grade = declared_grade
            if is_chapter_shard:
                derived = grade_from_kp_id(question.kp_id)
                if derived is None:
                    # kp_id 没有可识别的学段后缀 → 判不出这题属于哪个学段。
                    # **必须跳过并说出来**：硬塞一个默认学段会让学段隔离开天窗
                    # （小学低年级的题可能被当成高中的）。
                    report.skipped.append(
                        f"{path.name}/{question.qid}: 章分片里 kp_id 无法推导学段（{question.kp_id!r}）"
                    )
                    logger.warning("章分片的 kp_id 无学段后缀，已跳过：%s", question.qid)
                    continue
                entry_grade = derived
            report.entries.append(BankEntry(question=question, grade_level=entry_grade))

    for entry in report.entries:
        # 题干 + 选项 + 解析都算「学生看得到的文本」，一起过超纲自检
        parts = [entry.question.stem, entry.question.explanation, *(entry.question.options or [])]
        offending = out_of_scope_terms(
            "\n".join(parts), entry.grade_level, terminology=terminology
        )
        if offending:
            report.out_of_scope.append(f"{entry.question.qid}: {'、'.join(offending)}")
            logger.warning(
                "题库超纲（%s）：%s 出现 %s", entry.grade_level, entry.question.qid, offending
            )
    return report


def find_question(entries: Iterable[BankEntry], qid: str) -> QuizQuestion | None:
    """按 ``qid`` 查题（判分用；题库是唯一来源）。"""
    for entry in entries:
        if entry.question.qid == qid:
            return entry.question
    return None


def bank_question_ids(report: BankReport) -> set[str]:
    """题库里**所有可定位的 qid**（登记变式题时用来挡撞名，见 :func:`register_variants`）。

    只取 ``entries`` 里的题（坏题已被 ``load_bank`` 跳过）—— 这不是偷懒，而是**对齐**：
    ``_locate_question`` 也只在 ``entries`` 里找题，所以真正能被"覆盖"的
    恰好就是这一个集合；把 skipped 的 qid 也算进来反而会让拒绝理由凭空多几条。
    """
    return {entry.question.qid for entry in report.entries}


def select_questions(
    report: BankReport,
    *,
    kp_id: str,
    grade_level: str,
    count: int = DEFAULT_QUESTION_COUNT,
    allow_compat: bool = True,
) -> list[BankEntry]:
    """取题：**先本学段，再按向上兼容顺序取更低学段**，同一学段内保持文件顺序。

    学段方向与检索一致（§8.5）：只允许取**不高于**学生学段的内容；
    初中生取不到高中题（超纲），高中生可以回看初中的题（巩固）。
    """
    if kp_id:
        candidates = [entry for entry in report.entries if entry.question.kp_id == kp_id]
    else:
        candidates = list(report.entries)

    order = compatible_grades(grade_level) if allow_compat else [grade_level]
    rank = {grade: index for index, grade in enumerate(order)}

    def sort_key(indexed: tuple[int, BankEntry]) -> tuple[int, int]:
        index, entry = indexed
        # 不在兼容链上的学段（= 更高学段）排到最后并被下面的过滤丢掉
        return rank.get(entry.grade_level, len(order)), index

    ordered = [
        entry
        for _, entry in sorted(enumerate(candidates), key=sort_key)
        if entry.grade_level in rank
    ]
    return ordered[: max(1, min(int(count), MAX_QUESTION_COUNT))]


# ---------------------------------------------------------------- 闯关推进 --
def successor_ids_for(conn, kp_id: str, *, grade_level: str | None = None) -> list[str]:
    """依赖图里的直接后继（``from → to``，``from`` 是前置）。

    **只取一跳**：解锁的语义是「这一关过了，下一关放出来」，不是「整条支线全放开」。
    深度上限由 ``deps.py`` 的递归 CTE 保证（这里传 1，等于只取直接后继）。

    ★ ``grade_level`` 给了就**只返回该学段兼容范围内（本学段 + 更低学段）的直接后继**
      —— 判据就是 :func:`_allowed_grades`，与 :func:`_default_level_order`、
      :func:`select_questions` 同源。这不是装饰：解锁是**关卡路径**的写路径，
      放出一个更高学段的后继（``ai-definition-ph`` → 初中 ``ai-definition-jr``）
      会让前端把该关渲染成可做，而 ``select_questions`` 的学段隔离注定让它取题 **404**
      —— 一条普通游玩就能走到的死胡同。
    """
    from app.knowledge.deps import successors

    allowed = None if grade_level is None else _allowed_grades(grade_level)
    rows = successors(conn, kp_id, max_depth=1)
    return [
        row.kp_id
        for row in rows
        if allowed is None or row.grade_level in allowed
    ]


def apply_level_progress(
    store: LearningStore,
    *,
    kp_id: str,
    correct: bool,
    mastery_score: float,
    successor_ids: Sequence[str],
) -> LevelOutcome:
    """把一次答题的结果推进到 ``progress`` 表（**闯关状态的唯一写路径**）。

    流程（与 :func:`advance_stage` 的规则一一对应）：

    1. 读这一关已有的 ``stage`` / 徽章（徽章里记着「答对几道」）；
    2. 答对才 ``correct_count + 1``（答错不动计数 —— 状态单调，见 ``advance_stage``）；
    3. 算新 ``stage`` 与新徽章（徽章**只在答对时给**，答错保留旧的）；
    4. 写回；再按：「已 quizzed 且掌握度 ≥ 阈值」判断是否**解锁后继**。

    ★ 解锁的实现是**把后继从 ``locked`` 提到 ``learning``**（插入一行）。
      这里对每个后继都插一行是**修正一个有意的省略**：不插的话后继在 ``progress`` 表里
      根本没有行，前端拿到的进度里就没有这一关 —— 学生会以为「后面没有内容了」。
    """
    rows = store.progress_map()
    existing: ProgressRecord | None = rows.get(kp_id)
    current_stage = existing.stage if existing else None
    correct_count = correct_count_from_badge(existing.badge if existing else None)

    if correct:
        correct_count += 1
    new_stage = advance_stage(
        current_stage=current_stage,
        mastery_score=float(mastery_score),
        correct_count=correct_count,
    )
    # ★ 徽章只在**答对**时更新（答错保留旧徽章：那是「曾经通关」的事实，不该被抹掉）
    new_badge = badge_for(correct_count) if correct else (existing.badge if existing else None)
    store.upsert_progress(kp_id, stage=new_stage, badge=new_badge)

    unlocked: list[str] = []
    # ★ 解锁到 `learning` 而不是直接给 `quizzed`：解锁只表示「这一关可以开始做了」，
    #   做了没有由学生自己的作答决定。把新关直接标成 quizzed 会凭空长出一个进度。
    newly = unlocked_successor_ids(
        current_kp_id=kp_id,
        current_stage=new_stage,
        mastery_score=float(mastery_score),
        successor_ids=successor_ids,
    )
    for successor in newly:
        previous = rows.get(successor)
        if previous is not None and previous.stage != "locked":
            continue  # 已经在做 / 已经通过：**不回退**（状态单调）
        store.upsert_progress(
            successor,
            stage="learning",
            badge=previous.badge if previous is not None else None,
        )
        unlocked.append(successor)
    return LevelOutcome(
        kp_id=kp_id,
        stage=new_stage,
        badge=new_badge,
        correct_count=correct_count,
        unlocked=tuple(unlocked),
    )



def _known_kp_ids(request: Request) -> set[str] | None:
    """当前教材里**全部**知识点的 id（读不到 kb 时返回 ``None`` = 不过滤）。

    ★ 为什么要缓存：这个集合在一次请求里只读一次，但进度端点是**高频**的
      （每答一题都会回读），每次都全表扫一遍 `kp` 没必要。
      按 (kb 路径, mtime) 缓存 —— 教材重建后 mtime 变了会自动重读，
      不需要重启进程（与 `RagService` 的 mtime 自动重开连接同一手法）。

    ⚠️ 读不到（kb 缺失/损坏）返回 ``None`` 而**不是空集**：
      空集会让进度端点返回空的关卡列表，把「库读不到」伪装成「你没有进度」——
      那是比不显示更坏的错。不过滤时旧行为原样保留。
    """
    from app.rag.retriever import default_kb_path
    from app.store.connections import connect

    kb_path = default_kb_path(request.app.state.config.data_dir)
    try:
        stat = kb_path.stat()
    except OSError:
        return None
    key = (str(kb_path), int(stat.st_mtime_ns))
    cached = _KNOWN_KP_CACHE.get("value")
    if cached is not None and cached[0] == key:
        return cached[1]
    try:
        conn = connect(kb_path, readonly=True)
    except Exception:  # noqa: BLE001 - 读不到就当没有白名单（保留旧行为）
        return None
    try:
        ids = {str(row["kp_id"]) for row in conn.execute("SELECT kp_id FROM kp")}
    except Exception:  # noqa: BLE001 - 表不存在等异常一律退化为不过滤
        return None
    finally:
        conn.close()
    _KNOWN_KP_CACHE["value"] = (key, ids)
    return ids


#: `_known_kp_ids` 的单槽缓存：``{"value": (key, ids)}``。
#: 单槽足够 —— 同一进程只会服务一个 data-dir（多学生共用同一份 kb）。
_KNOWN_KP_CACHE: dict[str, object] = {}

def progress_snapshot(
    store: LearningStore,
    *,
    kp_ids: Sequence[str] | None = None,
    order: Sequence[str] | None = None,
    fallback_order: Sequence[str] | None = None,
    known_kp_ids: Collection[str] | None = None,
) -> list[dict[str, object]]:
    """给前端/事件载荷用的进度快照（纯数据，**不含答案**）。

    ``stage`` / ``badge`` 原样来自 ``learning.db``（前端只读，不自持状态机）；
    ``mastery`` 一并带上，免得前端为了画一条进度条再发一次画像请求。

    - ``kp_ids`` 给了就只返回这几关（用于「本次答题影响到的关卡」这种小范围回传）；
    - ★ ``order`` 是**依赖图拓扑序**（:func:`level_order_from_graph` 的产物）：
      给了就按它排序（序外的关卡按 kp_id 排到后面）。**不加它的话排序会退化成
      ``kp_id`` 字典序**，于是「变量」可能排在「循环」后面 —— 进度条会显示成
      「下一关已经解锁、上一关还没做」的怪样子（这正是票 15 说的
      「关卡顺序由依赖图拓扑序决定」，不是按 id 排）。
    - ★★ ``fallback_order`` 是**主序之外的补位序**（``None`` = 退回按 kp_id 排）。
      用来给「不在本学段关卡路径上、但确实有进度记录」的 kp 一个**拓扑序位置**，
      而不是把它们一律甩到最后。

      **为什么必须有它**（实测缺陷）：关卡路径 = 本学段（:func:`_default_level_order`），
      而取题允许**向上兼容**（学生能回头刷更低学段的题）—— 那些关不在主序里。
      再加上「每学段 57 个知识点、而路径曾被 ``limit=40`` 截断」，
      于是「前置在前 40 关里、已经被正常解锁的那 9 关」全部落在主序之外 →
      一律命中 fallback → 学生看到「下一关明明已经解锁了，却排在所有旧关之后」。
      截断已经去掉（治本）；补位序是同一类场景的第二道保险
      （旧库里指向已改学段的进度行也走这条路）。
    - ★★ ``known_kp_ids`` 给了就**只保留教材里真的存在的那几关**
      （``None`` = 不过滤，保留原行为）。

      **为什么必须有这个过滤**：``learning.db`` 是**按学生长期保留**的，
      而教材会换代（2026-09-19 接入 K12KnowledgeBase 时整库换过一次）。
      换代之后老学生的库里还剩着一批**指向已删除知识点**的进度行 ——
      进度条于是渲染出一串教材里根本不存在的关卡（实测：某学生的路径 55 关，
      其中 15 关是旧 kp），而关卡名只能退化成显示 **kp_id 原文**
      （``ph-data-train-predict`` 这种），因为查不到对应的中文名。

      这类行的正确处理是**不出现在界面上**（而不是显示成裸 id），
      同时**不删库里的行** —— 学生万一哪天回到旧教材，那些记录还在；
      而且「读的时候顺手删数据」是另一类危险的副作用。
    """
    mastery = store.mastery_map()
    wanted = set(kp_ids) if kp_ids is not None else None
    rank = {kp_id: index for index, kp_id in enumerate(order or ())}
    # 补位序只填**主序里没有的** kp（``setdefault``）：主序的相对次序一个字不动，
    # 否则「学生自己的学段」会被更低学段的补位序挤开。
    tail = len(rank)
    for index, kp_id in enumerate(fallback_order or ()):
        rank.setdefault(kp_id, tail + index)
    fallback = tail + len(fallback_order or ())
    rows = [
        row
        for row in store.progress_rows()
        if (wanted is None or row.kp_id in wanted)
        and (known_kp_ids is None or row.kp_id in known_kp_ids)
    ]
    rows.sort(key=lambda row: (rank.get(row.kp_id, fallback), row.kp_id))
    return [
        {
            "kpId": row.kp_id,
            "stage": row.stage,
            "badge": row.badge,
            "mastery": round(float(mastery.get(row.kp_id, 0.0)), 4),
        }
        for row in rows
    ]


# ---------------------------------------------------------------- 学生库 --
def student_db_path(data_dir: str | Path, student_id: str) -> Path:
    """``<data-dir>/students/<student_id>/learning.db``（执行文档 §8.2，一人一库）。

    ``student_id`` 先过白名单再做路径拼接：这个值来自请求体，直接拼路径等于把
    「本机任意文件写入」的口子开在 HTTP 上。

    ★ **归口已收拢**：真正拼路径的是 ``app.routes.students.student_learning_db_path``
    （``open_learning_store`` 内部调它），本函数只是**保留的兼容别名**，测试与历史调用方
    仍在用它。**新代码请直接调 ``open_learning_store`` / ``student_learning_db_path``** ——
    路径拼两处，迟早有一处忘记做白名单校验。

    ★ 数据根（第一个参数）**必须来自** ``require_data_dir(request)``（显式 ``--data-dir``），
    路由里不得再用 ``config.data_dir`` 兜底（那会落到共享的 ``server/_data``，见 D4）。
    """
    if not STUDENT_ID_RE.match(student_id):
        raise HTTPException(status_code=422, detail="studentId 不合法（只允许字母、数字、下划线、连字符）")
    return student_learning_db_path(data_dir, student_id)


def _student_grade(store: LearningStore, student_id: str) -> str:
    """学生的学段（**解锁判定/关卡路径的唯一依据**）。

    学段来自**服务端推断**（``app.grade.rules`` 的规则引擎，D-020：自动推断、自动生效），
    这里读到的就是学生当前**生效中**的值；学生端只读、**没有人工选择入口**，
    所以调用方传入/读取的学段都不是「学生选的那个」。

    学生行不存在时退回 :data:`COLD_START_GRADE` —— 与 :func:`read_progress`、
    :func:`register_variants` 的冷启动兜底同一口径（「学生还没登录就先做题」不该丢数据，
    也不该让他解锁到学段外的关卡）。不用请求体里的学段：判分请求体里**没有**学段字段，
    而且客户端的自述不能当作隔离依据 —— 学段必须来自服务端持有的学生记录。
    """
    student = store.get_student(student_id)
    if student is None:
        return COLD_START_GRADE
    return as_grade_level(student.grade_level)


# ---------------------------------------------------------------- 路由 --
def _pick_grade_level(
    grade_level: str | None, camel_grade_level: str | None, *, field_name: str = "gradeLevel"
) -> str:
    """取学段参数：``gradeLevel``（camelCase）与 ``grade_level``（snake_case）都认。

    仓库里两种写法都有先例（契约的 body 一律 camelCase，``/api/graph/deps`` 的 query 用
    snake_case），所以这里两个名字都收，避免调用方猜错名字得到一个静默的 422。
    """
    value = camel_grade_level or grade_level
    if not value:
        raise HTTPException(status_code=422, detail=f"缺少 {field_name}（四学段之一）")
    if value not in GRADE_LEVELS:
        raise HTTPException(
            status_code=422, detail=f"{field_name} 非法：{value!r}（只允许 {'、'.join(GRADE_LEVELS)}）"
        )
    return value


@router.get(
    "/quiz/bank/{kp_id}",
    response_model=QuizPayload,
    summary="按知识点 + 学段取题（剔除 answer）",
)
def get_quiz_bank(
    request: Request,
    kp_id: str,
    grade_level: str | None = Query(None, description="学生学段（四学段之一，必填）"),
    gradeLevel: str | None = Query(None, include_in_schema=False),
    count: int = Query(DEFAULT_QUESTION_COUNT, ge=1, le=MAX_QUESTION_COUNT, description="取几道题"),
    allow_compat: bool = Query(True, description="题目不足时是否允许取用更低学段的题"),
    allowCompat: bool | None = Query(None, include_in_schema=False),
) -> QuizPayload:
    """取题（供练习 Extension 的 ``generate_quiz`` Tool 调用）。

    - 本题库**按学段分文件**，因此学段是必填参数；只允许取**不高于**学生学段的题；
    - 返回体是 :class:`QuizPayload`，``questions`` 全是 :class:`QuizQuestionOut`
      （**结构上没有 ``answer``**，不是靠 ``exclude`` 临时裁的）；
    - 取不到题 → **404** + 可读中文（``questions: []`` 看起来像「这个知识点没题」，
      与「kpId 拼错了」分不开，所以不用空数组表达失败）；
    - 题库目录不存在/坏题多 → 不算错误：返回 404，由编排层决定改用 LLM 生成（票 15）。
    """
    level = _pick_grade_level(grade_level, gradeLevel)
    compat = allow_compat if allowCompat is None else allowCompat

    report = load_bank(bank_dir_for(request))
    picked = select_questions(
        report, kp_id=kp_id, grade_level=level, count=count, allow_compat=compat
    )
    if not picked:
        raise HTTPException(
            status_code=404,
            detail=(
                f"知识点 {kp_id!r} 在 {level} 及更低学段没有题目"
                "（题库文件：server/resources/quizbank/）"
            ),
        )

    missing = [
        entry.question.qid
        for entry in picked
        if entry.question.type == "choice" and not entry.question.options
    ]
    if missing:  # pragma: no cover - load_bank 已经挡掉，留作最后一道保险
        raise HTTPException(status_code=500, detail=f"题库存在无选项的选择题：{missing}")

    payload = QuizPayload.from_internal(
        kp_id=kp_id,
        source="bank",
        questions=[entry.question for entry in picked],
    )
    logger.info(
        "取题：kp=%s 学段=%s 命中=%d（题库文件：%s；坏题 %d，超纲 %d）",
        kp_id,
        level,
        len(payload.questions),
        "、".join(report.files) or "无",
        len(report.skipped),
        len(report.out_of_scope),
    )
    return payload


@router.post("/quiz/grade", response_model=QuizResult, summary="提交答案并批改（客观题规则判分）")
def grade_quiz(request: Request, body: QuizGradeRequest) -> QuizResult:
    """按 ``qid`` 查库判分，并把结果写进该学生的 ``learning.db``。

    写入三处（都是结构化数据，**不写对话正文**）：
      - ``mastery``：``score`` / ``attempts`` / ``correct`` / ``last_seen_at``；
      - ``learning_history``：一条 ``activity="quiz"`` 记录（票 20 的个性化闭环要吃它）；
      - ``progress``：闯关状态机（**票 15**，见 :func:`apply_level_progress`）。

    ★★ **判分幂等：首次作答决定**（``store.question_attempt(qid)`` 判首次，与主观路径同源）。
      第一次提交这道题 → 照常判分 + 计掌握度 + 推进闯关 + 计徽章；
      **之后的重复提交** → **照常判分、照常给反馈**（学生要看到这次对没对），
      但**不再改掌握度、不重复计数、不重复推进/解锁**，反馈里附一句
      :data:`REPEAT_ATTEMPT_SUFFIX` 把「不计分」说明白（**不说谎**）。

      为什么「答错后再答」不改变掌握度：掌握度是**能力信号**（推荐/画像要吃它），
      连点 4 次同一道题就能把 0.15 刷到 0.6 并解锁后继 —— 那不是能力，是点击次数。
      学习需要的是**即时反馈**，那一条一个字没少（判分与反馈照旧）。

    题目来源有两处，**按此顺序**查（票 15 起）：
      ① 该学生库里的 LLM 生成题（``generated_question``）—— 变式题走这条；
      ② 随包分发的题库。
    两处都要求「这条库里有这道题」，否则 404（**不猜、不新建**）。

    ``mastery_delta`` 回传的是**实际生效**的变化量（``新值 - 旧值``）：已经满分时再答对就是 0，
    而不是回一个没发生的 ``+0.15``（否则前端进度条会虚涨）；重复作答时它**恒为 0**
    （掌握度没动，回传任何非零值都是谎报）。
    """
    if not STUDENT_ID_RE.match(body.student_id):
        raise HTTPException(
            status_code=422,
            detail="studentId 不合法（只允许字母、数字、下划线、连字符）",
        )

    # ★ D4：数据根必须走**显式 --data-dir**（拿不到就 503），与画像/学段/动画路由同源。
    #   早先用 `config.data_dir` 兜底 → 没传参数时会静默写到共享的 `server/_data/students/`
    #   下（单测、手工 curl、多次运行互相污染），而其它三条轨已经拒收了。
    store = open_learning_store(require_data_dir(request), body.student_id)
    try:
        found = _locate_question(request, store, body.qid)
        if found is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"题目 {body.qid!r} 不在本题库、也不在这个学生的生成题里。"
                    "若是模型生成的变式题，要先经 POST /api/quiz/variants 登记（含标准答案）再批改。"
                ),
            )
        question, generated = found

        # ★ 主观题**不许**走这条规则判分：它的答案不是唯一解，规则比对会把好答案判错。
        #   409（不是 422）：请求本身合法，只是「这道题不用这条路径判」。
        if generated is not None and is_subjective(generated):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"题目 {body.qid!r} 是主观题（带评分细则），必须走 "
                    "POST /api/quiz/grade-subjective（由 TS 侧的模型判分）。"
                ),
            )

        correct = is_correct_answer(question, body.answer)
        # ★★ 幂等判据在**这里**取、判分之前：`question_attempt` 只认 learning_history 里
        #   `activity='quiz'` 且 detail.qid 相同的行（两条判分路径的落库点都是 _record_attempt）。
        #   放在判分之前是因为「是不是第一次」与「这次答得对不对」是两件独立的事 ——
        #   先判分再查会让重复作答的反馈里混进一个没发生的掌握度变化。
        repeat = store.question_attempt(question.qid) is not None
        feedback = feedback_for(question, correct)
        if repeat:
            feedback = repeat_attempt_feedback(feedback)
            # 掌握度一个字不动：读回当前值当 after，delta 恒为 0（回传非 0 就是谎报）
            before, _, _ = store.mastery(question.kp_id)
            after = before
            effective = 0.0
        else:
            before, _, _ = store.mastery(question.kp_id)
            delta = MASTERY_GAIN_CORRECT if correct else -MASTERY_LOSS_WRONG
            after = store.apply_mastery(question.kp_id, delta, correct=correct)
            effective = round(after - before, 6)
        outcome = _record_attempt(
            request,
            store,
            kp_id=question.kp_id,
            qid=question.qid,
            question_type=question.type,
            scored_by=GRADED_BY_RULE,
            correct=correct,
            mastery_after=after,
            effective_delta=effective,
            session_id=body.session_id or "",
            stem=question.stem,
            grade_level=_student_grade(store, body.student_id),
            repeat=repeat,
        )
    finally:
        store.close()

    logger.info(
        "判分（rule）：qid=%s kp=%s 对错=%s 掌握度 %.3f → %.3f（delta=%.3f）关卡=%s%s%s",
        question.qid,
        question.kp_id,
        correct,
        before,
        after,
        effective,
        outcome.stage,
        f" 解锁 {list(outcome.unlocked)}" if outcome.unlocked else "",
        "（重复作答，不计分）" if repeat else "",
    )
    return QuizResult(
        qid=question.qid,
        correct=correct,
        scored_by=GRADED_BY_RULE,
        feedback=feedback,
        # ★ 限幅：契约模型自身有 ge/le 校验（±MASTERY_DELTA_LIMIT），
        #   store 也限幅一次 —— 两道保险都在，单次答题绝不可能把掌握度从 0 顶到 1。
        mastery_delta=max(-MASTERY_DELTA_LIMIT, min(MASTERY_DELTA_LIMIT, effective)),
    )


# ---------------------------------------------------------------- 变式题登记 --
def _validate_variant(
    item: VariantQuestionIn, *, grade_level: str
) -> tuple[str, str] | None:
    """校验一道待登记的生成题；不合格返回 ``(字段, 原因)``，合格返回 ``None``。

    校验层**复查学段的超纲问题**（票 15 明确要求「学段写进 prompt 且校验层复查」）：
    prompt 里已经写了学段，但模型可能无视 —— 所以这里用与教材自检同一份术语文表
    再审一遍，超纲的题**直接拒**（不静默收下：超纲题会让学生看到没学过的名词）。

    ★ 还要卡 ``qid`` 前缀（见 :data:`GENERATED_QID_PREFIX`）：不带 ``gen-`` 的 qid
      既可能是生成侧漏了 ``variantQid()``，**也可能是一次故意的撞名尝试** ——
      两种都该在门口被挡下，而不是等它把某道真题的答案改写掉之后再查。
    """
    if not item.qid.startswith(GENERATED_QID_PREFIX):
        return (
            "qid",
            f"生成题的 qid 必须以 {GENERATED_QID_PREFIX!r} 开头（收到 {item.qid!r}）。"
            f"它由客户端生成，规则见 extensions/quiz.ts 的 variantQid()："
            f"{GENERATED_QID_PREFIX}<知识点>-<随机段>-<序号>。"
            "不带这个前缀的 qid 可能与题库真题同名，从而覆盖真题的标准答案。",
        )
    if item.type == "choice":
        if not item.options or len(item.options) < 2:
            return ("options", "选择题至少要两个选项（否则学生没法作答）")
    answers = _as_list(item.reference_answer)
    if not any(normalize_answer(value) for value in answers):
        return ("referenceAnswer", "标准答案是空的（后端将无法判分）")
    text = "\n".join([item.stem, item.explanation or "", *(item.options or [])])
    offending = out_of_scope_terms(text, grade_level)
    if offending:
        return ("stem", f"题干出现高于本学段的术语：{'、'.join(offending)}（超纲）")
    return None


@router.post(
    "/quiz/variants",
    response_model=QuizPayload,
    summary="登记 LLM 生成的变式题（含标准答案；返回体不含答案）",
)
def register_variants(
    request: Request,
    body: RegisterVariantsRequest,
    student_id: str = Query(..., description="学生 id（生成题落在这个学生自己的库里）"),
    studentId: str | None = Query(None, include_in_schema=False),
) -> QuizPayload:
    """把 TS 侧生成的变式题**登记到该学生的 ``learning.db``**，并返回对外载荷。

    ★ 两道闸门把「答案泄漏」挡在本端点之外：

    ① **入参方向**：``reference_answer`` 是模型产出的**标准答案**，只进库、绝不回显；
    ② **出参方向**：返回体是 :class:`QuizPayload`，``questions`` 全是
       :class:`QuizQuestionOut`（结构上没有 ``answer``）——
       转换只走 ``QuizPayload.from_internal``，不存在第二条投影路径。

    ★ ``qid`` 由 TS 侧生成（带随机段，见 ``quiz.ts`` 的 ``variantQid``）：
      Python 侧只做**形状校验**（长度/字符集/``gen-`` 前缀），不重新编号 ——
      重新编号会让「学生卡片上的 qid」与「后端登记的 qid」对不上，判分必 404。

    ★★ **撞名防护（两道，见 :data:`GENERATED_QID_PREFIX` 的说明）**：
      ① 形状：``qid`` 必须带 ``gen-`` 前缀（在 :func:`_validate_variant` 里逐题拒）；
      ② 硬检查：与**题库真题的 qid** 撞名 → **整批拒**（与「同批 qid 重复」同一处置）。

      为什么②必须是整批拒、而不是"只丢撞名那一道"：走到这一步说明生成侧给出了一个
      **与真题同名**的题，那不是「一道题没写好」，而是「这道题的去向搞错了」——
      它的答案会被写进 ``generated_question``，而 ``_locate_question`` **先生成题后题库**
      → 那道真题从此在这个学生这里判的是模型的答案（学生做的是真题，得分却是别人的答案）；
      同时批里其余的题也来自同一个有问题的生成调用，收下它们只是把问题藏起来。
    """
    student = student_id or studentId
    if not student or not STUDENT_ID_RE.match(student):
        raise HTTPException(
            status_code=422,
            detail="studentId 不合法（只允许字母、数字、下划线、连字符）",
        )

    # 题库真题的 qid 集合（读一次，整批复用）。读不到题库不是错误：
    # 空集等于"这一批没有可撞的对象"，登记照常进行 —— 撞名防护是加固，不是前置条件。
    bank_ids = bank_question_ids(load_bank(bank_dir_for(request)))

    rejected: list[str] = []
    duplicates: list[str] = []
    collisions: list[str] = []
    accepted: list[GeneratedQuestionRecord] = []
    seen: set[str] = set()
    for item in body.questions:
        # ★ 同一批里 qid 重复 → **整批拒**（`save_generated_questions` 是 ON CONFLICT 覆盖语义，
        #   重复的 qid 会让后一道**静默覆盖**前一道的答案 —— 学生做的是题 A、
        #   判分用的是题 B 的答案，是最难查的那类错）。整批拒而不是「只丢重复的」：
        #   重复说明生成侧有 bug（qid 不该撞），收下剩下几道只会把问题藏起来。
        if item.qid in seen:
            duplicates.append(item.qid)
            continue
        seen.add(item.qid)
        # ★★ 与**题库真题**撞名 → 同样整批拒。`_locate_question` 先查生成题，
        #   所以这个名字一旦落库，那道真题的标准答案就被静默改写了。
        if item.qid in bank_ids:
            collisions.append(item.qid)
            continue
        problem = _validate_variant(item, grade_level=body.grade_level)
        if problem is not None:
            rejected.append(f"{item.qid}/{problem[0]}: {problem[1]}")
            continue
        accepted.append(
            GeneratedQuestionRecord(
                qid=item.qid,
                kp_id=item.kp_id,
                grade_level=body.grade_level,
                type=item.type,
                stem=item.stem,
                options=tuple(item.options) if item.options else None,
                reference_answer=item.reference_answer,
                explanation=item.explanation,
                rubric=(item.rubric or "").strip() or None,
                source="generated",
                created_at=None,
            )
        )

    if collisions:
        # ★ 与真题撞名：说清是**哪道题**、以及为什么整批都不收（上面的 docstring 有完整理由）
        raise HTTPException(
            status_code=422,
            detail=(
                "生成题的 qid 与题库真题撞名："
                + "、".join(sorted(set(collisions)))
                + "。这个 qid 已经在随包题库里（判分时先查生成题、后查题库），"
                "登记成功会把那道真题的标准答案**静默改写** —— 学生做的是真题、"
                "判分用的却是模型的答案。整批已拒绝。"
                "请让生成侧改用 `gen-` 前缀（`quiz.ts` 的 `variantQid` 会带上它），"
                "或换一个不会被误认成真题的名字。"
            ),
        )

    if duplicates:
        # 更明确的一条：告诉调用方这是「生成侧 qid 撞了」，而不是某道题内容不合格
        raise HTTPException(
            status_code=422,
            detail=(
                "同一批里 qid 重复：" + "、".join(sorted(set(duplicates))) +
                "。重复的 qid 会让后一道覆盖前一道的标准答案（学生做题 A、判分用题 B 的答案），"
                "整批已拒绝；请让生成侧给每题一个唯一 qid（`quiz.ts` 的 `variantQid` 会带随机段）。"
            ),
        )

    if not accepted:
        # ★ 全部被拒时**不返回空题**：空载荷会让前端渲染一张空卡片（票 14 的同一口径）。
        #   理由里有具体是哪道题、哪里不合格，编排层据此重试或退回题库。
        raise HTTPException(
            status_code=422,
            detail="没有一道生成题通过校验：" + "；".join(rejected),
        )

    # ★ D4：与画像/学段/动画路由同源 —— 只认显式 `--data-dir`，拿不到就 503
    store = open_learning_store(require_data_dir(request), student)
    try:
        # 冷启动兜底（与 `POST /api/profile/{id}/events` 同一口径）：
        # 「学生还没登录就先开始做题」不该丢数据，也不该让之后的 `GET /api/profile` 回 404
        # —— 那样学生会看到「我没有学习记录」，而他明明刚做了题。
        if store.get_student(student) is None:
            store.upsert_student(student, nickname="", grade_level=body.grade_level)
            logger.info("冷启动：为 %s 建立学生行（学段 %s）", student, body.grade_level)
        store.save_generated_questions(accepted)
        # 冷启动/首次练习：把进度行补出来（**只插不覆盖**），否则前端拿到的进度里没这几关
        store.seed_progress([item.kp_id for item in accepted if item.kp_id])
    finally:
        store.close()

    logger.info(
        "登记变式题：学生=%s 学段=%s 通过 %d 道（拒 %d 道：%s）",
        student,
        body.grade_level,
        len(accepted),
        len(rejected),
        "；".join(rejected) or "无",
    )

    # ★ 唯一的「内部 → 对外」转换路径（`QuizQuestionOut.from_internal` 在白名单里丢答案）
    return QuizPayload.from_internal(
        kp_id=accepted[0].kp_id,
        source="generated",
        questions=[
            QuizQuestion(
                qid=item.qid,
                kp_id=item.kp_id,
                type=item.type,  # type: ignore[arg-type]
                stem=item.stem,
                options=list(item.options) if item.options else None,
                answer=item.reference_answer,
                explanation=item.explanation,
            )
            for item in accepted
        ],
    )


# ---------------------------------------------------------------- 主观题判分 --
@router.post(
    "/quiz/grade-subjective",
    response_model=QuizResult,
    summary="落库主观题判分结论（LLM 调用在 TS 侧，本端点只落库）",
)
def grade_subjective(request: Request, body: SubjectiveGradeRequest) -> QuizResult:
    """把 **TS 侧模型判分**的结论落进 ``learning.db``（票 15 的混合批改）。

    ★★ 为什么判分结论要从外面送进来、判分逻辑却仍在服务端：

    - **LLM 调用归 Ts 独占**（Pi 是编排层，Python 不装任何 LLM 客户端）——
      所以模型给出的 ``score`` / ``feedback`` 只能从 TS 侧来；
    - **但「多少分算过」必须由服务端定**（:data:`SUBJECTIVE_PASS_RATIO`）：
      TS 只送分数，不送 ``correct``。若让 TS 送对错，等于把判分规则复制一份到前端进程，
      两边迟早漂移，而漂移的表现是「同样的答案，有时算对有时算错」；
    - **只有登记过评分细则的主观题**走得通（客观题一律 **409**），
      这样 ``scored_by="llm"`` 不会被用来绕开规则判分。

    写库与 ``/quiz/grade`` **共用** :func:`_record_attempt`（同一个事务边界、
    同一套进度推进），所以两条判分路径在数据侧不可能出现两套语义。

    ★★ **判分幂等同样成立**（与 ``/quiz/grade`` 一条口径，判据也是
      ``store.question_attempt(qid)``）：这道主观题第二次提交时**照常落一条
      ``learning_history`` 流水**，但**不再改掌握度、不再推进闯关/解锁**，
      反馈里附一句 :data:`REPEAT_ATTEMPT_SUFFIX`。

      ⚠️ 主观题**尤其**需要这一条：LLM 判分不是确定性的（同一份答案可能这次 0.8、
      下次 1.0），同一道开放题反复提交就能靠分数抖动把掌握度一路推上去 ——
      而 ``SUBJECTIVE_PASS_RATIO`` 的「多少分算过」在服务端，学生只要反复点就够了。
      幂等判据落在**服务端**（不是靠 TS 侧记得别重复提交）。
    """
    if not STUDENT_ID_RE.match(body.student_id):
        raise HTTPException(
            status_code=422,
            detail="studentId 不合法（只允许字母、数字、下划线、连字符）",
        )

    # ★ D4：与画像/学段/动画路由同源 —— 只认显式 `--data-dir`，拿不到就 503
    store = open_learning_store(require_data_dir(request), body.student_id)
    try:
        generated = store.find_generated_question(body.qid)
        if generated is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"题目 {body.qid!r} 不在这个学生的生成题里。主观题必须先经 "
                    "POST /api/quiz/variants 登记（带 rubric 评分细则）才能按模型判分。"
                ),
            )
        if not is_subjective(generated):
            # ★ 客观题走主观路径 = 试图绕开规则判分：明确拒绝并指出正确路径
            raise HTTPException(
                status_code=409,
                detail=(
                    f"题目 {body.qid!r} 没有评分细则（是客观题），必须走 POST /api/quiz/grade "
                    "用规则判分；主观题判分路径只服务带 rubric 的开放题。"
                ),
            )

        correct = body.score >= SUBJECTIVE_PASS_RATIO
        feedback = subjective_feedback(
            score=body.score, correct=correct, raw_feedback=body.feedback
        )
        # ★★ 幂等判据与 `/quiz/grade` **同一处语义**（见该端点的说明）：
        #   查的是 learning_history 里这道题有没有作答过 —— 两条判分路径的落库点都是
        #   `_record_attempt`，所以「主观题先答、再用同一个 qid 走客观路径」这类交叉也不会漏判
        #   （客观路径那边同样查一次，判据是同一张表、同一个 qid）。
        repeat = store.question_attempt(generated.qid) is not None
        before, _, _ = store.mastery(generated.kp_id)
        if repeat:
            after = before
            effective = 0.0
            feedback = repeat_attempt_feedback(feedback)
        else:
            delta = MASTERY_GAIN_CORRECT if correct else -MASTERY_LOSS_WRONG
            after = store.apply_mastery(generated.kp_id, delta, correct=correct)
            effective = round(after - before, 6)
        outcome = _record_attempt(
            request,
            store,
            kp_id=generated.kp_id,
            qid=generated.qid,
            question_type=generated.type,
            scored_by=GRADED_BY_LLM,
            correct=correct,
            mastery_after=after,
            effective_delta=effective,
            session_id=body.session_id or "",
            stem=generated.stem,
            grade_level=_student_grade(store, body.student_id),
            extra={"llmScore": round(float(body.score), 4)},
            repeat=repeat,
        )
    finally:
        store.close()

    logger.info(
        "判分（llm）：qid=%s kp=%s 得分=%.2f 对错=%s 掌握度 %.3f → %.3f 关卡=%s%s%s",
        body.qid,
        generated.kp_id,
        body.score,
        correct,
        before,
        after,
        outcome.stage,
        f" 解锁 {list(outcome.unlocked)}" if outcome.unlocked else "",
        "（重复作答，不计分）" if repeat else "",
    )
    return QuizResult(
        qid=generated.qid,
        correct=correct,
        scored_by=GRADED_BY_LLM,
        feedback=feedback,
        mastery_delta=max(-MASTERY_DELTA_LIMIT, min(MASTERY_DELTA_LIMIT, effective)),
    )


# ---------------------------------------------------------------- 进度读取 --
@router.get(
    "/quiz/progress/{student_id}",
    summary="读闯关进度（learning.db 的 progress 表是唯一权威）",
)
def read_progress(
    request: Request,
    student_id: str,
    kpIds: str | None = Query(None, description="只看这几关，逗号分隔（可选）"),
) -> dict[str, object]:
    """读某学生的闯关进度。

    ★ **冷启动兜底**（票 15/20 的验收项）：新学生 ``progress`` 表是空的，
      这里按**依赖图的拓扑序**自动初始化默认路径（只插不覆盖），
      再返回 —— 前端不会拿到空数组，也不会因为没数据而报错。
    ``kpIds`` 用于「本次答题影响到的关卡」这种小范围回读。
    """
    if not STUDENT_ID_RE.match(student_id):
        raise HTTPException(
            status_code=422,
            detail="studentId 不合法（只允许字母、数字、下划线、连字符）",
        )

    # ★ D4：与画像/学段/动画路由同源 —— 只认显式 `--data-dir`，拿不到就 503
    store = open_learning_store(require_data_dir(request), student_id)
    try:
        # 冷启动：学生一行都没有时先建学生行（缺学段就按默认），否则种子路径无从谈起
        student = store.get_student(student_id)
        if student is None:
            student = store.upsert_student(
                student_id, nickname="", grade_level=COLD_START_GRADE
            )
            logger.info("冷启动：为 %s 建立学生行（学段 %s）", student_id, student.grade_level)

        seeded = _seed_default_path(request, store, grade_level=student.grade_level)
        wanted = (
            [item for item in str(kpIds).split(",") if item.strip()] if kpIds else None
        )
        # ★ 按依赖图拓扑序输出（不是 kp_id 字典序）：见 `progress_snapshot` 的注释。
        order = _default_level_order(request, grade_level=student.grade_level)
        # ★★ 路径外关卡（更低学段的历史记录）也要有**拓扑序位置**，不能一律甩到最后：
        #    关卡路径只含本学段，而取题允许向上兼容 —— 学生回头刷过的更低学段关卡
        #    本来就不在主序里。没有这一份补位序时它们全排到最后，
        #    表现就是「这关早就通过了却排在最后」（与 limit 截断同一类症状）。
        scope_order = _level_order_for_grades(
            request, grades=_allowed_grades(student.grade_level)
        )
        # ★★ 只回教材里真实存在的关卡：老学生的库里可能还留着**指向已删除知识点**的
        #    进度行（教材换代过 —— 2026-09-19 接入 K12KnowledgeBase 时就整库换过），
        #    不过滤就会渲染成一串查不到中文名的裸 kp_id（实测某学生 55 关里 15 关是旧 kp）。
        #    ⚠️ 白名单用**全库 kp**（不限学段），不是 `order`：
        #      `order` 只是本学段的关卡路径，而学生可能合法地持有更低学段的练习记录
        #      （取题允许向上兼容），拿 `order` 当白名单会把那些**真实存在的**记录也藏掉。
        rows = progress_snapshot(
            store,
            kp_ids=wanted,
            order=order,
            fallback_order=scope_order,
            known_kp_ids=_known_kp_ids(request),
        )
    finally:
        store.close()

    return {
        "studentId": student_id,
        "gradeLevel": student.grade_level,
        "seeded": seeded,
        "levels": rows,
    }


def _seed_default_path(
    request: Request, store: LearningStore, *, grade_level: str
) -> int:
    """按依赖图拓扑序初始化默认关卡路径（只插不覆盖），返回新插了几关。

    起点 = 该学段**（含更低学段）**里的「根知识点」——即没有前置的那些；
    路径 = 沿后继边做 BFS（:func:`level_order_from_graph`）。
    知识库缺失/为空时**不报错**：退化成空路径，前端仍能拿到 `{"levels": []}` 而不是 500。

    ★ **第一关是 ``learning`` 而不是 ``locked``**（冷启动的关键一步）：
      全 locked 的话学生打开练习看到「一关都进不去」，而「没有前置的第一关」
      本来就该是可以直接开始的。其余关卡保持 ``locked``，靠
      :func:`unlocked_successor_ids` 在答对后逐个放出来。

    ★ **依赖图里没有任何知识点**时（kb 为空/未建）退回一个**种子起点**：
      冷启动必须给出「可开始的第一关」，否则新学生的第一屏是死的（票 20 的冷启动验收）。
    """
    order = _default_level_order(request, grade_level=grade_level)
    if not order:
        logger.warning(
            "依赖图里没有可用的知识点（学段 %s），冷启动退回种子起点（练习仍可开始）",
            grade_level,
        )
        order = list(
            COLD_START_LEVEL_SEEDS.get(grade_level, COLD_START_LEVEL_SEED_FALLBACK)
        )

    inserted = 0
    existing = store.progress_map()
    for index, kp_id in enumerate(order):
        if not kp_id or kp_id in existing:
            continue
        # 第一关直接可做（`learning`），其余 `locked`；靠答对后逐个解锁（见 `unlocked_successor_ids`）
        stage = "learning" if index == 0 else "locked"
        inserted += store.seed_progress([kp_id], stage=stage)
        existing[kp_id] = ProgressRecord(
            kp_id=kp_id, stage=stage, badge=None, updated_at=None
        )
    if inserted:
        logger.info(
            "冷启动：按依赖图初始化 %d 关默认路径（学段 %s，首关 %s；根 %s）",
            inserted,
            grade_level,
            order[0],
            "、".join(order[:4]),
        )
    return inserted


def _default_level_order(request: Request, *, grade_level: str) -> list[str]:
    """依赖图拓扑序下的关卡路径，**只看学生自己的学段**（读不到图/图为空返回空列表）。

    ★★ 两条范围，别混（2026-09-19 接入 K12KnowledgeBase 时明确区分）：

      - **关卡路径 = 本学段**（本函数）。路径回答的是「我现在该按什么顺序练」；
      - **取题 / 检索 = 兼容学段**（:func:`_allowed_grades`）。学生随时可以回头取更低学段的题。

    ★ 为什么路径不能也用兼容学段（迁移后实测出来的）：
      新库的依赖图是「概念内 ``X-pl → X-ph → X-jr → X-sr`` 逐级加深 + 概念间同学段相关」。
      若路径按兼容范围取，**初中生的路径里只有 4/57 关是自己学段的内容**，其余全是小学；
      高中更极端 —— **0/57**，整条路径都是别人年级的课。
      学生会觉得「我上初中了，怎么还在学小学的课」。

      旧教材没有这个问题：它本来就是**一学段一本教材**，各学段的图互不相通。
      新库把概念串成跨学段链之后，「兼容可取」与「该练什么」必须分成两件事。

    ⚠️ **前置只在本学段内算数**：同一概念的低学段版本（初中那篇的前置是小学高年级那篇）
      对初中生而言是已经学过的基础，不该挡住他 —— 这正是「每个学段各自成图」的含义。
      取题侧的兼容隔离一个字没改，学生想回头复习随时取得到。
    """
    return _level_order_for_grades(request, grades=(grade_level,))


def _level_order_for_grades(request: Request, *, grades: Collection[str]) -> list[str]:
    """给定**学段集合**的依赖图拓扑序（:func:`_default_level_order` 的泛化版）。

    ``grades`` 是**本次排序的可见范围**（判据由调用方给）：关卡路径传「本学段」，
    给「路径外的已知 kp 补位」时传兼容范围（本学段 + 更低学段）。

    ★ 为什么补位要单独算一份**兼容范围**的拓扑序、而不是拿现成的路径凑：
      路径是按「本学段」建的（见上），它整份都不含更低学段的关；而学生**确实可能**
      持有更低学段的进度行（取题允许向上兼容）。拿路径补位等于没补 ——
      那些关仍然只能按 kp_id 排，而 kp_id 前缀是「概念 slug」不是顺序，
      排在哪儿纯属巧合（这正是「解锁了却排在最后」那个缺陷的另一半）。
    """
    from app.rag.retriever import default_kb_path
    from app.store.connections import connect

    kb_path = default_kb_path(request.app.state.config.data_dir)
    if not kb_path.exists():
        logger.warning("知识库不存在（%s），跳过默认关卡路径初始化", kb_path)
        return []
    try:
        conn = connect(kb_path, readonly=True)
    except Exception as exc:  # noqa: BLE001 - 冷启动不该因为库读不到而 500
        logger.warning("打开知识库失败，跳过默认关卡路径初始化：%s", exc)
        return []

    own = set(grades)
    try:
        rows = conn.execute("SELECT kp_id, grade_level FROM kp ORDER BY kp_id").fetchall()
        known = {str(r["kp_id"]) for r in rows}
        in_scope = [str(r["kp_id"]) for r in rows if str(r["grade_level"]) in own]
        # 根 = 本范围内**没有前置**的知识点。判据落在范围内（不是「全图无前置」）：
        # 若某个 kp 的前置只存在于范围外更高学段（数据将来变动时可能出现），把它当起点
        # 才能让它进入路径；否则它既不是根、又走不到，会**整关消失**。
        roots = [kp_id for kp_id in in_scope if not _has_prerequisite(conn, kp_id, own)]
        if not roots:
            # 范围内全都有前置：拿该范围全部知识点当起点，顺序仍由拓扑排序决定，
            # 至少保证「有内容可做」。
            roots = in_scope
        return [
            kp_id
            for kp_id in level_order_from_graph(
                conn, start_kp_ids=roots, allowed_grades=own
            )
            if kp_id in known
        ]
    finally:
        conn.close()


def _allowed_grades(grade_level: str) -> set[str]:
    """学生**可接触**的学段集合 = 本学段 + 更低学段（``compatible_grades`` 的唯一判据）。

    ★ 关卡路径、解锁后继、取题（:func:`select_questions`）、检索（RAG）四处必须同源：
      任何一处放宽成「全学段」，就会出现「路径里有关卡、但那关取不到题」的死胡同 ——
      这正是本文件要修的那个缺陷。

    ``grade_level`` 可能来自库里被人工改过的脏值，所以先过
    :func:`app.routes.students.as_grade_level` —— **与其它消费者同一套转换口径**
    （认不出就退到 :data:`COLD_START_GRADE` 并记日志），不在这里另立一套兜底规则。
    """
    return set(compatible_grades(as_grade_level(grade_level)))


def _has_prerequisite(conn, kp_id: str, allowed: set[str] | None = None) -> bool:
    """这个知识点有没有前置（依赖图里的入边）。

    ``allowed`` 给了就**只认该学段范围内的前置**（见 :func:`_default_level_order` 的根判定）。
    """
    if allowed is None:
        row = conn.execute(
            "SELECT 1 FROM knowledge_dependencies WHERE to_kp_id = ? LIMIT 1", (kp_id,)
        ).fetchone()
        return row is not None
    placeholders = ",".join("?" for _ in allowed)
    row = conn.execute(
        "SELECT 1 FROM knowledge_dependencies d JOIN kp k ON k.kp_id = d.from_kp_id "
        f"WHERE d.to_kp_id = ? AND k.grade_level IN ({placeholders}) LIMIT 1",
        (kp_id, *sorted(allowed)),
    ).fetchone()
    return row is not None


def _locate_question(
    request: Request, store: LearningStore, qid: str
) -> tuple[QuizQuestion, GeneratedQuestionRecord | None] | None:
    """按 ``qid`` 找题：**先学生库里的生成题，再随包题库**。

    返回 ``(内部题, 生成题记录或 None)``；找不到返回 ``None``。
    生成题记录要一起返回，是因为判分路径还要看它的 ``rubric``（判断是不是主观题）。
    """
    generated = store.find_generated_question(qid)
    if generated is not None:
        return (
            QuizQuestion(
                qid=generated.qid,
                kp_id=generated.kp_id,
                type=generated.type,  # type: ignore[arg-type]
                stem=generated.stem,
                options=list(generated.options) if generated.options else None,
                answer=generated.reference_answer,
                explanation=generated.explanation,
            ),
            generated,
        )
    bank_question = find_question(load_bank(bank_dir_for(request)).entries, qid)
    if bank_question is None:
        return None
    return (bank_question, None)


def _current_outcome(store: LearningStore, kp_id: str) -> LevelOutcome:
    """读这一关**当前**的关卡状态（不写任何东西）。

    给重复作答用：那时进度按口径**不动**，但日志与出参仍需要一个如实的快照，
    不能拿一个「没发生的推进结果」去糊弄（那会让日志与库里的值对不上）。
    """
    existing = store.progress_map().get(kp_id)
    if existing is None:  # pragma: no cover - 有历史作答就一定有进度行
        return LevelOutcome(kp_id=kp_id, stage="learning", badge=None, correct_count=0)
    return LevelOutcome(
        kp_id=kp_id,
        stage=existing.stage,
        badge=existing.badge,
        correct_count=correct_count_from_badge(existing.badge),
    )


def _record_attempt(
    request: Request,
    store: LearningStore,
    *,
    kp_id: str,
    qid: str,
    question_type: str,
    scored_by: str,
    correct: bool,
    mastery_after: float,
    effective_delta: float,
    session_id: str,
    stem: str,
    grade_level: str,
    extra: dict[str, object] | None = None,
    repeat: bool = False,
) -> LevelOutcome:
    """一次作答的**统一落库点**（两种判分路径共用，票 15）。

    写三样东西，都在同一个学生库、同一段控制流里：
      ① ``learning_history``（``activity="quiz"``，供票 20 的画像/推荐消费）；
      ② ``progress``（闯关状态机 + 徽章 + 解锁后继）；
      ③ 返回 :class:`LevelOutcome`（供日志与断言）。

    ★★ **判分幂等：首次作答决定**（``repeat=True`` 时改什么、不改什么）：

    | 落库项 | 重复作答时 | 为什么 |
    | --- | --- | --- |
    | ``learning_history`` | **照写** | 它是流水账：学生**确实**又答了一次，抹掉等于篡改记录；错题本/学习报告也要能看到重复的错 |
    | ``progress``（stage / 徽章 / 解锁） | **不写** | 闯关是「走过没走过」的进度，重复提交不改变「走过」这件事 |
    | ``mastery``（调用方负责） | **不动** | 掌握度是**能力信号**：连点 4 次同一题就把 0.15 刷到 0.6、顺手解锁后继，那不是能力 |

    ★ 为什么「答错后可以再答」仍然成立、但掌握度只由第一次决定：这两件事服务于不同目的。
      再答是为了**看到对错**（学习需要即时反馈），而掌握度是给推荐/画像用的**稳定信号**。
      让反复刷改变它，等于把「谁点得多」当成「谁会」。
      所以重复作答**照常判分、照常给反馈**，只是不再计入。

    ★ **不写对话正文**：``question`` 列只放题干**前 120 字**（题干是题目本身，
      不是学生的话）；学生原话与模型回答一律不入库（§8.1 合规红线）。

    ★ ``grade_level`` 是学生的学段，**解锁后继时按它过滤**（见 :func:`_safe_successors`）：
      路径与解锁必须同一学段口径，否则会放出取不到题的关卡。
    """
    if repeat:
        outcome = _current_outcome(store, kp_id)
    else:
        successor_ids = _safe_successors(request, kp_id, grade_level=grade_level)
        outcome = apply_level_progress(
            store,
            kp_id=kp_id,
            correct=correct,
            mastery_score=mastery_after,
            successor_ids=successor_ids,
        )
    detail: dict[str, object] = {
        "qid": qid,
        "type": question_type,
        "scoredBy": scored_by,
        "masteryDelta": effective_delta,
        "mastery": mastery_after,
        "stage": outcome.stage,
        "correctCount": outcome.correct_count,
    }
    if outcome.unlocked:
        detail["unlocked"] = list(outcome.unlocked)
    if repeat:
        # ★ 显式落一个判据，而不是靠「masteryDelta == 0」去猜：
        #   已经满分后再答对也是 0，两者在流水账里必须分得开（否则将来没人能复原口径）。
        detail["repeat"] = True
        detail["counted"] = False
    if extra:
        detail.update(extra)
    store.add_history(
        kp_id=kp_id,
        activity="quiz",
        session_id=session_id,
        question=stem[:120],
        is_correct=correct,
        detail=json.dumps(detail, ensure_ascii=False),
    )
    return outcome


def _safe_successors(request: Request, kp_id: str, *, grade_level: str) -> list[str]:
    """取**学段兼容范围内**的后继知识点（依赖图）；**任何失败都退化成空列表**，绝不让判分 500。

    依赖图读不到时，判分与掌握度照常工作，只是「下一关解锁」这一步不发生 ——
    这是可接受的降级（比「答对了却报错」好得多），且日志里明说。

    ★ ``grade_level`` 是**硬过滤**（:func:`successor_ids_for`）：解锁写的是关卡路径，
      放出更高学段的后继会立刻变成一条取题 404 的死关。与 :func:`select_questions`
      的学段隔离同源 —— 学生在初中就不该被解锁高中关卡，哪怕掌握度已经够了。
    """
    from app.rag.retriever import default_kb_path
    from app.store.connections import connect

    kb_path = default_kb_path(request.app.state.config.data_dir)
    if not kb_path.exists():
        return []
    try:
        conn = connect(kb_path, readonly=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("解锁判定：打开知识库失败（本次不解锁后继）：%s", exc)
        return []
    try:
        return successor_ids_for(conn, kp_id, grade_level=grade_level)
    except Exception as exc:  # noqa: BLE001
        logger.warning("解锁判定：查后继失败（本次不解锁）：%s", exc)
        return []
    finally:
        conn.close()


__all__ = [
    "BANK_DIR_ENV",
    "BANK_DIR_STATE_ATTR",
    "BankEntry",
    "BankReport",
    "DEFAULT_QUESTION_COUNT",
    "MASTERY_GAIN_CORRECT",
    "MASTERY_LOSS_WRONG",
    "MAX_QUESTION_COUNT",
    "QUIZ_BANK_DIRNAME",
    "STUDENT_ID_RE",
    "bank_dir_for",
    "default_bank_dir",
    "feedback_for",
    "find_question",
    "is_correct_answer",
    "load_bank",
    "normalize_answer",
    "out_of_scope_terms",
    "router",
    "select_questions",
    "student_db_path",
]
