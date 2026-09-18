"""``GET /api/graph/*`` —— 知识点依赖图查询（**双用途**）。

- ``GET /api/graph/deps/{kp_id}``：某个知识点的邻域
  - ``direction=successor``（默认）：**推荐路径** —— 学完这个知识点之后可以学什么；
  - ``direction=prerequisite``：**检索扩展** —— 要讲这个知识点，先补哪些前置内容；
  - ``direction=both``：两侧都要（前端画邻域图用）。
- ``GET /api/graph/overview/{grade_level}``：某学段整张图的**全览**（学习地图用）。

方向语义（全项目统一）：``from`` 是前置，``to`` 是后继 —— 详见 ``app/knowledge/deps.py``。
取值与契约的 ``DepDirection`` 逐字一致（``prerequisite`` 不缩写）。

薄控制器：只解析参数、校验、把服务层结果映射成契约模型。
递归 CTE 与深度上限在 ``app/knowledge/deps.py``，这里**不做图遍历**。

★ **两个接口的遍历实现是一份**：``/deps`` 走 ``deps.successors/prerequisites``（按点展开），
  ``/overview`` 走 ``kb.dependency_rows()``（整表读出）—— 后者不重复前者，
  它是「一张边表读全」而不是图算法（几十到几百条边，一次读完比逐点递归更简单）。
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request

from app.contracts import GraphEdge, GraphNode, GraphOverview
from app.knowledge.deps import (
    DEFAULT_DEPTH,
    MAX_DEPTH_LIMIT,
    prerequisites,
    successors,
)
from app.rag.contracts_bridge import DepNode
from app.store import kb as kb_repo
from app.store.connections import DatabaseMissing, connect

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["graph"])

Direction = Literal["successor", "prerequisite", "both"]

#: 允许的学段（与契约 ``GradeLevel`` 逐字一致；路径参数不自动校验 Literal，显式判一次）
GRADE_LEVELS: tuple[str, ...] = ("primary_low", "primary_high", "junior", "senior")


def open_kb_readonly(request: Request) -> sqlite3.Connection:
    """打开**随包只读**的知识库连接（调用方负责 ``close()``）。

    ★ 这个函数是本文件与 ``routes/knowledge.py`` **共用**的：两处各写一遍
      「取 kb 路径 + 判断存在 + readonly 连接 + 把 ``DatabaseMissing`` 转成 503」
      会很快分叉（一处补了新兜底、另一处没有），而它们必须给出同一口径的 503 文案。
    """
    from app.rag.retriever import default_kb_path

    config = request.app.state.config
    kb_path = default_kb_path(config.data_dir)
    if not kb_path.exists():
        raise HTTPException(
            status_code=503, detail=f"知识库不存在：{kb_path}（先跑 scripts/build_kb.py）"
        )
    try:
        return connect(kb_path, readonly=True)
    except DatabaseMissing as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/graph/deps/{kp_id}", response_model=list[DepNode])
def graph_deps(
    request: Request,
    kp_id: str,
    direction: Direction = Query(
        "successor",
        description="successor=后继（推荐路径）/ prerequisite=前置（检索扩展）/ both",
    ),
    max_depth: int = Query(
        DEFAULT_DEPTH, ge=1, le=MAX_DEPTH_LIMIT, description="递归深度上限（防环死循环）"
    ),
) -> list[DepNode]:
    """查一个知识点的前置/后继。

    - 知识点不存在 → **404**（不返回空数组：空数组看起来像「这个点没有邻居」，
      而实际上可能是 kp_id 拼错了，两者必须区分开）；
    - 深度上限由 :data:`app.knowledge.deps.MAX_DEPTH_LIMIT` 卡死（元数据笔误成环也不会挂）。

    ★ 返回结构里带 ``depth`` 与 ``direction``：前端画邻域图与排序都要用，
    调用方也就不必自己再走一遍图。
    """
    conn = open_kb_readonly(request)

    try:
        if kb_repo.get_kp(conn, kp_id) is None:
            raise HTTPException(status_code=404, detail=f"知识点不存在：{kp_id}")

        rows = []
        if direction in ("successor", "both"):
            rows.extend(successors(conn, kp_id, max_depth=max_depth))
        if direction in ("prerequisite", "both"):
            rows.extend(prerequisites(conn, kp_id, max_depth=max_depth))
    finally:
        conn.close()

    # both 时同一个知识点可能既在前置又在后继里：按 (kp_id, direction) 去重，保留最浅的一跳
    seen: dict[tuple[str, str], object] = {}
    for row in rows:
        key = (row.kp_id, row.direction)  # type: ignore[attr-defined]
        kept = seen.get(key)
        if kept is None or row.depth < kept.depth:  # type: ignore[attr-defined]
            seen[key] = row
    ordered = sorted(
        seen.values(), key=lambda r: (r.direction, r.depth, r.kp_id)  # type: ignore[attr-defined]
    )

    return [
        DepNode(
            kp_id=row.kp_id,  # type: ignore[attr-defined]
            name=row.name,  # type: ignore[attr-defined]
            grade_level=row.grade_level,  # type: ignore[attr-defined]
            relation=row.relation,  # type: ignore[attr-defined]
            weight=row.weight,  # type: ignore[attr-defined]
            depth=row.depth,  # type: ignore[attr-defined]
            direction=row.direction,  # type: ignore[attr-defined]
        )
        for row in ordered
    ]


@router.get(
    "/graph/overview/{grade_level}",
    response_model=GraphOverview,
    summary="某学段依赖图全览（学习地图用）",
)
def graph_overview(
    request: Request,
    grade_level: str,
    student_id: str | None = Query(
        None, description="带上就标注每个知识点是否已掌握（读该学生的 progress）"
    ),
    studentId: str | None = Query(None, include_in_schema=False),
) -> GraphOverview:
    """把某学段的知识点与**两端都在本学段内**的依赖边整张吐出来。

    ★ 为什么按学段切片而不是给全图：学习地图是要**看**的，一次画 33 个节点还行，
      跨学段全画（含边）会变成一团糊。跨学段的边在这里被**刻意丢掉** ——
      它们在单学段视图里没有落点，传出去只会画出悬空的线。

    ★ ``layer``（分层）由服务端算：前端拿到的是一张已排好层次的图，
      不必自己再做一次拓扑排序（两处各算一遍必然不一致）。算法见 ``_assign_layers``。

    - 学段名非法 → **422**；知识库缺失 → **503**（与章节接口同一口径）。
    """
    if grade_level not in GRADE_LEVELS:
        raise HTTPException(
            status_code=422,
            detail=f"学段非法：{grade_level!r}（允许：{'/'.join(GRADE_LEVELS)}）",
        )
    sid = student_id or studentId
    if sid:
        from app.routes.students import validate_student_id

        validate_student_id(sid)

    conn = open_kb_readonly(request)
    try:
        kp_ids = kb_repo.kp_ids_by_grade(conn, grade_level)
        meta = kb_repo.kp_meta(conn, kp_ids)
        edges = kb_repo.dependency_rows(conn)
    except sqlite3.Error as exc:
        logger.exception("依赖图全览读取失败：%s", grade_level)
        raise HTTPException(status_code=503, detail=f"读取依赖图失败（知识库异常）：{exc}") from exc
    finally:
        conn.close()

    inside = set(kp_ids)
    kept_edges = [
        GraphEdge(from_kp_id=f, to_kp_id=t, relation=r, weight=w)  # type: ignore[arg-type]
        for f, t, r, w in edges
        if f in inside and t in inside
    ]
    layers = _assign_layers(kp_ids, [(e.from_kp_id, e.to_kp_id) for e in kept_edges])

    mastered = _mastered_kp_ids(request, sid) if sid else set()
    nodes = [
        GraphNode(
            kp_id=kp_id,
            name=meta.get(kp_id, ("", "", ""))[0] or kp_id,
            grade_level=grade_level,  # type: ignore[arg-type]
            chapter_title=meta.get(kp_id, ("", "", ""))[1],
            layer=layers.get(kp_id, 0),
            mastered=kp_id in mastered,
        )
        for kp_id in kp_ids
    ]
    return GraphOverview(
        grade_level=grade_level,  # type: ignore[arg-type]
        nodes=nodes,
        edges=list(kept_edges),
    )


def _assign_layers(kp_ids: list[str], edges: list[tuple[str, str]]) -> dict[str, int]:
    """给每个知识点算**分层**（0 = 该子图的入口）。

    算法：节点的 layer = 它全部前置的 layer 的最大值 + 1；没有前置则为 0。
    用**迭代松弛**而不是递归：依赖图理论上无环（``deps.find_cycles`` 在导入阶段就拦住了），
    但万一数据被人手改出环，递归会直接爆栈 —— 而这个端点只是画图，
    让它**降级成「环上的点留在第 0 层」**远比让整个学习地图 500 好。

    ★ 迭代上限取 ``len(kp_ids)``：无环图上最多松弛 N 轮就收敛（这就是最长路径的轮数上界）；
      有环时会跑满 N 轮后停下，结果稳定（同输入同输出），不会转不出来。
    """
    predecessors: dict[str, list[str]] = {kp_id: [] for kp_id in kp_ids}
    for src, dst in edges:
        if src in predecessors and dst in predecessors:
            predecessors[dst].append(src)

    layers = {kp_id: 0 for kp_id in kp_ids}
    for _ in range(max(1, len(kp_ids))):
        changed = False
        for kp_id in kp_ids:
            best = 0
            for pred in predecessors[kp_id]:
                best = max(best, layers[pred] + 1)
            if best != layers[kp_id]:
                layers[kp_id] = best
                changed = True
        if not changed:
            break
    return layers


def _mastered_kp_ids(request: Request, student_id: str) -> set[str]:
    """该学生 ``progress.stage == "mastered"`` 的知识点集合（与章节接口同一口径）。

    ★ 与 ``routes/knowledge.py`` 里那个同名私有函数是**两处各一份**吗？不是「重复实现」：
      它只有两行 SQL 口径（``stage == "mastered"``），而共用它需要把「开哪个学生的库」
      这件事抽出去 —— 那反而多一层间接。真正要防的是「用 mastery 阈值冒充闯关通过」，
      这一点两处的注释都点名了同一条理由。
    """
    from app.routes.students import open_learning_store, require_data_dir

    store = open_learning_store(require_data_dir(request), student_id)
    try:
        return {record.kp_id for record in store.progress_rows() if record.stage == "mastered"}
    except sqlite3.Error:
        return set()
    finally:
        store.close()


__all__ = [
    "Direction",
    "GRADE_LEVELS",
    "graph_deps",
    "graph_overview",
    "open_kb_readonly",
    "router",
]
