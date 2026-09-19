"""画像与推荐（``/api/profile/*``）—— 读画像、写学习记录、**个性化推荐**。

本模块是学习闭环的三端（§6.3，票 09 落地、票 20 补齐推荐）：

- **读**（``GET /api/profile/{student_id}``）：画像 + 掌握度 + 偏好 + **依赖图推荐**
  （供 Pi 的 ``get_student_profile`` Tool 注入 Prompt）；
- **写**（``POST /api/profile/{student_id}/events``）：从对话/各模块提取出来的
  **结构化学习记录**回流到 ``learning.db``（``activity`` 覆盖 ``qa | animation | coding | quiz``）；
- **写偏好**（``PUT /api/profile/{student_id}/preferences``）：写入**学习方式**类偏好
  （喜好领域 / 讲解方式 / 节奏 / 一句备注）—— 这就是需求「根据答题表现**和兴趣偏好**
  动态调整后续推荐」里「兴趣偏好」那一半的**唯一写入口**（在此之前 ``profile_pref`` 只被读过）。
  键是**封闭词表**（``contracts.PreferenceKey``），值 ≤ 40 字单行；
- **推荐**（``GET /api/profile/{student_id}/recommendation``，票 20）：
  「下一步学什么」的**唯一出口**，依赖图 + 掌握度共同决定，冷启动有默认路径；
- **当前章节**（``GET`` / ``PUT /api/profile/{student_id}/chapter``）：学生显式选定
  「在学哪一章教材」。★ 它是**软偏好**：只进画像 Prompt（Pi 每轮读 ``GET /profile``），
  **不改检索契约、不做 SQL 硬过滤**（学生问别的章节照常回答）；
  非空标题必须命中该生**当前学段**的教材清单（``kb.sqlite``），学段一变由
  ``app/grade/rules.py`` 清空（那本教材已经不存在了）。

★★ 合规红线（§8.1 / §12）：**SQLite 不存对话正文**。
   本模块只接受「活动类型 + 知识点 id + 对错 + 一句固定口径的说明 + 时间戳」；
   学生原话、模型回答、代码片段一律不入库 —— 对话正文归 Pi 的 JSONL 会话树，
   两者靠 ``studentId`` + ``sessionId`` 关联。契约上的两道闸门：
   ① ``CamelModel`` 的 ``extra="forbid"``：多带一个 ``question`` / ``text`` 字段直接 422；
   ② ``detail`` 限长 200 字并压成单行（它是一条**说明**，不是正文的容器）。

★★ 推荐**只有一套实现**（票 12/20 的关键纪律）：依赖图的推荐路径一律走
   ``app.knowledge.deps.recommend_next()``，本文件**不自己遍历图**。
   本文件额外做的只有两件事：① 把「需要重练的知识点」排在前面（掌握度驱动，
   对应「连续答错 → 下一轮更可能再考它」）；② 冷启动时给出图里的**入口知识点**。

一人一库：每次请求现开现关该学生的 ``learning.db``（``app.routes.students.open_learning_store``），
**不跨学生复用连接**。表结构由 ``app/store/learning.py`` 的迁移器负责（幂等可重跑），
本文件**不写任何 DDL**。

> ⚠️ 路由挂载：本 router 需要在 ``app/main.py`` 里 ``include_router``（票 09 报备，
> 与 ``quiz`` / ``code`` 等新路由一起由 main.py 维护者登记）。**注册后必须重跑**
> ``uv run python scripts/export_openapi.py`` 与 ``cd desktop && npm run gen:api``，
> 否则 ``test_committed_artifact_matches_contracts`` 与 ``npm run check:api`` 会红。
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Collection, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import Field, field_validator

from app.contracts import (
    CamelModel,
    ChapterStateOut,
    ChapterUpdateRequest,
    GradeLevel,
    LearningActivity,
    Mastery,
    PreferenceUpdateRequest,
    Student,
    StudentProfile,
)
from app.routes.students import (
    DEFAULT_COLD_START_GRADE,
    as_grade_level,
    open_learning_store,
    require_data_dir,
    to_contract_ms,
    validate_student_id,
)
# ★ 掌握度阈值**从练习轨 import**（不是各写一个 0.6）：两处必须是同一个数，
#   否则会出现「推荐认为你已经会了、解锁认为你还不行」这种自相矛盾。
#   `quiz.py` 不 import 本文件，所以这条 import **不构成循环**。
from app.routes.quiz import MASTERY_UNLOCK_THRESHOLD

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["profile"])

#: ``detail`` 的长度上限：它是**说明**，不是对话正文的容器（合规口径见模块头）。
DETAIL_MAX_CHARS = 200

#: 知识点 id 的长度上限（与桌面端 `learning-log.ts` 的 `SAFE_KP_ID` 同量级）。
KP_ID_MAX_CHARS = 64

# ------------------------------------------------------------------ 推荐 --
#: 推荐条数上限（按顺序回给前端 / 注入 Prompt；太多等于没推荐）。
RECOMMEND_LIMIT = 3

#: ★ 「该重练」的掌握度上限：低于它、且**已经作答过**的知识点会被排到推荐最前面。
#: 这就是票 15/20 要求的「连续答错某知识点 → 下一轮更可能再考它」——**可演示的数据流**：
#: 同一份代码，只要 ``mastery.score`` 掉到这条线以下，推荐的第一位就换成它。
REVIEW_MASTERY_CEILING = 0.5

#: ★ 推荐的来源（回给前端做展示与断言；**取值冻结**，前端按它决定要不要提示）。
RecommendationSource = Literal["review", "graph", "cold_start", "empty"]


class LearningEventRequest(CamelModel):
    """``POST /api/profile/{student_id}/events`` 的请求体（学习记录写入）。

    由 ``learning-log`` Extension 构造，字段全部是**从对话里提取出来的结构化信息**：
    没有任何一个字段用于承载对话正文（这是有意的，见模块头）。
    """

    #: `qa | animation | coding | quiz`（契约冻结的四类活动）。
    activity: LearningActivity
    #: 知识点 id（提取不到就留空；不写「猜的知识点」）。
    kp_id: str = Field(default="", max_length=KP_ID_MAX_CHARS)
    #: 关联 Pi 的 JSONL 会话（`learning_history.session_id`）—— 这是正文与记录的**唯一**联系方式。
    session_id: str | None = Field(default=None, max_length=128)
    #: 对错（只有客观题/代码运行才有确定值；`None` = 不适用，不要臆造）。
    is_correct: bool | None = None
    #: 固定口径的中文说明（如「观看动画讲解」），**不是学生原话**。
    detail: str = Field(default="", max_length=DETAIL_MAX_CHARS)
    #: 学段（冷启动时服务端据此建学生行；正常路径学生已由 `POST /api/students` 建好）。
    grade_level: GradeLevel | None = None

    @field_validator("detail")
    @classmethod
    def _single_line(cls, value: str) -> str:
        """压成单行：换行会把「一句说明」变成「一整段正文」，是绕过限长的常见形态。"""
        return " ".join(value.split())


class LearningEventAck(CamelModel):
    """写入类端点的回执（§6.3：``{ok}``）：学习记录回流与学习偏好写入**共用同一形状**。

    ★ 偏好写入**复用**本模型而不是再造一个等价的 ``PreferenceAck``：两者的出参形状
      一字不差（``{ok: true}``），同形状两个模型名只会让 OpenAPI/TS 多一个语义重复的
      类型、让前端多写一个分支去认同一个 ``{ok}``。**新增写入型端点时也复用它。**
    """

    ok: bool = True


# --------------------------------------------------------------------------- #
# 推荐（票 20）
# --------------------------------------------------------------------------- #
class RecommendationItem(CamelModel):
    """一条推荐（**下一步学什么**）。

    字段全部是**可展示**的：``kp_id`` 是机器口径，``name`` 是给学生看的名字
    （由依赖图的 ``kp`` 表解析出来）；``reason`` 是一句可直接照念的中文。
    """

    kp_id: str
    #: 人类可读的知识点名（图里查不到时退化成 kp_id）
    name: str = ""
    #: 学段（供前端标注；四学段之一）
    grade_level: GradeLevel | None = None
    #: 相对当前已知位置的跳数（1 = 直接后继；0 = 冷启动入口/待重练）
    depth: int = 1
    #: 当前掌握度（0..1；没有记录就是 0.0 —— 这是会给学生的数，不是内部阈值）
    mastery: float = Field(default=0.0, ge=0.0, le=1.0)
    #: 中文理由（**可直接念**，不含内部字段名）
    reason: str = ""


class RecommendationResponse(CamelModel):
    """``GET /api/profile/{student_id}/recommendation`` 的响应（票 20）。

    ``source`` 说明这一批推荐是怎么来的 —— 前端据此决定提示语，
    也是验收时「冷启动 / 依赖图 / 待重练」三种形态的**可断言标志**：

    | source | 含义 |
    | --- | --- |
    | ``review`` | 优先重练（掌握度不足且练过） |
    | ``graph`` | 依赖图后继（掌握某知识点后往前推） |
    | ``cold_start`` | 全新学生：给图里的入口知识点 |
    | ``empty`` | 依赖图不可用且无任何学习记录（前端按空态展示，**不是错误**） |
    """

    student_id: str
    source: RecommendationSource
    items: list[RecommendationItem] = Field(default_factory=list)
    #: 一句总述（可读中文，用于对话里的一句话引导）
    summary: str = ""


def _load_kb_connection(request: Request):
    """打开只读知识库；不可用时返回 ``None``（调用方各自决定降级方式）。

    ★ **不抛异常**：知识库缺失/损坏是「这项能力受限」，不是「画像打不开」。
      画像本身（掌握度/偏好/章节）落在学生自己的库里，与 kb 无关 —— 让它们互相拖垮，
      结果是学生连自己的分数和章节都看不到。
    ★ 本函数有两个调用方，**降级方式不同**，所以日志只说「不可用」不说降级动作：
      ① 推荐（:func:`build_recommendation`）→ 退化成「按掌握度给建议」；
      ② 章节写入（:func:`write_chapter`）→ 非空标题无法校验，直接 503
         （**不能猜**：猜错就会把不存在的章节写进 Prompt）。
    """
    from app.rag.retriever import default_kb_path
    from app.store.connections import connect

    kb_path = default_kb_path(request.app.state.config.data_dir)
    if not kb_path.exists():
        logger.warning("知识库不存在（%s）", kb_path)
        return None
    try:
        return connect(kb_path, readonly=True)
    except Exception as exc:  # noqa: BLE001 - 见 docstring
        logger.warning("打开知识库失败（%s）", exc)
        return None


def _kp_names(conn, kp_ids: list[str]) -> dict[str, str]:
    """``kp_id → 人类可读名``（读不到就用 kp_id 兜底）。"""
    from app.store import kb as kb_repo

    if not kp_ids:
        return {}
    try:
        return {kp_id: name for kp_id, name in kb_repo.kp_names(conn, kp_ids).items() if name}
    except sqlite3.Error:  # pragma: no cover - 坏库
        return {}


def _entry_kp_ids(
    conn,
    *,
    grade_level: str,
    exclude: Collection[str] = (),
    limit: int = RECOMMEND_LIMIT,
) -> list[str]:
    """冷启动入口：该学段里没有前置的知识点（**优先本学段**，再退到更低学段）。

    「没有前置」= 依赖图里的入边为空。这些是必修的起点，也是新学生唯一
    「先看哪一个」的**有依据**答案（不是按 id 字典序瞎取一个）。

    ★ 排序按 ``|grade_index - 学生学段|`` —— 初中小朋友拿到的入口应该是初中内容，
      而不是因为「小学的根也没有前置」就把小学生课程推给他。
      ``compatible_grades`` 把更低学段也算合法（内容可以回看），所以这里**不能**直接过滤，
      只能**排序**（更低的留着当兜底）。
    ★ ``exclude`` 排除已经掌握的知识点：全掌握时不该再把起点推一遍。
    """
    from app.knowledge.library import compatible_grades, grade_index

    allowed = sorted(set(compatible_grades(grade_level)))
    rows = conn.execute(
        "SELECT k.kp_id, k.grade_level FROM kp k "
        "WHERE NOT EXISTS ("
        "  SELECT 1 FROM knowledge_dependencies d WHERE d.to_kp_id = k.kp_id"
        ") AND k.grade_level IN ({}) ORDER BY k.kp_id".format(",".join("?" * len(allowed))),
        tuple(allowed),
    ).fetchall()

    try:
        target_rank = grade_index(grade_level)
    except (KeyError, ValueError):  # pragma: no cover - 学段已在外层校验过
        target_rank = len(allowed)

    def distance(row) -> tuple[int, str]:
        grade = str(row["grade_level"])
        try:
            return (abs(grade_index(grade) - target_rank), str(row["kp_id"]))
        except (KeyError, ValueError):  # pragma: no cover - 库里的脏学段
            return (99, str(row["kp_id"]))

    blocked = {kp for kp in exclude if kp}
    ordered = [str(row["kp_id"]) for row in sorted(rows, key=distance)]
    picked = [kp_id for kp_id in ordered if kp_id not in blocked][:limit]

    # ★ 补位：教材骨架目前是**一条主链**（只有一个根），于是「没有前置的入口」常常只有 1 个，
    #   对初中生就成了「推荐小学内容」—— 技术上正确（那是这条线的起点），但演示与体验都不对。
    #   所以不足 ``limit`` 时再补上**本学段**的知识点：学生可以从线头开始，也可以直接上本学段。
    if len(picked) < limit:
        same_grade = conn.execute(
            "SELECT kp_id FROM kp WHERE grade_level = ? ORDER BY kp_id", (grade_level,)
        ).fetchall()
        for row in same_grade:
            kp_id = str(row["kp_id"])
            if kp_id in blocked or kp_id in picked:
                continue
            picked.append(kp_id)
            if len(picked) >= limit:
                break
    return picked


def _kp_grade(conn, kp_id: str) -> str | None:
    from app.store import kb as kb_repo

    try:
        record = kb_repo.get_kp(conn, kp_id)
    except sqlite3.Error:  # pragma: no cover - 坏库
        return None
    return record.grade_level if record is not None else None


def build_recommendation(
    request: Request,
    store,
    *,
    student_id: str,
    grade_level: str,
) -> RecommendationResponse:
    """★ 个性化推荐的**唯一实现**（票 20，被 ``GET /profile`` 与 ``/recommendation`` 共用）。

    三段式，优先级从高到低：

    1. **待重练**（``source="review"``）：练过但掌握度 < :data:`REVIEW_MASTERY_CEILING` 的知识点，
       按「分数升序、最近练过优先」排 —— 这就是「连续答错 → 下一轮更可能再考它」；
    2. **依赖图后继**（``source="graph"``）：掌握度 ≥ 阈值的知识点，经
       ``deps.recommend_next()`` 取它的**后继**（「掌握变量 → 推荐循环」）。
       这是执行文档 §8.6 的用途一，**不自己写第二个推荐器**；
    3. **冷启动**（``source="cold_start"``）：一条记录都没有的新学生，给图里的**入口知识点**。

    知识库不可用时退化为「只用掌握度」（第 1 段照常工作，第 2/3 段跳过）——
    推荐是加分项，不该让画像整体打不开。
    """
    mastery_map = store.mastery_map()

    # ① 待重练：练过、但掌握度不够（含答错扣下来的）
    review_candidates = [
        (kp_id, score) for kp_id, score in mastery_map.items() if score < REVIEW_MASTERY_CEILING
    ]
    review_candidates.sort(key=lambda item: (item[1], item[0]))

    conn = _load_kb_connection(request)
    try:
        items: list[RecommendationItem] = []
        # ★ 去重集合：同一个知识点只能出现一次。**必须跨两段共享** ——
        #   一个知识点完全可能既是「待重练」（掌握度不够）又是别人的「后继」
        #   （前置已掌握），两段各推一次就会出现**重复条目**（实测踩到过：
        #   推荐列表里 `training-inference-jr` 冒了两次，学生看到「先回头把 X、X 再练熟」）。
        picked: set[str] = set()
        names: dict[str, str] = {}
        if conn is not None and review_candidates:
            names.update(_kp_names(conn, [kp for kp, _ in review_candidates[: RECOMMEND_LIMIT * 2]]))

        for kp_id, score in review_candidates:
            if len(items) >= RECOMMEND_LIMIT:
                break
            if kp_id in picked:
                continue
            picked.add(kp_id)
            items.append(
                RecommendationItem(
                    kp_id=kp_id,
                    name=names.get(kp_id, kp_id),
                    grade_level=None,
                    depth=0,
                    mastery=max(0.0, min(1.0, float(score))),
                    reason="这个知识点还没练熟，我们把刚才卡住的地方再过一遍。",
                )
            )
        source: RecommendationSource = "review" if items else "empty"

        # ② 依赖图后继（仅在还有位置、且知识库可用时）
        if conn is not None and len(items) < RECOMMEND_LIMIT:
            from app.knowledge.deps import recommend_next

            mastered = [
                kp_id
                for kp_id, score in mastery_map.items()
                if score >= MASTERY_UNLOCK_THRESHOLD
            ]
            # 多要几条：其中可能有一部分与第 ① 段重复（去重后会不够 RECOMMEND_LIMIT）
            graph_rows = recommend_next(
                conn,
                mastered,
                limit=RECOMMEND_LIMIT + len(picked),
                grade_level=grade_level,
            )
            graph_names = _kp_names(conn, [row.kp_id for row in graph_rows]) if graph_rows else {}
            added_graph = False
            for row in graph_rows:
                if len(items) >= RECOMMEND_LIMIT:
                    break
                if row.kp_id in picked:
                    continue  # 已在第 ① 段作为「待重练」推过（重练优先，不重复）
                picked.add(row.kp_id)
                added_graph = True
                items.append(
                    RecommendationItem(
                        kp_id=row.kp_id,
                        name=graph_names.get(row.kp_id, row.name or row.kp_id),
                        grade_level=_as_grade_or_none(row.grade_level),
                        depth=max(1, int(row.depth)),
                        mastery=max(0.0, min(1.0, mastery_map.get(row.kp_id, 0.0))),
                        reason="你已经掌握了它的前置知识，可以顺着这条线往下学了。",
                    )
                )
            if added_graph and source == "empty":
                source = "graph"

        # ③ 冷启动：还没有「待重练」也没有「可推进的后继」（新学生，或全掌握但图走到头了）
        if not items and conn is not None:
            entry_ids = _entry_kp_ids(
                conn,
                grade_level=grade_level,
                # 已掌握的不再当起点推（全掌握时宁可不推，也不重复推一遍）
                exclude=[kp for kp, score in mastery_map.items() if score >= MASTERY_UNLOCK_THRESHOLD],
            )
            entry_names = _kp_names(conn, entry_ids)
            for kp_id in entry_ids:
                items.append(
                    RecommendationItem(
                        kp_id=kp_id,
                        name=entry_names.get(kp_id, kp_id),
                        grade_level=_as_grade_or_none(_kp_grade(conn, kp_id)),
                        depth=0,
                        mastery=max(0.0, min(1.0, mastery_map.get(kp_id, 0.0))),
                        reason="这是这条学习路线的起点，我们从它开始。",
                    )
                )
            if items:
                source = "cold_start"
    finally:
        if conn is not None:
            conn.close()

    summary = _recommendation_summary(source, items)
    logger.info(
        "推荐：学生=%s 学段=%s 来源=%s 条数=%d（%s）",
        student_id,
        grade_level,
        source,
        len(items),
        "、".join(item.kp_id for item in items) or "无",
    )
    return RecommendationResponse(
        student_id=student_id, source=source, items=items, summary=summary
    )


def _recommendation_summary(source: RecommendationSource, items: list[RecommendationItem]) -> str:
    """一句可读总述（对话里可直接念；空推荐也要说清「为什么没有」而不是留白）。"""
    if not items:
        return "暂时没有可以推荐的知识点（本地知识库还没准备好，先聊聊你想学什么吧）。"
    names = "、".join(item.name or item.kp_id for item in items[:2])
    if source == "review":
        return f"先回头把{names}再练熟一点，我们再往前走。"
    if source == "graph":
        return f"顺着你已掌握的内容，下一步适合学{names}。"
    return f"从{names}开始吧，这是这条学习路线的起点。"


def _as_grade_or_none(value: str | None) -> GradeLevel | None:
    """库里/图里的学段字符串 → 契约字面量（认不出就 ``None``，不猜）。"""
    allowed: tuple[str, ...] = ("primary_low", "primary_high", "junior", "senior")
    return value if value in allowed else None  # type: ignore[return-value]


def _read_student(store, student_id: str) -> Student | None:
    """从该学生的 ``learning.db`` 读学生行（秒 → 毫秒的换算只在 ``to_contract_ms`` 里做）。

    ★ 这是 ``StudentRecord → Student`` 的**唯一映射点**：``current_chapter`` 也只在这里补，
      别处（``routes/students.py`` 的 ``LearningDbStudentStore`` 是另一条学生出参路径，
      但它的契约里没有章节字段）不许再写第二份映射 —— 两处各写一份，改字段时必漏一处。
    """
    record = store.get_student(student_id)
    if record is None:
        return None
    return Student(
        student_id=record.student_id,
        nickname=record.nickname,
        grade_level=as_grade_level(record.grade_level),
        created_at=to_contract_ms(record.created_at),
        last_active_at=to_contract_ms(record.last_active_at),
        current_chapter=record.current_chapter,
    )


# --------------------------------------------------------------------------- #
# 读：画像（供 get_student_profile Tool 使用）
# --------------------------------------------------------------------------- #
@router.get(
    "/profile/{student_id}",
    response_model=StudentProfile,
    summary="画像与掌握度",
)
def student_profile(request: Request, student_id: str) -> StudentProfile:
    """读某学生的画像：基本身份 + 掌握度 + 偏好 + **依赖图推荐**（票 20 填充）。

    - 学生不存在 → **404**（空画像会让学生以为「我没学过任何东西」，两者必须区分）；
    - ``studentId`` 非法 → **422**（它会被拼进文件系统路径）；
    - 库读写失败 → **503**（可读中文；上层 Tool 会把它转成 `error` 事件而不是崩）。

    ★ ``recommended_kp_ids`` 自票 20 起**不再是空的**：它由 :func:`build_recommendation`
      算出（依赖图 + 掌握度 + 冷启动兜底）。**不要**在别处再算一份 ——
      两套推荐算法会给出两个不同的「下一步」，而学生只会看到其中一个。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)

    store = open_learning_store(data_dir, student_id)
    try:
        student = _read_student(store, student_id)
        if student is None:
            raise HTTPException(status_code=404, detail=f"还没有 {student_id} 的画像：该学生尚未建立学习记录")
        try:
            mastery_rows = store.conn.execute(
                "SELECT kp_id, score, attempts, correct, last_seen_at FROM mastery "
                "ORDER BY score DESC, kp_id"
            ).fetchall()
            # ★ 偏好的读**只有一处实现**（`LearningStore.preferences()`），与写入
            #   （`set_preference()`）构成这张表唯一的一对读写 —— 本文件不再自己拼 SQL。
            preferences = store.preferences()
        except sqlite3.Error as exc:  # 表被外力删掉 / 库损坏
            logger.exception("读画像失败：%s", student_id)
            raise HTTPException(status_code=503, detail=f"读取学习记录失败（本地数据库异常）：{exc}") from exc

        mastery = [
            Mastery(
                kp_id=str(row["kp_id"]),
                score=float(row["score"] or 0.0),
                attempts=int(row["attempts"] or 0),
                correct=int(row["correct"] or 0),
                # 库里的 last_seen_at 是**秒**；契约用毫秒（同 to_contract_ms 的口径）
                last_seen_at=to_contract_ms(row["last_seen_at"]) or None,
            )
            for row in mastery_rows
        ]

        # ★ 推荐（§8.6 用途一）：依赖图 + 掌握度 + 冷启动兜底。**只此一处实现。**
        recommendation = build_recommendation(
            request, store, student_id=student_id, grade_level=student.grade_level
        )
        return StudentProfile(
            student=student,
            mastery=mastery,
            preferences=preferences,
            recommended_kp_ids=[item.kp_id for item in recommendation.items],
        )
    finally:
        store.close()


@router.get(
    "/profile/{student_id}/recommendation",
    response_model=RecommendationResponse,
    summary="下一步学什么（依赖图 + 掌握度 + 冷启动）",
)
def student_recommendation(
    request: Request,
    student_id: str,
    grade_level: str | None = Query(None, description="覆盖学段（默认用画像里的当前学段）"),
    gradeLevel: str | None = Query(None, include_in_schema=False),
) -> RecommendationResponse:
    """★ 个性化推荐的**专用出口**（票 20 的「可演示数据流」）。

    与 ``GET /profile`` 的差别只有一层：这里会返回**为什么这么推荐**
    （``source`` + 每条的 ``reason`` + 掌握度），前端能显示一句可照念的引导语，
    验收时也能一眼断言「是重练、是依赖图、还是冷启动」。

    **学生不存在时自动建立**（冷启动兜底）：全新学生 id 直接问「学什么」是正常用法，
    回 404 会让前端显示一个空白页 —— 而冷启动必须能用是票 15/20 的明确验收项。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)

    override = grade_level or gradeLevel
    store = open_learning_store(data_dir, student_id)
    try:
        student = store.get_student(student_id)
        if student is None:
            student = store.upsert_student(
                student_id, nickname="", grade_level=DEFAULT_COLD_START_GRADE
            )
            logger.info(
                "冷启动：为 %s 建立学生行（学段 %s），直接给推荐路径",
                student_id,
                student.grade_level,
            )
        level = override or student.grade_level
        if level not in ("primary_low", "primary_high", "junior", "senior"):
            raise HTTPException(
                status_code=422,
                detail=f"gradeLevel 非法：{level!r}（只允许四学段之一）",
            )
        return build_recommendation(
            request, store, student_id=student_id, grade_level=level
        )
    finally:
        store.close()


# --------------------------------------------------------------------------- #
# 写：学习记录回流
# --------------------------------------------------------------------------- #
@router.post(
    "/profile/{student_id}/events",
    response_model=LearningEventAck,
    summary="学习记录写入（答题/代码/动画观看/答疑）",
)
def record_learning_event(
    request: Request, student_id: str, payload: LearningEventRequest
) -> LearningEventAck:
    """把一条结构化学习记录写进该学生的 ``learning.db``。

    冷启动兜底：学生行不存在时按请求里的学段（缺省 ``primary_high``）建一条 ——
    「学生还没登录就先产生了学习记录」不该丢数据，也不该 500。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)

    store = open_learning_store(data_dir, student_id)
    try:
        student = store.get_student(student_id)
        if student is None:
            student = store.upsert_student(
                student_id,
                nickname="",
                grade_level=payload.grade_level or DEFAULT_COLD_START_GRADE,
            )
            logger.info("冷启动：为 %s 自动建立学生行（学段 %s）", student_id, student.grade_level)

        try:
            store.add_history(
                kp_id=payload.kp_id,
                activity=payload.activity,
                session_id=payload.session_id or "",
                # ★ 不写 question（对话正文不进 SQLite）：这一列保持为空字符串
                question="",
                is_correct=payload.is_correct,
                detail=payload.detail,
            )
        except sqlite3.Error as exc:
            logger.exception("学习记录写入失败：%s", student_id)
            raise HTTPException(status_code=503, detail=f"学习记录写入失败（本地数据库异常）：{exc}") from exc

        # 刷新活跃时间（`student.last_active_at`）—— 「重启后学习记录仍在」这条验收要看它
        store.upsert_student(
            student_id,
            nickname=student.nickname,
            grade_level=student.grade_level,
        )
        return LearningEventAck(ok=True)
    finally:
        store.close()


@router.put(
    "/profile/{student_id}/preferences",
    response_model=LearningEventAck,
    summary="写入学习偏好（兴趣 / 讲解方式 / 节奏）",
)
def update_preference(
    request: Request, student_id: str, payload: PreferenceUpdateRequest
) -> LearningEventAck:
    """写一条学习偏好（``profile_pref`` 的**唯一生产写入口**）。

    需求要求「根据答题表现**和兴趣偏好**动态调整后续推荐」：「答题表现」那条链路
    （判分 → 掌握度 → 推荐）本就是通的，而「兴趣偏好」此前是条断头路 ——
    ``profile_pref`` 表建好了、``GET /profile`` 也读它，但**生产代码从不写**。
    本端点补上这一半：写入的偏好会经 ``GET /profile`` 进入画像，
    再由 ``get_student_profile`` Tool 拼进每轮 Prompt。

    ★ **为什么是 PUT 而不是 POST**：单键 upsert 是**幂等**操作 —— 同一个 key 提交两次，
      库里的状态完全相同（``key`` 是主键，第二次是覆盖）。POST 会暗示「追加一条记录」，
      与实际语义正好相反，调用方会以为「多写几条偏好更完整」而反复 POST。

    ★ **为什么键是封闭词表**（``contracts.PreferenceKey``：``interest | explain_style |
      pace | note``）：见该 Literal 的注释 —— 关键是「写掌握度」在**类型层面**就不可能。
      掌握度是判分规则算出来的客观量，一旦模型能通过偏好通道写它，
      就会出现「模型觉得学生懂了就改分」。这类多写路径的教训见 D-020。

    ★ **为什么不改 ``StudentProfile`` 的形状**：偏好已经在该模型的 ``preferences`` 里，
      本端点只写不读；出参复用 :class:`LearningEventAck`（``{ok: true}``）。

    冷启动兜底与 ``POST /events`` **完全一致**（学生行不存在时建一条）——
    两条写路径必须同口径，否则学生会遇到「写记录能用、写偏好 404」这类无谓差异。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)

    store = open_learning_store(data_dir, student_id)
    try:
        student = store.get_student(student_id)
        if student is None:
            student = store.upsert_student(
                student_id, nickname="", grade_level=DEFAULT_COLD_START_GRADE
            )
            logger.info("冷启动：为 %s 自动建立学生行（学段 %s）", student_id, student.grade_level)

        try:
            store.set_preference(payload.key, payload.value)
        except sqlite3.Error as exc:
            logger.exception("学习偏好写入失败：%s", student_id)
            raise HTTPException(status_code=503, detail=f"学习偏好写入失败（本地数据库异常）：{exc}") from exc

        logger.info("已写入学习偏好：学生=%s key=%s", student_id, payload.key)
        return LearningEventAck(ok=True)
    finally:
        store.close()


# --------------------------------------------------------------------------- #
# 当前教材章节（软偏好：只进画像 Prompt，不进检索契约）
# --------------------------------------------------------------------------- #
def _ensure_student_level(store, student_id: str) -> GradeLevel:
    """确保学生行存在并返回其学段（**冷启动口径与学段轨一致**）。

    ★ 为什么不在这里写 ``DEFAULT_COLD_START_GRADE``：那会让「冷启动默认学段」出现
      **第三处**字面量/常量引用。``GradeEngine.ensure_student`` 是既有的冷启动入口
      （建行 + 留一条 ``from_level=NULL`` 的基线轨迹），章节端点复用它即可。
    ★ 为什么章节端点需要「自动建行」而不是像 ``GET /profile`` 那样 404：
      界面上的章节指示器在**全新机器**上必须正常显示「未选择章节」，
      回 404 会让它显示成一个报错 —— 而「还没选章节」本来就是新学生的正常状态。
    """
    from app.grade.rules import GradeEngine

    return as_grade_level(GradeEngine(store).ensure_student(student_id))


def _chapter_titles(request: Request, grade_level: str) -> set[str]:
    """该学段教材里的**全部章标题**（kb 不可用 → 503）。

    ★ 查询**只有一份**：``kb_repo.chapters_by_grade``（``store/kb.py``）——
      它已经处理了「按第N章的章号排序」这件事。这里只把标题取成集合做**成员判断**，
      **不重新排序、不复制一份 SELECT**（复制一份迟早会漏掉它的排序修正）。
    """
    from app.store import kb as kb_repo

    conn = _load_kb_connection(request)
    if conn is None:
        raise HTTPException(
            status_code=503,
            detail="教材章节清单不可用（本地知识库缺失或损坏）：先跑 scripts/build_kb.py 再选择章节",
        )
    try:
        rows = kb_repo.chapters_by_grade(conn, grade_level)
    except sqlite3.Error as exc:
        logger.exception("章节清单读取失败：%s", grade_level)
        raise HTTPException(
            status_code=503, detail=f"读取教材章节失败（知识库异常）：{exc}"
        ) from exc
    finally:
        conn.close()
    return {str(row["chapter_title"]) for row in rows}


def _chapter_state(store, student_id: str) -> ChapterStateOut:
    """读回当前章节状态（**读写同形**，两个端点共用这一处构造）。"""
    record = store.get_student(student_id)
    if record is None:  # pragma: no cover - 调用方都已 ensure 过学生行
        return ChapterStateOut(grade_level=DEFAULT_COLD_START_GRADE, chapter_title="")
    return ChapterStateOut(
        grade_level=as_grade_level(record.grade_level),
        chapter_title=record.current_chapter,
    )


@router.get(
    "/profile/{student_id}/chapter",
    response_model=ChapterStateOut,
    summary="当前教材章节",
)
def read_chapter(request: Request, student_id: str) -> ChapterStateOut:
    """读学生当前在学的章节（``chapterTitle`` 为空串 = 未选择）。

    - ``studentId`` 非法 → 422（它会被拼进文件系统路径）；
    - 学生行不存在 → **自动建行**（冷启动，见 :func:`_ensure_student_level`），
      **不 404**：章节指示器在全新机器上要能显示「未选择章节」。
      因此本端点对**全新学生**是「建行 + 读」，对已存在的学生才是纯读。
    - 读库失败 → 503（可读中文）。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)

    store = open_learning_store(data_dir, student_id)
    try:
        try:
            _ensure_student_level(store, student_id)
            return _chapter_state(store, student_id)
        except sqlite3.Error as exc:
            logger.exception("读取当前章节失败：%s", student_id)
            raise HTTPException(
                status_code=503, detail=f"读取当前章节失败（本地数据库异常）：{exc}"
            ) from exc
    finally:
        store.close()


@router.put(
    "/profile/{student_id}/chapter",
    response_model=ChapterStateOut,
    summary="设定或清除当前教材章节",
)
def write_chapter(
    request: Request, student_id: str, body: ChapterUpdateRequest
) -> ChapterStateOut:
    """设定/清除当前章节（**学生显式选择的唯一落点**）。

    规则：

    - ``chapterTitle`` 为空串 → **清除**（写 NULL，回到「不限章节，自由问答」）；
      清除**不需要 kb**（清掉一个值不需要先查清单）。
    - 非空 → 必须命中该生**当前学段**的章标题（清单来自 ``kb.sqlite``），
      不在清单里 → **422**（否则 Prompt 里会出现一本不存在的教材）；
    - kb 不可用且要设非空标题 → **503**（提示 ``build_kb``，**不猜、不静默接受**）。

    ★ **不做 SQL 硬过滤**：章节是软偏好，检索契约（``RagSearchRequest``）一个字没改，
      学生选了第 4 章之后再问第 9 章的内容，``rag_search`` 照常检索。
    ★ 学段一变，章节由 ``app/grade/rules.py`` 清空（那本教材已经不存在了）——
      本端点**不负责**这件事，也不要在读的时候「顺手修正」。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)
    title = body.chapter_title.strip()

    store = open_learning_store(data_dir, student_id)
    try:
        try:
            grade_level = _ensure_student_level(store, student_id)
            if not title:
                store.set_current_chapter(student_id, None)
                logger.info("已清除当前章节：学生=%s", student_id)
                return _chapter_state(store, student_id)

            # 非空标题：必须命中该生**当前学段**的教材清单（kb 不可用 → 503，见 _chapter_titles）
            titles = _chapter_titles(request, grade_level)
            if title not in titles:
                raise HTTPException(
                    status_code=422,
                    detail=f"章节不在当前学段（{grade_level}）的教材清单里：{title}",
                )
            store.set_current_chapter(student_id, title)
        except sqlite3.Error as exc:
            # ⚠️ HTTPException（422/503）不是 sqlite3.Error，不会被这里吞掉。
            logger.exception("当前章节写入失败：%s", student_id)
            raise HTTPException(
                status_code=503, detail=f"当前章节写入失败（本地数据库异常）：{exc}"
            ) from exc
        logger.info("已设定当前章节：学生=%s 学段=%s 章节=%s", student_id, grade_level, title)
        return _chapter_state(store, student_id)
    finally:
        store.close()


def _require_data_dir(request: Request) -> str:
    """取学生数据根；缺失时给**可读**的 503（而不是在别处抛 KeyError）。

    ★ 实现归口在 :func:`app.routes.students.require_data_dir` —— 画像 / 练习 / 学段 / 动画
    四条轨必须**同一口径**（只认显式传入的 ``--data-dir``，理由见
    `resolve_student_data_root` 的注释）。保留这个私有名字只是为了少改调用点。
    """
    return require_data_dir(request)


__all__ = [
    "DETAIL_MAX_CHARS",
    "KP_ID_MAX_CHARS",
    "LearningEventAck",
    "LearningEventRequest",
    "RECOMMEND_LIMIT",
    "REVIEW_MASTERY_CEILING",
    "RecommendationItem",
    "RecommendationResponse",
    "build_recommendation",
    "read_chapter",
    "router",
    "update_preference",
    "write_chapter",
]
