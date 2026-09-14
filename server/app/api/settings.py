"""设置路由：`GET/PUT /api/settings`。

（对应 `项目执行文档.md` 第 6.3 节）

安全要点
--------
- **GET 永不回传明文 key**：只给 `hasKey` + 掩码（`models.mask_secret`）。
- **PUT 支持"不修改"语义**：空串/掩码 → 保留原值（避免误清空）。
- `/api/*` 的鉴权由 `main.py` 的中间件统一负责，这里不重复实现。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from app.models import SettingsResponse, SettingsUpdateRequest
from app.settings import SettingsError, SettingsStore

router = APIRouter(prefix="/api", tags=["settings"])
logger = logging.getLogger(__name__)


def _store(request: Request) -> SettingsStore:
    store: SettingsStore | None = getattr(request.app.state, "settings_store", None)
    if store is None:  # pragma: no cover - 组装错误，属于开发期问题
        raise HTTPException(status_code=500, detail="settings store 未初始化")
    return store


@router.get("/settings", response_model=SettingsResponse)
async def get_settings(request: Request) -> SettingsResponse:
    """读取设置（**脱敏**）。"""
    store = _store(request)
    response = store.to_response()
    if store.last_error:
        # 只记日志，不把损坏细节塞进正常响应；前端仍拿到可用的默认值
        logger.warning(store.last_error)
    return response


@router.put("/settings", response_model=SettingsResponse)
async def put_settings(request: Request, payload: SettingsUpdateRequest) -> SettingsResponse:
    """保存设置。

    ⚠️ 日志只记"改了哪些字段"，**绝不记值**（值里可能有 key）。
    """
    store = _store(request)
    try:
        saved = store.save(payload)
    except SettingsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    logger.info(
        "settings updated: provider=%s base_url=%s model=%s embedding_mode=%s key=%s",
        saved.llm.provider_name,
        saved.llm.base_url,
        saved.llm.model_id,
        saved.embedding.mode,
        "set" if saved.llm.api_key else "empty",
    )
    return store.to_response(saved)
