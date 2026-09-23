"""``GET`` / ``POST /api/students``（§6.3）：学生列表与新建（含学段）+ **学生目录的归口解析**。

**薄控制器**：解析 → 调存储 → 序列化契约模型；``student_id`` 与时间戳由服务端生成。

★ 票 09 落地（本文件的两项职责）：

1. **一人一库**：学生数据落在 ``<userData>/students/<id>/``，每人一份 ``learning.db``；
   ``LearningDbStudentStore`` 用 :class:`app.store.learning.LearningStore` 读写
   （**复用**，不在这里另写 DDL），每次用完立刻关连接 —— **不跨学生复用连接或数据**（AGENTS §5.8）。
2. **学生目录的归口解析**：``student_dir`` / ``student_learning_db_path`` / ``validate_student_id``
   是本模块对外提供的公共函数，其它轨（练习判分、画像、学段）**请调用它们**，
   不要在各自文件里再拼一遍 ``students/<id>/learning.db`` —— 路径拼两处，迟早有一处忘记做
   白名单校验，那就是「HTTP 上的任意文件读写」。

与桌面端的对齐：``students/<id>/pi-agent/`` 由桌面端建
（``desktop/src/main/agent/pi-paths.ts`` 的 ``ensureStudentPiDirs``），本模块只建学生目录与
``learning.db``，避免两处各建一遍目录。``STUDENT_DIR_NAME`` / ``LEARNING_DB_NAME`` 的取值
必须与那边的 ``STUDENTS_DIR_NAME`` / ``LEARNING_DB_NAME`` 保持一致。

**学段不由这里决定**：学段来自**服务端推断**（``app/grade/rules.py`` 的规则引擎，
D-020：自动推断、自动生效），学生在界面上**没有选择入口**、只有只读指示器。
本模块的 ``create_student`` 仍带 ``gradeLevel``，但它只是**冷启动默认值**（新建学生的初始档），
此后一切变更都由 ``POST /api/grade/turns`` 走规则引擎写入。
"""

from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import Protocol, Sequence

from fastapi import APIRouter, HTTPException, Request

from app.contracts import GradeLevel, Student, StudentCreateRequest
from app.store.learning import LearningStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["students"])

#: 注入点：测试与其它轨都通过 `app.state.students_store` 替换实现。
STUDENTS_STORE_ATTR = "students_store"

#: 学生 ID 前缀（§8.2 目录示例：`students/student_001/`）
STUDENT_ID_PREFIX = "student_"
STUDENT_ID_WIDTH = 3

#: 学生目录名（与 `desktop/src/main/agent/pi-paths.ts` 的 `STUDENTS_DIR_NAME` 对齐）
STUDENT_DIR_NAME = "students"

#: 每人一份的学习记录库名（与桌面端 `LEARNING_DB_NAME` 对齐）
LEARNING_DB_NAME = "learning.db"

#: ★ 学生 id 白名单：它会被拼进文件系统路径，必须挡在**做路径拼接之前**。
#: 规则与桌面端 `pi-paths.ts` 的 `STUDENT_ID_PATTERN` 逐字一致（两边都挡，谁也别指望对方）。
STUDENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: 冷启动兜底学段：正常路径一定先 `POST /api/students`（学段必填），
#: 只有「直接写学习记录但学生还没建」这种异常顺序才会用到它。
#:
#: ★★ **2026-09-22 由「小学高年级」改成「初中」**（用户裁决，见 D-073）：
#: 没判定之前先按初中讲，再由 LLM 判定接手。理由有两条：
#:   ① **四档里偏下的两档（小学低/高）与偏上的两档（初中/高中）讲法差别最大** ——
#:      从初中起步，判小了往下调一档（内容不会突然难到看不懂），
#:      而从小高起步去讲高中内容，学生会直接看不懂；
#:   ② **小学高年级是个「偏小」的默认值**：它会让第一轮的回答偏幼稚，
#:      而 K12 场景里「被当小孩」比「被当大孩」更伤体验。
#: ⚠️ 它是**兜底**而不是「判定结果」：`grade_history` 那条基线行的 `decided_by` 仍是空，
#:   界面照旧显示「待判定」，不冒充任何一层引擎的结论（D-066）。
DEFAULT_COLD_START_GRADE: GradeLevel = "junior"

#: 冷启动建行时的**默认昵称**（与桌面端同一口径：``desktop/src/main/ipc/handlers-data.ts``
#: 的建号请求带的就是 ``nickname: '同学'``）。
#:
#: ★★ 为什么必须非空：``student.nickname`` 是**显示字段**，它会经 ``/api/students``（侧栏
#:    与问候语）、``GET /api/profile/{id}``、``GET /api/profile/{id}/report``（学习记录页，
#:    还会被导出件带上）一路走到界面上。落一个空串下去，界面要么留白、要么回落到
#:    ``student_001`` 这种**内部主键** —— 而内部 id 出现在学生面前是双视角纪律的违规
#:    （D-063：学生面禁内部 id）。「同学」是与「不采集真实姓名」（§12 数据最小化）
#:    配套的中性称呼，也是渲染侧（``stores/student.ts`` 的 ``nickname`` computed）
#:    的同名回落值 —— 两边取的是**同一个词**，所以哪一侧先兜住，学生看到的都一样。
#:
#: ⚠️ 它只约束**写入**。契约的出参默认值（``contracts.LearningReport.nickname: str = ""``）
#:    不动：那是一个**为旧数据留的兜底**，改它会牵 ``export_openapi`` → ``gen:api``
#:    → TS 类型与 ``check:api``（本次刻意不碰契约）。
#:
#: ★ 谁在用它：``app/grade/rules.py`` 的 ``ensure_student``（学段引擎的冷启动）与
#:   ``app/routes/profile.py`` 的四处冷启动建行（推荐 / 开场 / 学习记录 / 偏好）。
#:   ``POST /api/students`` **不需要**它 —— 那条路的昵称由契约校验器把着
#:   （``StudentCreateRequest._strip_nickname`` 对空白抛 ``ValueError`` → 422），
#:   所以这里也不给它加「空就当默认」的兜底（那是一段永远走不到的代码）。
DEFAULT_STUDENT_NICKNAME = "同学"


def _now_ms() -> int:
    """Unix 毫秒（与 JS ``Date.now()`` 同尺度）。"""
    return int(time.time() * 1000)


def to_contract_ms(seconds: int | None) -> int:
    """``learning.db`` 的时间戳（**秒**）→ 契约 ``Student.createdAt``（**毫秒**）。

    ★ 两个单位并存是事实：``app/store/learning.py`` 用 ``int(time.time())``（秒），
    而契约的 ``created_at`` / ``last_active_at`` 明确写着「Unix 毫秒，与 JS Date.now() 同尺度」。
    转换只在这一个函数里做，别让两边各自猜单位（猜错的形态是「时间显示成 1970 年」）。
    """
    return int(seconds or 0) * 1000


# --------------------------------------------------------------------------- #
# 学生目录（归口解析）
# --------------------------------------------------------------------------- #
def students_root(data_dir: str | Path) -> Path:
    """``<data-dir>/students``。"""
    return Path(data_dir) / STUDENT_DIR_NAME


def validate_student_id(student_id: str) -> str:
    """校验学生 id；不合法抛 **422**（与 ``app/routes/quiz.py`` 的同一口径）。

    ★ 必须在**任何路径拼接之前**调用。放行 ``../`` 就等于把「选学生」变成「按 id 读写任意文件」，
    而学生 id 来自 HTTP 请求体 / 渲染进程，属于不可信输入。
    """
    if not isinstance(student_id, str) or not STUDENT_ID_RE.match(student_id):
        raise HTTPException(
            status_code=422,
            detail="studentId 不合法（只允许字母、数字、下划线、连字符，长度 1–64）",
        )
    return student_id


def student_dir(data_dir: str | Path, student_id: str) -> Path:
    """``<data-dir>/students/<student_id>``（一名学生的本地数据根）。"""
    return students_root(data_dir) / validate_student_id(student_id)


def student_learning_db_path(data_dir: str | Path, student_id: str) -> Path:
    """``<data-dir>/students/<student_id>/learning.db``（执行文档 §8.2，一人一库）。"""
    return student_dir(data_dir, student_id) / LEARNING_DB_NAME


def student_pi_agent_dir(data_dir: str | Path, student_id: str) -> Path:
    """``<data-dir>/students/<student_id>/pi-agent``（Pi 的 JSONL 会话目录，§8.1）。

    **只解析路径、不建目录** —— 建目录是桌面端 `ensureStudentPiDirs` 的职责；
    这里暴露它是为了让服务端也能断言「会话确实写在学生目录里」（验收用）。
    """
    return student_dir(data_dir, student_id) / "pi-agent"


def list_student_ids(data_dir: str | Path) -> list[str]:
    """扫 ``<data-dir>/students/`` 下的学生 id（按名称排序，**只返回合法 id**）。"""
    root = students_root(data_dir)
    if not root.is_dir():
        return []
    return sorted(
        entry.name
        for entry in root.iterdir()
        if entry.is_dir() and STUDENT_ID_RE.match(entry.name)
    )


def open_learning_store(data_dir: str | Path, student_id: str) -> LearningStore:
    """开这个学生的 ``learning.db``（**一人一连接**；调用方负责 ``close()``）。

    ``LearningStore.__init__`` 会跑一遍幂等迁移器：新学生首次使用时自动建表（冷启动兜底），
    重复打开不报错、不重复建表（``schema_version`` 记账）。
    """
    path = student_learning_db_path(data_dir, student_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    return LearningStore(path)


# --------------------------------------------------------------------------- #
# 存储实现
# --------------------------------------------------------------------------- #
class LearningDbStudentStore:
    """一人一库的学生存储（票 09 的真实实现）。

    - ``list_students``：逐个打开学生库读 `student` 表，**读完立刻关**（不复用连接）；
    - ``create_student``：分配下一个空闲 ``student_%03d``，建目录 + 建库 + 写学生行；
    - ``get_student``：读单个学生行。

    没有全局连接池是有意的：一人一库的意义就是任何时刻都不存在「多个学生共用一条连接」的状态。
    学生数量级是「一台机器上的几个孩子」，逐个开库的代价可以忽略。
    """

    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir)

    # ------------------------------------------------------------ 读 --
    def list_students(self) -> list[Student]:
        students: list[Student] = []
        for student_id in list_student_ids(self.data_dir):
            student = self.get_student(student_id)
            if student is not None:
                students.append(student)
        return students

    def get_student(self, student_id: str) -> Student | None:
        validate_student_id(student_id)
        path = student_learning_db_path(self.data_dir, student_id)
        if not path.exists():
            return None
        store = LearningStore(path)
        try:
            record = store.get_student(student_id)
        finally:
            store.close()
        if record is None:
            return None
        return Student(
            student_id=record.student_id,
            nickname=record.nickname,
            grade_level=as_grade_level(record.grade_level),
            created_at=to_contract_ms(record.created_at),
            last_active_at=to_contract_ms(record.last_active_at),
        )

    # ------------------------------------------------------------ 写 --
    def create_student(self, *, nickname: str, grade_level: GradeLevel) -> Student:
        existing = set(list_student_ids(self.data_dir))
        student_id = self._next_student_id(existing)
        store = open_learning_store(self.data_dir, student_id)
        try:
            created = store.upsert_student(student_id, nickname=nickname, grade_level=grade_level)
        finally:
            store.close()
        logger.info("已创建学生 %s（学段 %s），库路径 %s", student_id, grade_level, student_learning_db_path(self.data_dir, student_id))
        return Student(
            student_id=created.student_id,
            nickname=created.nickname,
            grade_level=as_grade_level(created.grade_level),
            created_at=to_contract_ms(created.created_at),
            last_active_at=to_contract_ms(created.last_active_at),
        )

    def _next_student_id(self, existing: set[str]) -> str:
        """下一个空闲 id（``student_001`` 起，跳过已被占用的号）。"""
        index = 1
        while True:
            candidate = f"{STUDENT_ID_PREFIX}{index:0{STUDENT_ID_WIDTH}d}"
            if candidate not in existing:
                return candidate
            index += 1
            if index > 100_000:  # 防御：目录被人塞满时不要死循环
                raise RuntimeError("学生 id 分配失败：编号已用尽（超过 100000）")


def as_grade_level(value: str) -> GradeLevel:
    """库里读到的学段字符串 → 契约字面量。

    ★ 库里的值可能是旧版本写的（或人工改过的），**不能**直接当 ``GradeLevel`` 用
    （pydantic 会在序列化时 422/500，用户看到的是「学生列表打不开」）。
    非四学段之一时退到冷启动默认值，并把脏值记日志。
    """
    allowed: Sequence[str] = ("primary_low", "primary_high", "junior", "senior")
    if value in allowed:
        return value  # type: ignore[return-value]
    logger.warning("学生学段取值非法（%r），已按 %s 处理", value, DEFAULT_COLD_START_GRADE)
    return DEFAULT_COLD_START_GRADE


class InMemoryStudentStore:
    """占位实现：进程内存里存一份（重启即失）。

    **只服务于契约形状验证与单测**（注入 ``app.state.students_store`` 即可替换成它）；
    真实运行走 :class:`LearningDbStudentStore`（一人一库），「重启后学习记录仍在」靠它成立。
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


class StudentStore(Protocol):
    """学生存储接口（两个实现都满足；测试与其它轨通过 ``app.state`` 注入）。"""

    def list_students(self) -> list[Student]: ...

    def create_student(self, *, nickname: str, grade_level: GradeLevel) -> Student: ...


def get_students_store(request: Request) -> StudentStore:
    """取存储实现。

    优先级：``app.state.students_store``（测试/其它轨注入）→ 由 ``app.state.config.data_dir``
    构造的一人一库实现（**真实运行的路径**）→ 内存占位（没有显式 data-dir 时）。
    """
    store = getattr(request.app.state, STUDENTS_STORE_ATTR, None)
    if store is not None:
        return store
    data_root = resolve_student_data_root(request)
    if data_root is not None:
        store = LearningDbStudentStore(data_root)
    else:
        logger.warning(
            "未显式传入 --data-dir：学生存储退回内存占位实现（重启即失）。"
            "Electron 启动 sidecar 时必然传 <userData>，所以这条只会出现在手工调试里。"
        )
        store = InMemoryStudentStore()
    setattr(request.app.state, STUDENTS_STORE_ATTR, store)
    return store


def get_data_dir(request: Request) -> Path | None:
    """取 ``<data-dir>``（Electron 传的 ``userData``）；没有运行配置时返回 ``None``。

    画像/学习记录路由与 :func:`get_students_store` 共用它，避免两处各猜一次配置从哪来。
    """
    config = getattr(request.app.state, "config", None)
    data_dir = getattr(config, "data_dir", None) if config is not None else None
    return Path(data_dir) if data_dir is not None else None


def resolve_student_data_root(request: Request) -> Path | None:
    """★ 学生数据的根：**只有 data-dir 是显式传入时才返回它**，否则返回 ``None``。

    为什么必须有这条判断：``app.config.resolve_data_dir(None)`` 的兜底值是
    ``server/_data``（打包态是 ``<exe 同级>/_data``）—— 那是个**共享**目录：
    手工 curl、单测、连续多次运行都会写到同一个 ``students/`` 下。
    把「共享目录」当学生数据根，等于把不同来源的数据混进同一棵学生目录树，
    既不符合「一人一库」的语义，也会让测试之间互相污染
    （实测：跑一次单测就在仓库里留下 12 个学生目录，另外「学生列表初始为空」的契约测试因此变红）。

    Electron 启动 sidecar 时**必然**传 ``--data-dir <userData>``（票 02），
    所以真实运行路径永远走显式分支。
    """
    from app.config import resolve_data_dir  # noqa: PLC0415 - 避免模块层循环 import

    data_dir = get_data_dir(request)
    if data_dir is None:
        return None
    try:
        if data_dir.resolve() == resolve_data_dir(None).resolve():
            return None
    except OSError:  # pragma: no cover - 路径解析失败时按显式处理更安全
        return data_dir
    return data_dir


def require_data_dir(request: Request) -> str:
    """★ 各条**按学生存数据**的路由统一用它取 ``<data-dir>``；取不到就 503。

    **归口理由**：没显式传 ``--data-dir`` 时 :func:`resolve_student_data_root` 会返回 ``None``
    （兜底值是共享的 ``server/_data``，见它的说明）。不同路由必须给同一个口径，
    否则会出现「画像路由拒收、练习路由却把学生的掌握度写进仓库里的共享目录」这种
    半隔离状态 —— 实测踩到过（跑一次单测就在仓库里留下 12 个学生目录）。

    503 而**不是**静默兜底：这是**配置缺失**（Electron 没传参数），不是学生数据的问题，
    调用方（编排层）据此提示用户重启应用，而不是让他看到一份「凭空清空」的学习记录。
    错误文案带上 ``data-dir`` 字样，便于日志与 UI 直接定位。
    """
    data_root = resolve_student_data_root(request)
    if data_root is None:
        raise HTTPException(
            status_code=503,
            detail="sidecar 未配置 data-dir：无法定位学生数据目录（应由 Electron 经 --data-dir 传入 <userData>）",
        )
    return str(data_root)


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
@router.get("/students", response_model=list[Student], summary="学生列表")
def list_students(request: Request) -> list[Student]:
    return get_students_store(request).list_students()


@router.post("/students", response_model=Student, summary="新建学生（含学段）")
def create_student(payload: StudentCreateRequest, request: Request) -> Student:
    """新建学生。请求体校验（含四学段字面量）由契约模型完成，非法学段直接 422。

    落盘位置：``<userData>/students/<id>/learning.db``（一人一库，§8.2）。
    """
    return get_students_store(request).create_student(
        nickname=payload.nickname.strip(),
        grade_level=payload.grade_level,
    )


__all__ = [
    "DEFAULT_COLD_START_GRADE",
    "DEFAULT_STUDENT_NICKNAME",
    "InMemoryStudentStore",
    "LEARNING_DB_NAME",
    "LearningDbStudentStore",
    "STUDENTS_STORE_ATTR",
    "STUDENT_DIR_NAME",
    "STUDENT_ID_RE",
    "StudentStore",
    "get_data_dir",
    "get_students_store",
    "list_student_ids",
    "open_learning_store",
    "require_data_dir",
    "resolve_student_data_root",
    "router",
    "student_dir",
    "student_learning_db_path",
    "student_pi_agent_dir",
    "students_root",
    "as_grade_level",
    "to_contract_ms",
    "validate_student_id",
]
