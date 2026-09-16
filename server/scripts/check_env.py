#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""环境自检：一屏看清本机后端环境是否满足开发要求。

用法::

    cd server
    uv run python scripts/check_env.py

退出码 0 = 无 FAIL；1 = 有 FAIL。**WARN 不算失败**（例如嵌入模型还没下载，
在票 10 之前是正常状态）。

为什么要先 `install_utf8_stdio()`：本机 Windows 控制台默认是 GBK，
中文输出本身就会乱码；先把流切到 UTF-8，后面的检查结果才可信。
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import (  # noqa: E402
    EMBEDDING_DIM,
    EMBEDDING_MODEL_DIR,
    EMBEDDING_MODEL_ID,
    model_files_present,
)
from app.console import install_utf8_stdio  # noqa: E402

# 先修编码，再看别的
install_utf8_stdio()

results: list[tuple[str, str, str]] = []


def run_check(name: str, fn) -> None:
    try:
        level, detail = fn()
    except Exception as exc:  # noqa: BLE001
        level, detail = "FAIL", f"{type(exc).__name__}: {exc}"
    results.append((level, name, detail))
    print(f"[{level}] {name:<34} {detail}")


# ---------------------------------------------------------------------------


def c_python() -> tuple[str, str]:
    v = sys.version_info
    return ("OK  " if v[:2] == (3, 12) else "FAIL", f"{sys.version.split()[0]} @ {sys.executable}")


def c_sqlite_vec() -> tuple[str, str]:
    """sqlite-vec 不只是能 import —— 必须真的能在连接里 load 出来。

    只测 import 会漏掉「.dll 没随包进去」这类打包事故。
    """
    import importlib.metadata as md

    import sqlite_vec

    conn = sqlite3.connect(":memory:")
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    # 加载完立刻关掉扩展加载权限：留着它等于把任意 .dll 注入能力暴露给后续 SQL
    conn.enable_load_extension(False)
    version = conn.execute("select vec_version()").fetchone()[0]
    conn.close()
    return "OK  ", f"pip {md.version('sqlite-vec')}；vec_version={version}"


def c_numpy() -> tuple[str, str]:
    import numpy as np

    return "OK  ", np.__version__


def c_fastembed() -> tuple[str, str]:
    """嵌入模型：**包必须能 import（FAIL），模型文件缺失只 WARN**。

    模型文件由 `scripts/fetch_embedding_model.py` 落到
    `server/resources/models/fastembed/`（约 90MB，不入 git）。
    在票 10 把模型拉下来之前，缺文件是正常状态；而缺依赖包是环境问题，必须报错。
    """
    import importlib.metadata as md

    import fastembed  # noqa: F401

    version = md.version("fastembed")
    if not model_files_present():
        return (
            "WARN",
            f"包已装 v{version}，但模型未就位（期望目录 {EMBEDDING_MODEL_DIR}）—— "
            "票 10 之前属正常；届时跑 uv run python scripts/fetch_embedding_model.py",
        )
    return "OK  ", f"v{version}；模型 {EMBEDDING_MODEL_ID}（{EMBEDDING_DIM} 维）文件已就位"


def c_utf8() -> tuple[str, str]:
    encoding = sys.stdout.encoding or ""
    level = "OK  " if encoding.lower().replace("-", "") == "utf8" else "FAIL"
    return level, f"stdout={encoding}"


def main() -> int:
    print(f"root = {ROOT}\n")
    run_check("python 3.12", c_python)
    run_check("sqlite-vec (import + load)", c_sqlite_vec)
    run_check("numpy", c_numpy)
    run_check("fastembed (包 + 模型)", c_fastembed)
    run_check("编码环境 (UTF-8)", c_utf8)

    failed = [name for level, name, _ in results if level == "FAIL"]
    warned = [name for level, name, _ in results if level == "WARN"]

    print()
    if failed:
        print(f"[X] {len(failed)} 项未通过：{', '.join(failed)}")
        return 1
    if warned:
        print(f"[!] {len(warned)} 项警告（不阻塞）：{', '.join(warned)}")
    print("[OK] 环境基线就绪。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
