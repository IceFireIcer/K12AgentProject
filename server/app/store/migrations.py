"""``schema_version`` + 幂等迁移器（**不用 Alembic**）。

为什么不上 Alembic：本地 SQLite、一人一库（``learning.db``）、随包分发，
没有多人协作的 schema 演进需求；引入迁移框架只会多一层依赖与一个必须在打包态跑通的东西。
这里只要保证两件事：**能建出来** 与 **重复跑不炸**（执行文档 §8.3、票 10）。

设计
----
- 迁移以 ``(set_name, version)`` 记账。**set_name 是给其他轨道留的并行通道**：
  票 14（题库）需要新表时，自己带一组 ``Migration`` 用 ``set_name="quiz"`` 调
  :func:`ensure_migrated` 即可，不必改本文件、也不会和 ``kb`` 的版本号打架。
- 每条迁移在**一个事务**里执行并当场记账；任一步失败 → 整体回滚，版本号不前进。
- ``chunk_vec``（vec0 虚拟表）**不进版本表**：它依赖 ``sqlite-vec`` 扩展是否可用，
  由 :func:`ensure_vec_table` 每次幂等检查，缺扩展时普通表照样能建（检索走 numpy 兜底）。

★ ``chunk_vec`` 的维度取自 ``app.config.EMBEDDING_DIM``（**唯一常量来源**）。
升级 ``bge-base-zh-v1.5``（768 维）时这里会自动发现「库里的 vec0 还是 512 维」并明确报错，
而不是让 KNN 静默算错。
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass
from typing import Callable, Sequence

logger = logging.getLogger(__name__)

KB = "kb"
LEARNING = "learning"

_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS schema_version (
  set_name   TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (set_name, version)
)
"""


@dataclass(frozen=True)
class Migration:
    """一条迁移。``apply`` 里可以写多条 SQL，也可以写 Python（例如补数据）。"""

    version: int
    name: str
    apply: Callable[[sqlite3.Connection], None]
    # 标记该迁移依赖 sqlite-vec（扩展缺失时跳过而不是让整库建不出来）
    needs_vec: bool = False


# --------------------------------------------------------------------------- #
# kb.sqlite（全局只读：教材 chunk / 向量 / 依赖图）
# --------------------------------------------------------------------------- #
_KB_V1 = """
-- 知识点（依赖图与画像都按 kp_id 对齐）
CREATE TABLE IF NOT EXISTS kp (
  kp_id         TEXT PRIMARY KEY,
  grade_level   TEXT NOT NULL,
  chapter_title TEXT,
  section_title TEXT,
  name          TEXT NOT NULL,
  summary       TEXT
);

-- ★ chunk 元数据 schema 固定（执行文档 §8.3），不要随手加删字段：
--   chunk_id, text, embedding, grade_level, chapter_title, section_title,
--   knowledge_point, content_type, parent_chunk_id, token_count
CREATE TABLE IF NOT EXISTS chunk (
  rowid           INTEGER PRIMARY KEY,          -- ★ 隐式 rowid，chunk_vec 的 rowid 必须与它一致
  chunk_id        TEXT NOT NULL UNIQUE,
  parent_chunk_id TEXT,                          -- 父块：命中子块后取父块作上下文
  text            TEXT NOT NULL,
  embedding       BLOB,                          -- Float32 小端（'<f4'），numpy 兜底要读它
  grade_level     TEXT NOT NULL,
  chapter_title   TEXT,
  section_title   TEXT,
  knowledge_point TEXT,                          -- 存 kp_id（机器可用）；人类可读名走 kp.name
  content_type    TEXT,
  token_count     INTEGER,
  is_parent       INTEGER NOT NULL DEFAULT 0     -- 1=节级块（注入上下文用）；0=检索用子块
);
CREATE INDEX IF NOT EXISTS idx_chunk_grade   ON chunk(grade_level);
CREATE INDEX IF NOT EXISTS idx_chunk_parent  ON chunk(parent_chunk_id);
CREATE INDEX IF NOT EXISTS idx_chunk_kp      ON chunk(knowledge_point);

-- 依赖图（邻接表）：from = 前置，to = 后继
CREATE TABLE IF NOT EXISTS knowledge_dependencies (
  from_kp_id TEXT NOT NULL REFERENCES kp(kp_id),
  to_kp_id   TEXT NOT NULL REFERENCES kp(kp_id),
  relation   TEXT NOT NULL,                      -- prerequisite | related
  weight     REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (from_kp_id, to_kp_id)
);
CREATE INDEX IF NOT EXISTS idx_deps_from ON knowledge_dependencies(from_kp_id);
CREATE INDEX IF NOT EXISTS idx_deps_to   ON knowledge_dependencies(to_kp_id);
"""

# ★ FTS5 必须 trigram：默认分词器把整段中文当一个 token，等于不可检索。
#   content='chunk' 是**外部内容表**：正文只存一份，重建用 'rebuild' 指令。
_KB_FTS = """
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  text,
  content='chunk',
  content_rowid='rowid',
  tokenize='trigram'
);
"""


def _apply_kb_v1(conn: sqlite3.Connection) -> None:
    conn.executescript(_KB_V1)
    conn.executescript(_KB_FTS)


# --------------------------------------------------------------------------- #
# learning.db（每人一份：画像 / 掌握度 / 学习历史 / 进度 / 学段信号）
# --------------------------------------------------------------------------- #
_LEARNING_V1 = """
CREATE TABLE IF NOT EXISTS student (
  student_id     TEXT PRIMARY KEY,
  nickname       TEXT,
  grade_level    TEXT NOT NULL,
  created_at     INTEGER,
  last_active_at INTEGER
);

CREATE TABLE IF NOT EXISTS mastery (
  kp_id        TEXT PRIMARY KEY,
  score        REAL NOT NULL DEFAULT 0,          -- 0..1
  attempts     INTEGER NOT NULL DEFAULT 0,
  correct      INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS learning_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER,
  session_id TEXT,                                -- ★ 关联 Pi JSONL 会话，不存对话正文
  kp_id      TEXT,
  activity   TEXT,                                -- qa | animation | coding | quiz
  question   TEXT,
  is_correct INTEGER,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_kp ON learning_history(kp_id);

CREATE TABLE IF NOT EXISTS progress (
  kp_id      TEXT PRIMARY KEY,
  stage      TEXT,                                -- locked | learning | quizzed | mastered
  badge      TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS profile_pref (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 学段变化轨迹（教育适配性 + 家长报告）
CREATE TABLE IF NOT EXISTS grade_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER,
  turn       INTEGER,
  from_level TEXT,
  to_level   TEXT,
  source     TEXT,                                -- explicit | inferred | confirmed
  confidence REAL
);

-- 学段信号缓冲区（自动推断用；只写建议，不直接改学段）
CREATE TABLE IF NOT EXISTS grade_signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER,
  session_id  TEXT,
  signal_type TEXT,                               -- vocab | depth | quiz_perf | meta_cognition
  value       REAL,
  raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_session ON grade_signals(session_id);
"""


def _apply_learning_v1(conn: sqlite3.Connection) -> None:
    conn.executescript(_LEARNING_V1)
def _apply_chapter_v2(conn: sqlite3.Connection) -> None:
    """v2：给 ``student`` 补 ``current_chapter`` 列（学生当前在学的教材章节）。
    ⚠️ 这里**只加列、不填默认值**：``NULL`` 就是「未选择章节」，
      读写原语（``LearningStore.current_chapter`` / ``set_current_chapter``）把
    if "current_chapter" not in columns:
        conn.execute("ALTER TABLE student ADD COLUMN current_chapter TEXT")


KB_MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="kb 核心表 + FTS5(trigram)", apply=_apply_kb_v1),
    # 后续新增教材相关表在此追加（version 递增），不要改已发布的那条
)

LEARNING_MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="学生画像 / 掌握度 / 学习历史 / 进度 / 学段信号", apply=_apply_learning_v1),
    Migration(version=2, name="学生当前教材章节列（current_chapter）", apply=_apply_chapter_v2),
)


# --------------------------------------------------------------------------- #
# 迁移执行
# --------------------------------------------------------------------------- #
def applied_versions(conn: sqlite3.Connection, set_name: str) -> dict[int, str]:
    conn.executescript(_TABLE_DDL)  # 幂等：第一次调用时建表
    rows = conn.execute(
        "SELECT version, name FROM schema_version WHERE set_name = ? ORDER BY version",
        (set_name,),
    ).fetchall()
    return {int(r["version"]): str(r["name"]) for r in rows}


def current_version(conn: sqlite3.Connection, set_name: str) -> int:
    versions = applied_versions(conn, set_name)
    return max(versions) if versions else 0


def ensure_migrated(
    conn: sqlite3.Connection,
    migrations: Sequence[Migration],
    *,
    set_name: str,
    vec_ready: bool = False,
) -> int:
    """把 ``migrations`` 里尚未应用的条目按版本顺序执行，返回应用后的版本号。

    **幂等**：重复调用只会跳过已记账的版本。缺 ``sqlite-vec`` 时跳过 ``needs_vec``
    的条目（不记账），等扩展可用了再补 —— 否则扩展缺失会连普通表都建不出来。
    """
    applied = applied_versions(conn, set_name)
    for mig in sorted(migrations, key=lambda m: m.version):
        if mig.version in applied:
            continue
        if mig.needs_vec and not vec_ready:
            logger.warning(
                "迁移 %s#%d(%s) 依赖 sqlite-vec，本次跳过（扩展可用时会补建）",
                set_name,
                mig.version,
                mig.name,
            )
            continue
        with conn:  # 事务：失败整体回滚，版本号不前进
            mig.apply(conn)
            conn.execute(
                "INSERT INTO schema_version(set_name, version, name, applied_at) VALUES(?,?,?,?)",
                (set_name, mig.version, mig.name, int(time.time())),
            )
        logger.info("已应用迁移 %s#%d %s", set_name, mig.version, mig.name)
    return current_version(conn, set_name)


def ensure_vec_table(conn: sqlite3.Connection, *, dim: int) -> bool:
    """幂等建立 ``chunk_vec``（vec0），返回是否就位。

    ★ **带 ``grade_level`` 元数据列**是有意的（相对执行文档 §8.3 的 DDL 多一列）：
    vec0 的 KNN 查询 ``WHERE embedding MATCH ? AND k = ?`` 会**先**按距离截断 top-k，
    再套其他条件 —— 若把学段过滤写成与 ``chunk`` 的 JOIN 条件，初中生问高中名词时
    top-k 里全被高中块占满，过滤后**剩下 0 条**（业务陷阱清单 §2 第 5 条「学段泄漏」）。
    声明为 vec0 的元数据列后，``AND grade_level = ?`` 由 vec0 在 KNN 内部执行，
    是**精确**的「先过滤再取 top-k」。

    ★ 维度来自调用方传入的 ``config.EMBEDDING_DIM``；库里维度不符时**明确报错**，
    提示「改维度必须重建索引」。
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunk_vec'"
    ).fetchone()
    if row is not None:
        ddl = str(row["sql"] or "")
        if f"float[{dim}]" not in ddl:
            raise RuntimeError(
                f"kb.sqlite 的 chunk_vec 维度与当前 EMBEDDING_DIM={dim} 不符（{ddl}）。"
                "升级嵌入模型后必须重建索引：uv run python scripts/build_kb.py"
            )
        return True
    try:
        conn.execute(
            f"CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[{dim}], grade_level TEXT)"
        )
    except sqlite3.Error as exc:
        logger.warning("chunk_vec 建表失败（sqlite-vec 不可用？）：%s", exc)
        return False
    return True


def ensure_kb(conn: sqlite3.Connection, *, dim: int, vec_ready: bool) -> None:
    """``kb.sqlite`` 的完整就绪流程：普通表 → 迁移 → vec0 表。"""
    ensure_migrated(conn, KB_MIGRATIONS, set_name=KB, vec_ready=vec_ready)
    if vec_ready:
        ensure_vec_table(conn, dim=dim)


def ensure_learning(conn: sqlite3.Connection) -> int:
    """``learning.db`` 就绪流程（一人一库，同一套迁移器）。"""
    return ensure_migrated(conn, LEARNING_MIGRATIONS, set_name=LEARNING)
