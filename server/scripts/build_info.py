#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""后端构建指纹：判断「磁盘上那份 sidecar exe 是不是**当前源码**打出来的」。

★ 为什么需要它（见 ``docs/report-material/pitfalls.md`` 的 P-072）：

sidecar 是**独立打包的产物**（``scripts/build_server.py`` → ``server/dist/k12-agent-server/``），
它**不随** ``electron-vite build`` 更新；而 ``npm run build:win`` 只把磁盘上**现成的那份**
exe 拷进安装包。于是「改了 ``server/`` 却没重打包」的包能顺利构建、能过全部单测，
只是**包里跑的是几天前的后端** —— 这类缺陷不会报错，只会以「源码里早修好的 bug 在包里还活着」
或「新端点 404」的形式漂到交付。

本模块是这套机制的**唯一实现**：Python 算出指纹并写进产物，JS 侧（``desktop/scripts/``）
只**调用**它、不另写一套算法 —— 两套算法一旦有细微差异（排序、编码、换行），
就会出现「明明刚打过包却永远判过期」或更糟的「过期却判新鲜」。

指纹 = 对「会进 exe 的那些文件」按路径排序后做 sha256：

* **逐字节哈希**：``app/`` ``scripts/`` ``packaging/`` ``knowledge/`` ``pyproject.toml`` ``uv.lock``
* **只记大小**：``resources/models/``（91MB ONNX，逐字节哈希纯属浪费；大小变了就足够可疑）
* **明确排除**：``tests/``（不进包 —— 改个测试不该触发几分钟的重打包）、
  ``dist/`` ``build/`` ``_data*/`` ``__pycache__`` ``.venv`` 与 ``*.pyc``；
  以及 ``resources/kb/``（那是**构建产出**，由 ``build_kb.py`` 现建，不是源码输入）

⚠️ **改了本文件的算法必须同步 ``FINGERPRINT_SCHEMA``**：schema 变了，旧指纹一律视为过期、
   产物会被重打一次。宁可多重打一次，也不要「新旧算法凑巧算出同一个值」。

用法::

    uv run python scripts/build_info.py --fingerprint   # 只打印 64 位指纹（给 JS 侧调用）
    uv run python scripts/build_info.py --json          # 打印完整信息（人看）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

#: 指纹算法版本。改算法（不只是改参数）时 +1：旧产物一律判过期。
FINGERPRINT_SCHEMA = 1

#: 指纹覆盖的目录（相对 ``server/``）
SOURCE_DIRS = ("app", "scripts", "packaging", "knowledge", "resources")

#: 指纹覆盖的顶层单文件
SOURCE_FILES = ("pyproject.toml", "uv.lock")

#: 任何层级都不参与指纹的目录名 / 文件后缀
SKIP_DIR_NAMES = frozenset(
    {"__pycache__", ".venv", ".git", "build", "dist", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
)
SKIP_SUFFIXES = frozenset({".pyc", ".pyo", ".log"})

#: 只记大小、不做内容哈希的子树（相对 ``server/``，POSIX 分段）
SIZE_ONLY_PREFIXES: tuple[tuple[str, ...], ...] = (("resources", "models"),)

#: 构建产出（不是源码输入）：由 ``build_kb.py`` 现建，留在源码树里也不该影响指纹
SKIP_PREFIXES: tuple[tuple[str, ...], ...] = (("resources", "kb"),)

#: 产物内的指纹文件名（``electron-builder.yml`` 的 extraResources 会把它一起拷进包里）
BUILD_INFO_FILENAME = "build-info.json"


def server_root() -> Path:
    """``server/`` 目录（本文件在 ``server/scripts/`` 下）。"""
    return Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------- #
# 指纹
# --------------------------------------------------------------------------- #
def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _skip(parts: tuple[str, ...]) -> bool:
    """该相对路径是否不参与指纹。"""
    if any(part in SKIP_DIR_NAMES for part in parts):
        return True
    if any(part.startswith("_data") for part in parts):
        return True
    if any(parts[: len(prefix)] == prefix for prefix in SKIP_PREFIXES):
        return True
    return parts[-1].split(".")[-1] in {"pyc", "pyo"} or PurePosixPath(parts[-1]).suffix in SKIP_SUFFIXES


def _size_only(parts: tuple[str, ...]) -> bool:
    return any(parts[: len(prefix)] == prefix for prefix in SIZE_ONLY_PREFIXES)


def iter_source_files(root: Path) -> list[tuple[str, Path]]:
    """列出「会进 exe」的源文件：``[(相对 POSIX 路径, 绝对路径)]``，按路径排序。"""
    found: dict[str, Path] = {}

    for name in SOURCE_FILES:
        candidate = root / name
        if candidate.is_file():
            found[name] = candidate

    for top in SOURCE_DIRS:
        base = root / top
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            parts = path.relative_to(root).parts
            if _skip(parts):
                continue
            found[PurePosixPath(*parts).as_posix()] = path

    return sorted(found.items())


def compute_fingerprint(root: Path | None = None) -> dict[str, object]:
    """算出源码树的指纹。返回 ``{schema, fingerprint, fileCount, sizeOnlyCount}``。"""
    root = Path(root) if root is not None else server_root()
    if not (root / "app").is_dir():
        raise FileNotFoundError(f"{root} 下没有 app/ —— 传进来的不像 server/ 源码根")

    entries: list[str] = [f"schema={FINGERPRINT_SCHEMA}", f"root={root.name}"]
    size_only = 0
    for rel, path in iter_source_files(root):
        parts = tuple(rel.split("/"))
        if _size_only(parts):
            size_only += 1
            # 只记大小：模型文件是「内容资产」，换一个模型的判据是体积变了
            entries.append(f"{rel}\tsize={path.stat().st_size}")
        else:
            entries.append(f"{rel}\tsha256={_file_sha256(path)}")

    digest = hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()
    return {
        "schema": FINGERPRINT_SCHEMA,
        "fingerprint": digest,
        "fileCount": len(entries) - 2,
        "sizeOnlyCount": size_only,
    }


# --------------------------------------------------------------------------- #
# 产物的构建信息
# --------------------------------------------------------------------------- #
def _git_commit(root: Path) -> tuple[str | None, bool]:
    """``(短 commit, 是否有未提交改动)``。仓库不可用时返回 ``(None, False)``。

    只作**溯源展示**用（写进 build-info.json 供排查），**不参与指纹判定** ——
    未提交的改动也必须能让指纹变，所以指纹是哈希文件内容而不是哈希 commit。
    """
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(root),
            capture_output=True,
            # ★★ 显式 utf-8 + errors="replace"（2026-09-28 集成期修的既有缺陷）：
            #   裸 text=True 用**系统默认编码**（中文 Windows 是 GBK），而 git 输出是 UTF-8；
            #   一旦工作树里有非 ASCII 路径（本仓库的 docs/执行报告-*.md 就是），
            #   解码在 subprocess 的读取线程里抛 UnicodeDecodeError，被吞掉后 stdout 变成 None，
            #   下一行 .strip() 直接 AttributeError —— 整个 build-info 指纹失效。
            #   errors="replace" 保证 stdout **永远是 str**：指纹宁可标「脏」也不能崩。
            encoding="utf-8",
            errors="replace",
            text=True,
            timeout=10,
            check=False,
        )
        if commit.returncode != 0:
            return None, False
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(root),
            capture_output=True,
            # ★ 同上：这条**必然**回显工作树里的非 ASCII 路径，是那个 AttributeError 的触发点。
            encoding="utf-8",
            errors="replace",
            text=True,
            timeout=10,
            check=False,
        )
        return commit.stdout.strip() or None, bool(dirty.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return None, False


def build_info_payload(root: Path | None = None, *, info: dict[str, object] | None = None) -> dict[str, object]:
    """构造 ``build-info.json`` 的内容。``info`` 可传**打包前**算好的指纹（见 build_server.py）。

    ★ 刻意用「打包前算的那一份」而不是打包后再算：若打包期间源码又被改动，
    产物里盖的仍是**它真正打出来的那份源码**的指纹，于是下一次 ``--if-stale``
    会判过期并重打 —— 失败方向是「多重打一次」，而不是「过期却判新鲜」。
    """
    root = Path(root) if root is not None else server_root()
    info = dict(info) if info is not None else compute_fingerprint(root)
    commit, dirty = _git_commit(root)
    return {
        "schema": info.get("schema", FINGERPRINT_SCHEMA),
        "fingerprint": info.get("fingerprint"),
        "fileCount": info.get("fileCount"),
        "builtAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "gitCommit": commit,
        "gitDirty": dirty,
        "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "builtBy": "server/scripts/build_server.py",
    }


def read_build_info(directory: Path) -> dict[str, object] | None:
    """读某份产物目录里的 ``build-info.json``（不存在/坏掉都返回 ``None``）。"""
    path = Path(directory) / BUILD_INFO_FILENAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_build_info(directory: Path, payload: dict[str, object]) -> Path:
    path = Path(directory) / BUILD_INFO_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def is_fresh(directory: Path, *, root: Path | None = None) -> tuple[bool, dict[str, object]]:
    """产物目录里的那份是不是当前源码打出来的。

    返回 ``(是否新鲜, 当前源码的指纹信息)``。**只有指纹相同且 schema 相同才算新鲜**；
    缺少 ``build-info.json``（即本机制上线前的旧产物）一律判**不新鲜** —— 重打一次。
    """
    root = Path(root) if root is not None else server_root()
    current = compute_fingerprint(root)
    recorded = read_build_info(directory)
    if not recorded:
        return False, current
    same = (
        recorded.get("schema") == current["schema"]
        and recorded.get("fingerprint") == current["fingerprint"]
    )
    return bool(same), current


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="后端源码指纹 / 产物构建信息")
    parser.add_argument("--fingerprint", action="store_true", help="只打印 64 位指纹（给 JS 侧调用）")
    parser.add_argument("--json", action="store_true", help="打印完整信息 JSON")
    parser.add_argument("--root", default=None, help="server/ 源码根（默认自动定位）")
    args = parser.parse_args(argv)

    root = Path(args.root) if args.root else server_root()
    info = compute_fingerprint(root)

    if args.fingerprint and not args.json:
        print(str(info["fingerprint"]))
        return 0

    print(json.dumps(build_info_payload(root, info=info), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
