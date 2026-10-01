"""对话式冷启动五问（/api/onboarding/*）—— 该学生引导流程状态的唯一读写口。

票 25 的后端半：状态机存在 identity_local.onboarding_state，
五问的回答存在 onboarding_qa（本表是「SQLite 不存对话正文」的唯一例外，见
app/store/migrations.py 的 v5 DDL 注释与 routes/profile.py 的合规章节）。

为什么单独一个路由文件而不是塞进 profile.py：
- 它的变更原因与画像不同（这里是「首次使用流程」，那边是「长期学习数据」）；
- 一人一库的连接纪律一样（open_learning_store），但端点是全新的一组（state/answer）。

★ 票 31（2026-09-29 用户裁决）：跳过入口**全链路删除**，`done` 是唯一终态 ——
历史库里落了 `skipped` 的学生按「没答完」处理，读到该状态时照常给出下一问；
学生再答一问就把它推回 in_progress（answer 端点既有逻辑，不变）。
`skipped` 保留在状态词表里只为兼容历史数据，**不再有任何路径产生它**。

★ 只做「存 / 取 / 推进状态」，**不做** Q1 的点选直达映射（那是主进程 grade:set 的事）、
  也不做 Q5 的称呼脱敏（主进程写 identity_local 之前做）。后端不知道自己收到的是
  「点选 chip」还是「自由打字」—— 两者走同一条提交路径（执行报告 §1.2/§1.4）。
"""

from __future__ import annotations

import logging
import sqlite3

from fastapi import APIRouter, HTTPException, Request

from app.contracts import (
    ONBOARDING_QUESTION_TEXTS,
    OnboardingAnswerOut,
    OnboardingAnswerRequest,
    OnboardingStateOut,
    safe_display_name,
)
from app.routes.students import (
    DEFAULT_COLD_START_GRADE,
    DEFAULT_STUDENT_NICKNAME,
    open_learning_store,
    require_data_dir,
    validate_student_id,
)
from app.store.learning import ONBOARDING_STATES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["onboarding"])

#: 问号顺序（q1..q5）。取自契约里的问句脚本 —— 顺序只有一处定义，别处不许再排一遍。
_QUESTION_IDS: tuple[str, ...] = tuple(ONBOARDING_QUESTION_TEXTS)


def _ensure_student(store, student_id: str) -> None:
    """冷启动兜底：学生行不存在就建一条（与画像写入路径**同一口径**）。

    ★ 与 routes/profile.py 的冷启动写法一致：引导是新用户的第一屏，
      「还没建学生行就先答了第一问」不该丢数据，也不该 500。
    """
    if store.get_student(student_id) is None:
        store.upsert_student(
            student_id,
            nickname=DEFAULT_STUDENT_NICKNAME,
            grade_level=DEFAULT_COLD_START_GRADE,
        )
        logger.info("冷启动：为 %s 建立学生行（学段 %s）", student_id, DEFAULT_COLD_START_GRADE)


def _state_out(store, student_id: str) -> OnboardingStateOut:
    """把库里的状态拼成出参（两个端点共用这一处构造，避免两份「下一问」推导）。"""
    identity = store.identity_or_default(student_id)
    # 状态是 Literal（出参模型会校验）：库里被外力塞了非法值时按「还没开始」处理。
    state = identity.onboarding_state if identity.onboarding_state in ONBOARDING_STATES else "not_started"
    answered = [
        record.question_id
        for record in store.onboarding_answers()
        if record.question_id in _QUESTION_IDS
    ]
    answered_set = set(answered)
    # 下一问 = 还没收齐的第一问；只有 done 是终态（票 31：skipped 也续问，直到答完）。
    if state == "done":
        next_question: str | None = None
    else:
        next_question = next((qid for qid in _QUESTION_IDS if qid not in answered_set), None)
    return OnboardingStateOut(
        onboarding_state=state,  # type: ignore[arg-type]
        answered=[qid for qid in _QUESTION_IDS if qid in answered_set],
        next_question_id=next_question,
        # display_name 只回脱敏后的安全值；real_name 本身走 identity 端点（本地替换用）。
        display_name=safe_display_name(identity.real_name),
    )


@router.get(
    "/onboarding/{student_id}/state",
    response_model=OnboardingStateOut,
    summary="引导流程状态（是否该弹引导）",
)
def read_onboarding_state(request: Request, student_id: str) -> OnboardingStateOut:
    """读引导状态。

    冷启动不建学生行也不写库：读一次状态不该留下任何痕迹（**读路径零副作用**）。
    真正落行的只有 answer（它顺带推进状态）—— 票 31 删掉 skip 之后，写路径只剩这一条。
    """
    validate_student_id(student_id)
    data_dir = require_data_dir(request)
    store = open_learning_store(data_dir, student_id)
    try:
        return _state_out(store, student_id)
    except sqlite3.Error as exc:
        logger.exception("读取引导状态失败：%s", student_id)
        raise HTTPException(
            status_code=503, detail=f"读取引导状态失败（本地数据库异常）：{exc}"
        ) from exc
    finally:
        store.close()


@router.post(
    "/onboarding/{student_id}/answer",
    response_model=OnboardingAnswerOut,
    summary="提交一问的回答（重答覆盖）",
)
def answer_onboarding(
    request: Request, student_id: str, payload: OnboardingAnswerRequest
) -> OnboardingAnswerOut:
    """收下学生对某一问的回答，并推进流程状态。

    - 同一 question_id 重答 = **覆盖**（onboarding_qa 上的 UNIQUE 索引 + upsert）；
    - 收齐五问 → done；否则 in_progress；已经 done 的不回退；
    - 空白的 answerText 直接 422（它不该被当成「答过了」）。
    """
    validate_student_id(student_id)
    data_dir = require_data_dir(request)
    answer_text = " ".join(payload.answer_text.split()).strip()
    if not answer_text:
        raise HTTPException(status_code=422, detail="answerText 不能为空（空白不算回答）")

    store = open_learning_store(data_dir, student_id)
    try:
        _ensure_student(store, student_id)
        try:
            store.save_onboarding_answer(
                question_id=payload.question_id,
                question_text=ONBOARDING_QUESTION_TEXTS[payload.question_id],
                answer_text=answer_text,
                session_id=payload.session_id or "",
            )
            answered = {record.question_id for record in store.onboarding_answers()}
            if store.onboarding_state(student_id) != "done":
                next_state = "done" if set(_QUESTION_IDS) <= answered else "in_progress"
                store.set_onboarding_state(student_id, next_state)
        except sqlite3.Error as exc:
            logger.exception("引导回答写入失败：%s", student_id)
            raise HTTPException(
                status_code=503, detail=f"引导回答写入失败（本地数据库异常）：{exc}"
            ) from exc
        state = _state_out(store, student_id)
        logger.info(
            "引导回答已收：学生=%s 问题=%s 状态=%s 已答=%d",
            student_id,
            payload.question_id,
            state.onboarding_state,
            len(state.answered),
        )
        return OnboardingAnswerOut(accepted=True, state=state)
    finally:
        store.close()


__all__ = ["router"]
