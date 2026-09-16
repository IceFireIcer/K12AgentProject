# -*- coding: utf-8 -*-
"""票 21：学段自动推断（第一层信号 + 第二层提议 + 规则引擎 + 四个端点 + 落库）。

这一份测试盯住「错了就静默出事」的五类问题：

1. **四类信号各自可单测**（``app/grade/signals.py`` 全是纯函数）：词汇 / 深度 / 答题 / 元认知，
   每类都有自己的判据与边界，**不调 LLM**；
2. ★ **规则引擎的四条硬约束**（执行文档 §10.3）逐条断言：
   ① 置信度 < 0.6 不改（边界写死 ``0.59`` / ``0.60``）② 连续 3 轮同方向
   ③ 改后 5 轮冷却 ④ 单次最多动 1 级；外加「一条反向信号不能翻盘」；
3. ★ **LLM 只是提议**：与规则反向时被否决（``llm_conflict``），同向时只能抬高置信度、
   **不能改变方向与步长**；
4. ★ **降级可见**：没有提议时第 3 轮起 ``degraded="no_llm"``（不是静默通过），
   且**第一层照常完成调整**（无 API Key 也能跑、也能改学段）；
5. ★ **合规**：学生原话经 HTTP 传进来但**不入库** —— 断言整库文件里找不到那句话
   （``grade_signals.raw`` 只写自有词表的命中项）。

跑法::

    cd server && uv run python -m unittest tests.test_grade -v
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
from app.contracts import GradeSignal  # noqa: E402
from app.grade.rules import (  # noqa: E402
    CONFIDENCE_THRESHOLD,
    COOLDOWN_TURNS,
    DEGRADED_NO_LLM,
    LAYER2_FIRST_TURN,
    LAYER2_RETRY_TURN,
    MAX_STEP_LEVELS,
    REASON_AT_BOUNDARY,
    REASON_CHANGED,
    REASON_COOLDOWN,
    REASON_LLM_CONFLICT,
    REASON_LOW_CONFIDENCE,
    REASON_NO_DIRECTION,
    SIGNALS_REQUIRED_FOR_CHANGE,
    SOURCE_INFERRED,
    GradeEngine,
    GradeProposal,
    TurnVerdict,
    decide,
    quiz_performance_from_history,
)
from app.grade.signals import (  # noqa: E402
    QuizPerformance,
    consecutive_same_direction,
    decode_turn_raw,
    encode_turn_raw,
    extract_depth_signal,
    extract_meta_cognition_signal,
    extract_quiz_perf_signal,
    extract_turn_signals,
    extract_vocab_signal,
)
from app.main import create_app  # noqa: E402
from app.routes.grade import router as grade_router  # noqa: E402
from app.routes.students import open_learning_store, student_learning_db_path  # noqa: E402
from app.store.learning import LearningStore  # noqa: E402

TOKEN = "test-token-grade"

#: 学生原话（测试专属的句子，便于在整库字节里搜「有没有被写进 SQLite」）。
CHILD_TURN_1 = "我家的小猫很可爱，电脑是怎么认图片的呀？"
CHILD_TURN_2 = "它会不会把我的小猫认成小狗呀？"
CHILD_TURN_3 = "我有点听不明白，再讲一遍好不好？"
ADVANCED_TURN_1 = "梯度下降的链式法则怎么推导？"
ADVANCED_TURN_2 = "损失函数和过拟合是什么关系？"
ADVANCED_TURN_3 = "正则化怎么证明能防止过拟合？"


def verdicts_from(texts: list[str], current_level: str, *, first_turn: int = 1) -> list[TurnVerdict]:
    """用**真提取器**把若干句话变成轮次读数（决策测试也吃真实信号，不喂手搓数字）。"""
    out: list[TurnVerdict] = []
    for index, text in enumerate(texts):
        signals = extract_turn_signals(
            text=text, turn=first_turn + index, current_level=current_level
        )
        out.append(
            TurnVerdict(turn=signals.turn, direction=signals.direction, strength=signals.strength)
        )
    return out


# --------------------------------------------------------------------------- #
# ① 四类信号（纯函数）
# --------------------------------------------------------------------------- #
class TestSignalExtraction(unittest.TestCase):
    def test_vocab_advanced_term_maps_to_its_min_grade(self) -> None:
        reading = extract_vocab_signal("梯度下降是怎么做到的", "primary_high")
        self.assertEqual(reading.level_hint, "senior")
        self.assertEqual(reading.direction, 1)
        # primary_high → senior 差 2 级 → 强度封顶 1.0
        self.assertAlmostEqual(reading.value, 1.0)
        self.assertIn("梯度下降", reading.raw)
        self.assertIn("min_grade=senior", reading.raw)

    def test_vocab_daily_terms_pull_down(self) -> None:
        reading = extract_vocab_signal(CHILD_TURN_1, "primary_high")
        self.assertEqual(reading.level_hint, "primary_low")
        self.assertAlmostEqual(reading.value, -0.5)
        self.assertIn("口语=", reading.raw)

    def test_vocab_term_at_current_level_is_neutral_but_recorded(self) -> None:
        reading = extract_vocab_signal("机器学习是什么", "junior")
        self.assertEqual(reading.value, 0.0)
        self.assertEqual(reading.level_hint, "junior")
        self.assertTrue(reading.has_evidence, "同档术语也是证据，要落库（值为 0）")

    def test_vocab_without_any_hit_has_no_evidence(self) -> None:
        reading = extract_vocab_signal("今天天气不错", "primary_high")
        self.assertEqual(reading.value, 0.0)
        self.assertIsNone(reading.level_hint)
        self.assertFalse(reading.has_evidence)

    def test_depth_concept_principle_derivation(self) -> None:
        self.assertEqual(extract_depth_signal("什么是人工智能", "primary_low").level_hint, "primary_high")
        self.assertEqual(extract_depth_signal("神经网络的工作原理是什么", "primary_high").level_hint, "junior")
        self.assertEqual(extract_depth_signal("链式法则怎么推导", "junior").level_hint, "senior")

    def test_depth_question_without_depth_word_falls_back_to_concept(self) -> None:
        reading = extract_depth_signal("电脑怎么认图片呀？", "primary_high")
        self.assertTrue(reading.has_evidence)
        self.assertEqual(reading.level_hint, "primary_high")
        self.assertEqual(reading.value, 0.0, "与当前学段同档 → 方向为 0")

    def test_depth_statement_without_depth_word_is_not_guessed(self) -> None:
        reading = extract_depth_signal("今天我在公园里玩了一下午", "primary_high")
        self.assertFalse(reading.has_evidence)

    def test_quiz_streak_up_and_down(self) -> None:
        up = extract_quiz_perf_signal(QuizPerformance(attempts=3, correct=3, current_streak=3), "", "junior")
        self.assertEqual(up.level_hint, "senior")
        self.assertGreater(up.value, 0)
        down = extract_quiz_perf_signal(QuizPerformance(attempts=3, correct=0, current_streak=-2), "", "junior")
        self.assertEqual(down.level_hint, "primary_high")
        self.assertLess(down.value, 0)

    def test_quiz_hints_and_too_hard_pull_down(self) -> None:
        reading = extract_quiz_perf_signal(
            QuizPerformance(attempts=4, correct=3, hints_requested=3), "", "junior"
        )
        self.assertLess(reading.value, 0)
        self.assertIn("要提示", reading.raw)

        from_text = extract_quiz_perf_signal(None, "这道题太难了", "junior")
        self.assertLess(from_text.value, 0)
        self.assertIn("太难了", from_text.raw)

    def test_quiz_conflict_prefers_downgrade(self) -> None:
        """证据一半朝上一半朝下时**下调优先**（不把受挫的学生往上推）。"""
        reading = extract_quiz_perf_signal(
            QuizPerformance(attempts=4, correct=4, current_streak=4, too_hard=True), "", "junior"
        )
        self.assertLess(reading.value, 0)

    def test_quiz_at_ceiling_and_floor_has_no_direction(self) -> None:
        senior = extract_quiz_perf_signal(QuizPerformance(current_streak=5), "", "senior")
        self.assertEqual(senior.value, 0.0)
        lowest = extract_quiz_perf_signal(QuizPerformance(current_streak=-3), "", "primary_low")
        self.assertEqual(lowest.value, 0.0)

    def test_meta_cognition_struggle_and_rephrase_pull_down(self) -> None:
        struggle = extract_meta_cognition_signal("老师我听不懂", "junior")
        self.assertEqual(struggle.level_hint, "primary_high")
        self.assertLess(struggle.value, 0)
        self.assertIn("受挫=", struggle.raw)

        rephrase = extract_meta_cognition_signal("能换个说法吗", "junior")
        self.assertLess(rephrase.value, 0)
        self.assertIn("求复述=", rephrase.raw)

    def test_meta_cognition_at_lowest_level_keeps_evidence_without_direction(self) -> None:
        reading = extract_meta_cognition_signal("我听不懂", "primary_low")
        self.assertEqual(reading.value, 0.0)
        self.assertTrue(reading.has_evidence)

    def test_turn_aggregates_four_classes(self) -> None:
        signals = extract_turn_signals(text=CHILD_TURN_3, turn=3, current_level="primary_high")
        self.assertEqual(len(signals.readings), 4, "四类读数每轮都要有（哪怕没有证据）")
        self.assertEqual(signals.direction, -1)
        self.assertAlmostEqual(signals.strength, 0.5)
        self.assertTrue(all(reading.signal_type in ("vocab", "depth", "quiz_perf", "meta_cognition") for reading in signals.readings))

    def test_raw_never_contains_the_students_sentence(self) -> None:
        signals = extract_turn_signals(text=CHILD_TURN_1, turn=1, current_level="primary_high")
        for reading in signals.readings:
            self.assertNotIn("小猫很可爱", reading.raw, "raw 只放自有词表的命中项，不放原话")

    def test_raw_carries_the_turn_anchor(self) -> None:
        encoded = encode_turn_raw(7, "口语=电脑")
        self.assertTrue(encoded.startswith("t7|"))
        self.assertEqual(decode_turn_raw(encoded), (7, "口语=电脑"))
        self.assertEqual(decode_turn_raw("没有锚点"), (None, "没有锚点"))
        self.assertEqual(decode_turn_raw(None), (None, ""))

    def test_consecutive_same_direction_breaks_on_neutral_turn(self) -> None:
        down = extract_turn_signals(text=CHILD_TURN_1, turn=1, current_level="primary_high")
        neutral = extract_turn_signals(text="嗯嗯", turn=2, current_level="primary_high")
        self.assertEqual(consecutive_same_direction([down, down, down]), (-1, 3))
        self.assertEqual(consecutive_same_direction([down, neutral, down]), (-1, 1))
        self.assertEqual(consecutive_same_direction([neutral]), (0, 0))


# --------------------------------------------------------------------------- #
# ② 规则引擎（纯决策）
# --------------------------------------------------------------------------- #
class TestDecisionRules(unittest.TestCase):
    def setUp(self) -> None:
        # 三句童言 → 三路同向（向下）的真实读数
        self.down = verdicts_from([CHILD_TURN_1, CHILD_TURN_2, CHILD_TURN_3], "primary_high")
        # 三句高中味道的提问 → 三路同向（向上）
        self.up = verdicts_from([ADVANCED_TURN_1, ADVANCED_TURN_2, ADVANCED_TURN_3], "primary_low")

    def test_thresholds_are_named_constants(self) -> None:
        self.assertEqual(CONFIDENCE_THRESHOLD, 0.6)
        self.assertEqual(SIGNALS_REQUIRED_FOR_CHANGE, 3)
        self.assertEqual(COOLDOWN_TURNS, 5)
        self.assertEqual(MAX_STEP_LEVELS, 1)
        self.assertEqual((LAYER2_FIRST_TURN, LAYER2_RETRY_TURN), (3, 5))

    def test_three_same_direction_turns_change_the_grade(self) -> None:
        decision = decide(current_level="primary_high", turn=3, verdicts=self.down)
        self.assertTrue(decision.changed)
        self.assertEqual(decision.reason, REASON_CHANGED)
        self.assertEqual(decision.target_level, "primary_low")
        self.assertAlmostEqual(decision.confidence, 0.75)
        self.assertEqual((decision.direction, decision.streak), (-1, 3))

    def test_two_signals_are_not_enough(self) -> None:
        decision = decide(current_level="primary_high", turn=2, verdicts=self.down[:2])
        self.assertFalse(decision.changed)
        self.assertEqual(decision.reason, REASON_NO_DIRECTION)
        self.assertEqual(decision.streak, 2)

    def test_a_single_opposite_signal_cannot_flip_the_grade(self) -> None:
        mixed = [self.down[0], self.down[1], self.up[0]]
        decision = decide(current_level="primary_high", turn=3, verdicts=mixed)
        self.assertFalse(decision.changed)
        self.assertEqual(decision.reason, REASON_NO_DIRECTION)
        self.assertEqual(decision.streak, 1)

    def test_confidence_boundary_059_is_rejected_and_060_accepted(self) -> None:
        """边界写死：``0.59`` 不改、``0.60`` 才进入后续判定（票 21 第 5 条验收）。"""
        # 规则置信度压到 0.30（三轮强度各 0.2），由第二层提议把置信度**顶到边界**：
        weak = [TurnVerdict(turn=n, direction=-1, strength=0.2) for n in (1, 2, 3)]
        below = decide(
            current_level="primary_high",
            turn=3,
            verdicts=weak,
            proposal=GradeProposal("primary_low", 0.59),
        )
        self.assertFalse(below.changed)
        self.assertEqual(below.reason, REASON_LOW_CONFIDENCE)
        self.assertAlmostEqual(below.confidence, 0.59)

        on_the_line = decide(
            current_level="primary_high",
            turn=3,
            verdicts=weak,
            proposal=GradeProposal("primary_low", 0.60),
        )
        self.assertTrue(on_the_line.changed)
        self.assertEqual(on_the_line.reason, REASON_CHANGED)
        self.assertAlmostEqual(on_the_line.confidence, 0.60)

    def test_weak_rules_without_llm_do_not_change_anything(self) -> None:
        weak = [TurnVerdict(turn=n, direction=-1, strength=0.2) for n in (1, 2, 3)]
        decision = decide(current_level="primary_high", turn=3, verdicts=weak)
        self.assertFalse(decision.changed)
        self.assertEqual(decision.reason, REASON_LOW_CONFIDENCE)

    def test_cooldown_suppresses_the_second_change(self) -> None:
        fresh = decide(current_level="primary_high", turn=3, verdicts=self.down)
        self.assertTrue(fresh.changed)
        self.assertEqual(fresh.cooldown_remaining, COOLDOWN_TURNS, "刚改过 → 冷却从头开始")

        for turn in (4, 5, 6, 7):
            blocked = decide(
                current_level="primary_low", turn=turn, verdicts=self.up, last_change_turn=3
            )
            self.assertFalse(blocked.changed, f"第 {turn} 轮（冷却期内）不该改")
            self.assertEqual(blocked.reason, REASON_COOLDOWN)
            self.assertGreater(blocked.cooldown_remaining, 0)

        allowed = decide(current_level="primary_low", turn=8, verdicts=self.up, last_change_turn=3)
        self.assertTrue(allowed.changed, "第 8 轮刚好满 5 轮冷却，应当放行")
        self.assertEqual(allowed.cooldown_remaining, COOLDOWN_TURNS, "第 8 轮的这次调整又开启 5 轮冷却")

    def test_never_moves_more_than_one_level(self) -> None:
        """证据是「高中」（差 2 级），也只上一级 —— 单次最多动 1 级。"""
        big = [TurnVerdict(turn=n, direction=1, strength=1.0) for n in (1, 2, 3)]
        decision = decide(current_level="primary_low", turn=3, verdicts=big)
        self.assertTrue(decision.changed)
        self.assertEqual(decision.target_level, "primary_high")

    def test_at_boundary_does_not_overflow(self) -> None:
        top = decide(current_level="senior", turn=3, verdicts=self.up)
        self.assertFalse(top.changed)
        self.assertEqual(top.reason, REASON_AT_BOUNDARY)

        floor = decide(current_level="primary_low", turn=3, verdicts=self.down)
        self.assertFalse(floor.changed)
        self.assertEqual(floor.reason, REASON_AT_BOUNDARY)

    def test_llm_only_proposes_and_is_vetoed_when_it_disagrees(self) -> None:
        conflict = decide(
            current_level="primary_high",
            turn=3,
            verdicts=self.down,
            proposal=GradeProposal("senior", 0.95),
        )
        self.assertFalse(conflict.changed)
        self.assertEqual(conflict.reason, REASON_LLM_CONFLICT)
        self.assertEqual(conflict.direction, -1, "方向仍由规则信号决定")

    def test_llm_same_direction_only_raises_confidence(self) -> None:
        # 同向（提议 primary_high，与规则同向）：置信度取二者较高，**步长仍只有 1 级**
        same = decide(
            current_level="junior",
            turn=3,
            verdicts=self.down,
            proposal=GradeProposal("primary_high", 0.97),
        )
        self.assertTrue(same.changed)
        self.assertEqual(same.target_level, "primary_high", "提议不能改变步长")
        self.assertAlmostEqual(same.confidence, 0.97)
        self.assertAlmostEqual(same.rule_confidence, 0.75)

    def test_llm_confidence_cannot_save_weak_rules_that_point_the_other_way(self) -> None:
        """提议即使「很自信」，只要方向与规则相反，方向仍由规则决定（然后被否决）。"""
        conflict = decide(
            current_level="primary_high",
            turn=3,
            verdicts=self.down,
            proposal=GradeProposal("senior", 0.99),
        )
        self.assertEqual(conflict.reason, REASON_LLM_CONFLICT)
        self.assertEqual(conflict.target_level, "primary_high")

    def test_missing_layer2_is_visible_not_silent(self) -> None:
        early = decide(current_level="primary_high", turn=2, verdicts=self.down[:2])
        self.assertIsNone(early.degraded, "第 3 轮之前第二层本来就还没到触发点")

        due = decide(current_level="primary_high", turn=3, verdicts=self.down)
        self.assertEqual(due.degraded, DEGRADED_NO_LLM)

        with_proposal = decide(
            current_level="primary_high",
            turn=3,
            verdicts=self.down,
            proposal=GradeProposal("primary_low", 0.72),
        )
        self.assertIsNone(with_proposal.degraded)

    def test_low_confidence_is_reported_before_cooldown(self) -> None:
        """判定顺序冻结：置信度不足 + 冷却期未过 → 报 ``low_confidence``。"""
        weak = [TurnVerdict(turn=n, direction=-1, strength=0.2) for n in (1, 2, 3)]
        decision = decide(current_level="primary_high", turn=4, verdicts=weak, last_change_turn=3)
        self.assertEqual(decision.reason, REASON_LOW_CONFIDENCE)


# --------------------------------------------------------------------------- #
# ③ 引擎落库（真库、真表）
# --------------------------------------------------------------------------- #
class GradeEngineCase(unittest.TestCase):
    """带临时一人一库的基类（绝不碰开发机的真实数据）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.student_id = "student_001"
        self.store = LearningStore(student_learning_db_path(self.tmp, self.student_id))
        self.addCleanup(self.store.close)
        self.engine = GradeEngine(self.store)

    def rows(self, sql: str, *params: object) -> list[sqlite3.Row]:
        return self.store.conn.execute(sql, params).fetchall()


class TestEnginePersistence(GradeEngineCase):
    def test_cold_start_defaults_to_primary_high_with_baseline_row(self) -> None:
        state = self.engine.state(self.student_id)
        self.assertEqual(state.grade_level, "primary_high", "冷启动默认小学高年级")
        self.assertEqual(state.source, SOURCE_INFERRED)
        self.assertEqual(state.cooldown_remaining, 0, "基线不是一次变更，不该产生冷却")

        rows = self.rows("SELECT turn, from_level, to_level, source, confidence FROM grade_history")
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["from_level"])
        self.assertEqual(rows[0]["to_level"], "primary_high")
        self.assertEqual(rows[0]["source"], SOURCE_INFERRED)

    def test_child_style_turns_lower_the_grade_at_the_third_turn(self) -> None:
        first = self.engine.observe_turn(
            student_id=self.student_id, turn=1, text=CHILD_TURN_1, session_id="sess-1"
        )
        second = self.engine.observe_turn(
            student_id=self.student_id, turn=2, text=CHILD_TURN_2, session_id="sess-1"
        )
        third = self.engine.observe_turn(
            student_id=self.student_id,
            turn=3,
            text=CHILD_TURN_3,
            session_id="sess-1",
            proposal=GradeProposal("primary_low", 0.72),
        )
        fourth = self.engine.observe_turn(
            student_id=self.student_id, turn=4, text=CHILD_TURN_3, session_id="sess-1"
        )

        self.assertEqual([first.decision.reason, second.decision.reason], [REASON_NO_DIRECTION] * 2)
        self.assertTrue(third.changed, "连续 3 轮同方向 → 第 3 轮就该调整")
        self.assertEqual(third.decision.target_level, "primary_low")
        # 第 4 轮：学段已经到底（primary_low），童言不再是向下信号；只剩「普通提问」
        # 这一档轻微的向上读数（primary_high 档），单轮远不够改
        self.assertEqual(fourth.decision.reason, REASON_NO_DIRECTION)
        self.assertEqual(fourth.decision.streak, 1, "一句普通提问只算 1 轮同向，动不了学段")
        self.assertEqual(fourth.decision.degraded, DEGRADED_NO_LLM, "没带提议 → 降级可见")
        self.assertEqual(self.engine.current_level(self.student_id), "primary_low")

        student = self.store.get_student(self.student_id)
        assert student is not None
        self.assertEqual(student.grade_level, "primary_low")

        change = self.rows(
            "SELECT turn, from_level, to_level, source, confidence FROM grade_history "
            "WHERE from_level IS NOT NULL ORDER BY id"
        )
        self.assertEqual(len(change), 1)
        self.assertEqual(change[0]["turn"], 3)
        self.assertEqual(change[0]["from_level"], "primary_high")
        self.assertEqual(change[0]["to_level"], "primary_low")
        self.assertEqual(change[0]["source"], "inferred", "来源必须记 inferred")
        self.assertAlmostEqual(change[0]["confidence"], 0.75)

    def test_signals_are_written_per_class_with_turn_anchor(self) -> None:
        self.engine.observe_turn(student_id=self.student_id, turn=1, text=CHILD_TURN_1, session_id="s")
        rows = self.rows("SELECT signal_type, value, raw, session_id FROM grade_signals ORDER BY id")
        self.assertGreaterEqual(len(rows), 2, "四类里至少有词汇与深度两路读数")
        self.assertEqual({row["session_id"] for row in rows}, {"s"})
        for row in rows:
            self.assertTrue(str(row["raw"]).startswith("t1|"), "raw 必须带轮次锚点")
        kinds = {row["signal_type"] for row in rows}
        self.assertIn("vocab", kinds)
        self.assertNotIn("meta_cognition", kinds, "童言 1 里没有元认知表达，就不写这一路")

    def test_students_sentence_never_reaches_the_database_file(self) -> None:
        """★ 合规：原话经 HTTP 传进来，但 SQLite 里**一个字都不能留**。"""
        for index, text in enumerate([CHILD_TURN_1, CHILD_TURN_2, CHILD_TURN_3], start=1):
            self.engine.observe_turn(student_id=self.student_id, turn=index, text=text)
        raw = student_learning_db_path(self.tmp, self.student_id).read_bytes()
        for fragment in ("我家的小猫", "小猫很可爱", "认成小狗", "再讲一遍好不好"):
            self.assertNotIn(fragment.encode("utf-8"), raw, f"库文件里不该出现原话片段：{fragment}")
        for row in self.rows("SELECT raw FROM grade_signals"):
            self.assertNotIn("我家的小猫", str(row["raw"]))
            self.assertIn("|", str(row["raw"]), "raw 里只该有轮次锚点 + 词表命中项")

    def test_advanced_terminology_moves_up_one_level_only(self) -> None:
        for index, text in enumerate([CHILD_TURN_1, CHILD_TURN_2, CHILD_TURN_3], start=1):
            self.engine.observe_turn(student_id=self.student_id, turn=index, text=text)
        self.assertEqual(self.engine.current_level(self.student_id), "primary_low")

        # 第 4、5 轮：高中味道的提问刚出现，**连续轮数**还不够（旧的向下轮打断了它）
        for turn in (4, 5):
            decision = self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text=ADVANCED_TURN_1
            )
            self.assertEqual(decision.decision.reason, REASON_NO_DIRECTION, f"第 {turn} 轮")
            self.assertEqual(decision.decision.direction, 1, "方向已经朝上，只是轮数不够")

        # 第 6、7 轮：连续 3 轮朝上，证据够格 —— 但冷却期（3 + 5 = 8）还没过
        for turn in (6, 7):
            decision = self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text=ADVANCED_TURN_1
            )
            self.assertEqual(decision.decision.reason, REASON_COOLDOWN, f"第 {turn} 轮应当被冷却挡住")
            self.assertFalse(decision.changed)
            self.assertEqual(self.engine.current_level(self.student_id), "primary_low")

        # 第 8 轮：冷却期满 → 只上调 **一级**（证据是 senior，也只到 primary_high）
        final = self.engine.observe_turn(
            student_id=self.student_id,
            turn=8,
            text=ADVANCED_TURN_1,
            proposal=GradeProposal("senior", 0.9),
        )
        self.assertTrue(final.changed)
        self.assertEqual(final.decision.target_level, "primary_high")
        self.assertAlmostEqual(final.decision.confidence, 0.9, "第二层同向时抬高置信度")
        self.assertAlmostEqual(final.decision.rule_confidence, 0.9, "规则置信度封顶 0.9")

        trail = [
            (row["turn"], row["from_level"], row["to_level"])
            for row in self.rows("SELECT turn, from_level, to_level FROM grade_history ORDER BY id")
        ]
        self.assertEqual(
            trail,
            [(0, None, "primary_high"), (3, "primary_high", "primary_low"), (8, "primary_low", "primary_high")],
        )

    def test_state_survives_reopening_the_database(self) -> None:
        for index, text in enumerate([CHILD_TURN_1, CHILD_TURN_2, CHILD_TURN_3], start=1):
            self.engine.observe_turn(student_id=self.student_id, turn=index, text=text)
        self.store.close()

        reopened = LearningStore(student_learning_db_path(self.tmp, self.student_id))
        self.addCleanup(reopened.close)
        restarted = GradeEngine(reopened)
        self.assertEqual(restarted.current_level(self.student_id), "primary_low", "重启后学段仍在")
        self.assertEqual(restarted.state(self.student_id).last_change_turn, 3)
        self.assertGreater(restarted.state(self.student_id).cooldown_remaining, 0)

    def test_suggested_level_is_exposed_while_blocked_by_cooldown(self) -> None:
        for index, text in enumerate([CHILD_TURN_1, CHILD_TURN_2, CHILD_TURN_3], start=1):
            self.engine.observe_turn(student_id=self.student_id, turn=index, text=text)
        for turn in (4, 5, 6):
            self.engine.observe_turn(student_id=self.student_id, turn=turn, text=ADVANCED_TURN_1)
        state = self.engine.state(self.student_id)
        self.assertEqual(state.direction, 1, "现在证据朝上")
        self.assertEqual(state.streak, 3)
        self.assertEqual(state.suggested_level, "primary_high", "够格但被冷却挡住 → 给出待生效学段")
        self.assertGreater(state.cooldown_remaining, 0)

    def test_recent_signals_are_returned_as_contract_models(self) -> None:
        self.engine.observe_turn(student_id=self.student_id, turn=1, text=CHILD_TURN_1)
        signals = self.engine.recent_signals()
        self.assertTrue(signals)
        self.assertIsInstance(signals[0], GradeSignal)
        self.assertTrue(any(signal.value != 0.0 for signal in signals))

    def test_quiz_history_in_the_database_drives_the_quiz_signal(self) -> None:
        """★ 答题表现**从 learning.db 读**（票 14/15 写进去的答题记录），桌面端不用上交。"""
        summary = quiz_performance_from_history(self.store)
        self.assertEqual((summary.attempts, summary.current_streak), (0, 0), "没有记录 → 没有信号")

        for correct in (True, True, True):
            self.store.add_history(kp_id="jr-ai-what", activity="quiz", is_correct=correct)
        summary = quiz_performance_from_history(self.store)
        self.assertEqual((summary.attempts, summary.correct, summary.current_streak), (3, 3, 3))

        # 连续 3 轮答题（每轮都带着「连对 3」这同一份库内证据）→ 上调一级
        for turn in (1, 2, 3):
            decision = self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text="我做完了"
            )
            kinds = {reading.signal_type for reading in decision.readings if reading.has_evidence}
            self.assertIn("quiz_perf", kinds)
        self.assertEqual(self.engine.current_level(self.student_id), "junior")

        # 连错两题后再来一轮 → 下调（连错 ≥2）
        self.store.add_history(kp_id="jr-ai-what", activity="quiz", is_correct=False)
        self.store.add_history(kp_id="jr-ai-what", activity="quiz", is_correct=False)
        self.assertEqual(quiz_performance_from_history(self.store).current_streak, -2)


# --------------------------------------------------------------------------- #
# ④ HTTP 端点
# --------------------------------------------------------------------------- #
class TestGradeRoutes(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config(token=TOKEN, data_dir=self.tmp))
        self.app.include_router(grade_router)  # main.py 维护者登记前，先显式挂载
        self.client = TestClient(self.app)
        self.client.headers.update({"X-Auth-Token": TOKEN})
        self.student_id = "student_001"

    def submit(self, *turns: dict) -> object:
        return self.client.post(f"/api/grade/turns/{self.student_id}", json={"turns": list(turns)})

    def test_state_and_signals_are_camel_case(self) -> None:
        state = self.client.get(f"/api/grade/state/{self.student_id}")
        self.assertEqual(state.status_code, 200, state.text)
        body = state.json()
        self.assertEqual(body["grade"], "primary_high")
        self.assertEqual(body["source"], "inferred")
        self.assertIn("cooldownRemainingTurns", body)
        self.assertIn("lastChangeTurn", body)

        signals = self.client.get(f"/api/grade/signals/{self.student_id}")
        self.assertEqual(signals.status_code, 200, signals.text)
        payload = signals.json()
        self.assertEqual(payload["currentLevel"], "primary_high")
        self.assertEqual(payload["signals"], [])
        self.assertIsNone(payload["suggestedLevel"])

    def test_batch_of_turns_changes_grade_and_returns_evaluations(self) -> None:
        response = self.submit(
            {"turn": 1, "text": CHILD_TURN_1, "sessionId": "sess-1"},
            {"turn": 2, "text": CHILD_TURN_2, "sessionId": "sess-1"},
            {
                "turn": 3,
                "text": CHILD_TURN_3,
                "sessionId": "sess-1",
                "proposal": {"suggestedGrade": "primary_low", "confidence": 0.72},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["previousGrade"], "primary_high")
        self.assertEqual(body["grade"], "primary_low")
        self.assertEqual(body["reason"], "changed")
        self.assertEqual(body["source"], "inferred")
        self.assertEqual(body["turn"], 3)
        self.assertEqual([item["reason"] for item in body["evaluations"]], ["no_direction", "no_direction", "changed"])
        self.assertGreaterEqual(len(body["signals"]), 3)
        for signal in body["signals"]:
            self.assertIn(signal["signalType"], ("vocab", "depth", "quiz_perf", "meta_cognition"))

        history = self.client.get(f"/api/grade/history/{self.student_id}").json()
        self.assertEqual(history["currentLevel"], "primary_low")
        changes = [entry for entry in history["entries"] if entry["fromLevel"]]
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["source"], "inferred")
        self.assertEqual(changes[0]["toLevel"], "primary_low")

    def test_layer2_missing_is_visible_in_the_response(self) -> None:
        response = self.submit({"turn": 3, "text": CHILD_TURN_3})
        body = response.json()
        self.assertEqual(body["degraded"], "no_llm")
        self.assertIsNone(body["llmConfidence"])

    def test_quiz_performance_drives_the_signal(self) -> None:
        response = self.submit(
            {"turn": 1, "text": "我做完了", "quiz": {"attempts": 5, "correct": 5, "currentStreak": 4}}
        )
        body = response.json()
        kinds = [signal["signalType"] for signal in body["signals"]]
        self.assertIn("quiz_perf", kinds)
        quiz_signal = next(signal for signal in body["signals"] if signal["signalType"] == "quiz_perf")
        self.assertGreater(quiz_signal["value"], 0)

    def test_auth_is_required(self) -> None:
        anonymous = TestClient(self.app)
        self.assertEqual(anonymous.get(f"/api/grade/state/{self.student_id}").status_code, 401)

    def test_bad_student_id_is_rejected(self) -> None:
        response = self.client.get("/api/grade/state/..%2Fetc")
        self.assertIn(response.status_code, (404, 422))

    def test_unknown_field_is_rejected_by_contract(self) -> None:
        response = self.client.post(
            f"/api/grade/turns/{self.student_id}",
            json={"turns": [{"turn": 1, "text": "你好", "transcript": "整段对话正文"}]},
        )
        self.assertEqual(response.status_code, 422, "契约 extra=forbid：不许夹带对话正文")

    def test_empty_batch_is_rejected(self) -> None:
        self.assertEqual(self.submit().status_code, 422)

    def test_signals_endpoint_reports_a_readable_503_when_the_table_is_gone(self) -> None:
        """库被外力删表 → 503 可读错误，而不是 500 堆栈（上层会把它转成 error 事件）。"""
        path = student_learning_db_path(self.tmp, self.student_id)
        self.client.get(f"/api/grade/state/{self.student_id}")  # 先建库
        conn = sqlite3.connect(path)
        conn.execute("DROP TABLE grade_signals")
        conn.commit()
        conn.close()
        response = self.client.get(f"/api/grade/signals/{self.student_id}")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("本地数据库异常", response.json()["detail"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main(verbosity=2)
