"""SSE 分帧工具（唯一实现）。

（对应 `项目执行文档.md` 第 6.4 节）

规则（SSE 规范 + 我们的约定）：
- 一个事件 = `event: <name>\\n` + `data: <json>\\n` + **空行**；
- `data` 必须是**单行** JSON（`json.dumps` 天然把换行转义成 `\\n`，所以安全）；
- `ensure_ascii=False`：中文直出，配合 `charset=utf-8`（避免 `\\u5faa` 这类
  转义污染日志与调试体验）；
- 事件名必须是契约里的 6 种之一，**拼错立刻抛异常**——宁可在服务端炸掉，
  也不要在前端静默丢事件（那种 bug 极难查）。

⚠️ 前端解析器（`desktop/src/renderer/api/sse.ts`）与这里是一对，改动必须同步。
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Iterable, Union

from pydantic import BaseModel

from app.models import SSE_EVENT_NAMES

#: SSE 响应的 Content-Type（charset 必须显式带上，否则浏览器按 ISO-8859-1 解 → 中文乱码）。
SSE_MEDIA_TYPE = "text/event-stream; charset=utf-8"

#: 反代/中间件层面禁用缓冲（本地场景主要是防御性写法，S03 起还要确认没挂 GZip）。
SSE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def format_sse(event: str, data: Union[BaseModel, dict[str, Any]]) -> str:
    """把 (事件名, 数据) 编码成一段 SSE 文本。

    `data` 传 pydantic 模型时按 **camelCase**（`by_alias=True`）序列化——
    这是"Python snake_case 内部、JSON camelCase 对外"约定的唯一落点。
    """
    if event not in SSE_EVENT_NAMES:
        raise ValueError(
            f"未知 SSE 事件名 {event!r}；契约只允许 {SSE_EVENT_NAMES}（见 models.SseEventName）"
        )
    payload = data.model_dump(mode="json", by_alias=True) if isinstance(data, BaseModel) else data
    # 紧凑分隔符：SSE 每条 delta 都是一个事件，`": "` 这类空格纯属浪费带宽与解析成本。
    # 换行安全由 json.dumps 保证（`\n` 会被转义成 `\\n`，绝不会裸出现在 data 行里），
    # 因此无需再手工检查——前端按 `\n\n` 切块，天然不会被内容里的换行截断。
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {body}\n\n"


async def stream_events(events: Iterable[tuple[str, Union[BaseModel, dict[str, Any]]]]) -> AsyncIterator[str]:
    """把静态事件列表变成异步生成器（S02 的 echo 端点用）。

    S03 起真实链路用同样的 `format_sse`，只是数据来自 LLM 的 token 流。
    """
    for event, data in events:
        yield format_sse(event, data)
