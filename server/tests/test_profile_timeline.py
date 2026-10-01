"""画像变化时间线（§5.2 #11）—— 变更序列的写入侧两道闸 + 读取侧投影。

★★ 这一组用例守的是**两条会互相拆台的红线**：

  ① 时间线必须真的记下「画像怎么变成现在这样的」（否则这个功能是空的）；
  ② **短期情绪标签绝不能进时间线** —— emotion / intensity / trigger 在读取侧有 TTL
     （3 轮或 24 小时），TTL 的全部意义是不让「上次考崩了、情绪低落」被长期记着
     （禁做 #11「长期负面情绪档案」）。历史表一旦把它们记下来，读取侧的 TTL 就被
     **完全架空**：当前值过期了，历史里却一行不少 —— 档案照样存在，而且更隐蔽。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routes.students import student_learning_db_path  # noqa: E402
from app.store.learning import ALLOWED_TAG_KEY_SET, LearningStore  # noqa: E402


class TagHistoryWriteCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.student_id = "student_tl"
        self.store = LearningStore(
            student_learning_db_path(Path(self.tmp.name), self.student_id)
        )
        self.addCleanup(self.store.close)

    def keys(self) -> list[str]:
        return [record.key for record in self.store.tag_history(self.student_id)]

    def test_first_appearance_and_change_are_both_recorded(self) -> None:
        self.store.upsert_tag(self.student_id, "explain_style", "多举生活里的例子")
        self.store.upsert_tag(self.student_id, "explain_style", "先给结论再讲")
        records = self.store.tag_history(self.student_id)
        self.assertEqual(len(records), 2, "首次出现 + 一次变更 = 两笔")
        # 新的在前
        self.assertEqual(records[0].value, "先给结论再讲")
        self.assertEqual(records[0].previous_value, "多举生活里的例子")
        # 最早那笔的 previous 必须是 None（第一次出现，不是「从空值变过来」）
        self.assertIsNone(records[1].previous_value)
        self.assertEqual(records[1].value, "多举生活里的例子")

    def test_same_value_is_not_recorded_twice(self) -> None:
        """★ 自动投影每轮都会 upsert 一遍：不做这个判断，时间线会被重复噪音塞满。"""
        for _ in range(5):
            self.store.upsert_tag(self.student_id, "pace", "慢一点")
        self.assertEqual(len(self.store.tag_history(self.student_id)), 1)

    def test_ephemeral_tags_never_enter_the_timeline(self) -> None:
        """★★★ 最关键的一条：短期情绪标签绝不进时间线（禁做 #11）。"""
        self.store.upsert_tag(self.student_id, "emotion", "frustrated")
        self.store.upsert_tag(self.student_id, "intensity", "3")
        self.store.upsert_tag(self.student_id, "trigger", "考试")
        self.assertEqual(
            self.keys(), [], "短期情绪标签进了时间线 = 读取侧的 TTL 被架空（禁做 #11）"
        )
        # 而主表里它们照样在（TTL 管的是「读得到多久」，不是「不许存」）
        live = {record.key for record in self.store.tags(self.student_id)}
        self.assertIn("emotion", live)

    def test_only_whitelisted_keys_are_recorded(self) -> None:
        """历史记的是过去的「值」，不是过去的「身份」。"""
        with self.assertRaises(ValueError):
            self.store.upsert_tag(self.student_id, "family_income", "高")
        self.assertEqual(self.keys(), [])

    def test_memory_switch_off_writes_no_history(self) -> None:
        """G-F 在存储层，自动路径同样绕不过去。"""
        self.store.set_identity_flags(self.student_id, memory_switch=False)
        written = self.store.upsert_tag(self.student_id, "pace", "慢一点")
        self.assertFalse(written)
        self.assertEqual(self.keys(), [])

    def test_history_is_append_only_and_newest_first(self) -> None:
        for value in ["a", "b", "c"]:
            self.store.upsert_tag(self.student_id, "pace", value)
        records = self.store.tag_history(self.student_id)
        self.assertEqual([r.value for r in records], ["c", "b", "a"])
        # 撤销（删除当前值）**不删历史**：留下的正是「他撤销过」这件事
        self.store.delete_tag(self.student_id, "pace")
        self.assertEqual(len(self.store.tag_history(self.student_id)), 3)

    def test_history_reader_re_checks_the_whitelist(self) -> None:
        """纵深防御：库里被外部塞了脏键，也不从这条出口流出去。"""
        self.store.conn.execute(
            "INSERT INTO profile_tag_history(ts, anon_student_id, key, value, source) "
            "VALUES(?,?,?,?,?)",
            (1, self.student_id, "report_card_score", "99", "declared"),
        )
        self.store.conn.commit()
        for key in self.keys():
            self.assertIn(key, ALLOWED_TAG_KEY_SET)
        self.assertEqual(self.keys(), [], "非白名单键不许从历史出口流出去")

    def test_does_not_cross_students(self) -> None:
        """禁做 #9：A 的变更绝不进 B 的时间线。"""
        self.store.upsert_tag(self.student_id, "pace", "慢一点")
        other = "student_other"
        fresh = LearningStore(student_learning_db_path(Path(self.tmp.name), other))
        try:
            fresh.upsert_tag(other, "pace", "快一点")
            mine = {r.value for r in self.store.tag_history(self.student_id)}
            self.assertEqual(mine, {"慢一点"})
            theirs = {r.value for r in fresh.tag_history(other)}
            self.assertEqual(theirs, {"快一点"})
        finally:
            fresh.close()


# --------------------------------------------------------------------------- #
# 投影：三类事件 + 三道闸
# --------------------------------------------------------------------------- #

from app.routes.profile import _timeline_events  # noqa: E402


class TimelineProjectionCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.student_id = "student_proj"
        self.store = LearningStore(
            student_learning_db_path(Path(self.tmp.name), self.student_id)
        )
        self.addCleanup(self.store.close)

    def grade(self, ts: int, frm: str | None, to: str, source: str = "inferred") -> None:
        self.store.conn.execute(
            "INSERT INTO grade_history(ts, turn, from_level, to_level, source, confidence) "
            "VALUES(?,?,?,?,?,?)",
            (ts, 1, frm, to, source, 0.8),
        )
        self.store.conn.commit()

    def events(self, limit: int = 50):
        return _timeline_events(self.store, self.student_id, limit=limit)

    def test_grade_change_becomes_a_readable_sentence(self) -> None:
        self.grade(1000, "primary_high", "junior")
        events = self.events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "grade")
        self.assertEqual(events[0].title, "学段从小学高年级变成初中")
        self.assertIn("自动调整", events[0].detail)

    def test_first_grade_row_is_the_starting_point_not_a_change(self) -> None:
        """冷启动基线那行 from_level 为 None —— 它是「起点」，不是「变化」。"""
        self.grade(1000, None, "junior")
        events = self.events()
        self.assertEqual(events[0].title, "开始按初中讲")

    def test_same_level_row_is_not_a_change(self) -> None:
        self.grade(1000, "junior", "junior")
        self.assertEqual(self.events(), [], "前后同值不是变化")

    def test_unknown_level_is_skipped_not_echoed(self) -> None:
        """认不出的学段值：跳过，绝不把内部枚举名当人话显示。"""
        self.grade(1000, "primary_high", "university")
        self.assertEqual(self.events(), [])

    def test_tag_change_becomes_a_readable_sentence(self) -> None:
        self.store.upsert_tag(self.student_id, "interest_topic", "恐龙")
        self.store.upsert_tag(self.student_id, "interest_topic", "太空")
        events = [e for e in self.events() if e.kind == "tag"]
        self.assertEqual(len(events), 2)
        # ★ 中文名以 TAG_LABELS 为准（后端唯一来源）：interest_topic 是「兴趣话题」
        self.assertEqual(events[0].title, "把「兴趣话题」改成了「太空」")
        self.assertIn("恐龙", events[0].detail)
        self.assertEqual(events[1].title, "记下了「兴趣话题」：恐龙")
        self.assertEqual(events[0].label, "兴趣话题")

    def test_onboarding_is_the_starting_point(self) -> None:
        self.store.save_onboarding_answer(
            question_id="q1",
            question_text="你现在上几年级呀？",
            answer_text="我上五年级",
            session_id="s1",
        )
        events = self.events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "onboarding")
        self.assertIn("入门问答", events[0].title)

    def test_newest_first_and_limit_is_respected(self) -> None:
        self.grade(1000, None, "primary_low")
        self.grade(2000, "primary_low", "primary_high")
        self.grade(3000, "primary_high", "junior")
        events = self.events(limit=2)
        self.assertEqual(len(events), 2, "limit 必须生效")
        self.assertEqual(events[0].at, 3000 * 1000, "新的在前（且已换算成毫秒）")
        self.assertEqual(events[1].at, 2000 * 1000)

    def test_parent_consent_off_returns_nothing(self) -> None:
        """G-G：时间线也是画像，同一道闸。"""
        self.grade(1000, "primary_high", "junior")
        self.store.set_identity_flags(self.student_id, parent_consent=False)
        self.assertEqual(self.events(), [])

    def test_ephemeral_emotion_never_reaches_the_timeline(self) -> None:
        """★★ 端到端再钉一次：情绪标签从写入到投影都不该出现（禁做 #11）。"""
        self.store.upsert_tag(self.student_id, "emotion", "frustrated")
        self.store.upsert_tag(self.student_id, "intensity", "3")
        kinds = {event.kind for event in self.events()}
        self.assertEqual(kinds, set(), "情绪标签不得出现在时间线上")

    def test_tag_event_carries_origin_in_both_forms(self) -> None:
        """★ origin 有两副面孔：结构化字段（界面用）+ detail 里的一句中文（学生读）。

        学生面只读 title/detail 这两句现成中文（双视角纪律 D-063）——
        所以 detail **必须**把出处讲成人话，而不是让学生去认 cold_start 这种枚举值。
        """
        self.store.upsert_tag(self.student_id, "pace", "慢一点", source="declared")
        events = [e for e in self.events() if e.kind == "tag"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].origin, "cold_start")
        self.assertIn("刚认识你", events[0].detail)
        # 绝不把内部枚举名当人话显示
        self.assertNotIn("cold_start", events[0].title)
        self.assertNotIn("cold_start", events[0].detail)

    def test_projection_and_refresh_render_different_sentences(self) -> None:
        """同 source=observed 的两笔，因 origin 不同，学生面看到**不同的**说明。"""
        self.store.upsert_tag(
            self.student_id, "pace", "慢一点", source="observed", origin="projection"
        )
        self.store.upsert_tag(
            self.student_id, "pace", "快一点", source="observed", origin="refresh"
        )
        events = [e for e in self.events() if e.kind == "tag"]
        self.assertEqual(events[0].origin, "refresh")
        self.assertEqual(events[1].origin, "projection")
        self.assertIn("聊天", events[0].detail)
        self.assertIn("练习", events[1].detail)

    def test_legacy_row_without_origin_renders_neutral_sentence(self) -> None:
        """★ 旧行（origin 为 NULL）→ 空串 + 一句中性中文，绝不显示空/枚举名。"""
        self.store.conn.execute(
            "INSERT INTO profile_tag_history("
            "ts, anon_student_id, key, value, previous_value, source, confidence"
            ") VALUES(?,?,?,?,?,?,?)",
            (10, self.student_id, "pace", "慢一点", None, "observed", None),
        )
        self.store.conn.commit()
        events = [e for e in self.events() if e.kind == "tag"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].origin, "")
        self.assertIn("系统调整的", events[0].detail)


if __name__ == "__main__":
    unittest.main()


class TagOriginCase(unittest.TestCase):
    """★★ origin 与 source 是**正交**的两维：
      · source 说「这条值**多可信**」（declared/observed/inferred）；
      · origin 说「它**从哪条写入路径来的**」（cold_start/refresh/projection）。

    这两维必须分得开，因为 `observed` 同时来自两条路（行为投影 / 持续迭代概括），
    而它们对「画像怎么变成现在这样的」是**两个不同的故事**。
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.student_id = "student_origin"
        self.store = LearningStore(
            student_learning_db_path(Path(self.tmp.name), self.student_id)
        )
        self.addCleanup(self.store.close)

    def test_declared_is_inferred_as_cold_start(self) -> None:
        """★ 不显式传 origin 时，declared 按唯一映射落到 cold_start（五问是唯一来源）。"""
        self.store.upsert_tag(self.student_id, "pace", "慢一点", source="declared")
        records = self.store.tag_history(self.student_id)
        self.assertEqual(records[0].origin, "cold_start")

    def test_projection_is_recorded_as_projection(self) -> None:
        """★★ 行为投影（sync_observed_tags）必须显式声明 projection，**不吃 refresh 兜底**。"""
        self.store.upsert_tag(
            self.student_id,
            "pace",
            "慢一点",
            source="observed",
            origin="projection",
        )
        records = self.store.tag_history(self.student_id)
        self.assertEqual(records[0].origin, "projection")
        self.assertEqual(records[0].source, "observed", "source 与 origin 是两维")

    def test_summary_write_is_recorded_as_refresh(self) -> None:
        """持续画像概括（upsert_tag_from_summary）显式声明 refresh。"""
        written = self.store.upsert_tag_from_summary(
            self.student_id, "explain_style", "图示优先", source="observed"
        )
        self.assertTrue(written)
        records = self.store.tag_history(self.student_id)
        self.assertEqual(records[0].origin, "refresh")

    def test_same_source_different_origin_is_distinguishable(self) -> None:
        """★★★ 这张表存在的**全部理由**：同一个 source、两种 origin 必须分得开。"""
        self.store.upsert_tag(
            self.student_id, "pace", "慢一点", source="observed", origin="projection"
        )
        self.store.upsert_tag(
            self.student_id, "pace", "快一点", source="observed", origin="refresh"
        )
        records = self.store.tag_history(self.student_id)
        self.assertEqual([r.source for r in records], ["observed", "observed"])
        self.assertEqual([r.origin for r in records], ["refresh", "projection"])

    def test_unknown_origin_is_rejected(self) -> None:
        """封闭词表：塞一个不在 TAG_ORIGINS 里的出处直接 ValueError（纵深防御）。"""
        with self.assertRaises(ValueError):
            self.store.upsert_tag(
                self.student_id, "pace", "慢一点", source="observed", origin="made_up"
            )

    def test_dirty_origin_in_db_does_not_leak_out(self) -> None:
        """★ 读取侧再过一遍词表：库里被外力塞了脏出处，也当「不知道」（None）流出。"""
        self.store.upsert_tag(self.student_id, "pace", "慢一点", source="declared")
        self.store.conn.execute(
            "UPDATE profile_tag_history SET origin = 'bogus' WHERE anon_student_id = ?",
            (self.student_id,),
        )
        self.store.conn.commit()
        records = self.store.tag_history(self.student_id)
        self.assertIsNone(records[0].origin, "脏出处一律当 None，绝不把内部枚举名流出去")


class TagOriginMigrationCase(unittest.TestCase):
    """v7 迁移：加列 + 只对**唯一可确定**的旧行回填，observed 留 NULL。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.student_id = "student_mig7"
        self.store = LearningStore(
            student_learning_db_path(Path(self.tmp.name), self.student_id)
        )
        self.addCleanup(self.store.close)

    def test_origin_column_exists_after_migration(self) -> None:
        columns = {
            str(row["name"])
            for row in self.store.conn.execute(
                "PRAGMA table_info(profile_tag_history)"
            ).fetchall()
        }
        self.assertIn("origin", columns, "v7 必须补出 origin 列")

    def test_legacy_rows_are_backfilled_only_when_unambiguous(self) -> None:
        """★★ 回填纪律（不替过去编造）：declared→cold_start、inferred→refresh、
        observed **留 NULL** —— 因为投影与概括都可能写 observed，猜不了。

        ★ 构造方式：把表**退回 v6 形状**（没有 origin 列）+ 删掉 v7 记账，
          再跑一次迁移 —— 这才是「老库升上来的」真实场景（列不存在 → 加列 + 回填）。
        """
        from app.store.migrations import LEARNING, LEARNING_MIGRATIONS, ensure_migrated

        # 退回 v6：整表重建（不删数据），去掉 origin 列。
        self.store.conn.execute("ALTER TABLE profile_tag_history RENAME TO _old_pth")
        self.store.conn.execute(
            "CREATE TABLE profile_tag_history ("
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  ts INTEGER, anon_student_id TEXT NOT NULL, key TEXT NOT NULL,"
            "  value TEXT, previous_value TEXT, source TEXT, confidence REAL"
            ")"
        )
        # 塞三行「v6 时代」的旧记录（declared / inferred / observed）。
        for source in ("declared", "inferred", "observed"):
            self.store.conn.execute(
                "INSERT INTO profile_tag_history("
                "ts, anon_student_id, key, value, previous_value, source, confidence"
                ") VALUES(?,?,?,?,?,?,?)",
                (1, self.student_id, "pace", "慢" + source, None, source, None),
            )
        self.store.conn.execute("DROP TABLE _old_pth")
        self.store.conn.execute(
            "DELETE FROM schema_version WHERE set_name=? AND version=7", (LEARNING,)
        )
        self.store.conn.commit()

        ensure_migrated(self.store.conn, LEARNING_MIGRATIONS, set_name=LEARNING)

        origins = {
            str(row["source"]): row["origin"]
            for row in self.store.conn.execute(
                "SELECT source, origin FROM profile_tag_history "
                "WHERE anon_student_id = ?",
                (self.student_id,),
            ).fetchall()
        }
        self.assertEqual(origins["declared"], "cold_start")
        self.assertEqual(origins["inferred"], "refresh")
        self.assertIsNone(origins["observed"], "observed 无法区分投影/概括，绝不猜")


if __name__ == "__main__":
    unittest.main()