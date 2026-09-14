"""运行时路径与配置。

只放「路径解析」与「常量」，不含业务逻辑。所有路径都兼容两种运行形态：
- 开发：直接从源码运行（`uv run python -m app.main`）
- 打包：PyInstaller `--onedir` 产出的 `k12-agent-server.exe`

⚠️ 禁止在日志里打印 API Key / token 等凭据。
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from importlib.metadata import PackageNotFoundError, version as _pkg_version

APP_NAME = "k12-agent-server"

#: 嵌入向量维度。S00 实测 bge-small-zh-v1.5 = 512。
#: ⚠️ 唯一来源，禁止在别处硬编码 512（升级到 bge-base-zh-v1.5 时为 768，须同步重建索引）。
EMBEDDING_DIM = 512

#: 嵌入模型名（fastembed / ONNX，无 torch、无 Ollama）。
EMBEDDING_MODEL_ID = "BAAI/bge-small-zh-v1.5"


def _version() -> str:
    try:
        return _pkg_version(APP_NAME)
    except PackageNotFoundError:  # 源码运行、未安装为包时
        return "0.1.0-dev"


APP_VERSION = _version()

#: sidecar 只会绑定本机回环地址。改动此常量等于打开对本机的攻击面，不要改。
ALLOWED_HOSTS = ("127.0.0.1", "::1", "localhost")


def is_frozen() -> bool:
    """是否运行在 PyInstaller 打包产物中。"""
    return bool(getattr(sys, "frozen", False))


def _bundle_root() -> Path:
    """打包时资源所在根目录，开发时等同仓库 `server/` 目录。"""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent  # server/


ROOT_DIR = _bundle_root()

#: 随包分发的只读资源（嵌入模型、题库、动画模板、敏感词库）。
RESOURCES_DIR = ROOT_DIR / "resources"


def resolve_data_dir(raw: str | os.PathLike[str] | None) -> Path:
    """解析侧车数据目录。

    打包后 `sys.executable` 在 Program Files 一类只读目录，相对路径必须锚定到 exe 同级，
    否则会写到只读位置直接失败。开发态则直接相对 CWD 解析。
    """
    if raw is None:
        base = Path(sys.executable).resolve().parent if is_frozen() else Path.cwd()
        candidate = base / "_data"
    else:
        candidate = Path(raw).expanduser()

    if not candidate.is_absolute():
        if is_frozen():
            candidate = Path(sys.executable).resolve().parent / candidate
        else:
            candidate = Path.cwd() / candidate
    return Path(os.path.normpath(str(candidate)))


@dataclass(frozen=True)
class RuntimeConfig:
    """一次 sidecar 进程的启动参数快照。"""

    host: str
    port: int
    token: str
    data_dir: Path

    @property
    def auth_enabled(self) -> bool:
        return bool(self.token)

    def describe(self) -> str:
        """可安全写日志的描述（**不含 token**）。"""
        return (
            f"host={self.host} port={self.port} "
            f"data_dir={self.data_dir} auth={'on' if self.auth_enabled else 'off'}"
        )
