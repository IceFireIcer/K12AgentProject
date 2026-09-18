"""``POST /api/rag/search`` —— 检索（供 Pi 的 ``rag_search`` Tool 调用）。

**薄控制器**：只做三件事 —— 取运行配置、调 :class:`app.rag.retriever.RagService`、
返回 ``RagSearchResult``。降级链、学段隔离、父子 chunk、依赖图扩展全在 ``app/rag/`` 内部完成，
**编排层只读结果里的 ``degraded`` 字段**（执行文档 §8.5）。

契约：``RagSearchRequest`` / ``RagSearchResult`` / ``RagHit`` 从 ``app.rag.contracts_bridge`` 取，
它优先用 ``app.contracts`` 的版本（票 04 已落地），契约缺失时才退回本地兜底定义。

★ **compat 的语义**（与契约 docstring 里「更高学段」的措辞不同，以本实现为准）：
``compat=true`` 表示**取用了比学生学段更低的内容**（高中生回看初中解释），
**永远不会返回更高学段的内容** —— 关卡 C 的判据就是「初中提问不得返回高中 chunk」，
超纲这件事没有「可选开关」。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from app.rag.contracts_bridge import RagSearchRequest, RagSearchResult
from app.rag.retriever import get_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["rag"])


@router.post("/rag/search", response_model=RagSearchResult)
def rag_search(request: Request, body: RagSearchRequest) -> RagSearchResult:
    """按学段检索教材片段。

    :param body: ``{query, gradeLevel, topK?, allowCompat?, includeExpansion?}``
        - ``gradeLevel``：学生**当前生效**的学段（由服务端推断，见 ``app/grade/rules.py``；
          学生端只读、**没有人工选择入口**），学段隔离在 SQL 层按它执行；
        - ``allowCompat``：是否允许取用更低学段的内容（命中标 ``compat=true``）；
        - ``includeExpansion``：是否把依赖图里的前置知识点补进上下文（有数量上限）。

    响应里的 ``hits`` 带父块正文（注入 LLM 的上下文），``context`` 是拼好的可直接投喂文本，
    ``degraded`` 说明本次落在降级链的哪一级（vector → cloud → fts → outline）。
    """
    config = request.app.state.config
    service = get_service(data_dir=config.data_dir)
    try:
        result = service.search(
            query=body.query,
            grade_level=body.grade_level,
            top_k=body.top_k,
            allow_compat=body.allow_compat,
            include_expansion=body.include_expansion,
        )
    except Exception:  # noqa: BLE001 - 演示现场宁可少答，也不要 500 打断对话
        logger.exception("检索失败（已返回空结果，对话可继续）")
        return RagSearchResult(hits=[], context="", degraded="outline")
    return result.to_response()
