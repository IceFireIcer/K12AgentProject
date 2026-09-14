"""HTTP 路由层。

`/api/*` 一律经过 main.py 的 token 中间件；`/health` 在 `/api` 之外，因此天然免鉴权
（Electron 探活时还不知道 token 是否已生效，必须留一个免鉴权探针）。

CORS 预检（`OPTIONS /api/*`）也在中间件里豁免鉴权——原因见 `config.ALLOWED_RENDERER_ORIGINS`。
"""

from app.api.chat import router as chat_router
from app.api.settings import router as settings_router
from app.api.system import router as system_router

__all__ = ["chat_router", "settings_router", "system_router"]
