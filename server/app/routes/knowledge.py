# -*- coding: utf-8 -*-
"""教材章节查询（``/api/knowledge/*``）—— 学习档案里的「章节进度」与学习路径的原料。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | ``/api/knowledge/chapters/{grade_level}`` | 列出某学段的全部章节（可选带学生进度） |

## 为什么这个接口以前不存在

章节数据**早就有了**：知识点文件的 front-matter 里就有 ``chapter_title``
（``app/knowledge/library.py`` 的 ``REQUIRED_META``），入库时写进 ``kb.sqlite`` 的 ``kp`` 表，
分块、citation 五字段、前端展示都已在用它。缺的只是「**按学段把章节列出来**」这一个查询
—— 直到本文件为止，``app/store/kb.py`` 里没有任何一处 ``GROUP BY chapter_title``。

## 一处容易搞混的地方

章节**清单**来自 ``kb.sqlite``（随包分发的只读内容资产），学生的**进度**来自该生自己的
``learning.db``（``progress`` 表）。本文件是唯一把两者**并到一起**的地方：清单是主，
进度只用来给每章补一个计数。**不要把清单也存进 ``learning.db``** —— 那会让教材内容
在每个学生的库里各存一份，改教材时到处对不上。

## 单元

``progress.kp_id`` 与 ``kp.kp_id`` 是**同一命名空间**（都是 kb 的知识点 id），
所以这里可以按 kp_id 直接对齐，不需要任何映射表。

> ⚠️ 路由挂载：本 router 需要在 ``app/main.py`` 里 ``include_router``。
> **注册后必须重跑** ``uv run python scripts/export_openapi.py`` 与
> ``cd desktop && npm run gen:api``，否则 ``test_committed_artifact_matches_contracts``
> 与 ``npm run check:api`` 会红。
"""

from __future__ import annotations

import logging
import sqlite3

from fastapi import APIRouter, HTTPException, Query, Request

from app.contracts import ChapterInfo, ChapterListResponse, GradeLevel
from app.routes.graph import open_kb_readonly
from app.routes.students import (
    as_grade_level,
    open_learning_store,
    require_data_dir,
    validate_student_id,
)
from app.store import kb as kb_repo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["knowledge"])

#: 允许的学段（与契约 ``GradeLevel`` 逐字一致）。
#: ★ 显式判一次：FastAPI 的**路径**参数不会自动按 Literal 校验（它只认 ``str``），
#:   而拼错学段名应当 422 —— 不是回一个空清单假装「这个学段没编教材」。
GRADE_LEVELS: tuple[str, ...] = ("primary_low", "primary_high", "junior", "senior")


@router.get(
    "/knowledge/chapters/{grade_level}",
    response_model=ChapterListResponse,
    summary="列出某学段的全部章节（可选带该学生的掌握进度）",
)
def list_chapters(
    request: Request,
    grade_level: str,
    student_id: str | None = Query(
        None,
        description="带上就补每章的已掌握数（读该学生的 learning.db）；不带给纯教材清单",
    ),
    studentId: str | None = Query(None, include_in_schema=False),
) -> ChapterListResponse:
    """按学段列出章节，顺序**就是教材顺序**（见 ``kb.chapters_by_grade`` 的排序注释）。

    - 学段名非法 → **422**（不回空清单：空清单看起来像「这个学段没编教材」）；
    - 知识库缺失 → **503**（可读中文：先跑 ``scripts/build_kb.py``）；
    - 带 ``student_id`` 但该生还没有进度行 → 计数为 0，**不报错**（新学生是正常状态）。
    """
    if grade_level not in GRADE_LEVELS:
        raise HTTPException(
            status_code=422,
            detail=f"学段非法：{grade_level!r}（允许：{'/'.join(GRADE_LEVELS)}）",
        )
    level: GradeLevel = as_grade_level(grade_level)

    sid = student_id or studentId
    if sid:
        # 学生 id 会被拼进文件系统路径，必须在**入口**校验（与其他路由同一口径）
        validate_student_id(sid)

    conn = open_kb_readonly(request)
    try:
        rows = kb_repo.chapters_by_grade(conn, level)
    except sqlite3.Error as exc:
        logger.exception("章节查询失败：%s", level)
        raise HTTPException(status_code=503, detail=f"读取教材章节失败（知识库异常）：{exc}") from exc
    finally:
        conn.close()

    # 学生进度：只在带了 student_id 时读（**另开一个库**，与 kb 无关）
    mastered: set[str] = set()
    if sid:
        mastered = _mastered_kp_ids(request, sid)

    chapters = [
        ChapterInfo(
            chapter_title=str(row["chapter_title"]),
            kp_count=len(row["kp_ids"]),  # type: ignore[arg-type]
            kp_ids=list(row["kp_ids"]),  # type: ignore[arg-type]
            mastered_count=sum(1 for kp in row["kp_ids"] if kp in mastered),  # type: ignore[union-attr]
        )
        for row in rows
    ]
    return ChapterListResponse(
        grade_level=level,
        chapters=chapters,
        with_progress=bool(sid),
    )


def _mastered_kp_ids(request: Request, student_id: str) -> set[str]:
    """该学生 ``progress.stage == "mastered"`` 的知识点集合。

    ★ 用 ``progress`` 而不是 ``mastery.score`` 判「已掌握」：闯关阶段才是
      「这一关过了吗」的权威（``quiz.py`` 的 ``apply_level_progress`` 维护它），
      而 ``mastery`` 是连续的分数，用阈值判会在 0.6 附近来回跳。
    ★ 读失败**不抛**：章节清单本身来自只读的 kb.sqlite，进度只是装饰 ——
      为了一个装饰把整页打空不值得（与画像预取的降级口径一致）。
    """
    store = open_learning_store(require_data_dir(request), student_id)
    try:
        return {record.kp_id for record in store.progress_rows() if record.stage == "mastered"}
    except sqlite3.Error as exc:
        logger.warning("读章节进度失败（按 0 掌握处理）：%s（%s）", student_id, exc)
        return set()
    finally:
        store.close()


__all__ = ["GRADE_LEVELS", "list_chapters", "router"]
