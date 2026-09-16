# -*- coding: utf-8 -*-
"""票 01 基线测试：验证脚手架里**已经有行为**的那几件事。

不放业务测试（那些属于各自的功能票），只钉住三件容易在后续票里被悄悄改坏的事：

1. `/health` 的出参是 **camelCase**（前端 `HealthPayload` 依赖它，改回 snake_case 会静默失效）；
2. 契约基类 `CamelModel` 真的**拒绝契约外字段**（防漂移的硬闸门）；
3. 6 事件词表**冻结**；
4. 非回环地址**拒绝启动**（sidecar 只能绑回环）。
"""

from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from app.config import EMBEDDING_DIM, build_runtime_config
from app.contracts import IPC_EVENT_NAMES, CamelModel, HealthResponse
from app.main import create_app


class TestHealthEndpoint(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app(build_runtime_config()))

    def test_health_returns_camel_case_keys(self) -> None:
        """★ 必须是 camelCase。前端按 `embedderReady` 读，snake_case 会让探活静默失效。"""
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)

        body = response.json()
        self.assertEqual(set(body), {"status", "version", "embedderReady"})
        self.assertNotIn("embedder_ready", body)
        self.assertEqual(body["status"], "ok")
        self.assertIsInstance(body["embedderReady"], bool)

    def test_health_is_anonymous(self) -> None:
        """`/health` 是探活入口，**不能要求 token**（票 02 加鉴权后这条要仍然成立）。"""
        self.assertEqual(self.client.get("/health").status_code, 200)


class TestContractBase(unittest.TestCase):
    def test_extra_field_is_rejected(self) -> None:
        """契约外字段必须直接报错 —— 这是防「临时加个松散字段」的闸门。"""
        with self.assertRaises(Exception):
            HealthResponse(status="ok", version="0", embedder_ready=False, oops=1)  # type: ignore[call-arg]

    def test_snake_case_in_camel_case_out(self) -> None:
        model = HealthResponse(status="ok", version="0.1.0", embedder_ready=True)
        self.assertEqual(
            model.model_dump(by_alias=True),
            {"status": "ok", "version": "0.1.0", "embedderReady": True},
        )

    def test_event_vocabulary_is_frozen(self) -> None:
        """6 事件词表冻结；与 `desktop/src/shared/ipc-events.ts` 必须一字不差。"""
        self.assertEqual(
            IPC_EVENT_NAMES,
            ("delta", "citation", "payload", "blocked", "done", "error"),
        )
        self.assertEqual(len(IPC_EVENT_NAMES), 6)


class TestRuntimeConfig(unittest.TestCase):
    def test_rejects_non_loopback_host(self) -> None:
        """sidecar 只许绑回环：绑到 0.0.0.0 等于把学生数据暴露给局域网。"""
        with self.assertRaises(SystemExit):
            build_runtime_config(host="0.0.0.0")

    def test_accepts_loopback(self) -> None:
        for host in ("127.0.0.1", "::1", "localhost"):
            self.assertEqual(build_runtime_config(host=host).host, host)

    def test_embedding_dim_is_contract(self) -> None:
        """512 维是嵌入模型契约（换模型必须同步改 vec0 维度并重建索引）。"""
        self.assertEqual(EMBEDDING_DIM, 512)


if __name__ == "__main__":
    unittest.main()
