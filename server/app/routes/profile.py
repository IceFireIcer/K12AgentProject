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

★★ 合规红线（§8.1 / §12）：**SQLite 不存对话正文** —— ★ 唯一例外是
   **冷启动五问的回答**（`onboarding_qa` 表，见 `app/store/migrations.py` 的迁移 v5 与
   `app/routes/onboarding.py`）。例外**只对那 5 条回答生效**：

   | 路径 | 口径 |
   | --- | --- |
   | 本模块的 `/events`（普通学习记录） | 仍**不承载**正文：`learning_history.question` 恒为空 |
   | quiz / animation / coding 判分路径 | 仍不存学生原话与代码片段 |
   | 冷启动五问（`onboarding_qa`） | ★ 例外：存学生原话（有界、一次性、明确知道写了什么） |

   除这 5 条以外，本模块只接受「活动类型 + 知识点 id + 对错 + 一句固定口径的说明 + 时间戳」；
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

from datetime import date
import random
import logging
import re
import sqlite3
from typing import Collection, Sequence

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import Field, field_validator

from app.contracts import (
    GRADE_LEVEL_LABELS,
    LEARNING_ACTIVITY_LABELS,
    TAG_DIMENSIONS,
    TAG_LABELS,
    CamelModel,
    ChapterStateOut,
    ChapterUpdateRequest,
    GradeLevel,
    IdentityFlagsRequest,
    IdentityOut,
    LearningActivity,
    LearningEventEntry,
    LearningEventHistoryOut,
    Mastery,
    OpeningGuidance,
    PreferenceUpdateRequest,
    ProfileTagOut,
    ProfileTagUpdateRequest,
    ProfileTagsOut,
    ProfileTimeline,
    ProfileTimelineEvent,
    RecommendationSource,
    RefreshApplyOut,
    RefreshApplyRequest,
    RefreshRejectOut,
    STUDENT_FALLBACK_NAME,
    Student,
    StudentProfile,
    safe_display_name,
)
# ★ 白名单与词表从**存储层**的常量 import（它是 TS 那份的唯一 Python 镜像）：
#   路由层只做「出栈再过一遍 + 入参先挡一道」，不自己再抄一份键表。
from app.store.learning import (
    ALLOWED_TAG_KEY_SET,
    ONBOARDING_STATES,
    TAG_SOURCES,
)
from app.routes.students import (
    DEFAULT_COLD_START_GRADE,
    DEFAULT_STUDENT_NICKNAME,
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

#: 推荐依据最多带几条（票 28）：依据是「一句话解释」，列多了等于把画像整张倒给界面。
_RECOMMEND_BASIS_LIMIT = 5

#: ★ 「该重练」的掌握度上限：低于它、且**已经作答过**的知识点会被排到推荐最前面。
#: 这就是票 15/20 要求的「连续答错某知识点 → 下一轮更可能再考它」——**可演示的数据流**：
#: 同一份代码，只要 ``mastery.score`` 掉到这条线以下，推荐的第一位就换成它。
REVIEW_MASTERY_CEILING = 0.5

# ★ 推荐的来源（`RecommendationSource`）**定义在 `app/contracts.py`**，本文件只 import：
#   它是「推荐」与「开场引导」两个端点共用的冻结词表，两处各写一份 `Literal` 就会漂移
#   （漂移的表现是「推荐页说是重练、开场语说这是新起点」这类自相矛盾）。


class LearningEventRequest(CamelModel):
    """``POST /api/profile/{student_id}/events`` 的请求体（学习记录写入）。

    由 ``learning-log`` Extension 构造，字段全部是**从对话里提取出来的结构化信息**：
    没有任何一个字段用于承载对话正文（这是有意的，见模块头）——
    冷启动五问走 ``/api/onboarding/*`` 的另一张表，不从这里过。
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


class RecommendationBasis(CamelModel):
    """推荐依据的一条（票 28）：从**该学生自己的** ``profile_tags`` 投影出来。

    ★ 只带 key / value / 中文名：界面照念「因为你喜欢先看结论」，
      而不是把内部键名或置信度摊给学生看。
    """

    key: str
    value: str
    label: str = ""


class InterestDrift(CamelModel):
    """兴趣漂移提示（§5.2 #7）。**只读**，不写任何标签。

    ★ 为什么不叫「兴趣历史」：`profile_tags` 的主键是 `(学生, 键)` ——
      同一时刻只存**一个** `interest_topic`，我们**没有**兴趣的时间序列。
      所以这里不假装能比较「过去的兴趣」，只用现有数据里唯一诚实的信号：
      **学生明说的兴趣** 与 **最近实际在学的主题** 对不上。
    ★ 不写回标签：用推断去覆盖学生明说的兴趣，正是 D-020 反复吃过的错。
    """

    #: 是否提示更新（False 时其余字段仍回填，便于界面判断要不要显示）
    drifted: bool = False
    #: 学生明说的兴趣（interest_topic，可能为空）
    declared: str = ""
    #: 最近实际在学的主题（current_topic / 最近知识点，可能为空）
    recent: str = ""
    #: 一句可读中文（界面直接用，不在前端拼）
    message: str = ""


#: 兴趣漂移的判据下限：主题太短（1 个字）没法判断是否「不一样」，不提示。
_DRIFT_MIN_CHARS = 2


def _interest_drift(store, student_id: str) -> InterestDrift:
    """兴趣漂移检测（§5.2 #7「20 轮后兴趣变了，提示更新」）。

    ★★ 判据只有一个，而且是刻意选的：**学生明说的兴趣**（interest_topic，L2）
      与 **最近实际在学的主题**（current_topic / 最近知识点，L1）对不上。
      为什么不比较「过去的兴趣 vs 现在的兴趣」：`profile_tags` 的键是唯一的，
      同一时刻只存一个值 —— **没有时间序列可比**。假装能比就是在编造数据。

    ★ **只读**：不写回任何标签。用一次推断去覆盖学生明说的兴趣，是 D-020 反复吃过的教训；
      这里只把「可能变了」摆出来，改不改是学生的动作。
    ★ parent_consent=0 → 一切为空（G-G：提示也是画像）。
    """
    empty = InterestDrift()
    if not store.parent_consent(student_id):
        return empty
    by_key = {record.key: record.value for record in store.tags(student_id)}
    declared = (by_key.get("interest_topic", "") or "").strip()
    recent = (by_key.get("current_topic", "") or by_key.get("knowledge_point", "") or "").strip()
    if len(declared) < _DRIFT_MIN_CHARS or len(recent) < _DRIFT_MIN_CHARS:
        # 一边缺数据就不提示：宁可不说，也不要拿半截数据下结论
        return InterestDrift(declared=declared, recent=recent)
    # 双向子串命中视为「同一方向」（与 _match_interest 同一套宽读，避免两套判据漂移）
    if declared in recent or recent in declared:
        return InterestDrift(declared=declared, recent=recent)
    return InterestDrift(
        drifted=True,
        declared=declared,
        recent=recent,
        message=(
            "你之前说对「" + declared + "」感兴趣，最近一直在学「" + recent + "」——"
            "要不要把兴趣也更新一下？"
        ),
    )


class RecommendationResponse(CamelModel):
    """``GET /api/profile/{student_id}/recommendation`` 的响应（票 20）。

    ``source`` 说明这一批推荐是怎么来的 —— 前端据此决定提示语，
    也是验收时「冷启动 / 依赖图 / 待重练」三种形态的**可断言标志**：

    | source | 含义 |
    | --- | --- |
    | ``review`` | 优先重练（掌握度不足且练过） |
    | ``random`` | 从「本学段、还没学过」的知识点里**随机**挑（D-074 起的主要来源） |
    | ``graph`` | *历史值*：依赖图后继 —— **D-074 起不再产出**（保留取值以免旧客户端/旧测试炸） |
    | ``cold_start`` | *历史值*：图里的入口知识点 —— **D-074 起不再产出**（同上） |
    | ``empty`` | 知识库不可用且无任何学习记录（前端按空态展示，**不是错误**） |
    """

    student_id: str
    source: RecommendationSource
    items: list[RecommendationItem] = Field(default_factory=list)
    #: 推荐依据（票 28）：本学生画像标签的投影，**不跨学生聚合**（禁做 #9）。
    #: 空数组是正常值（新学生还没标签，或家长关了同意闸）。
    basis: list[RecommendationBasis] = Field(default_factory=list)
    #: 一句总述（可读中文，用于对话里的一句话引导）
    summary: str = ""
    #: 兴趣漂移提示（§5.2 #7）：只在「说的」与「做的」对不上时才有意义，故可空。
    interest_drift: InterestDrift | None = None


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


#: ★ 兴趣类标签的优先级（§5.2 #9 的输入）：先看学生**明说**的兴趣，再看最近在学的主题/学科。
#: 顺序即优先级 —— 三个键都可能有值时，interest_topic 最能代表「他想学什么」。
_INTEREST_TAG_KEYS: tuple[str, ...] = ("interest_topic", "current_topic", "subject")

#: 兴趣词参与匹配的最短长度。
#: ⚠️ 单字（「数」「力」）会把「数据」「重力」全都命中 —— 那叫噪声，不叫个性化。
_INTEREST_MIN_CHARS = 2


def _interest_terms(store, student_id: str) -> tuple[str, ...]:
    """从画像标签里取「兴趣方向」（§5.2 #9 冷启动推荐按兴趣过滤的输入）。

    ★ 只读**学生自己**的标签（一人一库，禁做 #9）；`parent_consent=0` 时返回空
      —— 与 `_recommendation_basis` 同一道闸、同一口径（依据也是画像）。
    ★ 值可能是「数学、物理」这种连写（Q2 是自由回答），所以**切开**再逐词匹配。
    """
    if not store.parent_consent(student_id):
        return ()
    by_key = {record.key: record.value for record in store.tags(student_id)}
    terms: list[str] = []
    for key in _INTEREST_TAG_KEYS:
        for part in re.split(r"[、,，/;；\s]+", by_key.get(key, "")):
            part = part.strip()
            if len(part) >= _INTEREST_MIN_CHARS and part not in terms:
                terms.append(part)
    return tuple(terms[:6])


def _match_interest(conn, pool: Sequence[str], terms: Sequence[str]) -> list[str]:
    """池子里**名字命中兴趣**的那些（顺序沿用已打乱的 `pool`，所以结果仍是随机的）。

    ★★ 命中规则刻意**保守**：中文双向子串命中（「恐龙」命中「恐龙的种类」，「分数」命中「分数的加减」），
      并且**命中不了就返回空**。空的意思不是「没有兴趣」，而是「这次不加权」——
      宁可退回纯随机，也不要为了「看起来个性化」而推错方向。
    """
    cleaned = [t.strip() for t in terms if isinstance(t, str) and len(t.strip()) >= _INTEREST_MIN_CHARS]
    if not cleaned:
        return []
    names = _kp_names(conn, pool)
    hits: list[str] = []
    for kp_id in pool:
        name = names.get(kp_id, "")
        if not name:
            continue
        if any(term in name or name in term for term in cleaned):
            hits.append(kp_id)
    return hits


def _learnable_kp_ids(
    conn,
    *,
    grade_level: str,
    exclude: Collection[str] = (),
    limit: int = RECOMMEND_LIMIT,
    rng: "random.Random",
    interest_terms: Sequence[str] = (),
) -> list[str]:
    """随机挑几个「可以学」的知识点（**推荐与开场白共用的唯一实现**，D-074）。

    ★★ 为什么是随机、而不是沿依赖图走（2026-09-22 用户裁决，原话）：
      「你别设计成死按着内置教材和知识点的路线去走，每次随机换一个知识点；
        知识点什么解锁也去掉吧，没必要非得了解一个才能了解另一个」。
    于是原先的两段（② 依赖图后继 / ③ 冷启动入口节点）整体去掉：
    「必须先掌握 A 才能看 B」是我们对学习顺序的假设，不是学生的约束 ——
    他想先看「神经网络」就先看，不该因为没学过「数据」而看不到入口。

    ★ 仍然**按学段过滤**（先本学段；本学段一个都没有才退回全库）：
      学段隔离是硬边界（RAG 只取不高于学生学段的内容），推一个他那个学段
      根本检索不到的知识点，等于给一个点不开的入口。
    ★ ``exclude`` 传「已掌握 + 本次已选」：不推他已经会的，也不重复推。
    ★ ``rng`` **由调用方注入**（`random.Random(seed)`）：同一条会话内结果稳定、
      换一条会话就换一批 —— 这是可测的（见 `tests/test_personalization.py`）。
    """
    from app.store import kb as kb_repo

    blocked = {kp for kp in exclude if kp}
    try:
        pool = [kp for kp in kb_repo.kp_ids_by_grade(conn, grade_level) if kp not in blocked]
        if not pool:
            # 本学段没候选（教材还没铺到这一档，或全掌握了）→ 退回全库：宁可跨档，也别推空
            pool = [kp for kp in kb_repo.all_kp_ids(conn) if kp not in blocked]
    except sqlite3.Error:  # pragma: no cover - 坏库
        return []
    rng.shuffle(pool)
    if interest_terms:
        # ★★ §5.2 #9「冷启动推荐按兴趣过滤」——但**兴趣只加权，不取代随机**。
        #   为什么不能「只推兴趣」：D-074 是**用户裁决**（原话「每次随机换一个知识点」），
        #   兴趣过滤是锦上添花，不是把随机推翻成一条他可能早就腻了的窄路。
        #   所以做法是「命中的排前面 + 其余的跟在后面」，而不是「先过滤再随机」。
        wanted = _match_interest(conn, pool, interest_terms)
        if wanted:
            wanted_set = set(wanted)
            pool = wanted + [kp_id for kp_id in pool if kp_id not in wanted_set]
    return pool[:limit]


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
    rng: "random.Random | None" = None,
) -> RecommendationResponse:
    """★ 个性化推荐的**唯一实现**（票 20，被 ``GET /profile`` 与 ``/recommendation`` 共用）。

    两段式，优先级从高到低（**2026-09-22 / D-074 改**）：

    1. **待重练**（``source="review"``）：练过但掌握度 < :data:`REVIEW_MASTERY_CEILING` 的知识点，
       按「分数升序、最近练过优先」排 —— 这就是「连续答错 → 下一轮更可能再考它」；
    2. **随机挑没学过的**（``source="random"``）：本学段里、掌握度不到阈值的知识点里
       **随机**取（:func:`_learnable_kp_ids`）。
       ⚠️ 原先这里还有两段：「依赖图后继」（掌握 A → 推 A 的后继）与「冷启动入口节点」
       （入度为 0 的起点）。用户 2026-09-22 裁决去掉 ——「没必要非得了解一个才能了解另一个」。
       依赖图仍然服务于检索上下文扩展、闯关/编程的关卡结构与学习地图展示，只是**不再决定推荐什么**。

    知识库不可用时退化为「只用掌握度」（第 1 段照常工作，第 2/3 段跳过）——
    推荐是加分项，不该让画像整体打不开。
    """
    mastery_map = store.mastery_map()
    # ★★ rng 由调用方注入（开场白传「会话 id」当种子 → 同一条会话同一句）。
    #   不传时用 **学生 + 当天日期** 当种子（D-074）：
    #     · 同一天内反复取数结果稳定 —— 侧栏「建议接着练」不该每刷一次就跳一个；
    #     · 跨天自动换一批 —— 用户要的「随机给一个」在这里体现为**每天轮换**；
    #     · 也让 `/profile` 与 `/recommendation` 两个出口在同一天内给出同一份推荐
    #       （它们都调本函数，旧行为要求两者一致，这条不变量值得留着）。
    rng = rng if rng is not None else random.Random(f"{student_id}:{date.today().isoformat()}")

    conn = _load_kb_connection(request)

    # ★★ 丢掉**已删除知识点**的掌握度行（教材换代后的历史残留）。
    #    不过滤的后果实测过：旧掌握度 ``ph-data-train-predict`` 被当成「待重练」推荐出去，
    #    而它在当前教材里查不到中文名 → 界面上直接显示 **裸 kp_id**，
    #    顶栏「建议接着练」与学习档案的「继续学习」两处都是这个表现。
    #    ⚠️ kb 读不到时**不过滤**（保留旧行为）—— 不能让「库没打开」看起来像「没有学习记录」。
    if conn is not None:
        try:
            from app.store import kb as kb_repo  # noqa: PLC0415

            live = kb_repo.all_kp_ids(conn)
            mastery_map = {k: v for k, v in mastery_map.items() if k in live}
        except sqlite3.Error:  # pragma: no cover - 坏库
            pass

    # ① 待重练：练过、但掌握度不够（含答错扣下来的）
    review_candidates = [
        (kp_id, score) for kp_id, score in mastery_map.items() if score < REVIEW_MASTERY_CEILING
    ]
    review_candidates.sort(key=lambda item: (item[1], item[0]))
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

        # ② 随机挑「还没学过」的（D-074：不再走依赖图后继，也不再有「入口知识点」）
        #
        # ⚠️ 这里原先分两段：② 依赖图后继（掌握 A → 推 A 的后继 B）、③ 冷启动入口节点
        #    （依赖图里入度为 0 的那些）。两段都含「顺序」主张，用户明确要去掉。
        #    现在只剩一条：**从本学段里随机挑没学过的**。
        interest_terms = _interest_terms(store, student_id)
        if conn is not None and len(items) < RECOMMEND_LIMIT:
            learnable = _learnable_kp_ids(
                conn,
                grade_level=grade_level,
                # 已掌握的不再推（那不叫「可以学」，叫「学过了」）+ 本次已选的不重复推
                exclude=picked
                | {
                    kp_id
                    for kp_id, score in mastery_map.items()
                    if score >= MASTERY_UNLOCK_THRESHOLD
                },
                limit=RECOMMEND_LIMIT - len(items),
                rng=rng,
                # ★ 兴趣来自学生自己的标签（§5.2 #9）；读不到就是空元组 → 退回纯随机。
                interest_terms=interest_terms,
            )
            names.update(_kp_names(conn, learnable))
            for kp_id in learnable:
                picked.add(kp_id)
                items.append(
                    RecommendationItem(
                        kp_id=kp_id,
                        name=names.get(kp_id, kp_id),
                        grade_level=_as_grade_or_none(_kp_grade(conn, kp_id)),
                        depth=0,
                        mastery=max(0.0, min(1.0, mastery_map.get(kp_id, 0.0))),
                        # ★ 标点口径（报告 C16）：这条 reason 会进右栏与学习记录页，
                        #   还会被 `report-markdown.ts` 带进导出件 —— 学生面文案不用
                        #   `——` 断句（它是本应用里 LLM 文案的常见指纹），用逗号。
                        reason="这个还没学过，想的话可以从它开始看看。",
                    )
                )
            if items and source == "empty":
                source = "random"
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
        student_id=student_id,
        source=source,
        items=items,
        # ★ 推荐依据读的是**这个学生自己**的标签（一人一库）—— 禁做 #9 的落点。
        basis=_recommendation_basis(store, student_id),
        summary=summary,
        interest_drift=_interest_drift(store, student_id),
    )


#: 时间线默认/最大条数。
#: ★ 为什么有上限：时间线是给人**看**的（学生/家长），列 500 条不是「更完整」，是「没人看」。
TIMELINE_DEFAULT_LIMIT = 50
TIMELINE_MAX_LIMIT = 200

#: 学习历史（2026-09-30）：单页条数的默认值与上限。
#: ★ 上限 100 —— 一次拉太多对学生没意义（他会往下翻），却把载荷撑大。
HISTORY_DEFAULT_LIMIT = 30
HISTORY_MAX_LIMIT = 100

#: grade_history.source → 学生面措辞（封闭词表）。
#: ★ 认不出的来源**不编词**：回一句中性的话，而不是把内部枚举名当人话显示。
_GRADE_SOURCE_NOTES: dict[str, str] = {
    "explicit": "你自己设定的",
    "confirmed": "你确认过的",
    "inferred": "系统根据你的提问自动调整的",
    "rules": "系统根据你的提问自动调整的",
    "llm": "系统根据你的提问自动调整的",
}

#: 标签变更出处（origin）→ 学生面措辞（封闭词表，迁移 v7）。
#: ★ 认不出的出处**不编词**：回一句中性的话（而不是把内部枚举名当人话显示）——
#:   与 _GRADE_SOURCE_NOTES 同一条纪律。
#: ★ 空串（旧行 origin 为 NULL）也有对应措辞：「系统调整的」是中性的兜底，
#:   既不说「你自己说的」也不说「系统猜的」，如实表达「不知道是哪条路带的」。
_TAG_ORIGIN_NOTES: dict[str, str] = {
    "cold_start": "刚认识你的时候记下的",
    "refresh": "聊天里慢慢了解到的",
    "projection": "根据你的练习情况记下的",
    "": "系统调整的",
}


def _timeline_events(store, student_id: str, *, limit: int) -> list[ProfileTimelineEvent]:
    """把三处**真实存在的时间序列**汇成一条画像时间线（§5.2 #11）。

    ★★ 为什么只有三处，而不是「所有标签的历史」：
      · grade_history —— 学段本来就是时间序列（每次变化一行，有 ts 有前后值）；
      · profile_tag_history —— 画像标签的变更序列（迁移 v6 起新增）；
      · onboarding_qa —— 每问有作答时间，那是画像的**起点**。
      除此之外本项目**没有**别的可考序列：mastery 只有 last_seen_at（一个点，不是序列），
      profile_pref 是键值对。所以不做第四处，**也不从别处推断时间** ——
      时间线上每一行都必须对应库里真实存在的一条记录。

    ★ 只读**这个学生自己**的库（禁做 #9）：签名里只有一个 student_id，
      结构上没有第二名学生的位置。
    ★ 短期情绪标签**不会**出现在这里：写入侧根本没记（见 LearningStore 的
      _append_tag_history），读取侧再挡一次（tag_history）—— 两处都挡，是因为这条红线
      一旦破了，毁掉的是「不给孩子建长期负面情绪档案」这个承诺（禁做 #11）。
    ★ parent_consent=0 → 空（G-G）：时间线是画像，与 GET /tags 同一道闸。
    """
    if not store.parent_consent(student_id):
        return []
    events: list[ProfileTimelineEvent] = []

    # ① 学段变更
    for record in store.grade_history(limit=limit):
        from_label = GRADE_LEVEL_LABELS.get(str(record.from_level or ""), "")
        to_label = GRADE_LEVEL_LABELS.get(str(record.to_level or ""), "")
        if not to_label:
            # 认不出的学段值：不编句子，跳过（而不是显示一个内部枚举名）
            continue
        if from_label and from_label != to_label:
            title = "学段从" + from_label + "变成" + to_label
        elif from_label:
            # 前后同值 = 不是「变化」（历史里可能有这种行），不进时间线
            continue
        else:
            title = "开始按" + to_label + "讲"
        events.append(
            ProfileTimelineEvent(
                at=to_contract_ms(record.ts) or 0,
                kind="grade",
                title=title,
                detail=_GRADE_SOURCE_NOTES.get(str(record.source or ""), ""),
            )
        )

    # ② 画像标签变更
    for record in store.tag_history(student_id, limit=limit):
        label = TAG_LABELS.get(record.key, record.key)
        # ★ 出处说明（迁移 v7）：拼进 detail 的一句中性中文 —— 学生面**只**读
        #   title/detail 这两句现成中文，不认枚举值（双视角纪律 D-063）。
        origin_note = _TAG_ORIGIN_NOTES.get(record.origin or "", _TAG_ORIGIN_NOTES[""])
        if record.previous_value is None:
            title = "记下了「" + label + "」：" + record.value
            detail = origin_note + "。"
        else:
            title = "把「" + label + "」改成了「" + record.value + "」"
            detail = "原来是「" + record.previous_value + "」；" + origin_note + "。"
        events.append(
            ProfileTimelineEvent(
                at=to_contract_ms(record.ts) or 0,
                kind="tag",
                title=title,
                detail=detail,
                key=record.key,
                label=label,
                # ★ 出处（迁移 v7）：结构化字段（界面可据它上色/分组），
                #   而 detail 里已经把同一件事讲成人话了。
                origin=record.origin or "",
            )
        )

    # ③ 入门问答（画像的起点）
    answers = store.onboarding_answers()
    if answers:
        first_at = min((item.answered_at for item in answers if item.answered_at), default=0)
        if first_at:
            events.append(
                ProfileTimelineEvent(
                    at=to_contract_ms(first_at) or 0,
                    kind="onboarding",
                    title="完成了入门问答",
                    detail="一共答了 " + str(len(answers)) + " 个问题，画像就是从那时候开始的。",
                )
            )

    # 新的在前；同刻的事件按 kind 再排一次，避免每次请求顺序抖动
    events.sort(key=lambda event: (event.at, event.kind), reverse=True)
    return events[:limit]


def _recommendation_basis(store, student_id: str) -> list[RecommendationBasis]:
    """推荐依据（票 28）：把该学生自己的画像标签投影成可展示的三元组。

    ★ 不做跨学生聚合（禁做 #9）：只读当前这一份 ``learning.db``（一人一库），
      没有 GROUP BY / 排名 / 对比 —— 端点上不存在「别人怎么样」这个信息。
    ★ parent_consent=0 → 空（G-G）：与 ``GET /tags`` 同一道闸，因为依据也是画像。
    ★ 只给中文名与值，不给 confidence/source：界面要的是「为什么推荐」，不是内部元数据。
    """
    if not store.parent_consent(student_id):
        return []
    basis: list[RecommendationBasis] = []
    for record in store.tags(student_id):
        if record.key == "anon_student_id":
            # 匿名标识是 join 钥匙，不是「依据」——列出去等于给学生看一串随机码。
            continue
        basis.append(
            RecommendationBasis(
                key=record.key,
                value=record.value,
                label=TAG_LABELS.get(record.key, ""),
            )
        )
        if len(basis) >= _RECOMMEND_BASIS_LIMIT:
            break
    return basis


#: 开场白的几种说法（**随机选一种**，D-074）。
#:
#: 用户原话：「每次提问你想学点什么，后面随机给他跟一个知识点就可以」
#: —— 所以形态固定为「一句问学生想学什么」+ 「一个随机的知识点」，
#: 每次换一种问法（同一条会话内不换，见 `_opening_text` 的 rng 说明）。
#: ⚠️ 每条变体里 `{name}` **只能出现一次**：开场卡的动作按钮只指向一个知识点，
#:    文案里出现两个学生就不知道点下去会去哪里（这条纪律有过实测教训）。
_OPENING_VARIANTS: tuple[str, ...] = (
    "今天想聊点什么？我这边可以先从{name}说起，想听听吗？",
    "想学点什么都可以，要不我们从{name}聊起？",
    "先从{name}开始怎么样？不想聊它，也可以问我别的。",
    "你有什么想学的？或者我随手挑一个：{name}，要听听看吗？",
)


def _opening_text(
    source: RecommendationSource, items: list[RecommendationItem], rng: "random.Random"
) -> str:
    """把推荐结论拼成一句**可直接念**的开场语（纯模板，**不调 LLM**）。

    为什么用模板而不是让模型写（待实现文档给出的两个方案里选 A）：

    - 零延迟：它在**新建会话**那条路径上，而学生此刻正看着空屏等界面可用；
    - 断网 / 无 Key 可用：模型方案在没 Key 的机器上必然退回模板，那还不如只有一套；
    - 无成本：每开一段新会话就发一次云端调用，对一个「只是换个说法」的功能不值得。

    ★★ **只说第一个知识点**（不沿用 :func:`_recommendation_summary` 的「取前两条」）：
      开场语配着一个「好啊，就从这里开始」的动作按钮，而那个按钮**只能去一个地方**
      —— 接口回的 ``kp_id`` 就是第一条。文案里出现两个知识点时，学生点下去会落到
      其中一个（且看不出是哪一个）。实测踩到过：界面显示
      「从人工智能的定义、算力开始吧」，而按钮指向的是前者。
      ⚠️ 措辞仍与推荐接口**同族**（三种来源三种说法，只是这里只念第一条）。

    ★ **不编造学习历史**：`review` 那句的主语是「回头看」而 `cold_start` 是「起步」——
      它们的依据分别是「库里真有低于阈值的掌握度行」与「图里的入度为 0 节点」，
      都不是猜的。
    """
    if not items or source == "empty":
        return ""
    name = items[0].name.strip() or items[0].kp_id
    if not name:
        return ""
    if source == "review":
        body = f"{name}这个地方还没练熟，我们把它再过一遍。"
    else:
        # ★★ 其余来源（现在的 `random`，以及任何未登记的来源）走**同一组随机说法**（D-074）：
        #    既不再声称「这是这条路线的起点」（路线/解锁那套主张已按用户要求去掉），
        #    也不同一条会话里换说法 —— 变体由注入的 `rng` 选，同 seed 同结果。
        body = rng.choice(_OPENING_VARIANTS).format(name=name)
    # 「你好，我是智团团。」让学生知道**是谁**在开口，而不是凭空冒出一个没有主语的建议。
    # ★ 2026-09-21：自称与产品名（`@shared/brand` 的 `BRAND_NAME`）统一成「智团团」，
    #   此前这里是「团团」、提示词里又是「小 AI 老师 / AI 通识课老师」—— 三处不一致。
    return f"你好，我是智团团。{body}"


def _recommendation_summary(source: RecommendationSource, items: list[RecommendationItem]) -> str:
    """一句可读总述（对话里可直接念；空推荐也要说清「为什么没有」而不是留白）。"""
    if not items:
        return "暂时没有可以推荐的知识点（本地知识库还没准备好，先聊聊你想学什么吧）。"
    names = "、".join(item.name or item.kp_id for item in items[:2])
    if source == "review":
        return f"先回头把{names}再练熟一点，我们再往前走。"
    # ★ D-074：不再有「顺着依赖图往下学」与「学习路线的起点」两种说法 ——
    #   推荐只是「你还没学过的、可以看看的」，不含任何顺序主张。
    return f"想学点什么都可以，比如{names}。"


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
            # ★★ 丢掉**已删除知识点**的掌握度行（教材换代后的历史残留，见
            #    `build_recommendation` 里同一处过滤的说明）。画像页的「掌握度」
            #    列表不过滤就会逐条显示裸 kp_id —— 学生看到一列机器码。
            #    ⚠️ kb 读不到时**不过滤**：不能让「库没打开」看起来像「没有学习记录」。
            _conn = _load_kb_connection(request)
            if _conn is not None:
                try:
                    from app.store import kb as kb_repo  # noqa: PLC0415

                    _live = kb_repo.all_kp_ids(_conn)
                    mastery_rows = [r for r in mastery_rows if str(r["kp_id"]) in _live]
                except sqlite3.Error:  # pragma: no cover - 坏库
                    pass
                finally:
                    _conn.close()
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
                student_id, nickname=DEFAULT_STUDENT_NICKNAME, grade_level=DEFAULT_COLD_START_GRADE
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


@router.get(
    "/profile/{student_id}/opening",
    response_model=OpeningGuidance,
    summary="新会话开场引导（主动发起对话）",
)
def student_opening(
    request: Request,
    student_id: str,
    grade_level: str | None = Query(None, description="覆盖学段（默认用画像里的当前学段）"),
    gradeLevel: str | None = Query(None, include_in_schema=False),
    seed: str | None = Query(
        None,
        description=(
            "随机种子：同一条会话传同一个值 → 同一句开场白（同知识点、同说法）；"
            "不传则每次随机。前端传的是**会话 id**。"
        ),
    ),
) -> OpeningGuidance:
    """★ 「主动发起对话引导」的**唯一出口**（需求明文要求，此前零实现）。

    形态：**新会话建立后**调一次，把结果作为 AI 的第一条消息送进对话。
    不是「每轮打招呼」—— 它只在**会话内还没有任何消息**时才有意义。

    ★★ 不要重写推荐逻辑：本端点与 ``/recommendation`` 共用 :func:`build_recommendation`
       （它再往下走 :func:`app.knowledge.deps.recommend_next`，那是依赖图推荐的唯一实现）。
       「开场语该说什么」这件事的全部信息都在那个返回值里，本端点只做拼接。

    **没有可推荐的内容时返回空串**（而不是一句放之四海皆准的寒暄）：
    知识库缺失、学生已全部掌握、依赖图为空 —— 这三种情况都推不出该学什么，
    此时**不发开场**才是诚实的；前端据 ``text == ""`` 直接跳过。

    与 ``/recommendation`` 一样，**学生不存在时自动建立**（冷启动的第一屏就是它的用例）。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)

    override = grade_level or gradeLevel
    store = open_learning_store(data_dir, student_id)
    try:
        student = store.get_student(student_id)
        if student is None:
            student = store.upsert_student(
                student_id, nickname=DEFAULT_STUDENT_NICKNAME, grade_level=DEFAULT_COLD_START_GRADE
            )
            logger.info("冷启动：为 %s 建立学生行（学段 %s），生成开场引导", student_id, student.grade_level)
        level = override or student.grade_level
        if level not in ("primary_low", "primary_high", "junior", "senior"):
            raise HTTPException(
                status_code=422,
                detail=f"gradeLevel 非法：{level!r}（只允许四学段之一）",
            )
        # ★ rng 由 seed 派生（默认=会话 id，由主进程给）：同一条没开始的会话反复读，
        #   拿到的必须是**同一句**（否则历史里那句与屏幕上的对不上 —— D-072 修的就是这类）。
        rng = random.Random(seed) if seed else random.Random()
        recommendation = build_recommendation(
            request, store, student_id=student_id, grade_level=level, rng=rng
        )
    finally:
        store.close()

    first = recommendation.items[0] if recommendation.items else None
    guidance = OpeningGuidance(
        text=_opening_text(recommendation.source, recommendation.items, rng),
        # ★ 只在**真有推荐项**时给 kp_id：空推荐配一个 kp_id 会让前端渲染出一个
        #   「去吧」按钮，而点下去没有任何目标。
        kp_id=first.kp_id if first is not None else None,
        # ★ 知识点中文名一并给前端：动作按钮要拼「我想学「X」」，而 X 必须是**学生看到的那个名字**。
        #   此前前端是从 /recommendation 里按 kp_id 反查名字 —— 推荐改成随机之后两者不再同源，
        #   反查会落空（按钮点了没反应）。名字与 kp_id 取自同一个 item ✓
        #   ⚠️ 名字取不到时（库里没中文名，name 回落成 kp_id）**不给** —— 绝不把 slug 印给学生。
        kp_name=(
            first.name
            if first is not None and first.name and first.name != first.kp_id
            else None
        ),
        source=recommendation.source,
    )
    logger.info(
        "开场引导：学生=%s 学段=%s 来源=%s 有无开场语=%s",
        student_id,
        level,
        guidance.source,
        "有" if guidance.text else "无",
    )
    return guidance


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

    冷启动兜底：学生行不存在时按请求里的学段（缺省 ``junior``）建一条 ——
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
                nickname=DEFAULT_STUDENT_NICKNAME,
                grade_level=payload.grade_level or DEFAULT_COLD_START_GRADE,
            )
            logger.info("冷启动：为 %s 自动建立学生行（学段 %s）", student_id, student.grade_level)

        try:
            store.add_history(
                kp_id=payload.kp_id,
                activity=payload.activity,
                session_id=payload.session_id or "",
                # ★ 不写 question（正文不进 SQLite；冷启动五问走另一张表 onboarding_qa）：
                #   这一列保持为空字符串（G-K）
                question="",
                is_correct=payload.is_correct,
                detail=payload.detail,
            )
        except sqlite3.Error as exc:
            logger.exception("学习记录写入失败：%s", student_id)
            raise HTTPException(status_code=503, detail=f"学习记录写入失败（本地数据库异常）：{exc}") from exc

        # 刷新活跃时间（`student.last_active_at`）—— 「重启后学习记录仍在」这条验收要看它。
        # ★★ 必须是**单列** UPDATE，不能再用 `upsert_student` 回写整行：本端点每轮
        #   `agent_end` 都会发一次，而 `upsert_student` 的 `ON CONFLICT` 分支会把
        #   上面 `get_student` 读到的 `grade_level` 快照一起写回去 —— 「读快照 → 写回」
        #   之间学段可能已被 `app/grade/rules.py` 的规则引擎或 `POST /api/grade/override`
        #   改掉，于是这次「刷新活跃时间」把刚生效的新学段**打回旧值**，且不留
        #   `grade_history`、也不清 `current_chapter`：库里学段与轨迹互相矛盾（两处真相）。
        #   `touch_last_active` 只写 `last_active_at` 一列，没有读-改-写窗口，天然免疫。
        store.touch_last_active(student_id)
        return LearningEventAck(ok=True)
    finally:
        store.close()


@router.get(
    "/profile/{student_id}/history",
    response_model=LearningEventHistoryOut,
    summary="学习历史（结构化活动流水，倒序分页）",
)
def learning_history(
    request: Request,
    student_id: str,
    limit: int = Query(
        HISTORY_DEFAULT_LIMIT, ge=1, le=HISTORY_MAX_LIMIT, description="这一页最多几条"
    ),
    offset: int = Query(0, ge=0, description="按时间倒序跳过几条"),
) -> LearningEventHistoryOut:
    """「我做过什么」的**明细出口**（学习档案 → 学习历史）。

    ★ 与 ``GET /report`` 的分工：那个是**聚合**（每天多少条、正确率、连续天数），
      这个是**流水**（几点几分做了什么）。两者读同一张表，回答的是不同问题。
    ★ 学生面只给结构化列 + 后端折好的**中文动作名**：``detail``（内部 JSON 摘要）
      与 ``question``（恒空，G-K）**一个字节都不出**。
    ★ 还没有学习记录的学生回**空列表**（不是 404）：前端要把它渲染成「还没有记录」
      的空态，而 404 会让界面走错误分支、显示一句「读取失败」。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)

    store = open_learning_store(data_dir, student_id)
    try:
        if store.get_student(student_id) is None:
            # 冷启动（学生行还没建）：一条记录都还没有，回空页
            return LearningEventHistoryOut(student_id=student_id)
        rows = store.history_page(limit=limit, offset=offset)
        total = store.history_count()
    except sqlite3.Error as exc:
        logger.exception("学习历史读取失败：%s", student_id)
        raise HTTPException(status_code=503, detail=f"读取学习历史失败（本地数据库异常）：{exc}") from exc
    finally:
        store.close()

    events: list[LearningEventEntry] = []
    for record in rows:
        # ★ 脏行跳过（而不是兜一个默认活动）：`activity` 是 Literal，塞一个认不出的
        #   值进模型会把整个端点打成 500 —— 与画像标签出栈那处的「脏值跳过」同一条口径。
        if record.activity not in LEARNING_ACTIVITY_LABELS:
            continue
        events.append(
            LearningEventEntry(
                id=record.id,
                at=to_contract_ms(record.ts),
                activity=record.activity,  # type: ignore[arg-type]
                activity_label=LEARNING_ACTIVITY_LABELS[record.activity],
                kp_id=record.kp_id,
                is_correct=record.is_correct,
            )
        )
    return LearningEventHistoryOut(
        student_id=student_id,
        events=events,
        total=total,
        # ★ 用 `len(rows)`（读到的原始行数）而不是 `len(events)`：脏行被跳过时，
        #   用过滤后的条数会让 has_more 假阴性（明明还有却说到头了）。
        has_more=offset + len(rows) < total,
    )


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
                student_id, nickname=DEFAULT_STUDENT_NICKNAME, grade_level=DEFAULT_COLD_START_GRADE
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


# --------------------------------------------------------------------------- #
# 画像标签 / 本地身份（票 25 / 28）：白名单投影的读写
# --------------------------------------------------------------------------- #
def _tags_view(store, student_id: str) -> ProfileTagsOut:
    """拼 tags 出参（三个标签端点共用这一处构造）。

    ★ parent_consent=0 → tags **空数组**（G-G）：落库本身不算外发，这个读出口才算。
      两道闸照实回 —— 设置页要显示开关当前状态，不能因为闸关了就什么都不给。
    """
    parent_consent = store.parent_consent(student_id)
    memory_switch = store.memory_switch(student_id)
    tags: list[ProfileTagOut] = []
    if parent_consent:
        for record in store.tags(student_id):
            # 出栈再过一遍白名单（G-A）：store.tags 里已过一次，这里是路由层的兜底 ——
            # 宁可重复一次，也不让「某天有人在 store 里加了个不过滤的读路径」漏出去。
            if record.key not in ALLOWED_TAG_KEY_SET:
                continue
            # 出参模型的 source 是 Literal：库里被外力塞了别的值就跳过，
            # 不让一条脏行把整个读取端点打成 500（与白名单同一个防御口径）。
            if record.source not in TAG_SOURCES:
                continue
            tags.append(
                ProfileTagOut(
                    key=record.key,
                    value=record.value,
                    confidence=record.confidence,
                    source=record.source,  # type: ignore[arg-type]
                    ts=to_contract_ms(record.ts),
                    dimension=TAG_DIMENSIONS.get(record.key, 0),
                    # 中文名由后端给（唯一来源）：渲染层不写这些字面量，kp-slug 守卫不打架。
                    label=TAG_LABELS.get(record.key, ""),
                )
            )
    return ProfileTagsOut(tags=tags, parent_consent=parent_consent, memory_switch=memory_switch)


def _identity_out(store, student_id: str) -> IdentityOut:
    """拼 identity 出参（读 / 写 flags 共用）。

    ★ real_name 只给**渲染层做本地替换**；代码里不存在「读它再拼 prompt」的路径（G-C）。
      display_name 是它过 safe_display_name 后的安全值（可能是「同学」）。
    """
    identity = store.identity_or_default(student_id)
    # 状态也是 Literal：库里被外力塞了非法值时按「还没开始」回，不 500。
    state = identity.onboarding_state if identity.onboarding_state in ONBOARDING_STATES else "not_started"
    return IdentityOut(
        anon_student_id=student_id,
        real_name=identity.real_name,
        display_name=safe_display_name(identity.real_name),
        parent_consent=identity.parent_consent,
        memory_switch=identity.memory_switch,
        onboarding_state=state,  # type: ignore[arg-type]
    )


@router.get(
    "/profile/{student_id}/tags",
    response_model=ProfileTagsOut,
    summary="画像标签（白名单投影，已按 TTL 过滤）",
)
def read_profile_tags(request: Request, student_id: str) -> ProfileTagsOut:
    """读画像标签。

    - 出栈前过白名单（G-A）与短期情绪 TTL（G-E）；
    - parentConsent=false → tags 空（G-G）；
    - 学生行不存在也**不建行**（读路径零副作用），回默认闸值 + 空标签。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)
    store = open_learning_store(data_dir, student_id)
    try:
        return _tags_view(store, student_id)
    except sqlite3.Error as exc:
        logger.exception("读取画像标签失败：%s", student_id)
        raise HTTPException(
            status_code=503, detail=f"读取画像标签失败（本地数据库异常）：{exc}"
        ) from exc
    finally:
        store.close()


@router.put(
    "/profile/{student_id}/tags/{key}",
    response_model=ProfileTagsOut,
    summary="写一个画像标签（白名单内）",
)
def update_profile_tag(
    request: Request, student_id: str, key: str, body: ProfileTagUpdateRequest
) -> ProfileTagsOut:
    """写 / 覆盖一个画像标签（标签纠错的写入口）。

    三道闸在存储层（LearningStore.upsert_tag），这里再挡一层并把它翻成 422：
    - 非白名单键 → 422（「标签表无此 key；写入端点无此参数」的可测形态）；
    - source='inferred' 的非情绪/风格键 → 422（禁做 #10）；
    - emotion 非有限枚举 → 422（禁做 #12）。
    memory_switch=false 时**不写**（G-F），端点照常 200 —— 返回的 tags 里就是没它。
    """
    validate_student_id(student_id)
    if key not in ALLOWED_TAG_KEY_SET:
        raise HTTPException(
            status_code=422,
            detail=f"标签键不在白名单里：{key}（画像只收 LLM_VISIBLE_TAGS 里的键）",
        )
    data_dir = _require_data_dir(request)
    store = open_learning_store(data_dir, student_id)
    try:
        try:
            store.upsert_tag(
                student_id,
                key,
                body.value,
                confidence=body.confidence,
                source=body.source,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except sqlite3.Error as exc:
            logger.exception("画像标签写入失败：%s", student_id)
            raise HTTPException(
                status_code=503, detail=f"画像标签写入失败（本地数据库异常）：{exc}"
            ) from exc
        return _tags_view(store, student_id)
    finally:
        store.close()


@router.delete(
    "/profile/{student_id}/tags/{key}",
    response_model=ProfileTagsOut,
    summary="删一个画像标签（L3 一键撤销）",
)
def delete_profile_tag(request: Request, student_id: str, key: str) -> ProfileTagsOut:
    """删一个画像标签（猜错了能救；也是信任基础）。键不在白名单 → 422（同写入口径）。"""
    validate_student_id(student_id)
    if key not in ALLOWED_TAG_KEY_SET:
        raise HTTPException(status_code=422, detail=f"标签键不在白名单里：{key}")
    data_dir = _require_data_dir(request)
    store = open_learning_store(data_dir, student_id)
    try:
        try:
            store.delete_tag(student_id, key)
        except sqlite3.Error as exc:
            logger.exception("画像标签删除失败：%s", student_id)
            raise HTTPException(
                status_code=503, detail=f"画像标签删除失败（本地数据库异常）：{exc}"
            ) from exc
        return _tags_view(store, student_id)
    finally:
        store.close()


@router.post(
    "/profile/{student_id}/tags/refresh-apply",
    response_model=RefreshApplyOut,
    summary="批量应用持续画像迭代的概括结果（分档写入）",
)
def refresh_apply_tags(
    request: Request, student_id: str, body: RefreshApplyRequest
) -> RefreshApplyOut:
    """把一次「持续画像迭代」概括出来的标签批量应用到画像（分档写入）。

    ★★ 为什么是**逐条独立**而不是整体成功/失败：概括是**尽力而为**的增强 ——
      某一条被白名单/取值域/分档挡下，不该让其它条一起丢。与
      `sync_observed_tags` 的「逐条独立」同一条纪律。

    ★★ 分档在存储层（`LearningStore.upsert_tag_from_summary`）：本端点只负责
      ① 白名单先挡一道（非白名单 → 该条拒，不 500）；
      ② 把存储层的 ValueError 翻成**该条被拒**（而不是整个请求 422）；
      ③ 回逐条结果 + 应用后的最新投影。

    ★ 为什么 422 只留给**结构性问题**（空列表 / 超上限 / source='declared'）：
      那三类是「调用方写错了代码」，重试也一样；而**单条**不合法是数据问题，
      应该被记录、被跳过，让其余条照常落地。

    ★ memory_switch=false（G-F）：写入原语**逐条返回 False**（不写任何标签），
      这里如实记进 `rejected`（reason='memory-switch-off'），端点照常 200 ——
      与 `PUT /tags/{key}` 的口径一致（关闸不是错误，是有效状态）。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)
    store = open_learning_store(data_dir, student_id)
    try:
        applied: list[str] = []
        rejected: list[RefreshRejectOut] = []
        seen: set[str] = set()
        for item in body.tags:
            key = item.key.strip()
            # ① 白名单（G-A）：路由层先挡一道 —— 与 PUT /tags/{key} 同一口径，
            #    但这里是**该条拒**而不是整体 422（见 docstring）。
            if key not in ALLOWED_TAG_KEY_SET:
                rejected.append(RefreshRejectOut(key=key, reason="whitelist"))
                continue
            # ② 同一次请求内同键重复 → 留第一条（与 parseSummaryTags 去重口径一致）。
            if key in seen:
                rejected.append(RefreshRejectOut(key=key, reason="duplicate"))
                continue
            seen.add(key)
            try:
                written = store.upsert_tag_from_summary(
                    student_id,
                    key,
                    item.value,
                    source=item.source,
                    confidence=item.confidence,
                    reason=body.reason,
                )
            except ValueError as exc:
                # 取值域非法（emotion/intensity）/ 推断限键（禁做 #10）等 → 该条拒。
                logger.info("概括条目被拒：学生=%s 键=%s：%s", student_id, key, exc)
                rejected.append(
                    RefreshRejectOut(key=key, reason=_refresh_reject_reason(str(exc)))
                )
                continue
            if written:
                applied.append(key)
            else:
                # written=False 有两种来源：memory_switch 挡住，或**分档拒绝**。
                # 用 memory_switch 现状把它区分开（分档拒绝的细节已由存储层记日志）。
                reason = (
                    "memory-switch-off"
                    if not store.memory_switch(student_id)
                    else _refresh_skip_reason(store, student_id, key, item.source, item.confidence)
                )
                rejected.append(RefreshRejectOut(key=key, reason=reason))
        view = _tags_view(store, student_id)
        logger.info(
            "概括结果已应用：学生=%s 写入=%d 拒绝=%d 缘由=%s",
            student_id,
            len(applied),
            len(rejected),
            body.reason or "-",
        )
        return RefreshApplyOut(
            applied=applied,
            rejected=rejected,
            tags=view.tags,
            parent_consent=view.parent_consent,
            memory_switch=view.memory_switch,
            dimension_labels=view.dimension_labels,
        )
    except sqlite3.Error as exc:
        logger.exception("概括结果应用失败：%s", student_id)
        raise HTTPException(
            status_code=503, detail=f"概括结果应用失败（本地数据库异常）：{exc}"
        ) from exc
    finally:
        store.close()


def _refresh_reject_reason(detail: str) -> str:
    """把存储层 ValueError 的**详情**折成**封闭短标签**（供回执/前端展示）。

    ★ 为什么要有这个折叠：`ValueError` 的文案是给人看的**句子**（含取值域、收到的值），
      直接回给客户端既不稳定（文案一改契约就变）也不安全（可能回显非法输入）。
      回执里只放**封闭词表**里的短标签，真正的细节走日志。

    ★★ 判据必须**与 learning.py 抛错时的措辞一一对应**、且互不重叠：
      · G-H-10 那条含「禁做 #10」（唯一标识）—— 先判，否则会被 "inferred" 泛匹配吃掉；
      · 取值域四条分别含「emotion」「intensity」「learner_style」「personality」
        （后两个是 2026-09-30 维度 13 新增的封闭词表键）；
      · 白名单那条含「白名单」（G-A）。
    兜底 'rejected' 是**故意留的**：宁可回一个笼统标签，也不让一条没见过的错把端点打成 500。
    """
    if "禁做 #10" in detail:
        return "inferred-not-allowed"
    if "白名单" in detail:
        return "whitelist"
    if (
        "emotion" in detail
        or "intensity" in detail
        or "learner_style" in detail
        or "personality" in detail
    ):
        return "value-out-of-range"
    return "rejected"


def _refresh_skip_reason(
    store, student_id: str, key: str, source: str, confidence: float | None
) -> str:
    """分档拒绝时，回一个封闭短标签（诊断用；真正的原因在存储层日志里）。

    ★ 时序注意：这里读的是**写入尝试之后**的现状。分档拒绝时值没被改动，
      所以读到的仍是「挡住它的那条」的来源/置信度 —— 判据与
      `upsert_tag_from_summary` 的内部分档一一对应。
    """
    current_source = store.tag_source_of(student_id, key)
    if current_source == "declared":
        return "declared-protected"
    if current_source == "observed" and source == "inferred":
        return "observed-wins"
    if current_source == "inferred" and source == "inferred":
        return "confidence-not-higher"
    # 兜底：值没变（upsert_tag 内部虽仍返回 True，但理论上也可能走到这里）
    return "skipped"


@router.get(
    "/profile/{student_id}/identity",
    response_model=IdentityOut,
    summary="本地身份 + 两道闸（真名不出网）",
)
def read_identity(request: Request, student_id: str) -> IdentityOut:
    """读本地身份行与两道闸。

    ★ 本端点是**本地身份唯一的读出口**，而它的字段里没有 school / class / real_grade ——
      精确年级、学校、班级连出参形状都不存在（G-B 的第二种形态）。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)
    store = open_learning_store(data_dir, student_id)
    try:
        return _identity_out(store, student_id)
    except sqlite3.Error as exc:
        logger.exception("读取本地身份失败：%s", student_id)
        raise HTTPException(
            status_code=503, detail=f"读取本地身份失败（本地数据库异常）：{exc}"
        ) from exc
    finally:
        store.close()


@router.get(
    "/profile/{student_id}/timeline",
    response_model=ProfileTimeline,
    summary="画像变化时间线（学段变更 / 标签变更 / 入门问答）",
)
def read_profile_timeline(
    request: Request,
    student_id: str,
    limit: int = Query(
        TIMELINE_DEFAULT_LIMIT,
        ge=1,
        le=TIMELINE_MAX_LIMIT,
        description="最多返回几条（新的在前）",
    ),
) -> ProfileTimeline:
    """画像**怎么变成现在这样的**（§5.2 #11）。

    ★★ 这个端点回答的是一个此前**无法回答**的问题：profile_tags 的主键是
      (anon_student_id, key)，它只存**当前值** —— 没有历史就回答不了「变化过程」。
      迁移 v6 新增的 profile_tag_history 就是为它准备的时间序列。

    ★ 三类事件各自对应一处真实存在的序列，**不从别处推断时间**：
      学段变更（grade_history）、标签变更（profile_tag_history）、入门问答（onboarding_qa）。

    ★ 三道闸与画像其它出口完全一致：
      · parent_consent=0 → events 空（G-G）；
      · 只按单个 student_id 取数，**不跨学生**（禁做 #9）；
      · 短期情绪标签两处都被挡住（写入侧不记 + 读取侧再滤，禁做 #11）。

    - 学生不存在 → 空时间线（**不是 404**：新学生本来就没有变化，那是正常态）；
    - limit 越界 → 422；库异常 → 503。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)
    store = open_learning_store(data_dir, student_id)
    try:
        return ProfileTimeline(
            student_id=student_id,
            events=_timeline_events(store, student_id, limit=limit),
        )
    except sqlite3.Error as exc:
        logger.exception("读取画像时间线失败：%s", student_id)
        raise HTTPException(
            status_code=503, detail=f"读取画像时间线失败（本地数据库异常）：{exc}"
        ) from exc
    finally:
        store.close()


@router.put(
    "/profile/{student_id}/identity/flags",
    response_model=IdentityOut,
    summary="设置家长同意 / 记忆开关",
)
def update_identity_flags(
    request: Request, student_id: str, body: IdentityFlagsRequest
) -> IdentityOut:
    """写两道闸（设置页开关）+ 可选落盘一次称呼。

    - parentConsent=false → 以后 GET /tags 与推荐依据一律为空（G-G）；
    - memorySwitch=false → 以后**不写任何标签**（G-F）。
      ★ 只影响**往后写**：已经写下的标签仍在库里（学生没说「忘掉」），
        要抹掉由 DELETE 逐个撤销 —— 两个动作分开，别把开关做成静默清库。
    - realName（可选）→ 写 `identity_local.real_name`（本地身份数据，永不进 prompt）。

      ★★ 为什么称呼走这里（集成期修的功能死洞）：引导 Q5 问「我该怎么称呼你」，
        主进程把答案脱敏后需要一条落盘路径。此前**没有**这条路径，
        于是 `GET /identity` 恒回空 realName，渲染层永远把 `{{student_name}}`
        替换成「同学」—— **占位机制静默失效**（模型被要求用占位符，却永远替换不出真名）。
      ⚠️ 写称呼**不看** memorySwitch：不记画像 ≠ 忘掉称呼（见 store 的 set_real_name）。
      ⚠️ 再过一次 safe_display_name：**入库的是脱敏后的称呼，不是学生原话**
        （「XX 小学二班」这类不会进 identity_local —— 那是「学生没同意识别的信息」）。
    """
    validate_student_id(student_id)
    data_dir = _require_data_dir(request)
    store = open_learning_store(data_dir, student_id)
    try:
        try:
            store.set_identity_flags(
                student_id,
                parent_consent=body.parent_consent,
                memory_switch=body.memory_switch,
            )
            if body.real_name is not None:
                # ★ 入库存**安全值**：safe_display_name 命中可疑形态就回落「同学」，
                #   所以库里的 real_name 恒等于一个可安全展示的称呼；回落值存空串，
                #   读取端把空串统一折算回回落值（只有一种「空」）。
                safe = safe_display_name(body.real_name)
                # ★★ 库里只存**安全值**；回落值存空串（读取端把空串统一折算回回落值）。
                stored = "" if safe == STUDENT_FALLBACK_NAME else safe
                store.set_real_name(student_id, stored)
                # ★★ 称呼与昵称**在源头同步**（2026-10-04 用户报障：「画像部分为什么切账号
                #   以后 画像部分的名字什么没有更新 你是不是忘记做联动机制了」）。
                #   查出来**不是没联动**，是库里同一个人有两个名字：
                #     student.nickname         ← 账号列表 / 侧栏身份卡 读它
                #     identity_local.real_name ← GET /identity 的 displayName，画像/问候语 读它
                #   两者此前没有任何同步 ⇒ 侧栏「同学」、右栏真名，看着就是"没联动"。
                #   ⚠️ 只在**真的设了称呼**时同步（stored 非空）：学生把称呼清空 / 回落到
                #      「同学」时**不覆盖**昵称 —— 那是他在账号菜单里自己起的名字，不该被抹掉。
                #   ⚠️ 用单列 UPDATE（store.set_nickname），**不用** upsert_student：后者是
                #      整行 upsert，会把 grade_level 按调用方手里的值写回（这里根本没有学段
                #      快照），正是 touch_last_active 那条注释记过的故障形态。
                if stored != "":
                    store.set_nickname(student_id, stored)
        except sqlite3.Error as exc:
            logger.exception("身份闸写入失败：%s", student_id)
            raise HTTPException(
                status_code=503, detail=f"身份闸写入失败（本地数据库异常）：{exc}"
            ) from exc
        logger.info(
            "身份闸已更新：学生=%s parent_consent=%s memory_switch=%s",
            student_id,
            body.parent_consent,
            body.memory_switch,
        )
        return _identity_out(store, student_id)
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
    "OpeningGuidance",
    "RECOMMEND_LIMIT",
    "REVIEW_MASTERY_CEILING",
    "RecommendationItem",
    "RecommendationResponse",
    "build_recommendation",
    "read_chapter",
    "router",
    "student_opening",
    "update_preference",
    "write_chapter",
]
