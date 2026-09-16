"""``GET /api/graph/deps/{kp_id}`` —— 知识点依赖图查询（**双用途**）。

- ``direction=successor``（默认）：**推荐路径** —— 学完这个知识点之后可以学什么；
- ``direction=prerequisite``：**检索扩展** —— 要讲这个知识点，先补哪些前置内容；
- ``direction=both``：两侧都要（前端画邻域图用）。

方向语义（全项目统一）：``from`` 是前置，``to`` 是后继 —— 详见 ``app/knowledge/deps.py``。
取值与契约的 ``DepDirection`` 逐字一致（``prerequisite`` 不缩写）。

薄控制器：只解析参数、校验、把服务层结果映射成 ``DepNode[]``。
递归 CTE 与深度上限在 ``app/knowledge/deps.py``，这里**不做图遍历**。
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request

from app.knowledge.deps import (
    DEFAULT_DEPTH,
    MAX_DEPTH_LIMIT,
    prerequisites,
    successors,
)
from app.rag.contracts_bridge import DepNode
from app.store import kb as kb_repo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["graph"])

Direction = Literal["successor", "prerequisite", "both"]


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
    config = request.app.state.config
    from app.rag.retriever import default_kb_path
    from app.store.connections import DatabaseMissing, connect

    kb_path = default_kb_path(config.data_dir)
    if not kb_path.exists():
        raise HTTPException(
            status_code=503, detail=f"知识库不存在：{kb_path}（先跑 scripts/build_kb.py）"
        )
    try:
        conn = connect(kb_path, readonly=True)
    except DatabaseMissing as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

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
