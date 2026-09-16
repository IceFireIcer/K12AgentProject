# -*- coding: utf-8 -*-
"""一次性 nonce 与动画资源托管_票 16：**鉴权机制的正反用例**。

本文件盯住五条_对应票据里点名的那几个反向用例：

1. ★ **正常路径**：签发 → 加载_200→ 拿到的就是那份 HTML → 响应头含 `Cache-Control: no-store`；
2. ★ **单次消费**：同一个 nonce 用第二次返回 **403**_复用被拒；
3. ★ **有效期**：过期后返回 **403**_`NonceStore` 的 `now` 可注入，所以不必真睡；
4. ★ **绑定身份**：换一个学生 id 或知识点 id 返回 **403**_跨学生不可互取；
5. ★ **缺 nonce / 未知 nonce**：返回 **403**；**这条路由不得退化成无鉴权公开路由**。

另外两条容易漏的：

- 返回哪个文件**只由 nonce 记录决定**_URL 里的 id 只做交叉核对，所以不存在目录穿越入口；
- 托管目录按学生分：拿 A 的 nonce 去请求 B 的路径一定失败_上面第 4 条的一种形态。

⚠️ 和 `test_animation_templates.py` 一样，本测试**自己挂路由**_本票不修改 `app/main.py`。
"""

from __future__ import annotations

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
from app.routes.students import student_dir  # noqa: E402

TOKEN = "unit-test-token"

#: TestClient 默认发 `Host: testserver`，而托管路由**只认回环 Host**（防伪造 Host 把 iframe
#: 指向别的机器）。所以测试用回环 base_url 建客户端 —— 这也与真实调用方（主进程）一致。
LOOPBACK_BASE = "http://127.0.0.1:8756"

#: 两个学生_「跨学生不可互取」这条断言需要两个身份。
STUDENT_A = "student_001"
STUDENT_B = "student_002"
KP_ID = "jr-py-loop"


def _build_client(data_dir: Path) -> TestClient:
    """建一个**显式传 data_dir** 的客户端_不传的话学生托管会被拒绝，见路由里的 503。"""
    cfg = RuntimeConfig(host="127.0.0.1", port=0, token=TOKEN, data_dir=data_dir)
    app = create_app(cfg)
    app.include_router(R.router)
    app.include_router(R.public_router)
    return TestClient(app, base_url=LOOPBACK_BASE)


def _sample_html(payload_id: str = "unit-pid") -> str:
    """一份**通过校验**的动画 HTML_够小、够真、满足所有校验条件。"""
    template = R.load_templates()[0]
    return R.render_animation(template, payload_id=payload_id).html


class TestNonceStoreUnit(unittest.TestCase):
    """`NonceStore` 本身的单元测试_**不经过 HTTP**，`now` 可注入所以过期可确定断言。"""

    def setUp(self) -> None:
        self.store = R.NonceStore(ttl_seconds=60)

    def test_签发与消费(self) -> None:
        nonce, expires_at = self.store.issue(
            student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=1000.0
        )
        self.assertTrue(nonce)
        self.assertEqual(expires_at, 1060.0)

        record, reason = self.store.consume(
            nonce, student_id=STUDENT_A, kp_id=KP_ID, now=1001.0
        )
        self.assertEqual(reason, "ok")
        self.assertIsNotNone(record)
        self.assertEqual(record.filename if record else None, "a.html")

    def test_nonce_是不可预测的随机串(self) -> None:
        first, _ = self.store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=0.0)
        second, _ = self.store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=0.0)
        self.assertNotEqual(first, second)
        self.assertGreaterEqual(len(first), 20, "nonce 太短，可被暴力猜")

    def test_单次消费_第二次被拒(self) -> None:
        nonce, _ = self.store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=0.0)
        self.assertEqual(self.store.consume(nonce, student_id=STUDENT_A, kp_id=KP_ID, now=1.0)[1], "ok")
        record, reason = self.store.consume(nonce, student_id=STUDENT_A, kp_id=KP_ID, now=2.0)
        self.assertIsNone(record)
        self.assertEqual(reason, "used")

    def test_过期被拒(self) -> None:
        nonce, _ = self.store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=0.0)
        record, reason = self.store.consume(nonce, student_id=STUDENT_A, kp_id=KP_ID, now=61.0)
        self.assertIsNone(record)
        self.assertEqual(reason, "expired")

    def test_刚好没过期仍然有效(self) -> None:
        nonce, _ = self.store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=0.0)
        self.assertEqual(self.store.consume(nonce, student_id=STUDENT_A, kp_id=KP_ID, now=59.9)[1], "ok")

    def test_学生不符被拒(self) -> None:
        nonce, _ = self.store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=0.0)
        record, reason = self.store.consume(nonce, student_id=STUDENT_B, kp_id=KP_ID, now=1.0)
        self.assertIsNone(record)
        self.assertEqual(reason, "wrong-student")

    def test_知识点不符被拒(self) -> None:
        nonce, _ = self.store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=0.0)
        record, reason = self.store.consume(nonce, student_id=STUDENT_A, kp_id="other-kp", now=1.0)
        self.assertIsNone(record)
        self.assertEqual(reason, "wrong-kp")

    def test_身份不符时不消耗_nonce(self) -> None:
        """★ 交叉核对失败不该「用掉」凭据：否则一次手滑的参数就让正常请求也失败了。"""
        nonce, _ = self.store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="a.html", now=0.0)
        self.assertEqual(self.store.consume(nonce, student_id=STUDENT_B, kp_id=KP_ID, now=1.0)[1], "wrong-student")
        self.assertEqual(self.store.consume(nonce, student_id=STUDENT_A, kp_id=KP_ID, now=2.0)[1], "ok")

    def test_空或未知_nonce(self) -> None:
        self.assertEqual(self.store.consume("", student_id=STUDENT_A, kp_id=KP_ID, now=0.0)[1], "missing")
        self.assertEqual(self.store.consume("   ", student_id=STUDENT_A, kp_id=KP_ID, now=0.0)[1], "missing")
        self.assertEqual(
            self.store.consume("not-a-nonce", student_id=STUDENT_A, kp_id=KP_ID, now=0.0)[1], "unknown"
        )

    def test_容量有上限_过期项会被先清掉(self) -> None:
        store = R.NonceStore(ttl_seconds=10, capacity=16)
        for index in range(16):
            store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename=f"{index}.html", now=0.0)
        self.assertEqual(store.size(), 16)
        # 时间走过 TTL 之后再签发：过期项应先被清掉，容量不该无限增长
        store.issue(student_id=STUDENT_A, kp_id=KP_ID, filename="new.html", now=100.0)
        self.assertLessEqual(store.size(), 16)


class TestAnimationResourceRoute(unittest.TestCase):
    """HTTP 层的正反用例_状态码是票据点名的证据。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.client = _build_client(self.data_dir)
        self.payload_id = "unit-pid"

        # 托管一份真实的动画产物_走内部路由，与主进程的调用路径一致
        response = self.client.post(
            f"/api/animation/host/{STUDENT_A}/{KP_ID}",
            json={"html": _sample_html(self.payload_id), "payloadId": self.payload_id},
            headers={"X-Auth-Token": TOKEN},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.hosted = response.json()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # ------------------------------------------------------------ 正常路径 --
    def test_托管返回带nonce的地址_且声明单次使用(self) -> None:
        self.assertIn("nonce=", self.hosted["url"])
        self.assertEqual(self.hosted["payloadId"], self.payload_id)
        self.assertTrue(self.hosted["singleUse"])
        self.assertGreater(self.hosted["expiresInMs"], 0)
        self.assertTrue(
            self.hosted["url"].startswith("http://127.0.0.1"),
            "地址必须是本机回环的绝对地址_渲染进程里不许出现回环字面量",
        )

    def test_文件落在该学生目录下_按学生分目录(self) -> None:
        expected_dir = student_dir(self.data_dir, STUDENT_A) / "animations"
        self.assertTrue(expected_dir.is_dir(), f"托管目录不存在：{expected_dir}")
        files = list(expected_dir.glob("*.html"))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].name, self.hosted["filename"])
        # 另一个学生的目录**不该**被建出来_跨学生隔离
        self.assertFalse((student_dir(self.data_dir, STUDENT_B) / "animations").exists())

    def test_用_nonce能取到_html_且响应头是_no_store(self) -> None:
        response = self.client.get(
            self.hosted["path"],
            params={"nonce": self.hosted["url"].split("nonce=", 1)[1].split("&", 1)[0]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("anime", response.text, "返回的应当是那份动画 HTML")
        cache_control = response.headers.get("Cache-Control", "")
        self.assertIn("no-store", cache_control, f"缺 no-store：{cache_control}")
        self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("default-src 'none'", response.headers.get("Content-Security-Policy", ""))

    def test_这条路由不带token也能取到但也仅限合法nonce(self) -> None:
        """★ iframe 带不了自定义 header：所以这条路由**不要求** X-Auth-Token_上面那条用例里没带。

        但这**不等于**无鉴权：没有 nonce 就什么都拿不到_见下面的反向用例。
        """
        nonce = self.hosted["url"].split("nonce=", 1)[1].split("&", 1)[0]
        without_token = self.client.get(self.hosted["path"], params={"nonce": nonce})
        self.assertEqual(without_token.status_code, 200)

    # ------------------------------------------------------------ 反向用例 --
    def test_缺nonce_403(self) -> None:
        response = self.client.get(self.hosted["path"])
        self.assertEqual(response.status_code, 403, response.text)
        self.assertIn("nonce", response.json()["detail"])

    def test_未知nonce_403(self) -> None:
        response = self.client.get(self.hosted["path"], params={"nonce": "not-a-real-nonce"})
        self.assertEqual(response.status_code, 403)
        self.assertIn("unknown", response.json()["detail"])

    def test_复用已消费的nonce_403(self) -> None:
        nonce = self.hosted["url"].split("nonce=", 1)[1].split("&", 1)[0]
        first = self.client.get(self.hosted["path"], params={"nonce": nonce})
        self.assertEqual(first.status_code, 200)
        second = self.client.get(self.hosted["path"], params={"nonce": nonce})
        self.assertEqual(second.status_code, 403, "同一个 nonce 用第二次必须被拒")
        self.assertIn("used", second.json()["detail"])

    def test_过期nonce_403(self) -> None:
        """直接往 store 里塞一个已过期的记录_不必真等 2 分钟。"""
        nonce = "expired-unit-nonce"
        R.NONCE_STORE._records[nonce] = R.NonceRecord(  # noqa: SLF001 - 测试需要构造过期态
            student_id=STUDENT_A,
            kp_id=KP_ID,
            filename=self.hosted["filename"],
            expires_at=0.0,
        )
        try:
            response = self.client.get(self.hosted["path"], params={"nonce": nonce})
            self.assertEqual(response.status_code, 403)
            self.assertIn("expired", response.json()["detail"])
        finally:
            R.NONCE_STORE._records.pop(nonce, None)  # noqa: SLF001

    def test_换一个学生_403_跨学生不可互取(self) -> None:
        nonce = self.hosted["url"].split("nonce=", 1)[1].split("&", 1)[0]
        response = self.client.get(
            f"/resources/animation/{STUDENT_B}/{KP_ID}", params={"nonce": nonce}
        )
        self.assertEqual(response.status_code, 403, "拿 A 的 nonce 去请求 B 的路径必须被拒")
        self.assertIn("wrong-student", response.json()["detail"])

    def test_换一个知识点_403(self) -> None:
        nonce = self.hosted["url"].split("nonce=", 1)[1].split("&", 1)[0]
        response = self.client.get(
            f"/resources/animation/{STUDENT_A}/other-kp", params={"nonce": nonce}
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("wrong-kp", response.json()["detail"])

    def test_越权取别人的学生目录_即便重新申请也拿不到(self) -> None:
        """B 自己申请一份，然后在 URL 里写 A 的路径：两头都对不上，拿不到 A 的内容。"""
        response = self.client.post(
            f"/api/animation/host/{STUDENT_B}/{KP_ID}",
            json={"html": "<html><body>B 的内容</body></html>", "payloadId": "b-pid"},
            headers={"X-Auth-Token": TOKEN},
        )
        # B 的内容不合格_校验不通过，这一步就该被拒 —— 顺手验了托管入口的二次校验
        self.assertEqual(response.status_code, 422, response.text)

        # 换成合法内容再托管一次，然后试图用 B 的 nonce 读 A 的路径
        response = self.client.post(
            f"/api/animation/host/{STUDENT_B}/{KP_ID}",
            json={"html": _sample_html("b-pid"), "payloadId": "b-pid"},
            headers={"X-Auth-Token": TOKEN},
        )
        self.assertEqual(response.status_code, 200, response.text)
        nonce_b = response.json()["url"].split("nonce=", 1)[1].split("&", 1)[0]
        stolen = self.client.get(f"/resources/animation/{STUDENT_A}/{KP_ID}", params={"nonce": nonce_b})
        self.assertEqual(stolen.status_code, 403, "拿 B 的凭据读 A 的内容必须被拒")
        self.assertNotIn("A", stolen.text)

    def test_非法的学生id或知识点id_返回422(self) -> None:
        for path in (
            f"/resources/animation/{'..%2F..%2Fetc'}/jr-py-loop",
            f"/resources/animation/{STUDENT_A}/{'..%2F..%2Fpasswd'}",
        ):
            with self.subTest(path=path):
                response = self.client.get(path, params={"nonce": "x"})
                self.assertIn(response.status_code, (403, 404, 422), response.text)

    # ------------------------------------------------------------ 内部路由 --
    def test_内部托管路由要求token(self) -> None:
        response = self.client.post(
            f"/api/animation/host/{STUDENT_A}/{KP_ID}",
            json={"html": _sample_html("pid-2"), "payloadId": "pid-2"},
        )
        self.assertEqual(response.status_code, 401, "内部路由必须走 X-Auth-Token")

    def test_托管前会再校验一次_html(self) -> None:
        """★ 能落盘的东西一定已经过了校验_别处绕过了 render 也塞不进坏产物。"""
        response = self.client.post(
            f"/api/animation/host/{STUDENT_A}/{KP_ID}",
            json={"html": "<html><body>没有脚本、没有库</body></html>", "payloadId": "pid-3"},
            headers={"X-Auth-Token": TOKEN},
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("校验", response.json()["detail"])

    def test_缺_html_返回422(self) -> None:
        response = self.client.post(
            f"/api/animation/host/{STUDENT_A}/{KP_ID}",
            json={"payloadId": "pid-4"},
            headers={"X-Auth-Token": TOKEN},
        )
        self.assertEqual(response.status_code, 422)

    def test_没有显式_data_dir时拒绝托管而不是写进共享目录(self) -> None:
        """★ `server/_data` 是**共享**目录：把学生动画写进去等于把不同来源的数据混在一起。"""
        from app.config import build_runtime_config

        cfg = build_runtime_config()  # 不传 data_dir → 兜底到 server/_data
        app = create_app(cfg)
        app.include_router(R.router)
        app.include_router(R.public_router)
        client = TestClient(app, base_url=LOOPBACK_BASE)
        response = client.post(
            f"/api/animation/host/{STUDENT_A}/{KP_ID}",
            json={"html": _sample_html("pid-5"), "payloadId": "pid-5"},
            headers={"X-Auth-Token": TOKEN},
        )
        self.assertEqual(response.status_code, 503, "没显式 data_dir 时必须拒绝，而不是写进共享目录")

    def test_托管文件名带_payload_id_摘要_同知识点的两张卡片互不覆盖(self) -> None:
        first = self.hosted["filename"]
        second = self.client.post(
            f"/api/animation/host/{STUDENT_A}/{KP_ID}",
            json={"html": _sample_html("another-pid"), "payloadId": "another-pid"},
            headers={"X-Auth-Token": TOKEN},
        )
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(first, second.json()["filename"], "两张卡片的内容不该互相覆盖")


class TestNonceLifecycleAcrossInstances(unittest.TestCase):
    """`NONCE_STORE` 是进程内单例：跨请求有效、重启即失效_这是有意的边界。"""

    def test_同一个进程内跨请求可用(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            client = _build_client(Path(tmp))
            hosted_response = client.post(
                f"/api/animation/host/{STUDENT_A}/{KP_ID}",
                json={"html": _sample_html("pid-x"), "payloadId": "pid-x"},
                headers={"X-Auth-Token": TOKEN},
            )
            self.assertEqual(hosted_response.status_code, 200, hosted_response.text)
            hosted = hosted_response.json()
            nonce = hosted["url"].split("nonce=", 1)[1].split("&", 1)[0]
            self.assertEqual(client.get(hosted["path"], params={"nonce": nonce}).status_code, 200)
        # 说明：nonce 存活于 sidecar 进程内。sidecar 重启后旧 nonce 全部失效 ——
        # 这没问题：动画卡片的地址是一次性的，页面重载会重新走一轮生成 + 托管。

    def test_ttl_是分钟级而不是秒级(self) -> None:
        """太长 = 凭据被长期利用；太短 = 学生刚点开就失效。"""
        self.assertGreaterEqual(R.NONCE_TTL_SECONDS, 30)
        self.assertLessEqual(R.NONCE_TTL_SECONDS, 600)


if __name__ == "__main__":
    unittest.main()
