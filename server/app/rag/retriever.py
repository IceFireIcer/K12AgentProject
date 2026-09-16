"""检索主链路：**四级降级链在一次调用内完成**（关卡 C）。

调用方（Pi 的 ``rag_search`` Tool / 路由）**只调一次** :meth:`RagService.search`，
只读结果里的 ``degraded`` 字段。**不允许**把「先试向量、失败了再试 FTS」这种编排暴露出去 ——
否则同一套降级逻辑要在 TypeScript 里再写一遍（执行文档 §0.2 混合后端边界规则）。

链路（执行文档 §8.5 / 业务陷阱清单 §2）::

    [1] vector  : fastembed 本地查询向量 → sqlite-vec KNN（学段过滤在 SQL 层）
                   └─ 子兜底：sqlite-vec 不可用 → numpy 暴力余弦（仍记 degraded="vector"）
    [2] cloud   : 用户自填的云端 Embedding API（EmbeddingConfig.mode = "cloud_api"）
    [3] fts     : FTS5(trigram) 关键词检索（内置，永不失败；双字词回落 LIKE）
    [4] outline : 依赖图 + 章节大纲直接注入（最后的兜底，保证「有东西可讲」）

★ **学段隔离**：每一条 SQL 都带 ``grade_level`` 过滤，且**只允许不高于学生学段**的内容
（更低学段的内容算「向上兼容」，命中时标 ``compat=true``，前端要显式标注）。
把过滤放到应用层是错的 —— KNN 的 top-k 截断发生在过滤之前，
初中生问高中名词时 top-k 会先被高中块占满，筛完可能一条不剩。
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from app.config import resolve_data_dir
from app.knowledge.deps import EXPANSION_LIMIT, expansion_kp_ids
from app.knowledge.library import compatible_grades
from app.rag import fallback
from app.rag.contracts_bridge import Degraded, RagHit, RagSearchResult
from app.rag.embedder import (
    EmbedderUnavailable,
    LocalEmbedder,
    build_cloud_embedder,
    get_local_embedder,
    read_embedding_config,
)
from app.store import kb as kb_repo
from app.store.connections import DatabaseMissing, connect, vec_available
from app.store.kb import ChunkRecord

logger = logging.getLogger(__name__)

KB_PATH_ENV = "K12_KB_PATH"

DEGRADED_VECTOR: Degraded = "vector"
DEGRADED_CLOUD: Degraded = "cloud"
DEGRADED_FTS: Degraded = "fts"
DEGRADED_OUTLINE: Degraded = "outline"

DEFAULT_TOP_K = 5
# KNN 过采样系数：先多取几条，再按父块去重（一个父块可能有多个子块命中）
KNN_OVERFETCH = 4
# 注入 LLM 的上下文软上限（字符）：再长就截断，避免一次检索吃掉整个上下文窗口
CONTEXT_MAX_CHARS = 6000


@dataclass(frozen=True)
class LevelAttempt:
    """降级链的一级尝试记录（只进日志/轨迹，**不进 HTTP 契约**）。"""

    level: str
    ok: bool
    detail: str = ""
    hits: int = 0


@dataclass
class RetrievalResult:
    """一次检索的完整结果。

    ``hits`` 就是契约里的 :class:`RagHit`（含父块正文），
    ``to_response()`` 组装成 ``POST /api/rag/search`` 的响应体。
    """

    hits: list = field(default_factory=list)
    degraded: Degraded = DEGRADED_VECTOR
    attempts: tuple[LevelAttempt, ...] = ()
    elapsed_ms: float = 0.0
    grade_level: str = ""
    allow_compat: bool = True

    @property
    def levels_tried(self) -> list[str]:
        return [a.level for a in self.attempts]

    @property
    def citations(self) -> list:
        """事件载荷视角（5 字段）—— ``citation`` 事件只准投影这 5 个。"""
        return [hit.model_dump(include=set(CITATION_FIELDS)) for hit in self.hits]

    def to_response(self) -> RagSearchResult:
        return RagSearchResult(
            hits=self.hits,
            context=build_context(self.hits),
            degraded=self.degraded,
        )


# `citation` 事件载荷的冻结字段（投影时必须只取这些，别把整个 hit 塞进事件）
CITATION_FIELDS = ("chunk_id", "chapter_title", "section_title", "grade_level", "compat")


def build_context(hits: Sequence, max_chars: int = CONTEXT_MAX_CHARS) -> str:
    """把命中的父块正文拼成可直接注入 LLM 的上下文。

    带序号与出处（章节 / 小节），方便模型在回答里指出来源，也方便对齐 ``citation`` 事件。
    """
    blocks: list[str] = []
    total = 0
    for idx, hit in enumerate(hits, start=1):
        text = (getattr(hit, "text", "") or "").strip()
        if not text:
            continue
        header = f"[{idx}] {hit.chapter_title} · {hit.section_title}"
        if hit.expanded:
            header += "（前置知识点补充）"
        elif hit.compat:
            header += "（跨学段取用）"
        block = f"{header}\n{text}"
        if total + len(block) > max_chars:
            remain = max_chars - total
            if remain <= 200:  # 剩下的空间装不下什么了，直接停
                break
            block = block[:remain] + "…（已截断）"
        blocks.append(block)
        total += len(block)
    return "\n\n".join(blocks)


def default_kb_path(data_dir: str | Path | None = None) -> Path:
    """``<data-dir>/shared/kb.sqlite``（执行文档 §8.2）。

    ``K12_KB_PATH`` 可覆盖（开发/演示时指向别处的库，例如「故意弄坏」的那一份）。
    """
    override = os.environ.get(KB_PATH_ENV)
    if override:
        return Path(override)
    base = Path(data_dir) if data_dir else resolve_data_dir(None)
    return base / "shared" / "kb.sqlite"


class RagService:
    """一次调用完成四级降级的检索服务（进程内单例，按 kb 路径缓存）。

    连接与嵌入模型都常驻：请求路径上**不做**加载 ONNX、不做建表、不做网络探测。
    """

    def __init__(
        self,
        kb_path: str | Path,
        *,
        embedder: LocalEmbedder | None = None,
        embedding_config: dict[str, str] | None = None,
        data_dir: str | Path | None = None,
        load_vec: bool = True,
    ) -> None:
        self.kb_path = Path(kb_path)
        self.embedder = embedder or get_local_embedder()
        self.embedding_config = (
            embedding_config if embedding_config is not None else read_embedding_config(data_dir)
        )
        self._conn: sqlite3.Connection | None = None
        self._conn_mtime: float = -1.0
        self._vec_ready = False
        self._load_vec = load_vec
        # SQLite 连接不是线程安全的：FastAPI 同步端点跑在线程池里，这里统一串行化
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ 连接 --
    def _ensure_conn(self) -> sqlite3.Connection:
        if self._conn is not None and self.kb_path.exists():
            mtime = self.kb_path.stat().st_mtime
            if mtime == self._conn_mtime:
                return self._conn
            # 库被重建（build_kb 重跑）→ 重开连接，避免读到旧索引
            logger.info("kb.sqlite 已更新，重开连接：%s", self.kb_path)
            self._close()
        if self._conn is None:
            if not self.kb_path.exists():
                raise DatabaseMissing(
                    f"知识库不存在：{self.kb_path}（先跑 uv run python scripts/build_kb.py 建库）"
                )
            conn = connect(self.kb_path, readonly=True, load_vec=self._load_vec)
            self._conn = conn
            self._conn_mtime = self.kb_path.stat().st_mtime
            self._vec_ready = vec_available(conn) if self._load_vec else False
            if not self._vec_ready:
                logger.warning("sqlite-vec 不可用，向量路径将走 numpy 暴力余弦兜底")
        return self._conn

    def _close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except sqlite3.Error:  # pragma: no cover
                pass
        self._conn = None
        self._vec_ready = False
        self._conn_mtime = -1.0

    def close(self) -> None:
        self._close()

    # --------------------------------------------------------------- 主入口 --
    def search(
        self,
        *,
        query: str,
        grade_level: str,
        top_k: int = DEFAULT_TOP_K,
        allow_compat: bool = True,
        include_expansion: bool = True,
    ) -> RetrievalResult:
        """**唯一入口**：一次调用跑完整条降级链。

        :param grade_level: 学生当前学段（**显式选择为准**；自动推断只写建议）。
        :param allow_compat: 允许「向上兼容」取用**更低学段**的内容（命中标 ``compat=true``）。
            **无论开关如何，都不会返回更高学段的内容** —— 关卡 C 的判据是
            「初中提问不得返回高中 chunk」，超纲没有「可选」这一说。
        """
        started = time.perf_counter()
        attempts: list[LevelAttempt] = []
        allowed = compatible_grades(grade_level) if allow_compat else [grade_level]
        top_k = max(1, min(int(top_k), 20))

        try:
            conn = self._ensure_conn()
        except DatabaseMissing as exc:
            # 库都没建：不要抛给调用方（编排层不该处理数据层的部署问题），
            # 返回空结果 + outline 级别，日志里说清原因。
            logger.warning("检索跳过：%s", exc)
            return RetrievalResult(
                hits=[],
                degraded=DEGRADED_OUTLINE,
                attempts=(LevelAttempt(DEGRADED_OUTLINE, False, str(exc)),),
                elapsed_ms=(time.perf_counter() - started) * 1000,
                grade_level=grade_level,
                allow_compat=allow_compat,
            )

        with self._lock:
            hits: list[fallback.Hit] = []
            degraded: Degraded = DEGRADED_OUTLINE

            # ---------------- [1] vector ----------------
            hits, attempt = self._try_vector(conn, query, allowed, grade_level, top_k)
            attempts.append(attempt)
            if hits:
                degraded = DEGRADED_VECTOR
            else:
                # ---------------- [2] cloud ----------------
                hits, attempt = self._try_cloud(conn, query, allowed, grade_level, top_k)
                attempts.append(attempt)
                if hits:
                    degraded = DEGRADED_CLOUD
                else:
                    # ---------------- [3] fts ----------------
                    hits, attempt = self._try_fts(conn, query, allowed, grade_level, top_k)
                    attempts.append(attempt)
                    if hits:
                        degraded = DEGRADED_FTS
                    else:
                        # ---------------- [4] outline ----------------
                        hits, attempt = self._try_outline(conn, allowed, grade_level, top_k)
                        attempts.append(attempt)
                        degraded = DEGRADED_OUTLINE

            hits = self._to_hits(conn, hits, degraded, grade_level, top_k)
            if include_expansion and degraded != DEGRADED_OUTLINE:
                hits.extend(self._expand(conn, hits, allowed, grade_level, degraded))

        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info(
            "检索完成：级别=%s 命中=%d 用时=%.1fms（尝试：%s）",
            degraded,
            len(hits),
            elapsed_ms,
            "; ".join(f"{a.level}:{'ok' if a.ok else 'skip'}" for a in attempts),
        )
        return RetrievalResult(
            hits=hits,
            degraded=degraded,
            attempts=tuple(attempts),
            elapsed_ms=elapsed_ms,
            grade_level=grade_level,
            allow_compat=allow_compat,
        )

    # ------------------------------------------------------------- 各级实现 --
    def _try_vector(
        self, conn, query: str, allowed: Sequence[str], requested: str, top_k: int
    ) -> tuple[list[fallback.Hit], LevelAttempt]:
        try:
            query_vec = self.embedder.embed_query(query)
        except EmbedderUnavailable as exc:
            return [], LevelAttempt(DEGRADED_VECTOR, False, f"本地嵌入不可用：{exc}")

        if self._vec_ready:
            try:
                rows = kb_repo.knn_rows(conn, query_vec, allowed, k=top_k * KNN_OVERFETCH)
            except sqlite3.Error as exc:
                # 向量表坏了/扩展失效：本次及后续走 numpy，但**级别仍是 vector**
                self._vec_ready = False
                logger.warning("sqlite-vec KNN 失败，改用 numpy 暴力余弦：%s", exc)
            else:
                hits = self._rows_to_hits(conn, rows, requested, top_k)
                if hits:
                    return hits, LevelAttempt(
                        DEGRADED_VECTOR, True, "sqlite-vec KNN", len(hits)
                    )
                return [], LevelAttempt(DEGRADED_VECTOR, False, "sqlite-vec KNN 无命中（学段内无内容？）")

        try:
            hits = fallback.numpy_cosine_search(
                conn,
                query_vec=query_vec,
                grade_levels=allowed,
                requested_grade=requested,
                top_k=top_k,
            )
        except Exception as exc:  # noqa: BLE001 - 兜底路径不允许把异常抛给调用方
            return [], LevelAttempt(DEGRADED_VECTOR, False, f"numpy 兜底失败：{exc}")
        if hits:
            return hits, LevelAttempt(DEGRADED_VECTOR, True, "numpy 暴力余弦兜底", len(hits))
        return [], LevelAttempt(DEGRADED_VECTOR, False, "numpy 兜底无命中")

    def _try_cloud(
        self, conn, query: str, allowed: Sequence[str], requested: str, top_k: int
    ) -> tuple[list[fallback.Hit], LevelAttempt]:
        cloud = build_cloud_embedder(self.embedding_config)
        if cloud is None:
            return [], LevelAttempt(DEGRADED_CLOUD, False, "未配置云端嵌入（mode != cloud_api）")
        try:
            query_vec = cloud.embed_query(query)
        except EmbedderUnavailable as exc:
            return [], LevelAttempt(DEGRADED_CLOUD, False, f"云端嵌入不可用：{exc}")
        try:
            hits = fallback.numpy_cosine_search(
                conn,
                query_vec=query_vec,
                grade_levels=allowed,
                requested_grade=requested,
                top_k=top_k,
            )
        except Exception as exc:  # noqa: BLE001
            return [], LevelAttempt(DEGRADED_CLOUD, False, f"云端向量检索失败：{exc}")
        return hits, LevelAttempt(DEGRADED_CLOUD, bool(hits), "云端嵌入 + 向量检索", len(hits))

    def _try_fts(
        self, conn, query: str, allowed: Sequence[str], requested: str, top_k: int
    ) -> tuple[list[fallback.Hit], LevelAttempt]:
        try:
            hits = fallback.fts_search(
                conn,
                query=query,
                grade_levels=allowed,
                requested_grade=requested,
                top_k=top_k,
            )
        except sqlite3.Error as exc:
            return [], LevelAttempt(DEGRADED_FTS, False, f"FTS5 不可用：{exc}")
        return hits, LevelAttempt(DEGRADED_FTS, bool(hits), "FTS5 trigram", len(hits))

    def _try_outline(
        self, conn, allowed: Sequence[str], requested: str, top_k: int
    ) -> tuple[list[fallback.Hit], LevelAttempt]:
        try:
            hits = fallback.outline_search(
                conn,
                grade_levels=allowed,
                requested_grade=requested,
                top_k=top_k,
            )
        except sqlite3.Error as exc:
            return [], LevelAttempt(DEGRADED_OUTLINE, False, f"大纲读取失败：{exc}")
        return hits, LevelAttempt(DEGRADED_OUTLINE, bool(hits), "章节大纲兜底", len(hits))

    # --------------------------------------------------------------- 组装 --
    def _rows_to_hits(
        self, conn, rows: Sequence[sqlite3.Row], requested: str, top_k: int
    ) -> list[fallback.Hit]:
        """vec0 的 ``(rowid, distance)`` → Hit。

        单位向量下 vec0 的 L2 距离与余弦可换算：``cos = 1 - d²/2``
        （已实测：同向量 d=0、反向向量 d=2）。
        """
        if not rows:
            return []
        by_rowid = kb_repo.chunks_by_rowids(conn, [int(r["rowid"]) for r in rows])
        hits: list[fallback.Hit] = []
        for row in rows:
            rec = by_rowid.get(int(row["rowid"]))
            if rec is None:
                continue
            cos = 1.0 - (float(row["distance"]) ** 2) / 2.0
            hits.append(
                fallback.Hit(
                    chunk=rec,
                    score=round(max(0.0, min(1.0, cos)), 4),
                    compat=rec.grade_level != requested,
                    level=DEGRADED_VECTOR,
                )
            )
        hits.sort(key=lambda h: -h.score)
        return hits[:top_k]

    def _to_hits(
        self,
        conn,
        hits: Sequence[fallback.Hit],
        degraded: Degraded,
        requested: str,
        top_k: int,
    ) -> list[RagHit]:
        """命中子块 → **父块完整内容** → ``RagHit``（同一父块只保留最高分的一条）。"""
        if not hits:
            return []
        ordered = sorted(hits, key=lambda h: -h.score)
        parent_texts = kb_repo.parent_text_map(conn, [h.chunk.chunk_id for h in ordered])
        names = kb_repo.kp_names(conn, [h.chunk.knowledge_point for h in ordered])

        out: list[RagHit] = []
        seen: set[str] = set()
        for hit in ordered:
            rec: ChunkRecord = hit.chunk
            key = rec.parent_chunk_id or rec.chunk_id  # 去重按父块：一个父块命中多次只留一条
            if key in seen:
                continue
            seen.add(key)
            out.append(
                RagHit(
                    chunk_id=rec.chunk_id,
                    chapter_title=rec.chapter_title,
                    section_title=rec.section_title,
                    grade_level=rec.grade_level,
                    compat=hit.compat,
                    parent_chunk_id=rec.parent_chunk_id,
                    text=parent_texts.get(rec.chunk_id, rec.text),
                    knowledge_point=names.get(rec.knowledge_point, rec.knowledge_point),
                    kp_id=rec.knowledge_point,
                    score=hit.score,
                    degraded=degraded,
                    expanded=hit.expanded,
                )
            )
            if len(out) >= top_k:
                break
        return out

    def _expand(
        self,
        conn,
        hits: Sequence[RagHit],
        allowed: Sequence[str],
        requested: str,
        degraded: Degraded,
    ) -> list[RagHit]:
        """用途二：把命中的知识点的**前置知识点**内容补进上下文（**有上限**）。

        上限（``EXPANSION_LIMIT``）是硬要求：前置内容只是补充，
        让它挤满 top-k 会把真正命中的内容顶掉（业务陷阱清单 §3 第 4 条）。
        """
        kp_ids = [h.kp_id for h in hits if h.kp_id]
        if not kp_ids:
            return []
        try:
            extra_kp_ids = expansion_kp_ids(
                conn, kp_ids, grade_levels=allowed, limit=EXPANSION_LIMIT
            )
        except Exception as exc:  # noqa: BLE001 - 扩展失败不影响主检索结果
            logger.warning("依赖图扩展失败（不影响主结果）：%s", exc)
            return []
        present = set(kp_ids)
        extra_kp_ids = [k for k in extra_kp_ids if k not in present]
        if not extra_kp_ids:
            return []

        records = kb_repo.chunks_for_kps(conn, extra_kp_ids, allowed, per_kp=1)
        names = kb_repo.kp_names(conn, extra_kp_ids)
        out: list[RagHit] = []
        for rec in records:
            out.append(
                RagHit(
                    chunk_id=rec.chunk_id,
                    chapter_title=rec.chapter_title,
                    section_title=rec.section_title,
                    grade_level=rec.grade_level,
                    compat=rec.grade_level != requested,
                    parent_chunk_id=rec.parent_chunk_id,
                    text=rec.text,  # 已经是节级父块
                    knowledge_point=names.get(rec.knowledge_point, rec.knowledge_point),
                    kp_id=rec.knowledge_point,
                    score=0.0,  # 不是相似度命中，是依赖图补充
                    degraded=degraded,
                    expanded=True,
                )
            )
        if out:
            logger.debug("依赖图扩展：%s", [c.kp_id for c in out])
        return out


# --------------------------------------------------------------------------- #
# 进程内单例（一个 kb 路径一个服务）
# --------------------------------------------------------------------------- #
_SERVICES: dict[str, RagService] = {}
_SERVICE_LOCK = threading.Lock()


def get_service(
    kb_path: str | Path | None = None,
    *,
    data_dir: str | Path | None = None,
    embedder=None,
    force_new: bool = False,
) -> RagService:
    """取（或建）进程内单例服务。

    ``embedder`` / ``force_new`` 是给单测与排障用的注入口：
    可以让路由跑在夹具嵌入器上，不必加载真实模型。
    """
    path = Path(kb_path) if kb_path else default_kb_path(data_dir)
    key = str(path).lower()
    with _SERVICE_LOCK:
        service = _SERVICES.get(key)
        if service is None or force_new:
            if service is not None:
                service.close()
            service = RagService(path, embedder=embedder, data_dir=data_dir)
            _SERVICES[key] = service
        return service


def reset_services() -> None:
    """关掉全部缓存的服务（单测/换库时用）。"""
    with _SERVICE_LOCK:
        for service in _SERVICES.values():
            service.close()
        _SERVICES.clear()


def search(
    *,
    query: str,
    grade_level: str,
    top_k: int = DEFAULT_TOP_K,
    allow_compat: bool = True,
    include_expansion: bool = True,
    kb_path: str | Path | None = None,
    data_dir: str | Path | None = None,
) -> RetrievalResult:
    """便捷入口（内部就是 :meth:`RagService.search`，仍然只跑一次降级链）。"""
    return get_service(kb_path, data_dir=data_dir).search(
        query=query,
        grade_level=grade_level,
        top_k=top_k,
        allow_compat=allow_compat,
        include_expansion=include_expansion,
    )


__all__ = [
    "CONTEXT_MAX_CHARS",
    "CITATION_FIELDS",
    "DEFAULT_TOP_K",
    "DEGRADED_CLOUD",
    "DEGRADED_FTS",
    "DEGRADED_OUTLINE",
    "DEGRADED_VECTOR",
    "KB_PATH_ENV",
    "LevelAttempt",
    "RagService",
    "RetrievalResult",
    "build_context",
    "default_kb_path",
    "get_service",
    "reset_services",
    "search",
]
