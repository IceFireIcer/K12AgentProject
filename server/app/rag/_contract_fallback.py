"""★ **临时契约兜底** —— 只在 ``app/contracts.py`` 还没有这些模型时生效。

原本的处境：票 04（契约冻结）与数据轨（票 10–12）并行推进，写这份代码时
``app/contracts.py`` 里还只有 ``CamelModel`` / ``GradeLevel`` / ``HealthResponse``。
本文件让数据轨**不必等契约**就能跑通、能测、能演示。

**现状（已对齐）**：票 04 的契约已落地，``app/contracts.py`` 里有
``Citation`` / ``RagHit`` / ``RagSearchRequest`` / ``RagSearchResult`` / ``DepNode``，
:mod:`app.rag.contracts_bridge` 已自动切到契约那一份，本文件只在契约回退时启用。

字段必须与契约逐字一致；``tests/test_rag.py`` 的
``test_contract_models_match_app_contracts`` 会做逐字段比对，不一致即报漂移。
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.contracts import GradeLevel

# 降级级别与依赖方向/关系（与 app/contracts.py 的 Literal 逐字一致）
Degraded = Literal["vector", "cloud", "fts", "outline"]
DepRelation = Literal["prerequisite", "related"]
DepDirection = Literal["successor", "prerequisite"]


class _CamelModel(BaseModel):
    """与 ``app.contracts.CamelModel`` 行为一致的基类（snake_case 进、camelCase 出）。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class Citation(_CamelModel):
    """``citation`` 事件载荷（**只有 5 个字段，一字不改**）。"""

    chunk_id: str
    chapter_title: str
    section_title: str
    grade_level: GradeLevel
    compat: bool


class RagHit(Citation):
    """检索命中的完整记录（HTTP 层，供 Tool 注入上下文与轨迹图）。"""

    parent_chunk_id: Optional[str] = None
    text: str = ""  # ★ 父块完整内容（注入 LLM 的上下文，不是碎片）
    knowledge_point: str = ""
    kp_id: str = ""
    score: float = 0.0
    degraded: Degraded = "vector"
    expanded: bool = False


class RagSearchRequest(_CamelModel):
    """``POST /api/rag/search`` 请求体。

    ``allow_compat``：允许「向上兼容」取用**更低学段**的内容（例如高中生回看初中的解释），
    命中时 ``compat=true``。**无论开关怎么设，都不会返回更高学段的内容** ——
    关卡 C 的判据就是「初中提问不得返回高中 chunk」。
    """

    query: str
    grade_level: GradeLevel
    top_k: int = Field(default=5, ge=1, le=20)
    allow_compat: bool = True
    include_expansion: bool = True


class RagLevelAttempt(_CamelModel):
    """降级链一级的尝试记录（与 ``app/contracts.RagLevelAttempt`` 逐字段一致）。"""

    level: Degraded
    ok: bool = False
    detail: str = ""
    hits: int = 0


class RagSearchResult(_CamelModel):
    """``POST /api/rag/search`` 响应。降级链已在 Python 侧跑完，调用方只读 ``degraded``。

    ★ ``attempts`` / ``grade_filter`` 是**展示用**的只读字段（演示模式的可观测化）：
    逐级记录让人看见「试了哪几级、哪级命中」，过滤原文让人看见「WHERE 由谁强制」。
    """

    hits: list[RagHit] = Field(default_factory=list)
    context: str = ""
    degraded: Degraded = "vector"
    attempts: list[RagLevelAttempt] = Field(default_factory=list)
    grade_filter: str = ""


class DepNode(_CamelModel):
    """依赖图查询结果（``from`` 是前置、``to`` 是后继）。"""

    kp_id: str
    name: str
    grade_level: GradeLevel
    relation: DepRelation = "prerequisite"
    direction: DepDirection
    weight: float = 1.0
    depth: int = 1


__all__ = [
    "Citation",
    "Degraded",
    "DepDirection",
    "DepNode",
    "DepRelation",
    "RagHit",
    "RagLevelAttempt",
    "RagSearchRequest",
    "RagSearchResult",
]
