# -*- coding: utf-8 -*-
"""设置页探测端点：**失败文案不再回显对方响应正文**（精准收口）。

## 这条防线为什么必须存在

``POST /api/settings/probe`` 与 ``/api/settings/models`` 按设计接受**任意** baseUrl ——
「校内网关 / 自建 OpenAI 兼容服务」是需求里的硬要求，**不能**加主机白名单
（加了就把自建服务一起挡掉了）。而探测的失败文案会被主进程原样交给设置页显示。

旧实现把对方响应体里的 ``message`` 脱敏（替换掉 API Key）后**截断到 160 字带出去**，
于是本机任意端口上那个「返回 500、正文里塞一段内网数据」的服务，就能借设置页的回执
把**它自己的响应内容读出来** —— 探测端点在事实上成了一个「回环/内网任意 HTTP 服务的
正文读取器」。用户判断问题需要的是「状态码 + 归类原因」（是我的 Key 的问题，还是地址的
问题），对方那段文本对判断没有增量。

## 这组用例怎么测

三个方向**都要**，缺一条这个收口就不成立：

1. **不提正文**：真 socket（stdlib ``http.server``，只在回环）返回带哨兵串的 500/401，
   断言回执里没有那个哨兵串；
2. **仍然可读**：回执是中文、带状态码或归类原因（不能为了安全退化成「探测失败」四个字）；
3. **不误伤**：合法的自定义 baseUrl 仍然**能探测成功**（修完顺手把自建服务挡掉，
   比不回显正文更糟 —— 那是需求硬性要求）；Key 仍然不出现在任何回执里。

夹具风格与 ``tests/test_settings_store.py`` 一致（那边覆盖 BaseURL 的 ``/v1`` 差异），
这里只补「回显」这一条线，不重复造 ``FakeTransport`` 那套。
"""

from __future__ import annotations

import http.server
import json
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.routes.settings import (  # noqa: E402
    HttpOutcome,
    _provider_reason,
    fetch_provider_models,
    probe_llm_connectivity,
)
from tests.test_settings_store import FakeTransport, json_body  # noqa: E402

#: 哨兵串：假装是某个内网服务才会知道的数据（在真实缺陷里会被逐字回显给渲染进程）。
INTRANET_SENTINEL = "SECRET-INTRANET-DATA-999"
SECRET_KEY = "sk-9f3c2b7a41d0e8f6a5b4c3d2e1f09876"
MASK = f"…{SECRET_KEY[-4:]}"


# --------------------------------------------------------------------------- #
# 伪内网服务：只在回环地址上，正文里带着哨兵串
# --------------------------------------------------------------------------- #
class _LeakyHandler(http.server.BaseHTTPRequestHandler):
    """一个「什么请求都回同一段带哨兵的 JSON」的内网服务（复现外泄通道）。

    ``status`` / ``body_builder`` 由子类覆写 —— 500 与 401 走的是**两条不同的分支**
    （``_status_failure`` 与 ``_auth_failed``），两条都必须收口。
    """

    status = 500
    seen_paths: list[str] = []

    def _payload(self) -> dict[str, object]:
        return {
            "error": {
                "message": f"internal service echoed {INTRANET_SENTINEL} to whoever asked",
                # ★ 有的服务会把请求头回显出来 —— Key 脱敏那条防线也不能丢
                "receivedAuthorization": f"Bearer {SECRET_KEY}",
            }
        }

    def do_GET(self) -> None:  # noqa: N802 - http.server 的约定命名
        type(self).seen_paths.append(self.path)
        body = json_body(self._payload())
        self.send_response(self.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)  # 读干净再回，免得连接被半途重置
        self.do_GET()

    def log_message(self, *args: object) -> None:
        """别把访问日志打到 stderr（测试输出要干净）。"""


class _Leaky500Handler(_LeakyHandler):
    status = 500


class _Leaky401Handler(_LeakyHandler):
    status = 401


class _HealthyHandler(_LeakyHandler):
    """合法的自定义网关（**必须**仍然能探测成功）—— 回一个标准模型列表。"""

    status = 200

    def _payload(self) -> dict[str, object]:
        return {"object": "list", "data": [{"id": "internal-gateway-model"}]}


class _LoopbackServerCase(unittest.TestCase):
    handler: type[_LeakyHandler] = _Leaky500Handler

    @classmethod
    def setUpClass(cls) -> None:
        cls.handler.seen_paths = []
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), cls.handler)
        cls.port = int(cls.server.server_address[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        type(self).handler.seen_paths = []

    @property
    def root(self) -> str:
        return f"http://127.0.0.1:{self.port}"


# --------------------------------------------------------------------------- #
# 500：走 `_status_failure`
# --------------------------------------------------------------------------- #
class TestServerErrorIsNotEchoed(_LoopbackServerCase):
    handler = _Leaky500Handler

    def test_500_body_never_reaches_the_probe_result(self) -> None:
        """★★ 核心用例：对方 500 的正文（带哨兵）一个字都不许出现在回执里。"""
        result = probe_llm_connectivity(
            base_url=self.root, api_key=SECRET_KEY, model_id="whatever"
        )

        self.assertFalse(result.ok)
        self.assertNotIn(INTRANET_SENTINEL, result.message, "★ 对方响应正文被回显了")
        self.assertNotIn(SECRET_KEY, result.message)
        # 仍然必须是一句**能照着排查**的中文提示
        self.assertIn("500", result.message)
        self.assertIn("对方服务器内部错误", result.message)
        self.assertIn(self.root, result.message, "失败文案要指出是哪个地址出的事")
        # 并且确实探测了这个服务（不是「什么都没发所以没泄漏」）
        self.assertIn("/models", self.handler.seen_paths)

    def test_500_seen_by_the_models_route_is_also_silent(self) -> None:
        """同一收口在「拉取模型」那条通道上也要成立（它走的是另几条分支）。"""
        result = fetch_provider_models(base_url=self.root, api_key=SECRET_KEY)

        self.assertFalse(result.ok)
        self.assertEqual(result.models, [])
        self.assertNotIn(INTRANET_SENTINEL, result.message)
        self.assertNotIn(SECRET_KEY, result.message)
        self.assertIn("500", result.message)


# --------------------------------------------------------------------------- #
# 401：走 `_auth_failed`（与上一条是**两条不同**的分支，各自收口）
# --------------------------------------------------------------------------- #
class TestAuthFailureIsNotEchoed(_LoopbackServerCase):
    handler = _Leaky401Handler

    def test_401_body_never_reaches_the_probe_result(self) -> None:
        result = probe_llm_connectivity(
            base_url=self.root, api_key=SECRET_KEY, model_id="whatever"
        )

        self.assertFalse(result.ok)
        self.assertNotIn(INTRANET_SENTINEL, result.message)
        self.assertIn("API Key 被拒绝", result.message)
        self.assertIn("401", result.message)
        # ★ 反向对照：Key 的脱敏口径不能因为「不回显正文」而一起丢掉
        self.assertNotIn(SECRET_KEY, result.message)

    def test_401_seen_by_the_models_route_is_also_silent(self) -> None:
        result = fetch_provider_models(base_url=self.root, api_key=SECRET_KEY)

        self.assertFalse(result.ok)
        self.assertNotIn(INTRANET_SENTINEL, result.message)
        self.assertNotIn(SECRET_KEY, result.message)
        self.assertIn("Pi 内置预设", result.message, "失败文案仍要指出下一步该去哪拿候选模型")


# --------------------------------------------------------------------------- #
# 不误伤：合法的自定义 baseUrl 必须照旧能探测成功
# --------------------------------------------------------------------------- #
class TestCustomGatewayStillWorks(_LoopbackServerCase):
    handler = _HealthyHandler

    def test_a_self_hosted_gateway_can_still_be_probed(self) -> None:
        """★★ 修复不许把自建/校内网关一起挡掉（需求硬性要求，**不加主机白名单**）。"""
        result = probe_llm_connectivity(
            base_url=self.root, api_key=SECRET_KEY, model_id="internal-gateway-model"
        )

        self.assertTrue(result.ok, result.message)
        self.assertIn("连通成功", result.message)
        self.assertIn("internal-gateway-model", result.message)
        self.assertNotIn(SECRET_KEY, result.message, "成功路径同样不许回显 Key")
        self.assertEqual(self.handler.seen_paths, ["/models"])

    def test_models_route_still_lists_the_custom_gateway_catalog(self) -> None:
        result = fetch_provider_models(base_url=self.root, api_key=SECRET_KEY)

        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.models, ["internal-gateway-model"])


# --------------------------------------------------------------------------- #
# 状态码 → 归类原因（纯函数，不联网）
# --------------------------------------------------------------------------- #
class TestProviderReasonClassification(unittest.TestCase):
    def test_each_class_of_status_has_a_readable_chinese_reason(self) -> None:
        for status, expected in (
            (400, "ModelID"),
            (401, "鉴权未通过"),
            (403, "权限"),
            (404, "/v1"),
            (429, "限流"),
            (500, "对方服务器内部错误"),
            (502, "网关"),
            (503, "暂不可用"),
            (504, "超时"),
        ):
            with self.subTest(status=status):
                reason = _provider_reason(status)
                self.assertIn(expected, reason)
                self.assertTrue(reason.isprintable())

    def test_unknown_statuses_still_classify_by_their_class(self) -> None:
        """没登记过的状态码也要给一句可读中文（不能空着让界面只显示一个数字）。"""
        self.assertIn("服务器报错", _provider_reason(599))
        self.assertIn("拒绝了这次请求", _provider_reason(418))
        self.assertEqual(_provider_reason(None), "对方返回了无法识别的响应")

    def test_the_reason_text_never_contains_the_body(self) -> None:
        """★ 归类原因只看状态码 —— 传进来的正文连参数位都没有。"""
        body = json_body({"error": {"message": INTRANET_SENTINEL}})
        outcome = HttpOutcome(status=500, body=body)
        message = probe_llm_connectivity(
            base_url="https://gw.example.com/v1",
            api_key=SECRET_KEY,
            model_id="m",
            transport=FakeTransport(default=outcome),
        ).message

        self.assertNotIn(INTRANET_SENTINEL, message)
        self.assertIn("500", message)

    def test_sanitization_still_holds_for_the_masked_key_flow(self) -> None:
        """反向对照：提交掩码（= 用已存 Key）时，回执里也不许出现真 Key。"""
        body = json_body({"error": {"message": f"bad key {SECRET_KEY}"}})
        message = probe_llm_connectivity(
            base_url="https://gw.example.com/v1",
            api_key=MASK,
            model_id="m",
            transport=FakeTransport(default=HttpOutcome(status=403, body=body)),
        ).message

        self.assertNotIn(SECRET_KEY, message)
        self.assertNotIn("bad key", message)
        self.assertIn("403", message)


if __name__ == "__main__":
    unittest.main()
