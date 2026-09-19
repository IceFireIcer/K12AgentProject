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

from app.config import (  # noqa: E402
    KNOWLEDGE_DIR,
    RESOURCES_DIR,
    build_runtime_config,
    resolve_data_dir,
)
from app.contracts import MASTERY_DELTA_LIMIT, QuizQuestion  # noqa: E402
from app.knowledge.library import load_library  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import quiz as quiz_module  # noqa: E402
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
        kp_id="prog-loop-jr",
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

    def test_bank_question_types_are_within_release_scope_and_complete(self) -> None:
        """题库题型**恰好**是随包分发的那两种，且都在第一版范围内。

        ⚠️ 形态换代（2026-09-19，随 K12KnowledgeBase 接入）：新题库（``ch01``…``ch08``，
        684 题）里**没有 ``code_blank``**（旧题库有；新教材第 8 章「编程实践」的题
        全部是 choice / blank）。路由与契约仍然支持 ``code_blank``（判分分支还在，
        ``test_code_blank_ignores_spacing`` 也在），只是随包内容不再含这类题。

        判据仍然是「集合相等」而不是「包含于范围」：少一种（有人删掉全部填空题）
        或多一种（冒出一个没被登记过的题型）都会当场变红。
        """
        types = {entry.question.type for entry in self.report.entries}
        self.assertEqual(types, {"choice", "blank"}, f"题库题型集合变了：{sorted(types)}")
        self.assertTrue(types <= {"choice", "blank", "code_blank"}, "出现了第一版范围外的题型")

    def test_every_question_points_at_a_real_kp_in_the_same_grade(self) -> None:
        for entry in self.report.entries:
            doc = self.docs.get(entry.question.kp_id)
            self.assertIsNotNone(
                doc, f"{entry.question.qid} 的知识点 {entry.question.kp_id} 不在教材里"
            )
            self.assertEqual(
                doc.grade_level,
                entry.grade_level,
                f"{entry.question.qid} 逐题推导出的学段是 {entry.grade_level}，"
                f"但知识点属于 {doc.grade_level}（题库与教材学段错位）",
            )

    def test_qids_are_unique(self) -> None:
        qids = [entry.question.qid for entry in self.report.entries]
        self.assertEqual(len(qids), len(set(qids)), "题库里有重复 qid")

    def test_out_of_scope_helper_flags_primary_low_terms(self) -> None:
        """★ 超纲自检：小学低年级题干里出现更高的术语即违规（票 14 的口径）。"""
        # 术语文表换代（K12KnowledgeBase）：这两个词的 min_grade 是 junior，
        # 小学低年级题干里出现即超纲。逐条断言「判据真的卡在学段上」。
        self.assertIn("决策树", out_of_scope_terms("用决策树帮小明分类", "primary_low"))
        self.assertIn("特征向量", out_of_scope_terms("特征向量的长度", "primary_low"))
        # 反向对照：同一句话给初中生**不**算超纲（否则「超纲」二字就没了判别力）
        self.assertEqual(out_of_scope_terms("用决策树帮小明分类", "junior"), [])
        # 也不许把「本学段就该讲」的词误判成超纲（算法是 primary_low 起）
        self.assertEqual(out_of_scope_terms("用算法帮小明分类", "primary_low"), [])

    def test_d5_bank_load_reads_the_terminology_file_once(self) -> None:
        """★ D5 回归：``load_bank`` 逐题自检时**只读一次**术语表（不是每题一次）。

        修复前 ``out_of_scope_terms`` 内部每题都调 ``load_terminology(KNOWLEDGE_DIR)``：
        一次取题（或一次判分查库）就是「题数」次文件读 —— 旧题库 81 题时实测 82 次，
        新题库 684 题只会更贵（而判分路径每答一题都要调一次）。
        这里用**计数替身**盯住调用次数（比断言耗时稳，也不受磁盘缓存影响）。
        """
        calls = {"n": 0}
        real_loader = quiz_module.load_terminology

        def counting_loader(path: object) -> dict:
            calls["n"] += 1
            return real_loader(path)

        quiz_module.load_terminology = counting_loader
        quiz_module.reset_terminology_cache()
        try:
            report = load_bank(BANK_DIR)
        finally:
            quiz_module.load_terminology = real_loader
            quiz_module.reset_terminology_cache()

        self.assertGreater(len(report.entries), 1, "题库得有题，这条断言才有意义")
        self.assertLessEqual(calls["n"], 1, f"逐题自检却读了 {calls['n']} 次术语表")

    def test_d5_out_of_scope_terms_accepts_an_injected_table(self) -> None:
        """显式传入术语文表时**不读盘**，且判定结果与默认路径一致（向后兼容）。

        ⚠️ 夹具用**注入的那张表**造出一条「默认表里没有」的超纲关系：
        拿随包表里本就 min_grade=primary_low 的词（例如「算法」）当例子，
        这条断言会退化成「注入不生效也绿」—— 那正是它要防的空转。
        """
        table = {"terms": [{"term": "冒泡排序", "min_grade": "junior"}], "tone_markers": []}
        self.assertEqual(
            out_of_scope_terms("用冒泡排序帮小明排一下", "primary_low", terminology=table),
            ["冒泡排序"],
        )
        self.assertEqual(
            out_of_scope_terms("用冒泡排序帮小明排一下", "junior", terminology=table), []
        )
        # 不传 = 走默认路径（旧调用方照常工作），且默认表确实认得出它的那一条
        self.assertIn("决策树", out_of_scope_terms("用决策树帮小明分类", "primary_low"))


# --------------------------------------------------------------------------- #
# 学段隔离（取题方向）
# --------------------------------------------------------------------------- #
class TestGradeIsolation(QuizCase):
    def test_junior_gets_junior_questions(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/prog-loop-jr", params={"gradeLevel": "junior", "count": 5}
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["questions"])

    def test_junior_never_gets_senior_questions(self) -> None:
        """初中生问高中知识点 → 取不到题（404），**绝不返回超纲题**。"""
        response = self.client.get(
            "/api/quiz/bank/ai-definition-sr", params={"gradeLevel": "junior"}
        )
        self.assertEqual(response.status_code, 404)
        self.assertIn("没有题目", response.json()["detail"])

    def test_primary_low_never_gets_any_higher_grade(self) -> None:
        """★ 最强的那对对照：小学低年级取**同一概念**的更高学段，三档全部 404。

        「同一个概念、只差学段」把「按学段隔离」和「这个 kp 根本没题」区分开了：
        如果哪天隔离被放宽，这三条会立刻变成 200 而当场变红。
        """
        for kp_id in ("ai-definition-ph", "ai-definition-jr", "ai-definition-sr"):
            with self.subTest(kp=kp_id):
                response = self.client.get(
                    f"/api/quiz/bank/{kp_id}", params={"gradeLevel": "primary_low"}
                )
                self.assertEqual(response.status_code, 404, response.text)
        # 反向对照：同一个 kp_id 给对应学段就取得到（证明上一条不是「这个 kp 没题」）
        ok = self.client.get(
            "/api/quiz/bank/ai-definition-sr", params={"gradeLevel": "senior"}
        )
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertTrue(ok.json()["questions"])

    def test_senior_can_review_lower_grade_questions(self) -> None:
        """向上兼容方向是「高中生回看初中题」，与检索链一致。"""
        response = self.client.get(
            "/api/quiz/bank/prog-loop-jr", params={"gradeLevel": "senior"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["questions"])

    def test_allow_compat_false_restricts_to_exact_grade(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/prog-loop-jr",
            params={"gradeLevel": "senior", "allowCompat": "false"},
        )
        self.assertEqual(response.status_code, 404)

    def test_select_questions_orders_exact_grade_first(self) -> None:
        report = load_bank(BANK_DIR)
        picked = select_questions(
            report, kp_id="prog-loop-jr", grade_level="senior", count=2, allow_compat=True
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
            "/api/quiz/bank/prog-loop-jr", params={"gradeLevel": "junior", "count": 5}
        )
        raw = response.text
        payload = json.loads(raw)
        self.assertNotIn(
            "answer",
            self._keys(payload),
            f"对外题目载荷里出现了 answer 键：{raw}",
        )
        # 题目字段就是 QuizQuestionOut 的那 5 个（多一个都算契约外字段）。
        # ⚠️ `explanation` **不在**其中：解析里 43% 直接写着标准答案，随题面下发等于送答案。
        #    它在**判分之后**经 `QuizResult.feedback` 回来（另有专门的用例盯着那条）。
        for question in payload["questions"]:
            self.assertEqual(
                set(question),
                {"qid", "kpId", "type", "stem", "options"},
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
                            "kp_id": "prog-loop-jr",
                            "type": "blank",
                            "stem": "哨兵题：请填空（答案不该出现在这里）",
                            "answer": SENTINEL_ANSWER,
                            "explanation": "哨兵题只用于验证答案不外泄。",
                        },
                        {
                            "qid": "sentinel-q2",
                            "kp_id": "prog-loop-jr",
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
            "/api/quiz/bank/prog-loop-jr", params={"gradeLevel": "junior", "count": 5}
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
            "/api/quiz/bank/prog-loop-jr", params={"gradeLevel": "junior"}
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
        body = {"studentId": "student_001", "qid": "prog-loop-jr-q1", "answer": "循环变量"}
        first = self.grade(**body).json()
        self.assertTrue(first["correct"])
        self.assertEqual(first["scoredBy"], "rule")
        self.assertLessEqual(abs(first["masteryDelta"]), MASTERY_DELTA_LIMIT)
        self.assertAlmostEqual(first["masteryDelta"], MASTERY_GAIN_CORRECT, places=6)
        self.assertLess(first["masteryDelta"], 1.0, "一次答题不能把掌握度从 0 顶到 1")

        row = self._mastery_row("student_001", "prog-loop-jr")
        self.assertIsNotNone(row)
        self.assertAlmostEqual(row["score"], MASTERY_GAIN_CORRECT, places=6)
        self.assertEqual(row["attempts"], 1)
        self.assertEqual(row["correct"], 1)
        self.assertIsNotNone(row["last_seen_at"])

    def test_wrong_answer_delta_is_clamped_and_never_goes_below_zero(self) -> None:
        # ★ 用**同一知识点的两道不同题**（`-q1` 答对、`-q2` 答错）而不是同一道题答两次：
        #   判分口径是**首次作答决定**（H-3），同一 qid 的第二次提交不再改掌握度 ——
        #   拿同一道题当夹具，测出来的是幂等（另有专门的用例），不是限幅。
        #   先答对一次把掌握度抬到 0.15，再答错 —— 否则 0 减去任何值都会被截到 0，
        #   测出来是「0 变化」而不是「负变化」，等于没测到限幅。
        self.grade(studentId="student_002", qid="prog-loop-jr-q1", answer="循环变量")
        result = self.grade(
            studentId="student_002", qid="prog-loop-jr-q2", answer="随便选一个错的"
        ).json()
        self.assertFalse(result["correct"])
        self.assertAlmostEqual(result["masteryDelta"], -MASTERY_LOSS_WRONG, places=6)
        self.assertGreaterEqual(result["masteryDelta"], -MASTERY_DELTA_LIMIT)

        row = self._mastery_row("student_002", "prog-loop-jr")
        self.assertEqual(row["attempts"], 2)
        self.assertEqual(row["correct"], 1)
        self.assertAlmostEqual(row["score"], MASTERY_GAIN_CORRECT - MASTERY_LOSS_WRONG, places=6)

        # 全新学生答错：掌握度停在 0（不能为负），回报的增量也就是 0
        fresh = self.grade(
            studentId="student_012", qid="prog-loop-jr-q1", answer="循环次数"
        ).json()
        self.assertFalse(fresh["correct"])
        self.assertEqual(fresh["masteryDelta"], 0.0)
        self.assertEqual(self._mastery_row("student_012", "prog-loop-jr")["score"], 0.0)

    def test_repeated_answers_do_not_move_mastery_twice(self) -> None:
        """★★ 判分幂等（H-3）：**首次作答决定** —— 重复提交同一道题不再改掌握度。

        缺陷形态（修之前实测）：同一道题连点 4 次就能把掌握度从 0.15 刷到 0.6
        （``attempts`` 记到 4），顺手满足解锁阈值 —— 而学生并没有多会一点。
        掌握度是**能力信号**（推荐/画像要吃它），反复刷不该改变它。

        ★ 同时钉住「答错后可以再答」这一半：重复提交**照常判分、照常给反馈**
        （学生要看到这次对没对），只是反馈里必须**说实话**（说这是重复作答、不计分）。
        """
        wrong = self.grade(
            studentId="student_003", qid="prog-loop-jr-q1", answer="循环次数"
        ).json()
        self.assertFalse(wrong["correct"])
        self.assertEqual(wrong["masteryDelta"], 0.0, "全新学生答错，掌握度停在 0")
        self.assertNotIn("已经答过", wrong["feedback"], "第一次作答不该被说成重复作答")

        # 反手答对：**判分照旧**（correct 仍然是 true），但掌握度不动
        repeat = self.grade(
            studentId="student_003", qid="prog-loop-jr-q1", answer="循环变量"
        ).json()
        self.assertTrue(repeat["correct"], "重复作答照常判分（学生要看到这次对没对）")
        self.assertEqual(repeat["masteryDelta"], 0.0, "★ 重复作答不得再动掌握度")
        self.assertIn("已经答过", repeat["feedback"], "★ 必须如实告诉学生这次不计分")

        row = self._mastery_row("student_003", "prog-loop-jr")
        self.assertEqual(row["score"], 0.0, "★ 掌握度只由第一次（答错）决定")
        self.assertEqual(row["attempts"], 1, "★ attempts 不该被重复提交刷高")
        self.assertEqual(row["correct"], 0, "★ correct 不该被后一次答对改写")

    def test_repeat_attempt_still_lands_in_history_but_not_in_progress(self) -> None:
        """★★ 重复作答的落库边界：``learning_history`` 照写，``progress`` 不重复推进。

        :func:`_record_attempt` 写三样东西，重复作答时**只有流水账该长**：

        - ``learning_history``：**照写**（学生确实又答了一次，抹掉等于篡改记录）；
        - ``progress``（stage / 徽章 / 解锁）：**不写**（「走过没走过」不因重复提交改变）；
        - ``mastery``：**不动**（上一个用例已断言）。
        """
        qid = "prog-loop-jr-q1"
        for _ in range(4):
            self.grade(studentId="student_013", qid=qid, answer="循环变量")

        conn = sqlite3.connect(student_db_path(self.tmp, "student_013"))
        conn.row_factory = sqlite3.Row
        try:
            rows = list(
                conn.execute(
                    "SELECT detail FROM learning_history WHERE activity = 'quiz' ORDER BY id"
                )
            )
            # ① 流水账：4 次提交 = 4 条记录（别把学生的练习历史抹掉）
            self.assertEqual(len(rows), 4, "重复作答也要留下流水（它是记录，不是计数）")
            details = [json.loads(row["detail"]) for row in rows]
            self.assertNotIn("repeat", details[0], "第一次作答不是重复")
            for detail in details[1:]:
                self.assertTrue(detail.get("repeat"), "第 2 次起都要标记成重复作答")
                self.assertFalse(detail.get("counted"), "并显式记下「没计分」")
                self.assertEqual(detail["masteryDelta"], 0.0)

            # ② 闯关进度：徽章只反映第一次
            progress = {
                row["kp_id"]: dict(row)
                for row in conn.execute("SELECT kp_id, stage, badge FROM progress")
            }
            self.assertEqual(progress["prog-loop-jr"]["badge"], "起步-1", "★ 徽章只计第一次")
        finally:
            conn.close()

    def test_repeat_attempt_is_per_question_not_per_knowledge_point(self) -> None:
        """★ 幂等判据是**按 qid** 的：换一道题就重新计分（不能把整关都锁死）。

        反面形态：若判据写成「这个 kp 答过没有」，学生在同一关里的第 2 道题就永远
        不再计分 —— 那会让「多练几道」变成「练了也白练」。
        """
        first = self.grade(
            studentId="student_014", qid="prog-loop-jr-q1", answer="循环变量"
        ).json()
        self.assertAlmostEqual(first["masteryDelta"], MASTERY_GAIN_CORRECT, places=6)

        second = self.grade(
            studentId="student_014", qid="prog-loop-jr-q2", answer="`for`，因为它最常用"
        ).json()
        self.assertFalse(second["correct"], "这道题选了错的选项")
        self.assertAlmostEqual(
            second["masteryDelta"], -MASTERY_LOSS_WRONG, places=6,
            msg="★ 换一道题必须重新计分（掌握度按题累加，不是按知识点只算一次）",
        )

    def test_attempt_is_written_to_learning_history(self) -> None:
        self.grade(
            studentId="student_004",
            qid="prog-loop-jr-q1",
            answer="循环变量",
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
        self.assertEqual(rows[0][1], "prog-loop-jr")
        self.assertEqual(rows[0][2], 1)
        self.assertEqual(rows[0][3], "turn_abc")

    def test_students_do_not_share_a_database(self) -> None:
        self.grade(studentId="student_010", qid="prog-loop-jr-q1", answer="循环变量")
        self.grade(studentId="student_011", qid="prog-loop-jr-q1", answer="循环次数")
        a = self._mastery_row("student_010", "prog-loop-jr")["score"]
        b = self._mastery_row("student_011", "prog-loop-jr")["score"]
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
            "/api/quiz/bank/prog-variable-jr", params={"gradeLevel": "junior"}
        ).json()
        self.assertEqual(set(payload), {"kpId", "questions", "source"})
        self.assertEqual(payload["source"], "bank")
        self.assertLessEqual(len(payload["questions"]), 3)

    def test_snake_case_query_params_also_accepted(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/prog-variable-jr", params={"grade_level": "junior"}
        )
        self.assertEqual(response.status_code, 200)

    def test_missing_grade_is_422(self) -> None:
        self.assertEqual(self.client.get("/api/quiz/bank/prog-variable-jr").status_code, 422)

    def test_bad_grade_is_422(self) -> None:
        response = self.client.get(
            "/api/quiz/bank/prog-variable-jr", params={"gradeLevel": "college"}
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
        response = self.grade(studentId="../../evil", qid="prog-loop-jr-q1", answer="循环变量")
        self.assertEqual(response.status_code, 422)
        self.assertFalse((self.tmp.parent / "evil").exists())

    def test_grade_rejects_unknown_field(self) -> None:
        """契约 forbid 额外字段（临时加松散字段必须 422）。"""
        response = self.client.post(
            "/api/quiz/grade",
            json={"studentId": "student_001", "qid": "prog-loop-jr-q1", "answer": "循环变量", "oops": 1},
        )
        self.assertEqual(response.status_code, 422)

    def test_grade_result_shape(self) -> None:
        payload = self.grade(
            studentId="student_001", qid="prog-loop-jr-q1", answer="循环变量"
        ).json()
        self.assertEqual(
            set(payload), {"qid", "correct", "scoredBy", "feedback", "masteryDelta"}
        )
        self.assertIn("答对了", payload["feedback"])
        self.assertEqual(payload["scoredBy"], "rule")

    def test_feedback_of_wrong_answer_is_chinese_and_readable(self) -> None:
        payload = self.grade(
            studentId="student_005", qid="prog-loop-jr-q1", answer="完全不对"
        ).json()
        self.assertFalse(payload["correct"])
        self.assertIn("再", payload["feedback"])
        self.assertTrue(payload["feedback"].strip())


class TestQuizRoutesRequireExplicitDataDir(unittest.TestCase):
    """★ D4 回归：**没有显式 ``--data-dir`` 时练习路由必须 503**，不得写进共享兜底目录。

    修复前四处 ``LearningStore(student_db_path(config.data_dir, ...))`` 直接用
    ``config.data_dir``（兜底 = ``server/_data``）→ 单测/手工 curl/多次运行会把学生数据
    混进仓库里的**共享**目录；而画像 / 学段 / 动画三条轨早已按
    ``resolve_student_data_root`` 拒收（503）。四条轨必须同一个口径。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config())  # ★ 故意不传 data_dir
        self.app.include_router(quiz_router)
        self.client = TestClient(self.app)

    def test_grade_returns_503_instead_of_writing_to_the_shared_dir(self) -> None:
        response = self.client.post(
            "/api/quiz/grade",
            json={"studentId": "student_999", "qid": "prog-loop-jr-q1", "answer": "循环变量"},
        )
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("data-dir", response.json()["detail"])
        self.assertFalse(
            (resolve_data_dir(None) / "students" / "student_999").exists(),
            "共享兜底目录不该出现本用例的学生",
        )

    def test_variants_subjective_and_progress_all_return_503(self) -> None:
        """四条写库路径**全部**同源：漏掉任何一条就等于留了一个共享目录的口子。"""
        variants = self.client.post(
            "/api/quiz/variants",
            params={"student_id": "student_999"},
            json={
                "gradeLevel": "junior",
                "questions": [
                    {
                        # ★ qid 用生成题的标准形状（`gen-` 前缀）：本用例要说的是「没 data-dir
                        #   就 503」，若夹具先在**校验层**被拒（422），这条断言就测不到它想测的东西。
                        "qid": "gen-prog-loop-jr-v1-1",
                        "kpId": "prog-loop-jr",
                        "type": "blank",
                        "stem": "1 到 5 用什么函数？",
                        "referenceAnswer": "range",
                    }
                ],
            },
        )
        self.assertEqual(variants.status_code, 503, variants.text)

        subjective = self.client.post(
            "/api/quiz/grade-subjective",
            json={
                "studentId": "student_999",
                "qid": "gen-prog-loop-jr-v1-1",
                "score": 0.9,
                "feedback": "不错",
            },
        )
        self.assertEqual(subjective.status_code, 503, subjective.text)

        progress = self.client.get("/api/quiz/progress/student_999")
        self.assertEqual(progress.status_code, 503, progress.text)

        self.assertFalse(
            (resolve_data_dir(None) / "students" / "student_999").exists(),
            "共享兜底目录不该出现本用例的学生",
        )


class TestSharedResourcesAreReachable(unittest.TestCase):
    def test_resources_dir_contains_quizbank(self) -> None:
        self.assertTrue((Path(RESOURCES_DIR) / "quizbank").is_dir())
        self.assertGreaterEqual(len(list(default_bank_dir().glob("*.json"))), 4)


if __name__ == "__main__":
    unittest.main()
