"""运行期配置与全局常量。

**常量集中于此，不要在别处硬编码** —— 尤其 ``EMBEDDING_DIM``：
升级嵌入模型（如换 ``bge-base-zh-v1.5`` 变 768 维）时必须**同步改 ``vec0`` 维度并重建索引**，
散落各处的 ``512`` 是最容易漏掉的一处。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

APP_NAME = "k12-agent-server"
APP_TITLE = "K12 AI 教学助手 · sidecar"
APP_VERSION = "0.1.0"

# ---------------------------------------------------------------- 契约常量 --
# ★ 嵌入模型契约：512 维。改动必须连带 vec0 维度 + 重建索引（执行文档 §8.4）。
EMBEDDING_DIM = 512
EMBEDDING_MODEL_ID = "BAAI/bge-small-zh-v1.5"

# ---------------------------------------------------------------- 网络约束 --
# sidecar 只许绑回环：防本机其他进程与局域网访问（执行文档 §6.3 安全第 ① 条）。
ALLOWED_HOSTS = ("127.0.0.1", "::1", "localhost")
DEFAULT_HOST = "127.0.0.1"
# 0 = 由系统分配空闲端口（执行文档 §7.4 第 1 条，自找端口有竞态）。
DEFAULT_PORT = 0
# 开发态固定端口：便于手动 curl 调试（执行文档 §7.5）。
DEV_PORT = 8756
# 启动期探活的宽限时间由 Electron 侧控制（30s），本进程不设。
DEFAULT_LOG_LEVEL = "info"


def _root_dir() -> Path:
    """定位运行根目录，兼容源码态与 PyInstaller 打包态。

    - 源码态：``app/config.py`` → 上溯两级即 ``server/``。
    - 打包态：PyInstaller 把 ``resources/`` 解到 ``sys._MEIPASS``（``--onedir`` 下即 exe 同级）。
      **注意**：运行时数据（config.json / SQLite）绝不能写进这里 —— 见 ``resolve_data_dir``。
    """
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


ROOT_DIR = _root_dir()
RESOURCES_DIR = ROOT_DIR / "resources"
KNOWLEDGE_DIR = ROOT_DIR / "knowledge"
EMBEDDING_MODEL_DIR = RESOURCES_DIR / "models" / "fastembed"


def model_files_present() -> bool:
    """嵌入模型文件是否已就位。

    只做**文件存在性**判断，不加载模型 —— 探活端点必须轻量，
    真实加载失败（内存不足 / 文件损坏）由检索链路的降级兜底处理。
    """
    return EMBEDDING_MODEL_DIR.is_dir() and any(EMBEDDING_MODEL_DIR.rglob("*.onnx"))


def resolve_data_dir(raw: str | Path | None) -> Path:
    """把 ``--data-dir`` 解析成绝对路径。

    Electron 会传 ``userData``（每个用户各自的目录）；不传时退到可写位置，
    便于脱离 Electron 手动起服务调试。**注意不要退到 ROOT_DIR**：打包态那里是只读的。
    """
    if raw:
        return Path(raw).expanduser().resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "_data"
    return ROOT_DIR / "_data"


@dataclass(frozen=True)
class RuntimeConfig:
    """启动参数解析后的运行期配置（不可变）。"""

    host: str
    port: int
    token: str
    data_dir: Path
    log_level: str = DEFAULT_LOG_LEVEL
    # 打包态标志，落日志/排查时有用
    frozen: bool = False


def build_runtime_config(
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    token: str = "",
    data_dir: str | Path | None = None,
    log_level: str = DEFAULT_LOG_LEVEL,
) -> RuntimeConfig:
    """校验并构造运行期配置。**绑定非回环地址直接拒绝启动**。"""
    if host not in ALLOWED_HOSTS:
        raise SystemExit(
            f"拒绝绑定非回环地址：{host}（只允许 {', '.join(ALLOWED_HOSTS)}）"
        )
    return RuntimeConfig(
        host=host,
        port=int(port),
        token=token or "",
        data_dir=resolve_data_dir(data_dir),
        log_level=log_level,
        frozen=bool(getattr(sys, "frozen", False)),
    )
