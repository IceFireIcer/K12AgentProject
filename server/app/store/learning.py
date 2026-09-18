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
学生显式选定的「在学哪一章」是**软偏好**（只进画像 Prompt，不做检索硬过滤），
与 ``profile_pref`` 的读写对同一口径：**路由层不自己拼 SQL**。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from app.store.connections import connect
from app.store.migrations import Migration, ensure_learning, ensure_migrated

logger = logging.getLogger(__name__)

# 掌握度单次变更的限幅（业务陷阱清单 §5）：不限幅的话一次答对就能从 0 跳到 1，
# 之后「推荐下一步」直接失去意义。
MASTERY_DELTA_LIMIT = 0.2

#: 变式题仓库的迁移组名（``migrations.py`` 预留的并行通道，见模块头）。
QUIZ_MIGRATION_SET = "quiz"

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
    conn.executescript(_QUIZ_V1)


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
class GradeHistoryRecord:
    """``grade_history`` 的一行（学段变化轨迹）。
    ★ ``ts`` 是**秒**（由路由层经 ``to_contract_ms`` 转毫秒，与画像/学段同一处换算）。
    ★ 冷启动基线那行 ``from_level`` 为 ``None`` —— 学生还没有「上一段」。
    from_level: str | None
    to_level: str


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
            "SELECT student_id, nickname, grade_level, created_at, last_active_at "
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
        )

    #   是同一张表的一次 UPDATE，属学段轨自己的事务）不许再拼一份 SELECT/UPDATE。
          （``upsert_student`` 要一并写学段），存储层不该替它决定学段。
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
        """更新掌握度并返回新值。``delta`` **限幅 ±0.2**。"""
        score, attempts, correct_cnt = self.mastery(kp_id)
        clamped = max(-MASTERY_DELTA_LIMIT, min(MASTERY_DELTA_LIMIT, float(delta)))
        new_score = max(0.0, min(1.0, score + clamped))
        self.conn.execute(
            "INSERT INTO mastery(kp_id, score, attempts, correct, last_seen_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(kp_id) DO UPDATE SET score=excluded.score, "
            "attempts=excluded.attempts, correct=excluded.correct, last_seen_at=excluded.last_seen_at",
            (
                kp_id,
                new_score,
                attempts + 1,
                correct_cnt + (1 if correct else 0),
                int(time.time()),
            ),
        )
        self.conn.commit()
        return new_score

    def mastered_kp_ids(self, threshold: float = 0.6) -> list[str]:
        rows = self.conn.execute(
            "SELECT kp_id FROM mastery WHERE score >= ? ORDER BY score DESC, kp_id",
            (float(threshold),),
        ).fetchall()
        return [str(r["kp_id"]) for r in rows]

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
          不再自己写 ``SELECT key, value FROM profile_pref`` —— 与 :meth:`set_preference`
        rows = self.conn.execute("SELECT key, value FROM profile_pref").fetchall()
    def set_preference(self, key: str, value: str) -> None:
        """写一条学习偏好（**幂等 upsert**：同 key 覆盖，不追加）。
        ``key`` 由调用方（契约的 ``PreferenceKey``）保证是封闭词表 —— 本方法**不再校验**，
          永远不需要清理逻辑，也没有「攒了几百条偏好把每轮 Prompt 挤爆」这条路径。
            "INSERT INTO profile_pref(key, value) VALUES(?, ?) "
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
        self.conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) VALUES(?,?,?,?,?)",
            (int(time.time()), session_id, signal_type, float(value), raw),
        )
        self.conn.commit()

    def grade_history(self, *, limit: int = 200) -> list[GradeHistoryRecord]:
        """读 ``grade_history`` 轨迹（**按时间正序**，最早的在前）。
        ★ 正序：报告要讲的是「**怎么变成现在这个学段**」这条线，
        ★ 与 ``app/grade/rules.py`` 的 ``GradeEngine.history()`` 是两个用途：
            "SELECT id, ts, turn, from_level, to_level, source, confidence "
            "FROM grade_history ORDER BY id DESC LIMIT ?",
            GradeHistoryRecord(
                from_level=None if row["from_level"] is None else str(row["from_level"]),
                to_level=str(row["to_level"] or ""),
    def close(self) -> None:
        self.conn.close()


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
    "GeneratedQuestionRecord",
    "LearningStore",
    "MASTERY_DELTA_LIMIT",
    "ProgressRecord",
    "QUIZ_MIGRATIONS",
    "QUIZ_MIGRATION_SET",
    "StudentRecord",
]
