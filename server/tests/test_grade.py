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
6. ★ **2026-09-17 修复回归**（见 ``architecture/review-2026-09-17.md`` 的 D1/D2/D3/D8）：
   课堂用语不再产生下调信号、概念提问不误判成推导档、冷却期不被跨会话拉长、
   ``DECISION_ORDER`` 与实现顺序一致。
7. ★ **2026-09-19 修复回归**（见 ``architecture/review-2026-09-19.md`` 的 H-1 / M-10）：
   冷却锚点 ``(turn, source)`` 必须来自 ``grade_history`` 的**同一行**
   （``test_h1_*``）、**每一轮至少留一行读数**，使「连续 3 轮同向」真的是连续
   （``test_m10_*``）。

跑法::

    cd server && uv run python -m unittest tests.test_grade -v
"""

from __future__ import annotations

import re
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
    DECIDED_BY_LLM,
    DECIDED_BY_RULES,
    COOLDOWN_TURNS,
    DECISION_ORDER,
    DEGRADED_NO_LLM,
    LAYER2_FIRST_TURN,
    LAYER2_RETRY_TURN,
    MANUAL_COOLDOWN_TURNS,
    MAX_STEP_LEVELS,
    NO_EVIDENCE_RAW,
    REASON_AT_BOUNDARY,
    REASON_CHANGED,
    REASON_COOLDOWN,
    REASON_LLM_CONFLICT,
    REASON_LOW_CONFIDENCE,
    REASON_NO_DIRECTION,
    RECENT_SIGNAL_ROWS,
    SIGNALS_REQUIRED_FOR_CHANGE,
    SOURCE_EXPLICIT,
    SOURCE_INFERRED,
    GradeEngine,
    GradeProposal,
    TurnVerdict,
    decide,
)
from app.grade import rules as rules_module  # noqa: E402
from app.grade.signals import (  # noqa: E402
    DEFAULT_QUESTION_LEVEL,
    MIN_QUESTION_CONTENT_CHARS,
    SIGNAL_TYPES,
    classify_depth,
    consecutive_same_direction,
    decode_turn_raw,
    encode_turn_raw,
    extract_depth_signal,
    extract_meta_cognition_signal,
    extract_turn_signals,
    extract_vocab_signal,
    has_question_content,
)
from app.main import create_app  # noqa: E402
from app.routes.grade import router as grade_router  # noqa: E402
from app.routes.students import open_learning_store, student_learning_db_path  # noqa: E402
from app.store.learning import LearningStore  # noqa: E402

TOKEN = "test-token-grade"

#: ``app/grade/rules.py`` 的源码（只用于 D8 那条「常量与实现顺序一致」的结构断言）。
RULES_SOURCE = (ROOT / "app" / "grade" / "rules.py").read_text(encoding="utf-8")

#: 学生原话（测试专属的句子，便于在整库字节里搜「有没有被写进 SQLite」）。
#:
#: ★★ 2026-09-21 重定义：三句**真实的受挫表达**。
#: 原先这三句是「童言 + 日常口语」（小猫 / 电脑 / 图片）—— 靠「日常口语 → 下调」
#: 和「问得浅 → 下调」凑出三路向下的证据。那两条已改成**只上不下**
#: （问得浅 / 用词日常都不是「学段低」的证据），所以向下的够格证据现在只能来自
#: **元认知**（「听不懂 / 太难了 / 跟不上」）—— 这恰好也是执行文档 §10.3
#: 写的那条演示：「连说『听不懂』三轮 → 自动下调一级」。
CHILD_TURN_1 = "我有点听不明白，能再讲一遍吗？"
CHILD_TURN_2 = "这个我真的听不懂，太难了。"
CHILD_TURN_3 = "我还是跟不上，讲慢一点好吗？"

#: 只命中**日常口语**、不含任何深度词或受挫表达的句子。
#: 用来验证「日常口语是中性证据」：仍然落库（``has_evidence`` 为真），但方向为 0。
DAILY_TERM_TURN = "我家的小猫很可爱，电脑是怎么认图片的呀？"

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

    def test_vocab_daily_terms_are_neutral_at_higher_grades(self) -> None:
        """★ 回归（2026-09-21）：日常口语**不再下调** —— 它只是一条中性证据。

        修复前这里断言 ``value == -0.5``：命中 ``DAILY_TERMS`` 即产生一条到
        ``primary_low`` 的下调。可这些词（电脑 / 图片 / 小猫）在四个学段的教材里
        到处都是，初、高中生聊「机器人」连提三轮就够「连续 3 轮同向 + 0.75 ≥ 0.6」，
        把学段降级。**用词日常 ≠ 学段低**。

        ⚠️ 注意读数是**按当前学段**算的：对 ``primary_low`` 的学生，这个档位与他
        **同档** → 本来也是 0。所以这条断言对四个学段都成立。
        """
        reading = extract_vocab_signal(DAILY_TERM_TURN, "primary_high")
        self.assertEqual(reading.level_hint, "primary_low", "档位信息保留（可审计）")
        self.assertEqual(reading.value, 0.0, "日常用语不再产生下调")
        self.assertTrue(reading.has_evidence, "仍然是一条证据（要落库）")
        self.assertIn("口语=", reading.raw)

    def test_vocab_term_at_current_level_is_neutral_but_recorded(self) -> None:
        """同档术语 → 方向 0，但仍算证据（要落库）。

        ★ 学段跟着**术语表**走，不是写死的：接入 K12KnowledgeBase 后
          ``terminology.json`` 按正文实际位置重建下限，``机器学习`` 的 ``min_grade``
          由 junior 下调到 primary_low（见 ``scripts/import_knowledge.py`` 的
          ``build_terminology()``）。「同档」的判定必须取**表里的当前值**，
          否则这条用例测的就不再是「同档」，而是「低一档」（那会得到 -1.0，
          覆盖不到本用例要盯的『值为 0 但 has_evidence 为真』）。
        """
        from app.grade.signals import default_terminology

        min_grade = next(
            entry["min_grade"]
            for entry in default_terminology()["terms"]
            if entry["term"] == "机器学习"
        )
        reading = extract_vocab_signal("机器学习是什么", min_grade)
        self.assertEqual(reading.value, 0.0)
        self.assertEqual(reading.level_hint, min_grade)
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

    # ------------------------------------------------------------------ D3 --
    def test_d3_concept_questions_about_senior_topics_stay_in_the_concept_tier(self) -> None:
        """★ D3 回归：「什么是 X」是**概念**提问，不因为 X 是高中词就变成推导档。

        修复前：``classify_depth('什么是公式') == 'senior'``（``DEPTH_LEVELS`` 里 senior 排第一、
        取首个命中，于是「公式」压过了「什么是」）→ 对初中生是一条
        ``0.5 × 1.5 = 0.75 ≥ 0.6`` 的**上调**证据，三路同向就能把学段推上去。
        对照组 ``什么是循环`` 落 primary_high，说明这是词表优先级问题而不是句式失效 ——
        同一句式不该有两种档位。
        """
        self.assertEqual(classify_depth("什么是公式"), DEFAULT_QUESTION_LEVEL)
        self.assertEqual(classify_depth("什么是矩阵"), DEFAULT_QUESTION_LEVEL)
        self.assertEqual(classify_depth("什么是循环"), DEFAULT_QUESTION_LEVEL)
        self.assertEqual(classify_depth("矩阵是什么"), DEFAULT_QUESTION_LEVEL)
        self.assertEqual(classify_depth("什么是概率分布"), DEFAULT_QUESTION_LEVEL)
        # 三条样本的**字面档位**断言（修复前全部是 senior）
        for text in ("什么是公式", "什么是矩阵", "什么是循环"):
            self.assertEqual(
                extract_depth_signal(text, "junior").level_hint,
                DEFAULT_QUESTION_LEVEL,
                f"{text!r} 不该被判成推导档",
            )

    def test_d3_derivation_framing_still_wins(self) -> None:
        """反向口径不变：真的在问推导/证明，仍然落推导档（别把 D3 修过头）。"""
        self.assertEqual(classify_depth("链式法则怎么推导"), "senior")
        self.assertEqual(classify_depth("正则化怎么证明能防止过拟合"), "senior")
        self.assertEqual(classify_depth("神经网络的工作原理是什么"), "junior")

    def test_d3_topic_terms_still_raise_the_tier_without_a_framing_word(self) -> None:
        """没有框架词时，高中主题术语照旧兜底（陈述句也算深度表述）。"""
        self.assertEqual(classify_depth("梯度和矩阵的关系"), "senior")
        self.assertEqual(classify_depth("公式和矩阵的关系"), "senior")

    # ------------------------------------------------------------------ D2 --
    def test_d2_classroom_phrases_produce_no_signal(self) -> None:
        """★ D2 回归：课堂用语（「我们开始吧」「好呀」「继续吧」）不得产生任何深度信号。

        修复前：``classify_depth('我们开始吧') == 'primary_high'``（「吧」在
        ``QUESTION_MARKERS`` 里 → 落默认档），``extract_depth_signal('我们开始吧','junior')``
        返回 ``value=-0.5`` —— 每轮一条**下调**信号。初中/高中生每说一句「继续吧」
        就累积一次，三五轮纯语气词就能触发真实的学段下移，而 D-020 之后
        **没有人工纠正出口**：代价不对称。
        """
        phrases = ("好呀", "继续吧", "我们开始吧", "可以吗", "那我们做一道题吧", "现在开始上课吧")
        for text in phrases:
            with self.subTest(text=text):
                self.assertIsNone(classify_depth(text), "课堂用语不是提问")
                reading = extract_depth_signal(text, "junior")
                self.assertFalse(reading.has_evidence, f"{text!r} 不该产生深度证据")
                self.assertEqual(reading.value, 0.0, f"{text!r} 不该产生下调信号")
        # 整轮聚合：三句课堂用语连续上交，不该有任何方向（修复前是 −0.5×3）
        for index, text in enumerate(phrases[:3], start=1):
            signals = extract_turn_signals(text=text, turn=index, current_level="junior")
            self.assertEqual(signals.direction, 0, f"第 {index} 轮（{text!r}）方向必须是 0")

    def test_d2_real_questions_with_a_filler_word_still_count(self) -> None:
        """门槛只挡「剥完没有实词」的句子；带语气词的真问题照旧落默认档。"""
        self.assertEqual(classify_depth("电脑怎么认图片呀？"), DEFAULT_QUESTION_LEVEL)
        self.assertEqual(classify_depth("怎么认图片呢"), DEFAULT_QUESTION_LEVEL)
        self.assertTrue(has_question_content("电脑怎么认图片呀？"))
        self.assertFalse(has_question_content("我们开始吧"))

    def test_d2_information_threshold_is_the_declared_constant(self) -> None:
        """门槛是可读的具名常量，不是散在逻辑里的魔数。"""
        self.assertGreaterEqual(MIN_QUESTION_CONTENT_CHARS, 2, "太低等于没有门槛")
        self.assertLessEqual(MIN_QUESTION_CONTENT_CHARS, 8, "太高会漏掉真问题")

    # ------------------------------------------------- 只上不下（2026-09-21）--
    def test_depth_never_pulls_the_grade_down(self) -> None:
        """★ 回归：**问得浅不是「学段低」的证据** —— 深度信号只上不下。

        修复前：``classify_depth`` 返回**绝对档位**（``什么是X`` → ``primary_high``、
        普通疑问句兜底 → ``primary_high``），再对**当前学段**求差 —— 初中生问
        「什么是矩阵」就得到一条 ``-0.5``；连问三句（``0.5 × 3`` → 置信度 0.75 ≥ 0.6）
        就把学段**自动降级**。实测日志里那条
        ``第 [8] 轮 → primary_high（changed=True reason=changed 置信度=0.75 连续=4）``
        正是这种单路下调。

        而「任何学段的学生都会用『什么是…』问一个自己刚接触的概念」——
        那是好奇心的常态。下调由元认知那一路负责（它说的是「刚才讲深了」）。
        """
        for text in ("什么是矩阵", "什么是公式", "电脑怎么认图片呀？"):
            with self.subTest(text=text):
                # 对**比判出档位更高**的学生来说，这条证据一律是中性
                reading = extract_depth_signal(text, "junior")
                self.assertTrue(reading.has_evidence, "证据照记（要落库、要能审计）")
                self.assertEqual(
                    reading.value, 0.0, f"{text!r} 不该产生下调信号（只上不下）"
                )
                self.assertEqual(reading.level_hint, DEFAULT_QUESTION_LEVEL, "档位信息仍保留")

        # 整轮聚合：初中生连问三句「什么是 X」，方向必须是 0（不再凑出「连续 3 轮同向」）
        for index, text in enumerate(("什么是矩阵", "什么是公式", "什么是循环"), start=1):
            signals = extract_turn_signals(text=text, turn=index, current_level="junior")
            self.assertEqual(signals.direction, 0, f"第 {index} 轮（{text!r}）不许向下")

    def test_depth_still_raises_the_grade(self) -> None:
        """反向对照：**别把「只上不下」修成「什么都不做」** —— 向上照常。"""
        reading = extract_depth_signal("链式法则怎么推导", "junior")
        self.assertEqual(reading.level_hint, "senior")
        self.assertGreater(reading.value, 0, "真的在问推导，仍然上调")

    def test_daily_terms_are_neutral_not_downgrading(self) -> None:
        """★ 回归：**用词日常 ≠ 学段低** —— 日常口语只记证据、不下调。

        修复前：``DAILY_TERMS``（电脑 / 动画 / 图片 / 机器人 / 手机…）命中即产生
        一条到 ``primary_low`` 的 ``-0.5``。可这些词在**四个学段**的教材里都到处都是 ——
        初、高中生聊「机器人」很自然，连提三轮就凑够「连续 3 轮同向 + 0.75 ≥ 0.6」，
        把学段降级。这与深度信号是同一类错误。
        """
        reading = extract_vocab_signal(DAILY_TERM_TURN, "junior")
        self.assertTrue(reading.has_evidence, "证据照记（``口语=`` 仍写进 raw）")
        self.assertEqual(reading.value, 0.0, "日常用语不该产生下调")
        self.assertEqual(reading.level_hint, "primary_low", "档位信息仍保留")
        self.assertIn("口语=", reading.raw)

        signals = extract_turn_signals(text=DAILY_TERM_TURN, turn=1, current_level="junior")
        self.assertEqual(signals.direction, 0, "整轮方向为 0")

    def test_professional_terms_still_raise_the_grade(self) -> None:
        """反向对照：术语那一路照旧往上（只上不下**没有**顺手把它也废掉）。"""
        reading = extract_vocab_signal("梯度下降是怎么做到的", "primary_high")
        self.assertGreater(reading.value, 0)
        self.assertEqual(reading.level_hint, "senior")

    def test_struggle_words_are_the_only_downward_route(self) -> None:
        """向下的证据**只剩元认知**这一条路（这是「只上不下」的直接推论）。"""
        reading = extract_meta_cognition_signal("老师我真的听不懂", "junior")
        self.assertLess(reading.value, 0)
        self.assertIn("受挫=", reading.raw)
        # 而这三路对同一个学生都不向下
        for text in ("什么是循环", DAILY_TERM_TURN, "这道题怎么做呀"):
            with self.subTest(text=text):
                signals = extract_turn_signals(text=text, turn=1, current_level="junior")
                self.assertGreaterEqual(signals.total_value, 0.0, f"{text!r} 不该向下")

    def test_curiosity_words_are_not_struggle_signals(self) -> None:
        """★「举个例子」「详细一点」是**好奇心**，不是「听不懂」（2026-09-21 移除）。

        它们原先在 ``META_REPHRASE`` 里 → 产生下调。可「能举个例子吗」是听懂了、
        想更深一层；把它当受挫信号，会让**积极提问的学生被降级**，
        而且这类话在低学段尤其常见，方向恰好是反的。
        """
        for text in ("能举个例子吗", "详细一点好吗", "讲详细一点"):
            with self.subTest(text=text):
                reading = extract_meta_cognition_signal(text, "junior")
                self.assertEqual(reading.value, 0.0, f"{text!r} 不该产生下调")
                self.assertFalse(reading.has_evidence, f"{text!r} 不算受挫证据")

    def test_real_struggle_words_still_downgrade(self) -> None:
        """反向对照：真正表达受挫的词照旧下调（别把词表删秃了）。"""
        for text in ("我听不懂", "太难了", "讲慢一点好吗"):
            with self.subTest(text=text):
                self.assertLess(
                    extract_meta_cognition_signal(text, "junior").value,
                    0,
                    f"{text!r} 仍然是一条下调证据",
                )

    def test_conflicting_evidence_cancels_within_a_turn(self) -> None:
        """一轮里既有向上又有向下的证据 → 各自抵消（``TurnSignals.total_value`` 是求和）。

        ★ 「冲突时下调优先」那条规则原先属于**答题表现**那一路（它一次就能同时
        列出 up/down 两个理由）。那一路移除后，冲突发生在**不同路之间**，
        由聚合层的求和天然处理 —— 无需额外规则，但要钉住「同轮抵消」这个行为。
        """
        # 一句「什么是梯度下降」（深度向上 + 术语向上）叠加一句受挫表达 → 本轮仍有方向
        strong_up = extract_turn_signals(
            text="梯度下降怎么推导？", turn=1, current_level="primary_low"
        )
        self.assertGreater(strong_up.total_value, 0)
        # 受挫单独一句话：向下、强度恰好是单路的 0.5
        only_down = extract_turn_signals(
            text="我听不懂，太难了", turn=1, current_level="primary_high"
        )
        self.assertLess(only_down.total_value, 0)
        self.assertAlmostEqual(only_down.strength, 0.5, "单路证据 = 0.5")

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

    def test_turn_aggregates_three_classes(self) -> None:
        """一轮 → 三路读数（2026-09-21 起；「答题表现」那一路已移除）。

        ★ 移除理由见 ``signals.py`` 模块 docstring：它把「知识点没掌握」误当成
        「学段更低」，还会从对话原文里捡「太难了」与元认知**重复计数**
        （一句「太难了」曾同时产生两条 ``-0.5``、该轮强度直接封顶）。
        """
        signals = extract_turn_signals(text=CHILD_TURN_3, turn=3, current_level="primary_high")
        self.assertEqual(len(signals.readings), 3, "三路读数每轮都要有（哪怕没有证据）")
        self.assertEqual(signals.direction, -1)
        self.assertAlmostEqual(signals.strength, 0.5)
        self.assertEqual(
            {reading.signal_type for reading in signals.readings},
            {"vocab", "depth", "meta_cognition"},
            "信号词表恰好这三路（quiz_perf 已移除）",
        )
        self.assertNotIn(
            "quiz_perf",
            SIGNAL_TYPES,
            "不许把「答题表现」加回来 —— 见 signals.py 模块 docstring 的两条理由",
        )

    def test_same_turn_evidence_is_counted_once(self) -> None:
        """★ 一句话的受挫只算**一条**证据（原先「太难了」被元认知与答题各计一次）。

        ``TOO_HARD_TERMS`` 与 ``META_STRUGGLE`` 本来就重叠，而「答题表现」那一路
        **也会读学生原话**去找它们 —— 于是「太难了」一条话产生两条 ``-0.5``，
        该轮合并值顶到 ``-1.0``（强度封顶），三句就能推得更狠。
        移除那一路之后，该轮强度必须回到单路的 ``0.5``。
        """
        signals = extract_turn_signals(
            text="这个我真的听不懂，太难了。", turn=1, current_level="primary_high"
        )
        self.assertAlmostEqual(
            signals.strength, 0.5, "单路证据 = 0.5（不是被重复计到 1.0）"
        )
        struggle_routes = [r for r in signals.readings if r.value < 0]
        self.assertEqual(len(struggle_routes), 1, "只有元认知那一路向下")

    def test_raw_never_contains_the_students_sentence(self) -> None:
        signals = extract_turn_signals(text=DAILY_TERM_TURN, turn=1, current_level="primary_high")
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
                current_level="primary_low", turn=turn, verdicts=self.up, anchor_turn=3
            )
            self.assertFalse(blocked.changed, f"第 {turn} 轮（冷却期内）不该改")
            self.assertEqual(blocked.reason, REASON_COOLDOWN)
            self.assertGreater(blocked.cooldown_remaining, 0)

        allowed = decide(current_level="primary_low", turn=8, verdicts=self.up, anchor_turn=3)
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

    # ------------------------------------------------------------------ D1 --
    def test_d1_cooldown_is_measured_in_real_turns_not_turn_numbers(self) -> None:
        """★★ D1 的真正修复（2026-09-21）：冷却按**真实发生的轮数**算。

        缺陷现场：``elapsed = turn - anchor_turn`` 是拿**两个不同轮次空间**的数相减 ——
        ``turn`` 是每会话计数器（换会话从 1 重来），锚点却是上一会话写进库里的号。
        新会话里 ``turn``（1、2、3…）常小于 ``anchor_turn``（两位数），钳到 0 之后
        ``remaining`` **恒等于整个窗口**，冷却成了**一把永不释放的锁**。

        实测（``logs/sidecar.log`` 5 天）：450 次判定里 ``reason=cooldown`` **226 次（50%）**，
        其中 ``连续=4 / 置信度 0.90`` 的**达标证据**照样不生效；锚点 ``turn=22`` 让随后
        每个会话的第 1–8 轮全部卡死 —— 唯一出路是**在同一个会话里聊到第 23 轮**
        （实测会话上限 8 轮）。学生端表现是「学段永远不跟着我调」。

        现在 ``elapsed_turns`` 数的是**真实轮数**（跨会话连续累计）：
        锚点之后每走过一轮就减 1，走满窗口就放行 —— 与轮次号是多少无关。
        """
        # 锚点在第 3 轮：其后每多一轮，剩余冷却就少一
        for elapsed, expected in ((0, COOLDOWN_TURNS), (1, COOLDOWN_TURNS - 1), (4, 1)):
            with self.subTest(elapsed=elapsed):
                decision = decide(
                    current_level="primary_low",
                    turn=3 + elapsed,
                    verdicts=self.up,
                    elapsed_turns=elapsed,
                )
                self.assertEqual(
                    decision.cooldown_remaining,
                    expected,
                    f"锚点之后走过 {elapsed} 轮 → 剩 {expected}",
                )

        # 走满窗口 → 放行（这是「锁永不释放」的反面）；这次调整又开启一个新窗口
        released = decide(
            current_level="primary_low", turn=8, verdicts=self.up, elapsed_turns=COOLDOWN_TURNS
        )
        self.assertTrue(released.changed, "满 5 个真实轮次就该放行")
        self.assertEqual(released.cooldown_remaining, COOLDOWN_TURNS, "这次调整又开启新窗口")

    def test_d1_old_anchor_without_mark_falls_back_and_never_stretches(self) -> None:
        """兜底：历史锚点没有信号位标（v3 迁移前写入）→ 退回旧的轮次钳位。

        ★ 兜底的意义是「**不比修复前更糟**」：旧锚点最多再挡一个**窗口**，
        绝不会被跨会话拉长成 12 轮（那是修复前就有的症状，不能再回来）。
        """
        for turn in (1, 3, 7, 8):
            remaining = decide(
                current_level="primary_low",
                turn=turn,
                verdicts=self.up,
                anchor_turn=8,  # 没有 elapsed_turns → 走兜底
            ).cooldown_remaining
            with self.subTest(turn=turn):
                self.assertLessEqual(remaining, COOLDOWN_TURNS, "兜底也不许超过窗口")
                self.assertGreaterEqual(remaining, 0)

    def test_d1_cooldown_still_counts_down_after_the_change_turn(self) -> None:
        """正常方向不变：锚点之后第 1..4 轮仍在冷却、第 5 轮放行。"""
        for elapsed in (1, 4):
            blocked = decide(
                current_level="primary_low",
                turn=8 + elapsed,
                verdicts=self.up,
                elapsed_turns=elapsed,
            )
            self.assertEqual(blocked.reason, REASON_COOLDOWN, f"锚点后第 {elapsed} 轮")
            self.assertGreater(blocked.cooldown_remaining, 0)
        allowed = decide(
            current_level="primary_low", turn=13, verdicts=self.up, elapsed_turns=COOLDOWN_TURNS
        )
        self.assertTrue(allowed.changed, "走满 5 个真实轮次刚好满冷却")

    def test_h1_manual_window_reads_the_anchor_source_and_turn_from_one_row(self) -> None:
        """★ H-1（纯函数层）：窗口长度取自 ``anchor_source``、已过轮次取自 ``anchor_turn``。

        学生**显式确认当前学段**（``from_level == to_level`` 的 explicit 行）不改变学段，
        但它是冷却锚点：确认发生在第 12 轮 → 第 12..21 轮一律被冷却挡住、第 22 轮放行。
        修复前 ``observe_turn`` 把 ``turn`` 换成「上一次**真变更**的轮次」（第 3 轮）、
        ``source`` 却仍取「最近一次写入」（explicit）→ 第 12 轮就只剩 1 轮冷却，
        两个出口（``GET /grade/state`` 与 ``POST /grade/turns``）报出互相矛盾的数。
        """
        for turn in (12, 13, 21):
            blocked = decide(
                current_level="primary_low",
                turn=turn,
                verdicts=self.up,
                anchor_turn=12,
                anchor_source=SOURCE_EXPLICIT,
            )
            with self.subTest(turn=turn):
                self.assertEqual(blocked.reason, REASON_COOLDOWN, f"第 {turn} 轮仍在手动冷却内")
                self.assertGreater(blocked.cooldown_remaining, 0)
        self.assertEqual(
            decide(
                current_level="primary_low", turn=12, verdicts=self.up, anchor_turn=12,
                anchor_source=SOURCE_EXPLICIT,
            ).cooldown_remaining,
            MANUAL_COOLDOWN_TURNS,
            "确认的那一刻报一个完整的手动窗口（10 轮）",
        )
        released = decide(
            current_level="primary_low", turn=22, verdicts=self.up, anchor_turn=12,
            anchor_source=SOURCE_EXPLICIT,
        )
        self.assertTrue(released.changed, "第 12 + 10 = 22 轮刚好满冷却 → 自动推断重新接管")
        self.assertEqual(released.cooldown_remaining, COOLDOWN_TURNS, "放行后的这次改动是**自动**窗口")

        # 反向对照（P-053）：**同一个锚点轮次**，来源换成 inferred → 窗口只有 5 轮，
        # 第 17 轮（12 + 5）就放行，而第 13 轮仍在冷却。窗口长度确实来自 source，
        # 不是「一律 10 轮」也不是「一律 5 轮」——否则上面那条断言照不出问题。
        blocked_auto = decide(
            current_level="primary_low", turn=13, verdicts=self.up, anchor_turn=12,
            anchor_source=SOURCE_INFERRED,
        )
        self.assertEqual(blocked_auto.reason, REASON_COOLDOWN, "自动窗口下第 13 轮仍在冷却")
        released_auto = decide(
            current_level="primary_low", turn=17, verdicts=self.up, anchor_turn=12,
            anchor_source=SOURCE_INFERRED,
        )
        self.assertTrue(released_auto.changed, "自动窗口 5 轮：第 12 + 5 = 17 轮放行")

    # ------------------------------------------------------------------ D8 --
    def test_d8_decision_order_matches_the_implementation(self) -> None:
        """★ D8 回归：``DECISION_ORDER`` 必须与 :func:`decide` 里 ``outcome(...)`` 的顺序一致。

        修复前：常量写成 ``(no_direction, low_confidence, cooldown, at_boundary)`` ——
        **漏了 ``llm_conflict``**，且 ``llm_conflict`` 实际排在 ``low_confidence`` 之前。
        全仓没有任何代码或断言读它，所以漂移了也没人知道。
        这里直接读 ``rules.py`` 源码里的 ``return outcome(REASON_*, ...)`` 出现顺序来比对
        （比「再抄一份列表」更能挡住漂移：抄的那份照样会和实现一起漂）。
        """
        printed = [name for name in DECISION_ORDER]
        self.assertIn(REASON_LLM_CONFLICT, printed, "D8：常量漏了 llm_conflict")
        self.assertLess(
            printed.index(REASON_LLM_CONFLICT),
            printed.index(REASON_LOW_CONFIDENCE),
            "实现里 llm_conflict 排在 low_confidence 之前",
        )

        body = RULES_SOURCE.split("def decide(", 1)[1].split("\ndef ", 1)[0]
        # 源码里写的是常量名（``REASON_LLM_CONFLICT``）→ 用 rules 模块把它解析成字面值比对。
        #
        # ★★ 2026-09-21（D-066）起 ``decide()`` 有**两个分支**，它们的判定顺序**刻意不同**：
        #   - 【规则分支】：完整五条（这是 DECISION_ORDER 冻结的那份）；
        #   - 【LLM 分支】：**没有 ``llm_conflict``** —— 它本来就是对「LLM 只是提议」设计的
        #     （「提议与规则方向打架 → 否决」），而 LLM 分支里**提议就是方向**，没有可打架的对象。
        #   两个分支以源码里的锚点注释分界（``【LLM 分支】`` / ``【规则分支】``），
        #   各自的 ``outcome(...)`` 顺序都必须是 DECISION_ORDER 的子序列。
        llm_part, rules_part = body.split("【规则分支】", 1)

        def outcomes(source: str) -> list[str]:
            return [
                getattr(rules_module, name)
                for name in re.findall(r"return outcome\(\s*(REASON_[A-Z_]+)", source)
            ]

        # ① 规则分支：与冻结顺序**逐字一致**
        self.assertEqual(
            outcomes(rules_part),
            printed,
            "DECISION_ORDER 与 decide() 规则分支的检查顺序漂移了（报告与演示脚本按它解释现象）",
        )
        # ② LLM 分支：同序，但**不许**出现 llm_conflict（它没有「反向可否决」这回事）
        llm_actual = outcomes(llm_part)
        self.assertNotIn(
            REASON_LLM_CONFLICT, llm_actual, "LLM 分支不该有 llm_conflict —— 那条是为「提议可被否决」设计的"
        )
        self.assertEqual(
            llm_actual,
            [reason for reason in printed if reason != REASON_LLM_CONFLICT],
            "LLM 分支的判定顺序必须是 DECISION_ORDER 去掉 llm_conflict（其余相对顺序不变）",
        )

    def test_d8_conflict_still_beats_low_confidence_in_practice(self) -> None:
        """顺序不只是文档：**反向提议 + 规则置信度不足**时应报 ``llm_conflict``。"""
        weak = [TurnVerdict(turn=n, direction=1, strength=0.2) for n in (1, 2, 3)]
        decision = decide(
            current_level="primary_high",
            turn=3,
            verdicts=weak,
            proposal=GradeProposal("primary_low", 0.9),
        )
        self.assertEqual(decision.reason, REASON_LLM_CONFLICT)
        self.assertLess(decision.rule_confidence, CONFIDENCE_THRESHOLD, "规则这边本来就不够")

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
        """没提议时**默认**报降级（旧客户端不带状态时的兜底口径）。"""
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

    def test_degraded_reports_the_real_channel_status(self) -> None:
        """★★ 回归（2026-09-21）：``degraded`` 必须**诚实**报通道状态，不能一律说 ``no_llm``。

        缺陷现场：旧口径是「没提议 + 第 3 轮起 → ``no_llm``」，把
        ``already_proposed``（本窗口早就提过议了，一个窗口只判一次是**设计**）
        也报成「没有模型」。实测 436 次判定里 218 次被这么标，
        而 63 次第 3 轮判定里 **48 次真的带上了提议** —— 标注与实际相反，
        「学段信号双层判定」这条创新性叙事因此**拿不出可信证据**。

        现在由桌面端上报真实的 ``Layer2Status``，服务端只做归类。
        """
        # ① 真降级：没通道 / 调用失败 → 置位（这两个才是「第二层没工作」）
        for status in ("no_llm", "judge_error"):
            with self.subTest(status=status):
                decision = decide(
                    current_level="primary_high",
                    turn=5,
                    verdicts=self.down,
                    layer2_status=status,
                )
                self.assertEqual(decision.degraded, status)

        # ② ★★ 不是降级：这些状态描述的是「第二层工作正常」或「本来就还没到点」
        for status in ("used", "due", "retry", "already_proposed", "not_due", "insufficient_evidence"):
            with self.subTest(status=status):
                decision = decide(
                    current_level="primary_high",
                    turn=5,
                    verdicts=self.down,
                    layer2_status=status,
                )
                self.assertIsNone(
                    decision.degraded,
                    f"{status} 不是降级 —— 报成 no_llm 就是让标注说谎",
                )

        # ③ 桌面端报了什么就信什么：即便这一轮**带着提议**，报了 no_llm 也照实报
        #    （上游比我们更清楚通道状态；服务端不去猜）
        overt = decide(
            current_level="primary_high",
            turn=5,
            verdicts=self.down,
            proposal=GradeProposal("primary_low", 0.9),
            layer2_status="judge_error",
        )
        self.assertEqual(overt.degraded, "judge_error")

        # ④ 旧客户端（不带状态）退回老口径 —— 宁可多报，不要漏报降级
        legacy = decide(current_level="primary_high", turn=5, verdicts=self.down)
        self.assertEqual(legacy.degraded, DEGRADED_NO_LLM, "没带状态时保守报降级")

    # ------------------------------------------------- D-066（决策权移交）--
    def test_llm_decides_from_the_fifth_cumulative_turn(self) -> None:
        """★★ D-066：**累计第 5 轮起，LLM 的提议直接定方向**（不再只是提议）。

        这是 D-020「LLM 只是提议、反向即否决」那半条的**正面修订**（用户裁决）：
        前 4 轮由规则引擎全权判定（标签「本地规则判定」），第 5 轮起交给 LLM
        （标签「AI 引擎判定」），规则退居安全网。

        ★ 关键差别用**同一组输入**对照：规则方向向下、LLM 提议向上 ——
        第 4 轮报 `llm_conflict`（规则否决 LLM），第 5 轮 LLM 说了算（真的上调）。
        """
        # 规则方向向下（`self.down` 三句受挫表达），LLM 提议**向上**
        upward = GradeProposal("senior", 0.9)

        # ① 累计第 4 轮：还在规则的地盘 → LLM 的反向提议被**否决**
        before = decide(
            current_level="primary_high",
            turn=4,
            verdicts=self.down,
            proposal=upward,
            cumulative_turns=4,
        )
        self.assertFalse(before.changed, "前 4 轮规则说了算")
        self.assertEqual(before.reason, REASON_LLM_CONFLICT, "规则否决了 LLM 的反向提议")
        self.assertEqual(before.decided_by, DECIDED_BY_RULES)

        # ② 累计第 5 轮：LLM 接管 → **同一份提议**这次说了算（真的上调）
        after = decide(
            current_level="primary_high",
            turn=5,
            verdicts=self.down,
            proposal=upward,
            cumulative_turns=5,
        )
        self.assertTrue(after.changed, "第 5 轮起 LLM 直接定方向（同一份提议）")
        self.assertEqual(after.decided_by, DECIDED_BY_LLM)
        self.assertEqual(after.target_level, "junior", "一次最多动一级（即便提议 senior）")

    def test_rules_keep_three_safety_nets_when_llm_decides(self) -> None:
        """★★ 决策权移交后，**三条安全网仍在**（它们防的是「学段乱跳」，与「谁判」无关）：

        ④ 冷却期、⑤ ±1 级 / 到顶到底、以及 LLM 自报置信度 ≥ 0.6 的门槛。
        漏掉任何一条，LLM 就能把学段一次推两级、或在刚调完时立刻再调。
        """
        upward = GradeProposal("senior", 0.9)

        # ① 冷却期照常拦（锚点之后还没走满窗口）
        cooling = decide(
            current_level="primary_low",
            turn=6,
            verdicts=self.up,
            proposal=upward,
            cumulative_turns=9,
            anchor_source=SOURCE_INFERRED,
            elapsed_turns=1,
        )
        self.assertEqual(cooling.reason, REASON_COOLDOWN, "刚调整过 → 冷却期照常拦")
        self.assertEqual(cooling.decided_by, DECIDED_BY_LLM, "但这一轮确实是 LLM 在判")

        # ② ±1 级照常夹取：提议是 senior（比 primary_low 高两级），一次只动一级。
        #    ★ 注：`at_boundary` 在 LLM 分支里**结构上不可达** —— 方向是「提议相对当前学段」
        #    算出来的，再夹到 ±1；「到顶/到底而无可动」只会在方向为 0 时出现，
        #    而那种情况已由上面的 `llm_direction == 0 → no_direction` 提前返回。
        #    真正的边界情形属于**规则分支**（规则方向来自绝对档位，可能与当前学段同档）。
        stepped = decide(
            current_level="primary_low",
            turn=6,
            verdicts=self.down,
            proposal=upward,
            cumulative_turns=9,
        )
        self.assertTrue(stepped.changed)
        self.assertEqual(stepped.target_level, "primary_high", "±1 级：不一次跳到 senior")

        # ③ LLM 自报置信度 < 0.6 → 不动（判定 prompt 里就要求它「0.6 以上才算有把握」）
        unsure = decide(
            current_level="primary_low",
            turn=6,
            verdicts=self.down,
            proposal=GradeProposal("senior", 0.35),
            cumulative_turns=9,
        )
        self.assertEqual(unsure.reason, REASON_LOW_CONFIDENCE, "LLM 说自己没把握就别动")
        self.assertFalse(unsure.changed)

    def test_llm_says_same_grade_is_no_direction(self) -> None:
        """LLM 提议「还是这个学段」→ 没有方向，本轮不动（既不算降级也不算失败）。"""
        same = decide(
            current_level="primary_high",
            turn=6,
            verdicts=self.up,
            proposal=GradeProposal("primary_high", 0.9),
            cumulative_turns=9,
        )
        self.assertFalse(same.changed)
        self.assertEqual(same.reason, REASON_NO_DIRECTION)
        self.assertIsNone(same.degraded, "有提议就不算降级")

    def test_low_confidence_is_reported_before_cooldown(self) -> None:
        """判定顺序冻结：置信度不足 + 冷却期未过 → 报 ``low_confidence``。"""
        weak = [TurnVerdict(turn=n, direction=-1, strength=0.2) for n in (1, 2, 3)]
        decision = decide(current_level="primary_high", turn=4, verdicts=weak, anchor_turn=3)
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

    def seed_level(self, level: str) -> None:
        """把学生的**起点学段显式钉成** ``level``（不写 history、不留冷却锚点）。

        ★ 为什么测试要自己钉起点（2026-09-22 / D-073）：冷启动默认值会随产品决策变
          （由 ``primary_high`` 改成了 ``junior``），凡是「从 X 档动到 Y 档」的用例都依赖它。
          钉住起点之后，默认值再变也不会让这些用例跟着漂 —— 而「默认值是多少」由
          :meth:`TestEnginePersistence.test_cold_start_defaults_to_junior_with_baseline_row`
          与桌面的 ``grade-prompts.test.ts`` 各钉一次。
        """
        self.engine.ensure_student(self.student_id)  # 建行（含基线 history 行）
        self.store.conn.execute(
            "UPDATE student SET grade_level = ? WHERE student_id = ?", (level, self.student_id)
        )
        # ★ 基线那一行（`from_level IS NULL`）也要跟着改：否则「学生行说 primary_high、
        #   历史基线说 junior」自相矛盾，而 `state()` 的来源与报告都读后者。
        self.store.conn.execute(
            "UPDATE grade_history SET to_level = ? WHERE from_level IS NULL", (level,)
        )
        self.store.conn.commit()



class TestEnginePersistence(GradeEngineCase):
    def test_cold_start_defaults_to_junior_with_baseline_row(self) -> None:
        """★ 冷启动默认学段 = **初中**（2026-09-22 / D-073，原为小学高年级）。

        为什么改：四档里偏下的两档（小学低/高）与偏上的两档（初中/高中）讲法差别最大 ——
        从初中起步、判小了往下调一档只是讲得更细；而从小高起步去讲高中内容，
        学生会直接看不懂。桌面端的 `DEFAULT_GRADE_LEVEL` 由 `grade-prompts.test.ts` 钉住，
        两处必须一起改。
        """
        state = self.engine.state(self.student_id)
        self.assertEqual(state.grade_level, "junior", "冷启动默认初中（D-073）")
        self.assertEqual(state.source, SOURCE_INFERRED)
        self.assertEqual(state.cooldown_remaining, 0, "基线不是一次变更，不该产生冷却")

        rows = self.rows("SELECT turn, from_level, to_level, source, confidence FROM grade_history")
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["from_level"])
        self.assertEqual(rows[0]["to_level"], "junior")
        self.assertEqual(rows[0]["source"], SOURCE_INFERRED)

    def test_child_style_turns_lower_the_grade_at_the_third_turn(self) -> None:
        self.seed_level("primary_high")
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

    def test_cooldown_releases_across_sessions(self) -> None:
        """★★ 整条链路（本次修复的核心验收）：**换会话也要能走完冷却**。

        这是实测抓到的「活锁」现场。会话 A 第 3 轮受挫表达把学段下调一级之后，
        学生**换了一个会话**继续聊（桌面端的轮次号从 1 重来）：

        - 修复前：``elapsed = max(0, 1 - 3) = 0`` → ``remaining`` 恒等于整个窗口，
          每一轮都报 ``reason=cooldown``。**证据再够也不会生效** ——
          学生必须在一个会话里聊到第 23 轮才解的开（实测会话上限 8 轮）。
          实测 450 次判定里 226 次（50%）卡在这里。
        - 现在：冷却按**真实发生的轮数**算（跨会话连续累计），走满窗口就放行。
        """
        self.seed_level("primary_high")
        # 会话 A：第 1..3 轮受挫表达 → 第 3 轮自动下调一级
        for turn, text in enumerate((CHILD_TURN_1, CHILD_TURN_2, CHILD_TURN_3), start=1):
            self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text=text, session_id="sess-A"
            )
        self.assertEqual(self.engine.current_level(self.student_id), "primary_low", "第 3 轮改过")
        self.assertEqual(
            self.engine.state(self.student_id).cooldown_remaining,
            COOLDOWN_TURNS,
            "刚改过 → 一个完整窗口",
        )

        # 会话 B：轮次号从 1 重来。上交**向上**的够格证据（高中味道的提问）。
        # 冷却应当逐轮递减，并在走满窗口的那一轮真的放行 —— 这就是「活锁」的反面。
        seen: list[int] = []
        reasons: list[str] = []
        for turn in range(1, COOLDOWN_TURNS + 2):
            decision = self.engine.observe_turn(
                student_id=self.student_id,
                turn=turn,
                text=ADVANCED_TURN_1,
                session_id="sess-B",
            )
            seen.append(decision.decision.cooldown_remaining)
            reasons.append(decision.decision.reason)

        # 前两轮：还没攒够「连续 3 轮同向」（换会话后轮次重新开始，但**证据仍跨会话累计**）
        # 之后：证据够格，一律被冷却挡住 → 报 cooldown，直到走满窗口
        self.assertEqual(
            reasons[:2], [REASON_NO_DIRECTION, REASON_NO_DIRECTION], f"实际 {reasons}"
        )
        self.assertEqual(
            reasons[2:4], [REASON_COOLDOWN] * 2, f"证据够格后被冷却挡住；实际 {reasons}"
        )
        # 冷却逐轮递减（从 4 走到 1），这是「活锁」消失的直接证据
        self.assertEqual(seen[:4], [4, 3, 2, 1], f"冷却必须逐轮递减；实际 {seen}")
        # 第 5 轮：走满窗口 → 真的放行（报告的是一个**新**窗口）
        self.assertEqual(reasons[4], REASON_CHANGED, f"第 5 轮就该放行；实际 {reasons}")
        self.assertEqual(
            self.engine.current_level(self.student_id),
            "primary_high",
            "冷却期满 + 证据够格 → 学段真的动了（这才是「自适应」）",
        )
        # ★ 且**只动一级**：证据是高中味道的提问（差两级），单次最多动 1 级 —— 这是体验保护
        self.assertNotEqual(
            self.engine.current_level(self.student_id),
            "junior",
            "MAX_STEP_LEVELS=1：一次不能跨两级",
        )
        # ★ 两个出口报同一个数（H-1 的回声）
        self.assertEqual(
            self.engine.state(self.student_id).cooldown_remaining,
            seen[-1],
            "state() 与 observe_turn() 必须一致",
        )

    def test_decided_by_is_recorded_on_the_history_row(self) -> None:
        """★★ `decided_by` 必须**落进 ``grade_history``** —— 报告与界面标签都读它。

        两个轴各说各的：``source``（谁写的）+ ``decided_by``（哪一层判的）。
        报告叙事的价值就在这里：「第 3 轮**本地规则判定**为初中」与
        「第 12 轮**AI 引擎判定**为高中」是两种不同的证据。
        """
        # 前 3 轮只有规则 → 写的是 rules
        for turn in (1, 2, 3):
            self.engine.observe_turn(
                student_id=self.student_id,
                turn=turn,
                text=[CHILD_TURN_1, CHILD_TURN_2, CHILD_TURN_3][turn - 1],
                session_id="s",
            )
        rows = self.rows(
            "SELECT turn, source, decided_by FROM grade_history "
            "WHERE from_level IS NOT NULL ORDER BY id"
        )
        self.assertEqual(len(rows), 1, "第 3 轮改过一次")
        self.assertEqual(rows[0]["source"], SOURCE_INFERRED)
        self.assertEqual(rows[0]["decided_by"], DECIDED_BY_RULES, "前几轮是规则判的")

        # 走到累计第 5 轮之后，LLM 的提议改学段 → 那一行必须写 llm
        for turn in (4, 5):
            self.engine.observe_turn(
                student_id=self.student_id,
                turn=turn,
                text="梯度下降的链式法则怎么推导？",
                session_id="s",
                proposal=GradeProposal("primary_low", 0.9) if turn == 5 else None,
            )
        latest = self.rows(
            "SELECT turn, decided_by FROM grade_history "
            "WHERE from_level IS NOT NULL ORDER BY id DESC LIMIT 1"
        )[0]
        # 第 3 轮刚改过 → 冷却 5 轮，第 5 轮会被冷却挡住；所以这里断言的是
        # 「判定层被正确标出来」而不是「一定改了学段」。
        self.assertIn(
            latest["decided_by"],
            (DECIDED_BY_RULES, DECIDED_BY_LLM),
            "轨迹行必须带一个可读的判定层（不许为空）",
        )
        # ★ 而且 state() 报的判定层与轨迹行一致（同一行读出来，H-1 的纪律）
        self.assertEqual(self.engine.state(self.student_id).decided_by, latest["decided_by"])

    def test_cumulative_turns_counts_across_sessions(self) -> None:
        """★★ 累计轮次**跨会话**（D-066 的计数单位）—— 换会话不清零、同号不重复计。"""
        self.assertEqual(self.engine.cumulative_turns(), 0, "冷启动：一轮都没有")
        for turn in (1, 2):
            self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text=CHILD_TURN_1, session_id="sess-A"
            )
        self.assertEqual(self.engine.cumulative_turns(), 2)

        # 换个会话，轮次号从 1 重来 —— 累计数必须**接着涨**（不是归零、也不是被同号吞掉）
        self.engine.observe_turn(
            student_id=self.student_id, turn=1, text=CHILD_TURN_2, session_id="sess-B"
        )
        self.assertEqual(
            self.engine.cumulative_turns(), 3, "换会话不清零（换会话 ≠ 没聊过）"
        )

    def test_signals_are_written_per_class_with_turn_anchor(self) -> None:
        """每一路**各自**写一行（不是合并成一行），且 ``raw`` 带轮次锚点。"""
        self.engine.observe_turn(student_id=self.student_id, turn=1, text=DAILY_TERM_TURN, session_id="s")
        rows = self.rows("SELECT signal_type, value, raw, session_id FROM grade_signals ORDER BY id")
        self.assertGreaterEqual(len(rows), 2, "至少有词汇与深度两路读数")
        self.assertEqual({row["session_id"] for row in rows}, {"s"})
        for row in rows:
            self.assertTrue(str(row["raw"]).startswith("t1|"), "raw 必须带轮次锚点")
        kinds = {row["signal_type"] for row in rows}
        self.assertIn("vocab", kinds)
        self.assertIn("depth", kinds, "普通疑问句也落默认档（中性证据）")
        self.assertNotIn("meta_cognition", kinds, "这句里没有元认知表达，就不写这一路")

    def test_neutral_evidence_is_still_written(self) -> None:
        """★ 中性证据（值为 0）**照样落库** —— 它是「这一轮来过」的账本。

        「只上不下」把方向压成 0，但**不**把证据删掉：``raw`` 仍写着
        ``口语=…`` / ``深度=…``，所以报告与排障仍然看得见「模型读到了什么」。
        只有 ``raw`` 为空（真的什么都没命中）才走 M-10 的占位行。
        """
        self.engine.observe_turn(student_id=self.student_id, turn=1, text=DAILY_TERM_TURN, session_id="s")
        rows = self.rows("SELECT signal_type, value, raw FROM grade_signals ORDER BY id")
        vocab = next(row for row in rows if row["signal_type"] == "vocab")
        self.assertEqual(vocab["value"], 0.0, "方向被压成 0")
        self.assertIn("口语=", str(vocab["raw"]), "但证据摘要仍然写进 raw")
        self.assertNotIn(NO_EVIDENCE_RAW, str(vocab["raw"]), "不是占位行")

    # ------------------------------------------------------------------ M-10 --
    def test_m10_a_turn_without_evidence_still_leaves_exactly_one_neutral_reading(self) -> None:
        """★ M-10：四路全空的轮次也要留一行**中性读数**（否则这一轮在库里不存在）。

        第 1 轮童言（有证据）之后再来一轮「今天天气不错」（四路都没有命中）：
        断言它恰好留一行、值恒为 0、``raw`` 是那句可读的说明（不是学生原话），
        并且 :meth:`GradeEngine.verdicts` 读出来的这一轮方向是 0、强度是 0 ——
        即「这一轮来过，但它是中性轮」。
        """
        self.engine.observe_turn(student_id=self.student_id, turn=1, text=CHILD_TURN_1, session_id="s")
        before = len(self.rows("SELECT id FROM grade_signals"))
        self.engine.observe_turn(
            student_id=self.student_id, turn=2, text="今天天气不错", session_id="s"
        )
        rows = self.rows("SELECT signal_type, value, raw FROM grade_signals ORDER BY id")
        added = rows[before:]
        self.assertEqual(len(added), 1, "全无证据的轮次也要留**恰好一行**读数")
        self.assertEqual(added[0]["value"], 0.0, "占位读数的值恒为 0（不贡献方向也不贡献强度）")
        self.assertEqual(str(added[0]["raw"]), f"t2|{NO_EVIDENCE_RAW}", "raw 是轮次锚点 + 可读说明")
        self.assertNotIn("天气", str(added[0]["raw"]), "raw 里绝不放学生原话（合规）")

        verdicts = {verdict.turn: verdict for verdict in self.engine.verdicts()}
        self.assertIn(2, verdicts, "这一轮必须能被还原出来（否则连续计数会跨过去）")
        self.assertEqual(verdicts[2].direction, 0, "没有证据的轮次方向为 0")
        self.assertEqual(verdicts[2].strength, 0.0, "占位读数也不贡献任何强度")

    def test_m10_gap_turns_break_the_streak_instead_of_being_skipped(self) -> None:
        """★★ M-10 主断言：**三次隔着空白的同向证据**不许累成「连续 3 轮」。

        修复前：第 2..8 轮的「今天天气不错」四路全空 → 一行都不写 → 那一轮在
        ``grade_signals`` 里**不存在** → 第 1、9、10 轮的三条同向证据被当成连续三轮，
        学段当场被推走（实测就是这么发生的：中间隔了一周、还跨了会话）。

        修复后：第 2..8 轮各留一行中性读数 → 第 9 轮读到的连续只有 1、第 10 轮是 2，
        第 11 轮才够 3。★ 对照组是**同一批句子**在连续三轮里（第 11..13 轮）照样能改 —
        证明证据本身够格，是「空白轮不留痕」这一条在改结果。
        """
        self.seed_level("primary_high")
        self.engine.observe_turn(student_id=self.student_id, turn=1, text=CHILD_TURN_1, session_id="s")
        for turn in range(2, 9):
            decision = self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text="今天天气不错", session_id="s"
            )
            self.assertEqual(decision.decision.streak, 0, f"第 {turn} 轮是中性轮，连续必须断在这里")
            self.assertEqual(decision.decision.reason, REASON_NO_DIRECTION)

        # 第 9、10 轮：真正的连续只有 1、2 轮 —— 不够 3，学段纹丝不动
        reseed = [CHILD_TURN_2, CHILD_TURN_3]
        for offset, text in enumerate(reseed):
            turn = 9 + offset
            decision = self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text=text, session_id="s"
            )
            self.assertFalse(decision.changed, f"第 {turn} 轮：连续只有 {offset + 1} 轮，不该改")
            self.assertEqual(decision.decision.streak, offset + 1, "空白轮打断了连续，只能从 1 重新数")
        self.assertEqual(
            self.engine.current_level(self.student_id),
            "primary_high",
            "★ 第 1/9/10 轮的三条同向证据**不许**被当成「连续 3 轮」（修复前这里已经是 primary_low）",
        )

        # 对照组：再补第 11 轮（连续 3 轮）→ 立刻放行。同一批句子，差别只在有没有空白轮
        final = self.engine.observe_turn(
            student_id=self.student_id, turn=11, text=CHILD_TURN_1, session_id="s"
        )
        self.assertTrue(final.changed, "对照组：真正的连续 3 轮照样能改（证据本身是够格的）")
        self.assertEqual(final.decision.streak, SIGNALS_REQUIRED_FOR_CHANGE)
        self.assertEqual(self.engine.current_level(self.student_id), "primary_low")

    def test_m10_the_recent_signal_window_still_covers_the_decision_horizon(self) -> None:
        """M-10 的副作用检查：每轮多写一行**不许**把判定需要的轮次挤出读取窗口。

        最坏情况是一轮写满四路读数（4 行），所以窗口至少要容得下
        「手动冷却（10 轮）+ 连续窗口（3 轮）」这么多轮。
        """
        worst_case_per_turn = len(SIGNAL_TYPES)
        horizon = MANUAL_COOLDOWN_TURNS + SIGNALS_REQUIRED_FOR_CHANGE
        self.assertGreaterEqual(
            RECENT_SIGNAL_ROWS,
            worst_case_per_turn * horizon,
            f"{RECENT_SIGNAL_ROWS} 行不够覆盖 {horizon} 轮 × 每轮最多 {worst_case_per_turn} 行",
        )

    def test_m10_placeholder_rows_stay_out_of_the_evidence_list(self) -> None:
        """★ M-10 的展示侧对照：占位读数是**轮次账本**，不许冒充「证据」出现在界面上。

        它要是跟着 ``recent_signals()`` 回传，界面与学习报告上会冒出
        「词汇复杂度 · 本轮无证据」这种卡片，还会把真证据挤出那个 20 条的列表 ——
        而「无证据轮」正是 D2 之后的常态（课堂用语不许产生信号），几句「继续吧」就能刷空。
        """
        self.engine.observe_turn(student_id=self.student_id, turn=1, text=CHILD_TURN_1, session_id="s")
        for turn in (2, 3, 4):
            self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text="我们继续吧", session_id="s"
            )
        # 库里有 4 轮的行（第 2..4 轮是占位读数），但回传的证据只有第 1 轮那两路
        all_rows = self.rows("SELECT raw FROM grade_signals")
        self.assertGreaterEqual(len(all_rows), 4, "第 2..4 轮各留了一行占位读数")
        signals = self.engine.recent_signals()
        self.assertTrue(signals, "第 1 轮的真证据照常回传")
        for signal in signals:
            self.assertNotIn(NO_EVIDENCE_RAW, str(signal.raw), "占位读数不得出现在证据列表里")

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
        self.seed_level("primary_high")
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
        self.seed_level("primary_high")
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
        self.seed_level("primary_high")
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

    def test_quiz_records_no_longer_drive_the_grade(self) -> None:
        """★ 2026-09-21：**答题记录不再参与学段判定**（原「答题表现」那一路已移除）。

        反向对照旧行为：以前连对 3 题会连续 3 轮各产生一条 ``quiz_perf`` 上调，
        把学段推上去。现在答题再好也不动学段 —— 那是 ``mastery`` 该管的事
        （``MASTERY_GAIN_CORRECT`` 有独立机制），不是「你年级更高」。

        这条同时钉住「别把答题表现加回来」：``score`` 不再是判定输入。
        """
        for _ in range(3):
            self.store.add_history(kp_id="ai-definition-jr", activity="quiz", is_correct=True)
        before = self.engine.current_level(self.student_id)

        for turn in (1, 2, 3):
            decision = self.engine.observe_turn(
                student_id=self.student_id, turn=turn, text="我做完了"
            )
            kinds = {reading.signal_type for reading in decision.readings if reading.has_evidence}
            self.assertNotIn("quiz_perf", kinds, "答题表现不该再产生信号")
            self.assertFalse(
                any(reading.signal_type == "quiz_perf" for reading in decision.readings),
                "连读数里都不该有这一路",
            )

        self.assertEqual(
            self.engine.current_level(self.student_id),
            before,
            "答题记录（连对）不再改学段",
        )
        # 连错也一样：不再产生下调
        for _ in range(2):
            self.store.add_history(kp_id="ai-definition-jr", activity="quiz", is_correct=False)
        self.engine.observe_turn(student_id=self.student_id, turn=4, text="我做完了")
        self.assertEqual(self.engine.current_level(self.student_id), before, "连错也不改学段")

    # ------------------------------------------------------------------ D1 --
    def test_d1_verdicts_bucket_by_session_and_turn(self) -> None:
        """★ D1 ③ 回归：同号不同会话是**两次不同的交互**，不能求和成同一轮。

        修复前 ``verdicts()`` 只按 ``turn`` 分桶：会话 A 的第 1 轮（童言，−0.5）
        与会话 B 的第 1 轮（高中提问，+1.0）会相加成 ``+0.5`` —— 方向被平均、强度被叠加，
        而实际证据是「上一次交互在往下、这一次在往上」。
        """
        for text in (CHILD_TURN_1, CHILD_TURN_2):
            self.engine.observe_turn(
                student_id=self.student_id, turn=1, text=text, session_id="sess-A"
            )
        self.engine.observe_turn(
            student_id=self.student_id, turn=1, text=ADVANCED_TURN_1, session_id="sess-B"
        )

        rows = self.rows(
            "SELECT session_id, value FROM grade_signals WHERE raw LIKE 't1|%' ORDER BY id"
        )
        self.assertGreaterEqual(len(rows), 4, "两个会话各自的第 1 轮都要留下读数")

        verdicts = self.engine.verdicts()
        self.assertEqual(len(verdicts), 2, "同号不同会话要分成两轮，而不是求和成一桶")
        self.assertEqual([verdict.turn for verdict in verdicts], [1, 1])
        self.assertEqual(
            [verdict.direction for verdict in verdicts],
            [-1, 1],
            "各自的真实方向：会话 A 向下、会话 B 向上（修复前会被求和成一个方向）",
        )

    def test_d1_state_cooldown_is_capped_when_the_session_counter_restarts(self) -> None:
        """整条链路：上一会话在第 8 轮改过学段，新会话第 1 轮读状态 → 冷却 ≤ 5。"""
        for turn in range(1, 9):
            self.engine.observe_turn(
                student_id=self.student_id,
                turn=turn,
                text=CHILD_TURN_1,
                session_id="sess-A",
            )
        self.assertIsNotNone(self.engine.last_change_turn(), "第 3 轮就该改过一次学段")

        # 新会话：轮次号从 1 重来（桌面端的每会话计数器）
        self.engine.observe_turn(
            student_id=self.student_id, turn=1, text=ADVANCED_TURN_1, session_id="sess-B"
        )
        state = self.engine.state(self.student_id)
        self.assertLessEqual(
            state.cooldown_remaining,
            COOLDOWN_TURNS,
            "跨会话不得把冷却拉长到 COOLDOWN_TURNS 以上（修复前是 12）",
        )


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

    def seed_level(self, level: str) -> None:
        """路由级用例的起点学段（与 ``GradeEngineCase.seed_level`` 同一目的，见那里的说明）。

        直接经 ``open_learning_store`` 把学生行建出来并写好学段 —— **不写 history**，
        所以 ``state()`` 的 ``source`` 仍是 inferred（与冷启动一致）。
        """
        store = open_learning_store(self.tmp, self.student_id)
        try:
            store.upsert_student(self.student_id, nickname="", grade_level=level)
        finally:
            store.close()


    def test_state_and_signals_are_camel_case(self) -> None:
        self.seed_level("primary_high")
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
        self.seed_level("primary_high")
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

    def test_quiz_field_is_rejected_by_the_contract(self) -> None:
        """★ 契约层面**明确拒绝** ``quiz``（2026-09-21 起）。

        这条比「删掉提取器」更重要：``GradeTurnInput`` 是 ``extra="forbid"``，
        所以删掉字段之后老调用方会立刻拿到 422 —— **契约收下一个字段就等于承诺它参与判定**，
        现在它不参与了，就必须**响亮地**拒绝，而不是静默收下不用
        （静默收下会让人以为「我传了答题数据所以学段变了」）。
        """
        response = self.submit(
            {"turn": 1, "text": "我做完了", "quiz": {"attempts": 5, "correct": 5, "currentStreak": 4}}
        )
        self.assertEqual(response.status_code, 422, "带 quiz 的请求体必须被拒")
        # 不带 quiz 的老字段照常可用
        ok = self.submit({"turn": 1, "text": "梯度下降怎么推导？"})
        self.assertEqual(ok.status_code, 200, ok.text)
        kinds = [signal["signalType"] for signal in ok.json()["signals"]]
        self.assertNotIn("quiz_perf", kinds)
        self.assertTrue(kinds, "仍然有别的信号（词汇 / 深度）")

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

    def test_signals_endpoint_skips_unclassifiable_rows_instead_of_500(self) -> None:
        """★ P1-2：一行脏 ``signal_type`` 只让**那一行**被跳过，不能把整个读接口打成 500。

        实测现场就是这个形态：右栏「当前学段」正常（走 `/grade/state`，不读信号列表），
        而「学段」页签里的信号读取报 `读取失败（HTTP 500）：Internal Server Error` ——
        因为 `grade_signals.signal_type` 是宽松 TEXT，而契约 `GradeSignalType` 是收窄联合，
        构造 `GradeSignal` 时 pydantic 抛 `ValidationError`，它不是 `sqlite3.Error`，
        路由层的兜底拦不住。
        """
        path = student_learning_db_path(self.tmp, self.student_id)
        self.client.get(f"/api/grade/state/{self.student_id}")  # 先建库（冷启动）
        conn = sqlite3.connect(path)
        # ① 空串 ② NULL ③ 升级前写入的旧字面量 —— 三种都出现过
        conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) "
            "VALUES(1, 's', '', 0.2, 't1|术语=梯度(min_grade=senior)')"
        )
        conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) "
            "VALUES(2, 's', NULL, 0.2, 't2|x=1')"
        )
        conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) "
            "VALUES(3, 's', 'legacy_unknown', 0.2, 't3|y=1')"
        )
        # ④ 一行**正常**的证据：它必须照样回给前端（容错不能把好数据一起吃掉）
        conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) "
            "VALUES(4, 's', 'vocab', 0.5, 't4|术语=梯度下降(min_grade=senior)')"
        )
        conn.commit()
        conn.close()

        response = self.client.get(f"/api/grade/signals/{self.student_id}")
        self.assertEqual(response.status_code, 200, response.text)
        signals = response.json()["signals"]
        self.assertEqual([item["signalType"] for item in signals], ["vocab"], signals)


if __name__ == "__main__":  # pragma: no cover
    unittest.main(verbosity=2)
