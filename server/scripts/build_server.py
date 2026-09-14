#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包后端 sidecar（PyInstaller `--onedir`），并做打包后自检。

用法：
    cd server
    uv run python scripts/build_server.py            # 打包 + 自检
    uv run python scripts/build_server.py --verify   # 只自检已有产物

产物：`server/dist/k12-agent-server/k12-agent-server.exe`

为什么要脚本包一层：PyInstaller 打成功不代表**跑得起来**。最常见的是
① sqlite_vec 的 .dll 没进去；② fastembed 模型没进去；③ 中文编码在打包后变 GBK。
所以这里打完立刻起一次进程，验证「握手 JSON + /health + 中文不乱码」。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "packaging" / "k12-agent-server.spec"
DIST_DIR = ROOT / "dist" / "k12-agent-server"
EXE = DIST_DIR / "k12-agent-server.exe"

# 打包后的子进程不继承全局 PYTHONUTF8 —— 显式传，模拟 Electron 的 spawn
CHILD_ENV = {
    **os.environ,
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
    "PYTHONUNBUFFERED": "1",
    # 断网复验：证明模型与依赖都已在本地
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
}


def dir_size_mb(path: Path) -> float:
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total / (1024 * 1024)


def kill_stale_sidecar() -> None:
    """重打包前杀掉残留的 sidecar 进程。

    Windows 上只要有进程映射着产物里的 .pyd/.dll，PyInstaller 清目录就会
    `PermissionError: [WinError 5] 拒绝访问`。上一步验证若没退干净，
    下一次打包必然失败——所以在打包前主动清一次，而不是让开发者去猜。
    """
    if sys.platform != "win32":
        return
    result = subprocess.run(
        ["taskkill", "/IM", "k12-agent-server.exe", "/F"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        print("[build] 已清理残留的 k12-agent-server.exe 进程")
        time.sleep(1.0)  # 等 Windows 真正释放文件句柄


def run_build() -> None:
    if not SPEC.exists():
        sys.exit(f"[FATAL] 找不到 spec 文件：{SPEC}")

    kill_stale_sidecar()

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        # 工作目录放到 build/，避免污染仓库
        "--workpath",
        str(ROOT / "build"),
        "--distpath",
        str(ROOT / "dist"),
        str(SPEC),
    ]
    print("[build] " + " ".join(cmd))
    started = time.time()
    proc = subprocess.run(cmd, cwd=ROOT, env=CHILD_ENV, check=False)
    if proc.returncode != 0:
        sys.exit(f"[FATAL] 打包失败，退出码 {proc.returncode}")
    print(f"[build] 完成，耗时 {time.time() - started:.1f}s")


def verify() -> bool:
    """起一次打包产物，验证握手 + /health + **中文编码**。"""
    if not EXE.exists():
        print(f"[FAIL] 产物不存在：{EXE}")
        return False

    print(f"[verify] 启动 {EXE.name} …")
    data_dir = ROOT / "_data_packaged_check"
    shutil.rmtree(data_dir, ignore_errors=True)

    started = time.time()
    # 以二进制管道启动，自己按 UTF-8 解码 —— 这样能拿到**原始字节**，
    # 从而严格判断「打包后是否按 GBK 输出中文」。
    proc = subprocess.Popen(
        [
            str(EXE),
            "--port",
            "0",
            "--token",
            "verifytoken",
            "--data-dir",
            str(data_dir),
        ],
        cwd=str(DIST_DIR),
        env=CHILD_ENV,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # stderr 必须持续抽干：管道写满会让子进程阻塞在 print 上，表现成「启动卡死」
    stderr_chunks: list[bytes] = []

    def drain_stderr() -> None:
        assert proc.stderr is not None
        try:
            # 用 read1：一有数据就返回。read(n) 会一直等到读满 n 字节或 EOF，
            # 对「持续运行的服务进程」等于永远不返回，抽干线程就形同虚设。
            while True:
                chunk = proc.stderr.read1(4096)
                if not chunk:
                    break
                stderr_chunks.append(chunk)
        except (ValueError, OSError):
            pass

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    handshake: dict | None = None
    stdout_lines: list[str] = []
    try:
        assert proc.stdout is not None
        stdout_stream = io.TextIOWrapper(proc.stdout, encoding="utf-8", errors="replace")
        deadline = time.time() + 60
        while time.time() < deadline:
            line = stdout_stream.readline()
            if not line:
                if proc.poll() is not None:
                    break
                continue
            stdout_lines.append(line.rstrip("\n"))
            try:
                parsed = json.loads(line.strip())
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and parsed.get("event") in ("ready", "error"):
                handshake = parsed
                break

        if handshake is None:
            print("[FAIL] 未收到握手 JSON。stdout 内容：")
            for ln in stdout_lines:
                print(f"    {ln}")
            return False

        if handshake.get("event") == "error":
            print(f"[FAIL] 后端报告启动错误：{handshake.get('message')}")
            return False

        port = handshake.get("port")
        print(
            f"[verify] 握手成功 port={port} pid={handshake.get('pid')} "
            f"frozen={handshake.get('frozen')} 冷启动 {time.time() - started:.2f}s"
        )

        if not handshake.get("frozen"):
            print("[FAIL] 产物未以打包模式运行（frozen 应为 true）")
            return False

        ok_http = _verify_http(port)
        # 给抽干线程一点时间把启动日志读完，再做编码判定
        time.sleep(0.3)
        ok_enc = _verify_stderr_encoding(b"".join(stderr_chunks))
        return ok_http and ok_enc
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        stderr_thread.join(timeout=3)
        shutil.rmtree(data_dir, ignore_errors=True)


def _verify_stderr_encoding(raw: bytes) -> bool:
    """★ 回归防护：打包后的 stderr 必须是 UTF-8，不能是 GBK。

    PyInstaller 的 bootloader 会忽略 `PYTHONUTF8` / `PYTHONIOENCODING`，
    所以打包产物默认按系统代码页（本机 GBK）输出中文 —— 日志与握手错误信息会全乱。
    由 `app/encoding.py` 的 `install_utf8_stdio()` 在 Python 层强制修正。
    """
    if not raw:
        print("[SKIP] 未捕获到 stderr，跳过编码校验")
        return True

    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        print(f"[FAIL] stderr 不是合法 UTF-8（打包后按 GBK 输出了中文）：{exc}")
        print(f"       原始字节前 120：{raw[:120]!r}")
        return False

    if "启动中" in decoded:
        print("[verify] stderr 中文编码正确（UTF-8，未被 GBK 污染）✓")
        return True

    # 有非 ASCII 内容却没还原出预期中文 → 疑似乱码，而非日志措辞变化
    if any(b > 0x7F for b in raw):
        print("[FAIL] stderr 含非 ASCII 字节但未见预期中文，疑似乱码")
        print(f"       UTF-8 解码结果前 120：{decoded[:120]!r}")
        return False

    print("[SKIP] stderr 无非 ASCII 内容，跳过编码校验")
    return True


def _verify_http(port: int) -> bool:
    import urllib.error
    import urllib.request

    ok = True

    # /health 免鉴权
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=10) as resp:
            health = json.loads(resp.read().decode("utf-8"))
        print(f"[verify] /health → {json.dumps(health, ensure_ascii=False)}")
        if health.get("status") != "ok":
            print("[FAIL] /health status 不是 ok")
            ok = False
        if not health.get("embedder_ready"):
            print("[FAIL] 打包后找不到嵌入模型（检查 --collect-all fastembed 与 resources 数据文件）")
            ok = False
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] /health 请求失败：{exc}")
        return False

    # /api/* 无 token → 401
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=10)
        print("[FAIL] /api/ping 未带 token 竟然返回 200（鉴权中间件失效）")
        ok = False
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            print("[verify] /api/ping 无 token → 401 ✓")
        else:
            print(f"[FAIL] /api/ping 无 token 返回 {exc.code}，期望 401")
            ok = False
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] /api/ping 请求异常：{exc}")
        ok = False

    # /api/* 带 token → 200，并检查中文未乱码
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/meta",
        headers={"X-Auth-Token": "verifytoken"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            meta = json.loads(resp.read().decode("utf-8"))
        print(f"[verify] /api/meta → {json.dumps(meta, ensure_ascii=False)}")
        if meta.get("appName") != "K12 AI 教学助手":
            print(f"[FAIL] 中文乱码或字段不符：{meta.get('appName')!r}")
            ok = False
        else:
            print("[verify] 中文输出正常（UTF-8 未被 GBK 污染）✓")
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] /api/meta 请求失败：{exc}")
        ok = False

    return ok


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true", help="跳过打包，只自检已有产物")
    parser.add_argument("--skip-verify", action="store_true", help="只打包，不自检")
    args = parser.parse_args()

    if not args.verify:
        run_build()

    if args.skip_verify:
        return 0

    if not DIST_DIR.exists():
        sys.exit(f"[FATAL] 产物目录不存在：{DIST_DIR}")

    size = dir_size_mb(DIST_DIR)
    print(f"[build] 产物体积 {size:.1f} MB（{DIST_DIR}）")

    ok = verify()
    print()
    if ok:
        print(f"✓ 打包产物自检通过（{size:.1f} MB）")
        return 0
    print("✗ 打包产物自检失败")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
