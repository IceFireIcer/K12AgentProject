#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一键冒烟：**不启动 Electron**，直接验证 sidecar 全链路。

覆盖「起进程 → 读握手 → 打接口 → 杀进程」四步，用来回答一个问题：
**今天改的东西有没有把关卡 A 的判据弄坏？**

用法::

    cd server
    uv run python scripts/smoke_api.py

退出码 0 = 全过；1 = 有断言失败；2 = 脚本自身异常。

设计要点
--------
- 断言函数与进程管理**分开**，`build_server.py`（验证打包产物）复用同一套断言，
  避免两处各写一份、日后只改一边。
- 除了「握手能解析」，还会断言 **stdout 恰好一行**：握手通道是保留通道，
  多一行就说明有库在往 stdout 打日志，早晚会污染解析。
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 被 spawn 的进程不继承我们的 PYTHONUTF8 —— 显式传，模拟 Electron 的做法
CHILD_ENV = {
    **os.environ,
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
    "PYTHONUNBUFFERED": "1",
}

STARTUP_TIMEOUT_S = 30.0
# 握手后静默观察窗口：用来断言「stdout 没有第二行」
QUIET_WINDOW_S = 1.5

_failed: list[str] = []
_passed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed.append(name)


# ---------------------------------------------------------------------------
# 进程与握手
# ---------------------------------------------------------------------------


class StdoutCollector:
    """后台抽干 stdout 并逐行记录。

    必须持续抽干：管道写满会让子进程阻塞在 write 上，表现为「启动卡死」。
    """

    def __init__(self, stream) -> None:
        self._stream = stream
        self.lines: list[str] = []
        self._thread = threading.Thread(target=self._drain, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _drain(self) -> None:
        try:
            for raw in iter(self._stream.readline, b""):
                self.lines.append(raw.decode("utf-8", errors="replace").rstrip("\r\n"))
        except (ValueError, OSError):
            pass

    def join(self, timeout: float = 3.0) -> None:
        self._thread.join(timeout=timeout)


def wait_for_handshake(collector: StdoutCollector, proc: subprocess.Popen, timeout: float) -> dict | None:
    """等一行可解析的握手 JSON。非 JSON 行忽略（但会被断言检查）。"""
    deadline = time.monotonic() + timeout
    seen = 0
    while time.monotonic() < deadline:
        while seen < len(collector.lines):
            line = collector.lines[seen]
            seen += 1
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue  # 非 JSON 行：交给「stdout 恰好一行」的断言去评判
            if isinstance(payload, dict) and payload.get("event") in ("ready", "error"):
                return payload
        if proc.poll() is not None:
            return None
        time.sleep(0.05)
    return None


def _run_capturing_bytes(cmd: list[str]) -> str:
    """跑一条系统命令并把输出解成文本。

    ⚠️ **不要用 `text=True`**：Windows 自带工具（netstat / taskkill）按**系统代码页**输出
    （本机是 GBK），而这个进程处于 UTF-8 模式（`PYTHONUTF8=1`），
    `text=True` 会去按 UTF-8 解码 → 解码线程抛 `UnicodeDecodeError` 死掉 →
    **`stdout` 变成空字符串而不是抛异常**。症状是「命令看起来跑成功了，但解析不出来任何东西」，
    极难排查。这里显式按字节收、再用 `errors="replace"` 解：
    非 ASCII 字节变成替换符，但我们要解析的 ASCII 字段（端口、pid、状态）**位置不受影响**。
    """
    result = subprocess.run(cmd, capture_output=True, check=False)
    return result.stdout.decode("utf-8", errors="replace")


def kill_tree(pid: int) -> None:
    """杀掉整棵进程树。

    ★ 必须 `/T`：dev 态 Electron spawn 的是 `uv`，真正占端口的是它的 python 孙进程；
    只杀 `uv` 会留下孤儿继续占端口（票 01 实测撞到过）。
    """
    if sys.platform == "win32":
        _run_capturing_bytes(["taskkill", "/PID", str(pid), "/T", "/F"])
    else:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(os.getpgid(pid), 9)


def port_is_listening(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def pid_owning_port(port: int) -> int | None:
    """查出**真正监听**该端口的 pid。

    ★ 这不是多余的校验：本机实测发现 spawn 出来的 pid 与进程自报的 `os.getpid()`
    **根本不是同一个** —— dev 态 Electron spawn 的是 `uv`（包装器），
    而 venv 的 `python.exe` 本身又是个 redirector（实测 Popen 报 37432、进程自报 39792）。
    所以「该杀哪个 pid」只能以**握手自报的 pid** 为准，而这条断言就是它的证据。
    """
    if sys.platform != "win32":
        return None  # 非 Windows 不做这项校验（本项目的交付形态是 Windows .exe）

    for line in _run_capturing_bytes(["netstat", "-ano", "-p", "TCP"]).splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].endswith(f":{port}") and parts[3].upper() == "LISTENING":
            try:
                return int(parts[4])
            except (IndexError, ValueError):
                return None
    return None


# ---------------------------------------------------------------------------
# 断言集（build_server.py 复用）
# ---------------------------------------------------------------------------


def run_api_checks(base: str, token: str, *, timeout: float = 10.0) -> None:
    """对已就绪的 sidecar 打接口。**不负责起停进程**。"""
    import httpx

    with httpx.Client(base_url=base, timeout=timeout) as client:
        print("--- 探活与握手 ---")
        response = client.get("/health")
        check("/health 返回 200", response.status_code == 200, f"HTTP {response.status_code}")
        body = response.json()
        check(
            "/health 出参为 camelCase（embedderReady）",
            "embedderReady" in body and "embedder_ready" not in body,
            json.dumps(body, ensure_ascii=False),
        )
        check("/health 免鉴权（未带 token 也 200）", response.status_code == 200)

        print("--- token 鉴权 ---")
        # 现在还没有真正的 /api/* 路由，所以用「401 先于 404」作为中间件生效的证据
        response = client.get("/api/__probe__")
        check("无 token → 401", response.status_code == 401, f"HTTP {response.status_code}")

        response = client.get("/api/__probe__", headers={"X-Auth-Token": "wrong"})
        check("错 token → 401", response.status_code == 401, f"HTTP {response.status_code}")

        response = client.get("/api/__probe__", headers={"X-Auth-Token": token})
        check(
            "对 token → 穿过中间件（此刻路由未实现故 404）",
            response.status_code == 404,
            f"HTTP {response.status_code}",
        )

        print("--- 中文编码 ---")
        # /health 是匿名端点，用它验证响应体本身是合法 UTF-8 且未被转义
        raw = client.get("/health").content
        try:
            raw.decode("utf-8")
            check("响应体是合法 UTF-8", True)
        except UnicodeDecodeError as exc:
            check("响应体是合法 UTF-8", False, str(exc))


# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="sidecar 全链路冒烟（源码态）")
    parser.add_argument("--keep-data", action="store_true", help="保留临时数据目录便于排查")
    args = parser.parse_args()

    token = secrets.token_hex(32)
    data_dir = ROOT / "_data_smoke"
    shutil.rmtree(data_dir, ignore_errors=True)

    cmd = [
        sys.executable,
        "-m",
        "app.main",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--token",
        token,
        "--data-dir",
        str(data_dir),
        "--log-level",
        "warning",
    ]
    print(f"[info] 启动：{' '.join(cmd)}\n")

    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        env=CHILD_ENV,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdout is not None and proc.stderr is not None

    collector = StdoutCollector(proc.stdout)
    collector.start()
    stderr_chunks: list[bytes] = []

    def drain_stderr() -> None:
        try:
            # read1：一有数据就返回。read(n) 会等读满 n 字节或 EOF，
            # 对长期运行的服务进程等于永不返回，抽干线程就形同虚设。
            while True:
                chunk = proc.stderr.read1(4096)  # type: ignore[union-attr]
                if not chunk:
                    break
                stderr_chunks.append(chunk)
        except (ValueError, OSError):
            pass

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    port: int | None = None
    try:
        started = time.monotonic()
        handshake = wait_for_handshake(collector, proc, STARTUP_TIMEOUT_S)
        elapsed = time.monotonic() - started

        print("--- 握手 ---")
        if handshake is None:
            check("收到握手 JSON", False, f"{STARTUP_TIMEOUT_S:.0f}s 内未收到")
            print("  stdout 内容：")
            for line in collector.lines:
                print(f"    {line}")
            print("  stderr 尾部：")
            print("    " + b"".join(stderr_chunks).decode("utf-8", "replace")[-500:])
            return 1

        check("收到握手 JSON", True, f"{elapsed:.2f}s")
        check(
            "握手 event == ready",
            handshake.get("event") == "ready",
            json.dumps(handshake, ensure_ascii=False),
        )
        check("握手带 port", isinstance(handshake.get("port"), int), str(handshake.get("port")))
        check("握手带 pid（★ Electron 用它杀进程树，不是包装器的 pid）",
              isinstance(handshake.get("pid"), int) and handshake["pid"] > 0,
              str(handshake.get("pid")))

        port = int(handshake["port"])
        check("端口在有效区间", 1 <= port <= 65535, str(port))

        # 静默窗口：握手之后 stdout 不许再有任何一行
        time.sleep(QUIET_WINDOW_S)
        check(
            "★ stdout 恰好一行（保留通道未被污染）",
            len(collector.lines) == 1,
            f"实际 {len(collector.lines)} 行：{collector.lines[1:3]}",
        )

        run_api_checks(f"http://127.0.0.1:{port}", token)

        # ★ 关键断言：握手自报的 pid 必须是**真正占着端口的那个进程**。
        #   spawn 出来的 pid（uv / venv redirector）不是它 —— 拿错就会留下孤儿占住端口。
        #
        #   注意这里必须放在接口探活**之后**：握手是在 uvicorn 开始 accept **之前**发出的
        #   （见 main.py 的设计说明），刚握手时 socket 还没进入 LISTENING 状态，
        #   此刻查 netstat 查不到。Electron 正是靠随后轮询 /health 来渡过这个窗口。
        owner = pid_owning_port(port)
        check(
            "★ 握手 pid == 真正监听端口的进程",
            owner is not None and owner == handshake.get("pid"),
            f"握手 pid={handshake.get('pid')}；占端口的 pid={owner}；Popen 报的 pid={proc.pid}",
        )

        print("--- 退出清理 ---")
        kill_tree(proc.pid)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            check("进程在 10s 内退出", False)
        time.sleep(0.5)
        check("★ 退出后端口已释放（无孤儿）", not port_is_listening(port), f"port={port}")
    finally:
        collector.join()
        stderr_thread.join(timeout=2)
        if proc.poll() is None:
            kill_tree(proc.pid)
        if not args.keep_data:
            shutil.rmtree(data_dir, ignore_errors=True)

    print(f"\n{'=' * 60}")
    if _failed:
        print(f"✗ {len(_failed)} 项失败 / 共 {_passed + len(_failed)} 项：{'；'.join(_failed)}")
        return 1
    print(f"✓ 全部 {_passed} 项通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
