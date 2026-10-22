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

    # ------------------------------------------------------ 学段内难度档 --
    def seed_attempts(self, *, total: int, correct: int) -> None:
        """铺一组掌握度，使「总 attempts / 总 correct」恰好等于给定值。

        ★ 用**一个知识点**铺（不是多行均摊）：`sync_zpd_level` 只看总量，
          这里要的是可数的总量，行数不该成为变量。
        ★ 本类与 `test_profile_tags.py` 不同：这里 `self.store` 是**实例**（setUp 里已建好），
          没有 `exec_sql` / `query` 辅助方法 —— 直接用 `self.store.conn`。
        """
        # ★ 先清空：setUp 已经为「判分链路」铺了 kp_frac 两行，
        #   不清掉的话总量会被它们污染，档位就算不准（这是本组用例唯一的前置耦合）。
        self.store.conn.execute("DELETE FROM mastery")
        self.store.conn.execute(
            "INSERT INTO mastery(kp_id, score, attempts, correct, last_seen_at) "
            "VALUES(?,?,?,?,?)",
            ("kp_zpd", round(correct / max(1, total), 4), total, correct, 1_700_000_000),
        )
        self.store.conn.commit()

    def zpd_value(self) -> str | None:
        row = self.store.conn.execute(
            "SELECT value FROM profile_tags "
            "WHERE anon_student_id = ? AND key = 'zpd_level'",
            (self.student_id,),
        ).fetchone()
        return None if row is None else str(row["value"])

    def test_zpd_level_is_projected_from_mastery(self) -> None:
        """★★ 票 30 的**唯一生产方**：这个键以前全仓无人写，导致难度微调恒为「正常」。

        三条判据各钉一档：低正确率 → 偏易、高正确率 → 偏难、中段 → 正常。
        """
        # 低正确率（2/10 = 0.2 < 0.5）→ 偏易
        self.seed_attempts(total=10, correct=2)
        written = self.store.sync_observed_tags(self.student_id)
        self.assertEqual(written.get("zpd_level"), "偏易")
        self.assertEqual(self.zpd_value(), "偏易")

        # 高正确率（9/10 = 0.9 ≥ 0.85）→ 偏难
        self.seed_attempts(total=10, correct=9)
        written2 = self.store.sync_observed_tags(self.student_id)
        self.assertEqual(written2.get("zpd_level"), "偏难")
        self.assertEqual(self.zpd_value(), "偏难")

        # ★ 中段（7/10 = 0.7）→ **也要写「正常」**：这一条是有状态的，
        #   只写两端的话，曾经偏易的学生会永久被按偏易讲（没人覆盖那条旧值）。
        self.seed_attempts(total=10, correct=7)
        written3 = self.store.sync_observed_tags(self.student_id)
        self.assertEqual(written3.get("zpd_level"), "正常")
        self.assertEqual(self.zpd_value(), "正常", "中段必须能回到正常档，否则档位回不去")

    def test_zpd_level_source_and_origin(self) -> None:
        """★ 来源必须是 observed、出处必须是 projection（不是模型猜的 inferred）。"""
        self.seed_attempts(total=10, correct=2)
        self.store.sync_observed_tags(self.student_id)
        rows = self.store.conn.execute(
            "SELECT source FROM profile_tags WHERE anon_student_id = ? AND key = 'zpd_level'",
            (self.student_id,),
        ).fetchall()
        self.assertEqual(str(rows[0]["source"]), "observed")
        history = self.store.conn.execute(
            "SELECT origin FROM profile_tag_history WHERE key = 'zpd_level' ORDER BY id DESC LIMIT 1"
        ).fetchall()
        self.assertEqual(str(history[0]["origin"]), "projection")

    def test_zpd_level_insufficient_sample_writes_nothing(self) -> None:
        """★ 样本不足就不写 —— 不把「不知道」冒充成「观察到了」。"""
        self.seed_attempts(total=3, correct=1)  # 3 < ZPD_MIN_ATTEMPTS
        written = self.store.sync_observed_tags(self.student_id)
        self.assertNotIn("zpd_level", written)
        self.assertIsNone(self.zpd_value())

    def test_zpd_level_is_not_inferred_writable(self) -> None:
        """★ 禁做 #10：客观量不许被模型推断写（zpd_level 不在 inferred 允许集里）。"""
        from app.store.learning import INFERRED_ALLOWED_TAG_KEYS

        self.assertNotIn("zpd_level", INFERRED_ALLOWED_TAG_KEYS)
        with self.assertRaises(ValueError):
            self.store.upsert_tag(self.student_id, "zpd_level", "偏难", source="inferred")

    def test_zpd_level_rejects_out_of_vocabulary_values(self) -> None:
        """★ 封闭词表闸：自由文本（「很难」「1」这类）一律拒绝。"""
        for bad in ("很难", "1", "偏易一点", "harder"):
            with self.assertRaises(ValueError, msg=f"zpd_level={bad!r} 必须被取值域拒绝"):
                self.store.upsert_tag(self.student_id, "zpd_level", bad, source="observed")
        # 词表内的三个词可写
        for good in ("偏易", "正常", "偏难"):
            self.assertTrue(
                self.store.upsert_tag(self.student_id, "zpd_level", good, source="observed")
            )

    def test_zpd_level_does_not_cross_students(self) -> None:
        """禁做 #9：A 的判分数据不许投影成 B 的难度档。"""
        self.seed_attempts(total=10, correct=2)
        other = "student_zpd_other"
        path = student_learning_db_path(self.data_dir, other)
        fresh = LearningStore(path)
        try:
            written = fresh.sync_observed_tags(other)
            self.assertNotIn("zpd_level", written, "B 没有判分数据，不该有难度档")
        finally:
            fresh.close()

    def test_zpd_level_respects_memory_switch(self) -> None:
        """G-F 在存储层：记忆闸关闭时难度档也写不进去。"""
        self.seed_attempts(total=10, correct=2)
        self.store.set_identity_flags(self.student_id, memory_switch=False)
        written = self.store.sync_observed_tags(self.student_id)
        self.assertNotIn("zpd_level", written)
        self.assertIsNone(self.zpd_value())

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
