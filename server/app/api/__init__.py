"""HTTP 路由层。

`/api/*` 一律经过 main.py 的 token 中间件；`/health` 在 `/api` 之外，因此天然免鉴权
（Electron 探活时还不知道 token 是否已生效，必须留一个免鉴权探针）。
"""

from app.api.system import router as system_router

__all__ = ["system_router"]
