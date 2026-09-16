"""``learning.db``（**每人一份**）的建库与仓储。

数据层的三处分离（执行文档 §8.1）：对话正文归 Pi 的 JSONL 会话树，
**SQLite 不存对话内容**，这里只放从对话中提取出来的结构化学习数据。

一人一库是合规硬约束：**不同学生的画像/掌握度绝不能共用一个库文件**，
所以本模块只提供「按路径开库」的能力，不持有任何全局连接。

> 归口说明：``app/store/**`` 属数据轨。画像/学段/练习各轨**请复用本模块**，
> 不要另起一套 ``CREATE TABLE`` —— 同一个库两份 DDL 是最难查的那类故障。
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from app.store.connections import connect
from app.store.migrations import ensure_learning

logger = logging.getLogger(__name__)

# 掌握度单次变更的限幅（业务陷阱清单 §5）：不限幅的话一次答对就能从 0 跳到 1，
# 之后「推荐下一步」直接失去意义。
MASTERY_DELTA_LIMIT = 0.2


@dataclass(frozen=True)
class StudentRecord:
    student_id: str
    nickname: str
    grade_level: str
    created_at: int
    last_active_at: int


class LearningStore:
    """一个学生的 ``learning.db`` 读写入口。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.conn = connect(self.path, load_vec=False, wal=True, check_same_thread=False)
        ensure_learning(self.conn)

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
        """写一条学段信号（自动推断用；**只写建议**，改学段须学生确认）。"""
        self.conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) VALUES(?,?,?,?,?)",
            (int(time.time()), session_id, signal_type, float(value), raw),
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
