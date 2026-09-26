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
from app.main import create_app
from app.routes.students import open_learning_store  # noqa: E402
from app.routes.profile import (  # noqa: E402
    RECOMMEND_LIMIT,
    REVIEW_MASTERY_CEILING,
)
from app.routes.quiz import MASTERY_GAIN_CORRECT, MASTERY_UNLOCK_THRESHOLD  # noqa: E402

REAL_KB = Path(ROOT) / "_data" / "shared" / "kb.sqlite"


def _gq(qid: str) -> str:
    """用例里的短名 → 生成题的**真实** qid（幂等：已经带前缀的原样返回）。

    服务端硬校验 ``gen-`` 前缀（见 ``routes/quiz.py`` 的 ``GENERATED_QID_PREFIX``）：
    不带前缀的 qid 与题库真题同处一个命名空间，而判分**先查生成题** ——
    撞名等于把那道真题的标准答案静默改写。夹具里仍写短名（读起来清楚），
    由这里统一补前缀，**发出去的请求是真实形状**。
    """
    return qid if qid.startswith("gen-") else f"gen-{qid}"


def _variant(qid: str, kp_id: str, *, answer: object = "2", rubric: str | None = None) -> dict:
    body: dict = {
        "qid": _gq(qid),
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
                # 夹具里 qid 既可以写短名、也可以是 `register` 回传的真名 → `_gq` 幂等补前缀
                "qid": _gq(qid),
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
        # ★ D-074：冷启动不再走「图里的入口知识点」，来源是 `random`
        #   （从本学段、还没学过的里随机挑）
        self.assertEqual(body["source"], "random")
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

    def test_suggestions_match_the_student_grade(self) -> None:
        """★ 推荐要贴合学段 —— **随机不等于乱推**（学段隔离是硬边界）。

        D-074 之后推荐是随机的，但随机范围被限死在**本学段**：
        推一个他那个学段检索不到的知识点，等于给一个点不开的入口。
        """
        if not self.has_kb:
            self.skipTest("需要真实知识库")
        from app.store import kb as kb_repo  # noqa: PLC0415
        from app.store.connections import connect  # noqa: PLC0415
        from app.rag.retriever import default_kb_path  # noqa: PLC0415

        conn = connect(default_kb_path(self.tmp), readonly=True)
        try:
            for grade in ("primary_low", "junior", "senior"):
                self.set_student(f"student_cold_{grade}")
                body = self.recommend(gradeLevel=grade).json()
                self.assertGreater(len(body["items"]), 0, f"{grade} 应有推荐")
                allowed = set(kb_repo.kp_ids_by_grade(conn, grade))
                for item in body["items"]:
                    self.assertIn(
                        item["kpId"],
                        allowed,
                        f"{grade}：推荐了不属于本学段的知识点 {item['kpId']}（隔离被绕开）",
                    )
                    self.assertEqual(
                        item.get("gradeLevel"), grade, "条目上的学段要与筛选口径一致"
                    )
        finally:
            conn.close()


# --------------------------------------------------------------------------- #
# 2. ★ 依赖图驱动的推荐
# --------------------------------------------------------------------------- #
@unittest.skipUnless(REAL_KB.exists(), f"缺少真实知识库 {REAL_KB}（先跑 scripts/build_kb.py）")
class TestRandomSuggestion(PersonalizationCase):
    """★★ D-074：推荐不再沿依赖图走 —— 从「本学段、还没学过」里**随机**挑。

    这一段替换的是旧的 `TestGraphDrivenRecommendation`（断言「掌握前置 → 推它的后继」）。
    那条口径已被用户 2026-09-22 的裁决取代，原话：

        「你别设计成死按着内置教材和知识点的路线去走，每次启动给他随机换一个知识点；
          知识点什么解锁也去掉吧，没必要非得了解一个才能了解另一个」

    保留下来的不变量 + 新加的判据：
      ① **不推已掌握的**（推了等于白说）—— 旧口径里最实质的那半，继续守；
      ② **本学段**（见 `TestColdStart.test_suggestions_match_the_student_grade`）；
      ③ **随机真的随机**：换种子能换出不同的知识点（否则「每次换一个」是句空话）；
      ④ **同种子稳定**：同一批输入两次结果一致（侧栏不该每刷一次跳一个）。
    """

    #: 一个**初中学段**的知识点（掌握它 → 它该从推荐里消失）
    CHAIN_HEAD = "ai-definition-jr"
    #: ★ 一个有**同学段前置**的知识点：`ai-definition-jr → ai-three-values-jr`（related 边）。
    #:   它正是「解锁」那套主张的判据对象：去掉解锁之后，**没学过前置也能被抽到**。
    GATED_KP = "ai-three-values-jr"

    def test_mastered_kp_is_not_suggested_back(self) -> None:
        """★ 掌握之后它**不再出现**在推荐里（这条不变量与「走不走图」无关）。"""
        self.set_student("student_random_mastered")
        before = [item["kpId"] for item in self.recommend(gradeLevel="junior").json()["items"]]
        self.master(self.CHAIN_HEAD, prefix="rand-master")

        after = [item["kpId"] for item in self.recommend(gradeLevel="junior").json()["items"]]
        self.assertNotIn(
            self.CHAIN_HEAD, after, "已掌握的知识点不该被推回来（那不叫「可以学」）"
        )
        # 掌握前后都该有推荐（不是「掌握一个就空了」）
        self.assertGreater(len(before), 0)
        self.assertGreater(len(after), 0, "掌握一个知识点之后仍要有可学的")

    def test_no_prerequisite_gating(self) -> None:
        """★★ 去掉「解锁」之后：**没学过前置也能被推到**。

        旧口径下「掌握 A 才会推 A 的后继」，于是链上更靠后的知识点永远不会出现在
        新学生的推荐里。现在的判据相反：把链上**第二级**（要先学第一级的那种）放进
        候选池时，随机一批里就**应该**能抽到它 —— 学生想看就看得见。
        """
        from app.routes.profile import _learnable_kp_ids  # noqa: PLC0415
        from app.store.connections import connect  # noqa: PLC0415
        from app.rag.retriever import default_kb_path  # noqa: PLC0415
        import random as _random  # noqa: PLC0415

        self.set_student("student_no_gating")
        conn = connect(default_kb_path(self.tmp), readonly=True)
        try:
            seen: set[str] = set()
            for i in range(40):
                seen.update(
                    _learnable_kp_ids(
                        conn,
                        grade_level="junior",
                        exclude=(),
                        limit=6,
                        rng=_random.Random(f"pool-{i}"),
                    )
                )
            self.assertIn(
                self.GATED_KP,
                seen,
                "有前置的知识点必须能出现在候选里 —— 否则等于还在「解锁」",
            )
        finally:
            conn.close()

    def test_pool_is_seeded_and_stable(self) -> None:
        """★ 同种子同结果、换种子换顺序（「随机」必须是真的，且必须可复现）。"""
        from app.routes.profile import _learnable_kp_ids  # noqa: PLC0415
        from app.store.connections import connect  # noqa: PLC0415
        from app.rag.retriever import default_kb_path  # noqa: PLC0415
        import random as _random  # noqa: PLC0415

        conn = connect(default_kb_path(self.tmp), readonly=True)
        try:
            def pick(seed: str) -> list[str]:
                return _learnable_kp_ids(
                    conn,
                    grade_level="junior",
                    exclude=(),
                    limit=RECOMMEND_LIMIT,
                    rng=_random.Random(seed),
                )

            self.assertEqual(pick("same"), pick("same"), "同种子必须逐项相同（可复现）")
            # 换 6 个种子：至少出现两批不同的（4 条一组的组合极难完全撞上）
            batches = {tuple(pick(f"seed-{i}")) for i in range(6)}
            self.assertGreater(len(batches), 1, "换种子拿到的还是同一批 —— 随机没生效")
        finally:
            conn.close()

    def test_exclude_removes_mastered_from_the_pool(self) -> None:
        """★ `exclude`（已掌握 + 本次已选）必须真的把那些知识点从池子里去掉。"""
        from app.routes.profile import _learnable_kp_ids  # noqa: PLC0415
        from app.store.connections import connect  # noqa: PLC0415
        from app.rag.retriever import default_kb_path  # noqa: PLC0415
        from app.store import kb as kb_repo  # noqa: PLC0415
        import random as _random  # noqa: PLC0415

        conn = connect(default_kb_path(self.tmp), readonly=True)
        try:
            pool = kb_repo.kp_ids_by_grade(conn, "junior")
            blocked = set(pool[:5])
            picked = _learnable_kp_ids(
                conn,
                grade_level="junior",
                exclude=blocked,
                limit=len(pool),
                rng=_random.Random("exclude-check"),
            )
            self.assertTrue(picked, "池子里不该一个都不剩")
            self.assertEqual(
                blocked & set(picked), set(), f"被 exclude 的知识点仍被推出：{blocked & set(picked)}"
            )
            self.assertEqual(len(picked), len(set(picked)), "同一次调用里不许重复")
        finally:
            conn.close()

class TestRecommendationTracksMastery(PersonalizationCase):
    def test_wrong_answers_move_the_topic_to_the_front(self) -> None:
        """★ 票 20 的核心演示：「连续答错某知识点 → 下一轮更可能再考它」。

        步骤（可照念）：
          ① 新学生 → 推荐是随机挑的「还没学过」的知识点；
          ② 在 A 上答对几道（掌握 A）→ A **从推荐里消失**（不再推已会的）；
          ③ 在另一个知识点上**连续答错** → 它的掌握度掉到低于重练线 →
             推荐的第一位变成它（`source` 从 `random` 变成 `review`）。
        """
        self.set_student("student_demo_flow")
        # ① 冷启动（D-074：不再有「图里的入口」这回事，来源是 random）
        first = self.recommend(gradeLevel="junior").json()
        self.assertEqual(first["source"], "random")

        # ② 掌握一个知识点 → 它不再被推（随机池里被 exclude 掉）
        self.master("ai-definition-pl", prefix="demo-var")
        second = self.recommend(gradeLevel="junior").json()
        self.assertEqual(second["source"], "random")
        self.assertNotIn(
            "ai-definition-pl",
            [item["kpId"] for item in second["items"]],
            "★ 已掌握的不该再被推荐（旧口径这里断言的是「换成它的后继」）",
        )

        # ③ 在另一个知识点上连续答错 → 推荐第一位变成它（重练）
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
            json={"studentId": other, "qid": _gq("iso-1"), "answer": "2"},
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
        # ★ 生成编程题那张表走**独立迁移集**，只有真用到时才建 —— 这里显式建一次，
        #   让下面的字段清单把它一起过一遍（不然它永远不在盘点范围内）。
        _store = open_learning_store(self.tmp, "student_compliance")
        try:
            _store.ensure_code_tables()
        finally:
            _store.close()

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
            # ★ ``signal_mark`` 是「写这一行时 ``grade_signals`` 的最大 id」——
            #   一个**我们自己生成的自增序号**，不是任何学生信息：它不指向人、不含内容，
            #   只为让冷却按「真实发生的轮数」计算（见 app/grade/rules.py 的
            #   ``_cooldown_remaining``）。最小化原则不受影响。
            # ★ ``decided_by`` 是「这一档是哪层判的」（rules / llm / NULL），不指向任何学生信息。
            "grade_history": {"id", "ts", "turn", "from_level", "to_level", "source", "confidence",
                              "signal_mark", "decided_by"},
            "grade_signals": {"id", "ts", "session_id", "signal_type", "value", "raw"},
            # ★ ``student_id`` 是「这道题归哪个学生」（2026-09-26，D-088）：生成的题从此有归属，
            #   否则「我的题目」在数据层根本表达不出来（qid 里只有随机段、没有学生）。
            #   它不是新的个人信息：与 ``student.student_id`` 同一个值（主进程解析出来的那个）。
            "generated_question": {"qid", "kp_id", "grade_level", "type", "stem", "options",
                                   "reference_answer", "explanation", "rubric", "source",
                                   "created_at", "student_id"},
            # ★ 学生的生成编程题（2026-09-26，D-089）：随包模板目录是只读的，生成题要有别处可存。
            #   列里没有任何新采集项 —— `student_id` / `kp_id` / `grade_level` 都来自既有维度，
            #   `prompt_hash` 是**请求指纹**（学生原话不进库，与 `saved_animation` 同一条合规口径）。
            "generated_code_template": {"saved_id", "student_id", "kp_id", "grade_level", "title",
                                       "expected_behavior", "scaffold", "expected_output", "hints",
                                       "solution", "prompt_hash", "created_at"},
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
