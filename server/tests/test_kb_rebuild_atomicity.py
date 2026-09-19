# -*- coding: utf-8 -*-
"""教材重建的**原子性**与 vec0 缺失容错（两个已实测复现的缺陷的回归）。

缺陷一：重建只在最后 commit 一次，但**清表已经先提交过**了
----------------------------------------------------------
``build_kb.build`` 的旧写法是「清表 → 写正文（内部 commit 过一次）→ 重建 FTS → 写依赖图 → commit」。
那次中途提交把 ``DELETE FROM chunk`` 永久落了盘，于是后面任何一步失败都留下**半成品库**：

- ``chunk`` 被清空，而 ``chunk_fts`` 是**外部内容表**（``content='chunk'``）——
  正文删掉后不重建索引，索引与正文就永久不一致（实测索引变空）；
- ``knowledge_dependencies`` 已被清空，依赖图没了。

触发场景不需要什么罕见条件：依赖清单里有一条悬空引用（**有意**报错中止），
或者**重建到一半关掉应用**（``_run_rebuild`` 跑在线程池里，``before-quit`` 走
``taskkill /PID /T /F``，重建被直接掐断）。

后果是「重建失败」这四个字底下藏着一份被改坏的库：FTS5 兜底级静默变成 0 命中、
检索扩展 / 推荐路径 / 学习地图同时失效 —— 学生只看到「重建失败」，
看不出旧内容已经坏了。实测真实随包库：``MATCH "人工智能"`` 从 99 掉到 0、
依赖边从 483 掉到 0，而 ``/api/knowledge/rebuild`` 的回执只有 ``ok=false``。

所以本文件的第一组用例钉的是**不变量**：重建失败时，库必须与重建前**逐项相等**。

缺陷二：``vec0`` 扩展加载不了时重建**必定失败**
----------------------------------------------
``clear_knowledge_tables`` 里 ``DELETE FROM chunk_vec`` 与 ``insert_chunk`` 写 vec0 那一步，
在扩展没加载时都会抛 ``OperationalError: no such module: vec0``，
于是 ``/api/knowledge/rebuild`` 永久失败，学生看到「重建失败（OperationalError）：no such module: vec0」。

而此时检索链**设计上仍然可用**（``embeddings_by_grade`` 的 numpy 暴力余弦兜底，
``chunk.embedding`` 全在）—— 一次明明能用的重建被报成失败，是最难查的那种假失败。
修法是让**只有** ``chunk_vec`` 这一张表的失败降级为告警（它是派生索引，不是唯一真相），
其余三张表照旧抛 —— 第二组用例两个方向都要钉住。

★ 全程只用 ``tempfile`` 与夹具库：**绝不重建 ``server/_data/`` 与 ``server/resources/`` 下的交付物**
（真实库那条用例也是先复制到临时目录再动）。
"""

from __future__ import annotations

import json
import re
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import build_kb  # noqa: E402  scripts/build_kb.py（scripts/ 直挂在 sys.path 上）
from app.knowledge.deps import DependencyGraphError  # noqa: E402
from app.rag import chunker  # noqa: E402
from app.store import connections  # noqa: E402
from app.store import kb as kb_repo  # noqa: E402
from app.store.connections import connect  # noqa: E402
from app.store.kb import KpRecord  # noqa: E402
from tests.test_store import FakeEmbedder, build_fixture_kb, write_fixture_knowledge  # noqa: E402

BUILD_KB_SOURCE = (ROOT / "scripts" / "build_kb.py").read_text(encoding="utf-8")

#: FTS 探针的**字符数下限**。★ trigram 分词器要求**至少 3 个字符**：问单字或两字一律 0 命中
#: （实测夹具库 ``MATCH "测试"`` = 0、``MATCH "测试是"`` = 2）——
#: 拿两字去断言会得到一个假的「FTS 坏了」。取 6 个字符，命中面足够窄也足够稳。
FTS_PROBE_CHARS = 6


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
def probe_for(kb_path: Path) -> str:
    """从库里**取一段真实正文**当 FTS 探针。

    ★ 为什么不写死一个词：探针是「这把 FTS 索引到底能不能命中」的判据，
      写死就与教材内容耦合 —— 夹具库与真实教材没有交集（实测拿夹具的
      「循环让同一」去查真实库 = 0 命中，那是探针不对而不是索引坏了）。
      取正文自己的一段，两边都对得上，换代也不会让测试变红。

    ★★ 必须是**连续汉字段**：``chunk_fts`` 用 trigram 分词器，索引是按**原文**
      切的三字滑窗 —— 拿「去掉标点后拼起来」的串去 MATCH 是查不到的
      （实测真实库首块里 «想好了。办法…» 这类位置：拼出来的 6 字短语 0 命中，
      同一段原文里连续的 4 字 4 条命中）。所以按非汉字切段、取最长的那一段。
    """
    conn = connect(kb_path, readonly=True, load_vec=False)
    try:
        row = conn.execute(
            "SELECT text FROM chunk WHERE is_parent = 1 ORDER BY rowid LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return ""
    runs = [run for run in re.split(r"[^\u4e00-\u9fff]+", str(row["text"])) if len(run) >= FTS_PROBE_CHARS]
    return runs[0][:FTS_PROBE_CHARS] if runs else ""


def snapshot(kb_path: Path, *, load_vec: bool = True, probe: str | None = None) -> dict[str, int]:
    """库的**一致性快照**：重建失败前后必须逐项相等的那几组数字。

    三组数字各对应一种半成品故障，缺一不可：

    - ``chunk`` —— 正文还在不在；
    - ``chunk_fts`` / ``fts_probe`` —— FTS 兜底级还能不能用（外部内容表的索引是不是空的）；
    - ``deps`` —— 依赖图（推荐路径 / 检索扩展 / 学习地图的数据源）还在不在。

    「chunk 被清空但 FTS 还在」与「FTS 空但 chunk 还在」都会被这组比对抓出来，
    所以不要只比其中一项。

    默认 ``readonly=True`` 打开：这是**别人（另一个连接 / 检索服务）看到的那一份**，
    比「本连接自己看得见什么」更接近要守住的东西；顺带也不会因为可写而扰动 WAL。
    """
    if probe is None:
        probe = probe_for(kb_path)
    conn = connect(kb_path, readonly=True, load_vec=load_vec)
    try:
        def count(sql: str, params: tuple = ()) -> int:
            try:
                return int(conn.execute(sql, params).fetchone()[0])
            except sqlite3.DatabaseError:
                # 表不存在（例如向量扩展没加载时的 chunk_vec）→ -1，与「存在但为 0」区分开
                return -1

        return {
            "chunk": count("SELECT COUNT(*) FROM chunk"),
            "chunk_fts": count("SELECT COUNT(*) FROM chunk_fts"),
            "fts_probe": count(
                "SELECT COUNT(*) FROM chunk_fts WHERE chunk_fts MATCH ?", (probe,)
            ),
            "deps": count("SELECT COUNT(*) FROM knowledge_dependencies"),
            "kp": count("SELECT COUNT(*) FROM kp"),
            "vec": count("SELECT COUNT(*) FROM chunk_vec"),
        }
    finally:
        conn.close()


def inject_dangling_dependency(knowledge_dir: Path, dest: Path) -> Path:
    """复制一份教材，并在 ``manifest.json`` 里塞一条**悬空引用**的依赖边。

    ★ 这不是「随手造个异常」，而是真实且**有意**的失败点（``app/knowledge/deps.py``
    对悬空引用是报错中止、不静默跳过）：它发生在清表与正文写入**之后**、
    收尾 commit **之前**，正好落在旧实现「第一阶段已经落盘」的窗口里。
    """
    shutil.copytree(knowledge_dir, dest)
    manifest_path = dest / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.setdefault("dependencies", []).append(
        {"from": "fx-junior-a", "to": "kp-does-not-exist", "relation": "prerequisite", "weight": 1.0}
    )
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return dest


def code_only(text: str) -> str:
    """去掉 docstring 与注释后的**可执行代码**（供结构断言使用）。

    ★ 结构断言只能对着代码看：注释里**必然会**用文字讨论被禁止/被接受的写法
      （``build_kb.py`` 那段注释就在解释「为什么只提交一次」），
      拿整段源码去 ``assertNotIn`` 会把「解释规则」误判成「违反规则」。
    """
    outside = "".join(text.split('"""')[::2])
    lines = [code for code in (line.split("#", 1)[0].strip() for line in outside.splitlines()) if code]
    return "\n".join(lines)


def rebuild(knowledge_dir: Path, kb_path: Path, **kwargs):
    """按测试口径调用 ``build_kb.build``（夹具嵌入器 + 启发式 token 计数，不加载 90MB 模型）。"""
    return build_kb.build(
        knowledge_dir,
        kb_path,
        embedder=kwargs.pop("embedder", None) or FakeEmbedder(),
        counter=chunker.heuristic_token_count,
        strict_terms=kwargs.pop("strict_terms", False),
        print_report=False,
        **kwargs,
    )


class RebuildCase(unittest.TestCase):
    """夹具：一份建好的小库 + 一份可被改坏的教材目录。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.kb = build_fixture_kb(self.tmp, embedder=FakeEmbedder())
        # build_fixture_kb 把夹具教材写在 <tmp>/knowledge（write_fixture_knowledge 的落点）
        self.knowledge = self.tmp / "knowledge"
        self.assertTrue(self.knowledge.is_dir(), "前提：夹具教材目录存在")


# --------------------------------------------------------------------------- #
# ① 失败的重建必须完整退回「重建前那一份」
# --------------------------------------------------------------------------- #
class TestFailedRebuildKeepsPreviousLibrary(RebuildCase):
    def test_dangling_dependency_leaves_kb_item_by_item_unchanged(self) -> None:
        """★ 核心不变量：重建失败后，库与重建前**逐项相等**（不是「大致还在」）。"""
        before = snapshot(self.kb)
        # 前提：这几个数字必须非零，否则「相等」是拿两份空库在比，测试会假绿
        self.assertGreater(before["chunk"], 0, "前提：重建前库里有正文")
        self.assertGreater(before["fts_probe"], 0, f"前提：FTS 探针 {probe_for(self.kb)!r} 应有命中")
        self.assertGreater(before["deps"], 0, "前提：重建前有依赖边")

        bad = inject_dangling_dependency(self.knowledge, self.tmp / "knowledge-dangling")
        with self.assertRaises(DependencyGraphError) as ctx:
            rebuild(bad, self.kb)
        self.assertIn("kp-does-not-exist", str(ctx.exception), "抛出的应当是那条悬空引用")

        after = snapshot(self.kb)
        for key in ("chunk", "chunk_fts", "fts_probe", "deps", "kp", "vec"):
            with self.subTest(field=key):
                self.assertEqual(
                    after[key],
                    before[key],
                    f"{key} 变了：重建失败把库改坏了（before={before} / after={after}）",
                )

    def test_rebuild_is_repeatable_after_a_failed_attempt(self) -> None:
        """失败之后**再重建一次**必须能成功 —— 半成品库最阴的地方就是「下次也建不起来」。"""
        bad = inject_dangling_dependency(self.knowledge, self.tmp / "knowledge-dangling")
        with self.assertRaises(DependencyGraphError):
            rebuild(bad, self.kb)

        result = rebuild(self.knowledge, self.kb)  # 修好的教材，重跑
        self.assertGreater(result.stats["chunk"], 0)
        after = snapshot(self.kb)
        self.assertGreater(after["fts_probe"], 0, "重建成功后 FTS 必须真的能命中")
        self.assertEqual(after["deps"], 2, "夹具 manifest 有 2 条依赖边")

    def test_uncommitted_rebuild_is_invisible_to_other_readers(self) -> None:
        """模拟「重建到一半关掉应用」：事务未提交时，别人读到的必须是**完整的旧库**。

        这是「一个事务」这个选择的**代价**，也是它的收益：重建期间整库对外不可见
        （不会有人读到半成品），进程消失时未提交的部分被整体丢弃。
        """
        before = snapshot(self.kb)

        conn = connect(self.kb, load_vec=False)
        try:
            # 这条连接没加载 vec0 扩展 → 清表那句会（按设计）留一句告警。它是被测行为的一部分，
            # 这里只借 assertLogs 收掉噪声（本用例断言的是另一个东西：别人看得见什么）。
            with self.assertLogs("app.store.kb", level="WARNING"):
                kb_repo.clear_knowledge_tables(conn)
            kb_repo.insert_kp(
                conn,
                KpRecord(
                    kp_id="half-built",
                    grade_level="junior",
                    name="写了一半",
                    chapter_title="第9章",
                    section_title="第1节",
                    summary="",
                ),
            )
            # ★ 不 commit：这正是进程被 taskkill 掐断时磁盘上的状态
            self.assertEqual(snapshot(self.kb), before, "未提交时另一个连接必须仍读到完整旧库")
        finally:
            conn.close()  # 等价于进程消失：未提交的事务被丢弃

        self.assertEqual(
            snapshot(self.kb), before, "未提交的写入不得在库里留下任何痕迹（kp/正文/FTS/依赖图）"
        )


# --------------------------------------------------------------------------- #
# ② 反向对照：正常重建必须真的生效
# --------------------------------------------------------------------------- #
class TestSuccessfulRebuildStillCommits(RebuildCase):
    def test_new_content_is_visible_after_rebuild(self) -> None:
        """★ 反向对照：防「把事务搞得谁都提交不了」这种假修复。

        只断言「行数不变」是不够的 —— 一个永远回滚的实现也能让行数不变。
        所以这里改一个知识点的名字，重建后必须能在库里读到**新值**。
        """
        edited = self.tmp / "knowledge-edited"
        shutil.copytree(self.knowledge, edited)
        doc = edited / "primary-low" / "fx-low-a.md"
        doc.write_text(
            doc.read_text(encoding="utf-8").replace("knowledge_point: 认识测试", "knowledge_point: 认识测试改版"),
            encoding="utf-8",
        )

        result = rebuild(edited, self.kb)
        self.assertGreater(result.stats["kp"], 0)

        conn = connect(self.kb, readonly=True, load_vec=True)
        try:
            name = conn.execute("SELECT name FROM kp WHERE kp_id = 'fx-low-a'").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(str(name), "认识测试改版", "重建成功后新内容必须真的落库（否则是假修复）")

        after = snapshot(self.kb)
        self.assertGreater(after["fts_probe"], 0, "新库的 FTS 索引必须建起来")
        self.assertEqual(after["deps"], 2)

    def test_building_twice_is_still_idempotent(self) -> None:
        """幂等仍然是幂等（「先清再写」在一个事务里同样成立）。"""
        first = rebuild(self.knowledge, self.kb)
        second = rebuild(self.knowledge, self.kb)
        self.assertEqual(first.stats, second.stats)


# --------------------------------------------------------------------------- #
# ③ vec0 缺失时：能用的重建不许报失败，但别的表照旧抛
# --------------------------------------------------------------------------- #
class TestVecUnavailableTolerance(RebuildCase):
    def test_clear_tolerates_vec_table_but_still_clears_the_real_tables(self) -> None:
        """``clear_knowledge_tables`` 在扩展不可用的连接上必须**不抛**，且其余表照常清空。"""
        conn = connect(self.kb, load_vec=False)  # 不加载扩展 —— 与扩展加载失败的现场一致
        self.addCleanup(conn.close)
        self.assertTrue(kb_repo.table_exists(conn, "chunk_vec"), "前提：库里确实有 vec0 表")
        self.assertFalse(connections.vec_available(conn), "前提：这条连接上没有 vec0 能力")

        with self.assertLogs("app.store.kb", level="WARNING") as logs:
            kb_repo.clear_knowledge_tables(conn)  # 旧实现这里抛 no such module: vec0

        self.assertTrue(
            any("chunk_vec" in line for line in logs.output),
            f"必须留一句可读日志说明「本次不写向量」：{logs.output}",
        )
        for table in ("chunk", "kp", "knowledge_dependencies"):
            with self.subTest(table=table):
                self.assertEqual(
                    conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0],
                    0,
                    f"{table} 是唯一真相，必须照旧被清空",
                )
        # 关键：同一事务内读，才看得到这些删除（本用例不提交，收尾靠 close 回滚）
        conn.rollback()

    def test_non_vec_table_failure_still_raises(self) -> None:
        """★ 只容忍 vec 表：``chunk`` / ``kp`` / ``knowledge_dependencies`` 清不掉时**必须抛**。

        它们的删除失败 = 清表没做完，继续往下写会得到「新内容混着旧内容」的库 ——
        那种库看起来完全正常，是最危险的坏法（所以不许顺手把真错误吞掉）。
        """
        conn = connect(self._tmp.name + "/empty.sqlite", load_vec=False)  # 空库：一张表都没有
        self.addCleanup(conn.close)

        with mock.patch.object(kb_repo, "table_exists", side_effect=lambda c, name: True):
            # vec 表那一步的告警是被容忍的那一半（这里不关心它，只借 assertLogs 把噪声收掉），
            # 真正要断言的是**紧接着的 chunk** 照样抛。
            with self.assertLogs("app.store.kb", level="WARNING"):
                with self.assertRaises(sqlite3.OperationalError) as ctx:
                    kb_repo.clear_knowledge_tables(conn)
        self.assertIn("chunk", str(ctx.exception).lower(), "抛出的应当是 chunk 那条 DELETE")

    def test_rebuild_succeeds_when_vec_extension_is_unavailable(self) -> None:
        """★ 扩展加载不了时 ``build()`` 必须**成功**，且检索链仍然可用（numpy 兜底）。"""
        with mock.patch.object(
            connections, "load_sqlite_vec", side_effect=connections.SqliteVecUnavailable("dll 缺失")
        ):
            # 这条路径**必然**留下「清了 chunk_vec / 写不进 chunk_vec」两句告警：
            # 它们是给排障的人看的（本次没有向量索引），这里不重复断言语义，
            # 只借 assertLogs 收掉噪声，免得刷在测试输出里。
            with self.assertLogs("app.store.kb", level="WARNING"):
                result = rebuild(self.knowledge, self.kb)

        self.assertGreater(result.stats["chunk"], 0, "正文必须写完")
        self.assertGreater(result.stats["chunk_fts"], 0, "FTS 必须建起来")
        self.assertEqual(result.stats["dependencies"], 2, "依赖图必须写完")
        self.assertTrue(
            any("sqlite-vec" in note for note in result.notes),
            f"回执要说明本次没有向量索引：{result.notes}",
        )

        # numpy 暴力余弦兜底的数据源仍在：chunk.embedding 一个都没少
        conn = connect(self.kb, load_vec=False)
        try:
            rows, matrix = kb_repo.embeddings_by_grade(conn, ["junior"])
        finally:
            conn.close()
        self.assertTrue(rows, "检索兜底必须有向量可取（否则主路径真的没了）")
        self.assertEqual(matrix.shape[1], 512, "向量维度仍是契约里的 512")

        after = snapshot(self.kb, load_vec=False)
        self.assertGreater(after["fts_probe"], 0, "这份库的 FTS 必须能命中")

    def test_vec_write_failure_warns_once_per_rebuild(self) -> None:
        """vec0 写入失败也只告警：一次重建上千个子块，逐条刷屏会把真正要看的那行淹掉。

        这里走的是**维度不符**那条路（``vec0`` 表建的时候钉死了 512 维）——
        它与「扩展不可用」是两件不同的事，却都以 ``sqlite3.Error`` 的形式出现：
        升级到 ``bge-base-zh-v1.5``（768 维）后忘了重建索引，就是这一条。

        顺带钉住「只告警一次」这件事本身：判据是模块级 ``_VEC_WRITE_WARNED``，
        **只影响日志频率，不影响行为**（写入失败一律跳过，正文照写）。
        """
        conn = connect(self.kb, load_vec=True)
        self.addCleanup(conn.close)
        if not connections.vec_available(conn):
            self.skipTest("本机 sqlite-vec 不可用，测不到「维度不符」这条路径")
        kb_repo.clear_knowledge_tables(conn)  # ★ 清表顺带把「本次重建已告过警」的记账清零（见 clear 的实现）
        kb_repo.insert_kp(
            conn,
            KpRecord("warn-once", "junior", "n", "第1章", "第1节", ""),
        )

        with self.assertLogs("app.store.kb", level="WARNING") as logs:
            for i in range(3):
                kb_repo.insert_chunk(
                    conn,
                    chunk_id=f"warn-{i}",
                    text="正文",
                    grade_level="junior",
                    chapter_title="第1章",
                    section_title="第1节",
                    knowledge_point="warn-once",
                    content_type="principle",
                    token_count=2,
                    embedding=[0.0] * 128,  # 维度不对 → vec0 必然拒绝
                )

        vec_warnings = [line for line in logs.output if "chunk_vec" in line]
        self.assertEqual(len(vec_warnings), 1, f"同一条原因只许说一次：{logs.output}")
        # 正文那一条 INSERT 不受影响：三行 chunk 都在（只有向量索引没写成）
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM chunk").fetchone()[0], 3, "正文必须照旧写进去"
        )

    def test_chunk_write_failure_is_not_swallowed(self) -> None:
        """正文那条 INSERT 照旧抛（``text`` 是 NOT NULL）—— 容错的边界只在 vec 表。"""
        conn = connect(self.kb, load_vec=False)
        self.addCleanup(conn.close)
        with self.assertRaises(sqlite3.IntegrityError):
            kb_repo.insert_chunk(
                conn,
                chunk_id="bad-not-null",
                text=None,  # type: ignore[arg-type]  # 故意违规
                grade_level="junior",
                chapter_title="第1章",
                section_title="第1节",
                knowledge_point="fx-junior-a",
                content_type="principle",
                token_count=2,
            )


# --------------------------------------------------------------------------- #
# ④ 结构断言：事务边界（防止中途 commit 被悄悄加回来）
# --------------------------------------------------------------------------- #
class TestTransactionBoundaryInSource(unittest.TestCase):
    """行为用例已经钉住了不变量，这里再钉**落点**：中途提交加回来是最容易犯的回退。"""

    def _function_code(self, name: str) -> str:
        marker = f"\ndef {name}("
        self.assertIn(marker, BUILD_KB_SOURCE, f"build_kb.py 里找不到 {name}()")
        body = BUILD_KB_SOURCE.split(marker, 1)[1].split("\ndef ", 1)[0]
        return code_only(body)

    def test_insert_documents_never_commits(self) -> None:
        """★ ``_insert_documents`` 里不许有任何 commit —— 那正是半成品库的成因。"""
        self.assertNotIn(
            "commit()",
            self._function_code("_insert_documents"),
            "_insert_documents 提前提交会把「清表」永久落盘，后面一步失败就留下半成品库",
        )

    def test_build_commits_exactly_once_and_last(self) -> None:
        """``build()`` 全程只提交一次，且必须在清表 / 写正文 / 重建 FTS / 写依赖**之后**。"""
        body = self._function_code("build")
        self.assertEqual(body.count("conn.commit()"), 1, f"只许有一次收尾提交：{body}")

        commit_at = body.index("conn.commit()")
        for step in (
            "kb_repo.clear_knowledge_tables(conn)",
            "_insert_documents(conn, docs, drafts, embedder)",
            "kb_repo.rebuild_fts(conn)",
            "insert_dependencies(conn, edges)",
        ):
            with self.subTest(step=step):
                self.assertIn(step, body, f"build() 里找不到这一步：{step}")
                self.assertLess(body.index(step), commit_at, f"{step} 必须发生在提交之前")

    def test_failure_path_rolls_back_explicitly(self) -> None:
        """异常路径要**显式**回滚，不能只靠 ``close()`` 的隐式行为（那是驱动的实现细节）。"""
        body = self._function_code("build")
        self.assertIn("conn.rollback()", body)
        self.assertLess(body.index("conn.rollback()"), body.index("conn.close()"))


# --------------------------------------------------------------------------- #
# ⑤ 真实随包库（复制到临时目录，绝不动交付物）：报告里那三组数字的对照
# --------------------------------------------------------------------------- #
def _real_kb() -> Path | None:
    for candidate in (ROOT / "resources" / "kb" / "kb.sqlite", ROOT / "_data" / "shared" / "kb.sqlite"):
        if candidate.exists():
            return candidate
    return None


@unittest.skipUnless(_real_kb() is not None, "本机没有可复制的真实随包库（新机器 clone 后跳过）")
class TestRealLibraryRebuildAtomicity(RebuildCase):
    """用**真实教材 + 真实随包库的副本**再走一遍：三组数字要能整份保住。

    夹具库只有 8 个 chunk，跑得出「没坏」，但证明不了规模下的同一件事
    （例如 FTS 索引在真实库上是 99 命中而不是 2）。全程只在 tempfile 里操作副本。
    """

    def setUp(self) -> None:
        super().setUp()
        source = _real_kb()
        assert source is not None  # skipUnless 已保证
        self.real_kb = self.tmp / "real-kb.sqlite"
        shutil.copy2(source, self.real_kb)
        self.real_knowledge = ROOT / "knowledge"
        self.assertTrue(self.real_knowledge.is_dir(), "真实教材目录必须存在")

    def test_failed_rebuild_of_the_real_library_keeps_it_intact(self) -> None:
        before = snapshot(self.real_kb)
        self.assertGreater(before["chunk"], 100, f"前提：真实库有内容：{before}")
        self.assertGreater(before["deps"], 100, f"前提：真实依赖图有边：{before}")

        bad = inject_dangling_dependency(self.real_knowledge, self.tmp / "real-knowledge-dangling")
        with self.assertRaises(DependencyGraphError):
            rebuild(bad, self.real_kb)

        after = snapshot(self.real_kb)
        for key in ("chunk", "chunk_fts", "fts_probe", "deps", "kp"):
            with self.subTest(field=key):
                self.assertEqual(after[key], before[key], f"{key} 被失败的重建改坏了：{before} → {after}")

    def test_successful_rebuild_of_the_real_library_matches_shipped_scale(self) -> None:
        """正常重建（真实教材 + 夹具嵌入器）也要一次成功，且规模与随包库同量级。"""
        result = rebuild(self.real_knowledge, self.real_kb)
        shipped = snapshot(self.real_kb)

        self.assertGreater(result.stats["kp"], 100, f"知识点规模不对：{result.stats}")
        self.assertGreater(result.stats["dependencies"], 100, f"依赖边规模不对：{result.stats}")
        self.assertGreater(shipped["fts_probe"], 0, "真实库重建后 FTS 必须能命中")


if __name__ == "__main__":
    unittest.main()
