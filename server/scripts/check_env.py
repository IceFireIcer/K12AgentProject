#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""环境自检：一屏看清本机后端环境是否满足开发要求。

用法：
    cd server
    uv run python scripts/check_env.py
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "resources" / "models" / "fastembed"

results: list[tuple[str, bool, str]] = []


def check(name: str, fn) -> None:
    try:
        ok, detail = fn()
    except Exception as exc:  # noqa: BLE001
        ok, detail = False, f"{type(exc).__name__}: {exc}"
    results.append((name, ok, detail))
    print(f"[{'OK ' if ok else 'FAIL'}] {name:<34} {detail}")


def c_python():
    v = sys.version_info
    return (v[:2] == (3, 12)), f"{sys.version.split()[0]} @ {sys.executable}"


def c_langgraph():
    import importlib.metadata as md

    from langgraph.graph import StateGraph  # noqa: F401
    from langgraph.checkpoint.sqlite import SqliteSaver  # noqa: F401
    return True, md.version("langgraph")


def c_checkpoint_sqlite():
    from langgraph.checkpoint.sqlite import SqliteSaver
    import importlib.metadata as md
    ver = md.version("langgraph-checkpoint-sqlite")

    # 关键：验证它真的能建表（不只是 import 成功）
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "checkpoint.sqlite"
        conn = sqlite3.connect(db)
        saver = SqliteSaver(conn)
        saver.setup()
        names = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        conn.close()
    need = {"checkpoints", "writes"}
    return need <= names, f"v{ver}；建表 {sorted(need)} 成功"


def c_langchain_openai():
    from langchain_openai import ChatOpenAI  # noqa: F401
    import importlib.metadata as md
    return True, md.version("langchain-openai")


def c_sqlite_vec():
    import sqlite_vec
    import importlib.metadata as md
    conn = sqlite3.connect(":memory:")
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    ver = conn.execute("select vec_version()").fetchone()[0]
    conn.close()
    return True, f"pip {md.version('sqlite-vec')}；vec_version={ver}"


def _model_files_present() -> bool:
    return CACHE_DIR.exists() and any(CACHE_DIR.rglob("*.onnx"))


def c_fastembed():
    import importlib.metadata as md
    if not _model_files_present():
        return False, (
            f"包已装 v{md.version('fastembed')}，但模型未下载 —— "
            "先跑 uv run python scripts/download_models.py"
        )
    from fastembed import TextEmbedding
    model = TextEmbedding(model_name="BAAI/bge-small-zh-v1.5", cache_dir=str(CACHE_DIR))
    dim = len(next(iter(model.embed(["自检"]))))
    return (dim == 512), f"v{md.version('fastembed')}；dim={dim}"


def c_numpy():
    import numpy as np
    return True, np.__version__


def c_utf8():
    import locale
    enc = locale.getpreferredencoding(False)
    return True, f"stdout={sys.stdout.encoding}, locale={enc}"


def main() -> int:
    print(f"root = {ROOT}\n")
    check("python 3.12", c_python)
    check("langgraph", c_langgraph)
    check("langgraph-checkpoint-sqlite", c_checkpoint_sqlite)
    check("langchain-openai", c_langchain_openai)
    check("sqlite-vec (加载 + 版本)", c_sqlite_vec)
    check("fastembed (模型 + 512 维)", c_fastembed)
    check("numpy", c_numpy)
    check("编码环境", c_utf8)

    failed = [n for n, ok, _ in results if not ok]
    print()
    if failed:
        print(f"[X] {len(failed)} 项未通过：{', '.join(failed)}")
        return 1
    print("[OK] 全部通过，环境基线就绪。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
