# -*- coding: utf-8 -*-
"""账号 CRUD 的 PATCH / DELETE（``/api/students``）：改名、改学段、删号。

这一组断言盯住五条「错了就静默出事」的红线：

1. ★ **改学段连带清空当前章节**（与 ``app/grade/rules.py`` 的学段写入同一口径，D-038），
   而**只改昵称不许碰章节** —— 后者是「顺手把学生选好的教材弄丢」的常见形态；
2. ★ **删号只删校验通过的学生目录**：``../`` 一类的 id 必须在**触达文件系统之前**
   被挡掉（否则就是「HTTP 上的任意目录删除」）；
3. ★ **删号是幂等的**：号不存在回 ``deleted: false`` 而不是 404 ——
   连点两次不该把「已经没了」报成「操作失败」，界面也不该为它写特例；
4. **改 / 删都不改契约形状**：PATCH 回完整 ``Student``（camelCase、字段集合冻结，
   与 ``GET /api/students`` 的列表项一字不差），DELETE 回 ``{studentId, deleted}``；
5. **一人一库互不牵连**：删掉一个学生的目录，另一个学生的库文件仍在。

跑法::

    cd server && uv run python -m unittest tests.test_students_api -v
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import build_runtime_config  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes.students import (  # noqa: E402
    open_learning_store,
    student_dir,
    student_learning_db_path,
    validate_student_id,
)

TOKEN = "test-token-students-api"

#: ``Student`` 的出参字段集合（冻结）：PATCH 回的必须与列表项一致。
STUDENT_FIELDS = [
    "createdAt",
    "currentChapter",
    "gradeLevel",
    "lastActiveAt",
    "nickname",
    "studentId",
]


class StudentsApiCase(unittest.TestCase):
    """带临时 userData 的基类：真实一人一库落在 tmp 里，绝不碰开发机的真实数据。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config(token=TOKEN, data_dir=self.tmp))
        self.client = TestClient(self.app)
        self.client.headers.update({"X-Auth-Token": TOKEN})

    # ------------------------------------------------------------ 小工具 --
    def create_student(self, nickname: str, grade_level: str) -> dict:
        response = self.client.post(
            "/api/students", json={"nickname": nickname, "gradeLevel": grade_level}
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def patch_student(self, student_id: str, body: dict):
        return self.client.patch("/api/students/" + student_id, json=body)

    def delete_student(self, student_id: str):
        return self.client.delete("/api/students/" + student_id)

    def list_students(self) -> list[dict]:
        response = self.client.get("/api/students")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def set_chapter(self, student_id: str, title: str) -> None:
        """摆「学生已经选了章节」这个前提，走该列的**唯一**写入口径（不在这里拼 UPDATE）。"""
        store = open_learning_store(self.tmp, student_id)
        try:
            store.set_current_chapter(student_id, title)
        finally:
            store.close()

    def read_chapter(self, student_id: str) -> str:
        store = open_learning_store(self.tmp, student_id)
        try:
            return store.current_chapter(student_id)
        finally:
            store.close()


# --------------------------------------------------------------------------- #
# PATCH：改名 / 改学段
# --------------------------------------------------------------------------- #
class TestPatchStudent(StudentsApiCase):
    def test_patch_nickname_updates_and_reads_back(self) -> None:
        created = self.create_student("小海", "junior")
        response = self.patch_student(created["studentId"], {"nickname": "小海二号"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["nickname"], "小海二号")
        self.assertEqual(body["gradeLevel"], "junior", "没提交的字段必须保持原值")
        self.assertEqual(sorted(body), STUDENT_FIELDS, "PATCH 的出参形状与列表项一致")

        listed = {item["studentId"]: item for item in self.list_students()}
        self.assertEqual(
            listed[created["studentId"]]["nickname"], "小海二号", "改名必须真的落盘，不是只改了回声"
        )

    def test_patch_grade_clears_current_chapter(self) -> None:
        created = self.create_student("小海", "junior")
        student_id = created["studentId"]
        self.set_chapter(student_id, "第1章 认识人工智能")

        response = self.patch_student(student_id, {"gradeLevel": "senior"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["gradeLevel"], "senior")
        self.assertEqual(response.json()["currentChapter"], "", "换学段必须清空章节")
        self.assertEqual(self.read_chapter(student_id), "", "库里也必须真的清掉（读回仍是空串）")

    def test_patch_same_grade_keeps_current_chapter(self) -> None:
        """只改昵称、或提交**同一个**学段，都不该碰章节：判据是「学段真的变了」。"""
        created = self.create_student("小海", "junior")
        student_id = created["studentId"]
        self.set_chapter(student_id, "第1章 认识人工智能")

        renamed = self.patch_student(student_id, {"nickname": "小海二号"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["currentChapter"], "第1章 认识人工智能")

        same_grade = self.patch_student(student_id, {"gradeLevel": "junior"})
        self.assertEqual(same_grade.status_code, 200, same_grade.text)
        self.assertEqual(same_grade.json()["currentChapter"], "第1章 认识人工智能")
        self.assertEqual(self.read_chapter(student_id), "第1章 认识人工智能")

    def test_patch_both_fields_at_once(self) -> None:
        created = self.create_student("小海", "junior")
        response = self.patch_student(
            created["studentId"], {"nickname": "新名字", "gradeLevel": "primary_low"}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["nickname"], "新名字")
        self.assertEqual(response.json()["gradeLevel"], "primary_low")

    def test_patch_empty_body_is_a_read_back(self) -> None:
        """空 body = 「什么都不改」，回当前值：前端可以只提交改动项，不必先读再写。"""
        created = self.create_student("小海", "junior")
        self.set_chapter(created["studentId"], "第1章 认识人工智能")

        response = self.patch_student(created["studentId"], {})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["nickname"], "小海")
        self.assertEqual(response.json()["currentChapter"], "第1章 认识人工智能")

    def test_patch_unknown_field_is_rejected(self) -> None:
        created = self.create_student("小海", "junior")
        response = self.patch_student(created["studentId"], {"realName": "张三"})
        self.assertEqual(response.status_code, 422, "契约外字段（真实姓名）必须被拒")

    def test_patch_invalid_grade_is_rejected(self) -> None:
        created = self.create_student("小海", "junior")
        response = self.patch_student(created["studentId"], {"gradeLevel": "university"})
        self.assertEqual(response.status_code, 422, "学段只允许四个字面量")

    def test_patch_blank_nickname_is_rejected(self) -> None:
        created = self.create_student("小海", "junior")
        response = self.patch_student(created["studentId"], {"nickname": "   "})
        self.assertEqual(response.status_code, 422)

    def test_patch_missing_student_is_404(self) -> None:
        response = self.patch_student("student_999", {"nickname": "查无此人"})
        self.assertEqual(response.status_code, 404, response.text)

    def test_patch_rejects_illegal_student_id(self) -> None:
        """非法 id 必须在校验层被挡。

        ★ 含 ``/`` 的 id（``..%2Fx``）可能连路由参数的正则都匹配不上（404），
          能匹配上的（``bad id`` / ``bad!id``）必须 422 —— 两条路都到不了存储层，
          所以这里断言的是「不是 200 且没改到任何人」。
        """
        created = self.create_student("小海", "junior")
        for bad_id in ("bad%20id", "bad%21id", "..%2Fx"):
            response = self.patch_student(bad_id, {"nickname": "改名"})
            self.assertIn(response.status_code, (404, 422), response.text)

        listed = self.list_students()
        self.assertEqual(listed[0]["studentId"], created["studentId"])
        self.assertEqual(listed[0]["nickname"], "小海", "非法 id 不该改到任何人")


# --------------------------------------------------------------------------- #
# DELETE：删号与删目录
# --------------------------------------------------------------------------- #
class TestDeleteStudent(StudentsApiCase):
    def test_delete_removes_student_and_its_directory(self) -> None:
        first = self.create_student("小海", "junior")
        second = self.create_student("小江", "senior")
        first_id, second_id = first["studentId"], second["studentId"]
        self.assertTrue(student_dir(self.tmp, first_id).is_dir())

        response = self.delete_student(first_id)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(sorted(response.json()), ["deleted", "studentId"])
        self.assertEqual(response.json(), {"studentId": first_id, "deleted": True})

        self.assertFalse(student_dir(self.tmp, first_id).exists(), "学生目录必须整个消失")
        self.assertEqual(
            [item["studentId"] for item in self.list_students()], [second_id], "列表里不该再有它"
        )
        self.assertTrue(
            student_learning_db_path(self.tmp, second_id).exists(), "另一个人一人一库不受牵连"
        )

    def test_delete_missing_student_is_deleted_false(self) -> None:
        response = self.delete_student("student_999")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"studentId": "student_999", "deleted": False})

    def test_delete_is_idempotent(self) -> None:
        created = self.create_student("小海", "junior")
        first = self.delete_student(created["studentId"])
        second = self.delete_student(created["studentId"])
        self.assertEqual(first.json()["deleted"], True)
        self.assertEqual(second.json()["deleted"], False, "第二次是「本来就没有」，不是失败")

    def test_delete_rejects_illegal_student_id_before_filesystem(self) -> None:
        """删目录是本组最危险的一步：非法 id 必须在 rmtree 之前被挡。"""
        sentinel = self.tmp / "keep.txt"
        sentinel.write_text("别删我", encoding="utf-8")
        for bad_id in ("bad%20id", "bad%21id", "..%2Fx"):
            response = self.delete_student(bad_id)
            self.assertIn(response.status_code, (404, 422), response.text)
        self.assertTrue(sentinel.exists(), "非法 id 绝不能触达文件系统")

    def test_delete_requires_token(self) -> None:
        created = self.create_student("小海", "junior")
        anonymous = TestClient(self.app)
        response = anonymous.delete("/api/students/" + created["studentId"])
        self.assertEqual(response.status_code, 401)
        self.assertTrue(student_dir(self.tmp, created["studentId"]).is_dir(), "未鉴权不许删任何东西")


# --------------------------------------------------------------------------- #
# id 白名单（改名前 / 删目录前必须过的那道闸）
# --------------------------------------------------------------------------- #
class TestStudentIdWhitelist(StudentsApiCase):
    def test_validate_student_id_rejects_traversal_and_junk(self) -> None:
        """「../x」这类 id 在**任何路径拼接之前**就必须 422（两个路由都先调它）。

        ★ 这里直接点名校验函数：HTTP 层对含「/」的 id 先在路由正则上匹配失败（404），
          只断言 HTTP 状态码看不出「白名单本身挡不挡得住」，而它是防路径穿越的唯一落点。
        """
        for bad_id in ("../x", "..", "a/b", "a\\b", "", "x" * 65, "学生"):
            with self.assertRaises(HTTPException) as ctx:
                validate_student_id(bad_id)
            self.assertEqual(ctx.exception.status_code, 422, bad_id)

    def test_validate_student_id_accepts_what_the_server_generates(self) -> None:
        self.assertEqual(validate_student_id("student_001"), "student_001")
# --------------------------------------------------------------------------- #
# 称呼 → 昵称的同步与存量自愈（2026-10-04 用户报障）
# --------------------------------------------------------------------------- #
class TestDisplayNameReconcile(StudentsApiCase):
    """库里**同一个人只许有一个名字**。

    用户原话：「画像部分为什么切账号以后 画像部分的名字什么没有更新 你是不是忘记做
    联动机制了」。查出来**不是没联动**，是库里有两个名字源且从不同步：
      · student.nickname         ← 账号列表 / 侧栏身份卡 读它
      · identity_local.real_name ← GET /profile/{id}/identity 的 displayName，
                                   画像 / 问候语 读它
    于是同一屏：侧栏「同学」、右栏真名。这一组盯住"修好了，且不许退化"。
    """

    def set_real_name(self, student_id: str, real_name: str) -> None:
        """走**唯一**的称呼写入口（与渲染层同一条路：PUT identity/flags）。"""
        response = self.client.put(
            f"/api/profile/{student_id}/identity/flags", json={"realName": real_name}
        )
        self.assertEqual(response.status_code, 200, response.text)

    def read_real_name(self, student_id: str) -> str:
        response = self.client.get(f"/api/profile/{student_id}/identity")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["realName"]

    def read_nickname(self, student_id: str) -> str:
        """**直接读库**里的昵称 —— 不经过列表接口。

        ★★ 为什么必须绕开列表：列表现在带**存量自愈**，而自愈判据是
          「昵称还是回落值 → 用称呼补上」。如果在这里走列表，自愈会**替**同步把名字改对，
          于是"写入时没同步"这个变异被自愈掩盖 —— 那条断言就不是在守同步了
          （实测踩到：变异 144「设称呼时不再同步昵称」照样绿）。
        """
        store = open_learning_store(self.tmp, student_id)
        try:
            record = store.get_student(student_id)
        finally:
            store.close()
        self.assertIsNotNone(record)
        return record.nickname if record is not None else ""

    def test_setting_real_name_syncs_nickname(self) -> None:
        """★ 设称呼 = **写入当时**就把昵称定下来（源头同步）。

        ⚠️ 学生**自己起过名**这个前提是刻意的：自愈只在"昵称还是回落值"时动手，
          所以只有昵称非回落值时，这条断言才真的在量"写入时同步"而不动量自愈。
        """
        created = self.create_student("小海", "junior")
        self.set_real_name(created["studentId"], "思远")

        self.assertEqual(
            self.read_nickname(created["studentId"]),
            "思远",
            "设过称呼之后昵称必须**在写入当时**同步 —— 否则同一屏两个名字",
        )
        self.assertEqual(self.read_real_name(created["studentId"]), "思远")

    def test_blank_real_name_does_not_erase_the_nickname(self) -> None:
        """★ 清空称呼**不许**把学生自己起的名字抹掉。"""
        created = self.create_student("小海", "junior")
        self.set_real_name(created["studentId"], "同学")  # 命中回落值 → 入库存空串
        listed = {item["studentId"]: item for item in self.list_students()}
        self.assertEqual(
            listed[created["studentId"]]["nickname"],
            "小海",
            "称呼回落到「同学」时不许覆盖昵称 —— 那是学生自己在账号菜单里起的名字",
        )

    def test_list_heals_nickname_from_existing_real_name(self) -> None:
        """★★ **存量自愈**：已经写坏的数据（昵称仍是「同学」+ 有称呼）要在列表时补上。

        只修写入路径是不够的 —— 用户库里那份数据早就写坏了，
        光改写入路径他还是看到两个名字（这正是报障当下的状态）。
        """
        created = self.create_student("同学", "junior")
        # 直接摆出"写坏"的存量：有称呼、昵称还是回落值（绕过新写入路径）
        store = open_learning_store(self.tmp, created["studentId"])
        try:
            store.set_real_name(created["studentId"], "范思远")
        finally:
            store.close()

        listed = {item["studentId"]: item for item in self.list_students()}
        self.assertEqual(
            listed[created["studentId"]]["nickname"],
            "范思远",
            "存量自愈：昵称还是回落值而学生设过称呼时，列表要把它补上",
        )
        # 再列一次仍是同一个值（自愈是幂等的，不会来回抖）
        again = {item["studentId"]: item for item in self.list_students()}
        self.assertEqual(again[created["studentId"]]["nickname"], "范思远")

    def test_heal_never_overwrites_a_student_chosen_nickname(self) -> None:
        """★ 自愈的**反向**：学生自己起过名（昵称非回落值）时，称呼不许压过去。"""
        created = self.create_student("小海", "junior")
        store = open_learning_store(self.tmp, created["studentId"])
        try:
            store.set_real_name(created["studentId"], "范思远")
        finally:
            store.close()

        listed = {item["studentId"]: item for item in self.list_students()}
        self.assertEqual(
            listed[created["studentId"]]["nickname"],
            "小海",
            "昵称不是回落值时，自愈**不许**动手 —— 那是学生自己起的名字",
        )
