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
import re
import sqlite3
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

logger = logging.getLogger(__name__)

# 向量 BLOB 的 dtype：小端 float32。**两端必须一致**，改一处等于全库向量作废。
VECTOR_DTYPE = np.dtype("<f4")

# vec0 写入失败是否已经告过警。
# 一次重建会对每个子块调用一次 insert_chunk（上千次），同一条原因逐条刷屏会把
# 真正需要看的那一行淹掉，所以只记第一处；``clear_knowledge_tables`` 每次重建开头重置，
# 于是「本次重建没写进向量」这件事每次都会说一遍。
# ★ 它只影响**日志频率**，不影响任何行为（写不进去都照旧跳过）。
_VEC_WRITE_WARNED = False


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

    顺序有讲究（两条都不能反）：

    1. 先清 ``chunk_vec``（vec0 表）再清 ``chunk``：否则会出现「vec 行还在、chunk 行已换」
       的错位窗口。
    2. 先清 ``knowledge_dependencies`` 再清 ``kp``：连接上开了 ``foreign_keys=ON``
       （见 ``store/connections.py``），依赖边引用 ``kp`` —— 反过来先删 ``kp``
       会被 FK 直接拒绝，**重跑建库脚本就炸**。

    ``chunk_fts`` 是外部内容表，不直接 DELETE，改用 ``'rebuild'`` 指令重建
    （本函数内那一句 rebuild 建出来的是**空索引**，正文由调用方随后写入，
    调用方写完正文要再 rebuild 一次 —— ``build_kb.build`` 就是这么做的）。

    ★★ ``chunk_vec`` 的失败**只告警、不抛**（详见 :func:`_clear_vec_table`）：
    扩展加载不了时 ``DELETE FROM chunk_vec`` 会抛 ``no such module: vec0``，
    那会让整次重建**永久失败** —— 而正文与向量 BLOB 都还好端端躺在 ``chunk`` 里、
    检索有 numpy 兜底，学生却只看到「重建失败（OperationalError）: no such module: vec0」。
    其余三张表照旧抛：它们是唯一真相，清不掉还继续写 = 新旧内容混在一起。
    """
    global _VEC_WRITE_WARNED
    _VEC_WRITE_WARNED = False  # 每次重建重新记账（只影响日志频率，见模块头）
    for table in ("chunk_vec", "chunk", "knowledge_dependencies", "kp"):
        if not table_exists(conn, table):
            continue
        if table == "chunk_vec":
            _clear_vec_table(conn, table)
        else:
            conn.execute(f"DELETE FROM {table}")
    if table_exists(conn, "chunk_fts"):
        rebuild_fts(conn)


def _clear_vec_table(conn: sqlite3.Connection, table: str) -> None:
    """清 vec0 虚表，失败降级为告警 —— ★ **全库唯一允许这样处理的表**。

    为什么只有它可容忍：``chunk_vec`` 是 ``chunk.embedding`` 的**派生索引**，
    正文与向量 BLOB 都在 ``chunk`` 里，检索链对它的缺席本来就有兜底
    （:func:`embeddings_by_grade` 的 numpy 暴力余弦，几千 chunk 是毫秒级）。
    扩展加载不了时本次重建压根写不进新向量（见 :func:`insert_chunk`），
    所以「清不掉 + 不写」留下的是一份**没有向量索引、但正文完整的库**，检索照常可用 ——
    这比「重建永久失败」好得多，也是本项目「缺什么降什么、绝不让整条链停摆」的口径。

    反过来，``chunk`` / ``knowledge_dependencies`` / ``kp`` 是**唯一真相**：
    它们的删除失败意味着清表没做完，继续往下写就会得到「新内容混着旧内容」的库 ——
    那种库看起来完全正常，是最危险的坏法，所以它们照旧抛。

    ⚠️ **残留风险**（本文件不解决，已记录）：vec 表清不掉时旧向量行会留在库里，
    而 ``chunk`` 清空后 rowid 会从 1 重新分配 —— 若这个库之后在**扩展可用**的环境
    被 KNN 查询，旧向量会与新 chunk 行号错位（张冠李戴，见模块头第 1 条）。
    现实中这条路径要求「重建时扩展不可用、之后又变可用」，且扩展不可用时检索
    走 numpy 兜底（不读 chunk_vec）；真要彻底消除，需要在检索侧知道
    「这份库的向量是不是本次建的」（那是另一个改动，不在本仓储的职责内）。
    """
    global _VEC_WRITE_WARNED
    try:
        conn.execute(f"DELETE FROM {table}")
    except sqlite3.Error as exc:
        _VEC_WRITE_WARNED = True  # 同一原因的写入失败不必再说一遍
        logger.warning(
            "清空 %s 失败，本次重建不写向量（检索将走 numpy 暴力余弦兜底）：%s", table, exc
        )
        _VEC_WRITE_WARNED = True  # 同一原因的写入失败不必再说一遍
        logger.warning(
            "清空 %s 失败，本次重建不写向量（检索将走 numpy 暴力余弦兜底）：%s", table, exc
        )


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
        _insert_vec_row(conn, rowid=rowid, embedding=embedding, grade_level=grade_level)
    return rowid


def _insert_vec_row(
    conn: sqlite3.Connection, *, rowid: int, embedding: "np.ndarray | Sequence[float]", grade_level: str
) -> None:
    """写一行 ``chunk_vec``（vec0 虚表），失败降级为告警。

    ★ 为什么这里可以吞掉 ``sqlite3.Error``（正文那条 INSERT 则照旧抛）：
    vec 表是**派生索引**，不是唯一真相 —— 扩展没加载（``no such module: vec0``）
    或 vec0 表的维度与 ``EMBEDDING_DIM`` 对不上（升级到 768 维后忘了重建索引）时，
    正文与 ``chunk.embedding`` 都已经写好了，检索有 numpy 暴力余弦兜底。
    这时正确的行为是「这份库暂时没有向量索引」，而不是让整次重建失败 ——
    后者会让一次明明可用的重建报成失败，最难查的那种假失败。

    ⚠️ 重试/告警只做一次：一次重建有上千个子块，逐条 warning 会把日志刷满
    （判据是模块级 ``_VEC_WRITE_WARNED``，只影响日志频率，不影响行为）。
    """
    global _VEC_WRITE_WARNED
    try:
        conn.execute(
            "INSERT INTO chunk_vec(rowid, embedding, grade_level) VALUES(?,?,?)",
            (rowid, pack_vector(embedding), grade_level),
        )
    except sqlite3.Error as exc:
        if not _VEC_WRITE_WARNED:
            _VEC_WRITE_WARNED = True
            logger.warning(
                "写 chunk_vec 失败，该库本次没有向量索引（检索将走 numpy 暴力余弦兜底）：%s", exc
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


def parent_text_map(conn: sqlite3.Connection, chunk_ids: Iterable[str]) -> dict[str, str]:
    """批量取父块文本：``{child_chunk_id: 父块文本}``（一次查询，不在循环里打库）。

    ★ **注入上下文走这条批量路径，不走「逐块取父块记录」**：KNN 命中 N 个子块时，
    逐块 ``SELECT`` 变成 N 次查询，而这条一次 JOIN 就够 —— 而且它只带回
    **父块正文**（检索上下文唯一要用的字段），不必把父块的整行都读出来。
    ``COALESCE(p.text, c.text)``：父块缺失（数据不一致）时退回子块正文，
    宁可上下文短一点，也不要让整次检索失败。
    """
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


def all_kp_ids(conn: sqlite3.Connection) -> set[str]:
    """当前教材里**全部**知识点 id。

    ★★ 存在的理由：``learning.db`` 按学生长期保留，而**教材会换代**
      （2026-09-19 接入 K12KnowledgeBase 时整库换过一次）。
      换代之后老学生的库里还留着一批**指向已删除知识点**的掌握度 / 进度行 ——
      它们一旦被当作正常数据渲染，界面上就会出现 **裸 kp_id**
      （``ph-data-train-predict`` 这种），因为查不到对应的中文名，
      各处的兜底逻辑就退化成「显示 id 原文」。实测两处中招：
      顶栏「建议接着练」与学习档案的「继续学习」。

      正确处理是**这些行不出现在界面上**（而不是显示成 id），
      同时**不删库里的行** —— 学生万一回到旧教材，那些记录还在，
      而且「读的时候顺手删数据」是另一类危险的副作用。

    ⚠️ 读不到（kb 缺失/损坏/表不存在）时**调用方应当退化为不过滤**，
      而不是当成空集：空集会把「库读不到」伪装成「这个学生没有学习记录」。
    """
    return {str(row["kp_id"]) for row in conn.execute("SELECT kp_id FROM kp")}


def kp_names(conn: sqlite3.Connection, kp_ids: Iterable[str]) -> dict[str, str]:
    ids = [k for k in kp_ids if k]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT kp_id, name FROM kp WHERE kp_id IN ({placeholders})", ids
    ).fetchall()
    return {str(r["kp_id"]): str(r["name"]) for r in rows}


def kp_meta(
    conn: sqlite3.Connection, kp_ids: Iterable[str]
) -> dict[str, tuple[str, str, str]]:
    """``kp_id → (name, chapter_title, grade_level)``（一次取回，供章节/错题/地图补名）。

    ★ 与 :func:`kp_names` 的分工：那个只要名字（检索引用那类地方够用）；
      这个多带章节与学段 —— 错题本要显示「错在《第4章 用 Python 处理数据》里」，
      学习地图要按章节分组，都需要这三样一起。
    """
    ids = [k for k in dict.fromkeys(kp_ids) if k]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT kp_id, name, chapter_title, grade_level FROM kp WHERE kp_id IN ({placeholders})",
        ids,
    ).fetchall()
    return {
        str(r["kp_id"]): (
            str(r["name"] or ""),
            str(r["chapter_title"] or ""),
            str(r["grade_level"] or ""),
        )
        for r in rows
    }


def chapters_by_grade(
    conn: sqlite3.Connection, grade_level: str
) -> list[dict[str, object]]:
    """按学段列出章节（含每章的 ``kp_ids``，**顺序 = 教材顺序**）。

    ★ 排序是这里的**核心难点**，踩过一次，别改回去：
      - **不能按 ``chapter_title`` 字典序**：中文序号「第10章」的字面排在「第2章」前面；
      - **也不能按 ``MIN(rowid)``**：``kp`` 表的 rowid 是**入库顺序**，而入库顺序是
        *文件名字典序*（``ai-definition-pl`` → ``algorithm-pl`` → …），
        于是小学低年级会排成 ``第1章, 第6章, 第1章, 第3章, …`` 这种乱序（实测过）。
        真正能依赖的只有章节名里的数字。
      - 所以：**解析 ``第N章`` 的 N 排序**；解析不出来的章节名（理论上不会有 ——
        ``library.py`` 的 ``REQUIRED_META`` 强制这个字段存在，但格式未必总是「第N章」）
        统一排到末尾并按名称兜底，保证「同输入同输出」。
    """
    rows = conn.execute(
        "SELECT DISTINCT chapter_title FROM kp WHERE grade_level = ?",
        (grade_level,),
    ).fetchall()
    titles = [str(row["chapter_title"] or "") for row in rows]
    titles.sort(key=_chapter_sort_key)

    chapters: list[dict[str, object]] = []
    for title in titles:
        # 组内按 kp_id 排：同一章的知识点顺序没有教材依据，取字典序至少是**稳定**的
        # （不许用 rowid —— 它随入库顺序变化，同章的 kp 列表会无缘无故重排）。
        members = conn.execute(
            "SELECT kp_id FROM kp WHERE grade_level = ? AND COALESCE(chapter_title, '') = ? "
            "ORDER BY kp_id",
            (grade_level, title),
        ).fetchall()
        chapters.append(
            {
                "chapter_title": title,
                "kp_ids": [str(r["kp_id"]) for r in members],
            }
        )
    return chapters


#: 章节名里的中文序号（``第4章`` → 4）。只认阿拉伯数字：教材标题实测全是这种形态。
_CHAPTER_NUMBER_RE = re.compile(r"^第\s*(\d+)\s*章")


def _chapter_sort_key(title: str) -> tuple[int, int, str]:
    """章节排序键：``(能否解析, 章号, 标题)``。

    解析不出章号的排到最后（第一项为 1），并在同组内按标题字典序 ——
    这样即使教材里混进一个不规范标题，也不会让整份目录的顺序变得不确定。
    """
    match = _CHAPTER_NUMBER_RE.match(title.strip())
    if match:
        return (0, int(match.group(1)), title)
    return (1, 0, title)


def dependency_rows(conn: sqlite3.Connection) -> list[tuple[str, str, str, float]]:
    """全部依赖边：``(from_kp_id, to_kp_id, relation, weight)``。**``from`` 是前置、``to`` 是后继。**

    ★ 用不着递归：``knowledge_dependencies`` 是一张**边表**，全量读出来就是完整的图
      （几十到几百条）。递归 CTE 只在「从一个点向上/下游展开」时才需要
      （见 ``app/knowledge/deps.py`` 的 ``successors`` / ``prerequisites``）。
    """
    rows = conn.execute(
        "SELECT from_kp_id, to_kp_id, relation, weight FROM knowledge_dependencies "
        "ORDER BY from_kp_id, to_kp_id"
    ).fetchall()
    return [
        (
            str(r["from_kp_id"]),
            str(r["to_kp_id"]),
            str(r["relation"] or "prerequisite"),
            float(r["weight"] or 1.0),
        )
        for r in rows
    ]


def kp_ids_by_grade(conn: sqlite3.Connection, grade_level: str) -> list[str]:
    """某学段的全部知识点 id（**按教材定义序**，即 rowid 升序）。"""
    rows = conn.execute(
        "SELECT kp_id FROM kp WHERE grade_level = ? ORDER BY rowid", (grade_level,)
    ).fetchall()
    return [str(r["kp_id"]) for r in rows]


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
    """库规模（报告与汇报要能一行输出）。"""
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
