# -*- coding: utf-8 -*-
"""随包只读知识库（关卡 E 缺陷回归，票 23 补）。

**缺陷是什么**：打包产物带了嵌入模型、带了 ``resources/``，却**没带 ``kb.sqlite``**。
新机器 ``userData`` 是空的 → 检索一路降级到 ``outline``（**0 命中**），
``/health`` 的 ``embedderReady`` 却仍是 ``true`` —— 表现「一切正常」，实际知识库是空的。

**本文件钉住四件事**（改坏任何一条都会让缺陷以别的形式回来）：

1. **解析顺序**：``K12_KB_PATH`` → 随包只读库 → per-user ``<data-dir>/shared/`` → 缺席（诚实降级、不崩）；
2. **只读语义**：随包库以 ``readonly=True`` 打开，写入必须**响亮地失败**，绝不就地改写分发资产；
3. **幂等**：同一目标连建两次，行数完全相同（不翻倍）；
4. **构建接线**：spec 收 kb、``build_server.py --verify`` 真的断言「可用」（而不是只看文件在不在）。

第 1 条用 ``patch`` 掉 ``retriever.bundled_kb_path`` 的接缝（见 ``app/config.py`` 的设计说明），
所以这些用例**不需要**真的有一份 ``resources/kb/kb.sqlite``，新机器 clone 下来就能跑。
"""

from __future__ import annotations

import os
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

from app.config import (  # noqa: E402
    BUNDLED_KB_FILENAME,
    BUNDLED_KB_RELATIVE,
    BUNDLED_KB_STAGING,
    bundled_kb_path,
)
from app.rag import retriever  # noqa: E402
from app.rag.contracts_bridge import RagSearchRequest  # noqa: E402
from app.store.connections import connect  # noqa: E402
from tests.test_store import FakeEmbedder, build_fixture_kb  # noqa: E402


class KbPathCase(unittest.TestCase):
    """提供「一份真实可用的夹具 kb」与「干净的环境变量」两个前提。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        # ★ K12_KB_PATH 若被外部环境设着，会让所有解析顺序断言失真 —— 先隔离干净。
        #   收尾必须**无条件** pop：条件式 pop 在「本类没设过、但环境里本来就有」
        #   的情况下会把它留在环境里，泄漏给后续测试类
        #   （表现为 test_personalization / test_profile_routes 间歇性红：推荐返回
        #     cold_start 而不是 empty，因为解析被短路到了一份真实 kb）。
        os.environ.pop(retriever.KB_PATH_ENV, None)
        self.addCleanup(os.environ.pop, retriever.KB_PATH_ENV, None)
        retriever.reset_services()
        self.addCleanup(retriever.reset_services)

    def bundled_copy(self, name: str = "bundled/kb.sqlite") -> Path:
        """建一份夹具 kb 并放在「模拟 bundled」的位置，返回它的路径。"""
        path = self.tmp / name
        path.parent.mkdir(parents=True, exist_ok=True)
        build_fixture_kb(self.tmp, kb_name="fx.sqlite", embedder=FakeEmbedder())
        shutil.copy(self.tmp / "shared" / "fx.sqlite", path)
        return path


# --------------------------------------------------------------------------- #
# ① 解析顺序
# --------------------------------------------------------------------------- #
class TestResolutionOrder(KbPathCase):
    """四级顺序：env → bundled → per-user → 缺席。"""

    def test_env_override_wins_over_everything(self) -> None:
        """★ ``K12_KB_PATH`` 必须**压过**随包库 —— 否则「指向坏库复现降级」的演示手法会失效。"""
        bundled = self.bundled_copy()
        per_user = self.tmp / "data" / "shared" / "kb.sqlite"
        per_user.parent.mkdir(parents=True, exist_ok=True)
        per_user.write_bytes(b"not a db")
        override = self.tmp / "somewhere-else.sqlite"

        with mock.patch.object(retriever, "bundled_kb_path", return_value=bundled):
            os.environ[retriever.KB_PATH_ENV] = str(override)
            self.assertEqual(retriever.default_kb_path(self.tmp / "data"), override)

    def test_bundled_wins_over_per_user(self) -> None:
        """★ 随包库必须**优先于** per-user 库。

        否则用户目录里只要留着一份旧库（上一次重建），刚装的版本反倒用不上新内容 ——
        「升级后检索到的还是老教材」这类问题就出在这里。
        """
        bundled = self.bundled_copy()
        per_user = self.tmp / "data" / "shared" / "kb.sqlite"
        per_user.parent.mkdir(parents=True, exist_ok=True)
        per_user.write_bytes(b"stale per-user kb")

        with mock.patch.object(retriever, "bundled_kb_path", return_value=bundled):
            self.assertEqual(retriever.default_kb_path(self.tmp / "data"), bundled)

    def test_per_user_used_when_no_bundled_copy(self) -> None:
        """开发态（``resources/kb/`` 没有库）：退回 ``<data-dir>/shared/kb.sqlite``。"""
        missing_bundled = self.tmp / "no-such-bundle" / "kb.sqlite"
        with mock.patch.object(retriever, "bundled_kb_path", return_value=missing_bundled):
            resolved = retriever.default_kb_path(self.tmp / "data")
        self.assertEqual(resolved, self.tmp / "data" / "shared" / "kb.sqlite")

    def test_absent_kb_returns_path_without_raising(self) -> None:
        """★ 三级全无 → 返回 per-user 路径，**不抛异常**。缺库是部署问题，由检索层诚实降级。"""
        missing = self.tmp / "missing" / "kb.sqlite"
        with mock.patch.object(retriever, "bundled_kb_path", return_value=missing):
            resolved = retriever.default_kb_path(self.tmp / "data")
        self.assertFalse(resolved.exists(), "本用例的前提就是「哪儿都没有库」")

    def test_dev_mode_is_unaffected_since_staging_is_not_in_resources(self) -> None:
        """★ 待打包的暂存位**不能**落在 ``resources/`` 里。

        它一旦落在 ``resources/kb/``，源码态跑单测/开发时就会命中随包分支，
        ``<data-dir>/shared/`` 的新库被悄悄顶掉 —— 开发期会看到「改了库但检索没变」。
        """
        self.assertNotEqual(
            BUNDLED_KB_STAGING.resolve(),
            bundled_kb_path().resolve(),
            "暂存位与运行期 bundled 路径必须分开（见 app/config.py 的说明）",
        )
        self.assertTrue(
            BUNDLED_KB_RELATIVE.parent.parts[0] == "resources"
            and BUNDLED_KB_RELATIVE.parent.parts[1] == "kb",
            f"随包 kb 必须落在 resources/kb/：{BUNDLED_KB_RELATIVE}",
        )
        self.assertEqual(BUNDLED_KB_RELATIVE.name, BUNDLED_KB_FILENAME)


# --------------------------------------------------------------------------- #
# ② 只读语义
# --------------------------------------------------------------------------- #
class TestBundledKbIsReadOnly(KbPathCase):
    def test_bundled_copy_opens_readonly_and_rejects_writes(self) -> None:
        """★ 随包资产**绝不允许被就地改写**：写入必须响亮地失败。"""
        bundled = self.bundled_copy()
        conn = connect(bundled, readonly=True)
        self.addCleanup(conn.close)

        # 能读
        kp = conn.execute("SELECT COUNT(*) FROM kp").fetchone()[0]
        self.assertGreater(kp, 0, "夹具库应有知识点")

        # 不能写 —— 且必须是**报错**，不是静默无操作（静默才是最危险的：分发资产被改了还看不出来）
        for sql in ("DELETE FROM kp", "UPDATE kp SET name = 'x'", "DROP TABLE kp"):
            with self.subTest(sql=sql):
                with self.assertRaises(sqlite3.Error):
                    conn.execute(sql)

    def test_rag_service_never_opens_kb_writable(self) -> None:
        """检索服务只走 ``readonly=True``（对齐 ``store/connections.py`` 的既有能力）。

        用包装 ``connect`` 的方式断言**调用参数**，而不是去猜它有没有写 ——
        这样即便将来有人加了一条写路径，也会在这里断掉。
        """
        bundled = self.bundled_copy()
        seen: list[dict] = []
        real_connect = retriever.connect

        def spy(path, **kwargs):
            seen.append({"path": Path(path), "readonly": kwargs.get("readonly")})
            return real_connect(path, **kwargs)

        with mock.patch.object(retriever, "connect", spy):
            service = retriever.RagService(bundled, embedder=FakeEmbedder())
            self.addCleanup(service.close)
            result = service.search(query="循环", grade_level="junior", top_k=3)

        self.assertTrue(result.hits, "夹具库问「循环」应有命中")
        self.assertTrue(seen, "应当真的开过连接")
        for call in seen:
            self.assertTrue(call["readonly"], f"检索开了可写连接：{call}")


# --------------------------------------------------------------------------- #
# ③ 幂等
# --------------------------------------------------------------------------- #
class TestBundledBuildIsIdempotent(KbPathCase):
    def test_building_twice_into_same_target_does_not_duplicate_rows(self) -> None:
        """★ 连建两次行数必须相同（``build_kb`` 的「先清再写」对 bundled 目标同样成立）。

        幂等现在是**在一个事务里**完成的（清表 + 写正文 + 重建 FTS + 写依赖图 → 一次 commit，
        见 ``tests/test_kb_rebuild_atomicity.py``）。所以这里除了「不翻倍」，
        还要确认**第二次建完之后 FTS 索引与正文仍然对得上** ——
        ``chunk_fts`` 是外部内容表，正文被清掉而索引没跟着重建的话，
        ``COUNT(*)`` 照样好看，检索却已经 0 命中（这正是原子性要守住的那条不变量）。
        """
        import build_kb  # scripts/build_kb.py
        from app.rag import chunker  # noqa: PLC0415
        from app.store.connections import connect  # noqa: PLC0415

        target = self.tmp / "staging" / "kb.sqlite"
        knowledge = Path(ROOT) / "knowledge"

        # 用启发式分词计数器：本用例只关心幂等，不该因为没下 90MB 模型而跳过
        first = build_kb.build(
            knowledge,
            target,
            embedder=FakeEmbedder(),
            counter=chunker.heuristic_token_count,
            print_report=False,
        )
        second = build_kb.build(
            knowledge,
            target,
            embedder=FakeEmbedder(),
            counter=chunker.heuristic_token_count,
            print_report=False,
        )

        self.assertEqual(first.stats, second.stats, "两次建库统计不一致（说明没先清表）")
        self.assertGreater(second.stats.get("kp", 0), 0)
        self.assertGreater(second.stats.get("chunk_vec", 0), 0)

        # ★ FTS5 trigram **至少 3 个字符**才可能命中（两字一律 0，实测），从库里取一段真正文当探针
        conn = connect(target, readonly=True, load_vec=False)
        try:
            text = str(
                conn.execute("SELECT text FROM chunk WHERE is_parent = 1 ORDER BY rowid LIMIT 1")
                .fetchone()["text"]
            )
            probe = re.split(r"[^\u4e00-\u9fff]+", text)[0][:6]
            fts_matches = int(
                conn.execute(
                    "SELECT COUNT(*) FROM chunk_fts WHERE chunk_fts MATCH ?", (probe,)
                ).fetchone()[0]
            )
        finally:
            conn.close()
        self.assertGreater(
            fts_matches, 0, f"连建两次之后 FTS 索引必须仍然能命中（探针 {probe!r}）"
        )


# --------------------------------------------------------------------------- #
# ④ 构建接线（spec / build_server）
# --------------------------------------------------------------------------- #
class TestBuildWiring(KbPathCase):
    def test_spec_registers_bundled_kb_and_knowledge_markdown(self) -> None:
        """spec 必须把「建好的 kb」与「教材 Markdown」都收进 datas。

        收 Markdown 是为了让用户**能重建**（重建能力随包），kb 是为了**不必重建**（首跑即用）。
        两者缺一都会退回不同的坏状态：缺 kb = 首跑 0 命中；缺 Markdown = 永远改不了内容。
        """
        spec = (ROOT / "packaging" / "k12-agent-server.spec").read_text(encoding="utf-8")
        self.assertIn("BUNDLED_KB_RELATIVE", spec, "spec 必须从 app.config 取 bundled kb 路径")
        self.assertIn("BUNDLED_KB_STAGING", spec, "spec 必须收构建期建好的那份 kb")
        self.assertIn('(str(ROOT / "knowledge"), "knowledge")', spec, "教材 Markdown 必须随包")

    def test_spec_fails_loudly_when_bundled_kb_missing(self) -> None:
        """★ 缺 kb 时**打包直接失败**，而不是打出一个「没有知识库」的包。"""
        spec = (ROOT / "packaging" / "k12-agent-server.spec").read_text(encoding="utf-8")
        self.assertIn("[spec][FATAL] 随包知识库不存在", spec)

    def test_build_server_builds_kb_before_packaging(self) -> None:
        """``build_server.py`` 在调 PyInstaller **之前**必须先建库。"""
        src = (ROOT / "scripts" / "build_server.py").read_text(encoding="utf-8")
        build_body = src[src.index("def run_build()") : src.index("def build_bundled_kb()")]
        self.assertIn("build_bundled_kb()", build_body, "run_build 必须先建 kb 再打包")
        self.assertLess(
            build_body.index("build_bundled_kb()"),
            build_body.index('"-m",'),
            "建库必须发生在起 PyInstaller 之前",
        )

    def test_normalize_shipped_kb_switches_to_rollback_journal(self) -> None:
        """★ 待分发的库必须是 rollback journal。

        ``mode=ro`` 打开 WAL 库时，SQLite 需要在同目录建 ``-shm``/``-wal``；
        安装目录（``Program Files``）对普通用户不可写 → ``unable to open database file``。
        这条断言钉住「发布的库不能是 WAL」，否则换台机器就是「知识库打不开」。
        """
        import build_server

        kb = self.bundled_copy(name="to-normalize/kb.sqlite")
        # 先把它变成 WAL（模拟 build_kb 的产物形态）
        conn = sqlite3.connect(str(kb))
        mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        conn.execute("CREATE TABLE IF NOT EXISTS t(x)")
        conn.commit()
        conn.close()
        self.assertEqual(str(mode).lower(), "wal")

        build_server.normalize_shipped_kb(kb)

        conn = sqlite3.connect(str(kb))
        try:
            final = conn.execute("PRAGMA journal_mode").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(str(final).lower(), "delete")
        leftovers = [p.name for p in kb.parent.iterdir() if p.name.startswith(kb.name + "-")]
        self.assertEqual(leftovers, [], f"不该留下 WAL 边车文件：{leftovers}")


# --------------------------------------------------------------------------- #
# ⑤ 端到端：空 data-dir + 随包 kb → 主路径检索（缺陷的直接回归）
# --------------------------------------------------------------------------- #
class TestFreshMachineEndToEnd(KbPathCase):
    """★ 这就是关卡 E 缺陷的回归用例：**新机器**（空 data-dir）首跑应能检索。

    修复前：``default_kb_path`` 只认 ``<data-dir>/shared/kb.sqlite``，
    空 userData → 文件不存在 → ``degraded="outline"`` + 0 命中。
    修复后：随包只读库被解析到 → ``degraded="vector"`` + 真命中。
    """

    def test_empty_data_dir_still_retrieves_from_bundled_kb(self) -> None:
        bundled = self.bundled_copy()
        empty_data_dir = self.tmp / "fresh-userData"
        empty_data_dir.mkdir()
        self.assertFalse(
            (empty_data_dir / "shared" / "kb.sqlite").exists(),
            "前提：模拟新机器，userData 下没有 kb",
        )

        with mock.patch.object(retriever, "bundled_kb_path", return_value=bundled):
            resolved = retriever.default_kb_path(empty_data_dir)
            self.assertEqual(resolved, bundled, "空 data-dir 时必须解析到随包只读库")
            service = retriever.get_service(data_dir=empty_data_dir, embedder=FakeEmbedder())
            self.addCleanup(service.close)
            result = service.search(query="循环", grade_level="junior", top_k=5)

        self.assertEqual(result.degraded, "vector", "主路径必须是 vector（修复前是 outline）")
        self.assertTrue(result.hits, "必须有命中（修复前是 0 命中）")
        # 夹具教材的知识点 id（见 tests/test_store.py 的 FIXTURE_DOC_JUNIOR）
        self.assertIn("fx-junior-a", {h.kp_id for h in result.hits})

    def test_http_route_on_empty_data_dir_returns_vector_hits(self) -> None:
        """HTTP 边界同样要能过 —— 前端与 Pi Tool 走的是这条。"""
        from fastapi.testclient import TestClient

        from app.config import build_runtime_config
        from app.main import create_app

        bundled = self.bundled_copy()
        empty_data_dir = self.tmp / "fresh-userData-http"
        empty_data_dir.mkdir()

        with mock.patch.object(retriever, "bundled_kb_path", return_value=bundled):
            app = create_app(build_runtime_config(data_dir=empty_data_dir))
            with mock.patch.object(
                retriever, "get_local_embedder", return_value=FakeEmbedder()
            ):
                retriever.get_service(data_dir=empty_data_dir, force_new=True)
                response = TestClient(app).post(
                    "/api/rag/search",
                    json={"query": "循环", "gradeLevel": "junior", "topK": 3},
                )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["degraded"], "vector", f"响应体={body}")
        self.assertTrue(body["hits"], "空 userData 下必须能检索到教材内容")

    def test_absent_kb_degrades_honestly_instead_of_crashing(self) -> None:
        """三级全无时：返回 ``outline`` + 空命中，**不抛异常**（演示不能因缺库崩掉）。"""
        missing = self.tmp / "nowhere" / "kb.sqlite"
        with mock.patch.object(retriever, "bundled_kb_path", return_value=missing):
            service = retriever.RagService(
                retriever.default_kb_path(self.tmp / "empty-data"),
                embedder=FakeEmbedder(),
            )
            self.addCleanup(service.close)
            result = service.search(query="循环", grade_level="junior", top_k=3)
        self.assertEqual(result.degraded, "outline")
        self.assertEqual(result.hits, [])


# --------------------------------------------------------------------------- #
# ⑥ 契约：请求体仍然只认契约字段（防止为了修 kb 顺手改了契约）
# --------------------------------------------------------------------------- #
class TestContractUntouched(unittest.TestCase):
    def test_request_model_fields_unchanged(self) -> None:
        self.assertEqual(
            set(RagSearchRequest.model_fields),
            {"query", "grade_level", "top_k", "allow_compat", "include_expansion"},
        )


if __name__ == "__main__":
    unittest.main()
