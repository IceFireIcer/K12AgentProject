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
from app.routes.code import router as code_router  # noqa: E402
from app.routes.grade import router as grade_router  # noqa: E402
from app.routes.graph import router as graph_router  # noqa: E402
from app.routes.health import router as health_router  # noqa: E402
from app.routes.knowledge import router as knowledge_router  # noqa: E402
from app.routes.profile import router as profile_router  # noqa: E402
from app.routes.quiz import router as quiz_router  # noqa: E402
from app.routes.rag import router as rag_router  # noqa: E402
from app.routes.resources import public_router as animation_resources_router  # noqa: E402
from app.routes.resources import router as animation_router  # noqa: E402
from app.routes.settings import router as settings_router  # noqa: E402
from app.routes.students import router as students_router  # noqa: E402
from app.routes.study import router as study_router  # noqa: E402
from app.animation.compose import router as animation_compose_router  # noqa: E402
from app.safety.guard import install_log_redaction  # noqa: E402
from app.safety.route import router as safety_router  # noqa: E402
from app.security import (  # noqa: E402
    ALLOWED_ORIGIN_REGEX,
    ALLOWED_ORIGINS,
    AUTH_HEADER,
    DebugModeCredentialGuard,
    TokenAuthMiddleware,
)

LOG_LEVELS = ("critical", "error", "warning", "info", "debug", "trace")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="k12-agent-server",
        description="智团团 sidecar（数据 / RAG / 嵌入 / 判分服务）",
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


def _resolve_listen_family(host: str) -> int:
    """按 host 选出正确的 socket family（**IPv4 优先**，没有 A 记录才用 IPv6）。

    为什么需要它（审计发现）：此前硬编码 ``socket.AF_INET``，于是 ``--host ::1``
    通过了 ``ALLOWED_HOSTS`` 校验、却在 ``bind()`` 时抛
    ``[Errno 11001] getaddrinfo failed`` —— 「允许的取值」里混进一个**一定绑不上**的，
    错误信息还是英文的 DNS 错误，排查成本高。

    选 IPv4 优先而不是「按 getaddrinfo 顺序取第一个」：``localhost`` 在多数机器上同时有
    ``::1`` 与 ``127.0.0.1``，取第一个会让绑定结果随机器/网络栈变化（不可复现）。
    显式取 IPv4 保持与历史行为一致（默认 host 就是 ``127.0.0.1``），
    只有 ``::1`` 这种**只有 IPv6** 的输入才会切到 ``AF_INET6``。
    """
    infos = socket.getaddrinfo(host, 0, type=socket.SOCK_STREAM)
    families = [info[0] for info in infos]
    if socket.AF_INET in families:
        return socket.AF_INET
    if families:
        return families[0]
    raise OSError(f"无法解析监听地址：{host}")


def bind_listening_socket(host: str, port: int) -> socket.socket:
    """绑定监听 socket（不 listen —— asyncio 的 create_server 会自己 listen）。

    交给 uvicorn 用 ``server.run(sockets=[sock])``，于是：
    ① 真实端口在**启动前**就已知；② 端口占用能立刻变成一行可读的 error 握手。
    """
    try:
        family = _resolve_listen_family(host)
    except OSError as exc:
        # 解析不了也走同一条错误路径（上层会把它变成一行 error 握手）
        raise OSError(f"{host} 不是可用的监听地址（{exc}）") from exc
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
    except OSError:
        sock.close()
        raise
    return sock


def create_app(cfg: RuntimeConfig) -> FastAPI:
    # ★★ 日志脱敏**必须在建 handler 之后、任何业务日志之前**生效，且**两条启动路径都要**。
    #   历史缺陷：它只在 `main()` 里调用，于是『手动调试』那条路径
    #   （`uv run uvicorn app.main:app`，走本文件末尾的模块级 app）**一点脱敏都没有** ——
    #   LLM/嵌入的明文 Key 一旦被任何一行日志带出来就是明文（审计 M-7）。
    #   本函数幂等：重复调用只会把过滤器挂到**新出现的** handler 上，不会叠加第二个
    #   （见 `app/safety/guard.py` 的 `install_log_redaction`）。
    #   ⚠️ `main()` 里仍保留同一次调用：那里先 `configure_logging()` 建好 root handler、
    #     再调本函数，顺序与原来一致（只是现在多跑一遍幂等调用）。
    #   ⚠️ 必须放在**创建 FastAPI 之前**：路由挂载期就可能打日志。
    install_log_redaction()

    app = FastAPI(
        title=APP_TITLE,
        version=APP_VERSION,
        # ★ 打包态关掉 `/docs` 与 `/openapi.json`：两者都免鉴权，等于把**完整接口面**
        #   （34 条路径 / 85 个 schema，含 `/api/settings/runtime` 及其明文 `apiKey` 字段说明）
        #   连带一个可交互的控制台暴露给任何本机进程（审计 L 项）。
        #   生产包不需要它们：契约的 TS 类型是**构建期**由 `scripts/export_openapi.py`
        #   生成好的，Pi 与渲染进程都不在运行期读这份 schema。
        #   开发/调试态（源码运行，`cfg.frozen` 为假）保留 —— 那是排查便利。
        #   ⚠️ `/health` 不受影响：它是探活端点，必须一直可达（有意免鉴权）。
        docs_url=None if cfg.frozen else "/docs",
        openapi_url=None if cfg.frozen else "/openapi.json",
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
    app.include_router(profile_router)
    app.include_router(quiz_router)
    # 学习档案（章节清单 / 学习报告 / 错题本）：只读聚合视图，
    # 与 profile（画像+推荐，写入侧）分开成两个文件 —— 它们的变更原因不同。
    app.include_router(knowledge_router)
    app.include_router(study_router)
    # 学段自动推断（票 21）：前端没有选择器，这里是唯一的学段写路径
    app.include_router(grade_router)
    # 编程（票 18/19）：只提供模板/提示/报错翻译 —— **没有任何执行原语**
    app.include_router(code_router)
    # 动画（票 16）分两条：
    #   ① /api/animation/* 由主进程调用，走既有 X-Auth-Token 中间件；
    #   ② /resources/animation/* 由 **iframe 直接加载** —— iframe 带不了自定义 header，
    #      所以刻意不带 /api/ 前缀、不过鉴权中间件，改用**一次性 nonce**（绑定学生+知识点+有效期）。
    #      这是有意的例外，不是漏挂鉴权：nonce 校验在路由内部完成。
    app.include_router(animation_router)
    app.include_router(animation_resources_router)
    # 内容安全（票 22）：输入侧检查 / 生成结束后的整段终审 / provider 边界脱敏。
    # ★ 这一挂是**必须的**：主进程的 `agent/safety/review.ts` 是投递层，判定全在这里；
    #   不挂载的话 `blocked` 事件在真实回合里**永远不会产生**（审计发现的头号缺陷）。
    #   `include_in_schema=False`（在 route.py 里）：内部管道，不进 OpenAPI 生成物。
    app.include_router(safety_router)
    # 动画自由生成的合流（票 17 的补充路径）：模型出片段 → 这里拼装 + 校验 → 422 则重试。
    # ★ 不挂载的话，`animation.ts` 的 `generate` 会拿到 404 并降级 —— 表面上「有兜底」，
    #   但「自由生成」这条链路**永远不可达**（与被审计出的缺陷同一形态）。
    app.include_router(animation_compose_router)

    # ★ 中间件顺序是**有讲究的**，别调换：
    #   Starlette 的洋葱模型里「最后 add 的在最外层」，所以：
    #   先 add 调试模式凭据收口（最内层）→ 再 add 鉴权（中层）→ 最后 add CORS（外层）。
    #   若把鉴权与 CORS 反过来，鉴权提前 return 的 401 就不带 CORS 头，
    #   浏览器会把它伪装成 `TypeError: Failed to fetch`，排查成本极高。
    #   （调试收口排最内层的理由见 `app/security.py` 的 `DebugModeCredentialGuard`。）
    app.add_middleware(DebugModeCredentialGuard, token=cfg.token)
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
    # ★ 日志脱敏：LLM/嵌入的明文与 API Key 不得进日志（执行文档 §12）。
    #   放在 configure_logging 之后、任何业务日志之前；它会保留 %s / %(name)s 占位符，
    #   否则 record.getMessage() 会抛 TypeError（见 P-009）。
    #   ⚠️ `create_app()` 里**也**调了一次（两条启动路径必须都有脱敏，见那里的说明）。
    #     两处都调是**刻意**的，不是重复：这里保证「main 路径在建 app 之前就已脱敏」，
    #     那里保证「只有 app 被建出来时（`uvicorn app.main:app` 调试路径）也脱敏」。
    #     函数是幂等的（按 RedactionFilter 实例去重），后一次调用只会补齐新出现的 handler。
    install_log_redaction()
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

    # ★★ 顺序有讲究：**先把 app 与 uvicorn.Config 建好，再发 ready 握手**。
    # 曾经是「先发 ready、后 create_app」——若 create_app 抛异常（路由导入错、契约不匹配、
    # 某个模块在 import 期就炸），Electron 已经收到 ready 然后进程消失，
    # 上层只能显示「进程意外退出」，拿不到任何可读原因（这类事故排查成本极高）。
    # 现在 create_app 在握手之前：失败就走 stderr 日志 + 进程非零退出，ready 一个字都没发过。
    #
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

    uvicorn.Server(config).run(sockets=[sock])
    return 0


# 供 `uv run uvicorn app.main:app` 使用（执行文档 §7.5 的手动调试命令）。
# 这条路径**不发握手**（没有端口 0、没有 token），只用于人工 curl。
# 纯解析、无副作用：不建目录、不碰数据库。
# ⚠️ **调试模式的两条收口**（审计 M-7，改动下面这行前先读 `app/security.py`）：
#   ① `/api/settings/runtime`（唯一返回**明文 API Key** 的出口）在本路径下**被拒**（403 + 可读理由）；
#      其余 `/api/*` 与 `/health` 照旧免鉴权，调试便利保留；
#   ② 日志脱敏由 `create_app()` 内的 `install_log_redaction()` 负责（本路径过去完全没有脱敏）。
#   要连这条接口就得显式给 token —— 走**模块入口**带上本应用自己的 `--token`
#   （`uvicorn` 的 CLI 不认这个选项，实测报 `No such option '--token'`）：
#       uv run python -m app.main --port 8756 --token <t>
app = create_app(build_runtime_config())


if __name__ == "__main__":
    raise SystemExit(main())
