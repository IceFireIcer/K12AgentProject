"""对话 SSE 路由。

S02 阶段这里只有 **echo 端点**（假数据），用途是把「鉴权 → SSE 分帧 → 前端解析」
这条管道先打通并冻结事件形态；S03 再用真实 LLM 流替换 `/api/chat/stream` 的内部实现。

⚠️ `/api/chat/stream/echo` 是 **S02 临时端点**，S03 落地真实流后删除。
它存在的唯一理由是：让前端解析器能在「后端还没有大模型」时就被完整测过，
包括 6 种事件里的 `blocked` / `error` 分支——这两个分支在真实链路里都很难主动
触发，不测就等于没写。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import AsyncIterator, Iterable, Union

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.models import (
    SSE_EVENT_NAMES,
    AnswerKind,
    ChatRequest,
    Citation,
    QuizPayload,
    QuizQuestion,
    SseBlockedData,
    SseCitationData,
    SseDeltaData,
    SseDoneData,
    SseErrorData,
    SsePayloadData,
)
from app.sse import SSE_HEADERS, SSE_MEDIA_TYPE, format_sse
router = APIRouter(prefix="/api", tags=["chat"])
logger = logging.getLogger(__name__)

#: echo 回放的文案：含中文与换行，用来验证解析器对 UTF-8 跨 chunk 的处理。
_ECHO_TEXT = "这是一段用于验证 SSE 管道的示例讲解：循环会重复执行同一段代码，直到条件不再成立。\n"


def build_echo_events(
    payload: ChatRequest, *, all_events: bool = False
) -> list[tuple[str, Union[BaseModel, dict]]]:
    """构造 echo 事件序列（**纯函数**，便于单测）。

    默认发语义正常的 `delta → citation → payload → done`；
    `all_events=True` 额外补发 `blocked` 与 `error`，覆盖契约里的全部 6 种事件。
    """
    request_id = uuid.uuid4().hex[:12]
    events: list[tuple[str, Union[BaseModel, dict]]] = []

    # 1) delta：逐字（含中文、标点、换行）
    for ch in _ECHO_TEXT:
        events.append(("delta", SseDeltaData(request_id=request_id, delta=ch)))

    # 2) citation：检索引用（含 compat 向上兼容标记）
    events.append(
        (
            "citation",
            SseCitationData(
                request_id=request_id,
                citations=[
                    Citation(
                        chunk_id="demo-0001",
                        chapter_title="第三章 循环结构",
                        section_title="3.1 什么是循环",
                        grade_level=payload.grade,
                        compat=False,
                    ),
                    Citation(
                        chunk_id="demo-0002",
                        chapter_title="第四章 变量与作用域",
                        section_title="4.2 循环变量",
                        grade_level=payload.grade,
                        compat=True,
                    ),
                ],
            ),
        )
    )

    # 3) payload：内联卡片（用练习卡片做样例，S08 起由 SubAgent 产出）
    quiz = QuizPayload(
        kp_id="kp-loop-001",
        source="bank",
        questions=[
            QuizQuestion(
                qid="q1",
                kp_id="kp-loop-001",
                type="choice",
                stem="下面哪个语句可以让代码重复执行 5 次？",
                options=["print()", "for i in range(5):", "if i < 5:", "def f():"],
                answer="for i in range(5):",
                explanation="range(5) 会产生 0~4 共 5 个数，for 会依次取出。",
            )
        ],
    )
    events.append(
        (
            "payload",
            SsePayloadData(
                request_id=request_id,
                kind=AnswerKind.QUIZ,
                # payload 是"结构由 kind 决定"的自由字段，这里显式转成 camelCase dict
                payload=quiz.model_dump(mode="json", by_alias=True),
            ),
        )
    )

    if all_events:
        # 4) blocked：内容安全拦截（S12 真实实现；这里演示"撤回并替换"语义）
        events.append(
            (
                "blocked",
                SseBlockedData(
                    request_id=request_id,
                    reason="demo: 命中示例规则（S02 管道自检）",
                    safe_text="这个问题我们换个角度来想：先说说循环的作用是什么？",
                ),
            )
        )
        # 5) error：降级（弱网/供应商不可用；响应头已发出，只能这样收尾）
        events.append(
            (
                "error",
                SseErrorData(
                    request_id=request_id,
                    message="demo: 供应商连接超时，已降级为本地讲解（S02 管道自检）",
                    degraded=True,
                ),
            )
        )

    # 6) done
    events.append(("done", SseDoneData(request_id=request_id, message_id=uuid.uuid4().hex[:16])))
    return events


async def _stream_echo(
    events: Iterable[tuple[str, Union[BaseModel, dict]]], interval_ms: int
) -> AsyncIterator[str]:
    """逐条产出已分帧的 SSE 文本；`interval_ms` 让"逐条到达"肉眼可见。"""
    for event, data in events:
        if interval_ms:
            await asyncio.sleep(interval_ms / 1000)
        yield format_sse(event, data)


@router.post(
    "/chat/stream/echo",
    # 把 SSE 事件名作为 OpenAPI 扩展暴露出去，前端才能**机械地**从契约生成事件联合类型，
    # 而不是手抄一份（手抄必然漂移）。
    openapi_extra={"x-sse-events": list(SSE_EVENT_NAMES), "x-sse-media-type": SSE_MEDIA_TYPE},
)
async def chat_stream_echo(
    payload: ChatRequest,
    interval_ms: int = Query(default=15, ge=0, le=1000, description="事件间隔，便于肉眼看逐条到达"),
    all_events: bool = Query(default=False, description="是否补发 blocked/error 以覆盖全部 6 种事件"),
) -> StreamingResponse:
    """**S02 临时端点**：回放一段假的 SSE 数据流。

    ⚠️ 为什么用 POST：真实链路（S03）是 POST + JSON body，前端解析器必须按
    POST + `fetch` 写，不能因为"反正是 echo"就退回 GET。
    """
    events = build_echo_events(payload, all_events=all_events)
    logger.info(
        "sse echo: student=%s grade=%s events=%d",
        payload.student_id,
        payload.grade.value,
        len(events),
    )
    return StreamingResponse(
        _stream_echo(events, interval_ms),
        media_type=SSE_MEDIA_TYPE,
        headers=SSE_HEADERS,
    )
