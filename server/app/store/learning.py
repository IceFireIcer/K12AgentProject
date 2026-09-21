"""``learning.db``（**每人一份**）的建库与仓储。

数据层的三处分离（执行文档 §8.1）：对话正文归 Pi 的 JSONL 会话树，
**SQLite 不存对话内容**，这里只放从对话中提取出来的结构化学习数据。

一人一库是合规硬约束：**不同学生的画像/掌握度绝不能共用一个库文件**，
所以本模块只提供「按路径开库」的能力，不持有任何全局连接。

> 归口说明：``app/store/**`` 属数据轨。画像/学段/练习各轨**请复用本模块**，
> 不要另起一套 ``CREATE TABLE`` —— 同一个库两份 DDL 是最难查的那类故障。

票 15/20 新增的两块（都在本文件，**不动 migrations.py**）
--------------------------------------------------------
1. **闯关进度的读写原语**（``progress_rows`` / ``upsert_progress`` / ``mastery_map``）：
   ``progress`` 表在迁移 v1 里就有了（§8.3 的 DDL），此前只是没人写。**状态机不在本文件**
   ——「什么条件才能解锁下一关」是业务规则，属 ``app/routes/quiz.py``；这里只做「存/取」，
   避免出现第二套状态推导。
2. **LLM 生成的变式题仓库**（``generated_question`` 表）：走 ``migrations.py`` 文档里
   明确预留的 ``set_name="quiz"`` 通道（见该文件头部「set_name 是给其他轨道留的并行通道」），
   因此不必改 ``migrations.py``、也不会和 ``kb`` / ``learning`` 的版本号打架。

   ★ 为什么生成题**落在这个学生自己的库**里，而不是回写随包分发的题库文件：
     ① 一人一库是既有边界（生成题是这名学生的练习记录，不该出现在别人的题里）；
     ② ``resources/quizbank/*.json`` 是**随包分发的只读内容资产**（打包态在安装目录里，
        写不进去），往里写会同时污染交付物与演示环境；
     ③ 与掌握度/进度**同一个库同一个事务边界**，不会出现「题存了、掌握度没写」的半截状态。

   ★ 表里存的 ``reference_answer`` 是**标准答案**（用于 ``POST /api/quiz/grade`` 判分），
     它**只在本文件与 Python 侧存在**，绝不出现在任何出参模型里（§6.3 答案泄漏防护：
     对外一律 ``QuizQuestionOut``，结构上没有答案字段）。

当前教材章节（``student.current_chapter``）
------------------------------------------
学生显式选定的「在学哪一章」是**软偏好**（只进画像 Prompt，不做检索硬过滤），
存在 ``student`` 表的一列里（迁移 v2，见 ``migrations.py`` 的 ``_apply_chapter_v2``；
**不动 v1**，老库靠 v2 补列）。本文件提供这一列唯一的读写对
（:meth:`LearningStore.current_chapter` / :meth:`LearningStore.set_current_chapter`），
与 ``profile_pref`` 的读写对同一口径：**路由层不自己拼 SQL**。

> ⚠️ 章节的**清单**不在这里 —— 它来自 ``kb.sqlite`` 的 ``kp.chapter_title``
> （随包分发的只读内容资产，``store/kb.py:chapters_by_grade``）。
> 学生库里只存「他选了哪一个标题」这一个字符串，别把清单也搬进来
> （那会让教材内容在每个学生的库里各存一份，改教材时到处对不上）。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple, Sequence

from app.contracts import MASTERY_DELTA_LIMIT
from app.store.connections import connect
from app.store.migrations import Migration, ensure_learning, ensure_migrated, execute_script

logger = logging.getLogger(__name__)

# ★ 掌握度单次变更的限幅（业务陷阱清单 §5）**不在本文件定义**，而是从契约
#   ``app/contracts.py`` import：那边用它声明 ``QuizResult.mastery_delta`` 的 ``ge/le``。
#   各写一份 ``= 0.2`` 的话，只改一处就会让「返回给前端的 delta」与「实际写进
#   ``mastery`` 的分数变化」静默不一致 —— 常量只有一个来源（``__all__`` 里的
#   导出保持不变，``from app.store.learning import MASTERY_DELTA_LIMIT`` 照旧可用）。

#: 变式题仓库的迁移组名（``migrations.py`` 预留的并行通道，见模块头）。
QUIZ_MIGRATION_SET = "quiz"

#: :meth:`LearningStore.question_attempt` 单次扫描的学习记录行数上限。
#: ★ 为什么是「有界扫描 + 内存比对 qid」而不是加索引 / 加列：见那个方法的 docstring
#:   （``qid`` 在 ``detail`` 的 JSON 字符串里，按它查在现有表结构下无索引可用；
#:   加索引/加列都要动 ``migrations.py`` 的已发布迁移，超出「零迁移」的边界）。
_ATTEMPT_SCAN_LIMIT = 200

#: ``generated_question`` 表：LLM 生成的变式题（**含标准答案**，见模块头第 2 条）。
_QUIZ_V1 = """
CREATE TABLE IF NOT EXISTS generated_question (
  qid              TEXT PRIMARY KEY,
  kp_id            TEXT NOT NULL,
  grade_level      TEXT NOT NULL,
  type             TEXT NOT NULL,             -- choice | blank | code_blank
  stem             TEXT NOT NULL,
  options          TEXT,                      -- JSON 数组或 NULL
  reference_answer TEXT NOT NULL,             -- JSON（字符串或字符串数组）★ 标准答案，不出后端
  explanation      TEXT,
  rubric           TEXT,                      -- 主观题评分细则（非空 = 主观题，只能走 LLM 判分路径）
  source           TEXT NOT NULL DEFAULT 'generated',
  created_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_generated_kp ON generated_question(kp_id);
"""


def _apply_quiz_v1(conn: sqlite3.Connection) -> None:
    # ★ 用 ``execute_script`` 而不是 ``conn.executescript``：后者会**隐式提交**
    #   （sqlite3 的既有行为），让「失败整体回滚」在这条迁移上失效。
    execute_script(conn, _QUIZ_V1)


#: v2：补 ``rubric`` 列（主观题评分细则）。
#: ★ 不改 v1 那条迁移（``migrations.py`` 的纪律：**不要改已发布的那条**），
#:   追加一条新的 —— 已经建过库的学生（v1 已记账）靠它补列，新学生两条一起跑。
def _apply_quiz_v2(conn: sqlite3.Connection) -> None:
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(generated_question)").fetchall()
    }
    if "rubric" not in columns:
        conn.execute("ALTER TABLE generated_question ADD COLUMN rubric TEXT")


QUIZ_MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="LLM 变式题仓库（含标准答案，仅 Python 侧）", apply=_apply_quiz_v1),
    Migration(version=2, name="主观题评分细则列（rubric）", apply=_apply_quiz_v2),
)


@dataclass(frozen=True)
class StudentRecord:
    student_id: str
    nickname: str
    grade_level: str
    created_at: int
    last_active_at: int
    #: 学生当前在学的教材章节标题；**空串 = 未选择**（库里的 NULL 也读成空串）。
    #: ★ 只在 ``student.current_chapter`` 一列里存 —— 章节**清单**归 ``kb.sqlite``，
    #:   这里只存「学生选了哪一个」这一个值（软偏好，见 ``app/contracts.ChapterUpdateRequest``）。
    current_chapter: str = ""


@dataclass(frozen=True)
class GradeHistoryRecord:
    """``grade_history`` 的一行（学段变化轨迹）。

    ★ ``ts`` 是**秒**（由路由层经 ``to_contract_ms`` 转毫秒，与画像/学段同一处换算）。
    ★ 冷启动基线那行 ``from_level`` 为 ``None`` —— 学生还没有「上一段」。
    """

    id: int
    ts: int
    turn: int
    from_level: str | None
    to_level: str
    source: str
    #: 哪一层判的（D-066）：``rules`` / ``llm`` / ``None``（历史行或手动指定行）。
    decided_by: str | None
    confidence: float


@dataclass(frozen=True)
class MistakeRecord:
    """按知识点聚合后的错题（``is_correct = 0`` 的那些）。

    ``stem`` / ``last_qid`` 只可能来自 ``activity='quiz'`` 的行：其余轨（qa / coding）
    答错时 ``question`` 是空串，本记录如实留空 —— **不要**为此去 join 带标准答案的
    ``generated_question`` 表（见 ``app/contracts.py`` 的 ``MistakeItem`` 注释）。
    """

    kp_id: str
    #: 该知识点答错的**总次数**（含没有题干的那些）
    wrong_count: int
    #: 其中**取不到题干**的次数（qa / coding 轨答错）：显式报出来，别静默少几条
    blank_count: int
    #: 最近一次答错的时间（**秒**，由路由层转毫秒）
    last_wrong_at: int
    #: 最近一次**有题干**的错题的题干（没有则为空串）
    stem: str
    #: 该题干对应的题号（供「再练一遍」定位；空串 = 没有）
    last_qid: str


@dataclass(frozen=True)
class DayActivity:
    """某一**本地日期**的活动量（``day`` 形如 ``2026-09-17``）。

    ★ 按**本地日期**聚合而不是 UTC：学生晚上十点学的，跨了 UTC 零点还算「昨天」，
      报告里的「连续学习三天」就会莫名其妙断掉。
    """

    day: str
    count: int
    quiz_count: int
    correct_count: int


@dataclass(frozen=True)
class ProgressRecord:
    """``progress`` 表的一行（**闯关状态的唯一权威**，§8.3）。

    ``badge`` 为 ``None`` 表示这一关还没有徽章；一经授予**不因后续答错而清除**
    （徽章是「曾经通关」的事实，不是当前掌握度）。
    """

    kp_id: str
    stage: str
    badge: str | None
    updated_at: int | None


@dataclass(frozen=True)
class GeneratedQuestionRecord:
    """``generated_question`` 表的一行。

    ``reference_answer`` 是**标准答案**（``str | list[str]``，落库为 JSON）。
    ★ 本记录**不提供**任何「转成对外形态」的方法：转对外形态只允许走
    ``app/contracts.py`` 的 ``QuizQuestionOut.from_internal``，避免有人顺手把答案带出去。
    """

    qid: str
    kp_id: str
    grade_level: str
    type: str
    stem: str
    options: tuple[str, ...] | None
    reference_answer: Any
    explanation: str
    #: 主观题的评分细则；``None``/空 = 客观题（只能走规则判分）。
    rubric: str | None
    source: str
    created_at: int | None


class AttemptRecord(NamedTuple):
    """某道题**最近一次**作答（:meth:`LearningStore.question_attempt` 的返回）。

    ★ 用 ``NamedTuple`` 而不是本文件其它记录那种 ``frozen dataclass``：它是判分
      热路径上的一个**小返回值**（每次提交都要取一次），只需要「不可变 + 按名字读」，
      没有默认值 / 校验的需求；NamedTuple 还顺带能按位置取值与元组解包。

    ★ 它**不是** :class:`MistakeRecord` 那样按知识点聚合的结果：后者回答
      「这个知识点错了几次」，本记录回答「**这道题**答过没有、上次对没对」——
      聚合粒度不同，不能拿错题本代替判分幂等（错题本只含答错的行，
      「上次答对了」的那一次在那里根本不存在）。
    """

    qid: str
    #: 该次作答落在哪个知识点（``detail`` 里只有 qid，kp_id 取自行本身）
    kp_id: str
    #: 那次作答的对错；``None`` = 该行没有对错概念（列可空，如实透传）
    is_correct: bool | None
    #: 那次作答的时间（**Unix 秒**，与 ``add_history`` / ``last_active_at`` 同尺度）
    ts: int


class LearningStore:
    """一个学生的 ``learning.db`` 读写入口。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.conn = connect(self.path, load_vec=False, wal=True, check_same_thread=False)
        ensure_learning(self.conn)
        # 变式题仓库（见模块头）**按需建表**：见 :meth:`ensure_quiz_tables` 的注释。
        self._quiz_ready = False
        self.quiz_version = 0

    # ------------------------------------------------------------ 学生 --
    def upsert_student(self, student_id: str, nickname: str, grade_level: str) -> StudentRecord:
        now = int(time.time())
        self.conn.execute(
            "INSERT INTO student(student_id, nickname, grade_level, created_at, last_active_at) "
            "VALUES(?,?,?,?,?) "
            "ON CONFLICT(student_id) DO UPDATE SET nickname=excluded.nickname, "
            "grade_level=excluded.grade_level, last_active_at=excluded.last_active_at",
            (student_id, nickname, grade_level, now, now),
        )
        self.conn.commit()
        got = self.get_student(student_id)
        assert got is not None
        return got

    def get_student(self, student_id: str) -> StudentRecord | None:
        row = self.conn.execute(
            "SELECT student_id, nickname, grade_level, created_at, last_active_at, current_chapter "
            "FROM student WHERE student_id = ?",
            (student_id,),
        ).fetchone()
        if row is None:
            return None
        return StudentRecord(
            student_id=str(row["student_id"]),
            nickname=str(row["nickname"] or ""),
            grade_level=str(row["grade_level"]),
            created_at=int(row["created_at"] or 0),
            last_active_at=int(row["last_active_at"] or 0),
            current_chapter=str(row["current_chapter"] or ""),
        )

    def touch_last_active(self, student_id: str) -> None:
        """刷新 ``student.last_active_at``（**只写这一列**的单条 UPDATE）。

        列名与单位**以 DDL 为准**：``migrations.py`` 的 ``_LEARNING_V1`` 里是
        ``last_active_at INTEGER``，写 ``int(time.time())``（**Unix 秒**，
        与 ``upsert_student`` / ``add_history`` 同一尺度；路由层用 ``to_contract_ms``
        换算成毫秒给出参）。

        ★★ **为什么不能用 ``upsert_student()`` 来刷活跃时间**（这条方法存在的全部理由）：
          那个方法做的是**整行 upsert** —— ``ON CONFLICT`` 分支会把 ``nickname``
          与 **``grade_level``** 按调用方手里的值一起写回去。而刷新活跃时间的调用方
          只能先 ``get_student()`` 读一份快照、在请求收尾时再写回，**这一读一写之间
          学段可能已经被别处改掉**（``app/grade/rules.py`` 的自动规则引擎、
          ``POST /api/grade/override`` 的手动选择）。于是这次「刷新活跃时间」
          会把刚生效的新学段**打回旧值**，而且**不留 ``grade_history``** ——
          库里的学段与轨迹互相矛盾，现象是「学生明明被切到初中了，几轮后又变回小学」，
          属最难查的那类故障。单列 UPDATE 里没有「读取 → 改 → 写回」的窗口，天然免疫。

        ★ 同理**不碰** ``current_chapter`` / ``created_at`` / 任何其它列：
          这个方法的名字就是它的全部职责（与 D-038 的「学段变更才清章节」分得干干净净）。

        ★ 学生行不存在时**什么都不写**（``UPDATE`` 影响 0 行，不静默建行）——
          与 :meth:`set_current_chapter` 同一口径：建行要一并决定学段与昵称，
          那是路由层冷启动的事（``upsert_student``），存储层不替它决定。
        """
        self.conn.execute(
            "UPDATE student SET last_active_at = ? WHERE student_id = ?",
            (int(time.time()), student_id),
        )
        self.conn.commit()

    # ------------------------------------------------------- 当前教材章节 --
    # ★ 这一对方法是 ``student.current_chapter`` 这一列**唯一的读写实现**：
    #   ``routes/profile.py`` 的两条章节端点调它们，别处（学段变更清空在 rules.py 里
    #   是同一张表的一次 UPDATE，属学段轨自己的事务）不许再拼一份 SELECT/UPDATE。
    #   两处各写一份 SQL 的典型后果：「清空」一处写 NULL、一处写 ''，读出来两种空值。
    def current_chapter(self, student_id: str) -> str:
        """读该学生当前章节标题（无行 / ``NULL`` / 空串 → **空串**）。"""
        row = self.conn.execute(
            "SELECT current_chapter FROM student WHERE student_id = ?", (student_id,)
        ).fetchone()
        if row is None:
            return ""
        return str(row["current_chapter"] or "")

    def set_current_chapter(self, student_id: str, title: str | None) -> None:
        """写/清除当前章节（**空串 / ``None`` → 写 ``NULL``**，读回仍是空串）。

        ★ 为什么统一落成 ``NULL`` 而不是 ``''``：库里只留一种「空」的表示，
          否则 ``WHERE current_chapter = ''`` 这类查询会漏掉 ``NULL`` 的行
          （三值逻辑），排查起来是「明明没选章节却查不出来」。
        ★ 学生行不存在时**什么都不写**（不静默建行）：建行是路由层的冷启动口径
          （``upsert_student`` 要一并写学段），存储层不该替它决定学段。
        """
        value = (title or "").strip()
        self.conn.execute(
            "UPDATE student SET current_chapter = ? WHERE student_id = ?",
            (value or None, student_id),
        )
        self.conn.commit()

    # ------------------------------------------------------------ 掌握度 --
    def mastery(self, kp_id: str) -> tuple[float, int, int]:
        row = self.conn.execute(
            "SELECT score, attempts, correct FROM mastery WHERE kp_id = ?", (kp_id,)
        ).fetchone()
        if row is None:
            return 0.0, 0, 0
        return float(row["score"]), int(row["attempts"]), int(row["correct"])

    def apply_mastery(
        self, kp_id: str, delta: float, *, correct: bool | None = None
    ) -> float:
        """更新掌握度并返回新值。``delta`` **限幅 ±0.2**。

        ★ **算术全部下推到一条 SQL**（``RETURNING`` 直接读回新值），不做
        「先 ``SELECT`` 读旧值 → 在 Python 里算 → 再写回」：那是两步之间的竞态，
        同一学生并发两次判分（前端双击、模型并发调两次 ``submit_quiz``、
        判分与 ``/profile/events`` 交叉）时**后写的会覆盖先写的** ——
        ``attempts`` 只涨一次，不报错、不回滚，而返回值还与库里的值不一致
        （闯关解锁与推荐路径据此失真）。SQLite 3.35+ 支持 ``RETURNING``
        （本机 3.45.3），一条语句天然原子，不需要读-改-写。

        几个容易写错的点：

        - ``max()/min()`` 在 ``UPDATE SET`` 里是**标量**函数（两个参数就是标量语义，
          不会退化成聚合），所以钳位可以直接写在 SQL 里；
        - ``ON CONFLICT`` 分支里的 ``mastery.score`` 是**库里的当前值**（行级并发安全），
          不是调用方读到的旧值；
        - 冷启动那一行（``INSERT`` 分支）也要钳：直接写 ``delta`` 的话首次答对
          能一次跳到 1.0，限幅形同虚设。
        """
        clamped = max(-MASTERY_DELTA_LIMIT, min(MASTERY_DELTA_LIMIT, float(delta)))
        initial = max(0.0, min(1.0, clamped))
        row = self.conn.execute(
            "INSERT INTO mastery(kp_id, score, attempts, correct, last_seen_at) "
            "VALUES(:kp_id, :initial_score, 1, :hit, :now) "
            "ON CONFLICT(kp_id) DO UPDATE SET "
            "score = max(0.0, min(1.0, mastery.score + :delta)), "
            "attempts = mastery.attempts + 1, "
            "correct = mastery.correct + :hit, "
            "last_seen_at = :now "
            "RETURNING score",
            {
                "kp_id": kp_id,
                "initial_score": initial,
                "delta": clamped,
                "hit": 1 if correct else 0,
                "now": int(time.time()),
            },
        ).fetchone()
        self.conn.commit()
        if row is None:  # pragma: no cover - 有 INSERT .. RETURNING 就必有行
            return initial
        return float(row["score"])

    def mastery_map(self) -> dict[str, float]:
        """全部掌握度（``kp_id → score``）。

        推荐路径要「按掌握度排序」而不是只看「是否过阈值」，逐条 ``mastery()`` 会变成
        N 次查询；一次读全表更简单也更快（学生规模是「一台机器上的几个孩子」）。
        """
        rows = self.conn.execute("SELECT kp_id, score FROM mastery").fetchall()
        return {str(r["kp_id"]): float(r["score"] or 0.0) for r in rows}

    # ------------------------------------------------------------ 学习偏好 --
    def preferences(self) -> dict[str, str]:
        """读全部学习偏好（``profile_pref`` 的键值视图，供画像端点出参）。

        ★ **读只有一处实现**：``routes/profile.py`` 的 ``GET /profile`` 调这里，
          不再自己写 ``SELECT key, value FROM profile_pref`` —— 与 :meth:`set_preference`
          构成这一张表的唯一一对读写（两处各写一份 SQL 迟早会漂移）。
        """
        rows = self.conn.execute("SELECT key, value FROM profile_pref").fetchall()
        return {str(row["key"]): str(row["value"] or "") for row in rows}

    def set_preference(self, key: str, value: str) -> None:
        """写一条学习偏好（**幂等 upsert**：同 key 覆盖，不追加）。

        ``key`` 由调用方（契约的 ``PreferenceKey``）保证是封闭词表 —— 本方法**不再校验**，
        因为「校验只有一处」比「两处各校验一遍」更不容易漂移（与 ``students.py``
        的 ``validate_student_id`` 同一口径：入口校验，存储层只管写）。

        ★ 顺带一个结构性好处：``key`` 是主键 → 总行数天然 ≤ 词表大小（4），
          永远不需要清理逻辑，也没有「攒了几百条偏好把每轮 Prompt 挤爆」这条路径。
        """
        self.conn.execute(
            "INSERT INTO profile_pref(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(key), str(value)),
        )
        self.conn.commit()

    # ------------------------------------------------------------ 闯关进度 --
    def progress_rows(self) -> list[ProgressRecord]:
        """读全部闯关进度（**按 kp_id 排序**，保证出参稳定可比对）。"""
        rows = self.conn.execute(
            "SELECT kp_id, stage, badge, updated_at FROM progress ORDER BY kp_id"
        ).fetchall()
        return [
            ProgressRecord(
                kp_id=str(r["kp_id"]),
                stage=str(r["stage"] or ""),
                badge=None if r["badge"] is None else str(r["badge"]),
                updated_at=None if r["updated_at"] is None else int(r["updated_at"]),
            )
            for r in rows
        ]

    def progress_map(self) -> dict[str, ProgressRecord]:
        """``kp_id → ProgressRecord``（缺行 = 这一关还没被初始化）。"""
        return {record.kp_id: record for record in self.progress_rows()}

    def upsert_progress(self, kp_id: str, *, stage: str, badge: str | None = None) -> None:
        """写/更新一关的进度。

        ★ ``badge`` 的合并语义很关键（防「徽章被后来的答错抹掉」）：
          - 传入 ``None`` → **保留库里已有的徽章**（``badge`` 列取 ``COALESCE(existing, NULL)``）；
          - 传入字符串 → 覆盖。
        徽章代表「曾经通关」，不该因为后来答错一次就消失；而重新通关时会给一个更好的徽章。
        """
        self.conn.execute(
            "INSERT INTO progress(kp_id, stage, badge, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(kp_id) DO UPDATE SET stage=excluded.stage, "
            "badge=COALESCE(excluded.badge, progress.badge), "
            "updated_at=excluded.updated_at",
            (kp_id, stage, badge, int(time.time())),
        )
        self.conn.commit()

    def seed_progress(self, kp_ids: Sequence[str], *, stage: str = "locked") -> int:
        """给还没有进度行的知识点补默认行（**只插不覆盖**），返回新插了几行。

        冷启动用：新学生第一次打开练习时，`progress` 表是空的 —— 前端拿到空数组会显示
        「一关都没有」。这里按调用方给的**依赖图顺序**初始化默认路径，
        已有的行（学生真做过的）一个字都不动。
        """
        existing = set(self.progress_map())
        inserted = 0
        now = int(time.time())
        for kp_id in kp_ids:
            if not kp_id or kp_id in existing:
                continue
            self.conn.execute(
                "INSERT OR IGNORE INTO progress(kp_id, stage, badge, updated_at) VALUES(?,?,?,?)",
                (kp_id, stage, None, now),
            )
            existing.add(kp_id)
            inserted += 1
        if inserted:
            self.conn.commit()
        return inserted

    # ------------------------------------------------------------ 变式题仓库 --
    def ensure_quiz_tables(self) -> int:
        """确保 ``generated_question`` 存在，返回该迁移组的版本号。

        ★ **为什么不在 ``__init__`` 里建**（与 ``ensure_learning`` 的处理不同）：
          建表会在 ``schema_version`` 里多记一行 ``("quiz", 1)``，而「开了库就有哪几张表」
          是既有验收的断言口径（``tests/test_profile_routes.py`` 断言 ``schema_version``
          只有 ``("learning", 1)`` 这一条）。变式题只有练习轨真的用到时才存在，
          把建表推迟到**第一次读写生成题**，既拿到了 ``migrations.py`` 预留的独立迁移通道，
          又不动「只画像不练习」那条路径的既有事实。
        """
        if not self._quiz_ready:
            self.quiz_version = ensure_migrated(
                self.conn, QUIZ_MIGRATIONS, set_name=QUIZ_MIGRATION_SET
            )
            self._quiz_ready = True
        return self.quiz_version

    def save_generated_questions(self, records: Sequence[GeneratedQuestionRecord]) -> int:
        """落库一批 LLM 生成的变式题（同 ``qid`` 覆盖），返回写入条数。

        ★ 这是**答案进入 ``learning.db``** 的唯一入口，所以只接受
        :class:`GeneratedQuestionRecord`（已经是校验过的结构），不接受裸 dict ——
        裸 dict 会让「答案字段叫什么」变成一个到处猜的问题。
        """
        self.ensure_quiz_tables()
        for record in records:
            self.conn.execute(
                "INSERT INTO generated_question"
                "(qid, kp_id, grade_level, type, stem, options, reference_answer, explanation, rubric, source, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(qid) DO UPDATE SET kp_id=excluded.kp_id, grade_level=excluded.grade_level, "
                "type=excluded.type, stem=excluded.stem, options=excluded.options, "
                "reference_answer=excluded.reference_answer, explanation=excluded.explanation, "
                "rubric=excluded.rubric, source=excluded.source, created_at=excluded.created_at",
                (
                    record.qid,
                    record.kp_id,
                    record.grade_level,
                    record.type,
                    record.stem,
                    json.dumps(list(record.options), ensure_ascii=False)
                    if record.options is not None
                    else None,
                    json.dumps(record.reference_answer, ensure_ascii=False),
                    record.explanation,
                    record.rubric,
                    record.source,
                    int(record.created_at or time.time()),
                ),
            )
        self.conn.commit()
        return len(records)

    def find_generated_question(self, qid: str) -> GeneratedQuestionRecord | None:
        """按 ``qid`` 查一条生成题（判分用；**返回的记录含标准答案**）。"""
        self.ensure_quiz_tables()
        row = self.conn.execute(
            "SELECT qid, kp_id, grade_level, type, stem, options, reference_answer, "
            "explanation, rubric, source, created_at FROM generated_question WHERE qid = ?",
            (qid,),
        ).fetchone()
        if row is None:
            return None
        return _generated_from_row(row)

    def generated_questions(self, *, kp_id: str | None = None) -> list[GeneratedQuestionRecord]:
        """列生成题（可按知识点过滤）；**含标准答案**，只供 Python 侧使用。"""
        self.ensure_quiz_tables()
        sql = (
            "SELECT qid, kp_id, grade_level, type, stem, options, reference_answer, "
            "explanation, rubric, source, created_at FROM generated_question"
        )
        params: tuple[object, ...] = ()
        if kp_id:
            sql += " WHERE kp_id = ?"
            params = (kp_id,)
        sql += " ORDER BY created_at, qid"
        return [_generated_from_row(row) for row in self.conn.execute(sql, params)]

    # ------------------------------------------------------------ 学习记录 --
    def add_history(
        self,
        *,
        kp_id: str,
        activity: str,
        session_id: str = "",
        question: str = "",
        is_correct: bool | None = None,
        detail: str = "",
    ) -> None:
        """写一条学习记录（``session_id`` 关联 Pi JSONL 会话；**不写对话正文**）。"""
        self.conn.execute(
            "INSERT INTO learning_history(ts, session_id, kp_id, activity, question, is_correct, detail) "
            "VALUES(?,?,?,?,?,?,?)",
            (
                int(time.time()),
                session_id,
                kp_id,
                activity,
                question,
                None if is_correct is None else (1 if is_correct else 0),
                detail,
            ),
        )
        self.conn.commit()

    def add_grade_signal(
        self, *, signal_type: str, value: float, raw: str = "", session_id: str = ""
    ) -> None:
        """写一条学段信号（自动推断的原料）。

        ⚠️ 这里**只落信号**，不做任何判定：学段的唯一写路径是 ``app/grade/rules.py``
        的规则引擎 —— 达到阈值时它把新学段**自动生效**并写
        ``grade_history(source="inferred")``。学生端没有选择器、也没有确认动作
        （D-020 翻转；旧的「只写建议、改学段须学生确认」口径已废止）。
        """
        self.conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) VALUES(?,?,?,?,?)",
            (int(time.time()), session_id, signal_type, float(value), raw),
        )
        self.conn.commit()

    # ------------------------------------------------------------ 学习记录读 --
    # ★ 四个读原语（判分幂等 / 学习档案：错题本 / 学习报告）与 :meth:`add_history`
    #   构成 ``learning_history`` 这一张表唯一的读写对 —— 路由层不再自己拼 SQL，
    #   两处各写一份 ``SELECT`` 迟早会在「要不要过滤 activity」这类地方分叉。
    #
    # ⚠️ 这里刻意**没有**「读全部学习记录」的原语（``history_rows``）：写过一版，
    #   但报告用 ``daily_activity`` 按天聚合、错题本用 ``mistakes`` 按知识点聚合，
    #   没有任何调用方需要原始行 —— 零引用的读原语就是零测试覆盖的死代码
    #   （实测：给它注入「``is_correct`` 的 NULL 与 False 混为一谈」这种回归，
    #   全部测试依然绿，因为根本没走到）。要加就等真的有调用方时再加。
    def question_attempt(self, qid: str) -> AttemptRecord | None:
        """**这道题答过没有**：返回 ``detail.qid == qid`` 的最近一次作答，没有则 ``None``。

        用途是**判分幂等**：同一题被重复提交时（前端双击、模型并发调两次
        ``submit_quiz``）要能认出「这一题已经有记录」，而不是再记一次掌握度。

        - **只认 ``activity == 'quiz'`` 的行**（与 :meth:`mistakes` 的过滤口径一致）：
          ``qa`` / ``coding`` / ``animation`` 轨的记录里没有题目概念，
          它们的 ``detail`` 里就算凑巧有 qid 也不能算「做过这道题」。
        - 判据是 ``detail`` 里的 qid，取自 :func:`_qid_from_detail`
          —— ``detail`` 是 ``routes/quiz.py`` 的 ``_record_attempt`` 写的 JSON 串，
          **不另写一份 JSON 解析**（两处解析迟早对「格式坏了怎么办」给出不同答案）。
        - 「最近一条」按 ``ts DESC, id DESC``：与 :meth:`mistakes` /
          :meth:`grade_history` 的既有取法一致；同一秒内的多条靠自增 ``id`` 分先后
          （``ts`` 是**秒**，同一秒里的两次提交光看时间分不出来）。

        ★★ **为什么先按 ``learning_history`` 取最近 N 行、再在内存里比对 qid**
          （而不是 ``WHERE detail LIKE '%qid%'`` 或加索引）：

          1. ``qid`` **不是一个列**，它藏在 ``detail`` 的 JSON 字符串里 ——
             现有表结构下按它过滤**无索引可用**，SQL 层做不了等值查询；
             ``LIKE '%...%'`` 既走不了索引又会被子串误命中
             （``q-1`` 会匹配到 ``q-12``），而且要依赖 JSON 的书写格式。
          2. 加真实的索引 / 把 ``qid`` 提成列都要动 ``migrations.py`` 的**已发布迁移**
             —— 那是本模块明令的边界（见表头「不动 migrations.py」的口径），
             代价远大于收益：学生规模是「一台机器上的几个孩子」，
             ``learning_history`` 是每人的小表，**有界扫描（``_ATTEMPT_SCAN_LIMIT`` 行）
             完全够用**，且这条路径只走一次 PK 顺序扫描 + 若干次 JSON 解析。
          3. ``ORDER BY ts DESC, id DESC LIMIT N`` 拿到的**就是最近的那批行**，
             所以「最近一次作答」只要它落在窗口内就一定能找到（同一题的两次提交
             在时间上相邻）；即使窗口被更近的其它题占满而失手，退回 ``None``
             也只是「按没答过处理」，不会给出**错误的**结论。

          ⚠️ 调用方通常还知道 ``kp_id``（判分时手上就有），但本方法**不加 kp_id 参数**：
             ``detail`` 里只有 qid、没有 kp_id，让调用方多传一个只用于「顺手缩窄扫描」
             的参数会把「这道题答过没」的定义绑到调用方传参的正确性上。
             ``idx_history_kp`` 因此在本查询上帮不上忙 —— **不为此新增迁移**。
        """
        rows = self.conn.execute(
            "SELECT kp_id, ts, is_correct, detail FROM learning_history "
            "WHERE activity = 'quiz' ORDER BY ts DESC, id DESC LIMIT ?",
            (int(_ATTEMPT_SCAN_LIMIT),),
        ).fetchall()
        for row in rows:
            if _qid_from_detail(str(row["detail"] or "")) != qid:
                continue
            correct = row["is_correct"]
            return AttemptRecord(
                qid=str(qid),
                kp_id=str(row["kp_id"] or ""),
                is_correct=None if correct is None else bool(int(correct)),
                ts=int(row["ts"] or 0),
            )
        return None

    def mistakes(self, *, limit: int | None = 50) -> list[MistakeRecord]:
        """**错题聚合**：``is_correct = 0`` 的记录按 ``kp_id`` 分组。

        ★ 只取 ``is_correct = 0``：``is_correct IS NULL`` 的行是「没有对错概念」的活动
          （qa / animation / 生成题等），把它们算成错题会让错题本里冒出一堆学生没做错的题。
        ★ **不 join ``generated_question``**：那张表带 ``reference_answer``（标准答案）。
          完整题干换不来什么（``question`` 的前 120 字足够认出是这道题），
          却会把一条「带答案的表」接进对外响应 —— 收益小、风险大（§6.3 答案泄漏防护）。
        ★ ``blank_count`` 显式统计「答错了但没有题干」的次数（qa / coding 轨），
          调用方据此提示「还有 N 次答错没有题目记录」，而不是让学生觉得记录少了。

        ★ ``limit=None`` → **全量返回**（不做切片）：错题本里的「累计答错 N 次」
          是**求和**得出的，在**截断之后**求和只会偏小 —— 学生练过头 50 个知识点
          以后，界面上那个数字就不再涨了。默认仍是 50（既有调用方行为逐字不变），
          要统计全量的调用方显式传 ``None``。

        ★ 边界语义**保持不变**：``limit=0`` / 负数仍走 ``max(1, ...)`` → 至少 1 条
          （这是个历史口径，不是笔误 —— 顺手改成「0 就返回空」会静默改变既有调用方的行为）。
        """
        rows = self.conn.execute(
            "SELECT kp_id, activity, question, ts, detail FROM learning_history "
            "WHERE is_correct = 0 ORDER BY ts DESC, id DESC"
        ).fetchall()

        grouped: dict[str, dict[str, object]] = {}
        for row in rows:
            kp_id = str(row["kp_id"] or "")
            if not kp_id:
                # kp_id 为空 = 这条记录没关联知识点（例如 qa 轨未识别出知识点）：
                # 错题本按知识点聚合，无归属的行无处可放，跳过。
                continue
            entry = grouped.setdefault(
                kp_id,
                {"wrong": 0, "blank": 0, "last_ts": 0, "stem": "", "qid": "", "stem_ts": -1},
            )
            entry["wrong"] = int(entry["wrong"]) + 1  # type: ignore[arg-type]
            ts = int(row["ts"] or 0)
            if ts > int(entry["last_ts"]):  # type: ignore[arg-type]
                entry["last_ts"] = ts
            stem = str(row["question"] or "")
            if stem:
                # 「最近一次**有题干**的错题」与「最近一次答错」是两件事：
                # 之后又错了一道没题干的，不该把已有的题干抹掉。
                if ts >= int(entry["stem_ts"]):  # type: ignore[arg-type]
                    entry["stem"] = stem
                    entry["stem_ts"] = ts
                    entry["qid"] = _qid_from_detail(str(row["detail"] or ""))
            else:
                entry["blank"] = int(entry["blank"]) + 1  # type: ignore[arg-type]

        records = [
            MistakeRecord(
                kp_id=kp_id,
                wrong_count=int(data["wrong"]),  # type: ignore[arg-type]
                blank_count=int(data["blank"]),  # type: ignore[arg-type]
                last_wrong_at=int(data["last_ts"]),  # type: ignore[arg-type]
                stem=str(data["stem"]),
                last_qid=str(data["qid"]),
            )
            for kp_id, data in grouped.items()
        ]
        # ★ 排序显式钉死（错得多的在前，平局按 kp_id）：依赖 SQL 行序的话，
        #   「同错 2 次」的两个知识点顺序会随插入顺序漂 —— 前端列表会莫名跳动。
        records.sort(key=lambda item: (-item.wrong_count, item.kp_id))
        if limit is None:
            # 全量：**不切片**（统计口径要的是「一共错了多少次」，截断会让和偏小）。
            # ⚠️ 这里不能沿用 `records[: max(1, limit)]` —— 那个写法对 None 会抛
            # ``TypeError: '>' not supported between instances of 'int' and 'NoneType'``
            # （``max(1, None)`` 直接比较就炸），所以先分流再切。
            return records
        return records[: max(1, int(limit))]

    def daily_activity(self, *, since: int, tz_offset_seconds: int = 0) -> list[DayActivity]:
        """按**本地日期**聚合活动量（``since`` 是 **Unix 秒**下限，含边界）。

        ★ ``tz_offset_seconds`` 由调用方给（本机时区偏移）：SQLite 的
          ``date(ts, 'unixepoch')`` 默认按 **UTC** 切天，晚上八点以后的活动会被算到第二天，
          「连续学习 N 天」就断了。用 ``date(ts, 'unixepoch', '+08:00')`` 这种修饰符
          让切天发生在本地零点。
        """
        modifier = f"{int(tz_offset_seconds) // 3600:+03d}:00"
        rows = self.conn.execute(
            "SELECT date(ts, 'unixepoch', ?) AS day, COUNT(*) AS n, "
            "  SUM(CASE WHEN activity = 'quiz' THEN 1 ELSE 0 END) AS quiz_n, "
            "  SUM(CASE WHEN activity = 'quiz' AND is_correct = 1 THEN 1 ELSE 0 END) AS correct_n "
            "FROM learning_history WHERE ts >= ? "
            "GROUP BY day ORDER BY day",
            (modifier, int(since)),
        ).fetchall()
        return [
            DayActivity(
                day=str(row["day"]),
                count=int(row["n"] or 0),
                quiz_count=int(row["quiz_n"] or 0),
                correct_count=int(row["correct_n"] or 0),
            )
            for row in rows
            if row["day"]
        ]

    def activity_days(self, *, tz_offset_seconds: int = 0) -> list[str]:
        """全部**有活动的本地日期**（去重、升序）。

        打卡（连续学习天数）要的是**全量**而不是时间窗 —— 只看最近七天的话，
        一个坚持了三十天的学生会被算成「连续 7 天」。
        """
        modifier = f"{int(tz_offset_seconds) // 3600:+03d}:00"
        rows = self.conn.execute(
            "SELECT DISTINCT date(ts, 'unixepoch', ?) AS day FROM learning_history "
            "WHERE ts IS NOT NULL ORDER BY day",
            (modifier,),
        ).fetchall()
        return [str(row["day"]) for row in rows if row["day"]]

    def badges(self) -> list[str]:
        """已获得的徽章（去重、按字典序）。

        ★ 徽章是「曾经通关」的事实，``upsert_progress`` 用 ``COALESCE`` 保证它不被后续答错抹掉
          （见那个方法的注释）—— 这里只负责把它们取出来。
        """
        rows = self.conn.execute(
            "SELECT DISTINCT badge FROM progress WHERE badge IS NOT NULL AND badge <> '' ORDER BY badge"
        ).fetchall()
        return [str(row["badge"]) for row in rows]

    def grade_history(self, *, limit: int = 200) -> list[GradeHistoryRecord]:
        """读 ``grade_history`` 轨迹（**按时间正序**，最早的在前）。

        ★ 正序：报告要讲的是「**怎么变成现在这个学段**」这条线，
          倒序读出来还得让每个调用方自己 reverse 一遍。
        ★ 与 ``app/grade/rules.py`` 的 ``GradeEngine.history()`` 是两个用途：
          那个是**引擎自己**判冷却/连轮用的（限量、倒序读再翻正）；
          这个给报告用（只读、正序）。两者都只读，**不构成两套状态推导**。
        """
        rows = self.conn.execute(
            "SELECT id, ts, turn, from_level, to_level, source, decided_by, confidence "
            "FROM grade_history ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [
            GradeHistoryRecord(
                id=int(row["id"]),
                ts=int(row["ts"] or 0),
                turn=int(row["turn"] or 0),
                from_level=None if row["from_level"] is None else str(row["from_level"]),
                to_level=str(row["to_level"] or ""),
                source=str(row["source"] or ""),
                decided_by=None if row["decided_by"] is None else str(row["decided_by"]),
                confidence=float(row["confidence"] or 0.0),
            )
            for row in reversed(rows)
        ]

    def close(self) -> None:
        self.conn.close()


def _qid_from_detail(detail: str) -> str:
    """从 ``learning_history.detail`` 的 JSON 里取题号（取不到就返回空串）。

    ``detail`` 由 ``routes/quiz.py`` 的 ``_record_attempt`` 写成
    ``{"qid": ..., "type": ..., "masteryDelta": ...}``。这里**宽松解析**：
    它是一列辅助信息，格式坏了不该让错题本整体 500（与 ``_generated_from_row``
    对 ``options`` 的处理同一口径）。
    """
    if not detail:
        return ""
    try:
        parsed = json.loads(detail)
    except json.JSONDecodeError:
        return ""
    if not isinstance(parsed, dict):
        return ""
    qid = parsed.get("qid")
    return "" if qid is None else str(qid)


def _generated_from_row(row: sqlite3.Row) -> GeneratedQuestionRecord:
    """``generated_question`` 行 → 记录（JSON 列的**宽松解析**）。"""
    options_raw = row["options"]
    options: tuple[str, ...] | None = None
    if options_raw:
        try:
            parsed = json.loads(str(options_raw))
        except json.JSONDecodeError:  # pragma: no cover - 只有人工改坏库才会到这里
            logger.warning("生成题的 options 不是合法 JSON，已按「无选项」处理：%s", row["qid"])
            parsed = None
        if isinstance(parsed, list):
            options = tuple(str(item) for item in parsed)

    try:
        reference: Any = json.loads(str(row["reference_answer"]))
    except json.JSONDecodeError:  # pragma: no cover - 同上
        logger.warning("生成题的 reference_answer 不是合法 JSON，按原样文本处理：%s", row["qid"])
        reference = str(row["reference_answer"])

    return GeneratedQuestionRecord(
        qid=str(row["qid"]),
        kp_id=str(row["kp_id"]),
        grade_level=str(row["grade_level"]),
        type=str(row["type"]),
        stem=str(row["stem"]),
        options=options,
        reference_answer=reference,
        explanation=str(row["explanation"] or ""),
        rubric=(str(row["rubric"]) if row["rubric"] else None),
        source=str(row["source"] or "generated"),
        created_at=None if row["created_at"] is None else int(row["created_at"]),
    )


__all__ = [
    "AttemptRecord",
    "GeneratedQuestionRecord",
    "LearningStore",
    "MASTERY_DELTA_LIMIT",
    "ProgressRecord",
    "QUIZ_MIGRATIONS",
    "QUIZ_MIGRATION_SET",
    "StudentRecord",
]
