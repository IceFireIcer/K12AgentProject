"""HTTP 端到端自检（鉴权 / 设置往返 / SSE 流）。

（对应 `项目执行文档.md` 6.3 + S02 的 DoD）

用 FastAPI `TestClient` 走真实的 ASGI 栈——包括中间件，所以这里验证的是
「Electron 打过去的请求会怎样」，而不是"函数直接调用返回了什么"。
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

from app.config import RuntimeConfig  # noqa: E402
from app.main import AUTH_HEADER, create_app  # noqa: E402
from app.models import SSE_EVENT_NAMES  # noqa: E402

TOKEN = "t" * 64  # 形态与 electron 生成的 randomBytes(32).toString('hex') 一致
FAKE_KEY = "sk-test-key-abcdefghijklmnop"


class HttpTestCase(unittest.TestCase):
    """公共装置：带 token 的应用 + 独立 data-dir。"""

    token = TOKEN

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        cfg = RuntimeConfig(
            host="127.0.0.1", port=0, token=self.token, data_dir=self.data_dir
        )
        self.client = TestClient(create_app(cfg))
        self.auth = {AUTH_HEADER: self.token}

    def tearDown(self) -> None:
        self.client.close()
        self._tmp.cleanup()


# --------------------------------------------------------------------------- #
# 鉴权
# --------------------------------------------------------------------------- #


class TestAuth(HttpTestCase):
    def test_health_is_public(self) -> None:
        """探活必须免鉴权：Electron 在拿到 token 生效前就要能轮询它。"""
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["status"], "ok")
        self.assertIn("embedder_ready", body)

    def test_api_requires_token(self) -> None:
        self.assertEqual(self.client.get("/api/settings").status_code, 401)

    def test_api_rejects_wrong_token(self) -> None:
        res = self.client.get("/api/settings", headers={AUTH_HEADER: "wrong"})
        self.assertEqual(res.status_code, 401)

    def test_api_accepts_correct_token(self) -> None:
        res = self.client.get("/api/settings", headers=self.auth)
        self.assertEqual(res.status_code, 200)

    def test_empty_token_does_not_match(self) -> None:
        """不缺字段但值为空也必须 401（曾见于"前端忘了带上 token"）。"""
        res = self.client.get("/api/settings", headers={AUTH_HEADER: ""})
        self.assertEqual(res.status_code, 401)

    def test_preflight_options_is_not_blocked(self) -> None:
        """★ CORS 预检不带自定义头，若被鉴权拦掉 → 所有跨源 /api 调用全废。

        渲染进程是 file:// / localhost:5173，sidecar 是 127.0.0.1:<随机端口>，
        所以每个 POST /api/* 之前都会先来一发这个 OPTIONS。
        """
        res = self.client.options(
            "/api/settings",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": f"content-type,{AUTH_HEADER.lower()}",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        allowed = res.headers.get("access-control-allow-headers", "").lower()
        self.assertIn(AUTH_HEADER.lower(), allowed, "必须放行 X-Auth-Token，否则预检失败")
        self.assertEqual(
            res.headers.get("access-control-allow-origin"),
            "http://localhost:5173",
            "预检必须回显请求方 origin，否则浏览器会拒收真实请求",
        )
        self.assertIn("put", res.headers.get("access-control-allow-methods", "").lower())

    def test_401_response_carries_cors_headers(self) -> None:
        """★ 401 也必须带 CORS 头——否则浏览器把它变成 `Failed to fetch`。

        端到端验收时真踩到过：CORS 中间件在内层、鉴权在外层，鉴权提前 return 的
        401 不经过 CORS，前端拿不到 Allow-Origin → 报的是**网络错误**而不是 401，
        使用者永远看不到「鉴权失败」。所以 CORS 必须是最外层中间件。
        """
        for path, method in (("/api/settings", "GET"), ("/api/ping", "GET")):
            kwargs = {"headers": {"Origin": "http://localhost:5173"}}
            res = getattr(self.client, method.lower())(path, **kwargs)
            self.assertEqual(res.status_code, 401, f"{path} 应 401")
            self.assertEqual(
                res.headers.get("access-control-allow-origin"),
                "http://localhost:5173",
                f"{path} 的 401 缺 CORS 头：浏览器会把 401 伪装成网络错误",
            )

    def test_401_cors_headers_for_file_origin(self) -> None:
        """打包后渲染层是 `file://`，Chromium 发出的 Origin 字面量是 `null`。"""
        res = self.client.get("/api/settings", headers={"Origin": "null"})
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.headers.get("access-control-allow-origin"), "null")


class TestAuthDisabled(unittest.TestCase):
    """无 token（本地开发）时不应误拦——否则 `uvicorn app.main:app` 没法裸调试。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        cfg = RuntimeConfig(
            host="127.0.0.1", port=0, token="", data_dir=Path(self._tmp.name)
        )
        self.client = TestClient(create_app(cfg))

    def tearDown(self) -> None:
        self.client.close()
        self._tmp.cleanup()

    def test_no_token_configured_allows_api(self) -> None:
        self.assertEqual(self.client.get("/api/settings").status_code, 200)


# --------------------------------------------------------------------------- #
# 设置
# --------------------------------------------------------------------------- #


class TestSettingsApi(HttpTestCase):
    def _put(self, **llm_over):
        llm = {
            "providerName": "DeepSeek",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": FAKE_KEY,
            "modelId": "deepseek-chat",
        }
        llm.update(llm_over)
        return self.client.put("/api/settings", headers=self.auth, json={"llm": llm})

    def test_get_defaults(self) -> None:
        res = self.client.get("/api/settings", headers=self.auth)
        body = res.json()
        self.assertEqual(body["embedding"]["mode"], "local_fastembed")
        self.assertFalse(body["hasKey"])
        self.assertTrue(body["embeddingModelId"], "应告知前端本地用的嵌入模型")

    def test_put_then_get_roundtrip(self) -> None:
        res = self._put()
        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(res.json()["hasKey"])

        body = self.client.get("/api/settings", headers=self.auth).json()
        self.assertEqual(body["llm"]["baseUrl"], "https://api.deepseek.com/v1")
        self.assertEqual(body["llm"]["modelId"], "deepseek-chat")

    def test_response_never_leaks_plaintext_key(self) -> None:
        self._put()
        for response in (self._put().text, self.client.get("/api/settings", headers=self.auth).text):
            self.assertNotIn(FAKE_KEY, response, "API Key 明文出现在 HTTP 响应里！")

    def test_key_persists_to_disk_and_reloads(self) -> None:
        self._put()
        raw = json.loads((self.data_dir / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["llm"]["api_key"], FAKE_KEY)

        # 模拟"重启应用"：同一 data-dir 重新建 app
        cfg = RuntimeConfig(host="127.0.0.1", port=0, token=TOKEN, data_dir=self.data_dir)
        with TestClient(create_app(cfg)) as fresh:
            body = fresh.get("/api/settings", headers=self.auth).json()
        self.assertEqual(body["llm"]["modelId"], "deepseek-chat")
        self.assertTrue(body["hasKey"], "重启后 key 必须仍在")

    def test_blank_key_does_not_erase_existing(self) -> None:
        """界面回显场景：不动 key 直接点保存，不能把 key 清掉。"""
        self._put()
        self._put(apiKey="")
        body = self.client.get("/api/settings", headers=self.auth).json()
        self.assertTrue(body["hasKey"], "空 key 必须视为「不修改」")

    def test_masked_key_roundtrip_does_not_erase(self) -> None:
        """前端把掩码（…abcd）原样提交回来，也不能覆盖掉真 key。"""
        masked = self._put().json()["apiKeyMasked"]
        self._put(apiKey=masked)
        self.assertTrue(self.client.get("/api/settings", headers=self.auth).json()["hasKey"])

    def test_extra_field_is_rejected(self) -> None:
        res = self._put(surprise="oops")
        self.assertEqual(res.status_code, 422, "契约外字段必须被拒（防漂移）")

    def test_invalid_base_url_is_rejected(self) -> None:
        self.assertEqual(self._put(baseUrl="api.deepseek.com").status_code, 422)

    def test_put_requires_token(self) -> None:
        res = self.client.put("/api/settings", json={"llm": {}})
        self.assertEqual(res.status_code, 401)


# --------------------------------------------------------------------------- #
# SSE
# --------------------------------------------------------------------------- #


class TestSseHttp(HttpTestCase):
    def _post_echo(self, **query):
        params = {"interval_ms": 0, **query}
        return self.client.post(
            "/api/chat/stream/echo",
            headers=self.auth,
            params=params,
            json={"studentId": "s1", "grade": "junior", "message": "什么是循环？"},
        )

    @staticmethod
    def _parse(text: str) -> list[tuple[str, dict]]:
        """按契约解析（与前端解析器同一套规则），顺带当它的"规格说明书"。"""
        events: list[tuple[str, dict]] = []
        for block in text.split("\n\n"):
            if not block.strip():
                continue
            name, data = None, None
            for line in block.split("\n"):
                if line.startswith("event: "):
                    name = line[len("event: "):]
                elif line.startswith("data: "):
                    data = json.loads(line[len("data: "):])
            if name and data is not None:
                events.append((name, data))
        return events

    def test_content_type_has_utf8_charset(self) -> None:
        res = self._post_echo()
        self.assertEqual(res.status_code, 200, res.text)
        ctype = res.headers["content-type"]
        self.assertTrue(ctype.startswith("text/event-stream"), ctype)
        self.assertIn("charset=utf-8", ctype.lower(), "缺 charset 会导致中文按 ISO-8859-1 解")

    def test_requires_token(self) -> None:
        res = self.client.post(
            "/api/chat/stream/echo",
            params={"interval_ms": 0},
            json={"studentId": "s1", "grade": "junior", "message": "hi"},
        )
        self.assertEqual(res.status_code, 401)

    def test_all_six_events_arrive(self) -> None:
        events = self._parse(self._post_echo(all_events=True).text)
        names = [n for n, _ in events]
        self.assertEqual(set(names), set(SSE_EVENT_NAMES), f"实际事件：{names}")
        self.assertEqual(names[0], "delta")
        self.assertEqual(names[-1], "done")

    def test_chinese_survives_roundtrip(self) -> None:
        events = self._parse(self._post_echo().text)
        delta = "".join(d["delta"] for n, d in events if n == "delta")
        self.assertIn("循环", delta)
        self.assertNotIn("\\u5faa", delta, "中文不得被转义成 \\uXXXX")

    def test_request_id_shared_and_camel_case(self) -> None:
        events = self._parse(self._post_echo(all_events=True).text)
        ids = {d["requestId"] for _, d in events}
        self.assertEqual(len(ids), 1)
        for _, d in events:
            self.assertIn("requestId", d)
            self.assertNotIn("request_id", d)

    def test_citation_shape_matches_contract(self) -> None:
        events = self._parse(self._post_echo().text)
        citation = next(d for n, d in events if n == "citation")
        first = citation["citations"][0]
        for key in ("chunkId", "chapterTitle", "sectionTitle", "gradeLevel", "compat"):
            self.assertIn(key, first)
        self.assertTrue(
            any(c["compat"] for c in citation["citations"]),
            "必须有一条 compat=True 的用例，覆盖「向上兼容」标注",
        )

    def test_payload_event_carries_quiz(self) -> None:
        events = self._parse(self._post_echo().text)
        payload = next(d for n, d in events if n == "payload")
        self.assertEqual(payload["kind"], "quiz")
        self.assertIn("questions", payload["payload"])
        self.assertEqual(payload["payload"]["questions"][0]["qid"], "q1")

    def test_error_event_is_degraded(self) -> None:
        events = self._parse(self._post_echo(all_events=True).text)
        err = next(d for n, d in events if n == "error")
        self.assertTrue(err["degraded"], "error 事件必须标 degraded，前端据此显示降级提示")

    def test_invalid_grade_rejected(self) -> None:
        res = self.client.post(
            "/api/chat/stream/echo",
            headers=self.auth,
            params={"interval_ms": 0},
            json={"studentId": "s1", "grade": "幼儿园", "message": "hi"},
        )
        self.assertEqual(res.status_code, 422, "学段是受限枚举，非法值必须拒绝")


if __name__ == "__main__":
    unittest.main(verbosity=2)
