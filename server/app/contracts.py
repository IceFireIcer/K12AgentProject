"""★ 契约唯一来源（pydantic）。**只在本文件手写模型，不要散落别处。**

防漂移链路（执行文档 §6.1）：

    server/app/contracts.py          ← 唯一手写处
      → FastAPI 自动产出 /openapi.json
      → desktop/scripts/gen-api-types.mjs（openapi-typescript）生成 shared/api-types.ts
      → npm run typecheck 报错即代表契约漂移

票 01 只落**已经冻结**的部分：基础模型、四学段、6 事件词表、健康检查响应。
完整业务契约（Citation / AnimationPayload / CodeEvaluation / Quiz* 等）在**票 04** 冻结。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

# ---------------------------------------------------------------------------
# 四学段（赛题硬要求，不要增删）
# ---------------------------------------------------------------------------
GradeLevel = Literal["primary_low", "primary_high", "junior", "senior"]

# ---------------------------------------------------------------------------
# ★ 6 事件词表（**冻结**）
#
# 与 desktop/src/shared/ipc-events.ts 必须一字不差；架构守卫测试会比对两边。
# 传输层是 IPC（不是 SSE），词表沿用不变。
# ---------------------------------------------------------------------------
IPC_EVENT_NAMES: tuple[str, ...] = ("delta", "citation", "payload", "blocked", "done", "error")
IpcEventName = Literal["delta", "citation", "payload", "blocked", "done", "error"]


class CamelModel(BaseModel):
    """所有出参模型的基类。

    - Python 侧写 ``snake_case``，出参自动转 ``camelCase``（前端统一 camelCase）。
      **只做一次约定，两边不要混用。**
    - ``extra="forbid"``：契约外字段直接 422 —— 这是防止「临时加个松散字段」的硬闸门。
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class HealthResponse(CamelModel):
    """``GET /health`` 响应（执行文档 §6.3）。

    免鉴权，Electron 启动期轮询它判断 sidecar 是否可用。
    ``embedder_ready`` 为假**不代表 sidecar 不健康** —— 模型缺失时应用仍应能起来，
    只是检索会走降级链。
    """

    status: str
    version: str
    embedder_ready: bool
