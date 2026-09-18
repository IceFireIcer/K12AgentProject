"""``schema_version`` + 幂等迁移器（**不用 Alembic**）。

为什么不上 Alembic：本地 SQLite、一人一库（``learning.db``）、随包分发，
没有多人协作的 schema 演进需求；引入迁移框架只会多一层依赖与一个必须在打包态跑通的东西。
这里只要保证两件事：**能建出来** 与 **重复跑不炸**（执行文档 §8.3、票 10）。

设计
----
- 迁移以 ``(set_name, version)`` 记账。**set_name 是给其他轨道留的并行通道**：
  票 14（题库）需要新表时，自己带一组 ``Migration`` 用 ``set_name="quiz"`` 调
  :func:`ensure_migrated` 即可，不必改本文件、也不会和 ``kb`` 的版本号打架。
- 每条迁移在**一个具名 SAVEPOINT** 里执行并当场记账；任一步失败 → 整体回滚、版本号不前进
  （这条是**真**保证，见下面那条纪律 + :func:`ensure_migrated` 的注释）。
- ★★ **迁移里不许用 ``conn.executescript``**：它会**先隐式 COMMIT**
  （``sqlite3`` 的既有行为，与有没有开事务无关），脚本中途报错时前面那些语句
  已经落盘 —— 库变成「半应用、且 ``schema_version`` 里没有记录」的中间状态，
  比直接报错难查得多。多条 SQL 请用 :func:`execute_script`（逐条 ``conn.execute``）。
- ``chunk_vec``（vec0 虚拟表）**不进版本表**：它依赖 ``sqlite-vec`` 扩展是否可用，
  由 :func:`ensure_vec_table` 每次幂等检查，缺扩展时普通表照样能建（检索走 numpy 兜底）。

★ ``chunk_vec`` 的维度取自 ``app.config.EMBEDDING_DIM``（**唯一常量来源**）。
升级 ``bge-base-zh-v1.5``（768 维）时这里会自动发现「库里的 vec0 还是 512 维」并明确报错，
而不是让 KNN 静默算错。

> 连接上的 ``PRAGMA foreign_keys = ON`` 由 ``store/connections.py`` 的 :func:`connect` 统一设置，
> 本文件的 DDL 才真的具备「悬空 kp_id 会被拒绝」的能力。因此**清表顺序**必须
> 先 ``knowledge_dependencies`` 后 ``kp``（见 ``store/kb.py``）。
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


def split_sql_statements(script: str) -> list[str]:
    """把一段 SQL 脚本切成**单条**语句（顶层分号切分，注释与引号内不切）。

    ★ 为什么不用 ``sqlite3.complete_statement`` 逐行累加：它只回答「缓冲区此刻是否是
    一条完整语句」，而**把两条语句放在同一行**（``CREATE TABLE a(x); CREATE INDEX i ON a(x);``）
    时整行都算「完整」，于是两条被一起交给 ``conn.execute`` →
    ``ProgrammingError: You can only execute one statement at a time``。
    逐字符扫描没有这个盲区，且不依赖书写风格。

    识别并跳过：普通字符串 ``'...'``（``''`` 转义）、引号标识符 ``"..."``、
    反引号与方括号标识符、行注释 ``--``、块注释 ``/* ... */``；
    —— 这些都允许出现分号或成对引号，不能被当成语句边界。
    """
    statements: list[str] = []
    buffer: list[str] = []
    index = 0
    length = len(script)
    while index < length:
        char = script[index]
        pair = script[index : index + 2]

        if pair == "--":  # 行注释：跳到行尾（换行留给 buffer，不影响语义）
            end = script.find("\n", index)
            index = length if end == -1 else end
            continue
        if pair == "/*":  # 块注释：跳到配对的 */（未闭合就吃到结尾）
            end = script.find("*/", index + 2)
            index = length if end == -1 else end + 2
            continue
        if char in ("'", '"', "`"):
            closing = char
            buffer.append(char)
            index += 1
            while index < length:
                if script[index] == closing:
                    if index + 1 < length and script[index + 1] == closing:  # 转义：连写两个
                        buffer.append(closing * 2)
                        index += 2
                        continue
                    break
                buffer.append(script[index])
                index += 1
            if index < length:  # 收尾的引号
                buffer.append(script[index])
                index += 1
            continue
        if char == "[":  # 方括号标识符：内部不认转义，遇到 ] 即结束
            end = script.find("]", index)
            end = length if end == -1 else end + 1
            buffer.append(script[index:end])
            index = end
            continue
        if char == ";":
            statements.append("".join(buffer))
            buffer = []
            index += 1
            continue
        buffer.append(char)
        index += 1

    statements.append("".join(buffer))
    return [s for s in (statement.strip() for statement in statements) if s]


def execute_script(conn: sqlite3.Connection, script: str) -> None:
    """把一段多语句 DDL **逐条** ``conn.execute`` 执行（替代 ``conn.executescript``）。

    ★ 为什么不用 ``conn.executescript``：它会在执行前**隐式 COMMIT**，
    于是「失败整体回滚」在含 DDL 的迁移上直接失效（实测：``BEGIN`` → 建表 →
    报错 → ``ROLLBACK`` 之后表还在）。本函数不做隐式提交，
    只把语句一条条交给连接，事务边界完全由调用方（:func:`ensure_migrated`）掌握。
    """
    for statement in split_sql_statements(script):
        conn.execute(statement)


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
    # 建表顺序 = 被引用方（kp）在前、引用方（knowledge_dependencies）在后：
    # conn 上的 ``foreign_keys=ON``（见 connections.connect）要求被引用的表已存在。
    execute_script(conn, _KB_V1)
    execute_script(conn, _KB_FTS)


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

-- 学段信号缓冲区（自动推断的原料；本表只落信号，判定与写学段在 app/grade/rules.py）
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
    execute_script(conn, _LEARNING_V1)


def _apply_chapter_v2(conn: sqlite3.Connection) -> None:
    """v2：给 ``student`` 补 ``current_chapter`` 列（学生当前在学的教材章节）。

    ★ **幂等 ALTER**（模板 = ``store/learning.py`` 的 ``_apply_quiz_v2``）：
      先 ``PRAGMA table_info`` 看列在不在，再 ``ALTER TABLE ... ADD COLUMN``。
      SQLite 的 ``ADD COLUMN`` **没有** ``IF NOT EXISTS``，直接写会在重复执行时
      报 ``duplicate column name``；而迁移器虽然按 ``schema_version`` 记账跳过了，
      但**已建过 v1 的库**（v1 已记账、v2 还没）必须靠这条补列。

    ★ **不改 v1**（本模块的纪律：不要改已发布的那条）：v1 是「新学生建表」的基线，
      老学生走 v2 补列 —— 两条一起跑出新库，老库只跑 v2，结果一致。

    ⚠️ 这里**只加列、不填默认值**：``NULL`` 就是「未选择章节」，
      读写原语（``LearningStore.current_chapter`` / ``set_current_chapter``）把
      ``NULL`` 与空串统一成 ``""`` —— 不要在迁移里写 ``''``，那会引入第二种「空」。
    """
    columns = {
        str(row["name"]) for row in conn.execute("PRAGMA table_info(student)").fetchall()
    }
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
    # ``execute`` 而不是 ``executescript``：单条 DDL 不需要脚本语义，
    # 而且 executescript 的隐式提交会把调用方开的事务边界冲掉。
    conn.execute(_TABLE_DDL)
    rows = conn.execute(
        "SELECT version, name FROM schema_version WHERE set_name = ? ORDER BY version",
        (set_name,),
    ).fetchall()
    return {int(r["version"]): str(r["name"]) for r in rows}


def current_version(conn: sqlite3.Connection, set_name: str) -> int:
    versions = applied_versions(conn, set_name)
    return max(versions) if versions else 0


#: 每条迁移的事务用**具名 SAVEPOINT**包起来（见 :func:`ensure_migrated` 的注释）。
_MIGRATION_SAVEPOINT = "k12_migration"


def _rollback_migration(conn: sqlite3.Connection, savepoint: str) -> None:
    """把连接回退到迁移前的状态（**失败路径专用**）。

    先 ``ROLLBACK TO``（回到保存点）再 ``RELEASE``（撤掉保存点本身）：
    单独 ``ROLLBACK TO`` 会把保存点留在栈上，下一次同名 ``SAVEPOINT`` 就变成叠加。
    某些错误（磁盘满 / 被中断）会让 SQLite 直接回滚整个事务，那时保存点已不存在，
    ``ROLLBACK TO`` 会抛 —— 此时退回整连接 ``rollback()``，绝不让原异常被盖掉。
    """
    try:
        conn.execute(f'ROLLBACK TO "{savepoint}"')
        conn.execute(f'RELEASE "{savepoint}"')
    except sqlite3.Error:
        conn.rollback()


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

    ★ 事务用**具名 SAVEPOINT**（不是 ``with conn:``，也不是裸 ``BEGIN``）：

    - ``with conn:`` 只在「已经在事务里」时才真的开事务（DDL 走的是自动提交），
      于是「迁移中途报错 → 整体回滚」既可能不成立、也说不清；
    - 裸 ``BEGIN`` 遇到「调用方已经在自己的写事务里」会直接抛
      ``cannot start a transaction within a transaction`` —— 迁移是**别人可能顺手调用**
      的基础设施（``ensure_quiz_tables`` 就是），这种硬崩不该由调用方去猜；
    - ``SAVEPOINT`` 两种情形都对：不在事务里时它自己开一个、``RELEASE`` 即提交；
      已在事务里时只回退到自己这一段，**不动调用方的事务边界**。

    （前提：``mig.apply`` 内部不得 ``executescript`` —— 见模块头那条纪律。）

    ★★ **并发首次迁移**（2026-09-18 实测事故，见 P-063）：本函数**必须**容忍
    「另一个连接抢先跑完了同一条迁移」。这不是理论问题 —— 一人一库的打开方式是
    **每次请求现开现关**（``routes/students.py`` 的 ``open_learning_store``），
    所以两个并发请求（例如界面挂载时几乎同时发出的两条读请求）就是两个连接、
    两条连接同时看到「v2 还没应用」。竞争的结果是一条赢、一条炸，且炸的那条
    **不是**因为等得不够久：

      WAL 下，迁移通常先读后写（``PRAGMA table_info`` 判列 → ``ALTER``）。
      读那一步就把连接推进了一个**读快照**；等它要升级为写事务时，赢家已经提交过，
      SQLite 只能返回 ``SQLITE_BUSY_SNAPSHOT`` —— **这种失败不走 busy_timeout**，
      等多久都没用，直接抛 ``database is locked``。加 ``busy_timeout`` 治不了它。

    这里对 ``sqlite3.Error`` 的处置是**看账本、不看错误文本**：回滚本段之后重新读一次
    ``schema_version``，只要这一版**已经在账上**，就说明迁移的目标状态已经达成
    （赢家连列带记账一起提交了），按已应用处理；账上没有才是真故障，照旧抛出。

    ★ 但**光靠事后查账本还不够**：查的时候赢家可能还没提交。所以真正的解法是
    **先拿写锁、再读账本**（见下面的 ``BEGIN IMMEDIATE``）—— 拿到锁意味着此刻只有
    本连接能写，另一个连接要么已经提交（账本上看得见）、要么还在等锁（抢不到就跑不到
    我们前面）。这样「两条连接同时首迁」被**确定性**地串行化，而不是靠重试碰运气。
    """
    applied = applied_versions(conn, set_name)
    # ★ 只在**确实有未应用条目**时才去抢写锁：绝大多数调用（每次开库）都是「已是最新」，
    #   让它们连读锁都不用升级，保持「开库」这条热路径零额外开销。
    owns_transaction = False
    if not conn.in_transaction and any(mig.version not in applied for mig in migrations):
        conn.execute("BEGIN IMMEDIATE")
        owns_transaction = True
        applied = applied_versions(conn, set_name)  # 拿到写锁后重读：等锁期间别人的提交现在看得见
    try:
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
            conn.execute(f'SAVEPOINT "{_MIGRATION_SAVEPOINT}"')
            try:
                mig.apply(conn)
                conn.execute(
                    "INSERT INTO schema_version(set_name, version, name, applied_at) VALUES(?,?,?,?)",
                    (set_name, mig.version, mig.name, int(time.time())),
                )
            except sqlite3.Error as exc:
                # ★ 防御性分支（正常情况下到不了）：判据是**账本**，不是错误文本 ——
                #   「另一个连接刚把这一版跑完」时本连接必然拿到 database is locked，
                #   而迁移的目标状态其实已经达成。
                _rollback_migration(conn, _MIGRATION_SAVEPOINT)
                if mig.version in applied_versions(conn, set_name):
                    logger.info(
                        "迁移 %s#%d(%s) 已由另一个连接应用，本连接跳过（%s）",
                        set_name,
                        mig.version,
                        mig.name,
                        exc,
                    )
                    continue
                raise
            except BaseException:
                _rollback_migration(conn, _MIGRATION_SAVEPOINT)
                raise
            conn.execute(f'RELEASE "{_MIGRATION_SAVEPOINT}"')
            logger.info("已应用迁移 %s#%d %s", set_name, mig.version, mig.name)
        version = current_version(conn, set_name)
        if owns_transaction:
            conn.commit()
            owns_transaction = False
        return version
    finally:
        # 异常路径：本函数开的写事务必须自己收掉，否则写锁会一直握在手里
        # （`BEGIN IMMEDIATE` 抢来的锁不会因为异常自动释放，下一个请求就会卡到 busy_timeout）。
        if owns_transaction:
            conn.rollback()


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
