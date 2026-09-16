"""降级链的 3/4 级：FTS5 关键词检索 + numpy 暴力余弦 + 章节大纲兜底。

**为什么必须实现 FTS5**（执行文档 §8.5）：即便 fastembed 随包分发，
也可能因模型文件损坏 / 内存不足 / 向量扩展没打进去而失败。
FTS5 内置于 SQLite，**永不失败**。

★ 两个中文相关的坑（业务陷阱清单 §2）：

1. ``tokenize='trigram'`` —— 默认分词器把整段中文当一个 token，等于不可检索。
2. **trigram 的最小匹配长度是 3 个字符**：``MATCH '"循环"'`` 返回空集。
   而学生的提问大量是「循环」「变量」这种**双字词**，
   所以短词必须回落到 ``LIKE '%循环%'`` 扫描 —— 只做 FTS 的实现在演示时会「什么都没搜到」。
   这条已实测确认（sqlite 3.45.3 / fts5 trigram）。

第 1 级内部的子兜底（numpy 暴力余弦）也在这里：sqlite-vec 加载失败时用它，
**仍然算 ``degraded="vector"``** —— 因为向量是真的算过了，只是引擎换了。
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from app.store.kb import CHUNK_COLUMNS, ChunkRecord, embeddings_by_grade, l2_normalize, outline_chunks

logger = logging.getLogger(__name__)

# FTS5 trigram 的最小匹配长度（实测：少于 3 个字符匹配不到任何行）
TRIGRAM_MIN_CHARS = 3

# FTS 命中的最低词条覆盖率（≈1/3）：整句提问被拆成多个 n-gram 后，
# 「只蒙中一个二字片段」的块不该被当成命中 —— 关键词兜底返回一堆不相干的片段，
# 比返回空更糟（模型会把它当教材讲）。达不到就把这一级判为未命中，继续降级到大纲。
# 取 1/3 而不是更高：学生整句提问时（「循环里怎么累加总分」拆成 6 个词条），
# 命中其中 2 个（循环 + 累加）就已经是可靠的相关片段，不该被判掉。
MIN_FTS_COVERAGE = 0.33

_CJK_RUN = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]+")
_LATIN = re.compile(r"[A-Za-z0-9_]+")

# 提问里的疑问/语气成分：不删掉的话，「什么是循环」会变成一个 5 字词条，
# 关键词检索直接废掉（中文没有分词器，只能靠这种低成本启发式）。
_QUESTION_PREFIXES = (
    "请问",
    "告诉我",
    "解释一下",
    "什么叫",
    "什么是",
    "是什么",
    "为什么",
    "怎么样",
    "怎么办",
    "如何",
    "怎么",
    "什么",
)
_QUESTION_SUFFIXES = ("呢", "吗", "吧", "呀", "啊", "的")

# 长句拆词用的虚词字符：含这些字的二字/三字片段不可能是关键词（怎么 / 里怎 / 环里），
# 全部丢掉可显著降低噪声匹配。
_STOP_CHARS = set("的了是吗呢吧呀啊么怎里最会要有你我他它这那和与在到把被让给为就又都也就很")
# 中文连续片段超过这个长度就要拆 n-gram（否则整句当一个词，永远匹配不上）
CJK_MAX_TERM_CHARS = 4


@dataclass(frozen=True)
class Hit:
    """一条命中（**命中的是子块**，父块由检索链解析后再注入 LLM）。"""

    chunk: ChunkRecord
    score: float  # 越大越相关，0..1
    compat: bool  # true = 该条来自比学生学段更低的学段（向上兼容命中）
    level: str  # vector | cloud | fts | outline
    expanded: bool = False  # true = 依赖图补充的前置知识点（不是直接命中）


def query_terms(query: str) -> list[str]:
    """把自然语言提问切成关键词条（无分词器时的低成本方案）。

    - 先剥掉疑问/语气成分（「什么是循环」→「循环」）；
    - 中文连续片段 ≤4 字整体作一个词条（「循环」「梯度下降」）；
    - **更长的片段拆成 2/3 字 n-gram**，并丢掉含虚词的片段。
      这一步是必需的：学生常常整句提问（「循环里怎么累加总分」），
      若不拆，整句会被当成一个 14 字词条 —— trigram 的 FTS 与 LIKE 都匹配不到任何东西，
      「FTS 永不失败」的兜底就变成了「FTS 永远返回空」。

    这是**兜底路径**的分词策略，不追求语言学分词的准确性：
    目标是「整句提问也能找回相关内容」，而不是「切出唯一正确的词」。
    """
    text = query.strip()
    for prefix in _QUESTION_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix) :]
            break
    for suffix in _QUESTION_SUFFIXES:
        if text.endswith(suffix) and len(text) > len(suffix) + 1:
            text = text[: -len(suffix)]
            break

    terms: list[str] = []
    for match in re.finditer(r"[\u4e00-\u9fff\u3400-\u4dbf]+|[A-Za-z0-9_]+", text):
        token = match.group(0).strip()
        if len(token) < 2:
            continue
        if len(token) <= CJK_MAX_TERM_CHARS or not _is_cjk(token[0]):
            # 短词条与拉丁/数字词条整体使用（英文单词不做 n-gram 切分）
            terms.append(token)
            continue
        # 长片段：拆 3-gram（给 FTS）与 2-gram（给 LIKE），丢掉含虚词的碎片
        fragments: list[str] = []
        for size in (3, 2):
            for i in range(len(token) - size + 1):
                fragment = token[i : i + size]
                if any(ch in _STOP_CHARS for ch in fragment):
                    continue
                fragments.append(fragment)
        terms.extend(fragments or [token])

    # 去重但保序
    seen: set[str] = set()
    out: list[str] = []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _is_cjk(ch: str) -> bool:
    return "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf"


def _coverage(text: str, terms: Sequence[str]) -> float:
    if not terms:
        return 0.0
    hit = sum(1 for t in terms if t in text)
    return hit / len(terms)


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _rows_to_hits(
    rows: Sequence[sqlite3.Row],
    *,
    terms: Sequence[str],
    requested_grade: str,
    level: str,
    top_k: int,
    min_coverage: float = 0.0,
) -> list[Hit]:
    scored: list[tuple[float, int, Hit]] = []
    for row in rows:
        rec = ChunkRecord.from_row(row)
        coverage = _coverage(rec.text, terms) if terms else 0.0
        if coverage < min_coverage:
            continue
        # 排序键：命中词条覆盖率优先；同覆盖率时**短块优先**（更聚焦，
        # 也避免长篇泛泛而谈的块把精确的小块挤下去）。sqlite3.Row 无 getattr 语义。
        scored.append(
            (
                coverage,
                -rec.token_count,
                Hit(
                    chunk=rec,
                    score=round(float(coverage), 4),
                    compat=rec.grade_level != requested_grade,
                    level=level,
                ),
            )
        )
    scored.sort(key=lambda item: (-item[0], -item[1]))
    return [hit for _, _, hit in scored[:top_k]]


# --------------------------------------------------------------------------- #
# [3] FTS5（trigram）
# --------------------------------------------------------------------------- #
def fts_search(
    conn: sqlite3.Connection,
    *,
    query: str,
    grade_levels: Sequence[str],
    requested_grade: str,
    top_k: int,
) -> list[Hit]:
    """FTS5 trigram 关键词检索（长词走 MATCH，双字词走 LIKE）。

    **学段过滤写在 SQL 的 WHERE 里**（不是应用层筛）—— 与向量路径同一条纪律。
    """
    if not grade_levels:
        return []
    terms = query_terms(query)
    if not terms:
        return []
    placeholders = ",".join("?" * len(grade_levels))

    long_terms = [t for t in terms if len(t) >= TRIGRAM_MIN_CHARS]
    rows: list[sqlite3.Row] = []
    if long_terms:
        match_expr = " OR ".join('"' + t.replace('"', '""') + '"' for t in long_terms)
        sql = (
            f"SELECT {', '.join('c.' + col for col in CHUNK_COLUMNS.split(', '))} "
            "FROM chunk_fts f JOIN chunk c ON c.rowid = f.rowid "
            f"WHERE chunk_fts MATCH ? AND c.is_parent = 0 AND c.grade_level IN ({placeholders}) "
            "ORDER BY bm25(chunk_fts) LIMIT ?"
        )
        try:
            rows = conn.execute(
                sql, (match_expr, *grade_levels, max(top_k * 4, 12))
            ).fetchall()
        except sqlite3.Error as exc:
            logger.warning("FTS5 MATCH 失败，回落 LIKE：%s", exc)
            rows = []

    if not rows:
        # ★ 双字词（循环/变量/函数）与 trigram 不足 3 字符的情况走这里。
        where = " OR ".join(f"c.text LIKE ? ESCAPE '\\'" for _ in terms)
        sql = (
            f"SELECT {CHUNK_COLUMNS} FROM chunk c "
            f"WHERE c.is_parent = 0 AND c.grade_level IN ({placeholders}) AND ({where}) "
            "ORDER BY c.token_count ASC LIMIT ?"
        )
        params = [*grade_levels, *[f"%{_escape_like(t)}%" for t in terms], max(top_k * 8, 24)]
        rows = conn.execute(sql, params).fetchall()

    hits = _rows_to_hits(
        rows,
        terms=terms,
        requested_grade=requested_grade,
        level="fts",
        top_k=top_k,
        min_coverage=MIN_FTS_COVERAGE,
    )
    logger.debug("FTS5 命中 %d 条（terms=%s）", len(hits), terms)
    return hits


# --------------------------------------------------------------------------- #
# [1b] numpy 暴力余弦（sqlite-vec 不可用时的子兜底）
# --------------------------------------------------------------------------- #
def numpy_cosine_search(
    conn: sqlite3.Connection,
    *,
    query_vec: "np.ndarray",
    grade_levels: Sequence[str],
    requested_grade: str,
    top_k: int,
) -> list[Hit]:
    """全量暴力余弦。几千个 512 维 chunk 是**毫秒级**的，没必要为它上索引。

    向量从 ``chunk.embedding`` BLOB 读（小端 '<f4'），不依赖任何扩展，
    因此 sqlite-vec 的 .dll 没打进去时这条路仍然可用。
    """
    rows, matrix = embeddings_by_grade(conn, grade_levels)
    if not rows or matrix.size == 0:
        return []
    q = l2_normalize(query_vec).astype(np.float32)
    if q.shape[0] != matrix.shape[1]:
        logger.warning("查询向量维度 %s 与库内 %s 不符，跳过 numpy 兜底", q.shape[0], matrix.shape[1])
        return []

    sims = matrix @ q
    order = np.argsort(-sims)[:top_k]
    hits: list[Hit] = []
    for idx in order:
        rec = ChunkRecord.from_row(rows[int(idx)])
        hits.append(
            Hit(
                chunk=rec,
                score=round(max(0.0, float(sims[int(idx)])), 4),
                compat=rec.grade_level != requested_grade,
                level="vector",
            )
        )
    return hits


# --------------------------------------------------------------------------- #
# [4] 大纲/依赖图兜底
# --------------------------------------------------------------------------- #
def outline_search(
    conn: sqlite3.Connection,
    *,
    grade_levels: Sequence[str],
    requested_grade: str,
    top_k: int,
) -> list[Hit]:
    """最后的兜底：直接把该学段的节级块（大纲）当上下文注入。

    **它不是「检索结果」而是「可讲的内容范围」**，所以 score 记 0：
    与其让模型在无检索的情况下胡编，不如明确告诉它「只讲这些节」。
    """
    hits = [
        Hit(
            chunk=rec,
            score=0.0,
            compat=rec.grade_level != requested_grade,
            level="outline",
        )
        for rec in outline_chunks(conn, grade_levels, limit=max(top_k, 5))
    ]
    return hits[:top_k]


__all__ = [
    "Hit",
    "TRIGRAM_MIN_CHARS",
    "fts_search",
    "numpy_cosine_search",
    "outline_search",
    "query_terms",
]
