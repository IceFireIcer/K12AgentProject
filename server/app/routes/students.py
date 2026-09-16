"""``GET`` / ``POST /api/students``（§6.3）：学生列表与新建（含学段）。

**薄控制器**：解析 → 调存储 → 序列化契约模型；``student_id`` 与时间戳由服务端生成。

⚠️ **持久化是占位实现（票 04 明确许可）**：票 04 只冻结契约形状（`Student` /
`StudentCreateRequest`）。真实落地按票 09 —— 落 ``userData/students/<id>/``，
**一人一库**（``learning.db``），不跨学生复用连接与数据（AGENTS §5.8，合规硬伤项）。
替换方式：用 `app.state.students_store` 注入实现了 {@link StudentStore} 的对象，
本文件的路由代码不需要改。

**不要在这里做学段推断**：学段以显式选择为权威（AGENTS §5.1），自动推断只写建议。
"""

from __future__ import annotations

import threading
import time
from typing import Protocol

from fastapi import APIRouter, Request

from app.contracts import GradeLevel, Student, StudentCreateRequest

router = APIRouter(prefix="/api", tags=["students"])

#: 注入点：测试与票 09 都通过 `app.state.students_store` 替换实现。
STUDENTS_STORE_ATTR = "students_store"

#: 学生 ID 前缀（§8.2 目录示例：`students/student_001/`）
STUDENT_ID_PREFIX = "student_"
STUDENT_ID_WIDTH = 3


def _now_ms() -> int:
    """Unix 毫秒（与 JS ``Date.now()`` 同尺度）。"""
    return int(time.time() * 1000)


class StudentStore(Protocol):
    """学生存储接口（票 09 换成 `learning.db` 实现，接口不变）。"""

    def list_students(self) -> list[Student]: ...

    def create_student(self, *, nickname: str, grade_level: GradeLevel) -> Student: ...


class InMemoryStudentStore:
    """占位实现：进程内存里存一份（重启即失）。

    **只服务于票 04 的契约形状验证**；票 09 用「一人一库」替换它之后，
    「重启应用后学习记录仍在」才会成立。
    """

    def __init__(self) -> None:
        self._students: list[Student] = []
        self._lock = threading.Lock()

    def list_students(self) -> list[Student]:
        with self._lock:
            return list(self._students)

    def create_student(self, *, nickname: str, grade_level: GradeLevel) -> Student:
        with self._lock:
            student = Student(
                student_id=f"{STUDENT_ID_PREFIX}{len(self._students) + 1:0{STUDENT_ID_WIDTH}d}",
                nickname=nickname,
                grade_level=grade_level,
                created_at=_now_ms(),
                last_active_at=_now_ms(),
            )
            self._students.append(student)
            return student


def get_students_store(request: Request) -> StudentStore:
    """取存储实现：优先 `app.state.students_store`（可由测试/票 09 注入）。"""
    store = getattr(request.app.state, STUDENTS_STORE_ATTR, None)
    if store is None:
        store = InMemoryStudentStore()
        setattr(request.app.state, STUDENTS_STORE_ATTR, store)
    return store


@router.get("/students", response_model=list[Student], summary="学生列表")
def list_students(request: Request) -> list[Student]:
    return get_students_store(request).list_students()


@router.post("/students", response_model=Student, summary="新建学生（含学段）")
def create_student(payload: StudentCreateRequest, request: Request) -> Student:
    """新建学生。请求体校验（含四学段字面量）由契约模型完成，非法学段直接 422。"""
    return get_students_store(request).create_student(
        nickname=payload.nickname.strip(),
        grade_level=payload.grade_level,
    )
