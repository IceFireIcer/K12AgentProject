"""契约桥：优先用 ``app.contracts`` 里的模型，缺失时才退回本地兜底。

**为什么要有这一层**：``app/contracts.py`` 是唯一契约来源（执行文档 §6.1），
数据轨（票 10–12）要在它落地之前就能跑、能测。这里做一次性选择：

- ``app.contracts`` 有这些模型 → **用契约的**（票 04 落地后的正式路径）；
- 没有（契约回退或被临时改坏）→ 用 :mod:`app.rag._contract_fallback` 的同名同形模型，
  并记一条 warning。

业务代码只 ``from app.rag.contracts_bridge import RagHit, DepNode, ...``，
契约变化时**不需要改任何调用点**。``contract_parity_report()`` 供测试与报告核对，
``field_diff()`` 用来在契约与兜底不一致时**指名道姓**报出差异（防静默漂移）。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_NEEDED = (
    "Citation",
    "RagHit",
    "RagSearchRequest",
    "RagSearchResult",
    "DepNode",
)
_RESOLVED: dict[str, object] = {}


def _resolve() -> None:
    if _RESOLVED:
        return
    import app.contracts as contracts

    from app.rag import _contract_fallback as fallback

    for name in _NEEDED:
        found = getattr(contracts, name, None)
        _RESOLVED[name] = found if found is not None else getattr(fallback, name)

    missing = [n for n in _NEEDED if getattr(contracts, n, None) is None]
    if missing:
        logger.warning(
            "契约模型 %s 未出现在 app/contracts.py，临时使用 %s 的本地兜底定义",
            missing,
            fallback.__name__,
        )


def contract_source(name: str) -> str:
    """该模型当前取自哪里（``app.contracts`` / ``app.rag._contract_fallback``）。"""
    _resolve()
    import app.contracts as contracts

    return "app.contracts" if getattr(contracts, name, None) is _RESOLVED[name] else "app.rag._contract_fallback"


def contract_parity_report() -> dict[str, str]:
    _resolve()
    return {name: contract_source(name) for name in _NEEDED}


def field_diff(name: str) -> dict[str, list[str]]:
    """逐字段比对契约与兜底定义，返回 ``{"only_contract": [...], "only_fallback": [...]}``。

    契约与兜底都是空差异时返回空列表 —— 说明临时兜底随时可以删。
    """
    import app.contracts as contracts

    from app.rag import _contract_fallback as fallback

    contract_model = getattr(contracts, name, None)
    fallback_model = getattr(fallback, name, None)
    if contract_model is None or fallback_model is None:
        return {"only_contract": [], "only_fallback": []}
    contract_fields = set(contract_model.model_fields)
    fallback_fields = set(fallback_model.model_fields)
    return {
        "only_contract": sorted(contract_fields - fallback_fields),
        "only_fallback": sorted(fallback_fields - contract_fields),
    }


def __getattr__(name: str):  # PEP 562：模块级懒加载
    if name in _NEEDED or name in ("Degraded", "DepDirection", "DepRelation"):
        _resolve()
        if name in _RESOLVED:
            return _RESOLVED[name]
        from app.rag import _contract_fallback as fallback

        return getattr(fallback, name)
    raise AttributeError(name)


__all__ = [
    "Citation",
    "Degraded",
    "DepDirection",
    "DepNode",
    "DepRelation",
    "RagHit",
    "RagSearchRequest",
    "RagSearchResult",
    "contract_parity_report",
    "contract_source",
    "field_diff",
]
