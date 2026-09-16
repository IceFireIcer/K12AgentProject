"""鉴权与跨源策略。

**规则**（执行文档 §6.3 安全）：

- 所有 ``/api/*`` 必须带 ``X-Auth-Token``，与启动参数 ``--token`` 不符 → **401**；
- ``/health`` **免鉴权**（启动期探活要用，那时还没有任何凭据概念）；
- ``OPTIONS`` 预检免鉴权 —— 预检请求**不带**自定义头，拦掉它就等于拦掉一切跨源请求。

**为什么 token 是每次启动随机生成**：sidecar 监听在回环地址上，本机任何进程都能连到它。
没有 token 就等于把学生数据暴露给本机任意程序（执行文档 §6.3 安全第 ② 条）。

**为什么 token 不进渲染进程**：渲染进程不直连 sidecar，它走 IPC 白名单；
token 只存在于 Electron 主进程内存里。这样即使渲染层被注入脚本，也拿不到数据接口的凭据。
"""

from __future__ import annotations

import secrets
from typing import Any, Awaitable, Callable

from starlette.datastructures import Headers
from starlette.responses import JSONResponse

# 自定义鉴权头（契约的一部分，不要改名）
AUTH_HEADER = "X-Auth-Token"

# ------------------------------------------------------------------ 跨源策略 --
# 渲染进程**不直连 sidecar**（所有请求都来自主进程），所以跨源不是主链路问题；
# 这里保留一段最小显式来源的 CORS 只作纵深防御。**禁止使用 `*`**。
ALLOWED_ORIGINS = (
    "null",  # file:// 页面的 Origin 就是字符串 "null"
    "file://",
)

# 开发态：electron-vite dev server 的本地来源
ALLOWED_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"

# 需要鉴权的路径前缀（`/health` 与静态资源不在其中）
PROTECTED_PREFIX = "/api/"

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]


class TokenAuthMiddleware:
    """纯 ASGI 中间件：按 ``X-Auth-Token`` 拦截 ``/api/*``。

    做成纯 ASGI（而不是 ``BaseHTTPMiddleware``）是有意的：
    ``BaseHTTPMiddleware`` 会包一层 anyio 任务组，对流式响应的取消语义有影响，
    而本项目未来会有流式端点，不想在这里埋雷。
    """

    def __init__(self, app: Any, *, token: str, header: str = AUTH_HEADER) -> None:
        self.app = app
        self.token = token
        self.header = header

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or not self._needs_auth(scope):
            await self.app(scope, receive, send)
            return

        provided = Headers(scope=scope).get(self.header, "")
        if not self._matches(provided):
            response = JSONResponse(
                {"detail": "invalid or missing X-Auth-Token"},
                status_code=401,
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)

    def _needs_auth(self, scope: Scope) -> bool:
        # 未配置 token（纯手动调试 `uv run uvicorn ...`）：不拦。
        # Electron 启动时必然传入 token，所以生产路径永远走鉴权分支。
        if not self.token:
            return False
        if scope.get("method") == "OPTIONS":
            return False
        return str(scope.get("path", "")).startswith(PROTECTED_PREFIX)

    def _matches(self, provided: str) -> bool:
        # 常量时间比较：避免用响应时间猜 token。
        # 比较字节而非 str —— compare_digest 遇到非 ASCII 的 str 会抛 TypeError，
        # 而请求头的内容完全由调用方控制，不能让它把中间件打崩。
        try:
            return secrets.compare_digest(provided.encode("utf-8"), self.token.encode("utf-8"))
        except Exception:  # noqa: BLE001
            return False
