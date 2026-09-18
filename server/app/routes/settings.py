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
    LlmRuntimeConfig,
    ProbeRequest,
    ProbeResult,
    ProviderModelsRequest,
    ProviderModelsResult,
    SettingsResponse,
    SettingsUpdateRequest,
    is_api_key_placeholder,
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


def register_llm_secret(api_key: str | None) -> None:
    """把 LLM 明文 Key 登记进日志脱敏名单（``app.safety.guard.register_secret``）。

    ★ 为什么必须在这里登记：``guard`` 的脱敏过滤器只能抹掉**它认识的**凭据。
    嵌入侧的明文 Key 已在 ``app/rag/embedder.read_embedding_config`` 登记，
    而 **LLM 的明文 Key 只出现在本文件的两条路径上**（保存 / 加载），
    漏登记的话，「API Key 绝不明文进日志」这条硬约束在 LLM 这条线上就是空的
    —— 任何一条把配置或请求打进日志的代码都会漏出明文。

    ⚠️ 局部 import：避免 ``routes`` ↔ ``safety`` 的模块级循环依赖。
    """
    if not api_key:
        return
    from app.safety.guard import register_secret

    register_secret(api_key)


def load_settings(request: Request) -> StoredSettings:
    """读设置 —— **唯一入口**，顺带把明文 Key 登记进脱敏名单。

    ★ 收成一个函数而不是让各路由各写 ``get_settings_store(request).load()``：
    登记是「绝不许漏」的动作，散在 5 个调用点上早晚会漏一个（漏掉的那个恰恰是新加的）。
    凡是需要读设置的路径都走这里。
    """
    stored = get_settings_store(request).load()
    register_llm_secret(stored.llm.api_key)
    return stored


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
            provider_id=stored.llm.provider_id,
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


def to_runtime_config(stored: StoredSettings) -> LlmRuntimeConfig:
    """落盘 → **主进程专用**的运行时配置（**含明文 Key**）。

    这是「设置 → Pi」链路唯一的载体：Pi 必须拿到明文 Key 才能发请求，
    而设置页的读接口（`GET /api/settings`）恒回掩码。
    **调用方只有主进程**（渲染进程没有对应 IPC 通道，守卫会断言这一点）。
    """
    return LlmRuntimeConfig(
        provider_id=stored.llm.provider_id,
        provider_name=stored.llm.provider_name,
        base_url=stored.llm.base_url,
        api_key=stored.llm.api_key,
        has_key=bool(stored.llm.api_key),
        model_id=stored.llm.model_id,
    )


def apply_llm(payload: LlmConfigIn, current: StoredLlm) -> StoredLlm:
    """入参 + 现值 → 新落盘值。**四个字段一律「省略/占位即保留」**。

    ★ 这条规则必须对**每个字段**成立（不只是 `provider_id`）：入参模型的字段默认值
    现在是 ``None``（见 `contracts.LlmConfigIn`），所以「没提交」与「提交了出厂默认值」
    终于能区分开。否则 `PUT {"llm": {"apiKey": "…"}}` 这种字段级局部提交会把
    `provider_name` / `base_url` / `model_id` 一起静默换回 DeepSeek 默认值 ——
    用户改一次 Key 就丢掉自填的校内网关（A4）。

    Key 的取舍全部交给 `resolve_api_key`。
    """
    return StoredLlm(
        # 空白字符串与 ``None`` 同义（「这一栏没动」）：前端的空输入框会提交空串。
        provider_id=(payload.provider_id or "").strip() or current.provider_id,
        provider_name=(payload.provider_name or "").strip() or current.provider_name,
        base_url=payload.base_url or current.base_url,
        api_key=resolve_api_key(payload.api_key, current.api_key, clear=payload.clear_api_key),
        model_id=(payload.model_id or "").strip() or current.model_id,
    )


def apply_embedding(payload: EmbeddingConfigIn, current: StoredEmbedding) -> StoredEmbedding:
    """入参 + 现值 → 新落盘值。

    `mode` / `base_url` / `model_id` / `api_key` 四个字段遵循**同一条「省略即保留」规则**
    （Key 的规则见 `resolve_api_key`）：否则设置页切一下 `mode` 就会顺手清掉云端地址与
    模型 ID，只改 Key 也会把 `mode` 退回 `local_fastembed`（A4）。

    ``mode`` 用 ``is not None`` 判（它是枚举，空串过不了类型校验），
    其余两个用 ``or`` 兜空串 —— 语义一样，只是各自的取值形态不同。
    """
    return StoredEmbedding(
        mode=payload.mode if payload.mode is not None else current.mode,
        base_url=payload.base_url or current.base_url,
        api_key=resolve_api_key(payload.api_key, current.api_key, clear=payload.clear_api_key),
        model_id=payload.model_id or current.model_id,
    )


# ---------------------------------------------------------------- 路由 --
@router.get("/settings", response_model=SettingsResponse, summary="读设置（Key 只回掩码）")
def read_settings(request: Request) -> SettingsResponse:
    return to_response(load_settings(request))


@router.put("/settings", response_model=SettingsResponse, summary="存设置")
def update_settings(payload: SettingsUpdateRequest, request: Request) -> SettingsResponse:
    """保存设置。

    ``apiKey`` 提交空串或掩码（``…abcd``）**不会**抹掉已存 Key —— 用户没动这一栏时
    前端会把读回来的掩码原样提交；只有 ``clearApiKey=true`` 才删除。
    两栏都可省略（= 不动那一栏），但至少要提交一栏。

    ★ **栏内也是「省略即保留」**：`PUT {"llm": {"baseUrl": "…"}}` 只改地址，
    不会顺手重置 provider / 模型 / Key（见 `apply_llm` / `apply_embedding`）。
    """
    store = get_settings_store(request)
    current = load_settings(request)

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
    # ★ 保存后立刻登记新 Key：这是一把**刚写进 config.json 的明文凭据**，
    #   登记之后任何日志/审计副本里都不会再出现它（与加载路径同一口径）。
    register_llm_secret(updated.llm.api_key)
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

    探测的是**提交的候选配置**（先探测、满意再保存）：未提交的字段回落到已存值
    （与 `PUT /api/settings` 同一条「省略即保留」规则）。

    ★★ **已存的明文 Key 只允许用于保存它的那个地址**（见 `_resolve_probe_credentials`）：
    Key 提交掩码/空串时**不是无条件复用**，只在提交的地址与已存地址一致时才复用；
    换了地址又没有提交新 Key，直接回一句可读中文而**不发出任何请求**。
    **探测失败不阻塞保存**（断网/离线演示仍要能存配置），失败原因一律是可读中文。
    """
    if payload is None:
        return ProbeResult(ok=False, message="请求体缺少 llm 配置，无法探测。")

    credentials = _resolve_probe_credentials(payload.llm, load_settings(request).llm)
    if credentials.error is not None:
        return ProbeResult(ok=False, message=credentials.error)

    return probe_llm_connectivity(
        base_url=credentials.base_url,
        api_key=credentials.api_key,
        model_id=credentials.model_id,
    )


@router.post(
    "/settings/models",
    response_model=ProviderModelsResult,
    summary="拉取某个地址可见的模型清单（设置页的「拉取模型」）",
)
def list_provider_models(request: Request, payload: ProviderModelsRequest | None = None) -> ProviderModelsResult:
    """拉取 ``GET {baseUrl}/models`` 的模型 id 清单（**设置页填 ModelID 的辅助**）。

    与 ``/settings/probe`` 的分工：
      - ``probe``  回答「这组配置**能不能用**」（成功/失败 + 可读原因）；
      - ``models`` 回答「这个地址**有哪些模型可选**」（清单）。
    两者共用同一套外呼实现（``ProbeTransport`` 注入点也相同），**不新增任何依赖**。

    ``ok=False``（连不上 / 鉴权失败 / 端点没有模型清单）**不是致命错误**：
    调用方（主进程）会把 Pi 内置预设清单与这里的实时结果合并后交给设置页，
    所以这里失败时只需要给一句可读原因，界面照样能选到内置模型的候选。

    ★ 与探测**共用同一条凭据边界**（`_resolve_probe_credentials`）：换了地址就不复用已存 Key。
    """
    if payload is None:
        return ProviderModelsResult(ok=False, models=[], message="请求体缺少 llm 配置，无法拉取模型。")

    credentials = _resolve_probe_credentials(payload.llm, load_settings(request).llm)
    if credentials.error is not None:
        return ProviderModelsResult(ok=False, models=[], message=credentials.error)

    return fetch_provider_models(base_url=credentials.base_url, api_key=credentials.api_key)


@router.get(
    "/settings/runtime",
    response_model=LlmRuntimeConfig,
    summary="★ 主进程专用：真正生效的那份 LLM 配置（**含明文 Key**）",
)
def read_runtime_config(request: Request) -> LlmRuntimeConfig:
    """★★ **只给主进程用**：Pi 建会话 / 热切换时需要**明文 Key**。

    ⚠️ 为什么必须有这条接口：Pi 在进程外无法读 ``config.json`` 的语义
    （原子写、损坏备份、snake/camel 双写容忍都在本模块），而设置页的读接口
    恒回掩码。没有它，「设置页改了配置 → Pi 用新配置」这条链路就断了
    （实测：改完设置重启，Pi 仍用旧的 ``models.json``）。

    ⚠️ **安全边界**（三条一起才成立，缺一不可）：
      1. 与其它 ``/api/*`` 一样需要 ``X-Auth-Token``（token 只在主进程内存里）；
      2. 渲染进程**没有**对应 IPC 通道、preload **没有**对应方法（架构守卫断言）；
      3. 主进程拿到后只经 ``setRuntimeApiKey`` 放进内存，**不落盘、不进日志**。
    """
    return to_runtime_config(load_settings(request))


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
#: ★ 只允许 HTTP(S)：`file:` / `data:` 那类协议也照做外呼，等于把本机文件读给调用方。
ALLOWED_URL_SCHEMES = ("http", "https")


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """★ **不跟随重定向**（A3）。

    `urllib` 默认会把请求头（含 ``Authorization: Bearer <Key>``）**复制到跳转目标**，
    于是「起始地址回一个 302 到别的域名」就足以把明文 Key 送给对方，而且这整件事
    在设置页看来只是「探测慢了一下」。跳转本身也证明不了「这组配置能用」，
    所以这里直接不跟随：3xx 原样上报（标准库改为抛 `HTTPError`，状态码保留），
    由上层给出可读说明。
    """

    def redirect_request(  # noqa: N802 - 覆写标准库钩子，命名必须一致
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        """返回 ``None`` = 不做重定向（`HTTPRedirectHandler` 据此不再发起第二次请求）。

        参数全部照抄标准库签名（它们本来就参与重定向决策，我们只是**明确地不跟随**）。
        """
        return None


#: 探测专用的 opener（唯一差异就是禁用重定向）。构造一次复用 —— 与 `urllib.urlopen`
#: 复用模块级 opener 同理，`OpenerDirector.open` 不保存单次请求状态。
_PROBE_OPENER = urllib.request.build_opener(_NoRedirectHandler)


@dataclass(frozen=True)
class ProbeCredentials:
    """探测 / 拉模型**真正要用的**那组凭据（已解析、已过凭据边界校验）。

    与 :class:`~app.contracts.LlmConfigIn` 的差别：这里是「保存后会用的那份配置」
    （未提交的字段回落到已存值），而不是「这次提交了什么」。
    """

    base_url: str
    api_key: str
    model_id: str
    #: 非 ``None`` = **拒绝外呼**，把这句话原样回给用户（此时不会发出任何请求）。
    error: str | None = None


def _resolve_probe_credentials(payload: LlmConfigIn, stored: StoredLlm) -> ProbeCredentials:
    """把「候选配置（提交值 + 已存值回落）」解析成外呼要用的地址与 Key。

    ★★ **Key 与地址绑定**（A1，凭据外泄防线）：已存的明文 Key **只允许**用于
    「保存它的那个地址」。提交了别的 BaseURL 而 Key 仍是占位（掩码/空串）时，
    **绝不回退已存 Key** —— 否则渲染进程只要提交
    ``{"baseUrl": "http://攻击者", "apiKey": "…abcd"}``（只是回显它读到的掩码！）
    就能让 sidecar 拿真 Key 去访问任意地址，凭据当场外泄。

    两条正常路径不受影响：

    - **地址没变**（就是用户平时点「探测」的场景）→ 复用已存 Key；
    - **换了地址 + 交了新 Key** → 用用户自己填的凭据访问用户指定的地址。

    地址没有可复用 Key 时返回 ``error``（可读中文），调用方**不要**再外呼。
    """
    # 未提交 BaseURL（或提交空串）= 保留已存值：与 `apply_llm` 同一条「省略即保留」规则。
    base_url = normalize_base_url(payload.base_url or stored.base_url)
    stored_base_url = normalize_base_url(stored.base_url)
    model_id = (payload.model_id or "").strip() or stored.model_id

    if payload.clear_api_key:
        # 显式清除：本次探测没有 Key 可用（下一步会给「尚未配置 API Key」的可读提示）。
        return ProbeCredentials(base_url=base_url, api_key="", model_id=model_id)

    if not is_api_key_placeholder(payload.api_key):
        # 提交了明文 Key：这是用户**自己新填的**凭据，按用户指定的地址发（正常用法）。
        return ProbeCredentials(
            base_url=base_url, api_key=str(payload.api_key).strip(), model_id=model_id
        )

    if base_url == stored_base_url:
        return ProbeCredentials(base_url=base_url, api_key=stored.api_key, model_id=model_id)

    if not stored.api_key:
        # 没有已存 Key 可复用 —— 交给上层给「尚未配置 API Key」的标准提示。
        return ProbeCredentials(base_url=base_url, api_key="", model_id=model_id)

    return ProbeCredentials(
        base_url=base_url,
        api_key="",
        model_id=model_id,
        error=(
            "换了接口地址，请重新填写 API Key："
            f"已存的 Key 只允许用于保存它的地址（{stored_base_url}），不会跟着新地址走。"
            "请把 BaseURL 改回原地址，或在这一栏填入新地址对应的 Key。"
        ),
    )


def _url_scheme_problem(base_url: str) -> str | None:
    """入口处校验协议：**只允许 http(s)**（A2）。不是可读问题就返回 ``None``。

    非 http(s) 的地址（漏写 ``https://``、``data:``、``file:``）以前会走到
    ``urllib.request.Request(...)``：轻则 `ValueError: unknown url type` 逃出 try → **500**，
    重则 ``file:`` 真把本机文件内容读出来、连系统错误文本一起回显到设置页。
    这里统一挡住，并且**不回显提交的字符串**（那可能是本机路径）。
    """
    scheme = urllib.parse.urlsplit(base_url).scheme.lower()
    if scheme in ALLOWED_URL_SCHEMES:
        return None
    return (
        "BaseURL 形式不对：只支持 http:// 或 https:// 开头的完整地址"
        "（例如 https://api.deepseek.com；最常见的原因是漏写了 https://）。"
    )


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
    """默认实现：标准库 ``urllib.request``（见上方「为什么不用 httpx」）。

    ★ 两条安全纪律（A2 / A3）：

    1. 只对 **http(s)** 地址外呼（入口已校验，这里再兜一层，别让 `Request` 构造抛出去）；
    2. **不跟随重定向**（`_PROBE_OPENER`）—— `urllib` 默认会把 ``Authorization``
       连同 ``Bearer <Key>`` 复制给跳转目标，跨主机 302 就是一次凭据外泄。
    """

    def exchange(
        self,
        *,
        method: str,
        url: str,
        api_key: str,
        payload: dict[str, Any] | None,
        timeout: float,
    ) -> HttpOutcome:
        problem = _url_scheme_problem(url)
        if problem is not None:
            return HttpOutcome(error="config", detail=problem)

        headers = {"Accept": "application/json", "User-Agent": PROBE_USER_AGENT}
        data: bytes | None = None
        if api_key:
            # ★ Key 只进请求头：不进 URL、不进日志、不进异常消息。
            headers["Authorization"] = f"Bearer {api_key}"
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        try:
            # ⚠️ `Request(...)` 构造**必须在 try 内**：它自己就会对畸形 URL 抛 ValueError
            #    （`unknown url type: '…'`）。放在 try 之外 = 一个打字错误换一个 500 + 一段
            #    把本机路径/系统错误回显给渲染进程的堆栈（A2）。
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            with _PROBE_OPENER.open(request, timeout=timeout) as response:
                status = getattr(response, "status", None)
                body = response.read(PROBE_MAX_BODY_BYTES)
                if status is None:
                    # `data:` / `file:` 这类非 HTTP 响应没有 status —— 以前 `int(None)` 直接 500。
                    return HttpOutcome(
                        error="config",
                        detail=f"该地址不是 HTTP 服务（{_host_of(url)}）",
                    )
                return HttpOutcome(status=int(status), body=body)
        except urllib.error.HTTPError as exc:
            # HTTPError 本身也是响应：状态码与响应体正是「401 还是 404」的证据。
            # ★ 不跟随重定向后，3xx 也走这里 —— 原样带出去，由上层解释成「地址发生了跳转」。
            body = b""
            with contextlib.suppress(Exception):
                body = exc.read(PROBE_MAX_BODY_BYTES)
            return HttpOutcome(status=int(exc.code), body=body)
        except urllib.error.URLError as exc:
            return _classify_reason(exc.reason)
        except (TimeoutError, socket.timeout):
            return HttpOutcome(error="timeout", detail=f"{timeout:g} 秒内无响应")
        except ValueError as exc:
            # `unknown url type` / `Invalid URL`：地址形式问题，给可读文案而不是 500。
            return HttpOutcome(error="config", detail=f"{type(exc).__name__}: {exc}")
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
    if isinstance(reason, ValueError):
        # `unknown url type: 'api.deepseek.com'`（用户忘了写 https://）
        return HttpOutcome(error="config", detail=f"{type(reason).__name__}: {reason}")
    if isinstance(reason, str):
        return HttpOutcome(error="config", detail=reason)
    return HttpOutcome(error="network", detail=f"{type(reason).__name__}: {reason}")


def _is_redirect(outcome: HttpOutcome) -> bool:
    """3xx（含 304）：**不跟随、不当成功**，交给 :func:`_redirect_message` 解释（A3）。"""
    return outcome.status is not None and 300 <= outcome.status < 400


def _redirect_message(outcome: HttpOutcome, url: str) -> str:
    """3xx 的可读说明。

    ★ 这里**故意不显示 ``Location`` 的目标主机**：那个地址来自响应方，
    把它回显到界面上等于让「探测一个自己控制的地址」的人借我们的 UI 展示任意文案
    （钓鱼式引导）。文案也说清了「Key 没有被送过去」这件事，用户才不会以为是自己填错。
    """
    return (
        f"{url} 返回 HTTP {outcome.status}（地址发生了跳转）。"
        "探测**不会跟随跳转** —— 跳转目标收不到你的 API Key，也不代表这组配置可用。"
        "请直接填写服务的最终地址（不要填会跳转的短链或中转页），再探测一次。"
    )


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


def fetch_provider_models(
    *,
    base_url: str,
    api_key: str,
    timeout: float = PROBE_TIMEOUT_SECONDS,
    transport: ProbeTransport | None = None,
) -> ProviderModelsResult:
    """拉取 ``GET {baseUrl}/models`` 的模型 id 清单（**永远**返回可读中文，不抛异常）。

    与 :func:`probe_llm_connectivity` 的关系：**共用**同一套外呼实现与解析
    （``ProbeTransport`` / ``_extract_model_ids``），只是**不做** 1-token 回退探测 ——
    这里的目的是「列出候选项」，不是「证明配置可用」，所以路径不存在就如实说，
    由主进程把 Pi 内置预设清单合并进来兜底。

    与探测同一条纪律：**不自动改写地址**（不会替你补 `/v1`）；只有在路径不存在时才在
    失败原因里**提示**另一种写法。
    """
    if base_url == "":
        return ProviderModelsResult(ok=False, models=[], message="BaseURL 不能为空：请填写服务的根地址后再拉取模型。")

    # ★ 入口校验协议（A2）：`file:` / `data:` / 漏写 `https://` 一律在这里挡住，
    #   既不发外呼也不把本机路径回显给调用方。
    problem = _url_scheme_problem(base_url)
    if problem is not None:
        return ProviderModelsResult(ok=False, models=[], message=problem)

    backend = transport or UrllibTransport()
    models_url = f"{base_url}/models"
    host = _host_of(models_url)
    variant = base_url_variant(base_url)

    outcome = backend.exchange(
        method="GET",
        url=models_url,
        api_key=api_key,
        payload=None,
        timeout=timeout,
    )

    if _is_redirect(outcome):
        # 禁用重定向后如实上报（A3）：跟着跳转既证明不了配置可用，又可能把 Key 送出去。
        return ProviderModelsResult(ok=False, models=[], message=_redirect_message(outcome, models_url))

    if outcome.status is not None and 200 <= outcome.status < 300:
        model_ids = _extract_model_ids(outcome.body)
        if model_ids is None:
            # 接口通了但响应不是标准模型列表：**不是错误**，如实说清即可（有些兼容服务如此）。
            return ProviderModelsResult(
                ok=False,
                models=[],
                message=(
                    f"{models_url} 返回 HTTP {outcome.status}，但响应不是标准的模型列表"
                    f"（无法解析出模型 id）。可以在 ModelID 里直接手填该服务的模型名。"
                ),
            )
        if not model_ids:
            return ProviderModelsResult(
                ok=False,
                models=[],
                message=f"{models_url} 可连通，但该服务没有报出任何模型（清单为空）。请手动填写 ModelID。",
            )
        return ProviderModelsResult(
            ok=True,
            models=model_ids,
            message=f"拉取到 {len(model_ids)} 个模型（来自 {models_url}）。",
        )

    if outcome.status in (401, 403):
        return ProviderModelsResult(
            ok=False,
            models=[],
            message=(
                f"API Key 被拒绝（HTTP {outcome.status}）：{_provider_message(outcome.body, api_key)}"
                "。请先填好 Key（或点「探测」确认鉴权通过）；也可以用 Pi 内置预设里的模型名手填。"
            ),
        )

    if outcome.status in (404, 405, 400):
        hint = (
            f"；同一服务的 {variant} 可能才是正确写法（探测可以帮你确认）"
            if variant is not None
            else ""
        )
        return ProviderModelsResult(
            ok=False,
            models=[],
            message=(
                f"{models_url} 返回 HTTP {outcome.status}（该服务没有 /models 端点）{hint}。"
                "这不影响保存 —— 可以用 Pi 内置预设里的模型名手填 ModelID。"
            ),
        )

    if outcome.status is not None:
        return ProviderModelsResult(
            ok=False,
            models=[],
            message=(
                f"{models_url} 返回 HTTP {outcome.status}：{_provider_message(outcome.body, api_key)}"
                "。请检查 BaseURL 是否为该服务的根地址。"
            ),
        )

    # 走到这里说明是网络层失败：复用探测的错误分类文案（同一套措辞，别写两份）。
    failure = _error_failure(outcome, host, timeout)
    return ProviderModelsResult(ok=False, models=[], message=failure.message)


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

    ★ **不跟随重定向**（A3）：3xx 一律当作「地址发生了跳转」如实上报 ——
    跟着跳转既不证明这组配置可用，还会把 ``Authorization`` 送给跳转目标。
    """
    if base_url == "":
        return ProbeResult(ok=False, message="BaseURL 不能为空：请填写服务的根地址。")

    # ★ 入口校验协议（A2）：非 http(s) 不解析 Key、不发外呼、不回显提交的字符串。
    problem = _url_scheme_problem(base_url)
    if problem is not None:
        return ProbeResult(ok=False, message=problem)

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

    if _is_redirect(outcome):
        return ProbeResult(ok=False, message=_redirect_message(outcome, models_url))

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

        if _is_redirect(ping):
            # 对话端点也跳转：同样不跟随（否则 Key 跟着第二次请求一起走）。
            return ProbeResult(
                ok=False,
                message=_redirect_message(ping, f"{base_url}/chat/completions"),
            )

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
