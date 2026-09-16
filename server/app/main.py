"""FastAPI sidecar 入口：参数解析 → 绑定端口 → 握手 → 起 uvicorn。

**握手协议（与 Electron 侧 `desktop/src/main/sidecar/protocol.ts` 严格对应）**

进程启动为 ``--host 127.0.0.1 --port 0 --token <hex> --data-dir <path>``；
绑定成功后，stdout 输出**恰好一行** JSON，此后再无任何 stdout 输出：

    {"event":"ready","port":54321,"pid":12345,"version":"0.1.0","frozen":false}

启动失败（端口占用等）输出一行：

    {"event":"error","message":"无法绑定 127.0.0.1:8756 —— ..."}

**stdout 是保留通道**：日志（含 uvicorn 的）全部走 stderr。任何库往 stdout 打日志
都会污染握手解析 —— 所以这里从入口就把根 logger 钉在 stderr，且自己实现握手。

**为什么自己绑 socket**：``--port 0`` 的真实端口只有在 uvicorn 内部建好 server 之后才知道；
而且绑定失败时 uvicorn 是 ``sys.exit(1)`` + 只写 stderr，上层拿不到可读原因。
自己先绑、再把 socket 交给 uvicorn，两件事都掌握在自己手里。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
from typing import Any

# ★ 必须在任何输出之前调用。
# PyInstaller 的 bootloader 会忽略 PYTHONUTF8 / PYTHONIOENCODING，
# 打包态只有 Python 层的 reconfigure 有效（见 app/console.py 的说明）。
from app.console import install_utf8_stdio

install_utf8_stdio()

import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from app.config import (  # noqa: E402
    APP_TITLE,
    APP_VERSION,
    DEFAULT_HOST,
    DEFAULT_LOG_LEVEL,
    DEFAULT_PORT,
    RuntimeConfig,
    build_runtime_config,
)
from app.routes.graph import router as graph_router  # noqa: E402
from app.routes.health import router as health_router  # noqa: E402
from app.routes.rag import router as rag_router  # noqa: E402
from app.routes.settings import router as settings_router  # noqa: E402
from app.routes.students import router as students_router  # noqa: E402
from app.security import (  # noqa: E402
    ALLOWED_ORIGIN_REGEX,
    ALLOWED_ORIGINS,
    AUTH_HEADER,
    TokenAuthMiddleware,
)

LOG_LEVELS = ("critical", "error", "warning", "info", "debug", "trace")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="k12-agent-server",
        description="K12 AI 教学助手 sidecar（数据 / RAG / 嵌入服务）",
    )
    # 不在这里用 choices 限制 host：非回环地址统一由 build_runtime_config 拒绝，
    # 这样错误信息是中文且只有一处规则。
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址（只允许回环）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="端口，0 = 系统分配")
    parser.add_argument("--token", default="", help="随机鉴权 token（所有 /api/* 必须携带）")
    parser.add_argument("--data-dir", default=None, help="可写数据目录（Electron 传 userData）")
    parser.add_argument("--log-level", default=DEFAULT_LOG_LEVEL, choices=LOG_LEVELS)
    return parser.parse_args(argv)


def configure_logging(level: str) -> None:
    """日志一律走 **stderr**，stdout 留给握手。"""
    logging.basicConfig(
        stream=sys.stderr,
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


def emit_handshake(payload: dict[str, Any]) -> None:
    """把握手行写到 **stdout**（保留通道）。

    ⚠️ **整个进程只允许调用一次**。Electron 侧把 stdout 的第二行视为异常信号；
    ``scripts/build_server.py`` 的冒烟也会断言「stdout 恰好一行」。
    ``ensure_ascii=False`` 让中文错误信息保持可读（stdout 已被 console.py 切成 UTF-8）。
    """
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def bind_listening_socket(host: str, port: int) -> socket.socket:
    """绑定监听 socket（不 listen —— asyncio 的 create_server 会自己 listen）。

    交给 uvicorn 用 ``server.run(sockets=[sock])``，于是：
    ① 真实端口在**启动前**就已知；② 端口占用能立刻变成一行可读的 error 握手。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
    except OSError:
        sock.close()
        raise
    return sock


def create_app(cfg: RuntimeConfig) -> FastAPI:
    app = FastAPI(
        title=APP_TITLE,
        version=APP_VERSION,
        docs_url="/docs",
        redoc_url=None,
    )
    # 运行期配置挂在 app.state 上，路由通过 Request 取用（避免全局变量）
    app.state.config = cfg

    # 路由注册：契约冻结在 app/contracts.py，这里只挂载（票 04）
    # rag / graph 由数据主线（票 11 / 12）实现，供 Pi 的 rag_search Tool 调用
    app.include_router(health_router)
    app.include_router(settings_router)
    app.include_router(students_router)
    app.include_router(rag_router)
    app.include_router(graph_router)

    # ★ 中间件顺序是**有讲究的**，别调换：
    #   Starlette 的洋葱模型里「最后 add 的在最外层」，所以：
    #   先 add 鉴权（内层）→ 后 add CORS（外层）。
    #   若反过来，鉴权提前 return 的 401 就不带 CORS 头，
    #   浏览器会把它伪装成 `TypeError: Failed to fetch`，排查成本极高。
    app.add_middleware(TokenAuthMiddleware, token=cfg.token)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(ALLOWED_ORIGINS),
        allow_origin_regex=ALLOWED_ORIGIN_REGEX,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", AUTH_HEADER],
    )
    return app


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = build_runtime_config(
        host=args.host,
        port=args.port,
        token=args.token,
        data_dir=args.data_dir,
        log_level=args.log_level,
    )
    configure_logging(cfg.log_level)
    logger = logging.getLogger(APP_TITLE)

    try:
        sock = bind_listening_socket(cfg.host, cfg.port)
    except OSError as exc:
        # 绑定失败必须走**握手通道**报错：Electron 只看得懂 stdout，
        # 若只写 stderr，界面就只能显示「进程意外退出」，说不清原因。
        message = f"无法绑定 {cfg.host}:{cfg.port} —— {exc}"
        logger.error(message)
        emit_handshake({"event": "error", "message": message})
        return 2

    bound_port = int(sock.getsockname()[1])
    logger.info(
        "已绑定 %s:%s（请求端口 %s）；data_dir=%s frozen=%s token=%s",
        cfg.host,
        bound_port,
        cfg.port,
        cfg.data_dir,
        cfg.frozen,
        "已设置" if cfg.token else "未设置",
    )

    # ★ 唯一一次 stdout 输出。pid 是**本进程**的 pid —— Electron 必须用它杀进程树，
    #   因为 dev 态它 spawn 的是 `uv`，`uv` 的 pid 不是真正占端口的那个。
    emit_handshake(
        {
            "event": "ready",
            "port": bound_port,
            "pid": os.getpid(),
            "version": APP_VERSION,
            "frozen": cfg.frozen,
        }
    )

    # log_config=None：不让 uvicorn 自建 handler，日志经根 logger 统一走 stderr。
    # access_log=False：探活轮询每 300ms 一次，访问日志会淹没有用信息。
    config = uvicorn.Config(
        create_app(cfg),
        host=cfg.host,
        port=bound_port,
        log_config=None,
        access_log=False,
        log_level=cfg.log_level,
    )
    uvicorn.Server(config).run(sockets=[sock])
    return 0


# 供 `uv run uvicorn app.main:app` 使用（执行文档 §7.5 的手动调试命令）。
# 这条路径**不发握手**（没有端口 0、没有 token），只用于人工 curl。
# 纯解析、无副作用：不建目录、不碰数据库。
app = create_app(build_runtime_config())


if __name__ == "__main__":
    raise SystemExit(main())
