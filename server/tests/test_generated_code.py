# -*- coding: utf-8 -*-
"""D-089：**学生的生成编程题**（存储 + 校验 + 取回 + 分级提示）。

这一组盯住四件「错了就静默出事」的事：

1. ★★ **`solution` 与 `hints` 不外发**：用唯一哨兵串当参照实现与提示，走完
   「保存 → 列表 → 单条」全链路，哨兵在响应 JSON 里必须**零命中**（提示只从 hint 路由按级发）；
2. ★ **学生隔离**：另一个学生列不到、也取不到别人的题；
3. ★ **复用键命中就直接复用**（同学生 + 同知识点 + 同学段 + 同指纹）——
   同一句要求再问一次不该重做一道题、更不该覆盖学生手里正在做的那道；
4. **不合格的生成题一律 422 且不入库**（缺 TODO / 提示不是三级 / 第 1 级带代码）。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import build_runtime_config  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes.code import router as code_router  # noqa: E402

#: ★ 哨兵：只可能来自 solution / hints。它一旦出现在「保存 / 列表 / 单条」的响应里，就是泄漏。
SENTINEL_SOLUTION = "哨兵参照实现-ZX77-不得出现在响应里"
SENTINEL_HINT3 = "哨兵三级提示-ZX88-只能从 hint 路由按级发"


def _body(**overrides: object) -> dict:
    """一份合格的生成编程题（按需覆盖字段）。"""
    body: dict = {
        "kpId": "gen-prog-loop-jr-demo1",
        "gradeLevel": "junior",
        "title": "让程序把 1 到 5 打印出来",
        "expectedBehavior": "运行后屏幕上依次出现 1、2、3、4、5。",
        "scaffold": "for i in range(TODO):\n    print(i)\n",
        "expectedOutput": "1\n2\n3\n4\n5",
        "hints": [
            {"level": 1, "hint": "想想「重复做五遍」这件事可以怎么表达。"},
            {"level": 2, "hint": "用循环结构，把次数写进括号里。"},
            {"level": 3, "hint": SENTINEL_HINT3},
        ],
        "solution": SENTINEL_SOLUTION,
        "promptHash": "hash-demo-0001",
    }
    body.update(overrides)
    return body


class GeneratedCodeCase(unittest.TestCase):
    """带临时 userData 的基类（一人一库落在 tmp 里，不碰真实数据）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config(data_dir=self.tmp))
        # 数据轨的路由由 main.py 挂载；这里显式挂一次，保证端到端走到 HTTP 层
        self.app.include_router(code_router)
        self.client = TestClient(self.app)

    def save(self, student: str, **overrides: object):
        return self.client.post(f"/api/code/generated/{student}", json=_body(**overrides))


class TestGeneratedCodeRoutes(GeneratedCodeCase):
    def test_save_then_list_and_get(self) -> None:
        created = self.save("code_a")
        self.assertEqual(created.status_code, 200, created.text)
        saved_id = created.json()["savedId"]
        self.assertTrue(saved_id)

        listed = self.client.get("/api/code/generated/code_a")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual([item["savedId"] for item in listed.json()], [saved_id])

        single = self.client.get(f"/api/code/generated/code_a/{saved_id}")
        self.assertEqual(single.status_code, 200, single.text)
        self.assertEqual(single.json()["scaffold"], _body()["scaffold"])

    def test_solution_and_hints_never_leave_the_backend(self) -> None:
        created = self.save("code_b")
        saved_id = created.json()["savedId"]
        for response in (
            created,
            self.client.get("/api/code/generated/code_b"),
            self.client.get(f"/api/code/generated/code_b/{saved_id}"),
        ):
            self.assertNotIn(SENTINEL_SOLUTION, response.text, "★ 参照实现泄漏")
            self.assertNotIn(SENTINEL_HINT3, response.text, "★ 三级提示在列表/单条里泄漏")
            payload = json.loads(response.text)
            items = payload if isinstance(payload, list) else [payload]
            for item in items:
                self.assertEqual(
                    set(item.keys()) & {"solution", "hints", "promptHash", "studentId"},
                    set(),
                    f"生成题的对外结构多了字段：{sorted(item.keys())}",
                )

    def test_hint_comes_level_by_level(self) -> None:
        saved_id = self.save("code_c").json()["savedId"]
        first = self.client.get(f"/api/code/generated/code_c/{saved_id}/hint?level=1")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["level"], 1)
        self.assertNotIn(SENTINEL_HINT3, first.text, "★ 要第 1 级却把第 3 级发出去了")

        third = self.client.get(f"/api/code/generated/code_c/{saved_id}/hint?level=3")
        self.assertEqual(third.json()["level"], 3)
        self.assertIn("三级提示", third.text)

        # 越界 → 封顶到最高级（与随包模板那条路由同一口径）
        over = self.client.get(f"/api/code/generated/code_c/{saved_id}/hint?level=9")
        self.assertEqual(over.status_code, 422, over.text)

    def test_other_student_sees_nothing(self) -> None:
        saved_id = self.save("code_d").json()["savedId"]
        self.assertEqual(self.client.get("/api/code/generated/code_other").json(), [])
        missed = self.client.get(f"/api/code/generated/code_other/{saved_id}")
        self.assertEqual(missed.status_code, 404, missed.text)

    def test_same_key_reuses_instead_of_remaking(self) -> None:
        first = self.save("code_e").json()["savedId"]
        again = self.save("code_e")
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["savedId"], first, "★ 同一句要求又问了一次，却重做了一道题")
        self.assertEqual(len(self.client.get("/api/code/generated/code_e").json()), 1)

    def test_bad_templates_are_rejected_and_not_stored(self) -> None:
        cases = {
            "缺 TODO": {"scaffold": "print(1)\n"},
            "提示不是三级": {"hints": [{"level": 1, "hint": "a"}]},
            "第 1 级带代码": {"hints": [
                {"level": 1, "hint": "for i in range(1,6): 这样写"},
                {"level": 2, "hint": "b"},
                {"level": 3, "hint": "c"},
            ]},
            "缺 expectedBehavior": {"expectedBehavior": "  "},
            "缺 solution": {"solution": ""},
        }
        for name, overrides in cases.items():
            with self.subTest(case=name):
                response = self.save("code_f", **overrides)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertIn("不合格", response.json()["detail"])
        self.assertEqual(self.client.get("/api/code/generated/code_f").json(), [], "不合格的题进了库")

    def test_bad_student_id_is_422(self) -> None:
        self.assertEqual(self.client.get("/api/code/generated/有中文").status_code, 422)
