# -*- coding: utf-8 -*-
"""票 09：一人一库落盘 + 画像读取 + 学习记录回流（``/api/profile/*``）。

这一组断言盯住四条「错了就静默出事」的红线：

1. ★ **一人一库**：两个学生的数据落在各自的 ``students/<id>/learning.db`` 里，
   互相不可见（不是同一个库、不是同一条连接）；
2. ★ **不存对话正文**：契约 ``extra="forbid"`` 把 ``question`` / ``text`` 这类字段直接挡在
   400/422 上；``learning_history.question`` 列**永远为空**；
3. **冷启动兜底**：学生还没建就用到了学习记录 → 自动建学生行与库（不丢数据、不 500），
   迁移器重复跑不报错、不重复建表（``schema_version`` 记账）；
4. **重启后仍在**：库是文件、行数不减、``student.last_active_at`` 会刷新（可查表验证）。

⚠️ ``main.py`` 尚未 ``include_router`` 画像路由（票 09 报备，见报告）；
本文件与 ``tests/test_quiz.py`` 一样**显式挂载**，这样 HTTP 层（含鉴权中间件、pydantic 校验、
序列化 camelCase）都能真跑到。

跑法::

    cd server && uv run python -m unittest discover -s tests
"""

from __future__ import annotations

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
from app.routes.profile import router as profile_router  # noqa: E402
from app.routes.students import (  # noqa: E402
    LEARNING_DB_NAME,
    STUDENTS_STORE_ATTR,
    InMemoryStudentStore,
    LearningDbStudentStore,
    list_student_ids,
    student_dir,
    student_learning_db_path,
    validate_student_id,
)

TOKEN = "test-token-profile"


class ProfileCase(unittest.TestCase):
    """带临时 userData 的基类：真实一人一库落在 tmp 里，绝不碰开发机的真实数据。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config(token=TOKEN, data_dir=self.tmp))
        # 画像路由由 main.py 维护者登记（票 09 报备）；这里显式挂载以便端到端跑 HTTP。
        self.app.include_router(profile_router)
        self.client = TestClient(self.app)
        self.headers = {"X-Auth-Token": TOKEN}
        self.client.headers.update(self.headers)

    # ------------------------------------------------------------ 小工具 --
    def create_student(self, nickname: str, grade_level: str) -> dict:
        response = self.client.post(
            "/api/students", json={"nickname": nickname, "gradeLevel": grade_level}
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def post_event(self, student_id: str, **body) -> object:
        return self.client.post(f"/api/profile/{student_id}/events", json=body)

    def query(self, student_id: str, sql: str) -> list[sqlite3.Row]:
        conn = sqlite3.connect(student_learning_db_path(self.tmp, student_id))
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(sql).fetchall()
        finally:
            conn.close()


# --------------------------------------------------------------------------- #
# 一人一库
# --------------------------------------------------------------------------- #
class TestPerStudentStorage(ProfileCase):
    def test_create_student_writes_own_database(self) -> None:
        first = self.create_student("小低", "primary_low")
        second = self.create_student("初中生", "junior")

        self.assertEqual(first["studentId"], "student_001")
        self.assertEqual(second["studentId"], "student_002")
        # 契约的出参是 camelCase + 毫秒时间戳
        self.assertIn("createdAt", first)
        self.assertGreater(first["createdAt"], 1_600_000_000_000, "时间戳应当是毫秒")
        self.assertEqual(first["lastActiveAt"], first["createdAt"])

        # 一人一份库文件，且都在自己的目录里
        for student in (first, second):
            db = student_learning_db_path(self.tmp, student["studentId"])
            self.assertTrue(db.exists(), f"{student['studentId']} 的库没建出来：{db}")
            self.assertEqual(db.parent.name, student["studentId"])
            self.assertEqual(db.parent.parent.name, "students")
            self.assertEqual(db.name, LEARNING_DB_NAME)

        # 列表能读回两个学生（每个库各读一次、读完就关）
        listed = self.client.get("/api/students").json()
        self.assertEqual([item["studentId"] for item in listed], ["student_001", "student_002"])
        self.assertEqual(list_student_ids(self.tmp), ["student_001", "student_002"])

    def test_two_students_do_not_share_data(self) -> None:
        a = self.create_student("甲", "primary_low")["studentId"]
        b = self.create_student("乙", "senior")["studentId"]

        self.assertEqual(self.post_event(a, activity="quiz", kpId="kp-a", isCorrect=True).status_code, 200)
        self.assertEqual(self.post_event(b, activity="coding", kpId="kp-b", isCorrect=False).status_code, 200)
        self.assertEqual(self.post_event(b, activity="qa").status_code, 200)

        rows_a = self.query(a, "SELECT kp_id, activity FROM learning_history")
        rows_b = self.query(b, "SELECT kp_id, activity FROM learning_history")
        self.assertEqual([(r["kp_id"], r["activity"]) for r in rows_a], [("kp-a", "quiz")])
        self.assertEqual(
            sorted((r["kp_id"], r["activity"]) for r in rows_b),
            [("", "qa"), ("kp-b", "coding")],
        )
        # 两个库文件必须不同（防止「一个库被两个学生共用」这种最糟的形态）
        self.assertNotEqual(
            student_learning_db_path(self.tmp, a), student_learning_db_path(self.tmp, b)
        )

    def test_student_id_whitelist_blocks_path_traversal(self) -> None:
        """★ 学生 id 会被拼进路径：穿越、绝对路径、空串一律拒绝。"""
        for bad in ["../student_002", "..\\x", "C:\\Windows", "a/b", "", "..", "x" * 65]:
            with self.assertRaises(Exception) as ctx:
                validate_student_id(bad)
            self.assertIn("不合法", str(ctx.exception))

        # 真正走 HTTP 时也是 422（不是 500、更不是「真的读了别的文件」）
        for bad in ["..", "..%2Fstudent_002"]:
            response = self.post_event(bad, activity="qa")
            self.assertIn(response.status_code, (404, 422), response.text)

    def test_store_swap_via_app_state_still_works(self) -> None:
        """注入点保留：`app.state.students_store` 可替换实现（单测与其它轨都在用）。"""
        setattr(self.app.state, STUDENTS_STORE_ATTR, InMemoryStudentStore())
        created = self.create_student("内存甲", "primary_high")
        self.assertEqual(created["studentId"], "student_001")
        # 内存实现不落盘 —— 这才是「注入生效」的证据
        self.assertFalse(student_learning_db_path(self.tmp, "student_001").exists())
        delattr(self.app.state, STUDENTS_STORE_ATTR)

    def test_no_explicit_data_dir_does_not_touch_repo_directory(self) -> None:
        """★ 没有显式 ``--data-dir`` 时**绝不**把学生写进共享的兜底目录。

        `app.config.resolve_data_dir(None)` 的兜底是 ``server/_data``（仓库内、被多次运行共享）：
        拿它当学生数据根，单测与手工 curl 会互相污染（实测踩到：跑一次全量单测就留下 12 个学生目录，
        契约测试「学生列表初始为空」随即变红）。真实运行一定带 ``--data-dir``，
        所以这里要求「没带就退回内存实现」，并把画像/学习记录路由判成 503。
        """
        app = create_app(build_runtime_config(token=TOKEN))  # 不传 data_dir
        app.include_router(profile_router)
        client = TestClient(app, headers={"X-Auth-Token": TOKEN})

        created = client.post("/api/students", json={"nickname": "无目录", "gradeLevel": "junior"})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(client.get("/api/students").json()[0]["studentId"], "student_001")
        # 画像路由明确 503（可读原因），而不是悄悄写到共享目录里
        self.assertEqual(client.get("/api/profile/student_001").status_code, 503)
        self.assertEqual(client.post("/api/profile/student_001/events", json={"activity": "qa"}).status_code, 503)
        self.assertIn("data-dir", client.get("/api/profile/student_001").json()["detail"])

        # 兜底目录没有被本用例写脏
        from app.config import resolve_data_dir

        self.assertFalse(
            (resolve_data_dir(None) / "students" / "student_001").exists(),
            "默认兜底目录是**共享**的，不该出现本用例创建的学生目录",
        )

    def test_learning_db_store_is_directly_usable(self) -> None:
        store = LearningDbStudentStore(self.tmp)
        created = store.create_student(nickname="直接建", grade_level="junior")
        self.assertEqual(created.student_id, "student_001")
        self.assertEqual(created.grade_level, "junior")
        self.assertIsNotNone(store.get_student("student_001"))
        self.assertIsNone(store.get_student("student_404"))
        self.assertEqual([s.student_id for s in store.list_students()], ["student_001"])


# --------------------------------------------------------------------------- #
# 学习记录写入
# --------------------------------------------------------------------------- #
class TestLearningEvents(ProfileCase):
    def test_four_activity_kinds_are_all_accepted_and_persisted(self) -> None:
        student_id = self.create_student("四类活动", "junior")["studentId"]
        cases = [
            ("qa", {"sessionId": "sess-1", "detail": "对话轮次结束"}),
            ("animation", {"kpId": "jr-py-loop", "detail": "观看动画讲解"}),
            ("coding", {"kpId": "jr-py-loop", "isCorrect": True, "detail": "代码运行与评估"}),
            ("quiz", {"kpId": "jr-py-loop", "isCorrect": False, "detail": "提交作答"}),
        ]
        for activity, extra in cases:
            response = self.post_event(student_id, activity=activity, **extra)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), {"ok": True})

        rows = self.query(
            student_id,
            "SELECT activity, kp_id, session_id, is_correct, detail FROM learning_history ORDER BY id",
        )
        self.assertEqual([r["activity"] for r in rows], ["qa", "animation", "coding", "quiz"])
        self.assertEqual(rows[0]["session_id"], "sess-1")
        self.assertEqual(rows[2]["is_correct"], 1)
        self.assertEqual(rows[3]["is_correct"], 0)
        self.assertEqual(rows[0]["detail"], "对话轮次结束")

    def test_sqlite_never_stores_conversation_body(self) -> None:
        """★★ 合规红线：对话正文不进 SQLite。"""
        student_id = self.create_student("正文", "primary_low")["studentId"]

        # ① 契约 extra="forbid"：夹带正文的字段直接 422（而不是「被忽略、悄悄存下来」）
        for body in (
            {"activity": "qa", "question": "老师，为什么循环不会停？"},
            {"activity": "qa", "text": "学生原话"},
            {"activity": "qa", "answer": "A"},
        ):
            response = self.post_event(student_id, **body)
            self.assertEqual(response.status_code, 422, f"夹带正文字段必须 422：{body}")

        # ② detail 只允许一句说明（限长 200，且压成单行）
        too_long = self.post_event(student_id, activity="qa", detail="啊" * 500)
        self.assertEqual(too_long.status_code, 422)
        multiline = self.post_event(student_id, activity="qa", detail="第一行\n第二行")
        self.assertEqual(multiline.status_code, 200)
        rows = self.query(student_id, "SELECT question, detail FROM learning_history ORDER BY id")
        self.assertEqual(rows[-1]["detail"], "第一行 第二行")
        # ③ question 列永远为空 —— 全表扫一遍（这是「不存正文」最直接的证据）
        self.assertEqual(
            self.query(student_id, "SELECT COUNT(*) AS n FROM learning_history WHERE question != ''")[0]["n"],
            0,
        )

    def test_unknown_student_is_bootstrapped_cold_start(self) -> None:
        """冷启动兜底：还没建学生的 id 也能写记录（自动建库 + 建学生行）。"""
        response = self.post_event("student_777", activity="qa", gradeLevel="senior")
        self.assertEqual(response.status_code, 200, response.text)

        db = student_learning_db_path(self.tmp, "student_777")
        self.assertTrue(db.exists())
        rows = self.query("student_777", "SELECT student_id, grade_level FROM student")
        self.assertEqual([(r["student_id"], r["grade_level"]) for r in rows], [("student_777", "senior")])
        # 没有给学段时退到冷启动默认值（不要在库里留 NULL 让前端炸）
        self.assertEqual(self.post_event("student_778", activity="qa").status_code, 200)
        self.assertEqual(
            self.query("student_778", "SELECT grade_level FROM student")[0]["grade_level"],
            "primary_high",
        )

    def test_migration_is_idempotent_and_records_version(self) -> None:
        """迁移器：重复开库不报错、不重复建表、版本只记一条。"""
        student_id = self.create_student("幂等", "junior")["studentId"]
        for _ in range(3):
            store = LearningDbStudentStore(self.tmp)
            self.assertIsNotNone(store.get_student(student_id))
        rows = self.query(student_id, "SELECT set_name, version FROM schema_version")
        self.assertEqual([(r["set_name"], r["version"]) for r in rows], [("learning", 1)])
        tables = {
            r["name"]
            for r in self.query(
                student_id, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        }
        for expected in ("student", "mastery", "learning_history", "progress", "profile_pref", "grade_signals"):
            self.assertIn(expected, tables)

    def test_last_active_at_is_refreshed(self) -> None:
        """`student.last_active_at` 随写入刷新（「重启后数据仍在」这条验收要看它）。"""
        student_id = self.create_student("活跃", "junior")["studentId"]
        before = self.query(student_id, "SELECT last_active_at FROM student")[0]["last_active_at"]
        time.sleep(1.05)  # learning.db 的时间戳是**秒**，sleep 到下一秒才看得出变化
        self.assertEqual(self.post_event(student_id, activity="qa").status_code, 200)
        after = self.query(student_id, "SELECT last_active_at FROM student")[0]["last_active_at"]
        self.assertGreater(after, before)
        # 行数不减（重启不清库）
        self.assertEqual(self.query(student_id, "SELECT COUNT(*) AS n FROM learning_history")[0]["n"], 1)


# --------------------------------------------------------------------------- #
# 画像读取
# --------------------------------------------------------------------------- #
class TestProfileRead(ProfileCase):
    def test_profile_returns_contract_shape(self) -> None:
        student_id = self.create_student("画像", "primary_high")["studentId"]
        self.post_event(student_id, activity="quiz", kpId="ph-loop", isCorrect=True, detail="提交作答")
        self.post_event(student_id, activity="quiz", kpId="ph-var", isCorrect=False, detail="提交作答")
        # 掌握度由练习轨（票 14/15）写；这里直接改库模拟「已经答过题」
        conn = sqlite3.connect(student_learning_db_path(self.tmp, student_id))
        try:
            conn.execute(
                "INSERT INTO mastery(kp_id, score, attempts, correct, last_seen_at) VALUES(?,?,?,?,?)",
                ("ph-loop", 0.8, 3, 3, int(time.time())),
            )
            conn.execute("INSERT INTO profile_pref(key, value) VALUES('pace', 'slow')")
            conn.commit()
        finally:
            conn.close()

        response = self.client.get(f"/api/profile/{student_id}")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(sorted(body), ["mastery", "preferences", "recommendedKpIds", "student"])
        self.assertEqual(body["student"]["studentId"], student_id)
        self.assertEqual(body["student"]["gradeLevel"], "primary_high")
        self.assertEqual(body["mastery"][0]["kpId"], "ph-loop")
        self.assertAlmostEqual(body["mastery"][0]["score"], 0.8)
        self.assertGreater(body["mastery"][0]["lastSeenAt"], 1_600_000_000_000, "lastSeenAt 应当是毫秒")
        self.assertEqual(body["preferences"], {"pace": "slow"})
        # 推荐路径属票 20（依赖图 + 掌握度）；**宁可留空也不猜**
        self.assertEqual(body["recommendedKpIds"], [])

    def test_missing_student_is_404_with_readable_detail(self) -> None:
        response = self.client.get("/api/profile/student_999")
        self.assertEqual(response.status_code, 404)
        self.assertIn("student_999", response.json()["detail"])

    def test_invalid_student_id_is_422(self) -> None:
        """非法 id 一律 422（**不是** 404、更不是 500）：它会被拼进文件系统路径。"""
        for bad in ("x" * 65, "a b", "学段001"):
            response = self.client.get(f"/api/profile/{bad}")
            self.assertEqual(response.status_code, 422, f"{bad!r} 应当被 422 拒绝：{response.text}")
        # ⚠️ `..` 这类点段会被 HTTP 客户端/服务端**在到达路由前规范化掉**（`/api/profile/..` → `/api`），
        #    所以「路径穿越」这条只能在**函数级**验证（见 TestPerStudentStorage 的白名单用例）；
        #    这里只断言它不可能是 200。
        self.assertNotEqual(self.client.get("/api/profile/..%2Fetc").status_code, 200)

    def test_profile_routes_require_token(self) -> None:
        """鉴权中间件对画像/学习记录同样生效（它们是学生数据）。"""
        anonymous = TestClient(self.app)
        self.assertEqual(anonymous.get("/api/profile/student_001").status_code, 401)
        self.assertEqual(
            anonymous.post("/api/profile/student_001/events", json={"activity": "qa"}).status_code,
            401,
        )


# --------------------------------------------------------------------------- #
# 与桌面端的对齐
# --------------------------------------------------------------------------- #
class TestDesktopAlignment(unittest.TestCase):
    def test_directory_names_match_desktop_pi_paths(self) -> None:
        """``students`` / ``learning.db`` / ``pi-agent`` 这套目录名两端必须一致。

        直接读桌面端的 ``pi-paths.ts`` 比对常量（不是「我记得是一样的」）——
        两边一旦漂移，桌面端写会话、Python 读画像就会指向不同目录，表现为「画像永远是空的」。
        """
        source = (ROOT.parent / "desktop" / "src" / "main" / "agent" / "pi-paths.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn("STUDENTS_DIR_NAME = 'students'", source)
        self.assertIn("LEARNING_DB_NAME = 'learning.db'", source)
        self.assertIn("PI_APP_DIR_NAME = 'pi-agent'", source)

    def test_student_dir_layout(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        try:
            self.assertEqual(student_dir(tmp, "student_001"), tmp / "students" / "student_001")
            self.assertEqual(
                student_learning_db_path(tmp, "student_001"),
                tmp / "students" / "student_001" / "learning.db",
            )
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
