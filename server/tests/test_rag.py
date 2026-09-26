# -*- coding: utf-8 -*-
"""RAG 四级降级链 + 学段隔离（票 11，**关卡 C**）。

关卡 C 的两组判据在这里逐条落成断言：

1. **学段隔离**：初中提问不返回高中内容；向上兼容命中带 ``compat=true``；
2. **降级可触发**：向量 → 云端 → FTS5 → 大纲，每一级都能被单独逼出来，
   且 ``degraded`` 值正确（现场演示靠的是「把模型目录改名」「让 sqlite-vec 加载失败」两招，
   测试里用同样的两种手法逼降级 —— 演示与自动化验证走的是同一条路）。

夹具用 :class:`tests.test_store.FakeEmbedder`（不加载 90MB 模型），
所以这些用例在没下模型的新机器上也能跑。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from app.config import KNOWLEDGE_DIR  # noqa: E402
from app.knowledge import deps  # noqa: E402
from app.knowledge.deps import EXPANSION_LIMIT  # noqa: E402
from app.rag import retriever  # noqa: E402
from app.rag.contracts_bridge import contract_parity_report, field_diff  # noqa: E402
from tests.test_store import FakeEmbedder, build_fixture_kb  # noqa: E402

#: 检索锚点（★ 2026-09-19 随 K12KnowledgeBase 更新：旧 33 个 kp 的命名整体作废，
#: 新 kp_id 形如 ``<概念slug>-<pl|ph|jr|sr>``）。每个概念在四个学段各有一篇正文，
#: ``prog-loop`` 是「循环」这一概念。
LOOP_JUNIOR = "prog-loop-jr"
LOOP_PRIMARY_LOW = "prog-loop-pl"
LOOP_PRIMARY_HIGH = "prog-loop-ph"
LOOP_SENIOR = "prog-loop-sr"
VARIABLE_JUNIOR = "prog-variable-jr"

# 高中学段专有词（初中学段发问时**绝不能**命中它的内容）
SENIOR_ONLY_QUERY = "梯度下降"
# 双字词查询：trigram 匹配不到，靠 LIKE 兜底（FTS 降级路径的关键用例）
SHORT_QUERY = "循环"
# ★ 学生整句提问（逐字取自新教材初中「循环」正文）：中文没有分词器，
#   整句若不拆 n-gram 就匹配不到任何行 —— FTS 降级路径的关键用例。
SENTENCE_QUERY = "循环里忘了让条件变化会怎样"
# 教材里不存在的词（连 n-gram 都匹配不到）：用来把链路一路逼到 outline
ABSENT_QUERY = "量子纠缠退相干"


class RagCase(unittest.TestCase):
    """用真教材 + 夹具嵌入器建一次库，供全类复用。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        cls.kb_path = build_fixture_kb(
            cls.tmp, knowledge_dir=Path(KNOWLEDGE_DIR), kb_name="kb.sqlite"
        )

    @classmethod
    def tearDownClass(cls) -> None:
        retriever.reset_services()
        cls._tmp.cleanup()

    def setUp(self) -> None:
        retriever.reset_services()
        self.addCleanup(retriever.reset_services)
        self.embedder = FakeEmbedder()

    def service(self, **kwargs) -> retriever.RagService:
        service = retriever.RagService(
            self.kb_path, embedder=kwargs.pop("embedder", self.embedder), **kwargs
        )
        self.addCleanup(service.close)
        return service

    def grades_of(self, hits) -> set[str]:
        return {h.grade_level for h in hits}


# --------------------------------------------------------------------------- #
# 契约
# --------------------------------------------------------------------------- #
class TestContractWiring(unittest.TestCase):
    def test_models_come_from_app_contracts(self) -> None:
        """契约已由票 04 冻结：数据轨必须用契约里的模型，而不是自己的兜底定义。"""
        report = contract_parity_report()
        self.assertEqual(
            set(report.values()),
            {"app.contracts"},
            f"有模型仍走本地兜底：{report}",
        )

    def test_fallback_mirrors_contract_fields(self) -> None:
        """兜底定义与契约逐字段一致 —— 一旦漂移，这里立刻红。"""
        for name in ("Citation", "RagHit", "RagSearchRequest", "RagSearchResult", "DepNode"):
            diff = field_diff(name)
            self.assertEqual(diff, {"only_contract": [], "only_fallback": []}, f"{name}: {diff}")


# --------------------------------------------------------------------------- #
# 主路径：向量 + 学段隔离
# --------------------------------------------------------------------------- #
class TestVectorPathAndGradeIsolation(RagCase):
    def test_vector_level_hits_and_returns_degraded_vector(self) -> None:
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        self.assertEqual(result.degraded, "vector")
        self.assertTrue(result.hits, "初中学段问「循环」必须能命中（主路径）")
        self.assertIn(LOOP_JUNIOR, {h.kp_id for h in result.hits})

    def test_junior_query_never_returns_senior_content(self) -> None:
        """★ 关卡 C：初中提问不得返回高中学段的内容（不论问的是哪个词）。"""
        for query in (SENIOR_ONLY_QUERY, SHORT_QUERY, "什么是机器学习", ABSENT_QUERY):
            with self.subTest(query=query):
                result = self.service().search(query=query, grade_level="junior", top_k=5)
                self.assertNotIn(
                    "senior",
                    self.grades_of(result.hits),
                    f"学段泄漏：junior 提问「{query}」返回了高中内容",
                )

    def test_primary_low_query_never_returns_upper_grades(self) -> None:
        for query in (SHORT_QUERY, SENIOR_ONLY_QUERY, "什么是人工智能"):
            with self.subTest(query=query):
                result = self.service().search(query=query, grade_level="primary_low", top_k=5)
                self.assertTrue(self.grades_of(result.hits) <= {"primary_low"})

    def test_upward_compat_hits_are_flagged(self) -> None:
        """★ 向上兼容：高中生问基础问题可以拿到更低学段内容，但必须标 compat。"""
        result = self.service().search(query=SHORT_QUERY, grade_level="senior", top_k=8)
        lower = [h for h in result.hits if h.grade_level != "senior"]
        self.assertTrue(lower, "高中学段问「循环」应能命中初中学段的内容（向上兼容）")
        for hit in lower:
            self.assertTrue(hit.compat, f"{hit.kp_id} 来自 {hit.grade_level}，必须标 compat=true")
        for hit in result.hits:
            if hit.grade_level == "senior":
                self.assertFalse(hit.compat, "同学段命中不该标 compat")

    def test_allow_compat_false_restricts_to_exact_grade(self) -> None:
        allowed = self.service().search(query=SHORT_QUERY, grade_level="senior", top_k=8)
        strict = self.service().search(
            query=SHORT_QUERY, grade_level="senior", top_k=8, allow_compat=False
        )
        self.assertTrue(all(h.grade_level == "senior" for h in strict.hits))
        self.assertTrue(any(h.grade_level != "senior" for h in allowed.hits))

    def test_hit_context_is_parent_chunk_not_fragment(self) -> None:
        """★ 父子 chunk：命中子块，注入的是**父块完整内容**。"""
        conn = self.service()._ensure_conn()
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=3)
        for hit in result.hits:
            if hit.parent_chunk_id is None:
                continue
            parent = conn.execute(
                "SELECT text FROM chunk WHERE chunk_id = ?", (hit.parent_chunk_id,)
            ).fetchone()
            self.assertIsNotNone(parent)
            self.assertEqual(hit.text, parent["text"])
            child = conn.execute(
                "SELECT text FROM chunk WHERE chunk_id = ?", (hit.chunk_id,)
            ).fetchone()
            self.assertLessEqual(len(child["text"]), len(hit.text))

    def test_dedupe_keeps_one_hit_per_parent(self) -> None:
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=10)
        parents = [h.parent_chunk_id or h.chunk_id for h in result.hits]
        self.assertEqual(len(parents), len(set(parents)), "同一父块只应出现一次")


class TestTopKIsCountedAfterParentDedupe(RagCase):
    """★★ 回归用例（审计发现，修复前**必红**）：``top_k`` 曾被两级各自截断一次。

    缺陷形态：``_rows_to_hits`` 末尾先 ``hits[:top_k]``，``_to_hits`` 才做父块去重并**再截一次**。
    同一父块的多个子块排在前列时，去重会把名额吃掉 —— KNN 的过采样
    （``top_k * KNN_OVERFETCH``）**在去重之前就被切掉，等于白做**。

    实测（修复前，同一夹具库）：``top_k=5`` 去重后只剩 **4** 条；``top_k=8`` 只剩 7 条。
    修法：候选一律不截，截断只做一次 —— 在 ``_to_hits`` 的**去重之后**。
    """

    def test_direct_hits_reach_top_k(self) -> None:
        for top_k in (1, 2, 3, 5, 8):
            with self.subTest(top_k=top_k):
                result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=top_k)
                direct = [h for h in result.hits if not h.expanded]
                self.assertEqual(
                    len(direct),
                    top_k,
                    f"top_k={top_k} 时去重后只有 {len(direct)} 条直接命中"
                    "（截断发生在父块去重之前？）",
                )

    def test_vector_level_does_not_truncate_before_dedupe(self) -> None:
        """结构断言：``_rows_to_hits`` 返回的是**候选**，条数可以超过 ``top_k``。"""
        service = self.service()
        conn = service._ensure_conn()
        vector = service.embedder.embed_query(SHORT_QUERY)
        rows = retriever.kb_repo.knn_rows(
            conn, vector, ["junior", "primary_high", "primary_low"], k=5 * retriever.KNN_OVERFETCH
        )
        candidates = service._rows_to_hits(conn, rows, "junior")
        self.assertGreater(
            len(candidates), 5, "候选在父块去重之前就被截断了（过采样失效）"
        )
        parents = [h.chunk.parent_chunk_id or h.chunk.chunk_id for h in candidates]
        self.assertGreater(
            len(parents), len(set(parents)), "本夹具需要「同一父块的多个子块」才能照出缺陷"
        )

    def test_dedupe_still_removes_duplicate_parents(self) -> None:
        """修完截断顺序后，去重本身不许被削弱。"""
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=10)
        parents = [h.parent_chunk_id or h.chunk_id for h in result.hits]
        self.assertEqual(len(parents), len(set(parents)))

    def test_latency_is_sub_second(self) -> None:
        """检索延迟必须百毫秒级（这里用夹具嵌入器测链路开销）。"""
        service = self.service()
        service.search(query=SHORT_QUERY, grade_level="junior", top_k=5)  # 预热
        started = time.perf_counter()
        service.search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        elapsed_ms = (time.perf_counter() - started) * 1000
        self.assertLess(elapsed_ms, 1000, f"检索耗时 {elapsed_ms:.1f}ms 超过 1s")


# --------------------------------------------------------------------------- #
# 用途二：依赖图扩展（关卡 C 之外，但同属检索链）
# --------------------------------------------------------------------------- #
class TestDependencyExpansion(RagCase):
    """★ 票 12 用途二：检索命中之后，依赖图把**前置知识点**补进上下文。

    ★★ 2026-09-19 随 K12KnowledgeBase 更新：新库的边是「概念内四学段成链
    （全是 prerequisite）+ 概念间同学段 related」，所以旧断言「问循环补进变量」
    （那是旧库的一条 ``related`` 边，而且 ``related`` 本来就不参与扩展）必然红。

    改动后的断言不再钉某一个具体 id，而是钉**行为**：补进来的每一条都必须是
    「某个直接命中的知识点的、不超过 ``EXPANSION_MAX_DEPTH`` 跳的**前置**」，
    且落在允许的学段内 —— 这条不变量比旧写法更强（旧写法只查了一条边）。
    """

    def _get(self):
        conn = self.service()._ensure_conn()
        return conn

    def _prerequisite_closure(self, direct_ids: list[str], allowed: set[str]) -> set[str]:
        """直接命中集合的「前置闭包」（只看 prerequisite 边，深度同实现口径）。"""
        conn = self.service()._ensure_conn()
        closure: set[str] = set()
        for kp_id in direct_ids:
            for row in deps.prerequisites(
                conn, kp_id, max_depth=deps.EXPANSION_MAX_DEPTH, relation="prerequisite"
            ):
                if row.grade_level in allowed:
                    closure.add(row.kp_id)
        return closure

    def test_loop_query_pulls_in_prerequisite_context(self) -> None:
        """★ 问「循环」时返回的 Citation 里要能看到依赖图补进来的前置内容。

        ⚠️ 学生是初中学段：允许的学段是 junior + 更低（向上兼容），
        **高中学段的循环（``prog-loop-sr``）绝不能出现** —— 扩展同样受学段隔离约束。
        """
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        hits = result.hits
        direct = [h.kp_id for h in hits if not h.expanded]
        expanded = [h.kp_id for h in hits if h.expanded]

        self.assertIn(LOOP_JUNIOR, direct, "直接命中里应有初中「循环」")
        self.assertTrue(expanded, "依赖图没有把任何前置知识点补进来")
        closure = self._prerequisite_closure(direct, {"junior", "primary_high", "primary_low"})
        self.assertTrue(
            set(expanded) <= closure,
            f"补进来的内容不是任何直接命中的前置（方向或 relation 过滤写错了）："
            f"expanded={expanded}, 允许的前置闭包={sorted(closure)}",
        )
        self.assertNotIn(
            LOOP_SENIOR,
            {h.kp_id for h in hits},
            "初中学段问「循环」不该命中高中版（学段泄漏）",
        )

    def test_same_concept_lower_grades_are_the_expansion(self) -> None:
        """★ 具体到「同一概念的低学段正文」：高中生问循环，扩展必须带出初中/小学的循环。

        这是新库最典型的扩展动作（学段链就是 prerequisite 边），
        也是「跨学段衔接真实存在」在检索侧的证据。
        """
        conn = self.service()._ensure_conn()
        picked = deps.expansion_kp_ids(
            conn,
            [LOOP_SENIOR],
            grade_levels=["senior", "junior", "primary_high", "primary_low"],
            limit=EXPANSION_LIMIT,
        )
        self.assertEqual(
            picked,
            [LOOP_JUNIOR, LOOP_PRIMARY_HIGH],
            f"高中「循环」的前置应当是同概念的更低学段（越近越前），实际：{picked}",
        )

    def test_expansion_is_capped(self) -> None:
        """扩展必须有上限，不能把 top-k 挤满。"""
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        self.assertLessEqual(len([h for h in result.hits if h.expanded]), EXPANSION_LIMIT)
        direct = [h for h in result.hits if not h.expanded]
        self.assertGreater(len(direct), len([h for h in result.hits if h.expanded]))

    def test_expansion_can_be_disabled(self) -> None:
        result = self.service().search(
            query=SHORT_QUERY, grade_level="junior", top_k=5, include_expansion=False
        )
        self.assertFalse([h for h in result.hits if h.expanded])

    def test_expansion_never_leaks_higher_grades(self) -> None:
        """扩展同样受学段隔离约束（依赖边是跨学段的，这里最容易被绕过）。"""
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=8)
        self.assertNotIn("senior", self.grades_of(result.hits))


# --------------------------------------------------------------------------- #
# 空 query 与连接生命周期
# --------------------------------------------------------------------------- #
class TestEmptyQueryShortCircuit(RagCase):
    """★★ 回归用例（审计发现）：空 / 纯空白 query 曾被当**正常检索**处理。

    实测（修复前）：``search(query='', grade_level='junior')`` 返回 ``degraded='vector'``
    且 ``hits=7``（**比正常查询还多**），``'   '`` 同样 6 条 —— 向量对空串也给得出查询向量，
    于是 KNN 永远有 top-k 结果。返回一堆分数为正的无关片段比返回空更糟：
    模型会把它当教材讲。

    修法：``RagService.search`` 开头短路 —— 空/纯空白 → 空 hits + ``degraded="outline"``
    （**四级枚举内的取值**，诚实降级），并留一条 WARNING 供排查。
    """

    def test_blank_queries_return_empty_hits_with_outline(self) -> None:
        for query in ("", "   ", "\t\n ", "\u3000"):
            with self.subTest(query=query):
                result = self.service().search(query=query, grade_level="junior", top_k=5)
                self.assertEqual(result.hits, [], f"{query!r} 返回了无关片段")
                self.assertEqual(result.degraded, "outline")
                self.assertEqual(result.degraded in ("vector", "cloud", "fts", "outline"), True)

    def test_outline_value_is_within_the_frozen_enum(self) -> None:
        """★ ``degraded`` 只允许四级取值（TS 侧原样展示，多一个值就没人认）。"""
        for attribute in ("DEGRADED_VECTOR", "DEGRADED_CLOUD", "DEGRADED_FTS", "DEGRADED_OUTLINE"):
            self.assertIn(getattr(retriever, attribute), ("vector", "cloud", "fts", "outline"))

    def test_short_circuit_does_not_open_a_connection(self) -> None:
        """空 query 在**打开连接 / 跑嵌入之前**就返回（不该为一次空检索付嵌入代价）。"""
        service = self.service()
        result = service.search(query="   ", grade_level="junior")
        self.assertIsNone(service._conn, "空 query 不该建立数据库连接")
        self.assertEqual(result.degraded, "outline")
        self.assertFalse(result.attempts[0].ok)
        self.assertIn("query", result.attempts[0].detail)

    def test_non_blank_query_still_works(self) -> None:
        """反向：正常 query 不受短路影响。"""
        self.assertTrue(self.service().search(query=SHORT_QUERY, grade_level="junior").hits)


class TestEmbeddingConfigRegistersItsSecret(RagCase):
    """★ 内容安全与数据层的接线（审计发现 ``register_secret`` 全仓 0 调用点）。

    ``read_embedding_config`` 是 ``app/`` 范围内**唯一**读得到云端嵌入明文 Key 的地方
    （LLM 的明文 Key 在 ``routes/settings.py``，那条线是**未接线项**，见报告）。
    读出来的 Key 必须登记进日志脱敏名单，否则任何把 config 打进日志的代码都会漏出明文。
    """

    def test_cloud_api_key_is_registered_for_redaction(self) -> None:
        from app.rag.embedder import read_embedding_config
        from app.safety import guard

        secret = "sk-embed-abcdef0123456789"
        config_path = self.tmp / "config.json"
        config_path.write_text(
            json.dumps({"embedding": {"mode": "cloud_api", "api_key": secret}}),
            encoding="utf-8",
        )
        self.addCleanup(guard.clear_secrets)

        config = read_embedding_config(self.tmp)
        self.assertEqual(config["api_key"], secret)
        self.assertNotIn(secret, guard.redact_text(f"嵌入配置：{config}"))

    def test_absent_key_does_not_register_anything(self) -> None:
        """没有 Key 时不该往登记表里塞空串/短串（短串抹掉会造成大量误伤）。"""
        from app.rag.embedder import read_embedding_config
        from app.safety import guard

        (self.tmp / "config.json").write_text(
            json.dumps({"embedding": {"mode": "local_fastembed"}}), encoding="utf-8"
        )
        self.addCleanup(guard.clear_secrets)
        config = read_embedding_config(self.tmp)
        self.assertEqual(config["api_key"], "")
        self.assertEqual(config["mode"], "local_fastembed")


class TestConnectionLifecycle(RagCase):
    """★★ 回归用例（审计发现）：``_ensure_conn`` 无锁 → 并发首访建多条连接且多余的永不关闭。

    实测（修复前）：8 线程同时首访**真的建出 8 条连接**，``self._conn`` 只留最后一条，
    前 7 条既无引用也无 ``close()``（句柄泄漏 + 「一个服务一份连接」的假设失效）。
    """

    def _counting_service(self) -> tuple[retriever.RagService, list]:
        created: list = []
        original = retriever.connect

        def counting_connect(*args, **kwargs):  # noqa: ANN001
            conn = original(*args, **kwargs)
            created.append(conn)
            return conn

        retriever.connect = counting_connect  # type: ignore[assignment]
        self.addCleanup(setattr, retriever, "connect", original)
        service = retriever.RagService(self.kb_path, embedder=self.embedder)
        self.addCleanup(service.close)
        return service, created

    def test_concurrent_first_access_opens_exactly_one_connection(self) -> None:
        import threading

        service, created = self._counting_service()
        errors: list[BaseException] = []

        def touch() -> None:
            try:
                service._ensure_conn()
            except BaseException as exc:  # noqa: BLE001 - 线程里的异常要带回主线程
                errors.append(exc)

        threads = [threading.Thread(target=touch) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(len(created), 1, f"并发首访建立了 {len(created)} 条连接（应当只有 1 条）")

    def test_rebuilt_kb_closes_the_old_connection(self) -> None:
        """库被重建 → 关掉旧连接再重开（Windows 上旧句柄会让下一次全量重写撞上占用）。"""
        service, created = self._counting_service()
        first = service._ensure_conn()
        self.assertEqual(len(created), 1)

        stat = self.kb_path.stat()
        os.utime(self.kb_path, (stat.st_atime, stat.st_mtime + 5))  # 模拟 build_kb 重跑
        second = service._ensure_conn()
        self.assertEqual(len(created), 2, "库更新后应当重开连接")
        self.assertIsNot(first, second)
        with self.assertRaises(sqlite3.ProgrammingError):
            first.execute("SELECT 1")  # 旧连接必须真的关掉了

    def test_transient_vec_failure_is_recoverable(self) -> None:
        """★ 一次瞬时 KNN 错误不该把进程**永久**钉在 numpy 兜底上。

        失败时降级为 numpy（本次仍返回 ``degraded="vector"``），
        但重开连接时会**重新探测**向量引擎；``LevelAttempt.detail`` 里看得到降级原因。
        """
        service = self.service()
        conn = service._ensure_conn()
        self.assertTrue(service._vec_ready, "夹具库应当能用上 sqlite-vec")

        original = retriever.kb_repo.knn_rows

        def boom(*args, **kwargs):  # noqa: ANN001
            raise sqlite3.OperationalError("测试：模拟向量表损坏")

        retriever.kb_repo.knn_rows = boom  # type: ignore[assignment]
        self.addCleanup(setattr, retriever.kb_repo, "knn_rows", original)

        degraded = service.search(query=SHORT_QUERY, grade_level="junior", top_k=3)
        self.assertEqual(degraded.degraded, "vector", "numpy 兜底仍然算 vector 级")
        self.assertTrue(degraded.hits)
        self.assertFalse(service._vec_ready)
        detail = next(a.detail for a in degraded.attempts if a.level == "vector" and a.ok)
        self.assertIn("numpy", detail, "降级原因必须可观测")

        # 下一次 _ensure_conn（例如库更新/重连）会重新探测 → 向量路径恢复
        retriever.kb_repo.knn_rows = original  # type: ignore[assignment]
        service._close()
        service._ensure_conn()
        self.assertTrue(service._vec_ready, "重开连接后向量引擎应当恢复（瞬时错误不该永久降级）")
        recovered = service.search(query=SHORT_QUERY, grade_level="junior", top_k=3)
        detail = next(a.detail for a in recovered.attempts if a.level == "vector" and a.ok)
        self.assertIn("KNN", detail)
        self.assertFalse(service._vec_degraded)


class TestDegradationChain(RagCase):
    def _break_sqlite_vec(self) -> None:
        """②号演示手法：让 sqlite-vec 加载失败（等价于注释掉 sqlite_vec.load）。"""
        import app.store.connections as connections

        original = connections.load_sqlite_vec

        def boom(conn):  # noqa: ANN001
            raise connections.SqliteVecUnavailable("测试：模拟扩展缺失")

        connections.load_sqlite_vec = boom  # type: ignore[assignment]
        self.addCleanup(setattr, connections, "load_sqlite_vec", original)

    def test_level1_vector_with_numpy_sub_fallback(self) -> None:
        """★ 第 1 级内的子兜底：扩展不可用 → numpy 暴力余弦，**仍记 degraded=vector**。"""
        self._break_sqlite_vec()
        service = retriever.RagService(self.kb_path, embedder=self.embedder)
        self.addCleanup(service.close)
        result = service.search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        self.assertEqual(result.degraded, "vector")
        self.assertTrue(result.hits)
        self.assertIn(LOOP_JUNIOR, {h.kp_id for h in result.hits})
        notes = " ".join(a.detail for a in result.attempts if a.ok)
        self.assertIn("numpy", notes)

    def test_level3_fts_when_model_is_missing(self) -> None:
        """★ ①号演示手法：模型目录不可用（改名/换路径）→ 自动降级 FTS5 仍能检索。"""
        empty = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: os.environ.pop("K12_EMBEDDING_MODEL_DIR", None))
        os.environ["K12_EMBEDDING_MODEL_DIR"] = str(empty)

        from app.rag.embedder import LocalEmbedder

        service = retriever.RagService(
            self.kb_path, embedder=LocalEmbedder(model_dir=empty), embedding_config={"mode": "none"}
        )
        self.addCleanup(service.close)
        result = service.search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        self.assertEqual(result.degraded, "fts")
        self.assertTrue(result.hits, "FTS5 降级路径必须仍然检索得到「循环」")
        self.assertNotIn("senior", self.grades_of(result.hits))

    def test_level4_outline_when_nothing_matches(self) -> None:
        """★ ③号手法：模型不可用 + 无云端配置 + 关键词查不到 → 落到 outline。"""
        empty = Path(tempfile.mkdtemp())
        service = retriever.RagService(
            self.kb_path,
            embedder=None,
            embedding_config={"mode": "none"},
            data_dir=None,
        )
        service.embedder = retriever.LocalEmbedder(model_dir=empty)
        self.addCleanup(service.close)
        result = service.search(query=ABSENT_QUERY, grade_level="junior", top_k=5)
        self.assertEqual(result.degraded, "outline")
        self.assertTrue(result.hits, "大纲兜底要给模型「可讲的范围」，不能空手")
        self.assertNotIn("senior", self.grades_of(result.hits))
        self.assertTrue(all(h.score == 0.0 for h in result.hits))

    def test_level2_cloud_is_used_when_local_is_unavailable(self) -> None:
        """降级级 2：本地模型不可用但用户配了云端嵌入 → degraded=cloud。"""
        empty = Path(tempfile.mkdtemp())
        fake_cloud = FakeEmbedder()  # 云端「可用」时的行为等价于一个能编码的嵌入器

        original = retriever.build_cloud_embedder
        retriever.build_cloud_embedder = lambda cfg: fake_cloud  # type: ignore[assignment]
        self.addCleanup(setattr, retriever, "build_cloud_embedder", original)

        service = retriever.RagService(
            self.kb_path,
            embedder=retriever.LocalEmbedder(model_dir=empty),
            embedding_config={
                "mode": "cloud_api",
                "base_url": "https://example.invalid/v1",
                "api_key": "x",
                "model_id": "fake",
            },
        )
        self.addCleanup(service.close)
        result = service.search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        self.assertEqual(result.degraded, "cloud")
        self.assertTrue(result.hits)

    def test_cloud_without_config_is_skipped_not_attempted(self) -> None:
        """没配云端就不该发请求（断网演示的前提）。"""
        service = self.service(embedding_config={"mode": "none"}, embedder=None)
        service.embedder = retriever.LocalEmbedder(model_dir=Path(tempfile.mkdtemp()))
        result = service.search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        cloud_attempt = next(a for a in result.attempts if a.level == "cloud")
        self.assertFalse(cloud_attempt.ok)
        self.assertIn("未配置", cloud_attempt.detail)

    def test_chain_never_raises_when_kb_missing(self) -> None:
        """库还没建时，检索返回空结果 + outline，不抛异常（编排层不该处理部署问题）。"""
        service = retriever.RagService(self.tmp / "nope.sqlite", embedder=self.embedder)
        self.addCleanup(service.close)
        result = service.search(query=SHORT_QUERY, grade_level="junior")
        self.assertEqual(result.hits, [])
        self.assertEqual(result.degraded, "outline")

    def _fts_only_service(self) -> retriever.RagService:
        """本地模型不可用 + 没配云端：链路必然落在 FTS / 大纲这一档（要测的就是它）。"""
        service = retriever.RagService(
            self.kb_path,
            embedder=retriever.LocalEmbedder(model_dir=Path(tempfile.mkdtemp())),
            embedding_config={"mode": "none"},
        )
        self.addCleanup(service.close)
        return service

    def test_sentence_query_still_hits_on_fts_level(self) -> None:
        """★ 学生整句提问（逐字取自教材初中「循环」正文）在 FTS 级也必须能找到东西。

        中文没有分词器：整句若不拆 n-gram，会被当成一个十数字的词条，
        trigram 的 MATCH 与 LIKE 都匹配不到任何行 —— 「FTS 永不失败」就成了空话。
        """
        result = self._fts_only_service().search(
            query=SENTENCE_QUERY, grade_level="junior", top_k=3
        )
        self.assertEqual(result.degraded, "fts")
        self.assertIn(LOOP_JUNIOR, {h.kp_id for h in result.hits})

    # ------------------------------------------------------------------ 回归 --
    #: 常见学生提问（四学段都会问到的概念，逐条是从教材正文里问得出来的整句）。
    #: 它们**全部**必须在 FTS 级拿到候选 —— 见下一条用例为什么这是硬要求。
    COMMON_QUESTIONS = (
        "什么是循环",
        "循环里怎么累加总分",
        "为什么要用列表",
        "列表能用来做什么",
        "什么是条件判断",
        "变量是什么",
        "什么是人工智能",
        "机器学习和深度学习有什么区别",
        "什么是神经网络",
        "大语言模型是怎么工作的",
        "什么是提示词",
        "计算机视觉能做什么",
        "语音识别是怎么实现的",
        "数据在人工智能里有什么用",
        "算力是什么",
        "什么是监督学习",
        "强化学习是怎么回事",
        "什么是训练和推理",
        "为什么AI会出错",
        "智能体是怎么做计划的",
    )

    def test_common_questions_never_drop_to_outline(self) -> None:
        """★★ 回归：整句提问不许整批掉到大纲级（FTS 兜底失效）。

        缺陷形态（真实 kb 上实测，20 条常见提问里 4 条中招）：中文片段 ≤4 字**整词入列、
        不拆 n-gram**，于是「累加总分」只产出 3-gram「累加总/加总分」—— 而教材正文写的是
        「累加」「总分」，一个都匹配不上；更典型的「条件判断」（4 字，剥掉「什么是」之后的
        剩余部分）在正文里也从来不是连写的。加上覆盖率的分母是**所有 n-gram 碎片**
        （整句提问能拆出 10+ 条），一个真正相关的块也只能拿到 1/10 —— 于是**必然**被判掉。
        学生感觉到的就是「问得好好的，AI 却答得很泛」（其实是完全没有检索到内容）。

        这条把整张表钉住：**每一条**都要落在 fts 级且有命中。
        """
        service = self._fts_only_service()
        dropped: list[str] = []
        for question in self.COMMON_QUESTIONS:
            result = service.search(query=question, grade_level="junior", top_k=5)
            if result.degraded != "fts" or not result.hits:
                dropped.append(f"{question} → {result.degraded}（命中 {len(result.hits)} 条）")

        self.assertEqual(
            dropped,
            [],
            "下列整句提问在 FTS 级拿不到候选（分词/覆盖率又把它们判死了）：\n" + "\n".join(dropped),
        )

    def test_short_cjk_segments_also_produce_bigrams(self) -> None:
        """★ 根因守卫：中文片段**一律**产出 2-gram（短片段也要拆）。

        这一条单独把分词规则钉住，而不只是钉「那 20 条问题的结果」——
        否则将来有人为了「减少噪声词条」把短片段改回「整词入列」，表上可能一时看不出来，
        但「条件判断」「累加总分」这类**写在教材里的双字词组合**会立刻重新查不到。
        """
        from app.rag import fallback

        terms = fallback.query_terms("什么是条件判断")
        self.assertIn("条件", terms, "「条件判断」必须拆出「条件」—— 教材里就是这么写的")
        self.assertIn("判断", terms)
        self.assertIn("条件判断", terms, "整词也要留一条：四字术语在教材里常是连写")

        # 双字/三字片段同样要拆（此前「≤4 字整词入列」把这一整类都漏掉了）
        self.assertIn("循环", fallback.query_terms("循环"))
        self.assertIn("累加", fallback.query_terms("循环里怎么累加总分"))

    def test_coverage_denominator_counts_content_units_not_ngram_fragments(self) -> None:
        """★ 根因守卫：覆盖率的分母是**实词**，不是 n-gram 碎片。

        用「碎片数」当分母时，「循环里怎么累加总分」对一个真正讲循环的块给出 1/6 ≈ 0.17，
        低于 ``MIN_FTS_COVERAGE`` → 判掉。换成实词分母后同一块是 1/2 —— 这才是真实相关性。
        """
        from app.rag import fallback

        query = "循环里怎么累加总分"
        units = fallback.content_units(query)
        terms = fallback.query_terms(query)
        self.assertEqual(units, ["循环", "累加总分"], "虚词切出来的实词段")
        self.assertGreater(len(terms), len(units), "分词碎片本来就该比实词多")

        loop_text = "循环用于重复执行一段代码。它解决的是「一批数据挨个处理」这两类需求。"
        self.assertGreaterEqual(
            fallback._content_coverage(loop_text, units),  # noqa: SLF001 - 守卫钉的就是这个口径
            fallback.MIN_FTS_COVERAGE,
            "真正讲循环的块必须过线",
        )
        # ★ 反向对照：一个实词都没蒙中的块仍然要被判掉
        self.assertEqual(fallback._content_coverage("轮回一次就算一次", units), 0.0)
        # 纯虚词提问没有实词 → 交给调用方跳过过滤（那种查询本就不该在 FTS 级算命中）
        self.assertEqual(fallback.content_units("为什么"), [])
        self.assertEqual(fallback.content_units("怎么办"), [])

    def test_fts_rejects_weak_partial_matches(self) -> None:
        """只蒙中一个词条的块不算命中（否则会把不相干片段当教材喂给模型）。

        ★ 换了分母口径之后这条**依然必须成立**：SQL 会返回所有含「循环」的块（十几条），
        而提问里另有 3 个教材里根本不存在的实词 —— 覆盖率 1/4 < 1/3，全部判掉。
        """
        from app.rag import fallback

        conn = self.service()._ensure_conn()
        hits = fallback.fts_search(
            conn,
            query=ABSENT_QUERY,
            grade_levels=["junior", "primary_high", "primary_low"],
            requested_grade="junior",
            top_k=5,
        )
        self.assertEqual(hits, [])

        weak = "循环里的量子纠缠与薛定谔的猫坍缩算符"
        self.assertEqual(fallback.content_units(weak), ["循环", "量子纠缠", "薛定谔", "猫坍缩算符"])
        self.assertEqual(
            fallback.fts_search(
                conn,
                query=weak,
                grade_levels=["junior", "primary_high", "primary_low"],
                requested_grade="junior",
                top_k=5,
            ),
            [],
            "只命中 4 个实词里的 1 个，不该整片返回",
        )

    def test_outline_prefers_student_grade(self) -> None:
        """★ 大纲兜底要先把**学生自己学段**的内容摆出来。

        按 ``grade_level`` 字母序排会出事：'primary_low' > 'junior'（'p' > 'j'），
        初中生拿到的「可讲范围」会全是小学内容。
        """
        service = self.service(embedder=None)
        service.embedder = retriever.LocalEmbedder(model_dir=Path(tempfile.mkdtemp()))
        result = service.search(query=ABSENT_QUERY, grade_level="junior", top_k=3)
        self.assertEqual(result.degraded, "outline")
        self.assertEqual(result.hits[0].grade_level, "junior")


# --------------------------------------------------------------------------- #
# 上下文拼装与响应体
# --------------------------------------------------------------------------- #
class TestResponseShape(RagCase):
    def test_response_contains_hits_context_and_degraded(self) -> None:
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=3)
        payload = result.to_response()
        self.assertTrue(payload.hits)
        self.assertTrue(payload.context)
        self.assertEqual(payload.degraded, "vector")
        dumped = payload.model_dump(by_alias=True)
        # ★ 2026-09-26：新增 `attempts` / `gradeFilter` 两个**只读展示字段**
        #   （演示模式要看得见「试了哪几级、隔离条件长什么样」）。它们是纯附加的：
        #   老消费方不看即可，行为一字不变。
        self.assertEqual(set(dumped), {"hits", "context", "degraded", "attempts", "gradeFilter"})
        self.assertTrue(dumped["attempts"], "逐级记录必须真的有内容（否则降级链在界面上不可观测）")
        self.assertIn("vector", {item["level"] for item in dumped["attempts"]})
        self.assertIn("grade_level IN (", dumped["gradeFilter"])
        first = dumped["hits"][0]
        # 事件载荷的 5 个冻结字段 + 内部字段都要在（camelCase）
        for key in ("chunkId", "chapterTitle", "sectionTitle", "gradeLevel", "compat", "text", "kpId"):
            self.assertIn(key, first)

    def test_citation_projection_is_five_fields(self) -> None:
        """citation 事件只准投影 5 个冻结字段（票 13 的验收口径）。"""
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=2)
        for citation in result.citations:
            self.assertEqual(
                set(citation),
                {"chunk_id", "chapter_title", "section_title", "grade_level", "compat"},
            )

    def test_context_is_capped(self) -> None:
        hits = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=20).hits
        context = retriever.build_context(hits, max_chars=500)
        self.assertLessEqual(len(context), 520)


class TestGradeFilterTrace(RagCase):
    """★★ 展示用的学段过滤条件必须与**真正执行**的 SQL 同源（2026-09-26 演示模式）。

    ══════════════════════════════════════════════════════════════════════════
    这条守的是什么
    ══════════════════════════════════════════════════════════════════════════
    `RagSearchResult.gradeFilter` 会是演示模式屏幕上的一句原话（「学段隔离在 SQL 层强制，
    模型改不了 WHERE」）。如果它只是手写文案、与真正下发的 SQL 无关，那句展示就是装饰 ——
    答辩时被人追问一句「你怎么证明这就是它执行的 WHERE」就答不上来。

    ★ 判据用 **`sqlite3.set_trace_callback`**（抓真正执行过的语句），
      而不是读源码文本 —— 源码里出现过 `grade_level IN` 并不能证明这条查询真的被下发过。
    ★ 强制走 FTS 那条路（`embedder=None`）：向量那半会用 sqlite-vec / numpy，
      而 FTS 的 SQL 里**一定**带 `grade_level IN (?, …)`，所以判据是确定的。
    """

    def test_display_matches_executed_sql(self) -> None:
        from app.knowledge.library import compatible_grades
        from app.rag import fallback

        service = self.service(embedder=None)
        service.search(query=SHORT_QUERY, grade_level="junior", top_k=3)
        conn = service._conn
        self.assertIsNotNone(conn, "首次检索之后必须已有连接，否则 trace 抓不到任何东西")

        traced: list[str] = []
        conn.set_trace_callback(traced.append)
        try:
            result = service.search(query=SHORT_QUERY, grade_level="junior", top_k=3)
        finally:
            conn.set_trace_callback(None)

        allowed = compatible_grades("junior")
        payload = result.to_response()
        self.assertEqual(payload.grade_filter, fallback.grade_filter_sql(allowed))

        in_clauses = [sql for sql in traced if "grade_level IN (" in sql]
        self.assertTrue(in_clauses, f"这一轮应当有带学段过滤的 SQL：{traced}")
        for sql in in_clauses:
            fragment = sql.split("grade_level IN (", 1)[1].split(")", 1)[0]
            # 两种形态都要认：FTS / LIKE 那条路把学段作为**绑定参数**下发（`?`），
            # 而 sqlite-vec 的 KNN 那条路是**内联字面量**（`'junior','primary_high',…`）。
            # 无论哪种，**学段集合与顺序都必须与展示串逐字一致**。
            if "?" in fragment:
                self.assertEqual(
                    fragment.count("?"),
                    len(allowed),
                    f"实际执行的过滤条件有 {fragment.count('?')} 个占位符，展示串却列了 {len(allowed)} 个学段：{sql}",
                )
            else:
                executed = [item.strip().strip("'") for item in fragment.split(",") if item.strip() != ""]
                self.assertEqual(
                    executed,
                    list(allowed),
                    f"实际执行的 WHERE 与展示的 `gradeFilter` 不是同一份白名单：{sql}",
                )


class TestHttpRoute(RagCase):
    """HTTP 边界：契约字段名（camelCase）、状态码、路由挂载。"""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        from fastapi.testclient import TestClient

        from app.config import build_runtime_config
        from app.main import create_app
        from app.routes.graph import router as graph_router
        from app.routes.rag import router as rag_router

        app = create_app(build_runtime_config(data_dir=cls.tmp))
        # 数据轨的两个路由：main.py 由票 04 维护，这里显式挂载以便端到端验证
        app.include_router(rag_router)
        app.include_router(graph_router)
        cls.client = TestClient(app)

    def setUp(self) -> None:
        super().setUp()
        retriever.get_service(
            self.kb_path, embedder=self.embedder, force_new=True
        )

    def test_rag_search_returns_contract_shape(self) -> None:
        response = self.client.post(
            "/api/rag/search",
            json={"query": SHORT_QUERY, "gradeLevel": "junior", "topK": 3},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {"hits", "context", "degraded", "attempts", "gradeFilter"})
        self.assertEqual(body["degraded"], "vector")
        self.assertTrue(body["hits"])
        self.assertIn("chunkId", body["hits"][0])
        self.assertNotIn("senior", {h["gradeLevel"] for h in body["hits"]})

    def test_rag_search_rejects_unknown_field(self) -> None:
        """契约 forbid 额外字段：临时加松散字段必须 422。"""
        response = self.client.post(
            "/api/rag/search",
            json={"query": "循环", "gradeLevel": "junior", "oops": 1},
        )
        self.assertEqual(response.status_code, 422)

    def test_rag_search_rejects_bad_grade(self) -> None:
        response = self.client.post(
            "/api/rag/search", json={"query": "循环", "gradeLevel": "college"}
        )
        self.assertEqual(response.status_code, 422)

    def test_graph_deps_route(self) -> None:
        """后继方向（推荐路径的数据来源）。

        ★ 2026-09-19 随 K12KnowledgeBase 更新：新库的**同学段**后继走 ``related``
        （「变量 → 循环」），**同概念下一学段**走 ``prerequisite``（「变量（初中）→ 变量（高中）」）
        —— 两种关系各有一条，断言同时钉住两者（只钉一条会让另一条的方向错漏过去）。
        """
        response = self.client.get(
            f"/api/graph/deps/{VARIABLE_JUNIOR}", params={"max_depth": 1}
        )
        self.assertEqual(response.status_code, 200)
        nodes = response.json()
        by_id = {node["kpId"]: node for node in nodes}
        self.assertEqual(
            sorted(by_id),
            ["prog-loop-jr", "prog-variable-sr"],
            f"初中「变量」的 1 跳后继应当是同段的循环与同概念的高中篇，实际：{sorted(by_id)}",
        )
        self.assertTrue(all(node["direction"] == "successor" for node in nodes))
        self.assertEqual(by_id["prog-variable-sr"]["relation"], "prerequisite")
        self.assertEqual(by_id["prog-loop-jr"]["relation"], "related")

    def test_graph_deps_route_prerequisite_direction(self) -> None:
        """前置方向（检索扩展的数据来源）。深度 1 = 直接前置；默认深度会一直往上走。

        ★ 新库的「循环（初中）」直接前置是「循环（小学高）」（学段链，prerequisite）
        与「变量（初中）」（同学段 related）。
        """
        response = self.client.get(
            f"/api/graph/deps/{LOOP_JUNIOR}",
            params={"direction": "prerequisite", "max_depth": 1},
        )
        self.assertEqual(response.status_code, 200)
        by_id = {node["kpId"]: node for node in response.json()}
        self.assertEqual(
            sorted(by_id),
            [LOOP_PRIMARY_HIGH, "prog-variable-jr"],
            f"初中「循环」的 1 跳前置应当是同概念的上一学段与同段「变量」，实际：{sorted(by_id)}",
        )
        self.assertEqual(by_id[LOOP_PRIMARY_HIGH]["relation"], "prerequisite")
        self.assertEqual(by_id[LOOP_PRIMARY_HIGH]["gradeLevel"], "primary_high")

        transitive = self.client.get(
            f"/api/graph/deps/{LOOP_JUNIOR}", params={"direction": "prerequisite"}
        ).json()
        self.assertIn(
            LOOP_PRIMARY_LOW,
            {node["kpId"] for node in transitive},
            "默认深度应当一路走到小学低年级的那一篇（学段链是连通的）",
        )

    def test_graph_deps_unknown_kp_is_404(self) -> None:
        self.assertEqual(self.client.get("/api/graph/deps/nope").status_code, 404)

    def test_graph_deps_depth_is_capped(self) -> None:
        self.assertEqual(
            self.client.get(
                f"/api/graph/deps/{VARIABLE_JUNIOR}", params={"max_depth": 99}
            ).status_code,
            422,
        )


if __name__ == "__main__":
    unittest.main()
