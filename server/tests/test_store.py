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
import threading
import time
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from app.config import EMBEDDING_DIM  # noqa: E402
from app.contracts import MASTERY_DELTA_LIMIT as CONTRACT_DELTA_LIMIT  # noqa: E402
from app.rag import chunker  # noqa: E402
from app.store import kb as kb_repo  # noqa: E402
from app.store import learning as learning_store  # noqa: E402
from app.store.connections import connect, load_sqlite_vec, vec_available  # noqa: E402
from app.store.kb import pack_vector, unpack_vector  # noqa: E402
from app.store.migrations import (  # noqa: E402
    KB,
    LEARNING,
    KB_MIGRATIONS,
    Migration,
    _apply_kb_v1,
    _apply_learning_v1,
    applied_versions,
    current_version,
    ensure_kb,
    ensure_migrated,
    ensure_vec_table,
)
from app.store.learning import LearningStore  # noqa: E402

#: ``app/store/learning.py`` 的源码（只用于「刷活跃时间必须是单列 UPDATE」那条结构断言）。
LEARNING_SOURCE = (ROOT / "app" / "store" / "learning.py").read_text(encoding="utf-8")


def method_source(name: str) -> str:
    """取出 ``LearningStore`` 里某个方法的源码文本（到下一个 ``def`` 为止）。"""
    return LEARNING_SOURCE.split(f"def {name}(", 1)[1].split("\n    def ", 1)[0]


def method_code(name: str) -> str:
    """``method_source`` 去掉 docstring 与注释后的**可执行代码**。

    ★ 结构断言只能对着代码看：文档字符串里**必然会**用文字讨论被禁止的写法
      （本方法的 docstring 就在解释「为什么不能用 ``upsert_student``」），
      拿整段源码去 ``assertNotIn`` 会把「解释禁令」误判成「违反禁令」。
    """
    body = method_source(name)
    parts = body.split('"""')
    # 偶数段（0, 2, 4…）在 docstring 之外；把 docstring 段整段丢掉
    outside = "".join(parts[::2])
    lines = [
        line
        for line in (line.split("#", 1)[0] for line in outside.splitlines())
        if line.strip()
    ]
    return "\n".join(lines)


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
        # ★ 按 (set_name, version) 逐行看**账本**（不是「每个 set 取一行」）：
        #   同一组里多版本并存是正常的 —— learning 的 v2 是「学生当前教材章节列」、
        #   v3 是「学段轨迹的信号位标」，它们**不该**让 kb 的账本多出一行
        #   （那才是本用例真正防的事）。
        rows = {
            (str(r["set_name"]), int(r["version"]))
            for r in conn.execute("SELECT set_name, version FROM schema_version")
        }
        self.assertEqual(rows, {(KB, 1), (LEARNING, 1), (LEARNING, 2), (LEARNING, 3), (LEARNING, 4)})
        self.assertEqual(
            {str(r["set_name"]) for r in conn.execute("SELECT set_name FROM schema_version WHERE version > 1")},
            {LEARNING},
            "只有 learning 组有多版本（v2 章节列 / v3 学段信号位标）；kb 组不该出现多版本",
        )
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

    def test_failed_migration_rolls_back_and_records_nothing(self) -> None:
        """★ 迁移中途报错 → **整体回滚**：半截的表不留、版本号不前进。

        修复前为什么是红的：``apply`` 里用 ``conn.executescript``，而它会**先隐式 COMMIT**
        （``sqlite3`` 的既有行为），脚本第二条语句报错时第一张表已经落盘 ——
        于是库里留下一张没人认领的表，``schema_version`` 却是空的（「半应用且不记账」）。
        """
        conn = self.connect_kb()

        def broken(conn: sqlite3.Connection) -> None:
            conn.execute("CREATE TABLE probe_partial_a(x INTEGER)")
            conn.execute("CREATE INDEX probe_idx_a ON probe_partial_a(x)")
            conn.execute("CREATE TABLE probe_partial_b(x INTEGER)")
            conn.execute("THIS IS NOT VALID SQL")

        with self.assertRaises(sqlite3.OperationalError):
            ensure_migrated(conn, (Migration(version=1, name="故意失败的迁移", apply=broken),), set_name="probe")

        self.assertEqual(applied_versions(conn, "probe"), {}, "失败的迁移绝不能记账")
        self.assertEqual(current_version(conn, "probe"), 0)
        self.assertFalse(kb_repo.table_exists(conn, "probe_partial_a"), "半截的表必须回滚掉")
        self.assertFalse(kb_repo.table_exists(conn, "probe_partial_b"))
        # 回滚之后库还能正常用（不会卡在「有未提交事务」的状态里）
        self.assertEqual(ensure_migrated(conn, KB_MIGRATIONS, set_name=KB, vec_ready=True), 1)

    def test_real_ddl_is_rollbackable_inside_a_transaction(self) -> None:
        """★ 真 DDL 必须能在显式事务里被回滚 —— 这条钉住「不许再用 ``executescript``」。

        ``executescript`` 会隐式提交，连调用方自己开的 ``BEGIN`` 都会被它提交掉
        （实测：``BEGIN`` → ``_apply_kb_v1`` → ``ROLLBACK`` 之后 ``kp`` 还在）。
        """
        conn = self.connect_kb()
        conn.execute("BEGIN")
        _apply_kb_v1(conn)
        _apply_learning_v1(conn)
        self.assertTrue(kb_repo.table_exists(conn, "kp"))
        self.assertTrue(kb_repo.table_exists(conn, "chunk_fts"))
        self.assertTrue(kb_repo.table_exists(conn, "student"))
        conn.rollback()
        for table in ("kp", "chunk", "chunk_fts", "knowledge_dependencies", "student", "mastery"):
            self.assertFalse(
                kb_repo.table_exists(conn, table), f"{table} 没被回滚 —— 迁移又用回 executescript 了？"
            )

    def test_migration_inside_a_callers_transaction_does_not_break_it(self) -> None:
        """★ 调用方已有写事务时，迁移既不能崩、也不能把调用方的事务吃掉。

        ``ensure_quiz_tables()`` 就是这类「被别人顺手调用」的迁移入口：
        裸 ``BEGIN`` 在这种情况下会抛 ``cannot start a transaction within a transaction``；
        迁移用 SAVEPOINT 则只是把自己那一段圈起来 —— 调用方未提交的行、以及调用方
        自己后续的提交都不受影响。
        """
        conn = self.connect_kb()
        ensure_migrated(conn, KB_MIGRATIONS, set_name=KB, vec_ready=True)

        def add_probe(conn: sqlite3.Connection) -> None:
            conn.execute("CREATE TABLE probe_in_tx(x INTEGER)")

        conn.execute("BEGIN")
        conn.execute("INSERT INTO kp(kp_id, grade_level, name) VALUES('kp-tx','junior','事务里的行')")
        self.assertTrue(conn.in_transaction, "前提：调用方确实开着事务")

        version = ensure_migrated(
            conn, (Migration(version=1, name="在调用方事务里加表", apply=add_probe),), set_name="probe_tx"
        )
        self.assertEqual(version, 1)
        self.assertTrue(conn.in_transaction, "迁移不该动调用方的事务边界")
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM kp WHERE kp_id='kp-tx'").fetchone()[0],
            1,
            "调用方未提交的行必须还在",
        )
        conn.commit()
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM kp WHERE kp_id='kp-tx'").fetchone()[0], 1
        )
        self.assertTrue(kb_repo.table_exists(conn, "probe_in_tx"), "迁移自己那一段被提交了")

        # 失败路径：只有迁移那一段回滚，调用方未提交的行不受牵连
        def broken(conn: sqlite3.Connection) -> None:
            conn.execute("CREATE TABLE probe_in_tx_fail(x INTEGER)")
            conn.execute("THIS IS NOT VALID SQL")

        conn.execute("INSERT INTO kp(kp_id, grade_level, name) VALUES('kp-tx2','junior','第二行')")
        with self.assertRaises(sqlite3.OperationalError):
            ensure_migrated(
                conn, (Migration(version=1, name="故意失败", apply=broken),), set_name="probe_tx_fail"
            )
        self.assertFalse(kb_repo.table_exists(conn, "probe_in_tx_fail"))
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM kp WHERE kp_id='kp-tx2'").fetchone()[0],
            1,
            "迁移失败不能连带回滚调用方的事务",
        )
        conn.commit()

    def test_concurrent_first_migration_does_not_blow_up(self) -> None:
        """★ 两个连接同时做「首次迁移」时，落选的那个**不许抛** ``database is locked``。

        现象（2026-09-18 实测，属 P-063）：一人一库的打开方式是**每次请求现开现关**
        （``routes/students.py`` 的 ``open_learning_store``），界面挂载时几乎同时发出的
        两条请求就是两个连接、两条连接同时看到「v2 还没应用」。实测 36 次并发里有 11 次
        直接把 ``HTTP 500`` 抛给学生。

        根因不是「等得不够久」：WAL 下迁移**先读后写**（``PRAGMA table_info`` 判列 → ``ALTER``），
        读那一步就把连接推进了一个读快照；等它要升级为写事务时赢家已经提交，SQLite 只能返回
        ``SQLITE_BUSY_SNAPSHOT`` —— **这种失败不等 ``busy_timeout``**。所以修法是
        「先拿写锁（``BEGIN IMMEDIATE``，它会正常等锁）再读账本」。

        这条用例锁住的就是那个行为：无论跑多少次、无论谁赢，两边都必须成功且版本一致。
        """
        from concurrent.futures import ThreadPoolExecutor

        from app.store.migrations import LEARNING_MIGRATIONS

        # 造一个「老库」：只跑到 v1，把 v2（章节列）与 v3（学段信号位标）留成待应用 ——
        # 竞争就发生在这些待应用的版本上。
        path = self.tmp / "learning.db"
        seed = connect(path, load_vec=False)
        try:
            ensure_migrated(seed, LEARNING_MIGRATIONS[:1], set_name=LEARNING)
        finally:
            seed.close()

        def open_and_migrate(_index: int) -> int:
            store = LearningStore(path)
            try:
                return current_version(store.conn, LEARNING)
            finally:
                store.conn.close()

        # 三轮、每轮三个并发连接：单轮偶发过了不算数，这个竞争本来就是概率性的。
        for round_index in range(3):
            with ThreadPoolExecutor(max_workers=3) as pool:
                versions = [f.result() for f in [pool.submit(open_and_migrate, i) for i in range(3)]]
            self.assertEqual(
                versions,
                [4, 4, 4],
                f"第 {round_index + 1} 轮：并发首迁必须全部成功且都到最新版，实际 {versions}",
            )

        # 收尾：待应用的每一版**只有一行**（落选连接不许重复记账）
        check = connect(path, load_vec=False)
        try:
            rows = check.execute(
                "SELECT COUNT(*) FROM schema_version WHERE set_name=? AND version=4",
                (LEARNING,),
            ).fetchone()[0]
            columns = {str(r["name"]) for r in check.execute("PRAGMA table_info(student)")}
            history_columns = {
                str(r["name"]) for r in check.execute("PRAGMA table_info(grade_history)")
            }
        finally:
            check.close()
        self.assertEqual(rows, 1, "并发迁移不该把同一版记两次")
        self.assertIn("current_chapter", columns)
        self.assertIn("signal_mark", history_columns)

    def test_execute_script_splits_on_real_statement_boundaries(self) -> None:
        """★ 逐条执行：同一行的两条语句也要拆开，注释与字符串里的分号不能当边界。

        修复前为什么是红的：迁移走 ``conn.executescript``（隐式提交，见上一条），
        而按 ``sqlite3.complete_statement`` 逐行累加的替代实现会把
        「同一行两条语句」整行交给 ``conn.execute`` →
        ``ProgrammingError: You can only execute one statement at a time``。
        """
        from app.store.migrations import execute_script, split_sql_statements

        conn = self.connect_kb()
        script = (
            "-- 行注释里的分号; 不算边界\n"
            "CREATE TABLE sp_one(a TEXT DEFAULT 'x;y'); CREATE INDEX idx_sp_one ON sp_one(a);\n"
            "/* 块注释里的分号; 也不算 */ CREATE TABLE sp_two(b);\n"
            'CREATE TABLE "sp;three"(c);\n'
        )
        self.assertEqual(len(split_sql_statements(script)), 4)
        execute_script(conn, script)
        for table in ("sp_one", "sp_two", "sp;three"):
            self.assertTrue(kb_repo.table_exists(conn, table), f"{table} 没建出来")

        # 真 DDL 的条数固定下来（写死的 DDL 一旦被合并/拆散，这条会先响）
        from app.store import learning as learning_module
        from app.store.migrations import _KB_FTS, _KB_V1, _LEARNING_V1

        self.assertEqual(len(split_sql_statements(_KB_V1)), 8)
        self.assertEqual(len(split_sql_statements(_KB_FTS)), 1)
        self.assertEqual(len(split_sql_statements(_LEARNING_V1)), 9)
        self.assertEqual(len(split_sql_statements(learning_module._QUIZ_V1)), 2)

    def test_foreign_keys_are_enforced(self) -> None:
        """★ ``REFERENCES`` 必须真的生效。

        ``sqlite3`` 默认 ``foreign_keys=OFF``，``connect()`` 不显式打开的话，
        DDL 里的外键就只是一句注释：``knowledge_dependencies`` 的悬空 ``kp_id``
        会被静默写入（业务陷阱清单 §3 第 3 条）。
        """
        conn = self.connect_kb()
        self.assertEqual(
            int(conn.execute("PRAGMA foreign_keys").fetchone()[0]), 1, "连接必须显式打开外键"
        )
        ensure_migrated(conn, KB_MIGRATIONS, set_name=KB, vec_ready=True)
        kb_repo.insert_kp(
            conn,
            kb_repo.KpRecord(
                kp_id="kp-ok",
                grade_level="junior",
                name="循环",
                chapter_title="第1章",
                section_title="第1节",
                summary="测试用",
            ),
        )
        # 合法边：正常写入
        conn.execute(
            "INSERT INTO knowledge_dependencies(from_kp_id, to_kp_id, relation, weight) "
            "VALUES('kp-ok','kp-ok','related',1.0)"
        )
        # 悬空边：必须**当场报错**，不能静默入库
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO knowledge_dependencies(from_kp_id, to_kp_id, relation, weight) "
                "VALUES('kp-ok','kp-404','prerequisite',1.0)"
            )
        rows = conn.execute("SELECT COUNT(*) FROM knowledge_dependencies").fetchone()[0]
        self.assertEqual(rows, 1, "悬空那条不该留下任何痕迹")


# --------------------------------------------------------------------------- #
# 掌握度：并发不丢更新 + 限幅只有一处来源
# --------------------------------------------------------------------------- #
class TestMasteryStore(SqliteCase):
    KP = "kp-concurrent"

    def open_store(self) -> LearningStore:
        store = LearningStore(self.tmp / "learning.db")
        self.addCleanup(store.close)
        return store

    def test_concurrent_correct_answers_do_not_lose_updates(self) -> None:
        """★ 两条连接（两个线程）同时答对同一知识点 → attempts/correct/score 都必须涨两次。

        修复前为什么是红的：``apply_mastery`` 是「先 ``mastery()`` 读、再
        ``INSERT ... ON CONFLICT`` 写」两步，两个请求各自读到同一个旧值再各自写回，
        **后写的覆盖先写的** —— 实测结果是 ``(score=0.2, attempts=1, correct=1)``，
        不报错、不回滚，而调用方还以为自己那一次已经记上了。
        """
        first = self.open_store()
        second = self.open_store()
        barrier = threading.Barrier(2)
        results: list[float] = []
        errors: list[BaseException] = []
        lock = threading.Lock()

        def answer(store: LearningStore) -> None:
            try:
                barrier.wait(timeout=10)  # 两个线程同时冲线，最大化交错概率
                value = store.apply_mastery(self.KP, 0.2, correct=True)
                with lock:
                    results.append(value)
            except BaseException as exc:  # noqa: BLE001 - 线程里的异常必须带回主线程断言
                with lock:
                    errors.append(exc)

        threads = [threading.Thread(target=answer, args=(store,)) for store in (first, second)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        self.assertEqual(errors, [], f"并发调用抛异常：{errors}")
        self.assertEqual(len(results), 2)
        score, attempts, correct_cnt = first.mastery(self.KP)
        self.assertEqual(attempts, 2, "并发两次答对必须记两次尝试（丢更新 = attempts 只涨一次）")
        self.assertEqual(correct_cnt, 2)
        self.assertAlmostEqual(score, 0.4, places=6)
        # 返回值必须就是库里的那两个值（不是各算各的）
        self.assertEqual(sorted(results), [0.2, 0.4])
        self.assertEqual(second.mastery(self.KP), first.mastery(self.KP))

    def test_delta_limit_has_a_single_source(self) -> None:
        """★ ``MASTERY_DELTA_LIMIT`` 只允许有一处定义（契约），store 必须 import 它。

        各写一份 ``= 0.2`` 的话，只改一处就会让「返回给前端的 delta」与
        「实际写进 ``mastery`` 的分数变化」对不上。``assertIs`` 断言的是同一个对象，
        而不是数值恰好相等。
        """
        self.assertIs(learning_store.MASTERY_DELTA_LIMIT, CONTRACT_DELTA_LIMIT)
        self.assertEqual(CONTRACT_DELTA_LIMIT, 0.2)
        self.assertIn("MASTERY_DELTA_LIMIT", learning_store.__all__)

    def test_apply_mastery_clamps_with_the_contract_limit(self) -> None:
        """限幅用契约那个常量，且**冷启动那一行也要钳**（0.2 而不是 5.0）。"""
        store = self.open_store()
        self.assertAlmostEqual(
            store.apply_mastery("kp-new", 5.0, correct=True), CONTRACT_DELTA_LIMIT, places=6
        )
        self.assertEqual(store.mastery("kp-new"), (CONTRACT_DELTA_LIMIT, 1, 1))
        self.assertAlmostEqual(store.apply_mastery("kp-new", 5.0, correct=True), 0.4, places=6)
        self.assertAlmostEqual(store.apply_mastery("kp-new", -5.0, correct=False), 0.2, places=6)
        self.assertEqual(store.mastery("kp-new"), (0.2, 3, 2))
        # 空库上的新知识点：负数不会让分数掉到 0 以下
        self.assertAlmostEqual(store.apply_mastery("kp-empty", -5.0, correct=False), 0.0, places=6)
        self.assertEqual(store.mastery("kp-empty"), (0.0, 1, 0))


# --------------------------------------------------------------------------- #
# 学习记录读原语：判分幂等 / 活跃时间单列刷新 / 错题本全量
# --------------------------------------------------------------------------- #
class TestLearningHistoryReads(SqliteCase):
    """三个读原语的边界（**纯新增**，不改既有方法的行为）。

    每条都对应一个「错了也不报错、只是结果悄悄变错」的点：

    1. ``question_attempt`` 把**没做过的题**说成做过（判分幂等会吃掉学生的一次得分机会），
       或者把做过说成没做过（同一道题重复记两次掌握度）；
    2. ``touch_last_active`` 用整行 upsert 刷活跃时间，把**并发期间刚改掉的学段打回旧值**；
    3. ``mistakes()`` 在**截断之后**求和，让「累计答错 N 次」永远停在 50。
    """

    def open_store(self) -> LearningStore:
        store = LearningStore(self.tmp / "learning.db")
        self.addCleanup(store.close)
        return store

    def seed_student(self, store: LearningStore, *, grade: str = "primary_low") -> str:
        """建一个学生行（``upsert_student`` 是冷启动口径，这里用它把行铺出来）。"""
        student_id = "stu-reads"
        store.upsert_student(student_id, nickname="团团", grade_level=grade)
        return student_id

    def grade_of(self, store: LearningStore, student_id: str) -> str:
        """读回学段（``get_student`` 的返回值可空，测试里少写两行 None 检查）。"""
        record = store.get_student(student_id)
        self.assertIsNotNone(record, f"{student_id} 的行不见了")
        assert record is not None
        return record.grade_level

    # ------------------------------------------------- question_attempt --
    def test_question_attempt_is_none_before_any_attempt(self) -> None:
        """没做过就是 ``None``（不能凭空造一条「做过」出来）。"""
        store = self.open_store()
        store.add_history(kp_id="kp-a", activity="quiz", question="别的题", is_correct=True)
        self.assertIsNone(store.question_attempt("q-never-seen"))

    def test_question_attempt_returns_the_latest_of_two_attempts(self) -> None:
        """同一题答两次 → 返回**最近那次**。

        第一次答错、第二次答对：返回的必须是第二次（``is_correct=True``）。
        ``add_history`` 的 ``ts`` 是**秒**，两次提交几乎必然落在同一秒里，
        所以这里真正考的是 ``ORDER BY ts DESC, id DESC`` 的**第二顺位**
        （光按 ts 排的话，同一秒的两行顺序随 SQLite 心情，会随机返回第一次）。
        """
        store = self.open_store()
        store.add_history(
            kp_id="kp-a",
            activity="quiz",
            question="循环至少执行几次？",
            is_correct=False,
            detail=json.dumps({"qid": "q-1", "type": "choice"}, ensure_ascii=False),
        )
        store.add_history(
            kp_id="kp-a",
            activity="quiz",
            question="循环至少执行几次？",
            is_correct=True,
            detail=json.dumps({"qid": "q-1", "type": "choice"}, ensure_ascii=False),
        )

        attempt = store.question_attempt("q-1")
        self.assertIsNotNone(attempt)
        assert attempt is not None  # 给 type checker 看（unittest 断言不缩窄类型）
        self.assertEqual(attempt.qid, "q-1")
        self.assertEqual(attempt.kp_id, "kp-a")
        self.assertIs(attempt.is_correct, True, "必须是**第二次**的结果")
        self.assertGreater(attempt.ts, 0, "ts 是 Unix 秒")

    def test_question_attempt_prefers_newer_ts_over_newer_id(self) -> None:
        """``ts`` 是**第一顺位**：后插入但更早发生的行不算「最近一次」。

        用裸 SQL 造出「ts 与 id 反向」的两行 —— 只有按 ``ts`` 优先排序才会选对：
          id=1 ts=5000（新）、id=2 ts=1000（旧，但插入更晚）。
        修复前为什么可能是红的：只按 ``id DESC`` 取（或不做排序，直接读第一行命中的），
        返回的是那条 ``is_correct=0`` 的旧记录 —— 判分幂等据此认为「上次答错了」。
        """
        store = self.open_store()
        rows = [
            (5000, "kp-a", "quiz", "题干", 1, '{"qid": "q-ts"}'),
            (1000, "kp-a", "quiz", "题干", 0, '{"qid": "q-ts"}'),
        ]
        for ts, kp_id, activity, question, correct, detail in rows:
            store.conn.execute(
                "INSERT INTO learning_history(ts, session_id, kp_id, activity, question, is_correct, detail) "
                "VALUES(?,?,?,?,?,?,?)",
                (ts, "", kp_id, activity, question, correct, detail),
            )
        store.conn.commit()

        attempt = store.question_attempt("q-ts")
        self.assertIsNotNone(attempt)
        assert attempt is not None
        self.assertEqual(attempt.ts, 5000, "ts 大的那条才是最近一次")
        self.assertIs(attempt.is_correct, True)

    def test_question_attempt_keeps_qids_apart(self) -> None:
        """不同 qid 互不干扰；答过 A 不代表答过 B。"""
        store = self.open_store()
        store.add_history(
            kp_id="kp-a", activity="quiz", is_correct=True, detail='{"qid": "q-a"}'
        )
        store.add_history(
            kp_id="kp-b", activity="quiz", is_correct=False, detail='{"qid": "q-b"}'
        )

        attempt_a = store.question_attempt("q-a")
        attempt_b = store.question_attempt("q-b")
        self.assertIsNotNone(attempt_a)
        self.assertIsNotNone(attempt_b)
        assert attempt_a is not None and attempt_b is not None
        self.assertEqual((attempt_a.kp_id, attempt_a.is_correct), ("kp-a", True))
        self.assertEqual((attempt_b.kp_id, attempt_b.is_correct), ("kp-b", False))
        self.assertIsNone(store.question_attempt("q-c"))
        # ★ 子串也不许命中（``LIKE '%qid%'`` / ``in`` 的典型误报），**两个方向都要**：
        #   库里只有 q-a-2 时，问 q-a 不能命中；库里只有 q-a 时，问 q-a-2 也不能命中。
        self.assertIsNone(store.question_attempt("q-a-2"))
        store.add_history(kp_id="kp-c", activity="quiz", is_correct=False, detail='{"qid": "q-a-2"}')
        attempt_short = store.question_attempt("q-a")
        self.assertIsNotNone(attempt_short)
        assert attempt_short is not None
        self.assertEqual(attempt_short.kp_id, "kp-a", "q-a 只能命中 q-a 那一行，不是 q-a-2")

    def test_question_attempt_ignores_non_quiz_activities(self) -> None:
        """非 ``quiz`` 的行**不算作答**（与 ``mistakes`` 的过滤口径一致）。

        ``detail`` 里凑巧带上 qid 的 qa / coding / animation 记录必须被跳过 ——
        否则「学生在对话里提到过这道题」会被判成「他已经做过了」。
        顺带钉住 ``_qid_from_detail`` 的**宽松解析**：坏 JSON 不该让判分 500。
        """
        store = self.open_store()
        for activity in ("qa", "coding", "animation"):
            store.add_history(
                kp_id="kp-a",
                activity=activity,
                is_correct=True,
                detail=json.dumps({"qid": "q-1"}, ensure_ascii=False),
            )
        self.assertIsNone(store.question_attempt("q-1"), "只有 activity='quiz' 才算作答")

        store.add_history(kp_id="kp-a", activity="quiz", is_correct=True, detail="这不是 JSON")
        self.assertIsNone(
            store.question_attempt("这不是 JSON"), "坏 detail 只该让这一行匹配不上，不该抛"
        )

    # -------------------------------------------------- touch_last_active --
    def test_touch_last_active_updates_only_that_column(self) -> None:
        """★ 刷活跃时间**只能动 ``last_active_at``**（这条方法存在的全部理由）。

        学段与章节必须**一字未动**：整行 upsert 的写法会把握在调用方手里的
        ``grade_level`` 快照写回去，把并发期间刚生效的学段打回旧值 —— 而且
        **不留 ``grade_history``**，库里的学段与轨迹从此互相矛盾。

        ``last_active_at`` 先被压成一个很久以前的哨兵值，否则「刷没刷到」
        在同秒内根本观察不出来（``int(time.time())`` 的粒度是秒）。
        """
        store = self.open_store()
        student_id = self.seed_student(store, grade="primary_low")
        store.set_current_chapter(student_id, "第2章 认识循环")
        store.conn.execute(
            "UPDATE student SET last_active_at = 12345 WHERE student_id = ?", (student_id,)
        )
        store.conn.commit()
        before = store.get_student(student_id)
        assert before is not None

        started = int(time.time())
        store.touch_last_active(student_id)
        after = store.get_student(student_id)
        assert after is not None

        self.assertGreater(after.last_active_at, 12345, "活跃时间必须真的被刷新")
        self.assertGreaterEqual(after.last_active_at, started)
        self.assertLessEqual(after.last_active_at, int(time.time()))
        # ★ 逐列对照：只有 last_active_at 允许变
        self.assertEqual(after.grade_level, before.grade_level)
        self.assertEqual(after.current_chapter, before.current_chapter)
        self.assertEqual(after.nickname, before.nickname)
        self.assertEqual(after.created_at, before.created_at)

    def test_touch_last_active_does_not_revert_a_concurrently_changed_grade(self) -> None:
        """★ 并发场景的正面用例：学段在「读快照」之后被改掉，刷活跃时间**不许**把它改回去。

        时序刻意复现生产路径：``get_student()`` 读一份快照 → （别处把学段改成 junior，
        例如 ``app/grade/rules.py`` 的自动判定或 ``POST /api/grade/override``）→
        收尾时刷活跃时间。走 ``upsert_student`` 的老写法在这一步会把学段**写回
        ``primary_low``**（对照断言就在下面几条），单列 UPDATE 则不会。
        """
        store = self.open_store()
        student_id = self.seed_student(store, grade="primary_low")
        snapshot = store.get_student(student_id)
        assert snapshot is not None

        # 别处改学段（学的与 rules.py 的 _apply() 同一列）
        store.conn.execute(
            "UPDATE student SET grade_level = 'junior' WHERE student_id = ?", (student_id,)
        )
        store.conn.commit()

        store.touch_last_active(student_id)
        self.assertEqual(
            self.grade_of(store, student_id),
            "junior",
            "刷活跃时间把并发期间刚生效的学段打回去了",
        )

        # 对照：老写法（用陈旧快照整行 upsert）**确实**会把学段打回去 ——
        # 这条对照说明本方法不是「多此一举」，而是唯一正确的写法。
        store.upsert_student(
            student_id, nickname=snapshot.nickname, grade_level=snapshot.grade_level
        )
        self.assertEqual(
            self.grade_of(store, student_id),
            "primary_low",
            "前提变了：upsert_student 不再覆盖 grade_level，本用例需要重新论证",
        )

    def test_touch_last_active_is_a_single_column_update_in_source(self) -> None:
        """★ 结构断言：实现里必须是一条**只写 ``last_active_at`` 的 UPDATE**。

        上面那两条行为断言只覆盖「结果」—— 而「先读一行、再写回两列」这种写法
        在**单线程测试里结果完全一样**：它读到的就是当前值。真正的故障只在
        「读与写之间别的请求改了学段」那条时序上发生（生产路径见
        ``routes/profile.py`` 那条 ``upsert_student(... grade_level=student.grade_level)``），
        单测造不出那条时序。所以这里对**实现形态**再做一次正向断言：
        走 ``upsert_student`` / 自己写 ``grade_level`` 的等价写法必须当场变红。
        """
        body = method_code("touch_last_active")
        self.assertIn("UPDATE student SET last_active_at", body, "必须是单列 UPDATE")
        self.assertNotIn("upsert_student", body, "整行 upsert 会把并发期间改掉的学段打回旧值")
        for column in ("grade_level", "current_chapter", "nickname", "created_at"):
            self.assertNotIn(
                column, body, f"刷活跃时间不许碰 {column}（哪怕只是写回它读到的值）"
            )

    def test_touch_last_active_does_not_create_a_student_row(self) -> None:
        """学生行不存在时**什么都不写**（不静默建行）。

        建行要一并决定学段与昵称（那是路由层冷启动的事，见 ``upsert_student``），
        存储层替它决定 = 凭空冒出一个 grade_level 空串的学生。
        """
        store = self.open_store()
        store.touch_last_active("stu-ghost")
        self.assertIsNone(store.get_student("stu-ghost"))

    # ---------------------------------------------------------- mistakes --
    def test_mistakes_default_limit_is_unchanged(self) -> None:
        """★ 不传参 = 从前的行为（``limit=50``），既有调用方 ``routes/study.py`` 逐字不变。

        造 55 个各错 1 次的知识点：默认只回 50 条 —— 这就是「界面上的累计答错次数
        永远停在 50」那个偏小的来源。
        """
        store = self.open_store()
        self._seed_mistakes(store, 55)

        records = store.mistakes()
        self.assertEqual(len(records), 50, "默认上限仍是 50")
        self.assertEqual(sum(r.wrong_count for r in records), 50, "截断之后求和 = 偏小")
        self.assertEqual(len(store.mistakes(limit=3)), 3)
        # ★ 边界口径**照旧**：limit=0 / 负数走 max(1, ...) → 至少 1 条（不是「返回空」）
        self.assertEqual(len(store.mistakes(limit=0)), 1)
        self.assertEqual(len(store.mistakes(limit=-5)), 1)

    def test_mistakes_limit_none_returns_everything(self) -> None:
        """``limit=None`` → 全量（错题本求和要的就是这个口径）。"""
        store = self.open_store()
        self._seed_mistakes(store, 55)

        everything = store.mistakes(limit=None)
        self.assertEqual(len(everything), 55)
        self.assertEqual(sum(r.wrong_count for r in everything), 55)
        # 默认那 50 条必须是全量的前缀（排序键一样，切的是尾巴而不是别的东西）
        self.assertEqual(everything[:50], store.mistakes())
        # 同一个 kp 错多次也照样累加（全量不等于「每个 kp 一条」）
        store.add_history(kp_id="kp-000", activity="quiz", question="再错一次", is_correct=False)
        refreshed = store.mistakes(limit=None)
        self.assertEqual(len(refreshed), 55)
        self.assertEqual(
            next(r for r in refreshed if r.kp_id == "kp-000").wrong_count,
            2,
            "同一个知识点的多次答错必须在 wrong_count 里累加",
        )

    def _seed_mistakes(self, store: LearningStore, count: int) -> None:
        """造 ``count`` 个各错 1 次的知识点（每个 kp 一条记录 → 记录数 = 次数）。"""
        for index in range(count):
            store.add_history(
                kp_id=f"kp-{index:03d}",
                activity="quiz",
                question=f"第 {index} 题：下面哪个说法对？",
                is_correct=False,
                detail=json.dumps({"qid": f"q-{index:03d}"}, ensure_ascii=False),
            )


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

        # 取一篇**会被拆成多块**的正文（>600 token）—— 单块文档测不出「拆分顺序是否稳定」。
        # 新教材里高中篇幅最长，用它；找不到就退到任意一篇，别让这条测试因为内容变化而硬失败。
        candidates = [ROOT / "knowledge" / "senior" / "prompt-sr.md"]
        candidates += sorted((ROOT / "knowledge" / "senior").glob("*.md"))[:1]
        path = next((p for p in candidates if p.exists()), None)
        self.assertIsNotNone(path, "knowledge/senior/ 下找不到任何教材，无法测分块幂等")

        doc = load_document(path)
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

    def test_parent_blocks_respect_the_size_contract(self) -> None:
        """节级父块的尺寸口径。

        ★★ 这条断言在 2026-09-19 接入 K12KnowledgeBase 时**改过口径**，理由要说清楚：

        原文断言「每个父块都落在 300–600」。那对新教材是**不可能满足**的 ——
        新库的一篇正文 = 一个知识点的一个学段 = **一个 ``##`` 节**，
        而小学低年级那一节本身就只有 100–190 token（这是《写作规范》定的字数区间：
        小学低 80–150 字）。一节天生就短，硬凑到 300 只能靠灌水或跨知识点拼接，
        两者都会让检索质量变差。

        ★ 而且「允许短块」**本来就是 chunker 写明的契约**，不是为迁移开的口子：
        ``plan_parent_blocks`` 的 docstring 原话是
        「超过 600 token 的小节在句子边界拆成多个父块，切点尽量落在 300–600 之间
        （**拆出来的块不会小于 300，除非整节本来就这么短**）」。

        所以真正该钉住的是这两条：
          1. **上限是硬的**：任何父块都不许超过 600（超了说明拆分逻辑坏了）；
          2. **下限只对「被拆出来的块」生效**：一篇文档拆成 ≥2 块时，
             每一块都必须 ≥300 —— 这才是有判别力的那一半
             （单块文档落到 <300 是内容天然短，不是 bug）。
        """
        per_doc: list[list[int]] = []
        for doc in self.docs:
            sizes = [self.counter(text) for _title, text, _idx in chunker.plan_parent_blocks(doc, self.counter)]
            if sizes:
                per_doc.append(sizes)

        self.assertTrue(per_doc, "没有任何父块，说明教材没被读到")

        over = [s for sizes in per_doc for s in sizes if s > chunker.PARENT_MAX_TOKENS]
        self.assertEqual(over, [], f"超上限的父块：{over}")

        # 只有「被拆过」的文档才谈得上下限：拆出来的每一块都必须够大
        too_small_after_split = [
            (sizes, s)
            for sizes in per_doc
            if len(sizes) > 1
            for s in sizes
            if s < chunker.PARENT_MIN_TOKENS
        ]
        self.assertEqual(
            too_small_after_split,
            [],
            f"拆分后仍有低于下限的父块（拆分逻辑坏了）：{too_small_after_split}",
        )

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
