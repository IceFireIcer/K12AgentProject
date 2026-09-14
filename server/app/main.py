"""后端入口：FastAPI 应用 + sidecar 启动协议。

两种启动方式：

1. **sidecar 模式**（Electron 使用）：
   `k12-agent-server.exe --port 0 --token <hex> --data-dir <userData>`
   绑定 `127.0.0.1:0` 由系统分配端口，绑定成功后向 **stdout** 打一行 JSON 握手：
   `{"event":"ready","port":8756,"pid":1234,"version":"..."}`
   Electron 逐行读 stdout 解析出 port，再去轮询 `/health`。

2. **开发模式**（脱离 Electron 调试）：
   `uv run python -m app.main --port 8756 --token devtoken --data-dir ./_data`
   或 `uv run uvicorn app.main:app --reload --port 8756`（用模块级 ASGI 对象，无握手）。

⚠️ 握手的唯一通道是 stdout 单行 JSON。**不要把任何非 JSON 内容打到 stdout**
（uvicorn 日志默认走 stderr），否则 Electron 的解析会被污染。
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from typing import Any

# 必须在任何其他 import 之前设置：打包后的子进程不继承全局 PYTHONUTF8。
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from app.api import system_router  # noqa: E402
from app.config import (  # noqa: E402
    ALLOWED_HOSTS,
    APP_NAME,
    APP_VERSION,
    RuntimeConfig,
    resolve_data_dir,
)
from app.encoding import install_utf8_stdio  # noqa: E402

# ⚠️ PyInstaller 的 bootloader 会忽略上面两个 env（机制见 app/encoding.py），
# 必须在 Python 层面真正把流切到 UTF-8，否则打包后中文按 GBK 输出。
install_utf8_stdio()

AUTH_HEADER = "X-Auth-Token"


def create_app(cfg: RuntimeConfig) -> FastAPI:
    """按运行时配置组装 FastAPI 应用。"""
    app = FastAPI(
        title="K12 AI 教学助手 · sidecar",
        version=APP_VERSION,
        description="Electron 桌面壳的本地后端（仅绑定 127.0.0.1）",
        docs_url="/docs",
    )
    app.state.cfg = cfg

    @app.middleware("http")
    async def auth_guard(request: Request, call_next):
        """所有 `/api/*` 必须带正确的 `X-Auth-Token`，否则 401。

        `/health` 与 `/docs` 不在 `/api` 前缀下，天然免鉴权——Electron 探活必须能
        在还没有任何凭据认知时打到它。
        """
        if request.url.path.startswith("/api") and cfg.auth_enabled:
            provided = request.headers.get(AUTH_HEADER, "")
            # 常量时间比较，避免 token 被逐字符试探
            if not provided or not secrets.compare_digest(provided, cfg.token):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "invalid or missing X-Auth-Token"},
                )
        return await call_next(request)

    app.include_router(system_router)
    return app


# --------------------------------------------------------------------------- #
# 启动协议与参数
# --------------------------------------------------------------------------- #


def _emit(payload: dict[str, Any]) -> None:
    """向 stdout 打单行 JSON（握手与失败通知的唯一出口）。"""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _emit_ready(port: int) -> None:
    _emit(
        {
            "event": "ready",
            "port": port,
            "pid": os.getpid(),
            "version": APP_VERSION,
            "frozen": bool(getattr(sys, "frozen", False)),
        }
    )


def _emit_error(reason: str) -> None:
    _emit({"event": "error", "message": reason, "pid": os.getpid()})


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=APP_NAME,
        description="K12 AI 教学助手后端 sidecar",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="监听端口；0 表示由系统分配空闲端口（推荐，避免端口竞态）",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="监听地址；只允许回环地址",
    )
    parser.add_argument(
        "--token",
        default="",
        help="Electron 生成的随机 hex token；传入后所有 /api/* 需带 X-Auth-Token",
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help="数据目录（config.json / SQLite / 日志）；默认 <当前目录或 exe 同级>/_data",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        help="uvicorn 日志级别（日志走 stderr，不污染握手通道）",
    )
    return parser.parse_args(argv)


def build_runtime_config(args: argparse.Namespace, *, create: bool = True) -> RuntimeConfig:
    data_dir = resolve_data_dir(args.data_dir)
    if create:
        data_dir.mkdir(parents=True, exist_ok=True)
    return RuntimeConfig(host=args.host, port=args.port, token=args.token, data_dir=data_dir)


def _configure_logging() -> None:
    """日志一律走 stderr，保护 stdout 的握手通道。"""
    import logging

    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def _bound_port(server: uvicorn.Server) -> int:
    """从已启动的 uvicorn Server 上读回真实绑定端口（`--port 0` 时必须）。"""
    for srv in server.servers:
        for sock in srv.sockets or ():
            try:
                return int(sock.getsockname()[1])
            except (OSError, IndexError, TypeError):
                continue
    return -1


def _make_handshake_server(config: uvicorn.Config) -> uvicorn.Server:
    """uvicorn Server 子类：绑定成功后立刻打握手，失败打可读错误。"""

    class HandshakeServer(uvicorn.Server):
        async def startup(self, sockets=None):  # type: ignore[override]
            await super().startup(sockets=sockets)
            port = _bound_port(self)
            if port <= 0:
                _emit_error("uvicorn 已启动但未能取到绑定端口")
                raise SystemExit(2)
            _emit_ready(port)

    return HandshakeServer(config)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    _configure_logging()

    if args.host not in ALLOWED_HOSTS:
        # 硬约束：sidecar 绝不能监听外部地址（项目执行文档 6.3 / 12）
        _emit_error(f"拒绝绑定非回环地址: {args.host}")
        return 2

    try:
        cfg = build_runtime_config(args)
    except OSError as exc:
        _emit_error(f"数据目录不可用: {exc}")
        return 2

    if not cfg.auth_enabled:
        print(
            "[warn] 未提供 --token，/api/* 将不做鉴权；仅限本地开发使用。",
            file=sys.stderr,
            flush=True,
        )

    print(f"[info] {APP_NAME} {APP_VERSION} 启动中（{cfg.describe()}）", file=sys.stderr, flush=True)

    uvicorn_cfg = uvicorn.Config(
        app=create_app(cfg),
        host=cfg.host,
        port=cfg.port,
        log_level=args.log_level,
        access_log=False,  # 本地 sidecar，access log 纯噪音
    )
    server = _make_handshake_server(uvicorn_cfg)
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except Exception as exc:  # 启动期异常必须是可读 JSON，否则 Electron 只能干等超时
        _emit_error(f"{type(exc).__name__}: {exc}")
        return 1
    return 0


#: `uvicorn app.main:app` 形式的开发入口（此路径无握手，端口由命令行指定）。
#: 用 `create=False` 避免「仅 import 就产生文件系统副作用」。
app = create_app(build_runtime_config(parse_args([]), create=False))


if __name__ == "__main__":
    raise SystemExit(main())
