# -*- coding: utf-8 -*-
"""票 25 后端半：对话式冷启动五问（/api/onboarding/*）。

盯住四件事：

1. **状态机**：not_started → 答第一问 in_progress → 收齐五问 done；done 不回退；
   ★ 票 31：`done` 是**唯一终态**；历史库里落了 `skipped` 的学生按「没答完」处理 ——
   照常给下一问，再答一问就把它推回 in_progress（**没有跳过入口可产生 skipped** 了）；
2. **一问一答、幂等**：同一 question_id 重答是**覆盖**（onboarding_qa 上 UNIQUE），
   行数不增、answer_text 变成最新那条；
3. **触发条件只有一条**：**没到 done 就接着问**；只有 done 时 next_question_id 为 None；
4. **跨学生隔离**：A 的回答绝不进 B 的库（一人一库，G-E 的隔离面）。

★ 本文件不需要知识库，零 skip。

跑法::

    cd server && uv run python -m unittest tests.test_onboarding_routes -v
"""

from __future__ import annotations

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
from app.contracts import ONBOARDING_QUESTION_TEXTS, STUDENT_FALLBACK_NAME  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes.students import student_learning_db_path  # noqa: E402
from app.store.learning import LearningStore  # noqa: E402

TOKEN = "test-token-onboarding"
QUESTION_IDS = ("q1", "q2", "q3", "q4", "q5")


class OnboardingCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config(token=TOKEN, data_dir=self.tmp))
        self.client = TestClient(self.app)
        self.client.headers.update({"X-Auth-Token": TOKEN})
        self.student_id = "student_onb_001"

    # ------------------------------------------------------------ 小工具 --
    def state(self, student_id: str | None = None) -> dict:
        response = self.client.get(f"/api/onboarding/{student_id or self.student_id}/state")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def answer(self, question_id: str, text: str, student_id: str | None = None) -> object:
        return self.client.post(
            f"/api/onboarding/{student_id or self.student_id}/answer",
            json={"questionId": question_id, "answerText": text},
        )

    def seed_state(self, state: str, student_id: str | None = None) -> None:
        """★ 票 31 之后 `skipped` 只能来自「老库」—— 端点层面不再有路径产生它。

        所以要测「历史 skipped 怎么被对待」，就得直接写库，而不是调端点。
        """
        sid = student_id or self.student_id
        store = LearningStore(student_learning_db_path(self.tmp, sid))
        try:
            store.set_onboarding_state(sid, state)
        finally:
            store.close()

    def query(self, sql: str, params: tuple = (), student_id: str | None = None) -> list:
        conn = sqlite3.connect(student_learning_db_path(self.tmp, student_id or self.student_id))
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def exec_sql(self, sql: str, params: tuple = ()) -> None:
        conn = sqlite3.connect(student_learning_db_path(self.tmp, self.student_id))
        try:
            conn.execute(sql, params)
            conn.commit()
        finally:
            conn.close()


# --------------------------------------------------------------------------- #
# 状态机
# --------------------------------------------------------------------------- #
class TestOnboardingStateMachine(OnboardingCase):
    def test_default_state_is_not_started_with_q1_next(self) -> None:
        payload = self.state()
        self.assertEqual(payload["onboardingState"], "not_started")
        self.assertEqual(payload["answered"], [])
        self.assertEqual(payload["nextQuestionId"], "q1")
        self.assertEqual(payload["displayName"], STUDENT_FALLBACK_NAME)

    def test_reading_state_has_no_side_effects(self) -> None:
        """★ 读一次状态不该在库里留下任何行（读路径零副作用）。"""
        self.state()
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM student")[0]["n"], 0)
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM identity_local")[0]["n"], 0)

    def test_first_answer_moves_to_in_progress(self) -> None:
        response = self.answer("q1", "小学高年级")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["accepted"])
        self.assertEqual(payload["state"]["onboardingState"], "in_progress")
        self.assertEqual(payload["state"]["answered"], ["q1"])
        self.assertEqual(payload["state"]["nextQuestionId"], "q2")
        # 学生行被冷启动兜底建出来（与画像写入路径同口径）
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM student")[0]["n"], 1)

    def test_all_five_answers_finish_onboarding(self) -> None:
        for question_id in QUESTION_IDS:
            response = self.answer(question_id, f"答案-{question_id}")
            self.assertEqual(response.status_code, 200, response.text)
        payload = self.state()
        self.assertEqual(payload["onboardingState"], "done")
        self.assertEqual(payload["answered"], list(QUESTION_IDS))
        self.assertIsNone(payload["nextQuestionId"])

    def test_skip_endpoint_no_longer_exists(self) -> None:
        """★ 票 31：跳过五问的入口**全链路删除** —— 端点不许还认这条路。"""
        response = self.client.post(f"/api/onboarding/{self.student_id}/skip")
        self.assertEqual(response.status_code, 404, f"跳过端点必须不存在：{response.text}")
        # 对照：answer 那条写路径还在（否则上面那条 404 只说明整个路由没挂上）
        self.assertEqual(self.answer("q1", "在").status_code, 200)

    def test_historical_skipped_keeps_asking_until_done(self) -> None:
        """★★ 老库里落了 skipped 的学生按「没答完」处理：照常给下一问。"""
        self.seed_state("skipped")
        payload = self.state()
        self.assertEqual(payload["onboardingState"], "skipped", "历史状态原样回给前端（兼容，不改写）")
        self.assertEqual(payload["nextQuestionId"], "q1", "历史 skipped 也要接着问，直到 done")

    def test_answering_after_historical_skipped_returns_to_in_progress(self) -> None:
        self.seed_state("skipped")
        response = self.answer("q1", "我又想答了")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["state"]["onboardingState"], "in_progress")
        self.assertEqual(response.json()["state"]["nextQuestionId"], "q2")

    def test_done_does_not_roll_back_on_reanswer(self) -> None:
        """五问答完 = done 是终态：再答一问也不回退，且不再给下一问。"""
        for question_id in QUESTION_IDS:
            self.answer(question_id, "x")
        response = self.answer("q1", "再答一次")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["state"]["onboardingState"], "done")
        self.assertIsNone(response.json()["state"]["nextQuestionId"])


# --------------------------------------------------------------------------- #
# 一问一答（幂等：覆盖不追加）
# --------------------------------------------------------------------------- #
class TestOnboardingAnswers(OnboardingCase):
    def test_reanswer_overwrites_instead_of_appending(self) -> None:
        self.answer("q1", "第一次")
        self.answer("q1", "第二次")
        rows = self.query("SELECT question_id, answer_text FROM onboarding_qa")
        self.assertEqual(len(rows), 1, "重答必须是覆盖，不能追加第二行")
        self.assertEqual(rows[0]["answer_text"], "第二次")

    def test_question_text_is_snapshotted(self) -> None:
        """问句脚本落库（便于事后核对口径变更），不靠前端回传。"""
        self.answer("q3", "多举例子")
        row = self.query("SELECT question_text FROM onboarding_qa WHERE question_id='q3'")[0]
        self.assertEqual(row["question_text"], ONBOARDING_QUESTION_TEXTS["q3"])

    def test_answer_text_is_normalized_to_single_line(self) -> None:
        self.answer("q2", "  数学\n  和科学  ")
        row = self.query("SELECT answer_text FROM onboarding_qa WHERE question_id='q2'")[0]
        self.assertEqual(row["answer_text"], "数学 和科学")

    def test_blank_answer_is_422(self) -> None:
        for blank in ("", "   ", "\n\t"):
            self.assertEqual(self.answer("q2", blank).status_code, 422, repr(blank))

    def test_unknown_question_id_is_422(self) -> None:
        self.assertEqual(self.answer("q9", "x").status_code, 422)
        self.assertEqual(self.answer("", "x").status_code, 422)

    def test_too_long_answer_is_422(self) -> None:
        self.assertEqual(self.answer("q2", "长" * 401).status_code, 422)
        self.assertEqual(self.answer("q2", "长" * 400).status_code, 200)

    def test_extra_body_field_is_422(self) -> None:
        """契约 extra=forbid：多带一个 studentId / text 直接 422。"""
        response = self.client.post(
            f"/api/onboarding/{self.student_id}/answer",
            json={"questionId": "q1", "answerText": "x", "studentId": "别人的 id"},
        )
        self.assertEqual(response.status_code, 422, response.text)

    def test_onboarding_qa_unique_index_rejects_duplicates_at_db_level(self) -> None:
        self.answer("q1", "第一次")
        from app.routes.students import open_learning_store

        store = open_learning_store(self.tmp, self.student_id)
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                store.conn.execute(
                    "INSERT INTO onboarding_qa(question_id, answer_text) VALUES('q1', '重复')"
                )
        finally:
            store.conn.rollback()
            store.close()


# --------------------------------------------------------------------------- #
# 隔离与本地身份
# --------------------------------------------------------------------------- #
class TestOnboardingIsolation(OnboardingCase):
    def test_answers_never_leak_to_another_student(self) -> None:
        other = "student_onb_002"
        self.answer("q1", "A 的回答")
        for question_id in QUESTION_IDS:
            self.answer(question_id, f"A-{question_id}")
        state_a = self.state()
        state_other = self.state(other)
        self.assertEqual(state_a["answered"], list(QUESTION_IDS))
        self.assertEqual(state_other["answered"], [], "别的学生不该看到 A 的回答")
        self.assertEqual(state_other["onboardingState"], "not_started")
        self.assertEqual(
            self.query("SELECT COUNT(*) AS n FROM onboarding_qa", student_id=other)[0]["n"], 0
        )
        self.assertNotEqual(
            student_learning_db_path(self.tmp, self.student_id),
            student_learning_db_path(self.tmp, other),
        )

    def test_display_name_is_sanitized_from_identity(self) -> None:
        # 先把这个学生的库建出来（读状态是零副作用的，不会替我们建库）。
        LearningStore(student_learning_db_path(self.tmp, self.student_id)).close()
        self.exec_sql(
            "INSERT INTO identity_local(anon_student_id, real_name) VALUES(?,?)",
            (self.student_id, "小W"),
        )
        self.assertEqual(self.state()["displayName"], "小W")
        self.exec_sql(
            "UPDATE identity_local SET real_name='在XX小学二班' WHERE anon_student_id=?",
            (self.student_id,),
        )
        self.assertEqual(self.state()["displayName"], STUDENT_FALLBACK_NAME)

    def test_learning_history_question_stays_empty_on_onboarding_path(self) -> None:
        """★ 五问走 onboarding_qa，**不**顺手写 learning_history（G-K 不被绕开）。"""
        self.answer("q1", "五年级")
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM learning_history")[0]["n"], 0)


class TestOnboardingAnswersReadBack(OnboardingCase):
    """W8（task-47）：补概括用的**只读**出口 —— 只回五问正文，零副作用、按学生隔离。

    为什么需要它：没配 Key 时五问照常答完，但那批回答是冷启动最值钱的素材；
    主进程跨重启补跑时必须能**回读**它们，而答案不能复制到本地（隐私：学生原话只有一处）。
    """

    def answers(self, student_id: str | None = None) -> object:
        return self.client.get(f"/api/onboarding/{student_id or self.student_id}/answers")

    def test_returns_the_five_answers_in_order(self) -> None:
        for question_id in QUESTION_IDS:
            self.assertEqual(self.answer(question_id, f"回答-{question_id}").status_code, 200)
        response = self.answers()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual([item["questionId"] for item in body["answers"]], list(QUESTION_IDS))
        self.assertEqual(body["answers"][0]["answerText"], "回答-q1")
        # ★ 问句原文**不回传**：配对在主进程那侧做（少一处会漂的副本）。
        self.assertNotIn("questionText", body["answers"][0])

    def test_reading_is_side_effect_free_and_empty_before_answering(self) -> None:
        response = self.answers()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["answers"], [])
        # 一条回答都没给过 → 读一次不该留下任何行（读路径零副作用；与 state 那条同口径：
        # 共用的 open_learning_store 会建库文件，但**不建行**）。
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM onboarding_qa")[0]["n"], 0)

    def test_answers_do_not_leak_across_students(self) -> None:
        self.answer("q1", "A 的回答")
        other = "student_onb_002"
        self.assertEqual(self.answers(other).json()["answers"], [])
        self.answer("q1", "B 的回答", student_id=other)
        self.assertEqual(self.answers().json()["answers"][0]["answerText"], "A 的回答")
        self.assertEqual(self.answers(other).json()["answers"][0]["answerText"], "B 的回答")


if __name__ == "__main__":
    unittest.main()
