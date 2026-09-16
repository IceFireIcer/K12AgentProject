"""``GET /health`` —— 免鉴权探活端点。

Electron 启动期每 300ms 轮询一次，直到拿到 200 才认为 sidecar 可用（执行文档 §7.4）。
**必须保持轻量**：只回报状态与「模型文件是否就位」，绝不在请求路径上加载 ONNX 模型。
"""

from __future__ import annotations

from fastapi import APIRouter

from app.config import APP_VERSION, model_files_present
from app.contracts import HealthResponse

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """存活探针。

    ``embedder_ready`` 为假**不代表 sidecar 不健康** —— 模型缺失时应用仍应能起来，
    只是检索会走降级链（FTS5 → 大纲）。所以这里不因缺模型而报错。
    """
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        embedder_ready=model_files_present(),
    )
