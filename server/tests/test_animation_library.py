# -*- coding: utf-8 -*-
"""学生**动画库**（``/api/animation/saved/**``）：保存 → 复用 → 删除 → 学段隔离。

本文件盯住六条（对应需求里点名的能力与仓库的硬约束）：

1. ★ **完整链路**：保存 → 列表（**不回 html**）→ 取一条（**带 html**）→ 删除 → 取不到；
2. ★ **复用**：同一个 ``(kpId, gradeLevel, promptHash)`` 命中且 ``uses`` 自增；
   **改学段必不命中**（用户点名要求：小学低与初中是两份不同产物）、改指纹不命中；
3. ★ **学生隔离**：A 不能列 / 取 / 删 B 的记录（每条都验「B 的那条还在」）；
4. ★ **不合格输入一律 422 + 可读原因**：坏 HTML / 非法学生 id / 非 JSON 请求体；
5. ★★ **学生原话一个字都不进这里**：拿一个哨兵字符串当「学生原话」，
   存完之后 grep **库的整行**与**落盘目录里的每一个文件**，它都不许出现；
6. ★ **落盘位置与路径安全**：HTML 落在 ``students/<id>/animations/saved/`` 下、
   库里只存**相对**路径；把库里的 ``html_path`` 改出学生目录之后必须拒读而不是照读。

⚠️ 与 ``test_animation_nonce.py`` 的区别：那个文件测的是一次性 nonce 托管（**不进 OpenAPI**
的内部管道）；本文件测的动画库是**产品能力**，因此它在 OpenAPI 里、类型由契约生成。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import RuntimeConfig  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import resources as R  # noqa: E402
from app.routes.animation_library import SAVED_DIRNAME, router as library_router  # noqa: E402
from app.routes.students import student_dir  # noqa: E402

TOKEN = "unit-test-token"
#: 托管路由只认回环 Host（防伪造 Host），动画库沿用同一套客户端口径。
LOOPBACK_BASE = "http://127.0.0.1:8756"

STUDENT_A = "student_001"
STUDENT_B = "student_002"
KP_ID = "prog-loop-jr"
PROMPT_HASH = hashlib.sha1("什么是循环".encode("utf-8")).hexdigest()

#: ★ 哨兵：模拟「学生原话」。正常路径下它只被调用方算成 ``prompt_hash``，
#: 本体既不该进库、也不该落盘（见 ``TestRawUtteranceNeverStored``）。
UTTERANCE_SENTINEL = "哨兵原话请不要出现在任何落盘位置-7f3a"


def _build_client(data_dir: Path) -> TestClient:
    """显式传 data_dir 的客户端：不传的话动画库会 503（绝不写进共享的 server/_data）。"""
    cfg = RuntimeConfig(host="127.0.0.1", port=0, token=TOKEN, data_dir=data_dir)
    client = TestClient(create_app(cfg), base_url=LOOPBACK_BASE)
    client.headers.update({"X-Auth-Token": TOKEN})
    return client


def _sample_html(payload_id: str = "lib-pid") -> str:
    """一份**过校验**的真动画 HTML（与渲染/托管路径同一套产物）。"""
    template = R.load_templates()[0]
    return R.render_animation(template, payload_id=payload_id).html


def _save_body(**overrides: object) -> dict:
    """一份合格的保存请求体（含 ``gradeLevel`` 这一维复用键）。"""
    body: dict[str, object] = {
        "kpId": KP_ID,
        "gradeLevel": "junior",
        "concept": "循环",
        "promptHash": PROMPT_HASH,
        "title": "循环：重复做同一件事",
        "durationMs": 5000,
        "html": _sample_html(),
        "fallbackText": "循环就是让同一段代码重复执行很多次。",
    }
    body.update(overrides)
    return body


class LibraryCase(unittest.TestCase):
    """公共夹具：一个临时 data-dir + 一个带 token 的客户端。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.client = _build_client(self.data_dir)
        self.addCleanup(self._tmp.cleanup)

    # ------------------------------------------------------------ 便利方法 --
    def save(self, student_id: str = STUDENT_A, **overrides: object) -> dict:
        response = self.client.post(
            f"/api/animation/saved/{student_id}", json=_save_body(**overrides)
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def lookup(self, student_id: str = STUDENT_A, **overrides: object):
        payload = {
            "studentId": student_id,
            "kpId": KP_ID,
            "gradeLevel": "junior",
            "promptHash": PROMPT_HASH,
        }
        payload.update(overrides)
        return self.client.post("/api/animation/saved/lookup", json=payload)

    def list_saved(self, student_id: str = STUDENT_A, **params: object):
        return self.client.get(f"/api/animation/saved/{student_id}", params=params)

    def saved_dir(self, student_id: str = STUDENT_A) -> Path:
        return student_dir(self.data_dir, student_id) / "animations" / SAVED_DIRNAME

    def learning_db(self, student_id: str = STUDENT_A) -> Path:
        return student_dir(self.data_dir, student_id) / "learning.db"


# --------------------------------------------------------------------------- #
# 1. 保存 → 列表 → 取 → 删
# --------------------------------------------------------------------------- #
class TestLifecycle(LibraryCase):
    def test_save_list_get_delete_gone(self) -> None:
        """★ 完整链路：回执不带 html、列表不带 html、取一条带 html、删完取不到。"""
        created = self.save()
        self.assertTrue(created["id"], "保存必须回一个 id")
        self.assertNotIn("html", created, "保存回执不回 html（列表/回执同一形态）")
        self.assertEqual(created["gradeLevel"], "junior")
        self.assertEqual(created["uses"], 0)
        self.assertGreater(created["createdAt"], 0, "createdAt 是 Unix 毫秒，必须非零")

        listing = self.list_saved()
        self.assertEqual(listing.status_code, 200, listing.text)
        listed = listing.json()
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["studentId"], STUDENT_A)
        self.assertEqual([item["id"] for item in listed["items"]], [created["id"]])
        for item in listed["items"]:
            self.assertNotIn("html", item, "列表不回 html（否则响应会变成几 MB）")

        fetched = self.client.get(f"/api/animation/saved/{STUDENT_A}/{created['id']}")
        self.assertEqual(fetched.status_code, 200, fetched.text)
        view = fetched.json()
        self.assertIn("html", view)
        self.assertIn("anime", view["html"], "取回来的应当是那份动画 HTML 本体")
        self.assertEqual(view["fallbackText"], created["fallbackText"])

        deleted = self.client.delete(f"/api/animation/saved/{STUDENT_A}/{created['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertTrue(deleted.json()["deleted"])

        self.assertEqual(
            self.client.get(f"/api/animation/saved/{STUDENT_A}/{created['id']}").status_code, 404
        )
        self.assertEqual(self.list_saved().json()["total"], 0)

    def test_delete_removes_the_file_too(self) -> None:
        """删记录必须连文件一起删 —— 否则每删一次就在磁盘上留一份孤儿 HTML。"""
        created = self.save()
        files_before = list(self.saved_dir().glob("*.html"))
        self.assertEqual(len(files_before), 1, f"应当正好落一份 HTML：{files_before}")

        self.client.delete(f"/api/animation/saved/{STUDENT_A}/{created['id']}")
        self.assertEqual(list(self.saved_dir().glob("*.html")), [], "记录删了文件却还在")

    def test_list_is_newest_first(self) -> None:
        """按创建时间倒序（最新的在前）：前端不必自己 reverse 一遍。

        ★ 断言前把先存的那条时间**改早一分钟**：``created_at`` 是**秒**，同一秒内保存的
          两条光看时间分不出先后 —— 不这么做的话这条断言会随保存速度随机红（假红）。
        """
        older = self.save(kpId="prog-loop-jr")
        newer = self.save(kpId="data-processing-jr")

        conn = sqlite3.connect(self.learning_db())
        self.addCleanup(conn.close)
        conn.execute(
            "UPDATE saved_animation SET created_at = created_at - 60 WHERE id = ?", (older["id"],)
        )
        conn.commit()

        listed = self.list_saved().json()
        self.assertEqual([item["id"] for item in listed["items"]], [newer["id"], older["id"]])

    def test_list_filters_by_grade_and_kp(self) -> None:
        self.save(gradeLevel="junior")
        self.save(gradeLevel="primary_low", kpId="data-processing-jr")
        only_junior = self.list_saved(gradeLevel="junior").json()
        self.assertEqual(only_junior["total"], 1)
        self.assertEqual(only_junior["gradeLevel"], "junior", "过滤条件必须回显（前端据此显示筛选状态）")
        self.assertEqual(only_junior["items"][0]["gradeLevel"], "junior")

        by_kp = self.list_saved(kpId=KP_ID).json()
        self.assertEqual(by_kp["total"], 1)
        self.assertEqual(by_kp["items"][0]["gradeLevel"], "junior", "同一个知识点在两个学段的产物必须分得开")


# --------------------------------------------------------------------------- #
# 2. 复用键（★ 学段是身份的一部分）
# --------------------------------------------------------------------------- #
class TestReuseKey(LibraryCase):
    def test_same_key_hits_and_counts_uses(self) -> None:
        """★ 复用命中：返回**带 html** 的那条，``uses`` 自增（可观测的复用证据）。"""
        created = self.save()
        for expected in (1, 2):
            hit = self.lookup()
            self.assertEqual(hit.status_code, 200, hit.text)
            self.assertEqual(hit.json()["id"], created["id"])
            self.assertIn("html", hit.json(), "命中必须带 html（调用方要直接拿去渲染）")
            self.assertEqual(hit.json()["uses"], expected, "命中一次 uses 加一")

        stored = self.client.get(f"/api/animation/saved/{STUDENT_A}/{created['id']}").json()
        self.assertEqual(stored["uses"], 2, "uses 是持久化的，不是只在响应里加一")

    def test_different_grade_level_misses(self) -> None:
        """★★ **学段隔离**：同知识点、同指纹，换一个学段必不命中。

        这是用户点名的那条要求 —— 小学低与初中必须是**两份不同的产物**，
        共用一份就会把某一档讲法的动画端给另一档的孩子。
        """
        self.save(gradeLevel="junior")
        for other in ("primary_low", "primary_high", "senior"):
            with self.subTest(gradeLevel=other):
                missed = self.lookup(gradeLevel=other)
                self.assertEqual(missed.status_code, 404, missed.text)
                self.assertIn(other, missed.json()["detail"], "拒因里要说清是哪个学段没命中")

    def test_different_prompt_hash_misses(self) -> None:
        """**不同的一问**不该复用：指纹不同即不命中（否则换个问法就拿到旧动画）。"""
        self.save()
        missed = self.lookup(promptHash=hashlib.sha1("别的问法".encode("utf-8")).hexdigest())
        self.assertEqual(missed.status_code, 404, missed.text)

    def test_different_kp_misses(self) -> None:
        self.save()
        self.assertEqual(self.lookup(kpId="data-processing-jr").status_code, 404)

    def test_lookup_miss_does_not_create_anything(self) -> None:
        """未命中 → 404 + 库里空空（不许「顺便建一条空的」）。"""
        self.assertEqual(self.lookup().status_code, 404)
        self.assertEqual(self.list_saved().json()["total"], 0)

    def test_resave_same_key_overwrites_instead_of_appending(self) -> None:
        """同一个复用键再存一次 = **覆盖**那一条（否则库里会堆满几乎相同的记录）。"""
        first = self.save(title="第一版")
        second = self.save(title="第二版")
        self.assertNotEqual(first["id"], second["id"], "覆盖时换成新的 id（文件也换成新的）")
        listed = self.list_saved().json()
        self.assertEqual(listed["total"], 1, "复用键上只允许有一条")
        self.assertEqual(listed["items"][0]["title"], "第二版")
        self.assertEqual(len(list(self.saved_dir().glob("*.html"))), 1, "覆盖后不留孤儿文件")
        self.assertEqual(self.lookup().json()["title"], "第二版")

    def test_resave_keeps_the_use_count(self) -> None:
        """覆盖时**保留** ``uses``：重新生成一次不代表以前的复用没发生过。"""
        created = self.save()
        self.lookup()
        self.assertEqual(self.lookup().json()["uses"], 2)
        regenerated = self.save(title="重新生成的一版")
        self.assertEqual(regenerated["uses"], 2, "覆盖不该把复用计数清零")

    def test_lookup_endpoint_is_not_shadowed_by_the_save_endpoint(self) -> None:
        """★ 路由注册顺序的回归：``/saved/lookup`` 必须排在 ``/saved/{student_id}`` 之前。

        反过来的话「lookup」会被当成一个学生 id 吃掉，这条接口**永远 422** ——
        症状是「复用从来没生效过」，而生成路径照常工作（看不出来）。
        """
        self.assertEqual(
            [route.path for route in library_router.routes][0],
            "/api/animation/saved/lookup",
            "lookup 必须**先于** POST 保存路由注册",
        )
        hit = self.lookup()
        self.assertEqual(hit.status_code, 404, "空库下 lookup 走的是自己的处理器（404 而不是 422）")


# --------------------------------------------------------------------------- #
# 3. 学生隔离
# --------------------------------------------------------------------------- #
class TestStudentIsolation(LibraryCase):
    def test_another_student_cannot_list_my_records(self) -> None:
        self.save(STUDENT_A)
        listing = self.list_saved(STUDENT_B).json()
        self.assertEqual(listing["total"], 0, "B 的库是空的：A 的记录在 A 自己的库文件里")
        self.assertEqual(self.list_saved(STUDENT_A).json()["total"], 1, "A 的记录必须还在")

    def test_another_student_cannot_get_my_record(self) -> None:
        created = self.save(STUDENT_A)
        stolen = self.client.get(f"/api/animation/saved/{STUDENT_B}/{created['id']}")
        self.assertEqual(stolen.status_code, 404, "拿 A 的条目 id 去问 B 的库必须拿不到")
        self.assertNotIn("anime", stolen.text)
        self.assertEqual(
            self.client.get(f"/api/animation/saved/{STUDENT_A}/{created['id']}").status_code,
            200,
            "A 自己仍然取得回来",
        )

    def test_another_student_cannot_delete_my_record(self) -> None:
        created = self.save(STUDENT_A)
        denied = self.client.delete(f"/api/animation/saved/{STUDENT_B}/{created['id']}")
        self.assertEqual(denied.status_code, 404, "删别人的记录必须失败")
        self.assertEqual(
            self.client.get(f"/api/animation/saved/{STUDENT_A}/{created['id']}").status_code,
            200,
            "★ 别人的删除请求不许把我的记录删掉",
        )
        self.assertEqual(len(list(self.saved_dir(STUDENT_A).glob("*.html"))), 1, "文件也还在")

    def test_two_students_can_each_hold_the_same_key(self) -> None:
        """同一个复用键在两个人那里各有一份（学生维度由**库文件归属**承担）。"""
        mine = self.save(STUDENT_A, title="我的")
        yours = self.save(STUDENT_B, title="你的")
        self.assertNotEqual(mine["id"], yours["id"])
        self.assertEqual(self.lookup(STUDENT_A).json()["title"], "我的")
        self.assertEqual(self.lookup(STUDENT_B).json()["title"], "你的")

    def test_another_student_never_gets_my_html(self) -> None:
        """★ 反向断言盯住「跨学生不可互取」这条性质（同托管路径的口径）。"""
        mine = self.save(STUDENT_A)
        html = self.client.get(f"/api/animation/saved/{STUDENT_A}/{mine['id']}").json()["html"]
        marker = html[:200]
        stolen = self.client.get(f"/api/animation/saved/{STUDENT_B}/{mine['id']}")
        self.assertNotIn(marker, stolen.text)


# --------------------------------------------------------------------------- #
# 4. 不合格输入（一律 4xx + 可读原因，绝不 500）
# --------------------------------------------------------------------------- #
class TestRejections(LibraryCase):
    def test_invalid_html_is_rejected_with_a_readable_reason(self) -> None:
        """★ 保存入口**再校验一次** HTML：能进库的东西一定过了渲染/托管同一套判据。"""
        response = self.client.post(
            f"/api/animation/saved/{STUDENT_A}",
            json=_save_body(html="<html><body>没有脚本、没有库</body></html>"),
        )
        self.assertEqual(response.status_code, 422, response.text)
        detail = response.json()["detail"]
        self.assertIn("校验", detail, "拒因必须是可读中文")
        self.assertEqual(self.list_saved().json()["total"], 0, "拒收的东西不许进库")
        self.assertFalse(self.saved_dir().exists(), "拒收时连目录都不该建")

    def test_html_with_external_reference_is_rejected(self) -> None:
        """零外部引用这条（断网演示的底线）在保存入口同样成立。"""
        bad = _sample_html().replace("</head>", '<script src="https://cdn.jsdelivr.net/x.js"></script></head>', 1)
        response = self.client.post(f"/api/animation/saved/{STUDENT_A}", json=_save_body(html=bad))
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("外部引用", response.json()["detail"])

    def test_empty_html_is_rejected(self) -> None:
        for value in ("", "   "):
            with self.subTest(html=value):
                response = self.client.post(
                    f"/api/animation/saved/{STUDENT_A}", json=_save_body(html=value)
                )
                self.assertEqual(response.status_code, 422, response.text)

    def test_path_traversal_student_id_is_rejected(self) -> None:
        """★ 学生 id 会在**任何路径拼接之前**过白名单；穿越形态一律 4xx，绝不 200 / 500。

        两类形态都得拒，但拒的位置不同（这里把两种都钉住）：

        ① **单段**非法 id（``a b`` / 超长 / ``.hidden``）→ 请求进了处理器，白名单给 **422**
           （它们过得了 Starlette 的分段，是真正要靠我们挡的那一类）；
        ② 带**编码斜杠**的穿越串（``a%5C..%5C..%2Fetc``）→ 解码后段数与路由对不上，
           Starlette 在**路由匹配**阶段就 404 / 405（请求根本到不了处理器）。

        无论哪一类，都不许在 ``<data-dir>`` 之外留下任何东西。
        """
        for bad in ("a b", "x" * 65, ".hidden", "a%5C..%5C..%2Fetc", "..%2F..%2Fetc"):
            with self.subTest(student_id=bad):
                response = self.client.post(f"/api/animation/saved/{bad}", json=_save_body())
                self.assertGreaterEqual(response.status_code, 400, response.text)
                self.assertLess(response.status_code, 500, response.text)
                if "%" not in bad:
                    self.assertEqual(response.status_code, 422, "单段非法 id 必须由白名单拒掉")

        # 路径穿越的判据：data-dir 下**只有**合法学生目录，别处一个字都没写
        self.assertFalse((self.data_dir / "etc").exists(), "穿越串写出了学生目录之外的东西")
        students_root = self.data_dir / "students"
        # 全部被拒的极端情形下连 students/ 都不该被建出来 —— 这里两种都算过
        created = {entry.name for entry in students_root.iterdir()} if students_root.is_dir() else set()
        self.assertTrue(
            created <= {STUDENT_A, STUDENT_B},
            f"学生目录下出现了不该有的东西：{sorted(created)}",
        )

    def test_unknown_saved_id_is_404(self) -> None:
        self.assertEqual(
            self.client.get(f"/api/animation/saved/{STUDENT_A}/anim-not-a-real-id").status_code, 404
        )
        self.assertEqual(
            self.client.delete(f"/api/animation/saved/{STUDENT_A}/anim-not-a-real-id").status_code, 404
        )

    def test_illegal_saved_id_is_422(self) -> None:
        """``saved_id`` 会被拼进文件名：字符集白名单挡在拼接之前。

        ⚠️ 不用裸 ``..`` 当反例：它会被 URL 规范化（客户端与 httpx 都可能先处理掉），
        请求根本到不了处理器 —— 那测的是 URL 规范化，不是我们的白名单。
        这里用 ``%2E%2E`` 让它作为一个**字面段**到达处理器。
        """
        for bad in ("a%20b", "%2E%2E", "x" * 65, "a%3Bb"):
            with self.subTest(saved_id=bad):
                self.assertEqual(
                    self.client.get(f"/api/animation/saved/{STUDENT_A}/{bad}").status_code, 422
                )

    def test_non_json_body_is_a_readable_4xx(self) -> None:
        """★ 请求体不是 JSON 时给可读的 4xx（而不是 500）。"""
        response = self.client.post(
            f"/api/animation/saved/{STUDENT_A}",
            content=b"this is not json",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 422, response.text)
        detail = response.json()["detail"]
        self.assertIn("json_invalid", json.dumps(detail, ensure_ascii=False))

    def test_empty_body_is_422_with_field_names(self) -> None:
        response = self.client.post(f"/api/animation/saved/{STUDENT_A}", json={})
        self.assertEqual(response.status_code, 422, response.text)
        fields = {entry["loc"][-1] for entry in response.json()["detail"]}
        self.assertTrue({"kpId", "gradeLevel", "promptHash"} <= fields, fields)

    def test_illegal_grade_level_is_422(self) -> None:
        response = self.client.post(
            f"/api/animation/saved/{STUDENT_A}", json=_save_body(gradeLevel="大学")
        )
        self.assertEqual(response.status_code, 422, response.text)

    def test_illegal_grade_filter_is_422(self) -> None:
        self.assertEqual(self.list_saved(gradeLevel="大学").status_code, 422)
        self.assertEqual(self.list_saved(kpId="有 空格 的 id").status_code, 422)

    def test_missing_data_dir_is_503_not_the_shared_directory(self) -> None:
        """★ 没显式 ``--data-dir`` → 503：绝不把学生动画写进共享的 ``server/_data``。"""
        from app.config import build_runtime_config

        app = create_app(build_runtime_config())  # 不传 data_dir → 兜底到 server/_data
        app.include_router(library_router)
        client = TestClient(app, base_url=LOOPBACK_BASE)
        client.headers.update({"X-Auth-Token": TOKEN})
        response = client.post(f"/api/animation/saved/{STUDENT_A}", json=_save_body())
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("data-dir", response.json()["detail"])


# --------------------------------------------------------------------------- #
# 5. ★★ 学生原话一个字都不进这里
# --------------------------------------------------------------------------- #
class TestRawUtteranceNeverStored(LibraryCase):
    """★★ 合规硬约束（§8.1「SQLite 不存对话正文」在动画库的形态）。

    做法：拿一个哨兵字符串当「学生原话」，调用方只传它的摘要（``prompt_hash``），
    存完之后把**库的整行**与**该学生落盘目录里的每一个文件**都 grep 一遍。
    """

    def test_sentinel_utterance_never_reaches_db_or_disk(self) -> None:
        digest = hashlib.sha1(UTTERANCE_SENTINEL.encode("utf-8")).hexdigest()
        created = self.save(promptHash=digest, title="循环：重复做同一件事", concept="循环")

        # ① 库的整行（SELECT * 拿到全部列，含将来新增的列）
        conn = sqlite3.connect(self.learning_db())
        conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        rows = [dict(row) for row in conn.execute("SELECT * FROM saved_animation")]
        self.assertEqual(len(rows), 1, "应当正好存了一行")
        self.assertEqual(rows[0]["prompt_hash"], digest, "库里留的是摘要，不是原话")
        dump = json.dumps(rows[0], ensure_ascii=False)
        self.assertNotIn(UTTERANCE_SENTINEL, dump, "学生原话进了库")
        self.assertNotIn("什么是循环", dump, "学生原话（或其片段）进了库")
        # 库文件本体也不该出现它（覆盖「藏在别的列/索里」这种形态）
        self.assertNotIn(
            UTTERANCE_SENTINEL.encode("utf-8"),
            self.learning_db().read_bytes(),
            "库文件本体里出现了学生原话",
        )

        # ② 该学生目录下的**每一个文件**（HTML / -wal / -shm 全在内）
        student_root = student_dir(self.data_dir, STUDENT_A)
        scanned = 0
        for path in sorted(student_root.rglob("*")):
            if not path.is_file():
                continue
            scanned += 1
            data = path.read_bytes()
            with self.subTest(file=path.name):
                self.assertNotIn(UTTERANCE_SENTINEL.encode("utf-8"), data, f"{path} 里出现了学生原话")
        self.assertGreater(scanned, 1, "扫描面太窄（至少要有库文件与动画 HTML）")

        # ③ 接口回执里也没有（它只该有摘要）
        self.assertNotIn(UTTERANCE_SENTINEL, json.dumps(created, ensure_ascii=False))

    def test_raw_text_as_prompt_hash_is_rejected_by_the_contract(self) -> None:
        """★★ 「只收十六进制」是**类型约束**而不是口头纪律：原话连一个汉字都过不了校验。

        这条是上面那条测试的技术前提 —— 如果 ``promptHash`` 什么字符串都收，
        「别传原话」就只是一句靠人记得的约定。
        """
        for bad in (UTTERANCE_SENTINEL, "什么是循环", "这是 中文 摘要", "abc-def", "a" * 5):
            with self.subTest(value=bad[:12]):
                response = self.client.post(
                    f"/api/animation/saved/{STUDENT_A}", json=_save_body(promptHash=bad)
                )
                self.assertEqual(response.status_code, 422, response.text)

    def test_extra_body_fields_are_rejected(self) -> None:
        """``extra="forbid"``：多带一个 ``text`` / ``question`` 字段直接 422。

        这是「想顺手把原话存进来」那条路的硬闸门（同 ``profile.events`` 的口径）。
        """
        for extra in ("text", "question", "utterance", "rawText"):
            with self.subTest(field=extra):
                response = self.client.post(
                    f"/api/animation/saved/{STUDENT_A}",
                    json=_save_body(**{extra: UTTERANCE_SENTINEL}),
                )
                self.assertEqual(response.status_code, 422, f"{extra} 不该被接受")


# --------------------------------------------------------------------------- #
# 6. 落盘位置与路径安全
# --------------------------------------------------------------------------- #
class TestStorageLayout(LibraryCase):
    def test_html_lands_in_the_students_saved_animations_dir(self) -> None:
        """HTML 落在 ``<data-dir>/students/<id>/animations/saved/``（复用既有 ``animations/``）。"""
        created = self.save()
        files = list(self.saved_dir().glob("*.html"))
        self.assertEqual(len(files), 1, f"落盘位置不对：{files}")
        self.assertIn(
            "anime",
            files[0].read_text(encoding="utf-8"),
            "落盘的应当是那份动画 HTML",
        )
        self.assertEqual(len(created["id"]), len("anim-") + 16, "id 是短随机串（形状与 payload_id 一致）")
        # B 的目录不该被建出来（跨学生隔离的物理形态）
        self.assertFalse((student_dir(self.data_dir, STUDENT_B) / "animations").exists())

    def test_db_stores_a_relative_path_only(self) -> None:
        """★ 库里存**相对**路径：data-dir 跟着 userData 走，写死绝对路径会在搬家后全断。"""
        created = self.save()
        conn = sqlite3.connect(self.learning_db())
        conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        row = conn.execute("SELECT html_path FROM saved_animation WHERE id = ?", (created["id"],)).fetchone()
        stored = str(row["html_path"])
        self.assertEqual(stored, f"animations/saved/{hashlib.sha1(created['id'].encode()).hexdigest()}.html")
        self.assertNotIn(str(self.data_dir), stored, "库里不许出现 data-dir 的绝对路径")
        self.assertNotIn(created["id"], stored, "文件名是 id 的摘要，不是 id 本体")

    def test_tampered_html_path_outside_the_student_dir_is_refused(self) -> None:
        """★ 库被手工改坏之后：拒这一条请求（404），而不是按路径读任意文件。"""
        created = self.save()
        conn = sqlite3.connect(self.learning_db())
        self.addCleanup(conn.close)
        conn.execute(
            "UPDATE saved_animation SET html_path = ? WHERE id = ?",
            ("../../../../secret.html", created["id"]),
        )
        conn.commit()
        response = self.client.get(f"/api/animation/saved/{STUDENT_A}/{created['id']}")
        self.assertEqual(response.status_code, 404, response.text)
        self.assertIn("路径非法", response.json()["detail"])

    def test_record_without_file_is_404_not_500(self) -> None:
        created = self.save()
        for path in self.saved_dir().glob("*.html"):
            path.unlink()
        response = self.client.get(f"/api/animation/saved/{STUDENT_A}/{created['id']}")
        self.assertEqual(response.status_code, 404, response.text)
        self.assertIn("磁盘", response.json()["detail"])

    def test_dirty_grade_level_in_db_does_not_500(self) -> None:
        """★ 库里的学段被改坏时：退到冷启动默认学段并记日志，而不是让列表打不开。

        与 ``students.as_grade_level`` 同一条口径：库文件是**可写**的，
        一个非法学段不该让 pydantic 在序列化时抛 500。
        """
        created = self.save()
        conn = sqlite3.connect(self.learning_db())
        self.addCleanup(conn.close)
        conn.execute("UPDATE saved_animation SET grade_level = ? WHERE id = ?", ("大学", created["id"]))
        conn.commit()

        listing = self.list_saved()
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(listing.json()["items"][0]["gradeLevel"], "junior", "坏值退到冷启动默认学段")


# --------------------------------------------------------------------------- #
# 7. 迁移组与路由形状
# --------------------------------------------------------------------------- #
class TestMigrationSet(LibraryCase):
    def test_animation_migration_is_a_separate_set(self) -> None:
        """★ 新增表走 ``set_name="animation"`` 这条并行通道，**不动 learning 组**。

        理由（``migrations.py`` 模块头预留的通道）：learning 组的版本号是既有验收的断言口径
        —— 另有五条测试断言账本恰为 ``[(learning, 1..4)]``，往那一组塞版本会让它们全红。
        """
        self.save()  # 只有真用到动画库时才建表
        conn = sqlite3.connect(self.learning_db())
        conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        rows = [
            (str(r["set_name"]), int(r["version"]))
            for r in conn.execute("SELECT set_name, version FROM schema_version ORDER BY 1, 2")
        ]
        self.assertEqual(
            rows,
            [("animation", 1), ("learning", 1), ("learning", 2), ("learning", 3), ("learning", 4)],
        )

    def test_animation_table_is_absent_until_it_is_used(self) -> None:
        """没存过动画的库**不该**有 ``saved_animation``（不污染只画像的那条路径的既有事实）。"""
        from app.routes.students import open_learning_store

        store = open_learning_store(self.data_dir, STUDENT_A)
        store.close()
        conn = sqlite3.connect(self.learning_db())
        self.addCleanup(conn.close)
        names = {
            str(r[0]) for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        self.assertNotIn("saved_animation", names)

        self.save()  # 用过之后就有了
        conn2 = sqlite3.connect(self.learning_db())
        self.addCleanup(conn2.close)
        names2 = {
            str(r[0]) for r in conn2.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        self.assertIn("saved_animation", names2)
        self.assertIn("learning_history", names2, "动画库的迁移不该动别的表")


class TestRouterShape(unittest.TestCase):
    def test_routes_are_in_the_openapi_schema(self) -> None:
        """★ 与内部管道（compose / host / resources）相反：动画库是**产品能力**，要进 OpenAPI。

        它进生成物的直接好处：前端与主进程拿到的是**契约推导出来的类型**
        （``desktop/src/shared/api-types.ts``），而不是手写一份接口形状。
        """
        app = create_app(RuntimeConfig(host="127.0.0.1", port=0, token=TOKEN, data_dir=None))
        paths = app.openapi()["paths"]
        for path in (
            "/api/animation/saved/lookup",
            "/api/animation/saved/{student_id}",
            "/api/animation/saved/{student_id}/{saved_id}",
        ):
            with self.subTest(path=path):
                self.assertIn(path, paths, f"{path} 没进 OpenAPI")

    def test_path_freeze(self) -> None:
        """★ 这五条路径在计划里就冻结了（其它工作流按同一个形状编码）。

        ⚠️ 用**集合**比路径：同一个路径上挂着多条路由（POST/GET、GET/DELETE），
        列表里同名路径会出现两三次，逐个比长度只会得到「多出两条」这种噪声。
        """
        self.assertEqual(
            sorted({route.path for route in library_router.routes}),
            [
                "/api/animation/saved/lookup",
                "/api/animation/saved/{student_id}",
                "/api/animation/saved/{student_id}/{saved_id}",
            ],
        )
        methods = {
            (route.path, method)
            for route in library_router.routes
            for method in getattr(route, "methods", set())
        }
        self.assertEqual(
            methods,
            {
                ("/api/animation/saved/lookup", "POST"),
                ("/api/animation/saved/{student_id}", "POST"),
                ("/api/animation/saved/{student_id}", "GET"),
                ("/api/animation/saved/{student_id}/{saved_id}", "GET"),
                ("/api/animation/saved/{student_id}/{saved_id}", "DELETE"),
            },
        )


if __name__ == "__main__":
    unittest.main()
