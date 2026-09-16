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

**模型缺失直接报错**，不静默产出空向量：没有向量的知识库会让检索一路降级到 FTS，
表面上「还能用」，实际上主路径从没被验证过 —— 这种「看起来正常」最危险。
真要只建 FTS（例如排障），显式加 ``--no-vectors``。
"""

from __future__ import annotations

import argparse
import logging
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

    事务由 sqlite3 的隐式事务 + 末尾一次 ``commit`` 承担：中途任何异常都不会留下半个库。
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
    conn.commit()
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
            vec_ready = vec_available(conn)

        ensure_kb(conn, dim=EMBEDDING_DIM, vec_ready=bool(vec_ready))
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
        # ★ 悬空引用 / 有环 → 直接抛异常并中止（不静默跳过）
        insert_dependencies(conn, edges)
        conn.commit()
        stats = kb_repo.stats(conn)
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
