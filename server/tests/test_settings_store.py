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
from app.main import create_app  # noqa: E402
from app.routes import settings as settings_module  # noqa: E402
from app.routes.settings import (  # noqa: E402
    SETTINGS_STORE_ATTR,
    HttpOutcome,
    InMemorySettingsStore,
    base_url_variant,
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
        self.assertEqual(settings.llm.base_url, "https://api.deepseek.com/v1")
        self.assertTrue(any("llm.base_url" in issue for issue in issues))

        settings, issues = settings_from_json({})
        self.assertEqual(settings, default_settings())
        self.assertEqual(issues, [])

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
        self.assertEqual(response.json()["llm"]["baseUrl"], "https://api.deepseek.com/v1")

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
