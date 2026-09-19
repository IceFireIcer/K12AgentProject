"""教材知识库（``/api/knowledge/*``）—— 章节进度、知识点清单、体检数字、导入与重建。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | ``/api/knowledge/chapters/{grade_level}`` | 列出某学段的全部章节（可选带学生进度） |
| GET | ``/api/knowledge/points`` | 知识点清单（教材知识库页的表格；可按学段过滤） |
| GET | ``/api/knowledge/stats`` | 知识库体检数字（统计卡 / 版本信息 / 向量可用性） |
| POST | ``/api/knowledge/import`` | 导入一份教材 Markdown（校验 → 落盘 → 重建） |
| POST | ``/api/knowledge/rebuild`` | 重建索引（分块 + 嵌入 + FTS + 依赖图） |

## 为什么最初只有「章节」这一个接口

章节数据**早就有了**：知识点文件的 front-matter 里就有 ``chapter_title``
（``app/knowledge/library.py`` 的 ``REQUIRED_META``），入库时写进 ``kb.sqlite`` 的 ``kp`` 表，
分块、citation 五字段、前端展示都已在用它。缺的只是「**按学段把章节列出来**」这一个查询
—— 直到本文件为止，``app/store/kb.py`` 里没有任何一处 ``GROUP BY chapter_title``。

后面的四个接口是**同一个缺口的另外四面**：章节是「按章看」，知识点清单是「按点看」，
stats 是「这份库到底有多少东西」，导入/重建是「**能不能换一份教材**」。
前三个都只是读，第四个是本项目里**唯一会写 kb 的地方**。

## 一处容易搞混的地方

章节/知识点**清单**来自 ``kb.sqlite``（随包分发的只读内容资产），学生的**进度**来自该生自己的
``learning.db``（``progress`` 表）。本文件是唯一把两者**并到一起**的地方：清单是主，
进度只用来给每章补一个计数。**不要把清单也存进 ``learning.db``** —— 那会让教材内容
在每个学生的库里各存一份，改教材时到处对不上。

## 单元

``progress.kp_id`` 与 ``kp.kp_id`` 是**同一命名空间**（都是 kb 的知识点 id），
所以这里可以按 kp_id 直接对齐，不需要任何映射表。

## ★ 唯一会写 kb 的地方：导入 / 重建

``kb.sqlite`` 的默认解析顺序是「随包只读库优先于用户库」（见
``app/rag/retriever.py`` 的 ``default_kb_path``），理由是升级后不该被旧库遮蔽。
但重建必须写到**用户可写的那一份**，否则打包态下「重建成功但检索到的还是老教材」。

处置：重建成功后写一个**标记文件**（``user_rebuild_marker_path``），解析顺序据此
把用户库提到最前。标记是文件存在性，不需要额外的清理入口 —— 删掉它就退回随包库。

⚠️ **重建是同步重活**（分块 + ONNX 嵌入整份教材）：必须放进线程池跑
（FastAPI 的 ``run_in_threadpool``），否则会阻塞事件循环、把整台 sidecar 卡住。

> ⚠️ 路由挂载：本 router 需要在 ``app/main.py`` 里 ``include_router``。
> **注册后必须重跑** ``uv run python scripts/export_openapi.py`` 与
> ``cd desktop && npm run gen:api``，否则 ``test_committed_artifact_matches_contracts``
> 与 ``npm run check:api`` 会红。
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
import sys
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from app.config import EMBEDDING_DIM, EMBEDDING_MODEL_ID, KNOWLEDGE_DIR, resolve_data_dir
from app.contracts import (
    ChapterInfo,
    ChapterListResponse,
    GradeLevel,
    KnowledgeImportRequest,
    KnowledgeImportResponse,
    KnowledgePointItem,
    KnowledgePointListResponse,
    KnowledgeStats,
    KnowledgeRebuildResponse,
)
from app.knowledge import checker
from app.knowledge.library import (
    GRADE_DIRS,
    KnowledgeFormatError,
    load_terminology,
    parse_document,
)
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

#: 用户导入的教材落点（`<data-dir>/knowledge-user/`）。
#:
#: ★ 为什么不写进随包的 ``server/knowledge/``：打包态那是安装目录，普通用户写不了
#:   （即便写得动也不许 —— 安装目录里的资产是被校验过的只读内容）。
#: ★ 导入的内容按**学段子目录**落盘（``junior/xxx.md``），与 bundled 教材同一套目录约定，
#:   这样建库脚本可以原样复用（``GRADE_DIRS`` 那套映射不需要第二份）。
USER_KNOWLEDGE_DIR_NAME = "knowledge-user"


def user_knowledge_dir(data_dir: str | Path | None = None) -> Path:
    """用户导入教材的根目录（``<data-dir>/knowledge-user/``，按学段分子目录）。"""
    base = Path(data_dir) if data_dir else resolve_data_dir(None)
    return base / USER_KNOWLEDGE_DIR_NAME


def request_data_dir(request: Request) -> Path:
    """取本次请求的 ``<data-dir>``，**并保证类型是 ``Path``**。

    ★★ 为什么这一层转换是必须的（实测踩到，别把 ``Path()`` 去掉）：
      ``RuntimeConfig.data_dir`` 声明为 ``Path``，但它的值来自 Electron 的
      ``--data-dir <userData>``命令行参数 —— 直接 ``RuntimeConfig(data_dir="…")``
      构造时拿到的是 **``str``**。``str`` 往下走不会立刻炸：
      ``per_user_kb_path()`` / ``user_rebuild_marker_path()`` / ``default_kb_path()``
      内部都 ``Path(base)`` 一次，所以「纯重建」（没有用户导入内容）**看起来是好的**；
      唯一真的做 ``Path`` 运算的是 ``_rebuild_source_dir()`` 的
      ``data_dir / 'shared' / 'knowledge-staging'`` —— 于是带用户导入内容的
      「导入 + 重建」才抛 ``TypeError: unsupported operand type(s) for /``。
      症状与根因隔了三层调用，所以**在进入本模块时统一转一次**，而不是在下游各补一次。
    """
    config = getattr(request.app.state, "config", None)
    raw = getattr(config, "data_dir", None) if config is not None else None
    return Path(raw) if raw else resolve_data_dir(None)


# --------------------------------------------------------------------------- #
# 读：章节（既有）
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# 读：知识点清单
# --------------------------------------------------------------------------- #
@router.get(
    "/knowledge/points",
    response_model=KnowledgePointListResponse,
    summary="知识点清单（教材知识库页的表格；可按学段过滤）",
)
def list_points(
    request: Request,
    grade_level: str | None = Query(
        None, description="按学段过滤；不带给全部四个学段"
    ),
    gradeLevel: str | None = Query(None, include_in_schema=False),
) -> KnowledgePointListResponse:
    """列出知识点（每个点一行：学段 / 章节 / 类型 / chunk 数 / 是否有向量）。

    - 学段名非法 → **422**（与 ``list_chapters`` 同口径：不回空表假装没编教材）；
    - 知识库缺失 → **503**。
    """
    raw_level = grade_level or gradeLevel
    level: GradeLevel | None = None
    if raw_level is not None:
        if raw_level not in GRADE_LEVELS:
            raise HTTPException(
                status_code=422,
                detail=f"学段非法：{raw_level!r}（允许：{'/'.join(GRADE_LEVELS)}）",
            )
        level = as_grade_level(raw_level)

    conn = open_kb_readonly(request)
    try:
        points = _points_from_kb(conn, level)
    except sqlite3.Error as exc:
        logger.exception("知识点清单查询失败：%s", level)
        raise HTTPException(status_code=503, detail=f"读取知识点清单失败（知识库异常）：{exc}") from exc
    finally:
        conn.close()

    return KnowledgePointListResponse(grade_level=level, points=points)


def _points_from_kb(conn: sqlite3.Connection, level: GradeLevel | None) -> list[KnowledgePointItem]:
    """从 ``kp`` + ``chunk`` 拼出知识点清单（按学段、再按库内行序 = 教材顺序）。

    ★ 顺序**必须按 kb 的行序**（教材定义序），不是字典序 —— 字典序会把
      「第 10 章」排在「第 2 章」前面（章节列表那边已经踩过这个坑）。
    ★ ``chunk_count`` / ``embedded`` 用一条 ``GROUP BY`` 一次查出来，
      不在循环里逐点查询（N 个知识点 = N 次查询这种写法在 33 个点上看不出问题，
      教材一多就会变成明显卡顿）。
    ★ ``chunk_count`` 的语义是**子块数**（``is_parent = 0``）：子块才是可检索单元
      （KNN / FTS 都只吃子块），父块只是命中后回填的上下文容器。把它算进去会让
      「这一行有多少东西可检索」这个数字虚高。
      ⚠️ 契约 ``KnowledgePointItem.chunk_count`` 的注释写作「父子块都算」，与这里**不一致**
      —— 以本实现为准（契约文件是冻结的，措辞待同步）；``TestPoints`` 里有一条断言钉住它。
    """
    counts: dict[str, tuple[int, int]] = {}
    rows = conn.execute(
        """
        SELECT knowledge_point AS kp_id,
               COUNT(*) AS chunk_count,
               SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded_count
        FROM chunk
        WHERE is_parent = 0 AND knowledge_point IS NOT NULL AND knowledge_point != ''
        GROUP BY knowledge_point
        """
    ).fetchall()
    for row in rows:
        counts[str(row["kp_id"])] = (int(row["chunk_count"]), int(row["embedded_count"]))

    sql = (
        "SELECT kp_id, name, grade_level, chapter_title FROM kp "
        "WHERE EXISTS (SELECT 1 FROM chunk c WHERE c.knowledge_point = kp.kp_id AND c.is_parent = 0)"
    )
    params: tuple[str, ...] = ()
    if level is not None:
        sql += " AND grade_level = ?"
        params = (level,)
    # ★ 按 rowid 排（教材定义序）；`kp` 无 rowid 列时的兜底在下面按 kp_id 稳定排序
    sql += " ORDER BY rowid"

    points: list[KnowledgePointItem] = []
    for row in conn.execute(sql, params).fetchall():
        kp_id = str(row["kp_id"])
        chunk_count, embedded_count = counts.get(kp_id, (0, 0))
        grade = str(row["grade_level"])
        if grade not in GRADE_LEVELS:
            # 学段认不出的行**不进清单**（检索隔离全按学段走，一个坏值会污染整页）
            continue
        points.append(
            KnowledgePointItem(
                kp_id=kp_id,
                name=str(row["name"] or kp_id),
                grade_level=as_grade_level(grade),
                chapter_title=str(row["chapter_title"] or ""),
                content_type=_content_type_of(conn, kp_id),
                chunk_count=chunk_count,
                embedded=embedded_count > 0,
            )
        )
    return points


def _content_type_of(conn: sqlite3.Connection, kp_id: str) -> str:
    """该知识点的内容类型（取它任一子块的 ``content_type``；取不到回空串）。

    ``kp`` 表里没有这一列（它建表时只留了 name/summary），而表格要显示「概念/原理/实践…」，
    所以从 chunk 反查。用 ``LIMIT 1``：同一知识点的分块类型一致（建库时来自同一份 front-matter）。
    """
    row = conn.execute(
        "SELECT content_type FROM chunk WHERE knowledge_point = ? AND content_type IS NOT NULL LIMIT 1",
        (kp_id,),
    ).fetchone()
    return str(row["content_type"]) if row is not None and row["content_type"] else ""


# --------------------------------------------------------------------------- #
# 读：体检数字
# --------------------------------------------------------------------------- #
@router.get(
    "/knowledge/stats",
    response_model=KnowledgeStats,
    summary="知识库体检数字（统计卡 / 版本信息 / 向量可用性）",
)
def knowledge_stats(request: Request) -> KnowledgeStats:
    """知识库规模与状态。

    - 知识库缺失 → **503**（与其它两个读接口同口径：这页本来就是来看库的，
      回一份全 0 的统计会让人以为「库是空的」，而实际是「库不在」）。
    """
    conn = open_kb_readonly(request)
    try:
        counts = kb_repo.stats(conn)
        levels = _levels_of_conn(conn)
        vec_ready = _vec_ready(conn, counts)
    except sqlite3.Error as exc:
        logger.exception("知识库体检失败")
        raise HTTPException(status_code=503, detail=f"读取知识库统计失败（知识库异常）：{exc}") from exc
    finally:
        conn.close()

    from app.rag.retriever import (
        default_kb_path,
        user_rebuild_marker_path,
    )

    data_dir = request_data_dir(request)
    kb_path = default_kb_path(data_dir)
    return KnowledgeStats(
        counts=counts,
        grade_levels=levels,
        kb_path=str(kb_path),
        user_rebuilt=user_rebuild_marker_path(data_dir).exists(),
        embedding_dim=EMBEDDING_DIM,
        embedding_model=EMBEDDING_MODEL_ID,
        vec_ready=bool(vec_ready),
    )


# --------------------------------------------------------------------------- #
# 写：导入教材
# --------------------------------------------------------------------------- #
@router.post(
    "/knowledge/import",
    response_model=KnowledgeImportResponse,
    summary="导入一份教材 Markdown（严格校验 → 落盘 → 可选重建）",
)
async def import_knowledge(
    request: Request,
    payload: KnowledgeImportRequest,
) -> KnowledgeImportResponse:
    """导入一份教材 Markdown。

    **校验只有一处**（``library.parse_document``）：格式、必需字段、``content_type`` 白名单、
    「文件名 = kp_id.md」，全都走建库时那一份实现 —— 若这里另写一份，
    迟早出现「导入时通过、建库时失败」这种最难查的不一致。

    之后再过 **学段错位自检**（``checker.audit_library``）：超纲术语 / 语气错位 / 跨学段搬运。
    它不通过时**拒收**并逐条回报原因 —— 把初中的语气搬到高中是最典型的静默质量事故。

    ★ 校验/审计失败回 **200 + ``ok=false``**（而不是 4xx）：失败原因是**内容问题**，
      界面要在同一张卡片里逐条列出它们，不是「请求本身非法」。
      这与「学段名拼错 → 422」是两回事（那是调用方写错了参数）。

    ★ 导入**不覆盖**同名文件以外的任何东西；重建是**整库重建**（``build()`` 先清表再写），
      所以导入后看到的是「随包教材 + 用户导入」的合并结果，而不是只剩导入的那一份。
    """
    # ★ 取 data_dir 只有 :func:`request_data_dir` 这一条路（它保证返回 ``Path``）。
    #   曾经写成 ``data_dir: Path = config.data_dir`` —— 类型标注不是转换，
    #   ``str`` 会一路透传到 ``_rebuild_source_dir()`` 才炸（见 ``request_data_dir`` 的说明）。
    data_dir = request_data_dir(request)

    # ── ① 解析 + 严格校验（与建库同一份实现）─────────────────────────────
    try:
        doc = parse_document(
            payload.markdown,
            file_name=payload.file_name,
            expected_grade=None,  # 导入没有「所在目录」可依，学段由文件头自己声明
        )
    except KnowledgeFormatError as exc:
        return KnowledgeImportResponse(ok=False, problems=[str(exc)], message='教材格式校验未通过。')

    # ── ② 学生指定的学段必须与文件头一致（防把初中内容挂到高中）───────────
    if payload.grade_level is not None and doc.grade_level != payload.grade_level:
        return KnowledgeImportResponse(
            ok=False,
            problems=[
                f'文件头 grade_level={doc.grade_level} 与所选学段 {payload.grade_level} 不一致'
                '（学段错位会让检索隔离完全错位）'
            ],
            message='教材学段与所选学段不一致。',
        )

    # ── ③ 学段错位自检（超纲术语 / 语气错位 / 跨学段搬运）─────────────────
    terminology = load_terminology(KNOWLEDGE_DIR)
    # 与已在库里的随包教材一起审计：跨学段搬运只有放在一起比才看得出来
    try:
        from app.knowledge.library import load_library

        existing = load_library(KNOWLEDGE_DIR)
    except KnowledgeFormatError:
        existing = []
    audit = checker.audit_library([*existing, doc], terminology)
    # 只报**与这份文档相关**的违规（随包教材自己的问题不该拦住学生导入）
    own = [v for v in audit.violations if v.kp_id == doc.kp_id]
    if own:
        return KnowledgeImportResponse(
            ok=False,
            problems=[f'[{v.kind}] {v.detail}' for v in own],
            message=f'教材学段自检未通过（{len(own)} 处），已拒绝导入。',
        )

    # ── ④ 落盘（按学段子目录，与 bundled 教材同一套目录约定）──────────────
    target_dir = user_knowledge_dir(data_dir) / _grade_dir_name(doc.grade_level)
    target = target_dir / f'{doc.kp_id}.md'
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(payload.markdown.lstrip('\ufeff'), encoding='utf-8')
    except OSError as exc:
        logger.exception('教材导入落盘失败：%s', target)
        raise HTTPException(status_code=503, detail=f'教材落盘失败：{exc}') from exc

    rel = f'{USER_KNOWLEDGE_DIR_NAME}/{_grade_dir_name(doc.grade_level)}/{doc.kp_id}.md'

    # ── ⑤ 重建（不重建的话这份内容检索不到，等于没导入）───────────────────
    if not payload.rebuild:
        return KnowledgeImportResponse(
            ok=True,
            kp_id=doc.kp_id,
            saved_as=rel,
            message='已保存；未重建索引（这份内容要重建后才能被检索到）。',
        )

    rebuilt = await _run_rebuild(request)
    if not rebuilt.ok:
        return KnowledgeImportResponse(
            ok=True,
            kp_id=doc.kp_id,
            saved_as=rel,
            message=f'已保存，但重建失败：{rebuilt.message}',
        )
    return KnowledgeImportResponse(
        ok=True,
        kp_id=doc.kp_id,
        saved_as=rel,
        stats=rebuilt.stats,
        message=f'已导入并重建（用时 {rebuilt.elapsed_ms / 1000:.1f}s）。',
    )


def _grade_dir_name(grade_level: str) -> str:
    """学段值（``junior``）→ 目录名（``junior`` / ``primary-low``）。

    ★ 反向映射只有这一处：``GRADE_DIRS`` 是「目录 → 学段」的正向表，
      反向表建错会让导入的教材落到 ``primary_low/`` 而建库脚本按 ``primary-low`` 找
      —— 结果是「导入成功但检索不到」，且没有任何报错。
    """
    for dirname, level in GRADE_DIRS.items():
        if level == grade_level:
            return dirname
    raise HTTPException(status_code=422, detail=f'学段非法：{grade_level!r}')


# --------------------------------------------------------------------------- #
# 写：重建索引
# --------------------------------------------------------------------------- #
@router.post(
    "/knowledge/rebuild",
    response_model=KnowledgeRebuildResponse,
    summary="重建索引（分块 + 嵌入 + FTS + 依赖图）",
)
async def rebuild_knowledge(request: Request) -> KnowledgeRebuildResponse:
    """重建整库索引（幂等：``build()`` 先清表再写）。

    - 嵌入模型缺失 → ``ok=false`` + 可读中文（**不是 500**）：界面有失败横幅要显示它；
    - 教材格式错 → 同样 ``ok=false`` + 原因；
    - 成功 → 写**标记文件**（让用户库优先于随包库）+ 清理依赖图缓存 + 回统计数字。

    ★ 重建是同步重活（分块 + ONNX 嵌入），跑在**线程池**里：直接 await 会阻塞事件循环，
      把整台 sidecar 卡住（连 ``/health`` 都不响应，Electron 会以为它挂了）。
    """
    return await _run_rebuild(request)


async def _run_rebuild(request: Request) -> KnowledgeRebuildResponse:
    """重建的**唯一实现**（导入与重建两个端点共用）。

    ★ 导入端点也要重建，两处各写一份必然漂移（一处忘了写标记文件，
      表现就是「导入成功但检索不到」）。所以逻辑只在这里。
    """
    # ★ 同样只走 request_data_dir()：这里曾经写 ``config.data_dir``（可能是 str），
    #   而 ``_rebuild_sync`` 是「原样透传」的那一环，坏值会在更下游才炸。
    return await run_in_threadpool(_rebuild_sync, request_data_dir(request))


def _rebuild_sync(data_dir: str | Path) -> KnowledgeRebuildResponse:
    """线程池里跑的重建本体（同步、可被单测直接调用）。

    ★ 入口处再 ``Path()`` 一次：本函数是「原样透传调用方给的 data_dir」的那一环，
      写死 ``Path`` 类型标注不等于运行时真的是 ``Path``（``str`` 一路透传到这里，
      会在 ``_rebuild_source_dir`` 里才炸）。线程池与单测都可能直接调它，
      所以这里做一次便宜的归一。
    """
    data_dir = Path(data_dir)
    # 延迟导入：`scripts/` 不是包（`server/scripts/build_kb.py` 靠 sys.path 直跑），
    # 所以这里显式把仓库根插进 sys.path 再按模块名导入 —— 与 build_kb.py 自己的做法一致。
    root = Path(__file__).resolve().parent.parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    try:
        from scripts.build_kb import BuildError, build
    except ImportError as exc:  # pragma: no cover - 只在打包漏带 scripts/ 时发生
        logger.exception('无法导入建库脚本')
        return KnowledgeRebuildResponse(
            ok=False,
            message=f'重建不可用：建库脚本未随应用分发（{exc}）。',
        )

    from app.knowledge.deps import invalidate_cache
    from app.rag.retriever import (
        default_kb_path,
        per_user_kb_path,
        user_rebuild_marker_path,
    )

    started = time.perf_counter()
    kb_path = per_user_kb_path(data_dir)
    try:
        # ★ 重建的目标**永远是用户可写的那一份**（随包库只读，不许写）
        result = build(
            _rebuild_source_dir(data_dir),
            kb_path,
            print_report=False,
            require_vectors=True,
            # ★ 导入的教材已经单独过过审计；整库重跑时若因**随包**教材的既有问题中止，
            #   学生会看到一个与自己的操作无关的失败。所以整库重建宽松一点：
            #   审计结论仍随 stats/message 带出，但不中止（导入那条路才是硬门槛）。
            strict_terms=False,
        )
    except BuildError as exc:
        logger.warning('重建前置条件不满足：%s', exc)
        return KnowledgeRebuildResponse(
            ok=False,
            elapsed_ms=(time.perf_counter() - started) * 1000,
            message=f'重建失败：{exc}',
        )
    except Exception as exc:  # noqa: BLE001 - 端点边界：任何异常都要变成一句可读中文
        logger.exception('重建失败')
        return KnowledgeRebuildResponse(
            ok=False,
            elapsed_ms=(time.perf_counter() - started) * 1000,
            message=f'重建失败（{type(exc).__name__}）：{exc}',
        )

    # ★ 标记文件：解析顺序据此把用户库提到随包库之前。**必须在 build 成功之后写** ——
    #   先写标记再失败的话，之后检索会指向一份根本没建起来的库。
    try:
        marker = user_rebuild_marker_path(data_dir)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(
            f'rebuilt_at={time.strftime("%Y-%m-%dT%H:%M:%S")}\nkb={kb_path.name}\n',
            encoding='utf-8',
        )
    except OSError as exc:
        # 标记写不了 = 重建结果**不会生效**（会被随包库遮蔽）→ 这是失败，不能报成功
        logger.exception('重建标记写入失败：%s', exc)
        return KnowledgeRebuildResponse(
            ok=False,
            stats=_stats_of(default_kb_path(data_dir)),
            elapsed_ms=(time.perf_counter() - started) * 1000,
            message=f'重建完成但标记写入失败，新库不会生效：{exc}',
        )

    invalidate_cache(kb_path)
    counts = result.stats
    return KnowledgeRebuildResponse(
        ok=True,
        stats=KnowledgeStats(
            counts=counts,
            grade_levels=_levels_of_kb(kb_path),
            kb_path=str(kb_path),
            user_rebuilt=True,
            embedding_dim=EMBEDDING_DIM,
            embedding_model=EMBEDDING_MODEL_ID,
            vec_ready=counts.get('chunk_vec', 0) > 0,
        ),
        elapsed_ms=result.elapsed_ms or (time.perf_counter() - started) * 1000,
        documents=result.docs,
        dependencies=result.edges,
        message=f'重建完成：知识点 {counts.get("kp", 0)} / 分块 {counts.get("chunk", 0)} / 用时 {result.elapsed_ms / 1000:.1f}s。',
    )


def _rebuild_source_dir(data_dir: str | Path) -> Path:
    """重建时的教材来源目录。

    ★ 导入的教材落在 ``<data-dir>/knowledge-user/<学段>/``，而随包教材在
      ``server/knowledge/<学段>/`` —— ``build()`` 只接受**一个**目录。
      这里不把两边真的合并成一个目录（那要复制文件、还要处理同名冲突），
      而是用一个**临时合成的目录**：符号链接/复制两边的内容到一个 staging 目录。
    ★ 没有导入内容时（绝大多数情况）**直接用随包目录**，不建 staging —— 少一次 IO，
      也避免在用户目录里留下一个看起来像「教材源」的空目录。

    ⚠️ 本函数是**唯一**真做 ``data_dir / …`` 运算的地方，所以 ``str`` 传进来必然在这里
      抛 ``TypeError``（Bug #1 的现场）。归一化见 :func:`request_data_dir` 与
      :func:`_rebuild_sync`；这里保留形参上的 ``str | Path`` 只是为了不让调用方踩到。
    """
    data_dir = Path(data_dir)
    user_dir = user_knowledge_dir(data_dir)
    if not _has_markdown(user_dir):
        return KNOWLEDGE_DIR

    staging = data_dir / 'shared' / 'knowledge-staging'
    if staging.exists():
        # 先清再建：上一次重建留下的旧文件（学生删掉的导入内容）不该继续参与
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    # 随包教材打底，用户导入**覆盖同名**（学生的显式导入优先）
    for dirname in GRADE_DIRS:
        src = KNOWLEDGE_DIR / dirname
        if src.is_dir():
            shutil.copytree(src, staging / dirname, dirs_exist_ok=True)
        usrc = user_dir / dirname
        if usrc.is_dir():
            shutil.copytree(usrc, staging / dirname, dirs_exist_ok=True)
    # manifest.json / terminology.json 也要带上（依赖图与审计都用它）
    for name in ('manifest.json', 'terminology.json'):
        src = KNOWLEDGE_DIR / name
        if src.is_file():
            shutil.copy2(src, staging / name)
    return staging


def _has_markdown(root: Path) -> bool:
    """该目录下（含学段子目录）是否有任何 ``.md``。"""
    if not root.is_dir():
        return False
    for dirname in GRADE_DIRS:
        sub = root / dirname
        if sub.is_dir() and any(sub.glob('*.md')):
            return True
    return False


def _levels_of_kb(kb_path: Path) -> list[GradeLevel]:
    """这份 kb 里实际有内容的学段（按学段顺序）。

    ★ 读的是**刚建好的那一份**（而不是复用列表里的 ``levels``）：
      重建回执要回答的是「新库里有哪些学段」，不是「重建前有哪些」。
      读不到就回空表 —— 重建已经成功了，这里不该再把它变成失败。
    """
    from app.store.connections import connect

    if not kb_path.exists():
        return []
    try:
        conn = connect(kb_path, readonly=True)
    except Exception:  # noqa: BLE001 - 装饰性字段，读不到不回空表
        return []
    try:
        return _levels_of_conn(conn)
    finally:
        conn.close()


def _levels_of_conn(conn: sqlite3.Connection) -> list[GradeLevel]:
    """``DISTINCT grade_level FROM kp`` → 学段清单（按学段顺序，认不出的丢掉）。"""
    try:
        rows = conn.execute('SELECT DISTINCT grade_level FROM kp').fetchall()
    except sqlite3.Error:
        return []
    found = {str(row[0]) for row in rows} & set(GRADE_LEVELS)
    return [level for level in GRADE_LEVELS if level in found]  # type: ignore[return-value]


def _stats_of(kb_path: Path) -> KnowledgeStats | None:
    """给失败回执补一份「当前生效的那份库」的统计（读不到就回 ``None``）。"""
    if not kb_path.exists():
        return None
    from app.store.connections import connect

    try:
        conn = connect(kb_path, readonly=True)
    except Exception:  # noqa: BLE001 - 只是装饰性回执，读不到就算了
        return None
    try:
        counts = kb_repo.stats(conn)
        return KnowledgeStats(
            counts=counts,
            grade_levels=_levels_of_conn(conn),
            kb_path=str(kb_path),
            embedding_dim=EMBEDDING_DIM,
            embedding_model=EMBEDDING_MODEL_ID,
            # ★ 与 :func:`knowledge_stats` 用**同一个**判据：只看 ``table_exists`` 会在
            #   「表建出来了但 sqlite-vec 加载不起来」时报假的 true（那正是 ``_vec_ready``
            #   被写出来的原因）。失败回执更不该给一个偏乐观的数字。
            vec_ready=_vec_ready(conn, counts),
        )
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def _vec_ready(conn: sqlite3.Connection, counts: dict[str, int]) -> bool:
    """向量检索是否**真的可用**，并顺手把 ``counts["chunk_vec"]`` 修正成真实行数。

    ★★ 为什么不能只看 ``kb_repo.stats()`` 的返回：
      那个函数对每个表单独 ``COUNT(*)`` 并**吞掉错误**（表不存在/扩展没加载都算 0）。
      ``chunk_vec`` 是 ``vec0`` 虚表 —— 不先加载 sqlite-vec 扩展，连
      ``SELECT COUNT(*) FROM chunk_vec`` 都会抛 ``no such module: vec0``，
      于是统计里恒为 0，界面上就会显示「向量引擎不可用」**而实际完全可用**
      （实测踩到：随包库有 185 条向量，stats 却报 0）。

    ★ 处置：在这个连接上试着加载扩展，成功则重数一遍。
      加载失败（扩展没进包 / SQLite 构建不支持）**不抛** —— 那就是真的降级，
      界面该显示「只能靠关键词检索」，而不是整页打不开。
    """
    from app.store.connections import load_sqlite_vec, vec_available

    if not kb_repo.table_exists(conn, "chunk_vec"):
        return False
    try:
        load_sqlite_vec(conn)
    except Exception as exc:  # noqa: BLE001 - 扩展不可用 = 诚实降级，不是接口故障
        logger.warning("读统计时加载 sqlite-vec 失败（向量检索将降级）：%s", exc)
        return False
    if not vec_available(conn):
        return False
    try:
        counts["chunk_vec"] = int(conn.execute("SELECT COUNT(*) FROM chunk_vec").fetchone()[0])
    except sqlite3.Error as exc:
        logger.warning("统计 chunk_vec 行数失败：%s", exc)
        return False
    return counts["chunk_vec"] > 0


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


__all__ = [
    "GRADE_LEVELS",
    "USER_KNOWLEDGE_DIR_NAME",
    "import_knowledge",
    "knowledge_stats",
    "list_chapters",
    "list_points",
    "rebuild_knowledge",
    "router",
    "user_knowledge_dir",
]
