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

import os
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
from app.knowledge.deps import EXPANSION_LIMIT  # noqa: E402
from app.rag import retriever  # noqa: E402
from app.rag.contracts_bridge import contract_parity_report, field_diff  # noqa: E402
from tests.test_store import FakeEmbedder, build_fixture_kb  # noqa: E402

# 高中学段专有词（初中学段发问时**绝不能**命中它的内容）
SENIOR_ONLY_QUERY = "梯度下降"
# 双字词查询：trigram 匹配不到，靠 LIKE 兜底（FTS 降级路径的关键用例）
SHORT_QUERY = "循环"
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
        self.assertIn("jr-py-loop", {h.kp_id for h in result.hits})

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
    def test_loop_query_pulls_in_variable_context(self) -> None:
        """★ 票 12 用途二：问「循环」时，返回的 Citation 里能看到「变量」。"""
        result = self.service().search(query=SHORT_QUERY, grade_level="junior", top_k=5)
        kp_ids = [h.kp_id for h in result.hits]
        self.assertIn("jr-py-loop", kp_ids)
        self.assertIn("jr-py-variable", kp_ids, "依赖图扩展没有把前置知识点「变量」补进来")
        expanded = [h for h in result.hits if h.expanded]
        self.assertTrue(expanded)
        self.assertIn("jr-py-variable", {h.kp_id for h in expanded})

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
# 四级降级
# --------------------------------------------------------------------------- #
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
        self.assertIn("jr-py-loop", {h.kp_id for h in result.hits})
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

    def test_sentence_query_still_hits_on_fts_level(self) -> None:
        """★ 学生整句提问（「循环里怎么累加总分」）在 FTS 级也必须能找到东西。

        中文没有分词器：整句若不拆 n-gram，会被当成一个 14 字词条，
        trigram 的 MATCH 与 LIKE 都匹配不到任何行 —— 「FTS 永不失败」就成了空话。
        """
        empty = Path(tempfile.mkdtemp())
        service = retriever.RagService(
            self.kb_path,
            embedder=retriever.LocalEmbedder(model_dir=empty),
            embedding_config={"mode": "none"},
        )
        self.addCleanup(service.close)
        result = service.search(query="循环里怎么累加总分", grade_level="junior", top_k=3)
        self.assertEqual(result.degraded, "fts")
        self.assertIn("jr-py-loop", {h.kp_id for h in result.hits})

    def test_fts_rejects_weak_partial_matches(self) -> None:
        """只蒙中一个二字片段的块不算命中（否则会把不相干片段当教材喂给模型）。"""
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
        self.assertEqual(set(dumped), {"hits", "context", "degraded"})
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
        self.assertEqual(set(body), {"hits", "context", "degraded"})
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
        response = self.client.get("/api/graph/deps/jr-py-variable")
        self.assertEqual(response.status_code, 200)
        nodes = response.json()
        self.assertTrue(nodes)
        self.assertEqual(nodes[0]["direction"], "successor")
        self.assertEqual(nodes[0]["kpId"], "jr-py-loop")

    def test_graph_deps_route_prerequisite_direction(self) -> None:
        """前置方向（检索扩展的数据来源）。深度 1 = 直接前置；默认深度会一直往上走。"""
        response = self.client.get(
            "/api/graph/deps/jr-py-loop",
            params={"direction": "prerequisite", "max_depth": 1},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([n["kpId"] for n in response.json()], ["jr-py-variable"])

        transitive = self.client.get(
            "/api/graph/deps/jr-py-loop", params={"direction": "prerequisite"}
        ).json()
        self.assertIn("jr-data-features", {n["kpId"] for n in transitive})

    def test_graph_deps_unknown_kp_is_404(self) -> None:
        self.assertEqual(self.client.get("/api/graph/deps/nope").status_code, 404)

    def test_graph_deps_depth_is_capped(self) -> None:
        self.assertEqual(
            self.client.get("/api/graph/deps/jr-py-variable", params={"max_depth": 99}).status_code,
            422,
        )


if __name__ == "__main__":
    unittest.main()
