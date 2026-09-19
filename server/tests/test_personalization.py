# -*- coding: utf-8 -*-
"""票 20：个性化闭环（画像 / 依赖图推荐 / 冷启动 / 跨会话记忆）。

这一组断言盯住五条「闭环只写不读」类的静默故障：

1. ★ **推荐由依赖图驱动**：掌握「人工智能的定义（小学低年级）」（`ai-definition-pl`）
   → 推荐它的后继「人工智能的定义（小学高年级）」（`ai-definition-ph`）——
   同一概念跨学段的链，`from` 是前置、`to` 是后继，方向搞反是静默错；
2. ★ **推荐随掌握度变化**（票 20 的「可演示数据流」）：同一份代码，连续答错某知识点后
   推荐的第一位换成它；
3. ★ **冷启动**：全新学生 id 直接问推荐 → 有图里的入口知识点，不空、不 500；
4. ★ **跨会话/重启记忆**：关掉库重开，掌握度 / 进度 / 徽章 / 画像全部还在
   （用**新的** `TestClient` 与**新的**库连接读一遍，而不是复用内存里的对象）；
5. **画像不缓存、不落第二份副本**：每次读都反映 `learning.db` 的当前值；
6. ★ **兴趣偏好有写入口且进入画像**（\"答题表现**和兴趣偏好**\"的后一半）：
   `PUT /api/profile/{id}/preferences` → `GET /profile.preferences` → 重启后仍在。
   ⚠️ 偏好**尚未**参与 `build_recommendation` 的计算（残留，见该用例的注释）。

依赖图用例需要真实知识库；缺 kb 时跳过并说明原因（不假装通过）。
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import build_runtime_config  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes.profile import (  # noqa: E402
    RECOMMEND_LIMIT,
    REVIEW_MASTERY_CEILING,
)
from app.routes.quiz import MASTERY_GAIN_CORRECT, MASTERY_UNLOCK_THRESHOLD  # noqa: E402

REAL_KB = Path(ROOT) / "_data" / "shared" / "kb.sqlite"


def _variant(qid: str, kp_id: str, *, answer: object = "2", rubric: str | None = None) -> dict:
    body: dict = {
        "qid": qid,
        "kpId": kp_id,
        "type": "blank",
        "stem": f"{kp_id} 的练习题",
        "referenceAnswer": answer,
        "explanation": "讲解",
        "options": None,
    }
    if rubric is not None:
        body["rubric"] = rubric
    return body


class PersonalizationCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.has_kb = REAL_KB.exists()
        if self.has_kb:
            (self.tmp / "shared").mkdir(parents=True, exist_ok=True)
            shutil.copy(REAL_KB, self.tmp / "shared" / "kb.sqlite")
        self.app = create_app(build_runtime_config(data_dir=self.tmp))
        self.client = TestClient(self.app)

    @property
    def student(self) -> str:
        return self._student

    def set_student(self, name: str) -> str:
        self._student = name
        return name

    def recommend(self, **params) -> object:
        return self.client.get(f"/api/profile/{self.student}/recommendation", params=params)

    def profile(self) -> object:
        return self.client.get(f"/api/profile/{self.student}")

    def register(self, questions: list[dict], *, grade: str = "junior") -> list[str]:
        response = self.client.post(
            f"/api/quiz/variants?student_id={self.student}",
            json={"gradeLevel": grade, "questions": questions},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return [item["qid"] for item in response.json()["questions"]]

    def answer(self, qid: str, value: object, *, correct: bool = True) -> dict:
        response = self.client.post(
            "/api/quiz/grade",
            json={
                "studentId": self.student,
                "qid": qid,
                "answer": value if correct else "完全不沾边的答案",
                "sessionId": "sess-personal",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def master(self, kp_id: str, *, prefix: str, count: int = 4) -> None:
        """把某知识点练到过阈值（4 × 0.15 = 0.6）—— 推荐应当随之改变。"""
        qids = self.register(
            [
                _variant(f"{prefix}-{i}", kp_id)
                for i in range(1, count + 1)
            ]
        )
        for qid in qids:
            result = self.answer(qid, "2")
            self.assertTrue(result["correct"])

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        db = self.tmp / "students" / self.student / "learning.db"
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        try:
            return list(conn.execute(sql, params))
        finally:
            conn.close()


# --------------------------------------------------------------------------- #
# 1. ★ 冷启动
# --------------------------------------------------------------------------- #
class TestColdStart(PersonalizationCase):
    def test_brand_new_student_gets_a_recommendation(self) -> None:
        """★ 全新学生 id 直接问 → 有推荐、不空、不 500（票 20 的冷启动验收）。"""
        self.set_student("student_fresh_20")
        response = self.recommend()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["studentId"], "student_fresh_20")
        self.assertEqual(body["source"], "cold_start")
        self.assertGreater(len(body["items"]), 0, "冷启动必须给出推荐（不是空屏）")
        self.assertLessEqual(len(body["items"]), RECOMMEND_LIMIT)
        for item in body["items"]:
            self.assertTrue(item["kpId"], "推荐条目必须有 kp_id")
            self.assertTrue(item["reason"], "推荐条目必须给可读理由")
            self.assertEqual(item["mastery"], 0.0, "新学生什么都没练过")
        self.assertTrue(body["summary"], "必须有可读总述")
        # 冷启动会把学生行建出来（否则画像端点会 404）
        self.assertEqual(self.profile().status_code, 200)

    def test_cold_start_does_not_error_without_knowledge_base(self) -> None:
        """★★ 知识库缺失时**退化**而不是 500：推荐空但可读，画像照常能读。

        「推荐能力受限」与「画像打不开」是两件事：掌握度/偏好落在学生自己的库里，
        与 kb 无关，不该被 kb 拖垮。
        """
        if not self.has_kb:
            self.skipTest("本机没有真实 kb，无法测「有 kb 而删掉」这条路径")
        shutil.rmtree(self.tmp / "shared")
        self.set_student("student_nokb")
        response = self.recommend()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["source"], "empty")
        self.assertEqual(body["items"], [])
        self.assertTrue(body["summary"], "没有推荐也要说清原因，不能留白")

    def test_cold_start_items_match_the_student_grade(self) -> None:
        """冷启动推荐要贴合学段（初中生不该被推小学的入口当作唯一选项）。"""
        if not self.has_kb:
            self.skipTest("需要真实依赖图")
        for grade in ("primary_low", "junior", "senior"):
            self.set_student(f"student_cold_{grade}")
            body = self.recommend(gradeLevel=grade).json()
            self.assertGreater(len(body["items"]), 0, f"{grade} 的冷启动应有推荐")
            grades = {item.get("gradeLevel") for item in body["items"]}
            self.assertNotEqual(
                grades,
                {None},
                f"{grade}：推荐条目应带学段（图里查得到）",
            )


# --------------------------------------------------------------------------- #
# 2. ★ 依赖图驱动的推荐
# --------------------------------------------------------------------------- #
@unittest.skipUnless(REAL_KB.exists(), f"缺少真实知识库 {REAL_KB}（先跑 scripts/build_kb.py）")
class TestGraphDrivenRecommendation(PersonalizationCase):
    """掌握「人工智能的定义（小学低年级）」→ 推荐它的后继「人工智能的定义（小学高年级）」。

    这一对来自新教材（K12KnowledgeBase）里**同一概念跨学段的链**：
    ``ai-definition-pl → ai-definition-ph → ai-definition-jr → ai-definition-sr``
    —— 概念内四学段成链、链上相邻两级是 ``prerequisite`` 边，正是「沿链推荐」的样本。
    """

    #: 链上的前置（也是整张依赖图的唯一根）
    PREREQUISITE = "ai-definition-pl"
    #: 它的直接后继（同一概念的下一个学段）
    SUCCESSOR = "ai-definition-ph"

    def test_mastering_prerequisite_recommends_its_successor(self) -> None:
        """★ 执行文档 §8.6 用途一的直接断言（也是汇报要念的那一条）。"""
        self.set_student("student_graph_chain")
        self.master(self.PREREQUISITE, prefix="chain")

        body = self.recommend(gradeLevel="junior").json()
        self.assertEqual(body["source"], "graph", "掌握后应走依赖图后继这条路径")
        ids = [item["kpId"] for item in body["items"]]
        self.assertIn(
            self.SUCCESSOR,
            ids,
            f"★ 掌握「人工智能的定义（小学低年级）」后应推荐依赖图里的后继"
            f"「人工智能的定义（小学高年级）」，实际推荐：{ids}",
        )
        successor = next(item for item in body["items"] if item["kpId"] == self.SUCCESSOR)
        self.assertTrue(successor["name"], "推荐条目应带上人类可读的名字（图里查得到）")
        self.assertGreaterEqual(successor["depth"], 1, "后继的跳数至少是 1")

    def test_recommendation_is_not_alphabetical_or_random(self) -> None:
        """★ 推荐来自依赖图，**不是**按 id 字典序取下一个、也不是随机取。

        两个方向合起来才有判别力（单看任一条会放过某些错误实现）：
          - 还没掌握前置时，后继 `ai-definition-ph` **不该出现** —— 依赖图是有方向的
            （冷启动给的是图里的入口，不会因为 ph 在字典序上紧挨着 pl 就把它带上）；
          - 掌握前置之后，它**必须出现** —— 说明真的沿 `prerequisite` 边走了一步。
        换成「把 kp 表按 id 排序取下一个未掌握项」第一条就会红；换成随机取第二条会红。
        """
        self.set_student("student_not_alpha")
        before = [item["kpId"] for item in self.recommend(gradeLevel="junior").json()["items"]]
        self.assertNotIn(
            self.SUCCESSOR, before, "还没掌握前置时，后继不该被推荐出来（依赖图是有方向的）"
        )
        self.master(self.PREREQUISITE, prefix="alpha")
        after = [item["kpId"] for item in self.recommend(gradeLevel="junior").json()["items"]]
        self.assertIn(self.SUCCESSOR, after, "掌握前置后，后继应当出现在推荐里")

    def test_mastering_two_links_walks_further_along_the_chain(self) -> None:
        """★ 沿链继续往深走：掌握链上前两级后，推荐推进到第三级，且不回推已掌握的两级。

        概念内四学段成链 ``ai-definition-pl → -ph → -jr → -sr``：
          - 掌握 ``-pl`` → 推 ``-ph``（见上一条用例）；
          - 再掌握 ``-ph`` → 推 ``-jr``：**链在往前走**，不是原地打转；
          - 两个已掌握的 kp **一个都不许出现在推荐里** —— ``recommend_next`` 必须过滤已掌握项，
            否则学生会被反复推回刚学会的内容（掌握前置 → 它的后继正是刚掌握的那个）。
        """
        self.set_student("student_graph_walk")
        self.master(self.PREREQUISITE, prefix="walk-1")
        middle = self.SUCCESSOR  # ai-definition-ph
        self.master(middle, prefix="walk-2")

        body = self.recommend(gradeLevel="junior").json()
        self.assertEqual(body["source"], "graph")
        ids = [item["kpId"] for item in body["items"]]
        self.assertIn(
            "ai-definition-jr", ids, f"掌握链上前两级后应推进到第三级，实际推荐：{ids}"
        )
        self.assertNotIn(self.PREREQUISITE, ids, "已掌握的第一级不该被推回来")
        self.assertNotIn(middle, ids, "已掌握的第二级不该被推回来（它是第一级的后继）")

    def test_recommendation_never_exceeds_the_limit(self) -> None:
        self.set_student("student_limit")
        ids = [item["kpId"] for item in self.recommend(gradeLevel="junior").json()["items"]]
        self.assertLessEqual(len(ids), RECOMMEND_LIMIT)
        self.assertEqual(len(ids), len(set(ids)), "推荐不应有重复条目")
        self.assertGreater(len(ids), 0, "冷启动也给得出推荐")


# --------------------------------------------------------------------------- #
# 3. ★ 推荐随掌握度变化（可演示数据流）
# --------------------------------------------------------------------------- #
@unittest.skipUnless(REAL_KB.exists(), f"缺少真实知识库 {REAL_KB}（先跑 scripts/build_kb.py）")
class TestRecommendationTracksMastery(PersonalizationCase):
    def test_wrong_answers_move_the_topic_to_the_front(self) -> None:
        """★ 票 20 的核心演示：「连续答错某知识点 → 下一轮更可能再考它」。

        步骤（可照念）：
          ① 新学生 → 推荐是冷启动入口；
          ② 在 A 上答对几道（掌握 A）→ 推荐换成 A 的后继（依赖图驱动）；
          ③ 在后继上**连续答错** → 它的掌握度掉到 0 且低于重练线 →
             推荐的第一位变成它（`source` 从 `graph` 变成 `review`）。
        """
        self.set_student("student_demo_flow")
        # ① 冷启动
        first = self.recommend(gradeLevel="junior").json()
        self.assertEqual(first["source"], "cold_start")

        # ② 掌握「人工智能的定义（小学低年级）」→ 推荐后继（同一概念的下一个学段）
        self.master("ai-definition-pl", prefix="demo-var")
        second = self.recommend(gradeLevel="junior").json()
        self.assertEqual(second["source"], "graph")
        self.assertIn("ai-definition-ph", [item["kpId"] for item in second["items"]])

        # ③ 在后继上连续答错 → 推荐第一位变成它（重练）
        bad = self.register([_variant("demo-loop-1", "ai-definition-ph")])
        for _ in range(3):
            self.answer(bad[0], "", correct=False)

        third = self.recommend(gradeLevel="junior").json()
        self.assertEqual(
            third["source"], "review", "★ 连续答错后应切到「优先重练」这条路径"
        )
        self.assertEqual(
            third["items"][0]["kpId"],
            "ai-definition-ph",
            "★ 连续答错的知识点必须排在推荐第一位",
        )
        self.assertLess(
            third["items"][0]["mastery"],
            REVIEW_MASTERY_CEILING,
            "只有掌握度低于重练线才该被排到最前",
        )
        self.assertIn("再练", third["summary"], "总述应能直接念给学生")

    def test_profile_endpoint_uses_the_same_recommender(self) -> None:
        """★ 两条端点**同一套推荐**（不许各算一份，否则会给出两个「下一步」）。"""
        self.set_student("student_same_source")
        self.master("ai-definition-pl", prefix="same")
        detail = [item["kpId"] for item in self.recommend(gradeLevel="junior").json()["items"]]
        profile_ids = self.profile().json()["recommendedKpIds"]
        self.assertEqual(
            profile_ids,
            detail,
            "`/profile` 的 recommendedKpIds 必须与 `/recommendation` 的条目一致（同一处实现）",
        )

    def test_recommendation_items_are_unique(self) -> None:
        """★ 推荐条目**不能重复**（同一知识点既是「待重练」又是别人的「后继」时）。

        实测踩到过：同一个知识点同时命中第①段（掌握度不够）与第②段
        （前置已掌握），于是推荐列表里出现两次，总述读成
        「先回头把某个知识点、同一个知识点再练熟一点」—— 一眼假。

        ★ 换到新教材后这条场景照旧成立：掌握 `ai-definition-pl`（它成为后继的来源），
          再在它的后继 `ai-definition-ph` 上答错（它成为待重练）—— 同一个 kp 同时命中两段。
        """
        self.set_student("student_dedup")
        # 掌握链路前一级（它成为后继的来源），再在后一级上答错（它成为待重练）
        self.master("ai-definition-pl", prefix="dedup-var")
        bad = self.register([_variant("dedup-loop-1", "ai-definition-ph")])
        self.answer(bad[0], "", correct=False)

        body = self.recommend(gradeLevel="junior").json()
        ids = [item["kpId"] for item in body["items"]]
        self.assertEqual(len(ids), len(set(ids)), f"推荐条目出现重复：{ids}")
        # 总述里也不该把同一个名字念两遍
        names = [item["name"] for item in body["items"]][:2]
        if len(names) == 2:
            self.assertNotEqual(names[0], names[1], f"总述会把同一个名字念两遍：{names}")

    def test_recommendation_choice_and_practice_agree(self) -> None:
        """★ 推荐要能真的去练：推荐的 kp_id 一定在题库或依赖图里（不是编的）。"""
        self.set_student("student_actionable")
        for item in self.recommend(gradeLevel="junior").json()["items"]:
            # 名称由依赖图的 kp 表解析而来（等于它真的存在于知识库里）
            self.assertNotEqual(
                item["name"],
                item["kpId"],
                f"推荐条目 {item['kpId']} 在依赖图里查不到名字（说明 kp_id 是编的）",
            )

    def test_cold_start_skips_already_mastered_topics(self) -> None:
        """已掌握的知识点不该被推荐回来（既不做「待重练」，也不当「起点」重复推）。

        ★ 这条断言的可达性在新教材下要说清楚（**不要**以为它覆盖了
          ``_entry_kp_ids(exclude=…)`` 那个分支）：掌握一个知识点后它必然有后继
          （新图里六个入口在本学段内各有 6–14 个后继），于是 ``source`` 走到 ``graph``，
          而 ``exclude`` 只在``source`` 落到 ``cold_start`` 时才生效 —— 当前图里
          **没有**「既是入口、又在本学段内没有后继」的 kp，那个分支今天是不可达的。
          真正被这条钉住的是：已掌握项（mastery ≥ 阈值）不会以任何身份出现在推荐里。
        """
        self.set_student("student_skip_mastered")
        self.master("ai-definition-pl", prefix="skip")
        body = self.recommend(gradeLevel="junior").json()
        ids = [item["kpId"] for item in body["items"]]
        for item in body["items"]:
            self.assertIsNotNone(item["kpId"])
        # 已掌握的不该被推荐回来（无论走哪一段）
        self.assertNotIn(
            "ai-definition-pl", ids, "已掌握的知识点被推荐回来了（它既不该重练也不该当起点）"
        )
        # 已掌握的不该作为「待重练」出现（它是 mastery ≥ 阈值）
        review_ids = [
            item["kpId"]
            for item in body["items"]
            if item["mastery"] < REVIEW_MASTERY_CEILING and item["kpId"] == "ai-definition-pl"
        ]
        self.assertEqual(review_ids, [], "已掌握的「人工智能的定义（小学低年级）」不该被当成待重练")


# --------------------------------------------------------------------------- #
# 4. ★ 跨会话 / 重启记忆
# --------------------------------------------------------------------------- #
class TestCrossSessionMemory(PersonalizationCase):
    """★ 关掉应用重开，掌握度 / 进度 / 徽章 / 画像全部还在（票 15/20 的验收项）。

    「重启」在测试里的等价操作：丢掉 `TestClient` 与全部内存对象，
    **新建 app + 新建客户端**（等价于新进程），再读同一份磁盘数据。
    """

    def setUp(self) -> None:
        super().setUp()
        self.set_student("student_persist")

    def _restart(self) -> TestClient:
        """模拟「关掉应用再打开」：新建 app 与客户端，复用同一个 data-dir。"""
        self.app = create_app(build_runtime_config(data_dir=self.tmp))
        self.client = TestClient(self.app)
        return self.client

    def test_mastery_progress_badge_survive_restart(self) -> None:
        qids = self.register(
            [_variant(f"persist-{i}", "ai-definition-pl") for i in range(1, 5)]
        )
        for qid in qids:
            self.answer(qid, "2")

        before_profile = self.profile().json()
        before_progress = self.client.get(f"/api/quiz/progress/{self.student}").json()

        # ★ 重启
        self._restart()

        after_profile = self.profile().json()
        after_progress = self.client.get(f"/api/quiz/progress/{self.student}").json()

        self.assertEqual(
            after_profile["mastery"], before_profile["mastery"], "重启后掌握度变了"
        )
        self.assertEqual(
            after_progress["levels"], before_progress["levels"], "重启后闯关进度变了"
        )
        self.assertEqual(after_profile["student"]["studentId"], self.student)
        # 徽章还在（它就是「曾经通关」的事实）
        self.assertTrue(
            any(level["badge"] for level in after_progress["levels"]),
            "重启后徽章丢了",
        )
        # 掌握度的具体值也对（0.6）
        self.assertAlmostEqual(after_profile["mastery"][0]["score"], 0.6, places=6)

    def test_history_survives_restart_with_session_ids(self) -> None:
        """★ 学习记录带 `session_id` 落库、重启后仍在（关联 Pi 会话的唯一方式）。"""
        qids = self.register([_variant("hist-1", "ai-definition-pl")])
        self.client.post(
            "/api/quiz/grade",
            json={
                "studentId": self.student,
                "qid": qids[0],
                "answer": "2",
                "sessionId": "session-abc-123",
            },
        )
        self._restart()
        rows = self.query(
            "SELECT session_id, activity FROM learning_history WHERE activity = 'quiz'"
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["session_id"], "session-abc-123")

    def test_recommendation_is_stable_across_restart(self) -> None:
        """推荐也跨重启稳定（它读的是同一份 `learning.db`）。"""
        self.master  # noqa: B018 - 文档用途，避免 linter 误判未使用
        qids = self.register(
            [_variant(f"rec-{i}", "ai-definition-pl") for i in range(1, 5)]
        )
        for qid in qids:
            self.answer(qid, "2")
        before = self.recommend(gradeLevel="junior").json()
        self._restart()
        after = self.recommend(gradeLevel="junior").json()
        self.assertEqual(
            [item["kpId"] for item in before["items"]],
            [item["kpId"] for item in after["items"]],
            "重启后推荐变了（说明它读了内存里的临时状态而不是学习记录）",
        )

    def test_students_remain_isolated_after_restart(self) -> None:
        """★ 一人一库：重启后两个学生的数据仍然互不可见。"""
        other = "student_other_20"
        self.register([_variant("iso-1", "ai-definition-pl")])
        self.answer("iso-1", "2")
        self._restart()
        # 另一个学生：自己的库里没有这道生成题（判分 404），推荐也不受第一个学生影响
        response = self.client.post(
            "/api/quiz/grade",
            json={"studentId": other, "qid": "iso-1", "answer": "2"},
        )
        self.assertEqual(response.status_code, 404)
        other_profile = self.client.get(f"/api/profile/{other}/recommendation")
        self.assertEqual(other_profile.status_code, 200)
        self.assertNotIn(
            "iso-1",
            json.dumps(other_profile.json(), ensure_ascii=False),
            "另一个学生的推荐里出现了别人的题",
        )


# --------------------------------------------------------------------------- #
# 5. 画像不缓存 / 合规
# --------------------------------------------------------------------------- #
class TestProfileBehaviour(PersonalizationCase):
    def test_profile_reflects_the_latest_state_every_time(self) -> None:
        """★ **不缓存、不落第二份副本**：每次读都反映当前库里的值（票 20）。

        `GET /profile` 在**还没有任何学习记录**时是 404（契约口径，见下一条用例）；
        一旦开始练习（登记生成题就会建立学生行），每次读都必须是最新值 ——
        缓存了的话第二次读会停在 0.15。
        """
        self.set_student("student_nocache")
        self.assertEqual(
            self.profile().status_code, 404, "没有任何记录时画像应是 404（不是空画像）"
        )

        qids = self.register([_variant("nc-1", "ai-definition-pl")])
        self.assertEqual(self.profile().json()["mastery"], [], "刚建行时还没有掌握度")
        self.answer(qids[0], "2")

        mastery = self.profile().json()["mastery"]
        self.assertEqual(len(mastery), 1)
        self.assertAlmostEqual(mastery[0]["score"], MASTERY_GAIN_CORRECT, places=6)

        # 再答一道：第二次读必须反映新值（缓存了就会停在 0.15）
        qids2 = self.register([_variant("nc-2", "ai-definition-pl")])
        self.answer(qids2[0], "2")
        mastery = self.profile().json()["mastery"]
        self.assertAlmostEqual(mastery[0]["score"], MASTERY_GAIN_CORRECT * 2, places=6)

    def test_profile_404_for_unknown_student(self) -> None:
        """画像端点对未建立记录的学生回 404（与 /recommendation 的冷启动口径**不同**）。

        `/profile` 是「读已有记录」，读不到就是 404；
        `/recommendation` 是「问下一步学什么」，全新学生是**正常用法**，所以自动建立。
        两者口径不同是有意的：前者用于注入 Prompt（要区分「没记录」），
        后者用于「第一次打开应用」。
        """
        response = self.client.get("/api/profile/student_never_seen_20")
        self.assertEqual(response.status_code, 404)
        self.assertIn("student_never_seen_20", response.json()["detail"])

    def test_recommendation_rejects_bad_student_id(self) -> None:
        for bad in ("x" * 65, "a b", "学段001"):
            response = self.client.get(f"/api/profile/{bad}/recommendation")
            self.assertEqual(response.status_code, 422, f"{bad!r} 应被 422 拒绝")

    def test_written_preference_reaches_the_profile_and_survives_restart(self) -> None:
        """★ 偏好进入画像（闭环的另一半：需求的「和兴趣偏好」）。

        需求要求「根据答题表现**和兴趣偏好**动态调整后续推荐」：答题表现那条链路
        （判分 → 掌握度 → 推荐）是通的，兴趣偏好此前**只有读、没有写** ——
        ``profile_pref`` 建好了、画像也读它，但生产代码从不写，等于断头路。

        这里断言新写入口把偏好真的送进画像（``GET /profile.preferences``），
        并跨「重启」（新建 app + 新建客户端）仍然在 —— 画像由 ``get_student_profile``
        Tool 注入每轮 Prompt，写进去的内容必须重启后照样读得到。

        ⚠️ **残留（不要假装已解决）**：``build_recommendation`` 目前**完全不读**
        ``preferences``（它只看掌握度 + 依赖图），所以本用例**不**断言「推荐因此改变」
        —— 那是后续工作。偏好当前的消费点是画像 → Prompt 注入，
        不是推荐算法。当推荐开始消费偏好时，这条注释与用例应一起更新。
        """
        self.set_student("student_pref_20")
        response = self.client.put(
            f"/api/profile/{self.student}/preferences",
            json={"key": "interest", "value": "喜欢机器人"},
        )
        self.assertEqual(response.status_code, 200, response.text)

        profile = self.profile().json()
        self.assertEqual(
            profile["preferences"],
            {"interest": "喜欢机器人"},
            "偏好没进画像的话，get_student_profile Tool 就永远看不到它（等于没写）",
        )

        # ★ 重启（新 app + 新客户端，等价于新进程）后仍在
        self.app = create_app(build_runtime_config(data_dir=self.tmp))
        self.client = TestClient(self.app)
        self.assertEqual(self.profile().json()["preferences"], {"interest": "喜欢机器人"})
        # 推荐端点照常可用（偏好写入不该把推荐链路弄坏）
        recommendation = self.recommend(gradeLevel="junior")
        self.assertEqual(recommendation.status_code, 200, recommendation.text)
        self.assertTrue(recommendation.json()["source"], "推荐来源必须仍然有值")

    def test_learning_db_field_inventory_is_minimal(self) -> None:
        """★ 数据合规（K12 未成年人）：字段清单过一遍，确认最小化采集。

        断言的是**列名集合**：新增一列即失败，逼着人回来确认
        「这一列是不是真的必要、有没有生物特征或无关个人信息」。
        """
        self.set_student("student_compliance")
        self.register([_variant("cmp-1", "ai-definition-pl")])
        self.answer("cmp-1", "2")

        expected = {
            # ★ ``current_chapter`` 是「学生在学哪一章教材」的标题（= kb 的 chapter_title），
            #   不是新的个人信息：它由学生在界面上自己选、服务端只存一个标题字符串，
            #   不采集姓名/联系方式/生物特征（下面那条 forbidden 断言仍然逐项挡着）。
            "student": {"student_id", "nickname", "grade_level", "created_at", "last_active_at",
                        "current_chapter"},
            "mastery": {"kp_id", "score", "attempts", "correct", "last_seen_at"},
            "learning_history": {"id", "ts", "session_id", "kp_id", "activity",
                                  "question", "is_correct", "detail"},
            "progress": {"kp_id", "stage", "badge", "updated_at"},
            "profile_pref": {"key", "value"},
            "grade_history": {"id", "ts", "turn", "from_level", "to_level", "source", "confidence"},
            "grade_signals": {"id", "ts", "session_id", "signal_type", "value", "raw"},
            "generated_question": {"qid", "kp_id", "grade_level", "type", "stem", "options",
                                   "reference_answer", "explanation", "rubric", "source",
                                   "created_at"},
        }
        for table, columns in expected.items():
            actual = {
                row["name"]
                for row in self.query(f"PRAGMA table_info({table})")
            }
            self.assertEqual(
                actual,
                columns,
                f"{table} 的字段清单变了 —— K12 数据最小化，新增字段必须在票里说明理由："
                f"多了 {sorted(actual - columns)}，少了 {sorted(columns - actual)}",
            )

        # 没有任何「生物特征 / 真实身份 / 联系方式」类的列
        all_columns = set()
        for table in expected:
            all_columns |= {row["name"] for row in self.query(f"PRAGMA table_info({table})")}
        for forbidden in ("face", "voice", "photo", "phone", "email", "real_name", "id_card"):
            self.assertNotIn(forbidden, all_columns, f"出现了不该采集的字段：{forbidden}")


if __name__ == "__main__":
    unittest.main()
