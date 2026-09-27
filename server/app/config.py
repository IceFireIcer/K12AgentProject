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
APP_TITLE = "智团团 · sidecar"
APP_VERSION = "1.0.0"

# ---------------------------------------------------------------- 契约常量 --
# ★ 嵌入模型契约：512 维。改动必须连带 vec0 维度 + 重建索引（执行文档 §8.4）。
EMBEDDING_DIM = 512
EMBEDDING_MODEL_ID = "BAAI/bge-small-zh-v1.5"

# ---------------------------------------------------------------- 网络约束 --
# sidecar 只许绑回环：防本机其他进程与局域网访问（执行文档 §6.3 安全第 ① 条）。
# ⚠️ 这三个取值**都必须真的绑得上**：``app/main.py`` 的 ``bind_listening_socket()``
#    按 ``socket.getaddrinfo`` 选出正确的 family（IPv4 优先）——
#    ``::1`` 是纯 IPv6，硬编码 ``AF_INET`` 会让它抛 ``[Errno 11001] getaddrinfo failed``。
#    「允许的取值里混进一个一定绑不上的」正是审计发现的缺陷 C8，别把 family 选择改回硬编码。
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

# ------------------------------------------------- 随包分发的只读知识库 --
# ★ ``kb.sqlite`` 是**版本化的只读内容资产**，随应用分发（执行文档 §8.1：
#   「随应用分发，只读」）。它和 ``resources/models/fastembed`` 一样属于「内容」，
#   不属于「用户数据」—— 用户数据在 ``<data-dir>/shared/`` 里。
#
# 历史缺陷（关卡 E 复验发现，本文件是修复的一部分）：打包产物带了模型、带了
# ``resources/``，却**没带 kb.sqlite**。新机器上 data-dir 是空的，
# 检索一路降级到 ``outline``（0 命中），而 ``/health`` 的 ``embedderReady`` 仍是 true ——
# 表现得「一切正常」，实际知识库是空的。所以「随包 kb 落在哪」必须是一个**常量**，
# 由构建期（spec）与运行期（检索）共用，不允许两边各写一份路径。
#
# 布局：源码态 ``server/resources/kb/kb.sqlite``（**通常不存在**：构建产物，不入 git）；
#       打包态 ``<app>/_internal/resources/kb/kb.sqlite``。
BUNDLED_KB_FILENAME = "kb.sqlite"
BUNDLED_KB_RELATIVE = Path("resources") / "kb" / BUNDLED_KB_FILENAME

#: 随包只读 kb 的**运行期**路径（**不保证存在** —— 源码态一般就没有，走 dev 的 per-user 库）。
BUNDLED_KB_PATH = ROOT_DIR / BUNDLED_KB_RELATIVE

#: 随包 kb 的**构建期**暂存位。由 ``scripts/build_server.py`` 建库、由 PyInstaller spec
#: 收进产物。刻意**不**放进 ``resources/``：源码态若在 ``resources/kb/`` 留一份，
#: 开发时新库会被它悄悄顶掉（见 ``retriever.default_kb_path`` 的解析顺序）。
#: ``build/`` 与 ``*.sqlite`` 都在 .gitignore 里，所以这份产物永远不会被提交。
BUNDLED_KB_STAGING = ROOT_DIR / "build" / "bundle" / BUNDLED_KB_FILENAME


def bundled_kb_path() -> Path:
    """随包只读 ``kb.sqlite`` 的路径（**只给路径，不判断存在性**）。

    包一层函数而不是让调用方直接用常量，是为了留一个**可替换的接缝**：
    ``app/rag/retriever.py`` 通过模块级名字调用它，单测可以 patch 这个引用，
    在不碰真实 ``resources/`` 的前提下验证四级解析顺序。
    """
    return BUNDLED_KB_PATH


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
