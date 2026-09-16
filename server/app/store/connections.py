"""SQLite 连接工厂（含 ``sqlite-vec`` 扩展加载）。

**加载顺序是硬要求，不要调换**（执行文档 §8.5 / 业务陷阱清单 §2 第 4 条）::

    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)      # 立刻关掉：留着等于把任意 .dll 注入能力暴露给后续 SQL

**加载失败不是致命错误**：``load_sqlite_vec`` 只抛 :class:`SqliteVecUnavailable`，
由检索链降级到 numpy 暴力余弦（仍然算 ``degraded="vector"``）。
整个进程**不允许**因为向量扩展缺失而起不来 —— 模型缺、扩展缺、网断，应用都得能用。
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

# 查询超时：写库时若另一个进程正在读，宁可等一会也不要立刻抛 locked
BUSY_TIMEOUT_MS = 5000


class SqliteVecUnavailable(RuntimeError):
    """``sqlite-vec`` 无法加载（未安装 / .dll 缺失 / 被显式禁用）。"""


class DatabaseMissing(FileNotFoundError):
    """库文件不存在（例如 kb.sqlite 还没建）。调用方应降级而不是崩。"""


def load_sqlite_vec(conn: sqlite3.Connection) -> None:
    """按固定顺序加载 ``sqlite-vec`` 扩展。失败抛 :class:`SqliteVecUnavailable`。"""
    try:
        import sqlite_vec
    except ImportError as exc:  # pragma: no cover - 依赖缺失只可能出现在裁剪环境
        raise SqliteVecUnavailable(f"sqlite_vec 包不可用：{exc}") from exc

    try:
        conn.enable_load_extension(True)
    except (AttributeError, sqlite3.OperationalError) as exc:
        raise SqliteVecUnavailable(f"该 SQLite 构建不支持加载扩展：{exc}") from exc

    try:
        sqlite_vec.load(conn)
    except Exception as exc:  # noqa: BLE001 - 任何失败都归入「扩展不可用」
        raise SqliteVecUnavailable(f"sqlite_vec.load 失败：{exc}") from exc
    finally:
        # ★ 必须在 finally 里关：否则异常路径会把注入能力留在连接上
        conn.enable_load_extension(False)


def vec_available(conn: sqlite3.Connection) -> bool:
    """连接上是否真的能用 ``vec_version()``（只测 import 会漏掉 .dll 没进包的事故）。"""
    try:
        conn.execute("select vec_version()").fetchone()
    except sqlite3.Error:
        return False
    return True


def connect(
    path: str | Path,
    *,
    readonly: bool = False,
    load_vec: bool = False,
    wal: bool = True,
    check_same_thread: bool = False,
) -> sqlite3.Connection:
    """打开库文件。

    - ``readonly=True``：走 SQLite URI 的 ``mode=ro``（``kb.sqlite`` 是随包分发的只读库）
    - ``load_vec=True``：立刻加载 ``sqlite-vec``；**加载失败时回退为普通连接**并返回，
      由调用方用 :func:`vec_available` 判断能力，而不是在这里抛异常
    - ``check_same_thread=False``：FastAPI 同步端点跑在线程池里，连接会被跨线程使用；
      调用方负责串行化（见 ``app/rag/retriever.py`` 的 ``RagService._lock``）
    """
    p = Path(path)
    if readonly:
        if not p.exists():
            raise DatabaseMissing(f"库文件不存在：{p}")
        uri = f"file:{p.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, check_same_thread=check_same_thread)
    else:
        p.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(p), check_same_thread=check_same_thread)

    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    if not readonly and wal:
        # WAL：读多写少 + 允许读写并发；只在可写库上设
        conn.execute("PRAGMA journal_mode = WAL")
    if load_vec:
        try:
            load_sqlite_vec(conn)
        except SqliteVecUnavailable as exc:
            logger.warning("sqlite-vec 不可用，将以 numpy 兜底：%s", exc)
    return conn


def connect_memory(*, load_vec: bool = True) -> sqlite3.Connection:
    """内存库（单测用）。"""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    if load_vec:
        load_sqlite_vec(conn)  # 单测里加载失败应该立刻暴露
    return conn
