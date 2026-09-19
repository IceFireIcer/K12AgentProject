# -*- coding: utf-8 -*-
"""学段**手动切换**（服务端部分）：契约 / 落库 / 更长冷却 / 平滑回归自动。

这一份测试盯住「手写路径与自动路径共用一套机制」里最容易出错的四类问题：

1. **契约形状**：``POST /api/grade/override/{student_id}`` 的入参只有学段、
   出参 camelCase 且 ``source`` 恒为 ``explicit``（``grade_history.source`` 当初就预留了这个取值）；
2. ★ **留痕**：每次手动设定都写一行 ``grade_history``，``confidence=1.0``、
   ``from_level`` 写切换前的值；**重复选同一学段也要写行**（``from_level == to_level``）
   —— 那一行不改变学段，但它是「学生确认过」的留痕，也是冷却期的锚点；
3. ★★ **冷却 10 轮**（本票核心验收）：手动改过之后，够格的自动证据也**动不了**学段，
   而**同一批证据**在没有手动改过的对照学生身上必须照常改 —— 反向对照证明
   「这组证据本身是够格的，冷却才是唯一挡住它的东西」；
4. **冷却随轮次递减** + **不引入新列**（``grade_history`` 的表结构里没有 ``note``）；
5. ★★ **2026-09-19 修复回归（H-1）**：冷却锚点 ``(turn, source)`` 必须来自 ``grade_history``
   的**同一行** —— ``observe_turn``（``POST /api/grade/turns``）与 ``state()``
   （``GET /api/grade/state``）**两个出口对同一状态给出同一个值**，
   且「重复确认同一学段」真的**重新计时**（``test_h1_*``）。
   ⚠️ 原来那条只读 ``state()`` 的断言是**假绿**：走对的那条路从来不报错，
   而真出问题的 ``observe_turn`` 一次都没被问过。

跑法::

    cd server && uv run python -m unittest tests.test_grade_override -v
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
from app.contracts import GradeSignals  # noqa: E402
from app.grade.rules import (  # noqa: E402
    COOLDOWN_TURNS,
    MANUAL_COOLDOWN_TURNS,
    REASON_COOLDOWN,
    SOURCE_EXPLICIT,
    SOURCE_INFERRED,
)
from app.main import create_app  # noqa: E402
from app.routes.grade import router as grade_router  # noqa: E402
from app.routes.students import student_learning_db_path  # noqa: E402

TOKEN = "test-token-grade-override"

#: 三句童言 → 三路同向（向下）的**够格证据**：连续 3 轮同方向、规则置信度 0.75 ≥ 0.6。
#: 与 ``tests/test_grade.py`` 用的是同一组句子（那边已验证它能在第 3 轮把学段调下去）。
CHILD_TURNS = (
    "我家的小猫很可爱，电脑是怎么认图片的呀？",
    "它会不会把我的小猫认成小狗呀？",
    "我有点听不明白，再讲一遍好不好？",
)

#: 四路全空的轮次（M-10 之后每轮也会留一行读数，但方向恒为 0）——
#: 用来把**轮次水位**推到指定轮次而不产生任何证据。
NEUTRAL_TEXT = "我们继续吧"

HISTORY_SQL = (
    "SELECT turn, from_level, to_level, source, confidence FROM grade_history ORDER BY id"
)


class GradeOverrideRoutes(unittest.TestCase):
    """带临时 data dir 与显式挂载 router 的路由级用例（不碰开发机的真实数据）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config(token=TOKEN, data_dir=self.tmp))
        self.app.include_router(grade_router)  # main.py 维护者登记前，先显式挂载
        self.client = TestClient(self.app)
        self.client.headers.update({"X-Auth-Token": TOKEN})
        self.student_id = "student_001"

    # ------------------------------------------------------------ 小工具 --
    def override(self, grade_level: str, student_id: str | None = None) -> object:
        return self.client.post(
            f"/api/grade/override/{student_id or self.student_id}",
            json={"gradeLevel": grade_level},
        )

    def advance_to(self, turn: int, *, session_id: str = "sess-1") -> None:
        """把**轮次水位**推到 ``turn`` 轮（上交若干轮中性证据，每轮都会留一行读数）。

        用途：真 HTTP 契约里 ``POST /grade/override`` **没有** turn 字段（锚点由服务端的
        ``turn_watermark()`` 推算，见 ``rules.GradeEngine.override_level``），而 H-1 的
        两条断言要的是「锚点落在第 N 轮」这个**受控前提**（真变更 @6 / 确认 @9 / 确认 @12）。
        所以先老老实实把水位推上去，再走真路由切换 —— 全链路都是客户端视角的真实路径。
        """
        current = int(self.state()["lastTurn"])
        for item in range(current + 1, turn + 1):
            response = self.submit(
                {"turn": item, "text": NEUTRAL_TEXT, "sessionId": session_id}
            )
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.state()["lastTurn"], turn, f"水位应当推到第 {turn} 轮")


    def submit(self, *turns: dict, student_id: str | None = None) -> object:
        return self.client.post(
            f"/api/grade/turns/{student_id or self.student_id}", json={"turns": list(turns)}
        )

    def child_evidence(self, *turn_numbers: int, session_id: str = "sess-1") -> list[dict]:
        """把童言按给定轮次包成上交格式（这三句本身就是够格证据）。"""
        return [
            {"turn": turn, "text": text, "sessionId": session_id}
            for turn, text in zip(turn_numbers, CHILD_TURNS)
        ]

    def child_evidence_upto(self, *, first: int, last: int, session_id: str) -> list[dict]:
        """一段**连续**的童言轮次（句子循环使用）：冷却期足够长时用来反复撞击它。"""
        return [
            {
                "turn": turn,
                "text": CHILD_TURNS[(turn - first) % len(CHILD_TURNS)],
                "sessionId": session_id,
            }
            for turn in range(first, last + 1)
        ]

    def state(self, student_id: str | None = None) -> dict:
        response = self.client.get(f"/api/grade/state/{student_id or self.student_id}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def signals(self, student_id: str | None = None) -> dict:
        response = self.client.get(f"/api/grade/signals/{student_id or self.student_id}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def history_rows(self, student_id: str | None = None) -> list[sqlite3.Row]:
        """直接读库（断言「真的落盘了」，而不是只信响应体）。"""
        path = student_learning_db_path(self.tmp, student_id or self.student_id)
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(HISTORY_SQL).fetchall()
        finally:
            conn.close()

    # ------------------------------------------------------------ ① 契约 --
    def test_override_returns_the_frozen_contract_shape(self) -> None:
        response = self.override("junior")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()

        # camelCase（前端统一口径）；字段名与 GradeOverrideResponse 一一对应
        self.assertEqual(
            sorted(body),
            sorted(
                [
                    "studentId",
                    "gradeLevel",
                    "previousLevel",
                    "source",
                    "changed",
                    "turn",
                    "cooldownRemainingTurns",
                ]
            ),
        )
        self.assertEqual(body["studentId"], self.student_id)
        self.assertEqual(body["gradeLevel"], "junior")
        self.assertEqual(body["previousLevel"], "primary_high", "冷启动默认小学高年级")
        self.assertTrue(body["changed"])
        self.assertEqual(body["source"], SOURCE_EXPLICIT)
        self.assertEqual(body["cooldownRemainingTurns"], MANUAL_COOLDOWN_TURNS)
        self.assertEqual(body["turn"], 0, "还没有任何信号 → 水位就是 0（冷启动）")

    def test_unknown_field_is_rejected_by_contract(self) -> None:
        """★ 刻意没有 note 字段：夹带说明文本一律 422（见 GradeOverrideRequest 的注释）。"""
        response = self.client.post(
            f"/api/grade/override/{self.student_id}",
            json={"gradeLevel": "junior", "note": "学生说自己想学初中内容"},
        )
        self.assertEqual(response.status_code, 422, "契约 extra=forbid：不许夹带写不进去的字段")

    def test_invalid_grade_level_is_rejected(self) -> None:
        response = self.override("college")
        self.assertEqual(response.status_code, 422, "四学段之外的字面量由 pydantic 挡下")

    # ------------------------------------------------------------ ② 落库 --
    def test_override_writes_an_explicit_row_with_the_previous_level(self) -> None:
        self.override("junior")
        rows = [row for row in self.history_rows() if row["source"] == SOURCE_EXPLICIT]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["from_level"], "primary_high", "from_level 写切换前的值")
        self.assertEqual(row["to_level"], "junior")
        self.assertEqual(row["confidence"], 1.0, "学生明确选择不是推断，不存在置信度")
        self.assertEqual(row["turn"], 0)

    def test_manual_override_does_not_write_grade_signals(self) -> None:
        """信号是**证据**，手动选择不是证据 —— 它不改写推断的原料。"""
        self.override("senior")
        conn = sqlite3.connect(student_learning_db_path(self.tmp, self.student_id))
        try:
            count = conn.execute("SELECT COUNT(*) FROM grade_signals").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(count, 0)

    # ------------------------------------------------------------ ③ 留痕 --
    def test_repeating_the_same_level_writes_a_row_but_is_not_a_change(self) -> None:
        """★ ``from_level == to_level`` 也要写行，而且**仍是冷却锚点**。

        学生重复选同一个学段不改学段，但那一行是「学生确认过」的留痕；
        更要紧的是冷却：如果这一行不被当作锚点，学生点两下就等于白点 ——
        冷却会退回上一次真正变更的位置，学生刚确认的意图立刻被自动推断推翻。

        这里刻意让两次「确认」发生在**不同的轮次水位**上（中间上交一轮）：
        锚点若认错了行，读出来的冷却会是 10 − 1 = 9 而不是 10。
        """
        self.override("junior")  # 水位 0
        self.submit({"turn": 1, "text": CHILD_TURNS[0], "sessionId": "sess-1"})  # 水位 → 1

        again = self.override("junior")
        self.assertEqual(again.status_code, 200, again.text)
        body = again.json()
        self.assertFalse(body["changed"], "还是同一个学段，不算变更")
        self.assertEqual(body["previousLevel"], "junior")
        self.assertEqual(body["turn"], 1, "锚点记在当下的轮次水位上")

        rows = [row for row in self.history_rows() if row["source"] == SOURCE_EXPLICIT]
        self.assertEqual(len(rows), 2, "重复选择也要留痕")
        self.assertEqual(rows[1]["from_level"], "junior")
        self.assertEqual(rows[1]["to_level"], "junior", "from_level == to_level 也要写")

        # ★ 关键断言：锚点是最新那一行（turn=1），不是上一次真正变更的那一行（turn=0）
        state = self.state()
        self.assertEqual(state["cooldownRemainingTurns"], MANUAL_COOLDOWN_TURNS)
        self.assertEqual(state["source"], SOURCE_EXPLICIT)

    # ------------------------------------------------------- ④ ★★ 冷却 --
    def test_h1_observe_turn_agrees_with_state_after_an_explicit_confirmation(self) -> None:
        """★★ H-1（本票核心验收的补充）：**两个出口必须对同一状态给出同一个冷却值**。

        缺陷现场：``observe_turn`` 把冷却锚点的一对 ``(turn, source)`` **拆成了两行** ——
        ``turn`` 取 ``last_change_turn()``（只认 ``from<>to`` 的真变更）、
        ``source`` 取 ``last_cooldown_anchor()``（认任何 ``from_level`` 非空的行）。
        于是「学生显式确认当前学段」（``from_level == to_level`` 的 explicit 行）
        虽然写进了 ``grade_history``，冷却却按**更早那次真变更的轮次**起算 → 当场过期：

        ====================  ==================  ====================
        场景                  ``GET /state``      ``POST /turns``
        ====================  ==================  ====================
        inferred 真变更 @3    10（手动窗口）      1  ← 两行不一致
        explicit 确认 @12     ——                  0（第 13 轮就放行）
        ====================  ==================  ====================

        这条**走 ``POST /api/grade/turns``**（``observe_turn`` 那条路）做反向对照，
        因为原来那条断言（``test_repeating_the_same_level_writes_a_row_but_is_not_a_change``）
        只读了走对的那条路的 ``state()`` —— 是**假绿**。
        """
        # 造出「真变更 @3」：第 1..3 轮童言本来就会在**第 3 轮**把学段调下去（自动路径）
        self.submit(*self.child_evidence(1, 2, 3))
        self.assertEqual(self.state()["grade"], "primary_low", "前提：自动路径在第 3 轮改过学段")
        self.assertEqual(self.state()["lastChangeTurn"], 3, "前提：真变更落在第 3 轮")

        # 推到第 12 轮，再显式**确认**当前学段（`from_level == to_level`）——
        # 这一行不改变学段，但它是冷却锚点，窗口从这里重新起算
        self.advance_to(12)
        override = self.override("primary_low")
        self.assertEqual(override.status_code, 200, override.text)
        self.assertFalse(override.json()["changed"], "确认现状：from_level == to_level")
        self.assertEqual(override.json()["turn"], 12, "锚点落在第 12 轮")
        self.assertEqual(
            self.state()["lastChangeTurn"], 3, "展示字段不变：真正变更过学段的仍是第 3 轮"
        )

        # ① 两个出口对同一状态给出**一致**的冷却值；② 时长按**手动窗口**从 12 起算
        #    ⚠️ 只用 21 及之前的轮次：第 22 轮是「冷却满期」那一格，留给下面那一步（它会推进水位）
        for turn in (13, 15, 19, 21):
            submitted = self.submit({"turn": turn, "text": NEUTRAL_TEXT, "sessionId": "sess-2"})
            self.assertEqual(submitted.status_code, 200, submitted.text)
            body = submitted.json()
            with self.subTest(turn=turn):
                self.assertEqual(
                    body["cooldownRemainingTurns"],
                    self.state()["cooldownRemainingTurns"],
                    f"第 {turn} 轮：POST /grade/turns 与 GET /grade/state 报的冷却必须一致（H-1）",
                )
                self.assertEqual(
                    body["cooldownRemainingTurns"],
                    max(0, MANUAL_COOLDOWN_TURNS - (turn - 12)),
                    f"第 {turn} 轮：手动窗口必须从**确认的那一刻（12）**起算 10 轮",
                )

        # ③ 冷却期内的**够格证据**照样改不动学段：第 13..21 轮（连续 9 轮同向）一次性上交，
        #    从第 3 轮起证据就够格了（方向一致、置信度 0.75 ≥ 0.6），挡住它的必须是**冷却**。
        batch = self.submit(*self.child_evidence_upto(first=13, last=21, session_id="sess-3"))
        self.assertEqual(batch.status_code, 200, batch.text)
        body = batch.json()
        self.assertFalse(body["changed"], "冷却期内不许改学段")
        self.assertEqual(
            [item["reason"] for item in body["evaluations"][2:]], [REASON_COOLDOWN] * 7,
            "第 15 轮起证据已连续 3 轮同向 → 拦住它的只能是冷却（前两轮是「轮数还不够」）",
        )
        self.assertEqual(self.state()["grade"], "primary_low", "整批上交后学段纹丝不动")
        self.assertEqual(
            body["cooldownRemainingTurns"], self.state()["cooldownRemainingTurns"],
            "整批上交之后两个出口仍然一致（第 21 轮 → 剩 1 轮）",
        )
        self.assertEqual(body["cooldownRemainingTurns"], 1)

        # ③-b ★ `state()` 这一侧的锚点也必须成对读（H-1 的另一半）：
        #    证据够格 + 被冷却挡住 → **待生效学段必须给出**（`suggested_level` 只在
        #    ``reason in (low_confidence, cooldown)`` 时才有值）。若 `state()` 拿「上一次
        #    真变更的轮次（3）」去算冷却，它算出来的剩余是 0 → 既不是 cooldown 也不是
        #    low_confidence → `suggestedLevel` 变 null，界面上「待生效：小学高年级」凭空消失。
        state = self.state()
        self.assertGreater(state["cooldownRemainingTurns"], 0, "此刻真的还在冷却里")
        self.assertEqual(state["streak"], 9, "证据已经连续 9 轮同向（够格）")
        self.assertEqual(
            state["suggestedLevel"], "primary_high",
            "够格但被**冷却**挡住 → 待生效学段必须给出（锚点取错行时这里会是 null）",
        )

        # ④ 第 22 轮 = 12 + 10：冷却刚好期满 → 自动推断重新接管（不是被永久停用）
        released = self.submit(
            {"turn": 22, "text": CHILD_TURNS[0], "sessionId": "sess-3"}
        )
        self.assertEqual(released.status_code, 200, released.text)
        self.assertEqual(
            released.json()["reason"], "changed", "第 22 轮冷却期满，够格证据即可生效"
        )
        self.assertEqual(released.json()["grade"], "primary_high")
        self.assertEqual(self.state()["source"], SOURCE_INFERRED, "回归自动后来源也切回去")

    def test_h1_repeating_the_same_level_restarts_the_cooldown_window(self) -> None:
        """★ H-1 的另一半：**重复选择同一学段 = 重新计时**（文档承诺原话）。

        真变更 @6（手动切到 junior）+ 再次确认 @9：冷却必须从 **9** 起算（@19 满期），
        而不是从 6 起算（@16 满期）。修复前 ``observe_turn`` 读的是 ``last_change_turn``
        （还是 6），所以「我再点一次」在**判定侧**等于白点 —— ``state()`` 那一侧是正确的，
        两个出口于是互相矛盾。
        """
        self.advance_to(6)
        override = self.override("junior")
        self.assertEqual(override.status_code, 200, override.text)
        self.assertTrue(override.json()["changed"], "第 6 轮：小学高年级 → 初中，真变更")
        self.assertEqual(override.json()["turn"], 6)

        # 确认之前：从 6 起算
        before = self.submit({"turn": 8, "text": NEUTRAL_TEXT, "sessionId": "sess-1"}).json()
        self.assertEqual(before["cooldownRemainingTurns"], MANUAL_COOLDOWN_TURNS - (8 - 6))

        # 学生**再点一次**同一个学段：不改学段，但重新计时
        self.advance_to(9, session_id="sess-1")
        again = self.override("junior")
        self.assertEqual(again.status_code, 200, again.text)
        self.assertFalse(again.json()["changed"], "重复选择不改学段，但**是**一次新的冷却锚点")
        self.assertEqual(again.json()["turn"], 9)

        for turn in (11, 15, 18, 19):
            body = self.submit({"turn": turn, "text": NEUTRAL_TEXT, "sessionId": "sess-1"}).json()
            with self.subTest(turn=turn):
                self.assertEqual(
                    body["cooldownRemainingTurns"],
                    max(0, MANUAL_COOLDOWN_TURNS - (turn - 9)),
                    f"第 {turn} 轮：冷却必须从**再次确认的第 9 轮**起算（而不是真变更的第 6 轮）",
                )
                self.assertEqual(body["cooldownRemainingTurns"], self.state()["cooldownRemainingTurns"])

    def test_manual_override_suppresses_the_automatic_change_for_ten_turns(self) -> None:
        """★★ 本票核心验收：手动改过之后，够格证据在 10 轮内动不了学段。

        这条断言把窗口长度**钉死在数字上**（不是「冷却期有点长」）：锚点在第 3 轮，
        所以第 4..12 轮一律被挡、第 13 轮（3 + 10）刚好放行。窗口要是被改短
        （比如退回自动的 5 轮），第 8 轮就会放行 —— 这条会当场红。

        反向对照是这条断言的另一半：**同一批证据**在没有手动改过的对照学生身上
        必须把学段调下去 —— 否则「没改」可能只是因为证据本身不够格，冷却没被真正验证。
        """
        # 前提：这组童言本身够格，自动路径本来就会在第 3 轮把学段调下去
        self.submit(*self.child_evidence(1, 2, 3))
        self.assertEqual(self.state()["grade"], "primary_low", "前提：自动路径本来够格")

        # 学生看到后说「不对，我其实学的是高中内容」→ 手动切到高中（锚点落在第 3 轮）
        override = self.override("senior")
        self.assertEqual(override.status_code, 200, override.text)
        self.assertTrue(override.json()["changed"])
        self.assertEqual(override.json()["turn"], 3, "锚点跟着轮次水位走，不是写死的 0")

        state = self.state()
        self.assertEqual(state["grade"], "senior", "手动设定立即生效")
        self.assertEqual(state["cooldownRemainingTurns"], MANUAL_COOLDOWN_TURNS)
        self.assertEqual(state["source"], SOURCE_EXPLICIT)

        # 冷却窗内（第 4..12 轮）：换一个会话反复上交同方向的够格证据，学段必须纹丝不动
        reasons = []
        for item in self.child_evidence_upto(first=4, last=12, session_id="sess-2"):
            response = self.submit(item)
            self.assertEqual(response.status_code, 200, response.text)
            reasons.append(response.json()["reason"])
            self.assertEqual(
                self.state()["grade"],
                "senior",
                f"第 {item['turn']} 轮仍在 10 轮冷却内，不许自动改学段",
            )
        self.assertEqual(
            set(reasons),
            {REASON_COOLDOWN},
            "挡住它的必须是冷却（而不是「证据不够格」）—— 与对照组的差别只在这一条",
        )

        # 第 13 轮 = 3 + 10：冷却刚好期满 → 自动推断重新接管（不是被永久停用）
        resumed = self.submit(self.child_evidence_upto(first=13, last=13, session_id="sess-2")[0])
        self.assertEqual(resumed.status_code, 200, resumed.text)
        self.assertTrue(resumed.json()["changed"], "冷却期满后自动推断照常工作")
        self.assertEqual(resumed.json()["grade"], "junior")
        self.assertEqual(self.state()["source"], SOURCE_INFERRED, "回归自动后来源也切回去")

        # ★ 反向对照：同一批证据（第 1/2/3 轮童言）在没手动改过的学生身上必须改学段
        control = "student_002"
        self.submit(*self.child_evidence(1, 2, 3), student_id=control)
        self.assertEqual(
            self.state(control)["grade"],
            "primary_low",
            "对照学生必须改 —— 证明证据本身够格，冷却才是唯一挡住它的东西",
        )

    def test_cooldown_counts_down_with_each_turn(self) -> None:
        self.override("junior")
        self.assertEqual(self.state()["cooldownRemainingTurns"], MANUAL_COOLDOWN_TURNS)

        self.submit({"turn": 1, "text": CHILD_TURNS[0], "sessionId": "sess-1"})
        self.assertEqual(
            self.state()["cooldownRemainingTurns"],
            MANUAL_COOLDOWN_TURNS - 1,
            "每过一轮水位前进一格，冷却跟着递减",
        )

    def test_automatic_cooldown_is_still_the_shorter_window(self) -> None:
        """手动窗口更长**不该**顺手把自动窗口也改长（两处口径分别钉住）。"""
        self.submit(*self.child_evidence(1, 2, 3))
        state = self.state()
        self.assertEqual(state["grade"], "primary_low")
        self.assertEqual(state["cooldownRemainingTurns"], COOLDOWN_TURNS, "自动调整后仍是 5 轮")
        self.assertEqual(state["source"], SOURCE_INFERRED)

    # ------------------------------------------------------------ ⑤ 来源 --
    def test_signals_endpoint_reports_explicit_after_a_manual_override(self) -> None:
        self.override("senior")
        body = self.signals()
        self.assertEqual(body["source"], SOURCE_EXPLICIT)
        self.assertEqual(body["currentLevel"], "senior")

    def test_grade_signals_source_accepts_both_values(self) -> None:
        """契约层两种取值都合法：``explicit``（手动）与 ``inferred``（自动）。"""
        manual = GradeSignals(student_id="s", current_level="junior", source="explicit")
        self.assertEqual(manual.source, SOURCE_EXPLICIT)
        automatic = GradeSignals(student_id="s", current_level="junior", source="inferred")
        self.assertEqual(automatic.source, SOURCE_INFERRED)
        self.assertEqual(GradeSignals(student_id="s", current_level="junior").source, SOURCE_INFERRED)

        # 端点侧：纯自动路径（没有任何手动写入）必须报 inferred
        self.submit({"turn": 1, "text": CHILD_TURNS[0], "sessionId": "sess-1"})
        self.assertEqual(self.signals()["source"], SOURCE_INFERRED)

    def test_legacy_source_values_are_narrowed_instead_of_breaking_the_endpoint(self) -> None:
        """库里可能已有早期版本写的其它来源（DDL 注释里就有 ``confirmed``）。

        ``grade_history.source`` 是宽松 TEXT，而契约把 ``GradeSignals.source`` 收窄成两种取值
        —— 一行旧数据不该让整个读接口 500。这里直接把库改成旧取值，断言两端都还能读。
        """
        self.override("junior")  # 造出锚点行
        conn = sqlite3.connect(student_learning_db_path(self.tmp, self.student_id))
        try:
            conn.execute("UPDATE grade_history SET source = 'confirmed'")
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(self.signals()["source"], SOURCE_INFERRED, "越界取值收敛成 inferred")
        self.assertEqual(self.state()["source"], SOURCE_INFERRED)

    # ------------------------------------------------------------ ⑥ 边界 --
    def test_override_works_for_a_brand_new_student(self) -> None:
        """冷启动学生（库里一行都没有）也能直接手动设定 —— 手动路径会先建学生行。"""
        fresh = "student_003"
        response = self.override("senior", student_id=fresh)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["gradeLevel"], "senior")
        self.assertEqual(self.state(fresh)["grade"], "senior", "不依赖任何信号")

    def test_grade_history_table_has_no_note_column(self) -> None:
        """★ 把「刻意不提供 note」这条取舍钉成可判定的断言。

        ``note`` 无列可写 → 请求体里也就没有这个字段（收下一个写不进去的字段等于让接口撒谎）。
        加列需要改迁移器，那属于另一个决定 —— 改的话这条断言会红，提醒一并更新契约。
        """
        self.override("junior")  # 先确保库与表建出来
        conn = sqlite3.connect(student_learning_db_path(self.tmp, self.student_id))
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(grade_history)")}
        finally:
            conn.close()
        self.assertEqual(
            columns,
            {"id", "ts", "turn", "from_level", "to_level", "source", "confidence"},
            "grade_history 的列是冻结的；新增列必须同步放开契约里的 note 字段",
        )
        self.assertNotIn("note", columns)


if __name__ == "__main__":  # pragma: no cover
    unittest.main(verbosity=2)
