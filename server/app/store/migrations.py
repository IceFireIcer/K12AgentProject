"""``schema_version`` + 幂等迁移器（**不用 Alembic**）。

为什么不上 Alembic：本地 SQLite、一人一库（``learning.db``）、随包分发，
没有多人协作的 schema 演进需求；引入迁移框架只会多一层依赖与一个必须在打包态跑通的东西。
这里只要保证两件事：**能建出来** 与 **重复跑不炸**（执行文档 §8.3、票 10）。

设计
----
- 迁移以 ``(set_name, version)`` 记账。**set_name 是给其他轨道留的并行通道**：
  票 14（题库）需要新表时，自己带一组 ``Migration`` 用 ``set_name="quiz"`` 调
  :func:`ensure_migrated` 即可，不必改本文件、也不会和 ``kb`` 的版本号打架。
  已有的并行通道：``quiz``（变式题仓库）与 ``animation``（学生动画库），
  两组的 DDL 与 ``Migration`` 都写在 ``store/learning.py`` 里（**本文件只提供机制**）。
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
  session_id TEXT,                                -- ★ 关联 Pi JSONL 会话；本表不存对话正文，
                                                  --   唯一例外见 onboarding_qa（迁移 v5）
  kp_id      TEXT,
  activity   TEXT,                                -- qa | animation | coding | quiz
  question   TEXT,                                -- ★ 恒为空串（G-K）：五问回答走 onboarding_qa
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


def _apply_grade_signal_mark_v3(conn: sqlite3.Connection) -> None:
    """v3：给 ``grade_history`` 补 ``signal_mark`` 列（这一行是**信号序列里的第几位**）。

    ★ **为什么需要它（实测缺陷，不是预防性设计）**：冷却原先算
      ``elapsed = turn - anchor_turn``，而 ``turn`` 是**每会话**计数器
      （桌面端换一个会话就从 1 重来），``anchor_turn`` 却是上一会话写进库里、长期保留的号 ——
      **两个数来自不同的轮次空间**，相减没有意义：新会话里 ``turn`` 常小于 ``anchor_turn``，
      ``max(0, …)`` 把它钳成 0，``remaining`` 于是**恒等于整个窗口**，
      每次判定都报 ``cooldown`` —— 那把锁**永不释放**。

      实测（``logs/sidecar.log`` 5 天）：450 次判定里 ``reason=cooldown`` **226 次（50%）**，
      其中 ``连续=4 / 置信度 0.90`` 的**达标证据**照样不生效；锚点 ``turn=22``（手动设定）
      让随后每个会话的第 1–8 轮全部卡死 —— 唯一出路是**在同一个会话里聊到第 23 轮**
      （实测会话上限 8 轮）。

    ★ **修法是换一个单调的量**：不改「轮次」这个概念，而是记下锚点写下去时
      **``grade_signals`` 的最大 id**。``id`` 是 AUTOINCREMENT，全局单调、跨会话连续，
      而且每个轮次至少写一行（M-10 的占位读数）—— 于是
      「锚点之后又过了几轮」= 「id 大于这个 mark 的轮次桶数」，**不需要跨会话相减**。
      这样「调整后 5 轮 / 手动后 10 轮」仍然是**字面成立的真实轮数**，
      既解掉活锁，也不把冷却缩成 0。

    ★ 与 ``_apply_chapter_v2`` 同一模板（**幂等 ALTER**）：先 ``PRAGMA table_info`` 看列在不在。
      SQLite 的 ``ADD COLUMN`` 没有 ``IF NOT EXISTS``，直接写会在重复执行时报
      ``duplicate column name``；已建过 v1/v2 的库必须靠这条补列。

    ★ **不改 v1**（本模块的纪律：不要改已发布的那条）：v1 是「新学生建表」的基线，
      老学生走 v3 补列 —— 两条一起跑出新库，老库只跑 v3，结果一致。

    ⚠️ **只加列、不填默认值**：历史行的 ``NULL`` 表示「不知道它在信号序列里的位置」，
      由 ``_cooldown_remaining`` 走**保守兜底**（沿用旧的钳位算法，绝不拉长、绝不崩）。
      不要在这里回填任何猜测值 —— 那个位置已经不可考了。
    """
    columns = {
        str(row["name"]) for row in conn.execute("PRAGMA table_info(grade_history)").fetchall()
    }
    if "signal_mark" not in columns:
        conn.execute("ALTER TABLE grade_history ADD COLUMN signal_mark INTEGER")


def _apply_grade_decided_by_v4(conn: sqlite3.Connection) -> None:
    """v4：给 ``grade_history`` 补 ``decided_by`` 列（当前学段是**哪一层**产出的）。

    ★ 为什么要这一列（D-066，2026-09-21；用户裁决）：学段的**决策权**从规则引擎
      移交给了 LLM —— 前 4 个累计轮次只由规则判（标签「本地规则判定」），
      第 5 个累计轮次起由 LLM 判（标签「AI 引擎判定」），LLM 不可用时规则照常接管。

      界面标签必须**如实**反映「这一档是哪层说的」：
      - 修复前只有 ``source``（inferred / explicit），于是
        「发一句『你好』就被标成 AI 引擎推算·小学高年级」—— 那是**冷启动默认值**，
        一次推断都没发生过，标签却在替 AI 认领。这是用户点名要修的「过于粗暴」。
      - 现在 ``decided_by`` 回答「**哪一层判的**」，与 ``source``（「谁写的」）是两个轴；
        都取不到（冷启动基线行）→ 界面显示「待判定」。

    ★ 与 ``_apply_chapter_v2`` / v3 同一模板（**幂等 ALTER**）：先 ``PRAGMA table_info``
      看列在不在。SQLite 的 ``ADD COLUMN`` 没有 ``IF NOT EXISTS``，直接写会在重复执行时
      报 ``duplicate column name``；已建过 v1~v3 的库必须靠这条补列。

    ★ **不改已发布的版本**（本模块的纪律）：老库只跑 v4，新库 v1~v4 一起跑，结果一致。

    ⚠️ **只加列、不填默认值**：历史行的 ``NULL`` 表示「那一行没有这个概念」，
      读取端把 ``NULL`` 折算成「按 ``source`` 显示」—— 不要在这里回填猜测值
      （把旧行猜成 ``rules`` 看似合理，实则是在替过去的数据编造出处）。
    """
    columns = {
        str(row["name"]) for row in conn.execute("PRAGMA table_info(grade_history)").fetchall()
    }
    if "decided_by" not in columns:
        conn.execute("ALTER TABLE grade_history ADD COLUMN decided_by TEXT")


# --------------------------------------------------------------------------- #
# ★ 对话式冷启动画像（迁移 v5）：白名单真源的 Python 镜像 + 两张物理隔离的表
# --------------------------------------------------------------------------- #

#: ★★ 模型可见标签的**白名单**（执行报告 §0.6.2 / §0.6.3）。
#:
#: 真源是 `desktop/src/shared/profile-tags.ts` 的 `LLM_VISIBLE_TAGS`；这里是它在
#: Python 侧的**逐字镜像**，两边一致由 `tests/test_profile_tags.py` 断言
#: （那条测试既写死这份清单，又直接解析 TS 源文件逐字比对）。
#:
#: 为什么后端也要有一份：**所有写入原语都要过它**（G-A），而 store 层不依赖 TS ——
#: 只改一边（比如前端顺手加个 `parent_income`）会立刻红，而不是等脏键进了库才发现。
#: ⚠️ `parent_consent` / `memory_switch` **不在**白名单里：它们是闸，不是信息。
ALLOWED_TAG_KEYS: tuple[str, ...] = (
    "anon_student_id",
    # 维度 2：学段与课程
    "grade_band",
    "subject",
    "course_module",
    "current_topic",
    # 维度 3：AI 通识知识掌握
    "knowledge_point",
    "mastery",
    # 维度 4：错误模式与最近发展区
    "error_type",
    "zpd_level",
    # 维度 7：学习偏好
    "explain_style",
    "output_length",
    "pace",
    "practice_type",
    # 维度 8：兴趣类比
    "interest_topic",
    # 维度 9：短期情绪与动机
    "emotion",
    "intensity",
    "trigger",
    "confidence",
    # 维度 10：交互偏好
    "tone",
    "encouragement_freq",
    "challenge_level",
    # 维度 11：场景与目标
    "scene",
    "task_goal",
    # 维度 12：安全边界与反馈
    "safety_level",
    "boundary_topics",
    # 维度 13：学习类型与性格（2026-09-30 新增；这一节的加键伴随一次
    #   禁做红线的**最小移动**，见 learning.py 的 LEARNER_STYLE_VALUES 注释）
    "learner_style",
    "personality",
)

#: 运行期集合形态（写原语与出栈过滤用这个，别再 includes 一遍）。
ALLOWED_TAG_KEY_SET: frozenset[str] = frozenset(ALLOWED_TAG_KEYS)

#: `identity_local` 的列（与 TS 的 `IDENTITY_LOCAL_FIELDS` 同形）。
#: ★ **除 :data:`JOIN_KEY` 外，这些列一个都不在白名单里**（G-B）——
#:   两张表的唯一交集就是那把 join 钥匙（口径裁决见 TS 文件头的 G-B 修正）。
IDENTITY_LOCAL_FIELDS: tuple[str, ...] = (
    "anon_student_id",
    "real_name",
    "real_grade",
    "school",
    "class",
    "parent_consent",
    "memory_switch",
    "onboarding_state",
)

#: 两表唯一共有的 join 钥匙（随机串，模型看到它也还原不出任何真人）。
JOIN_KEY = "anon_student_id"


#: 迁移 v5 的 DDL。三段各自的「为什么」：
#:
#: ① `identity_local` = 本地身份层，**永不过桥**（代码里没有「读它再拼 prompt」的路径）。
#:    两道闸默认 1 —— 本轮裁决 = 选项 B「默认同意，家长可在设置页关」。
#:    默认值不是隐私边界本身：边界由「关掉立刻生效的两道闸 + 白名单」兜住。
#: ② `profile_tags` = 只有白名单字段可能出现的标签层，主键 (学生, key)。
#:    `turn_mark` = 写入时 `grade_signals` 的最大 id（单调、跨会话连续）—— TTL 的
#:    「3 轮」那一半靠它算。报告 §0.6.5 的伪代码只写了 `ts`，表达不了轮次；
#:    不加这一列则「3 轮或 24 小时，取先到」只能实现一半（24 小时）。`NULL` = 只有时钟口径。
#: ③ `onboarding_qa` = 冷启动五问的原始回答，是「SQLite 不存对话正文」这条不变量里
#:    **唯一被推翻的一处**（作用域只到这 5 条，见 `learning_history` 的 DDL 注释）。
#:    `question_id` 上的 UNIQUE 保证一问一答：重答是**覆盖**不是追加。
_IDENTITY_PROFILE_V5 = """
CREATE TABLE IF NOT EXISTS identity_local (
  anon_student_id  TEXT PRIMARY KEY,
  real_name        TEXT,
  real_grade       TEXT,
  school           TEXT,
  class            TEXT,
  parent_consent   INTEGER NOT NULL DEFAULT 1,
  memory_switch    INTEGER NOT NULL DEFAULT 1,
  onboarding_state TEXT NOT NULL DEFAULT 'not_started'
);

CREATE TABLE IF NOT EXISTS profile_tags (
  anon_student_id TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT,
  confidence      REAL,
  source          TEXT,
  ts              INTEGER,
  turn_mark       INTEGER,
  PRIMARY KEY (anon_student_id, key)
);
CREATE INDEX IF NOT EXISTS idx_tags_key ON profile_tags(key);

CREATE TABLE IF NOT EXISTS onboarding_qa (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER,
  session_id    TEXT,
  question_id   TEXT,
  question_text TEXT,
  answer_text   TEXT,
  answered_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_q ON onboarding_qa(question_id);
"""


def _apply_identity_profile_v5(conn: sqlite3.Connection) -> None:
    """v5：冷启动画像地基（`identity_local` / `profile_tags` / `onboarding_qa`）。

    ★ 只**新建**三张表，不动任何既有表/列 —— 老库与新库跑完 v5 的结果一致。
      为什么不用 `set_name="profile"` 那条并行通道：这三张表是**画像主轨**的一部分
      （票 25 的验收就是 `learning` 组到 v5），而 quiz/animation/code 那几条通道
      开给的是「只有真用到才建表」的功能性附属表。
    ★ 用 `execute_script`（逐条 `conn.execute`）而不是 `conn.executescript`：
      后者会**隐式提交**，让「失败整体回滚」失效（见本文件模块头那条纪律）。
    """
    execute_script(conn, _IDENTITY_PROFILE_V5)


# --------------------------------------------------------------------------- #
# v6：画像标签的**变更时间线**（§5.2 #11）
# --------------------------------------------------------------------------- #
#
# ★★ 为什么必须新开一张表：profile_tags 的主键是 (anon_student_id, key) ——
#    它是**当前值**的快照，同一时刻一个键只有一行。所以「画像怎么变成现在这样的」
#    这个问题在旧结构里**根本无法回答**（没有历史）。时间线要么另存一份序列，
#    要么就得承认做不了。
#
# ★★★ 两条硬约束（写错任何一条都会毁掉既有红线）：
#
#   ① **短期情绪标签绝不进这张表**。emotion / intensity / trigger 在读取侧有 TTL
#      （3 轮或 24 小时，§0.6.5），TTL 存在的**全部意义**就是不让「上次考崩了、情绪低落」
#      被长期记着（禁做清单第 11 条「长期负面情绪档案」）。
#      如果历史表把它们记下来，读取侧的 TTL 就**完全被架空了** ——
#      当前值过期了，但历史里一行不少，「长期档案」照样成立，而且是**更隐蔽的**成立
#      （主表看不见，翻历史才看得见）。所以这张表的写入侧**必须**排除它们，
#      见 LearningStore._append_tag_history 的显式判断。
#
#   ② **键必须仍在白名单里**（G-A）。历史是「过去的值」，但**不是**「过去的身份」——
#      真名 / 精确年级 / 学校 / 班级任何时候都不许出现在这里，与主表同一条纪律。
#
# ⚠️ 这张表是 **append-only**：只插不改不删（学生撤销一个标签时，历史里留下的正是
#    「他撤销过」这件事，抹掉它反而是丢信息）。

_PROFILE_HISTORY_V6 = """
CREATE TABLE IF NOT EXISTS profile_tag_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER,                -- 变更时间（Unix 秒，与本模块其它 ts 同单位）
  anon_student_id TEXT NOT NULL,
  key             TEXT NOT NULL,          -- 必须 ∈ ALLOWED_TAG_KEYS，且**不含**短期情绪标签
  value           TEXT,                   -- 变更**后**的值
  previous_value  TEXT,                   -- 变更**前**的值（NULL = 这个键第一次出现）
  source          TEXT,                   -- declared | observed | inferred
  confidence      REAL
);
CREATE INDEX IF NOT EXISTS idx_tag_history_student ON profile_tag_history(anon_student_id, ts);
"""


def _apply_profile_history_v6(conn: sqlite3.Connection) -> None:
    """v6：画像标签的变更时间线（§5.2 #11）。

    ★ **不改已发布的 v1~v5**（本模块的纪律）：老库只跑 v6，新库 v1~v6 一起跑，结果一致。
    ★ 表是 append-only，没有回填 —— **历史无法追溯**：这张表从 v6 这一刻开始记，
      在此之前发生过的变更（如果有）已经不可考，回填任何猜测值都是在替过去编造。
    """
    execute_script(conn, _PROFILE_HISTORY_V6)


# --------------------------------------------------------------------------- #
# v7：画像标签变更时间线的**来源出处**（origin：冷启动 / 持续迭代 / 行为投影）
# --------------------------------------------------------------------------- #
#
# ★★ 为什么单靠已有的 `source` 不够（三期实测结论，2026-09-30）：
#
#   `source` 回答的是「这条值**有多可信**」（declared/observed/inferred 三档），
#   不是「它**从哪条路来的**」。这两件事在**两条写入路径**上会撞车：
#
#     · `declared`  —— 现在**只有**五问冷启动能写（契约层 RefreshApplyTag 明确
#       禁止概括声明 declared）。所以它天然等于「冷启动」。
#     · `inferred`  —— 现在**只有**持续迭代概括能写。所以它天然等于「持续迭代」。
#     · `observed`  —— **两条路都会写**：行为投影（sync_observed_tags，学生在题库
#       作答时由判分数据投影）与持续迭代概括（学生自己在对话里表达过）。
#       光看 source 分不出这两者，但它们对「画像怎么变成这样的」是两回事：
#       一个是「系统看着你练」，一个是「系统听你说了再调整」。
#
#   所以 origin 是必要的：它把**写入路径**这一维度补上，与 source（可信度维度）
#   正交。二者合起来才能把时间线讲清楚。
#
# ★★★ 回填策略（**只对能确定的回填，不确定的留 NULL** —— 与 v6「历史无法追溯」同一条纪律）：
#
#     · source='declared'  → origin='cold_start'（唯一来源是五问，可确定）
#     · source='inferred'  → origin='refresh'（唯一来源是持续迭代，可确定）
#     · source='observed'  → **NULL**（投影与持续迭代都可能，无法区分 ——
#       绝不猜一个，宁可留空让读取侧如实显示成「系统根据你的使用调整的」）
#
#   ⚠️ 这与 v6「历史无法追溯」是同一条纪律的延续：v6 之前的历史已经不可考，
#      这里也不拿一个猜测值去填它。留 NULL 是**如实**，不是「没做完」。
#
# ★ 列可空、无默认值：NULL = 「这条变更发生时还没记 origin」（v7 之前的旧行）。
#   读取侧（routes/profile.py）把 NULL 折成一个中性的中文句子，不显示内部枚举名。
#   新写入一律显式带 origin（见 LearningStore.upsert_tag / _append_tag_history）。


def _apply_profile_origin_v7(conn: sqlite3.Connection) -> None:
    """v7：给 ``profile_tag_history`` 补 ``origin`` 列（变更的来源出处）。

    ★ **幂等 ALTER**（模板 = ``_apply_chapter_v2`` / v3 / v4）：先 ``PRAGMA table_info``
      看列在不在，再 ``ALTER TABLE ... ADD COLUMN``。SQLite 的 ``ADD COLUMN``
      **没有** ``IF NOT EXISTS``，直接写会在重复执行时报 ``duplicate column name``；
      而迁移器虽然按 ``schema_version`` 记账跳过了，但**已建过 v1~v6 的库**
      （v6 已记账、v7 还没）必须靠这条补列。

    ★ **不改 v6**（本模块的纪律：不要改已发布的那条）：v6 是建表基线，「老库跑 v7 补列、
      新库 v1~v7 一起跑」—— 两条路的结果一致（新库建表后用同一条 UPDATE 回填，
      但新库此刻没有历史行，回填是 no-op）。

    ★ 回填**只做能确定的映射**（declared→cold_start、inferred→refresh），
      observed 留 NULL —— 理由见本节上方注释，不在迁移里替过去编造。
    """
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(profile_tag_history)").fetchall()
    }
    if "origin" not in columns:
        conn.execute("ALTER TABLE profile_tag_history ADD COLUMN origin TEXT")
        # 回填：只对**唯一可确定**的两类来源填，observed 留给读取侧如实显示。
        conn.execute(
            "UPDATE profile_tag_history SET origin = 'cold_start' WHERE source = 'declared'"
        )
        conn.execute(
            "UPDATE profile_tag_history SET origin = 'refresh' WHERE source = 'inferred'"
        )


KB_MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="kb 核心表 + FTS5(trigram)", apply=_apply_kb_v1),
    # 后续新增教材相关表在此追加（version 递增），不要改已发布的那条
)

LEARNING_MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="学生画像 / 掌握度 / 学习历史 / 进度 / 学段信号", apply=_apply_learning_v1),
    Migration(version=2, name="学生当前教材章节列（current_chapter）", apply=_apply_chapter_v2),
    Migration(
        version=3,
        name="学段轨迹的信号位标（grade_history.signal_mark，冷却按真实轮数算）",
        apply=_apply_grade_signal_mark_v3,
    ),
    Migration(
        version=4,
        name="学段轨迹的判定层（grade_history.decided_by，规则 / LLM）",
        apply=_apply_grade_decided_by_v4,
    ),
    Migration(
        version=5,
        name="冷启动画像地基（identity_local / profile_tags / onboarding_qa，两表物理隔离）",
        apply=_apply_identity_profile_v5,
    ),
    Migration(
        version=6,
        name="画像标签变更时间线（profile_tag_history，append-only，§5.2 #11）",
        apply=_apply_profile_history_v6,
    ),
    Migration(
        version=7,
        name="画像标签变更的来源出处（profile_tag_history.origin：冷启动 / 持续迭代 / 行为投影）",
        apply=_apply_profile_origin_v7,
    ),
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
