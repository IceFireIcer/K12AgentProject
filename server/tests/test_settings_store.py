# -*- coding: utf-8 -*-
"""票 07 单测：``config.json`` 原子落盘 + API Key 掩码语义 + **真实连通性探测**。

覆盖三个「错了也不报错、只是悄悄变坏」的点：

1. **半写坏配置**：写入必须原子（临时文件 + ``os.replace``），中途崩溃只能留下旧的完整文件；
   损坏文件要回退默认值 + 留档 + 给可读原因，不能让应用起不来；
2. **Key 被掩码写回磁盘**：设置页把读回来的 ``…abcd`` 原样提交是**自然写法**，
   一旦被当成新 Key 存进去，真 Key 就没了 —— 这条必须有断言守着；
3. **BaseURL 的 ``/v1`` 陷阱**（执行文档 §6.2）：``https://api.deepseek.com``（无 ``/v1``）
   与 ``https://api.deepseek.com/v1`` 两种写法都可能出现，且**只有一种能连通**。
   探测必须原样探测「保存后会用的地址」，并在失败时说清该改成哪一种 ——
   否则现场必然出现「默认值能跑、用户改一下就连不上」。

探测的网络用例全部打在**回环地址上的伪供应商服务**（stdlib ``http.server``）或注入的假传输上：
单测不依赖外网、不依赖真实 Key，也不需要 90MB 模型。
"""

from __future__ import annotations

import http.server
import json
import logging
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import build_runtime_config  # noqa: E402
from app.contracts import (  # noqa: E402
    DEFAULT_LLM_BASE_URL,
    DEFAULT_LLM_MODEL_ID,
    DEFAULT_LLM_PROVIDER_ID,
)
from app.main import create_app  # noqa: E402
from app.routes import settings as settings_module  # noqa: E402
from app.safety import guard  # noqa: E402
from app.routes.settings import (  # noqa: E402
    SETTINGS_STORE_ATTR,
    HttpOutcome,
    InMemorySettingsStore,
    UrllibTransport,
    base_url_variant,
    fetch_provider_models,
    probe_llm_connectivity,
)
from app.security import AUTH_HEADER  # noqa: E402
from app.settings_store import (  # noqa: E402
    CONFIG_CORRUPT_INFIX,
    CONFIG_FILENAME,
    CONFIG_TEMP_SUFFIX,
    ConfigFileSettingsStore,
    SettingsWriteError,
    StoredEmbedding,
    StoredLlm,
    StoredSettings,
    config_path,
    default_settings,
    settings_from_json,
)

TOKEN = "f" * 64  # 与 Electron 侧 randomBytes(32).toString('hex') 同形
SECRET_KEY = "sk-9f3c2b7a41d0e8f6a5b4c3d2e1f09876"  # 测试用假 Key
MASK = f"…{SECRET_KEY[-4:]}"


def authed_client(app: FastAPI) -> TestClient:
    client = TestClient(app)
    client.headers.update({AUTH_HEADER: TOKEN})
    return client


def app_with_data_dir(data_dir: Path) -> FastAPI:
    """显式指定 ``--data-dir`` 的应用（**只有这种情况才落盘**，见 `get_settings_store`）。"""
    return create_app(build_runtime_config(token=TOKEN, data_dir=str(data_dir)))


# --------------------------------------------------------------------------- #
# 假传输：不联网地模拟 200/401/404/超时/DNS
# --------------------------------------------------------------------------- #
def json_body(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class FakeTransport:
    """按 ``(method, url)`` 预置结果的假传输，并记录**实际外呼的地址**。"""

    def __init__(
        self,
        responses: dict[tuple[str, str], HttpOutcome] | None = None,
        default: HttpOutcome | None = None,
    ) -> None:
        self.responses = responses or {}
        self.default = default or HttpOutcome(
            status=404, body=json_body({"error": {"message": "Not Found"}})
        )
        self.calls: list[tuple[str, str]] = []

    def exchange(
        self,
        *,
        method: str,
        url: str,
        api_key: str,
        payload: dict[str, object] | None,
        timeout: float,
    ) -> HttpOutcome:
        self.calls.append((method, url))
        return self.responses.get((method, url), self.default)


# --------------------------------------------------------------------------- #
# 伪供应商服务：只在回环地址上，且**只认 /v1 前缀**（复现现场那类服务）
# --------------------------------------------------------------------------- #
class _FakeProviderHandler(http.server.BaseHTTPRequestHandler):
    api_key = "sk-fake-provider-key-123456"
    seen_authorization: list[str] = []
    seen_paths: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - http.server 的约定命名
        self._record()
        if self.path != "/v1/models":
            # ★ 只有带 /v1 的写法才是正确路径（另一半病例由下个测试覆盖）
            self._json(404, {"error": {"message": "path not found"}})
            return
        if self.headers.get("Authorization") != f"Bearer {self.api_key}":
            self._json(401, {"error": {"message": "Authentication Fails, Your api key is invalid"}})
            return
        self._json(200, {"object": "list", "data": [{"id": "deepseek-chat"}, {"id": "deepseek-reasoner"}]})

    def _record(self) -> None:
        self.seen_paths.append(self.path)
        self.seen_authorization.append(self.headers.get("Authorization", ""))

    def _json(self, status: int, payload: object) -> None:
        body = json_body(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        """别把访问日志打到 stderr（测试输出要干净）。"""


class _RedirectHandler(http.server.BaseHTTPRequestHandler):
    """回 302 的「跳板」服务：指向 ``target``（用于验证探测**不跟随跳转**）。

    与 :class:`_FakeProviderHandler` 一样只跑在回环上；它记录收到的 ``Authorization``
    （起始地址拿到 Key 是正常的 —— 不正常的只有**跳转目标**也拿到）。
    """

    target = ""
    seen_authorization: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - http.server 的约定命名
        type(self).seen_authorization.append(self.headers.get("Authorization", ""))
        # 故意回一个**跨端口**的跳转：若探测跟随它，Key 就会跟着头一起送过去。
        self.send_response(302)
        self.send_header("Location", type(self).target)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args: object) -> None:
        """同上：安静一点。"""


class _StatuslessResponse:
    """模拟「没有 ``.status`` 属性」的响应对象（`data:` / `file:` 那类协议）。"""

    def __init__(self, body: bytes = b"hello") -> None:
        self._body = body

    def read(self, _limit: int | None = None) -> bytes:
        return self._body

    def __enter__(self) -> "_StatuslessResponse":
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False


class _StatuslessOpener:
    """把 :data:`app.routes.settings._PROBE_OPENER` 换成一个只会返回无状态码响应的对象。"""

    def open(self, request: object, timeout: float | None = None) -> _StatuslessResponse:  # noqa: ARG002
        return _StatuslessResponse()


class TestProbeOverRealHttp(unittest.TestCase):
    """★ 用真 socket（仅回环）验证「探测的就是要保存的那个地址」与 ``/v1`` 差异。"""

    @classmethod
    def setUpClass(cls) -> None:
        _FakeProviderHandler.seen_paths = []
        _FakeProviderHandler.seen_authorization = []
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeProviderHandler)
        cls.port = int(cls.server.server_address[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        _FakeProviderHandler.seen_paths = []
        _FakeProviderHandler.seen_authorization = []

    @property
    def root(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def test_models_ok_uses_the_exact_url_that_will_be_saved(self) -> None:
        result = probe_llm_connectivity(
            base_url=f"{self.root}/v1",
            api_key=_FakeProviderHandler.api_key,
            model_id="deepseek-chat",
        )

        self.assertTrue(result.ok, result.message)
        self.assertIn("连通成功", result.message)
        self.assertIn("可见模型 2 个", result.message)
        # ★ 请求确实打在 `<保存后要用的地址>/models` 上（而不是悄悄改写过的地址）
        self.assertEqual(_FakeProviderHandler.seen_paths, ["/v1/models"])
        # ★ Key 走请求头；探测用的假服务看不到任何查询串（不会被写进 URL / 日志 / 代理）
        self.assertEqual(
            _FakeProviderHandler.seen_authorization,
            [f"Bearer {_FakeProviderHandler.api_key}"],
        )

    def test_missing_v1_prefix_is_diagnosed_not_silently_rewritten(self) -> None:
        """★ 少写 ``/v1`` 的服务：探测仍原样打过去，失败原因直接告诉用户该加 ``/v1``。"""
        result = probe_llm_connectivity(
            base_url=self.root,
            api_key=_FakeProviderHandler.api_key,
            model_id="deepseek-chat",
        )

        self.assertFalse(result.ok, "用户填的地址不通时不能报成功（保存后 Pi 用的就是它）")
        self.assertIn(f"{self.root}/v1", result.message, "必须给出可照抄的正确地址")
        self.assertIn("请把 BaseURL 改成", result.message)
        # 三轮：GET {base}/models → GET /v1/models（诊断）→ POST 对话端点（BaseHTTPRequestHandler 无 do_POST → 501）
        self.assertIn("/models", _FakeProviderHandler.seen_paths)

    def test_extra_v1_is_diagnosed_when_the_service_has_no_v1(self) -> None:
        """反向病例：服务根本没有 ``/v1``（默认值反而是错的）→ 同样报错并给出正确写法。"""

        class _NoV1Handler(_FakeProviderHandler):
            def do_GET(self) -> None:  # noqa: N802
                self._record()
                if self.path != "/models":
                    self._json(404, {"error": {"message": "path not found"}})
                    return
                self._json(200, {"data": [{"id": "deepseek-chat"}]})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _NoV1Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = int(server.server_address[1])
            result = probe_llm_connectivity(
                base_url=f"http://127.0.0.1:{port}/v1",
                api_key=_NoV1Handler.api_key,
                model_id="deepseek-chat",
            )
            self.assertFalse(result.ok)
            self.assertIn(f"http://127.0.0.1:{port}", result.message)
            self.assertIn("请把 BaseURL 改成", result.message)
            self.assertNotIn("/v1（保存后", result.message, "不能把带 /v1 的坏地址推荐给用户")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_wrong_key_is_reported_as_key_problem(self) -> None:
        result = probe_llm_connectivity(
            base_url=f"{self.root}/v1", api_key="sk-wrong-key-000000", model_id="deepseek-chat"
        )

        self.assertFalse(result.ok)
        self.assertIn("API Key 被拒绝", result.message)
        self.assertIn("401", result.message)
        self.assertNotIn("sk-wrong-key-000000", result.message, "★ 失败信息里不能回显 Key")

    def test_unreachable_port_fails_fast_with_readable_reason(self) -> None:
        """★ 不通的地址必须**几秒内**给出可读中文，而不是把界面挂住。"""
        started = time.monotonic()
        result = probe_llm_connectivity(
            base_url="http://127.0.0.1:9/v1",  # 9 = discard：回环上没人监听
            api_key=SECRET_KEY,
            model_id="deepseek-chat",
        )
        elapsed = time.monotonic() - started

        self.assertFalse(result.ok)
        self.assertLess(elapsed, 5.0, f"探测耗时 {elapsed:.1f}s，会把设置页卡住")
        self.assertTrue(
            any(word in result.message for word in ("连接被拒绝", "网络请求失败", "连接超时")),
            result.message,
        )

    # ------------------------------------------------------------------ A1 --
    def test_a_stored_key_is_bound_to_its_own_address(self) -> None:
        """★ A1 的正面口径：**同一个地址**才允许复用已存 Key（这条防线不误伤正常用法）。

        真正的攻击用例在 `TestProbeCredentialBoundary`（那里有伪「攻击者服务」记录一切）。
        """
        from app.contracts import LlmConfigIn
        from app.routes.settings import _resolve_probe_credentials
        from app.settings_store import StoredLlm

        stored = StoredLlm(base_url=f"{self.root}/v1", api_key=SECRET_KEY, model_id="deepseek-chat")
        same = _resolve_probe_credentials(
            LlmConfigIn(base_url=f"{self.root}/v1/", api_key=MASK), stored
        )

        self.assertEqual(same.api_key, SECRET_KEY)
        self.assertIsNone(same.error)
        self.assertEqual(same.base_url, f"{self.root}/v1")

    # ------------------------------------------------------------------ A2 --
    def test_non_http_schemes_never_reach_the_transport(self) -> None:
        """★ A2：非 http(s) 一律在入口挡住（`file:` 以前会真读本机文件并把路径回显）。"""
        for submitted in ("api.deepseek.com", "data:text/plain,hi", "file:///C:/Windows/win.ini"):
            with self.subTest(base_url=submitted):
                result = probe_llm_connectivity(
                    base_url=submitted, api_key=SECRET_KEY, model_id="deepseek-chat"
                )

                self.assertFalse(result.ok)
                self.assertIn("http", result.message)
                self.assertNotIn("win.ini", result.message)
                self.assertNotIn(SECRET_KEY, result.message)

        models = fetch_provider_models(base_url="file:///C:/Windows/win.ini", api_key=SECRET_KEY)
        self.assertFalse(models.ok)
        self.assertEqual(models.models, [])
        self.assertNotIn("win.ini", models.message)

    def test_the_transport_survives_a_statusless_response(self) -> None:
        """★ A2：``int(response.status)`` 前判 ``None`` —— 否则 `data:` 协议直接 500。"""
        with mock.patch.object(settings_module, "_PROBE_OPENER", _StatuslessOpener()):
            outcome = UrllibTransport().exchange(
                method="GET",
                url="http://127.0.0.1:9/v1/models",
                api_key=SECRET_KEY,
                payload=None,
                timeout=3.0,
            )

        self.assertIsNone(outcome.status)
        self.assertEqual(outcome.error, "config")
        self.assertNotIn(SECRET_KEY, outcome.detail)

    # ------------------------------------------------------------------ A3 --
    def test_a_redirect_is_reported_and_never_followed(self) -> None:
        """★★ A3：跨主机/跨端口 302 不许把 ``Authorization`` 转发给跳转目标。"""
        target = _FakeProviderHandler  # 跳转目标 = 我们的「攻击者服务」（记录一切）
        target.seen_paths = []
        target.seen_authorization = []

        redirector = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RedirectHandler)
        _RedirectHandler.seen_authorization = []
        _RedirectHandler.target = f"{self.root}/v1"
        thread = threading.Thread(target=redirector.serve_forever, daemon=True)
        thread.start()
        try:
            port = int(redirector.server_address[1])
            result = probe_llm_connectivity(
                base_url=f"http://127.0.0.1:{port}/v1",
                api_key=SECRET_KEY,
                model_id="deepseek-chat",
            )
        finally:
            redirector.shutdown()
            redirector.server_close()
            thread.join(timeout=5)

        self.assertFalse(result.ok, "跳转不是「连通成功」，它只证明地址填的不是最终地址")
        self.assertIn("跳转", result.message)
        self.assertIn("302", result.message)
        self.assertNotIn(SECRET_KEY, result.message)
        # ★ 跳转目标一个字节都没收到（Key 也就没有跟着过去）
        self.assertEqual(target.seen_paths, [], "★ 跟随了重定向：Key 已经被转发给跳转目标")
        self.assertEqual(target.seen_authorization, [])
        # ★ 起始地址确实收到过 Key（它才是用户填的那个地址），说明这不是「啥都没发」
        self.assertEqual(_RedirectHandler.seen_authorization, [f"Bearer {SECRET_KEY}"])

    def test_a_redirect_target_is_never_echoed_to_the_ui(self) -> None:
        """跳转目标不该被回显到界面上（响应方控制的内容不进我们的 UI 文案）。"""
        target = _FakeProviderHandler
        target.seen_paths = []

        redirector = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RedirectHandler)
        _RedirectHandler.target = "http://evil.example.com/v1"
        thread = threading.Thread(target=redirector.serve_forever, daemon=True)
        thread.start()
        try:
            port = int(redirector.server_address[1])
            result = probe_llm_connectivity(
                base_url=f"http://127.0.0.1:{port}/v1",
                api_key=SECRET_KEY,
                model_id="deepseek-chat",
            )
        finally:
            redirector.shutdown()
            redirector.server_close()
            thread.join(timeout=5)

        self.assertFalse(result.ok)
        self.assertIn("跳转", result.message)
        self.assertNotIn("evil.example.com", result.message, "响应方给的目标地址不该被我们回显")
        self.assertEqual(target.seen_paths, [])


# --------------------------------------------------------------------------- #
# 探测的失败分支（注入假传输，不联网）
# --------------------------------------------------------------------------- #
class TestProbeDiagnosis(unittest.TestCase):
    def _probe(self, transport: FakeTransport, base_url: str = "https://api.deepseek.com/v1"):
        return probe_llm_connectivity(
            base_url=base_url,
            api_key=SECRET_KEY,
            model_id="deepseek-chat",
            transport=transport,
        )

    def test_empty_base_url_and_missing_key_are_readable(self) -> None:
        self.assertIn("BaseURL 不能为空", self._probe(FakeTransport(), base_url="").message)

        result = probe_llm_connectivity(
            base_url="https://api.deepseek.com/v1", api_key="", model_id="deepseek-chat"
        )
        self.assertFalse(result.ok)
        self.assertIn("尚未配置 API Key", result.message)

    def test_timeout_reports_seconds_and_does_not_retry_forever(self) -> None:
        transport = FakeTransport(default=HttpOutcome(error="timeout", detail="连接超时"))
        result = self._probe(transport)

        self.assertFalse(result.ok)
        self.assertIn("连接超时", result.message)
        self.assertIn("不影响保存", result.message)
        self.assertEqual(transport.calls, [("GET", "https://api.deepseek.com/v1/models")],
                         "超时属网络层问题：不该再去试另一种 URL 写法（会白等一轮）")

    def test_dns_failure_names_the_host(self) -> None:
        transport = FakeTransport(default=HttpOutcome(error="dns", detail="gaierror"))
        result = self._probe(transport, base_url="https://api.exmple-typo.com/v1")

        self.assertFalse(result.ok)
        self.assertIn("域名解析失败", result.message)
        self.assertIn("api.exmple-typo.com", result.message)

    def test_refused_and_tls_have_distinct_messages(self) -> None:
        refused = self._probe(FakeTransport(default=HttpOutcome(error="refused")))
        self.assertIn("连接被拒绝", refused.message)

        tls = self._probe(FakeTransport(default=HttpOutcome(error="tls", detail="CERTIFICATE_VERIFY_FAILED")))
        self.assertIn("证书", tls.message)

        config = self._probe(FakeTransport(default=HttpOutcome(error="config", detail="unknown url type: 'api.deepseek.com'")))
        self.assertIn("BaseURL 形式不对", config.message)

    def test_models_endpoint_missing_falls_back_to_one_token_request(self) -> None:
        """有些兼容服务没有 ``/models``：用 1-token 对话请求兜底，仍算连通。"""
        typed = "https://gateway.example.com/v1"
        transport = FakeTransport(
            {
                ("GET", f"{typed}/models"): HttpOutcome(status=404, body=b"{}"),
                ("POST", f"{typed}/chat/completions"): HttpOutcome(status=200, body=b'{"choices":[]}'),
            }
        )
        result = self._probe(transport, base_url=typed)

        self.assertTrue(result.ok, result.message)
        self.assertIn("1-token", result.message)
        self.assertEqual(
            [url for _, url in transport.calls],
            [f"{typed}/models", f"{typed}/chat/completions"],
        )

    def test_rejected_ping_points_at_the_model_id(self) -> None:
        typed = "https://gateway.example.com/v1"
        transport = FakeTransport(
            {
                ("GET", f"{typed}/models"): HttpOutcome(status=404, body=b"{}"),
                ("POST", f"{typed}/chat/completions"): HttpOutcome(
                    status=400,
                    body=json_body({"error": {"message": "Model Not Exist"}}),
                ),
            }
        )
        result = self._probe(transport, base_url=typed)

        self.assertFalse(result.ok)
        self.assertIn("Model Not Exist", result.message)
        self.assertIn("ModelID", result.message)

    def test_provider_error_body_is_sanitized(self) -> None:
        """★ 供应商可能把请求头/Key 回显在错误体里 —— 回显给用户前必须先脱敏。"""
        body = json_body({"error": {"message": f"invalid api key: {SECRET_KEY}"}})
        result = self._probe(FakeTransport(default=HttpOutcome(status=401, body=body)))

        self.assertFalse(result.ok)
        self.assertNotIn(SECRET_KEY, result.message)
        self.assertIn("已隐藏", result.message)

    def test_success_message_mentions_missing_model_id_but_stays_ok(self) -> None:
        body = json_body({"data": [{"id": "deepseek-reasoner"}]})
        result = self._probe(
            FakeTransport(default=HttpOutcome(status=200, body=body)),
            base_url="https://api.deepseek.com/v1",
        )

        self.assertTrue(result.ok)
        self.assertIn("deepseek-chat", result.message)
        self.assertIn("核对 ModelID", result.message)

    def test_deepseek_hint_mentions_both_forms(self) -> None:
        """把「带不带 /v1 都能用」写进提示，现场少一次误判。"""
        body = json_body({"data": [{"id": "deepseek-chat"}]})
        result = self._probe(FakeTransport(default=HttpOutcome(status=200, body=body)))

        self.assertIn("api.deepseek.com/v1", result.message)
        self.assertIn("两种写法都可用", result.message)

    def test_base_url_variant_covers_both_forms(self) -> None:
        self.assertEqual(base_url_variant("https://api.deepseek.com/v1"), "https://api.deepseek.com")
        self.assertEqual(base_url_variant("https://api.deepseek.com/v1/"), "https://api.deepseek.com")
        self.assertEqual(base_url_variant("https://api.deepseek.com"), "https://api.deepseek.com/v1")
        self.assertIsNone(base_url_variant(""))

    def test_probe_never_puts_the_key_in_the_url(self) -> None:
        """★ Key 只允许走请求头（URL 会进日志、代理与浏览器历史）。"""
        transport = FakeTransport(default=HttpOutcome(status=200, body=json_body({"data": []})))
        self._probe(transport)

        for _, url in transport.calls:
            self.assertNotIn(SECRET_KEY, url)
            self.assertNotIn("api_key", url)

    def test_redirect_is_diagnosed_instead_of_followed(self) -> None:
        """A3：3xx 如实上报（探测不跟随跳转），并且**只发一次**请求。"""
        transport = FakeTransport(default=HttpOutcome(status=302, body=b""))
        result = self._probe(transport, base_url="https://short.example.com/v1")

        self.assertFalse(result.ok)
        self.assertIn("跳转", result.message)
        self.assertIn("302", result.message)
        self.assertEqual(
            transport.calls,
            [("GET", "https://short.example.com/v1/models")],
            "★ 跳转之后还有第二次外呼 —— Key 可能已经被送到跳转目标",
        )

    def test_a_redirecting_chat_endpoint_is_also_not_followed(self) -> None:
        """对话端点（1-token 回退那一步）跳转时同样不跟随。"""
        typed = "https://gw.example.com/v1"
        transport = FakeTransport(
            {
                ("GET", f"{typed}/models"): HttpOutcome(status=404, body=b"{}"),
                ("POST", f"{typed}/chat/completions"): HttpOutcome(status=307, body=b""),
            }
        )
        result = self._probe(transport, base_url=typed)

        self.assertFalse(result.ok)
        self.assertIn("跳转", result.message)
        self.assertEqual(
            [url for _, url in transport.calls],
            [f"{typed}/models", f"{typed}/chat/completions"],
            "★ 跳转后仍有第三次外呼（Key 会跟着过去）",
        )


# --------------------------------------------------------------------------- #
# ★ A1：已存明文 Key 与「地址」绑定（凭据外泄防线）
# --------------------------------------------------------------------------- #
class TestProbeCredentialBoundary(unittest.TestCase):
    """★★ P0：**已存的明文 Key 只允许用于保存它的那个地址**。

    攻击模型（审查里复现过）：渲染进程提交
    ``{"baseUrl": "http://攻击者", "apiKey": "…abcd"}`` —— 那个 Key 字段只是它从
    ``GET /api/settings`` 读到的掩码回显，看起来「什么都没改」。若 sidecar 把掩码解释成
    「用已存 Key」而地址用提交值，攻击者服务就会收到 ``Authorization: Bearer sk-真Key``。
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_with_data_dir(Path(self.tmp.name))
        self.client = authed_client(self.app)

    def _patch_transport(self, transport: FakeTransport):
        return mock.patch.object(settings_module, "UrllibTransport", lambda: transport)

    def _save_gateway(self, base_url: str = "https://gw.example.com/v1") -> None:
        self.client.put(
            "/api/settings", json={"llm": {"baseUrl": base_url, "apiKey": SECRET_KEY}}
        )

    def test_helper_refuses_any_key_when_the_address_changes(self) -> None:
        """直接钉住私有 helper 的返回值（不经过网络，失败信息也最直白）。"""
        from app.contracts import LlmConfigIn
        from app.routes.settings import _resolve_probe_credentials
        from app.settings_store import StoredLlm

        stored = StoredLlm(base_url="https://gw.example.com/v1", api_key=SECRET_KEY, model_id="m")

        same = _resolve_probe_credentials(
            LlmConfigIn(base_url="https://gw.example.com/v1/", api_key=MASK), stored
        )
        self.assertEqual(same.api_key, SECRET_KEY, "同地址时掩码仍应回退已存 Key")

        changed = _resolve_probe_credentials(
            LlmConfigIn(base_url="http://attacker.example.com/v1", api_key=MASK), stored
        )
        self.assertEqual(changed.api_key, "", "★ 换了地址还带着已存 Key")
        self.assertIsNotNone(changed.error)
        assert changed.error is not None
        self.assertIn("重新填写 API Key", changed.error)

        replaced = _resolve_probe_credentials(
            LlmConfigIn(base_url="http://attacker.example.com/v1", api_key="sk-user-typed-0001"),
            stored,
        )
        self.assertEqual(replaced.api_key, "sk-user-typed-0001", "用户自己填的 Key 应照提交值用")
        self.assertIsNone(replaced.error)

    def test_probe_returns_before_any_outbound_call_when_the_address_changed(self) -> None:
        """★ 用假传输断言「一次外呼都没有」—— 这是比「Key 没出现」更强的断言。"""
        self._save_gateway()
        transport = FakeTransport(default=HttpOutcome(status=200, body=json_body({"data": []})))

        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/probe",
                json={"llm": {"baseUrl": "http://attacker.example.com/v1", "apiKey": MASK}},
            )

        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIn("重新填写 API Key", body["message"])
        self.assertIn("gw.example.com", body["message"], "要说清已存 Key 绑定的是哪个地址")
        self.assertEqual(transport.calls, [], "★ 换了地址还外呼了（真实 Key 已经发出去了）")
        self.assertNotIn(SECRET_KEY, response.text)

    def test_models_returns_before_any_outbound_call_when_the_address_changed(self) -> None:
        self._save_gateway()
        transport = FakeTransport(default=HttpOutcome(status=200, body=json_body({"data": []})))

        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/models",
                json={"llm": {"baseUrl": "http://attacker.example.com/v1", "apiKey": MASK}},
            )

        body = response.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["models"], [])
        self.assertIn("重新填写 API Key", body["message"])
        self.assertEqual(transport.calls, [])
        self.assertNotIn(SECRET_KEY, response.text)

    def test_a_new_key_unlocks_the_new_address(self) -> None:
        """换了地址 + 真填了新 Key → 照常探测（不能因为安全边界把正常用法堵死）。"""
        self._save_gateway()
        transport = FakeTransport(default=HttpOutcome(status=200, body=json_body({"data": [{"id": "m"}]})))

        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/probe",
                json={"llm": {"baseUrl": "http://new.example.com/v1", "apiKey": "sk-new-key-0987"}},
            )

        self.assertTrue(response.json()["ok"], response.text)
        self.assertEqual([url for _, url in transport.calls], ["http://new.example.com/v1/models"])

    def test_no_stored_key_still_gives_the_plain_readable_hint(self) -> None:
        """没存过 Key 时保持原有文案（不要用安全边界文案去糊无 Key 的情况）。"""
        response = self.client.post(
            "/api/settings/probe",
            json={"llm": {"baseUrl": "http://attacker.example.com/v1", "apiKey": ""}},
        )
        self.assertIn("尚未配置 API Key", response.json()["message"])


class TestCredentialBoundaryOverRealHttp(unittest.TestCase):
    """★★ A1 的原始攻击，**用真 socket 复现**（回环地址上起一个伪「攻击者服务」）。

    这条与 `TestProbeCredentialBoundary` 的区别：那边注入假传输（断言「一次外呼都没有」），
    这边**不注入任何东西** —— 请求真发得出去就会落到攻击者服务上并被记录。
    所以「攻击者什么也没收到」是端到端的证据，而不是「我们以为没发」。
    """

    @classmethod
    def setUpClass(cls) -> None:
        _FakeProviderHandler.seen_paths = []
        _FakeProviderHandler.seen_authorization = []
        cls.attacker = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeProviderHandler)
        cls.attacker_port = int(cls.attacker.server_address[1])
        cls.thread = threading.Thread(target=cls.attacker.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.attacker.shutdown()
        cls.attacker.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        _FakeProviderHandler.seen_paths = []
        _FakeProviderHandler.seen_authorization = []
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_with_data_dir(Path(self.tmp.name))
        self.client = authed_client(self.app)

        # 用户真正的配置：真 Key + 官方地址（与攻击者地址明显不同）
        saved = self.client.put(
            "/api/settings",
            json={"llm": {"baseUrl": "https://api.deepseek.com", "apiKey": SECRET_KEY}},
        )
        self.assertEqual(saved.status_code, 200, saved.text)

    @property
    def attacker_url(self) -> str:
        return f"http://127.0.0.1:{self.attacker_port}/v1"

    def test_probe_route_never_sends_the_stored_key_to_another_address(self) -> None:
        """★ 攻击：提交「攻击者地址 + 我读到的掩码」，攻击者不该收到任何东西。"""
        response = self.client.post(
            "/api/settings/probe", json={"llm": {"baseUrl": self.attacker_url, "apiKey": MASK}}
        )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIn("重新填写 API Key", body["message"])
        self.assertEqual(
            _FakeProviderHandler.seen_authorization, [], "★ 攻击者收到了带真 Key 的请求头（凭据外泄）"
        )
        self.assertEqual(_FakeProviderHandler.seen_paths, [], "★ 攻击者收到了请求（地址已按提交值外呼）")
        self.assertNotIn(SECRET_KEY, response.text)

    def test_models_route_never_sends_the_stored_key_to_another_address(self) -> None:
        """A1 的第二条路径：同一套边界，不能只修一条。"""
        response = self.client.post(
            "/api/settings/models", json={"llm": {"baseUrl": self.attacker_url, "apiKey": MASK}}
        )

        body = response.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["models"], [])
        self.assertIn("重新填写 API Key", body["message"])
        self.assertEqual(_FakeProviderHandler.seen_authorization, [])
        self.assertEqual(_FakeProviderHandler.seen_paths, [])

    def test_the_stored_key_is_still_usable_for_its_own_address(self) -> None:
        """★ 对照断言（真网络）：地址没变时掩码照旧回退已存 Key，探测真的打过去。

        否则「保存完再点探测」永远红 —— 安全边界把正常用法一起堵死，等于没修好。
        """
        saved_url = f"{self.attacker_url}"
        self.client.put(
            "/api/settings",
            json={"llm": {"baseUrl": saved_url, "apiKey": _FakeProviderHandler.api_key}},
        )

        response = self.client.post(
            "/api/settings/probe", json={"llm": {"baseUrl": saved_url, "apiKey": MASK}}
        )

        self.assertTrue(response.json()["ok"], response.text)
        self.assertEqual(_FakeProviderHandler.seen_paths, ["/v1/models"])
        self.assertEqual(
            _FakeProviderHandler.seen_authorization,
            [f"Bearer {_FakeProviderHandler.api_key}"],
        )

    def test_a_user_supplied_key_may_go_to_a_new_address(self) -> None:
        """用户自己填的新 Key + 新地址 = 正常用法（换供应商必须还能用）。"""
        response = self.client.post(
            "/api/settings/probe",
            json={"llm": {"baseUrl": self.attacker_url, "apiKey": _FakeProviderHandler.api_key}},
        )

        self.assertTrue(response.json()["ok"], response.text)
        self.assertNotIn(SECRET_KEY, response.text, "★ 已存的真 Key 不该出现在这次外呼里")
        self.assertEqual(
            _FakeProviderHandler.seen_authorization,
            [f"Bearer {_FakeProviderHandler.api_key}"],
        )

    def test_non_http_schemes_are_readable_and_touch_nothing(self) -> None:
        """★ A2（路由口径）：漏写 ``https://`` / ``data:`` / ``file:`` 一律可读结论。

        `file:` 尤其要紧：以前会真把本机文件读出来，连绝对路径与系统错误文本一起回显。
        """
        for submitted in ("api.deepseek.com", "data:text/plain,hi", "file:///C:/Windows/win.ini"):
            with self.subTest(base_url=submitted):
                response = self.client.post(
                    "/api/settings/probe", json={"llm": {"baseUrl": submitted, "apiKey": SECRET_KEY}}
                )

                self.assertEqual(response.status_code, 200, response.text)
                body = response.json()
                self.assertFalse(body["ok"])
                self.assertIn("http", body["message"])
                # ★ 不回显提交的字符串（那可能是本机路径），更不能把文件内容读出来
                self.assertNotIn("win.ini", response.text)
                self.assertNotIn("[fonts]", response.text.lower())
                self.assertNotIn(SECRET_KEY, response.text)

        self.assertEqual(_FakeProviderHandler.seen_paths, [])


# --------------------------------------------------------------------------- #
# 探测路由（HTTP 边界）
# --------------------------------------------------------------------------- #
class TestProbeRoute(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_with_data_dir(Path(self.tmp.name))
        self.client = authed_client(self.app)

    def _patch_transport(self, transport: FakeTransport):
        return mock.patch.object(settings_module, "UrllibTransport", lambda: transport)

    def test_probe_uses_the_stored_key_when_the_mask_is_submitted(self) -> None:
        """调用方提交掩码 ==「用已存的 Key」（否则用户不重填就没法探测）。"""
        self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})

        transport = FakeTransport(default=HttpOutcome(status=200, body=json_body({"data": [{"id": "deepseek-chat"}]})))
        with self._patch_transport(transport):
            response = self.client.post("/api/settings/probe", json={"llm": {"apiKey": MASK}})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"], response.text)

    def test_probe_requires_a_key(self) -> None:
        response = self.client.post(
            "/api/settings/probe", json={"llm": {"providerName": "自建", "baseUrl": "http://127.0.0.1:9/v1"}}
        )
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIn("尚未配置 API Key", body["message"])

    def test_probe_failure_still_allows_saving(self) -> None:
        """★ 探测与保存解耦：断网/不可达也要能存配置（离线演示场景）。"""
        with self._patch_transport(FakeTransport(default=HttpOutcome(error="dns"))):
            probe = self.client.post("/api/settings/probe", json={"llm": {"apiKey": SECRET_KEY}})
        self.assertFalse(probe.json()["ok"])

        saved = self.client.put(
            "/api/settings",
            json={"llm": {"providerName": "自建网关", "baseUrl": "https://gw.example.com/v1",
                          "apiKey": SECRET_KEY, "modelId": "my-model"}},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(self.client.get("/api/settings").json()["llm"]["providerName"], "自建网关")

    def test_unreachable_base_url_returns_readable_reason_quickly(self) -> None:
        started = time.monotonic()
        response = self.client.post(
            "/api/settings/probe",
            json={"llm": {"baseUrl": "http://127.0.0.1:9/v1", "apiKey": SECRET_KEY}},
        )
        elapsed = time.monotonic() - started

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertNotIn(SECRET_KEY, response.text)
        self.assertLess(elapsed, 5.0, f"探测耗时 {elapsed:.1f}s，会把设置页卡住")
        self.assertTrue(any(word in body["message"] for word in ("连接被拒绝", "网络请求失败", "连接超时")),
                        body["message"])

    def test_probe_never_returns_the_plaintext_key(self) -> None:
        self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})
        response = self.client.post("/api/settings/probe", json={"llm": {"apiKey": SECRET_KEY}})
        self.assertNotIn(SECRET_KEY, response.text)


# --------------------------------------------------------------------------- #
# 拉取模型（`POST /api/settings/models`）
# --------------------------------------------------------------------------- #
class TestFetchProviderModels(unittest.TestCase):
    """「拉取模型」：与探测共用外呼实现，但**只列候选**（不证明可用）。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_with_data_dir(Path(self.tmp.name))
        self.client = authed_client(self.app)

    def _patch_transport(self, transport: FakeTransport):
        return mock.patch.object(settings_module, "UrllibTransport", lambda: transport)

    def test_returns_model_ids_from_a_standard_models_endpoint(self) -> None:
        transport = FakeTransport(
            default=HttpOutcome(
                status=200,
                body=json_body({"object": "list", "data": [{"id": "glm-5.2"}, {"id": "glm-5.3"}]}),
            )
        )
        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/models",
                json={"llm": {"baseUrl": "https://api.z.ai/api/coding/paas/v4", "apiKey": SECRET_KEY}},
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["models"], ["glm-5.2", "glm-5.3"])
        self.assertIn("2", body["message"])
        self.assertNotIn(SECRET_KEY, response.text)

    def test_requires_a_base_url(self) -> None:
        result = fetch_provider_models(base_url="", api_key=SECRET_KEY)
        self.assertFalse(result.ok)
        self.assertEqual(result.models, [])
        self.assertIn("BaseURL 不能为空", result.message)

    def test_empty_catalog_is_not_reported_as_success_with_models(self) -> None:
        """端点通了但一个模型都没报出来：**如实说清**，不要假装拉到了东西。"""
        transport = FakeTransport(default=HttpOutcome(status=200, body=json_body({"data": []})))
        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/models", json={"llm": {"baseUrl": "http://127.0.0.1:9/v1", "apiKey": SECRET_KEY}}
            )

        body = response.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["models"], [])
        self.assertIn("没有报出任何模型", body["message"])

    def test_non_standard_body_stays_readable(self) -> None:
        """响应不是标准模型列表（有些兼容服务如此）：给可读结论并允许手填。"""
        transport = FakeTransport(default=HttpOutcome(status=200, body=b"<html>hello</html>"))
        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/models", json={"llm": {"baseUrl": "http://127.0.0.1:9/v1", "apiKey": SECRET_KEY}}
            )

        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIn("手填", body["message"])

    def test_auth_failure_is_readable_and_mentions_presets(self) -> None:
        transport = FakeTransport(
            default=HttpOutcome(status=401, body=json_body({"error": {"message": "invalid api key"}}))
        )
        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/models", json={"llm": {"baseUrl": "https://api.z.ai/api/v4", "apiKey": SECRET_KEY}}
            )

        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIn("API Key 被拒绝", body["message"])
        # 端点不通时界面仍要有候选可选用 —— 文案里要指出去哪里拿
        self.assertIn("Pi 内置预设", body["message"])
        self.assertNotIn(SECRET_KEY, response.text)

    def test_missing_models_endpoint_points_at_the_other_url_form(self) -> None:
        """404（没有 /models 端点）时说清另一种 /v1 写法，并明确「不影响保存」。"""
        transport = FakeTransport(default=HttpOutcome(status=404, body=b""))
        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/models", json={"llm": {"baseUrl": "https://api.deepseek.com", "apiKey": SECRET_KEY}}
            )

        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIn("/v1", body["message"])
        self.assertIn("不影响保存", body["message"])

    def test_uses_the_stored_key_when_the_mask_is_submitted(self) -> None:
        """掩码 + **同一个地址** == 「用已存的 Key」（这是用户点「探测」的常规路径）。"""
        self.client.put(
            "/api/settings",
            json={"llm": {"baseUrl": "https://gw.example.com/v1", "apiKey": SECRET_KEY}},
        )

        transport = FakeTransport(default=HttpOutcome(status=200, body=json_body({"data": [{"id": "m"}]})))
        with self._patch_transport(transport):
            response = self.client.post(
                "/api/settings/models",
                json={"llm": {"baseUrl": "https://gw.example.com/v1", "apiKey": MASK}},
            )

        self.assertTrue(response.json()["ok"], response.text)
        self.assertEqual([url for _, url in transport.calls], ["https://gw.example.com/v1/models"])


# --------------------------------------------------------------------------- #
# 主进程专用的运行时配置（`GET /api/settings/runtime`）
# --------------------------------------------------------------------------- #
class TestRuntimeConfigRoute(unittest.TestCase):
    """★★ 这条接口**含明文 Key**，是「设置 → Pi」的唯一载体。

    三条安全边界各有一组断言（缺任何一条这条链路都不成立）：
      ① 与其它 `/api/*` 一样需要 token；
      ② 读设置那条接口（`GET /api/settings`）**仍然只回掩码**；
      ③ 明文只在 `api_key` 这一个字段里（`has_key` 是布尔，不含密钥）。
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_with_data_dir(Path(self.tmp.name))
        self.client = authed_client(self.app)

    def test_requires_auth(self) -> None:
        anonymous = TestClient(self.app)
        self.assertEqual(anonymous.get("/api/settings/runtime").status_code, 401)

    def test_returns_the_plaintext_key_for_the_main_process(self) -> None:
        self.client.put(
            "/api/settings",
            json={
                "llm": {
                    "providerId": "zai",
                    "providerName": "Z.AI",
                    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
                    "apiKey": SECRET_KEY,
                    "modelId": "glm-5.2",
                }
            },
        )

        body = self.client.get("/api/settings/runtime").json()

        self.assertEqual(body["providerId"], "zai")
        self.assertEqual(body["modelId"], "glm-5.2")
        self.assertEqual(body["baseUrl"], "https://api.z.ai/api/coding/paas/v4")
        self.assertEqual(body["apiKey"], SECRET_KEY, "主进程要拿到明文才发得出请求")
        self.assertTrue(body["hasKey"])

    def test_the_plaintext_key_never_leaks_into_the_normal_settings_read(self) -> None:
        """★ 对照断言：同一个存储，`GET /api/settings` 读回来必须仍是掩码。"""
        self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})

        normal = self.client.get("/api/settings")
        self.assertEqual(normal.json()["llm"]["apiKey"], MASK)
        self.assertNotIn(SECRET_KEY, normal.text)

    def test_repr_never_contains_the_key(self) -> None:
        """契约模型的 `repr` 也必须干净（异常里打印模型是常见事故）。"""
        from app.contracts import LlmRuntimeConfig

        config = LlmRuntimeConfig(api_key=SECRET_KEY)
        self.assertNotIn(SECRET_KEY, repr(config))
        self.assertNotIn(SECRET_KEY[-8:], repr(config))

    def test_defaults_are_returned_before_anything_is_saved(self) -> None:
        body = self.client.get("/api/settings/runtime").json()
        self.assertEqual(body["providerId"], DEFAULT_LLM_PROVIDER_ID)
        self.assertEqual(body["baseUrl"], DEFAULT_LLM_BASE_URL)
        self.assertEqual(body["modelId"], DEFAULT_LLM_MODEL_ID)
        self.assertEqual(body["apiKey"], "")
        self.assertFalse(body["hasKey"])


# --------------------------------------------------------------------------- #
# provider_id 在 HTTP 边界的语义（占位即保留）
# --------------------------------------------------------------------------- #
class TestProviderIdRouteSemantics(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_with_data_dir(Path(self.tmp.name))
        self.client = authed_client(self.app)

    def test_partial_put_keeps_the_stored_provider_id(self) -> None:
        """★ 只改 BaseURL 的局部 PUT **不该**把 provider 静默重置回默认值。

        否则设置页分栏保存（或任何一次局部修改）都会悄悄换掉供应商 ——
        表现为「我明明选了 Z.AI，改了下地址就变回 deepseek 了」。
        """
        self.client.put("/api/settings", json={"llm": {"providerId": "zai", "modelId": "glm-5.2"}})

        # 只提交一个字段，providerId 完全不出现
        self.client.put("/api/settings", json={"llm": {"baseUrl": "https://proxy.example.com/v1"}})

        body = self.client.get("/api/settings").json()
        self.assertEqual(body["llm"]["providerId"], "zai")
        self.assertEqual(body["llm"]["baseUrl"], "https://proxy.example.com/v1")

    def test_explicit_provider_id_overwrites(self) -> None:
        self.client.put("/api/settings", json={"llm": {"providerId": "zai"}})
        self.client.put("/api/settings", json={"llm": {"providerId": "openai"}})
        self.assertEqual(self.client.get("/api/settings").json()["llm"]["providerId"], "openai")

    def test_blank_provider_id_falls_back_to_the_stored_one(self) -> None:
        """空串同样按「未修改」处理（前端下拉停在「手动填写」时可能提交空值）。"""
        self.client.put("/api/settings", json={"llm": {"providerId": "zai"}})
        self.client.put("/api/settings", json={"llm": {"providerId": "   "}})
        self.assertEqual(self.client.get("/api/settings").json()["llm"]["providerId"], "zai")


# --------------------------------------------------------------------------- #
# ★ A4：**字段级**局部 PUT —— 没提交的字段一律保留（不许回落出厂默认）
# --------------------------------------------------------------------------- #
class TestPartialPutKeepsUntouchedFields(unittest.TestCase):
    """★ A4：`PUT {"llm": {"apiKey": "…"}}` 这种**字段级**局部提交是受支持的用法。

    修复前只有 `providerId` 是「占位即保留」，其余字段「提交即覆盖」，而入参模型的
    默认值就是出厂默认 —— 于是「只换一下 Key」会把用户自填的校内网关整组换回
    DeepSeek 默认值（providerName / baseUrl / modelId 全丢），界面上还显示「保存成功」。
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_with_data_dir(Path(self.tmp.name))
        self.client = authed_client(self.app)

    def _save_custom_gateway(self) -> None:
        saved = self.client.put(
            "/api/settings",
            json={
                "llm": {
                    "providerId": "custom",
                    "providerName": "校内网关",
                    "baseUrl": "https://gw.example.com/v1",
                    "apiKey": SECRET_KEY,
                    "modelId": "qwen-max",
                }
            },
        )
        self.assertEqual(saved.status_code, 200, saved.text)

    def test_putting_only_a_key_keeps_every_other_llm_field(self) -> None:
        self._save_custom_gateway()

        # 设置页的常规动作：换一把 Key，别的栏一个都没动
        self.client.put("/api/settings", json={"llm": {"apiKey": "sk-brand-new-key-0987"}})

        llm = self.client.get("/api/settings").json()["llm"]
        self.assertEqual(llm["providerId"], "custom")
        self.assertEqual(llm["providerName"], "校内网关")
        self.assertEqual(llm["baseUrl"], "https://gw.example.com/v1")
        self.assertEqual(llm["modelId"], "qwen-max")
        self.assertTrue(llm["hasKey"])
        self.assertEqual(self.client.get("/api/settings/runtime").json()["apiKey"], "sk-brand-new-key-0987")

    def test_blank_submissions_also_keep_the_stored_values(self) -> None:
        """前端输入框被清空后提交空串：同样算「没改」（空 ModelID 根本调不通）。"""
        self._save_custom_gateway()

        self.client.put(
            "/api/settings", json={"llm": {"providerName": "", "baseUrl": "", "modelId": "   "}}
        )

        llm = self.client.get("/api/settings").json()["llm"]
        self.assertEqual(llm["providerName"], "校内网关")
        self.assertEqual(llm["baseUrl"], "https://gw.example.com/v1")
        self.assertEqual(llm["modelId"], "qwen-max")

    def test_explicitly_submitted_fields_still_overwrite(self) -> None:
        """★ 对照断言：真提交了的值必须生效（不能因为「保留」把改配置这条路堵死）。"""
        self._save_custom_gateway()

        self.client.put(
            "/api/settings",
            json={"llm": {"providerId": "zai", "providerName": "Z.AI", "modelId": "glm-5.2"}},
        )

        llm = self.client.get("/api/settings").json()["llm"]
        self.assertEqual(llm["providerId"], "zai")
        self.assertEqual(llm["providerName"], "Z.AI")
        self.assertEqual(llm["modelId"], "glm-5.2")
        self.assertEqual(llm["baseUrl"], "https://gw.example.com/v1", "没提交的地址应保留")

    def test_partial_embedding_put_keeps_mode_and_endpoint(self) -> None:
        """嵌入那栏同一条规则：只换 Key 不该把云端嵌入整组退回本地默认。"""
        self.client.put(
            "/api/settings",
            json={
                "embedding": {
                    "mode": "cloud_api",
                    "baseUrl": "https://embed.example.com/v1",
                    "apiKey": "emb-key-123456",
                    "modelId": "bge-m3",
                }
            },
        )

        self.client.put("/api/settings", json={"embedding": {"apiKey": "emb-key-new-999999"}})

        embedding = self.client.get("/api/settings").json()["embedding"]
        self.assertEqual(embedding["mode"], "cloud_api")
        self.assertEqual(embedding["baseUrl"], "https://embed.example.com/v1")
        self.assertEqual(embedding["modelId"], "bge-m3")
        self.assertTrue(embedding["hasKey"])

    def test_embedding_mode_can_still_be_switched_explicitly(self) -> None:
        """★ 对照断言：显式提交 `mode` 必须真的切过去（默认值不再来自入参模型）。"""
        self.client.put(
            "/api/settings",
            json={"embedding": {"mode": "cloud_api", "baseUrl": "https://embed.example.com/v1"}},
        )
        self.client.put("/api/settings", json={"embedding": {"mode": "none"}})

        embedding = self.client.get("/api/settings").json()["embedding"]
        self.assertEqual(embedding["mode"], "none")
        self.assertEqual(embedding["baseUrl"], "https://embed.example.com/v1", "地址仍应保留")

    def test_partial_put_never_clears_a_stored_key(self) -> None:
        """掩码语义在「字段级局部 PUT」下也要成立（两处规则叠加不能互相破坏）。"""
        self._save_custom_gateway()

        self.client.put("/api/settings", json={"llm": {"baseUrl": "https://gw2.example.com/v1"}})

        self.assertTrue(self.client.get("/api/settings").json()["llm"]["hasKey"])
        self.assertEqual(self.client.get("/api/settings/runtime").json()["apiKey"], SECRET_KEY)


# --------------------------------------------------------------------------- #
# 落盘 / 原子写 / 容错
# --------------------------------------------------------------------------- #
class TestConfigFileStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        self.path = config_path(self.data_dir)

    def store(self) -> ConfigFileSettingsStore:
        return ConfigFileSettingsStore(self.data_dir)

    def test_missing_file_yields_defaults_without_creating_it(self) -> None:
        settings = self.store().load()

        self.assertEqual(settings, default_settings())
        self.assertFalse(self.path.exists(), "只读一次不该有写副作用（GET 不该建文件）")

    def test_round_trip_survives_a_process_restart(self) -> None:
        self.store().save(
            StoredSettings(
                llm=StoredLlm(provider_name="自建网关", base_url="https://gw.example.com", api_key=SECRET_KEY,
                              model_id="my-model"),
                embedding=StoredEmbedding(mode="cloud_api", base_url="https://embed.example.com",
                                          api_key="emb-key-123456", model_id="bge-m3"),
            )
        )

        # ★ 「关掉重开还在」= 换一个 store 实例（新进程）重新读盘
        reloaded = self.store().load()
        self.assertEqual(reloaded.llm.provider_name, "自建网关")
        self.assertEqual(reloaded.llm.model_id, "my-model")
        self.assertEqual(reloaded.llm.api_key, SECRET_KEY)
        self.assertEqual(reloaded.embedding.mode, "cloud_api")
        self.assertEqual(reloaded.embedding.model_id, "bge-m3")

        # 磁盘上的 JSON：明文 Key 按设计落在本地，键名 snake_case，且有版本号
        document = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(document["llm"]["api_key"], SECRET_KEY)
        self.assertEqual(document["llm"]["provider_name"], "自建网关")
        self.assertEqual(document["version"], 1)
        self.assertIn("saved_at", document)

    def test_no_leftover_temp_files_after_saves(self) -> None:
        store = self.store()
        for index in range(5):
            store.save(StoredSettings(llm=StoredLlm(model_id=f"m-{index}", api_key=SECRET_KEY)))

        leftovers = sorted(item.name for item in self.data_dir.iterdir())
        self.assertEqual(leftovers, [CONFIG_FILENAME], f"目录里出现了多余文件：{leftovers}")
        self.assertFalse(self.path.with_name(self.path.name + CONFIG_TEMP_SUFFIX).exists())

    def test_corrupt_file_falls_back_to_defaults_and_keeps_a_backup(self) -> None:
        self.path.write_text('{"llm": {"api_key": "sk-half-writ', encoding="utf-8")  # 半截 JSON

        store = self.store()
        settings = store.load()

        self.assertEqual(settings, default_settings(), "损坏时应回退默认值而不是抛异常")
        self.assertIsNotNone(store.last_error)
        assert store.last_error is not None
        self.assertIn("不是合法 JSON", store.last_error)
        backups = [item for item in self.data_dir.iterdir() if CONFIG_CORRUPT_INFIX in item.name]
        self.assertEqual(len(backups), 1, "损坏的原文件必须留档，不能静默丢掉用户的配置")
        self.assertNotIn(SECRET_KEY, store.last_error)

    def test_corrupt_file_is_repaired_by_the_next_save(self) -> None:
        self.path.write_text("{ 这不是 JSON", encoding="utf-8")
        store = self.store()
        store.save(StoredSettings(llm=StoredLlm(api_key=SECRET_KEY)))

        self.assertIsNone(store.last_error)
        self.assertEqual(self.store().load().llm.api_key, SECRET_KEY)

    def test_tolerates_hand_edited_and_empty_values(self) -> None:
        """手改 ``config.json`` 调试是票 06 的既定用法：camelCase 与坏字段都要能读。"""
        self.path.write_text(
            json.dumps(
                {
                    "llm": {"providerName": "手工改的", "baseUrl": " https://gw.example.com/v1/ ",
                            "apiKey": SECRET_KEY, "modelId": "m", "unknown": "忽略我"},
                    "embedding": {"mode": "瞎写的模式", "baseUrl": "", "modelId": ""},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        store = self.store()
        settings = store.load()

        self.assertEqual(settings.llm.provider_name, "手工改的")
        self.assertEqual(settings.llm.base_url, "https://gw.example.com/v1", "读到就要规范化")
        self.assertEqual(settings.embedding.mode, "local_fastembed", "认不出的枚举回退默认值")
        self.assertIsNone(settings.embedding.base_url)
        self.assertEqual(settings.embedding.model_id, "BAAI/bge-small-zh-v1.5")
        assert store.last_error is not None
        self.assertIn("embedding.mode", store.last_error)

    def test_non_object_and_empty_files_are_tolerated(self) -> None:
        for raw in ("[]", '"str"', "", "   \n"):
            with self.subTest(raw=raw):
                self.path.write_text(raw, encoding="utf-8")
                store = self.store()
                self.assertEqual(store.load(), default_settings())
                self.assertIsNotNone(store.last_error)

    def test_settings_from_json_is_pure_and_reports_issues(self) -> None:
        settings, issues = settings_from_json({"llm": {"base_url": 123}})
        # 默认值来自 DEFAULT_LLM_BASE_URL（与 Pi 内置 deepseek provider 一致：**无 /v1**）
        self.assertEqual(settings.llm.base_url, DEFAULT_LLM_BASE_URL)
        self.assertTrue(any("llm.base_url" in issue for issue in issues))

        settings, issues = settings_from_json({})
        self.assertEqual(settings, default_settings())
        self.assertEqual(issues, [])

    def test_provider_id_is_read_back_and_old_files_get_the_default(self) -> None:
        """★ `provider_id` 的读取兼容：新文件读得回，**旧文件（没有这个键）静默取默认值**。

        升级不该让老用户看到一条无意义的警告 —— 老 `config.json` 没有 `provider_id`
        是完全正常的状态（那个字段是后加的），所以断言 `issues == []`。
        """
        # 旧文件：只有历史字段（没有 provider_id / providerId）
        legacy, legacy_issues = settings_from_json(
            {
                "llm": {
                    "provider_name": "DeepSeek",
                    "base_url": "https://api.deepseek.com/v1",
                    "api_key": SECRET_KEY,
                    "model_id": "deepseek-chat",
                }
            }
        )
        self.assertEqual(legacy.llm.provider_id, DEFAULT_LLM_PROVIDER_ID)
        self.assertEqual(legacy_issues, [], "旧文件缺 provider_id 不该产生任何 issue（静默取默认值）")

        # 新文件（snake_case 与 camelCase 都要认）
        for key in ("provider_id", "providerId"):
            with self.subTest(key=key):
                settings, issues = settings_from_json({"llm": {key: "zai", "model_id": "glm-5.2"}})
                self.assertEqual(settings.llm.provider_id, "zai")
                self.assertEqual(issues, [])

    def test_provider_id_survives_a_round_trip(self) -> None:
        """落盘 → 读回：`provider_id` 必须真的写进 config.json（否则重启就丢）。"""
        store = self.store()
        store.save(
            StoredSettings(
                llm=StoredLlm(
                    provider_id="zai",
                    provider_name="Z.AI",
                    base_url="https://api.z.ai/api/coding/paas/v4",
                    api_key=SECRET_KEY,
                    model_id="glm-5.2",
                )
            )
        )

        document = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(document["llm"]["provider_id"], "zai")
        self.assertEqual(self.store().load().llm.provider_id, "zai")

    def test_write_failure_raises_instead_of_pretending_success(self) -> None:
        blocked = self.data_dir / "not-a-dir"
        blocked.write_text("我是文件不是目录", encoding="utf-8")

        store = ConfigFileSettingsStore(blocked / "sub")
        with self.assertRaises(SettingsWriteError) as caught:
            store.save(StoredSettings(llm=StoredLlm(api_key=SECRET_KEY)))

        message = str(caught.exception)
        self.assertNotIn(SECRET_KEY, message)
        self.assertIn(CONFIG_FILENAME, message)

    def test_stale_temp_file_is_cleaned_on_load(self) -> None:
        """上次进程被强杀留下的临时文件不该永远躺在用户目录里。"""
        self.path.with_name(self.path.name + CONFIG_TEMP_SUFFIX).write_text("{", encoding="utf-8")
        self.store().load()
        self.assertFalse(self.path.with_name(self.path.name + CONFIG_TEMP_SUFFIX).exists())


# --------------------------------------------------------------------------- #
# 保密：repr / 日志
# --------------------------------------------------------------------------- #
class TestKeyNeverLeaks(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)

    def test_repr_of_stored_settings_hides_the_key(self) -> None:
        settings = StoredSettings(
            llm=StoredLlm(api_key=SECRET_KEY), embedding=StoredEmbedding(api_key="emb-key-123456")
        )
        self.assertNotIn(SECRET_KEY, repr(settings))
        self.assertNotIn(SECRET_KEY, str(settings.llm))
        self.assertNotIn("emb-key-123456", repr(settings.embedding))

    def test_logs_never_contain_the_key_and_keep_placeholders(self) -> None:
        """★ 日志脱敏纪律：不含 Key，且**保留 `%s` 占位符**（延迟格式化）。

        无脑把 ``record.msg`` 擦成 ``***`` 会让 ``record.getMessage()`` 抛
        ``TypeError: not all arguments converted during string formatting`` ——
        这里对每条记录都真的调用一次 ``getMessage()`` 来钉住这条纪律。
        """
        store = ConfigFileSettingsStore(self.data_dir)

        with self.assertLogs("app.settings_store", level="INFO") as captured:
            store.save(StoredSettings(llm=StoredLlm(provider_name="自建", api_key=SECRET_KEY)))
            store.load()

        output = "\n".join(captured.output)
        self.assertNotIn(SECRET_KEY, output)
        self.assertIn("API Key=已设置", output)

        records = [record for record in captured.records if record.name == "app.settings_store"]
        self.assertTrue(records, "存储层至少要留下一条可审计的日志")
        for record in records:
            self.assertNotIn(SECRET_KEY, record.getMessage())  # 占位符没被破坏才会走到这里
        self.assertTrue(
            any(record.args for record in records),
            "写盘日志必须用 %s 参数化（不要把 Key 拼进消息，也不要无脑擦 msg）",
        )


class _CapturingHandler(logging.Handler):
    """把格式化后的日志文本收进列表（**真实 handler**，不是 ``assertLogs``）。

    用真实 handler 才能照出「过滤器到底挂在 handler 上没有」—— ``assertLogs`` 会临时
    接管 handler 树，恰好绕开 ``install_log_redaction()`` 实际改写的那批对象。
    """

    def __init__(self, sink: list[str]) -> None:
        super().__init__(level=logging.INFO)
        self.sink = sink

    def emit(self, record: logging.LogRecord) -> None:
        self.sink.append(record.getMessage())


#: 自建/校内网关的**自定义形态** Key。
#: ★ 为什么不能用 `SECRET_KEY`（`sk-…`）：那种形态被 `guard` 的**形态规则**
#:   （`_SECRET_PATTERNS` 的 `sk-[A-Za-z0-9_-]{6,}`）无条件擦掉，**与登记无关** ——
#:   拿它写「登记生效」的断言会得到一条**恒绿的假测试**（已实测踩到：把 `register_secret`
#:   全部删掉，用 `sk-` 形态的用例依然通过）。
#:   这条自定义形态不在任何形态规则里，**只有登记了才会被擦**，才真的在测登记。
GATEWAY_KEY = "gw-8f3a2c1b9d4e6f70a1b2c3d4"


class TestLlmKeyIsRegisteredForRedaction(unittest.TestCase):
    """★★ 回归用例（审计发现，修复前**必红**）：LLM 的明文 Key 必须在保存/加载路径上登记。

    缺陷形态：``guard.install_log_redaction()`` 的过滤器只能抹掉**它认识的**凭据
    （登记表 + 形态规则）。嵌入侧的明文 Key 早在 ``rag/embedder.read_embedding_config``
    里登记了，而 **LLM 的明文 Key 只在 ``routes/settings.py`` 出现** —— 那条线当时
    一个 ``register_secret()`` 调用点都没有。

    为什么必须走**真实子 logger + 真实 root handler**（而不是 ``assertLogs``）：
    ``assertLogs`` 会临时接管 handler，照不出「生产里 filter 到底挂没挂上」。
    这里的顺序与 ``main.py`` 一致：先建 root handler（= ``configure_logging``），
    再装脱敏，最后让 ``app.routes.settings`` 这个子 logger 经 propagate 把记录交给它。
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)

        self.root = logging.getLogger()
        self._saved_handlers = list(self.root.handlers)
        self._saved_level = self.root.level
        self.addCleanup(self._restore_root)

        self.captured: list[str] = []
        self.root.handlers = [_CapturingHandler(self.captured)]
        self.root.setLevel(logging.INFO)
        guard.install_log_redaction()
        self.addCleanup(guard.clear_secrets)

    def _restore_root(self) -> None:
        for handler in list(self.root.handlers):
            handler.filters = [
                f for f in handler.filters if not isinstance(f, guard.RedactionFilter)
            ]
        self.root.handlers = self._saved_handlers
        self.root.setLevel(self._saved_level)
        self.root.filters = [
            f for f in self.root.filters if not isinstance(f, guard.RedactionFilter)
        ]

    def _client(self) -> TestClient:
        return authed_client(
            create_app(build_runtime_config(token=TOKEN, data_dir=str(self.data_dir)))
        )

    def test_saving_a_key_registers_it_for_redaction(self) -> None:
        """``PUT /api/settings`` 存下的明文 Key，之后任何日志里都必须被擦掉。"""
        client = self._client()
        response = client.put("/api/settings", json={"llm": {"apiKey": GATEWAY_KEY}})
        self.assertEqual(response.status_code, 200)

        # 生产形态：子 logger 经 propagate 交给 root 的 handler
        logging.getLogger("app.routes.settings").warning("保存后的诊断行 key=%s", GATEWAY_KEY)

        self.assertTrue(self.captured, "子 logger 的记录没有到达 root 的 handler")
        leaked = [line for line in self.captured if GATEWAY_KEY in line]
        self.assertEqual(leaked, [], f"明文 Key 进了日志：{leaked}")

    def test_loading_settings_registers_the_key_for_redaction(self) -> None:
        """★ 加载路径同样要登记 —— 进程重启后第一次读配置就得生效。

        只有保存路径登记是不够的：重启后到第一次保存之间，任何读配置触发的日志
        都会漏出上一次存下的明文 Key。
        """
        # 先直接落盘（不经路由，模拟「上次运行留下的配置」）
        ConfigFileSettingsStore(self.data_dir).save(
            StoredSettings(llm=StoredLlm(provider_name="自建", api_key=GATEWAY_KEY))
        )
        guard.clear_secrets()  # 确保「登记」只可能来自本次加载

        client = self._client()
        response = client.get("/api/settings")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(GATEWAY_KEY, response.text, "读设置只许回掩码")

        logging.getLogger("app.routes.settings").warning("加载后的诊断行 key=%s", GATEWAY_KEY)
        self.assertTrue(self.captured)
        leaked = [line for line in self.captured if GATEWAY_KEY in line]
        self.assertEqual(leaked, [], f"明文 Key 进了日志：{leaked}")

    def test_runtime_config_route_also_registers_the_key(self) -> None:
        """``GET /api/settings/runtime``（含明文，只给主进程）这条路径同样要登记。

        它是明文 Key 最集中的一条出参路径，一旦被记进日志就是最大的一处泄漏。
        """
        ConfigFileSettingsStore(self.data_dir).save(
            StoredSettings(llm=StoredLlm(provider_name="自建", api_key=GATEWAY_KEY))
        )
        guard.clear_secrets()

        client = self._client()
        response = client.get("/api/settings/runtime")
        self.assertEqual(response.status_code, 200)
        self.assertIn(GATEWAY_KEY, response.text, "该接口本就该回明文（供 Pi 用）")

        logging.getLogger("app.routes.settings").warning("运行时配置诊断 key=%s", GATEWAY_KEY)
        self.assertTrue(self.captured)
        leaked = [line for line in self.captured if GATEWAY_KEY in line]
        self.assertEqual(leaked, [], f"明文 Key 进了日志：{leaked}")


# --------------------------------------------------------------------------- #
# 路由：读回一致 / 掩码语义 / 存储接线
# --------------------------------------------------------------------------- #
class TestSettingsRouteStorage(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        self.client = authed_client(app_with_data_dir(self.data_dir))

    def _path(self) -> Path:
        return config_path(self.data_dir)

    def test_put_then_get_returns_mask_and_persists(self) -> None:
        response = self.client.put(
            "/api/settings",
            json={
                "llm": {
                    "providerName": "DeepSeek",
                    "baseUrl": "https://api.deepseek.com/v1",
                    "apiKey": SECRET_KEY,
                    "modelId": "deepseek-chat",
                }
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn(SECRET_KEY, response.text)
        self.assertEqual(response.json()["llm"]["apiKey"], MASK)
        self.assertTrue(response.json()["llm"]["hasKey"])

        # ★ 关掉重开（新 app 实例 = 新进程）后读回仍与磁盘一致
        restarted = authed_client(app_with_data_dir(self.data_dir))
        read_back = restarted.get("/api/settings")
        self.assertEqual(read_back.status_code, 200, read_back.text)
        self.assertEqual(read_back.json()["llm"]["apiKey"], MASK)
        self.assertTrue(read_back.json()["llm"]["hasKey"])
        self.assertEqual(read_back.json()["llm"]["modelId"], "deepseek-chat")
        self.assertIn(SECRET_KEY, self._path().read_text(encoding="utf-8"), "明文只许留在本地文件里")

    def test_blank_and_masked_submissions_do_not_erase_the_key(self) -> None:
        """★ 设置页的自然写法（把读回来的掩码原样提交）不能把真 Key 抹掉。"""
        self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})
        read_back = self.client.get("/api/settings").json()["llm"]

        for payload in ({"llm": read_back}, {"llm": {"apiKey": ""}}, {"llm": {"apiKey": ""}},
                        {"llm": {"apiKey": "••••••"}}, {"llm": {"apiKey": "", "hasKey": False}}):
            with self.subTest(payload=payload):
                response = self.client.put("/api/settings", json=payload)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["llm"]["hasKey"], "掩码/空串被当成新 Key 写回了")

        settings = self._path()
        self.assertIn(SECRET_KEY, settings.read_text(encoding="utf-8"))

        cleared = self.client.put("/api/settings", json={"llm": {"apiKey": "", "clearApiKey": True}})
        self.assertFalse(cleared.json()["llm"]["hasKey"], "只有显式 clearApiKey 才允许删除")
        self.assertNotIn(SECRET_KEY, self._path().read_text(encoding="utf-8"))

    def test_embedding_mode_round_trip(self) -> None:
        saved = self.client.put(
            "/api/settings",
            json={"embedding": {"mode": "cloud_api", "baseUrl": "https://embed.example.com/v1",
                                "apiKey": "emb-key-123456", "modelId": "bge-m3"}},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertTrue(saved.json()["embedding"]["hasKey"])
        self.assertNotIn("emb-key-123456", saved.text)

        again = authed_client(app_with_data_dir(self.data_dir)).get("/api/settings").json()
        self.assertEqual(again["embedding"]["mode"], "cloud_api")
        self.assertEqual(again["embedding"]["baseUrl"], "https://embed.example.com/v1")
        self.assertEqual(again["embedding"]["modelId"], "bge-m3")
        self.assertEqual(again["embedding"]["apiKey"], "…3456")

    def test_corrupt_file_does_not_break_the_settings_page(self) -> None:
        self._path().write_text("{ 半截", encoding="utf-8")

        response = self.client.get("/api/settings")

        self.assertEqual(response.status_code, 200, "配置坏了也要能打开设置页（回退默认值）")
        self.assertFalse(response.json()["llm"]["hasKey"])
        self.assertEqual(response.json()["llm"]["baseUrl"], DEFAULT_LLM_BASE_URL)
        self.assertEqual(response.json()["llm"]["providerId"], DEFAULT_LLM_PROVIDER_ID)

    def test_write_failure_surfaces_as_readable_5xx(self) -> None:
        store = ConfigFileSettingsStore(self.data_dir / "blocked")
        (self.data_dir / "blocked").write_text("文件挡路", encoding="utf-8")
        setattr(self.client.app.state, SETTINGS_STORE_ATTR, store)

        response = self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})

        self.assertEqual(response.status_code, 500, response.text)
        detail = response.json()["detail"]
        self.assertIn("配置未保存", detail)
        self.assertNotIn(SECRET_KEY, detail)

    def test_store_choice_depends_on_explicit_data_dir(self) -> None:
        """显式 ``--data-dir`` → 落盘；开发默认目录（单测/curl 调试）→ 内存，且不写仓库。"""
        explicit = authed_client(app_with_data_dir(self.data_dir))
        explicit.get("/api/settings")
        self.assertIsInstance(getattr(explicit.app.state, SETTINGS_STORE_ATTR), ConfigFileSettingsStore)

        implicit = authed_client(create_app(build_runtime_config(token=TOKEN)))
        implicit.get("/api/settings")
        self.assertIsInstance(getattr(implicit.app.state, SETTINGS_STORE_ATTR), InMemorySettingsStore)

    def test_injected_store_wins(self) -> None:
        injected = InMemorySettingsStore(StoredSettings(llm=StoredLlm(provider_name="注入的")))
        setattr(self.client.app.state, SETTINGS_STORE_ATTR, injected)

        self.assertEqual(self.client.get("/api/settings").json()["llm"]["providerName"], "注入的")
        self.assertFalse(self._path().exists(), "注入存储时不该顺手写盘")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    unittest.main()
