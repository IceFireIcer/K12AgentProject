# -*- coding: utf-8 -*-
"""动画**自由生成**的合流端点（票 17 的第二条路径：模板未命中时的补充）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | ``/api/animation/compose`` | 把模型产出的**片段**拼成完整沙箱 HTML 并校验，返回 ``AnimationPayload(source="generated")`` |

## 为什么需要这个端点（而不是让模型直接吐整份 HTML）

沙箱 HTML 必须满足四条硬要求，**只有 Python 侧做得到**：

1. **内联 Anime.js**（演示现场断网，任何 CDN 引用都会白屏）；
2. **内联沙箱运行时**（``window.Sandbox`` / ``Sandbox.ready(``）；
3. **注入 ``payload_id``**（同屏多张卡片的串台防线）；
4. **过 ``validate_animation_html()` 全套校验**（外部引用 / 库与运行时在位 / 脚本没写崩 / 安全结构）。

库文件（``server/resources/templates/_shared/``）与校验器都在 Python 侧。若让主进程
自己拼 HTML，它会需要「怎么内联库 + 怎么校验」的**第二套实现**，与 Python 的必然漂移
——而漂移的表现就是「有的产物过校验、有的不过」，表现为随机的白屏。

所以分工是：**模型出片段 → 这里拼装 + 校验 → 不合格 422（可重试）**。
TS 侧（``desktop/src/main/agent/animation/generator.ts``）只负责出片段与重试。

## 与模板路径的关系

同一套 ``compose_animation_html()`` + ``validate_animation_html()``（与
``routes/resources.py`` 的 ``render_animation`` 完全一致），只是 ``body`` / ``script``
来自模型而不是模板文件。**校验标准一字不差** —— 这正是「模板优先、自由生成只是补充」
这条纪律能成立的技术前提：补充路径不能比主路径松。

> ⚠️ 路由挂载：本 router 需要在 ``app/main.py`` 里 ``include_router``。
> ``include_in_schema=False``：它是主进程 ↔ sidecar 之间的内部管道（与 ``routes/resources.py``
> 的动画路由同一定位），不进 OpenAPI 生成物，``npm run check:api`` 的字节比对防线不受影响。
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field

from app.contracts import AnimationPayload, CamelModel
from app.routes.resources import (
    ANIME_LIB_FILENAME,
    BASE_CSS_FILENAME,
    MAX_HTML_BYTES,
    RUNTIME_FILENAME,
    build_fallback_svg,
    compose_animation_html,
    read_shared,
    templates_dir_for,
    validate_animation_html,
    validate_payload_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["animation"], include_in_schema=False)

#: 模型产出的片段大小上限（片段不是整份 HTML，给足但不放任）
MAX_FRAGMENT_CHARS = 60_000
#: 降级文案上限（它会进卡片与 Prompt）
MAX_FALLBACK_TEXT_CHARS = 600

#: 片段里**不许出现**的东西（出现即 422 + 可读原因，让生成器带着原因重试）
_FRAGMENT_FORBIDDEN: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("外部引用", re.compile(r"https?://|//cdn|unpkg|jsdelivr|cdnjs|googleapis", re.IGNORECASE)),
    ("完整文档标签", re.compile(r"<!doctype|<html[\s>]|</html>", re.IGNORECASE)),
    ("script 标签", re.compile(r"<script[\s>]|</script>", re.IGNORECASE)),
    ("远程加载", re.compile(r"\bfetch\s*\(|XMLHttpRequest", re.IGNORECASE)),
    ("宿主文档访问", re.compile(r"parent\.document|window\.top\b(?!\s*===?\s*window)")),
    ("顶层 throw", re.compile(r"(^|[^.\w])throw\b")),
)

class ComposeFragmentRequest(CamelModel):
    """模型产出的片段 + 本轮的上下文。"""

    concept: str = Field(min_length=1, max_length=120)
    kp_id: str = Field(default="", max_length=120)
    grade_level: str = Field(default="", max_length=40)
    payload_id: str = Field(default="", max_length=64)
    #: 页面片段（HTML 片段，不含 ``<html>`` / ``<script>``）
    body: str = Field(min_length=1, max_length=MAX_FRAGMENT_CHARS)
    #: 注册播放实现的脚本（不含 ``<script>`` 标签）
    script: str = Field(min_length=1, max_length=MAX_FRAGMENT_CHARS)
    #: 降级文案（动画失败时就用它讲；**必须非空**）
    fallback_text: str = Field(min_length=1, max_length=MAX_FALLBACK_TEXT_CHARS)
    #: 动画时长（毫秒）
    duration_ms: int = Field(gt=0, le=120_000)
    title: str = Field(default="", max_length=120)

def _fragment_problems(fragment: str) -> list[str]:
    """片段级预检：命中即 422（附带可读原因，生成器下一轮带着它重试）。"""
    problems: list[str] = []
    for label, pattern in _FRAGMENT_FORBIDDEN:
        found = pattern.search(fragment)
        if found:
            problems.append(f"{label}：{found.group(0)[:40]}")
    return problems

@router.post(
    "/animation/compose",
    response_model=AnimationPayload,
    summary="把模型产出的片段拼成完整动画 HTML 并校验（自由生成路径）",
)
def compose_animation_route(request: Request, body: ComposeFragmentRequest) -> AnimationPayload:
    """拼装 + 校验 → ``AnimationPayload(source="generated")``。

    - 片段里出现外部引用 / 完整文档标签 / 网络请求 / 宿主访问 / 顶层 ``throw`` → **422**；
    - 拼装后的整份 HTML 过 ``validate_animation_html()`` → 不过也是 **422**；
    - 两者都是**可重试**语义（TS 侧的生成器会带着原因重试，≤3 次后降级为文字 + 静态图）。
    """
    payload_id = body.payload_id.strip() or "generated"

    # ① 片段级预检：先给出**具体**原因（整份 HTML 的校验失败时，原因会笼统得多）
    problems = _fragment_problems(f"{body.body}\n{body.script}")
    if problems:
        detail = "；".join(problems)
        logger.warning("自由生成的片段未通过预检：%s", detail)
        raise HTTPException(status_code=422, detail=f"自由生成的片段不合格（{detail}）")

    # ② 拼装（**与模板路径同一个函数**：库、运行时、payload_id 都用同一套拼法）
    directory = templates_dir_for(request)
    html = compose_animation_html(
        css=read_shared(directory, BASE_CSS_FILENAME),
        library=read_shared(directory, ANIME_LIB_FILENAME),
        runtime=read_shared(directory, RUNTIME_FILENAME),
        body=body.body,
        script=body.script,
        payload_id=validate_payload_id(payload_id),
    )

    # ③ 整份校验（**与模板路径同一套判据**：补充路径不许比主路径松）
    validation = validate_animation_html(html)
    if not validation.ok:
        detail = validation.reason
        logger.warning("自由生成的 HTML 未通过校验：%s", detail)
        raise HTTPException(status_code=422, detail=f"自由生成的动画未通过校验：{detail}")

    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise HTTPException(status_code=422, detail=f"动画 HTML 过大（超过 {MAX_HTML_BYTES} 字节）")

    text = body.fallback_text.strip()
    if not text:
        # 理论上 pydantic 已经挡住；这里再兜一次（降级文案为空 = 动画失败时无话可说）
        raise HTTPException(status_code=422, detail="降级文案为空（动画失败时就没有话可说了）")

    title = body.title.strip() or body.concept
    return AnimationPayload(
        concept=body.concept.strip(),
        html=html,
        duration_ms=int(body.duration_ms),
        fallback_text=text,
        fallback_image=build_fallback_svg(concept=body.concept.strip(), title=title, text=text),
        source="generated",
    )

__all__ = [
    "MAX_FALLBACK_TEXT_CHARS",
    "MAX_FRAGMENT_CHARS",
    "ComposeFragmentRequest",
    "router",
    "compose_animation_route",
]
