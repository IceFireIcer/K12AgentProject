#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包后端 sidecar（PyInstaller ``--onedir``）并**立即做产物自检**。

用法::

    cd server
    uv run python scripts/build_server.py            # 打包 + 自检
    uv run python scripts/build_server.py --verify   # 只自检已有产物

产物：``server/dist/k12-agent-server/k12-agent-server.exe``

**为什么要包一层脚本**：PyInstaller 打成功不代表**跑得起来**。历史上最常翻车的三件事是
① sqlite_vec 的 ``.dll`` 没进去；② fastembed 模型/onnxruntime 供应库没进去；
③ 打包后中文变 GBK（bootloader 忽略 ``PYTHONUTF8``）。

所以这里打完立刻起一次**真进程**，并且是**在「没有 Python 的环境」下起**：
PATH 只留 ``System32``、清掉 ``PYTHONHOME`` / ``PYTHONPATH``、不带 venv。
终端用户不需要装 Python —— 这条必须由这个脚本证明，而不是靠相信。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import smoke_api  # noqa: E402  （复用同一套断言，避免两份实现各改一边）

ROOT = HERE.parent
SPEC = ROOT / "packaging" / "k12-agent-server.spec"
DIST_DIR = ROOT / "dist" / "k12-agent-server"
EXE = DIST_DIR / "k12-agent-server.exe"

STARTUP_TIMEOUT_S = 60.0


def dir_size_mb(path: Path) -> float:
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                pass
    return total / (1024 * 1024)


def kill_stale_sidecar() -> None:
    """重打包前杀掉残留的 sidecar 进程。

    Windows 上只要有进程映射着产物里的 ``.pyd`` / ``.dll``，PyInstaller 清 ``dist/``
    就会 ``PermissionError: [WinError 5] 拒绝访问``。上一次验证若没退干净，
    下一次打包必然失败 —— 所以在这里主动清一次，而不是让人去猜。
    """
    if sys.platform != "win32":
        return
    result = subprocess.run(
        ["taskkill", "/IM", "k12-agent-server.exe", "/F"],
        capture_output=True,
        check=False,
    )
    if result.returncode == 0:
        print("[build] 已清理残留的 k12-agent-server.exe 进程")
        time.sleep(1.0)  # 等 Windows 真正释放文件句柄


def scrubbed_env() -> dict[str, str]:
    """构造一个**没有 Python** 的环境，用来证明「终端用户零依赖」。

    只保留 Windows 自身运行所需：System32、临时目录、代码页相关。
    显式**不含** PATH 里的任何 python、不含 venv、不含 PYTHONHOME / PYTHONPATH。
    """
    system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
    temp = os.environ.get("TEMP", str(ROOT / "_data_packaged_check"))
    return {
        "SYSTEMROOT": system_root,
        "WINDIR": os.environ.get("WINDIR", system_root),
        "PATH": rf"{system_root}\System32;{system_root}",
        "TEMP": temp,
        "TMP": temp,
        # 这三条是**源码运行态的补充**；打包态真正起作用的是 app/console.py 的 reconfigure
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
        # 断网复验：证明模型与依赖都在本地
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
    }


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
    proc = subprocess.run(cmd, cwd=ROOT, check=False)
    if proc.returncode != 0:
        sys.exit(f"[FATAL] 打包失败，退出码 {proc.returncode}")
    print(f"[build] 完成，耗时 {time.time() - started:.1f}s")


def verify() -> bool:
    """在「没有 Python 的环境」下起一次打包产物，验证握手 / 接口 / 中文编码。"""
    if not EXE.exists():
        print(f"[FAIL] 产物不存在：{EXE}")
        return False

    data_dir = ROOT / "_data_packaged_check"
    shutil.rmtree(data_dir, ignore_errors=True)
    token = "verifytoken0123456789abcdef0123456789abcdef0123456789abcdef01234567"

    env = scrubbed_env()
    print(f"[verify] 启动 {EXE.name}")
    print(f"[verify] PATH = {env['PATH']}")
    print("[verify] PYTHONHOME/PYTHONPATH 均已清空（证明不依赖本机 Python）")

    # 以二进制管道启动，自己按 UTF-8 解码 —— 这样才能拿到**原始字节**，
    # 从而严格判断「打包后是否按 GBK 输出了中文」。
    proc = subprocess.Popen(
        [
            str(EXE),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--token",
            token,
            "--data-dir",
            str(data_dir),
            "--log-level",
            "info",
        ],
        cwd=str(DIST_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdout is not None and proc.stderr is not None

    collector = smoke_api.StdoutCollector(proc.stdout)
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

    ok = True
    port: int | None = None
    try:
        started = time.monotonic()
        handshake = smoke_api.wait_for_handshake(collector, proc, STARTUP_TIMEOUT_S)
        elapsed = time.monotonic() - started

        if handshake is None:
            smoke_api.check("收到握手 JSON", False, f"{STARTUP_TIMEOUT_S:.0f}s 内未收到")
            print("  stdout：", collector.lines)
            print("  stderr：", b"".join(stderr_chunks).decode("utf-8", "replace")[-800:])
            return False

        smoke_api.check("收到握手 JSON", True, f"冷启动 {elapsed:.2f}s")
        smoke_api.check(
            "★ 握手 event == ready",
            handshake.get("event") == "ready",
            f"port={handshake.get('port')} pid={handshake.get('pid')}",
        )
        smoke_api.check(
            "★ frozen == true（确实跑的是冻结产物，不是源码）",
            handshake.get("frozen") is True,
            str(handshake.get("frozen")),
        )

        port = int(handshake["port"])
        time.sleep(smoke_api.QUIET_WINDOW_S)
        smoke_api.check(
            "★ stdout 恰好一行（握手通道未被污染）",
            len(collector.lines) == 1,
            f"实际 {len(collector.lines)} 行：{collector.lines[1:3]}",
        )

        smoke_api.run_api_checks(f"http://127.0.0.1:{port}", token)

        owner = smoke_api.pid_owning_port(port)
        smoke_api.check(
            "★ 握手 pid == 真正监听端口的进程",
            owner is not None and owner == handshake.get("pid"),
            f"握手 pid={handshake.get('pid')}；占端口 pid={owner}；Popen 报的 pid={proc.pid}",
        )

        # 编码回归：打包后 stderr 必须是合法 UTF-8（PyInstaller 忽略 env，
        # 全靠 app/console.py 的 reconfigure 兜住）
        time.sleep(0.3)
        raw = b"".join(stderr_chunks)
        if not raw:
            smoke_api.check("stderr 中文编码", False, "未捕获到 stderr，无法判定")
        else:
            try:
                decoded = raw.decode("utf-8")
                smoke_api.check("★ stderr 是合法 UTF-8", True, decoded.strip().splitlines()[0][:80] if decoded.strip() else "")
                smoke_api.check(
                    "★ stderr 中文未乱码（含「已绑定」）",
                    "已绑定" in decoded,
                    "已在日志中找到预期中文",
                )
            except UnicodeDecodeError as exc:
                smoke_api.check("★ stderr 是合法 UTF-8", False, f"解码失败：{exc}")

        if not os.access(DIST_DIR / EXE.name, os.X_OK):
            ok = False
    finally:
        if port is not None:
            print("--- 退出清理 ---")
            smoke_api.kill_tree(proc.pid)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                smoke_api.check("进程在 15s 内退出", False)
            time.sleep(0.5)
            smoke_api.check(
                "★ 退出后端口已释放（无孤儿）",
                not smoke_api.port_is_listening(port),
                f"port={port}",
            )
        collector.join()
        stderr_thread.join(timeout=2)
        if proc.poll() is None:
            smoke_api.kill_tree(proc.pid)
        shutil.rmtree(data_dir, ignore_errors=True)

    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="打包 sidecar 并自检")
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
    print(f"[build] 产物体积 {size:.1f} MB（{DIST_DIR}）\n")

    verify()

    print(f"\n{'=' * 60}")
    if smoke_api._failed:
        print(f"✗ {len(smoke_api._failed)} 项失败 / 共 {smoke_api._passed + len(smoke_api._failed)} 项："
              f"{'；'.join(smoke_api._failed)}")
        print(f"  产物体积 {size:.1f} MB")
        return 1
    print(f"✓ 打包产物自检全部通过（{smoke_api._passed} 项，{size:.1f} MB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
