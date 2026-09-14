#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""下载并固化离线资源（嵌入模型）。

目标：把模型文件落到 server/resources/models/fastembed/，
而不是默认用户缓存 —— 否则 PyInstaller 打包时收不到。

用法：
    cd server
    uv run python scripts/download_models.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "resources" / "models" / "fastembed"

# 与 app/rag/embedder.py 中的常量保持一致；改这里必须同步改那边并重建索引。
MODEL_NAME = "BAAI/bge-small-zh-v1.5"
EXPECTED_DIM = 512


def main() -> int:
    from fastembed import TextEmbedding

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[i] 模型名   : {MODEL_NAME}")
    print(f"[i] 缓存目录 : {CACHE_DIR}")
    print("[i] 开始加载（首次会联网下载）...")

    model = TextEmbedding(model_name=MODEL_NAME, cache_dir=str(CACHE_DIR))

    print("[i] 下载完成，执行编码自检 ...")
    vec = next(iter(model.embed(["人工智能通识课"])))
    dim = len(vec)
    print(f"[i] 向量维度 : {dim}")
    if dim != EXPECTED_DIM:
        print(f"[!] 维度不符：期望 {EXPECTED_DIM}，实际 {dim}")
        return 1

    size_mb = sum(f.stat().st_size for f in CACHE_DIR.rglob("*") if f.is_file()) / 1024 / 1024
    print(f"[ok] 模型已就绪，总体积 {size_mb:.1f} MB")
    print(f"[ok] 位置：{CACHE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
