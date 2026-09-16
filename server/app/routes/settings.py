"""``GET`` / ``PUT /api/settings`` 与 ``POST /api/settings/probe``（§6.3）。

**薄控制器**：解析 → 调存储 → 序列化契约模型，业务规则不写在这里。
**API Key 掩码语义**（票 07 硬要求）由 `app.contracts` 的
:func:`~app.contracts.resolve_api_key` / :func:`~app.contracts.mask_api_key` 提供，
本文件只负责「读回一律掩码、占位不覆盖、清除必须显式」。

**落盘**（票 07 已落地）：``app/settings_store.py`` 的
:class:`~app.settings_store.ConfigFileSettingsStore` 原子写 ``<data-dir>/config.json``；
本文件按 `app.state.settings_store` 注入点取实现（注入优先，测试可替换）。

**探测**（票 07 已落地）：``POST /api/settings/probe`` 是 sidecar 唯一的外呼 HTTP ——
它不是业务规则，而是「设置域」里的一次连通性自检，所以放在 HTTP 边界这一层，
存储层（`settings_store.py`）保持纯文件 I/O。探测**不落库、不改配置**：失败也允许保存（离线场景）。
"""

from __future__ import annotations

import contextlib
import json
import logging
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from fastapi import APIRouter, HTTPException, Request, status

from app.config import resolve_data_dir
from app.contracts import (
    EmbeddingConfig,
    EmbeddingConfigIn,
    LlmConfig,
    LlmConfigIn,
    ProbeRequest,
    ProbeResult,
    SettingsResponse,
    SettingsUpdateRequest,
    normalize_base_url,
    resolve_api_key,
)
from app.settings_store import (
    ConfigFileSettingsStore,
    InMemorySettingsStore,
    SettingsStore,
    SettingsWriteError,
    StoredEmbedding,
    StoredLlm,
    StoredSettings,
)

__all__ = [
    "SETTINGS_STORE_ATTR",
    "InMemorySettingsStore",
    "SettingsStore",
    "StoredEmbedding",
    "StoredLlm",
    "StoredSettings",
    "router",
]

logger = logging.getLogger("app.routes.settings")

router = APIRouter(prefix="/api", tags=["settings"])

#: 注入点：测试与生产接线都通过 `app.state.settings_store` 替换实现（注入优先）。
SETTINGS_STORE_ATTR = "settings_store"

#: 「没有用户数据目录」的提示只打一次（进程级）。
_MEMORY_FALLBACK_WARNED = False


def get_settings_store(request: Request) -> SettingsStore:
    """取存储实现。

    顺序（票 07）：

    1. ``app.state.settings_store`` —— 显式注入（测试 / 将来由 `main.py` 接线）优先；
    2. 否则按运行期配置建**落盘**实现（``<data-dir>/config.json``）；
    3. 若 ``data-dir`` 是**未显式指定**的开发默认目录（单测、`uv run uvicorn` 手动 curl 调试），
       退回内存实现 —— 那种场景没有「用户数据目录」可言，往仓库的 ``server/_data`` 里写配置
       既污染开发目录，又会让契约测试互相串状态。Electron 每次都会传 ``--data-dir <userData>``，
       真实运行永远走第 2 条。
    """
    store = getattr(request.app.state, SETTINGS_STORE_ATTR, None)
    if store is not None:
        return store

    data_dir = _explicit_data_dir(request)
    if data_dir is not None:
        store = ConfigFileSettingsStore(data_dir)
    else:
        _warn_memory_fallback_once()
        store = InMemorySettingsStore()

    setattr(request.app.state, SETTINGS_STORE_ATTR, store)
    return store


def _warn_memory_fallback_once() -> None:
    """只提示一次（单测/调试期每个请求都刷屏会把日志淹掉，反而让人忽略它）。"""
    global _MEMORY_FALLBACK_WARNED
    if _MEMORY_FALLBACK_WARNED:
        return
    _MEMORY_FALLBACK_WARNED = True
    logger.warning(
        "未显式指定 --data-dir（当前为开发默认目录 %s）：设置使用内存存储，重启即失。"
        "Electron 启动时会传入 userData，配置才会写入 config.json。",
        resolve_data_dir(None),
    )


def _explicit_data_dir(request: Request) -> Path | None:
    """运行期配置里的 data-dir —— **显式指定**时返回路径，未指定（开发默认）返回 ``None``。"""
    runtime = getattr(request.app.state, "config", None)
    raw = getattr(runtime, "data_dir", None)
    if raw is None:
        return None

    data_dir = Path(raw)
    with contextlib.suppress(OSError):
        if data_dir.resolve() == resolve_data_dir(None):
            return None
    return data_dir


# ---------------------------------------------------------------- 转换逻辑 --
def to_response(stored: StoredSettings) -> SettingsResponse:
    """落盘 → 出参：**明文在这里变成掩码**（`from_plain` 是唯一入口）。"""
    return SettingsResponse(
        llm=LlmConfig.from_plain(
            provider_name=stored.llm.provider_name,
            base_url=stored.llm.base_url,
            api_key=stored.llm.api_key,
            model_id=stored.llm.model_id,
        ),
        embedding=EmbeddingConfig.from_plain(
            mode=stored.embedding.mode,
            base_url=stored.embedding.base_url,
            api_key=stored.embedding.api_key,
            model_id=stored.embedding.model_id,
        ),
    )


def apply_llm(payload: LlmConfigIn, current: StoredLlm) -> StoredLlm:
    """入参 + 现值 → 新落盘值。**Key 的取舍全部交给 `resolve_api_key`。**"""
    return StoredLlm(
        provider_name=payload.provider_name.strip(),
        base_url=payload.base_url,
        api_key=resolve_api_key(payload.api_key, current.api_key, clear=payload.clear_api_key),
        model_id=payload.model_id.strip(),
    )


def apply_embedding(payload: EmbeddingConfigIn, current: StoredEmbedding) -> StoredEmbedding:
    """入参 + 现值 → 新落盘值。

    `base_url` / `model_id` / `api_key` 三个可选字段遵循**同一条「占位即保留」规则**
    （Key 的规则见 `resolve_api_key`）：否则设置页切一下 `mode` 就会顺手清掉云端地址与模型 ID。
    """
    return StoredEmbedding(
        mode=payload.mode,
        base_url=payload.base_url or current.base_url,
        api_key=resolve_api_key(payload.api_key, current.api_key, clear=payload.clear_api_key),
        model_id=payload.model_id or current.model_id,
    )


# ---------------------------------------------------------------- 路由 --
@router.get("/settings", response_model=SettingsResponse, summary="读设置（Key 只回掩码）")
def read_settings(request: Request) -> SettingsResponse:
    return to_response(get_settings_store(request).load())


@router.put("/settings", response_model=SettingsResponse, summary="存设置")
def update_settings(payload: SettingsUpdateRequest, request: Request) -> SettingsResponse:
    """保存设置。

    ``apiKey`` 提交空串或掩码（``…abcd``）**不会**抹掉已存 Key —— 用户没动这一栏时
    前端会把读回来的掩码原样提交；只有 ``clearApiKey=true`` 才删除。
    两栏都可省略（= 不动那一栏），但至少要提交一栏。
    """
    store = get_settings_store(request)
    current = store.load()

    updated = StoredSettings(
        llm=(
            apply_llm(payload.llm, current.llm)
            if payload.llm is not None
            else current.llm
        ),
        embedding=(
            apply_embedding(payload.embedding, current.embedding)
            if payload.embedding is not None
            else current.embedding
        ),
    )
    try:
        store.save(updated)
    except SettingsWriteError as exc:
        # 写盘失败必须让用户看见（可读 5xx），不能返回「保存成功」的假象。
        logger.error("保存设置失败：%s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"{exc}（配置未保存，请检查磁盘空间与目录权限）",
        ) from exc
    return to_response(updated)


@router.post(
    "/settings/probe",
    response_model=ProbeResult,
    summary="探测 LLM 连通性（票 07 实现）",
)
def probe_settings(request: Request, payload: ProbeRequest | None = None) -> ProbeResult:
    """真实连通性探测（票 07 落地）：``GET {baseUrl}/models``，必要时补一条 1-token 对话请求。

    ★ **BaseURL 的 `/v1` 陷阱**：默认值历史上是 ``https://api.deepseek.com/v1``（OpenAI 兼容习惯），
    而 Pi 内置 DeepSeek provider 用的是 ``https://api.deepseek.com``（**无 `/v1`**）。
    两者都可能连通、也都可能只有一种能连通，所以这里**不自动改写**用户填的值：
    先原样探测（探测的就是「保存后会用的那个地址」），只有在**路径不存在**（404/405）时才拿
    另一种写法做一次诊断，并在失败原因里明确告诉用户该改成哪一个。

    探测的是**提交的候选配置**（先探测、满意再保存）；Key 提交掩码/空串时用已存 Key。
    **探测失败不阻塞保存**（断网/离线演示仍要能存配置），失败原因一律是可读中文。
    """
    if payload is None:
        return ProbeResult(ok=False, message="请求体缺少 llm 配置，无法探测。")

    current = get_settings_store(request).load()

    api_key = resolve_api_key(
        payload.llm.api_key, current.llm.api_key, clear=payload.llm.clear_api_key
    )
    base_url = normalize_base_url(payload.llm.base_url)
    model_id = payload.llm.model_id.strip() or current.llm.model_id

    return probe_llm_connectivity(base_url=base_url, api_key=api_key, model_id=model_id)


# --------------------------------------------------------------------------- #
# 连通性探测（本进程唯一的外呼 HTTP）
#
# 为什么用标准库 urllib 而不是 httpx：
#   httpx 现在只在 dev 组（`app/rag/embedder.py` 的云端嵌入出于同一理由也用了 urllib），
#   为一个探测接口把它升成运行期依赖，等于给 PyInstaller 多一个要 collect 的包（打包风险 × 15 天冲刺）。
#   本文件因此**不新增任何依赖**。
# --------------------------------------------------------------------------- #
#: 单次外呼超时（秒）。设置页要「几秒钟内给结论」，绝不能把 UI 卡住。
PROBE_TIMEOUT_SECONDS = 3.0
#: 整个探测（最多 3 次外呼）的总预算：超了就不再试，返回可读的超时说明。
PROBE_TOTAL_BUDGET_SECONDS = 8.0
#: 读取响应体的上限（防供应商返回超大页面把内存吃满；诊断只需要开头一段）。
PROBE_MAX_BODY_BYTES = 64 * 1024
#: 回显供应商错误文本的长度上限。
PROBE_MAX_DETAIL_CHARS = 160
#: 探测请求的 User-Agent（有些网关按 UA 拒绝空值；也方便对方日志里认出我们）。
PROBE_USER_AGENT = "k12-agent-desktop/0.1 (settings-probe)"
#: 1-token 请求用的最小提示词（只验证「这个地址能不能跑通一次对话」）。
PROBE_PING_PROMPT = "你好"


@dataclass(frozen=True)
class HttpOutcome:
    """一次外呼的结果：**要么有状态码，要么有错误分类**（两者必有其一）。"""

    status: int | None = None
    body: bytes = b""
    #: ``None``（有响应）/ ``timeout`` / ``dns`` / ``refused`` / ``tls`` / ``config`` / ``network``
    error: str | None = None
    #: 原始错误文本（只用于诊断，进消息前会截断；**永不含 Key**）。
    detail: str = ""


class ProbeTransport(Protocol):
    """外呼实现（单测注入假实现，不联网）。"""

    def exchange(
        self,
        *,
        method: str,
        url: str,
        api_key: str,
        payload: dict[str, Any] | None,
        timeout: float,
    ) -> HttpOutcome: ...


class UrllibTransport:
    """默认实现：标准库 ``urllib.request``（见上方「为什么不用 httpx」）。"""

    def exchange(
        self,
        *,
        method: str,
        url: str,
        api_key: str,
        payload: dict[str, Any] | None,
        timeout: float,
    ) -> HttpOutcome:
        headers = {"Accept": "application/json", "User-Agent": PROBE_USER_AGENT}
        data: bytes | None = None
        if api_key:
            # ★ Key 只进请求头：不进 URL、不进日志、不进异常消息。
            headers["Authorization"] = f"Bearer {api_key}"
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return HttpOutcome(status=int(response.status), body=response.read(PROBE_MAX_BODY_BYTES))
        except urllib.error.HTTPError as exc:
            # HTTPError 本身也是响应：状态码与响应体正是「401 还是 404」的证据。
            body = b""
            with contextlib.suppress(Exception):
                body = exc.read(PROBE_MAX_BODY_BYTES)
            return HttpOutcome(status=int(exc.code), body=body)
        except urllib.error.URLError as exc:
            return _classify_reason(exc.reason)
        except (TimeoutError, socket.timeout):
            return HttpOutcome(error="timeout", detail=f"{timeout:g} 秒内无响应")
        except OSError as exc:
            return HttpOutcome(error="network", detail=f"{type(exc).__name__}: {exc}")


def _classify_reason(reason: Any) -> HttpOutcome:
    """把 urllib 的 ``reason`` 归类成可读的失败种类（用户要能分辨「填错了」和「网断了」）。"""
    if isinstance(reason, socket.gaierror):
        return HttpOutcome(error="dns", detail=f"{type(reason).__name__}: {reason}")
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return HttpOutcome(error="timeout", detail="连接超时")
    if isinstance(reason, ssl.SSLError):
        return HttpOutcome(error="tls", detail=f"{type(reason).__name__}: {reason}")
    if isinstance(reason, ConnectionRefusedError):
        return HttpOutcome(error="refused", detail=f"{type(reason).__name__}: {reason}")
    if isinstance(reason, str):
        # 例：`unknown url type: 'api.deepseek.com'`（用户忘了写 https://）
        return HttpOutcome(error="config", detail=reason)
    return HttpOutcome(error="network", detail=f"{type(reason).__name__}: {reason}")


def base_url_variant(base_url: str) -> str | None:
    """另一种常见写法（``…`` ↔ ``…/v1``），**只用于诊断**，绝不自动改写用户填的值。

    DeepSeek 官方两种写法都可用，但多数 OpenAI 兼容服务只认一种：
    ``https://host/v1``（网关习惯）或 ``https://host``（直连）。返回 ``None`` 表示无法给出对照写法。
    """
    trimmed = normalize_base_url(base_url)
    if trimmed == "":
        return None
    if trimmed.endswith("/v1"):
        stripped = trimmed[: -len("/v1")]
        return stripped or None
    return f"{trimmed}/v1"


def probe_llm_connectivity(
    *,
    base_url: str,
    api_key: str,
    model_id: str,
    timeout: float = PROBE_TIMEOUT_SECONDS,
    total_budget: float = PROBE_TOTAL_BUDGET_SECONDS,
    transport: ProbeTransport | None = None,
) -> ProbeResult:
    """探测一组候选 LLM 配置能否真正跑通（返回**永远**是可读中文，不抛异常）。

    顺序（每一步都能单独解释失败原因）：

    1. ``GET {baseUrl}/models`` —— 最轻的鉴权+路由自检（OpenAI 兼容标准端点）；
    2. 若返回 404/405（**路径不存在**而不是鉴权问题），补一条 ``POST {baseUrl}/chat/completions``
       的 1-token 请求：有些兼容服务不实现 ``/models``，但对话是通的；
    3. 仍 404 时，用另一种写法（``/v1`` ↔ 无 ``/v1``）做一次诊断，直接告诉用户该改成哪个地址。

    ``ok`` 只反映**用户提交的那个地址**（因为保存后 Pi 用的就是它）；
    第 3 步的成功只用来把失败原因说清楚，不会让 ``ok`` 变真。
    """
    if base_url == "":
        return ProbeResult(ok=False, message="BaseURL 不能为空：请填写服务的根地址。")

    if api_key == "":
        return ProbeResult(
            ok=False,
            message=(
                "尚未配置 API Key：请填好这一栏再探测。"
                "（如果界面上显示的是 …xxxx 这样的掩码，说明 Key 已经存好了，直接点「探测」即可。）"
            ),
        )

    backend = transport or UrllibTransport()
    started = time.monotonic()
    deadline = started + max(total_budget, timeout)

    def call(method: str, url: str, payload: dict[str, Any] | None = None) -> HttpOutcome | None:
        """按剩余预算发起一次外呼；``None`` = 预算已用完（不再外呼）。"""
        remaining = deadline - time.monotonic()
        if remaining <= 0.5:
            return None
        return backend.exchange(
            method=method,
            url=url,
            api_key=api_key,
            payload=payload,
            timeout=min(timeout, remaining),
        )

    host = urllib.parse.urlsplit(base_url).netloc or base_url
    variant = base_url_variant(base_url)

    # ---------------- 第 1 步：GET /models ----------------
    models_url = f"{base_url}/models"
    outcome = call("GET", models_url)

    if outcome is None:
        return _timeout_result(host, timeout)

    if outcome.status is not None and 200 <= outcome.status < 300:
        return _models_ok(outcome, models_url, base_url, model_id)

    if outcome.status in (401, 403):
        return _auth_failed(outcome, api_key)

    if outcome.status in (404, 405, 400):
        # 路径形态可疑（而不是鉴权/网络问题）：先试对话端点，再试另一种写法。
        ping = call(
            "POST",
            f"{base_url}/chat/completions",
            {
                "model": model_id,
                "messages": [{"role": "user", "content": PROBE_PING_PROMPT}],
                "max_tokens": 1,
                "stream": False,
            },
        )

        if ping is None:
            return _timeout_result(host, timeout)

        if ping.status is None:
            # 连不上就是连不上：换路径写法也救不了，直接把网络层原因说清楚。
            return _error_failure(ping, host, timeout)

        if 200 <= ping.status < 300:
            return ProbeResult(
                ok=True,
                message=(
                    f"连通成功：{base_url} 可以正常调用对话接口"
                    f"（该地址没有 /models 端点，已用 1-token 请求验证，模型「{model_id}」）。"
                    f"保存后即以该地址调用。{_deepseek_hint(host)}"
                ),
            )

        if ping.status in (401, 403):
            return _auth_failed(ping, api_key)

        if 400 <= ping.status < 500 and ping.status not in (404, 405):
            return ProbeResult(
                ok=False,
                message=(
                    f"地址可达，但请求被供应商拒绝（HTTP {ping.status}）："
                    f"{_provider_message(ping.body, api_key)}。"
                    f"多半是 ModelID 填错了（请核对「{model_id}」是否为该地址支持的模型名）。"
                ),
            )

        # ---------------- 第 3 步：换一种 /v1 写法做诊断 ----------------
        if variant is not None:
            alt = call("GET", f"{variant}/models")
            if alt is not None and alt.status is not None and 200 <= alt.status < 300:
                return ProbeResult(
                    ok=False,
                    message=(
                        f"BaseURL 的路径不对：你填的 {base_url} 返回 HTTP {outcome.status}（该路径不存在），"
                        f"而同一服务的 {variant} 可以连通。"
                        f"请把 BaseURL 改成 {variant}（保存后即以它调用）。{_deepseek_hint(host)}"
                    ),
                )
            if alt is not None and alt.status in (401, 403):
                return _auth_failed(alt, api_key)

            alt_status = "无法连通（超时或网络不可达）" if alt is None else f"返回 HTTP {alt.status}"
            return ProbeResult(
                ok=False,
                message=(
                    f"两种常见写法都探测失败：{base_url} 返回 HTTP {outcome.status}，"
                    f"{variant} {alt_status}。请确认 BaseURL 填的是「服务根地址」"
                    f"（例如 https://api.deepseek.com 或 https://api.deepseek.com/v1），"
                    f"不要填到 /chat/completions 这类具体接口上。{_deepseek_hint(host)}"
                ),
            )

        return _status_failure(outcome, base_url, api_key)

    if outcome.status is not None:
        return _status_failure(outcome, base_url, api_key)

    return _error_failure(outcome, host, timeout)


# ------------------------------------------------------------------ 结果文案 --
def _models_ok(
    outcome: HttpOutcome,
    models_url: str,
    saved_base_url: str,
    model_id: str,
) -> ProbeResult:
    host = _host_of(models_url)
    model_ids = _extract_model_ids(outcome.body)
    if model_ids is None:
        return ProbeResult(
            ok=True,
            message=(
                f"连通成功：{models_url} 返回 HTTP {outcome.status}（响应不是标准的模型列表，"
                f"但服务与鉴权都正常）。保存后即以 {saved_base_url} 调用。{_deepseek_hint(host)}"
            ).strip(),
        )

    sample = "、".join(model_ids[:5])
    more = "…" if len(model_ids) > 5 else ""
    message = (
        f"连通成功：{models_url} 返回 HTTP {outcome.status}，可见模型 {len(model_ids)} 个"
        f"（示例：{sample}{more}）。保存后即以 {saved_base_url} 调用。{_deepseek_hint(host)}"
    )
    if model_id and model_id not in model_ids:
        # 只是提醒：有些服务的 /models 列表不全，或用户填的是自建别名。
        message += f"提醒：模型列表里没有看到「{model_id}」，请顺便核对 ModelID。"
    return ProbeResult(ok=True, message=message.strip())


def _auth_failed(outcome: HttpOutcome, api_key: str) -> ProbeResult:
    detail = _provider_message(outcome.body, api_key)
    suffix = f"：{detail}" if detail else ""
    return ProbeResult(
        ok=False,
        message=(
            f"API Key 被拒绝（HTTP {outcome.status}）{suffix}。"
            f"请核对 Key 是否填错、是否已过期或额度耗尽；"
            f"供应商名称只用于显示，不影响调用。"
        ),
    )


def _status_failure(outcome: HttpOutcome, base_url: str, api_key: str) -> ProbeResult:
    detail = _provider_message(outcome.body, api_key)
    suffix = f"：{detail}" if detail else ""
    return ProbeResult(
        ok=False,
        message=(
            f"{base_url} 返回 HTTP {outcome.status}{suffix}。"
            f"请检查 BaseURL 是否为该服务的地址；地址可达但没有可用接口时也会是这个结果。"
        ),
    )


def _error_failure(outcome: HttpOutcome, host: str, timeout: float) -> ProbeResult:
    host_label = f"「{host}」"
    if outcome.error == "dns":
        return ProbeResult(
            ok=False,
            message=(
                f"域名解析失败：找不到主机 {host_label}。"
                f"请检查 BaseURL 拼写（例如不要漏掉 api. 前缀），或确认这台电脑能正常上网。"
            ),
        )
    if outcome.error == "timeout":
        return _timeout_result(host, timeout)
    if outcome.error == "refused":
        return ProbeResult(
            ok=False,
            message=(
                f"连接被拒绝：{host_label}上没有服务在监听这个端口。"
                f"请检查 BaseURL 的端口是否写对（云端服务通常是 443，不需要写端口）。"
            ),
        )
    if outcome.error == "tls":
        return ProbeResult(
            ok=False,
            message=(
                f"HTTPS 证书校验失败（{host_label}）：{_truncate(outcome.detail)}。"
                f"如果是私有部署的自签名证书，可以先用 http:// 试；否则请联系服务方换正式证书。"
            ),
        )
    if outcome.error == "config":
        return ProbeResult(
            ok=False,
            message=(
                f"BaseURL 形式不对（{_truncate(outcome.detail)}）。"
                f"请填写完整的地址，例如 https://api.deepseek.com 或 https://api.deepseek.com/v1。"
            ),
        )
    detail = _truncate(outcome.detail)
    return ProbeResult(
        ok=False,
        message=(
            f"网络请求失败（{host_label}）{('：' + detail) if detail else ''}。"
            f"请检查网络、代理与防火墙设置。"
        ),
    )


def _timeout_result(host: str, timeout: float) -> ProbeResult:
    return ProbeResult(
        ok=False,
        message=(
            f"连接超时：{timeout:g} 秒内没有收到 {host} 的响应。"
            f"请检查这台电脑能否访问该地址（校园网/防火墙/代理常常是原因）。"
            f"探测失败不影响保存，可以先保存配置稍后再试。"
        ),
    )


def _deepseek_hint(host: str) -> str:
    """DeepSeek 专属提示：官方两种写法都可用（现场最容易被这个差异绊住）。"""
    if "api.deepseek.com" in host.lower():
        return (
            "（DeepSeek 官方两种写法都可用：https://api.deepseek.com 与 "
            "https://api.deepseek.com/v1，带不带 /v1 都能连通。）"
        )
    return ""


def _host_of(url: str) -> str:
    return urllib.parse.urlsplit(url).netloc or url


def _extract_model_ids(body: bytes) -> list[str] | None:
    """从 ``/models`` 响应里取模型 id 列表；不是标准形状时返回 ``None``（不算失败）。"""
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None

    items = data.get("data")
    if not isinstance(items, list):
        items = data.get("models")
    if not isinstance(items, list):
        return None

    ids: list[str] = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip():
            ids.append(item["id"].strip())
        elif isinstance(item, str) and item.strip():
            ids.append(item.strip())
    return ids


def _provider_message(body: bytes, api_key: str) -> str:
    """把供应商返回的错误文本压成一句可读中文线索（**先脱敏再截断**）。"""
    if not body:
        return ""

    text: str | None = None
    with contextlib.suppress(json.JSONDecodeError, UnicodeDecodeError):
        data = json.loads(body.decode("utf-8", errors="replace"))
        text = _find_error_text(data)
    if text is None:
        text = body.decode("utf-8", errors="replace")

    # ★ 万一供应商把请求头/Key 回显到错误体里，这里再兜一层脱敏。
    if api_key:
        text = text.replace(api_key, "（已隐藏）")
    return _truncate(text)


def _find_error_text(data: Any) -> str | None:
    if isinstance(data, str):
        return data
    if not isinstance(data, dict):
        return None
    for key in ("message", "detail", "msg", "error_description", "error"):
        if key not in data:
            continue
        value = data[key]
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, dict):
            nested = _find_error_text(value)
            if nested:
                return nested
    return None


def _truncate(text: str) -> str:
    """折叠空白 + 截断（**绝不把一整段 HTML 或换行塞进设置页提示**）。"""
    flat = " ".join(text.split())
    if len(flat) <= PROBE_MAX_DETAIL_CHARS:
        return flat
    return flat[: PROBE_MAX_DETAIL_CHARS] + "…"
