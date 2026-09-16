"""``kb.sqlite``（全局只读知识库）的仓储：教材 chunk / 向量 / FTS5 / 知识点读取。

**放在这里的只有 SQL 与行映射**，不含检索策略 —— 降级链在 ``app/rag/``。
这样做的原因：规则只有一处（例如「学段过滤必须在 SQL 层」），
编排与降级在另一处，二者不会互相污染。

★ 三个**会静默毁掉检索结果**的约定（业务陷阱清单 §2 第 2/3/6 条），本文件是唯一实现处：

1. ``chunk_vec.rowid`` **显式取 ``chunk.rowid``** —— vec0 与 chunk 一旦行号错位，
   检索会返回「别的知识点」的内容，而且看起来完全正常（张冠李戴）。
2. 向量 BLOB 一律 ``np.asarray(v, dtype="<f4").tobytes()``（**小端**），
   读出用 ``np.frombuffer(blob, dtype="<f4")``，端序必须一致。
3. 维度只有一个来源：``app.config.EMBEDDING_DIM``（不在此处写死 512）。
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

logger = logging.getLogger(__name__)

# 向量 BLOB 的 dtype：小端 float32。**两端必须一致**，改一处等于全库向量作废。
VECTOR_DTYPE = np.dtype("<f4")


# --------------------------------------------------------------------------- #
# 向量 <-> BLOB
# --------------------------------------------------------------------------- #
def pack_vector(vec: "np.ndarray | Sequence[float]") -> bytes:
    """向量 → BLOB（小端 float32）。"""
    arr = np.asarray(vec, dtype=VECTOR_DTYPE)
    return arr.tobytes(order="C")


def unpack_vector(blob: bytes) -> np.ndarray:
    """BLOB → 向量（按同端序还原）。"""
    return np.frombuffer(blob, dtype=VECTOR_DTYPE)


def l2_normalize(vec: "np.ndarray | Sequence[float]") -> np.ndarray:
    """L2 归一化。

    bge 系列本身输出归一化向量（实测 norm=1.0），这里再显式归一化一次是为了
    **让「余弦」与 vec0 的默认 L2 距离可互相换算**：单位向量下 ``cos = 1 - d²/2``。
    """
    arr = np.asarray(vec, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    if norm <= 0:
        return arr
    return arr / norm


# --------------------------------------------------------------------------- #
# 行模型
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class KpRecord:
    kp_id: str
    grade_level: str
    name: str
    chapter_title: str
    section_title: str
    summary: str


@dataclass(frozen=True)
class ChunkRecord:
    rowid: int
    chunk_id: str
    parent_chunk_id: str | None
    text: str
    grade_level: str
    chapter_title: str
    section_title: str
    knowledge_point: str
    content_type: str
    token_count: int
    is_parent: bool

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "ChunkRecord":
        return cls(
            rowid=int(row["rowid"]),
            chunk_id=str(row["chunk_id"]),
            parent_chunk_id=row["parent_chunk_id"],
            text=str(row["text"]),
            grade_level=str(row["grade_level"]),
            chapter_title=str(row["chapter_title"] or ""),
            section_title=str(row["section_title"] or ""),
            knowledge_point=str(row["knowledge_point"] or ""),
            content_type=str(row["content_type"] or ""),
            token_count=int(row["token_count"] or 0),
            is_parent=bool(row["is_parent"]),
        )


CHUNK_COLUMNS = (
    "rowid, chunk_id, parent_chunk_id, text, grade_level, chapter_title, "
    "section_title, knowledge_point, content_type, token_count, is_parent"
)


# --------------------------------------------------------------------------- #
# 写库（只被 build_kb.py 使用）
# --------------------------------------------------------------------------- #
def clear_knowledge_tables(conn: sqlite3.Connection) -> None:
    """清空教材相关表 —— **建索引幂等的前提**（不清表重跑 = 数据翻倍）。

    顺序有讲究：先清 ``chunk_vec``（vec0 表），再清 ``chunk``，
    否则会出现「vec 行还在、chunk 行已换」的错位窗口。
    ``chunk_fts`` 是外部内容表，不直接 DELETE，改用 ``'rebuild'`` 指令重建。
    """
    for table in ("chunk_vec", "chunk", "kp", "knowledge_dependencies"):
        if table_exists(conn, table):
            conn.execute(f"DELETE FROM {table}")
    if table_exists(conn, "chunk_fts"):
        rebuild_fts(conn)


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1", (name,)
        ).fetchone()
        is not None
    )


def insert_kp(conn: sqlite3.Connection, kp: KpRecord) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO kp(kp_id, grade_level, chapter_title, section_title, name, summary) "
        "VALUES(?,?,?,?,?,?)",
        (
            kp.kp_id,
            kp.grade_level,
            kp.chapter_title,
            kp.section_title,
            kp.name,
            kp.summary,
        ),
    )


def insert_chunk(
    conn: sqlite3.Connection,
    *,
    chunk_id: str,
    text: str,
    grade_level: str,
    chapter_title: str,
    section_title: str,
    knowledge_point: str,
    content_type: str,
    token_count: int,
    parent_chunk_id: str | None = None,
    is_parent: bool = False,
    embedding: "np.ndarray | None" = None,
) -> int:
    """写一行 ``chunk``，并（若有向量）**用同一个 rowid** 写 ``chunk_vec``。

    ★ ``rowid`` 是 SQLite 分配的，写 vec0 时必须**显式传入这个 rowid**：
    vec0 表自己再分配一次就会与 ``chunk`` 错位，检索结果张冠李戴。
    """
    cur = conn.execute(
        "INSERT INTO chunk(chunk_id, parent_chunk_id, text, embedding, grade_level, "
        "chapter_title, section_title, knowledge_point, content_type, token_count, is_parent) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (
            chunk_id,
            parent_chunk_id,
            text,
            pack_vector(embedding) if embedding is not None else None,
            grade_level,
            chapter_title,
            section_title,
            knowledge_point,
            content_type,
            token_count,
            1 if is_parent else 0,
        ),
    )
    rowid = int(cur.lastrowid)

    if embedding is not None and table_exists(conn, "chunk_vec"):
        conn.execute(
            "INSERT INTO chunk_vec(rowid, embedding, grade_level) VALUES(?,?,?)",
            (rowid, pack_vector(embedding), grade_level),
        )
    return rowid


def insert_dependency(
    conn: sqlite3.Connection,
    *,
    from_kp_id: str,
    to_kp_id: str,
    relation: str,
    weight: float = 1.0,
) -> None:
    """写一条依赖边。**from = 前置，to = 后继**（全项目统一，见 ``app/knowledge/deps.py``）。"""
    conn.execute(
        "INSERT OR REPLACE INTO knowledge_dependencies(from_kp_id, to_kp_id, relation, weight) "
        "VALUES(?,?,?,?)",
        (from_kp_id, to_kp_id, relation, weight),
    )


def rebuild_fts(conn: sqlite3.Connection) -> None:
    """重建 FTS5 索引（外部内容表专用指令）。

    外部内容表不能直接 ``DELETE``/``INSERT`` 正文，必须走 ``'rebuild'``：
    它按 ``content='chunk'`` 重新扫一遍 ``chunk`` 表建索引。
    """
    if table_exists(conn, "chunk_fts"):
        conn.execute("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')")


# --------------------------------------------------------------------------- #
# 读：chunk / 父块 / 大纲
# --------------------------------------------------------------------------- #
def get_chunk_by_id(conn: sqlite3.Connection, chunk_id: str) -> ChunkRecord | None:
    row = conn.execute(
        f"SELECT {CHUNK_COLUMNS} FROM chunk WHERE chunk_id = ?", (chunk_id,)
    ).fetchone()
    return ChunkRecord.from_row(row) if row else None


def get_chunk_by_rowid(conn: sqlite3.Connection, rowid: int) -> ChunkRecord | None:
    row = conn.execute(
        f"SELECT {CHUNK_COLUMNS} FROM chunk WHERE rowid = ?", (rowid,)
    ).fetchone()
    return ChunkRecord.from_row(row) if row else None


def chunks_by_rowids(
    conn: sqlite3.Connection, rowids: Sequence[int]
) -> dict[int, ChunkRecord]:
    """按 rowid 批量取 chunk（KNN 只返回 rowid+distance，这里补全字段）。"""
    ids = [int(r) for r in rowids]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT {CHUNK_COLUMNS} FROM chunk WHERE rowid IN ({placeholders})", ids
    ).fetchall()
    return {int(r["rowid"]): ChunkRecord.from_row(r) for r in rows}


def get_parent(conn: sqlite3.Connection, chunk: ChunkRecord) -> ChunkRecord:
    """命中子块 → 取父块。**注入 LLM 的上下文是父块完整内容，不是碎片**。

    父块缺失（数据不一致）时退回子块本身，并记一条 warning —— 宁可上下文短一点，
    也不要让整次检索失败。
    """
    if not chunk.parent_chunk_id:
        return chunk
    parent = get_chunk_by_id(conn, chunk.parent_chunk_id)
    if parent is None:
        logger.warning("父块缺失：child=%s parent=%s", chunk.chunk_id, chunk.parent_chunk_id)
        return chunk
    return parent


def parent_text_map(conn: sqlite3.Connection, chunk_ids: Iterable[str]) -> dict[str, str]:
    """批量取父块文本：``{child_chunk_id: 父块文本}``（一次查询，不在循环里打库）。"""
    ids = [c for c in chunk_ids if c]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        "SELECT c.chunk_id AS child_id, COALESCE(p.text, c.text) AS text "
        "FROM chunk c LEFT JOIN chunk p ON p.chunk_id = c.parent_chunk_id "
        f"WHERE c.chunk_id IN ({placeholders})",
        ids,
    ).fetchall()
    return {str(r["child_id"]): str(r["text"]) for r in rows}


def outline_chunks(
    conn: sqlite3.Connection, grade_levels: Sequence[str], *, limit: int
) -> list[ChunkRecord]:
    """四级兜底用：直接取该学段的节级块（父块）作大纲上下文，不走向量也不走 FTS。

    只取 ``is_parent=1``：注入的应当是完整的节级内容，而不是碎片。

    ★ ``grade_levels`` 的顺序**就是优先级**（``compatible_grades`` 已按由高到低排好）：
    学生自己学段的内容排最前，更低学段的内容随后。
    不能按 ``grade_level`` 字母序排 —— 那样 'primary_low' 会排在 'junior' 前面
    （'p' > 'j'），初中生拿到的「可讲范围」会全是小学内容。
    """
    if not grade_levels:
        return []
    ordered = list(dict.fromkeys(grade_levels))  # 去重保序
    placeholders = ",".join("?" * len(ordered))
    case = " ".join(f"WHEN ? THEN {i}" for i, _ in enumerate(ordered))
    rows = conn.execute(
        f"SELECT {CHUNK_COLUMNS} FROM chunk "
        f"WHERE grade_level IN ({placeholders}) AND is_parent = 1 "
        f"ORDER BY CASE grade_level {case} ELSE {len(ordered)} END, rowid LIMIT ?",
        (*ordered, *ordered, int(limit)),
    ).fetchall()
    return [ChunkRecord.from_row(r) for r in rows]


def chunks_for_kps(
    conn: sqlite3.Connection,
    kp_ids: Sequence[str],
    grade_levels: Sequence[str],
    *,
    per_kp: int = 1,
) -> list[ChunkRecord]:
    """按知识点取节级块（**依赖图扩展**用）。

    ★ 这里的 ``grade_level IN (...)`` 不是可选项：依赖图是**跨学段**的，
    若不在这里卡学段，初中生问「循环」时会把高中学段的「变量」内容也补进来 —— 直接超纲。
    """
    if not kp_ids or not grade_levels:
        return []
    kp_ph = ",".join("?" * len(kp_ids))
    grade_ph = ",".join("?" * len(grade_levels))
    rows = conn.execute(
        f"SELECT {CHUNK_COLUMNS} FROM chunk "
        f"WHERE knowledge_point IN ({kp_ph}) AND grade_level IN ({grade_ph}) AND is_parent = 1 "
        "ORDER BY knowledge_point, rowid",
        (*kp_ids, *grade_levels),
    ).fetchall()
    picked: dict[str, int] = {}
    out: list[ChunkRecord] = []
    for row in rows:
        rec = ChunkRecord.from_row(row)
        if picked.get(rec.knowledge_point, 0) >= per_kp:
            continue
        picked[rec.knowledge_point] = picked.get(rec.knowledge_point, 0) + 1
        out.append(rec)
    return out


def embeddings_by_grade(
    conn: sqlite3.Connection, grade_levels: Sequence[str]
) -> tuple[list[sqlite3.Row], np.ndarray]:
    """取出该学段全部子块向量，供 numpy 暴力余弦兜底。

    几千个 512 维 chunk 的暴力余弦是**毫秒级**的，比「因为没有 sqlite-vec 就检索不了」好得多
    （业务陷阱清单 §2 的验收口径明确要求这条兜底能现场演示）。
    """
    if not grade_levels:
        return [], np.zeros((0, 0), dtype=VECTOR_DTYPE)
    placeholders = ",".join("?" * len(grade_levels))
    rows = conn.execute(
        f"SELECT {CHUNK_COLUMNS}, embedding FROM chunk "
        f"WHERE grade_level IN ({placeholders}) AND embedding IS NOT NULL AND is_parent = 0",
        tuple(grade_levels),
    ).fetchall()
    if not rows:
        return [], np.zeros((0, 0), dtype=VECTOR_DTYPE)
    mat = np.vstack([unpack_vector(r["embedding"]) for r in rows]).astype(np.float32)
    return list(rows), mat


def knn_rows(
    conn: sqlite3.Connection,
    query_vec: "np.ndarray",
    grade_levels: Sequence[str],
    *,
    k: int,
) -> list[sqlite3.Row]:
    """sqlite-vec KNN（**学段过滤在 SQL 层，且由 vec0 在 KNN 内部执行**）。

    返回列：``rowid, distance``。为什么不是「先 KNN 再在应用层筛学段」：
    KNN 的 top-k 截断发生在过滤之前，应用层筛完可能一条不剩（业务陷阱清单 §2 第 5 条）。
    """
    if not grade_levels:
        return []
    placeholders = ",".join("?" * len(grade_levels))
    sql = (
        "SELECT rowid, distance FROM chunk_vec "
        f"WHERE embedding MATCH ? AND k = ? AND grade_level IN ({placeholders})"
    )
    return conn.execute(
        sql, (pack_vector(np.asarray(query_vec, dtype=VECTOR_DTYPE)), int(k), *grade_levels)
    ).fetchall()


# --------------------------------------------------------------------------- #
# 读：知识点 / 规模
# --------------------------------------------------------------------------- #
def get_kp(conn: sqlite3.Connection, kp_id: str) -> KpRecord | None:
    row = conn.execute(
        "SELECT kp_id, grade_level, name, chapter_title, section_title, summary "
        "FROM kp WHERE kp_id = ?",
        (kp_id,),
    ).fetchone()
    return _kp_from_row(row) if row else None


def kp_names(conn: sqlite3.Connection, kp_ids: Iterable[str]) -> dict[str, str]:
    ids = [k for k in kp_ids if k]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT kp_id, name FROM kp WHERE kp_id IN ({placeholders})", ids
    ).fetchall()
    return {str(r["kp_id"]): str(r["name"]) for r in rows}


def _kp_from_row(row: sqlite3.Row) -> KpRecord:
    return KpRecord(
        kp_id=str(row["kp_id"]),
        grade_level=str(row["grade_level"]),
        name=str(row["name"]),
        chapter_title=str(row["chapter_title"] or ""),
        section_title=str(row["section_title"] or ""),
        summary=str(row["summary"] or ""),
    )


def stats(conn: sqlite3.Connection) -> dict[str, int]:
    """库规模（报告与答辩要能一行输出）。"""
    def count(sql: str) -> int:
        try:
            return int(conn.execute(sql).fetchone()[0])
        except sqlite3.Error:
            return 0

    return {
        "kp": count("SELECT COUNT(*) FROM kp"),
        "chunk": count("SELECT COUNT(*) FROM chunk"),
        "parent_chunk": count("SELECT COUNT(*) FROM chunk WHERE is_parent = 1"),
        "child_chunk": count("SELECT COUNT(*) FROM chunk WHERE is_parent = 0"),
        "chunk_vec": count("SELECT COUNT(*) FROM chunk_vec"),
        "chunk_fts": count("SELECT COUNT(*) FROM chunk_fts"),
        "dependencies": count("SELECT COUNT(*) FROM knowledge_dependencies"),
    }
