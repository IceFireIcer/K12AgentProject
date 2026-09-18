# -*- coding: utf-8 -*-
"""知识点依赖图（票 12）：双用途 + 三条防护。

三条防护（业务陷阱清单 §3）在这里逐条落成断言，它们都是**静默错误或直接挂死**的那类问题：

1. 递归 CTE 无 ``depth`` 上限 → 元数据里一个笔误形成环，接口直接转死；
2. 环没在导入阶段被拦住 → 推荐路径与检索扩展全部失真，但图「看起来没问题」；
3. 悬空 ``to_kp_id`` 被静默跳过 → 少了一条依赖，没人发现。

另外两个用例覆盖**双用途**（推荐路径 / 检索扩展）—— 缺一个就少一条演示动作。
"""

from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.knowledge import deps  # noqa: E402
from app.knowledge.deps import (  # noqa: E402
    MAX_DEPTH_LIMIT,
    CycleError,
    DanglingReferenceError,
    DepEdge,
    expansion_kp_ids,
    find_cycles,
    graph_stats,
    insert_dependencies,
    load_adjacency,
    prerequisites,
    recommend_next,
    successors,
    validate_edges,
)
from app.knowledge.library import load_manifest  # noqa: E402
from tests.test_store import build_fixture_kb, open_kb  # noqa: E402

# 夹具知识点的 id（见 tests/test_store.py 的 FIXTURE_DOC_*）
LOW, MID, HIGH = "fx-low-a", "fx-junior-a", "fx-senior-a"


class GraphCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        cls.kb_path = build_fixture_kb(cls.tmp)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def setUp(self) -> None:
        self.conn = open_kb(self.kb_path)
        self.addCleanup(self.conn.close)
        self.addCleanup(deps.invalidate_cache)
        # 每个用例从「夹具自带的两条边」开始
        self.conn.execute("DELETE FROM knowledge_dependencies")
        self.conn.commit()
        insert_dependencies(
            self.conn,
            [
                DepEdge(LOW, MID),
                DepEdge(MID, HIGH),
            ],
        )


# --------------------------------------------------------------------------- #
# 防护一：环
# --------------------------------------------------------------------------- #
class TestCycleDetection(GraphCase):
    def test_cycle_error_reports_full_path(self) -> None:
        """★ 报错必须给出**完整环路路径**，不是只说「检测到环」。"""
        cycle_edges = [DepEdge(LOW, MID), DepEdge(MID, HIGH), DepEdge(HIGH, LOW)]
        with self.assertRaises(CycleError) as ctx:
            validate_edges(self.conn, cycle_edges)
        message = str(ctx.exception)
        self.assertIn("→", message)
        for kp in (LOW, MID, HIGH):
            self.assertIn(kp, message)
        # 完整路径（首尾相接）必须原样出现 —— 起点可能被旋转到字典序最小的节点
        rotations = [
            "→".join([LOW, MID, HIGH, LOW]),
            "→".join([MID, HIGH, LOW, MID]),
            "→".join([HIGH, LOW, MID, HIGH]),
        ]
        self.assertTrue(
            any(path in message for path in rotations),
            f"报错里没有完整环路：{message}",
        )

    def test_import_aborts_without_writing_any_edge(self) -> None:
        """校验不过 → 一条都不写（不允许写一半）。"""
        before = self.conn.execute("SELECT COUNT(*) FROM knowledge_dependencies").fetchone()[0]
        with self.assertRaises(CycleError):
            insert_dependencies(
                self.conn,
                [DepEdge(MID, HIGH), DepEdge(HIGH, MID)],
            )
        after = self.conn.execute("SELECT COUNT(*) FROM knowledge_dependencies").fetchone()[0]
        self.assertEqual(before, after)

    def test_self_loop_is_rejected(self) -> None:
        with self.assertRaises(CycleError):
            validate_edges(self.conn, [DepEdge(LOW, LOW)])

    def test_find_cycles_returns_rotation_deduplicated_paths(self) -> None:
        cycles = find_cycles([DepEdge(LOW, MID), DepEdge(MID, HIGH), DepEdge(HIGH, LOW)])
        self.assertEqual(len(cycles), 1, f"同一个环只应报一次：{cycles}")
        self.assertEqual(sorted(cycles[0][:-1]), sorted([LOW, MID, HIGH]))
        self.assertEqual(cycles[0][0], cycles[0][-1])

    def test_max_depth_cap_prevents_infinite_recursion(self) -> None:
        """★ 即使库里真的存在环（绕过导入校验写入），递归 CTE 也必须靠 depth 上限收住。"""
        self.conn.execute(
            "INSERT INTO knowledge_dependencies(from_kp_id, to_kp_id, relation, weight) "
            "VALUES(?,?,?,?)",
            (HIGH, LOW, "prerequisite", 1.0),
        )
        self.conn.commit()

        started = time.perf_counter()
        rows = successors(self.conn, LOW, max_depth=MAX_DEPTH_LIMIT)
        elapsed = time.perf_counter() - started

        self.assertLess(elapsed, 2.0, f"有环时递归 CTE 耗时 {elapsed:.2f}s —— 上限没生效？")
        self.assertTrue(rows)
        self.assertLessEqual(max(r.depth for r in rows), MAX_DEPTH_LIMIT)
        # 每个知识点只出现一次（DISTINCT + MIN(depth)）
        self.assertEqual(len({r.kp_id for r in rows}), len(rows))

    def test_depth_cap_is_clamped_for_absurd_requests(self) -> None:
        self.conn.execute(
            "INSERT INTO knowledge_dependencies(from_kp_id, to_kp_id, relation, weight) "
            "VALUES(?,?,?,?)",
            (HIGH, LOW, "prerequisite", 1.0),
        )
        self.conn.commit()
        rows = successors(self.conn, LOW, max_depth=10_000)
        self.assertLessEqual(max(r.depth for r in rows), MAX_DEPTH_LIMIT)


# --------------------------------------------------------------------------- #
# 防护二：悬空引用
# --------------------------------------------------------------------------- #
class TestDanglingReference(GraphCase):
    def test_dangling_target_raises_with_missing_id(self) -> None:
        """★ 悬空 ``to_kp_id`` 必须报错并中止，错误信息里要能看到缺失的 kp_id。"""
        with self.assertRaises(DanglingReferenceError) as ctx:
            insert_dependencies(self.conn, [DepEdge(MID, "fx-not-exist")])
        message = str(ctx.exception)
        self.assertIn("fx-not-exist", message)
        self.assertIn("to_kp_id", message)

    def test_dangling_source_raises(self) -> None:
        with self.assertRaises(DanglingReferenceError) as ctx:
            validate_edges(self.conn, [DepEdge("fx-ghost", MID)])
        self.assertIn("fx-ghost", str(ctx.exception))

    def test_illegal_relation_is_rejected(self) -> None:
        with self.assertRaises(deps.DependencyGraphError):
            validate_edges(self.conn, [DepEdge(LOW, MID, relation="depends_on")])

    def test_manifest_edges_are_validated_at_import(self) -> None:
        """真教材的 manifest.json 必须能全量导入（悬空/成环在建库时就该炸）。"""
        manifest = load_manifest(ROOT / "knowledge")
        self.assertGreater(len(manifest.dependencies), 0)
        for edge in manifest.dependencies:
            self.assertIn(edge.relation, ("prerequisite", "related"))


class RealCorpusCase(unittest.TestCase):
    """用真教材建一份库（夹具嵌入器），供「双用途」这类需要真实图结构的用例使用。

    依赖图是内容资产：`变量 → 循环` 这条边只存在于真教材的 manifest.json 里，
    用一份 mini 夹具断言它就等于没测到东西。
    """

    @classmethod
    def setUpClass(cls) -> None:
        from app.config import KNOWLEDGE_DIR

        cls._tmp = tempfile.TemporaryDirectory()
        cls.kb_path = build_fixture_kb(
            Path(cls._tmp.name), knowledge_dir=Path(KNOWLEDGE_DIR), kb_name="kb.sqlite"
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def setUp(self) -> None:
        self.conn = open_kb(self.kb_path)
        self.addCleanup(self.conn.close)
        self.addCleanup(deps.invalidate_cache)


# --------------------------------------------------------------------------- #
# 用途一：推荐路径
# --------------------------------------------------------------------------- #
class TestRecommendation(GraphCase):
    def test_recommendation_follows_the_graph_not_the_order(self) -> None:
        """推荐来自图，不是「按 id 顺序取下一个」。"""
        rows = recommend_next(self.conn, [LOW], max_depth=1)
        self.assertEqual([r.kp_id for r in rows], [MID])
        # 默认深度会给传递闭包：LOW → MID（1 跳）→ HIGH（2 跳）
        transitive = recommend_next(self.conn, [LOW])
        self.assertEqual([(r.kp_id, r.depth) for r in transitive], [(MID, 1), (HIGH, 2)])

    def test_mastered_nodes_are_not_recommended_again(self) -> None:
        rows = recommend_next(self.conn, [LOW, MID, HIGH])
        self.assertEqual(rows, [])

    def test_grade_filter_prevents_out_of_scope_recommendation(self) -> None:
        """给了学段就只推荐不高于该学段的内容（防超纲）。"""
        rows = recommend_next(self.conn, [MID], grade_level="junior")
        self.assertEqual(rows, [], "高中内容不该推荐给初中学段")
        unlimited = recommend_next(self.conn, [MID])
        self.assertEqual([r.kp_id for r in unlimited], [HIGH])

    def test_recommendation_is_depth_ordered(self) -> None:
        insert_dependencies(self.conn, [DepEdge(LOW, HIGH)])
        rows = recommend_next(self.conn, [LOW])
        self.assertEqual([r.depth for r in rows], sorted(r.depth for r in rows))


class TestRecommendationOnRealCorpus(RealCorpusCase):
    def test_recommend_after_mastering_variable_is_loop(self) -> None:
        """★ 真教材口径：掌握「变量」后推荐的后继必须是依赖图里的「循环」。"""
        rows = recommend_next(self.conn, ["jr-py-variable"], grade_level="junior")
        self.assertEqual([r.kp_id for r in rows][:1], ["jr-py-loop"])
        self.assertEqual(rows[0].direction, "successor")
        self.assertEqual(rows[0].name, "循环")


# --------------------------------------------------------------------------- #
# 用途二：检索扩展
# --------------------------------------------------------------------------- #
class TestExpansion(GraphCase):
    def test_expansion_excludes_seed_and_follows_prerequisite_edges_only(self) -> None:
        insert_dependencies(self.conn, [DepEdge(LOW, MID, relation="related")])
        # related 边不参与检索扩展（它只表示「相关」，不是讲授前提）
        self.assertEqual(
            expansion_kp_ids(self.conn, [MID], grade_levels=["junior"], limit=5), []
        )
        insert_dependencies(self.conn, [DepEdge(HIGH, MID, relation="prerequisite")])
        # 高学段的「前置」在初中学段里必须被过滤掉（扩展同样受学段隔离约束）
        self.assertEqual(
            expansion_kp_ids(self.conn, [MID], grade_levels=["junior"], limit=5), []
        )
        self.assertEqual(
            expansion_kp_ids(self.conn, [MID], grade_levels=["senior", "junior"], limit=5),
            [HIGH],
        )


# --------------------------------------------------------------------------- #
# ★ 回归：``related`` 边不得以「前置」身份出现（relation 过滤漏在 seed 侧）
# --------------------------------------------------------------------------- #
class TestRelationFilterOnSeed(GraphCase):
    """回归用例（审计发现，修复前**必红**）。

    ``_cte_walk`` 的 ``relation`` 过滤此前只拼在递归 ``step`` 上，
    **seed 那一半没有过滤** —— 于是「只有 ``A --related--> B`` 一条边」的 A
    会以**前置知识点**的身份被补进检索上下文（``prerequisites(B)`` 里能看到它）。
    这会让学生问「循环」时收到一段根本不是讲授前提的内容，而且图看起来完全正常。

    每个用例先把夹具自带的两条边清掉，只留本用例要验的那几条 ——
    否则断言会被夹具图的传递闭包淹没。
    """

    def _only(self, *edges: DepEdge) -> None:
        self.conn.execute("DELETE FROM knowledge_dependencies")
        self.conn.commit()
        insert_dependencies(self.conn, list(edges))

    def test_prerequisites_do_not_leak_related_edges(self) -> None:
        """A --related--> B、C --prerequisite--> B：前置只能是 C，不能是 A。"""
        self._only(
            DepEdge(LOW, MID, relation="related"),
            DepEdge(HIGH, MID, relation="prerequisite"),
        )
        rows = prerequisites(self.conn, MID, relation="prerequisite")
        self.assertEqual(
            [r.kp_id for r in rows],
            [HIGH],
            "只有 related 边的知识点被当成前置补了进来（relation 过滤漏在 seed 侧）",
        )
        for row in rows:
            self.assertEqual(row.relation, "prerequisite")

    def test_successors_do_not_leak_related_edges(self) -> None:
        """successor 方向同一条约束：`A --related--> B` 问 A 时不该说 B 是后继。"""
        self._only(DepEdge(LOW, MID, relation="related"))
        self.assertEqual(successors(self.conn, LOW, relation="prerequisite"), [])
        self.assertEqual([r.kp_id for r in successors(self.conn, LOW)], [MID])

    def test_deep_hops_also_filtered(self) -> None:
        """第 2 跳同样要过滤（只修 seed 而 step 漏掉的话这条会红）。

        LOW --related--> MID --related--> HIGH：问 HIGH 时两个 related 节点都不该出现。
        """
        self._only(
            DepEdge(LOW, MID, relation="related"),
            DepEdge(MID, HIGH, relation="related"),
        )
        self.assertEqual(prerequisites(self.conn, HIGH, relation="prerequisite"), [])
        # 反过来，把最外那条换成 prerequisite 就必须找得到它
        self._only(
            DepEdge(LOW, MID, relation="related"),
            DepEdge(MID, HIGH, relation="prerequisite"),
        )
        self.assertEqual(
            [r.kp_id for r in prerequisites(self.conn, HIGH, relation="prerequisite")], [MID]
        )

    def test_without_relation_filter_all_edges_are_returned(self) -> None:
        """不给 ``relation`` 时行为不变（两个方向的所有边都要能查出来）。"""
        self._only(DepEdge(LOW, MID, relation="related"))
        self.assertEqual([r.kp_id for r in prerequisites(self.conn, MID)], [LOW])
        self.assertEqual([r.relation for r in prerequisites(self.conn, MID)], ["related"])


class TestExpansionDepth(GraphCase):
    """回归用例（审计发现）：``expansion_kp_ids`` 的 depth 扫描此前每轮都把结果全写进字典，
    等于对同一个 seed 反复整树递归（``max_depth`` 次查询），并丢掉 ``weight`` 排序键。
    修复后一次 CTE 拿全部深度，再按 ``(depth, weight, kp_id)`` 取前 ``limit`` 个。

    这条断言用 **SQL 计数**钉住「一个 seed 一次查询」——只断言结果集的话，
    退回「N 次冗余扫描」也能全绿（结果集本来就等价）。
    """

    def _only(self, *edges: DepEdge) -> None:
        self.conn.execute("DELETE FROM knowledge_dependencies")
        self.conn.commit()
        insert_dependencies(self.conn, list(edges))

    def _chain(self) -> None:
        """LOW --prereq--> MID --prereq--> HIGH（问 HIGH 时 1 跳=MID、2 跳=LOW）。"""
        self._only(
            DepEdge(LOW, MID, relation="prerequisite"),
            DepEdge(MID, HIGH, relation="prerequisite"),
        )

    def test_deeper_prerequisites_are_returnable(self) -> None:
        self._chain()
        all_grades = ["senior", "junior", "primary_high", "primary_low"]
        two = expansion_kp_ids(self.conn, [HIGH], grade_levels=all_grades, max_depth=2, limit=2)
        self.assertEqual(two, [MID, LOW], "1 跳的前置应排在 2 跳之前，且两个都要能返回")
        one = expansion_kp_ids(self.conn, [HIGH], grade_levels=all_grades, max_depth=1, limit=2)
        self.assertEqual(one, [MID], "max_depth=1 不得越过 1 跳")

    def test_tighter_hop_wins_even_when_the_deeper_one_has_higher_weight(self) -> None:
        """排序键是 ``(depth, weight)``：更近的前置一定排在更远的前面。

        夹具 graph 里 LOW→MID→HIGH 是链，再加一条 LOW→HIGH 的直接边（权重给大），
        问 HIGH 时 1 跳应包含 LOW 与 MID（按 kp_id 排序），2 跳结果不参与竞争。
        """
        self._only(
            DepEdge(LOW, MID, relation="prerequisite"),
            DepEdge(MID, HIGH, relation="prerequisite"),
            DepEdge(LOW, HIGH, relation="prerequisite", weight=5.0),
        )
        picked = expansion_kp_ids(
            self.conn,
            [HIGH],
            grade_levels=["senior", "junior", "primary_high", "primary_low"],
            max_depth=2,
            limit=1,
        )
        self.assertEqual(len(picked), 1)
        self.assertIn(picked[0], (LOW, MID), "1 跳的前置不该被 2 跳的挤掉")

    def test_limit_zero_returns_nothing(self) -> None:
        self._chain()
        self.assertEqual(
            expansion_kp_ids(self.conn, [HIGH], grade_levels=["junior"], max_depth=2, limit=0),
            [],
        )

    def test_depth_scan_uses_one_query_per_seed(self) -> None:
        self._chain()
        seen: list[str] = []

        def trace(statement: str) -> None:  # noqa: ANN001 - sqlite3 trace 回调签名
            if statement.lstrip().upper().startswith("WITH RECURSIVE"):
                seen.append(statement)

        self.conn.set_trace_callback(trace)
        self.addCleanup(self.conn.set_trace_callback, None)
        expansion_kp_ids(
            self.conn,
            [HIGH],
            grade_levels=["senior", "junior", "primary_high", "primary_low"],
            max_depth=3,
            limit=2,
        )
        self.conn.set_trace_callback(None)
        self.assertEqual(len(seen), 1, f"一个 seed 应当只跑一次递归 CTE，实际 {len(seen)} 次")


class TestExpansionOnRealCorpus(RealCorpusCase):
    def test_prerequisites_of_loop_include_variable(self) -> None:
        """★ 检索扩展：问「循环」要补进「变量」的内容（真教材）。"""
        kp_ids = expansion_kp_ids(
            self.conn,
            ["jr-py-loop"],
            grade_levels=["junior", "primary_high", "primary_low"],
            limit=2,
        )
        self.assertIn("jr-py-variable", kp_ids)

    def test_expansion_respects_limit(self) -> None:
        kp_ids = expansion_kp_ids(
            self.conn,
            ["jr-py-loop"],
            grade_levels=["junior", "primary_high", "primary_low"],
            limit=1,
        )
        self.assertEqual(len(kp_ids), 1)

    def test_expansion_filtered_by_grade(self) -> None:
        """★ 扩展只允许不高于学生学段的内容：初中生的前置不该出现高中学段。"""
        kp_ids = expansion_kp_ids(self.conn, ["jr-py-loop"], grade_levels=["junior"], limit=5)
        self.assertIn("jr-py-variable", kp_ids)
        self.assertNotIn("ph-image-classification", kp_ids)


# --------------------------------------------------------------------------- #
# 邻接表缓存与图规模
# --------------------------------------------------------------------------- #
class TestAdjacencyAndStats(GraphCase):
    def test_adjacency_is_cached_by_mtime(self) -> None:
        first = load_adjacency(self.conn)
        second = load_adjacency(self.conn)
        self.assertIs(first, second, "同一份库应在内存里复用邻接表")

    def test_cache_is_invalidated_after_import(self) -> None:
        before = load_adjacency(self.conn)
        insert_dependencies(self.conn, [DepEdge(LOW, HIGH)])
        after = load_adjacency(self.conn)
        self.assertNotEqual(before.edge_count, after.edge_count)

    def test_graph_stats_counts_kp_and_edges(self) -> None:
        stats = graph_stats(self.conn)
        self.assertEqual(stats["kp"], 3, "夹具教材有 3 个知识点")
        self.assertEqual(stats["edges"], 2)
        self.assertEqual(stats["roots"], 1)
        self.assertFalse(bool(stats["cyclic"]))

    def test_direction_semantics_are_consistent(self) -> None:
        """``from`` 是前置、``to`` 是后继 —— 方向反了推荐与扩展会同时错，且看不出来。"""
        direct = successors(self.conn, LOW, max_depth=1)
        self.assertEqual([r.kp_id for r in direct], [MID])
        self.assertTrue(all(r.direction == "successor" for r in direct))

        # 默认深度会做传递闭包：LOW → MID → HIGH
        transitive = successors(self.conn, LOW)
        self.assertEqual([r.kp_id for r in transitive], [MID, HIGH])

        back = prerequisites(self.conn, HIGH, max_depth=1)
        self.assertEqual([r.kp_id for r in back], [MID])
        self.assertTrue(all(r.direction == "prerequisite" for r in back))

    def test_dep_rows_carry_name_and_grade(self) -> None:
        row = successors(self.conn, LOW)[0]
        self.assertTrue(row.name)
        self.assertEqual(row.grade_level, "junior")


if __name__ == "__main__":
    unittest.main()
