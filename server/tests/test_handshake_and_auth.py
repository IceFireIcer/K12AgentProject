# -*- coding: utf-8 -*-
"""票 02 测试：握手协议与 token 鉴权。

这些断言对应关卡 A 的判据，后续票改动时一旦破坏必须立刻失败。
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import socket
import unittest

from fastapi.testclient import TestClient

from app.config import build_runtime_config
from app.main import bind_listening_socket, create_app, emit_handshake, main
from app.security import AUTH_HEADER, TokenAuthMiddleware

TOKEN = "a" * 64  # 与 Electron 侧 randomBytes(32).toString('hex') 同形


def _client(*, token: str = "") -> TestClient:
    return TestClient(create_app(build_runtime_config(token=token)))


class TestTokenAuth(unittest.TestCase):
    """★ 鉴权行为。

    现在还没有真正的 `/api/*` 路由，所以用「**401 先于 404**」来证明中间件真的在拦：
    未带 token 时请求 `/api/whatever` 得到 401（被中间件拦下），
    带上正确 token 才落到路由层得到 404。这个差异本身就是证据。
    """

    def test_missing_token_is_rejected_before_routing(self) -> None:
        response = _client(token=TOKEN).get("/api/whatever")
        self.assertEqual(response.status_code, 401)
        self.assertIn("X-Auth-Token", response.json()["detail"])

    def test_wrong_token_is_rejected(self) -> None:
        response = _client(token=TOKEN).get("/api/whatever", headers={AUTH_HEADER: "b" * 64})
        self.assertEqual(response.status_code, 401)

    def test_empty_token_header_is_rejected(self) -> None:
        response = _client(token=TOKEN).get("/api/whatever", headers={AUTH_HEADER: ""})
        self.assertEqual(response.status_code, 401)

    def test_correct_token_reaches_the_router(self) -> None:
        """带对 token 时应当**穿过**中间件（此刻路由尚未实现 → 404）。"""
        response = _client(token=TOKEN).get("/api/whatever", headers={AUTH_HEADER: TOKEN})
        self.assertEqual(response.status_code, 404)

    def test_health_is_anonymous(self) -> None:
        """探活必须免鉴权 —— 启动期 Electron 还没有任何可用的凭据。"""
        response = _client(token=TOKEN).get("/health")
        self.assertEqual(response.status_code, 200)

    def test_options_preflight_is_not_blocked(self) -> None:
        """预检**不带**自定义头，拦掉它就等于拦掉一切跨源请求。"""
        response = _client(token=TOKEN).options(
            "/api/whatever",
            headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
        )
        self.assertNotEqual(response.status_code, 401)

    def test_401_still_carries_cors_headers(self) -> None:
        """★ 中间件顺序的回归防护：CORS 必须在最外层，否则 401 不带 CORS 头，
        浏览器会把 401 伪装成 `TypeError: Failed to fetch`。"""
        response = _client(token=TOKEN).get("/api/whatever", headers={"Origin": "null"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers.get("access-control-allow-origin"), "null")

    def test_non_ascii_token_does_not_crash_middleware(self) -> None:
        """请求头内容由调用方控制；比较必须走**字节**，否则 `compare_digest` 抛 TypeError。

        走 httpx 发不出非 ASCII 头（客户端自己就拒了），所以直接调中间件 ——
        这样测到的正是「原始字节进来会不会把中间件打崩」。
        """

        async def app_should_not_be_reached(scope, receive, send):  # pragma: no cover
            raise AssertionError("非 ASCII token 不应通过鉴权")

        async def receive():
            return {"type": "http.request", "body": b""}

        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/api/whatever",
            "headers": [(AUTH_HEADER.lower().encode(), "中文-token".encode("utf-8"))],
        }
        asyncio.run(
            TokenAuthMiddleware(app_should_not_be_reached, token=TOKEN)(scope, receive, send)
        )

        status = next(m["status"] for m in sent if m["type"] == "http.response.start")
        self.assertEqual(status, 401)

    def test_no_token_configured_disables_auth(self) -> None:
        """未配置 token（手动 `uv run uvicorn ...` 调试）时不拦 —— 生产路径必然带 token。"""
        response = _client(token="").get("/api/whatever")
        self.assertEqual(response.status_code, 404)


class TestHandshakeEmission(unittest.TestCase):
    def test_ready_line_is_single_line_json(self) -> None:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            emit_handshake({"event": "ready", "port": 54321, "pid": 12345})

        output = buffer.getvalue()
        self.assertEqual(output.count("\n"), 1, "握手必须是恰好一行")
        self.assertTrue(output.endswith("\n"))
        self.assertEqual(
            json.loads(output),
            {"event": "ready", "port": 54321, "pid": 12345},
        )

    def test_chinese_message_is_not_escaped(self) -> None:
        """错误信息要人可读 —— 不能被 \\uXXXX 转义淹没。"""
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            emit_handshake({"event": "error", "message": "端口被占用"})
        self.assertIn("端口被占用", buffer.getvalue())


class TestSocketBinding(unittest.TestCase):
    def test_port_zero_yields_a_real_port(self) -> None:
        sock = bind_listening_socket("127.0.0.1", 0)
        try:
            port = sock.getsockname()[1]
            self.assertIsInstance(port, int)
            self.assertGreater(port, 0)
            self.assertLessEqual(port, 65535)
        finally:
            sock.close()

    def test_occupied_port_raises_and_releases_socket(self) -> None:
        """端口被占用时必须抛 OSError（由 main 转成一行 error 握手）。"""
        holder = bind_listening_socket("127.0.0.1", 0)
        port = holder.getsockname()[1]
        try:
            with self.assertRaises(OSError):
                bind_listening_socket("127.0.0.1", port)
        finally:
            holder.close()


class TestStartupFailureReportsThroughHandshake(unittest.TestCase):
    """★ 绑定失败必须走**握手通道**报错。

    否则 Electron 只看到「进程意外退出」，说不清是端口占用还是别的 —— 这正是
    票 01 实测撞到的场景（孤儿进程占着 8756，界面只能显示 code=3）。
    """

    def test_bind_failure_emits_error_line_and_exit_code_2(self) -> None:
        holder = bind_listening_socket("127.0.0.1", 0)
        port = holder.getsockname()[1]
        buffer = io.StringIO()
        try:
            with contextlib.redirect_stdout(buffer):
                code = main(
                    ["--host", "127.0.0.1", "--port", str(port), "--log-level", "critical"]
                )
        finally:
            holder.close()

        self.assertEqual(code, 2, "绑定失败必须返回非零退出码")
        payload = json.loads(buffer.getvalue().strip())
        self.assertEqual(payload["event"], "error")
        self.assertIn("无法绑定", payload["message"])

    def test_non_loopback_host_refuses_to_start(self) -> None:
        with self.assertRaises(SystemExit):
            main(["--host", "0.0.0.0", "--port", "0"])


class TestStdoutStaysClean(unittest.TestCase):
    def test_importing_the_app_writes_nothing_to_stdout(self) -> None:
        """导入期绝不允许有 stdout 输出 —— 否则握手行前面会多一行。"""
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            create_app(build_runtime_config())
        self.assertEqual(buffer.getvalue(), "")

    def test_socket_is_af_inet_tcp(self) -> None:
        sock = bind_listening_socket("127.0.0.1", 0)
        try:
            self.assertEqual(sock.family, socket.AF_INET)
            self.assertEqual(sock.type, socket.SOCK_STREAM)
        finally:
            sock.close()


if __name__ == "__main__":
    unittest.main()
