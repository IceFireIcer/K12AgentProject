# -*- coding: utf-8 -*-
"""票 15：主观题批改 + 变式生成 + **闯关闭环（关卡 D）**。

这一组断言盯住六条「错了就静默出事」的红线，每一条都对应一个陷阱：

1. ★★ **答案不泄漏**（§6.3）：用一个**唯一哨兵串**当标准答案/评分细则，走完
   `/api/quiz/variants` 与 `/api/quiz/grade` 全链路，哨兵在响应 JSON 里必须**零命中**
   （含嵌套键名 —— 逐层递归查 `answer` / `rubric` 这类键）；
2. ★ **掌握度限幅 ±0.2**：单次答题不可能把 mastery 从 0 顶到 1（连续答对 4 次才到 0.6）；
3. ★ **闯关状态机**：`locked → learning → quizzed → mastered` 的转移条件逐条断言，
   且**答错不回退**、**答错不解锁后继**；
4. ★ **解锁条件**：「目标 kp 掌握度 ≥ 阈值 **且** 当前 kp 已 quizzed」才解锁后继
   （两个条件各自不成立时的用例都有）；
5. **混合批改**：客观题走 `rule`、带评分细则的主观题走 `llm`；
   两条路径**互相走不通**（客观题走主观端点 409、主观题走规则端点 409）；
6. **冷启动**：全新学生 id 直接问进度 / 推荐 → 自动初始化默认路径（首关可做），
   不空指针、不 500。

夹具用**真的** `server/_data/shared/kb.sqlite`（有真实依赖图）与真题库文件，
因为这一票要断言的正是「关卡顺序来自依赖图」这件事。kb 不存在时跳过对应用例
（而不是假装通过）—— 跳过时打印原因。
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
from app.contracts import MASTERY_DELTA_LIMIT, QuizQuestion, QuizQuestionOut  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes.quiz import (  # noqa: E402
    BADGE_LEVELS,
    MASTERED_CORRECT_NEEDED,
    MASTERY_GAIN_CORRECT,
    MASTERY_UNLOCK_THRESHOLD,
    QUIZZED_CORRECT_NEEDED,
    SUBJECTIVE_PASS_RATIO,
    advance_stage,
    badge_for,
    correct_count_from_badge,
    is_subjective,
    level_order_from_graph,
    normalize_answer,
    subjective_feedback,
    unlocked_successor_ids,
)
from app.store.learning import GeneratedQuestionRecord, LearningStore  # noqa: E402

#: ★ 哨兵：只可能来自题目的标准答案 / 评分细则。它一旦出现在响应 JSON 里就是答案泄漏。
SENTINEL_ANSWER = "哨兵标准答案-ZX91-不得出现在任何响应里"
SENTINEL_RUBRIC = "哨兵评分细则-ZX92-不得出现在任何响应里"

#: 真实知识库（含依赖图）。缺失时依赖图的用例跳过。
REAL_KB = Path(ROOT) / "_data" / "shared" / "kb.sqlite"


def _variant(
    qid: str,
    kp_id: str,
    *,
    qtype: str = "blank",
    stem: str = "1 + 1 = ___",
    answer: object = "2",
    options: list[str] | None = None,
    rubric: str | None = None,
) -> dict:
    body: dict = {
        "qid": qid,
        "kpId": kp_id,
        "type": qtype,
        "stem": stem,
        "referenceAnswer": answer,
        "explanation": "讲解文本（不含答案哨兵）",
        "options": options,
    }
    if rubric is not None:
        body["rubric"] = rubric
    return body


class LoopCase(unittest.TestCase):
    """带临时 userData 的基类；**真的**把 kb 拷进去，让解锁判定有图可查。"""

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

    # ------------------------------------------------------------ 小工具 --
    @property
    def student(self) -> str:
        return self._student

    def set_student(self, name: str) -> str:
        self._student = name
        return name

    def register(self, questions: list[dict], *, grade: str = "junior") -> object:
        return self.client.post(
            f"/api/quiz/variants?student_id={self.student}",
            json={"gradeLevel": grade, "questions": questions},
        )

    def grade(self, qid: str, answer: object) -> object:
        return self.client.post(
            "/api/quiz/grade",
            json={
                "studentId": self.student,
                "qid": qid,
                "answer": answer,
                "sessionId": "sess-test",
            },
        )

    def grade_subjective(self, qid: str, score: float, feedback: str = "说得挺清楚") -> object:
        return self.client.post(
            "/api/quiz/grade-subjective",
            json={
                "studentId": self.student,
                "qid": qid,
                "score": score,
                "feedback": feedback,
                "sessionId": "sess-test",
            },
        )

    def progress(self, **params) -> object:
        return self.client.get(f"/api/quiz/progress/{self.student}", params=params)

    def level(self, kp_id: str) -> dict | None:
        body = self.progress().json()
        for item in body.get("levels", []):
            if item["kpId"] == kp_id:
                return item
        return None

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        db = self.tmp / "students" / self.student / "learning.db"
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        try:
            return list(conn.execute(sql, params))
        finally:
            conn.close()

    @staticmethod
    def _all_keys(node, found: list[str]) -> list[str]:
        """递归收集 JSON 里出现过的所有键名（答案可能藏在嵌套结构里）。"""
        if isinstance(node, dict):
            for key, value in node.items():
                found.append(str(key))
                LoopCase._all_keys(value, found)
        elif isinstance(node, list):
            for item in node:
                LoopCase._all_keys(item, found)
        return found


# --------------------------------------------------------------------------- #
# 1. ★★ 答案不泄漏
# --------------------------------------------------------------------------- #
class TestAnswerNeverLeavesBackend(LoopCase):
    def setUp(self) -> None:
        super().setUp()
        self.set_student("student_leak")

    def test_sentinel_absent_from_variant_registration_response(self) -> None:
        """登记变式题：**入参带答案**，出参里哨兵必须零命中。"""
        response = self.register(
            [
                _variant("leak-q1", "jr-py-variable", answer=SENTINEL_ANSWER),
                _variant(
                    "leak-q2",
                    "jr-py-variable",
                    stem="说说什么是变量",
                    answer="给数据起名字",
                    rubric=SENTINEL_RUBRIC,
                ),
            ]
        )
        self.assertEqual(response.status_code, 200, response.text)
        raw = response.text
        self.assertNotIn(SENTINEL_ANSWER, raw, "★ 标准答案泄漏进了登记回执")
        self.assertNotIn(SENTINEL_RUBRIC, raw, "★ 评分细则泄漏进了登记回执")

        payload = json.loads(raw)
        keys = self._all_keys(payload, [])
        for forbidden in ("answer", "referenceAnswer", "rubric"):
            self.assertNotIn(forbidden, keys, f"★ 登记回执里出现了 {forbidden} 键：{raw}")
        # 每道题就是对外形态的那 6 个字段
        for question in payload["questions"]:
            self.assertEqual(
                set(question),
                {"qid", "kpId", "type", "stem", "options", "explanation"},
                f"对外题目字段不对：{question}",
            )

    def test_sentinel_absent_from_grading_response(self) -> None:
        """判分回执里也不许回显标准答案（回显 = 送答案）。"""
        self.register([_variant("leak-q3", "jr-py-variable", answer=SENTINEL_ANSWER)])
        hit = self.grade("leak-q3", SENTINEL_ANSWER)
        self.assertEqual(hit.status_code, 200)
        self.assertTrue(hit.json()["correct"])
        self.assertNotIn(SENTINEL_ANSWER, hit.text, "★ 判分回执回显了标准答案")

        miss = self.grade("leak-q3", "随便写一个不一样的")
        self.assertFalse(miss.json()["correct"])
        self.assertNotIn(SENTINEL_ANSWER, miss.text, "★ 答错时的反馈里回显了标准答案")

    def test_sentinel_absent_from_wrong_answer_feedback_round_trip(self) -> None:
        """连判多次（含答错）后，**整段会话的响应**里都不出现哨兵。"""
        self.register(
            [_variant("leak-q4", "jr-py-variable", answer=SENTINEL_ANSWER, rubric=SENTINEL_RUBRIC)]
        )
        self.grade("leak-q4", "先随便答一次")
        self.grade_subjective("leak-q4", 0.8)
        for response in (self.grade("leak-q4", "再乱答一次"), self.progress()):
            self.assertNotIn(SENTINEL_ANSWER, response.text)
            self.assertNotIn(SENTINEL_RUBRIC, response.text)

    def test_internal_model_really_has_the_answer(self) -> None:
        """反向对照：内部模型**有** ``answer``，对外模型**没有** —— 上面不是「字段压根不存在」。"""
        self.assertIn("answer", QuizQuestion.model_fields)
        self.assertNotIn("answer", QuizQuestionOut.model_fields)

    def test_rubric_is_not_in_the_outward_contract(self) -> None:
        """评分细则与答案同等待遇：它只在 Python 侧（`generated_question.rubric`）。"""
        self.assertNotIn("rubric", QuizQuestionOut.model_fields)
        # 出参契约里也没有它
        self.assertNotIn("rubric", json.dumps(self.client.get(
            "/api/quiz/bank/jr-py-variable", params={"gradeLevel": "junior"}
        ).json()))


# --------------------------------------------------------------------------- #
# 2. 状态机（纯函数）
# --------------------------------------------------------------------------- #
class TestStageMachine(unittest.TestCase):
    def test_learning_entry(self) -> None:
        """第一次作答（哪怕答错）就进入 learning：学生确实开始做这一关了。"""
        self.assertEqual(
            advance_stage(current_stage=None, mastery_score=0.0, correct_count=0), "learning"
        )

    def test_quizzed_requires_a_correct_answer(self) -> None:
        self.assertEqual(
            advance_stage(
                current_stage="learning",
                mastery_score=0.15,
                correct_count=QUIZZED_CORRECT_NEEDED,
            ),
            "quizzed",
        )

    def test_mastered_requires_both_count_and_mastery(self) -> None:
        """★ 两个条件缺一不可：光答对够数但掌握度不够 → 停在 quizzed。"""
        self.assertEqual(
            advance_stage(
                current_stage="quizzed",
                mastery_score=MASTERY_UNLOCK_THRESHOLD - 0.01,
                correct_count=MASTERED_CORRECT_NEEDED,
            ),
            "quizzed",
            "掌握度不够时不应判 mastered",
        )
        self.assertEqual(
            advance_stage(
                current_stage="quizzed",
                mastery_score=MASTERY_UNLOCK_THRESHOLD,
                correct_count=MASTERED_CORRECT_NEEDED,
            ),
            "mastered",
        )
        self.assertEqual(
            advance_stage(
                current_stage="learning",
                mastery_score=1.0,
                correct_count=MASTERED_CORRECT_NEEDED - 1,
            ),
            "quizzed",
            "答对题数不够时不应判 mastered",
        )

    def test_mastered_is_monotonic(self) -> None:
        """已经 mastered 就不回退（答错不把状态打回去 —— 那是掌握度的事）。"""
        self.assertEqual(
            advance_stage(current_stage="mastered", mastery_score=0.0, correct_count=2),
            "mastered",
        )

    def test_badge_tiers_and_count_round_trip(self) -> None:
        self.assertIsNone(badge_for(0), "没答对就不该有徽章")
        self.assertEqual(badge_for(1), f"{BADGE_LEVELS[0]}-1")
        self.assertEqual(badge_for(99), f"{BADGE_LEVELS[-1]}-99", "档位封顶但计数如实记录")
        for count in (1, 2, 3, 7, 99):
            self.assertEqual(correct_count_from_badge(badge_for(count)), count)
        self.assertEqual(correct_count_from_badge(None), 0)
        self.assertEqual(correct_count_from_badge("乱码"), 0, "认不出退回 0，不抛异常")


# --------------------------------------------------------------------------- #
# 3. ★ 解锁规则（纯函数）
# --------------------------------------------------------------------------- #
class TestUnlockRule(unittest.TestCase):
    """★「目标 kp 掌握度 ≥ 阈值 **且** 当前 kp 已 quizzed」才解锁后继。"""

    def test_both_conditions_must_hold(self) -> None:
        succ = ["kp-next"]
        # ① 没 quizzed（还在 learning）→ 不解锁（即便掌握度已经过阈值）
        self.assertEqual(
            unlocked_successor_ids(
                current_kp_id="kp-a",
                current_stage="learning",
                mastery_score=0.9,
                successor_ids=succ,
            ),
            [],
        )
        # ② 已 quizzed 但掌握度不达标 → 不解锁（**答错后就是这种状态**）
        self.assertEqual(
            unlocked_successor_ids(
                current_kp_id="kp-a",
                current_stage="quizzed",
                mastery_score=MASTERY_UNLOCK_THRESHOLD - 0.01,
                successor_ids=succ,
            ),
            [],
        )
        # ③ 两条都成立 → 解锁
        self.assertEqual(
            unlocked_successor_ids(
                current_kp_id="kp-a",
                current_stage="quizzed",
                mastery_score=MASTERY_UNLOCK_THRESHOLD,
                successor_ids=succ,
            ),
            succ,
        )

    def test_mastered_also_unlocks(self) -> None:
        self.assertEqual(
            unlocked_successor_ids(
                current_kp_id="kp-a",
                current_stage="mastered",
                mastery_score=1.0,
                successor_ids=["kp-next"],
            ),
            ["kp-next"],
        )

    def test_no_successors_or_self_loop(self) -> None:
        self.assertEqual(
            unlocked_successor_ids(
                current_kp_id="kp-a",
                current_stage="mastered",
                mastery_score=1.0,
                successor_ids=[],
            ),
            [],
        )
        self.assertEqual(
            unlocked_successor_ids(
                current_kp_id="kp-a",
                current_stage="mastered",
                mastery_score=1.0,
                successor_ids=["kp-a"],
            ),
            [],
            "自环不该被当成「新解锁了一关」",
        )


# --------------------------------------------------------------------------- #
# 4. ★ 主观题 / 客观题两条路径互不串台
# --------------------------------------------------------------------------- #
class TestSubjectiveGrading(LoopCase):
    def setUp(self) -> None:
        super().setUp()
        self.set_student("student_subjective")

    def test_is_subjective_reads_the_rubric(self) -> None:
        objective = GeneratedQuestionRecord(
            qid="q", kp_id="kp", grade_level="junior", type="blank", stem="s",
            options=None, reference_answer="2", explanation="", rubric=None,
            source="generated", created_at=None,
        )
        subjective = GeneratedQuestionRecord(
            qid="q", kp_id="kp", grade_level="junior", type="blank", stem="s",
            options=None, reference_answer="参考答案", explanation="",
            rubric="要点一；要点二", source="generated", created_at=None,
        )
        self.assertFalse(is_subjective(objective))
        self.assertTrue(is_subjective(subjective))
        self.assertFalse(
            is_subjective(
                GeneratedQuestionRecord(
                    qid="q", kp_id="kp", grade_level="junior", type="blank", stem="s",
                    options=None, reference_answer="x", explanation="", rubric="   ",
                    source="generated", created_at=None,
                )
            ),
            "只有空白的细则不算主观题",
        )

    def test_register_subjective_and_grade_by_llm(self) -> None:
        self.register(
            [
                _variant(
                    "sub-q1", "jr-py-variable",
                    stem="说说什么是变量",
                    answer="给数据起名字",
                    rubric="要点：变量是给数据起的名字（能提到「存数据」即可给满分）",
                )
            ]
        )
        response = self.grade_subjective("sub-q1", 0.9, "说出了「给数据起名字」这个要点。")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(
            set(body), {"qid", "correct", "scoredBy", "feedback", "masteryDelta"}
        )
        self.assertEqual(body["scoredBy"], "llm")
        self.assertTrue(body["correct"], f"0.9 ≥ 阈值 {SUBJECTIVE_PASS_RATIO} 应判答对")
        self.assertIn("说出", body["feedback"], "模型反馈应体现在最终反馈里")
        self.assertLessEqual(abs(body["masteryDelta"]), MASTERY_DELTA_LIMIT)

    def test_pass_threshold_is_enforced_server_side(self) -> None:
        """★「多少分算过」由服务端定：送进来的只有 score，没有对错。"""
        self.register(
            [_variant("sub-q2", "jr-py-variable", stem="开放题", answer="参考", rubric="要点")]
        )
        low = self.grade_subjective("sub-q2", SUBJECTIVE_PASS_RATIO - 0.01)
        self.assertFalse(low.json()["correct"], "低于阈值应判错（即便模型说「还不错」）")
        # 掌握度本来就在 0，扣分被下限夹到 0 → delta 是 0（而不是一个没发生的 -0.1）
        self.assertEqual(low.json()["masteryDelta"], 0.0)

        high = self.grade_subjective("sub-q2", SUBJECTIVE_PASS_RATIO)
        self.assertTrue(high.json()["correct"], "到阈值即判对")
        self.assertGreater(high.json()["masteryDelta"], 0)

    def test_objective_question_cannot_use_the_subjective_path(self) -> None:
        """★ 客观题走主观端点 = 试图绕开规则判分 → 409。"""
        self.register([_variant("obj-1", "jr-py-variable", answer="2")])
        response = self.grade_subjective("obj-1", 1.0)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("客观题", response.json()["detail"])

    def test_subjective_question_cannot_use_the_rule_path(self) -> None:
        """★ 主观题走规则端点 = 会把好答案判错 → 409。"""
        self.register(
            [_variant("sub-q3", "jr-py-variable", stem="开放", answer="参考", rubric="要点")]
        )
        response = self.grade("sub-q3", "参考")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("主观题", response.json()["detail"])

    def test_unknown_qid_on_subjective_path_is_404(self) -> None:
        response = self.grade_subjective("ghost-qid", 0.9)
        self.assertEqual(response.status_code, 404)

    def test_score_out_of_range_is_422(self) -> None:
        """`score` 必须落在 0..1（契约层挡下，不允许「没判就落库」）。"""
        self.register(
            [_variant("sub-q4", "jr-py-variable", stem="开放", answer="参考", rubric="要点")]
        )
        for bad in (-0.1, 1.5):
            response = self.client.post(
                "/api/quiz/grade-subjective",
                json={"studentId": self.student, "qid": "sub-q4", "score": bad},
            )
            self.assertEqual(response.status_code, 422, f"score={bad} 应被拒")

    def test_subjective_feedback_states_the_verdict(self) -> None:
        """模型措辞与规则判定不一致时，最终反馈必须把**系统的结论**说清楚。"""
        text = subjective_feedback(score=0.3, correct=False, raw_feedback="回答得不错")
        self.assertIn("回答得不错", text, "模型的话要保留")
        self.assertIn("差一点", text, "系统的结论要显式写出来")
        self.assertIn("30%", text, "分数要给学生看到")


# --------------------------------------------------------------------------- #
# 5. 变式题登记
# --------------------------------------------------------------------------- #
class TestVariantRegistration(LoopCase):
    def setUp(self) -> None:
        super().setUp()
        self.set_student("student_variants")

    def test_generated_source_and_shape(self) -> None:
        response = self.register([_variant("v-1", "jr-py-variable")])
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["source"], "generated", "变式题的 source 必须是 generated")
        self.assertEqual(set(body), {"kpId", "questions", "source"})

    def test_rejects_choice_without_options(self) -> None:
        response = self.register(
            [_variant("v-2", "jr-py-variable", qtype="choice", options=["只有一个"])]
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("选项", response.json()["detail"])

    def test_rejects_empty_answer(self) -> None:
        response = self.register([_variant("v-3", "jr-py-variable", answer="   ")])
        self.assertEqual(response.status_code, 422)
        self.assertIn("标准答案", response.json()["detail"])

    def test_rejects_out_of_scope_term_for_grade(self) -> None:
        """★ 校验层复查学段（prompt 里写了学段不够，模型可能无视）。"""
        # 「神经网络」在小学低年级属超纲（terminology.json 的 min_grade）
        response = self.register(
            [
                _variant(
                    "v-4",
                    "pl-ai-around-me",
                    stem="请解释神经网络是怎么工作的",
                    answer="随便",
                )
            ],
            grade="primary_low",
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("超纲", response.json()["detail"])

    def test_all_rejected_never_returns_empty_payload(self) -> None:
        """全部不合格时**不返回空题**（空载荷会让前端渲染一张空卡片）。"""
        response = self.register([_variant("v-5", "jr-py-variable", answer="")])
        self.assertEqual(response.status_code, 422)
        self.assertIn("没有一道生成题通过校验", response.json()["detail"])

    def test_duplicate_qids_in_one_batch_are_rejected(self) -> None:
        response = self.register(
            [
                _variant("dup-1", "jr-py-variable"),
                _variant("dup-1", "jr-py-variable"),
            ]
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("重复", response.json()["detail"])

    def test_generated_question_is_persisted_in_the_student_database(self) -> None:
        """生成题落**该学生自己的库**（一人一库，不写进随包题库文件）。"""
        self.register([_variant("v-6", "jr-py-variable", answer="2")])
        rows = self.query(
            "SELECT qid, kp_id, reference_answer FROM generated_question WHERE qid = ?",
            ("v-6",),
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["kp_id"], "jr-py-variable")
        self.assertEqual(json.loads(rows[0]["reference_answer"]), "2")

    def test_students_do_not_see_each_others_generated_questions(self) -> None:
        """一人一库：另一个学生的生成题在本题学生这里查不到（判分 404）。"""
        self.register([_variant("shared-q", "jr-py-variable", answer="2")])
        other = "student_other_variants"
        response = self.client.post(
            "/api/quiz/grade",
            json={"studentId": other, "qid": "shared-q", "answer": "2"},
        )
        self.assertEqual(response.status_code, 404, "跨学生的生成题不该可见")

    def test_batch_size_is_capped(self) -> None:
        many = [_variant(f"cap-{i}", "jr-py-variable") for i in range(20)]
        response = self.register(many)
        self.assertEqual(response.status_code, 422, "超过上限（10 道）应被契约挡下")


# --------------------------------------------------------------------------- #
# 6. ★★ 关卡 D：端到端一次跑通
# --------------------------------------------------------------------------- #
@unittest.skipUnless(REAL_KB.exists(), f"缺少真实知识库 {REAL_KB}（先跑 scripts/build_kb.py）")
class TestGateD(LoopCase):
    """★ 关卡 D 的硬线：答题 → 判分 → mastery 写入 → 下一关解锁 → 进度前进 → 徽章更新。

    用真实依赖图里的 `jr-py-variable → jr-py-loop`（「变量」是「循环」的前置）——
    这正是执行文档 §8.6 与票 15/20 用的那条演示线。

    ★ 注意：`jr-py-variable` 在整条链的第 5 跳，冷启动时它是 `locked` 的。
      所以这里的做法是**先把链上的前置逐关打过去，再在目标关做关卡 D 的观测** ——
      这既是真实的闯关流程，也让「答对 A → 下一关是 A 的后继」这条被完整走一遍。
    """

    CURRENT = "jr-py-variable"
    NEXT = "jr-py-loop"

    def setUp(self) -> None:
        super().setUp()
        self.set_student("student_gate_d")
        self.exit_stack_ok = True

    def _unlock(self, kp_id: str) -> None:
        """把 `kp_id` 这一关**打通**（答对足够多道），从而解锁它的后继。

        用与 `test_full_chain` 相同的口径：4 道题 × 0.15 = 0.6 掌握度（过阈值）。
        """
        questions = [
            _variant(f"unlock-{kp_id}-{i}", kp_id, stem=f"练习 {i}", answer="2")
            for i in range(1, 5)
        ]
        response = self.register(questions, grade="junior")
        self.assertEqual(response.status_code, 200, response.text)
        for item in response.json()["questions"]:
            graded = self.grade(item["qid"], "2")
            self.assertTrue(graded.json()["correct"], graded.text)
        level = self.level(kp_id)
        self.assertEqual(level["stage"], "mastered", f"{kp_id} 应已通关：{level}")
        self.assertGreaterEqual(level["mastery"], MASTERY_UNLOCK_THRESHOLD)

    def _register_n(self, count: int, *, qid_prefix: str = "gate") -> list[str]:
        questions = [
            _variant(f"{qid_prefix}-{i}", self.CURRENT, stem=f"变量练习 {i}", answer="2")
            for i in range(1, count + 1)
        ]
        response = self.register(questions, grade="junior")
        self.assertEqual(response.status_code, 200, response.text)
        return [item["qid"] for item in response.json()["questions"]]

    def test_walking_the_chain_unlocks_the_next_level(self) -> None:
        """★「答对 A → 下一关是 A 的后继」：逐关打通，后继逐关被放出来。

        这条用例走的是**真实的闯关流程**（不是直接把某关标成 learning），
        因此它同时证明了：解锁确实由答题驱动、且沿依赖图方向发生。
        """
        # 冷启动：目标关还是锁着的
        self.assertEqual(
            self.level(self.CURRENT)["stage"], "locked", "链上的关卡一开始应是 locked"
        )
        self.assertEqual(self.level(self.NEXT)["stage"], "locked")

        # 按**拓扑序**逐关打通它前面的每一关
        order = self.progress().json()["levels"]
        ids = [item["kpId"] for item in order]
        for kp_id in ids[: ids.index(self.CURRENT)]:
            self._unlock(kp_id)

        # ★ 目标关被它的前置放出来了
        self.assertEqual(
            self.level(self.CURRENT)["stage"],
            "learning",
            "★ 前置通关后，目标关必须从 locked 解锁为 learning",
        )
        # 再打通目标关 → 它的后继（循环）被放出来
        self._unlock(self.CURRENT)
        self.assertEqual(
            self.level(self.NEXT)["stage"],
            "learning",
            "★ 答对「变量」→ 下一关是它的后继「循环」",
        )

    def test_full_chain_answer_grade_mastery_unlock_badge(self) -> None:
        """★ 完整链路（每一步都断言，失败时一眼看出断在哪）。

        先把目标关的前置逐关打通（真实的闯关流程），再观测关卡 D 的五步。
        """
        # ① 冷启动：新学生一开始就有可做的第一关（不空指针）
        cold = self.progress()
        self.assertEqual(cold.status_code, 200, cold.text)
        levels = cold.json()["levels"]
        self.assertGreater(len(levels), 0, "冷启动应初始化默认关卡路径")

        # 把目标关之前的所有关卡按拓扑序打通（这一步本身就是「爬关卡」）
        ids = [item["kpId"] for item in levels]
        for kp_id in ids[: ids.index(self.CURRENT)]:
            self._unlock(kp_id)
        self.assertEqual(
            self.level(self.CURRENT)["stage"], "learning", "目标关应已被前置解锁"
        )

        qids = self._register_n(4)

        # 第二次观测起点：答对一道 → `quizzed` + 徽章 + 掌握度 +0.15
        first = self.grade(qids[0], "2")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["correct"])
        self.assertAlmostEqual(first.json()["masteryDelta"], MASTERY_GAIN_CORRECT, places=6)

        level = self.level(self.CURRENT)
        self.assertIsNotNone(level)
        self.assertEqual(level["stage"], "quizzed", "答对一道即 quizzed")
        self.assertIsNotNone(level["badge"], "答对一道就该有徽章")
        self.assertAlmostEqual(level["mastery"], MASTERY_GAIN_CORRECT, places=6)
        # ★ 此时后继**仍然锁定**：掌握度 0.15 < 阈值 0.6（解锁条件缺一不可）
        self.assertEqual(
            self.level(self.NEXT)["stage"],
            "locked",
            "掌握度不足时后继不该解锁（这正是「两个条件缺一不可」的那一半）",
        )

        # ② 继续答对到掌握度过阈值 → 解锁后继
        for qid in qids[1:]:
            self.grade(qid, "2")
        level = self.level(self.CURRENT)
        self.assertAlmostEqual(level["mastery"], 0.6, places=6, msg="4×0.15 = 0.6")
        self.assertGreaterEqual(level["mastery"], MASTERY_UNLOCK_THRESHOLD)
        self.assertEqual(level["stage"], "mastered", "答对 ≥2 道且掌握度过阈值 → mastered")

        # ③ ★ 下一关解锁（progress 行变化：locked → learning）
        successor = self.level(self.NEXT)
        self.assertIsNotNone(successor, f"依赖图里 {self.CURRENT} 的后继 {self.NEXT} 应出现在进度里")
        self.assertEqual(
            successor["stage"], "learning", f"★ 关卡 D：{self.NEXT} 应已从 locked 解锁为 learning"
        )

        # ④ 进度条前进（后端算出的 done 数增加）
        body = self.progress().json()
        levels = body["levels"]
        done = len([x for x in levels if x["stage"] in ("quizzed", "mastered")])
        self.assertGreaterEqual(done, 1, "至少一关已通过")

        # ⑤ 徽章更新 + 掌握度真的写进 sqlite（证据留档）
        mastery_row = self.query(
            "SELECT score, attempts, correct FROM mastery WHERE kp_id = ?", (self.CURRENT,)
        )
        self.assertEqual(len(mastery_row), 1)
        self.assertAlmostEqual(mastery_row[0]["score"], 0.6, places=6)
        self.assertEqual(mastery_row[0]["attempts"], 4)

        progress_rows = {
            row["kp_id"]: row["stage"]
            for row in self.query("SELECT kp_id, stage FROM progress")
        }
        self.assertEqual(progress_rows.get(self.CURRENT), "mastered")
        self.assertEqual(progress_rows.get(self.NEXT), "learning")

        badge_rows = self.query("SELECT badge FROM progress WHERE kp_id = ?", (self.CURRENT,))
        self.assertIsNotNone(badge_rows[0]["badge"])

    def test_wrong_answers_keep_the_next_level_locked(self) -> None:
        """★ 答错时后继保持锁定（票 15 明确要求的断言）。

        在**已解锁的那一关**上连续答错：掌握度停在 0（限幅 + 下限 0）、stage 停在
        `learning`（答错不推进）、没有徽章，并且**它的后继始终是 locked**。
        """
        # 用冷启动放出来的第一关（它必定是 learning）
        level_now = next(
            item for item in self.progress().json()["levels"] if item["stage"] == "learning"
        )
        current_kp = level_now["kpId"]
        from app.knowledge.deps import successors
        from app.store.connections import connect

        conn = connect(self.tmp / "shared" / "kb.sqlite", readonly=True)
        try:
            direct = [row.kp_id for row in successors(conn, current_kp, max_depth=1)]
        finally:
            conn.close()
        self.assertTrue(direct, f"{current_kp} 应当有后继（否则这条用例没在测解锁）")

        self.register(
            [_variant("wrong-1", current_kp, stem="随便一道", answer="2")], grade="junior"
        )
        for _ in range(6):
            response = self.grade("wrong-1", "完全不沾边的答案")
            self.assertFalse(response.json()["correct"])

        level = self.level(current_kp)
        self.assertIn(level["stage"], ("learning", "locked"), "答错不该推进到 quizzed")
        self.assertAlmostEqual(level["mastery"], 0.0, places=6, msg="掌握度不该掉到 0 以下")
        self.assertIsNone(level["badge"], "全答错不该有徽章")

        for successor in direct:
            target = self.level(successor)
            if target is None:
                continue  # 不在默认路径里的后继（更高学段）不参与这条断言
            self.assertEqual(
                target["stage"], "locked", f"★ 答错时后继 {successor} 必须保持 locked"
            )

    def test_mastery_delta_is_clamped(self) -> None:
        """★ 限幅：单次答题 ``abs(mastery_delta) <= 0.2``（否则一次答对就 0→1）。"""
        # 用冷启动放出来的第一关（未解锁的关卡做不了题）
        current = next(
            item["kpId"]
            for item in self.progress().json()["levels"]
            if item["stage"] == "learning"
        )
        questions = [
            _variant(f"clamp-{i}", current, stem=f"题 {i}", answer="2") for i in range(1, 4)
        ]
        response = self.register(questions, grade="junior")
        qids = [item["qid"] for item in response.json()["questions"]]

        for qid in qids:
            graded = self.grade(qid, "2")
            self.assertLessEqual(abs(graded.json()["masteryDelta"]), MASTERY_DELTA_LIMIT)
        # 答对 3 次也只到 0.45（< 0.6），继续答对才可能过阈值
        self.assertAlmostEqual(self.level(current)["mastery"], 0.45, places=6)

    def test_repeated_correct_answers_converge_and_extra_delta_is_zero(self) -> None:
        """满分后再答对，回传的 delta 是 **0**（而不是一个没发生的 +0.15）。"""
        current = next(
            item["kpId"]
            for item in self.progress().json()["levels"]
            if item["stage"] == "learning"
        )
        questions = [
            _variant(f"full-{i}", current, stem=f"题 {i}", answer="2") for i in range(1, 9)
        ]
        response = self.register(questions, grade="junior")
        qids = [item["qid"] for item in response.json()["questions"]]
        for qid in qids:
            self.grade(qid, "2")
        self.assertAlmostEqual(self.level(current)["mastery"], 1.0, places=6)
        # 满分之后再答对：delta 必须是 0（进度条不该虚涨）
        extra = self.grade(qids[0], "2")
        self.assertEqual(extra.json()["masteryDelta"], 0.0)

    def test_level_order_follows_the_dependency_graph(self) -> None:
        """★ 关卡顺序来自**依赖图拓扑序**（不是按 id 字典序）。"""
        from app.store.connections import connect

        conn = connect(self.tmp / "shared" / "kb.sqlite", readonly=True)
        try:
            order = level_order_from_graph(conn, start_kp_ids=[self.CURRENT])
        finally:
            conn.close()
        self.assertIn(self.CURRENT, order)
        self.assertIn(self.NEXT, order, "后继必须出现在拓扑序里")
        self.assertLess(
            order.index(self.CURRENT),
            order.index(self.NEXT),
            "★ 前置必须排在后继之前（from 是前置、to 是后继）",
        )

    def test_progress_survives_reopening_the_database(self) -> None:
        """★ 重启延续：关掉库再打开，进度/徽章/掌握度一字不变（票 15 的重启验收）。"""
        qids = self._register_n(4, qid_prefix="persist")
        for qid in qids:
            self.grade(qid, "2")
        before = {
            row["kp_id"]: (row["stage"], row["badge"])
            for row in self.query("SELECT kp_id, stage, badge FROM progress")
        }
        mastery_before = self.query("SELECT kp_id, score FROM mastery ORDER BY kp_id")

        # 重新打开同一个库（等价于「关掉应用再打开」在数据层的那一步）
        store = LearningStore(
            self.tmp / "students" / self.student / "learning.db"
        )
        try:
            self.assertEqual(
                {row.kp_id: (row.stage, row.badge) for row in store.progress_rows()},
                before,
                "重开后进度变了",
            )
            self.assertEqual(
                {kp: score for kp, score in store.mastery_map().items()},
                {row["kp_id"]: row["score"] for row in mastery_before},
                "重开后掌握度变了",
            )
        finally:
            store.close()


# --------------------------------------------------------------------------- #
# 7. 冷启动
# --------------------------------------------------------------------------- #
class TestColdStart(LoopCase):
    def test_brand_new_student_gets_a_usable_first_level(self) -> None:
        """★ 全新学生：`progress` 表为空也能直接可用（自动初始化默认路径）。

        设计口径（票 15「闯关」+「关卡顺序由依赖图拓扑序决定」）：
        默认路径**按依赖图拓扑序全部初始化**，其中**恰好第一关可做**（`learning`），
        其余 `locked` —— 学生一关一关往前走。所以「可用」的判据是
        「至少有一关可开始」，而不是「所有关都解锁」。
        """
        self.set_student("student_brand_new_15")
        response = self.progress()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["studentId"], "student_brand_new_15")
        self.assertGreater(len(body["levels"]), 0, "冷启动必须给出可做的关卡")
        self.assertGreater(body["seeded"], 0, "应真的初始化了默认路径")

        runnable = [x for x in body["levels"] if x["stage"] in ("learning", "quizzed", "mastered")]
        self.assertEqual(
            len(runnable), 1, "冷启动应恰好放出一关（其余靠答对逐关解锁）"
        )
        locked = [x for x in body["levels"] if x["stage"] == "locked"]
        self.assertEqual(
            len(locked) + len(runnable),
            len(body["levels"]),
            "每关都必须是四个合法状态之一（没有状态不明的关卡）",
        )

    def test_cold_start_is_idempotent(self) -> None:
        """重复调用不再重复初始化（已存在的行一个字不动）。"""
        self.set_student("student_cold_repeat")
        first = self.progress().json()
        second = self.progress().json()
        self.assertEqual(second["seeded"], 0, "第二次不该再插行")
        self.assertEqual(
            [(x["kpId"], x["stage"]) for x in first["levels"]],
            [(x["kpId"], x["stage"]) for x in second["levels"]],
        )

    def test_cold_start_does_not_overwrite_existing_progress(self) -> None:
        """★ 冷启动**只插不覆盖**：学生真做过的关卡不能被默认路径重置。"""
        self.set_student("student_keep")
        self.register([_variant("keep-1", "jr-py-variable", answer="2")])
        self.grade("keep-1", "2")
        before = self.level("jr-py-variable")
        self.assertEqual(before["stage"], "quizzed")
        self.assertIsNotNone(before["badge"])

        # 再来一次冷启动（模拟另一次调用）
        self.progress()
        after = self.level("jr-py-variable")
        self.assertEqual(after["stage"], before["stage"])
        self.assertEqual(after["badge"], before["badge"], "徽章不该被重置")

    def test_progress_endpoint_rejects_bad_student_id(self) -> None:
        for bad in ("x" * 65, "a b", "学段001"):
            response = self.client.get(f"/api/quiz/progress/{bad}")
            self.assertNotEqual(response.status_code, 200, f"{bad!r} 不该被接受")


# --------------------------------------------------------------------------- #
# 8. 统一落库点（两条判分路径共用）
# --------------------------------------------------------------------------- #
class TestLearningHistory(LoopCase):
    def test_history_records_scored_by_and_stage(self) -> None:
        """`learning_history` 里能看出**哪条判分路径**、以及当时的关卡状态（票 20 要吃它）。"""
        self.set_student("student_history")
        self.register(
            [
                _variant("h-obj", "jr-py-variable", answer="2"),
                _variant("h-sub", "jr-py-variable", stem="开放题", answer="参考", rubric="要点"),
            ]
        )
        self.grade("h-obj", "2")
        self.grade_subjective("h-sub", 0.9)

        rows = self.query(
            "SELECT detail FROM learning_history WHERE activity = 'quiz' ORDER BY id"
        )
        self.assertEqual(len(rows), 2)
        first = json.loads(rows[0]["detail"])
        second = json.loads(rows[1]["detail"])
        self.assertEqual(first["scoredBy"], "rule")
        self.assertEqual(second["scoredBy"], "llm")
        for detail in (first, second):
            self.assertIn("stage", detail, "每次作答都要记下当时的关卡状态")
            self.assertIn("mastery", detail)

    def test_sqlite_never_stores_conversation_body(self) -> None:
        """★ 合规红线：`learning_history.question` 只放题干前 120 字，不含学生原话。"""
        self.set_student("student_body")
        self.register([_variant("body-1", "jr-py-variable", answer="2")])
        student_words = "学生原话不该进数据库这句话"
        self.client.post(
            "/api/quiz/grade",
            json={
                "studentId": self.student,
                "qid": "body-1",
                "answer": student_words,
                "sessionId": "s-secret",
            },
        )
        rows = self.query("SELECT question, detail FROM learning_history")
        self.assertEqual(len(rows), 1)
        blob = json.dumps([dict(row) for row in rows], ensure_ascii=False)
        self.assertNotIn(student_words, blob, "★ 学生作答被写进了 SQLite（合规问题）")

    def test_practice_route_streams_into_the_two_round_trip(self) -> None:
        """★「上一轮的变化改变下一轮的输入」：掌握度真的变了，两次读到的进度不同。

        用**当前已解锁的那一关**（冷启动放出来的第一关，按依赖图拓扑序）——
        这正是学生实际会练的那一关，避免用例依赖某条固定的知识点 id。
        """
        self.set_student("student_loop")
        body = self.progress().json()
        runnable = [
            x for x in body["levels"] if x["stage"] in ("learning", "quizzed", "mastered")
        ]
        self.assertGreaterEqual(len(runnable), 1, "冷启动后至少有一关可做")
        current = runnable[0]["kpId"]
        before = self.level(current)["mastery"]

        self.register([_variant("loop-1", current, answer="2")], grade=body["gradeLevel"])
        self.grade("loop-1", "2")
        after = self.level(current)["mastery"]
        self.assertGreater(after, before, "第二轮读到的掌握度必须反映上一轮的作答")

    def test_deep_chain_level_is_present_in_the_default_path(self) -> None:
        """★ 关卡路径必须覆盖**整条链**（不能被递归深度截断）。

        `jr-py-variable` 在依赖图里离入口 4 跳
        （pl-ai-around-me → ph-data-train-predict → ph-image-classification
        → jr-data-features → **jr-py-variable**）。早期实现沿用
        `deps.DEFAULT_DEPTH=3`，结果它**根本没进关卡列表** ——
        表现为「依赖图明明有这条线，学生的进度里却没有这一关」。
        """
        self.set_student("student_deep")
        body = self.progress().json()
        ids = {item["kpId"] for item in body["levels"]}
        for expected in ("jr-py-variable", "jr-py-loop"):
            self.assertIn(expected, ids, f"★ 深链上的 {expected} 必须出现在默认关卡路径里")
        # 拓扑序：前置必须排在后继之前
        ordered = [item["kpId"] for item in body["levels"]]
        self.assertEqual(
            sorted(ids), sorted(ordered), "关卡列表应稳定有序（同一份图两次调用顺序一致）"
        )
        self.assertLess(
            ordered.index("jr-py-variable"),
            ordered.index("jr-py-loop"),
            "★ 前置（变量）必须排在后继（循环）之前",
        )


if __name__ == "__main__":
    unittest.main()
