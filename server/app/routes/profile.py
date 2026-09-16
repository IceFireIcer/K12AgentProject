"""``GET /api/profile/{student_id}`` 与 ``POST /api/profile/{student_id}/events``（§6.3，票 09）。

两条路径对应学习闭环的两端：

- **读**（``GET``）：画像 + 掌握度 + 偏好，供 Pi 的 ``get_student_profile`` Tool 注入 Prompt；
- **写**（``POST .../events``）：从对话里提取出来的**结构化学习记录**回流到 ``learning.db``
  （``learning-log`` Extension → ``bridge/client.ts`` → 这里）。``activity`` 覆盖
  ``qa | animation | coding | quiz`` 四类。

★★ 合规红线（§8.1 / §12）：**SQLite 不存对话正文**。
   本模块只接受「活动类型 + 知识点 id + 对错 + 一句固定口径的说明 + 时间戳」；
   学生原话、模型回答、代码片段一律不入库 —— 对话正文归 Pi 的 JSONL 会话树，
   两者靠 ``studentId`` + ``sessionId`` 关联。契约上的两道闸门：
   ① ``CamelModel`` 的 ``extra="forbid"``：多带一个 ``question`` / ``text`` 字段直接 422；
   ② ``detail`` 限长 200 字并压成单行（它是一条**说明**，不是正文的容器）。

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

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field, field_validator

from app.contracts import (
    CamelModel,
    GradeLevel,
    LearningActivity,
    Mastery,
    Student,
    StudentProfile,
)
from app.routes.students import (
    DEFAULT_COLD_START_GRADE,
    as_grade_level,
    open_learning_store,
    resolve_student_data_root,
    to_contract_ms,
    validate_student_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["profile"])

#: ``detail`` 的长度上限：它是**说明**，不是对话正文的容器（合规口径见模块头）。
DETAIL_MAX_CHARS = 200

#: 知识点 id 的长度上限（与桌面端 `learning-log.ts` 的 `SAFE_KP_ID` 同量级）。
KP_ID_MAX_CHARS = 64


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
    """学习记录写入的回执（§6.3：``{ok}``）。"""

    ok: bool = True


def _read_student(store, student_id: str) -> Student | None:
    """从该学生的 ``learning.db`` 读学生行（秒 → 毫秒的换算只在 ``to_contract_ms`` 里做）。"""
    record = store.get_student(student_id)
    if record is None:
        return None
    return Student(
        student_id=record.student_id,
        nickname=record.nickname,
        grade_level=as_grade_level(record.grade_level),
        created_at=to_contract_ms(record.created_at),
        last_active_at=to_contract_ms(record.last_active_at),
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
    """读某学生的画像：基本身份 + 掌握度 + 偏好（+ 依赖图推荐，票 20 填充）。

    - 学生不存在 → **404**（空画像会让学生以为「我没学过任何东西」，两者必须区分）；
    - ``studentId`` 非法 → **422**（它会被拼进文件系统路径）；
    - 库读写失败 → **503**（可读中文；上层 Tool 会把它转成 `error` 事件而不是崩）。
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
            pref_rows = store.conn.execute("SELECT key, value FROM profile_pref").fetchall()
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
        preferences = {str(row["key"]): str(row["value"] or "") for row in pref_rows}

        return StudentProfile(
            student=student,
            mastery=mastery,
            preferences=preferences,
            # ★ 推荐路径必须来自依赖图 + 掌握度（§8.6 用途一），属票 20；
            #   这里**宁可留空也不猜**：随便给一个 kp_id 会变成「推荐了不该推荐的东西」。
            recommended_kp_ids=[],
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


def _require_data_dir(request: Request) -> str:
    """取学生数据根；缺失时给**可读**的 503（而不是在别处抛 KeyError）。

    ★ 只认**显式传入**的 ``--data-dir``：没传时 ``app.config`` 的兜底值（``server/_data``）是
    共享目录，拿它当学生数据根会让不同来源的数据混进同一棵树
    （理由与 `resolve_student_data_root` 的注释一致）。
    """
    data_root = resolve_student_data_root(request)
    if data_root is None:
        raise HTTPException(
            status_code=503,
            detail="sidecar 未配置 data-dir：无法定位学生数据目录（应由 Electron 经 --data-dir 传入 <userData>）",
        )
    return str(data_root)


__all__ = [
    "DETAIL_MAX_CHARS",
    "LearningEventAck",
    "LearningEventRequest",
    "router",
]
