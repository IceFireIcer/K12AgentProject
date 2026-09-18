# -*- coding: utf-8 -*-
"""内容安全的 HTTP 边界（票 22）—— 判定逻辑全在 ``guard.py``，本文件只做「解析 → 调用 → 序列化」。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | ``/api/safety/check`` | 输入侧检查（``stage="input"``）与生成结束后的整段终审（``stage="final"``） |
| POST | ``/api/safety/self-review-prompt`` | 取 LLM 自审 prompt 模板（模板是判定的一部分，只在这里生成） |
| POST | ``/api/safety/redact-headers`` | provider 边界（``before_provider_headers``）的脱敏副本 |

## 为什么路由放在 ``app/safety/`` 而不是 ``app/routes/``

本模块与 ``guard.py`` 是**同一个功能单元的两半**（判定 / 投递），放在一起便于「改一边必须看到另一边」。
它同样是一个标准 ``APIRouter``，由 ``app/main.py`` 挂载。

## 为什么 ``include_in_schema=False``

这三个端点是**主进程 ↔ sidecar 之间的内部管道**（和 ``routes/resources.py`` 的动画管道同一定位），
不是前端契约的一部分：渲染进程永远不直连 sidecar（守卫 G5）。不进 OpenAPI 生成物，
``npm run check:api`` 就仍然做字节比对，契约漂移防线保持原样。

## 三个端点的共同纪律

1. **判定只有一份实现**：全部调用 ``guard.py`` 的函数，本文件**不写任何规则**；
2. **不回显正文**：出参里只有 ``reason``（面向开发者的一句话）与 ``safeText``（面向学生的替换文案），
   学生原话与模型输出**绝不**进响应、绝不进日志（§12 最小化采集）；
3. **词表路径与有没有 API Key 无关**：``check`` 的 ``stage="final"`` 在 ``selfReviewRaw`` 为空时
   仍然执行词表扫描 —— 这就是「无 Key 世界安全链路仍然有效」的服务端一半。
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter
from pydantic import Field, model_validator

from app.contracts import CamelModel
from app.safety import guard

logger = logging.getLogger(__name__)

#: 内部管道：不进 OpenAPI（理由见文件头）
router = APIRouter(prefix="/api", tags=["safety"], include_in_schema=False)

MAX_CHECK_CHARS = 8000
MAX_SELF_REVIEW_CHARS = 8000
MAX_HEADERS = 64
#: 单个请求头的**值**长度上限（字符）。
#:
#: ★ 审计发现：这个常量此前只出现在定义与 ``__all__`` 里 —— 而
#: ``RedactHeadersRequest.headers`` 上的 ``max_length=MAX_HEADERS`` 作用在 **dict 上**，
#: 限制的是**条目数**，单头长度上限**从未生效**（「看起来有约束其实没有」）。
#: 现在由 :meth:`RedactHeadersRequest.model_validator` 逐值强制（超长 → 422）。
#: 为什么要限制：这个端点的返回值会进日志/审计，一个几 MB 的畸形头会把日志撑爆；
#: 同时它也挡住「用超长头做内存放大」的畸形输入。
MAX_HEADER_CHARS = 2048


class SafetyCheckRequest(CamelModel):
    """一次安全检查的入参。``extra="forbid"``（CamelModel 的默认）挡住临时加松散字段。"""

    text: str = Field(default="", max_length=MAX_CHECK_CHARS)
    stage: Literal["input", "final"] = "input"
    grade_level: str | None = Field(default=None, max_length=64)
    #: ``stage="final"`` 专用：LLM 自审的原始响应（TS 侧调用模型后回传）。
    #: 为空表示自审那半不可用（**不是**「审核通过」）—— 此时仍会跑词表那一半。
    self_review_raw: str | None = Field(default=None, max_length=MAX_SELF_REVIEW_CHARS)

class SafetyCheckResponse(CamelModel):
    """一次安全检查的出参（``blocked`` 事件的两个字段就来自 ``reason`` / ``safe_text``）。"""

    allowed: bool
    category: str
    reason: str
    safe_text: str
    matched: list[str] = Field(default_factory=list)
    flagged: list[str] = Field(default_factory=list)
    #: ``wordlist`` / ``pattern`` / ``llm`` / ``none`` —— 哪一道命中的（证据用）
    source: str = "none"
    stage: str = guard.STAGE_INPUT

class SelfReviewPromptRequest(CamelModel):
    """自审 prompt 的入参。"""

    text: str = Field(default="", max_length=MAX_SELF_REVIEW_CHARS)
    grade_level: str | None = Field(default=None, max_length=64)

class SelfReviewPromptResponse(CamelModel):
    prompt: str

class RedactHeadersRequest(CamelModel):
    """provider 头脱敏的入参（真正的请求头副本）。

    ``headers`` 上有两个**不同**的限制，别看混：

    - ``max_length=MAX_HEADERS`` 作用在 dict 上 → 限制的是**条目数**；
    - :meth:`_check_header_lengths` 逐值限制**单个头的长度**（``MAX_HEADER_CHARS``）。
      单靠前者会让「一个 10MB 的头」直接进日志/审计（审计发现这个上限此前从未生效）。
    """

    headers: dict[str, str] = Field(default_factory=dict, max_length=MAX_HEADERS)

    @model_validator(mode="after")
    def _check_header_lengths(self) -> "RedactHeadersRequest":
        """逐值校验单头长度：超限 → 422（可读中文，指出是哪个头）。"""
        too_long = [
            name for name, value in self.headers.items() if len(str(value)) > MAX_HEADER_CHARS
        ]
        if too_long:
            raise ValueError(
                f"请求头过长（单个头上限 {MAX_HEADER_CHARS} 字符）：{'、'.join(sorted(too_long)[:5])}"
            )
        return self

class RedactHeadersResponse(CamelModel):
    """脱敏副本 + 命中并抹掉的敏感头名（**只有头名，没有值** —— 值里就是凭据）。"""

    headers: dict[str, str] = Field(default_factory=dict)
    sensitive_keys: list[str] = Field(default_factory=list)

def _to_response(verdict: guard.SafetyVerdict) -> SafetyCheckResponse:
    """``SafetyVerdict`` → 出参（**只投影契约字段**，不把内部对象整个漏出去）。"""
    return SafetyCheckResponse(
        allowed=verdict.allowed,
        category=verdict.category,
        reason=verdict.reason,
        safe_text=verdict.safe_text,
        matched=list(verdict.matched),
        flagged=list(verdict.flagged),
        source=verdict.source,
        stage=verdict.stage,
    )

@router.post("/safety/check", response_model=SafetyCheckResponse, summary="内容安全检查（输入侧 / 生成侧终审）")
def safety_check(body: SafetyCheckRequest) -> SafetyCheckResponse:
    """输入侧轻量检查，或生成结束后的整段终审。

    - ``stage="input"`` → :func:`guard.check_input`（命中即拦截，调用方不该再发模型请求）；
    - ``stage="final"`` → :func:`guard.final_review`（词表先扫、自审后合流）。

    ★ **无 Key 时的行为**（本项目本机现状）：``selfReviewRaw`` 为空 →
    ``parse_self_review("")`` 返回 ``None`` → 按「自审不可用」处理（**不据此拦截**），
    但 ``final_review`` 的**词表那一道照常执行**。所以这条端点在没有 API Key 时依然
    能拦住词表命中，只有「LLM 才认得出的漏网内容」拦不住 —— 这是明确取舍（宁可漏拦不误伤）。
    """
    if body.stage == "final":
        verdict = guard.final_review(
            body.text,
            self_review_raw=body.self_review_raw,
            grade_level=body.grade_level,
        )
    else:
        verdict = guard.check_input(body.text, grade_level=body.grade_level)
    return _to_response(verdict)

@router.post(
    "/safety/self-review-prompt",
    response_model=SelfReviewPromptResponse,
    summary="取 LLM 自审 prompt（模板与判定口径的唯一来源）",
)
def self_review_prompt(body: SelfReviewPromptRequest) -> SelfReviewPromptResponse:
    """生成自审 prompt。

    ★ 为什么由服务端生成而不是 TS 侧拼：这段 prompt 是**判定口径的一部分**
    （它列出的六类违规情形就是自审的判据）。放两份必然漂移，而漂移的表现是
    「同一段回答在两台机器上一个被拦一个放行」。TS 侧只负责把它交给模型、再把原文回传。
    """
    return SelfReviewPromptResponse(
        prompt=guard.build_self_review_prompt(body.text, grade_level=body.grade_level)
    )

@router.post(
    "/safety/redact-headers",
    response_model=RedactHeadersResponse,
    summary="provider 边界（before_provider_headers）的脱敏副本",
)
def redact_headers(body: RedactHeadersRequest) -> RedactHeadersResponse:
    """返回**脱敏副本**与命中并抹掉的敏感头名。

    ★ 语义（别搞反）：返回的是**审计副本**，不是「应当发出去的请求头」。
    ``Authorization`` 是发请求必须带的东西 —— 调用方（``runtime.ts`` 的
    ``before_provider_headers``）**只读不写**，真实请求头一个字节都不动；
    把 Key 抹成 ``***`` 会让每一轮对话都 401。
    ``guard.redact_provider_headers`` 本来就返回新 dict、不改入参，本函数再确保一次。

    ⚠️ 出参里绝不含原始值：``sensitiveKeys`` 只有头名，``headers`` 里敏感头是 ``***``，
    其余头过 ``redact_text``（抹掉 ``sk-`` / ``Bearer`` / 邮箱形态）。
    """
    redacted = guard.redact_provider_headers(body.headers)
    sensitive = [
        str(name)
        for name in body.headers
        if str(name).lower() in guard.SENSITIVE_HEADERS
    ]
    return RedactHeadersResponse(headers=redacted, sensitive_keys=sensitive)

__all__ = [
    "MAX_CHECK_CHARS",
    "MAX_HEADER_CHARS",
    "MAX_HEADERS",
    "MAX_SELF_REVIEW_CHARS",
    "RedactHeadersRequest",
    "RedactHeadersResponse",
    "SafetyCheckRequest",
    "SafetyCheckResponse",
    "SelfReviewPromptRequest",
    "SelfReviewPromptResponse",
    "router",
    "safety_check",
    "redact_headers",
    "self_review_prompt",
]
