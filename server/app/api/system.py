"""系统级路由：探活与自检。

S01 只需要 `/health` 与一个用于验证鉴权的受保护端点。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.config import (
    APP_VERSION,
    EMBEDDING_DIM,
    EMBEDDING_MODEL_ID,
    RESOURCES_DIR,
    is_frozen,
)

router = APIRouter()


class HealthResponse(BaseModel):
    """`/health` 响应。Electron 轮询它来判断 sidecar 是否就绪。"""

    status: str = Field(description="固定为 ok；不可用时该接口本身就不会响应")
    version: str
    embedder_ready: bool = Field(
        description=(
            "嵌入模型「可用」的快速探测结果。S01 阶段只检查模型文件是否随包分发到位，"
            "不做真实加载（加载 90MB ONNX 会显著拖慢冷启动）；S06 接入 RAG 后改为"
            "懒加载后的真实就绪态。"
        )
    )
    frozen: bool = Field(description="是否运行在 PyInstaller 打包产物中")
    data_dir: str


class PingResponse(BaseModel):
    """受保护端点，用于验证 `X-Auth-Token` 中间件确实生效。"""

    status: str = "ok"
    auth: str = "ok"


def _embedder_files_present() -> bool:
    """轻量探测：`server/resources/models/fastembed/` 下是否有可用的 ONNX 模型。

    只做文件系统检查（毫秒级），不 import fastembed、不加载权重。
    """
    candidates = [
        RESOURCES_DIR / "models" / "fastembed",
        # fastembed 会在 cache_dir 下再套一层模型名目录，兼容两种落盘形态
        RESOURCES_DIR / "models" / "fastembed" / "models--BAAI--bge-small-zh-v1.5",
    ]
    for base in candidates:
        if not base.is_dir():
            continue
        if any(base.rglob("*.onnx")):
            return True
    return False


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health(request: Request) -> HealthResponse:
    """免鉴权健康检查。"""
    cfg = request.app.state.cfg
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        embedder_ready=_embedder_files_present(),
        frozen=is_frozen(),
        data_dir=str(cfg.data_dir),
    )


@router.get("/api/ping", response_model=PingResponse, tags=["system"])
async def ping() -> PingResponse:
    """受保护端点：能返回 200 说明 token 校验通过。"""
    return PingResponse()


@router.get("/api/meta", tags=["system"])
async def meta(request: Request) -> dict[str, object]:
    """给前端展示的后端元信息（不含任何凭据）。"""
    cfg = request.app.state.cfg
    return {
        "appName": "K12 AI 教学助手",
        "version": APP_VERSION,
        "embeddingDim": EMBEDDING_DIM,
        "embeddingModelId": EMBEDDING_MODEL_ID,
        "frozen": is_frozen(),
        "dataDir": str(Path(cfg.data_dir)),
        "authEnabled": cfg.auth_enabled,
    }
