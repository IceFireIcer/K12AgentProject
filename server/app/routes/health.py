"""``GET /health`` —— 免鉴权探活端点。

Electron 启动期每 300ms 轮询一次，直到拿到 200 才认为 sidecar 可用（执行文档 §7.4）。
**必须保持轻量**：只回报状态与「模型文件是否就位」，绝不在请求路径上加载 ONNX 模型。
"""

from __future__ import annotations

from fastapi import APIRouter

from app.config import APP_VERSION
from app.contracts import HealthResponse
# ★★ **必须 import 检索侧那一套目录解析**（``app.rag.embedder.model_files_present``，
#   它会认 ``K12_EMBEDDING_MODEL_DIR``），**不能**用 ``app.config.model_files_present``
#   （那个把 ``EMBEDDING_MODEL_DIR`` 写死在函数体里）。
#   历史缺陷：探活说 ``embedderReady: true``，而 ``LocalEmbedder.available`` 已经是 False ——
#   两者对**同一个事实**给出相反结论。
#
#   触发场景不是理论上的：按 ``app/rag/embedder.py`` 的注释，把
#   ``K12_EMBEDDING_MODEL_DIR`` 指到一个空目录正是**演示四级降级链**的标准手法，
#   而演示者第一眼看的恰恰是探活灯。灯绿着、检索却一路降级，最坏的情况下会被读成
#   「知识库没建好」而白查半天。
#
#   代价：返回值随环境变量走。这正是想要的 —— 检索用哪个目录，探活就报哪个目录。
#
# ⚠️ 上面的说明刻意写在**注释**里而不是 `health()` 的 docstring 里：FastAPI 会把端点
#   docstring 原样写进 OpenAPI 的 `/health` description，而那份生成物已经提交在
#   `desktop/src/shared/openapi.json` —— 改 docstring 就等于制造一次契约漂移
#   （`tests/test_contracts.py` 会红，得重跑导出链）。文档留在这里一样看得见。
from app.rag.embedder import model_files_present

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
