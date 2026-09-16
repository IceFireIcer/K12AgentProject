# -*- coding: utf-8 -*-
"""练习 Extension 的服务端部分：题库取题 + 客观题规则判分 + 掌握度落库（票 14）。

本文件盯住四条不能被「顺手改坏」的红线：

1. ★ **答案不出后端**：对外题目结构上没有 ``answer``；用一个唯一哨兵串做端到端验证
   （真发 HTTP、真序列化，哨兵串在响应 JSON 里必须零命中）；
2. **归一化判分**：空白 / 引号 / 全角括号 / 大小写差异都不得误判（业务陷阱清单口径）；
3. **mastery_delta 限幅**：单次答题 ``abs(delta) <= 0.2``，且真的写进 ``learning.db``；
4. **学段隔离**：题库取题只允许「本学段 + 更低学段」，初中生取不到高中题。

夹具用真的 ``server/resources/quizbank/`` 与真的 ``server/knowledge/``
（题库是随包分发的内容资产，测试要盯住的就是它的内容质量）。
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import KNOWLEDGE_DIR, RESOURCES_DIR, build_runtime_config  # noqa: E402
from app.contracts import MASTERY_DELTA_LIMIT, QuizQuestion  # noqa: E402
from app.knowledge.library import load_library  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes.quiz import (  # noqa: E402
    MASTERY_GAIN_CORRECT,
    MASTERY_LOSS_WRONG,
    bank_dir_for,
    default_bank_dir,
    is_correct_answer,
    load_bank,
    normalize_answer,
    out_of_scope_terms,
    router as quiz_router,
    select_questions,
    student_db_path,
)

BANK_DIR = default_bank_dir()

#: ★ 哨兵：只可能来自题库里的标准答案。它一旦出现在响应 JSON 里，就说明答案泄漏了。
SENTINEL_ANSWER = "哨兵答案-ZX91-不得出现在响应里"


def _question(**overrides) -> QuizQuestion:
    base = dict(
        qid="test-q1",
        kp_id="jr-py-loop",
        type="blank",
        stem="1 到 5 依次打印，用什么函数？",
        options=None,
        answer="range",
        explanation="range 负责生成一串数字。",
    )
    base.update(overrides)
    return QuizQuestion(**base)


class QuizCase(unittest.TestCase):
    """带临时 userData 目录的基类（一人一库落在 tmp 里，不碰真实数据）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config(data_dir=self.tmp))
        # 数据轨的路由由 main.py 挂载（票 04 维护）；本文件只验证练习路由，
        # 显式挂载以便端到端跑到 HTTP 层。
        self.app.include_router(quiz_router)
        self.client = TestClient(self.app)

    def grade(self, **body):
        return self.client.post("/api/quiz/grade", json=body)


# --------------------------------------------------------------------------- #
# 归一化：这三例是票 14 点名的「不得误判」
# --------------------------------------------------------------------------- #
class TestNormalization(unittest.TestCase):
    def test_whitespace_only_difference_is_not_a_miss(self) -> None:
        self.assertTrue(is_correct_answer(_question(answer="1 到 5"), "1到5"))

    def test_quote_difference_is_not_a_miss(self) -> None:
        self.assertTrue(is_correct_answer(_question(answer='"循环"'), "“循环”"))

    def test_fullwidth_parentheses_are_not_a_miss(self) -> None:
        quote = 'print("你好")'
        fullwidth = "print（“你好”）"
        self.assertTrue(is_correct_answer(_question(answer=quote), fullwidth))

    def test_case_and_trailing_semicolon_are_ignored(self) -> None:
        self.assertTrue(is_correct_answer(_question(answer="Total += I"), "total += i;"))

    def test_chinese_punctuation_normalized(self) -> None:
        self.assertEqual(normalize_answer("（1），2。"), "(1),2.")

    def test_wrong_answer_is_still_wrong(self) -> None:
        self.assertFalse(is_correct_answer(_question(answer="1 到 5"), "1 到 6"))


# --------------------------------------------------------------------------- #
# 三类题型规则判分
# --------------------------------------------------------------------------- #
class TestRuleGrading(unittest.TestCase):
    def test_choice_accepts_letter_and_option_text(self) -> None:
        question = _question(
            type="choice",
            options=["第一项", "第二项", "第三项"],
            answer="第二项",
        )
        self.assertTrue(is_correct_answer(question, "第二项"))
        self.assertTrue(is_correct_answer(question, "b"))
        self.assertTrue(is_correct_answer(question, " B "))
        self.assertFalse(is_correct_answer(question, "第三项"))

    def test_blank_accepts_any_listed_variant(self) -> None:
        question = _question(type="blank", answer=["像素", "像点"])
        self.assertTrue(is_correct_answer(question, "像点"))
        self.assertTrue(is_correct_answer(question, "像素"))
        self.assertFalse(is_correct_answer(question, "色块"))

    def test_code_blank_ignores_spacing(self) -> None:
        question = _question(type="code_blank", answer="total += i")
        self.assertTrue(is_correct_answer(question, "total+=i"))
        self.assertTrue(is_correct_answer(question, " total += i\n"))

    def test_multi_blank_must_match_positionally(self) -> None:
        question = _question(type="blank", answer=["range", "print"])
        self.assertTrue(is_correct_answer(question, ["range", "print"]))
        self.assertFalse(is_correct_answer(question, ["print", "range"]))


# --------------------------------------------------------------------------- #
# 题库内容质量：坏题 / 超纲 / 学段错位
# --------------------------------------------------------------------------- #
class TestBankContent(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.report = load_bank(BANK_DIR)
        cls.docs = {doc.kp_id: doc for doc in load_library(KNOWLEDGE_DIR)}

    def test_bank_loads_without_bad_entries(self) -> None:
        self.assertTrue(self.report.entries, f"题库空：{BANK_DIR}")
        self.assertEqual(self.report.skipped, [], f"题库有坏题：{self.report.skipped}")

    def test_bank_has_no_out_of_scope_terms(self) -> None:
        self.assertEqual(self.report.out_of_scope, [], f"题库超纲：{self.report.out_of_scope}")

    def test_bank_covers_all_three_question_types(self) -> None:
        types = {entry.question.type for entry in self.report.entries}
        self.assertEqual(types, {"choice", "blank", "code_blank"})

    def test_every_question_points_at_a_real_kp_in_the_same_grade(self) -> None:
        for entry in self.report.entries:
            doc = self.docs.get(entry.question.kp_id)
            self.assertIsNotNone(
                doc, f"{entry.question.qid} 的知识点 {entry.question.kp_id} 不在教材里"
            )
            self.assertEqual(
                doc.grade_level,
                entry.grade_level,
                f"{entry.question.qid} 所在文件是 {entry.grade_level}，"
                f"但知识点属于 {doc.grade_level}（题库与教材学段错位）",
            )

    def test_qids_are_unique(self) -> None:
        qids = [entry.question.qid for entry in self.report.entries]
        self.assertEqual(len(qids), len(set(qids)), "题库里有重复 qid")

    def test_out_of_scope_helper_flags_primary_low_terms(self) -> None:
        # 票 14 点名的两个超纲词：小学低年级题干里出现即违规
        self.assertIn("算法", out_of_scope_terms("用算法帮小明分类", "primary_low"))
        self.assertIn("特征向量", out_of_scope_terms("特征向量的长度", "primary_low"))
        self.assertEqual(out_of_scope_terms("用算法帮小明分类", "junior"), [])


# --------------------------------------------------------------------------- #
# 学段隔离（取题方向）
# --------------------------------------------------------------------------- #
class TestGradeIsolation(QuizCase):
    def test_junior_gets_junior_questions(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/jr-py-loop", params={"gradeLevel": "junior", "count": 5}
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["questions"])

    def test_junior_never_gets_senior_questions(self) -> None:
        """初中生问高中知识点 → 取不到题（404），**绝不返回超纲题**。"""
        response = self.client.get(
            "/api/quiz/bank/sr-linear-regression", params={"gradeLevel": "junior"}
        )
        self.assertEqual(response.status_code, 404)
        self.assertIn("没有题目", response.json()["detail"])

    def test_senior_can_review_lower_grade_questions(self) -> None:
        """向上兼容方向是「高中生回看初中题」，与检索链一致。"""
        response = self.client.get(
            "/api/quiz/bank/jr-py-loop", params={"gradeLevel": "senior"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["questions"])

    def test_allow_compat_false_restricts_to_exact_grade(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/jr-py-loop",
            params={"gradeLevel": "senior", "allowCompat": "false"},
        )
        self.assertEqual(response.status_code, 404)

    def test_select_questions_orders_exact_grade_first(self) -> None:
        report = load_bank(BANK_DIR)
        picked = select_questions(
            report, kp_id="jr-py-loop", grade_level="senior", count=2, allow_compat=True
        )
        self.assertTrue(picked)
        self.assertEqual({entry.grade_level for entry in picked}, {"junior"})

    def test_bank_dir_override(self) -> None:
        sentinel_dir = self.tmp / "bank-override"
        sentinel_dir.mkdir()
        self.app.state.quiz_bank_dir = sentinel_dir
        request = type("R", (), {"app": self.app})()
        self.assertEqual(bank_dir_for(request), sentinel_dir)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# ★★ 答案不出后端（票 14 的头号红线）
# --------------------------------------------------------------------------- #
class TestAnswerNeverLeavesBackend(QuizCase):
    @staticmethod
    def _keys(node) -> list[str]:
        """递归收集 JSON 里出现过的所有键名。"""
        found: list[str] = []
        if isinstance(node, dict):
            for key, value in node.items():
                found.append(str(key))
                found.extend(TestAnswerNeverLeavesBackend._keys(value))
        elif isinstance(node, list):
            for item in node:
                found.extend(TestAnswerNeverLeavesBackend._keys(item))
        return found

    def test_no_answer_key_in_real_payload(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/jr-py-loop", params={"gradeLevel": "junior", "count": 5}
        )
        raw = response.text
        payload = json.loads(raw)
        self.assertNotIn(
            "answer",
            self._keys(payload),
            f"对外题目载荷里出现了 answer 键：{raw}",
        )
        # 题目字段就是 QuizQuestionOut 的那 6 个（多一个都算契约外字段）
        for question in payload["questions"]:
            self.assertEqual(
                set(question),
                {"qid", "kpId", "type", "stem", "options", "explanation"},
                f"对外题目字段不对：{question}",
            )

    def _write_sentinel_bank(self) -> Path:
        """造一份临时题库：标准答案是唯一哨兵串，解析文案里绝不出现它。"""
        bank = self.tmp / "sentinel-bank"
        bank.mkdir(exist_ok=True)
        (bank / "junior.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "grade_level": "junior",
                    "questions": [
                        {
                            "qid": "sentinel-q1",
                            "kp_id": "jr-py-loop",
                            "type": "blank",
                            "stem": "哨兵题：请填空（答案不该出现在这里）",
                            "answer": SENTINEL_ANSWER,
                            "explanation": "哨兵题只用于验证答案不外泄。",
                        },
                        {
                            "qid": "sentinel-q2",
                            "kp_id": "jr-py-loop",
                            "type": "choice",
                            "stem": "哨兵选择题",
                            "options": ["选项甲", "选项乙"],
                            "answer": SENTINEL_ANSWER + "-choice",
                            "explanation": "选项里也不许出现答案哨兵。",
                        },
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.app.state.quiz_bank_dir = bank
        return bank

    def test_sentinel_answer_is_absent_from_response(self) -> None:
        """★ 哨兵验证：真发 HTTP、真序列化，答案串在响应里必须零命中。

        用一份临时题库，把「唯一可识别的哨兵串」当作标准答案；
        响应里只要出现这个串，就说明答案跟着题面一起出去了。
        """
        self._write_sentinel_bank()

        response = self.client.get(
            "/api/quiz/bank/jr-py-loop", params={"gradeLevel": "junior", "count": 5}
        )
        self.assertEqual(response.status_code, 200)
        raw = response.text
        self.assertNotIn(SENTINEL_ANSWER, raw, "★ 标准答案泄漏进了对外载荷")
        self.assertNotIn("sentinel", json.dumps(self._keys(json.loads(raw)), ensure_ascii=False))
        self.assertNotIn("answer", self._keys(json.loads(raw)))

        # 同一份题库，判分仍然认得这个答案（说明「没发出去」而不是「没存进去」）
        graded = self.grade(
            studentId="student_001", qid="sentinel-q1", answer=SENTINEL_ANSWER
        )
        self.assertEqual(graded.status_code, 200)
        self.assertTrue(graded.json()["correct"])
        self.assertNotIn(SENTINEL_ANSWER, graded.text, "判分响应里也不许回显标准答案")

    def test_wrong_answer_feedback_does_not_reveal_the_answer(self) -> None:
        """答错时的中文反馈只讲思路，不回显标准答案（否则改一下答案就再试一次通关）。"""
        self._write_sentinel_bank()
        graded = self.grade(studentId="student_013", qid="sentinel-q1", answer="随便写点什么")
        self.assertEqual(graded.status_code, 200)
        payload = graded.json()
        self.assertFalse(payload["correct"])
        self.assertNotIn(SENTINEL_ANSWER, payload["feedback"])
        self.assertIn("再", payload["feedback"])

    def test_sentinel_question_is_not_present_in_shipped_bank_answers(self) -> None:
        """哨兵串只存在于临时题库里（防止有人把测试数据写进正式题库）。"""
        for entry in load_bank(BANK_DIR).entries:
            self.assertNotIn(SENTINEL_ANSWER, str(entry.question.answer))

    def test_internal_model_really_has_the_answer(self) -> None:
        """反向对照：内部模型**有** answer —— 上面的「没有」不是因为字段压根不存在。"""
        self.assertIn("answer", QuizQuestion.model_fields)
        self.assertNotIn("answer", json.dumps(self.client.get(
            "/api/quiz/bank/jr-py-loop", params={"gradeLevel": "junior"}
        ).json()))


# --------------------------------------------------------------------------- #
# 掌握度：限幅 + 真的落库
# --------------------------------------------------------------------------- #
class TestMasteryAndHistory(QuizCase):
    def _mastery_row(self, student_id: str, kp_id: str):
        path = student_db_path(self.tmp, student_id)
        self.assertTrue(path.exists(), f"没有建库：{path}")
        conn = sqlite3.connect(path)
        try:
            conn.row_factory = sqlite3.Row
            return conn.execute(
                "SELECT score, attempts, correct, last_seen_at FROM mastery WHERE kp_id = ?",
                (kp_id,),
            ).fetchone()
        finally:
            conn.close()

    def test_single_correct_answer_moves_mastery_by_at_most_0_2(self) -> None:
        body = {"studentId": "student_001", "qid": "jr-py-loop-q2", "answer": "+="}
        first = self.grade(**body).json()
        self.assertTrue(first["correct"])
        self.assertEqual(first["scoredBy"], "rule")
        self.assertLessEqual(abs(first["masteryDelta"]), MASTERY_DELTA_LIMIT)
        self.assertAlmostEqual(first["masteryDelta"], MASTERY_GAIN_CORRECT, places=6)
        self.assertLess(first["masteryDelta"], 1.0, "一次答题不能把掌握度从 0 顶到 1")

        row = self._mastery_row("student_001", "jr-py-loop")
        self.assertIsNotNone(row)
        self.assertAlmostEqual(row["score"], MASTERY_GAIN_CORRECT, places=6)
        self.assertEqual(row["attempts"], 1)
        self.assertEqual(row["correct"], 1)
        self.assertIsNotNone(row["last_seen_at"])

    def test_wrong_answer_delta_is_clamped_and_never_goes_below_zero(self) -> None:
        # 先答对一次，把掌握度抬到 0.15，再答错 —— 否则 0 减去任何值都会被截到 0，
        # 测出来是「0 变化」而不是「负变化」，等于没测到限幅。
        self.grade(studentId="student_002", qid="jr-py-loop-q2", answer="+=")
        result = self.grade(
            studentId="student_002", qid="jr-py-loop-q2", answer="-="
        ).json()
        self.assertFalse(result["correct"])
        self.assertAlmostEqual(result["masteryDelta"], -MASTERY_LOSS_WRONG, places=6)
        self.assertGreaterEqual(result["masteryDelta"], -MASTERY_DELTA_LIMIT)

        row = self._mastery_row("student_002", "jr-py-loop")
        self.assertEqual(row["attempts"], 2)
        self.assertEqual(row["correct"], 1)
        self.assertAlmostEqual(row["score"], MASTERY_GAIN_CORRECT - MASTERY_LOSS_WRONG, places=6)

        # 全新学生答错：掌握度停在 0（不能为负），回报的增量也就是 0
        fresh = self.grade(
            studentId="student_012", qid="jr-py-loop-q2", answer="-="
        ).json()
        self.assertFalse(fresh["correct"])
        self.assertEqual(fresh["masteryDelta"], 0.0)
        self.assertEqual(self._mastery_row("student_012", "jr-py-loop")["score"], 0.0)

    def test_repeated_answers_converge_and_delta_stops_at_the_ceiling(self) -> None:
        body = {"studentId": "student_003", "qid": "jr-py-loop-q2", "answer": "+="}
        deltas = []
        for _ in range(10):
            payload = self.grade(**body).json()
            deltas.append(payload["masteryDelta"])
            self.assertLessEqual(abs(payload["masteryDelta"]), MASTERY_DELTA_LIMIT)

        row = self._mastery_row("student_003", "jr-py-loop")
        self.assertAlmostEqual(row["score"], 1.0, places=6)
        self.assertEqual(row["attempts"], 10)
        self.assertEqual(row["correct"], 10)
        self.assertEqual(deltas[-1], 0.0, "满分后再答对，回报的增量必须是 0（不能虚涨）")

    def test_attempt_is_written_to_learning_history(self) -> None:
        self.grade(
            studentId="student_004",
            qid="jr-py-loop-q1",
            answer="for i in range(1, 6):\n    print(i)",
            sessionId="turn_abc",
        )
        conn = sqlite3.connect(student_db_path(self.tmp, "student_004"))
        try:
            rows = conn.execute(
                "SELECT activity, kp_id, is_correct, session_id FROM learning_history"
            ).fetchall()
        finally:
            conn.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], "quiz")
        self.assertEqual(rows[0][1], "jr-py-loop")
        self.assertEqual(rows[0][2], 1)
        self.assertEqual(rows[0][3], "turn_abc")

    def test_students_do_not_share_a_database(self) -> None:
        self.grade(studentId="student_010", qid="jr-py-loop-q2", answer="+=")
        self.grade(studentId="student_011", qid="jr-py-loop-q2", answer="-=")
        a = self._mastery_row("student_010", "jr-py-loop")["score"]
        b = self._mastery_row("student_011", "jr-py-loop")["score"]
        self.assertNotEqual(a, b, "两个学生的掌握度串了（一人一库被破坏）")
        self.assertNotEqual(
            student_db_path(self.tmp, "student_010"),
            student_db_path(self.tmp, "student_011"),
        )


# --------------------------------------------------------------------------- #
# HTTP 边界的错误口径
# --------------------------------------------------------------------------- #
class TestHttpBoundary(QuizCase):
    def test_bank_payload_shape(self) -> None:
        payload = self.client.get(
            "/api/quiz/bank/jr-py-variable", params={"gradeLevel": "junior"}
        ).json()
        self.assertEqual(set(payload), {"kpId", "questions", "source"})
        self.assertEqual(payload["source"], "bank")
        self.assertLessEqual(len(payload["questions"]), 3)

    def test_snake_case_query_params_also_accepted(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/jr-py-variable", params={"grade_level": "junior"}
        )
        self.assertEqual(response.status_code, 200)

    def test_missing_grade_is_422(self) -> None:
        self.assertEqual(self.client.get("/api/quiz/bank/jr-py-variable").status_code, 422)

    def test_bad_grade_is_422(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/jr-py-variable", params={"gradeLevel": "college"}
        )
        self.assertEqual(response.status_code, 422)

    def test_unknown_kp_is_404(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/nope", params={"gradeLevel": "junior"}
        )
        self.assertEqual(response.status_code, 404)

    def test_grade_unknown_qid_is_404_with_readable_message(self) -> None:
        response = self.grade(studentId="student_001", qid="ghost-qid", answer="x")
        self.assertEqual(response.status_code, 404)
        self.assertIn("题库", response.json()["detail"])

    def test_grade_rejects_path_traversal_student_id(self) -> None:
        """studentId 会被拼进路径：必须挡在 HTTP 边界上。"""
        response = self.grade(studentId="../../evil", qid="jr-py-loop-q2", answer="+=")
        self.assertEqual(response.status_code, 422)
        self.assertFalse((self.tmp.parent / "evil").exists())

    def test_grade_rejects_unknown_field(self) -> None:
        """契约 forbid 额外字段（临时加松散字段必须 422）。"""
        response = self.client.post(
            "/api/quiz/grade",
            json={"studentId": "student_001", "qid": "jr-py-loop-q2", "answer": "+=", "oops": 1},
        )
        self.assertEqual(response.status_code, 422)

    def test_grade_result_shape(self) -> None:
        payload = self.grade(
            studentId="student_001", qid="jr-py-loop-q2", answer="+="
        ).json()
        self.assertEqual(
            set(payload), {"qid", "correct", "scoredBy", "feedback", "masteryDelta"}
        )
        self.assertIn("答对了", payload["feedback"])
        self.assertEqual(payload["scoredBy"], "rule")

    def test_feedback_of_wrong_answer_is_chinese_and_readable(self) -> None:
        payload = self.grade(
            studentId="student_005", qid="jr-py-loop-q2", answer="完全不对"
        ).json()
        self.assertFalse(payload["correct"])
        self.assertIn("再", payload["feedback"])
        self.assertTrue(payload["feedback"].strip())


class TestSharedResourcesAreReachable(unittest.TestCase):
    def test_resources_dir_contains_quizbank(self) -> None:
        self.assertTrue((Path(RESOURCES_DIR) / "quizbank").is_dir())
        self.assertGreaterEqual(len(list(default_bank_dir().glob("*.json"))), 4)


if __name__ == "__main__":
    unittest.main()
