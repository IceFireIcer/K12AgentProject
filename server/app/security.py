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

# 开发态：electron-vite 的**渲染进程 dev server**来源，且只认它自己那个端口。
# ★ 端口 5173 是 **vite 的默认端口**：`desktop/electron.vite.config.ts` 的 renderer 段
#   没有配 `server.port`，所以 dev server 就跑在 5173，electron-vite 再把它写进
#   `ELECTRON_RENDERER_URL`（`desktop/src/main/index.ts` 用它 loadURL）。
#   （sidecar 自己的固定调试端口是 8756，见 `app/config.py` 的 `DEV_PORT` —— 那是**服务端**
#    端口，不是浏览器来源；从 8756 上加载的页面访问 8756 是同源，不需要 CORS。）
#
# ★★ 为什么**不能**再写成 `(localhost|127\.0\.0\.1)(:\d+)?`「任意回环端口」：
#   那等于本机上随便一个 `http://localhost:<任意端口>` 的页面（另一个项目的 dev server、
#   一条本地起的小服务、被诱导打开的本地页面）都能读到 sidecar 的响应 —— 回环来源
#   **不是**可信来源（审计 M-7：调试模式下连明文 API Key 都能被 JS 读走）。
#   收窄到实际会用的那一个来源即可：渲染进程本来就不直连 sidecar（IPC-only），
#   CORS 只是纵深防御，所以「5173 被占用时 vite 顺延端口」这类边缘情况不再放行也无妨。
ALLOWED_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1):5173$"

# 需要鉴权的路径前缀（`/health` 与静态资源不在其中）
PROTECTED_PREFIX = "/api/"

# ------------------------------------------------------------------ 调试模式 --
# ★ 「未配 token = 手动调试」这条路径（`uv run uvicorn app.main:app --port 8756`，
#   见 `app/main.py` 末尾的模块级 app）**故意不拦 `/api/*`**，那是它存在的意义
#   （没有握手、没有 token 也能 curl）。
#   但**明文凭据出口**必须除外：`/api/settings/runtime` 会原样返回**明文 API Key**
#   （它是「设置 → Pi」的唯一通路），而调试路径上没有任何凭据概念 ——
#   任意本机进程、任意 localhost 页面都能读到它（审计 M-7，实测 200）。
#   所以这里只摘出**这一个**端点，其余调试便利全部保留。
DEBUG_MODE_FORBIDDEN_PATHS: frozenset[str] = frozenset({"/api/settings/runtime"})

#: 拒绝理由要说人话（**不假装 404**）：调试的人得知道「为什么被拒、怎么做才能用」。
#: ⚠️ 提示里的命令必须是**真能跑通的**：`uvicorn` 的 CLI 只认它自己的选项，
#:    `--token` 是本应用自己的参数（`app/main.py` 的 `parse_args`），
#:    传给它只会得到 `Error: No such option '--token'`（实测）。所以给的是模块入口形式。
DEBUG_MODE_FORBIDDEN_DETAIL = (
    "调试模式（未配置 --token）下禁止访问本端点：它会返回明文 API Key。"
    "该接口只服务于 Electron 主进程（启动时会带上随机 token）。"
    "需要手工验证请用模块入口显式带上 token："
    "uv run python -m app.main --port 8756 --token <你的 token>，"
    "再带 X-Auth-Token 头请求（uvicorn 的 CLI 不认 --token，那条路拿不到 token）。"
)

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


def debug_mode_forbidden_path(path: str) -> bool:
    """调试模式（未配 token）下，这条路径是否属于「必须拒绝」的明文凭据出口。

    ⚠️ 判断**只看路径、看全部方法**：端点本身是 GET，但不排除将来支持写操作 ——
    「调试模式下这个出口整体关闭」比「只关 GET」更没有漏网的余地。

    ⚠️ 用**归一化后的路径**比：``/api/settings/runtime/`` 这种带尾斜杠的写法
    若放过去就会绕过（Starlette 会把它重定向到无斜杠形式，请求照样成功）。
    """
    return path.rstrip("/").lower() in DEBUG_MODE_FORBIDDEN_PATHS


class DebugModeCredentialGuard:
    """纯 ASGI 中间件：**只在调试模式（``token`` 为空）下**挡掉明文凭据出口。

    为什么做成独立中间件而不是塞进 :class:`TokenAuthMiddleware`：

    1. 两条规则的**触发条件互斥且语义不同** —— 带 token 时是「谁能调」（鉴权），
       不带 token 时是「哪些出口不能开」（收口）。混在一起会让「调试时可免鉴权」
       这条既定行为变得难读；
    2. 顺序上它必须**在内层**（先 `add_middleware`）：一旦将来给该端点加上鉴权，
       401 由内层出口自己给出，不会被这里替换成 403。

    生产路径（``token`` 非空）里它**一次判断都不做**（直接透传），所以不可能影响
    主进程取明文 Key 的唯一通路。
    """

    def __init__(self, app: Any, *, token: str) -> None:
        self.app = app
        self.enabled = not token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.enabled or scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        if not debug_mode_forbidden_path(str(scope.get("path", ""))):
            await self.app(scope, receive, send)
            return
        response = JSONResponse({"detail": DEBUG_MODE_FORBIDDEN_DETAIL}, status_code=403)
        await response(scope, receive, send)
