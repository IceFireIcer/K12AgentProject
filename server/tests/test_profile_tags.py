# -*- coding: utf-8 -*-
"""票 25：冷启动画像地基 —— 白名单投影 / 两张物理隔离的表 / 两道闸 / TTL。

这一组断言把执行报告的**红线**变成可执行的（每条都能红）：

- **G-A**：profile_tags 的任何键 ∈ 白名单；写入与出栈两处都过一遍；
- **G-B**：identity_local 的身份列与白名单零重叠（**唯一交集是 anon_student_id 这把 join 钥匙**，
  口径裁决见 desktop/src/shared/profile-tags.ts 的文件头）；
- **G-E**：emotion / intensity / trigger 过期后**读不到**（3 轮或 24 小时，取先到）；
- **G-F**：memory_switch=0 时**不写任何标签**；
- **G-G**：parent_consent=0 时 GET /tags 返回**空**（落库本身不算外发）；
- **G-K**：learning_history.question **仍然每一行为空**；
- 禁做 #2–6、#8：标签表无此 key、写入端点无此参数；
- 禁做 #10：source='inferred' 只允许情绪/风格类键；
- 禁做 #12：emotion 是有限枚举，自由文本一律拒绝。

★ 跨层一致性：本文件**写死那份白名单**，并直接解析 TS 源文件逐字比对 ——
  只改一边（不管改哪边）都会立刻红。

跑法（不需要知识库，本文件零 skip）::

    cd server && uv run python -m unittest tests.test_profile_tags -v
"""

from __future__ import annotations

import re
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
from app.contracts import (  # noqa: E402
    DISPLAY_NAME_MAX_CHARS,
    STUDENT_FALLBACK_NAME,
    TAG_DIMENSION_LABELS,
    TAG_DIMENSIONS,
    TAG_LABELS,
    safe_display_name,
)
from app.main import create_app  # noqa: E402
from app.routes.students import student_learning_db_path  # noqa: E402
from app.store.learning import (  # noqa: E402
    ALLOWED_TAG_KEYS,
    ALLOWED_TAG_KEY_SET,
    EMOTION_VALUES,
    EPHEMERAL_TAGS,
    EPHEMERAL_TTL_SECONDS,
    EPHEMERAL_TTL_TURNS,
    IDENTITY_LOCAL_FIELDS,
    INFERRED_ALLOWED_TAG_KEYS,
    JOIN_KEY,
    LEARNER_STYLE_VALUES,
    LearningStore,
    PERSONALITY_VALUES,
    ZPD_LEVEL_VALUES,
)

TOKEN = "test-token-profile-tags"

#: ★ 写死的那份白名单（27 个键）。契约书写「26 个」，但逐字对齐的 TS 真源
#: desktop/src/shared/profile-tags.ts 的 LLM_VISIBLE_TAGS 实际是 **27** 个 ——
#: 以真源为准（本文件同时解析源文件比对，不是靠这句注释）。
#: ⚠️ 25 → 27 是 2026-09-30 的加键（维度 13：学习类型与性格），
#:    伴随一次禁做红线的**最小移动**（只放开「性格」一维，见 G-M-7 的改写）。
EXPECTED_WHITELIST: tuple[str, ...] = (
    "anon_student_id",
    "grade_band",
    "subject",
    "course_module",
    "current_topic",
    "knowledge_point",
    "mastery",
    "error_type",
    "zpd_level",
    "explain_style",
    "output_length",
    "pace",
    "practice_type",
    "interest_topic",
    "emotion",
    "intensity",
    "trigger",
    "confidence",
    "tone",
    "encouragement_freq",
    "challenge_level",
    "scene",
    "task_goal",
    "safety_level",
    "boundary_topics",
    "learner_style",
    "personality",
)

#: 禁做 #2–6、#8 的键：这些键**不许存在**于白名单，写入端点也不许有对应参数。
FORBIDDEN_PRIVACY_KEYS: tuple[str, ...] = (
    "family_income",
    "parent_occupation",
    "consumption_profile",
    "advertising_id",
    "precise_location",
    "social_graph",
)


class ProfileTagsCase(unittest.TestCase):
    """带临时 userData 的基类：真实一人一库落在 tmp 里，绝不碰开发机的真实数据。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        # main.py 已 include profile + onboarding 两条 router；这里直接用 create_app 端到端跑。
        self.app = create_app(build_runtime_config(token=TOKEN, data_dir=self.tmp))
        self.client = TestClient(self.app)
        self.client.headers.update({"X-Auth-Token": TOKEN})
        self.student_id = "student_tag_001"

    # ------------------------------------------------------------ 小工具 --
    def store(self, student_id: str | None = None) -> LearningStore:
        store = LearningStore(student_learning_db_path(self.tmp, student_id or self.student_id))
        self.addCleanup(store.close)
        return store

    def query(self, sql: str, params: tuple = (), student_id: str | None = None) -> list:
        conn = sqlite3.connect(student_learning_db_path(self.tmp, student_id or self.student_id))
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def exec_sql(self, sql: str, params: tuple = (), student_id: str | None = None) -> None:
        conn = sqlite3.connect(student_learning_db_path(self.tmp, student_id or self.student_id))
        try:
            conn.execute(sql, params)
            conn.commit()
        finally:
            conn.close()

    def tags_view(self, student_id: str | None = None) -> dict:
        response = self.client.get(
            f"/api/profile/{student_id or self.student_id}/tags"
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def put_tag(self, key: str, *, value: str = "x", **extra) -> object:
        body = {"value": value}
        body.update(extra)
        return self.client.put(f"/api/profile/{self.student_id}/tags/{key}", json=body)

    def refresh_apply(self, tags: list[dict], *, reason: str = "", **extra) -> object:
        """调 refresh-apply（持续画像迭代的批量写入口）。"""
        body: dict = {"tags": tags}
        if reason:
            body["reason"] = reason
        body.update(extra)
        return self.client.post(
            f"/api/profile/{self.student_id}/tags/refresh-apply", json=body
        )

    def tag_value(self, key: str, student_id: str | None = None) -> str | None:
        """直接读库里的 (value, source, confidence) 三元组，供分档断言。"""
        rows = self.query(
            "SELECT value, source, confidence FROM profile_tags "
            "WHERE anon_student_id = ? AND key = ?",
            (student_id or self.student_id, key),
        )
        return None if not rows else rows[0]


# --------------------------------------------------------------------------- #
# 跨层一致性：白名单是唯一真相
# --------------------------------------------------------------------------- #
class TestWhitelistAlignment(ProfileTagsCase):
    def test_backend_constant_matches_typescript_source(self) -> None:
        """★ 后端常量与 TS 真源**逐字**一致（顺序也算）——只改一边必红。"""
        ts_path = ROOT.parent / "desktop" / "src" / "shared" / "profile-tags.ts"
        source = ts_path.read_text(encoding="utf-8")
        match = re.search(r"export const LLM_VISIBLE_TAGS = \[([\s\S]*?)\] as const", source)
        self.assertIsNotNone(match, "TS 里找不到 LLM_VISIBLE_TAGS（真源被改名了？）")
        ts_keys = tuple(re.findall(r"'([^']+)'", match.group(1)))
        self.assertEqual(ts_keys, ALLOWED_TAG_KEYS)
        self.assertEqual(tuple(ALLOWED_TAG_KEYS), EXPECTED_WHITELIST)
        self.assertEqual(len(EXPECTED_WHITELIST), 27)

    def test_labels_and_dimensions_cover_exactly_the_whitelist(self) -> None:
        """★ 中文名与维度也是后端唯一来源：覆盖面必须与白名单**恰好相等**（两个方向）。"""
        self.assertEqual(set(TAG_LABELS), set(ALLOWED_TAG_KEYS))
        self.assertEqual(set(TAG_DIMENSIONS), set(ALLOWED_TAG_KEYS))
        # ★ 上界跟着最新维度走：12 → 13（2026-09-30 新增「类型与性格」）。
        self.assertTrue(all(1 <= value <= 13 for value in TAG_DIMENSIONS.values()))

    def test_dimension_labels_cover_exactly_the_used_dimensions(self) -> None:
        """★ 维度小标题（A2+）：覆盖面必须与**实际用到的维度号**恰好相等。

        ★ 为什么判据是「TAG_DIMENSIONS 的取值集合」而不是「1..12」：
          1..12 是历史槽位（5/6 有意留空），拿它当判据会逼着人给空维度编一个名字。
          真正的要求是：**有标签落进去的每一维**都得有中文名，否则画像卡上
          那一组就没有小标题 —— 这正是 A2+ 要修的那个洞。
        ★ 反向也判：不许存在「没有标签用到的维度名」（那是没人消费的死数据，
          且会让人误以为界面漏渲染了一组）。
        """
        used_dimensions = set(TAG_DIMENSIONS.values())
        self.assertEqual(
            set(TAG_DIMENSION_LABELS),
            used_dimensions,
            "维度小标题的键集合必须恰好等于实际用到的维度号集合",
        )
        # 每个名字都得是**非空中文**（空串等于没给，界面会整行不渲染 —— 那是静默丢功能）
        for dimension, name in TAG_DIMENSION_LABELS.items():
            self.assertTrue(name.strip(), f"维度 {dimension} 的中文名不能为空")
            self.assertTrue(
                any("\u4e00" <= ch <= "\u9fff" for ch in name),
                f"维度 {dimension} 的中文名必须含中文（学生面文案）：{name!r}",
            )

    def test_join_key_is_the_only_overlap_between_identity_and_tags(self) -> None:
        """★ G-B：identity_local 与白名单的唯一交集就是那把 join 钥匙。"""
        identity = set(IDENTITY_LOCAL_FIELDS)
        allowed = set(ALLOWED_TAG_KEYS)
        self.assertEqual(identity & allowed, {JOIN_KEY})
        self.assertTrue((identity - {JOIN_KEY}).isdisjoint(allowed))

    def test_no_identity_field_leaks_into_labels(self) -> None:
        """身份列不能借「中文名表」这种侧门拿到出口（G-B 的第二种形态）。"""
        self.assertTrue(
            (set(IDENTITY_LOCAL_FIELDS) - {JOIN_KEY}).isdisjoint(set(TAG_LABELS))
        )


# --------------------------------------------------------------------------- #
# 迁移 v5：两张物理隔离的表
# --------------------------------------------------------------------------- #
class TestMigrationV5(ProfileTagsCase):
    def test_three_tables_are_created_with_expected_shape(self) -> None:
        store = self.store()
        store.close()  # 打开即跑迁移
        tables = {row["name"] for row in self.query("SELECT name FROM sqlite_master WHERE type='table'")}
        for name in ("identity_local", "profile_tags", "onboarding_qa"):
            self.assertIn(name, tables)

        self.assertEqual(
            {row["name"] for row in self.query("PRAGMA table_info(identity_local)")},
            set(IDENTITY_LOCAL_FIELDS),
        )
        self.assertEqual(
            {row["name"] for row in self.query("PRAGMA table_info(profile_tags)")},
            {"anon_student_id", "key", "value", "confidence", "source", "ts", "turn_mark"},
        )
        self.assertEqual(
            {row["name"] for row in self.query("PRAGMA table_info(onboarding_qa)")},
            {"id", "ts", "session_id", "question_id", "question_text", "answer_text", "answered_at"},
        )

    def test_gates_default_to_one_and_state_to_not_started(self) -> None:
        """★ 两道闸默认 1（本轮裁决 B：默认同意，家长可在设置页关）。"""
        store = self.store()
        store.conn.execute("INSERT INTO identity_local(anon_student_id) VALUES(?)", (self.student_id,))
        store.conn.commit()
        row = self.query(
            "SELECT parent_consent, memory_switch, onboarding_state FROM identity_local WHERE anon_student_id = ?",
            (self.student_id,),
        )[0]
        self.assertEqual(int(row["parent_consent"]), 1)
        self.assertEqual(int(row["memory_switch"]), 1)
        self.assertEqual(row["onboarding_state"], "not_started")

    def test_onboarding_question_id_is_unique(self) -> None:
        """★ 一问一答：question_id 上有 **UNIQUE** 索引（重答是覆盖不是追加）。"""
        self.store().close()
        rows = self.query(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_onboarding_q'"
        )
        self.assertEqual(len(rows), 1)
        self.assertIn("UNIQUE", str(rows[0]["sql"]).upper())

    def test_tags_key_index_exists(self) -> None:
        self.store().close()
        rows = self.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tags_key'")
        self.assertEqual(len(rows), 1)

    def test_migration_is_idempotent(self) -> None:
        for _ in range(3):
            self.store().close()
        rows = self.query(
            "SELECT version FROM schema_version WHERE set_name='learning' AND version=5"
        )
        self.assertEqual(len(rows), 1, "v5 只许记一行账")


# --------------------------------------------------------------------------- #
# 写入原语：白名单 / 禁做清单
# --------------------------------------------------------------------------- #
class TestWriteGuards(ProfileTagsCase):
    def test_forbidden_privacy_keys_are_rejected(self) -> None:
        """★ 禁做 #2–6、#8：标签表无此 key（白名单里没有，写入原语直接拒绝）。"""
        store = self.store()
        for key in FORBIDDEN_PRIVACY_KEYS:
            self.assertNotIn(key, ALLOWED_TAG_KEY_SET)
            with self.assertRaises(ValueError, msg=f"{key} 不该被写进画像"):
                store.upsert_tag(self.student_id, key, "有")

    def test_inferred_source_is_limited_to_emotion_and_style(self) -> None:
        """★ 禁做 #10：source='inferred' 只允许情绪/风格/倾向类键。

        ★ 2026-09-30：限键从 8 扩到 10（+learner_style +personality）——
          这是一次**红线的最小移动**（只放开「性格」一维）。本测试同时钉两个方向：
          客观量（学段/掌握度/知识点）**仍然**写不进去，而新两键**允许**被推断。
        """
        store = self.store()
        for key in ("grade_band", "mastery", "knowledge_point", "safety_level"):
            self.assertNotIn(key, INFERRED_ALLOWED_TAG_KEYS)
            with self.assertRaises(ValueError, msg=f"{key} 不该被推断写"):
                store.upsert_tag(self.student_id, key, "x", source="inferred")
        for key in ("emotion", "explain_style", "pace"):
            self.assertIn(key, INFERRED_ALLOWED_TAG_KEYS)
        # 维度 13（2026-09-30）：两个新键在限键内（值仍受封闭词表约束，见投影测试类）
        for key in ("learner_style", "personality"):
            self.assertIn(
                key, INFERRED_ALLOWED_TAG_KEYS, f"维度 13 的 {key} 允许被推断写（2026-09-30 裁决）"
            )
        self.assertTrue(store.upsert_tag(self.student_id, "explain_style", "生活例子", source="inferred"))

    def test_unknown_source_is_rejected(self) -> None:
        store = self.store()
        with self.assertRaises(ValueError):
            store.upsert_tag(self.student_id, "pace", "慢", source="guessed")

    def test_emotion_is_a_finite_enum(self) -> None:
        """★ 禁做 #12：情绪是有限枚举，自由文本（临床词汇）一律拒绝。"""
        store = self.store()
        for bad in ("抑郁", "焦虑", "我很难过", "sad", ""):
            with self.assertRaises(ValueError, msg=f"emotion={bad!r} 不该被接受"):
                store.upsert_tag(self.student_id, "emotion", bad)
        for value in EMOTION_VALUES:
            self.assertTrue(store.upsert_tag(self.student_id, "emotion", value))

    def test_intensity_is_clamped_to_0_3(self) -> None:
        store = self.store()
        for bad in ("9", "-1", "很高"):
            with self.assertRaises(ValueError):
                store.upsert_tag(self.student_id, "intensity", bad)
        self.assertTrue(store.upsert_tag(self.student_id, "intensity", "2"))

    def test_out_of_whitelist_row_is_not_returned_on_read(self) -> None:
        """★ G-A 出栈再过一遍：库里被外力塞了脏键，也不会流出去。"""
        store = self.store()
        store.upsert_tag(self.student_id, "pace", "慢")
        self.exec_sql(
            "INSERT INTO profile_tags(anon_student_id, key, value, source, ts) VALUES(?,?,?,?,?)",
            (self.student_id, "family_income", "保密", "observed", int(time.time())),
        )
        keys = {record.key for record in store.tags(self.student_id)}
        self.assertEqual(keys, {"pace"})


# --------------------------------------------------------------------------- #
# 两道闸（G-F / G-G）
# --------------------------------------------------------------------------- #
class TestTwoGates(ProfileTagsCase):
    def test_memory_switch_off_blocks_all_tag_writes(self) -> None:
        """★ G-F：memory_switch=0 时写入原语**直接 return，不写任何标签**。"""
        store = self.store()
        store.set_identity_flags(self.student_id, memory_switch=False)
        self.assertFalse(store.upsert_tag(self.student_id, "pace", "慢"))
        self.assertEqual(store.tags(self.student_id), [])
        self.assertEqual(
            self.query("SELECT COUNT(*) AS n FROM profile_tags")[0]["n"], 0
        )

    def test_memory_switch_off_hides_tags_from_http(self) -> None:
        store = self.store()
        store.upsert_tag(self.student_id, "pace", "慢")
        response = self.client.put(
            f"/api/profile/{self.student_id}/identity/flags", json={"memorySwitch": False}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["memorySwitch"])
        # 关闸只影响往后写；已写下的标签仍在库里（要抹掉走 DELETE）
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM profile_tags")[0]["n"], 1)

    def test_parent_consent_off_blanks_the_tags_endpoint(self) -> None:
        """★ G-G：parent_consent=0 → GET /tags 返回空（但库里那行还在）。"""
        store = self.store()
        store.upsert_tag(self.student_id, "explain_style", "先给结论")
        self.assertEqual(len(self.tags_view()["tags"]), 1)

        response = self.client.put(
            f"/api/profile/{self.student_id}/identity/flags", json={"parentConsent": False}
        )
        self.assertEqual(response.status_code, 200, response.text)
        view = self.tags_view()
        self.assertEqual(view["tags"], [])
        self.assertFalse(view["parentConsent"])
        # 落库本身不算外发 —— 行还在，只是这个出口不给了
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM profile_tags")[0]["n"], 1)

    def test_flags_endpoint_requires_at_least_one_field(self) -> None:
        response = self.client.put(
            f"/api/profile/{self.student_id}/identity/flags", json={}
        )
        self.assertEqual(response.status_code, 422, response.text)


# --------------------------------------------------------------------------- #
# 短期情绪 TTL（G-E）
# --------------------------------------------------------------------------- #
class TestEphemeralTtl(ProfileTagsCase):
    def test_ephemeral_tags_expire_after_24_hours(self) -> None:
        """★ G-E 的一半：超过 24 小时 → 读不到。"""
        store = self.store()
        now = int(time.time())
        for key in EPHEMERAL_TAGS:
            self.assertTrue(store.upsert_tag(self.student_id, key, self._value_for(key), ts=now))
        self.assertEqual({r.key for r in store.tags(self.student_id)}, set(EPHEMERAL_TAGS))

        for key in EPHEMERAL_TAGS:
            store.upsert_tag(self.student_id, key, self._value_for(key), ts=now - EPHEMERAL_TTL_SECONDS - 1)
        self.assertEqual(store.tags(self.student_id), [])

    def test_ephemeral_tags_expire_after_three_turns(self) -> None:
        """★ G-E 的另一半：超过 3 轮 → 读不到（轮次用 grade_signals 的 id 差算）。"""
        store = self.store()
        now = int(time.time())
        self.assertTrue(store.upsert_tag(self.student_id, "emotion", "calm", ts=now))
        # 模拟又过了 4 轮：每轮至少一条学段信号（迁移 v3 的口径）
        for _ in range(EPHEMERAL_TTL_TURNS + 1):
            store.conn.execute(
                "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) VALUES(?,?,?,?,?)",
                (now, "s1", "vocab", 0.0, ""),
            )
        store.conn.commit()
        self.assertEqual(store.tags(self.student_id), [])

    def test_non_ephemeral_tags_never_expire(self) -> None:
        store = self.store()
        store.upsert_tag(self.student_id, "pace", "慢", ts=int(time.time()) - EPHEMERAL_TTL_SECONDS - 1)
        self.assertEqual({r.key for r in store.tags(self.student_id)}, {"pace"})

    @staticmethod
    def _value_for(key: str) -> str:
        return {"emotion": "calm", "intensity": "2", "trigger": "题目太难"}[key]


# --------------------------------------------------------------------------- #
# HTTP 路由层
# --------------------------------------------------------------------------- #
class TestTagRoutes(ProfileTagsCase):
    def test_put_read_delete_roundtrip_returns_projection(self) -> None:
        response = self.put_tag("pace", value="慢一点")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(len(payload["tags"]), 1)
        tag = payload["tags"][0]
        self.assertEqual(tag["key"], "pace")
        self.assertEqual(tag["value"], "慢一点")
        self.assertEqual(tag["label"], TAG_LABELS["pace"])
        self.assertEqual(tag["dimension"], TAG_DIMENSIONS["pace"])
        self.assertGreater(tag["ts"], 1_600_000_000_000, "出参 ts 应当是毫秒")

        deleted = self.client.delete(f"/api/profile/{self.student_id}/tags/pace")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["tags"], [])

    def test_tags_response_delivers_dimension_labels(self) -> None:
        """★ A2+：维度小标题随 tags 一起下发（画像卡按它给每一组起小标题）。

        ★ 为什么要在**路由层**断言而不是只断言常量：中文名从后端到界面要过三层
          （pydantic 序列化 → 主进程归一化 → 渲染归一化）。只测常量的话，
          「字段名字拼错 / default_factory 没生效 / 键没字符串化」这三类错一个都抓不到。
        """
        self.put_tag("pace", value="慢一点")
        view = self.tags_view()
        self.assertIn("dimensionLabels", view, "载荷必须带上维度小标题")
        labels = view["dimensionLabels"]
        # 键是**字符串化的**序号（JSON 对象的键只能是字符串），值就是后端那份中文名
        self.assertEqual(labels[str(TAG_DIMENSIONS["pace"])], TAG_DIMENSION_LABELS[TAG_DIMENSIONS["pace"]])
        # 一次全给（不是只给「有标签的那几维」）—— 前端按需取，契约更简单
        self.assertEqual(
            {int(key) for key in labels},
            set(TAG_DIMENSION_LABELS),
            "下发的维度集合必须与后端那份完全一致",
        )

    def test_put_forbidden_key_is_422(self) -> None:
        for key in FORBIDDEN_PRIVACY_KEYS:
            response = self.put_tag(key)
            self.assertEqual(response.status_code, 422, f"{key}: {response.text}")

    def test_put_emotion_free_text_is_422(self) -> None:
        self.assertEqual(self.put_tag("emotion", value="抑郁").status_code, 422)
        self.assertEqual(self.put_tag("emotion", value="happy").status_code, 200)

    def test_put_inferred_sensitive_key_is_422(self) -> None:
        response = self.put_tag("grade_band", value="primary_high", source="inferred")
        self.assertEqual(response.status_code, 422, response.text)

    def test_delete_forbidden_key_is_422(self) -> None:
        response = self.client.delete(f"/api/profile/{self.student_id}/tags/family_income")
        self.assertEqual(response.status_code, 422, response.text)

    def test_identity_endpoint_shape_and_defaults(self) -> None:
        response = self.client.get(f"/api/profile/{self.student_id}/identity")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["anonStudentId"], self.student_id)
        self.assertEqual(payload["displayName"], STUDENT_FALLBACK_NAME)
        self.assertTrue(payload["parentConsent"])
        self.assertTrue(payload["memorySwitch"])
        self.assertEqual(payload["onboardingState"], "not_started")
        # 本地身份列里 school / class / realGrade **连出参形状都没有**
        for absent in ("school", "class", "realGrade"):
            self.assertNotIn(absent, payload)

    def test_identity_display_name_is_sanitized(self) -> None:
        self.store().close()
        self.exec_sql(
            "INSERT INTO identity_local(anon_student_id, real_name) VALUES(?,?)",
            (self.student_id, "小明"),
        )
        self.assertEqual(self.client.get(f"/api/profile/{self.student_id}/identity").json()["displayName"], "小明")
        self.exec_sql(
            "UPDATE identity_local SET real_name=? WHERE anon_student_id=?",
            ("我在XX小学二班", self.student_id),
        )
        self.assertEqual(
            self.client.get(f"/api/profile/{self.student_id}/identity").json()["displayName"],
            STUDENT_FALLBACK_NAME,
        )

    def test_safe_display_name_pure_function(self) -> None:
        self.assertEqual(safe_display_name(""), STUDENT_FALLBACK_NAME)
        self.assertEqual(safe_display_name(None), STUDENT_FALLBACK_NAME)
        self.assertEqual(safe_display_name("小明"), "小明")
        self.assertEqual(safe_display_name("x" * (DISPLAY_NAME_MAX_CHARS + 1)), STUDENT_FALLBACK_NAME)
        self.assertEqual(safe_display_name("13800138000"), STUDENT_FALLBACK_NAME)


# --------------------------------------------------------------------------- #
# 跨学生隔离（G-E 的隔离面）与不变量 G-K
# --------------------------------------------------------------------------- #
class TestIsolationAndHistory(ProfileTagsCase):
    def test_two_students_have_their_own_tags_and_files(self) -> None:
        other = "student_tag_002"
        self.store().close()
        self.store(other).close()
        self.exec_sql("INSERT INTO identity_local(anon_student_id) VALUES(?)", (self.student_id,))
        self.exec_sql("INSERT INTO identity_local(anon_student_id) VALUES(?)", (other,), student_id=other)
        store_a = self.store()
        store_b = self.store(other)
        store_a.upsert_tag(self.student_id, "pace", "慢")
        self.assertEqual({r.key for r in store_a.tags(self.student_id)}, {"pace"})
        self.assertEqual(store_b.tags(other), [])
        self.assertNotEqual(
            student_learning_db_path(self.tmp, self.student_id),
            student_learning_db_path(self.tmp, other),
        )

    def test_learning_history_question_stays_empty(self) -> None:
        """★ G-K：普通学习记录仍然不承载正文 —— question 每一行为空。"""
        response = self.client.post(
            f"/api/profile/{self.student_id}/events",
            json={"activity": "qa", "kpId": "kp-1", "detail": "看了解答"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        rows = self.query("SELECT question FROM learning_history")
        self.assertTrue(rows)
        self.assertTrue(all(str(row["question"] or "") == "" for row in rows))

    def test_events_endpoint_rejects_body_fields(self) -> None:
        """★ 契约 extra=forbid：多带一个 question / text 直接 422。"""
        for body in ({"activity": "qa", "question": "我叫小明"}, {"activity": "qa", "text": "hi"}):
            response = self.client.post(f"/api/profile/{self.student_id}/events", json=body)
            self.assertEqual(response.status_code, 422, response.text)


# --------------------------------------------------------------------------- #
# 票 28：推荐依据从自己的画像投影（禁做 #9）
# --------------------------------------------------------------------------- #
class TestRecommendationBasis(ProfileTagsCase):
    def test_basis_projects_own_tags(self) -> None:
        self.put_tag("explain_style", value="先给结论")
        response = self.client.get(f"/api/profile/{self.student_id}/recommendation")
        self.assertEqual(response.status_code, 200, response.text)
        basis = response.json()["basis"]
        self.assertEqual([item["key"] for item in basis], ["explain_style"])
        self.assertEqual(basis[0]["label"], TAG_LABELS["explain_style"])

    def test_basis_is_empty_without_tags(self) -> None:
        response = self.client.get(f"/api/profile/{self.student_id}/recommendation")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["basis"], [])

    def test_basis_respects_parent_consent(self) -> None:
        self.put_tag("pace", value="慢")
        self.client.put(
            f"/api/profile/{self.student_id}/identity/flags", json={"parentConsent": False}
        )
        response = self.client.get(f"/api/profile/{self.student_id}/recommendation")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["basis"], [])


# --------------------------------------------------------------------------- #
# 持续画像迭代：分档写入（G-M-1 .. G-M-3、G-M-8）与 refresh-apply 路由
# --------------------------------------------------------------------------- #
class TestTagTiering(ProfileTagsCase):
    """★ 用户裁决「自述不覆盖，其余可更新」的可执行形态（执行计划 §2.3 / §5.2）。

    这一组是**安全底线**：分档表错一格，画像就会开始撒谎（学生说的被猜测推翻）。
    每条断言都直接读库里那三列（value / source / confidence）来判，不绕开存储层。
    """

    def test_gm1_declared_is_never_overwritten_by_summary(self) -> None:
        """★★ G-M-1：`declared`（学生亲口说的）**永不**被概括写入覆盖。

        ★ 为什么这条必须独立成测：它是整条回路的安全底线。构造一个学生自述，
          再喂一个**值不同、置信度满格**的概括，断言**值、来源都不变** ——
          只断言"源不变"不够（可能是同值重写），必须连值一起钉死。
        """
        self.put_tag("explain_style", value="先给结论", source="declared")
        response = self.refresh_apply(
            [{"key": "explain_style", "value": "多举生活例子", "confidence": 1.0}]
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        # 被拒，且理由是可诊断的封闭标签（不是静默丢弃）
        self.assertEqual(payload["applied"], [])
        self.assertEqual(
            payload["rejected"], [{"key": "explain_style", "reason": "declared-protected"}]
        )
        row = self.tag_value("explain_style")
        self.assertEqual(str(row["value"]), "先给结论", "学生自述的值不得被覆盖")
        self.assertEqual(str(row["source"]), "declared", "学生自述的来源不得被改写")

    def test_gm2_observed_is_not_overwritten_by_inferred(self) -> None:
        """★ G-M-2：`observed`（系统量到的）不被 `inferred`（模型猜的）覆盖。"""
        self.put_tag("mastery", value="0.80", source="observed", confidence=0.8)
        response = self.refresh_apply(
            [{"key": "mastery", "value": "0.20", "confidence": 0.99}]
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["rejected"], [{"key": "mastery", "reason": "observed-wins"}])
        row = self.tag_value("mastery")
        self.assertEqual(str(row["value"]), "0.80")
        self.assertEqual(str(row["source"]), "observed")

    def test_gm3_inferred_can_be_upgraded_by_observed(self) -> None:
        """★ G-M-3：`inferred` 可被 `observed` **升级**（观察坐实了猜测）。"""
        self.put_tag("pace", value="慢", source="inferred", confidence=0.5)
        response = self.refresh_apply(
            [{"key": "pace", "value": "正常", "source": "observed", "confidence": 0.9}]
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["applied"], ["pace"])
        row = self.tag_value("pace")
        self.assertEqual(str(row["value"]), "正常")
        self.assertEqual(str(row["source"]), "observed", "观察应当坐实猜测并升级来源")

    def test_inferred_needs_higher_confidence_to_replace_inferred(self) -> None:
        """★ 分档表第三行：inferred → inferred 只有**置信度更高**才覆盖。

        ★ 为什么必须有这一条：没有它，每一轮概括都会无脑重写一遍，
          时间线被同一条的重复噪音塞满（且 turn_mark 被无意义刷新，
          影响短期情绪 TTL 的轮次口径）。
        ★ 为什么用 `explain_style` 而不是 `interest_topic`：`inferred` 来源受
          禁做 #10 限制，只能写情绪/风格类 8 个键（见 INFERRED_ALLOWED_TAG_KEYS）——
          拿 `interest_topic` 测会被白名单挡在前一步，测不到本行的逻辑。
        """
        self.put_tag("explain_style", value="先给结论", source="inferred", confidence=0.6)
        # 更低 → 拒
        lower = self.refresh_apply(
            [{"key": "explain_style", "value": "多举例子", "confidence": 0.4}]
        )
        self.assertEqual(
            lower.json()["rejected"],
            [{"key": "explain_style", "reason": "confidence-not-higher"}],
        )
        self.assertEqual(str(self.tag_value("explain_style")["value"]), "先给结论")
        # 更高 → 覆盖
        higher = self.refresh_apply(
            [{"key": "explain_style", "value": "多举例子", "confidence": 0.7}]
        )
        self.assertEqual(higher.json()["applied"], ["explain_style"])
        self.assertEqual(str(self.tag_value("explain_style")["value"]), "多举例子")
        self.assertEqual(str(self.tag_value("explain_style")["source"]), "inferred")

    def test_new_key_is_created(self) -> None:
        """★ 分档表最后一行：库里没有该键 → 直接新增。"""
        response = self.refresh_apply([{"key": "pace", "value": "慢", "confidence": 0.5}])
        self.assertEqual(response.json()["applied"], ["pace"])
        row = self.tag_value("pace")
        self.assertEqual(str(row["value"]), "慢")
        self.assertEqual(str(row["source"]), "inferred", "概括默认来源是 inferred")

    def test_observed_source_can_fill_the_whole_whitelist(self) -> None:
        """★ 概括的两条来源分工（本实现的关键裁决）：

        - `observed` = 学生**在对话里自己表达过**的东西 → 可写全 25 键白名单；
        - `inferred` = 模型**间接推导**出的东西 → 只限情绪/风格 8 键（禁做 #10）。

        ★ 为什么 `observed` 能写 `interest_topic` 这类"非风格"键：它不是"猜学生喜欢什么"，
          而是"学生在对话里说自己喜欢什么"—— 那是**观察到的表达**，不是推断。
          这正是「只把学生自己说过的东西归位」这条纪律在来源层上的落点。
        """
        for key, value in (("interest_topic", "太空"), ("tone", "轻松"), ("scene", "写作业时")):
            self.assertNotIn(key, INFERRED_ALLOWED_TAG_KEYS, f"{key} 不该在推断白名单里")
            response = self.refresh_apply(
                [{"key": key, "value": value, "source": "observed", "confidence": 0.6}]
            )
            self.assertEqual(response.json()["applied"], [key], f"{key} 应可由 observed 写入")
            self.assertEqual(str(self.tag_value(key)["source"]), "observed")

    def test_summary_cannot_declare_source_declared(self) -> None:
        """★ 概括**不得**声称 `declared`（伪造来源）—— 契约层直接 422。

        ★ 为什么是 422 而不是逐条拒：这是**结构性**错误（调用方写错代码），
          重试也一样；而单条不合法（取值域/白名单）才走逐条拒。
        """
        response = self.refresh_apply([{"key": "pace", "value": "慢", "source": "declared"}])
        self.assertEqual(response.status_code, 422, response.text)

    def test_declared_protection_beats_observed_upgrade(self) -> None:
        """★ declared 保护**优先于** observed 升级：来源分档最先判 declared。"""
        self.put_tag("pace", value="慢", source="declared")
        response = self.refresh_apply(
            [{"key": "pace", "value": "快", "source": "observed", "confidence": 1.0}]
        )
        self.assertEqual(response.json()["rejected"], [{"key": "pace", "reason": "declared-protected"}])
        self.assertEqual(str(self.tag_value("pace")["value"]), "慢")


class TestRefreshApplyRoute(ProfileTagsCase):
    """refresh-apply 的路由层行为（逐条独立 / 结构性 422 / 闸）。"""

    def test_gm8_per_item_independent_not_all_or_nothing(self) -> None:
        """★ G-M-8（改述为「逐条独立」）：一条不合法**不拖垮**其它条。"""
        response = self.refresh_apply(
            [
                {"key": "pace", "value": "慢", "confidence": 0.6},       # 合法
                {"key": "family_income", "value": "高"},                  # 非白名单
                {"key": "emotion", "value": "抑郁"},                      # 取值域非法
                {"key": "tone", "value": "轻松", "source": "observed", "confidence": 0.5},  # 合法
            ]
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(sorted(payload["applied"]), ["pace", "tone"])
        self.assertEqual(
            sorted((item["key"], item["reason"]) for item in payload["rejected"]),
            [("emotion", "value-out-of-range"), ("family_income", "whitelist")],
        )

    def test_inferred_limited_keys_are_rejected_with_readable_reason(self) -> None:
        """★ 禁做 #10 在概括路径上同样生效：`inferred` 只能写情绪/风格类键。"""
        response = self.refresh_apply([{"key": "knowledge_point", "value": "变量"}])
        self.assertEqual(
            response.json()["rejected"],
            [{"key": "knowledge_point", "reason": "inferred-not-allowed"}],
        )

    def test_duplicate_key_keeps_first(self) -> None:
        """★ 同一次请求内同键重复 → 留第一条（与五问 parseSummaryTags 去重口径一致）。"""
        response = self.refresh_apply(
            [{"key": "pace", "value": "慢"}, {"key": "pace", "value": "快"}]
        )
        self.assertEqual(response.json()["applied"], ["pace"])
        self.assertEqual(response.json()["rejected"], [{"key": "pace", "reason": "duplicate"}])
        self.assertEqual(str(self.tag_value("pace")["value"]), "慢")

    def test_empty_and_over_limit_are_422(self) -> None:
        """★ 结构性错误 → 422（不做静默截断：编了 20 条不该看起来像正常）。"""
        self.assertEqual(self.refresh_apply([]).status_code, 422)
        self.assertEqual(
            self.refresh_apply([{"key": "pace", "value": f"v{i}"} for i in range(9)]).status_code,
            422,
        )

    def test_empty_value_is_422(self) -> None:
        self.assertEqual(self.refresh_apply([{"key": "pace", "value": ""}]).status_code, 422)

    def test_memory_switch_off_writes_nothing(self) -> None:
        """★ G-F 在概括路径上同样生效：关闸后**一条都不写**（如实回 memory-switch-off）。"""
        self.client.put(
            f"/api/profile/{self.student_id}/identity/flags", json={"memorySwitch": False}
        )
        response = self.refresh_apply([{"key": "pace", "value": "慢"}])
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["applied"], [])
        self.assertEqual(payload["rejected"], [{"key": "pace", "reason": "memory-switch-off"}])
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM profile_tags")[0]["n"], 0)

    def test_response_carries_full_projection(self) -> None:
        """★ 回执带**完整投影 + 维度小标题**：客户端可直接换掉 store，不必再拉一次。"""
        response = self.refresh_apply([{"key": "pace", "value": "慢", "confidence": 0.6}])
        payload = response.json()
        self.assertEqual([tag["key"] for tag in payload["tags"]], ["pace"])
        self.assertEqual(payload["tags"][0]["label"], TAG_LABELS["pace"])
        self.assertEqual(payload["tags"][0]["dimension"], TAG_DIMENSIONS["pace"])
        self.assertIn("dimensionLabels", payload)
        self.assertEqual(
            {int(key) for key in payload["dimensionLabels"]}, set(TAG_DIMENSION_LABELS)
        )

    def test_parent_consent_off_blanks_projection_but_still_writes(self) -> None:
        """★ G-G：parent_consent=0 → 回执里的投影清空，但**落库照常**（落库不算外发）。"""
        self.client.put(
            f"/api/profile/{self.student_id}/identity/flags", json={"parentConsent": False}
        )
        response = self.refresh_apply([{"key": "pace", "value": "慢"}])
        payload = response.json()
        self.assertEqual(payload["applied"], ["pace"], "写入本身不受 parent_consent 影响")
        self.assertEqual(payload["tags"], [], "parent_consent=0 → 投影清空（G-G）")
        self.assertFalse(payload["parentConsent"])
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM profile_tags")[0]["n"], 1)

    def test_tiering_bypassable_by_manual_correction(self) -> None:
        """★ 分档**只约束概括路径**：人工纠错（PUT /tags/{key}）仍可覆盖 declared。

        ★ 这是「不把分档塞进 upsert_tag」的直接理由 —— 学生明确要求改，
          那是唯一允许覆盖自述的路径。这条断言把那个设计意图钉住。
        """
        self.put_tag("pace", value="慢", source="declared")
        # 概括覆不动
        self.refresh_apply([{"key": "pace", "value": "快", "confidence": 1.0}])
        self.assertEqual(str(self.tag_value("pace")["value"]), "慢")
        # 但人工纠错可以
        corrected = self.put_tag("pace", value="中速", source="declared")
        self.assertEqual(corrected.status_code, 200, corrected.text)
        self.assertEqual(str(self.tag_value("pace")["value"]), "中速")


class TestLearnerStyleProjection(ProfileTagsCase):
    """★ 维度 13（2026-09-30）：学习类型的规则投影 + 两个新键的词表闸。

    这一组钉住三件事：
      ① **规则口径**（天赋 / 钻研 / 速通 / 努力）与「样本不足就不写」；
      ② **双路仲裁**：投影写 `observed` → 概括的 `inferred` 推不翻；`inferred` 先占位、
         `observed` 一到就升级 —— 复用既有分档矩阵，**零新代码**；
      ③ **词表闸**：性格与学习类型的值越界一律拒绝（这是红线移动的那道闸）。
    """

    def seed_mastery(self, rows: list[tuple[str, float, int, int]]) -> None:
        """插掌握度行：``[(kp_id, score, attempts, correct), ...]``。"""
        # ★ 先摸一次 store：学生库是**懒创建**的（首次访问才建表 / 跑迁移），
        #   直接 exec_sql 会在库还不存在时报 "unable to open database file"。
        self.store()
        for kp_id, score, attempts, correct in rows:
            self.exec_sql(
                "INSERT OR REPLACE INTO mastery(kp_id, score, attempts, correct, last_seen_at) "
                "VALUES(?,?,?,?,?)",
                (kp_id, score, attempts, correct, 1_700_000_000),
            )

    def project_style(self) -> str | None:
        """走**真实钩子**（`sync_observed_tags`）而不只调内部函数：一并验证挂载。"""
        store = self.store()
        return store.sync_observed_tags(self.student_id).get("learner_style")

    def style_row(self):
        rows = self.query(
            "SELECT value, source, confidence FROM profile_tags "
            "WHERE anon_student_id = ? AND key = 'learner_style'",
            (self.student_id,),
        )
        return rows[0] if rows else None

    # ------------------------------------------------------------ 规则口径 --
    def test_insufficient_sample_writes_nothing(self) -> None:
        """★ 样本门槛：总尝试 < 10 不判定（3 道题打「天赋型」撑不住）。"""
        self.seed_mastery([("kp_a", 1.0, 3, 3)])
        self.assertIsNone(self.project_style())
        self.assertIsNone(self.style_row(), "样本不足时必须一个字都不写（不写「均衡型」垫底）")

    def test_gifted_when_accuracy_is_high(self) -> None:
        self.seed_mastery([("kp_a", 0.9, 12, 11)])  # 11/12 ≈ 0.917 ≥ 0.85
        self.assertEqual(self.project_style(), "天赋型")
        row = self.style_row()
        self.assertEqual(str(row["value"]), "天赋型")
        self.assertEqual(str(row["source"]), "observed", "规则投影的来源必须是 observed")

    def test_deep_when_grinding_the_same_kp(self) -> None:
        """钻研型：每知识点平均尝试 ≥ 3（反复打磨同一处），正确率不高。"""
        self.seed_mastery(
            [("kp_a", 0.5, 4, 2), ("kp_b", 0.5, 4, 2), ("kp_c", 0.5, 4, 2)]
        )  # 总 12 次 / 3 个 kp → per_kp = 4；正确率 0.5（不命中天赋）
        self.assertEqual(self.project_style(), "钻研型")

    def test_fast_when_one_pass_per_kp(self) -> None:
        """速通型：每知识点平均尝试 ≤ 1.5 且正确率 ≥ 0.7。"""
        self.seed_mastery(
            [
                ("kp_a", 0.8, 2, 2),
                ("kp_b", 0.8, 2, 2),
                ("kp_c", 0.8, 2, 1),
                ("kp_d", 0.8, 1, 1),
                ("kp_e", 0.8, 1, 1),
                ("kp_f", 0.8, 1, 0),
                ("kp_g", 0.8, 1, 1),
            ]
        )  # 总 10 次 / 7 个 kp → per_kp ≈ 1.43；正确率 0.8
        self.assertEqual(self.project_style(), "速通型")

    def test_diligent_when_many_attempts_and_low_accuracy(self) -> None:
        """努力型：总尝试够多（或重做占比高）且正确率不高。"""
        rows = [(f"kp_{i}", 0.6, 2, 2 if i < 6 else 1) for i in range(20)]
        # 20 个 kp × 2 次 = 40 次；正确 6*2+14*1 = 26 → 0.65；per_kp = 2（不命中钻研/速通）
        self.seed_mastery(rows)
        self.assertEqual(self.project_style(), "努力型")

    def test_no_style_when_features_are_unremarkable(self) -> None:
        """★ 特征不显著 → 不写（「均衡型」在词表里但规则不主动打）。"""
        rows = [(f"kp_{i}", 0.8, 1, 1) for i in range(6)]
        rows += [(f"kx_{i}", 0.8, 1, 0) for i in range(2)]
        rows += [(f"kq_{i}", 0.8, 6, 4) for i in range(2)]
        # 总 20 次 / 10 个 kp → per_kp = 2；正确率 0.7；重做占比 2/10 = 0.2
        # 天赋 ✗（0.7 < 0.85）钻研 ✗（2 < 3）速通 ✗（2 > 1.5）努力 ✗（20 < 30 且 0.2 < 0.4）
        self.seed_mastery(rows)
        self.assertIsNone(self.project_style())
        self.assertIsNone(self.style_row(), "四条规则都不命中时宁可不写")

    # -------------------------------------------------------- 双路仲裁（跨路径）--
    def test_projection_upgrades_inferred_summary(self) -> None:
        """★ 分档③：概括先写 `inferred`，规则投影一到就**升级**为 `observed`。"""
        self.refresh_apply(
            [{"key": "learner_style", "value": "速通型", "source": "inferred", "confidence": 0.6}]
        )
        self.assertEqual(str(self.style_row()["source"]), "inferred")
        self.seed_mastery([("kp_a", 0.9, 12, 11)])
        self.assertEqual(self.project_style(), "天赋型")
        row = self.style_row()
        self.assertEqual(str(row["value"]), "天赋型")
        self.assertEqual(str(row["source"]), "observed", "观察坐实猜测：来源必须升级")

    def test_projection_beats_inferred_summary(self) -> None:
        """★ 分档②：已有 `observed` 时，概括的 `inferred` 写不进去。"""
        self.seed_mastery([("kp_a", 0.9, 12, 11)])
        self.project_style()
        response = self.refresh_apply(
            [{"key": "learner_style", "value": "努力型", "source": "inferred", "confidence": 1.0}]
        )
        self.assertEqual(
            response.json()["rejected"],
            [{"key": "learner_style", "reason": "observed-wins"}],
        )
        self.assertEqual(str(self.style_row()["value"]), "天赋型", "规则判定的结果模型推不翻")

    def test_projection_origin_is_projection_in_timeline(self) -> None:
        """★ 迁移 v7 的 origin：规则投影写 `projection`（与概括的 `refresh` 分得开）。"""
        self.seed_mastery([("kp_a", 0.9, 12, 11)])
        self.project_style()
        rows = self.query(
            "SELECT origin FROM profile_tag_history WHERE key = 'learner_style' "
            "ORDER BY id DESC LIMIT 1"
        )
        self.assertEqual(str(rows[0]["origin"]), "projection")

    # -------------------------------------------------------- 词表闸（红线）--
    def test_out_of_vocabulary_values_are_rejected_at_write(self) -> None:
        """★ 词表闸（写入侧）：两个新键的值越界一律 ValueError —— 红线移动的那道闸。"""
        store = self.store()
        for key, bad in (
            ("learner_style", "聪明型"),
            ("learner_style", "天赋"),
            ("personality", "抑郁"),
            ("personality", "活泼开朗"),  # 词表外的自由短语也不收（只能是词表里的词）
        ):
            with self.assertRaises(ValueError, msg=f"{key}={bad!r} 必须被取值域拒绝"):
                store.upsert_tag(self.student_id, key, bad, source="observed")
        # 词表内的值可写（inferred 也在限键里）
        self.assertTrue(
            store.upsert_tag(self.student_id, "personality", "好奇", source="inferred", confidence=0.6)
        )
        self.assertEqual(str(self.tag_value("personality")["value"]), "好奇")

    def test_personality_from_summary_requires_vocabulary(self) -> None:
        """★ 概括路径同样过闸：词表外的值被拒（`value-out-of-range`），词表内的可写。"""
        bad = self.refresh_apply(
            [{"key": "personality", "value": "活泼开朗", "source": "inferred"}]
        )
        self.assertEqual(
            bad.json()["rejected"],
            [{"key": "personality", "reason": "value-out-of-range"}],
        )
        good = self.refresh_apply(
            [{"key": "personality", "value": "爱提问", "source": "inferred", "confidence": 0.6}]
        )
        self.assertEqual(good.json()["applied"], ["personality"])

    def test_vocabularies_match_typescript_source(self) -> None:
        """★ 两个词表与 TS 真源**逐字一致（顺序也算）** —— 只改一边必红。"""
        ts_path = ROOT.parent / "desktop" / "src" / "shared" / "profile-tags.ts"
        source = ts_path.read_text(encoding="utf-8")
        for name, py_values in (
            ("LEARNER_STYLE_VALUES", LEARNER_STYLE_VALUES),
            ("PERSONALITY_VALUES", PERSONALITY_VALUES),
        ):
            match = re.search(rf"export const {name} = \[([\s\S]*?)\] as const", source)
            self.assertIsNotNone(match, f"TS 里找不到 {name}（真源被改名了？）")
            ts_values = tuple(re.findall(r"'([^']+)'", match.group(1)))
            self.assertEqual(ts_values, tuple(py_values), f"{name} 必须与 TS 真源逐字一致")

    def test_zpd_values_are_readable_by_the_typescript_tier_resolver(self) -> None:
        """★★ 跨语言：`zpd_level` 的**每个**生产值都必须被 TS 侧认得。

        ★ 为什么必须有这一条：`sync_zpd_level` 写的是中文显示值，
          而真正消费它的是 `desktop/src/main/agent/prompts/adaptation.ts` 的
          `WORD_TIERS` 映射。两边各写一份、又没有任何东西钉住它们一致 ——
          一旦后端改了一个词（比如把「偏难」写成「较难」），TS 侧认不出，
          `resolveDifficultyTier()` 就**静默回落「正常」**，难度微调再次失效，
          而且没有任何报错（这正是本键此前「接好了但没通电」的同一类故障）。
        """
        ts_path = ROOT.parent / "desktop" / "src" / "main" / "agent" / "prompts" / "adaptation.ts"
        source = ts_path.read_text(encoding="utf-8")
        match = re.search(r"const WORD_TIERS[^=]*=\s*\{([\s\S]*?)\n\}", source)
        self.assertIsNotNone(match, "TS 里找不到 WORD_TIERS（难度档的中文词表被改名了？）")
        known = set(re.findall(r"([^\s:,{}]+):\s*'(?:easier|normal|harder)'", match.group(1)))
        for value in ZPD_LEVEL_VALUES:
            self.assertIn(
                value,
                known,
                f"后端会写 zpd_level={value!r}，但 TS 的 WORD_TIERS 认不出它 —— "
                "那样难度微调会静默回落「正常」",
            )

    def test_vocabulary_has_no_clinical_words(self) -> None:
        """★ 词表本身不得含临床词汇（红线移动那道闸的实质）。"""
        joined = "".join(PERSONALITY_VALUES) + "".join(LEARNER_STYLE_VALUES)
        for word in ("抑郁", "焦虑", "多动", "自闭", "障碍", "症", "人格"):
            self.assertNotIn(word, joined, f"词表不得含临床词汇：{word}")


if __name__ == "__main__":
    unittest.main()
