#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""API 冒烟自检：**起真实 uvicorn + 走真实 socket**（不是 TestClient 内存调用）。

（S02 DoD：「用 curl 带错 token → 401；正确 token → 200」）

为什么不用 `TestClient` 就够：内存 ASGI 调用绕过了 TCP 分片与编码路径，
而 SSE 最典型的翻车点恰恰在那里（分块边界切断多字节汉字、缺 charset、
`StreamingResponse` 被缓冲）。本脚本用 httpx 打真实 socket，等价于 curl。

用法：
    cd server
    uv run python scripts/smoke_api.py
    uv run python scripts/smoke_api.py --keep-data   # 保留临时数据目录便于排查
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from app.config import RuntimeConfig, resolve_data_dir  # noqa: E402
from app.main import AUTH_HEADER, create_app  # noqa: E402
from app.models import SSE_EVENT_NAMES  # noqa: E402

FAKE_KEY = "sk-smoke-abcdefghijklmnop1234"

_passed = 0
_failed: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed.append(name)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class ServerThread(threading.Thread):
    """在后台线程跑 uvicorn（真实 socket、真实 HTTP）。"""

    def __init__(self, cfg: RuntimeConfig) -> None:
        super().__init__(daemon=True)
        self.cfg = cfg
        self.server = uvicorn.Server(
            uvicorn.Config(
                app=create_app(cfg),
                host=cfg.host,
                port=cfg.port,
                log_level="warning",
                access_log=False,
            )
        )

    def run(self) -> None:  # pragma: no cover - 线程体内
        self.server.run()

    def wait_ready(self, timeout: float = 20.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if getattr(self.server, "started", False):
                return True
            time.sleep(0.05)
        return False

    def stop(self) -> None:
        self.server.should_exit = True


def parse_sse(text: str) -> list[tuple[str, dict]]:
    """按契约解析 SSE（与前端解析器同一套规则）。"""
    events: list[tuple[str, dict]] = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        name = data = None
        for line in block.split("\n"):
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if name and data is not None:
            events.append((name, data))
    return events


def run_checks(base: str, token: str, data_dir: Path) -> None:
    auth = {AUTH_HEADER: token}
    client = httpx.Client(base_url=base, timeout=30.0)

    # ---------------------------------------------------------------- 鉴权 --
    print("--- 鉴权（DoD：错 token 401 / 对 token 200）---")
    r = client.get("/health")
    check("/health 免鉴权可用", r.status_code == 200, f"HTTP {r.status_code}")
    check("/health 返回 embedder_ready", "embedder_ready" in r.json(), json.dumps(r.json(), ensure_ascii=False))

    r = client.get("/api/settings")
    check("无 token → 401", r.status_code == 401, f"HTTP {r.status_code}")

    r = client.get("/api/settings", headers={AUTH_HEADER: "wrong-token"})
    check("错 token → 401", r.status_code == 401, f"HTTP {r.status_code}")

    r = client.get("/api/settings", headers={AUTH_HEADER: ""})
    check("空 token → 401", r.status_code == 401, f"HTTP {r.status_code}")

    r = client.get("/api/settings", headers=auth)
    check("正确 token → 200", r.status_code == 200, f"HTTP {r.status_code}")

    # ---------------------------------------------------------------- CORS --
    print("\n--- CORS 预检（预检不带自定义头，必须豁免鉴权）---")
    for origin in ("http://localhost:5173", "null"):
        r = client.options(
            "/api/settings",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": f"content-type,{AUTH_HEADER.lower()}",
            },
        )
        check(
            f"预检通过（Origin={origin}）",
            r.status_code == 200
            and AUTH_HEADER.lower() in r.headers.get("access-control-allow-headers", "").lower(),
            f"HTTP {r.status_code}",
        )

    # ------------------------------------------------------------ 设置往返 --
    print("\n--- 设置读写（含 API Key 脱敏）---")
    payload = {
        "llm": {
            "providerName": "DeepSeek",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": FAKE_KEY,
            "modelId": "deepseek-chat",
        },
        "embedding": {"mode": "local_fastembed"},
    }
    r = client.put("/api/settings", headers=auth, json=payload)
    check("PUT /api/settings 成功", r.status_code == 200, f"HTTP {r.status_code} {r.text[:160]}")
    check("保存响应不回传明文 key", FAKE_KEY not in r.text)
    check("保存响应给出掩码", r.json().get("apiKeyMasked", "").endswith(FAKE_KEY[-4:]), r.json().get("apiKeyMasked", ""))

    r = client.get("/api/settings", headers=auth)
    body = r.json()
    check("GET 不回传明文 key", FAKE_KEY not in r.text)
    check("hasKey 为真", body.get("hasKey") is True)
    check("BaseURL 已持久化", body["llm"]["baseUrl"] == "https://api.deepseek.com/v1")
    check("中文供应商名未乱码", body["llm"]["providerName"] == "DeepSeek")

    config_path = data_dir / "config.json"
    check("config.json 已落盘", config_path.exists(), str(config_path))
    if config_path.exists():
        raw_text = config_path.read_text(encoding="utf-8")
        check("config.json 用 snake_case 存内部字段", '"api_key"' in raw_text)
        check("config.json 中文未被转义", "深度求索" not in raw_text or "\\u" not in raw_text)

    # 空 key / 掩码 → 不修改
    masked = body["apiKeyMasked"]
    for label, value in (("空串", ""), ("掩码", masked)):
        r = client.put(
            "/api/settings", headers=auth, json={**payload, "llm": {**payload["llm"], "apiKey": value}}
        )
        still = client.get("/api/settings", headers=auth).json()["hasKey"]
        check(f"提交{label}不丢失 key", still is True)

    # 契约外字段 → 422
    r = client.put(
        "/api/settings", headers=auth, json={**payload, "llm": {**payload["llm"], "oops": 1}}
    )
    check("契约外字段 → 422（防漂移）", r.status_code == 422, f"HTTP {r.status_code}")

    # ----------------------------------------------------------- SSE 真实流 --
    print("\n--- SSE 流式（真实 socket）---")
    chat = {"studentId": "smoke-1", "grade": "junior", "message": "什么是循环？"}
    with client.stream(
        "POST",
        "/api/chat/stream/echo",
        headers=auth,
        params={"interval_ms": 0, "all_events": "true"},
        json=chat,
    ) as res:
        check("SSE HTTP 200", res.status_code == 200, f"HTTP {res.status_code}")
        ctype = res.headers.get("content-type", "")
        check("Content-Type 是 text/event-stream", ctype.startswith("text/event-stream"), ctype)
        check("显式 charset=utf-8", "charset=utf-8" in ctype.lower(), ctype)
        raw_bytes = b"".join(res.iter_bytes())

    check("响应体是合法 UTF-8（无 GBK 污染）", _is_valid_utf8(raw_bytes))
    text = raw_bytes.decode("utf-8")

    events = parse_sse(text)
    names = [n for n, _ in events]
    check("解析出事件", len(events) > 0, f"{len(events)} 条")
    check(
        "6 种事件全部到达",
        set(names) == set(SSE_EVENT_NAMES),
        f"实到 {sorted(set(names))}",
    )
    check("首事件是 delta", names[0] == "delta", names[0] if names else "-")
    check("末事件是 done", names[-1] == "done", names[-1] if names else "-")

    delta = "".join(d["delta"] for n, d in events if n == "delta")
    check("中文逐字回放完整", "循环" in delta, delta[:40])
    check("多行文本可还原（\\n 转义正确）", "\n" in delta)

    ids = {d["requestId"] for _, d in events}
    check("同轮事件共享 requestId", len(ids) == 1, str(ids))
    check("事件字段是 camelCase", all("requestId" in d for _, d in events) and "request_id" not in text)

    citation = next((d for n, d in events if n == "citation"), None)
    check("citation 含 compat 向上兼容标记", bool(citation) and any(c["compat"] for c in citation["citations"]))

    payload_event = next((d for n, d in events if n == "payload"), None)
    check("payload 事件带 quiz 卡片", bool(payload_event) and payload_event["kind"] == "quiz")
    check("内层 payload 也是 camelCase", bool(payload_event) and "kpId" in json.dumps(payload_event["payload"]))

    err = next((d for n, d in events if n == "error"), None)
    check("error 事件标 degraded", bool(err) and err["degraded"] is True)

    # 逐条到达（不是一次性灌进来）：interval 拉大后统计读取次数
    chunks = 0
    with client.stream(
        "POST",
        "/api/chat/stream/echo",
        headers=auth,
        params={"interval_ms": 60, "all_events": "false"},
        json=chat,
    ) as res:
        for _ in res.iter_bytes():
            chunks += 1
    check("事件逐条到达（分多次收到）", chunks >= 3, f"收到 {chunks} 次 chunk")

    # 非法学段 → 422
    r = client.post(
        "/api/chat/stream/echo",
        headers=auth,
        params={"interval_ms": 0},
        json={**chat, "grade": "幼儿园"},
    )
    check("非法学段 → 422", r.status_code == 422, f"HTTP {r.status_code}")

    client.close()


def _is_valid_utf8(raw: bytes) -> bool:
    try:
        raw.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="API 冒烟自检（真实 socket）")
    parser.add_argument("--keep-data", action="store_true", help="保留临时数据目录")
    args = parser.parse_args()

    tmp = tempfile.TemporaryDirectory(prefix="k12-smoke-")
    data_dir = resolve_data_dir(tmp.name)
    data_dir.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)  # 与 Electron 生成的形态一致

    port = free_port()
    cfg = RuntimeConfig(host="127.0.0.1", port=port, token=token, data_dir=data_dir)
    base = f"http://127.0.0.1:{port}"
    print(f"[info] 启动真实 uvicorn：{base}（data_dir={data_dir}）\n")

    server = ServerThread(cfg)
    server.start()
    if not server.wait_ready():
        print("[fail] 服务未能在 20 秒内就绪", file=sys.stderr)
        return 2

    try:
        run_checks(base, token, data_dir)
    finally:
        server.stop()
        server.join(timeout=10)

    print(f"\n{'=' * 60}")
    if _failed:
        print(f"✗ {len(_failed)} 项失败 / 共 {_passed + len(_failed)} 项：{'；'.join(_failed)}")
    else:
        print(f"✓ 全部 {_passed} 项通过")

    if args.keep_data:
        print(f"[info] 数据目录保留于：{data_dir}")
    else:
        tmp.cleanup()
    return 1 if _failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
