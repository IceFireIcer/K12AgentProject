"""观察标签的自动投影（计划 §1.6 的数据源映射）——集成期补的功能缺口。

★★ 这一组用例守的是「画像会自己长」这件事：在它之前，全项目 `upsert_tag` **只有人工纠错
一个调用点** —— 除了五问那条路，画像从来不会自己长，「系统观察」那一层是空的。

纪律（用例逐条钉住）：
  · 所有写入过 `source='observed'`，且键在白名单里；
  · **读不到数据就不写**（绝不写占位值）；
  · **不跨学生**；
  · `memory_switch=0` 时不写（G-F 在存储层，绕不过去）。
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routes.students import student_learning_db_path  # noqa: E402
from app.store.learning import ALLOWED_TAG_KEY_SET, LearningStore  # noqa: E402


class ObservedTagsCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        self.student_id = "student_obs"
        self.path = student_learning_db_path(self.data_dir, self.student_id)
        self.store = LearningStore(self.path)
        self.addCleanup(self.store.close)
        # 判分链路的等价前置：一个还没答对过的知识点（连错两次）
        self.store.apply_mastery("kp_frac", -0.15, correct=False)
        self.store.apply_mastery("kp_frac", -0.15, correct=False)
        self.store.add_history(
            activity="quiz",
            kp_id="kp_frac",
            session_id="s1",
            question="",
            is_correct=False,
            detail="答错一次",
        )

    def tags(self) -> dict[str, str]:
        return {r.key: r.value for r in self.store.tags(self.student_id)}

    def test_projects_mastery_and_error_type_from_grading_data(self) -> None:
        written = self.store.sync_observed_tags(self.student_id)
        self.assertIn("mastery", written)
        self.assertIn("error_type", written)
        # 连错两次、从没对过 → 概念混淆（不是「粗心」）
        self.assertEqual(written["error_type"], "概念混淆")
        tags = self.tags()
        self.assertEqual(tags["error_type"], "概念混淆")
        # 来源必须是 observed（L1 观察），不是 declared / inferred
        sources = {r.key: r.source for r in self.store.tags(self.student_id)}
        self.assertEqual(sources["mastery"], "observed")
        self.assertEqual(sources["error_type"], "observed")

    def test_every_written_key_is_in_the_whitelist(self) -> None:
        """G-A：自动写入**也必须**只写白名单键（禁做 #2–6、#8 的写法层保证）。"""
        written = self.store.sync_observed_tags(self.student_id)
        for key in written:
            self.assertIn(key, ALLOWED_TAG_KEY_SET, "自动标签写了白名单外的键：" + key)

    def test_does_not_write_knowledge_point_without_a_name(self) -> None:
        """拿不到中文名时**不写** knowledge_point —— 绝不把内部 id 写进画像。"""
        written = self.store.sync_observed_tags(self.student_id)
        self.assertNotIn("knowledge_point", written)
        written2 = self.store.sync_observed_tags(
            self.student_id, kp_names={"kp_frac": "分数"}
        )
        self.assertEqual(written2.get("knowledge_point"), "分数")

    def test_no_data_writes_nothing(self) -> None:
        """★ 纪律②：读不到数据就**什么都不写**（不写占位默认值）。"""
        other = "student_empty"
        path = student_learning_db_path(self.data_dir, other)
        fresh = LearningStore(path)
        try:
            written = fresh.sync_observed_tags(other)
        finally:
            fresh.close()
        self.assertEqual(written, {}, "没有任何学习数据时不许写占位标签")

    def test_does_not_cross_students(self) -> None:
        """禁做 #9：A 的数据绝不写进 B 的库。"""
        other = "student_other"
        path = student_learning_db_path(self.data_dir, other)
        fresh = LearningStore(path)
        try:
            fresh.sync_observed_tags(other)
            self.assertEqual(fresh.tags(other), [], "别人的判分数据不该出现在我的画像里")
        finally:
            fresh.close()

    def test_memory_switch_off_blocks_every_write(self) -> None:
        """G-F 在存储层，自动路径同样绕不过去。"""
        self.store.set_identity_flags(self.student_id, memory_switch=False)
        written = self.store.sync_observed_tags(self.student_id)
        self.assertEqual(written, {}, "记忆闸关闭时不许写任何标签")
        self.assertEqual(self.tags(), {})

    def test_emotion_comes_from_the_metacognition_signal(self) -> None:
        """★ 计划 §1.6 明写「signals.py 元认知路**已有**」——这里把它接上。"""
        self.store.conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) "
            "VALUES(?,?,?,?,?)",
            (int(time.time()), "s1", "meta_cognition", -0.5, "元认知=受挫=太难了"),
        )
        self.store.conn.commit()
        written = self.store.sync_observed_tags(self.student_id)
        self.assertEqual(written.get("emotion"), "frustrated")
        self.assertEqual(written.get("intensity"), "2")
        # 取值域：emotion 必须落在有限枚举里（禁做 #12）
        self.assertIn(written["emotion"], ("happy", "calm", "confused", "frustrated", "angry"))

    def test_safety_level_records_a_grade_not_content(self) -> None:
        """★ 只记档位、不记内容：拦截了什么话一概不进画像。"""
        written = self.store.sync_observed_tags(self.student_id)
        self.assertEqual(written.get("safety_level"), "正常")
        self.store.add_history(
            activity="qa",
            kp_id="",
            session_id="s1",
            question="",
            is_correct=None,
            detail="内容安全拦截",
        )
        written2 = self.store.sync_observed_tags(self.student_id)
        self.assertEqual(written2.get("safety_level"), "需留意")
        # 标签值里**不得**出现被拦下的正文（只允许档位那两个词）
        for record in self.store.tags(self.student_id):
            if record.key == "safety_level":
                self.assertIn(record.value, ("正常", "需留意"))


if __name__ == "__main__":
    unittest.main()
