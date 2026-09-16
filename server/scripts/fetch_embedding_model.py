#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""拉取本地嵌入模型 ``BAAI/bge-small-zh-v1.5``（约 90MB，**不入 git**）。

用法::

    cd server
    uv run python scripts/fetch_embedding_model.py                    # 已就位则直接跳过（幂等）
    uv run python scripts/fetch_embedding_model.py --force            # 强制重新下载
    uv run python scripts/fetch_embedding_model.py --source <目录>     # 从离线 HF 缓存复制（不联网）

落到 ``server/resources/models/fastembed/``，目录布局与 fastembed 的 HF 缓存一致，
因此运行期可以用 ``local_files_only=True`` 直接加载（**离线可用**，断网演示不会卡）。

**幂等**：默认先检查「文件在不在 + 维度对不对」，判定通过就只打印一行然后退出 ——
重复执行不会重新下载 90MB，也不会把已有文件覆盖掉。

**维度断言**：装好之后真的编码一次，断言 ``len(vector) == EMBEDDING_DIM``（512）。
只检查文件名是不够的：模型目录里混进别的快照时，文件都在而维度是错的，
那时整个向量索引都会算错，且没有任何报错。
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import EMBEDDING_DIM, EMBEDDING_MODEL_DIR, EMBEDDING_MODEL_ID  # noqa: E402
from app.console import install_utf8_stdio  # noqa: E402
from app.rag.embedder import model_files_present, resolve_model_dir  # noqa: E402

install_utf8_stdio()

# fastembed 的 HF 缓存目录名（Qdrant 是 bge 系列在 HF 上的发布方）
HF_REPO_DIR = "models--Qdrant--bge-small-zh-v1.5"


def verify(model_dir: Path, *, verbose: bool = True) -> bool:
    """真的编码一次并断言维度。"""
    if not model_files_present(model_dir):
        return False
    try:
        from fastembed import TextEmbedding

        model = TextEmbedding(
            model_name=EMBEDDING_MODEL_ID, cache_dir=str(model_dir), local_files_only=True
        )
        vector = list(model.query_embed(["维度校验"]))[0]
    except Exception as exc:  # noqa: BLE001
        print(f"[校验失败] 模型加载报错：{type(exc).__name__}: {exc}", file=sys.stderr)
        return False

    dim = len(vector)
    if dim != EMBEDDING_DIM:
        print(
            f"[校验失败] 实测维度 {dim} != EMBEDDING_DIM {EMBEDDING_DIM}。"
            "换模型必须同步改 app/config.py 与 vec0 维度并**重建索引**。",
            file=sys.stderr,
        )
        return False
    if verbose:
        norm = sum(float(x) * float(x) for x in vector) ** 0.5
        print(f"[校验通过] {EMBEDDING_MODEL_ID}：{dim} 维，L2 范数 {norm:.4f}（≈1 表示已归一化）")
    return True


def copy_from_source(source: Path, target: Path) -> None:
    """从离线 HF 缓存复制（现场没有网时的唯一出路）。"""
    repo = source / HF_REPO_DIR
    if not repo.is_dir():
        # 也允许直接指向 snapshots 目录
        snapshots = source / "snapshots"
        if snapshots.is_dir():
            repo = source
        else:
            raise SystemExit(
                f"[失败] {source} 里找不到 {HF_REPO_DIR}（应指向 HF 缓存根目录或 snapshots 目录）"
            )
    target.mkdir(parents=True, exist_ok=True)
    shutil.copytree(repo, target / repo.name, dirs_exist_ok=True)
    print(f"[复制完成] {repo} → {target / repo.name}")


def download(target: Path) -> None:
    """走 fastembed 的下载路径（会联网）。"""
    from fastembed import TextEmbedding

    target.mkdir(parents=True, exist_ok=True)
    print(f"[下载中] {EMBEDDING_MODEL_ID} → {target}（约 90MB，只做一次）")
    started = time.perf_counter()
    TextEmbedding(model_name=EMBEDDING_MODEL_ID, cache_dir=str(target), local_files_only=False)
    print(f"[下载完成] 用时 {time.perf_counter() - started:.1f}s")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="拉取本地嵌入模型（幂等）")
    parser.add_argument("--target", default=None, help=f"目标目录（默认 {EMBEDDING_MODEL_DIR}）")
    parser.add_argument("--source", default=None, help="离线 HF 缓存目录（给了就不联网）")
    parser.add_argument("--force", action="store_true", help="已存在也重新拉取")
    args = parser.parse_args(argv)

    target = Path(args.target).expanduser() if args.target else Path(resolve_model_dir())
    print(f"目标目录 = {target}")

    if not args.force and verify(target):
        print("[跳过] 模型已就位且维度正确（幂等：不重复下载）")
        return 0

    try:
        if args.source:
            copy_from_source(Path(args.source).expanduser(), target)
        else:
            download(target)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print(f"[失败] {type(exc).__name__}: {exc}", file=sys.stderr)
        print(
            "提示：网络不通时用 --source 指向离线缓存目录；"
            "运行期检索不需要联网，这一步只是把模型放进 resources/。",
            file=sys.stderr,
        )
        return 1

    return 0 if verify(target) else 1


if __name__ == "__main__":
    raise SystemExit(main())
