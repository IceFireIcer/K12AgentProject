"""知识点依赖图：邻接表 + 内存缓存 + 递归 CTE，**同时服务两个用途**。

★ **方向语义（全项目统一，别处不要再解释一遍）**：

    from_kp_id  = 前置（prerequisite，先学它）
    to_kp_id    = 后继（successor，学完前置再学它）

于是 ``from='变量' → to='循环'`` 读作「变量是循环的前置」。
**方向搞反是静默错误**：图看着完全正常，但「推荐下一步」会把学生送去学更基础的，
「检索扩展」会把后继（超纲内容）当作补充上下文塞进来。

两个用途（创新点，缺一个就少一条演示动作）
------------------------------------------
1. **推荐路径** —— :func:`recommend_next`：掌握「变量」后，推荐依赖图里的后继「循环」
   （不是随机取，也不是按列表顺序取下一个）。
2. **检索扩展** —— :func:`expansion_kp_ids`：学生问「循环」时，把前置「变量」的内容
   补进检索上下文。**必须有数量上限**，否则前置内容会把 top-k 挤满、把真正命中的内容顶掉。

三条不可省略的防护（业务陷阱清单 §3）
------------------------------------
- 递归 CTE **必须带 ``depth`` 上限**：元数据里一个笔误形成环，无上限就是死循环；
- 导入阶段 **DFS 环检测**，报错要给出**完整环路路径**（``A→B→C→A``），不能只说「检测到环」；
- 悬空引用（``to_kp_id`` / ``from_kp_id`` 在 ``kp`` 表里不存在）**报错并中止导入**，不静默跳过。
"""

from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

logger = logging.getLogger(__name__)

# 递归 CTE 的深度上限（防环死循环的**唯一**保证；同时也是「图别太长」的产品约束）
MAX_DEPTH_LIMIT = 10
DEFAULT_DEPTH = 3

# 检索扩展的默认上限：前置内容只是补充上下文，**不得把 top-k 挤满**
EXPANSION_LIMIT = 2
EXPANSION_MAX_DEPTH = 2

RELATIONS: tuple[str, ...] = ("prerequisite", "related")


class DependencyGraphError(ValueError):
    """依赖图导入/校验失败。**必须中止导入**，不允许「跳过坏边继续」。"""


class DanglingReferenceError(DependencyGraphError):
    """依赖关系引用了 ``kp`` 表里不存在的知识点。"""


class CycleError(DependencyGraphError):
    """依赖图存在环（报错信息里带完整环路路径）。"""


@dataclass(frozen=True)
class DepEdge:
    """一条依赖边：``from`` 是前置，``to`` 是后继。"""

    from_kp_id: str
    to_kp_id: str
    relation: str = "prerequisite"
    weight: float = 1.0


@dataclass(frozen=True)
class DepRow:
    """查询结果行（带上深度与权重，供推荐排序与前端展示）。"""

    kp_id: str
    name: str
    grade_level: str
    relation: str
    weight: float
    depth: int
    # 该节点相对查询节点的方向：successor（后继）/ prerequisite（前置）
    direction: str


@dataclass(frozen=True)
class Adjacency:
    """邻接表（内存缓存的内容）。"""

    successors: dict[str, tuple[DepEdge, ...]]
    predecessors: dict[str, tuple[DepEdge, ...]]
    kp_meta: dict[str, tuple[str, str]]  # kp_id -> (name, grade_level)
    edge_count: int

    @property
    def kp_count(self) -> int:
        return len(self.kp_meta)


# --------------------------------------------------------------------------- #
# 校验（导入阶段）
# --------------------------------------------------------------------------- #
def _known_kp_ids(conn: sqlite3.Connection) -> set[str]:
    return {str(r["kp_id"]) for r in conn.execute("SELECT kp_id FROM kp")}


def validate_edges(conn: sqlite3.Connection, edges: Sequence[DepEdge]) -> None:
    """导入前校验：悬空引用 → 报错中止；有环 → 报错并给出完整路径。"""
    known = _known_kp_ids(conn)
    for edge in edges:
        if edge.relation not in RELATIONS:
            raise DependencyGraphError(
                f"依赖关系 relation={edge.relation!r} 非法（允许：{RELATIONS}）：{edge}"
            )
        for field, value in (("from_kp_id", edge.from_kp_id), ("to_kp_id", edge.to_kp_id)):
            if value not in known:
                raise DanglingReferenceError(
                    f"依赖关系引用了不存在的知识点：{field}={value!r}"
                    f"（来自 from={edge.from_kp_id!r} → to={edge.to_kp_id!r}）。"
                    f"悬空引用必须修数据，不允许跳过。"
                )
        if edge.from_kp_id == edge.to_kp_id:
            raise CycleError(f"依赖图存在自环：{edge.from_kp_id}→{edge.to_kp_id}")

    cycles = find_cycles(edges)
    if cycles:
        path = cycles[0]
        raise CycleError(
            "依赖图存在环：" + "→".join(path) + f"（共 {len(path) - 1} 条边）。"
            "环会让递归 CTE 无限展开（现在有 depth 上限兜底，但推荐路径与检索扩展都会失真）。"
        )


def find_cycles(edges: Sequence[DepEdge]) -> list[list[str]]:
    """DFS 找环，返回**完整环路路径**列表（例如 ``[["A","B","C","A"]]``）。"""
    graph: dict[str, list[str]] = defaultdict(list)
    nodes: set[str] = set()
    for edge in edges:
        graph[edge.from_kp_id].append(edge.to_kp_id)
        nodes.update((edge.from_kp_id, edge.to_kp_id))

    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {node: WHITE for node in nodes}
    found: list[list[str]] = []
    seen_signature: set[tuple[str, ...]] = set()

    def dfs(node: str, path: list[str]) -> None:
        color[node] = GRAY
        path.append(node)
        for nxt in graph.get(node, ()):
            if color.get(nxt, WHITE) == GRAY:
                idx = path.index(nxt)
                cycle = path[idx:] + [nxt]
                signature = _rotation_key(cycle)
                if signature not in seen_signature:
                    seen_signature.add(signature)
                    found.append(cycle)
            elif color.get(nxt, WHITE) == WHITE:
                dfs(nxt, path)
        path.pop()
        color[node] = BLACK

    for node in sorted(nodes):
        if color[node] == WHITE:
            dfs(node, [])
    return found


def _rotation_key(cycle: Sequence[str]) -> tuple[str, ...]:
    """把环旋转到字典序最小的起点，便于「同一个环只报一次」的去重。"""
    body = list(cycle[:-1])  # 去掉重复的收尾节点
    if not body:
        return tuple(cycle)
    rotations = [tuple(body[i:] + body[:i]) for i in range(len(body))]
    return min(rotations)


def insert_dependencies(conn: sqlite3.Connection, edges: Sequence[DepEdge]) -> int:
    """校验后写入依赖边（**校验不过直接抛异常，一条都不写**）。"""
    validate_edges(conn, edges)
    for edge in edges:
        conn.execute(
            "INSERT OR REPLACE INTO knowledge_dependencies(from_kp_id, to_kp_id, relation, weight) "
            "VALUES(?,?,?,?)",
            (edge.from_kp_id, edge.to_kp_id, edge.relation, float(edge.weight)),
        )
    invalidate_cache()
    return len(edges)


# --------------------------------------------------------------------------- #
# 邻接表 + 内存缓存
# --------------------------------------------------------------------------- #
_CACHE: dict[str, tuple[float, Adjacency]] = {}


def _db_identity(conn: sqlite3.Connection) -> str:
    """库文件路径（用于缓存键）。内存库返回空串 → 不缓存。"""
    try:
        for row in conn.execute("PRAGMA database_list"):
            if str(row["name"]) == "main":
                return str(row["file"] or "")
    except sqlite3.Error:
        pass
    return ""


def invalidate_cache(path: str | Path | None = None) -> None:
    """清缓存（导入/重建后必须调用，否则读到旧图）。"""
    if path is None:
        _CACHE.clear()
    else:
        _CACHE.pop(str(Path(path).resolve()).lower(), None)


def load_adjacency(conn: sqlite3.Connection, *, use_cache: bool = True) -> Adjacency:
    """读全图进内存（带 mtime 缓存）。

    依赖图很小（几十到几百条边），一次读全 + 内存索引比每次查询都做递归 CTE 更划算；
    递归 CTE 保留给「按 kp 查邻域」的接口（见 :func:`successors` / :func:`prerequisites`）。
    """
    identity = _db_identity(conn)
    mtime = 0.0
    if use_cache and identity and Path(identity).exists():
        mtime = Path(identity).stat().st_mtime
        cached = _CACHE.get(identity.lower())
        if cached and cached[0] == mtime:
            return cached[1]

    succ: dict[str, list[DepEdge]] = defaultdict(list)
    pred: dict[str, list[DepEdge]] = defaultdict(list)
    for row in conn.execute(
        "SELECT from_kp_id, to_kp_id, relation, weight FROM knowledge_dependencies "
        "ORDER BY from_kp_id, to_kp_id"
    ):
        edge = DepEdge(
            from_kp_id=str(row["from_kp_id"]),
            to_kp_id=str(row["to_kp_id"]),
            relation=str(row["relation"]),
            weight=float(row["weight"]),
        )
        succ[edge.from_kp_id].append(edge)
        pred[edge.to_kp_id].append(edge)

    meta = {
        str(r["kp_id"]): (str(r["name"]), str(r["grade_level"]))
        for r in conn.execute("SELECT kp_id, name, grade_level FROM kp")
    }
    adjacency = Adjacency(
        successors={k: tuple(v) for k, v in succ.items()},
        predecessors={k: tuple(v) for k, v in pred.items()},
        kp_meta=meta,
        edge_count=sum(len(v) for v in succ.values()),
    )
    if use_cache and identity:
        _CACHE[identity.lower()] = (mtime, adjacency)
    return adjacency


# --------------------------------------------------------------------------- #
# 递归 CTE（单点邻域查询）
# --------------------------------------------------------------------------- #
def _cte_walk(
    conn: sqlite3.Connection,
    kp_id: str,
    *,
    direction: str,
    max_depth: int,
    relation: str | None = None,
) -> list[sqlite3.Row]:
    """递归 CTE 走图。★ ``depth`` 上限是必须的 —— 有环时没有它就是死循环。

    ★ **``relation`` 过滤必须同时作用于 ``seed`` 与 ``step``**（两处都拼 ``rel_filter``）。
    只过滤 ``step`` 是一个**静默错误**：学生问「循环」时，只有 ``related`` 边的知识点
    （例如「神经网络」）会以「前置知识点」的身份被补进检索上下文 —— 图看着完全正常，
    但补进来的内容根本不是讲授前提（实测：``A --related--> B`` 的 A 会被当成 B 的前置）。
    两个方向（prerequisite / successor）都受同一条约束。
    """
    depth_cap = max(1, min(int(max_depth), MAX_DEPTH_LIMIT))
    # seed 侧的过滤条件：seed 的列别名就是 `relation`（没有 d. 前缀），step 侧是 `d.relation`。
    # 注意别把 d. 前缀套到 seed 上 —— seed 里没有 `d` 这个别名，SQL 会直接报错。
    seed_filter = " AND relation = :relation" if relation else ""
    step_filter = " AND d.relation = :relation" if relation else ""
    if direction == "successor":
        seed = ("SELECT to_kp_id AS kp_id, 1 AS depth, weight, relation "
                f"FROM knowledge_dependencies WHERE from_kp_id = :kp_id{seed_filter}")
        step = ("SELECT d.to_kp_id, s.depth + 1, d.weight, d.relation "
                "FROM knowledge_dependencies d JOIN walk s ON d.from_kp_id = s.kp_id")
    else:
        seed = ("SELECT from_kp_id AS kp_id, 1 AS depth, weight, relation "
                f"FROM knowledge_dependencies WHERE to_kp_id = :kp_id{seed_filter}")
        step = ("SELECT d.from_kp_id, s.depth + 1, d.weight, d.relation "
                "FROM knowledge_dependencies d JOIN walk s ON d.to_kp_id = s.kp_id")

    sql = (
        "WITH RECURSIVE walk(kp_id, depth, weight, relation) AS ("
        f"  {seed}"
        f"  UNION"  # UNION（不是 ALL）+ depth 上限：环不会无限展开
        f"  {step} WHERE s.depth < :depth_cap{step_filter}"
        ") "
        "SELECT w.kp_id, MIN(w.depth) AS depth, MAX(w.weight) AS weight, "
        "       MIN(w.relation) AS relation, k.name, k.grade_level "
        "FROM walk w JOIN kp k ON k.kp_id = w.kp_id "
        "GROUP BY w.kp_id ORDER BY depth ASC, w.kp_id ASC"
    )
    params: dict[str, object] = {"kp_id": kp_id, "depth_cap": depth_cap}
    if relation:
        params["relation"] = relation
    return list(conn.execute(sql, params))


def _rows_to_dep_rows(rows: Iterable[sqlite3.Row], direction: str) -> list[DepRow]:
    return [
        DepRow(
            kp_id=str(r["kp_id"]),
            name=str(r["name"]),
            grade_level=str(r["grade_level"]),
            relation=str(r["relation"]),
            weight=float(r["weight"]),
            depth=int(r["depth"]),
            direction=direction,
        )
        for r in rows
    ]


def successors(
    conn: sqlite3.Connection,
    kp_id: str,
    *,
    max_depth: int = DEFAULT_DEPTH,
    relation: str | None = None,
) -> list[DepRow]:
    """后继（学完 ``kp_id`` 之后可以学什么）—— **推荐路径**的数据来源。"""
    rows = _cte_walk(conn, kp_id, direction="successor", max_depth=max_depth, relation=relation)
    return _rows_to_dep_rows(rows, "successor")


def prerequisites(
    conn: sqlite3.Connection,
    kp_id: str,
    *,
    max_depth: int = DEFAULT_DEPTH,
    relation: str | None = None,
) -> list[DepRow]:
    """前置（要学 ``kp_id`` 得先会什么）—— **检索扩展**的数据来源。"""
    rows = _cte_walk(conn, kp_id, direction="prerequisite", max_depth=max_depth, relation=relation)
    return _rows_to_dep_rows(rows, "prerequisite")


# --------------------------------------------------------------------------- #
# 用途一：推荐路径
# --------------------------------------------------------------------------- #
def recommend_next(
    conn: sqlite3.Connection,
    mastered_kp_ids: Sequence[str],
    *,
    limit: int = 3,
    grade_level: str | None = None,
    max_depth: int = DEFAULT_DEPTH,
) -> list[DepRow]:
    """掌握了一批知识点后，推荐依赖图里的**后继**（不是按列表顺序取下一个）。

    - 过滤掉已掌握的；
    - ``grade_level`` 给了就只推荐「不高于该学段」的内容（防超纲）；
    - 排序：越近的后继越优先（depth 小的先），同深度看权重与 kp_id。
    """
    from app.knowledge.library import compatible_grades

    adjacency = load_adjacency(conn)
    mastered = {k for k in mastered_kp_ids if k}
    if not mastered:
        return []
    allowed = set(compatible_grades(grade_level)) if grade_level else None

    scored: dict[str, DepRow] = {}
    for source in sorted(mastered):
        for row in successors(conn, source, max_depth=max_depth):
            if row.kp_id in mastered:
                continue
            if allowed is not None and row.grade_level not in allowed:
                continue
            kept = scored.get(row.kp_id)
            if kept is None or (row.depth, -row.weight) < (kept.depth, -kept.weight):
                scored[row.kp_id] = row
    ordered = sorted(scored.values(), key=lambda r: (r.depth, -r.weight, r.kp_id))
    return ordered[:limit]


# --------------------------------------------------------------------------- #
# 用途二：检索扩展
# --------------------------------------------------------------------------- #
def expansion_kp_ids(
    conn: sqlite3.Connection,
    kp_ids: Sequence[str],
    *,
    grade_levels: Sequence[str],
    max_depth: int = EXPANSION_MAX_DEPTH,
    limit: int = EXPANSION_LIMIT,
) -> list[str]:
    """给出「应当补进检索范围的前置知识点」。

    ★ ``grade_levels`` 是**硬过滤**：依赖边是跨学段的，若不卡学段，
    初中生问「循环」会把高中才讲的「变量」内容补进来 —— 直接违反关卡 C 的学段隔离。

    ★ **一次 CTE 拿全部深度的候选，再按 ``(depth, weight, kp_id)`` 排序取前 ``limit`` 个**。
    不要写成「外层 for depth：每轮把结果全写进字典」——那样 depth=1 的邻居会先占满名额，
    更深的前置永远拿不到，``max_depth`` 这个参数就被吞掉了（实测：2 级链上
    ``limit=2`` 只返回 1 条，第 2 条深度的前置被吃掉）。

    三条不变量：① ``grade_levels`` 硬过滤；② 跳过 ``seeds`` 自身；③ 结果有数量上限。
    """
    allowed = set(grade_levels)
    adjacency = load_adjacency(conn)
    seeds = {k for k in kp_ids if k}
    if not seeds:
        return []
    depth_cap = max(1, min(int(max_depth), MAX_DEPTH_LIMIT))

    # 每个 seed 一次 CTE，只走 prerequisite 边（related 只表示「相关」，
    # 不该被当成讲授某个知识点的前提条件 —— 过滤写在 CTE 的 seed 与 step 两侧）。
    picked: dict[str, tuple[int, float]] = {}
    for kp in sorted(seeds):
        for row in _cte_walk(
            conn, kp, direction="prerequisite", max_depth=depth_cap, relation="prerequisite"
        ):
            kp_id = str(row["kp_id"])
            if kp_id in seeds:
                continue
            meta = adjacency.kp_meta.get(kp_id)
            grade = meta[1] if meta else str(row["grade_level"])
            if grade not in allowed:
                continue
            candidate = (int(row["depth"]), -float(row["weight"]))
            kept = picked.get(kp_id)
            # 同一个 kp 从不同 seed 走到时保留「更近 / 权重更大」的那条
            if kept is None or candidate < kept:
                picked[kp_id] = candidate

    ordered = sorted(picked.items(), key=lambda item: (item[1][0], item[1][1], item[0]))
    return [kp for kp, _ in ordered[: max(0, int(limit))]]


# --------------------------------------------------------------------------- #
# 图规模 / 自检
# --------------------------------------------------------------------------- #
def graph_stats(conn: sqlite3.Connection) -> dict[str, int | bool]:
    """图规模（知识点数 / 边数 / 是否成环），报告与汇报一行可查。"""
    adjacency = load_adjacency(conn)
    edges = [
        DepEdge(e.from_kp_id, e.to_kp_id, e.relation, e.weight)
        for group in adjacency.successors.values()
        for e in group
    ]
    return {
        "kp": adjacency.kp_count,
        "edges": adjacency.edge_count,
        "roots": len([k for k in adjacency.kp_meta if k not in adjacency.predecessors]),
        "leaves": len([k for k in adjacency.kp_meta if k not in adjacency.successors]),
        "cyclic": bool(find_cycles(edges)),
    }


def _main() -> int:
    """``uv run python -m app.knowledge.deps`` —— 一行看依赖图规模。"""
    from app.config import resolve_data_dir  # noqa: PLC0415
    from app.store.connections import connect  # noqa: PLC0415

    kb_path = resolve_data_dir(None) / "shared" / "kb.sqlite"
    if not kb_path.exists():
        print(f"kb 不存在：{kb_path}（先跑 uv run python scripts/build_kb.py）")
        return 1
    conn = connect(kb_path, readonly=True)
    stats = graph_stats(conn)
    print(f"kb = {kb_path}")
    print(
        f"知识点 {stats['kp']} 个 / 依赖边 {stats['edges']} 条 / 根 {stats['roots']} / "
        f"叶 {stats['leaves']} / 有环={stats['cyclic']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())


__all__ = [
    "Adjacency",
    "CycleError",
    "DEFAULT_DEPTH",
    "DepEdge",
    "DepRow",
    "DanglingReferenceError",
    "DependencyGraphError",
    "EXPANSION_LIMIT",
    "MAX_DEPTH_LIMIT",
    "expansion_kp_ids",
    "find_cycles",
    "graph_stats",
    "insert_dependencies",
    "invalidate_cache",
    "load_adjacency",
    "prerequisites",
    "recommend_next",
    "successors",
    "validate_edges",
]
