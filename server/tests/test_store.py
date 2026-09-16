# -*- coding: utf-8 -*-
"""数据层单测（票 10）：迁移器、向量行号对齐、端序、FTS5、建库幂等。

本文件同时提供**测试夹具**（:func:`build_fixture_kb` / :class:`FakeEmbedder`），
`test_rag.py` 与 `test_graph.py` 复用它们 —— 这样单测不依赖 90MB 模型，
CI/新机器上 clone 下来就能跑。

★ 三个「错了也不报错、只是结果悄悄变错」的点，每条都有对应断言：

1. ``chunk_vec.rowid`` 与 ``chunk.rowid`` 错位（张冠李戴）；
2. 向量 BLOB 端序不一致；
3. FTS5 用了默认分词器（中文检索直接失效）。
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from app.config import EMBEDDING_DIM  # noqa: E402
from app.rag import chunker  # noqa: E402
from app.store import kb as kb_repo  # noqa: E402
from app.store.connections import connect, load_sqlite_vec, vec_available  # noqa: E402
from app.store.kb import pack_vector, unpack_vector  # noqa: E402
from app.store.migrations import (  # noqa: E402
    KB,
    LEARNING,
    KB_MIGRATIONS,
    current_version,
    ensure_kb,
    ensure_migrated,
    ensure_vec_table,
)

# --------------------------------------------------------------------------- #
# 夹具
# --------------------------------------------------------------------------- #
FIXTURE_DOC_LOW = """---
kp_id: fx-low-a
grade_level: primary_low
chapter_title: 第1章 测试章
knowledge_point: 认识测试
content_type: concept
summary: 低学段夹具文档。
---

## 一、认识测试

测试是为了确认程序做的事和你想的一样。写测试的时候要先把期望写清楚，再去看结果，{filler}

## 二、测试的好处

有了测试，改坏东西会被立刻发现。{filler2}
"""

FIXTURE_DOC_JUNIOR = """---
kp_id: fx-junior-a
grade_level: junior
chapter_title: 第2章 测试章
knowledge_point: 循环
content_type: principle
summary: 初中学段夹具文档。
---

## 一、为什么需要循环

循环让同一段代码重复执行，重复劳动交给机器。{filler}

## 二、变量的配合

循环通常需要变量来记录当前处理到哪里。{filler2}
"""

FIXTURE_DOC_SENIOR = """---
kp_id: fx-senior-a
grade_level: senior
chapter_title: 第3章 测试章
knowledge_point: 梯度下降
content_type: principle
summary: 高中学段夹具文档。
---

## 一、梯度下降

梯度下降沿着最陡的下坡走，损失函数越小越好。{filler}
"""


class FakeEmbedder:
    """确定性伪嵌入：字符二元组哈希 → 512 维。

    有它的意义：单测不加载 90MB 的 ONNX（快、且在没有模型的机器上也能跑），
    但它保留**词面相似度**这一性质 —— 共享汉字多的文本向量更接近，
    所以「问循环→命中循环那篇」这类断言依然成立。
    """

    available = True

    def __init__(self, dim: int = EMBEDDING_DIM) -> None:
        self.dim = dim

    def _vector(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dim, dtype=np.float32)
        for ch in text:
            vec[ord(ch) % self.dim] += 1.0
        for i in range(len(text) - 1):
            vec[(ord(text[i]) * 31 + ord(text[i + 1])) % self.dim] += 1.0
        norm = float(np.linalg.norm(vec))
        return vec / norm if norm else vec

    def embed_documents(self, texts):
        return np.vstack([self._vector(t) for t in texts]) if texts else np.zeros((0, self.dim), np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        return self._vector(text)

    def warmup(self) -> None:  # 夹具兼容
        return None


def write_fixture_knowledge(root: Path) -> Path:
    """写一份最小的四学段教材目录（3 篇，够跑通整条链路）。"""
    filler = "这一句用来把正文撑到检索有意义的长短，重复出现的内容不影响断言。" * 4
    docs = {
        "primary-low/fx-low-a.md": (FIXTURE_DOC_LOW, filler),
        "junior/fx-junior-a.md": (FIXTURE_DOC_JUNIOR, filler),
        "senior/fx-senior-a.md": (FIXTURE_DOC_SENIOR, filler),
    }
    for rel, (raw, fill) in docs.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(raw.replace("{filler2}", fill).replace("{filler}", fill), encoding="utf-8")

    manifest = {
        "version": 1,
        "dependencies": [
            {"from": "fx-low-a", "to": "fx-junior-a", "relation": "prerequisite", "weight": 1.0},
            {"from": "fx-junior-a", "to": "fx-senior-a", "relation": "prerequisite", "weight": 1.0},
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return root


def build_fixture_kb(
    tmpdir: Path,
    *,
    knowledge_dir: Path | None = None,
    kb_name: str = "kb.sqlite",
    embedder=None,
) -> Path:
    """用夹具教材建一个 kb.sqlite（默认用 :class:`FakeEmbedder`，不加载真模型）。

    落点是 ``<tmp>/shared/kb.sqlite`` —— **与运行期布局一致**（执行文档 §8.2），
    这样路由按 ``<data-dir>/shared/kb.sqlite`` 去找也能找到，HTTP 层才测得到。
    """
    import build_kb  # scripts/build_kb.py（测试里直接复用建库流程）

    knowledge = knowledge_dir or write_fixture_knowledge(tmpdir / "knowledge")
    kb_path = tmpdir / "shared" / kb_name
    build_kb.build(
        knowledge,
        kb_path,
        embedder=embedder or FakeEmbedder(),
        counter=chunker.heuristic_token_count,
        print_report=False,
    )
    return kb_path


def open_kb(kb_path: Path) -> sqlite3.Connection:
    conn = connect(kb_path, load_vec=True)
    ensure_kb(conn, dim=EMBEDDING_DIM, vec_ready=vec_available(conn))
    return conn


class SqliteCase(unittest.TestCase):
    """带临时目录的基类：**每个连接都必须登记关闭**。

    Windows 上没关的连接会占住文件，临时目录清理会抛 ``WinError 32`` ——
    那是个和业务无关的假失败，但它会淹没真正的断言失败，必须一开始就避免。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def connect_kb(self, name: str = "kb.sqlite", *, vec: bool = True) -> sqlite3.Connection:
        conn = connect(self.tmp / name, load_vec=vec)
        self.addCleanup(conn.close)
        return conn

    def open_conn(self, path: Path) -> sqlite3.Connection:
        conn = open_kb(path)
        self.addCleanup(conn.close)
        return conn


# --------------------------------------------------------------------------- #
# 迁移器
# --------------------------------------------------------------------------- #
class TestMigrations(SqliteCase):
    def test_ensure_migrated_is_idempotent_and_records_version(self) -> None:
        conn = self.connect_kb()
        self.assertEqual(current_version(conn, KB), 0)
        ensure_migrated(conn, KB_MIGRATIONS, set_name=KB, vec_ready=True)
        self.assertEqual(current_version(conn, KB), 1)
        # 再跑一次：不报错、版本不重复、行数不翻倍
        ensure_migrated(conn, KB_MIGRATIONS, set_name=KB, vec_ready=True)
        rows = conn.execute("SELECT COUNT(*) FROM schema_version WHERE set_name='kb'").fetchone()[0]
        self.assertEqual(rows, 1)

    def test_learning_migrations_use_their_own_set(self) -> None:
        """两个库共用一套迁移器，靠 set_name 隔离 —— kb 的版本号不该被 learning 影响。"""
        from app.store.migrations import LEARNING_MIGRATIONS

        conn = self.connect_kb()
        ensure_migrated(conn, KB_MIGRATIONS, set_name=KB, vec_ready=True)
        ensure_migrated(conn, LEARNING_MIGRATIONS, set_name=LEARNING, vec_ready=False)
        versions = {
            str(r["set_name"]): int(r["version"])
            for r in conn.execute("SELECT set_name, version FROM schema_version")
        }
        self.assertEqual(versions, {KB: 1, LEARNING: 1})
        self.assertTrue(kb_repo.table_exists(conn, "student"))

    def test_vec_table_dimension_guard(self) -> None:
        """库里的 vec0 维度与配置不一致时**必须报错**，否则 KNN 会静默算错。"""
        conn = self.connect_kb()
        ensure_vec_table(conn, dim=EMBEDDING_DIM)
        with self.assertRaises(RuntimeError) as ctx:
            ensure_vec_table(conn, dim=768)
        self.assertIn("重建索引", str(ctx.exception))

    def test_vec_table_is_idempotent(self) -> None:
        conn = self.connect_kb()
        self.assertTrue(ensure_vec_table(conn, dim=EMBEDDING_DIM))
        self.assertTrue(ensure_vec_table(conn, dim=EMBEDDING_DIM))


# --------------------------------------------------------------------------- #
# 向量 BLOB
# --------------------------------------------------------------------------- #
class TestVectorBlob(unittest.TestCase):
    def test_little_endian_roundtrip(self) -> None:
        vec = np.arange(EMBEDDING_DIM, dtype=np.float32) / 7.0
        blob = pack_vector(vec)
        self.assertEqual(len(blob), EMBEDDING_DIM * 4)
        # 端序：小端 float32 的 1.0 存成 00 00 80 3F（大端会是 3F 80 00 00）
        one = pack_vector(np.array([1.0], dtype=np.float32))
        self.assertEqual(one, b"\x00\x00\x80\x3f")
        self.assertTrue(np.allclose(unpack_vector(blob), vec))

    def test_big_endian_input_is_normalized_to_little_endian(self) -> None:
        """>f4 输入也必须存成小端（读取侧固定按 <f4 还原）。"""
        big = np.array([1.0, 2.0], dtype=">f4")
        blob = pack_vector(big)
        self.assertTrue(np.allclose(unpack_vector(blob), np.array([1.0, 2.0], dtype="<f4")))


# --------------------------------------------------------------------------- #
# 建库：行号对齐、FTS5、幂等
# --------------------------------------------------------------------------- #
class TestBuildKb(SqliteCase):
    def setUp(self) -> None:
        super().setUp()
        self.kb_path = build_fixture_kb(self.tmp)
        self.conn = self.open_conn(self.kb_path)

    def test_vec_rowid_matches_chunk_rowid(self) -> None:
        """★ vec0 的 rowid 必须等于 chunk.rowid，否则检索结果张冠李戴。"""
        rows = self.conn.execute(
            "SELECT v.rowid AS vrow, c.rowid AS crow, c.chunk_id, c.grade_level "
            "FROM chunk_vec v JOIN chunk c ON c.rowid = v.rowid"
        ).fetchall()
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(row["vrow"], row["crow"])
        # 反向：vec 表里不能有 chunk 表没有的 rowid
        orphan = self.conn.execute(
            "SELECT COUNT(*) FROM chunk_vec v LEFT JOIN chunk c ON c.rowid = v.rowid "
            "WHERE c.rowid IS NULL"
        ).fetchone()[0]
        self.assertEqual(orphan, 0)

    def test_knn_returns_the_grade_filtered_rows(self) -> None:
        """KNN + 学段元数据过滤：初中查询不能返回高中行（这条是 SQL 层的事）。"""
        from app.rag.retriever import RagService

        service = RagService(self.kb_path, embedder=FakeEmbedder())
        self.addCleanup(service.close)
        conn = service._ensure_conn()
        query_vec = FakeEmbedder().embed_query("循环 变量")
        rows = kb_repo.knn_rows(conn, query_vec, ["junior", "primary_high", "primary_low"], k=10)
        self.assertTrue(rows)
        grades = {
            conn.execute("SELECT grade_level FROM chunk WHERE rowid = ?", (int(r["rowid"]),)).fetchone()[0]
            for r in rows
        }
        self.assertNotIn("senior", grades)

    def test_fts_trigram_matches_chinese(self) -> None:
        """★ 默认分词器把整段中文当一个 token（等于不可检索），必须 trigram。"""
        ddl = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE name='chunk_fts'"
        ).fetchone()[0]
        self.assertIn("trigram", ddl)

        hit = self.conn.execute(
            "SELECT COUNT(*) FROM chunk_fts WHERE chunk_fts MATCH ?", ('"同一段代码"',)
        ).fetchone()[0]
        self.assertGreater(hit, 0, "trigram 至少应能匹配正文里的 3 字以上中文片段")

    def test_short_chinese_query_falls_back_to_like(self) -> None:
        """★ trigram 的最小匹配长度是 3 字符：「循环」这种双字词必须靠 LIKE 兜底。"""
        from app.rag import fallback

        direct = self.conn.execute(
            "SELECT COUNT(*) FROM chunk_fts WHERE chunk_fts MATCH ?", ('"循环"',)
        ).fetchone()[0]
        self.assertEqual(direct, 0, "前提：trigram 匹配不到双字词（实测行为）")

        hits = fallback.fts_search(
            self.conn, query="循环", grade_levels=["junior"], requested_grade="junior", top_k=5
        )
        self.assertTrue(hits, "FTS 降级路径必须能靠 LIKE 找到「循环」")
        self.assertTrue(all(h.chunk.grade_level == "junior" for h in hits))

    def test_rebuild_is_idempotent(self) -> None:
        """★ 连续建两次，行数必须完全相同（不清表重跑 = 数据翻倍）。"""
        before = kb_repo.stats(self.conn)
        build_fixture_kb(self.tmp)  # 覆盖同一个 kb.sqlite
        conn = self.open_conn(self.kb_path)
        self.assertEqual(kb_repo.stats(conn), before)

    def test_no_empty_metadata_fields(self) -> None:
        """chunk 元数据不允许空字段（票 10 的验收项）。"""
        rows = self.conn.execute(
            "SELECT chunk_id, text, grade_level, chapter_title, section_title, "
            "knowledge_point, content_type, token_count FROM chunk"
        ).fetchall()
        self.assertTrue(rows)
        for row in rows:
            for column in row.keys():
                self.assertNotIn(
                    row[column], (None, ""), f"{row['chunk_id']} 的 {column} 为空"
                )
            self.assertGreater(int(row["token_count"]), 0)

    def test_parent_child_relationship_is_intact(self) -> None:
        parents = self.conn.execute("SELECT COUNT(*) FROM chunk WHERE is_parent = 1").fetchone()[0]
        children = self.conn.execute("SELECT COUNT(*) FROM chunk WHERE is_parent = 0").fetchone()[0]
        self.assertGreater(parents, 0)
        self.assertGreater(children, 0)
        missing = self.conn.execute(
            "SELECT COUNT(*) FROM chunk c WHERE c.parent_chunk_id IS NOT NULL "
            "AND NOT EXISTS (SELECT 1 FROM chunk p WHERE p.chunk_id = c.parent_chunk_id)"
        ).fetchone()[0]
        self.assertEqual(missing, 0, "子块的父块必须存在（父子两阶段检索的前提）")

    def test_only_children_are_indexed_in_vec_table(self) -> None:
        """检索单元是子块；父块不进向量表（命中后靠 parent_chunk_id 取回）。"""
        indexed_parents = self.conn.execute(
            "SELECT COUNT(*) FROM chunk c JOIN chunk_vec v ON v.rowid = c.rowid WHERE c.is_parent = 1"
        ).fetchone()[0]
        self.assertEqual(indexed_parents, 0)

    def test_dependencies_direction_semantics(self) -> None:
        """from = 前置，to = 后继：低学段 → 初中学段。"""
        row = self.conn.execute(
            "SELECT * FROM knowledge_dependencies WHERE from_kp_id='fx-low-a'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["to_kp_id"], "fx-junior-a")


# --------------------------------------------------------------------------- #
# 分块
# --------------------------------------------------------------------------- #
class TestChunker(unittest.TestCase):
    def test_pack_blocks_respects_window(self) -> None:
        text = "。".join(f"这是第{i}句用来测试分块的句子，长度大致均匀" for i in range(60)) + "。"
        blocks = chunker.pack_blocks(
            text,
            chunker.heuristic_token_count,
            min_tokens=chunker.PARENT_MIN_TOKENS,
            max_tokens=chunker.PARENT_MAX_TOKENS,
        )
        self.assertGreater(len(blocks), 1)
        sizes = [chunker.heuristic_token_count(b) for b in blocks]
        self.assertLessEqual(max(sizes), chunker.PARENT_MAX_TOKENS)
        # 除最后一块外都不得低于下限（最后一块可能本来就短）
        self.assertTrue(all(s >= chunker.PARENT_MIN_TOKENS for s in sizes[:-1]), sizes)

    def test_long_section_splits_into_in_window_blocks(self) -> None:
        text = "。".join(f"第{i}个句子的内容是重复出现的说明文字" for i in range(120)) + "。"
        blocks = chunker.pack_blocks(
            text,
            chunker.heuristic_token_count,
            min_tokens=chunker.PARENT_MIN_TOKENS,
            max_tokens=chunker.PARENT_MAX_TOKENS,
        )
        self.assertGreaterEqual(len(blocks), 2)
        for block in blocks:
            self.assertLessEqual(chunker.heuristic_token_count(block), chunker.PARENT_MAX_TOKENS)

    def test_short_child_not_split_into_fragments(self) -> None:
        """短父块只产生一个子块 —— 不为了凑数把 100 token 砍成两个碎片。"""
        text = "。" * 0 + "这是一段很短的正文。" * 5
        children = chunker.split_child_blocks(text, chunker.heuristic_token_count)
        self.assertEqual(len(children), 1)

    def test_chunk_ids_are_deterministic(self) -> None:
        """同一个 Markdown 反复分块，chunk_id 必须完全一致（幂等建库的前提）。"""
        from app.knowledge.library import load_document

        doc = load_document(ROOT / "knowledge" / "junior" / "jr-py-loop.md")
        first = [d.chunk_id for d in chunker.chunk_document(doc, chunker.heuristic_token_count)]
        second = [d.chunk_id for d in chunker.chunk_document(doc, chunker.heuristic_token_count)]
        self.assertEqual(first, second)
        self.assertEqual(len(first), len(set(first)), "chunk_id 不能重复")


class TestRealCorpusChunking(unittest.TestCase):
    """真教材 + 真分词器的分块口径（不需要 ONNX 模型，只需要 tokenizer.json）。"""

    def setUp(self) -> None:
        counter, note = chunker.resolve_token_counter(
            ROOT / "resources" / "models" / "fastembed"
        )
        if "heuristic" in note:
            self.skipTest(f"未找到 tokenizer.json（{note}）")
        self.counter = counter
        from app.knowledge.library import load_library

        self.docs = load_library(ROOT / "knowledge")

    def test_parent_blocks_are_within_300_600_tokens(self) -> None:
        sizes: list[int] = []
        for doc in self.docs:
            for _title, text, _idx in chunker.plan_parent_blocks(doc, self.counter):
                sizes.append(self.counter(text))
        self.assertTrue(sizes)
        over = [s for s in sizes if s > chunker.PARENT_MAX_TOKENS]
        self.assertEqual(over, [], f"超上限的父块：{over}")
        below = [s for s in sizes if s < chunker.PARENT_MIN_TOKENS]
        self.assertEqual(below, [], f"低于下限的父块：{below}")

    def test_grade_term_audit_passes(self) -> None:
        """学段错位自检必须零问题（教材内容与术语文表对齐）。"""
        from app.knowledge import checker
        from app.knowledge.library import load_terminology

        report = checker.audit_library(self.docs, load_terminology(ROOT / "knowledge"))
        self.assertTrue(
            report.ok,
            "\n".join(f"{v.grade_level}/{v.kp_id}: {v.detail}" for v in report.violations),
        )


if __name__ == "__main__":
    unittest.main()
