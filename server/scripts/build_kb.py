#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一键建知识库：教材 Markdown → ``kb.sqlite``（chunk + 向量 + FTS5 + 依赖图）。

用法::

    cd server
    uv run python scripts/build_kb.py                # 建到 <data-dir>/shared/kb.sqlite
    uv run python scripts/build_kb.py --out tmp/kb.sqlite
    uv run python scripts/build_kb.py --audit-only   # 只跑学段错位自检

**幂等**：每次先清表再写，连续跑两次 chunk 行数完全相同（业务陷阱清单 §2 第 7 条）。
不清表就重跑的话，调试期数据会翻倍，检索结果里会出现一堆重复条目，
而且「为什么有两条一模一样的 citation」这个问题能查很久。

**原子**：清表 → 写正文 → 重建 FTS → 写依赖图 属于**同一个事务**，只在全部成功时提交一次。
失败（依赖清单有悬空引用、重建途中关掉应用）必须留下**重建前那一份完整库**，
而不是「chunk 清了、FTS 索引空了、依赖图没了」的半成品 —— 后者看起来只是一句
「重建失败」，实际上 FTS 兜底级已经静默变成 0 命中、推荐路径与学习地图同时失效
（为什么必须这样、代价是什么，见 :func:`build` 里的那段注释）。

**模型缺失直接报错**，不静默产出空向量：没有向量的知识库会让检索一路降级到 FTS，
表面上「还能用」，实际上主路径从没被验证过 —— 这种「看起来正常」最危险。
真要只建 FTS（例如排障），显式加 ``--no-vectors``。
"""

from __future__ import annotations

import argparse
import logging
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import EMBEDDING_DIM, KNOWLEDGE_DIR, resolve_data_dir  # noqa: E402
from app.console import install_utf8_stdio  # noqa: E402
from app.knowledge import checker  # noqa: E402
from app.knowledge.deps import DepEdge, insert_dependencies, invalidate_cache  # noqa: E402
from app.knowledge.library import (  # noqa: E402
    KnowledgeDoc,
    load_library,
    load_manifest,
    load_terminology,
)
from app.rag import chunker  # noqa: E402
from app.rag.chunker import ChunkDraft  # noqa: E402
from app.rag.embedder import LocalEmbedder, model_files_present, resolve_model_dir  # noqa: E402
from app.store import kb as kb_repo  # noqa: E402
from app.store.connections import connect  # noqa: E402
from app.store.kb import KpRecord  # noqa: E402
from app.store.migrations import ensure_kb  # noqa: E402

install_utf8_stdio()

logger = logging.getLogger("build_kb")

# 与检索侧使用同一批向量：**只给子块建索引**（父块留给「命中后取上下文」用）
EMBED_BATCH = 32


class BuildError(RuntimeError):
    """建库前置条件不满足（模型缺失 / 教材格式错 / 依赖图有环等）。"""


@dataclass
class BuildResult:
    kb_path: Path
    stats: dict[str, int]
    tokens: dict[str, float | int]
    audit: checker.AuditReport
    docs: int = 0
    edges: int = 0
    elapsed_ms: float = 0.0
    notes: list[str] = field(default_factory=list)


def _insert_documents(conn, docs: list[KnowledgeDoc], drafts: list[ChunkDraft], embedder) -> int:
    """写 ``kp`` + ``chunk`` + ``chunk_vec``（父块先写，子块随后，顺序稳定）。

    ★ **本函数不提交事务**：它只是「整库重建」这一个事务里的一段（见 :func:`build`）。
    在这里提前 ``commit`` 会把「清表」永久落盘，于是后面任何一步失败（依赖图有悬空引用、
    重建到一半关掉应用）都会留下半成品库 —— 那时 ``chunk`` 是新的、``chunk_fts``
    索引是空的（外部内容表，``DELETE`` 正文后不重建索引就永久不一致）、依赖图为空。
    """
    kp_ids: set[str] = set()
    for doc in docs:
        kb_repo.insert_kp(
            conn,
            KpRecord(
                kp_id=doc.kp_id,
                grade_level=doc.grade_level,
                name=doc.knowledge_point,
                chapter_title=doc.chapter_title,
                section_title=doc.section_title,
                summary=doc.summary,
            ),
        )
        kp_ids.add(doc.kp_id)

    children = [d for d in drafts if not d.is_parent]
    vectors = None
    if embedder is not None and children:
        vectors = embedder.embed_documents([d.text for d in children])

    child_index = 0
    for draft in drafts:
        embedding = None
        if not draft.is_parent and vectors is not None:
            embedding = vectors[child_index]
            child_index += 1
        kb_repo.insert_chunk(
            conn,
            chunk_id=draft.chunk_id,
            text=draft.text,
            grade_level=draft.grade_level,
            chapter_title=draft.chapter_title,
            section_title=draft.section_title,
            knowledge_point=draft.knowledge_point,
            content_type=draft.content_type,
            token_count=draft.token_count,
            parent_chunk_id=draft.parent_chunk_id,
            is_parent=draft.is_parent,
            embedding=embedding,
        )
    return len(kp_ids)


def build(
    knowledge_dir: str | Path = KNOWLEDGE_DIR,
    kb_path: str | Path | None = None,
    *,
    embedder=None,
    counter=None,
    strict_terms: bool = True,
    require_vectors: bool = True,
    vec_ready: bool | None = None,
    print_report: bool = True,
) -> BuildResult:
    """建库主流程（可被单测直接调用）。

    ``require_vectors=False`` 是**排障开关**：只建 FTS 与大纲，检索会一路降级。
    正常路径必须带向量 —— 没验证过主路径的库不算建好。
    """
    started = time.perf_counter()
    knowledge_dir = Path(knowledge_dir)
    kb_path = Path(kb_path) if kb_path else resolve_data_dir(None) / "shared" / "kb.sqlite"

    # ------------------------------------------------------------------ 教材 --
    docs = load_library(knowledge_dir)
    if not docs:
        raise BuildError(f"{knowledge_dir} 下没有任何知识点 Markdown")
    counter = counter or None
    note_counter = ""
    if counter is None:
        counter, note_counter = chunker.resolve_token_counter(resolve_model_dir())

    # ------------------------------------------------- 学段错位自检（术语文表） --
    audit = checker.audit_library(docs, load_terminology(knowledge_dir))
    if print_report:
        print(checker.format_report(audit))
    if not audit.ok and strict_terms:
        raise BuildError(
            f"教材学段错位自检未通过（{len(audit.violations)} 处）。"
            "修内容或显式加 --lenient-terms（不推荐：超纲与错位语气会一路带到学生面前）"
        )

    # ------------------------------------------------------------------ 向量 --
    notes: list[str] = []
    if embedder is not None:
        if not getattr(embedder, "available", True):
            raise BuildError("嵌入模型不可用（模型文件缺失？先跑 scripts/fetch_embedding_model.py）")
    elif model_files_present():
        embedder = LocalEmbedder()
        embedder.warmup()
    elif require_vectors:
        raise BuildError(
            f"嵌入模型缺失：{resolve_model_dir()}。先跑 uv run python scripts/fetch_embedding_model.py；"
            "确实只要建 FTS（排障用）就加 --no-vectors"
        )
    else:
        notes.append("已按 --no-vectors 建库：无向量，检索只能走 FTS/大纲降级")

    # ---------------------------------------------------------------- 分块 --
    drafts = chunker.chunk_library(docs, counter)
    tokens = chunker.token_report(drafts)
    if not drafts:
        raise BuildError("分块结果为空（检查 Markdown 是否有 `## ` 小节）")

    # ---------------------------------------------------------------- 写库 --
    conn = connect(kb_path, load_vec=False)
    try:
        if vec_ready is None:
            from app.store.connections import load_sqlite_vec, vec_available

            try:
                load_sqlite_vec(conn)
            except Exception as exc:  # noqa: BLE001
                notes.append(f"sqlite-vec 不可用（本次不建 chunk_vec）：{exc}")
                if kb_repo.table_exists(conn, "chunk_vec"):
                    # 库里有 vec0 表但扩展加载不了 → 那张表**清不掉**（见
                    # store/kb.py 的 _clear_vec_table），旧向量行会留在原地。
                    # 本次重建因此不写向量，检索走 numpy 兜底（正文完好）。
                    # 要消除残留：扩展恢复可用后**再重建一次**即可（正常路径会先清后写）。
                    notes.append(
                        "提示：库内已有的 chunk_vec 本轮未能清空（扩展不可用），"
                        "其中可能残留上一版向量；sqlite-vec 恢复后请再重建一次。"
                    )
            vec_ready = vec_available(conn)

        ensure_kb(conn, dim=EMBEDDING_DIM, vec_ready=bool(vec_ready))
        # ------------------------------------------------------------------ 事务 --
        # ★★ 下面四步是**一个事务**，且只在全部成功时提交一次。
        # 为什么非这样不可：SQLite 的 ``DELETE`` 一旦提交就撤不回来。若在清表之后、
        # 写依赖图之前提交过（旧实现是 _insert_documents 末尾那次 commit），
        # 「依赖清单里有一条悬空引用」（有意报错中止）或「重建到一半关掉应用」
        # （before-quit 走 taskkill /PID /T /F，线程池里的重建被直接掐断）
        # 都会留下半成品库：chunk 被清空 → chunk_fts 这个**外部内容表**的索引
        # 与正文永久不一致（空索引）→ 依赖图为空。
        # 后果是 FTS5 兜底级静默变成 0 命中、检索扩展 / 推荐路径 / 学习地图同时失效，
        # 而 /api/knowledge/rebuild 只回一句「重建失败」—— 学生与老师都看不出
        # 旧内容已经被改坏（实测：真实随包库 MATCH "人工智能" 从 99 掉到 0、
        # 依赖边从 483 掉到 0，而 rebuild 的回执只有 ok=false）。
        #
        # 代价（有意接受，不要试图优化掉）：全量重建期间整库对外不可见 ——
        # 别的连接读到的是提交前的那一份旧内容（不会读到半成品），且日志
        # （WAL / 回滚日志）会随写入量变大（教材规模下是 MB 量级）。
        # 「要么整体成功、要么完整退回旧库」值这个价；这也正是不做断点续跑的原因
        # （脚本的设计就是「先清再写」整体幂等，一次不成下次整个重来）。
        kb_repo.clear_knowledge_tables(conn)  # ★ 幂等：先清再写
        _insert_documents(conn, docs, drafts, embedder)
        kb_repo.rebuild_fts(conn)  # 外部内容表：写完正文后重建索引

        manifest = load_manifest(knowledge_dir)
        edges = [
            DepEdge(
                from_kp_id=e.from_kp_id,
                to_kp_id=e.to_kp_id,
                relation=e.relation,
                weight=e.weight,
            )
            for e in manifest.dependencies
        ]
        # ★ 悬空引用 / 有环 → 直接抛异常并中止（不静默跳过）；此时上面的清表与写入
        #   都还没提交，异常路径会把整库退回重建前那一份。
        insert_dependencies(conn, edges)
        conn.commit()  # ★ 全程唯一一次提交
        stats = kb_repo.stats(conn)
    except BaseException:
        # 显式回滚。**不依赖 close() 的隐式回滚**：那是驱动的实现细节，而这里正是
        # 「原子性」的落点 —— 读代码的人必须一眼看得见失败路径发生了什么。
        try:
            conn.rollback()
        except sqlite3.Error:
            # 连接已经不可用时，不要用一个新异常把原始错误盖掉：
            # 真正要报给用户的是「重建为什么失败」。
            logger.warning("回滚重建事务失败（连接已不可用），原异常继续向上抛", exc_info=True)
        raise
    finally:
        conn.close()
    invalidate_cache(kb_path)

    result = BuildResult(
        kb_path=kb_path,
        stats=stats,
        tokens=tokens,
        audit=audit,
        docs=len(docs),
        edges=len(edges),
        elapsed_ms=(time.perf_counter() - started) * 1000,
        notes=notes,
    )
    if print_report:
        _print_summary(result, note_counter)
    return result


def _print_summary(result: BuildResult, counter_note: str) -> None:
    t = result.tokens
    print()
    print(f"kb.sqlite = {result.kb_path}")
    print(
        f"知识点 {result.stats.get('kp', 0)} / 依赖边 {result.stats.get('dependencies', 0)} / "
        f"父块 {result.stats.get('parent_chunk', 0)} / 子块 {result.stats.get('child_chunk', 0)} / "
        f"chunk_vec {result.stats.get('chunk_vec', 0)} / chunk_fts {result.stats.get('chunk_fts', 0)}"
    )
    print(
        f"节级 token：最小 {t.get('parent_min')} / 中位 {t.get('parent_median')} / 最大 {t.get('parent_max')}"
        f"；落在 300–600 窗口的父块 {t.get('parents_in_window')}/{t.get('parents')}"
        f"（超上限 {t.get('parents_over_max')} 个）；子块中位 {t.get('child_median')}"
    )
    if counter_note:
        print(f"token 计数：{counter_note}")
    for note in result.notes:
        print(f"[注意] {note}")
    print(f"用时 {result.elapsed_ms / 1000:.2f}s")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="建 K12 知识库 kb.sqlite（幂等）")
    parser.add_argument("--knowledge-dir", default=str(KNOWLEDGE_DIR))
    parser.add_argument("--out", default=None, help="kb.sqlite 输出路径（默认 <data-dir>/shared/kb.sqlite）")
    parser.add_argument("--no-vectors", action="store_true", help="不建向量（排障用，检索会降级）")
    parser.add_argument("--lenient-terms", action="store_true", help="学段错位自检只告警不中止")
    parser.add_argument("--audit-only", action="store_true", help="只跑学段错位自检")
    parser.add_argument("--log-level", default="warning")
    args = parser.parse_args(argv)

    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.WARNING))

    try:
        if args.audit_only:
            docs = load_library(args.knowledge_dir)
            report = checker.audit_library(docs, load_terminology(args.knowledge_dir))
            print(checker.format_report(report))
            return 0 if report.ok else 1

        build(
            args.knowledge_dir,
            args.out,
            embedder=None,
            require_vectors=not args.no_vectors,
            strict_terms=not args.lenient_terms,
        )
    except BuildError as exc:
        print(f"[建库失败] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - CLI 边界：把异常变成可读的一行
        print(f"[建库异常] {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
