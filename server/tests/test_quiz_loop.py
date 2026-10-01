# -*- coding: utf-8 -*-
"""票 15：主观题批改 + 变式生成 + **闯关闭环（关卡 D）**。

这一组断言盯住六条「错了就静默出事」的红线，每一条都对应一个陷阱：

1. ★★ **答案不泄漏**（§6.3）：用一个**唯一哨兵串**当标准答案/评分细则，走完
   `/api/quiz/variants` 与 `/api/quiz/grade` 全链路，哨兵在响应 JSON 里必须**零命中**
   （含嵌套键名 —— 逐层递归查 `answer` / `rubric` 这类键）；
2. ★ **掌握度限幅 ±0.2**：单次答题不可能把 mastery 从 0 顶到 1（连续答对 4 次才到 0.6）；
3. ★ **闯关状态机**：`learning → quizzed → mastered` 的转移条件逐条断言，
   且**答错不回退**；
4. ★★ **没有任何关卡锁定**（2026-09-25 起）：`advance_stage` 永不返回 `"locked"`，
   任意关卡都能**直接作答**（不要求先通过前一关），冷启动时所有关卡都可作答；
   这三个状态只是**进度反馈**，不是准入限制；
5. **混合批改**：客观题走 `rule`、带评分细则的主观题走 `llm`；
   两条路径**互相走不通**（客观题走主观端点 409、主观题走规则端点 409）；
6. **冷启动**：全新学生 id 直接问进度 / 推荐 → 自动初始化默认路径（每关都可做），
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

from app.config import KNOWLEDGE_DIR, build_runtime_config  # noqa: E402
from app.contracts import MASTERY_DELTA_LIMIT, QuizQuestion, QuizQuestionOut  # noqa: E402
from app.knowledge.library import GRADE_LEVELS, compatible_grades, load_library  # noqa: E402
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
    progress_snapshot,
    subjective_feedback,
)
from app.store.learning import GeneratedQuestionRecord, LearningStore  # noqa: E402

#: ★ 哨兵：只可能来自题目的标准答案 / 评分细则。它一旦出现在响应 JSON 里就是答案泄漏。
SENTINEL_ANSWER = "哨兵标准答案-ZX91-不得出现在任何响应里"
SENTINEL_RUBRIC = "哨兵评分细则-ZX92-不得出现在任何响应里"

#: 真实知识库（含依赖图）。缺失时依赖图的用例跳过。
REAL_KB = Path(ROOT) / "_data" / "shared" / "kb.sqlite"

#: 生成题 qid 的标准前缀（与 `extensions/quiz.ts` 的 `variantQid()` 同源；
#: 服务端的 `GENERATED_QID_PREFIX` 会**硬校验**它 —— 不带前缀的 qid 可能与题库真题同名，
#: 而判分先查生成题，于是能把那道真题的标准答案静默改写）。
#: 夹具里仍写短名（`_variant("v-1", ...)`），由 :func:`_variant` 与
#: :meth:`LoopCase.grade` / :meth:`LoopCase.grade_subjective` 统一补前缀 ——
#: 用例读起来是短名，**发出去的请求是真实形状**。
GEN_QID_PREFIX = "gen-"


def _gq(qid: str) -> str:
    """用例里的短名 → 真实 qid（幂等：已经是 ``gen-`` 开头的原样返回）。"""
    return qid if qid.startswith(GEN_QID_PREFIX) else f"{GEN_QID_PREFIX}{qid}"


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
        "qid": _gq(qid),
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
    """带临时 userData 的基类；**真的**把 kb 拷进去，让关卡路径/排序有图可查。"""

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
                "qid": _gq(qid),
                "answer": answer,
                "sessionId": "sess-test",
            },
        )

    def grade_subjective(self, qid: str, score: float, feedback: str = "说得挺清楚") -> object:
        return self.client.post(
            "/api/quiz/grade-subjective",
            json={
                "studentId": self.student,
                "qid": _gq(qid),
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

    def set_grade(self, grade_level: str) -> str:
        """在测试夹具里**直接**把学生行的学段设成指定值（走真实的学生行，不是请求参数）。

        ★ 学段必须落在 ``learning.db`` 的学生行上：关卡路径只认服务端的学生记录
        （客户端自述不算数 —— 请求里根本没有学段字段，D-020）。

        ⚠️ 这里绕过 ``app/grade/rules.py`` 的规则引擎只是**测试取巧**（步骤更快、确定性更好）。
        真实运行下学段的唯一写路径是 ``POST /api/grade/turns`` 的自动推断
        （自动生效、**没有人工选择入口**，学生端只有只读指示器）。
        """
        from app.routes.quiz import student_db_path  # noqa: PLC0415

        store = LearningStore(student_db_path(self.tmp, self.student))
        try:
            store.upsert_student(self.student, nickname="", grade_level=grade_level)
        finally:
            store.close()
        return grade_level

    def walk_path(self, *, grade_level: str) -> list[dict]:
        """★ 真实走一遍该学段的关卡路径：逐关取题（HTTP），返回逐关结果。

        返回每项 ``{kpId, gradeLevel, status}``（``status`` 是 ``/api/quiz/bank`` 的
        HTTP 状态码）。**真的发请求**，不是从依赖图里结构推导 —— 死胡同的表现就是
        「进度条上有这一关、取题却 404」，只有走一遍才抓得住。
        """
        body = self.progress().json()
        rows: list[dict] = []
        for item in body["levels"]:
            response = self.client.get(
                f"/api/quiz/bank/{item['kpId']}", params={"gradeLevel": grade_level}
            )
            rows.append(
                {"kpId": item["kpId"], "gradeLevel": grade_level, "status": response.status_code}
            )
        return rows

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

    def test_explanation_is_withheld_from_the_question_payload_but_kept_in_feedback(
        self,
    ) -> None:
        """★★ 解析（``explanation``）**取题时不下发、判分后照常给**（H-6 的两半）。

        为什么两半都要断言：修法很容易走成「干脆不要解析了」——
        那会把解析的教学价值一起丢掉（学生答完正是最该看「为什么」的时刻）。
        正确形态是**时间差**：答之前看不到（否则等于送答案，43% 的解析里直接写着答案），
        答之后在 ``QuizResult.feedback`` 里看到。

        ★ 用一道**解析里直接写着答案**的题做夹具（这正是那 43% 的形态）：
        「取题载荷不含解析」与「反馈含解析」在同一个 qid 上同时成立，
        才说明隔离是**按时机**做的，不是把这个字段禁掉了。
        """
        explanation = "答案是 2 —— 1 加 1 等于 2。"
        self.register(
            [{"qid": "gen-exp-1", "kpId": "prog-variable-jr", "type": "blank",
              "stem": "1 + 1 = ___", "referenceAnswer": "2", "explanation": explanation}]
        )

        # ① 取题载荷：连 `explanation` 这个键都没有（不是空串，是根本没带）
        payload = self.register(
            [{"qid": "gen-exp-2", "kpId": "prog-variable-jr", "type": "blank",
              "stem": "2 + 2 = ___", "referenceAnswer": "4", "explanation": explanation}]
        ).json()
        for question in payload["questions"]:
            self.assertNotIn("explanation", question, "★ 取题载荷不该带解析")
            self.assertNotIn(explanation, json.dumps(question, ensure_ascii=False))

        # ② 判分反馈：解析**在**里面（学生答完就该看到它）
        graded = self.grade("exp-1", "2").json()
        self.assertTrue(graded["correct"])
        self.assertIn(explanation, graded["feedback"], "★ 判分反馈必须保留解析（教学价值）")

    def test_sentinel_absent_from_variant_registration_response(self) -> None:
        """登记变式题：**入参带答案**，出参里哨兵必须零命中。"""
        response = self.register(
            [
                _variant("leak-q1", "prog-variable-jr", answer=SENTINEL_ANSWER),
                _variant(
                    "leak-q2",
                    "prog-variable-jr",
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
        # 每道题就是对外形态的那 5 个字段（`explanation` 与答案、细则一样不下发）
        for question in payload["questions"]:
            self.assertEqual(
                set(question),
                {"qid", "kpId", "type", "stem", "options"},
                f"对外题目字段不对：{question}",
            )

    def test_sentinel_absent_from_grading_response(self) -> None:
        """判分回执里也不许回显标准答案（回显 = 送答案）。"""
        self.register([_variant("leak-q3", "prog-variable-jr", answer=SENTINEL_ANSWER)])
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
            [_variant("leak-q4", "prog-variable-jr", answer=SENTINEL_ANSWER, rubric=SENTINEL_RUBRIC)]
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
            "/api/quiz/bank/prog-variable-jr", params={"gradeLevel": "junior"}
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
# 3. ★★ 没有关卡锁定（纯函数）
# --------------------------------------------------------------------------- #
class TestNoLevelLocking(unittest.TestCase):
    """★★ 状态机**永不产出** ``locked``：所有关卡一开始就可作答（2026-09-25 起）。

    这一组替掉了原来的 ``TestUnlockRule`` —— 解锁机制整个删掉了（见 ``quiz.py`` 模块头），
    所以「什么条件下解锁后继」不再是本仓库的行为，取而代之的是
    「任何输入都不会把一关锁上」，以及「不需要任何前置就能作答」。
    """

    def test_advance_stage_never_returns_locked(self) -> None:
        """★ 穷举一批输入（含当前就是 ``locked`` 的旧库行、含全错）都不得返回 ``locked``。"""
        for stage in (None, "locked", "learning", "quizzed", "mastered"):
            for correct_count in (0, 1, 2, 5):
                for mastery in (0.0, 0.3, MASTERY_UNLOCK_THRESHOLD, 1.0):
                    result = advance_stage(
                        current_stage=stage,
                        mastery_score=mastery,
                        correct_count=correct_count,
                    )
                    self.assertNotEqual(
                        result,
                        "locked",
                        f"★ stage={stage} count={correct_count} mastery={mastery} 时状态机产出了 locked",
                    )
                    self.assertIn(result, ("learning", "quizzed", "mastered"))

    def test_legacy_locked_row_is_promoted_on_first_answer(self) -> None:
        """★ 旧库里遗留的 ``locked`` 行：第一次作答（哪怕答错）就升到 ``learning``。"""
        self.assertEqual(
            advance_stage(current_stage="locked", mastery_score=0.0, correct_count=0),
            "learning",
        )

    def test_answerability_does_not_depend_on_any_prerequisite(self) -> None:
        """★ 一关能不能做，与「前置有没有通过」无关 —— 状态机只看**这一关自己**。

        给一个「这一关从来没有进度、掌握度也是 0」的场景（等价于「前置一关都没做过」），
        答对一道就应到 ``quizzed``，而不是停在某个被锁的状态。
        """
        self.assertEqual(
            advance_stage(
                current_stage=None,
                mastery_score=MASTERY_GAIN_CORRECT,
                correct_count=QUIZZED_CORRECT_NEEDED,
            ),
            "quizzed",
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
                    "sub-q1", "prog-variable-jr",
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
        """★「多少分算过」由服务端定：送进来的只有 score，没有对错。

        ★ 阈值两侧各用**一道不同的题**（而不是同一道题判两次）：判分口径是
          **首次作答决定**（H-3），同一 qid 的第二次提交不再改掌握度 ——
          拿同一道题判两次，`masteryDelta > 0` 那半句就永远测不到。
        """
        self.register(
            [
                _variant("sub-q2a", "prog-variable-jr", stem="开放题一", answer="参考", rubric="要点"),
                _variant("sub-q2b", "prog-variable-jr", stem="开放题二", answer="参考", rubric="要点"),
            ]
        )
        low = self.grade_subjective("sub-q2a", SUBJECTIVE_PASS_RATIO - 0.01)
        self.assertFalse(low.json()["correct"], "低于阈值应判错（即便模型说「还不错」）")
        # 掌握度本来就在 0，扣分被下限夹到 0 → delta 是 0（而不是一个没发生的 -0.1）
        self.assertEqual(low.json()["masteryDelta"], 0.0)

        high = self.grade_subjective("sub-q2b", SUBJECTIVE_PASS_RATIO)
        self.assertTrue(high.json()["correct"], "到阈值即判对")
        self.assertGreater(high.json()["masteryDelta"], 0)

    def test_objective_question_cannot_use_the_subjective_path(self) -> None:
        """★ 客观题走主观端点 = 试图绕开规则判分 → 409。"""
        self.register([_variant("obj-1", "prog-variable-jr", answer="2")])
        response = self.grade_subjective("obj-1", 1.0)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("客观题", response.json()["detail"])

    def test_subjective_question_cannot_use_the_rule_path(self) -> None:
        """★ 主观题走规则端点 = 会把好答案判错 → 409。"""
        self.register(
            [_variant("sub-q3", "prog-variable-jr", stem="开放", answer="参考", rubric="要点")]
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
            [_variant("sub-q4", "prog-variable-jr", stem="开放", answer="参考", rubric="要点")]
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
        response = self.register([_variant("v-1", "prog-variable-jr")])
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["source"], "generated", "变式题的 source 必须是 generated")
        self.assertEqual(set(body), {"kpId", "questions", "source"})

    def test_rejects_choice_without_options(self) -> None:
        response = self.register(
            [_variant("v-2", "prog-variable-jr", qtype="choice", options=["只有一个"])]
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("选项", response.json()["detail"])

    def test_rejects_empty_answer(self) -> None:
        response = self.register([_variant("v-3", "prog-variable-jr", answer="   ")])
        self.assertEqual(response.status_code, 422)
        self.assertIn("标准答案", response.json()["detail"])

    def test_rejects_out_of_scope_term_for_grade(self) -> None:
        """★ 校验层复查学段（prompt 里写了学段不够，模型可能无视）。"""
        # 「决策树」在小学低年级属超纲（terminology.json 里 min_grade=junior）
        response = self.register(
            [
                _variant(
                    "v-4",
                    "ai-definition-pl",
                    stem="请解释决策树是怎么工作的",
                    answer="随便",
                )
            ],
            grade="primary_low",
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("超纲", response.json()["detail"])

    def test_all_rejected_never_returns_empty_payload(self) -> None:
        """全部不合格时**不返回空题**（空载荷会让前端渲染一张空卡片）。"""
        response = self.register([_variant("v-5", "prog-variable-jr", answer="")])
        self.assertEqual(response.status_code, 422)
        self.assertIn("没有一道生成题通过校验", response.json()["detail"])

    def test_duplicate_qids_in_one_batch_are_rejected(self) -> None:
        response = self.register(
            [
                _variant("dup-1", "prog-variable-jr"),
                _variant("dup-1", "prog-variable-jr"),
            ]
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("重复", response.json()["detail"])

    # ---------------------------------------------------------------- H-4 --
    def test_rejects_qid_without_the_generated_prefix(self) -> None:
        """★ 生成题的 qid 必须带 `gen-` 前缀（生成侧漏了 `variantQid()` 的第一道拦网）。

        不带前缀的 qid 形如 ``<slug>-q<序号>``，与题库真题**同一个命名空间** ——
        而判分先查生成题，所以撞名就等于把真题的标准答案改写掉。
        """
        response = self.register(
            [{"qid": "prog-loop-jr-q1", "kpId": "prog-loop-jr", "type": "blank",
              "stem": "伪装成真题", "referenceAnswer": "随便"}]
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("gen-", response.json()["detail"], "拒绝理由必须说明前缀要求")

    def test_bank_question_qid_cannot_be_hijacked(self) -> None:
        """★★ 拿**题库真题的 qid** 登记生成题 → 整批拒，且那道真题的答案一个字不变。

        缺陷形态（修之前实测）：``register_variants`` 只在**同一批之内**查重，
        落库是 ``ON CONFLICT(qid) DO UPDATE`` —— 于是用一个真题 qid 登记生成题，
        就能把那道真题的**标准答案静默改写**。而 ``_locate_question`` 的次序是
        「先生成题、后题库」，学生此后做的是真题、判分用的是模型的答案。

        断言分两半：**拒绝**（HTTP 422 + 可读理由），以及**真题仍然按原答案判分**
        （只断言前一半的话，一个「拒了但已经写进去」的实现也能通过 —— 那种实现
        的后果和没修一样）。
        """
        bank_qid = "prog-loop-jr-q1"
        bank_correct = "循环变量"  # 真题的标准答案（ch08.json）
        victim = "student_hijack"

        # 先确认夹具前提：这道真题按原答案判对、按别的答案判错
        clean = self.client.post(
            "/api/quiz/grade",
            json={"studentId": victim, "qid": bank_qid, "answer": bank_correct},
        )
        self.assertEqual(clean.status_code, 200, clean.text)
        self.assertTrue(clean.json()["correct"], "前提：这道真题的标准答案就是它")

        # 拿同一个 qid 登记一道「答案是别的」的生成题
        response = self.client.post(
            f"/api/quiz/variants?student_id={victim}",
            json={
                "gradeLevel": "junior",
                "questions": [
                    {"qid": bank_qid, "kpId": "prog-loop-jr", "type": "blank",
                     "stem": "我是来抢名字的", "referenceAnswer": "被改写的答案"}
                ],
            },
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("撞名", response.json()["detail"])
        self.assertIn(bank_qid, response.json()["detail"], "要说清是哪个 qid 撞了")

        # ★ 后半：真题没被改写 —— 原来的错误答案仍然是错的、原答案仍然对
        still_wrong = self.client.post(
            "/api/quiz/grade",
            json={"studentId": victim, "qid": bank_qid, "answer": "被改写的答案"},
        )
        self.assertFalse(still_wrong.json()["correct"], "★ 抢名没有成功（答案没被改写）")

    def test_whole_batch_is_rejected_when_any_qid_collides_with_the_bank(self) -> None:
        """一道撞名 → **整批拒**（与「同批重复」同一处置：收下其余只会把问题藏起来）。

        ⚠️ 撞名的那一道不能借 :func:`_variant` 构造 —— 它会补 `gen-` 前缀，
        那样就不叫撞名了。这里直接写原始请求体（**真实攻击形状**）。
        """
        response = self.register(
            [
                _variant("ok-1", "prog-loop-jr"),
                {"qid": "prog-loop-jr-q2", "kpId": "prog-loop-jr", "type": "blank",
                 "stem": "与真题同名", "referenceAnswer": "随便"},
            ]
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("撞名", response.json()["detail"])

        # 整批拒 = **一道都没进库**（否则「拒了但写了一半」会让同一批出现两种状态）。
        # 判据走 HTTP：那一批里合格的那道题也应当查不到（判分 404）。
        # ⚠️ 不能用 `self.query(...)` 直接读表：整批拒发生在**打开学生库之前**，
        #    这个用例从没写过库，`learning.db` 根本不存在。
        probe = self.grade("ok-1", "2")
        self.assertEqual(probe.status_code, 404, "整批拒的批次里不该有任何一道落库")

    def test_generated_question_is_persisted_in_the_student_database(self) -> None:
        """生成题落**该学生自己的库**（一人一库，不写进随包题库文件）。"""
        self.register([_variant("v-6", "prog-variable-jr", answer="2")])
        rows = self.query(
            "SELECT qid, kp_id, reference_answer FROM generated_question WHERE qid = ?",
            (_gq("v-6"),),
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["kp_id"], "prog-variable-jr")
        self.assertEqual(json.loads(rows[0]["reference_answer"]), "2")

    def test_students_do_not_see_each_others_generated_questions(self) -> None:
        """一人一库：另一个学生的生成题在本题学生这里查不到（判分 404）。"""
        self.register([_variant("shared-q", "prog-variable-jr", answer="2")])
        other = "student_other_variants"
        response = self.client.post(
            "/api/quiz/grade",
            json={"studentId": other, "qid": _gq("shared-q"), "answer": "2"},
        )
        self.assertEqual(response.status_code, 404, "跨学生的生成题不该可见")

    def test_batch_size_is_capped(self) -> None:
        many = [_variant(f"cap-{i}", "prog-variable-jr") for i in range(20)]
        response = self.register(many)
        self.assertEqual(response.status_code, 422, "超过上限（10 道）应被契约挡下")


# --------------------------------------------------------------------------- #
# 6. ★★ 关卡 D：端到端一次跑通
# --------------------------------------------------------------------------- #
@unittest.skipUnless(REAL_KB.exists(), f"缺少真实知识库 {REAL_KB}（先跑 scripts/build_kb.py）")
class TestGateD(LoopCase):
    """★ 关卡 D 的硬线：答题 → 判分 → mastery 写入 → 进度前进 → 徽章更新。

    用真实依赖图里的一个初中知识点：`ai-hierarchy-jr`（「AI 技术的包含层级关系」），
    它的后继是 `deep-learning-jr`（「深度学习」，同为初中）。

    ★ 为什么不再用跨学段的那一对（``ai-definition-ph → ai-definition-jr``）：
      关卡路径**只看学生自己的学段**（见 ``_default_level_order`` 的说明 ——
      新库把概念串成 ``pl→ph→jr→sr`` 的跨学段链，若路径按兼容范围取，
      初中生 40 关里只有 4 关是自己的课，高中生更是 0 关）。
      所以 `ai-definition-ph` 已不在 junior 的路径里，拿它当夹具会「关卡不存在」。

    ★★ **不再有「先解锁再作答」**（2026-09-25 起）：`ai-hierarchy-jr` 冷启动就是
      ``learning``（可直接作答），不需要先把排在它前面的关卡逐关打过去；
      它的后继也一样一直可作答 —— 「解锁」这件事整个没有了。
    """

    CURRENT = "ai-hierarchy-jr"
    NEXT = "deep-learning-jr"
    #: 本类学生显式学段：让 ``CURRENT`` / ``NEXT`` 落在关卡路径里（见类文档）。
    GRADE = "junior"

    def setUp(self) -> None:
        super().setUp()
        self.set_student("student_gate_d")
        # ★ 先设学段再冷启动：关卡路径只认服务端学生行上的学段。
        self.set_grade(self.GRADE)
        self.exit_stack_ok = True

    def _register_n(self, count: int, *, qid_prefix: str = "gate") -> list[str]:
        questions = [
            _variant(f"{qid_prefix}-{i}", self.CURRENT, stem=f"定义练习 {i}", answer="2")
            for i in range(1, count + 1)
        ]
        response = self.register(questions, grade=self.GRADE)
        self.assertEqual(response.status_code, 200, response.text)
        return [item["qid"] for item in response.json()["questions"]]

    def test_any_level_can_be_answered_without_unlocking(self) -> None:
        """★★ **任意关卡都能直接作答**：目标关冷启动就是 ``learning``，无需先过前一关。

        旧行为是「链上的关卡一开始是 locked，要逐关打过去才放出来」；
        现在不再有锁定，所以这里不碰任何前置关卡，直接对目标关登记题目并判分。
        """
        # 冷启动：目标关与它的后继都直接可作答（进度里没有任何一关是 locked）
        self.assertEqual(self.level(self.CURRENT)["stage"], "learning")
        self.assertEqual(self.level(self.NEXT)["stage"], "learning")
        self.assertNotIn(
            "locked",
            {item["stage"] for item in self.progress().json()["levels"]},
            "★ 进度里不该出现 locked",
        )

        # 不碰任何前置关卡，直接做目标关的题 → 这一关自己的进度前进
        qids = self._register_n(2)
        for qid in qids:
            graded = self.grade(qid, "2")
            self.assertEqual(graded.status_code, 200, graded.text)
            self.assertTrue(graded.json()["correct"], graded.text)
        self.assertEqual(
            self.level(self.CURRENT)["stage"],
            "quizzed",
            "★ 直接作答就该推进这一关（答对 2 道且掌握度 0.3 < 阈值 → quizzed）",
        )

    def test_full_chain_answer_grade_mastery_badge(self) -> None:
        """★ 完整链路（每一步都断言，失败时一眼看出断在哪）。

        不再有「逐关解锁前置」那一段：目标关直接可做。
        """
        # ① 冷启动：新学生一开始所有关卡都可作答（不空指针、无锁定）
        cold = self.progress()
        self.assertEqual(cold.status_code, 200, cold.text)
        levels = cold.json()["levels"]
        self.assertGreater(len(levels), 0, "冷启动应初始化默认关卡路径")
        self.assertNotIn(
            "locked", {item["stage"] for item in levels}, "★ 冷启动不该有任何 locked 关卡"
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
        # ★ 只推进**当前这一关**：后继有自己的进度口径，不会因为本关通关而被改动
        self.assertEqual(
            self.level(self.NEXT)["stage"],
            "learning",
            "★ 后继一直是可作答的 learning（不存在「被解锁」这个状态跳变）",
        )

        # ② 继续答对到掌握度过阈值 → mastered
        for qid in qids[1:]:
            self.grade(qid, "2")
        level = self.level(self.CURRENT)
        self.assertAlmostEqual(level["mastery"], 0.6, places=6, msg="4×0.15 = 0.6")
        self.assertGreaterEqual(level["mastery"], MASTERY_UNLOCK_THRESHOLD)
        self.assertEqual(level["stage"], "mastered", "答对 ≥2 道且掌握度过阈值 → mastered")

        # ③ 进度条前进（后端算出的 done 数增加）
        body = self.progress().json()
        levels = body["levels"]
        done = len([x for x in levels if x["stage"] in ("quizzed", "mastered")])
        self.assertGreaterEqual(done, 1, "至少一关已通过")

        # ④ 徽章更新 + 掌握度真的写进 sqlite（证据留档）
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
        self.assertNotIn(
            "locked", set(progress_rows.values()), "★ 库里的 progress 不该有任何 locked"
        )

        badge_rows = self.query("SELECT badge FROM progress WHERE kp_id = ?", (self.CURRENT,))
        self.assertIsNotNone(badge_rows[0]["badge"])

    def test_wrong_answers_do_not_advance_stage(self) -> None:
        """★ 答错不推进状态、不给徽章、掌握度不掉到 0 以下（进度单调的另一半）。

        不再断言「后继保持 locked」—— 已经不存在 locked（见 :class:`TestNoLevelLocking`）。
        """
        # 挑一关直接作答（不再需要先解锁任何前置）
        current_kp = self.CURRENT
        from app.knowledge.deps import successors
        from app.store.connections import connect

        conn = connect(self.tmp / "shared" / "kb.sqlite", readonly=True)
        try:
            direct = [row.kp_id for row in successors(conn, current_kp, max_depth=1)]
        finally:
            conn.close()
        self.assertTrue(direct, f"{current_kp} 应当有后继（夹具前提：这条链真的存在）")

        self.register(
            [_variant("wrong-1", current_kp, stem="随便一道", answer="2")], grade="junior"
        )
        for _ in range(6):
            response = self.grade("wrong-1", "完全不沾边的答案")
            self.assertFalse(response.json()["correct"])

        level = self.level(current_kp)
        self.assertEqual(level["stage"], "learning", "答错不该推进到 quizzed")
        self.assertAlmostEqual(level["mastery"], 0.0, places=6, msg="掌握度不该掉到 0 以下")
        self.assertIsNone(level["badge"], "全答错不该有徽章")

        # ★ 答错也不影响后继的**可作答性**：它本来就是 learning，答错后仍是 learning
        for successor in direct:
            target = self.level(successor)
            if target is None:
                continue  # 不在默认路径里的后继（更高学段）不参与这条断言
            self.assertEqual(
                target["stage"], "learning", f"后继 {successor} 一直可作答"
            )

    def test_mastery_delta_is_clamped(self) -> None:
        """★ 限幅：单次答题 ``abs(mastery_delta) <= 0.2``（否则一次答对就 0→1）。"""
        # 任取一关（冷启动后所有关卡都可作答）
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
# 6.5 ★★ 关卡路径必须被学段隔离约束住（死胡同回归）
# --------------------------------------------------------------------------- #
@unittest.skipUnless(REAL_KB.exists(), f"缺少真实知识库 {REAL_KB}（先跑 scripts/build_kb.py）")
class TestPathIsScopedToTheStudentsGrade(LoopCase):
    """★★ 「路径里的每一关都取得到题」—— 这是本次修复的**唯一目的**。

    缺陷形态（修之前实测）：:func:`_default_level_order` 走**全图**（旧库 33 关，
    新库 228 个知识点），而 :func:`select_questions` 按学段隔离 —— 冷启动的 ``primary_high``
    学生拿到含初中/高中的关卡，取题全部 **404**。普通游玩就能走到：
    小学高年级练 ``ai-definition-ph`` → 它的初中后继 ``ai-definition-jr`` 出现在路径里
    → 该关在前端是可点的，取题却 404，闭环在**计分功能**里断掉。

    新库（K12KnowledgeBase）里每个概念都有 pl→ph→jr→sr 四个学段，跨学段的边（``related``
    连接同一概念的不同学段）比旧库更多，所以这条守卫只会更要紧。本类对**四个学段各走一遍
    完整路径**（真发 HTTP 逐关取题），断言：

    1. ★ 每一关都取得到题（``404 count = 0``）—— 真走一遍，不做结构推导；
    2. ★ 路径里**不得出现高于该学生学段**的关卡（初中生看不到高中内容）；
    3. ★ 学段隔离**没有被削弱**：该学生路径之外的更高学段 kp，
       直接请求仍然 **404**（证明修的是「路径范围」而不是「取题的隔离」）；
    4. 前置必须排在后继之前（路径仍是拓扑序）。
    """

    def _kp_grades(self) -> dict[str, str]:
        """知识点 → 学段（读教材，**不猜**）。"""
        return {doc.kp_id: doc.grade_level for doc in load_library(KNOWLEDGE_DIR)}

    def _successors(self, kp_id: str) -> list[str]:
        """依赖图里的直接后继（用真 kb，与关卡排序同一个数据来源）。"""
        from app.knowledge.deps import successors  # noqa: PLC0415
        from app.store.connections import connect  # noqa: PLC0415

        conn = connect(self.tmp / "shared" / "kb.sqlite", readonly=True)
        try:
            return [row.kp_id for row in successors(conn, kp_id, max_depth=1)]
        finally:
            conn.close()

    def _walk(self, grade_level: str) -> tuple[list[str], list[dict]]:
        """把学生设成 ``grade_level``、冷启动，再逐关取题。返回 ``(路径, 逐关结果)``。"""
        self.set_student(f"student_scope_{grade_level}")
        self.set_grade(grade_level)
        body = self.progress().json()
        self.assertEqual(body["gradeLevel"], grade_level, "学生学段应来自服务端记录")
        path = [item["kpId"] for item in body["levels"]]
        self.assertTrue(path, f"{grade_level} 的关卡路径不该为空（冷启动必须能开始）")
        rows = self.walk_path(grade_level=grade_level)
        self.assertEqual(
            [row["kpId"] for row in rows], path, "逐关取题的顺序应与进度路径一一对应"
        )
        return path, rows

    def test_every_level_in_each_grades_path_is_fetchable(self) -> None:
        """★★ 四个学段各走一遍完整路径：**每一关都要取得到题**（0 × 404）。"""
        grades = self._kp_grades()
        sizes: dict[str, int] = {}
        for grade_level in GRADE_LEVELS:
            with self.subTest(grade=grade_level):
                path, rows = self._walk(grade_level)
                sizes[grade_level] = len(path)

                missing = [row["kpId"] for row in rows if row["status"] == 404]
                detail = "\n".join(
                    f"  - {row['kpId']}（{grades.get(row['kpId'], '?')}）→ HTTP {row['status']}"
                    for row in rows
                    if row["status"] != 200
                )
                self.assertEqual(
                    missing,
                    [],
                    f"★ {grade_level} 的关卡路径里有 {len(missing)} 关取不到题"
                    f"（死胡同！）：\n{detail}",
                )

        # 路径规模随学段单调不减（兼容范围是「本学段 + 更低学段」的累积）
        ordered = [sizes[grade] for grade in GRADE_LEVELS]
        self.assertEqual(ordered, sorted(ordered), f"各学段路径规模应单调不减：{sizes}")

    def test_no_level_in_the_path_is_above_the_students_grade(self) -> None:
        """★ 路径里不得出现高于该学生学段的关卡（学段隔离的第一半）。"""
        grades = self._kp_grades()
        for grade_level in GRADE_LEVELS:
            with self.subTest(grade=grade_level):
                allowed = set(compatible_grades(grade_level))
                path, _ = self._walk(grade_level)
                offenders = [kp for kp in path if grades.get(kp) not in allowed]
                self.assertEqual(
                    offenders,
                    [],
                    f"★ {grade_level} 的路径里出现了兼容范围（{sorted(allowed)}）外的关卡："
                    f"{[(kp, grades.get(kp)) for kp in offenders]}",
                )
                # 每关的学段都要**真的读得到**（教材里没有的 kp 是另一种静默错误）
                unknown = [kp for kp in path if kp not in grades]
                self.assertEqual(unknown, [], f"路径里有教材查不到的 kp：{unknown}")

    def test_higher_grade_successor_is_absent_from_path_but_still_404_on_direct_fetch(
        self,
    ) -> None:
        """★★ 死胡同**确实被修掉**、且**隔离没有被绕过**。

        对每个「有更高学段可走」的学生，取一条**真实存在**的跨学段边
        （路径上的 kp → 更高学段的直接后继，正是缺陷的成因），断言：

        - 那个更高学段的 kp **不在**路径里（学段隔离把整条路径限在兼容范围内）；
        - 但**直接请求**它仍然 **404** —— 说明修的是「路径不该包含它」，
          而不是「把取题的学段隔离放宽了」。两条一起才叫收敛，只放宽隔离是把缺陷藏起来。
        """
        grades = self._kp_grades()
        checked: dict[str, str] = {}
        for grade_level in GRADE_LEVELS:
            allowed = set(compatible_grades(grade_level))
            path, _ = self._walk(grade_level)
            path_set = set(path)

            crossing: list[tuple[str, str]] = []
            for kp in path:
                for successor in self._successors(kp):
                    if successor not in grades:
                        continue
                    if grades[successor] not in allowed:
                        crossing.append((kp, successor))
            if not crossing:
                # senior 的兼容范围就是四学段全体，不存在「更高学段」——这是预期的空集
                self.assertEqual(
                    grade_level,
                    GRADE_LEVELS[-1],
                    f"★ {grade_level} 应当能走出一条跨到更高学段的边（夹具前提不成立）",
                )
                continue

            source, higher = sorted(crossing)[0]
            checked[grade_level] = f"{source} → {higher}（{grades[higher]}）"
            self.assertNotIn(
                higher,
                path_set,
                f"★ {higher}（{grades[higher]}）高于 {grade_level} 学生，不该在路径里出现",
            )
            response = self.client.get(
                f"/api/quiz/bank/{higher}", params={"gradeLevel": grade_level}
            )
            self.assertEqual(
                response.status_code,
                404,
                f"★ 学段隔离必须仍然生效：{grade_level} 学生直接取 {higher}"
                f"（{grades[higher]}）应当是 404，实测 {response.status_code}",
            )

        # 三个非最高学段都必须真的验过一条跨学段边（否则这条断言可能在空转）
        self.assertEqual(
            sorted(checked),
            sorted(GRADE_LEVELS[:-1]),
            f"跨学段边只在这些学段验到：{checked}",
        )

    def test_the_reported_dead_end_pair_is_gone_for_primary_high(self) -> None:
        """★ 复现工单里点名的那个死胡同：`primary_high` 学生走不到 `ai-definition-jr`。

        缺陷场景：小学高年级学生的路径里混进了 ``ai-definition-jr``（初中）→ 取题 404。
        修复后：该知识点**根本不进路径**（路径按学段隔离），
        而直接请求它仍然 404（隔离不变）。

        ⚠️ 旧知识库（33 个 kp 的那一代）里点名的对子是一条「图片分类（小学高年级）→
        数据特征（初中）」的边；新库（K12KnowledgeBase）里那两个 kp 都不存在，
        所以改成**同一个概念相邻的两个学段**（``ai-definition-ph → ai-definition-jr``）——
        跨学段边在新库里比比皆是（每个概念都有一条 pl→ph→jr→sr 的链），
        这条用例的判别力没有变化。
        """
        path, rows = self._walk("primary_high")
        self.assertNotIn("ai-definition-jr", path, "★ 初中知识点不该出现在小学高年级的路径里")
        self.assertIn(
            "ai-definition-ph",
            path,
            "前提：`ai-definition-ph` 本身是该学生兼容范围内的关卡",
        )
        self.assertIn("ai-definition-jr", self._successors("ai-definition-ph"),
                      "前提：`ai-definition-jr` 确实是它的后继（否则这条用例没在测那条边）")

        # 真走一遍「练完前置」：进度里仍不许冒出跨学段的那一个
        questions = [
            _variant(f"deadend-{i}", "ai-definition-ph", stem=f"练习 {i}", answer="2")
            for i in range(1, 5)
        ]
        response = self.register(questions, grade="primary_high")
        self.assertEqual(response.status_code, 200, response.text)
        for item in response.json()["questions"]:
            self.grade(item["qid"], "2")
        after = {item["kpId"]: item["stage"] for item in self.progress().json()["levels"]}
        self.assertEqual(
            after.get("ai-definition-jr"),
            None,
            "★ 练完前置也不该让初中的知识点出现在进度里（路径按学段隔离）",
        )
        direct = self.client.get(
            "/api/quiz/bank/ai-definition-jr", params={"gradeLevel": "primary_high"}
        )
        self.assertEqual(direct.status_code, 404, "★ 直接请求更高学段的内容仍应 404（隔离未被削弱）")


    def test_path_covers_every_kp_of_the_students_grade(self) -> None:
        """★★ 关卡路径**不得被长度上限截断**：本学段有几个知识点，路径就得有几关。

        缺陷形态（修之前实测）：``level_order_from_graph`` 的 ``limit: int = 40`` 把每个
        学段的后 **17 关**切掉，学生本该练到的内容整块从关卡列表里消失；
        而落进 ``progress`` 表的那些关又会被 :func:`progress_snapshot` 的
        ``rank.get(kp_id, fallback)`` 兜到进度条**最末** —— 进度条与「该练什么」对不上。

        判据落在**行为**上（不查源码里有没有 ``limit`` 这个字面量）：
        路径条数 == 该学段在教材里的知识点数；且路径集合 == 该学段知识点集合。
        """
        grades = self._kp_grades()
        own = {grade: sum(1 for value in grades.values() if value == grade) for grade in GRADE_LEVELS}
        for grade_level in GRADE_LEVELS:
            with self.subTest(grade=grade_level):
                self.set_student(f"student_pathlen_{grade_level}")
                self.set_grade(grade_level)
                levels = [item["kpId"] for item in self.progress().json()["levels"]]
                self.assertEqual(
                    len(levels),
                    own[grade_level],
                    f"★ {grade_level} 的路径被截断了：只有 {len(levels)} 关，"
                    f"而该学段有 {own[grade_level]} 个知识点",
                )
                self.assertEqual(
                    {kp for kp, value in grades.items() if value == grade_level},
                    set(levels),
                    f"★ {grade_level} 的路径应与该学段的知识点集合一一对应",
                )

    def test_answering_does_not_add_levels_outside_the_path(self) -> None:
        """★★ 作答**只推进当前关**，不往进度里塞路径外的关卡。

        「解锁后继」删掉之后，作答对进度的写路径只剩「这一关自己」这一条 ——
        所以进度集合恒等于路径集合（冷启动播下的第一批 + 作答过的那些，都在路径里）。
        这是原 ``test_unlocked_levels_stay_inside_the_path`` 的替代：后者守的是
        「解锁出来的关不能落在路径外」，而现在根本没有「解锁出来的关」。
        """
        self.set_student("student_answer_in_path")
        self.set_grade("primary_low")
        body = self.progress().json()
        path = [item["kpId"] for item in body["levels"]]
        self.assertNotIn("locked", {item["stage"] for item in body["levels"]})

        # 任取一关作答（不再有「只有第一关能做」的限制）
        first = body["levels"][0]["kpId"]
        questions = [
            _variant(f"inpath-{i}", first, stem=f"练习 {i}", answer="2") for i in range(1, 5)
        ]
        response = self.register(questions, grade="primary_low")
        self.assertEqual(response.status_code, 200, response.text)
        for item in response.json()["questions"]:
            self.grade(item["qid"], "2")

        after = {item["kpId"] for item in self.progress().json()["levels"]}
        self.assertIn(first, after, "被打通的那一关应已推进")
        self.assertEqual(
            after,
            set(path),
            "★ 作答不该往进度里加路径外的关卡（旧行为：解锁的后继会插一行）",
        )

    def test_in_path_hides_lower_grade_records_from_the_path_view(self) -> None:
        """★★ 学段升过级的学生：更低学段的旧记录**不算路径**，路径视图里不再重名。

        真机缺陷（截图）：智码工坊把整个 ``progress`` 表当学习路径渲染 —— 学段换过的
        学生（小学低 → 小学高 → 初中）名下三个学段的同名关卡都在，同一个大章节里
        「人工智能的定义」出现三次（名字一样、内容按学段不同）。
        修法：服务端逐行标 ``inPath``（= P-085 的「关卡路径 = 本学段」），前端**路径视图**
        只渲染 True；旧记录仍留在库里（P-086：读时不删行），记录视图照旧全渲染。
        """
        grades = self._kp_grades()
        self.set_student("student_path_inpath")
        # ① 小学低冷启动：进度里落下小学低那一份（此时没有路径外的行）
        self.set_grade("primary_low")
        before = self.progress().json()
        self.assertTrue(
            all(item["inPath"] for item in before["levels"]),
            "小学低学生的进度应当全是本学段路径内的关卡",
        )

        # ② 学段升到初中：路径换成初中的 57 关，小学低那 57 行仍留在库里
        self.set_grade("junior")
        body = self.progress().json()
        own = {kp for kp, value in grades.items() if value == "junior"}
        on_path = {item["kpId"] for item in body["levels"] if item["inPath"]}
        off_path = {item["kpId"] for item in body["levels"] if not item["inPath"]}
        self.assertEqual(on_path, own, "★ 路径 = 本学段的知识点集合")
        self.assertEqual(
            off_path,
            {kp for kp, value in grades.items() if value == "primary_low"},
            "★ 更低学段的旧记录必须被标成**路径外**（而不是被删掉）",
        )

        # ③ 路径视图要渲染的那些关卡，**名字不得重复**（这就是用户截图里的症状）
        names = [
            doc.knowledge_point
            for doc in load_library(KNOWLEDGE_DIR)
            if doc.kp_id in on_path
        ]
        duplicates = sorted({name for name in names if names.count(name) > 1})
        self.assertEqual(duplicates, [], f"★ 路径视图里仍出现重名关卡：{duplicates}")


# --------------------------------------------------------------------------- #
# 6.6 路径外关卡的补位序（`progress_snapshot` 的 `fallback_order`）
# --------------------------------------------------------------------------- #
class TestProgressSnapshotOrdering(unittest.TestCase):
    """★ 进度排序：主序（本学段路径）优先，路径外**已知 kp** 按补位拓扑序排，而非一律队尾。

    这组断言不碰 HTTP，直接用 ``LearningStore`` + ``progress_snapshot`` —— 排序是纯逻辑，
    把它绑在端到端用例上只会让失败原因变模糊（「排序错了」还是「路径取错了」）。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.store = LearningStore(self.tmp / "ordering.db")
        self.addCleanup(self.store.close)
        self.store.seed_progress(["z-main", "b-out", "a-out"])

    def _order(self, **kwargs) -> list[str]:
        return [row["kpId"] for row in progress_snapshot(self.store, **kwargs)]

    def test_fallback_order_replaces_alphabetical_order(self) -> None:
        """路径外的 kp 按 ``fallback_order`` 排，而不是按 kp_id 字典序。

        字典序是**巧合序**：kp_id 前缀是概念 slug（``ai-definition-pl`` / ``prog-loop-jr``），
        与「先学哪个」无关。所以本条特意让补位序与字典序**相反**，
        否则用例会在「刚好一样」的假象里通过。
        """
        self.assertEqual(
            self._order(order=["z-main"], fallback_order=["b-out", "a-out"]),
            ["z-main", "b-out", "a-out"],
        )

    def test_main_order_is_never_disturbed_by_the_fallback(self) -> None:
        """主序里的 kp **保持它的主序位次**（补位用 ``setdefault``，不覆盖已有 rank）。

        否则「学生自己学段的路径」会被更低学段的补位序挤开 —— 那是比原来的缺陷更糟的倒退：
        现在至少本学段的关是排对的。
        """
        self.assertEqual(
            self._order(order=["z-main", "b-out"], fallback_order=["a-out"]),
            ["z-main", "b-out", "a-out"],
        )

    def test_without_fallback_order_behaviour_is_unchanged(self) -> None:
        """不传补位序时退回原行为（按 kp_id 排）—— 既有调用方字节不变。"""
        self.assertEqual(self._order(order=["z-main"]), ["z-main", "a-out", "b-out"])

    def test_in_path_marks_only_the_students_own_path(self) -> None:
        """★ ``path_kp_ids`` 是 ``inPath`` 的**唯一**判据（路径内 True / 路径外 False）。

        真机缺陷形态（用户截图）：学段换过的学生进度表里同时留着小学低 / 小学高 / 初中
        三份同名关卡，路径视图按整张表渲染 → 同一个模块里「人工智能的定义」出现三次。
        服务端在这里逐行表态，前端**路径视图**据此只渲染 ``inPath=True`` 的那些。
        """
        flags = {
            row["kpId"]: row["inPath"]
            for row in progress_snapshot(self.store, order=["z-main"], path_kp_ids=["z-main"])
        }
        self.assertEqual(flags, {"z-main": True, "b-out": False, "a-out": False})

    def test_in_path_is_true_when_the_path_scope_is_not_given(self) -> None:
        """不传 ``path_kp_ids`` → **不判断**（全 True）：既有调用方与老前端行为不变。"""
        self.assertTrue(all(row["inPath"] for row in progress_snapshot(self.store)))


# --------------------------------------------------------------------------- #
# 7. 冷启动
# --------------------------------------------------------------------------- #
class TestColdStart(LoopCase):
    def test_brand_new_student_gets_all_levels_answerable(self) -> None:
        """★★ 全新学生：`progress` 表为空也能直接可用，且**所有关卡都可作答**。

        设计口径（票 15「闯关」+「关卡顺序由依赖图拓扑序决定」，2026-09-25 去锁定后）：
        默认路径**按依赖图拓扑序全部初始化**，每一关都是 `learning`（还没做过但可以开始）——
        没有任何一关是 `locked`，学生想从哪一关开始都行。
        """
        self.set_student("student_brand_new_15")
        response = self.progress()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["studentId"], "student_brand_new_15")
        self.assertGreater(len(body["levels"]), 0, "冷启动必须给出可做的关卡")
        self.assertGreater(body["seeded"], 0, "应真的初始化了默认路径")

        stages = {x["stage"] for x in body["levels"]}
        self.assertNotIn("locked", stages, "★ 冷启动不该产出任何 locked 关卡")
        self.assertEqual(stages, {"learning"}, f"冷启动每一关都应可直接作答：{stages}")

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
        self.register([_variant("keep-1", "prog-variable-jr", answer="2")])
        self.grade("keep-1", "2")
        before = self.level("prog-variable-jr")
        self.assertEqual(before["stage"], "quizzed")
        self.assertIsNotNone(before["badge"])

        # 再来一次冷启动（模拟另一次调用）
        self.progress()
        after = self.level("prog-variable-jr")
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
                _variant("h-obj", "prog-variable-jr", answer="2"),
                _variant("h-sub", "prog-variable-jr", stem="开放题", answer="参考", rubric="要点"),
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
        self.register([_variant("body-1", "prog-variable-jr", answer="2")])
        student_words = "学生原话不该进数据库这句话"
        self.client.post(
            "/api/quiz/grade",
            json={
                "studentId": self.student,
                "qid": _gq("body-1"),
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

        用**冷启动放出来的第一关**（按依赖图拓扑序，现在整条路径都可作答）——
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

        `token-pl`（「Token」，小学低年级）在依赖图里离入口 **5 跳**：

            ai-definition-pl --related--> ai-hierarchy-pl --related--> deep-learning-pl
            --related--> neural-network-pl --related--> transformer-pl --related--> token-pl

        早期实现沿用 `deps.DEFAULT_DEPTH=3`，结果深处的关卡**根本没进关卡列表** ——
        表现为「依赖图明明有这条线，学生的进度里却没有这一关」。

        ★ **前提修正（与 `TestGateD` 同一处，理由一样）**：这条断言测的是
          「递归深度别把深处的关卡截掉」这个**机制**，与学段无关；而这条深链整个落在
          **小学低年级**的兼容范围内（链上五个知识点都是 `-pl`），所以把学生显式设成
          `primary_low`，让「深链覆盖」在一个该学段真的能看到这条链的学生上被验证。
          冷启动默认学段 `primary_high` 虽然也兼容这些关卡，但它的 40 关里排不下这条深链。
          修复后仍要证明的是：在兼容范围内，5 跳的关卡**一关不少**。
        """
        self.set_student("student_deep")
        self.set_grade("primary_low")
        body = self.progress().json()
        ids = {item["kpId"] for item in body["levels"]}
        deep_chain = (
            "ai-definition-pl",
            "ai-hierarchy-pl",
            "deep-learning-pl",
            "neural-network-pl",
            "transformer-pl",
            "token-pl",
        )
        for expected in deep_chain:
            self.assertIn(expected, ids, f"★ 深链上的 {expected} 必须出现在默认关卡路径里")
        # 拓扑序：前置必须排在后继之前（整条 5 跳链逐段验）
        ordered = [item["kpId"] for item in body["levels"]]
        self.assertEqual(
            sorted(ids), sorted(ordered), "关卡列表应稳定有序（同一份图两次调用顺序一致）"
        )
        for earlier, later in zip(deep_chain, deep_chain[1:]):
            self.assertLess(
                ordered.index(earlier),
                ordered.index(later),
                f"★ 深链上 {earlier} 必须排在 {later} 之前",
            )

        # ★ 同一份拓扑序在**别的学段**同样成立（换一个学生走一遍 junior 的路径）：
        #   路径只看学生自己的学段，所以这里比的是 junior 内部的一对真实前置/后继。
        self.set_student("student_deep_junior")
        self.set_grade("junior")
        junior = [item["kpId"] for item in self.progress().json()["levels"]]
        self.assertLess(
            junior.index("ai-definition-jr"),
            junior.index("ai-hierarchy-jr"),
            "★ junior 路径内部也要保持前置先于后继（ai-definition-jr → ai-hierarchy-jr）",
        )


if __name__ == "__main__":
    unittest.main()


# --------------------------------------------------------------------------- #
# D-088：生成题**归学生**，并有一条读路径把它列回来（「我的题目」的数据面）
# --------------------------------------------------------------------------- #
class TestGeneratedQuestionLibrary(LoopCase):
    """生成的题不是一次性的：登记时就归到这个学生名下，之后能列回来、能再判分。

    ★ 为什么单独一组：在此之前生成题只有**写**路径（`/api/quiz/variants`）与按 qid 判分，
      没有任何读路径 —— 学生做完一轮就再也见不到那些题（存了，拿不回来）。
    """

    def test_owner_can_list_them_back(self) -> None:
        self.set_student("gen_lib_a")
        self.register([_variant("lib-1", "prog-variable-jr", answer="2")])

        response = self.client.get("/api/quiz/generated/gen_lib_a")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["source"], "generated")
        self.assertIn(_gq("lib-1"), [item["qid"] for item in body["questions"]])

    def test_projection_has_no_answer_field(self) -> None:
        """★ 与题库那条路同一个投影：结构上没有 answer / explanation / rubric。"""
        self.set_student("gen_lib_b")
        self.register([_variant("lib-2", "prog-variable-jr", answer=SENTINEL_ANSWER)])
        text = self.client.get("/api/quiz/generated/gen_lib_b").text
        self.assertNotIn(SENTINEL_ANSWER, text, "★ 读路径把标准答案带出去了")
        for item in json.loads(text)["questions"]:
            self.assertEqual(
                set(item.keys()) & {"answer", "explanation", "rubric"},
                set(),
                f"生成题的对外结构多了字段：{sorted(item.keys())}",
            )

    def test_another_student_does_not_see_it(self) -> None:
        self.set_student("gen_lib_c")
        self.register([_variant("lib-3", "prog-variable-jr", answer="2")])
        other = self.client.get("/api/quiz/generated/gen_lib_other").json()
        self.assertEqual(other["questions"], [], "★ 学生的题串到别人名下了")

    def test_kp_filter_and_order(self) -> None:
        self.set_student("gen_lib_d")
        self.register([_variant("lib-4", "prog-variable-jr", answer="2")])
        self.register([_variant("lib-5", "prog-loop-jr", answer="3")])
        only_loop = self.client.get("/api/quiz/generated/gen_lib_d?kpId=prog-loop-jr").json()
        self.assertEqual([item["kpId"] for item in only_loop["questions"]], ["prog-loop-jr"])
        both = self.client.get("/api/quiz/generated/gen_lib_d").json()
        self.assertEqual(len(both["questions"]), 2)

    def test_questions_stay_answerable_after_reload(self) -> None:
        """★ 「能再使用」的判据：列回来的 qid **仍然可判分**（答案还在后端）。"""
        self.set_student("gen_lib_e")
        self.register([_variant("lib-6", "prog-variable-jr", answer="2")])
        listed = self.client.get("/api/quiz/generated/gen_lib_e").json()["questions"][0]
        again = self.grade(listed["qid"], "2")
        self.assertEqual(again.status_code, 200, again.text)
        self.assertTrue(again.json()["correct"], "列回来的题判分失败 —— 读路径把 qid 弄丢了？")

    def test_bad_student_id_is_422(self) -> None:
        response = self.client.get("/api/quiz/generated/有中文的id")
        self.assertEqual(response.status_code, 422, response.text)
