"""FastAPI sidecar 入口：参数解析 → 组装应用 → 起 uvicorn。

**stdout 是保留通道**：票 02 起它只允许输出**一行**握手 JSON
（``{"event":"ready","port":N,"pid":P}``）。因此这里从第一天就把日志全部钉在 stderr，
免得将来某个库往 stdout 打日志污染握手解析。
"""

from __future__ import annotations

import argparse
import logging
import sys

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
from app.routes.health import router as health_router  # noqa: E402
from app.security import ALLOWED_ORIGIN_REGEX, ALLOWED_ORIGINS, AUTH_HEADER  # noqa: E402

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
    parser.add_argument("--token", default="", help="随机鉴权 token（票 02 起强制校验）")
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


def create_app(cfg: RuntimeConfig) -> FastAPI:
    app = FastAPI(
        title=APP_TITLE,
        version=APP_VERSION,
        docs_url="/docs",
        redoc_url=None,
    )
    # 运行期配置挂在 app.state 上，路由通过 Request 取用（避免全局变量）
    app.state.config = cfg

    app.include_router(health_router)

    # ★ CORS 必须**最后**加：Starlette 是洋葱模型，最后 `add_middleware` 的在最外层。
    #   反过来的话，鉴权中间件提前 return 的 401 就不带 CORS 头，
    #   浏览器会把它伪装成 `TypeError: Failed to fetch`，极难排查。
    #   本项目的渲染进程不直连 sidecar，所以这段 CORS 只是纵深防御 —— 但仍然要写对。
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
    logger.info(
        "启动中：host=%s port=%s data_dir=%s frozen=%s token=%s",
        cfg.host,
        cfg.port,
        cfg.data_dir,
        cfg.frozen,
        "已设置" if cfg.token else "未设置",
    )

    # log_config=None：不让 uvicorn 自建 handler，日志经根 logger 统一走 stderr。
    # access_log=False：探活轮询每 300ms 一次，访问日志会淹没有用信息。
    uvicorn.run(
        create_app(cfg),
        host=cfg.host,
        port=cfg.port,
        log_config=None,
        access_log=False,
        log_level=cfg.log_level,
    )
    return 0


# 供 `uv run uvicorn app.main:app` 使用（执行文档 §7.5 的开发命令）。
# 纯解析、无副作用：不建目录、不碰数据库。
app = create_app(build_runtime_config())


if __name__ == "__main__":
    raise SystemExit(main())
