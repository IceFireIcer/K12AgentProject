"""``GET /api/quiz/bank/{kp_id}`` + ``POST /api/quiz/grade``（票 14：练习 Extension 的服务端）。

两条端点各自只做一件事，且都守住同一条红线：**标准答案出不了 Python**。

| 端点 | 做什么 | 红线 |
| --- | --- | --- |
| ``GET /api/quiz/bank/{kp_id}`` | 按知识点 + 学段从题库取题 | 返回的是 :class:`QuizQuestionOut`（**没有** ``answer``）；内部 :class:`QuizQuestion` 一步都不出这个文件 |
| ``POST /api/quiz/grade`` | 按 ``qid`` 查库 → 规则判分 → 写掌握度与学习记录 | 判分**只在这里**做；请求里的 ``answer`` 是学生的作答，不是标准答案 |

**为什么判分必须留在这里**（执行文档 §6.3 的答案泄漏防护）：前端拿到题面就能作答，
只有「拿学生的作答去和库里的答案比」这一步必须留在后端；一旦把答案下发给前端、
或者让前端本地判分，答案就等于公开 —— 题目当场作废，`mastery` 也不再可信。

**题库**：``server/resources/quizbank/<grade_level>.json``（人工编写、随包分发、断网可用）。
LLM 生成的变式题（``source="generated"``）由票 15 的路径产生，本票只留衔接位：
生成题在题库里查不到 ``qid`` 时，``/api/quiz/grade`` 返回可读的 404 而不是 500。

**判分口径（客观题，``scored_by="rule"``）**：choice / blank / code_blank 三类都走
:func:`normalize_answer` 归一化后比较 —— 空白、全角、大小写、中英文标点一律等价
（业务陷阱清单 §「客观题误判」）。归一化只影响**比较**，不影响落库与回显。
"""

from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from fastapi import APIRouter, HTTPException, Query, Request

from app.config import KNOWLEDGE_DIR, RESOURCES_DIR
from app.contracts import (
    MASTERY_DELTA_LIMIT,
    GradeLevel,
    QuizGradeRequest,
    QuizPayload,
    QuizQuestion,
    QuizQuestionOut,
    QuizResult,
)
from app.knowledge.library import GRADE_LEVELS, compatible_grades, grade_index, load_terminology
from app.store.learning import LearningStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["quiz"])

# ---------------------------------------------------------------- 常量 --
#: 题库目录名（``server/resources/quizbank/``）
QUIZ_BANK_DIRNAME = "quizbank"
#: ``app.state`` 上的题库目录注入点（测试与演示用临时题库）
BANK_DIR_STATE_ATTR = "quiz_bank_dir"
#: 环境变量覆盖（演示时指向「故意少题」的那一份）
BANK_DIR_ENV = "K12_QUIZ_BANK_DIR"

DEFAULT_QUESTION_COUNT = 3
MAX_QUESTION_COUNT = 10

#: 一次答对/答错的掌握度变化。**绝对值必须 < MASTERY_DELTA_LIMIT**，
#: 并且 :meth:`app.store.learning.LearningStore.apply_mastery` 还会再限幅一次
#: （陷阱：不限幅则一次答题就从 0 直接到 1）。
MASTERY_GAIN_CORRECT = 0.15
MASTERY_LOSS_WRONG = 0.10

#: 选择题选项序号（学生可能提交 ``B``、也可能提交选项原文，两种都要认）
_OPTION_LETTERS = "ABCDEF"

#: 学生 id 白名单：它会被拼进文件路径（``students/<id>/learning.db``），
#: **必须**先卡死字符集，否则 ``../../`` 就能跑到别的目录去建库（本机任意文件写入）。
STUDENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: 中文标点 → ASCII（NFKC 覆盖不到 ``、`` ``。`` ``“`` 这类 CJK 标点，单独补一张表）
_PUNCT_TRANSLATION = str.maketrans(
    {
        "，": ",",
        "。": ".",
        "、": ",",
        "；": ";",
        "：": ":",
        "（": "(",
        "）": ")",
        "【": "[",
        "】": "]",
        "《": "<",
        "》": ">",
        "“": '"',
        "”": '"',
        "‘": "'",
        "’": "'",
        "！": "!",
        "？": "?",
        "－": "-",
        "—": "-",
        "…": ".",
        "～": "~",
        "　": " ",
    }
)


# ---------------------------------------------------------------- 归一化 --
def normalize_answer(value: str) -> str:
    """把一段答案归一化成**只保留语义**的形式（比较用，不落库、不回显）。

    依次做四件事：NFKC（全角→半角、兼容字符）、中文标点转 ASCII、大小写折叠、去掉全部空白。

    - 空白差异（``1 到 5`` vs ``1到5``）、引号差异（``"x"`` vs ``“x”``）、
      全角括号（``（1）`` vs ``(1)``）都会归一成同一个串，因此不会误判；
    - 去掉空白是有意的：代码填空里 ``x = 1`` 与 ``x=1`` 必须等价；
    - 末尾分号一并去掉（``x += 1;`` 与 ``x += 1`` 等价）。
    """
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.translate(_PUNCT_TRANSLATION)
    text = text.casefold()
    text = "".join(text.split())
    return text.rstrip(";")


def _as_list(value: str | Sequence[str]) -> list[str]:
    """把 ``str | list[str]`` 统一成 list（契约里这两种形态都合法）。"""
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value]


def _choice_variants(value: str, options: Sequence[str]) -> set[str]:
    """选择题一个值的全部等价写法：字母 ``B`` ⇄ 选项原文。

    学生可能填字母，也可能把选项整句抄进来；两种都算对，且不接受「半截选项」。
    """
    token = normalize_answer(value)
    variants = {token} if token else set()
    if len(token) == 1:
        index = _OPTION_LETTERS.find(token.upper())
        if 0 <= index < len(options):
            variants.add(normalize_answer(options[index]))
    else:
        for index, option in enumerate(options):
            if normalize_answer(option) == token and index < len(_OPTION_LETTERS):
                variants.add(_OPTION_LETTERS[index].casefold())
    return variants


def is_correct_answer(
    question: QuizQuestion, submitted: str | Sequence[str]
) -> bool:
    """客观题规则判分（``scored_by="rule"``）。**唯一判分入口。**"""
    expected = _as_list(question.answer)
    got = _as_list(submitted)

    if question.type == "choice":
        options = question.options or []
        accepted: set[str] = set()
        for value in expected:
            accepted |= _choice_variants(value, options)
        given: set[str] = set()
        for value in got:
            given |= _choice_variants(value, options)
        return bool(accepted & given)

    # blank / code_blank：多空时按位置逐空比对；单空时「任一可接受答案」都算对。
    if len(expected) > 1 and len(got) > 1:
        if len(expected) != len(got):
            return False
        return all(
            normalize_answer(want) == normalize_answer(has)
            for want, has in zip(expected, got)
        )
    accepted = {normalize_answer(value) for value in expected}
    return any(normalize_answer(value) in accepted for value in got)


def feedback_for(question: QuizQuestion, correct: bool) -> str:
    """面向学生的中文反馈。**绝不回显标准答案**（回显等于送答案）。"""
    if correct:
        return f"答对了！{question.explanation}"
    return f"这次还差一点，先看看思路：{question.explanation} 想一想再选一次吧。"


# ---------------------------------------------------------------- 超纲自检 --
def out_of_scope_terms(text: str, grade_level: str) -> list[str]:
    """题干里出现了**高于该学段**的术语 → 返回这些术语（空列表 = 合格）。

    术语文表就是教材自检用的那一份（``knowledge/terminology.json``，票 10），
    判据同 :func:`app.knowledge.checker.audit_library`：``min_grade`` 高于目标学段即超纲。
    小学低年级题干里的「算法」「特征向量」属于**明确点名**的验收口径（票 14）。
    """
    if grade_level not in GRADE_LEVELS:
        return []
    try:
        terminology = load_terminology(KNOWLEDGE_DIR)
    except Exception as exc:  # noqa: BLE001 - 表缺失不该让取题失败，只是失去自检能力
        logger.warning("术语文表不可用，跳过超纲自检：%s", exc)
        return []
    try:
        rank = grade_index(grade_level)
    except (KeyError, ValueError):
        return []

    hits: list[str] = []
    for entry in terminology.get("terms") or []:
        if not isinstance(entry, dict):
            continue
        term = str(entry.get("term") or "")
        if not term or term not in text:
            continue
        min_grade = str(entry.get("min_grade") or "primary_low")
        if min_grade in GRADE_LEVELS and rank < grade_index(min_grade):
            hits.append(term)
    return hits


# ---------------------------------------------------------------- 题库 --
@dataclass(frozen=True)
class BankEntry:
    """一条题库记录：内部题（含答案）+ 它来自哪个学段文件。"""

    question: QuizQuestion
    grade_level: str


@dataclass
class BankReport:
    """加载报告（供日志与测试断言「题库本身是干净的」）。"""

    entries: list[BankEntry] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    out_of_scope: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)

    @property
    def questions(self) -> list[QuizQuestion]:
        return [entry.question for entry in self.entries]


def default_bank_dir() -> Path:
    """题库目录（``K12_QUIZ_BANK_DIR`` 可覆盖，便于演示与排障）。"""
    override = os.environ.get(BANK_DIR_ENV)
    if override:
        return Path(override)
    return RESOURCES_DIR / QUIZ_BANK_DIRNAME


def bank_dir_for(request: Request) -> Path:
    """路由取题库目录：``app.state.quiz_bank_dir`` 优先（测试注入），否则用默认目录。"""
    injected = getattr(request.app.state, BANK_DIR_STATE_ATTR, None)
    return Path(injected) if injected else default_bank_dir()


def load_bank(bank_dir: str | Path) -> BankReport:
    """读整个题库目录并逐题校验。

    **坏题只跳过、不抛异常**：现场演示时题库里一条手滑的记录不该让「出题」整条链路挂掉；
    跳过的 qid 与原因都进日志。超纲（术语高于本学段）只记录、不剔除 ——
    题库是人工编写的，需要人看到报告去改；LLM 生成的题由票 15 在生成侧直接拒。
    """
    report = BankReport()
    root = Path(bank_dir)
    if not root.is_dir():
        logger.warning("题库目录不存在：%s（取题将全部落空）", root)
        return report

    for path in sorted(root.glob("*.json")):
        report.files.append(path.name)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            report.skipped.append(f"{path.name}: 无法解析（{exc}）")
            logger.warning("题库文件无法解析，已跳过：%s（%s）", path, exc)
            continue

        declared_grade = str(raw.get("grade_level") or "")
        if declared_grade not in GRADE_LEVELS:
            report.skipped.append(f"{path.name}: grade_level 非法（{declared_grade!r}）")
            logger.warning("题库文件学段非法，整文件跳过：%s（%r）", path, declared_grade)
            continue

        questions = raw.get("questions") or []
        if not isinstance(questions, list):
            report.skipped.append(f"{path.name}: questions 不是数组")
            continue

        for item in questions:
            try:
                question = QuizQuestion.model_validate(item)
            except Exception as exc:  # noqa: BLE001 - pydantic ValidationError 的字段名已在消息里
                qid = item.get("qid") if isinstance(item, dict) else None
                report.skipped.append(f"{path.name}/{qid or '?'}: {exc}")
                logger.warning("题库坏题已跳过：%s/%s（%s）", path.name, qid, exc)
                continue
            if question.type == "choice" and not question.options:
                report.skipped.append(f"{path.name}/{question.qid}: 选择题没有 options")
                logger.warning("选择题缺少选项，已跳过：%s", question.qid)
                continue
            report.entries.append(BankEntry(question=question, grade_level=declared_grade))

    for entry in report.entries:
        # 题干 + 选项 + 解析都算「学生看得到的文本」，一起过超纲自检
        parts = [entry.question.stem, entry.question.explanation, *(entry.question.options or [])]
        offending = out_of_scope_terms("\n".join(parts), entry.grade_level)
        if offending:
            report.out_of_scope.append(f"{entry.question.qid}: {'、'.join(offending)}")
            logger.warning(
                "题库超纲（%s）：%s 出现 %s", entry.grade_level, entry.question.qid, offending
            )
    return report


def find_question(entries: Iterable[BankEntry], qid: str) -> QuizQuestion | None:
    """按 ``qid`` 查题（判分用；题库是唯一来源）。"""
    for entry in entries:
        if entry.question.qid == qid:
            return entry.question
    return None


def select_questions(
    report: BankReport,
    *,
    kp_id: str,
    grade_level: str,
    count: int = DEFAULT_QUESTION_COUNT,
    allow_compat: bool = True,
) -> list[BankEntry]:
    """取题：**先本学段，再按向上兼容顺序取更低学段**，同一学段内保持文件顺序。

    学段方向与检索一致（§8.5）：只允许取**不高于**学生学段的内容；
    初中生取不到高中题（超纲），高中生可以回看初中的题（巩固）。
    """
    if kp_id:
        candidates = [entry for entry in report.entries if entry.question.kp_id == kp_id]
    else:
        candidates = list(report.entries)

    order = compatible_grades(grade_level) if allow_compat else [grade_level]
    rank = {grade: index for index, grade in enumerate(order)}

    def sort_key(indexed: tuple[int, BankEntry]) -> tuple[int, int]:
        index, entry = indexed
        # 不在兼容链上的学段（= 更高学段）排到最后并被下面的过滤丢掉
        return rank.get(entry.grade_level, len(order)), index

    ordered = [
        entry
        for _, entry in sorted(enumerate(candidates), key=sort_key)
        if entry.grade_level in rank
    ]
    return ordered[: max(1, min(int(count), MAX_QUESTION_COUNT))]


# ---------------------------------------------------------------- 学生库 --
def student_db_path(data_dir: str | Path, student_id: str) -> Path:
    """``<data-dir>/students/<student_id>/learning.db``（执行文档 §8.2，一人一库）。

    ``student_id`` 先过白名单再做路径拼接：这个值来自请求体，直接拼路径等于把
    「本机任意文件写入」的口子开在 HTTP 上。

    ⚠️ 归口说明：票 09 落学生目录时若提供统一解析函数，这里应改为调用它，
    不要留下第二套路径拼法（这是本文件唯一一处与 ``app/store/**`` 重叠的逻辑）。
    """
    if not STUDENT_ID_RE.match(student_id):
        raise HTTPException(status_code=422, detail="studentId 不合法（只允许字母、数字、下划线、连字符）")
    return Path(data_dir) / "students" / student_id / "learning.db"


# ---------------------------------------------------------------- 路由 --
def _pick_grade_level(
    grade_level: str | None, camel_grade_level: str | None, *, field_name: str = "gradeLevel"
) -> str:
    """取学段参数：``gradeLevel``（camelCase）与 ``grade_level``（snake_case）都认。

    仓库里两种写法都有先例（契约的 body 一律 camelCase，``/api/graph/deps`` 的 query 用
    snake_case），所以这里两个名字都收，避免调用方猜错名字得到一个静默的 422。
    """
    value = camel_grade_level or grade_level
    if not value:
        raise HTTPException(status_code=422, detail=f"缺少 {field_name}（四学段之一）")
    if value not in GRADE_LEVELS:
        raise HTTPException(
            status_code=422, detail=f"{field_name} 非法：{value!r}（只允许 {'、'.join(GRADE_LEVELS)}）"
        )
    return value


@router.get(
    "/quiz/bank/{kp_id}",
    response_model=QuizPayload,
    summary="按知识点 + 学段取题（剔除 answer）",
)
def get_quiz_bank(
    request: Request,
    kp_id: str,
    grade_level: str | None = Query(None, description="学生学段（四学段之一，必填）"),
    gradeLevel: str | None = Query(None, include_in_schema=False),
    count: int = Query(DEFAULT_QUESTION_COUNT, ge=1, le=MAX_QUESTION_COUNT, description="取几道题"),
    allow_compat: bool = Query(True, description="题目不足时是否允许取用更低学段的题"),
    allowCompat: bool | None = Query(None, include_in_schema=False),
) -> QuizPayload:
    """取题（供练习 Extension 的 ``generate_quiz`` Tool 调用）。

    - 本题库**按学段分文件**，因此学段是必填参数；只允许取**不高于**学生学段的题；
    - 返回体是 :class:`QuizPayload`，``questions`` 全是 :class:`QuizQuestionOut`
      （**结构上没有 ``answer``**，不是靠 ``exclude`` 临时裁的）；
    - 取不到题 → **404** + 可读中文（``questions: []`` 看起来像「这个知识点没题」，
      与「kpId 拼错了」分不开，所以不用空数组表达失败）；
    - 题库目录不存在/坏题多 → 不算错误：返回 404，由编排层决定改用 LLM 生成（票 15）。
    """
    level = _pick_grade_level(grade_level, gradeLevel)
    compat = allow_compat if allowCompat is None else allowCompat

    report = load_bank(bank_dir_for(request))
    picked = select_questions(
        report, kp_id=kp_id, grade_level=level, count=count, allow_compat=compat
    )
    if not picked:
        raise HTTPException(
            status_code=404,
            detail=(
                f"知识点 {kp_id!r} 在 {level} 及更低学段没有题目"
                "（题库文件：server/resources/quizbank/）"
            ),
        )

    missing = [
        entry.question.qid
        for entry in picked
        if entry.question.type == "choice" and not entry.question.options
    ]
    if missing:  # pragma: no cover - load_bank 已经挡掉，留作最后一道保险
        raise HTTPException(status_code=500, detail=f"题库存在无选项的选择题：{missing}")

    payload = QuizPayload.from_internal(
        kp_id=kp_id,
        source="bank",
        questions=[entry.question for entry in picked],
    )
    logger.info(
        "取题：kp=%s 学段=%s 命中=%d（题库文件：%s；坏题 %d，超纲 %d）",
        kp_id,
        level,
        len(payload.questions),
        "、".join(report.files) or "无",
        len(report.skipped),
        len(report.out_of_scope),
    )
    return payload


@router.post("/quiz/grade", response_model=QuizResult, summary="提交答案并批改（客观题规则判分）")
def grade_quiz(request: Request, body: QuizGradeRequest) -> QuizResult:
    """按 ``qid`` 查库判分，并把结果写进该学生的 ``learning.db``。

    写入两处（都是结构化数据，**不写对话正文**）：
      - ``mastery``：``score`` / ``attempts`` / ``correct`` / ``last_seen_at``；
      - ``learning_history``：一条 ``activity="quiz"`` 记录（票 20 的个性化闭环要吃它）。

    ``mastery_delta`` 回传的是**实际生效**的变化量（``新值 - 旧值``）：已经满分时再答对就是 0，
    而不是回一个没发生的 ``+0.15``（否则前端进度条会虚涨）。
    """
    if not STUDENT_ID_RE.match(body.student_id):
        raise HTTPException(
            status_code=422,
            detail="studentId 不合法（只允许字母、数字、下划线、连字符）",
        )

    report = load_bank(bank_dir_for(request))
    question = find_question(report.entries, body.qid)
    if question is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"题目 {body.qid!r} 不在本地题库里。若这是模型生成的变式题，"
                "需要由生成路径把答案登记到题库后再批改（票 15）。"
            ),
        )

    correct = is_correct_answer(question, body.answer)
    feedback = feedback_for(question, correct)

    config = request.app.state.config
    store = LearningStore(student_db_path(config.data_dir, body.student_id))
    try:
        before, _, _ = store.mastery(question.kp_id)
        delta = MASTERY_GAIN_CORRECT if correct else -MASTERY_LOSS_WRONG
        after = store.apply_mastery(question.kp_id, delta, correct=correct)
        effective = round(after - before, 6)
        store.add_history(
            kp_id=question.kp_id,
            activity="quiz",
            session_id=body.session_id or "",
            question=question.stem[:120],
            is_correct=correct,
            detail=json.dumps(
                {
                    "qid": question.qid,
                    "type": question.type,
                    "scoredBy": "rule",
                    "masteryDelta": effective,
                    "mastery": after,
                },
                ensure_ascii=False,
            ),
        )
    finally:
        store.close()

    logger.info(
        "判分：qid=%s kp=%s 对错=%s 掌握度 %.3f → %.3f（delta=%.3f）",
        question.qid,
        question.kp_id,
        correct,
        before,
        after,
        effective,
    )
    result = QuizResult(
        qid=question.qid,
        correct=correct,
        scored_by="rule",
        feedback=feedback,
        # ★ 限幅：契约模型自身有 ge/le 校验（±MASTERY_DELTA_LIMIT），
        #   store 也限幅一次 —— 两道保险都在，单次答题绝不可能把掌握度从 0 顶到 1。
        mastery_delta=max(-MASTERY_DELTA_LIMIT, min(MASTERY_DELTA_LIMIT, effective)),
    )
    return result


__all__ = [
    "BANK_DIR_ENV",
    "BANK_DIR_STATE_ATTR",
    "BankEntry",
    "BankReport",
    "DEFAULT_QUESTION_COUNT",
    "MASTERY_GAIN_CORRECT",
    "MASTERY_LOSS_WRONG",
    "MAX_QUESTION_COUNT",
    "QUIZ_BANK_DIRNAME",
    "STUDENT_ID_RE",
    "bank_dir_for",
    "default_bank_dir",
    "feedback_for",
    "find_question",
    "is_correct_answer",
    "load_bank",
    "normalize_answer",
    "out_of_scope_terms",
    "router",
    "select_questions",
    "student_db_path",
]
