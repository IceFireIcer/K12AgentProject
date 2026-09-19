# -*- coding: utf-8 -*-
"""学习档案的**聚合出口**（``/api/profile/*/report`` 与 ``/api/quiz/mistakes/*``）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | ``/api/profile/{student_id}/report``    | 学习报告（学生 / 家长）：周窗口活动量 + 掌握度 + 闯关 + 章节 + 学段轨迹 |
| GET | ``/api/quiz/mistakes/{student_id}``     | 错题本（按知识点聚合） |

## 为什么需要一个新文件而不是塞进 ``profile.py``

``profile.py`` 的职责是「画像 + 推荐 + 学习记录回流」（写入侧 + 依赖图推荐），
而这两个端点是**只读的聚合视图**：它们跨 ``learning.db`` 的**四张表** + ``kb.sqlite`` 的
章节清单，回答的是「这一周学得怎么样」「哪些地方错了」这类**报告式**问题。
放一起会让 ``profile.py`` 同时承担「推荐算法」与「报表聚合」两件事，
而这两件事的变化原因完全不同（推荐要调算法，报告要调口径）。

★ **没有第二份推荐实现**：本文件不碰推荐，报告里的「下一步」仍由前端调
  ``GET /api/profile/{id}/recommendation``（那是推荐的唯一出口）。

## 合规（两条红线，写在这里是因为本文件最容易踩）

1. **SQLite 不存对话正文**。这两个端点只读 ``learning_history`` 的**结构化列**；
   其中 ``question`` 是**题干前 120 字**（``routes/quiz.py`` 写入 ``stem[:120]``），
   **不是学生原话**（``routes/profile.py`` 的事件回流那一轨恒写空串）。
   报告与错题本因此都**没有**「学生的作答」这类字段 —— 数据本就不存在。
2. **答案绝不外流**。错题本**刻意不 join ``generated_question``**
   （那张表带 ``reference_answer``）：完整题干换不来什么，却会把一条带答案的表
   接进对外响应。详见 ``app/contracts.py`` 的 :class:`MistakeItem` 注释。

## 一人一库

每次请求现开现关该学生的 ``learning.db``（``app.routes.students.open_learning_store``），
**不跨学生复用连接**；表结构由 ``app/store/learning.py`` 的迁移器负责，本文件**不写任何 DDL**。

> ⚠️ 路由挂载：本 router 需要在 ``app/main.py`` 里 ``include_router``。
> **注册后必须重跑** ``uv run python scripts/export_openapi.py`` 与
> ``cd desktop && npm run gen:api``。
"""

from __future__ import annotations

import logging
import sqlite3
import time
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request

from app.contracts import (
    ChapterProgress,
    DailyActivity,
    GradeHistoryEntry,
    LearningReport,
    Mastery,
    MistakeItem,
    MistakeListResponse,
)
from app.routes.students import (
    as_grade_level,
    open_learning_store,
    require_data_dir,
    to_contract_ms,
    validate_student_id,
)
from app.store import kb as kb_repo
from app.store.learning import GradeHistoryRecord

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["study"])

#: 错题本单次返回的**知识点数**上限（不是错题条数：同一个知识点错十次仍算一条）。
#: 错题本是给学生看「我哪些地方还没搞明白」的，超过几十条就不再是清单而是噪音。
MISTAKE_LIMIT = 50

#: 报告的时间窗上限（防止有人传 ``days=100000`` 让聚合退化成全表扫）。
REPORT_MAX_DAYS = 90


def _tz_offset_seconds() -> int:
    """本机时区相对 UTC 的偏移（秒）。

    ★ 为什么需要它：SQLite 的 ``date(ts, 'unixepoch')`` 默认按 **UTC** 切天。
      在本机（UTC+8）晚上八点以后的活动，UTC 日期已经是第二天 ——
      报告里的「连续学习 N 天」会在跨零点学习时莫名断掉，而这是最常见的学习时段。
      这里取本机偏移交给 SQL 的修饰符（``store/learning.py`` 的 ``daily_activity``）。
    """
    # ``time.timezone`` 是 UTC 相对**本地**的偏移（东区为负），所以要取反。
    # 用 ``datetime.now() - utcnow()`` 更直观，但同时区下二者恒为朴素时间，
    # 靠 ``astimezone()`` 让解释器把本地规则（含夏令时）算进去。
    return int(-time.timezone)


# --------------------------------------------------------------------------- #
# 错题本
# --------------------------------------------------------------------------- #
@router.get(
    "/quiz/mistakes/{student_id}",
    response_model=MistakeListResponse,
    summary="错题本（按知识点聚合，含题干前 120 字）",
)
def list_mistakes(
    request: Request,
    student_id: str,
    limit: int = Query(MISTAKE_LIMIT, ge=1, le=200, description="返回的知识点数上限"),
) -> MistakeListResponse:
    """把 ``is_correct = 0`` 的学习记录按知识点聚合成错题。

    - 学生不存在 → **404**（没有学习记录与「从没错过」是两件事，前端要能分开显示）；
    - 学生 id 非法 → **422**；库读写失败 → **503**。

    ★ ``without_stem`` 显式告诉前端「还有几条错题没有题干记录」：
      QA / 编程轨答错时 ``question`` 是空串（那一轨不写题干），
      静默丢掉的话，学生会觉得「我明明错过它，这里怎么没有」。

    ★★ ``limit`` **只截断列表**，两个汇总（``total_wrong`` / ``without_stem``）**恒为全量**：
      它们回答的是「累计答错多少次」，与学生这次翻到第几条知识点无关。
      界面上「累计答错 N 次」与页脚「已计入上面的错次统计」都按全量口径写死 ——
      截断后求和会让错得多的学生看到一个**偏小且不再增长**的数字。
    """
    validate_student_id(student_id)
    data_dir = require_data_dir(request)

    store = open_learning_store(data_dir, student_id)
    try:
        student = store.get_student(student_id)
        if student is None:
            raise HTTPException(
                status_code=404,
                detail=f"还没有 {student_id} 的错题记录：该学生尚未建立学习记录",
            )
        try:
            # ★★ 汇总与列表**口径不同**，必须分两步取：
            #   ``total_wrong`` / ``without_stem`` 是「累计答错 N 次」，要的是**全量**和；
            #   而 ``limit`` 描述的是「列表回几条**知识点**」，不是「统计范围」。
            #   以前对着截断后的 ``records`` 求和 —— 学生错过的知识点一旦超过 ``limit``
            #   （默认 50，一个学段就有 57 个知识点、跨学段取题更多），界面上那个数字
            #   就永远不再增长，页脚「已计入上面的错次统计」也随之变成假话。
            #   ``store.mistakes`` 的 SQL 本就取全量、只在返回前切片，所以这里一次
            #   ``limit=None`` 拿全量，再自己切出给界面的列表（不是两次查询）。
            all_records = store.mistakes(limit=None)
        except sqlite3.Error as exc:
            logger.exception("错题聚合失败：%s", student_id)
            raise HTTPException(status_code=503, detail=f"读取错题失败（本地数据库异常）：{exc}") from exc
        # 列表仍然只回 ``limit`` 条；``max(1, ...)`` 与 ``store.mistakes`` 的边界口径一致
        # （路由上是 ``ge=1``，这条主要是给直接调用本函数的调用方兜底）。
        records = all_records[: max(1, limit)]
        total_wrong = sum(record.wrong_count for record in all_records)
        without_stem = sum(record.blank_count for record in all_records)
    finally:
        store.close()

    meta = _kp_meta(data_dir, [record.kp_id for record in records])
    items = [
        MistakeItem(
            kp_id=record.kp_id,
            kp_name=meta.get(record.kp_id, ("", ""))[0] or record.kp_id,
            chapter_title=meta.get(record.kp_id, ("", ""))[1],
            stem=record.stem,
            wrong_count=record.wrong_count,
            last_wrong_at=to_contract_ms(record.last_wrong_at),
            last_qid=record.last_qid,
        )
        for record in records
    ]
    return MistakeListResponse(
        student_id=student_id,
        grade_level=as_grade_level(student.grade_level),
        items=items,
        total_wrong=total_wrong,
        without_stem=without_stem,
    )


def _kp_meta(data_dir: str, kp_ids: list[str]) -> dict[str, tuple[str, str]]:
    """``kp_id → (名称, 章节名)``（读**只读的** ``kb.sqlite``，取不到就返回空表）。

    ★ 只取这两样：错题本要显示「循环（第 4 章）」。
      **不取** ``generated_question`` 里的完整题干 —— 那里带标准答案（见模块头合规第 2 条）。
    ★ 知识库缺失/损坏时返回空表：错题本身来自 ``learning.db``，**不该被 kb 的问题连坐**。
    """
    from app.rag.retriever import default_kb_path
    from app.store.connections import connect

    kb_path = default_kb_path(data_dir)
    if not kb_path.exists():
        return {}
    try:
        conn = connect(kb_path, readonly=True)
    except Exception:  # noqa: BLE001 - 见下面注释：任何 kb 读失败都只降级成「没有名字」
        return {}
    try:
        full = kb_repo.kp_meta(conn, kp_ids)
    except sqlite3.Error:
        return {}
    finally:
        conn.close()
    return {kp_id: (name, chapter) for kp_id, (name, chapter, _grade) in full.items()}


# --------------------------------------------------------------------------- #
# 学习报告
# --------------------------------------------------------------------------- #
@router.get(
    "/profile/{student_id}/report",
    response_model=LearningReport,
    summary="学习报告（周窗口活动量 + 掌握度 + 闯关 + 章节 + 学段轨迹）",
)
def learning_report(
    request: Request,
    student_id: str,
    days: int = Query(7, ge=1, le=REPORT_MAX_DAYS, description="时间窗天数（按本地日期切天）"),
) -> LearningReport:
    """「这一周学得怎么样」的**唯一出口**（学生与家长看的是同一份）。

    ★ 四张表在这里汇合：``mastery``（会什么）、``learning_history``（做了多少）、
      ``progress``（闯到哪关了）、``grade_history``（学段怎么变的）。
      此前它们各有零散出口，但没有一个「合起来看」的地方 ——
      而 ``grade_history`` 的表注释里本来就写着「家长报告」，这是补上那处设计意图。

    ★ **连续天数在服务端算**（``_streak_days``）：它跨「整段历史」而不是时间窗，
      前端拿到的是已经算好的结论；同时前端也拿到 ``daily`` 明细，可以自己铺满整周。

    - 学生不存在 → **404**；``days`` 越界 → **422**；库异常 → **503**。
    """
    validate_student_id(student_id)
    data_dir = require_data_dir(request)
    offset = _tz_offset_seconds()
    now = int(time.time())
    since = now - days * 86_400

    store = open_learning_store(data_dir, student_id)
    try:
        student = store.get_student(student_id)
        if student is None:
            raise HTTPException(
                status_code=404, detail=f"还没有 {student_id} 的报告：该学生尚未建立学习记录"
            )
        try:
            daily_rows = store.daily_activity(since=since, tz_offset_seconds=offset)
            activity_days = store.activity_days(tz_offset_seconds=offset)
            mastery_rows = store.conn.execute(
                "SELECT kp_id, score, attempts, correct, last_seen_at FROM mastery "
                "ORDER BY score DESC, kp_id"
            ).fetchall()
            # ★★ 丢掉**已删除知识点**的掌握度行（教材换代后的历史残留）。
            #    与 `routes/profile.py` 同一处口径：不过滤的话，
            #    「掌握度明细」会列出一堆当前教材里查不到中文名的知识点
            #    （界面只能退化成显示裸 kp_id），而「平均掌握度」也会被
            #    一批**已不存在的内容**拉低/拉高 —— 那是个假数字。
            #    ⚠️ kb 读不到时**不过滤**（保留旧行为）：不能让「库没打开」
            #       看起来像「这个学生没有学习记录」。
            try:
                from app.store import kb as kb_repo  # noqa: PLC0415
                from app.rag.retriever import default_kb_path  # noqa: PLC0415
                from app.store.connections import connect  # noqa: PLC0415

                kb_path = default_kb_path(request.app.state.config.data_dir)
                kb_conn = connect(kb_path, readonly=True)
                try:
                    live = kb_repo.all_kp_ids(kb_conn)
                finally:
                    kb_conn.close()
                # ⚠️ 只在**真的读到 kp** 时才过滤：空集会让「库没建好 / 表为空」
                #    伪装成「这个学生什么都没学」—— 那是比显示裸 id 更坏的错。
                if live:
                    mastery_rows = [row for row in mastery_rows if str(row["kp_id"]) in live]
            except Exception:  # noqa: BLE001 - 读不到 kb 就不过滤（见上）
                pass
            progress_rows = store.progress_rows()
            badges = store.badges()
            grade_rows = store.grade_history()
        except sqlite3.Error as exc:
            logger.exception("学习报告聚合失败：%s", student_id)
            raise HTTPException(status_code=503, detail=f"生成学习报告失败（本地数据库异常）：{exc}") from exc
    finally:
        store.close()

    today = _local_day(now, offset)
    stage_counts: dict[str, int] = {}
    for record in progress_rows:
        stage_counts[record.stage] = stage_counts.get(record.stage, 0) + 1

    mastered_ids = {record.kp_id for record in progress_rows if record.stage == "mastered"}
    quizzed_ids = {record.kp_id for record in progress_rows if record.stage == "quizzed"}
    chapters = _chapter_progress(
        data_dir, student.grade_level, mastered_ids, quizzed_ids
    )

    return LearningReport(
        student_id=student_id,
        nickname=student.nickname,
        grade_level=as_grade_level(student.grade_level),
        days=days,
        generated_at=to_contract_ms(now),
        daily=[
            DailyActivity(
                day=row.day,
                count=row.count,
                quiz_count=row.quiz_count,
                correct_count=row.correct_count,
            )
            for row in daily_rows
        ],
        total_activities=sum(row.count for row in daily_rows),
        quiz_total=sum(row.quiz_count for row in daily_rows),
        quiz_correct=sum(row.correct_count for row in daily_rows),
        streak_days=_streak_days(activity_days, today),
        today_studied=today in set(activity_days),
        mastery=[
            Mastery(
                kp_id=str(row["kp_id"]),
                score=float(row["score"] or 0.0),
                attempts=int(row["attempts"] or 0),
                correct=int(row["correct"] or 0),
                last_seen_at=to_contract_ms(row["last_seen_at"]) or None,
            )
            for row in mastery_rows
        ],
        chapters=chapters,
        stage_counts=dict(sorted(stage_counts.items())),
        badges=badges,
        grade_history=_grade_history_entries(grade_rows, to_contract_ms),
    )


def _chapter_progress(
    data_dir: str,
    grade_level: str,
    mastered_ids: set[str],
    quizzed_ids: set[str],
) -> list[ChapterProgress]:
    """按章节聚合闯关进度（章节清单来自 kb，进度来自 progress）。

    ★ 顺序 = 教材顺序（``kb.chapters_by_grade`` 保证）；kb 不可用时返回空列表
      —— 报告的主体（活动量 / 掌握度 / 轨迹）不依赖 kb，不该被知识库问题连坐。
    """
    from app.rag.retriever import default_kb_path
    from app.store.connections import connect

    kb_path = default_kb_path(data_dir)
    if not kb_path.exists():
        return []
    try:
        conn = connect(kb_path, readonly=True)
    except Exception:  # noqa: BLE001 - 见上：kb 读失败只降级
        return []
    try:
        rows = kb_repo.chapters_by_grade(conn, grade_level)
    except sqlite3.Error:
        return []
    finally:
        conn.close()

    out: list[ChapterProgress] = []
    for row in rows:
        kp_ids = list(row["kp_ids"])  # type: ignore[arg-type]
        out.append(
            ChapterProgress(
                chapter_title=str(row["chapter_title"]),
                kp_count=len(kp_ids),
                mastered_count=sum(1 for kp in kp_ids if kp in mastered_ids),
                quizzed_count=sum(1 for kp in kp_ids if kp in quizzed_ids),
            )
        )
    return out


def _local_day(ts_seconds: int, tz_offset_seconds: int) -> str:
    """Unix 秒 → **本地**日期串 ``YYYY-MM-DD``（与 ``daily_activity`` 的切天口径一致）。"""
    return (datetime.fromtimestamp(ts_seconds, tz=None) + timedelta(seconds=0)).strftime(
        "%Y-%m-%d"
    )


def _streak_days(activity_days: list[str], today: str) -> int:
    """连续学习天数（从今天往前数，允许「今天还没学」）。

    三条规则，缺一条就会给出学生看得出来的错数：

    1. **今天学了**就从今天起算；**今天还没学**则从最近一次学习那天起算 ——
       否则每天早上打开报告都会看到「连续 0 天」，把昨天刚建立的成就感清零。
    2. 只要**有一天没学**就断（不是「最近 N 天内有几天学过」）。
    3. 没有记录 → 0。
    """
    if not activity_days:
        return 0
    days = sorted(set(activity_days))
    try:
        parsed = [date.fromisoformat(day) for day in days]
    except ValueError:  # 极少数脏数据：宁可算 0 也不要抛 500
        return 0

    parsed.sort()
    last = parsed[-1]
    today_date = date.fromisoformat(today)
    # 允许「今天还没学」：从最后一次学习那天起算，但差距超过一天就不算连续
    if (today_date - last).days > 1:
        return 0

    streak = 1
    for index in range(len(parsed) - 1, 0, -1):
        if (parsed[index] - parsed[index - 1]).days == 1:
            streak += 1
        else:
            break
    return streak


def _grade_history_entries(rows: list[GradeHistoryRecord], to_ms) -> list[GradeHistoryEntry]:
    """``learning.db`` 的 ``grade_history`` 记录 → 契约条目（与 ``routes/grade.py`` 同一映射口径）。

    ★ 复用契约里的 :class:`GradeHistoryEntry`（而不是本文件再定义一个同形模型）：
      报告与 ``GET /api/grade/history`` 给出的是**同一份**轨迹数据，
      两处各定义一次的话，字段迟早分叉。
    ★ ``to_ms`` 由调用方传入（就是 ``students.to_contract_ms``）：库里存**秒**，
      契约用**毫秒**，换算只有一处实现。
    """
    return [
        GradeHistoryEntry(
            ts=to_ms(row.ts) or 0,
            turn=row.turn,
            from_level=as_grade_level(row.from_level) if row.from_level else None,
            to_level=as_grade_level(row.to_level),
            source=row.source,
            confidence=row.confidence,
        )
        for row in rows
    ]


__all__ = ["MISTAKE_LIMIT", "REPORT_MAX_DAYS", "router"]
