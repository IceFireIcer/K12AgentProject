"""``GET`` / ``PUT /api/settings`` 与 ``POST /api/settings/probe``（§6.3）。

**薄控制器**：解析 → 调存储 → 序列化契约模型，业务规则不写在这里。
**API Key 掩码语义**（票 07 硬要求）由 `app.contracts` 的
:func:`~app.contracts.resolve_api_key` / :func:`~app.contracts.mask_api_key` 提供，
本文件只负责「读回一律掩码、占位不覆盖、清除必须显式」。

⚠️ **持久化是占位实现（票 04 明确许可）**：票 04 只冻结契约与掩码语义，
落盘（``<data-dir>/config.json`` 原子写）属票 07 —— 见 `app/settings_store.py`。
替换方式：用 `app.state.settings_store` 注入一个实现了 {@link SettingsStore} 的对象即可，
本文件的路由代码**不需要改**（这是刻意的接缝）。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Protocol

from fastapi import APIRouter, HTTPException, Request, status

from app.contracts import (
    DEFAULT_EMBEDDING_MODEL_ID,
    DEFAULT_LLM_BASE_URL,
    DEFAULT_LLM_MODEL_ID,
    DEFAULT_LLM_PROVIDER_NAME,
    EmbeddingConfig,
    EmbeddingConfigIn,
    EmbeddingMode,
    LlmConfig,
    LlmConfigIn,
    ProbeRequest,
    ProbeResult,
    SettingsResponse,
    SettingsUpdateRequest,
    resolve_api_key,
)

router = APIRouter(prefix="/api", tags=["settings"])

#: 注入点：测试与票 07 都通过 `app.state.settings_store` 替换实现。
SETTINGS_STORE_ATTR = "settings_store"


# ---------------------------------------------------------------- 存储形状 --
@dataclass(frozen=True)
class StoredLlm:
    """落盘的 LLM 配置（**含明文 Key**，只在本模块与存储层之间流转）。"""

    provider_name: str = DEFAULT_LLM_PROVIDER_NAME
    base_url: str = DEFAULT_LLM_BASE_URL
    api_key: str = ""
    model_id: str = DEFAULT_LLM_MODEL_ID


@dataclass(frozen=True)
class StoredEmbedding:
    """落盘的嵌入配置（含明文 Key，同上）。"""

    mode: EmbeddingMode = "local_fastembed"
    base_url: str | None = None
    api_key: str = ""
    model_id: str | None = DEFAULT_EMBEDDING_MODEL_ID


@dataclass(frozen=True)
class StoredSettings:
    llm: StoredLlm = StoredLlm()
    embedding: StoredEmbedding = StoredEmbedding()


class SettingsStore(Protocol):
    """设置存储接口（票 07 换成 config.json 落盘实现，接口不变）。"""

    def load(self) -> StoredSettings: ...

    def save(self, settings: StoredSettings) -> None: ...


class InMemorySettingsStore:
    """占位实现：进程内存里存一份（重启即失）。

    **只服务于票 04 的契约与掩码语义验证**；票 07 用 ``config.json`` 替换它，
    那时「关掉重开窗口配置还在」才会成立。
    """

    def __init__(self, initial: StoredSettings | None = None) -> None:
        self._settings = initial or StoredSettings()
        self._lock = threading.Lock()

    def load(self) -> StoredSettings:
        with self._lock:
            return self._settings

    def save(self, settings: StoredSettings) -> None:
        with self._lock:
            self._settings = settings


def get_settings_store(request: Request) -> SettingsStore:
    """取存储实现：优先 `app.state.settings_store`（可由测试/票 07 注入）。"""
    store = getattr(request.app.state, SETTINGS_STORE_ATTR, None)
    if store is None:
        store = InMemorySettingsStore()
        setattr(request.app.state, SETTINGS_STORE_ATTR, store)
    return store


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
    store.save(updated)
    return to_response(updated)


@router.post(
    "/settings/probe",
    response_model=ProbeResult,
    summary="探测 LLM 连通性（票 07 实现）",
)
def probe_settings(request: Request, payload: ProbeRequest | None = None) -> ProbeResult:
    """⚠️ **票 04 不实现探测**：真实连通性探测（``GET /models`` / 1-token 请求 +
    可读失败原因）属票 07。

    这里**返回 501 而不是造一个 ``{ok:false}``** —— 假结果会被设置页当成
    「用户填错了」显示，比没实现更糟（执行文档 §6.2 明确要求真实探测）。
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=(
            "连通性探测尚未实现（票 07 设置页落地）：这里不做假探测。"
            "契约形状已冻结为 ProbeResult{ok, message}。"
        ),
    )
