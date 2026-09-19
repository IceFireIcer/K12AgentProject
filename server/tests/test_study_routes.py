# -*- coding: utf-8 -*-
"""学习档案（章节 / 依赖图全览 / 错题本 / 学习报告）的后端断言。

这一组盯住五条「错了就静默出事」的红线：

1. ★ **章节顺序是教材顺序**（按 `第N章` 解析章号，不是 rowid、不是字典序）——
   字典序会让「第 10 章」排在「第 2 章」前面、入库序会按文件名字典序乱排，
   学生看到的目录顺序就是错的；
2. ★ **错题只算 ``is_correct = 0``**：``is_correct IS NULL``（没有对错概念的活动：
   qa / 动画 / 生成题）不能算错题，否则错题本里会冒出一堆学生没做错的题；
3. ★★ **答案不外流**：错题本**不 join 带标准答案的 ``generated_question``，
   响应里任何位置都不许出现 ``answer``（递归扫 JSON，与 ``test_contracts`` 同一手法）；
4. ★ **时间按本地日期切天**：报告里的「连续学习 N 天」不能在跨零点学习时断掉；
5. ★ **跨学生隔离**：A 的错题/报告里不出现 B 的任何数据；
6. ★★ **错题本的汇总是全量**：``limit`` 只截断列表，``totalWrong`` / ``withoutStem``
   是「累计答错 N 次」—— 截断后求和会让练得多的学生看到一个**偏小且不再增长**的数字。

跑法::

    cd server && uv run python -m unittest discover -s tests
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import build_runtime_config  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes.study import MISTAKE_LIMIT  # noqa: E402
from app.routes.students import student_learning_db_path  # noqa: E402

TOKEN = "test-token-study"

#: 随包知识库（章节与依赖图的断言要用真教材，不是造一份假清单）。
#:
#: ★ 与 ``test_quiz_loop`` / ``test_personalization`` 同一个路径：**开发态的 per-user 库**
#:   （``server/_data/shared/kb.sqlite``，由 ``scripts/build_kb.py`` 生成，被 .gitignore 忽略）。
#:   刻意**不用** ``app.config.BUNDLED_KB_PATH``（``resources/kb/``）：源码态那里一般不存在
#:   ——「随包库」只在打包产物里有，测试要能用就得指向开发态那一份。
REAL_KB = ROOT / "_data" / "shared" / "kb.sqlite"

#: 四学段的章节数（实测：新教材 K12KnowledgeBase 每学段都是 8 章）。
#: ★ 写死在这里是**有意的**：教材章节数变了就要有人显式改这个数并说明原因，
#:   而不是让测试自动跟着变（那样「教材少了一章」永远不会被发现）。
EXPECTED_CHAPTERS = {"primary_low": 8, "primary_high": 8, "junior": 8, "senior": 8}

#: 新教材每学段的**最后一章**（章号最大的一章，用来说明排序不是字典序/入库序）。
#: ⚠️ 「（补充）」是全角括号，和库里的字面量一字不差。
LAST_CHAPTER_TITLE = "第8章 编程实践（补充）"


class StudyCase(unittest.TestCase):
    """带临时 userData 的基类：真实一人一库落在 tmp 里，绝不碰开发机的真实数据。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

        if REAL_KB.exists():
            (self.tmp / "shared").mkdir(parents=True, exist_ok=True)
            import shutil

            shutil.copy(REAL_KB, self.tmp / "shared" / "kb.sqlite")

        # ★ 路由已由 `main.py` 正式登记（本轮起不再靠测试自己 include_router）：
        #   这样 OpenAPI 导出链、鉴权中间件、camelCase 序列化全都真跑到。
        self.app = create_app(build_runtime_config(token=TOKEN, data_dir=self.tmp))
        self.client = TestClient(self.app)
        self.client.headers.update({"X-Auth-Token": TOKEN})

    # ------------------------------------------------------------ 小工具 --
    def create_student(self, nickname: str, grade_level: str) -> str:
        response = self.client.post(
            "/api/students", json={"nickname": nickname, "gradeLevel": grade_level}
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["studentId"]

    def write_history(self, student_id: str, **row) -> None:
        """直接往该学生的 ``learning_history`` 写一行（**模仿 `quiz.py` 的写入形态**）。

        ★ 为什么直接写库而不是走 HTTP：这条测试要精确控制 ``ts``（连续天数的用例要
          造出「昨天学过、今天没学」这类时间分布），而 HTTP 写入的时间戳恒为「现在」。
          走 ``store.add_history`` 同一张表同一套列，命令与线上写入路径一致。
        """
        from app.store.learning import LearningStore

        store = LearningStore(student_learning_db_path(self.tmp, student_id))
        try:
            store.add_history(
                kp_id=row.get("kp_id", ""),
                activity=row.get("activity", "quiz"),
                session_id=row.get("session_id", ""),
                question=row.get("question", ""),
                is_correct=row.get("is_correct"),
                detail=row.get("detail", ""),
            )
            if "ts" in row:
                # `add_history` 恒写「现在」；需要指定时间时改这一行（只改 ts）
                store.conn.execute(
                    "UPDATE learning_history SET ts = ? WHERE id = (SELECT MAX(id) FROM learning_history)",
                    (int(row["ts"]),),
                )
                store.conn.commit()
        finally:
            store.close()

    def query(self, student_id: str, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        conn = sqlite3.connect(student_learning_db_path(self.tmp, student_id))
        conn.row_factory = sqlite3.Row
        try:
            return list(conn.execute(sql, params))
        finally:
            conn.close()


# --------------------------------------------------------------------------- #
# 章节
# --------------------------------------------------------------------------- #
@unittest.skipUnless(REAL_KB.exists(), "随包知识库不存在（先跑 scripts/build_kb.py）")
class TestChapters(StudyCase):
    def test_four_grades_have_expected_chapter_counts(self) -> None:
        for grade, expected in EXPECTED_CHAPTERS.items():
            body = self.client.get(f"/api/knowledge/chapters/{grade}").json()
            self.assertEqual(body["gradeLevel"], grade)
            self.assertEqual(
                len(body["chapters"]),
                expected,
                f"{grade} 的章节数变了：期望 {expected}，实际 {len(body['chapters'])}"
                "（教材结构改动请显式更新 EXPECTED_CHAPTERS 并说明原因）",
            )
            self.assertFalse(body["withProgress"], "没传 studentId 时不该声称带进度")

    def test_chapter_order_is_textbook_order_not_lexicographic(self) -> None:
        """★ 顺序必须是**教材顺序**（章号递增），而不是字典序、也不是入库顺序。

        这两条都会真实踩到：
          - 字典序会让「第 10 章」排在「第 2 章」前面；
          - 入库顺序（``MIN(rowid)``）实际是**文件名字典序** —— 实测小学低年级排成
            ``第1章, 第6章, 第1章, 第3章, …``，目录页顺序就是乱的。
        所以这里断言的是**最强的性质**：章号必须严格递增且从 1 连续。
        """
        import re

        for grade in EXPECTED_CHAPTERS:
            body = self.client.get(f"/api/knowledge/chapters/{grade}").json()
            titles = [item["chapterTitle"] for item in body["chapters"]]
            numbers: list[int] = []
            for title in titles:
                match = re.match(r"^第(\d+)章", title)
                self.assertIsNotNone(match, f"章节名不是「第N章 …」形态：{title}")
                numbers.append(int(match.group(1)))
            self.assertEqual(
                numbers,
                sorted(numbers),
                f"{grade} 的章节顺序不是教材顺序（章号没有递增）：{numbers}",
            )
            self.assertEqual(
                numbers,
                list(range(1, len(numbers) + 1)),
                f"{grade} 的章号不连续（教材章节变了？）：{numbers}",
            )
            # ★ 反例锚点：最新的一章（第 8 章）必须排在最后 —— 按字典序/入库序都会把它排错。
            self.assertEqual(
                titles[-1],
                LAST_CHAPTER_TITLE,
                f"{grade} 的最后一章应当是「{LAST_CHAPTER_TITLE}」，实际：{titles[-1]}",
            )

    def test_kp_ids_are_real_and_counts_agree(self) -> None:
        body = self.client.get("/api/knowledge/chapters/junior").json()
        total = 0
        for item in body["chapters"]:
            self.assertEqual(item["kpCount"], len(item["kpIds"]))
            self.assertGreater(item["kpCount"], 0)
            total += item["kpCount"]
        # 初中学段的知识点数（新教材实测 57 = 57 概念 × 1）；与 kp 表一致即可，不写死具体数字
        listed = self.client.get("/api/knowledge/chapters/junior").json()
        self.assertEqual(total, sum(item["kpCount"] for item in listed["chapters"]))

    def test_progress_only_when_student_given(self) -> None:
        student = self.create_student("初中生", "junior")
        # 没建进度行时：withProgress 为真、计数全 0（**不报错** —— 新学生是正常状态）
        body = self.client.get(
            "/api/knowledge/chapters/junior", params={"student_id": student}
        ).json()
        self.assertTrue(body["withProgress"])
        self.assertTrue(all(item["masteredCount"] == 0 for item in body["chapters"]))

    def test_invalid_grade_is_422_not_empty_list(self) -> None:
        response = self.client.get("/api/knowledge/chapters/kindergarten")
        self.assertEqual(response.status_code, 422, response.text)

    def test_missing_kb_is_503_with_readable_message(self) -> None:
        empty = Path(self._tmp.name + "-nokb")
        empty.mkdir()
        self.addCleanup(lambda: __import__("shutil").rmtree(empty, ignore_errors=True))
        app = create_app(build_runtime_config(token=TOKEN, data_dir=empty))
        client = TestClient(app, headers={"X-Auth-Token": TOKEN})
        response = client.get("/api/knowledge/chapters/junior")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("build_kb", response.json()["detail"])


# --------------------------------------------------------------------------- #
# 依赖图全览
# --------------------------------------------------------------------------- #
@unittest.skipUnless(REAL_KB.exists(), "随包知识库不存在（先跑 scripts/build_kb.py）")
class TestGraphOverview(StudyCase):
    def test_nodes_and_edges_are_within_grade_and_consistent(self) -> None:
        body = self.client.get("/api/graph/overview/junior").json()
        node_ids = {node["kpId"] for node in body["nodes"]}
        self.assertTrue(node_ids, "初中学段应当有知识点")
        # ★ 边只允许两端都在本学段的节点里（跨学段的边在单学段视图里没有落点）
        for edge in body["edges"]:
            self.assertIn(edge["fromKpId"], node_ids, "边的起点不在本学段节点里")
            self.assertIn(edge["toKpId"], node_ids, "边的终点不在本学段节点里")
        # 每个节点都有名字与章节（地图要按章节分组显示）
        for node in body["nodes"]:
            self.assertTrue(node["name"])
            self.assertTrue(node["chapterTitle"])

    def test_layers_respect_precedence_and_are_deterministic(self) -> None:
        """★ 分层：后继的层必须严格大于前置；同输入两次调用结果完全相同。"""
        body = self.client.get("/api/graph/overview/junior").json()
        layer = {node["kpId"]: node["layer"] for node in body["nodes"]}
        for edge in body["edges"]:
            self.assertGreater(
                layer[edge["toKpId"]],
                layer[edge["fromKpId"]],
                f"分层不正确：{edge['fromKpId']}(layer {layer[edge['fromKpId']]}) → "
                f"{edge['toKpId']}(layer {layer[edge['toKpId']]})",
            )
        again = self.client.get("/api/graph/overview/junior").json()
        self.assertEqual(body, again, "同一份数据两次请求必须给出完全相同的图")

    def test_invalid_grade_is_422(self) -> None:
        self.assertEqual(self.client.get("/api/graph/overview/nope").status_code, 422)

    def test_mastered_flag_absent_without_student(self) -> None:
        body = self.client.get("/api/graph/overview/junior").json()
        self.assertTrue(all(node["mastered"] is False for node in body["nodes"]))


# --------------------------------------------------------------------------- #
# 错题本
# --------------------------------------------------------------------------- #
class TestMistakes(StudyCase):
    def test_only_wrong_answers_are_mistakes(self) -> None:
        """★ 只算 ``is_correct = 0``；``NULL``（没对错概念）与 ``1`` 都不算。"""
        student = self.create_student("错题", "junior")
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="循环题", is_correct=False)
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="循环题", is_correct=True)
        self.write_history(student, kp_id="prog-variable-jr", activity="qa", is_correct=None)  # NULL

        body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        self.assertEqual([item["kpId"] for item in body["items"]], ["prog-loop-jr"])
        self.assertEqual(body["items"][0]["wrongCount"], 1)
        self.assertEqual(body["totalWrong"], 1)

    def test_same_concept_in_two_grades_aggregates_separately(self) -> None:
        """★ 归并按 **kp_id**，不是按「概念」：同一概念在四学段各有独立 kp。

        ★ 新教材里 ``X-pl / X-ph / X-jr / X-sr`` 是**四个不同的知识点**
          （例如 ``prog-loop-pl`` 与 ``prog-loop-jr``）—— 错题本要分别归并，
          不能把「循环」这一个概念合并成一条（那样学生分不清自己卡在哪个学段的讲法上）。
        """
        student = self.create_student("跨学段", "junior")
        self.write_history(student, kp_id="prog-loop-pl", activity="quiz", question="小学的循环题", is_correct=False)
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="初中的循环题", is_correct=False)
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="初中的循环题", is_correct=False)

        body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        self.assertEqual(
            [(item["kpId"], item["wrongCount"]) for item in body["items"]],
            [("prog-loop-jr", 2), ("prog-loop-pl", 1)],
            "同一概念的两个学段必须是两条独立记录（错得多的在前）",
        )
        self.assertEqual(body["totalWrong"], 3)

    def test_blank_stem_is_counted_not_silently_dropped(self) -> None:
        """★ 答错但没有题干（QA / 编程轨）要被**显式统计**，不能静默少几条。"""
        student = self.create_student("无题干", "junior")
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="有题干", is_correct=False)
        self.write_history(student, kp_id="prog-loop-jr", activity="coding", question="", is_correct=False)
        self.write_history(student, kp_id="prog-variable-jr", activity="coding", question="", is_correct=False)

        body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        self.assertEqual(body["totalWrong"], 3, "总错次应当含没有题干的那些")
        self.assertEqual(body["withoutStem"], 2, "两次没有题干的答错要被显式报出来")
        loop = next(item for item in body["items"] if item["kpId"] == "prog-loop-jr")
        self.assertEqual(loop["wrongCount"], 2, "同一知识点的错次要累加")
        self.assertEqual(loop["stem"], "有题干", "题干取最近一次**有题干**的那条")

    def test_totals_are_full_even_when_the_item_list_is_truncated(self) -> None:
        """★★ ``limit`` 只截断**列表**；``totalWrong`` / ``withoutStem`` 恒为**全量**。

        错题本界面上「累计答错 N 次」与页脚「已计入上面的错次统计」都是求和得出的。
        以前这两个数是对**截断之后**的 records 求的和 —— 一旦错过的知识点超过 ``limit``
        （默认 50，而一个学段就有 57 个知识点、跨学段取题还会更多），
        那个数字就**偏小且永远不再增长**，页脚那句话也随之变成假话。
        ``limit`` 描述的是「列表回几条知识点」，不是「统计范围」。

        ★ 用 55 个虚构 kp（``kp-truncate-*``）而不是真实知识点：这条断言与 kb 无关
          —— 它要的是「超过 ``limit`` 的错题分布」，不是「名字能不能从 kb 补上」
          （那是 ``test_kp_name_and_chapter_come_from_kb`` 的事）。
        """
        from app.store.learning import LearningStore

        student = self.create_student("全量统计", "junior")
        total_kps = MISTAKE_LIMIT + 5

        # 一次开库批量写（55 次开库只为了数据分布，会白花时间）；
        # 每行都是「答错且没有题干」→ 两个汇总各自可预期。
        store = LearningStore(student_learning_db_path(self.tmp, student))
        try:
            for index in range(total_kps):
                store.add_history(
                    kp_id=f"kp-truncate-{index:03d}",
                    activity="coding",
                    question="",
                    is_correct=False,
                )
        finally:
            store.close()

        # ① 默认 limit：列表截到 MISTAKE_LIMIT 条，但两个汇总要覆盖全部 55 条
        default_body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        self.assertEqual(
            len(default_body["items"]), MISTAKE_LIMIT, "列表仍然只回 limit 条知识点"
        )
        self.assertEqual(
            default_body["totalWrong"],
            total_kps,
            "累计答错次数必须是**全量**和（按截断后的列表求和会让它停在 limit 上）",
        )
        self.assertEqual(default_body["withoutStem"], total_kps, "无题干的错次同样是全量")

        # ② 显式更小的 limit：列表跟着 limit 走，汇总**一个数都不变**
        explicit = self.client.get(
            f"/api/quiz/mistakes/{student}", params={"limit": 3}
        ).json()
        self.assertEqual(len(explicit["items"]), 3, "limit=3 只回 3 条知识点")
        self.assertEqual(explicit["totalWrong"], total_kps, "汇总不随 limit 缩小（它不是列表的子集和）")
        self.assertEqual(explicit["withoutStem"], total_kps)

    def test_rows_without_kp_id_are_skipped(self) -> None:
        """没有知识点归属的行（qa 轨未识别出 kp）按知识点聚合时无处可放 —— 跳过而不是崩。"""
        student = self.create_student("无归属", "junior")
        self.write_history(student, kp_id="", activity="qa", is_correct=False)
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="题", is_correct=False)

        body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        self.assertEqual([item["kpId"] for item in body["items"]], ["prog-loop-jr"])

    def test_sorted_by_wrong_count_then_kp_id(self) -> None:
        """★ 排序显式钉死：错得多的在前，平局按 kpId —— 不依赖 SQL 行序（否则列表会莫名跳动）。

        用三个**真实**的初中 kp：第 4 章「大模型与AI智能体Agent」里的三个知识点
        （``agent-perception-jr`` / ``agent-planning-jr`` / ``agent-action-jr``），
        字典序与错次都不相同，正好能分辨「按错次排」与「按 id 排」。
        """
        student = self.create_student("排序", "junior")
        for kp, times in (("agent-planning-jr", 1), ("agent-action-jr", 1), ("agent-perception-jr", 3)):
            for _ in range(times):
                self.write_history(student, kp_id=kp, activity="quiz", question="题", is_correct=False)

        body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        self.assertEqual(
            [item["kpId"] for item in body["items"]],
            ["agent-perception-jr", "agent-action-jr", "agent-planning-jr"],
            "错得多的在前；同为 1 次的按 kpId 升序（action < planning）",
        )

    def test_kp_name_and_chapter_come_from_kb(self) -> None:
        student = self.create_student("补名", "junior")
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="题", is_correct=False)
        body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        item = body["items"][0]
        self.assertTrue(item["kpName"], "知识点名应当从 kb 补上")
        self.assertTrue(item["chapterTitle"], "章节名应当从 kb 补上")

    def test_qid_is_extracted_from_detail(self) -> None:
        student = self.create_student("题号", "junior")
        self.write_history(
            student,
            kp_id="prog-loop-jr",
            activity="quiz",
            question="题",
            is_correct=False,
            detail=json.dumps({"qid": "q-123", "type": "choice"}, ensure_ascii=False),
        )
        body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        self.assertEqual(body["items"][0]["lastQid"], "q-123")

    def test_broken_detail_is_tolerated(self) -> None:
        """``detail`` 格式坏了不该让错题本整体 500（它只是辅助信息）。"""
        student = self.create_student("坏detail", "junior")
        self.write_history(
            student, kp_id="prog-loop-jr", activity="quiz", question="题", is_correct=False, detail="{不是JSON"
        )
        body = self.client.get(f"/api/quiz/mistakes/{student}").json()
        self.assertEqual(body["items"][0]["lastQid"], "")

    def test_response_never_contains_answer_keys(self) -> None:
        """★★ 答案泄漏防护：响应里任何位置都不许出现 ``answer`` 键（递归扫）。"""
        student = self.create_student("防泄漏", "junior")
        self.write_history(
            student,
            kp_id="prog-loop-jr",
            activity="quiz",
            question="下列哪个是正确的循环？",
            is_correct=False,
            detail=json.dumps({"qid": "q-1"}),
        )
        raw = self.client.get(f"/api/quiz/mistakes/{student}").text
        self.assertNotIn("answer", raw.lower(), "错题本响应里出现了 answer")
        self.assertNotIn("reference", raw.lower(), "错题本响应里出现了 reference_answer 的痕迹")

        def walk(node: object) -> list[str]:
            hits: list[str] = []
            if isinstance(node, dict):
                hits.extend(key for key in node if "answer" in key.lower())
                for value in node.values():
                    hits.extend(walk(value))
            elif isinstance(node, list):
                for value in node:
                    hits.extend(walk(value))
            return hits

        self.assertEqual(walk(json.loads(raw)), [])

    def test_unknown_student_is_404(self) -> None:
        self.assertEqual(self.client.get("/api/quiz/mistakes/student_999").status_code, 404)

    def test_invalid_student_id_is_rejected(self) -> None:
        """路径穿越的学生 id 必须被拒（404 或 422 都算拒 —— 绝不返回别人/别的文件的数据）。

        ★ 不用「必须是 422」这种过窄断言：``..%2F`` 会被 HTTP 层规范化成 ``../``，
          于是它落到路径上就是**另一个路径**（不是同一个路由的非法参数），
          框架给出的 404 同样是「拒绝」。真正要守的是「没读到别人的数据」。
        """
        response = self.client.get("/api/quiz/mistakes/..%2Fstudent_002")
        self.assertIn(response.status_code, (404, 422), response.text)

    def test_cross_student_isolation(self) -> None:
        """★ 跨学生隔离：A 的错题不出现在 B 的错题本里。"""
        a = self.create_student("甲", "junior")
        b = self.create_student("乙", "junior")
        self.write_history(a, kp_id="prog-loop-jr", activity="quiz", question="A 的题", is_correct=False)
        self.write_history(b, kp_id="prog-variable-jr", activity="quiz", question="B 的题", is_correct=False)

        body_a = self.client.get(f"/api/quiz/mistakes/{a}").json()
        body_b = self.client.get(f"/api/quiz/mistakes/{b}").json()
        self.assertEqual([item["kpId"] for item in body_a["items"]], ["prog-loop-jr"])
        self.assertEqual([item["kpId"] for item in body_b["items"]], ["prog-variable-jr"])
        self.assertNotIn("B 的题", json.dumps(body_a, ensure_ascii=False))


# --------------------------------------------------------------------------- #
# 学习报告
# --------------------------------------------------------------------------- #
class TestLearningReport(StudyCase):
    def test_counts_and_quiz_accuracy(self) -> None:
        student = self.create_student("周报", "junior")
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="题", is_correct=True)
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="题", is_correct=False)
        self.write_history(student, kp_id="prog-loop-jr", activity="qa")

        body = self.client.get(f"/api/profile/{student}/report").json()
        self.assertEqual(body["days"], 7)
        self.assertEqual(body["totalActivities"], 3)
        self.assertEqual(body["quizTotal"], 2)
        self.assertEqual(body["quizCorrect"], 1)
        self.assertEqual(body["todayStudied"], True)
        self.assertEqual(body["streakDays"], 1)
        self.assertEqual(body["studentId"], student)

    def test_streak_counts_consecutive_days(self) -> None:
        """★ 连续天数：跨日要连上，断一天就归零重算。"""
        student = self.create_student("连续", "junior")
        now = int(time.time())
        # 今天 / 昨天 / 前天：连续 3 天
        for offset in (0, 1, 2):
            self.write_history(
                student, kp_id="prog-loop-jr", activity="qa", ts=now - offset * 86_400
            )

        body = self.client.get(f"/api/profile/{student}/report").json()
        self.assertEqual(body["streakDays"], 3)

    def test_streak_allows_today_not_studied_yet(self) -> None:
        """★ 今天还没学不该把连续天数清零（否则每天早上打开都看到「连续 0 天」）。"""
        student = self.create_student("昨天", "junior")
        now = int(time.time())
        for offset in (1, 2):
            self.write_history(
                student, kp_id="prog-loop-jr", activity="qa", ts=now - offset * 86_400
            )

        body = self.client.get(f"/api/profile/{student}/report").json()
        self.assertEqual(body["streakDays"], 2)
        self.assertFalse(body["todayStudied"])

    def test_streak_breaks_on_gap(self) -> None:
        student = self.create_student("断档", "junior")
        now = int(time.time())
        # 今天、然后跳到 5 天前：中间断了 → 连续 1 天
        self.write_history(student, kp_id="prog-loop-jr", activity="qa", ts=now)
        self.write_history(student, kp_id="prog-loop-jr", activity="qa", ts=now - 5 * 86_400)

        body = self.client.get(f"/api/profile/{student}/report").json()
        self.assertEqual(body["streakDays"], 1)

    def test_streak_zero_without_recent_activity(self) -> None:
        student = self.create_student("久远", "junior")
        self.write_history(student, kp_id="prog-loop-jr", activity="qa", ts=int(time.time()) - 30 * 86_400)
        body = self.client.get(f"/api/profile/{student}/report").json()
        self.assertEqual(body["streakDays"], 0)
        self.assertEqual(body["totalActivities"], 0, "时间窗外的活动不计入周窗口")

    def test_window_excludes_old_activity(self) -> None:
        student = self.create_student("窗口", "junior")
        now = int(time.time())
        self.write_history(student, kp_id="k", activity="qa", ts=now)
        self.write_history(student, kp_id="k", activity="qa", ts=now - 3 * 86_400)
        self.write_history(student, kp_id="k", activity="qa", ts=now - 10 * 86_400)  # 窗外

        body = self.client.get(f"/api/profile/{student}/report", params={"days": 7}).json()
        self.assertEqual(body["totalActivities"], 2)
        wide = self.client.get(f"/api/profile/{student}/report", params={"days": 30}).json()
        self.assertEqual(wide["totalActivities"], 3)

    def test_days_out_of_range_is_422(self) -> None:
        student = self.create_student("越界", "junior")
        for bad in (0, 1000):
            response = self.client.get(f"/api/profile/{student}/report", params={"days": bad})
            self.assertEqual(response.status_code, 422, response.text)

    def test_unknown_student_is_404(self) -> None:
        self.assertEqual(self.client.get("/api/profile/student_999/report").status_code, 404)

    def test_report_includes_mastery_and_chapters(self) -> None:
        student = self.create_student("初中生", "junior")
        self.write_history(student, kp_id="prog-loop-jr", activity="quiz", question="题", is_correct=True)
        body = self.client.get(f"/api/profile/{student}/report").json()
        # 章节来自 kb（初中 8 章），且顺序为教材顺序
        self.assertEqual(len(body["chapters"]), EXPECTED_CHAPTERS["junior"])
        self.assertEqual(body["gradeLevel"], "junior")
        self.assertIsInstance(body["mastery"], list)
        # 刚建的学生还没有学段轨迹（基线那行由 `GradeEngine.ensure_student` 写，
        # 只在真的走过学段推断时才产生）—— 空列表是**正确**的初始状态，不是 bug。
        self.assertEqual(body["gradeHistory"], [])

    def test_grade_history_entries_are_mapped_from_the_table(self) -> None:
        """``gradeHistory`` 把 ``grade_history`` 的表行按统一契约映射出来。

        ★ 直接写库造两行（一次冷启动基线、一次真实变更）：这个端点要能给出
          「第 3 轮从小学高年级调到初中（0.75）」这种叙事素材，字段一个都不能少。
        """
        student = self.create_student("轨迹", "junior")
        conn = sqlite3.connect(student_learning_db_path(self.tmp, student))
        try:
            conn.execute(
                "INSERT INTO grade_history(ts, turn, from_level, to_level, source, confidence) "
                "VALUES(?,?,?,?,?,?)",
                (1_700_000_000, 0, None, "primary_high", "inferred", 0.0),
            )
            conn.execute(
                "INSERT INTO grade_history(ts, turn, from_level, to_level, source, confidence) "
                "VALUES(?,?,?,?,?,?)",
                (1_700_000_500, 3, "primary_high", "junior", "inferred", 0.75),
            )
            conn.commit()
        finally:
            conn.close()

        body = self.client.get(f"/api/profile/{student}/report").json()
        entries = body["gradeHistory"]
        self.assertEqual(len(entries), 2)
        # 正序：基线在前
        self.assertIsNone(entries[0]["fromLevel"])
        self.assertEqual(entries[0]["toLevel"], "primary_high")
        self.assertEqual(entries[1]["fromLevel"], "primary_high")
        self.assertEqual(entries[1]["toLevel"], "junior")
        self.assertEqual(entries[1]["turn"], 3)
        self.assertAlmostEqual(entries[1]["confidence"], 0.75)
        # 时间戳是毫秒（库里存秒）
        self.assertEqual(entries[1]["ts"], 1_700_000_500_000)

    def test_stage_counts_reflect_progress_rows(self) -> None:
        """``stageCounts`` 是 ``progress`` 表的阶段计数（闯关进度那一栏的数据源）。"""
        from app.store.learning import LearningStore

        student = self.create_student("闯关", "junior")
        store = LearningStore(student_learning_db_path(self.tmp, student))
        try:
            store.upsert_progress("prog-loop-jr", stage="mastered", badge="bronze")
            store.upsert_progress("prog-variable-jr", stage="learning")
        finally:
            store.close()

        body = self.client.get(f"/api/profile/{student}/report").json()
        self.assertEqual(body["stageCounts"], {"learning": 1, "mastered": 1})
        self.assertEqual(body["badges"], ["bronze"])
        # prog-loop-jr 在最后一章「第8章 编程实践（补充）」里：该章的已掌握数应当是 1
        chapter = next(c for c in body["chapters"] if c["masteredCount"] == 1)
        self.assertGreaterEqual(chapter["kpCount"], 1)
        self.assertEqual(
            sum(c["masteredCount"] for c in body["chapters"]),
            1,
            "各章已掌握数之和应当等于 mastered 阶段的总数",
        )

    def test_generated_at_is_milliseconds(self) -> None:
        student = self.create_student("时间", "junior")
        body = self.client.get(f"/api/profile/{student}/report").json()
        self.assertGreater(body["generatedAt"], 1_600_000_000_000, "时间戳应当是毫秒")

    def test_cross_student_isolation(self) -> None:
        a = self.create_student("甲", "primary_low")
        b = self.create_student("乙", "senior")
        self.write_history(a, kp_id="ai-definition-pl", activity="quiz", question="A", is_correct=True)
        body_b = self.client.get(f"/api/profile/{b}/report").json()
        self.assertEqual(body_b["totalActivities"], 0)
        self.assertEqual(body_b["gradeLevel"], "senior")
        self.assertEqual(len(body_b["chapters"]), EXPECTED_CHAPTERS["senior"])


if __name__ == "__main__":
    unittest.main()
