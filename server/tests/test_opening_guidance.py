# -*- coding: utf-8 -*-
"""主动发起对话引导（需求原文：「智能体也能主动发起对话引导学习章节内容」）。

这一组断言盯住「开场白**撒谎**」的四类形态 —— 它们全都不会报错，只会让学生
看到一个不该出现的招呼：

1. ★ **没有依据就不要开场**：知识库缺失 / 推不出内容时 ``text`` 必须为空串，
   前端据此**不发**（而不是弹一句「今天想学什么？」这种对谁都成立的废话）；
2. ★ **有依据才开场**：全新学生（``cold_start``）与有掌握度的学生（``review`` / ``graph``）
   都要拿到一句可读中文，且指向的 ``kpId`` 与同期的推荐接口**第一位一致**
   （两个端点各推各的 = 界面自相矛盾）；
3. ★ **不编造学习历史**：「上次那个知识点」这类话只能来自 ``review``，
   而 ``review`` 的判据是库里真有低于阈值的掌握度行；
4. ★ **不重写推荐逻辑**：开场语里的知识点名必须是图里查出来的中文名
   （退化成裸 ``kp_id`` 说明拼接绕过了推荐接口）。

真知识库缺失时**跳过并说明原因**（不假装通过）—— 与 `test_personalization.py` 同一口径。
"""

from __future__ import annotations

import shutil
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
from app.routes.profile import OpeningGuidance, _opening_text  # noqa: E402

REAL_KB = Path(ROOT) / "_data" / "shared" / "kb.sqlite"

#: 开场语里绝不允许出现的内部痕迹。
#: ★ 前两条是「拼接绕过推荐接口」的指纹：直接把 kp_id 念给学生听。
#: ★ 后两条是**技术词**（UX 体检 P-081 的同类问题：排障文案直出给学生）。
FORBIDDEN_SUBSTRINGS = ("kp_id", "kpId", "_pl", "_ph", "_jr", "_sr")
FORBIDDEN_WORDS = ("降级", "超时", "接口", "数据库")


class OpeningCase(unittest.TestCase):
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

    def opening(self, student: str, **params) -> object:
        return self.client.get(f"/api/profile/{student}/opening", params=params)

    def recommendation(self, student: str, **params) -> dict:
        response = self.client.get(f"/api/profile/{student}/recommendation", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def answer(self, student: str, kp_id: str, *, correct: bool, prefix: str) -> None:
        """通过真实的「生成变式题 → 判分」链路把掌握度压下去 / 抬起来。"""
        response = self.client.post(
            f"/api/quiz/variants?student_id={student}",
            json={
                "gradeLevel": "junior",
                "questions": [
                    {
                        "qid": f"gen-{prefix}",
                        "kpId": kp_id,
                        "type": "blank",
                        "stem": "题",
                        "referenceAnswer": "2",
                        "explanation": "讲解",
                        "options": None,
                    }
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        qid = response.json()["questions"][0]["qid"]
        graded = self.client.post(
            "/api/quiz/grade",
            json={
                "studentId": student,
                "qid": qid,
                "answer": "2" if correct else "完全不沾边的答案",
                "sessionId": "sess-opening",
            },
        )
        self.assertEqual(graded.status_code, 200, graded.text)


# --------------------------------------------------------------------------- #
# 1. ★ 纯函数：没有依据就没有开场语
# --------------------------------------------------------------------------- #
class TestOpeningTextIsHonest(unittest.TestCase):
    """`_opening_text` 是全项目**唯一**拼开场语的地方，所以它自己必须先说真话。"""

    def test_empty_source_yields_empty_text(self) -> None:
        """★ 没有推荐内容 → 空串（前端据此不发开场，而不是硬凑一句寒暄）。"""
        self.assertEqual(_opening_text("empty", []), "")

    def test_empty_items_yield_empty_text_even_with_a_source(self) -> None:
        """防御性：`source` 与 `items` 不一致时也**不发**（宁可不说，不要说错）。"""
        self.assertEqual(_opening_text("graph", []), "")

    def test_every_real_source_produces_readable_chinese(self) -> None:
        """三种真实来源各有各的说法，且都是可读中文、不含内部痕迹。"""
        from app.routes.profile import RecommendationItem

        real = [RecommendationItem(kp_id="prog-loop-jr", name="循环")]
        texts = {
            source: _opening_text(source, real)  # type: ignore[arg-type]
            for source in ("review", "graph", "cold_start")
        }
        for source, text in texts.items():
            self.assertTrue(text, f"{source} 必须给出开场语")
            for bad in FORBIDDEN_SUBSTRINGS:
                self.assertNotIn(bad, text, f"{source} 的开场语里出现内部字段痕迹：{bad}")
            for word in FORBIDDEN_WORDS:
                self.assertNotIn(word, text, f"{source} 的开场语里出现技术词：{word}")

        # ★ 三种来源必须**说三句不同的话**：否则「针对性引导」退化成一句万能招呼
        self.assertEqual(len(set(texts.values())), 3, f"三种来源的说法重复了：{texts}")

    def test_text_names_exactly_the_item_the_action_button_targets(self) -> None:
        """★★ 开场语里**只能出现第一个知识点** —— 动作按钮只去得了那一个。

        实测踩到过：界面显示「从人工智能的定义、算力开始吧」（`_recommendation_summary`
        会念前两条），而按钮回的是 `items[0].kp_id` —— 点下去落到其中一个，
        学生看不出是哪一个。所以拼开场语时**不能**沿用那段「取前两条」的措辞。
        """
        from app.routes.profile import RecommendationItem

        items = [
            RecommendationItem(kp_id="ai-definition-pl", name="人工智能的定义"),
            RecommendationItem(kp_id="computing-power-pl", name="算力"),
        ]
        text = _opening_text("cold_start", items)  # type: ignore[arg-type]
        self.assertIn("人工智能的定义", text)
        # ★ 第二个知识点**一个字节都不许出现**（它没有对应的动作）
        self.assertNotIn("算力", text)
        self.assertNotIn(items[1].kp_id, text)

    def test_falls_back_to_kp_id_when_the_graph_has_no_chinese_name(self) -> None:
        """图里查不到中文名时退化成 kp_id —— 不空、不抛（宁可说个代号也不留白）。"""
        from app.routes.profile import RecommendationItem

        text = _opening_text("cold_start", [RecommendationItem(kp_id="mystery-kp", name="")])  # type: ignore[arg-type]
        self.assertIn("mystery-kp", text)


# --------------------------------------------------------------------------- #
# 2. ★ 真实链路：冷启动有开场、且与推荐接口一致
# --------------------------------------------------------------------------- #
class TestOpeningOverHttp(OpeningCase):
    def setUp(self) -> None:
        super().setUp()
        if not self.has_kb:
            self.skipTest(f"缺少真实知识库 {REAL_KB}，无法断言「开场语来自依赖图推荐」")

    def test_brand_new_student_gets_an_opening(self) -> None:
        """★ 全新学生：有开场语、指向冷启动入口、与推荐接口第一位一致。"""
        student = "student_opening_fresh"
        response = self.opening(student)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()

        self.assertEqual(body["source"], "cold_start")
        self.assertTrue(body["text"], "冷启动必须有开场语（这是「AI 先开口」的第一屏）")
        self.assertTrue(body["kpId"], "接受引导要有可去的地方")

        items = self.recommendation(student)["items"]
        self.assertTrue(items)
        self.assertEqual(
            body["kpId"],
            items[0]["kpId"],
            "★ 开场指向的知识点必须与推荐接口的第一位一致（否则界面两处自相矛盾）",
        )
        # ★ 中文名必须来自图（裸 kp_id 说明拼接绕过了推荐接口）
        self.assertIn(items[0]["name"], body["text"])

    def test_kp_id_absent_when_there_is_no_opening(self) -> None:
        """★ 没有开场语时**不许**给 kp_id：否则界面会渲染一个「去吧」按钮却没有目标。"""
        student = "student_opening_empty"
        # 无知识库 = 推不出内容（与「知识库缺失」时的降级是同一条路）
        empty_app = create_app(build_runtime_config(data_dir=self.tmp / "no-kb-here"))
        with TestClient(empty_app) as client:
            response = client.get(f"/api/profile/{student}/opening")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["text"], "", "推不出内容时不许硬凑开场语")
        self.assertIsNone(body["kpId"], "没有开场语就不该有目标知识点")
        self.assertEqual(body["source"], "empty")

    def test_degraded_recommendation_still_returns_a_clean_shape(self) -> None:
        """知识库读不到时**不 500**：开场引导是加分项，缺库只该让它安静地不发。"""
        app = create_app(build_runtime_config(data_dir=self.tmp / "no-kb-here"))
        with TestClient(app) as client:
            response = client.get("/api/profile/student_opening_nokb/opening")
        self.assertEqual(response.status_code, 200, response.text)
        # 契约字段一个都不能少（前端按它们决定发不发）
        self.assertEqual(
            sorted(response.json().keys()), ["kpId", "source", "text"], response.text
        )

    def test_opening_does_not_claim_learning_history_without_evidence(self) -> None:
        """★ 全新学生的开场语里**不许**出现「上次 / 再练」这类编造的历史。"""
        student = "student_opening_nohistory"
        body = self.opening(student).json()
        self.assertEqual(body["source"], "cold_start")
        for phrase in ("上次", "再练", "刚才卡住"):
            self.assertNotIn(
                phrase, body["text"], "冷启动没有学习历史，说「上次」就是编造"
            )

    def test_low_mastery_student_gets_a_review_opening(self) -> None:
        """★ 答错之后来源变成 `review`，开场语也随之变成「回头再练」那一种。"""
        student = "student_opening_review"
        kp_id = self.recommendation(student)["items"][0]["kpId"]
        # 先答对一次（才会进 mastery 表）再答错，把分数压到阈值以下
        self.answer(student, kp_id, correct=True, prefix="opening-a")
        self.answer(student, kp_id, correct=False, prefix="opening-b")

        body = self.opening(student).json()
        self.assertEqual(body["source"], "review", body)
        self.assertEqual(body["kpId"], kp_id, "开场应指向那个没练熟的")
        self.assertTrue(body["text"])
        # ★ 重练场景该说「回炉」而不是「起步」：两者的依据完全不同
        #   （review = 库里真有低于阈值的掌握度行；cold_start = 图里的入口节点）。
        self.assertIn("练熟", body["text"], f"重练场景该说回炉，实际：{body['text']}")
        self.assertNotIn("起点", body["text"], "重练场景不该说「这是起点」（那是冷启动的说法）")

    def test_opening_is_stable_across_calls(self) -> None:
        """★ 同一状态下连问两次，开场语**逐字相同**。

        界面会在「新建会话」时调一次；如果同一个学生每次开新会话都拿到不同的一句话，
        学生会以为系统在随机说话 —— 而推荐本身在数据不变时是确定的，开场语也必须确定。
        """
        student = "student_opening_stable"
        first = self.opening(student).json()
        second = self.opening(student).json()
        self.assertEqual(first, second)

    def test_student_id_is_validated(self) -> None:
        """非法学生 id 当场 422（它会拼进文件系统路径，见 `assertStudentId` 那一族）。"""
        response = self.client.get("/api/profile/../evil/opening")
        self.assertIn(response.status_code, (400, 404, 422), response.text)


# --------------------------------------------------------------------------- #
# 3. ★ 契约形状（前端据它决定发不发，字段一个都不能少）
# --------------------------------------------------------------------------- #
class TestOpeningContract(unittest.TestCase):
    def test_default_shape_is_the_silent_one(self) -> None:
        """模型默认值就是「不发开场」—— 任何漏填字段的路径都不会误发一句空话。"""
        body = OpeningGuidance().model_dump(by_alias=True)
        self.assertEqual(body["text"], "")
        self.assertIsNone(body["kpId"])
        self.assertEqual(body["source"], "empty")

    def test_camel_case_aliases_are_what_the_frontend_reads(self) -> None:
        body = OpeningGuidance(text="x", kp_id="k", source="graph").model_dump(by_alias=True)
        self.assertEqual(sorted(body.keys()), ["kpId", "source", "text"])
        # snake_case 也能读（populate_by_name）—— 路由内部构造时用的是它
        self.assertEqual(OpeningGuidance(kpId="k").kp_id, "k")

    def test_extra_fields_are_rejected(self) -> None:
        """`extra="forbid"`：不许临时加松散字段（契约纪律）。"""
        with self.assertRaises(Exception):
            OpeningGuidance(text="x", nope=1)  # type: ignore[call-arg]


if __name__ == "__main__":
    unittest.main()
